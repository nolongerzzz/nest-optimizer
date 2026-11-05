/* Shared by tools/nso_bridge_test.js and its drive check: the shipped files in
   a vm context, index.html's order, and small fixture / pick helpers. Node only. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

function bridgeContext() {
  const ctx = {
    Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, isNaN, Date, Promise,
    Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer, Error, Infinity, NaN
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext('var state = {}; var THREE = {};', ctx);
  for (const f of ['NSO_Repair.js', 'nso_thickness.js', 'nso_support_aim.js', 'nso_assemble.js', 'nso_planar_fuse.js',
                   'nso_path_sweep.js', 'app-cut.js', 'app-sculpt.js', 'app-extend.js', 'nso_section.js', 'nso_bridge.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

// The triangle of `soup` that holds `p` (within tol of its plane, inside it),
// optionally facing `n`.
function triAt(soup, p, n, tol) {
  tol = tol || 1e-3;
  let best = -1, bestD = Infinity;
  for (let t = 0; t < soup.length / 9; t++) {
    const o = t * 9, A = [soup[o], soup[o + 1], soup[o + 2]], B = [soup[o + 3], soup[o + 4], soup[o + 5]], C = [soup[o + 6], soup[o + 7], soup[o + 8]];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const N = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const L = Math.hypot(N[0], N[1], N[2]);
    if (!(L > 0)) continue;
    const nn = N.map(x => x / L);
    if (n && nn[0] * n[0] + nn[1] * n[1] + nn[2] * n[2] < 0.99) continue;
    const w = [p[0] - A[0], p[1] - A[1], p[2] - A[2]];
    const d = Math.abs(w[0] * nn[0] + w[1] * nn[1] + w[2] * nn[2]);
    if (d > tol) continue;
    // barycentric
    const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2], uv = u[0] * v[0] + u[1] * v[1] + u[2] * v[2], vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    const wu = w[0] * u[0] + w[1] * u[1] + w[2] * u[2], wv = w[0] * v[0] + w[1] * v[1] + w[2] * v[2];
    const den = uv * uv - uu * vv;
    const s = (uv * wv - vv * wu) / den, q = (uv * wu - uu * wv) / den;
    if (s < -1e-6 || q < -1e-6 || s + q > 1 + 1e-6) continue;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

function box(x0, y0, z0, x1, y1, z1) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return new Float32Array(f.flatMap(t => t.flatMap(i => v[i])));
}
function sphere(c, r, nu, nv) {
  const P = (i, j) => {
    const th = Math.PI * i / nv, ph = 2 * Math.PI * j / nu;
    return [c[0] + r * Math.sin(th) * Math.cos(ph), c[1] + r * Math.sin(th) * Math.sin(ph), c[2] + r * Math.cos(th)];
  };
  const t = [];
  for (let i = 0; i < nv; i++) for (let j = 0; j < nu; j++) {
    const a = P(i, j), b = P(i + 1, j), cc = P(i + 1, j + 1), d = P(i, j + 1);
    if (i > 0) t.push(a, b, d);
    if (i < nv - 1) t.push(d, b, cc);
  }
  return new Float32Array(t.flat());
}
function turnZ(soup, deg, about) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), out = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i] - about[0], y = soup[i + 1] - about[1];
    out[i] = about[0] + c * x - s * y; out[i + 1] = about[1] + s * x + c * y; out[i + 2] = soup[i + 2];
  }
  return out;
}
function shift(soup, d) {
  const out = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i++) out[i] = soup[i] + d[i % 3];
  return out;
}
function bounds(soup) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i++) { const k = i % 3; if (soup[i] < lo[k]) lo[k] = soup[i]; if (soup[i] > hi[k]) hi[k] = soup[i]; }
  return { lo, hi };
}

// First hit of a ray on a soup: { tri, point }.
function rayHit(soup, o, d) {
  let best = null;
  for (let t = 0; t < soup.length / 9; t++) {
    const k = t * 9, A = [soup[k], soup[k + 1], soup[k + 2]];
    const e1 = [soup[k + 3] - A[0], soup[k + 4] - A[1], soup[k + 5] - A[2]], e2 = [soup[k + 6] - A[0], soup[k + 7] - A[1], soup[k + 8] - A[2]];
    const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det, s = [o[0] - A[0], o[1] - A[1], o[2] - A[2]];
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
    if (u < 0 || u > 1) continue;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
    if (v < 0 || u + v > 1) continue;
    const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
    if (tt > 1e-9 && (!best || tt < best.t)) best = { t: tt, tri: t, point: [o[0] + d[0] * tt, o[1] + d[1] * tt, o[2] + d[2] * tt] };
  }
  return best;
}
// A closed prism: polygon (x, y), counter-clockwise, extruded z0..z1, its two
// caps fanned from point `apex` (which must see every other corner).
function prismXY(poly, z0, z1, apex) {
  const t = [], n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    t.push([p[0], p[1], z0], [q[0], q[1], z0], [q[0], q[1], z1], [p[0], p[1], z0], [q[0], q[1], z1], [p[0], p[1], z1]);
  }
  const c = poly[apex || 0];
  for (let i = 1; i < n - 1; i++) {
    const p = poly[((apex || 0) + i) % n], q = poly[((apex || 0) + i + 1) % n];
    t.push([c[0], c[1], z1], [p[0], p[1], z1], [q[0], q[1], z1]);
    t.push([c[0], c[1], z0], [q[0], q[1], z0], [p[0], p[1], z0]);
  }
  return new Float32Array(t.flat());
}
function writeSTL(file, soup) {
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}

module.exports = { bridgeContext, triAt, rayHit, box, sphere, prismXY, turnZ, shift, bounds, writeSTL, ROOT };
