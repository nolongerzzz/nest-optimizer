/* Crop, stage 1 (app-crop.js): every result must pass the canonical checker.
   node tools/nso_crop_test.js        exit 0 = every gate held

   A box selects a slab along one axis. Crop removes it, slides the far part
   back by the box length and seals the joint, so what comes out is ONE
   closed piece, shorter by exactly the box length. Every gate below runs
   tools/mesh_validate.py on the result, the same checker the rawCut seam fix
   (tools/nso_rawcut_seam_test.js) is held to.

   1. the simple test piece: a 60 mm bar, middle 10 mm cropped. Exact length,
      exact volume, both kept parts bit for bit, and a full checker PASS
      including self-intersection. Also the reason the joint is sealed here
      and not handed to Join: Join's planar fuse refuses this very pair.
   2. sections that differ: a stepped bar, both ways round. The step face is
      capped with Cut's rawFlatCapLoop and faces the right way.
   3. a tube: the section has a hole. Both sections match, so no cap is
      needed and Cut's simple-outline cap never runs.
   4. library pieces, including the Mirror-Join seams of v9_mirror_factory
      and boxes ending exactly on a seam ring. Volume is checked against
      rawCut's own two capped halves, an independent route to the same number.
   5. refusals: each names its reason and hands back the input untouched.
      A box face landing exactly on a flat face of the piece is NOT one of
      them (2b): that face is part of the section and is sealed like any other.
   6. the box -> faces selection. */

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
for (const f of ['app-cut.js', 'nso_planar_fuse.js', 'app-crop.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { rawCut, NSO_cropRaw, NSO_cropResolveBox, NSO_planarFusePair } = ctx;

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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-crop-'));
let seq = 0;
function validate(soup, opts) {
  opts = opts || {};
  const f = path.join(TMP, 'p' + (seq++) + '.stl');
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(f, b);
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--json'];
  if (!opts.selfint) args.push('--no-selfint');
  const j = JSON.parse(execFileSync('python3', args, { maxBuffer: 1 << 30 }).toString());
  j.summary = 'open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' inc ' + j.inconsistent_winding_edges +
    ' deg ' + j.degenerate_tris + ' chi ' + j.euler_characteristic +
    (j.self_intersection ? ' pierce ' + j.self_intersection.pierce + ' coplanar ' + j.self_intersection.coplanar : '');
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
// What the result must enclose, computed without any cap: the flux of
// F = (x_k - c) e_k over one part's walls, zero across its open face at c.
function openVolume(s, k, c) {
  let v = 0;
  for (let o = 0; o < s.length; o += 9) {
    const u = [s[o+3]-s[o], s[o+4]-s[o+1], s[o+5]-s[o+2]], w = [s[o+6]-s[o], s[o+7]-s[o+1], s[o+8]-s[o+2]];
    const n = [u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]];
    v += ((s[o+k] + s[o+3+k] + s[o+6+k]) / 3 - c) * n[k] / 2;
  }
  return v;
}
function bounds(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i++) { const k = i % 3; lo[k] = Math.min(lo[k], s[i]); hi[k] = Math.max(hi[k], s[i]); }
  return { lo, hi };
}
function triKeys(s) {
  const out = [];
  for (let t = 0; t < s.length; t += 9) out.push(Array.from(s.slice(t, t + 9)).join(','));
  return out;
}

// Closed solids from outward-wound faces. poly: points in order, CCW seen
// from outside; fanned from its first point (all test polygons are fan-safe).
function solid(polys) {
  const out = [];
  for (const P of polys) for (let i = 1; i + 1 < P.length; i++) out.push(...P[0], ...P[i], ...P[i + 1]);
  return new Float32Array(out);
}
// Bar 0..L x 0..W x 0..H: every face one quad, so each wall is a single
// long diagonal - the case where the two cuts never share a vertex.
function bar(L, W, H) {
  return solid([
    [[0, 0, 0], [0, W, 0], [L, W, 0], [L, 0, 0]],         // z = 0, -z
    [[0, 0, H], [L, 0, H], [L, W, H], [0, W, H]],         // z = H, +z
    [[0, 0, 0], [L, 0, 0], [L, 0, H], [0, 0, H]],         // y = 0, -y
    [[0, W, 0], [0, W, H], [L, W, H], [L, W, 0]],         // y = W, +y
    [[0, 0, 0], [0, 0, H], [0, W, H], [0, W, 0]],         // x = 0, -x
    [[L, 0, 0], [L, W, 0], [L, W, H], [L, 0, H]]          // x = L, +x
  ]);
}
// Stepped bar: 0..30 is W x 8, 30..60 is W x 4, bottoms flush. The side
// faces are the L-shaped hexagon, fanned from (0,0) so no T-junction.
function steppedBar() {
  const W = 12;
  const side = [[0, 0], [60, 0], [60, 4], [30, 4], [30, 8], [0, 8]];
  return solid([
    [[0, 0, 0], [0, W, 0], [60, W, 0], [60, 0, 0]],
    [[0, 0, 8], [30, 0, 8], [30, W, 8], [0, W, 8]],
    [[30, 0, 4], [60, 0, 4], [60, W, 4], [30, W, 4]],
    [[30, 0, 4], [30, W, 4], [30, W, 8], [30, 0, 8]],     // the step, +x
    side.map(([x, z]) => [x, 0, z]),                      // y = 0, -y
    [side[0]].concat(side.slice(1).reverse()).map(([x, z]) => [x, W, z]),   // y = W, +y
    [[0, 0, 0], [0, 0, 8], [0, W, 8], [0, W, 0]],
    [[60, 0, 0], [60, W, 0], [60, W, 4], [60, 0, 4]]
  ]);
}
// x -> 60 - x with the winding swapped: the same stepped bar, thin end first.
function flipX(s) {
  const o = new Float32Array(s.length);
  for (let t = 0; t < s.length; t += 9) {
    const v = [[60 - s[t], s[t+1], s[t+2]], [60 - s[t+3], s[t+4], s[t+5]], [60 - s[t+6], s[t+7], s[t+8]]];
    o.set([...v[0], ...v[2], ...v[1]], t);
  }
  return o;
}

try {
  console.log('\n=== 1. the simple test piece: 60 x 12 x 8 bar, X 25..35 cropped out ===');
  {
    const src = bar(60, 12, 8);
    const s0 = validate(src, { selfint: true });
    check('source bar passes the checker', s0.verdict === 'PASS', s0.summary);
    const r = NSO_cropRaw(src, { axisIdx: 0, lo: 25, hi: 35 });
    check('crop ok', r.ok, r.reason);
    const v = validate(r.tris, { selfint: true });
    check('result PASSES mesh_validate.py, self-intersection included', v.verdict === 'PASS', v.summary);
    check('open 0, non-manifold 0, inconsistent 0, degenerate 0, one shell (chi 2)',
      v.open_edges === 0 && v.nonmanifold_edges === 0 && v.inconsistent_winding_edges === 0 &&
      v.degenerate_tris === 0 && v.euler_characteristic === 2, v.summary);
    const b = bounds(r.tris);
    check('shortened by exactly the box: X 0..50', b.lo[0] === 0 && b.hi[0] === 50, b.lo[0] + '..' + b.hi[0]);
    check('cross-section exactly unchanged: Y 0..12, Z 0..8',
      b.lo[1] === 0 && b.hi[1] === 12 && b.lo[2] === 0 && b.hi[2] === 8);
    check('volume exactly 50 x 12 x 8 = 4800', Math.abs(volume(r.tris) - 4800) < 1e-6, String(volume(r.tris)));
    check('reported lengths 60 -> 50, removed 10', r.lengthBefore === 60 && r.lengthAfter === 50 && r.removedLength === 10);
    check('sections match: no cap, only T-junction splits', r.joint.capLoops === 0 && r.joint.tJunctionSplits > 0,
      JSON.stringify(r.joint));
    // Both kept parts, bit for bit: every vertex of the source left of the
    // box is still there, every vertex right of it is there 10 mm lower.
    const have = new Set();
    for (let i = 0; i < r.tris.length; i += 3) have.add(r.tris[i] + ',' + r.tris[i+1] + ',' + r.tris[i+2]);
    let missing = 0;
    for (let i = 0; i < src.length; i += 3) {
      const x = src[i];
      const want = x < 25 ? x : x > 35 ? x - 10 : null;
      if (want !== null && !have.has(want + ',' + src[i+1] + ',' + src[i+2])) missing++;
    }
    check('both kept parts are bit for bit where they were (far part exactly -10 in X)', missing === 0, missing + ' missing');

    // Why not rawCut + Join: the two capped halves, far one slid back, are
    // refused by Join's planar fuse on this very bar.
    const lo = rawCut(src, 0, 25, false), hi = rawCut(src, 0, 35, true);
    const hs = new Float32Array(hi); for (let i = 0; i < hs.length; i += 3) hs[i] -= 10;
    const fu = NSO_planarFusePair(lo, hs);
    check('baseline: Join\'s planar fuse refuses rawCut\'s two caps (different vertices on one outline)',
      !fu.ok, fu.ok ? 'fused' : fu.reason);
  }

  console.log('\n=== 2. sections that differ: stepped bar, X 20..40 ===');
  for (const [name, src, facing] of [['thick end first', steppedBar(), '+x'], ['thin end first', flipX(steppedBar()), '-x']]) {
    const s0 = validate(src, { selfint: true });
    check(name + ': source passes', s0.verdict === 'PASS', s0.summary);
    const r = NSO_cropRaw(src, { axisIdx: 0, lo: 20, hi: 40 });
    check(name + ': crop ok', r.ok, r.reason);
    if (!r.ok) continue;
    const v = validate(r.tris, { selfint: true });
    check(name + ': result PASSES, self-intersection included', v.verdict === 'PASS', v.summary);
    const b = bounds(r.tris);
    check(name + ': X 0..40', b.lo[0] === 0 && b.hi[0] === 40, b.lo[0] + '..' + b.hi[0]);
    check(name + ': volume 20x12x8 + 20x12x4 = 2880', Math.abs(volume(r.tris) - 2880) < 1e-6, String(volume(r.tris)));
    check(name + ': one step face capped', r.joint.capLoops === 1, JSON.stringify(r.joint));
    // The cap: triangles in the plane x = 20 carry the 12 x 4 step, facing out.
    let nx = 0, area = 0;
    for (let t = 0; t < r.tris.length; t += 9) {
      if (r.tris[t] !== 20 || r.tris[t+3] !== 20 || r.tris[t+6] !== 20) continue;
      const s = r.tris;
      const ny = (s[t+4]-s[t+1]) * (s[t+8]-s[t+2]) - (s[t+5]-s[t+2]) * (s[t+7]-s[t+1]);
      nx += ny / 2; area += Math.abs(ny) / 2;
    }
    check(name + ': step face is 48 mm^2 facing ' + facing, Math.abs(area - 48) < 1e-9 &&
      Math.abs(nx - (facing === '+x' ? 48 : -48)) < 1e-9, 'area ' + area + ', signed ' + nx);
  }

  console.log('\n=== 2b. a box face exactly on the step face: that face is section, not wall ===');
  {
    const r = NSO_cropRaw(steppedBar(), { axisIdx: 0, lo: 30, hi: 45 });
    check('crop ok', r.ok, r.reason);
    if (r.ok) {
      const v = validate(r.tris, { selfint: true });
      check('result PASSES, self-intersection included', v.verdict === 'PASS', v.summary);
      check('the step face lying in the box face was taken out as section', r.inPlaneDropped === 2, String(r.inPlaneDropped));
      check('X 0..45, volume 30x12x8 + 15x12x4 = 3600', bounds(r.tris).hi[0] === 45 && Math.abs(volume(r.tris) - 3600) < 1e-6,
        String(volume(r.tris)));
    }
  }

  console.log('\n=== 3. a tube (the section has a hole), Z 10..15 ===');
  {
    const src = readSTL(path.join(ROOT, 'library', 'soften_test_03_thinwall_tube.stl'));
    const r = NSO_cropRaw(src, { axisIdx: 2, lo: 10, hi: 15 });
    check('crop ok', r.ok, r.reason);
    const v = validate(r.tris, { selfint: true });
    check('result PASSES, self-intersection included; still a tube (chi 0)',
      v.verdict === 'PASS' && v.euler_characteristic === 0, v.summary);
    check('no cap needed, so Cut\'s simple-outline cap never runs', r.joint.capLoops === 0);
    check('length 25 -> 20', r.lengthBefore === 25 && r.lengthAfter === 20, r.lengthBefore + ' -> ' + r.lengthAfter);
    const want = volume(src) * 20 / 25;
    check('volume is 20/25 of the source (a pure prism)', Math.abs(volume(r.tris) - want) / want < 1e-6,
      volume(r.tris).toFixed(4) + ' vs ' + want.toFixed(4));
  }

  console.log('\n=== 4. library pieces ===');
  const CASES = [
    ['pin.stl', 0, 8, 12, true],
    ['soften_test_04_slotted_block.stl', 0, 4.8, 32.4, true],       // step face through the slot
    ['soften_test_05_star_prism.stl', null, 0.3, 0.55, true],        // two step faces
    ['hinge_knuckle_box.stl', 0, 7.2, 10.8, true],
    ['hinge_knuckle_box.stl', 0, 2.16, 14.58, true],
    ['CTH_fixture.stl', null, 0.12, 0.81, true],
    ['v9_mirror_factory.stl', 0, -18.7, 18.7, true],                 // full checker once on the big one
    ['v9_mirror_factory.stl', 0, 50, 87.53694152832031, false],      // far face exactly on the +seam ring
    ['v9_mirror_factory.stl', 0, -88.56546020507812, -20, false],    // near face exactly on the -seam ring
    ['v9_mirror_factory.stl', 0, 0, 88, false],                      // through the +seam's sub-tolerance pair
    ['v9_mirror_factory.stl', null, 0.12, 0.81, false]               // crossings at the joint
  ];
  for (const [file, ax, a, b, selfint] of CASES) {
    const src = readSTL(path.join(ROOT, 'library', file));
    let k = ax, lo = a, hi = b;
    const bb = bounds(src);
    if (k === null) {   // fractions of the longest axis
      k = [0, 1, 2].sort((p, q) => (bb.hi[q] - bb.lo[q]) - (bb.hi[p] - bb.lo[p]))[0];
      lo = bb.lo[k] + (bb.hi[k] - bb.lo[k]) * a; hi = bb.lo[k] + (bb.hi[k] - bb.lo[k]) * b;
    }
    const tag = file + ' ' + 'XYZ'[k] + ' ' + (+lo.toFixed(4)) + '..' + (+hi.toFixed(4));
    const r = NSO_cropRaw(src, { axisIdx: k, lo, hi });
    if (!r.ok) { check(tag + ': crop ok', false, r.reason); continue; }
    const v = validate(r.tris, { selfint });
    check(tag + ': PASS' + (selfint ? ' (self-intersection included)' : ''), v.verdict === 'PASS',
      v.summary + '  [' + r.joint.capLoops + ' cap loop(s), ' + r.joint.crossings + ' crossing(s)]');
    const d = Math.fround(hi) - Math.fround(lo);
    check(tag + ': length shortened by the box', Math.abs((r.lengthBefore - r.lengthAfter) - d) < 1e-4,
      r.lengthBefore.toFixed(4) + ' -> ' + r.lengthAfter.toFixed(4) + ', box ' + d.toFixed(4));
    // Two independent references. The open-wall flux needs no cap at all.
    // rawCut's two capped halves are Cut's own answer, and count only where
    // Cut's cap is right: a section with a hole in it is Cut's known
    // limitation (one ear-clip per loop), and its halves fail the checker.
    const fL = Math.fround(lo), fH = Math.fround(hi);
    const flux = openVolume(ctx.rawCutOpen(src, k, fL, false), k, fL) + openVolume(ctx.rawCutOpen(src, k, fH, true), k, fH);
    check(tag + ': volume = the two kept parts (open-wall flux)', Math.abs(volume(r.tris) - flux) / Math.abs(flux) < 1e-5,
      volume(r.tris).toFixed(3) + ' vs ' + flux.toFixed(3));
    const nearHalf = rawCut(src, k, fL, false), farHalf = rawCut(src, k, fH, true);
    const halvesOk = validate(nearHalf).verdict === 'PASS' && validate(farHalf).verdict === 'PASS';
    if (halvesOk) {
      const want = volume(nearHalf) + volume(farHalf);
      check(tag + ': volume = rawCut\'s two capped halves', Math.abs(volume(r.tris) - want) / Math.abs(want) < 1e-5,
        volume(r.tris).toFixed(3) + ' vs ' + want.toFixed(3));
    } else {
      console.log('        (rawCut\'s own halves fail the checker here - a section with a hole, Cut\'s cap limitation - so they are not a reference)');
    }
  }

  console.log('\n=== 5. refusals name the reason and hand back the input untouched ===');
  {
    const src = bar(60, 12, 8);
    const REF = [
      ['box over an end', src, { axisIdx: 0, lo: -1, hi: 10 }, /inside the piece/],
      ['box not covering the cross-section', src,
        { box: { axisIdx: 0, min: [20, 0, 0], max: [30, 6, 8] } }, /whole cross-section/],
      ['step face that would need a hole (hinge bore)',
        readSTL(path.join(ROOT, 'library', 'hinge_knuckle_box.stl')), { axisIdx: 0, lo: 5.4, hi: 9.9 }, /hole/],
      ['two overlapping shells at the joint (box_closed.stl, 74 piercing pairs in the source)',
        readSTL(path.join(ROOT, 'library', 'box_closed.stl')), { axisIdx: 0, lo: 24, hi: 36 }, /overlap/]
    ];
    for (const [name, s, opts, re] of REF) {
      const r = NSO_cropRaw(s, opts);
      check(name + ': refused', !r.ok && re.test(r.reason), r.reason);
      check(name + ': input object handed back', r.tris === s);
    }
  }

  console.log('\n=== 6. the box selects faces ===');
  {
    const sel = NSO_cropResolveBox(bar(60, 12, 8), { axisIdx: 0, min: [25, -1, -1], max: [35, 13, 9] });
    check('bar: 8 wall triangles clipped, 4 end triangles kept, none wholly inside',
      sel.ok && sel.faces.clipped === 8 && sel.faces.kept === 4 && sel.faces.removed === 0, JSON.stringify(sel.faces));
    const pin = readSTL(path.join(ROOT, 'library', 'pin.stl'));
    const ps = NSO_cropResolveBox(pin, { axisIdx: 0, lo: 8, hi: 12 });
    check('pin: every face accounted for', ps.ok && ps.faces.removed + ps.faces.clipped + ps.faces.kept === pin.length / 9,
      JSON.stringify(ps.faces));
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('\n' + (fail === 0 ? 'PASS' : fail + ' FAILED') + ' (' + pass + ' ok)');
process.exit(fail === 0 ? 0 : 1);
