#!/usr/bin/env node
/* Fittings, driven through the real app: real index.html, real script tags, real clicks, real Undo.
     node tools/nso_fittings_drive_check.js            exit 0 = every gate held
     FITTINGS_SHOTS=dir node tools/nso_fittings_drive_check.js   also screenshots

   The geometry is proven headless in tools/nso_fittings_test.js. What this proves is the card: it is in
   Gen+, its fields show their defaults as placeholders, Cap reads the SELECTED tube and drops a cup of
   the tube's own wall beside it without touching it, the 2- and 3-way splitters drop pieces of their own
   (with something selected and with nothing), the new piece is selected and named, one Undo takes each
   back, "Ø from tube" fills the fields, and a refusal says why and adds nothing. The Manifold kernel is
   served from vendor/ by the harness, as for every other boolean drive check. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, statusOf } = require('./nso_app_harness');
// as a click on the piece does: the plate's selection AND the piece being edited (the harness's selectModel sets only the latter)
const selectModel = (page, id) => page.evaluate(id => { const i = state.placed.findIndex(p => p && p.sourceId === id); state.editId = id; if (i >= 0) selectPlaced(i); }, id);

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const SHOTS = process.env.FITTINGS_SHOTS || null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-fittings-'));
function writeSTL(name, soup) {
  const file = path.join(TMP, name), n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}
const NSO_Stock = require('../nso_stock.js');
const stockTube = (rOut, wall, h) => NSO_Stock.revolve(NSO_Stock.profileTube(rOut, rOut - wall, h), 96);

async function setField(page, id, value) {
  await page.evaluate(([id, v]) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, [id, value]);
}
const pieces = page => page.evaluate(() => state.models.filter(Boolean).map(m => ({ id: m.id, name: m.name, size: m.size && { x: m.size.x, y: m.size.y, z: m.size.z } })));
const topoOf = (page, id) => page.evaluate(id => { const m = state.models.find(x => x && x.id === id); return NSO_bendTopology(m.rawTris); }, id);
const readout = page => page.evaluate(() => ({ text: document.getElementById('fx-readout').textContent, bad: document.getElementById('fx-readout').classList.contains('is-bad') }));
const selName = page => page.evaluate(() => { const m = getActiveModel(); return m ? m.name : null; });
async function frame(page) {
  await page.evaluate(() => {
    const m = getActiveModel(), p = state.placed.find(q => q.sourceId === m.id), mesh = p.mesh;
    mesh.updateMatrixWorld(true);
    const c = new THREE.Vector3(); new THREE.Box3().setFromObject(mesh).getCenter(c);
    state.controls.target.copy(c); state.camera.position.set(c.x + 60, c.y + 55, c.z + 85); state.controls.update(); state.camera.updateMatrixWorld(true);
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
    const el = id => document.getElementById(id), menu = document.querySelector('.vp-fittings-menu');
    return { menu: !!menu, inGen: !!(menu && menu.closest('#menu-gen')), ids: ['btn-fx-cap', 'btn-fx-split2', 'btn-fx-split3', 'btn-fx-fromtube', 'inp-fx-gap', 'inp-fx-depth', 'inp-fx-od', 'inp-fx-wall', 'inp-fx-bod', 'inp-fx-angle', 'inp-fx-trunk', 'inp-fx-branch', 'sel-fx-end', 'fx-readout'].every(i => !!el(i)),
             wired: ['btn-fx-cap', 'btn-fx-split2', 'btn-fx-split3', 'btn-fx-fromtube'].every(i => el(i).dataset.nsoWired === '1'),
             ph: ['inp-fx-gap', 'inp-fx-od', 'inp-fx-wall', 'inp-fx-angle', 'inp-fx-trunk', 'inp-fx-branch'].map(i => el(i).placeholder).join('/') };
  });
  check('Fittings is in the Gen+ menu with all its controls, wired at load', ui.menu && ui.inGen && ui.ids && ui.wired, JSON.stringify(ui));
  check('blank fields say what they will do: Fit 0.25, Ø 20, Wall 2, Angle 35, Trunk 25, Branch 30', ui.ph === '0.25/20/2/35/25/30', ui.ph);

  console.log('\n=== 2. Cap: for the selected tube (Ø20, wall 1.6, 40 tall) ===');
  const tubeSoup = stockTube(10, 1.6, 40);
  const tubeId = await loadSTL(page, writeSTL('tube.stl', tubeSoup));
  await selectModel(page, tubeId);
  const tubeBefore = await page.evaluate(id => Array.from(state.models.find(m => m && m.id === id).rawTris).join(','), tubeId);
  await page.click('#btn-fx-cap');
  let st = await waitStatus(page, /Dropped cap 1|Cap refused/);
  console.log('   status: ' + st);
  let P = await pieces(page);
  const cap = P.find(p => p.name === 'cap 1');
  check('a piece "cap 1" is added, and it is the selected one', !!cap && (await selName(page)) === 'cap 1' && P.length === 2, JSON.stringify(P.map(p => p.name)));
  check('the status names the cap\'s numbers: bore Ø20.50, wall 1.60, closed end 1.60, 15 mm in (0.75 × Ø20)', /Dropped cap 1 - Cap for a Ø20\.00 tube: bore Ø20\.50 \(0\.25 mm clear all round\), outside Ø23\.70, wall 1\.60 and closed end 1\.60 mm, 15\.0 mm of tube goes in - 16\.6 mm tall, closed end down, beside tube/.test(st), st);
  check('its size is the cup\'s: Ø23.7 across (x and z), 16.6 tall (y: 15 deep + the 1.6 end)', cap && Math.abs(cap.size.x - 23.7) < 0.02 && Math.abs(cap.size.z - 23.7) < 0.02 && Math.abs(cap.size.y - 16.6) < 0.01, cap && JSON.stringify(cap.size));
  const T = await topoOf(page, cap.id);
  check('closed, 2-manifold, consistently wound, a cup (Euler 2)', T.open === 0 && T.nm === 0 && T.flip === 0 && T.degen === 0 && T.euler === 2, JSON.stringify(T));
  check('the tube is untouched, bit for bit', (await page.evaluate(id => Array.from(state.models.find(m => m && m.id === id).rawTris).join(','), tubeId)) === tubeBefore);
  let rd = await readout(page);
  check('the card\'s readout says the same, not as an error', !rd.bad && /^Cap for a Ø20\.00 tube/.test(rd.text), rd.text);
  await frame(page); await shot(page, 'fittings-cap.png');
  await page.click('#btn-undo');
  await waitStatus(page, /Undo/);
  P = await pieces(page);
  check('one Undo takes the cap off; the tube is all that is left', P.length === 1 && P[0].name === 'tube', JSON.stringify(P.map(p => p.name)));
  // typed Fit and Deep
  await selectModel(page, tubeId);
  await setField(page, 'inp-fx-gap', '0.4'); await setField(page, 'inp-fx-depth', '20');
  await page.click('#btn-fx-cap');
  st = await waitStatus(page, /Dropped cap 1|Cap refused/);
  P = await pieces(page);
  const cap2 = P.find(p => p.name === 'cap 1');
  check('Fit 0.4 and Deep 20: bore Ø20.80, 21.6 tall (the number is handed back after the Undo: "cap 1" again)', /bore Ø20\.80 \(0\.40 mm clear all round\).*20\.0 mm of tube goes in - 21\.6 mm tall/.test(st) && cap2 && Math.abs(cap2.size.y - 21.6) < 0.01, st);
  await page.click('#btn-undo'); await waitStatus(page, /Undo/);
  await setField(page, 'inp-fx-gap', ''); await setField(page, 'inp-fx-depth', '');

  console.log('\n=== 3. Cap refused: nothing selected, a closed piece - and nothing is added ===');
  await page.evaluate(() => { state.editId = null; state.selectedIndex = -1; });
  const nBefore = (await pieces(page)).length;
  await page.evaluate(() => { document.getElementById('btn-fx-cap').click(); });
  st = await waitStatus(page, /Cap: select the tube|Cap refused/);
  rd = await readout(page);
  check('no tube selected: said in words, in red, nothing added', rd.bad && /^Select a tube: the cap is made for its end\.$/.test(rd.text) && (await pieces(page)).length === nBefore, rd.text);
  const boxId = await loadSTL(page, writeSTL('box.stl', NSO_Stock.boxSoup(30, 20, 10)));
  await selectModel(page, boxId);
  await page.click('#btn-fx-cap');
  st = await waitStatus(page, /Cap refused/);
  rd = await readout(page);
  check('a closed box: the reader\'s words, with the cap\'s tail, nothing added', rd.bad && /that end is closed.*A cap fits the open, round end of a tube\.$/.test(rd.text) && /Cap refused - nothing added/.test(st) && (await pieces(page)).length === nBefore + 1, rd.text);

  console.log('\n=== 4. Splitter: 2-way and 3-way, pieces of their own ===');
  await selectModel(page, tubeId);
  const before2 = (await pieces(page)).length;
  await page.click('#btn-fx-split2');
  st = await waitStatus(page, /Dropped splitter 2-way 1|2-way splitter refused/);
  console.log('   status: ' + st);
  P = await pieces(page);
  const s2 = P.find(p => p.name === 'splitter 2-way 1');
  check('a piece "splitter 2-way 1" is added and selected, beside the tube', !!s2 && (await selName(page)) === 'splitter 2-way 1' && P.length === before2 + 1 && /, beside tube\.$/.test(st), st);
  check('the status gives its numbers: Ø20 trunk into 2 × Ø15 at 35°, wall 2', /^Dropped splitter 2-way 1 - 2-way splitter: Ø20\.00 trunk \(bore Ø16\.00\) into 2 × Ø15\.00 branches \(bore Ø11\.00\) at 35°, wall 2\.00 throughout/.test(st), st);
  let T2 = await topoOf(page, s2.id);
  check('closed, 2-manifold, wound, Euler -2 (a Y: a thickened sphere with 3 openings)', T2.open === 0 && T2.nm === 0 && T2.flip === 0 && T2.degen === 0 && T2.euler === -2, JSON.stringify(T2));
  check('its size: 46.7 across the branches (x), Ø20 the other way (z), 53.9 tall (y)', s2 && Math.abs(s2.size.x - 46.7) < 0.2 && Math.abs(s2.size.z - 20) < 0.1 && Math.abs(s2.size.y - 53.9) < 0.2, s2 && JSON.stringify(s2.size));
  await frame(page); await shot(page, 'fittings-split2.png');
  await page.click('#btn-undo'); await waitStatus(page, /Undo/);
  check('one Undo takes it off', (await pieces(page)).length === before2 && !(await pieces(page)).some(p => p.name === 'splitter 2-way 1'));

  // nothing selected: a piece on its own, in the middle of the plate - this is the "single item" case
  await page.evaluate(() => { state.editId = null; state.selectedIndex = -1; });
  await setField(page, 'inp-fx-od', '24'); await setField(page, 'inp-fx-wall', '1.6'); await setField(page, 'inp-fx-bod', '12'); await setField(page, 'inp-fx-angle', '45'); await setField(page, 'inp-fx-branch', '35');
  await page.click('#btn-fx-split3');
  st = await waitStatus(page, /Dropped splitter 3-way 1|3-way splitter refused/);
  console.log('   status: ' + st);
  P = await pieces(page);
  const s3 = P.find(p => p.name === 'splitter 3-way 1');
  check('with nothing selected: "splitter 3-way 1" lands on its own (no "beside")', !!s3 && !/beside/.test(st) && (await selName(page)) === 'splitter 3-way 1', st);
  check('typed Ø24 / wall 1.6 / branch Ø12 / 45° / 35 mm: the status says so', /3-way splitter: Ø24\.00 trunk \(bore Ø20\.80\) into 3 × Ø12\.00 branches \(bore Ø8\.80\) at 45°, wall 1\.60 throughout/.test(st), st);
  const T3 = await topoOf(page, s3.id);
  check('closed, 2-manifold, wound, Euler -4 (a thickened sphere with 4 openings)', T3.open === 0 && T3.nm === 0 && T3.flip === 0 && T3.degen === 0 && T3.euler === -4, JSON.stringify(T3));
  await frame(page); await shot(page, 'fittings-split3.png');
  await page.click('#btn-fx-split3');
  st = await waitStatus(page, /Dropped splitter 3-way 2/);
  check('a second click drops another: "splitter 3-way 2"', (await pieces(page)).some(p => p.name === 'splitter 3-way 2'), st);
  await page.click('#btn-undo'); await waitStatus(page, /Undo/); await page.click('#btn-undo'); await waitStatus(page, /Undo/);
  check('two Undos, and both are gone', !(await pieces(page)).some(p => /^splitter/.test(p.name)));
  for (const id of ['inp-fx-od', 'inp-fx-wall', 'inp-fx-bod', 'inp-fx-angle', 'inp-fx-branch']) await setField(page, id, '');

  console.log('\n=== 5. Ø from tube: the selected tube\'s Ø and wall into the fields ===');
  await selectModel(page, tubeId);
  await page.click('#btn-fx-fromtube');
  await page.waitForFunction(() => document.getElementById('inp-fx-od').value !== '', null, { timeout: 15000 });
  const f = await page.evaluate(() => ({ od: document.getElementById('inp-fx-od').value, wall: document.getElementById('inp-fx-wall').value, ro: document.getElementById('fx-readout').textContent }));
  check('Ø20.00 and wall 1.60 from the Ø20 / 1.6 tube', f.od === '20.00' && f.wall === '1.60', JSON.stringify(f));
  await page.click('#btn-fx-split2');
  st = await waitStatus(page, /Dropped splitter 2-way 1|2-way splitter refused/);
  check('...and the 2-way made from them carries them: Ø20.00 trunk, wall 1.60, branches ¾ of it (Ø15.00, bore Ø11.80)', /Ø20\.00 trunk \(bore Ø16\.80\) into 2 × Ø15\.00 branches \(bore Ø11\.80\).*wall 1\.60 throughout/.test(st), st);
  await page.click('#btn-undo'); await waitStatus(page, /Undo/);
  await setField(page, 'inp-fx-od', ''); await setField(page, 'inp-fx-wall', '');

  console.log('\n=== 6. Splitter refusals, said in the card, nothing added ===');
  const n0 = (await pieces(page)).length;
  await setField(page, 'inp-fx-angle', '5');
  await page.click('#btn-fx-split2');
  await page.waitForFunction(() => document.getElementById('fx-readout').classList.contains('is-bad'), null, { timeout: 15000 });
  rd = await readout(page); st = await statusOf(page);
  check('an angle of 5°: refused in words, in red, status says nothing added', /^2-way: a branch angle of 5\.0° is outside 10° to 80°/.test(rd.text) && /2-way splitter refused - nothing added/.test(st) && (await pieces(page)).length === n0, rd.text);
  await setField(page, 'inp-fx-angle', '12'); await setField(page, 'inp-fx-branch', '20');
  await page.click('#btn-fx-split3');
  await page.waitForFunction(() => /^3-way: the 3 outlets/.test(document.getElementById('fx-readout').textContent), null, { timeout: 15000 });
  rd = await readout(page);
  check('3 outlets that would run together: the number of mm to lengthen the branches to is named', /^3-way: the 3 outlets would run into each other - at 12\.0° and 20\.0 mm long.*Make the branches at least \d+\.\d mm long/.test(rd.text) && rd.bad && (await pieces(page)).length === n0, rd.text);
  await setField(page, 'inp-fx-angle', ''); await setField(page, 'inp-fx-branch', '');

  console.log('\n=== 7. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
