/* Exact minimum distance between two triangle soups, and the pair of points
   that realises it.   node tools/nso_soup_distance.js   (self-check)

   Why this exists
   ---------------
   Every Seat check before this one measured its gap along ONE axis: the
   shells were axis-aligned boxes, so "how far apart are they" was
   `min(B.z) - max(A.z)` off the exported STL. A curved target has no such
   axis. The closest approach between a flat mating face and a dome is at
   the dome's pole, between a flat face and a groove it is at the groove's
   rim, and neither is the extreme of either shell's bounding box. So a
   curved seat cannot be gated without the real quantity: the minimum
   distance between the two surfaces.

   This is that quantity, computed exactly rather than sampled:

     d(triA, triB) = 0                      if the two triangles touch
                   = min over 9 edge/edge pairs and 6 vertex/triangle pairs

   which is the standard decomposition - for two disjoint triangles the
   closest pair of points always lies on an edge pair or a vertex/face pair,
   never strictly inside both faces. Contact is tested separately (an edge of
   one crossing the other's interior, plus the coplanar case, which the
   vertex/triangle term already returns 0 for) because the 15-term minimum on
   its own can be positive for two triangles that genuinely cross.

   Stdlib only, no THREE, so it runs in the checks next to
   tools/mesh_validate.py rather than in the page.                       */

'use strict';

/* ---- vector helpers on plain arrays ---- */
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function len2(a) { return dot(a, a); }

/* ---- squared distance from p to triangle abc, plus the closest point ---- */
function closestOnTri(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { d2: len2(sub(p, a)), q: a };
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { d2: len2(bp), q: b };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const q = add(a, mul(ab, d1 / (d1 - d3)));
    return { d2: len2(sub(p, q)), q: q };
  }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { d2: len2(cp), q: c };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const q = add(a, mul(ac, d2 / (d2 - d6)));
    return { d2: len2(sub(p, q)), q: q };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const q = add(b, mul(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
    return { d2: len2(sub(p, q)), q: q };
  }
  const den = 1 / (va + vb + vc);
  const q = add(a, add(mul(ab, vb * den), mul(ac, vc * den)));
  return { d2: len2(sub(p, q)), q: q };
}

/* ---- closest points of two segments, squared distance ----
   Ericson, Real-Time Collision Detection 5.1.9, with the degenerate cases
   kept explicit so a zero-length edge in a real mesh cannot produce NaN. */
function segSeg(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  const EPS = 1e-18;
  if (a <= EPS && e <= EPS) return { d2: len2(r), pa: p1, pb: p2 };
  if (a <= EPS) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = dot(d1, r);
    if (e <= EPS) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = (den !== 0) ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const pa = add(p1, mul(d1, s)), pb = add(p2, mul(d2, t));
  return { d2: len2(sub(pa, pb)), pa: pa, pb: pb };
}

/* ---- does segment pq cross triangle abc? (Moller-Trumbore, closed) ---- */
function segHitsTri(p, q, a, b, c) {
  const dir = sub(q, p);
  const e1 = sub(b, a), e2 = sub(c, a);
  const h = cross(dir, e2), det = dot(e1, h);
  if (Math.abs(det) < 1e-15) return false;      /* parallel: the coplanar case
                                                   is covered by vertex/tri */
  const inv = 1 / det, s = sub(p, a);
  const u = dot(s, h) * inv;
  if (u < -1e-12 || u > 1 + 1e-12) return false;
  const k = cross(s, e1);
  const v = dot(dir, k) * inv;
  if (v < -1e-12 || u + v > 1 + 1e-12) return false;
  const t = dot(e2, k) * inv;
  return t >= -1e-12 && t <= 1 + 1e-12;
}

function triTri(A, B) {
  const a0 = A[0], a1 = A[1], a2 = A[2], b0 = B[0], b1 = B[1], b2 = B[2];
  if (segHitsTri(a0, a1, b0, b1, b2) || segHitsTri(a1, a2, b0, b1, b2) ||
      segHitsTri(a2, a0, b0, b1, b2) || segHitsTri(b0, b1, a0, a1, a2) ||
      segHitsTri(b1, b2, a0, a1, a2) || segHitsTri(b2, b0, a0, a1, a2)) {
    return { d2: 0, pa: a0, pb: a0 };
  }
  let best = Infinity, pa = null, pb = null;
  const ea = [[a0, a1], [a1, a2], [a2, a0]];
  const eb = [[b0, b1], [b1, b2], [b2, b0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const r = segSeg(ea[i][0], ea[i][1], eb[j][0], eb[j][1]);
      if (r.d2 < best) { best = r.d2; pa = r.pa; pb = r.pb; }
    }
  }
  for (let i = 0; i < 3; i++) {
    let r = closestOnTri(A[i], b0, b1, b2);
    if (r.d2 < best) { best = r.d2; pa = A[i]; pb = r.q; }
    r = closestOnTri(B[i], a0, a1, a2);
    if (r.d2 < best) { best = r.d2; pa = r.q; pb = B[i]; }
  }
  return { d2: best, pa: pa, pb: pb };
}

/* ---- soups ---- */
function triOf(soup, t) {
  const o = t * 9;
  return [[soup[o], soup[o + 1], soup[o + 2]],
          [soup[o + 3], soup[o + 4], soup[o + 5]],
          [soup[o + 6], soup[o + 7], soup[o + 8]]];
}

function boxOf(soup, t) {
  const o = t * 9;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 3; k++) {
    for (let a = 0; a < 3; a++) {
      const v = soup[o + k * 3 + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  }
  return { lo: lo, hi: hi };
}

function boxGap2(x, y) {
  let s = 0;
  for (let a = 0; a < 3; a++) {
    const d = Math.max(0, Math.max(x.lo[a] - y.hi[a], y.lo[a] - x.hi[a]));
    s += d * d;
  }
  return s;
}

/* Minimum distance between two world-space triangle soups (flat arrays, 9
   numbers per triangle). Returns { dist, pa, pb, pairs } - pairs is how many
   triangle pairs actually reached the exact solve, so a check can see that
   the box prefilter did its job rather than assuming it.

   The prefilter is exact-safe: a pair whose bounding boxes are further apart
   than the best distance found so far cannot beat it. Triangles are visited
   in bounding-box order along the widest axis so a good bound is found early.
*/
function soupMinDistance(soupA, soupB) {
  const nA = (soupA.length / 9) | 0, nB = (soupB.length / 9) | 0;
  if (!nA || !nB) return { dist: NaN, pa: null, pb: null, pairs: 0 };
  const bA = [], bB = [];
  for (let i = 0; i < nA; i++) bA.push(boxOf(soupA, i));
  for (let j = 0; j < nB; j++) bB.push(boxOf(soupB, j));

  /* order B's triangles by how close their box is to A's overall box, so the
     first few pairs already bound the answer tightly */
  const allA = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < nA; i++) {
    for (let a = 0; a < 3; a++) {
      if (bA[i].lo[a] < allA.lo[a]) allA.lo[a] = bA[i].lo[a];
      if (bA[i].hi[a] > allA.hi[a]) allA.hi[a] = bA[i].hi[a];
    }
  }
  const orderB = [];
  for (let j = 0; j < nB; j++) orderB.push(j);
  orderB.sort((p, q) => boxGap2(bB[p], allA) - boxGap2(bB[q], allA));

  let best = Infinity, pa = null, pb = null, pairs = 0;
  for (let oj = 0; oj < nB; oj++) {
    const j = orderB[oj];
    if (boxGap2(bB[j], allA) > best) continue;
    const TB = triOf(soupB, j);
    for (let i = 0; i < nA; i++) {
      if (boxGap2(bA[i], bB[j]) > best) continue;
      pairs++;
      const r = triTri(triOf(soupA, i), TB);
      if (r.d2 < best) { best = r.d2; pa = r.pa; pb = r.pb; }
      if (best === 0) return { dist: 0, pa: pa, pb: pb, pairs: pairs };
    }
  }
  return { dist: Math.sqrt(best), pa: pa, pb: pb, pairs: pairs };
}

/* Split a soup into edge-connected shells by exact shared vertices. The
   exported plate is one soup carrying both pieces, and the gap is between
   its shells, so every caller needs this before it can measure anything. */
function soupShells(soup) {
  const n = (soup.length / 9) | 0;
  const id = new Map(), parent = [];
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const vid = k => {
    if (!id.has(k)) { id.set(k, parent.length); parent.push(parent.length); }
    return id.get(k);
  };
  const triV = [];
  for (let t = 0; t < n; t++) {
    const o = t * 9, v = [];
    for (let k = 0; k < 3; k++) v.push(vid(soup[o + k * 3] + ',' + soup[o + k * 3 + 1] + ',' + soup[o + k * 3 + 2]));
    triV.push(v);
    for (let k = 1; k < 3; k++) {
      const a = find(v[0]), b = find(v[k]);
      if (a !== b) parent[a] = b;
    }
  }
  const groups = new Map();
  for (let t = 0; t < n; t++) {
    const r = find(triV[t][0]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t);
  }
  const out = [];
  groups.forEach(list => {
    const s = new Float64Array(list.length * 9);
    list.forEach((t, k) => { for (let a = 0; a < 9; a++) s[k * 9 + a] = soup[t * 9 + a]; });
    out.push(s);
  });
  out.sort((p, q) => q.length - p.length);
  return out;
}

module.exports = { soupMinDistance, soupShells, triTri, segSeg, closestOnTri };

/* ---- self-check ---- */
if (require.main === module) {
  let fails = 0;
  const ok = (name, cond, detail) => {
    console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
    if (!cond) fails++;
  };
  const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;

  /* two unit squares (2 tris each) in parallel planes 0.25 apart */
  const quad = (z) => [0, 0, z, 1, 0, z, 1, 1, z, 0, 0, z, 1, 1, z, 0, 1, z];
  let r = soupMinDistance(quad(0), quad(0.25));
  ok('two parallel quads 0.25 apart', near(r.dist, 0.25, 1e-12), r.dist);

  /* offset sideways so the closest pair is an edge/edge pair */
  const shifted = quad(0.25).slice();
  for (let i = 0; i < shifted.length; i += 3) shifted[i] += 2;
  r = soupMinDistance(quad(0), shifted);
  ok('edge/edge: 1 across and 0.25 up', near(r.dist, Math.hypot(1, 0.25), 1e-12), r.dist);

  /* crossing triangles: distance is exactly 0, and the 15-term minimum alone
     would not have said so */
  const T1 = [[0, 0, 0], [4, 0, 0], [0, 4, 0]];
  const T2 = [[1, 1, -1], [1, 1, 1], [3, 0.5, 0]];
  ok('crossing triangles measure 0', triTri(T1, T2).d2 === 0);

  /* a sphere-ish cap against a plane: the closest point is the pole, not any
     bounding-box extreme of either shell */
  const cap = [];
  const R = 10, rings = 24;
  for (let i = 0; i < rings; i++) {
    const a0 = (i / rings) * 2 * Math.PI, a1 = ((i + 1) / rings) * 2 * Math.PI;
    const ph = 0.25;      /* one ring of a sphere around the top */
    const p = (a, t) => [R * Math.sin(t) * Math.cos(a), R * Math.sin(t) * Math.sin(a), R * Math.cos(t)];
    cap.push(...p(a0, 0.0001), ...p(a0, ph), ...p(a1, ph));
  }
  const plate = (z) => [-20, -20, z, 20, -20, z, 20, 20, z, -20, -20, z, 20, 20, z, -20, 20, z];
  r = soupMinDistance(cap, plate(R + 0.18));
  ok('dome pole to a plate 0.18 above it', near(r.dist, 0.18, 1e-4), r.dist);
  ok('... and the closest point is the pole, not a rim vertex',
     near(r.pa ? r.pa[2] : NaN, R, 1e-3), r.pa && r.pa[2]);

  /* shells */
  const two = new Float64Array(quad(0).length + quad(5).length);
  two.set(quad(0), 0); two.set(quad(5), quad(0).length);
  const sh = soupShells(two);
  ok('two disjoint quads split into two shells', sh.length === 2, sh.length);

  console.log(fails ? '\n' + fails + ' self-check(s) FAILED' : '\nself-check ok');
  process.exit(fails ? 1 : 0);
}
