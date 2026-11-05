/* The Cut card's Whole plate blade: the planning core and the cut it hands to the app's own engine.
     node tools/nso_cut_plate_test.js    exit 0 = every gate held

   THE ASK. Print-testing a plate of pieces that share a long pillar means printing the pillar every time. One level
   blade across the plate, on a height slider, shortens every piece the same amount: Keep above drops what is under
   the blade and sets the rest back down on the bed.

   GATES (nso_cut_plate.js, with app-cut.js's cutOneSide as the engine, in a bare context - no browser)
     1. plan: the blade height is mm above the bed. A piece it crosses with 1 mm to spare each end is cut; a piece lower
        than the blade, a lifted one it passes under, a blade within 1 mm of the foot or the top: left alone, with the
        reason said.
     2. Keep above on a T (pillar + slab): every vertex of the kept part is up where it was less the drop, its foot is
        on the same level the piece's was, the height is the piece's less the blade's, and the volume is the piece's
        less the pillar slice taken - and it is closed (0 open, 0 non-manifold edges).
     3. Keep below: the same blade the other way up - the feet kept, the volume the pillar slice that stays.
     4. Keep above + Keep below at one height add back to the piece (volume), and the two cut faces are the same
        section.
     5. A blade through the slab, not the pillar: the cut face is the whole slab's section.
     6. A standing tube: the cut face is an annulus (the bore stays open), volume to the formula.
     7. planPlate / heightRange: counts, ranges and the readout's numbers; the slider's top always cuts something.
     8. The float32 move: the shifted soup is float32, and equal inputs give equal outputs (so two vertices that met
        still meet).                                                                                                  */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Float32Array,
  Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer, Error, Infinity, NaN };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-cut.js'), 'utf8'), ctx, { filename: 'app-cut.js' });
const { cutOneSide } = ctx;
const P = require(path.join(ROOT, 'nso_cut_plate.js'));

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 1e-3 : tol);

const { tee, tube, volume, census, bounds, planeArea } = require('./nso_cut_plate_pieces');

console.log('1. plan: where the blade cuts and where it does not');
{
  const T = tee(10, 4);                                     // 14 tall
  const at = (h, o) => P.plan(T, Object.assign({ height: h, keep: 'above' }, o || {}));
  const a = at(4);
  check('blade at 4 on a 14 tall piece cuts', a.cut && near(a.plane, 4) && near(a.removed, 4) && near(a.after, 10) && near(a.drop, 4),
    JSON.stringify({ plane: a.plane, removed: a.removed, after: a.after, drop: a.drop }));
  const b = at(4, { keep: 'below' });
  check('keep below: the plane is the same, the top goes', b.cut && near(b.plane, 4) && near(b.removed, 10) && near(b.after, 4) && b.drop === 0);
  check('lower than the blade: untouched, and says so', !at(20).cut && /lower than the blade/.test(at(20).why), at(20).why);
  check('a blade 0.5 mm up the foot: untouched', !at(0.5).cut && /1 mm up its foot/.test(at(0.5).why), at(0.5).why);
  check('a blade 0.5 mm from the top: untouched', !at(13.5).cut && /1 mm from its top/.test(at(13.5).why), at(13.5).why);
  check('exactly 1 mm each end is cut', at(1).cut && at(13).cut);
  const lifted = at(5, { liftY: 6 });
  check('a piece standing 6 mm up, blade at 5: untouched', !lifted.cut && /6\.0 mm up/.test(lifted.why), lifted.why);
  const l2 = at(8, { liftY: 6 });
  check('lifted 6, blade at 8: the blade is 2 mm up ITS foot (plane at foot + 2)', l2.cut && near(l2.plane, 2) && near(l2.removed, 2));
  check('the raw z of the foot is respected (a soup that starts at z 100)', (() => {
    const s = T.slice(); for (let i = 2; i < s.length; i += 3) s[i] += 100;
    const p = P.plan(s, { height: 4, keep: 'above' });
    return p.cut && near(p.plane, 104) && near(p.zmin, 100);
  })());
  check('an empty soup has no height', !P.plan(new Float32Array(0), { height: 4 }).cut);
}

console.log('2. Keep above on a T: shortened, foot on the same level, closed');
const T = tee(10, 4), tVol = volume(T);
{
  check('the test piece is closed and has the volume it should (pillar 5x5x10 + slab 14x5x4)',
    census(T).open === 0 && near(tVol, 5 * 5 * 10 + 14 * 5 * 4, 1e-3), 'volume ' + tVol.toFixed(3));
  const p = P.plan(T, { height: 4, keep: 'above' });
  const out = P.apply(T, p, cutOneSide);
  const bb = bounds(out), c = census(out);
  check('closed: 0 open, 0 non-manifold', c.open === 0 && c.nm === 0, JSON.stringify(c));
  check('the foot is on the level the piece\'s was (z 0)', near(bb.lo[2], 0, 1e-6), 'zmin ' + bb.lo[2]);
  check('the height is the piece\'s less the blade\'s: 14 - 4 = 10', near(bb.hi[2] - bb.lo[2], 10), 'z ' + bb.lo[2] + '..' + bb.hi[2]);
  check('x and y are untouched (the footprint is the same)', near(bb.lo[0], -7) && near(bb.hi[0], 7) && near(bb.lo[1], 0) && near(bb.hi[1], 5));
  check('volume = the piece less the pillar slice taken (5 x 5 x 4)', near(volume(out), tVol - 100, 1e-2), volume(out).toFixed(3) + ' vs ' + (tVol - 100));
  // every kept vertex is where it was, 4 mm down
  const zs = new Set(); for (let i = 2; i < out.length; i += 3) zs.add(+out[i].toFixed(3));
  check('the z levels left are the original ones less 4 (0, 6, 10) - nothing else', [...zs].sort((a, b) => a - b).join() === '0,6,10', [...zs].sort((a, b) => a - b).join());
}

console.log('3. Keep below: the feet kept');
{
  const p = P.plan(T, { height: 4, keep: 'below' });
  const out = P.apply(T, p, cutOneSide);
  const bb = bounds(out), c = census(out);
  check('closed', c.open === 0 && c.nm === 0, JSON.stringify(c));
  check('z 0..4, not moved', near(bb.lo[2], 0, 1e-6) && near(bb.hi[2], 4), 'z ' + bb.lo[2] + '..' + bb.hi[2]);
  check('volume = the pillar slice that stays (5 x 5 x 4)', near(volume(out), 100, 1e-2), volume(out).toFixed(3));
}

console.log('4. The two sides at one height add back to the piece');
{
  for (const h of [2.5, 7, 9.9, 11]) {
    const up = P.apply(T, P.plan(T, { height: h, keep: 'above' }), cutOneSide);
    const dn = P.apply(T, P.plan(T, { height: h, keep: 'below' }), cutOneSide);
    check('blade ' + h + ': volumes add back (' + (volume(up) + volume(dn)).toFixed(3) + ' vs ' + tVol.toFixed(3) + ')',
      near(volume(up) + volume(dn), tVol, 1e-2) && census(up).open === 0 && census(dn).open === 0);
  }
  const pa = P.plan(T, { height: 4, keep: 'above' }), pb = P.plan(T, { height: 4, keep: 'below' });
  const up = P.apply(T, pa, cutOneSide), dn = P.apply(T, pb, cutOneSide);
  check('the cut faces are the same section (25 mm2 of pillar), the upper\'s now the foot', near(planeArea(up, 0), 25, 1e-3) && near(planeArea(dn, Math.fround(4)), 25, 1e-3),
    planeArea(up, 0) + ' / ' + planeArea(dn, Math.fround(4)));
}

console.log('5. A blade through the slab');
{
  const p = P.plan(T, { height: 12, keep: 'above' });
  const out = P.apply(T, p, cutOneSide);
  check('the kept part is the top 2 mm of the slab: 14 x 5 x 2, closed', near(volume(out), 140, 1e-2) && census(out).open === 0 && census(out).nm === 0, volume(out).toFixed(3));
  check('its foot is on the level the piece\'s was', near(bounds(out).lo[2], 0, 1e-6) && near(planeArea(out, 0), 70, 1e-3), 'face ' + planeArea(out, 0));
}

console.log('6. A standing tube: the bore stays open');
{
  const n = 48, Tu = tube(12, n), vol = volume(Tu);
  const polyArea = r => n * r * r * Math.sin(2 * Math.PI / n) / 2;
  const ann = polyArea(6) - polyArea(4);
  check('the test tube is closed and its volume the annulus x 12', census(Tu).open === 0 && near(vol, ann * 12, 1e-2), vol.toFixed(3) + ' vs ' + (ann * 12).toFixed(3));
  const out = P.apply(Tu, P.plan(Tu, { height: 5, keep: 'above' }), cutOneSide);
  check('closed', census(out).open === 0 && census(out).nm === 0, JSON.stringify(census(out)));
  check('7 mm tall, on the foot\'s level', near(bounds(out).lo[2], 0, 1e-6) && near(bounds(out).hi[2], 7));
  check('the cut face is the annulus - the bore is not lidded', near(planeArea(out, 0), ann, 1e-2), planeArea(out, 0).toFixed(3) + ' vs ' + ann.toFixed(3));
  check('volume = annulus x 7', near(volume(out), ann * 7, 1e-2), volume(out).toFixed(3));
}

console.log('7. The plate: counts, readout numbers, the slider\'s range');
{
  const pieces = [
    { id: 1, name: 'tall', raw: tee(10, 4), liftY: 0 },          // 14
    { id: 2, name: 'tube', raw: tube(12, 24), liftY: 0 },        // 12
    { id: 3, name: 'stub', raw: tee(2, 2), liftY: 0 },           // 4
    { id: 4, name: 'floating', raw: tee(10, 4), liftY: 20 }      // 14 up at 20
  ];
  const plan = P.planPlate(pieces, { height: 5, keep: 'above' });
  check('4 pieces on the plate, 2 cut; the stub is lower than the blade, the floating one is passed under',
    plan.total === 4 && plan.cut === 2 && plan.untouched.map(u => u.name).join() === 'stub,floating', plan.untouched.map(u => u.name + ': ' + u.why).join(' | '));
  check('removed 5 each; tallest counted with its lift (34)', near(plan.removedMin, 5) && near(plan.removedMax, 5) && near(plan.tallest, 34), 'tallest ' + plan.tallest);
  const r = P.heightRange(pieces);
  check('the slider runs from 1 to the tallest less 1 (33, the lifted one stands to 34)', near(r.lo, 1) && near(r.hi, 33) && r.ok, JSON.stringify(r));
  const r2 = P.heightRange([{ id: 1, raw: tee(10, 4), liftY: 0 }]);
  check('on 14 tall it runs 1 .. 13, and 13 still cuts', near(r2.hi, 13) && P.plan(tee(10, 4), { height: r2.hi, keep: 'above' }).cut);
  check('a piece 1.5 tall has no room for a blade: ok false', !P.heightRange([{ id: 1, raw: tee(1, 0.5), liftY: 0 }]).ok);
  check('range input (no soup) agrees with the soup', (() => {
    const a = P.planPlate([{ id: 1, name: 'x', raw: tee(10, 4) }], { height: 6, keep: 'above' });
    const b = P.planPlate([{ id: 1, name: 'x', range: P.zRange(tee(10, 4)) }], { height: 6, keep: 'above' });
    return JSON.stringify(a.plans[0].plan) === JSON.stringify(b.plans[0].plan);
  })());
  check('snap to 0.1', P.snap(4.04) === 4 && P.snap(4.06) === 4.1);
}

console.log('8. The float32 move');
{
  const s = Float32Array.from([0.1, 0.2, 5.3, 1, 2, 5.3, 0.1, 0.2, 5.3]);
  const m = P.shiftZ(s, 4.1);
  check('float32 out', m instanceof Float32Array && m.length === s.length);
  check('equal inputs give equal outputs (two vertices that met still meet)', m[2] === m[8] && m[2] === m[5] && m[2] === Math.fround(Math.fround(5.3) - 4.1));
  check('x and y are not touched', m[0] === s[0] && m[1] === s[1] && m[3] === s[3] && m[4] === s[4]);
  check('the source is left alone', s[2] === Math.fround(5.3));
}

console.log(fails ? '\n' + fails + ' gate(s) FAILED' : '\nall gates held');
process.exit(fails ? 1 : 0);
