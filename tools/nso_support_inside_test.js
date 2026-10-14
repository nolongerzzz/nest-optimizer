#!/usr/bin/env node
// A support must stand in open space: the inside-material half of the line
// test (NSO_SupportAim.lineInsideAt), and the trunks it now refuses.
//
//   node tools/nso_support_inside_test.js      exit 0 = every gate held
//
// docs/CURVED-BRANCH.md 1b: on a mushroom-shaped part the contacts ring the
// stem, their centroid is on the stem's centre line, and the trunk was built
// [6,6,0] -> [6,6,8.58] wholly INSIDE the stem. nearestBase's line test was
// lineBlockedAt alone - "is a face hit strictly between the two ends" - and a
// segment that never leaves the material crosses no face, so it read as
// clear. That is where the inside check was missing; it is now
// lineInsideAt, run by nearestBase on every line lineBlockedAt clears.
//
// Loads the shipped files with vm, in index.html's own order, exactly the way
// tools/nso_support_tree_test.js does. Plans the way G-scope's planFor() does
// (section left at the shipped 'round', skipList []).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_seat_surface.js', 'app-sculpt.js',
                 'app-extend.js', 'nso_support_aim.js', 'nso_path_sweep.js',
                 'nso_support_tree.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const SA = ctx.NSO_SupportAim;
const ST = ctx.NSO_SupportTree;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const f3 = (v) => '[' + v.map((x) => x.toFixed(2)).join(', ') + ']';
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const L = len(a); return [a[0] / L, a[1] / L, a[2] / L]; };

/* ---- fixtures ----------------------------------------------------------- */

function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const t of f) for (const i of t) out.push(...v[i]);
  return out;
}
const soupOf = (...parts) => new Float32Array([].concat(...parts));

/* tools/nso_curved_branch_probe.js's arm(), verbatim: an arm whose underside
   is tessellated into `cell` mm squares, the squares under `holes` left out
   (that is where a stem or a body meets it). */
function arm(x0, x1, y0, y1, z0, z1, cell, holes) {
  const out = [];
  const inHole = (x, y) => holes.some(h => x >= h[0] - 1e-9 && x + cell <= h[1] + 1e-9 &&
                                           y >= h[2] - 1e-9 && y + cell <= h[3] + 1e-9);
  for (let x = x0; x < x1 - 1e-9; x += cell) {
    for (let y = y0; y < y1 - 1e-9; y += cell) {
      if (inHole(x, y)) continue;
      const a = [x, y, z0], b = [x + cell, y, z0], c = [x + cell, y + cell, z0], d = [x, y + cell, z0];
      out.push(...a, ...c, ...b, ...a, ...d, ...c);            /* facing down */
    }
  }
  const top = box([x0, y0, z0], [x1, y1, z1]);
  return out.concat(top.slice(6 * 9));                        /* the box minus its bottom */
}

const FIX = {
  /* The audit's own fixture, verbatim from the probe: a 12 x 12 mm cap on a
     4 x 4 mm stem. */
  mushroom: soupOf(box([4, 4, 0], [8, 8, 20]), arm(0, 12, 0, 12, 20, 24, 1, [[4, 8, 4, 8]])),
  /* An overhang above a solid body: a 20 x 14 mm shelf at z 30 on a 10 x 10
     block that is off the shelf's centre, so the overhang is a lopsided
     U round the block and its contacts' centroid [10.29, 7, 30] is over the
     block, not on any centre line. Before the fix the trunk was built
     [10.29, 7, 0] -> [10.29, 7, 10.20], inside the block. */
  shelfOnBlock: soupOf(box([4, 2, 0], [14, 12, 30]), arm(0, 20, 0, 14, 30, 34, 1, [[4, 14, 2, 12]])),
  /* tools/nso_support_tree_test.js's four, verbatim, and the probe's boss -
     controls whose trunks stand in open space. */
  shelf: soupOf(box([0, 0, 0], [10, 10, 20]), box([10, 0, 16], [22, 10, 20])),
  tall:  soupOf(box([0, 0, 0], [10, 10, 26]), box([10, 0, 22], [30, 10, 26])),
  tab:   soupOf(box([0, 0, 0], [10, 10, 16]), box([10, 1, 12], [18, 9, 16])),
  tiny:  soupOf(box([0, 0, 0], [10, 10, 16]), box([10, 4, 12], [12, 6, 16])),
  boss:  soupOf(box([0, 0, 0], [10, 10, 26]), arm(10, 30, 0, 10, 22, 26, 1, [[22, 25, 6, 9]]),
                box([22, 6, 17], [25, 9, 22]))
};
const plan = (host) => ST.planTree(host, { skipList: [] });
const INSIDE_WORDS = 'runs inside the piece';

/* ---- 1. the winding number the inside test stands on ------------------- */
console.log('\n1. windingAt: 1 inside a closed shell, 0 outside, additive over overlaps');
{
  const B = soupOf(box([0, 0, 0], [10, 10, 10]));
  const wIn = SA._windingAt(B, [3, 4, 5]);
  const wOut = SA._windingAt(B, [3, 4, 15]);
  const wFar = SA._windingAt(B, [-40, 25, 7]);
  check('1a inside a box: 1', near(wIn, 1, 1e-9), wIn.toFixed(12));
  check('1b just above it: 0', near(wOut, 0, 1e-9), wOut.toFixed(12));
  check('1c far off: 0', near(wFar, 0, 1e-9), wFar.toFixed(12));
  /* A point straight under a shared tessellation vertex and edge - exactly
     where a ray-crossing count would count the edge twice. */
  const wEdge = SA._windingAt(FIX.mushroom, [6, 6, 10]);
  check('1d mushroom stem centre line (under the stem cap\'s diagonal): inside', wEdge >= 0.5,
    wEdge.toFixed(6));
  const two = soupOf(box([0, 0, 0], [10, 10, 10]), box([5, 0, 0], [15, 10, 10]));
  const w2 = SA._windingAt(two, [7, 5, 5]);
  check('1e two overlapping shells add: 2 in the overlap', near(w2, 2, 1e-9), w2.toFixed(12));
}

/* ---- 2. where the check was missing ------------------------------------ */
console.log('\n2. the mushroom\'s plate -> apex line: the face test reads it clear, the inside test does not');
{
  const from = [6, 6, 0], to = [6, 6, 20];
  const dir = unit(sub(to, from)), L = len(sub(to, from));
  const blocked = SA.lineBlockedAt([FIX.mushroom], from, dir, L);
  const inside = SA.lineInsideAt([FIX.mushroom], from, dir, L);
  check('2a lineBlockedAt: -1 (no face strictly between the ends - the gap the audit found)',
    blocked === -1, String(blocked));
  check('2b lineInsideAt: flags it', inside > 0 && inside < L, inside.toFixed(3) + ' mm along');
  /* The same line moved 3 mm off the stem, into the open: clear on both. */
  const out = SA.lineInsideAt([FIX.mushroom], [1, 1, 0], dir, L);
  check('2c the same line in the open beside the stem: not inside', out === -1, String(out));
  /* A line lying IN a face is on the surface, neither in nor out, and is
     left to the face test - the stem's own wall, x = 4. */
  const onWall = SA.lineInsideAt([FIX.mushroom], [4, 6, 0], dir, L);
  check('2d a line lying in the stem\'s wall: not counted as inside', onWall === -1, String(onWall));
}

/* ---- 3. the two fixtures: refused at base, nothing built --------------- */
console.log('\n3. trunks that would stand inside the part are refused at the base, by name');
for (const name of ['mushroom', 'shelfOnBlock']) {
  const p = plan(FIX[name]);
  console.log('    ' + name + ': apex ' + (p.apex ? f3(p.apex) : '-') + ', stage ' + p.stage);
  console.log('      ' + p.reason);
  check('3 ' + name + ': not ok, refused at stage base', !p.ok && p.stage === 'base', p.stage);
  check('3 ' + name + ': no trunk, no parts', !p.trunk && p.parts.length === 0,
    'parts ' + p.parts.length);
  const c0 = p.base && p.base.considered && p.base.considered[0];
  check('3 ' + name + ': the plate was considered and marked inside', !!(c0 && c0.kind === 'plate' && c0.inside),
    c0 ? c0.why : '-');
  check('3 ' + name + ': the reason says so', p.reason.indexOf(INSIDE_WORDS) >= 0);
  /* and the apex's line really is inside the body - the fixture is what it
     claims to be */
  const L = p.apex[2] - p.detect.plateZ;
  const w = SA._windingAt(FIX[name], [p.apex[0], p.apex[1], p.detect.plateZ + L / 2]);
  check('3 ' + name + ': the trunk\'s would-be midpoint is in the body', w >= 0.5, w.toFixed(6));
}
{
  /* aim() asks the same nearestBase, so a strut aimed straight at the
     centroid is refused too - the strut half of the ticket. */
  const p = plan(FIX.shelfOnBlock);
  const a = SA.aim(p.apex, [{ kind: 'plate', z: 0 }], { obstacles: [FIX.shelfOnBlock] });
  check('3c a strut aim() at the shelf\'s centroid: refused at base, inside', !a.ok && a.stage === 'base' &&
    a.reason.indexOf(INSIDE_WORDS) >= 0, a.reason.slice(0, 120));
}

/* ---- 4. controls: trunks in open space are planned as before ----------- */
console.log('\n4. controls: every trunk that stands in open space still stands');
/* Pinned from this branch's base (claude-wip 6abb59c), unchanged here: the
   held branch counts and refusals G-scope's planFor() gets today. */
const EXPECT = {
  shelf: { branches: 16, refused: 0 },
  tall:  { branches: 28, refused: 0 },
  tab:   { branches: 8,  refused: 0 },
  tiny:  { branches: 0,  refused: 0 },
  boss:  { branches: 24, refused: 4 }
};
for (const name of Object.keys(EXPECT)) {
  const p = plan(FIX[name]);
  const e = EXPECT[name];
  const refused = (p.blocked || []).length;
  check('4 ' + name + ': ok, ' + e.branches + ' branches, ' + e.refused + ' refused',
    p.ok && p.branches.length === e.branches && refused === e.refused,
    'ok ' + p.ok + ', ' + p.branches.length + ' branches, ' + refused + ' refused');
  const t = p.trunk;
  const dir = unit(sub(t.tip, t.from)), L = len(sub(t.tip, t.from));
  const ins = SA.lineInsideAt([FIX[name]], t.from, dir, L);
  check('4 ' + name + ': its trunk ' + f3(t.from) + ' -> ' + f3(t.tip) + ' is in open space', ins === -1);
}
{
  /* The single strut, nso_support_aim.js's own cantilever. */
  const cant = soupOf(box([0, 0, 0], [10, 10, 20]), box([10, 0, 16], [30, 10, 20]));
  const r = SA.plan(cant, { skipList: [] });
  check('4 cantilever: SA.plan still builds its strut', r.ok && r.stage === 'done', r.reason.slice(0, 100));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('FAILED: ' + FAILS.join('; ')); process.exit(1); }
