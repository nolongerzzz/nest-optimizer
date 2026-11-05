#!/usr/bin/env node
// Soften on a face with a hole: a tube end, a washer, a bored plate.
//
//   node tools/nso_soften_holes_test.js        exit 0 = every gate held
//
// Soften used to refuse every such face with "R=... too large for this face",
// at any R: the lid trim rounded ONE boundary loop and checked the trimmed lid
// against that loop's inset ring, which an annulus can never match. Now every
// loop of the face is treated - the outline rounds inward, each hole rounds
// out into the same material, same R, same profile - through the one lid /
// wall / band rebuild both cap-plane engines share (rawCapRebuildFromRings,
// app-cut.js). A loop that cannot take R is refused with the number that
// limits it.
//
// The real engines are loaded out of the app's own files into a vm context,
// the way tools/nso_ring_test.js does it; nothing is reimplemented here. Every
// result goes through tools/mesh_validate.py: closed, manifold, consistently
// wound, no degenerate triangles, no piercing.
//
//   1  routing       a tube is not a box and has no box pocket, so a click on
//                    its end reaches the per-face engine
//   2  stock tube    Ø20 wall 2, Round and Bevel R 0.5 on each end: both edges
//                    treated, the lid flat is 2.0 - 2 x 0.5 wide, every band
//                    point on the profile, the volume taken is the profile's
//   3  refusal       R 1.1 (and 1.0) on that tube: "the wall here is 2.0 mm;
//                    R must be under 1.0", and no "too large for this face"
//                    without a number anywhere
//   4  washer        the tube's bore opened to Ø8 by the Ring verbs (Bore),
//                    Round and Bevel on both faces
//   5  bored plate   a box with a hole Subtracted by the vendored kernel: all
//                    four treatments bake on it; a hole 1 mm from the edge and
//                    two holes 1 mm apart are refused with their numbers
//   6  solid cylinder  the same welded vertices, volume and radius as before
//                    this change (pinned), now sound
//   7  one copy      the lid trim lives once, in app-cut.js, and both engines
//                    call it

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { writeSTL } = require('./nso_stl_io.js');

const ctx = {
  Math, Map, Set, console: { log() {}, warn() {}, error() {} }, Array, Object, Number, String, JSON,
  isFinite, isNaN, parseFloat, parseInt, Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array,
  Uint16Array, Int8Array, ArrayBuffer, Error, Infinity, NaN, Date, Promise, RegExp, Boolean, Symbol,
  setTimeout, clearTimeout
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['nso_thickness.js', 'nso_stock.js', 'app-cut.js', 'app-sculpt.js', 'app-finish.js',
                 'app-extend.js', 'app-fatten.js', 'nso_section.js', 'nso_ring.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const E = ctx, S = ctx.NSO_Stock;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-soften-holes-'));
let seq = 0;
function validate(soup) {
  const f = path.join(TMP, 's' + (seq++) + '.stl');
  writeSTL(f, soup, 'nso soften holes');
  const j = JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--json'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  j.ok = j.open_edges === 0 && j.nonmanifold_edges === 0 && j.inconsistent_winding_edges === 0 &&
    j.degenerate_tris === 0 && j.self_intersection.pierce === 0;
  j.summary = 'open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' inc ' + j.inconsistent_winding_edges +
    ' deg ' + j.degenerate_tris + ' pierce ' + j.self_intersection.pierce + ' chi ' + j.euler_characteristic;
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
function soften(soup, keepMin, R, mode) {
  const plane = E.rawExtremeOf(soup, 2, keepMin);
  try { return { out: E.softenSelectedFace(soup, 2, keepMin, R, mode, plane), build: E.rawPerimeterFilletInPlace.lastBuild, plane }; }
  catch (e) { return { err: e.message, plane }; }
}
const NAME = { fillet: 'Round', chamfer: 'Bevel', corners: 'Corners', cornersedges: 'corners+edges' };
// The rule the ticket set: the words never appear without the number.
const honest = (msg) => !/too large for this face/.test(msg) || /too large for this face - R must be under \d/.test(msg);

/* Radial reading of a solid of revolution about the z axis: (r, z) per vertex. */
function radial(soup) {
  const out = [];
  for (let i = 0; i < soup.length; i += 3) out.push([Math.hypot(soup[i], soup[i+1]), soup[i+2]]);
  return out;
}

/* The profile the engine is defined to cut: (inset, depth) at each of its
   steps - a quarter circle sampled at t = s/6 through asin for Round, one
   flat band for Bevel. Used for the volume only, by Pappus. */
function profileRemoved(R, mode, rEdge, outward) {
  const steps = mode === 'chamfer' ? 1 : 6;
  const pts = [];
  for (let s = 0; s <= steps; s++) {
    const t = s / steps, phi = Math.asin(Math.min(1, t));
    const inset = mode === 'chamfer' ? R * t : R * (1 - Math.cos(phi));
    const depth = mode === 'chamfer' ? R * (1 - t) : R * (1 - Math.sin(phi));
    pts.push([inset, depth]);
  }
  // the removed region: the sharp corner (0, 0) and the profile
  const poly = [[0, 0]].concat(pts);
  let a2 = 0, cx = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], c = p[0] * q[1] - q[0] * p[1];
    a2 += c; cx += (p[0] + q[0]) * c;
  }
  const area = Math.abs(a2) / 2, inset = Math.abs(cx / (3 * a2));
  const rho = outward ? rEdge + inset : rEdge - inset;
  return 2 * Math.PI * rho * area;
}

const SEG = 96;   // nso_stock.js DEFAULTS.segments - what Stock builds
const TUBE = S.revolve(S.profileTube(10, 8, 20), SEG);
const CYL = S.revolve(S.profileCylinder(10, 20), SEG);
// Polygon vs circle: Pappus on the circle, the mesh is a 96-gon.
const POLY_TOL = 0.004;

/* ============================== 1. routing ============================== */
console.log('\n== 1. a click on a tube end reaches the per-face engine ==');
{
  check('a tube is not a plain box (no whole-solid wrap)', E.rawSolidBox(TUBE) === null);
  check('  ...nor one box with one box pocket', E.rawPocketBrick(TUBE) === null);
  check('  ...and has no box pocket for the in-place wrap', E.rawBoxPockets(TUBE).length === 0);
  const fc = E.rawCapFaceContext(TUBE, 2, false);
  check('its end face reads as two loops, the outline first and the bore as a hole',
    fc.loops.length === 2 && !fc.loops[0].hole && fc.loops[1].hole,
    fc.loops.map(L => L.pts.length + (L.hole ? ' hole' : ' outline')).join(', '));
}

/* ============================== 2. stock tube ============================== */
console.log('\n== 2. stock tube Ø20 wall 2, R 0.5 on each end ==');
const R = 0.5;
const base = volume(TUBE);
for (const mode of ['fillet', 'chamfer']) {
  for (const [end, keepMin] of [['top', false], ['bottom', true]]) {
    const tag = NAME[mode] + ' R ' + R + ' on the ' + end + ' end';
    const r = soften(TUBE, keepMin, R, mode);
    check(tag + ' bakes', !r.err, r.err || '');
    if (r.err) continue;
    check('  ...on both loops, at R ' + R + ' on each',
      r.build.loops === 2 && r.build.holes === 1 && Math.abs(r.build.radius - R) < 1e-9,
      'loops ' + r.build.loops + ', holes ' + r.build.holes + ', radius ' + r.build.radius);
    const v = validate(r.out);
    check('  ...closed, manifold, consistently wound, no degenerate or piercing triangles', v.ok && v.euler_characteristic === 0, v.summary);

    const P = r.plane, sign = keepMin ? 1 : -1;   // into the body along z
    // Read along the 96-gon's own vertex rays, where every ring point sits:
    // a ring point is moved off its loop point along the bisector by R / cos
    // of half the 3.75 degree turn, so K is that factor, 1.000535.
    const K = 1 / Math.cos(Math.PI / SEG);
    const onRay = [];
    for (let i = 0; i < r.out.length; i += 3) {
      const a = Math.atan2(r.out[i+1], r.out[i]) / (2 * Math.PI / SEG);
      if (Math.abs(a - Math.round(a)) < 1e-4) onRay.push([Math.hypot(r.out[i], r.out[i+1]), Math.abs(r.out[i+2] - P)]);
    }
    const lid = onRay.filter(p => p[1] < 1e-4);
    const rMin = Math.min(...lid.map(p => p[0])), rMax = Math.max(...lid.map(p => p[0]));
    check('  ...the flat at the end is 2.0 - 2 x ' + R + ' = ' + (2 - 2 * R).toFixed(1) + ' mm wide: both edges came in by R',
      Math.abs((rMax - rMin) - (2 - 2 * R * K)) < 1e-4 && Math.abs(rMin - (8 + R * K)) < 1e-4 && Math.abs(rMax - (10 - R * K)) < 1e-4,
      'flat r ' + rMin.toFixed(4) + ' .. ' + rMax.toFixed(4) + ' = ' + (rMax - rMin).toFixed(4) + ' mm on the vertex rays');
    const top = radial(r.out).filter(p => Math.abs(p[1] - P) < 1e-4);
    check('  ...no vertex left on either sharp corner', !top.some(p => Math.abs(p[0] - 10) < 1e-3 || Math.abs(p[0] - 8) < 1e-3));
    const foot = radial(r.out).filter(p => Math.abs(Math.abs(p[1] - P) - R) < 1e-4);
    check('  ...the wall below the band is untouched: 2.0 mm, Ø20 / Ø16',
      foot.length > 0 && foot.every(p => Math.abs(p[0] - 10) < 1e-4 || Math.abs(p[0] - 8) < 1e-4),
      foot.length + ' points at the band\'s foot');

    // Every band point on its profile: in the ray's own (inset, depth) plane,
    // a quarter circle of R for Round, the straight 45 degree line from the
    // wall's foot to the flat's edge for Bevel.
    const band = onRay.filter(p => p[1] <= R + 1e-6 && (p[1] > 1e-6 || Math.abs(p[0] - (10 - R * K)) < 1e-4 || Math.abs(p[0] - (8 + R * K)) < 1e-4));
    let worstOut = 0, worstIn = 0, nOut = 0, nIn = 0, between = 0;
    for (const [rr, d] of band) {
      const outer = rr > 9;
      const inset = (outer ? 10 - rr : rr - 8) / K;
      const e = mode === 'chamfer' ? Math.abs(inset + d - R) / Math.SQRT2 : Math.abs(Math.hypot(inset - R, d - R) - R);
      if (mode === 'chamfer' && d > 1e-6 && d < R - 1e-6) between++;
      if (outer) { nOut++; if (e > worstOut) worstOut = e; } else { nIn++; if (e > worstIn) worstIn = e; }
    }
    const shape = mode === 'chamfer' ? 'one straight 45 degree band' : 'a quarter circle of R ' + R;
    check('  ...the outer edge is ' + shape, nOut >= 2 * SEG && worstOut < 1e-4 && between === 0,
      nOut + ' profile points, worst off ' + worstOut.toExponential(2) + ' mm');
    check('  ...and so is the bore edge, turned the other way', nIn >= 2 * SEG && worstIn < 1e-4 && between === 0,
      nIn + ' profile points, worst off ' + worstIn.toExponential(2) + ' mm');

    const want = profileRemoved(R, mode, 10, false) + profileRemoved(R, mode, 8, true);
    const got = base - volume(r.out);
    check('  ...the volume taken is the profile turned round both edges (Pappus)',
      Math.abs(got - want) / want < POLY_TOL, 'took ' + got.toFixed(4) + ' mm3, profile ' + want.toFixed(4) + ' mm3');
  }
}

/* ============================== 3. refusal ============================== */
console.log('\n== 3. a wall too thin for R is refused, with the number ==');
for (const mode of ['fillet', 'chamfer']) {
  for (const Rbad of [1.1, 1.0]) {
    const r = soften(TUBE, false, Rbad, mode);
    check(NAME[mode] + ' R ' + Rbad + ' is refused: "the wall here is 2.0 mm; R must be under 1.0"',
      !!r.err && /the wall here is 2\.0 mm; R must be under 1\.0\b/.test(r.err), r.err || 'it baked');
    check('  ...and never says "too large for this face" without its number', !!r.err && honest(r.err));
  }
}
{
  // Under the limit it bakes - the refusal is the wall, not a blanket one.
  const r = soften(TUBE, false, 0.9, 'fillet');
  const v = r.err ? null : validate(r.out);
  check('Round R 0.9 on the same tube bakes and is sound', !r.err && v.ok, r.err || v.summary);
  // The outline's own per-point clamp predates this change and still reads as
  // a clamp; the bore has no wall across it and takes the R asked for.
  check('  ...and reports the outline\'s clamp rather than hiding it', !r.err && r.build.radius < 0.9,
    r.err ? '' : 'radius ' + r.build.radius.toFixed(4) + ' asked 0.9');
}

/* ============================== 4. washer ============================== */
console.log('\n== 4. washer: the tube\'s bore opened to Ø8 by the Ring verbs ==');
{
  const short = S.revolve(S.profileTube(10, 8, 3), SEG);
  const bored = E.NSO_ringApplyRaw(short, 'bore', 8);
  check('Ring -> Bore Ø8 makes the washer', bored.ok, bored.ok ? E.NSO_ringDescribe(bored) : bored.reason);
  if (bored.ok) {
    for (const mode of ['fillet', 'chamfer']) {
      for (const [end, keepMin] of [['top', false], ['bottom', true]]) {
        const r = soften(bored.tris, keepMin, R, mode);
        const v = r.err ? null : validate(r.out);
        let width = NaN;
        if (!r.err) {
          const lid = radial(r.out).filter(p => Math.abs(p[1] - r.plane) < 1e-4).map(p => p[0]);
          width = Math.max(...lid) - Math.min(...lid);
        }
        check(NAME[mode] + ' R ' + R + ' on the washer\'s ' + end + ' face bakes on both loops and is sound',
          !r.err && r.build.loops === 2 && v.ok && Math.abs(width - (6 - 2 * R)) < 0.01,
          r.err || (v.summary + ', flat ' + width.toFixed(3) + ' mm of the 6.0 mm wall'));
      }
    }
  }
}

/* ============================== 5. bored plate ============================== */
console.log('\n== 5. bored plates, the hole Subtracted by the vendored kernel ==');
async function plates() {
  const mod = await import('file://' + path.join(ROOT, 'vendor/manifold/manifold.js'));
  const wasm = await (mod.default || mod)();
  wasm.setup();
  const M = wasm.Manifold;
  const soupOf = (m) => {
    const mesh = m.getMesh(), vp = mesh.vertProperties, tv = mesh.triVerts, np = mesh.numProp;
    const o = new Float32Array(tv.length * 3);
    for (let t = 0; t < tv.length; t++) for (let k = 0; k < 3; k++) o[t * 3 + k] = vp[tv[t] * np + k];
    return o;
  };
  const hole = (x, y, r) => M.cylinder(5, r, r, 48, false).translate([x, y, 0]);
  const centred = soupOf(M.cube([30, 30, 5], false).subtract(hole(15, 15, 4)));
  const nearEdge = soupOf(M.cube([30, 30, 5], false).subtract(hole(25, 15, 4)));
  const twoHoles = soupOf(M.cube([30, 30, 5], false).subtract(hole(11.5, 15, 3)).subtract(hole(18.5, 15, 3)));

  const plain = soupOf(M.cube([30, 30, 5], false));
  for (const mode of ['fillet', 'chamfer', 'corners', 'cornersedges']) {
    const r = soften(centred, false, R, mode);
    const v = r.err ? null : validate(r.out);
    // Corners (vertex balls only) leaves 72 inconsistently wound edges on a
    // plain box as well - before this change and after it, hole or no hole.
    // It is held to the plate without the hole, not to a standard it has
    // never met; every other check still applies to it.
    const p = soften(plain, false, R, mode), pv = p.err ? null : validate(p.out);
    const sound = v && pv && (v.ok || (v.open_edges === 0 && v.nonmanifold_edges === 0 && v.degenerate_tris === 0 &&
                  v.self_intersection.pierce === 0 && v.inconsistent_winding_edges <= pv.inconsistent_winding_edges));
    let corners = false;
    if (!r.err) {
      // the outline's four corners are treated: none of them is still on the top face
      corners = [[0, 0], [30, 0], [30, 30], [0, 30]].every(c => {
        for (let i = 0; i < r.out.length; i += 3) {
          if (Math.abs(r.out[i] - c[0]) < 1e-4 && Math.abs(r.out[i+1] - c[1]) < 1e-4 && Math.abs(r.out[i+2] - 5) < 1e-4) return false;
        }
        return true;
      });
    }
    check(NAME[mode] + ' R ' + R + ' on a 30 x 30 plate with a Ø8 hole: the outline is treated and the piece is sound',
      !r.err && sound && corners,
      r.err || (v.summary + (v.ok ? '' : ' (without the hole: inc ' + (pv ? pv.inconsistent_winding_edges : '?') + ')')));
  }
  {
    const r = soften(centred, false, R, 'fillet');
    const fc = E.rawCapFaceContext(centred, 2, false);
    check('  ...Round took the hole too (the kernel triangulates that face its own way)',
      !r.err && r.build.loops === 2 && r.build.holes === 1 && fc.loops[1].hole, r.err || ('loops ' + r.build.loops));
  }
  for (const mode of ['fillet', 'chamfer']) {
    const r = soften(nearEdge, false, 0.6, mode);
    check(NAME[mode] + ' R 0.6 with the hole 1 mm from the edge is refused, naming the gap and the limit',
      !!r.err && /this face's hole is too close to its edge for R=0\.6 - 1\.0 mm of material there; R must be under 0\.5\b/.test(r.err) && honest(r.err),
      r.err || 'it baked');
    const ok = soften(nearEdge, false, 0.45, mode);
    const v = ok.err ? null : validate(ok.out);
    check('  ...and R 0.45 there bakes and is sound', !ok.err && v.ok, ok.err || v.summary);
  }
  {
    const r = soften(twoHoles, false, 0.6, 'fillet');
    check('Round R 0.6 with two holes 1 mm apart is refused, naming the gap and the limit',
      !!r.err && /two holes on this face are 1\.0 mm apart, too close for R=0\.6; R must be under 0\.5\b/.test(r.err) && honest(r.err),
      r.err || 'it baked');
  }
}

/* ============================== 6. solid cylinder ============================== */
function solidCylinder() {
  console.log('\n== 6. solid cylinder: the same shape as before this change, now sound ==');
  /* Pinned from the engine as it stood before this change (git HEAD at the
     time, 7 Oct-14 build): the unique vertices at the mesh's 1e-4 weld, the
     volume and the radius it reports. That engine also emitted sliver lid
     triangles between near-twin points, which left 64 to 88 non-manifold
     edges on every stock cylinder end - the app's seal gate then refused the
     bake. The slivers are gone; the shape is not touched. */
  const PIN = [
    ['top', 'fillet', 0.5, '770:3957f8a23bd0', 6275.0649, 0.5],
    ['top', 'fillet', 1.1, '770:ff64e0c6dc06', 6273.6736, 0.5886282091671307],
    ['top', 'chamfer', 0.5, '290:f44ff320e675', 6270.9787, 0.5],
    ['top', 'chamfer', 1.1, '290:6a29e1c059f7', 6268.0308, 0.5886282091671307],
    ['bottom', 'fillet', 0.5, '770:d45605cda593', 6275.0649, 0.5],
    ['bottom', 'fillet', 1.1, '770:42a4fe2a66fb', 6273.6736, 0.5886282091671307],
    ['bottom', 'chamfer', 0.5, '290:d3ccf1d90d41', 6270.9787, 0.5],
    ['bottom', 'chamfer', 1.1, '290:95f59c72b45c', 6268.0309, 0.5886282091671307]
  ];
  const fp = (s) => {
    const k = new Set();
    for (let i = 0; i < s.length; i += 3) k.add(Math.round(s[i] * 1e4) + ',' + Math.round(s[i+1] * 1e4) + ',' + Math.round(s[i+2] * 1e4));
    const a = [...k].sort();
    return a.length + ':' + crypto.createHash('sha1').update(a.join(';')).digest('hex').slice(0, 12);
  };
  check('a stock cylinder end still reads as one loop', E.rawCapFaceContext(CYL, 2, false).loops.length === 1);
  for (const [end, mode, Rp, print, vol, rad] of PIN) {
    const r = soften(CYL, end === 'bottom', Rp, mode);
    if (r.err) { check(NAME[mode] + ' R ' + Rp + ' on the ' + end + ' end bakes', false, r.err); continue; }
    const v = validate(r.out);
    const got = fp(r.out), gv = volume(r.out);
    check(NAME[mode] + ' R ' + Rp + ' on the ' + end + ' end: same vertices, volume and radius as before',
      got === print && Math.abs(gv - vol) < 2e-4 && r.build.radius === rad,
      got + ', ' + gv.toFixed(4) + ' mm3, R ' + r.build.radius.toFixed(4));
    check('  ...and sound', v.ok && v.euler_characteristic === 2, v.summary);
  }
}

/* ============================== 7. one copy ============================== */
function oneCopy() {
  console.log('\n== 7. the lid trim lives once ==');
  const cut = fs.readFileSync(path.join(ROOT, 'app-cut.js'), 'utf8');
  const fin = fs.readFileSync(path.join(ROOT, 'app-finish.js'), 'utf8');
  const body = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    const j = src.indexOf('\nfunction ', i + 1);
    return i < 0 ? '' : src.slice(i, j < 0 ? src.length : j);
  };
  check('the lid check against the inset rings is in app-cut.js only',
    /function rawLidTrimToRings2\(/.test(cut) && !/ringArea - lidAfter/.test(cut + fin));
  check('Round and Bevel (rawPerimeterFilletBuild) call the shared rebuild',
    /rawCapRebuildFromRings\(/.test(body(fin, 'rawPerimeterFilletBuild')));
  check('the corner round in app-cut.js (rawEdgeRoundBuild) calls the same rebuild',
    /rawCapRebuildFromRings\(/.test(body(cut, 'rawEdgeRoundBuild')));
  const all = fs.readdirSync(ROOT).filter(f => /^app-.*\.js$/.test(f) && f !== 'app.full.js')
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const said = all.split('\n').filter(l => /too large for this face/.test(l));
  check('"too large for this face" is said in one place, and with the limit',
    said.length === 1 && /R must be under/.test(said[0]), said.map(s => s.trim()).join(' | '));
}

plates().then(() => {
  solidCylinder();
  oneCopy();
}).catch((e) => {
  check('the vendored kernel loads and the plates build', false, e && e.message);
}).finally(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('FAILED:\n  ' + FAILS.join('\n  ')); process.exit(1); }
});
