#!/usr/bin/env node
// Headless self-test for nso_close.js (ADD -> Close: a lid across an open end).
//
//   node tools/nso_close_test.js        exit 0 = every gate held
//
// Loads the shipped files with vm, in index.html's order. The tube is Stock's
// own (NSO_Stock.revolve of its tube meridian); the open box, the tube along X,
// the frame and the holed sphere are built here. The open box the pick was
// built for is library/box_closed.stl cut open by the real Cut (splitBothSides,
// as tools/nso_cut_bore_test.js drives it). Every number is measured on the OUTPUT
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

// The real Cut, in its own context (it needs Three.js, as nso_cut_bore_test.js loads it).
const THREE = require(path.join(ROOT, 'node_modules', 'three', 'build', 'three.cjs'));
const cutCtx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Float32Array, Float64Array,
  Int32Array, Uint32Array, Uint8Array, ArrayBuffer, Error, Infinity, NaN, THREE
};
cutCtx.window = cutCtx;
vm.createContext(cutCtx);
vm.runInContext('var state = {}; var document = { readyState: "complete", getElementById: function () { return null; },' +
  ' addEventListener: function () {} };', cutCtx);
for (const f of ['app-cut.js', 'app-extend.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), cutCtx, { filename: f });
}
const { splitBothSides } = cutCtx;

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

// A frame: a plate 80 x 60 x 3 with a 60 x 40 window through it. A through-opening.
const frame = () => prismTube([[0, 0], [80, 0], [80, 60], [0, 60]], [[10, 10], [70, 10], [70, 50], [10, 50]], 3);

// A closed cube, x y z from lo to hi.
function cube(lo, hi) {
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi, t = [];
  const quad = (a, b, c, d) => { t.push(a, b, c, a, c, d); };
  quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]);
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]);
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  return new Float32Array(t.flat());
}
const concat = parts => {
  const o = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0; parts.forEach(p => { o.set(p, at); at += p.length; });
  return o;
};

// Every vertex at height z moved by up to +-amp in z, the same for every triangle that uses it.
function jitterRim(soup, z, amp) {
  const out = new Float32Array(soup);
  for (let i = 0; i < out.length; i += 3) {
    if (out[i + 2] !== z) continue;
    const h = Math.sin(out[i] * 12.9898 + out[i + 1] * 78.233) * 43758.5453;
    out[i + 2] = Math.fround(z + amp * (2 * (h - Math.floor(h)) - 1));
  }
  return out;
}

// library/box_closed.stl cut open the way Cut does it: a piece built the way
// addModelFromZUpGeometry builds one, split on display Y. The half below the
// plane is a 60 x 40 tray with 2 mm walls, open at the cut.
function readSTL(file) {
  const b = fs.readFileSync(file), n = b.readUInt32LE(80), o = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) o[t * 9 + k] = b.readFloatLE(84 + t * 50 + 12 + k * 4);
  return o;
}
function cutOpenBox() {
  const raw = readSTL(path.join(ROOT, 'library', 'box_closed.stl'));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(raw), 3));
  g.rotateX(-Math.PI / 2);
  g.computeBoundingBox();
  const bb = g.boundingBox, off = { x: (bb.min.x + bb.max.x) / 2, y: (bb.min.y + bb.max.y) / 2, z: (bb.min.z + bb.max.z) / 2 };
  g.center();
  const piece = { geometry: g, rawTris: raw, rawAxis: 'zup', centerOffset: off };
  const pair = splitBothSides(piece, 'y', 0.123, 0.123);
  return { tray: pair.rawA, other: pair.rawB, raw };
}

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
  check('box: the bottom is refused, saying what was read', !bottom.ok &&
    /^flat face, 1 loop, no hole - the nearest open end is 24\.\d\d mm from the click, more than its 18\.00 mm wall$/.test(bottom.reason), bottom.reason);
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


console.log('\nThe three clicks that find an opening: the rim, the inner wall, the outer wall');
const sameBits = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
{
  // ---- the open box Close was built for, cut open by the real Cut
  const { tray, other } = cutOpenBox();
  const top = Math.max(...Array.from(tray).filter((_, i) => i % 3 === 2));
  check('fixture: Cut left box_closed a tray, closed and manifold but for its cut', topo(other).open === 0 && topo(tray).open === 0 && topo(tray).nm === 0,
    'tray open ' + topo(tray).open + ', rim at z ' + top);
  const picks = {
    rim: { point: [30, 1, top], via: 'rim' },
    'inner wall': { point: [30, 2, top - 5], via: 'inner wall' },
    'outer wall': { point: [30, 0, top - 5], via: 'outer wall' }
  };
  const lids = {};
  for (const [name, pk] of Object.entries(picks)) {
    const rd = NSO_closeRead(tray, { point: pk.point });
    check('cut box, ' + name + ': an open end, 56 × 36, wall 2.00', rd.ok && rd.rim.shape.kind === 'rectangular' && Math.abs(rd.rim.wallMm - 2) < 1e-4, rd.reason);
    check('cut box, ' + name + ': read as ' + pk.via + ', one rim face of ' + (rd.ok ? rd.rim.faceTris : '?') + ' triangles', rd.ok && rd.rim.via === pk.via && rd.rim.faceTris === 32,
      rd.ok ? rd.rim.via : '');
    check('cut box, ' + name + ': the wall runs 11.77 mm to the floor', rd.ok && rd.rim.depthKind === 'floor' && Math.abs(rd.rim.depthMm - (top - 2)) < 1e-4 && !rd.rim.through,
      rd.ok ? rd.rim.depthKind + ' ' + f3(rd.rim.depthMm) : '');
    const r = NSO_closeRaw(tray, { point: pk.point });
    check('cut box, ' + name + ': the lid is built', r.ok, r.reason);
    lids[name] = r;
  }
  if (lids.rim.ok && lids['inner wall'].ok && lids['outer wall'].ok) {
    check('cut box: all three clicks build the same lid, bit for bit',
      sameBits(lids.rim.tris, lids['inner wall'].tris) && sameBits(lids.rim.tris, lids['outer wall'].tris),
      lids.rim.tris.length / 9 + ' triangles');
    gateSolid('cut box', tray, lids['inner wall']);
    const rel = (volume(lids['inner wall'].tris) - volume(tray) - 56 * 36 * 2) / (56 * 36 * 2);
    check('cut box: the lid adds 56 × 36 × 2 mm³', Math.abs(rel) < 1e-4, (rel * 100).toFixed(5) + ' %');
    const H = rayHits(lids['inner wall'].tris, 2, 29.7, 19.3).map(h => h.at);
    check('cut box: a ray down the box crosses the floor, then the lid at ' + f3(top - 2) + ' and ' + f3(top), H.length === 4 &&
      Math.abs(H[2] - (top - 2)) < 1e-3 && Math.abs(H[3] - top) < 1e-4, H.map(f3).join(', '));
  }
  // The lower part of the outside wall is farther from the rim than the wall is tall.
  const low = NSO_closeRead(tray, { point: [30, 0, 0.5] });
  check('cut box: the outer wall below the floor is out of reach', !low.ok && /more than its 11\.77 mm wall/.test(low.reason), low.reason);
  const floorClick = NSO_closeRead(tray, { point: [30, 20, 2] });
  check('cut box: the floor is out of reach', !floorClick.ok && /^flat face, 1 loop, no hole/.test(floorClick.reason), floorClick.reason);

  // ---- the same on a Stock tube: any click on it finds the nearer end, and builds that end's lid
  const base = NSO_closeRaw(tube, tubePick);
  for (const [name, point, via] of [['inner wall', [8.4, 0, 27.5], 'inner wall'], ['outer wall', [10, 0, 27.5], 'outer wall']]) {
    const r = NSO_closeRaw(tube, { point });
    check('tube, ' + name + ' 2.5 mm under the rim: built, the same lid as the rim click, bit for bit', r.ok && base.ok && sameBits(r.tris, base.tris) &&
      r.rim.via === via, r.reason);
  }
  const lowEnd = NSO_closeRead(tube, { point: [10, 0, 2] });
  check('tube, outer wall 2 mm above the bottom end: the bottom end', lowEnd.ok && lowEnd.rim.normal[2] < -0.99 && lowEnd.rim.via === 'outer wall',
    lowEnd.ok ? 'normal ' + lowEnd.rim.normal.map(f3).join(',') : lowEnd.reason);

  // ---- the walk stays on the shell the click is on
  const pair = concat([tube, cube([12, -5, 20], [22, 5, 30])]);
  const onCube = NSO_closeRead(pair, { point: [12, 0, 25] });
  check('a second shell beside the tube is not walked to (it has no open end)', !onCube.ok &&
    /^flat face, 1 loop, no hole - this piece has no open end within reach/.test(onCube.reason), onCube.reason);
  const cubeAlone = NSO_closeRead(cube([0, 0, 0], [10, 10, 10]), { point: [5, 5, 10] });
  check('a closed cube is refused, saying what was read', !cubeAlone.ok &&
    /^flat face, 1 loop, no hole - this piece has no open end within reach/.test(cubeAlone.reason), cubeAlone.reason);
}

console.log('\nA frame (80 x 60 x 3, window 60 x 40 through it) - a through-opening');
{
  const fr = frame();
  const T = topo(fr);
  check('fixture: the frame is closed and manifold, Euler 0', T.open === 0 && T.nm === 0 && T.flip === 0 && T.euler === 0, 'Euler ' + T.euler);
  const rd = NSO_closeRead(fr, { point: [5, 30, 3] });
  check('read: a through-opening, 3.00 deep; the rim is 10 wide but the lid is capped at 3.00', rd.ok && rd.rim.through && rd.rim.depthKind === 'through' &&
    Math.abs(rd.rim.depthMm - 3) < 1e-4 && Math.abs(rd.rim.rimMm - 10) < 1e-4 && Math.abs(rd.rim.wallMm - 3) < 1e-4,
    rd.ok ? 'depth ' + f3(rd.rim.depthMm) + ', rim ' + f3(rd.rim.rimMm) + ', lid ' + f3(rd.rim.wallMm) : rd.reason);
  const want = volume(fr) + 60 * 40 * 3;
  for (const [name, point] of [['top rim', [5, 30, 3]], ['inner wall, nearer the top', [10, 30, 2.4]], ['outer wall, nearer the top', [0, 30, 2.5]],
                               ['inner wall, nearer the bottom', [10, 30, 0.6]]]) {
    const r = NSO_closeRaw(fr, { point });
    check('frame, ' + name + ': built', r.ok, r.reason);
    if (!r.ok) continue;
    const Tg = topo(r.tris);
    check('frame, ' + name + ': a panel the frame\'s depth, flush both sides (60·40·3 mm³, closed, Euler 2)', Math.abs(r.lid.thickness - 3) < 1e-4 &&
      Math.abs((volume(r.tris) - want) / want) < 1e-5 && Tg.open === 0 && Tg.nm === 0 && Tg.flip === 0 && Tg.degen === 0 && Tg.euler === 2,
      'thick ' + f3(r.lid.thickness) + ', ' + f3(volume(r.tris)) + ' vs ' + f3(want) + ', Euler ' + Tg.euler);
    const H = rayHits(r.tris, 2, 33.3, 21.7).map(h => h.at);
    check('frame, ' + name + ': a ray through the window crosses the panel at z 0 and 3', H.length === 2 && Math.abs(H[0]) < 1e-4 && Math.abs(H[1] - 3) < 1e-4, H.map(f3).join(', '));
    if (name === 'top rim') {
      const MV = meshValidate('frame-panel', r.tris);
      check('frame: mesh_validate --gate PASS', MV.pass, MV.pass ? '' : (MV.fails || []).join('; '));
    }
  }
  const deep = NSO_closeRaw(fr, { point: [5, 30, 3], thickness: 8 });
  check('frame: a lid of 8 is deeper than the wall of 3 - refused, in words', !deep.ok &&
    deep.reason === 'opening found but the lid (8.00 mm) is deeper than the wall (3.00 mm, down to the far side)', deep.reason);
  const part = NSO_closeRaw(fr, { point: [5, 30, 3], thickness: 2 });
  check('frame: a lid of 2 sits in the top and leaves the window open below it', part.ok && topo(part.tris).open === 0, part.reason);
  const sunk = NSO_closeRaw(fr, { point: [5, 30, 3], inset: 2 });
  check('frame: the 3 mm lid sunk 2 mm reaches 5 - refused, in words', !sunk.ok &&
    /^opening found but the lid \(3\.00 mm at 2\.00 mm inset, reaching 5\.00 mm\) is deeper than the wall \(3\.00 mm, down to the far side\)$/.test(sunk.reason), sunk.reason);
}

console.log('\nA lid deeper than the wall, in words');
{
  const shallow = openBox(40, 30, 5, 1.6, 2);
  const rd = NSO_closeRead(shallow, { point: [20, 0.8, 5] });
  check('shallow tray: a floor 3.00 down; not a through-opening, so the lid is the rim\'s 1.60', rd.ok && rd.rim.depthKind === 'floor' && !rd.rim.through &&
    Math.abs(rd.rim.depthMm - 3) < 1e-4 && Math.abs(rd.rim.wallMm - 1.6) < 1e-4, rd.ok ? rd.rim.depthKind + ' ' + f3(rd.rim.depthMm) : rd.reason);
  const r = NSO_closeRaw(shallow, { point: [20, 0.8, 5], thickness: 8 });
  check('shallow tray: a lid of 8 is deeper than the wall of 3', !r.ok &&
    r.reason === 'opening found but the lid (8.00 mm) is deeper than the wall (3.00 mm, down to a floor)', r.reason);
  const r2 = NSO_closeRaw(box, { point: [20, 0.8, 20], thickness: 10, inset: 9 });
  check('open box: 10 mm sunk 9 reaches 19 - past the floor at 18', !r2.ok &&
    r2.reason === 'opening found but the lid (10.00 mm at 9.00 mm inset, reaching 19.00 mm) is deeper than the wall (18.00 mm, down to a floor)', r2.reason);
}

console.log('\nThe plane tolerance scales with the piece');
{
  // Float noise on a rim. A skinny rim triangle's plane magnifies it along the rim's
  // length, so 5e-5 mm on a 600 mm rim is several 1e-3 mm off the seed's plane.
  const bigClean = openBox(600, 400, 200, 8, 4), big = jitterRim(bigClean, 200, 5e-5);
  const pk = { point: [300, 8, 150] };
  const rb = NSO_closeRead(big, pk);
  check('600 × 400 × 200, rim 5e-5 mm off its plane: one face (tolerance 1e-5 × 750 = 7.5e-3 mm), the opening found from the inner wall',
    rb.ok && rb.rim.faceTris === 8 && rb.rim.via === 'inner wall', rb.ok ? rb.rim.faceTris + ' triangles, ' + rb.reason : rb.reason);
  const clean = NSO_closeRead(bigClean, pk);
  check('... the same opening the clean rim reads', clean.ok && rb.ok && clean.rim.shape.text === rb.rim.shape.text && clean.rim.faceTris === rb.rim.faceTris, clean.reason);
  ctx.NSO_CL_PLANE_REL = 0;                  // the fixed 1e-3 mm it used to be
  const old = NSO_closeRead(new Float32Array(big), pk);
  ctx.NSO_CL_PLANE_REL = 1e-5;
  check('... which the fixed 1e-3 mm read as no rim at all (the regression this scales away)', !old.ok, old.reason);
  const small = jitterRim(openBox(40, 30, 20, 1.6, 2), 20, 3e-3);
  const rs = NSO_closeRead(small, { point: [20, 1.6, 15] });
  check('40 × 30 × 20, rim 3e-3 mm off its plane: still not one face (the 1e-3 mm floor holds on a small piece)', !rs.ok, rs.reason);
}

console.log('\nRefusals');
{
  const thin = NSO_closeRaw(tube, Object.assign({ thickness: 0.6 }, tubePick));
  check('a lid under 2 nozzle widths is refused', !thin.ok && /2 nozzle widths/.test(thin.reason), thin.reason);
  const ok2 = NSO_closeRaw(tube, Object.assign({ thickness: 0.8 }, tubePick));
  check('a lid of exactly 2 nozzle widths is built', ok2.ok, ok2.reason);
  const side = NSO_closeRead(tube, { point: [10, 0, 15] });
  check('the outside wall half way along is as near one end as the other - refused, saying so', !side.ok &&
    /^flat face, 1 loop, no hole - 2 open ends are 15\.00 mm from the click, as near as each other/.test(side.reason), side.reason);
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
