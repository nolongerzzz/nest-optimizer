#!/usr/bin/env node
// The Pottery Wheel's gate: the CANONICAL checker (tools/mesh_validate.py) run
// over every piece the wheel throws, with the numbers compared by machine
// against what the profile said they would be.
//
//   node tools/nso_wheel_canonical_check.js      exit 0 = every gate held
//
// Depends on tools/nso_wheel_test.js having written tools/wheel-out/; it runs
// that first so the pieces under test are always produced by the shipped code.
//
// WHAT IS ASSERTED, and why each one:
//
//   open / nonmanifold / odd edges          A revolved solid is closed or it is
//   inconsistent_winding, euler = 2         not a solid. The wheel rebuilds the
//                                           whole surface on every update, so
//                                           this is the check that the band
//                                           rule in section 5 is right at the
//                                           poles, the rim and the base at once.
//   degenerate_tris = 0                     No sliver ring where a profile
//                                           point sits on the axis.
//   self-intersection pierce/coplanar = 0   The inner wall never crosses the
//                                           outer one. This is the mesh-level
//                                           statement of the wall gate.
//   signed_volume                           THE VOLUME BUDGET, checked against
//                                           a volume the CHECKER measured
//                                           rather than one the wheel computed:
//                                           it must equal the analytic profile
//                                           volume times the polygon factor,
//                                           and it must sit under the material
//                                           ceiling at every stage.
//   bbox                                    Centred on the axis, and sitting
//                                           where the profile says it sits.
//
// WHAT IS MEASURED BUT NOT GATED:
//
//   sliver_tris / worst_aspect_ratio  A revolve at 96 segments makes long thin
//     triangles near the axis by construction - a ring one segment wide at
//     r = 0.2 mm against a meridian step of 1 mm is a legitimate aspect ratio
//     of 5, and the poles are worse. degenerate_tris staying 0 is the gate;
//     the aspect ratio is reported so a change in it is visible.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'wheel-out');

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

console.log('== regenerating tools/wheel-out/ from the shipped code ==');
try {
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'nso_wheel_test.js')], { stdio: 'ignore' });
} catch (e) {
  /* The self-test's own exit code is its business - this suite only needs the
     pieces it wrote. A missing manifest below is the real failure. */
}
if (!fs.existsSync(path.join(OUT, 'manifest.json'))) {
  console.log('  FAIL  tools/nso_wheel_test.js wrote no manifest - nothing to check');
  process.exit(1);
}
const MANIFEST = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));

const validate = f => JSON.parse(execFileSync('python3',
  [path.join(ROOT, 'tools', 'mesh_validate.py'), path.join(OUT, f + '.stl'), '--json'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

const CLEAN = ['open_edges', 'nonmanifold_edges', 'odd_edges',
  'inconsistent_winding_edges', 'degenerate_tris'];

let prev = null;
for (const m of MANIFEST) {
  console.log('\n== ' + m.name + '  (' + m.ops + ') ==');
  const v = validate(m.name);
  console.log('   ' + v.triangles + ' tris, ' + v.welded_vertices + ' verts, ' +
    v.unique_edges + ' edges, euler ' + v.euler_characteristic);

  for (const k of CLEAN) check(k + ' = 0', v[k] === 0, String(v[k]));
  check('euler characteristic is 2 - one closed shell, no handles',
    v.euler_characteristic === 2, String(v.euler_characteristic));
  check('no self-intersecting triangle pairs',
    v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0,
    v.self_intersection.pierce + ' pierce, ' + v.self_intersection.coplanar + ' coplanar over ' +
    v.self_intersection.pairs_tested + ' pairs tested');
  check('the solid has positive signed volume - it is not inside out',
    v.signed_volume > 0, v.signed_volume.toFixed(4) + ' mm^3');

  /* THE VOLUME BUDGET, against the checker's own number. The mesh is an
     inscribed 96-gon of the meridian's circles, so it holds exactly
     n*sin(2pi/n)/(2pi) of the analytic volume; the residual on top of that is
     float32 STL storage and nothing else. */
  const wanted = m.analytic_volume * m.polygon_factor;
  const rel = Math.abs(v.signed_volume - wanted) / wanted;
  check('the checker\'s volume is the analytic volume x the polygon factor',
    rel < 1e-6, v.signed_volume.toFixed(6) + ' vs ' + wanted.toFixed(6) +
    ' (' + rel.toExponential(2) + ' relative, float32 STL storage)');
  check('Pappus and the washer integral still agree on this piece',
    Math.abs(m.analytic_volume - m.pappus_volume) / m.analytic_volume < 1e-12);

  /* The constraint, stated on the checker's number: what is on the wheel can
     never be more clay than the potter has. */
  const ceilingMesh = m.budget.ceiling * m.polygon_factor;
  check('the measured solid is inside the material ceiling',
    v.signed_volume <= ceilingMesh + 1e-6,
    v.signed_volume.toFixed(1) + ' of ' + ceilingMesh.toFixed(1) + ' mm^3 (' +
    (100 * v.signed_volume / ceilingMesh).toFixed(1) + '% of the ball used)');
  check('...and the ceiling is the arithmetic the wheel says it is',
    Math.abs(m.budget.ceiling - (m.budget.start + m.budget.added - m.budget.trimmed)) < 1e-9,
    m.budget.start.toFixed(1) + ' + ' + m.budget.added.toFixed(1) + ' - ' +
    m.budget.trimmed.toFixed(1) + ' = ' + m.budget.ceiling.toFixed(1) + ' mm^3');

  /* Centred, and sitting where the profile says. */
  check('the piece is centred on the axis',
    Math.abs(v.bbox_min[0] + v.bbox_max[0]) < 1e-4 && Math.abs(v.bbox_min[1] + v.bbox_max[1]) < 1e-4,
    'x ' + v.bbox_min[0].toFixed(5) + '..' + v.bbox_max[0].toFixed(5));
  check('its footprint is the profile\'s widest diameter',
    Math.abs(v.bbox_size[0] - 2 * m.max_radius) < 1e-3 && Math.abs(v.bbox_size[1] - v.bbox_size[0]) < 1e-9,
    v.bbox_size[0].toFixed(4) + ' vs ' + (2 * m.max_radius).toFixed(4) + ' mm');
  check('its height is the profile\'s span, sitting at the profile\'s base',
    Math.abs(v.bbox_size[2] - (m.top_z - m.base_z)) < 1e-3 && Math.abs(v.bbox_min[2] - m.base_z) < 1e-3,
    v.bbox_min[2].toFixed(4) + ' .. ' + v.bbox_max[2].toFixed(4) + ' mm');

  if (m.opened) {
    check('the opened piece clears the nozzle floor', m.wall_pass,
      m.wall_mm.toFixed(3) + ' mm wall, ' + m.wall_floor_mm + ' mm floor');
  }

  /* A trim must show up in the checker's volume as clay that left. */
  if (prev && m.budget.trimmed > prev.budget.trimmed) {
    const removed = m.budget.trimmed - prev.budget.trimmed;
    const drop = prev.measured - v.signed_volume;
    check('a trim removed, in the MESH, exactly the clay it charged to the budget',
      Math.abs(drop - removed * m.polygon_factor) / (removed * m.polygon_factor) < 1e-5,
      drop.toFixed(4) + ' mm^3 gone from the mesh vs ' +
      (removed * m.polygon_factor).toFixed(4) + ' charged');
  }

  console.log('   NOT GATED: sliver_tris ' + v.sliver_tris + ', worst aspect ' +
    v.worst_aspect_ratio.toFixed(3) + ' (a 96-segment ring near the axis is thin by construction; ' +
    'degenerate stays ' + v.degenerate_tris + ')');

  m.measured = v.signed_volume;
  prev = m;
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
