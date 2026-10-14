#!/usr/bin/env node
// The grid-pack support planner (nso_support_gridpack.js): supports grown
// from the support points DOWN to the plate, merged pairwise on a lattice.
//
//   node tools/nso_support_gridpack_test.js       exit 0 = every gate held
//
// Loads the shipped files with vm in index.html's order and builds through
// the shipped union kernel (tools/nso_csg_node.js). Every solid it builds is
// written to tools/support-gridpack-out/ and put through tools/mesh_validate.py.
//
//   1. tilted box 30 deg: every point held, every member lands on the plate,
//      nothing refused, every leg within the lean limit
//   2. flat shelf, 3 x 3 points: each first merge happens at the depth the
//      lean budget predicts (the first lattice level both reach), to 0.1 mm
//   3. box with a through-hole: trunks route through the hole to the plate
//   4. mushroom on a wide stem: rest-on-model OFF - the cap's points are
//      unreachable from the plate, nothing is built, nothing refused;
//      ON - they stand on the stem top, counted as resting on the part
//   5. boss: 28 of 28 held (the trunk-first planner held 24)
//   6. a 60 mm high overhang: one trunk
//   7. Generate twice: identical bytes; strut style never merges
//   8. a point inside the piece: the one refusal, in one plain line
//   + mesh_validate on every solid: closed, manifold, no piercing pairs

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'support-gridpack-out');
const { writeSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_seat_surface.js', 'app-sculpt.js', 'app-extend.js',
                 'nso_support_aim.js', 'nso_path_sweep.js', 'nso_support_tree.js', 'nso_support_gridpack.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const GP = ctx.NSO_SupportGridpack, ST = ctx.NSO_SupportTree;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

/* ---- fixtures ----------------------------------------------------------- */
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
/* An arm with its underside in 1 mm cells and holes where something hangs
   from it - tools/nso_curved_branch_probe.js's own helper. */
function arm(x0, x1, y0, y1, z0, z1, cell, holes) {
  const out = [];
  const inHole = (x, y) => holes.some(h => x >= h[0] - 1e-9 && x + cell <= h[1] + 1e-9 &&
                                           y >= h[2] - 1e-9 && y + cell <= h[3] + 1e-9);
  for (let x = x0; x < x1 - 1e-9; x += cell) {
    for (let y = y0; y < y1 - 1e-9; y += cell) {
      if (inHole(x, y)) continue;
      const a = [x, y, z0], b = [x + cell, y, z0], c = [x + cell, y + cell, z0], d = [x, y + cell, z0];
      out.push(...a, ...c, ...b, ...a, ...d, ...c);
    }
  }
  return out.concat(box([x0, y0, z0], [x1, y1, z1]).slice(6 * 9));
}
/* Turned `deg` about Y, then dropped onto z = 0. */
function tilted(soup, deg) {
  const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), o = [];
  for (let i = 0; i < soup.length; i += 3) o.push(c * soup[i] + s * soup[i + 2], soup[i + 1], -s * soup[i] + c * soup[i + 2]);
  let mz = Infinity;
  for (let i = 2; i < o.length; i += 3) mz = Math.min(mz, o[i]);
  for (let i = 2; i < o.length; i += 3) o[i] -= mz;
  return new Float32Array(o);
}

const FIX = {
  /* A 40 x 12 x 6 block turned 30 deg, standing on its low edge: the flat
     underside the trunk-first planner refused ("leans 180 deg"), rising to
     20 mm so the slope's upper half has room for pickups. */
  tilted: tilted(new Float32Array(box([0, 0, 0], [40, 12, 6])), 30),
  /* A 9 x 9 shelf at z 20 on a post: exactly 3 x 3 points. */
  shelf: soupOf(box([0, 0, 0], [10, 9, 24]), box([10, 0, 20], [19, 9, 24])),
  /* A 20 x 20 x 8 block with an 8 x 8 hole through it, a post on the block,
     and an arm at z 22 reaching out over the hole. */
  hole: soupOf(box([0, 0, 0], [20, 6, 8]), box([0, 14, 0], [20, 20, 8]), box([0, 6, 0], [6, 14, 8]),
               box([14, 6, 0], [20, 14, 8]), box([15, 8, 8], [19, 12, 22]), arm(5, 19, 5, 15, 22, 25, 1, [[15, 19, 8, 12]])),
  /* A 12 x 12 cap on a 4 x 4 neck, the neck on a 32 x 32 x 6 stem. Nothing
     under the cap reaches the plate: the stem is wider than any lean. */
  mushroom: soupOf(box([-10, -10, 0], [22, 22, 6]), box([4, 4, 6], [8, 8, 20]), arm(0, 12, 0, 12, 20, 24, 1, [[4, 8, 4, 8]])),
  /* docs/CURVED-BRANCH.md's boss: the tall arm with a 3 x 3 boss hanging under it. */
  boss: soupOf(box([0, 0, 0], [10, 10, 26]), arm(10, 30, 0, 10, 22, 26, 1, [[22, 25, 6, 9]]), box([22, 6, 17], [25, 9, 22])),
  /* tools/nso_support_tree_test.js's tall arm, raised to 60 mm. */
  high: soupOf(box([0, 0, 0], [10, 10, 64]), box([10, 0, 60], [30, 10, 64]))
};

/* The mushroom cap's points, handed over in the beacon contract: today's
   detectOverhangs calls the cap supported (its ray lands on the stem), so the
   adapter would give none; the real detector flags it, and so does this. */
function capBeacons() {
  const out = [];
  for (const x of [1.065, 4.355, 7.645, 10.935]) for (const y of [1.065, 4.355, 7.645, 10.935]) {
    if (x > 4 && x < 8 && y > 4 && y < 8) continue;
    out.push({ p: [x, y, 20], n: [0, 0, -1] });
  }
  return out;
}

const validate = (file, weld) => JSON.parse(execFileSync('python3',
  [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'].concat(weld ? ['--weld', String(weld)] : []),
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));

/* Closest pair of distinct vertices, for the weld the tree suites derive. */
function closestPair(soup) {
  const seen = new Map(), V = [];
  for (let i = 0; i < soup.length; i += 3) {
    const k = soup[i] + ',' + soup[i + 1] + ',' + soup[i + 2];
    if (!seen.has(k)) { seen.set(k, 1); V.push([soup[i], soup[i + 1], soup[i + 2]]); }
  }
  const cell = 0.01, grid = new Map(), key = (a, b, c) => a + '|' + b + '|' + c;
  const idx = p => [Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)];
  V.forEach((p, i) => { const c = idx(p), k = key(...c); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  let best = cell;
  V.forEach((p, i) => {
    const c = idx(p);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
      for (const j of grid.get(key(c[0] + a, c[1] + b, c[2] + d)) || []) {
        if (j <= i) continue;
        best = Math.min(best, Math.hypot(p[0] - V[j][0], p[1] - V[j][1], p[2] - V[j][2]));
      }
    }
  });
  return best;
}

/* mesh_validate on a support solid: closed and manifold, no degenerate
   triangles, no piercing pairs, one shell per solid. At the default weld,
   or - where the boolean left distinct vertices closer than that weld, as
   docs/SUPPORT-TREE.md section 6 measured for the tree - at the weld derived
   from the closest pair, NSO_weldEpsFor's rule. */
/* Connected shells, by shared (exact) vertices. */
function shells(soup) {
  const id = new Map(), parent = [];
  const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const vid = k => { if (!id.has(k)) { id.set(k, parent.length); parent.push(parent.length); } return id.get(k); };
  for (let t = 0; t < soup.length; t += 9) {
    const a = vid(soup[t] + ',' + soup[t + 1] + ',' + soup[t + 2]);
    for (const o of [3, 6]) { const b = vid(soup[t + o] + ',' + soup[t + o + 1] + ',' + soup[t + o + 2]); parent[find(a)] = find(b); }
  }
  const roots = new Set();
  for (let i = 0; i < parent.length; i++) roots.add(find(i));
  return roots.size;
}

function validSolid(label, soup, solids, handlesAllowed) {
  const file = path.join(OUT, label + '.stl');
  writeSTL(file, soup);
  let v = validate(file), weld = 1e-4, note = 'default weld';
  const bad = r => r.verdict !== 'PASS';
  if (bad(v)) {
    const cp = closestPair(soup);
    weld = Math.min(1e-4, cp / 3);
    v = validate(file, weld);
    note = 'weld ' + weld.toExponential(2) + ' (closest pair ' + cp.toExponential(2) + ')';
  }
  const pierce = v.self_intersection.pierce;
  check(`${label}: mesh_validate - closed, manifold, no degenerate or piercing triangles`,
    !v.open_edges && !v.nonmanifold_edges && !v.degenerate_tris && !v.inconsistent_winding_edges && !pierce,
    `${v.triangles} tris, open ${v.open_edges}, non-manifold ${v.nonmanifold_edges}, degenerate ${v.degenerate_tris}, ` +
    `wind ${v.inconsistent_winding_edges}, piercing ${pierce}, Euler ${v.euler_characteristic}; ${note}`);
  const sh = shells(soup);
  check(`${label}: one shell per solid`, sh === solids, `${sh} shell(s), ${solids} solid(s)`);
  if (!handlesAllowed) {
    check(`${label}: no handles - Euler ${2 * solids}`, v.euler_characteristic === 2 * solids, `Euler ${v.euler_characteristic}`);
  } else {
    console.log(`       ${label}: Euler ${v.euler_characteristic} over ${solids} shell(s) - ${(2 * solids - v.euler_characteristic) / 2} handle(s) where neighbouring hands touch`);
  }
  check(`${label}: positive volume`, v.signed_volume > 0, v.signed_volume.toFixed(2) + ' mm^3');
  return v;
}

/* Every leg of every member within the lean limit (a side point's stub is
   horizontal by design and is left out). */
function worstLean(p) {
  let worst = 0;
  for (const m of p.members) {
    if (m.dead) continue;
    for (let i = 0; i + 1 < m.path.length; i++) {
      if (m.kind === 'side' && i === 0) continue;
      const a = m.path[i], b = m.path[i + 1], h = Math.hypot(b[0] - a[0], b[1] - a[1]), dz = Math.abs(b[2] - a[2]);
      if (h + dz < 1e-9) continue;
      worst = Math.max(worst, Math.atan2(h, dz) * 180 / Math.PI);
    }
  }
  for (const s of p.stubs) {
    const h = Math.hypot(s.to[0] - s.from[0], s.to[1] - s.from[1]), dz = s.to[2] - s.from[2];
    worst = Math.max(worst, Math.atan2(h, dz) * 180 / Math.PI);
  }
  return worst;
}

const plan = (name, extra) => GP.plan(FIX[name], Object.assign({ skipList: [], regionId: 0 }, extra || {}));

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const csg = csgContext();
  const K = { unionSoups: csg.NSO_unionSoups };
  const build = (p) => GP.solid(p, K);

  console.log('\n=== 1. tilted box, 30 deg ===');
  {
    const p = plan('tilted');
    check('the plan is made - no refusal', p.ok, p.reason);
    check('every support point held', p.ok && p.held === p.beacons.length && p.beacons.length > 10, `${p.held} of ${p.beacons && p.beacons.length}`);
    check('every trunk lands on the plate; none unreachable, none resting',
      p.ok && p.trunks.every(t => t.landing === 'plate') && !p.unreachable.length && !p.resting.length,
      `${p.trunks && p.trunks.length} trunk(s)`);
    check('every member ends at the plate or inside another member',
      p.ok && p.members.every(m => m.dead || ['plate', 'merge', 'pickup'].includes(m.end)));
    check('every leg within the lean limit', worstLean(p) <= p.branchTiltDeg + 1e-6, worstLean(p).toFixed(2) + ' deg');
    check('column pickup: members coming down the slope pick up lower points instead of each starting a strut',
      p.ok && p.pickups.length > 0 && p.pickups.every(k => p.beacons[k.beacon].p[2] < p.members[k.by].path[0][2]),
      `${p.pickups.length} picked up, ${p.merges.length} merges`);
    check('the status line is plain: no three-decimal numbers, no "1 trunks"',
      !/\d\.\d{3}/.test(p.reason) && !/\b1 trunks\b/.test(p.reason), p.reason);
    const s = await build(p);
    check('the solids build', s.ok, s.reason);
    if (s.ok) validSolid('tilted', s.soup, s.solids.length);
  }

  console.log('\n=== 2. flat shelf, 3 x 3: merges at the predicted depths ===');
  {
    const p = plan('shelf');
    check('3 x 3 support points', p.ok && p.beacons.length === 9, `${p.beacons && p.beacons.length}`);
    const tan = Math.tan(p.branchTiltDeg * Math.PI / 180), g = p.latticeMm / 2;
    const first = p.merges.filter(m => m.members.every(id => p.members[id].kind === 'beacon'));
    check('points merge pairwise: every first merge is a pair, and no merge takes more than three',
      first.length >= 3 && first.every(m => m.members.length === 2) && p.merges.every(m => m.members.length <= 3),
      `${first.length} first merges, ${p.merges.length} in all (${p.merges.map(m => m.members.length).join(', ')} members)`);
    let worst = 0;
    const rows = [];
    for (const m of first) {
      /* The prediction, from the budgets alone: the nearest node to the pair's
         midpoint, the farther of the two from it, and the first lattice level
         at least that far down at tan(theta). */
      const [a, b] = m.from;
      const N = [g * Math.round((a[0] + b[0]) / 2 / g), g * Math.round((a[1] + b[1]) / 2 / g)];
      const r = Math.max(Math.hypot(a[0] - N[0], a[1] - N[1]), Math.hypot(b[0] - N[0], b[1] - N[1]));
      const zPred = p.plateZ + g * Math.floor((Math.min(a[2], b[2]) - r / tan - p.plateZ) / g + 1e-9);
      worst = Math.max(worst, Math.abs(m.z - zPred));
      rows.push(`${m.z.toFixed(2)} (pred ${zPred.toFixed(2)})`);
    }
    check('each first merge at the predicted depth, within 0.1 mm', first.length && worst <= 0.1, rows.join(', '));
    check('a merged member carries its count: area = count x strut area, capped at 4x',
      p.members.every(m => Math.abs(m.side * m.side - p.sideMm * p.sideMm * Math.min(m.count, 4)) < 1e-9));
    check('every leg within the lean limit', worstLean(p) <= p.branchTiltDeg + 1e-6, worstLean(p).toFixed(2) + ' deg');
    const s = await build(p);
    check('the solids build', s.ok, s.reason);
    if (s.ok) validSolid('shelf', s.soup, s.solids.length);
  }

  console.log('\n=== 3. box with a through-hole ===');
  {
    const p = plan('hole');
    check('the plan is made', p.ok, p.reason);
    const inHole = (q) => q[0] > 6 && q[0] < 14 && q[1] > 6 && q[1] < 14;
    const plateRoots = p.trunks.filter(t => t.landing === 'plate').map(t => p.members[t.root]);
    check('trunks reach the plate', plateRoots.length > 0, `${plateRoots.length} trunk(s)`);
    check('and every one of them stands in the hole: it goes through the block, not round it',
      plateRoots.length && plateRoots.every(m => inHole(m.path[m.path.length - 1])),
      plateRoots.map(m => '[' + m.path[m.path.length - 1].slice(0, 2).map(v => v.toFixed(1)) + ']').join(' '));
    check('points not over the hole were steered into it', p.steered.length > 0, `${p.steered.length} steered`);
    check('every support point held', p.held === p.beacons.length, `${p.held} of ${p.beacons.length}`);
    check('every leg within the lean limit', worstLean(p) <= p.branchTiltDeg + 1e-6, worstLean(p).toFixed(2) + ' deg');
    const s = await build(p);
    check('the solids build', s.ok, s.reason);
    if (s.ok) validSolid('hole', s.soup, s.solids.length);
  }

  console.log('\n=== 4. mushroom on a wide stem ===');
  {
    const off = plan('mushroom', { beacons: capBeacons(), regionId: undefined });
    check('rest-on-model OFF: the plan is made - no refusal', off.ok, off.reason);
    check('every cap point is reported unreachable from the plate', off.ok && off.unreachable.length === 12 && off.held === 0,
      `${off.unreachable.length} unreachable, ${off.held} held`);
    check('and nothing is built on the stem', off.ok && off.trunks.length === 0);
    check('the line says so plainly', /12 unreachable from the plate/.test(off.reason), off.reason);
    const s0 = await build(off);
    check('solid() hands back an empty support, not an error', s0.ok && s0.soup.length === 0, s0.reason);

    const on = plan('mushroom', { beacons: capBeacons(), regionId: undefined, restOnModel: true });
    check('rest-on-model ON: every cap point held', on.ok && on.held === 12, on.reason);
    check('counted as resting on the part, none unreachable', on.resting.length === 12 && !on.unreachable.length, on.reason);
    const roots = on.trunks.map(t => on.members[t.root]);
    check('they stand on the stem top (z 6), a support gap and a two-layer pad above it',
      roots.length && roots.every(m => m.end === 'rest' && Math.abs(m.pad.surfaceZ - 6) < 1e-6 && Math.abs(m.pad.z0 - 6.18) < 1e-6),
      roots.map(m => m.pad && m.pad.surfaceZ.toFixed(2)).join(' '));
    const s = await build(on);
    check('the solids build', s.ok, s.reason);
    if (s.ok) validSolid('mushroom_rest', s.soup, s.solids.length);
  }

  console.log('\n=== 5. boss ===');
  {
    const p = plan('boss');
    check('28 support points', p.ok && p.beacons.length === 28, `${p.beacons && p.beacons.length}`);
    check('28 of 28 held (the trunk-first planner held 24)', p.held === 28 && !p.unreachable.length, p.reason);
    check('all of them to the plate', p.trunks.every(t => t.landing === 'plate'));
    check('every leg within the lean limit', worstLean(p) <= p.branchTiltDeg + 1e-6, worstLean(p).toFixed(2) + ' deg');
    console.log(`       ${p.nudged.length} tip(s) moved off a wall (up to ${Math.max(0, ...p.nudged.map(n => n.mm)).toFixed(2)} mm), ` +
      `${p.steered.length} steered, ${p.merges.length} merges`);
    const s = await build(p);
    check('the solids build', s.ok, s.reason);
    if (s.ok) validSolid('boss', s.soup, s.solids.length);
  }

  console.log('\n=== 6. a 60 mm high overhang ===');
  {
    const p = plan('high');
    check('every point held', p.ok && p.held === p.beacons.length, p.reason);
    check('one trunk', p.ok && p.trunks.length === 1 && p.trunks[0].landing === 'plate', `${p.trunks && p.trunks.length} trunk(s)`);
    check('its section is capped at 4x the strut area', p.ok && Math.abs(p.members[p.trunks[0].root].side - 2 * p.sideMm) < 1e-9,
      p.ok ? p.members[p.trunks[0].root].side.toFixed(2) + ' mm square' : '');
    check('and the line says "1 trunk"', /on 1 trunk to the plate/.test(p.reason), p.reason);
    const s = await build(p);
    check('the solids build', s.ok, s.reason);
    if (s.ok) validSolid('high', s.soup, s.solids.length);
  }

  console.log('\n=== 7. Generate twice; the strut style ===');
  {
    const a = await build(plan('boss')), b = await build(plan('boss'));
    const same = a.ok && b.ok && a.soup.length === b.soup.length && a.soup.every((v, i) => Object.is(v, b.soup[i]));
    check('the same region planned and built twice: identical bytes', same, `${a.soup && a.soup.length / 9} triangles`);
    const st = plan('shelf', { style: 'strut' });
    check('strut style: no merges, no pickups - one straight post per point',
      st.ok && !st.merges.length && !st.pickups.length && st.trunks.length === st.beacons.length, st.reason);
    const ss = await build(st);
    check('strut style builds', ss.ok, ss.reason);
    if (ss.ok) validSolid('shelf_strut', ss.soup, ss.solids.length);
    const gk = plan('boss', { style: 'gecko-hand' });
    const gs = await build(gk);
    check('gecko-hand style: the tree\'s plan, with a hand at every point', gk.ok && gs.ok &&
      JSON.stringify(gk.merges) === JSON.stringify(plan('boss').merges), gs.reason);
    if (gs.ok) validSolid('boss_gecko', gs.soup, gs.solids.length);
    const tp = ST.planTree(FIX.shelf, { skipList: [], regionId: 0 });
    check('NSO_SupportTree.planTree is this planner (one planner, not two)', tp.ok && tp.planner === 'gridpack' && tp.merges.length > 0, tp.reason);
  }

  console.log('\n=== 8. the one refusal ===');
  {
    const inside = plan('shelf', { beacons: [{ p: [5, 5, 10], n: [0, 0, -1] }], regionId: undefined });
    check('a point inside the piece is refused', !inside.ok && inside.inside.length === 1, inside.reason);
    check('in one plain line', !/\d\.\d{3}/.test(inside.reason) && inside.reason.split('\n').length === 1, inside.reason);
    const mixed = plan('shelf', { beacons: [{ p: [5, 5, 10], n: [0, 0, -1] }, { p: [14, 4, 20], n: [0, 0, -1] }], regionId: undefined });
    check('beside a good point it is left out and named; the good one is built', mixed.ok && mixed.held === 1 && mixed.inside.length === 1, mixed.reason);
  }

  console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
  if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }
})().catch(err => { console.error(err); process.exit(1); });
