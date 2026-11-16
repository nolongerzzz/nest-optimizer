/* Two known pieces for Feature size and Step / Boss, built here from their
   definitions so every size is known by hand (tools/nso_feature_size_test.js,
   tools/nso_scale_feature_drive_check.js, tools/nso_boss_drive_check.js).

     plateWithTongues(o)  a plate 40 x 79 x 2 (z 0..2) with two tongues on its
                          top, 25 x 5 x 4 at y = +-33.5 - the lid of the A1
                          Mini tool-head lock this was written for - each with
                          an `ease` (a 45 degree chamfer round its tip) if asked,
                          and `extra` corners on the plate's top (the stray
                          vertices a STEP export leaves round a feature)
     blockWithSlot(o)     a block 32 x 40 x 10 with a slot 20 x 5.2 x 4 deep
                          down into its top, in the middle

   Each is a closed, outward-wound Float32Array soup (9 floats a triangle),
   flat faces laid by NSO_CDT where they have holes. stl(soup) is a binary STL. */
const path = require('path');
const CDT = require(path.join(__dirname, '..', 'nso_cdt.js'));

function rect(cx, cy, hx, hy) { return [[cx - hx, cy - hy], [cx + hx, cy - hy], [cx + hx, cy + hy], [cx - hx, cy + hy]]; }

function builder() {
  const out = [];
  const T = (a, b, c) => out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  const at = (p, z) => [p[0], p[1], z];
  return {
    T,
    /* walls between two rings (counter-clockwise from above), lo at z0, hi at z1;
       out: the solid is inside the ring (a boss) - else outside it (a pocket) */
    wall(lo, z0, hi, z1, outward) {
      for (let i = 0; i < lo.length; i++) {
        const j = (i + 1) % lo.length;
        const a = at(lo[i], z0), b = at(lo[j], z0), c = at(hi[j], z1), d = at(hi[i], z1);
        if (outward) { T(a, b, c); T(a, c, d); } else { T(a, c, b); T(a, d, c); }
      }
    },
    /* a flat face at z: an outer loop (ccw) and holes (ccw, reversed here); up: normal +z */
    face(outer, holes, z, up, extra) {
      const pts = [], segs = [];
      [outer].concat((holes || []).map(h => h.slice().reverse())).forEach(L => {
        const b = pts.length;
        L.forEach((p, i) => { pts.push(p); segs.push([b + i, b + (i + 1) % L.length]); });
      });
      (extra || []).forEach(p => pts.push(p));
      const t = CDT.triangulate(pts, segs);
      if (!t || !t.tris) throw new Error('fixture face: ' + (t && t.reason));
      for (let q = 0; q < t.tris.length; q += 3) {
        const A = at(pts[t.tris[q]], z), B = at(pts[t.tris[q + 1]], z), C = at(pts[t.tris[q + 2]], z);
        if (up) T(A, B, C); else T(A, C, B);
      }
    },
    soup() { return new Float32Array(out); }
  };
}

function plateWithTongues(o) {
  o = Object.assign({ L: 25, W: 5, H: 4, ease: 0, y: 33.5, extra: null }, o || {});
  const B = builder(), plate = rect(0, 0, 20, 39.5), z0 = 0, z1 = 2;
  const feet = [rect(0, -o.y, o.L / 2, o.W / 2), rect(0, o.y, o.L / 2, o.W / 2)];
  B.face(plate, null, z0, false);
  B.wall(plate, z0, plate, z1, true);
  B.face(plate, feet, z1, true, o.extra);
  feet.forEach((foot, k) => {
    const cy = k ? o.y : -o.y, e = o.ease;
    const top = e > 0 ? rect(0, cy, o.L / 2 - e, o.W / 2 - e) : foot;
    B.wall(foot, z1, foot, z1 + o.H - e, true);
    if (e > 0) B.wall(foot, z1 + o.H - e, top, z1 + o.H, true);
    B.face(top, null, z1 + o.H, true);
  });
  return B.soup();
}

function blockWithSlot(o) {
  o = Object.assign({ L: 20, W: 5.2, D: 4 }, o || {});
  const B = builder(), blk = rect(0, 0, 16, 20), slot = rect(0, 0, o.L / 2, o.W / 2), top = 10;
  B.face(blk, null, 0, false);
  B.wall(blk, 0, blk, top, true);
  B.face(blk, [slot], top, true);
  B.wall(slot, top - o.D, slot, top, false);
  B.face(slot, null, top - o.D, true);
  return B.soup();
}

function stl(soup) {
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  return b;
}

/* every directed edge met once by its reverse, no degenerate triangle */
function topology(s) {
  const key = (x, y, z) => Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4);
  const edges = new Map();
  let degenerate = 0;
  for (let i = 0; i < s.length; i += 9) {
    const v = [key(s[i], s[i + 1], s[i + 2]), key(s[i + 3], s[i + 4], s[i + 5]), key(s[i + 6], s[i + 7], s[i + 8])];
    const ax = s[i + 3] - s[i], ay = s[i + 4] - s[i + 1], az = s[i + 5] - s[i + 2], bx = s[i + 6] - s[i], by = s[i + 7] - s[i + 1], bz = s[i + 8] - s[i + 2];
    if (Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) < 1e-9) degenerate++;
    for (let k = 0; k < 3; k++) { const e = v[k] + '>' + v[(k + 1) % 3]; edges.set(e, (edges.get(e) || 0) + 1); }
  }
  let bad = 0;
  for (const [e, n] of edges) { const [a, b] = e.split('>'); if (n !== 1 || edges.get(b + '>' + a) !== 1) bad++; }
  return { bad, degenerate, tris: s.length / 9 };
}

function volume(s) {
  let v = 0;
  for (let i = 0; i < s.length; i += 9) {
    v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) + s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
  }
  return v / 6;
}

module.exports = { plateWithTongues, blockWithSlot, stl, topology, volume };
