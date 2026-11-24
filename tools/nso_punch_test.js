#!/usr/bin/env node
// Headless self-test for nso_punch.js (Punch). docs/PUNCH.md.
//
//   node tools/nso_punch_test.js        exit 0 = every gate held
//
// nso_punch.js is required as it ships (it is THREE-free); the boolean in
// gates 1 and 2 is the shipped one: tools/nso_csg_node.js runs nso_csg.js in
// a vm, so the cutters go through the same NSO_subtractSoups the app calls.
// Volumes are measured on the kernel's OUTPUT soup, not on the plan.
//
//   1. one through hole in a 10 mm slab: depth reads 10.4, the axis +Z; the
//      cutter is closed and wound outward, and the slab loses exactly its
//      prism
//   2. a 3 x 4 grid at 8 mm pitch, centred on a 40 x 40 slab: 12 holes, every
//      axis +Z, u along +X; all twelve cut in ONE subtract
//   3. the same grid anchored at a corner: its fourth column lands 5 mm past
//      the slab's edge - those 3 holes dropped and said, the other 9 kept
//   4. radial: 6 holes on R 12, the first along u, 60 degrees apart
//   5. a 2 x 3 grid on a faceted tube's outside: every axis radial within
//      0.5 degrees, each hole through both walls
//   6. the wall floor, in words with the numbers: two holes 0.5 mm apart, a
//      hole 0.5 mm from the edge, a blind hole over a 0.5 mm skin; 0.9 mm
//      passes; the piece is untouched by any plan
//   7. the option refusals, and the cutter's side count

'use strict';

const P = require('../nso_punch.js');
const { csgContext } = require('./nso_csg_node.js');

let fails = 0;
const rows = [];
function gate(name, ok, detail) {
  rows.push([ok ? 'PASS' : 'FAIL', name, detail || '']);
  if (!ok) fails++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -  ' + detail : ''));
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const angDeg = (a, b) => {
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / Math.hypot(...a) / Math.hypot(...b);
  return Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
};

/* ---------------------------------------------------------------- fixtures */
function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const o = [];
  for (const t of f) for (const i of t) o.push(...v[i]);
  return new Float32Array(o);
}
/* A tube along X, x in [0, Lx], outer radius R, bore r, m facets. */
function tube(R, r, Lx, m) {
  const o = [];
  const tri = (a, b, c) => o.push(...a, ...b, ...c);
  const at = (rad, k, x) => { const a = 2 * Math.PI * k / m; return [x, rad * Math.cos(a), rad * Math.sin(a)]; };
  for (let k = 0; k < m; k++) {
    const k1 = k + 1;
    const o0 = at(R, k, 0), o1 = at(R, k1, 0), O0 = at(R, k, Lx), O1 = at(R, k1, Lx);
    const i0 = at(r, k, 0), i1 = at(r, k1, 0), I0 = at(r, k, Lx), I1 = at(r, k1, Lx);
    tri(o0, o1, O1); tri(o0, O1, O0);          // outside, outward
    tri(i0, I1, i1); tri(i0, I0, I1);          // bore, facing the axis
    tri(o0, i1, o1); tri(o0, i0, i1);          // the x = 0 annulus, facing -X
    tri(O0, O1, I1); tri(O0, I1, I0);          // the x = Lx annulus, facing +X
  }
  return new Float32Array(o);
}
function volume(s) {
  let v = 0;
  for (let i = 0; i < s.length; i += 9) {
    v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) +
         s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
  }
  return v / 6;
}
/* Every edge used exactly twice, once each way: closed and consistently wound. */
function closed(s) {
  const k = (i) => s[i].toFixed(5) + ',' + s[i + 1].toFixed(5) + ',' + s[i + 2].toFixed(5);
  const e = new Map();
  for (let t = 0; t < s.length; t += 9) {
    for (let c = 0; c < 3; c++) {
      const a = k(t + 3 * c), b = k(t + 3 * ((c + 1) % 3));
      e.set(a + '>' + b, (e.get(a + '>' + b) || 0) + 1);
    }
  }
  for (const [key, n] of e) {
    const [a, b] = key.split('>');
    if (n !== 1 || e.get(b + '>' + a) !== 1) return false;
  }
  return true;
}
/* The cross-section of an m-sided cutter whose flats are at r. */
const polyArea = (dia) => { const m = P.sidesFor(dia), rv = dia / 2 / Math.cos(Math.PI / m); return m / 2 * rv * rv * Math.sin(2 * Math.PI / m); };
function concat(list) {
  const out = new Float32Array(list.reduce((n, s) => n + s.length, 0));
  let q = 0;
  for (const s of list) { out.set(s, q); q += s.length; }
  return out;
}
const fingerprint = (s) => { let a = 0; for (let i = 0; i < s.length; i++) a += s[i] * ((i % 97) + 1); return s.length + ':' + a; };

(async function main() {
  const csg = csgContext();

  /* 1 --------------------------------------------------------------- */
  {
    const slab = box([0, 0, 0], [40, 40, 10]);
    const pl = P.plan(slab, { point: [20, 20, 10], normal: [0, 0, 1] }, { diaMm: 3 });
    const H = pl.holes[0] || {};
    gate('1a one through hole', pl.ok && pl.holes.length === 1, pl.reason);
    gate('1b depth reads back 10.4 (10 + 0.2 each end)', near(H.depth, 10.4, 1e-6), 'depth ' + H.depth);
    gate('1c axis +Z, centre the click', H.axis && angDeg(H.axis, [0, 0, 1]) < 1e-6 &&
      near(H.centre[0], 20, 1e-6) && near(H.centre[1], 20, 1e-6) && near(H.centre[2], 10, 1e-6),
      'axis ' + (H.axis || []).map(x => x.toFixed(6)).join(',') + ' centre ' + (H.centre || []).map(x => x.toFixed(3)).join(','));
    const cut = P.cutters(pl);
    const want = polyArea(3) * 10.4;
    gate('1d cutter: one soup, 24 sides at Ø3, closed, wound outward', cut.length === 1 && cut[0].length / 9 === 24 * 4 &&
      closed(cut[0]) && near(volume(cut[0]), want, 1e-3 * want),
      'tris ' + cut[0].length / 9 + ', volume ' + volume(cut[0]).toFixed(3) + ' (prism ' + want.toFixed(3) + ')');
    const before = fingerprint(slab);
    const res = await csg.NSO_subtractSoups(slab, cut[0]);
    const lost = volume(slab) - (res.soup ? volume(res.soup) : NaN), prism = polyArea(3) * 10;
    gate('1e the shipped subtract takes the hole out: the slab loses its 10 mm prism', res.ok && near(lost, prism, 1e-3 * prism),
      'lost ' + lost.toFixed(3) + ' mm3 of ' + prism.toFixed(3) + '; slab untouched by the boolean ' + (fingerprint(slab) === before));
  }

  /* 2 --------------------------------------------------------------- */
  {
    const slab = box([0, 0, 0], [40, 40, 5]);
    const pl = P.plan(slab, { point: [20, 20, 5], normal: [0, 0, 1] },
      { diaMm: 3, pattern: 'grid', rows: 3, cols: 4, pitchX: 8, pitchY: 8, anchor: 'centre' });
    const xs = [...new Set(pl.holes.map(h => h.centre[0].toFixed(3)))].sort((a, b) => a - b);
    const ys = [...new Set(pl.holes.map(h => h.centre[1].toFixed(3)))].sort((a, b) => a - b);
    gate('2a 3 x 4 grid -> 12 holes', pl.ok && pl.holes.length === 12 && pl.dropped === 0, pl.reason);
    gate('2b every axis +Z', pl.holes.every(h => angDeg(h.axis, [0, 0, 1]) < 1e-6));
    gate('2c 4 columns along u = +X at 8, 3 rows at 8, centred on the click',
      pl.frame && angDeg(pl.frame.u, [1, 0, 0]) < 1e-6 && xs.join() === '8.000,16.000,24.000,32.000' && ys.join() === '12.000,20.000,28.000',
      'x ' + xs.join(' ') + '  y ' + ys.join(' '));
    gate('2d holes numbered row-major from the anchor', pl.holes.map(h => h.n).join() === '1,2,3,4,5,6,7,8,9,10,11,12' &&
      pl.holes[1].centre[0] - pl.holes[0].centre[0] > 7.99 && pl.holes[4].centre[1] - pl.holes[0].centre[1] > 7.99);
    const res = await csg.NSO_subtractSoups(slab, concat(P.cutters(pl)));
    const lost = volume(slab) - (res.soup ? volume(res.soup) : NaN), want = 12 * polyArea(3) * 5;
    gate('2e all twelve cut in ONE subtract', res.ok && near(lost, want, 1e-3 * want),
      'lost ' + lost.toFixed(3) + ' of ' + want.toFixed(3) + ' mm3');
  }

  /* 3 --------------------------------------------------------------- */
  {
    const slab = box([0, 0, 0], [40, 40, 5]);
    // the corner hole at (21, 5): columns at x 21, 29, 37 and 45 - 5 mm past the x = 40 edge
    const pl = P.plan(slab, { point: [21, 5, 5], normal: [0, 0, 1] },
      { diaMm: 3, pattern: 'grid', rows: 3, cols: 4, pitchX: 8, pitchY: 8, anchor: 'corner' });
    gate('3a the overhanging column is dropped, the rest kept', pl.ok && pl.holes.length === 9 && pl.dropped === 3 &&
      pl.droppedHoles.join() === '4,8,12', 'holes ' + pl.holes.length + ', dropped ' + pl.droppedHoles);
    gate('3b ...and the reason says how many', /^3 holes of 12 fall off the face and were dropped \(4, 8, 12\)/.test(pl.reason), pl.reason);
    gate('3c the kept ones are the first three columns', pl.holes.every(h => h.centre[0] < 38 && h.centre[0] > 20));
  }

  /* 4 --------------------------------------------------------------- */
  {
    const slab = box([0, 0, 0], [60, 60, 5]);
    const c = [30, 30, 5];
    const pl = P.plan(slab, { point: c, normal: [0, 0, 1] }, { diaMm: 3, pattern: 'radial', n: 6, R: 12 });
    const ang = pl.holes.map(h => (Math.atan2(h.centre[1] - c[1], h.centre[0] - c[0]) * 180 / Math.PI + 360) % 360);
    const rad = pl.holes.map(h => Math.hypot(h.centre[0] - c[0], h.centre[1] - c[1]));
    gate('4a radial 6 -> 6 holes on R 12', pl.ok && pl.holes.length === 6 && rad.every(x => near(x, 12, 1e-6)), pl.reason);
    gate('4b the first at angle 0 (along u), then every 60 degrees', ang.every((a, i) => near(a, 60 * i, 1e-6) || near(a, 60 * i + 360, 1e-6)),
      ang.map(a => a.toFixed(2)).join(' '));
    gate('4c axes +Z, depth 5.4', pl.holes.every(h => angDeg(h.axis, [0, 0, 1]) < 1e-6 && near(h.depth, 5.4, 1e-6)));
  }

  /* 5 --------------------------------------------------------------- */
  {
    const R = 15, m = 64, T = tube(R, 11, 60, m), a = 75 * Math.PI / 180;
    const click = [30, R * Math.cos(a), R * Math.sin(a)];
    const pl = P.plan(T, { point: click, normal: [0, Math.cos(a), Math.sin(a)] },
      { diaMm: 3, pattern: 'grid', rows: 2, cols: 3, pitchX: 8, pitchY: 8, anchor: 'centre' });
    const errs = pl.holes.map(h => angDeg(h.axis, [0, h.centre[1], h.centre[2]]));
    gate('5a 2 x 3 grid on the tube -> 6 holes, u along the tube', pl.ok && pl.holes.length === 6 && angDeg(pl.frame.u, [1, 0, 0]) < 1e-6,
      pl.reason);
    gate('5b every axis radial within 0.5 degrees (the facets are 5.6 apart)', errs.length === 6 && errs.every(e => e < 0.5),
      'worst ' + Math.max(...errs).toFixed(4) + ' deg');
    // the gate can fail: the flat facet each footprint sits on is off radial by this much
    const step = 2 * Math.PI / m;
    const facet = pl.holes.map(h => {
      const t = Math.atan2(h.centre[2], h.centre[1]);
      return Math.abs(t - (Math.floor(t / step) + 0.5) * step) * 180 / Math.PI;
    });
    gate('5b\' ...where the facet normals are not: the worst footprint\'s facet is off by more than 0.5', Math.max(...facet) > 0.5,
      'facet error ' + facet.map(x => x.toFixed(2)).join(' ') + ' deg');
    gate('5c two rows apart round the tube, not stacked: their axes differ', pl.holes.length === 6 && angDeg(pl.holes[0].axis, pl.holes[3].axis) > 20,
      angDeg(pl.holes[0].axis, pl.holes[3].axis).toFixed(2) + ' deg');
    gate('5d each goes through both walls (2 spans, ~30 mm + 0.4)', pl.holes.every(h => h.spans.length === 2 && h.depth > 29.5 && h.depth < 30.5),
      pl.holes.map(h => h.spans.length + 'x ' + h.depth.toFixed(2)).join(', '));
  }

  /* 6 --------------------------------------------------------------- */
  {
    const slab = box([0, 0, 0], [40, 40, 5]);
    const before = fingerprint(slab);
    const pair = P.plan(slab, { point: [20, 20, 5], normal: [0, 0, 1] },
      { diaMm: 3, pattern: 'grid', rows: 1, cols: 2, pitchX: 3.5, anchor: 'centre' });
    gate('6a two holes 0.5 mm apart: refused, with the numbers', !pair.ok && pair.holes.length === 0 &&
      pair.reason === 'holes 1 and 2 would leave 0.5 mm between them; the floor is 0.8', pair.reason);
    const four = P.plan(slab, { point: [20, 20, 5], normal: [0, 0, 1] },
      { diaMm: 3, pattern: 'grid', rows: 1, cols: 4, pitchX: 3.5, anchor: 'centre' });
    gate('6b ...and how many other places are under it', !four.ok && /\(2 more places are under it too\)$/.test(four.reason), four.reason);
    const edge = P.plan(slab, { point: [2, 20, 5], normal: [0, 0, 1] }, { diaMm: 3 });
    gate('6c a hole 0.5 mm from the edge: refused, with the numbers', !edge.ok &&
      edge.reason === "hole 1 would leave 0.5 mm of wall to the piece's edge; the floor is 0.8", edge.reason);
    const over = P.plan(slab, { point: [1, 20, 5], normal: [0, 0, 1] }, { diaMm: 3 });
    gate('6d a hole over the edge: refused', !over.ok && /^hole 1 would break through the piece's edge/.test(over.reason), over.reason);
    const skin = P.plan(slab, { point: [20, 20, 5], normal: [0, 0, 1] }, { diaMm: 3, depth: 4.5 });
    gate('6e a blind hole over a 0.5 mm skin: refused', !skin.ok &&
      skin.reason === 'hole 1 would leave a 0.5 mm skin under it; the floor is 0.8', skin.reason);
    const blind = P.plan(slab, { point: [20, 20, 5], normal: [0, 0, 1] }, { diaMm: 3, depth: 3 });
    gate('6f a blind 3 mm hole over 2 mm: planned, depth 3.2', blind.ok && near(blind.holes[0].depth, 3.2, 1e-9), blind.reason);
    const ok = P.plan(slab, { point: [20, 20, 5], normal: [0, 0, 1] },
      { diaMm: 3, pattern: 'grid', rows: 1, cols: 2, pitchX: 3.9, anchor: 'centre' });
    const ok2 = P.plan(slab, { point: [2.4, 20, 5], normal: [0, 0, 1] }, { diaMm: 3 });
    gate('6g 0.9 mm between, 0.9 mm to the edge: planned', ok.ok && ok2.ok, ok.reason + ' / ' + ok2.reason);
    const nozzle = P.plan(slab, { point: [20, 20, 5], normal: [0, 0, 1] },
      { diaMm: 3, nozzle: 0.2, pattern: 'grid', rows: 1, cols: 2, pitchX: 3.5, anchor: 'centre' });
    gate('6h the floor is two nozzle widths: a 0.2 nozzle lets 0.5 mm through', nozzle.ok, nozzle.reason);
    gate('6i no plan touched the piece', fingerprint(slab) === before);
  }

  /* 7 --------------------------------------------------------------- */
  {
    const slab = box([0, 0, 0], [40, 40, 5]);
    const hit = { point: [20, 20, 5], normal: [0, 0, 1] };
    const r1 = P.plan(slab, hit, { diaMm: 0.5 });
    const r2 = P.plan(slab, hit, { countersink: 'cone' });
    const r3 = P.plan(slab, { point: [100, 100, 5], normal: [0, 0, 1] }, {});
    const r4 = P.plan(slab, hit, { pattern: 'grid', rows: 150, cols: 150, pitchX: 1, pitchY: 1 });   // 22,500 > 10,000
    gate('7a refusals in words', !r1.ok && /narrower than two nozzle widths/.test(r1.reason) && !r2.ok && /countersink/.test(r2.reason) &&
      !r3.ok && r3.reason === 'the click is not on this piece' && !r4.ok && /more than one punch makes/.test(r4.reason),
      [r1.reason, r2.reason, r3.reason, r4.reason].join(' | '));
    const sides = [1, 2, 2.5, 3, 5, 6, 10].map(P.sidesFor);
    gate('7b sides: 48 at Ø6 and up, fewer below, never under 16', sides.join() === '16,16,24,24,40,48,48', sides.join());
    const big = P.cutters(P.plan(slab, hit, { diaMm: 8 }))[0];
    gate('7c a Ø8 cutter has 48 sides and its flats at 4 mm', big.length / 9 === 48 * 4 && closed(big) &&
      near(volume(big), polyArea(8) * 5.4, 1e-3 * polyArea(8) * 5.4));
  }

  /* 8 --------------------------------------------------------------- */
  {
    // what the card (app-punch.js) draws and drags with
    const slab = box([0, 0, 0], [40, 40, 10]), hit = { point: [20, 20, 10], normal: [0, 0, 1] };
    const s1 = P.slide(slab, hit, 3, -2), s2 = P.slide(slab, hit, 30, 0);
    gate('8a slide moves the click along u and v on its face, and not off it', s1.ok && near(s1.point[0], 23, 1e-6) &&
      near(s1.point[1], 18, 1e-6) && near(s1.point[2], 10, 1e-6) && !s2.ok, JSON.stringify(s1.point) + ' / ' + s2.reason);
    const R = 15, T = tube(R, 11, 60, 64), a = 75 * Math.PI / 180;
    const th = { point: [30, R * Math.cos(a), R * Math.sin(a)], normal: [0, Math.cos(a), Math.sin(a)] };
    const s3 = P.slide(T, th, 0, 5);
    gate('8b ...on a tube, round it: still on the outside, the normal radial', s3.ok &&
      Math.abs(Math.hypot(s3.point[1], s3.point[2]) - R) < 0.02 && angDeg(s3.normal, [0, s3.point[1], s3.point[2]]) < 0.5,
      'r ' + (s3.point ? Math.hypot(s3.point[1], s3.point[2]).toFixed(3) : '-'));
    const grid = P.plan(slab, hit, { pattern: 'grid', rows: 2, cols: 2, pitchX: 8, pitchY: 8 });
    const tubeGrid = P.plan(T, th, { pattern: 'grid', rows: 2, cols: 1, pitchY: 8, anchor: 'centre' });
    gate('8c cutters meet only where they should: apart on a slab, crossing in a tube\'s bore',
      grid.ok && !P.cuttersOverlap(grid) && tubeGrid.ok && P.cuttersOverlap(tubeGrid));
    const bad = P.plan(slab, hit, { pattern: 'grid', rows: 1, cols: 2, pitchX: 3.5 });
    const over = P.plan(slab, { point: [37, 20, 10], normal: [0, 0, 1] }, { pattern: 'grid', rows: 1, cols: 2, pitchX: 8 });
    gate('8d a refusal still says where the holes would be; a dropped hole where it fell',
      !bad.ok && bad.wouldBe.length === 2 && over.ok && over.droppedAt.length === 1 && near(over.droppedAt[0].point[0], 45, 1e-6) &&
      near(over.frame.o[0], 37, 1e-6));
  }

  /* 9 ---------------------------------------------- a fine mesh: filter sheets */
  {
    // a solid disc Ø40 x 2 (a 128-gon prism), the click at its middle
    const disc = (() => {
      const o = [], m = 128, Rd = 20, H = 2, at = (k, z) => { const a = 2 * Math.PI * k / m; return [Rd * Math.cos(a), Rd * Math.sin(a), z]; };
      for (let k = 0; k < m; k++) {
        const a0 = at(k, 0), a1 = at(k + 1, 0), b0 = at(k, H), b1 = at(k + 1, H);
        o.push(0, 0, H, ...b0, ...b1);  o.push(0, 0, 0, ...a1, ...a0);
        o.push(...a0, ...a1, ...b1);    o.push(...a0, ...b1, ...b0);
      }
      return new Float32Array(o);
    })();
    const dh = { point: [0, 0, 2], normal: [0, 0, 1] };

    // 9a a pitch of exactly Ø + floor is AT the floor, not under it
    const slab = box([0, 0, 0], [40, 40, 1.2]), sh = { point: [20, 20, 1.2], normal: [0, 0, 1] };
    const exact = P.plan(slab, sh, { diaMm: 1, pattern: 'grid', rows: 10, cols: 10, pitchX: 1.8, pitchY: 1.8, anchor: 'centre' });
    const under = P.plan(slab, sh, { diaMm: 1, pattern: 'grid', rows: 10, cols: 10, pitchX: 1.79, pitchY: 1.79, anchor: 'centre' });
    gate('9a Ø1 at pitch 1.8 (a 0.8 wall, the floor exactly) passes; 1.79 is refused', exact.ok && !under.ok && /0\.79 mm between/.test(under.reason),
      exact.reason + ' | ' + under.reason);

    // 9b stagger: odd rows half a pitch along u, and a centred staggered grid still centred on the click
    const hex = P.plan(slab, sh, { diaMm: 1, pattern: 'grid', rows: 4, cols: 5, pitchX: 1.8, pitchY: 1.8 * Math.sqrt(3) / 2, anchor: 'centre', stagger: true });
    const xs = hex.ok ? hex.holes.map(H => H.centre[0]) : [], mx = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
    const row0 = hex.ok ? hex.holes[0].centre[0] : NaN, row1 = hex.ok ? hex.holes[5].centre[0] : NaN;
    gate('9b stagger: row 2 sits 0.9 along u from row 1, the grid centred on the click, the hex wall 0.8 passes',
      hex.ok && hex.holes.length === 20 && near(row1 - row0, 0.9, 1e-6) && near(mx, 20, 1e-6), hex.reason + ' mean x ' + mx.toFixed(4));

    // 9c edge 'drop': a hex grid bigger than the disc is trimmed to it, every kept hole a floor from the rim
    const go = { diaMm: 1, pattern: 'grid', rows: 26, cols: 24, pitchX: 1.8, pitchY: 1.8 * Math.sqrt(3) / 2, anchor: 'centre', stagger: true };
    const refused = P.plan(disc, dh, go), trim = P.plan(disc, dh, Object.assign({ edge: 'drop' }, go));
    const worstRim = trim.ok ? Math.min(...trim.holes.map(H => 20 * Math.cos(Math.PI / 128) - Math.hypot(H.centre[0], H.centre[1]) - 0.5)) : -1;
    gate('9c edge drop trims a grid to a disc: the plain plan refuses at the edge, drop keeps the rest, each a floor from the rim',
      !refused.ok && /edge/.test(refused.reason) && trim.ok && trim.trimmed > 0 && trim.holes.length + trim.dropped === 26 * 24 &&
      worstRim >= 0.8 - 1e-3 && /are off the face or within 0.8 mm of its edge and left out/.test(trim.reason),
      (trim.ok ? trim.holes.length + ' kept, ' + trim.trimmed + ' trimmed, worst rim wall ' + worstRim.toFixed(3) : trim.reason));

    // 9d ...and cut in ONE subtract: the disc loses exactly the cutters' prisms through it
    if (trim.ok) {
      const res = await csg.NSO_subtractSoups(disc, concat(P.cutters(trim)));
      const mm = P.sidesFor(1), prism = mm * 0.25 * Math.tan(Math.PI / mm) * 2;
      const lost = volume(disc) - (res.ok ? volume(res.soup) : 0), want = trim.holes.length * prism;
      gate('9d the trimmed sheet cuts in one boolean, the volume lost = holes x prism', res.ok && Math.abs(lost - want) / want < 1e-3,
        trim.holes.length + ' holes, lost ' + lost.toFixed(2) + ' mm3, want ' + want.toFixed(2));
    }

    // 9e the neighbour broad phase misses no pair brute force finds
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const bx = Array.from({ length: 400 }, () => {
      const c = [rnd() * 50, rnd() * 50, rnd() * 5], s = [rnd() * 2, rnd() * 2, rnd() * 3];
      return { lo: [c[0] - s[0], c[1] - s[1], c[2] - s[2]], hi: [c[0] + s[0], c[1] + s[1], c[2] + s[2]] };
    });
    const brute = [];
    for (let i = 0; i < bx.length; i++) for (let j = i + 1; j < bx.length; j++) {
      let ok = true;
      for (let k = 0; k < 3; k++) if (bx[j].lo[k] > bx[i].hi[k] + 0.5 || bx[i].lo[k] > bx[j].hi[k] + 0.5) ok = false;
      if (ok) brute.push(i + ',' + j);
    }
    const sp = P._nearPairs(bx, 0.5).map(p => p.join());
    gate('9e sweep-and-prune finds every pair brute force does', sp.length === brute.length && sp.join() === brute.join(), sp.length + ' / ' + brute.length);

    // 9f 10,000 holes is one punch, and plans in seconds; 10,001 is refused
    const big = box([0, 0, 0], [182, 182, 1.2]), bh = { point: [91, 91, 1.2], normal: [0, 0, 1] };
    const t0 = Date.now();
    const p10k = P.plan(big, bh, { diaMm: 1, pattern: 'grid', rows: 100, cols: 100, pitchX: 1.8, pitchY: 1.8, anchor: 'centre' });
    const ms = Date.now() - t0;
    const over = P.plan(big, bh, { diaMm: 1, pattern: 'grid', rows: 100, cols: 101, pitchX: 1.8, pitchY: 1.8, anchor: 'centre' });
    gate('9f a 100 x 100 Ø1 sheet plans (under 5 s); 100 x 101 is more than one punch makes', p10k.ok && p10k.holes.length === 10000 && ms < 5000 &&
      !over.ok && /more than one punch makes \(10000\)/.test(over.reason), ms + ' ms; ' + over.reason);

    // 9g cutter groups: one on a slab, overlap-free sets covering every hole across a tube's bore
    const R = 15, T = tube(R, 11, 60, 64), a = 75 * Math.PI / 180;
    const th = { point: [30, R * Math.cos(a), R * Math.sin(a)], normal: [0, Math.cos(a), Math.sin(a)] };
    const tg = P.plan(T, th, { diaMm: 2, pattern: 'grid', rows: 3, cols: 4, pitchX: 5, pitchY: 5, anchor: 'centre' });
    const gs = tg.ok ? P.cutterGroups(tg) : [], gSlab = P.cutterGroups(exact);
    const each = gs.every(g => !P.cuttersOverlap({ holes: g.map(i => tg.holes[i]) }));
    const covered = [].concat(...gs).sort((x, y) => x - y).join() === (tg.ok ? tg.holes.map((_, i) => i).join() : '-');
    gate('9g cutterGroups: 1 group on a slab; on a tube several, none meeting inside, every hole once',
      gSlab.length === 1 && gSlab[0].length === 100 && tg.ok && P.cuttersOverlap(tg) && gs.length > 1 && each && covered,
      gs.map(g => g.length).join('+'));

    // 9h extent: how far the face runs from the click, for Fill
    const ex = P.extent(slab, { point: [10, 25, 1.2], normal: [0, 0, 1] }, {});
    gate('9h extent of a 40 x 40 top clicked at (10, 25): u -10..30, v -25..15', ex.ok && near(ex.u[0], -10, 1e-4) && near(ex.u[1], 30, 1e-4) &&
      near(ex.v[0], -25, 1e-4) && near(ex.v[1], 15, 1e-4), ex.ok ? ex.u.concat(ex.v).map(x => x.toFixed(2)).join(' ') : ex.reason);
  }

  console.log('\n' + rows.map(r => r[0] + '  ' + r[1]).join('\n'));
  console.log('\n' + (fails ? 'FAILED ' + fails + ' of ' + rows.length : 'PASSED all ' + rows.length + ' gates'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
