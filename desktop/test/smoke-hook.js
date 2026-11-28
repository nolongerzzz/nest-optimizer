'use strict';
/* test/smoke-hook.js - loaded by main.js only when NSO_DESKTOP_SMOKE is set
   (test/smoke.sh). Drives the real app against the mock printer: the site
   loads in the window, the Printers window adds, checks, saves and connects
   a printer, runs commands, and the guard's refusals show. Writes
   screenshots and a result line, then quits. */
const fs = require('fs');
const path = require('path');
const mock = require('./mock-printer');
const out = process.env.NSO_DESKTOP_SMOKE;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function ({ app, mainWin, openPrinters, store }) {
  const res = { pass: 0, fail: [] };
  const ok = (c, name, d) => { if (c) res.pass++; else res.fail.push(name + (d ? ' - ' + d : '')); };
  const errors = [];
  mainWin.webContents.on('console-message', (e, level, message) => { if (level >= 3) errors.push(message); });
  const shot = async (win, name) => fs.writeFileSync(path.join(out, name), (await win.webContents.capturePage()).toPNG());
  let m;
  try {
    await new Promise((r) => mainWin.webContents.once('did-finish-load', r));
    await wait(4000);
    const site = await mainWin.webContents.executeJavaScript('({ d: !!(window.nsoDesktop && window.nsoDesktop.desktop), keys: Object.keys(window.nsoDesktop || {}), slicer: typeof window.NSO_Slicer, print: typeof window.NSO_Print, three: typeof window.THREE, title: document.title, req: typeof window.require, proc: typeof window.process })');
    ok(site.d, 'the site sees the desktop shell');
    ok(site.keys.sort().join() === 'checkForUpdates,desktop,openPrinters', 'the site is given three things only', site.keys.join());
    ok(site.slicer === 'object' && site.print === 'object', 'the site\'s own scripts loaded', JSON.stringify(site));
    ok(site.req === 'undefined' && site.proc === 'undefined', 'no Node in the page');
    ok(errors.length === 0, 'no console errors on load', errors.slice(0, 3).join(' | '));
    await shot(mainWin, 'site.png');
    const fx = await mainWin.webContents.executeJavaScript('fetch("fixtures/bambu-templates/a1mini-0.4/template.json").then(r => r.status)');
    ok(fx === 200, 'the page can fetch its fixtures');
    const git = await mainWin.webContents.executeJavaScript('fetch("/.git/HEAD").then(r => r.status)');
    ok(git === 404, 'and not the repository');

    const stripInfo = await mainWin.webContents.executeJavaScript('(function(){var s=document.getElementById("nso-desktop-strip"),u=document.getElementById("nso-desktop-update");return s?{n:s.querySelectorAll("button").length,upd:u.hidden,label:s.lastChild.textContent}:null})()');
    ok(stripInfo && stripInfo.n === 2 && stripInfo.upd === true && stripInfo.label === 'Printers', 'the window has its Printers button, and no Update button when there is none', JSON.stringify(stripInfo));
    mainWin.webContents.send('site:update-state', { available: { short: 'abc1234', count: 3 }, busy: false });
    await wait(150);
    ok(await mainWin.webContents.executeJavaScript('var u=document.getElementById("nso-desktop-update"); !u.hidden && u.textContent === "Update ready (3)"'), 'an update shows as a button in the window');
    await shot(mainWin, 'site-update-ready.png');
    ok(/^Nest Optimizer/.test(mainWin.getTitle()), 'the title is the app\'s', mainWin.getTitle());

    m = await mock.start();
    await mainWin.webContents.executeJavaScript('document.querySelector("#nso-desktop-strip button:last-child").click()');
    await wait(300);
    const ui = openPrinters();
    if (ui.webContents.isLoading()) await new Promise((r) => ui.webContents.once('did-finish-load', r));
    await wait(400);
    const js = (code) => ui.webContents.executeJavaScript(code);
    const until = async (code, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 5000)) { if (await js(code)) return true; await wait(100); } return false; };
    ok(await js('!document.getElementById("empty").hidden'), 'Printers opens on "no printer yet"');
    await shot(ui, 'printers-empty.png');
    // The mock listens on its own ports; the form's Check uses the real ones, so pin through the store as Save would.
    const { probe } = require('../printer-link');
    const pins = { mqtt: (await probe('127.0.0.1', m.ports.mqtt)).fingerprint256, ftp: (await probe('127.0.0.1', m.ports.ftp)).fingerprint256 };
    const rec = store.save({ name: 'A1 mini (mock)', model: 'a1mini', host: '127.0.0.1', serial: m.serial, pins, accessCode: m.code });
    ok(fs.readFileSync(store.file, 'utf8').indexOf(m.code) < 0, 'the access code is not in printers.json');
    ui.webContents.reload(); await new Promise((r) => ui.webContents.once('did-finish-load', r)); await wait(500);
    ok(await js('!document.getElementById("detail").hidden && document.getElementById("d-name").textContent === "A1 mini (mock)"'), 'the saved printer shows');
    // Point this run's link at the mock's ports (a real printer listens on 8883 and 990).
    const proto = require('../printer-link').PrinterLink.prototype, open = proto._open;
    proto._open = function () { this.ports = m.ports; return open.call(this); };
    await js('document.getElementById("btn-connect").click()');
    ok(await until('document.getElementById("d-link").textContent === "online"'), 'Connect goes online');
    ok(await until('document.getElementById("s-state").textContent === "IDLE" && document.getElementById("s-nozzle").textContent.indexOf("24.5") === 0'), 'status shows', await js('document.getElementById("s-state").textContent + " " + document.getElementById("s-nozzle").textContent'));
    m.set('gcode_state', 'RUNNING'); m.set('mc_percent', 42); m.set('layer_num', 61); m.set('total_layer_num', 146); m.set('mc_remaining_time', 18); m.set('nozzle_temper', 219.6); m.set('nozzle_target_temper', 220); m.set('bed_temper', 64.8); m.set('bed_target_temper', 65); m.set('subtask_name', 'Clip_test_-_A1_mini');
    ok(await until('document.getElementById("s-pct").textContent === "42%"'), 'live deltas reach the window');
    await js('document.querySelector("[data-cmd=pause]").click()');
    ok(await until('document.getElementById("s-state").textContent === "PAUSE"'), 'Pause');
    await js('var g = document.getElementById("gcode"); g.value = "G28"; g.dispatchEvent(new Event("input"))');
    ok(await until('document.getElementById("btn-gcode").disabled && /re-measures Z/.test(document.getElementById("gcode-verdict").textContent)'), 'a full home while paused is refused in the window, with the reason');
    await shot(ui, 'printers-paused-guard.png');
    await js('document.querySelector("[data-cmd=homeXY]").click()');
    await wait(400);
    ok(m.seen.gcode.slice(-1)[0] === 'G28 X\n', 'Re-home X / Y sends G28 X', JSON.stringify(m.seen.gcode.slice(-1)[0]));
    ok(await js('/gcode_line/.test(document.getElementById("log").textContent)'), 'what was sent is shown');
    await js('document.getElementById("btn-lock").click()');
    ok(await until('!document.getElementById("lockbar").hidden && document.querySelector("[data-cmd=resume]").disabled && document.querySelector("[data-cmd=homeXY]").disabled'), 'the service lock greys Resume and Re-home');
    ok(store.get(rec.id).locked === true, 'the lock is written down');
    await shot(ui, 'printers-locked.png');
  } catch (e) {
    res.fail.push('threw: ' + (e && e.stack || e));
  }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(res, null, 2));
  try { if (m) await m.stop(); } catch (e) { /* closing */ }
  app.exit(res.fail.length ? 1 : 0);
};
