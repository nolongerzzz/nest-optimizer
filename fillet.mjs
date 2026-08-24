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
