#!/usr/bin/env node
// Headless self-test for nso_ring.js (Scale's ring verbs: Outer, Bore, Wall,
// and a rod's Diameter).
//
//   node tools/nso_ring_test.js        exit 0 = every gate held
//
// Every verb on every fixture, against TRUTH: MINI_TPU_TEST.stl's published
// figures (Ø20 / Ø18, wall 1, length 8 - and what its own vertices say, which
// is not quite that; section 1), nso_stock.js's tube and cylinder against their
// generator parameters, and the ring turned 90 degrees about X and about Y.
// Each result is held to four things:
//
//   the numbers     the reader's reading of the result is what the verb asked
//   the hold        what the verb says it keeps is kept - outer coordinates bit
//                   for bit on Bore and Wall, the wall to within float32 on
//                   Outer, and the LENGTH bit for bit on every axial coordinate
//   the mesh        tools/mesh_validate.py on the result: closed, manifold,
//                   consistently wound, no degenerate triangles, no piercing
//   the way back    Outer 20 -> 24 -> 20 returns the original within 1e-6 mm,
//                   or one float32 ULP at the piece's coordinate magnitude
//                   where that is coarser (see EPS below)
//
// Prints the verb x fixture table at the end; the PR quotes it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { readSTL, writeSTL } = require('./nso_stl_io.js');
const LIBDIR = require('./nso_library_dir.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, isNaN, parseFloat, parseInt,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, Int8Array, ArrayBuffer,
  Error, Infinity, NaN, Date, Promise, RegExp, Boolean, Symbol, setTimeout, clearTimeout
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['nso_thickness.js', 'nso_stock.js', 'app-cut.js', 'app-sculpt.js', 'app-finish.js',
                 'app-extend.js', 'app-fatten.js', 'nso_section.js', 'nso_ring.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { NSO_ringApplyRaw, NSO_ringOffsetRaw, NSO_ringFaces, NSO_sectionRead, NSO_sectionReadout, NSO_Stock: S, NSO_Thickness } = ctx;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* THE PRECISION A RESULT CAN HAVE, by where the piece sits. Every apply
   stores its result as float32 once, rounding each coordinate by at most half
   a ULP, so a round trip of two applies is within one ULP and a reading made
   from those coordinates within about the same. A ULP depends on the
   coordinate's magnitude, not on the piece: 9.5e-7 mm at 12 (MINI_TPU_TEST
   centred on the origin, the ticket's 1e-6 holds), 7.6e-6 mm at 100 (the same
   ring uploaded at plate position (90, 90), where 1e-6 is unreachable by any
   arithmetic). So these checks are held to 1e-6 mm or one ULP at the piece's
   largest coordinate, whichever is coarser - Extend's lengthUlps rule, the
   same lesson (docs/EXTEND.md finding 3). Section 2 runs the ring at (90, 90)
   to keep that honest. */
function EPS(soup) {
  let m = 0;
  for (let i = 0; i < soup.length; i++) { const a = Math.abs(soup[i]); if (a > m) m = a; }
  return Math.max(1e-6, ctx.NSO_extendUlp32(m));
}
const shift = (soup, d) => {
  const o = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) { o[i] = soup[i] + d[0]; o[i + 1] = soup[i + 1] + d[1]; o[i + 2] = soup[i + 2] + d[2]; }
  return o;
};
const f3 = x => (x == null ? '-' : (+x).toFixed(3));
const f6 = x => (x == null ? '-' : (+x).toFixed(6));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-ring-'));
let seq = 0;
function canonical(soup) {
  const f = path.join(TMP, 'r' + (seq++) + '.stl');
  writeSTL(f, soup, 'nso ring');
  const j = JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--json'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  j.ok = j.open_edges === 0 && j.nonmanifold_edges === 0 && j.inconsistent_winding_edges === 0 &&
    j.degenerate_tris === 0 && j.self_intersection.pierce === 0;
  j.summary = 'open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' inc ' + j.inconsistent_winding_edges +
    ' deg ' + j.degenerate_tris + ' pierce ' + j.self_intersection.pierce + ' chi ' + j.euler_characteristic;
  return j;
}

/* Quarter turns, exact: a signed permutation of the coordinates. */
const turn = (soup, f) => {
  const o = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) { const p = f(soup[i], soup[i + 1], soup[i + 2]); o[i] = p[0]; o[i + 1] = p[1]; o[i + 2] = p[2]; }
  return o;
};
const TURN_X = (x, y, z) => [x, -z, y], TURN_Y = (x, y, z) => [z, y, -x];

const TABLE = [];
function rowOf(fixture, verb, ask, r, truth) {
  const a = r.ok ? r.after : null;
  TABLE.push({
    fixture, verb, ask,
    result: r.ok ? (a.hollow ? 'Ø' + f3(a.outer.diameterMm) + ' / Ø' + f3(a.bore.diameterMm) + ', wall ' + f3(a.wallMm)
                               : 'Ø' + f3(a.outer.diameterMm)) + ', L ' + f3(a.lengthMm)
                 : 'refused: ' + r.reason,
    truth
  });
}

/* Everything one successful verb must satisfy. `expect` gives the outer and
   bore it should read, `tol` how close (the fixture's own vertex scatter). */
function holds(label, soup, r, expect, tol) {
  check(label + ': applied', r.ok, r.ok ? NSO_sectionReadout(r.after) : r.reason);
  if (!r.ok) return;
  const a = r.after, b = r.before;
  check(label + ': outer reads Ø' + f3(expect.outer), near(a.outer.diameterMm, expect.outer, tol), f6(a.outer.diameterMm));
  if (expect.bore != null) check(label + ': bore reads Ø' + f3(expect.bore), near(a.bore.diameterMm, expect.bore, tol), f6(a.bore.diameterMm));
  if (expect.wall != null) check(label + ': wall reads ' + f3(expect.wall), near(a.wallMm, expect.wall, tol), f6(a.wallMm));
  // The length, bit for bit: every axial coordinate of the soup, not just the extent.
  const k = b.axisIdx;
  let drift = 0;
  for (let i = k; i < soup.length; i += 3) if (!Object.is(r.tris[i], soup[i])) drift++;
  check(label + ': length held - every ' + b.axis + ' coordinate bit for bit', drift === 0 && a.lengthMm === b.lengthMm,
    drift + ' drifted, L ' + b.lengthMm + ' -> ' + a.lengthMm);
  check(label + ': triangle count and order unchanged', r.tris.length === soup.length);
  const c = canonical(r.tris);
  check(label + ': canonical checker clean', c.ok, c.summary);
  return c;
}

/* Outer coordinates bit for bit: every vertex of an outer-wall face is where it was. */
function outerHeld(soup, out, before) {
  const faces = NSO_ringFaces(soup, before.axisIdx, before.outer.center);
  let moved = 0;
  for (let t = 0; t < faces.side.length; t++) {
    if (faces.side[t] !== 1) continue;
    for (let i = t * 9; i < t * 9 + 9; i++) if (!Object.is(out[i], soup[i])) moved++;
  }
  return moved;
}

// MINI_TPU_TEST.stl lives in nolongerzzz/nest-library (Library -> Test
// Fixtures), not in this repo. Read from the checkout nso_library_dir.js
// resolves - CI checks it out beside the suite - and every check that needs it
// SKIPs out loud without one, never passes. Sections 4-6 do not need it.
const TPU_FILE = LIBDIR.libraryDir() && LIBDIR.catalogFile('MINI_TPU_TEST.stl');
const TPU = TPU_FILE ? readSTL(TPU_FILE) : null;
const tpu0 = TPU ? NSO_sectionRead(TPU) : null;

console.log('\n=== 1. MINI_TPU_TEST.stl as it is ===');
if (!TPU) LIBDIR.skip('sections 1-3 and 7: MINI_TPU_TEST.stl, the ring every verb is held to');
else {
  // The published figures are Ø20 / Ø18, wall 1, length 8. The file's own
  // vertices say: outer at r 9.9995 - 10.0006 (mean 10.0000), bore at r
  // 9.0020 - 9.0030. So by its vertices the bore is Ø18.005 and the wall
  // 0.998 - a compensated or rounded export, not a reader error. Held to the
  // published figures within 0.01 mm, and to the vertices' own mean exactly.
  let rs = [];
  for (let i = 0; i < TPU.length; i += 3) rs.push(Math.hypot(TPU[i], TPU[i + 1]));
  const outerV = rs.filter(r => r > 9.5), boreV = rs.filter(r => r < 9.5);
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  console.log('     vertex radii: outer ' + f6(Math.min(...outerV)) + ' - ' + f6(Math.max(...outerV)) + ' (mean ' + f6(mean(outerV)) +
    '), bore ' + f6(Math.min(...boreV)) + ' - ' + f6(Math.max(...boreV)) + ' (mean ' + f6(mean(boreV)) + ')');
  check('reads Ring', tpu0.shape === 'round' && tpu0.hollow, NSO_sectionReadout(tpu0));
  check('readout is "Ring Ø20.0 outer · Ø18.0 bore · wall 1.0 · length 8.0"',
    NSO_sectionReadout(tpu0) === 'Ring Ø20.0 outer · Ø18.0 bore · wall 1.0 · length 8.0', NSO_sectionReadout(tpu0));
  check('outer Ø20.000 (within 0.001)', near(tpu0.outer.diameterMm, 20, 1e-3), f6(tpu0.outer.diameterMm));
  check('bore Ø18.000 within 0.01 - its vertices sit at Ø18.004 - 18.006', near(tpu0.bore.diameterMm, 18, 0.01), f6(tpu0.bore.diameterMm));
  check('wall 1.000 within 0.01', near(tpu0.wallMm, 1, 0.01), f6(tpu0.wallMm));
  check('length 8.000 exactly, along Z', tpu0.axis === 'Z' && tpu0.lengthMm === 8);
  const faces = NSO_ringFaces(TPU, tpu0.axisIdx, tpu0.outer.center);
  // "96-sided" in the ticket counts wall TRIANGLES. The outline has 48
  // distinct points per loop: a 48-gon, each side one quad of two triangles.
  const pts = new Set();
  for (let i = 0; i < TPU.length; i += 3) if (Math.hypot(TPU[i], TPU[i + 1]) > 9.5) pts.add(TPU[i] + ',' + TPU[i + 1]);
  check('a 48-gon: 48 outline points, 96 outer wall triangles, 96 bore, 192 cap', pts.size === 48 &&
    faces.outer === 96 && faces.bore === 96 && faces.held === 192,
    pts.size + ' points; ' + faces.outer + ' outer, ' + faces.bore + ' bore, ' + faces.held + ' held');
  const c = canonical(TPU);
  check('the fixture itself is clean', c.ok, c.summary);
}

/* The ring cases, on the ring as shipped, turned 90 degrees about X and Y, and
   moved to plate position (90, 90) - where a float32 ULP is 7.6e-6 mm. */
const RINGS = TPU ? [['MINI_TPU_TEST', TPU], ['MINI_TPU_TEST turned 90 about X', turn(TPU, TURN_X)],
  ['MINI_TPU_TEST turned 90 about Y', turn(TPU, TURN_Y)], ['MINI_TPU_TEST at (90, 90)', shift(TPU, [90, 90, 0])]] : [];
const TOL = 0.01;   // published figure vs the file's vertices (section 1)
for (const [name, soup] of RINGS) {
  console.log('\n=== 2. ' + name + ' ===');
  const b = NSO_sectionRead(soup), eps = EPS(soup);
  console.log('     precision held to: ' + eps.toExponential(2) + ' mm');
  check(name + ' reads the same ring', b.shape === 'round' && b.hollow && b.lengthMm === 8 &&
    near(b.outer.diameterMm, tpu0.outer.diameterMm, eps) && near(b.bore.diameterMm, tpu0.bore.diameterMm, eps),
    NSO_sectionReadout(b) + ' along ' + b.axis);

  const r1 = NSO_ringApplyRaw(soup, 'outer', 24);
  holds(name + ' Outer 20 -> 24', soup, r1, { outer: 24, bore: 22, wall: 1 }, TOL);
  if (r1.ok) {
    check(name + ' Outer: the wall is kept (to float32)', near(r1.after.wallMm, b.wallMm, 2 * eps), f6(b.wallMm) + ' -> ' + f6(r1.after.wallMm));
    check(name + ' Outer: Ø24 exactly (the ask), within ' + eps.toExponential(1), near(r1.after.outer.diameterMm, 24, eps), f6(r1.after.outer.diameterMm));
    // The way back: to the original's own reading, so the lines return to
    // where they were. Asking "20" lands on 20.000000, which is 6e-5 off this
    // file's 19.99994 - the round trip is to the piece, not to the label.
    const back = NSO_ringApplyRaw(r1.tris, 'outer', b.outer.diameterMm);
    let md = 0;
    if (back.ok) for (let i = 0; i < soup.length; i++) md = Math.max(md, Math.abs(back.tris[i] - soup[i]));
    check(name + ' Outer 20 -> 24 -> 20 returns the original within ' + eps.toExponential(1) + ' mm', back.ok && md <= eps,
      'worst ' + md.toExponential(2) + ' mm');
  }
  rowOf(name, 'Outer Ø', 24, r1, 'Ø24 / Ø22, wall 1, L 8');

  const r2 = NSO_ringApplyRaw(soup, 'bore', 16);
  holds(name + ' Bore 18 -> 16', soup, r2, { outer: 20, bore: 16, wall: 2 }, TOL);
  if (r2.ok) check(name + ' Bore: the outer is kept bit for bit', outerHeld(soup, r2.tris, b) === 0);
  rowOf(name, 'Bore Ø', 16, r2, 'Ø20 / Ø16, wall 2, L 8');

  const r3 = NSO_ringApplyRaw(soup, 'wall', 2);
  holds(name + ' Wall 1 -> 2', soup, r3, { outer: 20, bore: 16, wall: 2 }, TOL);
  if (r3.ok) check(name + ' Wall: the outer is kept bit for bit', outerHeld(soup, r3.tris, b) === 0);
  rowOf(name, 'Wall', 2, r3, 'Ø20 / Ø16, wall 2, L 8');

  // Refusals, each in millimetres.
  const floor = NSO_Thickness.floorFor();
  const r4 = NSO_ringApplyRaw(soup, 'wall', 0.4);
  check(name + ' Wall -> 0.4 refused by the floor', !r4.ok && r4.tris === soup &&
    r4.reason === 'wall would be 0.4 mm, under the ' + floor + ' mm floor', r4.reason);
  rowOf(name, 'Wall', 0.4, r4, 'refused: under the ' + floor + ' mm floor');
  const r5 = NSO_ringApplyRaw(soup, 'bore', 20);
  check(name + ' Bore -> 20 refused: reaches the outer', !r5.ok && r5.tris === soup && /^bore would reach the outer - Ø20 bore against a Ø20 outer$/.test(r5.reason), r5.reason);
  rowOf(name, 'Bore Ø', 20, r5, 'refused: reaches the outer');
  const r6 = NSO_ringApplyRaw(soup, 'bore', 0);
  check(name + ' Bore -> 0 refused: closes up', !r6.ok && /^bore would close up - Ø0 mm is at or below zero$/.test(r6.reason), r6.reason);
  const r7 = NSO_ringApplyRaw(soup, 'wall', 0.5);
  check(name + ' Wall -> 0.5 is ALLOWED at the default 0.4 nozzle (floor ' + floor + ' mm)',
    r7.ok && near(r7.after.wallMm, 0.5, eps), r7.ok ? 'wall ' + f6(r7.after.wallMm) : r7.reason);
  rowOf(name, 'Wall', 0.5, r7, 'allowed: 0.5 ≥ ' + floor + ' floor');
  const r7b = NSO_ringApplyRaw(soup, 'wall', 0.5, { nozzle: 0.6 });
  check(name + ' ...and refused on a 0.6 nozzle, whose floor is 0.63 mm', !r7b.ok && r7b.reason === 'wall would be 0.5 mm, under the 0.63 mm floor', r7b.reason);
}

console.log('\n=== 3. the inversion gate, under the plan ===');
if (TPU) {
  // The plan refuses a bore past the outer before any face moves. Bypass it
  // and drive the offset itself past the wall: the cap triangles turn inside
  // out, and the primitive's own gate says so - the same verdict Thicken gives.
  const b = NSO_sectionRead(TPU);
  const r = NSO_ringOffsetRaw(TPU, b.axisIdx, b.outer.center, 0, 1.5);
  check('a bore pushed 1.5 mm out through a 1 mm wall is refused by the offset itself', !r.ok && r.tris === TPU &&
    /^the move is more than the wall it crosses \(\d+ face\(s\) would turn inside out\)$/.test(r.reason), r.reason);
  console.log('     refusal: ' + r.reason);
}

console.log('\n=== 4. Stock tube, against nso_stock.js\'s parameters ===');
{
  const made = S.make({ shape: 'tube', height: 40 });
  const m = made.sizing.measure, soup = made.soup, b = NSO_sectionRead(soup);
  const D = 2 * m.radius, d = 2 * m.inner_radius, w = m.tube_wall;
  console.log('     generator: Ø' + f6(D) + ' / Ø' + f6(d) + ', wall ' + f6(w) + ', height ' + f6(m.height));
  check('reads the generator\'s ring', near(b.outer.diameterMm, D, 1e-4) && near(b.bore.diameterMm, d, 1e-4) && near(b.wallMm, w, 1e-4));
  const t1 = NSO_ringApplyRaw(soup, 'outer', D + 4);
  holds('tube Outer +4', soup, t1, { outer: D + 4, bore: d + 4, wall: w }, 1e-4);
  rowOf('Stock tube', 'Outer Ø', f3(D + 4), t1, 'Ø' + f3(D + 4) + ' / Ø' + f3(d + 4) + ', wall ' + f3(w));
  const t2 = NSO_ringApplyRaw(soup, 'bore', d - 4);
  holds('tube Bore -4', soup, t2, { outer: D, bore: d - 4, wall: w + 2 }, 1e-4);
  if (t2.ok) check('tube Bore: outer bit for bit', outerHeld(soup, t2.tris, b) === 0);
  rowOf('Stock tube', 'Bore Ø', f3(d - 4), t2, 'Ø' + f3(D) + ' / Ø' + f3(d - 4) + ', wall ' + f3(w + 2));
  const t3 = NSO_ringApplyRaw(soup, 'wall', 3);
  holds('tube Wall -> 3', soup, t3, { outer: D, bore: D - 6, wall: 3 }, 1e-4);
  rowOf('Stock tube', 'Wall', 3, t3, 'Ø' + f3(D) + ' / Ø' + f3(D - 6) + ', wall 3');
  const t4 = NSO_ringApplyRaw(soup, 'diameter', 30);
  check('tube: Diameter is a rod verb, refused on a ring', !t4.ok && /not Diameter/.test(t4.reason), t4.reason);
}

console.log('\n=== 5. Stock cylinder: a rod, Diameter only ===');
{
  const made = S.make({ shape: 'cylinder', height: 40 });
  const m = made.sizing.measure, soup = made.soup, b = NSO_sectionRead(soup);
  console.log('     generator: Ø' + f6(2 * m.radius) + ', height ' + f6(m.height));
  check('reads a Rod with the generator\'s diameter', b.shape === 'round' && !b.hollow && near(b.outer.diameterMm, 2 * m.radius, 1e-4),
    NSO_sectionReadout(b));
  const c1 = NSO_ringApplyRaw(soup, 'diameter', 30);
  holds('cylinder Diameter -> 30', soup, c1, { outer: 30 }, EPS(soup));
  if (c1.ok) check('...still a rod, no bore appeared', !c1.after.hollow);
  rowOf('Stock cylinder', 'Diameter', 30, c1, 'Ø30, L ' + f3(m.height));
  const c2 = NSO_ringApplyRaw(soup, 'diameter', 36);
  holds('cylinder Diameter -> 36', soup, c2, { outer: 36 }, EPS(soup));
  rowOf('Stock cylinder', 'Diameter', 36, c2, 'Ø36, L ' + f3(m.height));
  for (const v of ['outer', 'bore', 'wall']) {
    const x = NSO_ringApplyRaw(soup, v, 10);
    check('cylinder: ' + v + ' refused - a rod has no bore', !x.ok && /a rod has no bore/.test(x.reason), x.reason);
  }
  const c3 = NSO_ringApplyRaw(soup, 'diameter', 0);
  check('cylinder: Diameter -> 0 refused', !c3.ok && /needs more than zero/.test(c3.reason), c3.reason);
}

console.log('\n=== 6. not round, not touched ===');
{
  for (const [name, soup] of [['sphere', S.make({ shape: 'sphere', height: 40 }).soup],
                               ['lid_strap', readSTL(path.join(ROOT, 'fixtures', 'lid_strap.stl'))]]) {
    const r = NSO_ringApplyRaw(soup, 'outer', 30);
    check(name + ' refused with the reader\'s own reason', !r.ok && r.tris === soup && /^not round - /.test(r.reason), r.reason);
  }
}

console.log('\n=== 7. why the offset is solved in the section plane, measured ===');
if (TPU) {
  // nso_ring.js's header claims Thicken's offset, with Fatten's face filter,
  // leans the walls of a ring. Pinned here so the claim stays true or gets
  // retired: one outer pass through _thickenOffsetSoup, then Extend's census.
  const b = NSO_sectionRead(TPU);
  const faces = NSO_ringFaces(TPU, b.axisIdx, b.outer.center);
  const mask = new Uint8Array(faces.side.length);
  for (let t = 0; t < mask.length; t++) mask[t] = faces.side[t] === 1 ? 1 : 0;
  const th = ctx._thickenOffsetSoup(TPU, 'out', 2, { mayMove: mask });
  const obl = soup => ctx.NSO_extendAxisCensus(soup, b.axisIdx, {}).obliqueFrac;
  const ours = NSO_ringApplyRaw(TPU, 'outer', 24);
  console.log('     Z census oblique: as shipped ' + (obl(TPU) * 100).toFixed(2) + '%, after Thicken+filter ' +
    (obl(th.soup) * 100).toFixed(2) + '%, after the ring verb ' + (obl(ours.tris) * 100).toFixed(2) + '%');
  check('Thicken with the face filter leans the walls: Z oblique 0% -> over 1%', obl(TPU) === 0 && obl(th.soup) > 0.01);
  check('...and the next reading is no longer a ring', NSO_sectionRead(th.soup).shape !== 'round', NSO_sectionRead(th.soup).reason);
  check('the section-plane solve keeps it 0%', obl(ours.tris) === 0);
}

console.log('\n=== the verb x fixture table ===');
console.log('| fixture | verb | ask | result (by the reader) | truth |');
console.log('|---|---|---|---|---|');
for (const t of TABLE) console.log('| ' + t.fixture + ' | ' + t.verb + ' | ' + t.ask + ' | ' + t.result + ' | ' + t.truth + ' |');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
