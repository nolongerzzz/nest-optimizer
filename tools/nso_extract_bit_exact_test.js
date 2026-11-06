#!/usr/bin/env node
/* Extract bit's void selection and boolean (nso_void.js + nso_csg.js NSO_cavityCore): the bit is the void you clicked.
     node tools/nso_extract_bit_exact_test.js        exit 0 = every gate held

   The click's point and normal go to NSO_Void.select, which answers with the void's WALL; NSO_cavitySoup (the shipped
   boolean under node, tools/nso_csg_node.js) takes the hull of that wall less the piece.
     1. a closed tube, clicked on the bore wall: the cylinder in the bore, flush at both ends
     2. a hex nut, clicked inside its threaded hole: a threaded rod - its volume is the bore's
     3. a socket-head bolt, clicked on the bottom of the Allen socket: the hex plug, and NOT the thread grooves
     4. a block with two blind holes: each click gets its own hole
     5. a sealed sphere and a smaller one: the click chooses, not the size
     6. a click on the OUTSIDE of a block or of a ball: refused in words, nothing guessed
     7. the bit is a closed solid the kernel takes back                                                          */
'use strict';
require('../nso_thickness.js');
require('../nso_hollow.js');
const V = require('../nso_void.js');
const T = require('../nso_thread.js');
const { csgContext } = require('./nso_csg_node.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -  ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function bounds(s) {
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], s[i + k]); hi[k] = Math.max(hi[k], s[i + k]); }
  return { lo, hi };
}
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
  /* The whole of Extract bit short of the page: pick -> wall -> boolean. */
  async function extract(soup, point, normal, opts) {
    const t0 = Date.now();
    const sel = V.select(soup, point, normal, opts);
    if (!sel.ok) return { ok: false, stage: 'select', reason: sel.reason, sel };
    const r = await c.NSO_cavitySoup(soup, sel.points, sel.seed);
    r.sel = sel; r.ms = Date.now() - t0;
    return r;
  }

  /* 1. closed tube, bore open at both ends */
  const tube = soupOf(M.cylinder(30, 15, 15, 96, true).subtract(M.cylinder(32, 12, 12, 96, true)));
  let r = await extract(tube, [12, 0, 3], [-1, 0, 0]);
  const want1 = Math.PI * 144 * 30;
  check('tube: a bit comes out of a click on the bore wall', r.ok, r.reason);
  if (r.ok) {
    console.log('      lid R ' + r.sel.R + ' (' + (r.sel.auto ? 'auto' : 'asked') + '), pitch ' + r.sel.pitch + ', ' + r.ms + ' ms; tried ' + JSON.stringify(r.sel.tried));
    check('tube: it is the cylinder in the bore (volume ' + r.volumeMm3.toFixed(0) + ' of ' + want1.toFixed(0) + ')', near(r.volumeMm3, want1, want1 * 0.005));
    check('tube: every triangle of the bore is its wall (' + r.sel.tris + ' of 192) - none dropped, so no ragged edge', r.sel.tris === 192);
    let top = 0; for (let i = 0; i < r.soup.length; i += 3) if (r.soup[i + 2] > 14.95) top++;
    check('tube: the lid is the whole 96-gon, not a part of it (' + top + ' vertices on the top plane)', top >= 96);
    const b = bounds(r.soup), rr = radii(r.soup, -20, 20);
    check('tube: flush with both ends, radius 12 not the 15 of the outside',
      near(b.lo[2], -15, 0.02) && near(b.hi[2], 15, 0.02) && near(rr.mx, 12, 0.02), 'z ' + b.lo[2].toFixed(3) + '..' + b.hi[2].toFixed(3) + ', r max ' + rr.mx.toFixed(3));
    check('tube: closed', r.stats && r.stats.open === 0 && r.stats.nm === 0);
  }

  /* 1b. a short wide ring: its lid would sag the whole way down at a small ball, so a big one is needed */
  const ring = soupOf(M.cylinder(12, 40, 40, 128, true).subtract(M.cylinder(14, 36, 36, 128, true)));
  r = await extract(ring, [36, 0, 2], [-1, 0, 0]);
  const wantRing = Math.PI * 36 * 36 * 12;
  check('short wide ring: the click on the bore gets the whole disc (' + (r.ok ? r.volumeMm3.toFixed(0) : r.reason) + ' of ' + wantRing.toFixed(0) + ')', r.ok && near(r.volumeMm3, wantRing, wantRing * 0.005));

  /* 2. threaded hole: a nut's bore */
  const nut = T.nut({ size: 'M6' });
  const nutB = bounds(nut.soup), nutMid = (nutB.lo[2] + nutB.hi[2]) / 2;
  r = await extract(nut.soup, [2.9, 0, nutMid], [-1, 0, 0]);
  check('threaded: a bit comes out of a click inside the thread', r.ok, r.reason);
  if (r.ok) {
    const b = bounds(r.soup), rr = radii(r.soup, nutMid - 1.5, nutMid + 1.5);
    const hull = c.NSO_CSG.soupToManifold(wasm, nut.soup).hull();
    const bore = hull.volume() - c.NSO_CSG.soupToManifold(wasm, nut.soup).volume();
    console.log('      lid R ' + r.sel.R + ', pitch ' + r.sel.pitch + ', ' + r.ms + ' ms; radii ' + rr.mn.toFixed(2) + '..' + rr.mx.toFixed(2) + ', z ' + b.lo[2].toFixed(2) + '..' + b.hi[2].toFixed(2));
    check('threaded: the thread is in the bit - crest and root radii differ (' + rr.mn.toFixed(2) + ' .. ' + rr.mx.toFixed(2) + ')', rr.mx - rr.mn > 0.5 && rr.mx > 3 && rr.mx < 3.5);
    check('threaded: its volume is the bore (' + r.volumeMm3.toFixed(2) + ' vs ' + bore.toFixed(2) + ')', near(r.volumeMm3, bore, 0.003 * bore));
    check('threaded: flush with both faces of the nut, z ' + b.lo[2].toFixed(3) + ' .. ' + b.hi[2].toFixed(3), near(b.lo[2], nutB.lo[2], 0.01) && near(b.hi[2], nutB.hi[2], 0.01));
    check('threaded: closed', r.stats && r.stats.open === 0 && r.stats.nm === 0);
  }

  /* 2b. the same, on three sizes and on the auto reach AND a big one: the bit is the nut's bore, none of it missing and no more
     than it (hull of the nut less the nut is the reference, from the kernel) */
  for (const size of ['M5', 'M8', 'M10']) {
    const nt = T.nut({ size });
    const nb = bounds(nt.soup), nm = c.NSO_CSG.soupToManifold(wasm, nt.soup), ref = nm.hull().subtract(nm);
    for (const opt of [{}, { R: 45 }]) {
      const rr = await extract(nt.soup, [0.9 * (parseFloat(size.slice(1)) / 2 + 0.2), 0, (nb.lo[2] + nb.hi[2]) / 2], [-1, 0, 0], opt);
      if (!rr.ok) { check(size + ' ' + JSON.stringify(opt) + ': a bit comes out', false, rr.reason); continue; }
      const bit = c.NSO_CSG.soupToManifold(wasm, rr.soup);
      const missing = ref.subtract(bit).volume(), extra = bit.subtract(ref).volume();
      check(size + ' ' + (opt.R ? 'Lid R 45' : 'auto (R ' + rr.sel.R + ')') + ': the whole bore, nothing missing (' + missing.toFixed(3) + ' mm3 of ' + ref.volume().toFixed(1) + ') and nothing extra (' + extra.toFixed(3) + ')',
        missing < 0.002 * ref.volume() && extra < 0.002 * ref.volume());
    }
  }

  /* 3. an Allen socket in a bolt head: NOT the thread grooves, NOT the whole bolt's hull */
  const bolt = T.bolt({ size: 'M6', length: 20, head: 'socket' });
  check('bolt built', bolt.ok, bolt.reason);
  if (bolt.ok) {
    const bb = bounds(bolt.soup);
    /* The head is down on the bed and the socket opens on the bed face (z = low): scan up the axis for its floor, the first crossing. */
    const P = require('../nso_thickness.js').prepare(bolt.soup, {});
    const hits = P.hitsAlong([0, 0, bb.lo[2] - 1], [0, 0, 1], 100);
    const sockBottom = bb.lo[2] - 1 + hits[0];
    console.log('      axis crossings ' + hits.map(h => (bb.lo[2] - 1 + h).toFixed(2)).join(', '));
    r = await extract(bolt.soup, [0, 0, sockBottom], [0, 0, -1]);
    check('bolt: a bit comes out of a click on the socket floor', r.ok, r.reason);
    if (r.ok) {
      const b = bounds(r.soup);
      console.log('      lid R ' + r.sel.R + ', pitch ' + r.sel.pitch + ', ' + r.ms + ' ms; bit ' + (b.hi[0] - b.lo[0]).toFixed(2) + ' x ' + (b.hi[1] - b.lo[1]).toFixed(2) + ' x ' + (b.hi[2] - b.lo[2]).toFixed(2) + ', ' + r.volumeMm3.toFixed(1) + ' mm3');
      check('bolt: the bit is the socket - hex, about 5 mm across, a few mm deep, not the 20 mm shank', (b.hi[2] - b.lo[2]) < 6 && (b.hi[0] - b.lo[0]) < 6.2 && (b.hi[0] - b.lo[0]) > 4);
      check('bolt: it is flush with the bed face the socket opens on, flat (z ' + b.lo[2].toFixed(2) + ' vs ' + bb.lo[2].toFixed(2) + ') and ends at the socket floor (z ' + b.hi[2].toFixed(2) + ' of ' + sockBottom.toFixed(2) + ')', near(b.lo[2], bb.lo[2], 0.05) && near(b.hi[2], sockBottom, 0.1));
    }
  }

  /* 4. two blind holes in a block: each click gets its own */
  const blk = M.cube([40, 40, 40], true);
  const holes = blk.subtract(M.cylinder(15, 4, 4, 64, false).translate([-10, 0, 5]))        // z 5..20: opens on the top (z = 20)
                   .subtract(M.cylinder(8, 2, 2, 64, false).translate([10, 0, 12]));         // z 12..20
  const hs = soupOf(holes);
  let ra = await extract(hs, [-6, 0, 12], [1, 0, 0]);                                         // wall of the big hole
  let rb = await extract(hs, [10, 0, 16], [0, 0, 0].map((v, i) => i === 0 ? -1 : v));         // wall of the small hole
  const vBig = Math.PI * 16 * 15, vSmall = Math.PI * 4 * 8;
  check('two holes: the click on the big one gets the big one (' + (ra.ok ? ra.volumeMm3.toFixed(0) : ra.reason) + ' of ' + vBig.toFixed(0) + ')', ra.ok && near(ra.volumeMm3, vBig, vBig * 0.03));
  check('two holes: the click on the small one gets the small one (' + (rb.ok ? rb.volumeMm3.toFixed(0) : rb.reason) + ' of ' + vSmall.toFixed(0) + ')', rb.ok && near(rb.volumeMm3, vSmall, vSmall * 0.05));
  if (ra.ok) { const b = bounds(ra.soup); check('two holes: the big one is flush with the top of the block (z ' + b.hi[2].toFixed(2) + ')', near(b.hi[2], 20, 0.05)); }

  /* 5. sealed cavities: the click chooses, not the size */
  const two = soupOf(blk.subtract(M.sphere(8, 48)).subtract(M.sphere(4, 32).translate([13, 0, 0])));
  ra = await extract(two, [8, 0, 0], [-1, 0, 0]);
  rb = await extract(two, [13 + 4, 0, 0], [-1, 0, 0]);
  const sBig = 4 / 3 * Math.PI * 512, sSmall = 4 / 3 * Math.PI * 64;
  check('two cavities: the click on the big one gets it (' + (ra.ok ? ra.volumeMm3.toFixed(0) : ra.reason) + ' of ' + sBig.toFixed(0) + ')', ra.ok && near(ra.volumeMm3, sBig, sBig * 0.03));
  check('two cavities: the click on the small one gets it (' + (rb.ok ? rb.volumeMm3.toFixed(0) : rb.reason) + ' of ' + sSmall.toFixed(0) + ')', rb.ok && near(rb.volumeMm3, sSmall, sSmall * 0.05));

  /* 6. the outside */
  r = await extract(soupOf(blk), [20, 0, 0], [1, 0, 0]);
  check('solid block, click on its outside: refused in words', !r.ok, r.reason);
  r = await extract(soupOf(M.sphere(10, 48)), [10, 0, 0], [1, 0, 0]);
  check('solid ball, click on its outside: refused in words', !r.ok, r.reason);

  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
