#!/usr/bin/env node
// Headless self-test for nso_rod_branch.js (Cylinders → Branch).
//
//   node tools/nso_rod_branch_test.js        exit 0 = every gate held
//
// Loads the shipped files with vm, in index.html's order, and welds with the
// SHIPPED boolean (tools/nso_csg_node.js: nso_csg.js verbatim on the vendored
// Manifold). Every fixture is Stock's own cylinder or one built here. Every
// number is measured on the OUTPUT soup by code that shares nothing with the
// branch's construction:
//   - the branch's tip: the output's vertices farthest along the branch's
//     direction, their centre and radius (the tip Ø, and the length and angle
//     from the press);
//   - the branch's girth part-way out: the output's vertices in a thin slab
//     square to the branch, their distance from its line;
//   - the topology welded on exact float32 keys by a counter written here, and
//     tools/mesh_validate.py --gate on every output - its self-intersection
//     pass off (--no-selfint) and NSO_Repair's (the BVH Limb's pierce guard
//     uses) run instead: a Stock trunk's wall triangles run its whole length,
//     every box overlaps every other, and the Python pass's pair search went
//     past 12 GB on one 20,000-triangle piece. Zero piercing pairs, as --gate.
//   - Limb (nso_limb.js) grabs each branch near its tip and bends it, and its
//     own guards (fold, self-intersection) must pass.
// Prints a table at the end.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { writeSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');
const L = require('../nso_limb.js');
const REPAIR = require('../NSO_Repair.js').NSO_Repair;

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Date, Promise,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Int8Array, ArrayBuffer, Error, Infinity, NaN
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['NSO_Repair.js', 'nso_thickness.js', 'nso_stock.js', 'nso_section.js', 'nso_bend.js', 'nso_densify.js', 'nso_tube_edge.js', 'nso_rod_branch.js', 'nso_tube_neck.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { NSO_rodBranchRaw, NSO_rodBranchRead, NSO_rodBranchPlan, NSO_rbDepth, NSO_Stock, NSO_rodNeckRaw } = ctx;
const csg = csgContext();
const union = (a, b) => csg.nsoUnionSoups(a, b);

let pass = 0, fail = 0;
const FAILS = [], TABLE = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-rod-branch-'));
const f3 = x => (+x).toFixed(3);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function volume(s) {
  let v = 0;
  for (let o = 0; o < s.length; o += 9) {
    v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7]) - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6]) +
         s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]);
  }
  return v / 6;
}
// exact-key weld: open edges, edges on more than two faces, edges walked the same way twice, Euler
function topo(s) {
  const id = new Map(), vid = [], E = new Map();
  for (let i = 0; i < s.length; i += 3) {
    const k = s[i] + ',' + s[i + 1] + ',' + s[i + 2];
    if (!id.has(k)) id.set(k, id.size);
    vid.push(id.get(k));
  }
  for (let t = 0; t < vid.length / 3; t++) for (let k = 0; k < 3; k++) {
    const a = vid[t * 3 + k], b = vid[t * 3 + (k + 1) % 3], key = a < b ? a + ':' + b : b + ':' + a;
    const e = E.get(key) || { n: 0, fw: 0 };
    e.n++; if (a < b) e.fw++;
    E.set(key, e);
  }
  let open = 0, nm = 0, flip = 0;
  E.forEach(e => { if (e.n === 1) open++; else if (e.n > 2) nm++; else if (e.fw !== 1) flip++; });
  return { open, nm, flip, euler: id.size - E.size + vid.length / 3 };
}
const D = require('../nso_densify.js');
function meshValidate(name, soup) {
  const file = path.join(TMP, name.replace(/[^a-z0-9]+/gi, '_') + '.stl');
  writeSTL(file, soup);
  let out;
  try { out = execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json', '--gate', '--no-selfint'], { encoding: 'utf8', maxBuffer: 64 << 20 }); }
  catch (e) { out = e.stdout; }
  const r = JSON.parse(out);
  const m = D.weld(soup, 1e-9), si = REPAIR._selfIntersectionDetail({ pos: m.pos, faces: m.tri });
  const fails = (r.verdict_fails || []).slice();
  if (si.pierce > 0) fails.push('self-intersecting (piercing) pairs ' + si.pierce + ' (NSO_Repair)');
  return { pass: r.verdict === 'PASS' && si.pierce === 0, fails, pierce: si.pierce };
}
// The branch measured off the output: the vertices within rMax of its line from the press S in direction d.
function measure(out, S, d, rMax) {
  const near = [];
  for (let i = 0; i < out.length; i += 3) {
    const p = [out[i], out[i + 1], out[i + 2]], w = sub(p, S), s = dot(w, d);
    if (s > 0 && Math.hypot(w[0] - s * d[0], w[1] - s * d[1], w[2] - s * d[2]) <= rMax + 0.01) near.push([p, s]);
  }
  let far = -Infinity;
  near.forEach(q => { far = Math.max(far, q[1]); });
  const tip = near.filter(q => q[1] > far - 1e-3).map(q => q[0]);
  const c = [0, 1, 2].map(k => tip.reduce((q, p) => q + p[k], 0) / tip.length);
  let rt = 0;
  tip.forEach(p => { rt = Math.max(rt, Math.hypot(...sub(p, c))); });
  return { far, tipC: c, tipR: rt };
}
// Every vertex of the output along the middle half of the branch (s from L/4 to 3L/4, near its line): how far it
// sits off the taper's radius there - above it, or below its polygon's flats (rb..rt the radius, n facets).
function girth(out, S, d, L, rb, rt, n, trunkR) {
  let worst = 0, cnt = 0;
  for (let i = 0; i < out.length; i += 3) {
    if (trunkR && Math.hypot(out[i], out[i + 1]) <= trunkR + 0.05) continue;     // the trunk's own wall (Z axis), not the branch
    const w = sub([out[i], out[i + 1], out[i + 2]], S), s = dot(w, d);
    if (s < L / 4 || s > 3 * L / 4) continue;
    const r = Math.hypot(w[0] - s * d[0], w[1] - s * d[1], w[2] - s * d[2]), want = rb + (rt - rb) * s / L;
    if (r > Math.max(rb, rt) + 1) continue;
    cnt++;
    worst = Math.max(worst, r - want, want * Math.cos(Math.PI / n) - r);
  }
  return { worst, n: cnt };
}
function common(tag, soup, r) {
  check(tag + ': welded on', r.ok, r.reason);
  if (!r.ok) return false;
  const T = topo(r.tris);
  check(tag + ': closed, 2-manifold, wound one way, Euler 2 (one solid of genus 0)', T.open === 0 && T.nm === 0 && T.flip === 0 && T.euler === 2,
        `open ${T.open} nm ${T.nm} flip ${T.flip} euler ${T.euler}`);
  const MV = meshValidate(tag, r.tris);
  check(tag + ': mesh_validate --gate PASS', MV.pass, MV.pass ? 'pierce ' + MV.pierce : (MV.fails || []).join('; '));
  const dv = volume(r.tris) - volume(soup), b = r.branch;
  check(tag + ': the volume grew by what stands out of the wall (within 10%), no more than the branch\'s whole solid',
        dv > 0.9 * b.outsideMm3 && dv <= b.volumeMm3 + 1e-3, f3(dv) + ' mm³ vs ' + f3(b.outsideMm3) + ' out / ' + f3(b.volumeMm3) + ' whole');
  return true;
}
// Limb grabs the branch on its side, `back` mm in from the tip, and bends it `deg`. want: 'bend' (it must bend,
// and the bent piece must pass mesh_validate) or 'either' (it may refuse - in words, the piece unchanged - but
// what it hands back, if anything, must pass). Returns 'bent' or 'refused'.
function limbBend(tag, soup, b, back, deg, toward, want) {
  const rr = b.tipR + (b.rootR - b.tipR) * back / b.lengthMm, grab = b.tip.map((x, k) => x - back * b.dir[k] + rr * b.v[k]);
  const S = L.prepare(soup, grab, {});
  check(tag + ': Limb takes the branch as a limb', S.ok && !S.an.atBase, S.ok ? L.describe(S) : S.reason);
  if (!S.ok) return null;
  L.displaceBy(S, 0, deg, toward);
  const f = L.finish(S, { repair: REPAIR });
  if (want === 'bend') check(tag + ': Limb bends it ' + deg + '° and its guards pass', f.ok, f.ok ? 'pierce ' + f.report.pierce.before + ' → ' + f.report.pierce.after : f.reason);
  if (f.ok) {
    const MV = meshValidate(tag + '_limb', f.tris);
    check(tag + ': ...the bent piece passes mesh_validate', MV.pass, (MV.fails || []).join('; '));
    return 'bent';
  }
  if (want !== 'bend') check(tag + ': refused in words, the piece handed back unchanged', f.tris === soup && /inside out|subdivided cleanly|pass through/.test(f.reason), f.reason);
  return 'refused';
}

(async () => {
  console.log('\n=== 1. reading the rod the press is on ===');
  const R = 15.42, H = 100;
  const rod = NSO_Stock.revolve(NSO_Stock.profileCylinder(R, H), 96);
  const rd = NSO_rodBranchRead(rod, { point: [R, 0, 40] });
  check('Stock rod Ø30.84 × 100: the press reads the rod at Ø30.84, 60 mm in from its top end, radially out along +X',
        rd.ok && Math.abs(2 * rd.at.r - 30.84) < 1e-3 && Math.abs(rd.at.h + 60) < 1e-4 && rd.parent.axis[2] === 1 && Math.abs(rd.at.e[0] - 1) < 1e-9, rd.reason);
  const rEnd = NSO_rodBranchRead(rod, { point: [3, 2, H] });
  check('a press on the flat end is refused: "press on its side"', !rEnd.ok && /that is the rod's flat end \(Ø30\.84\) - press on its side/.test(rEnd.reason), rEnd.reason);
  const tube = NSO_Stock.revolve(NSO_Stock.profileTube(10, 8.4, 40), 96);
  const rTube = NSO_rodBranchRead(tube, { point: [10, 0, 20] });
  check('a tube is refused: no flat round end', !rTube.ok && /this piece has none \(its round end is open: a tube\)/.test(rTube.reason), rTube.reason);
  // the root disc: the depth it is buried, against the two rims, measured
  for (const [r, rb, A] of [[15.42, 7.5, 45], [15.42, 15, 90], [5, 2.5, 20], [5, 4.5, 160], [5, 4.9, 30]]) {
    const e = NSO_rbDepth(r, rb, A * Math.PI / 180, 0.05), a = A * Math.PI / 180;
    if (!isFinite(e)) {
      // no depth roots it: centred on the axis its rim still reaches the wall
      const reach = Math.max(rb * Math.abs(Math.cos(a)), rb);
      check(`root disc Ø${2 * rb} at ${A}° on a Ø${2 * r} rod: no depth roots it (its rim reaches ${f3(reach)} from the axis at best)`, reach > r - 0.05, f3(reach));
      continue;
    }
    let worst = 0;
    for (let k = 0; k < 720; k++) {
      const th = 2 * Math.PI * k / 720, t = Math.cos(th), s = Math.sin(th);
      // in the (radial x, axial z, y) frame of the parent at the press
      const x = r - e * Math.sin(a) + t * rb * Math.cos(a), y = s * rb;
      worst = Math.max(worst, Math.hypot(x, y));
    }
    check(`root disc Ø${2 * rb} at ${A}° on a Ø${2 * r} rod: buried ${f3(e)} mm, every rim point inside the rod by 0.05`, worst <= r - 0.05 + 1e-4, 'farthest ' + f3(worst));
  }

  console.log('\n=== 2. one branch: a plant shoot at 45°, a stub at 90°, a drooping one at 120° ===');
  let tree = rod;
  for (const [z, az, dia, tip, len, ang] of [[40, 0, 15, '', 30, 45], [60, 120, 10, '', 20, 90], [75, 240, 8, 4, 25, 120]]) {
    const ph = az * Math.PI / 180, P = [R * Math.cos(ph), R * Math.sin(ph), z];
    const tag = `rod Ø30.84: branch Ø${dia}${tip ? '→' + tip : ''} × ${len} at ${ang}°`;
    const t0 = Date.now();
    const r = await NSO_rodBranchRaw(tree, { point: P, dia, tipDia: tip, length: len, angle: ang, union });
    const ms = Date.now() - t0;
    console.log('   ' + r.reason);
    if (!common(tag, tree, r)) continue;
    const b = r.branch, M = measure(r.tris, b.wall, b.dir, Math.max(b.rootR, b.tipR));
    check(tag + ': its tip stands ' + len + ' mm out along it (± 0.01)', Math.abs(M.far - len) <= 0.01, f3(M.far));
    const tipD = 2 * M.tipR, want = tip === '' ? dia : tip;
    check(tag + ': its tip Ø' + want + ' (± 0.02, the polygon\'s corners)', Math.abs(tipD - want) <= 0.02, 'Ø' + f3(tipD));
    const off = Math.hypot(...sub(M.tipC, b.tip));
    const angle = Math.acos(dot(sub(M.tipC, P), [0, 0, 1]) / Math.hypot(...sub(M.tipC, P))) * 180 / Math.PI;
    check(tag + ': its tip\'s centre on the line from the press at ' + ang + '° off the axis (± 0.05°)', off < 0.01 && Math.abs(angle - ang) < 0.05, f3(angle) + '°, ' + f3(off) + ' mm off');
    const G = girth(r.tris, b.wall, b.dir, len, dia / 2, want / 2, b.segments, R);
    check(tag + ': along its middle half, every vertex on the taper (its own Ø there, or the polygon\'s flats) within 0.01', G.n > 0 && G.worst <= 0.01, G.n + ' vertices, worst ' + f3(G.worst));
    TABLE.push([tag, tree.length / 9, r.tris.length / 9, ms, 'tip Ø' + f3(tipD) + ', ' + f3(angle) + '°']);
    tree = r.tris;
  }

  console.log('\n=== 3. a branch off a branch, read off the first branch\'s own flat tip ===');
  const first = await NSO_rodBranchRaw(rod, { point: [R, 0, 40], dia: 15, length: 30, angle: 45, union });
  const b1 = first.branch;
  const P2 = [0, 1, 2].map(k => b1.wall[k] + 15 * b1.dir[k] + b1.rootR * b1.v[k]);
  const rd2 = NSO_rodBranchRead(first.tris, { point: P2 });
  check('the press on the first branch reads it: Ø15.00, its axis the branch\'s', rd2.ok && Math.abs(2 * rd2.at.r - 15) < 1e-3 && dot(rd2.parent.axis, b1.dir) > 0.99999, rd2.reason);
  const sub2 = await NSO_rodBranchRaw(first.tris, { point: P2, dia: 6, tipDia: 3, length: 15, angle: 50, union });
  console.log('   ' + sub2.reason);
  if (common('sub-branch Ø6→3 × 15 at 50° off the Ø15 branch', first.tris, sub2)) {
    const M = measure(sub2.tris, sub2.branch.wall, sub2.branch.dir, 3);
    check('...its tip 15 mm out, Ø3', Math.abs(M.far - 15) <= 0.01 && Math.abs(2 * M.tipR - 3) <= 0.02, f3(M.far) + ' / Ø' + f3(2 * M.tipR));
    TABLE.push(['sub-branch Ø6→3 × 15 at 50° off a Ø15 branch', first.tris.length / 9, sub2.tris.length / 9, '', '']);
  }
  const wide = NSO_rodBranchPlan(first.tris, { point: P2, dia: 15, length: 10, angle: 45 });
  check('a branch as wide as the branch it grows from is refused, with the most it may be', !wide.ok && /as wide as the rod it would grow from \(Ø15\.00 there\) or wider - a branch is narrower than its rod: Ø14\.89 at most here/.test(wide.reason), wide.reason);

  console.log('\n=== 4. Limb bends what Branch made ===');
  // SLIM branches - up to about a third of the trunk's Ø, Branch's default - take a grab anywhere along them
  for (const [Rr, dia, ang] of [[R, 8, 45], [R, 6, 60], [5, 5, 45], [R, 10, 90]]) {
    const trunk = NSO_Stock.revolve(NSO_Stock.profileCylinder(Rr, 100), 96);
    const br = await NSO_rodBranchRaw(trunk, { point: [Rr, 0, 40], dia, length: 30, angle: ang, union });
    const tag = `Ø${dia} at ${ang}° on Ø${f3(2 * Rr)}`;
    check(tag + ': welded on, the junction cut from the subdivided wall', br.ok && br.fine === true, br.reason);
    if (!br.ok) continue;
    for (const back of ang === 90 ? [3, 10, 15] : [3, 10, 15, 22]) limbBend(tag + ', grabbed ' + back + ' mm from its tip', br.tris, br.branch, back, 30, br.branch.v, 'bend');
  }
  // a FAT branch (half the trunk's Ø) bends grabbed near its tip; further in, Limb's fork reading (distance from
  // the foot) finds no rings round so fat a root and the bend folds - refused in words, the piece unchanged
  limbBend('the Ø15 45° shoot, grabbed 3 mm from its tip', first.tris, b1, 3, 30, [0, 1, 0], 'bend');
  limbBend('the Ø15 45° shoot, grabbed 15 mm from its tip', first.tris, b1, 15, 30, [0, 1, 0], 'either');
  if (sub2.ok) limbBend('the sub-branch', sub2.tris, sub2.branch, 2, 30, [0, 0, 1], 'either');
  // a TREE of three shoots round the trunk: each one bends, grabbed anywhere
  let tr = rod; const shoots = [];
  for (const [z, az, dia, ang] of [[30, 0, 8, 45], [55, 120, 8, 45], [75, 240, 6, 60]]) {
    const ph = az * Math.PI / 180, r = await NSO_rodBranchRaw(tr, { point: [R * Math.cos(ph), R * Math.sin(ph), z], dia, length: 30, angle: ang, union });
    check(`tree: a Ø${dia} shoot at ${az}° round, ${z} up`, r.ok && r.fine === true, r.reason);
    if (r.ok) { tr = r.tris; shoots.push(r.branch); }
  }
  const MVt = meshValidate('tree of three', tr);
  check('tree of three: mesh_validate --gate PASS', MVt.pass, (MVt.fails || []).join('; '));
  shoots.forEach((b, i) => { for (const back of [3, 15, 22]) limbBend('tree shoot ' + (i + 1) + ', grabbed ' + back + ' mm from its tip', tr, b, back, 30, b.v, 'bend'); });
  // a fourth rooted near the others: its wall there was cut by their unions, the subdivision is not used, and
  // Limb may refuse it (the queued nso_densify.js fix) - but never hands back a broken piece
  {
    const ph = 200 * Math.PI / 180, r = await NSO_rodBranchRaw(tr, { point: [R * Math.cos(ph), R * Math.sin(ph), 45], dia: 5, length: 30, angle: 45, union });
    if (common('tree: a fourth shoot among the others', tr, r)) for (const back of [3, 15]) limbBend('the fourth shoot, grabbed ' + back + ' mm from its tip', r.tris, r.branch, back, 30, r.branch.v, 'either');
  }
  const thin = NSO_Stock.revolve(NSO_Stock.profileCylinder(5, 80), 96);
  const twig = await NSO_rodBranchRaw(thin, { point: [5, 0, 30], dia: 5, length: 25, angle: 45, union });
  if (common('a Ø5 twig on a Ø10 rod at 45°', thin, twig)) for (const deg of [10, 60]) limbBend('the Ø5 twig, ' + deg + '°', twig.tris, twig.branch, 8, deg, [0, 1, 0], 'bend');

  console.log('\n=== 5. refusals, the piece unchanged ===');
  const base = { point: [R, 0, 40], dia: 10, length: 20, angle: 45, union };
  const cases = [
    [{ angle: 15 }, /an angle of 15\.0° off the rod - a branch stands 20° to 160° off it/],
    [{ angle: 170 }, /an angle of 170\.0° off the rod/],
    [{ dia: 0.6 }, /a Ø0\.60 branch is under 0\.80 mm across \(2 nozzle widths at a 0\.4 mm nozzle\)/],
    [{ tipDia: 0.5 }, /a Ø0\.50 tip is under 0\.80 mm across/],
    [{ dia: 31 }, /as wide as the rod it would grow from \(Ø30\.84 there\) or wider/],
    [{ length: 0 }, /enter how far the branch stands out of the wall/],
    [{ dia: '' }, /enter the branch's Ø in mm/],
    [{ point: null }, /press on the side of the rod where the branch grows out/]
  ];
  for (const [o, re] of cases) {
    const r = await NSO_rodBranchRaw(rod, Object.assign({}, base, o));
    check('refused: ' + JSON.stringify(o), !r.ok && r.tris === rod && re.test(r.reason), r.reason);
  }
  const noUnion = await NSO_rodBranchRaw(rod, Object.assign({}, base, { union: () => Promise.resolve({ ok: false, reason: 'the two pieces do not touch' }) }));
  check('a refusal from the boolean is passed on in words, the piece unchanged', !noUnion.ok && noUnion.tris === rod && /the boolean refused the branch \(the two pieces do not touch\)/.test(noUnion.reason), noUnion.reason);

  console.log('\n=== 6. Neck first, then Branch: a necked trunk grows a branch ===');
  // the order that works: Neck rebuilds the trunk between whole rings of its
  // vertices, and a branch's union re-cuts the trunk's long wall triangles, so
  // a trunk is necked before it is branched (Neck after Branch refuses in words)
  const nk = NSO_rodNeckRaw(rod, { point: [R, 0, 70], length: 20, dr: -3 });
  check('a neck on the bare trunk', nk.ok, nk.reason);
  const nb = nk.ok ? await NSO_rodBranchRaw(nk.tris, { point: [R, 0, 30], dia: 10, length: 20, angle: 50, union }) : nk;
  if (nk.ok) common('...then a branch under it', nk.tris, nb);
  const after = NSO_rodNeckRaw(tree, { point: [R, 0, 12], length: 12, dr: -3 });
  check('Neck after Branch is refused in words, the piece unchanged', !after.ok && after.tris === tree, after.reason);

  console.log('\n| piece and branch | in → out triangles | ms | measured |');
  console.log('|---|---|---|---|');
  for (const t of TABLE) console.log('| ' + t.join(' | ') + ' |');
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('FAILED: ' + FAILS.join(' | ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
