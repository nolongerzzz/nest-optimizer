#!/usr/bin/env node
// Headless self-test for Scale part 3: Length / Width / Height on boxes and
// trays, and the wall-kept Offset that replaced Fatten / Shrink.
//
//   node tools/nso_box_scale_test.js        exit 0 = every gate held
//
// THE FIXTURES ARE BUILT HERE, as meshes, by tools/nso_box_fixtures.js - not
// read from a file and not from another repository - so this test always
// runs, locally and in CI, and the wall and floor figures it holds the
// result to are the ones written in this file:
//
//   TRAY   100 x 40 x 25, walls 2, floor 2, open at the top
//   BAR    60 x 20 x 10, solid
//   TUBE   nso_stock.js's tube at height 40 (a generated ring, for the offset)
//
// Every coordinate of the tray and the bar is an integer, so float32 holds
// it exactly and "the wall is 2 mm" is a statement about bits: the distinct
// coordinate layers along each axis are read off the mesh and compared with
// ===, never within a tolerance.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const BOX = require('./nso_box_fixtures.js');

const ROOT = path.join(__dirname, '..');
const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, isNaN, parseFloat, parseInt,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, Uint16Array, Int8Array, ArrayBuffer,
  Error, Infinity, NaN, Date, Promise, RegExp, Boolean, Symbol, setTimeout, clearTimeout
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
for (const f of ['nso_thickness.js', 'NSO_Repair.js', 'nso_stock.js', 'app-cut.js', 'app-sculpt.js', 'app-finish.js',
                 'app-extend.js', 'app-fatten.js', 'nso_section.js', 'nso_ring.js', 'app-scale.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const { NSO_sectionRead, NSO_sectionReadout, NSO_extendRaw, NSO_scaleOffsetRaw, NSO_buildAdjacency, NSO_sculptMetrics,
        NSO_Stock: S, NSO_sectionShow } = ctx;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const L = BOX.layers;
const AX = 'XYZ';
function metrics(soup) { return NSO_sculptMetrics(soup, NSO_buildAdjacency(soup, {})); }
function closed(soup) { const m = metrics(soup); return m.openPos === 0 && m.nmPos === 0; }
function sameAxis(a, b, k) { for (let i = k; i < a.length; i += 3) if (a[i] !== b[i]) return false; return true; }
// float32 ULP at magnitude m, for the curved pieces whose coordinates are not integers
function ulp32(m) { const f = Math.fround(Math.abs(m)) || 1e-38; const e = Math.floor(Math.log2(f)); return Math.pow(2, e - 23); }

const W = 2, F = 2;                       // the tray's wall and floor, mm
const TRAY = BOX.tray(100, 40, 25, W, F);
const BAR = BOX.bar(60, 20, 10);
const trayVol = (l, w, h) => l * w * h - (l - 2 * W) * (w - 2 * W) * (h - F);

console.log('\n=== 1. the fixtures, as built ===');
check('tray: closed, manifold, 16 vertices, layers x 0,2,98,100  y 0,2,38,40  z 0,2,25',
  closed(TRAY) && L(TRAY, 0).join() === '0,2,98,100' && L(TRAY, 1).join() === '0,2,38,40' && L(TRAY, 2).join() === '0,2,25');
check('tray: volume 100*40*25 - 96*36*23 = 20512 mm3', Math.abs(Math.abs(metrics(TRAY).volume) - 20512) < 1e-6, String(metrics(TRAY).volume));
check('bar: closed, 12 triangles, volume 12000 mm3', closed(BAR) && BAR.length === 12 * 9 && Math.abs(Math.abs(metrics(BAR).volume) - 12000) < 1e-9);

console.log('\n=== 2. what the card offers ===');
const rT = NSO_sectionRead(TRAY), vT = rT.verbs;
console.log('   tray: ' + NSO_sectionReadout(rT));
check('tray reads other, gate "shape": a U open at the top', rT.shape === 'other' && rT.gate === 'shape' &&
  rT.why === 'its section along X is a U - open at the top - not a closed rectangle', rT.why);
check('tray: Length X 100 (band 96), Width Y 40 (band 36), Height Z 25 (band 23)',
  vT.length.axisIdx === 0 && vT.length.mm === 100 && vT.length.bandMm === 96 &&
  vT.width.axisIdx === 1 && vT.width.mm === 40 && vT.width.bandMm === 36 &&
  vT.height.axisIdx === 2 && vT.height.mm === 25 && vT.height.bandMm === 23, JSON.stringify([vT.length, vT.width, vT.height]));
check('tray: Offset shown (every piece but a ring or rod gets it), no Longest (it is the Length)', vT.offset && !vT.longest);
const rB = NSO_sectionRead(BAR), vB = rB.verbs;
console.log('   bar:  ' + NSO_sectionReadout(rB));
check('bar reads Bar 60.0 L × 20.0 W × 10.0 H with all three fields', NSO_sectionReadout(rB) === 'Bar 60.0 L × 20.0 W × 10.0 H' &&
  vB.length && vB.width && vB.height && vB.offset && !vB.longest);
// A bar stood on end: Height is still its own Z, Length the longer of X / Y.
const STAND = BOX.bar(10, 20, 60), rS = NSO_sectionRead(STAND);
check('a bar stood on end: Height Z 60, Length Y 20, Width X 10 - the piece\'s axes as it lies',
  rS.verbs.height.mm === 60 && rS.verbs.length.axisIdx === 1 && rS.verbs.width.axisIdx === 0, NSO_sectionReadout(rS));
const TUBE = S.make({ shape: 'tube', height: 40 }).soup, rU = NSO_sectionRead(TUBE), vU = rU.verbs;
check('ring: Length, Outer Ø and Wall; no Width / Height / Diameter / Offset; no Longest (it is the Length and the Ø)',
  vU.length && vU.outer && vU.wall && !vU.width && !vU.height && !vU.diameter && !vU.offset && !vU.longest, JSON.stringify(vU.named));
const SPH = S.make({ shape: 'sphere', height: 40 }).soup, rP = NSO_sectionRead(SPH), vP = rP.verbs;
check('sphere: only Offset, Whole x and Longest', !vP.length && !vP.width && !vP.height && vP.offset && vP.longest,
  rP.reason);
check('one display precision: 18.0047 shows 18.0, 40.623 shows 40.62, 25 shows 25.0',
  NSO_sectionShow(18.0047) === '18.0' && NSO_sectionShow(40.623) === '40.62' && NSO_sectionShow(25) === '25.0');

console.log('\n=== 3. Length / Width / Height on the tray: walls and floor bit for bit ===');
// [axis, target, the layers that axis must end with]
const CASES = [
  [0, 120, '0,2,118,120'], [0, 60, '0,2,58,60'],
  [1, 50, '0,2,48,50'], [1, 30, '0,2,28,30'],
  [2, 35, '0,2,35'], [2, 10, '0,2,10']
];
for (const [k, t, want] of CASES) {
  const r = NSO_extendRaw(TRAY, { axis: k, length: t });
  const dims = [100, 40, 25]; dims[k] = t;
  const lay = r.ok ? L(r.tris, k) : [];
  const others = r.ok && [0, 1, 2].filter(a => a !== k).every(a => sameAxis(r.tris, TRAY, a));
  const walls = k === 2 ? [lay[1] - lay[0]] : [lay[1] - lay[0], lay[3] - lay[2]];
  check(AX[k] + ' -> ' + t + ': ' + (r.ok ? r.mode : 'REFUSED ' + r.reason) + ', ' + AX[k] + ' layers ' + lay.join(','),
    r.ok && lay.join() === want);
  check('  ' + (k === 2 ? 'floor' : 'both walls') + ' exactly ' + (k === 2 ? F : W) + ' mm (===), every coordinate off ' + AX[k] + ' untouched',
    walls.every(w => w === (k === 2 ? F : W)) && others && r.crossSectionDrift === 0, walls.join(','));
  check('  closed, and the volume is the tray\'s own at ' + dims.join(' x '),
    closed(r.tris) && Math.abs(Math.abs(metrics(r.tris).volume) - trayVol(dims[0], dims[1], dims[2])) < 1e-6,
    Math.abs(metrics(r.tris).volume).toFixed(6) + ' vs ' + trayVol(dims[0], dims[1], dims[2]));
}

console.log('\n=== 4. shrinking below the walls or the floor refuses, naming the most it can take ===');
for (const [k, t, most] of [[2, 1.5, '22.9'], [1, 3, '35.9'], [0, 3, '95.9']]) {
  const r = NSO_extendRaw(TRAY, { axis: k, length: t });
  console.log('   ' + AX[k] + ' -> ' + t + ': ' + r.reason);
  check(AX[k] + ' -> ' + t + ' refused: "Shorten can remove up to ' + most + ' mm here", piece unchanged',
    !r.ok && r.reason.indexOf('Shorten can remove up to ' + most + ' mm here') === 0 && r.tris === TRAY);
}
{
  const r = NSO_extendRaw(TRAY, { axis: 2, length: 25 - 22.9 });
  check('...and exactly that much is allowed: Height 2.1, the floor still 2 mm', r.ok && L(r.tris, 2)[1] - L(r.tris, 2)[0] === 2,
    r.ok ? L(r.tris, 2).join(',') : r.reason);
}

console.log('\n=== 5. Length / Width / Height on the solid bar ===');
for (const [k, t] of [[0, 80], [0, 40], [1, 25], [1, 12], [2, 15], [2, 4]]) {
  const r = NSO_extendRaw(BAR, { axis: k, length: t });
  const dims = [60, 20, 10]; dims[k] = t;
  check('bar ' + AX[k] + ' -> ' + t + ': ' + dims.join(' x ') + ', the other two axes untouched, volume ' + dims[0] * dims[1] * dims[2],
    r.ok && L(r.tris, k).join() === '0,' + t && [0, 1, 2].filter(a => a !== k).every(a => sameAxis(r.tris, BAR, a)) &&
    Math.abs(Math.abs(metrics(r.tris).volume) - dims[0] * dims[1] * dims[2]) < 1e-6, r.ok ? '' : r.reason);
}

console.log('\n=== 6. Offset on the tray: the outside moves, the inner faces follow ===');
for (const t of [0.5, 1, -0.5, -1, -5]) {
  const r = NSO_scaleOffsetRaw(TRAY, t);
  const lx = r.ok ? L(r.tris, 0) : [], ly = r.ok ? L(r.tris, 1) : [], lz = r.ok ? L(r.tris, 2) : [];
  console.log('   ' + (t > 0 ? '+' : '') + t + ': ' + (r.ok ? 'x ' + lx.join(',') + '  y ' + ly.join(',') + '  z ' + lz.join(',') : r.reason));
  check('offset ' + t + ': every outer face ' + Math.abs(t) + ' mm ' + (t > 0 ? 'out' : 'in') + ' - ' + (100 + 2 * t) + ' x ' +
    (40 + 2 * t) + ' x ' + (25 + 2 * t),
    r.ok && lx[0] === -t && lx[3] === 100 + t && ly[0] === -t && ly[3] === 40 + t && lz[0] === -t && lz[2] === 25 + t);
  check('  walls 2 mm and floor 2 mm, exactly (===)',
    r.ok && lx[1] - lx[0] === 2 && lx[3] - lx[2] === 2 && ly[1] - ly[0] === 2 && ly[3] - ly[2] === 2 && lz[1] - lz[0] === 2,
    r.ok ? [lx[1] - lx[0], lx[3] - lx[2], ly[1] - ly[0], ly[3] - ly[2], lz[1] - lz[0]].join(',') : '');
  check('  closed, still reads as the U-section tray', r.ok && closed(r.tris) && NSO_sectionRead(r.tris).gate === 'shape');
}
{
  const r = NSO_scaleOffsetRaw(TRAY, -12);
  console.log('   -12: ' + r.reason);
  check('offset -12: the pocket closes (23 mm deep, less 2 x 12) - refused, limit "bore", piece unchanged',
    !r.ok && r.limit === 'bore' && /^the bore or pocket would close/.test(r.reason) && r.tris === TRAY);
  const f = NSO_scaleOffsetRaw(TRAY, -12.4);
  console.log('   -12.4: ' + f.reason);
  check('offset -12.4: the 25 mm height would drop to 0.2 mm - refused, limit "floor", naming 0.42 mm and the most it can take',
    !f.ok && f.limit === 'floor' && f.reason === 'its Z size of 25.00 mm would drop to 0.20 mm, under the 0.42 mm floor for a 0.4 mm nozzle - the most it can shrink is 12.29 mm');
}

console.log('\n=== 7. Offset on the bar and the ring ===');
{
  const g = NSO_scaleOffsetRaw(BAR, 1);
  check('bar +1: 62 x 22 x 12, volume 16368', g.ok && Math.abs(Math.abs(metrics(g.tris).volume) - 62 * 22 * 12) < 1e-6 && g.innerFaces === 0);
  const ok = NSO_scaleOffsetRaw(BAR, -4.75);
  check('bar -4.75: 10 mm down to 0.5, over the 0.42 mm floor - applies', ok.ok && L(ok.tris, 2).join() === '4.75,5.25', ok.ok ? L(ok.tris, 2).join() : ok.reason);
  const no = NSO_scaleOffsetRaw(BAR, -4.8);
  check('bar -4.8: 10 mm down to 0.4 - refused at the floor', !no.ok && no.limit === 'floor', no.reason);
}
{
  const R0 = rU.outer.diameterMm, B0 = rU.bore.diameterMm, W0 = rU.wallMm, L0 = rU.lengthMm;
  const eps = 4 * ulp32(R0);
  for (const t of [0.1, -0.1, -0.5, -5]) {
    const r = NSO_scaleOffsetRaw(TUBE, t);
    const s = r.ok ? NSO_sectionRead(r.tris) : null;
    console.log('   tube ' + t + ': ' + (s ? NSO_sectionReadout(s) : r.reason));
    check('tube ' + t + ': still a ring, Ø and length ' + (2 * t) + ' mm, the bore with them, the wall kept',
      s && s.shape === 'round' && s.hollow && Math.abs(s.outer.diameterMm - (R0 + 2 * t)) < 1e-3 &&
      Math.abs(s.bore.diameterMm - (B0 + 2 * t)) < 1e-3 && Math.abs(s.wallMm - W0) < eps && Math.abs(s.lengthMm - (L0 + 2 * t)) < 1e-3,
      s ? 'wall ' + s.wallMm + ' vs ' + W0 : '');
  }
  const c = NSO_scaleOffsetRaw(TUBE, -16);
  console.log('   tube -16: ' + c.reason);
  check('tube -16: its Ø' + NSO_sectionShow(B0) + ' bore would close - refused, limit "bore"', !c.ok && c.limit === 'bore', c.reason);
}

console.log('\n=== 8. Offset on a stepped piece: fixtures/lid_strap.stl ===');
{
  // A 2.4 mm plate (y 0..40) with a 0.6 mm strap along one edge (y 40..48):
  // an L-section. The strap's top and the step face sit inside the convex
  // hull, in the concave corner, so Thicken's classification calls them
  // INNER and they follow the outer faces rather than moving out. Recorded
  // here as it is, not as it might be wished: the plate thickens by 2t, the
  // strap keeps its 0.6 mm and slides with the plate's underside, and the
  // step deepens by 2t. Closed, manifold, nothing thinner than it was.
  const { readSTL } = require('./nso_stl_io.js');
  const LID = readSTL(path.join(ROOT, 'fixtures', 'lid_strap.stl'));
  const rL = NSO_sectionRead(LID);
  check('lid_strap: Offset shown alongside Length, Width and Height', rL.verbs.offset && rL.verbs.length && rL.verbs.width && rL.verbs.height);
  for (const t of [0.5, -0.5]) {
    const r = NSO_scaleOffsetRaw(LID, t);
    const z = r.ok ? L(r.tris, 2) : [];
    // the plate's thickness at its far edge (least y), the strap's at its own (most y)
    const zAt = (pick) => { if (!r.ok) return [NaN, NaN]; const ys = L(r.tris, 1), y0 = pick(ys); let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < r.tris.length; i += 3) if (r.tris[i + 1] === y0) { lo = Math.min(lo, r.tris[i + 2]); hi = Math.max(hi, r.tris[i + 2]); }
      return [lo, hi]; };
    const pz = zAt(ys => ys[0]), sz = zAt(ys => ys[ys.length - 1]);
    const plate = pz[1] - pz[0], strap = sz[1] - sz[0];
    console.log('   ' + t + ': z layers ' + z.map(v => +v.toFixed(4)).join(', ') + ' - plate ' + plate.toFixed(3) + ', strap ' + strap.toFixed(3));
    check('  ' + t + ': the plate goes 2.4 -> ' + (2.4 + 2 * t).toFixed(1) + ', the strap stays 0.6 (its top is an inner face), closed',
      r.ok && Math.abs(plate - (2.4 + 2 * t)) < 1e-5 && Math.abs(strap - 0.6) < 1e-5 && closed(r.tris), r.ok ? '' : r.reason);
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
