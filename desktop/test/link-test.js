'use strict';
/* test/link-test.js - the printer link against a mock printer on localhost.
   Run: npm test (in desktop/). No real printer, no network beyond 127.0.0.1. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PrinterLink, probe, safeRemoteName } = require('../printer-link');
const guard = require('../printer-link/guard');
const { summarise, printErrorCode, hmsCode } = require('../printer-link/state');
const mock = require('./mock-printer');

let pass = 0, fail = 0;
function ok(cond, name, detail) { if (cond) { pass++; } else { fail++; console.log('  FAIL ' + name + (detail ? ' - ' + detail : '')); } }
async function throwsCode(fn, code, name) { try { await fn(); ok(false, name, 'did not throw'); } catch (e) { ok(e.code === code, name, 'code ' + e.code + ': ' + e.message); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const t = Date.now(); while (Date.now() - t < (ms || 3000)) { if (fn()) return true; await wait(20); } return false; }

(async () => {
  // ---- pure parts ----
  ok(printErrorCode(0x03008008) === '0300-8008', 'print_error formats as the touchscreen shows it');
  ok(printErrorCode(0) === '', 'no error is empty');
  ok(hmsCode({ attr: 0x03001000, code: 0x00020001 }) === '0300-1000-0002-0001', 'hms code formats as the wiki names it');
  ok(summarise({}).jobActive === null && summarise({}).gcodeState === null, 'unknown state stays unknown');
  ok(safeRemoteName('String test - A1 mini.gcode.3mf') === 'String_test_-_A1_mini.gcode.3mf', 'remote name: spaces', safeRemoteName('String test - A1 mini.gcode.3mf'));
  ok(safeRemoteName('../../etc/passwd') === 'passwd.gcode.3mf', 'remote name: no path', safeRemoteName('../../etc/passwd'));
  ok(safeRemoteName('plate.3mf') === 'plate.gcode.3mf', 'remote name: extension');
  ok(/^.{1,96}$/.test(safeRemoteName('x'.repeat(300) + '.gcode.3mf')) && /\.gcode\.3mf$/.test(safeRemoteName('x'.repeat(300))), 'remote name: bounded');

  const idle = { jobActive: false, locked: false }, job = { jobActive: true, locked: false }, unk = { jobActive: null, locked: false }, lock = { jobActive: true, locked: true };
  ok(guard.checkGcode('G28', idle).ok, 'guard: full home when idle');
  ok(!guard.checkGcode('G28', job).ok, 'guard: full home refused during a job');
  ok(!guard.checkGcode('G28 ; home', job).ok, 'guard: a comment does not hide it');
  ok(!guard.checkGcode('G28 X Y Z', job).ok && !guard.checkGcode('g28 z', job).ok, 'guard: Z home refused during a job');
  ok(guard.checkGcode('G28 X', job).ok && guard.checkGcode('G28 X Y', job).ok, 'guard: X/Y home allowed during a job');
  ok(!guard.checkGcode('G28', unk).ok, 'guard: unknown state is treated as a job');
  ok(!guard.checkGcode('M104 S220\nG28', job).ok, 'guard: every line is judged');
  ok(guard.checkGcode('M104 S220', job).ok && guard.checkGcode('M83\nG1 E20 F100', job).ok, 'guard: temperature and purge allowed during a job');
  ok(!guard.checkGcode('G29', job).ok, 'guard: bed probe refused during a job');
  ok(!guard.checkGcode('G1 X10', lock).ok && !guard.checkGcode('G28 X', lock).ok && !guard.checkGcode('G0 Z5', lock).ok, 'lock: motion and homing refused');
  ok(guard.checkGcode('M104 S0', lock).ok && guard.checkGcode('G1 E5 F100', lock).ok, 'lock: heat and extrude allowed');
  ok(!guard.checkCommand('resume', { locked: true }).ok && guard.checkCommand('pause', { locked: true }).ok, 'lock: resume refused, pause allowed');
  ok(!guard.checkGcode('', idle).ok && !guard.checkGcode('; only a comment', idle).ok, 'guard: nothing to send');

  // ---- against the mock ----
  const m = await mock.start();
  const other = await mock.start({ serial: 'IMPOSTER00000000' });
  try {
    const c = await probe('127.0.0.1', m.ports.mqtt);
    ok(c.subjectCN === m.serial && /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(c.fingerprint256), 'probe reads the certificate (CN is the serial)');
    const cf = await probe('127.0.0.1', m.ports.ftp);
    const pins = { mqtt: c.fingerprint256, ftp: cf.fingerprint256 };
    await throwsCode(() => probe('127.0.0.1', 1, 1500), undefined, 'probe: a closed port says so');

    const mk = (o) => new PrinterLink(Object.assign({ host: '127.0.0.1', serial: m.serial, accessCode: m.code, model: 'a1mini', pins, ports: m.ports }, o || {}));

    // The pin: an imposter's certificate is refused before the access code is sent.
    const before = other.seen.connects;
    const wrong = mk({ ports: other.ports });
    wrong.on('error', () => {});
    await throwsCode(() => wrong.connect(), 'PIN_MISMATCH', 'another certificate on the MQTT port is refused');
    await wait(150);
    ok(other.seen.connects === before, 'nothing reached the imposter (no login attempt)', String(other.seen.connects - before));
    ok(wrong.state === 'refused', 'state says refused', wrong.state);
    await throwsCode(() => mk({ pins: {} }).connect(), 'NO_PIN', 'no pin, no connection');
    await throwsCode(() => wrong.upload(Buffer.from('x'), 'a.gcode.3mf'), 'PIN_MISMATCH', 'another certificate on the FTPS port is refused');

    // A wrong access code is reported as such and not retried.
    const badCode = mk({ accessCode: 'nope' });
    await throwsCode(() => badCode.connect(), 'AUTH', 'wrong access code');
    const n0 = m.seen.connects; await wait(2600);
    ok(m.seen.connects === n0 && badCode.state === 'refused', 'a refused code is not hammered', badCode.state + ' ' + (m.seen.connects - n0));
    badCode.close();

    // Connect, status, commands.
    const link = mk();
    const sent = []; link.on('sent', (s) => sent.push(s));
    await throwsCode(async () => link.request('print', { command: 'pause' }), 'OFFLINE', 'no command while offline');
    await link.connect();
    ok(link.state === 'online', 'online');
    ok(await until(() => link.status().gcodeState === 'IDLE'), 'pushall brings the full report');
    let s = link.status();
    ok(s.nozzle.temp === 24.5 && s.bed.temp === 23 && s.jobActive === false && s.wifi === '-41dBm' && s.sdcard === true, 'summary', JSON.stringify(s));
    ok(sent[0].topic === 'device/' + m.serial + '/request' && sent[0].payload.pushing.command === 'pushall', 'pushall goes to the request topic');

    m.set('nozzle_temper', 219.8); m.set('print_error', 0x03008008);
    ok(await until(() => link.status().nozzle.temp === 219.8 && link.status().printError === '0300-8008'), 'deltas merge into the kept report');
    ok(link.status().bed.temp === 23, 'a delta leaves the other keys');
    const ce = await link.clearError();
    ok(ce && ce.result === 'success' && m.seen.requests.slice(-1)[0].print.print_error === 0x03008008, 'clean_print_error carries the error it clears');
    ok(await until(() => link.status().printError === ''), 'error cleared');

    // Upload and start.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-link-'));
    const file = path.join(tmp, 'Clip test - A1 mini.gcode.3mf');
    const bytes = Buffer.alloc(300000, 7); fs.writeFileSync(file, bytes);
    let prog = [];
    const name = await link.upload(file, null, (a, b) => prog.push([a, b]));
    ok(name === 'Clip_test_-_A1_mini.gcode.3mf', 'upload: name', name);
    ok(fs.existsSync(path.join(m.sd, name)) && fs.readFileSync(path.join(m.sd, name)).equals(bytes), 'upload: the bytes arrive on the SD card');
    ok(prog.length && prog[prog.length - 1][0] === bytes.length, 'upload: progress ends at the total');
    const n2 = await link.upload(new Uint8Array([1, 2, 3, 4]), 'bytes.gcode.3mf');
    ok(fs.readFileSync(path.join(m.sd, n2)).equals(Buffer.from([1, 2, 3, 4])), 'upload: from bytes');
    ok((await link.list()).some((f) => f.name === name && f.size === bytes.length), 'list: the file is there');

    const body = link.projectFileBody(name, {});
    ok(body.param === 'Metadata/plate_1.gcode' && body.url === 'file:///sdcard/' + name && body.use_ams === false && body.bed_levelling === true && body.subtask_name === 'Clip_test_-_A1_mini', 'project_file body', JSON.stringify(body));
    const miss = await link.startPrint('missing.gcode.3mf', {});
    ok(miss && miss.result === 'fail', 'start: a file that is not there fails, and says so');
    const ack = await link.startPrint(name, { timelapse: false });
    ok(ack && ack.result === 'success', 'start: accepted');
    ok(await until(() => link.status().jobActive === true), 'the job is active');
    await throwsCode(async () => link.startPrint(name, {}), 'BUSY', 'no second job on a busy printer');

    // The guard, live.
    m.set('gcode_state', 'RUNNING'); await until(() => link.status().gcodeState === 'RUNNING');
    const p = await link.pause();
    ok(p && p.result === 'success' && (await until(() => link.status().paused)), 'pause');
    const g0 = m.seen.gcode.length;
    await throwsCode(async () => link.gcode('G28'), 'GUARD', 'a full home during a pause never leaves the app');
    ok(m.seen.gcode.length === g0, 'nothing was sent');
    await link.homeXY();
    ok(m.seen.gcode.slice(-1)[0] === 'G28 X\n', 'home X/Y sends the A1 mini\'s own re-home line', JSON.stringify(m.seen.gcode.slice(-1)[0]));
    await link.setNozzle(220.4);
    ok(m.seen.gcode.slice(-1)[0] === 'M104 S220\n', 'nozzle temperature');

    link.setLock(true);
    ok(link.status().locked === true, 'lock shows in the status');
    await throwsCode(async () => link.homeXY(), 'GUARD', 'locked: no homing');
    await throwsCode(async () => link.resume(), 'LOCKED', 'locked: no resume');
    await link.setNozzle(0);
    ok(m.seen.gcode.slice(-1)[0] === 'M104 S0\n', 'locked: the nozzle can still be turned off');
    link.setLock(false);
    const r = await link.resume();
    ok(r && r.result === 'success', 'unlocked: resume');

    // Reconnect after the printer drops.
    const events = []; link.on('state', (st) => events.push(st));
    for (const c2 of Object.values(link._client ? { a: link._client } : {})) c2.stream.destroy();
    ok(await until(() => events.indexOf('offline') >= 0), 'a dropped connection is noticed');
    ok(await until(() => link.state === 'online', 6000), 'and re-opened');
    link.close();
    ok(link.state === 'offline', 'close');
    await wait(100);
    fs.rmSync(tmp, { recursive: true, force: true });
  } finally {
    await m.stop(); await other.stop();
  }
  console.log('link-test: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
