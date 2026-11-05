#!/usr/bin/env node
/* Picture -> relief slab: does what comes out SCULPT? Headless.
 *
 *   node tools/nso_relief_sculpt_test.js        exit 0 = every gate held
 *
 * The slab is fixtures/relief/camera.png at Levels 8, 40 mm wide at 0.4 mm a
 * sample - the shipped nso_relief.js, nothing hand-built. On it, the shipped
 * tools' own geometry, loaded through `vm` the way tools/nso_brush_test.js
 * and tools/nso_rawcut_seam_test.js load them:
 *
 *   Brush   NSO_brushApply in Emboss (the brush's raising mode) along a drag
 *           across the face, with the brush's OWN gate on - the region goes
 *           up, and the gate (open, non-manifold, winding, T-junctions,
 *           slivers, self-intersections, volume budget) passes it
 *   Smooth  NSO_smoothGlobal, the Smooth button's bake, with its own gate
 *   Cut     rawCut, the Split engine, both sides of a plane through the
 *           sculpted region - each half sealed
 *   Export  the halves written as binary STL - the file an export is
 *
 * and the canonical checker (tools/mesh_validate.py) on the STL after every
 * step. tools/nso_relief_drive_check.js does the same through the real
 * buttons and pointer events; this one pins the numbers in Node.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { readPNG } = require('./nso_png.js');
const { writeSTL } = require('./nso_stl_io.js');
const RELIEF = require('../nso_relief.js');

const ROOT = path.join(__dirname, '..');
const MV = path.join(ROOT, 'tools', 'mesh_validate.py');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-relief-sculpt-'));

const ctx = { Math, Map, Set, console, isFinite, Object, Array, Number, String, JSON, Error, Infinity, NaN,
  Float32Array, Float64Array, Int32Array, Uint8Array, Uint32Array, ArrayBuffer };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['NSO_Repair.js', 'app-sculpt.js', 'app-brush.js', 'app-cut.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
ctx.NSO_Repair = ctx.window.NSO_Repair;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
function canonical(soup, tag) {
  const p = path.join(TMP, tag + '.stl');
  writeSTL(p, soup, 'nso relief sculpt ' + tag);
  const v = JSON.parse(execFileSync('python3', [MV, p, '--json'], { maxBuffer: 1 << 28 }).toString());
  v.bytes = fs.statSync(p).size;
  return v;
}
function closedLine(tag, v) {
  check(tag + ': canonical - closed, Euler 2, no piercing, PASS',
    v.open_edges === 0 && v.nonmanifold_edges === 0 && v.inconsistent_winding_edges === 0 &&
    v.degenerate_tris === 0 && v.euler_characteristic === 2 && v.self_intersection.pierce === 0 && v.verdict === 'PASS',
    v.triangles + ' tris, open ' + v.open_edges + ', nm ' + v.nonmanifold_edges + ', winding ' +
    v.inconsistent_winding_edges + ', degenerate ' + v.degenerate_tris + ', chi ' + v.euler_characteristic +
    ', pierce ' + v.self_intersection.pierce + ', coplanar ' + v.self_intersection.coplanar +
    ', slivers ' + v.sliver_tris + ', volume ' + v.signed_volume.toFixed(3) + ', ' + v.verdict);
}
const zmax = s => { let m = -Infinity; for (let i = 2; i < s.length; i += 3) if (s[i] > m) m = s[i]; return m; };
const ROWS = [];
const row = (step, v, extra) => ROWS.push(Object.assign({ step: step, tris: v.triangles, open: v.open_edges,
  nm: v.nonmanifold_edges, chi: v.euler_characteristic, pierce: v.self_intersection.pierce,
  slivers: v.sliver_tris, volume: v.signed_volume, verdict: v.verdict }, extra || {}));

console.log('=== the slab ===');
const img = readPNG(path.join(ROOT, 'fixtures', 'relief', 'camera.png'));
const slab = RELIEF.build(img, { widthMm: 40, sampleMm: 0.4, baseMm: 1.5, reliefMm: 1.2, levels: 8 });
check('built and closed by its own census', slab.ok && slab.census.closed, slab.describe);
const v0 = canonical(slab.rawTris, '0-slab');
closedLine('slab', v0);
row('slab', v0, { zmax: zmax(slab.rawTris) });

console.log('\n=== Brush - Emboss along a drag, the brush\'s own gate on ===');
/* A drag across the face at y = 12 mm, x 8 -> 32 mm, every dab aimed straight
   down on the top surface: the picture's surface under the cursor, as the
   app's raycast would hand it, with the face's up normal. */
const stamps = [];
for (let x = 8; x <= 32; x += 1.5) {
  const i = Math.min(slab.grid.nx - 1, Math.floor(x / slab.grid.dx));
  const j = Math.min(slab.grid.ny - 1, Math.floor((slab.sizeMm[1] - 12) / slab.grid.dy));
  stamps.push({ c: [x, 12, 1.5 + slab.heights[j * slab.grid.nx + i] * 1.2], n: [0, 0, 1], r: 5, falloff: 'soft' });
}
const t0 = Date.now();
const br = ctx.NSO_brushApply(slab.rawTris, stamps, { mode: 'emboss', intensity: 0.8 });
const brMs = Date.now() - t0;
check('the stroke baked through the brush\'s gate', br.ok, br.ok ? stamps.length + ' dabs in ' + brMs + ' ms' : br.reason);
if (br.ok) {
  console.log('   gate before: ' + JSON.stringify({ tris: br.before.tris, openPos: br.before.openPos, nmPos: br.before.nmPos,
    tJunctions: br.before.tJunctions, slivers: br.before.slivers, pierce: br.before.pierce, volume: +br.before.volume.toFixed(3) }));
  console.log('   gate after:  ' + JSON.stringify({ tris: br.after.tris, openPos: br.after.openPos, nmPos: br.after.nmPos,
    tJunctions: br.after.tJunctions, slivers: br.after.slivers, pierce: br.after.pierce, volume: +br.after.volume.toFixed(3) }));
  console.log('   refine: ' + JSON.stringify(br.refine) + ', moved ' + br.moved + ' vertices, max ' + br.maxMove.toFixed(3) + ' mm');
  check('it raised a region: the top went up and material was added',
    zmax(br.tris) > zmax(slab.rawTris) + 0.5 && br.after.volume > br.before.volume,
    'top ' + zmax(slab.rawTris).toFixed(3) + ' -> ' + zmax(br.tris).toFixed(3) + ' mm, volume ' +
    br.before.volume.toFixed(2) + ' -> ' + br.after.volume.toFixed(2) + ' mm^3');
  const v1 = canonical(br.tris, '1-brush');
  closedLine('after the brush', v1);
  row('Brush emboss', v1, { zmax: zmax(br.tris), ms: brMs });
}

console.log('\n=== Smooth - the Smooth button\'s bake ===');
const before = br.ok ? br.tris : slab.rawTris;
const t1 = Date.now();
const sm = ctx.NSO_smoothGlobal(before, { maxVolumeChange: 0.25 });
const smMs = Date.now() - t1;
check('Smooth ran through its own gate', sm.ok, sm.ok ? smMs + ' ms' : sm.reason);
const smoothed = sm.ok ? sm.tris : before;
if (sm.ok) {
  const v2 = canonical(smoothed, '2-smooth');
  closedLine('after Smooth', v2);
  row('Smooth', v2, { zmax: zmax(smoothed), ms: smMs });
}

console.log('\n=== Cut - rawCut, the Split engine, through the sculpted region ===');
let halves = [];
for (const keepMin of [true, false]) {
  const t2 = Date.now();
  let h = null, err = null;
  try { h = ctx.rawCut(smoothed, 0, 20, keepMin); } catch (e) { err = e.message; }
  const ms = Date.now() - t2;
  const tag = keepMin ? 'x < 20' : 'x > 20';
  check('the ' + tag + ' half came back', !!h, err || (h.length / 9) + ' tris in ' + ms + ' ms');
  if (!h) continue;
  halves.push(h);
  const v = canonical(h, '3-cut-' + (keepMin ? 'lo' : 'hi'));
  closedLine('cut ' + tag, v);
  row('Cut ' + tag, v, { ms: ms, bytes: v.bytes });
}
if (halves.length === 2) {
  const vol = s => { let v = 0; for (let o = 0; o < s.length; o += 9) v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7]) - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6]) + s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]); return v / 6; };
  const a = vol(halves[0]), b = vol(halves[1]), w = vol(smoothed);
  check('the halves\' volumes add up to the whole', Math.abs(a + b - w) / w < 1e-4,
    a.toFixed(3) + ' + ' + b.toFixed(3) + ' = ' + (a + b).toFixed(3) + ' vs ' + w.toFixed(3) + ' mm^3');
}

console.log('\n=== the numbers ===');
const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
console.log('  ' + pad('step', 14) + pad('triangles', 11) + pad('open', 6) + pad('nm', 4) + pad('chi', 5) + pad('pierce', 8) +
  pad('slivers', 9) + pad('top mm', 9) + pad('volume mm^3', 13) + pad('verdict', 8) + 'ms');
for (const r of ROWS) {
  console.log('  ' + pad(r.step, 14) + pad(r.tris, 11) + pad(r.open, 6) + pad(r.nm, 4) + pad(r.chi, 5) + pad(r.pierce, 8) +
    pad(r.slivers, 9) + pad(r.zmax != null ? r.zmax.toFixed(3) : '-', 9) + pad(r.volume.toFixed(2), 13) + pad(r.verdict, 8) +
    (r.ms != null ? r.ms : '-'));
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
