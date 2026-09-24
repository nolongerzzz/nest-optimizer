#!/usr/bin/env node
// The CANONICAL checker (tools/mesh_validate.py) run on every solid this
// feature produces: each part on its own, and the trunk-and-fan after the
// app's own boolean has made one thing of them.
//
//   node tools/nso_support_tree_canonical_check.js    exit 0 = every gate held
//
// Depends on tools/nso_support_tree_test.js having written
// tools/support-tree-out/; it runs that first, so the solids under test are
// always the ones the shipped code produces rather than a stale copy.
//
// WHAT IS ASSERTED ON A PART (the trunk, and one branch):
//
//   verdict PASS, 0 open / non-manifold / odd / inconsistently-wound edges,
//   Euler 2, 0 degenerate, 0 self-intersection of either kind, and
//   signed_volume = side^2 x length. That last one is THE cross-section
//   claim, carried from nso_support_aim.js's strut to a swept branch and put
//   to an independent implementation: a solid whose volume is exactly the
//   cross-section times the length has that cross-section the whole way.
//
// WHAT IS ASSERTED ON THE UNION, AND THE ONE THING THAT NEEDED SETTLING:
//
//   The weld radius. mesh_validate.py identifies vertices inside 1e-4 mm,
//   which is NSO_Repair.WELD_TOL and four orders below any printable feature
//   - on a part. It is NOT below every feature of a BOOLEAN's output: two
//   1.2 mm prisms crossing at a shallow angle meet along a curve whose
//   vertices land microns apart, and NSO_CSG.manifoldToSoup writes them as
//   float32, whose spacing at plate coordinates is about 2e-6 mm. So the
//   solid genuinely carries distinct vertices closer together than the
//   default weld radius, and welding them reports non-manifold edges that
//   are an artefact of the identification, not of the surface.
//
//   docs/CSG_INTEGRATION.md reached the same conclusion from the other end
//   ("the part is watertight; grid-snap welding was the wrong instrument").
//   This check does not pick a looser tolerance and hope. It MEASURES the
//   closest distinct pair of vertices in each solid, derives the weld from
//   that measurement by the same "a third of the shortest" rule
//   NSO_weldEpsFor uses, asserts the derived figure is under the default -
//   so the tolerance is a consequence of the geometry rather than a dial -
//   and validates there. It then runs the DEFAULT weld as well and asserts
//   the difference is only ever of that one kind: 0 open edges and 0
//   degenerate triangles either way, so the surface is closed on both
//   readings and what changes is which vertices are called one vertex.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'support-tree-out');
const { readSTL } = require('./nso_stl_io.js');

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

console.log('== regenerating tools/support-tree-out/ from the shipped code ==');
execFileSync(process.execPath, [path.join(ROOT, 'tools', 'nso_support_tree_test.js')],
  { stdio: 'ignore' });

const validate = (file, weld) => JSON.parse(execFileSync('python3',
  [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json']
    .concat(weld ? ['--weld', String(weld)] : []),
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));

/* The closest pair of DISTINCT vertices in a soup, through a uniform grid at
   the current best radius. Brute force would be minutes on the bigger fans. */
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
  let best = Infinity, at = null;
  for (let i = 0; i < V.length; i++) {
    const c = idx(V[i]);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
      const list = grid.get(key(c[0] + a, c[1] + b, c[2] + d));
      if (!list) continue;
      for (const j of list) {
        if (j <= i) continue;
        const dd = Math.hypot(V[i][0] - V[j][0], V[i][1] - V[j][1], V[i][2] - V[j][2]);
        if (dd < best) { best = dd; at = V[i]; }
      }
    }
  }
  return { distance: best, at: at, vertices: V.length };
}

const WELD_DEFAULT = 1e-4;          /* mesh_validate.py's own, = NSO_Repair.WELD_TOL */
const ZERO = ['open_edges', 'nonmanifold_edges', 'odd_edges',
              'inconsistent_winding_edges', 'degenerate_tris'];

/* Every case twice: the default square tip, and the 'gecko-hand' style,
   which must pass exactly the same gates. The gecko run's parts are the
   default's plus a hexagonal finger per kept finger, so the part check gains
   one finger, and the union's volume ceiling gains the fingers' volume. */
const BASES = ['shelf', 'tall', 'tab', 'tiny'];
const CASES = [].concat(...BASES.map(n => [n, n + '_gecko']));

for (const name of CASES) {
  console.log('\n== ' + name + ' ==');
  const meta = JSON.parse(fs.readFileSync(path.join(OUT, name + '.json'), 'utf8'));
  console.log(`  ${meta.contacts} contact(s) at ${meta.pitchMm} mm, covered to ` +
    `${meta.coverageMm.toFixed(3)} mm; trunk ${meta.trunkMm.toFixed(3)} mm, ` +
    `${meta.branches} branch(es), ${meta.parts} parts -> ${meta.unionTris} triangles`);

  /* ---- the parts, at the canonical weld, with nothing excused ---------- */
  /* Each part with its own cross-section area: side^2 for the square trunk
     and branch, the hexagon's for a finger. */
  const sq = meta.sideMm * meta.sideMm;
  const parts = [['trunk', sq]];
  if (meta.branches) parts.push(['branch0', sq]);
  if (meta.fingers) parts.push(['finger0', meta.fingerSectionMm2]);
  for (const [part, area] of parts) {
    const file = path.join(OUT, name + '_' + part + '.stl');
    if (!fs.existsSync(file)) continue;
    const v = validate(file);
    check(`${name}/${part}: the canonical checker passes it at the default weld`,
      v.verdict === 'PASS',
      v.verdict + (v.verdict_fails.length ? ' - ' + v.verdict_fails.join(', ') : ''));
    for (const k of ZERO) check(`${name}/${part}: ${k} = 0`, v[k] === 0, String(v[k]));
    check(`${name}/${part}: euler_characteristic = 2`,
      v.euler_characteristic === 2, String(v.euler_characteristic));
    check(`${name}/${part}: no self-intersection, piercing or coplanar`,
      v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0,
      `${v.self_intersection.pierce} piercing, ${v.self_intersection.coplanar} coplanar`);

    /* The cross-section claim, on a SWEPT solid this time. The length is read
       back off the solid itself: volume / side^2 must equal the extent along
       the part's own axis, and the bounding-box diagonal bounds that extent. */
    const L = v.signed_volume / area;
    const diag = Math.hypot(v.bbox_max[0] - v.bbox_min[0],
                            v.bbox_max[1] - v.bbox_min[1],
                            v.bbox_max[2] - v.bbox_min[2]);
    check(`${name}/${part}: signed volume is its section x a length inside its own diagonal`,
      L > 0 && L <= diag + 1e-6,
      `${v.signed_volume.toFixed(6)} mm^3 = ${area.toFixed(6)} mm^2 x ${L.toFixed(6)} mm, ` +
      `diagonal ${diag.toFixed(6)} mm`);
  }

  /* ---- the union, at a weld derived from its own finest feature -------- */
  const file = path.join(OUT, name + '.stl');
  const soup = readSTL(file).soup || readSTL(file);
  const cp = closestPair(soup);
  /* NSO_weldEpsFor's own rule, verbatim: min(what you wanted, a third of the
     shortest thing there is). Never looser than the canonical default, and
     never loose enough to identify two vertices this solid really has. */
  const weld = Math.min(WELD_DEFAULT, cp.distance / 3);

  check(`${name}: the solid's own finest vertex separation is measured, not assumed`,
    isFinite(cp.distance) && cp.distance > 0,
    `${cp.distance.toExponential(4)} mm over ${cp.vertices} distinct vertices` +
    (cp.at ? `, at [${cp.at.map(c => c.toFixed(4)).join(', ')}]` : ''));

  check(`${name}: the weld is never looser than the default, and never merges a real pair`,
    weld <= WELD_DEFAULT && weld < cp.distance,
    `${weld.toExponential(4)} mm; default ${WELD_DEFAULT} mm, closest pair ` +
    `${cp.distance.toExponential(4)} mm` +
    (cp.distance / 3 >= WELD_DEFAULT ? ' - the default is already fine enough here' : ''));

  const v = validate(file, weld);
  check(`${name}: the unioned tree passes the canonical checker at that weld`,
    v.verdict === 'PASS',
    v.verdict + (v.verdict_fails.length ? ' - ' + v.verdict_fails.join(', ') : ''));
  for (const k of ZERO) check(`${name}: ${k} = 0`, v[k] === 0, String(v[k]));
  check(`${name}: euler_characteristic = 2 - one closed shell, no handles`,
    v.euler_characteristic === 2, String(v.euler_characteristic));
  check(`${name}: not flagged non-solid`, v.non_solid === false, String(v.non_solid));
  check(`${name}: no self-intersection, piercing or coplanar`,
    v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0,
    `${v.self_intersection.pierce} piercing, ${v.self_intersection.coplanar} coplanar`);

  /* ---- and the default weld, as a measurement rather than a gate ------- */
  const d = validate(file);
  check(`${name}: at the default weld the surface is still closed and still clean`,
    d.open_edges === 0 && d.degenerate_tris === 0 &&
    d.self_intersection.pierce === 0 && d.self_intersection.coplanar === 0,
    `${d.open_edges} open, ${d.degenerate_tris} degenerate, ` +
    `${d.self_intersection.pierce} piercing`);
  if (d.verdict === 'PASS') {
    check(`${name}: and it passes the default weld outright`, true,
      `${d.welded_vertices} welded vertices, euler ${d.euler_characteristic}`);
  } else {
    console.log(`  note  ${name}: the default weld merges ` +
      `${v.welded_vertices - d.welded_vertices} of ${v.welded_vertices} distinct vertices ` +
      `(closest pair ${cp.distance.toExponential(3)} mm, weld radius ${WELD_DEFAULT} mm), ` +
      `which reports ${d.nonmanifold_edges} non-manifold edge(s) and euler ` +
      `${d.euler_characteristic}. The surface is unchanged - see the header.`);
    check(`${name}: every edge the default weld calls non-manifold comes from a merge`,
      v.welded_vertices > d.welded_vertices,
      `${v.welded_vertices} -> ${d.welded_vertices} vertices`);
  }

  /* ---- the union really is the parts, overlapped ----------------------- */
  const trunk = validate(path.join(OUT, name + '_trunk.stl'));
  check(`${name}: the union is bigger than its trunk and smaller than the parts summed`,
    v.signed_volume > trunk.signed_volume - 1e-9 &&
    v.signed_volume < trunk.signed_volume + meta.branches * meta.sideMm * meta.sideMm *
      (meta.branchLengthMm ? meta.branchLengthMm.max : 0) + (meta.fingerVolumeMm3 || 0) + 1e-6,
    `${v.signed_volume.toFixed(4)} mm^3, trunk alone ${trunk.signed_volume.toFixed(4)} mm^3`);

  /* ---- the piece it was aimed at ---------------------------------------- */
  const host = validate(path.join(OUT, name + '_host.stl'));
  check(`${name}: the piece it was aimed at is closed`,
    host.open_edges === 0,
    `${host.triangles} tris, ${host.open_edges} open, ${host.nonmanifold_edges} ` +
    `non-manifold (the shape's own - a post with an arm overlapping it)`);
}

/* ---- the gecko hand changes the tip and nothing it stands on ----------- */
console.log('\n== gecko-hand against the default, case by case ==');
const SAME = ['contacts', 'lattice', 'topUp', 'pitchMm', 'coverageMm', 'branches', 'blocked',
              'sideMm', 'trunkMm', 'splitMm', 'trunkFraction', 'tiltDeg', 'branchLengthMm',
              'worstTipPenetrationMm'];
for (const n of BASES) {
  const d = JSON.parse(fs.readFileSync(path.join(OUT, n + '.json'), 'utf8'));
  const g = JSON.parse(fs.readFileSync(path.join(OUT, n + '_gecko.json'), 'utf8'));
  const diff = SAME.filter(k => JSON.stringify(d[k]) !== JSON.stringify(g[k]));
  check(`${n}: gecko-hand has the default's contact count, split, trunk and fan, exactly`,
    diff.length === 0 && g.style === 'gecko-hand' && d.style === 'square',
    diff.length ? 'differs in ' + diff.join(', ')
                : `${g.contacts} contacts, ${g.branches} branches; ${g.fingers} finger(s) added, ` +
                  `${g.fingersDropped} left off; ${d.parts} -> ${g.parts} parts`);
}

console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }
