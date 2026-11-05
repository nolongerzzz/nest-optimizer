/* The pieces and the measures the Whole plate checks (nso_cut_plate_test.js, nso_cut_plate_drive_check.js) are built
   from: closed solids in the raw (Z-up) frame, and the numbers read off a soup. A soup is a Float32Array of triangles,
   nine numbers each. */

/* ---- the pieces ---------------------------------------------------------- */

/* A closed solid from a simple polygon in raw (x, z), extruded along raw y by `depth`. Ear clipping: the profiles
   here are tiny. */
function extrude(poly, depth, y0) {
  y0 = y0 || 0;
  const n = poly.length, tris = [];
  const area = poly.reduce((s, p, i) => { const q = poly[(i + 1) % n]; return s + (p[0] * q[1] - q[0] * p[1]); }, 0) / 2;
  const pts = area < 0 ? poly.slice().reverse() : poly.slice();             // counter-clockwise in (x, z)
  const idx = pts.map((_, i) => i), tri2 = [];
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p, a, b, c) => cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0;
  while (idx.length > 3) {
    let cut = false;
    for (let k = 0; k < idx.length && !cut; k++) {
      const a = pts[idx[(k + idx.length - 1) % idx.length]], b = pts[idx[k]], c = pts[idx[(k + 1) % idx.length]];
      if (cross(a, b, c) <= 1e-12) continue;
      if (idx.some(j => { const p = pts[j]; return p !== a && p !== b && p !== c && inTri(p, a, b, c); })) continue;
      tri2.push([idx[(k + idx.length - 1) % idx.length], idx[k], idx[(k + 1) % idx.length]]);
      idx.splice(k, 1);
      cut = true;
    }
    if (!cut) throw new Error('ear clip stuck');
  }
  tri2.push([idx[0], idx[1], idx[2]]);
  const V = (p, y) => [p[0], y, p[1]];
  // the profile faces the -y side with outward normal -y: (x, z) counter-clockwise seen from +y reads the other way, so
  // the front (y0) is wound as is and the back is reversed; the walls follow the outline
  for (const t of tri2) {
    tris.push(V(pts[t[0]], y0), V(pts[t[2]], y0), V(pts[t[1]], y0));
    tris.push(V(pts[t[0]], y0 + depth), V(pts[t[1]], y0 + depth), V(pts[t[2]], y0 + depth));
  }
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    tris.push(V(a, y0), V(b, y0), V(b, y0 + depth), V(a, y0), V(b, y0 + depth), V(a, y0 + depth));
  }
  const out = Float32Array.from(tris.flat());
  // the profile's handedness depends on how (x, z) sit in a right-handed (x, y, z): wind whichever way makes it a solid
  return volume(out) < 0 ? windReversed(out) : out;
}
function windReversed(s) {
  const o = new Float32Array(s.length);
  for (let t = 0; t < s.length; t += 9) {
    for (let k = 0; k < 3; k++) { o[t + k] = s[t + k]; o[t + 3 + k] = s[t + 6 + k]; o[t + 6 + k] = s[t + 3 + k]; }
  }
  return o;
}
/* A T: a 5 mm pillar (x -2.5..2.5) from z 0 to `pillar`, and a 14 mm slab of `slab` on top; 5 mm deep. */
function tee(pillar, slab) {
  const t = pillar + slab;
  return extrude([[-2.5, 0], [2.5, 0], [2.5, pillar], [7, pillar], [7, t], [-7, t], [-7, pillar], [-2.5, pillar]], 5);
}
/* A standing tube along raw z: outer radius 6, bore 4, `h` tall, `n` sides. */
function tube(h, n) {
  const ring = r => Array.from({ length: n }, (_, i) => [r * Math.cos(2 * Math.PI * i / n), r * Math.sin(2 * Math.PI * i / n)]);
  const O = ring(6), I = ring(4), t = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // outer wall, outward
    t.push([O[i][0], O[i][1], 0], [O[j][0], O[j][1], 0], [O[j][0], O[j][1], h], [O[i][0], O[i][1], 0], [O[j][0], O[j][1], h], [O[i][0], O[i][1], h]);
    // bore wall, facing the axis
    t.push([I[i][0], I[i][1], 0], [I[j][0], I[j][1], h], [I[j][0], I[j][1], 0], [I[i][0], I[i][1], 0], [I[i][0], I[i][1], h], [I[j][0], I[j][1], h]);
    // bottom (facing -z) and top (facing +z) rings
    t.push([O[i][0], O[i][1], 0], [I[j][0], I[j][1], 0], [O[j][0], O[j][1], 0], [O[i][0], O[i][1], 0], [I[i][0], I[i][1], 0], [I[j][0], I[j][1], 0]);
    t.push([O[i][0], O[i][1], h], [O[j][0], O[j][1], h], [I[j][0], I[j][1], h], [O[i][0], O[i][1], h], [I[j][0], I[j][1], h], [I[i][0], I[i][1], h]);
  }
  return Float32Array.from(t.flat());
}

/* ---- the measures -------------------------------------------------------- */
function volume(s) {
  let v = 0;
  for (let t = 0; t < s.length; t += 9) {
    v += (s[t] * (s[t + 4] * s[t + 8] - s[t + 5] * s[t + 7]) - s[t + 1] * (s[t + 3] * s[t + 8] - s[t + 5] * s[t + 6]) +
          s[t + 2] * (s[t + 3] * s[t + 7] - s[t + 4] * s[t + 6])) / 6;
  }
  return v;
}
function census(s) {
  const key = o => s[o] + ',' + s[o + 1] + ',' + s[o + 2];
  const dir = new Map();
  for (let t = 0; t < s.length; t += 9) for (let e = 0; e < 3; e++) {
    const k = key(t + e * 3) + '>' + key(t + ((e + 1) % 3) * 3);
    dir.set(k, (dir.get(k) || 0) + 1);
  }
  let open = 0, nm = 0;
  dir.forEach((c, k) => {
    const [a, b] = k.split('>');
    const back = dir.get(b + '>' + a) || 0;
    if (c > 1) nm++;
    if (back !== c) open++;
  });
  return { open, nm };
}
const bounds = s => {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], s[i + k]); hi[k] = Math.max(hi[k], s[i + k]); }
  return { lo, hi };
};
const planeArea = (s, z) => {                       // the area of the faces lying on the plane z
  let a = 0;
  for (let t = 0; t < s.length; t += 9) {
    if (s[t + 2] === z && s[t + 5] === z && s[t + 8] === z) {
      a += Math.abs((s[t + 3] - s[t]) * (s[t + 7] - s[t + 1]) - (s[t + 4] - s[t + 1]) * (s[t + 6] - s[t])) / 2;
    }
  }
  return a;
};

function writeSTL(file, soup) {
  const fs = require('fs');
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
  return file;
}

module.exports = { extrude, windReversed, tee, tube, volume, census, bounds, planeArea, writeSTL };
