#!/usr/bin/env node
// The round, tapered, exactly-bored support tree - the shipped default -
// against the measured reference and against the square plan it replaces.
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
                 'nso_support_aim.js', 'nso_path_sweep.js', 'nso_support_tree.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const ST = ctx.NSO_SupportTree, PS = ctx.NSO_PathSweep, TH = ctx.NSO_Thickness;

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
     2. PARITY with the square plan, and the law on every part
     ===================================================================== */
  console.log('\n=== 2. the round tree is the square PLAN, exactly, in round solids at the law ===');
  const PLANS = {};
  for (const [name, host] of CASES) for (const style of STYLES) {
    const tag = name + (style === 'gecko-hand' ? '_gecko' : '');
    const sq = ST.planTree(host, { skipList: [], section: 'square', branchStyle: style });
    const rd = ST.planTree(host, { skipList: [], branchStyle: style, hollow: true });
    if (!sq.ok || !rd.ok) { check(`${tag}: plans square and round`, false, (rd.ok ? sq : rd).reason); continue; }
    PLANS[tag] = { host, sq, rd };
    check(`${tag}: round is the default section`, rd.section === 'round', rd.section);
    check(`${tag}: the same contacts, count and placement`,
      sq.contacts.points.length === rd.contacts.points.length &&
      sq.contacts.points.every((c, i) => sameVec(c.p, rd.contacts.points[i].p)), `${rd.contacts.points.length} contacts`);
    check(`${tag}: the same trunk base, axis, length and split`,
      sameVec(sq.trunk.from, rd.trunk.from) && sameVec(sq.trunk.tip, rd.trunk.tip) && sameVec(sq.trunk.dir, rd.trunk.dir) &&
      sq.trunk.lengthMm === rd.trunk.lengthMm && sq.trunkCarriesContact === rd.trunkCarriesContact &&
      (sq.split ? sq.split.trunkMm === rd.split.trunkMm && sameVec(sq.split.point, rd.split.point) : !rd.split),
      `trunk ${rd.trunk.lengthMm.toFixed(6)} mm` + (rd.split ? `, split ${rd.split.trunkMm.toFixed(6)} mm` : ', single strut'));
    check(`${tag}: the same branches - count, contact, root, heading, length, tilt`,
      sq.branches.length === rd.branches.length && sq.branches.every((b, i) => {
        const e = rd.branches[i];
        return b.contactIndex === e.contactIndex && sameVec(b.from, e.from) && sameVec(b.tip, e.tip) &&
               sameVec(b.dir, e.dir) && b.lengthMm === e.lengthMm && b.tiltDeg === e.tiltDeg;
      }), `${rd.branches.length} branches` + (rd.tiltDeg ? `, ${rd.tiltDeg.min.toFixed(2)}..${rd.tiltDeg.max.toFixed(2)} deg` : ''));
    check(`${tag}: the same refusals, and the same number of parts`,
      (sq.blocked || []).length === (rd.blocked || []).length && sq.parts.length === rd.parts.length,
      `${(rd.blocked || []).length} refused, ${rd.parts.length} parts`);
    if (style === 'gecko-hand') {
      const fs0 = [].concat(...sq.branches.map(b => b.hand.fingers)).concat(sq.trunkHand ? sq.trunkHand.fingers : []);
      const fs1 = [].concat(...rd.branches.map(b => b.hand.fingers)).concat(rd.trunkHand ? rd.trunkHand.fingers : []);
      check(`${tag}: every gecko finger is the square plan's, byte for byte`,
        fs0.length === fs1.length && fs0.every((f, i) => sameBytes(f.soup, fs1[i].soup)), `${fs1.length} fingers`);
    }

    /* The law, part by part, against an independent restatement of it. */
    const zTip = Math.max(...rd.contacts.points.map(c => c.p[2]));
    const bad = [];
    const roundBranches = rd.branches.filter(b => b.section === 'round');
    for (const b of roundBranches) {
      const zc = rd.contacts.points[b.contactIndex].p[2];
      if (!near(b.dFromMm, LAW(b.from[2], zc), 1e-9) || !near(b.dToMm, LAW(b.tip[2], zc), 1e-9)) bad.push(b.contactIndex);
    }
    const tr = rd.trunk;
    const trunkOk = tr.section === 'square' ||
      (near(tr.dFromMm, LAW(tr.from[2], zTip), 1e-9) && near(tr.dToMm, LAW(tr.tip[2], zTip), 1e-9));
    check(`${tag}: every round part is 2 + 2 tan(5 deg) x (height below its tip) across, at both ends`,
      bad.length === 0 && trunkOk,
      (tr.section === 'round' ? `trunk ${r3(tr.dFromMm)} -> ${r3(tr.dToMm)} mm; ` : 'trunk square (fallback); ') +
      (roundBranches.length ? `branches ${r3(Math.min(...roundBranches.map(b => b.dFromMm)))}..${r3(Math.max(...roundBranches.map(b => b.dFromMm)))} mm at the root, ` +
        `${r3(roundBranches[0].dToMm)} mm at every tip` : 'no round branches'));

    /* The square fallback: named, square, and only where the round body hits. */
    const fb = rd.sectionFallback;
    const fbOk = fb.every(f => /would run into the piece/.test(f.why)) &&
      fb.filter(f => f.role === 'branch').every(f => rd.branches.find(b => b.contactIndex === f.contactIndex).section === 'square') &&
      (fb.some(f => f.role === 'trunk') ? rd.trunk.section === 'square' : rd.trunk.section === 'round');
    const expect = { shelf: 0, tab: 0, tiny: 1, tall: 4 }[name];
    check(`${tag}: ${expect ? expect + ' part(s) keep the square section - their round body would hit the piece - named' : 'no part needs the square fallback'}`,
      fbOk && fb.length === expect, fb.length ? fb.map(f => f.label + ': ' + f.why).join(' | ').slice(0, 260) : 'none');
  }

  if (!TALL_STYLE) {
    const t = PLANS.tiny.rd;
    check('tiny: the trunk falls back because a 2 mm tab 1 mm off a post has no room for a 4.1 mm base',
      t.trunk.section === 'square' && /rail \d+ is blocked/.test(t.sectionFallback[0].why), t.sectionFallback[0].why);
  } else {
    const t = PLANS[TALL_STYLE === 'square' ? 'tall' : 'tall_gecko'].rd;
    const xs = t.sectionFallback.map(f => t.contacts.points[f.contactIndex].p[0]);
    check('tall: the four fallbacks are the contacts 0.13 mm off the post - a 2 mm round tip there has to overlap it',
      xs.length === 4 && xs.every(x => x - 10 < 0.2), `contacts at x = ${xs.map(r3).join(', ')}; post face at x = 10`);
  }

  /* =====================================================================
     3. EXACT BORES
     ===================================================================== */
  console.log('\n=== 3. exact bores: each part shrunk by one wall, in closed form ===');
  for (const tag of Object.keys(PLANS)) {
    const rd = PLANS[tag].rd, hp = rd.hollow;
    let worst = Infinity, n = 0;
    hp.parts.forEach((r, i) => { if (r.hollow) { n++; worst = Math.min(worst, depthInside(rd.parts[i], r.inner)); } });
    check(`${tag}: every bore vertex is at least one ${FLOOR} mm wall inside every face of its own part`,
      n > 0 ? worst >= FLOOR - 1e-5 : hp.hollowed === 0,
      n ? `${n} bore(s), least depth ${r4(worst)} mm` : 'no part large enough to bore');
    const kinds = {}; hp.solid.forEach(s => { kinds[s.kind] = (kinds[s.kind] || 0) + 1; });
    const fingers = hp.parts.filter(r => r.role === 'finger');
    check(`${tag}: trunk and branches are bored where the section allows; every gecko finger stays solid`,
      fingers.every(r => !r.hollow && r.kind === 'too-small') &&
      hp.parts.filter(r => r.role !== 'finger').every((r, k) => r.hollow ||
        (r.kind === 'too-small' && (r.role === 'trunk' ? rd.trunk.section === 'square'
          : rd.branches[r.branch].section === 'square'))),
      hp.reason + (Object.keys(kinds).length ? ' ' + JSON.stringify(kinds) : ''));
  }
  if (!TALL_STYLE) {
    const sh = PLANS.shelf.rd, tr = sh.hollow.parts[0];
    check('the taper\'s cos(alpha) is paid for: the section shrinks by wall / cos(alpha), not by wall',
      near(tr.deltaMm, FLOOR / Math.cos(tr.halfAngleDeg * Math.PI / 180), 1e-9) && FLOOR * Math.cos(tr.halfAngleDeg * Math.PI / 180) < FLOOR - 1e-4,
      `half-angle ${r3(tr.halfAngleDeg)} deg: shrink ${r4(tr.deltaMm)} mm; a radial ${FLOOR} would leave ` +
      `${r4(FLOOR * Math.cos(tr.halfAngleDeg * Math.PI / 180))} mm perpendicular`);
    const tips = sh.hollow.parts.filter(r => r.role === 'branch');
    check('a 2 mm round tip keeps a bore of more than 1 mm - against 0.36 mm in the 1.2 mm square strut',
      tips.every(r => r.boreToMm > 1.0), `tip bore ${r3(Math.min(...tips.map(r => r.boreToMm)))} mm`);

    /* THE FALLBACK on a deliberately tiny branch, in a real tree. */
    const g = sh;
    const tiny = ST.branch(g.branchRoot, [20.5, 8.5, 16], { sideMm: 1.2, tipDiameterMm: 0.9, diameterAngleDeg: 0 });
    tiny.contactIndex = 99;
    const tinyPlan = Object.assign({}, g, {
      parts: g.parts.concat([tiny.soup]), partAxes: g.partAxes.concat([tiny.axis]),
      branches: g.branches.concat([tiny]), hollow: undefined
    });
    const hp = ST.hollowParts(tinyPlan, {});
    check('a deliberately thin 0.9 mm branch added to a real tree stays solid, named, and nothing else does',
      hp.ok && hp.solid.length === 1 && hp.solid[0].label === 'branch 16 (contact 99)' && hp.solid[0].kind === 'too-small' &&
      hp.hollowed === g.parts.length, hp.solid.map(s => s.label + ': ' + s.why).join('; '));
    PLANS.shelf_tinybranch = { rd: Object.assign(tinyPlan, { hollow: hp }) };

    const thin = ST.hollowParts(g, { hollowWallMm: 0.3 });
    check('a 0.3 mm wall request bores nothing - every part stays solid as under-floor, and the tree is not refused',
      thin.ok && thin.hollowed === 0 && thin.solid.every(s => s.kind === 'under-floor'), thin.solid[0].why);
    const p6 = ST.planTree(SHELF, { skipList: [], nozzle: 0.6, hollow: true });
    check('at a 0.6 mm nozzle (floor 0.63 mm) the round tree still takes bores - the square strut could not',
      p6.ok && p6.trunk.floorMm === TH.floorFor(0.6) && p6.hollow.hollowed === p6.parts.length,
      p6.hollow.reason + `; tip bore ${r3(Math.min(...p6.hollow.parts.filter(r => r.role === 'branch').map(r => r.boreToMm)))} mm`);
  }

  /* =====================================================================
     4. THE CANONICAL CHECKER, and the labelled wall probe
     ===================================================================== */
  console.log('\n=== 4. every hollow tree: the canonical checker, and walls vs membranes ===');
  const csg = csgContext();
  const opts = { unionSoups: csg.NSO_unionSoups, subtractSoups: csg.NSO_subtractSoups };
  for (const tag of Object.keys(PLANS)) {
    const rd = PLANS[tag].rd;
    console.log('\n-- ' + tag + ' --');
    const t = await ST.hollowTree(rd, opts);
    check(`${tag}: the hollow tree builds`, t.ok, t.reason && t.reason.slice(0, 220));
    if (!t.ok) continue;
    const file = path.join(OUT, tag + '_round_hollow.stl');
    writeSTL(file, t.soup, 'NSO round hollow support tree ' + tag);
    const weld = Math.min(1e-4, closestPair(t.soup) / 3);
    const v = validate(file, weld);
    check(`${tag}: canonical checker - closed, manifold, consistently wound, no degenerates`,
      v.verdict === 'PASS' && ['open_edges', 'nonmanifold_edges', 'odd_edges', 'inconsistent_winding_edges', 'degenerate_tris'].every(k => v[k] === 0),
      `${v.verdict}, weld ${weld.toExponential(2)} mm, ${v.triangles} tris`);
    check(`${tag}: no self-intersection, piercing or coplanar`,
      v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0,
      `${v.self_intersection.pierce} piercing, ${v.self_intersection.coplanar} coplanar`);
    const hollowed = rd.hollow.hollowed;
    check(`${tag}: euler = 2 + 2 x bores - ` + (hollowed > 1 ? 'every bore joined into ONE, as the reference\'s merged bore' : 'the skin and its bores'),
      v.euler_characteristic === 2 + 2 * t.boreShells && (hollowed > 1 ? t.boreShells === 1 : t.boreShells === hollowed),
      `${v.euler_characteristic}; ${hollowed} part(s) bored, ${t.boreShells} bore shell(s)`);
    check(`${tag}: volume = the solid union less exactly what the bores removed`,
      near(v.signed_volume, signedVolume(t.solidSoup) - t.removedMm3, 1e-3),
      `${r4(v.signed_volume)} = ${r4(signedVolume(t.solidSoup))} - ${r4(t.removedMm3)} mm^3`);
    if (hollowed) {
      const w = labelledWalls(t.soup, rd.parts);
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
