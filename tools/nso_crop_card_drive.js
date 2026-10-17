#!/usr/bin/env node
/* The Crop card, driven through the REAL app in headless Chromium (1280 x 900).
     node tools/nso_crop_card_drive.js      exit 0 = every gate held

   Every piece comes in through the app's own Import. Every grab is a real mouse:
   the pointer goes to the screen point of a handle the card drew (read back from
   the card, then checked here against the project of its world position), is
   pressed, dragged and let go. Nothing here sets a shape's numbers.

     1. the card is the Shape row, a readout, CROP and Cancel - and nothing else
     2. BOX: picked, it stands centred on the piece at half its size, six handles
        a thumb wide; a face dragged out grows the box on that side only; the body
        slides it across the plate, Shift slides it up; the readout follows live
        ("Box 40 x 22 x 15 mm - holds N faces, X cm3"); a press on nothing orbits;
        CROP adds "<name> crop N" in place, the original byte-identical, the copy
        selected, ONE Undo takes it off, the shape still there for another;
        a shape off the piece refuses in words and CROP stays off
     3. CYLINDER: the side sets the diameter, an end slides along the axis (the far
        end stays), an end pulled round past 45 degrees turns the axis
     4. SPHERE: one handle sets the diameter
     5. PIECE: a click on another piece is the cutter; the piece being cropped is refused
     6. OUTLINE: a click on a piece is its footprint, a Shift-click on a triangle its
        rim; d1, d2, z1, z2 dragged; the readout names them
     7. Escape and Cancel put the shape away; so does closing the card
     8. Detach from the Subtract card, Reattach from the Connect card
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++; else fail++;
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}
const f2 = v => (+v).toFixed(2);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const OUTDIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(os.tmpdir(), 'nso-crop-card-' + process.pid);
fs.mkdirSync(OUTDIR, { recursive: true });
const OUT = () => OUTDIR;
const HINGE = path.join(ROOT, 'library', 'hinge_knuckle_box.stl');
const TUBE = path.join(ROOT, 'library', 'soften_test_03_thinwall_tube.stl');
const V9 = path.join(ROOT, 'library', 'v9_mirror_factory.stl');

/* ---- page helpers --------------------------------------------------------- */

const card = (page, fn, arg) => page.evaluate(fn, arg);
const readout = page => page.evaluate(() => document.getElementById('crop-readout').textContent);
const shapeNow = page => page.evaluate(() => NSO_CropCard.shape());
const cardState = page => page.evaluate(() => {
  const S = NSO_CropCard.state();
  return { shape: S.shape, box: S.box, cyl: S.cyl, sph: S.sph, outline: { id: S.outline.id, mode: S.outline.mode, tri: S.outline.tri, d1: S.outline.d1, d2: S.outline.d2, z1: S.outline.z1, z2: S.outline.z2, hasFp: !!S.outline.fp },
           piece: S.piece, plan: S.plan && { ok: S.plan.ok, faces: S.plan.faces, vol: S.plan.volumeMm3, reason: S.plan.reason }, group: !!S.group, forId: S.forId };
});
/* The readout settles when the kernel has answered: wait for a "holds" or a refusal. */
const settled = (page, ms) => page.waitForFunction(() => {
  const S = NSO_CropCard.state();
  return !S.shape || (!S.timer && (S.plan || /^(Piece|Outline): click/.test(document.getElementById('crop-readout').textContent)));
}, null, { timeout: ms || 20000 });
const handleXY = (page, id) => page.evaluate(i => NSO_CropCard.handleScreen(i), id);

/* A real drag from (x, y) by (dx, dy), in steps, with optional modifier held. */
async function drag(page, x, y, dx, dy, shift) {
  await page.mouse.move(x, y);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.down();
  const n = 8;
  for (let i = 1; i <= n; i++) await page.mouse.move(x + dx * i / n, y + dy * i / n);
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

/* The camera, close and at an angle, on the middle of the plate. */
const frame = (page, from, at) => page.evaluate(([f, a]) => {
  state.camera.position.set(f[0], f[1], f[2]);
  state.controls.target.set(a[0], a[1], a[2]);
  state.camera.lookAt(a[0], a[1], a[2]);
  state.controls.update();
  state.renderer.render(state.scene, state.camera);
}, [from, at]);

/* A screen point where the ray hits piece `id` first, on a face pointing up if `up`,
   clear of every handle, with the canvas under it. */
const pointOn = (page, id, up) => page.evaluate(([i, wantUp]) => {
  const p = state.placed.find(q => q.sourceId === i), rc = state.renderer.domElement.getBoundingClientRect();
  const hs = NSO_CropCard.handles().map(h => NSO_CropCard.handleScreen(h));
  const c = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3()).project(state.camera);
  const cx = rc.left + (c.x + 1) / 2 * rc.width, cy = rc.top + (1 - c.y) / 2 * rc.height;
  let best = null;
  for (let gx = 0.03; gx < 0.97; gx += 0.012) for (let gy = 0.03; gy < 0.97; gy += 0.012) {
    const x = rc.left + gx * rc.width, y = rc.top + gy * rc.height;
    if (document.elementFromPoint(x, y) !== state.renderer.domElement) continue;
    if (hs.some(h => h && Math.hypot(h.x - x, h.y - y) < 26)) continue;
    state.raycaster.setFromCamera(new THREE.Vector2(gx * 2 - 1, 1 - gy * 2), state.camera);
    let hits = state.raycaster.intersectObjects(state.modelGroup.children, true).filter(h => h.faceIndex != null);
    if (nsoHelpers.pieceHits) hits = nsoHelpers.pieceHits(hits);
    if (!hits.length || hits[0].object !== p.mesh) continue;
    if (wantUp && hits[0].face.normal.clone().transformDirection(p.mesh.matrixWorld).y < 0.95) continue;
    const d = Math.hypot(x - cx, y - cy);
    if (!best || d < best.d) best = { x, y, d, tri: hits[0].faceIndex };
  }
  return best;
}, [id, !!up]);
const placeOver = (page, moveId, ontoId) => page.evaluate(([m, o]) => {
  const a = state.placed.find(q => q.sourceId === m), b = state.placed.find(q => q.sourceId === o);
  a.mesh.position.x = b.mesh.position.x; a.mesh.position.z = b.mesh.position.z; a.x = b.x; a.z = b.z;
  a.mesh.updateMatrixWorld(true);
}, [moveId, ontoId]);
const pieceCount = page => page.evaluate(() => state.models.length);
const cropNow = async (page, hid) => {
  const n = await pieceCount(page);
  await page.waitForFunction(() => !document.getElementById('btn-crop').disabled, null, { timeout: 20000 });
  await page.click('#btn-crop');
  await page.waitForFunction(k => state.models.length > k, n, { timeout: 30000 });
  return (await page.evaluate(() => state.models[state.models.length - 1].name));
};
const reselect = (page, id) => page.evaluate(h => { selectPlaced(state.placed.findIndex(q => q.sourceId === h)); }, id);

const world = (page, id) => page.evaluate(i => {
  const p = state.placed.find(q => q.sourceId === i);
  const b = new THREE.Box3().setFromObject(p.mesh);
  return { lo: [b.min.x, -b.max.z, b.min.y], hi: [b.max.x, -b.min.z, b.max.y] };
}, id);

const snap = (page, id) => page.evaluate(i => {
  const m = state.models.find(q => q.id === i);
  return { raw: Array.from(m.rawTris), pos: Array.from(m.geometry.attributes.position.array), off: m.centerOffset,
           models: state.models.length, placed: state.placed.length, undo: state.undoStack.length, names: state.models.map(q => q.name) };
}, id);

(async () => {
  await withApp(async (page, logs) => {
    await page.waitForTimeout(400);

    /* ================================================================= 1 */
    console.log('\n=== 1. the card is the Shape row, a readout, CROP and Cancel ===');
    const dom = await page.evaluate(() => {
      const c = document.getElementById('crop-card');
      const btns = Array.from(c.querySelectorAll('button')).map(b => b.id);
      return { btns, inputs: c.querySelectorAll('input, select, textarea').length, readouts: c.querySelectorAll('p').length,
               row: Array.from(document.querySelectorAll('#crop-shape-row button')).map(b => b.textContent.trim()),
               detachHere: !!c.querySelector('#btn-detach, #btn-reattach'),
               detachIn: !!document.querySelector('#menu-bit #btn-detach'), reattachIn: !!document.querySelector('#menu-connect #btn-reattach'),
               readoutId: !!document.getElementById('crop-readout'), hit: NSO_CropCard.HIT_PX };
    });
    check('the Shape row is Box, Cylinder, Sphere, Piece, Outline', dom.row.join(',') === 'Box,Cylinder,Sphere,Piece,Outline', dom.row.join(','));
    check('the buttons are the five shapes, CROP and Cancel, and no others', dom.btns.join(',') ===
      'btn-crop-shape-box,btn-crop-shape-cylinder,btn-crop-shape-sphere,btn-crop-shape-piece,btn-crop-shape-outline,btn-crop,btn-crop-cancel', dom.btns.join(','));
    check('no field, checkbox or list, and one readout line', dom.inputs === 0 && dom.readouts === 1 && dom.readoutId, dom.inputs + ' inputs, ' + dom.readouts + ' lines');
    check('Detach flange is in the Subtract card and Reattach in the Connect card, not here', !dom.detachHere && dom.detachIn && dom.reattachIn);
    check('a handle is grabbed within at least 12 px', dom.hit >= 12, dom.hit + ' px');

    /* ================================================================= 2 */
    console.log('\n=== 2. BOX ===');
    const hid = await loadSTL(page, HINGE);
    const tid = await loadSTL(page, TUBE);
    // the tube goes over the hinge, for Piece and Outline later; the hinge is the cropped piece
    await page.evaluate(([h, t]) => {
      const hp = state.placed.find(q => q.sourceId === h), tp = state.placed.find(q => q.sourceId === t);
      tp.mesh.position.x = hp.mesh.position.x + 40; tp.mesh.position.z = hp.mesh.position.z; tp.x = hp.x + 40; tp.z = hp.z;
      tp.mesh.updateMatrixWorld(true);
    }, [hid, tid]);
    await selectModel(page, hid);
    await page.click('#menu-crop > summary');
    await page.evaluate(h => { selectPlaced(state.placed.findIndex(q => q.sourceId === h)); }, hid);
    await frame(page, [26, 22, 30], [0, 4, 0]);
    let ro = await readout(page);
    check('open on a selected piece: the readout asks for a shape', /^Pick a shape/.test(ro), ro);
    check('CROP is off, Cancel is off, nothing is drawn', await page.evaluate(() =>
      document.getElementById('btn-crop').disabled && document.getElementById('btn-crop-cancel').disabled && !NSO_CropCard.state().group));

    const hb = await world(page, hid);
    await page.click('#btn-crop-shape-box');
    await settled(page);
    let st = await cardState(page);
    const ctr = [0, 1, 2].map(k => (hb.lo[k] + hb.hi[k]) / 2), sz = [0, 1, 2].map(k => hb.hi[k] - hb.lo[k]);
    check('picked: the box is centred on the piece', st.box && [0, 1, 2].every(k => near(st.box.c[k], ctr[k], 0.01)), JSON.stringify(st.box && st.box.c.map(f2)) + ' vs ' + JSON.stringify(ctr.map(f2)));
    check('...at half its size, each way', st.box && [0, 1, 2].every(k => near(2 * st.box.h[k], sz[k] / 2, 0.01)), JSON.stringify(st.box && st.box.h.map(v => f2(2 * v))) + ' vs ' + JSON.stringify(sz.map(v => f2(v / 2))));
    check('...drawn: a translucent body and six handles', st.group && (await page.evaluate(() => NSO_CropCard.handles().length)) === 6);
    ro = await readout(page);
    check('the readout is "Box A × B × C mm · holds N faces, X cm³"', /^Box [\d.]+ × [\d.]+ × [\d.]+ mm · holds \d+ faces, [\d.]+ cm³$/.test(ro), ro);
    check('CROP and Cancel are on', await page.evaluate(() => !document.getElementById('btn-crop').disabled && !document.getElementById('btn-crop-cancel').disabled));
    const hs = await page.evaluate(() => NSO_CropCard.handles().map(i => { const p = NSO_CropCard.handleScreen(i); return { i, x: p.x, y: p.y }; }));
    const nearest = hs.reduce((m, a) => hs.reduce((mm, b) => a === b ? mm : Math.min(mm, Math.hypot(a.x - b.x, a.y - b.y)), m), 1e9);
    check('the handles are far enough apart on screen to tell apart at this zoom', nearest > 8, nearest.toFixed(1) + ' px at the closest');
    await page.screenshot({ path: path.join(OUT(), 'crop-box.png') });

    // drag the +x face out
    const before = await cardState(page);
    const hx = await handleXY(page, 'x+');
    const ro0 = await readout(page);
    await drag(page, hx.x, hx.y, 46, 8);
    await settled(page);
    const after = await cardState(page);
    check('dragging the x+ face out grows that half-size', after.box.h[0] > before.box.h[0] + 0.3, f2(before.box.h[0]) + ' -> ' + f2(after.box.h[0]));
    check('...and the opposite face stays where it was', near(after.box.c[0] - after.box.h[0], before.box.c[0] - before.box.h[0], 1e-3),
      f2(after.box.c[0] - after.box.h[0]) + ' vs ' + f2(before.box.c[0] - before.box.h[0]));
    check('...the other sizes and the height are untouched', near(after.box.h[1], before.box.h[1], 1e-6) && near(after.box.h[2], before.box.h[2], 1e-6) && near(after.box.c[2], before.box.c[2], 1e-6));
    const ro1 = await readout(page);
    check('the readout followed', ro1 !== ro0 && /^Box /.test(ro1), ro0 + '  ->  ' + ro1);

    // the -z face down, the box slides: body
    const hz = await handleXY(page, 'z-');
    await drag(page, hz.x, hz.y, 0, 30);
    await settled(page);
    const dz = await cardState(page);
    check('the z- face pulled down grows the box downward', dz.box.h[2] > after.box.h[2] + 0.2, f2(after.box.h[2]) + ' -> ' + f2(dz.box.h[2]));

    // slide the body: press on the body, away from every handle
    const bodyPt = await page.evaluate(() => {
      // a point on the body's front face near a corner, clear of the six handles (>= 20 px)
      const S = NSO_CropCard.state(), hs2 = NSO_CropCard.handles().map(i => NSO_CropCard.handleScreen(i));
      const b = new THREE.Box3().setFromObject(S.body), c = b.getCenter(new THREE.Vector3());
      const cand = [];
      for (let u = -0.8; u <= 0.8; u += 0.2) for (let v = -0.8; v <= 0.8; v += 0.2) {
        for (let w = -0.8; w <= 0.8; w += 0.4) cand.push(new THREE.Vector3(c.x + u * (b.max.x - b.min.x) / 2, c.y + v * (b.max.y - b.min.y) / 2, c.z + w * (b.max.z - b.min.z) / 2));
      }
      const rc = state.renderer.domElement.getBoundingClientRect();
      for (const p of cand) {
        const q = p.clone().project(state.camera), x = rc.left + (q.x + 1) / 2 * rc.width, y = rc.top + (1 - q.y) / 2 * rc.height;
        if (hs2.every(h => Math.hypot(h.x - x, h.y - y) > 24)) {
          state.raycaster.setFromCamera(new THREE.Vector2(q.x, q.y), state.camera);
          const hit = state.raycaster.intersectObject(S.body, false)[0];
          if (hit && document.elementFromPoint(x, y) === state.renderer.domElement) return { x, y };
        }
      }
      return null;
    });
    check('(a spot on the body clear of every handle was found)', !!bodyPt);
    const c0 = (await cardState(page)).box.c.slice();
    await drag(page, bodyPt.x, bodyPt.y, 40, 0);
    await settled(page);
    const slid = (await cardState(page)).box;
    check('the body slid across the plate: x or y moved, the height did not', (Math.abs(slid.c[0] - c0[0]) + Math.abs(slid.c[1] - c0[1])) > 0.5 && near(slid.c[2], c0[2], 1e-6),
      JSON.stringify(c0.map(f2)) + ' -> ' + JSON.stringify(slid.c.map(f2)));
    const bodyPt2 = await page.evaluate(() => {
      const S = NSO_CropCard.state(), hs2 = NSO_CropCard.handles().map(i => NSO_CropCard.handleScreen(i));
      const b = new THREE.Box3().setFromObject(S.body), c = b.getCenter(new THREE.Vector3());
      const rc = state.renderer.domElement.getBoundingClientRect();
      for (let u = -0.8; u <= 0.8; u += 0.2) for (let v = -0.8; v <= 0.8; v += 0.2) {
        const p = new THREE.Vector3(c.x + u * (b.max.x - b.min.x) / 2, c.y + v * (b.max.y - b.min.y) / 2, c.z);
        const q = p.clone().project(state.camera), x = rc.left + (q.x + 1) / 2 * rc.width, y = rc.top + (1 - q.y) / 2 * rc.height;
        if (hs2.every(h => Math.hypot(h.x - x, h.y - y) > 24)) {
          state.raycaster.setFromCamera(new THREE.Vector2(q.x, q.y), state.camera);
          if (state.raycaster.intersectObject(S.body, false)[0] && document.elementFromPoint(x, y) === state.renderer.domElement) return { x, y };
        }
      }
      return null;
    });
    const c1 = slid.c.slice();
    await drag(page, bodyPt2.x, bodyPt2.y, 0, -36, true);
    await settled(page);
    const up = (await cardState(page)).box;
    check('Shift slides it straight up: the height moved, x and y did not', Math.abs(up.c[2] - c1[2]) > 0.3 && near(up.c[0], c1[0], 1e-6) && near(up.c[1], c1[1], 1e-6),
      f2(c1[2]) + ' -> ' + f2(up.c[2]));

    // orbit between grabs: a press on nothing moves the camera, not the shape
    const cam0 = await page.evaluate(() => state.camera.position.toArray());
    const box0 = JSON.stringify((await cardState(page)).box);
    await drag(page, 900, 700, 120, 0);
    const cam1 = await page.evaluate(() => state.camera.position.toArray());
    check('a press on no handle and no body orbits the camera', Math.hypot(cam1[0] - cam0[0], cam1[2] - cam0[2]) > 1, cam0.map(f2) + ' -> ' + cam1.map(f2));
    check('...and leaves the shape where it was', JSON.stringify((await cardState(page)).box) === box0);
    await frame(page, [26, 22, 30], [0, 4, 0]);

    // CROP: picking Box again stands a fresh one on the piece
    await page.click('#btn-crop-shape-box');
    await settled(page);
    const fresh = await cardState(page);
    check('picking Box again puts a fresh box on the piece, centred, at half size', near(fresh.box.c[0], ctr[0], 0.01) && near(2 * fresh.box.h[0], sz[0] / 2, 0.01) && fresh.box.yaw === 0);
    const pre = await snap(page, hid);
    await page.waitForFunction(() => !document.getElementById('btn-crop').disabled, null, { timeout: 20000 });
    await page.click('#btn-crop');
    await page.waitForFunction(n => state.models.length > n, pre.models, { timeout: 30000 });
    const post = await snap(page, hid);
    check('CROP adds one piece, named "<name> crop 1"', post.models === pre.models + 1 && post.names[post.names.length - 1] === 'hinge_knuckle_box crop 1', post.names[post.names.length - 1]);
    check('the original is byte-identical: its soup, its drawn mesh, its centre offset',
      JSON.stringify(post.raw) === JSON.stringify(pre.raw) && JSON.stringify(post.pos) === JSON.stringify(pre.pos) && JSON.stringify(post.off) === JSON.stringify(pre.off));
    const sel = await page.evaluate(() => { const p = state.placed[state.selectedIndex]; return p && state.models.find(q => q.id === p.sourceId).name; });
    check('the copy is selected', sel === 'hinge_knuckle_box crop 1', sel);
    const keep = await cardState(page);
    check('the shape stays, still on the original, for another crop', keep.shape === 'box' && keep.forId === hid && keep.group);
    await settled(page);
    await page.waitForFunction(() => !document.getElementById('btn-crop').disabled, null, { timeout: 20000 });
    await page.click('#btn-crop');
    await page.waitForFunction(n => state.models.length > n, post.models, { timeout: 30000 });
    const post2 = await snap(page, hid);
    check('...a second CROP is "crop 2" of the same original, not a crop of the copy', post2.names[post2.names.length - 1] === 'hinge_knuckle_box crop 2', post2.names[post2.names.length - 1]);
    await page.click('#btn-undo');
    const und = await snap(page, hid);
    check('ONE Undo takes that copy off the plate and out of the list', und.models === post.models && und.placed === post.placed && und.undo === post.undo, und.models + ' models, ' + und.placed + ' placed');
    await page.click('#btn-undo');
    const und2 = await snap(page, hid);
    check('a second Undo takes the first one', und2.models === pre.models && und2.undo === pre.undo && JSON.stringify(und2.raw) === JSON.stringify(pre.raw));
    check('the shape is still up after the Undos', (await cardState(page)).shape === 'box');
    await selectModel(page, hid);
    await page.evaluate(h => { selectPlaced(state.placed.findIndex(q => q.sourceId === h)); }, hid);

    // a shape dragged off the piece: refused in words, CROP off
    {
      const pt = await page.evaluate(() => {
        const S = NSO_CropCard.state(), hs2 = NSO_CropCard.handles().map(i => NSO_CropCard.handleScreen(i));
        const b = new THREE.Box3().setFromObject(S.body), c = b.getCenter(new THREE.Vector3()), rc = state.renderer.domElement.getBoundingClientRect();
        for (let u = -0.7; u <= 0.7; u += 0.1) for (let v = -0.7; v <= 0.7; v += 0.1) for (let w = -0.7; w <= 0.7; w += 0.35) {
          const p = new THREE.Vector3(c.x + u * (b.max.x - b.min.x) / 2, c.y + v * (b.max.y - b.min.y) / 2, c.z + w * (b.max.z - b.min.z) / 2);
          const q = p.clone().project(state.camera), x = rc.left + (q.x + 1) / 2 * rc.width, y = rc.top + (1 - q.y) / 2 * rc.height;
          if (hs2.every(h => Math.hypot(h.x - x, h.y - y) > 22)) {
            state.raycaster.setFromCamera(new THREE.Vector2(q.x, q.y), state.camera);
            if (state.raycaster.intersectObject(S.body, false)[0] && document.elementFromPoint(x, y) === state.renderer.domElement) return { x, y };
          }
        }
        return null;
      });
      await frame(page, [26, 22, 30], [0, 4, 0]);
      await page.click('#btn-crop-shape-box');
      await settled(page);
      const pt2 = await page.evaluate(() => {
        const S = NSO_CropCard.state(), hs2 = NSO_CropCard.handles().map(i => NSO_CropCard.handleScreen(i));
        const b = new THREE.Box3().setFromObject(S.body), c = b.getCenter(new THREE.Vector3()), rc = state.renderer.domElement.getBoundingClientRect();
        for (let u = -0.7; u <= 0.7; u += 0.1) for (let v = -0.7; v <= 0.7; v += 0.1) for (let w = -0.7; w <= 0.7; w += 0.35) {
          const p = new THREE.Vector3(c.x + u * (b.max.x - b.min.x) / 2, c.y + v * (b.max.y - b.min.y) / 2, c.z + w * (b.max.z - b.min.z) / 2);
          const q = p.clone().project(state.camera), x = rc.left + (q.x + 1) / 2 * rc.width, y = rc.top + (1 - q.y) / 2 * rc.height;
          if (hs2.every(h => Math.hypot(h.x - x, h.y - y) > 22)) {
            state.raycaster.setFromCamera(new THREE.Vector2(q.x, q.y), state.camera);
            if (state.raycaster.intersectObject(S.body, false)[0] && document.elementFromPoint(x, y) === state.renderer.domElement) return { x, y };
          }
        }
        return null;
      });
      // up with Shift, far: the shape leaves the piece
      await drag(page, pt2.x, pt2.y, 0, -400, true);
      await settled(page);
      ro = await readout(page);
      const refused = await page.evaluate(() => ({ crop: document.getElementById('btn-crop').disabled, red: document.getElementById('crop-readout').classList.contains('is-refusal') }));
      check('dragged off the piece: the readout refuses in words', /holds nothing of this piece/.test(ro), ro);
      check('...in the refusal colour, and CROP is off', refused.red && refused.crop);
      const n0 = (await snap(page, hid)).models;
      await page.evaluate(() => document.getElementById('btn-crop').click());
      await page.waitForTimeout(150);
      check('...pressing it anyway adds nothing', (await snap(page, hid)).models === n0);
    }

    // section 3: CYLINDER
    console.log('\n=== 3. CYLINDER ===');
    await frame(page, [26, 22, 30], [0, 4, 0]);
    await page.click('#btn-crop-shape-cylinder');
    await settled(page);
    st = await cardState(page);
    check('picked: a vertical cylinder centred on the piece, Ø half the narrower footprint, half the height',
      st.cyl && st.cyl.axis === 'z' && [0, 1, 2].every(k => near(st.cyl.c[k], ctr[k], 0.01)) && near(2 * st.cyl.r, Math.min(sz[0], sz[1]) / 2, 0.01) && near(2 * st.cyl.hl, sz[2] / 2, 0.01),
      JSON.stringify(st.cyl));
    check('...with an end on each end and one on the side', (await page.evaluate(() => NSO_CropCard.handles())).join(',') === 'end+,end-,side');
    ro = await readout(page);
    check('the readout is "Cylinder ØD × L mm along Z · holds …"', /^Cylinder Ø[\d.]+ × [\d.]+ mm along Z · holds \d+ faces, [\d.]+ cm³$/.test(ro), ro);
    const cy0 = st.cyl, sd = await handleXY(page, 'side');
    await drag(page, sd.x, sd.y, 30, 0);
    await settled(page);
    const cy1 = (await cardState(page)).cyl;
    check('dragging the side changes the diameter, and nothing else', Math.abs(cy1.r - cy0.r) > 0.2 && near(cy1.hl, cy0.hl, 1e-6) && cy1.axis === 'z' && near(cy1.c[2], cy0.c[2], 1e-6), f2(cy0.r) + ' -> ' + f2(cy1.r));
    const e1 = await handleXY(page, 'end+');
    await drag(page, e1.x, e1.y, 0, -26);
    await settled(page);
    const cy2 = (await cardState(page)).cyl;
    check('an end slid along the axis: the length changed, the axis is still z', Math.abs(cy2.hl - cy1.hl) > 0.2 && cy2.axis === 'z', f2(cy1.hl) + ' -> ' + f2(cy2.hl));
    check('...and the far end stayed', near(cy2.c[2] - cy2.hl, cy1.c[2] - cy1.hl, 1e-3), f2(cy2.c[2] - cy2.hl) + ' vs ' + f2(cy1.c[2] - cy1.hl));
    // pull an end round past 45 degrees: sideways, well off the axis
    await page.click('#btn-crop-shape-cylinder');
    await settled(page);
    const e2 = await handleXY(page, 'end+');
    await drag(page, e2.x, e2.y, 150, 20);
    await settled(page);
    const cy3 = (await cardState(page)).cyl;
    check('an end pulled round past 45° turns the axis to follow it', cy3.axis !== 'z', 'axis ' + cy3.axis);
    ro = await readout(page);
    check('...and the readout says which axis', new RegExp('along ' + cy3.axis.toUpperCase()).test(ro), ro);
    await page.click('#btn-crop-shape-cylinder');
    await settled(page);
    const n1 = (await snap(page, hid)).models;
    await page.waitForFunction(() => !document.getElementById('btn-crop').disabled, null, { timeout: 20000 });
    await page.click('#btn-crop');
    await page.waitForFunction(n => state.models.length > n, n1, { timeout: 30000 });
    check('CROP on the cylinder adds the copy', (await snap(page, hid)).models === n1 + 1);
    await page.click('#btn-undo');

    // section 4: SPHERE
    console.log('\n=== 4. SPHERE ===');
    await selectModel(page, hid);
    await page.evaluate(h => { selectPlaced(state.placed.findIndex(q => q.sourceId === h)); }, hid);
    await frame(page, [26, 22, 30], [0, 4, 0]);
    await page.click('#btn-crop-shape-sphere');
    await settled(page);
    st = await cardState(page);
    check('picked: a sphere centred on the piece, Ø half its smallest side', st.sph && [0, 1, 2].every(k => near(st.sph.c[k], ctr[k], 0.01)) && near(2 * st.sph.r, Math.min(...sz) / 2, 0.01), JSON.stringify(st.sph));
    check('...one handle', (await page.evaluate(() => NSO_CropCard.handles())).join(',') === 'radius');
    ro = await readout(page);
    check('the readout is "Sphere ØD mm · holds …"', /^Sphere Ø[\d.]+ mm · holds \d+ faces, [\d.]+ cm³$/.test(ro), ro);
    const sh0 = await handleXY(page, 'radius');
    await drag(page, sh0.x, sh0.y, 34, 0);
    await settled(page);
    const sp1 = (await cardState(page)).sph;
    check('dragging the handle sets the diameter, the centre stays', Math.abs(sp1.r - st.sph.r) > 0.3 && [0, 1, 2].every(k => near(sp1.c[k], st.sph.c[k], 1e-6)), f2(st.sph.r) + ' -> ' + f2(sp1.r));
    const n2 = (await snap(page, hid)).models;
    await page.waitForFunction(() => !document.getElementById('btn-crop').disabled, null, { timeout: 20000 });
    await page.click('#btn-crop');
    await page.waitForFunction(n => state.models.length > n, n2, { timeout: 30000 });
    check('CROP on the sphere adds the copy', (await snap(page, hid)).models === n2 + 1);
    await page.click('#btn-undo');

    /* ================================================================= 5 */
    console.log('\n=== 5. PIECE ===');
    await reselect(page, hid);
    await frame(page, [56, 40, 62], [20, 6, 0]);
    await page.click('#btn-crop-shape-piece');
    await settled(page);
    ro = await readout(page);
    check('picked: it waits for a click on another piece', /^Piece: click another piece to be the cutter/.test(ro), ro);
    check('...no handles, CROP off', (await page.evaluate(() => NSO_CropCard.handles().length)) === 0 && await page.evaluate(() => document.getElementById('btn-crop').disabled));
    const self = await pointOn(page, hid, false);
    await page.mouse.click(self.x, self.y);
    check('a click on the piece being cropped is refused in words', /That is the piece being cropped/.test(await page.evaluate(() => document.getElementById('status').textContent))
      && (await cardState(page)).piece.id == null);
    check('...and did not change the selection', await page.evaluate(h => state.placed[state.selectedIndex].sourceId === h, hid));
    await placeOver(page, tid, hid);
    await frame(page, [40, 34, 46], [0, 8, 0]);
    const tp = await pointOn(page, tid, false);
    await page.mouse.click(tp.x, tp.y);
    await settled(page);
    st = await cardState(page);
    ro = await readout(page);
    check('a click on the tube makes it the cutter', st.piece.id === tid, JSON.stringify(st.piece));
    check('the readout is "Piece <name> · holds N faces, X cm³"', /^Piece soften_test_03_thinwall_tube · holds \d+ faces, [\d.]+ cm³$/.test(ro), ro);
    check('...and the selection is still the piece being cropped', await page.evaluate(h => state.placed[state.selectedIndex].sourceId === h, hid));
    const pn = await cropNow(page, hid);
    check('CROP adds "<name> crop N"', /^hinge_knuckle_box crop \d+$/.test(pn), pn);
    await page.click('#btn-undo');

    /* ================================================================= 6 */
    console.log('\n=== 6. OUTLINE ===');
    await reselect(page, hid);
    await page.click('#btn-crop-shape-outline');
    await settled(page);
    ro = await readout(page);
    check('picked: it waits for a click on a piece (or a Shift-click on a triangle)', /^Outline: click a piece for its footprint, or Shift-click a triangle for its rim/.test(ro), ro);
    const tp2 = await pointOn(page, tid, false);
    await page.mouse.click(tp2.x, tp2.y);
    await page.waitForFunction(() => { const S = NSO_CropCard.state(); return S.outline.fp && S.plan && !S.timer; }, null, { timeout: 30000 });
    st = await cardState(page);
    ro = await readout(page);
    check('a click on the tube is its silhouette: four handles, d1 d2 z1 z2', st.outline.mode === 'silhouette' && (await page.evaluate(() => NSO_CropCard.handles())).join(',') === 'd1,d2,z1,z2');
    check('the readout is "Outline of <name>, +d1 / −d2 mm, z a → b mm · holds …"', /^Outline of soften_test_03_thinwall_tube, \+0\.0 \/ −0\.0 mm, z [\d.-]+ → [\d.-]+ mm · holds \d+ faces/.test(ro), ro);
    const o0 = st.outline;
    // d1: dragged along the surface normal, outward
    const d1h = await handleXY(page, 'd1');
    await drag(page, d1h.x, d1h.y, 40, 0);
    await settled(page);
    const o1 = (await cardState(page)).outline;
    check('the outer offset handle dragged outward sets d1', o1.d1 > 0.2 && o1.d2 === 0, f2(o0.d1) + ' -> ' + f2(o1.d1));
    const d2h = await handleXY(page, 'd2');
    await drag(page, d2h.x, d2h.y, 40, 0);
    await settled(page);
    const o2 = (await cardState(page)).outline;
    check('the inner offset handle dragged inward sets d2', o2.d2 > 0.2, f2(o1.d2) + ' -> ' + f2(o2.d2));
    const z2h = await handleXY(page, 'z2');
    await drag(page, z2h.x, z2h.y, 0, 22);
    await settled(page);
    const o3 = (await cardState(page)).outline;
    check('the top height handle dragged down lowers z2', o3.z2 < o2.z2 - 0.2 && o3.z1 === o2.z1, f2(o2.z2) + ' -> ' + f2(o3.z2));
    const z1h = await handleXY(page, 'z1');
    await drag(page, z1h.x, z1h.y, 0, -14);
    await settled(page);
    const o4 = (await cardState(page)).outline;
    check('the bottom height handle dragged up raises z1', o4.z1 > o3.z1 + 0.1 && o4.z2 === o3.z2, f2(o3.z1) + ' -> ' + f2(o4.z1));
    ro = await readout(page);
    check('the readout names them', new RegExp('\\+' + o4.d1.toFixed(1).replace('.', '\\.') + ' / −' + o4.d2.toFixed(1).replace('.', '\\.') + ' mm, z ' + o4.z1.toFixed(1).replace('.', '\\.')).test(ro), ro);
    await page.screenshot({ path: path.join(OUT(), 'crop-outline.png') });
    // Shift-click a triangle on the tube's top face: its rim
    await page.click('#btn-crop-shape-outline');
    await settled(page);
    const topPt = await pointOn(page, tid, true);
    await page.keyboard.down('Shift');
    await page.mouse.click(topPt.x, topPt.y);
    await page.keyboard.up('Shift');
    await page.waitForFunction(() => { const S = NSO_CropCard.state(); return S.outline.fp && S.plan && !S.timer; }, null, { timeout: 30000 });
    st = await cardState(page);
    ro = await readout(page);
    check('a Shift-click on a triangle takes its rim loop', st.outline.mode === 'rim' && st.outline.tri >= 0 && /^Outline of soften_test_03_thinwall_tube rim, /.test(ro), st.outline.mode + ' tri ' + st.outline.tri + '  ' + ro);
    // the same piece's own footprint: a skin
    await page.click('#btn-crop-shape-outline');
    await settled(page);
    await page.evaluate(t => { const a = state.placed.find(q => q.sourceId === t); a.mesh.position.x += 40; a.x += 40; a.mesh.updateMatrixWorld(true); }, tid);
    const hp = await pointOn(page, hid, false);
    await page.mouse.click(hp.x, hp.y);
    await page.waitForFunction(() => { const S = NSO_CropCard.state(); return S.outline.fp && S.plan && !S.timer; }, null, { timeout: 30000 });
    const own = await cardState(page);
    check('an Outline may be taken from the piece being cropped', own.outline.id === hid, JSON.stringify(own.outline));
    const d2o = await handleXY(page, 'd2');
    await drag(page, d2o.x, d2o.y, 30, 0);
    await settled(page);
    const skin = await cardState(page);
    check('...drag its inner offset: a skin, the plan holds some of the piece and not all of it', skin.outline.d2 > 0.1 && skin.plan.ok, f2(skin.outline.d2) + ' mm, ' + (skin.plan && skin.plan.faces) + ' faces');
    const sn = await cropNow(page, hid);
    check('CROP on an outline adds the copy', /^hinge_knuckle_box crop \d+$/.test(sn), sn);
    await page.click('#btn-undo');

    /* ================================================================= 7 */
    console.log('\n=== 7. Escape, Cancel, closing the card ===');
    await reselect(page, hid);
    await page.click('#btn-crop-shape-box');
    await settled(page);
    await page.keyboard.press('Escape');
    st = await cardState(page);
    check('Escape puts the shape away: nothing picked, nothing drawn', st.shape === null && !st.group && !(await page.evaluate(() => !!state.scene.getObjectByName('cropCardShape'))));
    check('...and the card asks for a shape again, CROP and Cancel off', /^Pick a shape/.test(await readout(page)) && await page.evaluate(() => document.getElementById('btn-crop').disabled && document.getElementById('btn-crop-cancel').disabled));
    await page.click('#btn-crop-shape-sphere');
    await settled(page);
    await page.click('#btn-crop-cancel');
    check('Cancel does the same', (await cardState(page)).shape === null && !(await page.evaluate(() => !!state.scene.getObjectByName('cropCardShape'))));
    await page.click('#btn-crop-shape-box');
    await settled(page);
    await page.click('#menu-crop > summary');
    check('closing the card puts the shape away too', (await cardState(page)).shape === null && !(await page.evaluate(() => !!state.scene.getObjectByName('cropCardShape'))));

    /* ================================================================= 8 */
    console.log('\n=== 8. Detach from the Subtract card, Reattach from the Connect card ===');
    const vid = await loadSTL(page, V9);
    await selectModel(page, vid);
    await page.click('#menu-bit > summary');
    const ids0 = await page.evaluate(() => state.models.map(m => m.id));
    check('Detach flange is a button of the Subtract card, wired', await page.evaluate(() => { const b = document.getElementById('btn-detach'); return !!b && b.dataset.nsoWired === '1' && !!b.closest('#menu-bit'); }));
    await page.click('#btn-detach');
    await page.waitForFunction(() => /Detach/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
    const ids1 = await page.evaluate(() => state.models.map(m => m.id));
    const dst = await page.evaluate(() => document.getElementById('status').textContent);
    check('Detach from the Subtract card takes the flange off as a piece of its own', ids1.length === ids0.length + 1 && /^Detached/.test(dst), dst.slice(0, 90));
    check('...its readout is in the Subtract card', await page.evaluate(() => !!document.getElementById('detach-readout').closest('#menu-bit') && document.getElementById('detach-readout').textContent.length > 1));
    await page.click('#menu-connect > summary');
    check('Reattach is a button of the Connect card, wired, and enabled now', await page.evaluate(() => { const b = document.getElementById('btn-reattach'); return !!b && b.dataset.nsoWired === '1' && !!b.closest('#menu-connect') && !b.disabled; }));
    await page.click('#btn-reattach');
    const arm = await page.evaluate(() => ({ armed: !!state.reattachArmed, s: document.getElementById('status').textContent }));
    check('Reattach from the Connect card arms, asking for the point on a piece', arm.armed && /click the point on a piece/.test(arm.s), arm.s.slice(0, 80));
    await page.click('#btn-reattach');

    const errs = logs.filter(l => l.startsWith('[pageerror]'));
    check('no page errors', errs.length === 0, errs.join(' | ').slice(0, 300));
  });

  console.log('\n' + (fail ? 'FAIL (' + fail + ' failed, ' + pass + ' ok)' : 'PASS (' + pass + ' ok)'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED', e); process.exit(2); });

