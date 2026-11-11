#!/usr/bin/env node
// Headless self-test for nso_square_tube.js (Shape → Tubes with Square tubes on).
//
//   node tools/nso_square_tube_test.js        exit 0 = every gate held
//
// Loads the shipped files with vm, in index.html's order, and welds branches
// with the SHIPPED boolean (tools/nso_csg_node.js: nso_csg.js verbatim on the
// vendored Manifold). Every number is measured on the OUTPUT soup by code that
// shares nothing with the construction: the topology on exact float32 keys by
// a counter written here, the section at a height from the output's own
// vertices (its outside and bore half-sides), the volume by the divergence
// theorem, and tools/mesh_validate.py --gate on every output (its
// self-intersection pass off and NSO_Repair's BVH run instead, as the rod
// branch test does).

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { writeSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');
const REPAIR = require('../NSO_Repair.js').NSO_Repair;
const D = require('../nso_densify.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Date, Promise,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Int8Array, ArrayBuffer, Error, Infinity, NaN
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['NSO_Repair.js', 'nso_thickness.js', 'nso_stock.js', 'nso_section.js', 'nso_bend.js', 'nso_densify.js', 'nso_tube_edge.js',
                 'nso_rod_branch.js', 'nso_tube_neck.js', 'nso_square_tube.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { NSO_SquareTube: SQ, NSO_Stock } = ctx;
const csg = csgContext();
const union = (a, b) => csg.nsoUnionSoups(a, b);
const subtract = (a, b) => csg.nsoSubtractSoups(a, b);

let pass = 0, fail = 0;
const FAILS = [], TABLE = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-square-tube-'));
const f3 = x => (+x).toFixed(3);

function volume(s) {
  let v = 0;
  for (let o = 0; o < s.length; o += 9) {
    v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7]) - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6]) +
         s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]);
  }
  return v / 6;
}
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
// The section of a Z-axis square tube at height z, from the output's own triangles: the outside's half-side (the
// farthest any edge crossing z is from the axis, Chebyshev) and the bore's (the nearest).
function sectionAt(s, z) {
  let out = 0, bore = Infinity, n = 0;
  for (let o = 0; o < s.length; o += 9) {
    for (let k = 0; k < 3; k++) {
      const a = o + 3 * k, b = o + 3 * ((k + 1) % 3), za = s[a + 2], zb = s[b + 2];
      if ((za - z) * (zb - z) > 0 || za === zb) continue;
      const t = (z - za) / (zb - za), x = s[a] + t * (s[b] - s[a]), y = s[a + 1] + t * (s[b + 1] - s[a + 1]);
      const r = Math.max(Math.abs(x), Math.abs(y));
      out = Math.max(out, r); bore = Math.min(bore, r); n++;
    }
  }
  return { out, bore, n };
}
function gates(tag, before, r, eulerWant) {
  check(tag + ': done', r.ok, r.reason);
  if (!r.ok) return false;
  const T = topo(r.tris), T0 = topo(before);
  const ew = eulerWant == null ? T0.euler : eulerWant;
  check(tag + ': closed, 2-manifold, wound one way, Euler ' + ew, T.open === 0 && T.nm === 0 && T.flip === 0 && T.euler === ew,
        `open ${T.open} nm ${T.nm} flip ${T.flip} euler ${T.euler}`);
  const MV = meshValidate(tag, r.tris);
  check(tag + ': mesh_validate --gate PASS, no piercing pairs', MV.pass, MV.pass ? '' : MV.fails.join('; '));
  TABLE.push([tag, before.length / 9, r.tris.length / 9, r.reason]);
  return true;
}

(async () => {
  console.log('\n=== 1. a new square tube, and reading its ends ===');
  const mk = SQ.make(20, 16.8, 40);
  check('square tube 20 / bore 16.8 × 40 is made', mk.ok, mk.reason);
  const tube = mk.soup, T0 = topo(tube);
  check('...closed, 2-manifold, wound one way, Euler 0 (a tube: one through-hole)', T0.open === 0 && T0.nm === 0 && T0.flip === 0 && T0.euler === 0, JSON.stringify(T0));
  check('...its volume is (20² - 16.8²) × 40 = 4710.40 mm³', Math.abs(volume(tube) - 4710.4) < 0.05, f3(volume(tube)));
  const mv0 = meshValidate('square tube', tube);
  check('...mesh_validate --gate PASS', mv0.pass, mv0.fails.join('; '));
  const rdTop = SQ.read(tube, {});
  check('no point: the top end, side 20 / bore 16.8, axis +Z', rdTop.ok && Math.abs(rdTop.end.a - 10) < 1e-6 && Math.abs(rdTop.end.b - 8.4) < 1e-5 &&
        Math.abs(rdTop.end.axis[2] - 1) < 1e-9 && Math.abs(rdTop.end.center[2] - 40) < 1e-6, rdTop.reason);
  const rdBot = SQ.read(tube, { point: [10, 0, 2] });
  check('a click 2 mm up the outside reads the bottom end, axis -Z', rdBot.ok && Math.abs(rdBot.end.axis[2] + 1) < 1e-9 && Math.abs(rdBot.end.center[2]) < 1e-6, rdBot.reason);
  const round = NSO_Stock.revolve(NSO_Stock.profileTube(10, 8.4, 40), 96);
  const rdRound = SQ.read(round, {});
  check('a round tube is refused, pointed at Tubes with Square tubes off', !rdRound.ok && /round tube is Tubes with Square tubes off/.test(rdRound.reason), rdRound.reason);
  // a 10 mm cube, wound outward
  const V = [[0,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,10],[10,0,10],[10,10,10],[0,10,10]];
  const F = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const rdBox = SQ.read(new Float32Array(F.flatMap(f => f.flatMap(i => V[i]))), {});
  check('a box is refused, naming its closed square end', !rdBox.ok && /this piece has none \(its square end is closed: a solid square bar\)/.test(rdBox.reason), rdBox.reason);

  console.log('\n=== 2. Reducer ===');
  let r = SQ.reducer(tube, { side2: 12, bore2: 8.8, transitionMm: 10, runMm: 5, profile: 'straight' });
  if (gates('reducer 20/16.8 → 12/8.8 over 10, run 5', tube, r)) {
    const s1 = sectionAt(r.tris, 52), s0 = sectionAt(r.tris, 20), sm = sectionAt(r.tris, 45);
    check('...the run at z 52 is 12 / bore 8.8', Math.abs(2 * s1.out - 12) < 1e-3 && Math.abs(2 * s1.bore - 8.8) < 1e-3, f3(2 * s1.out) + ' / ' + f3(2 * s1.bore));
    check('...the tube at z 20 is untouched: 20 / 16.8', Math.abs(2 * s0.out - 20) < 1e-4 && Math.abs(2 * s0.bore - 16.8) < 1e-4, f3(2 * s0.out) + ' / ' + f3(2 * s0.bore));
    check('...half-way through the transition (z 45) it is 16 / 12.8', Math.abs(2 * sm.out - 16) < 1e-3 && Math.abs(2 * sm.bore - 12.8) < 1e-3, f3(2 * sm.out) + ' / ' + f3(2 * sm.bore));
    const top = Math.max(...Array.from(r.tris).filter((_, i) => i % 3 === 2));
    check('...it ends 55 mm up, square and open', Math.abs(top - 55) < 1e-4, f3(top));
    const want = (400 - 16.8 * 16.8) * 40 + 10 / 3 * (400 + 240 + 144 - (282.24 + 16.8 * 8.8 + 77.44)) + 5 * (144 - 77.44);
    check('...the volume is the frusta\'s', Math.abs(volume(r.tris) - want) < 0.05, f3(volume(r.tris)) + ' vs ' + f3(want));
    check('...the old wall below the end copied bit for bit', (() => { const k = new Set(); for (let i = 0; i < r.tris.length; i += 9) k.add(Array.from(r.tris.slice(i, i + 9)).join()); let all = true; for (let i = 0; i < tube.length; i += 9) { const zs = [tube[i + 2], tube[i + 5], tube[i + 8]]; if (Math.max(...zs) < 40 - 1e-6 && !k.has(Array.from(tube.slice(i, i + 9)).join())) all = false; } return all; })());
    // and on again: a reducer on the reducer's own end
    const r2 = SQ.reducer(r.tris, { side2: 8, bore2: 5.6, transitionMm: 6, runMm: 4, profile: 'trumpet' });
    if (gates('...then a trumpet reducer on its end: 12/8.8 → 8/5.6 over 6, run 4', r.tris, r2)) {
      const s2 = sectionAt(r2.tris, 63);
      check('......its run is 8 / 5.6', Math.abs(2 * s2.out - 8) < 1e-3 && Math.abs(2 * s2.bore - 5.6) < 1e-3, f3(2 * s2.out) + ' / ' + f3(2 * s2.bore));
    }
  }
  r = SQ.reducer(tube, { side2: 28, bore2: 24.8, transitionMm: 12, runMm: 0, profile: 'trumpet' });
  if (gates('expander 20/16.8 → 28/24.8 over 12, trumpet', tube, r)) {
    const s1 = sectionAt(r.tris, 52 - 1e-3);
    check('...at its lip it is 28 / 24.8', Math.abs(2 * s1.out - 28) < 2e-3 && Math.abs(2 * s1.bore - 24.8) < 2e-3, f3(2 * s1.out) + ' / ' + f3(2 * s1.bore));
    check('...the readout names it', /^Square expander: 20\.00 \/ bore 16\.80 → 28\.00 \/ bore 24\.80 over 12\.0 mm, trumpet/.test(r.reason), r.reason);
  }
  r = SQ.reducer(tube, { point: [10, 0, 1], side2: 14, bore2: 10.8, transitionMm: 8, runMm: 6, profile: 'straight' });
  if (gates('reducer on the BOTTOM end (a click near it): 14/10.8 over 8, run 6', tube, r)) {
    const s1 = sectionAt(r.tris, -12);
    check('...the run below the plate line is 14 / 10.8', Math.abs(2 * s1.out - 14) < 1e-3 && Math.abs(2 * s1.bore - 10.8) < 1e-3, f3(2 * s1.out) + ' / ' + f3(2 * s1.bore));
  }
  r = SQ.reducer(tube, { side2: 20, bore2: 16.8, transitionMm: 0, runMm: 10 });
  gates('straight on: 10 mm more of the same tube', tube, r);
  r = SQ.reducer(tube, { side2: 12, bore2: 11.6, transitionMm: 10, runMm: 0 });
  check('a wall under the floor is refused, naming the widest bore', !r.ok && /under the 0\.42 mm floor .* its bore is 11\.16 at most/.test(r.reason), r.reason);
  r = SQ.reducer(tube, { side2: 2, bore2: 0.6, transitionMm: 10 });
  check('a bore under 2 nozzle widths is refused', !r.ok && /under 0\.80 mm \(2 nozzle widths/.test(r.reason), r.reason);
  r = SQ.reducer(tube, { side2: 4, bore2: 2, transitionMm: 1 });
  check('a transition steeper than 75° is refused, with the length it needs', !r.ok && /stands .*° off the axis - 75° at most/.test(r.reason), r.reason);
  r = SQ.reducer(tube, { side2: 12, bore2: 8.8, transitionMm: 0 });
  check('a 0 mm transition with a change is refused', !r.ok && /transition of 0 mm/.test(r.reason), r.reason);

  console.log('\n=== 3. Neck ===');
  for (const [prof, walls, dr, L, z, waistO, waistI] of [
    ['smooth', 'both', -2, 12, 20, 16, 12.8], ['funnel', 'both', -2, 12, 20, null, 12.8], ['smooth', 'both', 2, 12, 20, 24, 20.8],
    ['smooth', 'outside', -0.8, 10, 15, 18.4, 16.8], ['funnel', 'bore', 0.6, 10, 25, 20, 18]]) {
    const tag = `neck ${prof}, walls ${walls}, Δ ${dr} over ${L} at z ${z}`;
    const n = SQ.neck(tube, { point: [10, 0, z], length: L, dr, profile: prof, walls });
    if (!gates(tag, tube, n)) continue;
    const s = sectionAt(n.tris, z), s0 = sectionAt(n.tris, z + L / 2 + 3);
    if (waistO != null) check('...waist outside ' + waistO, Math.abs(2 * s.out - waistO) < 0.02, f3(2 * s.out));
    check('...waist bore ' + waistI, Math.abs(2 * s.bore - waistI) < 0.02, f3(2 * s.bore));
    check('...past the band the tube is 20 / 16.8', Math.abs(2 * s0.out - 20) < 1e-4 && Math.abs(2 * s0.bore - 16.8) < 1e-4, f3(2 * s0.out) + ' / ' + f3(2 * s0.bore));
    if (walls === 'both') check('...the wall square to its faces is 1.60 through the band (to 0.02)', n.neck.wallMm > 1.58 && n.neck.wallMm < 1.6 + 1e-6, f3(n.neck.wallMm));
  }
  let n1 = SQ.neck(tube, { point: [10, 0, 10], length: 10, dr: -2, profile: 'smooth', walls: 'both' });
  let n2 = n1.ok ? SQ.neck(n1.tris, { point: [10, 0, 30], length: 10, dr: -1.5, profile: 'funnel', walls: 'both' }) : n1;
  if (gates('two necks 10 mm apart (the second on the first\'s output)', n1.ok ? n1.tris : tube, n2)) {
    check('...both waists there: bore 12.8 at z 10, 13.8 at z 30', Math.abs(2 * sectionAt(n2.tris, 10).bore - 12.8) < 0.02 && Math.abs(2 * sectionAt(n2.tris, 30).bore - 13.8) < 0.02,
          f3(2 * sectionAt(n2.tris, 10).bore) + ' / ' + f3(2 * sectionAt(n2.tris, 30).bore));
    const n3 = SQ.neck(n2.tris, { point: [10, 0, 16], length: 10, dr: -1, profile: 'smooth' });
    check('a third neck overlapping the first is refused - necks may not overlap', !n3.ok && /not straight square tube .* Necks may not overlap/.test(n3.reason), n3.reason);
  }
  r = SQ.neck(tube, { point: [10, 0, 3], length: 12, dr: -2 });
  check('a neck running past the end is refused', !r.ok && /would run past the end of the tube \(it is 40\.00 mm long\)/.test(r.reason), r.reason);
  r = SQ.neck(tube, { point: [10, 0, 20], length: 12, dr: -8.2 });
  check('a pinch closing the bore is refused, with the most it may pinch', !r.ok && /would close the bore .* pinches by 8\.00 mm at most/.test(r.reason), r.reason);
  r = SQ.neck(tube, { point: [10, 0, 20], length: 3, dr: -3 });
  check('a smooth neck too short to carry the wall is refused, with the length it needs', !r.ok && /too short to move a 1\.60 mm wall/.test(r.reason), r.reason);
  r = SQ.neck(tube, { point: [10, 0, 20], length: 10, dr: -1.4, walls: 'outside' });
  check('outside only pinching the wall under the floor is refused', !r.ok && /floor is 0\.42/.test(r.reason), r.reason);

  console.log('\n=== 4. Branch (the shipped boolean) ===');
  const tall = SQ.make(20, 16.8, 80).soup;
  let tree = tall, eu = topo(tall).euler;
  const SPEC = [[[10, 0, 30], 10, 7, '', 25, 90], [[-10, 3, 45], 10, 7, '', 30, 45], [[2, 10, 60], 8, 5.6, 6, 20, 30], [[4, -10, 20], 8, 5.6, '', 15, 120]];
  const tips = [];
  for (const [P, dia, bore, tip, len, ang] of SPEC) {
    const tag = `square branch ${dia}/${bore}${tip ? '→' + tip : ''} × ${len} at ${ang}° from [${P}]`;
    const t0 = Date.now();
    const b = await SQ.branch(tree, { point: P, dia, boreDia: bore, tipDia: tip, length: len, angle: ang, union, subtract });
    if (!gates(tag, tree, b, eu - 2)) continue;
    console.log('        ' + (Date.now() - t0) + ' ms, ' + b.tries + ' tr' + (b.tries > 1 ? 'ies' : 'y'));
    const dv = volume(b.tris) - volume(tree);
    check('...the volume grew by what stands out of the wall (within 25%: a shallow foot runs up the wall), no more than its outside solid', dv > 0.75 * b.branch.outsideMm3 && dv <= b.branch.volumeMm3 + 1e-3,
          f3(dv) + ' vs ' + f3(b.branch.outsideMm3));
    // the tip read back as an open square end, at its side and bore
    const rt = SQ.read(b.tris, { point: b.branch.tip });
    const tipSide = tip === '' ? dia : tip;
    check('...its tip reads back as an open square end ' + tipSide + ' / ' + f3(tipSide - (dia - bore)), rt.ok && Math.abs(2 * rt.end.a - tipSide) < 2e-3 &&
          Math.abs(2 * rt.end.b - (tipSide - (dia - bore))) < 2e-3 && Math.abs(rt.end.center[0] - b.branch.tip[0]) < 1e-3, rt.reason);
    tips.push(b.branch);
    tree = b.tris; eu -= 2;
  }
  // a branch off a branch: pressed on the 45° one's side
  if (tips[1]) {
    const B = tips[1], P = B.wall.map((x, k) => x + 15 * B.dir[k] + B.rootR * B.v[k]);
    const b = await SQ.branch(tree, { point: P, dia: 5, boreDia: 3, length: 12, angle: 60, union, subtract });
    if (gates('a branch off the 45° branch, 5/3 × 12 at 60°', tree, b, eu - 2)) { tree = b.tris; eu -= 2; }
  }
  // a reducer on a branch's tip, and a neck on the trunk away from the branches
  if (tips[0]) {
    const r3 = SQ.reducer(tree, { point: tips[0].tip, side2: 5, bore2: 3, transitionMm: 5, runMm: 5, profile: 'straight' });
    if (gates('a reducer on the 90° branch\'s tip: 10/7 → 5/3 over 5, run 5', tree, r3)) tree = r3.tris;
  }
  const nT = SQ.neck(tree, { point: [10, 0, 75], length: 6, dr: -1, profile: 'smooth' });
  gates('a neck on the trunk above the branches', tree, nT);
  const nX = SQ.neck(tree, { point: [10, 0, 30], length: 8, dr: -1, profile: 'smooth' });
  check('a neck across a branch\'s junction is refused', !nX.ok && /not straight square tube/.test(nX.reason), nX.reason);
  // refusals
  let q = SQ.branchPlan(tall, { point: [10, 0, 30], dia: 20, boreDia: 16, length: 10, angle: 90 });
  check('a branch as wide as the face is refused', !q.ok && /as wide as the face/.test(q.reason), q.reason);
  q = SQ.branchPlan(tall, { point: [10, 0, 30], dia: 8, boreDia: 7.6, length: 10, angle: 90 });
  check('a branch wall under the floor is refused', !q.ok && /under the 0\.42 mm floor/.test(q.reason), q.reason);
  q = SQ.branchPlan(tall, { point: [8.4, 0, 30], dia: 8, boreDia: 5, length: 10, angle: 90 });
  check('a press on the bore is refused', !q.ok && /that is the tube's bore/.test(q.reason), q.reason);
  q = SQ.branchPlan(tall, { point: [3, 9.5, 80], dia: 8, boreDia: 5, length: 10, angle: 90 });
  check('a press on the open end is refused', !q.ok && /open end/.test(q.reason), q.reason);
  q = SQ.branchPlan(tall, { point: [10, 8, 30], dia: 8, boreDia: 5, length: 10, angle: 90 });
  check('a press near a corner moves the foot along the face to keep it there', q.ok && Math.abs(q.branch.wall[1] - (8.4 - 2.5 - 0.05)) < 1e-6 && /moved 2\.15 mm along the face/.test(q.reason), q.reason);
  q = SQ.branchPlan(tall, { point: [10, 0, 30], dia: 8, boreDia: 5, length: 10, angle: 10 });
  check('an angle under 20° is refused', !q.ok && /20° to 160°/.test(q.reason), q.reason);

  console.log('\n  piece and treatment                                              in → out tris');
  TABLE.forEach(t => console.log('  ' + t[0].padEnd(64) + String(t[1]).padStart(7) + ' → ' + String(t[2]).padEnd(7)));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('FAILED:\n  ' + FAILS.join('\n  ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
