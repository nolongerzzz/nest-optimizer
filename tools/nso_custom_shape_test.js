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
   9. a wall under 2 nozzle widths is made, with a warning
  10. LIPS: an outside flange or an inside rim, square or with a 45° chamfer under it - sections at chosen heights are the
      outlines they should be, every combination closed, the refusals said
  11. LIDS: the plate is the top outline (the lip's, with an outside lip), the plug the opening less Fit (the lip's
      opening, under an inside lip), hollow or solid or none, and the refusals
  12. GROW / SHRINK (offsetSpec): the exact offset, kept as points, radii and curves
  13. COPY AN OUTLINE (fromLoop): sections of made pieces come back as the points, radii and curves they were made from;
      a noisy trace still reads as rounded corners; a hole reads the right way round
  14. CALIPERS: a side's length set by stretching (a box stays a box, an L keeps its notch), by its end or start point
      alone, corner to corner whatever the radii; the overall width / depth set exactly, curves and all; refusals */

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
  const want = r.info.areaOut * sp.height - (mode === 'solid' ? 0 : r.info.areaIn * (sp.height - (mode === 'tray' ? sp.floor : 0)));
  check(name + ' ' + mode + ' volume', near(v, want, 1e-6 * want), v.toFixed(2) + ' vs ' + want.toFixed(2));
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

const SL = require('../nso_slicer.js');
const areasAt = (soup, z) => SL.sliceMesh(soup, [{ sliceZ: z }]).sections[0].loops.map(l => SL.signedArea(l)).sort((a, b) => b - a);
const chordUnder = R => 2 * Math.PI * R * 0.02;      // the most chords inscribed in a radius-R circle's worth of corners lose

console.log('10. lips: an out flange or an in rim at the top, its underside a 45° chamfer unless turned off');
{
  /* rounded 80 x 50, r 8, wall 2, H 25; lip 3 wide, 2 tall: chamfer from z 20 to 23, the lip from 23 to 25 */
  const lipAt = (type, chamfer, mode) => { const sp = CS.preset('rounded'); sp.mode = mode || 'tray'; sp.lip = { type, width: 3, height: 2, chamfer }; return CS.make(sp); };
  const rr = (W, D, R) => W * D - (4 - Math.PI) * R * R;
  for (const mode of ['tray', 'frame', 'solid']) for (const type of ['out', 'in']) for (const ch of [true, false]) {
    const r = lipAt(type, ch, mode);
    if (type === 'in' && mode === 'solid') { check('a solid takes no inside lip (made without)', r.ok && r.info.lip === 'none'); continue; }
    check(type + ' lip, ' + (ch ? 'chamfered' : 'square') + ', ' + mode + ': made and closed', r.ok && topo(r.soup).open === 0 && topo(r.soup).multi === 0, r.reason || JSON.stringify(topo(r.soup)));
  }
  let r = lipAt('out', true);
  check('out: below the chamfer the outline is the body', near(areasAt(r.soup, 10)[0], rr(80, 50, 8), chordUnder(8)));
  check('out: half way up the chamfer it is 1.5 mm out', near(areasAt(r.soup, 21.5)[0], rr(83, 53, 9.5), chordUnder(9.5)), areasAt(r.soup, 21.5)[0].toFixed(2) + ' vs ' + rr(83, 53, 9.5).toFixed(2));
  check('out: the lip is 3 mm out, its corners r + 3', near(areasAt(r.soup, 24)[0], rr(86, 56, 11), chordUnder(11)));
  check('out: the inside is untouched', near(-areasAt(r.soup, 24)[1], rr(76, 46, 6), chordUnder(6)));
  check('out: the footprint is the lip\'s, 86 x 56', near(r.info.width, 86, 1e-6) && near(r.info.depth, 56, 1e-6), r.info.width + ' x ' + r.info.depth);
  r = lipAt('out', false);
  check('out, square: no chamfer - just under the lip it is the body', near(areasAt(r.soup, 22.9)[0], rr(80, 50, 8), chordUnder(8)));
  r = lipAt('in', true);
  check('in: the opening at the top is 3 mm in all round', near(-areasAt(r.soup, 24)[1], rr(70, 40, 3), chordUnder(3)), (-areasAt(r.soup, 24)[1]).toFixed(2) + ' vs ' + rr(70, 40, 3).toFixed(2));
  check('in: below the chamfer the inside is the wall\'s', near(-areasAt(r.soup, 15)[1], rr(76, 46, 6), chordUnder(6)));
  check('in: the outside is untouched', near(areasAt(r.soup, 24)[0], rr(80, 50, 8), chordUnder(8)));
  const why = sp => { const q = CS.make(sp); return q.ok ? '(made)' : q.reason; };
  let sp = CS.preset('rect'); sp.lip = { type: 'in', width: 30, height: 2 };
  check('refused: an inside lip wider than the opening', /lip/.test(why(sp)) && /narrower/.test(why(sp)), why(sp));
  sp = CS.preset('rect'); sp.lip = { type: 'out', width: 3, height: 30 };
  check('refused: a lip taller than the piece', /taller than the piece/.test(why(sp)), why(sp));
  sp = CS.preset('rect'); sp.lip = { type: 'in', width: 3, height: 21, chamfer: true };   // 25 - 21 - 3 = 1, under the 2 mm floor
  check('refused: an inside lip reaching the floor', /floor/.test(why(sp)), why(sp));
}

console.log('11. lids: a plate the size of the top, a plug that fits the opening with Fit all round');
{
  const rr = (W, D, R) => W * D - (4 - Math.PI) * R * R;
  const lidOf = (lid, lip) => { const sp = CS.preset('rounded'); sp.lid = lid; if (lip) sp.lip = lip; return CS.make(sp); };
  let r = lidOf({ type: 'with' });
  check('with: two pieces, the tray and its lid, both closed', r.ok && r.parts.length === 2 && r.parts[0].kind === 'body' && r.parts[1].kind === 'lid' && r.parts.every(q => topo(q.soup).open === 0), r.reason);
  const lid = r.parts[1].soup;
  check('the plate is the top outline, 2 thick', near(areasAt(lid, 1)[0], rr(80, 50, 8), chordUnder(8)));
  check('the plug is the opening less 0.25 all round', near(areasAt(lid, 4)[0], rr(75.5, 45.5, 5.75), chordUnder(6)), areasAt(lid, 4)[0].toFixed(2) + ' vs ' + rr(75.5, 45.5, 5.75).toFixed(2));
  check('hollow: a 1.6 mm ring', near(-areasAt(lid, 4)[1], rr(72.3, 42.3, 4.15), chordUnder(6)));
  check('4 mm deep, on a 2 mm plate: 6 mm tall', near(r.parts[1].size[2], 6, 1e-9));
  r = lidOf({ type: 'only' });
  check('only: the lid alone', r.ok && r.parts.length === 1 && r.parts[0].kind === 'lid');
  r = lidOf({ type: 'with', wall: 0 });
  check('wall 0: a solid plug', r.ok && areasAt(r.parts[1].soup, 4).length === 1);
  r = lidOf({ type: 'with', depth: 0 });
  check('depth 0: a flat lid', r.ok && topo(r.parts[1].soup).open === 0 && near(r.parts[1].size[2], 2, 1e-9));
  r = lidOf({ type: 'with' }, { type: 'in', width: 3, height: 2 });
  check('under an inside lip the plug fits the lip\'s opening', r.ok && near(areasAt(r.parts[1].soup, 4)[0], rr(69.5, 39.5, 2.75), chordUnder(3)), r.ok && areasAt(r.parts[1].soup, 4)[0].toFixed(2));
  r = lidOf({ type: 'with' }, { type: 'out', width: 3, height: 2 });
  check('over an outside lip the plate covers the lip', r.ok && near(areasAt(r.parts[1].soup, 1)[0], rr(86, 56, 11), chordUnder(11)));
  const why = sp => { const q = CS.make(sp); return q.ok ? '(made)' : q.reason; };
  let sp = CS.preset('rounded'); sp.lid = { type: 'with', depth: 30 };
  check('refused: a plug deeper than the tray', /deeper than the tray/.test(why(sp)), why(sp));
  sp = CS.preset('rounded'); sp.mode = 'solid'; sp.lid = { type: 'with' };
  check('refused: a lid for a solid', /no opening/.test(why(sp)), why(sp));
}

console.log('12. grow and shrink: the exact offset, kept editable');
{
  let o = CS.offsetSpec(CS.preset('rounded'), 2);
  check('grow 2: the points 2 out, the radii 2 more', o.ok && JSON.stringify(o.spec.points.map(p => [p.x, p.y, p.r])) === '[[-2,-2,10],[82,-2,10],[82,52,10],[-2,52,10]]', o.ok && JSON.stringify(o.spec.points.map(p => [p.x, p.y, p.r])));
  o = CS.offsetSpec(CS.preset('lshape'), -1);
  check('shrink an L 1: outside corners r - 1, the turned-in one r + 1', o.ok && o.spec.points[3].r === 5 && o.spec.points[0].r === 3 && o.spec.points[3].x === 34 && o.spec.points[3].y === 34, o.ok && JSON.stringify(o.spec.points[3]));
  const sc = CS.preset('scoop'), A0 = CS.outline(Object.assign({}, sc, { mode: 'solid' })).info.areaOut;
  o = CS.offsetSpec(sc, -0.5);
  const A1 = o.ok && CS.outline(Object.assign({}, o.spec, { mode: 'solid' })).info.areaOut;
  /* the area of an offset band: perimeter x d, less the corners' share - within a little of perimeter x 0.5 */
  const perim = CS.outline(Object.assign({}, sc, { mode: 'solid' })).outer.reduce((L, p, i, a) => L + Math.hypot(a[(i + 1) % a.length][0] - p[0], a[(i + 1) % a.length][1] - p[1]), 0);
  check('shrink the scoop 0.5: about its perimeter x 0.5 off its area, its curve kept', o.ok && near(A0 - A1, perim * 0.5, 2) && o.spec.sides[4].bulge > 5, o.ok && (A0 - A1).toFixed(2) + ' vs ' + (perim * 0.5).toFixed(2));
  o = CS.offsetSpec(CS.preset('rect'), -30);
  check('refused: shrunk past nothing', !o.ok && /used up/.test(o.reason), o.reason);
}

console.log('13. an outline from a section: sides, curves and rounded corners read back');
{
  const back = (sp, z, tol) => { sp.mode = 'solid'; const L = SL.sliceMesh(CS.make(sp).soup, [{ sliceZ: z || 5 }]).sections[0].loops[0]; return CS.fromLoop(L, { tol: tol || 0.2 }); };
  const pts = r => r.spec.points.map(p => [p.x, p.y, p.r]);
  let r = back(CS.preset('rect'));
  check('a rectangle: its 4 corners', r.ok && JSON.stringify(pts(r)) === '[[0,0,0],[80,0,0],[80,50,0],[0,50,0]]', r.ok && JSON.stringify(pts(r)));
  r = back(CS.preset('rounded'));
  check('a rounded rectangle: 4 points of radius 8, not dozens', r.ok && JSON.stringify(pts(r)) === '[[0,0,8],[80,0,8],[80,50,8],[0,50,8]]', r.ok && JSON.stringify(pts(r)));
  r = back(CS.preset('lshape'));
  check('an L: 6 points of radius 4, the turned-in one among them', r.ok && r.spec.points.length === 6 && r.spec.points.every(p => p.r === 4) && near(r.info.area, r.info.areaFrom, 0.01), r.ok && JSON.stringify(pts(r)));
  r = back(CS.preset('hexagon'));
  check('a hexagon: 6 corners of radius 4', r.ok && r.spec.points.length === 6 && r.spec.points.every(p => p.r === 4), r.ok && JSON.stringify(pts(r)));
  r = back(CS.preset('trapezoid'));
  check('a trapezoid: 4 corners of radius 5', r.ok && JSON.stringify(pts(r)) === '[[0,0,5],[90,0,5],[70,50,5],[20,50,5]]', r.ok && JSON.stringify(pts(r)));
  const stad = CS.preset('rect'); stad.points.forEach(p => { p.r = 0; }); stad.sides[1].bulge = 25; stad.sides[3].bulge = 25;
  r = back(stad);
  check('a stadium: straight sides and curved ends, within 0.1 % of its area', r.ok && r.info.curved >= 2 && r.spec.points.length <= 8 && near(r.info.area, r.info.areaFrom, 1e-3 * r.info.areaFrom), r.ok && JSON.stringify(r.info));
  r = back(CS.preset('scoop'));
  check('the swept-corner tray: its 3 square-ish corners rounded at 8, its sweep curved', r.ok && r.spec.points.filter(p => p.r === 8).length === 3 && r.info.curved >= 1 && near(r.info.area, r.info.areaFrom, 1e-3 * r.info.areaFrom), r.ok && JSON.stringify(r.info));
  const ring = CS.make(CS.preset('rounded')), loops = SL.sliceMesh(ring.soup, [{ sliceZ: 10 }]).sections[0].loops;
  const hole = loops.find(l => SL.signedArea(l) < 0);
  r = CS.fromLoop(hole, { tol: 0.2 });
  check('a tray\'s inside (a hole, clockwise): 76 x 46, radius 6', r.ok && JSON.stringify(pts(r)) === '[[0,0,6],[76,0,6],[76,46,6],[0,46,6]]', r.ok && JSON.stringify(pts(r)));
  /* a scan is not exact: noise of +-0.05 on a rounded rectangle still reads as 4 rounded corners at Detail 0.3 */
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.1;
  const noisy = CS.outline(Object.assign(CS.preset('rounded'), { mode: 'solid' })).outer.map(p => [p[0] + rnd(), p[1] + rnd()]);
  r = CS.fromLoop(noisy, { tol: 0.3 });
  check('a noisy trace (+-0.05) at Detail 0.3: 4 corners, radius within 0.5 of 8', r.ok && r.spec.points.length === 4 && r.spec.points.every(p => Math.abs(p.r - 8) <= 0.5), r.ok && JSON.stringify(pts(r)));
  check('refused: fewer than 3 points', !CS.fromLoop([[0, 0], [1, 1]]).ok);
}

console.log('14. calipers: a side\'s length, and the overall width and depth');
{
  const P = r => JSON.stringify(r.spec.points.map(p => [p.x, p.y]));
  let r = CS.setSideLength(CS.preset('rect'), 0, 100);
  check('stretch: a box stays a box', r.ok && P(r) === '[[0,0],[100,0],[100,50],[0,50]]', r.ok && P(r));
  r = CS.setSideLength(CS.preset('rect'), 0, 100, 'end');
  check('end: only the end point moves, along the side', r.ok && P(r) === '[[0,0],[100,0],[80,50],[0,50]]', r.ok && P(r));
  r = CS.setSideLength(CS.preset('rect'), 0, 70, 'start');
  check('start: only the start point moves, back along it', r.ok && P(r) === '[[10,0],[80,0],[80,50],[0,50]]', r.ok && P(r));
  r = CS.setSideLength(CS.preset('lshape'), 0, 120);
  check('an L keeps its notch: the bottom 120, the notch where it was', r.ok && P(r) === '[[0,0],[120,0],[120,35],[35,35],[35,80],[0,80]]', r.ok && P(r));
  r = CS.setSideLength(CS.preset('scoop'), 0, 120);
  check('the swept tray\'s long side 120: the top moves up, the sweep stays', r.ok && CS.sideLength(r.spec, 0) === 120 && P(r) === '[[0,50],[0,170],[70,170],[70,0],[30,0]]' && r.spec.sides[4].bulge === 6, r.ok && P(r));
  const cw = CS.preset('rect'); cw.points.reverse();
  r = CS.setSideLength(cw, 0, 60);
  check('points given clockwise: the same stretch', r.ok && CS.sideLength(r.spec, 0) === 60 && CS.outline(Object.assign({}, r.spec, { mode: 'solid' })).ok, r.ok && P(r));
  r = CS.setSideLength(CS.preset('trapezoid'), 2, 60, 'end');
  check('a slanted side, end point only: 60 exactly', r.ok && near(CS.sideLength(r.spec, 2), 60, 1e-9));
  r = CS.setSideLength(CS.preset('rounded'), 1, 64);
  const o = r.ok && CS.outline(Object.assign({}, r.spec, { mode: 'solid' }));
  check('rounded corners: the length is corner to corner, so the piece measures 64 across', o && o.ok && near(o.info.depth, 64, 1e-9), o && o.info.depth);
  r = CS.setSideLength(CS.preset('lshape'), 0, 20);
  check('refused: a stretch that would fold the shape over, saying how far it can go', !r.ok && /fold over/.test(r.reason) && /45 mm/.test(r.reason), r.reason);
  check('refused: a length of 0', !CS.setSideLength(CS.preset('rect'), 0, 0).ok);
  const W = sp => CS.outline(Object.assign({}, sp, { mode: 'solid' })).info;
  r = CS.setExtent(CS.preset('rounded'), 'x', 123.4);
  check('Width 123.4: the outline measures 123.4 across', r.ok && near(W(r.spec).width, 123.4, 0.005) && near(W(r.spec).depth, 50, 1e-9), r.ok && W(r.spec).width);
  r = CS.setExtent(CS.preset('scoop'), 'y', 150);
  check('Depth 150 on the swept tray: 150, the sweep untouched', r.ok && near(W(r.spec).depth, 150, 0.005) && r.spec.points[4].y === 0 && r.spec.points[0].y === 50, r.ok && P(r));
  const st = CS.preset('rect'); st.points.forEach(p => { p.r = 0; }); st.sides[1].bulge = 25; st.sides[3].bulge = 25;
  r = CS.setExtent(st, 'x', 200);
  check('a stadium, curved ends and all: 200 across', r.ok && near(W(r.spec).width, 200, 0.005), r.ok && W(r.spec).width);
  r = CS.setExtent(CS.preset('hexagon'), 'x', 100);
  check('a hexagon: 100 across', r.ok && near(W(r.spec).width, 100, 0.005), r.ok && W(r.spec).width);
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall held');
process.exit(fails ? 1 : 0);
