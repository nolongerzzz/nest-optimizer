#!/usr/bin/env node
// Headless self-test for nso_section.js (the section reader).
//
//   node tools/nso_section_test.js        exit 0 = every reading held
//
// Every number is held against the GENERATOR's own parameters - nso_stock.js's
// sizing report, nso_features.js's HOST.size, the fixtures' published
// dimensions - never against what the reader said last time. And every piece
// is read again turned 90 degrees about X, about Y and about Z: a quarter turn
// is an exact signed permutation of the coordinates, so the answer has to be
// the same answer, to the bit where it is a measurement.
//
// Prints the classifier's table at the end; the PR quotes it.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { readSTL } = require('./nso_stl_io.js');
const LIBDIR = require('./nso_library_dir.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer, Error, Infinity, NaN
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['nso_thickness.js', 'nso_stock.js', 'app-cut.js', 'app-sculpt.js', 'app-extend.js', 'nso_section.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { NSO_sectionRead, NSO_sectionReadout, NSO_Stock: S } = ctx;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// Float32 storage of a generator's float64 parameter: a few parts in 1e7.
const TOL = 1e-4;

/* Quarter turns, exact: (x,y,z) -> a signed permutation. */
const TURNS = {
  'X+90': (x, y, z) => [x, -z, y],
  'Y+90': (x, y, z) => [z, y, -x],
  'Z+90': (x, y, z) => [-y, x, z]
};
function turn(soup, f) {
  const o = new Float32Array(soup.length);
  for (let i = 0; i < soup.length; i += 3) { const p = f(soup[i], soup[i + 1], soup[i + 2]); o[i] = p[0]; o[i + 1] = p[1]; o[i + 2] = p[2]; }
  return o;
}

/* A rectangular tube along Z: outer W x D, inner w x d (centred), height h.
   Not in any generator, so built here - four outer walls facing out, four
   inner walls facing in, two annular caps of four trapezoids each. */
function rectTube(W, D, w, d, h) {
  const t = [];
  const O = [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2], [-W / 2, D / 2]];
  const I = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]];
  const P = (q, z) => [q[0], q[1], z];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    t.push(P(O[i], 0), P(O[j], 0), P(O[j], h), P(O[i], 0), P(O[j], h), P(O[i], h));      // outer, out
    t.push(P(I[j], 0), P(I[i], 0), P(I[i], h), P(I[j], 0), P(I[i], h), P(I[j], h));      // inner, in
    t.push(P(O[i], h), P(O[j], h), P(I[j], h), P(O[i], h), P(I[j], h), P(I[i], h));      // top, +z
    t.push(P(O[j], 0), P(O[i], 0), P(I[i], 0), P(O[j], 0), P(I[i], 0), P(I[j], 0));      // bottom, -z
  }
  return new Float32Array(t.flat());
}

async function hullAlone() {
  // nso_features.js's own host, the box build() starts every piece from:
  // Manifold.cube of HOST.size, centred on x and y, resting on z = 0.
  const FX = require('./nso_features.js');
  const D = require('./nso_damage.js');
  const w = await D.kernel();
  const s = FX.HOST.size;
  const m = w.Manifold.cube(s, false).translate([-s[0] / 2, -s[1] / 2, 0]);
  const soup = D.toSoup(m);
  m.delete();
  return { soup, size: s };
}

const TABLE = [];
function row(name, r, truth) {
  TABLE.push({ name, shape: r.shape, hollow: r.hollow, axis: r.axis, readout: NSO_sectionReadout(r), truth, reason: r.reason });
}

/* The same piece turned three ways must read the same. Axis letters move with
   the turn, so they are taken out of the gate's words before comparing; every
   number is compared exactly. The gate (r.why) is compared, not the whole
   reason line: its "so ... apply" tail names Length / Width / Height, which
   are the piece's axes AS IT LIES - a quarter turn about X makes a Height a
   Length, and the tail is right to follow. */
function holdsTurned(name, soup, r0) {
  const strip = s => String(s || '').replace(/\balong [XYZ]\b/g, 'along _').replace(/\bon its [+-][XYZ] side\b|\bat the (top|bottom)\b/g, 'on a side');
  for (const [tn, f] of Object.entries(TURNS)) {
    const r = NSO_sectionRead(turn(soup, f));
    const same = r.shape === r0.shape && r.hollow === r0.hollow && r.gate === r0.gate && strip(r.why) === strip(r0.why) &&
      (r0.lengthMm == null ? r.lengthMm == null : r.lengthMm === r0.lengthMm) &&
      JSON.stringify(nums(r)) === JSON.stringify(nums(r0));
    check(name + ' turned ' + tn + ' reads the same', same,
      same ? '' : 'got ' + r.shape + ' / ' + r.reason + ' ' + JSON.stringify(nums(r)) + ' vs ' + JSON.stringify(nums(r0)));
  }
}
function nums(r) {
  const o = r.outer || {}, b = r.bore || {};
  return [o.diameterMm, o.widthMm, o.depthMm, b.diameterMm, b.widthMm, b.depthMm, r.wallMm].map(x => x == null ? null : +x.toFixed(9));
}

(async () => {
  console.log('\n=== 1. Stock: all eight shapes, against nso_stock.js\'s own sizing ===');
  const stock = {};
  for (const sh of S.SHAPES) {
    const made = S.make({ shape: sh, height: 40 });
    if (!made.ok) { check('stock ' + sh + ' generates', false, made.reason); continue; }
    stock[sh] = made;
  }
  {
    const m = stock.cylinder.sizing.measure, r = NSO_sectionRead(stock.cylinder.soup);
    check('cylinder -> round solid', r.shape === 'round' && !r.hollow, r.reason);
    check('  Ø outer = 2 x the generator\'s radius', near(r.outer.diameterMm, 2 * m.radius, TOL), r.outer.diameterMm + ' vs ' + 2 * m.radius);
    check('  length = the generator\'s height, along Z', r.axis === 'Z' && near(r.lengthMm, m.height, TOL), r.lengthMm + ' vs ' + m.height);
    row('Stock cylinder', r, 'Ø' + (2 * m.radius).toFixed(3) + ', L ' + m.height.toFixed(3));
    holdsTurned('cylinder', stock.cylinder.soup, r);
  }
  {
    const m = stock.tube.sizing.measure, r = NSO_sectionRead(stock.tube.soup);
    check('tube -> round hollow', r.shape === 'round' && r.hollow, r.reason);
    check('  Ø outer = 2 x radius', near(r.outer.diameterMm, 2 * m.radius, TOL), r.outer.diameterMm + ' vs ' + 2 * m.radius);
    check('  Ø bore = 2 x inner_radius', near(r.bore.diameterMm, 2 * m.inner_radius, TOL), r.bore.diameterMm + ' vs ' + 2 * m.inner_radius);
    check('  wall = the generator\'s tube_wall', near(r.wallMm, m.tube_wall, TOL), r.wallMm + ' vs ' + m.tube_wall);
    check('  length = height', near(r.lengthMm, m.height, TOL), r.lengthMm + ' vs ' + m.height);
    check('  bore concentric', r.bore.eccentricityMm < 1e-4, r.bore.eccentricityMm.toExponential(2) + ' mm');
    row('Stock tube', r, 'Ø' + (2 * m.radius).toFixed(3) + ' / Ø' + (2 * m.inner_radius).toFixed(3) + ', wall ' + m.tube_wall.toFixed(3) + ', L ' + m.height.toFixed(3));
    holdsTurned('tube', stock.tube.soup, r);
  }
  {
    const m = stock.box.sizing.measure, r = NSO_sectionRead(stock.box.soup);
    check('box -> rectangular solid', r.shape === 'rectangular' && !r.hollow, r.reason);
    check('  the default box is a cube - Extend calls it ambiguous, the reader takes it',
      r.axisTied && r.axisTied.length === 3, 'tied ' + (r.axisTied || []).join(','));
    check('  W x D x L = the generator\'s x, y, z', near(r.outer.widthMm, m.x, TOL) && near(r.outer.depthMm, m.y, TOL) && near(r.lengthMm, m.z, TOL),
      r.outer.widthMm + ' x ' + r.outer.depthMm + ' x ' + r.lengthMm + ' vs ' + m.x + ' cube');
    row('Stock box', r, m.x.toFixed(3) + ' cube');
    holdsTurned('box', stock.box.soup, r);

    const b2 = S.make({ shape: 'box', height: 40, proportions: { x: 2, y: 1, z: 0.5 } });
    const m2 = b2.sizing.measure, r2 = NSO_sectionRead(b2.soup);
    check('box 2:1:0.5 -> rectangular solid along X, W >= D', r2.shape === 'rectangular' && r2.axis === 'X' &&
      near(r2.outer.widthMm, m2.y, TOL) && near(r2.outer.depthMm, m2.z, TOL) && near(r2.lengthMm, m2.x, TOL),
      r2.outer.widthMm.toFixed(4) + ' x ' + r2.outer.depthMm.toFixed(4) + ' x ' + r2.lengthMm.toFixed(4) +
      ' vs ' + m2.y.toFixed(4) + ' x ' + m2.z.toFixed(4) + ' x ' + m2.x.toFixed(4));
    row('Stock box 2:1:0.5', r2, m2.y.toFixed(3) + ' x ' + m2.z.toFixed(3) + ' x ' + m2.x.toFixed(3));
    holdsTurned('box 2:1:0.5', b2.soup, r2);
  }
  const others = {
    sphere: /^it is curved or tapered all over \(100% of its surface\), so only an even offset and whole-piece scaling apply$/,
    cone: /^it is curved or tapered all over \(\d+% of its surface\), so only an even offset and whole-piece scaling apply$/,
    torus: /^it is curved or tapered all over \(100% of its surface\), so only an even offset and whole-piece scaling apply$/,
    // The capsule's barrel is straight along Z, so Height applies there; its
    // domes are why nothing else does.
    capsule: /^only 26\.01 of its 52\.02 mm along Z keeps one section - the ends are shaped, so only height, an even offset and whole-piece scaling apply$/,
    ellipsoid: /^it is curved or tapered all over \(100% of its surface\), so only an even offset and whole-piece scaling apply$/
  };
  for (const [sh, re] of Object.entries(others)) {
    const r = NSO_sectionRead(stock[sh].soup);
    check(sh + ' -> other, with its reason', r.shape === 'other' && re.test(r.reason), r.reason);
    row('Stock ' + sh, r, sh === 'capsule' ? 'barrel ' + stock.capsule.sizing.measure.barrel.toFixed(3) + ' of ' + stock.capsule.sizing.measure.height.toFixed(3) : 'not an extrusion');
    holdsTurned(sh, stock[sh].soup, r);
  }
  {
    // The capsule's reason, held to the generator: its barrel is the constant run.
    const m = stock.capsule.sizing.measure, r = NSO_sectionRead(stock.capsule.soup);
    check('  capsule: the constant run IS the barrel, the length IS the height',
      near(r.run.lengthMm, m.barrel, TOL) && near(r.lengthMm, m.height, TOL),
      'run ' + r.run.lengthMm + ' vs barrel ' + m.barrel);
    check('  capsule: Length still applies (there is a straight axis)', r.axis === 'Z');
    const s = NSO_sectionRead(stock.sphere.soup);
    check('  sphere: no axis, so no Length', s.axis === null && s.lengthMm === null);
  }

  console.log('\n=== 2. nso_features.js\'s hull alone ===');
  {
    const { soup, size } = await hullAlone();
    const r = NSO_sectionRead(soup);
    check('hull -> rectangular solid', r.shape === 'rectangular' && !r.hollow, r.reason);
    check('  along X, the longest of three equally straight axes, as Extend picks it', r.axis === 'X');
    check('  W x D x L = HOST.size ' + size.join(' x ') + ' (section 70 x 40, length 120)',
      r.outer.widthMm === size[1] && r.outer.depthMm === size[2] && r.lengthMm === size[0],
      r.outer.widthMm + ' x ' + r.outer.depthMm + ' x ' + r.lengthMm);
    row('nso_features.js hull', r, size.join(' x '));
    holdsTurned('hull', soup, r);
  }

  console.log('\n=== 3. fixtures ===');
  {
    // lid_strap: a 60 x 40 x 2.4 lid with a 60 x 10 x 0.6 strap along one
    // edge, overlapping y 38..40. The section is a stepped L inside a 48 x 2.4
    // bounding rectangle; its worst point is on the step at y = 40, where the
    // distance to the rectangle, min(z, 2.4 - z, 48 - 40), peaks at z = 1.2.
    const s = readSTL(path.join(ROOT, 'fixtures', 'lid_strap.stl'));
    const r = NSO_sectionRead(s);
    check('lid_strap -> other', r.shape === 'other', r.reason);
    check('  because its section is an L (the step), 1.2 mm off rectangular (half the 2.4 lid)',
      /^its section along X is an L-shape, not a plain rectangle, so length, width, height, an even offset and whole-piece scaling apply$/.test(r.reason) &&
      near(r.fit.outer.rect.devMm, 1.2, 1e-5), r.reason + '  dev ' + r.fit.outer.rect.devMm);
    check('  length 60 along X', r.axis === 'X' && r.lengthMm === 60);
    row('fixtures/lid_strap.stl', r, '60 x 48 x 2.4, step 1.2');
    holdsTurned('lid_strap', s, r);
  }
  {
    const s = readSTL(path.join(ROOT, 'library', 'v9_mirror_factory.stl'));
    const r = NSO_sectionRead(s);
    check('clamp bar -> other', r.shape === 'other', r.reason);
    check('  named: straight along X, but no constant section anywhere',
      r.axis === 'X' && /^its section changes all along X - no stretch of it is the same shape, so only an even offset and whole-piece scaling apply$/.test(r.reason) &&
      /none clean/.test(r.detail), r.reason + '  [' + r.detail + ']');
    row('clamp bar (library/v9_mirror_factory.stl)', r, '187 x 34 x 20.9, keyholes + flange');
    holdsTurned('clamp bar', s, r);
  }
  {
    // MINI_TPU_TEST.stl (Library -> Test Fixtures). It lives in
    // nolongerzzz/nest-library, not here: read from the checkout
    // nso_library_dir.js resolves, and SKIPped out loud without one, as the
    // feature fixtures' catalog checks are. Published: Ø20 / Ø18, wall 1,
    // length 8. A 48-gon, and not a perfect one: its outer vertices sit at r
    // 9.9995 - 10.0006 and its bore vertices at r 9.0020 - 9.0030, so by its
    // own vertices the bore is Ø18.005 and the wall 0.998. Held to the
    // published figures within 0.01 mm; the readout's one decimal is exact.
    const file = LIBDIR.libraryDir() && LIBDIR.catalogFile('MINI_TPU_TEST.stl');
    if (!file) LIBDIR.skip('MINI_TPU_TEST.stl reads as the published ring (nest-library)');
    else {
    const s = readSTL(file);
    const r = NSO_sectionRead(s);
    check('MINI_TPU_TEST -> round hollow, the published Ø20 / Ø18, wall 1, length 8',
      r.shape === 'round' && r.hollow && r.axis === 'Z' && near(r.outer.diameterMm, 20, 1e-3) &&
      near(r.bore.diameterMm, 18, 0.01) && near(r.wallMm, 1, 0.01) && r.lengthMm === 8,
      r.outer.diameterMm.toFixed(6) + ' / ' + r.bore.diameterMm.toFixed(6) + ', wall ' + r.wallMm.toFixed(6));
    check('  readout: Ring Ø20.0 outer · Ø18.0 bore · wall 1.0 · length 8.0',
      NSO_sectionReadout(r) === 'Ring Ø20.0 outer · Ø18.0 bore · wall 1.0 · length 8.0', NSO_sectionReadout(r));
    row('nest-library/MINI_TPU_TEST.stl', r, 'Ø20 / Ø18 published (vertices Ø20.000 / Ø18.005), wall 1, L 8');
    holdsTurned('MINI_TPU_TEST', s, r);
    }
  }
  {
    // prism_r10h30_s8: an octagon of circumradius 10. Off round by its
    // sagitta, 10 (1 - cos 22.5 deg) = 0.761 mm, against a 0.1 mm tolerance.
    const s = readSTL(path.join(ROOT, 'fixtures', 'prism_r10h30_s8.stl'));
    const r = NSO_sectionRead(s);
    const sag = 10 * (1 - Math.cos(Math.PI / 8));
    check('8-gon prism -> other, 0.8 mm off round', r.shape === 'other' && /^its section along Z is a 8-sided polygon, not a circle \(0\.76 mm off round\), so only height, an even offset and whole-piece scaling apply$/.test(r.reason) &&
      near(r.fit.outer.circle.devMm, sag, TOL), r.reason + '  (sagitta ' + sag.toFixed(4) + ')');
    row('fixtures/prism_r10h30_s8.stl', r, 'octagon r 10, sagitta ' + sag.toFixed(3));
    holdsTurned('prism', s, r);
  }
  {
    const s = readSTL(path.join(ROOT, 'fixtures', 'cylinder_r10h30_s64.stl'));
    const r = NSO_sectionRead(s);
    check('cylinder_r10h30_s64 -> round solid, Ø20 L30', r.shape === 'round' && !r.hollow &&
      near(r.outer.diameterMm, 20, TOL) && near(r.lengthMm, 30, TOL), NSO_sectionReadout(r));
    row('fixtures/cylinder_r10h30_s64.stl', r, 'Ø20, L 30');
    holdsTurned('cylinder_r10h30_s64', s, r);
  }
  {
    const s = readSTL(path.join(ROOT, 'fixtures', 'pin.stl'));
    const r = NSO_sectionRead(s);
    check('pin.stl -> round solid Ø3 L20 (the 0.1 mm chamfers are 1% of the length)', r.shape === 'round' &&
      near(r.outer.diameterMm, 3, TOL) && near(r.lengthMm, 20, TOL) && near(r.run.lengthMm, 19.8, TOL), NSO_sectionReadout(r));
    row('fixtures/pin.stl', r, 'Ø3, L 20, run 19.8');
    holdsTurned('pin', s, r);
  }
  {
    const s = rectTube(40, 20, 30, 10, 60);
    const r = NSO_sectionRead(s);
    check('rectangular tube 40 x 20, bore 30 x 10 -> rectangular hollow', r.shape === 'rectangular' && r.hollow &&
      r.outer.widthMm === 40 && r.outer.depthMm === 20 && r.bore.widthMm === 30 && r.bore.depthMm === 10 &&
      r.wallMm === 5 && r.lengthMm === 60, NSO_sectionReadout(r));
    row('rectangular tube (built here)', r, '40 x 20, bore 30 x 10, wall 5, L 60');
    holdsTurned('rectangular tube', s, r);
  }

  console.log('\n=== 4. readout wording ===');
  {
    const t = NSO_sectionReadout(NSO_sectionRead(rectTube(40, 20, 30, 10, 60)));
    check('a bar reads L x W x H, the card\'s own names', t === 'Bar 40.0 L × 20.0 W × 60.0 H · bore 30.0 × 10.0 · wall 5.0', t);
    const tb = NSO_sectionReadout(NSO_sectionRead(stock.tube.soup));
    check('a ring reads Ø outer, Ø bore, wall, length', /^Ring Ø\d+\.\d\d? outer · Ø\d+\.\d\d? bore · wall \d+\.\d\d? · length \d+\.\d\d?$/.test(tb), tb);
    const sp = NSO_sectionReadout(NSO_sectionRead(stock.sphere.soup));
    check('other reads the three sizes and the reason on one line', /^35\.3 L × 35\.3 W × 35\.3 H · it is curved or tapered all over/.test(sp), sp);
  }

  console.log('\n=== the classifier\'s table ===');
  console.log('| piece | shape | hollow | axis | reads | truth | reason |');
  console.log('|---|---|---|---|---|---|---|');
  for (const t of TABLE) {
    console.log('| ' + t.name + ' | ' + t.shape + ' | ' + (t.hollow ? 'yes' : 'no') + ' | ' + (t.axis || '-') + ' | ' +
      t.readout.replace(/\|/g, '/') + ' | ' + t.truth + ' | ' + (t.shape === 'other' ? t.reason : '') + ' |');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
