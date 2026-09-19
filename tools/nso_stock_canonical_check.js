#!/usr/bin/env node
// New stock's gate: the CANONICAL checker (tools/mesh_validate.py) run over
// every piece the tool generates, with the numbers compared by machine against
// what the sizing said they would be.
//
//   node tools/nso_stock_canonical_check.js      exit 0 = every gate held
//
// Depends on tools/nso_stock_test.js having written tools/stock-out/; it runs
// that first so the pieces under test are always produced by the shipped code.
//
// WHAT IS ASSERTED, and why each one:
//
//   open / nonmanifold / odd edges          A blank is a closed solid or it is
//   inconsistent_winding, euler = 2         not stock. Three shapes go through
//                                           here, two of them built by one
//                                           revolve and one by six flat faces,
//                                           so this is the check that the band
//                                           rule holds at a pole, at a rim
//                                           annulus and at a base at once AND
//                                           that the box's winding is right.
//   degenerate_tris = 0                     No sliver ring where a profile
//                                           point sits on the axis.
//   self-intersection pierce/coplanar = 0   A primitive that crosses itself is
//                                           not a primitive.
//   signed_volume                           THE MATERIAL FIGURE, checked
//                                           against a volume the CHECKER
//                                           measured rather than one the
//                                           module computed: it must equal the
//                                           as-built volume times the polygon
//                                           factor. See docs/STOCK.md finding 1
//                                           for why those are two separate
//                                           deficits and not one fudge.
//   bbox                                    Centred on the axis, resting on
//                                           z = 0, and exactly the size the
//                                           sizing reported - which is the box
//                                           the build-volume gate refused or
//                                           allowed, so a drift here would
//                                           mean the gate ruled on a piece
//                                           that was never generated.
//
// WHAT IS MEASURED BUT NOT GATED:
//
//   sliver_tris / worst_aspect_ratio  A revolve at 96 segments makes long thin
//     triangles near the axis by construction - the poles of a sphere are the
//     worst of them. degenerate_tris staying 0 is the gate; the aspect ratio
//     is reported so a change in it is visible.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'stock-out');

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

console.log('== regenerating tools/stock-out/ from the shipped code ==');
try {
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'nso_stock_test.js')], { stdio: 'ignore' });
} catch (e) {
  /* The self-test's own exit code is its business - this suite only needs the
     pieces it wrote. A missing manifest below is the real failure. */
}
if (!fs.existsSync(path.join(OUT, 'manifest.json'))) {
  console.log('  FAIL  tools/nso_stock_test.js wrote no manifest - nothing to check');
  process.exit(1);
}
const MANIFEST = JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8'));

const validate = f => JSON.parse(execFileSync('python3',
  [path.join(ROOT, 'tools', 'mesh_validate.py'), path.join(OUT, f + '.stl'), '--json'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

const CLEAN = ['open_edges', 'nonmanifold_edges', 'odd_edges',
  'inconsistent_winding_edges', 'degenerate_tris'];

const byShape = {};
for (const m of MANIFEST) {
  console.log('\n== ' + m.name + '  (' + m.shape + ', ' + m.measure_text + ') ==');
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

  /* THE MATERIAL FIGURE, against the checker's own number. Two deficits, both
     named, neither of them slack: the revolve inscribes an n-gon in every
     circle (polygon_factor), and a sphere's meridian is itself an n-gon
     inscribed in a semicircle (built_volume under analytic). The residual on
     top of those two is float32 STL storage and nothing else. */
  const wanted = m.built_volume * m.polygon_factor;
  const rel = Math.abs(v.signed_volume - wanted) / wanted;
  check('the checker\'s volume is the as-built volume x the polygon factor',
    rel < 1e-6, v.signed_volume.toFixed(6) + ' vs ' + wanted.toFixed(6) +
    ' (' + rel.toExponential(2) + ' relative, float32 STL storage)');
  check('...and the as-built volume is at most the material the sizing asked for',
    m.built_volume <= m.analytic_volume + 1e-9 &&
    Math.abs(m.analytic_volume - m.need_volume) / m.need_volume < 1e-9,
    m.built_volume.toFixed(3) + ' built of ' + m.need_volume.toFixed(3) + ' mm^3 asked (' +
    ((1 - m.built_volume / m.need_volume) * 100).toFixed(4) + '% under)');
  check('...and the material asked for is the shell estimate plus exactly the waste margin',
    Math.abs(m.need_volume - m.shell_volume * (1 + m.target.waste)) / m.need_volume < 1e-12,
    m.shell_volume.toFixed(1) + ' x ' + (1 + m.target.waste).toFixed(2) + ' = ' +
    m.need_volume.toFixed(1) + ' mm^3');

  /* Where it sits, measured off the mesh. This is the box the build-volume
     gate ruled on, so a drift here means the gate ruled on a piece that was
     never generated - the same class of bug docs/POTTERY-WHEEL.md finding 6
     caught on the wheel. */
  check('the piece is centred on the axis',
    Math.abs(v.bbox_min[0] + v.bbox_max[0]) < 1e-4 && Math.abs(v.bbox_min[1] + v.bbox_max[1]) < 1e-4,
    'x ' + v.bbox_min[0].toFixed(5) + '..' + v.bbox_max[0].toFixed(5));
  check('it rests on z = 0', Math.abs(v.bbox_min[2]) < 1e-4, v.bbox_min[2].toFixed(6));
  check('its bounding box is exactly the size the gate was shown',
    Math.abs(v.bbox_size[0] - m.size.x) < 1e-3 &&
    Math.abs(v.bbox_size[1] - m.size.y) < 1e-3 &&
    Math.abs(v.bbox_size[2] - m.size.z) < 1e-3,
    v.bbox_size.map(x => x.toFixed(4)).join(' x ') + ' vs ' +
    [m.size.x, m.size.y, m.size.z].map(x => x.toFixed(4)).join(' x ') + ' mm');

  /* Round shapes are round: a solid of revolution is as wide as it is deep,
     and a box built from explicit proportions is not required to be. */
  if (m.shape !== 'box') {
    check('a revolved blank is as wide as it is deep',
      Math.abs(v.bbox_size[0] - v.bbox_size[1]) < 1e-9,
      v.bbox_size[0].toFixed(6) + ' vs ' + v.bbox_size[1].toFixed(6));
  }

  /* And "does this block enclose the target" is a claim about the same box. */
  const enc = v.bbox_size[0] >= 2 * m.target.radius - 1e-3 &&
              v.bbox_size[2] >= m.target.height - 1e-3;
  check('the enclose-the-target claim matches the mesh the checker measured',
    enc === m.encloses_target,
    m.encloses_target ? 'encloses the ' + m.target.height + ' x ' + (2 * m.target.radius) + ' mm target'
                      : 'does not enclose it, and does not claim to');

  console.log('   NOT GATED: sliver_tris ' + v.sliver_tris + ', worst aspect ' +
    v.worst_aspect_ratio.toFixed(3) + ' (a 96-segment ring near the axis is thin by construction; ' +
    'degenerate stays ' + v.degenerate_tris + ')');

  byShape[m.shape] = (byShape[m.shape] || 0) + 1;
}

/* Every shape this version makes has to have been put through the checker, or
   the suite is passing on a shape nobody generated. */
console.log('');
for (const shape of ['sphere', 'box', 'cylinder']) {
  check('the checker saw real ' + shape + ' pieces, at several sizes',
    (byShape[shape] || 0) >= 3, (byShape[shape] || 0) + ' piece(s)');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
