'use strict';
/* store.js - the printers the owner has added, kept between runs.

   printers.json (in the app's user-data folder) holds each printer's name,
   model, address, serial, certificate pins and lock flag. The LAN access code
   is the secret: it is encrypted with the operating system's keychain
   (Electron safeStorage: the macOS Keychain, libsecret or KWallet on Linux)
   and only the ciphertext is written. Where no real keychain is available
   (a Linux session without one), the code is NOT written to disk at all: it
   is kept for this run and asked for again next time. It is never stored in
   plain text and never leaves this machine. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  /** dir: the user-data folder. safe: Electron's safeStorage (or a stand-in with the same three methods). */
  constructor(dir, safe, platform) {
    this.file = path.join(dir, 'printers.json');
    this.safe = safe;
    this.platform = platform || process.platform;
    this.session = new Map();
    this.data = { printers: [] };
    try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (d && Array.isArray(d.printers)) this.data = d; } catch (e) { /* first run */ }
  }

  /** True when a code written now is protected by a real keychain. */
  canKeep() {
    try {
      if (!this.safe || !this.safe.isEncryptionAvailable()) return false;
      if (this.platform === 'linux' && this.safe.getSelectedStorageBackend && this.safe.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    } catch (e) { return false; }
  }

  _write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  _public(p) {
    return { id: p.id, name: p.name, model: p.model, host: p.host, serial: p.serial, pins: p.pins, locked: !!p.locked,
      hasCode: !!this.code(p.id), codeKept: !!p.codeEnc };
  }
  list() { return this.data.printers.map((p) => this._public(p)); }
  get(id) { const p = this.data.printers.find((x) => x.id === id); return p ? this._public(p) : null; }

  /** The access code, or '' when it has to be asked for again. */
  code(id) {
    if (this.session.has(id)) return this.session.get(id);
    const p = this.data.printers.find((x) => x.id === id);
    if (!p || !p.codeEnc || !this.canKeep()) return '';
    try { const c = this.safe.decryptString(Buffer.from(p.codeEnc, 'base64')); this.session.set(id, c); return c; } catch (e) { return ''; }
  }

  /** Add or change a printer. rec.accessCode, when given, replaces the stored one. */
  save(rec) {
    let p = rec.id && this.data.printers.find((x) => x.id === rec.id);
    if (!p) { p = { id: crypto.randomBytes(6).toString('hex') }; this.data.printers.push(p); }
    ['name', 'model', 'host', 'serial'].forEach((k) => { if (rec[k] !== undefined) p[k] = String(rec[k]).trim(); });
    if (rec.pins) p.pins = { mqtt: String(rec.pins.mqtt || ''), ftp: String(rec.pins.ftp || '') };
    if (rec.accessCode) {
      this.session.set(p.id, String(rec.accessCode));
      p.codeEnc = this.canKeep() ? this.safe.encryptString(String(rec.accessCode)).toString('base64') : null;
    }
    this._write();
    return this._public(p);
  }

  setLock(id, on) {
    const p = this.data.printers.find((x) => x.id === id);
    if (!p) return;
    p.locked = !!on;
    this._write();
  }

  remove(id) {
    this.data.printers = this.data.printers.filter((x) => x.id !== id);
    this.session.delete(id);
    this._write();
  }
}
module.exports = { Store };
