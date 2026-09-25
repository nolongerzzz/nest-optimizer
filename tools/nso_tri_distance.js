/* Exact minimum distance between two triangle soups - every triangle pair,
   closed form - as an independent cross-check on sampled distances.

     const { minTriDistance } = require('./nso_tri_distance.js');
     const r = minTriDistance(soupA, soupB);   // { mm, a, b }  (triangles)

   For two DISJOINT triangles the minimum distance is attained at a vertex of
   one against the other (6 point-triangle tests, Ericson's closest point) or
   at an edge against an edge (9 segment-segment tests); this takes the least
   of those 15. It does not test for intersection - a pair that interpenetrates
   reads as its nearest feature pair, which is 0 only where they touch - so a
   caller asking "is it clear" also needs its own no-overlap check.

   CANDIDATES ARE CHOSEN BY TRIANGLE BOUNDING BOX, NEVER BY VERTEX. A piece's
   underside can be one long triangle: on the tape piece the one directly over
   the strut spans x 89.6 .. 170.4 and its nearest corner is 40.4 mm from the
   strut. A search that gathers candidates by nearby vertices never sees it and
   reports the NEXT surface - measured, 5.376 mm where the truth is 0.182 mm.
   Here every pair is kept unless the two triangles' boxes are already farther
   apart than the best distance found, which is a bound, not a guess. */
'use strict';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function ptTri(p, a, b, c) {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return dist(p, a);
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dist(p, b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return dist(p, [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]); }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dist(p, c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return dist(p, [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return dist(p, [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]);
  }
  const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  return dist(p, [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]);
}

function segSeg(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a <= 1e-18 && e <= 1e-18) return dist(p1, p2);
  if (a <= 1e-18) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-18) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den !== 0 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  return dist([p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s], [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t]);
}

function triTri(A, B) {
  let d = Infinity;
  for (let i = 0; i < 3; i++) { d = Math.min(d, ptTri(A[i], B[0], B[1], B[2]), ptTri(B[i], A[0], A[1], A[2])); }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) d = Math.min(d, segSeg(A[i], A[(i + 1) % 3], B[j], B[(j + 1) % 3]));
  return d;
}

function tris(soup) {
  const out = [];
  for (let o = 0; o < soup.length; o += 9) {
    const T = [[soup[o], soup[o + 1], soup[o + 2]], [soup[o + 3], soup[o + 4], soup[o + 5]], [soup[o + 6], soup[o + 7], soup[o + 8]]];
    const lo = [0, 1, 2].map(k => Math.min(T[0][k], T[1][k], T[2][k])), hi = [0, 1, 2].map(k => Math.max(T[0][k], T[1][k], T[2][k]));
    out.push({ T, lo, hi });
  }
  return out;
}
const boxGap = (a, b) => Math.hypot(...[0, 1, 2].map(k => Math.max(0, a.lo[k] - b.hi[k], b.lo[k] - a.hi[k])));

/* opts.reach: pairs whose boxes are farther apart than this are not looked
   at (default Infinity - every pair). A result over `reach` is reported as
   Infinity, never as a distance that was not measured. */
function minTriDistance(soupA, soupB, opts) {
  const reach = (opts && opts.reach) || Infinity;
  const A = tris(soupA), B = tris(soupB);
  const lo = [0, 1, 2].map(k => Math.min(...A.map(t => t.lo[k]))), hi = [0, 1, 2].map(k => Math.max(...A.map(t => t.hi[k])));
  const Aall = { lo, hi };
  const cand = B.filter(t => boxGap(t, Aall) <= reach);
  let best = { mm: Infinity, a: null, b: null, pairs: 0 };
  for (const a of A) for (const b of cand) {
    const g = boxGap(a, b);
    if (g > best.mm || g > reach) continue;
    best.pairs++;
    const d = triTri(a.T, b.T);
    if (d < best.mm) best = { mm: d, a: a.T, b: b.T, pairs: best.pairs };
  }
  best.candidates = cand.length;
  return best;
}

module.exports = { minTriDistance, triTri, ptTri, segSeg };
