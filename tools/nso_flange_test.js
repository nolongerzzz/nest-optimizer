/* nso_flange.js - the flange rule, validated on the real clamp bar.
   node tools/nso_flange_test.js        exit 0 = every gate held

   READ docs/GSCOPE-FLANGE.md for the rule and what these numbers mean.

   The motivating part is library/v9_mirror_factory.stl, the clamp bar: a
   2.94 mm plate standing 15 mm off a 19 x 21 mm body, 187 mm long, with a
   ribbed (keyholed) top on the far side, rounded ends, and two Mirror-Join
   seams (x = 87.537 and -88.565) where the neck wall steps by 10 um. The
   gates below say, in order:

     1. the flange is found, once, with its real thickness, band and root;
     2. nothing on the ribs, the ends or the seams passes - and none of it
        comes close;
     3. the flange lifts out as a closed, manifold solid that is exactly the
        flange: its bounds, no neck or rib in it, and its volume against an
        independent ray-parity integration of the same region;
     4. the same holds with the part turned, flipped, and turned off-axis;
     5. pieces with no flange report none (library pieces and synthetic
        shapes), and the shapes that do have one (T, hat, lip) are found.

   Self-intersection is skipped (--no-selfint) for speed, as nso_rawcut_seam
   does: the cut is rawCut's, whose topology is what is being checked. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const F = require(path.join(ROOT, 'nso_flange.js'));

// app-cut.js's rawCut, loaded the way nso_rawcut_seam_test.js loads it.
const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Float32Array,
  Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer, Error, Infinity, NaN };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-cut.js'), 'utf8'), ctx, { filename: 'app-cut.js' });
const rawCut = ctx.rawCut;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) pass++; else fail++;
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail ? '   ' + detail : ''));
}
const f3 = (x) => Number(x).toFixed(3);

function readSTL(f) {
  const b = fs.readFileSync(f), n = b.readUInt32LE(80), o = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) o[t * 9 + k] = b.readFloatLE(84 + t * 50 + 12 + k * 4);
  return o;
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-flange-'));
let seq = 0;
function validate(soup) {
  const f = path.join(TMP, 'p' + (seq++) + '.stl');
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  const j = JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--no-selfint', '--json']).toString());
  j.summary = j.verdict + ' open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' inc ' +
    j.inconsistent_winding_edges + ' chi ' + j.euler_characteristic;
  return j;
}
function bounds(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i++) { const k = i % 3; if (s[i] < lo[k]) lo[k] = s[i]; if (s[i] > hi[k]) hi[k] = s[i]; }
  return { lo, hi };
}
function volume(s) {
  let v = 0;
  for (let t = 0; t < s.length; t += 9) {
    const ax = s[t], ay = s[t + 1], az = s[t + 2], bx = s[t + 3], by = s[t + 4], bz = s[t + 5], cx = s[t + 6], cy = s[t + 7], cz = s[t + 8];
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}
function rot(s, ax, deg) {
  const c = Math.cos(deg * Math.PI / 180), n = Math.sin(deg * Math.PI / 180), o = new Float32Array(s.length);
  for (let i = 0; i < s.length; i += 3) {
    let x = s[i], y = s[i + 1], z = s[i + 2];
    if (ax === 'z') [x, y] = [c * x - n * y, n * x + c * y];
    if (ax === 'x') [y, z] = [c * y - n * z, n * y + c * z];
    o[i] = x; o[i + 1] = y; o[i + 2] = z;
  }
  return o;
}

/* Independent volume of the part's material on the far side of y = y0:
   z-ray parity on a 0.05 mm grid. Shares no code with nso_flange.js. */
function volumeBeyondY(s, y0) {
  const h = 0.05, x0 = -94, yLo = -17.5, nx = Math.ceil(188 / h), ny = Math.ceil((y0 - yLo) / h);
  const cells = new Map();
  for (let t = 0; t < s.length / 9; t++) {
    const o = t * 9, X = [s[o], s[o + 3], s[o + 6]], Y = [s[o + 1], s[o + 4], s[o + 7]], Z = [s[o + 2], s[o + 5], s[o + 8]];
    if (Math.min(...Y) > y0) continue;
    const den = (X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0]);
    if (Math.abs(den) < 1e-14) continue;
    const sg = den < 0 ? 1 : -1;
    const i0 = Math.max(0, Math.ceil((Math.min(...X) - x0) / h - 0.5)), i1 = Math.min(nx - 1, Math.floor((Math.max(...X) - x0) / h - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(...Y) - yLo) / h - 0.5)), j1 = Math.min(ny - 1, Math.floor((Math.max(...Y) - yLo) / h - 0.5));
    for (let j = j0; j <= j1; j++) {
      const py = yLo + (j + 0.5) * h + 1.3e-5;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * h + 0.7e-5;
        const l1 = ((X[1] - px) * (Y[2] - py) - (X[2] - px) * (Y[1] - py)) / den;
        const l2 = ((X[2] - px) * (Y[0] - py) - (X[0] - px) * (Y[2] - py)) / den;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const k = j * nx + i;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push([l1 * Z[0] + l2 * Z[1] + l3 * Z[2], sg]);
      }
    }
  }
  let V = 0;
  for (const hs of cells.values()) {
    hs.sort((a, b) => a[0] - b[0]);
    let d = 0, st = 0;
    for (const [z, sg] of hs) { const w = d; d += sg; if (w === 0 && d > 0) st = z; else if (w > 0 && d === 0) V += (z - st) * h * h; }
  }
  return V;
}

// --- synthetic shapes: a profile extruded along X, and a lathe -------------
function earClip(poly) {
  const idx = poly.map((_, i) => i), tris = [];
  const area = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (area(a, b, c) <= 1e-12) continue;
      if (idx.some((j) => j !== ia && j !== ib && j !== ic &&
          area(a, b, poly[j]) >= 0 && area(b, c, poly[j]) >= 0 && area(c, a, poly[j]) >= 0)) continue;
      tris.push([ia, ib, ic]); idx.splice(i, 1); cut = true; break;
    }
    if (!cut) break;
  }
  tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}
/** Profile (y, z), counter-clockwise or not, extruded x0..x1: a closed, outward soup. */
function extrude(poly, x0, x1) {
  let A = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; A += a[0] * b[1] - b[0] * a[1]; }
  if (A < 0) poly = poly.slice().reverse();
  const out = [];
  for (const [a, b, c] of earClip(poly)) {
    out.push(x1, ...poly[a], x1, ...poly[b], x1, ...poly[c]);
    out.push(x0, ...poly[a], x0, ...poly[c], x0, ...poly[b]);
  }
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    out.push(x0, ...a, x1, ...b, x1, ...a, x0, ...a, x0, ...b, x1, ...b);
  }
  return Float32Array.from(out);
}
/** Profile (r, z) revolved about Z. */
function lathe(prof, seg) {
  let A = 0;
  for (let i = 0; i < prof.length; i++) { const a = prof[i], b = prof[(i + 1) % prof.length]; A += a[0] * b[1] - b[0] * a[1]; }
  if (A < 0) prof = prof.slice().reverse();
  const out = [], P = (p, t) => [p[0] * Math.cos(t), p[0] * Math.sin(t), p[1]];
  for (let s = 0; s < seg; s++) {
    const t0 = 2 * Math.PI * s / seg, t1 = 2 * Math.PI * (s + 1) / seg;
    for (let i = 0; i < prof.length; i++) {
      const a = prof[i], b = prof[(i + 1) % prof.length];
      out.push(...P(a, t0), ...P(a, t1), ...P(b, t1), ...P(a, t0), ...P(b, t1), ...P(b, t0));
    }
  }
  return Float32Array.from(out);
}

// ===========================================================================
console.log('1. The clamp bar (library/v9_mirror_factory.stl): the flange is found');
const v9 = readSTL(path.join(ROOT, 'library', 'v9_mirror_factory.stl'));
const r = F.detect(v9);
const fl = r.flanges[0];
check('exactly one flange', r.flanges.length === 1, F.describe(r) + ', ' + r.ms + ' ms');
check('no bad ray columns anywhere (seams included)', r.badCells === 0, 'bad ' + r.badCells);
check('its axis is Z (the plate lies flat)', fl && fl.axis[0] === 0 && fl.axis[1] === 0 && fl.axis[2] === 1,
  fl && fl.axis.join(','));
check('thickness 2.94 mm', fl && Math.abs(fl.thickness - 2.938) < 0.01, fl && f3(fl.thickness));
check('band Z 7.53 - 10.47', fl && Math.abs(fl.band[0] - 7.531) < 0.01 && Math.abs(fl.band[1] - 10.469) < 0.01,
  fl && fl.band.map(f3).join(' - '));
check('sticks out >= 14 mm (to the rim fillet of a 15 mm plate)', fl && fl.reach >= 14 && fl.reach <= 15.1, fl && f3(fl.reach));
check('root runs the whole 187 mm bar', fl && fl.rootLen >= 185, fl && f3(fl.rootLen));
check('thin: body at the root >= 2.5 t (margin > 2x)', fl && fl.rootThickness >= 5 * fl.thickness,
  fl && f3(fl.rootThickness) + ' vs ' + f3(fl.thickness));
check('wide: reach >= 3 t (margin > 1.5x)', fl && fl.reach >= 4.5 * fl.thickness);
check('body: 19 mm of body behind the root', fl && fl.body && Math.abs(fl.body.bulk - 19) < 0.05,
  fl && fl.body && f3(fl.body.bulk));
check('root cut normal is -Y', fl && fl.cut.normal[0] === 0 && fl.cut.normal[1] === -1 && fl.cut.normal[2] === 0,
  fl && fl.cut.normal.join(','));
// The neck wall is at y = -1.9987 between the seams and steps to -2.0103
// beyond the -X seam; the cut stands 2 um past the outermost piece.
check('cut on y = -2.0123 (2 um past the outermost neck wall, -2.0103)', fl && Math.abs(fl.cut.offset - 2.0123) < 2e-4,
  fl && 'y = ' + f3(-fl.cut.offset) + ', wall mean ' + f3(-fl.cut.wall) + ', spread ' + (fl.cut.wallSpread * 1000).toFixed(1) + ' um');

console.log('\n2. No false positive on the ribs, the rounded ends or the seams');
const SEAMS = [87.537, -88.565];
const regions = { ribs: [], ends: [], seams: [] };
r.candidates.forEach((c) => {
  const [x, y, z] = c.centroid;
  if (y > 5 && z > -11) regions.ribs.push(c);
  if (Math.abs(x) > 88) regions.ends.push(c);
  if (SEAMS.some((sx) => Math.abs(x - sx) < 3)) regions.seams.push(c);
});
Object.keys(regions).forEach((k) => {
  const cs = regions[k];
  check(k + ': ' + cs.length + ' slab candidates, none passes', cs.length > 0 && cs.every((c) => c.failed.length > 0));
});
const near = r.candidates.filter((c) => c.failed.length && !c.failed.includes('attached'));
const worst = Math.max(...near.map((c) => c.reach / Math.max(3 * c.thickness, 4 * r.cell)));
check('the nearest non-flange attached slab reaches < 25 % of what "wide" needs', worst < 0.25,
  near.length + ' attached slabs, best ' + (worst * 100).toFixed(1) + ' %');

console.log('\n3. The flange lifts out as exactly the flange');
const ex = F.extract(v9, fl, rawCut);
check('extract ok, on an axis plane (no turn)', ex.ok && ex.plane.axisIdx === 1 && !ex.plane.turned, ex.reason || JSON.stringify(ex.plane));
const eb = ex.ok ? bounds(ex.positions) : null;
check('full length: X -93.49 .. 93.49', eb && Math.abs(eb.lo[0] + 93.493) < 0.01 && Math.abs(eb.hi[0] - 93.493) < 0.01,
  eb && f3(eb.lo[0]) + ' .. ' + f3(eb.hi[0]));
check('Y -17.01 .. -2.012: nothing of the neck, nothing of the ribs', eb && Math.abs(eb.lo[1] + 17.010) < 0.01 && eb.hi[1] <= -2.01,
  eb && f3(eb.lo[1]) + ' .. ' + f3(eb.hi[1]));
check('Z 7.53 .. 10.47: nothing of the body below', eb && Math.abs(eb.lo[2] - 7.531) < 0.01 && Math.abs(eb.hi[2] - 10.469) < 0.01,
  eb && f3(eb.lo[2]) + ' .. ' + f3(eb.hi[2]));
const vEx = ex.ok ? volume(ex.positions) : 0;
const vRef = volumeBeyondY(v9, -2.0123);
check('volume matches an independent integration to 0.5 %', Math.abs(vEx - vRef) / vRef < 0.005,
  vEx.toFixed(1) + ' vs ' + vRef.toFixed(1) + ' mm3 (' + ((vEx - vRef) / vRef * 100).toFixed(2) + ' %)');
const vj = ex.ok ? validate(ex.positions) : null;
check('closed, manifold, consistently wound, one shell', vj && vj.verdict === 'PASS' && vj.open_edges === 0 &&
  vj.nonmanifold_edges === 0 && vj.inconsistent_winding_edges === 0 && vj.euler_characteristic === 2, vj && vj.summary);
check('one piece', ex.ok && F.components(ex.positions).length === 1);

console.log('\n4. The same flange, the part turned');
[['turned 90 about Z', rot(v9, 'z', 90)], ['upside down', rot(v9, 'x', 180)], ['on its side', rot(v9, 'x', 90)],
 ['turned 30 about Z (off-axis cut)', rot(v9, 'z', 30)], ['30 about Z then 20 about X', rot(rot(v9, 'z', 30), 'x', 20)]]
  .forEach(([name, s]) => {
    const rr = F.detect(s);
    const e = rr.flanges.length === 1 ? F.extract(s, rr.flanges[0], rawCut) : { ok: false };
    const v = e.ok ? volume(e.positions) : 0;
    const ok = rr.flanges.length === 1 && Math.abs(rr.flanges[0].thickness - fl.thickness) < 0.01 &&
      e.ok && Math.abs(v - vEx) / vEx < 0.002;
    let detail = rr.flanges.length + ' flange(s), ' + (e.ok ? v.toFixed(1) + ' mm3' + (e.plane.turned ? ', cut turned' : '') : e.reason);
    if (e.ok && e.plane.turned) {
      const j = validate(e.positions);
      detail += ', ' + j.summary;
      check(name + ': the turned cut is still a clean solid', j.verdict === 'PASS' && j.open_edges === 0 && j.nonmanifold_edges === 0);
    }
    check(name, ok, detail);
  });

console.log('\n5. No flange where there is none; found where there is');
['box_closed.stl', 'pin.stl', 'hinge_knuckle_box.stl', 'CTH_fixture.stl', 'box_bit_12x8x8.stl', 'box_hull_80x40x20.stl',
 'soften_test_01_cube.stl', 'soften_test_03_thinwall_tube.stl', 'soften_test_04_slotted_block.stl', 'soften_test_05_star_prism.stl']
  .forEach((f) => {
    const rr = F.detect(readSTL(path.join(ROOT, 'library', f)));
    check(f + ': none', rr.flanges.length === 0, F.describe(rr));
  });
const L = extrude([[0, 0], [40, 0], [40, 3], [3, 3], [3, 40], [0, 40]], -20, 20);
const shapes = [
  // [name, soup, flanges expected, extracted volume each (or null), failure expected when none]
  ['T section, 2 mm wings on a 4 mm web', extrude([[-15, 8], [-2, 8], [-2, -10], [2, -10], [2, 8], [15, 8], [15, 10], [-15, 10]], -40, 40), 2, 13 * 2 * 80],
  ['hat section, 2 mm brims', extrude([[-25, 0], [-10, 0], [-10, 15], [10, 15], [10, 0], [25, 0], [25, 2], [12, 2], [12, 17], [-12, 17], [-12, 2], [-25, 2]], -30, 30), 2, 13 * 2 * 60],
  ['2 mm lip on a 20 mm block', extrude([[0, 0], [20, 0], [20, 20], [0, 20], [0, 18], [-12, 18], [-12, 16], [0, 16]], -30, 30), 1, 12 * 2 * 60],
  ['L-bracket, both legs 3 mm (leg off a leg, not a body)', L, 0, null, 'body'],
  ['thick L, 12 mm legs (not thin)', extrude([[0, 0], [30, 0], [30, 12], [12, 12], [12, 30], [0, 30]], -20, 20), 0, null],
  ['plain plate 60 x 40 x 2', extrude([[0, 0], [40, 0], [40, 2], [0, 2]], 0, 60), 0, null, 'attached'],
  ['thin-walled tube', lathe([[8.5, 0], [10, 0], [10, 30], [8.5, 30]], 64), 0, null],
  // A known limit, pinned so it is not mistaken for a pass: a round flange
  // has a round root, and one plane cannot lift it out.
  ['round flange on a pipe (curved root: not handled)', lathe([[5, 0], [25, 0], [25, 2.5], [10, 2.5], [10, 30], [5, 30]], 96), 0, null, 'straight']
];
shapes.forEach(([name, s, want, vol, why]) => {
  const rr = F.detect(s);
  let detail = F.describe(rr);
  let ok = rr.flanges.length === want;
  if (ok && vol) {
    rr.flanges.forEach((f) => {
      const e = F.extract(s, f, rawCut);
      const v = e.ok ? volume(e.positions) : 0;
      // The cut stands 2 um off the root, so a hair under the exact figure.
      if (!(e.ok && Math.abs(v - vol) / vol < 0.001)) ok = false;
      detail += ' | ' + (e.ok ? v.toFixed(1) + ' of ' + vol : e.reason);
    });
  }
  if (ok && why) ok = rr.candidates.length > 0 && rr.candidates[0].failed.includes(why);
  check(name + ': ' + want, ok, detail);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
