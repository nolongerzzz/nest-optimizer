#!/usr/bin/env node
/* A plate drag is flat (Move), and Lift's drop is the one grab (app-grab-drop.js) - driven
   through the REAL app in headless Chromium at 1280 x 800.

     node tools/nso_grab_drop_drive_check.js                     exit 0 = every gate held
     node tools/nso_grab_drop_drive_check.js tools/grab-drop-out ...and keep the screenshots
                                                                (gitignored, never committed)

   The fixture is generated (tools/nso_lift_plate_fixtures.js, the hinge
   plate: a slab carrying two hinge halves) and goes in through the app's own
   Import. Every grab is a real press on the main canvas, every carry a run
   of real pointer moves, every drop a real release; every button is a real
   click.

     1. Lift a hinge half: it ends in the air (on the leftover slab, 3 mm
        over the bed) and stays there
     2. Lift's drop: grab it, drop it on the parent's top: seated there at the
        Seat gap, clearance measured on the surfaces; ONE Undo puts it back in the air
     3. the other half, dropped over nothing: it stays where it was let go, floating;
        the export writes it at that height
     4. Escape mid-drag: back where it was, nothing on the Undo stack
     5. a floating piece through Move's nudge and Rotate: its height kept
     6. guards in words: onto a support piece, onto itself
     7. To plate brings it down
     8. half A, Lift's drop onto the plate: it rests on it, one Undo
     9. Move is flat: an ordinary piece dragged across the parent (a plain drag, no
        grab, no ray, no helper, its height never touched) lands where it is let go
        with its lowest point on the plate, overlapping the parent, one Undo
    10. a floating ordinary piece, turned: the same flat drag keeps its height; no
        ray on a pointer move, no vertex read from the press to the release;
        Escape puts it back
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { withApp, loadSTL, closeTopMenus, ROOT } = require('./nso_app_harness');
const { writeSTL } = require('./nso_stl_io.js');
const FX = require('./nso_lift_plate_fixtures.js');
const L = require('./nso_lift_plate_drive_lib.js');
const { rawTriNear, status, plateState, ctrlZ, waitRead, selectRow, frameOn } = L;
const C = L.makeCheck(), check = C.check;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-grab-drop-drive-'));
const KEEP = !!process.argv[2];
const OUT = KEEP ? path.resolve(process.argv[2]) : path.join(TMP, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const HG = FX.hinge();
const HG_STL = path.join(TMP, 'hinge-plate.stl');
writeSTL(HG_STL, HG.soup);
const T_A = rawTriNear(HG.soup, 12, 20, 4.15, 4.25);       // the top of half A's leaf
const T_B = rawTriNear(HG.soup, 52, 20, 4.15, 4.25);       // the top of half B's leaf

const shot = L.shooter(OUT, KEEP, ROOT).plate;

/* A piece as drawn: world box, the record, its index. */
const piece = (page, id) => page.evaluate(id => {
  const i = state.placed.findIndex(q => q && q.sourceId === id), p = state.placed[i];
  if (!p) return null;
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return { i, min: bb.min.toArray(), max: bb.max.toArray(), liftY: p.liftY || 0, x: p.x, z: p.z,
           pos: p.mesh.position.toArray(), quat: p.mesh.quaternion.toArray(),
           body: nsoPieceBodyQ(p).toArray() };
}, id);
const near = (a, b, tol) => a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) <= tol);
const samePlace = (a, b, tol) => a && b && near(a.min, b.min, tol) && near(a.max, b.max, tol) && Math.abs(a.liftY - b.liftY) <= tol;
/* The screen point of a world point. */
const screenOf = (page, w) => page.evaluate(w => {
  state.camera.updateMatrixWorld(true);
  const q = new THREE.Vector3(w[0], w[1], w[2]).project(state.camera), r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height };
}, w);
/* The top of a lifted half's leaf, in the world: its box centre (the leaf
   spans it), 1.2 mm over its bottom. */
const leafTop = p => [(p.min[0] + p.max[0]) / 2 - 3, p.min[1] + 1.2, (p.min[2] + p.max[2]) / 2];
/* Where the parent's raw point (x, y, z) is drawn. */
const parentPoint = (page, id, r) => page.evaluate(([id, r]) => {
  const p = state.placed.find(q => q && q.sourceId === id), m = state.models.find(q => q.id === id), c = m.centerOffset;
  p.mesh.updateMatrixWorld(true);
  return p.mesh.localToWorld(new THREE.Vector3(r[0] - c.x, r[2] - c.y, -r[1] - c.z)).toArray();
}, [id, r]);
/* A screen point that lands on the piece (the first thing the ray meets), nearest the middle of where it is drawn. */
const pointOn = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id), r = state.renderer.domElement.getBoundingClientRect();
  p.mesh.updateMatrixWorld(true); state.camera.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh), lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (let i = 0; i < 8; i++) {
    const v = new THREE.Vector3(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).project(state.camera);
    lo[0] = Math.min(lo[0], v.x); hi[0] = Math.max(hi[0], v.x); lo[1] = Math.min(lo[1], v.y); hi[1] = Math.max(hi[1], v.y);
  }
  const rc = new THREE.Raycaster(), cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
  let best = null;
  for (let a = 0; a <= 24; a++) for (let b = 0; b <= 24; b++) {
    const x = lo[0] + (hi[0] - lo[0]) * a / 24, y = lo[1] + (hi[1] - lo[1]) * b / 24;
    rc.setFromCamera({ x, y }, state.camera);
    const h = rc.intersectObjects(state.modelGroup.children, false)[0];
    if (!h || h.object !== p.mesh) continue;
    if (r.top + (1 - y) / 2 * r.height < 140) continue;       // under the top bar a press never reaches the canvas
    const d = Math.hypot(x - cx, y - cy);
    if (!best || d < best.d) best = { d, x, y };
  }
  return best ? { x: r.left + (best.x + 1) / 2 * r.width, y: r.top + (1 - best.y) / 2 * r.height } : null;
}, id);
/* Press at screen point a, carry to b in steps, and (unless `hold`) let go. */
async function carry(page, a, b, opts) {
  opts = opts || {};
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  const n = opts.steps || 12;
  for (let k = 1; k <= n; k++) {
    await page.mouse.move(a.x + (b.x - a.x) * k / n, a.y + (b.y - a.y) * k / n);
    await page.waitForTimeout(15);
  }
  await page.waitForTimeout(120);
  if (!opts.hold) { await page.mouse.up(); await page.waitForTimeout(250); }
}
const grabState = page => page.evaluate(() => ({ active: nsoGrab.active(), mode: nsoGrab.mode(), over: nsoGrab.over(), status: document.getElementById('status').textContent }));
/* The true minimum distance between two pieces as drawn. */
const clearance = (page, a, b) => page.evaluate(([a, b]) => {
  const pa = state.placed.find(q => q && q.sourceId === a), pb = state.placed.find(q => q && q.sourceId === b);
  const sa = meshToWorldSoup(pa.mesh), sb = meshToWorldSoup(pb.mesh);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < sb.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], sb[i + k]); hi[k] = Math.max(hi[k], sb[i + k]); }
  return NSO_SeatSurface.minDistance(NSO_SeatSurface.cullNear(sa, { lo, hi }, 3), sb);
}, [a, b]);

withApp(async (page, logs) => {
  await page.setViewportSize({ width: 1280, height: 800 });

  /* =================================================== 1. lift, in the air */
  console.log('\n=== 1. lift a hinge half: it ends in the air, and stays ===');
  const plateId = await loadSTL(page, HG_STL);
  await L.armOn(page, plateId);
  check('Lift finds the two hinge halves', (await L.card(page)).count === '2 features found', (await L.card(page)).count);
  await frameOn(page, plateId, 1.1);
  const fA = await L.featureOf(page, T_A), fB = await L.featureOf(page, T_B);
  const boxA = await page.evaluate(([id, f]) => {
    const p = state.placed.find(q => q && q.sourceId === id), P = p.mesh.geometry.attributes.position.array, bb = new THREE.Box3(), v = new THREE.Vector3();
    p.mesh.updateMatrixWorld(true);
    NSO_LIFT_PLATE.analysis().islands[f].tris.forEach(t => { for (let k = 0; k < 3; k++) bb.expandByPoint(v.set(P[t * 9 + k * 3], P[t * 9 + k * 3 + 1], P[t * 9 + k * 3 + 2]).applyMatrix4(p.mesh.matrixWorld)); });
    return { min: bb.min.toArray(), max: bb.max.toArray() };
  }, [plateId, fA]);
  const bed = (await piece(page, plateId)).min[1];
  let b1 = await plateState(page);
  await L.clickTri(page, plateId, T_A);
  await waitRead(page, /Lifted|refused|failed/);
  let a1 = await plateState(page);
  const idA = L.added(b1, a1)[0].id;
  const A1 = await piece(page, idA);
  check('half A lifts where it stood: the box the plate drew it in', near(A1.min, boxA.min, 1e-3) && near(A1.max, boxA.max, 1e-3),
    JSON.stringify(A1.min.map(v => +v.toFixed(3))));
  check('...in the air: its bottom 3 mm over the plate\'s, liftY says how far over the bed', Math.abs(A1.min[1] - bed - HG.paper) < 1e-3 &&
    Math.abs(A1.liftY - (A1.min[1] - 0.2)) < 1e-6 && A1.liftY > 3, 'liftY ' + A1.liftY.toFixed(3));
  b1 = a1;
  await L.clickTri(page, plateId, T_B);
  await waitRead(page, /Lifted 1 feature off hinge-plate.*\. 0 features left/);
  a1 = await plateState(page);
  const idB = L.added(b1, a1)[0].id;
  await L.disarm(page);
  await closeTopMenus(page);
  await selectRow(page, plateId);
  await page.evaluate(() => { renderModelList(); updateAdjustUI(); });
  await page.waitForTimeout(200);
  check('it stays there: Lift off, the plate selected and redrawn, half A has not moved', samePlace(await piece(page, idA), A1, 1e-9));

  /* ====================================== 2. drop it on the parent's top */
  console.log('\n=== 2. grab half A, drop it on the parent\'s top ===');
  await frameOn(page, plateId, 1.1);
  const A2 = await piece(page, idA);
  const from = await screenOf(page, leafTop(A2));
  const onTop = await parentPoint(page, plateId, [32, 30, HG.paper]);
  const to = await screenOf(page, onTop);
  const u2 = (await plateState(page)).undo;
  await carry(page, from, to, { hold: true });
  const g2 = await grabState(page);
  check('carried over the parent: the grab says it will seat there, at the Seat gap', g2.active && g2.mode === 'piece' && g2.over === plateId &&
    /Over "hinge-plate" - let go to seat "hinge-plate - lifted \d+" there at the Seat gap \(-0\.18 mm\)/.test(g2.status), g2.status);
  check('...the target boxed in green, the drop point marked', await page.evaluate(() => nsoGrab.layer().children.length === 2 &&
    nsoGrab.layer().children.every(c => c.material.color.getHex() === 0x22c55e)));
  await shot(page, '1-mid-drag-over-a-piece');
  await page.mouse.up();
  await page.waitForTimeout(300);
  const s2 = await status(page), A3 = await piece(page, idA), top = (await piece(page, plateId)).max[1];
  const gap2 = await clearance(page, plateId, idA);
  check('let go: seated on the parent, said in words', /^Dropped onto "hinge-plate": seated on the \w+ at that point - air gap 0\.18mm/.test(s2) && /One Undo/.test(s2), s2.slice(0, 200));
  check('...outside its top at the Seat gap: clearance 0.18 mm, measured on the surfaces', Math.abs(gap2 - 0.18) < 1e-3 && Math.abs(A3.min[1] - top - 0.18) < 1e-3,
    'clearance ' + gap2.toFixed(4) + ', bottom ' + (A3.min[1] - top).toFixed(4) + ' over the top');
  check('...over the point it was let go at', Math.abs((A3.min[0] + A3.max[0]) / 2 - onTop[0]) < 0.05 && Math.abs((A3.min[2] + A3.max[2]) / 2 - onTop[2]) < 0.05);
  check('...not fused: still two pieces', (await plateState(page)).models.length === a1.models.length);
  check('the drop is ONE Undo step', (await plateState(page)).undo === u2 + 1, u2 + ' -> ' + (await plateState(page)).undo);
  await page.evaluate(() => { clearSelectionOutline(); state.selectedIndex = -1; });
  await shot(page, '2-after-the-drop');
  await ctrlZ(page);
  check('one Ctrl+Z: back in the air where it was lifted', samePlace(await piece(page, idA), A2, 1e-6) && (await plateState(page)).undo === u2);
  await carry(page, from, to);
  check('dropped there again for the rest of the run', Math.abs(await clearance(page, plateId, idA) - 0.18) < 1e-3);

  /* ========================================= 3. over nothing: it floats */
  console.log('\n=== 3. half B, dropped over nothing: it stays where it was let go ===');
  await page.evaluate(id => {                // a low view: sky above the bed
    const p = state.placed.find(q => q && q.sourceId === id), c = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3());
    state.controls.target.copy(c);
    state.camera.position.set(c.x, c.y + 18, c.z + 90);
    state.controls.update();
  }, idB);
  await page.waitForTimeout(250);
  const B2 = await piece(page, idB);
  const fromB = await screenOf(page, [(B2.min[0] + B2.max[0]) / 2 + 3, B2.min[1] + 1.2, B2.max[2]]);
  const sky = { x: fromB.x + 40, y: 120 };
  const u4 = (await plateState(page)).undo;
  await carry(page, fromB, sky, { hold: true });
  const g4 = await grabState(page), held = await piece(page, idB);
  check('carried over nothing: it follows the pointer into the air', g4.mode === 'air' && /^Over nothing - let go to leave/.test(g4.status) && held.liftY > 5,
    g4.mode + ', ' + held.liftY.toFixed(2) + ' mm up');
  await page.mouse.up();
  await page.waitForTimeout(250);
  const B3 = await piece(page, idB);
  check('let go: its position is unchanged - where it was let go, floating', samePlace(B3, held, 1e-9) && near(B3.pos, held.pos, 1e-9), 'liftY ' + B3.liftY.toFixed(3));
  check('...its bottom is 0.2 + liftY, the floating state\'s one rule', Math.abs(B3.min[1] - 0.2 - B3.liftY) < 1e-6);
  check('...one Undo step, said in words', (await plateState(page)).undo === u4 + 1 && /left in the air, \d+\.\d\d mm over the bed - it stays there/.test(await status(page)), await status(page));
  const ex4 = await page.evaluate(id => {
    const ex = nsoHelpers.exportable(state.placed), o = buildPlacedObjects3MF()[ex.findIndex(q => q.sourceId === id)];
    let lo = Infinity; for (let i = 2; i < o.vertices.length; i += 3) lo = Math.min(lo, o.vertices[i]);
    return lo;
  }, idB);
  check('the export writes it at its height, like any piece', Math.abs(ex4 - B3.liftY) < 1e-3, 'lowest Z ' + ex4.toFixed(3) + ' for liftY ' + B3.liftY.toFixed(3));
  const B3s = await screenOf(page, [(B3.min[0] + B3.max[0]) / 2, (B3.min[1] + B3.max[1]) / 2, (B3.min[2] + B3.max[2]) / 2]);
  await page.mouse.move(B3s.x, B3s.y); await page.mouse.down(); await page.mouse.move(B3s.x + 1, B3s.y); await page.waitForTimeout(80);
  check('...and still grabbable', await page.evaluate(() => nsoGrab.active()));
  await page.mouse.up();
  await page.waitForTimeout(150);
  check('...a press and let go without carrying it moves nothing', samePlace(await piece(page, idB), B3, 1e-9) && (await plateState(page)).undo === u4 + 1);

  /* ================================================= 4. Escape mid-drag */
  console.log('\n=== 4. Escape mid-drag puts it back ===');
  await carry(page, B3s, { x: B3s.x - 160, y: B3s.y + 140 }, { hold: true });
  const moved5 = await piece(page, idB);
  check('mid-drag it has moved', !samePlace(moved5, B3, 1e-3) && (await grabState(page)).active);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const B5 = await piece(page, idB);
  check('Escape: back exactly where it was picked up, nothing on the Undo stack', samePlace(B5, B3, 1e-9) && near(B5.pos, B3.pos, 1e-9) &&
    (await plateState(page)).undo === u4 + 1 && !(await page.evaluate(() => nsoGrab.active())), await status(page));
  await page.mouse.up();
  await page.waitForTimeout(150);
  check('...and the release after it changes nothing', samePlace(await piece(page, idB), B3, 1e-9) && (await plateState(page)).undo === u4 + 1);

  /* ================================= 5. nudge and Rotate keep the height */
  console.log('\n=== 5. a floating piece through Move\'s nudge and Rotate ===');
  await selectRow(page, idB);
  const h0 = (await piece(page, idB)).min[1];
  await page.click('#btn-nudge-right');
  const N6 = await piece(page, idB);
  check('Move nudge: it moves across, its height unchanged', N6.x > B3.x + 0.5 && Math.abs(N6.min[1] - h0) < 1e-6 && Math.abs(N6.liftY - B3.liftY) < 1e-9,
    'x +' + (N6.x - B3.x).toFixed(2) + ', bottom ' + N6.min[1].toFixed(4) + ' (was ' + h0.toFixed(4) + ')');
  await page.click('#btn-rot-right');
  const R6 = await piece(page, idB);
  /* re-pinned (pose-bake): "it turns" is read off the BODY - the 90 is baked
     into the geometry when it ends, so the mesh's own turn is identity again */
  check('Rotate 90°: it turns, its height unchanged', !near(R6.body, N6.body, 1e-3) && Math.abs(R6.min[1] - h0) < 1e-6 && Math.abs(R6.liftY - B3.liftY) < 1e-9,
    'bottom ' + R6.min[1].toFixed(4) + ', body turned ' + !near(R6.body, N6.body, 1e-3));
  await closeTopMenus(page);

  /* =================================================== 6. guards in words */
  console.log('\n=== 6. guards: a support piece, itself ===');
  await page.evaluate(ids => {               // both in view, from above and in front
    const bb = new THREE.Box3();
    ids.forEach(id => bb.union(new THREE.Box3().setFromObject(state.placed.find(q => q && q.sourceId === id).mesh)));
    const c = bb.getCenter(new THREE.Vector3()), span = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
    state.controls.target.copy(c);
    state.camera.position.set(c.x, c.y + span * 1.7, c.z + span * 0.12);
    state.controls.update();
  }, [plateId, idB]);
  await page.waitForTimeout(250);
  await page.evaluate(id => { state.models.find(m => m.id === id).nsoSupport = { style: 'tree' }; }, plateId);
  const B8 = await piece(page, idB), u8 = (await plateState(page)).undo;
  const B8s = await pointOn(page, idB);
  await carry(page, B8s, await screenOf(page, await parentPoint(page, plateId, [50, 20, HG.paper])), { hold: true });
  const g8 = await grabState(page);
  check('over a support piece: refused before the drop, the target boxed red', g8.mode === 'piece' && /is a support piece - nothing is dropped onto a support/.test(g8.status) &&
    await page.evaluate(() => nsoGrab.layer().children.every(c => c.material.color.getHex() === 0xef4444)), g8.status);
  await page.mouse.up();
  await page.waitForTimeout(200);
  check('let go: refused in words, back where it was, nothing on the Undo stack', samePlace(await piece(page, idB), B8, 1e-9) && (await plateState(page)).undo === u8 &&
    /^"hinge-plate" is a support piece - nothing is dropped onto a support\. "hinge-plate - lifted \d+" is back where it was\./.test(await status(page)), await status(page));
  await page.evaluate(id => { delete state.models.find(m => m.id === id).nsoSupport; }, plateId);
  const self = await page.evaluate(id => {
    const p = state.placed.find(q => q && q.sourceId === id), bb = new THREE.Box3().setFromObject(p.mesh);
    return NSO_seatPieceAt(p, [bb.max.x, bb.max.y, bb.max.z], p).reason;
  }, idB);
  check('onto itself: refused in words, nothing moved', self === 'onto itself' && /cannot be dropped onto itself/.test(await status(page)) &&
    samePlace(await piece(page, idB), B8, 1e-9) && (await plateState(page)).undo === u8, await status(page));

/* ======================================================= 7. To plate */
  console.log('\n=== 7. To plate brings it down ===');
  await page.click('#btn-to-plate');
  const T7 = await piece(page, idB);
  check('To plate: on the bed, liftY 0', Math.abs(T7.min[1] - 0.2) < 1e-6 && T7.liftY === 0, await status(page));
  await closeTopMenus(page);

  /* ===================== 8. half A, Lift's drop onto the plate */
  console.log('\n=== 8. half A (seated on the parent, still Lift\'s), dropped on the plate ===');
  await frameOn(page, plateId, 1.1);
  const A8 = await piece(page, idA);
  const bedPoint = await page.evaluate(id => {
    const bb = new THREE.Box3().setFromObject(state.placed.find(q => q && q.sourceId === id).mesh);
    return [bb.max.x + 25, 0, (bb.min.z + bb.max.z) / 2];
  }, plateId);
  const u8b = (await plateState(page)).undo;
  await carry(page, await screenOf(page, leafTop(A8)), await screenOf(page, bedPoint), { hold: true });
  const g8b = await grabState(page);
  check('carried over the bed: it says it will set it down there', g8b.mode === 'plate' && /^Over the plate - let go to set/.test(g8b.status), g8b.status);
  await page.mouse.up();
  await page.waitForTimeout(250);
  const A8b = await piece(page, idA);
  check('let go: on the plate - its bottom on the bed, liftY 0', Math.abs(A8b.min[1] - 0.2) < 1e-6 && A8b.liftY === 0, 'bottom ' + A8b.min[1].toFixed(4));
  check('...near the point it was let go at, clear of the parent', Math.abs(A8b.x - bedPoint[0]) < 12 && A8b.min[0] > (await piece(page, plateId)).max[0],
    'x ' + A8b.x.toFixed(2) + ' for ' + bedPoint[0].toFixed(2));
  check('...one Undo step, said in words', (await plateState(page)).undo === u8b + 1 && /^Set down on the plate, from \d+\.\d\d mm up/.test(await status(page)), await status(page));
  await ctrlZ(page);
  check('one Ctrl+Z: back on the parent where the first drop left it', samePlace(await piece(page, idA), A8, 1e-6) && (await plateState(page)).undo === u8b);
  check('...and still Lift\'s: grabbed again it is carried by the grab', await (async () => {
    const at = await screenOf(page, leafTop(A8));
    await page.mouse.move(at.x, at.y); await page.mouse.down(); await page.mouse.move(at.x + 8, at.y + 2); await page.waitForTimeout(80);
    const on = await page.evaluate(() => nsoGrab.active());
    await page.keyboard.press('Escape'); await page.mouse.up(); await page.waitForTimeout(120);
    return on;
  })());
  await carry(page, await screenOf(page, leafTop(A8)), await screenOf(page, bedPoint));
  check('...and set down on the plate again for the rest of the run', Math.abs((await piece(page, idA)).min[1] - 0.2) < 1e-6);

  /* ================================= 9. Move is flat */
  console.log('\n=== 9. Move is flat: an ordinary piece dragged across the parent ===');
  const Pq = await piece(page, plateId);
  await page.evaluate(([id, pid]) => {         // both in view, from above and in front
    const bb = new THREE.Box3();
    [id, pid].forEach(i => bb.union(new THREE.Box3().setFromObject(state.placed.find(q => q && q.sourceId === i).mesh)));
    const c = bb.getCenter(new THREE.Vector3()), span = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
    state.controls.target.copy(c);
    state.camera.position.set(c.x, c.y + span * 1.1, c.z + span * 0.55);
    state.controls.update();
    state.camera.updateMatrixWorld(true);
  }, [idA, plateId]);
  await page.waitForTimeout(250);
  const A9 = await piece(page, idA);
  const pStart = await screenOf(page, [(A9.min[0] + A9.max[0]) / 2, A9.max[1], (A9.min[2] + A9.max[2]) / 2]);
  const parentMid = [(Pq.min[0] + Pq.max[0]) / 2, Pq.max[1], (Pq.min[2] + Pq.max[2]) / 2];
  const pEnd = await screenOf(page, [parentMid[0] - 6, Pq.max[1], parentMid[2]]);
  const u9 = (await plateState(page)).undo;
  await page.mouse.move(pStart.x, pStart.y);
  await page.mouse.down();
  await page.mouse.move(pStart.x + 1, pStart.y);
  await page.evaluate(() => {                  // every ray the drag asks for, with who asked
    window.__rc = [];
    const R = THREE.Raycaster.prototype;
    ['intersectObject', 'intersectObjects'].forEach(k => {
      const o = R[k]; R['__orig_' + k] = o;
      R[k] = function () { window.__rc.push(new Error().stack); return o.apply(this, arguments); };
    });
  });
  const samples = [], N9 = 24;
  for (let k = 1; k <= N9; k++) {
    await page.mouse.move(pStart.x + (pEnd.x - pStart.x) * k / N9, pStart.y + (pEnd.y - pStart.y) * k / N9);
    samples.push(await page.evaluate(([id, pid]) => {
      const p = state.placed.find(q => q && q.sourceId === id), par = state.placed.find(q => q && q.sourceId === pid);
      par.mesh.updateMatrixWorld(true);
      const hit = new THREE.Raycaster(); hit.setFromCamera(state.pointer, state.camera);
      return { y: p.mesh.position.y, liftY: p.liftY || 0, x: p.x, active: nsoGrab.active(),
               helper: !!(nsoGrab.layer() && nsoGrab.layer().parent), overParent: hit.intersectObject(par.mesh, false).length > 0 };
    }, [idA, plateId]));
  }
  const midStatus = await status(page);
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(250);
  const rays = await page.evaluate(() => {
    const R = THREE.Raycaster.prototype;
    ['intersectObject', 'intersectObjects'].forEach(k => { R[k] = R['__orig_' + k]; delete R['__orig_' + k]; });
    return window.__rc;
  });
  const A9e = await piece(page, idA);
  const y0 = A9.pos[1];
  check('the pointer did cross the parent', samples.some(s => s.overParent), samples.filter(s => s.overParent).length + ' of ' + N9 + ' moves');
  check('a plain drag: no grab live, no helper in the scene, at any move', samples.every(s => !s.active && !s.helper) && !/Over "hinge-plate"/.test(midStatus), midStatus);
  check('its height is never touched mid-drag', samples.every(s => s.y === y0 && s.liftY === 0), 'y ' + y0.toFixed(4));
  check('it follows the pointer across: x moves every step the pointer does', samples.every((s, k) => k === 0 || s.x < samples[k - 1].x + 1e-9) && samples[N9 - 1].x < A9.x - 20,
    'x ' + A9.x.toFixed(1) + ' -> ' + samples[N9 - 1].x.toFixed(1));
  check('no ray on a pointer move, none on the release', rays.filter(s => /dragMovePlaced|endMoveDrag|resolveDragPose|app-grab-drop/.test(s)).length === 0, rays.length + ' ray(s) at all');
  const overlap = A9e.min[0] < Pq.max[0] && A9e.max[0] > Pq.min[0] && A9e.min[2] < Pq.max[2] && A9e.max[2] > Pq.min[2];
  check('let go over the parent: it lands there, overlapping it - nothing checks', overlap, 'x ' + A9e.x.toFixed(1) + ', parent ' + Pq.min[0].toFixed(1) + '..' + Pq.max[0].toFixed(1));
  check('...its lowest point on the plate: it did not climb onto the parent', Math.abs(A9e.min[1] - 0.2) < 1e-6 && A9e.liftY === 0, 'bottom ' + A9e.min[1].toFixed(4));
  check('...one Undo step, said as a move', (await plateState(page)).undo === u9 + 1 && /^Moved model/.test(await status(page)), await status(page));
  await ctrlZ(page);
  check('one Ctrl+Z: back where it was picked up', samePlace(await piece(page, idA), A9, 1e-6) && (await plateState(page)).undo === u9);

  /* ======== 10. a floating ordinary piece, turned: height kept, nothing read */
  console.log('\n=== 10. a floating ordinary piece, turned: the flat drag keeps its height and reads nothing ===');
  const bit = await loadSTL(page, path.join(ROOT, 'library', 'box_bit_12x8x8.stl'));
  await page.evaluate(id => {                  // turned off-axis, 5 mm up: no shortcut for its bounds
    const p = state.placed.find(q => q && q.sourceId === id);
    p.rotY = 0.5; p.liftY = 5; applyMeshRotation(p); p.mesh.updateMatrixWorld(true);
    state.selectedIndex = -1;
  }, bit);
  await frameOn(page, bit, 1.1);
  const T0 = await piece(page, bit);
  const tStart = await screenOf(page, [(T0.min[0] + T0.max[0]) / 2, T0.max[1], (T0.min[2] + T0.max[2]) / 2]);
  const tEnd = await screenOf(page, [(T0.min[0] + T0.max[0]) / 2 + 14, T0.max[1], (T0.min[2] + T0.max[2]) / 2 + 9]);
  const u10 = (await plateState(page)).undo;
  await page.mouse.move(tStart.x, tStart.y);
  await page.mouse.down();
  await page.mouse.move(tStart.x + 1, tStart.y);
  await page.evaluate(id => {                  // every read of the piece's vertices from here to the release
    const a = state.placed.find(q => q && q.sourceId === id).mesh.geometry.attributes.position, arr = a.array;
    window.__reads = 0;
    Object.defineProperty(a, 'array', { get() { window.__reads++; return arr; }, configurable: true });
  }, bit);
  const ys = [];
  for (let k = 1; k <= 16; k++) {
    await page.mouse.move(tStart.x + (tEnd.x - tStart.x) * k / 16, tStart.y + (tEnd.y - tStart.y) * k / 16);
    ys.push(await page.evaluate(id => state.placed.find(q => q && q.sourceId === id).mesh.position.y, bit));
  }
  const moved10 = await piece(page, bit);
  check('mid-drag: it has moved across and its height has not', Math.hypot(moved10.x - T0.x, moved10.z - T0.z) > 5 && ys.every(y => y === T0.pos[1]), 'y ' + T0.pos[1].toFixed(4));
  check('...a plain drag, not the grab', !(await page.evaluate(() => nsoGrab.active())));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const E10 = await piece(page, bit);
  check('Escape: back exactly where it was picked up, nothing on the Undo stack', samePlace(E10, T0, 1e-9) && near(E10.pos, T0.pos, 1e-9) && (await plateState(page)).undo === u10 && !(await page.evaluate(() => state.moveDragging)), await status(page));
  await page.mouse.up();
  await page.waitForTimeout(100);
  await page.mouse.move(tStart.x, tStart.y);
  await page.mouse.down();
  await page.mouse.move(tStart.x + 1, tStart.y);
  await page.evaluate(() => { window.__reads = 0; });
  for (let k = 1; k <= 16; k++) await page.mouse.move(tStart.x + (tEnd.x - tStart.x) * k / 16, tStart.y + (tEnd.y - tStart.y) * k / 16);
  await page.mouse.up();
  await page.waitForTimeout(250);
  const reads = await page.evaluate(() => window.__reads);
  const T1 = await piece(page, bit);
  check('press-to-release: the piece\'s vertices are not read - the pose bounds are the cache\'s', reads === 0, reads + ' read(s)');
  check('let go: it keeps its height - lowest point 0.2 + liftY, liftY 5', Math.abs(T1.liftY - 5) < 1e-9 && Math.abs(T1.min[1] - 5.2) < 1e-4, 'bottom ' + T1.min[1].toFixed(4));
  check('...one Undo step, said as a move', (await plateState(page)).undo === u10 + 1 && /^Moved model/.test(await status(page)), await status(page));
  const probe = await page.evaluate(id => {    // the spy sees a scan when there is one
    const p = state.placed.find(q => q && q.sourceId === id);
    window.__reads = 0; nsoInvalidatePieceBounds(p); meshLocalBox3(p.mesh);
    return window.__reads;
  }, bit);
  check('(control) the spy does see a vertex scan when the bounds are forgotten', probe > 0, probe + ' read(s)');

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/favicon|404/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log('\n' + C.passes + ' passed, ' + C.fails + ' failed');
  if (KEEP) console.log('screenshots in ' + path.relative(ROOT, OUT));
  if (C.fails) { console.log('FAILED: ' + C.failed.join('; ')); process.exit(1); }
}).catch(err => { console.error(err); process.exit(1); });
