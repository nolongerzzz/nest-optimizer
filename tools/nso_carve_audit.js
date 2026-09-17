/* Local carving tool, Task 1 audit — what Seat + Subtract already does, and
   exactly where it stops, pinned as a runnable check.
     node tools/nso_carve_audit.js        exit 0 = every finding below still holds

   Everything here drives the REAL app through tools/nso_app_harness.js (the
   live app-join.js, the live manifold kernel from vendor/), and every result
   mesh goes through the canonical checker, tools/mesh_validate.py --gate.
   Nothing is asserted from reading the source.

   THE FINDINGS, as gates
   ----------------------
   1. Flush against one flat face is the shipped case and it works end to end:
      Seat flush lands 0.01 proud, Subtract removes exactly bit n hull, the
      result gates clean.
   2. Seat flush REFUSES at a top edge and at a top corner, and the reason is
      always 'corner N missed hull along punch axis'. NSO_seatFlushBitToHull
      casts a ray from each of the four corners of the bit's outer box face
      along one punch axis and requires all four to land on the hull; a bit
      that straddles an edge has 2 of 4, a corner 1 of 4. That gate is the
      whole of the gap: it is a placement precondition, not a CSG limit.
   3. The CSG pipeline itself already handles edges and corners. Parked by hand
      at an edge or a corner and handed straight to subtractSoupBFromA, the
      boolean removes exactly bit n hull to 1e-3 mm^3 and the result gates
      clean on the canonical checker - watertight, 0 non-manifold, 0 piercing,
      0 slivers, Euler 2. So Task 3 is placement work, not kernel work.
   4. Where Seat does NOT refuse a straddle it SILENTLY CONVERTS it. A bit
      centred on a vertical edge has all four outer-face rays hitting the +X
      wall, so Seat succeeds - by sliding the bit clear of the edge and
      seating it flush on that one face. The edge intent is destroyed with a
      clean status line. A free-orientation tool cannot route through Seat.
   5. minWall guards ONE axis. The safety box in NSO_CSG.buildCutVolume
      measures depth by ray-casting along frame.punch only, so on a hollow
      hull the far wall it stops short of is the OPPOSITE outer wall. A corner
      bite cuts clean through a 2 mm near wall with minWall 1.0 and still
      gates clean - the geometry is sound, the wall is gone.                */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, ROOT } = require('./nso_app_harness');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

/* ---- binary STL out, so the canonical checker can read the result ---- */
function writeBinarySTL(file, soup) {
  const n = soup.length / 9;
  const buf = Buffer.alloc(84 + n * 50);
  buf.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50, s = i * 9;
    const ax = soup[s], ay = soup[s+1], az = soup[s+2];
    const ux = soup[s+3]-ax, uy = soup[s+4]-ay, uz = soup[s+5]-az;
    const vx = soup[s+6]-ax, vy = soup[s+7]-ay, vz = soup[s+8]-az;
    let nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    buf.writeFloatLE(nx/L, o); buf.writeFloatLE(ny/L, o+4); buf.writeFloatLE(nz/L, o+8);
    for (let k = 0; k < 9; k++) buf.writeFloatLE(soup[s+k], o+12+k*4);
  }
  fs.writeFileSync(file, buf);
}

/* tools/mesh_validate.py --gate --json, the canonical battery */
function gate(file, extra) {
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--gate', '--json'].concat(extra || []);
  let out, code = 0;
  try { out = execFileSync('python3', args, { encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; code = e.status == null ? 1 : e.status; }
  let j = null;
  try { j = JSON.parse(out); } catch (e) { /* leave null */ }
  return { code, j };
}
const clean = g => !!(g.j && g.code === 0 && g.j.verdict === 'PASS' &&
  g.j.open_edges === 0 && g.j.nonmanifold_edges === 0 && g.j.odd_edges === 0 &&
  g.j.inconsistent_winding_edges === 0 && g.j.degenerate_tris === 0 && g.j.sliver_tris === 0 &&
  g.j.self_intersection && g.j.self_intersection.pierce === 0 &&
  g.j.euler_characteristic === 2);
const gsum = g => g.j ? ('tris ' + g.j.triangles + ', open ' + g.j.open_edges + ', nm ' + g.j.nonmanifold_edges +
  ', winding ' + g.j.inconsistent_winding_edges + ', slivers ' + g.j.sliver_tris +
  ', piercing ' + (g.j.self_intersection ? g.j.self_intersection.pierce : '?') +
  ', euler ' + g.j.euler_characteristic + ', verdict ' + g.j.verdict) : 'checker gave no JSON';

/* ---- page helpers ---- */
const worldBox = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return { min: bb.min.toArray(), max: bb.max.toArray() };
}, id);

/* park the bit with its world box centred on (cx,cz) and its bottom at `bottom` */
const park = (page, id, cx, cz, bottom) => page.evaluate(([id, cx, cz, bottom]) => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.liftY = 0; applyMeshRotation(p); p.mesh.updateMatrixWorld(true);
  let bb = new THREE.Box3().setFromObject(p.mesh);
  const c = bb.getCenter(new THREE.Vector3());
  p.x += cx - c.x; p.z += cz - c.z;
  p.liftY = bottom - 0.2;
  applyMeshRotation(p); p.mesh.updateMatrixWorld(true);
  bb = new THREE.Box3().setFromObject(p.mesh);
  return { min: bb.min.toArray(), max: bb.max.toArray() };
}, [id, cx, cz, bottom]);

/* One placement: what plugFrame picks, how many outer-face rays land, what
   Seat flush does (pose restored afterwards), then the real Subtract on the
   as-parked pose, with the true bit n hull volume to compare against. */
const measure = (page, idA, idB) => page.evaluate(async ([idA, idB]) => {
  const pa = state.placed.find(p => p && p.sourceId === idA && p.mesh);
  const pb = state.placed.find(p => p && p.sourceId === idB && p.mesh);
  pa.mesh.updateMatrixWorld(true); pb.mesh.updateMatrixWorld(true);
  const aWorld = meshToWorldSoup(pa.mesh), bWorld = meshToWorldSoup(pb.mesh);
  if (!pa.mesh.geometry.boundingBox) pa.mesh.geometry.computeBoundingBox();
  const hc = pa.mesh.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(pa.mesh.matrixWorld);

  const frame = NSO_plugFrame(pb.mesh, hc, aWorld);
  let cornerHits = 0;
  for (const c of NSO_outerFaceCorners(frame)) if (NSO_nearestSkinHit(aWorld, c, frame.punch)) cornerHits++;

  /* Seat flush on a saved pose, then put the pose back */
  const sp = pb.mesh.position.clone(), sq = pb.mesh.quaternion.clone();
  const s = NSO_seatFlushBitToHull(pa.mesh, pb.mesh, { proud: 0.01 });
  pb.mesh.updateMatrixWorld(true);
  const seatBox = new THREE.Box3().setFromObject(pb.mesh);
  const seat = { ok: !!(s && s.ok), reason: s && s.reason, maxResidual: s && s.maxResidual,
                 box: { min: seatBox.min.toArray(), max: seatBox.max.toArray() } };
  pb.mesh.position.copy(sp); pb.mesh.quaternion.copy(sq); pb.mesh.updateMatrixWorld(true);

  /* the true target volume, and the real subtract */
  const wasm = await NSO_CSG.load();
  const mA = NSO_CSG.soupToManifold(wasm, aWorld), mB = NSO_CSG.soupToManifold(wasm, bWorld);
  const inter = mA.intersect(mB);
  const wantRemoved = inter.volume(), volA = mA.volume();
  inter.delete();
  const r = await subtractSoupBFromA(aWorld, bWorld, { plugFrame: frame, minWall: 1.0 });
  const sub = { ok: !!(r && r.ok), reason: r && r.reason, openAfter: r && r.openAfter, nmAfter: r && r.nmAfter };
  if (r && r.ok && r.soup) {
    const mR = NSO_CSG.soupToManifold(wasm, r.soup);
    sub.gotRemoved = volA - mR.volume();
    mR.delete();
    sub.soup = Array.from(r.soup);
  }
  mA.delete(); mB.delete();
  return { axis: frame.axis, sign: frame.sign, outerNormal: frame.outerNormal.toArray(),
           cornerHits, wantRemoved, seat, sub };
}, [idA, idB]);

const MISSED = /^corner \d missed hull along punch axis$/;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-carve-audit-'));
  await withApp(async (page, logs) => {

    /* ================================================================
       Solid hull: 80 x 40, 20 tall on the plate. Bit: 12 x 8 x 8.
       ================================================================ */
    const idA = await loadSTL(page, path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl'));
    const idB = await loadSTL(page, path.join(ROOT, 'library', 'box_bit_12x8x8.stl'));
    const A = await worldBox(page, idA);
    const cx = (A.min[0] + A.max[0]) / 2, cz = (A.min[2] + A.max[2]) / 2, top = A.max[1];
    const midY = (A.min[1] + A.max[1]) / 2;

    console.log('\n--- 1. flush against ONE flat face: the shipped case, end to end ---');
    await park(page, idB, cx, cz, top - 3);
    let r = await measure(page, idA, idB);
    check('plugFrame picks the bit\'s +Y face', r.axis === 1 && r.sign === 1,
      'axis ' + r.axis + ' sign ' + r.sign);
    check('all four outer-face rays land on the hull', r.cornerHits === 4, r.cornerHits + '/4');
    check('Seat flush seats, skin error 0', r.seat.ok && near(r.seat.maxResidual, 0, 1e-6),
      r.seat.ok ? 'maxResidual ' + Number(r.seat.maxResidual).toFixed(4) : r.seat.reason);
    check('Subtract removes exactly bit n hull', r.sub.ok && near(r.sub.gotRemoved, r.wantRemoved, 1e-3),
      r.sub.ok ? r.sub.gotRemoved.toFixed(3) + ' of ' + r.wantRemoved.toFixed(3) + ' mm^3' : r.sub.reason);
    let f = path.join(tmp, 'flat.stl');
    writeBinarySTL(f, Float32Array.from(r.sub.soup));
    let g = gate(f);
    check('flat local shave gates clean on the canonical checker', clean(g), gsum(g));

    console.log('\n--- 2. a top EDGE: Seat flush refuses, the boolean does not ---');
    await park(page, idB, A.max[0], cz, top - 3);
    r = await measure(page, idA, idB);
    check('only 2 of the 4 outer-face rays land on the hull', r.cornerHits === 2, r.cornerHits + '/4');
    check('Seat flush REFUSES, and the reason is the corner-ray gate',
      !r.seat.ok && MISSED.test(String(r.seat.reason)), String(r.seat.reason));
    check('the boolean, handed the same pose, removes exactly bit n hull',
      r.sub.ok && near(r.sub.gotRemoved, r.wantRemoved, 1e-3),
      r.sub.ok ? r.sub.gotRemoved.toFixed(3) + ' of ' + r.wantRemoved.toFixed(3) + ' mm^3' : r.sub.reason);
    f = path.join(tmp, 'edge.stl');
    writeBinarySTL(f, Float32Array.from(r.sub.soup));
    g = gate(f);
    check('edge chamfer cut gates clean on the canonical checker', clean(g), gsum(g));

    console.log('\n--- 3. a top CORNER (two faces at once): same refusal, same clean cut ---');
    await park(page, idB, A.max[0], A.max[2], top - 3);
    r = await measure(page, idA, idB);
    check('only 1 of the 4 outer-face rays lands on the hull', r.cornerHits === 1, r.cornerHits + '/4');
    check('Seat flush REFUSES, and the reason is the corner-ray gate',
      !r.seat.ok && MISSED.test(String(r.seat.reason)), String(r.seat.reason));
    check('the boolean, handed the same pose, removes exactly bit n hull',
      r.sub.ok && near(r.sub.gotRemoved, r.wantRemoved, 1e-3),
      r.sub.ok ? r.sub.gotRemoved.toFixed(3) + ' of ' + r.wantRemoved.toFixed(3) + ' mm^3' : r.sub.reason);
    f = path.join(tmp, 'corner.stl');
    writeBinarySTL(f, Float32Array.from(r.sub.soup));
    g = gate(f);
    check('corner gouge gates clean on the canonical checker', clean(g), gsum(g));

    console.log('\n--- 4. a VERTICAL edge: Seat does not refuse, it silently un-straddles ---');
    const parked = await park(page, idB, A.max[0], cz, midY - 4);
    r = await measure(page, idA, idB);
    check('all four rays land (they all look at the +X wall)', r.cornerHits === 4, r.cornerHits + '/4');
    check('Seat flush reports success', r.seat.ok, r.seat.ok ? 'ok' : r.seat.reason);
    /* Parked, the bit straddles the +X wall: half in, 6 mm of overhang past it.
       Seat drives that overhang to `proud` (0.01) - it does not carve the edge,
       it buries the bit as a plug through the one flat face it chose, and says
       'Seated'. Straddle in, plug out, no refusal anywhere. */
    check('parked, the bit overhangs the +X wall by half its length',
      near(parked.max[0] - A.max[0], 6, 1e-6), (parked.max[0] - A.max[0]).toFixed(3) + ' mm past the wall');
    check('after Seat the overhang is gone - driven to proud 0.01, the bit is a plug',
      r.seat.ok && near(r.seat.box.max[0] - A.max[0], 0.01, 2e-3),
      (r.seat.box.max[0] - A.max[0]).toFixed(4) + ' mm past the wall');
    check('and the bit now lies inside the hull in X, not across its edge',
      r.seat.ok && r.seat.box.min[0] > A.min[0] && r.seat.box.min[0] < A.max[0],
      'bit x ' + r.seat.box.min[0].toFixed(3) + '..' + r.seat.box.max[0].toFixed(3) +
      ' vs hull x ' + A.min[0].toFixed(1) + '..' + A.max[0].toFixed(1));

    /* ================================================================
       Hollow hull: fixtures/box_open.stl, 60 x 40 x 25, 2 mm walls.
       ================================================================ */
    console.log('\n--- 5. minWall guards ONE axis: a corner bite severs a 2 mm near wall ---');
    const idC = await loadSTL(page, path.join(ROOT, 'fixtures', 'box_open.stl'));
    const C = await worldBox(page, idC);
    await park(page, idB, C.max[0], C.max[2], C.max[1] - 3);
    r = await measure(page, idC, idB);
    check('the bit only ever meets the 2 mm wall', near(r.wantRemoved, 48, 1e-3),
      'bit n hull ' + r.wantRemoved.toFixed(3) + ' mm^3');
    check('minWall 1.0 does NOT stop it - the whole bite is taken',
      r.sub.ok && near(r.sub.gotRemoved, r.wantRemoved, 1e-3),
      r.sub.ok ? r.sub.gotRemoved.toFixed(3) + ' of ' + r.wantRemoved.toFixed(3) + ' mm^3' : r.sub.reason);
    f = path.join(tmp, 'thin-corner.stl');
    writeBinarySTL(f, Float32Array.from(r.sub.soup));
    g = gate(f, ['--min-wall', '1.0']);
    check('and the severed result still gates clean - sound geometry, wall gone',
      clean(g), gsum(g));

    const errs = logs.filter(l => /pageerror/.test(l));
    check('no page errors', errs.length === 0, errs.join(' | ') || 'none');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + (fails ? fails + ' FAILED' : 'all audit findings hold'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
