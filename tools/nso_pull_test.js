#!/usr/bin/env node
/* Pull, headless: the densify, the field, and the guards.
     node tools/nso_pull_test.js            exit 0 = every gate held
     npm run pull:test

   The pointer session is proven in tools/nso_pull_drive_check.js; this is the
   geometry, on its own, with no browser. Every output that is meant to be a
   good mesh goes through the canonical checker, tools/mesh_validate.py
   --gate, as a real STL on disk, exactly as the repo defines it.

   Sections
     1  nso_densify.js   a coarse box and a revolved tube, to 0.5 mm
     2  the field        bell, grab, pins, "nearest handle wins"
     3  Stock tube       grab the lip, pull 6 mm: 6 mm at the grab, 0 at the
                         radius, wall 1.6 +- 0.05, manifold, mesh_validate clean
     4  pins             pin one side of the lip, pull the other
     5  coarse box       densified under the grab; a smooth bump, not a kink
     6  guards           a 0.8 mm wall pulled 2 mm is refused in words, piece
                         unchanged; a pull through itself is refused
*/

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const D = require('../nso_densify.js');
const PL = require('../nso_pull.js');
const STOCK = require('../nso_stock.js');
const TH = require('../nso_thickness.js');
const REPAIR = require('../NSO_Repair.js').NSO_Repair;
const { writeSTL } = require('./nso_stl_io.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-pull-'));
const MV = path.join(ROOT, 'tools', 'mesh_validate.py');

let pass = 0, fail = 0;
const FAILS = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok    ' + label + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(label); console.log('  FAIL  ' + label + (detail ? '\n          ' + detail : '')); }
}
const f3 = v => (Math.round(v * 1000) / 1000).toString();

/* ------------------------------------------------------------- helpers */

const tube = (rOut, wall, h) => STOCK.revolve(STOCK.profileTube(rOut, rOut - wall, h), 96);

/* Open / non-manifold / mis-wound edges and the signed volume, of a soup. */
function topology(soup) {
  const m = D.weld(soup);
  const und = new Map(), dir = new Map();
  for (let t = 0; t < m.triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const u = m.tri[t * 3 + e], v = m.tri[t * 3 + (e + 1) % 3];
      const k = u < v ? u + '_' + v : v + '_' + u;
      und.set(k, (und.get(k) || 0) + 1);
      dir.set(u + '>' + v, (dir.get(u + '>' + v) || 0) + 1);
    }
  }
  let open = 0, nm = 0, wind = 0, degen = 0, vol = 0, area = 0;
  und.forEach(c => { if (c === 1) open++; else if (c > 2) nm++; });
  dir.forEach(c => { if (c > 1) wind++; });
  for (let t = 0; t < m.triCount; t++) {
    const a = m.tri[t * 3] * 3, b = m.tri[t * 3 + 1] * 3, c = m.tri[t * 3 + 2] * 3, P = m.pos;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const A = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
    area += A; if (A < 1e-12) degen++;
    vol += (P[a] * nx + P[a + 1] * ny + P[a + 2] * nz) / 6;
  }
  return { tris: m.triCount, open, nm, wind, degen, vol, area, mesh: m };
}

/* mesh_validate.py --gate on a real STL; returns its parsed --json report. */
function canonical(soup, tag) {
  const p = path.join(TMP, tag + '.stl');
  writeSTL(p, soup, 'nso pull ' + tag);
  let out;
  try { out = execFileSync('python3', [MV, p, '--json', '--gate'], { maxBuffer: 1 << 28 }); }
  catch (e) { out = e.stdout; }              // --gate exits 1 on a failing verdict; the report is still on stdout
  return JSON.parse(out.toString());
}

/* Distance from a point to the grab, with the vertex positions of a prepared S. */
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const vpos = (pos, v) => [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]];

/* Aspect ratios (mesh_validate's: longest edge over twice the inradius). */
function aspects(mesh) {
  const out = [];
  for (let t = 0; t < mesh.triCount; t++) {
    const [a, b, c] = [mesh.tri[t * 3], mesh.tri[t * 3 + 1], mesh.tri[t * 3 + 2]];
    const A = vpos(mesh.pos, a), B = vpos(mesh.pos, b), C = vpos(mesh.pos, c);
    const x = dist(A, B), y = dist(B, C), z = dist(C, A), s = (x + y + z) / 2;
    const ar = Math.sqrt(Math.max(0, s * (s - x) * (s - y) * (s - z)));
    out.push(ar > 0 ? Math.max(x, y, z) / (2 * ar / s) : Infinity);
  }
  return out.sort((p, q) => p - q);
}

/* The wall under every moved vertex of a prepared+displaced S, measured here
   with NSO_Thickness and this file's own normals - not the engine's. Only
   vertices on the tube's wall proper: facing sideways, and clear of the rim. */
function wallRange(S, soup, rimZ) {
  const P = TH.prepare(soup, {});
  const m = S.mesh, pos = S.pos, nrm = new Float64Array(m.vertCount * 3);
  for (let t = 0; t < m.triCount; t++) {
    const a = m.tri[t * 3] * 3, b = m.tri[t * 3 + 1] * 3, c = m.tri[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { nrm[i] += cx; nrm[i + 1] += cy; nrm[i + 2] += cz; }
  }
  let lo = Infinity, hi = 0, n = 0;
  for (let q = 0; q < S.moved.length; q++) {
    const v = S.moved[q] * 3;
    const L = Math.hypot(nrm[v], nrm[v + 1], nrm[v + 2]);
    if (!(L > 0)) continue;
    const nz = nrm[v + 2] / L;
    if (Math.abs(nz) > 0.35 || pos[v + 2] > rimZ) continue;
    const w = P.wallAt([pos[v], pos[v + 1], pos[v + 2]], { normal: [nrm[v] / L, nrm[v + 1] / L, nrm[v + 2] / L], probe: 2.2 });
    if (!w.measured) continue;
    n++; if (w.mm < lo) lo = w.mm; if (w.mm > hi) hi = w.mm;
  }
  return { lo, hi, n };
}

/* ============================================================ 1. DENSIFY */
console.log('\n=== 1. nso_densify.js - subdivide to 0.5 mm under a sphere ===');
{
  const box = STOCK.boxSoup(20, 20, 20);
  const before = topology(box);
  const t0 = Date.now();
  const r = D.region(box, { c: [0, 0, 20], r: 12 }, {});
  const after = topology(r.soup);
  ok(r.ok && r.changed, 'a 12-triangle box is densified under a 12 mm zone',
     before.tris + ' -> ' + after.tris + ' triangles in ' + (Date.now() - t0) + ' ms');
  ok(after.open === 0 && after.nm === 0 && after.wind === 0,
     'the result is closed, 2-manifold and consistently wound', JSON.stringify({ open: after.open, nm: after.nm, wind: after.wind }));
  ok(after.degen === 0, 'no degenerate triangle');
  ok(Math.abs(after.vol - before.vol) < 1e-6 && Math.abs(after.area - before.area) < 1e-6,
     'the surface is geometrically unchanged', 'volume ' + f3(before.vol) + ' -> ' + f3(after.vol) + ', area ' + f3(before.area) + ' -> ' + f3(after.area));
  // every edge of every triangle the sphere reaches is <= 0.5 mm
  let worst = 0, inside = 0;
  const m = r.mesh;
  for (let t = 0; t < m.triCount; t++) {
    const [a, b, c] = [m.tri[t * 3], m.tri[t * 3 + 1], m.tri[t * 3 + 2]];
    if (D.triDist2(m.pos, a, b, c, [0, 0, 20]) > 12 * 12) continue;
    inside++;
    worst = Math.max(worst, dist(vpos(m.pos, a), vpos(m.pos, b)), dist(vpos(m.pos, b), vpos(m.pos, c)), dist(vpos(m.pos, c), vpos(m.pos, a)));
  }
  ok(worst <= 0.5 + 1e-9, 'every edge under the grab is at most 0.5 mm', 'longest ' + f3(worst) + ' mm over ' + inside + ' triangles');
  // far side untouched
  let bottom = 0;
  for (let t = 0; t < m.triCount; t++) {
    if ([0, 1, 2].every(k => m.pos[m.tri[t * 3 + k] * 3 + 2] === 0)) bottom++;
  }
  // (Not exactly two: a cut that makes a side-face triangle conform splits the
  // bottom edge it shares, and the bottom triangle on the other side of that
  // edge is split to match - a handful, and none of the dense field.)
  ok(bottom <= 16, 'the bottom face, 20 mm from the grab, is not densified', bottom + ' triangles (it began as 2)');
  // original corners survive with their exact coordinates
  const have = new Set();
  for (let v = 0; v < m.vertCount; v++) have.add(m.pos[v * 3] + ',' + m.pos[v * 3 + 1] + ',' + m.pos[v * 3 + 2]);
  const corners = [];
  for (let i = 0; i < box.length; i += 3) corners.push(box[i] + ',' + box[i + 1] + ',' + box[i + 2]);
  ok(corners.every(k => have.has(k)), 'every original vertex keeps its exact coordinates');
  const again = D.region(r.soup, { c: [0, 0, 20], r: 12 }, {});
  ok(again.report.splits === 0 && !again.changed, 'a region that is already fine is left alone', D.say(again.report));
  const mv = canonical(r.soup, 'densify-box');
  ok(mv.verdict === 'PASS', 'densified box: mesh_validate.py --gate PASS', mv.triangles + ' triangles');
}
{
  const soup = tube(10, 1.6, 60);
  const before = topology(soup);
  const t0 = Date.now();
  const r = D.region(soup, { c: [9.2, 0, 60], r: 12 }, {});
  const after = topology(r.soup);
  ok(r.report.trisAfter < 40000, 'a 96-segment tube lip is densified without needles piling up',
     before.tris + ' -> ' + after.tris + ' triangles in ' + (Date.now() - t0) + ' ms (bisection alone made 99,000)');
  ok(after.open === 0 && after.nm === 0 && after.wind === 0 && after.degen === 0,
     'closed, 2-manifold, consistently wound, nothing degenerate');
  // float32 soup: new points on a slanted facet are off its plane by ~1e-7, so relative
  ok(Math.abs(after.vol - before.vol) / before.vol < 1e-6 && Math.abs(after.area - before.area) / before.area < 1e-6,
     'the surface is geometrically unchanged (to float32)', 'volume ' + f3(before.vol) + ' -> ' + f3(after.vol) + ', area ' + f3(before.area) + ' -> ' + f3(after.area));
  const asp = aspects(r.mesh), p90 = asp[Math.floor(asp.length * 0.9)];
  ok(p90 < 6, 'the triangles are not needles', 'median aspect ' + f3(asp[asp.length >> 1]) + ', 90th percentile ' + f3(p90));
  const mv = canonical(r.soup, 'densify-tube');
  ok(mv.verdict === 'PASS', 'densified tube: mesh_validate.py --gate PASS (no phantom piercing pairs)',
     mv.triangles + ' triangles, piercing ' + (mv.self_intersection && mv.self_intersection.pierce));
}
{
  /* The canonical checker calls thin, nearly coplanar triangles on a slanted
     facet "piercing" when float32 puts them a millionth of a millimetre off
     plane. The first densify produced them in 24 of 40 zones on this tube; the
     quad ladders, the shared cuts and the grading take it to none. A zone on
     the rim, on the inside, on the outside, at several radii - and a seeded
     generator, so a failure is a failure on every run. */
  const soup = tube(10, 1.6, 60);
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  let phantom = 0, zones = 0, tris = 0;
  for (let k = 0; k < 16; k++) {
    const th = rnd() * Math.PI * 2, rr = [8.4, 9.2, 10][k % 3], z = [60, 55, 30][k % 3] * (0.9 + 0.1 * rnd()), r = [5, 8, 12, 20][k % 4];
    const reg = D.region(soup, { c: [rr * Math.cos(th), rr * Math.sin(th), z], r }, {});
    phantom += REPAIR._selfIntersectionDetail(REPAIR._weldToIndexed(reg.soup, 1e-4).mesh).pierce;
    zones++; tris += reg.mesh.triCount;
  }
  ok(phantom === 0, 'no phantom piercing pairs in 16 pseudo-random zones on the tube (rim, inside, outside; r 5-20)', zones + ' zones, ' + tris + ' triangles, ' + phantom + ' pairs');
}
{
  // a wall much longer than the zone: only the zone's part is fine
  const soup = tube(10, 1.6, 200);
  const r = D.region(soup, { c: [10, 0, 100], r: 12 }, {});
  ok(r.report.trisAfter < 60000, 'a 200 mm wall with a 12 mm zone in its middle stays small',
     r.report.trisBefore + ' -> ' + r.report.trisAfter);
}

/* ============================================================== 2. FIELD */
console.log('\n=== 2. the field - bell, grab, pins ===');
{
  ok(PL.bell(0, 12) === 1 && PL.bell(12, 12) === 0 && PL.bell(20, 12) === 0, 'the bell is 1 at the centre and 0 at the radius and beyond');
  let mono = true, prev = 1;
  for (let i = 1; i <= 1200; i++) { const b = PL.bell(i / 100, 12); if (b > prev + 1e-15) mono = false; prev = b; }
  ok(mono, 'the bell only ever falls');
  ok(PL.bell(0.01, 12) > 0.99999 && PL.bell(11.99, 12) < 1e-5, 'flat at both ends (no cliff at the radius)');
  const g = { c: [0, 0, 0], r: 12 };
  ok(PL.phiAt(g, [], [0, 0, 0]) === 1 && Math.abs(PL.phiAt(g, [], [6, 0, 0]) - 0.5) < 1e-12, 'with no pins phi is the bell of the distance to the grab');
  const pins = [{ c: [8, 0, 0], r: 10 }];
  ok(PL.phiAt(g, pins, [8, 0, 0]) < 1e-8, 'a pin holds its own spot', 'phi ' + PL.phiAt(g, pins, [8, 0, 0]));
  ok(PL.phiAt(g, pins, [0, 0, 0]) > 1 - 1e-6, 'the grab follows exactly even with a pin\'s radius over it', 'phi ' + PL.phiAt(g, pins, [0, 0, 0]));
  ok(PL.phiAt(g, pins, [-5, 0, 0]) === PL.phiAt(g, [], [-5, 0, 0]), 'outside every pin radius a pin changes nothing');
  // nearest handle wins, and wins smoothly: scan across the bisector
  let jump = 0, last = PL.phiAt(g, pins, [0, 0, 0]);
  for (let i = 1; i <= 800; i++) {
    const v = PL.phiAt(g, pins, [i / 100, 0, 0]);
    jump = Math.max(jump, Math.abs(v - last)); last = v;
  }
  ok(jump < 0.02, 'no step where "nearest" changes hands', 'largest change over 0.01 mm: ' + jump.toFixed(5));
  const nearPin = PL.phiAt(g, pins, [7, 0, 0]), nearGrab = PL.phiAt(g, pins, [1, 0, 0]);
  ok(nearPin < 0.1 * PL.phiAt(g, [], [7, 0, 0]) && nearGrab > 0.9 * PL.phiAt(g, [], [1, 0, 0]),
     'nearer the pin the pin wins, nearer the grab the grab does', 'phi 1 mm from the pin ' + nearPin.toFixed(4) + ', 1 mm from the grab ' + nearGrab.toFixed(4));
}

/* ====================================================== 3. THE STOCK TUBE */
console.log('\n=== 3. Stock tube D20 wall 1.6 - grab the lip, pull 6 mm outward (the section rule) ===');
{
  const soup = tube(10, 1.6, 60);
  const R = 50, grab = { c: [9.2, 0, 60], r: R }, Dv = [6, 0, 0];
  const t0 = Date.now();
  const S = PL.prepare(soup, grab, [], {});
  ok(S.ok && S.mode === 'section', 'prepare: densified first, wall vertices paired through the wall', D.say(S.densify) + '; ' + S.partnered + ' of ' + S.zone.length + ' vertices have a partner; ' + (Date.now() - t0) + ' ms');
  PL.displace(S, Dv);
  const gv = S.grab.v, moved = dist(vpos(S.pos, gv), vpos(S.basePos, gv));
  ok(Math.abs(moved - 6) < 1e-6, 'the lip moved 6 mm at the grab', f3(moved) + ' mm');
  ok(dist(S.grab.c, grab.c) < 0.5 + 1.0, 'the grab snapped to a vertex (centred on the wall\'s mid-point if it is on a wall) near where it was put', f3(dist(S.grab.c, grab.c)) + ' mm');
  /* A wall moves as ONE SECTION: each vertex on the wall moves by 6 mm x
     bell(distance from the wall's MID-SURFACE), not from itself, so the two
     skins at any point move together. The mid-surface of this tube is r = 9.2. */
  let worst = 0, nWall = 0, beyond = 0, beyondMoved = 0;
  for (let v = 0; v < S.mesh.vertCount; v++) {
    const b = vpos(S.basePos, v), rad = Math.hypot(b[0], b[1]);
    if (b[2] > 55 || rad < 8.3 || rad > 10.1) continue;
    const mid = [b[0] * 9.2 / rad, b[1] * 9.2 / rad, b[2]];
    const disp = dist(vpos(S.pos, v), b), want = 6 * PL.bell(dist(mid, S.grab.c), R);
    worst = Math.max(worst, Math.abs(disp - want)); nWall++;
    if (dist(mid, S.grab.c) >= R + 0.01) { beyond++; if (disp !== 0) beyondMoved++; }
  }
  ok(nWall > 10000 && worst < 0.01, 'every wall vertex moves by 6 mm x bell(distance from the wall\'s mid-surface)', 'worst error ' + worst.toExponential(2) + ' mm over ' + nWall + ' vertices');
  ok(beyond > 0 && beyondMoved === 0, '0 mm at the radius and beyond', beyond + ' wall vertices past 50 mm from the mid-surface, none moved');
  const res = PL.finish(S, Dv, { repair: REPAIR });
  ok(res.ok, 'the guards pass', res.reason || ('thinnest ' + f3(res.report.wall.thinnest) + ' mm, ' + res.report.wall.stations + ' stations, self-intersections ' +
     res.report.pierce.before + ' -> ' + res.report.pierce.after));
  const wr = wallRange(S, res.tris, 59.4);
  ok(wr.n > 1000 && wr.lo >= 1.55 && wr.hi <= 1.65, 'wall 1.6 +- 0.05 across the moved region', f3(wr.lo) + ' .. ' + f3(wr.hi) + ' mm at ' + wr.n + ' stations');
  const tp = topology(res.tris);
  ok(tp.open === 0 && tp.nm === 0 && tp.wind === 0 && tp.degen === 0, 'manifold: closed, 2-manifold, wound, nothing degenerate');
  const mv = canonical(res.tris, 'tube-r50');
  ok(mv.verdict === 'PASS', 'mesh_validate.py --gate PASS', mv.triangles + ' triangles; open ' + mv.open_edges + ', non-manifold ' + mv.nonmanifold_edges +
     ', degenerate ' + mv.degenerate_tris + ', piercing ' + (mv.self_intersection && mv.self_intersection.pierce));
  // original vertices that were out of reach are untouched
  const have = new Set();
  for (let i = 0; i < res.tris.length; i += 3) have.add(res.tris[i] + ',' + res.tris[i + 1] + ',' + res.tris[i + 2]);
  let far = 0, farKept = 0;
  for (let i = 0; i < soup.length; i += 3) {
    if (dist([soup[i], soup[i + 1], soup[i + 2]], S.grab.c) >= R + 1) { far++; if (have.has(soup[i] + ',' + soup[i + 1] + ',' + soup[i + 2])) farKept++; }
  }
  ok(far > 0 && far === farKept, 'the tube\'s far end is bit-for-bit where it was', farKept + ' of ' + far + ' vertices');

  /* THE SECTION RULE REMOVES THE SHEAR BETWEEN THE SKINS AND NOT THE TILT. The
     two skins now move by the same vector, so the wall never gets THICKER (the
     old rule reached 1.87 on the far side of the tube). But a section carried
     sideways across a slope is thinner measured square to its new surface, by
     cos(slope): at a small radius the slope is steep. Asserted against that
     bound, not against 1.6 +- 0.05, which only the large radius meets. */
  console.log('        radius -> thinnest .. thickest wall, and the cos(slope) bound (slope <= 1.5 x 6 / r)');
  for (const r of [12, 25, 50]) {
    const q = r === 50 ? { S, tris: res.tris } : (() => { const Sq = PL.prepare(soup, { c: [9.2, 0, 60], r }, [], {}); PL.displace(Sq, Dv); return { S: Sq, tris: D.toSoup(Sq.mesh, Sq.pos) }; })();
    const w = r === 50 ? wr : wallRange(q.S, q.tris, 59.4);
    const bound = 1.6 / Math.sqrt(1 + Math.pow(1.5 * 6 / r, 2));
    ok(w.hi <= 1.65 && w.lo >= bound - 0.05, 'r = ' + r + ' mm: never thicker than 1.65, no thinner than the slope bound less 0.05',
       f3(w.lo) + ' .. ' + f3(w.hi) + ' mm; bound ' + f3(bound));
  }
  // the old rule is still there, one switch away: a plain displacement of every vertex by its own distance
  const plain = PL.prepare(soup, { c: [9.2, 0, 60], r: 12 }, [], { section: false });
  PL.displace(plain, Dv);
  let pw = 0;
  for (let v = 0; v < plain.mesh.vertCount; v++) {
    const d = dist(vpos(plain.basePos, v), plain.grab.c);
    pw = Math.max(pw, Math.abs(dist(vpos(plain.pos, v), vpos(plain.basePos, v)) - 6 * PL.bell(d, 12)));
  }
  ok(plain.mode === 'space' && pw < 1e-9, 'section: false is the plain rule - every vertex by 6 mm x bell(its own distance)', 'worst error ' + pw.toExponential(2));
}

/* ================================================================ 4. PINS */
console.log('\n=== 4. pin one side of the lip, pull the other ===');
{
  const soup = tube(10, 1.6, 60);
  const pinAt = [9.2, 0, 60], grabAt = [-9.2, 0, 60], Dv = [-6, 0, 0], R = 30;
  const free = PL.prepare(soup, { c: grabAt, r: R }, [], {});
  PL.displace(free, Dv);
  const S = PL.prepare(soup, { c: grabAt, r: R }, [{ c: pinAt, r: R }], {});
  ok(S.ok && S.pins[0].v >= 0, 'the pin snapped to a vertex', f3(dist(S.pins[0].c, pinAt)) + ' mm away');
  PL.displace(S, Dv);
  const pv = S.pins[0].v;
  const pinMoved = dist(vpos(S.pos, pv), vpos(S.basePos, pv));
  ok(pinMoved <= 0.02, 'the pinned side is within 0.02 mm of its start', f3(pinMoved) + ' mm');
  let near = 0, nearWorst = 0;
  for (let v = 0; v < S.mesh.vertCount; v++) {
    if (dist(vpos(S.basePos, v), S.pins[0].c) > 1.0) continue;
    near++; nearWorst = Math.max(nearWorst, dist(vpos(S.pos, v), vpos(S.basePos, v)));
  }
  ok(near > 10 && nearWorst <= 0.02, 'and so is everything within 1 mm of it', near + ' vertices, worst ' + f3(nearWorst) + ' mm');
  // without the pin the same spot would have gone a long way
  let unpinned = 0;
  { const fv = free; let best = Infinity, bi = -1;
    for (let v = 0; v < fv.mesh.vertCount; v++) { const d = dist(vpos(fv.basePos, v), S.pins[0].c); if (d < best) { best = d; bi = v; } }
    unpinned = dist(vpos(fv.pos, bi), vpos(fv.basePos, bi)); }
  ok(unpinned > 1, 'without the pin that spot would have moved', f3(unpinned) + ' mm');
  const gm = dist(vpos(S.pos, S.grab.v), vpos(S.basePos, S.grab.v));
  ok(Math.abs(gm - 6) < 1e-6, 'the grab still moves the full 6 mm with the pin on the other side', f3(gm) + ' mm');
  const res = PL.finish(S, Dv, { repair: REPAIR });
  ok(res.ok, 'the guards pass', res.reason || '');
  const mv = canonical(res.tris, 'tube-pin');
  ok(mv.verdict === 'PASS', 'mesh_validate.py --gate PASS', mv.triangles + ' triangles');
}

/* ============================================================ 5. COARSE BOX */
console.log('\n=== 5. a coarse box (12 triangles) - densified under the grab, a smooth bump ===');
{
  const box = STOCK.boxSoup(20, 20, 20);
  const Dv = [0, 0, 3], R = 12;
  const r = PL.pull(box, { grab: { c: [0, 0, 20], r: R }, D: Dv }, { repair: REPAIR });
  ok(r.ok, 'the pull is accepted', r.reason || '');
  const S = r.S;
  ok(r.report.trisBefore === 12 && r.report.trisAfter > 5000, 'densified under the grab', r.report.trisBefore + ' -> ' + r.report.trisAfter + ' triangles; ' + D.say(S.densify));
  // the bump is exactly 3 mm x bell(distance) on the top face
  let worst = 0, n = 0, h1 = null;
  for (let v = 0; v < S.mesh.vertCount; v++) {
    const b = vpos(S.basePos, v);
    if (b[2] !== 20) continue;
    const d = dist(b, S.grab.c);
    if (d >= R) continue;
    n++;
    worst = Math.max(worst, Math.abs((S.pos[v * 3 + 2] - 20) - 3 * PL.bell(d, R)));
    if (d > 0.9 && d < 1.1 && h1 === null) h1 = S.pos[v * 3 + 2] - 20;
  }
  ok(n > 1000 && worst < 1e-9, 'the top is lifted by 3 mm x bell(distance) at every vertex', n + ' vertices, worst error ' + worst.toExponential(2));
  ok(h1 !== null && h1 > 2.9, 'flat at the top of the bump - 1 mm from the centre it is still within 0.1 mm of the peak',
     f3(h1) + ' mm (a pyramid with a kink would read ' + f3(3 * (1 - 1 / 12)) + ')');
  // no crease: the dihedral between neighbouring triangles stays small across the bump
  const m = S.mesh, nrm = [];
  for (let t = 0; t < m.triCount; t++) {
    const a = vpos(S.pos, m.tri[t * 3]), b = vpos(S.pos, m.tri[t * 3 + 1]), c = vpos(S.pos, m.tri[t * 3 + 2]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cr = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const L = Math.hypot(cr[0], cr[1], cr[2]) || 1;
    nrm.push([cr[0] / L, cr[1] / L, cr[2] / L]);
  }
  const edge = new Map(), onTop = t => [0, 1, 2].every(k => S.basePos[m.tri[t * 3 + k] * 3 + 2] === 20);
  let worstDihedral = 0, pairs = 0;
  for (let t = 0; t < m.triCount; t++) {
    if (!onTop(t)) continue;
    for (let e = 0; e < 3; e++) {
      const u = m.tri[t * 3 + e], v = m.tri[t * 3 + (e + 1) % 3], k = u < v ? u + '_' + v : v + '_' + u;
      const o = edge.get(k);
      if (o === undefined) edge.set(k, t);
      else {                                   // both triangles lie on the box's top face
        const dot = nrm[t][0] * nrm[o][0] + nrm[t][1] * nrm[o][1] + nrm[t][2] * nrm[o][2];
        worstDihedral = Math.max(worstDihedral, Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI);
        pairs++;
      }
    }
  }
  ok(worstDihedral < 12, 'no crease: the largest angle between neighbouring triangles across the bump is small', f3(worstDihedral) + ' degrees over ' + pairs + ' neighbouring pairs on the top face');
  const tp = topology(r.tris);
  ok(tp.open === 0 && tp.nm === 0 && tp.wind === 0 && tp.degen === 0, 'manifold: closed, 2-manifold, wound, nothing degenerate');
  ok(tp.vol > topology(box).vol, 'the box gained volume', f3(topology(box).vol) + ' -> ' + f3(tp.vol));
  const mv = canonical(r.tris, 'box-bump');
  ok(mv.verdict === 'PASS', 'mesh_validate.py --gate PASS', mv.triangles + ' triangles');
}

/* ================================================================ 6. GUARDS */
console.log('\n=== 6. guards - the words, and the piece unchanged ===');
{
  const thin = tube(10, 0.8, 60);
  const r = PL.pull(thin, { grab: { c: [9.6, 0, 60], r: 12 }, D: [2, 0, 0] }, { repair: REPAIR });
  ok(!r.ok, 'a 0.8 mm wall pulled 2 mm is refused');
  ok(/of wall/.test(r.reason) && /under the 0\.8 mm floor \(two 0\.4 mm nozzle widths\)/.test(r.reason), 'and says why, in words', r.reason);
  ok(r.tris === thin, 'the piece is returned unchanged (the very same soup)');
  const thick = PL.pull(tube(10, 1.6, 60), { grab: { c: [9.2, 0, 60], r: 12 }, D: [2, 0, 0] }, { repair: REPAIR });
  ok(thick.ok, 'the same 2 mm pull of a 1.6 mm wall is fine - the guard is not refusing everything', 'thinnest ' + f3(thick.report.wall.thinnest) + ' mm');
}
{
  // a plate pulled down through itself: the self-intersection guard, on its own
  const plate = STOCK.boxSoup(40, 40, 3);
  const S = PL.prepare(plate, { c: [0, 0, 3], r: 4 }, [], { section: false });   // the plain rule: a section would carry both skins down together
  const Dv = [0, 0, -6];
  PL.displace(S, Dv);
  const g = PL.pierceGuard(S, Dv, { repair: REPAIR });
  ok(!g.ok && g.after > g.before, 'pulling the top of a 3 mm plate down 6 mm through its own bottom is a self-intersection',
     g.reason || (g.before + ' -> ' + g.after));
  const full = PL.finish(S, Dv, { repair: REPAIR });
  ok(!full.ok && full.tris === S.origTris, 'and the whole pull is refused with the piece returned', full.reason);
  const noChecker = PL.pierceGuard(S, Dv, { repair: { } });
  ok(!noChecker.ok && /not loaded/.test(noChecker.reason), 'a missing checker is a refusal, not a skip');
}
{
  const r = PL.pull(STOCK.boxSoup(20, 20, 20), { grab: { c: [0, 0, 20], r: 8 }, D: [0, 0, 0] }, { repair: REPAIR });
  ok(r.ok && r.noop, 'a grab that did not move is a no-op, not a commit');
}

/* ============================================================= 7. THIS SIDE ONLY */
console.log('\n=== 7. "This side only" - the bore of the tube pushed 0.4 mm inward ===');
{
  const soup = tube(10, 1.6, 60);
  const bore = [8.4, 0, 52], Dv = [-0.4, 0, 0];             // toward the axis: the wall gets thicker. 8 mm under the lip, so the 12 mm radius reaches the rim and must not get over it
  const t0 = Date.now();
  const S = PL.prepare(soup, { c: bore, r: 12 }, [], { sideOnly: true });
  ok(S.ok && S.mode === 'side', 'prepare in side-only mode', D.say(S.densify) + '; ' + (Date.now() - t0) + ' ms');
  PL.displace(S, Dv);
  let outer = 0, outerWorst = 0, inner = 0, rimWorst = 0;
  for (const v of S.moved) {
    const rad = Math.hypot(S.basePos[v * 3], S.basePos[v * 3 + 1]);
    const d = dist(vpos(S.pos, v), vpos(S.basePos, v));
    if (rad > 9.9) { outer++; outerWorst = Math.max(outerWorst, d); } else if (rad < 8.5) inner++;
  }
  ok(inner > 1000, 'the skin under the grab moved', inner + ' bore vertices');
  ok(outer === 0 && outerWorst <= 0.01, 'the outer surface is unchanged within 0.01 mm', outer + ' outer vertices moved, worst ' + outerWorst.toExponential(1) + ' mm');
  // and that is true of the whole soup, not just the vertices that were asked about
  const res = PL.finish(S, Dv, { repair: REPAIR });
  ok(res.ok, 'the guards pass', res.reason || '');
  let outerSoup = 0;
  const base = D.region(soup, { c: bore, r: 12 }, {}).soup, key = new Set();
  for (let i = 0; i < base.length; i += 3) if (Math.hypot(base[i], base[i + 1]) > 9.9) key.add(base[i] + ',' + base[i + 1] + ',' + base[i + 2]);
  const after = new Set();
  for (let i = 0; i < res.tris.length; i += 3) if (Math.hypot(res.tris[i], res.tris[i + 1]) > 9.9) after.add(res.tris[i] + ',' + res.tris[i + 1] + ',' + res.tris[i + 2]);
  key.forEach(k => { if (!after.has(k)) outerSoup++; });
  ok(key.size > 1000 && outerSoup === 0, 'every vertex of the outer skin is bit-for-bit where it was', key.size + ' outer vertices, ' + outerSoup + ' changed');
  const P = TH.prepare(res.tris, {});
  const gv = S.grab.v, w = P.wallAt(vpos(S.pos, gv), { normal: [-1, 0, 0], probe: 3 });
  ok(w.measured && Math.abs(w.mm - 2.0) <= 0.05, 'wall 2.0 +- 0.05 at the grab', f3(w.mm) + ' mm (1.6 + 0.4)');
  ok(Math.abs(dist(vpos(S.pos, gv), vpos(S.basePos, gv)) - 0.4) < 1e-9, 'the grab moved the full 0.4 mm');
  const mv = canonical(res.tris, 'bore-side');
  ok(mv.verdict === 'PASS', 'mesh_validate.py --gate PASS', mv.triangles + ' triangles');
  // the same push with the toggle off carries the outside with it - that is what the toggle is for
  const both = PL.prepare(soup, { c: bore, r: 12 }, [], {});
  PL.displace(both, Dv);
  let outerBoth = 0;
  for (const v of both.moved) if (Math.hypot(both.basePos[v * 3], both.basePos[v * 3 + 1]) > 9.9) outerBoth = Math.max(outerBoth, dist(vpos(both.pos, v), vpos(both.basePos, v)));
  ok(outerBoth > 0.3, 'with the toggle off the same push moves the outer skin too (the wall as one section)', f3(outerBoth) + ' mm');
  // the 0.8 mm guard still applies: a 0.8 wall pushed 0.4 mm toward the axis is fine, pulled into the wall 0.4 mm it is not
  const thin = tube(10, 0.8, 60);
  const intoSide = (() => { const St = PL.prepare(thin, { c: [10, 0, 40], r: 12 }, [], { sideOnly: true }); PL.displace(St, [-0.5, 0, 0]); return PL.finish(St, [-0.5, 0, 0], { repair: REPAIR }); })();
  ok(!intoSide.ok && /under the 0\.8 mm floor/.test(intoSide.reason), 'the 0.8 mm guard still applies: the OUTSIDE of a 0.8 wall pushed 0.5 mm into it is refused', intoSide.reason);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('FAILED:\n  ' + FAILS.join('\n  ')); process.exit(1); }
