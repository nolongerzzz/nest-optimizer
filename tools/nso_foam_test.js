#!/usr/bin/env node
/* Foam (nso_foam.js) - the geometry, in Node, on fixtures generated here
   (tools/nso_foam_fixtures.js) and on fixtures/box_cavity_30.stl.

     node tools/nso_foam_test.js        exit 0 = every gate held

   GATES, per fixture and level
     - the result is closed and 2-manifold with consistent winding, by this
       file's census AND by the canonical checker (tools/mesh_validate.py
       --gate, self-intersection included)
     - every triangle off the foamed cavity's shell comes back in its own
       order, bit for bit (the outer surface, other cavities, a captive solid)
     - the volume removed is the cavity's volume below the level, worked out
       from the shapes - within 0.1%
     - level at the top gives exactly Fill / Densify's soup; level at the
       floor gives the input back unchanged
     - the readout (preview) is the number Set removes, and reads in words
     - a painted wall of the cavity stands it down, named; paint elsewhere
       does not; no skip list at all is refused
     - the input soup is never written to, so Undo's saved array is the piece
     - Cut, Extend and Smooth still run on the foamed piece
   and the refusals: an open cup, a solid piece, a level through a captive
   solid - each in words, nothing changed. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { readSTL, writeSTL } = require('./nso_stl_io.js');
const FX = require('./nso_foam_fixtures.js');

const ROOT = path.join(__dirname, '..');
const MV = path.join(ROOT, 'tools', 'mesh_validate.py');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-foam-'));

const FOAM = require('../nso_foam.js');
const HOLLOW = require('../nso_hollow.js');

/* The cut engine, Extend and Smooth, as the app loads them. */
const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Float32Array, Float64Array,
  Int32Array, Uint32Array, Uint8Array, ArrayBuffer, Error, Infinity, NaN };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {}; var document = { readyState: "complete", ' +
  'getElementById: function () { return null; }, addEventListener: function () {} };', ctx);
for (const f of ['NSO_Repair.js', 'app-cut.js', 'app-extend.js', 'app-sculpt.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
if (!ctx.NSO_Repair && ctx.window.NSO_Repair) ctx.NSO_Repair = ctx.window.NSO_Repair;
const DEPS = { rawCut: ctx.rawCut };

let pass = 0, fail = 0;
const FAILED = [];
function check(name, cond, detail) {
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined ? '   ' + detail : ''));
  if (cond) pass++; else { fail++; FAILED.push(name); }
}
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
const sameBytes = (a, b) => a.length === b.length &&
  Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;

let canonN = 0;
function canonical(soup) {
  const p = path.join(TMP, 'f' + (canonN++) + '.stl');
  writeSTL(p, soup, 'nso foam');
  let out, gate = true;
  try { out = execFileSync('python3', [MV, p, '--json', '--gate'], { maxBuffer: 1 << 28 }); }
  catch (e) { out = e.stdout; gate = false; }
  const j = JSON.parse(out.toString());
  j.gatePass = gate;
  return j;
}

/* The triangles of `soup` that are not on the faces listed, in order. */
function offShell(soup, faces) {
  const drop = new Set(faces);
  const out = [];
  for (let t = 0; t < soup.length / 9; t++) if (!drop.has(t)) for (let i = 0; i < 9; i++) out.push(soup[t * 9 + i]);
  return new Float32Array(out);
}

/* The gates every Set result is held to. */
function gateResult(tag, src, A, cv, r, expectBelow) {
  const keep = offShell(src, cv.faces);
  check(tag + ': set', r.ok && r.changed, r.reason);
  if (!r.ok) return;
  const cs = FOAM.census(r.soup);
  check(tag + ': closed, 2-manifold, consistent winding (census)', cs.closed && !cs.degen,
        cs.open + ' open, ' + cs.nm + ' nm, ' + cs.degen + ' degen');
  const cj = canonical(r.soup);
  check(tag + ': canonical checker --gate passes', cj.gatePass && cj.open_edges === 0 && cj.nonmanifold_edges === 0 &&
        cj.inconsistent_winding_edges === 0 && cj.self_intersection.pierce === 0,
        'open ' + cj.open_edges + ', nm ' + cj.nonmanifold_edges + ', winding ' + cj.inconsistent_winding_edges +
        ', pierce ' + cj.self_intersection.pierce + ', degen ' + cj.degenerate_tris);
  check(tag + ': every triangle off this cavity is untouched, in order, bit for bit',
        sameBytes(r.soup.subarray(0, keep.length), keep), (keep.length / 9) + ' tris');
  if (expectBelow != null) {
    check(tag + ': removed volume = the cavity\'s volume below the level, within 0.1%',
          rel(r.removedVolume, expectBelow) < 1e-3,
          r.removedVolume.toFixed(3) + ' vs ' + expectBelow.toFixed(3) + ' (' + (rel(r.removedVolume, expectBelow) * 100).toFixed(5) + '%)');
  }
  const vSrc = HOLLOW.signedVolume(src, null), vRes = HOLLOW.signedVolume(r.soup, null);
  // A captive solid now held in the foam is counted twice by a signed-volume
  // sum (its own shell, and the shell that used to hold it): add it back.
  check(tag + ': the piece gained exactly the volume removed from the hollow',
        rel(vRes - vSrc, r.removedVolume + r.embeddedVolume) < 1e-6,
        (vRes - vSrc).toFixed(4) + ' vs ' + r.removedVolume.toFixed(4) + ' + ' + r.embeddedVolume.toFixed(4) + ' embedded');
  const p = FOAM.preview(src, A, cv.id, r.height, DEPS);
  check(tag + ': the readout\'s volume is the volume Set removes', p.ok && rel(p.foamVolume, r.removedVolume) < 1e-6,
        p.reason);
}

function analyse(soup, up) { return FOAM.analyse(soup, { up: up }); }
function set(soup, A, id, h, skip, more) {
  return FOAM.foam(soup, A, id, h, Object.assign({ rawCut: DEPS.rawCut, skipList: skip || [] }, more || {}));
}

/* ------------------------------------------------------------------ */
console.log('\n== 1. box_cavity_30.stl: one cavity ==');
{
  const src = readSTL(path.join(ROOT, 'fixtures', 'box_cavity_30.stl'));
  const before = Float32Array.from(src);
  const A = analyse(src);
  check('one hollow found, named with its volume', A.ok && A.cavities.length === 1 &&
        /Hollow 1 - 17,576 mm³/.test(A.reason), A.reason);
  const cv = A.cavities[0];
  for (const h of [0.5, 5, 10.94, 13, 20, 25.9]) gateResult('h ' + h, src, A, cv, set(src, A, 0, h), 26 * 26 * h);

  const h42 = 7396 / 676;
  const p = FOAM.preview(src, A, 0, h42, DEPS);
  check('readout reads "Foam: 42% of the hollow, 7,396 mm³"', p.reason === 'Foam: 42% of the hollow, 7,396 mm³', p.reason);
  check('preview draws a closed foam solid and a ring at the level', FOAM.census(p.foam).closed && p.ring.length >= 4 * 6,
        (p.foam.length / 9) + ' foam tris, ' + (p.ring.length / 6) + ' ring segments');
  let ringOk = true;
  for (let i = 2; i < p.ring.length; i += 3) if (Math.abs(p.ring[i] - (-13 + h42)) > 1e-5) ringOk = false;
  check('...the ring sits on the level', ringOk);

  const r = set(src, A, 0, 10.94);
  const floor = [];
  for (let t = 0; t < r.soup.length / 9; t++) {
    const o = t * 9, z = -13 + 10.94;
    if ([2, 5, 8].every(k => Math.abs(r.soup[o + k] - Math.fround(z)) < 1e-6)) {
      const nz = (r.soup[o + 3] - r.soup[o]) * (r.soup[o + 7] - r.soup[o + 1]) - (r.soup[o + 4] - r.soup[o + 1]) * (r.soup[o + 6] - r.soup[o]);
      floor.push(nz);
    }
  }
  check('the floor is flat at the level and faces UP, into the void that is left', floor.length >= 2 && floor.every(n => n > 0),
        floor.length + ' floor tris');
  const A2 = analyse(r.soup);
  check('...and what is left is still a hollow, the volume Set says is left',
        A2.cavities.length === 1 && rel(A2.cavities[0].volume, r.remainingVolume) < 1e-6,
        A2.cavities.length + ' hollow(s), ' + (A2.cavities[0] && A2.cavities[0].volume.toFixed(2)));

  const top = set(src, A, 0, cv.height);
  const fill = HOLLOW.fill(src, {});
  check('level at the top: exactly Fill / Densify\'s output, bit for bit', top.ok && fill.ok && sameBytes(top.soup, fill.soup),
        (top.soup.length / 9) + ' vs ' + (fill.soup.length / 9) + ' tris');
  const over = set(src, A, 0, cv.height + 5);
  check('...and a level past the top is the top', sameBytes(over.soup, fill.soup));
  const bottom = set(src, A, 0, 0);
  check('level at the floor: nothing changes - the input comes back as it went in',
        bottom.ok && !bottom.changed && bottom.soup === src, bottom.reason);
  check('the input soup was never written to (Undo holds it as it was)', sameBytes(src, before));
}

console.log('\n== 2. two cavities of different heights, each foamed on its own ==');
{
  const F = FX.box2();
  const A = analyse(F.soup);
  check('two hollows found', A.cavities.length === 2, A.reason);
  // Match each found cavity to its box by its span.
  const which = cv => F.cavities.findIndex(c => Math.abs(c.hi[2] - c.lo[2] - cv.height) < 1e-6);
  const tall = A.cavities.find(cv => which(cv) === 0), short = A.cavities.find(cv => which(cv) === 1);
  check('...24 mm and 10 mm tall', !!tall && !!short, A.cavities.map(c => c.height).join(', '));
  for (const [cv, c] of [[tall, F.cavities[0]], [short, F.cavities[1]]]) {
    const fp = (c.hi[0] - c.lo[0]) * (c.hi[1] - c.lo[1]);
    for (const h of [3, cv.height * 0.6]) {
      const r = set(F.soup, A, cv.id, h);
      gateResult('hollow ' + (cv.id + 1) + ' at ' + h.toFixed(1), F.soup, A, cv, r, fp * h);
      const other = A.cavities.find(x => x !== cv);
      const A2 = analyse(r.soup);
      check('  ...the other hollow is still there, the same volume', A2.cavities.length === 2 &&
            A2.cavities.some(x => rel(x.volume, other.volume) < 1e-9));
    }
  }
  // Both to the top, one after the other = Fill.
  const r1 = set(F.soup, A, tall.id, tall.height);
  const A1 = analyse(r1.soup);
  const r2 = set(r1.soup, A1, 0, A1.cavities[0].height);
  const fill = HOLLOW.fill(F.soup, {});
  check('both foamed to the top, one at a time = Fill / Densify\'s output, bit for bit',
        r2.ok && sameBytes(r2.soup, fill.soup));
  const p = FOAM.preview(F.soup, A, short.id, 5, DEPS);
  check('the readout is per hollow: half of the 10 mm one is 50%', /^Foam: 50% of the hollow, 2,000 mm³$/.test(p.reason), p.reason);
}

console.log('\n== 3. a cylinder with a stepped cavity: two pockets above the chamber ==');
{
  const F = FX.stepped();
  const A = analyse(F.soup);
  check('one hollow found, the chamber and both chimneys', A.cavities.length === 1 &&
        Math.abs(A.cavities[0].volume - F.below(1e9)) < 1e-6, A.reason);
  const cv = A.cavities[0];
  for (const L of [5, 7, 10, 11.3, 14, 18, 21.5]) {
    const r = set(F.soup, A, 0, L - cv.lo);
    gateResult('level z ' + L, F.soup, A, cv, r, F.below(L));
    if (L > 10 && L < 18) {
      check('  ...above the chamber the hollow splits: two closed pockets', r.pockets === 2, r.reason);
      const A2 = analyse(r.soup);
      const want = [FX.voxelBelow(F.left, 2, F.origin, 1e9) - FX.voxelBelow(F.left, 2, F.origin, L),
                    FX.voxelBelow(F.right, 2, F.origin, 1e9) - FX.voxelBelow(F.right, 2, F.origin, L)].sort((a, b) => a - b);
      const got = A2.cavities.map(c => c.volume).sort((a, b) => a - b);
      check('  ...each pocket is its own hollow, its own chimney\'s volume above the level',
            got.length === 2 && rel(got[0], want[0]) < 1e-6 && rel(got[1], want[1]) < 1e-6,
            got.map(v => v.toFixed(2)).join(' + ') + ' vs ' + want.map(v => v.toFixed(2)).join(' + '));
    }
    if (L > 18) check('  ...past the short chimney\'s top: one pocket left', r.pockets === 1, r.reason);
  }
  const top = set(F.soup, A, 0, cv.height), fill = HOLLOW.fill(F.soup, {});
  check('level at the top = Fill / Densify, bit for bit', sameBytes(top.soup, fill.soup));
}

console.log('\n== 4. a round cavity, and poses: on its side, and tilted ==');
{
  const R = FX.round();
  const A = analyse(R.soup);
  gateResult('round, h 9', R.soup, A, A.cavities[0], set(R.soup, A, 0, 9), R.area * 9);

  // The block with two cavities, lying with its raw -Y up: the plate's vertical
  // is the piece's -Y as it lies, so the foam rises along -Y.
  const F = FX.box2();
  const As = analyse(F.soup, [0, -1, 0]);
  check('on its side: the hollows span the piece\'s Y, 20 mm each', As.cavities.length === 2 &&
        As.cavities.every(c => Math.abs(c.height - 20) < 1e-9), As.cavities.map(c => c.height).join(', '));
  const cs = As.cavities[0];
  const box = F.cavities[Math.abs(cs.volume - 20 * 20 * 24) < 1 ? 0 : 1];
  const footS = (box.hi[0] - box.lo[0]) * (box.hi[2] - box.lo[2]);
  const rs = set(F.soup, As, cs.id, 7);
  gateResult('on its side, h 7', F.soup, As, cs, rs, footS * 7);
  const A2 = analyse(rs.soup, [0, -1, 0]);
  const left = A2.cavities.find(c => rel(c.volume, cs.volume - rs.removedVolume) < 1e-6);
  check('...the foam filled from the piece\'s high Y down (its bottom as it lies)', !!left &&
        Math.abs(left.lo - (cs.lo + 7)) < 1e-4, left && (left.lo.toFixed(3) + ' vs ' + (cs.lo + 7).toFixed(3)));

  // Tilted 15 degrees about Y: the level is a slanted plane through the box cavity.
  const th = 15 * Math.PI / 180, up = [Math.sin(th), 0, Math.cos(th)];
  const B = FX.box1();
  const At = analyse(B.soup, up);
  const ct = At.cavities[0];
  for (const h of [12, 20]) {
    const L = ct.lo + h;
    const rt = set(B.soup, At, 0, h);
    gateResult('tilted 15°, h ' + h, B.soup, At, ct, rt, FX.boxBelow(B.cavities[0], up, L));
  }
}

console.log('\n== 5. a captive solid inside the cavity: never touched ==');
{
  const C = FX.captive();
  const A = analyse(C.soup);
  check('one hollow, and the loose cube is not one of them', A.cavities.length === 1 && A.cavities[0].captives.length === 1,
        A.reason + ' captives: ' + (A.cavities[0] ? A.cavities[0].captives.length : '?'));
  check('...the hollow\'s volume is its empty space: 30³ less the 10³ cube', A.cavities[0].volume === 26000 &&
        /Hollow 1 - 26,000 mm³/.test(A.reason), A.reason);
  const pIn = FOAM.preview(C.soup, A, 0, 15, DEPS);
  check('the readout while the foam rises through the cube counts only empty space',
        Math.abs(pIn.foamVolume - (900 * 15 - 500)) < 1e-6 && !!pIn.captiveCross, pIn.reason);
  const cv = A.cavities[0];
  const shells = HOLLOW.cavityShells(C.soup, {});
  const ballShell = shells.shells[cv.captives[0].shell].slice().sort((a, b) => a - b);
  const ballTris = new Float32Array(ballShell.length * 9);
  ballShell.forEach((t, i) => ballTris.set(C.soup.subarray(t * 9, t * 9 + 9), i * 9));
  const below = set(C.soup, A, 0, 6);
  gateResult('below the cube (h 6)', C.soup, A, cv, below, 30 * 30 * 6);
  const inside = set(C.soup, A, 0, 15);
  check('a level through the cube is refused, in words, nothing changed', !inside.ok && inside.soup === C.soup &&
        /loose solid inside hollow 1/.test(inside.reason) && /below 10\.0 mm or above 20\.0 mm/.test(inside.reason), inside.reason);
  const past = set(C.soup, A, 0, 24);
  gateResult('past the cube (h 24)', C.soup, A, cv, past, 30 * 30 * 24 - 1000);
  let found = false;
  for (let t = 0; t + ballTris.length / 9 <= past.soup.length / 9 && !found; t++) {
    if (sameBytes(past.soup.subarray(t * 9, t * 9 + ballTris.length), ballTris)) found = true;
  }
  check('...the cube is still there, its own triangles bit for bit, now held in the foam', found);
  const top = set(C.soup, A, 0, cv.height), fill = HOLLOW.fill(C.soup, {});
  check('level at the top = Fill / Densify (which keeps the cube too), bit for bit', sameBytes(top.soup, fill.soup));
}

console.log('\n== 6. refusals in words: an open cup, a solid piece ==');
{
  const cup = FX.cup();
  const A = analyse(cup.soup);
  check('an open cup: "open to the outside", "open vessels come later"', !A.ok && A.kind === 'open' &&
        /open to the outside/.test(A.reason) && /open vessels come later/.test(A.reason), A.reason);
  const solid = FX.solid();
  const S = analyse(solid.soup);
  check('a solid piece: no enclosed hollow, said so', !S.ok && S.kind === 'none' && /no enclosed hollow/.test(S.reason), S.reason);
  const box20 = readSTL(path.join(ROOT, 'fixtures', 'box-20mm.stl'));
  const S2 = analyse(box20);
  check('box-20mm.stl: no enclosed hollow either', S2.kind === 'none', S2.reason);
  const thick = new Float32Array(FX.boxTris([-20, -20, -20], [20, 20, 20], false).concat(FX.boxTris([-5, -5, -5], [5, 5, 5], true)));
  const T = analyse(thick);
  check('a sealed hollow with every wall over the 5 mm probe: Fill cannot confirm it, and Foam says so - not "open"',
        !T.ok && T.kind === 'unconfirmed' && /could not confirm/.test(T.reason) && !HOLLOW.fill(thick, {}).ok, T.reason);
  const r = set(solid.soup, S, 0, 5);
  check('asked to foam anyway: refused, the piece handed back', !r.ok && r.soup === solid.soup, r.reason);
}

console.log('\n== 7. paint: sub-region ==');
{
  const src = readSTL(path.join(ROOT, 'fixtures', 'box_cavity_30.stl'));
  const A = analyse(src);
  // A recorded click: axis, side, the plane n.p = d. The cavity's floor faces
  // into the void (+Z) at z = -13; its ceiling faces -Z at z = 13.
  const floor = { axisIdx: 2, keepMin: false, d: -13, inner: true };
  const ceiling = { axisIdx: 2, keepMin: true, d: -13, inner: true };
  const outerTop = { axisIdx: 2, keepMin: false, d: 15, inner: false };
  const rf = set(src, A, 0, 10, [floor]);
  check('the painted floor of the hollow stands Foam down, naming the face', !rf.ok && rf.soup === src &&
        /Foam stood down - the inner Z\+ face at -13\.00 is painted/.test(rf.reason), rf.reason);
  const rn = set(src, A, 0, 10, [floor], { faceName: () => 'the inner Y+ face at -13.00' });
  check('...in the app\'s own words for that face when it has them', /the inner Y\+ face at -13\.00 is painted/.test(rn.reason));
  const rc = set(src, A, 0, 10, [ceiling, outerTop]);
  check('a painted ceiling the foam does not reach, and a painted outer face: no stand-down', rc.ok && rc.changed, rc.reason);
  const rt = set(src, A, 0, 26, [ceiling]);
  check('...but Fill it all reaches the ceiling, so it stands down', !rt.ok && /is painted/.test(rt.reason), rt.reason);
  const rs = FOAM.foam(src, A, 0, 10, { rawCut: DEPS.rawCut });
  check('no skip list at all is refused - never assumed unpainted', !rs.ok && /skip list/.test(rs.reason), rs.reason);
}

console.log('\n== 8. a hollowed piece (nso_hollow.js), a curved cavity ==');
{
  const cyl = FX.prismTris(12, 0, 30, 48, false);
  const h = HOLLOW.hollow(new Float32Array(cyl), { wall: 2 });
  check('the hollow was carved', h.ok, h.reason && h.reason.slice(0, 80));
  if (h.ok) {
    const A = analyse(h.soup);
    check('...and Foam finds it', A.cavities.length === 1, A.reason);
    const cv = A.cavities[0];
    const r = set(h.soup, A, 0, cv.height * 0.45);
    gateResult('hollowed cylinder at 45%', h.soup, A, cv, r, null);
    check('  ...what is removed and what is left add up to the hollow', rel(r.removedVolume + r.remainingVolume, cv.volume) < 1e-9);
    const top = set(h.soup, A, 0, cv.height), fill = HOLLOW.fill(h.soup, {});
    check('  ...level at the top = Fill / Densify, bit for bit', sameBytes(top.soup, fill.soup));
  }
}

console.log('\n== 9. other tools still run on the foamed piece ==');
{
  const F = FX.stepped();
  const A = analyse(F.soup);
  const r = set(F.soup, A, 0, 14 - A.cavities[0].lo);
  for (const [ax, at, keep] of [[2, 12, true], [2, 20, false], [0, -5, true], [1, 1.3, false]]) {
    let c = null, err = null;
    try { c = ctx.rawCut(r.soup, ax, at, keep); } catch (e) { err = e.message; }
    const cs = c ? FOAM.census(c) : null;
    check('Cut through the foamed piece at ' + 'XYZ'[ax] + ' ' + at + ': a closed half', !!cs && cs.closed && !cs.degen,
          err || (cs.open + ' open, ' + cs.nm + ' nm'));
  }
  const ex = ctx.NSO_extendRaw(r.soup, { length: 50 });
  check('Extend runs on it: a result or a refusal in words, never a throw', ex && (ex.ok || typeof ex.reason === 'string'),
        ex.ok ? 'extended' : ex.reason);
  if (ex.ok) check('  ...and its result is closed', FOAM.census(ex.tris).closed);
  const box = readSTL(path.join(ROOT, 'fixtures', 'box_cavity_30.stl'));
  const Ab = analyse(box);
  const rb = set(box, Ab, 0, 9);
  const sm = ctx.NSO_smoothGlobal(rb.soup, { passes: 1, strength: 0.3 });
  check('Smooth (a deformer) runs on the foamed box', sm && (sm.ok || typeof sm.reason === 'string'), sm.ok ? 'smoothed' : sm.reason);
  if (sm.ok) check('  ...and its result is closed', FOAM.census(sm.tris).closed);
  const exb = ctx.NSO_extendRaw(rb.soup, { length: 40 });
  check('Extend on the foamed box', exb && (exb.ok || typeof exb.reason === 'string'), exb.ok ? 'extended' : exb.reason);
  if (exb.ok) check('  ...closed', FOAM.census(exb.tris).closed);
  const A3 = analyse(rb.soup);
  const rb2 = set(rb.soup, A3, 0, 5);
  gateResult('Foam again on the foamed box', rb.soup, A3, A3.cavities[0], rb2, 26 * 26 * 5);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\npassed ' + pass + ' check(s), ' + fail + ' failure(s)');
if (fail) { console.log('FAILED:\n  ' + FAILED.join('\n  ')); process.exit(1); }
