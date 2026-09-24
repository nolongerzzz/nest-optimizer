#!/usr/bin/env node
// The hollow support tree: trunk and every branch as a tube at the nozzle
// floor, a solid fallback for any part too small to take one, and the
// canonical checker (tools/mesh_validate.py) on every result.
//
//   node tools/nso_support_tree_hollow_check.js         shelf, tab, tiny + sections 1-3
//   node tools/nso_support_tree_hollow_check.js --tall  the tall fixture, square tips
//   node tools/nso_support_tree_hollow_check.js --tall-gecko   ... gecko-hand tips
//                                                       exit 0 = every gate held
//
// Three invocations, three npm steps (tree:hollow, tree:hollow-tall,
// tree:hollow-tall-gecko), because the tall tree is the expensive one: its
// bores are ~69k triangles and the canonical checker's self-intersection
// pass over them alone takes ~26 s. Split, they pack into separate shards of
// tools/run-tests.mjs instead of one step longer than any other in the suite.
//
// One step rather than a test plus a separate canonical check, because the
// hollowing is the expensive part and a second step would only redo it.
// Writes tools/support-tree-out/<case>_hollow.stl.
//
// What is asserted, section by section:
//
//   1. AUDIT. Does nso_hollow.js's solid -> shell logic apply cleanly to the
//      prisms NSO_SupportAim.aim and NSO_PathSweep.sweep produce? The two
//      things the audit found are pinned here as facts: the outer-face wall
//      gate is blind on a two-triangle prism side (so hollow() now measures
//      the cavity side too), and the bounding-box "thicker than half" check
//      cannot fire on a TILTED thin part (the field refusal does).
//   2. THE FLOOR. Every wall is NSO_Thickness.floorFor(nozzle) = 0.42 mm at a
//      0.4 nozzle, measured from both sides on every hollowed part; a part
//      hollowed on its own passes the canonical checker at --min-wall = the
//      floor; a wall asked for under the floor is never built; and the floor
//      scales with the nozzle.
//   3. THE FALLBACK. A deliberately tiny branch added to a real tree stays
//      solid, named, while everything else is hollowed and the tree is not
//      refused - and hollow() itself agrees it cannot be hollowed.
//   4. PARITY. Hollowing changes nothing that was planned: contacts, trunk,
//      split, every branch's root, heading, length and tilt, the refusals,
//      and every part byte for byte - the same exact-match standard
//      tree:test 7b holds the gecko hand to. And the hollow tree's outer
//      surface IS the solid union, byte for byte.
//   5. THE CANONICAL CHECKER on every hollow tree, at the weld derived from
//      its own finest vertex separation (tree:canonical's rule, verbatim):
//      PASS, 0 open / non-manifold / odd / mis-wound / degenerate, no
//      self-intersection, Euler = 2 + 2 x cavities, volume = solid - bores,
//      and no wall under the floor that the solid tree did not already have.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'support-tree-out');
const { writeSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_hollow.js', 'nso_seat_surface.js', 'app-sculpt.js',
                 'app-extend.js', 'nso_support_aim.js', 'nso_path_sweep.js', 'nso_support_tree.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const ST = ctx.NSO_SupportTree;
const H = ctx.NSO_Hollow;
const TH = ctx.NSO_Thickness;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const r3 = v => (v == null ? 'null' : (+v).toFixed(3));

/* ---- the same shapes tools/nso_support_tree_test.js builds ------------- */
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
const SHELF = soupOf(box([0, 0, 0], [10, 10, 20]), box([10, 0, 16], [22, 10, 20]));
const TALL = soupOf(box([0, 0, 0], [10, 10, 26]), box([10, 0, 22], [30, 10, 26]));
const TAB = soupOf(box([0, 0, 0], [10, 10, 16]), box([10, 1, 12], [18, 9, 16]));
const TINY = soupOf(box([0, 0, 0], [10, 10, 16]), box([10, 4, 12], [12, 6, 16]));
const TALL_STYLE = process.argv.includes('--tall-gecko') ? 'gecko-hand'
                 : process.argv.includes('--tall') ? 'square' : null;
const TALL_ONLY = TALL_STYLE !== null;
const CASES = TALL_ONLY ? [['tall', TALL]] : [['shelf', SHELF], ['tab', TAB], ['tiny', TINY]];

const FLOOR = TH.floorFor(0.4);
const sameVec = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameBytes = (a, b) => Buffer.from(new Float32Array(a).buffer)
  .equals(Buffer.from(new Float32Array(b).buffer));

const validate = (file, weld, minWall) => JSON.parse(execFileSync('python3',
  [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json']
    .concat(weld ? ['--weld', String(weld)] : [])
    .concat(minWall ? ['--min-wall', String(minWall)] : []),
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));

/* tree:canonical's closest-pair search, so the weld here is derived by the
   same rule from the same measurement. */
function closestPair(soup) {
  const seen = new Map(), V = [];
  for (let i = 0; i < soup.length; i += 3) {
    const k = soup[i] + ',' + soup[i + 1] + ',' + soup[i + 2];
    if (seen.has(k)) continue;
    seen.set(k, 1);
    V.push([soup[i], soup[i + 1], soup[i + 2]]);
  }
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of V) for (let k = 0; k < 3; k++) {
    if (p[k] < mn[k]) mn[k] = p[k];
    if (p[k] > mx[k]) mx[k] = p[k];
  }
  const side = Math.max(1, Math.round(Math.cbrt(V.length)));
  const cell = Math.max(1e-9, Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / side);
  const grid = new Map();
  const key = (a, b, c) => a + '|' + b + '|' + c;
  const idx = p => [Math.floor((p[0] - mn[0]) / cell), Math.floor((p[1] - mn[1]) / cell),
                    Math.floor((p[2] - mn[2]) / cell)];
  for (let i = 0; i < V.length; i++) {
    const c = idx(V[i]), k = key(c[0], c[1], c[2]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  }
  let best = Infinity;
  for (let i = 0; i < V.length; i++) {
    const c = idx(V[i]);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
      const list = grid.get(key(c[0] + a, c[1] + b, c[2] + d));
      if (!list) continue;
      for (const j of list) {
        if (j <= i) continue;
        const dd = Math.hypot(V[i][0] - V[j][0], V[i][1] - V[j][1], V[i][2] - V[j][2]);
        if (dd < best) best = dd;
      }
    }
  }
  return best;
}
const ZERO = ['open_edges', 'nonmanifold_edges', 'odd_edges', 'inconsistent_winding_edges', 'degenerate_tris'];

fs.mkdirSync(OUT, { recursive: true });

/* =======================================================================
   1. AUDIT
   ======================================================================= */
const planS = ST.planTree(SHELF, { skipList: [] });
if (!TALL_ONLY) {
  console.log('\n=== 1. AUDIT: nso_hollow.js on the prisms aim() and sweep() make ===');
  check('the shelf plans a solid tree to audit against', planS.ok && planS.branches.length > 1, planS.reason);
  const trunk = planS.trunk, br = planS.branches[0];
  check('the floor the trunk was built to is floorFor(0.4) = 0.42 mm - the one floor',
    trunk.floorMm === FLOOR && FLOOR === 0.42, `${trunk.floorMm} mm`);

  for (const [name, soup] of [['the aim() trunk', trunk.soup], ['a sweep() branch', br.soup]]) {
    const h = H.hollow(soup, { wall: FLOOR, maxDim: 4096 });
    check(`${name}: hollow() takes it - closed, and wide enough (1.2 mm > 2 x 0.42)`,
      h.ok && h.cavity_tris > 0, h.reason);
    /* THE BLIND SPOT. A prism side is two triangles; their centroids sit a
       third of the way across, outside a 0.36 mm cavity, so a probe fired
       from the outer faces reaches the FAR outer wall. Measured from the
       cavity side it is the wall. hollow() now takes the thinner of both. */
    check(`${name}: measured from its outer faces alone, the wall reads the far side (~1.2 mm)`,
      near(h.measured_outer_mm, trunk.sideMm, 1e-3),
      `outer ${r3(h.measured_outer_mm)} mm on a ${trunk.sideMm} mm strut`);
    check(`${name}: measured from the cavity it is the real wall, at the floor`,
      near(h.measured_cavity_mm, FLOOR, 1e-4) && h.measured_mm === Math.min(h.measured_outer_mm, h.measured_cavity_mm),
      `cavity ${r3(h.measured_cavity_mm)} mm, gate took ${r3(h.measured_mm)} mm`);
  }

  /* The box test and the field test, on a part too thin to hollow. */
  const up = ST.branch([0, 0, 0], [0, 0, 8], { sideMm: 0.8 });
  const lean = ST.branch([0, 0, 0], [3, 2, 8], { sideMm: 0.8 });
  const hUp = H.hollow(up.soup, { wall: FLOOR, maxDim: 4096 });
  const hLean = H.hollow(lean.soup, { wall: FLOOR, maxDim: 4096 });
  check('a vertical 0.8 mm part trips hollow()\'s "thicker than half" box test',
    !hUp.ok && /thicker than half/.test(hUp.reason), hUp.reason.slice(0, 90));
  check('a TILTED 0.8 mm part does not - its box is wider than its section - but the field refuses it',
    !hLean.ok && /leaves no cavity/.test(hLean.reason), hLean.reason.slice(0, 90));
}

/* =======================================================================
   2 + 4. THE FLOOR, AND PARITY - every fixture, both styles
   ======================================================================= */
console.log('\n=== 2 + 4. every part at the floor, and nothing planned has moved ===');

const RUNS = [];
for (const [name, host] of CASES) {
  if (TALL_STYLE !== 'gecko-hand') RUNS.push([name, host, {}]);
  if (TALL_STYLE !== 'square') RUNS.push([name + '_gecko', host, { branchStyle: 'gecko-hand' }]);
}
const HOLLOW = {};
for (const [name, host, style] of RUNS) {
  const base = Object.assign({ skipList: [] }, style);
  const d = ST.planTree(host, base);
  const g = ST.planTree(host, Object.assign({}, base, { hollow: true }));
  if (!d.ok || !g.ok || !g.hollow || !g.hollow.ok) {
    check(`${name}: plans solid and hollow`, false, (g.hollow && g.hollow.reason) || g.reason);
    continue;
  }
  HOLLOW[name] = { host, plan: g, solid: d };

  check(`${name}: the same contact points, count and placement, exactly`,
    d.contacts.points.length === g.contacts.points.length &&
    d.contacts.points.every((c, i) => sameVec(c.p, g.contacts.points[i].p)),
    `${g.contacts.points.length} contacts`);
  check(`${name}: the same trunk, byte for byte, to the same split`,
    sameBytes(d.trunk.soup, g.trunk.soup) && sameVec(d.trunk.tip, g.trunk.tip) &&
    (d.split ? d.split.trunkMm === g.split.trunkMm && sameVec(d.split.point, g.split.point) : !g.split),
    d.split ? `split ${g.split.trunkMm.toFixed(6)} mm` : `single strut, ${g.trunk.lengthMm.toFixed(6)} mm`);
  check(`${name}: the same branches - count, contact, root, heading, length, tilt`,
    d.branches.length === g.branches.length &&
    d.branches.every((b, i) => {
      const e = g.branches[i];
      return b.contactIndex === e.contactIndex && sameVec(b.from, e.from) && sameVec(b.tip, e.tip) &&
             sameVec(b.dir, e.dir) && b.lengthMm === e.lengthMm && b.tiltDeg === e.tiltDeg;
    }),
    `${g.branches.length} branches` + (g.tiltDeg ? `, ${g.tiltDeg.min.toFixed(2)}..${g.tiltDeg.max.toFixed(2)} deg` : ''));
  check(`${name}: the same contacts refused`,
    (d.blocked || []).length === (g.blocked || []).length, `${(g.blocked || []).length} refused`);
  check(`${name}: every part the union is built from is the solid plan's, byte for byte`,
    d.parts.length === g.parts.length && d.parts.every((p, i) => sameBytes(p, g.parts[i])),
    `${g.parts.length} parts`);

  const hp = g.hollow;
  const shafts = hp.parts.filter(r => r.role === 'trunk' || r.role === 'branch');
  const fingers = hp.parts.filter(r => r.role === 'finger');
  check(`${name}: the trunk and every branch are hollow`,
    shafts.length === 1 + g.branches.length && shafts.every(r => r.hollow),
    `${shafts.filter(r => r.hollow).length} of ${shafts.length}; ` + hp.reason);
  check(`${name}: every wall is at the floor, measured from BOTH sides of every hollowed part`,
    hp.wallMm === FLOOR &&
    hp.parts.filter(r => r.hollow).every(r => r.measuredMm >= FLOOR - TH.WELD_TOL &&
                                              r.measuredCavityMm >= FLOOR - TH.WELD_TOL),
    `wall ${hp.wallMm} mm; thinnest measured ` +
    r3(Math.min(...hp.parts.filter(r => r.hollow).map(r => r.measuredMm))) + ' mm');
  if (fingers.length) {
    check(`${name}: every gecko finger - ${fingers[0].acrossMm.toFixed(3)} mm across - stays solid, as too-small`,
      fingers.every(r => !r.hollow && r.kind === 'too-small') &&
      hp.solid.length === fingers.length,
      `${fingers.length} finger(s); e.g. ${fingers[0].reason.slice(0, 80)}`);
  } else {
    check(`${name}: nothing was left solid`, hp.solid.length === 0, `${hp.solid.length}`);
  }
}

if (!TALL_ONLY) {
  /* One trunk and one branch, hollowed on their own, through the canonical
     checker with the wall check ON at the floor. Euler 4: the outer skin
     and the bore, two spheres. */
  const g = HOLLOW.shelf.plan;
  for (const r of g.hollow.parts.slice(0, 2)) {
    const file = path.join(OUT, 'shelf_hollow_' + r.role + '.stl');
    writeSTL(file, r.hollowSoup, 'NSO hollow ' + r.label);
    const v = validate(file, null, FLOOR);
    check(`shelf ${r.label} hollowed alone: the canonical checker passes it, wall check on at ${FLOOR} mm`,
      v.verdict === 'PASS' && v.euler_characteristic === 4 && v.wall.thin_faces === 0 &&
      ZERO.every(k => v[k] === 0),
      `${v.verdict}, euler ${v.euler_characteristic}, thinnest ${r3(v.wall.min_wall_mm)} mm over ` +
      `${v.wall.faces_measured} faces`);
  }

  /* A wall under the floor is never built: every part falls back. */
  const thin = ST.hollowParts(g, { hollowWallMm: 0.3 });
  check('a 0.3 mm wall request builds no tube at all - every part stays solid, and the tree is not refused',
    thin.ok && thin.hollowed === 0 && thin.solid.length === g.parts.length &&
    thin.solid.every(s => s.kind === 'under-floor'),
    thin.solid[0] && thin.solid[0].why.slice(0, 100));

  /* The floor scales with the nozzle: at 0.6 mm it is 0.63, and a 1.2 mm
     strut is not wider than two of those. */
  const p6 = ST.planTree(SHELF, { skipList: [], nozzle: 0.6, hollow: true });
  check('at a 0.6 mm nozzle the floor is 0.63 mm, and a 1.2 mm strut is too small to hollow at it',
    p6.ok && p6.trunk.floorMm === TH.floorFor(0.6) && p6.hollow.wallMm === 0.63 &&
    p6.hollow.hollowed === 0 && p6.hollow.solid.every(s => s.kind === 'too-small'),
    `floor ${p6.trunk && p6.trunk.floorMm} mm, side ${p6.sideMm} mm; ${p6.hollow && p6.hollow.reason}`);
}

/* =======================================================================
   3. THE FALLBACK, on a deliberately tiny branch
   ======================================================================= */
const TINY_SIDE = 0.8;       /* under 2 x 0.42 = 0.84 */
let tinyPlan = null;
if (!TALL_ONLY) {
  console.log('\n=== 3. a branch too small to hollow stays solid, and nothing else does ===');
  const g = HOLLOW.shelf.solid;
  /* A thin extra branch from the same collar toward the middle of the
     shelf's underside, leaning like its neighbours. Added to the plan as a
     branch in its own right - part list, branch list, label - so the tree
     code meets it exactly as it meets a real one. */
  const root = g.branchRoot;
  const tip = [20.5, 8.5, 16];
  const tiny = ST.branch(root, tip, { sideMm: TINY_SIDE });
  check('the tiny branch builds, 0.8 mm square, leaning', tiny.ok && tiny.tiltDeg > 5,
    tiny.ok ? `${tiny.lengthMm.toFixed(3)} mm, ${tiny.tiltDeg.toFixed(2)} deg off vertical` : tiny.reason);
  tiny.contactIndex = 99;
  tinyPlan = Object.assign({}, g, {
    parts: g.parts.concat([tiny.soup]),
    branches: g.branches.concat([tiny])
  });
  delete tinyPlan.hollow;
  const hp = ST.hollowParts(tinyPlan, {});
  const rec = hp.parts[hp.parts.length - 1];
  check('hollowParts does not refuse the tree', hp.ok, hp.reason);
  check('the tiny branch - and only it - is left solid, named, as too-small',
    hp.solid.length === 1 && hp.solid[0].label === 'branch ' + g.branches.length + ' (contact 99)' &&
    hp.solid[0].kind === 'too-small' && !rec.hollow,
    hp.solid.map(s => `${s.label}: ${s.why}`).join('; '));
  check('the trunk and every real branch are still hollow',
    hp.hollowed === g.parts.length && hp.parts.slice(0, -1).every(r => r.hollow),
    `${hp.hollowed} of ${hp.parts.length} hollowed`);
  /* The precheck is hollow()'s own rule on the true section - so hollow()
     asked directly must agree. */
  const direct = H.hollow(tiny.soup, { wall: FLOOR, maxDim: 4096 });
  check('and hollow() asked directly agrees it cannot be hollowed at the floor',
    !direct.ok && /thicker than half|leaves no cavity/.test(direct.reason), direct.reason.slice(0, 100));
  tinyPlan.hollow = hp;
}

/* =======================================================================
   5. THE CANONICAL CHECKER on every hollow tree
   ======================================================================= */
console.log('\n=== 5. the canonical checker on every hollow tree ===');

(async () => {
  const csg = csgContext();
  const opts = { unionSoups: csg.NSO_unionSoups };
  const runs = Object.keys(HOLLOW).map(n => [n, HOLLOW[n].plan])
    .concat(tinyPlan ? [['shelf_tinybranch', tinyPlan]] : []);
  for (const [name, plan] of runs) {
    console.log('\n-- ' + name + ' --');
    const t = await ST.hollowTree(plan, opts);
    check(`${name}: the hollow tree builds`, t.ok, t.reason);
    if (!t.ok) continue;
    const solid = await ST.unionParts(plan.parts, opts);
    check(`${name}: its outer surface IS the solid union, byte for byte`,
      solid.ok && sameBytes(t.soup.subarray(0, solid.soup.length), solid.soup) &&
      t.soup.length === solid.soup.length + plan.hollow.parts.reduce((s, r) => s + (r.hollow ? r.cavity.length : 0), 0),
      `${solid.soup.length / 9} outer + ${(t.soup.length - solid.soup.length) / 9} bore triangles`);

    /* The bores, from the inside out: every face of every bore, probed into
       the material, reaches a surface no nearer than the floor. */
    const n0 = solid.soup.length / 9, n1 = t.soup.length / 9;
    const bores = [];
    for (let f = n0; f < n1; f++) bores.push(f);
    const wr = TH.measureRegion(t.soup, bores, { nozzle: 0.4, probe: 5 });
    check(`${name}: every bore face is at least the floor from the next surface, in the finished tree`,
      wr.pass && wr.min_mm >= FLOOR - TH.WELD_TOL,
      `${wr.measured} bore faces, thinnest ${r3(wr.min_mm)} mm, ${wr.thin} under ${FLOOR}`);

    const file = path.join(OUT, name + '_hollow.stl');
    const sfile = path.join(OUT, name + '_hollow_solid.stl');
    writeSTL(file, t.soup, 'NSO hollow support tree ' + name);
    writeSTL(sfile, solid.soup, 'NSO support tree ' + name + ' (solid, for comparison)');
    const cp = closestPair(t.soup);
    const weld = Math.min(1e-4, cp / 3);
    const v = validate(file, weld, FLOOR);
    const s = validate(sfile, weld, FLOOR);
    const cav = t.bores;
    const structural = v.verdict_fails.filter(x => !/^wall\/gap/.test(x));
    check(`${name}: canonical checker - closed, manifold, consistently wound, no degenerates`,
      structural.length === 0 && ZERO.every(k => v[k] === 0),
      `weld ${weld.toExponential(3)} mm; ` + ZERO.map(k => `${k} ${v[k]}`).join(', '));
    check(`${name}: no self-intersection, piercing or coplanar - no bore touches another, or the skin`,
      v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0,
      `${v.self_intersection.pierce} piercing, ${v.self_intersection.coplanar} coplanar`);
    check(`${name}: euler = 2 + 2 x ${cav} bores - the skin and ${cav} closed, separate cavities`,
      v.euler_characteristic === 2 + 2 * cav,
      `${v.euler_characteristic}; ${t.cavities} part(s) hollowed` +
      (cav > t.cavities ? `, ${cav - t.cavities} of them with a bore either side of a collar` : ''));
    check(`${name}: volume = the solid tree's less exactly the bores`,
      near(v.signed_volume, s.signed_volume - t.cavityMm3, 1e-3),
      `${v.signed_volume.toFixed(4)} = ${s.signed_volume.toFixed(4)} - ${t.cavityMm3.toFixed(4)} mm^3`);
    /* The wall check over the WHOLE solid, at the floor. The square trees
       pass it outright. The gecko solids carry finger-to-finger gaps under
       the floor already - the shipped solid tree has them, measured here at
       the same weld - so what is asserted is that hollowing added none. */
    check(`${name}: no wall or gap under ${FLOOR} mm that the solid tree did not already have`,
      v.wall.thin_faces === s.wall.thin_faces &&
      (s.wall.thin_faces === 0 ? v.verdict === 'PASS' : true),
      `hollow ${v.wall.thin_faces} thin face(s), solid ${s.wall.thin_faces}; ` +
      `thinnest ${r3(v.wall.min_wall_mm)} vs ${r3(s.wall.min_wall_mm)} mm` +
      (s.wall.thin_faces ? ' (pre-existing, in the solid gecko fingers)' : ', verdict ' + v.verdict));
    if (t.solid.length) {
      const kinds = {};
      for (const x of t.solid) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
      console.log(`  note  left solid: ${Object.entries(kinds).map(([k, n]) => n + ' ' + k).join(', ')}`);
    }
  }

  console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
  if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }
})().catch(err => { console.error(err); process.exit(1); });
