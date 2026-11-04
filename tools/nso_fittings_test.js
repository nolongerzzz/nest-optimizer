#!/usr/bin/env node
// Headless self-test for nso_fittings.js (Fittings: the slip-on Cap, the 2- and 3-way Splitter).
//
//   node tools/nso_fittings_test.js        exit 0 = every gate held
//
// Loads the shipped files, in index.html's order, into THIS realm (the Manifold kernel's
// vector arguments are plain arrays, which it only takes from its own realm). Every number is
// measured on the OUTPUT soup by code that shares nothing with the construction:
//   - walls, bores and the closed end by casting rays through the mesh (Moller-Trumbore) at
//     places the construction did not put a vertex;
//   - topology by an exact-bit weld and edge counter written below, with the Euler number
//     checked against the thickened sphere-with-holes it should be: 4 - 2 x openings;
//   - tools/mesh_validate.py --gate on every output.
// The splitter runs on the app's own kernel (nso_csg.js, Manifold) through tools/nso_csg_node.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { writeSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');
for (const f of ['NSO_Repair.js', 'nso_thickness.js', 'nso_stock.js', 'nso_section.js', 'nso_bend.js', 'nso_tube_edge.js', 'nso_fittings.js']) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
}
const F = globalThis.NSO_Fittings, S = globalThis.NSO_Stock;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-fittings-'));
const f3 = x => (+x).toFixed(3);
const near = (a, b, t) => Math.abs(a - b) <= t;
const TABLE = [];

/* ------------------------------------------------------------- measuring */

function topo(s) {
  const key = i => s[i] + ',' + s[i + 1] + ',' + s[i + 2];
  const ids = new Map(), vid = [];
  for (let i = 0; i < s.length; i += 3) { const k = key(i); if (!ids.has(k)) ids.set(k, ids.size); vid.push(ids.get(k)); }
  const E = new Map();
  let degen = 0;
  for (let t = 0; t < vid.length / 3; t++) {
    const a = vid[t * 3], b = vid[t * 3 + 1], c = vid[t * 3 + 2];
    if (a === b || b === c || a === c) degen++;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const k = Math.min(p, q) + ':' + Math.max(p, q), e = E.get(k) || { n: 0, f: 0 };
      e.n++; if (p < q) e.f++; E.set(k, e);
    }
  }
  let open = 0, nm = 0, flip = 0;
  E.forEach(e => { if (e.n === 1) open++; else if (e.n > 2) nm++; else if (e.f !== 1) flip++; });
  return { tris: vid.length / 3, verts: ids.size, open, nm, flip, degen, euler: ids.size - E.size + vid.length / 3 };
}
function volume(s) {
  let v = 0;
  for (let o = 0; o < s.length; o += 9) {
    v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7]) - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6]) +
         s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]);
  }
  return v / 6;
}
// the distances along a ray (origin o, unit direction d) at which it crosses the mesh, ascending
function rayHits(s, o, d) {
  const hits = [];
  for (let t = 0; t < s.length; t += 9) {
    const e1 = [s[t + 3] - s[t], s[t + 4] - s[t + 1], s[t + 5] - s[t + 2]], e2 = [s[t + 6] - s[t], s[t + 7] - s[t + 1], s[t + 8] - s[t + 2]];
    const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-12) continue;
    const tv = [o[0] - s[t], o[1] - s[t + 1], o[2] - s[t + 2]], u = (tv[0] * p[0] + tv[1] * p[1] + tv[2] * p[2]) / det;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const q = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
    const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) / det;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const dist = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (dist > 1e-9) hits.push(dist);
  }
  hits.sort((a, b) => a - b);
  return hits.filter((h, i) => i === 0 || h - hits[i - 1] > 1e-6);          // an edge hit is one crossing, not two
}
function bbox(s) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], s[i + k]); hi[k] = Math.max(hi[k], s[i + k]); }
  return { lo, hi };
}
function meshValidate(name, soup) {
  const file = path.join(TMP, name + '.stl');
  writeSTL(file, soup);
  let out;
  try { out = execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json', '--gate'], { encoding: 'utf8', maxBuffer: 64 << 20 }); }
  catch (e) { out = e.stdout; }
  try { const j = JSON.parse(out); return { pass: j.verdict === 'PASS', fails: j.verdict_fails || [], pierce: j.self_intersection ? j.self_intersection.pierce : null }; }
  catch (e) { return { pass: false, fails: ['no JSON from mesh_validate: ' + String(out).slice(0, 80)] }; }
}
function closed(tag, soup, euler) {
  const T = topo(soup);
  check(tag + ': closed, 2-manifold, consistently wound, no zero-area faces, Euler ' + euler,
    T.open === 0 && T.nm === 0 && T.flip === 0 && T.degen === 0 && T.euler === euler, `open ${T.open} nm ${T.nm} flip ${T.flip} degen ${T.degen} euler ${T.euler}`);
  const MV = meshValidate(tag.replace(/[^a-z0-9]+/gi, '_'), soup);
  check(tag + ': mesh_validate --gate PASS', MV.pass, MV.pass ? 'pierce ' + MV.pierce : (MV.fails || []).join('; '));
  check(tag + ': wound outward (volume > 0)', volume(soup) > 0, f3(volume(soup)) + ' mm³');
  return T;
}

const stockTube = (rOut, wall, h) => S.revolve(S.profileTube(rOut, rOut - wall, h), 96);
// an imported-style 48-sided tube along Z: Ø16 / Ø12, its own winding by construction
function polyTube(n, rOut, rIn, h) {
  const circle = r => Array.from({ length: n }, (_, i) => { const a = 2 * Math.PI * i / n; return [r * Math.cos(a), r * Math.sin(a)]; });
  const O = circle(rOut), I = circle(rIn), t = [];
  for (let i = 0; i < n; i++) {
    const a = O[i], b = O[(i + 1) % n], c = I[i], d = I[(i + 1) % n];
    t.push([a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], h], [a[0], a[1], 0], [b[0], b[1], h], [a[0], a[1], h]);
    t.push([d[0], d[1], 0], [c[0], c[1], 0], [c[0], c[1], h], [d[0], d[1], 0], [c[0], c[1], h], [d[0], d[1], h]);
    t.push([a[0], a[1], h], [b[0], b[1], h], [d[0], d[1], h], [a[0], a[1], h], [d[0], d[1], h], [c[0], c[1], h]);
    t.push([a[0], a[1], 0], [d[0], d[1], 0], [b[0], b[1], 0], [a[0], a[1], 0], [c[0], c[1], 0], [d[0], d[1], 0]);
  }
  return new Float32Array(t.flat());
}

(async () => {
  /* ===================================================================== CAP */
  console.log('\n=== 1. the Cap: a slip-on cup for the end of a stock tube ===');
  {
    // the tube in the screenshot that started this: Ø40.62 outside, 5.078 wall, 40.623 tall
    const tube = stockTube(20.311, 5.078, 40.623);
    const r = F.capFromTube(tube, {});
    console.log('   ' + r.reason);
    check('cap from a Stock tube: made', r.ok, r.reason);
    const T = closed('cap on Ø40.62 / wall 5.078', r.soup, 2);
    const I = r.info, n = I.segments, flat = Math.PI / n;                     // measure on a flat, where the apothem is
    check('read off the tube\'s end: Ø40.62 and wall 5.078 (not typed)', near(I.tubeOdMm, 40.622, 2e-3) && near(I.wallMm, 5.078, 2e-3), f3(I.tubeOdMm) + ' / ' + f3(I.wallMm));
    // a horizontal ray from outside through the middle of the cup's wall, at a flat
    const dir = [-Math.cos(flat), -Math.sin(flat), 0], o = [100 * Math.cos(flat), 100 * Math.sin(flat), 10];
    const h = rayHits(r.soup, o, dir).map(d => 100 - d);                       // radii where it crosses, outermost first
    check('the wall is the tube\'s: outside apothem ' + f3(h[0]) + ', bore ' + f3(h[1]) + ' - a ' + f3(h[0] - h[1]) + ' mm wall',
      h.length === 4 && near(h[0] - h[1], 5.078, 1e-3) && near(h[2] - h[3], 5.078, 1e-3), h.map(f3).join(' / '));
    check('the bore is the tube\'s outside + 0.25 mm all round: apothem ' + f3(h[1]) + ' = 20.311 + 0.25', near(h[1], 20.311 + 0.25, 1e-3));
    // up the middle from below: the closed end is the tube's wall thick
    const up = rayHits(r.soup, [5, 0, -10], [0, 0, 1]).map(d => d - 10);
    check('the closed end is the same wall thick: z 0 to ' + f3(up[1]) + ' (5.078), and the top is open', up.length === 2 && near(up[0], 0, 1e-6) && near(up[1], 5.078, 1e-3), up.map(f3).join(' / '));
    const bb = bbox(r.soup);
    check('closed end down on z = 0, the open end up: ' + f3(bb.hi[2]) + ' mm tall = 30 deep + the 5.078 end', near(bb.lo[2], 0, 1e-6) && near(bb.hi[2], 30 + 5.078, 1e-3), f3(bb.lo[2]) + '..' + f3(bb.hi[2]));
    // the fit, measured against the tube itself: its most distant vertex vs the cup's flats
    const tb = bbox(tube), rTube = Math.max(...Array.from({ length: tube.length / 3 }, (_, i) => Math.hypot(tube[i * 3], tube[i * 3 + 1])));
    check('it slips on: clearance from the tube\'s widest vertex (r ' + f3(rTube) + ') to the bore\'s flats is ' + f3(h[1] - rTube) + ' mm (asked 0.25), and the tube is long enough for the ' + I.depthMm + ' mm it goes in',
      near(h[1] - rTube, 0.25, 2e-3) && tb.hi[2] - tb.lo[2] >= I.depthMm, f3(tb.hi[2] - tb.lo[2]));
    check('volume equals the revolved loop\'s own (Pappus), within float32', near(volume(r.soup), (function () {
      const Rin = (20.311 + 0.25) / Math.cos(flat), Rout = (20.311 + 0.25 + 5.078) / Math.cos(flat), pf = n * Math.sin(2 * Math.PI / n) / (2 * Math.PI);
      return Math.PI * pf * (Rout * Rout * (30 + 5.078) - Rin * Rin * 30);
    })(), 0.5), f3(volume(r.soup)));
    TABLE.push({ name: 'cap on Ø40.62 / 5.078 tube, 30 deep', tris: T.tris, ms: '', extra: 'bore Ø' + f3(I.boreDiaMm) + ' wall ' + f3(I.wallMm) });
    // the other end of the tube
    const rb = F.capFromTube(tube, { point: [0, 18, 0.5] });
    check('click the bottom end: the same cap (the tube is the same at both ends)', rb.ok && near(rb.info.tubeOdMm, I.tubeOdMm, 1e-4) && near(rb.info.wallMm, I.wallMm, 1e-4), rb.reason);
  }
  {
    // other sizes: the wall carried is each tube's own, never a default
    for (const [od, wall, h] of [[8, 1.2, 30], [16, 1.6, 50], [63.5, 3, 80]]) {
      const t = stockTube(od / 2, wall, h), r = F.capFromTube(t, {});
      const flat = Math.PI / r.info.segments, dir = [-Math.cos(flat), -Math.sin(flat), 0], o = [200 * Math.cos(flat), 200 * Math.sin(flat), 4];
      const hh = rayHits(r.soup, o, dir).map(d => 200 - d);
      check('Ø' + od + ' tube, wall ' + wall + ': the cap\'s wall is ' + wall + ' and its bore Ø' + (od + 0.5), r.ok && hh.length === 4 && near(hh[0] - hh[1], wall, 1e-3) && near(hh[1], od / 2 + 0.25, 1e-3),
        r.ok ? hh.map(f3).join(' / ') : r.reason);
      if (r.ok) closed('cap on Ø' + od + ' / ' + wall, r.soup, 2);
    }
    check('default depth: 0.75 × the tube\'s Ø, 8 to 30 mm (Ø8 -> 8, Ø16 -> 12, Ø63.5 -> 30)', F.capDepthFor(8) === 8 && F.capDepthFor(16) === 12 && F.capDepthFor(63.5) === 30, [8, 16, 63.5].map(F.capDepthFor).join(' / '));
    const pt = polyTube(48, 8, 6, 30), r = F.capFromTube(pt, { gap: 0.3, depth: 10 });
    const flat = Math.PI / r.info.segments, hh = rayHits(r.soup, [200 * Math.cos(flat), 200 * Math.sin(flat), 4], [-Math.cos(flat), -Math.sin(flat), 0]).map(d => 200 - d);
    check('an imported 48-sided Ø16 / Ø12 tube (corners at r 8): typed 0.3 mm gap and 10 mm depth; the bore\'s flats clear its corners by 0.30', r.ok && near(hh[1] - 8, 0.3, 2e-3) && near(r.info.heightMm, 10 + 2, 1e-6), r.ok ? hh.map(f3).join(' / ') : r.reason);
    closed('cap on the 48-sided tube', r.soup, 2);
  }
  console.log('\n=== 2. the Cap\'s refusals, in words, nothing made ===');
  {
    const no = (tag, r, re) => { console.log('   ' + r.reason); check('refused: ' + tag, !r.ok && !r.soup && re.test(r.reason), r.reason); };
    no('a wall under the nozzle-safety floor', F.capFromTube(stockTube(10, 0.3, 30), {}), /^a 0\.30 mm wall is under the nozzle-safety floor of 0\.42 mm \(nso_thickness\.js: one extrusion line at a 0\.4 mm nozzle\) - the cap would not print solid$/);
    no('a negative fit gap', F.cap({ od: 20, wall: 2, gap: -0.1 }), /^a fit gap of -0\.10 mm is refused - it is the clearance round the tube, 0 or more$/);
    no('no Ø', F.cap({ wall: 2 }), /^enter the tube's outside Ø in mm, more than 0$/);
    no('a depth of 0', F.cap({ od: 20, wall: 2, depth: 0 }), /^the depth the tube goes in must be more than 0$/);
    no('an end under the floor', F.cap({ od: 20, wall: 2, endWall: 0.2 }), /^a 0\.20 mm end is under the nozzle-safety floor/);
    const box = S.boxSoup(30, 20, 10);
    no('a closed piece - the reader\'s words, with the cap\'s tail', F.capFromTube(box, {}), /that end is closed|not a circular ring.* A cap fits the open, round end of a tube\.$/);
    // a flared end: the cap slips over a straight pipe
    const flared = globalThis.NSO_tubeEdgeRaw(stockTube(10, 1.6, 40), { verb: 'flare', length: 8, angle: 30 });
    no('a flared end - its wall leans 30°', F.capFromTube(flared.tris, {}), /^that tube's wall leans 30\.0° off its axis at the end \(a flare or a taper\) - a cap slips over a straight pipe, within 2°$/);
  }

  /* ================================================================ SPLITTER */
  console.log('\n=== 3. the Splitter: one trunk into 2 or 3 branches, a piece of its own ===');
  const wasm = await csgContext().NSO_CSG.load();
  const unit = (az, tilt) => [Math.sin(tilt) * Math.cos(az), Math.sin(tilt) * Math.sin(az), Math.cos(tilt)];
  // the branch's section, measured at its middle by a ray from outside across its axis (square to it, through a vertex
  // of both its cylinders): the outside radius, then the bore's
  function branchWall(soup, p, az) {
    const th = p.angle * Math.PI / 180, ax = unit(az, th), mid = p.trunkLen + p.branchLen / 2;
    const c = [ax[0] * p.branchLen / 2, ax[1] * p.branchLen / 2, p.trunkLen + ax[2] * p.branchLen / 2];
    // local +x after tilt about Y then turn about Z by az
    const n = [Math.cos(th) * Math.cos(az), Math.cos(th) * Math.sin(az), -Math.sin(th)];
    const o = [c[0] + 60 * n[0], c[1] + 60 * n[1], c[2] + 60 * n[2]];
    return rayHits(soup, o, [-n[0], -n[1], -n[2]]).map(d => 60 - d).slice(0, 4);      // the four across this branch; the ray runs on through the rest
  }
  for (const [ways, opts, tag] of [[2, {}, '2-way, defaults'], [3, {}, '3-way, defaults']]) {
    const t0 = Date.now(), r = await F.splitter(Object.assign({ ways }, opts), wasm), ms = Date.now() - t0;
    console.log('   ' + r.reason);
    check(tag + ': made', r.ok, r.reason);
    if (!r.ok) continue;
    const I = r.info, P = F.splitterSize(Object.assign({ ways }, opts)).p;
    const T = closed(tag, r.soup, 4 - 2 * (ways + 1));
    check(tag + ': one body, genus ' + (ways) + ' (a thickened sphere with ' + (ways + 1) + ' openings)', I.genus === ways && I.openings === ways + 1, 'genus ' + I.genus);
    // the trunk: a ray across it at mid-height, through a vertex of both cylinders
    const tw = rayHits(r.soup, [60, 0, P.trunkLen / 2], [-1, 0, 0]).map(d => 60 - d);
    check(tag + ': the trunk is Ø20 outside, Ø16 bore, wall 2 (rays: ' + tw.map(f3).join(' / ') + ')', tw.length === 4 && near(tw[0], 10, 1e-3) && near(tw[1], 8, 1e-3) && near(tw[2], -8, 1e-3) && near(tw[3], -10, 1e-3));
    const azs = ways === 2 ? [0, Math.PI] : [0, 2 * Math.PI / 3, 4 * Math.PI / 3];
    azs.forEach((az, i) => {
      const bw = branchWall(r.soup, P, az);
      const rbo = P.branchOd / 2, rbi = rbo - 2;
      check(tag + ': branch ' + (i + 1) + ' (' + Math.round(az * 180 / Math.PI) + '°) is Ø' + P.branchOd + ' outside, Ø' + (2 * rbi) + ' bore, wall 2 (' + bw.map(f3).join(' / ') + ')',
        bw.length === 4 && near(bw[0], rbo, 2e-3) && near(bw[1], rbi, 2e-3) && near(bw[2], -rbi, 2e-3) && near(bw[3], -rbo, 2e-3));
      // open: from the junction along the branch's axis nothing is crossed on the way out
      const ax = unit(az, P.angle * Math.PI / 180), out = rayHits(r.soup, [0, 0, P.trunkLen], ax);
      check(tag + ': branch ' + (i + 1) + ' is open at its end - nothing crossed from the junction out along its axis', out.length === 0, out.map(f3).join(','));
    });
    // the inlet is open and the hub's dome is where it should be: up the trunk's axis, the bore's dome then the outside's
    // - the bore's end is where the axis leaves the hub's chamber AND every branch's bore: the larger of the hub's radius and the
    // branch bore's crotch (r / sin angle); the outside's the same with the outer radii
    const sn = Math.sin(P.angle * Math.PI / 180), ro = P.od / 2, rbO = P.branchOd / 2, hubO = Math.max(ro, rbO), hubI = hubO - P.wall;
    const wantI = P.trunkLen + Math.max(hubI, (rbO - P.wall) / sn), wantO = P.trunkLen + Math.max(hubO, rbO / sn);
    const dome = rayHits(r.soup, [0, 0, -10], [0, 0, 1]).map(d => d - 10);
    check(tag + ': up the axis from the open inlet: the bore ends at z ' + f3(wantI) + ' (hub chamber or branch crotch, whichever reaches further) and the outside at ' + f3(wantO),
      dome.length === 2 && near(dome[0], wantI, 0.03) && near(dome[1], wantO, 0.03), dome.map(f3).join(' / '));
    const bb = bbox(r.soup), th = P.angle * Math.PI / 180, rb = P.branchOd / 2;
    check(tag + ': inlet flat on the bed (z 0), the highest outlet corner at z ' + f3(P.trunkLen + P.branchLen * Math.cos(th) + rb * Math.sin(th)),
      near(bb.lo[2], 0, 1e-5) && near(bb.hi[2], P.trunkLen + P.branchLen * Math.cos(th) + rb * Math.sin(th), 0.05), f3(bb.lo[2]) + '..' + f3(bb.hi[2]));
    if (ways === 2) check(tag + ': the Y spreads in X only: x ' + f3(bb.lo[0]) + '..' + f3(bb.hi[0]) + ', y ' + f3(bb.lo[1]) + '..' + f3(bb.hi[1]) + ' (±' + f3(P.branchLen * Math.sin(th) + rb * Math.cos(th)) + ')',
      near(bb.hi[0], P.branchLen * Math.sin(th) + rb * Math.cos(th), 0.05) && near(bb.lo[0], -bb.hi[0], 1e-3) && bb.hi[1] <= 10.001);
    TABLE.push({ name: tag, tris: T.tris, ms: String(ms), extra: 'genus ' + I.genus + ', ' + f3(I.volumeMm3) + ' mm³, outlets ' + f3(I.outletClearMm) + ' apart' });
  }
  console.log('\n=== 4. other sizes and angles: the same gates ===');
  for (const [ways, opts, tag] of [
    [2, { od: 30, wall: 2.4, branchOd: 20, angle: 25, trunkLen: 30, branchLen: 50 }, '2-way Ø30 → 2 × Ø20 at 25°'],
    [2, { angle: 60 }, '2-way at 60° (a wide Y)'],
    [2, { angle: 80, branchLen: 25 }, '2-way at 80° (nearly a T)'],
    [3, { od: 24, branchOd: 12, wall: 1.6, angle: 45, branchLen: 35 }, '3-way Ø24 → 3 × Ø12 at 45°'],
    [3, { angle: 20, branchLen: 60 }, '3-way at 20° (a tight fan)'],
    [2, { od: 12, wall: 1.2, branchOd: 8, trunkLen: 15, branchLen: 20 }, '2-way Ø12 / 1.2 wall (small)']
  ]) {
    const r = await F.splitter(Object.assign({ ways }, opts), wasm);
    check(tag + ': made', r.ok, r.ok ? '' : r.reason);
    if (!r.ok) continue;
    const P = F.splitterSize(Object.assign({ ways }, opts)).p;
    closed(tag, r.soup, 4 - 2 * (ways + 1));
    const az = ways === 2 ? [0, Math.PI] : [0, 2 * Math.PI / 3, 4 * Math.PI / 3];
    const ok = az.every(a => { const bw = branchWall(r.soup, P, a); return bw.length === 4 && near(bw[0] - bw[1], P.wall, 3e-3) && near(bw[0], P.branchOd / 2, 3e-3); });
    check(tag + ': every branch ' + P.branchOd + ' outside with a ' + P.wall + ' mm wall', ok);
    const tw = rayHits(r.soup, [60, 0, P.trunkLen / 2], [-1, 0, 0]).map(d => 60 - d);
    check(tag + ': the trunk Ø' + P.od + ', wall ' + P.wall, tw.length === 4 && near(tw[0], P.od / 2, 2e-3) && near(tw[0] - tw[1], P.wall, 2e-3));
  }
  console.log('\n=== 5. the Splitter\'s refusals, in words, nothing built ===');
  {
    const no = async (tag, o, re) => { const r = await F.splitter(o, wasm); console.log('   ' + r.reason); check('refused: ' + tag, !r.ok && !r.soup && re.test(r.reason), r.reason); };
    await no('4 ways', { ways: 4 }, /^a splitter is 2-way or 3-way: one trunk into 2 or 3 branches$/);
    await no('a wall under the floor', { ways: 2, wall: 0.3 }, /^a 0\.30 mm wall is under the nozzle-safety floor of 0\.42 mm/);
    await no('a trunk bore under 2 nozzle widths', { ways: 2, od: 3.8, wall: 1.6, branchOd: 3.8 }, /^the trunk's bore would be Ø0\.60 \(Ø3\.80 outside, 1\.60 mm wall\) - under the bore limit of Ø0\.80 \(2 nozzle widths at a 0\.4 mm nozzle\)\. The outside must be at least Ø4\.00$/);
    await no('a branch bore under 2 nozzle widths', { ways: 2, od: 20, wall: 2, branchOd: 4.5 }, /^the branches' bore would be Ø0\.50 \(Ø4\.50 outside, 2\.00 mm wall\) - under the bore limit of Ø0\.80 \(2 nozzle widths at a 0\.4 mm nozzle\)\. Their outside must be at least Ø4\.80$/);
    await no('an angle under 10°', { ways: 2, angle: 5 }, /^a branch angle of 5\.0° is outside 10° to 80° off the trunk's axis - less and the branches are one pipe, more and they are not a splitter$/);
    await no('an angle over 80°', { ways: 3, angle: 85 }, /^a branch angle of 85\.0° is outside 10° to 80°/);
    await no('outlets that run into each other', { ways: 2, angle: 12, branchLen: 20 },
      /^the 2 outlets would run into each other - at 12\.0° and 20\.0 mm long the branch ends are 8\.32 mm between axes for Ø15\.00 pipes; they need 1\.00 mm clear\. Make the branches at least 38\.5 mm long, the angle wider, or the branches narrower$/);
    await no('3 outlets running into each other', { ways: 3, angle: 12, branchLen: 30 }, /^the 3 outlets would run into each other - at 12\.0° and 30\.0 mm long the branch ends are 10\.80 mm between axes for Ø13\.00 pipes/);
    await no('3 outlets standing too close (0.45 mm clear)', { ways: 3, angle: 15, branchLen: 30 }, /^the 3 outlets would stand only 0\.45 mm apart - at 15\.0° and 30\.0 mm long the branch ends are 13\.45 mm between axes for Ø13\.00 pipes/);
    await no('no length', { ways: 2, trunkLen: 0 }, /^the trunk and the branches need a length, more than 0$/);
    // and the refusal's own advice works: the longer branches it names are made
    const fix = await F.splitter({ ways: 2, angle: 12, branchLen: 38.5 }, wasm);
    check('...and the 38.5 mm it names is made', fix.ok, fix.reason);
    if (fix.ok) closed('2-way at 12° with the 38.5 mm branches it asked for', fix.soup, -2);
  }
  console.log('\n=== 6. time ===');
  {
    const t0 = Date.now(), r = await F.splitter({ ways: 3 }, wasm), ms = Date.now() - t0;
    check('a 3-way splitter (' + (r.ok ? r.soup.length / 9 : '-') + ' triangles) builds in under 5 s', r.ok && ms < 5000, ms + ' ms');
  }

  console.log('\n| fitting | triangles | ms | measured |');
  console.log('|---|---|---|---|');
  for (const t of TABLE) console.log('| ' + t.name + ' | ' + t.tris + ' | ' + t.ms + ' | ' + t.extra + ' |');
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('FAILED: ' + FAILS.join(' | ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(2); });
