// Watertightness / manifold analyzer for a binary or ASCII STL.
// Usage: node tools/stl_watertight.mjs <file.stl> [weldTol]
// Reports: triangle count, boundary edges (used once), non-manifold edges
// (used 3+), and whether the mesh is closed (every undirected edge used twice).
import fs from 'fs';

const file = process.argv[2];
const tol = Number(process.argv[3] || 1e-3);
if (!file) { console.error('usage: node tools/stl_watertight.mjs <file.stl> [weldTol]'); process.exit(2); }

const buf = fs.readFileSync(file);

function parseBinary(buf) {
  const tris = [];
  const n = buf.readUInt32LE(80);
  let o = 84;
  for (let i = 0; i < n; i++) {
    o += 12; // normal
    const t = [];
    for (let k = 0; k < 3; k++) {
      t.push([buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)]);
      o += 12;
    }
    o += 2; // attribute
    tris.push(t);
  }
  return tris;
}
function parseAscii(text) {
  const tris = [];
  const nums = [];
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let m;
  while ((m = re.exec(text))) nums.push([parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]);
  for (let i = 0; i + 2 < nums.length; i += 3) tris.push([nums[i], nums[i + 1], nums[i + 2]]);
  return tris;
}

const isAscii = buf.slice(0, 5).toString('ascii').toLowerCase() === 'solid' &&
  !buf.slice(0, 512).includes(0);
const tris = isAscii ? parseAscii(buf.toString('ascii')) : parseBinary(buf);

const key = p => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)},${Math.round(p[2] / tol)}`;
const edge = new Map();
const dir = new Map();
let degenerate = 0;
for (const t of tris) {
  // skip zero-area
  const [a, b, c] = t;
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
  if (nx * nx + ny * ny + nz * nz < 1e-12) { degenerate++; continue; }
  for (let i = 0; i < 3; i++) {
    const ka = key(t[i]), kb = key(t[(i + 1) % 3]);
    const ek = ka < kb ? ka + '|' + kb : kb + '|' + ka;
    edge.set(ek, (edge.get(ek) || 0) + 1);
    const dk = ka + '>' + kb;
    dir.set(dk, (dir.get(dk) || 0) + 1);
  }
}
let boundary = 0, nonmanifold = 0;
for (const c of edge.values()) { if (c === 1) boundary++; else if (c !== 2) nonmanifold++; }
let flipped = 0;
for (const c of dir.values()) if (c > 1) flipped++;

const closed = boundary === 0 && nonmanifold === 0;
console.log(JSON.stringify({
  file, triangles: tris.length, degenerate,
  uniqueEdges: edge.size, boundaryEdges: boundary, nonManifoldEdges: nonmanifold,
  repeatedDirectedEdges: flipped,
  watertight: closed,
  consistentlyOriented: closed && flipped === 0,
}, null, 2));
process.exit(closed ? 0 : 1);
