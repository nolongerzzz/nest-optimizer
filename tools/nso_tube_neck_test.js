#!/usr/bin/env node
// Headless self-test for nso_tube_neck.js (Tube edge's third verb, Neck).
//
//   node tools/nso_tube_neck_test.js        exit 0 = every gate held
//
// Loads the shipped files with vm, in index.html's order. Every fixture is
// generated here, from the shipped generators where there is one (Stock's
// revolve, the Wheel's revolve, Extend). Every number is measured on the
// OUTPUT soup by code that shares nothing with the neck's construction:
//   - the meridian at angle 0 is walked out of the output mesh's own edges
//     (the vertices with y = 0), from each face's bottom ring vertex upward;
//   - the bore and the outside at the waist are the output's own vertices at
//     the waist's height;
//   - the wall is measured on that meridian (each face's points against the
//     other face's polyline) and in 3D, from every new vertex on twelve
//     meridians to the nearest face of the wall's other side;
//   - the topology is welded on exact float32 keys by a counter written here;
//   - tools/mesh_validate.py --gate runs on every output.
//
// Prints a table at the end; the PR quotes it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { writeSTL, readSTL } = require('./nso_stl_io.js');
const LIBDIR = require('./nso_library_dir.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Date,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Int8Array, ArrayBuffer, Error, Infinity, NaN
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['NSO_Repair.js', 'nso_thickness.js', 'nso_stock.js', 'nso_path_sweep.js', 'app-cut.js', 'app-sculpt.js',
                 'app-extend.js', 'nso_section.js', 'nso_bend.js', 'app-wheel.js', 'nso_tube_edge.js', 'nso_tube_neck.js', 'app-scale.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { NSO_tubeNeckRaw, NSO_tubeNeckRead, NSO_Stock, NSO_extendRaw, NSO_tubeEdgeRaw, NSO_scaleSoup } = ctx;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const TABLE = [];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-tube-neck-'));
const f3 = x => (+x).toFixed(3);
function row(name, soup, r, ms, extra) {
  TABLE.push({ name, trisIn: soup.length / 9, trisOut: r.ok ? r.tris.length / 9 : '-', ms: ms == null ? '' : ms.toFixed(0), extra: extra || '' });
}

/* ------------------------------------------------------------------ fixtures */

// Stock's own tube: NSO_Stock.revolve of its tube meridian, 96 segments, Z up,
// the axis at x = y = 0, the open ends at z = 0 and z = h.
const stockTube = (rOut, wall, h, seg) => NSO_Stock.revolve(NSO_Stock.profileTube(rOut, rOut - wall, h), seg || 96);
// An imported-style tube along X: 48 sides, Ø16 / Ø12, its own winding (Bend's fixture).
function tubeAlongX(len, n) {
  const circle = (cy, cz, r) => Array.from({ length: n }, (_, i) => { const a = 2 * Math.PI * i / n; return [cy + r * Math.cos(a), cz + r * Math.sin(a)]; });
  const O = circle(20, 10, 8), I = circle(20, 10, 6), t = [];
  for (const lp of [O, I.slice().reverse()]) for (let i = 0; i < lp.length; i++) {
    const p = lp[i], q = lp[(i + 1) % lp.length];
    t.push([0, p[0], p[1]], [0, q[0], q[1]], [len, q[0], q[1]], [0, p[0], p[1]], [len, q[0], q[1]], [len, p[0], p[1]]);
  }
  for (const [x, far] of [[len, true], [0, false]]) for (let i = 0; i < n; i++) {
    const O0 = O[i], O1 = O[(i + 1) % n], I0 = I[i], I1 = I[(i + 1) % n];
    for (const tr of [[[x, O0[0], O0[1]], [x, O1[0], O1[1]], [x, I1[0], I1[1]]], [[x, O0[0], O0[1]], [x, I1[0], I1[1]], [x, I0[0], I0[1]]]])
      far ? t.push(...tr) : t.push(tr[0], tr[2], tr[1]);
  }
  return new Float32Array(t.flat());
}
// A Wheel cup: a straight-walled thrown cup (base 3 mm, wall 2, Ø30, 45 tall)
// as the Wheel holds it - its meridian profile - revolved by the Wheel's own
// revolve, exactly as the app bakes it.
function wheelCup() {
  const piece = { outer: [{ z: 0, r: 0 }, { z: 0, r: 15 }, { z: 45, r: 15 }],
                  inner: [{ z: 3, r: 0 }, { z: 3, r: 13 }, { z: 45, r: 13 }], segments: 128 };
  return ctx.NSO_wheelRevolve(piece);
}

/* ------------------------------------------------------------- measuring */

// Exact-bit weld and edge counts, written here (not the neck's).
function topo(s) {
  const key = i => s[i] + ',' + s[i + 1] + ',' + s[i + 2];
  const ids = new Map(), vid = [];
  for (let i = 0; i < s.length; i += 3) { const k = key(i); if (!ids.has(k)) ids.set(k, ids.size); vid.push(ids.get(k)); }
  const E = new Map();
  let degen = 0;
  for (let t = 0; t < vid.length / 3; t++) {
    const a = vid[t * 3], b = vid[t * 3 + 1], c = vid[t * 3 + 2];
    if (a === b || b === c || a === c) degen++;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = Math.min(p, q) + ':' + Math.max(p, q), e = E.get(k) || { n: 0, f: 0 };
      e.n++; if (p < q) e.f++; E.set(k, e);
    }
  }
  let open = 0, nm = 0, flip = 0;
  E.forEach(e => { if (e.n === 1) open++; else if (e.n > 2) nm++; else if (e.f !== 1) flip++; });
  return { tris: vid.length / 3, verts: ids.size, open, nm, flip, degen, euler: ids.size - E.size + vid.length / 3, vid, pos: ids };
}
function volume(s) {
  let v = 0;
  for (let o = 0; o < s.length; o += 9) {
    v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7]) - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6]) +
         s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]);
  }
  return v / 6;
}
function meshValidate(name, soup) {
  const file = path.join(TMP, name + '.stl');
  writeSTL(file, soup);
  let out;
  try { out = execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json', '--gate'], { encoding: 'utf8', maxBuffer: 64 << 20 }); }
  catch (e) { out = e.stdout; }
  const r = JSON.parse(out);
  return { pass: r.verdict === 'PASS', fails: r.verdict_fails, pierce: r.self_intersection ? r.self_intersection.pierce : null };
}
function graph(s) {
  const T = topo(s), P = [], nb = [], faces = [];
  T.pos.forEach((id, k) => { P[id] = k.split(',').map(Number); nb[id] = new Set(); faces[id] = []; });
  for (let t = 0; t < T.tris; t++) {
    const a = T.vid[t * 3], b = T.vid[t * 3 + 1], c = T.vid[t * 3 + 2];
    nb[a].add(b); nb[a].add(c); nb[b].add(a); nb[b].add(c); nb[c].add(a); nb[c].add(b);
    faces[a].push(t); faces[b].push(t); faces[c].push(t);
  }
  return { T, P, nb, faces, s };
}
function faceNormal(s, t) {
  const o = t * 9, u = [s[o + 3] - s[o], s[o + 4] - s[o + 1], s[o + 5] - s[o + 2]], v = [s[o + 6] - s[o], s[o + 7] - s[o + 1], s[o + 8] - s[o + 2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], L = Math.hypot(...n);
  return { n: n.map(x => x / L), area: L / 2 };
}
/* One face's meridian at angle 0, walked out of the mesh's own edges: from
   the vertex at (r0, z0) on the plane y = 0, each step to the neighbour on
   that plane that is higher, the nearest in r if there are two. Returns
   [[r, z], ...] (frame: the axis is +Z through x = y = 0). */
function meridian(G, r0, z0) {
  const on = id => Math.abs(G.P[id][1]) < 1e-5 && G.P[id][0] > 0;
  let cur = [...G.P.keys()].find(id => G.P[id] && on(id) && Math.abs(G.P[id][0] - r0) < 1e-4 && Math.abs(G.P[id][2] - z0) < 1e-4);
  if (cur == null) return null;
  const chain = [[G.P[cur][0], G.P[cur][2]]];
  for (;;) {
    let best = null, bd = Infinity;
    for (const q of G.nb[cur]) {
      if (!on(q) || !(G.P[q][2] > G.P[cur][2] + 1e-9)) continue;
      const d = Math.abs(G.P[q][0] - G.P[cur][0]);
      if (d < bd) { bd = d; best = q; }
    }
    if (best == null) break;
    cur = best; chain.push([G.P[cur][0], G.P[cur][2]]);
  }
  return chain;
}
function segDist(p, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1], L2 = ex * ex + ey * ey;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / L2)) : 0;
  return { d: Math.hypot(p[0] - a[0] - t * ex, p[1] - a[1] - t * ey), t };
}
// Each chain's points against the other chain's polyline, where the nearest
// point is not one of the other chain's two ends (there an end face is nearer).
function chainWall(A, B) {
  let lo = Infinity, hi = -Infinity, n = 0;
  for (const [X, Y] of [[A, B], [B, A]]) for (const p of X) {
    let best = Infinity, end = false;
    for (let j = 0; j + 1 < Y.length; j++) {
      const r = segDist(p, Y[j], Y[j + 1]);
      if (r.d < best) { best = r.d; end = (j === 0 && r.t <= 1e-12) || (j + 2 === Y.length && r.t >= 1 - 1e-12); }
    }
    if (end) continue;
    n++; lo = Math.min(lo, best); hi = Math.max(hi, best);
  }
  return { lo, hi, n };
}
// Closest point on a triangle (Ericson, Real-Time Collision Detection 5.1.5).
function pointTri(p, s, t) {
  const q = t * 9, A = [s[q], s[q + 1], s[q + 2]], B = [s[q + 3], s[q + 4], s[q + 5]], C = [s[q + 6], s[q + 7], s[q + 8]];
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]], dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const at = (P0, d, k) => [P0[0] + d[0] * k, P0[1] + d[1] * k, P0[2] + d[2] * k];
  const ab = sub(B, A), ac = sub(C, A), ap = sub(p, A);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  let X;
  if (d1 <= 0 && d2 <= 0) X = A;
  else {
    const bp = sub(p, B), d3 = dot(ab, bp), d4 = dot(ac, bp);
    const cp = sub(p, C), d5 = dot(ab, cp), d6 = dot(ac, cp);
    const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
    if (d3 >= 0 && d4 <= d3) X = B;
    else if (d6 >= 0 && d5 <= d6) X = C;
    else if (vc <= 0 && d1 >= 0 && d3 <= 0) X = at(A, ab, d1 / (d1 - d3));
    else if (vb <= 0 && d2 >= 0 && d6 <= 0) X = at(A, ac, d2 / (d2 - d6));
    else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) X = at(B, sub(C, B), (d4 - d3) / ((d4 - d3) + (d5 - d6)));
    else { const den = 1 / (va + vb + vc); X = [A[0] + ab[0] * vb * den + ac[0] * vc * den, A[1] + ab[1] * vb * den + ac[1] * vc * den, A[2] + ab[2] * vb * den + ac[2] * vc * den]; }
  }
  return Math.hypot(p[0] - X[0], p[1] - X[1], p[2] - X[2]);
}
/* The wall in 3D: from every output vertex in the band z0..z1 on every
   `everyDeg` meridian, the distance to the nearest face of the OTHER side of
   the wall. A face's side is which way its own (output) normal points about
   the axis: away from it, the outside; toward it, the bore (the ends, square
   to the axis, are neither). A vertex is on the side all its faces are. */
function rayWall(G, z0, z1, everyDeg) {
  const s = G.s, nT = G.T.tris, fn = [], side = new Int8Array(nT);
  for (let t = 0; t < nT; t++) {
    fn.push(faceNormal(s, t));
    const o = t * 9, cx = (s[o] + s[o + 3] + s[o + 6]) / 3, cy = (s[o + 1] + s[o + 4] + s[o + 7]) / 3, L = Math.hypot(cx, cy);
    const rs = (fn[t].n[0] * cx + fn[t].n[1] * cy) / L;
    side[t] = rs > 0.05 ? 1 : rs < -0.05 ? -1 : 0;
  }
  const cand = [];
  for (let t = 0; t < nT; t++) {
    let zl = Infinity, zh = -Infinity; for (let k = 0; k < 3; k++) { zl = Math.min(zl, s[t * 9 + k * 3 + 2]); zh = Math.max(zh, s[t * 9 + k * 3 + 2]); }
    if (zh >= z0 - 4 && zl <= z1 + 4) cand.push(t);
  }
  let lo = Infinity, hi = -Infinity, n = 0, tried = 0;
  G.P.forEach((p, id) => {
    if (!p || p[2] < z0 + 1e-6 || p[2] > z1 - 1e-6) return;
    const ang = Math.atan2(p[1], p[0]) * 180 / Math.PI, k = Math.round(ang / everyDeg);
    if (Math.abs(ang - k * everyDeg) > 1e-3) return;
    const sides = new Set(G.faces[id].map(t => side[t]));
    if (sides.size !== 1 || sides.has(0)) return;
    const mine = side[G.faces[id][0]];
    tried++;
    let best = Infinity;
    for (const t of cand) {
      if (side[t] !== -mine) continue;
      const d = pointTri(p, s, t); if (d < best) best = d;
    }
    if (!isFinite(best)) return;
    n++; lo = Math.min(lo, best); hi = Math.max(hi, best);
  });
  return { lo, hi, n, tried };
}
// The output's vertices at one height: the least and the most radius there.
function radiiAt(s, z) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < s.length; i += 3) if (Math.abs(s[i + 2] - z) < 1e-4) { const r = Math.hypot(s[i], s[i + 1]); lo = Math.min(lo, r); hi = Math.max(hi, r); }
  return { lo, hi };
}

/* Everything every output must hold: the neck's own ok, the topology
   unchanged, the canonical checker, the input copied bit for bit outside the
   band it took out, and the volume Pappus's. */
function common(tag, soup, r) {
  check(tag + ': necked', r.ok, r.reason);
  if (!r.ok) return null;
  const T0 = topo(soup), T1 = topo(r.tris);
  check(tag + ': closed, 2-manifold, consistently wound, Euler unchanged',
    T1.open === T0.open && T1.nm === 0 && T1.flip === 0 && T1.degen === 0 && T1.euler === T0.euler,
    `open ${T1.open} nm ${T1.nm} flip ${T1.flip} degen ${T1.degen} euler ${T0.euler}->${T1.euler}`);
  const MV = meshValidate(tag.replace(/[^a-z0-9]+/gi, '_'), r.tris);
  check(tag + ': mesh_validate --gate PASS', MV.pass, MV.pass ? 'pierce ' + MV.pierce : (MV.fails || []).join('; '));
  const keyT = (s, t) => Array.from(s.subarray(t * 9, t * 9 + 9)).join(',');
  const outSet = new Set();
  for (let t = 0; t < r.tris.length / 9; t++) outSet.add(keyT(r.tris, t));
  let kept = 0, missing = 0;
  for (let t = 0; t < soup.length / 9; t++) { if (outSet.has(keyT(soup, t))) kept++; else missing++; }
  check(tag + ': only the band\'s wall taken out - the rest copied bit for bit', missing === r.counts.removed, kept + ' kept, ' + missing + ' replaced (' + r.counts.removed + ' planned)');
  const dv = volume(r.tris) - volume(soup);
  check(tag + ': volume changed by the section swept round (Pappus) within 0.5%', Math.abs(dv - r.volume.pappus) <= 5e-3 * Math.abs(r.volume.pappus),
    f3(dv) + ' vs ' + f3(r.volume.pappus) + ' mm³');
  return { T0, T1, MV };
}

/* A neck on a Z-up tube, measured: the bore and outside at the waist, the
   wall on the meridian and in 3D, the ends where they were. */
function measureZ(tag, soup, r, o) {
  const G = graph(r.tris);
  const w = radiiAt(r.tris, o.zWaist);
  // at the waist the inner face's vertices are the least radius, the outer's the most
  check(tag + ': bore at the waist Ø' + f3(o.bore) + ' ± 0.05', Math.abs(2 * w.lo - o.bore) <= 0.05, 'Ø' + f3(2 * w.lo));
  check(tag + ': outside at the waist Ø' + f3(o.outer) + ' ± 0.05', Math.abs(2 * w.hi - o.outer) <= 0.05, 'Ø' + f3(2 * w.hi));
  const Oc = meridian(G, o.Ro, o.zo != null ? o.zo : o.z0), Ic = meridian(G, o.Ri, o.zi != null ? o.zi : o.z0);
  const inBand = c => c.filter(p => p[1] >= o.zA - 0.5 && p[1] <= o.zB + 0.5);
  const W = Oc && Ic ? chainWall(inBand(Oc), Ic) : { lo: NaN, hi: NaN, n: 0 };
  const W2 = Oc && Ic ? chainWall(inBand(Ic), Oc) : { lo: NaN, hi: NaN, n: 0 };
  const lo = Math.min(W.lo, W2.lo), hi = Math.max(W.hi, W2.hi);
  check(tag + ': wall ' + o.t + ' ± 0.02 along the neck (meridian walked out of the mesh)', lo >= o.t - 0.02 && hi <= o.t + 0.02 && W.n >= 8,
    f3(lo) + '–' + f3(hi) + ' over ' + (W.n + W2.n) + ' points');
  const RW = rayWall(G, o.zA, o.zB, 30);
  check(tag + ': wall ' + o.t + ' ± 0.02 in 3D (every new vertex on 12 meridians, to the other face)', RW.lo >= o.t - 0.02 && RW.hi <= o.t + 0.02 && RW.n >= RW.tried * 0.95,
    f3(RW.lo) + '–' + f3(RW.hi) + ' from ' + RW.n + ' of ' + RW.tried + ' vertices');
  const z0 = radiiAt(r.tris, o.z0), z1 = radiiAt(r.tris, o.z1);
  check(tag + ': the axis and the ends unchanged (end rings Ø' + f3(2 * o.Ri) + ' / Ø' + f3(2 * o.Ro) + ' where they were)',
    Math.abs(z0.lo - o.Ri) < 1e-4 && Math.abs(z0.hi - o.Ro) < 1e-4 && Math.abs(z1.lo - o.Ri) < 1e-4 && Math.abs(z1.hi - o.Ro) < 1e-4);
  return { W: { lo, hi }, RW, w };
}

/* ======================================================================= */

console.log('\n=== 1. reading the tube ===');
const tube = stockTube(10, 1.6, 40);
{
  const rd = NSO_tubeNeckRead(tube);
  check('Stock tube Ø20 wall 1.6: the axis read off its top end', rd.ok && rd.tube.axis[2] === 1 && Math.abs(rd.tube.center[2] - 40) < 1e-9 &&
        Math.abs(rd.tube.lengthMm - 40) < 1e-9, rd.reason);
}

const HOURS = [];
console.log('\n=== 2. pinch Δr −4 over 12 mm, Smooth, at the middle of the Stock tube ===');
{
  const t0 = Date.now(), r = NSO_tubeNeckRaw(tube, { point: [10, 0, 20], length: 12, dr: -4, profile: 'smooth' }), ms = Date.now() - t0;
  console.log('   ' + r.reason);
  if (common('pinch smooth', tube, r)) {
    const M = measureZ('pinch smooth', tube, r, { zWaist: 20, bore: 8.8, outer: 12, Ro: 10, Ri: 8.4, t: 1.6, z0: 0, z1: 40, zA: 14, zB: 26 });
    console.log('   NOTE: the ticket wrote "bore at the waist = 12.8". Δr is a change of RADIUS (it is Flare\'s Δr, and −9 must close a');
    console.log('         Ø16.8 bore): 16.8 − 2·4 = 8.8. 12.8 is 16.8 − 4, the diameter moved by 4. Measured: Ø' + f3(2 * M.w.lo) + '.');
    row('Stock tube Ø20/1.6, pinch −4 over 12, smooth', tube, r, ms, 'bore Ø' + f3(2 * M.w.lo) + ', wall ' + f3(M.W.lo) + '–' + f3(M.W.hi) + ' (3D ' + f3(M.RW.lo) + '–' + f3(M.RW.hi) + ')');
  }
}

console.log('\n=== 3. expand Δr +4 over 12 mm, Smooth ===');
{
  const t0 = Date.now(), r = NSO_tubeNeckRaw(tube, { point: [10, 0, 20], length: 12, dr: 4, profile: 'smooth' }), ms = Date.now() - t0;
  console.log('   ' + r.reason);
  if (common('expand smooth', tube, r)) {
    // at the waist of a bulge the inner face is the least radius there too
    const M = measureZ('expand smooth', tube, r, { zWaist: 20, bore: 24.8, outer: 28, Ro: 10, Ri: 8.4, t: 1.6, z0: 0, z1: 40, zA: 14, zB: 26 });
    row('Stock tube Ø20/1.6, expand +4 over 12, smooth', tube, r, ms, 'bore Ø' + f3(2 * M.w.lo) + ', wall ' + f3(M.W.lo) + '–' + f3(M.W.hi) + ' (3D ' + f3(M.RW.lo) + '–' + f3(M.RW.hi) + ')');
  }
}

console.log('\n=== 4. Funnel: pinch and expand, straight in and straight out ===');
for (const dr of [-4, 4]) {
  const tag = (dr < 0 ? 'pinch' : 'expand') + ' funnel';
  const t0 = Date.now(), r = NSO_tubeNeckRaw(tube, { point: [10, 0, 20], length: 12, dr, profile: 'funnel' }), ms = Date.now() - t0;
  console.log('   ' + r.reason + ' · taper ' + (r.profile && f3(r.profile.taperDeg)) + '°');
  if (common(tag, tube, r)) {
    const M = measureZ(tag, tube, r, { zWaist: 20, bore: 16.8 + 2 * dr, outer: 20 + 2 * dr, Ro: 10, Ri: 8.4, t: 1.6, z0: 0, z1: 40, zA: 14, zB: 26 });
    // straight in, straight out: on each face's meridian the longest edge below
    // the waist and the longest above it are the taper, at the same angle off
    // the axis, mirrored, each over half the band less the bends
    const G = graph(r.tris);
    const tapers = [meridian(G, 10, 0), meridian(G, 8.4, 0)].map(c => {
      const e = [];
      for (let i = 0; i + 1 < c.length; i++) if (c[i][1] >= 14 - 1e-6 && c[i + 1][1] <= 26 + 1e-6) e.push([c[i], c[i + 1]]);
      const longest = half => e.filter(q => half ? q[0][1] >= 20 - 1e-6 : q[1][1] <= 20 + 1e-6)
        .reduce((m, q) => Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) > Math.hypot(m[1][0] - m[0][0], m[1][1] - m[0][1]) ? q : m);
      const ang = q => Math.atan2(q[1][0] - q[0][0], q[1][1] - q[0][1]) * 180 / Math.PI;
      const lo = longest(false), hi = longest(true);
      return { a: ang(lo), b: ang(hi), len: Math.hypot(lo[1][0] - lo[0][0], lo[1][1] - lo[0][1]) };
    });
    const want = r.profile.taperDeg * Math.sign(dr);
    check(tag + ': straight in and straight out - one edge each way on both faces, at ' + f3(r.profile.taperDeg) + '° off the axis',
      tapers.every(q => Math.abs(q.a - want) < 0.01 && Math.abs(q.b + want) < 0.01 && q.len > 4),
      tapers.map(q => f3(q.a) + '° / ' + f3(q.b) + '° over ' + f3(q.len)).join(' · '));
    row('Stock tube Ø20/1.6, ' + (dr < 0 ? 'pinch −4' : 'expand +4') + ' over 12, funnel', tube, r, ms, 'bore Ø' + f3(2 * M.w.lo) + ', wall ' + f3(M.W.lo) + '–' + f3(M.W.hi) + ', taper ' + f3(r.profile.taperDeg) + '°');
  }
}

console.log('\n=== 5. two necks 10 mm apart, then one that would overlap ===');
let twoNecks = null;
{
  const a = NSO_tubeNeckRaw(tube, { point: [10, 0, 9], length: 12, dr: -4 });
  const b = a.ok ? NSO_tubeNeckRaw(a.tris, { point: [10, 0, 31], length: 12, dr: -4 }) : a;
  console.log('   first:  ' + a.reason + '\n   second: ' + b.reason);
  check('first neck (3–15 mm up): made', a.ok);
  check('second neck (25–37 mm up, 10 mm clear of the first): made, no refusal', b.ok, b.reason);
  if (a.ok && b.ok) {
    common('two necks', a.tris, b);
    const T0 = topo(tube), T2 = topo(b.tris);
    check('both: closed, 2-manifold, Euler unchanged from the plain tube', T2.open === 0 && T2.nm === 0 && T2.flip === 0 && T2.euler === T0.euler);
    const w1 = radiiAt(b.tris, 9), w2 = radiiAt(b.tris, 31), mid = radiiAt(b.tris, 20);
    check('both waists present: bore Ø8.80 at 9 mm and at 31 mm', Math.abs(2 * w1.lo - 8.8) <= 0.05 && Math.abs(2 * w2.lo - 8.8) <= 0.05,
      'Ø' + f3(2 * w1.lo) + ' · Ø' + f3(2 * w2.lo));
    check('...and the straight tube between them', mid.lo === Infinity || (Math.abs(mid.lo - 8.4) < 1e-4 && Math.abs(mid.hi - 10) < 1e-4),
      mid.lo === Infinity ? 'no vertex at 20 mm (one long straight band)' : f3(mid.lo) + ' / ' + f3(mid.hi));
    const keyT = (s, t) => Array.from(s.subarray(t * 9, t * 9 + 9)).join(',');
    const outSet = new Set(); for (let t = 0; t < b.tris.length / 9; t++) outSet.add(keyT(b.tris, t));
    let firstKept = 0, firstTotal = 0;
    for (let t = 0; t < a.tris.length / 9; t++) {
      let zh = -Infinity; for (let k = 0; k < 3; k++) zh = Math.max(zh, a.tris[t * 9 + k * 3 + 2]);
      if (zh <= 15 + 1e-4) { firstTotal++; if (outSet.has(keyT(a.tris, t))) firstKept++; }
    }
    check('the second neck left the first bit for bit (its own Undo undoes only itself)', firstKept === firstTotal, firstKept + ' of ' + firstTotal);
    const G = graph(b.tris), Oc = meridian(G, 10, 0), Ic = meridian(G, 8.4, 0), W = chainWall(Oc, Ic);
    check('wall 1.6 ± 0.02 along both necks', W.lo >= 1.58 && W.hi <= 1.62, f3(W.lo) + '–' + f3(W.hi));
    twoNecks = b;
    row('Stock tube, two pinches −4 over 12, 10 mm apart', a.tris, b, null, 'wall ' + f3(W.lo) + '–' + f3(W.hi));
    const ov = NSO_tubeNeckRaw(b.tris, { point: [10, 0, 20], length: 12, dr: 3 });
    console.log('   overlap: ' + ov.reason);
    check('a third neck over the gap (14–26 mm, into both) is refused: necks may not overlap', !ov.ok && ov.tris === b.tris &&
          /Necks may not overlap/.test(ov.reason) && /move it \d+\.\d+ mm or more along the tube/.test(ov.reason), ov.reason);
  }
  const one = NSO_tubeNeckRaw(tube, { point: [10, 0, 20], length: 12, dr: -4 });
  const ov2 = NSO_tubeNeckRaw(one.tris, { point: [10, 0, 28], length: 12, dr: -2 });
  check('a neck 8 mm from another of 12 mm (bands 4 mm into each other) is refused, naming the shaped stretch and the move',
    !ov2.ok && /the wall is not straight from 14\.00 to 26\.00 mm in from the end/.test(ov2.reason) && /move it 4\.00 mm or more/.test(ov2.reason), ov2.reason);
  const touch = NSO_tubeNeckRaw(one.tris, { point: [10, 0, 32], length: 12, dr: -2 });
  check('...and one that just meets it (bands end to end) is made', touch.ok, touch.reason);
}

console.log('\n=== 6. refusals, the piece unchanged ===');
{
  const r9 = NSO_tubeNeckRaw(tube, { point: [10, 0, 20], length: 12, dr: -9 });
  console.log('   ' + r9.reason);
  check('pinch −9 is refused, naming the bore limit (Ø0.80, 2 nozzle widths) and the most it pinches (8.00)', !r9.ok && r9.tris === tube &&
        /would close the bore/.test(r9.reason) && /bore limit of Ø0\.80 \(2 nozzle widths at a 0\.4 mm nozzle\)/.test(r9.reason) &&
        /pinches by 8\.00 mm at most/.test(r9.reason));
  const r8 = NSO_tubeNeckRaw(tube, { point: [10, 0, 20], length: 30, dr: -8 });
  check('...and that most, −8 over 30 mm, is made: bore Ø0.80', r8.ok && Math.abs(r8.waistBoreDiaMm - 0.8) < 1e-6, r8.reason);
  const rs = NSO_tubeNeckRaw(tube, { point: [10, 0, 20], length: 6, dr: -6 });
  check('a smooth neck too short for its Δr is refused by name, with the length it needs', !rs.ok && /too short to move a 1\.60 mm wall/.test(rs.reason) &&
        /needs 9\.74 mm or more/.test(rs.reason), rs.reason);
  const rf = NSO_tubeNeckRaw(tube, { point: [10, 0, 20], length: 3, dr: -6, profile: 'funnel' });
  check('a funnel too short for its Δr is refused (past the 75° taper)', !rf.ok && /past the 75° limit|too short to bend/.test(rf.reason), rf.reason);
  const re = NSO_tubeNeckRaw(tube, { point: [10, 0, 37], length: 12, dr: -4 });
  check('a band past the end of the tube is refused', !re.ok && /would run past the end of the tube \(it is 40\.00 mm long\)/.test(re.reason), re.reason);
  const r0 = NSO_tubeNeckRaw(tube, { point: [10, 0, 20], length: 12, dr: 0 });
  check('Δr 0 is refused: no neck', !r0.ok && /a Δr of 0 is no neck/.test(r0.reason));
  const rod = NSO_Stock.revolve(NSO_Stock.profileCylinder(6, 30), 96);
  const rr = NSO_tubeNeckRaw(rod, { length: 8, dr: -2 });
  check('a solid rod is refused: its end is closed', !rr.ok && /the end is closed - a flat Ø12\.00 face/.test(rr.reason), rr.reason);
}

console.log('\n=== 7. a Wheel cup, an Extend-made pipe, an imported tube along X ===');
{
  const cup = wheelCup();
  const r = NSO_tubeNeckRaw(cup, { point: [15, 0, 25], length: 14, dr: -3 });
  console.log('   ' + r.reason);
  if (common('Wheel cup, pinch −3 over 14', cup, r)) {
    const M = measureZ('Wheel cup', cup, r, { zWaist: 25, bore: 20, outer: 24, Ro: 15, Ri: 13, t: 2, z0: 45, z1: 45, zo: 0, zi: 3, zA: 18, zB: 32 });
    row('Wheel cup Ø30/2 (128 sides), pinch −3 over 14, smooth', cup, r, null, 'bore Ø' + f3(2 * M.w.lo) + ', wall ' + f3(M.W.lo) + '–' + f3(M.W.hi));
  }
  const ext = NSO_extendRaw(tube, { length: 60 });
  check('Extend makes the Stock tube 60 mm long', ext.ok, ext.reason);
  if (ext.ok) {
    const re = NSO_tubeNeckRaw(ext.tris, { point: [10, 0, 30], length: 12, dr: 3, profile: 'funnel' });
    console.log('   ' + re.reason);
    if (common('Extend-made pipe, expand +3 funnel', ext.tris, re)) {
      const M = measureZ('Extend pipe', ext.tris, re, { zWaist: 30, bore: 22.8, outer: 26, Ro: 10, Ri: 8.4, t: 1.6, z0: 0, z1: 60, zA: 24, zB: 36 });
      row('Extend-made pipe (60 mm), expand +3 over 12, funnel', ext.tris, re, null, 'bore Ø' + f3(2 * M.w.lo) + ', wall ' + f3(M.W.lo) + '–' + f3(M.W.hi));
    }
  }
  const tx = tubeAlongX(80, 48);
  const rx = NSO_tubeNeckRaw(tx, { point: [40, 20, 18], length: 16, dr: -2.5 });
  console.log('   ' + rx.reason);
  if (common('imported tube along X, pinch −2.5 over 16', tx, rx)) {
    // the waist is at x = 40: the bore there, about the tube's own axis (y 20, z 10)
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < rx.tris.length; i += 3) if (Math.abs(rx.tris[i] - 40) < 1e-4) { const q = Math.hypot(rx.tris[i + 1] - 20, rx.tris[i + 2] - 10); lo = Math.min(lo, q); hi = Math.max(hi, q); }
    check('...the axis along X read; bore Ø7.00 and outside Ø11.00 at the waist (48-gon vertices)', rx.tube.axis[0] !== 0 &&
          Math.abs(2 * lo - 7) <= 0.05 && Math.abs(2 * hi - 11) <= 0.05, 'Ø' + f3(2 * lo) + ' / Ø' + f3(2 * hi));
    check('...wall held', rx.wall.minMm >= 1.98 && rx.wall.maxMm <= 2.02, f3(rx.wall.minMm) + '–' + f3(rx.wall.maxMm));
    row('imported Ø16/Ø12 48-gon along X, pinch −2.5 over 16', tx, rx, null, 'bore Ø' + f3(2 * lo) + ', wall ' + f3(rx.wall.minMm) + '–' + f3(rx.wall.maxMm));
  }
}

console.log('\n=== 8. an hourglass, and time ===');
{
  const r = NSO_tubeNeckRaw(tube, { point: [10, 0, 20], length: 36, dr: -5.5 });
  console.log('   ' + r.reason);
  if (common('hourglass: pinch −5.5 over 36', tube, r)) row('Stock tube, hourglass: pinch −5.5 over 36, smooth', tube, r, null, 'bore Ø' + f3(r.waistBoreDiaMm));
  const big = stockTube(30, 2, 120, 2000);
  const t0 = Date.now(), rb = NSO_tubeNeckRaw(big, { length: 30, dr: -6 }), ms = Date.now() - t0;
  check('a 2000-sided tube (' + big.length / 9 + ' triangles) necks in under 5 s', rb.ok && ms < 5000, ms + ' ms · ' + (rb.ok ? rb.tris.length / 9 + ' out' : rb.reason));
  if (rb.ok) row('2000-sided Ø60/2 tube, pinch −6 over 30, smooth', big, rb, ms, '');
}

console.log('\n=== 9. one tube to a printer: a scaled, Rolled export necks; a real taper and an oval are refused with their spread ===');
{
  // An exported tube: MINI_TPU_TEST's size (Ø20 / Ø18, 8 long, 96 sides), its
  // coordinates rounded to 0.001 mm as an STL exporter writing three places
  // leaves them. Its outside's vertices then spread ~0.0012 mm in radius, as
  // MINI_TPU_TEST's own do (9.99952 - 10.00060); a scale multiplies that.
  const round3 = q => { const o = new Float32Array(q.length); for (let i = 0; i < q.length; i++) o[i] = Math.round(q[i] * 1000) / 1000; return o; };
  const radii = q => { const rr = []; for (let i = 0; i < q.length; i += 3) rr.push(Math.hypot(q[i], q[i + 1])); return rr; };
  const scaledRolled = (soup, factor) => {
    const S = NSO_scaleSoup(soup, { factor });
    if (!S.ok) return { ok: false, reason: 'scale: ' + S.reason };
    let zl = Infinity, zh = -Infinity;
    for (let i = 2; i < S.tris.length; i += 3) { zl = Math.min(zl, S.tris[i]); zh = Math.max(zh, S.tris[i]); }
    // Roll the bottom end, with the card's default bead (radius 1.5 walls; the
    // wall is 1 mm × the factor), 180°. The top stays a plain end for Neck to
    // read the axis off: Neck reads the highest open end, and a top Roll's lip,
    // standing highest, is not read as an end at every size (×2.37 is one).
    const ro = Math.max(...radii(S.tris));
    const R = NSO_tubeEdgeRaw(S.tris, { verb: 'roll', point: [ro, 0, zl], radius: Math.max(1, Math.round(3 * factor) / 2), angle: 180 });
    return { ok: R.ok, reason: R.reason, scaled: S.tris, tris: R.tris, zl, zh };
  };
  const pinchMid = (tag, base, factor, wantRo) => {
    const P = scaledRolled(base, factor);
    check(tag + ': scaled ×' + factor + ' and Rolled at its bottom end', P.ok, P.reason);
    if (!P.ok) return;
    const zm = (P.zl + P.zh) / 2;
    const r = NSO_tubeNeckRaw(P.tris, { point: [wantRo, 0, zm], length: 12, dr: -2 });
    console.log('   ' + r.reason);
    const S = r.wallRead && r.wallRead.radii;
    if (S) console.log('   band: outside r ' + S.outer.lo.toFixed(6) + ' - ' + S.outer.hi.toFixed(6) + ' (mean ' + S.outer.mean.toFixed(6) + ', ' +
      (S.outer.dev * 1000).toFixed(2) + ' µm off it), bore ' + S.inner.lo.toFixed(6) + ' - ' + S.inner.hi.toFixed(6) + ' (' + (S.inner.dev * 1000).toFixed(2) +
      ' µm off it), allowed ' + f3(S.outer.tolMm) + ' / ' + f3(S.inner.tolMm));
    check(tag + ': the band\'s outside spreads more than 0.001 mm (the old limit, which refused it)', S && S.outer.hi - S.outer.lo > 1e-3,
      S ? (1000 * (S.outer.hi - S.outer.lo)).toFixed(2) + ' µm' : 'no reading');
    if (!common(tag + ', pinch −2 over 12 mid-tube', P.tris, r)) return;
    const Ro = r.band.Ro, Ri = r.band.Ri, w = radiiAt(r.tris, zm);
    check(tag + ': outside Ø' + f3(2 * wantRo) + ' read (the mean), within 0.01', Math.abs(2 * Ro - 2 * wantRo) <= 0.01, 'Ø' + f3(2 * Ro) + ' / bore Ø' + f3(2 * Ri));
    check(tag + ': bore and outside at the waist 4 mm narrower, ± 0.05', Math.abs(2 * w.lo - (2 * Ri - 4)) <= 0.05 && Math.abs(2 * w.hi - (2 * Ro - 4)) <= 0.05,
      'Ø' + f3(2 * w.lo) + ' / Ø' + f3(2 * w.hi));
    const RW = rayWall(graph(r.tris), zm - 6, zm + 6, 30), t = Ro - Ri;
    check(tag + ': wall ' + f3(t) + ' ± 0.02 in 3D through the neck', RW.lo >= t - 0.02 && RW.hi <= t + 0.02 && RW.n >= RW.tried * 0.95,
      f3(RW.lo) + '–' + f3(RW.hi) + ' from ' + RW.n + ' of ' + RW.tried + ' vertices');
    row(tag + ' ×' + factor + ', Rolled, pinch −2 over 12', P.tris, r, null, 'outside spread ' + (1000 * (S.outer.hi - S.outer.lo)).toFixed(1) + ' µm, wall ' + f3(RW.lo) + '–' + f3(RW.hi));
  };
  const exported = round3(stockTube(10, 1, 8));
  const ev = radii(exported).filter(q => q > 9.5);
  check('the exported tube\'s outside vertices spread over 0.001 mm in radius, as MINI_TPU_TEST\'s do', Math.max(...ev) - Math.min(...ev) > 1e-3,
    Math.min(...ev).toFixed(6) + ' - ' + Math.max(...ev).toFixed(6));
  pinchMid('exported tube', exported, 2.37, 10 * 2.37);

  // ...and MINI_TPU_TEST itself, where a nest-library checkout is (CI has one)
  const TPU_FILE = LIBDIR.libraryDir() && LIBDIR.catalogFile('MINI_TPU_TEST.stl');
  if (!TPU_FILE) LIBDIR.skip('section 9\'s MINI_TPU_TEST.stl case (the generated export above still runs)');
  else pinchMid('MINI_TPU_TEST.stl', readSTL(TPU_FILE), 2.37, 10 * 2.37);

  // A real taper: the outside narrows 0.025 mm in diameter per mm (stations
  // every 2 mm), so across a 12 mm band 14 - 26 mm up it runs Ø19.65 to Ø19.35.
  const prof = [{ z: 0, r: 9.2 }];
  for (let z = 0; z <= 40; z += 2) prof.push({ z, r: 10 - 0.0125 * z });
  prof.push({ z: 40, r: 9.2 }, { z: 0, r: 9.2 });
  const taper = NSO_Stock.revolve(prof, 96);
  const rt = NSO_tubeNeckRaw(taper, { point: [10, 0, 20], length: 12, dr: -2 });
  console.log('   taper: ' + rt.reason);
  check('a tube whose outside tapers 0.30 mm across the band is refused, the piece unchanged, with the spread: Ø19.35 to Ø19.65',
    !rt.ok && rt.tris === taper && /its outside varies by 0\.30 mm across the band, Ø19\.35 to Ø19\.65/.test(rt.reason), rt.reason);

  // An oval: the outside 0.9% wider along X than along Y (Ø20.00 by Ø20.18),
  // every face still square to the axis - the one-radius test itself refuses it.
  const oval = stockTube(10, 1.6, 40).slice();
  for (let i = 0; i < oval.length; i += 3) if (Math.hypot(oval[i], oval[i + 1]) > 9) oval[i] = Math.fround(oval[i] * 1.009);
  const ro = NSO_tubeNeckRaw(oval, { point: [10, 0, 20], length: 12, dr: -2 });
  console.log('   oval: ' + ro.reason);
  const nums = (ro.reason.match(/Ø\d+\.\d+ to Ø\d+\.\d+/) || [''])[0].match(/\d+\.\d+/g) || [];
  check('an oval outside (Ø20.00 by Ø20.18) is refused as not one tube, with the spread: varies by 0.18 mm, Ø20.00 to Ø20.18, and the limit',
    !ro.ok && ro.tris === oval && /not one tube across the band - its outside varies by 0\.18 mm across the band, Ø20\.00 to Ø20\.18 \(0\.0\d\d mm off its mean radius; one tube holds every vertex within 0\.020 mm of it\)/.test(ro.reason) &&
    nums.length === 2 && nums[0] !== nums[1], ro.reason);
}

console.log('\n| piece and neck | in → out triangles | ms | measured |');
console.log('|---|---|---|---|');
for (const t of TABLE) console.log('| ' + t.name + ' | ' + t.trisIn + ' → ' + t.trisOut + ' | ' + t.ms + ' | ' + t.extra + ' |');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('FAILED: ' + FAILS.join(' | ')); process.exit(1); }
