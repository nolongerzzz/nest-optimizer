#!/usr/bin/env node
// Headless self-test for nso_bridge.js (Bridge).
//
//   node tools/nso_bridge_test.js        exit 0 = every gate held
//
// Loads the shipped files with vm, in index.html's order (tools/nso_bridge_testlib.js).
// The union is the shipped one too: tools/nso_csg_node.js splices app-join.js's
// NSO_CSG adapter and NSO_unionSoups into node, so a string or sheet goes
// through the same kernel call Set makes in the page.
//
// Every number is measured on the OUTPUT soup by code that is not the
// bridge's own: sections are sliced out with NSO_PathSweep.sectionLoops, the
// topology is counted by tools/mesh_validate.py (the canonical checker) on an
// STL written from the output, and the kernel's own component count.
//
//   1. the ring: MINI_TPU_TEST cut through its axis, the halves 20 mm apart,
//      both gaps bridged face to face -> one closed ring, the band's section
//      the cut section within 0.02 mm, 40 mm longer all round
//   2. two boxes face to face, one turned 10 degrees -> a twist-free loft
//   3. two spheres, point to point -> one solid, the rod Ø2
//   4. two bars, edge to edge -> the sheet as thick as set, welded
//   4b. a sheet is wound outward whichever way its two edges run (and in one piece)
//   5. every guard, in its own words
//
// Prints a table at the end; the PR quotes it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const L = require('./nso_bridge_testlib.js');
const LIBDIR = require('./nso_library_dir.js');
const { readSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');

const ctx = L.bridgeContext();
const BR = ctx.NSO_Bridge, S = ctx.NSO_PathSweep;
const csg = csgContext();
const union = (a, b) => csg.NSO_unionSoups(a, b);

let pass = 0, fail = 0;
const FAILS = [], TABLE = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-bridge-'));

// tools/mesh_validate.py on the output, as written to disk.
function canonical(name, soup) {
  const file = L.writeSTL(path.join(TMP, name + '.stl'), soup);
  const out = execFileSync('python3', [path.join(L.ROOT, 'tools', 'mesh_validate.py'), file, '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const j = JSON.parse(out);
  const si = j.self_intersection || {};
  const ok = j.open_edges === 0 && j.nonmanifold_edges === 0 && j.inconsistent_winding_edges === 0 &&
             j.degenerate_tris === 0 && (si.pierce || 0) === 0 && j.signed_volume > 0;
  check(name + ': mesh_validate - closed, manifold, wound one way, no degenerate faces, nothing piercing', ok,
    'open ' + j.open_edges + ', non-manifold ' + j.nonmanifold_edges + ', winding ' + j.inconsistent_winding_edges +
    ', degenerate ' + j.degenerate_tris + ', pierce ' + si.pierce + ', coplanar ' + si.coplanar + ', Euler ' + j.euler_characteristic +
    ', vol ' + j.signed_volume.toFixed(3));
  return j;
}

function end(pieces, i, T, hit) { return { piece: i, target: BR.pick(T[i], hit.tri, hit.point) }; }
function hitAt(soup, p, n) { const t = L.triAt(soup, p, n); return { tri: t, point: p }; }

// Distance from p to a closed polyline (3D points).
function toPoly(p, loop) {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], L2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / L2)) : 0;
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1], p[2] - a[2] - t * d[2]));
  }
  return best;
}
// Two-way worst distance between two loops, after moving `b` by `shift`.
function loopGap(a, b, shift) {
  const bb = b.map(p => [p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]]);
  let w = 0;
  a.forEach(p => { w = Math.max(w, toPoly(p, bb)); });
  bb.forEach(p => { w = Math.max(w, toPoly(p, a)); });
  return w;
}
function perimeter(loop) { let s = 0; for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; s += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); } return s; }
const ms = t0 => (Date.now() - t0) + ' ms';

(async () => {
  /* =================================================================== 1 */
  console.log('\n=== 1. the ring: MINI_TPU_TEST cut twice, halves 20 mm apart, both gaps bridged ===');
  const tpuFile = LIBDIR.libraryDir() && LIBDIR.catalogFile('MINI_TPU_TEST.stl');
  if (!tpuFile) {
    LIBDIR.skip('section 1: MINI_TPU_TEST.stl (nest-library), the ring -> oval case');
  } else {
    const tpu = readSTL(tpuFile), b = L.bounds(tpu);
    const cx = (b.lo[0] + b.hi[0]) / 2, zm = (b.lo[2] + b.hi[2]) / 2;
    // One plane through the axis cuts the band twice: two C-shaped halves,
    // each with two cut faces. rawCut is the Cut tool's own engine.
    const lowH = ctx.rawCut(tpu, 0, cx, false), highH = L.shift(ctx.rawCut(tpu, 0, cx, true), [20, 0, 0]);
    const cutSec = S.sectionLoops(tpu, [cx, 0, 0], [1, 0, 0]);
    check('the cut leaves two halves, the ring\'s section two 1 × 8 mm loops', lowH && highH && cutSec && cutSec.length === 2,
      (lowH.length / 9) + ' + ' + (highH.length / 9) + ' triangles');
    const yTop = b.hi[1] - 0.5, yBot = b.lo[1] + 0.5;
    const P1 = [lowH, highH], T1 = P1.map(s => BR.index(s));
    const a1 = end(P1, 0, T1, hitAt(lowH, [cx, yTop, zm], [1, 0, 0])), b1 = end(P1, 1, T1, hitAt(highH, [cx + 20, yTop, zm], [-1, 0, 0]));
    check('both presses pick the cut faces as faces', a1.target.kind === 'face' && b1.target.kind === 'face', a1.target.text + ' | ' + b1.target.text);
    let t0 = Date.now();
    const p1 = BR.plan(P1, a1, b1, {});
    const tPlan1 = Date.now() - t0;
    check('gap 1 plans a band', p1.ok && p1.kind === 'band', p1.reason || p1.text);
    const r1 = await BR.weld(p1, {});
    check('gap 1 welds: ONE piece, closed', r1.ok && r1.topo.shells === 1 && r1.topo.open === 0 && r1.topo.nm === 0,
      JSON.stringify(r1.topo || r1.reason));
    const R1 = r1.soup, T2 = [BR.index(R1)];
    const a2 = end([R1], 0, T2, hitAt(R1, [cx, yBot, zm], [1, 0, 0])), b2 = end([R1], 0, T2, hitAt(R1, [cx + 20, yBot, zm], [-1, 0, 0]));
    t0 = Date.now();
    const p2 = BR.plan([R1], a2, b2, {});
    check('gap 2, both faces on the one piece now, plans a band', p2.ok && p2.kind === 'band', p2.reason || p2.text);
    const r2 = await BR.weld(p2, {});
    const tAll2 = Date.now() - t0;
    const R2 = r2.soup;
    check('gap 2 welds: one closed piece, still a ring (Euler 0)', r2.ok && r2.topo.shells === 1 && r2.topo.open === 0 && r2.topo.nm === 0 &&
      r2.topo.badWinding === 0 && r2.topo.euler === 0, JSON.stringify(r2.topo));
    check('the loops matched point for point - identical parallel faces give a plain straight band, no new points',
      p1.matches[0].counts.out === 4 && p2.matches[0].counts.out === 4 && Math.abs(p1.twistDeg) < 1e-6 && r1.split === 0 && r2.split === 0,
      'stations ' + p1.matches[0].counts.out + ', twist ' + p1.twistDeg.toExponential(1) + '°, walls split ' + r1.split);
    // The band's section is the cut section.
    const mid = S.sectionLoops(R2, [cx + 10, 0, 0], [1, 0, 0]);
    let worst = Infinity;
    if (mid && mid.length === 2) {
      worst = 0;
      mid.forEach(lp => {
        const g = lp.reduce((s, p) => s + p[1], 0) / lp.length;
        const ref = cutSec.find(c => Math.sign(c.reduce((s, p) => s + p[1], 0)) === Math.sign(g));
        worst = Math.max(worst, loopGap(lp, ref, [10, 0, 0]));
      });
    }
    check('the band\'s section, sliced 10 mm into the gap, is the cut section within 0.02 mm', worst <= 0.02,
      (mid ? mid.length : 0) + ' loop(s), worst ' + worst.toExponential(2) + ' mm');
    // Length: every path round the ring 40 mm longer.
    const secZ0 = S.sectionLoops(tpu, [0, 0, zm + 0.123], [0, 0, 1]), secZ1 = S.sectionLoops(R2, [0, 0, zm + 0.123], [0, 0, 1]);
    const per = l => l.map(perimeter).sort((x, y) => y - x);
    const pa = per(secZ0), pb = per(secZ1);
    check('the oval is the ring + 40 mm all round: outer and bore perimeter each grow 40.000 mm (±0.02)',
      Math.abs(pb[0] - pa[0] - 40) <= 0.02 && Math.abs(pb[1] - pa[1] - 40) <= 0.02,
      'outer ' + pa[0].toFixed(4) + ' -> ' + pb[0].toFixed(4) + ', bore ' + pa[1].toFixed(4) + ' -> ' + pb[1].toFixed(4));
    const A = S.loopArea(cutSec[0], [1, 0, 0]) + S.loopArea(cutSec[1], [1, 0, 0]);
    const dv = BR.volume(R2) - BR.volume(tpu);
    check('volume added = the cut section × 20 mm, twice (0.1%)', Math.abs(dv - A * 20) <= 1e-3 * A * 20,
      dv.toFixed(3) + ' mm³ vs ' + (A * 20).toFixed(3));
    const span = L.bounds(R2);
    check('the oval is 20 mm longer along the gap and the same across it',
      Math.abs((span.hi[0] - span.lo[0]) - (b.hi[0] - b.lo[0]) - 20) < 1e-4 && Math.abs((span.hi[1] - span.lo[1]) - (b.hi[1] - b.lo[1])) < 1e-6);
    canonical('ring->oval gap 1', R1);
    const j = canonical('ring->oval', R2);
    TABLE.push(['ring → oval (MINI_TPU_TEST)', (tpu.length / 9) + ' → ' + (R2.length / 9), 'band ×2', 'Euler ' + j.euler_characteristic,
      'section ≤ ' + worst.toExponential(1) + ' mm', tPlan1 + ' / ' + tAll2 + ' ms']);
  }

  /* =================================================================== 2 */
  console.log('\n=== 2. two boxes face to face, one turned 10° ===');
  {
    const A = L.box(0, 0, 0, 20, 20, 20);
    const B = L.turnZ(L.box(35, 0, 0, 55, 20, 20), 10, [45, 10, 0]);
    const P = [A, B], T = P.map(s => BR.index(s));
    const hb = L.rayHit(B, [27, 10, 10], [1, 0, 0]);
    const a = end(P, 0, T, hitAt(A, [20, 10, 10], [1, 0, 0])), b = end(P, 1, T, hb);
    check('both picks are faces', a.target.kind === 'face' && b.target.kind === 'face', a.target.text + ' | ' + b.target.text);
    const t0 = Date.now();
    const p = BR.plan(P, a, b, {});
    check('plans a band 10° off square', p.ok && Math.abs(p.opposeDeg - 10) < 1e-3, p.reason || p.text);
    const M = p.matches && p.matches[0];
    // Twist-free: every corner of A runs to the corner of B on the same side.
    const gA = [20, 10, 10], gB = (() => { let s = [0, 0, 0]; M.stations.forEach(x => { s = s.map((v, k) => v + x.b[k]); }); return s.map(v => v / M.stations.length); })();
    const same = M.stations.every(x => Math.sign(x.a[2] - gA[2]) === Math.sign(x.b[2] - gB[2]) &&
      Math.sign(x.a[1] - gA[1]) === Math.sign(x.b[1] - gB[1]));
    check('twist-free: 4 corners to the 4 corners on the same sides, turn under the 10° yaw', M.counts.out === 4 && same && Math.abs(p.twistDeg) <= 10 + 1e-6,
      'stations ' + M.counts.out + ', largest spoke turn ' + p.twistDeg.toFixed(3) + '°');
    const r = await BR.weld(p, {});
    check('one closed piece', r.ok && r.topo.shells === 1 && r.topo.open === 0 && r.topo.nm === 0 && r.topo.euler === 2, JSON.stringify(r.topo));
    const j = canonical('boxes 10° yaw', r.soup);
    TABLE.push(['two boxes, 10° yaw', '12 + 12 → ' + (r.soup.length / 9), 'band', 'Euler ' + j.euler_characteristic, 'twist ' + p.twistDeg.toFixed(2) + '°', ms(t0)]);
  }

  console.log('\n=== 2b. a square face to a round one: new points, walls split, still closed ===');
  {
    const A = L.box(0, 0, 0, 20, 20, 20);
    const n = 32, circ = Array.from({ length: n }, (_, i) => [10 + 8 * Math.cos(2 * Math.PI * i / n), 10 + 8 * Math.sin(2 * Math.PI * i / n)]);
    const t = [];
    for (let i = 0; i < n; i++) {
      const p = circ[i], q = circ[(i + 1) % n];
      t.push([40, p[0], p[1]], [40, q[0], q[1]], [70, q[0], q[1]], [40, p[0], p[1]], [70, q[0], q[1]], [70, p[0], p[1]]);
      t.push([70, 10, 10], [70, p[0], p[1]], [70, q[0], q[1]]); t.push([40, 10, 10], [40, q[0], q[1]], [40, p[0], p[1]]);
    }
    const R = new Float32Array(t.flat());
    const P = [A, R], T = P.map(s => BR.index(s));
    const t0 = Date.now();
    const p = BR.plan(P, end(P, 0, T, hitAt(A, [20, 10, 10], [1, 0, 0])), end(P, 1, T, L.rayHit(R, [30, 10.3, 10.2], [1, 0, 0])), {});
    check('a 20 mm square to a Ø16 round plans a band', p.ok && /rectangle to round Ø16/.test(p.text), p.reason || p.text);
    const r = await BR.weld(p, {});
    check('the square\'s walls take the round\'s points (split, no T-junction): closed, one piece', r.ok && r.split === 4 &&
      r.topo.open === 0 && r.topo.nm === 0 && r.topo.badWinding === 0 && r.topo.shells === 1 && r.topo.euler === 2,
      'walls split ' + r.split + ', ' + JSON.stringify(r.topo));
    const j = canonical('square->round', r.soup);
    TABLE.push(['square → round', '12 + 128 → ' + (r.soup.length / 9), 'band', 'Euler ' + j.euler_characteristic,
      p.matches[0].counts.a + '/' + p.matches[0].counts.b + ' → ' + p.matches[0].counts.out + ' points', ms(t0)]);
  }

  /* =================================================================== 3 */
  console.log('\n=== 3. two spheres, point to point: a string ===');
  {
    const A = L.sphere([0, 0, 10], 8, 32, 16), B = L.sphere([30, 0, 10], 8, 32, 16);
    const P = [A, B], T = P.map(s => BR.index(s));
    const ha = L.rayHit(A, [0.01, 0.3, 10.2], [1, 0, 0]), hb = L.rayHit(B, [29.99, 0.3, 10.2], [-1, 0, 0]);
    const a = end(P, 0, T, ha), b = end(P, 1, T, hb);
    check('a sphere is points, not faces', a.target.kind === 'point' && b.target.kind === 'point', a.target.kind + ' | ' + b.target.kind);
    const t0 = Date.now();
    const p = BR.plan(P, a, b, {});
    check('plans a string Ø2 (the default)', p.ok && p.kind === 'string' && p.diameterMm === 2, p.reason || p.text);
    check('each end sunk by the rim gap + 0.5 mm (Assemble\'s seat)', p.ok && p.engageMm.every((e, i) => Math.abs(e - p.rimGapMm[i] - 0.5) < 1e-12 && e >= 0.5),
      p.ok ? 'gap ' + p.rimGapMm.map(x => x.toFixed(4)).join(' / ') + ', sunk ' + p.engageMm.map(x => x.toFixed(4)).join(' / ') : '');
    const r = await BR.weld(p, { union });
    check('welds into ONE solid (the kernel\'s own count)', r.ok && r.parts === 1 && r.kernel && r.kernel.open === 0 && r.kernel.nm === 0,
      r.ok ? 'parts ' + r.parts + ' (A ' + r.partsA + ', B ' + r.partsB + ')' : r.reason);
    const sec = r.ok && S.sectionLoops(r.soup, [15, 0, 0], [1, 0, 0]);
    let dia = NaN;
    if (sec && sec.length === 1) {
      // nso_section.js's own circle fit: the circle the rod's vertices sit on
      const fit = ctx.NSO_sectionFitCircle(sec[0].map(q => [q[1], q[2]]));
      dia = fit ? 2 * fit.r : NaN;
    }
    check('the rod, sliced halfway, is Ø2.000 (its vertex circle)', Math.abs(dia - 2) < 2e-3, 'Ø' + dia.toFixed(4) + ', ' + p.segments + ' sides');
    const j = r.ok ? canonical('spheres string', r.soup) : null;
    TABLE.push(['two spheres, string', (A.length / 9) + ' + ' + (B.length / 9) + ' → ' + (r.ok ? r.soup.length / 9 : '-'), 'string Ø2',
      j ? 'Euler ' + j.euler_characteristic : '-', 'Ø' + dia.toFixed(3), ms(t0)]);
  }

  /* =================================================================== 4 */
  console.log('\n=== 4. two bars, edge to edge: a sheet ===');
  {
    const A = L.box(0, 0, 0, 60, 5, 5), B = L.box(0, 15, 0, 60, 20, 5);
    const P = [A, B], T = P.map(s => BR.index(s));
    const a = end(P, 0, T, hitAt(A, [30, 4.9, 5], [0, 0, 1])), b = end(P, 1, T, hitAt(B, [30, 15.1, 5], [0, 0, 1]));
    check('a press near a face\'s straight rim edge picks the whole edge', a.target.kind === 'edge' && b.target.kind === 'edge' &&
      Math.abs(a.target.lengthMm - 60) < 1e-6 && Math.abs(b.target.lengthMm - 60) < 1e-6, a.target.text + ' | ' + b.target.text);
    const def = BR.sheetDefault(P, a, b, {});
    check('the thickness defaults to the thinner piece\'s wall (5 mm bars: 5)', Math.abs(def.mm - 5) < 1e-6 && def.floorMm === 0.8, JSON.stringify(def));
    const t0 = Date.now();
    const p = BR.plan(P, a, b, { thicknessMm: 2 });
    check('plans a 2 mm sheet, flush with the bars\' tops', p.ok && p.kind === 'sheet' && p.thicknessMm === 2 && p.mode === 'flush', p.reason || p.text);
    const r = await BR.weld(p, { union });
    check('welds along both edges into ONE solid', r.ok && r.parts === 1 && r.kernel && r.kernel.open === 0 && r.kernel.nm === 0,
      r.ok ? 'parts ' + r.parts : r.reason);
    // Thickness, measured: slice across the middle, read the loop at y = 10.37
    // (off the union's own vertices, so the crossing is a crossing).
    let th = NaN, top = NaN;
    const YM = 10.37;
    const sec = r.ok && S.sectionLoops(r.soup, [30, 0, 0], [1, 0, 0]);
    if (sec && sec.length === 1) {
      const zs = [];
      const lp = sec[0];
      for (let i = 0; i < lp.length; i++) {
        const p0 = lp[i], p1 = lp[(i + 1) % lp.length];
        if ((p0[1] - YM) * (p1[1] - YM) < 0) zs.push(p0[2] + (p1[2] - p0[2]) * (YM - p0[1]) / (p1[1] - p0[1]));
      }
      if (zs.length === 2) { th = Math.abs(zs[0] - zs[1]); top = Math.max(zs[0], zs[1]); }
    }
    check('the sheet, sliced across, is 2.000 mm thick, its top flush at z 5', Math.abs(th - 2) < 1e-4 && Math.abs(top - 5) < 1e-4,
      'thickness ' + th.toFixed(5) + ', top ' + top.toFixed(5) + ' (' + (sec ? sec.length : 0) + ' loop)');
    const vol = r.ok ? BR.volume(r.soup) : 0, want = 2 * 1500 + 60 * 10 * 2;
    check('volume = two bars + a 60 × 10 × 2 sheet (the sunk ends add nothing)', Math.abs(vol - want) < 1e-3 * want, vol.toFixed(3) + ' vs ' + want);
    const j = r.ok ? canonical('bars sheet', r.soup) : null;
    TABLE.push(['two bars, sheet', '12 + 12 → ' + (r.ok ? r.soup.length / 9 : '-'), 'sheet 2 mm', j ? 'Euler ' + j.euler_characteristic : '-',
      'thick ' + th.toFixed(4), ms(t0)]);
  }

  /* ================================================================== 4b */
  console.log('\n=== 4b. a sheet is wound outward whichever way its edges run ===');
  {
    // Two bars; the sheet runs from A's top rim at y 5 to B's top rim at y 15. A face's
    // edges run round its own loop, so which way a picked edge runs depends on which
    // face it was picked from: A's top face and B's top face give edges running opposite
    // ways, A's +y side face and B's top face give edges running the same way.
    const A = L.box(0, 0, 0, 60, 5, 5), B = L.box(0, 15, 0, 60, 20, 5);
    const want = 2 * 1500 + 60 * 10 * 2;
    const ran = {};
    for (const [name, ha, hb] of [
      ['same direction', hitAt(A, [30, 5, 4.9], [0, 1, 0]), hitAt(B, [30, 15.1, 5], [0, 0, 1])],
      ['opposite direction', hitAt(A, [30, 4.9, 5], [0, 0, 1]), hitAt(B, [30, 15.1, 5], [0, 0, 1])]]) {
      const P = [A, B], T = P.map(s => BR.index(s));
      const a = end(P, 0, T, ha), b = end(P, 1, T, hb);
      ran[name] = Math.sign(b.target.b[0] - b.target.a[0]) * Math.sign(a.target.b[0] - a.target.a[0]);
      const p = BR.plan(P, a, b, { thicknessMm: 2 });
      check(name + ': plans a flush 2 mm sheet', p.ok && p.mode === 'flush', p.reason || p.text);
      const wv = p.ok ? BR.volume(p.web) : NaN;
      check(name + ': the slab is wound outward (positive volume)', wv > 0, 'web volume ' + wv.toFixed(3));
      const r = await BR.weld(p, { union });
      check(name + ': welds closed into ONE solid', r.ok && r.parts === 1 && r.topo.open === 0 && r.topo.nm === 0 && r.topo.badWinding === 0,
        r.ok ? 'parts ' + r.parts : r.reason);
      const vol = r.ok ? BR.volume(r.soup) : 0;
      check(name + ': volume = two bars + the 2 mm sheet', Math.abs(vol - want) < 1e-3 * want, vol.toFixed(3) + ' vs ' + want);
      ran[name + ' vol'] = vol;
    }
    check('the picked edges run the same way in one case and opposite ways in the other', ran['same direction'] === 1 && ran['opposite direction'] === -1,
      JSON.stringify({ same: ran['same direction'], opposite: ran['opposite direction'] }));
    check('both build the same sheet (same welded volume)', Math.abs(ran['same direction vol'] - ran['opposite direction vol']) < 1e-6 * want,
      ran['same direction vol'].toFixed(3) + ' / ' + ran['opposite direction vol'].toFixed(3));

    // The slab, the other way round: a plan's slab handed in inside-out is turned out again.
    const P0 = [A, B], T0 = P0.map(s => BR.index(s));
    const p0 = BR.plan(P0, end(P0, 0, T0, hitAt(A, [30, 4.9, 5], [0, 0, 1])), end(P0, 1, T0, hitAt(B, [30, 15.1, 5], [0, 0, 1])), { thicknessMm: 2 });
    const rev = new Float32Array(p0.web);
    for (let o = 0; o < rev.length; o += 9) for (let k = 0; k < 3; k++) { const t = rev[o + 3 + k]; rev[o + 3 + k] = rev[o + 6 + k]; rev[o + 6 + k] = t; }
    const turned = BR.outward(new Float32Array(rev));
    check('a slab handed in inside-out (volume ' + BR.volume(rev).toFixed(0) + ') is turned outward', BR.volume(rev) < 0 && Math.abs(BR.volume(turned) - BR.volume(p0.web)) < 1e-6,
      BR.volume(turned).toFixed(3) + ' vs ' + BR.volume(p0.web).toFixed(3));

    // Same piece: a U (a base and two arms, one solid), the sheet across its mouth
    // between the arms' inner top edges.
    const base = L.box(0, 0, 0, 60, 10, 5), arm1 = L.box(0, 8, 0, 15, 30, 5), arm2 = L.box(45, 8, 0, 60, 30, 5);
    const u = await union(await union(base, arm1).then(x => x.soup), arm2);
    const U = u.soup, PU = [U], TU = [BR.index(U)];
    const e1 = end(PU, 0, TU, hitAt(U, [14.9, 20, 5], [0, 0, 1])), e2 = end(PU, 0, TU, hitAt(U, [45.1, 20, 5], [0, 0, 1]));
    check('the two arm edges are picked as edges', e1.target.kind === 'edge' && e2.target.kind === 'edge', e1.target.text + ' | ' + e2.target.text);
    for (const [name, x, y] of [['first to second arm', e1, e2], ['second to first arm', e2, e1]]) {
      const p = BR.plan(PU, x, y, { thicknessMm: 2 });
      check('same piece, ' + name + ': plans a sheet', p.ok && p.kind === 'sheet', p.reason || p.text);
      const wv = p.ok ? BR.volume(p.web) : NaN;
      check('same piece, ' + name + ': the slab is wound outward', wv > 0, 'web volume ' + wv.toFixed(3));
      const r = await BR.weld(p, { union });
      const uv = BR.volume(U), vol = r.ok ? BR.volume(r.soup) : 0, wantU = uv + 30 * 20 * 2;
      check('same piece, ' + name + ': welds closed into ONE solid', r.ok && r.topo.open === 0 && r.topo.nm === 0 && r.topo.badWinding === 0 && r.topo.shells === 1 && Math.abs(vol - wantU) < 1e-3 * wantU,
        r.ok ? 'shells ' + r.topo.shells + ', volume ' + vol.toFixed(3) + ' (U ' + uv.toFixed(3) + ')' : r.reason);
    }
  }

  /* =================================================================== 5 */
  console.log('\n=== 5. the guards, each in its own words, before anything is built ===');
  {
    // An L block: its horizontal arm stands between its upright arm and a box.
    const Lp = [[0, 0], [40, 0], [40, 10], [10, 10], [10, 30], [0, 30]];
    const LB = L.prismXY(Lp, 0, 10, 3), BX = L.box(50, 2, 0, 60, 8, 10);
    const P = [LB, BX], T = P.map(s => BR.index(s));
    let p = BR.plan(P, end(P, 0, T, hitAt(LB, [10, 20, 5], [1, 0, 0])), end(P, 1, T, hitAt(BX, [50, 5, 5], [-1, 0, 0])), {});
    check('band through a piece', !p.ok && /would pass through the first piece/.test(p.reason), p.reason);
    p = BR.plan(P, end(P, 0, T, { tri: L.triAt(LB, [10, 12, 5], [1, 0, 0]), point: [10, 12, 5] }),
      { piece: 1, target: { kind: 'point', tri: L.triAt(BX, [50, 5, 5], [-1, 0, 0]), point: [50, 5, 5], normal: [-1, 0, 0] } }, {});
    check('string through a piece', !p.ok && /string would pass through the first piece - something stands between/.test(p.reason), p.reason);

    const A = L.box(0, 0, 0, 20, 20, 20), B = L.box(40, 0, 0, 60, 20, 20), Bup = L.box(40, 30, 0, 60, 50, 20);
    let PP = [A, Bup], TT = PP.map(s => BR.index(s));
    p = BR.plan(PP, end(PP, 0, TT, hitAt(A, [20, 10, 10], [1, 0, 0])), end(PP, 1, TT, hitAt(Bup, [50, 30, 10], [0, -1, 0])), {});
    check('faces more than 60° from facing each other', !p.ok && /90\.0° from facing each other - a band takes faces no more than 60°/.test(p.reason), p.reason);
    PP = [A, B]; TT = PP.map(s => BR.index(s));
    p = BR.plan(PP, end(PP, 0, TT, hitAt(A, [0, 10, 10], [-1, 0, 0])), end(PP, 1, TT, hitAt(B, [60, 10, 10], [1, 0, 0])), {});
    check('faces facing away from each other', !p.ok && /faces face away from each other/.test(p.reason), p.reason);

    // An L (20 x 20, 4 thick) and the same L turned half round, 3 mm above it.
    const L20 = [[0, 0], [20, 0], [20, 4], [4, 4], [4, 20], [0, 20]];
    const Lup = L.turnZ(L.prismXY(L20, 13, 23, 3), 180, [10, 10, 0]);
    const LA = L.prismXY(L20, 0, 10, 3);
    PP = [LA, Lup]; TT = PP.map(s => BR.index(s));
    p = BR.plan(PP, end(PP, 0, TT, L.rayHit(LA, [2, 2, 30], [0, 0, -1])), end(PP, 1, TT, L.rayHit(Lup, [18, 18, 11], [0, 0, 1])), {});
    check('outlines whose loft would cross itself', !p.ok && /band between these faces would cross itself/.test(p.reason), p.reason);
    PP = [LA, L.prismXY(L20, 13, 23, 3)]; TT = PP.map(s => BR.index(s));
    p = BR.plan(PP, end(PP, 0, TT, L.rayHit(PP[0], [2, 2, 30], [0, 0, -1])), end(PP, 1, TT, L.rayHit(PP[1], [2, 2, 11], [0, 0, 1])), {});
    check('...the same L lofted to itself is a plain band', p.ok, p.reason || p.text);

    const SA = L.sphere([0, 0, 10], 8, 32, 16), SB = L.sphere([17, 0, 10], 8, 32, 16);
    PP = [SA, SB]; TT = PP.map(s => BR.index(s));
    p = BR.plan(PP, end(PP, 0, TT, L.rayHit(SA, [0.01, 0.2, 10.1], [1, 0, 0])), end(PP, 1, TT, L.rayHit(SB, [16.99, 0.2, 10.1], [-1, 0, 0])), {});
    check('a string shorter than its own diameter', !p.ok && /shorter than its own Ø2/.test(p.reason), p.reason);

    const bars = [L.box(0, 0, 0, 60, 5, 5), L.box(0, 15, 0, 60, 20, 5)], TB = bars.map(s => BR.index(s));
    p = BR.plan(bars, end(bars, 0, TB, hitAt(bars[0], [30, 4.9, 5], [0, 0, 1])), end(bars, 1, TB, hitAt(bars[1], [30, 17, 5], [0, 0, 1])), {});
    check('an edge to a face is refused: a sheet runs edge to edge', !p.ok && /one end is an edge and the other a face/.test(p.reason), p.reason);
    p = BR.plan(bars, end(bars, 0, TB, hitAt(bars[0], [30, 4.9, 5], [0, 0, 1])), end(bars, 1, TB, hitAt(bars[1], [30, 15.1, 5], [0, 0, 1])), { thicknessMm: 0.5 });
    check('a sheet under two nozzle widths', !p.ok && /under two nozzle widths \(0\.8 mm\)/.test(p.reason), p.reason);
    const tilted = [L.box(0, 0, 0, 60, 5, 5), L.box(0, 15, 3, 60, 20, 8)].map((s, i) => i ? L.turnZ(s, 0, [0, 0, 0]) : s);
    const raised = [tilted[0], (() => { const s = L.box(0, 15, 0, 60, 20, 5); const o = new Float32Array(s); for (let i = 0; i < o.length; i += 3) o[i + 2] += o[i] * 0.1; return o; })()];
    const TR = raised.map(s => BR.index(s));
    p = BR.plan(raised, end(raised, 0, TR, hitAt(raised[0], [30, 4.9, 5], [0, 0, 1])),
      end(raised, 1, TR, L.rayHit(raised[1], [30, 15.1, 20], [0, 0, -1])), {});
    check('two edges not in one plane', !p.ok && /not in one plane/.test(p.reason), p.reason);
  }

  console.log('\n=== table ===');
  console.log('| case | triangles | web | topology | measured | time |');
  console.log('|---|---|---|---|---|---|');
  TABLE.forEach(r => console.log('| ' + r.join(' | ') + ' |'));
  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (fail ? ': ' + FAILS.join('; ') : ''));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
