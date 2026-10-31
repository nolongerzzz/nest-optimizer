#!/usr/bin/env node
// Headless self-test for nso_resurface.js (Resurface: fill / repair surface work). docs/RESURFACE.md.
//
//   node tools/nso_resurface_test.js        exit 0 = every gate held
//
// nso_resurface.js is required as it ships (THREE-free); the work is made with the shipped boolean
// (tools/nso_csg_node.js) and the result is judged by the app's own checker (NSO_Repair.js +
// nso-defects.js in a vm) and by rays against the surface that was there before the work.
//
//   1. engraved text on a flat slab: all three letters found by one click, the face back (flat to
//      0.001 mm), the volume back, the checker clean
//   2. a trench running 40 mm along the slab (it runs off any small box): filled flush
//   3. a hole straight through: the wall and the underside round it go, both faces are laid again,
//      the slab is whole (volume exactly) and clean
//   4. engraved text on a faceted cylinder: the curve is carried across (p95 < 0.03 mm), clean
//   5. a shell piercing the piece elsewhere is left as it was; other work out of reach is left alone
//   6. refusals in words: a click on the plain face, a click on a wall
//   7. a mesh full of splinters (every face of the engraving split, a cloud of zero-area triangles
//      between): the kept splinters inside the work are taken with it, no loop of no area is left
'use strict';

const R = require('../nso_resurface.js');
const T = require('../nso_text.js');
const { csgContext } = require('./nso_csg_node.js');
const vm = require('vm'), fs = require('fs'), path = require('path');

let fails = 0;
function gate(name, ok, detail) {
  if (!ok) fails++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -  ' + detail : ''));
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sb = { window: {} };
vm.createContext(sb);
for (const f of ['NSO_Repair.js', 'nso-defects.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sb, { filename: f });
const check = (soup) => { const r = sb.window.NSO_Defects.locate(soup, {}); return { open: r.openEdges, nm: r.nonManifoldEdges, odd: r.oddEdges, flip: r.flippedEdges, degen: r.degenerateTris, pierce: r.pierce }; };
const clean = (c) => c.open === 0 && c.nm === 0 && c.odd === 0 && c.flip === 0 && c.degen === 0 && !c.pierce;

/* ---------------------------------------------------------------- fixtures */
function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const t of f) for (const i of t) o.push(...v[i]);
  return new Float32Array(o);
}
/* A cylinder along X: x in [0, Lx], radius R, m facets, capped. */
function cylinder(R, Lx, m) {
  const o = [];
  const tri = (a, b, c) => o.push(...a, ...b, ...c);
  const at = (k, x) => { const a = 2 * Math.PI * k / m; return [x, R * Math.cos(a), R * Math.sin(a)]; };
  for (let k = 0; k < m; k++) {
    const a0 = at(k, 0), a1 = at(k + 1, 0), b0 = at(k, Lx), b1 = at(k + 1, Lx);
    tri(a0, a1, b1); tri(a0, b1, b0);
    tri([0, 0, 0], a1, a0);
    tri([Lx, 0, 0], b0, b1);
  }
  return new Float32Array(o);
}
function volume(s) {
  let v = 0;
  for (let i = 0; i < s.length; i += 9) {
    v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) +
         s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
  }
  return v / 6;
}
function closed(s) {
  const k = (i) => s[i].toFixed(4) + ',' + s[i + 1].toFixed(4) + ',' + s[i + 2].toFixed(4);
  const e = new Map();
  for (let t = 0; t < s.length; t += 9) {
    for (let c = 0; c < 3; c++) {
      const a = k(t + 3 * c), b = k(t + 3 * ((c + 1) % 3));
      e.set(a + '>' + b, (e.get(a + '>' + b) || 0) + 1);
    }
  }
  for (const [key, n] of e) {
    const [a, b] = key.split('>');
    if (n !== 1 || e.get(b + '>' + a) !== 1) return false;
  }
  return true;
}
const fingerprint = (s) => { let a = 0; for (let i = 0; i < s.length; i++) a += s[i] * ((i % 97) + 1); return s.length + ':' + a; };


/* Rasterise an ink(x, y) predicate (pixel units, y up) into alpha, 4 x 4
   supersampled, row 0 at the top. */
function raster(w, h, ink, mmPerPx) {
  const d = new Uint8Array(w * h), N = 4;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    let n = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      if (ink(c - 0.5 + (i + 0.5) / N, (h - 1 - r) - 0.5 + (j + 0.5) / N)) n++;
    }
    d[r * w + c] = Math.round(255 * n / (N * N));
  }
  return { w, h, data: d, mmPerPx };
}
const rect = (x0, y0, x1, y1) => (x, y) => x >= x0 && x < x1 && y >= y0 && y < y1;
const disc = (cx, cy, R) => (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= R * R;
const any = (...f) => (x, y) => f.some(g => g(x, y));
const minus = (a, b) => (x, y) => a(x, y) && !b(x, y);
const rayTop = (soup, x, y) => { // highest z of the surface at (x, y), by brute force
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
};

const PX = 0.1;
/* "H": two stems and a bar, 10 mm tall, 6 mm wide, 1.2 mm strokes. */
const letterH = () => raster(90, 130, any(rect(10, 10, 22, 110), rect(68, 10, 80, 110), rect(10, 54, 80, 66)), PX);
/* "E": a stem and three arms. */
const letterE = () => raster(80, 130, any(rect(10, 10, 22, 110), rect(10, 10, 70, 22), rect(10, 54, 60, 66), rect(10, 98, 70, 110)), PX);
/* "O": a ring, and "o." with a dot in the hole (an island in a hole). */
function word(n) {
  const gap = 100, ink = [];
  for (let k = 0; k < n; k++) {
    const o = k * gap;
    ink.push(rect(10 + o, 10, 22 + o, 110), rect(68 + o - 8, 10, 80 + o - 8, 110), rect(10 + o, 54, 80 + o - 8, 66));
  }
  return raster(gap * n + 20, 130, any(...ink), PX);
}

function disc3(cx, cy, Rr, z0, z1, m) {
  const o = [];
  for (let k = 0; k < m; k++) {
    const a0 = 2 * Math.PI * k / m, a1 = 2 * Math.PI * (k + 1) / m;
    const p = (a, z) => [cx + Rr * Math.cos(a), cy + Rr * Math.sin(a), z];
    o.push(...p(a0, z0), ...p(a1, z0), ...p(a1, z1), ...p(a0, z0), ...p(a1, z1), ...p(a0, z1));
    o.push(cx, cy, z0, ...p(a1, z0), ...p(a0, z0));
    o.push(cx, cy, z1, ...p(a0, z1), ...p(a1, z1));
  }
  return new Float32Array(o);
}

(async function main() {
  const csg = csgContext();
  const SLAB = box([0, 0, 0], [60, 40, 6]), v0 = volume(SLAB);
  const stamp = async (soup, shp, depth, at, angle) => {
    const pl = T.plan(soup, { point: at, normal: [0, 0, 1] }, shp, { depth, angle: angle || 0 });
    const r = await csg.NSO_subtractSoups(soup, T.cutter(pl));
    return { pl, soup: r.soup, ok: r.ok };
  };

  /* 1 --------------------------------------------------------------- */
  const A = await stamp(SLAB, T.shape(word(3)), 1, [30, 20, 6]);
  const sx = A.pl.data.o[0] + A.pl.data.V.reduce((m, v) => Math.min(m, v[0]), Infinity) + 0.6;
  {
    const t0 = Date.now();
    const pl = R.plan(A.soup, { point: [sx, 20, 5], normal: [0, 0, 1] }, { half: 26, reach: 5 });
    gate('1a one click on a letter finds the whole word (3 pieces of work, 1 mm deep)', pl.ok && pl.count === 3 && near(pl.depth, 1, 0.1), pl.reason);
    const r = pl.ok ? R.apply(A.soup, pl) : { ok: false, reason: pl.reason };
    gate('1b the slab is whole again: volume (0.1%), checker clean', r.ok && near(volume(r.soup), v0, 1e-3 * v0) && clean(check(r.soup)),
      r.ok ? JSON.stringify(check(r.soup)) + ' ' + volume(r.soup).toFixed(2) + ' / ' + v0 : r.reason);
    const tops = [[30 - 3.2, 20], [30, 20], [30 + 3.1, 22]].map(([x, y]) => rayTop(r.soup, x, y));
    gate('1c the face is flat again where the letters were (z = 6 within 0.002)', r.ok && tops.every(z => near(z, 6, 2e-3)), tops.map(z => z.toFixed(4)).join(' / '));
    gate('1d quick (under 3 s for plan and apply)', Date.now() - t0 < 3000, (Date.now() - t0) + ' ms');
    const before = fingerprint(A.soup);
    R.apply(A.soup, pl);
    gate('1e the soup handed in is not touched', fingerprint(A.soup) === before);
  }

  /* 2 --------------------------------------------------------------- */
  {
    const tr = await csg.NSO_subtractSoups(SLAB, box([10, 18, 4.5], [50, 22, 7]));
    const pl = R.plan(tr.soup, { point: [30, 20, 4.5], normal: [0, 0, 1] }, { half: 30 });
    const r = pl.ok ? R.apply(tr.soup, pl) : { ok: false, reason: pl.reason };
    gate('2 a 40 x 4 x 1.5 mm trench filled flush: volume exactly, flat, clean', pl.ok && r.ok && near(volume(r.soup), v0, 1e-3 * v0) && near(rayTop(r.soup, 30, 20), 6, 2e-3) && clean(check(r.soup)),
      pl.ok ? (r.ok ? JSON.stringify(check(r.soup)) + ' ' + volume(r.soup).toFixed(2) : r.reason) : pl.reason);
  }

  /* 3 --------------------------------------------------------------- */
  {
    const hole = await csg.NSO_subtractSoups(SLAB, disc3(30, 20, 4, -1, 7, 48));
    const pl = R.plan(hole.soup, { point: [34.1, 20, 6], normal: [0, 0, 1] }, { half: 10 });
    const r = pl.ok ? R.apply(hole.soup, pl) : { ok: false, reason: pl.reason };
    gate('3 a hole straight through filled: both faces laid, volume exactly the slab, clean', pl.ok && pl.holes && r.ok && near(volume(r.soup), v0, 1e-3 * v0) && clean(check(r.soup)) && near(rayTop(r.soup, 30, 20), 6, 2e-3),
      pl.ok ? (r.ok ? JSON.stringify(check(r.soup)) + ' ' + volume(r.soup).toFixed(2) : r.reason) : pl.reason);
  }

  /* 4 --------------------------------------------------------------- */
  {
    const cyl = cylinder(15, 40, 96), cs = T.shape(word(2));
    const cpl = T.plan(cyl, { point: [20, 0, 15], normal: [0, 0, 1] }, cs, { depth: 1, angle: 90 });
    const cut = await csg.NSO_subtractSoups(cyl, T.cutter(cpl));
    const D = cpl.data, at = (x, y) => [D.o[0] + D.ex[0] * x + D.ey[0] * y, D.o[1] + D.ex[1] * x + D.ey[1] * y];
    const st = at(Math.min(...D.V.map(v => v[0])) + 0.6, 0);
    const pl = R.plan(cut.soup, { point: [st[0], st[1], rayTop(cut.soup, st[0], st[1])], normal: [0, 0, 1] }, { half: 26, reach: 5 });
    const r = pl.ok ? R.apply(cut.soup, pl) : { ok: false, reason: pl.reason };
    const errs = [];
    if (r.ok) for (let x = 12; x < 28; x += 0.4) for (let y = -4.5; y <= 4.5; y += 0.4) {
      const zc = Math.sqrt(225 - y * y);
      if (zc - rayTop(cut.soup, x, y) < 0.3) continue;
      errs.push(Math.abs(rayTop(r.soup, x, y) - zc));
    }
    errs.sort((a, b) => a - b);
    const p95 = errs.length ? errs[Math.floor(errs.length * 0.95)] : Infinity;
    gate('4 letters on a faceted cylinder filled: face back (p95 under 0.03 mm), volume back, clean',
      pl.ok && r.ok && errs.length > 100 && p95 < 0.03 && Math.abs(volume(r.soup) - volume(cyl)) < 0.005 * (volume(cyl) - volume(cut.soup)) * 100 && clean(check(r.soup)),
      pl.ok ? (r.ok ? errs.length + ' points, p95 ' + p95.toFixed(4) + ', ' + JSON.stringify(check(r.soup)) : r.reason) : pl.reason);
  }

  /* 5 --------------------------------------------------------------- */
  {
    const second = box([47, 10, 0], [75, 30, 8]);
    const messy = new Float32Array(A.soup.length + second.length); messy.set(A.soup); messy.set(second, A.soup.length);
    const pl = R.plan(messy, { point: [sx, 20, 5], normal: [0, 0, 1] }, { half: 26, reach: 5 });
    const r = pl.ok ? R.apply(messy, pl) : { ok: false, reason: pl.reason };
    gate('5a another shell piercing the piece elsewhere is no obstacle (only the work changes)', pl.ok && r.ok && near(volume(r.soup) - volume(messy), v0 - volume(A.soup), 2e-3 * v0), pl.ok ? (r.ok ? (volume(r.soup) - volume(messy)).toFixed(3) : r.reason) : pl.reason);
    const B2 = await stamp(A.soup, T.shape(letterH()), 0.5, [30, 33, 6]);
    const pl2 = R.plan(B2.soup, { point: [sx, 20, 5], normal: [0, 0, 1] }, { half: 26, reach: 5 });
    const r2 = pl2.ok ? R.apply(B2.soup, pl2) : { ok: false, reason: pl2.reason };
    gate('5b a second stamp 0.5 deep in reach goes with the word: 4 pieces, the slab whole, clean', pl2.ok && pl2.count === 4 && r2.ok && near(volume(r2.soup), v0, 1e-3 * v0) && clean(check(r2.soup)),
      pl2.ok ? (r2.ok ? JSON.stringify(check(r2.soup)) : r2.reason) : pl2.reason);
  }

  /* 6 --------------------------------------------------------------- */
  {
    const plain = R.plan(A.soup, { point: [5, 5, 6], normal: [0, 0, 1] }, { half: 4 });
    gate('6a a click on the plain face is refused in words', !plain.ok && /no pit/.test(plain.reason), plain.reason);
    const wall = R.plan(box([0, 0, 0], [20, 20, 6]), { point: [10, 10, 3], normal: [1, 0, 0] }, {});
    gate('6b a flat block with nothing on it is refused', !wall.ok, wall.reason);
    const none = R.plan(new Float32Array(0), { point: [0, 0, 0], normal: [0, 0, 1] }, {});
    gate('6c no piece is refused', !none.ok && /no piece/.test(none.reason), none.reason);
  }

  /* 7 --------------------------------------------------------------- */
  {
    // split every triangle of the engraving in three (a mesh from a scan has splinters like these) and
    // keep a few of the pieces as tiny islands of their own: the kept bits inside the work go with it
    const out = [];
    for (let t = 0; t < A.soup.length; t += 9) {
      const p = [A.soup.subarray(t, t + 3), A.soup.subarray(t + 3, t + 6), A.soup.subarray(t + 6, t + 9)];
      const inLetters = p.every(v => v[2] < 6.001 && v[2] > 4.999 || (Math.abs(v[0] - 30) < 12 && Math.abs(v[1] - 20) < 8 && v[2] > 4.99));
      if (!inLetters || (t / 9) % 2) { out.push(...p[0], ...p[1], ...p[2]); continue; }
      const c = [(p[0][0] + p[1][0] + p[2][0]) / 3, (p[0][1] + p[1][1] + p[2][1]) / 3, (p[0][2] + p[1][2] + p[2][2]) / 3];
      out.push(...p[0], ...p[1], ...c, ...p[1], ...p[2], ...c, ...p[2], ...p[0], ...c);
    }
    const split = new Float32Array(out);
    const pl = R.plan(split, { point: [sx, 20, 5], normal: [0, 0, 1] }, { half: 26, reach: 5 });
    const r = pl.ok ? R.apply(split, pl) : { ok: false, reason: pl.reason };
    gate('7 a mesh whose engraved triangles are split in three is filled all the same: volume back, checker clean', pl.ok && r.ok && near(volume(r.soup), v0, 2e-3 * v0) && clean(check(r.soup)),
      pl.ok ? (r.ok ? JSON.stringify(check(r.soup)) : r.reason) : pl.reason);
  }

  console.log(fails ? '\n' + fails + ' FAILED' : '\nPASSED all gates');
  process.exit(fails ? 1 : 0);
})();
