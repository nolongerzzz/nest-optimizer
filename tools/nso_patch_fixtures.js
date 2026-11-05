/* Fixtures for patch:test (tools/nso_patch_test.js) and patch:drive (tools/nso_patch_drive_check.js):
   a generated sphere R 15 with four holes of O 2, 5, 9 and 14 mm, cut by planes so every rim is
   EXACTLY planar and exactly the size named. Nothing random, nothing on disk: built on the spot. */
'use strict';

function icosphere(R, level) {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map(p => { const l = Math.hypot(...p); return p.map(x => x / l * R); });
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
           [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let l = 0; l < level; l++) {
    const mid = new Map(), nf = [];
    const m = (a, b) => {
      const k = a < b ? a + ',' + b : b + ',' + a;
      if (mid.has(k)) return mid.get(k);
      const p = v[a].map((x, i) => (x + v[b][i]) / 2), L = Math.hypot(...p);
      v.push(p.map(x => x / L * R)); mid.set(k, v.length - 1);
      return v.length - 1;
    };
    for (const [a, b, c] of f) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    f = nf;
  }
  return f.map(tri => tri.map(i => v[i]));                  // triangles of three points
}
/* Keep the part of every triangle on the side n.p <= h (Sutherland-Hodgman). A cut
   point is computed from its edge's two ends in a fixed order, so the two triangles
   sharing the edge get the same point: the piece stays watertight but for the hole. */
function clip(tris, n, h) {
  const out = [], key = p => p[0] * 1e6 + p[1] * 1e3 + p[2];
  const cut = (a, b) => {
    if (key(a) > key(b)) { const t = a; a = b; b = t; }
    const da = n[0] * a[0] + n[1] * a[1] + n[2] * a[2] - h, db = n[0] * b[0] + n[1] * b[1] + n[2] * b[2] - h, u = da / (da - db);
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  };
  for (const tri of tris) {
    const d = tri.map(p => n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - h), poly = [];
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      if (d[i] <= 0) poly.push(tri[i]);
      if ((d[i] <= 0) !== (d[j] <= 0)) poly.push(cut(tri[i], tri[j]));
    }
    for (let k = 1; k + 1 < poly.length; k++) out.push([poly[0], poly[k], poly[k + 1]]);
  }
  return out;
}
const soupOfTris = tris => { const s = new Float32Array(tris.length * 9); tris.forEach((t, i) => t.forEach((p, k) => s.set(p, i * 9 + k * 3))); return s; };
const unit3 = v => { const l = Math.hypot(...v); return v.map(x => x / l); };

const R = 15, HOLES = [{ d: 2, axis: unit3([-0.5, -0.5, -0.7071]) }, { d: 5, axis: [0, 1, 0] }, { d: 9, axis: [1, 0, 0] }, { d: 14, axis: [0, 0, 1] }];
function sphereWithHoles() {
  let tris = icosphere(R, 5);
  for (const H of HOLES) { H.h = Math.sqrt(R * R - (H.d / 2) ** 2); tris = clip(tris, H.axis, H.h); }
  return soupOfTris(tris);
}

module.exports = { icosphere, clip, soupOfTris, unit3, R, HOLES, sphereWithHoles };
