#!/usr/bin/env node
// Headless self-test for nso_support_tree.js: the contact points an overhang
// actually needs, the branch and gecko-hand primitives, the refusals, and the
// union - with planTree now the grid-pack planner (nso_support_gridpack.js).
//
// CHANGED with the grid-pack planner (docs/SUPPORT-GRIDPACK.md). Sections 2
// (the split point), 3 (the fan of branches), 4 (the rails on a branch) and
// 5 (the contact on the trunk's axis) pinned the trunk-first planSolid, which
// is replaced: splitPoint is gone with it. They are rewritten below to ask
// the same questions of the planner that replaced it - every contact held,
// the rails (not just the axis) tested, the gecko style changing only the
// tips - and section 8 still unions every plan through the shipped kernel
// and writes what tools/nso_support_tree_canonical_check.js validates.
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
// The contact counts are counted rather than predicted.

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
                 'app-extend.js', 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js',
                 'nso_support_tree.js', 'nso_support_gridpack.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
/* branch() is asked of the SQUARE section by name: its 16-triangle and
   side^2 x length facts are about that section. The planner's members are
   square anyway (docs/SUPPORT-GRIDPACK.md). */
const ST_SHIPPED = ctx.NSO_SupportTree;
const ST = Object.assign({}, ST_SHIPPED, {
  branch: (a, b, o) => ST_SHIPPED.branch(a, b, Object.assign({ section: 'square' }, o))
});
const GP = ctx.NSO_SupportGridpack;
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


console.log('\n=== 2. THE PLAN: every contact held, every member to the plate ===');

const planSHELF = ST.planTree(SHELF, { skipList: [] });
{
  check('planTree is the grid-pack planner', planSHELF.planner === 'gridpack' && planSHELF.ok, planSHELF.reason);
  check('its support points are the contact points of section 1, in the same count',
    planSHELF.beacons.length === 16, `${planSHELF.beacons.length}`);
  check('every one is held, on trunks that all land on the plate',
    planSHELF.held === 16 && planSHELF.trunks.every(t => t.landing === 'plate'), planSHELF.reason);
  /* Where the trunk-first planner refused the 20 x 10 cantilever (one trunk
     could not serve that fan), the grid-pack planner holds it. */
  const r = ST.planTree(CANTILEVER, { skipList: [] });
  check('the cantilever the trunk-first planner refused is held now', r.ok && r.held === r.beacons.length, r.reason);
  const t = ST.planTree(TALL, { skipList: [] });
  check('the tall arm: all 28 contacts held', t.ok && t.held === 28, t.reason);
}

console.log('\n=== 3. ONE STRUT PER CONTACT, ON THE STRUT\'S OWN SECTION ===');
{
  const p = planSHELF;
  const starts = p.members.filter(m => m.kind === 'beacon' || m.kind === 'side');
  check('one member starts at each contact, and no contact twice',
    starts.length === 16 && new Set(starts.map(m => m.beacon)).size === 16, `${starts.length} members`);
  check('a single contact\'s strut is buildStrut\'s side, never under the floor',
    starts.every(m => m.side === p.sideMm) && p.sideMm >= p.floorMm, `${p.sideMm} mm, floor ${p.floorMm} mm`);
  const lean = Math.max(...p.members.map(m => {
    let w = 0;
    for (let i = 0; i + 1 < m.path.length; i++) {
      const a = m.path[i], b = m.path[i + 1];
      w = Math.max(w, Math.atan2(Math.hypot(b[0] - a[0], b[1] - a[1]), Math.abs(b[2] - a[2])) * 180 / Math.PI);
    }
    return w;
  }));
  check('no leg leans past the branch limit', lean <= ST.BRANCH_TILT_DEG + 1e-9,
    `${lean.toFixed(2)} deg against ${ST.BRANCH_TILT_DEG}`);
  const single = ST.planTree(TINY, { skipList: [] });
  /* 1 mm from the post: the strut's rails (its circumscribed circle plus
     CLEAR_MM) would graze the post, so it leans away once, then drops. */
  const sm = single.members[0], foot = sm.path[sm.path.length - 1];
  check('a region one contact wide is one strut - one member, one trunk - to the plate, clear of the post',
    single.ok && single.members.length === 1 && single.trunks.length === 1 && foot[2] === single.plateZ &&
    sm.path.every(q => q[0] - 10 >= sm.side / Math.SQRT2 + GP.CLEAR_MM - 1e-9 || q === sm.path[0]),
    single.reason + `; ${sm.path.length - 1} leg(s)` + (single.steered.length ? ', leaning off the post first' : ''));
}

console.log('\n=== 4. THE RAILS CATCH WHAT THE CENTRE LINE MISSES ===');
{
  /* A 0.5 mm plate under the tiny tab's strut with a 0.8 mm square window
     centred exactly on its axis: the axis goes clean through, the 1.2 mm
     strut does not - so the planner must not send it through the window. */
  const s0 = ST.planTree(TINY, { skipList: [] }).members[0].path[0];
  const z = 6, h = 0.4, R = 3;
  const WALL = soupOf(
    box([s0[0] - R, s0[1] - R, z], [s0[0] + R, s0[1] - h, z + 0.5]),
    box([s0[0] - R, s0[1] + h, z], [s0[0] + R, s0[1] + R, z + 0.5]),
    box([s0[0] - R, s0[1] - h, z], [s0[0] - h, s0[1] + h, z + 0.5]),
    box([s0[0] + h, s0[1] - h, z], [s0[0] + R, s0[1] + h, z + 0.5]));
  check('the axis alone reads the window clear',
    SA.lineBlockedAt([TINY, WALL], s0, [0, 0, -1], s0[2]) === -1);
  const p = ST.planTree(TINY, { skipList: [], occluders: [WALL] });
  const m = p.members[0];
  const through = m.path.some((q, i) => i + 1 < m.path.length && Math.abs(q[0] - s0[0]) < 1e-9 && Math.abs(q[1] - s0[1]) < 1e-9 &&
    Math.abs(m.path[i + 1][0] - s0[0]) < 1e-9 && m.path[i + 1][2] < z);
  check('the rails see the window too narrow: the strut does not go through it',
    p.ok && !through, p.reason + (p.steered.length ? `; steered to [${p.steered[0].to.map(v => v.toFixed(2))}]` : ''));
}

console.log('\n=== 6. WHAT IT REFUSES TO DO WITHOUT ===');

{
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
    !noAim.ok && /nso_support_aim\.js/.test(noAim.reason), noAim.reason);

  const savedGP = ctx.NSO_SupportGridpack;
  ctx.NSO_SupportGridpack = undefined;
  const noGP = ST.planTree(SHELF, { skipList: [] });
  ctx.NSO_SupportGridpack = savedGP;
  check('with no nso_support_gridpack.js planTree refuses by name - there is no second planner',
    !noGP.ok && /nso_support_gridpack\.js/.test(noGP.reason), noGP.reason);

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

console.log('\n=== 7b. GECKO HAND: a different tip, and the same plan ===');

const sameVec = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
for (const [name, host] of CASES) {
  const d = ST.planTree(host, { skipList: [] });
  const g = ST.planTree(host, { skipList: [], branchStyle: 'gecko-hand' });
  check(`${name}: both styles plan`, d.ok && g.ok, d.reason + ' / ' + g.reason);
  check(`${name}: gecko-hand plans exactly the default's members, merges and trunks`,
    d.members.length === g.members.length &&
    d.members.every((m, i) => m.count === g.members[i].count && m.path.length === g.members[i].path.length &&
      m.path.every((q, k) => sameVec(q, g.members[i].path[k]))) &&
    JSON.stringify(d.merges) === JSON.stringify(g.merges) && JSON.stringify(d.trunks) === JSON.stringify(g.trunks),
    `${g.members.length} members, ${g.merges.length} merges, ${g.trunks.length} trunks`);
}
{
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
  const unk = ST.planTree(SHELF, { skipList: [], style: 'claw' });
  check('an unknown style is refused by name, before anything is planned',
    !unk.ok && /unknown support style/.test(unk.reason), unk.reason);
  const unkB = ST.branch([0, 0, 0], [1, 1, 10], { sideMm: 1.2, branchStyle: 'claw' });
  check('and so is one handed to branch() directly', !unkB.ok && /unknown branchStyle/.test(unkB.reason),
    unkB.reason);
}

console.log('\n=== 8. THE UNION: the app\'s own boolean, and nothing else ===');

(async () => {
  const noUnion = await ST.unionParts([new Float32Array(9), new Float32Array(9)],
    { unionSoups: null });
  check('with no app-join.js the union refuses by name rather than concatenating',
    !noUnion.ok && /NSO_unionSoups/.test(noUnion.reason), noUnion.reason);
  const noU = await GP.solid(planSHELF, { unionSoups: null });
  /* GP.solid falls back to the global; in this context there is none. */
  check('nor does the planner\'s solid() build without it',
    !noU.ok && /NSO_unionSoups/.test(noU.reason), noU.reason);

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
    const s = await GP.solid(p, { unionSoups: csg.NSO_unionSoups });
    check(`${name}: every part of every trunk genuinely merges - nothing detached`,
      s.ok && s.detached === 0, s.ok ? `${s.solids.length} solid(s) from ${p.trunks.length} trunk(s)` : s.reason);
    if (!s.ok) continue;

    writeSTL(path.join(OUT, name + '.stl'), s.soup, 'NSO support ' + name);
    writeSTL(path.join(OUT, name + '_host.stl'), host, 'NSO support host ' + name);
    /* Two members on their own, so the canonical checker can say whether a
       swept member is a clean solid separately from what the boolean did:
       the first trunk's landing column, and the first contact's strut. */
    const P = ctx.NSO_PathSweep, root = p.members[p.trunks[0].root];
    const strut = p.members.find(m => m.kind === 'beacon' && m.path.length >= 2);
    const sweepOf = m => P.sweep({ points: m.points, profile: [[-m.side / 2, -m.side / 2], [m.side / 2, -m.side / 2],
      [m.side / 2, m.side / 2], [-m.side / 2, m.side / 2]], up: [0, 1, 0] });
    const rs = sweepOf(root), bs = strut && strut !== root ? sweepOf(strut) : null;
    writeSTL(path.join(OUT, name + '_trunk.stl'), rs.tris, 'NSO trunk column ' + name);
    if (bs && bs.ok) writeSTL(path.join(OUT, name + '_branch0.stl'), bs.tris, 'NSO strut ' + name);
    const len = m => m.points.reduce((a, q, i) => i ? a + Math.hypot(q[0] - m.points[i - 1][0], q[1] - m.points[i - 1][1], q[2] - m.points[i - 1][2]) : 0, 0);
    let partsVolumeMm3 = 0;
    for (const m of p.members) if (!m.dead && m.points) partsVolumeMm3 += m.side * m.side * len(m);
    for (const st of p.stubs) partsVolumeMm3 += st.side * st.side * (Math.hypot(...[0, 1, 2].map(k => st.via[k] - st.from[k])) + Math.hypot(...[0, 1, 2].map(k => st.to[k] - st.via[k])) + p.sideMm);
    fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify({
      contacts: p.beacons.length,
      held: p.held,
      members: p.members.length,
      merges: p.merges.length,
      trunks: p.trunks.length,
      solids: s.solids.length,
      sideMm: p.sideMm,
      trunkSideMm: root.side,
      branchSideMm: bs && bs.ok ? strut.side : null,
      style: p.style,
      fingersDropped: s.fingersDropped,
      partsVolumeMm3: partsVolumeMm3,
      unionTris: (s.soup.length / 9) | 0
    }, null, 2) + '\n');
    console.log(`  wrote ${name}.stl (${(s.soup.length / 9) | 0} tris, ${s.solids.length} solid(s) from ` +
      `${p.trunks.length} trunk(s)) and ${name}_host.stl`);
  }

  console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
  if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }
})().catch(err => { console.error(err); process.exit(1); });
