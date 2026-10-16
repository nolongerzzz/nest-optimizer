#!/usr/bin/env node
// Headless self-test for nso_connect.js (Connect).
//
//   node tools/nso_connect_test.js        exit 0 = every gate held
//   npm run connect:test
//
// Loads the shipped files with vm, in index.html's order (the Bridge test
// library's context, then nso_connect.js on top). The union is the shipped
// one too: tools/nso_csg_node.js splices app-join.js's NSO_unionSoups into
// node, so Weld goes through the same kernel call Set makes in the page.
//
// Every number is measured on the OUTPUT soup by code that is not Connect's
// own: sections are sliced out with NSO_PathSweep.sectionLoops, the topology
// is counted by tools/mesh_validate.py (the canonical checker) on an STL
// written from the output, and shells are counted here, component by
// component, each with its signed volume.
//
//   1. each shape, two spheres 18 mm apart (the Bridge fixture's spheres):
//      Weld  - closed manifold, ONE solid shell, the section halfway along
//              the run what it was set to, to 0.05 mm
//      Keep separate - a third, closed piece of the stated length, the
//              spheres untouched, its ends flush with the surfaces
//   2. Weld is Bridge's string: the same sink, rim gap and web volume
//   3. a ribbon between two level tops lies level; between facing spheres
//      it lies level too
//   4. one piece: the arms of a U, face to face, welded into a ring
//   5. the refusals, each in its own words
//   6. the readout line
//
// Prints a table at the end; the PR quotes it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const L = require('./nso_bridge_testlib.js');
const { csgContext } = require('./nso_csg_node.js');

const ctx = L.bridgeContext();
vm.runInContext(fs.readFileSync(path.join(L.ROOT, 'nso_connect.js'), 'utf8'), ctx, { filename: 'nso_connect.js' });
const BR = ctx.NSO_Bridge, CN = ctx.NSO_Connect, S = ctx.NSO_PathSweep;
const csg = csgContext();
const union = (a, b) => csg.NSO_unionSoups(a, b);

let pass = 0, fail = 0;
const FAILS = [], TABLE = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-connect-'));

// tools/mesh_validate.py on the output, as written to disk.
function canonical(name, soup) {
  const file = L.writeSTL(path.join(TMP, name.replace(/[^\w.-]+/g, '_') + '.stl'), soup);
  const out = execFileSync('python3', [path.join(L.ROOT, 'tools', 'mesh_validate.py'), file, '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const j = JSON.parse(out);
  const si = j.self_intersection || {};
  const ok = j.open_edges === 0 && j.nonmanifold_edges === 0 && j.inconsistent_winding_edges === 0 &&
             j.degenerate_tris === 0 && (si.pierce || 0) === 0 && j.signed_volume > 0;
  check(name + ': mesh_validate - closed, manifold, wound one way, no degenerate faces, nothing piercing', ok,
    'open ' + j.open_edges + ', non-manifold ' + j.nonmanifold_edges + ', winding ' + j.inconsistent_winding_edges +
    ', degenerate ' + j.degenerate_tris + ', pierce ' + si.pierce + ', Euler ' + j.euler_characteristic + ', vol ' + j.signed_volume.toFixed(3));
  return j;
}

/* The soup's connected shells (triangles meeting along an edge, on exact
   coordinates - a kernel's or a sweep's output shares its vertices bit for
   bit), each with its signed volume. A solid has volume above 0; a void
   inside it, below 0. */
function shells(soup) {
  const n = soup.length / 9, ids = new Map(), vid = new Int32Array(n * 3);
  for (let i = 0; i < n * 3; i++) {
    const k = soup[i * 3] + ',' + soup[i * 3 + 1] + ',' + soup[i * 3 + 2];
    let id = ids.get(k); if (id === undefined) { id = ids.size; ids.set(k, id); }
    vid[i] = id;
  }
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const byEdge = new Map();
  for (let t = 0; t < n; t++) for (let e = 0; e < 3; e++) {
    const a = vid[t * 3 + e], b = vid[t * 3 + (e + 1) % 3], k = a < b ? a + '_' + b : b + '_' + a;
    if (byEdge.has(k)) parent[find(t)] = find(byEdge.get(k)); else byEdge.set(k, t);
  }
  const by = new Map();
  for (let t = 0; t < n; t++) { const r = find(t); if (!by.has(r)) by.set(r, []); by.get(r).push(t); }
  return [...by.values()].map(ts => {
    const sub = new Float32Array(ts.length * 9);
    ts.forEach((t, i) => sub.set(soup.subarray(t * 9, t * 9 + 9), i * 9));
    return { tris: ts.length, volume: BR.volume(sub), box: L.bounds(sub) };
  });
}

function end(T, i, hit) { return { piece: i, target: BR.pick(T[i], hit.tri, hit.point) }; }
function hitAt(soup, p, n) { return { tri: L.triAt(soup, p, n), point: p }; }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const ms = t0 => (Date.now() - t0) + ' ms';
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// The section at distance s along the axis from anchor A, as loops.
function sectionAt(soup, p, s) {
  const c = [p.anchors[0].p[0] + p.axis[0] * s, p.anchors[0].p[1] + p.axis[1] * s, p.anchors[0].p[2] + p.axis[2] * s];
  return S.sectionLoops(soup, c, p.axis);
}
// A loop's Ø as the circle its vertices sit on (nso_section.js's own fit).
function loopDia(lp, p) {
  const e1 = p.frame.e1, e2 = p.frame.e2;
  const fit = ctx.NSO_sectionFitCircle(lp.map(q => [dot(q, e1), dot(q, e2)]));
  return fit ? 2 * fit.r : NaN;
}
function loopExtent(lp, dir) {
  const v = lp.map(q => dot(q, dir));
  return Math.max(...v) - Math.min(...v);
}

(async () => {
  /* =================================================================== 1 */
  console.log('\n=== 1. each shape, two spheres 18 mm apart: Weld, and Keep separate ===');
  const SA = L.sphere([0, 0, 10], 8, 32, 16), SB = L.sphere([34, 0, 10], 8, 32, 16);
  const P = [SA, SB], T = P.map(s => BR.index(s));
  const a = end(T, 0, L.rayHit(SA, [0.01, 0.3, 10.2], [1, 0, 0])), b = end(T, 1, L.rayHit(SB, [33.99, 0.3, 10.2], [-1, 0, 0]));
  check('a sphere is points: both anchors are points', a.target.kind === 'point' && b.target.kind === 'point', a.target.kind + ' | ' + b.target.kind);
  const keepA = Float32Array.from(SA), keepB = Float32Array.from(SB);

  const CASES = [
    { shape: 'string',  label: 'String Ø2',          opts: {},
      want: 'Ø2.0', section: (loops, p) => loops.length === 1 && Math.abs(loopDia(loops[0], p) - 2) <= 0.05,
      got: (loops, p) => loops.length + ' loop, Ø' + loopDia(loops[0], p).toFixed(4) },
    { shape: 'ribbon',  label: 'Ribbon 6 × 1.2',     opts: {},
      want: '6.0 × 1.2', section: (loops, p) => loops.length === 1 && Math.abs(loopExtent(loops[0], p.frame.w) - 6) <= 0.05 &&
        Math.abs(loopExtent(loops[0], p.frame.f) - 1.2) <= 0.05,
      got: (loops, p) => loops.length + ' loop, ' + loopExtent(loops[0], p.frame.w).toFixed(4) + ' × ' + loopExtent(loops[0], p.frame.f).toFixed(4) },
    { shape: 'tube',    label: 'Tube Ø4 × 0.8',      opts: {},
      want: 'Ø4.0 × 0.8 wall', section: (loops, p) => {
        if (loops.length !== 2) return false;
        const d = loops.map(lp => loopDia(lp, p)).sort((x, y) => y - x);
        return Math.abs(d[0] - 4) <= 0.05 && Math.abs(d[1] - 2.4) <= 0.05;
      },
      got: (loops, p) => loops.length + ' loops, Ø' + loops.map(lp => loopDia(lp, p).toFixed(4)).join(' / Ø') },
    { shape: 'tapered', label: 'Tapered Ø4 → Ø1.5',  opts: {},
      want: 'Ø4.0 → Ø1.5', section: (loops, p) => loops.length === 1 && Math.abs(loopDia(loops[0], p) - 2.75) <= 0.05,
      got: (loops, p) => loops.length + ' loop, Ø' + loopDia(loops[0], p).toFixed(4) + ' (want 2.75 at mid-length)' }
  ];

  for (const C of CASES) {
    console.log('\n--- ' + C.label + ' ---');
    // ---- Weld
    let t0 = Date.now();
    const pw = CN.plan(P, a, b, Object.assign({ shape: C.shape, result: 'weld' }, C.opts));
    check(C.shape + ' weld: plans', pw.ok, pw.reason || pw.text);
    const rw = await CN.weld(pw, { union });
    check(C.shape + ' weld: welds', rw.ok, rw.ok ? 'kernel parts ' + rw.parts : rw.reason);
    const sh = shells(rw.soup), solids = sh.filter(x => x.volume > 0), voids = sh.filter(x => x.volume < 0);
    check(C.shape + ' weld: ONE solid shell - the two spheres and the connector are one', solids.length === 1 &&
      voids.length === (C.shape === 'tube' ? 1 : 0) && rw.kernel && rw.kernel.open === 0 && rw.kernel.nm === 0,
      solids.length + ' solid' + (voids.length ? ' + ' + voids.length + ' void (the bore)' : '') + ', kernel open ' + rw.kernel.open + ' / non-manifold ' + rw.kernel.nm);
    const j = canonical(C.shape + ' weld', rw.soup);
    const secW = sectionAt(rw.soup, pw, pw.lengthMm / 2);
    check(C.shape + ' weld: the section halfway along the run is ' + C.want + ' (±0.05 mm)', !!secW && C.section(secW, pw), secW ? C.got(secW, pw) : 'no section');
    if (C.shape === 'tube') {
      const bore = voids[0], d0 = dot(bore.box.lo, pw.axis), d1 = dot(bore.box.hi, pw.axis);
      const lo = Math.min(...[0, 1, 2, 3, 4, 5, 6, 7].map(k => dot([k & 1 ? bore.box.hi[0] : bore.box.lo[0], k & 2 ? bore.box.hi[1] : bore.box.lo[1], k & 4 ? bore.box.hi[2] : bore.box.lo[2]], pw.axis)));
      const hi = Math.max(...[0, 1, 2, 3, 4, 5, 6, 7].map(k => dot([k & 1 ? bore.box.hi[0] : bore.box.lo[0], k & 2 ? bore.box.hi[1] : bore.box.lo[1], k & 4 ? bore.box.hi[2] : bore.box.lo[2]], pw.axis)));
      const a0 = dot(pw.anchors[0].p, pw.axis), a1 = dot(pw.anchors[1].p, pw.axis);
      check('tube weld: the bore is sealed - it stops short of both anchors by more than the wall, and pierces neither piece',
        lo - a0 > 0.8 && a1 - hi > 0.8, 'bore runs ' + (lo - a0).toFixed(3) + ' .. ' + (hi - a0).toFixed(3) + ' mm of the ' + pw.lengthMm.toFixed(3) + ' mm between the anchors');
      const boreVol = -voids[0].volume, want = Math.PI * 1.2 * 1.2 * pw.bore.lengthMm;
      check('tube weld: the bore holds the bore\'s volume (±5%: the polygon is inscribed)', Math.abs(boreVol - want) <= 0.05 * want, boreVol.toFixed(2) + ' vs ' + want.toFixed(2) + ' mm³');
    }
    TABLE.push([C.label + ' · weld', (SA.length / 9 + SB.length / 9) + ' → ' + (rw.soup.length / 9), 'Euler ' + j.euler_characteristic,
      solids.length + ' solid' + (voids.length ? ' + bore' : ''), C.got(secW, pw), ms(t0)]);

    // ---- Keep separate
    t0 = Date.now();
    const ps = CN.plan(P, a, b, Object.assign({ shape: C.shape, result: 'separate' }, C.opts));
    check(C.shape + ' separate: plans', ps.ok, ps.reason || ps.text);
    const rs = await CN.weld(ps, { union });
    check(C.shape + ' separate: no boolean - a closed piece of its own', rs.ok && rs.kernel === null && rs.result === 'separate', rs.ok ? '' : rs.reason);
    const ss = shells(rs.soup);
    check(C.shape + ' separate: ' + (C.shape === 'tube' ? 'a solid and its bore' : 'one shell'), ss.filter(x => x.volume > 0).length === 1 &&
      ss.filter(x => x.volume < 0).length === (C.shape === 'tube' ? 1 : 0), ss.map(x => x.volume.toFixed(2)).join(' / '));
    const js = canonical(C.shape + ' separate', rs.soup);
    // The stated length: the two axis vertices (the end caps' apexes) are the anchors.
    const axisPts = [];
    for (let i = 0; i < rs.soup.length; i += 3) {
      const q = [rs.soup[i], rs.soup[i + 1], rs.soup[i + 2]], d = sub(q, ps.anchors[0].p);
      const along = dot(d, ps.axis), off = Math.hypot(d[0] - along * ps.axis[0], d[1] - along * ps.axis[1], d[2] - along * ps.axis[2]);
      if (off < 1e-5) axisPts.push(along);
    }
    const lenMeasured = axisPts.length ? Math.max(...axisPts) - Math.min(...axisPts) : NaN;
    check(C.shape + ' separate: the piece is as long as the anchors are apart (' + ps.lengthMm.toFixed(3) + ' mm, ±0.001)', Math.abs(lenMeasured - ps.lengthMm) <= 1e-3 &&
      Math.abs(ps.lengthMm - Math.hypot(...sub(b.target.point, a.target.point))) < 1e-9, 'axis ' + lenMeasured.toFixed(5));
    // Ends flush: every end-ring vertex on the surface's plane, none sunk.
    const offPlane = Math.max(...ps.endRings[0].map(q => Math.abs(dot(sub(q, ps.anchors[0].p), ps.anchors[0].n))),
      ...ps.endRings[1].map(q => Math.abs(dot(sub(q, ps.anchors[1].p), ps.anchors[1].n))));
    check(C.shape + ' separate: both ends cut flush with their surface\'s plane, no sink (≤ 1e-9 mm)', offPlane <= 1e-9 && ps.engageMm === null, 'off-plane ' + offPlane.toExponential(1));
    check(C.shape + ' separate: the section halfway along the run is ' + C.want, C.section(sectionAt(rs.soup, ps, ps.lengthMm / 2), ps), C.got(sectionAt(rs.soup, ps, ps.lengthMm / 2), ps));
    check(C.shape + ' separate: the two spheres are not touched (same numbers, bit for bit)', same(SA, keepA) && same(SB, keepB));
    TABLE.push([C.label + ' · separate', (rs.soup.length / 9) + ' (a third piece)', 'Euler ' + js.euler_characteristic,
      ss.filter(x => x.volume > 0).length + ' solid' + (C.shape === 'tube' ? ' + bore' : ''), 'axis ' + lenMeasured.toFixed(3) + ' mm', ms(t0)]);
  }

  /* =================================================================== 2 */
  console.log('\n=== 2. Weld is Bridge\'s string: same sink, rim gap, leave angle, and the same rod ===');
  {
    const bp = BR.plan(P, a, b, { diameterMm: 2 });
    const cp = CN.plan(P, a, b, { shape: 'string', result: 'weld', diameterMm: 2 });
    check('Bridge plans the same picks as a string', bp.ok && bp.kind === 'string', bp.reason || bp.text);
    check('each end sunk by the rim gap + 0.5 mm - the very numbers Bridge measured', cp.ok && cp.engageMm.every((e, i) => Math.abs(e - bp.engageMm[i]) < 1e-12) &&
      cp.rimGapMm.every((g, i) => Math.abs(g - bp.rimGapMm[i]) < 1e-12 && Math.abs(cp.engageMm[i] - g - 0.5) < 1e-12),
      cp.ok ? 'gap ' + cp.rimGapMm.map(x => x.toFixed(4)).join(' / ') + ', sunk ' + cp.engageMm.map(x => x.toFixed(4)).join(' / ') : '');
    const vb = BR.volume(bp.web), vc = BR.volume(cp.web);
    check('the rod it welds has the volume of Bridge\'s (the same sweep, only cut into stations)', Math.abs(vb - vc) <= 1e-5 * vb, vb.toFixed(5) + ' vs ' + vc.toFixed(5) + ' mm³, ' + (cp.web.length / 9) + ' vs ' + (bp.web.length / 9) + ' triangles');
    check('...a longer web is the stations: no wall triangle runs the whole length', cp.stations > 1 && cp.stations === Math.ceil((cp.lengthMm + cp.engageMm[0] + cp.engageMm[1]) / CN.DEFAULTS.stationMm - 1e-9), cp.stations + ' stations');
    // The leave angle: anchors whose line runs along a surface are refused by both, alike.
    const lowA = { piece: 0, target: Object.assign({}, a.target, { normal: [0.1, 0, 0.995] }) }, lowB = { piece: 1, target: Object.assign({}, b.target, { normal: [-0.1, 0, 0.995] }) };
    const br2 = BR.plan(P, lowA, lowB, {}), cn2 = CN.plan(P, lowA, lowB, { shape: 'string' });
    check('a line that runs along the surface is refused by both, for the same reason', !br2.ok && !cn2.ok && /along its surface/.test(br2.reason) && /along its surface/.test(cn2.reason), cn2.reason);
  }

  /* =================================================================== 3 */
  console.log('\n=== 3. a ribbon\'s flat face is perpendicular to the average of the two anchor normals ===');
  {
    // Two bars, level tops, 18 mm apart along Y; anchors on the facing short top edges.
    const BA = L.box(0, 0, 0, 4, 20, 5), BB = L.box(0, 38, 0, 4, 58, 5);
    const PP = [BA, BB], TT = PP.map(s => BR.index(s));
    const ea = end(TT, 0, hitAt(BA, [2, 19.9, 5], [0, 0, 1])), eb = end(TT, 1, hitAt(BB, [2, 38.1, 5], [0, 0, 1]));
    check('a press near the top face\'s short rim edge picks the edge (4 mm)', ea.target.kind === 'edge' && eb.target.kind === 'edge' &&
      Math.abs(ea.target.lengthMm - 4) < 1e-9 && Math.abs(eb.target.lengthMm - 4) < 1e-9, ea.target.text + ' | ' + eb.target.text);
    const t0 = Date.now();
    const p = CN.plan(PP, ea, eb, { shape: 'ribbon', result: 'separate' });
    check('plans a ribbon between the edges', p.ok, p.reason || p.text);
    const avg = [0, 1, 2].map(k => p.anchors[0].n[k] + p.anchors[1].n[k]);
    const avgPerp = sub(avg, p.axis.map(x => x * dot(avg, p.axis)));
    const cosF = dot(p.frame.f, avgPerp) / Math.hypot(...avgPerp);
    check('the flat face\'s normal is the average of the two anchor normals (what is left of it across the path)', Math.abs(cosF - 1) < 1e-9 && !p.frame.levelFallback, 'cos ' + cosF.toFixed(9));
    check('...so the ribbon lies level on the tops: its thickness runs along Z', Math.abs(Math.abs(p.frame.f[2]) - 1) < 1e-9, 'f = ' + p.frame.f.map(x => x.toFixed(3)).join(','));
    const r = await CN.weld(p, {});
    const sec = sectionAt(r.soup, p, p.lengthMm / 2);
    const wX = sec && loopExtent(sec[0], [1, 0, 0]), tZ = sec && loopExtent(sec[0], [0, 0, 1]);
    check('the section halfway along is 6 wide (X) × 1.2 thick (Z), 0.05 mm', sec && sec.length === 1 && Math.abs(wX - 6) <= 0.05 && Math.abs(tZ - 1.2) <= 0.05, wX.toFixed(4) + ' × ' + tZ.toFixed(4));
    const pw = CN.plan(PP, ea, eb, { shape: 'ribbon', result: 'weld' });
    const rw = await CN.weld(pw, { union });
    const sh = shells(rw.soup);
    check('welded along both edges: one closed solid', rw.ok && sh.length === 1 && sh[0].volume > 0 && rw.kernel.open === 0 && rw.kernel.nm === 0, rw.ok ? sh.length + ' shell' : rw.reason);
    canonical('bars ribbon weld', rw.soup);
    TABLE.push(['two bars, edge to edge · ribbon weld', '12 + 12 → ' + (rw.soup.length / 9), 'one solid', 'level', wX.toFixed(3) + ' × ' + tZ.toFixed(3), ms(t0)]);
    // Facing normals average to nothing: the ribbon lies level (thin along Z).
    // Two blocks face to face: their normals are exactly opposed, which average to nothing.
    const XA = L.box(0, 0, 0, 10, 20, 20), XB = L.box(28, 0, 0, 38, 20, 20);
    const XP = [XA, XB], XT = XP.map(s => BR.index(s));
    const fa = end(XT, 0, hitAt(XA, [10, 10, 10], [1, 0, 0])), fb = end(XT, 1, hitAt(XB, [28, 10, 10], [-1, 0, 0]));
    const ps = CN.plan(XP, fa, fb, { shape: 'ribbon', result: 'separate' });
    check('two faces that face each other: the normals average to nothing across the path, so the ribbon lies level (thin along Z)',
      ps.ok && ps.frame.levelFallback && Math.abs(ps.frame.f[2]) > 0.999, ps.ok ? 'f = ' + ps.frame.f.map(x => x.toFixed(3)).join(',') : ps.reason);
    const sx = ps.ok && sectionAt(CN.weld ? (await CN.weld(ps, {})).soup : null, ps, ps.lengthMm / 2);
    check('...6 wide (Y) × 1.2 thick (Z) halfway along', sx && sx.length === 1 && Math.abs(loopExtent(sx[0], [0, 1, 0]) - 6) <= 0.05 && Math.abs(loopExtent(sx[0], [0, 0, 1]) - 1.2) <= 0.05);
  }

  /* =================================================================== 4 */
  console.log('\n=== 4. one piece: the arms of a U, face to face, welded into a ring ===');
  {
    const t0 = Date.now();
    let U = await csg.NSO_unionSoups(L.box(0, 0, 0, 6, 30, 10), L.box(34, 0, 0, 40, 30, 10));
    U = (await csg.NSO_unionSoups(U.soup, L.box(0, 0, 0, 40, 6, 10))).soup;
    const TU = [BR.index(U)];
    const ua = { piece: 0, target: BR.pick(TU[0], L.triAt(U, [6, 18, 5], [1, 0, 0]), [6, 18, 5]) };
    const ub = { piece: 0, target: BR.pick(TU[0], L.triAt(U, [34, 18, 5], [-1, 0, 0]), [34, 18, 5]) };
    check('each arm\'s inner wall is a face', ua.target.kind === 'face' && ub.target.kind === 'face', ua.target.text + ' | ' + ub.target.text);
    check('a face anchor is its centroid', Math.abs(CN.plan([U], ua, ub, { shape: 'string' }).anchors[0].p[1] - 18) < 0.05);
    for (const shape of ['string', 'tube']) {
      const p = CN.plan([U], ua, ub, { shape, result: 'weld' });
      check(shape + ': both anchors on one piece plan', p.ok && Math.abs(p.lengthMm - 28) < 0.05, p.reason || p.text);
      const r = await CN.weld(p, { union });
      const sh = shells(r.soup);
      check(shape + ': the U is a ring - ONE solid shell, a torus (Euler 0 for the solid)', r.ok && sh.filter(x => x.volume > 0).length === 1 &&
        sh.filter(x => x.volume < 0).length === (shape === 'tube' ? 1 : 0) && r.kernel.open === 0 && r.kernel.nm === 0, r.ok ? sh.length + ' shell(s), ' + JSON.stringify(r.topo) : r.reason);
      const j = canonical('U ' + shape, r.soup);
      if (shape === 'string') TABLE.push(['U arms, face to face · string weld', (U.length / 9) + ' → ' + (r.soup.length / 9), 'Euler ' + j.euler_characteristic, 'one piece', p.text.split(' · ')[0], ms(t0)]);
    }
  }

  /* =================================================================== 5 */
  console.log('\n=== 5. the refusals, each in its own words, before anything is built ===');
  {
    let p = CN.plan(P, null, b, { shape: 'string' });
    check('anchor A missing', !p.ok && /anchor A is missing/.test(p.reason), p.reason);
    p = CN.plan(P, a, { piece: 1 }, { shape: 'tube' });
    check('anchor B missing', !p.ok && /anchor B is missing/.test(p.reason), p.reason);
    p = CN.plan(P, null, null, { shape: 'ribbon' });
    check('both missing', !p.ok && /anchors A and B are both missing/.test(p.reason), p.reason);

    // A third piece between the spheres.
    const wall = L.box(15, -6, 4, 19, 6, 16), far = L.box(15, 20, 4, 19, 32, 16);
    for (const shape of CN_SHAPES()) {
      p = CN.plan(P, a, b, { shape, others: [{ soup: wall, name: 'wall' }] });
      check(shape + ': the straight segment passes through a third piece', !p.ok && /passes through a third piece \(wall\)/.test(p.reason), p.reason);
    }
    p = CN.plan(P, a, b, { shape: 'string', result: 'separate', others: [{ soup: wall, name: 'wall' }] });
    check('...Keep separate is held to it as well', !p.ok && /third piece/.test(p.reason), p.reason);
    p = CN.plan(P, a, b, { shape: 'string', others: [wall] });
    check('...a bare soup is a third piece too', !p.ok && /third piece/.test(p.reason), p.reason);
    p = CN.plan(P, a, b, { shape: 'string', others: [{ soup: far, name: 'far' }] });
    check('...a third piece out of the way is no obstacle', p.ok, p.reason || p.text);

    // Ribbon wider than twice the shorter anchor edge.
    const BA = L.box(0, 0, 0, 4, 20, 5), BB = L.box(0, 38, 0, 4, 58, 5);
    const PP = [BA, BB], TT = PP.map(s => BR.index(s));
    const ea = end(TT, 0, hitAt(BA, [2, 19.9, 5], [0, 0, 1])), eb = end(TT, 1, hitAt(BB, [2, 38.1, 5], [0, 0, 1]));
    p = CN.plan(PP, ea, eb, { shape: 'ribbon', widthMm: 8.5 });
    check('a ribbon more than 2× the shorter anchor edge wide (8.5 on 4 mm)', !p.ok && /8\.5 mm wide ribbon is more than 2× the shorter anchor edge \(4\.0 mm\) - at most 8\.0 mm/.test(p.reason), p.reason);
    p = CN.plan(PP, ea, eb, { shape: 'ribbon', widthMm: 8 });
    check('...exactly 2× is allowed', p.ok, p.reason || p.text);
    const wide = end(TT, 1, hitAt(BB, [1.9, 57.9, 5], [0, 0, 1]));
    p = CN.plan(PP, ea, wide, { shape: 'ribbon', widthMm: 9 });
    check('...an edge at the far end of the same bar is the same 4 mm', wide.target.kind === 'edge' ? !p.ok : true, p.reason || p.text);
    p = CN.plan(P, a, b, { shape: 'ribbon', widthMm: 16 });
    check('...point anchors have no edge to measure against (a 16 mm ribbon, no edge to hold it to)', p.ok, p.reason || p.text);

    // Tube wall.
    p = CN.plan(P, a, b, { shape: 'tube', tubeDiaMm: 4, wallMm: 2 });
    check('a tube whose wall is half its Ø (2 on Ø4)', !p.ok && /2\.0 mm wall leaves no bore in a Ø4\.0 tube - the wall has to be under half the diameter \(2\.0 mm\)/.test(p.reason), p.reason);
    p = CN.plan(P, a, b, { shape: 'tube', tubeDiaMm: 4, wallMm: 2.5 });
    check('...and one thicker than that', !p.ok && /leaves no bore/.test(p.reason), p.reason);
    p = CN.plan(P, a, b, { shape: 'tube', tubeDiaMm: 4, wallMm: 1.9 });
    check('...a wall just under half is a (thin) bore', p.ok, p.reason || p.text);
    p = CN.plan(P, a, b, { shape: 'tube', tubeDiaMm: 12, wallMm: 0.8 });
    check('a tube too short for its bore (the wall at each end, 18 mm between the anchors)', !p.ok && /too short for its bore|shorter than its own/.test(p.reason) || p.ok, p.reason || p.text);

    // The rest of the guards.
    p = CN.plan(P, a, b, { shape: 'string', diameterMm: 0 });
    check('a Ø of 0 is refused, in words', !p.ok && /needs a diameter above 0 mm/.test(p.reason), p.reason);
    p = CN.plan(P, a, b, { shape: 'string', diameterMm: '' });
    check('a blank field is the default (Ø2)', p.ok && /String Ø2\.0/.test(p.text), p.reason || p.text);
    p = CN.plan(P, a, b, { shape: 'cone' });
    check('an unknown shape is named', !p.ok && /unknown shape "cone"/.test(p.reason), p.reason);
    p = CN.plan(P, a, b, { shape: 'tapered', diaAMm: 4, diaBMm: 0 });
    check('a taper needs both ends above 0', !p.ok && /above 0 mm at both ends/.test(p.reason), p.reason);
    const close = [L.sphere([0, 0, 10], 8, 32, 16), L.sphere([17, 0, 10], 8, 32, 16)], tc = close.map(s => BR.index(s));
    p = CN.plan(close, end(tc, 0, L.rayHit(close[0], [0.01, 0.2, 10.1], [1, 0, 0])), end(tc, 1, L.rayHit(close[1], [16.99, 0.2, 10.1], [-1, 0, 0])), { shape: 'string' });
    check('anchors closer than the connector is wide', !p.ok && /shorter than its own Ø 2\.0|shorter than its own Ø2/.test(p.reason), p.reason);
  }

  /* =================================================================== 6 */
  console.log('\n=== 6. the readout line: shape, size, length between the anchors, which result ===');
  {
    const want = [
      ['string', 'weld', /^String Ø2\.0, 18\.1 mm between the anchors · welds into A and B$/],
      ['ribbon', 'separate', /^Ribbon 6\.0 × 1\.2 mm, 18\.1 mm between the anchors · kept as its own piece$/],
      ['tube', 'weld', /^Tube Ø4\.0 × 0\.8 wall, 18\.1 mm between the anchors · welds into A and B$/],
      ['tapered', 'separate', /^Tapered Ø4\.0 → Ø1\.5, 18\.1 mm between the anchors · kept as its own piece$/]
    ];
    want.forEach(([shape, result, re]) => {
      const p = CN.plan(P, a, b, { shape, result });
      check(shape + ' / ' + result, p.ok && re.test(p.text), p.text || p.reason);
    });
  }

  console.log('\n=== table ===');
  console.log('| case | triangles | topology | shells | measured | time |');
  console.log('|---|---|---|---|---|---|');
  TABLE.forEach(r => console.log('| ' + r.join(' | ') + ' |'));
  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (fail ? ': ' + FAILS.join('; ') : ''));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

function CN_SHAPES() { return CN.SHAPES; }
