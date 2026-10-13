/* Fixtures for Foam (nso_foam.js), generated here rather than stored, the
   way tools/nso_lift_fixtures.js makes Lift's. Each comes with the numbers a
   test needs to check it independently of the code under test: the cavity's
   volume below any level is worked out from the shapes, not measured.

   Raw soup, Z up, mm. Outer shells wound outward, cavity shells inward.

     box1()        a 40 mm cube round one 30 x 30 x 30 box cavity
     box2()        a 60 x 30 x 30 block round two box cavities of different
                   heights (24 mm and 10 mm)
     stepped()     a Ø40 x 40 cylinder (48 sides) round a stepped cavity: a
                   chamber at the bottom and two chimneys of different
                   heights rising from it - above the chamber, two pockets
     round()       a Ø30 x 40 cylinder round a Ø24 x 34 cylindrical cavity
     captive()     a 40 mm cube round a 30 mm cavity with a 10 mm cube held
                   loose inside it (outward-wound: a rattle, not a cavity)
     cup()         a 30 mm cup open at the top - one shell
     solid()       a plain 20 mm cube
*/
'use strict';

/* ---- boxes ---- */

// Triangles of an axis box [lo, hi], wound outward (or inward).
function boxTris(lo, hi, inward) {
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
             [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]];
  const out = [];
  for (const q of quads) {
    const t = [[q[0], q[1], q[2]], [q[0], q[2], q[3]]];
    for (const tri of t) {
      const o = inward ? [tri[0], tri[2], tri[1]] : tri;
      for (const i of o) out.push(v[i][0], v[i][1], v[i][2]);
    }
  }
  return out;
}

/* ---- voxels ---- */

// The boundary of a set of unit cells, one quad per exposed cell face, so
// every face meets its neighbours edge to edge. cells: array of [i, j, k];
// cell (i, j, k) spans origin + unit * [i, i+1] etc. No two cells may meet
// along an edge only.
function voxelTris(cells, unit, origin, inward) {
  const set = new Set(cells.map(c => c.join(',')));
  const has = (i, j, k) => set.has(i + ',' + j + ',' + k);
  const P = (i, j, k) => [origin[0] + i * unit, origin[1] + j * unit, origin[2] + k * unit];
  const out = [];
  function quad(a, b, c, d) {
    const tris = [[a, b, c], [a, c, d]];
    for (const t of tris) {
      const o = inward ? [t[0], t[2], t[1]] : t;
      for (const p of o) out.push(p[0], p[1], p[2]);
    }
  }
  for (const [i, j, k] of cells) {
    if (!has(i, j, k - 1)) quad(P(i, j, k), P(i, j + 1, k), P(i + 1, j + 1, k), P(i + 1, j, k));
    if (!has(i, j, k + 1)) quad(P(i, j, k + 1), P(i + 1, j, k + 1), P(i + 1, j + 1, k + 1), P(i, j + 1, k + 1));
    if (!has(i, j - 1, k)) quad(P(i, j, k), P(i + 1, j, k), P(i + 1, j, k + 1), P(i, j, k + 1));
    if (!has(i, j + 1, k)) quad(P(i, j + 1, k), P(i, j + 1, k + 1), P(i + 1, j + 1, k + 1), P(i + 1, j + 1, k));
    if (!has(i - 1, j, k)) quad(P(i, j, k), P(i, j, k + 1), P(i, j + 1, k + 1), P(i, j + 1, k));
    if (!has(i + 1, j, k)) quad(P(i + 1, j, k), P(i + 1, j + 1, k), P(i + 1, j + 1, k + 1), P(i + 1, j, k + 1));
  }
  return out;
}

// Volume of a cell set below the plane z = L.
function voxelBelow(cells, unit, origin, L) {
  let v = 0;
  for (const c of cells) {
    const z0 = origin[2] + c[2] * unit;
    v += unit * unit * Math.max(0, Math.min(unit, L - z0));
  }
  return v;
}

/* ---- prisms ---- */

// A closed n-gon prism about the Z axis through (cx, cy), from z0 to z1.
function prismTris(r, z0, z1, n, inward, cx, cy) {
  cx = cx || 0; cy = cy || 0;
  const ring = [];
  for (let i = 0; i < n; i++) {
    const t = 2 * Math.PI * i / n;
    ring.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  const out = [];
  function tri(a, b, c) {
    const o = inward ? [a, c, b] : [a, b, c];
    for (const p of o) out.push(p[0], p[1], p[2]);
  }
  const bc = [cx, cy, z0], tc = [cx, cy, z1];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const a0 = [a[0], a[1], z0], b0 = [b[0], b[1], z0], a1 = [a[0], a[1], z1], b1 = [b[0], b[1], z1];
    tri(bc, b0, a0);
    tri(tc, a1, b1);
    tri(a0, b0, b1);
    tri(a0, b1, a1);
  }
  return out;
}
function ngonArea(r, n) { return 0.5 * n * r * r * Math.sin(2 * Math.PI / n); }

const f32 = a => new Float32Array(a);

/* ---- the pieces ---- */

function box1() {
  return { soup: f32(boxTris([-20, -20, -20], [20, 20, 20], false).concat(boxTris([-15, -15, -15], [15, 15, 15], true))),
           cavities: [{ lo: [-15, -15, -15], hi: [15, 15, 15] }] };
}

function box2() {
  const A = { lo: [-25, -10, -12], hi: [-5, 10, 12] };   // 24 tall
  const B = { lo: [5, -10, -12], hi: [25, 10, -2] };     // 10 tall, same floor
  return { soup: f32(boxTris([-30, -15, -15], [30, 15, 15], false)
                     .concat(boxTris(A.lo, A.hi, true), boxTris(B.lo, B.hi, true))),
           cavities: [A, B] };
}

/* A box cavity's volume below the plane n.p = L, for a plane that crosses
   only its vertical edges (n has no y part): the cavity's footprint times the
   plane's mean height over it, less the floor. */
function boxBelow(c, n, L) {
  const [x0, y0, z0] = c.lo, [x1, y1, z1] = c.hi;
  if (n[1] !== 0) throw new Error('boxBelow: n must have no y part');
  const zAt = x => (L - n[0] * x) / n[2];
  const zl = zAt(x0), zr = zAt(x1);
  if (Math.min(zl, zr) < z0 || Math.max(zl, zr) > z1) throw new Error('boxBelow: the plane leaves the walls');
  return (x1 - x0) * (y1 - y0) * ((zl + zr) / 2 - z0);
}

// Stepped: unit 2 mm cells. Chamber i 0..7 (x -8..8), j 0..3 (y -4..4),
// k 0..2 (z 4..10). Left chimney i 0..2 (x -8..-2), k 3..9 (z 10..24);
// right chimney i 5..7 (x 2..8), k 3..6 (z 10..18).
function steppedCells() {
  const c = [];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 3; k++) c.push([i, j, k]);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) for (let k = 3; k < 10; k++) c.push([i, j, k]);
  for (let i = 5; i < 8; i++) for (let j = 0; j < 4; j++) for (let k = 3; k < 7; k++) c.push([i, j, k]);
  return c;
}
const STEP = { unit: 2, origin: [-8, -4, 4] };
function stepped() {
  const cells = steppedCells();
  return { soup: f32(prismTris(20, 0, 40, 48, false).concat(voxelTris(cells, STEP.unit, STEP.origin, true))),
           cells, unit: STEP.unit, origin: STEP.origin,
           below: L => voxelBelow(cells, STEP.unit, STEP.origin, L),
           // the right chimney alone, and the left alone
           left: cells.filter(c => c[0] < 3 && c[2] >= 3), right: cells.filter(c => c[0] >= 5 && c[2] >= 3) };
}

function round() {
  const n = 48, r = 12;
  return { soup: f32(prismTris(15, 0, 40, n, false).concat(prismTris(r, 3, 37, n, true))),
           area: ngonArea(r, n), lo: 3, hi: 37 };
}

function captive() {
  return { soup: f32(boxTris([-20, -20, -20], [20, 20, 20], false)
                     .concat(boxTris([-15, -15, -15], [15, 15, 15], true), boxTris([-5, -5, -5], [5, 5, 5], false))),
           cavity: { lo: [-15, -15, -15], hi: [15, 15, 15] }, ball: { lo: [-5, -5, -5], hi: [5, 5, 5] } };
}

// A cup: 30 x 30 x 30 of 2 mm cells, walls and floor one cell thick, open top.
function cup() {
  const c = [];
  for (let i = 0; i < 15; i++) for (let j = 0; j < 15; j++) for (let k = 0; k < 15; k++) {
    const wall = i === 0 || j === 0 || i === 14 || j === 14 || k === 0;
    if (wall) c.push([i, j, k]);
  }
  return { soup: f32(voxelTris(c, 2, [-15, -15, 0], false)) };
}

function solid() { return { soup: f32(boxTris([-10, -10, -10], [10, 10, 10], false)) }; }

module.exports = { boxTris, voxelTris, voxelBelow, prismTris, ngonArea, boxBelow,
                   box1, box2, stepped, round, captive, cup, solid };
