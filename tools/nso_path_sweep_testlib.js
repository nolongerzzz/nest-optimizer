/* Shared measurement helpers for the curving-path suites. Node only.
 *
 * Nothing here knows how nso_path_sweep.js builds anything. Every function
 * takes a finished triangle soup and measures it, which is the point: the
 * module's own gates check its arithmetic against itself, and these check the
 * buffer that actually came out.
 */
'use strict';

const path = require('path');
const REPO = path.resolve(__dirname, '..');

function loadSweep() {
  return require(path.join(REPO, 'nso_path_sweep.js'));
}

/** Exact-bit vertex key. The sweep emits shared corners as the same float32
 *  value, so welding needs no tolerance - and if that ever stops being true the
 *  open-edge count says so loudly instead of a tolerance papering over it. */
function vkey(t, i) {
  return t[i] + ',' + t[i + 1] + ',' + t[i + 2];
}

function topology(tris) {
  const nt = tris.length / 9;
  const ids = new Map();
  const idOf = k => { let v = ids.get(k); if (v === undefined) { v = ids.size; ids.set(k, v); } return v; };
  const edges = new Map();       // "a|b" (a<b) -> {count, fwd, rev}
  let degenerate = 0;
  let vol = 0;
  let area = 0;
  let minEdge = Infinity, maxAspect = 0;

  for (let t = 0; t < nt; t++) {
    const o = t * 9;
    const a = idOf(vkey(tris, o)), b = idOf(vkey(tris, o + 3)), c = idOf(vkey(tris, o + 6));
    const A = [tris[o], tris[o + 1], tris[o + 2]];
    const B = [tris[o + 3], tris[o + 4], tris[o + 5]];
    const C = [tris[o + 6], tris[o + 7], tris[o + 8]];
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const twoA = Math.hypot(nx, ny, nz);
    if (twoA === 0) degenerate++;
    area += twoA / 2;
    // signed volume = sum of tetrahedra on the origin
    vol += (A[0] * (B[1] * C[2] - B[2] * C[1])
          - A[1] * (B[0] * C[2] - B[2] * C[0])
          + A[2] * (B[0] * C[1] - B[1] * C[0])) / 6;
    const e = [[A, B], [B, C], [C, A]];
    let lmin = Infinity, lmax = 0;
    for (const [p, q] of e) {
      const L = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (L < lmin) lmin = L;
      if (L > lmax) lmax = L;
    }
    if (lmin < minEdge) minEdge = lmin;
    if (twoA > 0) {
      const h = twoA / lmax;              // shortest altitude
      const asp = lmax / h;
      if (asp > maxAspect) maxAspect = asp;
    }
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const lo = Math.min(p, q), hi = Math.max(p, q);
      const k = lo + '|' + hi;
      let rec = edges.get(k);
      if (!rec) { rec = { count: 0, fwd: 0, rev: 0 }; edges.set(k, rec); }
      rec.count++;
      if (p === lo) rec.fwd++; else rec.rev++;
    }
  }

  let open = 0, nonManifold = 0, odd = 0, badWinding = 0;
  for (const rec of edges.values()) {
    if (rec.count === 1) open++;
    if (rec.count > 2) nonManifold++;
    if (rec.count !== 2) odd++;
    if (rec.count === 2 && !(rec.fwd === 1 && rec.rev === 1)) badWinding++;
  }

  const V = ids.size, E = edges.size, F = nt;
  return {
    tris: nt, verts: V, edges: E, faces: F,
    open, nonManifold, odd, badWinding, degenerate,
    euler: V - E + F,
    volume: vol, area, minEdge, maxAspect
  };
}

/** Everything a closed, correctly wound solid must satisfy. */
function solidFailures(topo) {
  const bad = [];
  if (topo.open !== 0) bad.push('open edges ' + topo.open);
  if (topo.nonManifold !== 0) bad.push('non-manifold edges ' + topo.nonManifold);
  if (topo.odd !== 0) bad.push('odd edges ' + topo.odd);
  if (topo.badWinding !== 0) bad.push('inconsistently wound edges ' + topo.badWinding);
  if (topo.degenerate !== 0) bad.push('degenerate triangles ' + topo.degenerate);
  if (topo.euler !== 2) bad.push('Euler characteristic ' + topo.euler + ' (want 2)');
  if (!(topo.volume > 0)) bad.push('signed volume ' + topo.volume.toExponential(3) + ' (want > 0: outward winding)');
  return bad;
}

module.exports = { REPO, loadSweep, topology, solidFailures };
