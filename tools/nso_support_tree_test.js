#!/usr/bin/env node
// Headless self-test for nso_support_tree.js: the contact points an overhang
// actually needs, where the trunk stops, and the fan it hands off to.
//
//   node tools/nso_support_tree_test.js      exit 0 = every gate held
//
// Loads the shipped files with vm, in index.html's own order, exactly the way
// tools/nso_support_aim_test.js does - so the browser files stay free of any
// node idiom and the stronger set of Extend's gates runs on the trunk's growth
// step. app-join.js's boolean comes in through tools/nso_csg_node.js, which is
// the SHIPPED union spliced out of app-join.js rather than a second copy.
//
// Writes tools/support-tree-out/*.stl for
// tools/nso_support_tree_canonical_check.js, which puts the same solids
// through tools/mesh_validate.py.
//
// The numbers worth reading are the exact ones. "the widest branch leans
// 31.43 deg" is the measured angle of the measured branch, not a rounded
// restatement of the limit, and the contact counts are counted rather than
// predicted.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'support-tree-out');
const { writeSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_seat_surface.js', 'app-sculpt.js',
                 'app-extend.js', 'nso_support_aim.js', 'nso_path_sweep.js',
                 'nso_support_tree.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const ST = ctx.NSO_SupportTree;
const SA = ctx.NSO_SupportAim;
const PS = ctx.NSO_PathSweep;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---- shapes built here, so the arithmetic is checkable by hand ---------- */

function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const t of f) for (const i of t) out.push(...v[i]);
  return out;
}
const soupOf = (...parts) => new Float32Array([].concat(...parts));

/* nso_support_aim.js's own cantilever: a 20 x 10 mm underside at z = 16. */
const CANTILEVER = soupOf(box([0, 0, 0], [10, 10, 20]), box([10, 0, 16], [30, 10, 20]));
/* The same arm, 12 mm long instead of 20: a fan one trunk can serve. */
const SHELF = soupOf(box([0, 0, 0], [10, 10, 20]), box([10, 0, 16], [22, 10, 20]));
/* The full 20 x 10 arm, carried 6 mm higher so the branches have the rise. */
const TALL = soupOf(box([0, 0, 0], [10, 10, 26]), box([10, 0, 22], [30, 10, 26]));
/* An 8 x 8 tab beside the post. 8 mm is between two spans and three, so the
   lattice is 3 x 3 and its middle site lands dead on the trunk's own aim -
   the collinear case, which is the ordinary one on any symmetric region with
   an odd site count rather than a corner case. */
const TAB = soupOf(box([0, 0, 0], [10, 10, 16]), box([10, 1, 12], [18, 9, 16]));
/* A 2 x 2 tab: smaller than one span in both directions, so one contact. */
const TINY = soupOf(box([0, 0, 0], [10, 10, 16]), box([10, 4, 12], [12, 6, 16]));

console.log('\n=== 1. THE CONTACT POINTS: derived from the region, not asked for ===');

const detSHELF = SA.detectOverhangs(SHELF, { skipList: [] });
const regSHELF = detSHELF.regions[0];
{
  check('the shelf has one unsupported region, 120 mm^2 at z = 16',
    detSHELF.ok && detSHELF.regions.length === 1 && near(regSHELF.areaMm2, 120, 1e-3),
    `${detSHELF.regions.length} region(s), ${regSHELF.areaMm2.toFixed(3)} mm^2`);

  const cp = ST.contactPoints(SHELF, regSHELF, { skipList: [] });
  check('contactPoints derives a count rather than taking one',
    cp.ok && cp.points.length > 1, cp.reason);

  /* ceil(12 / 3.29) x ceil(10 / 3.29) = 4 x 4, every site on a flat 12 x 10
     region. Hand-computable, and the point of the centred lattice. */
  check('the lattice is ceil(w / pitch) x ceil(d / pitch) = 4 x 4, all 16 on the region',
    cp.latticeNx === 4 && cp.latticeNy === 4 && cp.lattice === 16 && cp.points.length === 16,
    `${cp.latticeNx} x ${cp.latticeNy}, ${cp.lattice} on the lattice, ${cp.topUp} topped up`);

  check('no top-up was needed on a flat region the lattice already covers',
    cp.topUp === 0, `${cp.topUp}`);

  /* Neighbouring sites sit at EXACTLY the pitch - that is what makes the
     covering radius pitch/2 rather than something to be hoped for. */
  check('neighbouring contacts sit at exactly the span, 3.29 mm',
    near(cp.nnMm.min, ST.MAX_SPAN_MM, 1e-9) && near(cp.nnMm.max, ST.MAX_SPAN_MM, 1e-9),
    `nn ${cp.nnMm.min.toFixed(6)} .. ${cp.nnMm.max.toFixed(6)} mm over ${cp.nnMm.count} contacts`);

  /* A square lattice at pitch p covers to p/sqrt(2) - the centre of a cell -
     and this flat region hits that bound exactly, measured over a sample grid
     fine enough to land in the middle of a cell. A coarser sample set (the
     two triangles' corners and centroids, six points) would have reported
     1.07 mm, which is the covering where it is BEST. */
  check('the covering is measured off the region and lands exactly on pitch/sqrt(2)',
    cp.coverageMm <= cp.coveringRadiusMm + 1e-9 &&
    near(cp.coverageMm, ST.MAX_SPAN_MM / Math.SQRT2, 1e-3),
    `worst uncovered ${cp.coverageMm.toFixed(4)} mm, radius ${cp.coveringRadiusMm.toFixed(4)} mm ` +
    `over ${cp.samples} samples`);

  /* Symmetry: the lattice is centred, so a region symmetric about its own
     centre gets contacts symmetric about it too. Anchored at min-x it would
     not, and a mirrored piece would get a different tree. */
  const cx = (regSHELF.min[0] + regSHELF.max[0]) / 2;
  const xs = cp.points.map(p => p.p[0] - cx).sort((a, b) => a - b);
  let sym = true;
  for (let i = 0; i < xs.length; i++) if (!near(xs[i], -xs[xs.length - 1 - i], 1e-6)) sym = false;
  check('the centred lattice is symmetric about the region\'s own centre', sym,
    `x offsets ${xs.slice(0, 4).map(v => v.toFixed(3)).join(', ')} ...`);

  /* Every contact is ON the region - the whole reason the site is projected
     onto a flagged triangle rather than dropped at the bbox height. */
  let onSurface = 0;
  for (const p of cp.points) if (near(p.p[2], 16, 1e-6)) onSurface++;
  check('every contact sits on the region, not on its bounding box',
    onSurface === cp.points.length, `${onSurface} of ${cp.points.length} at z = 16`);
}

{
  const detTINY = SA.detectOverhangs(TINY, { skipList: [] });
  const cp = ST.contactPoints(TINY, detTINY.regions[0], { skipList: [] });
  check('a region narrower than one span gets exactly one contact, at its centre',
    cp.ok && cp.points.length === 1 && near(cp.points[0].p[0], 11, 1e-6) &&
    near(cp.points[0].p[1], 5, 1e-6), cp.reason);
}

{
  /* The guard is a refusal by name, not a silent cap. */
  const cp = ST.contactPoints(SHELF, regSHELF, { skipList: [], maxSpanMm: 0.01 });
  check('an absurd span is refused by name rather than yielding thousands of contacts',
    !cp.ok && /guard/.test(cp.reason), cp.reason);

  const bad = ST.contactPoints(SHELF, regSHELF, { skipList: [], maxSpanMm: -1 });
  check('a negative span is refused', !bad.ok && /must be positive/.test(bad.reason), bad.reason);

  const noRegion = ST.contactPoints(SHELF, null, { skipList: [] });
  check('contactPoints without a region says which module owns the region',
    !noRegion.ok && /detectOverhangs/.test(noRegion.reason), noRegion.reason);
}

console.log('\n=== 2. THE SPLIT POINT: as high as the fan allows, and no higher ===');

const planSHELF = ST.planTree(SHELF, { skipList: [] });
{
  check('the shelf plans a tree', planSHELF.ok, planSHELF.reason);

  const sp = planSHELF.split;
  check('the widest branch is AT the limit, which is what "as high as it can" means',
    sp.widestDeg <= ST.BRANCH_TILT_DEG + 1e-9 &&
    sp.widestDeg >= ST.BRANCH_TILT_DEG - 2 * sp.splitResolutionMm,
    `widest ${sp.widestDeg.toFixed(4)} deg, limit ${ST.BRANCH_TILT_DEG}, ` +
    `scan resolution ${sp.splitResolutionMm.toFixed(6)} mm`);

  /* One station higher and the fan is outside the limit. That is the gate
     that says the scan found the top of the feasible range rather than any
     old feasible point. */
  const higher = ST.splitPoint(planSHELF.base.from, planSHELF.apex, planSHELF.contacts.points,
    { stations: 4096 });
  check('a finer scan lands on the same split to within its own resolution',
    near(higher.trunkMm, sp.trunkMm, sp.splitResolutionMm + higher.splitResolutionMm),
    `${sp.trunkMm.toFixed(6)} mm at ${sp.splitResolutionMm.toFixed(6)} mm vs ` +
    `${higher.trunkMm.toFixed(6)} mm at ${higher.splitResolutionMm.toFixed(6)} mm`);

  check('the split point reports where it is on the trunk line, as a fraction',
    sp.trunkFraction > 0 && sp.trunkFraction < 1,
    `${(sp.trunkFraction * 100).toFixed(1)}% of ${sp.apexMm.toFixed(3)} mm`);

  /* The ceiling is nso_support_aim.js's own printable angle, read from it. */
  const past = ST.splitPoint(planSHELF.base.from, planSHELF.apex, planSHELF.contacts.points,
    { branchTiltDeg: 46 });
  check('a tilt past the printable angle is refused by name, not clamped',
    !past.ok && /printable angle/.test(past.reason), past.reason);
  check('the ceiling is read from nso_support_aim.js rather than restated here',
    past.reason.indexOf(String(SA.ANGLE_DEFAULT_DEG)) >= 0, `${SA.ANGLE_DEFAULT_DEG} deg`);
}

{
  /* The 20 x 10 cantilever at 16 mm is wider than one trunk can fan to. That
     is the right answer and the reference agrees with it - the real 70 mm
     tabletop used 36 trunks - so the refusal names the number instead of
     going quiet. */
  const r = ST.planTree(CANTILEVER, { skipList: [] });
  check('a fan too wide for one trunk is refused, at the split stage',
    !r.ok && r.stage === 'split' && /cannot serve this fan/.test(r.reason), r.reason);
  check('the refusal says how many trunks the region would take',
    r.trunksNeeded >= 2, `${r.trunksNeeded} trunks`);

  /* Same arm, 6 mm more rise, and the same fan now fits. Nothing about the
     region changed but the height it hangs at, which is the quantity the
     tilt bound is actually about. */
  const t = ST.planTree(TALL, { skipList: [] });
  check('the same 20 x 10 arm carried 6 mm higher plans a tree',
    t.ok && t.branches.length === 28, t.ok ? `${t.branches.length} branches` : t.reason);
}

console.log('\n=== 3. THE BRANCHES: one per contact, on the trunk\'s own cross-section ===');

{
  const p = planSHELF;
  check('one branch per contact point, none left over',
    p.branches.length + p.blocked.length + (p.trunkCarriesContact >= 0 ? 1 : 0) ===
      p.contacts.points.length,
    `${p.branches.length} built, ${p.blocked.length} blocked, ` +
    `${p.contacts.points.length} contacts`);

  check('every branch ends exactly on its own contact point',
    p.branches.every(b => {
      const q = p.contacts.points[b.contactIndex].p;
      return Math.hypot(b.tip[0] - q[0], b.tip[1] - q[1], b.tip[2] - q[2]) < 1e-5;
    }), `${p.branches.length} branches`);

  check('no two branches end on the same contact',
    new Set(p.branches.map(b => b.contactIndex)).size === p.branches.length,
    `${new Set(p.branches.map(b => b.contactIndex)).size} distinct contacts`);

  check('every branch carries the trunk\'s cross-section, to the millimetre it was floored at',
    p.branches.every(b => b.sideMm === p.trunk.sideMm),
    `side ${p.trunk.sideMm} mm, floor ${p.trunk.floorMm} mm`);

  check('every branch is inside the tilt the split point was computed for',
    p.branches.every(b => b.tiltDeg <= ST.BRANCH_TILT_DEG + 1e-9),
    `${p.tiltDeg.min.toFixed(2)} .. ${p.tiltDeg.max.toFixed(2)} deg off vertical`);

  /* The sweep's own evidence, per branch: one segment, no joints, so the
     mitre never ran and the seam gate had nothing to measure. */
  check('each branch is ONE segment - the mitre arithmetic never runs',
    p.branches.every(b => b.sweep.stats.rings === 2 && b.sweep.stats.maxTurnDeg === 0),
    `${p.branches[0].sweep.stats.rings} rings, max turn ${p.branches[0].sweep.stats.maxTurnDeg} deg`);

  /* 2 x M per segment for the walls and M per cap, M = 4 for a square: the
     sweep fans each cap from the path endpoint rather than splitting it in
     two, which is what lets the endpoint be inside its own ring. */
  check('each branch is 16 triangles: 2 x 4 wall, 4 + 4 cap fans',
    p.branches.every(b => b.soup.length / 9 === 16), `${p.branches[0].soup.length / 9}`);

  /* The flat cap overshoot, bracketed by its own closed form. The cap is a
     square perpendicular to the branch; whichever way the sweep's frame put
     it about the axis, the extreme point is between the edge midpoint
     (side/2) and the corner (side/sqrt(2)) out. nso_support_aim.js pins the
     edge-midpoint case exactly for the strut; here the frame comes from
     NSO_PathSweep's transport, so the bracket is the honest statement. */
  let bracketed = 0;
  for (const b of p.branches) {
    const s = Math.sin(b.tiltDeg * Math.PI / 180);      /* the region's normal is -Z */
    const lo = (b.sideMm / 2) * s - 1e-6;
    const hi = (b.sideMm / Math.SQRT2) * s + 1e-6;
    if (b.tipPenetrationMm >= lo && b.tipPenetrationMm <= hi) bracketed++;
  }
  check('every branch\'s cap overshoot is inside [side/2, side/sqrt(2)] x sin(tilt)',
    bracketed === p.branches.length,
    `${bracketed} of ${p.branches.length}, worst ${p.worstTipPenetrationMm.toFixed(6)} mm`);
}

console.log('\n=== 4. THE RAILS CATCH WHAT THE CENTRE LINE MISSES ===');

{
  /* A branch threading a gap narrower than itself: clear down the centre
     line, solid through the wall. Built AROUND a branch this planner really
     produced - a horizontal plate across it with a 0.8 mm square window
     centred exactly on its axis. The axis goes through the window; the rails,
     0.6 mm out, do not. This is the case the axis-only test cannot see, and
     it is why the clearance probe casts the rails as well. */
  const base = planSHELF;
  const b0 = base.branches[base.branches.length - 1];
  const tMid = b0.lengthMm / 2;
  const M = [b0.from[0] + b0.dir[0] * tMid,
             b0.from[1] + b0.dir[1] * tMid,
             b0.from[2] + b0.dir[2] * tMid];
  /* The plate is only 3 mm across, so it sits in this one branch's way and
     nowhere near the trunk's own line - a wall big enough to block the trunk
     would be testing nearestBase instead. */
  const halfWin = 0.4, zLo = M[2] - 0.25, zHi = M[2] + 0.25, R = 1.5;
  const WALL = soupOf(
    box([M[0] - R, M[1] - R, zLo], [M[0] + R, M[1] - halfWin, zHi]),
    box([M[0] - R, M[1] + halfWin, zLo], [M[0] + R, M[1] + R, zHi]),
    box([M[0] - R, M[1] - halfWin, zLo], [M[0] - halfWin, M[1] + halfWin, zHi]),
    box([M[0] + halfWin, M[1] - halfWin, zLo], [M[0] + R, M[1] + halfWin, zHi]));

  const axisHit = SA._nearestHit([WALL], b0.from, b0.dir, 1e-3, b0.lengthMm - 1e-3);
  check('the centre line goes clean through the 0.8 mm window',
    axisHit < 0, `axis hit ${axisHit}`);

  const p = ST.planTree(SHELF, { skipList: [], obstacles: [SHELF, WALL] });
  check('the plan still stands with the wall in the way', p.ok, p.reason);
  const stopped = p.blocked.filter(x => /^rail /.test(x.why));
  check('but branches whose rails meet the plate are refused, by rail and by distance',
    stopped.length > 0,
    stopped.slice(0, 2).map(x => `#${x.index}: ${x.why}`).join(' | ') ||
      'none blocked - the window let the whole branch through');
  check('and the contact that was threading the window is one of them',
    p.blocked.some(x => x.index === b0.contactIndex),
    `blocked contacts: ${p.blocked.map(x => x.index).join(', ')}`);
}

console.log('\n=== 5. A CONTACT ON THE TRUNK\'S AXIS IS THE TRUNK\'S ===');

{
  const p = ST.planTree(TAB, { skipList: [] });
  check('the centre contact is carried by the trunk, not built as a branch',
    p.trunkCarriesContact >= 0 &&
    !p.branches.some(b => b.contactIndex === p.trunkCarriesContact),
    `contact #${p.trunkCarriesContact}`);

  check('the trunk therefore grows past its split point, to that contact',
    p.trunk.lengthMm > p.split.trunkMm + 1e-6,
    `trunk ${p.trunk.lengthMm.toFixed(3)} mm, split at ${p.split.trunkMm.toFixed(3)} mm`);

  check('and it ends on the contact itself',
    Math.abs(p.trunk.tip[2] - p.contacts.points[p.trunkCarriesContact].p[2]) < 1e-4,
    `tip z ${p.trunk.tip[2].toFixed(5)}, contact z ` +
    `${p.contacts.points[p.trunkCarriesContact].p[2].toFixed(5)}`);

  check('the lattice on an 8 mm region is 3 x 3, so a site lands on the aim',
    p.contacts.latticeNx === 3 && p.contacts.latticeNy === 3 && p.contacts.points.length === 9,
    `${p.contacts.latticeNx} x ${p.contacts.latticeNy}, ${p.contacts.points.length} contacts`);

  check('the single-contact region needs no split at all: it IS the straight strut',
    (() => { const t = ST.planTree(TINY, { skipList: [] });
             return t.ok && t.single === true && t.branches.length === 0 && t.parts.length === 1; })(),
    ST.describe(ST.planTree(TINY, { skipList: [] })));
}

console.log('\n=== 6. WHAT IT REFUSES TO DO WITHOUT ===');

{
  const noSweep = ST.branch([0, 0, 0], [1, 1, 10], { sideMm: 1.2, pathSweep: null });
  const savedPS = ctx.NSO_PathSweep;
  ctx.NSO_PathSweep = undefined;
  const reallyNoSweep = ST.branch([0, 0, 0], [1, 1, 10], { sideMm: 1.2 });
  ctx.NSO_PathSweep = savedPS;
  check('with no nso_path_sweep.js a branch refuses, and says why Extend cannot do it',
    !reallyNoSweep.ok && /off-cardinal axis/.test(reallyNoSweep.reason), reallyNoSweep.reason);

  const savedSA = ctx.NSO_SupportAim;
  ctx.NSO_SupportAim = undefined;
  const noAim = ST.planTree(SHELF, { skipList: [] });
  ctx.NSO_SupportAim = savedSA;
  check('with no nso_support_aim.js the whole plan refuses rather than re-detecting',
    !noAim.ok && /nso_support_aim\.js is not loaded/.test(noAim.reason), noAim.reason);

  check('a branch with no cross-section refuses rather than defaulting one',
    !ST.branch([0, 0, 0], [1, 1, 10], {}).ok,
    ST.branch([0, 0, 0], [1, 1, 10], {}).reason);

  /* detectOverhangs's paint contract is inherited whole, not re-decided. */
  const noSkip = ST.planTree(SHELF, {});
  check('opts.skipList is still REQUIRED - the paint contract is inherited whole',
    !noSkip.ok && /skipList/.test(noSkip.reason), noSkip.reason);
}

console.log('\n=== 7. THE PIECE IS READ, NEVER WRITTEN ===');

const CASES = [['shelf', SHELF], ['tall', TALL], ['tab', TAB], ['tiny', TINY]];
for (const [name, host] of CASES) {
  const before = Buffer.from(new Float32Array(host).buffer);
  ST.planTree(host, { skipList: [] });
  const after = Buffer.from(new Float32Array(host).buffer);
  check(`${name}: the host soup is byte-identical after planTree()`,
    before.equals(after), `${before.length} bytes`);
}

console.log('\n=== 7b. GECKO HAND: a different tip, and the same tree ===');

/* The 'gecko-hand' style may change what a contact's tip LOOKS like and
   nothing else. So every number the default plan decides - the contacts,
   the split, the trunk, each branch's root, heading, length and tilt, what
   was refused - is compared here EXACTLY, not to a tolerance: the style is
   read after all of it is settled, so any difference at all is a bug. */
const sameVec = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameBytes = (a, b) => Buffer.from(new Float32Array(a).buffer)
  .equals(Buffer.from(new Float32Array(b).buffer));

function parity(name, host, extra) {
  const base = Object.assign({ skipList: [] }, extra || {});
  const d = ST.planTree(host, base);
  const g = ST.planTree(host, Object.assign({}, base, { branchStyle: 'gecko-hand' }));
  check(`${name}: both styles plan, or neither does`, d.ok === g.ok && d.ok,
    `square: ${d.ok}, gecko-hand: ${g.ok}` + (g.ok ? '' : ' - ' + g.reason));
  if (!d.ok || !g.ok) return null;

  check(`${name}: the same contact points, count and placement, exactly`,
    d.contacts.points.length === g.contacts.points.length &&
    d.contacts.points.every((c, i) => sameVec(c.p, g.contacts.points[i].p) &&
                                      c.source === g.contacts.points[i].source),
    `${g.contacts.points.length} contacts, coverage ${g.contacts.coverageMm.toFixed(4)} mm`);

  check(`${name}: the same trunk, byte for byte, from the same base to the same split`,
    sameBytes(d.trunk.soup, g.trunk.soup) && sameVec(d.trunk.tip, g.trunk.tip) &&
    (d.split ? d.split.trunkMm === g.split.trunkMm && sameVec(d.split.point, g.split.point)
             : !g.split) &&
    d.trunkCarriesContact === g.trunkCarriesContact,
    d.split ? `split ${g.split.trunkMm.toFixed(6)} mm, trunk ${g.trunk.lengthMm.toFixed(6)} mm`
            : `single strut, ${g.trunk.lengthMm.toFixed(6)} mm`);

  check(`${name}: the same branches - count, contact, root, heading, length, tilt`,
    d.branches.length === g.branches.length &&
    d.branches.every((b, i) => {
      const e = g.branches[i];
      return b.contactIndex === e.contactIndex && sameVec(b.from, e.from) &&
             sameVec(b.tip, e.tip) && sameVec(b.dir, e.dir) &&
             b.lengthMm === e.lengthMm && b.tiltDeg === e.tiltDeg && b.sideMm === e.sideMm;
    }),
    `${g.branches.length} branches, ${g.tiltDeg ? g.tiltDeg.min.toFixed(2) + '..' +
      g.tiltDeg.max.toFixed(2) + ' deg' : 'none'}`);

  check(`${name}: the same contacts refused, for the same reasons`,
    (d.blocked || []).length === (g.blocked || []).length &&
    (d.blocked || []).every((b, i) => b.index === g.blocked[i].index && b.why === g.blocked[i].why),
    `${(g.blocked || []).length} refused`);

  check(`${name}: each shaft is the default branch byte for byte - the flat cap included`,
    d.branches.every((b, i) => sameBytes(b.soup, g.branches[i].soup) &&
                               b.tipPenetrationMm === g.branches[i].tipPenetrationMm),
    `${g.branches.length} shafts`);

  /* The fold is left to right, so the default's parts leading the list, in
     the default's order, is what makes the default's union a prefix of this
     one - see planTree, THE FINGERS GO ON AFTER EVERY SHAFT. */
  check(`${name}: the default's parts lead the list, in the default's order`,
    d.parts.every((p, i) => sameBytes(p, g.parts[i])) &&
    g.parts.length === d.parts.length + g.fingers,
    `${d.parts.length} default part(s), then ${g.fingers} finger(s)`);

  /* Every contact point has a hand: each branch's, and the trunk's own when
     it ends on one. */
  const hands = g.branches.map(b => ({ hand: b.hand, end: b.tip }));
  if (g.single || g.trunkCarriesContact >= 0) hands.push({ hand: g.trunkHand, end: g.trunk.tip });
  const contactsHeld = g.branches.length + ((g.single || g.trunkCarriesContact >= 0) ? 1 : 0);
  check(`${name}: one hand per contact point held, and no hand anywhere else`,
    hands.length === contactsHeld && hands.every(h => h.hand && h.hand.ok) &&
    (g.single || g.trunkCarriesContact >= 0 ? !!g.trunkHand : !g.trunkHand),
    `${hands.length} hands over ${contactsHeld} contacts`);

  let bad = [];
  let kept = 0, dropped = 0;
  for (const { hand, end } of hands) {
    kept += hand.fingers.length; dropped += hand.dropped.length;
    if (hand.fingers.length + hand.dropped.length !== ST.GECKO.FINGERS) bad.push('finger count');
    if (!(hand.widthMm >= g.trunk.floorMm)) bad.push('width under the floor');
    for (const f of hand.fingers) {
      const r = [f.to[0] - end[0], f.to[1] - end[1], f.to[2] - end[2]];
      const out = Math.hypot(r[0], r[1], r[2]);
      const off = r[0] * hand.normal[0] + r[1] * hand.normal[1] + r[2] * hand.normal[2];
      if (!near(out, hand.reachMm, 1e-9)) bad.push(`finger ${f.index} reaches ${out}`);
      if (!near(off, 0, 1e-9)) bad.push(`finger ${f.index} is ${off} off the surface plane`);
      if (!(f.sweep.stats.rings === 2 && f.sweep.stats.maxTurnDeg === 0)) bad.push('a finger with a joint');
      if (f.soup.length / 9 !== 2 * 6 + 6 + 6) bad.push(`finger ${f.index} is ${f.soup.length / 9} tris`);
    }
  }
  check(`${name}: every finger is one hexagonal segment, ending ON the surface plane at the reach`,
    bad.length === 0,
    bad.length ? bad.slice(0, 3).join('; ')
               : `${kept} kept, ${dropped} left off; ${hands[0].hand.widthMm.toFixed(3)} mm across ` +
                 `(floor ${g.trunk.floorMm} mm), reach ${hands[0].hand.reachMm.toFixed(3)} mm`);

  check(`${name}: the plan's finger tally is the hands' own`,
    g.fingers === kept && g.fingersDropped === dropped, `${g.fingers} + ${g.fingersDropped}`);
  return { d, g };
}

for (const [name, host] of [['shelf', SHELF], ['tall', TALL], ['tab', TAB], ['tiny', TINY]]) {
  parity(name, host);
}

{
  /* Section 4's wall, planned both ways: the rail refusals are the default's
     exactly, because the shaft is tested before a finger exists. */
  const b0 = planSHELF.branches[planSHELF.branches.length - 1];
  const tMid = b0.lengthMm / 2;
  const M = [0, 1, 2].map(k => b0.from[k] + b0.dir[k] * tMid);
  const halfWin = 0.4, zLo = M[2] - 0.25, zHi = M[2] + 0.25, R = 1.5;
  const WALL = soupOf(
    box([M[0] - R, M[1] - R, zLo], [M[0] + R, M[1] - halfWin, zHi]),
    box([M[0] - R, M[1] + halfWin, zLo], [M[0] + R, M[1] + R, zHi]),
    box([M[0] - R, M[1] - halfWin, zLo], [M[0] - halfWin, M[1] + halfWin, zHi]),
    box([M[0] + halfWin, M[1] - halfWin, zLo], [M[0] + R, M[1] + halfWin, zHi]));
  parity('shelf + wall', SHELF, { obstacles: [SHELF, WALL] });
}

{
  const exp = ST.planTree(SHELF, { skipList: [], branchStyle: 'square' });
  check('naming the default style explicitly is the default, part for part',
    exp.ok && exp.parts.length === planSHELF.parts.length &&
    exp.parts.every((p, i) => sameBytes(p, planSHELF.parts[i])) && exp.fingers === undefined,
    `${exp.parts.length} parts`);

  const unk = ST.planTree(SHELF, { skipList: [], branchStyle: 'gecko' });
  check('an unknown style is refused by name, before anything is planned',
    !unk.ok && /unknown branchStyle/.test(unk.reason) && /gecko-hand/.test(unk.reason), unk.reason);
  const unkB = ST.branch([0, 0, 0], [1, 1, 10], { sideMm: 1.2, branchStyle: 'claw' });
  check('and so is one handed to branch() directly', !unkB.ok && /unknown branchStyle/.test(unkB.reason),
    unkB.reason);

  /* The fingers the post is in the way of are left off, and the tip keeps
     its contact: the shelf's inner column heads back toward the post. */
  const g = ST.planTree(SHELF, { skipList: [], branchStyle: 'gecko-hand' });
  const lost = [].concat(...g.branches.map(b => b.hand.dropped));
  check('a finger that would run into the piece is left off, and says where',
    lost.length > 0 && lost.every(x => /^finger \d: (the axis|rail \d) is blocked/.test(x.why)) &&
    g.branches.every(b => b.parts.length === 1 + b.hand.fingers.length),
    lost.length ? `${lost.length} left off, e.g. ${lost[0].why}` : 'none - the post was not in the way');

  /* A finger's root cap has to be inside the shaft, not just its centre -
     see GECKO.ROOT_SIDES. A floor that forces a finger this wide is refused
     by name rather than built poking out through the wall. */
  const fat = ST._geckoHand([0, 0, 10], [0, 0, 1], 1.2, { floorMm: 0.9, normal: [0, 0, -1] });
  check('a finger too wide to start inside its shaft is refused by name',
    !fat.ok && /cannot start inside/.test(fat.reason), fat.reason);
  const fits = ST._geckoHand([0, 0, 10], [0, 0, 1], 1.2, { floorMm: 0.42, normal: [0, 0, -1] });
  check('and at the shipped proportions every root cap is inside the shaft',
    fits.ok && ST.GECKO.ROOT_SIDES * 1.2 + fits.widthMm / Math.sqrt(3) < 0.6 && fits.fullCircle,
    `${(ST.GECKO.ROOT_SIDES * 1.2 + fits.widthMm / Math.sqrt(3)).toFixed(4)} mm of a 0.6 mm half-width; ` +
    `a vertical tip gets the full circle`);

  check('the hand\'s fingertip overshoot is measured and reported, like the cap\'s',
    g.branches.every(b => b.fingerPenetrationMm >= 0 && b.fingerPenetrationMm <= b.hand.widthMm),
    `worst ${Math.max(...g.branches.map(b => b.fingerPenetrationMm)).toFixed(4)} mm; ` +
    `flat cap ${g.worstTipPenetrationMm.toFixed(4)} mm`);
}

console.log('\n=== 8. THE UNION: the app\'s own boolean, and nothing else ===');

(async () => {
  const noUnion = await ST.unionParts([new Float32Array(9), new Float32Array(9)],
    { unionSoups: null });
  check('with no app-join.js the union refuses by name rather than concatenating',
    !noUnion.ok && /NSO_unionSoups/.test(noUnion.reason), noUnion.reason);

  const csg = csgContext();
  fs.mkdirSync(OUT, { recursive: true });

  const RUNS = [];
  for (const [name, host] of CASES) {
    RUNS.push([name, host, {}]);
    RUNS.push([name + '_gecko', host, { branchStyle: 'gecko-hand' }]);
  }
  for (const [name, host, style] of RUNS) {
    const p = ST.planTree(host, Object.assign({ skipList: [] }, style));
    if (!p.ok) { check(`${name}: plans`, false, p.reason); continue; }

    /* Every step is a genuine merge. NSO_unionSoups only reports ok when the
       part count FELL, so a branch that missed the trunk would be caught here
       rather than quietly added as a second shell. */
    let acc = p.parts[0], merged = 0, oneShell = true;
    for (let i = 1; i < p.parts.length; i++) {
      const u = await csg.NSO_unionSoups(acc, p.parts[i]);
      if (!u.ok) break;
      merged++;
      if (u.parts !== 1) oneShell = false;
      acc = u.soup;
    }
    check(`${name}: every branch genuinely merges into the trunk`,
      merged === p.parts.length - 1,
      `${merged} of ${p.parts.length - 1} steps`);
    check(`${name}: and the kernel calls the result one shell at every step`,
      oneShell, 'parts = 1 throughout');

    const whole = await ST.unionParts(p.parts, { unionSoups: csg.NSO_unionSoups });
    check(`${name}: unionParts folds left and gets the same solid`,
      whole.ok && whole.soup.length === acc.length, whole.reason);

    writeSTL(path.join(OUT, name + '.stl'), whole.soup, 'NSO support tree ' + name);
    writeSTL(path.join(OUT, name + '_host.stl'), host, 'NSO support tree host ' + name);
    /* The parts on their own, so the canonical checker can say whether a
       branch is a clean solid separately from what the boolean did with it. */
    writeSTL(path.join(OUT, name + '_trunk.stl'), p.trunk.soup, 'NSO trunk ' + name);
    if (p.branches.length) {
      writeSTL(path.join(OUT, name + '_branch0.stl'), p.branches[0].soup, 'NSO branch ' + name);
    }
    /* And one finger, for the same reason: a hand is only as clean as the
       sweeps it is made of. The first kept finger of the first hand. */
    const hands = p.branches.map(b => b.hand).concat(p.trunkHand ? [p.trunkHand] : [])
      .filter(h => h && h.fingers.length);
    if (hands.length) {
      writeSTL(path.join(OUT, name + '_finger0.stl'), hands[0].fingers[0].soup, 'NSO finger ' + name);
    }
    let fingerVolumeMm3 = 0;
    for (const h of hands) for (const f of h.fingers) fingerVolumeMm3 += h.sectionAreaMm2 * f.lengthMm;
    fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify({
      contacts: p.contacts.points.length,
      lattice: p.contacts.lattice,
      topUp: p.contacts.topUp,
      pitchMm: p.contacts.pitchMm,
      coverageMm: p.contacts.coverageMm,
      branches: p.branches.length,
      blocked: p.blocked ? p.blocked.length : 0,
      sideMm: p.sideMm,
      trunkMm: p.trunk.lengthMm,
      splitMm: p.split ? p.split.trunkMm : null,
      trunkFraction: p.split ? p.split.trunkFraction : null,
      tiltDeg: p.tiltDeg || null,
      branchLengthMm: p.branchLengthMm || null,
      worstTipPenetrationMm: p.worstTipPenetrationMm == null ? null : p.worstTipPenetrationMm,
      style: p.style,
      fingers: p.fingers || 0,
      fingersDropped: p.fingersDropped || 0,
      fingerSectionMm2: hands.length ? hands[0].sectionAreaMm2 : null,
      fingerVolumeMm3: fingerVolumeMm3,
      parts: p.parts.length,
      unionTris: (whole.soup.length / 9) | 0
    }, null, 2) + '\n');
    console.log(`  wrote ${name}.stl (${(whole.soup.length / 9) | 0} tris from ` +
      `${p.parts.length} parts) and ${name}_host.stl`);
  }

  console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
  if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }
})().catch(err => { console.error(err); process.exit(1); });
