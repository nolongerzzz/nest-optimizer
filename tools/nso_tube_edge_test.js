#!/usr/bin/env node
// Headless self-test for nso_tube_edge.js (Tube edge: Flare and Roll).
//
//   node tools/nso_tube_edge_test.js        exit 0 = every gate held
//
// Loads the shipped files with vm, in index.html's order, so the browser files
// stay free of any node idiom. Every fixture is generated here, from the
// shipped generators where there is one (Stock's revolve, the Wheel, Extend).
// Every number is measured on the OUTPUT soup by code that shares nothing with
// the treatment's construction:
//   - the meridian at angle 0 is walked out of the output mesh's own edges
//     (the vertices with y = 0), from the ring along the straightest edge;
//   - the wall is measured on that meridian (each face's points against the
//     other face's polyline) and, in 3D, by casting a ray from every vertex of
//     the new wall on a dozen meridians along its own (output) vertex normal;
//   - the topology is welded on exact float32 keys by a counter written below;
//   - tools/mesh_validate.py --gate runs on every output.
//
// Prints a table at the end; the PR quotes it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { writeSTL } = require('./nso_stl_io.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Date,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Int8Array, ArrayBuffer, Error, Infinity, NaN
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['NSO_Repair.js', 'nso_thickness.js', 'nso_stock.js', 'nso_path_sweep.js', 'app-cut.js', 'app-sculpt.js',
                 'app-extend.js', 'nso_section.js', 'nso_bend.js', 'app-wheel.js', 'nso_tube_edge.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { NSO_tubeEdgeRaw, NSO_tubeEdgeRead, NSO_Stock, NSO_extendRaw } = ctx;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const TABLE = [];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-tube-edge-'));
const f3 = x => (+x).toFixed(3);

/* ------------------------------------------------------------------ fixtures */

// Stock's own tube: NSO_Stock.revolve of its tube meridian, 96 segments, Z up,
// the axis at x = y = 0, the open ends at z = 0 and z = h.
const stockTube = (rOut, wall, h) => NSO_Stock.revolve(NSO_Stock.profileTube(rOut, rOut - wall, h), 96);
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
function box(x0, y0, z0, x1, y1, z1) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return new Float32Array(f.flatMap(t => t.flatMap(i => v[i])));
}
// A square tube 20 x 20, wall 2, along Z.
function squareTube(h) {
  const O = [[-10, -10], [10, -10], [10, 10], [-10, 10]], I = [[-8, -8], [8, -8], [8, 8], [-8, 8]], t = [];
  for (let i = 0; i < 4; i++) {
    const a = O[i], b = O[(i + 1) % 4], c = I[i], d = I[(i + 1) % 4];
    t.push([a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], h], [a[0], a[1], 0], [b[0], b[1], h], [a[0], a[1], h]);
    t.push([d[0], d[1], 0], [c[0], c[1], 0], [c[0], c[1], h], [d[0], d[1], 0], [c[0], c[1], h], [d[0], d[1], h]);
    t.push([a[0], a[1], h], [b[0], b[1], h], [d[0], d[1], h], [a[0], a[1], h], [d[0], d[1], h], [c[0], c[1], h]);
    t.push([a[0], a[1], 0], [d[0], d[1], 0], [b[0], b[1], 0], [a[0], a[1], 0], [c[0], c[1], 0], [d[0], d[1], 0]);
  }
  return new Float32Array(t.flat());
}
const rod = (r, h) => NSO_Stock.revolve(NSO_Stock.profileCylinder(r, h), 96);
// A thrown vessel: the Wheel's ball, opened, revolved - exactly what the app makes.
function wheelVessel() {
  const ball = ctx.NSO_wheelBall({ height: 60 });
  const open = ctx.NSO_wheelOpen(ball.piece, {});
  if (!open.ok) throw new Error('wheel open: ' + open.reason);
  return { soup: ctx.NSO_wheelRevolve(open.piece), piece: open.piece };
}

/* ------------------------------------------------------------- measuring */

// Exact-bit weld and edge counts, written here (not the treatment's).
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
// The canonical checker on the real bytes.
function meshValidate(name, soup) {
  const file = path.join(TMP, name + '.stl');
  writeSTL(file, soup);
  let out;
  try { out = execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json', '--gate'], { encoding: 'utf8', maxBuffer: 64 << 20 }); }
  catch (e) { out = e.stdout; }
  const r = JSON.parse(out);
  return { pass: r.verdict === 'PASS', fails: r.verdict_fails, open: r.open_edges, nm: r.nonmanifold_edges, pierce: r.self_intersection ? r.self_intersection.pierce : null, file };
}

/* The output mesh's own graph: vertex positions, neighbours, incident faces. */
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

/* Walk one face's meridian at angle 0 (the vertices with y = 0, x > cx) out
   of the mesh, from a start vertex, always along the straightest edge, until
   the turn is more than 35° (a lip corner; the straight cone's crease turns
   30°). Returns [[r, z], ...]. Frame: axis
   +Z through (cx, 0). */
function meridianChain(G, start, cx, firstUp) {
  // y within 1e-6: the new stations are each vertex moved along its own
  // radial line about the FITTED centre, which is ~1e-16 off the origin
  const onPlane = id => Math.abs(G.P[id][1]) < 1e-6 && G.P[id][0] > cx;
  const rz = id => [G.P[id][0] - cx, G.P[id][2]];
  let cur = [...G.P.keys()].find(id => G.P[id] && onPlane(id) && Math.abs(G.P[id][0] - cx - start[0]) < 1e-5 && Math.abs(G.P[id][2] - start[1]) < 1e-5);
  if (cur == null) return null;
  const chain = [rz(cur)], seen = new Set([cur]);
  let dir = firstUp;
  for (;;) {
    let best = null, bestTurn = Infinity;
    for (const q of G.nb[cur]) {
      if (seen.has(q) || !onPlane(q)) continue;
      const a = rz(cur), b = rz(q), d = [b[0] - a[0], b[1] - a[1]], L = Math.hypot(...d);
      const turn = Math.acos(Math.max(-1, Math.min(1, (d[0] * dir[0] + d[1] * dir[1]) / L)));
      if (turn < bestTurn) { bestTurn = turn; best = q; }
    }
    if (best == null || bestTurn > 35 * Math.PI / 180) break;
    const a = rz(cur), b = rz(best), L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    dir = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    seen.add(best); chain.push(b); cur = best;
  }
  return chain;
}
function segDist(p, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1], L2 = ex * ex + ey * ey;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / L2)) : 0;
  return { d: Math.hypot(p[0] - a[0] - t * ex, p[1] - a[1] - t * ey), t };
}
// Each chain's points against the other chain's polyline, where the nearest
// point is not one of the other chain's two ends.
function chainWall(A, B) {
  let lo = Infinity, hi = -Infinity, n = 0;
  for (const [X, Y] of [[A, B], [B, A]]) for (const p of X.slice(1)) {
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
/* The wall in 3D: from every output vertex past the ring plane on every
   `everyDeg` meridian, the distance to the nearest face of the OTHER side of
   the wall - the faces whose normal is antiparallel to the vertex's own
   (output) normal within 20°. Offset faces have antiparallel normals at
   corresponding points, so that nearest distance is the wall there. A lip
   corner has no such face and is not counted, and nor are a flare's vertices
   within a wall of its lip plane (zLipSkip): the nearest face there is the
   lip's own edge. */
function rayWall(G, zEnd, cx, cy, everyDeg, zLipSkip) {
  const s = G.s, nT = G.T.tris, fn = [];
  for (let t = 0; t < nT; t++) fn.push(faceNormal(s, t));
  let lo = Infinity, hi = -Infinity, n = 0, tried = 0, worstAt = null;
  const cand = [];
  for (let t = 0; t < nT; t++) {
    let zmax = -Infinity; for (let k = 0; k < 3; k++) zmax = Math.max(zmax, s[t * 9 + k * 3 + 2]);
    if (zmax >= zEnd - 6) cand.push(t);
  }
  const cos20 = Math.cos(20 * Math.PI / 180);
  G.P.forEach((p, id) => {
    if (!p || p[2] < zEnd - 1e-6) return;
    // within a wall of a flare's lip plane the nearest face is the lip, not
    // the wall's other side
    if (zLipSkip != null && p[2] > zLipSkip) return;
    const ang = Math.atan2(p[1] - cy, p[0] - cx) * 180 / Math.PI;
    const k = Math.round(ang / everyDeg);
    if (Math.abs(ang - k * everyDeg) > 1e-3) return;
    const N = [0, 0, 0];
    for (const t of G.faces[id]) { for (let c = 0; c < 3; c++) N[c] += fn[t].n[c] * fn[t].area; }
    const L = Math.hypot(...N), nv = N.map(x => x / L);
    // a corner (the lip's two edges) has faces more than 35° apart: no one
    // other face to measure to. The cone's crease is 30°.
    let spread = 1;
    for (const t1 of G.faces[id]) for (const t2 of G.faces[id]) spread = Math.min(spread, fn[t1].n[0] * fn[t2].n[0] + fn[t1].n[1] * fn[t2].n[1] + fn[t1].n[2] * fn[t2].n[2]);
    if (spread < Math.cos(35 * Math.PI / 180)) return;
    tried++;
    let best = Infinity;
    for (const t of cand) {
      if (fn[t].n[0] * nv[0] + fn[t].n[1] * nv[1] + fn[t].n[2] * nv[2] > -cos20) continue;
      const d = pointTri(p, s, t); if (d < best) best = d;
    }
    if (!isFinite(best)) return;
    n++; if (best < lo) { lo = best; } if (best > hi) { hi = best; worstAt = p; }
  });
  if (process.env.TE_DEBUG) console.log('      worst at', worstAt && worstAt.map(x => x.toFixed(3)).join(', '));
  return { lo, hi, n, tried };
}
// Kasa circle fit.
function fitCircle(pts) {
  let mx = 0, my = 0; pts.forEach(p => { mx += p[0]; my += p[1]; }); mx /= pts.length; my /= pts.length;
  let Suu = 0, Svv = 0, Suv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
  pts.forEach(p => { const u = p[0] - mx, v = p[1] - my; Suu += u * u; Svv += v * v; Suv += u * v; Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u; });
  const det = Suu * Svv - Suv * Suv, bu = (Suuu + Suvv) / 2, bv = (Svvv + Svuu) / 2;
  const c = [(bu * Svv - bv * Suv) / det + mx, (Suu * bv - Suv * bu) / det + my];
  const rs = pts.map(p => Math.hypot(p[0] - c[0], p[1] - c[1]));
  return { c, r: rs.reduce((a, b) => a + b, 0) / rs.length, dev: Math.max(...rs) - Math.min(...rs) };
}

/* Everything every output must hold: the treatment's own ok, the topology
   unchanged, the canonical checker, and the input copied bit for bit outside
   the end face. */
function common(tag, soup, r, wantWall) {
  check(tag + ': treated', r.ok, r.reason);
  if (!r.ok) return null;
  const T0 = topo(soup), T1 = topo(r.tris);
  check(tag + ': closed, 2-manifold, consistently wound, Euler unchanged',
    T1.open === T0.open && T1.nm === 0 && T1.flip === 0 && T1.degen === 0 && T1.euler === T0.euler,
    `open ${T1.open} nm ${T1.nm} flip ${T1.flip} degen ${T1.degen} euler ${T0.euler}->${T1.euler}`);
  const MV = meshValidate(tag.replace(/[^a-z0-9]+/gi, '_'), r.tris);
  check(tag + ': mesh_validate --gate PASS', MV.pass, MV.pass ? 'pierce ' + MV.pierce : (MV.fails || []).join('; '));
  // every input triangle but the end face's is in the output, the same bits
  const keyT = (s, t) => Array.from(s.subarray(t * 9, t * 9 + 9)).join(',');
  const outSet = new Set();
  for (let t = 0; t < r.tris.length / 9; t++) outSet.add(keyT(r.tris, t));
  const face = new Set(r.end.face);
  let missing = 0;
  for (let t = 0; t < soup.length / 9; t++) if (!face.has(t) && !outSet.has(keyT(soup, t))) missing++;
  check(tag + ': the rest of the piece copied bit for bit', missing === 0, missing + ' missing of ' + (soup.length / 9 - face.size));
  check(tag + ': volume grew by the section swept round (Pappus) within 0.5%',
    Math.abs((volume(r.tris) - volume(soup)) - r.volume.pappus) <= 5e-3 * r.volume.pappus,
    f3(volume(r.tris) - volume(soup)) + ' vs ' + f3(r.volume.pappus) + ' mm³');
  return { T0, T1, MV };
}

/* ======================================================================= */

console.log('\n=== 1. reading the end ===');
const tube = stockTube(10, 1.6, 40);
{
  const rd = NSO_tubeEdgeRead(tube);
  check('Stock tube Ø20 wall 1.6: the top end read', rd.ok && Math.abs(rd.end.Ro - 10) < 1e-6 && Math.abs(rd.end.Ri - 8.4) < 1e-6 &&
        Math.abs(rd.end.wallMm - 1.6) < 1e-6 && rd.end.axis[2] === 1 && Math.abs(rd.end.center[2] - 40) < 1e-9, rd.reason);
  check('...its wall runs straight along the axis there', rd.ok && Math.abs(rd.end.leanDeg) < 1e-9, rd.ok && rd.end.leanDeg + '°');
  const rb = NSO_tubeEdgeRead(tube, { point: [0, 9, 0.5] });
  check('a click near the bottom picks the bottom end, facing down', rb.ok && rb.end.axis[2] === -1 && Math.abs(rb.end.center[2]) < 1e-9, rb.reason);
  const rw = NSO_tubeEdgeRead(tube, { point: [10, 0, 38] });
  check('a click on the outside wall near the top picks the top end', rw.ok && rw.end.axis[2] === 1, rw.reason);
}

console.log('\n=== 2. Flare 8 mm at 30°, straight, on the Stock tube ===');
const ROWS = [];
function row(name, soup, r, ms, extra) {
  TABLE.push({ name, trisIn: soup.length / 9, trisOut: r.ok ? r.tris.length / 9 : '-', ms: ms.toFixed(0), extra: extra || '' });
}
{
  const t0 = Date.now();
  const r = NSO_tubeEdgeRaw(tube, { verb: 'flare', length: 8, angle: 30, profile: 'straight' });
  const ms = Date.now() - t0;
  console.log('   ' + r.reason);
  const C = common('flare straight', tube, r, 1.6);
  if (C) {
    const G = graph(r.tris);
    let lipR = 0, zTop = -Infinity;
    G.P.forEach(p => { if (p && p[2] > 40) { lipR = Math.max(lipR, Math.hypot(p[0], p[1])); zTop = Math.max(zTop, p[2]); } });
    const want = 10 + 8 * Math.tan(Math.PI / 6);
    check('outer radius at the lip = 10 + 8·tan30 within 0.05', Math.abs(lipR - want) <= 0.05, f3(lipR) + ' vs ' + f3(want));
    check('...the lip 8 mm out from the end', Math.abs(zTop - 48) < 1e-4, f3(zTop));
    const Oc = meridianChain(G, [10, 0], 0, [0, 1]), Ic = meridianChain(G, [8.4, 0], 0, [0, 1]);
    const W = chainWall(Oc, Ic);
    check('wall 1.6 ± 0.02 along the flare (meridian walked out of the mesh)', W.lo >= 1.58 && W.hi <= 1.62 && W.n >= 4,
      f3(W.lo) + '–' + f3(W.hi) + ' over ' + W.n + ' points');
    const RW = rayWall(G, 40, 0, 0, 30, 48 - 1.6);
    check('wall 1.6 ± 0.02 in 3D (from every new vertex on 12 meridians, to the other face)', RW.lo >= 1.58 && RW.hi <= 1.62 && RW.n >= RW.tried * 0.6,
      f3(RW.lo) + '–' + f3(RW.hi) + ' from ' + RW.n + ' of ' + RW.tried + ' vertices');
    const ri = Oc.findIndex(p => p[0] === 10 && p[1] === 40), ring = Oc[ri], next = Oc[ri + 1];
    check('the join: the cone leaves the ring at 30° with no lip and no step',
      Math.abs(Math.atan2(next[0] - ring[0], next[1] - ring[1]) * 180 / Math.PI - 30) < 1e-3 && ring[0] === 10 && ring[1] === 40,
      'first edge at ' + f3(Math.atan2(next[0] - ring[0], next[1] - ring[1]) * 180 / Math.PI) + '°');
    row('Stock tube Ø20/1.6, flare 8 mm 30° straight', tube, r, ms, 'wall ' + f3(W.lo) + '–' + f3(W.hi) + ', lip r ' + f3(lipR));
  }
}

console.log('\n=== 3. the same flare, Trumpet ===');
{
  const t0 = Date.now();
  const r = NSO_tubeEdgeRaw(tube, { verb: 'flare', length: 8, angle: 30, profile: 'trumpet' });
  const ms = Date.now() - t0;
  console.log('   ' + r.reason);
  const C = common('flare trumpet', tube, r, 1.6);
  if (C) {
    const G = graph(r.tris);
    let lipR = 0, zTop = -Infinity;
    G.P.forEach(p => { if (p && p[2] > 40) { lipR = Math.max(lipR, Math.hypot(p[0], p[1])); zTop = Math.max(zTop, p[2]); } });
    const want = 10 + 8 * Math.tan(Math.PI / 6);
    check('same end values: lip radius 10 + 8·tan30 within 0.05, 8 mm out', Math.abs(lipR - want) <= 0.05 && Math.abs(zTop - 48) < 1e-4,
      f3(lipR) + ' at z ' + f3(zTop));
    const Oc = meridianChain(G, [10, 0], 0, [0, 1]), Ic = meridianChain(G, [8.4, 0], 0, [0, 1]);
    const W = chainWall(Oc, Ic);
    check('wall 1.6 ± 0.02 along the trumpet', W.lo >= 1.58 && W.hi <= 1.62 && W.n >= 6, f3(W.lo) + '–' + f3(W.hi) + ' over ' + W.n + ' points');
    const RW = rayWall(G, 40, 0, 0, 30, 48 - 1.6);
    check('...and in 3D', RW.lo >= 1.58 && RW.hi <= 1.62 && RW.n >= RW.tried * 0.6, f3(RW.lo) + '–' + f3(RW.hi) + ' from ' + RW.n + ' of ' + RW.tried);
    // discrete curvature on the outside face: turn / mean edge length at each
    // interior station past the ring
    const k = [], r0 = Oc.findIndex(p => p[0] === 10 && p[1] === 40);
    for (let i = r0 + 1; i + 1 < Oc.length; i++) {
      const a = Oc[i - 1], b = Oc[i], c = Oc[i + 1];
      const d1 = [b[0] - a[0], b[1] - a[1]], d2 = [c[0] - b[0], c[1] - b[1]], l1 = Math.hypot(...d1), l2 = Math.hypot(...d2);
      const turn = Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);
      k.push(Math.abs(turn) / ((l1 + l2) / 2));
    }
    const inner = k;   // from the first station past the ring (the ring vertex turns half a step off the straight wall)
    let mono = true;
    for (let i = 1; i < inner.length; i++) if (inner[i] > inner[i - 1] * (1 + 1e-6)) mono = false;
    check('monotone curvature along the trumpet (greatest at the join, easing toward the lip)', mono && inner.length >= 5,
      inner.map(x => x.toFixed(4)).join(' '));
    const ri = Oc.findIndex(p => p[0] === 10 && p[1] === 40), ring = Oc[ri], next = Oc[ri + 1];
    const a0 = Math.atan2(next[0] - ring[0], next[1] - ring[1]) * 180 / Math.PI;
    check('...tangent to the tube at the ring (the first edge under 5° off the axis)', a0 >= 0 && a0 < 5, f3(a0) + '°');
    check('...and steeper than the cone at the lip', r.lipAngleDeg > 30, f3(r.lipAngleDeg) + '°');
    row('Stock tube Ø20/1.6, flare 8 mm 30° trumpet', tube, r, ms, 'wall ' + f3(W.lo) + '–' + f3(W.hi) + ', lip ' + f3(r.lipAngleDeg) + '°');
  }
}

console.log('\n=== 4. Roll out 180°, radius 2.5 ===');
{
  const t0 = Date.now();
  const r = NSO_tubeEdgeRaw(tube, { verb: 'roll', radius: 2.5, angle: 180 });
  const ms = Date.now() - t0;
  console.log('   ' + r.reason);
  const C = common('roll 180', tube, r, 1.6);
  if (C) {
    const G = graph(r.tris);
    const Oc = meridianChain(G, [10, 0], 0, [0, 1]), Ic = meridianChain(G, [8.4, 0], 0, [0, 1]);
    const past = c => c.slice(c.findIndex(p => p[1] === 40) + 1);
    const fo = fitCircle(past(Oc)), fi = fitCircle(past(Ic));
    check('bead centre at (R + 2.5, z_end) = (12.5, 40)', Math.hypot(fo.c[0] - 12.5, fo.c[1] - 40) < 0.01 && Math.hypot(fi.c[0] - 12.5, fi.c[1] - 40) < 0.01,
      'outside face (' + f3(fo.c[0]) + ', ' + f3(fo.c[1]) + ') r ' + f3(fo.r) + ' · inside face (' + f3(fi.c[0]) + ', ' + f3(fi.c[1]) + ') r ' + f3(fi.r));
    check('...the bead\'s faces at 2.5 and 2.5 + 1.6', Math.abs(fo.r - 2.5) < 0.01 && Math.abs(fi.r - 4.1) < 0.01);
    const W = chainWall(Oc, Ic);
    check('wall 1.6 ± 0.02 round the roll', W.lo >= 1.58 && W.hi <= 1.62 && W.n >= 10, f3(W.lo) + '–' + f3(W.hi) + ' over ' + W.n + ' points');
    const RW = rayWall(G, 40, 0, 0, 30);
    check('...and in 3D', RW.lo >= 1.58 && RW.hi <= 1.62 && RW.n >= RW.tried * 0.5, f3(RW.lo) + '–' + f3(RW.hi) + ' from ' + RW.n + ' of ' + RW.tried);
    const lip = Oc[Oc.length - 1];
    check('the lip comes down at the bead\'s far side, (15, 40), pointing down', Math.abs(lip[0] - 15) < 1e-4 && Math.abs(lip[1] - 40) < 1e-4, lip.map(f3).join(', '));
    check('no self-touch: mesh_validate finds no piercing pair, and the bead clears the tube by the roll radius',
      C.MV.pierce === 0 && r.clearance.closest.g > 0.4, 'closest ' + f3(r.clearance.closest.g) + ' mm (zone-weighted)');
    row('Stock tube Ø20/1.6, roll 180° r 2.5', tube, r, ms, 'bead (' + f3(fo.c[0]) + ', ' + f3(fo.c[1]) + '), wall ' + f3(W.lo) + '–' + f3(W.hi));
  }
}

console.log('\n=== 5. Roll 270° and on toward the tube ===');
{
  const r = NSO_tubeEdgeRaw(tube, { verb: 'roll', radius: 2.5, angle: 270 });
  const C = common('roll 270', tube, r, 1.6);
  if (C) {
    const G = graph(r.tris);
    const Oc = meridianChain(G, [10, 0], 0, [0, 1]), Ic = meridianChain(G, [8.4, 0], 0, [0, 1]);
    const W = chainWall(Oc, Ic);
    check('roll 270° r 2.5: wall held, 2.5 mm clear of the tube', W.lo >= 1.58 && W.hi <= 1.62 && C.MV.pierce === 0, f3(W.lo) + '–' + f3(W.hi));
    row('Stock tube Ø20/1.6, roll 270° r 2.5', tube, r, 0, 'wall ' + f3(W.lo) + '–' + f3(W.hi));
  }
  const r2 = NSO_tubeEdgeRaw(tube, { verb: 'roll', radius: 2.5, angle: 330 });
  console.log('   330°: ' + r2.reason);
  check('roll 330° r 2.5 is refused before it touches the tube, naming the most it can roll', !r2.ok && /would (run the new wall into|bring the new wall within [\d.]+ mm of) the piece/.test(r2.reason) &&
        r2.maxAngleDeg >= 290 && r2.maxAngleDeg <= 305 && r2.tris === tube, r2.maxAngleDeg + '°');
  const r3 = NSO_tubeEdgeRaw(tube, { verb: 'roll', radius: 2.5, angle: r2.maxAngleDeg });
  check('...and that angle rolls', r3.ok, r3.reason);
}

console.log('\n=== 6. refusals, the piece unchanged ===');
{
  const thin = stockTube(10, 0.8, 40);
  const r = NSO_tubeEdgeRaw(thin, { verb: 'roll', radius: 1, angle: 270 });
  console.log('   ' + r.reason);
  check('roll 270° r 1 on a 0.8 mm wall: refused by the thin-wall rule, stated', !r.ok && r.tris === thin &&
        /too thin to roll/.test(r.reason) && /2 nozzle widths \(0\.80 mm at a 0\.4 mm nozzle\)/.test(r.reason) &&
        /The rule: wall × \(ring radius ÷ largest radius\)/.test(r.reason));
  const ri = NSO_tubeEdgeRaw(tube, { verb: 'flare', length: 8, angle: -60 });
  console.log('   ' + ri.reason);
  check('an inward flare that would close the bore is refused, naming the bore limit (Ø0.80, 2 nozzle widths)', !ri.ok && ri.tris === tube &&
        /that flare would close the bore - the Ø16\.80 bore would come to nothing at the lip, under the bore limit of Ø0\.80 \(2 nozzle widths at a 0\.4 mm nozzle\)/.test(ri.reason), ri.reason);
  const rr = NSO_tubeEdgeRaw(tube, { verb: 'roll', radius: 2, angle: 180, direction: 'in' });
  check('an inward roll is refused: not supported yet', !rr.ok && /inward roll is not supported yet/.test(rr.reason), rr.reason);
  const bx = box(0, 0, 0, 30, 20, 10);
  const rb = NSO_tubeEdgeRaw(bx, { verb: 'flare', length: 5, angle: 20 });
  console.log('   ' + rb.reason);
  check('a closed box is refused: its end is closed', !rb.ok && /that end is closed - a flat 4-sided face with no opening/.test(rb.reason) && rb.tris === bx);
  const rd = rod(6, 30);
  const rr2 = NSO_tubeEdgeRaw(rd, { verb: 'roll', radius: 2, angle: 180 });
  check('a solid rod is refused: its end is closed, by its size', !rr2.ok && /that end is closed - a flat Ø12\.00 face with no opening/.test(rr2.reason), rr2.reason);
  const sq = squareTube(30);
  const rs = NSO_tubeEdgeRaw(sq, { verb: 'flare', length: 5, angle: 20 });
  check('a square tube is refused: its end is not circular', !rs.ok && /that end is not circular - its outline is a 4-sided polygon and its bore a 4-sided polygon/.test(rs.reason), rs.reason);
  const rl = NSO_tubeEdgeRaw(tube, { verb: 'flare', length: 0.5, angle: 70 });
  check('a flare too short to turn the wall\'s inside face is refused by name', !rl.ok && /too short to turn a 1\.60 mm wall/.test(rl.reason), rl.reason);
  const rf = NSO_tubeEdgeRaw(tube, { verb: 'flare', length: 2, angle: 80 });
  check('a flare past 75° is refused', !rf.ok && /past the 75° limit/.test(rf.reason), rf.reason);
  const rz = NSO_tubeEdgeRaw(tube, { verb: 'roll', radius: 2, angle: 400 });
  check('a roll past 360° is refused', !rz.ok && /at most 360°/.test(rz.reason), rz.reason);
}

console.log('\n=== 7. a thrown vessel (the Wheel), an Extend-made pipe, an imported tube along X ===');
{
  const V = wheelVessel();
  const rd = NSO_tubeEdgeRead(V.soup);
  console.log('   ' + rd.reason + (rd.ok ? ' · lean ' + rd.end.leanDeg.toFixed(2) + '° · rim at z ' + f3(rd.end.center[2]) : ''));
  check('Wheel vessel: the rim read as the open end', rd.ok && rd.end.axis[2] === 1);
  for (const [name, o] of [['Wheel vessel, flare 6 mm 25° straight', { verb: 'flare', length: 6, angle: 25, profile: 'straight' }],
                           ['Wheel vessel, flare 6 mm 25° trumpet', { verb: 'flare', length: 6, angle: 25, profile: 'trumpet' }],
                           ['Wheel vessel, roll 180° r 2', { verb: 'roll', radius: 2, angle: 180 }]]) {
    const t0 = Date.now(), r = NSO_tubeEdgeRaw(V.soup, o), ms = Date.now() - t0;
    console.log('   ' + r.reason);
    const C = common(name, V.soup, r, rd.end && rd.end.wallMm);
    if (C) {
      check(name + ': wall held within 0.02 on the construction', Math.abs(r.wall.minMm - r.wallMm) <= 0.02 && Math.abs(r.wall.maxMm - r.wallMm) <= 0.02,
        f3(r.wall.minMm) + '–' + f3(r.wall.maxMm) + ' vs ' + f3(r.wallMm));
      const G = graph(r.tris), cz = rd.end.center[2];
      const RW = rayWall(G, cz, 0, 0, 30, o.verb === 'flare' ? cz + o.length - r.wallMm : null);
      check(name + ': wall held in 3D', RW.lo >= r.wallMm - 0.02 && RW.hi <= r.wallMm + 0.02 && RW.n > 0, f3(RW.lo) + '–' + f3(RW.hi) + ' from ' + RW.n);
      row(name, V.soup, r, ms, 'wall ' + f3(r.wallMm) + ' (' + f3(RW.lo) + '–' + f3(RW.hi) + ')');
    }
  }
  const ext = NSO_extendRaw(tube, { length: 60 });
  check('Extend makes the Stock tube 60 mm long', ext.ok, ext.reason);
  if (ext.ok) {
    const r = NSO_tubeEdgeRaw(ext.tris, { verb: 'roll', radius: 2, angle: 180 });
    common('Extend-made pipe, roll 180° r 2', ext.tris, r, 1.6);
    if (r.ok) row('Extend-made pipe (60 mm), roll 180° r 2', ext.tris, r, 0, 'wall ' + f3(r.wall.minMm) + '–' + f3(r.wall.maxMm));
  }
  const tx = tubeAlongX(80, 48);
  const rx = NSO_tubeEdgeRaw(tx, { verb: 'flare', length: 6, angle: 20, point: [80, 20, 18] });
  const C = common('imported tube along X, flare at its far end', tx, rx, 2);
  if (C) {
    check('...the end along +X read and flared', rx.end.axis[0] === 1 && Math.abs(rx.end.center[0] - 80) < 1e-9 && Math.abs(rx.lipOuterRadiusMm - (8 + 6 * Math.tan(20 * Math.PI / 180))) < 0.05,
      'lip r ' + f3(rx.lipOuterRadiusMm));
    row('imported Ø16/Ø12 48-gon along X, flare 6 mm 20°', tx, rx, 0, 'wall ' + f3(rx.wall.minMm) + '–' + f3(rx.wall.maxMm));
  }
}

console.log('\n=== 8. Walls and inward (tube-walls) ===');
{
  const crypto = require('crypto');
  const sha = r => r.ok ? crypto.createHash('sha1').update(Buffer.from(r.tris.buffer, r.tris.byteOffset, r.tris.byteLength)).digest('hex') : 'refused';
  // Both is today's behaviour: these are the output buffers' SHA-1s from
  // claude-wip b0697c1, before Walls existed
  const PINNED = [
    ['flare 8 mm 20° straight', { verb: 'flare', length: 8, angle: 20 }, '459a83756387c5538a39bb81a205dad6d8cf807f'],
    ['flare 8 mm Δr 3 trumpet', { verb: 'flare', length: 8, dr: 3, profile: 'trumpet' }, '66185547b118ce2ebcaff4146c4da4b63ccb7af8'],
    ['roll 180° r 2', { verb: 'roll', radius: 2, angle: 180 }, '546d8a9c38f72d6078f3ac026589a09756c43cd1']];
  for (const [name, o, want] of PINNED) {
    const a = NSO_tubeEdgeRaw(tube, o), b = NSO_tubeEdgeRaw(tube, Object.assign({ walls: 'both' }, o));
    check('Both is byte-identical to today: ' + name + ' (pinned SHA-1, and walls: \'both\' the same as no Walls)', sha(a) === want && sha(b) === want, sha(a));
  }

  // inward, both faces: Δr −4 over 10, Straight and Trumpet, on the Stock tube
  for (const prof of ['straight', 'trumpet']) {
    const tag = 'inward flare −4 over 10, ' + prof;
    const t0 = Date.now(), r = NSO_tubeEdgeRaw(tube, { verb: 'flare', length: 10, dr: -4, profile: prof }), ms = Date.now() - t0;
    console.log('   ' + r.reason);
    if (!common(tag, tube, r, 1.6)) continue;
    const G = graph(r.tris);
    let lo = Infinity, hi = -Infinity, zTop = -Infinity;
    G.P.forEach(p => { if (p && Math.abs(p[2] - 50) < 1e-4) { const q = Math.hypot(p[0], p[1]); lo = Math.min(lo, q); hi = Math.max(hi, q); } if (p) zTop = Math.max(zTop, p[2]); });
    check(tag + ': the lip 10 mm out, its bore radius 4 smaller (8.40 → 4.40 ± 0.05), its outside inside the tube\'s', Math.abs(zTop - 50) < 1e-4 &&
          Math.abs(lo - 4.4) <= 0.05 && hi < 10 - 4 + 1.6, 'lip bore r ' + f3(lo) + ', outside r ' + f3(hi));
    const Oc = meridianChain(G, [10, 0], 0, [0, 1]), Ic = meridianChain(G, [8.4, 0], 0, [0, 1]);
    const W = chainWall(Oc, Ic);
    check(tag + ': wall 1.6 ± 0.02 held through the turn (meridian walked out of the mesh)', W.lo >= 1.58 && W.hi <= 1.62 && W.n >= 4,
      f3(W.lo) + '–' + f3(W.hi) + ' over ' + W.n + ' points');
    const RW = rayWall(G, 40, 0, 0, 30, 50 - 1.6);
    check(tag + ': ...and in 3D', RW.lo >= 1.58 && RW.hi <= 1.62 && RW.n >= RW.tried * 0.5, f3(RW.lo) + '–' + f3(RW.hi) + ' from ' + RW.n + ' of ' + RW.tried);
    check(tag + ': the lip square to the wall at u = L (every lip vertex at z 50)', [...G.P.values()].filter(p => p && p[2] > 50 + 1e-4).length === 0);
    row('Stock tube Ø20/1.6, inward flare −4 over 10, ' + prof, tube, r, ms, 'lip bore r ' + f3(lo) + ', wall ' + f3(W.lo) + '–' + f3(W.hi));
  }
  const wayIn = NSO_tubeEdgeRaw(tube, { verb: 'flare', length: 8, angle: 20, direction: 'in' }), neg = NSO_tubeEdgeRaw(tube, { verb: 'flare', length: 8, angle: -20 });
  check('Way In is the same as a negative angle, byte for byte', wayIn.ok && neg.ok && sha(wayIn) === sha(neg), wayIn.reason);

  // one face: a Ø40.62 / Ø30.47 pipe (wall 5.08)
  const pipe = stockTube(20.31, 5.076, 40);
  const faceSet = (s, sign) => {
    const S = new Set();
    for (let t = 0; t < s.length / 9; t++) {
      const fn = faceNormal(s, t), o = t * 9, cx = (s[o] + s[o + 3] + s[o + 6]) / 3, cy = (s[o + 1] + s[o + 4] + s[o + 7]) / 3, L = Math.hypot(cx, cy);
      if ((fn.n[0] * cx + fn.n[1] * cy) / L * sign > 0.5) S.add(Array.from(s.subarray(o, o + 9)).join(','));
    }
    return S;
  };
  const sameFace = (a, b, sign) => { const A = faceSet(a, sign); let n = 0; for (const k of A) if (faceSet(b, sign).has(k)) n++; return { kept: n, of: A.size }; };
  const radiiAtZ = (s, z) => { let lo = Infinity, hi = -Infinity; for (let i = 0; i < s.length; i += 3) if (Math.abs(s[i + 2] - z) < 1e-4) { const q = Math.hypot(s[i], s[i + 1]); lo = Math.min(lo, q); hi = Math.max(hi, q); } return { lo, hi }; };
  for (const [walls, dr, prof] of [['bore', 3, 'straight'], ['bore', 3, 'trumpet'], ['outside', -3, 'straight'], ['bore', -3, 'trumpet'], ['outside', 3, 'trumpet']]) {
    const tag = (walls === 'bore' ? 'Bore only ' : 'Outside only ') + (dr > 0 ? '+' : '−') + Math.abs(dr) + ' flare over 10, ' + prof;
    const r = NSO_tubeEdgeRaw(pipe, { verb: 'flare', length: 10, dr, profile: prof, walls });
    console.log('   ' + r.reason);
    if (!common(tag, pipe, r)) continue;
    const bore = walls === 'bore', thin = bore ? dr > 0 : dr < 0, tl = bore ? 5.076 - dr : 5.076 + dr;
    const kept = sameFace(pipe, r.tris, bore ? 1 : -1);
    check(tag + ': the ' + (bore ? 'outside' : 'bore') + ' untouched - every one of its triangles in the output, bit for bit', kept.kept === kept.of, kept.kept + ' of ' + kept.of);
    const lip = radiiAtZ(r.tris, 50);
    const mv = bore ? lip.lo : lip.hi, kp = bore ? lip.hi : lip.lo;
    check(tag + ': at the lip the ' + walls + ' stands ' + dr + ' off its line (r ' + f3((bore ? 15.234 : 20.31) + dr) + ') and the other face runs on at its own radius',
      Math.abs(mv - ((bore ? 15.234 : 20.31) + dr)) <= 0.05 && Math.abs(kp - (bore ? 20.31 : 15.234)) <= 1e-4, 'moved r ' + f3(mv) + ', kept r ' + f3(kp));
    check(tag + ': the wall runs from 5.08 at the ring to ' + f3(tl) + ' at the lip, never under the lesser', Math.abs(r.wall.lipMm - tl) < 1e-4 &&
          r.wall.minMm >= Math.min(5.076, tl) - 0.02 && r.wall.maxMm <= Math.max(5.076, tl) + 0.02 && Math.abs((mv - kp) * (bore ? -1 : 1) - tl) <= 0.05,
      f3(r.wall.minMm) + '–' + f3(r.wall.maxMm) + ' (thinning: ' + thin + ')');
    const want = (bore ? 'Bore only: Ø30.47 → Ø' : 'Outside only: Ø40.62 → Ø') + (2 * ((bore ? 15.234 : 20.31) + dr)).toFixed(2) + ' at the lip, ' +
      (bore ? 'outside kept Ø40.62' : 'bore kept Ø30.47') + ', wall 5.08 → ' + tl.toFixed(2);
    check(tag + ': the readout names the walls: "' + want + '"', r.reason.indexOf(want) === 0, r.reason);
    row('Ø40.62/Ø30.47 pipe, ' + tag, pipe, r, 0, 'lip moved r ' + f3(mv) + ', wall ' + f3(r.wall.minMm) + '–' + f3(r.wall.maxMm));
  }
  const rfl = NSO_tubeEdgeRaw(pipe, { verb: 'flare', length: 10, dr: 4.8, walls: 'bore' });
  console.log('   ' + rfl.reason);
  check('Bore only +4.8 refused under the floor, with the numbers: "bore +4.80 mm would leave a 0.28 mm wall at the lip; the floor is 0.42 mm"', !rfl.ok && rfl.tris === pipe &&
        /^bore \+4\.80 mm would leave a 0\.28 mm wall at the lip; the floor is 0\.42 mm \(nso_thickness\.js: one extrusion line at a 0\.4 mm nozzle\)\. This wall lets its bore move out by 4\.65 mm at most$/.test(rfl.reason), rfl.reason);
  const rcx = NSO_tubeEdgeRaw(pipe, { verb: 'flare', length: 10, dr: -6, walls: 'outside' });
  check('Outside only −6 refused: the faces would cross', !rcx.ok && rcx.tris === pipe && /^outside −6\.00 mm would carry the outside through the other face of a 5\.08 mm wall - the faces would cross/.test(rcx.reason), rcx.reason);
  const rw = NSO_tubeEdgeRaw(pipe, { verb: 'flare', length: 10, dr: 3, walls: 'middle' });
  check('an unknown Walls is refused in words', !rw.ok && /Walls is Both, Outside only or Bore only/.test(rw.reason), rw.reason);
  const rr = NSO_tubeEdgeRaw(tube, { verb: 'roll', radius: 2, angle: 180, direction: 'in' });
  check('an inward roll is still refused: not supported yet', !rr.ok && /inward roll is not supported yet/.test(rr.reason), rr.reason);
}

console.log('\n=== 9. Run: the reducer and the expander (tube-run) ===');
{
  const crypto = require('crypto');
  const sha = r => r.ok ? crypto.createHash('sha1').update(Buffer.from(r.tris.buffer, r.tris.byteOffset, r.tris.byteLength)).digest('hex') : 'refused';
  const pipe = stockTube(20.31, 5.076, 40);
  // Run 0 is today's Flare: section 8's SHA-1s from b0697c1, and four more
  // from claude-wip 695808a (inward and one-face, which b0697c1 did not have)
  const PINNED = [
    ['flare 8 mm 20° straight', tube, { verb: 'flare', length: 8, angle: 20 }, '459a83756387c5538a39bb81a205dad6d8cf807f'],
    ['flare 8 mm Δr 3 trumpet', tube, { verb: 'flare', length: 8, dr: 3, profile: 'trumpet' }, '66185547b118ce2ebcaff4146c4da4b63ccb7af8'],
    ['roll 180° r 2', tube, { verb: 'roll', radius: 2, angle: 180 }, '546d8a9c38f72d6078f3ac026589a09756c43cd1'],
    ['inward −4 over 10 straight', tube, { verb: 'flare', length: 10, dr: -4 }, 'fed95faa32b65a522e5ea43f8b3aa147a3e86654'],
    ['inward −4 over 10 trumpet', tube, { verb: 'flare', length: 10, dr: -4, profile: 'trumpet' }, '4af342585be350f2db1bfe8ae1c4878d7346d463'],
    ['bore only +3 over 10', pipe, { verb: 'flare', length: 10, dr: 3, walls: 'bore' }, 'aefe2a958a38a1e3fd3e5188202273612a392caa'],
    ['outside only +3 over 10 trumpet', pipe, { verb: 'flare', length: 10, dr: 3, walls: 'outside', profile: 'trumpet' }, '2caf953a1f82fe504d3ae671b30ed9b468e8957a']];
  for (const [name, s, o, want] of PINNED) {
    const got = [undefined, 0, '', null].map(run => sha(NSO_tubeEdgeRaw(s, Object.assign({}, o, run === undefined ? {} : { runMm: run }))));
    check('Run 0 is byte-identical to the pinned hash: ' + name + ' (no runMm, 0, \'\' and null)', got.every(h => h === want), got[1]);
  }

  /* The run, read off the output: every triangle wholly at or past the lip's
     plane (zLip) is the end face (all three corners at zEnd), or a piece of
     one of two cylinders about the axis - its three corners at one radius
     within 0.02, the outside facing out and the bore in. Anything else there
     ('other'), or a flat face left on the lip's plane, is not a run. */
  function runRead(s, zLip, zEnd) {
    const O = { lo: Infinity, hi: -Infinity, n: 0 }, I = { lo: Infinity, hi: -Infinity, n: 0 };
    let ends = 0, lipFlat = 0, other = 0, offStation = 0;
    for (let t = 0; t < s.length / 9; t++) {
      const o = t * 9, z = [s[o + 2], s[o + 5], s[o + 8]];
      if (Math.min(...z) < zLip - 1e-4) continue;
      if (z.every(q => Math.abs(q - zEnd) < 1e-4)) { ends++; continue; }
      if (z.every(q => Math.abs(q - zLip) < 1e-4)) { lipFlat++; continue; }
      if (!z.every(q => Math.abs(q - zLip) < 1e-4 || Math.abs(q - zEnd) < 1e-4)) offStation++;
      const r = [0, 1, 2].map(k => Math.hypot(s[o + k * 3], s[o + k * 3 + 1]));
      if (Math.max(...r) - Math.min(...r) > 0.02) { other++; continue; }
      const fn = faceNormal(s, t), cx = (s[o] + s[o + 3] + s[o + 6]) / 3, cy = (s[o + 1] + s[o + 4] + s[o + 7]) / 3;
      const C = (fn.n[0] * cx + fn.n[1] * cy) > 0 ? O : I;
      C.n++; for (const q of r) { C.lo = Math.min(C.lo, q); C.hi = Math.max(C.hi, q); }
    }
    return { O, I, ends, lipFlat, other, offStation };
  }
  // the run's end ring is the lip ring carried straight up: the same x and y
  // bits at zEnd as at zLip, vertex for vertex
  function straightUp(s, zLip, zEnd) {
    const at = z => { const S = new Set(); for (let i = 0; i < s.length; i += 3) if (Math.abs(s[i + 2] - z) < 1e-4) S.add(s[i] + ',' + s[i + 1]); return S; };
    const A = at(zLip), B = at(zEnd);
    let same = 0; for (const k of A) if (B.has(k)) same++;
    return { lip: A.size, end: B.size, same };
  }
  const dia = x => 'Ø' + (2 * x).toFixed(3);

  // THE REDUCER: a Ø40 / wall 2.54 tube (bore Ø34.92), Flare In −10 over 15, Run 30
  const t40 = stockTube(20, 2.54, 40);
  const lipW = 2.54 / Math.cos(Math.atan2(10, 15));          // the lip's width, cut square to the axis
  for (const [tag, o] of [['reducer: Ø40 tube, Flare In −10 over 15, Run 30', { verb: 'flare', length: 15, dr: -10, runMm: 30 }],
                          ['expander: Ø40 tube, Flare Out +10 over 15, Run 20', { verb: 'flare', length: 15, dr: 10, runMm: 20 }]]) {
    const t0 = Date.now(), r = NSO_tubeEdgeRaw(t40, o), ms = Date.now() - t0;
    console.log('   ' + r.reason);
    if (!common(tag, t40, r)) continue;
    const red = o.dr < 0, zLip = 55, zEnd = 55 + o.runMm;
    const R = runRead(r.tris, zLip, zEnd);
    // the reducer's bore and the expander's outside stand exactly Δr off the
    // tube's; the other face is the lip's width away
    const wantI = red ? 7.46 : 30 - lipW, wantO = red ? 7.46 + lipW : 30;
    check(tag + ': the last ' + o.runMm + ' mm reads as one cylinder - every face there is the run\'s outside, its bore or its end, and no flat face is left on the lip\'s plane',
      R.other === 0 && R.offStation === 0 && R.lipFlat === 0 && R.O.n === 2 * 96 && R.I.n === 2 * 96 && R.ends > 0,
      `outside ${R.O.n}, bore ${R.I.n}, end ${R.ends}, other ${R.other}, lip-plane flats ${R.lipFlat}`);
    check(tag + ': outside ' + dia(wantO) + ' / bore ' + dia(wantI) + ' within 0.02, all the way along' + (red ? ' (bore Ø14.92, the ticket\'s)' : ' (outside Ø60, the ticket\'s)'),
      Math.abs(R.O.lo - wantO) <= 0.01 && Math.abs(R.O.hi - wantO) <= 0.01 && Math.abs(R.I.lo - wantI) <= 0.01 && Math.abs(R.I.hi - wantI) <= 0.01,
      dia(R.O.lo) + '–' + dia(R.O.hi) + ' / ' + dia(R.I.lo) + '–' + dia(R.I.hi));
    check(tag + ': the run\'s wall is the lip\'s width, ' + f3(lipW) + ' (2.54 / cos ' + (Math.atan2(10, 15) * 180 / Math.PI).toFixed(1) + '°)',
      Math.abs((R.O.lo - R.I.hi) - lipW) <= 0.02 && Math.abs(r.run.wallMm - lipW) <= 1e-4, f3(R.O.lo - R.I.hi));
    const U = straightUp(r.tris, zLip, zEnd);
    check(tag + ': no step - the run\'s end ring is the lip ring carried straight up, x and y bit for bit', U.lip === 192 && U.end === 192 && U.same === 192, JSON.stringify(U));
    let top = -Infinity; for (let i = 2; i < r.tris.length; i += 3) top = Math.max(top, r.tris[i]);
    check(tag + ': the end cut square to the axis, ' + o.runMm + ' mm past the lip (z ' + zEnd + ')', Math.abs(top - zEnd) < 1e-4, f3(top));
    check(tag + ': the flare\'s wall is held, 2.54 ± 0.02 (on the construction)', r.wall.minMm >= 2.52 && r.wall.maxMm <= 2.56, f3(r.wall.minMm) + '–' + f3(r.wall.maxMm));
    const G = graph(r.tris), RW = rayWall(G, 40, 0, 0, 30, zLip - 2.54);
    check(tag + ': ...and in 3D through the flare', RW.lo >= 2.52 && RW.hi <= 2.56 && RW.n > 0, f3(RW.lo) + '–' + f3(RW.hi) + ' from ' + RW.n + ' of ' + RW.tried);
    const want = 'Straight flare 15.0 mm at ' + (red ? '−33.7° inward' : '33.7° outward') + ', then ' + o.runMm.toFixed(1) + ' mm run at Ø' + (2 * wantO).toFixed(2) +
      ' / bore Ø' + (2 * wantI).toFixed(2) + ' · wall 2.54 held';
    check(tag + ': the readout: "' + want + ' …"', r.reason.indexOf(want) === 0, r.reason);
    row('Ø40/2.54 tube, ' + (red ? 'reducer In −10 over 15, run 30' : 'expander Out +10 over 15, run 20'), t40, r, ms,
      'run ' + dia(R.O.lo) + ' / ' + dia(R.I.lo) + ', wall ' + f3(R.O.lo - R.I.hi));
    if (red) {
      const wi = NSO_tubeEdgeRaw(t40, Object.assign({}, o, { dr: 10, direction: 'in' }));
      check(tag + ': Way In with Δr +10 is the same, byte for byte', sha(wi) === sha(r));
    }
  }

  // the ticket's readout line, character for character, on the tube it describes
  const t51 = stockTube(25.577, 2.54, 40);
  const rt = NSO_tubeEdgeRaw(t51, { verb: 'flare', length: 21, angle: -36, runMm: 30 });
  console.log('   ' + rt.reason);
  common('Ø51.15/2.54 tube, Flare −36° over 21, Run 30', t51, rt);
  check('the ticket\'s readout: "Straight flare 21.0 mm at −36.0° inward, then 30.0 mm run at Ø21.84 / bore Ø15.56 · wall 2.54 held"',
    rt.reason.indexOf('Straight flare 21.0 mm at −36.0° inward, then 30.0 mm run at Ø21.84 / bore Ø15.56 · wall 2.54 held') === 0, rt.reason);

  // TRUMPET + RUN: the run is parallel to the axis, and meets the trumpet's
  // lip at its lip angle
  {
    const t0 = Date.now(), r = NSO_tubeEdgeRaw(tube, { verb: 'flare', length: 8, angle: 30, profile: 'trumpet', runMm: 10 }), ms = Date.now() - t0;
    console.log('   ' + r.reason);
    if (common('trumpet 8 mm 30°, run 10', tube, r)) {
      const R = runRead(r.tris, 48, 58), U = straightUp(r.tris, 48, 58);
      check('trumpet + run: the last 10 mm is one cylinder at the lip\'s outside and bore, parallel to the axis', R.other === 0 && R.offStation === 0 && R.lipFlat === 0 &&
        Math.abs(R.O.lo - r.lipOuterRadiusMm) <= 1e-4 && Math.abs(R.O.hi - r.lipOuterRadiusMm) <= 1e-4 && U.same === U.lip && U.lip === 192,
        dia(R.O.lo) + ' / ' + dia(R.I.lo));
      // the outside face's last chord into the lip, off the mesh (the walk
      // stops at the lip: the join turns more than its 35°), within one
      // station's turn of the trumpet's lip angle; then the mesh's own edge
      // from that lip vertex up the run
      const G = graph(r.tris), Oc = meridianChain(G, [10, 0], 0, [0, 1]);
      const k = Oc.length - 1, a = Oc[k - 1], b = Oc[k];
      const lipId = [...G.P.keys()].find(id => G.P[id] && Math.abs(G.P[id][1]) < 1e-6 && G.P[id][0] === b[0] && G.P[id][2] === b[1]);
      const upId = lipId == null ? null : [...G.nb[lipId]].find(q => Math.abs(G.P[q][2] - 58) < 1e-4 && Math.abs(G.P[q][1]) < 1e-6);
      const c = upId == null ? b : [G.P[upId][0], G.P[upId][2]];
      const chord = Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI, up = upId == null ? NaN : Math.atan2(c[0] - b[0], c[1] - b[1]) * 180 / Math.PI;
      check('trumpet + run: the outside face\'s walk ends at the lip, z 48', Math.abs(b[1] - 48) < 1e-4, f3(b[1]));
      check('trumpet + run: the join is the trumpet\'s lip angle - its last chord ' + f3(chord) + '°, then the run straight up (0°)',
        k > 0 && up === 0 && chord <= r.lipAngleDeg + 1e-9 && chord > r.lipAngleDeg - 10, f3(chord) + '° then ' + f3(up) + '°');
      check('trumpet + run: the readout says so - "joined at 49.1°, the trumpet\'s lip angle (the run is parallel to the axis)"',
        /^Trumpet flare 8\.0 mm at 30\.0° outward, then 10\.0 mm run at Ø29\.24 \/ bore Ø[\d.]+ · wall 1\.60 held/.test(r.reason) &&
        r.reason.indexOf('joined at 49.1°, the trumpet\'s lip angle (the run is parallel to the axis)') > 0, r.reason);
      row('Stock tube Ø20/1.6, trumpet 8 mm 30°, run 10', tube, r, ms, 'run ' + dia(R.O.lo) + ' / ' + dia(R.I.lo) + ', joined at ' + f3(r.lipAngleDeg) + '°');
    }
  }

  // WALLS + RUN: one face moved; the other runs on, unmoved, through the run
  for (const [walls, dr, prof] of [['bore', 3, 'straight'], ['outside', -3, 'trumpet']]) {
    const bore = walls === 'bore', tag = (bore ? 'Bore only +3' : 'Outside only −3') + ' over 10, ' + prof + ', run 20';
    const r = NSO_tubeEdgeRaw(pipe, { verb: 'flare', length: 10, dr, profile: prof, walls, runMm: 20 });
    console.log('   ' + r.reason);
    if (!common(tag, pipe, r)) continue;
    const R = runRead(r.tris, 50, 70);
    // the kept face, every vertex of it from the pipe's foot to the run's end
    let lo = Infinity, hi = -Infinity;
    for (let t = 0; t < r.tris.length / 9; t++) {
      const fn = faceNormal(r.tris, t), o = t * 9, cx = (r.tris[o] + r.tris[o + 3] + r.tris[o + 6]) / 3, cy = (r.tris[o + 1] + r.tris[o + 4] + r.tris[o + 7]) / 3;
      if (Math.abs(fn.n[2]) > 1e-6 || ((fn.n[0] * cx + fn.n[1] * cy) > 0) !== bore) continue;
      for (let k = 0; k < 3; k++) { const q = Math.hypot(r.tris[o + k * 3], r.tris[o + k * 3 + 1]); lo = Math.min(lo, q); hi = Math.max(hi, q); }
    }
    const kept = bore ? 20.31 : 15.234, moved = kept + (bore ? -(5.076 - dr) : (5.076 + dr));
    check(tag + ': the ' + (bore ? 'outside' : 'bore') + ' keeps its Ø' + (2 * kept).toFixed(2) + ' through the run - every vertex of it, the pipe\'s foot to the run\'s end',
      Math.abs(lo - kept) <= 1e-4 && Math.abs(hi - kept) <= 1e-4, dia(lo) + '–' + dia(hi));
    const M = bore ? R.I : R.O;
    check(tag + ': the run is one cylinder, its ' + (bore ? 'bore' : 'outside') + ' at the lip\'s Ø' + (2 * moved).toFixed(2) + ' - the changed wall, 2.08, kept',
      R.other === 0 && R.offStation === 0 && R.lipFlat === 0 && Math.abs(M.lo - moved) <= 0.01 && Math.abs(M.hi - moved) <= 0.01 &&
      Math.abs(r.run.wallMm - 2.076) <= 1e-3, dia(M.lo) + '–' + dia(M.hi) + ', wall ' + f3(r.run.wallMm));
    check(tag + ': the readout carries the run: ", then 20.0 mm run at Ø' + (2 * Math.max(kept, moved)).toFixed(2) + ' / bore Ø' + (2 * Math.min(kept, moved)).toFixed(2) + ', wall 2.08"',
      r.reason.indexOf(', then 20.0 mm run at Ø' + (2 * Math.max(kept, moved)).toFixed(2) + ' / bore Ø' + (2 * Math.min(kept, moved)).toFixed(2) + ', wall 2.08') > 0 &&
      r.reason.indexOf(bore ? 'Bore only: Ø30.47 → Ø36.47 at the lip, outside kept Ø40.62, wall 5.08 → 2.08' : 'Outside only: Ø40.62 → Ø34.62 at the lip, bore kept Ø30.47, wall 5.08 → 2.08') === 0, r.reason);
    row('Ø40.62/Ø30.47 pipe, ' + tag, pipe, r, 0, 'run ' + dia(R.O.lo) + ' / ' + dia(R.I.lo));
  }

  // a leaning rim (the Wheel vessel, −0.47°): the run is parallel to the
  // axis, not to the rim, and its end square to the axis
  {
    const V = wheelVessel();
    const r = NSO_tubeEdgeRaw(V.soup, { verb: 'flare', length: 6, angle: 25, runMm: 8 });
    console.log('   ' + r.reason);
    if (common('Wheel vessel, flare 6 mm 25°, run 8', V.soup, r)) {
      const zE = r.end.center[2] + r.run.endH;
      let n = 0, off = 0; for (let i = 2; i < r.tris.length; i += 3) if (r.tris[i] > zE - 1e-3) { n++; if (Math.abs(r.tris[i] - zE) > 1e-4) off++; }
      const Om = r.meridian.outer, Im = r.meridian.inner;
      check('Wheel vessel + run: the run parallel to the axis (both faces at one radius along it), the end cut square to the axis',
        n > 0 && off === 0 && Om[Om.length - 1][0] === Om[Om.length - 2][0] && Im[Im.length - 1][0] === Im[Im.length - 2][0] &&
        Math.abs(Math.max(Om[Om.length - 2][1], Im[Im.length - 2][1]) + 8 - r.run.endH) < 1e-12, n + ' end vertices at z ' + f3(zE));
    }
  }
  // an imported tube along X: the run along +X
  {
    const tx = tubeAlongX(80, 48);
    const r = NSO_tubeEdgeRaw(tx, { verb: 'flare', length: 6, angle: 20, point: [80, 20, 18], runMm: 12 });
    if (common('imported tube along X, flare + run 12 at its far end', tx, r)) {
      let top = -Infinity; for (let i = 0; i < r.tris.length; i += 3) top = Math.max(top, r.tris[i]);
      check('...the run along +X, its end at x 98 (80 + 6 + 12)', Math.abs(top - 98) < 1e-4, f3(top));
    }
  }

  // refusals, before building, the piece unchanged
  const rr = NSO_tubeEdgeRaw(tube, { verb: 'roll', radius: 2, angle: 180, runMm: 10 });
  console.log('   ' + rr.reason);
  check('Roll + Run is refused in words: Roll has no lip direction to run along', !rr.ok && rr.tris === tube &&
    rr.reason === 'a 10.0 mm run is refused on a Roll - a Roll has no lip direction to run along (the wall curls round its bead and stops where the Angle ends). Run is a Flare\'s: set it to 0 to roll', rr.reason);
  check('...a Roll with Run 0 rolls as before', NSO_tubeEdgeRaw(tube, { verb: 'roll', radius: 2, angle: 180, runMm: 0 }).ok);
  const rb = NSO_tubeEdgeRaw(tube, { verb: 'flare', length: 8, dr: -8.1, runMm: 30 });
  console.log('   ' + rb.reason);
  check('a run whose bore would be under 2 nozzle widths is refused before building, naming the run', !rb.ok && rb.tris === tube && !rb.counts &&
    /^that flare would close the bore - the Ø16\.80 bore would come to Ø0\.60 at the lip and down its 30\.0 mm run, under the bore limit of Ø0\.80 \(2 nozzle widths at a 0\.4 mm nozzle\)/.test(rb.reason), rb.reason);
  // a plate floating 20 mm over the tube's end (its own shell): a run into it
  // is refused by the clearance, a run that stops short of it is not
  const roofed = new Float32Array([...tube, ...box(-30, -30, 60, 30, 30, 62)]);
  const rc = NSO_tubeEdgeRaw(roofed, { verb: 'flare', length: 8, angle: 20, runMm: 30 });
  console.log('   ' + rc.reason);
  check('a run into the piece is refused by the clearance, naming the run', !rc.ok && rc.tris === roofed &&
    /^that flare and its run would (run the new wall into|bring the new wall within [\d.]+ mm of) the piece \(20\.0 mm out from the end, [\d.]+ mm from the axis\) - it may come no closer than 0\.40 mm \(one nozzle width\)\. Use a shorter run, or a shorter or shallower flare$/.test(rc.reason), rc.reason);
  const rc2 = NSO_tubeEdgeRaw(roofed, { verb: 'flare', length: 8, angle: 20, runMm: 10 });
  check('...and a run stopping 2 mm under it is built', rc2.ok && rc2.counts.trisOut > 0, rc2.reason);
  const rn = NSO_tubeEdgeRaw(tube, { verb: 'flare', length: 8, dr: 3, runMm: -2 });
  check('a negative run is refused in words', !rn.ok && rn.tris === tube && /enter a run length in mm, 0 or more/.test(rn.reason), rn.reason);
}

console.log('\n=== 10. time ===');
{
  const big = NSO_Stock.revolve(NSO_Stock.profileTube(30, 28, 120), 2000);
  const t0 = Date.now(), r = NSO_tubeEdgeRaw(big, { verb: 'roll', radius: 3, angle: 180 }), ms = Date.now() - t0;
  check('a 2000-sided tube (' + big.length / 9 + ' triangles) rolls 180° in under 5 s', r.ok && ms < 5000, ms + ' ms · ' + (r.ok ? r.tris.length / 9 + ' out' : r.reason));
  if (r.ok) row('2000-sided Ø60/2 tube, roll 180° r 3', big, r, ms, '');
}

console.log('\n| piece and treatment | in → out triangles | ms | measured |');
console.log('|---|---|---|---|');
for (const t of TABLE) console.log('| ' + t.name + ' | ' + t.trisIn + ' → ' + t.trisOut + ' | ' + (t.ms === '0' ? '' : t.ms) + ' | ' + t.extra + ' |');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('FAILED: ' + FAILS.join(' | ')); process.exit(1); }
