/* Seat (support) onto a flat face that is not square to the bit.
     node tools/nso_seat_tilted_face_test.js      exit 0 = every gate held

   Target = library/box_hull_80x40x20.stl, bit = library/box_bit_12x8x8.stl,
   both through the real library browser, the bit dragged over the target on
   the bed the way a user does it, and the only extra step is a press or two of
   the Tilt arrows in the Tip menu - on one piece or the other. Nothing is
   staged by hand.

   THE REPORT THIS PINS
   "Seat (support), box to box, leaves the piece elevated in mid-air rather
   than positioned relative to the join."

   What was happening. NSO_seatTipsProbe decides whether the surface under the
   bit is a contact skin, and NSO_seatFlushBitToHull sends gap mode down one of
   two completely different paths on the answer: over NSO_SEAT_TIPS_TOL the bit
   is set against the tips UNTILTED, under it the corner-ray fit runs and tilts
   the bit onto the face. The probe measured the relief as

       ext.s - mean(hit . n)

   an extreme height against an AVERAGE height, both along the BIT's own
   normal - and those two agree only while the face is square to that normal.
   Tilt either piece and the four corner-ray hits sit at four different heights
   along n, their mean lands at the middle of the face, and the highest point
   of that same FLAT face stands above the mean by half the face's rise across
   the footprint: 1.07 mm at 15 degrees, 2.31 mm at 30. Both are a hundred
   times the 0.01 mm tolerance, so the plain flat top of an 80 x 40 x 20 box
   was called a contact skin, the tilt fit was skipped, and the bit was slid
   along its own normal until it hung off the high edge of the slope touching
   nothing - at a true shell-to-shell separation of 0.1739 / 0.1559 mm, while
   the status line said `measured -0.180mm, skin error 0.00mm`. The tips path
   measures its residuals against the very extreme it positioned from, so that
   wrong seat read exactly like a right one.

   NOT the corner-ray / outward tie-break issue fixed in 404b996, and not from
   any of the placement merges of that night: measured identically at 060b685,
   the commit before that fix. The tips reference is where it came in
   (2026-09-16); app-join.js carried no tips probe at all at 2a6d07a.

   The fix measures the relief against the PLANE of the four hits - the same
   plane the fit tilts onto - instead of the mean of their heights. A flat face
   at any angle puts its own extreme point in that plane, so the rise is
   Float32 noise and the corner-ray path runs. A real relief still stands its
   tip height proud of the plane its rays found.

   What is pinned:
   1. A square seat is untouched: same status byte for byte, true distance
      0.18, no rotation.
   2. Tilt the TARGET one press and two: plain status, no "from skin tips", the
      bit laid onto the slope at the target's own angle, and the TRUE minimum
      distance between the two shells is the 0.18 mm that was asked for.
   3. Tilt the BIT the same way: the same, with the bit straightened onto the
      face.
   4. The probe's own number: ~0 on a tilted flat face, while the mean measure
      it replaced still reads 1.07 and 2.31 at the same poses.
   5. A real contact skin still takes the tips path and still reports its
      relief, and the seat against it is still exact.
   6. Three presses (45 degrees) is past where the corner-ray fit converges.
      It now REFUSES, naming both numbers, and moves nothing - where before it
      reported a clean seat that was 0.053 mm out.
   7. NEGATIVE CONTROL: put the mean-height measure back in the page and the
      report comes back word for word - "from skin tips, relief 1.07mm above
      the base plane", the bit left unrotated, true distance 0.1739 - and the
      very same click seats at 0.18 with it switched back on. */

const { withApp, openFinishMenu } = require('./nso_app_harness');
const { openJoin } = require('./nso_join_card');
const { soupMinDistance } = require('./nso_soup_distance');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const f4 = v => (Number.isFinite(v) ? v.toFixed(4) : String(v));

const SEATED_18 = 'Seated - air gap 0.18mm (measured -0.180mm, skin error 0.00mm)';
/* the report, word for word, at one press of Tilt */
const OLD_TIPS_15 = SEATED_18 + ' - from skin tips, relief 1.07mm above the base plane';

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
  await openJoin(page);
  await page.click('#join-slot-a'); await selectRow(page, idA);
  await page.click('#join-slot-b'); await selectRow(page, idB);
  return page.evaluate(() => ({ session: state.joinSession, a: state.editId, b: state.joinPartnerId }));
}
/* the app's own move primitive - what a viewport drag calls */
const dragTo = (page, id, x, z) => page.evaluate(([id, x, z]) => {
  const i = state.placed.findIndex(p => p && p.sourceId === id);
  selectPlaced(i);
  nudgeSelected(x - state.placed[i].x, z - state.placed[i].z);
}, [id, x, z]);
/* Tilt lifts one edge 15 degrees a press - the Tip menu's own arrow */
const tiltPress = (page, id, n) => page.evaluate(([id, n]) => {
  const i = state.placed.findIndex(p => p && p.sourceId === id);
  selectPlaced(i);
  for (let k = 0; k < n; k++) tiltSelected(1);
}, [id, n]);
const pose = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return { x: p.x, z: p.z, liftY: p.liftY || 0, pos: p.mesh.position.toArray(),
           quat: p.mesh.quaternion.toArray(), min: bb.min.toArray(), max: bb.max.toArray(),
           status: document.getElementById('status').textContent };
}, id);
const worldSoup = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.mesh.updateMatrixWorld(true);
  return Array.from(meshToWorldSoup(p.mesh));
}, id);
/* the quantity the status line cannot fake: the real minimum distance between
   the two shells, computed outside the page by tools/nso_soup_distance.js */
async function trueGap(page, idA, idB) {
  return soupMinDistance(await worldSoup(page, idA), await worldSoup(page, idB)).dist;
}
const clearStatus = page => page.evaluate(() => { document.getElementById('status').textContent = ''; });
const waitSeat = page => page.waitForFunction(
  () => /^Seated|^Seat failed/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
async function clickSeat(page) {
  await clearStatus(page);
  await page.click('#btn-seat-support');
  await waitSeat(page);
  return page.evaluate(() => document.getElementById('status').textContent);
}

/* Both relief measures at the pose the FIT is handed - the staged pose every
   seat creates, with the bit raised clear of the target's top. `rise` is what
   the probe now reports; `meanRise` is the quantity it replaced, rebuilt from
   the probe's own s and sPlane so the two cannot drift apart. */
const relief = (page, idA, idB) => page.evaluate(([idA, idB]) => {
  const pa = state.placed.find(p => p && p.sourceId === idA);
  const pb = state.placed.find(p => p && p.sourceId === idB);
  settlePlacedOnBed(pa);
  pa.mesh.updateMatrixWorld(true);
  const raised = NSO_raiseBuriedBitClear(pa, pb);
  if (!pa.mesh.geometry.boundingBox) pa.mesh.geometry.computeBoundingBox();
  const hc = new THREE.Vector3();
  pa.mesh.geometry.boundingBox.getCenter(hc);
  hc.applyMatrix4(pa.mesh.matrixWorld);
  const probe = NSO_seatTipsProbe(meshToWorldSoup(pa.mesh), pb.mesh, hc);
  if (raised) NSO_restoreRaisedBit(pb, raised);
  return probe ? { rise: probe.rise, meanRise: probe.s - probe.sPlane } : null;
}, [idA, idB]);

/* The negative control: put the mean-height measure back, through the shipped
   probe rather than a copy of it, so what comes back is the old quantity and
   nothing else. */
const setMeanRise = (page, on) => page.evaluate(on => {
  if (on) {
    if (window.__realTipsProbe) { NSO_seatTipsProbe = window.__realTipsProbe; delete window.__realTipsProbe; }
  } else if (!window.__realTipsProbe) {
    window.__realTipsProbe = NSO_seatTipsProbe;
    NSO_seatTipsProbe = function (hull, bitMesh, hullCenter) {
      const p = window.__realTipsProbe(hull, bitMesh, hullCenter);
      if (p) p.rise = p.s - p.sPlane;
      return p;
    };
  }
}, on);

async function freshPair(page) {
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true, null, { timeout: 30000 });
  const idA = await loadFromLibrary(page, 'box_hull_80x40x20.stl');
  const idB = await loadFromLibrary(page, 'box_bit_12x8x8.stl');
  await joinAB(page, idA, idB);
  await dragTo(page, idB, 0, 0);
  return { idA, idB };
}

withApp(async (page, logs) => {
  let { idA, idB } = await freshPair(page);
  const j = await page.evaluate(() => ({ session: state.joinSession, a: state.editId, b: state.joinPartnerId }));
  check('Join holds A = the box target, B = the box bit', j.session && j.a === idA && j.b === idB, JSON.stringify(j));
  check('the gap slider is at its -0.18 default, untouched',
    (await page.evaluate(() => document.getElementById('seat-gap').value)) === '-0.18');
  const a0 = await pose(page, idA);
  check('the target is the plain flat box it claims to be (80 x 40 x 20, on the bed)',
    near(a0.max[0] - a0.min[0], 80, 1e-9) && near(a0.max[2] - a0.min[2], 40, 1e-9)
    && near(a0.max[1] - a0.min[1], 20, 1e-6) && near(a0.min[1], 0.2, 1e-9),
    JSON.stringify([a0.min, a0.max]));

  /* ---------- 1. square: nothing about this changes ---------- */
  console.log('\n--- 1. square on the face, the case every other seat suite pins ---');
  let st = await clickSeat(page);
  let b = await pose(page, idB);
  check('status, byte for byte', st === SEATED_18, st);
  check('the bit is not rotated', b.quat.every((v, i) => near(v, [0, 0, 0, 1][i], 1e-12)), JSON.stringify(b.quat));
  check('and the TRUE minimum distance between the shells is 0.18',
    near(await trueGap(page, idA, idB), 0.18, 1e-4), f4(await trueGap(page, idA, idB)));

  /* ---------- 2. the target tilted ---------- */
  console.log('\n--- 2. the TARGET tilted, one press of Tilt and two ---');
  for (const n of [1, 2]) {
    ({ idA, idB } = await freshPair(page));
    await tiltPress(page, idA, n);
    await dragTo(page, idB, 0, 0);
    const r = await relief(page, idA, idB);
    st = await clickSeat(page);
    const a = await pose(page, idA);
    b = await pose(page, idB);
    const d = await trueGap(page, idA, idB);
    check(n * 15 + ' deg: seats on the corner-ray path, not as a skin', st === SEATED_18, st);
    check(n * 15 + ' deg: the bit is laid onto the slope, at the target\'s own angle',
      b.quat.every((v, i) => near(v, a.quat[i], 1e-6)),
      JSON.stringify(b.quat) + ' vs target ' + JSON.stringify(a.quat));
    check(n * 15 + ' deg: TRUE minimum distance is the 0.18 that was asked for', near(d, 0.18, 1e-4), f4(d));
    check(n * 15 + ' deg: the probe reads a flat face as flat, where the mean measure read a relief',
      Math.abs(r.rise) < 0.01 && r.meanRise > 1, 'rise ' + f4(r.rise) + ', mean measure ' + f4(r.meanRise));
  }

  /* ---------- 3. the bit tilted ---------- */
  console.log('\n--- 3. the BIT tilted, one press and two ---');
  for (const n of [1, 2]) {
    ({ idA, idB } = await freshPair(page));
    await tiltPress(page, idB, n);
    await dragTo(page, idB, 0, 0);
    st = await clickSeat(page);
    b = await pose(page, idB);
    const d = await trueGap(page, idA, idB);
    check(n * 15 + ' deg: seats on the corner-ray path, not as a skin', st === SEATED_18, st);
    check(n * 15 + ' deg: the bit is straightened onto the flat face',
      b.quat.every((v, i) => near(v, [0, 0, 0, 1][i], 1e-6)), JSON.stringify(b.quat));
    check(n * 15 + ' deg: TRUE minimum distance is the 0.18 that was asked for', near(d, 0.18, 1e-4), f4(d));
  }

  /* ---------- 4. a real relief is still a relief ---------- */
  console.log('\n--- 4. a real contact skin still takes the tips path ---');
  {
    /* B is left where it loads, beside A, so Skin face's auto-pick puts the
       relief on the face that looks at B - the very face the seat then works
       off. A side seat, the one place a 20 mm target and an 8 mm bit meet
       squarely without either being moved. */
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof state !== 'undefined' && state.ready === true, null, { timeout: 30000 });
    idA = await loadFromLibrary(page, 'box_hull_80x40x20.stl');
    idB = await loadFromLibrary(page, 'box_bit_12x8x8.stl');
    await joinAB(page, idA, idB);
    await page.evaluate(id => { selectPlaced(state.placed.findIndex(p => p && p.sourceId === id)); }, idA);
    await openFinishMenu(page);
    await page.click('#btn-skin-face');
    await page.waitForFunction(() => /^Skinned /.test(document.getElementById('status').textContent),
      null, { timeout: 180000 });
    const skinned = await page.evaluate(() => document.getElementById('status').textContent);
    await page.evaluate(() => { const d = document.querySelector('.vp-finish-menu'); if (d) d.open = false; });
    check('the face that looks at B carries a 0.6 mm crosshatch relief',
      /^Skinned \+X face/.test(skinned) && /0\.6 mm tall/.test(skinned), skinned);
    await joinAB(page, idA, idB);
    st = await clickSeat(page);
    const d = await trueGap(page, idA, idB);
    check('the seat says so, and says how tall the relief is',
      st === SEATED_18 + ' - from skin tips, relief 0.60mm above the base plane', st);
    check('and the seat against the tips is exact', near(d, 0.18, 1e-4), f4(d));
  }

  /* ---------- 5. past where the fit converges ---------- */
  console.log('\n--- 5. three presses: past where the corner-ray fit converges ---');
  {
    ({ idA, idB } = await freshPair(page));
    await tiltPress(page, idA, 3);
    await dragTo(page, idB, 0, 0);
    const before = await pose(page, idB);
    st = await clickSeat(page);
    const after = await pose(page, idB);
    check('45 deg: the seat refuses, and names both numbers',
      /^Seat failed - the fit ended 4\.7\d mm off the 0\.18 mm that was asked for/.test(st), st);
    check('...and moves nothing',
      after.pos.every((v, i) => v === before.pos[i]) && after.liftY === before.liftY
      && after.quat.every((v, i) => v === before.quat[i]), JSON.stringify(after.pos));
  }

  /* ---------- 6. negative control ---------- */
  console.log('\n--- 6. negative control: put the mean-height measure back ---');
  {
    ({ idA, idB } = await freshPair(page));
    await setMeanRise(page, false);
    await tiltPress(page, idA, 1);
    await dragTo(page, idB, 0, 0);
    st = await clickSeat(page);
    b = await pose(page, idB);
    const d = await trueGap(page, idA, idB);
    check('the report comes back, word for word', st === OLD_TIPS_15, st);
    check('...with the bit left unrotated over a face that is not flat to it',
      b.quat.every((v, i) => near(v, [0, 0, 0, 1][i], 1e-12)), JSON.stringify(b.quat));
    check('...and the true distance is not the gap that was asked for', near(d, 0.1739, 1e-3), f4(d));

    await setMeanRise(page, true);
    await page.click('#btn-undo');
    await dragTo(page, idB, 0, 0);
    st = await clickSeat(page);
    const d2 = await trueGap(page, idA, idB);
    check('measure back on: the very same click seats', st === SEATED_18, st);
    check('...at the gap that was asked for', near(d2, 0.18, 1e-4), f4(d2));
  }

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  console.log('\n' + (fails ? fails + ' gate(s) FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(2); });
