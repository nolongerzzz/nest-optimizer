#!/usr/bin/env node
// Headless self-test for nso_printer.js and the live build-volume warning.
//
//   node tools/nso_printer_fit_test.js      exit 0 = every gate held
//
// Two halves:
//
//   Sections 1-4 are the profile table and the fit arithmetic on its own -
//   the boundary, the axis convention, the 90 degree turn, the custom plate.
//
//   Section 5 is the REAL CASE the feature exists for: a vessel actually
//   thrown on the Pottery Wheel, which grows past an A1 Mini's build height
//   while it is being thrown, and the warning firing on the right axis with
//   the right numbers at the right moment. Nothing in it is a hand-made
//   bounding box; every number comes off a piece the wheel produced and the
//   CANONICAL checker measured.
//
// Scope, restated because it is the easiest thing to get wrong here: this
// checks whether a box fits a machine. It is not a printability check. A
// piece that fits and cannot be printed passes every line below, on purpose.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'wheel-out');
const P = require(path.join(ROOT, 'nso_printer.js'));
const { writeSTL } = require('./nso_stl_io.js');

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

/* =====================================================================
   1. The profile table
   ===================================================================== */
console.log('== 1. one profile per printer, keyed to the plates the app already has ==');
{
  const appCore = fs.readFileSync(path.join(ROOT, 'app-core.js'), 'utf8');
  const block = appCore.slice(appCore.indexOf('const PLATES'), appCore.indexOf('// ===================== State'));
  const plateIds = [];
  const re = /^\s{2}(\w+):\s*\{/gm;
  let m;
  while ((m = re.exec(block))) plateIds.push(m[1]);
  check('app-core.js still declares plates to key against', plateIds.length >= 4, plateIds.join(', '));
  for (const id of plateIds) {
    check('PLATES.' + id + ' has a printer profile with a build height',
      P.get(id) !== null && P.get(id).buildZ > 0,
      P.get(id) ? (P.get(id).bedX + ' x ' + P.get(id).bedY + ' x ' + P.get(id).buildZ + ' mm') : 'MISSING');
  }
  for (const id of plateIds) {
    if (id === 'custom') continue;
    const w = Number((block.match(new RegExp(id + ':\\s*\\{[^}]*w:\\s*(\\d+)'))  || [])[1]);
    const d = Number((block.match(new RegExp(id + ':\\s*\\{[^}]*d:\\s*(\\d+)')) || [])[1]);
    check('  ...and its bed matches PLATES exactly',
      P.get(id).bedX === w && P.get(id).bedY === d, w + ' x ' + d + ' mm');
  }
  check('a plate id with no profile resolves to something usable rather than throwing',
    P.resolve('no-such-printer', {}).buildZ > 0);
  /* The one id that covers two real machines takes the SHORTER height, so the
     warning fires early on the taller one rather than staying silent on the
     shorter one. */
  check('prusa takes the MK3S height, not the MK4 one, because the id covers both',
    P.get('prusa').buildZ === 210 && /MK3S/.test(P.get('prusa').covers.join(' ')),
    P.get('prusa').covers.join(' / '));
}

/* =====================================================================
   2. The fit arithmetic and its boundary
   ===================================================================== */
console.log('\n== 2. the boundary: exactly as big as the machine fits ==');
{
  const a1mini = P.get('a1mini');
  check('a piece exactly the size of the build volume fits',
    P.fit({ x: 180, y: 180, z: 180 }, a1mini).fits);
  check('a hair over on X does not',
    !P.fit({ x: 180.01, y: 10, z: 10 }, a1mini).fits);
  check('float noise at the boundary is not an overhang',
    P.fit({ x: 180 + 5e-5, y: 10, z: 10 }, a1mini).fits, '180.00005 mm on a 180 mm bed');

  const tall = P.fit({ x: 50, y: 50, z: 250 }, a1mini);
  check('a piece too tall is caught on Z', !tall.fits && tall.over.length === 1 && tall.over[0].axis === 'z');
  check('...with the overhang measured, not just flagged',
    tall.over[0].over_mm === 70 && tall.worst_mm === 70, tall.reason);

  const both = P.fit({ x: 300, y: 200, z: 400 }, a1mini);
  check('several axes over are all reported', both.over.length === 3);
  check('...worst first', both.over[0].axis === 'z' && both.over[0].over_mm === 220,
    both.over.map(o => o.axis + '+' + o.over_mm).join(' '));

  check('describe() says which machine and by how much',
    /TOO BIG for Bambu A1 Mini/.test(P.describe(tall)) && /70 mm over/.test(P.describe(tall)),
    P.describe(tall));
  check('...and says so plainly when it fits',
    /^Fits Bambu A1 Mini/.test(P.describe(P.fit({ x: 10, y: 10, z: 10 }, a1mini))));

  const margin = P.fit({ x: 178, y: 178, z: 10 }, a1mini, { margin: 2 });
  check('a margin, when asked for, comes off both sides of the bed',
    !margin.fits && margin.over[0].limit_mm === 176, margin.reason);
  check('...and never off the build height, which has no rim',
    P.fit({ x: 10, y: 10, z: 180 }, a1mini, { margin: 2 }).fits);
  check('the default margin is zero - this is a physical-fit question',
    P.fit({ x: 180, y: 180, z: 180 }, a1mini).margin_mm === 0);
}

/* =====================================================================
   3. The axis convention, and the 90 degree turn
   ===================================================================== */
console.log('\n== 3. axes, and the one rotation that is exact ==');
{
  /* Display geometry is Y up. Getting this backwards is the bug the whole
     convention exists to stop, so it is asserted rather than commented. */
  const display = { x: 40, y: 200, z: 60 };   // 200 mm TALL in display space
  const printer = P.fromDisplaySize(display);
  check('a display size converts Y-up to Z-up',
    printer.x === 40 && printer.y === 60 && printer.z === 200,
    JSON.stringify(printer));
  check('...and the tall piece is caught on the build HEIGHT, not the bed',
    P.fit(printer, P.get('a1mini')).over[0].axis === 'z');

  const raw = new Float32Array([0, 0, 0, 10, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 7, 10, 0, 0]);
  check('sizeOfRaw reads a raw soup straight, no conversion',
    JSON.stringify(P.sizeOfRaw(raw)) === JSON.stringify({ x: 10, y: 4, z: 7 }),
    JSON.stringify(P.sizeOfRaw(raw)));

  const bar = P.fit({ x: 240, y: 30, z: 10 }, P.get('prusa'));   // 250 x 210 bed
  check('a bar that fits one way round but not the other is reported as such',
    bar.fits, 'fits as it stands');
  const turned = P.fit({ x: 30, y: 240, z: 10 }, P.get('prusa'));
  check('...and turned 90 deg it does not fit, but is told it would',
    !turned.fits && turned.rotatedFits && /turning it 90 deg about Z would fit/.test(turned.reason),
    turned.reason);
  const hopeless = P.fit({ x: 300, y: 300, z: 10 }, P.get('prusa'));
  check('a piece too big both ways is not offered a rotation',
    !hopeless.fits && !hopeless.rotatedFits);
  /* Named, not silently wrong: a diagonal placement is out of scope. */
  const diagonal = P.fit({ x: 260, y: 20, z: 10 }, P.get('a1'));  // 256 bed
  check('a bar that would only fit on the DIAGONAL is reported as not fitting',
    !diagonal.fits && !diagonal.rotatedFits, diagonal.reason);
  check('...and the module says why that is deliberate',
    /only fits on the diagonal deserves a human/.test(fs.readFileSync(path.join(ROOT, 'nso_printer.js'), 'utf8')));
}

/* =====================================================================
   4. Custom plates, and what the module refuses to guess
   ===================================================================== */
console.log('\n== 4. a custom machine is a profile like any other ==');
{
  const c = P.resolve('custom', { w: 300, d: 300, h: 400 });
  check('the plate card\'s w / d / h fold into the custom profile',
    c.bedX === 300 && c.bedY === 300 && c.buildZ === 400);
  check('...without touching the frozen table',
    P.get('custom').bedX === 180 && P.get('custom').buildZ === 180);
  check('bed axes spell the same thing',
    P.resolve('custom', { bedX: 300, bedY: 300, buildZ: 400 }).bedX === 300);
  check('a missing height falls back to the profile rather than to infinity',
    P.resolve('custom', { w: 300, d: 300 }).buildZ === 180);
  check('a resolve with nothing to change returns the profile itself',
    P.resolve('a1mini', {}) === P.get('a1mini'));

  const nothing = P.fit(null, P.get('a1mini'));
  check('no measurable size is reported as nothing checked, not as a pass',
    !nothing.fits && /nothing checked/.test(nothing.reason), nothing.reason);
  const nan = P.fit({ x: NaN, y: 1, z: 1 }, P.get('a1mini'));
  check('a NaN size is the same', !nan.fits && /nothing checked/.test(nan.reason));

  /* SCOPE. This module must not grow a printability opinion. */
  const src = fs.readFileSync(path.join(ROOT, 'nso_printer.js'), 'utf8');
  check('it is not a printability check, and says so',
    /It is NOT a printability check/.test(src));
  /* Comments may DISCUSS printability - the scope paragraph has to name what
     it excludes. The code must not touch it. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('...and no CODE in it touches bridging, overhangs or wall thickness',
    !/bridg|overhang|nozzle|thick|support|adhes/i.test(code));
  check('...and it depends on no other NSO module at all',
    !/NSO_(?!Printer)/.test(code), 'standalone, so any tool can query it');
}

/* =====================================================================
   5. THE REAL CASE: a thrown vessel that outgrows the machine
   ===================================================================== */
console.log('\n== 5. a real wheel-thrown piece, thrown past an A1 Mini ==');
{
  const ctx = {
    Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Error,
    Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer,
    NSO_Thickness: require(path.join(ROOT, 'nso_thickness.js')),
    NSO_Printer: P
  };
  vm.createContext(ctx);
  /* nso_stock.js first: app-wheel.js's BALL calls it. */
  for (const f of ['nso_stock.js', 'app-sculpt.js', 'app-extend.js', 'app-wheel.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }
  const W = ctx;
  const mini = P.get('a1mini');     // 180 x 180 x 180
  const a1 = P.get('a1');           // 256 x 256 x 256
  const fitOf = piece => W.NSO_wheelFitReport(piece, mini);

  /* A floor vase: 320 mm tall, 110 mm across. A real thing a potter throws,
     and a thing an A1 Mini cannot print. */
  const target = { height: 320, radius: 55, wall: 6 };
  const sized = W.NSO_wheelSizeBall(target);
  check('a 320 mm floor vase sizes off Pappus', sized.ok, sized.reason);

  let p = W.NSO_wheelBall(target).piece;
  const ballFit = fitOf(p);
  console.log('   ball: ' + (2 * sized.ball_radius).toFixed(1) + ' mm across, ' +
    (2 * sized.ball_radius).toFixed(1) + ' mm tall -> ' + P.describe(ballFit));
  check('the BALL for that vase still fits the A1 Mini - the warning is not just "big target"',
    ballFit.fits, 'ball diameter ' + (2 * sized.ball_radius).toFixed(1) + ' mm');

  const open = W.NSO_wheelOpen(p, {});
  check('it opens', open.ok, open.reason);
  p = open.piece;
  check('...and the opened bowl still fits', fitOf(p).fits,
    P.describe(fitOf(p)));

  /* Now throw it up. Pull the wall straight and extend the rim, over and
     over, exactly as a potter raises a tall form in stages - and watch for
     the stage at which it stops fitting. */
  let firstOver = null, stages = 0;
  for (let round = 0; round < 12; round++) {
    const s = W.NSO_wheelSpan(p.outer);
    const zMid = s.lo + (s.hi - s.lo) * 0.45;
    const rt = W.NSO_wheelRadiusAt(p.outer, zMid);
    const straight = [];
    for (let i = 0; i <= 10; i++) straight.push({ z: zMid + (s.hi - zMid) * i / 10, r: rt });
    const up = W.NSO_wheelPull(p, { points: straight, reshapeWall: true });
    if (!up.ok) { console.log('   (raise refused: ' + up.reason + ')'); break; }
    const ext = W.NSO_wheelExtendRim(up.piece, { delta: 30 });
    if (!ext.ok) { console.log('   (rim refused: ' + ext.reason + ')'); break; }
    p = ext.piece;
    stages++;
    const f = fitOf(p);
    const h = W.NSO_wheelSpan(p.outer);
    console.log('   stage ' + stages + ': ' + (h.hi - h.lo).toFixed(1) + ' mm tall, ' +
      (2 * p.outer.reduce((m, x) => Math.max(m, x.r), 0)).toFixed(1) + ' mm across  ->  ' +
      (f.fits ? 'fits' : 'TOO BIG: ' + f.reason));
    if (!f.fits && firstOver === null) firstOver = { stage: stages, report: f, piece: p };
    if (firstOver && stages >= firstOver.stage + 1) break;
  }

  check('raising the form on the wheel actually worked', stages >= 2, stages + ' stages');
  check('and at some stage the piece stopped fitting the A1 Mini', firstOver !== null,
    firstOver ? ('stage ' + firstOver.stage) : 'never fired - the warning would be useless');

  if (firstOver) {
    const f = firstOver.report;
    const piece = firstOver.piece;
    const s = W.NSO_wheelSpan(piece.outer);
    const height = s.hi - s.lo;
    const dia = 2 * piece.outer.reduce((m, x) => Math.max(m, x.r), 0);

    /* THE WARNING'S CONTENT, checked against the piece rather than against
       itself: the right axis, the right measurement, the right overhang. */
    check('it fires on the build HEIGHT - the axis a thrown vessel runs out of first',
      f.over.length === 1 && f.over[0].axis === 'z', f.reason);
    check('...reporting the height the piece actually has',
      Math.abs(f.over[0].size_mm - height) < 1e-3,
      f.over[0].size_mm + ' mm warned vs ' + height.toFixed(3) + ' mm thrown');
    check('...against the machine\'s real build height',
      f.over[0].limit_mm === mini.buildZ, mini.buildZ + ' mm');
    check('...and the overhang is the arithmetic',
      Math.abs(f.over[0].over_mm - (height - mini.buildZ)) < 1e-3,
      f.over[0].over_mm + ' mm over');
    check('a 90 degree turn is NOT offered, because height cannot be rotated away',
      f.rotatedFits === false);

    /* The same piece against a bigger machine: the warning must be about the
       MACHINE, not about the piece being large. */
    const onA1 = W.NSO_wheelFitReport(piece, a1);
    check('the same piece on a 256 mm machine is judged separately',
      onA1.printer === 'a1' && onA1.build_z_mm === 256);
    console.log('   the same piece on an A1 / P1S / X1C: ' + P.describe(onA1));
    if (height <= 256 && dia <= 256) {
      check('...and fits it, so the warning is about the machine and not about size',
        onA1.fits, P.describe(onA1));
    }

    /* A custom machine tall enough takes it - the profile table is the thing
       that decides, not a constant anywhere in the wheel. */
    const big = P.resolve('custom', { w: 400, d: 400, h: 500 });
    check('a custom 400 x 400 x 500 profile takes the same piece',
      W.NSO_wheelFitReport(piece, big).fits);
    const shallow = P.resolve('custom', { w: 400, d: 400, h: 50 });
    check('...and a 50 mm-tall custom machine does not', !W.NSO_wheelFitReport(piece, shallow).fits);

    /* THE CHECK IS LIVE, not an export-time gate. Assert it on the wheel's
       own status line, which is what the user sees on every update, and
       assert that nothing in the wheel defers it to an export path. */
    const line = W.NSO_wheelStatus(piece, 'Rim extended');
    check('the wheel\'s live status line carries the warning',
      /TOO BIG for Bambu A1 Mini/.test(line), line);
    const okLine = W.NSO_wheelStatus(W.NSO_wheelBall(target).piece, 'Ball centred');
    check('...and says nothing when the piece fits', !/TOO BIG/.test(okLine), okLine);
    const wheelSrc = fs.readFileSync(path.join(ROOT, 'app-wheel.js'), 'utf8');
    check('the fit check is not wired to an export path',
      !/export[\s\S]{0,80}NSO_wheelFitReport|NSO_wheelFitReport[\s\S]{0,80}export/i.test(wheelSrc));

    /* And the bounding box the warning is built on is the one the CANONICAL
       checker measures off the revolved solid - not a profile number that
       drifted from the mesh. This is the line that caught the profile / mesh
       disagreement NSO_wheelTidy now prevents. */
    fs.mkdirSync(OUT, { recursive: true });
    const stl = path.join(OUT, 'oversize_vase.stl');
    writeSTL(stl, W.NSO_wheelRevolve(piece), 'NSO pottery wheel oversize vase');
    const v = JSON.parse(execFileSync('python3',
      [path.join(ROOT, 'tools', 'mesh_validate.py'), stl, '--json'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    console.log('   canonical checker on the oversize vase: ' + v.triangles + ' tris, bbox ' +
      v.bbox_size.map(x => x.toFixed(2)).join(' x ') + ' mm, volume ' + v.signed_volume.toFixed(0) + ' mm^3');
    check('the solid the warning describes is watertight',
      v.open_edges === 0 && v.nonmanifold_edges === 0 && v.odd_edges === 0 &&
      v.inconsistent_winding_edges === 0 && v.euler_characteristic === 2 &&
      v.self_intersection.pierce === 0);
    const measured = P.fit({ x: v.bbox_size[0], y: v.bbox_size[1], z: v.bbox_size[2] }, mini);
    check('the CHECKER\'s bounding box gives the same verdict as the live one',
      measured.fits === f.fits && measured.over.length === f.over.length &&
      measured.over[0].axis === f.over[0].axis,
      'checker: ' + measured.reason);
    check('...to within the float32 the STL is stored in',
      Math.abs(measured.over[0].over_mm - f.over[0].over_mm) < 1e-3,
      measured.over[0].over_mm + ' vs ' + f.over[0].over_mm + ' mm over');
  }

  /* The other way a thrown piece outgrows a machine: a wide bowl. Height is
     fine, the bed is not, and this time the 90 degree turn is no help either
     because a solid of revolution is as wide as it is deep. */
  console.log('\n   -- and the wide case --');
  let bowl = W.NSO_wheelBall({ height: 260, radius: 130, wall: 6 }).piece;
  const bo = W.NSO_wheelOpen(bowl, {});
  check('a big ball opens into a bowl', bo.ok, bo.reason);
  if (bo.ok) {
    bowl = bo.piece;
    check('...which still fits the A1 Mini as thrown', W.NSO_wheelFitReport(bowl, mini).fits,
      (2 * bowl.outer.reduce((m, x) => Math.max(m, x.r), 0)).toFixed(1) + ' mm across');
    /* Now open it OUT into a wide low bowl, which is what a potter does with
       the remaining clay - and which is how a round piece runs off the bed. */
    const bs = W.NSO_wheelSpan(bowl.outer);
    const wide = [];
    for (let i = 0; i <= 10; i++) {
      const z = bs.lo + (bs.hi - bs.lo) * (0.25 + 0.75 * i / 10);
      wide.push({ z, r: W.NSO_wheelRadiusAt(bowl.outer, z) + 30 });
    }
    const spread = W.NSO_wheelPull(bowl, { points: wide, reshapeWall: true });
    check('the bowl spreads out on the remaining clay', spread.ok, spread.reason);
    if (spread.ok) bowl = spread.piece;
    console.log('   spread bowl: ' +
      (2 * bowl.outer.reduce((m, x) => Math.max(m, x.r), 0)).toFixed(1) + ' mm across, ' +
      (W.NSO_wheelSpan(bowl.outer).hi - W.NSO_wheelSpan(bowl.outer).lo).toFixed(1) + ' mm tall');
    const f = W.NSO_wheelFitReport(bowl, mini);
    check('it is caught on BOTH bed axes', !f.fits && f.over.some(o => o.axis === 'x') && f.over.some(o => o.axis === 'y'),
      f.reason);
    check('...and turning it 90 deg does not help a solid of revolution',
      f.rotatedFits === false);
    const fx = f.over.find(o => o.axis === 'x');
    check('...with X and Y over by exactly the same amount, because it is round',
      Math.abs(fx.over_mm - f.over.find(o => o.axis === 'y').over_mm) < 1e-9,
      fx.over_mm + ' mm over on each');
    check('the same bowl fits a 256 mm machine',
      W.NSO_wheelFitReport(bowl, a1).fits, P.describe(W.NSO_wheelFitReport(bowl, a1)));
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
