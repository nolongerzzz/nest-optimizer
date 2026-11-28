/* The three pieces Scale zones is tested on (tools/nso_scale_zones_test.js, and the drive
   check tools/nso_scale_zones_drive_check.js), each the shape of one of the owner's asks:
   a thumb screw, a stringing test, a shower head. Every one closed and wound outward. */
'use strict';

/* a solid of revolution about Z: a closed profile [[r, z], ...] (counter-clockwise in r-z), N sides, wound outward.
   A point on the axis (r = 0) is one vertex, so the caps are fans. */
function revolve(profile, N) {
  const tris = [];
  const P = (r, z, i) => { const a = 2 * Math.PI * i / N; return [r * Math.cos(a), r * Math.sin(a), z]; };
  for (let k = 0; k < profile.length; k++) {
    const [r0, z0] = profile[k], [r1, z1] = profile[(k + 1) % profile.length];
    for (let i = 0; i < N; i++) {
      const a = P(r0, z0, i), b = P(r0, z0, i + 1), c = P(r1, z1, i + 1), d = P(r1, z1, i);
      if (r0 > 0) tris.push([a, b, d]);
      if (r1 > 0) tris.push([b, c, d]);
    }
  }
  return soupOf(tris);
}
/* a closed mesh from a height per 1 mm cell (0: no cell): tops, bottoms at z = 0, and the walls between */
function heightfield(H) {
  const ny = H.length, nx = H[0].length, tris = [];
  const h = (i, j) => (j >= 0 && j < ny && i >= 0 && i < nx ? H[j][i] : 0);
  const quad = (a, b, c, d) => { tris.push([a, b, c]); tris.push([a, c, d]); };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const z = h(i, j);
    if (!z) continue;
    quad([i, j, z], [i + 1, j, z], [i + 1, j + 1, z], [i, j + 1, z]);
    quad([i, j, 0], [i, j + 1, 0], [i + 1, j + 1, 0], [i + 1, j, 0]);
    /* a wall where the neighbour is lower: from its height up to this one, facing it */
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    nb.forEach(([dx, dy]) => {
      const zn = h(i + dx, j + dy);
      if (zn >= z) return;
      let p, q;   // the shared edge, ordered so the wall faces outward (toward the neighbour)
      if (dx === 1) { p = [i + 1, j]; q = [i + 1, j + 1]; }
      if (dx === -1) { p = [i, j + 1]; q = [i, j]; }
      if (dy === 1) { p = [i + 1, j + 1]; q = [i, j + 1]; }
      if (dy === -1) { p = [i, j]; q = [i + 1, j]; }
      quad([p[0], p[1], zn], [q[0], q[1], zn], [q[0], q[1], z], [p[0], p[1], z]);
    });
  }
  return soupOf(tris);
}
function soupOf(tris) {
  const s = new Float32Array(tris.length * 9);
  tris.forEach((t, k) => t.forEach((p, c) => { s[k * 9 + c * 3] = p[0]; s[k * 9 + c * 3 + 1] = p[1]; s[k * 9 + c * 3 + 2] = p[2]; }));
  return s;
}
/* topology at a weld: open and over-shared edges, and the signed volume */
function topo(s) {
  const key = o => Math.round(s[o] * 1e4) + ',' + Math.round(s[o + 1] * 1e4) + ',' + Math.round(s[o + 2] * 1e4);
  const E = new Map();
  let vol = 0;
  for (let t = 0; t < s.length / 9; t++) {
    const k = [key(t * 9), key(t * 9 + 3), key(t * 9 + 6)];
    for (let e = 0; e < 3; e++) { const a = k[e], b = k[(e + 1) % 3]; if (a === b) continue; const ek = a < b ? a + '|' + b : b + '|' + a; E.set(ek, (E.get(ek) || 0) + 1); }
    const o = t * 9;
    vol += (s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7]) - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6]) + s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6])) / 6;
  }
  let open = 0, nm = 0;
  E.forEach(c => { if (c === 1) open++; else if (c > 2) nm++; });
  return { open, nm, vol };
}

/* a Ø20 x 10 head (a ring at r 7.5 on its top) on a Ø10 x 20 shaft */
function screw() { return revolve([[0, 0], [10, 0], [10, 10], [7.5, 10], [5, 10], [5, 30], [0, 30]], 48); }
/* a 10 x 30 x 1 plate on a 1 mm grid, two 2 x 2 pillars 19 tall at (5, 5) and (5, 25) */
function pillars() {
  const H = [];
  for (let j = 0; j < 30; j++) { const row = []; for (let i = 0; i < 10; i++) row.push(1); H.push(row); }
  [[4, 4], [5, 4], [4, 5], [5, 5]].forEach(([i, j]) => { H[j][i] = 20; });
  [[4, 24], [5, 24], [4, 25], [5, 25]].forEach(([i, j]) => { H[j][i] = 20; });
  return heightfield(H);
}
/* a Ø30 x 100 tube, a Ø22 x 3 collar, a Ø20 x 7 fitting, a Ø10 bore through all of it */
function shower() { return revolve([[5, 0], [15, 0], [15, 100], [11, 100], [11, 103], [10, 103], [10, 110], [5, 110]], 64); }
const stl = require('./nso_feature_fixture.js').stl;

module.exports = { revolve, heightfield, soupOf, topo, screw, pillars, shower, stl };
