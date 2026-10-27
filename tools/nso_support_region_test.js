#!/usr/bin/env node
/* THE REGION PLATE'S GEOMETRY (nso_support_interface.js api.region; docs/SUPPORT-FOOTPRINT.md section 9).
     node tools/nso_support_region_test.js
     npm run support:region

   The pure functions the region plate stands on, each on a region whose answer is known: the exact distance (a block, a diagonal), the level set
   of a distance (a disk's circle), the mask smoothed (a spike goes, a block stays), the plate of a region (an outline loop, a hatch laid flush on
   a lattice fixed in the plane, the lines a line's gap short of the loop, the thin region laid in loops alone), and that the extrusion takes every
   layer of it - no overlap, no short segment, a watertight solid. Not the sheet: support:interface, support:coverage and support:plate hold that. */
'use strict';
const SI = require('../nso_support_interface.js');
const RL = require('../nso_raster_lines.js');
const R = SI.region;

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) pass++; else fail++;
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
};

const CELL = 0.1, PITCH = 0.5, WIDTH = 0.4;      // the card's, as the region plate asks for them: a line 0.4 mm wide (0.42 x SHEET_UNDER), the dense pitch 0.47 and 0.03 more
/* a raster of w x h mm with a margin of 1 mm of 0 cells all round, the cells where inside(x, y) is true set */
function raster(w, h, inside) {
  const nx = Math.round((w + 2) / CELL) + 1, ny = Math.round((h + 2) / CELL) + 1, M = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const x = i * CELL - 1, y = j * CELL - 1; if (inside(x, y)) M[j * nx + i] = 1; }
  return { M, nx, ny, ox: -1, oy: -1 };
}
const ringLen = (r) => { let s = 0; for (let k = 1; k < r.length; k++) s += Math.hypot(r[k][0] - r[k - 1][0], r[k][1] - r[k - 1][1]); return s; };
const nearestToRing = (ring, x, y) => {
  let best = Infinity;
  for (let k = 1; k < ring.length; k++) {
    const ax = ring[k - 1][0], ay = ring[k - 1][1], bx = ring[k][0], by = ring[k][1], dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y));
  }
  return best;
};

console.log('\n=== 1. edtCells: the exact distance to the nearest 0 cell, in cells ===');
{
  const nx = 11, ny = 9, M = new Uint8Array(nx * ny);
  for (let j = 2; j < 7; j++) for (let i = 2; i < 9; i++) M[j * nx + i] = 1;       // a block of 7 x 5 cells, a ring of 0 all round
  const d = R.edtCells(M, nx, ny);
  check('a 0 cell is 0', d[0] === 0 && d[1 * nx + 1] === 0);
  check('the block\'s edge cell is 1', d[2 * nx + 2] === 1 && d[4 * nx + 2] === 1);
  check('its centre cell is 3 (the nearest 0 is three rows up or down)', Math.abs(d[4 * nx + 5] - 3) < 1e-6, String(d[4 * nx + 5]));
  const e = new Uint8Array(nx * ny); e.fill(1); e[0] = 0;
  const de = R.edtCells(e, nx, ny);
  check('a diagonal is Euclid, not a chessboard: (3, 4) from the one 0 is 5', Math.abs(de[4 * nx + 3] - 5) < 1e-6, String(de[4 * nx + 3]));
  const all = new Uint8Array(nx * ny); all.fill(1);
  check('no 0 cell anywhere: far (1e6), not a crash', R.edtCells(all, nx, ny)[5] >= 1e5);
}

console.log('\n=== 2. isoLoops: the closed level sets of a field ===');
{
  const nx = 61, ny = 61, f = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) f[j * nx + i] = 20 - Math.hypot(i - 30, j - 30);       // a cone: its level 10 is the circle of radius 10 cells
  const loops = R.isoLoops(f, nx, ny, 10);
  check('one loop for a disk', loops.length === 1, String(loops.length));
  const L = loops[0] || [];
  check('closed (the first point repeated)', L.length > 3 && L[0][0] === L[L.length - 1][0] && L[0][1] === L[L.length - 1][1]);
  check('its length is the circle\'s 2 pi r within 1 %', Math.abs(ringLen(L) - 2 * Math.PI * 10) < 0.63, ringLen(L).toFixed(2));
  check('every point at the radius within 0.05 cell', L.every((p) => Math.abs(Math.hypot(p[0] - 30, p[1] - 30) - 10) < 0.05));
  const two = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) two[j * nx + i] = Math.max(8 - Math.hypot(i - 15, j - 30), 8 - Math.hypot(i - 45, j - 30));
  check('two disks apart: two loops', R.isoLoops(two, nx, ny, 3).length === 2);
}

console.log('\n=== 3. smoothMask: a stepped edge and a spike become a curve; a block stays ===');
{
  const g = raster(20, 20, (x, y) => x >= 3 && x <= 17 && y >= 3 && y <= 17);
  const sp = new Uint8Array(g.M);
  sp[(g.ny >> 1) * g.nx + 2] = 1;                          // one cell out in the margin
  const out = R.smoothMask(sp, g.nx, g.ny, 2);
  check('a one-cell spike is gone', out[(g.ny >> 1) * g.nx + 2] === 0);
  const c = ((g.ny >> 1) * g.nx) + (g.nx >> 1);
  check('the block\'s middle stays', out[c] === 1);
  let a = 0, b = 0; for (let k = 0; k < g.M.length; k++) { a += g.M[k]; b += out[k]; }
  check('the block keeps its area within 3 %', Math.abs(b - a) / a < 0.03, a + ' -> ' + b + ' cells');
}

console.log('\n=== 4. plateOfRegion: the outline, the hatch flush on its lattice, the thin region in loops alone ===');
const MINLOOP = 2.4, MINLINE = 0.9;
{
  const g = raster(30, 20, (x, y) => x >= 0 && x <= 30 && y >= 0 && y <= 20);
  const p45 = R.plateOfRegion(g.M, g.nx, g.ny, g.ox, g.oy, CELL, PITCH, WIDTH, 45, MINLOOP, MINLINE);
  const p135 = R.plateOfRegion(g.M, g.nx, g.ny, g.ox, g.oy, CELL, PITCH, WIDTH, 135, MINLOOP, MINLINE);
  check('a 30 x 20 mm rectangle: one outline loop and a hatch inside it', p45.loops.length === 1 && p45.lines.length > 20, p45.loops.length + ' loops, ' + p45.lines.length + ' lines');
  const lp = p45.loops[0].ring;
  check('the loop hugs the edge: no point more than 0.25 mm in from it, none out past it',
    lp.every((q) => { const dIn = Math.min(q[0], 30 - q[0], q[1], 20 - q[1]); return dIn > -0.06 && dIn < 0.25; }),
    'inset ' + Math.min(...lp.map((q) => Math.min(q[0], 30 - q[0], q[1], 20 - q[1]))).toFixed(2) + ' - ' + Math.max(...lp.map((q) => Math.min(q[0], 30 - q[0], q[1], 20 - q[1]))).toFixed(2));
  const gapMin = Math.min(...p45.lines.map((l) => Math.min(nearestToRing(lp, l[0][0], l[0][1]), nearestToRing(lp, l[1][0], l[1][1]))));
  check('the hatch ends a line and a gap short of the loop, never touching: centre to centre at least the width', gapMin >= WIDTH - 1e-3, gapMin.toFixed(3) + ' mm');
  const dir = (l) => Math.atan2(l[1][1] - l[0][1], l[1][0] - l[0][0]) * 180 / Math.PI;
  check('45 deg lines run at 45', p45.lines.every((l) => Math.abs(((dir(l) % 180) + 180) % 180 - 45) < 0.5));
  check('135 deg lines run at 135', p135.lines.every((l) => Math.abs(((dir(l) % 180) + 180) % 180 - 135) < 0.5));
  /* flush: the line's offset across its direction is a multiple of the pitch, in either layer: two layers of one direction stack line on line */
  const off = (l, deg) => { const t = deg * Math.PI / 180; return (-Math.sin(t) * l[0][0] + Math.cos(t) * l[0][1]) / PITCH; };
  check('lines lie on a lattice fixed in the plane (offset a whole number of pitches)', p45.lines.every((l) => Math.abs(off(l, 45) - Math.round(off(l, 45))) < 1e-6) && p135.lines.every((l) => Math.abs(off(l, 135) - Math.round(off(l, 135))) < 1e-6));
  check('no line shorter than the least', p45.lines.every((l) => Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1]) >= MINLINE - 1e-6));
  const paths = p45.loops.map((l) => l.ring).concat(p45.lines);
  const ex = RL.extrudeFlat(paths, { width: WIDTH, height: 0.2, baseZ: 0 });
  check('the extrusion takes the layer (no overlap, no short segment)', ex.ok, ex.ok ? ex.tris.length / 9 + ' triangles' : ex.reason);
  const ex2 = RL.extrudeFlat(p135.loops.map((l) => l.ring).concat(p135.lines), { width: WIDTH, height: 0.2, baseZ: 0.2 });
  check('...and the next layer, turned', ex2.ok, ex2.ok ? '' : ex2.reason);
}
{
  const g = raster(30, 1.0, (x, y) => x >= 0 && x <= 30 && y >= 0 && y <= 1.0);
  const p = R.plateOfRegion(g.M, g.nx, g.ny, g.ox, g.oy, CELL, PITCH, WIDTH, 45, MINLOOP, MINLINE);
  check('a strip 1 mm wide is too thin for a hatch: loops alone', p.lines.length === 0 && p.loops.length >= 1, p.loops.length + ' loops, ' + p.lines.length + ' lines');
  const ex = p.loops.length ? RL.extrudeFlat(p.loops.map((l) => l.ring), { width: WIDTH, height: 0.2, baseZ: 0 }) : { ok: false, reason: 'no loops' };
  check('...and the extrusion takes them', ex.ok, ex.ok ? '' : ex.reason);
}
{
  const g = raster(8, 8, (x, y) => x >= 0 && x <= 0.6 && y >= 0 && y <= 0.6);
  const p = R.plateOfRegion(g.M, g.nx, g.ny, g.ox, g.oy, CELL, PITCH, WIDTH, 45, MINLOOP, MINLINE);
  check('a 0.6 mm speck is no plate (shorter than the least loop)', p.loops.length === 0 && p.lines.length === 0);
}

console.log('\n=== 5. concentricLoops: a disk is rings a pitch apart, none touching ===');
{
  const g = raster(20, 20, (x, y) => Math.hypot(x - 10, y - 10) <= 9);
  const loops = R.concentricLoops(g.M, g.nx, g.ny, g.ox, g.oy, CELL, PITCH, WIDTH, MINLOOP);
  check('about 9 / pitch rings (within 2)', Math.abs(loops.length - Math.floor((9 - 0.1) / PITCH)) <= 2, String(loops.length));
  const byLevel = loops.slice().sort((a, b) => a.level - b.level);
  check('the first ring hugs the edge of the region (radius 9 mm: within 0.15 mm in, none out)', byLevel.length && ringLen(byLevel[0].ring) / (2 * Math.PI) <= 9.0 && ringLen(byLevel[0].ring) / (2 * Math.PI) >= 8.85, byLevel.length ? (ringLen(byLevel[0].ring) / (2 * Math.PI)).toFixed(2) : '-');
  const ex = RL.extrudeFlat(loops.map((l) => l.ring), { width: WIDTH, height: 0.2, baseZ: 0 });
  check('the extrusion takes the rings', ex.ok, ex.ok ? loops.length + ' rings' : ex.reason);
}

console.log('\n=== 6. the thin parts: a bead along a sliver the outline cannot open ===');
{
  const g = raster(30, 0.5, (x, y) => x >= 0 && x <= 30 && y >= 0 && y <= 0.5);
  const p = R.plateOfRegion(g.M, g.nx, g.ny, g.ox, g.oy, CELL, PITCH, WIDTH, 45, MINLOOP, MINLINE);
  check('a strip 0.5 mm wide: no loop opens in it, one bead runs along its middle', p.loops.length === 0 && p.thin.length === 1, p.loops.length + ' loops, ' + p.thin.length + ' beads');
  const b = p.thin[0] || [[0, 0], [0, 0]];
  check('...end to end (at least 27 of its 30 mm)', Math.abs(b[b.length - 1][0] - b[0][0]) >= 27, Math.abs(b[b.length - 1][0] - b[0][0]).toFixed(1) + ' mm');
  check('...along the middle (0.25 mm up, within 0.08)', b.every((q) => Math.abs(q[1] - 0.25) <= 0.08), b.map((q) => q[1].toFixed(2)).join(' '));
  const ex = RL.extrudeFlat(p.thin, { width: WIDTH, height: 0.2, baseZ: 0 });
  check('...and the extrusion takes it', ex.ok, ex.ok ? '' : ex.reason);
}
{
  const g = raster(20, 20, (x, y) => { const r = Math.hypot(x - 10, y - 10); return r <= 6 && r >= 4.3; });
  const p = R.plateOfRegion(g.M, g.nx, g.ny, g.ox, g.oy, CELL, PITCH, WIDTH, 45, MINLOOP, MINLINE);
  const paths = p.loops.map((l) => l.ring).concat(p.lines, p.thin);
  const ex = RL.extrudeFlat(paths, { width: WIDTH, height: 0.2, baseZ: 0 });
  check('a ring 1.7 mm wide: loops and beads, and the extrusion takes them', paths.length >= 2 && ex.ok, p.loops.length + ' loops, ' + p.thin.length + ' beads' + (ex.ok ? '' : ' - ' + ex.reason));
  check('...every centre line inside the ring (radius 4.3 - 6)', paths.every((pa) => pa.every((q) => { const r = Math.hypot(q[0] - 10, q[1] - 10); return r >= 4.3 && r <= 6; })));
  check('...the beads (not the loops) stand a half line in from either edge (radius 4.5 - 5.8)', p.thin.every((bd) => bd.every((q) => { const r = Math.hypot(q[0] - 10, q[1] - 10); return r >= 4.3 + WIDTH / 2 - 0.01 && r <= 6 - WIDTH / 2 + 0.01; })));
  check('...and a bead is a line and a gap from every loop (centre to centre 0.45 mm or more)', p.thin.every((bd) => bd.every((q) => p.loops.every((l) => nearestToRing(l.ring, q[0], q[1]) >= WIDTH + 0.05))));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
