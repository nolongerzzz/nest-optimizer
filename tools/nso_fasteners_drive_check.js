#!/usr/bin/env node
/* Fasteners (Gen+ > Fasteners), driven through the real app: real index.html, real script tags, real clicks, real Undo.
     node tools/nso_fasteners_drive_check.js            exit 0 = every gate held
     FASTENERS_SHOTS=dir node tools/nso_fasteners_drive_check.js   also screenshots

   The geometry is proven headless in tools/nso_thread_test.js. What this proves is the card: it is in Gen+, its blank
   fields show their defaults, Rod / Bolt / Nut / Bolt + nut each drop pieces of their own - named, selected, closed,
   the size the standard says - one Undo each, a typed Ø and pitch and a left hand are honoured, a refusal says why and
   adds nothing, and the nut and the bolt made together are built to turn on each other. */

const fs = require('fs');
const path = require('path');
const { withApp, statusOf } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = process.env.FASTENERS_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

async function setField(page, id, value) {
  await page.evaluate(([id, v]) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, [id, value]);
}
const pieces = page => page.evaluate(() => state.models.filter(Boolean).map(m => ({ id: m.id, name: m.name, size: m.size && { x: m.size.x, y: m.size.y, z: m.size.z } })));
const topoOf = (page, id) => page.evaluate(id => { const m = state.models.find(x => x && x.id === id); return NSO_bendTopology(m.rawTris); }, id);
const readout = page => page.evaluate(() => ({ text: document.getElementById('fs-readout').textContent, bad: document.getElementById('fs-readout').classList.contains('is-bad') }));
const selName = page => page.evaluate(() => { const m = getActiveModel(); return m ? m.name : null; });
const undoDepth = page => page.evaluate(() => state.undoStack.length);
async function frame(page) {
  await page.evaluate(() => {
    const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh;
    mesh.updateMatrixWorld(true);
    const c = new THREE.Vector3(); new THREE.Box3().setFromObject(mesh).getCenter(c);
    state.controls.target.copy(c); state.camera.position.set(c.x + 30, c.y + 28, c.z + 42); state.controls.update(); state.camera.updateMatrixWorld(true);
  });
}
async function shot(page, name) {
  if (!SHOTS) return;
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: path.join(SHOTS, name) });
  console.log('   screenshot ' + path.join(SHOTS, name));
}
async function waitStatus(page, re) {
  await page.waitForFunction(re => new RegExp(re).test(document.getElementById('status').textContent), re.source, { timeout: 30000 });
  return statusOf(page);
}

withApp(async (page, logs) => {
  console.log('\n=== 1. the card, in Gen+, defaults showing ===');
  const ui = await page.evaluate(() => {
    const el = id => document.getElementById(id), menu = document.querySelector('.vp-fasteners-menu');
    const ids = ['btn-fs-rod', 'btn-fs-bolt', 'btn-fs-nut', 'btn-fs-set', 'sel-fs-size', 'sel-fs-hand', 'sel-fs-head', 'inp-fs-major', 'inp-fs-pitch', 'inp-fs-length', 'inp-fs-fit', 'inp-fs-nutm', 'fs-readout'];
    return { menu: !!menu, inGen: !!(menu && menu.closest('#menu-gen')), ids: ids.every(i => !!el(i)), wired: ['btn-fs-rod', 'btn-fs-bolt', 'btn-fs-nut', 'btn-fs-set'].every(i => el(i).dataset.nsoWired === '1'),
             size: el('sel-fs-size').value, fit: el('inp-fs-fit').placeholder, sizes: el('sel-fs-size').options.length };
  });
  check('Fasteners is in the Gen+ menu with all its controls, wired at load', ui.menu && ui.inGen && ui.ids && ui.wired, JSON.stringify(ui));
  check('M8 is the default size, the blank Fit says 0.2, and the table has 35 sizes (15 coarse, 11 fine, 9 G)', ui.size === 'M8' && ui.fit === '0.2' && ui.sizes === 35, JSON.stringify(ui));

  console.log('\n=== 2. Bolt: an M8 hex bolt, 25 mm, a piece of its own ===');
  await page.evaluate(() => { state.editId = null; state.selectedIndex = -1; });
  const d0 = await undoDepth(page);
  await page.click('#btn-fs-bolt');
  let st = await waitStatus(page, /Dropped bolt M8|Bolt refused/);
  console.log('   status: ' + st);
  let P = await pieces(page);
  const bolt = P.find(p => p.name === 'bolt M8 1') || P.find(p => /^bolt M8/.test(p.name));
  check('a piece "bolt M8 1" is added, selected, with one Undo entry', !!bolt && (await selName(page)) === bolt.name && (await undoDepth(page)) === d0 + 1, JSON.stringify(P.map(p => p.name)));
  check('the status gives its numbers: 13.0 across flats, head 5.3, pitch 1.25, right-hand, head down', /^Dropped bolt M8 1 - Hex bolt M8 × 25\.0 \(ISO metric 60°\): 13\.0 across flats, head 5\.3 mm, pitch 1\.25 mm, right-hand, head down on the bed/.test(st), st);
  check('its size: 15.0 across the hex corners, 13.0 across flats, 30.3 tall (5.3 head + 25 shank)', bolt && Math.abs(bolt.size.x - 15.01) < 0.03 && Math.abs(bolt.size.z - 13) < 0.03 && Math.abs(bolt.size.y - 30.3) < 0.03, bolt && JSON.stringify(bolt.size));
  const T = await topoOf(page, bolt.id);
  check('closed, 2-manifold, consistently wound, no degenerate faces, Euler 2', T.open === 0 && T.nm === 0 && T.flip === 0 && T.degen === 0 && T.euler === 2, JSON.stringify(T));
  let rd = await readout(page);
  check('the card\'s readout says the same, not as an error', !rd.bad && /^Hex bolt M8 × 25\.0/.test(rd.text), rd.text);
  await frame(page); await shot(page, 'fasteners-bolt.png');
  await page.click('#btn-undo'); await waitStatus(page, /Undo/);
  check('one Undo takes it off', (await pieces(page)).length === 0 && (await undoDepth(page)) === d0, JSON.stringify((await pieces(page)).map(p => p.name)));

  console.log('\n=== 3. Nut, Rod; the heads and the hand ===');
  await page.click('#btn-fs-nut');
  st = await waitStatus(page, /Dropped nut M8|Nut refused/);
  P = await pieces(page);
  const nut = P.find(p => /^nut M8/.test(p.name));
  const Tn = nut && await topoOf(page, nut.id);
  check('Nut: "nut M8 1", 13 across flats and 6.8 thick, a ring (Euler 0), bore = bolt + 0.2 said in the status',
    !!nut && Math.abs(nut.size.y - 6.8) < 0.02 && Math.abs(nut.size.z - 13) < 0.03 && Tn.open === 0 && Tn.nm === 0 && Tn.flip === 0 && Tn.euler === 0 && /bore Ø8\.40 \(the bolt's \+ 0\.20 mm fit\)/.test(st), st);
  await frame(page); await shot(page, 'fasteners-nut.png');
  await setField(page, 'inp-fs-nutm', '10'); await setField(page, 'inp-fs-fit', '0.3');
  await page.click('#btn-fs-nut');
  st = await waitStatus(page, /Dropped nut M8 2|Nut refused/);
  check('a typed thickness 10 and Fit 0.3: bore Ø8.60 and 10 mm thick', /10\.0 mm thick, bore Ø8\.60 \(the bolt's \+ 0\.30 mm fit\)/.test(st), st);
  await setField(page, 'inp-fs-nutm', ''); await setField(page, 'inp-fs-fit', '');
  await setField(page, 'sel-fs-size', 'M6'); await setField(page, 'inp-fs-length', '20');
  await page.click('#btn-fs-rod');
  st = await waitStatus(page, /Dropped rod M6|Rod refused/);
  P = await pieces(page);
  const rod = P.find(p => /^rod M6/.test(p.name)), Tr = rod && await topoOf(page, rod.id);
  check('Rod M6 × 20: Ø6 across, 20 tall, closed, Euler 2', !!rod && Math.abs(rod.size.y - 20) < 0.01 && Math.abs(rod.size.x - 6) < 0.05 && Tr.open === 0 && Tr.nm === 0 && Tr.euler === 2, rod && JSON.stringify(rod.size));
  await setField(page, 'sel-fs-head', 'socket'); await setField(page, 'inp-fs-length', '');
  await page.click('#btn-fs-bolt');
  st = await waitStatus(page, /Dropped bolt M6|Bolt refused/);
  P = await pieces(page);
  const sock = P.find(p => /^bolt M6/.test(p.name)), Ts = sock && await topoOf(page, sock.id);
  check('Socket-head M6 × 25: Ø10 head, 6 + 25 tall = 31, a 5 hex socket, closed, Euler 2',
    !!sock && Math.abs(sock.size.x - 10) < 0.05 && Math.abs(sock.size.y - 31) < 0.02 && Ts.open === 0 && Ts.nm === 0 && Ts.euler === 2 && /Socket-head bolt M6 × 25\.0.*5\.0 hex socket/.test(st), st);
  await setField(page, 'sel-fs-head', 'hex');
  await setField(page, 'sel-fs-hand', 'left');
  await page.click('#btn-fs-nut');
  st = await waitStatus(page, /Dropped nut M6/);
  check('Left hand is honoured: the nut says left-hand', /left-hand/.test(st), st);
  await setField(page, 'sel-fs-hand', 'right');
  // a typed Ø and pitch: any other thread
  await setField(page, 'inp-fs-major', '7'); await setField(page, 'inp-fs-pitch', '1.5'); await setField(page, 'inp-fs-length', '15');
  await page.click('#btn-fs-rod');
  st = await waitStatus(page, /Dropped rod M6 2|Rod refused/);
  check('a typed Ø7 / pitch 1.5 beats the size: the rod says Ø7.00, pitch 1.50', /Ø7\.00 \/ root Ø.*pitch 1\.50 mm/.test(st), st);
  for (const id of ['inp-fs-major', 'inp-fs-pitch', 'inp-fs-length']) await setField(page, id, '');

  console.log('\n=== 4. Bolt + nut: two pieces, one thread, built to turn ===');
  await setField(page, 'sel-fs-size', 'M10');
  const nBefore = (await pieces(page)).length, dBefore = await undoDepth(page);
  await page.click('#btn-fs-set');
  st = await waitStatus(page, /Dropped nut M10/);
  P = await pieces(page);
  const b10 = P.find(p => /^bolt M10/.test(p.name)), n10 = P.find(p => /^nut M10/.test(p.name));
  check('"bolt M10 1" and "nut M10 1" are both added, one Undo each', !!b10 && !!n10 && P.length === nBefore + 2 && (await undoDepth(page)) === dBefore + 2, JSON.stringify(P.map(p => p.name)));
  // the pair, measured in the page: the nut's bore less the bolt's radius, at the same helix phase, is the Fit all round
  const gap = await page.evaluate(([bid, nid]) => {
    const b = state.models.find(m => m && m.id === bid).rawTris, n = state.models.find(m => m && m.id === nid).rawTris;
    function first(s, o, d) { let best = Infinity;
      for (let t = 0; t < s.length; t += 9) {
        const e1 = [s[t + 3] - s[t], s[t + 4] - s[t + 1], s[t + 5] - s[t + 2]], e2 = [s[t + 6] - s[t], s[t + 7] - s[t + 1], s[t + 8] - s[t + 2]];
        const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
        const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2]; if (Math.abs(det) < 1e-12) continue;
        const w = [o[0] - s[t], o[1] - s[t + 1], o[2] - s[t + 2]], u = (w[0] * p[0] + w[1] * p[1] + w[2] * p[2]) / det; if (u < -1e-9 || u > 1 + 1e-9) continue;
        const q = [w[1] * e1[2] - w[2] * e1[1], w[2] * e1[0] - w[0] * e1[2], w[0] * e1[1] - w[1] * e1[0]];
        const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det; if (v < -1e-9 || u + v > 1 + 1e-9) continue;
        const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det; if (tt > 1e-9 && tt < best) best = tt;
      } return best; }
    // both pieces are in their own raw frames, axis +Z, centred on it; the bolt's shank starts at its head's top
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < b.length; i += 3) { lo = Math.min(lo, b[i + 2]); hi = Math.max(hi, b[i + 2]); }
    let gmin = Infinity;
    for (let c = 0; c < 60; c++) { const dz = 1.5 * c / 60; let g = Infinity;
      for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) { const th = i * Math.PI / 4, z = 2 + j * 1.3;
        const rn = first(n, [0, 0, z], [Math.cos(th), Math.sin(th), 0]), rb = first(b, [0, 0, z + 12 - dz], [Math.cos(th), Math.sin(th), 0]);
        if (isFinite(rn) && isFinite(rb)) g = Math.min(g, rn - rb); }
      gmin = Math.max(gmin === Infinity ? -Infinity : gmin, g); }
    return gmin;
  }, [b10.id, n10.id]);
  check('measured on the two pieces in the page: the bolt has a screw position that clears the nut by ' + gap.toFixed(3) + ' mm (the 0.2 fit)', gap > 0.17 && gap < 0.22, gap.toFixed(3));
  await frame(page); await shot(page, 'fasteners-set.png');

  console.log('\n=== 5. refusals, said in the card, nothing added ===');
  const n0 = (await pieces(page)).length, u0 = await undoDepth(page);
  await setField(page, 'inp-fs-nutm', '1');
  await page.click('#btn-fs-nut');
  st = await waitStatus(page, /Nut refused/);
  rd = await readout(page);
  check('a nut thinner than a pitch: in words, in red, nothing added', rd.bad && /^Nut: a nut thinner than one pitch \(1\.50 mm\) does not engage - make it at least 3\.0 mm$/.test(rd.text) && (await pieces(page)).length === n0 && (await undoDepth(page)) === u0, rd.text);
  await setField(page, 'inp-fs-nutm', '');
  await setField(page, 'inp-fs-pitch', '0.2');
  await page.click('#btn-fs-rod');
  st = await waitStatus(page, /Rod refused/);
  rd = await readout(page);
  check('a pitch too fine to form: refused with the least pitch', rd.bad && /would not form\. Use a pitch of at least 0\.33 mm/.test(rd.text) && (await pieces(page)).length === n0, rd.text);
  await setField(page, 'inp-fs-pitch', '');
  await setField(page, 'sel-fs-size', 'M3');
  await page.click('#btn-fs-rod');
  st = await waitStatus(page, /Dropped rod M3/);
  rd = await readout(page);
  check('M3: made, with the note that 0.5 mm is finer than a 0.4 nozzle resolves (not an error)', !rd.bad && /note: a 0\.50 mm pitch is finer than a 0\.4 mm nozzle resolves well/.test(rd.text), rd.text);
  const errs = logs.filter(l => /\[pageerror\]/.test(l));
  check('no uncaught page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log(fails ? '\n' + fails + ' gate(s) FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
}).catch(err => { console.error(err); process.exit(1); });
