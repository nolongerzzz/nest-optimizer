/* Box on box: the simplest seat there is, anywhere on the target's top face.
     node tools/nso_seat_box_on_box_test.js       exit 0 = every gate held

   Target = library/box_hull_80x40x20.stl (a 12-triangle box, 80 x 40 x 20,
   flat top), bit = library/box_bit_12x8x8.stl (a 12-triangle box). Both
   loaded through the real library browser, the bit dragged over the target
   along the bed the way a user does it, then Seat. Nothing is staged by hand
   and nothing is posed: this is as plain as the seat gets.

   THE REPORT THIS PINS
   "Seat (support) fails with 'corner 0 missed hull along punch axis' on a
   confirmed-flat box target, with any bit, always at corner 0." Every part of
   that was true and none of it meant what it looked like:

   - Not the corner. The fit refuses on the FIRST corner whose ray misses and
     corner 0 is the first one tested, so "always corner 0" carries no
     information at all - when the axis is wrong, all four miss. The negative
     control in section 6 shows corner 0 for two different bit shapes.
   - Not the bit. The axis was chosen before the bit's shape was consulted.
   - Not a regression. Measured against 2a6d07a (2026-09-15), five days and
     both placement merges earlier: the same offsets fail there, identically.
     A previously-uncaught limitation, uncaught because every seat test until
     now put the bit over the MIDDLE of its target.
   - It was the position. NSO_plugFrame ranks the six candidate faces by what
     a step out of and into each one meets, and a bit standing clear of the
     target - which is the pose NSO_raiseBuriedBitClear deliberately creates
     before every seat - puts all six on the same rank. The decision then fell
     to the rank's tie-break, a hull-centre-to-bit-centre vector, which leans
     sideways as soon as the bit is further across the target than it is above
     it: 19 mm here. Past that the seat punched horizontally through open air
     above the target and every corner ray missed. Over half of this target's
     top face could not be seated, with either Seat button, by any bit.

   What is pinned:
   1. Seat (support) works at every plan offset across the whole top face -
      centre, the far half that used to refuse, and flush with the target's
      edge - with the same clean status line, the same 0.18 mm gap, XZ
      untouched, and Undo putting the bit back.
   2. The fit punches at the face it is seated to (axis +Y, punch -Y) at every
      one of those offsets, not at whichever face the centroid vector leans at.
   3. The gap in the status line is MEASURED, not echoed. The read-back used to
      build its frame without the hull soup, fall back to that same centroid
      rule, name a different face and miss with all four rays - which reads as
      cornerResidual NaN, maxResidual 0 and gapAchieved NaN, and prints the gap
      that was asked for as the one that was measured. Section 3 pins the real
      measurement against the real world-box gap, and shows what the soup-less
      frame still says.
   4. Seat flush, the other button, over the same offsets.
   5. A second bit shape - the crosshatch washer patch, a 30 x 30 non-solid
      lattice - over the same offsets, because the report said any bit and the
      fix has to be shape-blind too.
   6. NEGATIVE CONTROL: with the reach test switched off in the page, the
      original failure comes back at the original offsets, word for word, at
      corner 0, for both bits - and the refused seat moves nothing. Switch it
      back on and the same click seats. Without this the gates above would
      still pass if the fix were deleted and the bug simply never triggered. */

/* No path helpers: every piece here is named the way the catalog names it and
   fetched by the library browser itself, so the test cannot load a file the
   shipped catalog does not actually offer. */
const { withApp } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

const SEATED_18 = 'Seated - air gap 0.18mm (measured -0.180mm, skin error 0.00mm)';
const GOLDEN_FLUSH = 'Seated - proud 0.01mm, skin error 0.00mm - Subtract';
const MISSED = /^Seat failed - corner 0 missed hull along punch axis$/;

/* ---- driving the real UI ---- */
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
async function joinAB(page, idA, idB) {
  await page.click('#btn-join-start');
  await page.click('#join-slot-a'); await selectRow(page, idA);
  await page.click('#join-slot-b'); await selectRow(page, idB);
  return page.evaluate(() => ({ session: state.joinSession, a: state.editId, b: state.joinPartnerId }));
}
const pose = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return { x: p.x, z: p.z, liftY: p.liftY || 0, pos: p.mesh.position.toArray(),
           quat: p.mesh.quaternion.toArray(), min: bb.min.toArray(), max: bb.max.toArray(),
           status: document.getElementById('status').textContent };
}, id);
/* the app's own move primitive - what a viewport drag calls; it keeps the piece on the bed */
const dragTo = (page, id, x, z) => page.evaluate(([id, x, z]) => {
  const i = state.placed.findIndex(p => p && p.sourceId === id);
  selectPlaced(i);
  const p = state.placed[i];
  nudgeSelected(x - p.x, z - p.z);
}, [id, x, z]);
const clearStatus = page => page.evaluate(() => { document.getElementById('status').textContent = ''; });
const waitSeat = page => page.waitForFunction(
  () => /^Seated|^Seat failed/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
async function clickSeat(page, sel) {
  await clearStatus(page);
  await page.click(sel);
  await waitSeat(page);
}

/* The frame the fit builds at the bit's CURRENT pose, and what the read-back
   would say if it were still built without the hull soup. */
const frames = (page, idA, idB, staged) => page.evaluate(([idA, idB, staged]) => {
  const pa = state.placed.find(p => p && p.sourceId === idA);
  const pb = state.placed.find(p => p && p.sourceId === idB);
  pa.mesh.updateMatrixWorld(true); pb.mesh.updateMatrixWorld(true);
  /* `staged` reads the frame at the pose the FIT is handed, not the pose the
     drag left: every seat raises a buried bit clear of the target's top first
     (NSO_raiseBuriedBitClear), and that staged pose - bit standing clear, all
     six candidates on one rank - is the one the chooser used to get wrong. A
     bit still sitting buried in the target is a different question with a
     different right answer: the nearest way out really is sideways. */
  const raised = staged ? NSO_raiseBuriedBitClear(pa, pb) : null;
  if (!pa.mesh.geometry.boundingBox) pa.mesh.geometry.computeBoundingBox();
  const hc = new THREE.Vector3();
  pa.mesh.geometry.boundingBox.getCenter(hc);
  hc.applyMatrix4(pa.mesh.matrixWorld);
  const hull = meshToWorldSoup(pa.mesh);
  const asked = f => ({ axis: f.axis, sign: f.sign, punch: f.punch.toArray().map(v => +v.toFixed(6)) });
  const withSoup = NSO_plugFrame(pb.mesh, hc, hull);
  const noSoup = NSO_plugFrame(pb.mesh, hc);
  /* the old read-back, run the way NSO_seatFlushBitToHull used to run it */
  const cf = NSO_outerFaceCorners(noSoup);
  const rays = NSO_seatRayOrigins(cf);
  let hitsNoSoup = 0;
  for (let i = 0; i < rays.length; i++) if (NSO_nearestSkinHit(hull, rays[i], noSoup.punch)) hitsNoSoup++;
  if (raised) NSO_restoreRaisedBit(pb, raised);
  return { fit: asked(withSoup), centroid: asked(noSoup), hitsNoSoup: hitsNoSoup };
}, [idA, idB, !!staged]);

/* The seat engine's own numbers at a staged pose, so the status line's
   "measured" can be held against something that is not itself. */
const seatDirect = (page, idA, idB, x, gap) => page.evaluate(([idA, idB, x, gap]) => {
  const pa = state.placed.find(p => p && p.sourceId === idA);
  const pb = state.placed.find(p => p && p.sourceId === idB);
  pa.mesh.updateMatrixWorld(true);
  const ba = new THREE.Box3().setFromObject(pa.mesh);
  if (!pb.mesh.geometry.boundingBox) pb.mesh.geometry.computeBoundingBox();
  const bl = pb.mesh.geometry.boundingBox;
  pb.mesh.quaternion.set(0, 0, 0, 1);
  pb.mesh.position.set(x, ba.max.y + 5 + (bl.max.y - bl.min.y) / 2, 0);
  pb.mesh.updateMatrixWorld(true);
  const r = NSO_seatFlushBitToHull(pa.mesh, pb.mesh, { gap: gap });
  const bb = new THREE.Box3().setFromObject(pb.mesh);
  return { ok: !!(r && r.ok), reason: r && r.reason,
           cornerResidual: (r.cornerResidual || []).map(v => (Number.isFinite(v) ? v : null)),
           maxResidual: r.maxResidual, gapAchieved: r.gapAchieved,
           trueGap: bb.min.y - ba.max.y };
}, [idA, idB, x, gap]);

const setReach = (page, on) => page.evaluate(on => {
  if (on) {
    if (window.__realReach) { NSO_seatFaceReaches = window.__realReach; delete window.__realReach; }
  } else if (!window.__realReach) {
    window.__realReach = NSO_seatFaceReaches;
    NSO_seatFaceReaches = function () { return true; };
  }
}, on);

/* Offsets across the target's top face. The target is 80 x 40 and the bit is
   12 x 8, so 34 is flush with the +X edge and 0 is dead centre. 19 is where
   the plan offset overtakes the height difference - the first offset that used
   to refuse - and everything past it used to refuse too. */
const X_OFFSETS = [0, 10, 18, 19, 20, 25, 30, 34];
const X_USED_TO_FAIL = [19, 20, 25, 30, 34];
/* Seat flush is the same corner-ray fit at a different offset, so it does not
   need the whole sweep again - just the shape of it: centre, the last offset
   that used to work, the first that did not, and flush with the edge. */
const X_FLUSH = [0, 18, 19, 25, 34];

async function sweepSupport(page, idA, idB, label, offsets) {
  let bad = 0, worst = '';
  for (const x of offsets) {
    await dragTo(page, idB, x, 0);
    await clickSeat(page, '#btn-seat-support');
    const a = await pose(page, idA), b = await pose(page, idB);
    const ok = b.status === SEATED_18
      && near(b.min[1] - a.max[1], 0.18, 2e-6)
      && near(b.x, x, 1e-9) && near(b.z, 0, 1e-9)
      && b.quat.every((v, i) => near(v, [0, 0, 0, 1][i], 1e-12));
    if (!ok) { bad++; worst = 'x=' + x + ': ' + b.status + ' gap ' + (b.min[1] - a.max[1]) + ' at (' + b.x + ',' + b.z + ')'; }
    const f = await frames(page, idA, idB, true);
    if (f.fit.axis !== 1 || f.fit.sign !== 1) { bad++; worst = 'x=' + x + ': fit punch ' + JSON.stringify(f.fit.punch); }
    await page.click('#btn-undo');
  }
  check(label, bad === 0, bad ? worst : offsets.length + ' offsets, all seated at 0.18 with punch -Y');
}

withApp(async (page, logs) => {
  const idA = await loadFromLibrary(page, 'box_hull_80x40x20.stl');
  const idB = await loadFromLibrary(page, 'box_bit_12x8x8.stl');
  const j = await joinAB(page, idA, idB);
  check('Join holds A = the box target, B = the box bit', j.session && j.a === idA && j.b === idB, JSON.stringify(j));
  check('the gap slider is at its -0.18 default, untouched',
    (await page.evaluate(() => document.getElementById('seat-gap').value)) === '-0.18');
  const a0 = await pose(page, idA);
  check('the target is the plain flat box it claims to be (80 x 40 x 20, on the bed)',
    near(a0.max[0] - a0.min[0], 80, 1e-9) && near(a0.max[2] - a0.min[2], 40, 1e-9)
    && near(a0.max[1] - a0.min[1], 20, 1e-6) && near(a0.min[1], 0.2, 1e-9),
    JSON.stringify([a0.min, a0.max]));

  /* ---------- 1. Seat (support) anywhere on the top face ---------- */
  console.log('\n--- 1. Seat (support), bit dragged across the whole top face ---');
  await sweepSupport(page, idA, idB, 'every offset seats: same status, 0.18 gap, XZ and pose untouched', X_OFFSETS);

  console.log('\n--- 1b. Undo after a seat at the offset that used to refuse ---');
  await dragTo(page, idB, 25, 0);
  const bedPose = await pose(page, idB);
  await clickSeat(page, '#btn-seat-support');
  let b = await pose(page, idB);
  check('seated off centre', b.status === SEATED_18, b.status);
  await page.click('#btn-undo');
  b = await pose(page, idB);
  check('Undo puts the bit back on the bed exactly where the drag left it',
    b.pos.every((v, i) => v === bedPose.pos[i]) && b.liftY === bedPose.liftY, JSON.stringify(b.pos));

  /* ---------- 2. the axis the fit actually punches at ---------- */
  console.log('\n--- 2. the chosen face, off centre ---');
  await dragTo(page, idB, 34, 0);
  const fFar = await frames(page, idA, idB, true);
  check('at the staged pose the fit is handed, it punches at the target (-Y), 34 mm off centre and flush with the edge',
    fFar.fit.axis === 1 && fFar.fit.sign === 1 && fFar.fit.punch[1] === -1, JSON.stringify(fFar.fit));
  check('...while the bare centroid rule still leans sideways at that same pose - the bug, still visible',
    fFar.centroid.axis === 0, JSON.stringify(fFar.centroid));
  const fBuried = await frames(page, idA, idB, false);
  check('and a bit still BURIED in the target keeps its old answer - the nearest way out is sideways, and that is right',
    fBuried.fit.axis === 0, JSON.stringify(fBuried.fit));
  await dragTo(page, idB, 0, 0);

  /* ---------- 3. the number in the status line is measured ---------- */
  console.log('\n--- 3. "measured" is a measurement ---');
  for (const x of [0, 25, 34]) {
    const r = await seatDirect(page, idA, idB, x, -0.18);
    const finite = r.cornerResidual.length === 4 && r.cornerResidual.every(v => v !== null);
    check('x=' + x + ': all four corner residuals are real numbers', finite, JSON.stringify(r.cornerResidual));
    check('x=' + x + ': gapAchieved matches the true world-box gap (2e-6)',
      near(-r.gapAchieved, r.trueGap, 2e-6), r.gapAchieved + ' vs ' + (-r.trueGap));
    check('x=' + x + ': the seat really is 0.18 mm off the target (2e-6)', near(r.trueGap, 0.18, 2e-6), r.trueGap);
  }
  await dragTo(page, idB, 34, 0);
  await clickSeat(page, '#btn-seat-support');
  const fSeated = await frames(page, idA, idB);
  check('the read-back reads the seated face, and the soup-less frame it used to build still misses with all four rays',
    fSeated.fit.axis === 1 && fSeated.centroid.axis === 0 && fSeated.hitsNoSoup === 0,
    JSON.stringify([fSeated.fit.axis, fSeated.centroid.axis, fSeated.hitsNoSoup]));
  await page.click('#btn-undo');

  /* ---------- 4. Seat flush over the same offsets ---------- */
  console.log('\n--- 4. Seat flush, the other button ---');
  let flushBad = 0, flushWorst = '';
  for (const x of X_FLUSH) {
    await dragTo(page, idB, x, 0);
    await clickSeat(page, '#btn-seat-flush');
    const a = await pose(page, idA), bb = await pose(page, idB);
    /* the flush plug seat: outer face 0.01 proud of the skin, the 8 mm bit
       therefore 7.99 below the target's top */
    if (!(bb.status === GOLDEN_FLUSH && near(bb.max[1] - a.max[1], 0.01, 2e-6)
          && near(bb.min[1] - a.max[1], -7.99, 2e-6))) {
      flushBad++; flushWorst = 'x=' + x + ': ' + bb.status + ' top ' + (bb.max[1] - a.max[1]);
    }
    await page.click('#btn-undo');
  }
  check('Seat flush holds the golden plug relation at every offset', flushBad === 0,
    flushBad ? flushWorst : X_FLUSH.length + ' offsets');

  /* ---------- 5. a second bit shape ---------- */
  console.log('\n--- 5. the crosshatch washer patch as the bit (30 x 30 lattice) ---');
  const idC = await loadFromLibrary(page, 'patch_crosshatch_loose.stl');
  const j2 = await joinAB(page, idA, idC);
  check('Join holds A = the box target, B = the patch', j2.session && j2.a === idA && j2.b === idC, JSON.stringify(j2));
  /* 80 wide, patch 30 wide: 25 is the furthest it goes while staying on the face */
  await sweepSupport(page, idA, idC, 'the patch seats at every offset too - the fix is bit-shape-blind',
    [0, 10, 19, 20, 25]);

  /* ---------- 6. negative control ---------- */
  console.log('\n--- 6. negative control: switch the reach test off and the report comes back ---');
  await setReach(page, false);
  for (const [id, what] of [[idB, 'box bit'], [idC, 'patch']]) {
    await joinAB(page, idA, id);
    let missed = 0, seated = 0, moved = 0;
    for (const x of X_USED_TO_FAIL.filter(v => v <= (id === idC ? 25 : 34))) {
      await dragTo(page, id, x, 0);
      const before = await pose(page, id);
      await clickSeat(page, '#btn-seat-support');
      const after = await pose(page, id);
      if (MISSED.test(after.status)) missed++;
      if (/^Seated/.test(after.status)) seated++;
      if (!after.pos.every((v, i) => v === before.pos[i]) || after.liftY !== before.liftY) moved++;
      await page.click('#btn-undo');
    }
    check('without the reach test the ' + what + ' refuses at corner 0, at every offset that used to fail',
      seated === 0 && missed > 0, missed + ' refused, ' + seated + ' seated');
    check('...and the refused seat moves nothing', moved === 0, moved + ' moved');
  }
  await setReach(page, true);
  await joinAB(page, idA, idB);
  await dragTo(page, idB, 25, 0);
  await clickSeat(page, '#btn-seat-support');
  b = await pose(page, idB);
  check('reach test back on: the very same click seats', b.status === SEATED_18, b.status);

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('\n' + (fails ? fails + ' gate(s) FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(2); });
