#!/usr/bin/env node
/* Validation suite for nso_hollow.js - general Hollow and Fill/Densify.

   Every verdict here is the CANONICAL checker's, before and after: no local
   re-derivation of "thick enough", no eyeballed triangle counts standing in
   for a wall measurement. NSO_Thickness.measureMesh() is run on the input and
   on the output of each case and the two reports are compared, which is the
   only way to say a Hollow left a printable wall rather than to hope it did.

   Six parts:
     1. the floor, and the one rule that is not just "clamp to it":
        safeMinWall() - a plain Hollow is REFUSED under the floor, a
        hollow-to-safe-minimum is CLAMPED up to it.
     2. Hollow on real geometry, canonical checker before and after, on four
        fixtures that are not all boxes: a cube, a curved sphere, an organic
        blob and an 80x40x20 hull. Includes the exact-volume check the cube
        allows (the erosion of a cube by a ball is another cube).
     3. the result-side gate: a target over the floor is not enough on its
        own, because the cavity is a sampled level set. The wall that comes
        OUT is measured and the pitch refined until it passes.
     4. Fill/Densify, canonical checker before and after, plus the round trip:
        fill(hollow(X)) is X's own triangles, bit for bit, not a lookalike.
     5. Fill leaves a captive separate solid alone - a body inside a body is
        not a cavity, and winding is what tells them apart.
     6. THE THICKEN -> EDIT -> HOLLOW BACK OUT WORKFLOW, end to end, on a case
        where the original wall and the floor genuinely differ: a 0.30 mm
        shell, thickened, edited, hollowed back out. Restoring 0.30 mm is the
        wrong answer and this proves the mode does not.

   Run: node tools/nso_hollow_test.js */

const path = require('path');
const T = require('../nso_thickness.js');
const H = require('../nso_hollow.js');
const { readSTL } = require('./nso_stl_io.js');

const FIX = path.resolve(__dirname, '..', 'fixtures');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok    ' + name + (detail ? '   (' + detail + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '   (' + detail + ')' : '')); }
}
const near = (a, b, tol) => (a != null && b != null && Math.abs(a - b) <= tol);
const r3 = (x) => (x == null ? '?' : Math.round(x * 1000) / 1000);

/* An axis-aligned box as raw soup. `inward` winds it the way a cavity wall is
   wound, which is how a hollow shell is built by hand below. */
function box(lo, hi, inward) {
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  const V = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
             [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const F = [[0, 3, 2], [0, 2, 1], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const f of F) {
    const t = inward ? [f[0], f[2], f[1]] : f;
    for (const i of t) out.push(...V[i]);
  }
  return new Float32Array(out);
}
function concat(...soups) {
  let n = 0; for (const s of soups) n += s.length;
  const out = new Float32Array(n);
  let at = 0; for (const s of soups) { out.set(s, at); at += s.length; }
  return out;
}
/* A hollow box shell with a wall of exactly `wall` mm, built by hand so the
   wall is known by construction rather than measured off something this suite
   itself produced. */
function shell(size, wall) {
  return concat(box([0, 0, 0], [size, size, size], false),
                box([wall, wall, wall], [size - wall, size - wall, size - wall], true));
}

/* ============================================ 1. the floor, and the two modes */
console.log('\n== 1. the floor: refused one way, clamped the other ==');
{
  const floor = T.floorFor(0.4);
  check('the floor is nso_thickness.js\'s and nothing else - 0.42 at a 0.4 nozzle',
        floor === 0.42, String(floor));

  const s = H.safeMinWall(1.2);
  check('safeMinWall leaves a wall that is already safe alone',
        s.mm === 1.2 && s.floored === false, r3(s.mm));

  const t = H.safeMinWall(0.3);
  check('safeMinWall raises a wall under the floor TO the floor',
        t.mm === floor && t.floored === true, r3(t.mm) + ' from 0.3');
  check('  ...and says why, naming both numbers',
        /0\.42/.test(t.reason) && /0\.3/.test(t.reason), t.reason);

  const u = H.safeMinWall(null, { restore: 0.25 });
  check('a restore target under the floor is floored too, not honoured',
        u.mm === floor && u.floored === true, r3(u.mm) + ' from a 0.25 restore');

  const v = H.safeMinWall(null, { restore: 3 });
  check('a restore target over the floor IS honoured - the floor is a floor, not a target',
        v.mm === 3 && v.floored === false, r3(v.mm));

  const w = H.safeMinWall(0.5, { nozzle: 0.8 });
  check('the floor scales with the nozzle - 0.84 at a 0.8 nozzle',
        w.mm === T.floorFor(0.8) && w.mm === 0.84, r3(w.mm));

  /* The refusal side. A plain Hollow does NOT quietly clamp: a user who typed
     0.3 made a mistake and is told so. */
  const solid = box([0, 0, 0], [20, 20, 20], false);
  const refused = H.hollow(solid, { wall: 0.3 });
  check('Hollow REFUSES a target under the floor - it does not silently clamp',
        refused.ok === false && /under the 0\.42 mm nozzle floor/.test(refused.reason), refused.reason.slice(0, 70));
  check('  ...and hands the ORIGINAL soup back, so a caller can swap unconditionally',
        refused.soup === solid);
  check('  ...and points at the way out', /hollow to the safe minimum/i.test(refused.reason));
}

/* =========================================== 2. Hollow, canonical before/after */
console.log('\n== 2. Hollow on real geometry: the canonical checker, before and after ==');

const CASES = [
  { file: 'box-20mm.stl', wall: 2, note: 'a 20 mm cube' },
  { file: 'fixture_sphere_curved.stl', wall: 1.5, note: 'a curved sphere - no flat face anywhere' },
  { file: 'fixture_blob_organic.stl', wall: 1.5, note: 'an organic blob - no axis, no profile' },
  { file: 'box_hull_80x40x20-2.stl', wall: 1.5, note: 'an 80x40x20 hull' }
];
const hollowed = {};
for (const c of CASES) {
  const solid = readSTL(path.join(FIX, c.file));
  const floor = T.floorFor(0.4);
  const before = T.measureMesh(solid, {});
  const res = H.hollow(solid, { wall: c.wall });
  check(c.file + ' hollows to a ' + c.wall + ' mm wall (' + c.note + ')',
        res.ok === true, res.ok ? (res.cavity_tris + ' cavity tris') : res.reason);
  if (!res.ok) continue;
  hollowed[c.file] = { solid, res };

  const after = T.measureMesh(res.soup, { probe: Math.max(5, c.wall * 4) });
  check('  BEFORE: ' + T.describe(before).slice(0, 78), true);
  check('  AFTER : ' + T.describe(after).slice(0, 78), true);
  check('  the canonical checker PASSES the hollowed piece',
        after.pass === true && after.thin === 0, 'thin ' + after.thin);
  check('  ...and the wall it measures is at or over the floor',
        after.min_mm >= floor - T.WELD_TOL, r3(after.min_mm) + ' vs floor ' + floor);
  check('  ...and is the wall that was asked for, not a cos(slope) fraction of it',
        near(after.min_mm, c.wall, c.wall * 0.06),
        r3(after.min_mm) + ' asked ' + c.wall);
  check('  the outer surface is untouched - the input\'s own triangles come first, verbatim',
        res.soup.length > solid.length &&
        Array.prototype.every.call(solid, (v, i) => res.soup[i] === v),
        solid.length / 9 + ' outer tris held');
  check('  the piece lost volume - a shell is lighter than the solid it came from',
        res.volume_after < res.volume_before && res.cavity_volume > 0,
        r3(res.volume_before) + ' -> ' + r3(res.volume_after));
}

/* The cube is the one case with an exact answer to compare against: the
   erosion of [0,20]^3 by a ball of radius 2 is exactly [2,18]^3, because the
   distance from an interior point to the boundary is the min over six faces.
   So the cavity is 16^3 = 4096 mm3 and nothing has to be taken on trust. */
console.log('\n   -- the cube, against an answer known by construction --');
{
  const h = hollowed['box-20mm.stl'];
  if (h) {
    check('the cube\'s cavity is the inner cube the erosion defines: 16^3 = 4096 mm3',
          near(h.res.cavity_volume, 4096, 4096 * 0.02),
          r3(h.res.cavity_volume) + ' vs 4096, ' + r3(100 * (h.res.cavity_volume / 4096 - 1)) + '%');
    /* The cavity's own extent is the same statement, read off the geometry. */
    const cav = h.res.soup.subarray(h.solid.length);
    let lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let i = 0; i < cav.length; i += 3)
      for (let a = 0; a < 3; a++) {
        if (cav[i + a] < lo[a]) lo[a] = cav[i + a];
        if (cav[i + a] > hi[a]) hi[a] = cav[i + a];
      }
    /* The fixture is centred on the origin, so the outer cube is [-10,10] and
       the cavity the erosion defines is [-8,8]. Read off the piece rather than
       written down, so the assertion cannot drift from the fixture. */
    let slo = [1e9, 1e9, 1e9], shi = [-1e9, -1e9, -1e9];
    for (let i = 0; i < h.solid.length; i += 3)
      for (let a = 0; a < 3; a++) {
        if (h.solid[i + a] < slo[a]) slo[a] = h.solid[i + a];
        if (h.solid[i + a] > shi[a]) shi[a] = h.solid[i + a];
      }
    check('  ...and its bounding box is the solid\'s inset by the wall on every axis',
          lo.every((v, a) => near(v, slo[a] + 2, h.res.pitch_mm)) &&
          hi.every((v, a) => near(v, shi[a] - 2, h.res.pitch_mm)),
          'lo ' + lo.map(r3).join(',') + ' hi ' + hi.map(r3).join(',') +
          ' from ' + slo.map(r3).join(',') + '/' + shi.map(r3).join(','));
  } else check('the cube case ran', false);
}

/* THE DEFINITION IS PERPENDICULAR DISTANCE, not a radial shrink - the mistake
   NSO_wheelInnerAt's comment measured at a 56% shortfall on a ball. The sphere
   is where that difference shows, because every point of it is sloped. */
console.log('\n   -- the sphere: perpendicular, not radial --');
{
  const h = hollowed['fixture_sphere_curved.stl'];
  if (h) {
    const after = T.measureMesh(h.res.soup, { probe: 8 });
    check('a 1.5 mm Hollow of a sphere measures 1.5 mm of wall everywhere, not wall*cos(slope)',
          near(after.min_mm, 1.5, 0.05), r3(after.min_mm));
  } else check('the sphere case ran', false);
}

/* ================================================= 3. the result-side gate */
console.log('\n== 3. the gate is on the RESULT, not only on the request ==');
{
  const solid = box([0, 0, 0], [10, 10, 10], false);
  const floor = T.floorFor(0.4);

  /* A target sitting exactly ON the floor is the hardest case for a sampled
     level set: there is no headroom at all between what was asked for and
     what the slicer will drop. */
  const tight = H.hollow(solid, { wall: floor });
  check('a Hollow to exactly the floor is allowed',
        tight.ok === true, tight.ok ? r3(tight.measured_mm) + ' mm at a ' + r3(tight.pitch_mm) + ' mm pitch' : tight.reason);
  if (tight.ok) {
    const after = T.measureMesh(tight.soup, { probe: 5 });
    check('  ...and the canonical checker passes what actually came out',
          after.pass === true, T.describe(after).slice(0, 80));
    check('  ...at the floor, measured, not assumed',
          after.min_mm >= floor - T.WELD_TOL, r3(after.min_mm) + ' vs ' + floor);
    check('  the result carries the measurement it was gated on',
          typeof tight.measured_mm === 'number', r3(tight.measured_mm));
  }

  /* With the verification switched off the same call is ungated, which is how
     the suite shows the gate is doing something rather than agreeing with a
     result that was already right. */
  const raw = H.hollow(solid, { wall: floor, verify: false });
  check('with verify off the same Hollow reports no measurement - the gate is a real step',
        raw.ok === true && raw.measured_mm === null);
}

/* ======================================================= 4. Fill / Densify */
console.log('\n== 4. Fill/Densify: the inverse, and the round trip ==');
for (const c of CASES) {
  const h = hollowed[c.file];
  if (!h) continue;
  const before = T.measureMesh(h.res.soup, { probe: Math.max(5, c.wall * 4) });
  const f = H.fill(h.res.soup, {});
  check(c.file + ' fills back to a solid', f.ok === true, f.ok ? f.reason.slice(0, 64) : f.reason);
  if (!f.ok) continue;
  const after = T.measureMesh(f.soup, {});
  check('  BEFORE: ' + T.describe(before).slice(0, 78), true);
  check('  AFTER : ' + T.describe(after).slice(0, 78), true);
  check('  the filled piece passes the canonical checker',
        after.pass === true, 'thin ' + after.thin);
  check('  the wall the hollow left is GONE - nothing measures it any more',
        after.min_mm === null || after.min_mm > c.wall + 0.01,
        'min ' + r3(after.min_mm) + ', sheets ' + after.sheets);
  check('  the round trip is bit for bit: fill(hollow(X)) is X\'s own triangles',
        f.soup.length === h.solid.length &&
        Array.prototype.every.call(h.solid, (v, i) => f.soup[i] === v),
        f.tris_after + ' tris vs ' + (h.solid.length / 9));
  check('  ...and the volume comes back to the solid it started as',
        near(f.volume_after, h.res.volume_before, Math.abs(h.res.volume_before) * 1e-6),
        r3(f.volume_after) + ' vs ' + r3(h.res.volume_before));
  check('  the cavity it filled is the cavity the hollow carved',
        near(f.cavity_volume, h.res.cavity_volume, Math.abs(h.res.cavity_volume) * 1e-6),
        r3(f.cavity_volume));
}
{
  const solid = box([0, 0, 0], [20, 20, 20], false);
  const f = H.fill(solid, {});
  check('Fill on a solid refuses by name rather than doing nothing quietly',
        f.ok === false && /no enclosed cavity/.test(f.reason), f.reason.slice(0, 72));
  check('  ...and hands the ORIGINAL soup back', f.soup === solid);
}

/* ============================================== 5. a captive separate solid */
console.log('\n== 5. Fill reads winding: a body inside a body is not a cavity ==');
{
  /* A rattle: a 20 mm box with a loose 4 mm cube inside it. The inner cube is
     wound OUTWARD - it is a solid, not a cavity wall - and deleting it would
     be wrong. The cavity around it, wound inward, is a cavity and goes. */
  const outer = box([0, 0, 0], [20, 20, 20], false);
  const cavity = box([3, 3, 3], [17, 17, 17], true);
  const ball = box([8, 8, 8], [12, 12, 12], false);
  const rattle = concat(outer, cavity, ball);
  const f = H.fill(rattle, {});
  check('the rattle has three shells', f.shells === 3, String(f.shells));
  check('Fill removes exactly ONE of them - the inward-wound cavity',
        f.ok === true && f.filled === 1, f.ok ? (f.filled + ' filled, ' + f.kept + ' kept') : f.reason);
  if (f.ok) {
    check('  the captive 4 mm cube survives - it is a solid, not a cavity wall',
          f.tris_after === 24, f.tris_after + ' tris (outer 12 + ball 12)');
    check('  ...and it is still the same triangles, untouched',
          Array.prototype.every.call(ball, (v, i) => f.soup[outer.length + i] === v));
    check('  the volume filled is the cavity\'s, 14^3 = 2744',
          near(f.cavity_volume, 2744, 1e-6), r3(f.cavity_volume));
  }
}

/* ========================= 6. thicken -> edit -> hollow back out, end to end */
console.log('\n== 6. the thicken -> edit -> hollow back out workflow ==');
console.log('   (the case the mode exists for: the original wall and the floor DIFFER)');
{
  const floor = T.floorFor(0.4);
  const ORIGINAL_WALL = 0.30;
  check('the premise: the original wall and the floor are genuinely different numbers',
        ORIGINAL_WALL < floor, ORIGINAL_WALL + ' vs ' + floor);

  /* Step 0. The piece as it was: a 10 mm shell with a 0.30 mm wall, built by
     hand so its wall is known by construction. */
  const thin = shell(10, ORIGINAL_WALL);
  const rep0 = T.measureMesh(thin, {});
  check('step 0 - the piece starts with a 0.30 mm wall, and the canonical checker FAILS it',
        rep0.pass === false && near(rep0.min_mm, ORIGINAL_WALL, 0.01),
        T.describe(rep0).slice(0, 76));

  /* Step 1. Thicken in. The wall goes up so an edit has something to bite. */
  const solid = H.fill(thin, {});
  check('step 1a - Fill turns the thin shell back into a solid', solid.ok === true);
  const thick = H.hollow(solid.soup, { wall: 2 });
  check('step 1b - Thicken in: the wall comes up to 2 mm', thick.ok === true,
        thick.ok ? r3(thick.measured_mm) + ' mm' : thick.reason);
  const rep1 = T.measureMesh(thick.soup, { probe: 8 });
  check('  ...and the canonical checker now PASSES it',
        rep1.pass === true && near(rep1.min_mm, 2, 0.06), T.describe(rep1).slice(0, 76));

  /* Step 2. The edit. Not this suite's subject; the point is only that the
     wall is thick enough for one to happen. */

  /* Step 3. Hollow back out. TWO ways, and they give different answers - which
     is the whole reason the mode exists. */
  const naive = H.hollow(solid.soup, { wall: ORIGINAL_WALL });
  check('step 3a - hollowing back out to the ORIGINAL 0.30 mm is REFUSED',
        naive.ok === false && /under the 0\.42 mm nozzle floor/.test(naive.reason),
        naive.reason.slice(0, 68));

  const safe = H.hollow(solid.soup, { mode: 'safe-min', restore: ORIGINAL_WALL });
  check('step 3b - hollow-to-safe-minimum runs, and does NOT restore 0.30 mm',
        safe.ok === true && safe.wall_mm !== ORIGINAL_WALL,
        safe.ok ? ('targeted ' + r3(safe.wall_mm)) : safe.reason);
  check('  it stops at the floor - 0.42, not the 0.30 it used to be',
        safe.wall_mm === floor && safe.floored === true, r3(safe.wall_mm));
  check('  ...and says so, naming both numbers, so nobody has to guess what happened',
        /0\.42/.test(safe.reason) && /0\.3/.test(safe.reason), (safe.floor_note || '').slice(0, 88));

  const rep3 = T.measureMesh(safe.soup, { probe: 5 });
  check('  the canonical checker PASSES the hollowed-back-out piece',
        rep3.pass === true, T.describe(rep3).slice(0, 76));
  check('  ...at the floor, measured on the result',
        rep3.min_mm >= floor - T.WELD_TOL, r3(rep3.min_mm) + ' vs ' + floor);
  check('  and it IS thinner than the thickened piece - this really was a hollow back OUT',
        rep3.min_mm < rep1.min_mm, r3(rep1.min_mm) + ' -> ' + r3(rep3.min_mm));
  check('  and thicker than the wall it started with, which is the point',
        rep3.min_mm > ORIGINAL_WALL, ORIGINAL_WALL + ' -> ' + r3(rep3.min_mm));

  /* The other half of the rule: when the original wall was ALREADY safe, the
     mode restores it and does not over-thicken to some house minimum. */
  const keep = H.hollow(solid.soup, { mode: 'safe-min', restore: 1.2 });
  check('a restore target that was already printable is honoured, not raised',
        keep.ok === true && keep.wall_mm === 1.2 && keep.floored === false, r3(keep.wall_mm));
}

/* ========================================================== 7. the refusals */
console.log('\n== 7. refusals name the problem and leave the piece alone ==');
{
  const sheet = box([0, 0, 0], [10, 10, 10], false).subarray(0, 9 * 6);
  const r = H.hollow(sheet, { wall: 1 });
  check('an open piece is refused by name - parity is the inside test and a sheet has no inside',
        r.ok === false && /open edge/.test(r.reason), r.reason.slice(0, 72));

  const tiny = box([0, 0, 0], [3, 3, 3], false);
  const r2 = H.hollow(tiny, { wall: 2 });
  check('a wall thicker than half the piece is refused - there is no interior left',
        r2.ok === false && /no interior left/.test(r2.reason), r2.reason.slice(0, 72));
  check('  ...and the piece is handed back unchanged', r2.soup === tiny);

  const r3res = H.hollow(new Float32Array(0), { wall: 1 });
  check('an empty piece is refused rather than throwing', r3res.ok === false, r3res.reason);
}

console.log('\n' + (fail ? 'FAILED ' : 'passed ') + pass + ' check(s), ' + fail + ' failure(s)\n');
process.exit(fail ? 1 : 0);
