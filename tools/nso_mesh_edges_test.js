#!/usr/bin/env node
// nso_mesh_edges.js: round or bevel chosen straight edges of ANY piece -
// Soften's Pick edges on a piece that is not a plain box.
//
//   node tools/nso_mesh_edges_test.js        exit 0 = every gate held
//
// The kernel is loaded from the app's own file and the booleans are the
// shipped kernel's (tools/nso_csg_node.js runs nso_csg.js whole). The piece is
// a 60 x 2 x 20 wall with a 20 wide, 12 deep notch out of its top - a drawer
// wall with a finger notch - and a 60-degree wedge for a face pair that is not
// square.
//
//   1  lines        the notch's rims are straight convex lines, its two inside
//                   corners concave; numbering is the same on every read
//   2  one rim      R 0.5 Round on one rim: closed, the volume taken is the
//                   quarter-round's to the chord sampling
//   3  bevel        the same rim beveled: exactly R^2/2 per mm
//   4  fill         an inside corner alone: the fillet is ADDED, to the formula
//   5  the notch    every rim and both corners at R 0.5: closed, no fin where a
//                   rim meets a filled corner (the rim is carried round it),
//                   the sharp notch corners are gone
//   6  thin wall    R 3 on a 2 mm wall is clamped under half the wall, said so
//   7  not square   a 60-degree edge takes R: removed area R^2 (cot 30 - pi/3)
//   8  sweep        random sets of the notch's edges at random R: closed

const path = require('path');
const { csgContext } = require('./nso_csg_node.js');
const ME = require('../nso_mesh_edges.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const t of f) for (const i of t) o.push(...v[i]);
  return new Float32Array(o);
}
/* A prism along y whose cross-section in xz is the polygon `xz` (counter-clockwise). */
function prismY(xz, y0, y1) {
  const o = [], n = xz.length;
  const P = (i, y) => [xz[i][0], y, xz[i][1]];
  const tri = (a, b, c) => o.push(...a, ...b, ...c);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(P(i, y0), P(j, y0), P(j, y1)); tri(P(i, y0), P(j, y1), P(i, y1));
  }
  for (let i = 1; i < n - 1; i++) { tri(P(0, y0), P(i + 1, y0), P(i, y0)); tri(P(0, y1), P(i, y1), P(i + 1, y1)); }
  const s = new Float32Array(o);
  if (vol(s) < 0) for (let t = 0; t < s.length; t += 9) for (let k = 0; k < 3; k++) { const x = s[t + 3 + k]; s[t + 3 + k] = s[t + 6 + k]; s[t + 6 + k] = x; }
  return s;
}
function vol(s) {
  let v = 0;
  for (let t = 0; t < s.length; t += 9) {
    v += (s[t] * (s[t + 4] * s[t + 8] - s[t + 5] * s[t + 7]) - s[t + 1] * (s[t + 3] * s[t + 8] - s[t + 5] * s[t + 6]) +
          s[t + 2] * (s[t + 3] * s[t + 7] - s[t + 4] * s[t + 6])) / 6;
  }
  return v;
}
const closed = (s) => { const c = ME.seal(s); return c.open === 0 && c.nm === 0; };
// a quarter-round of 12 chords: the area between the corner and the polygon, per mm of edge
const NA = 12;
const quarterTaken = (R) => R * R - (R * R / 2) * NA * Math.sin(Math.PI / 2 / NA);   // corner square less the 12-chord fan from the centre
let seed = 11;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

(async () => {
  const csg = csgContext();
  const U = csg.nsoUnionSoups, S = csg.nsoSubtractSoups;
  const cut = await S(box([0, 0, 0], [60, 2, 20]), box([20, -1, 8], [40, 3, 21]));
  const wall = ME.tidy ? ME.tidy(cut.soup) : cut.soup;
  const V0 = vol(wall);

  console.log('\n=== 1. lines ===');
  const lines = ME.lines(wall);
  const inNotch = (p) => p[0] >= 20 - 1e-6 && p[0] <= 40 + 1e-6 && p[2] >= 8 - 1e-6;
  const notch = lines.filter(l => inNotch(l.p0) && inNotch(l.p1));
  const rims = notch.filter(l => l.convex), corners = notch.filter(l => !l.convex);
  check('the notched wall is closed', closed(wall));
  // rims: 3 on each face of the wall (two sides, the floor of the notch) and 2 across the wall top at the notch's ends
  check('the notch has 8 rims (convex) and 2 inside corners (concave)', rims.length === 8 && corners.length === 2,
        rims.length + ' rims, ' + corners.length + ' corners');
  check('the inside corners run across the wall, 2 mm', corners.every(l => near(l.len, 2, 1e-4)));
  check('every line is numbered by its place in the list', lines.every((l, i) => l.id === i));
  const again = ME.lines(wall);
  check('the same soup reads the same numbers', again.length === lines.length &&
        again.every((l, i) => l.p0.every((v, k) => near(v, lines[i].p0[k], 1e-9))));
  const floorRim = rims.find(l => near(l.p0[2], 8, 1e-6) && near(l.p1[2], 8, 1e-6) && near(l.p0[1], 0, 1e-6));
  check('the notch floor\'s front rim is a 20 mm line', floorRim && near(floorRim.len, 20, 1e-4), floorRim && floorRim.len);

  console.log('\n=== 2. one rim, Round ===');
  const R = 0.5;
  const r2 = await ME.run(wall, [{ id: floorRim.id, R, mode: 'fillet' }], U, S, { lines });
  const taken2 = V0 - vol(r2.soup);
  // the rim ends square at both notch corners (nothing picked there), so the prism is the 20 mm of the line
  const want2 = 20 * quarterTaken(R);
  check('closed', r2.ok && closed(r2.soup), r2.reason);
  check('the volume taken is the quarter-round\'s, 20 mm of it', near(taken2, want2, 0.01), taken2.toFixed(4) + ' vs ' + want2.toFixed(4));
  check('nothing clamped, both ends square', !r2.build.clamped.length && r2.build.ends.square === 2, JSON.stringify(r2.build.ends));

  console.log('\n=== 3. bevel ===');
  const r3 = await ME.run(wall, [{ id: floorRim.id, R, mode: 'chamfer' }], U, S, { lines });
  check('closed, and exactly R^2/2 per mm taken', r3.ok && closed(r3.soup) && near(V0 - vol(r3.soup), 20 * R * R / 2, 1e-3),
        (V0 - vol(r3.soup)).toFixed(4) + ' vs ' + (20 * R * R / 2).toFixed(4));

  console.log('\n=== 4. an inside corner is filled ===');
  const r4 = await ME.run(wall, [{ id: corners[0].id, R, mode: 'fillet' }], U, S, { lines });
  const added = vol(r4.soup) - V0;
  check('closed, and the fillet is added: 2 mm of quarter-round', r4.ok && closed(r4.soup) && near(added, 2 * quarterTaken(R), 0.002),
        added.toFixed(4) + ' vs ' + (2 * quarterTaken(R)).toFixed(4));
  check('the build says one concave edge', r4.build.concave === 1 && r4.build.convex === 0);

  console.log('\n=== 5. the whole notch ===');
  const all = notch.map(l => ({ id: l.id, R, mode: 'fillet' }));
  const r5 = await ME.run(wall, all, U, S, { lines });
  check('closed', r5.ok && closed(r5.soup), r5.reason || JSON.stringify(ME.seal(r5.soup || new Float32Array(0))));
  check('the rims are carried round the filled corners', r5.build.carried > 0, 'carried ' + r5.build.carried);
  const hasPoint = (s, p) => { for (let t = 0; t < s.length; t += 3) if (near(s[t], p[0], 1e-3) && near(s[t + 1], p[1], 1e-3) && near(s[t + 2], p[2], 1e-3)) return true; return false; };
  const sharp = [[20, 0, 8], [40, 0, 8], [20, 2, 8], [40, 2, 8], [20, 0, 20], [40, 2, 20]];
  check('no sharp notch corner is left', sharp.every(p => !hasPoint(r5.soup, p)), sharp.filter(p => hasPoint(r5.soup, p)).map(p => p.join(',')).join(' '));
  // no fin: nothing of the result stands outside the wall faces y = 0 and y = 2
  let outY = 0;
  for (let t = 1; t < r5.soup.length; t += 3) if (r5.soup[t] < -1e-4 || r5.soup[t] > 2 + 1e-4) outY++;
  check('nothing stands proud of the wall faces (no fillet fin)', outY === 0, outY + ' points outside');

  console.log('\n=== 6. a thin wall clamps ===');
  const top = rims.filter(l => near(l.p0[2], 8, 1e-6) && near(l.p1[2], 8, 1e-6));
  const r6 = await ME.run(wall, top.map(l => ({ id: l.id, R: 3, mode: 'fillet' })), U, S, { lines });
  check('both floor rims of the 2 mm wall at R 3: clamped under 1 mm, closed', r6.ok && closed(r6.soup) &&
        r6.build.clamped.length === 2 && r6.build.clamped.every(c => c.got < 1 && c.got > 0.8),
        JSON.stringify(r6.build.clamped.map(c => +c.got.toFixed(3))));

  console.log('\n=== 7. faces that are not square ===');
  // a wedge: base 20 along x, the apex edge at 60 degrees, 10 long in y
  const h = 10 * Math.sqrt(3);
  const wedge = prismY([[0, 0], [20, 0], [10, h]], 0, 10);
  const wl = ME.lines(wedge);
  const apex = wl.find(l => near(l.p0[2], h, 1e-3) && near(l.p1[2], h, 1e-3));
  check('the apex is a convex line at 60 degrees', apex && apex.convex && near(apex.phi, Math.PI / 3, 1e-6), apex && (apex.phi * 180 / Math.PI).toFixed(2));
  const Rw = 1;
  const r7 = await ME.run(wedge, [{ id: apex.id, R: Rw, mode: 'chamfer' }], U, S, { lines: wl });
  const d = Rw / Math.tan(Math.PI / 6);                    // tangent setback, cot(30) R
  const wantBevel = 10 * (d * d * Math.sin(Math.PI / 3) / 2);
  check('beveled: closed, and the triangle cut off is the setback\'s', r7.ok && closed(r7.soup) && near(vol(wedge) - vol(r7.soup), wantBevel, 0.01),
        (vol(wedge) - vol(r7.soup)).toFixed(4) + ' vs ' + wantBevel.toFixed(4));
  const r7r = await ME.run(wedge, [{ id: apex.id, R: Rw, mode: 'fillet' }], U, S, { lines: wl });
  // the arc turns 120 degrees in 16 chords; the chords cut a sliver more than the true circle
  const turn = Math.PI - Math.PI / 3, k = Math.ceil(12 * turn / (Math.PI / 2));
  const wantRound = 10 * Rw * Rw * (1 / Math.tan(Math.PI / 6) - turn / 2 + (turn - k * Math.sin(turn / k)) / 2);
  check('rounded: closed, and the area taken is R^2 (cot 30 - pi/3), to the chords', r7r.ok && closed(r7r.soup) &&
        near(vol(wedge) - vol(r7r.soup), wantRound, 0.01), (vol(wedge) - vol(r7r.soup)).toFixed(4) + ' vs ' + wantRound.toFixed(4));

  console.log('\n=== 8. sweep ===');
  let bad = 0, n = 0;
  for (let k = 0; k < 40; k++) {
    const pick = notch.filter(() => rnd() < 0.5);
    if (!pick.length) continue;
    const Rk = [0.2, 0.4, 0.6, 0.8][Math.floor(rnd() * 4)], mode = rnd() < 0.7 ? 'fillet' : 'chamfer';
    const r = await ME.run(wall, pick.map(l => ({ id: l.id, R: Rk, mode })), U, S, { lines });
    n++;
    if (!r.ok || !closed(r.soup)) { bad++; console.log('    not closed: ' + pick.map(l => l.id).join(',') + ' R ' + Rk + ' ' + mode); }
  }
  check(n + ' random edge sets of the notch: every one closed', bad === 0, bad + ' not');

  console.log(fails ? '\n' + fails + ' FAILED' : '\nall gates held');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
