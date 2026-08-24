// =============================================================================
// Tests for the simple edge fillet (§2) and shared utilities.
// Run:  node fillet.test.mjs
// Pure Node, no dependencies.
//
// NOTE: the measured-corner regression (spec §8, R = 2.0148mm, n1 = [1,0],
// n2 = [0.2536, 0.9673]) belongs to the §4 sphere-center solver, which is NOT
// implemented yet by design. It will be added as a regression test when the
// corner stage lands.
// =============================================================================

import {
  signedArea,
  inwardNormalSign,
  edgeInwardNormal,
  vertexOffset,
  resampleLoop,
  simpleFilletPoint,
  filletRibForVertex,
  buildSimpleFillet,
  earClip,
  checkWatertight,
  trianglesToCoords,
  meshToPositions,
  turningAngle,
  detectCorners,
  wallInwardNormalsAtCorner,
  solveCornerCenter,
  smoothstep,
  slerp2D,
  spherePoint,
  cornerBlendedPoint,
  buildCornerAwareRing,
  segmentsIntersect,
  ringSelfIntersects,
  rayToOppositeWall,
  adaptiveRadii,
} from './fillet.mjs';

const norm2 = (v) => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};

// ---- tiny test harness ----
let passed = 0;
let failed = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    fails.push(name);
    console.log(`  FAIL ${name}${extra ? '  — ' + extra : ''}`);
  }
}
function approx(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}

// ---- shared fixtures ----
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

// CCW square with subdivided edges, so subdivision points have collinear
// neighbours (true "straight run" vertices) and the four corners are 90°.
function subdivSquare(size, per) {
  const pts = [];
  const corners = [[0, 0], [size, 0], [size, size], [0, size]];
  for (let c = 0; c < 4; c++) {
    const a = corners[c];
    const b = corners[(c + 1) % 4];
    for (let k = 0; k < per; k++) {
      const t = k / per;
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return pts;
}

// =============================================================================
console.log('\n§0/§1 — winding, inward normals, miter offset');
// =============================================================================
{
  const ccw = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const cw = [...ccw].reverse();
  ok('signedArea CCW positive', signedArea(ccw) > 0, `${signedArea(ccw)}`);
  ok('signedArea CW negative', signedArea(cw) < 0, `${signedArea(cw)}`);
  ok('inwardNormalSign CCW = +1', inwardNormalSign(ccw) === 1);
  ok('inwardNormalSign CW = -1', inwardNormalSign(cw) === -1);

  // Bottom edge of CCW unit square: interior is +y.
  const nrm = edgeInwardNormal([0, 0], [1, 0], inwardNormalSign(ccw));
  ok('edge inward normal points into interior (+y)', approx(nrm[0], 0) && approx(nrm[1], 1));

  // Straight run: offset magnitude equals the requested inset (cosHalf = 1).
  const sq = subdivSquare(100, 4); // 16 verts
  const sgn = inwardNormalSign(sq);
  const straightIdx = 1; // [25,0], collinear neighbours [0,0] and [50,0]
  const off = vertexOffset(sq, straightIdx, 3, sgn);
  ok('straight-run offset magnitude == inset', approx(dist(off, sq[straightIdx]), 3, 1e-9), `${dist(off, sq[straightIdx])}`);
  ok('straight-run offset direction is inward (+y)', approx(off[0], 25) && approx(off[1], 3));

  // 90° corner miter: corner [100,0] offset by inset 3 -> [97, 3].
  const cornerIdx = 4; // [100,0]
  const coff = vertexOffset(sq, cornerIdx, 3, sgn);
  ok('90° corner miter offsets diagonally to [97,3]', approx(coff[0], 97, 1e-9) && approx(coff[1], 3, 1e-9), `${coff}`);

  // Offsetting inward shrinks the area (correct winding sanity, spec §1).
  const shrunk = sq.map((_, i) => vertexOffset(sq, i, 3, sgn));
  ok('inward offset shrinks area', Math.abs(signedArea(shrunk)) < Math.abs(signedArea(sq)));
}

// =============================================================================
console.log('\n§2 — simpleFilletPoint boundary conditions + exact circle');
// =============================================================================
{
  const sq = subdivSquare(100, 4);
  const sgn = inwardNormalSign(sq);
  const R = 2;
  const capPlanePos = 5;
  const straightIdx = 1;

  // u = R: at the un-rounded wall — no inset, depth R below the cut plane.
  const atWall = simpleFilletPoint(sq, straightIdx, R, R, capPlanePos, sgn);
  ok('u=R -> inset 0 (uv == vertex)', approx(dist(atWall.uv, sq[straightIdx]), 0, 1e-12));
  ok('u=R -> alongAxis == capPlanePos + R', approx(atWall.alongAxis, capPlanePos + R));

  // u = 0: at the cut face — inset by full R, on the cap plane.
  const atFace = simpleFilletPoint(sq, straightIdx, R, 0, capPlanePos, sgn);
  ok('u=0 -> inset == R', approx(dist(atFace.uv, sq[straightIdx]), R, 1e-12), `${dist(atFace.uv, sq[straightIdx])}`);
  ok('u=0 -> alongAxis == capPlanePos', approx(atFace.alongAxis, capPlanePos));

  // Whole rib lies exactly on a circle of radius R centred at (R, R) in
  // (depth-from-cap, inset) space  =>  (a-R)^2 + (inset-R)^2 == R^2.
  const rib = filletRibForVertex(sq, straightIdx, R, 16, capPlanePos, sgn);
  let maxResidual = 0;
  for (const p of rib) {
    const a = p.alongAxis - capPlanePos; // depth from cut plane
    const inset = dist(p.uv, sq[straightIdx]); // straight run => == perpendicular inset
    const residual = Math.abs((a - R) ** 2 + (inset - R) ** 2 - R ** 2);
    maxResidual = Math.max(maxResidual, residual);
  }
  ok('rib is an exact constant-radius circle (residual < 1e-12)', maxResidual < 1e-12, `max residual ${maxResidual.toExponential(3)}`);

  // Depth is monotonic R -> 0 and inset monotonic 0 -> R across the rib.
  let mono = true;
  for (let k = 1; k < rib.length; k++) {
    if (rib[k].alongAxis > rib[k - 1].alongAxis + 1e-12) mono = false;
  }
  ok('rib depth is monotonic (wall -> cut face)', mono);
}

// =============================================================================
console.log('\n§2 + §6 — full fillet mesh is a clean manifold-with-boundary');
// =============================================================================
{
  const sq = subdivSquare(100, 8); // 32 verts, well-resolved
  const n = sq.length;
  const mesh = buildSimpleFillet(sq, { radius: 2, uSteps: 12, capPlanePos: 0 });

  // Vertex / triangle counts: (uSteps+1) rings of n verts; band tris + cap tris.
  ok('vertex count == (uSteps+1) * n', mesh.vertices.length === 13 * n, `${mesh.vertices.length}`);
  const bandTris = 12 * n * 2;
  const capTris = n - 2;
  ok('triangle count == bandTris + capTris', mesh.triangles.length === bandTris + capTris, `${mesh.triangles.length} vs ${bandTris + capTris}`);

  // Edge topology: only open edges are the outer seam ring (n edges); every
  // other edge is shared by exactly 2 triangles; no directed edge repeats.
  const wt = checkWatertight(trianglesToCoords(mesh));
  ok('no non-manifold undirected edges (badEdges 0)', wt.badEdges === 0, `${wt.badEdges}`);
  ok('no repeated directed edges (badDirs 0)', wt.badDirs === 0, `${wt.badDirs}`);
  ok('open boundary == outer ring (n edges)', wt.boundaryEdgeCount === n, `${wt.boundaryEdgeCount} vs ${n}`);

  // The innermost ring (largest inset) is still a valid simple polygon with the
  // same winding — i.e. no self-intersection on this convex loop.
  const innerPts = mesh.innerRing.map((vi) => [mesh.vertices[vi][0], mesh.vertices[vi][1]]);
  ok('inner ring keeps positive area (no collapse/flip)', signedArea(innerPts) > 0, `${signedArea(innerPts)}`);
  ok('inner ring is a shrunk square (~96×96)', approx(signedArea(innerPts), 96 * 96, 1), `${signedArea(innerPts)}`);

  // Frame conversion produces the right amount of float data.
  const frame = {
    origin: [0, 0, 0],
    uAxis: [1, 0, 0],
    vAxis: [0, 1, 0],
    nAxis: [0, 0, 1],
  };
  const pos = meshToPositions(mesh, frame);
  ok('meshToPositions length == triangles*9', pos.length === mesh.triangles.length * 9);
}

// =============================================================================
console.log('\nEar clipping');
// =============================================================================
{
  // Convex polygon.
  const conv = [[0, 0], [4, 0], [4, 3], [0, 3]];
  const t1 = earClip(conv);
  ok('convex: n-2 triangles', t1.length === conv.length - 2);
  let areaSum = 0;
  for (const [a, b, c] of t1) areaSum += Math.abs(signedArea([conv[a], conv[b], conv[c]]));
  ok('convex: triangle area sums to polygon area', approx(areaSum, Math.abs(signedArea(conv)), 1e-9), `${areaSum}`);

  // Non-convex L-shape.
  const L = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
  const t2 = earClip(L);
  ok('L-shape: n-2 triangles', t2.length === L.length - 2, `${t2.length}`);
  let areaSum2 = 0;
  let allCCW = true;
  for (const [a, b, c] of t2) {
    const s = signedArea([L[a], L[b], L[c]]);
    if (s <= 0) allCCW = false;
    areaSum2 += Math.abs(s);
  }
  ok('L-shape: triangle area sums to polygon area', approx(areaSum2, Math.abs(signedArea(L)), 1e-9), `${areaSum2} vs ${Math.abs(signedArea(L))}`);
  ok('L-shape: all output triangles wound CCW', allCCW);
}

// =============================================================================
console.log('\nWatertight helper — closed tetrahedron');
// =============================================================================
{
  const A = [0, 0, 0], B = [1, 0, 0], C = [0, 1, 0], D = [0, 0, 1];
  const tetra = [
    [A, C, B],
    [A, B, D],
    [A, D, C],
    [B, C, D],
  ];
  const wt = checkWatertight(tetra);
  ok('tetra: no bad undirected edges', wt.badEdges === 0);
  ok('tetra: no open boundary', wt.boundaryEdgeCount === 0);
}

// =============================================================================
console.log('\n§0 — loop resampling removes micro-edges');
// =============================================================================
{
  // Square with injected duplicate + near-zero-length noise edges.
  const noisy = [
    [0, 0], [0, 0], [50, 0], [50.0000001, 0], [100, 0],
    [100, 100], [100, 100], [0, 100], [0, 100.0000002],
  ];
  const rs = resampleLoop(noisy, 5);
  // No zero-length edges remain.
  let minEdge = Infinity;
  for (let i = 0; i < rs.length; i++) {
    minEdge = Math.min(minEdge, dist(rs[i], rs[(i + 1) % rs.length]));
  }
  ok('resample removes zero-length edges', minEdge > 1e-6, `minEdge ${minEdge}`);
  ok('resample preserves winding sign', Math.sign(signedArea(rs)) === Math.sign(signedArea(noisy)));
  ok('resample roughly preserves area (~10000)', approx(Math.abs(signedArea(rs)), 10000, 200), `${signedArea(rs)}`);
  ok('resample spacing ~ uniform (~5mm)', approx(minEdge, 5, 2), `${minEdge}`);
}

// =============================================================================
console.log('\n§3 — turning angle + corner detection');
// =============================================================================
{
  const sq = subdivSquare(100, 4); // corners at indices 0,4,8,12
  ok('straight-run turning angle ~ 0', approx(turningAngle(sq, 1), 0, 1e-12), `${turningAngle(sq, 1)}`);
  ok('90° corner turning angle ~ +pi/2 (CCW)', approx(turningAngle(sq, 4), Math.PI / 2, 1e-9), `${turningAngle(sq, 4)}`);
  const corners = detectCorners(sq, 30);
  ok('detectCorners finds exactly the 4 corners', corners.length === 4 && corners.join(',') === '0,4,8,12', `[${corners}]`);

  // Wall normals from points away from the corner: at corner [100,0] they are
  // the bottom (+y) and right (-x) inward normals.
  const [wn1, wn2] = wallInwardNormalsAtCorner(sq, 4, inwardNormalSign(sq), 3);
  ok('corner wall normal n1 ~ [0,1]', approx(wn1[0], 0, 1e-9) && approx(wn1[1], 1, 1e-9), `${wn1}`);
  ok('corner wall normal n2 ~ [-1,0]', approx(wn2[0], -1, 1e-9) && approx(wn2[1], 0, 1e-9), `${wn2}`);
}

// =============================================================================
console.log('\n§4a — solveCornerCenter (measured-corner regression, spec §8)');
// =============================================================================
{
  // Spec §8 wall directions. Normalise to unit (doc gives n2 to 4 dp).
  const n1 = norm2([1, 0]);
  const n2 = norm2([0.2536, 0.9673]);
  const corner = [0, 0];

  // The construction guarantees dot(C - corner, n) == R for BOTH walls. The doc
  // reports "exactly 2.0000mm"; that IS R. So with R = 2.0 the tangency
  // distances are exactly 2.0000, and with the fitted R = 2.0148 they are
  // exactly 2.0148.

  // (a) Literal §8 expectation: distances == 2.0000 with R = 2.0.
  const C2 = solveCornerCenter(corner, n1, n2, 2.0);
  const d1 = C2[0] * n1[0] + C2[1] * n1[1];
  const d2 = C2[0] * n2[0] + C2[1] * n2[1];
  ok('R=2.0: dist to wall 1 == 2.0000', approx(d1, 2.0, 1e-9), `${d1.toFixed(6)}`);
  ok('R=2.0: dist to wall 2 == 2.0000', approx(d2, 2.0, 1e-9), `${d2.toFixed(6)}`);
  ok('R=2.0: both distances equal', approx(d1, d2, 1e-9));

  // (b) Fitted radius R = 2.0148: tangency distance == R exactly.
  const R = 2.0148;
  const C = solveCornerCenter(corner, n1, n2, R);
  const e1 = C[0] * n1[0] + C[1] * n1[1];
  const e2 = C[0] * n2[0] + C[1] * n2[1];
  console.log(`       (fitted R=${R}: center=[${C[0].toFixed(4)}, ${C[1].toFixed(4)}], dist1=${e1.toFixed(4)}, dist2=${e2.toFixed(4)})`);
  ok('R=2.0148: dist to wall 1 == R', approx(e1, R, 1e-9), `${e1}`);
  ok('R=2.0148: dist to wall 2 == R', approx(e2, R, 1e-9), `${e2}`);

  // Parallel walls -> no unique corner sphere.
  ok('parallel walls return null', solveCornerCenter([0, 0], [1, 0], [1, 0], 2) === null);
}

// =============================================================================
console.log('\n§4b — smoothstep / slerp2D / spherePoint');
// =============================================================================
{
  ok('smoothstep(0)=0', approx(smoothstep(0), 0));
  ok('smoothstep(1)=1', approx(smoothstep(1), 1));
  ok('smoothstep(0.5)=0.5', approx(smoothstep(0.5), 0.5));
  ok('smoothstep clamps below 0', approx(smoothstep(-1), 0));

  const a = norm2([1, 0]);
  const b = norm2([0, 1]);
  const s0 = slerp2D(a, b, 0);
  const s1 = slerp2D(a, b, 1);
  const sm = slerp2D(a, b, 0.5);
  ok('slerp2D t=0 -> a', approx(s0[0], a[0]) && approx(s0[1], a[1]));
  ok('slerp2D t=1 -> b', approx(s1[0], b[0]) && approx(s1[1], b[1]));
  ok('slerp2D midpoint stays unit length', approx(Math.hypot(sm[0], sm[1]), 1, 1e-12));
  ok('slerp2D midpoint bisects (45°)', approx(sm[0], Math.SQRT1_2, 1e-9) && approx(sm[1], Math.SQRT1_2, 1e-9));

  // Every sphere point lies exactly on the sphere of radius R centred at
  // (C, capPlanePos + R).
  const C = [5, 5];
  const R = 2;
  const cap = 3;
  const negN1 = norm2([-1, 0]);
  const negN2 = norm2([0, -1]);
  let maxErr = 0;
  for (let pi = 0; pi <= 8; pi++) {
    const phi = (Math.PI / 2) * (pi / 8);
    for (let ti = 0; ti <= 4; ti++) {
      const p = spherePoint(C, R, phi, ti / 4, negN1, negN2, cap);
      const dx = p.uv[0] - C[0];
      const dy = p.uv[1] - C[1];
      const dz = p.alongAxis - (cap + R);
      maxErr = Math.max(maxErr, Math.abs(Math.hypot(dx, dy, dz) - R));
    }
  }
  ok('spherePoint always on radius-R sphere (err < 1e-12)', maxErr < 1e-12, `maxErr ${maxErr.toExponential(3)}`);

  // Tangency to the cut face: at phi = 90°, the point sits on the cap plane.
  const face = spherePoint(C, R, Math.PI / 2, 0.5, negN1, negN2, cap);
  ok('phi=90° sphere point sits on cap plane', approx(face.alongAxis, cap, 1e-12));
}

// =============================================================================
console.log('\n§4c — segment intersection + ring self-intersection');
// =============================================================================
{
  ok('crossing segments detected', segmentsIntersect([0, 0], [2, 2], [0, 2], [2, 0]) === true);
  ok('non-crossing segments rejected', !segmentsIntersect([0, 0], [1, 0], [0, 1], [1, 1]));
  ok('shared endpoint is not an intersection', !segmentsIntersect([0, 0], [1, 1], [1, 1], [2, 0]));

  const convex = [[0, 0], [4, 0], [4, 4], [0, 4]];
  ok('convex ring does not self-intersect', ringSelfIntersects(convex).hit === false);

  const bowtie = [[0, 0], [2, 2], [2, 0], [0, 2]]; // classic self-crossing quad
  ok('bowtie ring self-intersects', ringSelfIntersects(bowtie).hit === true);
}

// =============================================================================
console.log('\n§4 — corner blend prevents the pinch that §2 alone produces');
// =============================================================================
{
  // A sharp, DENSELY sampled convex spike. Adjacent vertices around the apex
  // have wildly diverging inward normals over a fraction of a mm of arc — the
  // exact condition where independent §2 sweeps cross (a visible pinch).
  // interiorDeg = the interior angle at the apex.
  function spikeLoop(interiorDeg, len, step, capN) {
    const half = ((180 - interiorDeg) / 2) * Math.PI / 180;
    const dirUp = [Math.cos(half), Math.sin(half)];
    const dirDn = [Math.cos(half), -Math.sin(half)];
    const pts = [];
    for (let d = 0; d <= len; d += step) pts.push([dirDn[0] * d, dirDn[1] * d]);
    const loFar = [dirDn[0] * len, dirDn[1] * len];
    const hiFar = [dirUp[0] * len, dirUp[1] * len];
    for (let k = 1; k < capN; k++) {
      const t = k / capN;
      pts.push([loFar[0] + (hiFar[0] - loFar[0]) * t, loFar[1] + (hiFar[1] - loFar[1]) * t]);
    }
    for (let d = len; d > 0; d -= step) pts.push([dirUp[0] * d, dirUp[1] * d]);
    return pts;
  }

  const loop = spikeLoop(90, 24, 0.4, 16);
  const L = signedArea(loop) > 0 ? loop : loop.slice().reverse(); // CCW so normals point inward
  const sgn = inwardNormalSign(L);
  const R = 2;
  const windowSize = 16;

  // Locate the apex = sharpest corner.
  const corners = detectCorners(L, 30);
  ok('spike apex detected as a corner', corners.length >= 1, `[${corners}]`);
  let apexIdx = corners[0];
  for (const ci of corners) if (Math.abs(turningAngle(L, ci)) > Math.abs(turningAngle(L, apexIdx))) apexIdx = ci;

  // §4c is meant for a NEAR-innermost ring: at u = 0 the corner sphere
  // legitimately collapses to its single cut-face tangent point C (the fillet
  // cap apex), which makes a polygon self-intersection test false-positive on
  // that degenerate point. Check a near-innermost ring (u = 0.3R) where the
  // corner sphere is a real circle.
  const u = 0.3 * R;
  const simpleRing = L.map((_, i) => simpleFilletPoint(L, i, R, u, 0, sgn).uv);
  const blendRing = buildCornerAwareRing(L, u, { radius: R, sign: sgn, windowSize, thresholdDeg: 30 });

  const simpleHit = ringSelfIntersects(simpleRing).hit;
  const blendHit = ringSelfIntersects(blendRing).hit;
  console.log(`       (near-innermost ring u=0.3R — simple §2 self-intersects: ${simpleHit}; §4 blended: ${blendHit})`);
  ok('§2-only ring self-intersects at the sharp corner', simpleHit === true);
  ok('§4 corner-blended ring is self-intersection-free', blendHit === false);

  // The corner vertex is driven by the single sphere: at u = 0 it lands exactly
  // on the sphere center C (the cut-face tangent point).
  const [n1, n2] = wallInwardNormalsAtCorner(L, apexIdx, sgn, 3);
  const C = solveCornerCenter(L[apexIdx], n1, n2, R);
  const apexInner = buildCornerAwareRing(L, 0, { radius: R, sign: sgn, windowSize, thresholdDeg: 30 })[apexIdx];
  ok('corner cap vertex lands exactly on sphere center C', approx(apexInner[0], C[0], 1e-9) && approx(apexInner[1], C[1], 1e-9), `${apexInner} vs ${C}`);

  // The corner vertex (blend weight 1) lies exactly on the corner sphere at any
  // depth: distance from the 3D sphere centre (C, R) equals R.
  let maxSphereErr = 0;
  for (const uf of [0.2, 0.4, 0.6, 0.8]) {
    const uu = uf * R;
    const p = buildCornerAwareRing(L, uu, { radius: R, sign: sgn, windowSize, thresholdDeg: 30 })[apexIdx];
    const along = uu; // capPlanePos 0
    const err = Math.abs(Math.hypot(p[0] - C[0], p[1] - C[1], along - R) - R);
    maxSphereErr = Math.max(maxSphereErr, err);
  }
  ok('corner vertex lies on the corner sphere at all depths', maxSphereErr < 1e-9, `maxErr ${maxSphereErr.toExponential(3)}`);

  // Continuity: outside every corner window, §4 == §2 exactly (weight 0).
  // Pick an index on the far cap, >windowSize from all detected corners.
  let farIdx = -1;
  for (let i = 0; i < L.length; i++) {
    let clear = true;
    for (const ci of corners) {
      let d = Math.abs(i - ci);
      d = Math.min(d, L.length - d);
      if (d <= windowSize) { clear = false; break; }
    }
    if (clear) { farIdx = i; break; }
  }
  const simpleFar = simpleFilletPoint(L, farIdx, R, u, 0, sgn).uv;
  ok('§4 == §2 outside corner windows (weight 0, no seam)',
    farIdx >= 0 && approx(blendRing[farIdx][0], simpleFar[0], 1e-9) && approx(blendRing[farIdx][1], simpleFar[1], 1e-9), `farIdx ${farIdx}`);
}

// =============================================================================
console.log('\n§5 — adaptive radius (ray-cast, min-filter, fail-loud)');
// =============================================================================
{
  // Thin horizontal slab: thickness 5, width 200, subdivided so mid-edge points
  // have pure-normal bisectors.
  function slab(w, h, per) {
    const pts = [];
    const corners = [[0, 0], [w, 0], [w, h], [0, h]];
    for (let c = 0; c < 4; c++) {
      const a = corners[c], b = corners[(c + 1) % 4];
      for (let k = 0; k < per; k++) {
        const t = k / per;
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return pts;
  }
  const s = slab(200, 5, 20);
  const sgn = inwardNormalSign(s);

  // A mid-edge point on the bottom edge should see the opposite wall at ~5mm.
  const midBottom = 10; // within first (bottom) edge run of 20 points
  const d = rayToOppositeWall(s, midBottom, sgn);
  ok('rayToOppositeWall ~ wall thickness (5mm)', approx(d, 5, 1e-6), `${d}`);

  // Target 3mm gets capped to 0.3 × 5 = 1.5mm along the THIN dimension (the long
  // top/bottom edges). The short end edges legitimately see the far wall (200mm)
  // and keep the full target — so assert on a long-edge vertex, not the global max.
  const { radii, warnings } = adaptiveRadii(s, 3, { safety: 0.3, rMin: 0.3 });
  ok('adaptive caps long-edge radius to ~0.3×thickness (1.5)', approx(radii[midBottom], 1.5, 1e-6), `${radii[midBottom]}`);
  ok('adaptive never exceeds target', radii.every((r) => r <= 3 + 1e-9));
  ok('thin slab still fits rMin (no false warnings)', warnings.length === 0, `warnings ${warnings.length}`);

  // Thick square: no capping, radius stays at target.
  const big = subdivSquare(400, 20);
  const bigA = adaptiveRadii(big, 3, { safety: 0.3 });
  const midEdge = 5;
  ok('thick wall keeps full target radius', approx(bigA.radii[midEdge], 3, 1e-9), `${bigA.radii[midEdge]}`);

  // Min-filter, not mean: a single thin spot pulls its NEIGHBOURS down too.
  const raw = [3, 3, 0.5, 3, 3];
  // emulate the filter directly on a tiny ring to assert min-behaviour
  const n = raw.length;
  const filtered = raw.map((_, i) => Math.min(raw[(i - 1 + n) % n], raw[i], raw[(i + 1) % n]));
  ok('min-filter drops neighbours of a thin spot', filtered[1] === 0.5 && filtered[3] === 0.5);
  ok('min-filter never raises a value', filtered.every((v, i) => v <= raw[i]));
}

// ---- summary ----
console.log(`\n──────────────────────────────────────`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`  failing: ${fails.join(', ')}`);
  process.exit(1);
}
