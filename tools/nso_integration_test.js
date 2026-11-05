#!/usr/bin/env node
// Integration stress test: tools that are each correct on their own, meeting
// for the first time.
//
//   node tools/nso_integration_test.js      exit 0 = every gate held
//
// This suite is deliberately NOT a feature suite. Every tool it drives has its
// own suite that already proves the tool right in isolation. What is asserted
// here is only what happens at the JOINS between them, and the reason it is
// worth its own file is that the one real bug it found - see section 2 - was
// invisible from either side: Hollow was right, the union was right, and the
// pair was broken.
//
// It also carries the NEGATIVE CONTROLS for the two fixes that came out of it.
// A gate that has been loosened has to be shown still refusing the thing it
// was built to refuse, or the fix is indistinguishable from deleting the gate.
//
// Loads the shipped files with vm in index.html's own order, the way
// tools/nso_assemble_test.js does, and uses the SHIPPED boolean through
// tools/nso_csg_node.js. The app-layer half of the same sweep - Clone,
// Extract selection, the Pottery Wheel through Paint and Delete - is
// tools/nso_wire_integration_test.js, because those are app state, not
// geometry.
//
// Full write-up, including what was found NOT to be a bug and why:
// docs/INTEGRATION.md

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'integration-out');
const { writeSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, isNaN,
  parseFloat, parseInt, Float32Array, Float64Array, Int32Array, Uint32Array,
  Uint8Array, Uint16Array, Int8Array, ArrayBuffer, Error, Infinity, NaN, Date,
  Promise, RegExp, Boolean, Symbol, setTimeout, clearTimeout,
  NSO_Thickness: require(path.join(ROOT, 'nso_thickness.js')),
  NSO_Printer: require(path.join(ROOT, 'nso_printer.js'))
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ['nso_stock.js', 'nso_hollow.js', 'nso_seat_surface.js', 'app-sculpt.js',
                 'app-finish.js', 'app-extend.js', 'app-fatten.js', 'nso_support_aim.js',
                 'nso_assemble.js', 'app-wheel.js', 'NSO_Repair.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const S = ctx.NSO_Stock, H = ctx.NSO_Hollow, AS = ctx.NSO_Assemble;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
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
function signedVolume(s) {
  let v = 0;
  for (let t = 0; t < s.length; t += 9) {
    v += (s[t] * (s[t + 4] * s[t + 8] - s[t + 5] * s[t + 7])
        - s[t + 1] * (s[t + 3] * s[t + 8] - s[t + 5] * s[t + 6])
        + s[t + 2] * (s[t + 3] * s[t + 7] - s[t + 4] * s[t + 6])) / 6;
  }
  return v;
}
/* Edge topology and the Euler characteristic straight off the soup. chi = 2 is
   one closed shell; chi = 4 is a solid with one internal void, which is what a
   hollowed piece legitimately is and is the whole subject of section 2. */
function topo(s) {
  const q = 1e4, id = new Map();
  const key = i => Math.round(s[i] * q) + ',' + Math.round(s[i + 1] * q) + ',' + Math.round(s[i + 2] * q);
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
  return { verts: id.size, edges: em.size, tris: (s.length / 9) | 0, open, nm,
           chi: id.size - em.size + ((s.length / 9) | 0) };
}
function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const t of f) for (const i of t) o.push(...v[i]);
  return new Float32Array(o);
}

/* The headless half of what the Fatten button runs: Extend's detector, then
   Thicken's offset restricted to the faces parallel to that axis, then
   Fatten's own length gate. Same three calls in the same order. */
function fattenRaw(soup, mm, opts) {
  opts = opts || {};
  const det = ctx.NSO_extendDetectAxis(soup, opts);
  if (!det.ok) return { ok: false, reason: det.reason, stage: 'detect' };
  const faces = ctx.NSO_fattenCrossSectionFaces(soup, det.axisIdx, opts);
  if (faces.move === 0) return { ok: false, reason: 'no face parallel to ' + det.axis, stage: 'faces' };
  const r = ctx._thickenOffsetSoup(soup, 'out', mm, { mayMove: faces.mayMove });
  if (!r || !r.soup) return { ok: false, reason: (r && r.reason) || 'no soup', stage: 'offset' };
  const why = ctx.NSO_fattenLengthGate(det.axisIdx, opts.lengthUlps)(soup, r.soup);
  if (why) return { ok: false, reason: why, stage: 'gate' };
  return { ok: true, tris: r.soup, axis: det.axis, axisIdx: det.axisIdx, faces };
}

/* ---- the pieces every section below is built out of --------------------- */
const BODY = S.make({ shape: 'box', height: 40, radius: 20, wall: 3, waste: 0 });
const ARM = S.make({ shape: 'cylinder', height: 18, radius: 5, wall: 3, waste: 0,
                     ratio: 3, segments: 48 });

(async function main() {
const csg = csgContext();

console.log('\n=== 1. an assembly through Extend and Fatten, at four attachment points ===');
console.log('    Attach\'s own report validated ONE axis from ONE point. This asks the');
console.log('    same two tools about every face of the body and all three axes.');
const ASSEMBLIES = {};
{
  const bb = bounds(BODY.soup);
  const PTS = [
    ['+X face', [bb.hi[0], 0, (bb.lo[2] + bb.hi[2]) / 2], [1, 0, 0], 'x'],
    ['-X face', [bb.lo[0], 0, (bb.lo[2] + bb.hi[2]) / 2], [-1, 0, 0], 'x'],
    ['+Y face', [0, bb.hi[1], (bb.lo[2] + bb.hi[2]) / 2], [0, 1, 0], 'y'],
    ['+Z top', [0, 0, bb.hi[2]], [0, 0, 1], 'z']
  ];
  for (const [label, at, dir, wantAxis] of PTS) {
    const r = AS.attach(BODY.soup, ARM.soup, { at, dir });
    check(label + ': Attach seats the arm', r.ok, r.ok ? '' : r.reason);
    if (!r.ok) continue;
    const u = await csg.NSO_unionSoups(BODY.soup, r.soup);
    check(label + ': the union is one solid', u.ok && u.parts === 1,
      'parts ' + u.parts + (u.reason ? ' - ' + u.reason : ''));
    if (!u.ok) continue;
    const A = u.soup, t0 = topo(A), ab = bounds(A);
    ASSEMBLIES[wantAxis] = ASSEMBLIES[wantAxis] || A;
    check(label + ': ...closed, one shell', t0.open === 0 && t0.nm === 0 && t0.chi === 2,
      t0.tris + ' tris, chi ' + t0.chi + ', ' + t0.open + ' open, ' + t0.nm + ' nm');

    /* Extend picks the assembly's own dominant axis, which is the ARM's axis
       wherever the arm was put - not a fixed one. That is the integration
       claim: the detector reads the piece, it was not told. */
    const det = ctx.NSO_extendDetectAxis(A, {});
    check(label + ': Extend\'s detector picks ' + wantAxis + ' unprompted',
      det.ok && det.axis === wantAxis, det.ok ? ('axis ' + det.axis) : det.reason);

    const i = { x: 0, y: 1, z: 2 }[wantAxis];
    const want = (ab.hi[i] - ab.lo[i]) + 5;
    const e = ctx.NSO_extendRaw(A, { axis: wantAxis, length: want, gate: true });
    check(label + ': Extend lengthens it along that axis', e.ok, e.ok ? '' : e.reason);
    if (e.ok) {
      const eb = bounds(e.tris), et = topo(e.tris);
      const held = [0, 1, 2].filter(k => k !== i)
        .every(k => eb.lo[k] === ab.lo[k] && eb.hi[k] === ab.hi[k]);
      check(label + ': ...to length, cross-section held bit for bit, still one shell',
        Math.abs((eb.hi[i] - eb.lo[i]) - want) < 1e-3 && held && et.chi === 2 &&
        et.open === 0 && et.nm === 0,
        (eb.hi[i] - eb.lo[i]).toFixed(4) + ' mm, chi ' + et.chi);
      writeSTL(path.join(OUT, 'asm_' + wantAxis + '_extended.stl'), e.tris);
    }

    /* The two cross axes are REFUSED, and that is Extend's own injectivity
       gate, not a combination bug - see docs/INTEGRATION.md finding 4. What
       is asserted is that it refuses rather than mangles: the input comes
       back by identity. */
    for (const ax of ['x', 'y', 'z']) {
      if (ax === wantAxis) continue;
      const j = { x: 0, y: 1, z: 2 }[ax];
      const bad = ctx.NSO_extendRaw(A, { axis: ax, length: (ab.hi[j] - ab.lo[j]) + 5, gate: true });
      check(label + ': a cross-axis stretch (' + ax + ') refuses and hands the piece back untouched',
        !bad.ok && bad.tris === A, (bad.reason || '').slice(0, 70));
    }

    const f = fattenRaw(A, 0.5, {});
    check(label + ': Fatten grows the cross-section', f.ok, f.ok ? '' : f.reason);
    if (f.ok) {
      const fb = bounds(f.tris), ft = topo(f.tris);
      const lengthHeld = fb.lo[i] === ab.lo[i] && fb.hi[i] === ab.hi[i];
      const grew = [0, 1, 2].filter(k => k !== i)
        .every(k => Math.abs((fb.hi[k] - ab.hi[k]) - 0.5) < 1e-3 &&
                    Math.abs((ab.lo[k] - fb.lo[k]) - 0.5) < 1e-3);
      check(label + ': ...0.5 mm a side, ' + wantAxis + ' length untouched, still one shell',
        grew && lengthHeld && ft.chi === 2 && ft.open === 0 && ft.nm === 0,
        'chi ' + ft.chi + ', ' + wantAxis + ' ' + (ab.hi[i] - ab.lo[i]).toFixed(3) +
        ' -> ' + (fb.hi[i] - fb.lo[i]).toFixed(3));
      writeSTL(path.join(OUT, 'asm_' + wantAxis + '_fattened.stl'), f.tris);
    }
    const fs2 = fattenRaw(A, -0.3, {});
    check(label + ': Fatten shrinks it too', fs2.ok, fs2.ok ? 'chi ' + topo(fs2.tris).chi : fs2.reason);
    writeSTL(path.join(OUT, 'asm_' + wantAxis + '.stl'), A);
  }

  /* A second arm onto a finished assembly - the case a limb tree starts from. */
  const A1 = ASSEMBLIES.x;
  const a1b = bounds(A1);
  const r2 = AS.attach(A1, ARM.soup, { at: [0, a1b.hi[1], 13.035058975219727], dir: [0, 1, 0] });
  check('a SECOND arm attaches to a finished assembly', r2.ok, r2.ok ? '' : r2.reason);
  if (r2.ok) {
    const u2 = await csg.NSO_unionSoups(A1, r2.soup);
    const t2 = u2.soup ? topo(u2.soup) : null;
    check('  ...and the two-arm result is still one closed shell',
      u2.ok && u2.parts === 1 && t2.chi === 2 && t2.open === 0 && t2.nm === 0,
      u2.ok ? (t2.tris + ' tris, chi ' + t2.chi) : u2.reason);
    if (u2.ok) writeSTL(path.join(OUT, 'asm_two_arms.stl'), u2.soup);
  }
}

console.log('\n=== 2. THE BUG: Hollow makes a two-shell solid, and the union counted shells ===');
console.log('    Two independently-correct tools. Hollow is right to make a piece with a');
console.log('    void; the kernel is right that a void is a second component. The GATE was');
console.log('    wrong: it asked for one component instead of asking whether A and B merged.');
let SHELL = null;
{
  const h = H.hollow(BODY.soup, { mode: 'exact', wall: 2, nozzle: 0.4 });
  check('Hollow makes a shell out of the Stock body', h.ok, (h.reason || '').slice(0, 110));
  SHELL = h.soup;
  const ht = topo(SHELL);
  check('  ...and it is legitimately TWO shells - chi 4, not 2',
    ht.chi === 4 && ht.open === 0 && ht.nm === 0,
    ht.tris + ' tris, chi ' + ht.chi + ', ' + ht.open + ' open, ' + ht.nm + ' nm');
  writeSTL(path.join(OUT, 'hollow_shell.stl'), SHELL);

  /* The fact the old gate could not see. Asked of the kernel directly, with a
     cube the shell plainly does not touch: the count starts at 2 before
     anything is joined. */
  const far = await csg.NSO_unionSoups(SHELL, box([100, 100, 100], [110, 110, 110]));
  check('the kernel counts the shell as 2 components before anything is joined',
    far.partsA === 2 && far.partsB === 1 && far.parts === 3,
    'A ' + far.partsA + ' + B ' + far.partsB + ' -> ' + far.parts);

  const bb = bounds(SHELL);
  const r = AS.attach(SHELL, ARM.soup, { at: [bb.hi[0], 0, (bb.lo[2] + bb.hi[2]) / 2], dir: [1, 0, 0] });
  check('Attach seats an arm on the shell exactly as it does on a solid',
    r.ok && r.rootGapMm < 1e-9 && Math.abs(r.engageMm - 0.42) < 1e-9,
    r.ok ? ('rim gap ' + r.rootGapMm.toExponential(2) + ', seated ' + r.engageMm.toFixed(4)) : r.reason);

  const u = await csg.NSO_unionSoups(SHELL, r.soup);
  check('THE FIX: the union is accepted - A 2 + B 1 -> 2 is a merge, not a miss',
    u.ok && u.parts === 2 && u.partsA === 2 && u.partsB === 1,
    'ok ' + u.ok + ', ' + u.partsA + ' + ' + u.partsB + ' -> ' + u.parts);

  /* And the union really had merged all along - this is what the old gate was
     throwing away. The overlap is the arm's cross-section times the seat. */
  const overlap = Math.PI * Math.pow(ARM.sizing.measure.radius, 2) * 0.42;
  const got = signedVolume(SHELL) + signedVolume(r.soup) - signedVolume(u.soup);
  check('  ...and the boolean had done its job the whole time: the overlap is subtracted',
    Math.abs(got - overlap) / overlap < 0.01,
    got.toFixed(4) + ' mm^3 removed vs pi r^2 x 0.42 = ' + overlap.toFixed(4));
  const ut = topo(u.soup);
  check('  ...result is closed, and still the one void it started with',
    ut.open === 0 && ut.nm === 0 && ut.chi === 4,
    ut.tris + ' tris, chi ' + ut.chi);
  writeSTL(path.join(OUT, 'hollow_shell_arm.stl'), u.soup);

  const rep = ctx.NSO_Repair.commit(u.soup, {});
  check('  ...and Repair no-ops the hollow assembly by identity',
    rep.ok && rep.rawTris === u.soup && rep.report.applied === false,
    '"' + rep.report.reason + '", nonSolid ' + rep.report.nonSolid);
}

console.log('\n=== 3. NEGATIVE CONTROLS for that fix - the gate must still refuse a miss ===');
console.log('    A loosened gate has to be shown still refusing what it was built to refuse,');
console.log('    or the fix is indistinguishable from deleting it.');
{
  const g1 = await csg.NSO_unionSoups(box([0, 0, 0], [10, 10, 10]), box([10.4, 0, 0], [20, 10, 10]));
  check('two solids parked a 0.4 mm kerf apart are STILL refused',
    !g1.ok && g1.parts === 2 && g1.partsA === 1 && g1.partsB === 1,
    g1.partsA + ' + ' + g1.partsB + ' -> ' + g1.parts + ': "' + g1.reason + '"');

  const g2 = await csg.NSO_unionSoups(SHELL, box([100, 100, 100], [110, 110, 110]));
  check('a hollow shell and a cube 100 mm away are STILL refused',
    !g2.ok && g2.parts === 3, g2.partsA + ' + ' + g2.partsB + ' -> ' + g2.parts);
  check('  ...and the refusal now says WHY the count is what it is',
    /A is 2 shell\(s\)/.test(g2.reason), g2.reason);

  /* The case that would fool a naive "the count went down" test if the counts
     were not measured on both inputs: a captive solid sitting in the cavity,
     touching nothing. */
  const g3 = await csg.NSO_unionSoups(SHELL, box([-1, -1, 10], [1, 1, 12]));
  check('a cube captive INSIDE the cavity, touching nothing, is STILL refused',
    !g3.ok && g3.parts === 3, g3.partsA + ' + ' + g3.partsB + ' -> ' + g3.parts);

  /* The body's +X face is at 13.0351, so this cube bites 0.5 mm into it. */
  const g4 = await csg.NSO_unionSoups(BODY.soup, box([12.5, -3, 10], [20, 3, 16]));
  check('and a plain solid pair that really does touch is still accepted',
    g4.ok && g4.parts === 1, 'parts ' + g4.parts);
}

console.log('\n=== 4. the other order, and the rest of the finish chain on a hollow piece ===');
{
  /* Attach first, THEN hollow the assembly. The reverse of section 2, and the
     order a person is at least as likely to use. */
  const bb = bounds(BODY.soup);
  const r = AS.attach(BODY.soup, ARM.soup, { at: [bb.hi[0], 0, (bb.lo[2] + bb.hi[2]) / 2], dir: [1, 0, 0] });
  const u = await csg.NSO_unionSoups(BODY.soup, r.soup);
  const h = H.hollow(u.soup, { mode: 'exact', wall: 2, nozzle: 0.4 });
  check('Attach THEN Hollow: the assembly hollows', h.ok, (h.reason || '').slice(0, 120));
  if (h.ok) {
    const t = topo(h.soup);
    check('  ...to a closed two-shell solid', t.open === 0 && t.nm === 0 && t.chi === 4,
      t.tris + ' tris, chi ' + t.chi);
    const rep = ctx.NSO_Repair.commit(h.soup, {});
    check('  ...that Repair no-ops by identity',
      rep.rawTris === h.soup && rep.report.applied === false, '"' + rep.report.reason + '"');
    writeSTL(path.join(OUT, 'asm_then_hollow.stl'), h.soup);
  }

  /* Extend on a hollow piece: the void travels with the stretch. */
  const sb = bounds(SHELL);
  const e = ctx.NSO_extendRaw(SHELL, { axis: 'z', length: (sb.hi[2] - sb.lo[2]) + 5, gate: true });
  check('Extend lengthens a hollow shell', e.ok, e.ok ? '' : (e.reason || '').slice(0, 90));
  if (e.ok) {
    const et = topo(e.tris);
    check('  ...and the void goes with it - still chi 4, still closed',
      et.chi === 4 && et.open === 0 && et.nm === 0, 'chi ' + et.chi);
    writeSTL(path.join(OUT, 'hollow_extended.stl'), e.tris);
  }

  /* NOT a bug, and asserted as such so a later ticket does not "fix" it:
     Smooth on a hollow shell refuses, because smoothing a 2 mm wall whose
     cavity is a 0.667 mm marching-cubes surface drives the cavity out through
     the skin and the signed volume flips. The gate catches it and the input
     comes back untouched. */
  const sm = ctx.NSO_smoothGlobal(SHELL, { maxVolumeChange: 0.25 });
  check('Smooth REFUSES a hollow shell, and hands it back unchanged',
    !sm.ok && sm.tris === SHELL, '"' + (sm.reason || '') + '"');
}

console.log('\n=== 5. a Pottery Wheel vessel is an ordinary piece for Repair ===');
console.log('    The app half of this - Paint, Delete, Seat - is in the wire suite.');
{
  const ball = ctx.NSO_wheelBall({ height: 60, radius: 30, wall: 3 });
  check('Ball throws a vessel', ball.ok, (ball.reason || '').slice(0, 100));
  const op = ctx.NSO_wheelOpen(ball.piece, {});
  check('Open turns it into a vessel', op.ok, (op.reason || '').slice(0, 100));
  const soup = ctx.NSO_wheelRevolve(op.piece, {});
  const t = topo(soup);
  check('the revolved vessel is ONE closed shell - not a hollow two-shell solid',
    t.chi === 2 && t.open === 0 && t.nm === 0,
    t.tris + ' tris, chi ' + t.chi + ' (an open-topped pocket, which is why the ' +
    'section-2 bug never reached the wheel)');
  const rep = ctx.NSO_Repair.commit(soup, {});
  check('Repair no-ops the wheel vessel by identity',
    rep.ok && rep.rawTris === soup && rep.report.applied === false,
    '"' + rep.report.reason + '", nonSolid ' + rep.report.nonSolid);
  writeSTL(path.join(OUT, 'wheel_vessel.stl'), soup);

  /* And the wheel's output goes into Attach, which no suite had asked before.

     First, the pick gate earning its keep on a real curved piece: a vessel's
     widest point is not at its mid-height, so [maxX, 0, midZ] is a point in
     mid-air beside the wall rather than on it, and attach refuses by name
     instead of growing an arm out of somewhere the user did not pick. */
  const vb = bounds(soup);
  const offSurface = AS.attach(soup, ARM.soup,
    { at: [vb.hi[0], 0, (vb.lo[2] + vb.hi[2]) / 2], dir: [1, 0, 0] });
  check('a pick that is beside the vessel rather than on it is refused, with the distance',
    !offSurface.ok && /mm apart/.test(offSurface.reason),
    'foot drift ' + offSurface.footDriftMm.toFixed(3) + ' mm');

  /* Then the real attach, aimed the headless way: name where the free end
     goes and let auto-aim find the foot on the curve for itself. */
  const r = AS.attach(soup, ARM.soup,
    { target: [vb.hi[0] + ARM.sizing.measure.height, 0, (vb.lo[2] + vb.hi[2]) / 2] });
  check('an arm attaches to the wheel vessel\'s curved flank', r.ok,
    r.ok ? ('rim gap ' + r.rootGapMm.toFixed(4) + ' mm, seated ' + r.engageMm.toFixed(4)) : r.reason);
  check('  ...and the curved flank needed a seat DEEPER than the bare floor',
    r.ok && r.rootGapMm > 0.01 && r.engageMm > r.rootGapMm,
    r.ok ? (r.rootGapMm.toFixed(4) + ' + 0.42 = ' + r.engageMm.toFixed(4) + ' mm') : '');
  if (r.ok) {
    const u = await csg.NSO_unionSoups(soup, r.soup);
    const ut = u.soup ? topo(u.soup) : null;
    check('  ...and the union is one closed solid',
      u.ok && ut.chi === 2 && ut.open === 0 && ut.nm === 0,
      u.ok ? (ut.tris + ' tris, chi ' + ut.chi) : u.reason);
    if (u.ok) writeSTL(path.join(OUT, 'wheel_vessel_arm.stl'), u.soup);
  }
}

console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }

})().catch(err => { console.error(err); process.exit(1); });
