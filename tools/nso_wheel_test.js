#!/usr/bin/env node
// Headless self-test for app-wheel.js (the Pottery Wheel).
//
//   node tools/nso_wheel_test.js        exit 0 = every gate held
//
// Loads the shipped files with vm so the browser files stay free of any node
// idiom, the same way tools/nso_extend_test.js and tools/sculpt_selftest.js do.
// The load order is the one index.html has: nso_thickness.js and
// nso_printer.js as modules, then app-sculpt.js (the commit half and the
// topology helpers), then app-extend.js (rim extension delegates to it), then
// app-wheel.js.
//
// Writes the revolved pieces to tools/wheel-out/ so
// tools/nso_wheel_canonical_check.js can put the CANONICAL checker over them.
//
// Prints real numbers. The interesting ones are the exact agreements: the two
// faces of Pappus's theorem reconciling to 1e-12, and the revolved mesh
// landing on exactly n*sin(2pi/n)/(2pi) of the analytic volume.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'wheel-out');
const { writeSTL } = require('./nso_stl_io.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Error,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer,
  NSO_Thickness: require(path.join(ROOT, 'nso_thickness.js')),
  NSO_Printer: require(path.join(ROOT, 'nso_printer.js'))
};
vm.createContext(ctx);
/* The ball's sizing and the revolve both live in nso_stock.js now - loaded as
   a classic script, the same load order index.html has. See docs/STOCK.md. */
for (const f of ['nso_stock.js', 'app-sculpt.js', 'app-extend.js', 'app-wheel.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const W = ctx;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

fs.mkdirSync(OUT, { recursive: true });

/* Every piece written out also records the numbers the PROFILE says it has,
   so tools/nso_wheel_canonical_check.js can put the canonical checker over
   the STL and compare machine against machine rather than by eye. The budget
   figures go in too: that is how "the live shape can never exceed the
   material budget" gets checked against a mesh volume the checker measured,
   not one this file computed. */
const MANIFEST = [];
const save = (name, piece) => {
  const soup = W.NSO_wheelRevolve(piece);
  writeSTL(path.join(OUT, name + '.stl'), soup, 'NSO pottery wheel ' + name);
  const bud = W.NSO_wheelBudget(piece);
  const s = W.NSO_wheelSpan(piece.outer);
  const wall = W.NSO_wheelWall(piece);
  MANIFEST.push({
    name: name,
    ops: piece.ops.join(' > '),
    segments: piece.segments,
    polygon_factor: piece.segments * Math.sin(2 * Math.PI / piece.segments) / (2 * Math.PI),
    analytic_volume: W.NSO_wheelVolume(piece),
    pappus_volume: W.NSO_wheelPappus(piece).volume,
    budget: { start: bud.start, added: bud.added, trimmed: bud.trimmed, ceiling: bud.ceiling, live: bud.live },
    base_z: s.lo, top_z: s.hi,
    max_radius: piece.outer.reduce((m, x) => Math.max(m, x.r), 0),
    opened: !!piece.inner,
    wall_mm: wall.min_mm, wall_floor_mm: wall.threshold_mm, wall_pass: wall.pass
  });
  return soup;
};

/* Independent of the module under test, on purpose: the signed volume of a
   closed triangle soup by the tetrahedron sum. This is the number the
   canonical checker reports, computed here so the relationship to the
   analytic profile volume can be asserted without shelling out. */
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
const span = p => { const s = W.NSO_wheelSpan(p.outer); return s.hi - s.lo; };
const rMax = p => p.outer.reduce((m, x) => Math.max(m, x.r), 0);

/* =====================================================================
   0. The floor is not this file's to invent
   ===================================================================== */
console.log('== 0. the wall floor comes from nso_thickness.js and nowhere else ==');
{
  check('NSO_wheelFloor matches NSO_Thickness.floorFor at 0.4 mm',
    W.NSO_wheelFloor(0.4) === ctx.NSO_Thickness.floorFor(0.4),
    W.NSO_wheelFloor(0.4) + ' mm');
  check('...and tracks it to another nozzle rather than carrying a literal',
    W.NSO_wheelFloor(0.6) === ctx.NSO_Thickness.floorFor(0.6) && W.NSO_wheelFloor(0.6) !== W.NSO_wheelFloor(0.4),
    W.NSO_wheelFloor(0.6) + ' mm at a 0.6 nozzle');

  /* Load the file in a context with NO thickness module and confirm it
     refuses rather than defaulting - the whole point of the dependency. */
  const bare = {
    Math, Map, Set, console: { log() {}, warn() {}, error() {} },
    Array, Object, Number, String, JSON, isFinite, Error,
    Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
  };
  vm.createContext(bare);
  for (const f of ['app-sculpt.js', 'app-extend.js', 'app-wheel.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), bare, { filename: f });
  }
  let threw = null;
  try { bare.NSO_wheelBall({ height: 60 }); } catch (e) { threw = e.message; }
  check('without nso_thickness.js the wheel refuses to start, loudly',
    threw !== null && /nso_thickness/.test(threw), threw ? threw.slice(0, 64) + '...' : 'did NOT throw');

  /* And the same contract on the OTHER module BALL now leans on. The sizing
     moved to nso_stock.js (docs/STOCK.md); loaded without it the wheel says so
     by name rather than growing a second copy of the Pappus arithmetic - the
     same refusal app-extend.js gets in section 7. The thickness module is
     present here, so the message that comes back can only be the stock one. */
  const noStock = {
    Math, Map, Set, console: { log() {}, warn() {}, error() {} },
    Array, Object, Number, String, JSON, isFinite, Error,
    Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer,
    NSO_Thickness: require(path.join(ROOT, 'nso_thickness.js'))
  };
  vm.createContext(noStock);
  for (const f of ['app-sculpt.js', 'app-extend.js', 'app-wheel.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), noStock, { filename: f });
  }
  let noStockThrew = null;
  try { noStock.NSO_wheelBall({ height: 60 }); } catch (e) { noStockThrew = e.message; }
  check('without nso_stock.js the wheel refuses rather than re-deriving the sizing',
    noStockThrew !== null && /nso_stock\.js is not loaded/.test(noStockThrew),
    noStockThrew ? noStockThrew.slice(0, 72) + '...' : 'did NOT throw');
  check('...and the file carries no second copy of the ball arithmetic',
    !/Math\.cbrt\s*\(/.test(fs.readFileSync(path.join(ROOT, 'app-wheel.js'), 'utf8')));
}

/* =====================================================================
   1. Pappus's centroid theorem, both ways round
   ===================================================================== */
console.log('\n== 1. Pappus sizes the ball, and measures what is on the wheel ==');
{
  const sized = W.NSO_wheelSizeBall({ height: 60 });
  check('a 60 mm target sizes', sized.ok, sized.reason);

  /* The two parts of the shell, each checked against the closed form Pappus
     must reproduce. The wall strip: 2*pi*(R - t/2)*(H*t). The floor disc:
     pi*R^2*t. Different formulas, same theorem. */
  const R = 30, H = 60, t = 3;
  check('wall strip volume = 2*pi*rho*A with rho = R - t/2',
    Math.abs(sized.wall_volume - 2 * Math.PI * (R - t / 2) * (H * t)) < 1e-9,
    sized.wall_volume.toFixed(6) + ' mm^3');
  check('floor volume = pi*R^2*t, which is what Pappus on the floor rectangle gives',
    Math.abs(sized.floor_volume - Math.PI * R * R * t) < 1e-9,
    sized.floor_volume.toFixed(6) + ' mm^3');
  check('ball volume = shell x (1 + waste)',
    Math.abs(sized.ball_volume - sized.shell_volume * 1.30) < 1e-9,
    sized.shell_volume.toFixed(1) + ' x 1.30 = ' + sized.ball_volume.toFixed(1));
  check('ball radius is the sphere of that volume',
    Math.abs(4 / 3 * Math.PI * Math.pow(sized.ball_radius, 3) - sized.ball_volume) < 1e-6,
    'r = ' + sized.ball_radius.toFixed(4) + ' mm');

  /* The waste margin is a real margin, not decoration: without it the potter
     runs out mid-form. Measured here rather than asserted in prose. */
  const noWaste = W.NSO_wheelSizeBall({ height: 60, waste: 0 });
  console.log('   waste margin: ball radius ' + noWaste.ball_radius.toFixed(3) + ' mm at 0% vs ' +
    sized.ball_radius.toFixed(3) + ' mm at 30% - ' +
    (sized.ball_volume - noWaste.ball_volume).toFixed(0) + ' mm^3 of headroom bought');
  check('the 30% margin is real clay, not a rounding',
    sized.ball_volume - noWaste.ball_volume > 0.25 * noWaste.ball_volume);

  /* And the two ways of computing a solid of revolution's volume, on the
     live form, agree - because they are the same identity, not two guesses. */
  const p = W.NSO_wheelBall({ height: 60 }).piece;
  const washer = W.NSO_wheelVolume(p);
  const pap = W.NSO_wheelPappus(p);
  check('pi * contour(r^2 dz) == 2*pi*rho*A on the ball',
    Math.abs(washer - pap.volume) / washer < 1e-12,
    washer.toFixed(9) + ' vs ' + pap.volume.toFixed(9));

  const bowl = W.NSO_wheelOpen(p, {}).piece;
  const w2 = W.NSO_wheelVolume(bowl), p2 = W.NSO_wheelPappus(bowl);
  check('...and on an OPENED form, where the meridian is not convex',
    Math.abs(w2 - p2.volume) / w2 < 1e-12,
    w2.toFixed(9) + ' vs ' + p2.volume.toFixed(9));
  console.log('   opened form: meridian area ' + p2.area.toFixed(3) + ' mm^2, centroid radius ' +
    p2.centroidR.toFixed(3) + ' mm');
}

/* =====================================================================
   2. The ball, and the revolve
   ===================================================================== */
console.log('\n== 2. a smooth centred ball, and the revolve that builds it ==');
let ball;
{
  const r = W.NSO_wheelBall({ height: 60 });
  check('ball throws', r.ok, r.reason);
  ball = r.piece;

  const a = ball.sizing.ball_radius;
  check('it rests on z = 0', Math.abs(W.NSO_wheelSpan(ball.outer).lo) < 1e-12);
  check('it is 2a tall', Math.abs(span(ball) - 2 * a) < 1e-9, span(ball).toFixed(6) + ' mm');
  check('it is centred on the axis - both poles sit at r = 0',
    ball.outer[0].r === 0 && ball.outer[ball.outer.length - 1].r === 0);
  check('its widest point is a, at the equator',
    Math.abs(rMax(ball) - a) < 1e-9, rMax(ball).toFixed(6) + ' mm');

  /* A 96-sided polygon inscribed in the meridian semicircle is a shade under
     the true sphere. The budget is charged the AS-BUILT figure, not the ask,
     so the very first pull cannot be priced off clay that is not there. */
  const trueSphere = 4 / 3 * Math.PI * a * a * a;
  const built = W.NSO_wheelVolume(ball);
  check('the budget starts at the AS-BUILT volume, not the requested one',
    ball.budget.start === built && built < trueSphere,
    built.toFixed(3) + ' built vs ' + trueSphere.toFixed(3) + ' asked (' +
    ((1 - built / trueSphere) * 100).toFixed(3) + '% under)');
  check('and the potter starts with exactly zero headroom used',
    Math.abs(W.NSO_wheelBudget(ball).headroom) < 1e-9);

  /* The revolve's one exact invariant. An n-gon inscribed in a circle has
     cross-sectional area (n/2)r^2 sin(2pi/n) instead of pi r^2, and EVERY
     term of the volume integral is an r^2 term, so the whole mesh volume is
     the analytic volume times that one factor. If the two triangles a quad is
     split into ever stopped tiling the frustum exactly, this is the number
     that would move. */
  const soup = save('ball', ball);
  const n = ball.segments;
  const k = n * Math.sin(2 * Math.PI / n) / (2 * Math.PI);
  const exact = meshVolume(W.NSO_wheelRevolve(ball, { precise: true })) / W.NSO_wheelVolume(ball);
  check('mesh volume / analytic volume == n*sin(2pi/n)/(2pi), EXACTLY',
    Math.abs(exact - k) < 1e-12, exact.toFixed(15) + ' vs ' + k.toFixed(15));
  /* The shipped soup is float32, because rawTris is float32 everywhere in
     this repo. That storage - and nothing about the tessellation - is the
     whole of the residual, which is why the line above is run on the same
     revolve in float64 and lands on the identity to 1e-15. */
  const stored = meshVolume(soup) / W.NSO_wheelVolume(ball);
  check('...and the float32 soup the app actually gets is within a few parts in 1e8 of it',
    Math.abs(stored - k) < 1e-6 && Math.abs(stored - k) > 0,
    'float32 residual ' + Math.abs(stored - k).toExponential(2) +
    ' vs float64 ' + Math.abs(exact - k).toExponential(2));
  check('the revolve emits no degenerate ring at the poles',
    soup.length / 9 === n * (ball.outer.length - 1) * 2 - 2 * n,
    (soup.length / 9) + ' triangles at ' + n + ' segments');
}

/* =====================================================================
   3. Open - and the reason the cavity is not outer(z) - wall
   ===================================================================== */
console.log('\n== 3. Open: one push, and a wall that is actually the wall ==');
let bowl;
{
  const r = W.NSO_wheelOpen(ball, {});
  check('a ball opens', r.ok, r.reason);
  bowl = r.piece;
  check('the piece now has TWO profiles where it had one',
    ball.inner === null && bowl.inner !== null && bowl.inner.length > 2,
    bowl.outer.length + ' outer + ' + bowl.inner.length + ' inner samples');

  const wall = W.NSO_wheelWall(bowl);
  check('the perpendicular wall is the wall that was asked for',
    Math.abs(wall.wall_mm - bowl.wall) < 1e-6,
    wall.wall_mm.toFixed(6) + ' mm asked ' + bowl.wall.toFixed(3));
  check('the base under the cavity clears the nozzle floor',
    wall.floor_mm >= wall.threshold_mm, wall.floor_mm.toFixed(3) + ' mm');
  check('the rim carries a wall too', wall.rim_mm >= wall.threshold_mm, wall.rim_mm.toFixed(3) + ' mm');
  check('and the report passes', wall.pass, wall.reason);

  /* THE FINDING this function exists for. The obvious cavity - subtract the
     wall from the radius - leaves a perpendicular wall of wall*cos(slope),
     which goes to nothing exactly where a thrown pot is weakest. Measured on
     the same piece rather than argued. */
  const naive = {
    outer: bowl.outer, nozzle: bowl.nozzle, wall: bowl.wall, segments: bowl.segments,
    budget: { start: bowl.budget.start, added: 0, trimmed: 0 }, ops: [],
    inner: bowl.inner.map(s => ({
      z: s.z, r: Math.max(0, W.NSO_wheelRadiusAt(bowl.outer, s.z) - bowl.wall)
    }))
  };
  naive.inner[0].r = 0;
  const naiveWall = W.NSO_wheelWall(naive);
  console.log('   radial subtraction inner(z) = outer(z) - ' + bowl.wall.toFixed(1) +
    ': thinnest ' + naiveWall.min_mm.toFixed(3) + ' mm (' +
    ((1 - naiveWall.min_mm / bowl.wall) * 100).toFixed(1) + '% under the ask) at z = ' +
    naiveWall.at.z.toFixed(2) + ' mm');
  check('the radial shortcut really is thinner than the bisected cavity - by a lot',
    naiveWall.min_mm < 0.75 * wall.wall_mm,
    naiveWall.min_mm.toFixed(3) + ' vs ' + wall.wall_mm.toFixed(3) + ' mm');

  /* Cross-check against the canonical 2D probe. NSO_Thickness.measureLoop
     walks a closed section; the meridian IS one, so the module that owns the
     floor can be asked for a second opinion on the wall as well. Its skip
     functions are told which loop indices are the outside and which are the
     inside, because its default "ignore your two neighbours" window is meant
     for a cut cross-section and on a 96-sample profile it would answer with
     the SAMPLE SPACING instead of the wall. */
  const no = bowl.outer.length;
  const sameSide = (j, i) => ((j < no) === (i < no));
  const loop = W.NSO_wheelMeridian(bowl).map(s => [s.r, s.z]);
  const canon = ctx.NSO_Thickness.measureLoop(loop, {
    nozzle: bowl.nozzle, skipSeg: sameSide, skipPt: sameSide
  });
  console.log('   canonical 2D probe over the same meridian: ' + ctx.NSO_Thickness.describe(canon));
  check('the canonical probe agrees the piece passes', canon.pass, canon.reason);

  /* Point by point, the probe's two passes against the exact measure. The
     NEAREST pass reconciles; the RAY pass does not, and the reason is worth
     writing down because it is why the live gate here uses its own scan and
     not measureLoop. loopWallAt accepts a ray hit at u in [-0.05, 1.05] - a
     5% overshoot past the end of the target segment, which is the right slop
     on a cut cross-section whose segments are all a similar length. A
     meridian's cavity-floor segments are millimetres long next to a wall that
     is tens, so 5% of a short segment is a long way, and the ray is admitted
     against a segment it actually misses. */
  let worstNear = 0, worstRay = 0, rayAt = null, worstGrid = 0;
  const pointToPoint = (i) => {
    const other = i < no ? bowl.inner : bowl.outer;
    let best = Infinity;
    for (let k = 0; k < other.length; k++) {
      best = Math.min(best, Math.hypot(other[k].r - loop[i][0], other[k].z - loop[i][1]));
    }
    return best;
  };
  for (let i = 0; i < loop.length; i++) {
    const w = ctx.NSO_Thickness.loopWallAt(loop, i, { skipSeg: sameSide, skipPt: sameSide });
    if (!w.measured) continue;
    const exact = W.NSO_wheelDistToProfile(loop[i][0], loop[i][1], i < no ? bowl.inner : bowl.outer);
    if (w.byNearest !== null) {
      worstNear = Math.max(worstNear, Math.abs(w.byNearest - pointToPoint(i)));
      worstGrid = Math.max(worstGrid, w.byNearest - exact);
    }
    if (w.byRay !== null && exact - w.byRay > worstRay) { worstRay = exact - w.byRay; rayAt = i; }
  }
  check('the probe\'s NEAREST pass measures against the OTHER wall, as the skip functions told it to',
    worstNear < 1e-9, 'worst disagreement with the same point-to-point sum ' +
    worstNear.toExponential(2) + ' mm over ' + loop.length + ' points');
  check('...and sits at most half a sample spacing above the exact point-to-segment wall',
    worstGrid >= 0 && worstGrid < 0.7,
    'point-to-point over-reports by up to ' + worstGrid.toFixed(4) + ' mm, which is the meridian sampling');
  console.log('   the probe\'s RAY pass under-reports by up to ' + worstRay.toFixed(4) +
    ' mm (at loop index ' + rayAt + '), because its u in [-0.05, 1.05] slop admits a hit ' +
    'against a short cavity-floor segment the ray actually misses');
  check('...and that ray shortfall is real and material, which is why the live gate does not use it',
    worstRay > 1.0, worstRay.toFixed(4) + ' mm on a ' + bowl.wall.toFixed(1) + ' mm wall');
  check('...but it still never says PASS on a piece that is actually thin',
    canon.min_mm > canon.threshold_mm,
    canon.min_mm.toFixed(3) + ' mm reported vs a ' + canon.threshold_mm + ' mm floor');

  save('bowl', bowl);

  /* Refusals, each by its own name. */
  const again = W.NSO_wheelOpen(bowl, {});
  check('opening an already-open piece refuses', !again.ok, again.reason);
  const tooWide = W.NSO_wheelOpen(ball, { radius: 500 });
  check('an opening wider than the wall allows refuses, and says how wide it may be',
    !tooWide.ok && /widest this ball will take/.test(tooWide.reason), tooWide.reason);
  const tooThick = W.NSO_wheelOpen(ball, { wall: 400 });
  check('a wall thicker than the ball refuses',
    !tooThick.ok && /no cavity anywhere/.test(tooThick.reason), tooThick.reason);
  const subFloor = W.NSO_wheelOpen(ball, { wall: 0.1 });
  check('a wall under the nozzle floor refuses, naming the floor',
    !subFloor.ok && /nozzle floor/.test(subFloor.reason), subFloor.reason);
  check('every refusal hands back the ORIGINAL piece object, not a copy',
    again.piece === bowl && tooWide.piece === ball && tooThick.piece === ball);
}

/* =====================================================================
   4. Pull - a spline through the drag points, at any height
   ===================================================================== */
console.log('\n== 4. Pull: spline-fitted, compactly supported, at any height ==');
let pulled;
{
  const s = W.NSO_wheelSpan(bowl.outer);
  const lo = s.lo + (s.hi - s.lo) * 0.35, hi = s.hi;
  const pts = [];
  for (let i = 0; i <= 8; i++) {
    const z = lo + (hi - lo) * i / 8;
    pts.push({ z, r: W.NSO_wheelRadiusAt(bowl.outer, z) * 0.85 });
  }
  const r = W.NSO_wheelPull(bowl, { points: pts });
  check('a drag path pulls', r.ok, r.reason);
  pulled = r.piece;

  /* This pull's taper reaches the base (it is a whole-wall drag), so the base
     genuinely narrows - and the profile has to SAY so. NSO_wheelTidy drops the
     samples whose radius clamped to zero, so the piece's stated base is the
     one the revolved solid actually has. Before that was added, the profile
     claimed a base at z = 0 while the mesh started at z = 0.112, and the only
     thing that noticed was the canonical checker's bbox. */
  check('a pull that narrows the base moves the base, and the profile says where to',
    pulled.outer[0].r === 0 && pulled.outer[0].z > bowl.outer[0].z,
    'base z ' + bowl.outer[0].z.toFixed(4) + ' -> ' + pulled.outer[0].z.toFixed(4) + ' mm');
  check('...with exactly one axis point at the base, never a run of them',
    pulled.outer[1].r > 0);
  check('...and the piece did change where the drag was',
    Math.abs(rMax(pulled) - rMax(bowl)) > 0.5,
    rMax(bowl).toFixed(3) + ' -> ' + rMax(pulled).toFixed(3) + ' mm');

  /* A pull at a height that is NOT the rim. Chosen at 45% of the height so a
     "top edge only" implementation could not pass this, and with an explicit
     taper so COMPACT SUPPORT is testable: every sample further than `taper`
     from the drag must come through bit-identical. A Gaussian falloff would
     fail this line by a micron everywhere, which is how a base stops sitting
     flat on the plate after twenty pulls. */
  const zMid = s.lo + (s.hi - s.lo) * 0.45;
  const before = W.NSO_wheelRadiusAt(bowl.outer, zMid);
  const mid = W.NSO_wheelPull(bowl, { z: zMid, dr: 1.5, taper: 3 });
  check('a single pull lands at the height it was asked for', mid.ok, mid.reason);
  check('...moving the belly by what was asked',
    Math.abs(W.NSO_wheelRadiusAt(mid.piece.outer, zMid) - (before + 1.5)) < 0.05,
    before.toFixed(3) + ' -> ' + W.NSO_wheelRadiusAt(mid.piece.outer, zMid).toFixed(3) + ' mm');
  let outside = 0, moved = 0;
  for (let i = 0; i < bowl.outer.length; i++) {
    if (Math.abs(bowl.outer[i].z - zMid) <= 3) continue;
    outside++;
    if (mid.piece.outer[i].r !== bowl.outer[i].r) moved++;
  }
  check('...and leaving every sample outside the taper BIT-identical',
    moved === 0 && outside > 10, outside + ' samples outside the 3 mm taper, ' + moved + ' moved');
  check('...including the rim', W.NSO_wheelRadiusAt(mid.piece.outer, s.hi) === W.NSO_wheelRadiusAt(bowl.outer, s.hi));

  /* THE SPLINE. Two things are asserted: that the fit is smooth (no facets),
     and that it is the MONOTONE cubic rather than a Catmull-Rom - which is
     measured by giving both the same awkward drag and watching Catmull-Rom
     leave the interval. */
  const drag = [{ z: 4, r: 8 }, { z: 6, r: 8 }, { z: 6.5, r: 14 }, { z: 12, r: 14 }];
  const f = W.NSO_wheelPchip(drag);
  let worstOver = 0;
  for (let i = 0; i <= 400; i++) {
    const z = 4 + 8 * i / 400;
    const v = f(z);
    if (v > 14) worstOver = Math.max(worstOver, v - 14);
    if (v < 8) worstOver = Math.max(worstOver, 8 - v);
  }
  check('the drag-point fit never overshoots the points it was given',
    worstOver < 1e-12, 'worst excursion ' + worstOver.toExponential(2) + ' mm');

  /* Uniform Catmull-Rom on the same four points, for the comparison. */
  function crAt(P, z) {
    for (let i = 0; i + 1 < P.length; i++) {
      if (z < P[i].z || z > P[i + 1].z) continue;
      const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
      const t = (z - p1.z) / (p2.z - p1.z), t2 = t * t, t3 = t2 * t;
      return 0.5 * ((2 * p1.r) + (-p0.r + p2.r) * t +
        (2 * p0.r - 5 * p1.r + 4 * p2.r - p3.r) * t2 +
        (-p0.r + 3 * p1.r - 3 * p2.r + p3.r) * t3);
    }
    return null;
  }
  let crOver = 0;
  for (let i = 0; i <= 400; i++) {
    const z = 4 + 8 * i / 400;
    const v = crAt(drag, z);
    if (v === null) continue;
    if (v > 14) crOver = Math.max(crOver, v - 14);
    if (v < 8) crOver = Math.max(crOver, 8 - v);
  }
  console.log('   same drag through a uniform Catmull-Rom: overshoots by ' + crOver.toFixed(4) +
    ' mm - a bulge the potter did not make');
  check('and Catmull-Rom on the same points DOES overshoot, which is why it is not used',
    crOver > 0.1, crOver.toFixed(4) + ' mm');

  /* Not faceted: the revolved form's meridian turns smoothly. Measured as the
     largest angle between consecutive meridian segments in the dragged span,
     against the same measure on the drag polyline the user actually gave. */
  function worstKink(profile, zLo, zHi) {
    let worst = 0;
    for (let i = 1; i + 1 < profile.length; i++) {
      if (profile[i].z < zLo || profile[i].z > zHi) continue;
      const a = profile[i - 1], b = profile[i], c = profile[i + 1];
      const a1 = Math.atan2(b.r - a.r, b.z - a.z), a2 = Math.atan2(c.r - b.r, c.z - b.z);
      let d = Math.abs(a2 - a1);
      if (d > Math.PI) d = 2 * Math.PI - d;
      worst = Math.max(worst, d * 180 / Math.PI);
    }
    return worst;
  }
  const kinkFit = worstKink(pulled.outer, lo, hi);
  const kinkRaw = worstKink(pts, lo, hi);
  console.log('   worst meridian kink in the dragged span: ' + kinkFit.toFixed(2) +
    ' deg fitted vs ' + kinkRaw.toFixed(2) + ' deg through the raw drag points');
  check('the fitted profile is smoother than the drag polyline it came from',
    kinkFit < kinkRaw && kinkFit < 12, kinkFit.toFixed(2) + ' deg');

  save('pulled', pulled);

  const empty = W.NSO_wheelPull(bowl, {});
  check('a pull with no drag path refuses', !empty.ok && empty.piece === bowl, empty.reason);
}

/* =====================================================================
   5. The two constraints, refusing with a next action
   ===================================================================== */
console.log('\n== 5. the material budget and the wall floor, both live ==');
{
  /* BUDGET. A pull that wants more clay than is on the wheel. */
  const s = W.NSO_wheelSpan(bowl.outer);
  const greedy = [];
  for (let i = 0; i <= 8; i++) {
    const z = s.lo + (s.hi - s.lo) * i / 8;
    greedy.push({ z, r: W.NSO_wheelRadiusAt(bowl.outer, z) + 60 });
  }
  const over = W.NSO_wheelPull(bowl, { points: greedy, carryInner: false });
  check('a pull past the ball refuses', !over.ok, over.reason);
  check('...naming how much more clay it wanted',
    /mm\^3 more clay than is on the/.test(over.reason));
  check('...and reading as a NEXT ACTION, not a dead end',
    /out of material: extend the rim or add clay here to continue/.test(over.reason));
  check('...handing back the original piece object unchanged',
    over.piece === bowl && W.NSO_wheelBudget(bowl).headroom > 0);

  /* The budget is a CEILING that the live form can never exceed - asserted
     over the whole worked sequence, not just at the refusal. */
  let p = ball, worstHead = Infinity, steps = 0;
  const seq = [
    ['open', {}],
    ['pull', { z: span(ball) * 0.5, dr: 2, taper: 6 }],
    ['pull', { z: span(ball) * 0.7, dr: 1, taper: 5 }],
    ['trim', { z: 2 }]
  ];
  for (const [move, o] of seq) {
    const r = move === 'open' ? W.NSO_wheelOpen(p, o)
      : move === 'pull' ? W.NSO_wheelPull(p, o)
        : W.NSO_wheelTrim(p, o);
    if (!r.ok) { console.log('   (sequence step ' + move + ' refused: ' + r.reason + ')'); continue; }
    p = r.piece; steps++;
    worstHead = Math.min(worstHead, W.NSO_wheelBudget(p).headroom);
  }
  check('across a whole worked sequence the live volume never exceeds the ceiling',
    steps === seq.length && worstHead >= -1e-6,
    steps + ' moves, worst headroom ' + worstHead.toFixed(4) + ' mm^3');

  /* WALL FLOOR. A pull that would take the wall under the nozzle. */
  const thin = [];
  for (let i = 0; i <= 8; i++) {
    const z = s.lo + (s.hi - s.lo) * (0.5 + 0.5 * i / 8);
    thin.push({ z, r: W.NSO_wheelRadiusAt(bowl.inner, z) + 0.1 });
  }
  const tooThin = W.NSO_wheelPull(bowl, { points: thin, carryInner: false });
  check('a pull that would take the wall under the floor refuses', !tooThin.ok, tooThin.reason);
  check('...naming the measured wall, the height, and the floor',
    /would take the wall to [\d.]+ mm at z = [\d.]+ mm, under the 0\.420 mm nozzle floor/.test(tooThin.reason));
  check('...and reading as a NEXT ACTION',
    /pull less here, or add clay at this height first/.test(tooThin.reason));
  check('...handing back the original piece object', tooThin.piece === bowl);

  /* A solid has no wall, and is not a failed shell. */
  const solid = W.NSO_wheelWall(ball);
  check('an unopened ball passes the wall check with nothing measured',
    solid.pass && solid.min_mm === null, solid.reason);
}

/* =====================================================================
   6. Trim
   ===================================================================== */
console.log('\n== 6. Trim: the clay comes off the wheel, and off the budget ==');
let trimmed;
{
  const before = W.NSO_wheelBudget(pulled);
  const r = W.NSO_wheelTrim(pulled, { z: 2.0 });
  check('a base trim lands', r.ok, r.reason);
  trimmed = r.piece;
  const after = W.NSO_wheelBudget(trimmed);

  check('the live volume drops by exactly what was removed',
    Math.abs((before.live - after.live) - r.removed) < 1e-9,
    r.removed.toFixed(4) + ' mm^3');
  check('the ceiling drops by exactly the same amount',
    Math.abs((before.ceiling - after.ceiling) - r.removed) < 1e-9);
  /* THE INVARIANT: trimmings go in the slops bucket, not back on the wheel,
     so a trim buys the potter no headroom. */
  check('so a trim buys NO extra headroom - trimmings do not go back on the wheel',
    Math.abs(after.headroom - before.headroom) < 1e-6,
    before.headroom.toFixed(6) + ' -> ' + after.headroom.toFixed(6) + ' mm^3');

  check('the base is now flat at the trim height',
    Math.abs(trimmed.outer[0].z - 2.0) < 1e-9 && trimmed.outer[0].r === 0 &&
    Math.abs(trimmed.outer[1].z - 2.0) < 1e-9 && trimmed.outer[1].r > 0,
    'flat from r = 0 to r = ' + trimmed.outer[1].r.toFixed(3) + ' mm');
  check('and the piece is shorter by exactly the clay the trim took off the bottom',
    Math.abs(span(pulled) - span(trimmed) - (2.0 - pulled.outer[0].z)) < 1e-9,
    span(pulled).toFixed(3) + ' -> ' + span(trimmed).toFixed(3) + ' mm, base ' +
    pulled.outer[0].z.toFixed(4) + ' -> 2.0000');

  save('trimmed', trimmed);

  check('trimming below the existing base refuses',
    !W.NSO_wheelTrim(trimmed, { z: 0 }).ok, W.NSO_wheelTrim(trimmed, { z: 0 }).reason);
  const deep = W.NSO_wheelTrim(trimmed, { z: trimmed.inner[0].z });
  check('trimming up into the cavity floor refuses, naming the nozzle floor',
    !deep.ok && /nozzle floor/.test(deep.reason), deep.reason);
  const whole = W.NSO_wheelTrim(trimmed, { z: span(trimmed) + 5 });
  check('trimming the whole piece off the wheel refuses', !whole.ok, whole.reason);
  const nothing = W.NSO_wheelTrim(trimmed, {});
  check('a trim with no instruction refuses', !nothing.ok && nothing.piece === trimmed, nothing.reason);

  /* A foot cut back to a radius the wall can still carry. The legal radius
     is whatever the cavity leaves plus the wall, so it is computed from the
     piece rather than guessed - and the illegal one right below it is the
     more valuable half of this pair. */
  const upTo = trimmed.inner[0].z + 3;
  const legal = W.NSO_wheelRadiusAt(trimmed.inner, upTo) + trimmed.wall + 0.5;
  const foot = W.NSO_wheelTrim(trimmed, { toR: legal, upTo: upTo });
  check('a foot can be cut back as well as levelled', foot.ok, foot.reason);
  if (foot.ok) check('...and that removes material too', foot.removed > 0, foot.removed.toFixed(2) + ' mm^3');
  const bite = W.NSO_wheelTrim(trimmed, { toR: 1.0, upTo: upTo });
  check('a foot cut that would eat into the cavity refuses, naming the wall it would leave',
    !bite.ok && /nozzle floor/.test(bite.reason), bite.reason);
}

/* =====================================================================
   7. Rim extension IS Extend
   ===================================================================== */
console.log('\n== 7. rim extension calls Extend, and does not reimplement it ==');
let tall;
{
  /* Without a straight wall there is no band to insert height into, and the
     refusal has to say what to do about it. */
  const curved = W.NSO_wheelExtendRim(trimmed, { delta: 10 });
  check('a curved rim refuses', !curved.ok, curved.reason);
  check('...telling the potter to pull the wall straight first',
    /Pull the top of the wall straight first/.test(curved.reason));

  /* Pull the upper wall straight - with reshapeWall, because a vertical
     OUTSIDE carried radially leaves a non-vertical inside and Extend needs
     both. That is finding 2 in docs/POTTERY-WHEEL.md. */
  const s = W.NSO_wheelSpan(trimmed.outer);
  const zMid = s.lo + (s.hi - s.lo) * 0.55;
  const rt = W.NSO_wheelRadiusAt(trimmed.outer, zMid);
  const straight = [];
  for (let i = 0; i <= 10; i++) straight.push({ z: zMid + (s.hi - zMid) * i / 10, r: rt });

  const cheap = W.NSO_wheelPull(trimmed, { points: straight });
  const exact = W.NSO_wheelPull(trimmed, { points: straight, reshapeWall: true });
  check('pulling the wall straight lands both ways', cheap.ok && exact.ok);
  const bandCheap = W.NSO_wheelStraightBand(cheap.piece);
  const bandExact = W.NSO_wheelStraightBand(exact.piece);
  console.log('   straight band after a radial carry: ' +
    (bandCheap.ok ? bandCheap.length.toFixed(3) + ' mm' : 'none (' + (bandCheap.found_mm || 0).toFixed(3) + ' mm best)'));
  console.log('   straight band after reshapeWall:     ' +
    (bandExact.ok ? bandExact.length.toFixed(3) + ' mm' : 'none'));
  check('only the reshaping pull leaves a band Extend can use',
    bandExact.ok && !bandCheap.ok);

  /* Count the calls into Extend, so "it delegates" is proved rather than
     asserted. Wrapping the global in the vm context is the only way to see it
     from outside. */
  const realExtend = ctx.NSO_extendRaw;
  let calls = 0, sawAxis = null;
  ctx.NSO_extendRaw = function (soup, o) { calls++; sawAxis = o && o.axis; return realExtend(soup, o); };

  const p0 = exact.piece;
  const v0 = W.NSO_wheelVolume(p0), b0 = W.NSO_wheelBudget(p0);
  const r = W.NSO_wheelExtendRim(p0, { delta: 12 });
  ctx.NSO_extendRaw = realExtend;

  check('the rim extends', r.ok, r.reason);
  check('...by calling NSO_extendRaw exactly once, on Z',
    calls === 1 && sawAxis === 'z', calls + ' call(s), axis ' + sawAxis);
  check('...and carrying Extend\'s own report back',
    r.extend && typeof r.extend.cut === 'number' && r.extend.ok === true,
    'cut at z = ' + (r.extend ? r.extend.cut.toFixed(4) : '?'));

  tall = r.piece;
  const real = r.extend.lengthAfter - r.extend.lengthBefore;
  check('the piece grew by the length EXTEND measured, not the length asked for',
    Math.abs(span(tall) - span(p0) - real) < 1e-6,
    span(p0).toFixed(6) + ' -> ' + span(tall).toFixed(6) + ' mm (delta ' + real.toFixed(6) + ')');
  check('the widest radius is untouched - a rim extension is not a scale',
    Math.abs(rMax(tall) - rMax(p0)) < 1e-9, rMax(p0).toFixed(6) + ' mm');

  /* The bookkeeping: added clay raises the ceiling by exactly what the form
     gained, so an extension is affordable by construction. */
  const b1 = W.NSO_wheelBudget(tall);
  check('the ceiling rose by exactly the volume the form gained',
    Math.abs((b1.ceiling - b0.ceiling) - (W.NSO_wheelVolume(tall) - v0)) < 1e-9,
    '+' + r.added.toFixed(3) + ' mm^3');
  check('...so the headroom the potter had is unchanged',
    Math.abs(b1.headroom - b0.headroom) < 1e-6,
    b0.headroom.toFixed(4) + ' -> ' + b1.headroom.toFixed(4) + ' mm^3');

  /* And the profile bookkeeping reconciles with the mesh Extend returned:
     the same n*sin(2pi/n)/(2pi) factor, or the two have parted company. */
  save('tall', tall);
  const k = tall.segments * Math.sin(2 * Math.PI / tall.segments) / (2 * Math.PI);
  const ratio = meshVolume(W.NSO_wheelRevolve(tall, { precise: true })) / W.NSO_wheelVolume(tall);
  check('the re-revolved mesh still sits on the exact polygon factor after an extension',
    Math.abs(ratio - k) < 1e-12, ratio.toFixed(15) + ' vs ' + k.toFixed(15));

  check('extending by nothing refuses', !W.NSO_wheelExtendRim(tall, { delta: 0 }).ok);
  check('extending by a negative amount refuses', !W.NSO_wheelExtendRim(tall, { delta: -5 }).ok);

  /* Without app-extend.js loaded the move refuses instead of growing its own
     copy of an axis-preserving stretch. */
  const noExt = { Math, Map, Set, console: { log() {}, warn() {}, error() {} },
    Array, Object, Number, String, JSON, isFinite, Error,
    Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer,
    NSO_Thickness: require(path.join(ROOT, 'nso_thickness.js')) };
  vm.createContext(noExt);
  for (const f of ['nso_stock.js', 'app-sculpt.js', 'app-wheel.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), noExt, { filename: f });
  }
  const orphan = noExt.NSO_wheelOpen(noExt.NSO_wheelBall({ height: 60 }).piece, {});
  const noRim = noExt.NSO_wheelExtendRim(orphan.piece, { delta: 5 });
  check('without app-extend.js the rim move refuses rather than reimplementing it',
    !noRim.ok && /app-extend\.js is not loaded/.test(noRim.reason), noRim.reason);
}

/* =====================================================================
   8. Out of scope, refused by name
   ===================================================================== */
console.log('\n== 8. what this first version does not do, and says so ==');
{
  const src = fs.readFileSync(path.join(ROOT, 'app-wheel.js'), 'utf8');
  check('non-symmetric appendages are named as out of scope in the source',
    /NON-SYMMETRIC APPENDAGES/.test(src));
  check('centring an arbitrary / asymmetric mesh is named as out of scope',
    /CENTRING AN ARBITRARY \/ ASYMMETRIC STARTING MESH/.test(src));
  check('there is no handle, spout or foot-ring generator hiding in here',
    !/function\s+NSO_wheel(Handle|Spout|Lug)/.test(src));
  check('the wheel does not take a mesh in - there is no centring entry point',
    !/NSO_wheelCentre|NSO_wheelCenter|NSO_wheelFromRaw/.test(src));

  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'POTTERY-WHEEL.md'), 'utf8');
  check('and docs/POTTERY-WHEEL.md names both as deferred future work',
    /handles?, spouts?/i.test(doc) && /asymmetric/i.test(doc));
  check('the doc declares the paint scope', /PAINT SCOPE:\s*WHOLE[- ]PIECE/.test(doc));
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(MANIFEST, null, 2));
console.log('\n' + MANIFEST.length + ' piece(s) written to tools/wheel-out/ with manifest.json');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
