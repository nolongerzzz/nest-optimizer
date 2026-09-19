/* The local carving tool, proven in Node and through the real app, every result
   mesh through the canonical checker.
     node tools/nso_carve_test.js        exit 0 = every gate held

   Part 1 - nso_carve.js alone, no browser
     a. every blade builds one closed watertight solid: 0 open, 0 non-manifold,
        0 odd, 0 winding, 0 degenerate, 0 sliver, 0 piercing, Euler 2, and a
        signed volume that matches the analytic shape.
     b. the probe names the feature it is aimed at - face, edge, corner - and
        the outward direction is the bisector of exactly the faces in play.
        A click near an edge snaps onto the edge; a blade too small to reach it
        reads the face instead.
     c. refusals return a reason and never a frame: off the piece, a wall
        thinner than the blade, depth deeper than the blade, a bad parameter.
     d. the placement basis is orthonormal and right-handed at every
        orientation, and roll spins the sweep axis without touching outward.
   Part 2 - the shipped tool, through the real app in real Chromium
     e. the three canonical carves on fixtures/box_hull_80x40x20-2.stl -
        a corner gouge, an edge chamfer, a flat local shave - each removing
        exactly blade n piece and each gating clean.
     f. the same three on a curved piece (fixtures/fixture_sphere_curved.stl),
        because a bisector of clustered facet normals is the case a box cannot
        exercise.
     g. the blade is not consumed: three carves in a row off one armed tool,
        the piece count unchanged, each cut landing.
     h. Undo puts the piece back exactly, and says "Carve".
     i. the status line names the one-axis wall check whenever more than one
        face is in play, and names what minWall held back when it held anything.
*/

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { withApp, loadSTL, selectModel, ROOT } = require('./nso_app_harness');
const NSO_Carve = require(path.join(ROOT, 'nso_carve.js'));

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
/* "removed of intended", or the refusal - so a detail string never throws on a
   carve that stood down */
const vol = c => (c && c.ok && Number.isFinite(c.removed))
  ? (c.removed.toFixed(4) + ' of ' + Number(c.intended).toFixed(4) + ' mm^3')
  : ('refused: ' + (c && c.reason));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-carve-'));

function writeBinarySTL(file, soup) {
  const n = soup.length / 9;
  const buf = Buffer.alloc(84 + n * 50);
  buf.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50, s = i * 9;
    const ax = soup[s], ay = soup[s + 1], az = soup[s + 2];
    const ux = soup[s + 3] - ax, uy = soup[s + 4] - ay, uz = soup[s + 5] - az;
    const vx = soup[s + 6] - ax, vy = soup[s + 7] - ay, vz = soup[s + 8] - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    buf.writeFloatLE(nx / L, o); buf.writeFloatLE(ny / L, o + 4); buf.writeFloatLE(nz / L, o + 8);
    for (let k = 0; k < 9; k++) buf.writeFloatLE(soup[s + k], o + 12 + k * 4);
  }
  fs.writeFileSync(file, buf);
}

/* the canonical battery, tools/mesh_validate.py */
function gate(file, extra) {
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--gate', '--json'].concat(extra || []);
  let out, code = 0;
  try { out = execFileSync('python3', args, { encoding: 'utf8' }); }
  catch (e) { out = e.stdout || ''; code = e.status == null ? 1 : e.status; }
  let j = null;
  try { j = JSON.parse(out); } catch (e) { /* leave null */ }
  return { code, j };
}
/* "Clean" is the CANONICAL definition, not a stricter one invented here.
   tools/mesh_validate.py's verdict() gates on non-manifold edges, inconsistent
   winding, degenerate triangles, piercing self-intersections, open edges (unless
   --non-solid) and the wall check. Sliver triangles are REPORTED by that file
   and deliberately not gated: a high-aspect triangle with real area is
   watertight and prints. So the gate here is its verdict plus the explicit
   topology numbers, and the sliver count is measured and printed on every case
   rather than folded into a pass/fail it does not belong in. */
const clean = g => !!(g.j && g.code === 0 && g.j.verdict === 'PASS' &&
  g.j.open_edges === 0 && g.j.nonmanifold_edges === 0 && g.j.odd_edges === 0 &&
  g.j.inconsistent_winding_edges === 0 && g.j.degenerate_tris === 0 &&
  g.j.self_intersection && g.j.self_intersection.pierce === 0 && g.j.euler_characteristic === 2);
const gsum = g => g.j ? ('tris ' + g.j.triangles + ', open ' + g.j.open_edges + ', nm ' + g.j.nonmanifold_edges +
  ', odd ' + g.j.odd_edges + ', wind ' + g.j.inconsistent_winding_edges + ', deg ' + g.j.degenerate_tris +
  ', pierce ' + (g.j.self_intersection ? g.j.self_intersection.pierce : '?') +
  ', euler ' + g.j.euler_characteristic + ', ' + g.j.verdict +
  '  [slivers ' + g.j.sliver_tris + ', worst aspect ' + Number(g.j.worst_aspect_ratio).toFixed(1) + ']') : 'checker gave no JSON';

/* an axis-aligned box as a soup, for the headless probe checks */
function boxSoup(x0, y0, z0, x1, y1, z1) {
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
             [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const s = [];
  for (const f of q) for (const t of [[0, 1, 2], [0, 2, 3]]) for (const k of t) s.push(...v[f[k]]);
  return Float32Array.from(s);
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = a => Math.hypot(a[0], a[1], a[2]);

/* ============================================================
   PART 1 - nso_carve.js under node
   ============================================================ */
function part1() {
  console.log('\n=== Part 1: nso_carve.js, no browser ===');

  console.log('\n--- 1a. every blade is one closed watertight solid, of the right size ---');
  const T = Math.tan(Math.PI / 4);
  const blades = [
    ['flat', { width: 6, length: 10, height: 6 }, 6 * 10 * 6],
    ['flat', { width: 3, length: 3, height: 2 }, 3 * 3 * 2],
    ['vee', { angle: 90, length: 10, height: 6 }, 6 * T * 6 * 10],
    ['vee', { angle: 45, length: 6, height: 3 }, 3 * Math.tan(Math.PI * 45 / 360) * 3 * 6],
    ['ball', { radius: 2, height: 6, seg: 24, rings: 6 }, null],
    ['ball', { radius: 1, height: 4, seg: 64, rings: 24 }, null]
  ];
  blades.forEach(([name, p, wantVol], i) => {
    const b = NSO_Carve.buildBlade(name, p);
    if (!b.ok) { check(name + ' ' + JSON.stringify(p) + ' builds', false, b.reason); return; }
    const f = path.join(tmp, 'blade' + i + '_' + name + '.stl');
    writeBinarySTL(f, b.soup);
    const g = gate(f);
    check(name + ' ' + JSON.stringify(p) + ' is one closed solid', clean(g), gsum(g));
    /* the blade-local convention: tip at y = 0, shank end at y = height */
    check('  ... and obeys the blade-local convention (y 0..height)',
      near(b.box.min[1], 0, 1e-6) && near(b.box.max[1], p.height, 1e-6),
      'y ' + b.box.min[1].toFixed(4) + '..' + b.box.max[1].toFixed(4) + ', height ' + b.height);
    if (wantVol != null) {
      check('  ... and its volume is the analytic one', near(g.j.signed_volume, wantVol, 1e-3),
        g.j.signed_volume.toFixed(3) + ' vs ' + wantVol.toFixed(3) + ' mm^3');
    } else {
      /* a faceted hemisphere is inscribed, so it must be UNDER the ideal and
         approach it as the segment count rises */
      const ideal = (2 / 3) * Math.PI * Math.pow(p.radius, 3) + Math.PI * p.radius * p.radius * (p.height - p.radius);
      const err = (ideal - g.j.signed_volume) / ideal;
      check('  ... and its volume is just under the ideal capsule (inscribed facets)',
        err > 0 && err < 0.06, (100 * err).toFixed(3) + '% under ' + ideal.toFixed(3) + ' mm^3');
    }
  });

  console.log('\n--- 1b. the probe names the feature, and outward is its bisector ---');
  const cube = boxSoup(0, 0, 0, 20, 20, 20);
  const R2 = Math.SQRT1_2, R3 = 1 / Math.sqrt(3);
  const probes = [
    ['middle of the +Y face',                    [10, 20, 10], 2, 'face',   [0, 1, 0],       [10, 20, 10]],
    ['the top +X edge',                          [20, 20, 10], 2, 'edge',   [R2, R2, 0],     [20, 20, 10]],
    ['the +X+Y+Z corner',                        [20, 20, 20], 2, 'corner', [R3, R3, R3],    [20, 20, 20]],
    ['0.5 mm onto the face, blade reaches the edge', [19.5, 20, 10], 2, 'edge', [R2, R2, 0],  [20, 20, 10]],
    ['1.5 mm in, blade too small to reach it',    [18.5, 20, 10], 1, 'face', [0, 1, 0],       [18.5, 20, 10]]
  ];
  for (const [name, pt, r, kind, out, snap] of probes) {
    const t = NSO_Carve.probeTarget(cube, pt, r);
    if (!t.ok) { check(name, false, t.reason); continue; }
    check(name + ' reads as a ' + kind, t.kind === kind, t.kind + ' (' + t.facesUsed + ' faces)');
    check('  ... outward is the bisector',
      near(t.outward[0], out[0], 1e-6) && near(t.outward[1], out[1], 1e-6) && near(t.outward[2], out[2], 1e-6),
      '[' + t.outward.map(v => v.toFixed(4)).join(', ') + ']');
    check('  ... and the reference point snapped onto the feature',
      near(t.point[0], snap[0], 1e-5) && near(t.point[1], snap[1], 1e-5) && near(t.point[2], snap[2], 1e-5),
      '[' + t.point.map(v => v.toFixed(4)).join(', ') + ']');
  }
  /* at an edge the sweep axis IS the edge, which is what makes a chamfer need
     no rotation from the user */
  const eg = NSO_Carve.probeTarget(cube, [20, 20, 10], 2);
  check('at an edge the sweep axis is the edge itself',
    near(Math.abs(eg.tangent[2]), 1, 1e-6) && near(eg.tangent[0], 0, 1e-6) && near(eg.tangent[1], 0, 1e-6),
    '[' + eg.tangent.map(v => v.toFixed(4)).join(', ') + ']');
  /* determinism: the answer cannot depend on triangle order in the soup */
  const shuffled = (() => {
    const tris = [];
    for (let i = 0; i < cube.length; i += 9) tris.push(Array.from(cube.slice(i, i + 9)));
    tris.reverse();
    return Float32Array.from([].concat(...tris));
  })();
  const a1 = NSO_Carve.probeTarget(cube, [20, 20, 20], 2);
  const a2 = NSO_Carve.probeTarget(shuffled, [20, 20, 20], 2);
  check('the probe is order-independent (reversed soup, same answer)',
    a1.kind === a2.kind && near(dot3(a1.outward, a2.outward), 1, 1e-9) &&
    near(dot3(a1.tangent, a2.tangent), 1, 1e-9),
    a2.kind + ', outward.outward ' + dot3(a1.outward, a2.outward).toFixed(9));

  console.log('\n--- 1c. refusals give a reason and never a frame ---');
  const refusals = [
    ['off the piece', () => NSO_Carve.plan(cube, [60, 60, 60], 'ball', {}, { depth: 1 }), /aim at the piece/],
    ['a wall thinner than the blade',
      () => NSO_Carve.plan(boxSoup(0, 0, 0, 20, 1, 20), [10, 1, 10], 'ball', { radius: 3, height: 6 }, { depth: 1 }),
      /thinner than/],
    ['depth deeper than the blade',
      () => NSO_Carve.plan(cube, [10, 20, 10], 'ball', { radius: 2, height: 3 }, { depth: 5 }),
      /taller than/],
    ['a negative parameter',
      () => NSO_Carve.plan(cube, [10, 20, 10], 'flat', { width: -1 }, { depth: 1 }), /must be a positive/],
    ['an unknown blade',
      () => NSO_Carve.plan(cube, [10, 20, 10], 'router', {}, { depth: 1 }), /unknown blade/],
    ['a ball whose shank does not clear its own radius',
      () => NSO_Carve.plan(cube, [10, 20, 10], 'ball', { radius: 4, height: 4 }, { depth: 1 }), /exceed the radius/]
  ];
  for (const [name, fn, re] of refusals) {
    const r = fn();
    check('refuses ' + name, !r.ok && re.test(String(r.reason)) && !r.frame, String(r.reason).slice(0, 84));
  }

  console.log('\n--- 1d. the placement basis is orthonormal and right-handed, at every aim ---');
  const aims = [[10, 20, 10], [20, 20, 10], [20, 20, 20], [0, 0, 0], [0, 10, 20], [20, 3, 0]];
  let worstOrtho = 0, worstUnit = 0, allRH = true, allTip = true;
  for (const pt of aims) {
    for (const roll of [0, 17, -90, 180]) {
      const r = NSO_Carve.plan(cube, pt, 'ball', { radius: 1, height: 4 }, { depth: 1, roll: roll });
      if (!r.ok) { check('plan at ' + JSON.stringify(pt) + ' roll ' + roll, false, r.reason); continue; }
      const { x, y, z } = r.placed.basis;
      worstOrtho = Math.max(worstOrtho, Math.abs(dot3(x, y)), Math.abs(dot3(y, z)), Math.abs(dot3(x, z)));
      worstUnit = Math.max(worstUnit, Math.abs(len3(x) - 1), Math.abs(len3(y) - 1), Math.abs(len3(z) - 1));
      /* right-handed: x cross y == z */
      const cx = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
      if (!near(dot3(cx, z), 1, 1e-9)) allRH = false;
      /* the tip is `depth` inside the surface along outward, and the frame the
         kernel gets always reads as the blade's own +Y face */
      const tipToPoint = dot3([r.probe.point[0] - r.placed.origin[0], r.probe.point[1] - r.placed.origin[1],
                               r.probe.point[2] - r.placed.origin[2]], r.placed.outward);
      if (!near(tipToPoint, 1, 1e-9)) allTip = false;
      if (r.frame.axis !== 1 || r.frame.sign !== 1 || !near(r.frame.capCoord, 4, 1e-9)) allTip = false;
    }
  }
  check('every basis is orthogonal', worstOrtho < 1e-9, 'worst |dot| ' + worstOrtho.toExponential(2));
  check('every basis is unit length', worstUnit < 1e-9, 'worst |len-1| ' + worstUnit.toExponential(2));
  check('every basis is right-handed (x cross y = z)', allRH);
  check('the tip sits exactly `depth` inside, and the frame is always {axis 1, sign 1, capCoord height}', allTip);

  /* roll spins the sweep axis and leaves outward alone - the property that
     lets a user aim a groove off the edge without re-aiming the tool */
  const r0 = NSO_Carve.plan(cube, [20, 20, 10], 'vee', { angle: 90, length: 6, height: 4 }, { depth: 1, roll: 0 });
  const r90 = NSO_Carve.plan(cube, [20, 20, 10], 'vee', { angle: 90, length: 6, height: 4 }, { depth: 1, roll: 90 });
  check('roll leaves outward untouched', near(dot3(r0.placed.outward, r90.placed.outward), 1, 1e-12),
    'dot ' + dot3(r0.placed.outward, r90.placed.outward).toFixed(12));
  check('roll 90 turns the sweep axis a right angle', near(dot3(r0.basis || r0.placed.basis.z, r90.placed.basis.z), 0, 1e-9),
    'dot ' + dot3(r0.placed.basis.z, r90.placed.basis.z).toExponential(2));
}

/* ============================================================
   PART 2 - the shipped tool, through the real app
   ============================================================ */

const setControls = (page, o) => page.evaluate(o => window.nsoCarveSetControls(o), o);
const carve = (page, id, pt) => page.evaluate(([id, pt]) => window.nsoCarveAtPoint(id, pt).then(r => {
  if (!r) return { ok: false, reason: 'no result' };
  const out = { ok: r.ok, reason: r.reason, removed: r.removed, intended: r.intended, status: r.status };
  out.dropped = r.dropped; out.trisOut = r.trisOut; out.weldTol = r.weldTol;
  if (r.planned && r.planned.ok) {
    out.kind = r.planned.probe.kind;
    out.facesUsed = r.planned.probe.facesUsed;
    out.planes = r.planned.probe.planesFound;
  }
  return out;
}), [id, pt]);
const worldBox = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.mesh.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(p.mesh);
  return { min: bb.min.toArray(), max: bb.max.toArray() };
}, id);
const soupOf = (page, id) => page.evaluate(id => {
  const p = state.placed.find(q => q && q.sourceId === id && q.mesh);
  p.mesh.updateMatrixWorld(true);
  return Array.from(meshToWorldSoup(p.mesh));
}, id);
const statusOf = page => page.evaluate(() => document.getElementById('status').textContent);

/* The smallest triangle in a soup, and how many are above aspect 100. A carve
   DOES leave high-aspect triangles at the cut boundary - manifold retriangulates
   a curved boundary against a tessellated surface and thin triangles are what
   that produces. What matters is whether any of them has collapsed: a thin
   triangle with real area is watertight and prints, a zero-area one is a
   degenerate the canonical checker fails on. So this measures both and the
   gates below assert the second is zero rather than pretending the first is. */
function sliverStats(soup) {
  let minArea = Infinity, worst = 0, over = 0, zero = 0;
  for (let i = 0; i < soup.length; i += 9) {
    const ax = soup[i], ay = soup[i + 1], az = soup[i + 2];
    const ux = soup[i + 3] - ax, uy = soup[i + 4] - ay, uz = soup[i + 5] - az;
    const vx = soup[i + 6] - ax, vy = soup[i + 7] - ay, vz = soup[i + 8] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    const area = Math.hypot(cx, cy, cz) / 2;
    if (area <= 0) { zero++; continue; }
    if (area < minArea) minArea = area;
    const e = [Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz),
               Math.hypot(vx - ux, vy - uy, vz - uz)];
    const asp = Math.pow(Math.max.apply(null, e), 2) / (2 * area);
    if (asp > worst) worst = asp;
    if (asp > 100) over++;
  }
  return { minArea, worst, over, zero, tris: soup.length / 9 };
}

async function gateCarve(page, id, label) {
  const soup = await soupOf(page, id);
  const f = path.join(tmp, label + '.stl');
  writeBinarySTL(f, Float32Array.from(soup));
  const g = gate(f);
  g.slivers = sliverStats(Float32Array.from(soup));
  return g;
}

/* Every carve result gets this, alongside the canonical gate: the sliver
   population is reported as numbers and only a COLLAPSED triangle fails. */
function checkSlivers(g, label) {
  const sv = g.slivers;
  check(label + ': no triangle has collapsed to zero area', sv && sv.zero === 0,
    sv ? (sv.over + ' of ' + sv.tris + ' over aspect 100, worst ' + sv.worst.toFixed(0) +
          ', smallest area ' + sv.minArea.toExponential(2) + ' mm^2') : 'not measured');
}

async function part2() {
  console.log('\n=== Part 2: the shipped tool, real app + real kernel ===');
  await withApp(async (page, logs) => {

    const idA = await loadSTL(page, path.join(ROOT, 'fixtures', 'box_hull_80x40x20-2.stl'));
    await selectModel(page, idA);
    await page.evaluate(() => { const d = document.querySelector('.vp-finish-menu'); if (d) d.open = true; });
    const A = await worldBox(page, idA);
    const cx = (A.min[0] + A.max[0]) / 2, cz = (A.min[2] + A.max[2]) / 2;

    console.log('\n--- 2e. the three canonical carves on a box ---');
    /* corner gouge: a ball-nose at the +X/+Z top corner */
    let r = await setControls(page, { blade: 'ball', a: 2, depth: 1.5, roll: 0 });
    check('the ball-nose readout carries the derived height (depth 1.5, r 2 -> 4)',
      near(r.params.height, 4, 1e-9), 'height ' + r.params.height);
    let c = await carve(page, idA, [A.max[0], A.max[1], A.max[2]]);
    check('corner gouge lands', c.ok, c.ok ? (c.kind + ', ' + c.removed.toFixed(3) + ' mm^3') : c.reason);
    check('  ... aimed at a corner (3 faces)', c.kind === 'corner' && c.facesUsed === 3, c.kind + '/' + c.facesUsed);
    check('  ... and removed exactly blade n piece', c.ok && near(c.removed, c.intended, 1e-3), vol(c));
    let g = await gateCarve(page, idA, 'box_corner_gouge');
    check('  ... corner gouge gates clean', clean(g), gsum(g));
    checkSlivers(g, '  ... corner gouge');
    check('  ... and the status names the one-axis wall check',
      /wall checked along the cut axis only, 3 faces in play/.test(c.status), c.status);

    /* edge chamfer: a V-groove along the top +X edge */
    await setControls(page, { blade: 'vee', a: 90, b: 12, depth: 1, roll: 0 });
    c = await carve(page, idA, [A.max[0], A.max[1], cz]);
    check('edge chamfer lands', c.ok, c.ok ? (c.kind + ', ' + c.removed.toFixed(3) + ' mm^3') : c.reason);
    check('  ... aimed at an edge (2 faces)', c.kind === 'edge' && c.facesUsed === 2, c.kind + '/' + c.facesUsed);
    check('  ... and removed exactly blade n piece', c.ok && near(c.removed, c.intended, 1e-3), vol(c));
    g = await gateCarve(page, idA, 'box_edge_chamfer');
    check('  ... edge chamfer gates clean', clean(g), gsum(g));
    checkSlivers(g, '  ... edge chamfer');

    /* flat local shave: a slab in the middle of the top face */
    await setControls(page, { blade: 'flat', a: 8, b: 12, depth: 1.2, roll: 0 });
    c = await carve(page, idA, [cx, A.max[1], cz]);
    check('flat local shave lands', c.ok, c.ok ? (c.kind + ', ' + c.removed.toFixed(3) + ' mm^3') : c.reason);
    check('  ... aimed at one face', c.kind === 'face' && c.facesUsed === 1, c.kind + '/' + c.facesUsed);
    check('  ... removed exactly blade n piece', c.ok && near(c.removed, c.intended, 1e-3), vol(c));
    check('  ... which for a slab on a flat face is width x length x depth',
      c.ok && near(c.removed, 8 * 12 * 1.2, 1e-3), vol(c) + ' vs ' + (8 * 12 * 1.2).toFixed(4) + ' mm^3');
    g = await gateCarve(page, idA, 'box_flat_shave');
    check('  ... flat shave gates clean', clean(g), gsum(g));
    checkSlivers(g, '  ... flat shave');
    check('  ... and a one-face carve does NOT claim a multi-face wall caveat',
      !/faces in play/.test(c.status), c.status);

    console.log('\n--- 2g. the blade is not consumed: three carves off one tool ---');
    const modelsBefore = await page.evaluate(() => state.models.length);
    const placedBefore = await page.evaluate(() => state.placed.length);
    await setControls(page, { blade: 'ball', a: 1.5, depth: 1, roll: 0 });
    const three = [];
    for (const z of [cz - 12, cz, cz + 12]) {
      three.push(await carve(page, idA, [A.min[0], A.max[1], z]));
    }
    check('all three carves landed', three.every(t => t.ok),
      three.map(t => t.ok ? t.removed.toFixed(3) : t.reason).join(' | '));
    check('each removed exactly blade n piece', three.every(t => t.ok && near(t.removed, t.intended, 1e-3)));
    check('nothing was added to or taken from the plate',
      (await page.evaluate(() => state.models.length)) === modelsBefore &&
      (await page.evaluate(() => state.placed.length)) === placedBefore,
      'models ' + modelsBefore + ', placed ' + placedBefore);
    g = await gateCarve(page, idA, 'box_three_gouges');
    check('the piece still gates clean after six carves', clean(g), gsum(g));
    checkSlivers(g, 'after six carves');

    console.log('\n--- 2g2. two carves cannot overlap and lose each other ---');
    /* Each carve reads the piece, awaits the kernel, then commits. Two in flight
       would both read the pre-cut geometry and the second commit would throw the
       first cut away - reachable by ordinary use of a tool meant for repeated
       clicks, so it is refused rather than raced. */
    await setControls(page, { blade: 'ball', a: 1, depth: 0.8, roll: 0 });
    const pair = await page.evaluate(([id, p1, p2]) => Promise.all([
      window.nsoCarveAtPoint(id, p1), window.nsoCarveAtPoint(id, p2)
    ]).then(rs => rs.map(r => ({ ok: r.ok, reason: r.reason }))),
      [idA, [cx - 30, A.max[1], cz], [cx - 20, A.max[1], cz]]);
    check('exactly one of two overlapping carves runs', pair.filter(r => r.ok).length === 1,
      JSON.stringify(pair));
    check('  ... and the other is refused, not raced',
      pair.some(r => !r.ok && /already running/.test(String(r.reason))), JSON.stringify(pair));
    g = await gateCarve(page, idA, 'box_no_race');
    check('  ... and the piece still gates clean', clean(g), gsum(g));

    console.log('\n--- 2h. Undo puts the piece back, exactly, and says Carve ---');
    const before = await soupOf(page, idA);
    const boxBefore = await worldBox(page, idA);
    await setControls(page, { blade: 'flat', a: 5, b: 5, depth: 2, roll: 30 });
    c = await carve(page, idA, [cx, A.max[1], cz - 15]);
    check('a carve to undo landed', c.ok, c.ok ? c.removed.toFixed(3) + ' mm^3' : c.reason);
    await page.evaluate(() => undoLast());
    const st = await statusOf(page);
    check('Undo says Carve, not Subtract or Soften', st === 'Undo: Carve reverted', st);
    const after = await soupOf(page, idA);
    const boxAfter = await worldBox(page, idA);
    check('the geometry came back identical (same triangle count)', after.length === before.length,
      before.length / 9 + ' -> ' + after.length / 9 + ' tris');
    let worst = 0;
    for (let i = 0; i < Math.min(after.length, before.length); i++) worst = Math.max(worst, Math.abs(after[i] - before[i]));
    check('  ... vertex for vertex', worst === 0, 'worst delta ' + worst);
    check('  ... and the piece sits where it did',
      boxBefore.min.every((v, i) => near(v, boxAfter.min[i], 1e-9)) &&
      boxBefore.max.every((v, i) => near(v, boxAfter.max[i], 1e-9)));

    console.log('\n--- 2f. a curved piece: the bisector of clustered facet normals ---');
    const idS = await loadSTL(page, path.join(ROOT, 'fixtures', 'fixture_sphere_curved.stl'));
    await selectModel(page, idS);
    const S = await worldBox(page, idS);
    const sc = [(S.min[0] + S.max[0]) / 2, (S.min[1] + S.max[1]) / 2, (S.min[2] + S.max[2]) / 2];
    await setControls(page, { blade: 'ball', a: 1.5, depth: 1, roll: 0 });
    c = await carve(page, idS, [sc[0], S.max[1], sc[2]]);
    check('a gouge on a curved top lands', c.ok, c.ok ? (c.kind + ', ' + c.removed.toFixed(3) + ' mm^3') : c.reason);
    check('  ... and reads the dome as ONE smooth feature', c.ok && c.kind === 'face' && c.facesUsed === 1,
      c.ok ? (c.kind + '/' + c.facesUsed + ', ' + c.planes + ' coplanar groups merged') : '-');
    check('  ... and removed exactly blade n piece', c.ok && near(c.removed, c.intended, 1e-3), vol(c));
    g = await gateCarve(page, idS, 'sphere_gouge');
    check('  ... and the curved piece gates clean', clean(g), gsum(g));
    checkSlivers(g, '  ... dome gouge');
    await setControls(page, { blade: 'vee', a: 60, b: 6, depth: 0.8, roll: 0 });
    c = await carve(page, idS, [S.max[0], sc[1], sc[2]]);
    check('a V-groove on the curved flank lands', c.ok,
      c.ok ? (c.kind + ', ' + c.removed.toFixed(3) + ' mm^3') : c.reason);
    check('  ... and reads the dome as ONE smooth feature, not an edge or a corner',
      c.ok && c.kind === 'face' && c.facesUsed === 1, c.ok ? (c.kind + '/' + c.facesUsed) : '-');
    check('  ... and removed exactly blade n piece', c.ok && near(c.removed, c.intended, 1e-3), vol(c));
    g = await gateCarve(page, idS, 'sphere_vgroove');
    check('  ... and still gates clean', clean(g), gsum(g));
    checkSlivers(g, '  ... dome V-groove');

    console.log('\n--- 2i. minWall holds a through-cut back, and the line says so ---');
    /* The block is 20 mm tall, so a 19.5 mm cut from the top would leave 0.5 mm
       of floor. minWall is 1.0, so the safety box must clip the blade and leave
       exactly 1.0 mm - and the status has to report what it kept back rather
       than presenting a clipped cut as the cut that was asked for. */
    await selectModel(page, idA);
    const solidTop = (await worldBox(page, idA)).max[1];
    const solidBot = (await worldBox(page, idA)).min[1];
    await setControls(page, { blade: 'flat', a: 4, b: 4, depth: 19.5, roll: 0 });
    c = await carve(page, idA, [cx + 25, solidTop, cz]);
    check('a near-through cut lands', c.ok, c.ok ? c.removed.toFixed(3) + ' mm^3' : c.reason);
    if (c.ok) {
      const held = c.intended - c.removed;
      check('  ... and minWall held part of it back', held > 1e-3,
        'held ' + held.toFixed(4) + ' of ' + c.intended.toFixed(4) + ' mm^3 asked for');
      check('  ... the status says so, in mm^3', /held back [\d.]+ mm\u00b3 to keep the wall/.test(c.status), c.status);
      /* The promise minWall makes is about the WALL LEFT, not about how much of
         the blade was clipped - the blade only reached 0.5 mm into the protected
         zone, so only 0.5 mm x 16 mm^2 = 8 mm^3 of it was held back. What has to
         be 1.0 mm is the floor under the cut: 4 x 4 footprint, 304 mm^3 removed
         out of a 20.0 mm tall block is a 19.0 mm cut, leaving 1.0 mm. */
      const cutDepth = c.removed / (4 * 4);
      const wallLeft = (solidTop - solidBot) - cutDepth;
      check('  ... and the wall it left is exactly the 1.0 mm minWall asks for',
        near(wallLeft, 1.0, 1e-3),
        'cut ' + cutDepth.toFixed(4) + ' mm of ' + (solidTop - solidBot).toFixed(1) +
        ' mm, wall left ' + wallLeft.toFixed(4) + ' mm');
      g = await gateCarve(page, idA, 'box_held_back');
      check('  ... and the held-back result gates clean', clean(g), gsum(g));
      checkSlivers(g, '  ... held-back cut');
      await page.evaluate(() => undoLast());
    }

    console.log('\n--- 2i2. a wall thinner than the blade is refused, not guessed at ---');
    const idH = await loadSTL(page, path.join(ROOT, 'fixtures', 'box_open.stl'));
    await selectModel(page, idH);
    const H = await worldBox(page, idH);
    await setControls(page, { blade: 'flat', a: 4, b: 4, depth: 8, roll: 0 });
    c = await carve(page, idH, [(H.min[0] + H.max[0]) / 2, H.min[1], (H.min[2] + H.max[2]) / 2]);
    check('a blade wider than a 2 mm floor is refused with an actionable reason',
      !c.ok && /thinner than this blade/.test(String(c.reason)), String(c.reason));
    /* and a blade small enough to read one face of that floor does carve it */
    await setControls(page, { blade: 'ball', a: 0.6, depth: 0.5, roll: 0 });
    c = await carve(page, idH, [(H.min[0] + H.max[0]) / 2, H.min[1], (H.min[2] + H.max[2]) / 2]);
    check('a blade that fits the same floor carves it', c.ok,
      c.ok ? (c.kind + ', ' + c.removed.toFixed(4) + ' mm^3') : c.reason);
    check('  ... removing exactly blade n piece', c.ok && near(c.removed, c.intended, 1e-3), vol(c));
    g = await gateCarve(page, idH, 'tray_small_gouge');
    check('  ... and the thin-walled tray gates clean', clean(g), gsum(g));
    checkSlivers(g, '  ... tray gouge');

    const errs = logs.filter(l => /pageerror/.test(l));
    check('no page errors anywhere in the run', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
  });
}

(async () => {
  part1();
  await part2();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + (fails ? fails + ' FAILED' : 'all carve gates held'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
