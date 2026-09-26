#!/usr/bin/env node
/* tools/nso_features.js has to be as trustworthy as the detectors it is used
 * to test. This holds it to the canonical checker, tools/mesh_validate.py, to
 * measurements that share no code with it, and to the one feature detector
 * that exists, nso_flange.js:
 *
 *   1. REFUSES   parameters that are not the feature they name are refused,
 *                with the clause of the definition they break - and two
 *                features that would touch are refused as not independent.
 *   2. EXACT     every committed piece: the checker reports exactly the
 *                census the definitions add up to, and the volume and area.
 *   3. ROOTS     each feature detached from the whole piece by its cell alone
 *                (the soup and features.json, nothing else) is exactly the
 *                feature; the contact it leaves is exactly the root area it
 *                declares; reattached, the piece is the piece again.
 *   4. FLANGE    nso_flange.js finds the one flange on the whole piece, where
 *                and as it was made, and lifts it out; nothing on the handle,
 *                bracket, lid or hinge passes. Alone on the hull, each other
 *                feature reads none. The bracket without its gussets reads as
 *                a flange - the rule's own verdict, pinned.
 *   5. HANDLE    a loop: genus 1 by the checker; a finger passes through the
 *                opening and is trapped in it; the clearance, by ray.
 *   6. BRACKET   an L of one thickness with tapering gussets, by ray.
 *   7. LID       lifts straight off its seat, locates by its plug, and seated
 *                it encloses exactly the void it declares.
 *   8. HINGE     two bodies; the leaf swings +-90 degrees free and is stopped
 *                by the face at 135; captive on its pin, axially and radially.
 *   9. FIXTURES  fixtures/features/ reads as its manifest says, the same call
 *                is the same bytes, and the Library rows are those files.
 *
 * Run: node tools/nso_features_test.js */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const FX = require('./nso_features.js');
const G = require('./nso_features_make_fixtures.js');
const D = require('./nso_damage.js');
const Fl = require('../nso_flange.js');
const { readSTL, writeSTL } = require('./nso_stl_io.js');
const LIBDIR = require('./nso_library_dir.js');

const ROOT = path.resolve(__dirname, '..');
const MV = path.join(__dirname, 'mesh_validate.py');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-features-test-'));

// app-cut.js's rawCut, loaded the way tools/nso_flange_test.js loads it.
const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Float32Array,
  Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer, Error, Infinity, NaN };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-cut.js'), 'utf8'), ctx, { filename: 'app-cut.js' });
const rawCut = ctx.rawCut;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok    ' + name + (detail ? '   (' + detail + ')' : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   (' + detail + ')' : '')); }
}
const f3 = x => Number(x).toFixed(3);
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);

let nTmp = 0;
function measure(soup, noSelfint) {
  const f = path.join(TMP, 'm' + (nTmp++) + '.stl');
  writeSTL(f, soup, 'nso_features_test');
  const r = JSON.parse(execFileSync('python3', [MV, f, '--json'].concat(noSelfint ? ['--no-selfint'] : []),
    { maxBuffer: 1 << 28 }).toString());
  fs.unlinkSync(f);
  return r;
}
function measureFile(f) { return JSON.parse(execFileSync('python3', [MV, f, '--json'], { maxBuffer: 1 << 28 }).toString()); }
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e.message; } }

/* ------------------------------------------------ independent measurement
   A ray caster and a component count that share nothing with nso_features.js
   or the kernel: Moller-Trumbore on the raw soup, and a union-find over
   triangles on exact vertex values. */
function rayHits(soup, O, Dir) {
  const hits = [];
  for (let t = 0; t < soup.length; t += 9) {
    const a = [soup[t], soup[t + 1], soup[t + 2]];
    const e1 = [soup[t + 3] - a[0], soup[t + 4] - a[1], soup[t + 5] - a[2]];
    const e2 = [soup[t + 6] - a[0], soup[t + 7] - a[1], soup[t + 8] - a[2]];
    const p = [Dir[1] * e2[2] - Dir[2] * e2[1], Dir[2] * e2[0] - Dir[0] * e2[2], Dir[0] * e2[1] - Dir[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) continue;
    const s = [O[0] - a[0], O[1] - a[1], O[2] - a[2]];
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
    if (u < 0 || u > 1) continue;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (Dir[0] * q[0] + Dir[1] * q[1] + Dir[2] * q[2]) / det;
    if (v < 0 || u + v > 1) continue;
    const d = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (d > 1e-9) hits.push([d, det > 0 ? 1 : -1]);          // det > 0: faces the ray - an entry
  }
  hits.sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const h of hits) if (!out.length || h[1] !== out[out.length - 1][1] || h[0] - out[out.length - 1][0] > 1e-6) out.push(h);
  return out;
}
/* Solid runs [enter, exit] along a ray that starts in air. */
function runs(soup, O, Dir) {
  const out = [];
  let depth = 0, start = 0;
  for (const [d, s] of rayHits(soup, O, Dir)) {
    const was = depth; depth += s;
    if (was === 0 && depth > 0) start = d;
    else if (was > 0 && depth === 0) out.push([start, d]);
  }
  return out;
}
function components(soup) {
  const ex = D.exactIndex(soup), n = ex.n;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const first = new Map();
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) {
    const v = ex.index[t * 3 + k];
    if (first.has(v)) { const a = find(first.get(v)), b = find(t); if (a !== b) parent[a] = b; } else first.set(v, t);
  }
  const groups = new Map();
  for (let t = 0; t < n; t++) { const r = find(t); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); }
  return [...groups.values()].map(ts => { const o = new Float32Array(ts.length * 9); ts.forEach((t, i) => o.set(soup.subarray(t * 9, t * 9 + 9), i * 9)); return o; });
}
function signedVolume(s) {
  let v = 0;
  for (let t = 0; t < s.length; t += 9) {
    v += (s[t] * (s[t + 4] * s[t + 8] - s[t + 5] * s[t + 7]) - s[t + 1] * (s[t + 3] * s[t + 8] - s[t + 5] * s[t + 6]) +
          s[t + 2] * (s[t + 3] * s[t + 7] - s[t + 4] * s[t + 6])) / 6;
  }
  return v;
}
function bounds(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i++) { const k = i % 3; if (s[i] < lo[k]) lo[k] = s[i]; if (s[i] > hi[k]) hi[k] = s[i]; }
  return { lo, hi };
}
const inBox = (p, b) => [0, 1, 2].every(i => p[i] >= b.lo[i] - 1e-9 && p[i] <= b.hi[i] + 1e-9);
const add = (a, b, s) => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];
/* A closed box as a soup, for probes. */
function boxSoup(lo, hi) {
  const c = k => [k & 1 ? hi[0] : lo[0], k & 2 ? hi[1] : lo[1], k & 4 ? hi[2] : lo[2]];
  const Q = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const o = [];
  for (const [a, b, cc, d] of Q) o.push(...c(a), ...c(b), ...c(cc), ...c(a), ...c(cc), ...c(d));
  return Float32Array.from(o);
}
function rotZ90(s) { const o = new Float32Array(s.length); for (let i = 0; i < s.length; i += 3) { o[i] = -s[i + 1]; o[i + 1] = s[i]; o[i + 2] = s[i + 2]; } return o; }
function flipX(s) { const o = new Float32Array(s.length); for (let i = 0; i < s.length; i += 3) { o[i] = s[i]; o[i + 1] = -s[i + 1]; o[i + 2] = -s[i + 2]; } return o; }

(async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(G.OUT, 'features.json'), 'utf8'));
  const entry = f => manifest.entries.find(e => e.stl === f);
  const file = f => readSTL(path.join(G.OUT, f));
  const ALL = entry('feature-hull_all.stl');
  const ALLS = file('feature-hull_all.stl');
  const feat = (e, type) => e.features.find(r => r.type === type);

  /* ================================================================ 1 */
  console.log('\n== 1. parameters that are not the feature are refused, with the clause they break ==');
  {
    const cases = [
      ['a flange sticking out under 3t', { type: 'flange', params: { t: 3, reach: 8 } }, /under 3t .*"wide"/],
      ['a flange on a root under 2t', { type: 'flange', params: { t: 3, length: 5 } }, /"attached"/],
      ['a flange on a face under 2.5t tall', { type: 'flange', params: { t: 20, reach: 60 } }, /"thin"/],
      ['a handle whose opening is narrower than its rod', { type: 'handle', params: { r: 6, R: 16 } }, /narrower than the rod/],
      ['a bracket without its gussets', { type: 'bracket', params: { gussets: 0 } }, /is a flange by nso_flange/],
      ['a bracket whose gusset overruns the arm', { type: 'bracket', params: { gusset: 19 } }, /gusset leg/],
      ['a lid whose plug reaches the pocket floor', { type: 'lid', params: { plug: 15 } }, /short of the pocket floor/],
      ['a lid with no clearance on its plug', { type: 'lid', params: { clear: 0 } }, /real clearance/],
      ['a hinge whose moving knuckle has no wall', { type: 'hinge', params: { rp: 4 } }, /too thin/],
      ['a hinge whose leaf is thicker than its knuckle', { type: 'hinge', params: { half: 6 } }, /carried by its knuckle/],
      ['a feature off the edge of its face', { type: 'flange', params: { length: 130 } }, /runs off the face/],
      ['the bed is not a face', { type: 'flange', face: '-z' }, /unknown face/]
    ];
    for (const [name, f, re] of cases) {
      const m = await refusal(() => FX.build({ features: [f] }));
      check(name, m && re.test(m), m);
    }
    const two = await refusal(() => FX.build({ features: [{ type: 'flange' }, { type: 'flange', params: { u: 20 } }] }));
    check('two features whose cells overlap are refused - they would not be independent', two && /overlap/.test(two), two);
    const side = await refusal(() => FX.build({ features: [{ type: 'flange' }, { type: 'flange', params: { u: 0, v: 3 } }] }));
    check('...even on one face, a thickness apart', side && /overlap/.test(side), side);
    const ok = await refusal(() => FX.build({ features: [{ type: 'flange', params: { u: -30, length: 40 } }, { type: 'flange', params: { u: 30, length: 40, v: 10 } }] }));
    check('two flanges on one face with their cells apart are accepted', ok === null, ok);
  }

  /* ================================================================ 2 */
  console.log('\n== 2. every piece: the checker reads exactly what the definitions add up to ==');
  const KEYS = ['triangles', 'welded_vertices', 'open_edges', 'nonmanifold_edges', 'odd_edges',
    'inconsistent_winding_edges', 'euler_characteristic', 'degenerate_tris', 'piercing'];
  for (const e of manifest.entries) {
    const m = measureFile(path.join(G.OUT, e.stl));
    const got = D.measuredFrom(m);
    const dd = KEYS.filter(k => e.expected[k] !== got[k]).map(k => k + ' predicted ' + e.expected[k] + ', checker ' + got[k]);
    check(e.stl + ': census, verdict ' + m.verdict, dd.length === 0 && m.verdict === 'PASS',
      dd.join('; ') || e.expected.triangles + ' tris, chi ' + got.euler_characteristic);
    const dv = rel(m.signed_volume, e.declared.signed_volume), da = rel(m.surface_area, e.declared.surface_area);
    check('  ...volume and area are the hull plus each feature minus its roots', dv < 1e-6 && da < 1e-6,
      'volume ' + f3(m.signed_volume) + ' (' + dv.toExponential(1) + '), area ' + f3(m.surface_area) + ' (' + da.toExponential(1) + ')');
    const chi = e.declared.euler_characteristic, shells = components(file(e.stl)).length;
    check('  ...chi ' + chi + ' and ' + e.declared.shells + ' shell(s), as declared (' +
      e.features.map(r => r.type + (Object.keys(r.topology).length ? ' ' + JSON.stringify(r.topology) : '')).join(', ') + ')',
      got.euler_characteristic === chi && shells === e.declared.shells, shells + ' shells by exact-vertex components');
  }

  /* ================================================================ 3 */
  console.log('\n== 3. each feature detached by its cell is exactly the feature, at exactly its root ==');
  {
    const A = measure(ALLS, true);
    for (const r of ALL.features) {
      const d = await FX.detach(ALLS, r);
      const mf = measure(d.feature, true), mh = measure(d.host, true);
      check(r.type + ': the cell holds exactly the feature - ' + f3(r.volume) + ' mm3, clean',
        rel(mf.signed_volume, r.volume) < 1e-6 && mf.verdict === 'PASS' && mh.verdict === 'PASS',
        'feature ' + f3(mf.signed_volume) + ', host left ' + f3(mh.signed_volume) + ', ' + mf.verdict + '/' + mh.verdict);
      // Contact area, measured: what the two surfaces lose on being joined.
      const contact = (mf.surface_area + mh.surface_area - A.surface_area) / 2;
      check('  ...the contact it leaves is its declared root, ' + f3(r.roots.area) + ' mm2', rel(contact, r.roots.area) < 1e-5,
        'measured ' + f3(contact));
      const back = await FX.reattach(d.host, d.feature);
      const mb = measure(back.soup, true);
      check('  ...reattached, the piece again: volume, area, chi', rel(mb.signed_volume, A.signed_volume) < 1e-9 &&
        rel(mb.surface_area, A.surface_area) < 1e-6 && mb.euler_characteristic === A.euler_characteristic && mb.verdict === 'PASS',
        'chi ' + mb.euler_characteristic + ', ' + f3(mb.signed_volume) + ' mm3');
    }
    // Detached, the lid gives back the open pocket and the hinge takes its moving body with it.
    const lid = await FX.detach(ALLS, feat(ALL, 'lid'));
    const hinge = await FX.detach(ALLS, feat(ALL, 'hinge'));
    check('the lid comes off whole (one body, chi 2) and the void goes with it',
      components(lid.feature).length === 1 && measure(lid.feature, true).euler_characteristic === 2 &&
      components(lid.host).length === ALL.declared.shells - 1);
    check('the hinge comes off as its two bodies', components(hinge.feature).length === 2);
  }

  /* ================================================================ 4 */
  console.log('\n== 4. nso_flange.js: the one flange, and nothing else ==');
  {
    const r = Fl.detect(ALLS);
    const truth = feat(ALL, 'flange').truth;
    const fl = r.flanges[0];
    check('the whole piece: exactly one flange (the manifest says ' + ALL.detectors.flange.count + ')',
      r.flanges.length === ALL.detectors.flange.count && r.flanges.length === 1, Fl.describe(r) + ', ' + r.ms + ' ms, cell ' + f3(r.cell));
    check('...no bad ray columns', r.badCells === 0, 'bad ' + r.badCells);
    check('...on the generated flange\'s axis, at its thickness', fl && fl.axis.join() === truth.axis.join() &&
      Math.abs(fl.thickness - truth.thickness) < 0.01, fl && fl.axis.join(',') + ', t ' + f3(fl.thickness));
    check('...in its band', fl && Math.abs(fl.band[0] - truth.band[0]) < 0.01 && Math.abs(fl.band[1] - truth.band[1]) < 0.01,
      fl && fl.band.map(f3).join(' - ') + ' vs ' + truth.band.join(' - '));
    check('...reach and root length within a grid cell of the truth', fl && Math.abs(fl.reach - truth.reach) <= r.cell &&
      Math.abs(fl.rootLen - truth.root_length) <= r.cell, fl && f3(fl.reach) + ' / ' + f3(fl.rootLen) + ' vs ' + truth.reach + ' / ' + truth.root_length);
    check('...cut on the true root: its normal, 2 um past the face', fl && fl.cut.normal.join() === truth.root_normal.join() &&
      Math.abs(fl.cut.offset - (truth.root_offset + 0.002)) < 1e-6, fl && fl.cut.normal.join(',') + ' @ ' + fl.cut.offset);
    const ex = fl ? Fl.extract(ALLS, fl, rawCut) : { ok: false };
    const vb = ex.ok ? bounds(ex.positions) : null;
    const vol = ex.ok ? signedVolume(ex.positions) : 0;
    const want = feat(ALL, 'flange').volume * (1 - 0.002 / truth.reach);
    check('...lifted out, it is the flange: its volume less the 2 um root clearance', ex.ok && rel(vol, want) < 1e-5,
      ex.ok ? f3(vol) + ' vs ' + f3(want) : ex.reason);
    // The root side stands 2 um off the face; every other side is exact.
    check('...and its bounds', vb && [0, 1, 2].every(i => Math.abs(vb.lo[i] - truth.bounds.lo[i]) < 1e-3 &&
      Math.abs(vb.hi[i] - truth.bounds.hi[i]) < 3e-3), vb && vb.lo.map(f3).join(',') + ' .. ' + vb.hi.map(f3).join(','));
    const vj = ex.ok ? measure(ex.positions, true) : null;
    check('...a clean solid', vj && vj.verdict === 'PASS' && vj.euler_characteristic === 2, vj && vj.verdict);

    // Zero false positives: every slab candidate inside another feature's cell fails.
    for (const other of ALL.features.filter(x => x.type !== 'flange')) {
      const cs = r.candidates.filter(c => other.cells.some(b => inBox(c.centroid, b)));
      const passed = cs.filter(c => !c.failed.length);
      const tally = {};
      cs.forEach(c => c.failed.forEach(k => { tally[k] = (tally[k] || 0) + 1; }));
      check('  ' + other.type + ': ' + cs.length + ' slab candidates in its cell, none passes', passed.length === 0,
        Object.keys(tally).map(k => k + ' ' + tally[k]).join(', ') || 'no slab at all');
    }
    const onHost = r.candidates.filter(c => !ALL.features.some(x => x.cells.some(b => inBox(c.centroid, b))));
    check('  the hull itself: ' + onHost.length + ' slab candidate(s), none passes', onHost.every(c => c.failed.length > 0));

    // Each feature alone on the hull.
    for (const e of manifest.entries.filter(x => x.features.length === 1)) {
      const rr = Fl.detect(file(e.stl));
      check(e.stl + ': ' + e.detectors.flange.count + ' flange(s)', rr.flanges.length === e.detectors.flange.count, Fl.describe(rr));
    }
    // The pin on the bracket's definition: without its gussets it IS a flange.
    const ang = entry('feature-hull_angle-unbraced.stl'), at = feat(ang, 'angle').truth;
    const ra = Fl.detect(file(ang.stl)), fa = ra.flanges[0];
    check('the unbraced angle\'s arm is found as a flange: on the arm, its thickness, cut on the plate face',
      ra.flanges.length === 1 && Math.abs(fa.thickness - at.thickness) < 0.01 && inBox(fa.centroid, at.arm.bounds) &&
      fa.cut.normal.join() === at.plate.normal.join() && Math.abs(fa.cut.offset - (at.plate.bounds.hi[0] + 0.002)) < 1e-6,
      Fl.describe(ra));
    const rb = Fl.detect(file('feature-hull_bracket.stl'));
    const armC = rb.candidates.filter(c => inBox(c.centroid, feat(entry('feature-hull_bracket.stl'), 'bracket').truth.arm.bounds));
    check('...and with its gussets the same arm fails on its root: the gussets make it a bracket',
      armC.length > 0 && armC.every(c => c.failed.includes('straight')), armC.map(c => c.failed.join('+')).join('; '));
    // The handle's arch, seen along the loop's normal, is a band of nearly even
    // chord that chains into a slab. It is a rod, and the "sheet" clause is
    // what says so; without it this was a false positive (t 7.7 mm, 26 mm out).
    const rh = Fl.detect(file('feature-hull_handle.stl'));
    const hc = rh.candidates.filter(c => c.failed.length === 1 && c.failed[0] === 'sheet');
    check('the handle\'s rod crest fails exactly one clause, "sheet": narrower than it is thick',
      hc.length >= 1 && hc.every(c => c.sheetReach < 3 * c.thickness),
      hc.map(c => 't ' + f3(c.thickness) + ', ' + f3(c.reach) + ' out, eroded ' + f3(c.sheetReach)).join('; '));
    // Pose: the same answer turned a quarter and upside down.
    for (const [name, s] of [['turned 90 about Z', rotZ90(ALLS)], ['upside down', flipX(ALLS)]]) {
      const rr = Fl.detect(s);
      check('the whole piece ' + name + ': one flange, ' + truth.thickness + ' mm', rr.flanges.length === 1 &&
        Math.abs(rr.flanges[0].thickness - truth.thickness) < 0.01, Fl.describe(rr));
    }
  }

  /* ================================================================ 5 */
  console.log('\n== 5. the handle is a loop you can take hold of ==');
  {
    const e = entry('feature-hull_handle.stl'), h = feat(e, 'handle'), T = h.truth, S = file(e.stl);
    const m = measureFile(path.join(G.OUT, e.stl));
    check('genus 1 by the checker: chi ' + m.euler_characteristic, m.euler_characteristic === 0);
    const W = h.frame.W, U = h.frame.U, V = h.frame.V;
    const face = add(T.opening_centre, W, -T.clear / 2);          // on the face, under the middle of the arch
    const up = runs(S, add(face, V, 1e-3), W);
    check('straight out from the face at the middle: air for exactly `clear`, then the rod',
      up.length >= 1 && Math.abs(up[0][0] - T.clear) < 1e-3 && Math.abs(up[0][1] - up[0][0] - 2 * T.rod_radius) < 1e-2,
      up.length ? 'air ' + f3(up[0][0]) + ', rod ' + f3(up[0][1] - up[0][0]) : 'no hit');
    const across = runs(S, add(add(face, W, 1e-3), U, -(T.arc_radius + T.rod_radius + 5)), U);
    check('along the face between the legs: a leg, the opening (2 clear), the other leg',
      across.length >= 2 && Math.abs(across[1][0] - across[0][1] - T.opening_width) < 1e-2,
      across.map(x => f3(x[0]) + '-' + f3(x[1])).join(', '));
    const rho = 0.4 * T.clear;
    const finger = (du, dw) => { const c = add(add(T.opening_centre, U, du), W, dw);
      return boxSoup([0, 1, 2].map(i => c[i] - rho * (Math.abs(U[i]) + Math.abs(W[i])) - 40 * Math.abs(V[i])),
                     [0, 1, 2].map(i => c[i] + rho * (Math.abs(U[i]) + Math.abs(W[i])) + 40 * Math.abs(V[i]))); };
    const free = await FX.overlapVolume(S, finger(0, 0));
    check('a finger through the opening touches nothing', free === 0, 'overlap ' + free);
    const trapped = [];
    for (const [du, dw] of [[T.clear, 0], [-T.clear, 0], [0, T.clear], [0, -T.clear]]) trapped.push(await FX.overlapVolume(S, finger(du, dw)));
    check('...and is trapped: moved one clearance any way in the loop\'s plane, it hits', trapped.every(v => v > 0),
      trapped.map(v => f3(v)).join(', '));
  }

  /* ================================================================ 6 */
  console.log('\n== 6. the bracket is an L of one thickness, braced ==');
  {
    const e = entry('feature-hull_bracket.stl'), b = feat(e, 'bracket'), T = b.truth, S = file(e.stl);
    const p = b.params, U = b.frame.U, V = b.frame.V, W = b.frame.W, C = b.frame.C;
    const at = (u, v, w) => [0, 1, 2].map(i => C[i] + u * U[i] + v * V[i] + w * W[i]);
    const down = (u, w) => runs(S, at(u, p.v0 + p.height + 5, w), V.map(x => -x));
    const mid = down(0, p.t + (p.arm - p.t) / 2);
    check('through the arm between the gussets: t', mid.length && Math.abs(mid[0][1] - mid[0][0] - p.t) < 1e-4,
      mid.length ? f3(mid[0][1] - mid[0][0]) : 'no hit');
    let taper = true; const seen = [];
    for (const s of [0.1, 0.4, 0.7, 0.95]) {
      const wv = p.t + s * p.gusset, want = p.t + p.gusset - (wv - p.t);
      const r = down(-p.width / 2 + p.t / 2, wv);
      const got = r.length ? r[0][1] - r[0][0] : 0;
      seen.push(f3(got) + '/' + f3(want));
      if (Math.abs(got - want) > 1e-3) taper = false;
    }
    check('through a gusset: arm plus a straight 45-degree taper', taper, seen.join(', '));
    const back = runs(S, at(0, p.v0 + p.height - 2, p.arm + 5), W.map(x => -x));
    const Dw = FX.frame({ size: e.host.size }, b.face).Dw;
    check('square to the face above the gussets: the plate\'s face at t, then solid through the hull - fused flat',
      back.length && Math.abs(back[0][0] - (p.arm + 5 - p.t)) < 1e-4 && Math.abs(back[0][1] - back[0][0] - (p.t + Dw)) < 1e-3,
      back.length ? 'air ' + f3(back[0][0]) + ', solid ' + f3(back[0][1] - back[0][0]) + ' = t + ' + Dw : 'no hit');
    check('volume: plate + arm + two gussets, by hand', rel(b.volume, T.volume_analytic) < 1e-9, f3(b.volume) + ' vs ' + f3(T.volume_analytic));
  }

  /* ================================================================ 7 */
  console.log('\n== 7. the lid lifts off its seat, locates by its plug, and closes a void ==');
  {
    const e = entry('feature-hull_lid.stl'), l = feat(e, 'lid'), T = l.truth, S = file(e.stl);
    const d = await FX.detach(S, l);
    const W = l.frame.W, U = l.frame.U, V = l.frame.V;
    check('volume: plate + plug, by hand', rel(l.volume, T.volume_analytic) < 1e-9, f3(l.volume));
    const lift = await FX.overlapVolume(d.host, FX.translate(d.feature, W.map(x => x * 0.01)));
    check('lifted 0.01 mm off the seat it touches nothing - it comes straight off', lift === 0, 'overlap ' + lift);
    const slide = async (dir, s) => FX.overlapVolume(d.host, FX.translate(FX.translate(d.feature, W.map(x => x * 1e-3)), dir.map(x => x * s)));
    const small = [await slide(U, 0.5 * T.clear), await slide(U, -0.5 * T.clear), await slide(V, 0.5 * T.clear), await slide(V, -0.5 * T.clear)];
    const big = [await slide(U, 2 * T.clear), await slide(U, -2 * T.clear), await slide(V, 2 * T.clear), await slide(V, -2 * T.clear)];
    check('slid half its clearance any way, the plug still clears the pocket', small.every(v => v === 0), small.map(f3).join(', '));
    check('slid twice it, the plug hits the pocket wall - it locates', big.every(v => v > 0), big.map(f3).join(', '));
    const m = measureFile(path.join(G.OUT, e.stl));
    const shells = components(S).map(signedVolume).sort((x, y) => x - y);
    check('seated, it encloses a void: chi 4, and the inner shell holds exactly the pocket less the plug',
      m.euler_characteristic === 4 && shells.length === 2 && rel(-shells[0], T.void_volume) < 1e-9,
      'chi ' + m.euler_characteristic + ', inner shell ' + f3(shells[0]) + ' mm3, declared void ' + f3(T.void_volume));
    const mh = measure(d.host, true);
    check('detached, the pocket is open again: the hull is one genus-0 shell', mh.euler_characteristic === 2 && components(d.host).length === 1);
  }

  /* ================================================================ 8 */
  console.log('\n== 8. the hinge turns, stops, and stays on its pin ==');
  {
    const e = entry('feature-hull_hinge.stl'), hg = feat(e, 'hinge'), T = hg.truth, S = file(e.stl);
    const parts = components(S).sort((a, b) => b.length - a.length);
    check('two bodies, by exact-vertex components: the hull with its fixed knuckles, and the moving leaf', parts.length === 2,
      parts.map(p => p.length / 9 + ' tris').join(' + '));
    const [fixed, moving] = parts;
    const mm = measure(moving, true);
    check('the moving body is closed and genus 1 (its bore)', mm.verdict === 'PASS' && mm.euler_characteristic === 0, 'chi ' + mm.euler_characteristic);
    const mb = bounds(moving);
    check('...and it is where the truth says, to the micron', [0, 1, 2].every(i => Math.abs(mb.lo[i] - T.moving.lo[i]) < 1e-3 &&
      Math.abs(mb.hi[i] - T.moving.hi[i]) < 1e-3), mb.lo.map(f3).join(',') + ' .. ' + mb.hi.map(f3).join(','));
    const swing = [];
    for (const deg of [-90, -45, 45, 90]) swing.push([deg, await FX.overlapVolume(fixed, FX.rotateAbout(moving, T.axis_point, T.axis_dir, deg))]);
    check('swung -90, -45, 45, 90 degrees about its axis it touches nothing', swing.every(x => x[1] === 0),
      swing.map(x => x[0] + ': ' + f3(x[1])).join(', '));
    const stop = [];
    for (const deg of T.swing_blocked_deg) stop.push([deg, await FX.overlapVolume(fixed, FX.rotateAbout(moving, T.axis_point, T.axis_dir, deg))]);
    check('...and at +-135 the face stops it', stop.every(x => x[1] > 0), stop.map(x => x[0] + ': ' + f3(x[1])).join(', '));
    const A = T.axis_dir, W = hg.frame.W, V = hg.frame.V;
    const mv = async (dir, s) => FX.overlapVolume(fixed, FX.translate(moving, dir.map(x => x * s)));
    const axial = [await mv(A, 0.5 * T.gap), await mv(A, -0.5 * T.gap)];
    const axialHit = [await mv(A, 2 * T.gap), await mv(A, -2 * T.gap)];
    check('slid half its axial gap along the pin it is free; slid twice it, a fixed knuckle stops it',
      axial.every(v => v === 0) && axialHit.every(v => v > 0), axial.concat(axialHit).map(f3).join(', '));
    const radial = [await mv(W, 0.5 * T.clear), await mv(V, 0.5 * T.clear), await mv(V, -0.5 * T.clear)];
    const radialHit = [await mv(V, 2 * T.clear), await mv(V, -2 * T.clear), await mv(W.map(x => -x), 2 * T.clear)];
    check('moved half its clearance across the pin it is free; moved twice it, the pin holds it',
      radial.every(v => v === 0) && radialHit.every(v => v > 0), radial.concat(radialHit).map(f3).join(', '));
  }

  /* ================================================================ 9 */
  console.log('\n== 9. fixtures/features/ reads as its manifest says, and the Library lists it ==');
  {
    const onDisk = fs.readdirSync(G.OUT).filter(f => f.endsWith('.stl')).sort();
    const listed = manifest.entries.map(e => e.stl).sort();
    check('every file on disk is in features.json and every entry is on disk', JSON.stringify(onDisk) === JSON.stringify(listed), onDisk.length + ' files');
    for (const e of manifest.entries) {
      const head = fs.readFileSync(path.join(G.OUT, e.stl)).slice(0, 80).toString('latin1');
      check(e.stl + ': its header says what it is', /^NSO feature fixture: /.test(head));
    }
    const a1 = await FX.build({ features: FX.ORDER.map(type => ({ type })) });
    const a2 = await FX.build({ features: FX.ORDER.map(type => ({ type })) });
    check('the same call is the same bytes - and the committed bytes', Buffer.from(a1.soup.buffer).equals(Buffer.from(a2.soup.buffer)) &&
      Buffer.from(a1.soup.buffer).equals(Buffer.from(ALLS.buffer)));

    const cat = fs.readFileSync(path.join(ROOT, 'app-library.js'), 'utf8');
    const rows = (cat.match(/\{\s*file:\s*'([^']+)'[^}]*category:\s*'([^']+)'/g) || [])
      .map(row => ({ file: row.match(/file:\s*'([^']+)'/)[1], category: row.match(/category:\s*'([^']+)'/)[1] }));
    const want = manifest.entries.filter(e => e.library).map(e => e.stl);
    const inLib = rows.filter(r => want.includes(r.file));
    check('every library-flagged fixture has a Library row, under Test Fixtures',
      inLib.length === want.length && inLib.every(r => r.category === 'Test Fixtures'), inLib.length + ' of ' + want.length);
    const unflagged = rows.filter(r => manifest.entries.some(e => e.stl === r.file && !e.library));
    check('...and nothing the manifest keeps out of the Library is in it', unflagged.length === 0, unflagged.map(r => r.file).join(', '));
    const src = f => ((cat.match(new RegExp("\\{\\s*file:\\s*'" + f.replace(/[.]/g, '\\.') + "'[^}]*source:\\s*'([^']+)'")) || [])[1]);
    check('...each served from nest-library, where the catalog fetches from', want.every(f => src(f) === 'nest-library'), want.map(src).join(', '));
    const NL = LIBDIR.libraryDir();
    if (NL) {
      const drift = want.filter(f => !fs.existsSync(path.join(NL, f)) ||
        !fs.readFileSync(path.join(NL, f)).equals(fs.readFileSync(path.join(G.OUT, f))));
      check('...and nest-library holds each one byte-identical to fixtures/features/', drift.length === 0, drift.join(', '));
    } else {
      LIBDIR.skip('...nest-library holds each one byte-identical to fixtures/features/');
    }
    const stray = want.filter(f => fs.existsSync(path.join(ROOT, 'library', f)));
    check('...and none of them is copied into this repo\'s library/', stray.length === 0, stray.join(', '));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('FAILED: ' + FAILS.join(' | ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
