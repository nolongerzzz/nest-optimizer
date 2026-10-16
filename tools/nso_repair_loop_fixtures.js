#!/usr/bin/env node
/* Fixtures for the repair loop (Patch / Cap / Bridge from the Findings card):
 * the shapes the committed damage fixtures do not cover.
 *
 *   node tools/nso_repair_loop_fixtures.js            # write them
 *   node tools/nso_repair_loop_fixtures.js --check    # regenerate and byte-diff the tree
 *
 *   fixtures/repair/box_lid_hole.stl   a flat-topped box, 24 x 24 x 12 mm, every face on a 16 x 16
 *                                      grid (so no T-junction anywhere), with a round hole of
 *                                      radius 5 mm cut through the LID only: one open loop, a
 *                                      staircase of grid edges, every vertex on the lid's plane.
 *                                      The rim is flat, so the card chooses CAP.
 *
 * The same builders are required by tools/nso_repair_loop_test.js, so the test and the committed
 * file cannot drift. Every coordinate is a function of integers and literals; nothing is random.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { writeSTL, readSTL } = require('./nso_stl_io.js');

const OUT = path.join(__dirname, '..', 'fixtures', 'repair');

/* A closed box, outward-wound, every face on an n x n grid. Corners are computed from the
   integer index with one formula per axis, so two faces that meet on an edge produce the same
   float32 numbers for the vertices on it. */
function gridBox(lo, hi, n, skip) {
  const at = (axis, i) => lo[axis] + (hi[axis] - lo[axis]) * i / n;
  const out = [];
  function face(axis, side) {                    // side 0 = low face, 1 = high face
    const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const P = (ii, jj) => { const p = [0, 0, 0]; p[axis] = side ? hi[axis] : lo[axis]; p[a1] = at(a1, ii); p[a2] = at(a2, jj); return p; };
      const q = [P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)];     // CCW seen from +axis (a1 -> a2)
      const tris = side ? [[q[0], q[1], q[2]], [q[0], q[2], q[3]]] : [[q[0], q[2], q[1]], [q[0], q[3], q[2]]];
      tris.forEach(t => { if (!(skip && skip(axis, side, t))) out.push(t[0][0], t[0][1], t[0][2], t[1][0], t[1][1], t[1][2], t[2][0], t[2][1], t[2][2]); });
    }
  }
  for (let axis = 0; axis < 3; axis++) { face(axis, 0); face(axis, 1); }
  return new Float32Array(out);
}

function boxLidHole() {
  const lo = [-12, -12, 0], hi = [12, 12, 12], R = 5;
  return gridBox(lo, hi, 16, (axis, side, t) => {
    if (axis !== 2 || side !== 1) return false;
    const cx = (t[0][0] + t[1][0] + t[2][0]) / 3, cy = (t[0][1] + t[1][1] + t[2][1]) / 3;
    return Math.hypot(cx, cy) < R;
  });
}

const FILES = { 'box_lid_hole.stl': { build: boxLidHole, header: 'NSO repair-loop fixture: flat-topped box, round hole in the lid' } };

if (require.main === module) {
  const check = process.argv.includes('--check');
  let bad = 0;
  for (const name of Object.keys(FILES)) {
    const f = FILES[name], dest = path.join(OUT, name), soup = f.build();
    if (!check) { writeSTL(dest, soup, f.header); console.log('wrote ' + path.relative(process.cwd(), dest) + ' (' + soup.length / 9 + ' tris)'); continue; }
    const tmp = path.join(require('os').tmpdir(), 'nso-rlf-' + process.pid + '-' + name);
    writeSTL(tmp, soup, f.header);
    const same = fs.existsSync(dest) && Buffer.compare(fs.readFileSync(tmp), fs.readFileSync(dest)) === 0;
    fs.unlinkSync(tmp);
    console.log((same ? 'ok    ' : 'DIFF  ') + name);
    if (!same) bad++;
  }
  process.exit(bad ? 1 : 0);
}
module.exports = { gridBox, boxLidHole, FILES };
