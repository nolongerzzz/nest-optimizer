/* A scan-like fixture for Weave (nso_weave.js, docs/WEAVE.md): a closed slab whose top is a spherical cap with
   strokes and a ring ENGRAVED in it, on a jittered grid (so its triangles are irregular, as a scan's are). The
   surface the engraving was cut from is known in closed form: base(x, y).

     const fx = build({ W, H, cell, R, depth, jit, ink, inkScale, groove });  ->  { soup (Float32Array), base(x, y), inkAt(x, y), ... }
     inkScale shrinks the strokes about the centre (a small, strongly curved cap); groove { depth, width } cuts a smooth valley
     along y through the cap (part of the surface, so part of base): a groove the work lies across.

   The cap is centred on (0, 0); the strokes and the ring are in mm about the same centre. */
'use strict';
module.exports = function build(opts) {
  opts = opts || {};
  const W = opts.W || 36, H = opts.H || 28, cell = opts.cell || 0.15, R = opts.R || 30, depth = opts.depth == null ? 0.6 : opts.depth;
  const zb = -4, jit = opts.jit == null ? 0.2 : opts.jit;
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const nx = Math.round(W / cell), ny = Math.round(H / cell);
  const gv = opts.groove || null, isc = opts.inkScale || 1;
  const base = (x, y) => Math.sqrt(R * R - (x * x + y * y)) - R - (gv ? gv.depth * Math.exp(-(x * x) / (gv.width * gv.width)) : 0);
  const bars = opts.ink === false ? [] : [
    [-9, -4, -7.6, 4], [-7.6, -4, -5.5, -2.6], [-7.6, 2.6, -5.5, 4], [-5.7, -2.6, -4.3, 2.6],   // a D
    [-2.5, -4, -1.1, 4], [1, -4, 2.4, 4], [-1.1, -4, 1, -2.6],                                    // a U
    [5, -4, 6.4, 4], [6.4, -0.7, 9, 0.7]                                                          // a K-ish
  ];
  const ring = opts.ink === false ? null : { cx: 0, cy: 9, r0: 2, r1: 3.3 };
  const inkAt = (x0, y0) => {
    const x = x0 / isc, y = y0 / isc;
    for (const b of bars) if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) return true;
    if (ring) { const d = Math.hypot(x - ring.cx, y - ring.cy); if (d >= ring.r0 && d <= ring.r1) return true; }
    return false;
  };
  const V = [], idx = (i, j) => j * (nx + 1) + i;
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    let x = -W / 2 + i * cell, y = -H / 2 + j * cell;
    if (i > 0 && i < nx && j > 0 && j < ny) { x += (rnd() - 0.5) * 2 * jit * cell; y += (rnd() - 0.5) * 2 * jit * cell; }
    V.push([x, y, base(x, y) - (inkAt(x, y) ? depth : 0)]);
  }
  const tris = [], tri = (a, b, c) => tris.push(V[a], V[b], V[c]);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
    if ((i + j) & 1) { tri(a, b, c); tri(a, c, d); } else { tri(a, b, d); tri(b, c, d); }
  }
  const loop = [];
  for (let i = 0; i < nx; i++) loop.push(idx(i, 0));
  for (let j = 0; j < ny; j++) loop.push(idx(nx, j));
  for (let i = nx; i > 0; i--) loop.push(idx(i, ny));
  for (let j = ny; j > 0; j--) loop.push(idx(0, j));
  const B = loop.map(v => [V[v][0], V[v][1], zb]), m = loop.length;
  for (let q = 0; q < m; q++) {
    const a = V[loop[q]], b = V[loop[(q + 1) % m]], ab = B[q], bb = B[(q + 1) % m];
    tris.push(a, ab, bb, a, bb, b);
  }
  const ctr = [0, 0, zb];
  for (let q = 0; q < m; q++) tris.push(ctr, B[(q + 1) % m], B[q]);
  const soup = new Float32Array(tris.length * 3);
  tris.forEach((p, i) => { soup[3 * i] = p[0]; soup[3 * i + 1] = p[1]; soup[3 * i + 2] = p[2]; });
  return { soup, base, inkAt, W, H, R, depth, zb, cell };
};
