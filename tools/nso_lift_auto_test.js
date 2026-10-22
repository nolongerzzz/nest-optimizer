#!/usr/bin/env node
/* Lift 2 (auto-aim and Strip) - headless. node tools/nso_lift_auto_test.js   exit 0 = every gate held

   READ docs/LIFT.md, "Lift 2". Every fixture is generated here
   (tools/nso_lift_auto_fixtures.js, tools/nso_lift_fixtures.js) - never
   anyone's model or G-code:

     1. a flat plate: dots, a line, an S, a ring, two dots fused into one
        body, a mushroom (an undercut). The map finds exactly Phase 1's
        islands, triangle for triangle; Strip's groups; each detail lifts
        alone with every gate; Strip with a group unticked lifts exactly the
        ticked ones; Remove leaves the plate flat and closed.
     2. Phase 1's own plate (56 details): the same 56 islands.
     3. a gently curved dish: dots lift, each at its own tilted plane; a long
        squiggle is refused in words because the dish bends under it.
     4. the Picture relief slab (camera.png, as Phase 1's test).
     5. paper that is not flat (+-0.08 mm of noise): what it does, in words.
     6. a base of 0.2 mm layer steps: no step reads as a detail.
     7. leaves that touch: one island; where a watershed would split it (data).
     8. refusals, the coarsened map, the replaceable base estimator.
     9. speed: the map of 0.5 million triangles.
    10. where the 0.15 mm bend tolerance bites: bars of 2 - 20 mm on bowls of
        radius 300, 150, 60 and 30 mm.
    11. the canonical checker (tools/mesh_validate.py) on pieces and plates. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const pace = require('./nso_pace.js');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-lift-auto-'));
const { writeSTL } = require('./nso_stl_io.js');
const { readPNG } = require('./nso_png.js');
const FX = require('./nso_lift_auto_fixtures.js');
const FX1 = require('./nso_lift_fixtures.js');
const L = require(path.join(ROOT, 'nso_lift.js'));
const LA = require(path.join(ROOT, 'nso_lift_auto.js'));
const R = require(path.join(ROOT, 'nso_relief.js'));

const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, Float32Array, Float64Array,
  Int32Array, Uint8Array, Error, Infinity, NaN, isFinite };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-cut.js'), 'utf8'), ctx, { filename: 'app-cut.js' });
const CAP = ctx.rawFlatCapLoops;
const DEPS = { rawFlatCapLoops: CAP };

let pass = 0, fail = 0;
const FAILS = [], REPORT = [];
function check(name, cond, detail) {
  if (cond) pass++; else { fail++; FAILS.push(name); }
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined ? '   ' + detail : ''));
}
function quiet(fn) {
  const save = console.log, lines = [];
  console.log = s => lines.push(s);
  let r;
  try { r = fn(); } finally { console.log = save; }
  const bad = lines.filter(s => /FAIL/.test(s));
  bad.forEach(s => console.log(s));
  return { r, lines: lines.length, bad: bad.length };
}
const f3 = x => Number(x).toFixed(3);
const f2 = x => Number(x).toFixed(2);

/* ---------------------------------------------------------------- helpers */

function triNormal(s, t) {
  const o = t * 9;
  const u = [s[o + 3] - s[o], s[o + 4] - s[o + 1], s[o + 5] - s[o + 2]];
  const v = [s[o + 6] - s[o], s[o + 7] - s[o + 1], s[o + 8] - s[o + 2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}
function sameTri(a, ta, b, tb) { for (let q = 0; q < 9; q++) if (a[ta * 9 + q] !== b[tb * 9 + q]) return false; return true; }
function duplicates(s) {
  const seen = new Set();
  let d = 0;
  for (let t = 0; t < s.length / 9; t++) {
    const k = [0, 1, 2].map(k2 => s[t * 9 + k2 * 3] + ',' + s[t * 9 + k2 * 3 + 1] + ',' + s[t * 9 + k2 * 3 + 2]).sort().join('|');
    if (seen.has(k)) d++; else seen.add(k);
  }
  return d;
}
/* Triangles [from, to) of s against plane n.p = d: every corner within tol,
   which way they face, their area. */
function onPlane(s, from, to, n, d, tol) {
  let off = 0, facing = 0, against = 0, area = 0;
  for (let t = from; t < to; t++) {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      off = Math.max(off, Math.abs(s[o] * n[0] + s[o + 1] * n[1] + s[o + 2] * n[2] - d));
    }
    const c = triNormal(s, t), dn = c[0] * n[0] + c[1] * n[1] + c[2] * n[2];
    area += Math.hypot(c[0], c[1], c[2]) / 2;
    if (dn > 0) facing++; else against++;
  }
  return { off, facing, against, area, all: off <= tol };
}
function seedNear(s, x, y, z) {
  let b = -1, bd = Infinity;
  for (let t = 0; t < s.length / 9; t++) {
    const o = t * 9;
    if (triNormal(s, t)[2] <= 0) continue;
    if (z != null && !(s[o + 2] === z && s[o + 5] === z && s[o + 8] === z)) continue;
    const cx = (s[o] + s[o + 3] + s[o + 6]) / 3, cy = (s[o + 1] + s[o + 4] + s[o + 7]) / 3;
    const dd = Math.hypot(cx - x, cy - y);
    if (dd < bd) { bd = dd; b = t; }
  }
  return b;
}
function islandAt(A, x, y, r) {
  let best = null, bd = Infinity;
  A.islands.forEach(I => { const d = Math.hypot(I.center[0] - x, I.center[1] - y); if (d < bd) { bd = d; best = I; } });
  return bd < (r || 1) ? best : null;
}
let seq = 0;
function validate(soup, name) {
  const f = path.join(OUT, (name || 'p' + seq++) + '.stl');
  writeSTL(f, soup);
  const j = JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--json'], { maxBuffer: 64 << 20 }).toString());
  const si = j.self_intersection || {};
  j.summary = j.verdict + ' open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' chi ' + j.euler_characteristic +
    ' pierce ' + si.pierce + ' coplanar ' + si.coplanar;
  j.clean = j.verdict === 'PASS' && si.pierce === 0 && si.coplanar === 0;
  return j;
}

/* Every gate a lift of ONE island owes, at the island's own plane. */
function lifted(tag, src, A, I, truth) {
  const r = LA.lift(src, A, [I.id], DEPS);
  check(tag + ': lifts', r.ok, r.reason);
  if (!r.ok) return null;
  const pc = r.pieces[0], ps = pc.soup, c = L.census(ps), n = I.plane.n, d = I.plane.d;
  const bendTol = Math.max(I.rootBendMm || 0, 0) + 1e-5;
  check(tag + ': the piece is closed and manifold', c.closed && c.degen === 0, c.tris + ' tris, chi ' + c.chi);
  const nT = ps.length / 9, back = onPlane(ps, nT - pc.capTris, nT, n, d, bendTol);
  check(tag + ': its back lies on its own plane (within the ' + f3(I.rootBendMm) + ' mm its root bends) and faces into the plate',
    back.all && back.facing === 0 && back.against === pc.capTris,
    pc.capTris + ' back triangles, ' + f3(back.area) + ' mm², ' + f3(back.off) + ' mm off; plane n (' + n.map(x => x.toFixed(4)).join(', ') + ')');
  check(tag + ': no duplicate faces', duplicates(ps) === 0);
  let same = true;
  I.tris.forEach((t, i) => { if (!sameTri(ps, i, src, t)) same = false; });
  check(tag + ': the piece is the detail\'s own triangles, bit for bit, plus its back', same && c.tris === I.tris.length + pc.capTris);
  if (truth && truth.volume != null) {
    check(tag + ': the piece is the volume the generator built', Math.abs(pc.volume - truth.volume) < 1e-6 * Math.max(1, truth.volume),
      f3(pc.volume) + ' of ' + f3(truth.volume) + ' mm³');
  }
  const pl = r.plate, pcs = LA.census(pl);
  check(tag + ': the plate stays closed and manifold', pcs.closed && pcs.degen === 0, pcs.tris + ' tris, chi ' + pcs.chi);
  const drop = new Set(I.tris);
  let k = 0, unchanged = true;
  for (let t = 0; t < src.length / 9; t++) { if (drop.has(t)) continue; if (!sameTri(pl, k, src, t)) unchanged = false; k++; }
  check(tag + ': every other triangle of the plate is the source\'s, in order, bit for bit', unchanged && k === r.keptTris, k + ' kept');
  const added = onPlane(pl, k, pl.length / 9, n, d, bendTol);
  check(tag + ': where it stood the plate is flat: every new triangle on that plane, facing out, filling exactly the back',
    added.all && added.against === 0 && Math.abs(added.area - back.area) < 1e-9 * Math.max(1, back.area),
    (pl.length / 9 - k) + ' new, ' + f3(added.area) + ' mm²');
  const resid = r.volumes.source - r.volumes.plate - r.volumes.pieces;
  check(tag + ': plate + piece = source', Math.abs(resid) < 1e-7 * Math.abs(r.volumes.source),
    f3(r.volumes.plate) + ' + ' + f3(r.volumes.pieces) + ' = ' + f3(r.volumes.source) + ' (residual ' + resid.toExponential(2) + ')');
  return r;
}
function liftEach(tag, src, A, ids) {
  let ok = 0;
  ids.forEach(id => { const q = quiet(() => lifted(tag + ' ' + id, src, A, A.islands[id])); if (!q.bad && q.r) ok++; });
  check(tag + ': each of the ' + ids.length + ' lifts alone with every gate', ok === ids.length, ok + ' of ' + ids.length);
}
/* Remove: the plate closed, flat where they stood, volumes, and a fresh read
   of it finds none of them. */
function removed(tag, src, A, ids, seedAt) {
  const r = LA.remove(src, A, ids, DEPS);
  check(tag + ': Remove ' + ids.length + ' - the plate is closed and manifold', r.ok && r.plateCensus.closed && r.plateCensus.degen === 0,
    r.ok ? r.reason : r.reason);
  if (!r.ok) return null;
  check(tag + ': ...no pieces are made, and plate + what went = the original', !r.pieces &&
    Math.abs(r.volumes.source - r.volumes.plate - r.volumes.removed) < 1e-7 * Math.abs(r.volumes.source),
    f3(r.volumes.plate) + ' + ' + f3(r.volumes.removed) + ' = ' + f3(r.volumes.source));
  const backs = r.removed.every(x => x.backOffMm <= A.islands[x.id].rootBendMm + 1e-5);
  check(tag + ': ...and it is flat where each stood, at that one\'s own plane', backs,
    'off by at most ' + f3(Math.max(...r.removed.map(x => x.backOffMm))) + ' mm');
  const A2 = LA.analyse(r.plate, seedNear(r.plate, seedAt[0], seedAt[1], seedAt[2]));
  return { r, A2 };
}

/* ======================================================= 1. the flat plate */

console.log('\n=== 1. a flat plate: five dots, a line, an S, a ring, two dots fused, a mushroom ===');
const FL = FX.flat(CAP), FS = FL.soup, fsCopy = new Float32Array(FS);
check('fixture: closed and manifold', L.census(FS).closed, L.census(FS).tris + ' tris');
const fSeed = seedNear(FS, 26, 26, 3);
const AF = LA.analyse(FS, fSeed);
check('a click on the top reads the plate as a height map', AF.ok && AF.kind === 'map', AF.reason);
check('looking straight down: the view is +Z exactly', AF.map.normal.join() === '0,0,1', AF.map.normal.join());
check('10 details found, all can be lifted', AF.islands.length === 10 && AF.liftable === 10, AF.islands.length + ' / ' + AF.liftable);
const P1F = L.analyse(FS, fSeed);
const key = I => I.tris.slice().sort((a, b) => a - b).join(',');
check('...exactly Phase 1\'s islands, triangle for triangle', JSON.stringify(P1F.islands.map(key).sort()) === JSON.stringify(AF.islands.map(key).sort()),
  P1F.islands.length + ' in Phase 1');
check('every island\'s plane is z = 3 exactly', AF.islands.every(I => I.plane.n.join() === '0,0,1' && I.plane.d === 3 && I.rootBendMm === 0));
const kinds = {};
FL.truth.forEach(t => { const I = islandAt(AF, t.center[0], t.center[1], 1); t.island = I; (kinds[t.kind] = kinds[t.kind] || []).push(t); });
check('every detail the generator made is one island where it was made', FL.truth.every(t => t.island));
Object.keys(kinds).forEach(k => {
  const L0 = kinds[k];
  check(k + ' (' + L0.length + '): ' + f3(L0[0].island.heightMm) + ' mm high, group "' + L0[0].island.group + '"',
    L0.every(t => Math.abs(t.island.heightMm - t.heightMm) < 1e-6), L0.map(t => f2(t.island.areaMm2) + ' mm², ' + f2(t.island.widthMm) + ' wide').join('; '));
});
const grp = AF.groups;
check('Strip\'s groups: 6 small dots (the five, and the fused pair), 3 lines & squiggles (line, S, ring), 1 large shape (the mushroom), none can\'t-lift',
  grp.dots === 6 && grp.lines === 3 && grp.large === 1 && grp.cant === 0 &&
  kinds.dot.every(t => t.island.group === 'dots') && kinds.pair[0].island.group === 'dots' &&
  ['line', 'squiggle', 'ring'].every(k => kinds[k][0].island.group === 'lines') && kinds.mushroom[0].island.group === 'large', JSON.stringify(grp));
FL.truth.forEach(t => {
  const q = quiet(() => lifted(t.kind, FS, AF, t.island, t));
  if (!q.bad) console.log('  ok    ' + t.kind + ' at (' + t.center.join(', ') + ') lifts alone: all ' + q.lines + ' gates');
  t.lift = q.r;
});
const mush = kinds.mushroom[0].lift && kinds.mushroom[0].lift.pieces[0];
if (mush) {
  let under = 0;
  for (let t = 0; t < mush.soup.length / 9 - mush.capTris; t++) {
    const nn = triNormal(mush.soup, t), z = (mush.soup[t * 9 + 2] + mush.soup[t * 9 + 5] + mush.soup[t * 9 + 8]) / 3;
    if (nn[2] < 0 && z > 3.5) under++;
  }
  check('the mushroom keeps its undercut: the cap\'s underside comes with it, facing down, 0.8 mm up', under > 0, under + ' triangles');
}
const ringPc = kinds.ring[0].lift && kinds.ring[0].lift.pieces[0];
check('the ring lifts as a ring: genus 1 (chi 0), its bore open', ringPc && ringPc.census.chi === 0, ringPc && 'chi ' + ringPc.census.chi);
// Strip: lines & squiggles unticked
const ticked = AF.islands.filter(I => I.group === 'dots' || I.group === 'large').map(I => I.id);
const SL1 = LA.lift(FS, AF, ticked, DEPS);
check('Strip, lines & squiggles unticked: Lift 7 makes exactly the 7 ticked pieces', SL1.ok && SL1.pieces.length === 7 &&
  JSON.stringify(SL1.pieces.map(p => p.id).sort((a, b) => a - b)) === JSON.stringify(ticked.slice().sort((a, b) => a - b)), SL1.ok ? SL1.reason : SL1.reason);
check('...each closed, and plate + pieces = the original', SL1.ok && SL1.pieces.every(p => p.census.closed) && L.census(SL1.plate).closed &&
  Math.abs(SL1.volumes.residual) < 1e-7 * SL1.volumes.source, SL1.ok && f3(SL1.volumes.plate) + ' + ' + f3(SL1.volumes.pieces) + ' = ' + f3(SL1.volumes.source));
const AF2 = LA.analyse(SL1.plate, seedNear(SL1.plate, 26, 26, 3));
check('...and the unticked ones stay on the plate: a fresh read finds the 3 lines & squiggles and nothing else',
  AF2.ok && AF2.islands.length === 3 && AF2.islands.every(I => I.group === 'lines'), AF2.ok ? JSON.stringify(AF2.groups) : AF2.reason);
const RF = removed('flat plate', FS, AF, LA.offered(AF, 0.42), [26, 26, 3]);
if (RF) {
  check('flat plate: after Remove a fresh read finds nothing standing on it', RF.A2.ok && RF.A2.islands.length === 0, RF.A2.reason);
  const P1R = L.analyse(RF.r.plate, seedNear(RF.r.plate, 26, 26, 3));
  check('...Phase 1 agrees: one flat face of 3600 mm², nothing on it; the plate is the bare 10800 mm³ slab',
    P1R.ok && P1R.islands.length === 0 && Math.abs(P1R.base.areaMm2 - 3600) < 1e-6 && Math.abs(RF.r.volumes.plate - 10800) < 1e-6,
    P1R.ok ? f3(P1R.base.areaMm2) + ' mm², ' + f3(RF.r.volumes.plate) + ' mm³' : P1R.reason);
}
check('nothing here wrote to the source: it is bit for bit what it was', FS.every((v, i) => v === fsCopy[i]));
check('NSO_LiftAuto.census counts exactly as Phase 1\'s census (source, a plate, a piece)', [FS, SL1.plate, SL1.pieces[0].soup].every(x => JSON.stringify(LA.census(x)) === JSON.stringify(L.census(x))));

/* =================================================== 2. Phase 1's own plate */

console.log('\n=== 2. Phase 1\'s plate (tools/nso_lift_fixtures.js): 56 details ===');
const PL = FX1.plate(CAP);
const pSeed = seedNear(PL.soup, 26, 26, 3);
const AP = LA.analyse(PL.soup, pSeed), P1P = L.analyse(PL.soup, pSeed);
check('the map finds Phase 1\'s 56 islands, triangle for triangle, all liftable',
  AP.ok && AP.liftable === 56 && JSON.stringify(P1P.islands.map(key).sort()) === JSON.stringify(AP.islands.map(key).sort()), AP.reason);
check('...including the 48 packed bumps (2.5 mm apart), each measured on the face between them',
  AP.islands.filter(I => I.triangles === 10 && Math.abs(I.heightMm - 0.5) < 1e-6).length === 48);
const PAll = LA.lift(PL.soup, AP, LA.offered(AP, 0.42), DEPS);
check('all 56 lift: the plate is the bare 60 x 60 x 3 slab, closed', PAll.ok && L.census(PAll.plate).closed && Math.abs(PAll.volumes.plate - 10800) < 1e-6 &&
  Math.abs(PAll.volumes.residual) < 1e-7 * PAll.volumes.source, PAll.ok && f3(PAll.volumes.plate) + ' + ' + f3(PAll.volumes.pieces));

/* ================================================================ 3. dish */

console.log('\n=== 3. a gently curved dish (radius of curvature 150 mm): six dots and a long squiggle ===');
const DS = FX.dish(), DSo = DS.soup;
check('fixture: closed', L.census(DSo).closed, DSo.length / 9 + ' tris');
const dSeed = seedNear(DSo, 30, 35);
const P1D = L.analyse(DSo, dSeed);
check('Phase 1 refuses it: the face is curved', !P1D.ok && P1D.refused === 'curved', P1D.reason);
const AD = LA.analyse(DSo, dSeed);
check('the map reads it', AD.ok, AD.reason);
const dDots = DS.truth.filter(t => t.kind === 'dot').map(t => islandAt(AD, t.center[0], t.center[1], 1.5));
const dSq = islandAt(AD, 30, 24, 3);
check('7 details: the six dots and the squiggle, nothing else (the dish itself never reads as one)', AD.islands.length === 7 && dDots.every(Boolean) && dSq,
  AD.islands.length + ' found, ' + AD.map.ghosts + ' map-only');
check('every dot can be lifted, each at its own plane, tilted with the dish', dDots.every(I => I && I.status === 'ok') &&
  dDots.filter(I => I.plane.n[2] < 0.9999).length >= 4, dDots.map(I => I && (Math.acos(I.plane.n[2]) * 180 / Math.PI).toFixed(1) + '°').join(', '));
check('the squiggle is refused in words: the dish bends under it', dSq && dSq.status === 'bends' && /bends too much for a flat cut/.test(dSq.reason) &&
  dSq.group === 'cant', dSq && dSq.reason);
REPORT.push('dish: dots bend ' + dDots.map(I => f3(I.bendMm)).join(' / ') + ' mm (lift); the 40 mm squiggle ' + f3(dSq.bendMm) + ' mm (refused)');
liftEach('dish dot', DSo, AD, dDots.map(I => I.id));
const dOne = lifted('the middle dot', DSo, AD, dDots[0]);
const dTry = LA.lift(DSo, AD, [dSq.id], DEPS);
check('Lift on the squiggle says why and makes nothing', !dTry.ok && /bends too much/.test(dTry.reason), dTry.reason);
const RD = removed('dish', DSo, AD, dDots.map(I => I.id), [30, 35]);
if (RD) check('dish: after Remove a fresh read finds only the squiggle, still refused', RD.A2.ok && RD.A2.islands.length === 1 && RD.A2.islands[0].status === 'bends',
  RD.A2.ok ? RD.A2.islands.map(I => I.status).join() : RD.A2.reason);

/* ========================================================= 4. the slab */

console.log('\n=== 4. the Picture relief slab: camera.png, Levels 2, 40 mm at 0.4 mm ===');
const PHOTO = readPNG(path.join(ROOT, 'fixtures', 'relief', 'camera.png'));
const slab = R.build(PHOTO, { widthMm: 40, sampleMm: 0.4, baseMm: 2, reliefMm: 2, levels: 2 });
const SLo = slab.rawTris;
let sSeed = -1, sbd = Infinity;
for (let t = 0; t < SLo.length / 9; t++) {
  if (!(SLo[t * 9 + 2] === 2 && SLo[t * 9 + 5] === 2 && SLo[t * 9 + 8] === 2) || triNormal(SLo, t)[2] <= 0) continue;
  const dd = Math.hypot((SLo[t * 9] + SLo[t * 9 + 3] + SLo[t * 9 + 6]) / 3 - 20, (SLo[t * 9 + 1] + SLo[t * 9 + 4] + SLo[t * 9 + 7]) / 3 - 36);
  if (dd < sbd) { sbd = dd; sSeed = t; }
}
const AS = LA.analyse(SLo, sSeed), P1S = L.analyse(SLo, sSeed);
check('a click on the paper reads the slab', AS.ok, AS.reason);
const sSt = {};
AS.islands.forEach(I => { sSt[I.status] = (sSt[I.status] || 0) + 1; });
const sOff = LA.offered(AS, 0.42), p1Off = L.offered(P1S, 0.42).map(id => P1S.islands[id]);
check('Phase 1\'s two offered details (0.69 and 1.85 mm) are found and offered here too',
  p1Off.every(J => sOff.some(id => Math.abs(AS.islands[id].heightMm - J.heightMm) < 0.02 && Math.hypot(AS.islands[id].center[0] - J.center[0], AS.islands[id].center[1] - J.center[1]) < 1)),
  p1Off.map(J => f2(J.heightMm)).join(', '));
check('what reaches the slab\'s sides is refused by name; every refusal says why', AS.islands.filter(I => I.status !== 'ok').every(I => I.reason && I.reason.length > 20) &&
  (sSt.edge || 0) >= 1, JSON.stringify(sSt));
REPORT.push('slab: ' + AS.islands.length + ' islands ' + JSON.stringify(sSt) + '; offered at 0.42: ' + sOff.map(id => f2(AS.islands[id].heightMm) + ' (back ' + f3(AS.islands[id].rootBendMm) + ')').join(', '));
AS.islands.filter(I => I.status !== 'ok').forEach(I => REPORT.push('  slab refused ' + I.id + ' (' + f2(I.heightMm) + ' mm, ' + I.triangles + ' tris): ' + I.reason));
liftEach('slab island', SLo, AS, sOff);
const sAll = LA.lift(SLo, AS, sOff, DEPS);
check('all of them together: the slab stays closed, the volumes add up', sAll.ok && L.census(sAll.plate).closed && Math.abs(sAll.volumes.residual) < 1e-7 * sAll.volumes.source,
  sAll.ok ? f3(sAll.volumes.plate) + ' + ' + f3(sAll.volumes.pieces) + ' = ' + f3(sAll.volumes.source) : sAll.reason);

/* ========================================================= 5. noisy paper */

console.log('\n=== 5. paper that is not flat: +-0.08 mm of noise, three blobs and a bar, 1 mm high ===');
const NZ = FX.noisy(0.08), NZo = NZ.soup;
const nSeed = seedNear(NZo, 20, 20);
const P1N = L.analyse(NZo, nSeed);
check('Phase 1 has no flat face to stand on here', !P1N.ok || P1N.base.areaMm2 < 1, P1N.ok ? P1N.base.areaMm2 + ' mm² flat' : P1N.reason);
const AN = LA.analyse(NZo, nSeed);
check('the map finds the four, and no noise as a detail', AN.ok && AN.islands.length === 4 && NZ.truth.every(t => islandAt(AN, t.center[0], t.center[1], 1.5)),
  AN.ok ? AN.islands.length + ' found, ' + AN.map.ghosts + ' map-only' : AN.reason);
check('...all four lift, each at a cut fitted to where it meets the paper', AN.liftable === 4,
  AN.islands.map(I => f3(I.rootBendMm)).join(' / ') + ' mm off flat');
REPORT.push('noisy paper (+-0.08): ' + AN.islands.length + ' found, ' + AN.liftable + ' lift; each back follows the paper within ' +
  AN.islands.map(I => f3(I.rootBendMm)).join(' / ') + ' mm; heights ' + AN.islands.map(I => f3(I.heightMm)).join(' / '));
liftEach('noisy', NZo, AN, LA.offered(AN, 0.42));
const AN2 = LA.analyse(FX.noisy(0.16).soup, nSeed);
REPORT.push('noisy paper (+-0.16): ' + (AN2.ok ? AN2.islands.length + ' found ' + JSON.stringify(AN2.groups) + ', ' + AN2.map.ghosts + ' map-only; ' +
  AN2.islands.map(I => I.status + ' (ring ' + f3(I.bendMm) + ', root ' + f3(I.rootBendMm) + ')').join(', ') : AN2.reason));

/* ======================================================= 6. layer steps */

console.log('\n=== 6. a base of 0.2 mm layer steps (5 mm terraces) with details ===');
const SP = FX.stepped(), SPo = SP.soup;
const stSeed = seedNear(SPo, 2.5, 30);
const P1T = L.analyse(SPo, stSeed);
check('Phase 1, on one terrace: the higher terraces are one thing "part of the body", and nothing can be lifted - why a print needs the map',
  P1T.ok && P1T.islands.length === 1 && P1T.islands[0].status === 'edge' && P1T.liftable === 0, P1T.ok ? P1T.reason : P1T.reason);
const AT = LA.analyse(SPo, stSeed);
check('the map finds the six details and no step', AT.ok && AT.islands.length === 6 && SP.truth.every(t => islandAt(AT, t.center[0], t.center[1], 1.5)),
  AT.ok ? AT.islands.length + ' found, groups ' + JSON.stringify(AT.groups) : AT.reason);
check('...all six lift', AT.liftable === 6, AT.islands.map(I => f3(I.rootBendMm)).join(' / ') + ' mm off flat where they meet the steps');
SP.truth.forEach(t => { const I = islandAt(AT, t.center[0], t.center[1], 1.5); if (I) REPORT.push('steps: ' + t.kind + ' - ring ' + f3(I.bendMm) + ' mm, root ' + f3(I.rootBendMm) + ' mm, ' + I.status); });
liftEach('stepped', SPo, AT, LA.offered(AT, 0.42));
const RT = removed('steps', SPo, AT, LA.offered(AT, 0.42), [2.5, 30]);
if (RT) check('steps: after Remove a fresh read finds nothing', RT.A2.ok && RT.A2.islands.length === 0, RT.A2.reason);

/* ============================================================ 7. leaves */

console.log('\n=== 7. leaves that touch: three at a stem, one apart ===');
const LV = FX.leaves(), LVo = LV.soup;
const AL = LA.analyse(LVo, seedNear(LVo, 5, 5));
const cl = islandAt(AL, 21, 20, 2), lone = islandAt(AL, 40, 20, 1);
check('two islands: the three touching leaves are one body, the lone leaf another', AL.ok && AL.islands.length === 2 && cl && lone, AL.ok && AL.islands.length + '');
check('both are large shapes and both lift', cl && lone && cl.group === 'large' && lone.group === 'large' && AL.liftable === 2);
check('4b, data only: a watershed on the smoothed distance transform would divide the cluster in 3, the lone leaf not at all',
  cl && cl.necks.parts === 3 && lone.necks.parts === 1,
  cl && cl.necks.necks.map(nk => 'neck ' + f2(nk.widthMm) + ' mm at (' + nk.atMm.map(f2).join(', ') + ') between parts ' + nk.partsMm.map(f2).join(' / ') + ' mm wide').join('; '));
if (cl) REPORT.push('leaves (4b data): cluster parts ' + cl.necks.parts + ': ' + cl.necks.necks.map(nk => f2(nk.widthMm) + ' mm neck at (' + nk.atMm.map(f2).join(', ') + ')').join('; '));
liftEach('leaf', LVo, AL, LA.offered(AL, 0.42));

/* ======================================================== 8. refusals etc. */

console.log('\n=== 8. refusals, the coarsened map, the replaceable base ===');
const dotTop = kinds.dot[2].island.tris.find(t => triNormal(FS, t)[2] > 0 && FS[t * 9 + 2] > 3.5);
const onDot = LA.analyse(FS, dotTop);
check('a click on a detail, not the face, is refused in words', !onDot.ok && onDot.refused === 'onDetail' && /not on the face itself/.test(onDot.reason), onDot.reason);
const noSeed = LA.analyse(FS, FS.length / 9 + 5);
check('a click on no triangle is refused', !noSeed.ok && /not on a triangle/.test(noSeed.reason), noSeed.reason);
check('nothing chosen: Lift and Remove say so', /nothing is chosen/.test(LA.lift(FS, AF, [], DEPS).reason) && /nothing is chosen/.test(LA.remove(FS, AF, [], DEPS).reason));
const BIGBOX = FX.box(600, 500, 2);
const AB = LA.analyse(BIGBOX, 2);
check('a 600 x 500 mm piece: the map is made coarser and says so in words', AB.ok && AB.map.cellMm > 0.25 && AB.map.cells <= 4e6 &&
  /would be 4\.8 million cells, over the 4 million it keeps - so it is read at 0\.28 mm per cell/.test(AB.map.coarsened) && AB.reason.indexOf(AB.map.coarsened) >= 0,
  AB.map.coarsened);
const keep = LA.estimateBase;
let called = 0;
LA.estimateBase = (map, o) => { called++; const r = keep(map, o); return r; };
const AR = LA.analyse(FS, fSeed);
LA.estimateBase = keep;
check('the base estimator is one replaceable function (NSO_LiftAuto.estimateBase)', called === 1 && AR.ok && AR.islands.length === 10);

/* ============================================================ 9. speed */

console.log('\n=== 9. speed: the dish at 0.17 mm per sample ===');
/* The best of three builds, gated in calibration loops (tools/nso_pace.js)
   run either side of them, not seconds: MAP_LOOPS_MAX is the old "under a
   second" on the box it was set on. */
const MAP_LOOPS_MAX = 3.4;
const BG = FX.big(0.17).soup;
const tm = [];
const mapCal0 = pace.calibrate();
for (let i = 0; i < 3; i++) { const t0 = Date.now(); LA.buildMap(BG, [0, 0, 1]); tm.push(Date.now() - t0); }
const mapCal = (mapCal0 + pace.calibrate()) / 2, mapLoops = Math.min(...tm) / mapCal;
console.log(pace.finding('the best of three dish maps', { ms: Math.min(...tm), cal: mapCal, loops: mapLoops }));
const bSeed = seedNear(BG, 30, 35);
const t1 = Date.now(), ABg = LA.analyse(BG, bSeed), full = Date.now() - t1;
check('the map of ' + (BG.length / 9).toLocaleString('en') + ' triangles builds in under ' + MAP_LOOPS_MAX + ' calibration loops', mapLoops < MAP_LOOPS_MAX,
  mapLoops.toFixed(2) + ' loops; ' + tm.join(' / ') + ' ms; the whole read ' + full + ' ms (' + Object.keys(ABg.ms).map(k => k + ' ' + Math.round(ABg.ms[k])).join(', ') + ')');
REPORT.push('speed: map of ' + BG.length / 9 + ' triangles ' + tm.join(' / ') + ' ms; whole read ' + full + ' ms ' + JSON.stringify(ABg.ms, (k, v) => typeof v === 'number' ? Math.round(v) : v));
check('...and finds the same seven details', ABg.ok && ABg.islands.length === 7 && ABg.liftable === 6);

/* ================================================ 10. where the bend bites */

console.log('\n=== 10. where the 0.15 mm bend tolerance bites: straight bars on bowls of four radii ===');
const LENS = [2, 4, 6, 8, 10, 12, 16, 20], BITE = {};
[300, 150, 60, 30].forEach(Rr => {
  const DB = FX.dishBars(Rr, LENS), AB2 = LA.analyse(DB.soup, seedNear(DB.soup, 24, 24));
  const row = DB.truth.map(t => islandAt(AB2, t.center[0], t.center[1], 3));
  BITE[Rr] = row;
  const firstNo = row.findIndex(I => !I || I.status !== 'ok');
  check('bowl R ' + Rr + ' mm: every bar found; the bend grows with length; once one is refused every longer one is',
    AB2.ok && row.every(Boolean) && row.every((I, i) => i === 0 || I.bendMm >= row[i - 1].bendMm - 1e-3) &&
    (firstNo < 0 || row.slice(firstNo).every(I => I.status === 'bends')),
    row.map((I, i) => LENS[i] + ' mm ' + (I ? (I.status === 'ok' ? 'lifts' : 'refused') + ' ' + f3(I.bendMm) : 'missing')).join(', '));
  REPORT.push('bowl R ' + Rr + ' mm: ' + row.map((I, i) => LENS[i] + (I && I.status === 'ok' ? '✓' : '✗') + f2(I ? I.bendMm : NaN)).join(' ') +
    (firstNo < 0 ? ' - all lift' : ' - refused from ' + LENS[firstNo] + ' mm'));
});
check('on the R 150 dish a 10 mm bar lifts and a 12 mm bar is refused', BITE[150][4].status === 'ok' && BITE[150][5].status === 'bends');

/* ===================================================== 11. canonical checker */

console.log('\n=== 11. tools/mesh_validate.py, self-intersection on ===');
const CANON = [
  ['the mushroom (undercut)', mush && mush.soup],
  ['the flat plate after Remove', RF && RF.r.plate],
  ['a dish dot', dOne && dOne.pieces[0].soup],
  ['the dish after its middle dot', dOne && dOne.plate],
  ['the dish after Remove', RD && RD.r.plate],
  ['the bar across two steps', (() => { const I = islandAt(AT, 18, 22, 1.5); const r = I && LA.lift(SPo, AT, [I.id], DEPS); return r && r.ok ? r.pieces[0].soup : null; })()],
  ['the steps after Remove', RT && RT.r.plate],
  (() => { const r = cl && LA.lift(LVo, AL, [cl.id], DEPS); return ['the leaf cluster', r && r.ok ? r.pieces[0].soup : null, r && r.ok ? r.pieces[0].contacts : null]; })()
];
CANON.forEach(([name, soup, contacts], i) => {
  if (!soup) { check(name + ': PASS, no piercing, no coincident faces', false, 'missing'); return; }
  const j = validate(soup, 'c' + i);
  if (!contacts || !contacts.length) { check(name + ': PASS, no piercing, no coincident faces', j.clean, j.summary); return; }
  // An island that comes down to the base INSIDE its own outline (where the
  // leaves meet) touches its back there: every self-contact the checker
  // reports must be a triangle with one of those corners, against the back.
  const ck = new Set(contacts.map(q => q.join(',')));
  const hasContact = t => [0, 1, 2].some(k => ck.has([soup[t * 9 + k * 3], soup[t * 9 + k * 3 + 1], soup[t * 9 + k * 3 + 2]].join(',')));
  const si = j.self_intersection || {}, ex = si.examples || [];
  const onlyTouch = si.coplanar === 0 && ex.length === si.pierce && ex.every(e => hasContact(e.a) || hasContact(e.b));
  check(name + ': closed, no coincident faces, and its only self-contacts are the ' + contacts.length + ' corner(s) where it comes down to the base inside its outline',
    j.verdict !== undefined && j.open_edges === 0 && j.nonmanifold_edges === 0 && onlyTouch, j.summary);
  REPORT.push(name + ': touches its own back at ' + contacts.length + ' corner(s) inside its outline (' + contacts.map(q => '(' + q.map(f2).join(', ') + ')').join(' ') + ') - ' + si.pierce + ' contact(s) by the checker');
});

console.log('\n--- report ---');
REPORT.forEach(s => console.log('  ' + s));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('FAILED: ' + FAILS.join('; ')); process.exit(1); }
