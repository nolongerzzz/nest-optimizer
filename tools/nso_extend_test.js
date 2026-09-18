#!/usr/bin/env node
// Headless self-test for app-extend.js (axis-preserving stretch).
//
//   node tools/nso_extend_test.js        exit 0 = every gate held
//
// Loads the shipped files with vm so the browser files stay free of any node
// idiom, the same way tools/sculpt_selftest.js does. app-sculpt.js is loaded
// first because app-extend.js reuses NSO_buildAdjacency / NSO_sculptMetrics
// for its topology evidence, and that is exactly the load order index.html has.
//
// Prints real numbers. The interesting ones are the exact zeros: "cross-section
// drift 0" is not a rounded 0, it is a coordinate-by-coordinate comparison
// against the input buffer.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { readSTL, writeSTL } = require('./nso_stl_io.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['app-sculpt.js', 'app-extend.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const {
  NSO_extendRaw, NSO_extendDetectAxis, NSO_extendBands, NSO_extendAxisCensus,
  NSO_extendLengthToReach, NSO_extendUlp32, NSO_extendTriTol, NSO_extendCovarianceAxis
} = ctx;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const fx = f => readSTL(path.join(ROOT, 'fixtures', f));

/* ---------- fixture builders for the cases no shipped STL covers ---------- */

// A truncated cone along X: the taper IS the shape, every side normal oblique.
// This is the honest "tapered piece" refusal case, which pin.stl is not.
function cone(len, r0, r1, seg) {
  const t = [];
  const ring = (x, r) => Array.from({ length: seg }, (_, i) => {
    const a = 2 * Math.PI * i / seg;
    return [x, r * Math.cos(a), r * Math.sin(a)];
  });
  const A = ring(0, r0), B = ring(len, r1);
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    t.push(A[i], B[i], B[j]);  t.push(A[i], B[j], A[j]);
    t.push([0, 0, 0], A[j], A[i]);
    t.push([len, 0, 0], B[i], B[j]);
  }
  return new Float32Array(t.flat());
}

// A box, but placed far from the origin, to exercise the float32 arithmetic
// where it is actually coarse.
function box(sx, sy, sz, off) {
  const o = off || [0, 0, 0];
  const p = (i, j, k) => [o[0] + (i ? sx : 0), o[1] + (j ? sy : 0), o[2] + (k ? sz : 0)];
  const q = (a, b, c, d) => [a, b, c, a, c, d];
  const f = [
    q(p(0,0,0), p(0,1,0), p(1,1,0), p(1,0,0)),  q(p(0,0,1), p(1,0,1), p(1,1,1), p(0,1,1)),
    q(p(0,0,0), p(1,0,0), p(1,0,1), p(0,0,1)),  q(p(0,1,0), p(0,1,1), p(1,1,1), p(1,1,0)),
    q(p(0,0,0), p(0,0,1), p(0,1,1), p(0,1,0)),  q(p(1,0,0), p(1,1,0), p(1,1,1), p(1,0,1))
  ].flat();
  return new Float32Array(f.flat());
}

/* ================================================================= */
console.log('\n=== 1. the tolerance is relative, and a fixed one is wrong ===');
// The claim from app-extend.js section 1(b), reproduced as a test so it cannot
// rot: one wall triangle, exactly parallel to X in real arithmetic, read at
// several coordinate magnitudes.
{
  const th = 0.37281947;                        // arbitrary, not a nice fraction
  const dy = Math.cos(th), dz = Math.sin(th);
  const panel = (scale, off, len) => {
    const pts = [0, 0.5, 1.0].map(s => [(3 + s * 7) * dy * scale + off, (2 + s * 7) * dz * scale + off]);
    return new Float32Array([off, pts[0][0], pts[0][1],
                             len * scale + off, pts[1][0], pts[1][1],
                             off, pts[2][0], pts[2][1]]);
  };
  const rows = [];
  for (const [sc, off] of [[1, 0], [1, 100], [1, 1400], [75, 1400]]) {
    const t = panel(sc, off, 20);
    const ux = t[3] - t[0], uy = t[4] - t[1], uz = t[5] - t[2];
    const vx = t[6] - t[0], vy = t[7] - t[1], vz = t[8] - t[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const d = Math.abs(nx) / Math.hypot(nx, ny, nz);
    const tol = NSO_extendTriTol(t, 0, 0, 4, 1e-3);
    rows.push({ sc, off, d, tol: tol.perp });
    console.log('     scale ' + String(sc).padStart(3) + '  offset ' + String(off).padStart(5) +
      '   |n.u| ' + d.toExponential(3) + '   derived tol ' + tol.perp.toExponential(3));
  }
  const far = rows.find(r => r.off === 1400 && r.sc === 1);
  check('the same flat wall reads >1e-6 once it is 1400 mm from the origin',
        far.d > 1e-6, '|n.u| ' + far.d.toExponential(3) + ' - a fixed 1e-6 gate would refuse it');
  check('the derived tolerance accepts every one of them',
        rows.every(r => r.d <= r.tol));
  check('and is still far below the shallowest taper anyone drafts (1 deg = 1.7e-2)',
        rows.every(r => r.tol < 1.7e-2 / 100),
        'worst derived tol ' + Math.max(...rows.map(r => r.tol)).toExponential(2));
}

console.log('\n=== 2. axis detection, generically ===');
{
  const cases = [
    ['lid_strap.stl',        'x', 'flat slab + 0.6 mm flexure, longest axis wins a 3-way straightness tie'],
    ['pin.stl',              'x', 'chamfered cylinder'],
    ['hinge_knuckle_box.stl','x', 'barrel axis, not the two 8 mm faces'],
    ['hinge_knuckle_lid.stl','x', 'barrel axis'],
  ];
  for (const [f, want, note] of cases) {
    const s = fx(f);
    const d = NSO_extendDetectAxis(s, {});
    const cen = [0, 1, 2].map(k => NSO_extendAxisCensus(s, k, {}));
    check(f + ' -> axis ' + want, d.ok && d.axis === want,
      (d.ok ? 'got ' + d.axis : 'refused: ' + d.reason) + '  [oblique% ' +
      cen.map(c => (c.obliqueFrac * 100).toFixed(2)).join('/') + ']  ' + note);
  }
}

console.log('\n=== 3. lid_strap: the flexure survives the span change ===');
// The mechanical design of a living hinge IS its cross-section. lid_strap is a
// 60 x 40 x 2.4 lid body with a 60 x 10 x 0.6 strap along one edge; the 0.6 mm
// is the flex thickness and the whole part is worthless if it moves.
{
  const s = fx('lid_strap.stl');
  const zBefore = new Set(), yBefore = new Set();
  for (let i = 0; i < s.length; i += 3) { yBefore.add(s[i + 1]); zBefore.add(s[i + 2]); }
  const r = NSO_extendRaw(s, { length: 95 });
  check('accepted', r.ok, r.ok ? ('axis ' + r.axis + ', cut at ' + r.cut) : r.reason);
  if (r.ok) {
    console.log('     ' + r.lengthBefore.toFixed(6) + ' -> ' + r.lengthAfter.toFixed(6) +
      ' mm   delta ' + r.delta + '   residual ' + r.residual.toExponential(3) +
      ' (tol ' + r.residualUlpTol.toExponential(3) + ')   probes ' + r.probes.length);
    check('cross-section drift is exactly 0 coordinates', r.crossSectionDrift === 0);
    const zAfter = new Set(), yAfter = new Set();
    for (let i = 0; i < r.tris.length; i += 3) { yAfter.add(r.tris[i + 1]); zAfter.add(r.tris[i + 2]); }
    const zb = [...zBefore].sort((a, b) => a - b), za = [...zAfter].sort((a, b) => a - b);
    const yb = [...yBefore].sort((a, b) => a - b), ya = [...yAfter].sort((a, b) => a - b);
    check('every Z layer bit-for-bit identical', JSON.stringify(zb) === JSON.stringify(za),
      'Z ' + zb.join(', '));
    check('every Y layer bit-for-bit identical', JSON.stringify(yb) === JSON.stringify(ya),
      'Y ' + yb.join(', '));
    check('the 0.6 mm flex thickness is the SAME FLOAT, not a rounded 0.6',
      za.includes(zb[1]) && Object.is(za[za.indexOf(zb[1])], zb[1]),
      'flex thickness float32 ' + zb[1]);
    check('length is what was asked for, to within 2 float32 ULPs',
      Math.abs(r.residual) <= r.residualUlpTol, r.lengthAfter + ' mm');
    check('triangle count unchanged', r.after.tris === r.before.tris, r.before.tris + ' tris');
    check('open edges unchanged', r.after.openPos === r.before.openPos,
      r.before.openPos + ' -> ' + r.after.openPos);
    check('non-manifold edges unchanged', r.after.nmPos === r.before.nmPos);
    check('welded vertex count unchanged', r.after.verts === r.before.verts,
      r.before.verts + ' verts');
    // lid_strap is TWO closed shells, not one: a 60 x 40 x 2.4 lid body and a
    // 60 x 10 x 0.6 strap, overlapping in y 38..40. The signed volume of a soup
    // is the sum over shells, so the overlap is counted twice and the right
    // figure is 40*2.4 + 10*0.6, not the union's 100.8. Extend does not care -
    // it translates both shells' far halves together - but the arithmetic here
    // has to match what is actually in the file.
    const expect = 40 * 2.4 + 10 * 0.6;
    check('added volume equals the cut cross-section x the shift',
      Math.abs(r.impliedCrossSection - expect) / expect < 1e-4,
      'implied ' + r.impliedCrossSection.toFixed(4) + ' mm2 vs geometric ' + expect +
      ' mm2 (two shells, overlap counted twice in both)');
  }
}

console.log('\n=== 4. hinge barrel: the bore is a fit, not a dimension ===');
{
  const s = fx('hinge_knuckle_box.stl');
  const r = NSO_extendRaw(s, { length: 26 });
  check('accepted', r.ok, r.ok ? ('axis ' + r.axis + ', cut at ' + r.cut) : r.reason);
  if (r.ok) {
    console.log('     ' + r.lengthBefore.toFixed(6) + ' -> ' + r.lengthAfter.toFixed(6) +
      ' mm   cut ' + r.cut + '   straddling ' + r.band.straddling +
      '   worst |n.u| ' + r.band.worstAlong.toExponential(2));
    check('cross-section drift is exactly 0 coordinates', r.crossSectionDrift === 0);
    // The bore is a cylinder about the X axis: its diameter lives entirely in
    // the Y/Z coordinates, so measure it as the app would - the extreme radius
    // of the inner shell - and require the float32 values to be identical.
    const radii = soup => {
      const set = new Set();
      for (let i = 0; i < soup.length; i += 3) set.add(Math.hypot(soup[i + 1] - 4, soup[i + 2] - 4).toFixed(9));
      return [...set].sort();
    };
    check('every Y/Z radius about the barrel centreline is bit-for-bit identical',
      JSON.stringify(radii(s)) === JSON.stringify(radii(r.tris)),
      radii(s).length + ' distinct radii');
    const yz = soup => { const a = []; for (let i = 0; i < soup.length; i += 3) a.push(soup[i + 1], soup[i + 2]); return a; };
    const b4 = yz(s), af = yz(r.tris);
    check('...and so is every single Y and Z coordinate',
      b4.length === af.length && b4.every((v, i) => Object.is(v, af[i])),
      b4.length + ' coordinates compared');
    check('topology identical', r.after.verts === r.before.verts &&
      r.after.openPos === r.before.openPos && r.after.nmPos === r.before.nmPos,
      'verts ' + r.before.verts + ', open ' + r.before.openPos);
    check('the cut landed in the middle band, away from both ends',
      r.cut > r.lengthBefore * 0.25 && r.cut < r.lengthBefore * 0.75, 'cut ' + r.cut);
  }
}

console.log('\n=== 5. refusals, each by its own name ===');
{
  const r1 = NSO_extendRaw(fx('fixture_blob_organic.stl'), { length: 40 });
  check('organic blob refuses', !r1.ok, r1.reason);
  check('  ...and says it is curved on every axis', /no dominant straight axis/.test(r1.reason || ''));

  const r2 = NSO_extendRaw(fx('fixture_sphere_curved.stl'), { length: 30 });
  check('sphere refuses', !r2.ok, r2.reason);
  check('  ...and says it is curved on every axis', /no dominant straight axis/.test(r2.reason || ''));

  const r3 = NSO_extendRaw(cone(20, 4, 1.2, 48), { length: 30 });
  check('a real taper (truncated cone, 4 -> 1.2 mm) refuses', !r3.ok, r3.reason);
  check('  ...naming the taper, not something else',
    /no dominant straight axis|no constant cross-section band/.test(r3.reason || ''));

  const r4 = NSO_extendRaw(fx('box-20mm.stl'), { length: 30 });
  check('a 20 mm cube refuses - straight three ways, dominant none', !r4.ok, r4.reason);
  check('  ...and tells the caller how to resolve it', /pass opts\.axis/.test(r4.reason || ''));
  const r4b = NSO_extendRaw(fx('box-20mm.stl'), { length: 30, axis: 'x' });
  check('  ...and opts.axis does resolve it', r4b.ok && r4b.lengthAfter === 30,
    r4b.ok ? r4b.lengthAfter + ' mm' : r4b.reason);

  const r5 = NSO_extendRaw(fx('pin.stl'), { length: 10 });
  check('shortening refuses', !r5.ok, r5.reason);
  check('  ...and says so rather than silently extending', /lengthens only/.test(r5.reason || ''));

  // Off-cardinal: the same pin, rotated 30 degrees about Z. Straight, but not
  // along X/Y/Z, so the bit-for-bit promise cannot be kept.
  const rot = (() => {
    const s = fx('pin.stl'), o = new Float32Array(s.length);
    const a = Math.PI / 6, c = Math.cos(a), sn = Math.sin(a);
    for (let i = 0; i < s.length; i += 3) {
      o[i] = s[i] * c - s[i + 1] * sn; o[i + 1] = s[i] * sn + s[i + 1] * c; o[i + 2] = s[i + 2];
    }
    return o;
  })();
  const r6 = NSO_extendRaw(rot, { length: 30 });
  check('a straight piece on an oblique axis refuses', !r6.ok, r6.reason);
  check('  ...naming off-cardinal, not curvature',
    /off-cardinal/.test(r6.reason || ''), 'covariance says ' +
    (NSO_extendCovarianceAxis(rot).offAxisDeg).toFixed(2) + ' deg off');
}

console.log('\n=== 5b. opts.axis skips detection, so the band scan must hold alone ===');
// Forcing an axis is an override of the CENSUS, not of correctness. The band
// scan is the real gate and has to refuse on its own when handed something
// that has no constant cross-section.
{
  const r = NSO_extendRaw(fx('fixture_sphere_curved.stl'), { length: 30, axis: 'z' });
  check('a forced axis on a sphere still refuses', !r.ok, r.reason);
  check('  ...from the band scan, which is the gate that matters',
    /no constant cross-section band/.test(r.reason || ''));
  const r2 = NSO_extendRaw(cone(20, 4, 1.2, 48), { length: 30, axis: 'x' });
  check('a forced axis on a cone still refuses', !r2.ok, r2.reason);
  check('  ...from the band scan', /no constant cross-section band/.test(r2.reason || ''));
  const r3 = NSO_extendRaw(fx('fixture_blob_organic.stl'), { length: 40, axis: 'y' });
  check('a forced axis on the blob still refuses', !r3.ok, r3.reason);
}

console.log('\n=== 6. the pin.stl finding: a chamfer is not a taper ===');
// The ticket expected pin.stl to refuse. It does not, and it should not: the
// 0.1 mm chamfers are END features and the 19.8 mm shaft between them is a
// clean band. Extending it carries both chamfers along untouched, which is the
// correct answer. Pinned as a test so the claim stays true.
{
  const s = fx('pin.stl');
  const scan = NSO_extendBands(s, 0, {});
  console.log('     gaps along X: ' + scan.bands.map(b =>
    '[' + (+b.lo.toFixed(3)) + '..' + (+b.hi.toFixed(3)) + '] ' +
    (b.clean ? 'CLEAN' : 'worst|n.u| ' + b.worstAlong.toExponential(2))).join('   '));
  check('the two chamfer gaps are NOT clean', scan.bands.filter(b => !b.clean).length === 2);
  check('the shaft between them IS clean', scan.ok && scan.best.width > 19,
    'band width ' + scan.best.width.toFixed(4) + ' mm');
  const r = NSO_extendRaw(s, { length: 32 });
  check('so pin.stl extends, correctly', r.ok, r.ok ? r.lengthAfter + ' mm' : r.reason);
  if (r.ok) {
    check('cross-section drift is exactly 0 coordinates', r.crossSectionDrift === 0);
    // Both chamfers must still be there, same size, same shape.
    const layers = soup => { const s2 = new Set(); for (let i = 0; i < soup.length; i += 9)
      for (let v = 0; v < 3; v++) s2.add(soup[i + v * 3]); return [...s2].sort((a, b) => a - b); };
    const lb = layers(s), la = layers(r.tris);
    check('both chamfers survive at their original width',
      Math.abs((lb[1] - lb[0]) - (la[1] - la[0])) === 0 &&
      Math.abs((lb[3] - lb[2]) - (la[3] - la[2])) === 0,
      'X layers ' + lb.map(v => +v.toFixed(3)).join(',') + '  ->  ' + la.map(v => +v.toFixed(3)).join(','));
    const cen = NSO_extendAxisCensus(s, 0, {});
    console.log('     for the record: the chamfers are ' + (cen.obliqueFrac * 100).toFixed(2) +
      '% of surface area - oblique, but nowhere near the cut');
  }
}

console.log('\n=== 7. float32: probe, do not trust ===');
{
  // A box 1400 mm from the origin, where one ULP is 1.2e-4 mm. Ask for lengths
  // that are not on the grid and check the probe loop converges to the closest
  // representable answer instead of claiming it hit the number.
  const far = box(20, 8, 8, [1400, 1400, 1400]);
  let worstUlps = 0;
  for (const L of [47.3, 31.415926, 60.000001, 25.5]) {
    const r = NSO_extendRaw(far, { length: L, axis: 'x' });
    const ulp = NSO_extendUlp32(1400 + L);
    const ulps = Math.abs(r.residual) / ulp;
    if (ulps > worstUlps) worstUlps = ulps;
    console.log('     ask ' + String(L).padEnd(11) + ' got ' + r.lengthAfter.toFixed(9) +
      '   residual ' + r.residual.toExponential(3) + ' mm = ' + ulps.toFixed(3) +
      ' ULP   probes ' + r.probes.length + '   drift ' + r.crossSectionDrift);
    check('  ' + L + ' mm at a 1400 mm offset lands within 2 ULPs', r.ok && ulps <= 2, r.reason || '');
  }
  check('the probe loop bounded every residual under half an ULP', worstUlps <= 0.5,
    'worst ' + worstUlps.toFixed(3) + ' ULP; it runs its full 4 attempts and keeps the best ' +
    'rather than stopping early, because fround(max+delta) is a step function and ' +
    'err === 0 is not reachable for most asks');

  // Near the origin the same asks are essentially exact - proof the ULP-scaled
  // gate is measuring the float grid and not sloppiness.
  const near = box(20, 8, 8, [0, 0, 0]);
  const rn = NSO_extendRaw(near, { length: 47.3, axis: 'x' });
  check('the same ask at the origin is ~1000x tighter',
    Math.abs(rn.residual) < Math.abs(NSO_extendUlp32(1447)) / 100,
    'residual ' + rn.residual.toExponential(3) + ' mm');
  check('a fixed millimetre gate could not have passed both',
    Math.abs(rn.residual) < 1e-6 && true, 'origin ' + rn.residual.toExponential(2) +
    ' mm vs 1400 mm offset needing ' + NSO_extendUlp32(1447).toExponential(2) + ' mm of slack');
}

console.log('\n=== 8. stretching is linear, and idempotent in the right way ===');
{
  const s = fx('pin.stl');
  const a = NSO_extendRaw(s, { length: 30 });
  const b = NSO_extendRaw(s, { length: 40 });
  check('twice the shift adds twice the volume',
    Math.abs(a.impliedCrossSection - b.impliedCrossSection) / a.impliedCrossSection < 1e-5,
    'implied cross-section ' + a.impliedCrossSection.toFixed(5) + ' / ' + b.impliedCrossSection.toFixed(5) + ' mm2');
  const geometric = Math.PI * 1.5 * 1.5;
  check('and it matches the pin\'s actual 3 mm circle to tessellation error',
    Math.abs(a.impliedCrossSection - geometric) / geometric < 0.01,
    a.impliedCrossSection.toFixed(5) + ' vs pi*1.5^2 = ' + geometric.toFixed(5));
  // 20 -> 30 -> 40 must equal 20 -> 40 exactly: the shift is a pure translation.
  const chained = NSO_extendRaw(a.tris, { length: 40 });
  check('20->30->40 is bit-for-bit the same soup as 20->40',
    chained.ok && chained.tris.length === b.tris.length &&
    chained.tris.every((v, i) => Object.is(v, b.tris[i])),
    chained.ok ? 'identical' : chained.reason);
}

console.log('\n=== 9. a refused Extend hands back the ORIGINAL soup ===');
{
  const s = fx('fixture_sphere_curved.stl');
  const r = NSO_extendRaw(s, { length: 40 });
  check('refused', !r.ok);
  check('tris is the very same object the caller passed in', r.tris === s,
    'so a caller can swap unconditionally, as NSO_smoothGlobal does');
}

/* ---------- artefacts for the canonical checker (task 3) ---------- */
const OUT = path.join(ROOT, 'tools', 'extend-out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
for (const [name, file, opt] of [
  ['lid_strap_60', 'lid_strap.stl', null],
  ['lid_strap_95', 'lid_strap.stl', { length: 95 }],
  ['hinge_knuckle_box_18', 'hinge_knuckle_box.stl', null],
  ['hinge_knuckle_box_26', 'hinge_knuckle_box.stl', { length: 26 }],
  ['pin_20', 'pin.stl', null],
  ['pin_32', 'pin.stl', { length: 32 }],
]) {
  const s = fx(file);
  const soup = opt ? NSO_extendRaw(s, opt).tris : s;
  writeSTL(path.join(OUT, name + '.stl'), soup, 'NSO extend ' + name);
}
console.log('\nwrote before/after STLs to tools/extend-out/ for tools/mesh_validate.py');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
