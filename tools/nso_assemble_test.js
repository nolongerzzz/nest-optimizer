#!/usr/bin/env node
// Headless self-test for nso_assemble.js - Attach: two Stock primitives, one
// aimed at the other by straight-line auto-aim, joined by the shipped
// NSO_CSG union into one watertight solid.
//
//   node tools/nso_assemble_test.js      exit 0 = every gate held
//
// Loads the shipped files with vm in index.html's own order, so the browser
// files stay free of any node idiom - the same way tools/nso_support_aim_test.js
// and tools/nso_stock_test.js do. app-finish.js touches `window` at the
// bottom, so the context carries a stub for it; nothing else is altered.
//
// The BOOLEAN is the shipped one too. tools/nso_csg_node.js splices
// app-join.js's own NSO_CSG adapter and NSO_unionSoups into a vm context with
// the vendored kernel, so the solids below went through the same welds and
// the same kernel call the Complete Join button makes. Nothing is retyped.
//
// Writes tools/assemble-out/*.stl for tools/nso_assemble_canonical_check.js,
// which puts tools/mesh_validate.py over every one of them.
//
// FIVE THINGS ARE BEING PROVED, and the second is the one the ticket asked
// for:
//
//   1. THE SMALLEST REAL CASE COMPOSES. Stock body + Stock arm + auto-aim's
//      direction + the shipped union = one solid, 1 part, checker PASS.
//   2. ZERO ENGAGEMENT - what place() gives you on its own - FAILS ON A
//      CURVED BODY, and the failure surfaces out of the kernel as "the two
//      pieces do not touch". Section 2 runs the naive composition on four
//      body faces and records which of them survive it. That table is the
//      finding, and it is measured rather than argued.
//   3. THE SEAT DEPTH IS MEASURED. The rim gap on a curved flank is checked
//      against the closed form for the true cylinder, with the 96-gon's own
//      inscription named as the difference rather than hidden in a tolerance.
//   4. THE CONTRACTS REFUSE BY NAME. No thickness floor, no aim module, a
//      solid modelled around its own centre, a pick that disagrees with the
//      aim, a blocked line - each one is a named refusal, not a guess.
//   5. THE ASSEMBLY IS AN ORDINARY PIECE. Repair no-ops it BY IDENTITY,
//      Extend lengthens it and Fatten grows its cross-section, all with no
//      argument that says "this came out of a boolean".

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'assemble-out');
const { writeSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, isNaN,
  parseFloat, parseInt, Float32Array, Float64Array, Int32Array, Uint32Array,
  Uint8Array, Uint16Array, ArrayBuffer, Error, Infinity, NaN, Date, Promise,
  RegExp, Boolean, Symbol, setTimeout, clearTimeout,
  NSO_Thickness: require(path.join(ROOT, 'nso_thickness.js')),
  NSO_Printer: require(path.join(ROOT, 'nso_printer.js'))
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['nso_stock.js', 'nso_seat_surface.js', 'app-sculpt.js', 'app-finish.js',
                 'app-extend.js', 'app-fatten.js', 'nso_support_aim.js',
                 'nso_assemble.js', 'NSO_Repair.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const S = ctx.NSO_Stock;
const SA = ctx.NSO_SupportAim;
const AS = ctx.NSO_Assemble;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

fs.mkdirSync(OUT, { recursive: true });

function bounds(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (s[i + k] < lo[k]) lo[k] = s[i + k];
      if (s[i + k] > hi[k]) hi[k] = s[i + k];
    }
  }
  return { lo, hi };
}

/* Independent of everything under test: the signed volume of a closed soup by
   the tetrahedron sum. Used to say what the union actually holds rather than
   to trust that a boolean added two numbers. */
function signedVolume(s) {
  let v = 0;
  for (let t = 0; t < s.length; t += 9) {
    v += (s[t] * (s[t + 4] * s[t + 8] - s[t + 5] * s[t + 7])
        - s[t + 1] * (s[t + 3] * s[t + 8] - s[t + 5] * s[t + 6])
        + s[t + 2] * (s[t + 3] * s[t + 7] - s[t + 4] * s[t + 6])) / 6;
  }
  return v;
}

/* Edge topology straight off the soup, welded at a tenth of a micron. A
   quick, local "is this one closed shell" - the CANONICAL answer comes from
   tools/mesh_validate.py in the canonical check, not from here. */
function edgeStats(s) {
  const q = 1e4, id = new Map(), key = i =>
    Math.round(s[i] * q) + ',' + Math.round(s[i + 1] * q) + ',' + Math.round(s[i + 2] * q);
  const vid = i => { const k = key(i); if (!id.has(k)) id.set(k, id.size); return id.get(k); };
  const em = new Map();
  for (let t = 0; t < s.length; t += 9) {
    const a = vid(t), b = vid(t + 3), c = vid(t + 6);
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      const ek = x < y ? x + '_' + y : y + '_' + x;
      em.set(ek, (em.get(ek) || 0) + 1);
    }
  }
  let open = 0, nm = 0;
  em.forEach(n => { if (n === 1) open++; else if (n > 2) nm++; });
  return { verts: id.size, edges: em.size, open, nm };
}

/* ---- the two solids, sized by nso_stock.js and nothing else -------------
   Both at waste 0, so the material figure in the status line IS the block. */
const BODY = S.make({ shape: 'box', height: 40, radius: 20, wall: 3, waste: 0 });
const ARM = S.make({ shape: 'cylinder', height: 18, radius: 5, wall: 3, waste: 0,
                     ratio: 3, segments: 48 });
const CYL_BODY = S.make({ shape: 'cylinder', height: 40, radius: 20, wall: 3, waste: 0,
                          ratio: 1, segments: 96 });

(async function main() {

console.log('\n=== 0. the two Stock primitives ===');
{
  check('the body is a Stock box', BODY.ok && BODY.sizing.shape === 'box', BODY.reason);
  check('the arm is a Stock cylinder', ARM.ok && ARM.sizing.shape === 'cylinder', ARM.reason);
  const b = bounds(BODY.soup), a = bounds(ARM.soup);
  check('the arm is the smaller of the two',
    ARM.sizing.volume < BODY.sizing.volume,
    ARM.sizing.volume.toFixed(1) + ' mm^3 arm vs ' + BODY.sizing.volume.toFixed(1) + ' mm^3 body');
  /* The local-frame contract place() needs, and nso_stock.js gives it for
     free on both shapes: centred on the axis, resting on z = 0. */
  check('both rest on z = 0 - the frame place() maps onto the foot',
    b.lo[2] === 0 && a.lo[2] === 0, 'body z0 ' + b.lo[2] + ', arm z0 ' + a.lo[2]);
  check('NSO_Assemble.armSpan reads the arm\'s own +Z length',
    near(AS.armSpan(ARM.soup), ARM.sizing.measure.height, 1e-4),
    AS.armSpan(ARM.soup).toFixed(6) + ' mm vs the sized ' +
    ARM.sizing.measure.height.toFixed(6) + ' mm');
}

const csg = csgContext();
const bb = bounds(BODY.soup);
/* The chosen point: the middle of the body's +X face. */
const AT = [bb.hi[0], 0, (bb.lo[2] + bb.hi[2]) / 2];

console.log('\n=== 1. the smallest real case: generate, aim, seat, union ===');
let ASSEMBLY = null;
{
  const r = AS.attach(BODY.soup, ARM.soup, { at: AT, dir: [1, 0, 0] });
  check('attach succeeds', r.ok, r.reason);
  console.log('        ' + AS.describe(r));

  check('auto-aim found the foot exactly where the point was picked',
    r.footDriftMm === 0 || r.footDriftMm < 1e-6, r.footDriftMm.toExponential(2) + ' mm drift');
  /* +X to one ulp. The last bit goes in nearestBase's own normalisation - it
     divides by a length it computed as a square root - and it is quoted
     rather than rounded away, because a direction that is off by more than
     that is a direction that came from somewhere else. */
  check('the aim is the outward face normal, to one ulp',
    Math.abs(r.dir[0] - 1) <= Number.EPSILON && r.dir[1] === 0 && r.dir[2] === 0,
    '[' + r.dir.join(', ') + '], x is ' +
    (Math.abs(r.dir[0] - 1) / Number.EPSILON).toFixed(1) + ' ulp off 1');
  check('a flat face perpendicular to the aim has NO rim gap',
    r.rootGapMm < 1e-9, r.rootGapMm.toExponential(2) + ' mm over ' + r.rimPoints + ' rim points');
  check('so the seat is exactly the one-extrusion-line margin',
    near(r.engageMm, 0.42, 1e-9) && r.marginSource === 'NSO_Thickness.floorFor',
    r.engageMm.toFixed(6) + ' mm, ' + r.marginSource);
  check('Extend put the sunk length back - the arm proud of the face is the sized length',
    r.keptLength && near(r.exposedLengthMm, ARM.sizing.measure.height, 1e-4),
    r.exposedLengthMm.toFixed(6) + ' mm proud vs the sized ' +
    ARM.sizing.measure.height.toFixed(6) + ' mm');
  check('the turn is the 90 degrees +Z -> +X is',
    near(r.turnedDeg, 90, 1e-6), r.turnedDeg.toFixed(6) + ' deg');

  const u = await csg.NSO_unionSoups(BODY.soup, r.soup);
  check('the SHIPPED NSO_CSG union takes it', u.ok, u.reason || '');
  check('  ...and it is ONE part, not two solids in contact',
    u.parts === 1, u.parts + ' part(s)');
  check('  ...closed by the kernel\'s own topology: 0 open, 0 non-manifold',
    u.stats && u.stats.open === 0 && u.stats.nm === 0, JSON.stringify(u.stats));
  const es = edgeStats(u.soup);
  check('  ...and closed by an independent edge count off the soup',
    es.open === 0 && es.nm === 0,
    u.soup.length / 9 + ' tris, ' + es.verts + ' verts, ' + es.edges + ' edges, ' +
    es.open + ' open, ' + es.nm + ' non-manifold');

  /* What the solid actually holds. The arm is sunk 0.42 mm and grown 0.42 mm,
     so the union is the body plus the arm's full sized length standing proud
     of the face plus the 0.42 mm plug now inside the body - which is the arm
     AS BUILT, once, with nothing double-counted. */
  const want = signedVolume(BODY.soup) + signedVolume(ARM.soup);
  const got = signedVolume(u.soup);
  check('volume = the body plus the arm as built, to 1e-4 relative',
    Math.abs(got - want) / want < 1e-4,
    got.toFixed(4) + ' mm^3 vs ' + want.toFixed(4) + ' mm^3 (' +
    (100 * (got - want) / want).toExponential(2) + '%)');

  writeSTL(path.join(OUT, 'box_body_cyl_arm.stl'), u.soup);
  writeSTL(path.join(OUT, 'box_body_cyl_arm_body.stl'), BODY.soup);
  writeSTL(path.join(OUT, 'box_body_cyl_arm_arm.stl'), r.soup);
  ASSEMBLY = u.soup;
}

console.log('\n=== 2. THE FINDING: zero engagement across four body faces ===');
console.log('    place(soup, from, dir) - what the aim module gives you on its own -');
console.log('    seats the arm FLUSH. Four faces, same arm, same calls, the shipped union:');
{
  const cb = bounds(CYL_BODY.soup);
  const R = CYL_BODY.sizing.measure.radius, H = CYL_BODY.sizing.measure.height;
  const u3 = v => { const L = Math.hypot(v[0], v[1], v[2]); return [v[0] / L, v[1] / L, v[2] / L]; };
  const obl = u3([Math.cos(Math.PI / 6), 0, Math.sin(Math.PI / 6)]);
  const L = ARM.sizing.measure.height;

  const CASES = [
    ['box, flat face, straight on', BODY.soup, [AT[0] + L, AT[1], AT[2]], true],
    ['box, flat face, 30 deg oblique', BODY.soup,
      [AT[0] + obl[0] * L, AT[1], AT[2] + obl[2] * L], true],
    ['cylinder, flat top', CYL_BODY.soup, [0, 0, H + L], true],
    ['cylinder, CURVED flank', CYL_BODY.soup, [R + L, 0, H / 2], false]
  ];

  for (const [label, body, target, expectTouch] of CASES) {
    /* The naive composition, written out so there is no doubt what is being
       measured: nearestBase, then place, then union. No seat. */
    const nb = SA.nearestBase(target, [{ kind: 'piece', soup: body, id: 'body' }],
                              { obstacles: [body] });
    const pl = SA.place(ARM.soup, nb.from, nb.dir);
    const u = await csg.NSO_unionSoups(body, pl.soup);
    check('flush: ' + label + (expectTouch ? ' -> one solid' : ' -> the kernel REFUSES it'),
      u.ok === expectTouch,
      'parts ' + u.parts + (u.reason ? ', "' + u.reason + '"' : ''));

    /* ...and the same face through attach(), which seats it. Every one of the
       four then lands as one solid, including the one flush cannot do. */
    const r = AS.attach(body, ARM.soup, { target: target });
    check('  seated: ' + label + ' -> one solid', r.ok, r.reason);
    if (!r.ok) continue;
    const u2 = await csg.NSO_unionSoups(body, r.soup);
    check('  ...union ok, 1 part', u2.ok && u2.parts === 1,
      'engage ' + r.engageMm.toFixed(4) + ' mm (rim gap ' + r.rootGapMm.toFixed(4) +
      '), parts ' + u2.parts + ', ' + (u2.soup ? u2.soup.length / 9 : 0) + ' tris');
    if (u2.ok) {
      writeSTL(path.join(OUT, 'face_' + label.replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '.stl'),
        u2.soup);
    }
  }
}

console.log('\n=== 3. the seat depth is MEASURED, against the closed form ===');
{
  const R = CYL_BODY.sizing.measure.radius;
  const r = ARM.sizing.measure.radius;
  const res = AS.attach(CYL_BODY.soup, ARM.soup, { at: [R, 0, CYL_BODY.sizing.measure.height / 2],
                                                   dir: [1, 0, 0] });
  check('attach onto the curved flank succeeds', res.ok, res.reason);

  /* On a TRUE cylinder the rim corner sits sqrt(R^2 + r^2) from the axis, so
     the gap is that minus R. The body is a 96-gon inscribed in that cylinder,
     so its surface is a shade further in and the measured gap is a shade
     larger. Both numbers are printed; the difference is the tessellation and
     is named, not absorbed into a tolerance. */
  const closed = Math.sqrt(R * R + r * r) - R;
  check('the rim gap matches the true-cylinder closed form to within the 96-gon',
    res.rootGapMm > closed && res.rootGapMm - closed < 0.01,
    'measured ' + res.rootGapMm.toFixed(6) + ' mm, closed form ' + closed.toFixed(6) +
    ' mm, 96-gon inscription accounts for ' + (res.rootGapMm - closed).toFixed(6) + ' mm');
  check('the seat is the gap plus the floor, and nothing else',
    near(res.engageMm, res.rootGapMm + 0.42, 1e-12),
    res.engageMm.toFixed(6) + ' = ' + res.rootGapMm.toFixed(6) + ' + 0.42');
  check('every rim point is sampled, not just the corners',
    res.rimPoints === 49, res.rimPoints + ' rim points on a 48-segment cylinder ' +
    '(48 round the base + the axis point the caps fan from)');

  /* The margin is nso_thickness.js's, and this file has no second opinion. */
  const m = AS.margin({});
  check('the margin comes from NSO_Thickness.floorFor and nowhere else',
    m.ok && m.source === 'NSO_Thickness.floorFor' && m.mm === ctx.NSO_Thickness.floorFor(),
    m.mm + ' mm');
  check('nso_assemble.js carries no floor literal of its own',
    !/0\.42|nozzle\s*\*\s*1\.05/.test(fs.readFileSync(path.join(ROOT, 'nso_assemble.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')),
    'no 0.42 and no nozzle * 1.05 outside the comments');
}

console.log('\n=== 4. the contracts refuse BY NAME ===');
{
  const r1 = AS.attach(BODY.soup, ARM.soup, { at: AT, dir: [1, 0, 0], thickness: {} });
  check('no nso_thickness.js -> refused, and it names the file',
    !r1.ok && /nso_thickness\.js is not loaded/.test(r1.reason), r1.reason.slice(0, 90) + '...');

  const r2 = AS.attach(BODY.soup, ARM.soup, { at: AT, dir: [1, 0, 0], aim: {} });
  check('no nso_support_aim.js -> refused, and it names the file',
    !r2.ok && /nso_support_aim\.js is not loaded/.test(r2.reason), r2.reason.slice(0, 90) + '...');

  /* A solid modelled around its own centre, which is what most imported bits
     are. place() would bury half of it in the body without a word. */
  const centred = new Float32Array(ARM.soup);
  for (let i = 2; i < centred.length; i += 3) centred[i] -= ARM.sizing.measure.height / 2;
  const r3 = AS.attach(BODY.soup, centred, { at: AT, dir: [1, 0, 0] });
  check('an arm modelled around its own centre -> refused at the rim stage',
    !r3.ok && r3.stage === 'rim' && /LOCAL ORIGIN/.test(r3.reason),
    'near end ' + r3.baseOffsetMm.toFixed(4) + ' mm off the foot');

  /* Clicked the back face, pointed forward. The nearest point to that target
     is the FRONT face, so the arm would grow out of somewhere the user did
     not pick - and that is said rather than silently obeyed. */
  const r4 = AS.attach(BODY.soup, ARM.soup, { at: [bb.lo[0], 0, AT[2]], dir: [1, 0, 0] });
  check('a pick that disagrees with the aim -> refused, with the distance',
    !r4.ok && /mm apart/.test(r4.reason),
    'foot drift ' + r4.footDriftMm.toFixed(3) + ' mm');

  /* A wall standing between the face and where the arm would end. auto-aim's
     own blockage test, reached through attach with nothing added. */
  const wall = S.make({ shape: 'box', height: 30, radius: 15, wall: 3, waste: 0 }).soup;
  const shifted = new Float32Array(wall);
  for (let i = 0; i < shifted.length; i += 3) shifted[i] += bb.hi[0] + 12;
  const r5 = AS.attach(BODY.soup, ARM.soup,
    { at: AT, dir: [1, 0, 0], obstacles: [shifted] });
  check('a blocked straight line -> refused in nearestBase\'s own words',
    !r5.ok && r5.stage === 'aim' && /blocked|no viable base/.test(r5.reason),
    r5.reason.slice(0, 110) + '...');

  const r6 = AS.attach(BODY.soup, ARM.soup, { at: AT });
  check('neither a target nor a direction -> refused, and it says which',
    !r6.ok && /opts\.target/.test(r6.reason) && /opts\.at \+ opts\.dir/.test(r6.reason));

  /* A Stock sphere has no straight axis, so Extend will not lengthen it. The
     seat still happens; the shortfall is STATED in Extend's own words. */
  const ball = S.make({ shape: 'sphere', height: 12, radius: 6, wall: 3, waste: 0 });
  const r7 = AS.attach(BODY.soup, ball.soup, { at: AT, dir: [1, 0, 0] });
  check('a sphere arm seats, but Extend will not lengthen it - and says so',
    r7.ok && r7.keptLength === false && /would not grow/.test(r7.growWarning || ''),
    (r7.growWarning || '').slice(0, 120) + '...');
  check('  ...so the exposed length is short by exactly the seat',
    near(r7.exposedLengthMm, AS.armSpan(ball.soup) - r7.engageMm, 1e-9),
    r7.exposedLengthMm.toFixed(4) + ' mm proud of ' + AS.armSpan(ball.soup).toFixed(4) +
    ' mm, seated ' + r7.engageMm.toFixed(4));
}

console.log('\n=== 5. the assembly is an ORDINARY piece - Repair, Extend, Fatten ===');
{
  /* REPAIR. The strongest statement available: NSO_Repair.commit hands the
     CALLER'S OWN ARRAY back, by reference, when nothing was applied. So this
     is not "repair changed little", it is "repair found nothing to do". */
  const rep = ctx.NSO_Repair.commit(ASSEMBLY, {});
  check('Repair no-ops the assembly BY IDENTITY - the same array comes back',
    rep.ok && rep.rawTris === ASSEMBLY && rep.report.applied === false,
    'applied ' + rep.report.applied + ', "' + rep.report.reason + '", nonSolid ' +
    rep.report.nonSolid);

  /* EXTEND. The detector picks the assembly's own dominant axis - x, the one
     the arm points along - with no argument from us. */
  const det = ctx.NSO_extendDetectAxis(ASSEMBLY, {});
  check('Extend\'s detector reads the assembly and calls the axis x',
    det.ok && det.axis === 'x', det.ok ? ('axis ' + det.axis) : det.reason);

  const ab = bounds(ASSEMBLY);
  const wantLen = (ab.hi[0] - ab.lo[0]) + 5;
  const ext = ctx.NSO_extendRaw(ASSEMBLY, { axis: 'x', length: wantLen, gate: true });
  check('Extend lengthens the assembly along that axis with no special-casing',
    ext.ok, ext.ok ? '' : ext.reason);
  if (ext.ok) {
    const eb = bounds(ext.tris);
    check('  ...to the asked length, and the cross-section is held bit for bit',
      near(eb.hi[0] - eb.lo[0], wantLen, 1e-3) &&
      eb.lo[1] === ab.lo[1] && eb.hi[1] === ab.hi[1] &&
      eb.lo[2] === ab.lo[2] && eb.hi[2] === ab.hi[2],
      (eb.hi[0] - eb.lo[0]).toFixed(4) + ' mm long, y and z bounds unmoved');
    writeSTL(path.join(OUT, 'assembly_extended.stl'), ext.tris);
  }

  /* FATTEN. The same two calls app-fatten.js's button makes, in the same
     order: Extend's detector, then Thicken's offset restricted to the faces
     parallel to that axis. */
  const faces = ctx.NSO_fattenCrossSectionFaces(ASSEMBLY, det.axisIdx, {});
  check('Fatten marks the assembly\'s cross-section faces',
    faces.move > 0 && faces.untrusted === 0,
    faces.move + ' movable, ' + faces.hold + ' held, ' + faces.untrusted + ' untrusted');
  const off = ctx._thickenOffsetSoup(ASSEMBLY, 'out', 0.5, { mayMove: faces.mayMove });
  check('  ...and Thicken\'s offset runs on it', !!(off && off.soup),
    (off && off.reason) || '');
  if (off && off.soup) {
    const why = ctx.NSO_fattenLengthGate(det.axisIdx, undefined)(ASSEMBLY, off.soup);
    check('  ...through Fatten\'s own length gate', !why, why || 'length held');
    const fb = bounds(off.soup);
    check('  ...the cross-section grew 0.5 mm a side and the x length did not move',
      near(fb.hi[1] - ab.hi[1], 0.5, 1e-3) && near(ab.lo[1] - fb.lo[1], 0.5, 1e-3) &&
      fb.lo[0] === ab.lo[0] && fb.hi[0] === ab.hi[0],
      'y ' + (ab.hi[1] - ab.lo[1]).toFixed(3) + ' -> ' + (fb.hi[1] - fb.lo[1]).toFixed(3) +
      ' mm, x ' + (ab.hi[0] - ab.lo[0]).toFixed(3) + ' mm unmoved');
    writeSTL(path.join(OUT, 'assembly_fattened.stl'), off.soup);
  }

  /* NAMED, not swept under the rug: Extend's CROSS-axis stretch of this
     assembly is refused - by Extend's own float32 layer gate, which is a
     property of a piece carrying a 48-gon at one end, not a property of
     having come out of a boolean. The plain body box takes the same stretch. */
  const ez = ctx.NSO_extendRaw(ASSEMBLY, { axis: 'z', length: (ab.hi[2] - ab.lo[2]) + 5, gate: true });
  const bz = ctx.NSO_extendRaw(BODY.soup, { axis: 'z', length: 31, gate: true });
  check('Extend across the arm\'s axis is refused by Extend\'s OWN gate, not by us',
    !ez.ok && bz.ok, 'assembly z: "' + (ez.reason || '').slice(0, 70) + '"; plain box z: ok');
}

console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }

})().catch(err => { console.error(err); process.exit(1); });
