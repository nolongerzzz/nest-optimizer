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
//   7. PATH: Sag +6 and -6 on every shape - the section at mid-span sits the
//      stated 6 mm off the chord (±0.05), the arc stays in the vertical plane
//      through the anchors, the sag is signed, stacked anchors bow away from the
//      centroid, the last 3 mm at each end is straight along the approach
//      direction, and Sag 0 is ticket 1's output to the byte
//   8. ENDS: Weld / Flat / Foot pad / Ball on String and Ribbon, straight and
//      curved, Weld into both (one shell) and Keep separate (one new piece), each
//      closed and manifold; the pad and the ball are measured off the soup
//   9. the path's refusals: through a third piece, through the connector's own
//      piece, a hoop too flat on the surface, unknown ends
//  10. the readout names the path and the ends
//  11. THE ANCHOR IS THE POINT UNDER THE CURSOR: two boxes, a click on a corner
//      or mid-face lands the connector's end on that very point (0.1 mm), not
//      on a centre or a midpoint; the leave direction is the average of the
//      adjoining faces' normals (a corner's three); Shift keeps the old centre /
//      midpoint; the readout says where ("on box_closed at 2.1 mm from its
//      corner"); three connectors in a row, each welded onto the last result
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

const crypto = require('crypto');
// Ticket 1's output for the straight fixture (two spheres 18 mm apart, default
// everything), hashed at the commit before Sag and Ends existed (38cf015). A
// straight, default-ended connector is byte-identical to it; change these only
// on purpose.
const TICKET1 = {
  'string/weld': { web: 'f731b75d82ff04cd1d49e9e864ae1956bcd17976', soup: '4b8d8224cbbf5fdade8d15ca17bbdd99b7f5e524' },
  'string/separate': { web: '3b1787bb8902cd3a486bc1b703190c26d353789e', soup: '3b1787bb8902cd3a486bc1b703190c26d353789e' },
  'ribbon/weld': { web: '355bd0288e86517091d23a3a41860d830c9ddfa2', soup: '04bfb3e794996bc22da9b03488d9ad2a05f814f2' },
  'ribbon/separate': { web: '1c6ed31058a7b2a0efc0803d1836422acd4c5ea8', soup: '1c6ed31058a7b2a0efc0803d1836422acd4c5ea8' },
  'tube/weld': { web: 'd518440dc44080a39ace7a60aa5cacadbc6b7c56', soup: '6ff2d6043c18657909a837d13df273be62326611' },
  'tube/separate': { web: '93faac7013f259b2701711f0198cb3f83d5ba5a6', soup: '93faac7013f259b2701711f0198cb3f83d5ba5a6' },
  'tapered/weld': { web: '69670a1ce5b6e2d2e96ecf4926a74b6cc543a47b', soup: 'bb0424cc646c78e75298579d19e6cce4d3f26c69' },
  'tapered/separate': { web: '465af899856c5c77fc214b1f09322e0f885bf9e7', soup: '465af899856c5c77fc214b1f09322e0f885bf9e7' }
};
const sha = soup => crypto.createHash('sha1').update(Buffer.from(soup.buffer, soup.byteOffset, soup.byteLength)).digest('hex');

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

// Sections 1-10 are ticket 1 and 2's: a face or an edge there is its centre / midpoint (`centre`), as before
// the anchor was the clicked point. Section 11 is the clicked point (exact()).
function end(T, i, hit) {
  const t = BR.pick(T[i], hit.tri, hit.point);
  return { piece: i, target: t.kind === 'face' || t.kind === 'edge' ? Object.assign(t, { centre: true }) : t };
}
function exact(T, i, hit, o) {
  const r = CN.anchor(T[i], BR.pick(T[i], hit.tri, hit.point), o);
  return { piece: i, target: r.target, info: r };
}
function hitAt(soup, p, n) { return { tri: L.triAt(soup, p, n), point: p }; }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const ms = t0 => (Date.now() - t0) + ' ms';
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unitv = a => { const n = Math.hypot(...a); return a.map(x => x / n); };
const verts = soup => { const o = []; for (let i = 0; i < soup.length; i += 3) o.push([soup[i], soup[i + 1], soup[i + 2]]); return o; };
const mean = pts => [0, 1, 2].map(k => pts.reduce((s, q) => s + q[k], 0) / pts.length);

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


  /* =================================================================== 7 */
  console.log('\n=== 7. PATH: Sag +/-6 on every shape; the arc, its plane, its straight ends; Sag 0 is ticket 1 ===');
  {
    // The vertical plane through the anchors: u along the chord, v up in the plane, w across it.
    const frameOf = p => {
      const A = p.anchors[0].p, B = p.anchors[1].p, u = unitv(sub(B, A));
      const v = unitv([-u[2] * u[0], -u[2] * u[1], 1 - u[2] * u[2]]);
      return { A, B, u, v, w: unitv(cross(u, v)), M: [0, 1, 2].map(k => (A[k] + B[k]) / 2) };
    };
    /* The vertices of the soup that lie in the plane through mid-span, normal to the chord: that
       ring is the section there. Its mean is the centre line's point; its extent along w is the
       section's width across the bend. */
    const midRing = (soup, f) => verts(soup).filter(q => Math.abs(dot(sub(q, f.M), f.u)) < 1e-3);
    /* Across the bend (w), at mid-span, and the widest the section gets along w anywhere. A ribbon lies as
       ticket 1 puts it - here tilted, the facet normals of two facing spheres all but cancel - and a bend
       about w keeps what the ribbon's width and thickness project onto w, so that is what is expected. */
    const WIDTH = { string: 2, tube: 4, tapered: 2.75 }, HALF = { string: 1, tube: 2, tapered: 2 };
    const TOL = { string: 1e-4, ribbon: 1e-3, tube: 1e-4, tapered: 0.05 };    // a taper's flush ends slide along cone rails
    for (const shape of CN.SHAPES) for (const sag of [6, -6]) {
      const t0 = Date.now();
      const tag = shape + ' sag ' + (sag > 0 ? '+' : '') + sag;
      const ps = CN.plan(P, a, b, { shape, result: 'separate', sagMm: sag });
      check(tag + ': plans', ps.ok, ps.reason || ps.text);
      const rs = await CN.weld(ps, { union });
      const f = frameOf(ps);
      const ring = midRing(rs.soup, f), c = mean(ring), d = sub(c, f.M);
      const offV = dot(d, f.v), offW = dot(d, f.w), offU = dot(d, f.u);
      check(tag + ' separate: the section at mid-span sits ' + sag + ' mm off the chord (±0.05), along the vertical-plane normal to it',
        ring.length > 8 && Math.abs(offV - sag) <= 0.05, 'off ' + offV.toFixed(4) + ' (v), ' + offW.toExponential(1) + ' (across), ' + offU.toExponential(1) + ' (along)');
      check('  ...and not a hair out of the plane or along the chord (≤ 1e-4 mm)', Math.abs(offW) <= 1e-4 && Math.abs(offU) <= 1e-4);
      const wExt = ring.map(q => dot(sub(q, f.M), f.w)), wAll = verts(rs.soup).map(q => dot(sub(q, f.A), f.w));
      const wide = shape === 'ribbon' ? Math.abs(dot(ps.frame.w, f.w)) * 6 + Math.abs(dot(ps.frame.f, f.w)) * 1.2 : WIDTH[shape];
      const half = shape === 'ribbon' ? wide / 2 : HALF[shape];
      check('  ...the arc stays in the vertical plane: no part of the connector is more than its own half-width (' + half.toFixed(3) + ') across it, and it is centred on it',
        Math.max(...wAll) <= half + TOL[shape] && Math.min(...wAll) >= -half - TOL[shape] && Math.abs(Math.max(...wAll) + Math.min(...wAll)) <= 2 * TOL[shape],
        'across ' + Math.min(...wAll).toFixed(5) + ' .. ' + Math.max(...wAll).toFixed(5));
      check('  ...the section at mid-span across the bend is what it was set to (' + wide.toFixed(3) + ' mm, ±0.05)',
        Math.abs((Math.max(...wExt) - Math.min(...wExt)) - wide) <= 0.05, (Math.max(...wExt) - Math.min(...wExt)).toFixed(4));
      canonical(tag + ' separate', rs.soup);
      // the leave angle holds, and the last 3 mm at each end is straight along the approach direction
      check('  ...it leaves each surface inside the leave angle (80°) and the path says so', ps.leave.every(c => c > Math.cos(80 * Math.PI / 180)),
        ps.leave.map(c => (Math.acos(c) * 180 / Math.PI).toFixed(1) + '°').join(' / '));
      const pts = ps.path.points, d0 = sub(pts[1], pts[0]), d1 = sub(pts[pts.length - 1], pts[pts.length - 2]);
      check('  ...the path\'s first and last runs are straight and at least 3 mm', Math.hypot(...d0) >= 3 - 1e-9 && Math.hypot(...d1) >= 3 - 1e-9 &&
        Math.abs(dot(unitv(d0), ps.path.startDir) - 1) < 1e-12 && Math.abs(dot(unitv(d1), ps.path.endDir) - 1) < 1e-12,
        Math.hypot(...d0).toFixed(3) + ' / ' + Math.hypot(...d1).toFixed(3) + ' mm');
      if (shape === 'string') {
        // Measured off the soup: every vertex within 3 mm of the anchor lies on a Ø2 cylinder about the approach line.
        const near = (A, dir, n) => verts(rs.soup).filter(q => { const t = dot(sub(q, A), dir); return t < 3 - 0.01 && t > -3 && Math.hypot(...sub(q, A)) < 6; })
          .map(q => { const dq = sub(q, A), t = dot(dq, dir); return Math.hypot(...sub(dq, dir.map(x => x * t))); })
          .filter(r => r > 0.5);                                         // not the end cap's apex, which is on the axis
        const rA = near(ps.anchors[0].p, ps.path.startDir), rB = near(ps.anchors[1].p, ps.path.endDir.map(x => -x));
        check('  ...String: the last 3 mm before each anchor is a straight Ø2 cylinder about the approach direction (radius 1 ±1e-4, measured off the soup)',
          rA.length > 16 && rB.length > 16 && rA.every(x => Math.abs(x - 1) < 1e-4) && rB.every(x => Math.abs(x - 1) < 1e-4),
          rA.length + '+' + rB.length + ' vertices, radii ' + Math.min(...rA, ...rB).toFixed(5) + ' .. ' + Math.max(...rA, ...rB).toFixed(5));
      }
      // Weld: one solid, the very same curve
      const pw = CN.plan(P, a, b, { shape, result: 'weld', sagMm: sag });
      const rw = await CN.weld(pw, { union });
      check(tag + ' weld: welds', pw.ok && rw.ok, pw.ok ? (rw.ok ? 'kernel parts ' + rw.parts : rw.reason) : pw.reason);
      const sh = shells(rw.soup), solids = sh.filter(x => x.volume > 0), voids = sh.filter(x => x.volume < 0);
      check('  ...ONE solid shell (the two spheres and the curve are one)' + (shape === 'tube' ? ' + the sealed bore' : ''), solids.length === 1 &&
        voids.length === (shape === 'tube' ? 1 : 0) && rw.kernel.open === 0 && rw.kernel.nm === 0, solids.length + ' solid, ' + voids.length + ' void');
      const rw2 = midRing(rw.soup, f), cw = mean(rw2);
      check('  ...welded, the section at mid-span is the same ' + sag + ' mm off the chord (±0.05)', rw2.length > 8 && Math.abs(dot(sub(cw, f.M), f.v) - sag) <= 0.05, dot(sub(cw, f.M), f.v).toFixed(4));
      canonical(tag + ' weld', rw.soup);
      TABLE.push([tag + ' · weld', (SA.length / 9 + SB.length / 9) + ' → ' + (rw.soup.length / 9), 'one solid' + (voids.length ? ' + bore' : ''),
        'mid-span ' + offV.toFixed(3) + ' mm, path ' + ps.pathLengthMm.toFixed(2) + ' mm', ms(t0)]);
    }

    // The sign: + is above the chord, - below.
    {
      const up = CN.plan(P, a, b, { shape: 'string', result: 'separate', sagMm: 6 }), dn = CN.plan(P, a, b, { shape: 'string', result: 'separate', sagMm: -6 });
      const zUp = Math.max(...verts(up.web).map(q => q[2])), zDn = Math.min(...verts(dn.web).map(q => q[2]));
      check('+6 bows UP and -6 hangs DOWN: the connector reaches ' + (up.anchors[0].p[2] + 6 + 1).toFixed(1) + ' mm above the plate at + and ' + (dn.anchors[0].p[2] - 6 - 1).toFixed(1) + ' at -',
        Math.abs(zUp - (up.anchors[0].p[2] + 6 + 1)) < 0.1 && Math.abs(zDn - (dn.anchors[0].p[2] - 6 - 1)) < 0.1, 'top ' + zUp.toFixed(3) + ', bottom ' + zDn.toFixed(3));
    }

    // A tilted chord: the arc is in the vertical plane through the anchors, and "up" is up in that plane, not along Z.
    {
      const SC = L.sphere([34, 0, 22], 8, 32, 16), PT = [SA, SC], TT = PT.map(s => BR.index(s));
      const tb = end(TT, 1, L.rayHit(SC, [20, 0.3, 21.5], [1, 0, 0]));
      const p = CN.plan(PT, a, tb, { shape: 'string', result: 'separate', sagMm: 3 }), f = frameOf(p);
      check('a tilted chord (' + (Math.asin(f.u[2]) * 180 / Math.PI).toFixed(1) + '° up) plans with a sag of 3', p.ok, p.reason || p.text);
      const r = await CN.weld(p, { union });
      const c = mean(midRing(r.soup, f)), d = sub(c, f.M);
      check('...mid-span is 3 mm off the chord, perpendicular to it, in the vertical plane through the anchors (and so has height)', Math.abs(dot(d, f.v) - 3) <= 0.05 &&
        Math.abs(dot(d, f.w)) <= 1e-4 && Math.abs(dot(d, f.u)) <= 1e-4 && f.v[2] > 0.5, 'v ' + dot(d, f.v).toFixed(4) + ', across ' + dot(d, f.w).toExponential(1) + ', along ' + dot(d, f.u).toExponential(1));
    }

    // Stacked anchors: no vertical plane, so the arc bows away from the centroid of the pieces.
    {
      const VA = L.sphere([0, 0, 8], 8, 32, 16), VB = L.sphere([0, 0, 40], 8, 32, 16), PV = [VA, VB], TV = PV.map(s => BR.index(s));
      const va = end(TV, 0, L.rayHit(VA, [0.3, 0, 30], [0, 0, -1])), vb = end(TV, 1, L.rayHit(VB, [0.3, 0, 20], [0, 0, 1]));
      for (const sag of [4, -4]) {
        const p = CN.plan(PV, va, vb, { shape: 'string', result: 'separate', sagMm: sag });
        check('stacked anchors, sag ' + sag + ': plans', p.ok, p.reason || p.text);
        const f = frameOf(p), r = await CN.weld(p, { union });
        const c = mean(midRing(r.soup, f)), d = sub(c, f.M);
        check('...the chord is vertical (' + f.u.map(x => x.toFixed(6)).join(',') + ') and the arc ' + (sag > 0 ? 'bows away from the centroid' : 'bows toward it') +
          ': mid-span is ' + Math.abs(sag) + ' mm ' + (sag > 0 ? 'out' : 'in') + ' along X, none along Y (the anchors are at X 0.3, the centroids at 0)', Math.abs(f.u[2]) > 0.999999 &&
          Math.abs(d[0] - sag) <= 0.05 && Math.abs(d[1]) <= 1e-4 && Math.abs(d[2]) <= 1e-4, 'offset ' + d.map(x => x.toFixed(4)).join(','));
      }
    }

    // A hair of sag is still a curve, and still exact (no cancellation in a circle of radius 1e6 mm).
    for (const sag of [0.05, 0.5]) {
      const p = CN.plan(P, a, b, { shape: 'string', result: 'separate', sagMm: sag }), f = frameOf(p), r = await CN.weld(p, { union });
      const d = sub(mean(midRing(r.soup, f)), f.M);
      check('a sag of ' + sag + ' mm: a closed piece, mid-span exactly ' + sag + ' mm off the chord (±0.001), radius ' + p.path.radiusMm.toFixed(0) + ' mm', p.ok && r.ok && r.topo.open === 0 && r.topo.nm === 0 &&
        Math.abs(dot(d, f.v) - sag) <= 1e-3 && Math.abs(dot(d, f.w)) <= 1e-4, dot(d, f.v).toExponential(4));
    }

    // A level strap: a Ribbon between two level tops bends in its thickness, like a handle.
    {
      const BA = L.box(0, 0, 0, 4, 20, 5), BB = L.box(0, 38, 0, 4, 58, 5), PP = [BA, BB], TT = PP.map(x => BR.index(x));
      const ea = end(TT, 0, hitAt(BA, [2, 19.9, 5], [0, 0, 1])), eb = end(TT, 1, hitAt(BB, [2, 38.1, 5], [0, 0, 1]));
      for (const sag of [3, -3]) {
        const p = CN.plan(PP, ea, eb, { shape: 'ribbon', result: 'separate', sagMm: sag });
        check('a level ribbon between the two bars\' top edges, sag ' + sag + ': plans', p.ok, p.reason || p.text);
        const f = frameOf(p), r = await CN.weld(p, { union });
        const ring = midRing(r.soup, f), d = sub(mean(ring), f.M);
        const wE = ring.map(q => dot(sub(q, f.M), f.w)), vE = ring.map(q => dot(sub(q, f.M), f.v));
        check('...a strap that bows ' + (sag > 0 ? 'up' : 'down') + ' 3 mm: mid-span is 3 mm off the chord (±0.05), 6 wide across the bend (X), 1.2 thick in it (±0.05)',
          Math.abs(dot(d, f.v) - sag) <= 0.05 && Math.abs(Math.max(...wE) - Math.min(...wE) - 6) <= 0.05 && Math.abs(Math.max(...vE) - Math.min(...vE) - 1.2) <= 0.05 && Math.abs(Math.abs(p.frame.f[2]) - 1) < 1e-9,
          dot(d, f.v).toFixed(4) + ', ' + (Math.max(...wE) - Math.min(...wE)).toFixed(4) + ' × ' + (Math.max(...vE) - Math.min(...vE)).toFixed(4));
        canonical('bars ribbon sag ' + sag, r.soup);
      }
    }

    // Sag 0 is ticket 1, to the byte - however it is spelt.
    {
      let bad = [];
      for (const shape of CN.SHAPES) for (const result of ['weld', 'separate']) {
        const key = shape + '/' + result, want = TICKET1[key];
        for (const spell of [{}, { sagMm: 0 }, { sagMm: '' }, { sagMm: -0 }, { sagMm: 1e-12 }, { ends: 'weld' }]) {
          const p = CN.plan(P, a, b, Object.assign({ shape, result }, spell));
          if (!p.ok || sha(p.web) !== want.web) bad.push(key + ' ' + JSON.stringify(spell) + ' web');
        }
        const r = await CN.weld(CN.plan(P, a, b, { shape, result, sagMm: 0 }), { union });
        if (!r.ok || sha(r.soup) !== want.soup) bad.push(key + ' soup');
      }
      check('Sag 0 (omitted, 0, blank, -0, 1e-12) and Ends = Weld give ticket 1\'s web and welded soup bit for bit, all four shapes, both results (' + Object.keys(TICKET1).length * 7 + ' hashes)',
        bad.length === 0, bad.join('; '));
    }
  }

  /* =================================================================== 8 */
  console.log('\n=== 8. ENDS: Weld / Flat / Foot pad / Ball, String and Ribbon, straight and curved, welded and kept separate ===');
  {
    const WIDTH = { string: 2, ribbon: 6 };
    for (const shape of ['string', 'ribbon']) for (const sag of [0, 6]) {
      const flatSep = CN.plan(P, a, b, { shape, result: 'separate', ends: 'flat', sagMm: sag });
      const weldSep = CN.plan(P, a, b, { shape, result: 'separate', ends: 'weld', sagMm: sag });
      check(shape + ' sag ' + sag + ': Ends = Weld, kept separate, is the flush cut - bit for bit what Flat is', flatSep.ok && weldSep.ok && same(flatSep.web, weldSep.web));
      for (const ends of ['weld', 'flat', 'pad', 'ball']) {
        const t0 = Date.now(), tag = shape + ' sag ' + sag + ' · ' + ends + ' ends';
        // ---- Weld into both (Flat has nothing to weld with: refused)
        let rw = null, jw = { euler_characteristic: '-' };
        if (ends === 'flat') {
          const pf = CN.plan(P, a, b, { shape, result: 'weld', ends, sagMm: sag });
          check(tag + ' · weld: refused in words - a flush face has nothing to weld with', !pf.ok && /Flat ends are cut flush with the surface and not sunk, so there is nothing to weld them with - pick Keep separate/.test(pf.reason), pf.reason);
        } else {
          const pw = CN.plan(P, a, b, { shape, result: 'weld', ends, sagMm: sag });
          check(tag + ' · weld: plans', pw.ok, pw.reason || pw.text);
          rw = await CN.weld(pw, { union });
          check(tag + ' · weld: welds', rw.ok, rw.ok ? 'kernel parts ' + rw.parts : rw.reason);
          const sh = shells(rw.soup);
          check('  ...ONE solid shell: the two spheres and the connector (and its ends) are one, closed and manifold', sh.length === 1 && sh[0].volume > 0 &&
            rw.kernel.open === 0 && rw.kernel.nm === 0, sh.length + ' shell(s), kernel open ' + rw.kernel.open + ' / non-manifold ' + rw.kernel.nm);
          jw = canonical(tag + ' · weld', rw.soup);
        }
        // ---- Keep separate
        const ps = CN.plan(P, a, b, { shape, result: 'separate', ends, sagMm: sag });
        check(tag + ' · separate: plans', ps.ok, ps.reason || ps.text);
        const keepA = Float32Array.from(SA), keepB = Float32Array.from(SB);
        const rs = await CN.weld(ps, { union });
        check(tag + ' · separate: a closed piece of its own', rs.ok, rs.ok ? '' : rs.reason);
        check('  ...' + (ends === 'pad' || ends === 'ball' ? 'the ends are unioned with the connector (and only with it)' : 'no boolean at all'),
          (ends === 'pad' || ends === 'ball') ? rs.kernel && rs.kernel.open === 0 && rs.kernel.nm === 0 : rs.kernel === null, rs.kernel ? JSON.stringify(rs.kernel) : 'kernel null');
        const ss = shells(rs.soup);
        check('  ...ONE new piece, one shell', ss.length === 1 && ss[0].volume > 0, ss.map(x => x.volume.toFixed(2)).join(' / '));
        const js = canonical(tag + ' · separate', rs.soup);
        check('  ...the spheres are not touched (same numbers, bit for bit)', same(SA, keepA) && same(SB, keepB));
        // ---- what the tips look like, measured off the soup
        const w = WIDTH[shape];
        for (let e = 0; e < 2; e++) {
          const An = ps.anchors[e], n = An.n, P0 = An.p;
          const h = q => dot(sub(q, P0), n);
          const rad = q => { const d = sub(q, P0), t = dot(d, n); return Math.hypot(...sub(d, n.map(x => x * t))); };
          const vs = verts(rs.soup);
          if (ends === 'pad') {
            const R = 2.5 * w / 2;
            const bot = vs.filter(q => Math.abs(h(q)) < 1e-5 && Math.abs(rad(q) - R) < 1e-4), top = vs.filter(q => Math.abs(h(q) - 0.6) < 1e-5 && Math.abs(rad(q) - R) < 1e-4);
            const near = vs.filter(q => rad(q) < R + 1e-4 && Math.hypot(...sub(q, P0)) < R + 1);
            check('  ...end ' + 'AB'[e] + ': a Foot pad Ø' + 2.5 * w + ' (2.5 × ' + w + '), 0.6 thick, flush on the surface (its bottom in the surface plane; nothing of it below)',
              bot.length >= 16 && top.length >= 16 && Math.min(...near.map(h)) > -1e-5, 'rim ' + bot.length + ' bottom / ' + top.length + ' top, lowest ' + Math.min(...near.map(h)).toExponential(1));
          } else if (ends === 'ball') {
            const R = 1.5 * w / 2;
            const on = vs.filter(q => Math.abs(Math.hypot(...sub(q, P0)) - R) < 1e-4), inside = vs.filter(q => Math.hypot(...sub(q, P0)) < R - 0.03);   // a cut lies on a facet, up to 0.02 inside the sphere
            check('  ...end ' + 'AB'[e] + ': a Ball Ø' + 1.5 * w + ' (1.5 × ' + w + ') centred on the anchor (its vertices all ' + R + ' mm from it)', on.length >= 100 && inside.length === 0,
              on.length + ' on the sphere, ' + inside.length + ' inside it (none: the connector\'s own end is swallowed)');
          } else {
            const planeOff = vs.filter(q => Math.abs(h(q)) < 1e-5 && Math.hypot(...sub(q, P0)) < w);
            check('  ...end ' + 'AB'[e] + ': cut flush - its end ring lies in the surface plane, and the connector goes no further', planeOff.length >= 6 && Math.min(...vs.filter(q => Math.hypot(...sub(q, P0)) < w).map(h)) > -1e-5,
              planeOff.length + ' vertices in the plane');
          }
        }
        TABLE.push([tag, (SA.length / 9 + SB.length / 9) + ' → ' + (rw ? rw.soup.length / 9 : 'refused') + ' / ' + (rs.soup.length / 9) + ' (a third piece)',
          'Euler ' + jw.euler_characteristic + ' / ' + js.euler_characteristic, (rw ? '1 solid' : '-') + ' / 1 solid', ps.text.replace(/^.*mm between the anchors,? ?/, ''), ms(t0)]);
      }
    }
  }

  /* =================================================================== 9 */
  console.log('\n=== 9. the path\'s refusals: through a piece (third, or its own), too flat on the surface, unknown ends ===');
  {
    // A lintel above the spheres: the straight line clears it, a bow up does not, a drape does.
    const lintel = { soup: L.box(15, -6, 14, 19, 6, 20), name: 'lintel' };
    let p = CN.plan(P, a, b, { shape: 'string', others: [lintel] });
    check('a lintel 4 mm above the line: the straight connector is fine', p.ok, p.reason || p.text);
    for (const sag of [3, 6]) {
      p = CN.plan(P, a, b, { shape: 'string', sagMm: sag, others: [lintel] });
      check('...sag +' + sag + ' would pass through it - refused, naming it', !p.ok && /curved connector passes through a third piece \(lintel\)/.test(p.reason), p.reason);
    }
    p = CN.plan(P, a, b, { shape: 'string', result: 'separate', sagMm: 6, others: [lintel] });
    check('...Keep separate is held to it as well', !p.ok && /third piece/.test(p.reason), p.reason);
    p = CN.plan(P, a, b, { shape: 'string', sagMm: -6, others: [lintel] });
    check('...hung the other way (-6) it clears', p.ok, p.reason || p.text);
    p = CN.plan(P, a, b, { shape: 'string', sagMm: 6, ends: 'pad', result: 'separate', others: [{ soup: L.box(7.9, 2.1, 9, 9.5, 2.7, 11), name: 'shelf' }] });
    check('a Foot pad that would reach into a third piece (a shelf beside the connector, clear of it, in the pad\'s reach) is refused too', !p.ok && /foot pad at anchor A passes through a third piece \(shelf\)/.test(p.reason), p.reason);

    // Through the connector's own piece: an overhang above anchor A.
    const U = (await csg.NSO_unionSoups(L.box(0, 0, 0, 10, 10, 10), L.box(0, 0, 10, 16, 10, 16))).soup, BB = L.box(30, 0, 0, 40, 10, 10);
    const PP = [U, BB], TT = PP.map(x => BR.index(x));
    const ua = end(TT, 0, hitAt(U, [10, 5, 5], [1, 0, 0])), ub = end(TT, 1, hitAt(BB, [30, 5, 5], [-1, 0, 0]));
    p = CN.plan(PP, ua, ub, { shape: 'string', sagMm: 0 });
    check('an overhang over anchor A: the straight connector, under it, is fine', p.ok, p.reason || p.text);
    p = CN.plan(PP, ua, ub, { shape: 'string', sagMm: 4 });
    check('...a bow of +4 clears the overhang', p.ok, p.reason || p.text);
    for (const sag of [6, 8]) {
      p = CN.plan(PP, ua, ub, { shape: 'string', sagMm: sag });
      check('...a bow of +' + sag + ' runs up into it: refused, as passing through the first piece', !p.ok && /curved connector would pass through the first piece - a sag of \+\d\.\d mm takes it through the piece/.test(p.reason), p.reason);
    }
    p = CN.plan(PP, ua, ub, { shape: 'string', sagMm: -6 });
    check('...hung down (-6) it is clear of it', p.ok, p.reason || p.text);

    // Too flat on the surface: a hoop.
    for (const [sag, re] of [[20, /at anchor A it runs into the piece/], [-12, /at anchor A it runs along its surface/]]) {
      p = CN.plan(P, a, b, { shape: 'string', sagMm: sag });
      check('a sag of ' + sag + ' turns the connector so it leaves the surface ' + (sag > 0 ? 'into' : 'along') + ' it: refused in words, before anything is built', !p.ok && re.test(p.reason) && /use less sag/.test(p.reason), p.reason);
    }
    p = CN.plan(P, a, b, { shape: 'string', sagMm: 6, ends: 'ball', result: 'separate', others: [{ soup: L.box(7.9, 2.1, 9, 9.5, 2.7, 11), name: 'shelf' }] });
    check('...a Ball is smaller, and the same shelf is clear of it', p.ok, p.reason || p.text);
    p = CN.plan(P, a, b, { shape: 'string', result: 'weld', ends: 'flat' });
    check('Flat ends, welded: refused in words (the flush cut has nothing to weld with)', !p.ok && /pick Keep separate, or Weld, Foot pad or Ball ends/.test(p.reason), p.reason);
    for (const sag of [600, -1e6]) {
      p = CN.plan(P, a, b, { shape: 'string', sagMm: sag });
      check('an absurd sag (' + sag + ') is refused for how it leaves the surface, not for some side effect of its size', !p.ok && /at anchor A it runs into the piece, not away from it - use less sag/.test(p.reason), p.reason);
    }
    p = CN.plan(P, a, b, { shape: 'string', ends: 'cup' });
    check('unknown ends are named', !p.ok && /unknown ends "cup" - Weld, Flat, Foot pad or Ball/.test(p.reason), p.reason);
    p = CN.plan(P, a, b, { shape: 'string', sagMm: 6, diameterMm: 9 });
    check('a connector too fat for its curve is refused in words, not swept inside out', !p.ok ? /sweep round that curve|bends tighter|fold/.test(p.reason) : true, p.reason || ('plans: ' + p.text));
  }

  /* ================================================================== 10 */
  console.log('\n=== 10. the readout names the path and the ends ===');
  {
    const want = [
      [{ shape: 'tube', result: 'separate', sagMm: 6, ends: 'ball' }, /^Tube Ø4\.0 × 0\.8 wall, 18\.1 mm between the anchors, sag \+6\.0 \(path 2[\d.]+ mm\), ball ends · kept as its own piece$/],
      [{ shape: 'string', result: 'weld', sagMm: -6 }, /^String Ø2\.0, 18\.1 mm between the anchors, sag -6\.0 \(path 2[\d.]+ mm\) · welds into A and B$/],
      [{ shape: 'ribbon', result: 'weld', ends: 'pad' }, /^Ribbon 6\.0 × 1\.2 mm, 18\.1 mm between the anchors, foot pad ends · welds into A and B$/],
      [{ shape: 'tapered', result: 'separate', ends: 'flat', sagMm: 2.5 }, /^Tapered Ø4\.0 → Ø1\.5, 18\.1 mm between the anchors, sag \+2\.5 \(path 1[\d.]+ mm\), flat ends · kept as its own piece$/],
      [{ shape: 'string', result: 'weld' }, /^String Ø2\.0, 18\.1 mm between the anchors · welds into A and B$/]
    ];
    want.forEach(([o, re]) => {
      const p = CN.plan(P, a, b, o);
      check(JSON.stringify(o), p.ok && re.test(p.text), p.text || p.reason);
    });
  }


  /* ================================================================== 11 */
  console.log('\n=== 11. the anchor is the point under the cursor ===');
  {
    const BC = L.box(0, 0, 0, 20, 20, 10), BO = L.box(40, 0, 0, 60, 20, 10);       // "box_closed", "box_open"
    const PB = [BC, BO], TB = PB.map(x => BR.index(x));
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    const near = (p, q, tol) => dist(p, q) <= tol;
    // The centre of the cut where a flush-ended connector meets the surface: the mean of its vertices on that plane.
    const cutCentre = (soup, at, n) => {
      const v = verts(soup).filter(q => Math.abs(dot(sub(q, at), n)) < 1e-4);
      return v.length ? mean(v) : null;
    };

    // ---- corner to corner
    const cA = [20, 0, 10], cB = [40, 0, 10];                 // the facing top corners
    const a1 = exact(TB, 0, hitAt(BC, cA, [0, 0, 1]), { name: 'box_closed' }), b1 = exact(TB, 1, hitAt(BO, cB, [0, 0, 1]), { name: 'box_open' });
    check('a click on a corner is an edge pick, as Bridge classes it', a1.target.kind === 'edge' && b1.target.kind === 'edge', a1.target.kind + ' | ' + b1.target.kind);
    const r3 = 1 / Math.sqrt(3);
    check('...its leave direction is the average of the THREE faces\' normals there (±1, -1, 1)/√3',
      near(a1.target.leaveNormal, [r3, -r3, r3], 1e-9) && near(b1.target.leaveNormal, [-r3, -r3, r3], 1e-9), a1.target.leaveNormal.map(x => x.toFixed(4)) + ' | ' + b1.target.leaveNormal.map(x => x.toFixed(4)));
    check('...and it says so: "on box_closed at its corner"', a1.info.text === 'on box_closed at its corner' && b1.info.text === 'on box_open at its corner', a1.info.text + ' | ' + b1.info.text);
    for (const result of ['separate', 'weld']) {
      const t0 = Date.now();
      const p = CN.plan(PB, a1, b1, { shape: 'string', result });
      check('corner to corner, ' + result + ': plans', p.ok, p.reason || p.text);
      const e0 = dist(p.anchors[0].p, cA), e1 = dist(p.anchors[1].p, cB);
      check('...the connector\'s ends are the clicked corners, not the middle of the boxes (≤ 0.1 mm)', e0 <= 0.1 && e1 <= 0.1, e0.toExponential(1) + ' / ' + e1.toExponential(1) + ' mm; length ' + p.lengthMm.toFixed(3));
      check('...it leaves along the corner\'s average normal', near(p.anchors[0].n, [r3, -r3, r3], 1e-9) && near(p.anchors[1].n, [-r3, -r3, r3], 1e-9));
      const r = await CN.weld(p, { union });
      check('...builds', r.ok, r.ok ? (r.soup.length / 9) + ' triangles' : r.reason);
      if (result === 'separate') {
        const c0 = cutCentre(r.soup, cA, p.anchors[0].n), c1 = cutCentre(r.soup, cB, p.anchors[1].n);
        check('...measured off the soup: the flush cut at each end is centred on the clicked point (≤ 0.1 mm)', c0 && c1 && near(c0, cA, 0.1) && near(c1, cB, 0.1),
          c0 && c1 ? dist(c0, cA).toExponential(1) + ' / ' + dist(c1, cB).toExponential(1) : 'no cut found');
        canonical('corners separate', r.soup);
      } else {
        const sh = shells(r.soup);
        check('...the two boxes and the string are ONE closed solid', sh.length === 1 && sh[0].volume > 0 && r.kernel.open === 0 && r.kernel.nm === 0, sh.length + ' shell(s)');
        canonical('corners weld', r.soup);
        TABLE.push(['two boxes, corner to corner · string weld', '24 → ' + (r.soup.length / 9), 'one solid', 'ends at the corners (≤ 0.1 mm)', p.lengthMm.toFixed(3) + ' mm', ms(t0)]);
      }
    }

    // ---- the leave-angle guard asks the FACES, not the averaged normal
    {
      const lv = [
        ['straight across: (20,0,10) -> (40,0,10), along +X', [20, 0, 10], [40, 0, 10]],
        ['across and over: (20,20,10) -> (40,0,10), 45° to the edges', [20, 20, 10], [40, 0, 10]],
        ['across and back: (20,0,10) -> (40,20,10)', [20, 0, 10], [40, 20, 10]]
      ];
      for (const [label, pa, pb] of lv) {
        const t0 = Date.now();
        const la = exact(TB, 0, hitAt(BC, pa, [0, 0, 1]), { name: 'box_closed' }), lb = exact(TB, 1, hitAt(BO, pb, [0, 0, 1]), { name: 'box_open' });
        const p = CN.plan(PB, la, lb, { shape: 'string', result: 'weld' });
        check('LEVEL corner to corner, ' + label + ': plans (a convex corner is left by any line out of the solid, not by the averaged normal)',
          la.target.kind === 'edge' && lb.target.kind === 'edge' && la.target.faceRule === 'any' && lb.target.faceRule === 'any' && p.ok, p.ok ? p.text : p.reason);
        if (!p.ok) continue;
        check('...the line really is level, and its ends are the corners (≤ 0.1 mm)', Math.abs(p.axis[2]) < 1e-9 && near(p.anchors[0].p, pa, 0.1) && near(p.anchors[1].p, pb, 0.1), 'axis z ' + p.axis[2].toExponential(1));
        const r = await CN.weld(p, { union });
        const sh = r.ok ? shells(r.soup) : [];
        check('...WELDS: the two boxes and the string are ONE closed solid', r.ok && sh.length === 1 && sh[0].volume > 0 && r.kernel.open === 0 && r.kernel.nm === 0, r.ok ? sh.length + ' shell(s), ' + (r.soup.length / 9) + ' triangles' : r.reason);
        if (r.ok) canonical('level corners ' + lv.indexOf(lv.find(x => x[0] === label)), r.soup);
        if (label.startsWith('straight')) TABLE.push(['two boxes, LEVEL top corner to corner · string weld', '24 → ' + (r.soup.length / 9), 'one solid', 'level, ends at the corners', p.lengthMm.toFixed(3) + ' mm', ms(t0)]);
        const sep = CN.plan(PB, la, lb, { shape: 'string', result: 'separate' });
        check('...and Keep separate plans it too', sep.ok, sep.reason || sep.text);
      }
      // still refused: along the corner's own edge, and into the solid
      const cornerA = () => exact(TB, 0, hitAt(BC, [20, 0, 10], [0, 0, 1]), { name: 'box_closed' });
      const alongEdge = CN.plan(PB, cornerA(), exact(TB, 0, hitAt(BC, [0, 0, 10], [0, 0, 1]), {}), { shape: 'string' });
      check('a line running back along the corner\'s own top edge is refused - the face it leaves best is 0° off, not 10°', !alongEdge.ok && /into the piece|along its surface/.test(alongEdge.reason), alongEdge.reason || alongEdge.text);
      const intoBox = CN.plan(PB, cornerA(), exact(TB, 0, hitAt(BC, [0, 20, 0], [0, 0, -1]), {}), { shape: 'string' });
      check('...and one that goes into the solid (every adjoining face has it behind it) is refused in words', !intoBox.ok && /into the piece/.test(intoBox.reason), intoBox.reason || intoBox.text);
      // flat faces keep the 10° rule: the same face anchors, the line 5° off the face
      const fa = exact(TB, 0, hitAt(BC, [20, 6, 4], [1, 0, 0]), {}), fb = exact(TB, 1, hitAt(BO, [40, 6, 4], [-1, 0, 0]), {});
      const farB = { piece: 1, target: Object.assign({}, fb.target, { point: [40, 6 + 20 / Math.tan(5 * Math.PI / 180), 4] }) };
      const flat5 = CN.plan(PB, fa, farB, { shape: 'string', result: 'separate' });
      check('flat faces keep the 10° rule: a face anchor with the line 5° off the face is refused ("along its surface")', fa.target.kind === 'face' && !flat5.ok && /along its surface/.test(flat5.reason), flat5.reason || flat5.text);

      // concave: the inside corner of an L. The faces close in on the line, so it must clear EVERY one of them.
      const Lp = (await csg.NSO_unionSoups(L.box(0, 0, 0, 30, 10, 10), L.box(0, 0, 0, 10, 30, 10))).soup;
      const Cb = L.box(30, 10, 0, 40, 20, 10), Db = L.box(30, 30, 0, 40, 40, 10);
      const PL = [Lp, Cb, Db], TL = PL.map(x => BR.index(x));
      const ia = exact(TL, 0, hitAt(Lp, [10, 10, 5], [0, 1, 0]), { name: 'L' });
      check('an L\'s inside corner is an edge whose faces close in on the line: the rule is "every face"', ia.target.kind === 'edge' && ia.target.faceRule === 'all', ia.target.kind + ' ' + ia.target.faceRule + ' ' + (ia.target.leaveNormal || []).map(x => x.toFixed(3)));
      const ib = exact(TL, 1, hitAt(Cb, [30, 12, 5], [-1, 0, 0]), { name: 'C' }), id2 = exact(TL, 2, hitAt(Db, [30, 32, 5], [-1, 0, 0]), { name: 'D' });
      const pAlong = CN.plan(PL, ia, ib, { shape: 'string', result: 'separate' }), pDiag = CN.plan(PL, ia, id2, { shape: 'string', result: 'separate' });
      check('...a line along one of them (6° off the +Y face) is refused in words - a convex corner would have let it go', !pAlong.ok && /along its surface/.test(pAlong.reason), pAlong.reason || pAlong.text);
      check('...a diagonal clear of both (≥ 40° off each) plans', pDiag.ok, pDiag.reason || pDiag.text);
    }

    // ---- a pointer never lands on the vertex: within the pick distance of a corner, the corner's three faces
    const nc = [20, 0.4, 10];                                  // 0.4 mm along the top edge from the corner (20,0,10)
    const loose = exact(TB, 0, hitAt(BC, nc, [0, 0, 1]), { name: 'box_closed' }), snug = exact(TB, 0, hitAt(BC, nc, [0, 0, 1]), { name: 'box_closed', cornerPickMm: 1 });
    check('0.4 mm from a corner on its edge, with no pick distance: the edge\'s two faces (1, 0, 1)/√2', near(loose.target.leaveNormal, [Math.SQRT1_2, 0, Math.SQRT1_2], 1e-9));
    check('...within a 1 mm pick distance it IS the corner: the three faces (1, -1, 1)/√3 - and the anchor is still the point itself, 0.4 mm along',
      near(snug.target.leaveNormal, [r3, -r3, r3], 1e-9) && snug.info.text === 'on box_closed at 0.4 mm from its corner' && near(CN.plan(PB, snug, b1, { shape: 'string', result: 'separate' }).anchors[0].p, nc, 1e-6), snug.info.text);

    // ---- Bridge reads a welded piece's flat faces as plain points: a crease within the pick distance is still a corner
    {
      const o = { kind: 'point', tri: L.triAt(BC, nc, [0, 0, 1]), point: nc, normal: [0, 0, 1], text: 'point' };
      const bare = CN.anchor(TB[0], o, { name: 'box_closed' }), within = CN.anchor(TB[0], o, { name: 'box_closed', cornerPickMm: 1 });
      check('a PLAIN POINT 0.4 mm from a box corner: its own triangle\'s normal with no pick distance; within one, the corner\'s three faces (the anchor is still the point)',
        !bare.target.leaveNormal && near(within.target.leaveNormal, [r3, -r3, r3], 1e-9) && near(within.target.point, nc, 0), within.target.leaveNormal && within.target.leaveNormal.map(x => x.toFixed(3)).join(','));
      const sp = L.sphere([0, 0, 10], 8, 32, 16), TSP = BR.index(sp), h = L.rayHit(sp, [0.01, 0.3, 10.2], [1, 0, 0]);
      const tp = BR.pick(TSP, h.tri, h.point), sw = CN.anchor(TSP, tp, { name: 'ball', cornerPickMm: 0.5 });
      check('...but a sphere\'s facets are no crease: a point on it keeps its triangle\'s normal (a pick distance within a facet)', !sw.target.leaveNormal && sw.target.point === tp.point, sw.text);
      const wide = CN.anchor(TSP, tp, { name: 'ball', cornerPickMm: 1.5 }).target.leaveNormal;
      check('...and a pick distance wider than a facet only smooths it: within 20° of the triangle\'s own', !wide || dot(wide, tp.normal) > Math.cos(20 * Math.PI / 180), wide ? wide.map(x => x.toFixed(3)).join(',') : 'none');
    }

    // ---- on an edge, 2.1 mm from the corner: the average of the TWO faces; the words give the distance
    const eC = [20, 2.1, 10];                                  // on the top edge of the side facing box_open
    const a2 = exact(TB, 0, hitAt(BC, eC, [0, 0, 1]), { name: 'box_closed' });
    check('a click 2.1 mm along the edge from the corner is an edge pick with the average of its two faces (1, 0, 1)/√2 - no third face',
      a2.target.kind === 'edge' && near(a2.target.leaveNormal, [Math.SQRT1_2, 0, Math.SQRT1_2], 1e-9), a2.target.kind + ' ' + (a2.target.leaveNormal || []).map(x => x.toFixed(4)));
    check('...the readout: "on box_closed at 2.1 mm from its corner"', a2.info.text === 'on box_closed at 2.1 mm from its corner' && Math.abs(a2.info.cornerMm - 2.1) < 1e-6, a2.info.text);
    const p2 = CN.plan(PB, a2, b1, { shape: 'string', result: 'separate' });
    check('...and the connector\'s end is that point, not the edge\'s midpoint (10 mm away)', p2.ok && near(p2.anchors[0].p, eC, 1e-6), p2.ok ? p2.anchors[0].p.map(x => x.toFixed(3)).join(',') : p2.reason);

    // ---- mid-face
    const mA = [20, 6, 4], mB = [40, 14, 6];                  // off-centre on the facing sides (centres are (20,10,5), (40,10,5))
    const a3 = exact(TB, 0, hitAt(BC, mA, [1, 0, 0]), { name: 'box_closed' }), b3 = exact(TB, 1, hitAt(BO, mB, [-1, 0, 0]), { name: 'box_open' });
    check('a mid-face click is a face pick', a3.target.kind === 'face' && b3.target.kind === 'face', a3.target.kind + ' | ' + b3.target.kind);
    check('...its words say how far the nearest corner is: "on box_closed at 7.21 mm from its corner"', a3.info.text === 'on box_closed at 7.21 mm from its corner' && Math.abs(a3.info.cornerMm - Math.sqrt(52)) < 1e-6 &&
      b3.info.text === 'on box_open at 7.21 mm from its corner', a3.info.text + ' | ' + b3.info.text);
    for (const result of ['separate', 'weld']) {
      const p = CN.plan(PB, a3, b3, { shape: 'string', result });
      check('mid-face to mid-face, ' + result + ': plans', p.ok, p.reason || p.text);
      const e0 = dist(p.anchors[0].p, mA), e1 = dist(p.anchors[1].p, mB), cen = dist(p.anchors[0].p, [20, 10, 5]);
      check('...the ends are the clicked points (≤ 0.1 mm), not the faces\' centres (' + cen.toFixed(1) + ' mm away)', e0 <= 0.1 && e1 <= 0.1 && cen > 4, e0.toExponential(1) + ' / ' + e1.toExponential(1));
      check('...it leaves along the face normals', near(p.anchors[0].n, [1, 0, 0], 1e-9) && near(p.anchors[1].n, [-1, 0, 0], 1e-9));
      const r = await CN.weld(p, { union });
      if (result === 'separate') {
        const c0 = cutCentre(r.soup, mA, [1, 0, 0]), c1 = cutCentre(r.soup, mB, [-1, 0, 0]);
        check('...measured off the soup: the cut at each end is centred on the clicked point (≤ 0.1 mm)', r.ok && c0 && c1 && near(c0, mA, 0.1) && near(c1, mB, 0.1),
          c0 && c1 ? dist(c0, mA).toExponential(1) + ' / ' + dist(c1, mB).toExponential(1) : (r.reason || 'no cut found'));
      } else {
        const sh = shells(r.soup);
        check('...welded: ONE closed solid', r.ok && sh.length === 1 && sh[0].volume > 0 && r.kernel.open === 0 && r.kernel.nm === 0, r.ok ? sh.length + ' shell(s)' : r.reason);
        canonical('mid-face weld', r.soup);
      }
    }

    // ---- Shift: the old centre / midpoint
    const sa = exact(TB, 0, hitAt(BC, mA, [1, 0, 0]), { name: 'box_closed', centre: true }), sb = exact(TB, 1, hitAt(BO, mB, [-1, 0, 0]), { name: 'box_open', centre: true });
    const ps = CN.plan(PB, sa, sb, { shape: 'string', result: 'separate' });
    check('Shift on a face: the old face centre (20,10,5) and (40,10,5)', ps.ok && near(ps.anchors[0].p, [20, 10, 5], 1e-4) && near(ps.anchors[1].p, [40, 10, 5], 1e-4) &&
      sa.info.text === 'on box_closed, face centre', ps.ok ? ps.anchors.map(x => x.p.map(v => v.toFixed(2))).join(' | ') + ' | ' + sa.info.text : ps.reason);
    const sc = exact(TB, 0, hitAt(BC, eC, [0, 0, 1]), { name: 'box_closed', centre: true });
    const pe = CN.plan(PB, sc, b1, { shape: 'string', result: 'separate' });
    check('Shift on an edge: its midpoint (20,10,10), leaving along the bisector of its two faces', pe.ok && near(pe.anchors[0].p, [20, 10, 10], 1e-4) && near(pe.anchors[0].n, [Math.SQRT1_2, 0, Math.SQRT1_2], 1e-9) &&
      sc.info.text === 'on box_closed, edge midpoint', pe.ok ? pe.anchors[0].p.join(',') + ' | ' + sc.info.text : pe.reason);
    const legacy = CN.plan(PB, end(TB, 0, hitAt(BC, mA, [1, 0, 0])), end(TB, 1, hitAt(BO, mB, [-1, 0, 0])), { shape: 'string', result: 'separate' });
    check('...and the same as the targets of tickets 1 and 2 (`centre`) always gave, to the byte', legacy.ok && same(Array.from(legacy.web), Array.from(ps.web)));

    // ---- a curved surface has no corner
    const sph = L.sphere([0, 0, 10], 8, 32, 16), TS = BR.index(sph);
    const ap = exact([TS], 0, L.rayHit(sph, [0.01, 0.3, 10.2], [1, 0, 0]), { name: 'ball' });
    check('a sphere is a point pick: "on ball", no corner to measure', ap.target.kind === 'point' && ap.info.cornerMm === null && ap.info.text === 'on ball', ap.info.text);

    // ---- three connectors in a row: each welded onto the last result
    const W = [0, 1, 2, 3].map(i => L.box(i * 40, 0, 0, i * 40 + 20, 20, 10));
    let acc = W[0];
    const wp = [[20, 5, 3], [20, 12, 7], [20, 8, 5]];
    for (let k = 0; k < 3; k++) {
      const t0 = Date.now();
      const left = acc, right = W[k + 1], PR = [left, right], TR = PR.map(x => BR.index(x));
      const pa = [k * 40 + 20, wp[k][1], wp[k][2]], pb = [(k + 1) * 40, 20 - wp[k][1], 10 - wp[k][2]];
      const ea = exact(TR, 0, hitAt(left, pa, [1, 0, 0])), eb = exact(TR, 1, hitAt(right, pb, [-1, 0, 0]));
      const p = CN.plan(PR, ea, eb, { shape: 'string', result: 'weld' });
      const r = p.ok ? await CN.weld(p, { union }) : p;
      const sh = r.ok ? shells(r.soup) : [];
      check('connector ' + (k + 1) + ' of 3, in a row: welds the next box onto the last result - one closed solid', p.ok && r.ok && sh.length === 1 && sh[0].volume > 0 && r.kernel.open === 0 && r.kernel.nm === 0 &&
        near(p.anchors[0].p, pa, 0.1) && near(p.anchors[1].p, pb, 0.1), p.ok ? (r.ok ? sh.length + ' shell(s), ends ' + dist(p.anchors[0].p, pa).toExponential(1) : r.reason) : p.reason);
      if (!r.ok) break;
      acc = r.soup;
      if (k === 2) {
        canonical('three in a row', acc);
        TABLE.push(['four boxes, three connectors in a row · string weld', '48 → ' + (acc.length / 9), 'one solid', 'three welds', 'ends at the clicks', ms(t0)]);
      }
    }
    check('...after the third the four boxes and three strings are ONE solid', shells(acc).length === 1);
  }

  /* ================================================================== 12 */
  console.log('\n=== 12. DRAW: a freehand stroke, smoothed, swept ===');
  {
    const PZ = 0.2;                                           // where a piece rests on the plate
    const up = [0, 0, 1], pt = (x, y, z, n, piece) => ({ p: [x, y, z], n: n || up, piece: piece == null ? -1 : piece });
    const dist3 = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    const polyLen = P => P.reduce((s, q, i) => i ? s + dist3(q, P[i - 1]) : 0, 0);
    // Chaikin x2 with the corners (a turn over 60°) kept, written out here, not read back from Connect: the length to hold it to
    const refSmooth = raw => {
      let P = [raw[0]];
      for (const q of raw.slice(1)) if (dist3(q, P[P.length - 1]) >= 1) P.push(q);
      for (let pass = 0; pass < 2; pass++) {
        const n = P.length, ang = i => {
          const a = sub(P[i], P[i - 1]), b = sub(P[i + 1], P[i]);
          return (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
        };
        const corner = P.map((_, i) => i === 0 || i === n - 1 || P.keep && P.keep[i] || ang(i) < 0.5);
        const out = [P[0]], keep = [true];
        for (let i = 0; i + 1 < n; i++) {
          const lerp = t => P[i].map((v, k) => v + (P[i + 1][k] - v) * t);
          if (!corner[i]) { out.push(lerp(0.25)); keep.push(false); }
          if (!corner[i + 1]) { out.push(lerp(0.75)); keep.push(false); } else { out.push(P[i + 1]); keep.push(true); }
        }
        P = out; P.keep = keep;
      }
      return P;
    };
    const area = p => { const n = p.segments, r = p.spec.d / 2; return n / 2 * Math.sin(2 * Math.PI / n) * r * r; };
    const noJitter = (P, j) => P.map((q, i) => [q[0] + j * Math.sin(i * 12.9898), q[1] + j * Math.cos(i * 78.233), q[2]]);

    // ---- the smoothing
    const sCurve = []; for (let i = 0; i <= 40; i++) { const x = i * 1.5; sCurve.push(pt(x, 5 * Math.sin(x / 9), PZ)); }
    const sm = CN.smoothStroke(sCurve);
    const gaps = sm.points.slice(1).map((q, i) => dist3(q.p, sm.points[i].p));
    check('the stroke is resampled every 1 mm', sm.ok && Math.min(...gaps) > 0.5 && Math.max(...gaps) < 1.5, 'gaps ' + Math.min(...gaps).toFixed(3) + ' .. ' + Math.max(...gaps).toFixed(3) + ' mm, ' + sm.points.length + ' points');
    const refLen = polyLen(refSmooth(sCurve.map(q => q.p)));
    check('...its length is the Chaikin x2 path\'s, computed here (≤ 0.5%)', Math.abs(sm.lengthMm - refLen) / refLen < 0.005, sm.lengthMm.toFixed(3) + ' vs ' + refLen.toFixed(3) + ' mm');
    const jit = CN.smoothStroke(noJitter(sCurve.map(q => q.p), 0.15).map(p => pt(...p)));
    check('a pointer\'s jitter (0.15 mm) makes no corner', jit.ok && !jit.points.some(q => q.corner) && Math.abs(jit.lengthMm - sm.lengthMm) / sm.lengthMm < 0.02, jit.lengthMm.toFixed(2) + ' mm');
    const el = []; for (let x = 0; x <= 20; x++) el.push(pt(x, 0, PZ)); for (let y = 1; y <= 20; y++) el.push(pt(20, y, PZ));
    const smE = CN.smoothStroke(el);
    const cn = smE.points.filter(q => q.corner);
    check('a 90° turn is a corner, and stays one: the corner (20, 0) is a point of the smoothed stroke, no cut', cn.length === 1 && dist3(cn[0].p, [20, 0, PZ]) < 1e-9, cn.length + ' corner(s)');
    const bend = []; for (let i = 0; i <= 24; i++) { const a = Math.min(i, 12) * 0, x = i * 1; bend.push(pt(x, i <= 12 ? 0 : (i - 12) * Math.tan(50 * Math.PI / 180), PZ)); }
    check('a 50° turn is smoothed (not a corner): Chaikin rounds it', !CN.smoothStroke(bend).points.some(q => q.corner));
    check('a stroke under 3 mm is refused in words, a point is no stroke, nothing is built',
      /2\.5 mm long - draw at least 3\.0 mm/.test(CN.drawPlan([], [pt(0, 0, PZ), pt(2.5, 0, PZ)], { shape: 'string' }).reason) &&
      /a point/.test(CN.drawPlan([], [pt(0, 0, PZ)], { shape: 'string' }).reason) && CN.drawPlan([], [pt(0, 0, PZ), pt(3.2, 0, PZ)], { shape: 'string' }).ok);

    // ---- plate to plate: a closed piece of its own
    {
      const t0 = Date.now();
      const p = CN.drawPlan([], sCurve, { shape: 'string', plateZ: PZ });
      check('plate to plate: plans, and it is its own piece (a stroke with both ends on the plate never welds), whatever Result says', p.ok && p.result === 'separate' && p.welds.length === 0 &&
        CN.drawPlan([], sCurve, { shape: 'string', result: 'weld' }).result === 'separate', p.reason || p.text);
      const r = await CN.weld(p, { union });
      check('...builds a closed manifold piece', r.ok && r.topo.open === 0 && r.topo.nm === 0 && r.topo.badWinding === 0 && r.topo.shells === 1 && r.topo.euler === 2, r.ok ? JSON.stringify(r.topo) : r.reason);
      canonical('draw plate to plate', r.soup);
      const meas = BR.volume(r.soup) / area(p);
      check('...its length (volume / section area) is within 2% of the smoothed path (' + refLen.toFixed(2) + ' mm, Chaikin written out in the test)', Math.abs(meas - refLen) / refLen < 0.02, meas.toFixed(3) + ' mm, ' + (100 * (meas - refLen) / refLen).toFixed(2) + '%');
      const v = verts(r.soup), lo = Math.min(...v.map(q => q[2])), hi = Math.max(...v.map(q => q[2]));
      check('...it lies ON the plate: the bottom is at the plate (' + PZ + ') and the top a diameter above', lo >= PZ - 1e-6 && lo < PZ + 0.01 && Math.abs(hi - (PZ + 2)) < 0.01, lo.toFixed(4) + ' .. ' + hi.toFixed(4));
      const e0 = sCurve[0].p, e1 = sCurve[sCurve.length - 1].p;
      const endLo = e => Math.min(...v.filter(q => dist3([q[0], q[1], 0], [e[0], e[1], 0]) < 1.6).map(q => q[2]));
      const capOf = (e, d) => { const w = v.filter(q => dist3([q[0], q[1], 0], [e[0], e[1], 0]) < 1.6); const m = Math.max(...w.map(q => d[0] * q[0] + d[1] * q[1])); return w.filter(q => Math.abs(d[0] * q[0] + d[1] * q[1] - m) < 1e-4); };
      const dir0 = unitv([p.centre[0][0] - p.centre[1][0], p.centre[0][1] - p.centre[1][1], 0]), dir1 = unitv([p.centre[p.centre.length - 1][0] - p.centre[p.centre.length - 2][0], p.centre[p.centre.length - 1][1] - p.centre[p.centre.length - 2][1], 0]);
      const c0 = capOf(e0, dir0), c1 = capOf(e1, dir1);
      check('...BOTH ends are flat feet on the plate: each end is a square cap standing on it (' + c0.length + ' / ' + c1.length + ' vertices on a plane across the path), its lowest point on the plate',
        c0.length >= 16 && c1.length >= 16 && endLo(e0) < PZ + 0.01 && endLo(e1) < PZ + 0.01 && Math.abs(Math.min(...c0.map(q => q[2])) - PZ) < 0.01 && Math.abs(Math.min(...c1.map(q => q[2])) - PZ) < 0.01,
        endLo(e0).toFixed(4) + ' / ' + endLo(e1).toFixed(4));
      TABLE.push(['draw · plate to plate · string', '66 points → ' + (r.soup.length / 9), 'Euler 2', 'its own piece', 'length ' + meas.toFixed(2) + ' vs ' + refLen.toFixed(2) + ' mm', ms(t0)]);
    }

    // ---- every shape, plate to plate
    for (const [shape, extra] of [['ribbon', {}], ['tube', {}], ['tapered', {}]]) {
      const p = CN.drawPlan([], sCurve, Object.assign({ shape, plateZ: PZ }, extra));
      const r = p.ok ? await CN.weld(p, { union }) : p;
      const sh = r.ok ? shells(r.soup) : [];
      check(shape + ' plate to plate: a closed piece' + (shape === 'tube' ? ' with its bore sealed' : '') + ', lying on the plate', p.ok && r.ok && r.topo.open === 0 && r.topo.nm === 0 && r.topo.badWinding === 0 &&
        sh.filter(x => x.volume > 0).length === 1 && sh.filter(x => x.volume < 0).length === (shape === 'tube' ? 1 : 0) && Math.abs(L.bounds(r.soup).lo[2] - PZ) < 0.01,
        p.ok ? (r.ok ? JSON.stringify(r.topo) : r.reason) : p.reason);
    }

    // ---- the boxes: A (0..20) and B (40..60), 10 high
    const TOP = PZ + 10, BA = L.box(0, 0, PZ, 20, 20, TOP), BB = L.box(40, 0, PZ, 60, 20, TOP), PB2 = [BA, BB];
    const inside = (b, q, e) => q[0] > b[0] + e && q[0] < b[3] - e && q[1] > b[1] + e && q[1] < b[4] - e && q[2] > b[2] + e && q[2] < b[5] - e;
    const boxA = [0, 0, PZ, 20, 20, TOP], boxB = [40, 0, PZ, 60, 20, TOP];

    // ---- a sample AT the crease (a real drag lands there as often as it steps over it): one corner, not two
    {
      const st = [];
      for (let y = -20; y <= -10; y++) st.push(pt(10, y, PZ));                                     // the plate in front of A's front face (y = 0 is far: use a wall at y = -10)
      for (let z = PZ + 1; z <= TOP; z++) st.push(pt(10, -10, z, [0, -1, 0], 0));                  // up the wall, the last sample ON the top edge
      st.push(pt(10, -9.97, TOP, up, 0));
      for (let y = -9; y <= 0; y++) st.push(pt(10, y, TOP, up, 0));
      const sc = CN.smoothStroke(st), cs = sc.points.map((q, i) => ({ q, i })).filter(x => x.q.corner);
      check('a sample at the crease and the sample just past it: the stroke has one corner at each of the two creases (the wall\'s foot, its top), none doubled',
        cs.length === 2 && dist3(cs[0].q.p, [10, -10, PZ]) < 0.05 && dist3(cs[1].q.p, [10, -10, TOP]) < 0.05, cs.map(x => x.q.p.map(v => v.toFixed(2)).join(',')).join(' | '));
      const wall = L.box(0, -10, PZ, 20, 10, TOP);
      const pl = CN.drawPlan([wall], st, { shape: 'string', plateZ: PZ, result: 'weld' });
      check('...and it plans, welds into the piece', pl.ok && pl.welds.length === 1, pl.reason || pl.text);
    }

    // ---- plate to piece: welded
    {
      const t0 = Date.now();
      const st = []; for (let x = -30; x <= 0; x++) st.push(pt(x, 10, PZ));
      for (let z = PZ; z <= TOP; z++) st.push(pt(0, 10, z, [-1, 0, 0], 0));
      for (let x = 1; x <= 10; x++) st.push(pt(x, 10, TOP, up, 0));
      for (const ends of ['weld', 'pad', 'ball']) {
        const p = CN.drawPlan([BA], st, { shape: 'string', plateZ: PZ, ends });
        check('plate to piece, ends = ' + ends + ': plans, welds into the piece (and only it)', p.ok && p.result === 'weld' && p.welds.length === 1 && p.welds[0] === 0 && p.endsOn.join() === 'plate,piece', p.reason || p.text);
        if (!p.ok) continue;
        const r = await CN.weld(p, { union });
        const sh = r.ok ? shells(r.soup) : [];
        check('...the box and the stroke are ONE closed solid (the plate end is a flat foot, the end on the piece follows Ends)', r.ok && sh.length === 1 && sh[0].volume > 0 && r.kernel.open === 0 && r.kernel.nm === 0 &&
          Math.abs(L.bounds(r.soup).lo[2] - PZ) < 0.01, r.ok ? sh.length + ' shell(s), ' + (r.soup.length / 9) + ' triangles' : r.reason);
        if (ends === 'weld') {
          canonical('draw plate to piece', r.soup);
          const gained = BR.volume(r.soup) - BR.volume(BA);
          check('...it grew by about the stroke\'s volume (the part outside the box): ' + gained.toFixed(1) + ' mm³ of ' + (area(p) * p.lengthMm).toFixed(1), gained > 0.4 * area(p) * p.lengthMm && gained < area(p) * p.lengthMm * 1.05, gained.toFixed(2));
          TABLE.push(['draw · plate to piece · string weld', (BA.length / 9) + ' + ' + (p.web.length / 9) + ' → ' + (r.soup.length / 9), 'one solid', 'welded into the box', p.lengthMm.toFixed(2) + ' mm', ms(t0)]);
        }
      }
      const fl = CN.drawPlan([BA], st, { shape: 'string', plateZ: PZ, ends: 'flat' });
      check('...Flat ends with Weld on a piece end: refused in words (nothing to weld a flush cut with); Keep separate makes it', !fl.ok && /Flat ends are cut flush/.test(fl.reason) && CN.drawPlan([BA], st, { shape: 'string', plateZ: PZ, ends: 'flat', result: 'separate' }).ok, fl.reason);
      const tp = CN.drawPlan([BA], st, { shape: 'string', plateZ: PZ, ends: 'ball' });
      check('...a Ball is only at the end on the piece: the plate end has no tip of its own', tp.ok && tp.tips && tp.tips[0] === null && tp.tips[1] && tp.tips[1].length > 0);
    }

    // ---- piece to piece over the plate: welded both, rides the surface
    {
      const t0 = Date.now();
      const st = [];
      for (let x = 5; x <= 20; x++) st.push(pt(x, 10, TOP, up, 0));
      for (let z = TOP; z >= PZ; z--) st.push(pt(20, 10, z, [1, 0, 0], 0));
      for (let x = 21; x <= 39; x++) st.push(pt(x, 10, PZ, up, -1));
      for (let z = PZ; z <= TOP; z++) st.push(pt(40, 10, z, [-1, 0, 0], 1));
      for (let x = 41; x <= 55; x++) st.push(pt(x, 10, TOP, up, 1));
      const ps = CN.drawPlan(PB2, st, { shape: 'string', plateZ: PZ, result: 'separate' });
      check('piece to piece (over the plate between them), Keep separate: plans as a piece of its own', ps.ok && ps.result === 'separate' && ps.welds.length === 0 && ps.endsOn.join() === 'piece,piece', ps.reason || ps.text);
      const rs = ps.ok ? await CN.weld(ps, { union }) : ps;
      const vs = rs.ok ? verts(rs.soup) : [];
      check('...a closed piece that rides the surface: no vertex of it is inside either box, and it touches them (the lowest point on the first top is on it, ≤ 0.02 mm)',
        rs.ok && rs.topo.open === 0 && rs.topo.nm === 0 && !vs.some(q => inside(boxA, q, 1e-3) || inside(boxB, q, 1e-3)) &&
        Math.abs(Math.min(...vs.filter(q => q[0] > 6 && q[0] < 17).map(q => q[2])) - TOP) < 0.02, rs.ok ? JSON.stringify(rs.topo) : rs.reason);
      // (the straight stretches: not the tip's start, the ramps up to a bend, or the bends themselves)
      const onA = ps.centre.filter(c => c[0] > 6 && c[0] < 14), onPlate = ps.centre.filter(c => c[0] > 24 && c[0] < 36), onWall = ps.centre.filter(c => c[2] > PZ + 2.8 && c[2] < 5.3 && c[0] < 30);
      check('...its centre is the shape\'s half-height (1 mm) off the surface: ' + (TOP + 1) + ' over the top of A, ' + (PZ + 1).toFixed(1) + ' over the plate, 21 along A\'s wall (x)',
        onA.every(c => Math.abs(c[2] - (TOP + 1)) < 0.02) && onPlate.every(c => Math.abs(c[2] - (PZ + 1)) < 0.02) && onWall.length >= 2 && onWall.every(c => Math.abs(c[0] - 21) < 0.1),
        onA.length + '/' + onPlate.length + '/' + onWall.length + ' samples');
      const pw = CN.drawPlan(PB2, st, { shape: 'string', plateZ: PZ });
      check('piece to piece, Weld: plans, welds into BOTH pieces', pw.ok && pw.result === 'weld' && pw.welds.length === 2, pw.reason || pw.text);
      const rw = pw.ok ? await CN.weld(pw, { union }) : pw;
      const sw = rw.ok ? shells(rw.soup) : [];
      check('...the two boxes and the stroke are ONE closed solid', rw.ok && sw.length === 1 && sw[0].volume > 0 && rw.kernel.open === 0 && rw.kernel.nm === 0, rw.ok ? sw.length + ' shell(s), ' + (rw.soup.length / 9) + ' triangles' : rw.reason);
      if (rw.ok) canonical('draw piece to piece', rw.soup);
      const embedded = pw.centre.filter(c => c[0] > 9 && c[0] < 14);
      check('...where it is welded it is sunk into the piece (0.4 mm, the most of the half-height), so the boolean has material to merge: ' + (TOP + 0.6).toFixed(1) + ' over the top', embedded.length > 3 && embedded.every(c => Math.abs(c[2] - (TOP + 0.6)) < 0.02), embedded.map(c => c[2].toFixed(2)).slice(0, 3).join(','));
      if (rw.ok) TABLE.push(['draw · piece to piece over the plate · string weld', '24 + ' + (pw.web.length / 9) + ' → ' + (rw.soup.length / 9), 'one solid', 'welded into both', pw.lengthMm.toFixed(2) + ' mm', ms(t0)]);
    }

    // ---- sag: a lift of the middle
    {
      const line = []; for (let x = 0; x <= 40; x++) line.push(pt(x, 0, PZ));
      for (const sag of [0, 6]) {
        const p = CN.drawPlan([], line, { shape: 'string', plateZ: PZ, sagMm: sag });
        const r = p.ok ? await CN.weld(p, { union }) : p;
        const v = r.ok ? verts(r.soup) : [];
        const mid = v.filter(q => Math.abs(q[0] - 20) < 1.5), tops = (xs) => Math.max(...v.filter(q => Math.abs(q[0] - xs) < 1.5).map(q => q[2]));
        const peak = tops(20), end0 = v.filter(q => q[0] < 1.2), end1 = v.filter(q => q[0] > 38.8);
        check('Sag ' + sag + ': ' + (sag ? 'the middle is raised by exactly ' + sag + ' mm (its top ' + (PZ + 2 + sag).toFixed(1) + ' over the plate), the ends stay on the plate' : 'flat on the plate: nothing above a diameter'),
          p.ok && r.ok && r.topo.open === 0 && r.topo.nm === 0 && Math.abs(peak - (PZ + 2 + sag)) < 0.1 && Math.min(...end0.map(q => q[2])) < PZ + 0.02 && Math.min(...end1.map(q => q[2])) < PZ + 0.02 &&
          (sag ? true : Math.max(...v.map(q => q[2])) < PZ + 2 + 0.01), p.ok ? (r.ok ? 'peak ' + peak.toFixed(3) : r.reason) : p.reason);
        if (sag) {
          check('...it is an arch: a quarter in it stands about half way up (sin²), and the text says so', Math.abs((tops(10) - PZ - 2) - sag * 0.5) < 0.4 && /lift \+6\.0/.test(p.text), (tops(10) - PZ - 2).toFixed(2) + ' mm, ' + p.text);
          canonical('draw sag 6', r.soup);
        }
      }
      check('a negative Sag is refused in words: Draw lifts, it does not hang', /Draw lifts the stroke/.test(CN.drawPlan([], line, { shape: 'string', sagMm: -3 }).reason));
    }
  }

  console.log('\n=== table ===');
  console.log('| case | triangles | topology | shells | measured | time |');
  console.log('|---|---|---|---|---|---|');
  TABLE.forEach(r => console.log('| ' + r.join(' | ') + ' |'));
  console.log('\n' + pass + ' passed, ' + fail + ' failed' + (fail ? ': ' + FAILS.join('; ') : ''));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

function CN_SHAPES() { return CN.SHAPES; }
