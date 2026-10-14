#!/usr/bin/env node
// Where a support meets the piece: the air gap and the crosshatch interface
// (nso_support_interface.js), on the grid-pack planner's supports and their
// stations (nso_support_gridpack.js keeps every tip off a side wall itself).
//
//   node tools/nso_support_interface_check.js     exit 0 = every gate held
//
//   1. THE CONFLICT IT FIXES. Every tip the planner aims ends ON the underside:
//      closest approach 0. After finish(), the TRUE minimum distance from the
//      whole support to the piece is the gap, 0.18 mm - no nearer anywhere,
//      and no farther at the tips than the solve needs.
//   2. THE INTERFACE is nso_crosshatch.js's: two layers, ONE direction each,
//      the second at 90 degrees to the first, each exactly one 0.2 mm layer,
//      0.42 mm lines at 1.2 mm pitch; fused to its tip (one component); the
//      result closed, manifold, not self-intersecting (canonical checker).
//   3. THE LADDER: a lip beside the tip too close for a 2x2 patch gets a 1x1;
//      one too close for any patch AND the tip is refused, not built into.
//      Wall clearance (4) is what keeps real trees out of that last case.
//   4. WALL CLEARANCE: the tall fixture's four contacts 0.13 mm off the post
//      are kept off it by the planner (moved, or leaning away) - CHANGED with
//      the grid-pack planner, which replaced opts.wallClearanceMm.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'support-tree-out');
const { writeSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');
const { minTriDistance } = require('./nso_tri_distance.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_seat_surface.js', 'app-sculpt.js', 'app-extend.js',
                 'nso_support_aim.js', 'nso_path_sweep.js', 'nso_support_tree.js',
                 'nso_raster_lines.js', 'nso_crosshatch.js', 'nso_support_interface.js', 'nso_support_gridpack.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const ST = ctx.NSO_SupportTree, SI = ctx.NSO_SupportInterface, TH = ctx.NSO_Thickness, RL = ctx.NSO_RasterLines;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const r4 = v => (+v).toFixed(4);

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
const TAB = soupOf(box([0, 0, 0], [10, 10, 16]), box([10, 1, 12], [18, 9, 16]));
const TALL = soupOf(box([0, 0, 0], [10, 10, 26]), box([10, 0, 22], [30, 10, 26]));

const GAP = SI.DEFAULTS.gapMm, LAYER = SI.DEFAULTS.layerMm, FLOOR = TH.floorFor(0.4);
const validate = (file, weld) => JSON.parse(execFileSync('python3',
  [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json', '--weld', String(weld)],
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));

/* The planner hands its stations over in finish()'s own shape: one per
   contact, its axis the leg that arrives at the tip. */
const stationsOf = p => p.stations;

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const csg = csgContext();
  const K = { unionSoups: csg.NSO_unionSoups, subtractSoups: csg.NSO_subtractSoups };

  console.log('\n=== 1 + 2. the gap and the interface, on real trees ===');
  for (const [name, host, extra] of [['shelf', SHELF, {}], ['tab', TAB, {}], ['tall', TALL, {}]]) {
    console.log('\n-- ' + name + ' --');
    const p = ST.planTree(host, Object.assign({ skipList: [], hollow: true }, extra));
    const t = await ST.hollowTree(p, K);
    if (!p.ok || !t.ok) { check(`${name}: plans and bores`, false, p.reason || t.reason); continue; }
    const before = SI.minDistance(t.soup, host, { thickness: TH, reach: 1 });
    check(`${name}: as aimed, the tips end ON the underside - the conflict Bambu reported`,
      before.mm < 1e-3, `closest approach ${r4(before.mm)} mm`);
    const st = stationsOf(p);
    const f = await SI.finish(t.soup, st, host, K);
    check(`${name}: finish() builds - every tip gets a two-layer interface`,
      f.ok && f.stations.every(r => r.interface && r.cutOk && r.joined), f.reason);
    check(`${name}: the whole support keeps the ${GAP} mm gap - as a TRUE minimum distance, not a z offset`,
      f.minDistanceMm >= GAP - 1e-5 && f.minDistanceMm <= GAP + 0.01,
      `closest approach ${r4(f.minDistanceMm)} mm, sampled at ${f.sampleStepMm} mm`);
    const tops = f.stations.map(r => r.zUnderside - r.zTop);
    check(`${name}: each interface's top is the gap under the underside, its base two ${LAYER} mm layers lower`,
      f.stations.every(r => Math.abs((r.zTop - r.zBase) - 2 * LAYER) < 1e-9) && tops.every(g => g >= GAP - 1e-9 && g < GAP + 0.01),
      `gap over each tip ${tops.map(r4).join(', ')} mm`);
    const pt = f.stations[0].patch;
    const dirs = pt.lineDirections.map(d => ((d % 180) + 180) % 180);
    check(`${name}: each layer runs ONE direction, the second across the first, ${f.widthMm} mm lines at ${f.pitchMm} mm`,
      pt.census.every(c => c.crossShare <= 0.25) && Math.abs(Math.abs(dirs[0] - dirs[1]) - 90) < 1e-6 &&
      f.widthMm === FLOOR && f.pitchMm === 1.2,
      `layers at ${dirs.map(d => d.toFixed(0)).join(' / ')} deg, cross share ${pt.census.map(c => c.crossShare.toFixed(3)).join(' / ')}`);
    /* The same number, EXACTLY, by a method that shares nothing with the
       sampler: every triangle pair in closed form, candidates by box. */
    const ex = minTriDistance(f.soup, host);
    check(`${name}: the exact triangle-to-triangle distance agrees with the sampled one`,
      Math.abs(ex.mm - f.minDistanceMm) < 1e-3 && ex.mm >= GAP - 1e-5,
      `exact ${ex.mm.toFixed(6)} mm over ${ex.pairs} pairs, sampled ${r4(f.minDistanceMm)} mm`);
    const file = path.join(OUT, name + '_interface.stl');
    writeSTL(file, f.soup, 'NSO support with interface ' + name);
    const v = validate(file, 1e-6);
    check(`${name}: canonical checker - closed, manifold, no degenerates, no self-intersection`,
      v.open_edges === 0 && v.nonmanifold_edges === 0 && v.degenerate_tris === 0 &&
      v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0,
      `${v.triangles} tris, open ${v.open_edges}, nm ${v.nonmanifold_edges}, pierce ${v.self_intersection.pierce}`);
    /* One solid per trunk (and its bores) before, the same count after: every
       patch fused to the tip it sits on, none left floating. */
    check(`${name}: every patch fused to the tip it sits on - no new component`,
      RL.countComponents(f.soup) === RL.countComponents(t.soup),
      `${RL.countComponents(f.soup)} component(s) after, ${RL.countComponents(t.soup)} before`);
    if (name === 'tall') {
      /* CHANGED with the grid-pack planner: opts.wallClearanceMm and the
         tree's clearWalls are gone. The planner keeps every strut's rails
         (its circumscribed circle plus CLEAR_MM) off the piece; the four
         contacts that sit 0.13 mm off the post are moved off it (or lean
         away) by the planner itself, and their tips then take the interface
         like every other - asserted above, for all of them. */
      const nearPost = p.beacons.filter(b => b.p[0] - 10 < 0.2).map(b => b.id);
      const moved = nearPost.filter(id => p.nudged.some(n => n.beacon === id) ||
        p.members.some(m => m.beacon === id && m.path.length > 1 && m.path[1][0] > m.path[0][0] + 1e-9));
      check('tall: the four contacts 0.13 mm off the post are kept off it by the planner - moved, or leaning away',
        nearPost.length === 4 && moved.length === 4,
        `${nearPost.length} near the post; ${p.nudged.length} tip(s) moved, the rest lean off it`);
    }
  }

  console.log('\n=== 3. the ladder: a lip hanging beside one round strut ===');
  {
    /* Controlled on purpose: one round strut, its tip ON a flat underside at
       z 10, and a 0.7 mm lip hanging 0.5 mm under that underside, x0 off the
       strut's axis. A 2x2 patch reaches 1.41 mm, a 1x1 0.81 mm, the strut's
       cut top about 1.05 mm. */
    const law = ST._lawOf({});
    const strut = ST._roundPart(ctx.NSO_PathSweep, [0, 0, 0], [0, 0, 10], law.at(0, 10), law.at(10, 10)).soup;
    const station = [{ label: 'strut', contact: [0, 0, 10], from: [0, 0, 0], to: [0, 0, 10] }];
    const host = x0 => soupOf(box([-5, -5, 10], [5, 5, 12]), box([x0, -2, 9.5], [x0 + 0.7, 2, 10]));
    const f = await SI.finish(strut, station, host(1.3), K);
    const r = f.stations[0];
    check('a lip 1.3 mm off the axis: the 2x2 patch is refused by name and a 1x1 fits, gap kept',
      f.ok && r.interface && r.repeats === 1 && r.tried.length === 1 && f.minDistanceMm >= GAP - 1e-5,
      `${r.repeats}x${r.repeats}; refused: ${r.tried.map(x => x.why).join('; ')}; closest approach ${r4(f.minDistanceMm)} mm`);
    const f2 = await SI.finish(strut, station, host(0.7), K);
    check('a lip 0.7 mm off the axis - inside the strut\'s own radius: no patch fits, and the result is REFUSED',
      !f2.ok && !f2.stations[0].interface && f2.minDistanceMm < GAP && /NOT OK/.test(f2.reason), f2.reason.slice(0, 220));
  }

  console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
  if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }
})().catch(err => { console.error(err); process.exit(1); });
