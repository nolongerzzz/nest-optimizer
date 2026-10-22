#!/usr/bin/env node
// Headless self-test for nso_support_aim.js: overhang detection, and a
// straight support aimed from the nearest viable base and grown to reach it.
//
//   node tools/nso_support_aim_test.js      exit 0 = every gate held
//
// Loads the shipped files with vm, in index.html's own order, so the browser
// files stay free of any node idiom - the same way tools/nso_extend_test.js
// and tools/sculpt_selftest.js do. app-sculpt.js is loaded because Extend
// reuses NSO_buildAdjacency / NSO_sculptMetrics for its topology evidence, and
// loading it here means the STRONGER set of Extend's gates runs on every grow
// step below rather than the weaker set.
//
// Writes tools/support-aim-out/*.stl for tools/nso_support_aim_canonical_check.js,
// which puts the same solids through tools/mesh_validate.py.
//
// The numbers worth reading are the exact ones. "cross-section drift 0" is a
// coordinate-by-coordinate comparison against the input buffer, not a rounded
// zero, and the area spread across the sections of a finished, turned strut is
// quoted in full rather than as "uniform".

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'support-aim-out');
const { readSTL, writeSTL } = require('./nso_stl_io.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise, Date, WeakMap,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, Int8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_seat_surface.js', 'app-sculpt.js',
                 'app-extend.js', 'nso_support_beacons.js', 'nso_support_aim.js',
                 'nso_path_sweep.js', 'nso_support_tree.js', 'nso_support_gridpack.js',
                 'nso_raster_lines.js', 'nso_crosshatch.js', 'nso_support_interface.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const SA = ctx.NSO_SupportAim;
const TH = ctx.NSO_Thickness;
const ST = ctx.NSO_SupportTree;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const fx = f => path.join(ROOT, f);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* The scan's time is gated against this box's speed right now, not against
   seconds: a fixed amount of pure JS work - triangle normals from a typed
   array, binned into a Map grid, the scan's own kind of work - run in this
   process immediately before it. A box starved by another suite slows both,
   so their ratio holds where "under 2 s" did not (red twice locally under
   load). One untimed pass first, so the timed passes run warm, as the scan
   does: detectOverhangs has run on four files before it.
   RECORDED on the 4-core cloud box: 3.46 - 3.97 loops alone, 3.40 - 4.80
   with another suite beside it (the scan 989 - 1642 ms on the clock). 8 is
   twice the box alone, the headroom 2 s gave the ~1 s scan; one ray per
   triangle, brute force (169 s), is ~470. */
const SCAN_RATIO_MAX = 8;
function calibrate() {
  const N = 200000, PASSES = 40;
  const v = new Float64Array(N * 9);
  let s = 12345, acc = 0;
  for (let i = 0; i < v.length; i++) { s = (s * 1103515245 + 12345) >>> 0; v[i] = s / 4294967296 * 100; }
  const pass = p => {
    const grid = new Map();
    for (let t = 0; t < N; t++) {
      const o = t * 9;
      const ax = v[o + 3] - v[o], ay = v[o + 4] - v[o + 1], az = v[o + 5] - v[o + 2];
      const bx = v[o + 6] - v[o], by = v[o + 7] - v[o + 1], bz = v[o + 8] - v[o + 2];
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const k = (Math.floor(v[o] / 2) + p) * 4096 + Math.floor(v[o + 1] / 2);
      grid.set(k, (grid.get(k) || 0) + nz / (Math.sqrt(nx * nx + ny * ny + nz * nz) || 1));
    }
    for (const x of grid.values()) acc += x;
  };
  pass(-1);
  const t0 = performance.now();
  for (let p = 0; p < PASSES; p++) pass(p);
  const ms = performance.now() - t0;
  if (!isFinite(acc)) throw new Error('calibration loop: ' + acc);    // used, so it is not optimised away
  return { ms };
}

/* ---- shapes built here, so the arithmetic is checkable by hand ---------- */

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

/* A post with an arm jutting off it. The arm's underside, 200 mm^2 at z = 16,
   has nothing beneath it: the canonical cantilever. */
const CANTILEVER = soupOf(box([0, 0, 0], [10, 10, 20]), box([10, 0, 16], [30, 10, 20]));
/* The same arm with a pillar already under its far half. Everything about the
   arm's underside is unchanged - same normals, same angle, same area - and
   half of it is now held up. */
const CANTILEVER_PROPPED = soupOf(box([0, 0, 0], [10, 10, 20]),
                                  box([10, 0, 16], [30, 10, 20]),
                                  box([20, 0, 0], [30, 10, 16]));

/* A wedge whose sloping underside sits at a stated angle off the build plate:
   run = rise / tan(deg). Used to pin the threshold itself. */
function rampUnder(deg, z0, rise) {
  const run = rise / Math.tan(deg * Math.PI / 180);
  const v = [[0, 0, z0], [run, 0, z0 + rise], [run, 0, z0 + rise + 4], [0, 0, z0 + 4],
             [0, 10, z0], [run, 10, z0 + rise], [run, 10, z0 + rise + 4], [0, 10, z0 + 4]];
  const f = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 5, 1], [0, 4, 5],
             [1, 5, 6], [1, 6, 2], [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0]];
  const out = [];
  for (const t of f) for (const i of t) out.push(...v[i]);
  return new Float32Array(out);
}

/* A C-section run 40 mm along y: a floor (z 0-6), a wall (x 0-10) and a roof
   (z 40-48) whose inside corner is a 45 deg chamfer from (10, 32) to
   (18, 40) - a sloped band 8 mm tall x 40 mm long, the floor 26 mm under
   it. The shape of the chamfer a 12-piece plate's part carries along its
   whole length (x 65.6-74.4, z 64-72.2, y 70-110), at test size. One closed
   mesh, the profile cut by hand into convex fans, so no face is doubled. */
function chamferBand() {
  const P = [[0, 0], [40, 0], [40, 6], [10, 6], [10, 32], [18, 40], [40, 40], [40, 48], [0, 48]];
  const fans = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 8], [8, 4, 5], [8, 5, 6], [8, 6, 7]];
  const L = 40, out = [];
  const v = (i, y) => [P[i][0], y, P[i][1]];
  for (const [a, b, c] of fans) out.push(...v(a, 0), ...v(b, 0), ...v(c, 0), ...v(a, L), ...v(c, L), ...v(b, L));
  for (let i = 0; i < P.length; i++) {
    const j = (i + 1) % P.length;
    out.push(...v(i, 0), ...v(j, L), ...v(j, 0), ...v(i, 0), ...v(i, L), ...v(j, L));
  }
  return new Float32Array(out);
}

console.log('\n=== 1. DETECTION: the angle, and the half that makes it a detector ===');

{
  const d = SA.detectOverhangs(CANTILEVER, { skipList: [] });
  check('cantilever: detected', d.ok, d.reason);
  check('cantilever: one region', d.regions.length === 1, `${d.regions.length} region(s)`);
  const r = d.regions[0];
  check('cantilever: region area is the arm underside, 20 x 10 mm',
    near(r.areaMm2, 200, 1e-3), `${r.areaMm2.toFixed(4)} mm^2`);
  check('cantilever: aim point is the centre of that face',
    near(r.point[0], 20, 1e-4) && near(r.point[1], 5, 1e-4) && near(r.point[2], 16, 1e-4),
    `[${r.point.map(c => c.toFixed(4)).join(', ')}]`);
  check('cantilever: the drop to the plate is the arm height',
    near(r.dropMm, 16, 1e-4), `${r.dropMm.toFixed(4)} mm`);
  check('cantilever: the post\'s own bottom face is not flagged - it is ON the plate',
    d.trisOnPlate === 2 && d.trisDownward === 4 && d.trisFlagged === 2,
    `downward ${d.trisDownward}, onPlate ${d.trisOnPlate}, flagged ${d.trisFlagged}`);
}

{
  /* THE test. Same faces, same normals, same angle - a tint cannot tell these
     two shapes apart, and a detector must. */
  const bare = SA.detectOverhangs(CANTILEVER, { skipList: [] });
  const prop = SA.detectOverhangs(CANTILEVER_PROPPED, { skipList: [] });
  check('propped: the arm underside is still 4 downward faces on both shapes',
    prop.trisDownward >= bare.trisDownward,
    `bare ${bare.trisDownward}, propped ${prop.trisDownward}`);
  check('propped: the half with a pillar under it is dropped as self-supported',
    prop.trisSelfSupported > 0, `${prop.trisSelfSupported} self-supported`);
  const propArea = prop.regions.reduce((s, r) => s + r.areaMm2, 0);
  check('propped: the unsupported area halves, 200 -> 100 mm^2',
    near(propArea, 100, 1e-3), `${propArea.toFixed(4)} mm^2`);
}

{
  /* The tint's own predicate, written out, so the difference is a measurement
     and not a claim. applyOverhangColors (app-core.js) flags n.up < cos(45),
     which is every face more than 45 deg off UP. */
  const tint = soup => {
    let n = 0;
    for (let t = 0; t < soup.length / 9; t++) {
      const o = t * 9;
      const ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
      const vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const L = Math.hypot(nx, ny, nz);
      if (!(L > 1e-15)) continue;
      if (nz / L < Math.cos(45 * Math.PI / 180)) n++;
    }
    return n;
  };
  const d = SA.detectOverhangs(CANTILEVER, { skipList: [] });
  check('the viewport tint is not the detector: it flags every vertical wall too',
    tint(CANTILEVER) === 20 && d.trisFlagged === 2,
    `tint ${tint(CANTILEVER)} of ${CANTILEVER.length / 9} faces, detector ${d.trisFlagged}`);
}

for (const [deg, expect] of [[30, true], [44, true], [46, false], [60, false]]) {
  const d = SA.detectOverhangs(rampUnder(deg, 6, 8), { skipList: [], minAreaMm2: 0 });
  const got = d.regions.length > 0;
  check(`threshold: an underside ${deg} deg off the plate ${expect ? 'needs' : 'does not need'} support at the 45 deg default`,
    got === expect, `${d.regions.length} region(s), ${d.trisFlagged} face(s) flagged`);
}
{
  const d = SA.detectOverhangs(rampUnder(30, 6, 8), { skipList: [], minAreaMm2: 0, angleDeg: 20 });
  check('threshold: the same 30 deg underside passes once the threshold drops to 20 deg',
    d.regions.length === 0, d.reason);
}

console.log('\n=== 2. DETECTION on real fixtures ===');

{
  for (const f of ['library/box_closed.stl', 'library/soften_test_01_cube.stl',
                   'library/box_hull_80x40x20-2.stl', 'fixtures/lid_strap.stl']) {
    const d = SA.detectOverhangs(readSTL(fx(f)), { skipList: [] });
    check(`${f}: sits on its own base, needs no support`,
      d.ok && d.regions.length === 0, d.reason);
  }
}
{
  const f = 'fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl';
  const soup = readSTL(fx(f));
  const cal = calibrate();
  const t0 = performance.now();
  const d = SA.detectOverhangs(soup, { skipList: [] });
  const ms = performance.now() - t0;
  const ratio = ms / cal.ms;
  check(`${f}: a real 32862-triangle part, scanned`, d.ok, d.reason);
  check('tape: the biggest unsupported region is the on-edge underside, ~1188 mm^2 at ~18 mm up',
    d.regions.length > 0 && near(d.regions[0].areaMm2, 1187.86, 0.5) && near(d.regions[0].dropMm, 18.04, 0.05),
    d.regions.length ? `${d.regions[0].areaMm2.toFixed(2)} mm^2, drop ${d.regions[0].dropMm.toFixed(2)} mm` : 'none');
  check('tape: 5204 downward faces reduce to ' + d.trisFlagged + ' genuinely unsupported',
    d.trisDownward === 5204 && d.trisFlagged < d.trisDownward,
    `downward ${d.trisDownward}, self-supported ${d.trisSelfSupported}, on the plate ${d.trisOnPlate}`);
  console.log(`  FINDING tape: the scan took ${Math.round(ms)} ms on the clock; the calibration loop ${Math.round(cal.ms)} ms`);
  check(`tape: the whole scan is under ${SCAN_RATIO_MAX} calibration loops (one ray per triangle, brute force, is ~470)`,
    ratio < SCAN_RATIO_MAX, ratio.toFixed(2) + ' loops');
}

console.log('\n=== 3. The vertical-ray grid is exactly the brute-force answer ===');

for (const [f, stride] of [['fixtures/fixture_groove_concave.stl', 1],
                           ['fixtures/hinge_pip.stl', 1],
                           ['fixtures/fixture_blob_organic.stl', 1],
                           ['fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl', 37]]) {
  const s = readSTL(fx(f));
  const n = (s.length / 9) | 0;
  const grid = SA._buildDownGrid([s]);
  let diff = 0, rays = 0, hits = 0;
  for (let t = 0; t < n; t += stride) {
    const o = t * 9;
    const c = [(s[o] + s[o + 3] + s[o + 6]) / 3,
               (s[o + 1] + s[o + 4] + s[o + 7]) / 3,
               (s[o + 2] + s[o + 5] + s[o + 8]) / 3];
    const orig = [c[0], c[1], c[2] - 1e-3];
    const g = SA._nearestHitDown(grid, orig, 1e-3, 1e9);
    const b = SA._nearestHit([s], orig, [0, 0, -1], 1e-3, 1e9);
    rays++;
    if (g > 0) hits++;
    if (Math.abs((g < 0 ? -1 : g) - (b < 0 ? -1 : b)) > 1e-9) diff++;
  }
  check(`${path.basename(f)}: ${rays} vertical rays agree ray for ray`,
    diff === 0, `${diff} disagreement(s), ${hits} of ${rays} rays hit something`);
}

console.log('\n=== 4. Paint scope: the skip list is required, and it is obeyed ===');

{
  const noList = SA.detectOverhangs(CANTILEVER, {});
  check('a caller who forgets the skip list is refused, not given an unpainted default',
    !noList.ok && /skipList/.test(noList.reason), noList.reason);

  const nullList = SA.detectOverhangs(CANTILEVER, { skipList: null });
  check('a painted face with no axis to name it by is refused by name',
    !nullList.ok && /no axis and side/.test(nullList.reason), nullList.reason);

  const empty = SA.detectOverhangs(CANTILEVER, { skipList: [] });
  check('[] states that nothing is painted, and the scan runs',
    empty.ok && empty.regions.length === 1, empty.reason);

  /* The arm underside is the -Z face at z = 16. nsoMaskFaceList spells that
     { axisIdx: 2, keepMin: true, d: 16 }; the list is read as recorded, and
     never re-derived from a bounding box. */
  const painted = SA.detectOverhangs(CANTILEVER,
    { skipList: [{ axisIdx: 2, keepMin: true, d: 16, inner: false }] });
  check('painting the arm underside takes it out of the scan',
    painted.ok && painted.regions.length === 0 && painted.trisPainted === 2,
    `${painted.trisPainted} face(s) skipped, ${painted.regions.length} region(s)`);

  /* Sub-region scope: paint somewhere else on the piece must NOT stand the
     whole scan down. The post's own bottom is the -Z face at z = 0. */
  const elsewhere = SA.detectOverhangs(CANTILEVER,
    { skipList: [{ axisIdx: 2, keepMin: true, d: 0, inner: false }] });
  check('paint elsewhere on the piece does not stand the scan down (sub-region scope)',
    elsewhere.ok && elsewhere.regions.length === 1, elsewhere.reason);
}

console.log('\n=== 5. THE AIM: one straight line, from the nearest viable base ===');

{
  const d = SA.detectOverhangs(CANTILEVER, { skipList: [] });
  const target = d.regions[0].point;
  const nb = SA.nearestBase(target, [{ kind: 'plate', z: 0 }], { obstacles: [CANTILEVER] });
  check('plate base: the foot is straight below the target', nb.ok &&
    near(nb.from[0], 20, 1e-6) && near(nb.from[1], 5, 1e-6) && near(nb.from[2], 0, 1e-6),
    nb.ok ? `[${nb.from.map(c => c.toFixed(4)).join(', ')}]` : nb.reason);
  check('plate base: the direction is straight up and the length is the drop',
    nb.ok && near(nb.dir[2], 1, 1e-9) && near(nb.length, 16, 1e-6),
    nb.ok ? `dir [${nb.dir.map(c => c.toFixed(6)).join(', ')}], ${nb.length.toFixed(4)} mm` : nb.reason);
}

{
  /* A second piece already on the plate, under the arm but off to one side.
     Its nearest surface point is closer than the plate, so it wins - and the
     direction that comes out is oblique, which is the case the whole "bake,
     do not pose" finding exists for. */
  const prop = new Float32Array(box([22, 2, 0], [26, 6, 10]));
  const d = SA.detectOverhangs(CANTILEVER, { skipList: [] });
  const target = d.regions[0].point;                       /* [20, 5, 16] */
  const nb = SA.nearestBase(target, [{ kind: 'plate', z: 0 }, { kind: 'piece', soup: prop, id: 'prop' }],
    { obstacles: [CANTILEVER] });
  check('another piece wins when it is nearer than the plate',
    nb.ok && nb.base.kind === 'piece' && nb.base.id === 'prop',
    nb.ok ? `${nb.base.kind}, ${nb.length.toFixed(4)} mm (plate was 16)` : nb.reason);
  check('the aim off a piece is oblique, not vertical',
    nb.ok && nb.dir[2] < 0.999 && nb.dir[2] > 0,
    nb.ok ? `dir [${nb.dir.map(c => c.toFixed(6)).join(', ')}]` : nb.reason);
  /* Nothing of the prop sits directly under [20, 5, 16] - it spans x 22..26 -
     so the foot is its nearest EDGE, at x = 22, z = 10: hypot(2, 0, 6). A
     straight-down reading would have found no prop at all and fallen back to
     the plate. */
  check('nearest means nearest on the surface, not straight down from the target',
    nb.ok && near(nb.length, Math.hypot(2, 0, 6), 1e-4),
    nb.ok ? `${nb.length.toFixed(4)} mm, expected ${Math.hypot(2, 0, 6).toFixed(4)}` : nb.reason);
}

{
  /* A blocked line is refused, not routed around. The target is the far end
     of a pocket whose mouth the piece itself closes over. */
  const wall = soupOf(box([0, 0, 0], [30, 10, 4]), box([0, 0, 8], [30, 10, 12]));
  const target = [15, 5, 8];                               /* the upper slab's underside */
  const blocked = SA.nearestBase(target, [{ kind: 'plate', z: 0 }], { obstacles: [wall] });
  check('a blocked straight line refuses rather than bending',
    !blocked.ok && /blocked/.test(blocked.considered[0].why),
    blocked.considered[0].why);
  check('the refusal names curving as out of scope rather than implying it will be tried',
    !blocked.ok && /curving path/.test(blocked.reason), blocked.reason);
}

console.log('\n=== 6. THE GROWTH: Extend does it, and the cross-section holds ===');

const CASES = [];
{
  const p = SA.plan(CANTILEVER, { skipList: [] });
  check('cantilever: plan() runs detect -> aim -> build -> grow -> place', p.ok, p.reason);
  check('cantilever: the grow step is Extend, with its own gates passing',
    p.ok && p.aim.grow.ok && p.aim.grow.axis === 'z', p.ok ? p.aim.grow.reason || 'ok' : '');
  check('cantilever: Extend reports cross-section drift of exactly 0 coordinates',
    p.ok && p.aim.grow.crossSectionDrift === 0, p.ok ? String(p.aim.grow.crossSectionDrift) : '');
  check('cantilever: the strut is grown to the length the aim asked for',
    p.ok && near(p.aim.grow.lengthAfter, 16, p.aim.grow.residualUlpTol),
    p.ok ? `${p.aim.grow.lengthAfter} mm, residual ${p.aim.grow.residual.toExponential(3)} mm ` +
           `(tolerance ${p.aim.grow.residualUlpTol.toExponential(3)})` : '');
  check('cantilever: the strut tip lands on the point that needed support',
    p.ok && Math.abs(p.aim.reachErrorMm) < 1e-4,
    p.ok ? `${p.aim.reachErrorMm.toExponential(3)} mm off` : '');
  check('cantilever: a straight-up aim meets the flat underside square, so nothing goes past it',
    p.ok && p.aim.tipPenetrationMm === 0,
    p.ok ? `${p.aim.tipPenetrationMm} mm past the face` : '');
  if (p.ok) CASES.push(['cantilever_strut', p, CANTILEVER]);
}

{
  /* The oblique case: the same overhang, supported off a second piece, so the
     strut is turned through a real angle before it is measured. */
  const prop = new Float32Array(box([22, 2, 0], [26, 6, 10]));
  const p = SA.plan(CANTILEVER, {
    skipList: [],
    bases: [{ kind: 'plate', z: 0 }, { kind: 'piece', soup: prop, id: 'prop' }],
    obstacles: [CANTILEVER, prop]
  });
  check('oblique: plan() aims off the second piece', p.ok && p.aim.base.base.kind === 'piece', p.reason);
  check('oblique: the strut is turned through a real angle, baked into its triangles',
    p.ok && p.aim.place.turnedDeg > 5,
    p.ok ? `${p.aim.place.turnedDeg.toFixed(3)} deg` : '');
  check('oblique: Extend still reports cross-section drift of exactly 0',
    p.ok && p.aim.grow.crossSectionDrift === 0, p.ok ? String(p.aim.grow.crossSectionDrift) : '');
  check('oblique: the tip still lands on the target after the turn',
    p.ok && Math.abs(p.aim.reachErrorMm) < 1e-4,
    p.ok ? `${p.aim.reachErrorMm.toExponential(3)} mm off` : '');
  /* The flat cap on a tilted aim: the corner stands (side/2) * sin(tilt) past
     the face it meets. Pinned against the closed form, not against a
     tolerance, because this is the number that separates "a cap that is not
     shaped to the contact" from "a support driven through the piece". */
  const predicted = (p.ok ? p.aim.sideMm / 2 : 0) *
    Math.sin((p.ok ? p.aim.place.turnedDeg : 0) * Math.PI / 180);
  check('oblique: the cap corner stands (side/2) x sin(tilt) past the target face',
    p.ok && near(p.aim.tipPenetrationMm, predicted, 1e-5),
    p.ok ? `${p.aim.tipPenetrationMm.toFixed(6)} mm, closed form ${predicted.toFixed(6)} mm ` +
           `at ${p.aim.place.turnedDeg.toFixed(3)} deg` : '');
  if (p.ok) CASES.push(['oblique_strut', p, CANTILEVER]);
}

{
  /* A real part. The tape's on-edge underside, 18 mm up, supported off the plate. */
  const soup = readSTL(fx('fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl'));
  const p = SA.plan(soup, { skipList: [] });
  check('tape: plan() aims a support at the real part\'s biggest unsupported region',
    p.ok, p.reason);
  check('tape: Extend reports cross-section drift of exactly 0',
    p.ok && p.aim.grow.crossSectionDrift === 0, p.ok ? String(p.aim.grow.crossSectionDrift) : '');
  check('tape: the tip lands on the target',
    p.ok && Math.abs(p.aim.reachErrorMm) < 1e-4,
    p.ok ? `${p.aim.reachErrorMm.toExponential(3)} mm off, ${p.aim.lengthMm.toFixed(3)} mm long` : '');
  if (p.ok) CASES.push(['tape_strut', p, soup]);
}

console.log('\n=== 7. Cross-section uniformity, measured on the FINISHED solid ===');

for (const [name, p] of CASES) {
  const u = SA.uniformity(p.soup, p.aim.from, p.aim.dir, { stations: 15 });
  check(`${name}: 15 sections perpendicular to the aim all close`, u.ok, u.reason);
  check(`${name}: section area is uniform along the aimed direction`,
    u.ok && u.areaRelSpread < 1e-6,
    u.ok ? `${u.areaMin.toFixed(9)} .. ${u.areaMax.toFixed(9)} mm^2, ` +
           `spread ${(u.areaRelSpread * 100).toExponential(3)}%` : '');
  check(`${name}: section perimeter is uniform too`,
    u.ok && u.perimeterRelSpread < 1e-6,
    u.ok ? `spread ${(u.perimeterRelSpread * 100).toExponential(3)}%` : '');
  check(`${name}: the section really is the strut's own square cross-section`,
    u.ok && near(u.areaMin, p.aim.sideMm * p.aim.sideMm, 1e-4),
    u.ok ? `${u.areaMin.toFixed(6)} vs side^2 = ${(p.aim.sideMm * p.aim.sideMm).toFixed(6)} mm^2` : '');
}

console.log('\n=== 8. The wall-thickness / nozzle-safety floor ===');

{
  const fl = SA._resolveFloor({});
  check('the floor comes from NSO_Thickness.floorFor and nowhere else',
    fl.ok && fl.source === 'NSO_Thickness.floorFor' && fl.floor === TH.floorFor(),
    `${fl.floor} mm from ${fl.source}`);
  check('at the default 0.4 nozzle that is 0.42 mm - the figure mesh_validate.py uses',
    fl.floor === 0.42, String(fl.floor));

  const thin = SA.buildStrut({ sideMm: 0.1 });
  check('a strut asked for thinner than the floor is raised to it, and says so',
    thin.ok && thin.sideMm === 0.42 && thin.flooredUp, thin.reason);

  const fat = SA.buildStrut({ sideMm: 1.2 });
  check('a strut already clear of the floor is left alone',
    fat.ok && fat.sideMm === 1.2 && !fat.flooredUp, fat.reason);

  const big = SA.buildStrut({ sideMm: 0.1, nozzle: 0.8 });
  check('a 0.8 nozzle moves the floor to 0.84 and the strut with it',
    big.ok && big.sideMm === 0.84, `${big.sideMm} mm`);

  /* No thickness module and no measured width: refuse, do not invent one. */
  const orphan = { detectOverhangs: null };
  const saved = ctx.NSO_Thickness;
  ctx.NSO_Thickness = undefined;
  const noFloor = SA.buildStrut({ sideMm: 1.2, thickness: null });
  ctx.NSO_Thickness = saved;
  check('with no floor available the build refuses rather than defaulting',
    !noFloor.ok && /cannot be established/.test(noFloor.reason), noFloor.reason);

  const measured = SA.buildStrut({ sideMm: 0.3, minWall: 0.3 });
  check('a caller passing a measured extrusion width steps the floor aside',
    measured.ok && measured.sideMm === 0.3 && measured.floorSource === 'caller-supplied minWall',
    measured.reason);
}

for (const [name, p] of CASES) {
  const rep = TH.measureMesh(p.soup);
  check(`${name}: the finished strut passes the canonical wall-thickness probe`,
    rep.pass, TH.describe(rep));
  check(`${name}: its measured minimum wall is at or above the ${rep.threshold_mm} mm floor`,
    rep.min_mm == null || rep.min_mm >= rep.threshold_mm - 1e-4,
    rep.min_mm == null ? `no opposing surface within the probe (${rep.sheets} sheets)`
                       : `${rep.min_mm.toFixed(5)} mm`);
}

console.log('\n=== 9. Detection reads the piece; it never writes to it ===');

for (const [name, , host] of CASES) {
  /* The buffer that went in, byte for byte, after a full plan() over it. A
     detector that quietly normalised or welded its input would be changing the
     piece to answer a question about it. */
  const before = Buffer.from(new Float32Array(host).buffer);
  SA.plan(host, { skipList: [] });
  const after = Buffer.from(new Float32Array(host).buffer);
  check(`${name}: the host soup is byte-identical after plan()`,
    before.equals(after), `${before.length} bytes`);
}

console.log('\n=== 10. STLs for the canonical checker ===');

fs.mkdirSync(OUT, { recursive: true });
for (const [name, p, host] of CASES) {
  writeSTL(path.join(OUT, name + '.stl'), p.soup, 'NSO support strut ' + name);
  writeSTL(path.join(OUT, name + '_host.stl'), host, 'NSO support host ' + name);
  console.log(`  wrote ${name}.stl (${(p.soup.length / 9) | 0} tris) ` +
              `and ${name}_host.stl (${(host.length / 9) | 0} tris)`);
}
check('every planned case was written out', CASES.length === 3, `${CASES.length} case(s)`);

console.log('\n=== 11. A sloped band is held along its length, not only at its ends ===');

{
  /* At 60 deg the band's nz = -0.707 is inside the threshold (nzMax =
     -0.5). 60 was the card's default; at its 35 now the 45 deg band is
     steeper than the threshold and is not detected (section 13 holds that).
     The triangle pass gives it no region - the ray down from
     each chamfer triangle meets the floor, so all of them count as self-
     supported - and that is not what the card plans from: it plans the beacon
     grid, which flags the band as 'gap' spots. Those spots go through
     planTree the way the card sends one area (the card's own opts, the band's
     beacons), at the card's default rest (may not rest on the part) and with rest
     on. Held means a tip, and a pad, on the band. */
  const host = chamferBand();
  let vol = 0;
  for (let i = 0; i < host.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = host.subarray(i, i + 9);
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  /* profile 240 floor + 260 wall + 112 corner (80 wall, 32 chamfer) + 320 roof = 932 mm^2, x 40 */
  check('the chamfer-band part is one closed, outward mesh', near(vol, 932 * 40, 1e-2),
    `volume ${vol.toFixed(2)} mm^3 (932 x 40 = 37280 expected)`);
  const opts = { skipList: [], angleDeg: 60, occluders: [] };
  const det = SA.detectOverhangs(host, opts);
  const onBand = b => near(b.normal[0], Math.SQRT1_2, 0.05) && near(b.normal[2], -Math.SQRT1_2, 0.05);
  const band = (det.beacons || []).filter(onBand);
  check('the triangle pass gives the band no region: its rays down meet the floor',
    det.ok && det.regions.length === 0 && det.trisSelfSupported > 0 && det.trisFlagged === 0,
    `${det.regions.length} region(s), ${det.trisSelfSupported} self-supported, ${det.trisFlagged} flagged`);
  check('the beacon grid flags the band along its whole length, as gap spots (some by a cell corner)',
    band.length >= 12 && band.every(b => (b.need.kind === 'gap' || b.need.via === 'gap') && b.need.below === 'material') &&
    Math.min(...band.map(b => b.y)) < 3 && Math.max(...band.map(b => b.y)) > 37,
    `${band.length} spot(s), y ${Math.min(...band.map(b => b.y)).toFixed(1)}-${Math.max(...band.map(b => b.y)).toFixed(1)}`);

  const bs = band.map((b, i) => ({ x: b.x, y: b.y, z: b.z, normal: b.normal, regionId: 0, key: 'b' + i }));
  for (const rest of [false, true]) {
    const t = ST.planTree(host, Object.assign({}, opts, { beacons: bs, style: 'tree', restOnModel: rest }));
    const landing = {};
    if (t.ok) t.trunks.forEach(tr => tr.beacons.forEach(id => { landing[id] = tr.landing; }));
    const per10 = [0, 0, 0, 0];
    bs.forEach((b, id) => { if (landing[id]) per10[Math.min(3, Math.floor(b.y / 10))]++; });
    const held = Object.keys(landing).length;
    const on = rest ? 'may rest on the part' : 'plate only (the card default)';
    check(`${on}: at least one pad per 10 mm of the band`, t.ok && per10.every(n => n >= 1),
      `held ${held} of ${bs.length}; per 10 mm ${per10.join(', ')}; unreachable ${t.ok ? t.unreachable.length : '-'}`);
    if (rest) {
      check('may rest on the part: every spot on the band is held, on the plate or the floor under it',
        t.ok && held === bs.length && Object.values(landing).every(l => l === 'plate' || l === 'rest'),
        Object.entries(Object.values(landing).reduce((m, l) => (m[l] = (m[l] || 0) + 1, m), {})).map(e => e.join(' ')).join(', '));
    }
  }
}

/* 12. THE 2026-10-20 COUPON (fixtures/supports/top_clip_x2_coupon.stl), as the
   Supports card builds it: its two areas found and held, every tip under
   the slab and the leg ending in a flat cap at z_cap under the sheet - two
   transition and two interface layers, each a closed loop and ONE
   serpentine inside it, as Bambu's own tree on it
   (thinwall_sideXside.gcode.3mf) - and one pad - one support -
   under both areas' trees, as Bambu's tree stands on one first layer. */
async function coupon() {
  console.log('\n=== 12. The top_clip_x2 coupon, as the card builds it ===');
  const GP = ctx.NSO_SupportGridpack, SI = ctx.NSO_SupportInterface;
  const piece = readSTL(path.join(ROOT, 'fixtures', 'supports', 'top_clip_x2_coupon.stl'));
  const opts = { skipList: [], angleDeg: 35, occluders: [] };
  const det = SA.detectOverhangs(piece, opts);
  const regs = det.beaconRegions || [];
  const zs = regs.map(r => [...new Set(r.beacons.map(b => +b.z.toFixed(3)))].join('/'));
  check('two areas at the card\'s 35 deg: the slab\'s underside (40 spots, z 13.5) and the hanging leg\'s (9 spots, z 6.5)',
    det.ok && regs.length === 2 && regs[0].beacons.length === 40 && zs[0] === '13.5' && regs[1].beacons.length === 9 && zs[1] === '6.5',
    regs.map((r, k) => `${r.beacons.length} spots at z ${zs[k]}`).join('; '));
  const builds = [];
  let held = 0, plateZ = 0;
  for (const rg of regs) {
    const bs = rg.beacons.map(b => ({ x: b.x, y: b.y, z: b.z, normal: b.normal, regionId: rg.id, key: 'c' }));
    const t = ST.planTree(piece, Object.assign({}, opts, { beacons: bs, style: 'tree', restOnModel: false, sideMm: 1.2 }));
    if (!t.ok) continue;
    held += t.held; plateZ = t.plateZ;
    const tp = await GP.parts(t, { interface: true, foldSheets: false, footPads: 'shared' });
    if (tp.ok) builds.push({ tp, solids: GP.shells(t, tp).solids });
  }
  check('every spot held, on the plate', held === 49 && builds.length === 2, `${held} of 49`);
  const sheets = builds.map(b => b.tp.sheet);
  const tips = [].concat(...sheets.map(S => S.tips));
  const caps = tips.filter(x => x.cap);
  check('every tip under the slab and the leg ends in a flat cap (none cut at the gap, no side tips)',
    tips.length === 49 && tips.every(x => x.mode === 'sheet' && x.cap),
    `${caps.length} caps on ${tips.length} tips; ` + sheets.map(S => S.reason).join(' | '));
  const slab = sheets[0].levels[0] ? sheets[0].levels[0].caps.map(c => c.w) : [];
  check(`under the slab every cap is ${SI.CAP.minMm} - ${SI.CAP.maxMm} mm across, or held a hair short of a neighbour`,
    slab.length === 40 && slab.every(w => w <= SI.CAP.maxMm + 1e-9 && w >= SI.CAP.minMm - 0.1),
    `widths ${Math.min(...slab).toFixed(3)} - ${Math.max(...slab).toFixed(3)} mm`);
  check('each sheet is T1, T2, I1, I2 on z_cap, each layer ONE rectangular loop and ONE serpentine inside it, T2 and I2 along T1, I1 across',
    sheets.every(S => S.levels.length === 1 && S.levels[0].layers.map(x => x.role).join(',') === 'transition,transition,interface,interface' &&
      S.levels[0].layers.every(x => x.pieces.length === 1 && x.pieces[0].kind === 'rectangle' && x.paths.length === 2) && Math.abs(S.levels[0].layers[0].z0 - S.levels[0].zCap) < 1e-9 &&
      S.levels[0].layers[1].angleDeg === S.levels[0].layers[0].angleDeg && S.levels[0].layers[3].angleDeg === S.levels[0].layers[0].angleDeg &&
      Math.abs(((S.levels[0].layers[2].angleDeg - S.levels[0].layers[0].angleDeg) % 180 + 180) % 180 - 90) < 1e-6),
    sheets.map(S => S.levels.map(L => `loop ${L.layers[0].loopMm.map(v => v.toFixed(2)).join(' x ')}: ` + L.layers.map(x => `${x.role[0].toUpperCase()} ${x.lines} lines ${+x.angleDeg.toFixed(2)} deg`).join(', ')).join(';')).join(' | '));
  const sf = GP.shareFeet(builds.map(b => ({ solids: b.solids })), piece, { plateZ });
  check('one pad under the slab\'s and the leg\'s trees, and so ONE support (Bambu reported a layer-1 conflict between two)',
    sf.ok && sf.pads === 1 && sf.objects.length === 1 && sf.clustersSplit === 0, sf.ok ? sf.reason : sf.reason);
  /* the line: 0.95 of a bead, to the 0.01 mm - 0.40 at a 0.4 nozzle, under
     the 0.42 bead, for the thin-wall pass the support object asks for */
  const want = Math.round(TH.floorFor() * SI.SHEET.under * 100) / 100;
  check('the sheet\'s lines are 0.95 of a bead, 0.40 mm at a 0.4 nozzle',
    want === 0.4 && sheets.every(S => S.widthMm === want), sheets.map(S => S.widthMm).join(', ') + ` mm (bead ${TH.floorFor()})`);
  check('every support object asks for the classic wall generator and thin walls (the sheet is a thin wall)',
    JSON.stringify(SI.SHEET.slicerSettings) === JSON.stringify({ wall_generator: 'classic', detect_thin_wall: '1' }), JSON.stringify(SI.SHEET.slicerSettings));
}

/* 13. THE ANGLE IS FROM HORIZONTAL, AS BAMBU'S IS. fixtures/supports/
   simple_overhang.3mf (the owner's Simple Overhang Test): an arc whose
   underside steps 10, 20 ... 80 deg off horizontal, each step 20 mm wide.
   Bambu Studio (tree slim, threshold 30, the owner's slice of this file)
   supported only the arc's underside within 30 deg of horizontal - z 41.4 -
   46.2, 254 mm^2 - and printed the 40 - 60 deg stretch (175 mm^2) as overhang
   walls. The card's 60 was read as "Bambu 30" on the belief that Bambu
   measures from vertical; it does not. At the card's 35 the detected area is
   the top of the arc only; at the old 60 it reaches down the arc (pinned, so
   the change shows). */
async function overhangArc() {
  console.log('\n=== 13. The Simple Overhang Test: the card\'s 35 is Bambu\'s 30, a hair more sensitive ===');
  const card = fs.readFileSync(path.join(ROOT, 'app-supports-card.js'), 'utf8');
  const ANGLE = +(/var ANGLE_DEFAULT = (\d+);/.exec(card) || [])[1], BAMBU = +(/var BAMBU_ANGLE = (\d+);/.exec(card) || [])[1];
  check('the card defaults to 35 deg and names Bambu\'s 30 beside it', ANGLE === 35 && BAMBU === 30, `ANGLE_DEFAULT ${ANGLE}, BAMBU_ANGLE ${BAMBU}`);
  const R3 = require(path.join(ROOT, 'nso-3mf-read.js'));
  const res = await R3.parse3MF(new Uint8Array(fs.readFileSync(path.join(ROOT, 'fixtures', 'supports', 'simple_overhang.3mf'))));
  const piece = res.objects[0].positions;
  const tilt = t => {
    const o = t * 9, u = [0, 1, 2].map(k => piece[o + 3 + k] - piece[o + k]), v = [0, 1, 2].map(k => piece[o + 6 + k] - piece[o + k]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    return Math.acos(-n[2] / Math.hypot(...n)) * 180 / Math.PI;
  };
  const read = a => {
    const d = SA.detectOverhangs(piece, { skipList: [], angleDeg: a, occluders: [] });
    const tris = d.ok ? d.regions.flatMap(r => r.tris) : [];
    const zs = tris.flatMap(t => [2, 5, 8].map(k => piece[t * 9 + k]));
    const bz = (d.beacons || []).map(b => b.z);
    return { d, tris, area: d.ok ? d.regions.reduce((s, r) => s + r.areaMm2, 0) : 0, zlo: Math.min(...zs), zhi: Math.max(...zs),
      tilts: [...new Set(tris.map(t => Math.round(tilt(t))))].sort((x, y) => x - y),
      areas: (d.beaconRegions || []).map(r => r.beacons.length), spots: bz.length, bzlo: Math.min(...bz) };
  };
  const BAMBU_MM2 = 254;
  const at = read(ANGLE);
  check('at 35: one overhang, the arc\'s 10, 20 and 30 deg steps (6 triangles) and nothing steeper',
    at.d.ok && at.d.regions.length === 1 && at.tris.length === 6 && JSON.stringify(at.tilts) === '[10,20,30]',
    `${at.d.regions.length} region(s), ${at.tris.length} triangles, steps ${at.tilts.join(', ')} deg`);
  check('...the top of the arc only (z 37.7 - 46.5), within 20 % of Bambu\'s 254 mm^2',
    at.zlo > 37 && near(at.area, 259.06, 0.05) && Math.abs(at.area - BAMBU_MM2) <= 0.2 * BAMBU_MM2,
    `${at.area.toFixed(2)} mm^2 (${(100 * (at.area - BAMBU_MM2) / BAMBU_MM2).toFixed(1)} % off Bambu's), z ${at.zlo.toFixed(2)} - ${at.zhi.toFixed(2)}`);
  const arc = at.d.beaconRegions[0].beacons, side = at.d.beaconRegions.slice(1).flatMap(r => r.beacons);
  check('...its hanging areas: the arc\'s top (40 spots, z 38 - 46.3, faces 10 - 30 deg) and two single side spots on ridges at z 17.7 (27.5 and 28.8 deg)',
    JSON.stringify(at.areas) === '[40,1,1]' && arc.every(b => b.z > 37.9 && b.need.angle <= 30 + 1e-6 && !b.need.side) &&
      side.every(b => b.need.kind === 'ridge' && b.need.side && near(b.z, 17.73, 0.02) && b.need.angle < 29),
    `areas ${at.areas.join(', ')}; arc z ${Math.min(...arc.map(b => b.z)).toFixed(2)} - ${Math.max(...arc.map(b => b.z)).toFixed(2)}; side ` +
      side.map(b => `${b.need.kind} z ${b.z.toFixed(2)} ${b.need.angle.toFixed(1)} deg`).join(', '));
  const at30 = read(BAMBU);
  check('...the same set as at Bambu\'s own 30', at30.tris.length === 6 && near(at30.area, at.area, 1e-9) && JSON.stringify(at30.areas) === JSON.stringify(at.areas),
    `${at30.tris.length} triangles, ${at30.area.toFixed(2)} mm^2, areas ${at30.areas.join(', ')}`);
  const old = read(60);
  check('at the old 60: the 40 deg step joins (7 triangles, 301.88 mm^2, down to z 32.2)',
    old.d.ok && old.d.regions.length === 1 && old.tris.length === 7 && JSON.stringify(old.tilts) === '[10,20,30,40]' && near(old.area, 301.88, 0.05) && near(old.zlo, 32.23, 0.02),
    `${old.tris.length} triangles, steps ${old.tilts.join(', ')} deg, ${old.area.toFixed(2)} mm^2, z ${old.zlo.toFixed(2)} - ${old.zhi.toFixed(2)}`);
  check('...and the hanging areas reach down the arc: 71 spots in 2 areas (70 + 1), the lowest at z 8.6, against 42 at 35',
    JSON.stringify(old.areas) === '[70,1]' && old.spots === 71 && near(old.bzlo, 8.56, 0.02) && at.spots === 42,
    `areas ${old.areas.join(', ')}, ${old.spots} spots, lowest z ${old.bzlo.toFixed(2)}; at 35: ${at.spots} spots`);
  /* section 11's 45 deg chamfer band is steeper than 35: the card leaves it alone now */
  const band = (SA.detectOverhangs(chamferBand(), { skipList: [], angleDeg: ANGLE, occluders: [] }).beacons || [])
    .filter(b => near(b.normal[0], Math.SQRT1_2, 0.05) && near(b.normal[2], -Math.SQRT1_2, 0.05));
  check('section 11\'s 45 deg chamfer band is not detected at the card\'s 35', band.length === 0, `${band.length} spot(s) on the band`);
}

coupon().catch(err => { check('the coupon builds', false, (err && err.stack) || String(err)); })
  .then(overhangArc).catch(err => { check('the Simple Overhang Test reads', false, (err && err.stack) || String(err)); }).then(() => {
  console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
  if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }
});
