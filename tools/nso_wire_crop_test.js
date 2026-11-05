/* End-to-end evidence for Crop, driven through the real app.
   node tools/nso_wire_crop_test.js        exit 0 = every gate held

   Real index.html, real clicks. The geometry proofs live in
   tools/nso_crop_engine_test.js (the copy engine) and tools/nso_crop_test.js
   (the slab crop G-scope and Detach still use); the card is driven in
   tools/nso_crop_card_drive.js. This file proves the copy is a real piece on
   the plate: the Crop card is reachable, a Box dragged with the mouse and
   CROP add a piece that passes tools/mesh_validate.py - both the rawTris the
   app keeps and the STL it exports - one Undo takes it off, paint on the
   original is neither read nor touched, a refusal leaves the plate alone,
   and Split still cuts the copy cleanly. */

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

const rawOf = (page, id) => page.evaluate(i => Array.from(state.models.find(m => m.id === i).rawTris), id);
const cropNames = page => page.evaluate(() => state.models.map(m => m.name));
const settle = page => page.waitForFunction(() => { const S = NSO_CropCard.state(); return !S.shape || (!S.timer && S.plan); }, null, { timeout: 30000 });

withApp(async (page, logs) => {
  console.log('\n=== 1. the Crop card is in the column and wired ===');
  const ui = await page.evaluate(() => {
    const b = document.getElementById('btn-crop');
    const inMenu = !!(b && b.closest('#menu-crop'));
    return { btn: !!b, wired: !!b && b.dataset.nsoWired === '1', inMenu,
             row: ['box', 'cylinder', 'sphere', 'piece', 'outline'].every(k => !!document.getElementById('btn-crop-shape-' + k)),
             old: ['crop-start-mm', 'chk-crop-box', 'btn-crop-axis-x', 'btn-crop-lockin'].filter(i => document.getElementById(i)) };
  });
  check('#btn-crop present, inside the Crop card', ui.btn && ui.inMenu);
  check('listener attached at load', ui.wired);
  check('the Shape row is there, and the old from / to fields, Box tick, axis and Lock in are not', ui.row && ui.old.length === 0, ui.old.join(','));

  console.log('\n=== 2. select the simple test piece (60 x 12 x 8); Box stands on it at half size ===');
  const id = await loadSTL(page, writeSTL(path.join(TMP, 'bar60.stl'), bar(60, 12, 8)));
  await selectModel(page, id);
  await page.click('#menu-crop > summary');
  await page.evaluate(i => selectPlaced(state.placed.findIndex(p => p.sourceId === i)), id);
  await page.evaluate(() => {      // an oblique view, close, so the handles are a hand's width apart
    state.camera.position.set(40, 36, 52); state.controls.target.set(0, 4, 0); state.camera.lookAt(0, 4, 0); state.controls.update();
    state.renderer.render(state.scene, state.camera);
  });
  await page.click('#btn-crop-shape-box');
  await settle(page);
  const ro = await page.evaluate(() => document.getElementById('crop-readout').textContent);
  console.log('   readout: ' + ro);
  check('readout: Box 30 x 6 x 4 mm, holds the 12 faces of a box, 0.72 cm3', /^Box 30 × 6 × 4 mm · holds 12 faces, 0\.72 cm³$/.test(ro), ro);
  check('CROP is on with a shape up', !(await page.evaluate(() => document.getElementById('btn-crop').disabled)));

  console.log('\n=== 3. a real mouse drag on a face of the box ===');
  const hp = await page.evaluate(() => NSO_CropCard.handleScreen('x+'));
  const x0 = await page.evaluate(() => NSO_CropCard.state().box.h[0]);
  await page.mouse.move(hp.x, hp.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(hp.x + 6 * i, hp.y + i);
  await page.mouse.up();
  await settle(page);
  const x1 = await page.evaluate(() => ({ h: NSO_CropCard.state().box.h[0], orbit: state.controls.enabled, same: state.editId }));
  check('dragging the +x face grew the box on that side', x1.h > x0 + 0.3, x0.toFixed(2) + ' -> ' + x1.h.toFixed(2));
  check('orbit handed back after the drag, same piece selected', x1.orbit === true && x1.same === id);
  await page.click('#btn-crop-shape-box');     // a fresh one, 30 x 6 x 4
  await settle(page);

  console.log('\n=== 4. CROP: a new, closed piece beside nothing - in place, the original untouched ===');
  const before = await rawOf(page, id);
  await page.click('#btn-crop');
  await page.waitForFunction(() => state.models.length === 2, null, { timeout: 30000 });
  const st = await statusOf(page);
  console.log('   status: ' + st);
  check('status reports the copy, by name', /^Crop: "bar60 crop 1" - copied 720\.0 mm³ in 12 faces, 30\.0 x 6\.0 x 4\.0 mm/.test(st), st);
  const cid = await page.evaluate(() => state.models[1].id);
  const after = await rawOf(page, cid);
  const rawV = validate(writeSTL(path.join(TMP, 'raw.stl'), after));
  check('rawTris PASS mesh_validate.py (self-intersection included)', rawV.verdict === 'PASS', summary(rawV));
  check('rawTris: one shell, 30 x 6 x 4, volume 720',
    rawV.euler_characteristic === 2 && rawV.bbox_size.join() === '30,6,4' && Math.abs(rawV.signed_volume - 720) < 1e-3,
    rawV.bbox_size.join(' x ') + ', ' + rawV.signed_volume);
  const stl = await page.evaluate(() => Array.from(new Uint8Array(activeModelSTL().buffer)));
  const stlFile = path.join(TMP, 'export.stl');
  fs.writeFileSync(stlFile, Buffer.from(stl));
  const expV = validate(stlFile);
  check('exported STL (the selected copy) PASS mesh_validate.py', expV.verdict === 'PASS', summary(expV));
  const wt = execFileSync('python3', [path.join(ROOT, 'tools', 'stl_watertight_check.py'), stlFile]).toString();
  check('exported STL watertight by stl_watertight_check.py',
    /open_edges\(count=1\) 0/.test(wt) && /nonmanifold_edges\(count>2\) 0/.test(wt) && /\nOK\s*$/.test(wt),
    wt.trim().split('\n').join(', '));
  check('the original is byte for byte what it was', JSON.stringify(await rawOf(page, id)) === JSON.stringify(before));
  const shown = await page.evaluate(i => ({ x: state.models.find(m => m.id === i).size.x, sel: state.models.find(m => m.id === state.placed[state.selectedIndex].sourceId).name }), cid);
  check('the app draws a 30 mm piece, and it is the selected one', Math.abs(shown.x - 30) < 1e-4 && shown.sel === 'bar60 crop 1', JSON.stringify(shown));

  console.log('\n=== 5. one Undo takes the copy off ===');
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('undo names what it removed', /Undo: removed cloned pieces/.test(await statusOf(page)), await statusOf(page));
  check('one model again, the plate still has the original, the soup is back coordinate for coordinate',
    (await cropNames(page)).length === 1 && (await page.evaluate(() => state.placed.length)) === 1 && JSON.stringify(await rawOf(page, id)) === JSON.stringify(before));
  check('the shape is still up for another crop', (await page.evaluate(() => NSO_CropCard.state().shape)) === 'box');

  console.log('\n=== 6. paint is not read and not touched: a copy writes nothing to the original ===');
  const mask = { exclude: [{ n: [0, 0, 1], d: 0, axisIdx: 2, keepMin: false, inner: false }] };
  await page.evaluate(([i, m]) => { state.models.find(x => x.id === i).faceMask = m; }, [id, mask]);
  await page.click('#btn-crop-shape-box');
  await settle(page);
  await page.click('#btn-crop');
  await page.waitForFunction(() => state.models.length === 2, null, { timeout: 30000 });
  check('CROP goes ahead on a painted piece', /^Crop: "bar60 crop 1"/.test(await statusOf(page)), await statusOf(page));
  check('...the original\'s paint is exactly as it was, and the copy carries none',
    await page.evaluate(([i, m]) => JSON.stringify(state.models.find(x => x.id === i).faceMask) === JSON.stringify(m) && !state.models[1].faceMask, [id, mask]));
  await page.click('#btn-undo');
  await page.evaluate(i => { state.models.find(x => x.id === i).faceMask = null; }, id);

  console.log('\n=== 7. a shape that holds nothing is refused in words, the plate untouched ===');
  const hid = await loadSTL(page, path.join(ROOT, 'library', 'hinge_knuckle_box.stl'));
  await selectModel(page, id);
  await page.evaluate(i => selectPlaced(state.placed.findIndex(p => p.sourceId === i)), id);
  await page.evaluate(() => { state.camera.position.set(70, 60, 90); state.controls.target.set(20, 4, 0); state.camera.lookAt(20, 4, 0); state.controls.update(); state.renderer.render(state.scene, state.camera); });
  await page.click('#btn-crop-shape-piece');
  const hxy = await page.evaluate(hh => {
    const p = state.placed.find(q => q.sourceId === hh), r = state.renderer.domElement.getBoundingClientRect();
    const c = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3()).project(state.camera);
    return { x: r.left + (c.x + 1) / 2 * r.width, y: r.top + (1 - c.y) / 2 * r.height };
  }, hid);
  await page.mouse.click(hxy.x, hxy.y);
  await page.waitForFunction(() => { const S = NSO_CropCard.state(); return S.piece.id != null && S.plan && !S.timer; }, null, { timeout: 30000 });
  const refusal = await page.evaluate(() => ({ ro: document.getElementById('crop-readout').textContent, off: document.getElementById('btn-crop').disabled }));
  check('the hinge, standing apart from the bar, is a cutter that holds nothing of it - said in words, CROP off',
    /holds nothing of this piece/.test(refusal.ro) && refusal.off, refusal.ro);
  const pre = await page.evaluate(() => ({ m: state.models.length, p: state.placed.length, u: state.undoStack.length }));
  const forced = await page.evaluate(async () => {
    const m = state.models.find(q => q.id === NSO_CropCard.state().forId);
    const r = await NSO_Crop.copy(m, NSO_CropCard.shape());
    return { r: { ok: r.ok, reason: r.reason }, s: document.getElementById('status').textContent };
  });
  const post = await page.evaluate(() => ({ m: state.models.length, p: state.placed.length, u: state.undoStack.length }));
  check('asked anyway, the engine refuses, the status says so, and nothing was added', !forced.r.ok && /^Crop refused - nothing changed \(.*holds nothing/.test(forced.s) &&
    JSON.stringify(pre) === JSON.stringify(post), forced.s);

  console.log('\n=== 8. Split still cuts a copy cleanly ===');
  await page.click('#btn-crop-cancel');
  await page.click('#btn-crop-shape-box');
  await settle(page);
  await page.click('#btn-crop');
  await page.waitForFunction(() => state.models.length === 3, null, { timeout: 30000 });
  const halves = await page.evaluate(() => {
    const cid2 = state.models[state.models.length - 1].id;
    openCutter('cut');      // Cut is its own card: arm it for the split
    state.editId = cid2;
    updateCutHelper();
    cutActiveModel();
    return state.models.filter(m => /-[AB]\d+$/.test(m.name)).map(m => Array.from(m.rawTris));
  });
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
