'use strict';
/* test/server-test.js - the static server and the printer store. Run: npm test (in desktop/). */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { start } = require('../static-server');
const { Store } = require('../store');

let pass = 0, fail = 0;
function ok(c, name, detail) { if (c) pass++; else { fail++; console.log('  FAIL ' + name + (detail ? ' - ' + detail : '')); } }
function get(port, p, host) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers: host ? { Host: host } : {} }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    });
    req.on('error', () => resolve({ status: 0 })); req.end();
  });
}

(async () => {
  const root = path.resolve(__dirname, '..', '..');
  const s = await start(root);
  let r = await get(s.port, '/index.html');
  ok(r.status === 200 && /text\/html/.test(r.type) && r.body.length > 1000, 'serves index.html');
  r = await get(s.port, '/'); ok(r.status === 200, '/ is index.html');
  r = await get(s.port, '/nso_slicer.js?v=abc'); ok(r.status === 200 && /javascript/.test(r.type), 'serves a script, query ignored');
  r = await get(s.port, '/vendor/manifold/manifold.wasm'); ok(r.status === 200 && r.type === 'application/wasm', 'wasm has its type', r.type);
  r = await get(s.port, '/fixtures/bambu-templates/a1mini-0.4/template.json'); ok(r.status === 200, 'serves the fixtures the Print card fetches');
  for (const p of ['/../package.json', '/%2e%2e/%2e%2e/etc/passwd', '/.git/config', '/.gitignore', '/desktop/main.js', '/desktop/node_modules/mqtt/package.json', '/node_modules/x', '/fixtures/%00', '/nope.js', '/docs/../.git/HEAD']) {
    r = await get(s.port, p); ok(r.status === 404, 'refuses ' + p, String(r.status));
  }
  r = await get(s.port, '/index.html', 'evil.example:' + s.port); ok(r.status === 403, 'refuses another Host name');
  r = await new Promise((resolve) => { const q = http.request({ host: '127.0.0.1', port: s.port, path: '/index.html', method: 'POST' }, (res) => resolve({ status: res.statusCode })); q.end(); });
  ok(r.status === 405, 'GET and HEAD only');
  await s.close();

  // The store: the access code is never written in the clear.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-store-'));
  const fakeSafe = (on, backend) => ({ isEncryptionAvailable: () => on, getSelectedStorageBackend: () => backend, encryptString: (t) => Buffer.from('ENC:' + Buffer.from(t).toString('hex')), decryptString: (b) => Buffer.from(b.toString().slice(4), 'hex').toString() });
  let st = new Store(dir, fakeSafe(true, 'gnome_libsecret'), 'linux');
  const p = st.save({ name: 'A1 mini', model: 'a1mini', host: '192.168.1.50', serial: 'S1', pins: { mqtt: 'AA', ftp: 'BB' }, accessCode: 'secret-code-1' });
  ok(p.hasCode && p.codeKept, 'kept with a keychain');
  ok(fs.readFileSync(st.file, 'utf8').indexOf('secret-code-1') < 0, 'the file does not hold the code in the clear');
  ok((fs.statSync(st.file).mode & 0o077) === 0, 'the file is the owner\'s only');
  st = new Store(dir, fakeSafe(true, 'gnome_libsecret'), 'linux');
  ok(st.code(p.id) === 'secret-code-1' && st.list()[0].pins.mqtt === 'AA', 'read back on the next run');
  st.setLock(p.id, true); ok(new Store(dir, fakeSafe(true, 'x'), 'darwin').get(p.id).locked === true, 'the lock survives a restart');
  const st2 = new Store(dir, fakeSafe(true, 'basic_text'), 'linux');
  ok(st2.canKeep() === false && st2.code(p.id) === '', 'no real keychain: a stored code is not trusted');
  const q = st2.save({ name: 'P1S', model: 'p1s', host: 'h', serial: 'S2', pins: {}, accessCode: 'secret-code-2' });
  ok(q.hasCode && !q.codeKept && st2.code(q.id) === 'secret-code-2', 'no keychain: kept for this run only');
  ok(fs.readFileSync(st2.file, 'utf8').indexOf('secret-code-2') < 0, 'and not written at all');
  ok(new Store(dir, fakeSafe(false), 'linux').code(q.id) === '', 'asked for again next run');
  st2.remove(q.id); ok(st2.list().length === 1, 'remove');
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('server-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
