/* End-to-end evidence for Move (Crop, stage 2), driven through the real app.
   node tools/nso_wire_crop_move_test.js        exit 0 = every gate held

   Real index.html, real clicks, the real kernel (the vendored manifold the
   harness serves for the CDN). The geometry proofs live in
   tools/nso_crop_move_test.js; this file proves the Move rows under Crop are
   reachable and wired, that Up / Across narrow the box to a region, that
   Lift draws the region as a ghost and a mouse drag really moves it, and that
   Lock in commits what is MEASURED where it lands - on the acceptance piece,
   library/v9_mirror_factory.stl, the -Y lip next to the +seam moved to the
   +Y side: pushed into the teeth it is trimmed, held at its own height it is
   bridged, and lifted 6 mm clear it is refused with the piece untouched. Both
   the rawTris the app keeps and the STL it exports pass mesh_validate.py, and
   Undo names Move and puts the soup back. */

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-wire-crop-move-'));
function writeSTL(file, soup) {
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}
function validate(file, selfint) {
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'];
  if (!selfint) args.push('--no-selfint');
  return JSON.parse(execFileSync('python3', args, { maxBuffer: 1 << 30 }).toString());
}
const summary = j => j.verdict + ' open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' inc ' +
  j.inconsistent_winding_edges + ' deg ' + j.degenerate_tris + ' chi ' + j.euler_characteristic +
  (j.self_intersection ? ' pierce ' + j.self_intersection.pierce : '');

const rawOf = page => page.evaluate(() => Array.from(getActiveModel().rawTris));
const openCutter = async page => {
  const open = await page.evaluate(() => document.getElementById('menu-cut').open);
  if (!open) await page.click('#menu-cut > summary');
  if (!(await page.evaluate(() => state.cutterOpen))) await page.click('#btn-cutter-open');
};
const fill = async (page, id, v) => { await page.fill('#' + id, String(v)); await page.dispatchEvent('#' + id, 'change'); };
const setMove = async (page, d) => {
  await fill(page, 'crop-move-dx', d[0]); await fill(page, 'crop-move-dy', d[1]); await fill(page, 'crop-move-dz', d[2]);
};
const lockIn = async page => {
  await page.click('#btn-crop-lockin');
  await page.waitForFunction(() => /Move (done|refused|stood down|failed)/.test(document.getElementById('status').textContent),
    null, { timeout: 120000 });
  return statusOf(page);
};

withApp(async (page, logs) => {
  console.log('\n=== 1. the Move rows sit under Crop in the Cut menu, wired ===');
  const ui = await page.evaluate(() => {
    const b = document.getElementById('btn-crop-lockin');
    const ids = ['crop-up-from', 'crop-up-to', 'crop-across-from', 'crop-across-to', 'crop-move-dx', 'crop-move-dy', 'crop-move-dz'];
    return { btn: !!b, inMenu: !!(b && b.closest('#menu-cut')), wired: !!b && b.dataset.nsoWired === '1',
             numeric: ids.every(i => (document.getElementById(i) || {}).type === 'number'),
             lift: (document.getElementById('chk-crop-lift') || {}).type === 'checkbox', disabled: !!(b && b.disabled) };
  });
  check('#btn-crop-lockin present, inside the Cut menu, listener attached', ui.btn && ui.inMenu && ui.wired);
  check('Up / Across / ΔX ΔY ΔZ numeric, Lift tick present', ui.numeric && ui.lift);
  check('Lock in disabled before anything is lifted', ui.disabled);

  console.log('\n=== 2. v9_mirror_factory.stl: box the -Y lip next to the +seam ===');
  const id = await loadSTL(page, path.join(ROOT, 'library', 'v9_mirror_factory.stl'));
  await openCutter(page);
  await selectModel(page, id);
  await page.evaluate(() => { showEditPreview(); updateCutterUI(); });
  // Along X, from the piece's low end (raw X -93.493): 167.5 .. 179.5 is raw
  // X 74.0 .. 86.0, ending 1.5 mm short of the +seam ring at 87.537.
  await fill(page, 'crop-start-mm', 167.5);
  await fill(page, 'crop-end-mm', 179.5);
  // Up from the bottom (raw Z -10.469): 15.5 and above is raw Z 5.0 and above,
  // under the lip (Z 7.53 .. 10.47). Across (display Z, raw -Y) from the low
  // side (raw Y 17.010): 20.0 and beyond is raw Y -2.99 and below - the lip,
  // clear of its fillet into the body at Y -2.
  await fill(page, 'crop-up-from', 15.5); await fill(page, 'crop-up-to', 30);
  await fill(page, 'crop-across-from', 20); await fill(page, 'crop-across-to', 40);
  const box = await page.evaluate(() => {
    const m = getActiveModel(), cur = NSO_cropCurrentRegion(m);
    return cur.box;
  });
  console.log('   raw box ' + JSON.stringify(box));
  check('raw box: X 74..86, Y up to -3, Z from 5 - the lip span, nothing of the body',
    Math.abs(box.min[0] - 74) < 0.01 && Math.abs(box.max[0] - 86) < 0.01 && Math.abs(box.max[1] + 2.99) < 0.02 &&
    Math.abs(box.min[2] - 5.03) < 0.02, JSON.stringify(box));

  console.log('\n=== 3. Lift: the region is drawn as a ghost, and a mouse drag moves it ===');
  await page.check('#chk-crop-lift');
  const lifted = await page.evaluate(() => ({
    ghost: !!state.cropGhost && state.cropGhost.parent === state.scene,
    readout: document.getElementById('crop-move-readout').textContent,
    disabled: document.getElementById('btn-crop-lockin').disabled }));
  console.log('   readout: ' + lifted.readout);
  check('ghost drawn in the scene', lifted.ghost);
  check('readout names the region: ~488 mm3', /Region 48[89]\.\d mm³/.test(lifted.readout), lifted.readout);
  check('Lock in still disabled until it has moved', lifted.disabled);
  // Turn the view so the drag is unambiguous: camera looking straight down.
  const pts = await page.evaluate(() => {
    const g = state.cropGhost;
    g.geometry.computeBoundingBox();
    const c = g.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(g.matrixWorld);
    const r = state.renderer.domElement.getBoundingClientRect();
    const proj = v => { v.project(state.camera); return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height }; };
    const n = new THREE.Vector3(); state.camera.getWorldDirection(n);
    // 10 mm along the view plane's horizontal
    const side = new THREE.Vector3().crossVectors(n, state.camera.up).normalize().multiplyScalar(10);
    const a = proj(c.clone()), b = proj(c.clone().add(side));
    const el = document.elementFromPoint(a.x, a.y);
    return { a, b, onCanvas: el === state.renderer.domElement };
  });
  check('the ghost is on the canvas, clear of the menus', pts.onCanvas);
  await page.mouse.move(pts.a.x, pts.a.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(pts.a.x + (pts.b.x - pts.a.x) * i / 10, pts.a.y + (pts.b.y - pts.a.y) * i / 10);
  await page.mouse.up();
  const dragged = await page.evaluate(() => ({ move: state.crop.move.slice(), orbit: state.controls.enabled,
    fields: ['crop-move-dx', 'crop-move-dy', 'crop-move-dz'].map(i => +document.getElementById(i).value),
    disabled: document.getElementById('btn-crop-lockin').disabled }));
  const len = Math.hypot(...dragged.move);
  check('dragging the ghost moved it ~10 mm in the view plane', Math.abs(len - 10) < 1, JSON.stringify(dragged.move));
  check('the fields follow the drag, orbit handed back, Lock in enabled',
    dragged.fields.every((v, i) => Math.abs(v - dragged.move[i]) < 0.006) && dragged.orbit && !dragged.disabled,
    JSON.stringify(dragged));

  console.log('\n=== 4. Lock in, pushed into the teeth: trimmed ===');
  const before = await rawOf(page);
  // Raw offset [0, 31, -2]: +31 in raw Y is -31 in display Z; -2 in raw Z is -2 up.
  await setMove(page, [0, -2, -31]);
  let st = await lockIn(page);
  console.log('   status: ' + st);
  check('status: done, overlap trimmed', /Move done - landed \d+\.\d+ mm³ into the piece, overlap trimmed/.test(st), st);
  let after = await rawOf(page);
  let v = validate(writeSTL(path.join(TMP, 'trim.stl'), after), true);
  check('rawTris PASS mesh_validate.py, self-intersection included', v.verdict === 'PASS', summary(v));
  const stl = await page.evaluate(() => Array.from(new Uint8Array(activeModelSTL().buffer)));
  fs.writeFileSync(path.join(TMP, 'export.stl'), Buffer.from(stl));
  const ev = validate(path.join(TMP, 'export.stl'));
  check('exported STL PASS mesh_validate.py', ev.verdict === 'PASS', summary(ev));
  // Across 20.0 from the low side (raw Y 17.0103) is raw Y -2.9897, so the
  // lip's cut face, moved +31, now sits at Y 28.0103.
  check('the lip now reaches Y +28.01 on the +Y side (bbox grew from 34.02 to 45.02 across)',
    Math.abs(v.bbox_max[1] - 28.0103) < 1e-3 && Math.abs(v.bbox_size[1] - 45.0205) < 1e-3, v.bbox_size.join(' x '));
  const ghostGone = await page.evaluate(() => !state.cropGhost && !state.crop.lift);
  check('ghost cleared and Lift reset after the commit', ghostGone);

  console.log('\n=== 5. Undo names Move and puts the soup back ===');
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo/.test(document.getElementById('status').textContent), null, { timeout: 15000 });
  check('undo names Move', /Undo: Move reverted/.test(await statusOf(page)), await statusOf(page));
  check('the whole soup is back, coordinate for coordinate', JSON.stringify(await rawOf(page)) === JSON.stringify(before));

  console.log('\n=== 6. Lock in at the lip\'s own height: clear of the teeth, bridged ===');
  await page.evaluate(() => { showEditPreview(); updateCutterUI(); });
  await fill(page, 'crop-start-mm', 167.5); await fill(page, 'crop-end-mm', 179.5);
  await fill(page, 'crop-up-from', 15.5); await fill(page, 'crop-up-to', 30);
  await fill(page, 'crop-across-from', 20); await fill(page, 'crop-across-to', 40);
  await page.check('#chk-crop-lift');
  await setMove(page, [0, 0, -31]);
  if (process.env.NSO_SHOT) await page.screenshot({ path: process.env.NSO_SHOT.replace(/\.png$/, '-ghost.png') });
  st = await lockIn(page);
  console.log('   status: ' + st);
  check('status: done, gap bridged', /Move done - landed 0\.\d+ mm clear, gap bridged \(\+\d+\.\d+ mm³\)/.test(st), st);
  after = await rawOf(page);
  v = validate(writeSTL(path.join(TMP, 'bridge.stl'), after), true);
  check('rawTris PASS mesh_validate.py, self-intersection included', v.verdict === 'PASS', summary(v));
  if (process.env.NSO_SHOT) await page.screenshot({ path: process.env.NSO_SHOT });
  await page.click('#btn-undo');
  await page.waitForFunction(() => /Undo: Move reverted/.test(document.getElementById('status').textContent), null, { timeout: 15000 });

  console.log('\n=== 7. too extreme: lifted 6 mm above the teeth - refused, piece untouched ===');
  await page.evaluate(() => { showEditPreview(); updateCutterUI(); });
  await fill(page, 'crop-start-mm', 167.5); await fill(page, 'crop-end-mm', 179.5);
  await fill(page, 'crop-up-from', 15.5); await fill(page, 'crop-up-to', 30);
  await fill(page, 'crop-across-from', 20); await fill(page, 'crop-across-to', 40);
  await page.check('#chk-crop-lift');
  await setMove(page, [0, 6, -31]);
  st = await lockIn(page);
  check('refused, naming the gap and the reach', /Move refused - piece unchanged \(the move leaves a gap of 6\.\d+ mm.*3 mm at most\)/.test(st), st);
  check('piece unchanged', JSON.stringify(await rawOf(page)) === JSON.stringify(before));

  console.log('\n=== 8. paint wins: a painted piece is a stand-down ===');
  await page.evaluate(() => { getActiveModel().faceMask = { exclude: [{ n: [0, 0, 1], d: 0, axisIdx: 2, keepMin: false, inner: false }] }; });
  await setMove(page, [0, -2, -31]);
  st = await lockIn(page);
  check('stood down, naming the paint', /Move stood down - 1 painted face/.test(st), st);
  check('piece unchanged', JSON.stringify(await rawOf(page)) === JSON.stringify(before));
  await page.evaluate(() => { getActiveModel().faceMask = null; });

  console.log('\n=== 9. Stage 1 is untouched: with Lift off, Crop still crops the full slab ===');
  await page.uncheck('#chk-crop-lift');
  const noGhost = await page.evaluate(() => !state.cropGhost);
  check('Lift off clears the ghost', noGhost);
  await fill(page, 'crop-up-from', ''); await fill(page, 'crop-up-to', '');
  await fill(page, 'crop-across-from', ''); await fill(page, 'crop-across-to', '');
  // Raw X -18.7 .. 18.7, a span crop:test already holds Stage 1 to on v9.
  await fill(page, 'crop-start-mm', 74.8); await fill(page, 'crop-end-mm', 112.2);
  await page.click('#btn-crop');
  await page.waitForFunction(() => /Crop (done|refused)/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  st = await statusOf(page);
  check('Crop done on the full slab', /Crop done/.test(st), st);
  const cropped = validate(writeSTL(path.join(TMP, 'crop.stl'), await rawOf(page)));
  check('and the cropped piece PASSES mesh_validate.py', cropped.verdict === 'PASS', summary(cropped));

  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
