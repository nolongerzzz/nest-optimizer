#!/usr/bin/env node
// nso_box_edges.js: round or bevel ANY chosen edges of a plain box.
//
//   node tools/nso_box_edges_test.js        exit 0 = every gate held
//
// The kernel is loaded straight from the app's own file; nothing is
// reimplemented here. Every result is checked for closure with the same weld
// grid Soften's own seal test uses, and for volume against the closed form.
//
//   1  numbering     edge = axis*4 + sideA*2 + sideB; faces / between agree
//   2  two edges     a 30 x 30 x 50 box, the two parallel edges on one side at
//                    R 15: a true half-round (the flat between them is gone),
//                    the volume is the D's, closed
//   3  the D piece   that pair at R 15, then the other pair at R 3, each edge at
//                    its own radius: the cross-section is the D-profile
//   4  one edge      a single edge takes R and nothing else moves
//   5  mitre         two picked edges that share a corner, the third left sharp
//   6  bevel         the flat cut, exact to the closed form
//   7  clamp         R beyond the box is cut to what the edge can use, and said
//   8  paint         an edge on a painted-out face is left sharp
//   9  every edge    all twelve at one R: closed (the wrap's balls are not this
//                    kernel's job; the corners are mitres here)
//  10  sweep         400 random edge sets at random radii: always closed,
//                    positive volume, inside the box

const E = require('../nso_box_edges.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
  if (!cond) fails++;
};

function seal(soup) {          // the same weld grid as nsoSealScore in app-finish.js
  const q = 1e4, vk = (i) => Math.round(soup[i] * q) + '|' + Math.round(soup[i + 1] * q) + '|' + Math.round(soup[i + 2] * q);
  const use = new Map();
  for (let t = 0; t + 8 < soup.length; t += 9) {
    const K = [vk(t), vk(t + 3), vk(t + 6)];
    for (let e = 0; e < 3; e++) {
      const a = K[e], b = K[(e + 1) % 3];
      if (a === b) continue;
      const k = a < b ? a + '~' + b : b + '~' + a;
      use.set(k, (use.get(k) || 0) + 1);
    }
  }
  let open = 0, nm = 0;
  use.forEach(c => { if (c % 2) open++; if (c > 2) nm++; });
  return { open, nm };
}
function vol(s) {
  let v = 0;
  for (let t = 0; t < s.length; t += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = s.slice(t, t + 9);
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return v;
}
const mkBox = (lo, hi) => ({ lo, hi, ext: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] });
const box = mkBox([-15, -15, -25], [15, 15, 25]);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// a 24-chord semicircle (12 per quarter) loses this fraction of its area to the chords
const chordLoss = (R, n) => 0.5 * R * R * (n * (Math.PI / 2 / n) - n * Math.sin(Math.PI / 2 / n));   // area lost per quarter, n chords

console.log('\n=== 1. numbering ===');
{
  let ok = true;
  for (let id = 0; id < 12; id++) {
    const f = E.faces(id);
    if (E.between(f[0][0], f[0][1], f[1][0], f[1][1]) !== id) ok = false;
    if (E.between(f[1][0], f[1][1], f[0][0], f[0][1]) !== id) ok = false;
  }
  check('faces() and between() are inverses for all twelve edges', ok);
  check('opposite faces share no edge', E.between(0, 0, 0, 1) === -1);
  const seg = E.segments(box.lo, box.hi);
  check('twelve segments, each the length of its axis', seg.length === 12 && seg.every(s => {
    const c = s.id >> 2;
    return near(Math.abs(s.q[c] - s.p[c]), box.ext[c], 1e-9);
  }));
}

console.log('\n=== 2. two edges: the half-round ===');
{
  const r = E.round(box, [{ id: 8, R: 15 }, { id: 10, R: 15 }]);
  const area = 450 + Math.PI * 225 / 2 - 2 * chordLoss(15, 12);
  check('closed and manifold', JSON.stringify(seal(r.soup)) === '{"open":0,"nm":0}', JSON.stringify(seal(r.soup)));
  check('the D cross-section times 50 (inscribed chords, 12 per quarter)', near(vol(r.soup), area * 50, 1),
    vol(r.soup).toFixed(1) + ' vs ' + (area * 50).toFixed(1));
  check('within 0.3% of the true semicircle', near(vol(r.soup) / ((450 + Math.PI * 225 / 2) * 50), 1, 0.003));
  check('both edges used, none clamped', r.build.edges === 2 && r.build.clamped === 0 && r.build.maxR === 15);
  let lowFlat = 0;
  for (let t = 0; t < r.soup.length; t += 9) if ([1, 4, 7].every(k => r.soup[t + k] === -15)) lowFlat++;
  check('the flat between the two is gone (no triangle left on the low face)', lowFlat === 0, lowFlat + ' left');
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < r.soup.length; i += 3) { minY = Math.min(minY, r.soup[i]); maxY = Math.max(maxY, r.soup[i]); }
  check('the box still spans y -15..15', minY === -15 && maxY === 15);
}

console.log('\n=== 3. the D piece: two radii on one box ===');
{
  const r = E.round(box, [{ id: 8, R: 15 }, { id: 10, R: 15 }, { id: 9, R: 3 }, { id: 11, R: 3 }]);
  const exact = (450 + Math.PI * 225 / 2 - 2 * (9 - Math.PI * 9 / 4)) * 50;
  check('closed and manifold', JSON.stringify(seal(r.soup)) === '{"open":0,"nm":0}');
  check('volume is the D-profile\'s (within the chord sampling)', near(vol(r.soup) / exact, 1, 0.003),
    vol(r.soup).toFixed(1) + ' vs ' + exact.toFixed(1));
  check('each edge kept its own radius', r.build.perEdge.filter(p => p.R === 15).length === 2 && r.build.perEdge.filter(p => p.R === 3).length === 2);
  // the top corner (x 15, y 15): the point 3 in from the corner along 45 degrees sits on the R3 arc
  let onArc = false;
  const cx = 12, cy = 12, rr = 3;
  for (let i = 0; i < r.soup.length; i += 3) {
    if (near(Math.hypot(r.soup[i] - cx, r.soup[i + 1] - cy), rr, 1e-4) && r.soup[i] > cx && r.soup[i + 1] > cy) onArc = true;
  }
  check('vertices sit on the R 3 top arc and are not a sharp corner', onArc);
  let sharp = false;
  for (let i = 0; i < r.soup.length; i += 3) if (r.soup[i] === 15 && r.soup[i + 1] === 15) sharp = true;
  check('no vertex is left at the sharp top corner (15, 15)', !sharp);
}

console.log('\n=== 4. one edge ===');
{
  const r = E.round(box, [{ id: 0, R: 5 }]);                  // along x, low y, low z
  const exact = (30 * 30 * 50 - (25 - Math.PI * 25 / 4) * 30);
  check('closed', JSON.stringify(seal(r.soup)) === '{"open":0,"nm":0}');
  check('volume is the box less one quarter-round spandrel', near(vol(r.soup) / exact, 1, 0.001), vol(r.soup).toFixed(1) + ' vs ' + exact.toFixed(1));
  let n = 0;
  for (let i = 0; i < r.soup.length; i += 3) if (r.soup[i + 1] === -15 && r.soup[i + 2] === -25) n++;
  check('the edge itself is gone from the mesh', n === 0, n + ' vertices left on it');
}

console.log('\n=== 5. two edges that share a corner ===');
{
  const r = E.round(box, [{ id: 0, R: 5 }, { id: 4, R: 5 }]);  // x-edge and y-edge, both at the low z low corner
  check('closed and manifold', JSON.stringify(seal(r.soup)) === '{"open":0,"nm":0}');
  check('removed more than one edge alone and less than both added twice',
    vol(r.soup) < vol(E.round(box, [{ id: 0, R: 5 }]).soup) && vol(r.soup) > 45000 - 2 * 4.5 * 50);
}

console.log('\n=== 6. bevel ===');
{
  const r = E.round(box, [{ id: 8, R: 3, mode: 'chamfer' }, { id: 10, R: 3, mode: 'chamfer' }]);
  check('closed', JSON.stringify(seal(r.soup)) === '{"open":0,"nm":0}');
  check('exactly the box less two 3 x 3 triangles over 50', near(vol(r.soup), (45000 - 2 * 4.5 * 50), 1e-3), vol(r.soup).toFixed(3));
}

console.log('\n=== 7. clamp ===');
{
  let r = E.round(box, [{ id: 8, R: 99 }]);
  check('one edge: the most it can use is the whole face, 30', r.build.perEdge[0].R === 30 && r.build.clamped === 1);
  r = E.round(box, [{ id: 8, R: 99 }, { id: 10, R: 99 }]);
  check('a pair across one face shares it: 15 each', r.build.perEdge.every(p => p.R === 15) && r.build.clamped === 2);
  check('and still closed', JSON.stringify(seal(r.soup)) === '{"open":0,"nm":0}');
  let threw = '';
  try { E.round(box, []); } catch (e) { threw = e.message; }
  check('no edges is refused with a reason', /no edge/.test(threw), threw);
}

console.log('\n=== 8. paint ===');
{
  const sq = [[false, false], [false, false], [false, false]];
  sq[1][0] = true;                                          // the low y face is painted out
  const r = E.round(box, [{ id: 8, R: 5 }, { id: 10, R: 5 }, { id: 9, R: 5 }], { square: sq });
  check('edges on the painted face (8, 10) are left sharp; the one that is not (9) rounds', r.build.edges === 1 && r.build.perEdge[0].id === 9,
    JSON.stringify(r.build.perEdge.map(p => p.id)));
  let threw = '';
  try { E.round(box, [{ id: 8, R: 5 }], { square: sq }); } catch (e) { threw = e.message; }
  check('only painted edges left: refused', /no edge/.test(threw), threw);
}

console.log('\n=== 9. every edge ===');
{
  const r = E.round(box, [...Array(12).keys()].map(id => ({ id, R: 4 })));
  check('closed and manifold', JSON.stringify(seal(r.soup)) === '{"open":0,"nm":0}', JSON.stringify(seal(r.soup)));
  check('12 edges used', r.build.edges === 12);
}

console.log('\n=== 10. sweep ===');
{
  let seed = 12345;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  let bad = 0, worst = '';
  for (let k = 0; k < 400; k++) {
    const ext = [8 + rnd() * 40, 8 + rnd() * 40, 8 + rnd() * 40];
    const b = mkBox([-ext[0] / 2, -ext[1] / 2, -ext[2] / 2], [ext[0] / 2, ext[1] / 2, ext[2] / 2]);
    const list = [];
    for (let id = 0; id < 12; id++) if (rnd() < 0.35) list.push({ id, R: 0.3 + rnd() * 14, mode: rnd() < 0.25 ? 'chamfer' : 'fillet' });
    if (!list.length) continue;
    let r;
    try { r = E.round(b, list); } catch (e) { bad++; worst = 'threw ' + e.message; continue; }
    const s = seal(r.soup), v = vol(r.soup), full = ext[0] * ext[1] * ext[2];
    let inside = true;
    for (let i = 0; i < r.soup.length; i += 3) {
      for (let a = 0; a < 3; a++) if (Math.abs(r.soup[i + a]) > ext[a] / 2 + 1e-4) inside = false;
    }
    if (s.open || s.nm || !(v > 0) || v > full + 1e-3 || !inside) {
      bad++; worst = 'seal ' + JSON.stringify(s) + ' vol ' + v.toFixed(1) + '/' + full.toFixed(1) + ' ids ' + list.map(x => x.id + '@' + x.R.toFixed(2)).join(',');
    }
  }
  check('400 random edge sets: closed, positive volume, inside the box', bad === 0, bad ? bad + ' bad, last: ' + worst : '');
}

console.log(fails ? '\n' + fails + ' check(s) FAILED' : '\nall gates held');
process.exit(fails ? 1 : 0);
