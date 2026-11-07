#!/usr/bin/env node
/* Custom shape, headless: nso_custom_shape.js's outlines and meshes against figures worked out by hand.
     node tools/nso_custom_shape_test.js        exit 0 = every gate held

   1. every preset in every mode is CLOSED: each directed edge is met by its reverse exactly once (an exact-bit weld), and the
      mesh's signed volume is the engine's own area x height figure
   2. a sharp rectangle with a DIFFERENT WALL ON EVERY SIDE leaves exactly the inside it should: (W - wL - wR) x (D - wB - wT)
   3. a rounded rectangle's area is W*D - (4 - pi) r^2 to the chord tolerance, inside and out (inside at r - wall: concentric)
   4. a side's CURVE is a true arc: a stadium (two sides bulged by half their length) is W*D + pi*(D/2)^2
   5. the winding the points are given in does not matter: clockwise and counter-clockwise make the same piece
   6. Inner R: auto keeps the wall round an outside corner (r - wall) and an inside one (r + wall); a typed one is used as typed
   7. the refusals say what is wrong in words and name the point or side, counting from 1 in the order given
   8. maxRadius is the most a corner's sides have room for, with its neighbours as they are
   9. a wall under 2 nozzle widths is made, with a warning */

const CS = require('../nso_custom_shape.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function topo(s) {
  const key = i => s[i] + ',' + s[i + 1] + ',' + s[i + 2];
  const E = new Map();
  for (let t = 0; t < s.length; t += 9) {
    const v = [key(t), key(t + 3), key(t + 6)];
    for (let k = 0; k < 3; k++) { const e = v[k] + '|' + v[(k + 1) % 3]; E.set(e, (E.get(e) || 0) + 1); }
  }
  let open = 0, multi = 0;
  for (const [e, c] of E) { const [a, b] = e.split('|'); if ((E.get(b + '|' + a) || 0) !== c) open++; if (c > 1) multi++; }
  return { open, multi };
}
function volume(s) {
  let v = 0;
  for (let i = 0; i < s.length; i += 9)
    v += (s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) + s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6])) / 6;
  return v;
}
const rect = (W, D, r, walls) => ({
  points: [{ x: 0, y: 0, r }, { x: W, y: 0, r }, { x: W, y: D, r }, { x: 0, y: D, r }],
  sides: (walls || [2, 2, 2, 2]).map(w => ({ wall: w, bulge: 0 })), height: 20, floor: 2, mode: 'tray'
});

console.log('1. every preset, every mode: closed, and its volume is area x height');
for (const name of CS.PRESETS) for (const mode of CS.MODES) {
  const sp = CS.preset(name); sp.mode = mode;
  const r = CS.make(sp);
  if (!r.ok) { check(name + ' ' + mode, false, r.reason); continue; }
  const t = topo(r.soup), v = volume(r.soup);
  check(name + ' ' + mode + ' closed', t.open === 0 && t.multi === 0, JSON.stringify(t));
  check(name + ' ' + mode + ' volume', near(v, r.info.volume, 1e-3 * r.info.volume), v.toFixed(2) + ' vs ' + r.info.volume.toFixed(2));
}

console.log('2. a different wall on every side');
{
  const r = CS.make(rect(80, 50, 0, [2, 4, 6, 8]));
  check('made', r.ok, r.reason);
  check('inside is 68 x 42', near(r.info.areaIn, 68 * 42, 1e-6), r.info.areaIn);
  check('thinnest wall is the thinnest side, 2', near(r.info.minWall, 2, 1e-9), r.info.minWall);
  const xs = r.inner.map(p => p[0]), ys = r.inner.map(p => p[1]);
  /* the mesh is centred on the footprint: the outline spans -40..40 x -25..25 */
  check('left wall 8, right wall 4', near(Math.min(...xs), -32, 1e-6) && near(Math.max(...xs), 36, 1e-6), Math.min(...xs) + '..' + Math.max(...xs));
  check('bottom wall 2, top wall 6', near(Math.min(...ys), -23, 1e-6) && near(Math.max(...ys), 19, 1e-6), Math.min(...ys) + '..' + Math.max(...ys));
  const v = volume(r.soup);
  check('volume = 80*50*20 - 68*42*18', near(v, 80 * 50 * 20 - 68 * 42 * 18, 1e-3), v);
}

console.log('3. a rounded rectangle, inside and out');
{
  const R = 8, w = 2, r = CS.make(rect(80, 50, R));
  const out = 80 * 50 - (4 - Math.PI) * R * R, inn = 76 * 46 - (4 - Math.PI) * (R - w) * (R - w);
  /* chords inscribe the arc: under by at most (perimeter of the arcs) x tolerance */
  check('outside area', out - r.info.areaOut >= 0 && out - r.info.areaOut < 2 * Math.PI * R * 0.02, (out - r.info.areaOut).toFixed(4));
  check('inside area (concentric, r - wall)', inn - r.info.areaIn >= 0 && inn - r.info.areaIn < 2 * Math.PI * R * 0.02, (inn - r.info.areaIn).toFixed(4));
  check('auto Inner R is 6', r.ok && near(CS.outline(rect(80, 50, R)).corners[0].rIn, 6, 1e-9));
}

console.log('4. a curved side is a true arc');
{
  const sp = rect(80, 50, 0); sp.sides[1].bulge = 25; sp.sides[3].bulge = 25; sp.mode = 'solid';
  const r = CS.make(sp), want = 80 * 50 + Math.PI * 25 * 25;
  check('stadium area W*D + pi*(D/2)^2', r.ok && want - r.info.areaOut >= 0 && want - r.info.areaOut < 2 * Math.PI * 25 * 0.02, r.ok && (want - r.info.areaOut).toFixed(4));
  check('stadium is 130 long', r.ok && near(r.info.width, 130, 1e-6), r.ok && r.info.width);
  const sp2 = rect(80, 50, 0); sp2.sides[0].bulge = -10;
  const h = 40, s = 10, R = (h * h + s * s) / (2 * s), seg = R * R * Math.asin(h / R) - h * (R - s);
  const r2 = CS.make(Object.assign(sp2, { mode: 'solid' }));
  check('a side bowed IN takes the circular segment off', r2.ok && near(r2.info.areaOut, 4000 - seg, 2 * R * 0.02 * 2), r2.ok && (r2.info.areaOut - (4000 - seg)).toFixed(4));
  const sp3 = rect(80, 50, 3); sp3.sides[1].bulge = 25; sp3.sides[3].bulge = 25;
  const r3 = CS.make(sp3);
  check('a curved side walled and rounded is closed', r3.ok && topo(r3.soup).open === 0, r3.reason);
}

console.log('5. winding does not matter');
{
  const sp = CS.preset('scoop'), n = sp.points.length;
  const cw = Object.assign({}, sp, { points: sp.points.slice().reverse(), sides: [] });
  for (let i = 0; i < n; i++) cw.sides.push(sp.sides[((n - 2 - i) % n + n) % n]);   // reversed: side i is the old side n-2-i
  const a = CS.make(sp), b = CS.make(cw);
  check('same volume either way', a.ok && b.ok && near(a.info.volume, b.info.volume, 1e-6), a.ok && b.ok && a.info.volume + ' / ' + b.info.volume);
  const sp2 = rect(80, 50, 40); sp2.points.reverse();
  const r = CS.make(sp2);
  /* given clockwise, side 2 runs from point 2 (80, 50) to point 3 (80, 0): 50 long */
  check('a refusal on clockwise points names them as given', !r.ok && /points 2 and 3/.test(r.reason) && /side 2 \(50 mm/.test(r.reason), r.reason);
}

console.log('6. Inner R');
{
  const L = CS.preset('lshape');
  L.points.forEach(p => { p.r = 4; });
  const o = CS.outline(L);
  check('outside corner: r - wall', near(o.corners[0].rIn, 2, 1e-9), o.corners[0].rIn);
  check('the turned-in corner (point 4): r + wall', o.corners[3].convex === false && near(o.corners[3].rIn, 6, 1e-9), JSON.stringify(o.corners[3]));
  L.points[3].rIn = 1;
  check('a typed Inner R is used', near(CS.outline(L).corners[3].rIn, 1, 1e-9));
  const sharp = rect(80, 50, 0);
  check('a sharp outside corner has a sharp inside', near(CS.outline(sharp).corners[2].rIn, 0, 1e-9));
}

console.log('7. refusals, in words');
{
  const why = sp => { const r = CS.make(sp); return r.ok ? '(made)' : r.reason; };
  let sp = rect(80, 50, 0); sp.points = sp.points.slice(0, 2); sp.sides = sp.sides.slice(0, 2);
  check('2 points', /at least 3 points/.test(why(sp)), why(sp));
  sp = rect(80, 50, 30);
  check('radii too big name the side and what fits', /points 2 and 3/.test(why(sp)) && /side 2/.test(why(sp)) && /20 mm/.test(why(sp)), why(sp));
  sp = rect(80, 50, 0); sp.points[1] = { x: 0, y: 0, r: 0 };
  check('points on top of each other', /on top of each other/.test(why(sp)), why(sp));
  sp = rect(80, 50, 0); sp.points = [{ x: 0, y: 0 }, { x: 80, y: 50 }, { x: 80, y: 0 }, { x: 0, y: 50 }].map(p => Object.assign(p, { r: 0 }));
  check('a figure of eight', /no area|crosses itself/.test(why(sp)), why(sp));
  sp = { points: [{ x: 0, y: 0, r: 0 }, { x: 60, y: 0, r: 0 }, { x: 60, y: 40, r: 0 }, { x: 30, y: 10, r: 0 }, { x: 0, y: 40, r: 0 }], sides: [0, 0, 0, 0, 0].map(() => ({ wall: 2 })), mode: 'solid', height: 5 };
  sp.points[3] = { x: 30, y: -10, r: 0 };
  check('an outline that crosses itself', /crosses itself/.test(why(sp)), why(sp));
  sp = rect(80, 50, 0, [30, 30, 30, 30]);
  check('walls that meet in the middle', /room|meet in the middle/.test(why(sp)), why(sp));
  sp = rect(80, 50, 0); sp.sides[0].bulge = 100;
  check('a curve longer than its side', /side 1's curve/.test(why(sp)), why(sp));
  sp = rect(80, 50, 0); sp.floor = 20;
  check('a floor as thick as the tray is tall', /floor/.test(why(sp)) && /Solid/.test(why(sp)), why(sp));
  sp = CS.preset('scoop'); sp.sides[4].wall = 6;
  check('unequal walls at a near-tangent curved corner', /point 1/.test(why(sp)) && /walls differ/.test(why(sp)), why(sp));
}

console.log('8. maxRadius');
{
  const sp = rect(80, 50, 0);
  check('one corner alone: the shorter side, 50', near(CS.maxRadius(sp, 0), 50, 0.01), CS.maxRadius(sp, 0));
  sp.points.forEach(p => { p.r = 10; });
  check('beside corners of 10: 40 (the 50 side less 10)', near(CS.maxRadius(sp, 0), 40, 0.01), CS.maxRadius(sp, 0));
  sp.points[0].r = CS.maxRadius(sp, 0);
  check('and that radius is made', CS.make(sp).ok, CS.make(sp).reason);
}

console.log('9. thin walls warn, and are made');
{
  const r = CS.make(rect(80, 50, 0, [0.5, 2, 2, 2]));
  check('made', r.ok, r.reason);
  check('warned in words', r.ok && r.warnings.length === 1 && /0.5 mm/.test(r.warnings[0]) && /nozzle/.test(r.warnings[0]), r.ok && r.warnings.join('; '));
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall held');
process.exit(fails ? 1 : 0);
