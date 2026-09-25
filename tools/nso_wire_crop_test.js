/* End-to-end evidence for Crop, driven through the real app.
   node tools/nso_wire_crop_test.js        exit 0 = every gate held

   Real index.html, real clicks. The geometry proofs live in
   tools/nso_crop_test.js; this file proves the Crop row in the Cut menu is
   reachable, the box is drawn and really moves under a mouse drag, the
   button commits a piece that passes tools/mesh_validate.py - both the
   rawTris the app keeps and the STL it exports - undo names Crop and puts
   the soup back, paint stands it down, a refusal leaves the piece alone, a
   step face with a hole (hinge bore) is capped,
   and Split still cuts the cropped piece cleanly. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, statusOf, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-wire-crop-'));
function writeSTL(file, soup) {
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}
function validate(file) {
  return JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json']).toString());
}
const summary = j => j.verdict + ' open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' inc ' +
  j.inconsistent_winding_edges + ' deg ' + j.degenerate_tris + ' chi ' + j.euler_characteristic +
  ' pierce ' + j.self_intersection.pierce;

// The simple test piece: a 60 x 12 x 8 bar, Z up, every face one quad.
function bar(L, W, H) {
  const out = [];
  const q = (a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  q([0, 0, 0], [0, W, 0], [L, W, 0], [L, 0, 0]);
  q([0, 0, H], [L, 0, H], [L, W, H], [0, W, H]);
  q([0, 0, 0], [L, 0, 0], [L, 0, H], [0, 0, H]);
  q([0, W, 0], [0, W, H], [L, W, H], [L, W, 0]);
  q([0, 0, 0], [0, 0, H], [0, W, H], [0, W, 0]);
  q([L, 0, 0], [L, W, 0], [L, W, H], [L, 0, H]);
  return out;
}

const rawOf = page => page.evaluate(() => Array.from(getActiveModel().rawTris));
const openCutter = async page => {
  const open = await page.evaluate(() => document.getElementById('menu-cut').open);
  if (!open) await page.click('#menu-cut > summary');
  if (!(await page.evaluate(() => state.cutterOpen))) await page.click('#btn-cutter-open');
};
const setBox = async (page, a, b) => {
  await page.fill('#crop-start-mm', String(a));
  await page.dispatchEvent('#crop-start-mm', 'change');
  await page.fill('#crop-end-mm', String(b));
  await page.dispatchEvent('#crop-end-mm', 'change');
};

withApp(async (page, logs) => {
  console.log('\n=== 1. the Crop row is in the Cut menu and wired ===');
  const ui = await page.evaluate(() => {
    const b = document.getElementById('btn-crop');
    const inMenu = !!(b && b.closest('#menu-cut'));
    return { btn: !!b, wired: !!b && b.dataset.nsoWired === '1', inMenu,
             inputs: ['crop-start-mm', 'crop-end-mm'].every(i => (document.getElementById(i) || {}).type === 'number'),
             box: (document.getElementById('chk-crop-box') || {}).type === 'checkbox' };
  });
  check('#btn-crop present, inside the Cut menu', ui.btn && ui.inMenu);
  check('listener attached at load', ui.wired);
  check('from / to boxes numeric, Box tick present', ui.inputs && ui.box);

  console.log('\n=== 2. select the simple test piece; the box defaults to the middle fifth ===');
  const id = await loadSTL(page, writeSTL(path.join(TMP, 'bar60.stl'), bar(60, 12, 8)));
  await openCutter(page);
  await selectModel(page, id);
  await page.evaluate(() => { showEditPreview(); updateCutterUI(); });
  const def = await page.evaluate(() => ({
    s: document.getElementById('crop-start-mm').value, e: document.getElementById('crop-end-mm').value,
    readout: document.getElementById('crop-readout').textContent,
    disabled: document.getElementById('btn-crop').disabled }));
  check('defaults 24.0 -> 36.0 mm', def.s === '24.0' && def.e === '36.0', def.s + ' -> ' + def.e);
  check('Crop enabled with the cutter open on a piece', !def.disabled);
  await setBox(page, 25, 35);
  const ro = await page.evaluate(() => document.getElementById('crop-readout').textContent);
  console.log('   readout: ' + ro);
  check('readout: 25.0 -> 35.0, 10 mm out, 60 -> 50', /25\.0 → 35\.0 mm \(10\.0 mm out\) → piece 60\.0 → 50\.0 mm/.test(ro), ro);
  check('readout: the box selects the 8 long wall faces', /0 face\(s\) removed, 8 clipped/.test(ro), ro);

  console.log('\n=== 3. the box is drawn and a mouse drag moves it ===');
  await page.check('#chk-crop-box');
  const drawn = await page.evaluate(() => !!state.cropHelper && state.cropHelper.parent === state.scene);
  check('box drawn in the scene', drawn);
  const pts = await page.evaluate(() => {
    const h = state.cropHelper;
    const r = state.renderer.domElement.getBoundingClientRect();
    const proj = v => { v.project(state.camera); return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height }; };
    // The middle of the box's top face: the surface a user sees and grabs.
    h.updateMatrixWorld(true);
    const c = new THREE.Vector3(0, 5, 0).applyMatrix4(h.matrixWorld);
    const a = proj(c.clone()), b = proj(c.clone().add(new THREE.Vector3(5, 0, 0)));
    const el = document.elementFromPoint(a.x, a.y);
    return { a, b, onCanvas: el === state.renderer.domElement };
  });
  check('the box centre is on the canvas, clear of the menus', pts.onCanvas);
  await page.mouse.move(pts.a.x, pts.a.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(pts.a.x + (pts.b.x - pts.a.x) * i / 8, pts.a.y + (pts.b.y - pts.a.y) * i / 8);
  await page.mouse.up();
  const moved = await page.evaluate(() => ({ s: state.crop.startMm, e: state.crop.endMm, orbit: state.controls.enabled,
    same: state.editId }));
  check('dragging the body slid the box ~5 mm along X', Math.abs(moved.s - 30) <= 0.3, moved.s + ' -> ' + moved.e);
  check('and kept its length', Math.abs((moved.e - moved.s) - 10) < 1e-9);
  check('orbit handed back after the drag, same piece selected', moved.orbit === true && moved.same === id);

  // Now grab the high end face and pull it 3 mm further out.
  const endPts = await page.evaluate(() => {
    const h = state.cropHelper;
    h.updateMatrixWorld(true);
    const r = state.renderer.domElement.getBoundingClientRect();
    const proj = v => { v.project(state.camera); return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height }; };
    const len = state.crop.endMm - state.crop.startMm;
    // The top of the end slab, where a user would grab it.
    const top = new THREE.Vector3(len / 2 - 0.3, 5, 0).applyMatrix4(h.matrixWorld);
    return { a: proj(top.clone()), b: proj(top.clone().add(new THREE.Vector3(3, 0, 0))) };
  });
  await page.mouse.move(endPts.a.x, endPts.a.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(endPts.a.x + (endPts.b.x - endPts.a.x) * i / 8, endPts.a.y + (endPts.b.y - endPts.a.y) * i / 8);
  await page.mouse.up();
  const grown = await page.evaluate(() => ({ s: state.crop.startMm, e: state.crop.endMm }));
  check('dragging the end face moved only that end, ~3 mm', grown.s === moved.s && Math.abs(grown.e - (moved.e + 3)) <= 0.5,
    moved.s + '..' + moved.e + ' -> ' + grown.s + '..' + grown.e);
  await setBox(page, 25, 35);

  console.log('\n=== 4. Crop: one closed piece, 10 mm shorter ===');
  const before = await rawOf(page);
  await page.click('#btn-crop');
  await page.waitForFunction(() => /Crop (done|refused)/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const st = await statusOf(page);
  console.log('   status: ' + st);
  check('status reports a completed crop', /Crop done/.test(st) && /60\.00 → 50\.00 mm/.test(st), st);
  const after = await rawOf(page);
  const rawV = validate(writeSTL(path.join(TMP, 'raw.stl'), after));
  check('rawTris PASS mesh_validate.py (self-intersection included)', rawV.verdict === 'PASS', summary(rawV));
  check('rawTris: one shell, X 50 x Y 12 x Z 8, volume 4800',
    rawV.euler_characteristic === 2 && rawV.bbox_size.join() === '50,12,8' && Math.abs(rawV.signed_volume - 4800) < 1e-3,
    rawV.bbox_size.join(' x ') + ', ' + rawV.signed_volume);
  const stl = await page.evaluate(() => Array.from(new Uint8Array(activeModelSTL().buffer)));
  const stlFile = path.join(TMP, 'export.stl');
  fs.writeFileSync(stlFile, Buffer.from(stl));
  const expV = validate(stlFile);
  check('exported STL PASS mesh_validate.py', expV.verdict === 'PASS', summary(expV));
  const wt = execFileSync('python3', [path.join(ROOT, 'tools', 'stl_watertight_check.py'), stlFile]).toString();
  check('exported STL watertight by stl_watertight_check.py',
    /open_edges\(count=1\) 0/.test(wt) && /nonmanifold_edges\(count>2\) 0/.test(wt) && /\nOK\s*$/.test(wt),
    wt.trim().split('\n').join(', '));
  const shown = await page.evaluate(() => ({ x: getActiveModel().size.x, list: state.models.length }));
  check('the app now draws a 50 mm piece, still one model', Math.abs(shown.x - 50) < 1e-4 && shown.list === 1, JSON.stringify(shown));

  console.log('\n=== 5. Undo names Crop and puts the soup back ===');
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('undo names Crop', /Undo: Crop reverted/.test(await statusOf(page)), await statusOf(page));
  check('the whole soup is back, coordinate for coordinate', JSON.stringify(await rawOf(page)) === JSON.stringify(before));

  console.log('\n=== 6. paint wins: a painted piece is a stand-down ===');
  await page.evaluate(() => { getActiveModel().faceMask = { exclude: [{ n: [0, 0, 1], d: 0, axisIdx: 2, keepMin: false, inner: false }] }; });
  await page.click('#btn-crop');
  check('stood down, naming the paint', /Crop stood down - 1 painted face/.test(await statusOf(page)), await statusOf(page));
  check('piece unchanged', JSON.stringify(await rawOf(page)) === JSON.stringify(before));
  await page.evaluate(() => { getActiveModel().faceMask = null; });

  console.log('\n=== 7. a refusal leaves the piece alone (box_closed: two overlapping shells at the joint) ===');
  const bid = await loadSTL(page, path.join(ROOT, 'library', 'box_closed.stl'));
  await selectModel(page, bid);
  await page.evaluate(() => { showEditPreview(); updateCutterUI(); });
  const bBefore = await rawOf(page);
  await setBox(page, 24, 36);
  await page.click('#btn-crop');
  await page.waitForFunction(() => /Crop (done|refused)/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const bs = await statusOf(page);
  check('refused, naming the overlap', /Crop refused/.test(bs) && /overlap/.test(bs), bs);
  check('piece unchanged', JSON.stringify(await rawOf(page)) === JSON.stringify(bBefore));

  console.log('\n=== 7b. a step face with a hole (hinge bore) is capped ===');
  const hid = await loadSTL(page, path.join(ROOT, 'library', 'hinge_knuckle_box.stl'));
  await selectModel(page, hid);
  await page.evaluate(() => { showEditPreview(); updateCutterUI(); });
  const hBefore = await rawOf(page);
  await setBox(page, 5.4, 9.9);
  await page.click('#btn-crop');
  await page.waitForFunction(() => /Crop (done|refused)/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  const hs = await statusOf(page);
  check('hinge 5.4..9.9 cropped, the hole named in the status', /Crop done/.test(hs) && /1 of them a hole/.test(hs), hs);
  const hv = validate(writeSTL(path.join(TMP, 'hinge-hole.stl'), await rawOf(page)));
  check('rawTris PASS mesh_validate.py (self-intersection included)', hv.verdict === 'PASS', summary(hv));
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('undo puts the hinge back', JSON.stringify(await rawOf(page)) === JSON.stringify(hBefore));

  console.log('\n=== 8. Split still cuts a cropped piece cleanly ===');
  await setBox(page, 7.2, 10.8);
  await page.click('#btn-crop');
  await page.waitForFunction(() => /Crop (done|refused)/.test(document.getElementById('status').textContent), null, { timeout: 30000 });
  check('hinge 7.2..10.8 cropped', /Crop done/.test(await statusOf(page)), await statusOf(page));
  const halves = await page.evaluate(id => {
    state.editId = id;
    updateCutHelper();
    cutActiveModel();
    return state.models.filter(m => /-[AB]\d+$/.test(m.name)).map(m => Array.from(m.rawTris));
  }, hid);
  check('Split made two raw halves', halves.length === 2);
  halves.forEach((h, i) => {
    const v = validate(writeSTL(path.join(TMP, 'half' + i + '.stl'), h));
    check('half ' + 'AB'[i] + ' PASS', v.verdict === 'PASS', summary(v));
  });

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
