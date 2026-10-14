#!/usr/bin/env node
/* Texture - a conformal skin over a cylinder's curved side, proven on real
   exported geometry through the canonical checker.

     node tools/nso_texture_test.js        exit 0 = every gate held

   Every mesh this suite judges is written to a binary STL first and read back
   through tools/nso_stl_io.js, and every closure verdict comes from
   tools/mesh_validate.py - the canonical checker - not from a helper in here.
   The measurements are taken off the file that was read back, so a number that
   only survives in float64 inside the builder cannot pass.

   Part 1  The audit (docs/HANDOFF.md "the OTHER wrap"). The three blockers are
           still real and are demonstrated rather than asserted: findFace
           groups a cylinder side per FACET, rectFrame refuses every one of
           those groups as a face, and the flat engine's single-normal lift
           is why nothing below it could survive a curve.
   Part 2  findBand: what it accepts, what it refuses, and that a cylinder
           tipped and moved anywhere is the same band.
   Part 3  The bake on fixtures/cylinder_r10h30_s64.stl: one closed shell,
           Euler 2, no self-intersection, the caps untouched, the axial extent
           untouched, the radial extent up by exactly 2 x depth.
   Part 4  CONFORMAL, measured: every tip in the exported file stands exactly
           `depth` off the ORIGINAL curved surface, all the way round. That is
           the number that separates a skin from a slab.
   Part 5  The wrap closes: the tip set is invariant under a rotation of one
           pitch, including across the seam, and the arc pitch is honoured.
   Part 6  Contact area on a curved face: the measured tip area equals the
           closed form to the last decimal, and the flat (unrolled) reading -
           what the existing engine's tipArea would have said - is 6% low.
   Part 7  Volume: the closed form with its curvature term, and a convergence
           run showing the residual is faceting and goes to zero.
   Part 8  Refusals return the input untouched.
   Part 9  Reachability, paint scope, and Seat kept out of scope.                */

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const Skin = require(path.join(ROOT, 'nso_skin.js'));
const Band = require(path.join(ROOT, 'nso_skin_band.js'));
const { readSTL, writeSTL } = require('./nso_stl_io.js');
const { cylinder } = require('./nso_texture_fixtures.js');

const fx = f => path.join(ROOT, 'fixtures', f);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-texture-'));

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (name, got, want, tol, unit) =>
  check(name, Math.abs(got - want) <= tol,
        'got ' + got.toFixed(6) + ', want ' + want.toFixed(6) + ' +-' + tol + (unit || 'mm') +
        ', off by ' + Math.abs(got - want).toExponential(2));

function meshValidate(file) {
  const out = execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'],
    { encoding: 'utf8', maxBuffer: 64 << 20 });
  return JSON.parse(out);
}
/* Write a soup out, read the FILE back, and judge the file. Nothing after
   this point looks at the in-memory soup. */
function exported(name, soup) {
  const file = path.join(tmp, name + '.stl');
  writeSTL(file, soup, 'nso texture ' + name);
  return { file: file, soup: readSTL(file), v: meshValidate(file) };
}
function closed(v) {
  return v.open_edges === 0 && v.nonmanifold_edges === 0 && v.odd_edges === 0 &&
         v.inconsistent_winding_edges === 0 && v.euler_characteristic === 2 &&
         v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0 &&
         v.degenerate_tris === 0;
}
function closedWhy(v) {
  return 'open ' + v.open_edges + ', nm ' + v.nonmanifold_edges + ', odd ' + v.odd_edges +
         ', winding ' + v.inconsistent_winding_edges + ', euler ' + v.euler_characteristic +
         ', pierce ' + v.self_intersection.pierce + ', coplanar ' + v.self_intersection.coplanar +
         ', degenerate ' + v.degenerate_tris + ', tris ' + v.triangles;
}
/* Shells by shared EDGES, welded at 1e-4 - the same test the skin suite uses. */
function edgeShells(soup) {
  const n = soup.length / 9;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const key = o => Math.round(soup[o] * 1e4) + '_' + Math.round(soup[o + 1] * 1e4) + '_' + Math.round(soup[o + 2] * 1e4);
  const owner = new Map();
  for (let t = 0; t < n; t++) {
    const k = [key(t * 9), key(t * 9 + 3), key(t * 9 + 6)];
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3];
      const ek = a < b ? a + '|' + b : b + '|' + a;
      if (owner.has(ek)) uni(owner.get(ek), t); else owner.set(ek, t);
    }
  }
  return new Set(Array.from({ length: n }, (_, i) => find(i))).size;
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const TAU = Math.PI * 2;

/* The ORIGINAL surface radius along the ray at angle theta: the inscribed
   polygon's chord, not the circle. Written out here rather than reached for
   inside the engine, so the conformality gate is measured against geometry
   the test derives for itself. */
function chordRadius(r, facets, phi) {
  const d = TAU / facets;
  let x = ((phi % d) + d) % d - d / 2;
  return r * Math.cos(d / 2) / Math.cos(x);
}

/* ==================================================================== 1 */
console.log('\n=== 1. the audit: what actually blocked a curved skin ===');
{
  const cyl = readSTL(fx('cylinder_r10h30_s64.stl'));

  /* Blocker 1: plane-exact grouping. findFace looks for planar groups; on a
     cylinder every one of them is a single facet, so "the side" is not a face
     that finder can name. */
  const face = Skin.findFace(cyl, [1, 0, 0]);
  check('findFace finds SOMETHING on a cylinder side', !!face);
  check('  ...but it is one FACET, not the surface: 2 triangles',
        !!face && face.tris.length === 2, face ? face.tris.length + ' triangles' : 'null');
  const sideArea = 2 * Math.PI * 10 * 30;
  check('  ...carrying ~1/64 of the side area',
        !!face && Math.abs(face.area - sideArea / 64) < sideArea / 64 * 0.01,
        face ? face.area.toFixed(3) + ' of ' + sideArea.toFixed(1) + ' mm2' : 'null');

  /* Blocker 2: the rectangle requirement. This is the sharp end of it, and
     it is worse than a refusal. A single facet IS a rectangle, so the flat
     engine does not refuse a cylinder for being curved - at the default
     pattern it refuses for being too NARROW, and at a fine enough pattern it
     happily succeeds and skins one stripe of sixty-four. Silent, plausible,
     and the wrong thing. */
  const flatDefault = Skin.applySkinToFace(cyl, { dir: [1, 0, 0], pattern: 'crosshatch' });
  check('the flat engine cannot skin a cylinder side at the default pattern',
        !flatDefault.ok, flatDefault.reason);
  check('  ...and returns the input soup untouched', flatDefault.tris === cyl);
  const flatFine = Skin.applySkinToFace(cyl, {
    dir: [1, 0, 0], pattern: 'crosshatch', params: { pitch: 0.2, rib: 0.08, height: 0.2, margin: 0.1 } });
  check('  ...and at a fine enough pattern it SUCCEEDS - on one facet',
        flatFine.ok, flatFine.ok ? 'contact ' + flatFine.tipArea.toFixed(2) + ' mm2' : flatFine.reason);
  check('  ...covering about 1/64 of the side, which is the bug, not a refusal',
        flatFine.ok && flatFine.tipArea < sideArea / 40,
        flatFine.ok ? flatFine.tipArea.toFixed(2) + ' of ' + sideArea.toFixed(1) + ' mm2' : 'n/a');
  const sph = Skin.applySkinToFace(readSTL(fx('fixture_sphere_curved.stl')), { dir: [0, 0, 1] });
  check('a sphere is still refused, by the rectangle rule', !sph.ok && /rectangle/.test(sph.reason || ''), sph.reason);

  /* Blocker 3: single-normal lifting. Demonstrated by what a skin built that
     way would measure: lifting the whole band along ONE normal puts the far
     side of the cylinder 2r + h from the axis instead of r + h. Part 4 gates
     the built article against exactly this. */
  check('the band engine exists to replace that lift', typeof Band.applyBandSkin === 'function');
}

/* ==================================================================== 2 */
console.log('\n=== 2. findBand: the developable-band finder ===');
{
  const cyl = readSTL(fx('cylinder_r10h30_s64.stl'));
  const b = Band.findBand(cyl);
  check('the cylinder fixture is a band', typeof b !== 'string', typeof b === 'string' ? b : 'found');
  if (typeof b !== 'string') {
    near('  radius', b.r, 10, 1e-4);
    near('  axial length', b.D, 30, 1e-4);
    check('  facet count', b.facets === 64, String(b.facets));
    near('  circumference', b.circumference, TAU * 10, 1e-4);
    check('  axis is Z', Math.abs(Math.abs(b.A[2]) - 1) < 1e-9, JSON.stringify(b.A.map(x => +x.toFixed(6))));
    check('  every side triangle is in the band', b.bandTris.length === 128, String(b.bandTris.length));
    check('  every cap triangle is in the caps', b.capTris.length === 128, String(b.capTris.length));
  }

  const b2 = Band.findBand(readSTL(fx('cylinder_r6h12_s96.stl')));
  check('the second cylinder is a band too', typeof b2 !== 'string', typeof b2 === 'string' ? b2 : 'r ' + b2.r.toFixed(3) + ', ' + b2.facets + ' facets');

  /* the same cylinder tipped and moved: a fit, not an axis-aligned guess */
  const rot = p => {
    const a = 30 * Math.PI / 180, c = 20 * Math.PI / 180;
    const y1 = p[1] * Math.cos(a) - p[2] * Math.sin(a), z1 = p[1] * Math.sin(a) + p[2] * Math.cos(a);
    return [p[0] * Math.cos(c) + z1 * Math.sin(c) + 13.7, y1 - 4.2, -p[0] * Math.sin(c) + z1 * Math.cos(c) + 9.1];
  };
  const tipped = cylinder(10, 30, 64);
  for (let i = 0; i < tipped.length; i += 3) {
    const q = rot([tipped[i], tipped[i + 1], tipped[i + 2]]);
    tipped[i] = q[0]; tipped[i + 1] = q[1]; tipped[i + 2] = q[2];
  }
  const bt = Band.findBand(tipped);
  check('a cylinder tipped 30/20 deg and moved is the same band', typeof bt !== 'string',
        typeof bt === 'string' ? bt : 'r ' + bt.r.toFixed(4) + ', D ' + bt.D.toFixed(4) + ', ' + bt.facets + ' facets');
  if (typeof bt !== 'string') {
    near('  radius, off axis', bt.r, 10, 2e-3);
    near('  axial length, off axis', bt.D, 30, 2e-3);
  }

  for (const [file, want] of [['prism_r10h30_s8.stl', /8-sided prism/],
                              ['box-20mm.stl', /prism/],
                              ['fixture_sphere_curved.stl', /not a cylinder about this axis/],
                              ['fixture_blob_organic.stl', /not a cylinder about this axis/]]) {
    const got = Band.findBand(readSTL(fx(file)));
    check(file + ' is refused, and named', typeof got === 'string' && want.test(got),
          typeof got === 'string' ? got : 'ACCEPTED');
  }
  const prism = Band.findBand(readSTL(fx('prism_r10h30_s8.stl')));
  check('  ...the prism refusal points at the engine that DOES cover it',
        typeof prism === 'string' && /Skin wrap/.test(prism));
}

/* ==================================================================== 3 */
console.log('\n=== 3. the bake on fixtures/cylinder_r10h30_s64.stl, through mesh_validate.py ===');
const R = 10, H = 30, SEG = 64, DEPTH = 0.6;
const base = readSTL(fx('cylinder_r10h30_s64.stl'));
const baseBand = Band.findBand(base);
const baseOut = exported('cylinder-base', base);
const res = Band.applyBandSkin(base, { pattern: 'crosshatch', params: { pitch: 1.2, height: DEPTH } });
check('the bake runs', res.ok, res.ok ? res.describe : res.reason);
const out = exported('cylinder-crosshatch', res.tris);
{
  console.log('   ' + closedWhy(out.v));
  check('one closed shell, no self-intersection', closed(out.v), closedWhy(out.v));
  check('exactly one edge-connected shell', edgeShells(out.soup) === 1, String(edgeShells(out.soup)));
  near('axial extent unchanged (the caps did not move)', out.v.bbox_size[2], H, 1e-5);
  near('radial extent up by exactly 2 x depth (x)', out.v.bbox_size[0], 2 * (R + DEPTH), 2e-5);
  near('radial extent up by exactly 2 x depth (y)', out.v.bbox_size[1], 2 * (R + DEPTH), 2e-5);
  near('the cap planes are where they were (min z)', out.v.bbox_min[2], baseOut.v.bbox_min[2], 1e-6);
  near('the cap planes are where they were (max z)', out.v.bbox_max[2], baseOut.v.bbox_max[2], 1e-6);

  /* The caps are re-fanned, not rebuilt: same plane, same boundary, same
     area. A cap that had been re-sampled onto a finer circle would grow. */
  const mBase = Band.measureBand(baseOut.soup, baseBand, R, 1e-3);
  const mSkin = Band.measureBand(out.soup, baseBand, res.tipRadius, 1e-3);
  near('cap area unchanged by the bake', mSkin.capArea, mBase.capArea, 1e-3, 'mm2');
  check('the caps gained triangles only where the relief met them',
        mSkin.capTris > mBase.capTris, mBase.capTris + ' -> ' + mSkin.capTris + ' triangles');
  check('the bake reports how many cap triangles it re-fanned',
        res.capTrisFanned > 0, String(res.capTrisFanned));
}

/* ==================================================================== 4 */
console.log('\n=== 4. conformal: every tip stands exactly `depth` off the ORIGINAL surface ===');
{
  const band = baseBand;
  let worst = 0, worstAt = null, tips = 0, minR = Infinity, maxR = -Infinity;
  const s = out.soup;
  for (let i = 0; i < s.length; i += 3) {
    const p = [s[i], s[i + 1], s[i + 2]];
    const rad = band.radiusOf(p);
    const w = dot(p, band.A);
    /* a cap's fan centre sits on the axis, so the floor is measured on the
       SIDE's vertices only */
    const onCap = Math.abs(w - band.wLo) < 1e-6 || Math.abs(w - band.wHi) < 1e-6;
    if (!onCap && rad < minR) minR = rad;
    if (rad > maxR) maxR = rad;
    if (rad < R + DEPTH / 2) continue;                       /* not a tip vertex */
    tips++;
    const phi = band.phiOf(p);
    const stand = rad - chordRadius(R, SEG, phi);
    const err = Math.abs(stand - DEPTH);
    if (err > worst) { worst = err; worstAt = { phi: phi, stand: stand }; }
  }
  check('there are tip vertices to measure', tips > 1000, String(tips) + ' of ' + (s.length / 3));
  check('every tip stands ' + DEPTH + ' mm off the real surface, all the way round',
        worst < 2e-5, 'worst error ' + worst.toExponential(2) + ' mm' +
        (worstAt ? ' at ' + (worstAt.phi * 180 / Math.PI).toFixed(1) + ' deg (stand ' + worstAt.stand.toFixed(6) + ')' : ''));

  /* The single-normal control. A relief lifted along ONE normal - what
     gridRelief does, and the third blocker in the audit - would put the far
     side of the band at 2R + depth from the axis. */
  near('nothing anywhere reaches further than R + depth from the axis', maxR, R + DEPTH, 2e-5);
  check('  ...where a single-normal lift would reach ' + (2 * R + DEPTH) + ' mm',
        maxR < R + DEPTH + 1e-4, 'max radius ' + maxR.toFixed(6));
  /* The floor between the ribs is the ORIGINAL inscribed prism, so the
     smallest radius anywhere on the side is the facet apothem - not R. It is
     sampled at the grid's node columns rather than exactly at each facet's
     midpoint, so it sits a hair above the apothem and never below it. */
  const apothem = R * Math.cos(Math.PI / SEG);
  check('the floor between the ribs is still the original prism',
        minR >= apothem - 1e-5 && minR <= apothem + 5e-4 && minR < R - 1e-4,
        'floor radius ' + minR.toFixed(6) + ', apothem ' + apothem.toFixed(6) + ', R ' + R);

  /* The relief crosses facet boundaries: it is one surface over the band, not
     a flat tile per facet. If it were tiled per facet, every tip vertex on a
     given tile would share that tile's plane, and the tip radii would take
     only as many distinct values as there are facets. */
  const facetAngle = TAU / SEG;
  let crossing = 0;
  for (let t = 0; t + 8 < s.length; t += 9) {
    const ph = [0, 1, 2].map(k => band.phiOf([s[t + k * 3], s[t + k * 3 + 1], s[t + k * 3 + 2]]));
    const rad = [0, 1, 2].map(k => band.radiusOf([s[t + k * 3], s[t + k * 3 + 1], s[t + k * 3 + 2]]));
    if (!rad.every(x => x > R + DEPTH / 2)) continue;
    const cell = ph.map(x => Math.floor(x / facetAngle + 1e-9));
    if (!(cell[0] === cell[1] && cell[1] === cell[2])) crossing++;
  }
  check('rib tops span facet boundaries (the pattern wraps, it does not tile)',
        crossing > 0, String(crossing) + ' tip triangles straddle a facet edge');
}

/* ==================================================================== 5 */
console.log('\n=== 5. the wrap closes: the rib boundaries are one pitch apart all the way round ===');
{
  const band = baseBand;
  const k = res.ribsAround;
  const step = TAU / k;
  const s = out.soup;

  /* A rib's SIDE is a wall at constant angle spanning base to tip. Those exist
     at the rib boundaries and nowhere else - a grid line merged in from the
     band's own facets has the same height either side of it, so no wall is
     emitted there. So this reads the pattern's own layout straight off the
     exported file, with nothing from the plan. */
  const wallPhi = new Set();
  for (let t = 0; t + 8 < s.length; t += 9) {
    const P = [0, 1, 2].map(j => [s[t + j * 3], s[t + j * 3 + 1], s[t + j * 3 + 2]]);
    const ph = P.map(p => band.phiOf(p));
    const rad = P.map(p => band.radiusOf(p));
    if (Math.max(...ph) - Math.min(...ph) > 1e-7) continue;      /* not at one angle */
    if (Math.max(...rad) - Math.min(...rad) < DEPTH / 2) continue; /* not base-to-tip */
    wallPhi.add(Math.round(ph[0] * 1e6) / 1e6);
  }
  const phis = Array.from(wallPhi).sort((a, b) => a - b);
  check('the file carries two rib walls per repeat', phis.length === 2 * k,
        phis.length + ' wall angles for ' + k + ' repeats');

  /* Every rib boundary has its partner exactly one pitch round, and the list
     closes on itself: phis[i + 2] - phis[i] is one pitch for every i, with the
     last two wrapping past the seam. A pattern with a seam would show a gap
     here that is not a pitch - which is the whole point. */
  let worstStep = 0, worstAt = -1;
  for (let i = 0; i < phis.length; i++) {
    const nxt = (i + 2 < phis.length) ? phis[i + 2] : phis[i + 2 - phis.length] + TAU;
    const err = Math.abs((nxt - phis[i]) - step);
    if (err > worstStep) { worstStep = err; worstAt = i; }
  }
  check('every rib boundary has its partner one pitch round, seam included',
        worstStep < 1e-6, 'worst ' + worstStep.toExponential(2) + ' rad at index ' + worstAt +
        ' of ' + phis.length);
  near('and the pitch, measured as ARC LENGTH on the exported file',
       R * step, res.pitch, 1e-3);

  near('the snapped arc pitch divides the circumference exactly', band.circumference / k, res.pitch, 1e-9);
  check('  ...and is within half a pitch of what was asked',
        Math.abs(res.pitch - res.pitchAsked) < res.pitch / 2,
        'asked ' + res.pitchAsked + ', snapped to ' + res.pitch.toFixed(6) + ' over ' + k + ' repeats');
  check('  ...and the snap is reported, not silent', res.pitchSnapped === true);
  /* A pattern laid out in ANGLE rather than arc length is the failure mode the
     audit names. It shows up as a repeat count taken from the wrong length:
     from the arc circumference it is 52, from the diameter - a planar reading
     of "how wide is this thing" - it would be 17. */
  check('the repeat count comes from the ARC, not from the diameter',
        k === Math.round(band.circumference / res.pitchAsked),
        'arc gives ' + k + ', a planar diameter reading would give ' + Math.round(2 * R / res.pitchAsked));
}

/* ==================================================================== 6 */
console.log('\n=== 6. contact area on a curved face ===');
{
  const m = Band.measureBand(out.soup, baseBand, res.tipRadius, 1e-3);
  console.log('   analytic ' + res.tipArea.toFixed(4) + '  faceted ' + res.tipAreaFaceted.toFixed(4) +
              '  unrolled ' + res.tipAreaUnrolled.toFixed(4) + '  MEASURED ' + m.tipArea.toFixed(4) + ' mm2');
  near('the exported file measures the closed form for a faceted band',
       m.tipArea, res.tipAreaFaceted, 1e-3, 'mm2');
  near('the analytic (smooth cylinder) value is that, to the faceting',
       res.tipArea, res.tipAreaFaceted, res.tipArea * 1e-3, 'mm2');
  const ratio = res.tipArea / res.tipAreaUnrolled;
  near('the curved contact is (R + depth) / R times the unrolled one',
       ratio, (R + DEPTH) / R, 1e-6, '');
  check('  ...so the flat reading under-reports by ' +
        (res.tipArea - res.tipAreaUnrolled).toFixed(1) + ' mm2 (' +
        (100 * (ratio - 1)).toFixed(1) + '%)',
        res.tipArea - res.tipAreaUnrolled > 50);
  check('the tips are the only thing a mating part would touch',
        m.tipArea < m.baseArea + m.wallArea,
        'tips ' + m.tipArea.toFixed(1) + ', floor ' + m.baseArea.toFixed(1) + ', walls ' + m.wallArea.toFixed(1) + ' mm2');
}

/* ==================================================================== 7 */
console.log('\n=== 7. volume: the closed form and its curvature term ===');
{
  const added = out.v.signed_volume - baseOut.v.signed_volume;
  const errCurved = Math.abs(added - res.volumeExpected) / res.volumeExpected;
  const errFlat = Math.abs(added - res.volumeExpectedFlat) / res.volumeExpectedFlat;
  console.log('   added ' + added.toFixed(4) + '  curved form ' + res.volumeExpected.toFixed(4) +
              '  flat form ' + res.volumeExpectedFlat.toFixed(4));
  check('the exported file grew by the curved closed form (0.15%)', errCurved < 1.5e-3,
        (100 * errCurved).toFixed(4) + '%');
  check('  ...and NOT by the flat one, which is ' + (100 * errFlat).toFixed(2) + '% out',
        errFlat > 20 * errCurved, 'flat ' + (100 * errFlat).toFixed(4) + '% vs curved ' + (100 * errCurved).toFixed(4) + '%');

  /* The residual is faceting, and the way to prove that is to make the facets
     smaller. A builder that had the maths wrong would not converge. */
  console.log('   convergence (the residual is the inscribed prism, and it goes away):');
  for (const pattern of ['crosshatch', 'zigzag']) {
    const errs = [];
    for (const seg of [48, 96, 192, 384]) {
      const c = cylinder(R, H, seg);
      const r = Band.applyBandSkin(c, { pattern: pattern, params: { height: DEPTH } });
      if (!r.ok) { errs.push(NaN); continue; }
      errs.push(100 * Math.abs(r.volumeAdded - r.volumeExpected) / r.volumeExpected);
    }
    console.log('     ' + pattern.padEnd(11) + errs.map(e => e.toFixed(4) + '%').join('  '));
    let monotone = true;
    for (let i = 1; i < errs.length; i++) if (!(errs[i] < errs[i - 1])) monotone = false;
    check(pattern + ': the residual falls with every refinement', monotone, errs.map(e => e.toFixed(4)).join(' > '));
    /* 0.2%: the crosshatch is at 0.004% by 384 facets and the zigzag at 0.13%.
       The zigzag converges more slowly because its flanks are ramps sampled on
       the facet grid, where the crosshatch's tops are flat - so it is held to
       the looser of the two numbers, said out loud, rather than to a gate that
       only the easy pattern can meet. */
    check('  ...and is under 0.2% by 384 facets', errs[errs.length - 1] < 0.2, errs[errs.length - 1].toFixed(4) + '%');
  }
}

/* ==================================================================== 8 */
console.log('\n=== 8. the second pattern, the second cylinder, and the refusals ===');
{
  const zig = Band.applyBandSkin(base, { pattern: 'zigzag', params: { pitch: 2.0, height: DEPTH } });
  check('zigzag bakes', zig.ok, zig.ok ? zig.describe : zig.reason);
  const zo = exported('cylinder-zigzag', zig.tris);
  check('zigzag is one closed shell, no self-intersection', closed(zo.v), closedWhy(zo.v));
  check('  ...one edge-connected shell', edgeShells(zo.soup) === 1, String(edgeShells(zo.soup)));
  const zm = Band.measureBand(zo.soup, baseBand, zig.tipRadius, 1e-3);
  near('  ...and its crests measure the closed form', zm.tipArea, zig.tipAreaFaceted, 1e-3, 'mm2');

  const small = readSTL(fx('cylinder_r6h12_s96.stl'));
  const sb = Band.findBand(small);
  const sr = Band.applyBandSkin(small, { pattern: 'crosshatch', params: { pitch: 1.2, height: 0.4 } });
  check('the r 6 x 12 cylinder bakes', sr.ok, sr.ok ? sr.describe : sr.reason);
  const so = exported('cylinder-small', sr.tris);
  check('  ...one closed shell, no self-intersection', closed(so.v), closedWhy(so.v));
  near('  ...radial extent up by 2 x depth', so.v.bbox_size[0], 2 * (6 + 0.4), 2e-5);
  near('  ...axial extent unchanged', so.v.bbox_size[2], 12, 1e-5);
  const sm = Band.measureBand(so.soup, sb, sr.tipRadius, 1e-3);
  near('  ...contact measures the closed form', sm.tipArea, sr.tipAreaFaceted, 1e-3, 'mm2');

  for (const [what, opts, want] of [
    ['ring', { pattern: 'ring' }, /no height field/],
    ['recess', { mode: 'recess' }, /raise-only/],
    ['an unknown pattern', { pattern: 'waffle' }, /unknown pattern/],
    ['a margin bigger than the band', { margin: 20 }, /leaves nothing/],
    ['a relief taller than the radius', { params: { height: 12 } }, /is not a skin/]
  ]) {
    const r = Band.applyBandSkin(base, opts);
    check(what + ' is refused', !r.ok && want.test(r.reason || ''), r.reason);
    check('  ...with the input soup untouched', r.tris === base);
  }
  const notCyl = Band.applyBandSkin(readSTL(fx('box-20mm.stl')), {});
  check('a box is refused by the bake too', !notCyl.ok && /prism/.test(notCyl.reason || ''), notCyl.reason);
}

/* ==================================================================== 9 */
console.log('\n=== 9. reachability, paint scope, and what is NOT in scope ===');
{
  const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const html = read('index.html');
  check('index.html carries #btn-texture', /id="btn-texture"/.test(html));
  check('  ...labelled exactly "Texture"', />Texture<\/button>/.test(html));
  check('  ...with its pattern select and both numbers',
        /id="sel-texture-pattern"/.test(html) && /id="inp-texture-pitch"/.test(html) && /id="inp-texture-depth"/.test(html));
  // Shell v2: the Surface menu, which was Finish's Surface section.
  const surfaceAt = html.indexOf('id="menu-surface"');
  const surface = surfaceAt < 0 ? '' : html.slice(surfaceAt, html.indexOf('</details>', surfaceAt));
  check('  ...in the Surface card, with the other skin rows',
        /id="btn-texture"/.test(surface) && /id="btn-skin-face"/.test(surface));
  check('  ...and the engine and the wiring are both loaded',
        /nso_skin_band\.js\?v=/.test(html) && /app-texture\.js\?v=/.test(html));

  /* The label has to stay distinct from Soften's checkbox: they are different
     features and the ticket asked for them not to be confused. */
  check('Soften still has its own "Full wrap" checkbox, untouched',
        /id="chk-full-wrap"/.test(html) && /Full wrap<\/label>/.test(html));
  check('  ...and Texture is not called a wrap anywhere in the UI',
        !/>\s*Texture wrap\s*</.test(html));

  const src = read('app-texture.js');
  check('app-texture.js declares PAINT SCOPE: SUB-REGION', /PAINT SCOPE:\s*SUB-REGION/.test(src));
  check('  ...pointing at the rule in HANDOFF', /PAINT SCOPE:[\s\S]{0,700}?docs\/HANDOFF\.md/.test(src));
  check('  ...and reads mask6 per facet rather than re-deriving a face',
        /nsoMaskIsExcludedRaw\s*\(\s*m\s*,\s*face\.n\s*,\s*face\.d/.test(src));
  check('  ...and carries its stand-down wording',
        /Texture stood down - ' \+ \w+ \+ ' painted facet\(s\)/.test(src));

  /* the paint check itself, headless: the module reads mask6's answer and
     counts the band's own facets, and nothing else on the piece. */
  const app = require(path.join(ROOT, 'app-texture.js'));
  const facets = app.NSO_textureFacetPlanes(base, baseBand);
  check('the band offers one plane per facet to the paint system',
        facets.length === SEG, facets.length + ' planes for ' + SEG + ' facets');
  let asked = [];
  global.nsoMaskIsExcludedRaw = function (m, n, d) { asked.push([n, d]); return false; };
  check('an unpainted cylinder is not stood down', app.NSO_textureBandPainted({}, base, baseBand) === 0);
  check('  ...having asked mask6 about every facet, and nothing else', asked.length === SEG, String(asked.length));
  const painted = facets[7];
  global.nsoMaskIsExcludedRaw = (m, n, d) =>
    Math.abs(d - painted.d) < 1e-6 && Math.abs(n[0] - painted.n[0]) < 1e-6 && Math.abs(n[1] - painted.n[1]) < 1e-6;
  check('one painted facet is seen', app.NSO_textureBandPainted({}, base, baseBand) === 1);
  /* a painted CAP is not the band's business: the cap planes are +Z / -Z and
     no band facet lies on them, so the same predicate never fires here */
  global.nsoMaskIsExcludedRaw = (m, n, d) => Math.abs(Math.abs(n[2]) - 1) < 1e-6;
  check('a painted CAP does not stand the bake down', app.NSO_textureBandPainted({}, base, baseBand) === 0);
  delete global.nsoMaskIsExcludedRaw;

  /* Seat against a curved contact is a separate ticket. Nothing here may
     quietly start answering it. */
  const engine = read('nso_skin_band.js');
  /* the word appears in both files' prose, saying Seat is somebody else's
     ticket. What must not appear is a CALL. */
  const callsSeat = t => /(supportExtreme|seatFlushBitToHull|NSO_seatFlushBitToHull|tipContactArea)\s*\(/.test(t);
  check('the band engine never calls into Seat', !callsSeat(engine));
  check('the button never calls into Seat', !callsSeat(src));
  check('  ...and both say so in words',
        /OUT OF SCOPE/.test(engine) && /Seat against a curved contact is a separate ticket/.test(src));
  check('docs/CURVED-SKIN.md exists and says the same',
        /Seat/.test(read('docs/CURVED-SKIN.md')) && /out of scope/i.test(read('docs/CURVED-SKIN.md')));
}

console.log('\n' + (fails ? fails + ' gate(s) FAILED' : 'every gate held'));
process.exit(fails ? 1 : 0);
