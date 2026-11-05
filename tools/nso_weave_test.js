#!/usr/bin/env node
// Headless self-test for nso_cdt.js and nso_weave.js (Weave: cut a patch out along its own triangles, clone its surface in a fresh
// even weave, reattach it rim to rim). docs/WEAVE.md.
//
//   node tools/nso_weave_test.js        exit 0 = every gate held
//
// Both files are required as they ship (THREE-free). The fixtures are scan-like slabs (tools/nso_weave_fixture.js: a jittered grid
// under a spherical cap, strokes and a ring ENGRAVED 0.6 mm in it, and for the curved ones a groove running through the cap) whose
// unengraved surface is known in closed form; the result is judged by the app's own checker (NSO_Repair.js + nso-defects.js in a vm).
//
//   1. the mesher alone (it fills the holes of work): random jagged outlines with holes - every rim edge is an edge of the result, in
//      its own direction, no flat or turned triangle, the area exactly the outline's, the triangles even
//   2. a cut: the selection closes (islands filled, pinches opened), one loop of the mesh's own corners
//   3. WEAVE (smooth) over engraved strokes and a ring: the surface is the sphere again where the work was, the triangles are even
//      and the plate's own size, none turned
//   4. REATTACH: the checker finds the piece exactly as closed as it was, every rim corner is the mesh's own coordinate (bit for bit),
//      the volume is the unengraved slab's, the soup handed in is not touched
//   5. follow: the plate's own surface only re-woven
//   6. a ring of a cut (a hole in the patch) weaves and closes
//   7. grow / shrink / close behave; refusals in words
//   8. a CURVED cap (R 14, a cut that leans 40 degrees at its edge) with a GROOVE through the work: the new corners stand on the
//      cap and the groove, not on a plane
//   9. the same, unengraved: a clone - the groove and the dome copied to 3 microns
//  10. a cut whose edge runs across a stroke: it is kept as it is, the rest of the work goes
'use strict';

const CDT = require('../nso_cdt.js');
const W = require('../nso_weave.js');
const build = require('./nso_weave_fixture.js');
const vm = require('vm'), fs = require('fs'), path = require('path');

let fails = 0;
function gate(name, ok, detail) {
  if (!ok) fails++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -  ' + detail : ''));
}
const sb = { window: {} };
vm.createContext(sb);
for (const f of ['NSO_Repair.js', 'nso-defects.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sb, { filename: f });
const check = (soup) => { const r = sb.window.NSO_Defects.locate(soup, {}); return { open: r.openEdges, nm: r.nonManifoldEdges, odd: r.oddEdges, flip: r.flippedEdges, degen: r.degenerateTris, pierce: r.pierce }; };
const closedClean = (c, ref) => c.open === 0 && c.nm === 0 && c.odd === 0 && c.flip === 0 && c.degen === 0 && c.pierce === ref.pierce;
const fingerprint = (s) => { let a = 0; for (let i = 0; i < s.length; i++) a += s[i] * ((i % 97) + 1); return s.length + ':' + a; };
function volume(s) {
  let v = 0;
  for (let i = 0; i < s.length; i += 9) {
    v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) + s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
  }
  return v / 6;
}
const rnd = (seed) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };

/* ------------------------------------------------------------------ 1 */
{
  let bad = 0, worstMs = 0, lowAngle = Infinity, n = 0, detail = '';
  for (let seed = 1; seed <= 14; seed++) {
    const R = rnd(seed * 977), m = 40 + Math.floor(R() * 360), rmin = 1 + R() * 6, rmax = rmin + R() * 5, outer = [];
    for (let i = 0; i < m; i++) { const a = 2 * Math.PI * i / m, r = rmin + (rmax - rmin) * R(); outer.push([r * Math.cos(a), r * Math.sin(a)]); }
    const loops = [outer];
    if (R() < 0.6) { const h = [], k = 20 + Math.floor(R() * 40); for (let i = 0; i < k; i++) { const a = 2 * Math.PI * i / k, r = 0.3 + 0.4 * rmin * R(); h.push([r * Math.cos(a), r * Math.sin(a)]); } loops.push(h.reverse()); }
    const t0 = Date.now(), f = CDT.fill(loops, { pitch: 0.15 + R() * 0.3 });
    worstMs = Math.max(worstMs, Date.now() - t0);
    n++;
    if (!f.ok || f.flat || Math.abs(f.areaGot - f.areaWant) > 1e-6 * f.areaWant) { bad++; detail += ' seed ' + seed + ': ' + (f.reason || 'flat ' + f.flat); continue; }
    const have = new Set(), K = 1e7;
    for (let i = 0; i < f.T.length; i += 3) for (let k = 0; k < 3; k++) have.add(f.T[i + k] * K + f.T[i + (k + 1) % 3]);
    let s0 = 0, miss = 0;
    loops.forEach(L => { for (let q = 0; q < L.length; q++) if (!have.has((s0 + q) * K + (s0 + (q + 1) % L.length))) miss++; s0 += L.length; });
    if (miss) { bad++; detail += ' seed ' + seed + ': ' + miss + ' rim edges missing'; continue; }
    const angs = [];
    for (let i = 0; i < f.T.length; i += 3) {
      if (f.T[i] < f.nRim || f.T[i + 1] < f.nRim || f.T[i + 2] < f.nRim) continue;       // the interior: no rim corner among them
      const p = [0, 1, 2].map(k => f.P[f.T[i + k]]), e = [0, 1, 2].map(k => Math.hypot(p[k][0] - p[(k + 1) % 3][0], p[k][1] - p[(k + 1) % 3][1]));
      for (let k = 0; k < 3; k++) angs.push(Math.acos(Math.max(-1, Math.min(1, (e[k] ** 2 + e[(k + 1) % 3] ** 2 - e[(k + 2) % 3] ** 2) / (2 * e[k] * e[(k + 1) % 3])))) * 180 / Math.PI);
    }
    angs.sort((a, b) => a - b);
    lowAngle = Math.min(lowAngle, angs[(angs.length * 0.05) | 0]);
  }
  gate('1a ' + n + ' random jagged outlines (some with holes) fill: every rim edge present in its direction, none flat, area exact', bad === 0, detail || ('worst ' + worstMs + ' ms'));
  gate('1b the interior is even: the 5th percentile angle of triangles with no rim corner is over 40 degrees on every outline', lowAngle > 40, 'worst p5 ' + lowAngle.toFixed(1) + '°');
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]], pts = sq.slice(), R2 = rnd(5);
  for (let i = 0; i < 300; i++) pts.push([R2() * 10, R2() * 10]);
  const t = CDT.triangulate(pts, [[0, 1], [1, 2], [2, 3], [3, 0]]);
  gate('1c a constrained triangulation of 4 corners and 300 points: the square\'s sides are forced in (all 604 triangles of a convex hull)', !t.reason && t.nTri === 2 * 304 - 2 - 4, t.reason || t.nTri + ' triangles');
}

/* ------------------------------------------------------------------ 2 */
const fx = build({ W: 36, H: 28, cell: 0.3 });
const fxPlain = build({ W: 36, H: 28, cell: 0.3, ink: false });
const SOUP = fx.soup, ref = check(SOUP), refPlain = check(fxPlain.soup), v0 = volume(fxPlain.soup);
const M = W.prepare(SOUP);
const seedAt = (Mx, x, y) => { let s = -1, b = 1e9; for (let t = 0; t < Mx.n; t++) { if (Mx.nrm[3 * t + 2] < 0.5) continue; const c = W.centroid(Mx, t), d = Math.hypot(c[0] - x, c[1] - y); if (d < b) { b = d; s = t; } } return s; };
const ballAt = (x, y, r) => { const s = seedAt(M, x, y); return W.ball(M, s, W.centroid(M, s), r, { axis: [0, 0, 1], minDot: 0.25 }); };
const MASK = ballAt(-1, 0, 13.6);
{
  const raw = W.count(MASK), c = W.close(M, MASK), pt = W.patch(M, c.mask);
  gate('2a the welded mesh is a closed surface (no open or shared-by-three edges, no degenerate triangle)', M.nonManifold === 0 && M.degenerate === 0 && ref.open === 0, 'tris ' + M.n);
  gate('2b a circle laid on the engraved slab leaves the engraving\'s walls out; close() takes them back (islands), no pinch', c.added > 0 && c.pieces === 1 && c.count === raw + c.added, 'circle ' + raw + ' + ' + c.added + ' = ' + c.count);
  gate('2c it is cut out whole: one outline of the mesh\'s own corners, no hole, an area a little over the circle\'s (the engraving\'s walls)', pt.ok && pt.loops.length === 1 && pt.holes === 0 && pt.area > Math.PI * 169 && pt.area < 1.4 * Math.PI * 169,
    pt.ok ? pt.tris.length + ' triangles, rim ' + pt.rimCorners + ' corners, ' + pt.area.toFixed(1) + ' mm2' : pt.reason);
}

/* ------------------------------------------------------------------ 3, 4 */
{
  const before = fingerprint(SOUP), t0 = Date.now();
  const pl = W.plan(SOUP, MASK, {});
  const ms = Date.now() - t0;
  gate('3a WEAVE over four strokes and a ring 0.6 mm deep succeeds', pl.ok, pl.ok ? pl.stats.oldTris + ' -> ' + pl.stats.newTris + ' triangles, ' + ms + ' ms' : pl.reason);
  if (pl.ok) {
    let maxe = 0, sum = 0, n = 0;
    for (let i = 0; i < pl.newV.length; i += 3) { const e = Math.abs(pl.newV[i + 2] - fx.base(pl.newV[i], pl.newV[i + 1])); maxe = Math.max(maxe, e); sum += e * e; n++; }
    gate('3b the new corners stand on the sphere the engraving was cut from: max under 0.02 mm, rms under 0.005', maxe < 0.02 && Math.sqrt(sum / n) < 0.005, 'max ' + maxe.toFixed(4) + ', rms ' + Math.sqrt(sum / n).toFixed(4) + ' (' + n + ' corners)');
    const s = pl.stats;
    gate('3c the weave is even and the plate\'s own size: edges p50 within 10% of the plate\'s, 1st percentile angle over 30 degrees, none turned', Math.abs(s.edgeP50 / s.plateEdge - 1) < 0.1 && s.angleP1 > 30 && s.flipped === 0,
      'edge ' + s.edgeP50.toFixed(3) + ' vs ' + s.plateEdge.toFixed(3) + ', p1 ' + s.angleP1.toFixed(1) + '°, min ' + s.angleMin.toFixed(1) + '°, turned ' + s.flipped);
    gate('3d the work it bridged is read right: depth 0.6 mm, area over the strokes and ring, walls included (60 to 300 mm2)', Math.abs(s.workDepth - 0.6) < 0.05 && s.workArea > 60 && s.workArea < 300, 'depth ' + s.workDepth.toFixed(3) + ', area ' + s.workArea.toFixed(1));

    const r = W.apply(SOUP, pl, pl.mask), cc = r.ok ? check(r.soup) : null;
    gate('4a REATTACH: the checker finds it exactly as closed as it was (open, non-manifold, odd, flipped, degenerate 0; piercing unchanged)', r.ok && closedClean(cc, ref), r.ok ? JSON.stringify(cc) + ' was ' + JSON.stringify(ref) : r.reason);
    gate('4b the volume is the unengraved slab\'s (0.5%)', r.ok && Math.abs(volume(r.soup) - v0) < 0.005 * v0, r.ok ? volume(r.soup).toFixed(2) + ' vs ' + v0.toFixed(2) + ' (engraved ' + volume(SOUP).toFixed(2) + ')' : '');
    // every rim corner is the mesh's own coordinate, bit for bit: the old soup's corners that border the patch are all in the new soup
    let have = new Set(), kept = 0;
    for (let i = 0; i < r.soup.length; i += 3) have.add(r.soup[i] + ',' + r.soup[i + 1] + ',' + r.soup[i + 2]);
    pl.rim.forEach(v => { const k = Math.fround(M.P[3 * v]) + ',' + Math.fround(M.P[3 * v + 1]) + ',' + Math.fround(M.P[3 * v + 2]); if (have.has(k)) kept++; });
    gate('4c every rim corner of the new patch is the mesh\'s own coordinate, bit for bit (' + pl.rim.length + ' of them)', kept === pl.rim.length, kept + ' found');
    gate('4d the soup handed in is not touched', fingerprint(SOUP) === before);
    // the old patch is gone, the rest is byte for byte
    let same = 0;
    for (let t = 0, q = 0; t < M.n; t++) { if (pl.mask[t]) continue; let ok = true; for (let k = 0; k < 9; k++) if (r.soup[9 * q + k] !== SOUP[9 * t + k]) { ok = false; break; } if (ok) same++; q++; }
    gate('4e every triangle outside the cut is untouched, in order', same === M.n - W.count(pl.mask), same + ' of ' + (M.n - W.count(pl.mask)));
  }
}

/* ------------------------------------------------------------------ 5 */
{
  const Mp = W.prepare(fxPlain.soup), s0 = seedAt(Mp, -0.8, 0), mk = W.ball(Mp, s0, W.centroid(Mp, s0), 9, { axis: [0, 0, 1], minDot: 0.25 });
  const pl = W.plan(fxPlain.soup, mk, { fit: 'follow' });
  let maxe = 0;
  if (pl.ok) for (let i = 0; i < pl.newV.length; i += 3) maxe = Math.max(maxe, Math.abs(pl.newV[i + 2] - fxPlain.base(pl.newV[i], pl.newV[i + 1])));
  const r = pl.ok ? W.apply(fxPlain.soup, pl, pl.mask) : { ok: false };
  gate('5a follow on a plain cap: the plate\'s own surface re-woven, the corners within 0.01 mm of it, the piece as closed as it was', pl.ok && maxe < 0.01 && r.ok && closedClean(check(r.soup), refPlain),
    pl.ok ? 'max ' + maxe.toFixed(4) + ' mm, ' + pl.stats.oldTris + ' -> ' + pl.stats.newTris + ' triangles' : pl.reason);
  const pf = W.plan(SOUP, MASK, { fit: 'follow' });
  gate('5b follow over the engraving keeps it: nothing bridged, the volume stays the engraved one (0.3%)', pf.ok && pf.stats.workArea === 0 && Math.abs(volume(W.apply(SOUP, pf, pf.mask).soup) - volume(SOUP)) < 0.003 * volume(SOUP),
    pf.ok ? 'work ' + pf.stats.workArea : pf.reason);
}

/* ------------------------------------------------------------------ 6 */
{
  const Mp = W.prepare(fxPlain.soup), at = (x, y, r) => { const s0 = seedAt(Mp, x, y); return W.ball(Mp, s0, W.centroid(Mp, s0), r, { axis: [0, 0, 1], minDot: 0.25 }); };
  const outer = at(-1, 0, 11), inner = at(-1, 0, 8.5), ringMask = new Uint8Array(Mp.n);
  for (let t = 0; t < Mp.n; t++) ringMask[t] = outer[t] && !inner[t] ? 1 : 0;
  const c = W.close(Mp, ringMask), pt = W.patch(Mp, c.mask);
  gate('6a a ring cut (an island too big to be a counter is left a hole) is two outlines', pt.ok && pt.loops.length === 2 && pt.holes === 1, pt.ok ? pt.loops.length + ' loops' : pt.reason);
  const pl = W.plan(fxPlain.soup, ringMask, {});
  if (pl.ok) {
    const r = W.apply(fxPlain.soup, pl, pl.mask), refP = refPlain;
    gate('6b it weaves and reattaches: closed as before, the island inside it untouched', r.ok && closedClean(check(r.soup), refP) && Math.abs(volume(r.soup) - volume(fxPlain.soup)) < 0.002 * volume(fxPlain.soup),
      r.ok ? JSON.stringify(check(r.soup)) : r.reason);
  } else gate('6b it weaves and reattaches', false, pl.reason);
}

/* ------------------------------------------------------------------ 7 */
{
  const small = ballAt(-0.8, 0, 6), g = W.grow(M, small, 1), sh = W.shrink(M, g, 1);
  gate('7a grow adds a ring of triangles and shrink takes it off again (to within the ring\'s jaggedness)', W.count(g) > W.count(small) && W.count(sh) <= W.count(g) && W.count(sh) >= W.count(small) - 0.05 * W.count(small),
    W.count(small) + ' -> ' + W.count(g) + ' -> ' + W.count(sh));
  const pinched = Uint8Array.from(small);
  let removed = 0;                                                   // knock a few triangles out of the middle: holes
  for (let t = 0; t < M.n && removed < 40; t++) { const c = W.centroid(M, t); if (pinched[t] && Math.hypot(c[0] + 0.8, c[1]) < 2.5 && t % 7 === 0) { pinched[t] = 0; removed++; } }
  const cl = W.close(M, pinched);
  gate('7b close() fills the holes knocked in a cut (islands) and leaves one piece', cl.count >= W.count(small) - 3 && cl.pieces === 1, 'removed ' + removed + ', back ' + (cl.count - (W.count(pinched))) + ', count ' + cl.count + ' of ' + W.count(small));
  // a hole cut on purpose (opts.keep) is left a hole; the same hole without it is filled like a counter
  const bite = Uint8Array.from(small), keepM = new Uint8Array(M.n);
  for (let t = 0; t < M.n; t++) { const c = W.centroid(M, t); if (bite[t] && Math.hypot(c[0] + 0.8, c[1]) < 1.6) { bite[t] = 0; keepM[t] = 1; } }
  const filled = W.close(M, bite), held = W.close(M, bite, { keep: keepM }), hp = W.patch(M, held.mask);
  gate('7b2 close() leaves a hole the user cut on purpose (opts.keep) and fills the same hole without it', filled.count > held.count && hp.ok && hp.holes === 1, 'filled ' + filled.count + ', kept ' + held.count + ', holes ' + (hp.holes || 0));
  // the rest of a closed piece is not a hole in a big cut: every top triangle (nothing facing away from +Z, no wall) is cut, close() leaves the underside and sides alone
  const topAll = new Uint8Array(M.n);
  for (let t = 0; t < M.n; t++) if (M.nrm[3 * t + 2] > 0.25) topAll[t] = 1;
  const cTop = W.close(M, topAll);
  let under = 0;
  for (let t = 0; t < M.n; t++) if (cTop.mask[t] && M.nrm[3 * t + 2] < -0.5) under++;
  gate('7b3 close() does not swallow the rest of the piece (its underside and sides) as an island of a cut that covers the top', under === 0 && cTop.count < M.n, 'top ' + W.count(topAll) + ' -> ' + cTop.count + ' of ' + M.n + ', underside triangles taken ' + under);
  const none = W.plan(SOUP, new Uint8Array(M.n), {});
  gate('7c nothing cut: refused in words', !none.ok && /nothing is selected/.test(none.reason), none.reason);
  // a cut whose edge runs across the work: it is kept as it is (a feature the edge crosses), not refused; the rest of the work goes
  const through = ballAt(-4, 0, 6), cut = W.plan(SOUP, through, {});
  gate('7d a cut whose edge runs across an engraved stroke is woven, saying how many features its edge crosses and keeping them as they are', cut.ok && cut.stats.keptFeatures > 0, cut.ok ? 'kept ' + cut.stats.keptFeatures + ', work ' + cut.stats.workArea.toFixed(1) : cut.reason);
  // a cut that curls round: the whole top and sides, no normal filter
  const sd = seedAt(M, -0.8, 0), wrap = W.ball(M, sd, W.centroid(M, sd), 40);
  const wr = W.plan(SOUP, wrap, {});
  gate('7e a selection that is the whole piece is refused in words, not woven', !wr.ok && wr.reason.length > 20, wr.ok ? 'it succeeded' : wr.reason);
  // a patch too fine
  const fine = W.plan(SOUP, MASK, { pitch: 0.0005 });
  gate('7f a pitch that would need millions of triangles is refused in words', !fine.ok && /raise the pitch|too many/.test(fine.reason), fine.ok ? 'it succeeded' : fine.reason);
}

/* ------------------------------------------------------------------ 8, 9, 10 */
function topAt(soup, x, y) {
  let best = -Infinity;
  for (let t = 0; t < soup.length; t += 9) {
    const A = [soup[t], soup[t + 1], soup[t + 2]], B = [soup[t + 3], soup[t + 4], soup[t + 5]], C = [soup[t + 6], soup[t + 7], soup[t + 8]];
    const d = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
    if (Math.abs(d) < 1e-12) continue;
    const a = ((B[1] - C[1]) * (x - C[0]) + (C[0] - B[0]) * (y - C[1])) / d, b = ((C[1] - A[1]) * (x - C[0]) + (A[0] - C[0]) * (y - C[1])) / d, c = 1 - a - b;
    if (a < -1e-9 || b < -1e-9 || c < -1e-9) continue;
    best = Math.max(best, a * A[2] + b * B[2] + c * C[2]);
  }
  return best;
}
{
  const opt = { W: 20, H: 16, cell: 0.2, R: 14, inkScale: 0.6, groove: { depth: 1.2, width: 2.5 } };
  const cv = build(opt), cvPlain = build(Object.assign({ ink: false }, opt));
  const Mc = W.prepare(cv.soup), refC = check(cv.soup);
  const lassoOn = (Mx, R) => {                                  // the lasso: a cylinder along Z, every surface facing up within it
    let s0 = -1, b0 = 1e9;
    for (let t = 0; t < Mx.n; t++) { if (Mx.nrm[3 * t + 2] < 0.3) continue; const c = W.centroid(Mx, t), d = Math.hypot(c[0], c[1]); if (d < b0) { b0 = d; s0 = t; } }
    return W.flood(Mx, s0, t => { const c = W.centroid(Mx, t); return Math.hypot(c[0], c[1]) <= R && Mx.nrm[3 * t + 2] > 0; });
  };
  const maskC = lassoOn(Mc, 9.2), pl = W.plan(cv.soup, maskC, {});
  gate('8a a lasso over a CURVED cap (R 14, the cut leans 40 degrees at its edge) with a groove (1.2 mm deep) under the engraving weaves', pl.ok, pl.ok ? pl.stats.oldTris + ' -> ' + pl.stats.newTris + ' triangles, ' + pl.stats.workGroups + ' holes of work, ' + pl.stats.ms + ' ms' : pl.reason);
  if (pl.ok) {
    let maxe = 0, sum = 0, n = 0;
    for (let i = 0; i < pl.newV.length; i += 3) { const e = Math.abs(pl.newV[i + 2] - cv.base(pl.newV[i], pl.newV[i + 1])); maxe = Math.max(maxe, e); sum += e * e; n++; }
    gate('8b the new corners stand on the cap and its groove, not on a plane (the groove is under the ring letter: the spline carries it across - max 0.2 mm, rms 0.03)', maxe < 0.2 && Math.sqrt(sum / n) < 0.03, 'max ' + maxe.toFixed(4) + ', rms ' + Math.sqrt(sum / n).toFixed(4));
    const r = W.apply(cv.soup, pl, pl.mask);
    gate('8c reattached: the piece exactly as closed as it was, nothing turned, the weave even', r.ok && closedClean(check(r.soup), refC) && pl.stats.flipped === 0 && pl.stats.angleP1 > 30, r.ok ? JSON.stringify(check(r.soup)) + ' p1 ' + pl.stats.angleP1.toFixed(1) + '°' : r.reason);
  }
  const Mq = W.prepare(cvPlain.soup), plq = W.plan(cvPlain.soup, lassoOn(Mq, 9.2), {}), refQ = check(cvPlain.soup);
  if (plq.ok) {
    let maxe = 0;
    for (let i = 0; i < plq.newV.length; i += 3) maxe = Math.max(maxe, Math.abs(plq.newV[i + 2] - cvPlain.base(plq.newV[i], plq.newV[i + 1])));
    const r = W.apply(cvPlain.soup, plq, plq.mask);
    gate('9 unengraved, the same cut is a clone: the dome and the groove copied to within 0.01 mm, closed as before', maxe < 0.01 && r.ok && closedClean(check(r.soup), refQ), 'max ' + maxe.toFixed(4) + ' mm, ' + plq.stats.oldTris + ' -> ' + plq.stats.newTris + ' triangles');
  } else gate('9 unengraved, the same cut is a clone', false, plq.reason);
  // 10: the edge across a stroke
  const Ms = W.prepare(SOUP), sd = seedAt(Ms, -5, 0), edgeCut = W.ball(Ms, sd, W.centroid(Ms, sd), 7.5, { axis: [0, 0, 1], minDot: 0.25 }), pe = W.plan(SOUP, edgeCut, {});
  if (pe.ok) {
    const r = W.apply(SOUP, pe, pe.mask), cut1 = Math.abs(topAt(r.soup, -8.3, 0) - fx.base(-8.3, 0)), U = [-1.8, 0];
    const kept = topAt(r.soup, U[0], U[1]) - fx.base(U[0], U[1]);
    gate('10 a letter the cut\'s edge crosses (the U) is kept as it is (still 0.6 mm down), the one wholly inside (the D) is gone (the surface back to 0.01 mm)', pe.stats.keptFeatures > 0 && cut1 < 0.01 && kept < -0.5, 'kept features ' + pe.stats.keptFeatures + ', inside stroke off by ' + cut1.toFixed(4) + ', crossed stroke at ' + kept.toFixed(2));
  } else gate('10 a stroke the cut\'s edge crosses is kept as it is', false, pe.reason);
}

console.log(fails ? '\n' + fails + ' gate(s) FAILED' : '\nall gates held');
process.exit(fails ? 1 : 0);
