#!/usr/bin/env node
/* Lift 3 (lift off a curved base, repair to match) - headless.
   node tools/nso_lift_curved_test.js        exit 0 = every gate held

   READ docs/LIFT.md, section 6. Every fixture is generated here
   (tools/nso_lift_curved_fixtures.js, and Lift 2's) - never anyone's model:

     1. the spiky ball (the canonical case): 14 bumps on a 40 mm ball. Lift 2
        refuses every one; Lift 3 lifts each, the plate's repair welded to
        its neighbours (same corners, the slope carried across), on the
        sphere, curved like it, never a flat cap; plate + piece = source. Then
        all 14 one after another: the bare ball.
     2. a gently domed plate with dots, a 36 mm squiggle and a plaque: all
        lift together; Remove leaves nothing standing; the plaque's lift says
        in words what the fill cannot know.
     3. a cylinder with bumps and a ridge running round it.
     4. Lift 2's fixtures read with { curved: true }: the flat ones give
        exactly Lift 2's islands and plate, bit for bit; the dish squiggle,
        every bowl bar, noisy paper and layer steps all lift; the noisy ones
        say why the fill runs smooth.
     5. refusals in words: a bump seen too slantwise; what is not opted in.
     6. the canonical checker (tools/mesh_validate.py) on pieces and plates.

   THE RIM GATES, from the output soups alone. Each root edge is shared by a
   new plate triangle (the fill) and a kept one (the real neighbour): the
   weld, the same two corners bit for bit. Its angle is the one between the
   two triangles' normals. The surround's angles are those between each
   neighbour and its own other kept neighbours. No crease: the welds' median
   and 95th percentile within 1° of the surround's 95th percentile (a facet
   edge across the curve), their worst within 1° of its worst. A flat cap on
   any bump here fails all three (it meets the sphere at 5 - 9°). */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-lift-curved-'));
const { writeSTL } = require('./nso_stl_io.js');
const CF = require('./nso_lift_curved_fixtures.js');
const FX = require('./nso_lift_auto_fixtures.js');
const FX1 = require('./nso_lift_fixtures.js');
const L = require(path.join(ROOT, 'nso_lift.js'));
const LA = require(path.join(ROOT, 'nso_lift_auto.js'));
const LC = require(path.join(ROOT, 'nso_lift_curved.js'));

const ctx = { Math, Map, Set, console, Array, Object, Number, String, JSON, Float32Array, Float64Array,
  Int32Array, Uint8Array, Error, Infinity, NaN, isFinite };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext('var state = {}; var THREE = {};', ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-cut.js'), 'utf8'), ctx, { filename: 'app-cut.js' });
const DEPS = { rawFlatCapLoops: ctx.rawFlatCapLoops };
const CURVED = { curved: true };

let pass = 0, fail = 0;
const FAILS = [], REPORT = [];
function check(name, cond, detail) {
  if (cond) pass++; else { fail++; FAILS.push(name); }
  console.log('  ' + (cond ? 'ok    ' : 'FAIL  ') + name + (detail !== undefined ? '   ' + detail : ''));
}
function quiet(fn) {
  const save = console.log, lines = [];
  console.log = s => lines.push(s);
  let r;
  try { r = fn(); } finally { console.log = save; }
  const bad = lines.filter(s => /FAIL/.test(s));
  bad.forEach(s => console.log(s));
  return { r, lines: lines.length, bad: bad.length };
}
const f3 = x => Number(x).toFixed(3);
const f2 = x => Number(x).toFixed(2);
const f1 = x => Number(x).toFixed(1);

/* ---------------------------------------------------------------- helpers */

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function unit(a) { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; }
function triNormal(s, t) {
  const o = t * 9;
  const u = [s[o + 3] - s[o], s[o + 4] - s[o + 1], s[o + 5] - s[o + 2]];
  const v = [s[o + 6] - s[o], s[o + 7] - s[o + 1], s[o + 8] - s[o + 2]];
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
}
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * 180 / Math.PI;
function sameTri(a, ta, b, tb) { for (let q = 0; q < 9; q++) if (a[ta * 9 + q] !== b[tb * 9 + q]) return false; return true; }
function duplicates(s) {
  const seen = new Set();
  let d = 0;
  for (let t = 0; t < s.length / 9; t++) {
    const k = [0, 1, 2].map(k2 => s[t * 9 + k2 * 3] + ',' + s[t * 9 + k2 * 3 + 1] + ',' + s[t * 9 + k2 * 3 + 2]).sort().join('|');
    if (seen.has(k)) d++; else seen.add(k);
  }
  return d;
}
/* The triangle whose centroid is nearest p (3D), facing out (along `out`, if given). */
function triAt(s, p, out) {
  let b = -1, bd = Infinity;
  for (let t = 0; t < s.length / 9; t++) {
    const o = t * 9;
    const c = [(s[o] + s[o + 3] + s[o + 6]) / 3, (s[o + 1] + s[o + 4] + s[o + 7]) / 3, (s[o + 2] + s[o + 5] + s[o + 8]) / 3];
    const d = Math.hypot(c[0] - p[0], c[1] - p[1], c[2] - p[2]);
    if (d < bd && (!out || dot(triNormal(s, t), out) > 0)) { bd = d; b = t; }
  }
  return b;
}
/* A click on the surface beside a bump: off its centre by its radius + 1.5 mm,
   sideways, put back on the base surface by `onBase`. */
function besideBump(T, onBase) {
  const n = T.normal, side = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const s = unit([n[1] * side[2] - n[2] * side[1], n[2] * side[0] - n[0] * side[2], n[0] * side[1] - n[1] * side[0]]);
  const off = (T.radiusMm || 2) + 1.5;
  return onBase([T.center[0] + s[0] * off, T.center[1] + s[1] * off, T.center[2] + s[2] * off]);
}
function islandNear(A, c, r) {
  let best = null, bd = Infinity;
  A.islands.forEach(I => {
    const d = Math.hypot(I.center[0] - c[0], I.center[1] - c[1], c.length > 2 ? I.center[2] - c[2] : 0);
    if (d < bd) { bd = d; best = I; }
  });
  return bd < (r || 2) ? best : null;
}
let seq = 0;
function validate(soup, name) {
  const f = path.join(OUT, (name || 'p' + seq++) + '.stl');
  writeSTL(f, soup);
  const j = JSON.parse(execFileSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), f, '--json'], { maxBuffer: 64 << 20 }).toString());
  const si = j.self_intersection || {};
  j.summary = j.verdict + ' open ' + j.open_edges + ' nm ' + j.nonmanifold_edges + ' chi ' + j.euler_characteristic +
    ' pierce ' + si.pierce + ' coplanar ' + si.coplanar;
  j.clean = j.verdict === 'PASS' && si.pierce === 0 && si.coplanar === 0;
  return j;
}

/* The rim, from the plate alone: every new triangle's edge that a kept
   triangle shares (reversed) is a weld. Its angle, and how far that kept
   neighbour already bends against its other kept neighbours. */
function rimOf(plate, kept) {
  const key = (t, k) => { const o = t * 9 + k * 3; return plate[o] + ',' + plate[o + 1] + ',' + plate[o + 2]; };
  const E = new Map(), nt = plate.length / 9;
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) E.set(key(t, k) + '|' + key(t, (k + 1) % 3), t);
  const N = [];
  for (let t = 0; t < nt; t++) N.push(triNormal(plate, t));
  const own = u => {
    let m = 0;
    for (let k = 0; k < 3; k++) { const w = E.get(key(u, (k + 1) % 3) + '|' + key(u, k)); if (w != null && w < kept) m = Math.max(m, angle(N[u], N[w])); }
    return m;
  };
  const edges = [], surround = [];
  for (let t = kept; t < nt; t++) {
    for (let k = 0; k < 3; k++) {
      const u = E.get(key(t, (k + 1) % 3) + '|' + key(t, k));
      if (u == null || u >= kept) continue;
      edges.push({ rim: angle(N[t], N[u]), own: own(u) });
      for (let k2 = 0; k2 < 3; k2++) { const w = E.get(key(u, (k2 + 1) % 3) + '|' + key(u, k2)); if (w != null && w < kept) surround.push(angle(N[u], N[w])); }
    }
  }
  surround.sort((a, b) => a - b);
  const q = (a, f) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * f))] : 0;
  const rims = edges.map(e => e.rim).sort((a, b) => a - b);
  const R = { n: edges.length, max: rims[rims.length - 1] || 0, p50: q(rims, 0.5), p95: q(rims, 0.95),
    surroundP50: q(surround, 0.5), surroundP95: q(surround, 0.95), surroundMax: surround[surround.length - 1] || 0 };
  // no crease: the welds bend against the surface no more than the surface
  // bends against itself there. Typical and 95th-percentile welds against
  // the surround's 95th percentile (a facet edge across the curve: a
  // cylinder's quads along its axis are flat, so its median is 0), the
  // worst against its worst, each + 1°. A flat cap fails all three.
  R.smooth = R.p50 <= R.surroundP95 + 1 && R.p95 <= R.surroundP95 + 1 && R.max <= R.surroundMax + 1;
  R.noWorse = R.max <= R.surroundMax + 1;
  R.words = 'welds ' + f2(R.p50) + ' / ' + f2(R.p95) + ' / ' + f2(R.max) + '° (median / p95 / worst), the surface itself ' +
    f2(R.surroundP50) + ' / ' + f2(R.surroundP95) + ' / ' + f2(R.surroundMax) + '°';
  return R;
}

/* Least-squares quadratic w = a u^2 + b uv + c v^2 + d u + e v + f over points
   [u, v, w]; its Hessian [2a, b, 2c] and how far the points stand off the best
   PLANE through them. */
function quadFit(P) {
  const m = [], rhs = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 6; i++) m.push([0, 0, 0, 0, 0, 0]);
  let su = 0, sv = 0;
  P.forEach(p => { su += p[0]; sv += p[1]; });
  su /= P.length; sv /= P.length;
  P.forEach(p => {
    const u = p[0] - su, v = p[1] - sv, f = [u * u, u * v, v * v, u, v, 1];
    for (let a = 0; a < 6; a++) { rhs[a] += f[a] * p[2]; for (let b = 0; b < 6; b++) m[a][b] += f[a] * f[b]; }
  });
  const c = solve(m, rhs);
  // the plane: w = d u + e v + f by least squares
  const m3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r3 = [0, 0, 0];
  P.forEach(p => { const u = p[0] - su, v = p[1] - sv, f = [u, v, 1]; for (let a = 0; a < 3; a++) { r3[a] += f[a] * p[2]; for (let b = 0; b < 3; b++) m3[a][b] += f[a] * f[b]; } });
  const pl = solve(m3, r3);
  let flatOff = 0;
  P.forEach(p => { flatOff = Math.max(flatOff, Math.abs(p[2] - (pl[0] * (p[0] - su) + pl[1] * (p[1] - sv) + pl[2]))); });
  return { H: [2 * c[0], c[1], 2 * c[2]], flatOff };
}
function solve(A, b) {
  const n = b.length, m = A.map((r, i) => r.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) { if (r === c) continue; const f = m[r][c] / m[c][c]; for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k]; }
  }
  return m.map((r, i) => r[n] / r[i]);
}
const hNorm = H => Math.hypot(H[0], H[1] * Math.SQRT2, H[2]);

/* Every gate a curved lift of ONE island owes. `F` is the fixture: its true
   surface F.base(p) (signed, along the outward normal, ~ distance). */
function curvedLift(tag, src, A, I, F, opts) {
  opts = opts || {};
  const r = LA.lift(src, A, [I.id], DEPS);
  check(tag + ': lifts', r.ok, r.ok ? r.reason.slice(0, 140) : r.reason);
  if (!r.ok) return null;
  const pc = r.pieces[0], ps = pc.soup, pl = r.plate, c = L.census(ps), pcs = LA.census(pl);
  check(tag + ': read as a curved base, filled along it (not a flat cut)', I.fill === 'curved' && !!pc.fill, I.baseKind + ' base');
  check(tag + ': the piece is closed and manifold, no duplicate faces', c.closed && c.degen === 0 && duplicates(ps) === 0, c.tris + ' tris, chi ' + c.chi);
  check(tag + ': the plate stays closed and manifold', pcs.closed && pcs.degen === 0, pcs.tris + ' tris');
  let same = true;
  I.tris.forEach((t, i) => { if (!sameTri(ps, i, src, t)) same = false; });
  check(tag + ': the piece is the detail\'s own triangles, bit for bit, plus its back', same && c.tris === I.tris.length + pc.capTris);
  const drop = new Set(I.tris);
  let k = 0, unchanged = true;
  for (let t = 0; t < src.length / 9; t++) { if (drop.has(t)) continue; if (!sameTri(pl, k, src, t)) unchanged = false; k++; }
  check(tag + ': every other plate triangle is the source\'s, in order, bit for bit', unchanged && k === r.keptTris, k + ' kept');
  // the piece's back IS the plate's fill, turned over
  const nT = ps.length / 9, nP = pl.length / 9;
  let backSame = nP - k === pc.capTris;
  for (let i = 0; backSame && i < pc.capTris; i++) {
    const a = (nT - pc.capTris + i) * 9, b = (k + i) * 9;
    for (const [qa, qb] of [[0, 0], [3, 6], [6, 3]]) for (let q = 0; q < 3; q++) if (ps[a + qa + q] !== pl[b + qb + q]) backSame = false;
  }
  check(tag + ': the piece\'s back is the plate\'s fill turned over, corner for corner', backSame, pc.capTris + ' triangles');
  const resid = r.volumes.source - r.volumes.plate - r.volumes.pieces;
  check(tag + ': plate + piece = source', Math.abs(resid) < 1e-7 * Math.abs(r.volumes.source),
    f3(r.volumes.plate) + ' + ' + f3(r.volumes.pieces) + ' = ' + f3(r.volumes.source) + ' (residual ' + resid.toExponential(2) + ')');
  // the weld: every root edge shared with its real neighbour, the slope carried across
  const loopEdges = I.loops.reduce((s, Lp) => s + Lp.verts.length, 0), rim = rimOf(pl, k);
  check(tag + ': welded - every one of its ' + loopEdges + ' root edges is shared by the fill and the real neighbour (same corners, bit for bit)', rim.n === loopEdges, rim.n + ' welds');
  check(tag + ': the slope carries across the rim - the welds bend no more than the surface already bends round it (+1°)', rim.smooth, rim.words);
  // on the true surface, curved like it, never a flat cap
  const n = A.map.normal, e1 = A.map.grid.e1, e2 = A.map.grid.e2, P = [], Pt = [];
  let dev = 0, devIn = 0;
  const loopSet = new Set();
  I.loops.forEach(Lp => Lp.verts.forEach(v => loopSet.add(A.M.V[v].join(','))));
  for (let c3 = k * 9; c3 < pl.length; c3 += 3) {
    const p = [pl[c3], pl[c3 + 1], pl[c3 + 2]], d = F.base(p);
    dev = Math.max(dev, Math.abs(d));
    if (!loopSet.has(p.join(','))) devIn = Math.max(devIn, Math.abs(d));
    const u = dot(p, e1), v = dot(p, e2), w = dot(p, n);
    P.push([u, v, w]);
    // the true surface under (u, v), along the view
    let wt = w;
    for (let it = 0; it < 6; it++) { const q = [u * e1[0] + v * e2[0] + wt * n[0], u * e1[1] + v * e2[1] + wt * n[1], u * e1[2] + v * e2[2] + wt * n[2]]; wt -= F.base(q) / Math.max(0.2, dot(F.normalAt(q), n)); }
    Pt.push([u, v, wt]);
  }
  const qF = quadFit(P), qT = quadFit(Pt), dH = hNorm([qF.H[0] - qT.H[0], qF.H[1] - qT.H[1], qF.H[2] - qT.H[2]]);
  const tolDev = opts.devMm != null ? opts.devMm : 0.05;
  check(tag + ': the fill is on the true surface (within ' + f2(tolDev) + ' mm) - no step, no dent, no bulge', dev <= tolDev,
    f3(devIn) + ' mm inside, ' + f3(dev) + ' mm at worst (the rim corners are the real neighbours: what stays below the lift band)');
  check(tag + ': not a flat cap - the fill curves as the true surface does', qF.flatOff >= 0.5 * qT.flatOff,
    'off its best plane by ' + f3(qF.flatOff) + ' mm, the true surface ' + f3(qT.flatOff) + ' mm');
  check(tag + ': its curvature tracks the base (fitted Hessian within 15% of the true surface\'s)', dH <= 0.15 * hNorm(qT.H) + 1e-4,
    'fill ' + qF.H.map(x => x.toFixed(4)).join(' / ') + ', true ' + qT.H.map(x => x.toFixed(4)).join(' / ') + ' (1/mm)');
  return { r, rim, dev, devIn, qF, qT };
}
/* Remove: the plate closed, volumes, and a fresh read of it finds none of them. */
function removed(tag, src, A, ids, seed) {
  const r = LA.remove(src, A, ids, DEPS);
  check(tag + ': Remove ' + ids.length + ' - the plate is closed and manifold', r.ok && r.plateCensus.closed && r.plateCensus.degen === 0, r.reason && r.reason.slice(0, 160));
  if (!r.ok) return null;
  check(tag + ': ...no pieces are made, and plate + what went = the original', !r.pieces &&
    Math.abs(r.volumes.source - r.volumes.plate - r.volumes.removed) < 1e-7 * Math.abs(r.volumes.source),
    f3(r.volumes.plate) + ' + ' + f3(r.volumes.removed) + ' = ' + f3(r.volumes.source));
  return { r, A2: LA.analyse(r.plate, seed(r.plate), CURVED) };
}

/* ====================================================== 1. the spiky ball */

console.log('\n=== 1. the spiky ball: 14 bumps on a 40 mm ball (81,920 triangles) ===');
const SB = CF.sphere(), SBo = SB.soup, sbCopy = new Float32Array(SBo);
SB.normalAt = p => unit(p);
const onBall = p => { const r = Math.hypot(p[0], p[1], p[2]); return p.map(x => x * SB.R / r); };
check('fixture: closed and manifold', L.census(SBo).closed, L.census(SBo).tris + ' tris');
const seedFor = (soup, T, F, onBase) => { const p = besideBump(T, onBase); return triAt(soup, p, F.normalAt(p)); };
// Lift 2, as it is: every bump refused
{
  const T = SB.truth[0], A2 = LA.analyse(SBo, seedFor(SBo, T, SB, onBall)), I = islandNear(A2, T.center, 2);
  check('Lift 2 as it is (no curved option): the bump is found, and refused - its base bends', A2.ok && I && I.status === 'bends', I && I.reason);
}
const SPIKES = [], DOMES = [];
let sbOne = null, sbA = null, bareBall = null, domeAll = null;
let sphereTimes = [];
SB.truth.forEach((T, i) => {
  const seed = seedFor(SBo, T, SB, onBall), t0 = Date.now();
  const A = LA.analyse(SBo, seed, CURVED), ta = Date.now() - t0;
  const I = A.ok && islandNear(A, T.center, 2);
  const tag = 'ball ' + T.kind + ' ' + (i + 1);
  if (!I) { check(tag + ': found beside the click', false, A.ok ? A.islands.length + ' islands' : A.reason); return; }
  check(tag + ': found beside the click, liftable, ' + f2(I.heightMm) + ' mm high (the generator: ' + f2(T.heightMm) + ')',
    I.status === 'ok' && Math.abs(I.heightMm - T.heightMm) < 0.1, I.status + (I.reason ? ': ' + I.reason : ''));
  const t1 = Date.now();
  const q = quiet(() => curvedLift(tag, SBo, A, I, SB));
  const tl = Date.now() - t1;
  sphereTimes.push(ta + tl);
  if (!q.bad && q.r) console.log('  ok    ' + tag + ' lifts with every gate (' + q.lines + '): ' + q.r.rim.words + '; on the sphere within ' +
    f3(q.r.devIn) + ' mm inside, ' + f3(q.r.dev) + ' at the rim; ' + (ta + tl) + ' ms');
  (T.kind === 'spike' ? SPIKES : DOMES).push(q.r && !q.bad ? { rim: q.r.rim, dev: q.r.dev, devIn: q.r.devIn, fill: q.r.r.pieces[0].fill } : null);
  if (i === 0) { sbOne = q.r; sbA = A; }
});
const sumUp = L0 => L0.filter(Boolean);
REPORT.push('ball: 6 spikes - rim ' + sumUp(SPIKES).map(x => f2(x.rim.max)).join(' / ') + '° worst, fill on the sphere within ' +
  sumUp(SPIKES).map(x => f3(x.devIn)).join(' / ') + ' mm inside');
REPORT.push('ball: 8 domes - rim ' + sumUp(DOMES).map(x => f2(x.rim.max)).join(' / ') + '° worst (the surface round each: ' + sumUp(DOMES).map(x => f2(x.rim.surroundMax)).join(' / ') +
  '° worst), on the sphere within ' + sumUp(DOMES).map(x => f3(x.devIn)).join(' / ') + ' mm inside, ' + sumUp(DOMES).map(x => f3(x.dev)).join(' / ') + ' at the rim');
REPORT.push('ball: read + lift per bump ' + Math.min(...sphereTimes) + ' - ' + Math.max(...sphereTimes) + ' ms');
check('all 14 bumps lift, each on its own, with every gate', SPIKES.concat(DOMES).filter(Boolean).length === 14, SPIKES.concat(DOMES).filter(Boolean).length + ' of 14');
// Strip, one click: the bump there is offered; the ones round the curve say why not
if (sbA) {
  const slant = sbA.islands.filter(I => I.status === 'slant');
  check('one click reads the bump beside it; the ones round the ball are refused in words, never lifted at a bad angle',
    sbA.islands.filter(I => I.status === 'ok').length >= 1 && slant.length >= 5 && slant.every(I => /seen too slantwise .* click the face nearer it/.test(I.reason) && I.group === 'cant'),
    slant.length + ' too slantwise: "' + (slant[0] && slant[0].reason) + '"');
  check('...a slantwise one cannot be lifted, and Lift says so', (() => { const r = LA.lift(SBo, sbA, [slant[0].id], DEPS); return !r.ok && /seen too slantwise/.test(r.reason); })());
}
// one after another: the bare ball
{
  let cur = SBo, okAll = true, bad = '';
  const t0 = Date.now();
  SB.truth.forEach((T, i) => {
    if (!okAll) return;
    const A = LA.analyse(cur, seedFor(cur, T, SB, onBall), CURVED), I = A.ok && islandNear(A, T.center, 2);
    const r = I && I.status === 'ok' ? LA.lift(cur, A, [I.id], DEPS) : null;
    if (!r || !r.ok) { okAll = false; bad = 'bump ' + (i + 1) + ': ' + (r ? r.reason : I ? I.reason : 'not found'); return; }
    cur = r.plate;
  });
  const bare = CF.sphere({ bumps: false }).soup, vBare = L.volume(bare), vCur = L.volume(cur), cc = L.census(cur);
  let worst = 0;
  for (let c = 0; c < cur.length; c += 3) worst = Math.max(worst, Math.abs(Math.hypot(cur[c], cur[c + 1], cur[c + 2]) - SB.R));
  check('all 14 lifted one after another (each read on the plate the last left): the ball is closed and bare - every corner on the sphere',
    okAll && cc.closed && cc.degen === 0 && worst < 0.05, (okAll ? cc.tris + ' tris, ' : bad + '; ') + 'every corner within ' + f3(worst) + ' mm of r = 20 (' + (Date.now() - t0) + ' ms)');
  check('...its volume is the bare icosphere\'s', Math.abs(vCur - vBare) < 1e-4 * vBare, f3(vCur) + ' vs ' + f3(vBare) + ' mm³ (' + f3(vCur - vBare) + ')');
  const again = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0]].map(d => { const A = LA.analyse(cur, triAt(cur, onBall(d), d), CURVED); return A.ok ? A.islands.length : -1; });
  check('...and a fresh read from four sides finds nothing standing on it', again.every(x => x === 0), again.join(', '));
  REPORT.push('ball, all 14 one after another: bare to ' + f3(worst) + ' mm, volume ' + f3(vCur) + ' vs the bare icosphere ' + f3(vBare) + ' mm³');
  bareBall = cur;
}
check('nothing here wrote to the source: the ball is bit for bit what it was', SBo.every((v, i) => v === sbCopy[i]));

/* ======================================================= 2. the domed plate */

console.log('\n=== 2. a gently domed plate (radius of curvature 80 mm): eight dots, a 36 mm squiggle, a plaque ===');
const DM = CF.dome(), DMo = DM.soup;
DM.normalAt = () => [0, 0, 1];
const dmSeed = s => triAt(s, [34, 30, DM.baseZ(34, 30)], [0, 0, 1]);
const A2D = LA.analyse(DMo, dmSeed(DMo)), sq2 = islandNear(A2D, [30, 22], 3);
check('Lift 2 as it is: the squiggle is refused (bends)', sq2 && sq2.status === 'bends', sq2 && sq2.reason);
const AD = LA.analyse(DMo, dmSeed(DMo), CURVED);
const dIs = DM.truth.map(T => islandNear(AD, T.center, 2));
check('Lift 3 reads all ten - the dots, the squiggle, the plaque - every one liftable, along the dome', AD.ok && dIs.every(I => I && I.status === 'ok' && I.fill === 'curved'),
  AD.ok ? dIs.map(I => I ? I.status : '-').join(',') + '; groups ' + JSON.stringify(AD.groups) : AD.reason);
DM.truth.forEach((T, i) => {
  const I = dIs[i];
  if (!I) return;
  const q = quiet(() => curvedLift('dome ' + T.kind + ' ' + (i + 1), DMo, AD, I, DM));
  if (!q.bad && q.r) console.log('  ok    dome ' + T.kind + ' ' + (i + 1) + ' lifts with every gate (' + q.lines + '): ' + q.r.rim.words + '; on the dome within ' + f3(q.r.dev) + ' mm');
  if (T.kind === 'squiggle' && q.r) REPORT.push('dome squiggle (36 mm, Lift 2 refused it, bend ' + f2(sq2.bendMm) + ' mm): ' + q.r.rim.words + ', on the dome within ' + f3(q.r.dev) + ' mm; fill ' + Math.round(q.r.r.pieces[0].fill.ms) + ' ms');
});
const plaque = dIs[DM.truth.findIndex(T => T.kind === 'plaque')];
const rPl = plaque && LA.lift(DMo, AD, [plaque.id], DEPS);
check('the plaque (78.5 mm², more than the clear surface measured round it) lifts, and says in words what the fill cannot know',
  rPl && rPl.ok && rPl.notes.length === 1 && /more than the .* mm² of clear surface measured round it: across its middle the surface carried under it is the base fitted to that surround/.test(rPl.notes[0]) &&
  /Note: /.test(rPl.reason), rPl && (rPl.notes || [])[0]);
const dAll = LA.lift(DMo, AD, LA.offered(AD, 0.42), DEPS);
check('all ten together: ten closed pieces, the plate closed, the volumes add up', dAll.ok && dAll.pieces.length === 10 && dAll.pieces.every(p => p.census.closed) &&
  L.census(dAll.plate).closed && Math.abs(dAll.volumes.residual) < 1e-7 * dAll.volumes.source,
  dAll.ok ? f3(dAll.volumes.plate) + ' + ' + f3(dAll.volumes.pieces) + ' = ' + f3(dAll.volumes.source) : dAll.reason);
if (dAll.ok) {
  const rim = rimOf(dAll.plate, dAll.keptTris);
  check('...every weld of all ten carries the slope across', rim.smooth && rim.n === dIs.reduce((s, I) => s + I.loops.reduce((a, Lp) => a + Lp.verts.length, 0), 0),
    rim.n + ' welds; ' + rim.words);
  let dev = 0;
  for (let c = dAll.keptTris * 9; c < dAll.plate.length; c += 3) dev = Math.max(dev, Math.abs(DM.base([dAll.plate[c], dAll.plate[c + 1], dAll.plate[c + 2]])));
  check('...and where all ten stood, every corner is on the dome (within 0.01 mm)', dev < 0.01, f3(dev) + ' mm');
  domeAll = dAll;
}
const RD = removed('dome', DMo, AD, LA.offered(AD, 0.42), dmSeed);
if (RD) {
  check('dome: Remove says it carried the surface across, and its note', /as they were; where they stood, the surface round them is carried across, welded to it at the rim\. Note: /.test(RD.r.reason) &&
    RD.r.notes.length === 1, RD.r.reason.slice(0, 220));
  check('dome: after Remove a fresh read finds nothing standing on it', RD.A2.ok && RD.A2.islands.filter(I => I.status === 'ok').length === 0,
    RD.A2.ok ? RD.A2.islands.length + ' found' + (RD.A2.islands.length ? ' (' + RD.A2.islands.map(I => I.status).join(',') + ': the slab\'s corners, falling away, as on the bare dome)' : '') : RD.A2.reason);
}

/* ========================================================== 3. the cylinder */

console.log('\n=== 3. a cylinder 30 mm across with bumps, and a ridge running 16 mm round it ===');
const CY = CF.cylinder(), CYo = CY.soup;
CY.normalAt = p => unit([0, p[1], p[2]]);
const onCyl = p => { const r = Math.hypot(p[1], p[2]); return [p[0], p[1] * CY.R / r, p[2] * CY.R / r]; };
check('fixture: closed and manifold', L.census(CYo).closed, CYo.length / 9 + ' tris');
let cyOk = 0, cyOne = null;
CY.truth.forEach((T, i) => {
  const p = T.kind === 'ridge' ? onCyl([T.center[0] - 4, T.center[1], T.center[2]]) : besideBump(T, onCyl);
  const A = LA.analyse(CYo, triAt(CYo, p, CY.normalAt(p)), CURVED), I = A.ok && islandNear(A, T.center, 3);
  const tag = 'cylinder ' + T.kind + ' ' + (i + 1);
  if (!I) { check(tag + ': found', false, A.ok ? A.islands.length + ' islands' : A.reason); return; }
  if (i === 0) {
    const A2 = LA.analyse(CYo, triAt(CYo, p, CY.normalAt(p))), I2 = islandNear(A2, T.center, 3);
    check('Lift 2 as it is: refused (bends)', I2 && I2.status === 'bends', I2 && I2.reason);
  }
  check(tag + ': found, liftable', I.status === 'ok', I.reason);
  const q = quiet(() => curvedLift(tag, CYo, A, I, CY));
  if (!q.bad && q.r) {
    cyOk++;
    console.log('  ok    ' + tag + ' lifts with every gate (' + q.lines + '): ' + q.r.rim.words + '; on the cylinder within ' + f3(q.r.devIn) + ' mm inside, ' + f3(q.r.dev) + ' at the rim');
    if (T.kind === 'ridge') REPORT.push('cylinder ridge (16 mm round, 61° of arc): ' + q.r.rim.words + ', on the cylinder within ' + f3(q.r.dev) + ' mm, ' + q.r.r.pieces[0].fill.points + ' points inside');
    if (i === 0) cyOne = q.r;
  }
});
check('all 8 lift', cyOk === 8, cyOk + ' of 8');

/* ======================================== 4. Lift 2's fixtures, read curved */

console.log('\n=== 4. Lift 2\'s fixtures, read with { curved: true } ===');
const key = I => I.tris.slice().sort((a, b) => a - b).join(',');
function seedNear(s, x, y, z) {
  let b = -1, bd = Infinity;
  for (let t = 0; t < s.length / 9; t++) {
    const o = t * 9;
    if (triNormal(s, t)[2] <= 0) continue;
    if (z != null && !(s[o + 2] === z && s[o + 5] === z && s[o + 8] === z)) continue;
    const dd = Math.hypot((s[o] + s[o + 3] + s[o + 6]) / 3 - x, (s[o + 1] + s[o + 4] + s[o + 7]) / 3 - y);
    if (dd < bd) { bd = dd; b = t; }
  }
  return b;
}
[['the flat plate', FX.flat(DEPS.rawFlatCapLoops).soup, [26, 26, 3]], ['Phase 1\'s plate (56 details)', FX1.plate(DEPS.rawFlatCapLoops).soup, [26, 26, 3]],
 ['the leaves', FX.leaves().soup, [5, 5]]].forEach(([name, soup, at]) => {
  const seed = seedNear(soup, at[0], at[1], at[2]), A2 = LA.analyse(soup, seed), A3 = LA.analyse(soup, seed, CURVED);
  const ids = LA.offered(A2, 0.42), r2 = LA.lift(soup, A2, ids, DEPS), r3 = LA.lift(soup, A3, ids, DEPS);
  check(name + ': a flat face - exactly Lift 2\'s islands, every one cut flat, and the same plate and pieces, bit for bit',
    JSON.stringify(A2.islands.map(key).sort()) === JSON.stringify(A3.islands.map(key).sort()) && A3.islands.every(I => !I.fill) &&
    r2.ok && r3.ok && r2.plate.length === r3.plate.length && r2.plate.every((v, i) => v === r3.plate[i]) &&
    r2.pieces.every((p, i) => p.soup.length === r3.pieces[i].soup.length && p.soup.every((v, j) => v === r3.pieces[i].soup[j])) && r2.reason === r3.reason,
    A3.islands.length + ' islands, ' + ids.length + ' lifted');
});
const lift2Refused = {};
[['the dish (R 150)', FX.dish(), [30, 35]], ['noisy paper +-0.08', FX.noisy(0.08), [20, 20]], ['noisy paper +-0.16', FX.noisy(0.16), [20, 20]],
 ['0.2 mm layer steps', FX.stepped(), [2.5, 30]]].concat([300, 150, 60, 30].map(R => ['bowl R ' + R + ' with bars 2 - 20 mm', FX.dishBars(R, [2, 4, 6, 8, 10, 12, 16, 20]), [24, 24]]))
  .forEach(([name, F, at]) => {
    const soup = F.soup, seed = seedNear(soup, at[0], at[1]), A2 = LA.analyse(soup, seed), A3 = LA.analyse(soup, seed, CURVED);
    const n2 = A2.islands.filter(I => I.status === 'ok').length, n3 = A3.islands.filter(I => I.status === 'ok').length;
    lift2Refused[name] = A2.islands.length - n2;
    const all = A3.islands.filter(I => I.status === 'ok').map(I => I.id), r = LA.lift(soup, A3, all, DEPS);
    let rim = null;
    if (r.ok) rim = rimOf(r.plate, r.keptTris);
    // rough surfaces: the fill runs smooth (said in words below), so only "no
    // weld bends more than the surface's own worst" is asked of them
    const rough = /noisy|steps/.test(name);
    check(name + ': every detail Lift 2 found lifts (Lift 2: ' + n2 + ' of ' + A2.islands.length + '); closed, the volumes add up, ' +
      (rough ? 'no weld bends more than the surface\'s own worst' : 'the welds bend no more than the surface round them'),
      A3.islands.length === A2.islands.length && n3 === A3.islands.length && r.ok && L.census(r.plate).closed && r.pieces.every(p => p.census.closed) &&
      Math.abs(r.volumes.residual) < 1e-7 * r.volumes.source && (rough ? rim.noWorse : rim.smooth),
      n3 + ' of ' + A3.islands.length + (r.ok ? '; ' + rim.words : '; ' + r.reason));
    if (/noisy|steps/.test(name)) {
      check(name + ': ...and each says why its fill runs smooth - the roughness round it is not made up under it',
        r.ok && r.notes.length >= A3.islands.length && r.notes.every(s => /is rough \(.* mm rms about the smooth surface fitted to it\): the fill meets it at the rim and runs smooth across/.test(s)),
        r.ok && r.notes[0]);
    }
    REPORT.push(name + ': Lift 2 lifts ' + n2 + ' of ' + A2.islands.length + ', Lift 3 ' + n3 + (r.ok ? '; ' + rim.words : ''));
  });

/* ============================================================ 5. refusals */

console.log('\n=== 5. refusals and the opt-in ===');
check('curved is opt-in: Lift 2\'s analyse is unchanged by default (nothing curved on a read without it)', LA.DEFAULTS.curved === false &&
  LA.analyse(SBo, seedFor(SBo, SB.truth[1], SB, onBall)).islands.every(I => !I.fill));
check('the repair is its own module (window.NSO_LiftCurved): fill, baseSampler', typeof LC.fill === 'function' && typeof LC.baseSampler === 'function');

/* ===================================================== 6. canonical checker */

console.log('\n=== 6. tools/mesh_validate.py, self-intersection on ===');
[['a spike off the ball', sbOne && sbOne.r.pieces[0].soup], ['the ball after one spike', sbOne && sbOne.r.plate], ['the bare ball (all 14 lifted)', bareBall],
 ['the dome after all ten', domeAll && domeAll.plate], ['the plaque', rPl && rPl.ok && rPl.pieces[0].soup], ['a cylinder spike', cyOne && cyOne.r.pieces[0].soup],
 ['the cylinder after it', cyOne && cyOne.r.plate]].forEach(([name, soup], i) => {
  if (!soup) { check(name + ': PASS, no piercing, no coincident faces', false, 'missing'); return; }
  const j = validate(soup, 'c' + i);
  check(name + ': PASS, no piercing, no coincident faces', j.clean, j.summary);
});

console.log('\n--- report ---');
REPORT.forEach(s => console.log('  ' + s));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('FAILED: ' + FAILS.join('; ')); process.exit(1); }
