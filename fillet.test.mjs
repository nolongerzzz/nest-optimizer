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
} from './fillet.mjs';

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

// ---- summary ----
console.log(`\n──────────────────────────────────────`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failed) {
  console.log(`  failing: ${fails.join(', ')}`);
  process.exit(1);
}
