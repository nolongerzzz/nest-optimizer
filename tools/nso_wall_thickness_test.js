#!/usr/bin/env node
/* Validation suite for nso_thickness.js - the canonical wall-thickness /
   nozzle-safety check - and for the retrofit of app-cut.js / app-finish.js
   onto it.

   Five parts:
     1. the floor: floorFor() reproduces the 0.42 mm at a 0.4 nozzle that
        nso_skin.js and mesh_validate.py both already quote, and scales.
     2. the 3D probe on REAL geometry, against ground truth from two
        independent directions: analytic slabs whose thickness is known by
        construction, and tools/mesh_validate.py's own wall_thickness() -
        the implementation this module is a port of - run live when python3
        is present. Includes a genuine thin-wall FAILURE (thin_shell_cup_thin,
        a 0.25 mm dent) and a genuine safe-thickness PASS (thin_shell_cup at
        1.2 mm), which is the case the ticket asks for.
     3. regions: measuring a named subset of faces, not the whole mesh.
     4. the 2D probe reproduces app-cut.js's historical fillet-clamp maths
        BIT FOR BIT, including the two different meanings its two variants
        gave the magic `4`.
     5. no regression from the retrofit, proved the strong way: the fillet
        engines are loaded TWICE - once from git HEAD (the inline copies) and
        once from the working tree (delegating to nso_thickness.js) - driven
        on the same geometry, and their output compared float for float.

   Run: node tools/nso_wall_thickness_test.js */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const T = require('../nso_thickness.js');
const { readSTL } = require('./nso_stl_io.js');
const LIB = require('./nso_inside_corners_testlib.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok    ' + name + (detail ? '   (' + detail + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '   (' + detail + ')' : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ============================================================ 1. the floor */
console.log('\n== 1. the floor: one extrusion line, stated not guessed ==');
{
  check('floorFor(0.4) is exactly 0.42 - the figure nso_skin.js quotes for its thinnest rib',
        T.floorFor(0.4) === 0.42, String(T.floorFor(0.4)));
  check('  ...and it is the default mesh_validate.py already gates on',
        T.floorFor(T.NOZZLE_DEFAULT) === 0.42);
  check('floorFor(0.6) = 0.63, floorFor(0.8) = 0.84 - it scales with the nozzle',
        T.floorFor(0.6) === 0.63 && T.floorFor(0.8) === 0.84,
        T.floorFor(0.6) + ', ' + T.floorFor(0.8));
  check('a nonsense nozzle falls back to the 0.4 default rather than inventing a floor',
        T.floorFor(0) === 0.42 && T.floorFor(-1) === 0.42 && T.floorFor(undefined) === 0.42);
  check('an explicit minWall overrides the nozzle floor entirely',
        T.measureLoop([[0,0],[10,0],[10,10],[0,10]], { minWall: 3 }).threshold_mm === 3);
}

/* ================================================ 2. the 3D probe, on truth */
console.log('\n== 2. the 3D probe against ground truth ==');

/* Two facing quads `gap` apart, each wound so its normal points AWAY from the
   gap and its INWARD normal therefore points across the gap at the other. The
   thinnest thing in this mesh IS `gap`, by construction - ground truth that
   owes nothing to the implementation being tested. */
function facingPair(gap, size) {
  size = size || 10;
  const t = [];
  // quad A in plane z = 0, wound so its normal is -z (inward = +z, across the gap)
  t.push(0,0,0,  size,size,0,  size,0,0);
  t.push(0,0,0,  0,size,0,  size,size,0);
  // quad B in plane z = gap, wound so its normal is +z (inward = -z, across)
  t.push(0,0,gap,  size,0,gap,  size,size,gap);
  t.push(0,0,gap,  size,size,gap,  0,size,gap);
  return new Float32Array(t);
}
{
  for (const gap of [0.25, 0.42, 1.2, 3.0]) {
    const r = T.measureMesh(facingPair(gap), { nozzle: 0.4 });
    check('two faces ' + gap + ' mm apart measure ' + gap + ' mm',
          r.min_mm !== null && near(r.min_mm, gap, 1e-5), 'got ' + r.min_mm);
  }
  const thin = T.measureMesh(facingPair(0.25), { nozzle: 0.4 });
  check('0.25 mm apart FAILS the 0.42 floor', thin.pass === false && thin.thin === 4, thin.reason);
  const at = T.measureMesh(facingPair(0.42), { nozzle: 0.4 });
  check('0.42 mm apart PASSES - a wall built AT the floor is not a thin wall', at.pass === true, at.reason);
  const ok = T.measureMesh(facingPair(1.2), { nozzle: 0.4 });
  check('1.2 mm apart passes comfortably', ok.pass === true, ok.reason);
  const big = T.measureMesh(facingPair(1.2), { nozzle: 3.0 });
  check('...and the SAME geometry fails at a 3.0 mm nozzle (floor 3.15) - the floor is the nozzle\'s, not the mesh\'s',
        big.pass === false, big.reason);
  const beyond = T.measureMesh(facingPair(8.0), { nozzle: 0.4, probe: 5.0 });
  check('8 mm apart with a 5 mm probe: 4 sheets, nothing measured, and NOT reported as a pass with a number',
        beyond.sheets === 4 && beyond.min_mm === null && beyond.pass === true, beyond.reason);
  check('  ...the report says so in words rather than inventing a thickness',
        /no wall found within/.test(beyond.reason), beyond.reason);
}

/* The real fixtures - the ticket's genuine fail and genuine pass. */
console.log('\n-- real fixtures --');
const FX = path.join(REPO, 'fixtures', 'open');
const REAL = {
  // name: [min_wall_mm, thin_faces, sheet_faces, faces_measured] from
  // tools/mesh_validate.py --non-solid, the reference implementation.
  'thin_shell_cup':      [1.1974302879018142, 0, 0, 1056],
  'thin_shell_cup_thin': [0.24946452525853083, 96, 0, 1056],
  'open_clip':           [null, 0, 200, 200],
  'fabric_weave':        [1.2026801894320156, 0, 928, 1600],
  // A real 32,862-triangle production mesh, not a synthetic one. It is here
  // because the clean fixtures above CANNOT catch a whole class of bug: they
  // have no near-duplicate vertices, so a grid-snap weld and a true radius
  // weld give identical answers on them. This one has hundreds of vertex
  // pairs inside tolerance, and it is what proved that measuring RAW
  // positions while welding only for adjacency disagrees with the reference
  // (0.163 vs 0.239 mm, 32862 vs 32565 faces measured). Keep it in the suite.
  '../tape_on-edge-single-B101_rounded_v8_FINAL':
                         [0.23944640590160277, 2, 27678, 32565]
};
const got = {};
for (const name of Object.keys(REAL)) {
  const raw = readSTL(path.join(FX, name + '.stl'));
  const r = T.measureMesh(raw, { nozzle: 0.4 });
  got[name] = r;
  const [mm, thin, sheets, measured] = REAL[name];
  const mmOK = (mm === null) ? r.min_mm === null : near(r.min_mm, mm, 1e-9);
  check(path.basename(name) + ': matches mesh_validate.py face for face',
        mmOK && r.thin === thin && r.sheets === sheets && r.measured === measured,
        'min ' + r.min_mm + ' thin ' + r.thin + ' sheets ' + r.sheets + ' measured ' + r.measured);
}
check('GENUINE FAIL: thin_shell_cup_thin - the 0.25 mm dent is caught, 96 faces under the floor',
      got['thin_shell_cup_thin'].pass === false && got['thin_shell_cup_thin'].thin === 96 &&
      got['thin_shell_cup_thin'].min_mm < 0.26, got['thin_shell_cup_thin'].reason);
check('  ...and the report names the offending faces so a caller can show them',
      got['thin_shell_cup_thin'].examples.length === 8 &&
      got['thin_shell_cup_thin'].examples.every(e => typeof e.at === 'number' && e.mm < 0.42));
check('GENUINE PASS: thin_shell_cup - 1.2 mm wall everywhere, no sheets, clean verdict',
      got['thin_shell_cup'].pass === true && got['thin_shell_cup'].sheets === 0 &&
      near(got['thin_shell_cup'].min_mm, 1.2, 0.005), got['thin_shell_cup'].reason);
check('the two cups differ ONLY by the dent, and the checker separates them',
      got['thin_shell_cup'].pass !== got['thin_shell_cup_thin'].pass &&
      got['thin_shell_cup'].measured === got['thin_shell_cup_thin'].measured);
check('open_clip: a single sheet is reported as unmeasured, never as thin',
      got['open_clip'].sheets === got['open_clip'].measured && got['open_clip'].thin === 0);
check('fabric_weave: the crossing clearance is the figure, and it clears the floor',
      got['fabric_weave'].min_mm > 1.15 && got['fabric_weave'].thin === 0);
{
  const tape = got['../tape_on-edge-single-B101_rounded_v8_FINAL'];
  check('a real 32k-triangle mesh with near-duplicate vertices still matches to the last digit',
        tape.min_mm === 0.23944640590160277 && tape.measured === 32565,
        'min ' + tape.min_mm + ', measured ' + tape.measured);
  check('  ...which is the radius weld doing its job - 297 faces collapse to degenerate and are NOT measured',
        tape.measured === 32862 - 297, (32862 - tape.measured) + ' faces dropped by the weld');
  check('  ...and it finds a genuine 0.24 mm thin feature on production geometry',
        tape.pass === false && tape.thin === 2, tape.reason);
}

/* Live cross-check against the Python, when it is available. */
{
  let ran = false;
  try {
    for (const name of Object.keys(REAL)) {
      const out = execFileSync('python3', [path.join(REPO, 'tools', 'mesh_validate.py'),
                                           path.join(FX, name + '.stl'), '--non-solid', '--json',
                                           // only `wall` is read here; the self-intersection
                                           // pass is minutes on the 33k mesh and irrelevant
                                           '--no-selfint'],
                               { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
                                 maxBuffer: 1 << 28 });
      const w = JSON.parse(out).wall;
      ran = true;
      const r = got[name];
      const same = (w.min_wall_mm === null ? r.min_mm === null : near(r.min_mm, w.min_wall_mm, 1e-9)) &&
                   r.thin === w.thin_faces && r.sheets === w.sheet_faces && r.measured === w.faces_measured;
      check('LIVE vs mesh_validate.py - ' + path.basename(name), same,
            'py ' + w.min_wall_mm + ' / js ' + r.min_mm);
    }
  } catch (e) {
    if (!ran) console.log('  --    python3/mesh_validate.py unavailable, using its recorded numbers above');
  }
}

/* ================================================== 3. regions, not just meshes */
console.log('\n== 3. a region: measure one part of a mesh, against the whole of it ==');
{
  const raw = readSTL(path.join(FX, 'thin_shell_cup_thin.stl'));
  const whole = T.measureMesh(raw, { nozzle: 0.4 });
  const thinFaces = whole.examples.map(e => e.at);
  const justThin = T.measureRegion(raw, thinFaces, { nozzle: 0.4 });
  check('a region of known-thin faces measures only them, and fails',
        justThin.measured === thinFaces.length && justThin.pass === false &&
        justThin.thin === thinFaces.length, justThin.reason);
  check('  ...and reports the same thickness for them as the whole-mesh pass did',
        near(justThin.min_mm, Math.min(...whole.examples.map(e => e.mm)), 1e-4),
        justThin.min_mm + ' vs ' + Math.min(...whole.examples.map(e => e.mm)));

  /* The wall behind a selected face is made of faces OUTSIDE the selection,
     so a region must still see the whole mesh as a target. */
  const pair = facingPair(0.25);
  const oneFace = T.measureRegion(pair, [0], { nozzle: 0.4 });
  check('a one-face region still finds the wall behind it (targets are never restricted)',
        oneFace.measured === 1 && near(oneFace.min_mm, 0.25, 1e-6) && oneFace.pass === false,
        oneFace.reason);
  const none = T.measureRegion(pair, [], { nozzle: 0.4 });
  check('an empty region measures the whole mesh rather than silently nothing', none.measured === 4);
  const bogus = T.measureRegion(pair, [99, -3], { nozzle: 0.4 });
  check('out-of-range face indices are dropped, not crashed on', bogus.measured === 0);
}

/* ================ 4. the 2D probe reproduces the historical clamp maths ==== */
console.log('\n== 4. the 2D probe is app-cut.js\'s own maths, bit for bit ==');

/* The ORIGINAL bodies, pulled out of git HEAD rather than retyped, so this
   compares against what actually shipped. */
function headSource(file) {
  return execFileSync('git', ['show', 'HEAD:' + file], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 });
}
{
  let origBand, origCorner, ok = true;
  try {
    const src = headSource('app-cut.js');
    const sandbox = { Math, Infinity, Number, Array };
    vm.createContext(sandbox);
    const grab = (name) => {
      const m = new RegExp('^function\\s+' + name + '\\s*\\(', 'm').exec(src);
      if (!m) throw new Error('no ' + name + ' at HEAD');
      let j = src.indexOf('{', m.index), depth = 0;
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (!depth) { j++; break; } }
      }
      return src.slice(m.index, j);
    };
    vm.runInContext([grab('rawEdgeInwardNormal2'), grab('rawLocalThickness2'),
                     grab('rawCornerWallLimit2')].join('\n\n'), sandbox);
    origBand = sandbox.rawLocalThickness2;
    origCorner = sandbox.rawCornerWallLimit2;
  } catch (e) {
    ok = false;
    console.log('  --    cannot read the pre-retrofit bodies from git HEAD (' + e.message + ')');
  }

  if (ok) {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const loops = [
      [[0,0],[20,0],[20,10],[0,10]],                                  // plain rectangle
      [[0,0],[40,0],[40,0.3],[0,0.3]],                                // 0.3 mm slab
      [[0,0],[30,0],[30,2],[12,2],[12,8],[30,8],[30,10],[0,10]]       // a C, with a real reflex pair
    ];
    for (let k = 0; k < 60; k++) {
      const n = 5 + Math.floor(rnd() * 40), L = [];
      for (let i = 0; i < n; i++) {
        const a = i / n * Math.PI * 2, r = 0.5 + rnd() * 20;
        L.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
      loops.push(L);
    }
    for (let k = 0; k < 20; k++) {
      const n = 12 + Math.floor(rnd() * 90), r = 0.4 + rnd() * 30, L = [];
      for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; L.push([Math.cos(a) * r, Math.sin(a) * r]); }
      loops.push(L);
    }
    let pts = 0, bad = 0, sawFallback = 0, sawCap = 0;
    for (const L of loops) {
      for (let i = 0; i < L.length; i++) {
        pts += 2;
        const b = T.bandWall(L, i), c = T.cornerWall(L, i);
        if (origBand(L, i) !== b.mm) bad++;
        if (origCorner(L, i) !== c.mm) bad++;
        if (!c.measured) sawFallback++;
        if (b.byRay === null && b.mm === 4) sawCap++;
      }
    }
    check('BAND and CORNER reproduce the shipped numbers exactly over ' + pts + ' measurements',
          bad === 0, bad + ' mismatches');
    check('  ...and the corpus actually exercised the `4` cap, so that is proved too, not skipped',
          sawCap > 0, sawCap + ' points where the bisector ray missed and 4 capped the answer');
    check('the CAP is the real behaviour: BAND pins a 22 mm wall to 4 mm when its ray misses',
          T.bandWall([[0,0],[20,0],[20,10],[0,10]], 0).mm === 4 &&
          T.cornerWall([[0,0],[20,0],[20,10],[0,10]], 0).mm > 22,
          'band 4 vs corner ' + T.cornerWall([[0,0],[20,0],[20,10],[0,10]], 0).mm.toFixed(3));
    check('  ...and `measured` now tells the caller a real 4 mm from a guessed one',
          T.bandWall([[0,0],[20,0],[20,10],[0,10]], 0).measured === true &&
          T.loopWallAt([[0,0],[1,0],[1,1]], 0, { fallback: 4 }).measured === false);
  }
}

/* ======================= 5. no regression from the retrofit ================ */
console.log('\n== 5. the retrofitted engines produce identical geometry ==');
console.log('   (engines loaded twice: git HEAD\'s inline copies vs the working tree\'s delegation)');

/* Load a set of engine functions out of an arbitrary source string. Same
   extraction the inside-corners testlib uses, pointed at either revision. */
function loadFrom(cutSrc, finSrc, names) {
  const tmp = path.join(__dirname, 'out', 'wall-thickness');
  fs.mkdirSync(tmp, { recursive: true });
  const cutFile = path.join(tmp, '_cut.js'), finFile = path.join(tmp, '_fin.js');
  fs.writeFileSync(cutFile, cutSrc);
  fs.writeFileSync(finFile, finSrc);
  const cut = LIB.extractFns(cutFile, names.cut);
  const fin = LIB.extractFns(finFile, names.fin);
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math, Number, Array, Float32Array, Uint32Array, Map, Set, JSON, Error,
    Infinity, NaN, isFinite, isNaN, String, Object, Promise,
    FACE_PICK_TOL: 0.35,
    NSO_Thickness: require('../nso_thickness.js'),
    state: { edgeTreat: 'fillet' },
    getEdgeTreat() { return sandbox.state.edgeTreat; },
    nsoMaskFaces() { return [[false, false], [false, false], [false, false]]; }
  };
  vm.createContext(sandbox);
  vm.runInContext(Object.values(cut).join('\n\n') + '\n\n' + Object.values(fin).join('\n\n'),
                  sandbox, { filename: 'engines.js' });
  fs.unlinkSync(cutFile); fs.unlinkSync(finFile);
  return sandbox;
}

{
  const NAMES = {
    cut: ['rawEdgeInwardNormal2', 'rawEarClip2D', 'raw2DWeldLoop', 'rawLocalThickness2',
          'rawCornerWallLimit2', 'rawCornerRadiiOnLoop2'],
    fin: ['rawSolidBox', 'rawBoxSoup', 'rawVertexBallCorners', 'rawVertexBallOnly',
          'rawPerimeterFilletInPlace', 'rawHasPlane', 'rawExtremeOf']
  };
  let before, after, ready = true;
  try {
    before = loadFrom(headSource('app-cut.js'), headSource('app-finish.js'), NAMES);
    after = loadFrom(fs.readFileSync(path.join(REPO, 'app-cut.js'), 'utf8'),
                     fs.readFileSync(path.join(REPO, 'app-finish.js'), 'utf8'), NAMES);
  } catch (e) {
    ready = false;
    console.log('  --    cannot load both revisions (' + e.message + ') - skipping the A/B');
  }

  if (ready) {
    /* Real geometry, several shapes and several radii, so the clamp is
       exercised where it actually bites: a plain box, a long thin slab whose
       wall genuinely limits the radius, and an L. */
    const boxes = [
      ['box 40x30x20', [0, 0, 0], [40, 30, 20]],
      ['thin slab 40x3x20 (the wall clamps R here)', [0, 0, 0], [40, 3, 20]],
      ['tall thin 6x6x40', [0, 0, 0], [6, 6, 40]]
    ];
    let cmp = 0, diffs = 0, worst = 0, ranSomething = 0;
    for (const [label, lo, hi] of boxes) {
      const soup = before.rawBoxSoup(lo, hi);
      for (const R of [0.3, 0.5, 1.0, 2.0, 4.0]) {
        for (const [engine, axis] of [['rawVertexBallCorners', 2], ['rawVertexBallOnly', 2],
                                      ['rawPerimeterFilletInPlace', 2]]) {
          let a = null, b = null, ea = null, eb = null;
          try { a = before[engine](new Float32Array(soup), axis, true, R, {}); }
          catch (e) { ea = e.message; }
          try { b = after[engine](new Float32Array(soup), axis, true, R, {}); }
          catch (e) { eb = e.message; }
          cmp++;
          if (ea || eb) {
            if (ea !== eb) { diffs++; console.log('    DIFF ' + engine + ' R=' + R + ' ' + label + ': "' + ea + '" vs "' + eb + '"'); }
            continue;
          }
          ranSomething++;
          if (a.length !== b.length) {
            diffs++;
            console.log('    DIFF ' + engine + ' R=' + R + ' ' + label + ': ' + a.length + ' vs ' + b.length + ' floats');
            continue;
          }
          for (let i = 0; i < a.length; i++) {
            const d = Math.abs(a[i] - b[i]);
            if (d > worst) worst = d;
            if (a[i] !== b[i]) { diffs++; break; }
          }
        }
      }
    }
    check('every engine/radius/shape combination behaves identically before and after',
          diffs === 0, cmp + ' combinations compared, ' + ranSomething + ' produced geometry, worst delta ' + worst);
    check('  ...and the comparison was not vacuous - real geometry came out of it', ranSomething > 0,
          ranSomething + ' runs produced meshes');
    check('rawCornerRadiiOnLoop2 (the clamp that consumes rawCornerWallLimit2) is unchanged too',
          (() => {
            const L = [[0,0],[40,0],[40,3],[0,3]];
            for (const R of [0.2, 0.5, 1.0, 3.0]) {
              const x = JSON.stringify(before.rawCornerRadiiOnLoop2(L, R, 0.3));
              const y = JSON.stringify(after.rawCornerRadiiOnLoop2(L, R, 0.3));
              if (x !== y) return false;
            }
            return true;
          })());
  }
}

/* ============================== 6. the floor the clamp never had =========== */
console.log('\n== 6. safeRadius: the printability floor the fillet clamp was missing ==');
{
  const wide = T.safeRadius(2.0, 10.0);
  check('a 10 mm wall takes the 0.45 ratio and leaves plenty behind',
        wide.r === 2.0 && wide.floored === false, wide.reason);
  const tight = T.safeRadius(2.0, 0.6);
  check('a 0.6 mm wall: the radius clamps to 0.27 as always, but is now FLAGGED - it leaves 0.33 mm',
        near(tight.r, 0.27, 1e-12) && tight.floored === true && near(tight.residualMM, 0.33, 1e-9),
        tight.reason);
  check('  ...the ratio itself is untouched: r is still min(requested, wall * 0.45)',
        [[2, 0.6], [0.1, 10], [5, 1.0], [3, 0.42]].every(([rq, w]) =>
          T.safeRadius(rq, w).r === Math.min(rq, Math.max(0, w * 0.45))));
  const edge = T.safeRadius(10, 0.7636363636363637);
  check('the floor bites exactly where the arithmetic says it should (wall * 0.55 = 0.42)',
        edge.floored === false && near(edge.residualMM, 0.42, 1e-9), edge.reason);
  check('  ...and one hair thinner is flagged', T.safeRadius(10, 0.76).floored === true);
  const unk = T.safeRadius(2.0, Infinity);
  check('an unmeasured wall does not silently produce a radius',
        unk.measured === false && unk.r === 0, unk.reason);
  check('the floor follows the nozzle, not a constant',
        T.safeRadius(10, 2.0, { nozzle: 0.4 }).floored === false &&
        T.safeRadius(10, 2.0, { nozzle: 2.0 }).floored === true);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
