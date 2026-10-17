/* To plate: put a piece back down on the bed, in one press.
     node tools/nso_bring_to_plate_test.js        exit 0 = every gate held

   `bringSelectedToPlate` (app-core.js) behind `#btn-to-plate` in the viewport
   Move menu, beside Raise and Lower.

   WHY IT EXISTS
   Nothing put a piece back on the plate. Raise and Lower step 2 mm a press, so
   a piece Seat (support) has stacked on a 20 mm target - liftY 20.18 - is
   eleven presses from the bed, and a piece a seat left in the air over a
   target that has since moved or been deleted has nothing under it at all.
   And Lower is not only slow: it goes through applyMeshRotation, which rebuilds
   the mesh's rotation from the placed record's pose fields. A piece the seat
   laid on a slope carries a free quaternion those fields cannot express, so the
   first press of Lower throws that angle away - and the piece is still in the
   air. Section 4 measures both, with Lower as its control.

   What is pinned:
   1. The button is in the Move menu, disabled with nothing selected and
      enabled with a selection, like every other adjust button.
   2. A seated piece comes down in ONE press: world-box bottom on the bed
      baseline, liftY 0, x / z and the piece's own rotation untouched, and the
      status says how far it came.
   3. A second press moves nothing and says so - and pushes no undo entry, so
      one Undo still puts the piece back exactly where the seat left it.
   4. A piece the seat laid on a slope - carrying a free rotation the placed
      record's pose fields cannot express - lands on the bed in one press with
      that rotation intact. The control is the same seat made again: Lower goes
      through applyMeshRotation, which rebuilds the rotation from those fields,
      so its first press throws the seat's angle away and still leaves the
      piece in the air. Undo cannot put that angle back either - pre-existing,
      not this ticket's, and pinned so it cannot change unnoticed.
   5. A tilted piece lands on its lowest corner and keeps its rotation.
   6. A locked piece refuses it exactly as it refuses Raise and Lower: the
      button is disabled and the action moves nothing when called directly.
   7. Raise and Lower are unchanged. */

const { withApp, openMenuFor } = require('./nso_app_harness');
const { openJoin } = require('./nso_join_card');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

/* settlePlacedOnBed puts a world-box bottom on 0.2 + liftY */
const BED = 0.2;

const openLibrary = page => page.evaluate(() => {
  const b = document.getElementById('btn-library');
  if (b) b.click();
  document.querySelectorAll('#library-list .library-sec').forEach(d => { d.open = true; });
});
async function loadFromLibrary(page, file) {
  const before = await page.evaluate(() => state.models.length);
  await openLibrary(page);
  await page.evaluate(f => {
    const row = document.querySelector('#library-list .library-item[data-file="' + f + '"]');
    if (!row) throw new Error('no library row for ' + f);
    row.click();
  }, file);
  await page.waitForFunction(n => state.models.length > n, before, { timeout: 30000 });
  return page.evaluate(() => state.models[state.models.length - 1].id);
}
const selectRow = (page, id) => page.click('.model-item[data-edit-id="' + id + '"]');
const select = (page, id) => page.evaluate(id => {
  selectPlaced(state.placed.findIndex(p => p && p.sourceId === id));
}, id);
const pose = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return { x: p.x, z: p.z, liftY: p.liftY || 0, pos: p.mesh.position.toArray(),
           quat: p.mesh.quaternion.toArray(), bottom: bb.min.y,
           status: document.getElementById('status').textContent };
}, id);
const dragTo = (page, id, x, z) => page.evaluate(([id, x, z]) => {
  const i = state.placed.findIndex(p => p && p.sourceId === id);
  selectPlaced(i);
  nudgeSelected(x - state.placed[i].x, z - state.placed[i].z);
}, [id, x, z]);
const press = async (page, sel) => { await openMenuFor(page, sel); await page.click(sel); };

withApp(async (page, logs) => {
  const idA = await loadFromLibrary(page, 'box_hull_80x40x20.stl');
  const idB = await loadFromLibrary(page, 'box_bit_12x8x8.stl');

  /* ---------- 1. the button ---------- */
  console.log('\n--- 1. the button in the Move menu ---');
  await page.evaluate(() => { state.selectedIndex = -1; updateAdjustUI(); });
  check('disabled with nothing selected',
    await page.evaluate(() => document.getElementById('btn-to-plate').disabled));
  await select(page, idB);
  check('enabled once a piece is selected',
    await page.evaluate(() => !document.getElementById('btn-to-plate').disabled));

  /* ---------- 2. a seated piece comes down in one press ---------- */
  console.log('\n--- 2. a piece Seat (support) stacked on the target ---');
  await openJoin(page);
  await page.click('#join-slot-a'); await selectRow(page, idA);
  await page.click('#join-slot-b'); await selectRow(page, idB);
  await dragTo(page, idB, 0, 0);
  await page.click('#btn-seat-support');
  await page.waitForFunction(() => /^Seated/.test(document.getElementById('status').textContent),
    null, { timeout: 60000 });
  const seated = await pose(page, idB);
  check('the seat left it 20.18 mm up, resting on the target',
    near(seated.liftY, 20.18, 2e-6) && near(seated.bottom, 20.38, 2e-6),
    'liftY ' + seated.liftY + ', bottom ' + seated.bottom);
  await select(page, idB);
  await press(page, '#btn-to-plate');
  let b = await pose(page, idB);
  check('one press and its bottom is on the bed baseline', near(b.bottom, BED, 1e-9), b.bottom);
  check('...and the record says so too', b.liftY === 0, b.liftY);
  check('...with x, z and the piece\'s own rotation untouched',
    b.x === seated.x && b.z === seated.z && b.quat.every((v, i) => v === seated.quat[i]),
    JSON.stringify([b.x, b.z, b.quat]));
  check('...and the status says how far it came', b.status === 'On the plate - down 20.18 mm', b.status);

  /* ---------- 3. idempotent, and one Undo ---------- */
  console.log('\n--- 3. a second press, and Undo ---');
  await press(page, '#btn-to-plate');
  const again = await pose(page, idB);
  check('a piece already on the plate is told so and not moved',
    again.status === 'Already on the plate' && again.pos.every((v, i) => v === b.pos[i]), again.status);
  await page.click('#btn-undo');
  const undone = await pose(page, idB);
  check('one Undo puts it back exactly where the seat left it - the no-op pressed no undo entry',
    undone.pos.every((v, i) => v === seated.pos[i]) && undone.liftY === seated.liftY,
    JSON.stringify(undone.pos) + ' vs ' + JSON.stringify(seated.pos));

  /* ---------- 4. a piece the seat put at an angle ---------- */
  console.log('\n--- 4. a piece carrying a free rotation, which is what Lower cannot bring down ---');
  {
    /* Seat the bit onto a tilted target: the fit lays it on the slope, so the
       bit ends up carrying a free quaternion that the placed record's pose
       fields (rotY / tipX / tiltX / tipZ / tiltZ) cannot express.

       To plate goes through settlePlacedOnBed, which only ever writes y.
       Lower goes through applyMeshRotation, which rebuilds the mesh's rotation
       FROM those fields - so its first press throws the seat's angle away, and
       the piece is still in the air. */
    const seatOnSlope = async () => {
      await openJoin(page);
      await page.click('#join-slot-a'); await selectRow(page, idA);
      await page.click('#join-slot-b'); await selectRow(page, idB);
      await dragTo(page, idB, 0, 0);
      await page.evaluate(() => { document.getElementById('status').textContent = ''; });
      await page.click('#btn-seat-support');
      await page.waitForFunction(() => /^Seated/.test(document.getElementById('status').textContent),
        null, { timeout: 60000 });
      return pose(page, idB);
    };
    await select(page, idA);
    await page.evaluate(() => { tiltSelected(1); });
    const onSlope = await seatOnSlope();
    check('seated on the slope, well clear of the bed and carrying a free rotation',
      onSlope.bottom > 25 && Math.abs(onSlope.quat[0]) > 0.1,
      'bottom ' + onSlope.bottom + ', quat ' + JSON.stringify(onSlope.quat));

    await select(page, idB);
    await press(page, '#btn-to-plate');
    const down = await pose(page, idB);
    check('To plate lands it on the bed in one press', near(down.bottom, BED, 1e-9), down.bottom);
    check('...keeping the angle the seat gave it',
      down.quat.every((v, i) => v === onSlope.quat[i]), JSON.stringify(down.quat));
    check('...and the record agrees afterwards', down.liftY === 0, down.liftY);

    /* the control, on the same seated pose, made again from the plate */
    const again2 = await seatOnSlope();
    /* the same angle on the same slope, well clear of the bed. Not the same
       world-box bottom to the micron: the first seat had to rotate the bit and
       the tilt fit swings it about its outer face's centre, so it lands a
       fraction further along the slope than a bit that arrived already at the
       right angle. */
    check('seated on the slope again, at the same angle and clear of the bed',
      again2.quat.every((v, i) => near(v, onSlope.quat[i], 1e-9)) && again2.bottom > 20,
      JSON.stringify(again2.quat) + ' bottom ' + again2.bottom);
    await select(page, idB);
    /* The control was `#btn-lower` when this was written. That button is
       retired - the Move menu's Vertical slider and arrows own the axis now -
       so it is driven through liftSelected, which is the function the button
       called, which survives, and which every other suite in this repo uses
       for the vertical step. The point of the control is the PATH, not the
       widget: liftSelected, the Vertical arrows and the slider all write liftY
       and then call applyMeshRotation, and it is applyMeshRotation that
       rebuilds the pose from fields holding no free rotation. */
    await page.evaluate(() => { liftSelected(-1); });
    const lowered = await pose(page, idB);
    check('CONTROL: one vertical step throws the seat\'s angle away',
      lowered.quat.every((v, i) => v === [0, 0, 0, 1][i]), JSON.stringify(lowered.quat));
    check('...and still leaves it in the air, one step at a time', lowered.bottom > 20, lowered.bottom);
    /* Pre-existing and not this ticket's to fix: the pose snapshot Undo keeps
       carries the record's fields and no free rotation, so Undo cannot put that
       angle back either. Pinned here so it cannot change unnoticed. */
    await page.click('#btn-undo');
    const undo2 = await pose(page, idB);
    check('KNOWN, pre-existing: Undo cannot restore a free rotation either',
      undo2.quat.every((v, i) => v === [0, 0, 0, 1][i]), JSON.stringify(undo2.quat));

    await select(page, idB);
    await press(page, '#btn-to-plate');
    await select(page, idA);
    await page.evaluate(() => { tiltSelected(-1); });
  }

  /* ---------- 5. a tilted piece ---------- */
  console.log('\n--- 5. a tilted piece ---');
  {
    await select(page, idB);
    await page.evaluate(() => { tiltSelected(1); liftSelected(1); liftSelected(1); });
    const up = await pose(page, idB);
    check('tilted and lifted clear of the bed', up.bottom > 4 && up.quat[0] !== 0, up.bottom);
    await select(page, idB);
    await press(page, '#btn-to-plate');
    const down = await pose(page, idB);
    check('it lands on its lowest corner', near(down.bottom, BED, 1e-9), down.bottom);
    check('...keeping the tilt it had', down.quat.every((v, i) => v === up.quat[i]), JSON.stringify(down.quat));
  }

  /* ---------- 6. a locked piece ---------- */
  console.log('\n--- 6. a locked piece refuses it, the way it refuses the vertical step ---');
  {
    await select(page, idB);
    await page.evaluate(() => { liftSelected(1); });
    await page.evaluate(() => { nsoInputMode.leaveTool(); });
    await page.click('#btn-lock-pos');
    const before = await pose(page, idB);
    check('the button is greyed out with the rest of the adjust row',
      await page.evaluate(() => document.getElementById('btn-to-plate').disabled));
    /* and the action itself refuses, not only the button */
    await page.evaluate(() => { bringSelectedToPlate(); });
    const after = await pose(page, idB);
    check('...and calling it moves nothing', after.pos.every((v, i) => v === before.pos[i]), JSON.stringify(after.pos));
    check('...and says why', /^Locked - bring to plate refused/.test(after.status), after.status);
    await page.evaluate(() => { nsoInputMode.leaveTool(); });
    await page.click('#btn-lock-pos');
  }

  /* ---------- 7. the vertical step is unchanged ---------- */
  /* Was "Raise and Lower, unchanged", driven through those two buttons. They
     are retired; liftSelected is what they called and what is left, so the
     don't-break-the-neighbours check is made against it. Its own 2 mm step is
     the subject here - the Vertical control's 0.25 mm one is pinned by
     `npm run move:vertical`, which owns that ticket. */
  console.log('\n--- 7. liftSelected, the surviving vertical step, unchanged ---');
  {
    await select(page, idB);
    await press(page, '#btn-to-plate');
    const base = await pose(page, idB);
    await page.evaluate(() => { liftSelected(1); });
    const up = await pose(page, idB);
    check('liftSelected(1) still steps 2 mm', near(up.bottom - base.bottom, 2, 1e-9) && up.liftY === 2,
      (up.bottom - base.bottom) + ', liftY ' + up.liftY);
    await page.evaluate(() => { liftSelected(-1); });
    const back = await pose(page, idB);
    check('liftSelected(-1) still steps back', near(back.bottom, base.bottom, 1e-9) && back.liftY === 0, back.bottom);
  }

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('\n' + (fails ? fails + ' gate(s) FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(2); });
