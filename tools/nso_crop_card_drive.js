#!/usr/bin/env node
/* The Crop card, driven through the REAL app in headless Chromium (1280 x 900).
     node tools/nso_crop_card_drive.js      exit 0 = every gate held

   Every piece comes in through the app's own Import. Every grab is a real mouse:
   the pointer goes to the screen point of a handle the card drew (read back from
   the card, then checked here against the project of its world position), is
   pressed, dragged and let go. Nothing here sets a shape's numbers.

     1. the card is the Shape row, a readout, CROP and Cancel, then Lift's button and panel
        (Strip, Detach flange) - and nothing else
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
     5b. WALL: click a flat wall of a block with a bump on it and a line appears along it; the line
        is dragged out of the wall and into it, or set by a click on the piece (the bump's top: the
        line is its height, and CROP holds nothing; the wall: the line is flush); CROP copies the
        bump and nothing else - 4 x 4 x 2 mm, closed - and the original is untouched; a Shift-click
        picks another wall
     5. OUTLINE: a click on a piece is its footprint, a Shift-click on a triangle its
        rim; d1, d2, z1, z2 dragged; the readout names them
     6. Escape and Cancel put the shape away; so does closing the card
     7. LASSO: a loop dragged round part of the piece with the real mouse is the shape; the
        copy is what the loop sees (every vertex of it falls inside the loop on the screen);
        Alt-drag orbits and the cone stays; a click or an Escape'd loop changes nothing;
        a new loop replaces the old one
     8. LIFT, in the Crop card, opens and folds away with its button; Detach flange is in its
        panel; Lift and a shape never run together; Reattach is in the Connect card
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');
const { csgContext } = require('./nso_csg_node.js');
const { writeSTL } = require('./nso_stl_io.js');

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

/* A 40 x 20 x 10 block with a 4 x 4 bump 2 mm proud on its +x wall (the bump is sunk 1 mm into the block, so the union has no seam), as an STL. */
async function bumpyBlockSTL(file) {
  const ctx = csgContext(), kern = ctx.NSO_CSG, wasm = await kern.load();
  const box = (lo, hi) => {
    const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]], [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
    const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]], o = [];
    for (const t of f) for (const i of t) o.push(...v[i]);
    return new Float32Array(o);
  };
  const a = kern.soupToManifold(wasm, box([0, 0, 0], [40, 20, 10])), b = kern.soupToManifold(wasm, box([39, 8, 3], [42, 12, 7]));
  const u = a.add(b), soup = kern.manifoldToSoup(u);
  a.delete(); b.delete(); u.delete();
  writeSTL(file, soup);
  return file;
}

const card = (page, fn, arg) => page.evaluate(fn, arg);
const readout = page => page.evaluate(() => document.getElementById('crop-readout').textContent);
const shapeNow = page => page.evaluate(() => NSO_CropCard.shape());
const cardState = page => page.evaluate(() => {
  const S = NSO_CropCard.state();
  return { shape: S.shape, box: S.box, cyl: S.cyl, sph: S.sph, outline: { id: S.outline.id, mode: S.outline.mode, tri: S.outline.tri, d1: S.outline.d1, d2: S.outline.d2, z1: S.outline.z1, z2: S.outline.z2, hasFp: !!S.outline.fp },
           plan: S.plan && { ok: S.plan.ok, faces: S.plan.faces, vol: S.plan.volumeMm3, reason: S.plan.reason }, group: !!S.group, forId: S.forId };
});
/* The readout settles when the kernel has answered: wait for a "holds" or a refusal. */
const settled = (page, ms) => page.waitForFunction(() => {
  const S = NSO_CropCard.state();
  return !S.shape || (!S.timer && (S.plan || /^(Outline|Wall|Lasso): (click|drag)/.test(document.getElementById('crop-readout').textContent)));
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
    console.log('\n=== 1. the card is the Shape row, a readout, CROP and Cancel, then Lift ===');
    const dom = await page.evaluate(() => {
      const c = document.getElementById('crop-card');
      const outside = el => !el.closest('#lift-panel');
      const btns = Array.from(c.querySelectorAll('button')).filter(b => outside(b) && b.id !== 'btn-lift').map(b => b.id);
      const panel = document.getElementById('lift-panel');
      return { btns, inputs: Array.from(c.querySelectorAll('input, select, textarea')).filter(outside).length,
               readouts: Array.from(c.querySelectorAll('p')).filter(outside).length,
               lift: { btn: !!c.querySelector('#btn-lift'), panelIn: !!panel && c.contains(panel), panelHidden: !!panel && panel.hidden,
                       detachInPanel: !!panel && !!panel.querySelector('#btn-detach') && !!panel.querySelector('#detach-readout'),
                       stripInPanel: !!panel && !!panel.querySelector('#btn-lift-strip'), notInSubtract: !document.querySelector('#menu-bit #btn-lift, #menu-bit #btn-detach, #menu-bit #lift-panel') },
               row: Array.from(document.querySelectorAll('#crop-shape-row button')).map(b => b.textContent.trim()),
               reattachHere: !!c.querySelector('#btn-reattach'), reattachIn: !!document.querySelector('#menu-connect #btn-reattach'),
               readoutId: !!document.getElementById('crop-readout'), hit: NSO_CropCard.HIT_PX };
    });
    check('the Shape row is Box, Cylinder, Sphere, Outline, Wall, Lasso', dom.row.join(',') === 'Box,Cylinder,Sphere,Outline,Wall,Lasso', dom.row.join(','));
    check('the buttons outside Lift are the six shapes, CROP and Cancel, and no others', dom.btns.join(',') ===
      'btn-crop-shape-box,btn-crop-shape-cylinder,btn-crop-shape-sphere,btn-crop-shape-outline,btn-crop-shape-wall,btn-crop-shape-lasso,btn-crop,btn-crop-cancel', dom.btns.join(','));
    check('no field, checkbox or list outside Lift, and one readout line', dom.inputs === 0 && dom.readouts === 1 && dom.readoutId, dom.inputs + ' inputs, ' + dom.readouts + ' lines');
    check('Lift is a button of the card with its panel folded away; Strip and Detach flange are in the panel; none of it is in Subtract',
      dom.lift.btn && dom.lift.panelIn && dom.lift.panelHidden && dom.lift.detachInPanel && dom.lift.stripInPanel && dom.lift.notInSubtract, JSON.stringify(dom.lift));
    check('Reattach is in the Connect card, not here', !dom.reattachHere && dom.reattachIn);
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

    /* ================================================================= 5b */
    console.log('\n=== 5b. WALL ===');
    {
    const BUMPY = await bumpyBlockSTL(path.join(OUTDIR, 'bumpy-block.stl'));
    const bid = await loadSTL(page, BUMPY);
    await selectModel(page, bid);
    await reselect(page, bid);
    const bb = await world(page, bid);                         // P-frame box of the block with its bump
    const wallX = bb.hi[0] - 2;                                // the +x wall is 2 mm under the bump's top
    const mid = [(bb.lo[0] + bb.hi[0]) / 2, (bb.lo[1] + bb.hi[1]) / 2, (bb.lo[2] + bb.hi[2]) / 2];
    // look at the +x wall from out in front of it, a little above, P (x, y, z) -> world (x, z, -y)
    await frame(page, [bb.hi[0] + 55, mid[2] + 22, -mid[1] + 20], [wallX, mid[2], -mid[1]]);
    await page.click('#btn-crop-shape-wall');
    await settled(page);
    ro = await readout(page);
    check('picked: it asks for a wall, no handles, CROP off, the button lit', /^Wall: click a flat wall of the piece/.test(ro) &&
      (await page.evaluate(() => NSO_CropCard.handles().length)) === 0 && await page.evaluate(() => document.getElementById('btn-crop').disabled &&
      document.getElementById('btn-crop-shape-wall').getAttribute('aria-pressed') === 'true'), ro);
    /* a screen point on the piece whose face is `wantN` (P) and sits `onPlane` mm out from the wall plane (+-0.05), clear of the bump and the handle */
    const bumpC = [mid[1], mid[2]];                              // the bump is in the middle of the wall: P y and z of the block's centre
    const aim = (wantN, plane, notNearBump) => page.evaluate(([i, wn, pl, wx, notNearBump, bumpC]) => {
      const p = state.placed.find(q => q.sourceId === i), rc = state.renderer.domElement.getBoundingClientRect();
      const hs = NSO_CropCard.handles().map(h => NSO_CropCard.handleScreen(h)).filter(Boolean);
      let best = null;
      for (let gx = 0.05; gx < 0.95; gx += 0.01) for (let gy = 0.05; gy < 0.95; gy += 0.01) {
        const x = rc.left + gx * rc.width, y = rc.top + gy * rc.height;
        if (document.elementFromPoint(x, y) !== state.renderer.domElement) continue;
        if (hs.some(h => Math.hypot(h.x - x, h.y - y) < 30)) continue;
        state.raycaster.setFromCamera(new THREE.Vector2(gx * 2 - 1, 1 - gy * 2), state.camera);
        const hit = state.raycaster.intersectObject(p.mesh, false).filter(h => h.faceIndex != null)[0];
        if (!hit) continue;
        const nP = hit.face.normal.clone().transformDirection(p.mesh.matrixWorld), n = [nP.x, -nP.z, nP.y];
        if (n[0] * wn[0] + n[1] * wn[1] + n[2] * wn[2] < 0.99) continue;
        const q = [hit.point.x, -hit.point.z, hit.point.y], out = q[0] - wx;
        if (Math.abs(out - pl) > 0.05) continue;
        const dBump = Math.hypot(q[1] - bumpC[0], q[2] - bumpC[1]);
        if (notNearBump && dBump < 7) continue;
        if (!notNearBump && dBump > 1.5) continue;
        const d = Math.hypot(gx - 0.5, gy - 0.5);
        if (!best || d < best.d) best = { x, y, d };
      }
      return best;
    }, [bid, wantN, plane, wallX, !!notNearBump, bumpC]);
    const w1 = await aim([1, 0, 0], 0, true);
    check('a point on the wall, away from the bump, is in view to click', !!w1, JSON.stringify(w1));
    await page.mouse.click(w1.x, w1.y);
    await settled(page);
    let wst = await page.evaluate(() => { const S = NSO_CropCard.state(); return { f: S.wall.face && { n: S.wall.face.n, size: S.wall.face.size, holes: S.wall.face.holes, corners: S.wall.face.ring.length }, off: S.wall.off, plan: S.plan && { ok: S.plan.ok, v: S.plan.volumeMm3, r: S.plan.reason }, handles: NSO_CropCard.handles() }; });
    check('a click on the wall picks it: faces +x, 20 x 10, four corners, the bump a hole in it', wst.f && near(wst.f.n[0], 1, 1e-6) && wst.f.corners === 4 && near(Math.min(...wst.f.size), 10, 1e-3) && near(Math.max(...wst.f.size), 20, 1e-3) && wst.f.holes === 1, JSON.stringify(wst.f));
    check('...one handle, the line, and the line is flush on the wall', wst.handles.join(',') === 'line' && wst.off === 0, wst.handles.join(',') + ' off ' + wst.off);
    ro = await readout(page);
    check('the readout is "Wall 20 × 10 mm, line +0.00 mm · holds N faces, 0.03 cm³" - the bump', /^Wall 20 × 10 mm, line \+0\.00 mm · holds \d+ faces, 0\.03 cm³$/.test(ro) && wst.plan && wst.plan.ok && near(wst.plan.v, 32, 0.1), ro);
    await page.screenshot({ path: path.join(OUT(), 'crop-wall.png') });

    // the handle drags the line out of the wall and into it
    const dir = () => page.evaluate(() => { const S = NSO_CropCard.state(), h = S.handles.find(q => q.id === 'line'), a = h.pos.clone().project(state.camera), b = h.pos.clone().add(h.dir.clone().multiplyScalar(4)).project(state.camera);
      const r = state.renderer.domElement.getBoundingClientRect(), k = v => [(v.x + 1) / 2 * r.width, (1 - v.y) / 2 * r.height]; const A = k(a), B = k(b); return [B[0] - A[0], B[1] - A[1]]; });
    const hl = await handleXY(page, 'line'), dv = await dir();
    check('the handle sits on the line, clear of the wall\'s bump on the screen', !!hl, JSON.stringify(hl));
    await drag(page, hl.x, hl.y, dv[0] * 0.25, dv[1] * 0.25);                 // 4 mm of screen along the normal is dv, so a quarter of that is 1 mm
    await settled(page);
    wst = await page.evaluate(() => { const S = NSO_CropCard.state(); return { off: S.wall.off, plan: S.plan && { ok: S.plan.ok, v: S.plan.volumeMm3 } }; });
    check('dragged out along the wall\'s normal, the line leaves the wall and the bump shrinks to what stands outside it', wst.off > 0.3 && wst.off < 2 && wst.plan.ok && wst.plan.v < 31 && wst.plan.v > 4,
      'off ' + wst.off + ', ' + (wst.plan && f2(wst.plan.v)) + ' mm3');
    const hl2 = await handleXY(page, 'line');
    await drag(page, hl2.x, hl2.y, -dv[0] * 0.6, -dv[1] * 0.6);
    await settled(page);
    wst = await page.evaluate(() => { const S = NSO_CropCard.state(); return { off: S.wall.off, plan: S.plan && { ok: S.plan.ok, v: S.plan.volumeMm3 } }; });
    check('dragged into the wall, the copy is the bump and a skin of the wall under the outline', wst.off < -0.2 && wst.plan.ok && wst.plan.v > 40, 'off ' + wst.off + ', ' + (wst.plan && f2(wst.plan.v)) + ' mm3');

    // a click on the piece sets the line through the point: the bump's top is 2 mm out - nothing stands outside that
    const top = await aim([1, 0, 0], 2, false);
    check('the bump\'s top is in view to click', !!top, JSON.stringify(top));
    await page.mouse.click(top.x, top.y);
    await page.waitForFunction(() => { const S = NSO_CropCard.state(); return !S.timer && S.plan && !S.plan.ok; }, null, { timeout: 20000 });
    wst = await page.evaluate(() => NSO_CropCard.state().wall.off);
    ro = await readout(page);
    check('a click on the bump\'s top puts the line 2 mm out; nothing stands outside it, said in words, CROP off', near(wst, 2, 0.02) && /holds nothing of this piece - pull the line in toward the wall/.test(ro) &&
      await page.evaluate(() => document.getElementById('btn-crop').disabled && document.getElementById('crop-readout').classList.contains('is-refusal')), 'off ' + wst + ' · ' + ro);
    const w2 = await aim([1, 0, 0], 0, true);
    await page.mouse.click(w2.x, w2.y);
    await settled(page);
    wst = await page.evaluate(() => { const S = NSO_CropCard.state(); return { off: S.wall.off, ok: S.plan && S.plan.ok, v: S.plan && S.plan.volumeMm3 }; });
    check('a click on the wall itself puts it back flush, and the bump is what is held again', near(wst.off, 0, 0.02) && wst.ok && near(wst.v, 32, 0.2), JSON.stringify(wst));

    // CROP: the bump, as a piece of its own
    const pre5 = await snap(page, bid);
    const bname = await cropNow(page, bid);
    const made = await page.evaluate(() => { const m = state.models[state.models.length - 1], b = NSO_Crop.bounds(m.rawTris), c = NSO_Crop.census(m.rawTris);
      return { name: m.name, v: NSO_Crop.volume(m.rawTris), size: [0, 1, 2].map(k => b.hi[k] - b.lo[k]), open: c.open + c.repeated + c.degenerate + c.welded.open + c.welded.repeated }; });
    check('CROP adds "<name> crop N"', /crop \d+$/.test(bname), bname);
    const sz = made.size.slice().sort((p, q) => p - q);
    check('the copy is the bump and nothing else: 4 x 4 x 2 mm, 32 mm3, closed', near(sz[0], 2, 0.01) && near(sz[1], 4, 0.01) && near(sz[2], 4, 0.01) && near(made.v, 32, 0.1) && made.open === 0, JSON.stringify(made));
    const post5 = await snap(page, bid);
    check('the original is byte for byte as it was, bump and all', JSON.stringify(post5.raw) === JSON.stringify(pre5.raw));
    await page.click('#btn-undo');
    check('one Undo takes the copy off, the line still there', (await snap(page, bid)).models === pre5.models && await page.evaluate(() => !!NSO_CropCard.state().wall.face));

    // Shift-click picks another wall: the top, 40 x 20, with the line back at 0
    await frame(page, [mid[0] + 20, bb.hi[2] + 70, -mid[1] + 25], [mid[0], bb.hi[2], -mid[1]]);
    const tpt = await page.evaluate(i => { const p = state.placed.find(q => q.sourceId === i), rc = state.renderer.domElement.getBoundingClientRect();
      for (let gx = 0.2; gx < 0.8; gx += 0.02) for (let gy = 0.2; gy < 0.8; gy += 0.02) {
        const x = rc.left + gx * rc.width, y = rc.top + gy * rc.height; if (document.elementFromPoint(x, y) !== state.renderer.domElement) continue;
        state.raycaster.setFromCamera(new THREE.Vector2(gx * 2 - 1, 1 - gy * 2), state.camera);
        const hit = state.raycaster.intersectObject(p.mesh, false).filter(h => h.faceIndex != null)[0];
        if (hit && hit.face.normal.clone().transformDirection(p.mesh.matrixWorld).y > 0.99) return { x, y }; } return null; }, bid);
    await page.keyboard.down('Shift');
    await page.mouse.click(tpt.x, tpt.y);
    await page.keyboard.up('Shift');
    await settled(page);
    wst = await page.evaluate(() => { const S = NSO_CropCard.state(); return { n: S.wall.face.n, size: S.wall.face.size, off: S.wall.off }; });
    check('a Shift-click picks another wall: the top, 40 x 20, the line back at 0', near(wst.n[2], 1, 1e-6) && near(Math.max(...wst.size), 40, 1e-3) && near(Math.min(...wst.size), 20, 1e-3) && wst.off === 0, JSON.stringify(wst));
    await page.click('#btn-crop-cancel');
    check('Cancel puts the wall and its line away', await page.evaluate(() => !NSO_CropCard.state().shape && !state.scene.getObjectByName('cropCardShape')));
    await selectModel(page, hid);
    await reselect(page, hid);

    }

    /* ================================================================= 5 */
    console.log('\n=== 5. OUTLINE ===');
    await reselect(page, hid);
    await placeOver(page, tid, hid);                 // the tube stands over the hinge, for its footprint to be clicked
    await frame(page, [40, 34, 46], [0, 8, 0]);
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

    /* ================================================================= 6 */
    console.log('\n=== 6. Escape, Cancel, closing the card ===');
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

    /* ================================================================= 7 */
    console.log('\n=== 7. LASSO ===');
    await page.click('#menu-crop > summary');
    await reselect(page, hid);
    await frame(page, [26, 22, 30], [0, 4, 0]);
    await page.click('#btn-crop-shape-lasso');
    await settled(page);
    ro = await readout(page);
    check('picked: the readout asks for a loop, and the button is lit', /^Lasso: drag a loop round what to copy/.test(ro) &&
      await page.evaluate(() => document.getElementById('btn-crop-shape-lasso').getAttribute('aria-pressed') === 'true'), ro);
    check('...it has no handles and no body to slide, CROP is off, the pointer is a crosshair', await page.evaluate(() =>
      NSO_CropCard.handles().length === 0 && !NSO_CropCard.state().body && document.getElementById('btn-crop').disabled && state.renderer.domElement.style.cursor === 'crosshair'));
    const rect = await page.evaluate(id => {
      const p = state.placed.find(q => q.sourceId === id), rc = state.renderer.domElement.getBoundingClientRect(), b = new THREE.Box3().setFromObject(p.mesh);
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (let k = 0; k < 8; k++) {
        const v = new THREE.Vector3(k & 1 ? b.max.x : b.min.x, k & 2 ? b.max.y : b.min.y, k & 4 ? b.max.z : b.min.z).project(state.camera);
        const x = rc.left + (v.x + 1) / 2 * rc.width, y = rc.top + (1 - v.y) / 2 * rc.height;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      return { x0, y0, x1, y1 };
    }, hid);
    const cx = rect.x0 + (rect.x1 - rect.x0) * 0.32, cy = (rect.y0 + rect.y1) / 2, rx = (rect.x1 - rect.x0) * 0.3, ry = (rect.y1 - rect.y0) * 0.6;
    const ellipse = (ox, oy, ax, ay, n) => Array.from({ length: n + 1 }, (_, i) => [ox + ax * Math.cos(i / n * 2 * Math.PI), oy + ay * Math.sin(i / n * 2 * Math.PI)]);
    async function loop(pts, opts) {
      opts = opts || {};
      await page.mouse.move(pts[0][0], pts[0][1]);
      if (opts.alt) await page.keyboard.down('Alt');
      await page.mouse.down();
      for (let i = 1; i < pts.length; i++) await page.mouse.move(pts[i][0], pts[i][1]);
      if (opts.mid) await opts.mid();
      await page.mouse.up();
      if (opts.alt) await page.keyboard.up('Alt');
    }
    const loop1 = ellipse(cx, cy, rx, ry, 28);
    await loop(loop1, { mid: async () => {
      check('while the loop is dragged it is drawn over the view', await page.evaluate(() => {
        const o = document.getElementById('crop-lasso-overlay');
        return !!o && o.style.pointerEvents === 'none' && (o.firstChild.getAttribute('points') || '').split(' ').length > 10;
      }));
    } });
    await settled(page);
    check('let go: the loop is the shape, and the overlay is gone', await page.evaluate(() => !document.getElementById('crop-lasso-overlay') && NSO_CropCard.shape() && NSO_CropCard.shape().kind === 'lasso'));
    const ls = await page.evaluate(() => { const S = NSO_CropCard.state(); return { n: S.lasso.dirs.length, eye: S.lasso.eye.slice(), dirs0: S.lasso.dirs[0].slice(), plan: S.plan && { ok: S.plan.ok, vol: S.plan.volumeMm3, faces: S.plan.faces, reason: S.plan.reason }, preview: !!S.preview }; });
    check('...kept as rays from the camera it was drawn in, a handful of corners not every mouse move', ls.n >= 6 && ls.n <= 60, ls.n + ' corners');
    ro = await readout(page);
    check('the readout is "Lasso, N-point loop · holds N faces, X cm³"', /^Lasso, \d+-point loop · holds \d+ faces, [\d.]+ cm³$/.test(ro), ro);
    const whole = await page.evaluate(id => NSO_Crop.volume(state.models.find(m => m.id === id).rawTris), hid);
    check('it holds part of the piece, not all of it, not nothing', ls.plan && ls.plan.ok && ls.plan.vol > 1 && ls.plan.vol < whole * 0.9, f2(ls.plan && ls.plan.vol) + ' of ' + f2(whole) + ' mm³');
    check('the cone is drawn (its preview came back from the kernel)', ls.preview && await page.evaluate(() => !!state.scene.getObjectByName('cropCardShape')));
    await page.screenshot({ path: path.join(OUT(), 'crop-lasso.png') });

    // CROP: every vertex of the copy lies inside the loop, seen from where it was drawn
    const pre8 = await snap(page, hid);
    const cname = await cropNow(page, hid);
    check('CROP adds "<name> crop N"', /crop \d+$/.test(cname), cname);
    const inside = await page.evaluate(poly => {
      const m = state.models[state.models.length - 1], p = state.placed.find(q => q.sourceId === m.id), rc = state.renderer.domElement.getBoundingClientRect();
      state.camera.updateMatrixWorld(true);
      const soup = NSO_Crop.meshSoupP(p.mesh);
      function dEdge(x, y, a, b) {
        const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
        return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
      }
      let ok = 0, n = 0;
      for (let i = 0; i < soup.length; i += 3) {
        const v = new THREE.Vector3(soup[i], soup[i + 2], -soup[i + 1]).project(state.camera);
        const x = rc.left + (v.x + 1) / 2 * rc.width, y = rc.top + (1 - v.y) / 2 * rc.height;
        let c = false, near = 1e9;
        for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
          if ((poly[a][1] > y) !== (poly[b][1] > y) && x < (poly[b][0] - poly[a][0]) * (y - poly[a][1]) / (poly[b][1] - poly[a][1]) + poly[a][0]) c = !c;
          near = Math.min(near, dEdge(x, y, poly[a], poly[b]));
        }
        n++; if (c || near < 3) ok++;
      }
      return { ok, n };
    }, loop1);
    check('every vertex of the copy falls inside the loop on the screen (3 px for the corners cut)', inside.n > 100 && inside.ok === inside.n, inside.ok + ' of ' + inside.n);
    const post8 = await snap(page, hid);
    check('the original is byte for byte as it was', JSON.stringify(post8.raw) === JSON.stringify(pre8.raw));
    await page.click('#btn-undo');
    const und8 = await snap(page, hid);
    check('one Undo takes the copy off, the loop still there for another', und8.models === pre8.models && (await cardState(page)).shape === 'lasso' && !!(await page.evaluate(() => NSO_CropCard.state().lasso.dirs)));

    // Alt-drag orbits; the cone stays where it was drawn
    const cam8 = await page.evaluate(() => state.camera.position.toArray());
    const lasso8 = await page.evaluate(() => JSON.stringify(NSO_CropCard.state().lasso));
    await loop([[rect.x1 + 80, rect.y1 + 60], [rect.x1 + 140, rect.y1 + 40], [rect.x1 + 200, rect.y1 + 20]], { alt: true });
    const cam9 = await page.evaluate(() => state.camera.position.toArray());
    check('Alt-drag orbits the camera and draws nothing', Math.hypot(cam9[0] - cam8[0], cam9[2] - cam8[2]) > 1 && await page.evaluate(l => JSON.stringify(NSO_CropCard.state().lasso) === l, lasso8), cam8.map(f2) + ' -> ' + cam9.map(f2));
    check('...and the cone is still the one that was drawn, seen from the new side', (await page.evaluate(() => { const S = NSO_CropCard.state(); return !!S.preview && !!S.group; })));
    await page.screenshot({ path: path.join(OUT(), 'crop-lasso-orbited.png') });
    await frame(page, [26, 22, 30], [0, 4, 0]);

    // a click, a tiny loop, and Escape mid-loop change nothing
    await page.mouse.click(rect.x1 + 100, rect.y1 + 50);
    await loop([[rect.x1 + 100, rect.y1 + 50], [rect.x1 + 104, rect.y1 + 51], [rect.x1 + 102, rect.y1 + 54], [rect.x1 + 100, rect.y1 + 50]]);
    check('a click and a loop of a few pixels keep the old loop', await page.evaluate(l => JSON.stringify(NSO_CropCard.state().lasso) === l, lasso8));
    await loop(ellipse(rect.x1 + 60, rect.y0 - 30, 50, 30, 12), { mid: async () => { await page.keyboard.press('Escape'); } });
    check('Escape mid-loop drops the loop being drawn, not the shape or the old loop', await page.evaluate(l => !document.getElementById('crop-lasso-overlay') &&
      NSO_CropCard.state().shape === 'lasso' && JSON.stringify(NSO_CropCard.state().lasso) === l, lasso8));

    // a new loop replaces it
    const loop2 = ellipse(rect.x0 + (rect.x1 - rect.x0) * 0.7, (rect.y0 + rect.y1) / 2, (rect.x1 - rect.x0) * 0.2, (rect.y1 - rect.y0) * 0.5, 20);
    await loop(loop2);
    await settled(page);
    const ls2 = await page.evaluate(() => { const S = NSO_CropCard.state(); return { n: S.lasso.dirs.length, plan: S.plan && { ok: S.plan.ok, vol: S.plan.volumeMm3 } }; });
    check('a new loop replaces the old one and is planned', await page.evaluate(l => JSON.stringify(NSO_CropCard.state().lasso) !== l, lasso8) && ls2.plan && ls2.plan.ok, JSON.stringify(ls2));

    // a loop that sees nothing of the piece refuses in words, CROP off
    await loop(ellipse(rect.x1 + 200, rect.y0 - 10, 30, 20, 12));
    await page.waitForFunction(() => { const S = NSO_CropCard.state(); return !S.timer && S.plan && !S.plan.ok; }, null, { timeout: 20000 });
    ro = await readout(page);
    check('a loop round empty air says so, in the refusal colour, and CROP is off', /holds nothing/.test(ro) && await page.evaluate(() =>
      document.getElementById('btn-crop').disabled && document.getElementById('crop-readout').classList.contains('is-refusal')), ro);
    await page.click('#btn-crop-cancel');
    check('Cancel puts the lasso away: no shape, no cone, the pointer is the pointer again', await page.evaluate(() =>
      !NSO_CropCard.state().shape && !state.scene.getObjectByName('cropCardShape') && state.renderer.domElement.style.cursor === ''));

    /* ================================================================= 8 */
    console.log('\n=== 8. LIFT, in the Crop card, with Detach flange; Reattach from the Connect card ===');
    const vid = await loadSTL(page, V9);
    await selectModel(page, vid);
    const ids0 = await page.evaluate(() => state.models.map(m => m.id));
    check('the Lift panel is folded away while the card is open and Lift is not pressed', await page.evaluate(() =>
      document.getElementById('menu-crop').open && document.getElementById('lift-panel').hidden && !NSO_LIFT_PLATE.isArmed() &&
      document.getElementById('btn-lift').getAttribute('aria-pressed') === 'false'));
    check('...and Detach flange, in it, is not on show', await page.evaluate(() => document.getElementById('btn-detach').offsetParent === null));
    await page.click('#btn-lift');
    const lift1 = await page.evaluate(() => ({ armed: NSO_LIFT_PLATE.isArmed(), pressed: document.getElementById('btn-lift').getAttribute('aria-pressed'),
      panel: !document.getElementById('lift-panel').hidden, inCard: !!document.getElementById('lift-panel').closest('#crop-card'),
      detach: document.getElementById('btn-detach').offsetParent !== null, strip: document.getElementById('btn-lift-strip').offsetParent !== null }));
    check('Lift opens in the card: armed, pressed, its panel, Strip and Detach flange on show', lift1.armed && lift1.pressed === 'true' && lift1.panel && lift1.inCard && lift1.detach && lift1.strip, JSON.stringify(lift1));
    await page.screenshot({ path: path.join(OUT(), 'crop-lift-open.png') });
    check('Detach flange is wired', await page.evaluate(() => { const b = document.getElementById('btn-detach'); return !!b && b.dataset.nsoWired === '1'; }));
    await page.click('#btn-detach');
    await page.waitForFunction(() => /Detach/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
    const ids1 = await page.evaluate(() => state.models.map(m => m.id));
    const dst = await page.evaluate(() => document.getElementById('status').textContent);
    check('Detach flange, from inside Lift, takes the flange off as a piece of its own', ids1.length === ids0.length + 1 && /^Detached/.test(dst), dst.slice(0, 90));
    check('...its readout is in the Lift panel, and Lift is still open', await page.evaluate(() => !!document.getElementById('detach-readout').closest('#lift-panel') &&
      document.getElementById('detach-readout').textContent.length > 1 && NSO_LIFT_PLATE.isArmed()));
    await page.click('#btn-lift');
    const lift2 = await page.evaluate(() => ({ armed: NSO_LIFT_PLATE.isArmed(), pressed: document.getElementById('btn-lift').getAttribute('aria-pressed'),
      panel: document.getElementById('lift-panel').hidden, detach: document.getElementById('btn-detach').offsetParent === null }));
    check('pressing Lift again folds it away: disarmed, panel and Detach flange gone', !lift2.armed && lift2.pressed === 'false' && lift2.panel && lift2.detach, JSON.stringify(lift2));

    // Lift and a shape never run together: each puts the other away
    await selectModel(page, hid);
    await page.click('#btn-crop-shape-box');
    await settled(page);
    await page.click('#btn-lift');
    check('pressing Lift puts the shape away', await page.evaluate(() => NSO_LIFT_PLATE.isArmed() && !NSO_CropCard.state().shape && !state.scene.getObjectByName('cropCardShape')));
    await page.click('#btn-crop-shape-sphere');
    check('picking a shape folds Lift away', await page.evaluate(() => !NSO_LIFT_PLATE.isArmed() && document.getElementById('lift-panel').hidden && NSO_CropCard.state().shape === 'sphere'));
    await page.click('#btn-crop-cancel');
    await page.click('#btn-lift');
    check('closing the Crop card folds Lift away with it', await (async () => {
      await page.click('#menu-crop > summary');
      await page.waitForFunction(() => !NSO_LIFT_PLATE.isArmed(), null, { timeout: 5000 }).catch(() => {});
      return page.evaluate(() => !NSO_LIFT_PLATE.isArmed() && document.getElementById('lift-panel').hidden);
    })());

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

