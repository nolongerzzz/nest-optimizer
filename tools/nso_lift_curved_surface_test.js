#!/usr/bin/env node
/* Lift off a curved SURFACE REGION - headless.
   node tools/nso_lift_curved_surface_test.js        exit 0 = every gate held

   The base under the cursor is a surface region (nso_lift_curved.js, `surface`): it grows from the
   triangle under the cursor across edges while the surface stays smooth (12 degrees, and not more
   than 12 degrees of turn in 4 mm of surface: a fillet is a crease), and stops at creases. Whatever
   stands on it and is attached only through it lifts as one piece; the cut follows the region's
   curvature and the hole is filled flush with the surround. A planar region is a face and goes
   to Lift 2 / 3 unchanged. Every fixture is generated here (tools/nso_lift_curved_surface_fixtures.js).

     1. a cylinder body (60 mm across) with a torus handle sewn to its wall and a sphere bump welded
        on: the handle and the bump lift, each alone and both together; the caps do not.
     2. a dome with a raised ring: the ring lifts and the bore floor stays where it was.
     3. planar faces are unchanged: feature-hull_hinge's +Y wall and the Barocke plate's top lift
        byte for byte as lift-any-face lifts them.
     4. an assembly: a free part held by the bump comes off with it.
     5. refusals in words, Remove, and the canonical checker (tools/mesh_validate.py).

   Gates from the output soups alone. A lift: the piece and the plate closed and manifold; the plate's
   other triangles the source's, in order, bit for bit; the piece the feature's own triangles bit for
   bit plus its back; plate + pieces = source (volume residual under 1e-6 mm^3); every new corner on
   the true surface within 0.05 mm (no step); the weld: every edge of the fill is shared with a real
   neighbour, the same corners bit for bit. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-lift-curved-surface-'));
const { writeSTL, readSTL } = require('./nso_stl_io.js');
const FX = require('./nso_lift_curved_surface_fixtures.js');
const PFX = require('./nso_lift_plate_fixtures.js');
const L = require(path.join(ROOT, 'nso_lift.js'));
const LA = require(path.join(ROOT, 'nso_lift_auto.js'));
const LC = require(path.join(ROOT, 'nso_lift_curved.js'));
const S = LC.surface;

const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, Float32Array, Float64Array,
  Int32Array, Uint8Array, Error, Infinity, NaN, isFinite };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-cut.js'), 'utf8'), ctx, { filename: 'app-cut.js' });
const DEPS = { rawFlatCapLoops: ctx.rawFlatCapLoops };

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) pass++; else { fail++; FAILS.push(name); }
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined ? '   ' + detail : ''));
}
const f3 = x => Number(x).toFixed(3);
const f4 = x => Number(x).toFixed(4);

/* ---------------------------------------------------------------- helpers */

/* the nearest triangle a ray from `o` along `d` meets */
function ray(soup, o, d) {
  let best = Infinity, bt = -1;
  for (let t = 0; t < soup.length / 9; t++) {
    const i = t * 9;
    const e1 = [soup[i + 3] - soup[i], soup[i + 4] - soup[i + 1], soup[i + 5] - soup[i + 2]];
    const e2 = [soup[i + 6] - soup[i], soup[i + 7] - soup[i + 1], soup[i + 8] - soup[i + 2]];
    const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-14) continue;
    const inv = 1 / det, tv = [o[0] - soup[i], o[1] - soup[i + 1], o[2] - soup[i + 2]];
    const u = (tv[0] * p[0] + tv[1] * p[1] + tv[2] * p[2]) * inv;
    if (u < 0 || u > 1) continue;
    const q = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
    if (v < 0 || u + v > 1) continue;
    const tt = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
    if (tt > 0 && tt < best) { best = tt; bt = t; }
  }
  return bt;
}

const tri = (s, t) => Array.from(s.subarray(t * 9, t * 9 + 9));
function same9(a, ta, b, tb) { for (let q = 0; q < 9; q++) if (a[ta * 9 + q] !== b[tb * 9 + q]) return false; return true; }
function sameArr(a, b) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
const ekey = (s, t, k) => {
  const a = s[t * 9 + k * 3] + ',' + s[t * 9 + k * 3 + 1] + ',' + s[t * 9 + k * 3 + 2];
  const b = s[t * 9 + ((k + 1) % 3) * 3] + ',' + s[t * 9 + ((k + 1) % 3) * 3 + 1] + ',' + s[t * 9 + ((k + 1) % 3) * 3 + 2];
  return [a, b];
};

/* Everything the lift did, from the soups alone. `own` = the feature's triangles (+ parts) in the source. */
function gateLift(tag, src, A, ids, res, surfaceDev) {
  const out = {};
  check(tag + ': lift ok', res.ok, res.ok ? '' : res.reason);
  if (!res.ok) return out;
  const srcC = LA.census(src);
  check(tag + ': plate closed and manifold', res.plateCensus.closed && !res.plateCensus.degen,
    res.plateCensus.open + ' open, ' + res.plateCensus.nm + ' non-manifold, ' + res.plateCensus.degen + ' degenerate');
  res.pieces.forEach((pc, i) => {
    check(tag + ': piece ' + (i + 1) + ' closed and manifold', pc.census.closed && !pc.census.degen && L.census(pc.soup).closed,
      pc.soup.length / 9 + ' triangles, ' + pc.parts + ' held');
  });
  // every other plate triangle the source's, in order, bit for bit
  const chosen = new Set();
  ids.forEach(id => { const I = A.islands[id]; I.tris.forEach(t => chosen.add(t)); (I.parts || []).forEach(P => P.tris.forEach(t => chosen.add(t))); });
  let ok = true, k = 0;
  for (let t = 0; t < src.length / 9 && ok; t++) {
    if (chosen.has(t)) continue;
    if (!same9(src, t, res.plate, k++)) ok = false;
  }
  check(tag + ': every other triangle is the source\'s, in order, bit for bit', ok && k === res.keptTris, k + ' kept');
  // the piece: the feature's own triangles bit for bit, then its back
  res.pieces.forEach((pc, i) => {
    const I = A.islands[ids[i]], own = I.tris.length;
    let own1 = true;
    I.tris.forEach((t, j) => { if (!same9(src, t, pc.soup, j)) own1 = false; });
    check(tag + ': piece ' + (i + 1) + ' = the feature\'s own triangles bit for bit + its back', own1 && pc.soup.length / 9 >= own);
  });
  // plate + pieces = source
  check(tag + ': plate + pieces = source', Math.abs(res.volumes.residual) < 1e-6, res.volumes.residual.toExponential(2) + ' mm^3');
  // the fill: new plate triangles; every corner on the true surface, and welded to a kept neighbour
  const nk = res.keptTris, nf = res.plate.length / 9 - nk;
  let dev = 0;
  for (let t = nk; t < nk + nf; t++) for (let c = 0; c < 3; c++) dev = Math.max(dev, surfaceDev(res.plate[t * 9 + c * 3], res.plate[t * 9 + c * 3 + 1], res.plate[t * 9 + c * 3 + 2]));
  check(tag + ': the hole is filled with no step over 0.05 mm', nf > 0 && dev <= 0.05, nf + ' fill triangles, worst ' + f4(dev) + ' mm off the true surface');
  const dir = new Map();
  for (let t = 0; t < res.plate.length / 9; t++) for (let e = 0; e < 3; e++) { const [a, b] = ekey(res.plate, t, e); dir.set(a + '>' + b, t < nk ? 'kept' : 'fill'); }
  let welded = 0, bad = 0;
  for (let t = nk; t < nk + nf; t++) for (let e = 0; e < 3; e++) {
    const [a, b] = ekey(res.plate, t, e), tw = dir.get(b + '>' + a);
    if (tw === 'kept') welded++; else if (tw !== 'fill') bad++;
  }
  check(tag + ': every edge of the fill is shared with a real neighbour or another fill triangle', bad === 0, welded + ' welded to kept triangles');
  out.dev = dev; out.fillTris = nf;
  return out;
}

/* ---------------------------------------------------------------- 1. the cylinder */

console.log('=== 1. a cylinder body, a torus handle sewn to its wall, a sphere bump welded on ===');
const CYL = FX.cylinderBody();
const cyl = CYL.soup;
const cylCensus = LA.census(cyl);
check('the cylinder is closed and manifold, under 20k triangles', cylCensus.closed && !cylCensus.degen && cylCensus.tris < 20000,
  cylCensus.tris + ' triangles, ' + f3(L.volume(cyl)) + ' mm^3');
const cylDev = (x, y) => Math.abs(Math.hypot(x, y) - CYL.R);
const seedCyl = ray(cyl, [0, 100, 10], [0, -1, 0]);
let t0 = Date.now();
const AC = S.analyse(cyl, seedCyl);
const msCyl = Date.now() - t0;
check('the surface under the cursor is read as a surface, not a face', AC.ok && AC.engine === 'surface' && !AC.planar, 'region ' + AC.region.tris.length + ' triangles, ' + msCyl + ' ms');
const okC = AC.islands.filter(I => I.status === 'ok');
const handle = okC.find(I => I.groups.length === 2), bump = okC.find(I => I.groups.length === 1);
check('two things stand on it: the handle (two roots) and the bump (one)', okC.length === 2 && !!handle && !!bump,
  AC.islands.map(I => I.status + ' ' + I.tris.length).join(', '));
check('the handle stands out about 13 mm, the bump about 4.3 mm', handle && bump && Math.abs(handle.heightMm - 13) < 1.5 && Math.abs(bump.heightMm - 4.3) < 0.5,
  handle && bump ? f3(handle.heightMm) + ' / ' + f3(bump.heightMm) : '');
check('the caps are not details on the wall (they are refused, in words)', AC.islands.filter(I => I.status !== 'ok').length >= 2 &&
  AC.islands.filter(I => I.status !== 'ok').every(I => I.reason && I.reason.length > 20), AC.islands.filter(I => I.status !== 'ok').map(I => I.status).join(', '));
check('the handle is welded to the wall at both ends (two root loops, 24 corners each)', handle && handle.loops.length === 2 && handle.loops.every(Lp => Lp.verts.length === CYL.handle.loopVerts));

const RES = {};
if (handle && bump) {
  const lh = S.lift(cyl, AC, [handle.id], DEPS);
  RES.handle = gateLift('the handle', cyl, AC, [handle.id], lh, cylDev);
  const lb = S.lift(cyl, AC, [bump.id], DEPS);
  RES.bump = gateLift('the bump', cyl, AC, [bump.id], lb, cylDev);
  const both = S.lift(cyl, AC, [handle.id, bump.id], DEPS);
  gateLift('both', cyl, AC, [handle.id, bump.id], both, cylDev);
  if (both.ok) {
    check('both: two pieces', both.pieces.length === 2);
    // the body that remains reads as a bare cylinder: a fresh read finds nothing standing on it
    const seed2 = ray(both.plate, [0, 100, 10], [0, -1, 0]);
    const A2 = S.analyse(both.plate, seed2);
    check('both: a fresh read of the remaining body finds nothing standing on it', A2.ok && A2.islands.filter(I => I.status === 'ok').length === 0,
      A2.islands.map(I => I.status + ' ' + I.tris.length).join(', '));
    // the body is a cylinder again: every new corner within 0.05 mm, volume as a cylinder
    check('both: the body is the bare cylinder\'s volume (within 0.5 %)', Math.abs(L.volume(both.plate) - Math.PI * CYL.R * CYL.R * CYL.H) / (Math.PI * CYL.R * CYL.R * CYL.H) < 0.005,
      f3(L.volume(both.plate)) + ' vs ' + f3(Math.PI * CYL.R * CYL.R * CYL.H));
  }
  // Remove: the same plate, no pieces
  const rm = S.remove(cyl, AC, [handle.id, bump.id], DEPS);
  check('Remove leaves exactly the plate Lift leaves, and no pieces', rm.ok && both.ok && sameArr(rm.plate, both.plate) && !rm.pieces);
}

/* ---------------------------------------------------------------- 2. the dome with a raised ring */

console.log('\n=== 2. a dome with a raised ring ===');
const DOME = FX.domeRing();
const dome = DOME.soup;
const domeCensus = LA.census(dome);
check('the dome is closed and manifold, under 20k triangles', domeCensus.closed && !domeCensus.degen && domeCensus.tris < 20000, domeCensus.tris + ' triangles');
const domeDev = (x, y, z) => Math.abs(Math.hypot(x, y, z - (DOME.T - DOME.Rd)) - DOME.Rd);
const seedDome = ray(dome, [-15, -15, 50], [0, 0, -1]);
t0 = Date.now();
const AD = S.analyse(dome, seedDome);
check('the dome is read as a surface', AD.ok && AD.engine === 'surface' && !AD.planar, 'region ' + AD.region.tris.length + ' triangles, ' + (Date.now() - t0) + ' ms');
const okD = AD.islands.filter(I => I.status === 'ok');
check('one thing stands on it: the ring, on two root loops, 1.2 mm out', okD.length === 1 && okD[0].loops.length === 2 && Math.abs(okD[0].heightMm - DOME.h) < 0.1,
  okD.map(I => I.loops.length + ' loops, ' + f3(I.heightMm) + ' mm').join(', '));
if (okD.length === 1) {
  const ring = okD[0];
  const lr = S.lift(dome, AD, [ring.id], DEPS);
  gateLift('the ring', dome, AD, [ring.id], lr, domeDev);
  if (lr.ok) {
    // the bore stays open: the floor inside the ring is the plate's own, bit for bit; the fill is the annulus only
    const chosen = new Set(ring.tris);
    let floor = 0, floorKept = 0;
    for (let t = 0; t < dome.length / 9; t++) {
      let inside = true, top = true;
      for (let c = 0; c < 3; c++) {
        const x = dome[t * 9 + c * 3], y = dome[t * 9 + c * 3 + 1], z = dome[t * 9 + c * 3 + 2];
        if (Math.hypot(x, y) > DOME.r1 - 0.01) inside = false;
        if (z < 1) top = false;
      }
      if (inside && top) { floor++; if (!chosen.has(t)) floorKept++; }
    }
    check('the bore floor is not lifted: every triangle inside the ring stays on the plate', floor > 100 && floor === floorKept, floorKept + ' of ' + floor);
    let inBore = 0;
    for (let t = lr.keptTris; t < lr.plate.length / 9; t++) {
      const cx = (lr.plate[t * 9] + lr.plate[t * 9 + 3] + lr.plate[t * 9 + 6]) / 3, cy = (lr.plate[t * 9 + 1] + lr.plate[t * 9 + 4] + lr.plate[t * 9 + 7]) / 3;
      if (Math.hypot(cx, cy) < DOME.r1 - 1.7) inBore++;
    }
    check('the fill is under the ring, not across the bore (none further in than the lattice\'s own edge, 1.7 mm)', inBore === 0, inBore + ' fill triangles in the bore');
    const volRing = Math.PI * (DOME.r2 * DOME.r2 - DOME.r1 * DOME.r1) * DOME.h;
    check('the ring\'s volume is its annulus x its height (within 5 %)', Math.abs(lr.pieces[0].volume - volRing) / volRing < 0.05, f3(lr.pieces[0].volume) + ' vs ' + f3(volRing));
    const A3 = S.analyse(lr.plate, ray(lr.plate, [-15, -15, 50], [0, 0, -1]));
    check('a fresh read finds nothing on the dome', A3.ok && A3.islands.filter(I => I.status === 'ok').length === 0);
  }
}

/* ---------------------------------------------------------------- 3. planar faces are unchanged */

console.log('\n=== 3. planar faces: byte for byte as lift-any-face lifts them ===');
function planeKey(s, t) {
  const o = t * 9;
  const ux = s[o + 3] - s[o], uy = s[o + 4] - s[o + 1], uz = s[o + 5] - s[o + 2], vx = s[o + 6] - s[o], vy = s[o + 7] - s[o + 1], vz = s[o + 8] - s[o + 2];
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx, l = Math.hypot(cx, cy, cz);
  if (!(l > 1e-12)) return null;
  const n = [cx / l, cy / l, cz / l], h = ((s[o] + s[o + 3] + s[o + 6]) * n[0] + (s[o + 1] + s[o + 4] + s[o + 7]) * n[1] + (s[o + 2] + s[o + 5] + s[o + 8]) * n[2]) / 3;
  const r3 = x => Math.round(x * 1000) / 1000 + 0;
  return { n, nk: r3(n[0]) + ',' + r3(n[1]) + ',' + r3(n[2]), k: Math.round(h / 0.05), area: l / 2 };
}
/* lift-any-face's way (app-lift-plate.js): the face's triangles by plane, its biggest ones as seeds, the first read with islands */
function appRead(s, tpl, minH) {
  const tris = [];
  for (let t = 0; t < s.length / 9; t++) { const p = planeKey(s, t); if (p && p.nk === tpl.nk && Math.abs(p.k - tpl.k) <= 1) tris.push([t, p.area]); }
  tris.sort((a, b) => b[1] - a[1]);
  const M = LA.index(s);
  let last = null;
  for (const [t] of tris.slice(0, 3)) {
    const A = LA.analyse(s, t, { M, normal: tpl.nk.split(',').map(Number), curved: true });
    if (A.ok && A.islands.length) return A;
    last = last || A;
  }
  return last;
}
function samePlanar(tag, s, seedTri, tpl) {
  const a = appRead(s, planeKey(s, seedTri));
  const b = S.analyse(s, seedTri);
  check(tag + ': a planar region is a face - the surface read hands it on', b.ok && b.planar === true && b.engine !== 'surface', b.ok ? b.islands.length + ' features' : b.reason);
  if (!(a && a.ok && b.ok)) return;
  const offA = LA.offered(a, 0.42), offB = LA.offered(b, 0.42);
  check(tag + ': the same features are offered', offA.length === offB.length && offA.every((id, i) => id === offB[i]), offA.length + ' offered');
  if (!offA.length) return;
  const ra = LA.lift(s, a, offA, DEPS), rb = LA.lift(s, b, offB, DEPS);
  check(tag + ': the lift is byte-identical (plate and every piece)', ra.ok && rb.ok && sameArr(ra.plate, rb.plate) && ra.pieces.length === rb.pieces.length &&
    ra.pieces.every((p, i) => sameArr(p.soup, rb.pieces[i].soup)), ra.ok ? ra.pieces.length + ' pieces, plate ' + ra.plate.length / 9 + ' triangles' : ra.reason);
}
{
  const hinge = readSTL(path.join(ROOT, 'fixtures', 'features', 'feature-hull_hinge.stl'));
  let wall = -1, best = 0;
  for (let t = 0; t < hinge.length / 9; t++) {
    const p = planeKey(hinge, t);
    if (p && p.nk === '0,1,0' && p.area > best) { best = p.area; wall = t; }
  }
  samePlanar('feature-hull_hinge, +Y wall', hinge, wall);
  const BAR = PFX.barocke();
  let paper = -1, pa = 0;
  for (let t = 0; t < BAR.soup.length / 9; t++) {
    const p = planeKey(BAR.soup, t);
    if (p && p.nk === '0,0,1' && Math.abs(p.k - Math.round(3 / 0.05)) <= 1 && p.area > pa) { pa = p.area; paper = t; }
  }
  samePlanar('the Barocke plate, top', BAR.soup, paper);
  // the cylinder's own top cap is a plane too: nothing on it
  const cap = ray(cyl, [3, 2, 100], [0, 0, -1]);
  const Ac = S.analyse(cyl, cap);
  check('the cylinder\'s top cap is a face: handed on, nothing stands on it', Ac.ok && Ac.planar === true && Ac.islands.length === 0);
}

/* ---------------------------------------------------------------- 4. an assembly */

console.log('\n=== 4. an assembly: a free part held by the bump comes off with it ===');
{
  // a 1 mm cube floating over the bump's crown, a shell of its own
  const cx = -(CYL.R + CYL.bump.h + 0.8), cube = [], h = 0.5;
  const V = [[-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h], [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]].map(v => [v[0] + cx, v[1], v[2] + CYL.bump.z]);
  [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [3, 0, 4], [3, 4, 7]]
    .forEach(f => f.forEach(i => cube.push(...V[i])));
  const asm = new Float32Array(cyl.length + cube.length);
  asm.set(cyl); asm.set(cube, cyl.length);
  const Aa = S.analyse(asm, seedCyl);
  const bumpA = Aa.ok && Aa.islands.find(I => I.status === 'ok' && I.groups.length === 1);
  check('the bump holds the cube: a captured part', !!bumpA && bumpA.partCount === 1, bumpA ? bumpA.partCount + ' part' : 'no bump');
  if (bumpA) {
    const r = S.lift(asm, Aa, [bumpA.id], DEPS);
    check('lift ok', r.ok, r.ok ? '' : r.reason);
    if (r.ok) {
      const pc = r.pieces[0], shells = LA.shellsOf(LA.index(pc.soup));
      const tail = new Set(), cubeF = new Float32Array(cube);
      for (let t = pc.soup.length / 9 - 12; t < pc.soup.length / 9; t++) tail.add(tri(pc.soup, t).join(','));
      const cubeBits = Array.from({ length: 12 }, (_, t) => tri(cubeF, t).join(','));
      check('one piece of two shells, closed, the cube\'s triangles bit for bit and not fused', pc.parts === 1 && shells.n === 2 && pc.census.closed && cubeBits.every(k => tail.has(k)),
        shells.n + ' shells');
      check('the body is closed without the cube; plate + piece = source', r.plateCensus.closed && Math.abs(r.volumes.residual) < 1e-6, r.volumes.residual.toExponential(2));
      check('nothing of the cube is left on the plate (one shell, the cylinder)', LA.shellsOf(LA.index(r.plate)).n === 1);
    }
  }
}

/* ---------------------------------------------------------------- 5. refusals, and the canonical checker */

console.log('\n=== 5. refusals in words ===');
{
  const r1 = S.analyse(cyl, 1e9), r2 = S.analyse(new Float32Array(0), 0);
  check('a click on no triangle is refused in words', !r1.ok && /not on a triangle/.test(r1.reason), r1.reason);
  check('an empty mesh is refused in words', !r2.ok && /no mesh/.test(r2.reason), r2.reason);
  const none = S.lift(cyl, AC, [], DEPS);
  check('Lift with nothing chosen is refused in words', !none.ok && /nothing is chosen/.test(none.reason), none.reason);
  const refused = AC.islands.find(I => I.status !== 'ok');
  const rr = refused ? S.lift(cyl, AC, [refused.id], DEPS) : null;
  check('Lift on a feature that cannot be lifted says why and changes nothing', !!rr && !rr.ok && /cannot be lifted/.test(rr.reason) && rr.reason.length > 40, rr && rr.reason);
  const bad = S.lift(cyl, AC, [99], DEPS);
  check('Lift on no such feature is refused in words', !bad.ok && /no detail/.test(bad.reason), bad.reason);
}

console.log('\n=== tools/mesh_validate.py, self-intersection on ===');
function validate(soup, name) {
  const f = path.join(OUT, name + '.stl');
  writeSTL(f, soup);
  const j = JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--json'], { maxBuffer: 64 << 20 }).toString());
  const si = j.self_intersection || {};
  return { j, clean: j.verdict === 'PASS' && si.pierce === 0 && si.coplanar === 0,
    text: j.verdict + ' open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' chi ' + j.euler_characteristic + ' pierce ' + si.pierce + ' coplanar ' + si.coplanar };
}
if (handle && bump) {
  const lh = S.lift(cyl, AC, [handle.id], DEPS), lb = S.lift(cyl, AC, [bump.id], DEPS);
  [['the handle piece', lh.pieces[0].soup, 'handle'], ['the cylinder after the handle', lh.plate, 'cyl-after-handle'],
   ['the bump piece', lb.pieces[0].soup, 'bump'], ['the cylinder after the bump', lb.plate, 'cyl-after-bump']].forEach(([n, s, f]) => {
    const v = validate(s, f);
    check(n + ': mesh_validate PASS, 0 piercing, 0 coplanar', v.clean, v.text);
  });
}

console.log('\n' + pass + ' passed, ' + fail + ' failed' + (fail ? ' - ' + FAILS.join('; ') : ''));
process.exit(fail ? 1 : 0);
