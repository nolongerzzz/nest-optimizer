#!/usr/bin/env node
/* patch:test - Patch fills a hole with a surface that follows what is round it,
   at every hole size.   node tools/nso_patch_test.js   (exit 0 = every gate held)

   THE BUG. A circular hole in a sphere has a rim that lies in ONE plane, so the
   engine took the rim for a flat floor and capped it flat: the bigger the hole,
   the bigger the facet. The fix reads the SURROUND (a ring of the piece's own
   vertices out from the rim), fits a surface to it - a least-squares sphere,
   else Lift 3's quadric - and puts the fill's interior vertices ON that fit. If
   no fit follows the surround it says so, per hole.

   1. R15. A generated sphere R 15 (icosphere, edge 0.5 mm), four holes cut by
      planes so each rim is EXACTLY planar and exactly the size named: O 2, 5, 9
      and 14 mm.
        - the rims are flat (the trap): the card would have said CAP; it says PATCH
        - every fill vertex, and the middle of every fill triangle, is within
          0.05 mm of R 15; the fill has interior vertices at every size
        - the fill is at the surround's triangle density and well shaped
        - closed, manifold, one shell, Euler 2, tools/mesh_validate.py PASS
        - nothing outside the holes moves: the piece's own triangles are kept
          byte for byte, and every new triangle stands inside its own hole
        - the control: the flat cap on the same holes FAILS the same measure
          (so the measure is not blind), and Patch is deterministic
   2. QUADRIC. A saddle (no sphere follows it): the fit is the quadric, and the
      fill's interior is on it to float precision.
   3. NEVER SILENT. A noisy sphere no fit follows: the readout says NO SURFACE FIT
      and why, and what was done (faired, or FLAT with opts.fallback 'flat').
      A flat floor is the flat cap and says so; a cube's face too; CAP asked for
      says "as asked".
   4. THE USER'S SPHERE (fixtures/damage/shape-sphere_holes-shredded.stl, R 4.822,
      five shells): both big loops are filled on the sphere, closed and manifold.
      Reported, not gated: the canonical checker's piercing pairs, where a fill
      stands on a fragment that already lies on the same sphere. */
'use strict';
const path = require('path');
const P = require('../nso_patch.js');
const RL = require('./nso_repair_loop_lib.js');

let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const f3 = x => x.toFixed(3);
const f6 = x => x.toExponential(2);

/* ------------------------------------------------------------- the fixture */
const { icosphere, clip, soupOfTris, R, HOLES, sphereWithHoles } = require('./nso_patch_fixtures.js');
const rad = (s, o) => Math.hypot(s[o], s[o + 1], s[o + 2]);

/* How far a fill is from R 15: its vertices, and the middle of every triangle
   and of every edge - a flat cap has only rim vertices, which sit on the sphere,
   so the vertices alone cannot tell it from a surface. */
function offSphere(soup, from, to, R0, c0) {
  c0 = c0 || [0, 0, 0];
  let vtx = 0, mid = 0, interior = new Set();
  for (let t = from; t < to; t++) {
    const p = [0, 1, 2].map(k => [soup[t * 9 + k * 3] - c0[0], soup[t * 9 + k * 3 + 1] - c0[1], soup[t * 9 + k * 3 + 2] - c0[2]]);
    p.forEach(q => { vtx = Math.max(vtx, Math.abs(Math.hypot(...q) - R0)); });
    const pts = [[0, 1, 2].map(i => (p[0][i] + p[1][i] + p[2][i]) / 3), [0, 1, 2].map(i => (p[0][i] + p[1][i]) / 2), [0, 1, 2].map(i => (p[1][i] + p[2][i]) / 2), [0, 1, 2].map(i => (p[2][i] + p[0][i]) / 2)];
    pts.forEach(q => { mid = Math.max(mid, Math.abs(Math.hypot(...q) - R0)); });
  }
  return { vtx, mid };
}
/* The shape of the fill's triangles. A triangle that stands on a tiny edge of the piece's own
   rim (the plane that cut a hole grazed a vertex and left a 0.01 mm edge) is a sliver whatever
   the fill does, so those are left out: minEdge is the shortest edge allowed in the count. */
function triQuality(soup, from, to, minEdge) {
  const angs = [];
  for (let t = from; t < to; t++) {
    const p = [0, 1, 2].map(k => [soup[t * 9 + k * 3], soup[t * 9 + k * 3 + 1], soup[t * 9 + k * 3 + 2]]);
    const e = [0, 1, 2].map(k => Math.hypot(...p[(k + 1) % 3].map((x, i) => x - p[k][i])));
    if (Math.min(...e) < minEdge) continue;
    const ang = k => Math.acos(Math.max(-1, Math.min(1, (e[(k + 1) % 3] ** 2 + e[(k + 2) % 3] ** 2 - e[k] ** 2) / (2 * e[(k + 1) % 3] * e[(k + 2) % 3])))) * 180 / Math.PI;
    angs.push(Math.min(ang(0), ang(1), ang(2)));
  }
  angs.sort((a, b) => a - b);
  return { n: angs.length, min: angs[0], p5: angs[Math.floor(angs.length * 0.05)], median: angs[angs.length >> 1] };
}

/* ======================================================================= 1. */
console.log('patch:test - Patch follows the surround at every hole size\n');
console.log('1. R 15 with holes of O 2, 5, 9 and 14 mm');
const soup = sphereWithHoles(), n0 = soup.length / 9;
{
  const loops = P.loops(soup);
  check('four loops, none unclosed', loops.length === 4 && loops.unclosed === 0, loops.map(l => l.n).join('+'));
  const sizes = loops.map(l => P.describe(soup, l));
  const dia = loops.map(l => 2 * Math.max(...l.pts.map(p => Math.hypot(...p.map((x, i) => x - sizes[l.id].centre[i])))));
  const want = [14, 9, 5, 2];                                    // longest loop first
  check('the loops measure O 14, 9, 5 and 2 mm', want.every((w, i) => Math.abs(dia[i] - w) < 0.05), dia.map(f3).join(', '));
  check('every rim is FLAT (within the card\'s 0.05 mm): the trap that made them flat caps', sizes.every(s => s.planar), sizes.map(s => s.planarMm.toExponential(1)).join(', '));
  const pl = P.plan(soup);
  check('the card\'s choice for every one is PATCH, not CAP (a flat rim in a curved surround)', pl.loops.length === 4 && pl.loops.every(l => l.fix === 'patch' && l.rimPlanar && !l.planar), pl.loops.map(l => l.fix).join(','));

  const res = P.patch(soup, loops.map(l => l.id));
  check('Patch ran on all four', res.ok, res.reason);
  const fills = res.filled;
  check('every hole is fitted: a sphere', fills.every(f => f.fit.kind === 'sphere' && f.method === 'fitted surface' && f.curved), fills.map(f => f.fit.kind).join(','));
  check('of radius 15 (a small patch fixes its radius to ~1%) and following the surround to under 0.001 mm rms', fills.every(f => Math.abs(f.fit.radiusMm - R) < 0.15 && f.fit.rmsMm < 0.001), fills.map(f => f.fit.radiusMm.toFixed(4) + '/' + f6(f.fit.rmsMm)).join(' '));
  let t = n0;
  fills.forEach((f, i) => {
    const H = HOLES.find(h => h.d === want[i]), dev = offSphere(res.soup, t, t + f.tris, R);
    const rimN = loops[i].n;
    check('O ' + want[i] + ': every fill vertex within 0.05 mm of R 15, and the middle of every triangle and edge', dev.vtx < 0.05 && dev.mid < 0.05,
          'vertices ' + f6(dev.vtx) + ', middles ' + f6(dev.mid) + ' mm');
    check('O ' + want[i] + ': the fill has interior vertices, all on the fit', f.tris > rimN - 2 && f.fit.interiorMaxDevMm < 1e-9 && f.added > 0,
          f.added + ' interior vertices, ' + f.tris + ' triangles, interior off the fit ' + f6(f.fit.interiorMaxDevMm) + ' mm, rim ' + f6(f.fit.rimMaxDevMm) + ' mm');
    check('O ' + want[i] + ': the report is the fit\'s own numbers', f.fit.maxDevMm >= f.fit.rimMaxDevMm && f.fit.maxDevMm < 0.05 && Math.abs(f.diameterMm - want[i]) < 0.05 &&
          f.fit.samples > 20 && f.fit.ringMm >= 3, 'diameter ' + f3(f.diameterMm) + ', ' + f.fit.samples + ' surround vertices, ' + f.fit.ringMm + ' rings, max off the fit ' + f6(f.fit.maxDevMm));
    check('O ' + want[i] + ': at the surround\'s triangle density', f.fillEdgeMm > 0.7 * f.surroundEdgeMm && f.fillEdgeMm < 1.5 * f.surroundEdgeMm,
          'fill ' + f3(f.fillEdgeMm) + ' mm, surround ' + f3(f.surroundEdgeMm) + ' mm');
    const q = triQuality(res.soup, t, t + f.tris, 0.25 * f.surroundEdgeMm);
    check('O ' + want[i] + ': well-shaped triangles (not counting any on a tiny edge of the rim itself)', q.n >= 0.7 * f.tris && q.min > 10 && q.median > 40,
          q.n + ' of ' + f.tris + ' counted: min ' + q.min.toFixed(1) + ', median ' + q.median.toFixed(1) + ' degrees');
    // inside its own hole: every fill vertex is on the hole's side of the cutting plane (the rim is ON it)
    let inside = true;
    for (let k = t * 3; k < (t + f.tris) * 3; k++) {
      const o = k * 3, d = H.axis[0] * res.soup[o] + H.axis[1] * res.soup[o + 1] + H.axis[2] * res.soup[o + 2] - H.h;
      if (d < -0.01) inside = false;
    }
    check('O ' + want[i] + ': the fill stands inside its own hole', inside);
    t += f.tris;
  });
  check('nothing outside the holes moves: the piece\'s own ' + n0 + ' triangles are kept byte for byte', RL.sameBytes(res.soup, soup, soup.length));
  check('and the fill is all that was added', res.soup.length / 9 === n0 + fills.reduce((a, f) => a + f.tris, 0));
  const topo = P.topology(res.soup);
  check('closed, manifold, one shell, a sphere (Euler 2)', topo.open === 0 && topo.nm === 0 && topo.badWinding === 0 && topo.degenerate === 0 && topo.shells === 1 && topo.euler === 2, JSON.stringify(topo));
  const can = RL.canonical(res.soup, 'patch_r15');
  check('tools/mesh_validate.py: PASS, no piercing', can.open === 0 && can.nm === 0 && can.winding === 0 && can.degenerate === 0 && can.pierce === 0 && can.verdict === 'PASS', JSON.stringify(can));
  const vol = can.volume, ball = 4 / 3 * Math.PI * R ** 3;
  check('and it is a ball again: volume within 0.5% of 4/3 pi R^3', Math.abs(vol - ball) / ball < 0.005, f3(vol) + ' against ' + f3(ball));

  // each hole alone gives the same, and Patch is deterministic
  const again = P.patch(soup, loops.map(l => l.id));
  check('the same piece gives the same bytes twice', RL.sameBytes(again.soup, res.soup) && again.soup.length === res.soup.length);
  let one = true;
  for (const l of loops) {
    const r1 = P.patch(soup, [l.id]), f = r1.filled[0], dev = offSphere(r1.soup, n0, r1.soup.length / 9, R);
    if (!(r1.ok && f.fit.kind === 'sphere' && dev.vtx < 0.05 && dev.mid < 0.05 && P.topology(r1.soup).nm === 0)) one = false;
  }
  check('each hole patched alone is on R 15 as well', one);

  // the control: the flat cap on the same holes fails the same measure
  const capR = P.cap(soup, loops.map(l => l.id));
  let tc = n0;
  const capDev = capR.filled.map(f => { const d = offSphere(capR.soup, tc, tc + f.tris, R); tc += f.tris; return d; });
  check('control: the flat cap\'s middles are off R 15 by far more than 0.05 mm for O 5, 9 and 14 (so the measure is not blind)',
        capDev[0].mid > 1 && capDev[1].mid > 0.5 && capDev[2].mid > 0.1, capDev.map(d => f3(d.mid)).join(', ') + ' mm');
  check('control: and it has no interior vertex at any size, which Patch has at every one', capR.filled.every(f => f.added === undefined && f.method === 'flat cap'));
}

/* ======================================================================= 2. */
console.log('2. a quadric: a saddle no sphere follows');
{
  const N = 49, step = 0.5, half = (N - 1) * step / 2, z = (x, y) => 0.03 * (x * x - y * y);
  const tris = [];
  const pt = (i, j) => [i * step - half, j * step - half, z(i * step - half, j * step - half)];
  for (let i = 0; i < N - 1; i++) for (let j = 0; j < N - 1; j++) {
    const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
    if ((i + j) % 2) { tris.push([a, b, c], [a, c, d]); } else { tris.push([a, b, d], [b, c, d]); }
  }
  const keep = tris.filter(t => {
    const g = [0, 1].map(k => (t[0][k] + t[1][k] + t[2][k]) / 3);
    return Math.hypot(g[0] - 1.3, g[1] + 0.9) > 2.5;
  });
  const sd = soupOfTris(keep), loops = P.loops(sd);
  check('a sheet with one hole in it: two loops, the border and the hole', loops.length === 2, loops.map(l => l.n).join('+'));
  const hole = loops.find(l => l.n < 90), pl = P.plan(sd).loops[hole.id];
  check('the hole\'s rim is not flat; the card says PATCH', !P.describe(sd, hole).planar && pl.fix === 'patch');
  const r = P.patch(sd, [hole.id]), f = r.filled[0];
  check('Patch ran', r.ok, r.reason);
  check('the sphere does not follow it; the quadric does', f.fit.kind === 'quadric' && f.fit.passedOver && /no sphere/.test(f.fit.passedOver[0]) && f.fit.rmsMm < 0.01,
        'sphere: ' + (f.fit.passedOver || []).join(' / ') + '; quadric rms ' + f6(f.fit.rmsMm));
  let dev = 0, inner = 0;
  const vs = new Set();
  for (let t = sd.length / 9; t < r.soup.length / 9; t++) for (let k = 0; k < 3; k++) {
    const o = t * 9 + k * 3, key = r.soup[o] + ',' + r.soup[o + 1] + ',' + r.soup[o + 2];
    dev = Math.max(dev, Math.abs(r.soup[o + 2] - z(r.soup[o], r.soup[o + 1])));
  }
  check('every fill vertex is on the saddle z = 0.03 (x^2 - y^2) within 0.01 mm (the quadric stands over a tilted plane); the interior points on the fit to float precision',
        dev < 0.01 && f.fit.interiorMaxDevMm < 1e-9 && f.added > 0, f6(dev) + ' mm, ' + f.added + ' interior vertices');
  check('density: the surround\'s', f.fillEdgeMm > 0.7 * f.surroundEdgeMm && f.fillEdgeMm < 1.5 * f.surroundEdgeMm, f3(f.fillEdgeMm) + ' against ' + f3(f.surroundEdgeMm));
  const topo = P.topology(r.soup);
  check('the hole is closed; only the sheet\'s own border is open; manifold', topo.open === loops.find(l => l !== hole).n && topo.nm === 0 && topo.badWinding === 0, JSON.stringify(topo));
  check('the piece\'s own triangles are kept byte for byte', RL.sameBytes(r.soup, sd, sd.length));
}

/* ======================================================================= 3. */
console.log('3. never silent: no fit, a flat floor, CAP asked for');
{
  // a sphere with 0.15 mm of noise on every vertex: no sphere and no quadric follows it
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const noise = new Map();
  const jitter = p => { const k = p.join(','); if (!noise.has(k)) { const s = 1 + (rnd() - 0.5) * 0.02; noise.set(k, s); } return p.map(x => x * noise.get(k)); };
  const rough = icosphere(R, 4).map(t => t.map(jitter));
  // a jagged rim (the triangles whose middle is within 4.5 mm of the axis come out): not flat, no fit follows it
  const jag = rough.filter(t => {
    const g = [0, 1, 2].map(i => (t[0][i] + t[1][i] + t[2][i]) / 3);
    return !(g[2] > 0 && Math.hypot(g[0], g[1]) < 4.5);
  });
  const ns = soupOfTris(jag), l = P.loops(ns)[0];
  check('the rim of a hole in a noisy sphere is not flat, so the card says PATCH', !P.describe(ns, l).planar && P.plan(ns).loops[0].fix === 'patch');
  const r = P.patch(ns, [l.id]), f = r.filled[0], line = P.readout(f);
  check('a noisy sphere: Patch still closes the hole', r.ok && P.topology(r.soup).open === 0, r.reason);
  check('and says it found NO fit, and why (both rungs)', f.fit.kind === 'none' && /sphere/.test(f.fit.reason) && /quadric/.test(f.fit.reason), f.fit.reason);
  check('the fill is faired from the rim, not a facet: it has interior vertices', f.fit.fallback === 'faired' && f.method.indexOf('fairing') === 0 && f.tris > l.n - 2, f.method + ', ' + f.tris + ' triangles');
  check('the readout line says so', /^\u00d8\d+\.\d mm hole: NO SURFACE FIT \(.+\) - faired from the rim slopes, not on a fit$/.test(line), line);
  const rf = P.patch(ns, [l.id], { fallback: 'flat' }), ff = rf.filled[0];
  check('with fallback "flat" it fills flat and the readout says FLAT', rf.ok && ff.fit.kind === 'none' && ff.fit.fallback === 'flat' && ff.method === 'flat cap' && ff.tris === l.n - 2 && /filled FLAT$/.test(P.readout(ff)), P.readout(ff));
  // the same sphere cut by a plane: the rim is flat, no fit follows the surround - a flat cap, and it says why
  const fl = soupOfTris(clip(rough, [0, 0, 1], Math.sqrt(R * R - 4.5 * 4.5))), fr = P.patch(fl, [0]), fq = fr.filled[0];
  check('a flat rim in a surround no fit follows: the flat cap, and the readout says why', fr.ok && fq.fit.kind === 'none' && fq.fit.fallback === 'flat' && /the rim is flat, so the flat cap/.test(fq.fit.reason) && /filled FLAT$/.test(P.readout(fq)), P.readout(fq).slice(0, 160));

  // a flat floor: the surround is a plane
  const lid = RL.soupOf('repair/box_lid_hole.stl'), lr = P.patch(lid, [0]), lf = lr.filled[0];
  check('a hole in a flat lid: the surround is a plane, a flat cap, and the readout says so', lf.fit.kind === 'plane' && lf.method === 'flat cap' && lf.tris === 20 && /flat surround, flat cap$/.test(P.readout(lf)), P.readout(lf));
  // a cube's face: too few vertices for any fit to mean anything
  const cube = RL.soupOf('repair/synth_hole.stl'), cr = P.patch(cube, [0]), cf = cr.filled[0];
  check('a missing triangle of a cube face: no fit is possible, it is capped flat, and says why', cr.ok && cf.fit.kind === 'none' && cf.fit.fallback === 'flat' && /too few/.test(cf.fit.reason) && P.topology(cr.soup).open === 0, P.readout(cf));
  // CAP, asked for, on a hole in a sphere
  const capr = P.cap(soup, [P.loops(soup)[0].id]), capf = capr.filled[0];
  check('CAP asked for on a hole in a sphere is a flat cap "as asked"', capf.fit.kind === 'plane' && capf.fit.asked && /flat cap, as asked$/.test(P.readout(capf)), P.readout(capf));
  const rl = P.readout(P.patch(soup, [P.loops(soup)[3].id]).filled[0]);
  check('the readout line for a fitted hole: size, sphere radius, fit rms, how far the fill is from it', /^Ø2\.0 mm hole: sphere R 15\.\d\d mm \(fit rms 0\.00\d mm\), fill within 0\.00\d mm of it$/.test(rl), rl);
}

/* ======================================================================= 4. */
console.log('4. the user\'s sphere: fixtures/damage/shape-sphere_holes-shredded.stl');
{
  const sh = RL.soupOf('damage/shape-sphere_holes-shredded.stl'), m0 = sh.length / 9, C = [0, 0, 4.822];
  const loops = P.loops(sh);
  check('six loops, 221 open edges (five shells)', loops.length === 6 && loops.reduce((a, l) => a + l.n, 0) === 221 && P.topology(sh).shells === 5, loops.map(l => l.n).join('+'));
  const res = P.patch(sh, loops.map(l => l.id)), fills = res.filled;
  check('Patch ran on all six', res.ok, res.reason);
  console.log('     per hole:');
  fills.forEach(f => console.log('       ' + (loops[f.loop].n + ' edges').padEnd(10) + P.readout(f)));
  const big = fills.slice(0, 2);
  check('the two big loops (144 and 64 edges, one wrapping 218 degrees round the sphere) are fitted: a sphere of radius 4.822',
        big.every(f => f.fit.kind === 'sphere' && Math.abs(f.fit.radiusMm - 4.822) < 0.001), big.map(f => f.fit.kind + ' R ' + (f.fit.radiusMm || 0).toFixed(4)).join(', '));
  let t = m0;
  const devs = fills.map(f => { const d = offSphere(res.soup, t, t + f.tris, 4.822, C); t += f.tris; return d; });
  check('and their fills are on it: every vertex, triangle middle and edge middle within 0.05 mm of R 4.822',
        devs.slice(0, 2).every(d => d.vtx < 0.05 && d.mid < 0.05), devs.slice(0, 2).map(d => f6(d.vtx) + '/' + f6(d.mid)).join(' '));
  check('at the surround\'s density', big.every(f => f.fillEdgeMm > 0.7 * f.surroundEdgeMm && f.fillEdgeMm < 1.5 * f.surroundEdgeMm), big.map(f => f3(f.fillEdgeMm) + ' vs ' + f3(f.surroundEdgeMm)).join(', '));
  check('the four small loops are islands (a fragment\'s own edge, the "hole" is all the rest): none is filled flat without saying so',
        fills.slice(2).every(f => f.fit.kind !== 'none' || (f.fit.reason && f.fit.fallback)), fills.slice(2).map(f => f.fit.kind).join(','));
  const topo = P.topology(res.soup);
  check('closed, manifold, wound one way', topo.open === 0 && topo.nm === 0 && topo.badWinding === 0, JSON.stringify(topo));
  check('the piece\'s own 1015 triangles are kept byte for byte', RL.sameBytes(res.soup, sh, sh.length));
  const can = RL.canonical(res.soup, 'patch_shred');
  check('tools/mesh_validate.py: 0 open, 0 non-manifold, 0 mis-wound, 0 degenerate', can.open === 0 && can.nm === 0 && can.winding === 0 && can.degenerate === 0, JSON.stringify(can));
  console.log('     (reported, not gated: ' + can.pierce + ' piercing pairs - the original 10 before this change - where a fill stands on a fragment that already lies on the same sphere)');
}

console.log('\n----------------------------------------------------------');
console.log(fails ? 'FAIL (' + fails + ')' : 'PASS');
process.exit(fails ? 1 : 0);
