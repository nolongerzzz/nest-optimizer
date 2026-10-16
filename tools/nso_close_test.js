#!/usr/bin/env node
// Headless self-test for nso_close.js (ADD -> Close: a lid across an open end).
//
//   node tools/nso_close_test.js        exit 0 = every gate held
//
// Loads the shipped files with vm, in index.html's order. The tube is Stock's
// own (NSO_Stock.revolve of its tube meridian); the open box, the tube along X
// and the holed sphere are built here. Every number is measured on the OUTPUT
// soup by code that shares nothing with the lid's construction:
//   - the topology is welded on exact float32 keys by a counter written here;
//   - the volume is the divergence sum, here;
//   - where the lid's top and underside are: a ray down the opening, the
//     heights it crosses the output's faces at;
//   - the outside unchanged: every input triangle off the opening's wall is in
//     the output, bit for bit;
//   - tools/mesh_validate.py --gate runs on every output.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { writeSTL } = require('./nso_stl_io.js');

const ctx = {
  Math, Map, Set, WeakMap, console, Array, Object, Number, String, JSON, isFinite, Date,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Int8Array, ArrayBuffer, Error, Infinity, NaN
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['nso_thickness.js', 'nso_stock.js', 'nso_section.js', 'nso_tube_edge.js', 'nso_close.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { NSO_closeRaw, NSO_closeRead, NSO_Stock } = ctx;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-close-'));
const f3 = x => (+x).toFixed(3);
const TABLE = [];

/* ------------------------------------------------------------------ fixtures */

// Stock's tube: Z up, the axis at x = y = 0, the open ends at z = 0 and z = h.
const stockTube = (rOut, wall, h, seg) => NSO_Stock.revolve(NSO_Stock.profileTube(rOut, rOut - wall, h), seg || 96);

// An open box (a tray): outer X x Y x H, walls w, floor f, open at the top z = H.
// Two triangles per rectangle; each wall face split at the floor's height so
// the inside and outside meet the floor on shared edges.
function openBox(X, Y, H, w, f) {
  const t = [];
  const quad = (a, b, c, d) => { t.push(a, b, c, a, c, d); };   // a b c d counter-clockwise seen from outside
  const x0 = 0, x1 = X, y0 = 0, y1 = Y, i0 = w, i1 = X - w, j0 = w, j1 = Y - w;
  // bottom (facing -z)
  quad([x0, y0, 0], [x0, y1, 0], [x1, y1, 0], [x1, y0, 0]);
  // outside walls
  quad([x0, y0, 0], [x1, y0, 0], [x1, y0, H], [x0, y0, H]);
  quad([x1, y0, 0], [x1, y1, 0], [x1, y1, H], [x1, y0, H]);
  quad([x1, y1, 0], [x0, y1, 0], [x0, y1, H], [x1, y1, H]);
  quad([x0, y1, 0], [x0, y0, 0], [x0, y0, H], [x0, y1, H]);
  // rim (facing +z): four trapezoids between the outer and the inner rectangle
  quad([x0, y0, H], [x1, y0, H], [i1, j0, H], [i0, j0, H]);
  quad([x1, y0, H], [x1, y1, H], [i1, j1, H], [i1, j0, H]);
  quad([x1, y1, H], [x0, y1, H], [i0, j1, H], [i1, j1, H]);
  quad([x0, y1, H], [x0, y0, H], [i0, j0, H], [i0, j1, H]);
  // inside walls (facing the middle), from the rim down to the floor
  quad([i0, j0, H], [i1, j0, H], [i1, j0, f], [i0, j0, f]);
  quad([i1, j0, H], [i1, j1, H], [i1, j1, f], [i1, j0, f]);
  quad([i1, j1, H], [i0, j1, H], [i0, j1, f], [i1, j1, f]);
  quad([i0, j1, H], [i0, j0, H], [i0, j0, f], [i0, j1, f]);
  // the floor inside (facing +z)
  quad([i0, j0, f], [i1, j0, f], [i1, j1, f], [i0, j1, f]);
  return new Float32Array(t.flat());
}

// An imported-style tube along X: 48 sides, Ø16 / Ø12, its own winding.
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

// A tube of any section: the outer loop and the inner one (same count,
// counter-clockwise, each inner point radially inside its outer one) extruded
// 0..h, open at both ends.
function prismTube(O, I, h) {
  const n = O.length, t = [];
  const tri = (a, b, c) => t.push(a, b, c);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, o0 = O[i], o1 = O[j], i0 = I[i], i1 = I[j];
    tri([o0[0], o0[1], 0], [o1[0], o1[1], 0], [o1[0], o1[1], h]); tri([o0[0], o0[1], 0], [o1[0], o1[1], h], [o0[0], o0[1], h]);
    tri([i1[0], i1[1], 0], [i0[0], i0[1], 0], [i0[0], i0[1], h]); tri([i1[0], i1[1], 0], [i0[0], i0[1], h], [i1[0], i1[1], h]);
    tri([o0[0], o0[1], h], [o1[0], o1[1], h], [i1[0], i1[1], h]); tri([o0[0], o0[1], h], [i1[0], i1[1], h], [i0[0], i0[1], h]);
    tri([o0[0], o0[1], 0], [i1[0], i1[1], 0], [o1[0], o1[1], 0]); tri([o0[0], o0[1], 0], [i0[0], i0[1], 0], [i1[0], i1[1], 0]);
  }
  return new Float32Array(t.flat());
}
const star = (k, ro, ri, s) => Array.from({ length: 2 * k }, (_, i) => {
  const a = Math.PI * i / k, r = (i % 2 ? ri : ro) * s; return [30 + r * Math.cos(a), 30 + r * Math.sin(a)];
});

// A sphere (Stock's revolve of its own meridian) with a hole in its top:
// every triangle with a corner above z = 0.85 a taken out.
function holedSphere(a) {
  const s = NSO_Stock.revolve(NSO_Stock.profileSphere(a, 48), 64), keep = [];
  for (let o = 0; o < s.length; o += 9) {
    if (Math.max(s[o + 2], s[o + 5], s[o + 8]) > 1.85 * a) continue;   // the sphere sits on z = 0: its top is z = 2a
    for (let k = 0; k < 9; k++) keep.push(s[o + k]);
  }
  return new Float32Array(keep);
}

/* ------------------------------------------------------------- measuring */

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
  return { tris: vid.length / 3, verts: ids.size, open, nm, flip, degen, euler: ids.size - E.size + vid.length / 3 };
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
  return { pass: r.verdict === 'PASS', fails: r.verdict_fails };
}
// Where a line along axis k through (u, v) in the other two crosses the soup:
// the sorted coordinates along k, each with the sign of the face's normal on k.
function rayHits(s, k, u, v) {
  const o = [0, 1, 2].filter(a => a !== k), hits = [];
  for (let q = 0; q < s.length; q += 9) {
    const A = [s[q], s[q + 1], s[q + 2]], B = [s[q + 3], s[q + 4], s[q + 5]], C = [s[q + 6], s[q + 7], s[q + 8]];
    const ax = A[o[0]] - u, ay = A[o[1]] - v, bx = B[o[0]] - u, by = B[o[1]] - v, cx = C[o[0]] - u, cy = C[o[1]] - v;
    const w0 = bx * cy - by * cx, w1 = cx * ay - cy * ax, w2 = ax * by - ay * bx;
    if (!((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0))) continue;
    const W = w0 + w1 + w2;
    if (W === 0) continue;
    hits.push({ at: (w0 * A[k] + w1 * B[k] + w2 * C[k]) / W, sign: Math.sign(W) });
  }
  return hits.sort((a, b) => a.at - b.at);
}
// The input's triangles that are not in the output, bit for bit.
function missing(inp, out, keepIf) {
  const key = (s, o) => Array.from(s.subarray(o, o + 9)).join(',');
  const have = new Set();
  for (let o = 0; o < out.length; o += 9) have.add(key(out, o));
  let miss = 0, asked = 0;
  for (let o = 0; o < inp.length; o += 9) {
    if (!keepIf(inp, o)) continue;
    asked++;
    if (!have.has(key(inp, o))) miss++;
  }
  return { miss, asked };
}
function gateSolid(tag, inp, r) {
  const T = topo(r.tris);
  check(tag + ': closed and manifold (own counter)', T.open === 0 && T.nm === 0 && T.flip === 0 && T.degen === 0,
    'open ' + T.open + ', non-manifold ' + T.nm + ', flipped ' + T.flip + ', degenerate ' + T.degen + ', Euler ' + T.euler);
  // A lid closes one opening: a tube (Euler 0) becomes a cup (2); an open box
  // (2) becomes a closed box round a sealed hollow, two shells (4).
  const Ti = topo(inp);
  check(tag + ': Euler ' + Ti.euler + ' -> ' + (Ti.euler + 2) + ' (one opening closed)', T.euler === Ti.euler + 2, 'out ' + T.euler);
  const MV = meshValidate(tag.replace(/[^a-z0-9]+/gi, '-'), r.tris);
  check(tag + ': mesh_validate --gate PASS', MV.pass, MV.pass ? '' : (MV.fails || []).join('; '));
  return T;
}

/* ------------------------------------------------------------------ tests */

console.log('\nStock tube Ø20, wall 1.6, 30 long - click the top rim');
const tube = stockTube(10, 1.6, 30);
const tubePick = { point: [9.2, 0, 30] };
{
  const rd = NSO_closeRead(tube, tubePick);
  check('read: an open end', rd.ok, rd.reason);
  check('read: the wall is 1.60 mm', rd.ok && Math.abs(rd.rim.wallMm - 1.6) < 0.005, rd.ok ? f3(rd.rim.wallMm) : '');
  check('read: a round opening Ø16.80', rd.ok && rd.rim.shape.kind === 'round' && Math.abs(rd.rim.shape.dia - 16.8) < 0.02, rd.ok ? rd.rim.shape.text : '');

  const t0 = Date.now(), r = NSO_closeRaw(tube, tubePick), ms = Date.now() - t0;
  check('flush lid: built', r.ok, r.reason);
  if (r.ok) {
    check('flush lid: 1.60 thick (the wall, prefilled)', Math.abs(r.lid.thickness - 1.6) < 0.005, f3(r.lid.thickness));
    gateSolid('tube flush', tube, r);
    const vT = volume(tube), vO = volume(r.tris), want = vT + Math.PI * 8.4 * 8.4 * 1.6;
    const rel = (vO - want) / want;
    check('flush lid: volume = tube + π·8.4²·1.6 within 0.5 %', Math.abs(rel) < 0.005,
      f3(vO) + ' vs ' + f3(want) + ' mm³ (' + (rel * 100).toFixed(3) + ' %)');
    const H = rayHits(r.tris, 2, 0.31, 0.17).map(h => h.at);
    check('flush lid: the ray down the bore crosses the lid only, at z 28.4 and 30', H.length === 2 &&
      Math.abs(H[0] - 28.4) < 1e-3 && Math.abs(H[1] - 30) < 1e-4, H.map(f3).join(', '));
    const M = missing(tube, r.tris, (s, o) => Math.max(Math.hypot(s[o], s[o + 1]), Math.hypot(s[o + 3], s[o + 4]), Math.hypot(s[o + 6], s[o + 7])) > 8.41);
    check('flush lid: the outside unchanged (every face off the bore, bit for bit)', M.miss === 0, M.asked - M.miss + ' / ' + M.asked);
    TABLE.push(['tube Ø20/1.6 flush', r.counts.trisIn, r.counts.trisOut, f3(r.lid.volume), ms]);
  }
}

console.log('\nThe same tube, Inset 2');
{
  const t0 = Date.now(), r = NSO_closeRaw(tube, Object.assign({ inset: 2 }, tubePick)), ms = Date.now() - t0;
  check('inset 2: built', r.ok, r.reason);
  if (r.ok) {
    gateSolid('tube inset 2', tube, r);
    const H = rayHits(r.tris, 2, 0.31, 0.17).map(h => h.at);
    check('inset 2: the lid top is 2 mm below the rim (z 28), its underside at 26.4', H.length === 2 &&
      Math.abs(H[0] - 26.4) < 1e-3 && Math.abs(H[1] - 28) < 1e-3, H.map(f3).join(', '));
    const want = volume(tube) + Math.PI * 8.4 * 8.4 * 1.6, rel = (volume(r.tris) - want) / want;
    check('inset 2: volume = tube + π·8.4²·1.6 within 0.5 %', Math.abs(rel) < 0.005, (rel * 100).toFixed(3) + ' %');
    const M = missing(tube, r.tris, (s, o) => Math.max(Math.hypot(s[o], s[o + 1]), Math.hypot(s[o + 3], s[o + 4]), Math.hypot(s[o + 6], s[o + 7])) > 8.41);
    check('inset 2: the outside unchanged', M.miss === 0, M.asked - M.miss + ' / ' + M.asked);
    TABLE.push(['tube Ø20/1.6 inset 2', r.counts.trisIn, r.counts.trisOut, f3(r.lid.volume), ms]);
  }
}

console.log('\nThe ray test above, on itself: an empty bore crosses nothing between the ends');
{
  const H = rayHits(tube, 2, 0.31, 0.17);
  check('ray: the input tube has no face across its bore', H.length === 0, H.length + ' hit(s)');
}

console.log('\nOpen box 40 × 30 × 20, wall 1.6, floor 2 - click the rim');
const box = openBox(40, 30, 20, 1.6, 2);
{
  const T = topo(box);
  check('fixture: the open box is closed and manifold', T.open === 0 && T.nm === 0 && T.flip === 0, JSON.stringify(T).slice(0, 80));
  const pick = { point: [20, 0.8, 20] };
  const rd = NSO_closeRead(box, pick);
  check('read: an open end, rectangular', rd.ok && rd.rim.shape.kind === 'rectangular', rd.reason);
  check('read: the wall is 1.60 mm', rd.ok && Math.abs(rd.rim.wallMm - 1.6) < 1e-4, rd.ok ? f3(rd.rim.wallMm) : '');
  const t0 = Date.now(), r = NSO_closeRaw(box, pick), ms = Date.now() - t0;
  check('box lid: built', r.ok, r.reason);
  if (r.ok) {
    gateSolid('box flush', box, r);
    const want = volume(box) + 36.8 * 26.8 * 1.6, rel = (volume(r.tris) - want) / want;
    check('box lid: volume = box + 36.8·26.8·1.6', Math.abs(rel) < 1e-5, (rel * 100).toFixed(5) + ' %');
    const H = rayHits(r.tris, 2, 13.3, 9.1).map(h => h.at);
    check('box lid: a ray down the box crosses 0, 2, 18.4 and 20', H.length === 4 &&
      Math.abs(H[1] - 2) < 1e-4 && Math.abs(H[2] - 18.4) < 1e-3 && Math.abs(H[3] - 20) < 1e-4, H.map(f3).join(', '));
    const M = missing(box, r.tris, (s, o) => {
      for (let k = 0; k < 9; k += 3) { const x = s[o + k], y = s[o + k + 1]; if (x < 1.59 || x > 38.41 || y < 1.59 || y > 28.41) return true; }
      return false;
    });
    check('box lid: the outside and the rim unchanged', M.miss === 0, M.asked - M.miss + ' / ' + M.asked);
    TABLE.push(['open box 40×30×20', r.counts.trisIn, r.counts.trisOut, f3(r.lid.volume), ms]);
  }
  const rIn = NSO_closeRaw(box, Object.assign({ inset: 3 }, pick));
  check('box, inset 3: built and closed', rIn.ok && topo(rIn.tris).open === 0, rIn.reason);
  if (rIn.ok) {
    const H = rayHits(rIn.tris, 2, 13.3, 9.1).map(h => h.at);
    check('box, inset 3: the lid top at z 17', H.length === 4 && Math.abs(H[3] - 17) < 1e-3 && Math.abs(H[2] - 15.4) < 1e-3, H.map(f3).join(', '));
  }
  const deep = NSO_closeRaw(box, Object.assign({ thickness: 10, inset: 9 }, pick));
  check('box: a lid reaching the floor is refused', !deep.ok && /floor/.test(deep.reason), deep.reason);
  const bottom = NSO_closeRead(box, { point: [20, 15, 0] });
  check('box: the bottom has no opening - refused in words', !bottom.ok && /no opening/.test(bottom.reason), bottom.reason);
}

console.log('\nAn imported tube along X (Ø16 / Ø12, 48 sides) - click the far end');
{
  const tx = tubeAlongX(40, 48);
  const pick = { point: [40, 20, 17] };
  const r = NSO_closeRaw(tx, pick);
  check('tube along X: built', r.ok, r.reason);
  if (r.ok) {
    check('tube along X: the lid is the 2.00 mm wall', Math.abs(r.lid.thickness - 2) < 0.02, f3(r.lid.thickness));
    gateSolid('tube along X', tx, r);
    const H = rayHits(r.tris, 0, 20.2, 10.1).map(h => h.at);
    check('tube along X: the lid spans x 38 to 40', H.length === 2 && Math.abs(H[0] - 38) < 0.03 && Math.abs(H[1] - 40) < 1e-4, H.map(f3).join(', '));
    const poly = 48 / 2 * 36 * Math.sin(2 * Math.PI / 48);
    check('tube along X: the lid is the 48-gon\'s area × the wall', Math.abs(r.lid.volume - poly * r.lid.thickness) < 1e-3 * poly, f3(r.lid.volume) + ' vs ' + f3(poly * r.lid.thickness));
  }
}

console.log('\nA five-point star tube (a non-convex rim), 25 long - click the rim');
{
  const O = star(5, 14, 7, 1), I = star(5, 14, 7, 0.8), st = prismTube(O, I, 25);
  const T0 = topo(st);
  check('fixture: the star tube is closed and manifold', T0.open === 0 && T0.nm === 0 && T0.flip === 0, 'Euler ' + T0.euler);
  const pick = { point: [(O[0][0] + I[0][0]) / 2, (O[0][1] + I[0][1]) / 2, 25] };
  const r = NSO_closeRaw(st, Object.assign({ thickness: 2 }, pick));
  check('star: built', r.ok, r.reason);
  if (r.ok) {
    gateSolid('star tube', st, r);
    let A = 0; for (let i = 0; i < I.length; i++) { const p = I[i], q = I[(i + 1) % I.length]; A += (p[0] * q[1] - q[0] * p[1]) / 2; }
    check('star: the lid is the star\'s area × 2', Math.abs(r.lid.volume - A * 2) < 1e-4 * A, f3(r.lid.volume) + ' vs ' + f3(A * 2));
    const H = rayHits(r.tris, 2, 30.2, 30.1).map(h => h.at);
    check('star: the lid spans z 23 to 25 at the middle', H.length === 2 && Math.abs(H[0] - 23) < 1e-3 && Math.abs(H[1] - 25) < 1e-4, H.map(f3).join(', '));
    const tip = rayHits(r.tris, 2, I[0][0] - 0.3, I[0][1]).map(h => h.at);
    check('star: and out in a point of the star', tip.length === 2 && Math.abs(tip[0] - 23) < 1e-3, tip.map(f3).join(', '));
    TABLE.push(['star tube', r.counts.trisIn, r.counts.trisOut, f3(r.lid.volume), '']);
  }
}

console.log('\nRefusals');
{
  const thin = NSO_closeRaw(tube, Object.assign({ thickness: 0.6 }, tubePick));
  check('a lid under 2 nozzle widths is refused', !thin.ok && /2 nozzle widths/.test(thin.reason), thin.reason);
  const ok2 = NSO_closeRaw(tube, Object.assign({ thickness: 0.8 }, tubePick));
  check('a lid of exactly 2 nozzle widths is built', ok2.ok, ok2.reason);
  const side = NSO_closeRead(tube, { point: [10, 0, 15] });
  check('the outside wall is not an open end', !side.ok && /no opening/.test(side.reason), side.reason);
  const neg = NSO_closeRaw(tube, Object.assign({ inset: -1 }, tubePick));
  check('a negative inset is refused', !neg.ok, neg.reason);

  const sph = holedSphere(10);
  check('fixture: the holed sphere has open edges', topo(sph).open > 0, topo(sph).open + ' open');
  // a click on the sphere beside the hole
  let near = null;
  for (let o = 0; o < sph.length; o += 9) if (Math.max(sph[o + 2], sph[o + 5], sph[o + 8]) > 18.2) { near = [sph[o], sph[o + 1], sph[o + 2]]; break; }
  const h = NSO_closeRaw(sph, { point: near });
  check('a hole in a sphere is refused, naming Patch', !h.ok && h.reason === "that edge isn't an open end — Patch repairs holes", h.reason);
  const hFar = NSO_closeRaw(sph, { point: [0, 0, 0] });
  check('the same sphere clicked far from the hole names Patch too', !hFar.ok && /Patch repairs holes/.test(hFar.reason), hFar.reason);
}

console.log('\n  case                    tris in  tris out  lid mm³    ms');
TABLE.forEach(r => console.log('  ' + r[0].padEnd(22) + String(r[1]).padStart(9) + String(r[2]).padStart(10) + String(r[3]).padStart(10) + String(r[4]).padStart(6)));
console.log('\n' + pass + ' passed, ' + fail + ' failed' + (fail ? ': ' + FAILS.join('; ') : ''));
process.exit(fail ? 1 : 0);
