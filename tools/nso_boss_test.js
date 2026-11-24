/* nso_boss.js - a step, boss, ledge or wedge as a solid, headless.
     node tools/nso_boss_test.js        exit 0 = every gate held

   Pinned, for every outline (rectangle square and rounded, round, drawn
   points including a notch) with and without a ramp:
   1. closed and consistently wound - every directed edge met once by its
      reverse - with no degenerate triangle, signed volume positive;
   2. it runs from -embed to its height exactly, and spans its outline;
   3. volumes by hand: a flat 20 x 10 step is 20 x 10 x (h + embed); a 45
      degree ramp from the bottom edge (rampDir 90) on a square-cornered
      20 x 10 x 4 is the prism less the triangle the ramp cuts off, the dip
      accounted; a ramp that never levels off (a wedge) is a trapezoid prism;
   4. the top is exact: every top corner is at min(height, (s - s0) tan(ramp)
      - dip) - checked on the triangles, the crease included;
   5. span() is what the placed solid measures; place() keeps the volume;
   6. check() refuses what cannot be built, in words. */
const path = require('path');
const BS = require(path.join(__dirname, '..', 'nso_boss.js'));
const FX = require('./nso_feature_fixture.js');

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : '')); if (!cond) fails++; };
const near = (a, b, t) => Math.abs(a - b) <= (t == null ? 1e-4 : t);
function box(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) { if (s[i + k] < lo[k]) lo[k] = s[i + k]; if (s[i + k] > hi[k]) hi[k] = s[i + k]; }
  return { lo, hi };
}
const E = 0.4, DIP = BS.DIP;

const cases = [
  ['square step', { outline: 'rect', length: 20, width: 10, radius: 0, height: 3 }],
  ['rounded step', { outline: 'rect', length: 20, width: 10, radius: 2, height: 3 }],
  ['round boss', { outline: 'round', diameter: 8, height: 5 }],
  ['ledge, 45 from the bottom', { outline: 'rect', length: 20, width: 10, radius: 0, height: 4, ramp: 45, rampDir: 90 }],
  ['rounded ledge, 30 from the left', { outline: 'rect', length: 20, width: 10, radius: 2, height: 4, ramp: 30, rampDir: 0 }],
  ['round, ramped at a slant', { outline: 'round', diameter: 12, height: 3, ramp: 40, rampDir: 33 }],
  ['wedge', { outline: 'rect', length: 20, width: 10, radius: 0, height: 50, ramp: 20, rampDir: 90 }],
  ['drawn, with a notch', { outline: 'custom', points: [{ x: 0, y: 0, r: 1 }, { x: 30, y: 0, r: 1 }, { x: 30, y: 20, r: 1 }, { x: 15, y: 8, r: 0 }, { x: 0, y: 20, r: 1 }], height: 4, ramp: 40, rampDir: 90 }]
];

console.log('1-2. closed, wound, its own size');
const built = {};
cases.forEach(([name, spec]) => {
  const r = BS.build(spec, { embed: E });
  built[name] = r;
  if (!r.ok) { check(name + ': built', false, r.reason); return; }
  const t = FX.topology(r.soup), b = box(r.soup);
  check(name + ': closed, wound, no degenerate triangle', t.bad === 0 && t.degenerate === 0, JSON.stringify(t));
  check(name + ': positive volume, = signedVolume', r.volume > 0 && near(FX.volume(r.soup), r.volume, 1e-3));
  check(name + ': from -embed up to its top', near(b.lo[2], -E) && near(b.hi[2], r.top, 1e-4), b.lo[2].toFixed(4) + '..' + b.hi[2].toFixed(4));
  const o = BS.outline(spec), sp = BS.span(o.loop, 0);
  check(name + ': spans its outline, centred', near(b.lo[0], sp.u0) && near(b.hi[0], sp.u1) && near(b.lo[1], sp.v0) && near(b.hi[1], sp.v1) && near(sp.u0, -sp.u1) && near(sp.v0, -sp.v1));
});

console.log('3. volumes by hand');
check('flat 20 x 10 x 3: 20 x 10 x 3.4', near(built['square step'].volume, 20 * 10 * 3.4, 1e-3), built['square step'].volume.toFixed(4));
/* ledge: t(y) = min(4, (y + 5) - dip) over y in -5..5, solid from -0.4 */
(function () {
  const H = 4, s = (H + DIP);                         // where it levels off, from the bottom edge (tan 45 = 1)
  const area = (10 - s) * (H + E) + (s * (-DIP + E) + s * s / 2);
  check('45 degree ledge 20 x 10 x 4: the prism less the cut triangle', near(built['ledge, 45 from the bottom'].volume, 20 * area, 1e-3),
    built['ledge, 45 from the bottom'].volume.toFixed(4) + ' vs ' + (20 * area).toFixed(4));
  check('...its crease where the ramp levels off', near(built['ledge, 45 from the bottom'].crease, -5 + s, 1e-6));
})();
(function () {
  const k = Math.tan(20 * Math.PI / 180), t0 = -DIP + E, t1 = 10 * k - DIP + E;
  check('20 degree wedge 20 x 10: a trapezoid prism, no crease', near(built.wedge.volume, 20 * 10 * (t0 + t1) / 2, 1e-3) && built.wedge.crease == null,
    built.wedge.volume.toFixed(4));
})();
check('round boss 8 x 5: the 64-gon prism', near(built['round boss'].volume, 32 * 16 * Math.sin(2 * Math.PI / 64) * 5.4, 1e-3));

console.log('4. the top is exact');
cases.forEach(([name, spec]) => {
  const r = built[name];
  if (!r || !r.ok || !(spec.ramp > 0)) return;
  const a = spec.rampDir * Math.PI / 180, d = [Math.cos(a), Math.sin(a)], k = Math.tan(spec.ramp * Math.PI / 180);
  const o = BS.outline(spec), s0 = Math.min(...o.loop.map(p => p[0] * d[0] + p[1] * d[1]));
  let worst = 0;
  for (let i = 0; i < r.soup.length; i += 3) {
    const z = r.soup[i + 2];
    if (z <= -E + 1e-6) continue;                     // the bottom
    const want = Math.min(spec.height, (r.soup[i] * d[0] + r.soup[i + 1] * d[1] - s0) * k - DIP);
    worst = Math.max(worst, Math.abs(z - want));
  }
  check(name + ': every top corner on min(height, ramp)', worst < 2e-5, worst.toExponential(2));
});

console.log('5. span and place');
(function () {
  const r = built['rounded step'], o = BS.outline(cases[1][1]);
  [0, 90, 30].forEach(deg => {
    const F = { o: [5, 6, 7], u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] };
    const w = BS.place(r.soup, F, deg), b = box(w), sp = BS.span(o.loop, deg);
    check('turned ' + deg + ': placed span is span()', near(b.lo[1], 6 + sp.u0, 1e-4) && near(b.hi[1], 6 + sp.u1, 1e-4) && near(b.lo[2], 7 + sp.v0, 1e-4) && near(b.hi[2], 7 + sp.v1, 1e-4));
    check('turned ' + deg + ': out of the face along n, volume kept', near(b.lo[0], 5 - E) && near(b.hi[0], 8) && near(FX.volume(w), r.volume, 1e-3));
  });
})();

console.log('6. refusals');
[[{ height: 0 }, /Height/], [{ ramp: 90 }, /Ramp/], [{ outline: 'rect', length: 10, width: 4, radius: 3 }, /radius/],
 [{ outline: 'round', diameter: 0 }, /Diameter/], [{ outline: 'custom', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }, /3 points/],
 [{ outline: 'custom', points: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }] }, /crosses itself|no area/]
].forEach(([spec, re]) => {
  const r = BS.build(Object.assign({ outline: 'rect', length: 20, width: 10, height: 3 }, spec), { embed: E });
  check('refused: ' + JSON.stringify(spec).slice(0, 60), !r.ok && re.test(r.reason), r.reason);
});

console.log(fails ? '\nFAIL - ' + fails + ' gate(s)' : '\nall gates held');
process.exit(fails ? 1 : 0);
