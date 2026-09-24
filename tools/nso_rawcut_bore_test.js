/* rawCut through a section with a hole in it: every piece must pass the
   canonical checker.   node tools/nso_rawcut_bore_test.js   exit 0 = all held

   A cut across a tube, a hinge knuckle or any part with a bore meets the
   plane in more than one loop: the outline, and the bore inside it. rawCut
   used to hand each loop to rawFlatCapLoop on its own, so the bore was filled
   as a second disk on top of the outline's; the checker then sees every bore
   edge wound the same way from both sides. On a 48-segment tube cut at mid
   height that was 96 inconsistent-winding edges on each half, and in a
   9-plane-per-axis sweep it failed hinge_knuckle_box (6 pieces),
   hinge_knuckle_lid (8), hinge_pip (10) and soften_test_03_thinwall_tube (18).
   rawFlatCapLoops (app-cut.js) now classes loops by nesting and bridges each
   hole into its outline before the ear clip.

   Self-intersection is skipped (--no-selfint): the fix is about topology. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Float32Array,
  Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer, Error, Infinity, NaN };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-cut.js'), 'utf8'), ctx, { filename: 'app-cut.js' });
const { rawCut, rawFlatCapLoop, rawFlatCapLoops } = ctx;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++; else fail++;
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}

function readSTL(f) {
  const b = fs.readFileSync(f), n = b.readUInt32LE(80), o = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) o[t * 9 + k] = b.readFloatLE(84 + t * 50 + 12 + k * 4);
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-rawcut-bore-'));
let seq = 0;
function validate(soup) {
  const f = path.join(TMP, 'p' + (seq++) + '.stl');
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  const j = JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--no-selfint', '--json']).toString());
  j.summary = 'open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' inc ' + j.inconsistent_winding_edges +
    ' deg ' + j.degenerate_tris + ' chi ' + j.euler_characteristic;
  return j;
}
function volume(s) {
  let v = 0;
  for (let o = 0; o < s.length; o += 9) {
    v += s[o] * (s[o+4] * s[o+8] - s[o+5] * s[o+7]) - s[o+1] * (s[o+3] * s[o+8] - s[o+5] * s[o+6])
       + s[o+2] * (s[o+3] * s[o+7] - s[o+4] * s[o+6]);
  }
  return v / 6;
}
// Area of the cap triangles, projected onto the plane (unsigned).
function capArea(cap, axisIdx) {
  const o1 = (axisIdx + 1) % 3, o2 = (axisIdx + 2) % 3;
  let a = 0;
  for (let t = 0; t < cap.length; t += 9) {
    a += Math.abs((cap[t+3+o1]-cap[t+o1]) * (cap[t+6+o2]-cap[t+o2]) - (cap[t+3+o2]-cap[t+o2]) * (cap[t+6+o1]-cap[t+o1])) / 2;
  }
  return a;
}

// The side walls of a straight prism along z, 0..h, one wall ring per section
// ring. depths[i] is ring i's nesting depth: even = an outline (wall faces
// out), odd = a bore (wall faces into the bore). Ends are added by the caller.
function prismWalls(rings, depths, h) {
  const out = [];
  function area(r) { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i+1) % r.length]; a += p[0]*q[1] - q[0]*p[1]; } return a / 2; }
  rings.forEach((r0, k) => {
    const r = (area(r0) > 0) === (depths[k] % 2 === 0) ? r0 : r0.slice().reverse();
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q = r[(i + 1) % r.length];
      out.push(p[0], p[1], 0, q[0], q[1], 0, q[0], q[1], h, p[0], p[1], 0, q[0], q[1], h, p[0], p[1], h);
    }
  });
  return out;
}
function circle(cx, cy, r, n, phase) {
  const out = [];
  for (let i = 0; i < n; i++) { const t = 2 * Math.PI * (i + (phase || 0)) / n; out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  return out;
}
// Concentric rings of equal segment count, closed with quad strips between
// neighbours (ring k to ring k+1 is material when k is even).
function concentricTube(radii, n, h) {
  const rings = radii.map(r => circle(0, 0, r, n));
  const out = prismWalls(rings, radii.map((_, i) => i), h);
  for (let k = 0; k + 1 < rings.length; k += 2) {
    const A = rings[k], B = rings[k + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      // top (+z): outer ring CCW seen from +z
      out.push(B[i][0], B[i][1], h, A[i][0], A[i][1], h, A[j][0], A[j][1], h);
      out.push(B[i][0], B[i][1], h, A[j][0], A[j][1], h, B[j][0], B[j][1], h);
      out.push(B[j][0], B[j][1], 0, A[j][0], A[j][1], 0, A[i][0], A[i][1], 0);
      out.push(B[j][0], B[j][1], 0, A[i][0], A[i][1], 0, B[i][0], B[i][1], 0);
    }
  }
  return new Float32Array(out);
}

function cutBoth(name, src, axisIdx, plane) {
  let lo = null, hi = null, err = null;
  try { lo = rawCut(src, axisIdx, plane, true); hi = rawCut(src, axisIdx, plane, false); } catch (e) { err = e.message; }
  if (err || !lo || !hi) { check(name + ': cut both sides', false, err || 'empty side'); return; }
  const a = validate(lo), b = validate(hi);
  check(name + ': keep >= plane PASS', a.verdict === 'PASS', a.summary);
  check(name + ': keep <= plane PASS', b.verdict === 'PASS', b.summary);
  const vs = volume(src), dv = Math.abs(volume(lo) + volume(hi) - vs) / Math.abs(vs);
  check(name + ': halves add back to the source volume', dv < 1e-4, (dv * 100).toFixed(5) + '% off');
}

try {
  console.log('\n=== 1. the old per-loop cap is the bug this test is about ===');
  const tube = concentricTube([10, 5], 48, 20);
  const src0 = validate(tube);
  check('tube source is closed and consistent', src0.verdict === 'PASS', src0.summary);
  const outer = circle(0, 0, 10, 48).map(p => [p[0], p[1], 7]);
  const bore = circle(0, 0, 5, 48).map(p => [p[0], p[1], 7]);
  const annulus = Math.PI * (100 - 25) * Math.sin(2 * Math.PI / 48) / (2 * Math.PI / 48);
  const perLoop = capArea(rawFlatCapLoop(outer, 2, 7, true), 2) + capArea(rawFlatCapLoop(bore, 2, 7, true), 2);
  check('per-loop caps cover outline + bore (double-covers the bore)', Math.abs(perLoop - annulus) > 1, perLoop.toFixed(3) + ' vs annulus ' + annulus.toFixed(3));
  const joint = rawFlatCapLoops([outer, bore], 2, 7, true);
  check('rawFlatCapLoops covers exactly the annulus', Math.abs(capArea(joint, 2) - annulus) < 1e-6 * annulus,
    capArea(joint, 2).toFixed(6) + ' vs ' + annulus.toFixed(6));
  check('... with no new vertex (only loop points)', (function () {
    const ok = new Set(outer.concat(bore).map(p => p.join(',')));
    for (let i = 0; i < joint.length; i += 3) if (!ok.has(joint[i] + ',' + joint[i+1] + ',' + joint[i+2])) return false;
    return true;
  })());
  check('loop order does not matter (bore first)', Math.abs(capArea(rawFlatCapLoops([bore, outer], 2, 7, false), 2) - annulus) < 1e-6 * annulus);

  console.log('\n=== 2. synthetic sections with holes ===');
  cutBoth('tube across its axis (annulus)', tube, 2, 7);
  cutBoth('tube across its axis, off-centre height', tube, 2, 13.25);
  cutBoth('tube along its axis, clear of the bore', tube, 0, 7.5);
  cutBoth('tube along its axis, through the bore (two strips)', tube, 0, 0.3);
  cutBoth('tube in a tube (outline, bore, island, island bore)', concentricTube([12, 9, 6, 3], 40, 10), 2, 4);
  // A plate with two off-centre round bores and a square one: three holes
  // under one outline, bridged one after another. Its ends are closed with
  // rawFlatCapLoops itself, so the source is checked on its own first.
  const plateRings = [
    [[-20, -8], [20, -8], [20, 8], [-20, 8]],
    circle(-11, 0, 4, 32), circle(11, 1, 3, 24, 0.5), [[-2, -3], [3, -3], [3, 2], [-2, 2]]
  ];
  const plateSrc = prismWalls(plateRings, [0, 1, 1, 1], 6);
  // keepMin true = the kept side is >= the plane, so its cap faces -axis.
  for (const [z, keepMin] of [[0, true], [6, false]]) {
    const cap = rawFlatCapLoops(plateRings.map(r => r.map(p => [p[0], p[1], z])), 2, z, keepMin);
    for (const c of cap) plateSrc.push(c);
  }
  const plateF = new Float32Array(plateSrc);
  const pv = validate(plateF);
  check('three-bore plate, closed with rawFlatCapLoops ends, is a valid solid', pv.verdict === 'PASS' && pv.euler_characteristic === -4, pv.summary);
  const ngon = (r, n) => n * r * r * Math.sin(2 * Math.PI / n) / 2;
  const plateArea = 40 * 16 - 25 - ngon(4, 32) - ngon(3, 24);
  check('... with the right volume (section area x 6)', Math.abs(volume(plateF) - plateArea * 6) < 1e-3 * plateArea * 6,
    volume(plateF).toFixed(3) + ' vs ' + (plateArea * 6).toFixed(3));
  cutBoth('three-bore plate across its thickness', plateF, 2, 2.5);
  cutBoth('three-bore plate along y, through a round bore and the square one', plateF, 1, 0.5);

  console.log('\n=== 3. real parts with a bore (planes that failed before the fix) ===');
  const hinge = readSTL(path.join(ROOT, 'library', 'hinge_knuckle_box.stl'));
  for (const x of [1.8, 9, 16.2]) cutBoth('hinge_knuckle_box x=' + x + ' (knuckle bore)', hinge, 0, x);
  const thin = readSTL(path.join(ROOT, 'library', 'soften_test_03_thinwall_tube.stl'));
  for (const z of [2.5, 5]) cutBoth('soften_test_03_thinwall_tube z=' + z, thin, 2, z);
  const pip = readSTL(path.join(ROOT, 'fixtures', 'hinge_pip.stl'));
  const lid = readSTL(path.join(ROOT, 'fixtures', 'hinge_knuckle_lid.stl'));
  for (const [nm, s] of [['hinge_pip', pip], ['hinge_knuckle_lid', lid]]) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < s.length; i++) { mn[i % 3] = Math.min(mn[i % 3], s[i]); mx[i % 3] = Math.max(mx[i % 3], s[i]); }
    for (let a = 0; a < 3; a++) for (const f of [0.2, 0.5, 0.8]) {
      cutBoth(nm + ' axis ' + a + ' at ' + f * 100 + '%', s, a, mn[a] + (mx[a] - mn[a]) * f);
    }
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('\n' + (fail === 0 ? 'PASS' : fail + ' FAILED') + ' (' + pass + ' ok)');
process.exit(fail === 0 ? 0 : 1);
