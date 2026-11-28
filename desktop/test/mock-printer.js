'use strict';
/* test/mock-printer.js - a stand-in for a Bambu printer on localhost: an MQTT
   broker over TLS that answers as the firmware is documented to, and an
   implicit-TLS FTP server for the SD card. For the checks only. */
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const FtpSrv = require('ftp-srv');

function makeCert(dir, cn) {
  const key = path.join(dir, cn + '.key'), crt = path.join(dir, cn + '.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=' + cn], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

async function start(opts) {
  opts = opts || {};
  const serial = opts.serial || '0309DA000000001';
  const code = opts.code || '12345678';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-mock-'));
  const sd = path.join(dir, 'sdcard'); fs.mkdirSync(sd);
  const id = makeCert(dir, serial);
  const broker = require('aedes').createBroker();
  const seen = { connects: 0, requests: [], gcode: [] };
  const report = { print: { command: 'push_status', gcode_state: 'IDLE', nozzle_temper: 24.5, nozzle_target_temper: 0, bed_temper: 23, bed_target_temper: 0, mc_percent: 0, mc_remaining_time: 0, layer_num: 0, total_layer_num: 0, wifi_signal: '-41dBm', print_error: 0, hms: [], sdcard: true } };
  const topicReport = 'device/' + serial + '/report', topicRequest = 'device/' + serial + '/request';
  const pub = (obj) => broker.publish({ topic: topicReport, payload: Buffer.from(JSON.stringify(obj)), qos: 0, retain: false }, () => {});

  broker.authenticate = (client, username, password, done) => {
    seen.connects++;
    const ok = username === 'bblp' && password && password.toString() === code;
    if (ok) return done(null, true);
    const e = new Error('bad'); e.returnCode = 4; done(e, false);
  };
  broker.on('publish', (packet, client) => {
    if (!client || packet.topic !== topicRequest) return;
    let m; try { m = JSON.parse(packet.payload.toString()); } catch (e) { return; }
    seen.requests.push(m);
    if (m.pushing && m.pushing.command === 'pushall') return pub(report);
    const p = m.print; if (!p) return;
    const echo = (extra) => pub({ print: Object.assign({ command: p.command, sequence_id: p.sequence_id, result: 'success', reason: '' }, extra || {}) });
    if (p.command === 'pause') { report.print.gcode_state = 'PAUSE'; echo({ gcode_state: 'PAUSE' }); }
    else if (p.command === 'resume') { report.print.gcode_state = 'RUNNING'; echo({ gcode_state: 'RUNNING' }); }
    else if (p.command === 'stop') { report.print.gcode_state = 'IDLE'; echo({ gcode_state: 'IDLE' }); }
    else if (p.command === 'gcode_line') { seen.gcode.push(p.param); echo(); }
    else if (p.command === 'clean_print_error') { report.print.print_error = 0; echo({ print_error: 0 }); }
    else if (p.command === 'project_file') {
      const f = decodeURIComponent(String(p.url).replace('file:///sdcard/', ''));
      if (!fs.existsSync(path.join(sd, f))) return pub({ print: { command: p.command, sequence_id: p.sequence_id, result: 'fail', reason: 'file not found' } });
      report.print.gcode_state = 'PREPARE'; report.print.subtask_name = p.subtask_name;
      echo({ gcode_state: 'PREPARE', subtask_name: p.subtask_name });
    }
  });

  const mqttServer = tls.createServer({ key: id.key, cert: id.cert }, broker.handle);
  await new Promise((r) => mqttServer.listen(0, '127.0.0.1', r));

  const ftpPort = await new Promise((r) => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const ftpServer = new FtpSrv({ url: 'ftps://127.0.0.1:' + ftpPort, pasv_url: '127.0.0.1', pasv_min: 40000, pasv_max: 40100, tls: { key: id.key, cert: id.cert }, anonymous: false, greeting: 'mock', log: require('bunyan').createLogger({ name: 'ftp', level: 61 }) });
  ftpServer.on('login', ({ username, password }, resolve, reject) => (username === 'bblp' && password === code) ? resolve({ root: sd }) : reject(new Error('bad login')));
  await ftpServer.listen();

  return {
    serial, code, sd, seen, report, pub,
    ports: { mqtt: mqttServer.address().port, ftp: ftpPort },
    set(k, v) { report.print[k] = v; const d = {}; d[k] = v; pub({ print: d }); },
    async stop() { await ftpServer.close(); await new Promise((r) => broker.close(r)); mqttServer.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}
module.exports = { start, makeCert };
