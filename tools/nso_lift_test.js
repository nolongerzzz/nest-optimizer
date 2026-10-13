#!/usr/bin/env node
/* Lift, phase 1 - headless. node tools/nso_lift_test.js   exit 0 = every gate held

   READ docs/LIFT.md for what these numbers mean. The fixtures are generated
   here (tools/nso_lift_fixtures.js), not taken from nest-library:

     1. the plate. 60 x 60 x 3 with five dots, a raised line, a ring, a
        spherical-cap bump and 48 small bumps. A click on its top finds the
        plane z = 3 exactly, and every detail is one island of the height and
        size the generator built; the slider offers what stands out more than
        it, and nothing below.
     2. lifting each detail alone. The piece is closed and manifold, its flat
        back lies in z = 3 and faces down, it has no duplicate or coincident
        faces, and it is the detail's own triangles bit for bit; the plate is
        closed, flat where the detail stood, and every other triangle is the
        source's, in order, bit for bit. Volumes add up.
     3. lifting all of them. The plate's top is one flat face again (a fresh
        click finds 3600 mm^2 and nothing on it) and plate + pieces = source.
     4. the ring lifts as a ring: genus 1, its bore open.
     5. refusals in plain words, nothing changed: a curved face (a cylinder's
        side); a flat face beside fillets is NOT refused; a step that runs
        down the part's side is never offered.
     6. the same plate turned off every axis: the same islands, the caps made
        through the turned frame, still of the loops' own vertices.
     7. the Picture relief slab, camera.png (the photo the relief tests use).
     8. the canonical checker (tools/mesh_validate.py, self-intersection on)
        on the pieces and the plates. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-lift-'));
const { writeSTL } = require('./nso_stl_io.js');
const { readPNG } = require('./nso_png.js');
const FX = require('./nso_lift_fixtures.js');
const L = require(path.join(ROOT, 'nso_lift.js'));
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
const FAILS = [];
function check(name, cond, detail) {
  if (cond) pass++; else { fail++; FAILS.push(name); }
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined ? '   ' + detail : ''));
}
const f3 = x => Number(x).toFixed(3);

/* ---------------------------------------------------------------- helpers */

const triKey = (s, t) => {
  const v = [0, 1, 2].map(k => s[t * 9 + k * 3] + ',' + s[t * 9 + k * 3 + 1] + ',' + s[t * 9 + k * 3 + 2]);
  return v;
};
/* Duplicate faces: two triangles on the same three corners, either way round. */
function duplicates(s) {
  const seen = new Set();
  let d = 0;
  for (let t = 0; t < s.length / 9; t++) {
    const k = triKey(s, t).sort().join('|');
    if (seen.has(k)) d++; else seen.add(k);
  }
  return d;
}
function triNormal(s, t) {
  const o = t * 9;
  const u = [s[o + 3] - s[o], s[o + 4] - s[o + 1], s[o + 5] - s[o + 2]];
  const v = [s[o + 6] - s[o], s[o + 7] - s[o + 1], s[o + 8] - s[o + 2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}
/* The triangles lying in a plane n.p = d (to tol): count, area, which way they face. */
function inPlane(s, n, d, tol) {
  let count = 0, area = 0, facing = 0, against = 0;
  for (let t = 0; t < s.length / 9; t++) {
    let on = true;
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      if (Math.abs(s[o] * n[0] + s[o + 1] * n[1] + s[o + 2] * n[2] - d) > tol) { on = false; break; }
    }
    if (!on) continue;
    const c = triNormal(s, t), a = Math.hypot(c[0], c[1], c[2]) / 2;
    count++; area += a;
    if (c[0] * n[0] + c[1] * n[1] + c[2] * n[2] > 0) facing++; else against++;
  }
  return { count, area, facing, against };
}
function sameTri(a, ta, b, tb) {
  for (let q = 0; q < 9; q++) if (a[ta * 9 + q] !== b[tb * 9 + q]) return false;
  return true;
}
let seq = 0;
function validate(soup, name) {
  const f = path.join(OUT, (name || 'p' + seq++) + '.stl');
  writeSTL(f, soup);
  const j = JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--json'],
    { maxBuffer: 64 << 20 }).toString());
  const si = j.self_intersection || {};
  j.summary = j.verdict + ' open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' inc ' +
    j.inconsistent_winding_edges + ' chi ' + j.euler_characteristic + ' pierce ' + si.pierce + ' coplanar ' + si.coplanar;
  j.clean = j.verdict === 'PASS' && si.pierce === 0 && si.coplanar === 0;
  return j;
}
function seedOn(s, z) {
  // the plate top's last triangle in z = z, facing up: a click on the plate, not on a detail
  for (let t = s.length / 9 - 1; t >= 0; t--) {
    if (s[t * 9 + 2] === z && s[t * 9 + 5] === z && s[t * 9 + 8] === z && triNormal(s, t)[2] > 0) return t;
  }
  return -1;
}
function islandFor(A, truth) {
  let best = null, bd = Infinity;
  A.islands.forEach(I => {
    const d = Math.hypot(I.center[0] - truth.center[0], I.center[1] - truth.center[1]);
    if (d < bd) { bd = d; best = I; }
  });
  return bd < 0.5 ? best : null;
}

/* Every gate a lift of ONE island owes: piece, back, plate, volumes. */
function lifted(tag, src, A, I, truth, n, d, opts) {
  opts = opts || {};
  const r = L.lift(src, A, [I.id], DEPS);
  check(tag + ': lifts', r.ok, r.reason);
  if (!r.ok) return null;
  const pc = r.pieces[0], ps = pc.soup;
  const c = L.census(ps);
  check(tag + ': the piece is closed and manifold', c.closed && c.degen === 0,
    c.tris + ' tris, open ' + c.open + ', nm ' + c.nm + ', degen ' + c.degen + ', chi ' + c.chi);
  const back = inPlane(ps, n, d, opts.tol || 1e-9);
  check(tag + ': its flat back lies in the base plane and faces into the plate',
    back.count === pc.capTris && back.facing === 0 && back.against === back.count,
    back.count + ' back triangles, ' + f3(back.area) + ' mm^2, all facing down');
  if (truth && truth.rootArea != null) {
    check(tag + ': the back covers the detail\'s footprint exactly', Math.abs(back.area - truth.rootArea) < 2e-5 * Math.max(1, truth.rootArea),
      f3(back.area) + ' of ' + f3(truth.rootArea) + ' mm^2');
  }
  check(tag + ': no duplicate faces', duplicates(ps) === 0);
  let same = true;
  I.tris.forEach((t, i) => { if (!sameTri(ps, i, src, t)) same = false; });
  check(tag + ': the piece is the detail\'s own triangles, bit for bit, plus its back', same && c.tris === I.tris.length + pc.capTris);
  if (truth && truth.volume != null) {
    check(tag + ': the piece is the volume the generator built', Math.abs(pc.volume - truth.volume) < 1e-6 * Math.max(1, truth.volume),
      f3(pc.volume) + ' of ' + f3(truth.volume) + ' mm^3');
  }
  // the plate
  const pl = r.plate, pcs = L.census(pl);
  check(tag + ': the plate stays closed and manifold', pcs.closed && pcs.degen === 0,
    pcs.tris + ' tris, open ' + pcs.open + ', nm ' + pcs.nm + ', chi ' + pcs.chi);
  const drop = new Set(I.tris);
  let k = 0, unchanged = true;
  for (let t = 0; t < src.length / 9; t++) {
    if (drop.has(t)) continue;
    if (!sameTri(pl, k, src, t)) unchanged = false;
    k++;
  }
  check(tag + ': every other triangle of the plate is the source\'s, in order, bit for bit', unchanged && k === r.keptTris,
    k + ' kept of ' + src.length / 9);
  const added = new Float32Array(pl.subarray(k * 9));
  const ap = inPlane(added, n, d, opts.tol || 1e-9);
  check(tag + ': where it stood the plate is flat: every new triangle lies in the base plane and faces out',
    ap.count === added.length / 9 && ap.against === 0, ap.count + ' new, ' + f3(ap.area) + ' mm^2');
  check(tag + ': ...and fills exactly the back of the piece', Math.abs(ap.area - back.area) < 1e-9 * Math.max(1, back.area));
  const resid = r.volumes.source - r.volumes.plate - r.volumes.pieces;
  check(tag + ': plate + piece = source', Math.abs(resid) < 1e-7 * r.volumes.source,
    f3(r.volumes.plate) + ' + ' + f3(r.volumes.pieces) + ' = ' + f3(r.volumes.source) + ' (residual ' + resid.toExponential(2) + ')');
  return r;
}

/* ============================================================ 1. the plate */

console.log('\n=== 1. the plate: 60 x 60 x 3, five dots, a line, a ring, a cap, 48 bumps ===');
const PL = FX.plate(CAP);
const SRC = PL.soup;
const srcCopy = new Float32Array(SRC);
check('fixture: the plate is closed and manifold', L.census(SRC).closed, L.census(SRC).tris + ' tris');
PL.truth.forEach(t => { t.rootArea = FX.polyArea(t.hole); });
// the ring meets the plate on an annulus: its bore's floor is plate
PL.truth.filter(t => t.kind === 'ring').forEach(t => { t.rootArea -= FX.polyArea(FX.circle(0, 0, 3, 32)); });
const seed = seedOn(SRC, 3);
let t0 = Date.now();
const A = L.analyse(SRC, seed);
const msPlate = Date.now() - t0;
check('a click on the top finds a flat face', A.ok, A.reason);
check('its plane is z = 3, exactly', A.plane.n[0] === 0 && A.plane.n[1] === 0 && A.plane.n[2] === 1 && A.plane.d === 3,
  'n ' + A.plane.n.join(',') + ', d ' + A.plane.d + ', residual ' + A.base.residualMm);
check('...not curved', !A.curve.curved);
check('56 things stand on it and all 56 can be lifted', A.islands.length === 56 && A.liftable === 56, A.reason);
const byKind = {};
let matched = 0;
PL.truth.forEach(t => {
  const I = islandFor(A, t);
  t.island = I;
  if (!I) return;
  matched++;
  (byKind[t.kind] = byKind[t.kind] || []).push({ t, I });
});
check('every detail the generator made is one island, where it was made', matched === PL.truth.length);
Object.keys(byKind).forEach(kind => {
  const L0 = byKind[kind];
  const okH = L0.every(x => Math.abs(x.I.heightMm - x.t.heightMm) < 1e-6);
  const okT = L0.every(x => x.I.triangles === x.t.tris);
  check(kind + ' (' + L0.length + '): height ' + f3(L0[0].I.heightMm) + ' mm and ' + L0[0].I.triangles + ' triangles, as built',
    okH && okT);
});
const ring = byKind.ring[0].I;
check('the ring meets the face on two loops', ring.loops.length === 2, ring.loops.map(x => f3(x.area)).join(' / ') + ' mm^2');
const DEF = L.defaultMinHeight();
check('the slider\'s default is NSO_Thickness.floorFor at 0.4: 0.42 mm', DEF === 0.42, DEF);
check('at 0.42 every detail is offered', L.offered(A, DEF).length === 56);
const at07 = L.offered(A, 0.7);
check('at 0.7 the dots, the line and the texture (0.6 / 0.6 / 0.5) are not offered; the ring and the cap are',
  at07.length === 2 && at07.indexOf(ring.id) >= 0 && at07.indexOf(byKind.cap[0].I.id) >= 0, at07.length + ' offered');
check('at 0.6 a 0.6 mm dot is not offered: it must stand out MORE than the slider', L.offered(A, 0.6).indexOf(byKind.dot[0].I.id) < 0);
check('analyse writes nothing', SRC.every((v, i) => v === srcCopy[i]));
console.log('   analyse: ' + msPlate + ' ms on ' + SRC.length / 9 + ' triangles');

/* ======================================================= 2. one at a time */

console.log('\n=== 2. lifting each detail alone ===');
const N3 = [0, 0, 1];
const KEEP = {};
PL.truth.forEach((t, i) => {
  const quiet = t.kind === 'texture' && i > PL.truth.findIndex(x => x.kind === 'texture');
  const tag = t.kind + (byKind[t.kind].length > 1 ? ' ' + (byKind[t.kind].findIndex(x => x.t === t) + 1) : '');
  if (quiet || (t.kind === 'dot' && byKind.dot[0].t !== t)) {
    // the rest of a kind: every gate, one line
    const save = { pass, fail, log: console.log };
    const lines = [];
    console.log = s => lines.push(s);
    const r = lifted(tag, SRC, A, t.island, t, N3, 3);
    console.log = save.log;
    const bad = lines.filter(s => /FAIL/.test(s));
    bad.forEach(s => console.log(s));
    if (!bad.length) console.log('  ok    ' + tag + ': all ' + lines.length + ' gates');
    if (r && !KEEP[t.kind + '_more']) KEEP[t.kind + '_more'] = r;
    return;
  }
  KEEP[t.kind] = lifted(tag, SRC, A, t.island, t, N3, 3);
});

/* ========================================================= 3. all of them */

console.log('\n=== 3. lifting all of them ===');
t0 = Date.now();
const ALL = L.lift(SRC, A, L.offered(A, DEF), DEPS);
const msAll = Date.now() - t0;
check('all 56 lift together', ALL.ok && ALL.pieces.length === 56, ALL.reason + ' (' + msAll + ' ms)');
const allC = L.census(ALL.plate);
check('the plate is closed and manifold', allC.closed && allC.degen === 0, allC.tris + ' tris, chi ' + allC.chi);
check('every piece is closed and manifold', ALL.pieces.every(p => p.census.closed && p.census.degen === 0));
const vSum = ALL.pieces.reduce((s, p) => s + p.volume, 0);
const V0 = L.volume(SRC);
check('plate + lifted pieces = the original, to float32 tolerance', Math.abs(V0 - ALL.volumes.plate - vSum) < 1e-7 * V0,
  f3(ALL.volumes.plate) + ' + ' + f3(vSum) + ' = ' + f3(V0) + ' mm^3');
check('the plate is the bare 60 x 60 x 3 slab again', Math.abs(ALL.volumes.plate - 10800) < 1e-6, f3(ALL.volumes.plate) + ' mm^3');
const A2 = L.analyse(ALL.plate, seedOn(ALL.plate, 3));
check('its top is one flat face again: a click finds 3600 mm^2 with nothing on it',
  A2.ok && A2.islands.length === 0 && Math.abs(A2.base.areaMm2 - 3600) < 1e-6, A2.ok ? f3(A2.base.areaMm2) + ' mm^2, ' + A2.islands.length + ' islands' : A2.reason);
const topAll = inPlane(ALL.plate, N3, 3, 0);
check('...every triangle at z = 3 is in that one face', topAll.count === A2.base.tris && topAll.against === 0, topAll.count + ' triangles');
const above = (() => { let m = -Infinity; for (let i = 2; i < ALL.plate.length; i += 3) m = Math.max(m, ALL.plate[i]); return m; })();
check('nothing is left above it', above === 3, 'top z ' + above);

/* ================================================================ 4. ring */

console.log('\n=== 4. the ring lifts as a ring ===');
const rp = KEEP.ring && KEEP.ring.pieces[0];
check('the ring piece has genus 1 (chi 0): one bore through it', rp && rp.census.chi === 0, 'chi ' + (rp && rp.census.chi));
// a vertical line through the ring's centre meets none of its triangles
let through = 0;
if (rp) {
  const s = rp.soup, P = [10, 18];
  for (let t = 0; t < s.length / 9; t++) {
    const o = t * 9, a = [s[o], s[o + 1]], b = [s[o + 3], s[o + 4]], c = [s[o + 6], s[o + 7]];
    const d1 = (P[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (P[1] - b[1]);
    const d2 = (P[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (P[1] - c[1]);
    const d3 = (P[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (P[1] - a[1]);
    if ((d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0)) through++;
  }
}
check('its bore is open: a line down through the centre meets nothing', rp && through === 0, through + ' triangles cover the centre');
check('its back is the annulus, 8 mm outer, 6 mm bore', rp && Math.abs(rp.rootAreaMm2 - (FX.polyArea(FX.circle(0, 0, 4, 32)) - FX.polyArea(FX.circle(0, 0, 3, 32)))) < 1e-4,
  rp ? f3(rp.rootAreaMm2) + ' mm^2' : '-');
const plateAfterRing = KEEP.ring && KEEP.ring.plate;
if (plateAfterRing) {
  const bore = inPlane(plateAfterRing, N3, 3, 0);
  check('the plate under it is whole: its top is 3600 mm^2 minus the other details\' footprints',
    Math.abs(bore.area - (3600 - PL.truth.filter(t => t.kind !== 'ring').reduce((s, t) => s + t.rootArea, 0))) < 1e-3, f3(bore.area) + ' mm^2');
}

/* =========================================================== 5. refusals */

console.log('\n=== 5. refusals, and what is not refused ===');
const CYL = FX.cylinder(10, 20, 48), cylCopy = new Float32Array(CYL);
let side = -1;
for (let t = 0; t < CYL.length / 9; t++) { if (Math.abs(triNormal(CYL, t)[2]) < 1e-9) { side = t; break; } }
const Ac = L.analyse(CYL, side);
check('a click on a cylinder\'s side is refused as curved', !Ac.ok && Ac.refused === 'curved', Ac.reason);
check('...in plain words that say so', /curved/.test(Ac.reason) && /Pick the flat face/.test(Ac.reason));
check('...and nothing changed', CYL.every((v, i) => v === cylCopy[i]));
const Act = L.analyse(CYL, CYL.length / 9 - 1);
check('the same cylinder\'s flat top is a flat face, with nothing on it', Act.ok && Act.islands.length === 0, Act.ok ? Act.reason : Act.reason);
const RB = FX.rounded(CAP);
let rs = -1;
for (let t = 0; t < RB.length / 9; t++) if (RB[t * 9 + 2] === 6 && RB[t * 9 + 5] === 6 && RB[t * 9 + 8] === 6) { rs = t; break; }
const Ar = L.analyse(RB, rs);
check('a big flat top between two fillets is NOT refused', Ar.ok,
  Ar.ok ? 'gentle along ' + (100 * Ar.curve.gentleShare).toFixed(0) + '% of its edge, at ' + f3(Ar.curve.bendDeg) +
    ' deg, but ' + f3(Ar.base.areaMm2) + ' mm^2 against fillet strips of ' + f3(Ar.curve.neighbourAreaMm2) : Ar.reason);
const ST = FX.stepped(CAP);
let ss = -1;
for (let t = 0; t < ST.length / 9; t++) if (ST[t * 9 + 2] === 3 && ST[t * 9 + 5] === 3 && ST[t * 9 + 8] === 3) { ss = t; break; }
const As = L.analyse(ST, ss);
check('on a stepped block the higher half stands proud of the low top...', As.ok && As.islands.length === 1, As.reason);
check('...and is never offered: it runs down the part\'s side', As.ok && As.islands[0].status === 'edge' &&
  L.offered(As, 0).length === 0, As.islands[0] && As.islands[0].reason);
const Ab = L.analyse(SRC, (() => { for (let t = 0; t < SRC.length / 9; t++) if (SRC[t * 9 + 2] === 0 && SRC[t * 9 + 5] === 0 && SRC[t * 9 + 8] === 0) return t; })());
check('the plate\'s bottom face is flat and nothing stands proud of it', Ab.ok && Ab.islands.length === 0, Ab.reason);
const none = L.lift(SRC, A, [], DEPS);
check('Lift with nothing chosen says so and makes nothing', !none.ok && /nothing is chosen/.test(none.reason), none.reason);

/* ============================================================== 6. turned */

console.log('\n=== 6. the plate turned off every axis (30 deg about Z, then 20 deg about X) ===');
function turn(s) {
  const a = 30 * Math.PI / 180, b = 20 * Math.PI / 180, out = new Float32Array(s.length);
  for (let i = 0; i < s.length; i += 3) {
    const x = s[i], y = s[i + 1], z = s[i + 2];
    const x1 = x * Math.cos(a) - y * Math.sin(a), y1 = x * Math.sin(a) + y * Math.cos(a);
    out[i] = x1; out[i + 1] = y1 * Math.cos(b) - z * Math.sin(b); out[i + 2] = y1 * Math.sin(b) + z * Math.cos(b);
  }
  return out;
}
const TS = turn(SRC);
const At = L.analyse(TS, seed);
const nT = [0, -Math.sin(20 * Math.PI / 180), Math.cos(20 * Math.PI / 180)];
check('a click on the turned top finds a flat face', At.ok, At.reason);
check('its normal is the turned +Z', At.ok && Math.hypot(At.plane.n[0] - nT[0], At.plane.n[1] - nT[1], At.plane.n[2] - nT[2]) < 1e-6,
  At.ok ? At.plane.n.map(x => x.toFixed(7)).join(', ') + ', fit residual ' + At.base.residualMm.toExponential(2) + ' mm' : '');
check('the same 56 islands, all liftable', At.ok && At.islands.length === 56 && At.liftable === 56);
const tRing = At.islands.find(I => I.loops && I.loops.length === 2);
const tCap = At.islands.reduce((m, I) => (!m || I.heightMm > m.heightMm ? I : m), null);
const tTruthRing = PL.truth.find(t => t.kind === 'ring'), tTruthCap = PL.truth.find(t => t.kind === 'cap');
const tol = At.plane.tolMm;
lifted('turned ring', TS, At, tRing, { volume: tTruthRing.volume, rootArea: null }, At.plane.n, At.plane.d, { tol });
lifted('turned cap', TS, At, tCap, { volume: null, rootArea: null }, At.plane.n, At.plane.d, { tol });
const tAll = L.lift(TS, At, L.offered(At, DEF), DEPS);
check('all 56 off the turned plate: closed, and the volumes add up',
  tAll.ok && L.census(tAll.plate).closed && Math.abs(tAll.volumes.residual) < 1e-6 * tAll.volumes.source,
  tAll.ok ? f3(tAll.volumes.plate) + ' + ' + f3(tAll.volumes.pieces) + ' = ' + f3(tAll.volumes.source) : tAll.reason);

/* ========================================================== 7. the slab */

console.log('\n=== 7. the Picture relief slab: camera.png, Levels 2, 40 mm at 0.4 mm ===');
const PHOTO = readPNG(path.join(ROOT, 'fixtures', 'relief', 'camera.png'));
const slab = R.build(PHOTO, { widthMm: 40, sampleMm: 0.4, baseMm: 2, reliefMm: 2, levels: 2 });
const SL = slab.rawTris;
// a click on the paper (z = base, facing up) near the top middle - the sky
let sseed = -1, sbd = Infinity;
for (let t = 0; t < SL.length / 9; t++) {
  if (!(SL[t * 9 + 2] === 2 && SL[t * 9 + 5] === 2 && SL[t * 9 + 8] === 2) || triNormal(SL, t)[2] <= 0) continue;
  const cx = (SL[t * 9] + SL[t * 9 + 3] + SL[t * 9 + 6]) / 3, cy = (SL[t * 9 + 1] + SL[t * 9 + 4] + SL[t * 9 + 7]) / 3;
  const dd = Math.hypot(cx - 20, cy - 36);
  if (dd < sbd) { sbd = dd; sseed = t; }
}
t0 = Date.now();
const AS = L.analyse(SL, sseed);
const msSlab = Date.now() - t0;
check('a click on the paper finds the base, z = 2', AS.ok && AS.plane.n[2] === 1 && AS.plane.d === 2, AS.reason + ' (' + msSlab + ' ms, ' + SL.length / 9 + ' tris)');
const sOk = AS.islands.filter(I => I.status === 'ok'), sEdge = AS.islands.filter(I => I.status === 'edge');
check('what runs down the slab\'s side (the figure, the ground) is part of the body, refused by name',
  sEdge.length > 0 && sEdge.every(I => /edge of the face/.test(I.reason)), sEdge.length + ' refused, the biggest ' + Math.max(...sEdge.map(I => I.triangles)) + ' triangles');
const sOff = L.offered(AS, DEF);
check('the slider offers the islands that stand out more than 0.42 mm, and no lower one',
  sOff.length > 0 && sOff.every(id => AS.islands[id].heightMm > DEF) && sOk.filter(I => I.heightMm <= DEF).every(I => sOff.indexOf(I.id) < 0),
  sOk.length + ' liftable, ' + sOff.length + ' offered at 0.42 (' + sOff.map(id => f3(AS.islands[id].heightMm)).join(', ') + ' mm)');
let slabOne = 0, slabFail = [];
sOff.forEach(id => {
  const save = console.log, lines = [];
  console.log = s => lines.push(s);
  lifted('slab island ' + id, SL, AS, AS.islands[id], null, [0, 0, 1], 2);
  console.log = save;
  if (lines.some(s => /FAIL/.test(s))) slabFail.push(lines.filter(s => /FAIL/.test(s)).join('\n')); else slabOne++;
});
slabFail.forEach(s => console.log(s));
check('each offered island lifts alone with every gate of section 2', slabOne === sOff.length, slabOne + ' of ' + sOff.length);
const sAll = L.lift(SL, AS, sOff, DEPS);
check('all of them together: the slab stays closed and the volumes add up',
  sAll.ok && L.census(sAll.plate).closed && Math.abs(sAll.volumes.residual) < 1e-7 * sAll.volumes.source,
  sAll.ok ? f3(sAll.volumes.plate) + ' + ' + f3(sAll.volumes.pieces) + ' = ' + f3(sAll.volumes.source) + ' mm^3' : sAll.reason);
const sLow = L.analyse(sAll.plate, sseed);
check('...and nothing that was offered is left standing on it', sLow.ok && L.offered(sLow, DEF).length === 0,
  sLow.ok ? sLow.reason : sLow.reason);

/* ===================================================== 8. canonical checker */

console.log('\n=== 8. tools/mesh_validate.py, self-intersection on ===');
const CANON = [
  ['the dot', KEEP.dot && KEEP.dot.pieces[0].soup],
  ['the plate after the dot', KEEP.dot && KEEP.dot.plate],
  ['the line', KEEP.line && KEEP.line.pieces[0].soup],
  ['the ring', KEEP.ring && KEEP.ring.pieces[0].soup],
  ['the plate after the ring', KEEP.ring && KEEP.ring.plate],
  ['the cap', KEEP.cap && KEEP.cap.pieces[0].soup],
  ['a texture bump', KEEP.texture && KEEP.texture.pieces[0].soup],
  ['the plate after all 56', ALL.plate],
  ['the slab after all its islands', sAll.ok ? sAll.plate : null],
  ['the biggest slab island', sAll.ok && sAll.pieces.length ? sAll.pieces.reduce((m, p) => (!m || p.soup.length > m.soup.length ? p : m), null).soup : null]
];
CANON.forEach(([name, soup], i) => {
  if (!soup) { check(name + ': PASS, no piercing, no coincident faces', false, 'missing'); return; }
  const j = validate(soup, 'c' + i);
  check(name + ': PASS, no piercing, no coincident faces', j.clean, j.summary);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('FAILED: ' + FAILS.join('; ')); process.exit(1); }
