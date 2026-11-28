/* nso_scale_zones.js - scale part of a piece, keep the rest, headless.
     node tools/nso_scale_zones_test.js        exit 0 = every gate held

   Three pieces built here, each the shape of one of the owner's asks
   (2026-11-28): a thumb screw (a Ø20 x 10 head on a Ø10 x 20 shaft), a
   stringing test (a 10 x 30 x 1 plate with two 2 x 2 x 19 pillars), and a
   shower head (a Ø30 tube with a Ø22 collar and a Ø20 fitting on top, a Ø10
   bore through all of it). Pinned:
   1. fit(): a click on the shaft is a Keep cylinder round the shaft alone
      (Ø just over 10, from the head's top to the shaft's end, along Z); a
      click on the fitting stops at the collar, a click on the collar takes
      the fitting with it; a click on a square pillar is a box round that
      pillar, from the plate's top to its own.
   2. Keep: the screw's head to 150% - every shaft vertex exactly where it
      was, the head Ø30, its top still at the shaft's foot (the pivot is the
      join), the triangles and the topology unchanged.
   3. Per axis and anchors: the head wider but not taller; Centre and Base
      pivots where they say.
   4. Scale: one pillar to 140% - its own footprint and height, the other
      pillar and the plate's outside untouched; two Scale zones are two parts,
      each about its own foot; a Keep zone inside a Scale zone wins.
   5. Refusals in words: no zones, a zone over everything, a factor out of
      range, the head shrunk past the shaft it joins (faces turned inside
      out), a pillar grown over the plate's next grid line.
   6. Blend: the change eases in - a vertex inside the band moves part way.
   7. The shower head, collar kept, the tube to 120% across: the tube Ø36,
      the collar and fitting exact, the closed mesh still closed.
   8. carry(): a Scale zone carried with its part still holds it. */
const path = require('path');
const SZ = require(path.join(__dirname, '..', 'nso_scale_zones.js'));

let fails = 0;
const check = (name, cond, detail) => { console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : '')); if (!cond) fails++; };
const near = (a, b, t) => Number.isFinite(a) && Math.abs(a - b) <= (t == null ? 1e-4 : t);
const f2 = x => (Math.round(x * 100) / 100).toFixed(2);

const FX = require('./nso_scale_zones_fixture.js');
const { revolve, heightfield, topo } = FX;

function triWhere(s, test) {
  for (let t = 0; t < s.length / 9; t++) {
    const c = [0, 1, 2].map(a => (s[t * 9 + a] + s[t * 9 + 3 + a] + s[t * 9 + 6 + a]) / 3);
    if (test(c)) return t;
  }
  return -1;
}
const mid = (s, t) => [0, 1, 2].map(a => (s[t * 9 + a] + s[t * 9 + 3 + a] + s[t * 9 + 6 + a]) / 3);
/* the box of the vertices passing `test`, after */
function boxOf(s, test) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) {
    if (test && !test(s[i], s[i + 1], s[i + 2], i)) continue;
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], s[i + k]); hi[k] = Math.max(hi[k], s[i + k]); }
  }
  return { lo, hi };
}
/* every coordinate of vertices passing `test` (in the original) the same in the result */
function unmoved(a, b, test) {
  let n = 0, bad = 0;
  for (let i = 0; i < a.length; i += 3) {
    if (!test(a[i], a[i + 1], a[i + 2])) continue;
    n++;
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) bad++;
  }
  return { n, bad };
}

const screw = FX.screw(), pillars = FX.pillars(), shower = FX.shower();

console.log('0. fixtures');
[['screw', screw], ['pillars', pillars], ['shower', shower]].forEach(([n, s]) => {
  const T = topo(s);
  check(n + ' is closed and outward', T.open === 0 && T.nm === 0 && T.vol > 0, JSON.stringify(T));
});

console.log('1. fit');
const ixScrew = SZ.index(screw);
const tShaft = triWhere(screw, c => Math.hypot(c[0], c[1]) > 4.8 && c[2] > 15 && c[2] < 25);
const fShaft = SZ.fit(screw, tShaft, mid(screw, tShaft), { ix: ixScrew, kind: 'keep' });
check('a click on the shaft fits a Keep cylinder along Z', fShaft.ok && fShaft.zone.shape === 'cyl' && fShaft.zone.axis === 2 && fShaft.zone.kind === 'keep', fShaft.reason || JSON.stringify(fShaft.zone));
const zs = fShaft.zone;
check('round the shaft alone: Ø just over 10, under the head\'s 20', zs && zs.r > 5 && zs.r < 5.5, zs && f2(2 * zs.r));
check('from the head\'s top to the shaft\'s end (10 to 30)', zs && near(zs.c[2] - zs.hl, 10, 0.01) && zs.c[2] - zs.hl < 10 && near(zs.c[2] + zs.hl, 30, 0.01) && zs.c[2] + zs.hl > 30,
  zs && f2(zs.c[2] - zs.hl) + ' .. ' + f2(zs.c[2] + zs.hl));
check('on the axis', zs && near(zs.c[0], 0, 0.05) && near(zs.c[1], 0, 0.05), zs && f2(zs.c[0]) + ', ' + f2(zs.c[1]));
const tHead = triWhere(screw, c => Math.hypot(c[0], c[1]) > 9.5 && c[2] > 2 && c[2] < 8);
const fHead = SZ.fit(screw, tHead, mid(screw, tHead), { ix: ixScrew });
check('a click on the head is a Scale cylinder round the head, stopped at the shaft', fHead.ok && fHead.zone.shape === 'cyl' && fHead.zone.kind === 'scale' &&
  near(fHead.zone.c[2] + fHead.zone.hl, 10, 0.01) && fHead.zone.r > 10 && fHead.zone.r < 11, fHead.ok ? SZ.describe(fHead.zone) + ' top ' + f2(fHead.zone.c[2] + fHead.zone.hl) : fHead.reason);

const ixShower = SZ.index(shower);
const tFit = triWhere(shower, c => Math.hypot(c[0], c[1]) > 9.8 && Math.hypot(c[0], c[1]) < 10.2 && c[2] > 105);
const fFit = SZ.fit(shower, tFit, mid(shower, tFit), { ix: ixShower, kind: 'keep' });
check('the fitting: Ø just over 20, 103 to 110 - stopped at the collar', fFit.ok && fFit.zone.shape === 'cyl' && fFit.zone.r > 10 && fFit.zone.r < 10.6 &&
  near(fFit.zone.c[2] - fFit.zone.hl, 103, 0.01) && near(fFit.zone.c[2] + fFit.zone.hl, 110, 0.01), fFit.ok ? SZ.describe(fFit.zone) + ' from ' + f2(fFit.zone.c[2] - fFit.zone.hl) : fFit.reason);
const tCollar = triWhere(shower, c => near(Math.hypot(c[0], c[1]), 11, 0.3) && c[2] > 100.5 && c[2] < 102.5);
const fCollar = SZ.fit(shower, tCollar, mid(shower, tCollar), { ix: ixShower, kind: 'keep' });
check('the collar: takes the fitting with it, 100 to 110, Ø just over 22', fCollar.ok && fCollar.zone.r > 11 && fCollar.zone.r < 11.6 &&
  near(fCollar.zone.c[2] - fCollar.zone.hl, 100, 0.01) && near(fCollar.zone.c[2] + fCollar.zone.hl, 110, 0.01), fCollar.ok ? SZ.describe(fCollar.zone) + ' from ' + f2(fCollar.zone.c[2] - fCollar.zone.hl) : fCollar.reason);

const ixP = SZ.index(pillars);
const tP1 = triWhere(pillars, c => near(c[0], 6) && c[1] > 4 && c[1] < 6 && c[2] > 5);
const fP1 = SZ.fit(pillars, tP1, mid(pillars, tP1), { ix: ixP });
const zp = fP1.zone;
check('a square pillar is a box round it', fP1.ok && zp.shape === 'box' && zp.h[0] > 1 && zp.h[0] < 1.3 && zp.h[1] > 1 && zp.h[1] < 1.3 && near(zp.c[0], 5, 0.01) && near(zp.c[1], 5, 0.01),
  fP1.ok ? SZ.describe(zp) + ' at ' + zp.c.map(f2).join(', ') : fP1.reason);
check('from the plate\'s top (1) to its own (20)', zp && near(zp.c[2] - zp.h[2], 1, 0.01) && zp.c[2] - zp.h[2] < 1 && near(zp.c[2] + zp.h[2], 20, 0.01), zp && f2(zp.c[2] - zp.h[2]) + ' .. ' + f2(zp.c[2] + zp.h[2]));

console.log('2. keep the thread, scale the head');
let r = SZ.apply(screw, [zs], 1.5, { ix: ixScrew });
check('applies', r.ok, r.reason);
const shaftKept = unmoved(screw, r.soup, (x, y, z) => z > 10 - 1e-6 && Math.hypot(x, y) < 5 + 1e-4);
check('every shaft vertex exactly where it was (the ring at its foot too)', shaftKept.n > 0 && shaftKept.bad === 0, shaftKept.n + ' vertices, ' + shaftKept.bad + ' moved');
let B = boxOf(r.soup, (x, y, z) => z < 10 - 1e-6 || Math.hypot(x, y) > 5.01);
check('the head is Ø30', near(B.hi[0] - B.lo[0], 30, 1e-3) && near(B.hi[1] - B.lo[1], 30, 0.1), f2(B.hi[0] - B.lo[0]) + ' x ' + f2(B.hi[1] - B.lo[1]));
check('15 tall, its top still at the shaft\'s foot (z 10)', near(B.hi[2], 10, 1e-4) && near(B.lo[2], -5, 1e-4), f2(B.lo[2]) + ' .. ' + f2(B.hi[2]));
check('one part, pivot at the join (0, 0, 10)', r.parts.length === 1 && near(r.parts[0].pivot[2], 10, 1e-3) && near(r.parts[0].pivot[0], 0, 1e-3) && r.parts[0].joined,
  r.parts.map(p => p.pivot.map(f2).join(',')).join(' | '));
let T = topo(r.soup);
check('same triangles, still closed and outward', r.soup.length === screw.length && T.open === 0 && T.nm === 0 && T.vol > 0, JSON.stringify(T));

console.log('3. per axis, anchors');
r = SZ.apply(screw, [zs], [1.5, 1.5, 1], { ix: ixScrew });
B = boxOf(r.soup, (x, y, z) => z < 10 - 1e-6);
check('X and Y 150%, Z 100%: Ø30 head, still 10 tall', r.ok && near(B.hi[0] - B.lo[0], 30, 1e-3) && near(B.lo[2], 0, 1e-4), f2(B.hi[0] - B.lo[0]) + ' / ' + f2(B.lo[2]));
r = SZ.apply(screw, [zs], 1.5, { ix: ixScrew, anchor: 'centre' });
check('Centre: about the head\'s own middle (0, 0, 5)', r.ok && near(r.parts[0].pivot[2], 5, 1e-3), r.ok ? r.parts[0].pivot.map(f2).join(', ') : r.reason);
r = SZ.apply(screw, [zs], 1.5, { ix: ixScrew, anchor: 'base' });
B = r.ok ? boxOf(r.soup, (x, y, z) => z < 10 - 1e-6 || Math.hypot(x, y) > 5.01) : null;
check('Base: about its bottom (0, 0, 0) - the head\'s underside stays on the plate', r.ok && near(r.parts[0].pivot[2], 0, 1e-3) && near(B.lo[2], 0, 1e-4), r.ok ? r.parts[0].pivot.map(f2).join(', ') : r.reason);

console.log('4. scale one pillar');
r = SZ.apply(pillars, [zp], 1.4, { ix: ixP });
check('applies', r.ok, r.reason);
B = boxOf(r.soup, (x, y, z) => z > 1 + 1e-6 && y < 15);
check('pillar 1 is 2.8 x 2.8 about its own middle (5, 5)', near(B.hi[0] - B.lo[0], 2.8, 1e-4) && near((B.hi[0] + B.lo[0]) / 2, 5, 1e-4) && near(B.hi[1] - B.lo[1], 2.8, 1e-4),
  f2(B.hi[0] - B.lo[0]) + ' x ' + f2(B.hi[1] - B.lo[1]));
check('and 27.6 tall (1 + 19 x 1.4)', near(B.hi[2], 1 + 19 * 1.4, 1e-4), f2(B.hi[2]));
let um = unmoved(pillars, r.soup, (x, y) => y > 15);
check('pillar 2 and its half of the plate untouched', um.bad === 0 && um.n > 0, um.n + ' vertices, ' + um.bad + ' moved');
um = unmoved(pillars, r.soup, (x, y, z) => z < 1 - 1e-6 || x < 3.5 || x > 6.5 || y < 3.5 || y > 6.5);
check('the plate round it untouched (bottom, edges, and all but the pillar\'s foot)', um.bad === 0, um.n + ' vertices, ' + um.bad + ' moved');
T = topo(r.soup);
check('still closed and outward', T.open === 0 && T.nm === 0 && T.vol > 0, JSON.stringify(T));
const tP2 = triWhere(pillars, c => near(c[0], 6) && c[1] > 24 && c[1] < 26 && c[2] > 5);
const zp2 = SZ.fit(pillars, tP2, mid(pillars, tP2), { ix: ixP }).zone;
r = SZ.apply(pillars, [zp, zp2], [1.4, 1.4, 0.5], { ix: ixP });
check('two Scale zones are two parts, each about its own foot', r.ok && r.parts.length === 2 && r.parts.every(p => near(p.pivot[2], 1, 1e-3)) &&
  near(r.parts[0].pivot[1] + r.parts[1].pivot[1], 30, 1e-3), r.ok ? r.parts.map(p => p.pivot.map(f2).join(',')).join(' | ') : r.reason);
B = boxOf(r.soup, (x, y, z) => z > 1 + 1e-6);
check('both 1 + 19 x 0.5 = 10.5 tall', r.ok && near(B.hi[2], 10.5, 1e-4), f2(B.hi[2]));
const keepTop = { kind: 'keep', shape: 'box', c: [5, 5, 20], h: [2, 2, 3] };
r = SZ.apply(pillars, [zp, keepTop], 1.4, { ix: ixP });
um = unmoved(pillars, r.soup || pillars, (x, y, z) => z > 17 - 1e-6 && y < 15);
check('a Keep zone inside a Scale zone wins: the pillar\'s top stays put', r.ok && um.bad === 0 && um.n > 0, r.ok ? um.n + ' kept, ' + um.bad + ' moved' : r.reason);

console.log('5. refusals');
r = SZ.apply(screw, [], 1.5, { ix: ixScrew });
check('no zones', !r.ok && /no zones/.test(r.reason), r.reason);
r = SZ.apply(screw, [{ kind: 'keep', shape: 'box', c: [0, 0, 15], h: [20, 20, 20] }], 1.5, { ix: ixScrew });
check('a Keep zone over everything', !r.ok && /whole piece/.test(r.reason), r.reason);
r = SZ.apply(screw, [{ kind: 'scale', shape: 'box', c: [100, 0, 0], h: [1, 1, 1] }], 1.5, { ix: ixScrew });
check('a Scale zone over nothing', !r.ok && /no part/.test(r.reason), r.reason);
r = SZ.apply(screw, [zs], 50, { ix: ixScrew });
check('5000% is out of range', !r.ok && /outside/.test(r.reason), r.reason);
r = SZ.apply(screw, [zs], 0.4, { ix: ixScrew });
check('the head shrunk to Ø8 under a Ø10 shaft: faces turned inside out, refused', !r.ok && r.folds > 0 && /inside out/.test(r.reason), r.reason);
r = SZ.apply(pillars, [zp], 2, { ix: ixP });
check('a pillar grown onto the next grid line of the plate: refused', !r.ok && (r.folds > 0 || r.flat > 0), r.reason);

console.log('6. blend');
r = SZ.apply(screw, [zs], 1.5, { ix: ixScrew, blend: 3 });
check('applies', r.ok, r.reason);
let part = 0, full = 0;
for (let i = 0; i < screw.length; i += 3) {
  const rr = Math.hypot(screw[i], screw[i + 1]);
  if (!(near(screw[i + 2], 10, 1e-4) && rr > 5.5 && rr < 9.5)) continue;
  const ratio = Math.hypot(r.soup[i], r.soup[i + 1]) / rr;
  if (ratio > 1.0001 && ratio < 1.4999) part++; else if (ratio >= 1.4999) full++;
}
const outer = unmoved(screw, r.soup, (x, y, z) => z > 10 - 1e-6 && Math.hypot(x, y) < 5 + 1e-4);
check('the shaft is still exact', outer.bad === 0, outer.bad + ' moved');
check('the head\'s top eases: a ring inside the band moves part way, none fully', part > 0 && full === 0, part + ' part way, ' + full + ' fully');
B = boxOf(r.soup);
check('the head\'s rim (outside the band) is still Ø30', near(B.hi[0] - B.lo[0], 30, 1e-3), f2(B.hi[0] - B.lo[0]));

console.log('7. the shower head: collar and fitting kept, tube 120% across');
r = SZ.apply(shower, [fCollar.zone], [1.2, 1.2, 1], { ix: ixShower });
check('applies', r.ok, r.reason);
um = unmoved(shower, r.soup, (x, y, z) => z > 100 - 1e-6 && Math.hypot(x, y) < 11 + 1e-4);
check('collar and fitting exactly where they were', um.bad === 0 && um.n > 0, um.n + ' vertices, ' + um.bad + ' moved');
B = boxOf(r.soup, (x, y, z) => z < 100 - 1e-6);
check('the tube Ø36 (30 x 1.2), its length unchanged', near(B.hi[0] - B.lo[0], 36, 1e-3) && near(B.lo[2], 0, 1e-4), f2(B.hi[0] - B.lo[0]) + ', from z ' + f2(B.lo[2]));
B = boxOf(r.soup, (x, y, z) => z < 1e-6 && Math.hypot(x, y) < 6.5);
check('the bore at the far end follows: Ø12', near(B.hi[0] - B.lo[0], 12, 1e-3), f2(B.hi[0] - B.lo[0]));
T = topo(r.soup);
check('still closed and outward', T.open === 0 && T.nm === 0 && T.vol > 0, JSON.stringify(T));

console.log('8. carry, describe');
r = SZ.apply(pillars, [zp], 1.4, { ix: ixP });
const carried = SZ.carry(zp, r.parts[0].pivot, 1.4);
B = boxOf(r.soup, (x, y, z) => z > 1 + 1e-6 && y < 15);
const cb = SZ.bounds(carried);
check('the carried zone holds the grown pillar', [0, 1, 2].every(k => cb.lo[k] <= B.lo[k] + 1e-4 && cb.hi[k] >= B.hi[k] - 1e-4), cb.lo.map(f2) + ' .. ' + cb.hi.map(f2));
check('describe', /^cylinder Ø10\.\d × 20\.0 along Z$/.test(SZ.describe(zs)) && /^box /.test(SZ.describe(zp)), SZ.describe(zs) + ' / ' + SZ.describe(zp));

console.log(fails ? fails + ' FAILED' : 'all ok');
process.exit(fails ? 1 : 0);
