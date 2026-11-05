#!/usr/bin/env node
/* cavityShells() (nso_hollow.js) on hollows whose walls are thick - the one
   definition of "a cavity" that Fill / Densify and Foam both ask. Fixtures are
   built here from axis boxes; no STL is read.

     node tools/nso_cavity_thickwall_test.js     exit 0 = every gate held

   WHY. The "sits in material" half of the test steps off a cavity face by a
   quarter of the wall behind it, and that wall was measured with
   nso_thickness.js's 5 mm default probe. Every wall thicker than that came
   back unmeasured, the face was skipped, and a shell with every face skipped
   was never asked at all: a 40 mm cube round a 10 mm hollow read as
   "mis-wound, not inside material" - Fill said "nothing to fill", Foam said
   "could not confirm". The probe now reaches across the whole piece.

   GATES
     1. thick-walled cube-in-cube (15 mm walls): the default probe really is
        blind here (so the fixture exercises the old miss); the inner shell is
        a cavity, the outer is not; Fill drops exactly the inner shell and
        hands back the outer cube's own triangles; Foam finds the hollow at
        its true volume and a Set comes back closed with the volume it said.
     2. captive solid inside a thick-walled cavity (20 mm walls): the hollow
        is found, the loose cube is NOT a cavity and survives Fill bit for bit,
        and Foam counts it as a captive. The same loose cube saved inside out
        is still not a cavity - it is not in material, however far the probe
        now reaches - and Fill leaves it alone.
     3. thin-wall cube-in-cube (2 mm walls) and one-thin-wall-only: found and
        filled exactly as before. */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HOLLOW = require('../nso_hollow.js');
const FOAM = require('../nso_foam.js');
const TH = require('../nso_thickness.js');

/* The cut engine, as the app loads it - Foam's Set needs rawCut. */
const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Float32Array, Float64Array,
  Int32Array, Uint32Array, Uint8Array, ArrayBuffer, Error, Infinity, NaN };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {}; var document = { readyState: "complete", ' +
  'getElementById: function () { return null; }, addEventListener: function () {} };', ctx);
for (const f of ['NSO_Repair.js', 'app-cut.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined ? '   ' + detail : ''));
  if (cond) pass++; else fail++;
}
const sameBytes = (a, b) => a.length === b.length &&
  Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));

// Triangles of an axis box [lo, hi], wound outward (or inward). 12 per box.
function box(lo, hi, inward) {
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
             [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]];
  const out = [];
  for (const q of quads) {
    for (const t of [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]) {
      for (const i of (inward ? [t[0], t[2], t[1]] : t)) out.push(v[i][0], v[i][1], v[i][2]);
    }
  }
  return out;
}
const cube = (h, inward) => box([-h, -h, -h], [h, h, h], inward);
const soupOf = (...parts) => new Float32Array([].concat(...parts));
const range = (soup, t0, n) => soup.slice(t0 * 9, (t0 + n) * 9);

/* Which shell holds face t. */
function shellOf(C, t) { return C.shells.findIndex((s) => s.indexOf(t) >= 0); }

function foamSet(soup, A, h) {
  return FOAM.foam(soup, A, 0, h, { rawCut: ctx.rawCut, skipList: [] });
}

console.log('== 1. thick-walled cube-in-cube: 40 mm round a 10 mm hollow, 15 mm walls ==');
{
  const soup = soupOf(cube(20, false), cube(5, true));
  const P = TH.prepare(soup, {});
  // A face of the inner shell (12..23), fired into its wall at the old reach.
  const t = 12, n = P.faceNormal(t), T = P.tris[t];
  const c = [0, 1, 2].map((k) => (T[0][k] + T[1][k] + T[2][k]) / 3);
  const w5 = P.wallAt(c, { normal: n });
  check('the old 5 mm probe really is blind here - the fixture exercises the miss', !w5.measured, w5.reason);

  const C = HOLLOW.cavityShells(soup, {});
  const sIn = shellOf(C, 12), sOut = shellOf(C, 0);
  check('two shells', C.shells.length === 2);
  check('the inner shell is a cavity, not "mis-wound"', C.info[sIn].cavity && !C.info[sIn].misWound,
        JSON.stringify(C.info[sIn]));
  check('the outer shell is not a cavity', !C.info[sOut].cavity && !C.info[sOut].misWound);

  const F = HOLLOW.fill(soup, {});
  check('Fill: one cavity filled', F.ok && F.filled === 1 && F.kept === 1, F.reason);
  check('...it hands back the outer cube\'s own 12 triangles, bit for bit', F.ok && sameBytes(F.soup, range(soup, 0, 12)));
  check('...1,000 mm³ of cavity now solid, piece now 64,000 mm³',
        F.ok && Math.abs(F.cavity_volume - 1000) < 1e-6 && Math.abs(F.volume_after - 64000) < 1e-6,
        F.cavity_volume + ' / ' + F.volume_after);

  const A = FOAM.analyse(soup, {});
  check('Foam: one hollow, 1,000 mm³', A.ok && A.kind === 'cavities' && A.cavities.length === 1 &&
        A.cavities[0].volume === 1000, A.reason);
  if (A.ok) {
    const r = foamSet(soup, A, 4);
    const cs = r.ok ? FOAM.census(r.soup) : {};
    check('Foam Set at 4 mm of 10: done, 400 mm³ removed', r.ok && rel(r.removedVolume, 400) < 1e-6, r.reason);
    check('...closed, 2-manifold, consistent winding', r.ok && cs.closed && !cs.degen,
          cs.open + ' open, ' + cs.nm + ' nm, ' + cs.degen + ' degen');
    check('...the outer cube untouched, in order, bit for bit',
          r.ok && sameBytes(r.soup.subarray(0, 12 * 9), range(soup, 0, 12)));
    const top = foamSet(soup, A, A.cavities[0].height);
    check('...level at the top = Fill / Densify, bit for bit', top.ok && F.ok && sameBytes(top.soup, F.soup));
  }
}

console.log('\n== 2. a captive solid inside a thick-walled cavity: still NOT a cavity ==');
{
  // 60 mm cube, 20 mm hollow (20 mm walls), a loose 6 mm cube in the hollow.
  const soup = soupOf(cube(30, false), cube(10, true), cube(3, false));
  const C = HOLLOW.cavityShells(soup, {});
  const sOut = shellOf(C, 0), sCav = shellOf(C, 12), sBall = shellOf(C, 24);
  check('three shells', C.shells.length === 3);
  check('the hollow is a cavity', C.info[sCav].cavity, JSON.stringify(C.info[sCav]));
  check('the loose cube is not a cavity, and not "mis-wound" either', !C.info[sBall].cavity && !C.info[sBall].misWound,
        JSON.stringify(C.info[sBall]));
  check('the outer shell is not a cavity', !C.info[sOut].cavity);

  const F = HOLLOW.fill(soup, {});
  check('Fill: one cavity filled, two shells kept', F.ok && F.filled === 1 && F.kept === 2, F.reason);
  check('...the outer cube and the loose cube come back bit for bit, in order',
        F.ok && sameBytes(F.soup, soupOf(Array.from(range(soup, 0, 12)), Array.from(range(soup, 24, 12)))));

  const A = FOAM.analyse(soup, {});
  check('Foam: one hollow, the loose cube a captive, 8,000 - 216 = 7,784 mm³ of empty space',
        A.ok && A.cavities.length === 1 && A.cavities[0].captives.length === 1 && A.cavities[0].volume === 7784, A.reason);

  // The same loose cube saved inside out. The probe now reaches the cavity
  // wall from it - and the step lands in the void, not in material.
  const flipped = soupOf(cube(30, false), cube(10, true), cube(3, true));
  const C2 = HOLLOW.cavityShells(flipped, {});
  const b2 = shellOf(C2, 24);
  check('an inside-out loose cube in the hollow: not a cavity, reported mis-wound', !C2.info[b2].cavity && C2.info[b2].misWound,
        JSON.stringify(C2.info[b2]));
  const F2 = HOLLOW.fill(flipped, {});
  check('...Fill fills the hollow and leaves the inside-out cube alone, in words',
        F2.ok && F2.filled === 1 && F2.kept === 2 && /left alone/.test(F2.reason) &&
        sameBytes(F2.soup.subarray(12 * 9), range(flipped, 24, 12)), F2.reason);
}

console.log('\n== 3. thin walls: unchanged ==');
{
  // 40 mm cube round a 36 mm hollow: 2 mm walls, every face inside the old reach.
  const soup = soupOf(cube(20, false), cube(18, true));
  const C = HOLLOW.cavityShells(soup, {});
  check('2 mm walls: the hollow is a cavity, the outside is not',
        C.info[shellOf(C, 12)].cavity && !C.info[shellOf(C, 0)].cavity);
  const F = HOLLOW.fill(soup, {});
  check('...Fill drops it and hands back the outer cube, bit for bit', F.ok && F.filled === 1 &&
        sameBytes(F.soup, range(soup, 0, 12)), F.reason);
  const A = FOAM.analyse(soup, {});
  check('...Foam finds it at 36³ = 46,656 mm³', A.ok && A.cavities.length === 1 && A.cavities[0].volume === 46656, A.reason);

  // One 2 mm wall, the rest 15+ mm: found before (one face measured) and now.
  const one = soupOf(cube(20, false), box([-5, -5, -5], [18, 5, 5], true));
  const C1 = HOLLOW.cavityShells(one, {});
  check('one thin wall, five thick: the hollow is a cavity', C1.info[shellOf(C1, 12)].cavity, JSON.stringify(C1.info));
  const F1 = HOLLOW.fill(one, {});
  check('...Fill drops it', F1.ok && F1.filled === 1 && sameBytes(F1.soup, range(one, 0, 12)), F1.reason);

  // A lone shell is still never a cavity, and a solid still has nothing to fill.
  const solid = soupOf(cube(20, false));
  const Fs = HOLLOW.fill(solid, {});
  check('a solid cube: nothing to fill, said so', !Fs.ok && /nothing to fill/.test(Fs.reason), Fs.reason);
}

console.log('\npassed ' + pass + ' check(s), ' + fail + ' failure(s)');
process.exit(fail ? 1 : 0);
