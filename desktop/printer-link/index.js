'use strict';
/* printer-link - talk to a Bambu Lab printer over the local network.

   Pure Node: no Electron, no DOM. The desktop shell's main process loads it,
   and printer-link/cli.js runs it on its own.

   What it speaks (community-documented, OpenBambuAPI; the printer must be in
   LAN Only + Developer Mode to accept commands):
     MQTT over TLS, port 8883, user "bblp", password = the LAN access code.
       reports arrive on  device/<serial>/report
       commands go to     device/<serial>/request
     FTPS (implicit TLS), port 990, same user and password: files to the SD card.

   TLS. The printer's certificate is signed by Bambu's own CA, which no system
   trusts, so the usual chain check cannot pass. Verification is by PIN
   instead: the certificate's SHA-256 fingerprint is read once when the
   printer is added (probe), shown to the owner, and stored. Every later
   connection completes the TLS handshake, compares the fingerprint with the
   pin, and only then lets the access code onto the wire. A printer that
   presents another certificate is refused. There is no "accept anything" path.

   Everything marked TO VERIFY is taken from community documentation and has
   not yet been run against the owner's printers. */

const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const mqtt = require('mqtt');
const ftp = require('basic-ftp');
const { merge, summarise } = require('./state');
const guard = require('./guard');

const MQTT_PORT = 8883;
const FTPS_PORT = 990;
const USER = 'bblp';

/** Per-model facts. `fileUrl` is how project_file names a file on the SD card. TO VERIFY per model. */
const MODELS = {
  a1mini: { label: 'A1 mini', fileUrl: (n) => 'file:///sdcard/' + n, homeXY: 'G28 X' },
  a1: { label: 'A1', fileUrl: (n) => 'file:///sdcard/' + n, homeXY: 'G28 X' },
  p1s: { label: 'P1S', fileUrl: (n) => 'file:///sdcard/' + n, homeXY: 'G28 X Y' },
  p1p: { label: 'P1P', fileUrl: (n) => 'file:///sdcard/' + n, homeXY: 'G28 X Y' }
};
/* homeXY: Bambu's own A1 mini start G-code re-homes with "G28 X ; re-home XY"
   (fixtures/print-planner/a1mini-0.4/frozen.json), so that is what is sent to
   the bed-slingers. Whether it also re-homes Y during a PAUSE, and whether the
   resume then lands clean, is the first service test (docs/DESKTOP.md). */

function normPin(p) { return String(p || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase(); }

function certFacts(cert) {
  const cn = (o) => (o && (Array.isArray(o.CN) ? o.CN[0] : o.CN)) || '';
  return {
    fingerprint256: cert.fingerprint256 || '',
    subjectCN: cn(cert.subject),
    issuerCN: cn(cert.issuer),
    validFrom: cert.valid_from || '',
    validTo: cert.valid_to || ''
  };
}

/**
 * Read a port's TLS certificate WITHOUT sending anything else. Used once, when
 * a printer is added, so the owner can see what is being pinned (the subject
 * CN of a Bambu printer is its serial number).
 */
function probe(host, port, timeoutMs) {
  port = port || MQTT_PORT;
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, rejectUnauthorized: false });
    const t = setTimeout(() => { s.destroy(); reject(new Error('No answer from ' + host + ':' + port + '. Is the printer on, on this network, and in LAN Only mode?')); }, timeoutMs || 8000);
    s.once('secureConnect', () => {
      clearTimeout(t);
      const cert = s.getPeerCertificate();
      s.destroy();
      if (!cert || !cert.fingerprint256) return reject(new Error(host + ':' + port + ' sent no certificate.'));
      resolve(certFacts(cert));
    });
    s.once('error', (e) => { clearTimeout(t); reject(new Error('Could not reach ' + host + ':' + port + ' (' + e.message + ').')); });
  });
}

/** A TLS socket whose certificate has been checked against the pin. Nothing has been written to it. */
function openVerified(host, port, pin, timeoutMs) {
  return new Promise((resolve, reject) => {
    const want = normPin(pin);
    if (!want) return reject(Object.assign(new Error('This printer has no certificate pin. Add it again.'), { code: 'NO_PIN' }));
    const s = tls.connect({ host, port, rejectUnauthorized: false });
    const t = setTimeout(() => { s.destroy(); reject(Object.assign(new Error('No answer from ' + host + ':' + port + '.'), { code: 'TIMEOUT' })); }, timeoutMs || 8000);
    s.once('secureConnect', () => {
      clearTimeout(t);
      const cert = s.getPeerCertificate();
      const got = normPin(cert && cert.fingerprint256);
      if (got !== want) {
        s.destroy();
        return reject(Object.assign(new Error('The certificate at ' + host + ':' + port + ' is not the one pinned for this printer. Nothing was sent. If the printer was reset or replaced, remove it and add it again.'), { code: 'PIN_MISMATCH' }));
      }
      s.removeAllListeners('error');
      resolve(s);
    });
    s.once('error', (e) => { clearTimeout(t); reject(Object.assign(new Error('Could not reach ' + host + ':' + port + ' (' + e.message + ').'), { code: 'UNREACHABLE' })); });
  });
}

/** A name the SD card and the project_file command both take: ASCII, no path. */
function safeRemoteName(name) {
  let n = path.basename(String(name || 'print.gcode.3mf')).normalize('NFKD').replace(/[^\x20-\x7e]/g, '');
  n = n.replace(/[\\/:*?"<>|#%&{}$!'`@+=]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^[_.]+/, '');
  if (!/\.gcode\.3mf$/i.test(n)) n = n.replace(/(\.gcode)?(\.3mf)?$/i, '') + '.gcode.3mf';
  if (n === '.gcode.3mf') n = 'print.gcode.3mf';
  return n.length > 96 ? n.slice(0, 96 - 10).replace(/[_.]+$/, '') + '.gcode.3mf' : n;
}

class PrinterLink extends EventEmitter {
  /**
   * opts: { host, serial, accessCode, model, pins: { mqtt, ftp }, ports?: { mqtt, ftp } }
   * Events: 'state' (connecting | online | offline | refused | error, detail)
   *         'status' (summary), 'report' (the raw delta), 'sent' ({ topic, payload })
   */
  constructor(opts) {
    super();
    this.host = opts.host;
    this.serial = String(opts.serial || '').trim();
    this.code = opts.accessCode;
    this.modelId = MODELS[opts.model] ? opts.model : 'a1mini';
    this.model = MODELS[this.modelId];
    this.pins = opts.pins || {};
    this.ports = Object.assign({ mqtt: MQTT_PORT, ftp: FTPS_PORT }, opts.ports || {});
    this.report = {};
    this.locked = !!opts.locked;
    this.state = 'offline';
    this._seq = 0;
    this._client = null;
    this._wantOpen = false;
    this._retry = null;
    this._backoff = 2000;
    this._waiters = new Map();
  }

  get topicReport() { return 'device/' + this.serial + '/report'; }
  get topicRequest() { return 'device/' + this.serial + '/request'; }
  status() { return Object.assign(summarise(this.report), { link: this.state, locked: this.locked }); }

  _setState(s, detail) {
    this.state = s;
    this.emit('state', s, detail || '');
    this.emit('status', this.status());
  }

  /** Open the connection and keep it open (reconnecting) until close(). */
  connect() {
    this._wantOpen = true;
    return this._open();
  }

  async _open() {
    clearTimeout(this._retry);
    if (this._client) return;
    this._setState('connecting');
    let socket;
    try {
      socket = await openVerified(this.host, this.ports.mqtt, this.pins.mqtt);
    } catch (e) {
      if (e.code === 'PIN_MISMATCH' || e.code === 'NO_PIN') { this._wantOpen = false; this._setState('refused', e.message); throw e; }
      this._setState('offline', e.message);
      this._again();
      throw e;
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const client = new mqtt.MqttClient(() => socket, {
        clientId: 'nso-' + Math.random().toString(16).slice(2, 10),
        username: USER, password: this.code,
        protocolVersion: 4, clean: true, keepalive: 30,
        reconnectPeriod: 0, connectTimeout: 10000, resubscribe: false
      });
      this._client = client;
      client.on('connect', () => {
        this._backoff = 2000;
        client.subscribe(this.topicReport, { qos: 0 }, (err) => {
          if (err) { this._setState('error', 'Subscribe failed: ' + err.message); return; }
          this._setState('online');
          this.pushAll();
          if (!settled) { settled = true; resolve(); }
        });
      });
      client.on('message', (topic, buf) => this._onMessage(topic, buf));
      client.on('error', (err) => {
        const auth = err && (err.code === 4 || err.code === 5);
        const msg = auth ? 'The printer refused the access code. Check it on the printer\'s screen (it changes when LAN Only is switched).' : (err && err.message) || 'MQTT error';
        if (auth) this._wantOpen = false;
        this._drop(client);
        this._setState(auth ? 'refused' : 'error', msg);
        if (!settled) { settled = true; reject(Object.assign(new Error(msg), { code: auth ? 'AUTH' : 'MQTT' })); }
        if (!auth) this._again();
      });
      client.on('close', () => {
        if (this._client !== client) return;
        this._drop(client);
        this._setState('offline', 'Connection closed.');
        if (!settled) { settled = true; reject(Object.assign(new Error('The printer closed the connection.'), { code: 'CLOSED' })); }
        this._again();
      });
    });
  }

  _drop(client) {
    if (this._client === client) this._client = null;
    try { client.removeAllListeners(); client.on('error', () => {}); client.end(true); } catch (e) { /* already gone */ }
  }

  _again() {
    if (!this._wantOpen) return;
    clearTimeout(this._retry);
    this._retry = setTimeout(() => { this._open().catch(() => {}); }, this._backoff);
    this._backoff = Math.min(this._backoff * 2, 30000);
  }

  close() {
    this._wantOpen = false;
    clearTimeout(this._retry);
    const c = this._client;
    if (c) this._drop(c);
    this._setState('offline', 'Closed.');
  }

  _onMessage(topic, buf) {
    let msg;
    try { msg = JSON.parse(buf.toString('utf8')); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    merge(this.report, msg);
    Object.keys(msg).forEach((cat) => {
      const b = msg[cat];
      const w = b && this._waiters.get(String(b.sequence_id));
      if (w && b.command === w.command) { this._waiters.delete(String(b.sequence_id)); clearTimeout(w.timer); w.resolve(b); }
    });
    this.emit('report', msg);
    this.emit('status', this.status());
  }

  /** Publish one command. Returns its sequence id. Throws when the link is not online. */
  request(category, body) {
    if (!this._client || this.state !== 'online') throw Object.assign(new Error('The printer is not connected.'), { code: 'OFFLINE' });
    const g = guard.checkCommand(body.command, { locked: this.locked });
    if (!g.ok) throw Object.assign(new Error(g.reason), { code: 'LOCKED' });
    const id = String(++this._seq);
    const payload = {};
    payload[category] = Object.assign({ sequence_id: id }, body);
    const text = JSON.stringify(payload);
    this._client.publish(this.topicRequest, text, { qos: 0 });
    this.emit('sent', { topic: this.topicRequest, payload });
    return id;
  }

  /** As request(), then wait for the printer's echo of the command (or null after the timeout: not every command echoes). */
  requestAck(category, body, timeoutMs) {
    const id = this.request(category, body);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this._waiters.delete(id); resolve(null); }, timeoutMs || 5000);
      this._waiters.set(id, { command: body.command, resolve, timer });
    });
  }

  pushAll() { return this.request('pushing', { command: 'pushall', version: 1, push_target: 1 }); }
  pause() { return this.requestAck('print', { command: 'pause', param: '' }); }
  resume() { return this.requestAck('print', { command: 'resume', param: '' }); }
  stop() { return this.requestAck('print', { command: 'stop', param: '' }); }

  /** Dismiss the current print error. TO VERIFY which errors a paused job lets go of (0300-8008 after a hotend swap is the case that matters). */
  clearError() {
    const p = this.report.print || {};
    const body = { command: 'clean_print_error' };
    if (p.subtask_id !== undefined) body.subtask_id = String(p.subtask_id);
    if (p.print_error !== undefined) body.print_error = p.print_error;
    return this.requestAck('print', body);
  }

  /** What the guard would say, without sending. */
  judgeGcode(text) { return guard.checkGcode(text, { jobActive: this.status().jobActive, locked: this.locked }); }

  /** Send G-code lines for the printer to run now. Refused (thrown) when the guard says no. */
  gcode(text) {
    const g = this.judgeGcode(text);
    if (!g.ok) throw Object.assign(new Error(g.reason), { code: 'GUARD' });
    return this.requestAck('print', { command: 'gcode_line', param: g.lines.join('\n') + '\n' });
  }

  /** Re-home X and Y only. Never Z: over a part that is how a print is lost. */
  homeXY() { return this.gcode(this.model.homeXY); }
  setNozzle(c) { return this.gcode('M104 S' + Math.max(0, Math.min(300, Math.round(c)))); }
  setBed(c) { return this.gcode('M140 S' + Math.max(0, Math.min(110, Math.round(c)))); }

  setLock(on) { this.locked = !!on; this.emit('status', this.status()); }

  /** Check the FTPS port's certificate against its pin, log in. The caller closes the client. */
  async _ftp() {
    const client = new ftp.Client(30000);
    try {
      await client.connectImplicitTLS(this.host, this.ports.ftp, { rejectUnauthorized: false });
      const sock = client.ftp.socket;
      const cert = sock && sock.getPeerCertificate && sock.getPeerCertificate();
      if (normPin(cert && cert.fingerprint256) !== normPin(this.pins.ftp) || !normPin(this.pins.ftp)) {
        throw Object.assign(new Error('The file-transfer certificate at ' + this.host + ':' + this.ports.ftp + ' is not the one pinned for this printer. Nothing was sent.'), { code: 'PIN_MISMATCH' });
      }
      await client.login(USER, this.code);
      await client.useDefaultSettings();
      return client;
    } catch (e) {
      client.close();
      throw e;
    }
  }

  /**
   * Put a file on the printer's SD card. src: a path, a Buffer or a Uint8Array.
   * Returns the remote name used. onProgress(bytesSent, total).
   */
  async upload(src, remoteName, onProgress) {
    const isPath = typeof src === 'string';
    const total = isPath ? fs.statSync(src).size : src.byteLength;
    const name = safeRemoteName(remoteName || (isPath ? src : 'print.gcode.3mf'));
    const client = await this._ftp();
    try {
      if (onProgress) client.trackProgress((info) => onProgress(Math.min(info.bytes, total), total));
      await client.uploadFrom(isPath ? src : Readable.from(Buffer.from(src.buffer || src, src.byteOffset || 0, src.byteLength)), name);
      if (onProgress) onProgress(total, total);
      return name;
    } finally {
      client.trackProgress();
      client.close();
    }
  }

  /** The files on the SD card's root (names and sizes). */
  async list() {
    const client = await this._ftp();
    try { return (await client.list()).map((f) => ({ name: f.name, size: f.size, dir: f.isDirectory })); }
    finally { client.close(); }
  }

  /** The project_file command for a file already on the SD card. Field set TO VERIFY on each printer. */
  projectFileBody(remoteName, o) {
    o = o || {};
    const plate = Math.max(1, o.plate | 0 || 1);
    const useAms = !!o.useAms;
    return {
      command: 'project_file',
      param: 'Metadata/plate_' + plate + '.gcode',
      project_id: '0', profile_id: '0', task_id: '0', subtask_id: '0',
      subtask_name: remoteName.replace(/\.gcode\.3mf$/i, ''),
      file: '',
      url: this.model.fileUrl(remoteName),
      md5: '',
      timelapse: !!o.timelapse,
      bed_type: 'auto',
      bed_levelling: o.bedLevelling !== false,
      flow_cali: !!o.flowCali,
      vibration_cali: o.vibrationCali !== false,
      layer_inspect: false,
      ams_mapping: useAms ? (o.amsMapping || [0]) : '',
      use_ams: useAms
    };
  }

  /** Start a file that is on the SD card. */
  startPrint(remoteName, o) {
    const s = this.status();
    if (s.jobActive) throw Object.assign(new Error('The printer is busy (' + s.gcodeState + '). Stop or finish that job first.'), { code: 'BUSY' });
    return this.requestAck('print', this.projectFileBody(remoteName, o), 15000);
  }

  /** Upload, then start. */
  async sendAndPrint(src, remoteName, o, onProgress) {
    const s = this.status();
    if (s.jobActive) throw Object.assign(new Error('The printer is busy (' + s.gcodeState + '). Stop or finish that job first.'), { code: 'BUSY' });
    const name = await this.upload(src, remoteName, onProgress);
    const ack = await this.startPrint(name, o);
    return { name, ack };
  }
}

module.exports = { PrinterLink, probe, openVerified, safeRemoteName, MODELS, MQTT_PORT, FTPS_PORT, guard };
