#!/usr/bin/env node
/* The GUN (nso_foam_gun.js): point into a gap, it fills plate to face.
   In Node, with the vendored kernel (vendor/manifold).

     node tools/nso_foam_gun_test.js       exit 0 = every gate held

   GATES
     1. a through-slot in a block: one shot fills it plate to face, the exact
        prism's volume, one closed solid, genus down by one
     2. a slot closed at the bottom: floor to face; closed at the top: plate to
        ceiling; a slot in the middle of a wall: floor to ceiling
     3. a chamber behind a 0.4 mm mouth: filled, its mouth closed flush with the
        outside; nothing past the piece's own box
     4. amount 50: half the height, half the volume
     5. a click in open air, a click above the piece: refused in words, the soup
        handed back as it went in
     6. float noise on the top and bottom faces (2e-5 mm): fills as if flat
     7. a painted wall the foam fills against stands it down; paint elsewhere does not
     8. fixtures/welded_gaps.stl (a welded part: float-noise faces, needles, a
        wall pinched to nothing, a hairline crack): its four gaps, shot one after
        another, each closed, ending with no hole through it (genus 0)
     9. the hairline slit left where the crack reached the outside: a click on the
        top face beside it (reach) fills it out to its flared mouth
    10. the notch's outer channel (its mouth shut at its narrowest by the notch
        shot): a shot into it bridges the arm's end to the S-curve
    11. FLOAT: a step between two welded faces (a ramp to the high corner), a
        V-groove down a wall, a pit in a top face, refusals, and
        fixtures/welded_step.stl's seam
*/
'use strict';
const path = require('path');
const { readSTL } = require('./nso_stl_io.js');
const GUN = require('../nso_foam_gun.js');
const FOAM = require('../nso_foam.js');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const FAILED = [];
function check(name, cond, detail) {
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined ? '   ' + detail : ''));
  if (cond) pass++; else { fail++; FAILED.push(name); }
}
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-12, Math.abs(b));
function vol(s) {
  let v = 0;
  for (let o = 0; o + 8 < s.length; o += 9) {
    v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7]) - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6]) +
         s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]);
  }
  return v / 6;
}
function bounds(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], s[i + a]); hi[a] = Math.max(hi[a], s[i + a]); }
  return { lo, hi };
}

(async function main() {
  const W = await (await import(path.join(ROOT, 'vendor', 'manifold', 'manifold.js'))).default();
  W.setup();
  const { Manifold } = W;
  const soupOf = m => {
    const mesh = m.getMesh(), tv = mesh.triVerts, vp = mesh.vertProperties, np = mesh.numProp, out = new Float32Array(tv.length * 3);
    for (let i = 0; i < tv.length; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = vp[tv[i] * np + k];
    return out;
  };
  const box = (sx, sy, sz, x, y, z) => Manifold.cube([sx, sy, sz], true).translate([x, y, z]);
  const block = () => box(40, 30, 20, 0, 0, 10);                      // z 0..20, the plate at 0
  const minus = (a, ...cut) => { let m = a; for (const c of cut) m = m.subtract(c); return soupOf(m); };
  const genus = s => { const n = s.length / 3, vp = Float32Array.from(s), tv = Uint32Array.from({ length: n }, (_, i) => i);
    const mesh = new W.Mesh({ numProp: 3, vertProperties: vp, triVerts: tv }); mesh.merge(); return new Manifold(mesh).genus(); };
  /* a shot at (x, y, z), from +x toward -x, hitting a wall at x */
  const shot = (soup, x, y, z, opts) => GUN.spray({ rawTris: soup, skipList: (opts && opts.skip) || [] },
    { point: [x, y, z], dir: [-1, 0, 0] }, Object.assign({ wasm: W }, opts || {}));
  function gateSolid(tag, src, r, expect, tol) {
    check(tag + ': set', r.ok && r.changed, r.reason);
    if (!(r.ok && r.changed)) return;
    const cs = FOAM.census(r.mesh);
    check(tag + ': closed, 2-manifold, nothing collapsed', cs.closed && !cs.degen, JSON.stringify(cs));
    check(tag + ': the piece gained the volume it says', Math.abs(vol(r.mesh) - vol(src) - r.addedVolume) < 1e-3,
          (vol(r.mesh) - vol(src)).toFixed(4) + ' vs ' + r.addedVolume.toFixed(4));
    if (expect != null) check(tag + ': added = the closed form', rel(r.addedVolume, expect) < (tol || 1e-4), r.addedVolume.toFixed(3) + ' vs ' + expect);
    const B0 = bounds(src), B1 = bounds(r.mesh);
    check(tag + ': nothing past the piece\'s own box', [0, 1, 2].every(a => B1.lo[a] >= B0.lo[a] - 1e-4 && B1.hi[a] <= B0.hi[a] + 1e-4));
  }

  console.log('\n== 1. a through-slot ==');
  const slot = minus(block(), box(20, 2, 30, 0, 0, 10));            // x -10..10, y -1..1, through
  const r1 = await shot(slot, -9, 0, 10);                           // seed just before the wall at x = -10... aim from inside the slot
  gateSolid('through-slot', slot, r1, 20 * 2 * 20);
  check('...plate to face', r1.reachesPlate && r1.reachesFace && r1.bridge === 0, JSON.stringify({ p: r1.reachesPlate, f: r1.reachesFace, b: r1.bridge }));
  check('...the hole through it is gone (genus 1 -> 0)', genus(slot) === 1 && genus(r1.mesh) === 0);
  check('...one prism: the words say plate to face', /from the plate to the face/.test(r1.reason), r1.reason);

  console.log('\n== 2. closed at one end, or both ==');
  const fromTop = minus(block(), box(20, 2, 12, 0, 0, 20));         // z 14..20 open at the top... depth 6
  const r2 = await shot(fromTop, -9, 0, 17);
  gateSolid('a slot open at the top only', fromTop, r2, 20 * 2 * 6);
  check('...floor to face', !r2.reachesPlate && r2.reachesFace, r2.reason);
  const fromBottom = minus(block(), box(20, 2, 12, 0, 0, 0));       // z 0..6, open at the plate
  const r3 = await shot(fromBottom, -9, 0, 3);
  gateSolid('a slot open at the plate only', fromBottom, r3, 20 * 2 * 6);
  check('...plate to ceiling', r3.reachesPlate && !r3.reachesFace, r3.reason);
  const sideways = minus(block(), box(20, 2, 30, 0, 14.5, 10));     // a groove y 13.5..15 along the +y face, 20 mm wide: open air
  const rs = await shot(sideways, -9, 14, 10);
  check('a 20 mm-wide, 1.5 mm-deep groove in the outside wall is not a gap: refused, not filled', !rs.ok && rs.kind === 'air', rs.reason);

  console.log('\n== 3. a chamber behind a 0.4 mm mouth ==');
  const chamber = box(10, 4, 30, 0, 5, 10), mouth = box(0.4, 10, 30, 0, 12, 10);   // mouth y 7..17 runs out of the +y wall (15)
  const notched = minus(block(), chamber, mouth);
  const r4 = await shot(notched, -4, 5, 10);
  gateSolid('the chamber', notched, r4, 20 * (10 * 4 + 0.4 * 8), 0.01);
  check('...its mouth closed flush with the outside (bridge > 0, said so)', r4.bridge > 0 && /mouth \(under 0\.4 mm at its narrowest\) closed flush/.test(r4.reason), r4.reason);
  check('...the piece is a plain block again (volume 40 x 30 x 20)', r4.ok && rel(vol(r4.mesh), 24000) < 0.002, r4.ok && vol(r4.mesh).toFixed(2));

  console.log('\n== 4. amount 50 ==');
  const r5 = await shot(slot, -9, 0, 10, { amount: 50 });
  gateSolid('half a spray', slot, r5, 20 * 2 * 10);
  check('...the level is half way up', r5.ok && Math.abs(r5.level - 10) < 1e-6, r5.level);

  console.log('\n== 5. refusals ==');
  const r6 = await shot(slot, 30, 0, 10);
  check('a click in open air: refused, in words, nothing changed', !r6.ok && r6.kind === 'air' && r6.mesh === slot && /not in a gap/.test(r6.reason), r6.reason);
  const r7 = await GUN.spray({ rawTris: slot }, { point: [0, 0, 25], dir: [0, 0, -1] }, { wasm: W });
  check('a click above the piece: refused, in words', !r7.ok && r7.kind === 'air' && /above or below/.test(r7.reason), r7.reason);

  console.log('\n== 6. float noise on the flat faces ==');
  const noisy = new Float32Array(slot), nudge = new Map();
  for (let i = 0; i < noisy.length; i += 3) {
    const k = noisy[i] + ',' + noisy[i + 1] + ',' + noisy[i + 2];
    if (!nudge.has(k)) nudge.set(k, (((nudge.size * 7919) % 11) - 5) * 4e-6);
    noisy[i + 2] = Math.fround(noisy[i + 2] + nudge.get(k));
  }
  const r8 = await shot(noisy, -9, 0, 10);
  gateSolid('the slot, its faces float noise', noisy, r8, 20 * 2 * 20, 1e-3);
  check('...still plate to face', r8.reachesPlate && r8.reachesFace);

  console.log('\n== 7. paint ==');
  let wallT = -1, farT = -1;
  for (let t = 0; t < slot.length / 9; t++) {
    const o = t * 9, xs = [slot[o], slot[o + 3], slot[o + 6]], ys = [slot[o + 1], slot[o + 4], slot[o + 7]];
    if (wallT < 0 && xs.every(x => Math.abs(x + 10) < 1e-5) && ys.every(y => Math.abs(y) <= 1 + 1e-5)) wallT = t;   // the slot's end wall
    if (farT < 0 && xs.every(x => Math.abs(x + 20) < 1e-5)) farT = t;                                                  // the block's outside
  }
  const r9 = await shot(slot, -9, 0, 10, { skip: [wallT] });
  check('a painted wall of the slot stands the gun down, in words', !r9.ok && r9.kind === 'painted' && r9.mesh === slot, r9.reason);
  const r10 = await shot(slot, -9, 0, 10, { skip: [farT] });
  check('paint on the block\'s outside does not', r10.ok && r10.changed, r10.reason);

  console.log('\n== 8. fixtures/welded_gaps.stl: four gaps, four shots ==');
  let soup = readSTL(path.join(ROOT, 'fixtures', 'welded_gaps.stl'));
  const g0 = genus(soup);
  const shots = [['the long slot', -9.6881, -3.4119, 1043.6], ['the bottom slot', -5.2702, -16.1904, 139.5],
                 ['the hairline crack', 1.7562, -16.3471, null], ['the notch (0.4 mm mouth)', -15.0237, 7.323, null]];
  for (const [name, x, y, expect] of shots) {
    const t0 = Date.now();
    const r = await GUN.spray({ rawTris: soup, skipList: [] }, { point: [x - 0.02, y, 0], dir: [-1, 0, 0] }, { wasm: W });
    const cs = r.ok && r.changed ? FOAM.census(r.mesh) : null;
    check(name + ': set, closed and 2-manifold (' + (Date.now() - t0) + ' ms)', r.ok && r.changed && cs.closed && cs.open === 0 && cs.nm === 0, r.reason);
    if (expect != null) check('...' + Math.round(expect) + ' mm³, its cross-section times the height', r.ok && rel(r.addedVolume, expect) < 0.01, r.ok && r.addedVolume.toFixed(1));
    if (r.ok && r.changed) soup = r.mesh;
  }
  check('the welded part: two holes through it before (genus ' + g0 + '), none after', g0 === 2 && genus(soup) === 0, genus(soup));

  console.log('\n== 9. the hairline slit the crack left to the outside (welded_gaps.stl, after the four shots) ==');
  /* About 0.9 mm long and 0.01-0.05 mm wide, flaring to the outside at (2.25, -18.8):
     thinner than the seed's step off its wall, and shut by a 0.01 mm closing at its
     narrowest. Seen from above, a click lands on the top face beside it. */
  const t9 = Date.now();
  const r9b = await GUN.spray({ rawTris: soup, skipList: [] }, { point: [2.14, -18.2, 13.55], dir: [0, 0, -1], reach: 0.05 }, { wasm: W });
  const cs9 = r9b.ok && r9b.changed ? FOAM.census(r9b.mesh) : null;
  check('a click on the top face 0.05 mm from it finds it, and fills it plate to face, closed (' + (Date.now() - t9) + ' ms)',
        r9b.ok && r9b.changed && cs9.closed && !cs9.degen && r9b.reachesPlate && r9b.reachesFace, r9b.reason);
  check('...out to its flared mouth, not just its narrowest point: 0.6 mm³ (0.023 mm² x 27.1 mm)', r9b.ok && r9b.addedVolume > 0.5 && r9b.addedVolume < 0.75,
        r9b.ok && r9b.addedVolume.toFixed(3));
  check('...and says so in numbers that are not 0', /0\.6\d mm³/.test(r9b.reason) && /under 0\.0\d+ mm at its narrowest/.test(r9b.reason), r9b.reason);
  const r9c = await GUN.spray({ rawTris: soup, skipList: [] }, { point: [2.6, -18.2, 13.55], dir: [0, 0, -1], reach: 0.1 }, { wasm: W });
  check('a click on the top face 0.4 mm from it is not a gap', !r9c.ok && r9c.kind === 'air', r9c.reason);
  if (r9b.ok && r9b.changed) soup = r9b.mesh;

  console.log('\n== 10. the notch\'s outer channel: from where its mouth was shut out to the arm\'s end ==');
  /* The notch shot shuts its 0.4 mm mouth at its narrowest (y 10.1). Above that a
     channel 0.3-0.6 mm wide runs 4 mm up between the arm tip's edge and the
     S-curve, open at the top: the outline's last curve. A shot into it takes it
     out to where the arm ends - the closing grows gently step by step there (1.74,
     1.85, 1.91, 1.96 mm²) - and the arm's edge then runs on into the S-curve. */
  const rCh = await GUN.spray({ rawTris: soup, skipList: [] }, { point: [-3.88, 12.3, 0], dir: [-1, 0, 0], reach: 0.05 }, { wasm: W });
  const csCh = rCh.ok && rCh.changed ? FOAM.census(rCh.mesh) : null;
  check('a shot into the channel fills it plate to face, closed', rCh.ok && rCh.changed && csCh.closed && !csCh.degen && rCh.reachesPlate && rCh.reachesFace, JSON.stringify(csCh));
  check('...out to the arm\'s end: about 2 mm² x 27.1 mm (50-60 mm³)', rCh.ok && rCh.addedVolume > 50 && rCh.addedVolume < 60, rCh.ok && rCh.addedVolume.toFixed(1));
  check('...its mouth named at its narrowest, not the closing that took it out', rCh.ok && /under 0\.8 mm at its narrowest/.test(rCh.reason), rCh.reason);
  if (rCh.ok && rCh.changed) {
    const again = await GUN.spray({ rawTris: rCh.mesh, skipList: [] }, { point: [-3.88, 12.3, 0], dir: [-1, 0, 0], reach: 0.05 }, { wasm: W });
    check('...and nothing is left there: the same shot again finds no gap', !(again.ok && again.changed && again.addedVolume > 0.5), again.reason);
  }

  console.log('\n== 11. FLOAT: two points, a straight edge resting on the high spots ==');
  const fl = (soup, a, an, b, bn, opts) => GUN.float({ rawTris: soup, skipList: [] }, { point: a, normal: an }, { point: b, normal: bn }, Object.assign({ wasm: W }, opts || {}));
  function gateFloat(tag, src, r, expect, tol) {
    check(tag + ': set', r.ok && r.changed, r.reason);
    if (!(r.ok && r.changed)) return;
    const cs = FOAM.census(r.mesh);
    check(tag + ': closed, 2-manifold, nothing collapsed', cs.closed && !cs.degen, JSON.stringify(cs));
    check(tag + ': gained the volume it says, and lost none (Float never cuts)', Math.abs(vol(r.mesh) - vol(src) - r.addedVolume) < 1e-3 && r.addedVolume > 0,
          (vol(r.mesh) - vol(src)).toFixed(4) + ' vs ' + r.addedVolume.toFixed(4));
    if (expect != null) check(tag + ': added = the closed form', rel(r.addedVolume, expect) < (tol || 0.02), r.addedVolume.toFixed(4) + ' vs ' + expect);
    const B0 = bounds(src), B1 = bounds(r.mesh);
    check(tag + ': nothing past the piece\'s own box', [0, 1, 2].every(a => B1.lo[a] >= B0.lo[a] - 1e-4 && B1.hi[a] <= B0.hi[a] + 1e-4));
  }
  /* Two blocks welded side by side, the right one's front 0.05 mm proud: a step at x = 0. */
  const stepped = soupOf(box(20, 10, 20, -10, 5, 10).add(box(20, 10.05, 20, 10, 4.975, 10)));    // fronts at y = 0 and y = -0.05
  const rf = await fl(stepped, [-6, 0, 15], [0, -1, 0], [8, -0.05, 4], [0, -1, 0]);
  gateFloat('a step between two welded faces, points 6 mm and 8 mm either side', stepped, rf, 0.5 * 6 * 0.05 * 20);
  check('...a wall floats up the wall, whatever height each point was clicked at', rf.ok && rf.along && rf.along[2] === 1 && rf.reachesPlate && rf.reachesFace,
        JSON.stringify(rf.along));
  check('...and the edge rests on the high corner, not the line to the second point: the ramp ends at the step', rf.ok && rel(rf.addedVolume, 3) < 0.02,
        rf.ok && rf.addedVolume.toFixed(3) + ' (to the step: 6 x 0.05 / 2 x 20 = 3; the line to the second point would give 1.29)');
  /* A V-groove 1 mm wide, 0.3 mm deep, down the whole front wall. */
  const groove = soupOf(box(20, 10, 20, 0, 5, 10).subtract(W.Manifold.cylinder(30, 0.6, 0.6, 3).rotate([0, 0, 90]).translate([0, -0.3, -5])));
  const blockVol = vol(soupOf(box(20, 10, 20, 0, 5, 10)));
  const rg = await fl(groove, [-3, 0, 10], [0, -1, 0], [3, 0, 2], [0, -1, 0]);
  gateFloat("a V-groove down a wall, points either side of it", groove, rg, blockVol - vol(groove), 0.01);
  /* A pit in the top face: 2 x 2 mm, 0.3 deep. */
  const pit = soupOf(box(20, 10, 20, 0, 5, 10).subtract(box(2, 2, 0.6, 0, 5, 20)));
  const rp = await fl(pit, [-3, 5, 20], [0, 0, 1], [3, 5, 20], [0, 0, 1]);
  gateFloat('a pit in the top face, points either side across it', pit, rp, 2 * 2 * 0.3, 0.01);
  check('...a face floats across itself, square to the edge', rp.ok && rp.along && Math.abs(rp.along[1]) === 1, JSON.stringify(rp.along));
  const rflat = await fl(groove, [5, 0, 10], [0, -1, 0], [9, 0, 10], [0, -1, 0]);
  check('two points on a flat wall: nothing to float, in words', !rflat.ok && rflat.kind === 'flat' && rflat.mesh === groove && /already straight or proud/.test(rflat.reason), rflat.reason);
  const rnear = await fl(groove, [5, 0, 10], [0, -1, 0], [5.01, 0, 10], [0, -1, 0]);
  check('two points on top of each other: refused, in words', !rnear.ok && /too close together/.test(rnear.reason), rnear.reason);
  /* fixtures/welded_step.stl: two blocks welded with their fronts 0.054 mm apart at x = -10. */
  const ws = readSTL(path.join(ROOT, 'fixtures', 'welded_step.stl'));
  const t11 = Date.now();
  const rws = await fl(ws, [-12, -15.036, 5], [0, -1, 0], [-8, -15.09, -3], [0, -1, 0]);
  /* The oracle: the section at mid-height in shapely - the hull of the piece in
     the strip between the points, less the piece - 0.05063 mm² - x 38.52 mm. */
  gateFloat('welded_step.stl: the seam between the two fronts (' + (Date.now() - t11) + ' ms)', ws, rws, 0.050634 * 38.52, 0.02);

  for (const [name, a, an, b, bn] of [['the right block\'s even front face', [-8, -15.09, 5], [0, -1, 0], [-4, -15.09, -2], [0, -1, 0]],
                                       ['the left block\'s even top face', [-14, -10, 19.24], [0, 0, 1], [-11, 5, 19.24], [0, 0, 1]]]) {
    const r = await fl(ws, a, an, b, bn);
    check('welded_step.stl: two points on ' + name + ' - nothing to float, nothing changed (its float noise is not a dip)',
          !r.ok && r.kind === 'flat' && r.mesh === ws, r.reason);
  }

  console.log('\npassed ' + pass + ' check(s), ' + fail + ' failure(s)');
  if (fail) { FAILED.forEach(n => console.log('  FAILED: ' + n)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
