/* Shared by mold:test and mold:drive: the SHIPPED kernels the mold is made of,
   running under node, and the fixtures both use.

     const lib = require('./nso_mold_testlib.js');
     const kernel = lib.kernel();          // { subtract, union, cutSide } as the app passes them
     const sphere = lib.stockSphere(15);   // y-up world soup, faces out

   NOTHING IS REIMPLEMENTED. The boolean is nso_csg_node.js's splice of
   app-join.js (Manifold from vendor/); the clean split is app-cut.js's own
   cutOneSide / rawCut, run in a vm exactly as nso_rawcut_seam_test.js does. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { csgContext } = require('./nso_csg_node.js');

const ROOT = path.resolve(__dirname, '..');

let cutCtx = null;
function cutContext() {
  if (cutCtx) return cutCtx;
  const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Float32Array,
    Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer, Error, Infinity, NaN };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext('var state = {}; var THREE = {};', ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-cut.js'), 'utf8'), ctx, { filename: 'app-cut.js' });
  return (cutCtx = ctx);
}

function kernel() {
  const csg = csgContext();
  const cut = cutContext();
  return {
    subtract: (a, b) => csg.NSO_subtractSoups(a, b),
    union: (a, b) => csg.NSO_unionSoups(a, b),
    cutSide: (soup, axisIdx, plane, keepMin) => cut.cutOneSide(soup, axisIdx, plane, keepMin)
  };
}

/* Stock's z-up soup into the world's y-up: display = (x, z, -y) of raw. */
function toYUp(raw) {
  const o = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) { o[i] = raw[i]; o[i + 1] = raw[i + 2]; o[i + 2] = -raw[i + 1]; }
  return o;
}
function centred(soup, y0) {
  // centre on x/z = 0 and rest the piece's bottom at y0 (the plate)
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < soup.length; i += 3) for (let a = 0; a < 3; a++) {
    mn[a] = Math.min(mn[a], soup[i + a]); mx[a] = Math.max(mx[a], soup[i + a]);
  }
  const o = new Float32Array(soup.length), cx = (mn[0] + mx[0]) / 2, cz = (mn[2] + mx[2]) / 2;
  for (let i = 0; i < soup.length; i += 3) { o[i] = soup[i] - cx; o[i + 1] = soup[i + 1] - mn[1] + y0; o[i + 2] = soup[i + 2] - cz; }
  return o;
}

/* Stock's sphere of radius r, exactly as the card's New stock would revolve it. */
function stockSphere(r, y0) {
  const S = require('../nso_stock.js');
  return centred(toYUp(S.revolve(S.profileSphere(r, 96), 96)), y0 == null ? 0 : y0);
}
function stockBox(x, y, z, y0) {
  const S = require('../nso_stock.js');
  return centred(toYUp(S.boxSoup(x, y, z)), y0 == null ? 0 : y0);
}
function stockTorus(ring, tube, y0) {
  const S = require('../nso_stock.js');
  return centred(toYUp(S.revolve(S.profileTorus(ring, tube, 48), 64)), y0 == null ? 0 : y0);
}

/* The mesh checker the repo already has, on one soup. */
function validate(soup, weld, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-mold-'));
  const f = path.join(dir, 'p.stl');
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--json'];
  if (!(opts && opts.selfint)) args.push('--no-selfint');
  if (weld) args.push('--weld', String(weld));
  const j = JSON.parse(execFileSync('python3', args).toString());
  j.summary = 'open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' inc ' + j.inconsistent_winding_edges +
    ' deg ' + j.degenerate_tris + ' chi ' + j.euler_characteristic +
    (opts && opts.selfint ? ' selfint ' + JSON.stringify(j.self_intersection) : '');
  fs.rmSync(dir, { recursive: true, force: true });
  return j;
}

/* Is the point inside the closed soup? Ray parity, majority of three skew rays. */
function inside(soup, p) {
  const DIRS = [[0.5299, 0.6831, 0.5028], [-0.6113, 0.3917, 0.6877], [0.2741, -0.8423, 0.4641]];
  let votes = 0;
  for (const d of DIRS) {
    let hits = 0;
    for (let t = 0; t + 8 < soup.length; t += 9) {
      const e1 = [soup[t + 3] - soup[t], soup[t + 4] - soup[t + 1], soup[t + 5] - soup[t + 2]];
      const e2 = [soup[t + 6] - soup[t], soup[t + 7] - soup[t + 1], soup[t + 8] - soup[t + 2]];
      const pv = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
      if (Math.abs(det) < 1e-12) continue;
      const tv = [p[0] - soup[t], p[1] - soup[t + 1], p[2] - soup[t + 2]];
      const u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
      const w = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
      if (w < 0 || u + w > 1) continue;
      if ((e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det > 1e-9) hits++;
    }
    if (hits & 1) votes++;
  }
  return votes >= 2;
}

module.exports = { ROOT, kernel, cutContext, toYUp, centred, stockSphere, stockBox, stockTorus, validate, inside };
