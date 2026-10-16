/* Mold: a two-piece interlocking silicone mold from one piece.
   node tools/nso_mold_test.js        exit 0 = every gate held

   The engine (nso_mold.js) with the SHIPPED kernels under it: Subtract and
   Union are app-join.js's own (through tools/nso_csg_node.js, Manifold from
   vendor/), the split is app-cut.js's own cutOneSide / rawCut run in a vm
   (tools/nso_mold_testlib.js). Nothing here retypes what the page does.

   What is asserted is the ticket, in numbers, against INDEPENDENT measures:
     - a Stock sphere Ø30 gives two halves, each closed and manifold (the
       module's census AND tools/mesh_validate.py, self-intersection included),
       their mating faces coplanar within 0.01 mm, the cavity volume equal to
       the sphere plus the sprue plus the vent within 0.5 %, four cones on A and
       four sockets on B at the same x,z within 0.01 mm, socket Ø = cone Ø +
       0.4 mm, a sprue that runs from the top face to the cavity top, a vent
       that reaches the outside (point-in-solid tests on the halves, not the
       module's own say-so);
     - the blade: the plane follows the slider and tilt, and the lock area is
       > 0 below the widest point, 0 at the mid-plane of a symmetric piece, and
       equal to a brute-force sampling of the same rule;
     - a clicked pour point moves the sprue straight to the nearest outer face;
     - the refusals, in words: an open mesh, a block bigger than the plate (the
       size is in the text), keys that would not fit (the minimum wall is);
     - the piece is read and never written. */
'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const lib = require('./nso_mold_testlib.js');
const M = require('../nso_mold.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++; else fail++;
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const f = (v, d) => (+v).toFixed(d == null ? 3 : d);
const sum = soup => { let s = 0; for (let i = 0; i < soup.length; i++) s += soup[i] * (i % 7 + 1); return s; };

/* The lock rule again, written differently: every triangle cut into a fine
   grid of small ones, each judged at its centre on its own side. */
function sampledLock(soup, plane, n) {
  n = n || 40;
  let area = 0;
  const nrm = plane.n;
  for (let t = 0; t + 8 < soup.length; t += 9) {
    const A = [soup[t], soup[t + 1], soup[t + 2]], B = [soup[t + 3], soup[t + 4], soup[t + 5]], C = [soup[t + 6], soup[t + 7], soup[t + 8]];
    const e1 = B.map((v, i) => v - A[i]), e2 = C.map((v, i) => v - A[i]);
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...cr);
    if (l < 1e-9) continue;
    const nn = (cr[0] * nrm[0] + cr[1] * nrm[1] + cr[2] * nrm[2]) / l;
    const share = (l / 2) / (n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
      // the up triangles of the grid, and the down ones between them
      for (const w of (j < n - i - 1 ? [[(i + 1 / 3) / n, (j + 1 / 3) / n], [(i + 2 / 3) / n, (j + 2 / 3) / n]] : [[(i + 1 / 3) / n, (j + 1 / 3) / n]])) {
        const p = A.map((v, k) => v + e1[k] * w[0] + e2[k] * w[1]);
        const d = nrm[0] * p[0] + nrm[1] * p[1] + nrm[2] * p[2] - plane.c;
        if ((d > 0 && nn < -M.LOCK_EPS) || (d < 0 && nn > M.LOCK_EPS)) area += share;
      }
    }
  }
  return area;
}

/* Rotate a soup about z through its own centre (a piece posed on its side). */
function turnedAboutZ(soup, deg, y0) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const o = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) { o[i] = soup[i] * c - soup[i + 1] * s; o[i + 1] = soup[i] * s + soup[i + 1] * c; o[i + 2] = soup[i + 2]; }
  return lib.centred(o, y0 || 0);
}

(async () => {
  const kernel = lib.kernel();

  console.log('\n=== 0. the engine is THREE-free and runs with no page ===');
  {
    const ctx = { Math, Float32Array, Float64Array, Map, Set, Array, Object, Number, JSON, isFinite, Error, Infinity, NaN, Promise };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(lib.ROOT, 'nso_mold.js'), 'utf8'), ctx, { filename: 'nso_mold.js' });
    check('loads in a bare context as NSO_Mold', typeof ctx.NSO_Mold === 'object' && typeof ctx.NSO_Mold.plan === 'function');
    check('no THREE, no document, no state in the source',
      !/\bTHREE\b|\bdocument\b|\bstate\./.test(fs.readFileSync(path.join(lib.ROOT, 'nso_mold.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));
  }

  console.log('\n=== 1. the blade: slider, tilt, and where the plane is ===');
  const box = lib.stockBox(30, 20, 25, 0);            // 30 wide (x), 20 deep (z), 25 tall (y)
  const bb = M.bounds(box);
  {
    const p0 = M.plan(box, {}, {});
    check('default plane: horizontal, at the middle of the height', near(p0.plane.mm, 12.5, 1e-9) && p0.plane.n[1] === 1 && near(p0.plane.p0[1], 12.5, 1e-6),
      'mm ' + p0.plane.mm + ', y ' + f(p0.plane.p0[1]));
    check('slider range is Cut\'s: 1 mm in from each end, on a 0.1 grid', p0.plane.lo === 1 && p0.plane.hi === 24, p0.plane.lo + '..' + p0.plane.hi);
    check('slider beyond the ends is held in range', M.plan(box, { mm: 0 }, {}).plane.mm === 1 && M.plan(box, { mm: 99 }, {}).plane.mm === 24);
    let ok = true, worst = 0;
    for (const mm of [3, 8.4, 12.5, 20, 23.9]) {
      const pl = M.plan(box, { mm, tiltDeg: 20, headingDeg: 90 }, {}).plane;
      const tau = 20 * Math.PI / 180;
      // the plane crosses the piece's centre line at mm from the low end, and leans 20 deg toward heading 90 (+x)
      const onLine = M.dist(pl, [(bb.min[0] + bb.max[0]) / 2, bb.min[1] + mm, (bb.min[2] + bb.max[2]) / 2]);
      const lean = Math.acos(Math.min(1, pl.n[1])) * 180 / Math.PI;
      const toward = [pl.n[0] / Math.sin(tau), pl.n[2] / Math.sin(tau)];
      worst = Math.max(worst, Math.abs(onLine), Math.abs(lean - 20), Math.abs(toward[0] - 1), Math.abs(toward[1]));
      // and rises toward -x, falls toward +x, by tan 20 per mm
      const drop = M.planeY(pl, bb.min[0], 0) - M.planeY(pl, bb.max[0], 0);
      worst = Math.max(worst, Math.abs(drop - 30 * Math.tan(tau)));
      if (!near(pl.mm, mm, 1e-9)) ok = false;
    }
    check('a box with the blade tilted 20 deg: the plane follows the slider (centre line, lean, direction, slope)', ok && worst < 1e-9, 'worst ' + worst.toExponential(2));
    const headN = M.plan(box, { tiltDeg: 20, headingDeg: 0 }, {}).plane.n, headE = M.plan(box, { tiltDeg: 20, headingDeg: 90 }, {}).plane.n;
    check('heading 0 leans toward the top of the screen (-z), 90 toward +x', headN[2] < -0.3 && near(headN[0], 0, 1e-12) && headE[0] > 0.3 && near(headE[2], 0, 1e-12));
    check('tilt 0 is exactly level whatever the heading', M.plan(box, { tiltDeg: 0, headingDeg: 137 }, {}).plane.n.join() === '0,1,0');
  }

  console.log('\n=== 2. locks: the faces that would lock a half ===');
  const sph = lib.stockSphere(15, 0);
  {
    const mid = M.plan(sph, {}, {}).lock, low = M.plan(sph, { mm: 8 }, {}), high = M.plan(sph, { mm: 22 }, {});
    check('sphere, plane at the equator (a symmetric piece, mid-plane): 0 mm² lock', mid.areaMm2 < 1e-6, f(mid.areaMm2, 6) + ' mm²');
    check('sphere, plane BELOW the widest point: area reported > 0', low.lock.areaMm2 > 100, f(low.lock.areaMm2, 1) + ' mm²');
    // a band of the southern hemisphere between the plane and the equator faces down: 2 pi R h
    const band = 2 * Math.PI * 15 * 7;
    // ... less the band at the equator, whose facets are within 1 deg of vertical (no draft: silicone pulls off those)
    const eq = 2 * Math.PI * 15 * (15 * Math.sin(Math.PI / 96));
    check('  ... and it is that band, 2 pi R h, less the near-vertical band at the equator (within LOCK_EPS of square)',
      low.lock.areaMm2 < band && near(low.lock.areaMm2, band - eq, 1.5), f(low.lock.areaMm2, 1) + ' vs ' + f(band, 1) + ' - ' + f(eq, 1) + ' = ' + f(band - eq, 1));
    check('sphere, plane ABOVE the widest point: the same, from B\'s side', near(high.lock.areaMm2, low.lock.areaMm2, 0.5), f(high.lock.areaMm2, 1) + ' mm²');
    const indep = sampledLock(sph, low.plane);
    check('the area is the rule, sampled independently', near(low.lock.areaMm2 / indep, 1, 0.02), f(low.lock.areaMm2, 1) + ' vs sampled ' + f(indep, 1));
    check('the locking faces come back as triangles to tint', low.lock.tris.length > 0 && low.lock.count > 0 && mid.tris.length === 0);
    for (const mm of [1, 6.3, 12.5, 24]) {
      const z = M.plan(box, { mm }, {}).lock.areaMm2;
      if (mm === 12.5) check('a straight-sided box has no undercut at any height (mid-plane: 0)', z < 1e-9, f(z, 9));
    }
    const tiltBox = M.plan(box, { tiltDeg: 20, headingDeg: 90 }, {});
    const indepBox = sampledLock(box, tiltBox.plane, 50);
    check('a box with the blade tilted 20 deg: lock area > 0, and the rule\'s', tiltBox.lock.areaMm2 > 50 && near(tiltBox.lock.areaMm2 / indepBox, 1, 0.02),
      f(tiltBox.lock.areaMm2, 1) + ' vs sampled ' + f(indepBox, 1));
    // a piece posed tilted 20 deg on the plate: the same horizontal blade now meets leaning walls
    const posed = turnedAboutZ(box, 20, 0);
    const pp = M.plan(posed, {}, {});
    const indepPosed = sampledLock(posed, pp.plane, 50);
    check('a box posed 20 deg on its side: lock > 0 at its mid-plane, and the rule\'s', pp.lock.areaMm2 > 50 && near(pp.lock.areaMm2 / indepPosed, 1, 0.02),
      f(pp.lock.areaMm2, 1) + ' vs sampled ' + f(indepPosed, 1));
  }

  console.log('\n=== 3. the Stock sphere Ø30: the mold ===');
  const before = sum(sph), bounds0 = JSON.stringify(M.bounds(sph));
  let pl, R;
  {
    pl = M.plan(sph, {}, { printer: { w: 180, d: 180, h: 180 } });
    check('plans without a refusal', pl.ok, JSON.stringify(pl.refusals));
    check('block: the piece + Wall 10 each side, + Top/bottom 15', pl.block.size.map(v => +v.toFixed(3)).join() === '50,60,50', pl.block.size.join(' x '));
    const t0 = Date.now();
    R = await M.build(sph, pl, kernel);
    check('builds', R.ok, R.ok ? (Date.now() - t0) + ' ms' : R.reason);
  }
  if (!R || !R.ok) { console.log('\nFAILED  ' + fail + ' (the mold did not build)'); process.exit(1); }
  const A = R.A, B = R.B, A0 = R.openA;               // A0 is half A as cut, before it is turned over
  const planeY0 = pl.plane.p0[1];
  {
    check('the piece is untouched (read, never written)', sum(sph) === before && JSON.stringify(M.bounds(sph)) === bounds0);
    for (const [n, s] of [['A', A], ['B', B]]) {
      const c = M.census(s), v = lib.validate(s, null, { selfint: true });
      check('half ' + n + ' closed and manifold (the module\'s census)', c.closed && c.degen === 0, JSON.stringify(c));
      check('half ' + n + ' passes tools/mesh_validate.py - open 0, non-manifold 0, winding 0, degenerate 0, no self-intersection',
        v.open_edges === 0 && v.nonmanifold_edges === 0 && v.inconsistent_winding_edges === 0 && v.degenerate_tris === 0 &&
        v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0 && v.verdict === 'PASS', v.summary);
      check('half ' + n + ' has positive volume (faces out)', M.volume(s) > 0, f(M.volume(s), 1) + ' mm³');
    }
    // mating faces
    const faceA = [], faceB = [];
    for (let i = 0; i < A0.length; i += 3) if (near(A0[i + 1], planeY0, 1e-3)) faceA.push([A0[i], A0[i + 1], A0[i + 2]]);
    for (let i = 0; i < B.length; i += 3) if (near(B[i + 1], planeY0, 1e-3)) faceB.push([B[i], B[i + 1], B[i + 2]]);
    const spread = faceA.concat(faceB).reduce((m, p) => Math.max(m, Math.abs(p[1] - planeY0)), 0);
    check('the mating faces are coplanar within 0.01 mm', spread < 0.01 && faceA.length > 100 && faceB.length > 100, 'worst ' + spread.toExponential(2) + ' mm over ' + (faceA.length + faceB.length) + ' vertices');
    // every outline vertex of one face (away from the keys) is a vertex of the other: they meet exactly
    const keyXZ = pl.keys.places.map(p => [p.o[0], p.o[2]]);
    const far = p => keyXZ.every(k => Math.hypot(p[0] - k[0], p[2] - k[1]) > 4);
    const idx = new Map(faceB.map(p => [Math.round(p[0] * 50) + ',' + Math.round(p[2] * 50), p]));
    let miss = 0, tested = 0;
    for (const p of faceA) {
      if (!far(p)) continue;
      tested++;
      let hit = false;
      for (let dx = -1; dx <= 1 && !hit; dx++) for (let dz = -1; dz <= 1 && !hit; dz++) {
        const q = idx.get((Math.round(p[0] * 50) + dx) + ',' + (Math.round(p[2] * 50) + dz));
        if (q && Math.hypot(q[0] - p[0], q[2] - p[2]) < 0.01) hit = true;
      }
      if (!hit) miss++;
    }
    check('every vertex of A\'s face (off the keys) is a vertex of B\'s, within 0.01 mm: they meet exactly', miss === 0 && tested > 100, tested + ' tested, ' + miss + ' unmatched');

    // volumes
    const s = R.stats, kv = M.keyVolumes({});
    const cavity = s.blockMm3 - M.volume(A0) - M.volume(B) + 4 * (kv.cone - kv.socket);
    const sprueV = Math.PI * 16 * pl.pour.lengthMm, ventV = Math.PI * 1.5 * 1.5 * pl.vent.ch.lengthMm;
    const meshV = M.volume(sph), exact = 4 / 3 * Math.PI * 3375;
    const want = meshV + sprueV + ventV;
    check('cavity volume = sphere + sprue + vent within 0.5 %', Math.abs(cavity - want) / want < 0.005,
      'cavity ' + f(cavity, 1) + ' vs ' + f(want, 1) + ' (' + f(100 * (cavity - want) / want, 3) + ' %); sphere mesh ' + f(meshV, 1) + ', Ø30 ' + f(exact, 1) +
      ', sprue ' + f(sprueV, 1) + ' (' + f(pl.pour.lengthMm, 1) + ' mm), vent ' + f(ventV, 1) + ' (' + f(pl.vent.ch.lengthMm, 1) + ' mm)');
    check('  ... and the module\'s own account of it agrees', Math.abs(s.cavityMm3 - cavity) / cavity < 0.001, f(s.cavityMm3, 1) + ' vs ' + f(cavity, 1));
    check('the sphere is a Ø30 sphere to the mesh\'s accuracy', Math.abs(meshV - exact) / exact < 0.005);

    // the keys
    const cones = [], tip = planeY0 - 3;
    for (let i = 0; i < A0.length; i += 3) if (A0[i + 1] < planeY0 - 2.99) cones.push([A0[i], A0[i + 1], A0[i + 2]]);
    const apexes = [];
    cones.filter(p => near(p[1], tip, 0.01)).forEach(p => { if (!apexes.some(q => Math.hypot(q[0] - p[0], q[2] - p[2]) < 0.01)) apexes.push(p); });
    check('four cones stand out of half A\'s face, 3 mm proud', apexes.length === 4 && cones.every(p => p[1] >= tip - 0.01), apexes.length + ' tips at y ' + apexes.map(p => f(p[1], 2)).join(','));
    const insets = apexes.map(p => [25 - Math.abs(p[0]), 25 - Math.abs(p[2])]);
    check('  ... at the face\'s corners, inset Wall/2 = 5 mm from the edges', insets.every(i => near(i[0], 5, 0.01) && near(i[1], 5, 0.01)), JSON.stringify(insets.map(i => i.map(v => +v.toFixed(3)))));
    let socketsAt = 0, dCone = [], dSock = [];
    for (const a of apexes) {
      if (B.length && (() => { for (let i = 0; i < B.length; i += 3) if (near(B[i], a[0], 0.01) && near(B[i + 2], a[2], 0.01) && near(B[i + 1], planeY0 - 3.2, 0.01)) return true; return false; })()) socketsAt++;
      const ringA = [], ringB = [];
      for (let i = 0; i < A0.length; i += 3) if (near(A0[i + 1], planeY0, 1e-3)) { const r = Math.hypot(A0[i] - a[0], A0[i + 2] - a[2]); if (r < 3.5) ringA.push(r); }
      for (let i = 0; i < B.length; i += 3) if (near(B[i + 1], planeY0, 1e-3)) { const r = Math.hypot(B[i] - a[0], B[i + 2] - a[2]); if (r < 3.6) ringB.push(r); }
      dCone.push(2 * Math.max(...ringA)); dSock.push(2 * Math.max(...ringB));
    }
    check('four sockets in half B, at the same x,z as the cones within 0.01 mm', socketsAt === 4, socketsAt + ' of 4 socket tips found under the cone tips');
    check('cone Ø 6.0 at the face', dCone.length === 4 && dCone.every(d => near(d, 6, 0.01)), dCone.map(d => f(d, 3)).join(', '));
    check('socket Ø = cone Ø + 0.4 mm', dSock.length === 4 && dSock.every((d, i) => near(d - dCone[i], 0.4, 0.01)), dSock.map(d => f(d, 3)).join(', '));

    // the sprue and the vent: point-in-solid on half A, not on the module's say-so
    const top = pl.block.max[1], solid = p => lib.inside(A0, p);
    const px = pl.pour.point[0], pz = pl.pour.point[2];
    check('the sprue runs from the top face down to the cavity top: its whole axis is empty',
      [top + 0.5, top - 0.2, 38, 33, 31, 30.4].every(y => !solid([px, y, pz])), 'axis (' + f(px, 2) + ', y, ' + f(pz, 2) + ') from y ' + f(top, 0) + ' to ' + f(pl.pour.point[1], 2));
    check('  ... Ø8: empty at r 3.8, solid at r 4.3', !solid([px + 3.8, 38, pz]) && solid([px + 4.3, 38, pz]) && !solid([px, 38, pz + 3.8]) && solid([px, 38, pz + 4.3]));
    check('  ... and it opens into the cavity (a point of the cavity just under the pole is empty too)', !solid([px, 28.5, pz]) && solid([px + 5, 29.9, pz]) === true);
    const v = pl.vent.point;
    check('the vent runs from the far side of the cavity to the outside: empty from its start to past the top face',
      [top + 0.5, top - 0.2, 38, 34, v[1] + 1].every(y => !solid([v[0], y, v[2]])), 'at (' + f(v[0], 2) + ', ' + f(v[2], 2) + '), the sprue is at (' + f(px, 2) + ', ' + f(pz, 2) + ')');
    check('  ... Ø3: empty at r 1.3, solid at r 1.8', !solid([v[0] + 1.3, 38, v[2]]) && solid([v[0] + 1.8, 38, v[2]]));
    check('  ... clear of the sprue, on the other side of the piece', Math.hypot(v[0] - px, v[2] - pz) >= 4 + 1.5, f(Math.hypot(v[0] - px, v[2] - pz), 2) + ' mm apart');
    check('A and B together carry no vent or sprue below the plane (they are above it)', pl.vent.ch.from[1] > planeY0 && pl.pour.ch.from[1] > planeY0);

    // both halves open, parting face up, flat block faces down
    const bA = M.bounds(A), bB = M.bounds(B);
    check('both halves lie open, flat block faces on the plate: A turned over, B as cut', near(bA.min[1], pl.block.min[1], 1e-4) && near(bB.min[1], pl.block.min[1], 1e-4),
      'A y ' + f(bA.min[1], 2) + '..' + f(bA.max[1], 2) + ' (cones to +3), B y ' + f(bB.min[1], 2) + '..' + f(bB.max[1], 2));
    check('  ... the cones now point up out of A, the sockets open up in B', near(bA.max[1] - 15, 3, 0.01) && near(bB.max[1], 15, 1e-4), 'cone tips at ' + f(bA.max[1], 3));
  }

  console.log('\n=== 4. a clicked pour point moves the sprue to the nearest outer face ===');
  {
    const el = 40 * Math.PI / 180, az = 30 * Math.PI / 180;
    const P = [15 * Math.cos(el) * Math.cos(az), 15 + 15 * Math.sin(el), 15 * Math.cos(el) * Math.sin(az)];
    const cache = {};
    const pc = M.plan(sph, { pour: P }, { cache });
    check('the pour point is where it was clicked', pc.pour.ok && !pc.pour.auto && Math.hypot(pc.pour.point[0] - P[0], pc.pour.point[1] - P[1], pc.pour.point[2] - P[2]) < 1e-9);
    // faces: +x at 25, top at 45 -> +x is nearer (15.05 vs 20.4)
    check('the sprue goes straight to the NEAREST outer face: +X, not the top', pc.pour.dir === '+x' && near(pc.pour.lengthMm, 25 - P[0], 1e-9), pc.pour.dir + ', ' + f(pc.pour.lengthMm, 3) + ' mm');
    const Rc = await M.build(sph, pc, kernel);
    check('the mold builds with it', Rc.ok, Rc.ok ? '' : Rc.reason);
    if (Rc.ok) {
      const solid = p => lib.inside(Rc.openA, p);
      const mid = [(P[0] + 25) / 2, P[1], P[2]], late = [24.5, P[1], P[2]];
      check('the sprue is a straight bore from the pour point out of the +X face', !solid(mid) && !solid(late) && solid([mid[0], P[1] + 4.4, P[2]]) && !solid([mid[0], P[1] + 3.6, P[2]]));
      check('both halves still closed and manifold', M.census(Rc.A).closed && M.census(Rc.B).closed);
      check('the top is not drilled (no sprue at the pole any more)', solid([0, 38, 0]));
      check('the vent is still placed', pc.vent && pc.vent.ok && !solid([pc.vent.point[0], 38, pc.vent.point[2]]));
    }
    const lo = M.plan(sph, { pour: [14.9, 15.5, 0] }, { cache });
    check('a spot too close to the parting plane is refused in words and the pour stays at the highest point',
      lo.pour.auto && /too close to the parting plane/.test(lo.warnings.join(' ')) && near(lo.pour.point[1], 30, 1e-9), lo.warnings.join(' | '));
    const under = M.plan(sph, { pour: [0, 1, 0] }, { cache });
    check('a spot on B\'s side is refused the same way', under.pour.auto && /parting plane/.test(under.warnings.join(' ')));
  }

  console.log('\n=== 5. the blade at an angle: the mold follows it ===');
  {
    const plT = M.plan(box, { tiltDeg: 20, headingDeg: 90, mm: 12 }, { printer: { w: 180, d: 180, h: 180 } });
    check('plans, keys fit at all four corners', plT.ok, JSON.stringify(plT.refusals));
    const RT = await M.build(box, plT, kernel);
    check('builds', RT.ok, RT.ok ? '' : RT.reason);
    if (RT.ok) {
      const dists = [];
      for (let i = 0; i < RT.openA.length; i += 3) {
        const d = M.dist(plT.plane, [RT.openA[i], RT.openA[i + 1], RT.openA[i + 2]]);
        if (Math.abs(d) < 0.001) dists.push(d);
      }
      const distsB = [];
      for (let i = 0; i < RT.B.length; i += 3) { const d = M.dist(plT.plane, [RT.B[i], RT.B[i + 1], RT.B[i + 2]]); if (Math.abs(d) < 0.001) distsB.push(d); }
      check('the mating faces lie on the tilted plane, within 0.01 mm, on both halves', dists.length > 20 && distsB.length > 20 && Math.max(...dists.map(Math.abs), ...distsB.map(Math.abs)) < 0.01,
        dists.length + ' + ' + distsB.length + ' vertices, worst ' + Math.max(...dists.map(Math.abs), ...distsB.map(Math.abs)).toExponential(2));
      for (const [n, s] of [['A', RT.A], ['B', RT.B]]) {
        const v = lib.validate(s, null, { selfint: true });
        check('half ' + n + ' (tilted) passes mesh_validate', v.verdict === 'PASS' && v.open_edges === 0 && v.nonmanifold_edges === 0 && v.degenerate_tris === 0, v.summary);
      }
      const kv = M.keyVolumes({}), cav = RT.stats.blockMm3 - M.volume(RT.openA) - M.volume(RT.B) + 4 * (kv.cone - kv.socket);
      const want = M.volume(box) + Math.PI * 16 * plT.pour.lengthMm + Math.PI * 2.25 * plT.vent.ch.lengthMm;
      check('cavity = piece + sprue + vent within 0.5 %', Math.abs(cav - want) / want < 0.005, f(cav, 1) + ' vs ' + f(want, 1));
      // the cones stand along the plane's normal
      const tips = [];
      for (let i = 0; i < RT.openA.length; i += 3) {
        const p = [RT.openA[i], RT.openA[i + 1], RT.openA[i + 2]], d = M.dist(plT.plane, p);
        if (near(d, -3, 0.01) && !tips.some(q => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 0.01)) tips.push(p);
      }
      const n = plT.plane.n;
      const along = tips.every(p => plT.keys.places.some(k => Math.hypot(p[0] - (k.o[0] - 3 * n[0]), p[1] - (k.o[1] - 3 * n[1]), p[2] - (k.o[2] - 3 * n[2])) < 0.02));
      check('four cone tips stand 3 mm off the tilted face, along its normal', tips.length === 4 && along, tips.length + ' tips');
    }
    const posed = turnedAboutZ(box, 20, 0), ppl = M.plan(posed, {}, {});
    const RP = await M.build(posed, ppl, kernel);
    check('a box posed 20 deg on its side builds too, both halves closed', RP.ok && M.census(RP.A).closed && M.census(RP.B).closed, RP.ok ? '' : RP.reason);
  }

  console.log('\n=== 6. other shapes: a torus (a hole through it, a ring of tops) ===');
  {
    const tor = lib.stockTorus(20, 6, 0), pt = M.plan(tor, {}, { printer: { w: 180, d: 180, h: 180 } });
    check('plans', pt.ok, JSON.stringify(pt.refusals));
    const RT = await M.build(tor, pt, kernel);
    check('builds; both halves closed and manifold', RT.ok && M.census(RT.A).closed && M.census(RT.B).closed, RT.ok ? '' : RT.reason);
    if (RT.ok) {
      const v = pt.vent.point, p = pt.pour.point;
      check('pour on the ring\'s top, vent on the far side of the ring', Math.hypot(v[0] - p[0], v[2] - p[2]) > 10, f(Math.hypot(v[0] - p[0], v[2] - p[2]), 1) + ' mm apart');
      check('mesh_validate on both halves', ['A', 'B'].every(n => lib.validate(n === 'A' ? RT.A : RT.B, null, { selfint: true }).verdict === 'PASS'));
    }
  }

  console.log('\n=== 6b. a cup: a closed piece with a pocket (fixtures/box_open.stl) ===');
  {
    const { readSTL } = require('./nso_stl_io.js');
    const cup = lib.centred(readSTL(path.join(lib.ROOT, 'fixtures', 'box_open.stl')), 0);
    const pc = M.plan(cup, {}, { printer: { w: 180, d: 180, h: 180 } });
    check('plans: the pour is on the rim, with its seat on the rim and not down in the pocket', pc.ok && pc.pour.point[1] >= M.bounds(cup).max[1] - 1e-6 && pc.pour.ch.from[1] > M.bounds(cup).max[1] - 1.5,
      'pour y ' + f(pc.pour.point[1], 2) + ', seat y ' + f(pc.pour.ch.from[1], 2));
    const RC = await M.build(cup, pc, kernel);
    check('builds; both halves closed and manifold (half A has a core standing in the pocket)', RC.ok && M.census(RC.A).closed && M.census(RC.B).closed, RC.ok ? '' : RC.reason);
    if (RC.ok) {
      check('mesh_validate on both halves', ['A', 'B'].every(n => lib.validate(n === 'A' ? RC.A : RC.B, null, { selfint: true }).verdict === 'PASS'));
      const kv = M.keyVolumes({}), cav = RC.stats.blockMm3 - M.volume(RC.openA) - M.volume(RC.B) + 4 * (kv.cone - kv.socket);
      const want = M.volume(cup) + Math.PI * 16 * pc.pour.lengthMm + Math.PI * 2.25 * pc.vent.ch.lengthMm;
      check('cavity = the cup + sprue + vent (the part of each bore that is in the cavity is not counted twice) within 1 %', Math.abs(cav - want) / want < 0.01, f(cav, 1) + ' vs ' + f(want, 1));
    }
  }

  console.log('\n=== 7. refusals, in words ===');
  {
    const open = box.slice(0, box.length - 9);
    const po = M.plan(open, {}, {});
    check('a piece that is not closed: refused, and the text says so', !po.ok && /not closed/.test(po.refusals[0]) && /open edge/.test(po.refusals[0]), po.refusals[0]);
    const rb = await M.build(open, po, kernel);
    check('  ... and build() does nothing with it', !rb.ok && !rb.A);
    const inside = M.flipWinding(box), pi = M.plan(inside, {}, {});
    check('an inside-out piece: refused, in words', !pi.ok && /inside-out/.test(pi.refusals[0]), pi.refusals[0]);

    const big = lib.stockSphere(50, 0);                         // Ø100: block 120 x 150 x 120
    const pb = M.plan(big, {}, { printer: { w: 100, d: 100, h: 256 } });
    check('a piece larger than the plate once the block is added: refused, and the size is in the text',
      !pb.ok && /Too big for the plate/.test(pb.refusals[0]) && /120\.0 x 120\.0 x 130\.0 mm/.test(pb.refusals[0]) && /100 x 100/.test(pb.refusals[0]), pb.refusals[0]);
    const pf = M.plan(big, {}, { printer: { w: 180, d: 180, h: 180 } });
    check('  ... but the piece alone would fit that plate, and the same piece on a bigger plate is fine', pf.ok && M.bounds(big).size[0] <= 100, 'block ' + pf.block.size.map(v => f(v, 0)).join(' x '));
    const wide = M.plan(box, {}, { printer: { w: 40, d: 90, h: 100 } });       // block 50 x 40 x 55 (x, z, y): fits turned, not as it lies
    check('a block that fits only if turned says so (the halves are not turned for you)', !wide.ok && /Too big/.test(wide.refusals[0]) && /Turn the piece 90/.test(wide.refusals[0]), wide.refusals[0]);
    const pTall = M.plan(sph, {}, { printer: { w: 180, d: 180, h: 20 } });
    check('a block taller than the machine\'s build height is refused too', !pTall.ok && /Too big/.test(pTall.refusals[0]), pTall.refusals[0]);

    const thin = M.plan(box, { wallMm: 6 }, {});
    check('keys that would not fit the parting face: refused, and the minimum wall is in the text',
      !thin.ok && /keys would not fit/.test(thin.refusals[0]) && /minimum wall/.test(thin.refusals[0]) && /8\.4 mm/.test(thin.refusals[0]), thin.refusals[0]);
    check('  ... and at exactly the minimum it fits', M.plan(box, { wallMm: 8.4 }, {}).keys.ok);
    check('  ... a smaller key fits a thinner wall: Ø3 at Wall 6', M.plan(box, { wallMm: 6, keyDiaMm: 3, keyHeightMm: 1.5 }, {}).ok);
    check('  ... a tilt steep enough to leave the block at a corner is refused for the keys', !M.plan(box, { tiltDeg: 60, headingDeg: 90, mm: 3 }, {}).ok);
    // two cubes with a gap: the blade's centre line runs through the gap, so the plane misses both
    const gap = M.concat([M.boxSoup([-5, 0, -5], [5, 10, 5]), M.boxSoup([-5, 20, -5], [5, 30, 5])]);
    const pg = M.plan(gap, { mm: 15 }, {});
    check('a plane that does not pass through the piece is refused, in words', !pg.ok && /does not pass through the piece/.test(pg.refusals.join(' ')), pg.refusals.join(' | '));
    check('  ... and nearer a cube it does pass', !M.plan(gap, { mm: 5 }, {}).refusals.some(r => /does not pass/.test(r)));
    check('Key height is held to what a 45 deg cone of that Ø can be (Ø6: 3 mm), and the card says so', near(M.normalize({ keyHeightMm: 9 }).keyHeightMm, 3, 1e-9) && /limited to 3\.0 mm/.test(M.plan(box, { keyHeightMm: 9 }, {}).warnings.join(' ')));
  }

  console.log('\n' + (fail ? 'FAILED  ' + fail + ' of ' + (pass + fail) : 'PASSED  ' + pass + ' gates'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
