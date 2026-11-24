#!/usr/bin/env node
// Soften on a curved rim: a drawn outline with rounded corners, a D, a disc.
//
//   node tools/nso_soften_rim_test.js        exit 0 = every gate held
//
// The piece that started this: a Custom shape frame thickened into a wrist
// rest - a D-shaped shell 59 x 172 mm, a 24 mm slab on top, 2.5 mm walls and a
// pocket underneath, corners rounded at r 8. Softening its top face did three
// wrong things:
//
//   Round / Bevel   asked R 15, built R 3.27 and said "wall clamp". The clamp
//                   read the outline's point two steps along its own curve as
//                   the wall across the face - on 1 mm steps, a 2 mm "wall" on
//                   a face 59 mm wide. Every finely sampled outline (a drawn
//                   one, a cylinder) was capped by its sampling, not its size.
//   past the bend   with that gone, R stopped just under 8: an inset larger
//                   than a bend's radius folds the ring back over itself, and
//                   the fold was refused. Now the fold is cut off where the
//                   ring crosses - which is what an inset by that much IS - and
//                   the two sides of the bend meet in a soft hip.
//   Corners(+edges) the vertex engines look for sharp square corners; a rim
//                   that bends in curves has none, and they refused with
//                   "3 back onto something already softened". Corners+edges of
//                   a rim with no corner on it is the rim rounded all the way
//                   round, so that is what it does now, and says so. Corners
//                   (a ball per corner, edges left square) says plainly there
//                   is no square corner to put a ball on.
//
// The pieces are made by Custom shape itself (nso_custom_shape.js) and the
// engines are the app's own files in a vm context; nothing is reimplemented
// here. Every result goes through tools/mesh_validate.py.
//
//   1  the wrist rest  a tray with a 24 mm floor is that shell upside down;
//                      Round R 5 (under the r 8 bends) and R 15 (over them) on
//                      the floor's face: sound, the R asked (no clamp), the
//                      bends counted, a true quarter circle along a straight
//                      side, the rows fine enough at R 15
//   2  corners+edges   the same face: the rim round, bit for bit, and why
//   3  corners         refused, in words that name the way to do it
//   4  bevel           R 15 too: sound, one 45 degree band
//   5  the limit       a solid 50 mm wide: R just under half the width bakes,
//                      past it is refused with the number, never a quiet clamp
//   6  a disc          a solid cylinder, R 10 on a 30 mm rod: the R asked
//   7  sharp + curved  two square corners and two rounded ones: the setback
//                      cannot band a curve and used to come out open; now the
//                      rim round, and Corners still balls the square two
//   8  rows            small rounds keep the six rows Round always had

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { writeSTL } = require('./nso_stl_io.js');
const CS = require('../nso_custom_shape.js');

const ctx = {
  Math, Map, Set, console: { log() {}, warn() {}, error() {} }, Array, Object, Number, String, JSON,
  isFinite, isNaN, parseFloat, parseInt, Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array,
  Uint16Array, Int8Array, ArrayBuffer, Error, Infinity, NaN, Date, Promise, RegExp, Boolean, Symbol,
  setTimeout, clearTimeout
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['nso_thickness.js', 'nso_stock.js', 'app-cut.js', 'app-sculpt.js', 'app-finish.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const E = ctx;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-soften-rim-'));
let seq = 0;
function validate(soup) {
  const f = path.join(TMP, 's' + (seq++) + '.stl');
  writeSTL(f, soup, 'nso soften rim');
  const j = JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--json'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  j.ok = j.open_edges === 0 && j.nonmanifold_edges === 0 && j.inconsistent_winding_edges === 0 &&
    j.degenerate_tris === 0 && j.self_intersection.pierce === 0;
  j.summary = 'open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' inc ' + j.inconsistent_winding_edges +
    ' deg ' + j.degenerate_tris + ' pierce ' + j.self_intersection.pierce;
  return j;
}
function volume(s) {
  let v = 0;
  for (let i = 0; i < s.length; i += 9) {
    v += (s[i] * (s[i+4] * s[i+8] - s[i+5] * s[i+7]) - s[i+1] * (s[i+3] * s[i+8] - s[i+5] * s[i+6]) +
          s[i+2] * (s[i+3] * s[i+7] - s[i+4] * s[i+6])) / 6;
  }
  return v;
}
function made(spec) {
  const r = CS.make(spec);
  if (!r.ok) throw new Error('Custom shape refused the test piece: ' + r.reason);
  return r.soup;
}
// The face on the z axis, either end, through the one entry every Soften bake
// uses. keepMinFace true is the bottom face.
function soften(soup, bottom, R, mode) {
  const plane = E.rawExtremeOf(soup, 2, bottom);
  try {
    const out = E.softenSelectedFace(soup, 2, bottom, R, mode, plane);
    return { out: out, build: E.lastBuildFor(mode) };
  } catch (e) {
    return { err: e.message || String(e) };
  }
}
// Every distinct vertex of a soup.
function verts(s) {
  const seen = new Map();
  for (let i = 0; i < s.length; i += 3) {
    const k = Math.round(s[i] * 1e4) + ',' + Math.round(s[i+1] * 1e4) + ',' + Math.round(s[i+2] * 1e4);
    if (!seen.has(k)) seen.set(k, [s[i], s[i+1], s[i+2]]);
  }
  return [...seen.values()];
}

/* The wrist rest, upside down: 80 x 50 with r 8 corners and the far side
   bulged out 10 mm into a long curve (a D), 50 tall, 2.5 mm walls, a 24 mm
   floor - the slab the hand rests on is the floor, its face is z = 0. */
function wristRest() {
  const s = CS.preset('rounded');
  s.mode = 'tray'; s.height = 50; s.floor = 24;
  s.sides.forEach(x => { x.wall = 2.5; });
  s.sides[2].bulge = 10;
  return made(CS.normalize(s));
}
const REST = wristRest();
const REST_VOL = volume(REST);
// The straight front side's plane: Custom shape centres the piece on its box,
// and the bulge on the far side moves the box.
let Y0 = Infinity;
for (let i = 1; i < REST.length; i += 3) if (REST[i] < Y0) Y0 = REST[i];

/* ============================== 1. the wrist rest ============================== */
console.log('\n== 1. the wrist rest: Round on the slab face, under and over the r 8 bends ==');
check('the piece is sound before Soften', validate(REST).ok);
const ROUND = {};
for (const R of [5, 15]) {
  const r = soften(REST, true, R, 'fillet');
  ROUND[R] = r;
  if (r.err) { check('Round R ' + R + ' bakes', false, r.err); continue; }
  const v = validate(r.out);
  check('Round R ' + R + ' bakes and is sound', v.ok, v.summary);
  check('  ...at the R asked - no clamp from the outline\'s own sampling', r.build.radius === R,
    'radius ' + r.build.radius + ' asked ' + R);
  check('  ...' + (R > 8 ? 'the four r 8 bends are counted as hips' : 'no bend is tighter than R, no hip'),
    r.build.bends === (R > 8 ? 4 : 0), 'bends ' + r.build.bends);
  check('  ...and takes material, not adds it', volume(r.out) < REST_VOL - 1);

  // At the ends of the straight front side (x = +-32, where the r 8 corners
  // start - a straight side has points only at its ends), every band vertex
  // is on the quarter circle whose centre is R in and R up.
  const V = verts(r.out);
  // (y - Y0 under 8: the rows that have not reached the bend's radius.)
  const band = V.filter(p => Math.abs(p[0]) > 31 && Math.abs(p[0]) <= 32 + 1e-4 && p[1] < Y0 + Math.min(R, 8) &&
                             p[2] < R + 1e-6 && p[2] > 1e-6 && p[1] > Y0 + 1e-6);
  let worst = 0;
  for (const p of band) worst = Math.max(worst, Math.abs(Math.hypot(p[1] - (Y0 + R), p[2] - R) - R));
  check('  ...a true quarter circle down the straight side', band.length >= 4 && worst < 1e-3,
    band.length + ' band points, worst off ' + worst.toExponential(2) + ' mm');
  if (R > 8) {
    // The hip: where a round wider than the r 8 bend meets itself, every point
    // is as far in from the front wall as from the side wall - on the corner's
    // bisector - to within the bend's own chords.
    const hip = V.filter(p => p[1] < 0 && p[2] > 1e-6 && p[2] < R - 1e-6 &&
                              p[1] - Y0 > 8.3 && p[1] - Y0 < R + 1e-6 &&
                              40 - Math.abs(p[0]) > 8.3 && 40 - Math.abs(p[0]) < R + 1e-6);
    let off = 0;
    for (const p of hip) off = Math.max(off, Math.abs((40 - Math.abs(p[0])) - (p[1] - Y0)));
    check('  ...each front corner\'s hip runs up its bisector', hip.length >= 4 && off < 0.1,
      hip.length + ' hip points, worst ' + off.toFixed(3) + ' mm off');
  }
}
{
  const r = ROUND[15];
  if (!r.err) {
    check('R 15 is cut in rows of equal angle, enough that no facet stands 0.05 mm off the arc',
      r.build.rows === 10, 'rows ' + r.build.rows);
    // A hip is where the two sides of a bend meet: the lid must still be a
    // closed flat region at z = 0, and every bend's corner of it is one point.
    const lid = verts(r.out).filter(p => Math.abs(p[2]) < 1e-6);
    check('  ...the lid is still on the face\'s own plane', lid.length >= 4, lid.length + ' lid points');
  }
}

/* ============================== 2. corners+edges ============================== */
console.log('\n== 2. Corners+edges on a rim with no square corner rounds the rim ==');
for (const R of [5, 15]) {
  const ce = soften(REST, true, R, 'cornersedges');
  if (ce.err) { check('Corners+edges R ' + R + ' bakes', false, ce.err); continue; }
  const same = ROUND[R].out && ce.out.length === ROUND[R].out.length &&
               ce.out.every((x, i) => x === ROUND[R].out[i]);
  check('Corners+edges R ' + R + ' is the rim round, bit for bit', same);
  check('  ...and its build says so, with the reason', ce.build && ce.build.rimRound === true &&
    /corners/.test(ce.build.why || ''), ce.build ? JSON.stringify({ rimRound: ce.build.rimRound, why: ce.build.why }) : 'no build');
}

/* ============================== 3. corners ============================== */
console.log('\n== 3. Corners on a rim with no square corner is refused in words ==');
{
  const r = soften(REST, true, 5, 'corners');
  check('Corners R 5 is refused, naming the ways that do round this rim',
    !!r.err && /has none/.test(r.err) && /Corners\+edges or Round/.test(r.err), r.err || 'it baked');
  check('  ...and never says the face was "already softened"', !!r.err && !/already softened/.test(r.err));
}

/* ============================== 4. bevel ============================== */
console.log('\n== 4. Bevel R 15 on the same face ==');
{
  const r = soften(REST, true, 15, 'chamfer');
  const v = r.err ? null : validate(r.out);
  check('Bevel R 15 bakes and is sound', !r.err && v.ok, r.err || v.summary);
  check('  ...at the R asked, one band', !r.err && r.build.radius === 15 && r.build.rows === 1,
    r.err ? '' : 'radius ' + r.build.radius + ' rows ' + r.build.rows);
}

/* ============================== 5. the limit ============================== */
console.log('\n== 5. the limit is said with its number, never clamped quietly ==');
{
  const s = CS.preset('rounded');
  s.mode = 'solid'; s.height = 30;
  const SOLID = made(CS.normalize(s));          // 80 x 50, r 8
  const big = soften(SOLID, false, 30, 'fillet');
  const m = big.err && /R must be under ([0-9.]+)/.exec(big.err);
  const lim = m ? parseFloat(m[1]) : NaN;
  check('R 30 on a face 50 wide is refused with the R it takes', !!m && lim > 20 && lim <= 25,
    big.err || 'it baked');
  if (m) {
    const ok = soften(SOLID, false, lim, 'fillet');
    const v = ok.err ? null : validate(ok.out);
    check('  ...and that R bakes and is sound', !ok.err && v.ok, ok.err || v.summary);
  }
}

/* ============================== 6. a disc ============================== */
console.log('\n== 6. a solid rod: the R asked, all the way round ==');
{
  const ROD = E.NSO_Stock.cylinder ? E.NSO_Stock.cylinder({ d: 30, h: 30 }) : null;
  const s = { points: [{ x: 0, y: 0, r: 15 }, { x: 30, y: 0, r: 15 }, { x: 30, y: 30, r: 15 }, { x: 0, y: 30, r: 15 }],
              sides: [0, 1, 2, 3].map(() => ({ wall: 2, bulge: 0 })), height: 30, mode: 'solid' };
  const DISC = ROD && ROD.soup ? ROD.soup : made(CS.normalize(s));
  const r = soften(DISC, false, 10, 'fillet');
  const v = r.err ? null : validate(r.out);
  check('Round R 10 on a 30 mm rod bakes and is sound', !r.err && v.ok, r.err || v.summary);
  check('  ...at R 10, not the sampling\'s clamp', !r.err && r.build.radius === 10 && r.build.bends === 0,
    r.err ? '' : 'radius ' + r.build.radius + ' bends ' + r.build.bends);
}

/* ============================== 7. sharp + curved ============================== */
console.log('\n== 7. two square corners and two curved ones: the rim round, not an open mesh ==');
{
  // Before: the setback found the two sharp corners, banded "between" them
  // across the curves and came out with 77 open and 238 non-manifold edges
  // (the app's seal gate then refused it as "fights one already softened").
  const s = { points: [{ x: 0, y: 0, r: 0 }, { x: 60, y: 0, r: 0 }, { x: 60, y: 40, r: 12 }, { x: 0, y: 40, r: 12 }],
              sides: [0, 1, 2, 3].map(() => ({ wall: 2, bulge: 0 })), height: 20, mode: 'solid' };
  const D = made(CS.normalize(s));
  const ce = soften(D, false, 3, 'cornersedges');
  const v = ce.err ? null : validate(ce.out);
  check('Corners+edges R 3 bakes and is sound', !ce.err && v.ok, ce.err || v.summary);
  check('  ...as the rim round, saying the rim bends', !ce.err && ce.build.rimRound === true &&
    /bends in curves/.test(ce.build.why), ce.err ? '' : ce.build.why);
  const rr = soften(D, false, 3, 'fillet');
  check('  ...bit for bit what Round makes of it', !ce.err && !rr.err && ce.out.length === rr.out.length &&
    ce.out.every((x, i) => x === rr.out[i]));
}

/* ============================== 8. rows ============================== */
console.log('\n== 8. small rounds keep their six rows ==');
{
  const legacy = [0, 1, 2, 3, 4, 5, 6].map(s => Math.asin(s / 6));
  for (const R of [0.5, 1.0]) {
    const rows = E.rawRimRows(R);
    check('R ' + R + ': the same six rows, evenly spaced in height', rows.length === 7 &&
      rows.every((x, i) => x === legacy[i]));
  }
  check('Bevel is one band', E.rawRimRows(0).length === 2);
  for (const R of [2, 5, 15, 40]) {
    const rows = E.rawRimRows(R), d = rows[1] - rows[0];
    check('R ' + R + ': every facet within 0.05 mm of the arc', R * (1 - Math.cos(d / 2)) <= 0.05 + 1e-12 || rows.length === 33,
      (rows.length - 1) + ' rows');
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('FAILED:\n  ' + FAILS.join('\n  ')); process.exit(1); }
