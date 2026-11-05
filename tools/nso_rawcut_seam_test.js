/* rawCut through a Join seam: every piece must pass the canonical checker.
   node tools/nso_rawcut_seam_test.js        exit 0 = every gate held

   library/v9_mirror_factory.stl is a Mirror-Join result. Its seams (raw
   x = 87.537 and x = -88.565) are where the Join's boolean re-triangulated the
   part, which left two things a plain clip-and-cap trips over:
     - long slivers running seam-to-seam across the flat faces, so almost any
       plane slices one where it is narrower than the 1e-4 weld radius, and
     - a vertex pair 7e-5 apart at the +seam, and a whole seam ring sitting
       exactly on a plane a user can cut at.
   Before the fix in app-cut.js rawCut, 372 of 374 pieces from a 1 mm sweep
   of this part failed tools/mesh_validate.py (open / non-manifold edges,
   inconsistent winding, degenerate triangles). The gates below are the
   planes that failed for each distinct reason, plus small synthetic cases for
   the on-plane paths.

   Self-intersection is skipped (--no-selfint) to keep this fast; the fix is
   about topology, and the checker's self-intersection pass is unchanged. */

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
const { rawCut } = ctx;

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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-rawcut-seam-'));
let seq = 0;
function validate(soup, weld) {
  const f = path.join(TMP, 'p' + (seq++) + '.stl');
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--no-selfint', '--json'];
  if (weld) args.push('--weld', String(weld));
  const j = JSON.parse(execFileSync('python3', args).toString());
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
function box(x0, x1, y0, y1, z0, z1, ringX) {
  // Closed box; with ringX, its long faces carry a vertex ring at x = ringX so
  // a cut at (or within the weld radius of) ringX meets real on-plane edges.
  const xs = ringX == null ? [x0, x1] : [x0, ringX, x1];
  const out = [];
  const quad = (a, b, c, d) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = xs[i], b = xs[i + 1];
    quad([a, y0, z0], [b, y0, z0], [b, y0, z1], [a, y0, z1]);
    quad([a, y1, z0], [a, y1, z1], [b, y1, z1], [b, y1, z0]);
    quad([a, y0, z0], [a, y1, z0], [b, y1, z0], [b, y0, z0]);
    quad([a, y0, z1], [b, y0, z1], [b, y1, z1], [a, y1, z1]);
  }
  quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  return new Float32Array(out);
}

try {
  console.log('\n=== 1. the fixture carries the seam residue this test is about ===');
  const src = readSTL(path.join(ROOT, 'library', 'v9_mirror_factory.stl'));
  const exact = validate(src, 1e-6), canon = validate(src);
  check('source is closed at an exact weld (1e-6)', exact.verdict === 'PASS', exact.summary);
  check('source FAILS at the canonical 1e-4 weld (sub-tolerance seam pair)', canon.verdict === 'FAIL', canon.summary);
  const vSrc = volume(src);

  console.log('\n=== 2. seam-crossing and seam-sliver cuts: both halves PASS, volume kept ===');
  const planes = [
    [87.53694152832031, 'exactly through the +seam vertex ring'],
    [87.537, '5.8e-5 off the +seam ring'],
    [88, 'just past the +seam, through its sub-tolerance pair\'s slivers'],
    [-88.56546020507812, 'exactly through the -seam ring'],
    [-88.5, 'just inside the -seam'],
    [0, 'mid-body, through the seam-to-seam slivers'],
    [50, 'collinear run on the section (ear-clip over a diagonal)'],
    [-1, 'wall sliver thinner than float32 at the plane'],
    [-68, 'cap points 1.00001e-4 apart before float32 rounding'],
    [-92, 'tip, through a -seam sliver fan']
  ];
  for (const [x, why] of planes) {
    let lo = null, hi = null, err = null;
    try { lo = rawCut(src, 0, x, true); hi = rawCut(src, 0, x, false); } catch (e) { err = e.message; }
    if (err || !lo || !hi) { check('x=' + x + ' (' + why + ') cut both sides', false, err || 'empty side'); continue; }
    const a = validate(lo), b = validate(hi);
    check('x=' + x + ' keep >= plane PASS  (' + why + ')', a.verdict === 'PASS', a.summary);
    check('x=' + x + ' keep <= plane PASS', b.verdict === 'PASS', b.summary);
    const dv = Math.abs(volume(lo) + volume(hi) - vSrc) / vSrc;
    check('x=' + x + ' halves add back to the source volume', dv < 1e-4, (dv * 100).toFixed(5) + '% off');
  }

  console.log('\n=== 3. synthetic on-plane paths ===');
  const ring = box(0, 20, 0, 5, 0, 5, 10);
  for (const [x, why] of [[10, 'plane exactly on a vertex ring'], [10 + 5e-5, 'ring 5e-5 inside the weld radius']]) {
    const lo = rawCut(ring, 0, x, true), hi = rawCut(ring, 0, x, false);
    const a = validate(lo), b = validate(hi);
    check(why + ': both halves PASS', a.verdict === 'PASS' && b.verdict === 'PASS', a.summary + ' | ' + b.summary);
    check(why + ': volumes 250 + 250', Math.abs(volume(lo) - 250) < 1e-2 && Math.abs(volume(hi) - 250) < 1e-2,
      volume(lo).toFixed(4) + ' + ' + volume(hi).toFixed(4));
  }
  const plain = box(0, 10, 0, 5, 0, 5);
  const whole = rawCut(plain, 0, 10, false);
  const wv = whole ? validate(whole) : null;
  check('cut at the end face, keeping the body: box comes back whole and closed',
    !!whole && wv.verdict === 'PASS' && Math.abs(volume(whole) - 250) < 1e-6, whole ? wv.summary + ' vol ' + volume(whole) : 'null');
  check('cut at the end face, keeping the empty side: no zero-volume sheet left behind',
    rawCut(plain, 0, 10, true) === null);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('\n' + (fail === 0 ? 'PASS' : fail + ' FAILED') + ' (' + pass + ' ok)');
process.exit(fail === 0 ? 0 : 1);
