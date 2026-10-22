/* Fixtures for foamBox (nso_foam.js), generated here rather than stored, each
   with the numbers a test needs worked out from the shape, not measured.

   Raw soup, Z up, mm, wound outward.

     slantCup(n)      a round cup (n sides, Ø30, 2 mm wall, 2 mm floor) whose rim
                      is cut by the slanted plane z = 20 + 0.3 x. Its bowl is
                      buried up to the inner rim's lowest corner, 16.1 mm - above
                      that the wall is open on one side. Every inner wall is one
                      tall quad, so the fill has to cut them at that height.
     stepCup()        the 30 mm voxel cup (nso_foam_fixtures cup) with a rim that
                      steps up from 20 mm on the -X wall to 28 mm on the +X wall
     composite()      a 30 mm voxel cup with a 6 mm floor, a 10 x 10 x 2 sealed
                      void inside the floor and a 6 x 6 post standing on the floor
                      up past the rim to 40 mm
     vase(n, m)       a thin-walled flared vase (n around, m up) with a wavy rim
                      and bumps on its outside, for timing
*/
'use strict';

const FX = require('./nso_foam_fixtures.js');
const f32 = a => new Float32Array(a);

/* A round cup: outer radius R, inner r, floor at `floor`, rim on top(x, y). */
function roundCup(n, R, r, floor, top) {
  const out = [];
  const P = (rad, i, z) => { const t = 2 * Math.PI * i / n; return [rad * Math.cos(t), rad * Math.sin(t), z]; };
  const tri = (a, b, c) => out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  const bc = [0, 0, 0], fc = [0, 0, floor];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ob0 = P(R, i, 0), ob1 = P(R, j, 0);
    const ot0 = P(R, i, 0), ot1 = P(R, j, 0);
    ot0[2] = top(ot0[0], ot0[1]); ot1[2] = top(ot1[0], ot1[1]);
    const ib0 = P(r, i, floor), ib1 = P(r, j, floor);
    const it0 = P(r, i, 0), it1 = P(r, j, 0);
    it0[2] = top(it0[0], it0[1]); it1[2] = top(it1[0], it1[1]);
    tri(bc, ob1, ob0);                                     // bottom, facing -Z
    tri(ob0, ob1, ot1); tri(ob0, ot1, ot0);               // outer wall
    tri(ot0, ot1, it1); tri(ot0, it1, it0);               // rim
    tri(ib0, it0, it1); tri(ib0, it1, ib1);               // inner wall, facing the bowl
    tri(fc, ib0, ib1);                                     // floor, facing +Z
  }
  return out;
}

function slantCup(n) {
  n = n || 48;
  const R = 15, r = 13, floor = 2, z0 = 20, k = 0.3;
  if (n % 2) throw new Error('slantCup: n must be even, so a corner sits at the lowest point of the rim');
  return { soup: f32(roundCup(n, R, r, floor, (x) => z0 + k * x)),
           opening: z0 - k * r,                           // the inner rim's lowest corner
           bowlArea: FX.ngonArea(r, n), floor, R, r, rimTop: z0 + k * R };
}

/* Voxel cups on 2 mm cells, 15 x 15 columns, origin (-15, -15, 0). */
function voxelCup(heightOf, floorCells, extra, missing) {
  const c = [], skip = new Set((missing || []).map(x => x.join(',')));
  for (let i = 0; i < 15; i++) for (let j = 0; j < 15; j++) {
    const wall = i === 0 || j === 0 || i === 14 || j === 14;
    const top = wall ? heightOf(i, j) : floorCells;
    for (let k = 0; k < top; k++) if (!skip.has(i + ',' + j + ',' + k)) c.push([i, j, k]);
  }
  for (const e of extra || []) c.push(e);
  return c;
}

function stepCup() {
  // wall height in cells: 10 on the -X wall, rising one cell every 3 columns to 14 at +X
  const cells = voxelCup((i) => 10 + Math.floor(i / 3), 1);
  return { soup: f32(FX.voxelTris(cells, 2, [-15, -15, 0], false)), cells,
           opening: 20, bowl: 26 * 26 * (20 - 2) };
}

function composite() {
  const missing = [], post = [];
  for (let i = 5; i < 10; i++) for (let j = 5; j < 10; j++) missing.push([i, j, 1]);
  for (let i = 6; i < 9; i++) for (let j = 6; j < 9; j++) for (let k = 3; k < 20; k++) post.push([i, j, k]);
  const cells = voxelCup(() => 15, 3, post, missing);
  return { soup: f32(FX.voxelTris(cells, 2, [-15, -15, 0], false)), cells,
           volume: cells.length * 8,
           filled: (15 * 15 * 15 + 9 * 5) * 8,               // the cup solid to its rim, the post above it
           voidVolume: 25 * 8, bowl: (26 * 26 * 24) - (6 * 6 * 24) };
}

/* A thin-walled vase on n x m quads a side: radius 30 at the foot flaring to
   45, a 1.2 mm wall, a 3 mm floor, a rim that waves 3 mm up and down five
   times round, and twelve bumps on the outside. */
function vase(n, m) {
  n = n || 720; m = m || 500;
  const H = 150, wall = 1.2, floor = 3;
  const radius = (t, z) => 30 + 15 * Math.sin(Math.PI * 0.5 * z / H) + 4 * Math.sin(3 * Math.PI * z / H);
  const bump = (t, z) => {
    let b = 0;
    for (let q = 0; q < 12; q++) {
      const tc = 2 * Math.PI * q / 12, zc = 30 + 90 * ((q * 7) % 12) / 12;
      let dt = Math.abs(t - tc); if (dt > Math.PI) dt = 2 * Math.PI - dt;
      const d2 = (dt * 40) * (dt * 40) + (z - zc) * (z - zc);
      b += 2.5 * Math.exp(-d2 / 50);
    }
    return b;
  };
  const rimZ = t => H + 3 * Math.sin(5 * t);
  const out = [];
  const tri = (a, b, c) => out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  const O = [], I = [];
  for (let k = 0; k <= m; k++) {
    O.push([]); I.push([]);
    for (let i = 0; i < n; i++) {
      const t = 2 * Math.PI * i / n, top = rimZ(t);
      const zo = top * k / m, zi = floor + (top - floor) * k / m;
      const ro = radius(t, zo) + bump(t, zo), ri = radius(t, zi) - wall;
      O[k].push([ro * Math.cos(t), ro * Math.sin(t), zo]);
      I[k].push([ri * Math.cos(t), ri * Math.sin(t), zi]);
    }
  }
  const bc = [0, 0, 0], fc = [0, 0, floor];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(bc, O[0][j], O[0][i]);
    tri(fc, I[0][i], I[0][j]);
    for (let k = 0; k < m; k++) {
      tri(O[k][i], O[k][j], O[k + 1][j]); tri(O[k][i], O[k + 1][j], O[k + 1][i]);
      tri(I[k][i], I[k + 1][i], I[k + 1][j]); tri(I[k][i], I[k + 1][j], I[k][j]);
    }
    tri(O[m][i], O[m][j], I[m][j]); tri(O[m][i], I[m][j], I[m][i]);
  }
  let lowRim = Infinity;
  for (let i = 0; i < n; i++) lowRim = Math.min(lowRim, I[m][i][2]);
  return { soup: f32(out), height: H + 3, lowRim };
}

module.exports = { roundCup, slantCup, stepCup, composite, vase };
