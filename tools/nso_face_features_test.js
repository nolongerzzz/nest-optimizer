#!/usr/bin/env node
/* nso_face_features.js - the handle, bracket, lid and hinge rules, held to
 * the ground truth tools/nso_features.js declares for each (docs/FEATURES.md,
 * fixtures/features/features.json), the bar nso_flange.js was held to:
 *
 *   1. TRUTH     on the whole piece (feature-hull_all.stl), each rule finds
 *                exactly its one feature, in its cell, and measures it: every
 *                number the generator declared (the handle's rod, clearance
 *                and opening; the bracket's plate, arm and gussets; the lid's
 *                seat, clearance, plug and void; the hinge's pin, bore,
 *                knuckle and axial gaps), its root area, its volume and its
 *                bounds.
 *   2. SOLID     what each rule lifts out is a clean solid (the canonical
 *                checker, tools/mesh_validate.py), and it is the same solid
 *                as the reference detach() cuts out of the same piece by the
 *                manifest's cells alone - same volume, area and chi, sharing
 *                no code with the rule.
 *   3. NOTHING   zero false positives: every candidate in any other feature's
 *   ELSE         cell fails, and says which clause; the hull alone has nothing
 *                standing on it; each feature alone lights its own rule and
 *                no other; the unbraced angle fails the bracket on "braced"
 *                alone (the flange rule's, pinned in nso_features_test.js).
 *   4. POSE      the whole piece turned 90 degrees, upside down, and turned
 *                off every axis: the same four, the same numbers.
 *   5. MEASURED  other parameters, built fresh: the numbers follow them, so
 *                nothing is fitted to the defaults.
 *   6. LIBRARY   every other STL in library/ and fixtures/: none of the four.
 *
 * Run: node tools/nso_face_features_test.js */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const FX = require('./nso_features.js');
const FF = require('../nso_face_features.js');
const { readSTL, writeSTL } = require('./nso_stl_io.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'fixtures', 'features');
const MV = path.join(__dirname, 'mesh_validate.py');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-face-features-test-'));

let pass = 0, fail = 0;
const FAILS = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok    ' + name + (detail ? '   (' + detail + ')' : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   (' + detail + ')' : '')); }
}
const f3 = x => Number(x).toFixed(3);
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const vnear = (a, b, tol) => a && b && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);
const inBox = (p, b) => [0, 1, 2].every(i => p[i] >= b.lo[i] - 1e-9 && p[i] <= b.hi[i] + 1e-9);
const boxNear = (a, b, tol) => vnear(a.lo, b.lo, tol) && vnear(a.hi, b.hi, tol);
const fb = b => b.lo.map(f3).join(',') + ' .. ' + b.hi.map(f3).join(',');

let nTmp = 0;
function measure(soup) {
  const f = path.join(TMP, 'm' + (nTmp++) + '.stl');
  writeSTL(f, soup, 'nso_face_features_test');
  const r = JSON.parse(execFileSync('python3', [MV, f, '--json', '--no-selfint'], { maxBuffer: 1 << 28 }).toString());
  fs.unlinkSync(f);
  return r;
}
function boxSoup(lo, hi) {
  const c = k => [k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]];
  const Q = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const o = [];
  for (const [a, b, cc, d] of Q) o.push(...c(a), ...c(b), ...c(cc), ...c(a), ...c(cc), ...c(d));
  return Float32Array.from(o);
}
function turn(s, R) {
  const o = new Float32Array(s.length);
  for (let i = 0; i < s.length; i += 3) {
    const x = s[i], y = s[i + 1], z = s[i + 2];
    o[i] = R[0] * x + R[1] * y + R[2] * z; o[i + 1] = R[3] * x + R[4] * y + R[5] * z; o[i + 2] = R[6] * x + R[7] * y + R[8] * z;
  }
  return o;
}
function mul(A, B) {
  const C = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { let t = 0; for (let k = 0; k < 3; k++) t += A[i * 3 + k] * B[k * 3 + j]; C.push(t); }
  return C;
}
function walk(d) {
  let o = [];
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f), st = fs.statSync(p);
    if (st.isDirectory()) o = o.concat(walk(p));
    else if (/\.stl$/i.test(f)) o.push(p);
  }
  return o;
}
const sameAxis = (a, b) => vnear(a, b, 1e-9) || vnear(a, b.map(x => -x), 1e-9);

/** Each rule's numbers against its feature's declared truth. */
function truthChecks(rule, f, rec, label) {
  const m = f.measured, T = rec.truth, p = rec.params;
  if (rule === 'handle') {
    check(label + 'rod radius = the generator\'s r, off both feet', near(m.rodRadius, T.rod_radius, 1e-6) && m.footRadii.every(r => near(r, T.rod_radius, 1e-6)), f3(m.rodRadius) + ' vs ' + T.rod_radius);
    check(label + 'feet round: equidistant, and filling their circle as a ' + p.sides + '-gon does', m.roundness < 1e-6 &&
      near(m.fill, p.sides * Math.sin(2 * Math.PI / p.sides) / (2 * Math.PI), 1e-6), 'fill ' + f3(m.fill));
    check(label + 'span between the feet', near(m.span, T.span, 1e-6), f3(m.span) + ' vs ' + T.span);
    check(label + 'the opening between the legs', near(m.openingWidth, T.opening_width, 1e-6), f3(m.openingWidth) + ' vs ' + T.opening_width);
    check(label + 'clear: straight out from between the feet, air for exactly `clear`', near(m.clear, T.clear, 1e-3), f3(m.clear) + ' vs ' + T.clear);
    check(label + '...then the grip: the same rod, 2r across', near(m.grip, 2 * T.rod_radius, 1e-3), f3(m.grip));
    check(label + 'the opening\'s centre and the loop\'s plane', vnear(m.openingCentre, T.opening_centre, 1e-3) &&
      sameAxis(m.loopNormal, T.loop_plane_normal), m.openingCentre.map(f3).join(',') + ' / ' + m.loopNormal.join(','));
  } else if (rule === 'bracket') {
    check(label + 'plate thickness', near(m.thickness, T.thickness, 1e-3), f3(m.thickness) + ' vs ' + T.thickness);
    check(label + 'the arm: projects, its own thickness, its plate normal', near(m.arm.projects, T.arm.projects, 1e-3) &&
      near(m.arm.thickness, T.thickness, 1e-6) && sameAxis(m.arm.normal, T.arm.normal),
      f3(m.arm.projects) + ' out, ' + f3(m.arm.thickness) + ' thick, normal ' + m.arm.normal.join(','));
    check(label + 'the arm runs the plate\'s width', near(m.arm.length, p.width, 2 * m.sample), f3(m.arm.length) + ' vs ' + p.width);
    const g = m.gussets.filter(x => x.r2 >= 0.95 && x.slope < -0.2);
    check(label + T.gussets.length + ' gussets, each a straight 45-degree taper', g.length === T.gussets.length &&
      g.every(x => near(x.angle, 45, 1e-6) && x.r2 > 1 - 1e-9), g.map(x => f3(x.angle) + ' deg, r2 ' + x.r2.toFixed(9)).join('; '));
    check(label + '...their legs', g.every(x => near(x.legOut, T.gussets[0].leg, 1e-6) && near(x.legAlong, T.gussets[0].leg, 1e-6)),
      g.map(x => f3(x.legOut) + ' / ' + f3(x.legAlong)).join('; ') + ' vs ' + T.gussets[0].leg);
    check(label + '...each inside its declared gusset', g.every(x => T.gussets.some(tg => inBox(x.centre, tg.bounds))) &&
      T.gussets.every(tg => g.some(x => inBox(x.centre, tg.bounds))), g.map(x => x.centre.map(f3).join(',')).join('; '));
  } else if (rule === 'lid') {
    check(label + 'clearance round the plug', near(m.clear, T.clear, 1e-6), f3(m.clear) + ' vs ' + T.clear);
    check(label + 'the seat: rim width and ring area', near(m.rim, p.rim, 1e-6) && near(m.seatArea, rec.roots.area, 1e-6),
      f3(m.rim) + ' mm, ' + f3(m.seatArea) + ' mm2 vs ' + p.rim + ', ' + rec.roots.area);
    check(label + 'plug depth, and the gap under it to the floor', near(m.plugDepth, T.plug_depth, 1e-6) &&
      near(m.floorGap, T.pocket.hi[2] - T.pocket.lo[2] - T.plug_depth, 1e-6), f3(m.plugDepth) + ', ' + f3(m.floorGap));
    check(label + 'the void it closes', rel(m.voidVolume, T.void_volume) < 1e-7 && m.voidChi === 2, f3(m.voidVolume) + ' vs ' + T.void_volume);
    check(label + 'the plate over the seat', near(m.plate, p.t, 1e-6), f3(m.plate) + ' vs ' + p.t);
  } else if (rule === 'hinge') {
    check(label + 'pin radius', near(m.pinRadius, T.pin_radius, 1e-5), f3(m.pinRadius) + ' vs ' + T.pin_radius);
    check(label + 'bore: pin + clear', near(m.boreRadius, T.pin_radius + T.clear, 1e-5), f3(m.boreRadius));
    check(label + 'radial clearance, and the least gap at the flats (cos pi/n of it)', near(m.clear, T.clear, 1e-5) &&
      m.leastGap >= T.clear * Math.cos(Math.PI / p.sides) - 1e-6 && m.leastGap <= T.clear + 1e-9, f3(m.clear) + ', least ' + f3(m.leastGap));
    check(label + 'knuckle radius', near(m.knuckleRadius, T.knuckle_radius, 1e-6), f3(m.knuckleRadius));
    check(label + 'axial gap to the fixed knuckle, both sides', m.axialGaps.every(g => near(g, T.gap, 1e-6)), m.axialGaps.map(f3).join(', '));
    check(label + 'the axis: its direction and where it runs', sameAxis(m.axis, T.axis_dir) &&
      [0, 1, 2].every(i => Math.abs(T.axis_dir[i]) > 0.5 || near(m.axisPoint[i], T.axis_point[i], 1e-3)),
      m.axis.join(',') + ' through ' + m.axisPoint.map(f3).join(','));
    check(label + 'the second body: bored (genus 1)', m.bodyChi === 0, 'chi ' + m.bodyChi);
  }
}

(async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, 'features.json'), 'utf8'));
  const entry = f => manifest.entries.find(e => e.stl === f);
  const file = f => readSTL(path.join(OUT, f));
  const ALL = entry('feature-hull_all.stl');
  const ALLS = file(ALL.stl);
  const feat = (e, t) => e.features.find(x => x.type === t);

  /* ================================================================ 1 + 2 */
  console.log('\n== 1. the whole piece: each rule finds its one feature, as it was made ==');
  const r = FF.detect(ALLS);
  console.log('       ' + r.faces + ' flat faces, ' + r.protrusions + ' things standing on them, ' + r.ms + ' ms');
  for (const rule of FF.RULES) {
    const rec = feat(ALL, rule), want = ALL.detectors[rule].count;
    const found = r[rule].found;
    check(rule + ': exactly ' + want + ' (the manifest says so)', found.length === want && want === 1, FF.describe(r, rule));
    const f = found[0];
    if (!f) continue;
    check('  in its cell', rec.cells.some(b => inBox(f.centroid, b)), f.centroid.map(f3).join(','));
    check('  its root area', rel(f.rootArea, rec.roots.area) < 1e-6, f3(f.rootArea) + ' vs ' + f3(rec.roots.area));
    truthChecks(rule, f, rec, '  ');
    check('  lifted out: its volume', rel(f.volume, rec.volume) < 1e-6, f3(f.volume) + ' vs ' + f3(rec.volume));
    check('  ...and exactly its bounds', boxNear(f.extent, rec.truth.bounds, 1e-4), fb(f.extent));
    const mv = measure(f.positions);
    const bodies = 1 + ((rec.topology.bodies || []).length);
    const chi = 2 + (rec.topology.bodies || []).reduce((s, g) => s + 2 - 2 * g, 0);
    check('  ...a clean solid: PASS, closed, chi ' + chi + ' (' + bodies + ' bod' + (bodies === 1 ? 'y' : 'ies') + ')',
      mv.verdict === 'PASS' && mv.open_edges === 0 && mv.nonmanifold_edges === 0 && mv.inconsistent_winding_edges === 0 &&
      mv.euler_characteristic === chi, mv.verdict + ', chi ' + mv.euler_characteristic);
    // The reference: detach() by the manifest's cells alone.
    const ref = await FX.detach(ALLS, rec);
    const mr = measure(ref.feature);
    check('  ...the same solid the reference detach() cuts out: volume, area, chi',
      rel(mv.signed_volume, mr.signed_volume) < 1e-7 && rel(mv.surface_area, mr.surface_area) < 1e-7 &&
      mv.euler_characteristic === mr.euler_characteristic && mv.triangles === mr.triangles,
      f3(mv.signed_volume) + ' / ' + f3(mv.surface_area) + ' / ' + mv.triangles + ' tri vs ' +
      f3(mr.signed_volume) + ' / ' + f3(mr.surface_area) + ' / ' + mr.triangles + ' tri');
  }

  /* ================================================================ 3 */
  console.log('\n== 3. nothing else: every other candidate fails, and says why ==');
  for (const rule of FF.RULES) {
    for (const other of ALL.features.filter(x => x.type !== rule)) {
      const cs = r[rule].candidates.filter(c => other.cells.some(b => inBox(c.centroid, b)));
      const tally = {};
      cs.forEach(c => c.failed.forEach(k => { tally[k] = (tally[k] || 0) + 1; }));
      const worded = cs.every(c => c.failed.every(k => FF.WHY[rule][k]));
      check(rule + ' on the ' + other.type + ': ' + cs.length + ' candidate(s), none passes, each in words',
        cs.every(c => c.failed.length > 0) && worded, Object.keys(tally).map(k => k + ' ' + tally[k]).join(', ') || 'nothing standing there');
    }
    const onHull = r[rule].candidates.filter(c => !ALL.features.some(x => x.cells.concat(x.recess_cells).some(b => inBox(c.centroid, b))));
    check(rule + ' on the hull itself: ' + onHull.length + ' candidate(s), none passes', onHull.every(c => c.failed.length > 0));
  }
  const hull = FF.detect(boxSoup([-60, -35, 0], [60, 35, 40]));
  check('the hull alone: nothing stands on it, and every row says so',
    hull.protrusions === 0 && FF.RULES.every(k => !hull[k].found.length && /nothing stands on a flat face/.test(hull[k].reason)),
    FF.RULES.map(k => FF.describe(hull, k)).join(' | '));
  for (const e of manifest.entries.filter(x => x.features.length === 1)) {
    const rr = FF.detect(file(e.stl));
    const got = FF.RULES.map(k => k + ' ' + rr[k].found.length).join(', ');
    check(e.stl + ': ' + FF.RULES.map(k => k + ' ' + e.detectors[k].count).join(', '),
      FF.RULES.every(k => rr[k].found.length === e.detectors[k].count), got);
    for (const k of FF.RULES.filter(k => !e.detectors[k].count)) {
      if (!/ (none detected|nothing stands)/.test(FF.describe(rr, k)) && !rr[k].reason) check(e.stl + ': ' + k + ' has a reason', false);
    }
  }
  const nearest = (stl, rule) => FF.detect(file(stl))[rule].candidates[0];
  const ang = nearest('feature-hull_angle-unbraced.stl', 'bracket');
  check('the unbraced angle: plate and arm pass, it fails exactly "braced" (a flange, by nso_flange.js)',
    ang && ang.failed.join() === 'braced' && near(ang.measured.arm.projects, 20, 1e-3), ang && ang.failed.join('+'));
  const hOnHinge = nearest('feature-hull_hinge.stl', 'handle');
  check('the hinge read as a handle: two feet, but not round ones', hOnHinge && hOnHinge.failed[0] === 'round', hOnHinge && hOnHinge.failed.join('+'));
  const gOnHandle = nearest('feature-hull_handle.stl', 'hinge');
  check('the handle read as a hinge: two feet, but no second body', gOnHandle && gOnHandle.failed.join() === 'body', gOnHandle && gOnHandle.failed.join('+'));
  const bOnLid = nearest('feature-hull_lid.stl', 'bracket');
  check('the lid read as a bracket: a plate, but no arm', bOnLid && bOnLid.failed.join() === 'arm', bOnLid && bOnLid.failed.join('+'));
  const lOnBracket = nearest('feature-hull_bracket.stl', 'lid');
  check('the bracket read as a lid: nothing enclosed under it', lOnBracket && lOnBracket.failed.join() === 'void', lOnBracket && lOnBracket.failed.join('+'));

  /* ================================================================ 4 */
  console.log('\n== 4. pose: the same four, the same numbers ==');
  const a = 30 * Math.PI / 180, b = 20 * Math.PI / 180;
  const Rz = [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];
  const Rx = [1, 0, 0, 0, Math.cos(b), -Math.sin(b), 0, Math.sin(b), Math.cos(b)];
  for (const [name, R] of [['turned 90 about Z', [0, -1, 0, 1, 0, 0, 0, 0, 1]], ['upside down', [1, 0, 0, 0, -1, 0, 0, 0, -1]],
                           ['turned 30 about Z, then 20 about X', mul(Rx, Rz)]]) {
    const rr = FF.detect(turn(ALLS, R));
    check('the whole piece ' + name + ': one of each, same volume and numbers',
      FF.RULES.every(k => rr[k].found.length === 1 && rel(rr[k].found[0].volume, feat(ALL, k).volume) < 1e-5 &&
        FF.summary(k, rr[k].found[0]) === FF.summary(k, r[k].found[0])),
      FF.RULES.map(k => FF.describe(rr, k)).join(' | '));
  }

  /* ================================================================ 5 */
  console.log('\n== 5. other parameters, built fresh: the numbers follow them ==');
  const variants = [
    ['handle', { r: 3, R: 20, sides: 16, arc: 16 }],
    ['bracket', { t: 2, width: 30, height: 24, arm: 14, gusset: 9 }],
    ['lid', { clear: 0.3, rim: 4, plug: 4, t: 2 }],
    ['hinge', { R: 6, rp: 3, clear: 0.3, gap: 0.4, sides: 24 }]
  ];
  for (const [rule, params] of variants) {
    const p = await FX.build({ features: [{ type: rule, params }] });
    const rec = p.features[0];
    const rr = FF.detect(p.soup);
    const others = FF.RULES.filter(k => k !== rule && rr[k].found.length);
    check(rule + ' ' + JSON.stringify(params) + ': found, alone', rr[rule].found.length === 1 && !others.length, FF.describe(rr, rule));
    const f = rr[rule].found[0];
    if (!f) continue;
    truthChecks(rule, f, rec, '  ');
    check('  volume, root area and bounds', rel(f.volume, rec.volume) < 1e-6 && rel(f.rootArea, rec.roots.area) < 1e-6 &&
      boxNear(f.extent, rec.truth.bounds, 1e-4), f3(f.volume) + ' vs ' + f3(rec.volume));
  }

  /* ================================================================ 6 */
  console.log('\n== 6. everything else in the repo: none of the four ==');
  const files = walk(path.join(ROOT, 'library')).concat(walk(path.join(ROOT, 'fixtures')))
    .filter(f => !f.startsWith(OUT + path.sep));
  let nProt = 0, nFiles = 0, slow = 0;
  const lit = [];
  for (const f of files) {
    let s;
    try { s = readSTL(f); } catch (e) { continue; }
    nFiles++;
    const rr = FF.detect(s);
    nProt += rr.protrusions;
    slow = Math.max(slow, rr.ms);
    FF.RULES.forEach(k => { if (rr[k].found.length) lit.push(path.relative(ROOT, f) + ': ' + k); });
  }
  check(nFiles + ' STLs, ' + nProt + ' things standing on a face: no handle, bracket, lid or hinge on any', lit.length === 0 && nFiles > 90,
    lit.join('; ') || 'slowest ' + slow + ' ms');

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('FAILED:\n  ' + FAILS.join('\n  ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
