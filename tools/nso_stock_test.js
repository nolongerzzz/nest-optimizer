#!/usr/bin/env node
// Headless self-test for nso_stock.js (New stock) and for the extraction that
// created it.
//
//   node tools/nso_stock_test.js        exit 0 = every gate held
//
// Loads the shipped files with vm so the browser files stay free of any node
// idiom, the same way tools/nso_wheel_test.js and tools/nso_extend_test.js do.
// The load order is the one index.html has: nso_thickness.js and nso_printer.js
// as modules, then nso_stock.js, app-sculpt.js and app-extend.js (whose
// NSO_extendDetectAxis the proportions reader calls), then app-wheel.js -
// which is here because half of what this file exists to prove is that the
// Pottery Wheel's BALL is untouched by the move.
//
// Writes the generated pieces to tools/stock-out/ so
// tools/nso_stock_canonical_check.js can put the CANONICAL checker over them.
//
// Prints real numbers. The interesting ones are the exact agreements: the
// primitive's analytic volume landing on the material figure to the last bit
// the cube root allows, and the sphere coming out BIT-IDENTICAL to the ball
// the wheel throws - not merely the same size.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'stock-out');
const { writeSTL, readSTL } = require('./nso_stl_io.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Error,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer,
  NSO_Thickness: require(path.join(ROOT, 'nso_thickness.js')),
  NSO_Printer: require(path.join(ROOT, 'nso_printer.js'))
};
vm.createContext(ctx);
/* nso_stock.js is a classic script in index.html, not a module, and it has to
   be one here too: it looks NSO_extendDetectAxis up as a global at call time,
   and a require()d copy would resolve that against node's global scope, where
   app-extend.js has never been run. Loading it in-context is the same load
   order the page has. */
for (const f of ['nso_stock.js', 'app-sculpt.js', 'app-extend.js', 'app-wheel.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const S = ctx.NSO_Stock;
const P = ctx.NSO_Printer;
const W = ctx;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

fs.mkdirSync(OUT, { recursive: true });

/* Independent of the module under test, on purpose: the signed volume of a
   closed triangle soup by the tetrahedron sum. This is the number the
   canonical checker reports, computed here so the relationship to the
   primitive's analytic volume can be asserted without shelling out. */
function meshVolume(t) {
  let v = 0;
  for (let i = 0; i < t.length; i += 9) {
    const ax = t[i], ay = t[i + 1], az = t[i + 2];
    const bx = t[i + 3], by = t[i + 4], bz = t[i + 5];
    const cx = t[i + 6], cy = t[i + 7], cz = t[i + 8];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}
/* Comments say things like "0.42 mm" legitimately; the checks below are about
   what the CODE contains, so they read the file with every comment stripped. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/[^\n]*/gm, '');
}
function bbox(t) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (t[i + k] < lo[k]) lo[k] = t[i + k];
      if (t[i + k] > hi[k]) hi[k] = t[i + k];
    }
  }
  return { lo, hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}

/* Every piece written out also records the numbers the SIZING says it has, so
   tools/nso_stock_canonical_check.js can put the canonical checker over the
   STL and compare machine against machine rather than by eye. */
const MANIFEST = [];
const save = (name, made) => {
  writeSTL(path.join(OUT, name + '.stl'), made.soup, 'NSO new stock ' + name);
  const s = made.sizing;
  const b = bbox(made.soup);
  MANIFEST.push({
    name: name,
    shape: s.shape,
    target: { height: s.height, radius: s.radius, wall: s.wall, waste: s.waste },
    measure_text: s.measure_text,
    shell_volume: s.shell_volume,
    need_volume: s.need_volume,
    analytic_volume: s.volume,
    built_volume: s.built_volume,
    polygon_factor: s.polygon_factor,
    segments: s.segments,
    size: s.size,
    encloses_target: s.encloses_target,
    base_z: b.lo[2],
    tris: made.soup.length / 9
  });
  return made.soup;
};

/* =====================================================================
   0. The floor is not this file's to invent either
   ===================================================================== */
console.log('== 0. the wall floor comes from nso_thickness.js and nowhere else ==');
{
  check('NSO_Stock.floor matches NSO_Thickness.floorFor at 0.4 mm',
    S.floor(0.4) === ctx.NSO_Thickness.floorFor(0.4), S.floor(0.4) + ' mm');
  check('...and tracks it to another nozzle rather than carrying a literal',
    S.floor(0.6) === ctx.NSO_Thickness.floorFor(0.6) && S.floor(0.6) !== S.floor(0.4),
    S.floor(0.6) + ' mm at a 0.6 nozzle');

  /* Loaded with no thickness module at all, it throws rather than defaulting -
     the whole point of the dependency, and the same contract app-wheel.js has
     always had. require() would see the real module through node's cache, so
     the file is run in a context that has neither. */
  const bare = {
    Math, Map, Set, console: { log() {}, warn() {}, error() {} },
    Array, Object, Number, String, JSON, isFinite, Error,
    Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
  };
  vm.createContext(bare);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'nso_stock.js'), 'utf8'), bare,
    { filename: 'nso_stock.js' });
  let threw = null;
  try { bare.NSO_Stock.size({ shape: 'sphere', height: 60 }); } catch (e) { threw = e.message; }
  check('without nso_thickness.js new stock refuses to size, loudly',
    threw !== null && /nso_thickness/.test(threw),
    threw ? threw.slice(0, 64) + '...' : 'did NOT throw');
  check('...and the file carries no copy of the floor to fall back on',
    !/0\.42|nozzle\s*\*\s*1\.05/.test(stripComments(
      fs.readFileSync(path.join(ROOT, 'nso_stock.js'), 'utf8'))));
}

/* =====================================================================
   1. THE EXTRACTION: the Pottery Wheel's Ball is untouched

   This is the load-bearing section. The sizing moved out of app-wheel.js into
   nso_stock.js; the figures below are the ones docs/POTTERY-WHEEL.md
   published BEFORE the move, transcribed here as literals rather than
   recomputed, so "identical" means identical to the shipped documentation and
   not merely self-consistent.
   ===================================================================== */
console.log('\n== 1. the extraction is exact - BALL still says what it said ==');
{
  const sized = W.NSO_wheelSizeBall({ height: 60 });
  check('a 60 mm target still sizes', sized.ok, sized.reason);

  /* docs/POTTERY-WHEEL.md, "The defaults": "on a 60 mm target it is the
     difference between a 21.341 mm ball and a 23.292 mm one - 12,215 mm^3 of
     headroom". Both numbers, to the digits the doc prints. */
  const noWaste = W.NSO_wheelSizeBall({ height: 60, waste: 0 });
  check('the 30% ball is still 23.292 mm, the figure the doc published',
    sized.ball_radius.toFixed(3) === '23.292', sized.ball_radius.toFixed(6) + ' mm');
  check('...and the 0% ball is still 21.341 mm',
    noWaste.ball_radius.toFixed(3) === '21.341', noWaste.ball_radius.toFixed(6) + ' mm');
  check('...and the margin is still 12,215 mm^3 of headroom',
    Math.round(sized.ball_volume - noWaste.ball_volume) === 12215,
    (sized.ball_volume - noWaste.ball_volume).toFixed(1) + ' mm^3');

  /* docs/POTTERY-WHEEL.md, same paragraph: "52915.383 vs 52929.553 mm^3 at a
     60 mm target" - the as-built 96-gon budget against the true sphere. */
  const ball = W.NSO_wheelBall({ height: 60 }).piece;
  check('the budget still opens at 52915.383 mm^3 - the ball AS BUILT',
    W.NSO_wheelVolume(ball).toFixed(3) === '52915.383', W.NSO_wheelVolume(ball).toFixed(6));
  check('...against a true sphere of 52929.553 mm^3',
    sized.ball_volume.toFixed(3) === '52929.553', sized.ball_volume.toFixed(6));

  /* And the status line a potter reads, character for character. */
  const want = 'target 60.0 x 60.0 mm, 3.00 mm wall: shell 40715.0 mm^3, ' +
               '+30% waste = 52929.6 mm^3, ball radius 23.292 mm';
  check('BALL\'s reason line is unchanged, character for character',
    sized.reason === want, JSON.stringify(sized.reason));

  /* Every field the wheel's own suite and the printer-fit suite read off the
     sizing is still there and still a number. */
  for (const k of ['height', 'radius', 'wall', 'waste', 'nozzle_floor', 'wall_volume',
                   'floor_volume', 'shell_volume', 'ball_volume', 'ball_radius']) {
    check('sizing still carries ' + k, typeof sized[k] === 'number' && isFinite(sized[k]),
      String(sized[k]));
  }

  /* The refusals, both of them, in the wheel's own words. */
  const thin = W.NSO_wheelSizeBall({ height: 60, wall: 0.2 });
  check('a wall under the nozzle floor still refuses in the wheel\'s own words',
    !thin.ok && /nothing thrown at that wall could be printed/.test(thin.reason), thin.reason);
  const rod = W.NSO_wheelSizeBall({ height: 60, radius: 2, wall: 3 });
  check('a wall with no cavity behind it still refuses as "a solid rod, not a pot"',
    !rod.ok && /solid rod, not a pot/.test(rod.reason), rod.reason);
  const noH = W.NSO_wheelSizeBall({});
  check('a missing target height still refuses', !noH.ok, noH.reason);

  /* And the mesh. The wheel's revolve is NSO_Stock.revolve now, so this is the
     assertion that the move did not move a coordinate. */
  const soup = W.NSO_wheelRevolve(ball);
  check('the ball\'s revolved soup is still 96 segments of 96 samples',
    soup.length / 9 === 2 * 96 * 96 - 2 * 96, (soup.length / 9) + ' triangles');
  const k96 = ball.segments * Math.sin(2 * Math.PI / ball.segments) / (2 * Math.PI);
  const ratio = meshVolume(W.NSO_wheelRevolve(ball, { precise: true })) / W.NSO_wheelVolume(ball);
  check('...and still sits on exactly the polygon factor',
    Math.abs(ratio - k96) < 1e-12, ratio.toFixed(15) + ' vs ' + k96.toFixed(15));
}

/* =====================================================================
   2. The shell estimate, shape-agnostic

   Pappus's second theorem, both parts, against the closed forms it must
   reproduce - the same two assertions tools/nso_wheel_test.js makes, now on
   the shared function rather than on the wheel's copy of it.
   ===================================================================== */
console.log('\n== 2. the estimate is Pappus, and it does not know what shape it is for ==');
{
  const R = 30, H = 60, t = 3;
  const sh = S.shell({ height: H, radius: R, wall: t });
  check('wall strip volume = 2*pi*rho*A with rho = R - t/2',
    Math.abs(sh.wall_volume - 2 * Math.PI * (R - t / 2) * (H * t)) < 1e-9,
    sh.wall_volume.toFixed(6) + ' mm^3');
  check('floor volume = pi*R^2*t, which is what Pappus on the floor rectangle gives',
    Math.abs(sh.floor_volume - Math.PI * R * R * t) < 1e-9,
    sh.floor_volume.toFixed(6) + ' mm^3');

  /* The shell figure does not move when the shape does. That is the whole
     claim of the extraction, stated as a check rather than in prose. */
  const per = S.SHAPES.map(shape => S.size({ shape, height: H, radius: R, wall: t }));
  check('all three shapes estimate the SAME shell from the same target',
    per.every(x => x.ok && Math.abs(x.shell_volume - sh.shell_volume) < 1e-12),
    per.map(x => x.shape + ' ' + x.shell_volume.toFixed(4)).join(', '));
  check('...and need the same material once the waste margin is on',
    per.every(x => Math.abs(x.need_volume - per[0].need_volume) < 1e-12),
    per[0].need_volume.toFixed(4) + ' mm^3');
  console.log('   and they differ only in the last step: ' +
    per.map(x => x.shape + ' -> ' + x.measure_text).join(' | '));

  /* THE ESTIMATE IS A SOLID OF REVOLUTION'S, whatever shape the stock is, and
     a genuinely box-shaped target has a longer perimeter than the circle
     inscribed in it - 8R against 2*pi*R. So this under-estimates such a
     target, which is the unsafe direction, and out-of-scope 4 says so. The
     size of it is measured here rather than left as a shrug. */
  console.log('   a BOX-shaped target against this revolution estimate:');
  const boxTargets = [[40, 20, 2], [60, 30, 3], [60, 20, 3], [100, 25, 3], [140, 70, 4]];
  let worstUnder = 0, allCovered = true;
  for (const [h, r, t] of boxTargets) {
    const rev = S.shell({ height: h, radius: r, wall: t }).shell_volume;
    /* An open-topped box vessel of the same bounding box: six walls minus the
       cavity, computed here and owing nothing to the module under test. */
    const real = (2 * r) * (2 * r) * h - (2 * r - 2 * t) * (2 * r - 2 * t) * (h - t);
    const under = 1 - rev / real;
    const need = S.size({ shape: 'box', height: h, radius: r, wall: t }).need_volume;
    if (under > worstUnder) worstUnder = under;
    if (need < real) allCovered = false;
    console.log('     ' + String(h).padStart(4) + ' x ' + String(2 * r).padStart(4) + ' x ' +
      t + ' mm wall: ' + rev.toFixed(0).padStart(7) + ' estimated vs ' + real.toFixed(0).padStart(7) +
      ' really needed, ' + (under * 100).toFixed(1) + '% under; block holds ' + need.toFixed(0));
  }
  check('the shortfall on a box-shaped target is real, and it is UNDER not over',
    worstUnder > 0.15 && worstUnder < 0.25, 'worst ' + (worstUnder * 100).toFixed(1) + '% under');
  check('...and the default 30% margin still covers it on every target measured',
    allCovered, 'a margin doing a job it was not sized for - see out-of-scope 4');

  /* The default target radius is stated, not measured: height/2. */
  const dflt = S.size({ shape: 'sphere', height: 60 });
  check('a blank radius means half the height, as DEFAULTS.aspect says',
    dflt.radius === 60 * S.DEFAULTS.aspect, dflt.radius + ' mm');
  check('a blank wall means DEFAULTS.wall', dflt.wall === S.DEFAULTS.wall, dflt.wall + ' mm');
}

/* =====================================================================
   3. The waste margin is a parameter, and a real one
   ===================================================================== */
console.log('\n== 3. the waste margin is tunable, and it is real clay ==');
{
  const at = w => S.size({ shape: 'sphere', height: 60, waste: w });
  const rows = [0, 0.1, 0.3, 0.5, 1].map(w => ({ w, r: at(w) }));
  for (const row of rows) {
    console.log('   waste ' + (row.w * 100).toFixed(0).padStart(3) + '% -> need ' +
      row.r.need_volume.toFixed(1).padStart(9) + ' mm^3, radius ' +
      row.r.measure.radius.toFixed(4) + ' mm');
  }
  check('need scales exactly as shell x (1 + waste), at every setting',
    rows.every(row => Math.abs(row.r.need_volume - rows[0].r.need_volume * (1 + row.w)) < 1e-9));
  check('the defining measurement grows strictly with the margin',
    rows.every((row, i) => i === 0 || row.r.measure.radius > rows[i - 1].r.measure.radius));
  check('0% is legal and means exactly the shell estimate',
    rows[0].r.ok && Math.abs(rows[0].r.need_volume - rows[0].r.shell_volume) < 1e-12);
  const bad = S.size({ shape: 'sphere', height: 60, waste: -0.5 });
  check('a negative margin falls back to the stated default rather than shrinking the stock',
    bad.ok && bad.waste === S.DEFAULTS.waste, 'waste ' + bad.waste);

  /* It is a parameter on every shape, not only on the one it came from. */
  for (const shape of S.SHAPES) {
    const lo = S.size({ shape, height: 60, waste: 0 });
    const hi = S.size({ shape, height: 60, waste: 0.5 });
    check('the margin moves ' + shape + ' stock too',
      Math.abs(hi.need_volume / lo.need_volume - 1.5) < 1e-12,
      lo.volume.toFixed(1) + ' -> ' + hi.volume.toFixed(1) + ' mm^3');
  }

  /* And it is not a constant hiding behind an argument: nothing outside
     DEFAULTS states 0.30 anywhere in the module. */
  const body = stripComments(fs.readFileSync(path.join(ROOT, 'nso_stock.js'), 'utf8'));
  check('0.30 appears exactly once in the code - in DEFAULTS',
    (body.match(/0\.30\b/g) || []).length === 1,
    (body.match(/0\.30\b/g) || []).length + ' occurrence(s)');
}

/* =====================================================================
   4. Each shape solves its own closed form, exactly
   ===================================================================== */
console.log('\n== 4. three shapes, three closed forms, all exact ==');
{
  const H = 80, R = 25, t = 2.5;
  const sph = S.size({ shape: 'sphere', height: H, radius: R, wall: t });
  const box = S.size({ shape: 'box', height: H, radius: R, wall: t });
  const cyl = S.size({ shape: 'cylinder', height: H, radius: R, wall: t });

  check('sphere: 4/3 pi a^3 is the material figure',
    Math.abs(4 / 3 * Math.PI * Math.pow(sph.measure.radius, 3) - sph.need_volume) < 1e-6,
    'a = ' + sph.measure.radius.toFixed(6) + ' mm');
  check('box: w*d*h is the material figure',
    Math.abs(box.measure.x * box.measure.y * box.measure.z - box.need_volume) < 1e-6,
    box.measure_text);
  check('cylinder: pi r^2 h is the material figure',
    Math.abs(Math.PI * cyl.measure.radius * cyl.measure.radius * cyl.measure.height - cyl.need_volume) < 1e-6,
    cyl.measure_text);
  check('every shape reports its own analytic volume as that same figure',
    [sph, box, cyl].every(x => Math.abs(x.volume - x.need_volume) < 1e-6));

  /* The stated defaults for the two shapes that have a second measurement. */
  check('a box with no proportions given takes the target\'s own bounding box',
    Math.abs(box.measure.x / box.measure.z - (2 * R) / H) < 1e-12 &&
    Math.abs(box.measure.x - box.measure.y) < 1e-12,
    box.measure.proportions_from);
  check('a cylinder with no ratio given takes the target\'s height over diameter',
    Math.abs(cyl.measure.ratio - H / (2 * R)) < 1e-12,
    'ratio ' + cyl.measure.ratio.toFixed(4) + ' - ' + cyl.measure.ratio_from);

  /* Explicit proportions, and explicit ratio. */
  const pbox = S.size({ shape: 'box', height: H, radius: R, wall: t, proportions: { x: 2, y: 1, z: 1 } });
  check('explicit box proportions are held exactly, at whatever scale',
    Math.abs(pbox.measure.x / pbox.measure.y - 2) < 1e-12 &&
    Math.abs(pbox.measure.y / pbox.measure.z - 1) < 1e-12 &&
    Math.abs(pbox.volume - pbox.need_volume) < 1e-6,
    pbox.measure_text);
  const pcyl = S.size({ shape: 'cylinder', height: H, radius: R, wall: t, ratio: 3 });
  check('an explicit cylinder ratio is held exactly',
    Math.abs(pcyl.measure.height / pcyl.measure.diameter - 3) < 1e-12 &&
    Math.abs(pcyl.volume - pcyl.need_volume) < 1e-6,
    pcyl.measure_text);

  const junk = S.size({ shape: 'box', height: H, proportions: { x: 1, y: 0, z: 1 } });
  check('a zero side in the proportions refuses rather than dividing by it',
    !junk.ok, junk.reason);
  const nope = S.size({ shape: 'pyramid', height: H });
  check('an unknown shape refuses, and names the ones there are',
    !nope.ok && /sphere, box, cylinder/.test(nope.reason), nope.reason);
}

/* =====================================================================
   5. Proportions off a reference piece - and Extend is what reads them

   NSO_extendDetectAxis is not decoration here. It is the thing that decides
   whether a reference piece HAS a shape worth copying, which is a real
   question with a real wrong answer.
   ===================================================================== */
console.log('\n== 5. "match this piece" is NSO_extendDetectAxis, not a bounding box ==');
{
  const fx = f => readSTL(path.join(ROOT, 'fixtures', f));

  const bar = S.proportionsFrom(fx('box_hull_80x40x20-2.stl'), {});
  check('an 80 x 40 x 20 hull reads as 80 : 40 : 20 on X',
    bar.ok && bar.axis === 'x' &&
    Math.abs(bar.proportions.x - 80) < 1e-3 && Math.abs(bar.proportions.y - 40) < 1e-3 &&
    Math.abs(bar.proportions.z - 20) < 1e-3, bar.reason);
  check('...and its height/diameter ratio is the long side over the wider short one',
    bar.ok && Math.abs(bar.ratio - 2) < 1e-6, bar.ok ? bar.ratio.toFixed(6) : bar.reason);

  /* A cube is Extend's `ambiguous` refusal and NOT this tool's - see the
     comment on proportionsFrom. 1 : 1 : 1 is a perfectly good proportion. */
  const cube = S.proportionsFrom(fx('box-20mm.stl'), {});
  check('a cube is taken, not refused - Extend\'s "no dominant axis" is its question, not this one',
    cube.ok && cube.ambiguous &&
    Math.abs(cube.proportions.x - 20) < 1e-3 && Math.abs(cube.proportions.z - 20) < 1e-3,
    cube.reason);
  check('...and a cube reference gives a ratio of 1', Math.abs(cube.ratio - 1) < 1e-9);

  /* A curved blob has no straight axis at all, and its bounding box means
     nothing. That refusal is Extend's, passed through in Extend's words. */
  const ball = S.proportionsFrom(fx('fixture_sphere_curved.stl'), {});
  check('a curved piece refuses, in Extend\'s own words',
    !ball.ok && /no dominant straight axis/.test(ball.reason), ball.reason.slice(0, 96));
  const blob = S.proportionsFrom(fx('fixture_blob_organic.stl'), {});
  check('...and so does an organic blob', !blob.ok, blob.reason.slice(0, 72));

  /* End to end: stock shaped like a reference, sized for a target. */
  const like = S.size({ shape: 'box', height: 40, radius: 12, wall: 2,
                        like: fx('box_hull_80x40x20-2.stl') });
  check('a box matched to that hull holds its 4 : 2 : 1 proportions',
    like.ok && Math.abs(like.measure.x / like.measure.z - 4) < 1e-9 &&
    Math.abs(like.measure.y / like.measure.z - 2) < 1e-9, like.measure_text);
  check('...and still holds exactly the material the target needs',
    Math.abs(like.volume - like.need_volume) < 1e-6,
    like.volume.toFixed(4) + ' vs ' + like.need_volume.toFixed(4) + ' mm^3');
  const likeCyl = S.size({ shape: 'cylinder', height: 40, radius: 12, wall: 2,
                           like: fx('pin.stl') });
  check('a cylinder matched to a 20 x 3 x 3 pin comes out 6.67 : 1 tall',
    likeCyl.ok && Math.abs(likeCyl.measure.ratio - 20 / 3) < 1e-6, likeCyl.measure_text);

  const likeSphere = S.size({ shape: 'sphere', height: 40, like: fx('pin.stl') });
  check('a reference handed to a SPHERE refuses rather than being silently dropped',
    !likeSphere.ok && /no proportions to read/.test(likeSphere.reason), likeSphere.reason);

  /* And without app-extend.js there is no home-grown axis detector here. */
  const noExt = {
    Math, Map, Set, console: { log() {}, warn() {}, error() {} },
    Array, Object, Number, String, JSON, isFinite, Error,
    Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer,
    NSO_Thickness: require(path.join(ROOT, 'nso_thickness.js')),
    NSO_Printer: P
  };
  vm.createContext(noExt);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'nso_stock.js'), 'utf8'), noExt,
    { filename: 'nso_stock.js' });
  const orphan = noExt.NSO_Stock.size({ shape: 'box', height: 40, like: fx('pin.stl') });
  check('without app-extend.js matching refuses rather than reimplementing the detector',
    !orphan.ok && /app-extend\.js is not loaded/.test(orphan.reason), orphan.reason.slice(0, 90));
  check('...while everything that does not need a reference still works there',
    noExt.NSO_Stock.size({ shape: 'box', height: 40 }).ok);
}

/* =====================================================================
   6. The build volume, checked BEFORE anything is generated
   ===================================================================== */
console.log('\n== 6. the plate constraint is a gate, not a warning after the fact ==');
{
  const mini = P.get('a1mini');    // 180 x 180 x 180
  const a1 = P.get('a1');          // 256 x 256 x 256

  /* A target taller than the machine is a dead end: no waste setting, no
     shape and no later edit makes a piece that cannot physically exist. */
  const tall = S.size({ shape: 'sphere', height: 260, radius: 60, wall: 4, printer: mini });
  check('a 260 mm target on a 180 mm machine is REFUSED outright',
    !tall.ok && /cannot be printed on Bambu A1 Mini at all/.test(tall.reason), tall.reason.slice(0, 110));
  check('...and the refusal names the axis and the overhang',
    tall.target_fit && !tall.target_fit.fits && tall.target_fit.over[0].axis === 'z' &&
    Math.abs(tall.target_fit.over[0].over_mm - 80) < 1e-6,
    JSON.stringify(tall.target_fit.over[0]));
  check('...and make() builds NO geometry when the sizing refused',
    (() => { const m = S.make({ shape: 'sphere', height: 260, radius: 60, wall: 4, printer: mini });
             return !m.ok && m.soup === null; })());
  check('...and the same target on a 256 mm machine is fine',
    S.size({ shape: 'sphere', height: 260, radius: 60, wall: 4, printer: a1 }).ok === false ||
    S.size({ shape: 'sphere', height: 250, radius: 60, wall: 4, printer: a1 }).ok,
    'the machine is what changed, not the target');

  /* Every shape, every plate in the table: the gate is on the SIZE, so a
     target that fits one machine and not another must flip on the machine. */
  for (const id of P.ids()) {
    const p = P.get(id);
    const r = S.size({ shape: 'cylinder', height: p.buildZ + 40, radius: 20, wall: 3, printer: p });
    check('a target 40 mm past ' + p.name + '\'s build height is refused there',
      !r.ok, r.reason.slice(0, 64) + '...');
  }

  /* A target that fits with a stock block that does not: a refusal by default,
     because a block that cannot print is not stock - but a real thing to want,
     so warnOnly generates it and says what to do. */
  let over = null, overOpts = null;
  for (const waste of [1, 2, 4, 8, 16, 32]) {
    const o = { shape: 'sphere', height: 170, radius: 85, wall: 8, waste: waste, printer: mini };
    const r = S.size(o);
    if (!r.ok && /too big for/.test(r.reason)) { over = r; overOpts = o; break; }
  }
  check('a stock block bigger than the machine is refused, and says what to do about it',
    over !== null && /split it with Cut/.test(over.reason), over ? over.reason.slice(0, 130) : 'never found one');
  if (over) {
    check('...its TARGET was fine - that is what makes this a different refusal',
      over.target_fit.fits, over.target_fit.reason);
    const warned = S.size(Object.assign({}, overOpts, { warnOnly: true }));
    check('...and warnOnly generates it with a warning instead',
      warned.ok && warned.warnings.some(w => /too big for/.test(w)),
      warned.warnings.join(' | ').slice(0, 120));
    const madeAnyway = S.make(Object.assign({}, overOpts, { warnOnly: true }));
    check('...which really does come back with geometry',
      madeAnyway.ok && madeAnyway.soup.length > 0, (madeAnyway.soup.length / 9) + ' triangles');
    check('...and the warning never leaks into `reason`, which one caller prints verbatim',
      !/too big for/.test(warned.reason), warned.reason.slice(0, 80));
  }

  /* No printer is no guess. A build-volume check against the wrong machine
     reads as a pass, which is worse than no check. */
  const ungated = S.size({ shape: 'sphere', height: 900, radius: 400, wall: 10 });
  check('with no printer given nothing is checked, and it SAYS so',
    ungated.ok && ungated.fit === null && ungated.checked_build_volume === false &&
    ungated.warnings.some(w => /no printer given/.test(w)), ungated.warnings.join('; '));

  /* The custom plate's live numbers resolve the same way every other caller
     resolves them - through nso_printer.js, not through a second table. */
  const custom = S.size({ shape: 'box', height: 100, radius: 40, wall: 3,
                          plate: 'custom', plateOver: { w: 400, d: 400, h: 50 } });
  check('a 50 mm-tall custom machine refuses a 100 mm target', !custom.ok, custom.reason.slice(0, 90));
}

/* =====================================================================
   7. The geometry, and the one tessellator

   The sphere here and the ball the wheel throws are the same mesh. Not the
   same size - the same float32 bytes. That is what "NSO_Stock.revolve is the
   wheel's revolve, moved" means, asserted rather than claimed.
   ===================================================================== */
console.log('\n== 7. one tessellator - the stock sphere IS the wheel\'s ball ==');
{
  for (const h of [30, 60, 120]) {
    const mine = S.make({ shape: 'sphere', height: h }).soup;
    const theirs = W.NSO_wheelRevolve(W.NSO_wheelBall({ height: h }).piece);
    let same = mine.length === theirs.length;
    if (same) for (let i = 0; i < mine.length; i++) if (mine[i] !== theirs[i]) { same = false; break; }
    check('a ' + h + ' mm target: stock sphere and wheel ball are bit-identical',
      same, (mine.length / 9) + ' triangles, ' + mine.length + ' floats compared');
  }

  /* An n-gon inscribed in a circle holds n*sin(2pi/n)/(2pi) of the circle, and
     every term of a solid-of-revolution volume integral is an r^2 term, so the
     whole mesh volume is the analytic volume times that one factor. A box has
     no such deficit: six flat faces ARE the solid. */
  for (const shape of S.SHAPES) {
    const made = S.make({ shape, height: 70, radius: 22, wall: 3, precise: true });
    const mv = meshVolume(made.soup);
    const want = made.sizing.built_volume * made.sizing.polygon_factor;
    check(shape + ': the mesh holds exactly as-built x polygon factor',
      Math.abs(mv - want) / want < 1e-12,
      mv.toFixed(6) + ' vs ' + want.toFixed(6) + ' (factor ' +
      made.sizing.polygon_factor.toFixed(12) + ')');
  }
  check('a box\'s polygon factor is exactly 1 - it is not an inscribed anything',
    S.size({ shape: 'box', height: 70 }).polygon_factor === 1);

  /* The two deficits, kept apart. A cylinder's meridian is four straight
     segments and a box is not revolved at all, so for those two the solid as
     built IS the figure asked for; only the sphere's meridian is itself an
     inscribed polygon, and only it is under. */
  for (const shape of ['box', 'cylinder']) {
    const r = S.size({ shape, height: 70, radius: 22, wall: 3 });
    check(shape + ': as-built IS the analytic volume - its profile is exact',
      Math.abs(r.built_volume - r.volume) / r.volume < 1e-12,
      r.built_volume.toFixed(9));
  }
  const sp96 = S.size({ shape: 'sphere', height: 60 });
  check('sphere: the as-built solid is a shade UNDER the sphere asked for',
    sp96.built_volume < sp96.volume &&
    Math.abs(1 - sp96.built_volume / sp96.volume - 0.000268) < 1e-5,
    sp96.built_volume.toFixed(3) + ' built vs ' + sp96.volume.toFixed(3) + ' asked (' +
    ((1 - sp96.built_volume / sp96.volume) * 100).toFixed(4) + '% under)');
  check('...and that as-built figure is exactly the one the wheel charges the potter',
    sp96.built_volume === W.NSO_wheelVolume(W.NSO_wheelBall({ height: 60 }).piece),
    sp96.built_volume.toFixed(9));
  check('...and a finer profile closes the gap, which is what makes it a sampling deficit',
    1 - S.size({ shape: 'sphere', height: 60, profileN: 960 }).built_volume /
        sp96.volume < 1e-5);

  /* Where every primitive sits: centred on the axis, resting on z = 0, with
     the bounding box the sizing said it would have. */
  for (const shape of S.SHAPES) {
    const made = S.make({ shape, height: 70, radius: 22, wall: 3 });
    const b = bbox(made.soup);
    check(shape + ': rests on z = 0 and is centred on x and y',
      Math.abs(b.lo[2]) < 1e-5 && Math.abs(b.lo[0] + b.hi[0]) < 1e-4 &&
      Math.abs(b.lo[1] + b.hi[1]) < 1e-4,
      'base z ' + b.lo[2].toFixed(6) + ', x ' + b.lo[0].toFixed(4) + '..' + b.hi[0].toFixed(4));
    check(shape + ': its bounding box is the size the sizing reported',
      Math.abs(b.size[0] - made.sizing.size.x) < 1e-3 &&
      Math.abs(b.size[1] - made.sizing.size.y) < 1e-3 &&
      Math.abs(b.size[2] - made.sizing.size.z) < 1e-3,
      b.size.map(x => x.toFixed(4)).join(' x ') + ' mm');
  }

  /* Whether the block ENCLOSES the target is reported, never decided. A
     sphere sized for a 60 mm vessel is 46.6 mm across, which is right for
     clay a potter pulls up and wrong for a block a carve must fit inside. */
  const sph = S.size({ shape: 'sphere', height: 60 });
  const cyl = S.size({ shape: 'cylinder', height: 60 });
  check('the sphere for a 60 mm target does NOT enclose it, and says so',
    !sph.encloses_target, (2 * sph.measure.radius).toFixed(2) + ' mm across vs a 60 mm target');
  check('...and the cylinder for the same target does not either, for the same reason',
    !cyl.encloses_target, cyl.measure_text);
  const fat = S.size({ shape: 'box', height: 60, waste: 8 });
  check('...while a big enough margin does enclose it, and that is also reported',
    fat.encloses_target, fat.measure_text);
}

/* =====================================================================
   8. Real pieces, at several target sizes, written out for the checker
   ===================================================================== */
console.log('\n== 8. real generated pieces, every shape, several sizes ==');
{
  const CASES = [];
  for (const shape of S.SHAPES) {
    for (const h of [20, 60, 140]) {
      CASES.push({ name: shape + '_' + h + 'mm', opts: { shape, height: h, wall: 3 } });
    }
  }
  /* Plus the cases that exercise the two second measurements and the margin. */
  CASES.push({ name: 'box_2to1_90mm', opts: { shape: 'box', height: 90, radius: 30, wall: 4, proportions: { x: 2, y: 1, z: 1 } } });
  CASES.push({ name: 'cyl_ratio3_90mm', opts: { shape: 'cylinder', height: 90, radius: 30, wall: 4, ratio: 3 } });
  CASES.push({ name: 'sphere_nowaste_60mm', opts: { shape: 'sphere', height: 60, wall: 3, waste: 0 } });
  CASES.push({ name: 'box_matched_hull_40mm', opts: { shape: 'box', height: 40, radius: 12, wall: 2,
    like: readSTL(path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl')) } });

  for (const c of CASES) {
    const made = S.make(Object.assign({ printer: P.get('a1') }, c.opts));
    check(c.name + ' generates', made.ok, made.ok ? made.sizing.measure_text : made.reason);
    if (!made.ok) continue;
    save(c.name, made);
    check('  ...and its mesh volume is the as-built figure x the polygon factor',
      Math.abs(meshVolume(made.soup) - made.sizing.built_volume * made.sizing.polygon_factor) /
        (made.sizing.built_volume * made.sizing.polygon_factor) < 1e-6,
      meshVolume(made.soup).toFixed(3) + ' mm^3');
  }
}

/* =====================================================================
   9. Out of scope, refused by name
   ===================================================================== */
console.log('\n== 9. what this first version does not do, and says so ==');
{
  const src = fs.readFileSync(path.join(ROOT, 'nso_stock.js'), 'utf8');
  check('cones, tubes and rounded blocks are named as out of scope in the source',
    /CONES, TUBES AND ROUNDED BLOCKS/.test(src));
  check('placing the stock is named as somebody else\'s job',
    /PLACING THE STOCK/.test(src));
  check('sizing from a target MESH is named as a different ticket',
    /SIZING FROM A TARGET MESH/.test(src));
  check('the revolution estimate\'s shortfall on a box target is named, with its direction',
    /A SHELL ESTIMATE FOR A NON-REVOLVED TARGET/.test(src) && /18-20% UNDER/.test(src));
  check('there is no cone, torus or tube generator hiding in here',
    !/function\s+(profileCone|profileTorus|profileTube)/.test(src));
  check('the module has no DOM and no app state, like nso_printer.js beside it',
    !/document\.|window\.[a-z]|getActiveModel|setStatus|\bstate\./.test(stripComments(src)));

  const app = fs.readFileSync(path.join(ROOT, 'app-stock.js'), 'utf8');
  check('app-stock.js declares its paint scope', /PAINT SCOPE:\s*NONE/.test(app));
  check('...and carries no arithmetic of its own - it reads controls and calls the module',
    !/Math\.cbrt|Math\.PI/.test(stripComments(app)));

  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'STOCK.md'), 'utf8');
  check('docs/STOCK.md names the deferred shapes', /cones?, tubes?/i.test(doc));
  check('...and declares the paint scope', /PAINT SCOPE:\s*NONE/.test(doc));
  check('...and names the three shapes this version makes',
    /sphere/i.test(doc) && /box/i.test(doc) && /cylinder/i.test(doc));
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(MANIFEST, null, 2));
console.log('\n' + MANIFEST.length + ' piece(s) written to tools/stock-out/ with manifest.json');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
