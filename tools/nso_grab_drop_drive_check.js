#!/usr/bin/env node
/* Grab and drop, and the floating state (app-grab-drop.js) - driven through
   the REAL app in headless Chromium at 1280 x 800.

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
     2. grab it, drop it on the parent's top: seated there at the Seat gap,
        clearance measured on the surfaces; ONE Undo puts it back in the air
     3. the other half, dropped on the plate: on the plate
     4. one dropped over nothing: it stays where it was let go, floating;
        the export writes it at that height
     5. Escape mid-drag: back where it was, nothing on the Undo stack
     6. a floating piece through Move's nudge and Rotate: its height kept
     7. To plate brings it down
     8. guards in words: onto a support piece, onto itself
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

  /* =========================================== 3. the other, on the plate */
  console.log('\n=== 3. half B, dropped on the plate ===');
  const B0 = await piece(page, idB);
  const bedPoint = await page.evaluate(id => {
    const bb = new THREE.Box3().setFromObject(state.placed.find(q => q && q.sourceId === id).mesh);
    return [bb.max.x + 25, 0, (bb.min.z + bb.max.z) / 2];
  }, plateId);
  const u3 = (await plateState(page)).undo;
  await carry(page, await screenOf(page, leafTop(B0)), await screenOf(page, bedPoint), { hold: true });
  const g3 = await grabState(page);
  check('carried over the bed: it says it will set it down there', g3.mode === 'plate' && /^Over the plate - let go to set/.test(g3.status), g3.status);
  await page.mouse.up();
  await page.waitForTimeout(250);
  const B1 = await piece(page, idB);
  check('let go: on the plate - its bottom on the bed, liftY 0', Math.abs(B1.min[1] - 0.2) < 1e-6 && B1.liftY === 0, 'bottom ' + B1.min[1].toFixed(4));
  check('...near the point it was let go at, clear of the parent', Math.abs(B1.x - bedPoint[0]) < 12 && B1.min[0] > (await piece(page, plateId)).max[0],
    'x ' + B1.x.toFixed(2) + ' for ' + bedPoint[0].toFixed(2));
  check('...one Undo step, said in words', (await plateState(page)).undo === u3 + 1 && /^Set down on the plate, from 3\.\d\d mm up/.test(await status(page)), await status(page));

  /* ========================================= 4. over nothing: it floats */
  console.log('\n=== 4. dropped over nothing: it stays where it was let go ===');
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

  /* ================================================= 5. Escape mid-drag */
  console.log('\n=== 5. Escape mid-drag puts it back ===');
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

  /* ================================= 6. nudge and Rotate keep the height */
  console.log('\n=== 6. a floating piece through Move\'s nudge and Rotate ===');
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

  /* ======================================================= 7. To plate */
  console.log('\n=== 7. To plate brings it down ===');
  await page.click('#btn-to-plate');
  const T7 = await piece(page, idB);
  check('To plate: on the bed, liftY 0', Math.abs(T7.min[1] - 0.2) < 1e-6 && T7.liftY === 0, await status(page));
  await closeTopMenus(page);

  /* =================================================== 8. guards in words */
  console.log('\n=== 8. guards: a support piece, itself ===');
  await page.evaluate(ids => {               // both in view, from above and in front
    const bb = new THREE.Box3();
    ids.forEach(id => bb.union(new THREE.Box3().setFromObject(state.placed.find(q => q && q.sourceId === id).mesh)));
    const c = bb.getCenter(new THREE.Vector3()), span = Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
    state.controls.target.copy(c);
    state.camera.position.set(c.x, c.y + span * 1.2, c.z + span * 0.5);
    state.controls.update();
  }, [plateId, idB]);
  await page.waitForTimeout(250);
  await page.evaluate(id => { state.models.find(m => m.id === id).nsoSupport = { style: 'tree' }; }, plateId);
  const B8 = await piece(page, idB), u8 = (await plateState(page)).undo;
  const B8s = await screenOf(page, [(B8.min[0] + B8.max[0]) / 2, B8.max[1], (B8.min[2] + B8.max[2]) / 2]);
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

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l) && !/favicon|404/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
}).then(() => {
  console.log('\n' + C.passes + ' passed, ' + C.fails + ' failed');
  if (KEEP) console.log('screenshots in ' + path.relative(ROOT, OUT));
  if (C.fails) { console.log('FAILED: ' + C.failed.join('; ')); process.exit(1); }
}).catch(err => { console.error(err); process.exit(1); });
