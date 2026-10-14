#!/usr/bin/env node
// HISTORICAL. This probe measured the trunk-first planner (plan.trunk,
// plan.branches), which nso_support_gridpack.js replaced - see
// docs/SUPPORT-GRIDPACK.md. It no longer runs against the shipped planTree;
// it is kept as the record behind docs/CURVED-BRANCH.md.
// Curved support branches - a headless PROBE for docs/CURVED-BRANCH.md.
//
//   node tools/nso_curved_branch_probe.js     print every measurement (~2.5 min)
//
// Writes the solids it validates to tools/curved-branch-out/ (git-ignored) and
// runs tools/mesh_validate.py on them.
//
// NOT A TEST and NOT in `npm test`. It gates nothing and changes nothing: it
// loads the shipped files with vm, in index.html's order (the way
// tools/nso_support_tree_test.js does), plans trees the way G-scope's
// planFor() plans them, and measures what a curved branch would have to get
// past. The one search it runs - a single-waypoint detour - lives HERE, in a
// tool, on purpose: it is the "smallest first slice" the report proposes,
// written just far enough to put numbers on it, and nothing in the app calls
// it.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools', 'curved-branch-out');
const { readSTL, writeSTL } = require('./nso_stl_io.js');
const { csgContext } = require('./nso_csg_node.js');

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_seat_surface.js', 'app-sculpt.js',
                 'app-extend.js', 'nso_support_aim.js', 'nso_path_sweep.js',
                 'nso_support_tree.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const SA = ctx.NSO_SupportAim, ST = ctx.NSO_SupportTree, PS = ctx.NSO_PathSweep, TH = ctx.NSO_Thickness;

/* ---- vectors ------------------------------------------------------------- */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = a => Math.hypot(a[0], a[1], a[2]);
const unit = a => mul(a, 1 / len(a));
const tiltOf = d => Math.atan2(Math.hypot(d[0], d[1]), d[2]) * 180 / Math.PI;
const f3 = (x, n = 3) => (x == null ? '-' : (+x).toFixed(n));
const ms = t0 => (Number(process.hrtime.bigint() - t0) / 1e6);
const now = () => process.hrtime.bigint();

/* ---- fixtures: the tree suite's own four, plus two built for this ------- */
function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = [];
  for (const t of f) for (const i of t) out.push(...v[i]);
  return out;
}
const soupOf = (...parts) => new Float32Array([].concat(...parts));

/* An arm whose UNDERSIDE is tessellated into `cell` mm squares, with the
   squares under `holes` left out (that is where something hangs from it).
   detectOverhangs flags a triangle by a ray from its centroid, so one big
   underside triangle half over a boss would be flagged - or not - whole, and
   contacts would land on the boss's own top. A grid keeps the region honest.
   Only the underside matters to detection and to the rays; the soup is not
   claimed to be a closed solid. */
function arm(x0, x1, y0, y1, z0, z1, cell, holes) {
  const out = [];
  const inHole = (x, y) => holes.some(h => x >= h[0] - 1e-9 && x + cell <= h[1] + 1e-9 &&
                                           y >= h[2] - 1e-9 && y + cell <= h[3] + 1e-9);
  for (let x = x0; x < x1 - 1e-9; x += cell) {
    for (let y = y0; y < y1 - 1e-9; y += cell) {
      if (inHole(x, y)) continue;
      const a = [x, y, z0], b = [x + cell, y, z0], c = [x + cell, y + cell, z0], d = [x, y + cell, z0];
      out.push(...a, ...c, ...b, ...a, ...d, ...c);            /* facing down */
    }
  }
  const top = box([x0, y0, z0], [x1, y1, z1]);
  return out.concat(top.slice(6 * 9));                        /* the box minus its bottom */
}

const FIX = {
  /* tools/nso_support_tree_test.js, verbatim */
  shelf: soupOf(box([0, 0, 0], [10, 10, 20]), box([10, 0, 16], [22, 10, 20])),
  tall:  soupOf(box([0, 0, 0], [10, 10, 26]), box([10, 0, 22], [30, 10, 26])),
  tab:   soupOf(box([0, 0, 0], [10, 10, 16]), box([10, 1, 12], [18, 9, 16])),
  tiny:  soupOf(box([0, 0, 0], [10, 10, 16]), box([10, 4, 12], [12, 6, 16])),
  /* NEW. The tall arm with a 3 x 3 mm boss hanging 5 mm under it, off the
     fan's centre line. Material below an overhang is the commonest obstacle
     there is - a rib, a boss, a clip - and a branch that has to pass it is
     refused today. */
  boss:  soupOf(box([0, 0, 0], [10, 10, 26]), arm(10, 30, 0, 10, 22, 26, 1, [[22, 25, 6, 9]]),
                box([22, 6, 17], [25, 9, 22])),
  /* NEW. A 12 x 12 mm cap on a 4 x 4 mm stem (a mushroom, a T-handle, a
     peg): the overhang is a ring round the stem, so the centroid of its
     contacts - where the trunk is aimed - is inside the stem. */
  mushroom: soupOf(box([4, 4, 0], [8, 8, 20]), arm(0, 12, 0, 12, 20, 24, 1, [[4, 8, 4, 8]]))
};
const TAPE = 'fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl';

/* G-scope's planFor(): the soup and the detection options, regionId, the
   style. section is left at the module default ('round'), as G-scope does. */
function plan(host, extra) {
  return ST.planTree(host, Object.assign({ skipList: [] }, extra || {}));
}

function head(t) { console.log('\n=== ' + t + ' ==='); }

/* =========================================================================
   A. TODAY: what a straight branch is refused for, fixture by fixture
   ========================================================================= */
head('A. today - planTree as G-scope calls it (round, square tips)');
const PLANS = {};
for (const name of Object.keys(FIX)) {
  const t0 = now();
  const p = plan(FIX[name]);
  const dt = ms(t0);
  PLANS[name] = p;
  const contacts = p.contacts ? p.contacts.points.length : 0;
  const held = p.ok ? p.branches.length + ((p.single || p.trunkCarriesContact >= 0) ? 1 : 0) : 0;
  console.log(`${name.padEnd(6)} ok=${p.ok} stage=${p.stage} contacts=${contacts} held=${held} ` +
    `refused=${(p.blocked || []).length} fallback=${(p.sectionFallback || []).length} ${dt.toFixed(0)} ms`);
  if (!p.ok) console.log('       reason: ' + p.reason.slice(0, 260));
  for (const b of (p.blocked || []).slice(0, 3)) console.log(`       contact ${b.index}: ${b.why}`);
}
{
  const tape = readSTL(path.join(ROOT, TAPE));
  const det = SA.detectOverhangs(tape, { skipList: [] });
  console.log(`tape   ${(tape.length / 9) | 0} tris, ${det.regions.length} region(s)`);
  for (let r = 0; r < det.regions.length; r++) {
    const t0 = now();
    const p = plan(tape, { regionId: r });
    const dt = ms(t0);
    const contacts = p.contacts ? p.contacts.points.length : 0;
    console.log(`  region ${r}: ${det.regions[r].areaMm2.toFixed(1)} mm2, ok=${p.ok} stage=${p.stage} ` +
      `contacts=${contacts} branches=${p.ok ? p.branches.length : 0} refused=${(p.blocked || []).length} ` +
      `${dt.toFixed(0)} ms` + (p.ok ? '' : ' - ' + p.reason.slice(0, 200)));
    for (const b of (p.blocked || []).slice(0, 2)) console.log(`       contact ${b.index}: ${b.why}`);
  }
}


/* =========================================================================
   B. THE BEND RADIUS A SECTION ALLOWS - NSO_PathSweep's F6, per section
   ========================================================================= */
head('B. minimum bend radius per section (60 deg corner, 8 chords, 20 mm legs)');
/* The same 24-gon nso_support_tree.js sweeps: the AREA of a circle of d. */
function roundProfile(d, n = 24) {
  const R = (d / 2) * Math.sqrt((2 * Math.PI / n) / Math.sin(2 * Math.PI / n));
  const pr = [];
  for (let k = 0; k < n; k++) { const a = 2 * Math.PI * k / n; pr.push([R * Math.cos(a), R * Math.sin(a)]); }
  return { profile: pr, circumMm: R, apothemMm: R * Math.cos(Math.PI / n) };
}
const squareProfile = s => [[-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2]];
const LAW_PER_MM = 2 * Math.tan(5 * Math.PI / 180);
const lawD = (z, zTip) => 2 + LAW_PER_MM * Math.max(0, zTip - z);
function buildsAt(profile, R, turnDeg, n) {
  const t = turnDeg * Math.PI / 180;
  const P = [[0, 0, 0], [0, 0, 20], [20 * Math.sin(t), 0, 20 + 20 * Math.cos(t)]];
  const a = PS.arcSubdivide(P, { radius: R, segments: n });
  if (!a.ok) return false;
  return PS.sweep({ points: a.pts, profile }).ok;
}
function minRadius(profile, turnDeg, n) {
  let lo = 0.01, hi = 10;
  if (!buildsAt(profile, hi, turnDeg, n)) return null;
  for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (buildsAt(profile, m, turnDeg, n)) hi = m; else lo = m; }
  return hi;
}
const SECTIONS = [
  ['square 1.2 (planning side)', squareProfile(1.2), 0.6 * Math.SQRT2],
  ['square 0.42 (nozzle floor)', squareProfile(TH.floorFor(0.4)), TH.floorFor(0.4) / Math.SQRT2],
  ['round d 2.0 (tip)', roundProfile(2).profile, roundProfile(2).circumMm],
  ['round d 3.0', roundProfile(3).profile, roundProfile(3).circumMm],
  ['round d 4.1 (tiny trunk base)', roundProfile(4.1).profile, roundProfile(4.1).circumMm]
];
for (const [name, prof, rc] of SECTIONS) {
  const r8 = minRadius(prof, 60, 8), r1 = minRadius(prof, 60, 1), r16 = minRadius(prof, 60, 16);
  const pred8 = rc / Math.cos((60 * Math.PI / 180) / 16);
  console.log(`${name.padEnd(30)} circum ${f3(rc, 4)}  min R: 8 chords ${f3(r8, 4)} (R cos(t/2n) > r predicts ` +
    `${f3(pred8, 4)}), 16 chords ${f3(r16, 4)}, 1 chord ${r1 == null ? 'n/a' : f3(r1, 4)}`);
}
{
  /* And the one-line answer to "can a round, TAPERED branch bend today?" */
  const rp = roundProfile(3);
  const sw = PS.sweep({ points: [[0, 0, 0], [0, 0, 10], [3, 0, 18]], profile: rp.profile, scales: [1, 2 / 3] });
  console.log('tapered 3-point sweep: ok=' + sw.ok + ' - ' + sw.reason);
}

/* =========================================================================
   C. THE SMALLEST SEARCH: one waypoint, one rounded corner, per refused
      contact. Constraints, in the order they are cheapest to test:
        1. both legs within BRANCH_TILT_DEG of vertical (the cone is convex,
           so no chord of the rounded corner leans further than its legs)
        2. the axis polyline clear of the piece (2 rays)
        3. the corner rounds at R >= the section's own floor, and sweeps
        4. every rail of every segment clear (the tree's own gate, per segment)
        5. clearance from the axis to the piece >= section radius
      Shortest survivor wins. Constant section at the law's ROOT diameter,
      never under the law (see the report, 3).
   ========================================================================= */
head('C. one-waypoint detour for every refused contact');
const EPS = 1e-3;
const triCount = s => (s.length / 9) | 0;
const TILT = 31.44;
function railsClear(obstacles, sw, capMm) {
  const R = sw.rings;
  let casts = 0;
  for (let k = 0; k + 1 < R.length; k++) {
    const last = (k + 2 === R.length);
    for (let j = 0; j < R[k].length; j++) {
      const v = sub(R[k + 1][j], R[k][j]), L = len(v);
      const run = last ? L - capMm : L;
      if (run <= 2 * EPS) continue;
      casts++;
      const hit = SA._nearestHit(obstacles, R[k][j], mul(v, 1 / L), EPS, run - EPS);
      if (hit > 0) return { ok: false, casts, why: `segment ${k} rail ${j} blocked ${hit.toFixed(3)} mm along` };
    }
  }
  return { ok: true, casts };
}
function axisClear(obstacles, pts) {
  for (let k = 0; k + 1 < pts.length; k++) {
    const v = sub(pts[k + 1], pts[k]), L = len(v);
    if (SA._nearestHit(obstacles, pts[k], mul(v, 1 / L), EPS, L - EPS) > 0) return false;
  }
  return true;
}
/* Body clearance for a ROUND part: distance from each axis sample to the
   piece, minus the section's circumradius THERE. Exact for a circle, and
   conservative by circum/apothem for the 24-gon. The last `capMm` before the
   contact is the cap's (it lands on the overhang by design), as in the tree. */
function bodyClearance(soup, pts, radiusAt, capMm, step) {
  let total = 0;
  for (let k = 0; k + 1 < pts.length; k++) total += len(sub(pts[k + 1], pts[k]));
  let best = Infinity, at = null, s0 = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const v = sub(pts[k + 1], pts[k]), L = len(v), n = Math.max(1, Math.ceil(L / step));
    for (let i = 0; i <= n; i++) {
      const s = s0 + L * i / n;
      if (s > total - capMm) break;
      const p = add(pts[k], mul(v, i / n));
      const c = closestOnSoupD(soup, p) - radiusAt(s, p);
      if (c < best) { best = c; at = s; }
    }
    s0 += L;
  }
  return { mm: best, atMm: at };
}
function closestOnSoupD(soup, p) {
  let best = Infinity;
  for (let o = 0; o < soup.length; o += 9) {
    const q = SA._closestOnTri(p, [soup[o], soup[o + 1], soup[o + 2]], [soup[o + 3], soup[o + 4], soup[o + 5]],
                                  [soup[o + 6], soup[o + 7], soup[o + 8]]);
    const d = len(sub(q, p));
    if (d < best) best = d;
  }
  return best;
}
/* The section a curved branch carries. Three ways to answer the question
   NSO_PathSweep forces (a taper is refused on any path with a joint):
     'root'   one sweep, constant at the law's diameter at the ROOT. Never under
              the law; the tip is as fat as the root.
     'tip'    one sweep, constant at the 2 mm TIP. The tip is right; the shaft
              is under the law all the way down.
     'chain'  the law kept exactly: every straight piece of the rounded path
              is its own two-point frustum (the taper NSO_PathSweep does allow),
              each sunk one diameter into the next, unioned like any part. */
function curvedParts(pts, zTip, variant) {
  const lens = [];
  for (let k = 0; k + 1 < pts.length; k++) lens.push(len(sub(pts[k + 1], pts[k])));
  if (variant === 'chain') {
    const parts = [];
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1], u = unit(sub(b, a));
      const ov = k ? Math.min(0.5 * lens[k - 1], lawD(a[2], zTip) / 2) : 0;
      const a2 = sub(a, mul(u, ov));
      const d0 = lawD(a2[2], zTip), d1 = lawD(b[2], zTip);
      const rp = roundProfile(d0);
      const sw = PS.sweep({ points: [a2, b], profile: rp.profile, scales: [1, d1 / d0] });
      if (!sw.ok) return { ok: false, reason: 'piece ' + k + ': ' + sw.reason };
      parts.push(sw);
    }
    return { ok: true, parts, radiusAt: (s, p) => roundProfile(lawD(p[2], zTip)).circumMm };
  }
  if (variant === 'hybrid') {
    /* pts is [root, A, arc chords..., B, contact] for one rounded corner */
    const A = pts[1], B = pts[pts.length - 2], r = pts[0], q = pts[pts.length - 1];
    const dA = lawD(A[2], zTip);
    const u1 = unit(sub(A, r)), u2 = unit(sub(q, B));
    const leg1 = PS.sweep({ points: [r, A], profile: roundProfile(lawD(r[2], zTip)).profile,
      scales: [1, dA / lawD(r[2], zTip)] });
    const arcPts = [sub(A, mul(u1, dA / 2))].concat(pts.slice(1, -1));
    const arc = PS.sweep({ points: arcPts, profile: roundProfile(dA).profile });
    const b2 = sub(B, mul(u2, dA / 2));
    const leg2 = PS.sweep({ points: [b2, q], profile: roundProfile(dA).profile, scales: [1, 2 / dA] });
    for (const [nm, sw] of [['leg 1', leg1], ['arc', arc], ['leg 2', leg2]]) {
      if (!sw.ok) return { ok: false, reason: nm + ': ' + sw.reason };
    }
    const sA = len(sub(A, r));
    let sB = sA;
    for (let k = 1; k + 2 < pts.length; k++) sB += len(sub(pts[k + 1], pts[k]));
    const L2 = len(sub(q, B));
    return { ok: true, parts: [leg1, arc, leg2], dArc: dA, radiusAt: (s, p) => roundProfile(
      s <= sA ? lawD(p[2], zTip) : s <= sB ? dA : dA + (2 - dA) * (s - sB) / L2).circumMm };
  }
  const d = variant === 'root' ? lawD(pts[0][2], zTip) : 2;
  const rp = roundProfile(d);
  const sw = PS.sweep({ points: pts, profile: rp.profile });
  if (!sw.ok) return { ok: false, reason: sw.reason };
  return { ok: true, parts: [sw], d, radiusAt: () => rp.circumMm };
}
/* The last 3 mm of a branch's axis, as a segment, and the exact distance
   between two segments (clamped closest points). */
function tail3(P) {
  const q = P[P.length - 1], u = unit(sub(P[P.length - 2], q));
  return [add(q, mul(u, 3)), q];
}
function segDist(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), c = dot(d1, r), b = dot(d1, d2);
  const den = a * e - b * b;
  let s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
  let t = (b * s + f) / e;
  if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
  else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
  return len(sub(add(p1, mul(d1, s)), add(p2, mul(d2, t))));
}
/* The air a curved branch keeps from the piece: 0.18 mm, the tree's own
   easy-release gap (nso_support_interface.js DEFAULTS.gapMm). */
const CLEAR_MM = 0.18;
function detour(p, host, i, variant, iso) {
  const q = p.contacts.points[i].p;
  const collar = p.branchRoot, tdir = p.trunk.dir, spread = p.rootSpreadMm;
  const hd = unit(sub(q, collar));
  const ac = sub(hd, mul(tdir, dot(hd, tdir)));
  const r = len(ac) > 1e-12 ? add(collar, mul(unit(ac), spread)) : collar;
  const obstacles = [host];
  const h = sub(q, r), hh = unit([h[0], h[1], 0]), lat = [-hh[1], hh[0], 0];
  const cands = [];
  for (const s of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    for (let a = -8; a <= 8 + 1e-9; a += 0.25) {
      for (const b of [-3, -2, -1, 0, 1, 2]) {
        const w = add(add(add(r, mul(h, s)), mul(lat, a)), [0, 0, b]);
        const t1 = tiltOf(sub(w, r)), t2 = tiltOf(sub(q, w));
        if (t1 > TILT || t2 > TILT) continue;
        if (w[2] <= r[2] || w[2] >= q[2]) continue;
        cands.push({ w, L: len(sub(w, r)) + len(sub(q, w)), t1, t2 });
      }
    }
  }
  cands.sort((x, y) => x.L - y.L);
  const fails = { axis: 0, corner: 0, sweep: 0, rails: 0, body: 0, iso: 0 };
  let tried = 0, casts = 0;
  const t0 = now();
  for (const c of cands) {
    tried++;
    casts += 2;
    if (!axisClear(obstacles, [r, c.w, q])) { fails.axis++; continue; }
    /* the corner at a radius the ROOT section can bend round, with margin */
    const rMin = roundProfile(lawD(r[2], q[2])).circumMm;
    let a = null, R = null;
    for (const k of [3, 2, 1.5, 1.15]) {
      const aa = PS.arcSubdivide([r, c.w, q], { radius: k * rMin, segments: 8 });
      if (aa.ok) { a = aa; R = k * rMin; break; }
    }
    if (!a) { fails.corner++; continue; }
    const cp = curvedParts(a.pts, q[2], variant);
    if (!cp.ok) { fails.sweep++; continue; }
    let railBad = false;
    for (let k = 0; k < cp.parts.length && !railBad; k++) {
      const rc = railsClear(obstacles, cp.parts[k], k === cp.parts.length - 1 ? 2 : 0);
      casts += rc.casts;
      if (!rc.ok) railBad = true;
    }
    if (railBad) { fails.rails++; continue; }
    const bc = bodyClearance(host, a.pts, cp.radiusAt, 2, 0.5);
    if (!(bc.mm >= CLEAR_MM)) { fails.body++; continue; }
    if (iso) {
      /* TIP ISOLATION: the last 3 mm of this branch stays a tip diameter plus
         the gap from the last 3 mm of every branch already standing. */
      const mine = tail3(a.pts);
      if (iso.some(t => segDist(mine[0], mine[1], t[0], t[1]) < 2 + CLEAR_MM)) { fails.iso++; continue; }
    }
    const turn = a.tangent.length ? a.tangent[0].turn * 180 / Math.PI : 0;
    return { ok: true, i, r, q, w: c.w, pts: a.pts, parts: cp.parts, d: cp.d, dArc: cp.dArc, R, turnDeg: turn,
      lengthMm: c.L, straightMm: len(h), tilts: [c.t1, c.t2], tried, casts, fails, clearMm: bc.mm,
      ms: ms(t0), tris: cp.parts.reduce((n, sw) => n + sw.tris.length / 9, 0),
      maxChordTilt: Math.max(...a.pts.slice(1).map((pt, k) => tiltOf(sub(pt, a.pts[k])))) };
  }
  return { ok: false, i, tried, casts, fails, candidates: cands.length, ms: ms(t0) };
}
const DETOURS = {};
for (const name of ['boss', 'mushroom']) {
  const p = PLANS[name];
  const host = FIX[name];
  console.log(`${name}: ${triCount(host)} tris in the piece`);
  const blocked = (p.blocked && p.blocked.length) ? p.blocked : [];
  DETOURS[name] = {};
  for (const variant of (name === 'mushroom' ? ['tip'] : ['root', 'tip', 'hybrid', 'chain', 'tip+iso'])) {
    const t0 = now();
    let list;
    if (variant === 'tip+iso') {
      /* contacts in order, each against today's straight tips AND the curved
         ones already accepted */
      const standing = p.branches.map(b => tail3([b.from, b.contact]));
      list = [];
      for (const b of blocked) {
        const x = detour(p, host, b.index, 'tip', standing);
        if (x.ok) standing.push(tail3(x.pts));
        list.push(x);
      }
    } else list = blocked.map(b => detour(p, host, b.index, variant));
    const dt = ms(t0);
    DETOURS[name][variant] = list;
    const ok = list.filter(x => x.ok);
    const F = { axis: 0, corner: 0, sweep: 0, rails: 0, body: 0, iso: 0 };
    list.forEach(x => Object.keys(F).forEach(k => { F[k] += x.fails[k]; }));
    console.log(`${name} [${variant}]: ${ok.length} of ${list.length} refused contact(s) recovered, ` +
      `${dt.toFixed(0)} ms; candidates rejected by axis ${F.axis}, corner ${F.corner}, sweep ${F.sweep}, ` +
      `rails ${F.rails}, body ${F.body}, tip isolation ${F.iso}`);
    if (name === 'mushroom') continue;   /* every one refused at the axis - see below */
    for (const x of list) {
      if (!x.ok) { console.log(`  contact ${x.i}: not recovered (${x.tried} candidates, ${x.casts} rays)`); continue; }
      console.log(`  contact ${x.i}: ${x.lengthMm.toFixed(2)} mm vs ${x.straightMm.toFixed(2)} straight ` +
        `(+${(100 * (x.lengthMm / x.straightMm - 1)).toFixed(1)}%), legs ${x.tilts.map(t => t.toFixed(1)).join('/')} deg ` +
        `(worst chord ${x.maxChordTilt.toFixed(2)}), turn ${x.turnDeg.toFixed(1)} deg at R ${x.R.toFixed(2)}, ` +
        `${x.d ? 'd ' + x.d.toFixed(2) : x.dArc ? 'law, arc at d ' + x.dArc.toFixed(2) : 'law'}, body clear by ${x.clearMm.toFixed(2)} mm, ` +
        `${x.parts.length} part(s) ${x.tris} tris, ${x.tried} candidates / ${x.casts} rays / ${x.ms.toFixed(0)} ms`);
    }
  }
}
{
  /* WHY the mushroom recovers nothing: its trunk is inside the stem. */
  const p = PLANS.mushroom, t = p.trunk;
  const mid = mul(add(t.from, t.tip), 0.5);
  const inStem = mid[0] > 4 && mid[0] < 8 && mid[1] > 4 && mid[1] < 8 && mid[2] > 0 && mid[2] < 20;
  console.log(`mushroom trunk: [${t.from.map(v => v.toFixed(2))}] -> [${t.tip.map(v => v.toFixed(2))}], ` +
    `its midpoint ${inStem ? 'IS' : 'is not'} inside the 4 x 4 stem; apex [${p.apex.map(v => v.toFixed(2))}]; ` +
    `nearestBase: ${p.base.reason}`);
}

/* =========================================================================
   D. WHAT THE UNION PAYS, and whether the result is still one clean solid
   ========================================================================= */
head('D. union cost and the canonical validator');
const csg = csgContext();
const validate = (file, weld) => JSON.parse(execFileSync('python3',
  [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'].concat(weld ? ['--weld', String(weld)] : []),
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
fs.mkdirSync(OUT, { recursive: true });
function vsum(r) {
  return `tris ${r.triangles}, open ${r.open_edges}, non-mf ${r.nonmanifold_edges}, ` +
    `wind ${r.inconsistent_winding_edges}, degen ${r.degenerate_tris}, slivers ${r.sliver_tris}, ` +
    `piercing ${r.self_intersection.pierce}, coplanar ${r.self_intersection.coplanar}, ` +
    `Euler ${r.euler_characteristic}, vol ${(+r.signed_volume).toFixed(2)}`;
}
async function unionTimed(parts) {
  const t0 = now();
  const u = await ST.unionParts(parts, { unionSoups: csg.NSO_unionSoups });
  return { u, ms: ms(t0) };
}
(async () => {
  const base = PLANS.boss;
  const b0 = await unionTimed(base.parts);
  const stepMs = b0.ms / Math.max(1, base.parts.length - 1);
  console.log(`boss as planned today: ${base.parts.length} parts, ${base.parts.reduce((n, s) => n + triCount(s), 0)} ` +
    `input tris -> ${b0.u.ok ? triCount(b0.u.soup) : 'FAILED'} tris, ${b0.ms.toFixed(0)} ms (${stepMs.toFixed(1)} ms/step)`);
  const rows = [['today', b0, base.parts.length]];
  for (const variant of ['tip', 'hybrid', 'chain']) {
    const rec = DETOURS.boss[variant].filter(x => x.ok);
    if (!rec.length) { console.log(`boss [${variant}]: nothing recovered, nothing to union`); continue; }
    const extra = [].concat(...rec.map(x => x.parts.map(sw => sw.tris)));
    const parts = base.parts.concat(extra);
    const r = await unionTimed(parts);
    console.log(`boss + ${rec.length} curved [${variant}]: ${parts.length} parts, ` +
      `${parts.reduce((n, s) => n + triCount(s), 0)} input tris -> ${r.u.ok ? triCount(r.u.soup) : 'FAILED: ' + r.u.reason} ` +
      `tris, ${r.ms.toFixed(0)} ms (${(r.ms / Math.max(1, parts.length - 1)).toFixed(1)} ms/step)`);
    rows.push([variant, r, parts.length]);
    /* one curved branch on its own, through the validator, before any union */
    const one = rec[0];
    if (one && one.parts.length === 1) {
      const f = path.join(OUT, `boss-curved-${variant}-branch.stl`);
      writeSTL(f, one.parts[0].tris);
      console.log(`  one curved branch alone: ${vsum(validate(f))}; ` +
        `profile area x rounded centreline ${(PS.polyArea(roundProfile(2).profile) *
          one.pts.slice(1).reduce((L, pt, k) => L + len(sub(pt, one.pts[k])), 0)).toFixed(2)} (CURVING-PATH F3)`);
    }
  }
  for (const [label, r] of rows) {
    if (!r.u.ok) continue;
    const f = path.join(OUT, `boss-union-${label}.stl`);
    writeSTL(f, r.u.soup);
    const def = validate(f);
    const fine = validate(f, 1e-6);
    console.log(`  union [${label}] default weld: ${vsum(def)}`);
    console.log(`  union [${label}] 1e-6 weld:    ${vsum(fine)}`);
  }

  /* ======================================================================
     E. TIPS: still isolated point contacts? and how proud does the cap sit?
     ====================================================================== */
  head('E. tips - isolation and cap overshoot');
  const n = base.region.normal;
  const straight = base.branches.map(b => b.tipPenetrationMm);
  console.log(`today's straight round branches: tip overshoot ${Math.min(...straight).toFixed(3)}..` +
    `${Math.max(...straight).toFixed(3)} mm, tilts ${base.tiltDeg.min.toFixed(1)}..${base.tiltDeg.max.toFixed(1)} deg`);
  /* segment-to-segment distance, sampled finely enough for this purpose */
  function polyDist(A, B, step) {
    const S = P => { const o = []; for (let k = 0; k + 1 < P.length; k++) {
      const v = sub(P[k + 1], P[k]), L = len(v), m = Math.max(1, Math.ceil(L / step));
      for (let i = 0; i <= m; i++) o.push(add(P[k], mul(v, i / m))); } return o; };
    const a = S(A), b = S(B);
    let best = Infinity;
    for (const p of a) for (const q of b) { const d = len(sub(p, q)); if (d < best) best = d; }
    return best;
  }
  {
    /* the baseline: today's straight tips against each other */
    const tl = b => [add(b.contact, mul(unit(sub(b.from, b.contact)), 3)), b.contact];
    let worst = Infinity;
    for (let a = 0; a < base.branches.length; a++) for (let c = a + 1; c < base.branches.length; c++) {
      worst = Math.min(worst, polyDist(tl(base.branches[a]), tl(base.branches[c]), 0.1));
    }
    console.log(`  today's straight tips: closest pair of last-3 mm axes ${worst.toFixed(2)} mm apart`);
  }
  for (const variant of ['tip', 'hybrid', 'chain']) {
    for (const x of DETOURS.boss[variant].filter(y => y.ok)) {
      let pen = 0;
      for (const sw of x.parts) for (let v = 0; v < sw.tris.length; v += 3) {
        const past = -((sw.tris[v] - x.q[0]) * n[0] + (sw.tris[v + 1] - x.q[1]) * n[1] + (sw.tris[v + 2] - x.q[2]) * n[2]);
        if (past > pen) pen = past;
      }
      /* the last 3 mm of this branch against the last 3 mm of every other */
      const tail = P => { const q = P[P.length - 1], u = unit(sub(P[P.length - 2], q)); return [add(q, mul(u, 3)), q]; };
      let nearest = Infinity, who = -1;
      for (const b of base.branches) {
        const d = polyDist(tail(x.pts), [add(b.contact, mul(unit(sub(b.from, b.contact)), 3)), b.contact], 0.1);
        if (d < nearest) { nearest = d; who = b.contactIndex; }
      }
      console.log(`  [${variant}] contact ${x.i}: last leg ${x.tilts[1].toFixed(1)} deg, tip overshoot ${pen.toFixed(3)} mm; ` +
        `its last 3 mm come within ${nearest.toFixed(2)} mm (axis to axis) of contact ${who}'s - ` +
        `${nearest > 2 ? 'apart' : 'FUSED'} at a 2 mm tip`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
