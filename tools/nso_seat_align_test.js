/* Vertical stacking: Seat (support) from the bed, then Align edges, proven
   through the real app and the canonical checker.
     node tools/nso_seat_align_test.js        exit 0 = every gate held

   Hull = fixtures/box_hull_80x40x20-2.stl (80 x 40, 20 tall on the plate),
   bit = fixtures/box-20mm.stl. Unlike tools/nso_seat_gap_test.js, the bit is
   NOT staged in the air: it is dragged over the hull along the bed the way a
   user does it (drag never lifts), so it starts buried in the hull. That is
   the live report - "Seat (support) does not seat at all when stacking" -
   and, after a Seat had worked, "Align edges sinks the top piece to the
   plate".

   What is pinned:
   1. The buried start seats: Seat (support) at -0.18 lifts the bit clear and
      lands its underside 0.18 mm above the hull's top, status line clean (no
      "from skin tips", no "held at plate level"). Undo puts it back on the
      bed. The same from a bit Raised part-way, and from a part shorter than
      the hull (the case that used to read "held at plate level").
   2. Align edges after the seat keeps the seated Z relation EXACTLY: mesh y,
      liftY and the world box bottom are === what Seat left, while XZ snaps
      the bit's edge flush with the hull's edge as Align always did. Seat
      again after Align: the same pose, ===. Align again: unchanged.
   3. The file the slicer gets after Align, through tools/mesh_validate.py
      --json: two closed shells, 0 piercing, 0 coplanar, the shells 0.18 mm
      apart, 3MF objects the same - the Seat-gap gates, after Align.
   4. A second real gap, -0.05, and touching (0), through the slider: each
      survives Align with its own export signature.
   5. Join's own Align is unchanged: two pieces on the bed side by side snap
      to the pre-change pose to 1e-9, both bottoms on 0.2.
   6. Seat flush from the buried start gives the flush plug seat's golden
      relation and status. A seat that fails puts the bit back exactly. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');
const { openJoin } = require('./nso_join_card');

const fx = f => path.join(ROOT, 'fixtures', f);
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const SEATED_18 = 'Seated - air gap 0.18mm (measured -0.180mm, skin error 0.00mm)';
const GOLDEN_FLUSH_STATUS = 'Seated - proud 0.01mm, skin error 0.00mm - Subtract';

/* ---- STL helpers, stdlib only (as in nso_seat_gap_test.js) ---- */
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
function shells(tris) {
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
    let zmin = Infinity, zmax = -Infinity;
    for (const t of list) for (const v of t) { if (v[2] < zmin) zmin = v[2]; if (v[2] > zmax) zmax = v[2]; }
    return { tris: list.length, zmin, zmax };
  }).sort((a, b) => a.zmin - b.zmin);
}
function meshValidate(file) {
  const out = execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out);
}

/* ---- in-page helpers ---- */
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
const setLift = (page, id, v) => page.evaluate(([id, v]) => {
  const p = state.placed.find(q => q && q.sourceId === id);
  p.liftY = v; applyMeshRotation(p);
}, [id, v]);
const selectRow = (page, id) => page.click(`.model-item[data-edit-id="${id}"]`);
async function joinAB(page, idA, idB) {
  await openJoin(page);
  await page.click('#join-slot-a'); await selectRow(page, idA);
  await page.click('#join-slot-b'); await selectRow(page, idB);
  return page.evaluate(() => ({ session: state.joinSession, a: state.editId, b: state.joinPartnerId }));
}
async function setSlider(page, value) {
  await page.evaluate(v => {
    const el = document.getElementById('seat-gap');
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}
async function clickSeat(page) { await clearStatus(page); await page.click('#btn-seat-support'); await waitStatus(page, /^Seated|^Seat /); }
async function clickAlign(page) { await clearStatus(page); await page.click('#btn-join-align'); await waitStatus(page, /^Aligned|^Align /); }
const exportPlate = () => {
  const geo = buildCombinedGeometry();
  const buf = geometryToBinarySTL(geo);
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  let mf = null;
  if (window.NSO3MF && typeof buildPlacedObjects3MF === 'function') {
    mf = buildPlacedObjects3MF().map(o => {
      let zmin = Infinity, zmax = -Infinity;
      for (let i = 2; i < o.vertices.length; i += 3) { const z = o.vertices[i]; if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
      return { name: o.name, zmin, zmax };
    }).sort((p, q) => p.zmin - q.zmin);
  }
  return { stl: btoa(bin), mf };
};
const sameZ = (p, q) => p.pos[1] === q.pos[1] && p.liftY === q.liftY && p.min[1] === q.min[1] && p.max[1] === q.max[1];
const zDetail = (p, q) => 'y ' + p.pos[1] + ' vs ' + q.pos[1] + ', liftY ' + p.liftY + ' vs ' + q.liftY + ', bottom ' + p.min[1] + ' vs ' + q.min[1];

withApp(async (page, logs) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-seat-align-'));
  const hullVol = meshValidate(fx('box_hull_80x40x20-2.stl')).signed_volume;
  const bitVol = meshValidate(fx('box-20mm.stl')).signed_volume;
  const idA = await loadSTL(page, fx('box_hull_80x40x20-2.stl'));
  const idB = await loadSTL(page, fx('box-20mm.stl'));
  const j = await joinAB(page, idA, idB);
  check('Join session holds A = hull, B = bit', j.session && j.a === idA && j.b === idB, JSON.stringify(j));
  check('slider is at its -0.18 default', (await page.evaluate(() => document.getElementById('seat-gap').value)) === '-0.18');

  /* ---------- 1. the live flow: drag B over A along the bed, Seat (support) ---------- */
  console.log('\n--- 1. bit dragged over the hull along the bed (buried), Seat (support) at -0.18 ---');
  let a = await pose(page, idA);
  await dragTo(page, idB, a.x, a.z);
  let b = await pose(page, idB);
  check('drag leaves the bit on the bed, buried in the hull (bottom 0.2, inside the footprint)',
    near(b.min[1], 0.2, 1e-9) && b.min[0] > a.min[0] && b.max[0] < a.max[0] && b.min[2] > a.min[2] && b.max[2] < a.max[2],
    JSON.stringify([b.min, b.max]));
  const bedPose = b;
  await clickSeat(page);
  a = await pose(page, idA); b = await pose(page, idB);
  console.log('  status: ' + b.status);
  check('status is the clean seat line (no "skin tips", no "held at plate level")', b.status === SEATED_18, b.status);
  check('bit underside is 0.18 mm above the hull top (2e-6)', near(b.min[1] - a.max[1], 0.18, 2e-6), b.min[1] - a.max[1]);
  check('bit liftY is hull-relative: 20.18 (2e-6)', near(b.liftY, 20.18, 2e-6), b.liftY);
  check('bit is upright and still centred on the hull (XZ untouched by the seat)',
    b.quat.every((v, i) => near(v, [0, 0, 0, 1][i], 1e-12)) && near(b.x, a.x, 1e-9) && near(b.z, a.z, 1e-9), JSON.stringify([b.x, b.z]));
  check('hull settled on the bed baseline, not lifted', near(a.pos[1], 10.2, 1e-9) && a.liftY === 0, a.pos[1]);
  check('one undo entry was pushed', b.undoDepth === bedPose.undoDepth + 1, b.undoDepth - bedPose.undoDepth);
  await page.click('#btn-undo');
  b = await pose(page, idB);
  check('Undo puts the bit back on the bed exactly where the drag left it',
    b.pos.every((v, i) => v === bedPose.pos[i]) && b.liftY === 0, JSON.stringify(b.pos));

  // the same from a bit Raised part-way into the hull (underside still below the top)
  await setLift(page, idB, 6);
  b = await pose(page, idB);
  check('staged: bit lifted 6, top still inside the hull', near(b.min[1], 6.2, 1e-9) && b.max[1] < a.max[1] + 10, JSON.stringify(b.min));
  await clickSeat(page);
  a = await pose(page, idA); b = await pose(page, idB);
  check('Seat from a part-way lift: same clean seat, 0.18 above the hull (2e-6)', b.status === SEATED_18 && near(b.min[1] - a.max[1], 0.18, 2e-6), b.status + ' ' + (b.min[1] - a.max[1]));
  const seated = b;

  /* ---------- 2. Align edges after the seat: Z survives exactly ---------- */
  console.log('\n--- 2. Align edges on the stacked bit ---');
  await clickAlign(page);
  a = await pose(page, idA); b = await pose(page, idB);
  console.log('  status: ' + b.status + ' - bit box ' + JSON.stringify([b.min, b.max]));
  check('Align reports success', /^Aligned/.test(b.status), b.status);
  check('seated Z relation survives EXACTLY (mesh y, liftY, box bottom/top all ===)', sameZ(b, seated), zDetail(b, seated));
  check('bit underside still 0.18 mm above the hull top (2e-6)', near(b.min[1] - a.max[1], 0.18, 2e-6), b.min[1] - a.max[1]);
  check('Align moved the bit in plan: its -Z edge flush with the hull\'s -Z edge, X unchanged',
    near(b.min[2], a.min[2], 1e-9) && near(b.x, seated.x, 1e-9), JSON.stringify([b.min[2], a.min[2], b.x]));
  check('hull untouched by Align (bed baseline, no lift)', near(a.pos[1], 10.2, 1e-9) && a.liftY === 0, a.pos[1]);
  const aligned = b;

  // Seat again after Align, then Align again: nothing moves
  await clickSeat(page);
  b = await pose(page, idB);
  check('Seat (support) again after Align: same status, same pose ===', b.status === SEATED_18 && sameZ(b, aligned) && b.x === aligned.x && b.z === aligned.z, b.status + ' ' + zDetail(b, aligned));
  await clickAlign(page);
  b = await pose(page, idB);
  check('Align again: pose unchanged ===', sameZ(b, aligned) && b.x === aligned.x && b.z === aligned.z, zDetail(b, aligned));

  /* ---------- 3. the file after Align, through the canonical checker ---------- */
  console.log('\n--- 3. plate export after Align, mesh_validate.py --json ---');
  const exp18 = await page.evaluate(exportPlate);
  const stl18 = path.join(tmp, 'seat_align_-0.18.stl');
  fs.writeFileSync(stl18, Buffer.from(exp18.stl, 'base64'));
  const v18 = meshValidate(stl18);
  console.log('  mesh_validate: tris ' + v18.triangles + ', open ' + v18.open_edges + ', nonmanifold ' + v18.nonmanifold_edges +
    ', volume ' + v18.signed_volume.toFixed(3) + ', bbox_size ' + JSON.stringify(v18.bbox_size) +
    ', pierce ' + v18.self_intersection.pierce + ', coplanar ' + v18.self_intersection.coplanar);
  check('export holds both shells (28 + 12 triangles)', v18.triangles === 40, v18.triangles);
  check('export is watertight: 0 open, 0 non-manifold edges', v18.open_edges === 0 && v18.nonmanifold_edges === 0);
  check('export volume is hull + bit exactly (two disjoint shells)', near(v18.signed_volume, hullVol + bitVol, 1e-3), v18.signed_volume);
  check('canonical checker: 0 piercing pairs', v18.self_intersection.pierce === 0, v18.self_intersection.pierce);
  check('canonical checker: 0 coplanar contact (an air gap, not flush)', v18.self_intersection.coplanar === 0, v18.self_intersection.coplanar);
  check('export height is 20 + 0.18 + 20 = 40.18 (1e-5)', near(v18.bbox_size[2], 40.18, 1e-5), v18.bbox_size[2]);
  const sh18 = shells(parseBinarySTL(fs.readFileSync(stl18)));
  check('export splits into exactly two shells', sh18.length === 2, sh18.length);
  if (sh18.length === 2) {
    const gapSTL = sh18[1].zmin - sh18[0].zmax;
    console.log('  STL shells: hull z ' + sh18[0].zmin + '..' + sh18[0].zmax + ', bit z ' + sh18[1].zmin + '..' + sh18[1].zmax + ', gap ' + gapSTL);
    check('exported hull rests on the plate (z 0)', near(sh18[0].zmin, 0, 1e-5), sh18[0].zmin);
    check('measured air gap in the exported STL is 0.18 mm (1e-5)', near(gapSTL, 0.18, 1e-5), gapSTL);
  }
  if (exp18.mf) {
    const gap3 = exp18.mf[1].zmin - exp18.mf[0].zmax;
    check('3MF objects carry the same 0.18 mm gap (1e-5)', exp18.mf.length === 2 && near(gap3, 0.18, 1e-5), gap3);
  } else {
    check('3MF object builder available', false, 'NSO3MF missing');
  }

  /* ---------- 4. other real gaps through the slider: -0.05 and touching ---------- */
  console.log('\n--- 4. gap -0.05 and gap 0 through the slider, each followed by Align ---');
  await setSlider(page, '-0.05');
  await clickSeat(page);
  a = await pose(page, idA); b = await pose(page, idB);
  check('-0.05 seats: status and 0.05 mm above the hull (2e-6)', /^Seated - air gap 0\.05mm \(measured -0\.050mm/.test(b.status) && near(b.min[1] - a.max[1], 0.05, 2e-6), b.status);
  const s05 = b;
  await clickAlign(page);
  b = await pose(page, idB);
  check('-0.05 survives Align exactly', /^Aligned/.test(b.status) && sameZ(b, s05), zDetail(b, s05));
  const exp05 = await page.evaluate(exportPlate);
  const stl05 = path.join(tmp, 'seat_align_-0.05.stl');
  fs.writeFileSync(stl05, Buffer.from(exp05.stl, 'base64'));
  const v05 = meshValidate(stl05);
  const sh05 = shells(parseBinarySTL(fs.readFileSync(stl05)));
  console.log('  mesh_validate: pierce ' + v05.self_intersection.pierce + ', coplanar ' + v05.self_intersection.coplanar + ', bbox_size ' + JSON.stringify(v05.bbox_size));
  check('-0.05 export after Align: 0 piercing, 0 coplanar, height 40.05, shells 0.05 apart (1e-5)',
    v05.self_intersection.pierce === 0 && v05.self_intersection.coplanar === 0 && near(v05.bbox_size[2], 40.05, 1e-5)
      && sh05.length === 2 && near(sh05[1].zmin - sh05[0].zmax, 0.05, 1e-5),
    JSON.stringify({ h: v05.bbox_size[2], shells: sh05.length, gap: sh05.length === 2 ? sh05[1].zmin - sh05[0].zmax : null }));

  await setSlider(page, '0');
  await clickSeat(page);
  a = await pose(page, idA); b = await pose(page, idB);
  check('0 seats touching: mating face on the hull skin (2e-6)', /^Seated - touching, gap 0\.00mm/.test(b.status) && near(b.min[1] - a.max[1], 0, 2e-6), b.status);
  const s0 = b;
  await clickAlign(page);
  b = await pose(page, idB);
  check('touching survives Align exactly', /^Aligned/.test(b.status) && sameZ(b, s0), zDetail(b, s0));
  const exp0 = await page.evaluate(exportPlate);
  const stl0 = path.join(tmp, 'seat_align_0.stl');
  fs.writeFileSync(stl0, Buffer.from(exp0.stl, 'base64'));
  const v0 = meshValidate(stl0);
  console.log('  mesh_validate: pierce ' + v0.self_intersection.pierce + ', coplanar ' + v0.self_intersection.coplanar + ', bbox_size ' + JSON.stringify(v0.bbox_size));
  check('0 export after Align: coplanar contact present (touching), height 40.00 (1e-5)',
    v0.self_intersection.coplanar > 0 && near(v0.bbox_size[2], 40, 1e-5), JSON.stringify(v0.bbox_size));
  await setSlider(page, '-0.18');

  /* ---------- 5. Join's own Align is unchanged: two pieces on the bed ---------- */
  console.log('\n--- 5. regression: Align edges on two pieces side by side on the bed ---');
  await setLift(page, idB, 0);
  await dragTo(page, idB, a.x + 53, a.z);
  b = await pose(page, idB);
  check('staged: bit on the bed 13 mm off the hull\'s +X wall', near(b.min[1], 0.2, 1e-9) && near(b.min[0], a.max[0] + 3, 1e-9), JSON.stringify(b.min));
  await clickAlign(page);
  a = await pose(page, idA); b = await pose(page, idB);
  console.log('  status: ' + b.status + ' - bit box ' + JSON.stringify([b.min, b.max]));
  // the pre-change pose for this staging, captured before any edit to matchPlacedBottoms
  check('status is "Aligned to nearest corner of A"', b.status === 'Aligned to nearest corner of A', b.status);
  check('bit snapped against the wall and to the corner: box [40,0.2,-20]..[60,20.2,0] (1e-9)',
    near(b.min[0], 40, 1e-9) && near(b.min[1], 0.2, 1e-9) && near(b.min[2], -20, 1e-9) &&
    near(b.max[0], 60, 1e-9) && near(b.max[1], 20.2, 1e-9) && near(b.max[2], 0, 1e-9), JSON.stringify([b.min, b.max]));
  check('both bottoms on the bed baseline 0.2, no lift on either', near(a.min[1], 0.2, 1e-9) && a.liftY === 0 && b.liftY === 0, a.min[1] + ' / ' + b.min[1]);

  /* ---------- 6. Seat flush from the buried start; a failed seat restores ---------- */
  console.log('\n--- 6. Seat flush from the bed (buried), and the fail-safe ---');
  await dragTo(page, idB, a.x, a.z);
  await clearStatus(page);
  await page.click('#btn-seat-flush');
  await waitStatus(page, /^Seated|^Seat /);
  a = await pose(page, idA); b = await pose(page, idB);
  check('Seat flush from the bed: golden status', b.status === GOLDEN_FLUSH_STATUS, b.status);
  check('Seat flush from the bed: outer face 0.01 proud, bottom 19.99 below the hull top (2e-6) - the plug seat',
    near(b.max[1] - a.max[1], 0.01, 2e-6) && near(b.min[1] - a.max[1], -19.99, 2e-6), (b.max[1] - a.max[1]) + ' / ' + (b.min[1] - a.max[1]));

  await setLift(page, idB, 0);
  await dragTo(page, idB, a.x, a.z);
  const before = await pose(page, idB);
  await page.evaluate(() => { window.__realSeat = NSO_seatFlushBitToHull; NSO_seatFlushBitToHull = function () { return { ok: false, reason: 'stub' }; }; });
  await clickSeat(page);
  b = await pose(page, idB);
  await page.evaluate(() => { NSO_seatFlushBitToHull = window.__realSeat; delete window.__realSeat; });
  check('a seat that fails says so', b.status === 'Seat failed - stub', b.status);
  check('and puts the bit back exactly where it was (position, quaternion, liftY)',
    b.pos.every((v, i) => v === before.pos[i]) && b.quat.every((v, i) => v === before.quat[i]) && b.liftY === before.liftY, JSON.stringify(b.pos));

  /* ---------- 7. a part shorter than the hull, dragged over it (the live report) ---------- */
  console.log('\n--- 7. hinge_pip (18 x 16 x 8, shorter than the 20 mm hull) dragged over the hull, Seat (support) ---');
  const idC = await loadSTL(page, fx('hinge_pip.stl'));
  const j2 = await joinAB(page, idA, idC);
  check('Join session holds A = hull, B = hinge_pip', j2.session && j2.a === idA && j2.b === idC, JSON.stringify(j2));
  await dragTo(page, idC, a.x, a.z);
  let c = await pose(page, idC);
  check('staged: short part on the bed inside the hull, its top below the hull\'s top', near(c.min[1], 0.2, 1e-9) && c.max[1] < a.max[1], JSON.stringify([c.min, c.max]));
  await clickSeat(page);
  a = await pose(page, idA); c = await pose(page, idC);
  console.log('  status: ' + c.status);
  check('short part seats: clean status, underside 0.18 above the hull top (2e-6), liftY 20.18', c.status === SEATED_18 && near(c.min[1] - a.max[1], 0.18, 2e-6) && near(c.liftY, 20.18, 2e-6), c.status + ' ' + (c.min[1] - a.max[1]));
  const cSeated = c;
  await clickAlign(page);
  c = await pose(page, idC);
  check('short part: Align keeps the seat exactly', /^Aligned/.test(c.status) && sameZ(c, cSeated), zDetail(c, cSeated));
  await clickSeat(page);
  c = await pose(page, idC);
  check('short part: Seat again after Align, same pose ===', c.status === SEATED_18 && sameZ(c, cSeated), zDetail(c, cSeated));

  const errs = logs.filter(l => /pageerror|\[error\]/.test(l));
  check('no page errors', errs.length === 0, errs.join(' | '));

  console.log('\n' + (fails ? fails + ' gate(s) FAILED' : 'all gates held'));
  process.exit(fails ? 1 : 0);
}).catch(e => { console.error(e); process.exit(2); });
