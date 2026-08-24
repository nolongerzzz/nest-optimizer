// =============================================================================
// Cut-Edge Rounding (fillet) — pure geometry math
// =============================================================================
//
// Target stack: Three.js r160, non-indexed BufferGeometry ("triangle soup"),
// NO CSG library. Everything in this file is plain vertex/triangle math on
// number arrays so it can be unit-tested in pure Node and later fed straight
// into a Float32Array at the Three.js boundary.
//
// This module implements ONLY the "simple / smooth edge fillet" path
// (Section 2 of cut-edge-fillet-algorithm.md), plus the shared utilities it
// depends on (loop resampling, inward normals, miter offset, ear-clip cap,
// watertight check). The sharp-corner sphere blend (Section 4) is intentionally
// NOT here yet — per the implementation order it comes only after §2 is clean
// and tested.
//
// Coordinate model
// ----------------
// The boundary loop of the cut lives in the cut plane. We work in that plane's
// local 2D frame as an ordered array of [u, v] points (a single simple closed
// curve, no holes). "alongAxis" is the signed position along the cap's normal
// axis: it is the distance measured from the flat cut plane INTO the part.
//
// The §2 fillet is an exact constant-radius quarter-circle. Parametrise a rib
// by phi (0 at the un-rounded wall, 90° at the cut face). With
//     u     = R * (1 - sin phi)      // depth from the cut plane, R -> 0
//     inset = R * (1 - cos phi)      // how far the point moves inward
// the pair (u, inset) lies exactly on a circle of radius R centred at (R, R),
// i.e. a true rolling-ball fillet. (Proven in the spec + regression tests.)
//
// Radius policy (decision, documented up front)
// ---------------------------------------------
// §2 uses a single UNIFORM radius. On smooth/straight runs the spec guarantees
// no failure modes, so there is nothing to adapt to and a constant R is both
// correct and cheapest. ADAPTIVE radius (ray-cast to the opposite wall, cap to
// ~0.3x, min-filter across neighbours — spec §5) becomes relevant only where a
// fillet can self-intersect, which is at sharp corners. It will be introduced
// together with the §4 corner handling, with a fail-loud fallback when even a
// minimum meaningful radius will not fit. Keeping §2 uniform avoids paying for
// (and testing) ray-casting before the corner stage needs it.
// =============================================================================

// --------------------------------------------------------------------------
// 0. Small 2D helpers
// --------------------------------------------------------------------------

/** Shoelace signed area. > 0 for counter-clockwise (CCW) winding. */
export function signedArea(loop) {
  let a = 0;
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return 0.5 * a;
}

/**
 * Which perpendicular of a directed edge points INTO the loop interior.
 * For a CCW loop the interior is to the left of each edge, so the inward
 * normal is (-dy, dx); for a CW loop it is the opposite. Returns +1 or -1 so
 * callers can offset inward regardless of the loop's winding convention.
 */
export function inwardNormalSign(loop) {
  return signedArea(loop) > 0 ? 1 : -1;
}

/**
 * §1 — unit inward normal of the edge p1->p2.
 * Rotates the edge direction 90°; `sign` selects the inward side for this
 * loop's winding (see inwardNormalSign).
 */
export function edgeInwardNormal(p1, p2, sign = 1) {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const len = Math.hypot(dx, dy) || 1e-12;
  return [sign * (-dy / len), sign * (dx / len)];
}

/**
 * §1 — miter join. Offset loop vertex i inward by `inset`, measured as the
 * perpendicular distance from BOTH adjacent walls (so straight runs stay
 * parallel and corners keep a constant offset). The bisector magnitude is
 * inset / cos(halfAngle); cosHalf is clamped so a very sharp corner cannot
 * blow the offset up to infinity (that regime is handled properly by §4).
 */
export function vertexOffset(loop, i, inset, sign) {
  const n = loop.length;
  const prev = loop[(i - 1 + n) % n];
  const curr = loop[i];
  const next = loop[(i + 1) % n];

  const n1 = edgeInwardNormal(prev, curr, sign);
  const n2 = edgeInwardNormal(curr, next, sign);

  let bx = n1[0] + n2[0];
  let by = n1[1] + n2[1];
  const blen = Math.hypot(bx, by) || 1e-9;
  bx /= blen;
  by /= blen;

  const cosHalf = Math.max(bx * n1[0] + by * n1[1], 0.3);
  const mag = inset / cosHalf;
  return [curr[0] + bx * mag, curr[1] + by * mag];
}

// --------------------------------------------------------------------------
// 0b. Loop resampling — kill float-noise micro-edges before any direction math
// --------------------------------------------------------------------------

/**
 * Resample a closed loop at (roughly) uniform arc-length `spacing` (mm).
 * Near-duplicate / zero-length edges make every inward-normal computation
 * unstable, so this is the recommended first step (spec §0). Preserves the
 * overall shape; returns a new loop.
 */
export function resampleLoop(loop, spacing = 0.35) {
  const n = loop.length;
  if (n < 2) return loop.slice();

  // Cumulative perimeter length.
  const seg = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p = loop[i];
    const q = loop[(i + 1) % n];
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    seg.push(d);
    total += d;
  }
  if (total < 1e-9) return [loop[0].slice()];

  const count = Math.max(3, Math.round(total / spacing));
  const step = total / count;

  const out = [];
  let segIdx = 0;
  let segStart = 0; // arc length at start of current segment
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (segIdx < n - 1 && segStart + seg[segIdx] < target) {
      segStart += seg[segIdx];
      segIdx++;
    }
    const p = loop[segIdx];
    const q = loop[(segIdx + 1) % n];
    const segLen = seg[segIdx] || 1e-12;
    const t = Math.min(1, Math.max(0, (target - segStart) / segLen));
    out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
  }
  return out;
}

// --------------------------------------------------------------------------
// 2. Simple edge fillet
// --------------------------------------------------------------------------

/**
 * §2 — one fillet-surface point for loop vertex i at depth u in [0, R].
 *
 *   phi   : swept angle, 0 at the un-rounded wall (u = R), 90° at the cut face (u = 0)
 *   inset : R * (1 - cos phi)         — inward offset in the cut plane
 *   along : capPlanePos + u           — position along the cap's normal axis
 *
 * Returns { alongAxis, uv } where uv is the 2D point in the cut plane.
 */
export function simpleFilletPoint(loop, i, R, u, capPlanePos, sign) {
  const sinPhi = Math.min(1, Math.max(0, 1 - u / R));
  const phi = Math.asin(sinPhi);
  const inset = R * (1 - Math.cos(phi));
  const uv = vertexOffset(loop, i, inset, sign);
  return { alongAxis: capPlanePos + u, uv };
}

/**
 * §2 — the full rib (profile) for a single loop vertex: `uSteps + 1` points
 * from the wall (u = R) down to the cut face (u = 0). Handy for verifying the
 * profile is a true circle.
 */
export function filletRibForVertex(loop, i, R, uSteps, capPlanePos, sign) {
  const rib = [];
  for (let k = 0; k <= uSteps; k++) {
    const u = R * (1 - k / uSteps); // R -> 0
    rib.push(simpleFilletPoint(loop, i, R, u, capPlanePos, sign));
  }
  return rib;
}

/**
 * §2 + §6 — assemble the whole simple-edge fillet as a triangle mesh in the
 * cut-plane parametric frame.
 *
 * Vertices are [uCoord, vCoord, alongAxis] triples (map to real 3D with
 * `ribToPositions` / a frame at the Three.js boundary). Triangles are index
 * triples into `vertices`, consistently wound.
 *
 * Rings run k = 0 (outer seam at the wall, u = R, inset 0) .. uSteps (inner
 * ring at the cut face, u = 0, inset R). Consecutive rings are joined by a
 * ruled quad strip (2 triangles / quad); the innermost ring is ear-clip
 * triangulated as the new, smaller flat cap.
 *
 * The result is a manifold-with-boundary: its ONLY open edge loop is the outer
 * ring (k = 0), which is exactly where it mates with the existing wall.
 */
export function buildSimpleFillet(loop, opts = {}) {
  const {
    radius,
    uSteps = 12,
    capPlanePos = 0,
    sign = inwardNormalSign(loop),
    resample = false,
    spacing = 0.35,
  } = opts;

  if (!(radius > 0)) throw new Error('buildSimpleFillet: radius must be > 0');

  const L = resample ? resampleLoop(loop, spacing) : loop;
  const n = L.length;
  const R = radius;

  const vertices = [];
  const ring = []; // ring[k][i] -> vertex index

  for (let k = 0; k <= uSteps; k++) {
    const u = R * (1 - k / uSteps);
    const row = [];
    for (let i = 0; i < n; i++) {
      const pt = simpleFilletPoint(L, i, R, u, capPlanePos, sign);
      row.push(vertices.length);
      vertices.push([pt.uv[0], pt.uv[1], pt.alongAxis]);
    }
    ring.push(row);
  }

  const triangles = [];

  // Ruled quad strips between consecutive rings.
  for (let k = 0; k < uSteps; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = ring[k][i];
      const b = ring[k][j];
      const c = ring[k + 1][j];
      const d = ring[k + 1][i];
      // quad (a,b,c,d) -> two triangles, consistent winding
      triangles.push([a, b, d]);
      triangles.push([b, c, d]);
    }
  }

  // Innermost ring -> new flat cap via ear clipping (in 2D cut-plane coords).
  const innerRow = ring[uSteps];
  const cap2D = innerRow.map((vi) => [vertices[vi][0], vertices[vi][1]]);
  const capTris = earClip(cap2D);
  for (const [x, y, z] of capTris) {
    triangles.push([innerRow[x], innerRow[y], innerRow[z]]);
  }

  return { vertices, triangles, outerRing: ring[0].slice(), innerRing: innerRow.slice(), loop: L };
}

// --------------------------------------------------------------------------
// Ear-clipping triangulation of a simple polygon (for the flat cap)
// --------------------------------------------------------------------------

function pointInTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Ear-clip a simple polygon. Returns triangles as [i, j, k] index triples into
 * the input, wound CCW. Robust O(n^2); returns [] on degenerate input.
 */
export function earClip(contour) {
  const n = contour.length;
  const tris = [];
  if (n < 3) return tris;

  // Work on an index list, normalised to CCW so "ear" tests use a fixed sign.
  const V = new Array(n);
  if (signedArea(contour) > 0) for (let i = 0; i < n; i++) V[i] = i;
  else for (let i = 0; i < n; i++) V[i] = n - 1 - i;

  let nv = n;
  let guard = 2 * nv;
  let v = nv - 1;

  while (nv > 2) {
    if (guard-- <= 0) break; // non-simple polygon safety valve

    const u = v % nv;
    v = (u + 1) % nv;
    const w = (v + 1) % nv;

    const A = contour[V[u]];
    const B = contour[V[v]];
    const C = contour[V[w]];

    // Convex (CCW) ear test: positive area and no other vertex inside.
    const cross = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    if (cross > 1e-12) {
      let isEar = true;
      for (let p = 0; p < nv; p++) {
        if (p === u || p === v || p === w) continue;
        const P = contour[V[p]];
        if (pointInTri(P[0], P[1], A[0], A[1], B[0], B[1], C[0], C[1])) {
          isEar = false;
          break;
        }
      }
      if (isEar) {
        tris.push([V[u], V[v], V[w]]);
        for (let s = v; s < nv - 1; s++) V[s] = V[s + 1];
        nv--;
        guard = 2 * nv;
      }
    }
  }
  return tris;
}

// --------------------------------------------------------------------------
// 6. Reassembly helpers
// --------------------------------------------------------------------------

/**
 * §6 — watertight / manifold check on a list of triangles given as coordinate
 * triples [[x,y,z],[x,y,z],[x,y,z]]. Every undirected edge should appear in
 * exactly 2 triangles; every directed edge at most once. Returns counts + the
 * list of boundary (once-used) undirected edge keys, so callers can confirm a
 * manifold-with-boundary attaches only along its expected open seam.
 */
export function checkWatertight(triangles, tol = 1e-4) {
  const key = (p) =>
    `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)},${Math.round(p[2] / tol)}`;
  const edgeCount = new Map();
  const dirCount = new Map();

  for (const tri of triangles) {
    for (let i = 0; i < 3; i++) {
      const a = key(tri[i]);
      const b = key(tri[(i + 1) % 3]);
      const ek = [a, b].sort().join('|');
      edgeCount.set(ek, (edgeCount.get(ek) || 0) + 1);
      const dk = a + '>' + b;
      dirCount.set(dk, (dirCount.get(dk) || 0) + 1);
    }
  }

  const boundaryEdges = [];
  let badEdges = 0;
  for (const [ek, c] of edgeCount) {
    if (c === 1) boundaryEdges.push(ek);
    else if (c !== 2) badEdges++;
  }
  const badDirs = [...dirCount.values()].filter((c) => c > 1).length;

  return {
    watertight: badEdges === 0 && badDirs === 0 && boundaryEdges.length === 0,
    badEdges,
    badDirs,
    boundaryEdgeCount: boundaryEdges.length,
    boundaryEdges,
  };
}

/** Resolve mesh index-triangles into coordinate-triples (for checkWatertight). */
export function trianglesToCoords(mesh) {
  return mesh.triangles.map((t) => t.map((vi) => mesh.vertices[vi]));
}

// =============================================================================
// 3. Sharp-corner detection
// =============================================================================

/**
 * §3 — signed turning angle at loop vertex i (radians). ~0 on a straight run;
 * +/- for a left/right turn. |angle| beyond a threshold marks a genuine corner
 * that needs the §4 sphere treatment instead of the §2 per-vertex sweep.
 */
export function turningAngle(loop, i) {
  const n = loop.length;
  const prev = loop[(i - 1 + n) % n];
  const curr = loop[i];
  const next = loop[(i + 1) % n];
  const a1 = Math.atan2(curr[1] - prev[1], curr[0] - prev[0]);
  const a2 = Math.atan2(next[1] - curr[1], next[0] - curr[0]);
  let d = a2 - a1;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** §3 — indices of vertices whose |turningAngle| exceeds `thresholdDeg` (default 30°). */
export function detectCorners(loop, thresholdDeg = 30) {
  const th = (thresholdDeg * Math.PI) / 180;
  const out = [];
  for (let i = 0; i < loop.length; i++) {
    if (Math.abs(turningAngle(loop, i)) > th) out.push(i);
  }
  return out;
}

/**
 * The two wall inward-normals meeting at a corner, computed from points `step`
 * vertices away so the immediate (possibly noisy) edges around the corner do
 * not contaminate the directions. Returns unit [n1, n2] where n1 is the
 * incoming wall and n2 the outgoing wall.
 */
export function wallInwardNormalsAtCorner(loop, i, sign, step = 3) {
  const n = loop.length;
  const s = Math.min(step, Math.floor(n / 3) || 1);
  const before = loop[(i - s + n) % n];
  const curr = loop[i];
  const after = loop[(i + s) % n];
  const n1 = edgeInwardNormal(before, curr, sign);
  const n2 = edgeInwardNormal(curr, after, sign);
  return [n1, n2];
}

// =============================================================================
// 4a. Single corner sphere center (tangent to both walls + the cut face)
// =============================================================================

/**
 * §4a — the ONE sphere center for a corner where two walls with inward normals
 * n1, n2 meet. Solves dot(C - corner, n1) = R and dot(C - corner, n2) = R via a
 * 2x2 linear solve, so C is exactly distance R from BOTH wall lines (and, in
 * 3D, from the cut face). Using one center per corner — not one per vertex — is
 * what prevents the crease/pinch a naive independent sweep produces.
 *
 * Returns null if the walls are (near) parallel (no unique corner sphere).
 * n1, n2 are assumed unit; normalise beforehand if unsure.
 */
export function solveCornerCenter(cornerPt, n1, n2, R) {
  const det = n1[0] * n2[1] - n1[1] * n2[0];
  if (Math.abs(det) < 1e-12) return null;
  const nx = (n2[1] - n1[1]) / det; // (n2y*1 - n1y*1) / det
  const ny = (n1[0] - n2[0]) / det; // (n1x*1 - n2x*1) / det
  return [cornerPt[0] + R * nx, cornerPt[1] + R * ny];
}

// =============================================================================
// 4b. Corner patch — blend the simple sweep toward the single sphere center
// =============================================================================

/** Clamped smoothstep. 0 at x<=0, 1 at x>=1, smooth in between. */
export function smoothstep(x) {
  x = Math.max(0, Math.min(1, x));
  return x * x * (3 - 2 * x);
}

/** §4b — spherical (great-circle) interpolation between two unit 2D directions. */
export function slerp2D(a, b, t) {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]));
  const theta = Math.acos(dot);
  if (theta < 1e-8) return [a[0], a[1]];
  const s = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / s;
  const wb = Math.sin(t * theta) / s;
  return [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1]];
}

/**
 * §4b — a point on the corner sphere.
 *   phi     : shared ring angle (0 at the wall, 90° at the cut face)
 *   tBlend  : position across the corner window, 0 -> negN1 side, 1 -> negN2 side
 * The direction from the center is slerped between the two (negated) wall
 * normals. alongAxis matches §2's convention (add capPlanePos at the caller).
 * By construction the returned point lies on a sphere of radius R centered at
 * (C, capPlanePos + R).
 */
export function spherePoint(C, R, phi, tBlend, negN1, negN2, capPlanePos = 0) {
  const nBlend = slerp2D(negN1, negN2, tBlend);
  const alongAxis = capPlanePos + R * (1 - Math.sin(phi));
  const cos = R * Math.cos(phi);
  return { alongAxis, uv: [C[0] + cos * nBlend[0], C[1] + cos * nBlend[1]] };
}

/** Signed vertex offset j - cornerIdx wrapped into [-n/2, n/2] (arc distance in vertices). */
function relIndex(j, cornerIdx, n) {
  let d = j - cornerIdx;
  while (d > n / 2) d -= n;
  while (d < -n / 2) d += n;
  return d;
}

/**
 * §4b — one blended fillet point at ring depth u for vertex j inside the window
 * of the corner at cornerIdx. Blends the §2 simple-sweep point (a) with the
 * single-sphere point (b) at weight smoothstep(1 - |rel|/windowSize): 1.0 at the
 * corner, 0.0 at the window edge (so it rejoins §2 with C0/continuity by
 * construction — no seam). Points outside the window should just use §2.
 */
export function cornerBlendedPoint(loop, j, opts) {
  const { cornerIdx, windowSize, C, R, negN1, negN2, u, capPlanePos = 0, sign } = opts;
  const n = loop.length;

  const sinPhi = Math.min(1, Math.max(0, 1 - u / R));
  const phi = Math.asin(sinPhi);

  const rel = relIndex(j, cornerIdx, n);
  const tBlend = Math.max(0, Math.min(1, (rel + windowSize) / (2 * windowSize)));

  const simple = simpleFilletPoint(loop, j, R, u, capPlanePos, sign);
  const sphere = spherePoint(C, R, phi, tBlend, negN1, negN2, capPlanePos);

  const w = smoothstep(1 - Math.abs(rel) / windowSize);
  return {
    alongAxis: simple.alongAxis, // identical for both terms (same u)
    uv: [
      (1 - w) * simple.uv[0] + w * sphere.uv[0],
      (1 - w) * simple.uv[1] + w * sphere.uv[1],
    ],
    weight: w,
  };
}

/**
 * Build one ring (at depth u) of 2D cut-plane points for `loop`, using the §2
 * simple sweep everywhere and the §4 corner blend within a window around each
 * detected corner. This is the ring whose validity §4c checks. Pure geometry;
 * does not assemble triangles.
 */
export function buildCornerAwareRing(loop, u, opts = {}) {
  const {
    radius,
    capPlanePos = 0,
    sign = inwardNormalSign(loop),
    thresholdDeg = 30,
    windowSize = 12,
    normalStep = 3,
    radii = null, // optional per-vertex radius (adaptive, §5)
  } = opts;

  const n = loop.length;
  const R0 = radius;
  const Rof = (i) => (radii ? radii[i] : R0);

  // Base: §2 simple sweep everywhere.
  const ring = [];
  for (let i = 0; i < n; i++) {
    const p = simpleFilletPoint(loop, i, Rof(i), u, capPlanePos, sign);
    ring.push(p.uv);
  }

  // Overlay: §4 corner blend within each corner's window.
  const corners = detectCorners(loop, thresholdDeg);
  for (const ci of corners) {
    const R = Rof(ci);
    const [n1, n2] = wallInwardNormalsAtCorner(loop, ci, sign, normalStep);
    const C = solveCornerCenter(loop[ci], n1, n2, R);
    if (!C) continue; // parallel walls: leave §2 result
    const negN1 = [-n1[0], -n1[1]];
    const negN2 = [-n2[0], -n2[1]];
    for (let d = -windowSize; d <= windowSize; d++) {
      const j = ((ci + d) % n + n) % n;
      const bp = cornerBlendedPoint(loop, j, {
        cornerIdx: ci, windowSize, C, R, negN1, negN2, u, capPlanePos, sign,
      });
      ring[j] = bp.uv;
    }
  }
  return ring;
}

// =============================================================================
// 4c. Local self-intersection check
// =============================================================================

/** §4c — proper segment/segment intersection test (open segments). */
export function segmentsIntersect(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-12) return false;
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom;
  const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / denom;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6;
}

/**
 * §4c — does a closed ring of 2D points self-intersect? Checks all non-adjacent
 * edge pairs (adjacent edges legitimately share an endpoint). Returns
 * { hit, i, j } — check the innermost ring (largest inset), where crossing is
 * most likely, before committing geometry.
 */
export function ringSelfIntersects(pts) {
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // skip adjacent segments (share a vertex), including the wrap pair
      if (j === i) continue;
      if (j === i + 1) continue;
      if (i === 0 && j === n - 1) continue;
      const c = pts[j];
      const d = pts[(j + 1) % n];
      if (segmentsIntersect(a, b, c, d)) return { hit: true, i, j };
    }
  }
  return { hit: false };
}

// =============================================================================
// 5. Adaptive radius policy (min-filter, fail-loud on impossible walls)
// =============================================================================

/**
 * Cast a ray from loop[i] along its inward miter bisector and return the
 * distance to the nearest opposite wall (edge not touching vertex i). Infinity
 * if nothing is hit. Used to find local wall thickness.
 */
export function rayToOppositeWall(loop, i, sign) {
  const n = loop.length;
  const prev = loop[(i - 1 + n) % n];
  const curr = loop[i];
  const next = loop[(i + 1) % n];
  const nn1 = edgeInwardNormal(prev, curr, sign);
  const nn2 = edgeInwardNormal(curr, next, sign);
  let bx = nn1[0] + nn2[0];
  let by = nn1[1] + nn2[1];
  const blen = Math.hypot(bx, by) || 1e-9;
  bx /= blen; by /= blen;

  let best = Infinity;
  for (let e = 0; e < n; e++) {
    const e2 = (e + 1) % n;
    if (e === i || e2 === i) continue; // skip edges sharing this vertex
    const a = loop[e], c = loop[e2];
    const ex = c[0] - a[0], ey = c[1] - a[1];
    const denom = bx * ey - by * ex;
    if (Math.abs(denom) < 1e-12) continue;
    // curr + t*b = a + s*e
    const t = ((a[0] - curr[0]) * ey - (a[1] - curr[1]) * ex) / denom;
    const s = ((a[0] - curr[0]) * by - (a[1] - curr[1]) * bx) / denom;
    if (t > 1e-6 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.min(best, t);
  }
  return best;
}

/**
 * §5 — per-vertex adaptive radius. Caps the local radius to `safety` × the
 * distance to the opposite wall (so a fillet cannot eat through a thin wall),
 * then applies a MIN-filter across neighbours (not a mean — averaging can raise
 * the radius back up next to a thin spot, defeating the purpose). Vertices
 * where even `rMin` will not fit are returned in `warnings` (fail loud) rather
 * than silently forced.
 */
export function adaptiveRadii(loop, targetR, opts = {}) {
  const { sign = inwardNormalSign(loop), safety = 0.3, rMin = 0.3, minFilterRadius = 1 } = opts;
  const n = loop.length;

  const raw = [];
  for (let i = 0; i < n; i++) {
    const d = rayToOppositeWall(loop, i, sign);
    const cap = isFinite(d) ? safety * d : targetR;
    raw.push(Math.min(targetR, cap));
  }

  const radii = raw.map((_, i) => {
    let m = raw[i];
    for (let k = 1; k <= minFilterRadius; k++) {
      m = Math.min(m, raw[(i - k + n) % n], raw[(i + k) % n]);
    }
    return m;
  });

  const warnings = [];
  for (let i = 0; i < n; i++) if (radii[i] < rMin) warnings.push(i);
  return { radii, raw, warnings };
}

// --------------------------------------------------------------------------
// Three.js boundary — convert parametric [u, v, alongAxis] verts into real 3D
// --------------------------------------------------------------------------

/**
 * Map parametric fillet vertices into world 3D using the cut plane's frame:
 *   p3D = origin + u*uAxis + v*vAxis + alongAxis*nAxis
 * Returns a flat Float32Array of non-indexed triangle positions (9 floats per
 * triangle) ready for `new THREE.BufferAttribute(arr, 3)`.
 */
export function meshToPositions(mesh, frame) {
  const { origin, uAxis, vAxis, nAxis } = frame;
  const out = new Float32Array(mesh.triangles.length * 9);
  let o = 0;
  for (const tri of mesh.triangles) {
    for (const vi of tri) {
      const [u, v, a] = mesh.vertices[vi];
      out[o++] = origin[0] + u * uAxis[0] + v * vAxis[0] + a * nAxis[0];
      out[o++] = origin[1] + u * uAxis[1] + v * vAxis[1] + a * nAxis[1];
      out[o++] = origin[2] + u * uAxis[2] + v * vAxis[2] + a * nAxis[2];
    }
  }
  return out;
}
