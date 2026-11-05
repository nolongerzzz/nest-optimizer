/* Delete painted, driven through the real app in real Chromium.
     node tools/nso_paint_delete_drive_check.js     exit 0 = every gate held

   The module's own numbers are proved without a browser in
   tools/nso_paint_delete_test.js. This file proves the other half - that the
   thing a USER can reach does what that module does, on the same piece:

     1. the Delete row exists, is wired, and refuses politely with no target
     2. Paint Selected + a real click on a real face records the target, and
        the triangles the delete removes are EXACTLY the triangles the pink
        covers. That is the whole WYSIWYG contract for a destructive tool,
        and it is asserted against the app's own overlay, not against a
        recomputed set
     3. the piece really loses that geometry, and Undo puts the geometry AND
        the target back in one step
     4. paint wins: a target that is also painted excluded stands the delete
        down and the piece is byte-for-byte unchanged
     5. Face+seal closes the rim again, and the piece that comes out of the
        app's own STL export passes the canonical checker
     6. a refusal in the app leaves the piece byte-for-byte unchanged
     7. nothing else on the page broke */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, openFinishMenu, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-delete-drive-'));
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const waitStatus = (page, re) => page.waitForFunction(
  src => new RegExp(src).test(document.getElementById('status').textContent),
  re.source, { timeout: 60000 });
const clearStatus = page => page.evaluate(() => { document.getElementById('status').textContent = ''; });

/* Everything about the piece the assertions below need, read the way the app
   itself reads it. `pink` is the triangle count of the SELECT overlay - the
   app's own answer to "what did I highlight", taken off the mesh in the
   scene, so comparing the delete against it compares against what was on
   screen and not against a second derivation of it. */
const pieceState = function (id) {
  const m = state.models.find(x => x.id === id);
  const raw = m.rawTris;
  let sum = 0;
  for (let i = 0; i < raw.length; i++) sum = (sum * 31 + Math.round(raw[i] * 1e6)) | 0;
  const overlays = state.modelGroup.children.filter(o => o.isMesh && o.material && o.material.color &&
    (o.material.color.getHex() === 0xf472b6 || o.material.color.getHex() === 0xffdd00));
  const col = o => o.material.color.getHex();
  const sel = (typeof nsoMaskSelected === 'function') ? nsoMaskSelected(m) : null;
  return {
    tris: raw.length / 9,
    fingerprint: sum,
    size: { x: +m.size.x.toFixed(6), y: +m.size.y.toFixed(6), z: +m.size.z.toFixed(6) },
    selectCount: nsoMaskSelectCount(m),
    excludeCount: nsoMaskCount(m),
    selected: sel ? { axisIdx: sel.axisIdx, keepMin: sel.keepMin, inner: sel.inner, d: sel.d } : null,
    pink: overlays.filter(o => col(o) === 0xf472b6)
                  .reduce((n, o) => n + o.geometry.attributes.position.count / 3, 0),
    yellow: overlays.filter(o => col(o) === 0xffdd00)
                    .reduce((n, o) => n + o.geometry.attributes.position.count / 3, 0),
    status: document.getElementById('status').textContent,
    undoEnabled: !document.getElementById('btn-undo').disabled
  };
};

/* Screen point at the centre of one face of a placed piece, plus what the
   app's own ray finds there, so a click is asserted to land on the face it
   was aimed at BEFORE it is made. Lifted from tools/nso_face_select_test.js,
   which is where the pattern is already proven. */
const facePoint = function ([id, axis, sign]) {
  const p = state.placed.find(x => x && x.sourceId === id && x.mesh);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  const c = bb.getCenter(new THREE.Vector3());
  const w = c.clone();
  w.setComponent(axis, sign > 0 ? bb.max.getComponent(axis) : bb.min.getComponent(axis));
  const ndc = w.clone().project(state.camera);
  const rect = state.renderer.domElement.getBoundingClientRect();
  const x = rect.left + (ndc.x + 1) / 2 * rect.width;
  const y = rect.top + (1 - ndc.y) / 2 * rect.height;
  state.pointer.x = ndc.x; state.pointer.y = ndc.y;
  state.raycaster.setFromCamera(state.pointer, state.camera);
  const hits = state.raycaster.intersectObjects(state.modelGroup.children, true)
    .filter(h => h.faceIndex != null);
  let hitId = null, hitN = null;
  if (hits.length) {
    let o = hits[0].object;
    while (o && o.userData.placedIndex == null && o.parent) o = o.parent;
    hitId = o && o.userData ? state.placed[o.userData.placedIndex].sourceId : null;
    const n = hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld);
    hitN = [n.x, n.y, n.z].map(v => Math.round(v * 1000) / 1000);
  }
  const el = document.elementFromPoint(x, y);
  return { x, y, hitId, hitN, onCanvas: el === state.renderer.domElement };
};

async function clickFace(page, id, axis, sign) {
  const fp = await page.evaluate(facePoint, [id, axis, sign]);
  const want = [0, 0, 0]; want[axis] = sign;
  const aimed = fp.hitId === id && fp.hitN && fp.hitN.every((v, i) => near(v, want[i], 1e-3)) && fp.onCanvas;
  check('  aim: the click lands on that piece\'s ' + 'XYZ'[axis] + (sign > 0 ? '+' : '-') +
        ' face, on the canvas', aimed, JSON.stringify(fp));
  await page.mouse.click(fp.x, fp.y);
  return fp;
}

async function exportPlateSTL(page, label) {
  // export-format moved into the top bar's Export dropdown; unfold it first.
  await page.evaluate(() => { const e = document.getElementById('export-format'); for (let n = e; n; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true; });
  await page.selectOption('#export-format', 'stl');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('#btn-export-stl')
  ]);
  // folded back: this check clicks the canvas, and an open panel
  // hangs over the top of the viewport where some of those land.
  await page.evaluate(() => document.querySelectorAll('.viewport-overlay-topbar details').forEach(d => { d.open = false; }));
  const file = path.join(tmp, label + '_' + download.suggestedFilename());
  await download.saveAs(file);
  return file;
}

function meshValidate(file, extra) {
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json', '--gate'];
  if (extra) args.push.apply(args, extra);
  try {
    return { code: 0, json: JSON.parse(execFileSync('python3', args, { encoding: 'utf8', maxBuffer: 64 << 20 })) };
  } catch (e) {
    let json = null;
    try { json = JSON.parse(e.stdout || ''); } catch (_) { /* crashed before JSON */ }
    return { code: e.status == null ? 1 : e.status, json, out: (e.stdout || '') + (e.stderr || '') };
  }
}

withApp(async (page, logs) => {
  console.log('\n=== 1. the Delete row is on the page and wired ===');
  const row = await page.evaluate(() => {
    const b = document.getElementById('btn-mask-delete');
    const s = document.getElementById('sel-mask-delete');
    return {
      btn: b ? { text: b.textContent.trim(), wired: b.dataset.nsoWired === '1' } : null,
      modes: s ? Array.from(s.options).map(o => o.value) : null,
      value: s ? s.value : null,
      moduleLoaded: typeof NSO_PaintDelete !== 'undefined' && typeof NSO_PaintDelete.commit === 'function',
      appFn: typeof NSO_deletePaintedFace === 'function'
    };
  });
  check('#btn-mask-delete present', !!row.btn, row.btn ? 'label "' + row.btn.text + '"' : 'missing');
  check('listener attached at load', !!row.btn && row.btn.wired);
  check('nso_paint_delete.js loaded in the page', row.moduleLoaded);
  check('NSO_deletePaintedFace is reachable', row.appFn);
  check('three modes, Face first', JSON.stringify(row.modes) === '["face","face-seal","shell"]' &&
        row.value === 'face', JSON.stringify(row.modes) + ' value ' + row.value);

  const id = await loadSTL(page, fx('box-20mm.stl'));
  await selectModel(page, id);
  await openFinishMenu(page);

  console.log('\n=== 2. no target: it says what to do, and changes nothing ===');
  let before = await page.evaluate(pieceState, id);
  await clearStatus(page);
  await page.click('#btn-mask-delete');
  await waitStatus(page, /Delete needs a target face/);
  let s = await page.evaluate(pieceState, id);
  console.log('   status: ' + s.status);
  check('status names Paint Selected as the way in', /Paint Selected/.test(s.status), s.status);
  check('piece untouched', s.fingerprint === before.fingerprint && s.tris === before.tris);

  console.log('\n=== 3. Paint Selected + a real click: the pink IS the cut ===');
  await page.click('#btn-mask-select');
  await clickFace(page, id, 1, 1);      // display +Y is the raw +Z top of the cube
  s = await page.evaluate(pieceState, id);
  console.log('   status: ' + s.status);
  check('exactly one target recorded', s.selectCount === 1, JSON.stringify(s.selected));
  check('the exclude list is untouched', s.excludeCount === 0);
  check('the target is an outer face, raw +Z', s.selected && s.selected.axisIdx === 2 &&
        s.selected.keepMin === false && s.selected.inner === false, JSON.stringify(s.selected));
  check('the pink covers the 2 triangles of that face', s.pink === 2, String(s.pink));
  await page.click('#btn-mask-select');      // stop selecting; the target stays

  const pinkBefore = s.pink;
  before = await page.evaluate(pieceState, id);
  await clearStatus(page);
  await page.selectOption('#sel-mask-delete', 'face');
  await page.click('#btn-mask-delete');
  await waitStatus(page, /Delete done/);
  s = await page.evaluate(pieceState, id);
  console.log('   status: ' + s.status);
  check('status reports a completed delete', /^Delete done/.test(s.status), s.status);
  check('it removed exactly the triangles the pink covered',
        new RegExp('\\b' + pinkBefore + ' tri\\(s\\) removed').test(s.status),
        'pink was ' + pinkBefore + ', status says "' + s.status + '"');
  check('the piece really lost them', s.tris === before.tris - pinkBefore,
        before.tris + ' -> ' + s.tris);
  check('the status says the piece is now open', /the piece is now OPEN/.test(s.status), s.status);
  check('the target was consumed - its plane is not a face any more', s.selectCount === 0);
  check('and nothing is pink any more', s.pink === 0, String(s.pink));

  console.log('\n=== 4. Undo puts the geometry AND the target back, in one step ===');
  check('undo is enabled', s.undoEnabled);
  await clearStatus(page);
  await page.click('#btn-undo');
  await waitStatus(page, /Undo/);
  s = await page.evaluate(pieceState, id);
  console.log('   status: ' + s.status);
  check('undo names Delete, not another bake', /Undo: Delete reverted/.test(s.status), s.status);
  check('geometry restored exactly', s.fingerprint === before.fingerprint && s.tris === before.tris,
        before.tris + '/' + before.fingerprint + ' -> ' + s.tris + '/' + s.fingerprint);
  check('the target came back with it', s.selectCount === 1 && s.pink === 2,
        s.selectCount + ' target(s), ' + s.pink + ' pink');

  console.log('\n=== 5. paint wins: an excluded target stands the delete down ===');
  await page.click('#btn-mask-paint');                 // Paint Excluded
  await clickFace(page, id, 1, 1);                     // the same top face
  s = await page.evaluate(pieceState, id);
  check('the face is on both lists now', s.selectCount === 1 && s.excludeCount === 1,
        s.selectCount + ' target, ' + s.excludeCount + ' excluded');
  await page.click('#btn-mask-paint');
  before = await page.evaluate(pieceState, id);
  await clearStatus(page);
  await page.click('#btn-mask-delete');
  await waitStatus(page, /Delete stood down/);
  s = await page.evaluate(pieceState, id);
  console.log('   status: ' + s.status);
  check('it stands down and names the painted count', /Delete stood down - 1 painted face\(s\)/.test(s.status), s.status);
  check('it says paint wins', /Paint wins/.test(s.status), s.status);
  check('piece is byte-for-byte unchanged',
        s.fingerprint === before.fingerprint && s.tris === before.tris);
  check('the target is still there - a stand-down consumes nothing', s.selectCount === 1);

  console.log('\n=== 6. Face+seal: cut the lid off and close it again ===');
  await page.click('#btn-mask-clear');                 // drop both lists
  await page.click('#btn-mask-select');
  await clickFace(page, id, 1, 1);
  await page.click('#btn-mask-select');
  before = await page.evaluate(pieceState, id);
  await clearStatus(page);
  await page.selectOption('#sel-mask-delete', 'face-seal');
  await page.click('#btn-mask-delete');
  await waitStatus(page, /Delete done|Delete refused/);
  s = await page.evaluate(pieceState, id);
  console.log('   status: ' + s.status);
  check('applied, and the rim was sealed', /^Delete done/.test(s.status) && /, sealed/.test(s.status), s.status);
  check('the piece is closed again, so the status does not call it open',
        !/now OPEN/.test(s.status), s.status);
  check('a 12-triangle cube came back a 12-triangle cube', s.tris === 12, String(s.tris));
  check('the bounding box did not move', JSON.stringify(s.size) === JSON.stringify(before.size),
        JSON.stringify(before.size) + ' -> ' + JSON.stringify(s.size));

  const sealedFile = await exportPlateSTL(page, 'cube_delete_sealed');
  const v = meshValidate(sealedFile);
  check('the app\'s own export passes the canonical checker',
        v.code === 0 && v.json && v.json.verdict === 'PASS',
        v.json ? 'verdict ' + v.json.verdict + ', odd ' + v.json.odd_edges +
                 ', euler ' + v.json.euler_characteristic : (v.out || '').slice(-200));
  check('and it is still 8000 mm^3 of cube',
        v.json && near(Math.abs(v.json.signed_volume), 8000, 1e-3),
        v.json ? v.json.signed_volume.toFixed(4) : '-');
  await page.click('#btn-undo');

  console.log('\n=== 7. a refusal in the app leaves the piece alone ===');
  /* out-box-round-r05 is a rounded box. Cutting its flat top off leaves a
     5-edge rim that the shipped repair can only fan shut by crossing the
     piece - NSO_Repair's own gate blocks the fill (hole-fill:selfInt 0->1),
     the piece would come back neither cut nor closed, and Face+seal refuses
     the whole thing. This is the headline refusal: it reverts a delete that
     already "worked" because the seal it was asked for could not. */
  const id2 = await loadSTL(page, fx('out-box-round-r05.stl'));
  await selectModel(page, id2);
  await openFinishMenu(page);
  await page.click('#btn-mask-select');
  await clickFace(page, id2, 1, 1);
  await page.click('#btn-mask-select');
  before = await page.evaluate(pieceState, id2);
  check('out-box-round-r05 loaded with 118 triangles', before.tris === 118, String(before.tris));
  check('and the click took its top face as the target', before.selectCount === 1 && before.pink === 3,
        before.selectCount + ' target(s), ' + before.pink + ' pink');
  await clearStatus(page);
  await page.selectOption('#sel-mask-delete', 'face-seal');
  await page.click('#btn-mask-delete');
  await waitStatus(page, /Delete refused|Delete done/);
  s = await page.evaluate(pieceState, id2);
  console.log('   status: ' + s.status);
  check('refused', /^Delete refused/.test(s.status), s.status);
  check('and says which clause and with what numbers',
        /closed solid was required/.test(s.status), s.status);
  check('piece is byte-for-byte unchanged',
        s.fingerprint === before.fingerprint && s.tris === before.tris);
  check('the target survives a refusal', s.selectCount === 1);
  check('undo was not offered a step for something that did not happen',
        s.undoEnabled === before.undoEnabled);

  /* The same face, the same click, in plain Face mode: the cut itself was
     never the problem, only the seal it could not have. */
  await clearStatus(page);
  await page.selectOption('#sel-mask-delete', 'face');
  await page.click('#btn-mask-delete');
  await waitStatus(page, /Delete refused|Delete done/);
  s = await page.evaluate(pieceState, id2);
  console.log('   status: ' + s.status);
  check('without the seal the same delete goes through', /^Delete done/.test(s.status), s.status);
  check('and takes the 3 triangles the pink covered', s.tris === before.tris - 3,
        before.tris + ' -> ' + s.tris);
  const openFile = await exportPlateSTL(page, 'round_r05_open_top');
  const v2 = meshValidate(openFile, ['--non-solid']);
  check('the exported open piece passes the canonical checker as a deliberate open one',
        v2.code === 0 && v2.json && v2.json.verdict === 'PASS',
        v2.json ? 'verdict ' + v2.json.verdict + ', open ' + v2.json.open_edges +
                  ', nonmanifold ' + v2.json.nonmanifold_edges : (v2.out || '').slice(-200));
  await page.click('#btn-undo');

  console.log('\n=== 8. nothing else on the page broke ===');
  const errs = logs.filter(l => l.startsWith('[pageerror]'));
  check('no uncaught page errors', errs.length === 0, errs.join(' | '));
  const missing = await page.evaluate(() => ['btn-soften', 'btn-seal', 'btn-solidify', 'btn-smooth',
    'btn-mask-paint', 'btn-mask-select', 'btn-mask-clear', 'btn-skin-face', 'btn-mask-delete']
    .filter(i => !document.getElementById(i)));
  check('every Finish button still present', missing.length === 0, missing.join(','));

  console.log('\n----------------------------------------------------------');
  console.log(fails === 0 ? 'PASS' : fails + ' FAILED');
  console.log('exports in ' + tmp);
  process.exit(fails === 0 ? 0 : 1);
}).catch(e => { console.error('HARNESS FAIL', e); process.exit(1); });
