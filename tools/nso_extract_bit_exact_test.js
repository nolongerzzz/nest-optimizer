#!/usr/bin/env node
/* Extract bit's exact path (nso_csg.js NSO_cavityCore / NSO_cavitySoup): the bit is the void, whatever shape it is.
     node tools/nso_extract_bit_exact_test.js        exit 0 = every gate held

   The void of a piece is its convex hull less the piece. The shipped core runs under node through tools/nso_csg_node.js.
     1. a closed tube (open-ended bore): the bit is the cylinder in the bore, flush at both ends, volume = pi r^2 L
     2. a threaded hole (a nut from nso_thread.js): the bit is a threaded rod - its volume is the bore's, and a ray out
        from the axis meets a crest radius and a root radius, so it is not a plain cylinder
     3. a sealed cavity inside a block: the bit is the cavity
     4. two sealed cavities: the largest is the bit and the count says 2
     5. a solid ball, a solid block: no cavity, said so (noCavity), nothing guessed
     6. the bit is a solid the kernel takes back: closed and 2-manifold */
'use strict';
const T = require('../nso_thread.js');
const { csgContext } = require('./nso_csg_node.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -  ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function soupVolume(s) {
  let v = 0;
  for (let i = 0; i < s.length; i += 9) {
    v += (s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) +
          s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6])) / 6;
  }
  return v;
}
function bounds(s) {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], s[i + k]); hi[k] = Math.max(hi[k], s[i + k]); }
  return { lo, hi };
}
/* Radial extent of the soup's vertices about the z axis, within a z band. */
function radii(s, z0, z1) {
  let mn = 1e9, mx = 0;
  for (let i = 0; i < s.length; i += 3) {
    if (s[i + 2] < z0 || s[i + 2] > z1) continue;
    const r = Math.hypot(s[i], s[i + 1]);
    mn = Math.min(mn, r); mx = Math.max(mx, r);
  }
  return { mn, mx };
}

(async () => {
  const c = csgContext();
  const wasm = await c.NSO_CSG.load();
  const M = wasm.Manifold;
  const soupOf = m => c.NSO_CSG.manifoldToSoup(m);

  /* 1. closed tube, bore open at both ends */
  const tube = soupOf(M.cylinder(30, 15, 15, 96, true).subtract(M.cylinder(32, 12, 12, 96, true)));
  let r = await c.NSO_cavitySoup(tube);
  const want1 = Math.PI * 144 * 30;
  check('tube: a bit comes out', r.ok, r.reason);
  check('tube: it is the cylinder in the bore (volume ' + (r.ok ? r.volumeMm3.toFixed(0) : '-') + ' of ' + want1.toFixed(0) + ')',
    r.ok && near(r.volumeMm3, want1, want1 * 0.01));
  if (r.ok) {
    const b = bounds(r.soup), rr = radii(r.soup, -20, 20);
    check('tube: flush with both ends (z -15 .. 15), radius 12 not the 15 of the outside',
      near(b.lo[2], -15, 1e-3) && near(b.hi[2], 15, 1e-3) && near(rr.mx, 12, 0.02), 'z ' + b.lo[2].toFixed(3) + '..' + b.hi[2].toFixed(3) + ', r max ' + rr.mx.toFixed(3));
    check('tube: one void, not the four corners of its bounding box', r.voids === 1);
  }

  /* 2. threaded hole: a nut's bore */
  const nut = T.nut({ size: 'M6' });
  check('threaded: nut built', nut.ok, nut.reason);
  if (nut.ok) {
    r = await c.NSO_cavitySoup(nut.soup);
    check('threaded: a bit comes out', r.ok, r.reason);
    if (r.ok) {
      const b = bounds(r.soup), mid = (b.lo[2] + b.hi[2]) / 2;
      const rr = radii(r.soup, mid - 2, mid + 2);
      const nutV = Math.abs(soupVolume(nut.soup));
      const hexV = Math.abs(soupVolume(c.NSO_CSG.manifoldToSoup(c.NSO_CSG.soupToManifold(wasm, nut.soup).hull())));
      check('threaded: the bit is a rod with a thread - crest and root radii differ by the thread depth (' + rr.mn.toFixed(2) + ' .. ' + rr.mx.toFixed(2) + ')',
        rr.mx - rr.mn > 0.5 && rr.mx > 3 && rr.mx < 3.5);
      check('threaded: its volume is the hull less the nut (' + r.volumeMm3.toFixed(1) + ' vs ' + (hexV - nutV).toFixed(1) + ')',
        near(r.volumeMm3, hexV - nutV, 0.01 * hexV));
      check('threaded: it is far from a plain cylinder of its own extent (volume < 97% of the cylinder it would fill)',
        r.volumeMm3 < 0.97 * Math.PI * rr.mx * rr.mx * (b.hi[2] - b.lo[2]));
      const back = c.NSO_CSG.soupToManifold(wasm, r.soup);
      check('threaded: the bit is a closed solid the kernel takes back', back.status() === 'NoError' && back.volume() > 0 && r.stats && r.stats.open === 0 && r.stats.nm === 0);
      back.delete();
    }
  }

  /* 3 + 4. sealed cavities */
  const blk = M.cube([40, 40, 40], true);
  const one = soupOf(blk.subtract(M.sphere(8, 48)));
  r = await c.NSO_cavitySoup(one);
  check('sealed cavity: the bit is the cavity (sphere r 8)', r.ok && near(r.volumeMm3, 4 / 3 * Math.PI * 512, 4 / 3 * Math.PI * 512 * 0.02) && r.voids === 1, r.ok ? r.volumeMm3.toFixed(0) : r.reason);
  const two = soupOf(blk.subtract(M.sphere(8, 48)).subtract(M.sphere(4, 32).translate([20 - 8, 0, 0])).subtract(M.sphere(4, 32).translate([0, 12, 0])));
  r = await c.NSO_cavitySoup(two);
  check('two cavities: the largest is the bit, and it is said there were more', r.ok && r.voids >= 2 && near(r.volumeMm3, 4 / 3 * Math.PI * 512, 4 / 3 * Math.PI * 512 * 0.05), r.ok ? r.voids + ' voids, ' + r.volumeMm3.toFixed(0) : r.reason);

  /* 5. nothing to extract */
  r = await c.NSO_cavitySoup(soupOf(M.sphere(10, 48)));
  check('solid ball: no cavity, said so', !r.ok && r.noCavity === true, r.reason);
  r = await c.NSO_cavitySoup(soupOf(blk));
  check('solid block: no cavity, said so', !r.ok && r.noCavity === true, r.reason);

  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
