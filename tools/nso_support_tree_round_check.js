#!/usr/bin/env node
// The taper primitive, and EXACT BORES on the planner's supports.
//
// CHANGED with the grid-pack planner (docs/SUPPORT-GRIDPACK.md). This suite
// pinned the trunk-first planner's round, tapered tree: its parity with the
// square plan (section 2) and its frusta's bores. That planner is replaced
// and its members are SQUARE, constant-section mitred sweeps (a flagged
// choice), so: section 1 still pins the taper primitive (_roundPart, the
// law), which stays in nso_support_tree.js; section 2 now asks the planner's
// bores the same closed-form question - every bore point one wall inside its
// own member - per leg, since a mitred member is convex leg by leg; section 3
// is the fallback ladder (too-small, under-floor, a fatter nozzle); section 4
// is the canonical checker and the labelled wall probe, unchanged in what
// they ask, on every hollow support.
//
//   node tools/nso_support_tree_round_check.js               shelf, tab, tiny + sections 1-4
//   node tools/nso_support_tree_round_check.js --tall        the tall fixture, square tips
//   node tools/nso_support_tree_round_check.js --tall-gecko  ... gecko-hand tips
//                                                            exit 0 = every gate held
//
// Three npm steps (tree:round, tree:round-tall, tree:round-tall-gecko) so the
// expensive tall trees pack into separate shards. Writes
// tools/support-tree-out/<case>_round_hollow.stl.
//
//   1. THE TAPER. NSO_PathSweep's frustum is exact: every wall quad planar,
//      each end ring the area of a circle of its diameter, the volume the
//      frustum formula's. Every round part's diameter at both ends is the
//      measured law, 2 + 2 tan(5 deg) x (height below its tip), exactly.
//   2. PARITY with the square plan, exactly - the standard tree:test 7b holds
//      the gecko hand to: contacts, split, trunk base and axis, every branch's
//      contact, root, heading, length and tilt, the refusals, the part count,
//      and every gecko finger byte for byte. A part whose round body would run
//      into the piece keeps the square section, and is named.
//   3. EXACT BORES. Each part's inner is its own solid shrunk by one wall:
//      every inner vertex is at least `wall` inside every face plane of its
//      convex part - closed form, checked per vertex. The taper's cos(alpha)
//      is paid for, and shown to be needed. Parts too small for a bore stay
//      solid, named - including a deliberately thin branch in a real tree.
//   4. THE CANONICAL CHECKER on every hollow tree (derived weld, as
//      tree:canonical): closed, manifold, no self-intersection, Euler =
//      2 + 2 x bores, volume = solid union - bores. And a LABELLED wall probe
//      on the kernel's actual output: every face classed skin or bore, one ray
//      per face into the material, and every skin<->bore reading at least the
//      floor. Bore<->bore membranes, where two bores diverge, are measured and
//      reported - they are not walls to the outside (docs/SUPPORT-TREE-SHAPE.md).

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
for (const f of ['nso_thickness.js', 'nso_seat_surface.js', 'app-sculpt.js', 'app-extend.js',
                 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js', 'nso_support_tree.js', 'nso_support_gridpack.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const ST = ctx.NSO_SupportTree, PS = ctx.NSO_PathSweep, TH = ctx.NSO_Thickness, GP = ctx.NSO_SupportGridpack;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const r3 = v => (v == null || !isFinite(v)) ? String(v) : (+v).toFixed(3);
const r4 = v => (v == null || !isFinite(v)) ? String(v) : (+v).toFixed(4);
const sameVec = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sameBytes = (a, b) => Buffer.from(new Float32Array(a).buffer).equals(Buffer.from(new Float32Array(b).buffer));
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

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

const TALL_STYLE = process.argv.includes('--tall-gecko') ? 'gecko-hand' : process.argv.includes('--tall') ? 'square' : null;
const CASES = TALL_STYLE ? [['tall', TALL]] : [['shelf', SHELF], ['tab', TAB], ['tiny', TINY]];
const STYLES = TALL_STYLE ? [TALL_STYLE] : ['square', 'gecko-hand'];
const unit3 = a => { const L = Math.hypot(a[0], a[1], a[2]); return [a[0] / L, a[1] / L, a[2] / L]; };
/* Shells of a soup, by shared exact vertices. */
function shells(soup) {
  const id = new Map(), parent = [];
  const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const vid = k => { if (!id.has(k)) { id.set(k, parent.length); parent.push(parent.length); } return id.get(k); };
  for (let t = 0; t < soup.length; t += 9) {
    const a = vid(soup[t] + ',' + soup[t + 1] + ',' + soup[t + 2]);
    for (const o of [3, 6]) { const b = vid(soup[t + o] + ',' + soup[t + o + 1] + ',' + soup[t + o + 2]); parent[find(a)] = find(b); }
  }
  const r = new Set(); for (let i = 0; i < parent.length; i++) r.add(find(i)); return r.size;
}
/* A member's outer and inner sweeps, as GP builds them, with their rings. */
function sweepsOf(p, m, wall) {
  const pts = m.points.map(q => q.slice()), n = pts.length;
  const u0 = unit3(sub(pts[1], pts[0])), up = Math.abs(u0[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const outer = PS.sweep({ points: pts, profile: GP._squareProfile(m.side, GP._phaseOf(m.id + 1)), up });
  const u1 = unit3(sub(pts[n - 1], pts[n - 2]));
  const ip = pts.map(q => q.slice());
  ip[0] = [0, 1, 2].map(k => ip[0][k] + u0[k] * wall);
  ip[n - 1] = [0, 1, 2].map(k => ip[n - 1][k] - u1[k] * wall);
  const inner = PS.sweep({ points: ip, profile: GP._squareProfile(m.side - 2 * wall, GP._phaseOf(m.id + 1)), up });
  return { outer, inner };
}
/* Least depth of the inner's vertices inside the outer, LEG BY LEG: on leg k
   the outer is a prism (convex), so each inner ring vertex of that leg is
   measured against the leg's four side planes, and the first / last inner
   rings against the outer's end caps. */
function boreDepth(outer, inner, pts) {
  let worst = Infinity;
  const R = outer.rings, I = inner.rings, M = R[0].length;
  for (let k = 0; k + 1 < R.length; k++) {
    for (let j = 0; j < M; j++) {
      const A = R[k][j], B = R[k][(j + 1) % M], C = R[k + 1][j];
      const nrm = unit3(cross(sub(B, A), sub(C, A)));
      const side = dot(sub(pts[k], A), nrm) > 0 ? 1 : -1;      /* the axis is inside */
      for (const q of [...I[k], ...I[k + 1]]) worst = Math.min(worst, dot(sub(q, A), nrm) * side);
    }
  }
  const n = pts.length, u0 = unit3(sub(pts[1], pts[0])), u1 = unit3(sub(pts[n - 1], pts[n - 2]));
  for (const q of I[0]) worst = Math.min(worst, dot(sub(q, pts[0]), u0));
  for (const q of I[I.length - 1]) worst = Math.min(worst, dot(sub(pts[n - 1], q), u1));
  return worst;
}
const FLOOR = TH.floorFor(0.4);
const LAW = (z, zTip) => 2 + 2 * Math.tan(5 * Math.PI / 180) * Math.max(0, zTip - z);

function signedVolume(s) {
  let v = 0;
  for (let o = 0; o < s.length; o += 9) {
    v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7]) - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6]) +
         s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]);
  }
  return v / 6;
}
/* How far `inner` sits inside the convex solid `outer`: the least distance,
   over inner vertices and outer face planes, measured inward. */
function depthInside(outer, inner) {
  const planes = [];
  for (let o = 0; o < outer.length; o += 9) {
    const A = [outer[o], outer[o + 1], outer[o + 2]], B = [outer[o + 3], outer[o + 4], outer[o + 5]], C = [outer[o + 6], outer[o + 7], outer[o + 8]];
    const n = cross(sub(B, A), sub(C, A)), L = Math.hypot(...n);
    if (L < 1e-9) continue;
    planes.push([n[0] / L, n[1] / L, n[2] / L, A]);
  }
  let worst = Infinity;
  for (let v = 0; v < inner.length; v += 3) {
    const p = [inner[v], inner[v + 1], inner[v + 2]];
    for (const [a, b, c, A] of planes) { const d = -((p[0] - A[0]) * a + (p[1] - A[1]) * b + (p[2] - A[2]) * c); if (d < worst) worst = d; }
  }
  return worst;
}
const validate = (file, weld) => JSON.parse(execFileSync('python3',
  [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'].concat(weld ? ['--weld', String(weld)] : []),
  { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
function closestPair(soup) {
  const seen = new Map(), V = [];
  for (let i = 0; i < soup.length; i += 3) { const k = soup[i] + ',' + soup[i + 1] + ',' + soup[i + 2]; if (!seen.has(k)) { seen.set(k, 1); V.push([soup[i], soup[i + 1], soup[i + 2]]); } }
  const cell = 0.05, grid = new Map(), key = p => p.map(c => Math.floor(c / cell)).join('|');
  V.forEach((p, i) => { const k = key(p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  let best = Infinity;
  V.forEach((p, i) => {
    const c = p.map(x => Math.floor(x / cell));
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
      const list = grid.get((c[0] + a) + '|' + (c[1] + b) + '|' + (c[2] + d)); if (!list) continue;
      for (const j of list) if (j > i) { const dd = Math.hypot(p[0] - V[j][0], p[1] - V[j][1], p[2] - V[j][2]); if (dd < best) best = dd; }
    }
  });
  return best;
}

const labelledWallsFor = require('./nso_support_tree_walls.js');
const labelledWalls = (soup, parts) => labelledWallsFor(TH, soup, parts, FLOOR);

fs.mkdirSync(OUT, { recursive: true });

(async () => {
  /* =====================================================================
     1. THE TAPER
     ===================================================================== */
  if (!TALL_STYLE) {
    console.log('\n=== 1. THE TAPER: an exact frustum, at the measured law ===');
    const rp = ST._roundPart(PS, [0, 0, 0], [3, 1, 10], 3.75, 2);
    const sw = rp.sweep, u = [3 / Math.hypot(3, 1, 10), 1 / Math.hypot(3, 1, 10), 10 / Math.hypot(3, 1, 10)];
    const pl = PS.wallPlanarity(sw.rings);
    check('the swept frustum\'s wall quads are planar - every rail passes through the apex',
      pl.worst < 1e-5, `worst ${pl.worst.toExponential(2)} mm off plane over ${ST.ROUND_SIDES} quads`);
    const A0 = PS.loopArea(sw.rings[0], u), A1 = PS.loopArea(sw.rings[1], u);
    check('each end ring has the area of a circle of its diameter - the reference\'s diameter is area-equivalent',
      near(A0, Math.PI * 3.75 * 3.75 / 4, 1e-4) && near(A1, Math.PI, 1e-4),
      `${r4(A0)} vs ${r4(Math.PI * 3.75 * 3.75 / 4)}, ${r4(A1)} vs ${r4(Math.PI)} mm^2`);
    const L = Math.hypot(3, 1, 10), Vf = L / 3 * (A0 + A1 + Math.sqrt(A0 * A1));
    check('...and the solid\'s volume is the frustum formula\'s', near(signedVolume(sw.tris), Vf, 1e-3),
      `${r4(signedVolume(sw.tris))} vs L/3 (A0 + A1 + sqrt(A0 A1)) = ${r4(Vf)} mm^3`);
    const bent = PS.sweep({ points: [[0, 0, 0], [0, 0, 5], [2, 0, 9]], profile: ST._roundProfile(2).profile, scales: [1, 0.5] });
    check('a taper on a path with a joint is refused by name, not mitred wrong',
      !bent.ok && /straight 2-point path/.test(bent.reason), bent.reason);
    const law = ST._lawOf({});
    check('the law is the reference\'s: 2 mm at the tip, 2 tan(5 deg) = 0.175 mm per mm below it',
      law.tipMm === 2 && law.angleDeg === 5 && near(law.perMm, 0.174977, 1e-6) && ST.TIP_DIAMETER_MM === 2 &&
      ST.DIAMETER_ANGLE_DEG === 5, `d = ${law.tipMm} + ${law.perMm.toFixed(6)} x depth`);
  }

  /* =====================================================================
     2. EXACT BORES on the planner's members
     ===================================================================== */
  console.log('\n=== 2. exact bores: each member shrunk by one wall, leg by leg, in closed form ===');
  const csg = csgContext();
  const opts = { unionSoups: csg.NSO_unionSoups, subtractSoups: csg.NSO_subtractSoups };
  const PLANS = {};
  for (const [name, host] of CASES) for (const style of STYLES) {
    const tag = name + (style === 'gecko-hand' ? '_gecko' : '');
    const rd = ST.planTree(host, { skipList: [], branchStyle: style });
    if (!rd.ok) { check(`${tag}: plans`, false, rd.reason); continue; }
    const t = await ST.hollowTree(rd, opts);
    check(`${tag}: the hollow support builds`, t.ok && !!t.hollow, t.reason && t.reason.slice(0, 220));
    if (!t.ok) continue;
    PLANS[tag] = { host, rd, t };
    let worst = Infinity, n = 0;
    for (const b of t.hollow.bores) {
      const m = rd.members[b.member], sw = sweepsOf(rd, m, t.hollow.wallMm);
      worst = Math.min(worst, boreDepth(sw.outer, sw.inner, m.points)); n++;
    }
    check(`${tag}: every bore vertex is at least one ${FLOOR} mm wall inside its own member`,
      n > 0 ? worst >= FLOOR - 1e-5 : t.hollow.cut === 0,
      n ? `${n} bore(s), least depth ${r4(worst)} mm` : 'no member large enough to bore');
    const single = rd.members.filter(m => !m.dead && m.count === 1 && m.points);
    check(`${tag}: a single contact's 1.2 mm strut stays solid - its bore would be 0.36 mm`,
      single.every(m => t.hollow.solid.some(x => x.label === 'member ' + m.id && x.kind === 'too-small')),
      `${single.length} strut(s); ${t.hollow.reason}`);
    check(`${tag}: merged members are bored: their side is the count's, less two walls`,
      t.hollow.bores.every(b => near(b.boreMm, rd.members[b.member].side - 2 * FLOOR, 1e-12) && rd.members[b.member].count >= 2),
      t.hollow.bores.map(b => r3(b.boreMm)).filter((v, i, a) => a.indexOf(v) === i).join(', ') + ' mm');
  }

  /* =====================================================================
     3. THE FALLBACK LADDER
     ===================================================================== */
  if (!TALL_STYLE) {
    console.log('\n=== 3. the fallback: too small, under the floor, a fatter nozzle ===');
    const rd = ST.planTree(SHELF, { skipList: [] });
    const thin = await GP.solid(rd, Object.assign({ hollow: true, hollowWallMm: 0.3 }, opts));
    check('a 0.3 mm wall request bores nothing, and the support is still built',
      thin.ok && thin.hollow.cut === 0 && /under the .* nozzle floor/.test(thin.hollow.reason), thin.hollow.reason);
    const p6 = ST.planTree(SHELF, { skipList: [], nozzle: 0.6 });
    const t6 = await GP.solid(p6, Object.assign({ hollow: true }, opts));
    const f6 = TH.floorFor(0.6);
    check('at a 0.6 mm nozzle (floor 0.63 mm) the merged members whose side leaves a bore of the floor still take one',
      t6.ok && p6.floorMm === f6 && t6.hollow.cut > 0 &&
      t6.hollow.bores.every(b => p6.members[b.member].side - 2 * f6 >= f6 - 1e-9 && p6.members[b.member].count >= 3), t6.hollow.reason);
  }

  /* =====================================================================
     4. THE CANONICAL CHECKER, and the labelled wall probe
     ===================================================================== */
  console.log('\n=== 4. every hollow support: the canonical checker, and walls vs membranes ===');
  for (const tag of Object.keys(PLANS)) {
    const { rd, t } = PLANS[tag];
    console.log('\n-- ' + tag + ' --');
    const file = path.join(OUT, tag + '_round_hollow.stl');
    writeSTL(file, t.soup, 'NSO hollow support ' + tag);
    const weld = Math.min(1e-4, closestPair(t.soup) / 3);
    const v = validate(file, weld);
    check(`${tag}: canonical checker - closed, manifold, consistently wound, no degenerates`,
      v.verdict === 'PASS' && ['open_edges', 'nonmanifold_edges', 'odd_edges', 'inconsistent_winding_edges', 'degenerate_tris'].every(k => v[k] === 0),
      `${v.verdict}, weld ${weld.toExponential(2)} mm, ${v.triangles} tris`);
    check(`${tag}: no self-intersection, piercing or coplanar`,
      v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0,
      `${v.self_intersection.pierce} piercing, ${v.self_intersection.coplanar} coplanar`);
    const sh = shells(t.soup), voids = sh - t.solids.length;
    check(`${tag}: euler = 2 x shells - every solid and every bore a sphere, no handles`,
      v.euler_characteristic === 2 * sh && voids >= (t.hollow.cut ? 1 : 0) && voids <= t.hollow.cut,
      `${v.euler_characteristic}; ${t.solids.length} solid(s), ${t.hollow.cut} member(s) bored into ${voids} bore(s)`);
    check(`${tag}: volume = the solid union less exactly what the bores removed`,
      near(v.signed_volume, signedVolume(t.solidSoup) - t.hollow.removedMm3, 1e-3),
      `${r4(v.signed_volume)} = ${r4(signedVolume(t.solidSoup))} - ${r4(t.hollow.removedMm3)} mm^3`);
    if (t.hollow.cut) {
      /* Skin vs bore is decided against the BORED members only. Against
         every part, a face at the crotch where two unbored 1.2 mm legs
         converge on a node reads as 'bore' (the point just off it lands in
         the other leg) and the probe reports the crotch's wedge as a 0.03 mm
         wall - measured on the tab, at z 10.3, above every bore. */
      const bored = t.hollow.bores.map(b => sweepsOf(rd, rd.members[b.member], t.hollow.wallMm).outer.tris);
      const w = labelledWalls(t.soup, bored);
      check(`${tag}: every wall to the outside is at least the ${FLOOR} mm floor, read off the kernel's output`,
        w.wall.n > 0 && w.wall.thin === 0 && w.wall.min >= FLOOR - TH.WELD_TOL,
        `${w.wall.n} skin<->bore readings over ${w.faces.skin} skin + ${w.faces.bore} bore faces, thinnest ${r4(w.wall.min)} mm` +
        (w.wall.ex.length ? ' ' + JSON.stringify(w.wall.ex) : ''));
      console.log(`  note  membranes between diverging bores: ${w.membrane.n} readings, ${w.membrane.thin} under the floor, ` +
        `thinnest ${r4(w.membrane.min)} mm - bore<->bore, not a wall; a slicer merges holes that close`);
    }
  }

  console.log('\n' + (fail ? `FAILED  ${fail} of ${pass + fail}` : `PASSED  all ${pass}`));
  if (fail) { console.log('  ' + FAILS.join('\n  ')); process.exit(1); }
})().catch(err => { console.error(err); process.exit(1); });
