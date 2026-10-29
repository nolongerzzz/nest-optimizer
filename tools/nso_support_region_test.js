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
  check('a strip 1 mm wide is too thin for a hatch: its loops, and rungs across the gap between them', p.loops.length >= 1 && p.lines.length >= 10, p.loops.length + ' loops, ' + p.lines.length + ' lines');
  const ex = p.loops.length ? RL.extrudeFlat(p.loops.map((l) => l.ring).concat(p.lines), { width: WIDTH, height: 0.2, baseZ: 0 }) : { ok: false, reason: 'no loops' };
  check('...and the extrusion takes them (each rung meets a loop at a node at both ends)', ex.ok, ex.ok ? '' : ex.reason);
  check('...every rung runs across the strip (within 35 degrees of square to it)', p.lines.every((l) => Math.abs(l[1][1] - l[0][1]) / Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1]) >= 0.57));
}
{
  /* a patch 2.0 mm across and 6 long (the Negative Sphere2's flat under the bowl's rim): no room for an outline and a hatch inside it, so lines across it, edge to edge, turned
     from one layer to the next - the zigzag of the slicer's own interface - and each layer extrudes */
  const g = raster(6, 2.0, (x, y) => ((x - 3) / 3) * ((x - 3) / 3) + (y - 1) * (y - 1) <= 1);
  const p45 = R.plateOfRegion(g.M, g.nx, g.ny, g.ox, g.oy, CELL, PITCH, WIDTH, 45, MINLOOP, MINLINE);
  const p135 = R.plateOfRegion(g.M, g.nx, g.ny, g.ox, g.oy, CELL, PITCH, WIDTH, 135, MINLOOP, MINLINE);
  check('a patch 2.0 mm across is laid in lines across it, no outline (three or more)', p45.loops.length === 0 && p45.lines.length >= 3 && p135.loops.length === 0 && p135.lines.length >= 3, p45.lines.length + ' / ' + p135.lines.length + ' lines');
  const dir = (pl) => { const l = pl.lines[0]; return Math.round(Math.atan2(l[1][1] - l[0][1], l[1][0] - l[0][0]) * 180 / Math.PI + 360) % 180; };
  check('...at 45 deg on one layer and 135 on the next', dir(p45) === 45 && dir(p135) === 135, dir(p45) + ' / ' + dir(p135));
  const e1 = RL.extrudeFlat(p45.lines, { width: WIDTH, height: 0.2, baseZ: 0 }), e2 = RL.extrudeFlat(p135.lines, { width: WIDTH, height: 0.2, baseZ: 0.2 });
  check('...and the extrusion takes both layers', e1.ok && e2.ok, (e1.ok ? '' : e1.reason) + (e2.ok ? '' : e2.reason));
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
{
  /* A flat face round a cavity: four bands 1.1 mm wide and four corners 2.4 across (the Negative Sphere's lower plate). The two layers (45 and 135) must lay the
     SAME kind of plate - outline loops and the hatch inside them - not loops on one and hatch lines on the next (55 / 70 % of the face held on alternate layers) */
  /* the real footprint (supp_ref's Negative Sphere, 42 mm2, centred on its cavity): the diamond's four 1.1 mm sides and its corners, a notch at the top */
  const RING = [[[-0.5,-6.35],[-0.25,-6.38],[0.0,-6.35],[0.25,-6.24],[0.34,-6.19],[0.5,-6.13],[0.75,-5.99],[5.81,-0.94],[5.86,-0.69],[6.0,-0.49],[6.03,-0.44],[6.11,-0.19],[6.13,0.06],[6.08,0.31],[6.0,0.49],[5.95,0.56],[5.93,0.81],[1.5,5.24],[1.25,5.27],[1.0,5.15],[0.75,5.06],[0.5,5.02],[0.25,5.0],[-0.75,5.0],[-1.0,5.02],[-1.24,5.06],[-1.5,5.15],[-1.75,5.27],[-2.0,5.24],[-6.43,0.81],[-6.45,0.56],[-6.5,0.49],[-6.57,0.31],[-6.62,0.06],[-6.61,-0.19],[-6.52,-0.44],[-6.5,-0.49],[-6.35,-0.69],[-6.3,-0.94],[-1.25,-5.99],[-1.0,-6.13],[-0.83,-6.19],[-0.75,-6.24]],[[-0.75,-3.97],[-0.95,-3.94],[-1.0,-3.93],[-1.25,-3.87],[-1.5,-3.79],[-1.75,-3.7],[-1.79,-3.69],[-2.0,-3.6],[-2.25,-3.46],[-2.29,-3.44],[-2.5,-3.31],[-2.66,-3.19],[-2.75,-3.12],[-2.96,-2.94],[-3.0,-2.9],[-3.21,-2.69],[-3.25,-2.64],[-3.41,-2.44],[-3.5,-2.33],[-3.59,-2.19],[-3.74,-1.94],[-3.75,-1.93],[-3.87,-1.69],[-3.98,-1.44],[-4.0,-1.39],[-4.06,-1.19],[-4.13,-0.94],[-4.19,-0.69],[-4.22,-0.44],[-4.24,-0.19],[-4.24,0.06],[-4.23,0.31],[-4.2,0.56],[-4.16,0.81],[-4.1,1.06],[-4.02,1.31],[-4.0,1.39],[-3.92,1.56],[-3.81,1.81],[-3.75,1.93],[-3.67,2.06],[-3.51,2.31],[-3.5,2.33],[-3.32,2.56],[-3.25,2.64],[-3.09,2.81],[-3.0,2.9],[-2.82,3.06],[-2.75,3.12],[-2.5,3.31],[-2.48,3.31],[-2.25,3.46],[-2.06,3.56],[-2.0,3.6],[-1.75,3.71],[-1.5,3.8],[-1.44,3.81],[-1.25,3.87],[-1.0,3.93],[-0.75,3.96],[-0.5,3.99],[-0.25,4.0],[0.0,3.99],[0.25,3.96],[0.5,3.93],[0.75,3.87],[0.95,3.81],[1.0,3.8],[1.25,3.71],[1.5,3.6],[1.56,3.56],[1.75,3.46],[1.99,3.31],[2.0,3.31],[2.25,3.12],[2.33,3.06],[2.5,2.9],[2.59,2.81],[2.75,2.64],[2.83,2.56],[3.0,2.33],[3.02,2.31],[3.18,2.06],[3.25,1.93],[3.31,1.81],[3.43,1.56],[3.5,1.39],[3.53,1.31],[3.61,1.06],[3.67,0.81],[3.71,0.56],[3.74,0.31],[3.75,0.06],[3.74,-0.19],[3.73,-0.44],[3.69,-0.69],[3.64,-0.94],[3.57,-1.19],[3.5,-1.39],[3.48,-1.44],[3.38,-1.69],[3.25,-1.93],[3.25,-1.94],[3.1,-2.19],[3.0,-2.33],[2.92,-2.44],[2.75,-2.64],[2.71,-2.69],[2.5,-2.9],[2.46,-2.94],[2.25,-3.12],[2.17,-3.19],[2.0,-3.31],[1.79,-3.44],[1.75,-3.46],[1.5,-3.6],[1.29,-3.69],[1.25,-3.7],[1.0,-3.79],[0.75,-3.87],[0.5,-3.93],[0.45,-3.94],[0.25,-3.97],[0.0,-3.99],[-0.25,-4.0],[-0.5,-3.99]]];
  const inRing = (x, y) => { let c = false; for (const L of RING) for (let q = 0, w = L.length - 1; q < L.length; w = q++) if ((L[q][1] > y) !== (L[w][1] > y) && x < (L[w][0] - L[q][0]) * (y - L[q][1]) / (L[w][1] - L[q][1]) + L[q][0]) c = !c; return c; };
  const g = raster(20, 20, (x, y) => inRing(x - 10, y - 10));
  const Ms = R.smoothMask(g.M, g.nx, g.ny, 1);           /* as the plate's layer loop reads it, at the cavity's place on the plate (the hatch's lattice is fixed in the plane, so where it falls matters), with the card's pitch 0.46 + 0.03 and line 0.42 */
  const p45 = R.plateOfRegion(Ms, g.nx, g.ny, g.ox + 118, g.oy + 58, CELL, 0.49, 0.42, 45, MINLOOP, 0.9);
  const p135 = R.plateOfRegion(Ms, g.nx, g.ny, g.ox + 118, g.oy + 58, CELL, 0.49, 0.42, 135, MINLOOP, 0.9);
  const total = (p) => p.loops.reduce((a, l) => a + l.lenMm, 0) + p.lines.reduce((a, l) => a + Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1]), 0) + p.thin.reduce((a, pt) => { let q = 0; for (let k = 1; k < pt.length; k++) q += Math.hypot(pt[k][0] - pt[k - 1][0], pt[k][1] - pt[k - 1][1]); return a + q; }, 0);
  check('a ring of narrow bands and wide corners: outline loops and hatch lines on both layers', p45.loops.length >= 1 && p135.loops.length >= 1 && p45.lines.length >= 3 && p135.lines.length >= 3, p45.loops.length + '/' + p135.loops.length + ' loops, ' + p45.lines.length + '/' + p135.lines.length + ' lines');
  /* the share of the face the beads hold (a bead a line wide about each path) - Bambu's plate round this cavity holds 80 % (79 - 94) */
  const held = (p) => {
    const segs = []; p.loops.forEach((l) => { for (let k = 0; k + 1 < l.ring.length; k++) segs.push([l.ring[k], l.ring[k + 1]]); }); p.lines.forEach((l) => segs.push(l)); p.thin.forEach((pt) => { for (let k = 0; k + 1 < pt.length; k++) segs.push([pt[k], pt[k + 1]]); });
    const dseg = (x, y, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2)) : 0; return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy); };
    let tot = 0, hit = 0;
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) if (Ms[j * g.nx + i]) { tot++; const x = g.ox + 118 + i * CELL, y = g.oy + 58 + j * CELL; if (segs.some((s2) => dseg(x, y, s2[0], s2[1]) <= 0.21)) hit++; }
    return hit / tot;
  };
  check('...each holding 70 % of the face or more (the hatch inside the loops held 56 and 61 %; Bambu\'s 80)', held(p45) >= 0.7 && held(p135) >= 0.7, (held(p45) * 100).toFixed(0) + ' / ' + (held(p135) * 100).toFixed(0) + ' %');
  check('...the rungs lie across the bands, on the loops\' own vertices (the extrusion takes the layer)', RL.extrudeFlat(p45.loops.map((l) => l.ring).concat(p45.lines, p45.thin), { width: 0.42, height: 0.2, baseZ: 0 }).ok && RL.extrudeFlat(p135.loops.map((l) => l.ring).concat(p135.lines, p135.thin), { width: 0.42, height: 0.2, baseZ: 0.2 }).ok);
  check('...and both layers lay about the same length (within 20 %)', Math.abs(total(p45) - total(p135)) <= 0.2 * Math.max(total(p45), total(p135)), total(p45).toFixed(1) + ' / ' + total(p135).toFixed(1) + ' mm');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
