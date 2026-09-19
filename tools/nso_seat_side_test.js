/* Horizontal seating: two pieces resting side by side on the bed, proven
   through the real app and the canonical checker.
     node tools/nso_seat_side_test.js        exit 0 = every gate held

   Hull = fixtures/box_hull_80x40x20-2.stl (80 x 40, 20 tall on the plate),
   bit = fixtures/box-20mm.stl, dragged along the bed to sit BESIDE the hull
   rather than over it. That is the case docs/HANDOFF.md carried as a stated
   limit of the vertical-stacking work: "Two pieces resting side by side on
   the bed never seat horizontally - Seat failed - corner 0 missed hull along
   punch axis. Both bottoms sit on exactly 0.2, so the corner rays run along
   the hull's bottom edge and NSO_rayTri misses it."

   What is pinned:
   1. The staging really is the grazing one: both world-box bottoms on the
      same bed baseline, to the last bit.
   2. The fix is load-bearing: with NSO_seatRayOrigins stubbed back to the
      bare corners, the same click refuses with the reported message.
   3. Seat (support) at -0.18 side by side: clean status (no "held at plate
      level"), the bit's mating face 0.18 mm off the hull's wall, the bit
      still on the bed, Z and the quaternion untouched, Undo exact.
   4. The file the slicer gets, through tools/mesh_validate.py --json: two
      closed shells 0.18 mm apart along X, 0 piercing, 0 coplanar.
   5. The other gaps through the slider (-0.05, 0) and all four walls.
   6. Seat flush side by side gives the side plug (outer face 0.01 proud).
   7. A bit the wall cuts through is still refused, from the bed too - the
      overhang gate now sees the pose instead of losing it to a missed ray.
   8. The bed-epsilon clamp: a seat that really would sink the bit below the
      plate still says so; the Float noise a settled bit carries does not.
   9. The inset is a sample-point change only: the ray origins keep the
      corners' own offset along the punch axis and stay inside the face.
  10. The 60-placement sweep the inset was MEASURED from, pinned rather than
      left as an audit number: four walls x five distances off the wall x
      three slides along it. Every one loses a corner ray at the bare corner
      and at a 1e-9 inset; from 1e-7 up the 50 that sit over the target face
      recover all four and measure the near wall, while the 10 that hang 3 mm
      past the hull's own edge go on refusing out to a 0.01 mm inset. No
      placement is ever flagged as a straddle, at any inset in that range. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const SEATED_18 = 'Seated - air gap 0.18mm (measured -0.180mm, skin error 0.00mm)';
const GOLDEN_FLUSH_STATUS = 'Seated - proud 0.01mm, skin error 0.00mm - Subtract';
const MISSED_RE = /^Seat failed - corner \d missed hull along punch axis$/;

/* ---- STL helpers, stdlib only (as in nso_seat_align_test.js) ---- */
function parseBinarySTL(buf) {
  const n = buf.readUInt32LE(80);
  const tris = [];
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    const t = [];
    for (let k = 0; k < 3; k++) {
      t.push([buf.readFloatLE(o + k * 12), buf.readFloatLE(o + k * 12 + 4), buf.readFloatLE(o + k * 12 + 8)]);
    }
    tris.push(t);
  }
  return tris;
}
/* connected shells, with each one's extent along `ax` (0 = file X, 2 = file Z) */
function shells(tris, ax) {
  const id = new Map();
  const parent = [];
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const vid = v => {
    const k = v.join(',');
    if (!id.has(k)) { id.set(k, parent.length); parent.push(parent.length); }
    return id.get(k);
  };
  const triV = tris.map(t => t.map(vid));
  for (const t of triV) { union(t[0], t[1]); union(t[1], t[2]); }
  const groups = new Map();
  tris.forEach((t, i) => {
    const r = find(triV[i][0]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  });
  return [...groups.values()].map(list => {
    let lo = Infinity, hi = -Infinity;
    for (const t of list) for (const v of t) { if (v[ax] < lo) lo = v[ax]; if (v[ax] > hi) hi = v[ax]; }
    return { tris: list.length, lo, hi };
  }).sort((a, b) => a.lo - b.lo);
}
function meshValidate(file) {
  const out = execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out);
}

/* ---- in-page helpers (same primitives the Seat/Align suites drive) ---- */
const pose = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return { x: p.x, z: p.z, liftY: p.liftY || 0, pos: p.mesh.position.toArray(), quat: p.mesh.quaternion.toArray(),
           min: bb.min.toArray(), max: bb.max.toArray(),
           status: document.getElementById('status').textContent, undoDepth: state.undoStack.length };
}, id);
const clearStatus = page => page.evaluate(() => { document.getElementById('status').textContent = ''; });
const waitStatus = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.getElementById('status').textContent), re.source, { timeout: 60000 });
/* the app's move primitive - what a viewport drag calls; it keeps the piece on the bed */
const dragTo = (page, id, x, z) => page.evaluate(([id, x, z]) => {
  const idx = state.placed.findIndex(p => p && p.sourceId === id);
  selectPlaced(idx);
  const p = state.placed[idx];
  nudgeSelected(x - p.x, z - p.z);
}, [id, x, z]);
const setSlider = (page, value) => page.evaluate(v => {
  const el = document.getElementById('seat-gap');
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, value);
const selectRow = (page, id) => page.click(`.model-item[data-edit-id="${id}"]`);
async function joinAB(page, idA, idB) {
  await page.click('#btn-join-start');
  await page.click('#join-slot-a'); await selectRow(page, idA);
  await page.click('#join-slot-b'); await selectRow(page, idB);
  return page.evaluate(() => ({ session: state.joinSession, a: state.editId, b: state.joinPartnerId }));
}
async function clickSeat(page) { await clearStatus(page); await page.click('#btn-seat-support'); await waitStatus(page, /^Seated|^Seat /); }
async function clickFlush(page) { await clearStatus(page); await page.click('#btn-seat-flush'); await waitStatus(page, /^Seated|^Seat /); }

const exportPlate = () => {
  const geo = buildCombinedGeometry();
  const buf = geometryToBinarySTL(geo);
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

withApp(async (page, logs) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-seat-side-'));
  const hullVol = meshValidate(fx('box_hull_80x40x20-2.stl')).signed_volume;
  const bitVol = meshValidate(fx('box-20mm.stl')).signed_volume;
  const idA = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const idB = await loadSTL(page, fx('box-20mm.stl'));
  const j = await joinAB(page, idA, idB);
  check('Join session holds A = hull, B = bit', j.session && j.a === idA && j.b === idB, JSON.stringify(j));

  /* Seat settles A itself; do it up front so the staging gates read the same
     bed baseline the seat will. */
  await page.evaluate(id => {
    const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
    settlePlacedOnBed(p); p.mesh.updateMatrixWorld(true);
  }, idA);

  /* ---------- 1. the staging, and that it really is the grazing one ---------- */
  console.log('\n--- 1. bit dragged BESIDE the hull along the bed, 3 mm off the +X wall ---');
  let a = await pose(page, idA);
  await dragTo(page, idB, a.max[0] + 13, a.z);
  let b = await pose(page, idB);
  console.log('  hull box ' + JSON.stringify([a.min, a.max]) + '\n  bit box  ' + JSON.stringify([b.min, b.max]));
  check('bit is beside the hull, not over it: 3 mm clear of the +X wall', near(b.min[0] - a.max[0], 3, 1e-9), b.min[0] - a.max[0]);
  check('both pieces rest on the SAME bed baseline, to the last bit (the graze)',
    b.min[1] === a.min[1] && near(b.min[1], 0.2, 1e-9), b.min[1] + ' vs ' + a.min[1]);
  check('the bit overlaps the hull in Y and Z, so the wall is a real target',
    b.max[1] <= a.max[1] + 1e-9 && b.min[2] > a.min[2] && b.max[2] < a.max[2], JSON.stringify([b.min, b.max]));
  const bedPose = b;

  /* ---------- 2. the fix is load-bearing ---------- */
  console.log('\n--- 2. the same click with NSO_seatRayOrigins stubbed back to the bare corners ---');
  await page.evaluate(() => {
    window.__realOrigins = NSO_seatRayOrigins;
    NSO_seatRayOrigins = function (corners) { return corners.map(c => c.clone()); };
  });
  await clickSeat(page);
  b = await pose(page, idB);
  console.log('  status: ' + b.status);
  check('without the inset the seat refuses, exactly as the handoff reported', MISSED_RE.test(b.status), b.status);
  check('... and the bit has not moved', b.pos.every((v, i) => v === bedPose.pos[i]) && b.liftY === bedPose.liftY, JSON.stringify(b.pos));
  await page.evaluate(() => { NSO_seatRayOrigins = window.__realOrigins; delete window.__realOrigins; });
  await page.click('#btn-undo');

  /* ---------- 3. Seat (support) at -0.18, side by side ---------- */
  console.log('\n--- 3. Seat (support) at -0.18 with the shipped code ---');
  const beforeSeat = await pose(page, idB);
  check('undo put the bit back on the bed where the drag left it',
    beforeSeat.pos.every((v, i) => v === bedPose.pos[i]) && beforeSeat.liftY === 0, JSON.stringify(beforeSeat.pos));
  await clickSeat(page);
  a = await pose(page, idA); b = await pose(page, idB);
  console.log('  status: ' + b.status + '\n  bit box ' + JSON.stringify([b.min, b.max]));
  check('status is the clean seat line (no "held at plate level", no "skin tips")', b.status === SEATED_18, b.status);
  check('bit mating face is 0.18 mm off the hull\'s +X wall (2e-6)', near(b.min[0] - a.max[0], 0.18, 2e-6), b.min[0] - a.max[0]);
  check('the bit is still ON THE BED: bottom === the hull\'s, liftY 0', b.min[1] === a.min[1] && b.liftY === 0, b.min[1] + ' / ' + b.liftY);
  check('Z and the quaternion are untouched - a horizontal seat moves X only',
    near(b.z, beforeSeat.z, 1e-9) && b.pos[1] === beforeSeat.pos[1] && b.quat.every((v, i) => near(v, [0, 0, 0, 1][i], 1e-12)),
    JSON.stringify([b.z, b.pos[1]]));
  check('hull is untouched by the seat', a.liftY === 0 && near(a.max[0], 40, 1e-9), JSON.stringify(a.max));
  check('one undo entry was pushed', b.undoDepth === beforeSeat.undoDepth + 1, b.undoDepth - beforeSeat.undoDepth);
  const seated = b;
  await clickSeat(page);
  b = await pose(page, idB);
  check('Seat again from the seated pose: same status, pose ===',
    b.status === SEATED_18 && b.pos.every((v, i) => v === seated.pos[i]) && b.liftY === seated.liftY, b.status + ' ' + JSON.stringify(b.pos));
  await page.click('#btn-undo');
  b = await pose(page, idB);
  check('Undo returns the bit to the seated pose exactly', b.pos.every((v, i) => v === seated.pos[i]), JSON.stringify(b.pos));

  /* ---------- 4. the exported file, through the canonical checker ---------- */
  console.log('\n--- 4. plate export, mesh_validate.py --json ---');
  const stl18 = path.join(tmp, 'seat_side_-0.18.stl');
  fs.writeFileSync(stl18, Buffer.from(await page.evaluate(exportPlate), 'base64'));
  const v18 = meshValidate(stl18);
  console.log('  mesh_validate: tris ' + v18.triangles + ', open ' + v18.open_edges + ', nonmanifold ' + v18.nonmanifold_edges +
    ', volume ' + v18.signed_volume.toFixed(3) + ', bbox_size ' + JSON.stringify(v18.bbox_size) +
    ', pierce ' + v18.self_intersection.pierce + ', coplanar ' + v18.self_intersection.coplanar);
  check('export holds both shells (28 + 12 triangles)', v18.triangles === 40, v18.triangles);
  check('export is watertight: 0 open, 0 non-manifold edges', v18.open_edges === 0 && v18.nonmanifold_edges === 0);
  check('export volume is hull + bit exactly (two disjoint shells)', near(v18.signed_volume, hullVol + bitVol, 1e-3), v18.signed_volume);
  check('canonical checker: 0 piercing pairs', v18.self_intersection.pierce === 0, v18.self_intersection.pierce);
  check('canonical checker: 0 coplanar contact (an air gap, not flush)', v18.self_intersection.coplanar === 0, v18.self_intersection.coplanar);
  check('export width is 80 + 0.18 + 20 = 100.18 (1e-5)', near(v18.bbox_size[0], 100.18, 1e-5), v18.bbox_size[0]);
  check('export height is one piece tall, 20 - nothing was stacked (1e-5)', near(v18.bbox_size[2], 20, 1e-5), v18.bbox_size[2]);
  const sh18 = shells(parseBinarySTL(fs.readFileSync(stl18)), 0);
  check('export splits into exactly two shells', sh18.length === 2, sh18.length);
  if (sh18.length === 2) {
    const gapSTL = sh18[1].lo - sh18[0].hi;
    console.log('  STL shells along X: hull ' + sh18[0].lo + '..' + sh18[0].hi + ', bit ' + sh18[1].lo + '..' + sh18[1].hi + ', gap ' + gapSTL);
    check('measured air gap in the exported STL is 0.18 mm (1e-5)', near(gapSTL, 0.18, 1e-5), gapSTL);
  }
  const zs = shells(parseBinarySTL(fs.readFileSync(stl18)), 2);
  check('both exported shells rest on z = 0 (1e-5)', zs.length === 2 && near(zs[0].lo, 0, 1e-5) && near(zs[1].lo, 0, 1e-5),
    JSON.stringify(zs.map(s => s.lo)));

  /* ---------- 5. the other gaps, and the other three walls ---------- */
  console.log('\n--- 5. gap -0.05 and gap 0 through the slider ---');
  await setSlider(page, '-0.05');
  await clickSeat(page);
  a = await pose(page, idA); b = await pose(page, idB);
  check('-0.05 seats: status and 0.05 mm off the wall (2e-6)',
    /^Seated - air gap 0\.05mm \(measured -0\.050mm/.test(b.status) && near(b.min[0] - a.max[0], 0.05, 2e-6), b.status);
  const stl05 = path.join(tmp, 'seat_side_-0.05.stl');
  fs.writeFileSync(stl05, Buffer.from(await page.evaluate(exportPlate), 'base64'));
  const v05 = meshValidate(stl05);
  const sh05 = shells(parseBinarySTL(fs.readFileSync(stl05)), 0);
  check('-0.05 export: 0 piercing, 0 coplanar, width 100.05, shells 0.05 apart (1e-5)',
    v05.self_intersection.pierce === 0 && v05.self_intersection.coplanar === 0 && near(v05.bbox_size[0], 100.05, 1e-5)
      && sh05.length === 2 && near(sh05[1].lo - sh05[0].hi, 0.05, 1e-5),
    JSON.stringify({ w: v05.bbox_size[0], shells: sh05.length, gap: sh05.length === 2 ? sh05[1].lo - sh05[0].hi : null }));

  await setSlider(page, '0');
  await clickSeat(page);
  a = await pose(page, idA); b = await pose(page, idB);
  check('0 seats touching: mating face on the wall (2e-6)',
    /^Seated - touching, gap 0\.00mm/.test(b.status) && near(b.min[0] - a.max[0], 0, 2e-6), b.status);
  const stl0 = path.join(tmp, 'seat_side_0.stl');
  fs.writeFileSync(stl0, Buffer.from(await page.evaluate(exportPlate), 'base64'));
  const v0 = meshValidate(stl0);
  console.log('  mesh_validate: pierce ' + v0.self_intersection.pierce + ', coplanar ' + v0.self_intersection.coplanar +
    ', bbox_size ' + JSON.stringify(v0.bbox_size));
  check('0 export: coplanar contact present (touching), width 100.00 (1e-5)',
    v0.self_intersection.coplanar > 0 && near(v0.bbox_size[0], 100, 1e-5), JSON.stringify(v0.bbox_size));
  await setSlider(page, '-0.18');

  console.log('\n--- 5b. the same seat against each of the four walls ---');
  const walls = [
    { name: '+X', to: h => [h.max[0] + 13, 0], face: (bb, h) => bb.min[0] - h.max[0] },
    { name: '-X', to: h => [h.min[0] - 13, 0], face: (bb, h) => h.min[0] - bb.max[0] },
    { name: '+Z', to: h => [0, h.max[2] + 13], face: (bb, h) => bb.min[2] - h.max[2] },
    { name: '-Z', to: h => [0, h.min[2] - 13], face: (bb, h) => h.min[2] - bb.max[2] }
  ];
  for (const w of walls) {
    await page.evaluate(id => { const p = state.placed.find(q => q && q.sourceId === id); p.liftY = 0; settlePlacedOnBed(p); }, idB);
    const [wx, wz] = w.to(a);
    await dragTo(page, idB, wx, wz);
    const pre = await pose(page, idB);
    await clickSeat(page);
    a = await pose(page, idA); b = await pose(page, idB);
    check(w.name + ' wall: clean seat, mating face 0.18 mm off it (2e-6), bit still on the bed',
      b.status === SEATED_18 && near(w.face(b, a), 0.18, 2e-6) && b.min[1] === a.min[1] && b.liftY === 0,
      b.status + ' | face ' + w.face(b, a) + ' | bottom ' + b.min[1]);
    check(w.name + ' wall: the seat moved the bit along that axis only',
      (w.name[1] === 'X' ? near(b.z, pre.z, 1e-9) : near(b.x, pre.x, 1e-9)) && b.pos[1] === pre.pos[1],
      JSON.stringify([b.x, b.z]));
  }

  /* ---------- 6. Seat flush side by side: the side plug ---------- */
  console.log('\n--- 6. Seat flush from the bed, beside the hull ---');
  await page.evaluate(id => { const p = state.placed.find(q => q && q.sourceId === id); p.liftY = 0; settlePlacedOnBed(p); }, idB);
  await dragTo(page, idB, a.max[0] + 13, 0);
  await clickFlush(page);
  a = await pose(page, idA); b = await pose(page, idB);
  console.log('  status: ' + b.status + '\n  bit box ' + JSON.stringify([b.min, b.max]));
  check('Seat flush side by side: golden flush status', b.status === GOLDEN_FLUSH_STATUS, b.status);
  check('... outer face 0.01 mm proud of the wall, body inside the hull - the side plug (2e-6)',
    near(b.max[0] - a.max[0], 0.01, 2e-6) && b.min[0] > a.min[0], (b.max[0] - a.max[0]) + ' / ' + b.min[0]);
  check('... and it stayed on the bed', b.min[1] === a.min[1] && b.liftY === 0, b.min[1]);

  /* ---------- 7. a bit the wall cuts through is still refused, from the bed ---------- */
  console.log('\n--- 7. the overhang gate, on a bed-level straddle ---');
  await page.evaluate(id => { const p = state.placed.find(q => q && q.sourceId === id); p.liftY = 0; settlePlacedOnBed(p); }, idB);
  await dragTo(page, idB, a.max[0] - 4, 0);   /* 6 mm proud of the wall, 14 mm already inside */
  const straddlePre = await pose(page, idB);
  check('staged across the +X wall: 6 mm proud, the rest inside (1e-9)',
    near(straddlePre.max[0] - a.max[0], 6, 1e-9) && straddlePre.min[0] < a.max[0], straddlePre.max[0] - a.max[0]);
  const stlPre = await page.evaluate(exportPlate);
  await clickSeat(page);
  let s = await pose(page, idB);
  console.log('  status: ' + s.status);
  check('the seat refuses and names the millimetres at stake',
    /^Seat failed - bit straddles that hull face - 6\.00mm of it stands proud/.test(s.status), s.status);
  check('... nothing moved, and the plate export is identical across the click',
    s.pos.every((v, i) => v === straddlePre.pos[i]) && s.liftY === straddlePre.liftY &&
    (await page.evaluate(exportPlate)) === stlPre, JSON.stringify(s.pos));
  await clickFlush(page);
  s = await pose(page, idB);
  check('Seat flush refuses the same pose the same way',
    /^Seat failed - bit straddles that hull face - 6\.00mm of it stands proud/.test(s.status) &&
    s.pos.every((v, i) => v === straddlePre.pos[i]), s.status);

  /* ---------- 8. the bed-epsilon clamp still catches a real sink ---------- */
  console.log('\n--- 8. "held at plate level" - noise vs a real sink ---');
  await page.evaluate(id => { const p = state.placed.find(q => q && q.sourceId === id); p.liftY = 0; settlePlacedOnBed(p); }, idB);
  await dragTo(page, idB, a.max[0] + 13, 0);
  const sink = async drop => {
    await page.evaluate(d => {
      window.__realSeat = NSO_seatFlushBitToHull;
      NSO_seatFlushBitToHull = function (hullMesh, bitMesh, opts) {
        const r = window.__realSeat(hullMesh, bitMesh, opts);
        if (r && r.ok) { bitMesh.position.y -= d; bitMesh.updateMatrixWorld(true); }
        return r;
      };
    }, drop);
    await clickSeat(page);
    const p = await pose(page, idB);
    await page.evaluate(() => { NSO_seatFlushBitToHull = window.__realSeat; delete window.__realSeat; });
    await page.click('#btn-undo');
    return p;
  };
  const tiny = await sink(1e-9);
  check('a bit dropped by 1e-9 mm - Float noise at the bed baseline - seats clean', tiny.status === SEATED_18, tiny.status);
  const real = await sink(1);
  check('a bit really pushed 1 mm into the plate still says so',
    /held at plate level: gap NOT as requested$/.test(real.status), real.status);

  /* ---------- 9. what the inset is, measured on a real frame ---------- */
  console.log('\n--- 9. the inset moves the sample point and nothing else ---');
  await page.evaluate(id => { const p = state.placed.find(q => q && q.sourceId === id); p.liftY = 0; settlePlacedOnBed(p); }, idB);
  await dragTo(page, idB, a.max[0] + 13, 0);
  const geom = await page.evaluate(([idA, idB]) => {
    const A = state.placed.find(p => p.sourceId === idA), B = state.placed.find(p => p.sourceId === idB);
    A.mesh.updateMatrixWorld(true); B.mesh.updateMatrixWorld(true);
    const hull = meshToWorldSoup(A.mesh);
    if (!A.mesh.geometry.boundingBox) A.mesh.geometry.computeBoundingBox();
    const hc = new THREE.Vector3(); A.mesh.geometry.boundingBox.getCenter(hc); hc.applyMatrix4(A.mesh.matrixWorld);
    const fr = NSO_plugFrame(B.mesh, hc, hull);
    const corners = NSO_outerFaceCorners(fr);
    const origins = NSO_seatRayOrigins(corners);
    const mid = new THREE.Vector3();
    for (const c of corners) mid.add(c);
    mid.multiplyScalar(0.25);
    return {
      inset: NSO_SEAT_RAY_INSET,
      bedEps: NSO_SEAT_BED_EPS,
      straddleTol: NSO_SEAT_STRADDLE_TOL,
      alongNormal: origins.map((o, i) => o.clone().sub(corners[i]).dot(fr.outerNormal)),
      moved: origins.map((o, i) => o.distanceTo(corners[i])),
      closer: origins.map((o, i) => mid.distanceTo(corners[i]) - mid.distanceTo(o)),
      hitsCorner: corners.map(c => !!NSO_nearestSkinHit(hull, c, fr.punch)),
      hitsInset: origins.map(o => !!NSO_nearestSkinHit(hull, o, fr.punch))
    };
  }, [idA, idB]);
  console.log('  ' + JSON.stringify(geom));
  check('the inset is 1 micron, far under the seat\'s own tolerances',
    geom.inset === 0.001 && geom.inset * 100 <= geom.straddleTol && geom.bedEps <= 1e-6, JSON.stringify([geom.inset, geom.straddleTol, geom.bedEps]));
  check('every ray origin keeps its corner\'s offset along the punch axis (1e-12)',
    geom.alongNormal.every(v => Math.abs(v) <= 1e-12), JSON.stringify(geom.alongNormal));
  check('every ray origin moved the inset, toward the face centre',
    geom.moved.every(v => near(v, 0.001, 1e-12)) && geom.closer.every(v => v > 0), JSON.stringify(geom.moved));
  check('on this pose the bare corners miss and the inset origins hit - the whole defect',
    geom.hitsCorner.some(h => !h) && geom.hitsInset.every(h => h), JSON.stringify([geom.hitsCorner, geom.hitsInset]));

  /* ---------- 10. the sweep the inset was measured from, pinned ---------- */
  /* docs/HANDOFF.md carried this as an audit number. It is a gate here for the
     same reason every other measurement in this project is one: 0.001 mm is
     only defensible while the band it was chosen from still holds. Four walls
     x five distances off the wall x three slides along it. The third slide
     hangs the bit 3 mm past the hull's own +Z edge on the +-X walls - that is
     a real overhang, and it must go on refusing however big the inset gets,
     so the sweep pins the refusals as tightly as the rescues.
     It is corner-ray arithmetic over real staged poses rather than 60 clicks:
     the staging goes through the app's own nudge/settle path, so the bed
     baseline is the one the seat sees, and the whole sweep is a single page
     round trip. */
  console.log('\n--- 10. the 60-placement sweep the inset was measured from ---');
  const SWEEP_DISTS = [0, 0.18, 1, 3, 10];             /* mm clear of the wall */
  const SWEEP_SLIDES = [0, -6, 13];                    /* along it; 13 overhangs the +-X walls */
  const SWEEP_INSETS = [0, 1e-9, 1e-7, 1e-5, 0.001, 0.01];
  const BIT_DEPTH = 20;                                /* box-20mm, along whichever axis it punches */
  const sweep = await page.evaluate(([idA, idB, dists, slides, insets]) => {
    const A = state.placed.find(p => p && p.sourceId === idA);
    const B = state.placed.find(p => p && p.sourceId === idB);
    A.mesh.updateMatrixWorld(true);
    const hb = new THREE.Box3().setFromObject(A.mesh);
    if (!A.mesh.geometry.boundingBox) A.mesh.geometry.computeBoundingBox();
    const hc = new THREE.Vector3();
    A.mesh.geometry.boundingBox.getCenter(hc);
    hc.applyMatrix4(A.mesh.matrixWorld);

    const walls = [
      { name: '+X', slide: 'z', at: (d, s) => [hb.max.x + 10 + d, s], face: bb => bb.min.x - hb.max.x },
      { name: '-X', slide: 'z', at: (d, s) => [hb.min.x - 10 - d, s], face: bb => hb.min.x - bb.max.x },
      { name: '+Z', slide: 'x', at: (d, s) => [s, hb.max.z + 10 + d], face: bb => bb.min.z - hb.max.z },
      { name: '-Z', slide: 'x', at: (d, s) => [s, hb.min.z - 10 - d], face: bb => hb.min.z - bb.max.z }
    ];
    const shipped = NSO_SEAT_RAY_INSET;
    const out = [];
    try {
      for (const w of walls) for (const d of dists) for (const s of slides) {
        /* stage through the app: settle on the bed, then its own move primitive */
        B.liftY = 0;
        settlePlacedOnBed(B);
        const at = w.at(d, s);
        selectPlaced(state.placed.indexOf(B));
        nudgeSelected(at[0] - B.x, at[1] - B.z);
        B.mesh.updateMatrixWorld(true);
        const bb = new THREE.Box3().setFromObject(B.mesh);
        const hull = meshToWorldSoup(A.mesh);
        const k = w.slide;
        const per = [];
        for (const ins of insets) {
          NSO_SEAT_RAY_INSET = ins;
          const fr = NSO_plugFrame(B.mesh, hc, hull);
          const origins = NSO_seatRayOrigins(NSO_outerFaceCorners(fr));
          let hits = 0;
          const ds = [];
          for (let i = 0; i < 4; i++) {
            const h = NSO_nearestSkinHit(hull, origins[i], fr.punch);
            if (h) { hits++; ds.push(origins[i].clone().sub(h).dot(fr.outerNormal)); }
          }
          per.push({ inset: ins, hits: hits, ds: ds, straddle: !!NSO_seatStraddle(hull, B.mesh, hc, -0.18) });
        }
        NSO_SEAT_RAY_INSET = shipped;
        out.push({
          wall: w.name, d: d, s: s,
          over: bb.min[k] < hb.min[k] - 1e-9 || bb.max[k] > hb.max[k] + 1e-9,
          staged: w.face(bb), bed: bb.min.y === hb.min.y, per: per
        });
      }
    } finally { NSO_SEAT_RAY_INSET = shipped; }
    return { rows: out, insetRestored: NSO_SEAT_RAY_INSET };
  }, [idA, idB, SWEEP_DISTS, SWEEP_SLIDES, SWEEP_INSETS]);

  const rows = sweep.rows;
  const at = i => rows.map(r => r.per[i]);
  const overRows = rows.filter(r => r.over);
  for (let i = 0; i < SWEEP_INSETS.length; i++) {
    const p = at(i);
    console.log('  inset ' + String(SWEEP_INSETS[i]).padEnd(8) +
      ' all four rays: ' + String(p.filter(x => x.hits === 4).length).padEnd(3) +
      ' lost at least one: ' + String(p.filter(x => x.hits < 4).length).padEnd(3) +
      ' straddle flags: ' + p.filter(x => x.straddle).length);
  }

  check('the sweep is 60 placements: 4 walls x 5 distances x 3 slides',
    rows.length === SWEEP_DISTS.length * SWEEP_SLIDES.length * 4, rows.length);
  check('every placement is staged at the distance asked, on the bed baseline (1e-9)',
    rows.every(r => near(r.staged, r.d, 1e-9) && r.bed),
    rows.filter(r => !(near(r.staged, r.d, 1e-9) && r.bed)).map(r => r.wall + '/d' + r.d + '/s' + r.s).slice(0, 4).join(' '));
  check('exactly 10 of them hang past the target face - the +-X walls at the 13 mm slide',
    overRows.length === 10 && overRows.every(r => r.wall[1] === 'X' && r.s === 13),
    overRows.length + ': ' + overRows.map(r => r.wall + '/d' + r.d).join(' '));

  /* the defect, at the two insets that do not rescue it */
  for (const ins of [0, 1e-9]) {
    const i = SWEEP_INSETS.indexOf(ins);
    check('at a ' + ins + ' inset every one of the 60 loses at least one corner ray',
      at(i).every(x => x.hits < 4), at(i).filter(x => x.hits === 4).length + ' unexpectedly kept all four');
  }

  /* the rescue, at every inset from 1e-7 up - and the refusals it must not touch */
  const RESCUING = SWEEP_INSETS.filter(v => v >= 1e-7);
  for (const ins of RESCUING) {
    const i = SWEEP_INSETS.indexOf(ins);
    const p = at(i);
    check('at a ' + ins + ' inset the 50 placements over the target face recover all four rays',
      rows.filter((r, n) => !r.over && p[n].hits === 4).length === 50,
      rows.filter((r, n) => !r.over && p[n].hits < 4).map(r => r.wall + '/d' + r.d + '/s' + r.s).slice(0, 4).join(' '));
    check('... and the 10 that overhang it still refuse - an inset rescues a graze, never an overhang',
      rows.every((r, n) => !r.over || p[n].hits < 4),
      rows.filter((r, n) => r.over && p[n].hits === 4).map(r => r.wall + '/d' + r.d).join(' '));
    check('... every recovered ray measures the NEAR wall, d = 20 + the staged distance (1e-6)',
      rows.every((r, n) => p[n].hits < 4 || p[n].ds.every(v => near(v, BIT_DEPTH + r.d, 1e-6))),
      JSON.stringify(rows.filter((r, n) => p[n].hits === 4 && p[n].ds.some(v => !near(v, BIT_DEPTH + r.d, 1e-6)))
        .map(r => r.wall + '/d' + r.d).slice(0, 4)));
  }

  /* the thing to get wrong: a side-by-side pose is never a straddle */
  check('0 straddle flags across all 60 placements at every inset from 0 to 0.01',
    rows.every(r => r.per.every(x => !x.straddle)),
    rows.filter(r => r.per.some(x => x.straddle)).map(r => r.wall + '/d' + r.d + '/s' + r.s).slice(0, 4).join(' '));
  check('the shipped inset sits inside the band the sweep recovers on',
    RESCUING.includes(geom.inset) && geom.inset === 0.001,
    geom.inset);
  check('the sweep put the shipped inset back', sweep.insetRestored === geom.inset, sweep.insetRestored);

  /* ---------- 11. the vertical case the side seat must not have cost ---------- */
  console.log('\n--- 11. stacking still works: the bit dragged OVER the hull ---');
  await page.evaluate(id => { const p = state.placed.find(q => q && q.sourceId === id); p.liftY = 0; settlePlacedOnBed(p); }, idB);
  await dragTo(page, idB, a.x, a.z);
  await clickSeat(page);
  a = await pose(page, idA); b = await pose(page, idB);
  check('Seat (support) still stacks: 0.18 above the hull top, liftY 20.18 (2e-6)',
    b.status === SEATED_18 && near(b.min[1] - a.max[1], 0.18, 2e-6) && near(b.liftY, 20.18, 2e-6), b.status + ' ' + (b.min[1] - a.max[1]));

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
  check('no page errors', errs.length === 0, errs.join(' | '));

  console.log('\nfiles: ' + tmp);
  console.log('\n' + (fails ? fails + ' gate(s) FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(2); });
