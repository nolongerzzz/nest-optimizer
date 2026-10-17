#!/usr/bin/env node
// The spatial index under NSO_SupportAim (section 0b of nso_support_aim.js):
// one BVH per piece, built once, cached on the soup, asked for every ray, every
// nearest point and every inside test the support planner makes.
//
//   node tools/nso_support_index_test.js       exit 0 = every gate held
//
// The index changes no answer, it only narrows which triangles a question is
// put to. So every gate here holds a query to its brute-force twin (the
// *Brute functions, and windingAt, kept in the module for exactly this):
//
//   1. rays            index == walk, to the bit, on the clamp bar and the tape
//   2. straight down   the footprint variant == the walk with the footprint rule
//   3. nearest point   same point, same distance; "within" == distance < tol
//   4. inside          windingInside == (windingAt >= 0.5) on points a hair from
//                      a face and in the open, on the clamp bar (closed by a
//                      fan of 0), the tape (open in earnest: the bound sum) and
//                      every small defective fixture (fans, T-junctions, flips)
//   5. the cache       one index per soup object; an edit in place is caught
//                      (a transform by the sample, anything by verify)
//   6. whole plans     the small pieces plan to the same JSON with the index
//                      as with the walk
//   7. THE WEDGE       library/v9_mirror_factory.stl, its big underside: 377
//                      support points, 49,026 triangles. It took 478 s to plan
//                      with every query walking the piece; it plans under
//                      WEDGE_BUDGET_S here (the timing gate), to the plan it
//                      always planned (pinned by hash)
//
// Loads the shipped files with vm, in index.html's order, the way
// tools/nso_support_gridpack_test.js does.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { readSTL } = require('./nso_stl_io.js');

const ROOT = path.join(__dirname, '..');
const WEDGE_BUDGET_S = 30;
/* The plan the wedge's 377 points have always planned to: sha256 (first 16 hex
   digits) of JSON.stringify of planTree's result, typed arrays as arrays.
   Taken from the walk-everything code before the index existed. Re-pin only
   with a planner change that is meant to move the plan. */
const WEDGE_PLAN_SHA = 'fd7642190e345a54';

const ctx = {
  Math, Map, Set, console, Array, Object, Number, String, JSON, isFinite, Promise,
  Float32Array, Float64Array, Int32Array, Uint32Array, Uint8Array, ArrayBuffer
};
vm.createContext(ctx);
for (const f of ['nso_thickness.js', 'nso_seat_surface.js', 'app-sculpt.js', 'app-extend.js',
                 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js',
                 'nso_support_tree.js', 'nso_support_gridpack.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const SA = ctx.NSO_SupportAim, ST = ctx.NSO_SupportTree;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

/* A fixed pseudo-random stream, so a failure is the same failure next time. */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const bounds = (s) => {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], s[i + k]); mx[k] = Math.max(mx[k], s[i + k]); }
  return { mn, mx };
};
const randUnit = (r) => { for (;;) { const d = [r() - .5, r() - .5, r() - .5], L = Math.hypot(d[0], d[1], d[2]); if (L > .05) return d.map(x => x / L); } };
/* Points: a third in the box round the piece (air, mostly), the rest a hair
   off a random face, either side, from 1 micron to ~2 mm. */
function probePoints(s, n, seed) {
  const r = rng(seed), { mn, mx } = bounds(s), tris = (s.length / 9) | 0, pts = [];
  for (let i = 0; i < n; i++) {
    if (i % 3 === 0) { pts.push([0, 1, 2].map(k => mn[k] - 5 + (mx[k] - mn[k] + 10) * r())); continue; }
    const o = ((r() * tris) | 0) * 9;
    let u = r(), v = r(); if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const a = [s[o], s[o + 1], s[o + 2]], e1 = [s[o + 3] - a[0], s[o + 4] - a[1], s[o + 5] - a[2]], e2 = [s[o + 6] - a[0], s[o + 7] - a[1], s[o + 8] - a[2]];
    let nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const L = Math.hypot(nn[0], nn[1], nn[2]) || 1; nn = nn.map(x => x / L);
    const d = (r() < .5 ? 1 : -1) * Math.pow(10, -3 + 3.3 * r());
    pts.push([0, 1, 2].map(k => a[k] + u * e1[k] + v * e2[k] + nn[k] * d));
  }
  return pts;
}

const CLAMP = readSTL(path.join(ROOT, 'library', 'v9_mirror_factory.stl'));
const TAPE = readSTL(path.join(ROOT, 'fixtures', 'tape_on-edge-single-B101_rounded_v8_FINAL.stl'));

console.log('\n=== 1. Rays: the index answers what the walk answers, to the bit ===');
for (const [label, s, n] of [['clamp bar', CLAMP, 2500], ['tape', TAPE, 1500]]) {
  const r = rng(11), { mn, mx } = bounds(s);
  const axes = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [Math.SQRT1_2, Math.SQRT1_2, 0]];
  let bad = 0, hits = 0;
  for (let i = 0; i < n; i++) {
    const o = [0, 1, 2].map(k => mn[k] - 4 + (mx[k] - mn[k] + 8) * r());
    const d = i % 3 === 0 ? axes[i % axes.length] : randUnit(r);
    const tMax = r() < .5 ? 1e9 : r() * 40;
    const a = SA._nearestHitBrute([s], o, d, 1e-3, tMax), b = SA._nearestHit([s], o, d, 1e-3, tMax);
    if (!Object.is(a, b)) bad++;
    if (a > 0) hits++;
  }
  check(`${label}: ${n} rays (axis-aligned, vertical and oblique) agree to the bit`, bad === 0, `${bad} differ, ${hits} hit something`);
}
{
  /* Several soups at once, the way obstacles = [piece].concat(occluders) asks. */
  const r = rng(3), { mn, mx } = bounds(CLAMP);
  const occ = new Float32Array(TAPE); for (let i = 0; i < occ.length; i += 3) occ[i + 2] += mx[2] + 1;
  let bad = 0;
  for (let i = 0; i < 400; i++) {
    const o = [0, 1, 2].map(k => mn[k] - 4 + (mx[k] - mn[k] + 8) * r()), d = randUnit(r);
    if (!Object.is(SA._nearestHitBrute([CLAMP, occ], o, d, 1e-3, 1e9), SA._nearestHit([CLAMP, occ], o, d, 1e-3, 1e9))) bad++;
  }
  check('two soups at once (a piece and an occluder): 400 rays agree to the bit', bad === 0, `${bad} differ`);
}

{
  /* A strange mesh: 400 triangles along a geometric progression, the shape a
     surface-area split peels one triangle a level from. The tree must stay
     shallower than the traversal's stack, and still answer exactly. */
  const g = [];
  for (let i = 0; i < 400; i++) { const c = Math.pow(1.05, i); g.push(c, 0, 0, c + 0.5, 1, 0, c, 1, 1); }
  const soup = new Float32Array(g), r = rng(17);
  let bad = 0, hits = 0;
  for (let i = 0; i < 600; i++) {
    const o = [Math.pow(1.05, r() * 400) + r(), r() * 2 - .5, r() * 2 - .5], d = i % 2 ? [0, 0, 1] : randUnit(r);
    const a = SA._nearestHitBrute([soup], o, d, 1e-3, 1e9), b = SA._nearestHit([soup], o, d, 1e-3, 1e9);
    if (!Object.is(a, b)) bad++;
    if (a > 0) hits++;
  }
  check('a geometric-progression mesh (400 triangles, the worst case for a peeling split): 600 rays agree to the bit', bad === 0 && hits > 0, `${bad} differ, ${hits} hit something`);
}

console.log('\n=== 2. Straight down: the footprint variant is the walk with the footprint rule ===');
{
  /* nearestHitDown's rule: a triangle is asked only if (x, y) lies in its XY
     bounding box. The walk, with that rule. */
  const walk = (s, o, tMin, tMax) => {
    let best = -1;
    for (let t = 0; t < s.length / 9; t++) {
      const b = t * 9;
      if (o[0] < Math.min(s[b], s[b + 3], s[b + 6]) || o[0] > Math.max(s[b], s[b + 3], s[b + 6]) ||
          o[1] < Math.min(s[b + 1], s[b + 4], s[b + 7]) || o[1] > Math.max(s[b + 1], s[b + 4], s[b + 7])) continue;
      const hit = SA._nearestHitBrute([s.subarray(b, b + 9)], o, [0, 0, -1], tMin, tMax);
      if (hit > tMin && hit < tMax && (best < 0 || hit < best)) best = hit;
    }
    return best;
  };
  const sub = new Float32Array(CLAMP.subarray(0, 9 * 6000));
  const grid = SA._buildDownGrid([sub]);
  const r = rng(5), { mn, mx } = bounds(sub);
  let bad = 0, hits = 0;
  for (let i = 0; i < 300; i++) {
    const o = i % 2 ? [mn[0] + (mx[0] - mn[0]) * r(), mn[1] + (mx[1] - mn[1]) * r(), mx[2] + 1]
                    : (() => { const t = ((r() * 6000) | 0) * 9; return [(sub[t] + sub[t + 3] + sub[t + 6]) / 3, (sub[t + 1] + sub[t + 4] + sub[t + 7]) / 3, sub[t + 2] + 1e-3]; })();
    const a = walk(sub, o, 1e-3, 1e9), b = SA._nearestHitDown(grid, o, 1e-3, 1e9);
    if (!Object.is(a, b)) bad++;
    if (a > 0) hits++;
  }
  check('300 straight-down rays on 6,000 triangles of the clamp bar agree to the bit', bad === 0, `${bad} differ, ${hits} hit something`);
}

console.log('\n=== 3. Nearest point, and "is anything within tol" ===');
{
  const r = rng(9);
  const pts = probePoints(CLAMP, 300, 21);
  let bad = 0;
  for (const p of pts) {
    const a = SA._closestOnSoupBrute(p, CLAMP), b = SA._closestOnSoup(p, CLAMP);
    if (a.distance !== b.distance || a.point.some((v, k) => v !== b.point[k])) bad++;
  }
  check('clamp bar: 300 nearest points agree to the bit (point and distance)', bad === 0, `${bad} differ`);
  bad = 0; let near = 0;
  for (const p of pts) for (const tol of [1e-3, 0.05, 0.5]) {
    const brute = SA._closestOnSoupBrute(p, CLAMP).distance < tol;
    if (brute) near++;
    if (brute !== SA._withinOfSoup(p, CLAMP, tol)) bad++;
  }
  check('clamp bar: "anything within tol" (1e-3, 0.05, 0.5 mm) agrees on 900 asks', bad === 0, `${bad} differ, ${near} within`);
  void r;
}

console.log('\n=== 4. Inside: windingInside is windingAt >= 0.5, always ===');
function insideGate(label, s, n, seed) {
  const pts = probePoints(s, n, seed);
  let bad = 0, inside = 0;
  for (const p of pts) {
    const w = SA._windingAt(s, p) >= 0.5;
    if (w) inside++;
    if (w !== SA._windingInside(s, p)) bad++;
  }
  const ix = SA._indexFor(s);
  const fan = ix && ix.cross !== undefined ? (ix.cross ? ix.cross.n + '-triangle fan' : 'no fan (open in earnest: the bound sum)') : '';
  check(`${label}: ${n} points agree (${inside} inside)`, bad === 0, `${bad} differ; ${fan}`);
}
insideGate('clamp bar', CLAMP, 1200, 31);
insideGate('tape', TAPE, 900, 32);
{
  const was = SA._setIndexMinTris(1, 1);       /* force the index on even the small ones */
  const dirs = ['fixtures/open', 'fixtures/damage', 'fixtures/repair'];
  let files = 0, pointsAsked = 0, bad = 0, fans = 0;
  for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(ROOT, d)).filter(x => x.endsWith('.stl')).sort()) {
      const s = readSTL(path.join(ROOT, d, f));
      files++;
      for (const p of probePoints(s, 120, 40 + files)) {
        pointsAsked++;
        if ((SA._windingAt(s, p) >= 0.5) !== SA._windingInside(s, p)) bad++;
      }
      const ix = SA._indexFor(s);
      if (ix && ix.cross && ix.cross.n > 0) fans++;
    }
  }
  SA._setIndexMinTris(was[0], was[1]);
  check(`the ${files} open / damaged / repair fixtures (holes, flaps, T-junctions, flips, duplicates): ${pointsAsked} points agree`,
    bad === 0, `${bad} differ; ${fans} of them closed by a fan`);
}

console.log('\n=== 5. The cache is the soup, and it notices an edit ===');
{
  const s = new Float32Array(CLAMP);
  const a = SA._indexFor(s), b = SA._indexFor(s);
  check('the same soup object gets the same index, not a second build', a && a === b);
  check('a soup under the size floor gets none (walking twelve triangles beats an index)',
    SA._indexFor(new Float32Array(12 * 9)) === null);
  const moved = new Float32Array(s); for (let i = 2; i < moved.length; i += 3) moved[i] += 7.5;
  check('a copy is another soup: its own index', SA._indexFor(moved) !== a);
  const was = new Float32Array(s);
  for (let i = 0; i < s.length; i += 3) s[i] += 3;                       /* a transform in place */
  const c = SA._indexFor(s);
  check('a transform in place is caught by the sample on the next ask', c !== a);
  s.set(was);
  const d = SA._indexFor(s, true);
  /* One value the 48-value sample does not read (index 1): only verify sees it. */
  const before = s[1]; s[1] = before + 1;
  const quiet = SA._indexFor(s), loud = SA._indexFor(s, true);
  s[1] = before;
  check('one edited number the sample cannot see: the plain ask keeps the index, verify rebuilds it', quiet === d && loud !== d);
}

console.log('\n=== 6. Whole plans: with the index == with the walk ===');
function box(lo, hi) {
  const v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const out = []; for (const t of f) for (const i of t) out.push(...v[i]); return out;
}
function tilted(soup, deg) {
  const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), o = [];
  for (let i = 0; i < soup.length; i += 3) o.push(c * soup[i] + s * soup[i + 2], soup[i + 1], -s * soup[i] + c * soup[i + 2]);
  let mz = Infinity; for (let i = 2; i < o.length; i += 3) mz = Math.min(mz, o[i]);
  for (let i = 2; i < o.length; i += 3) o[i] -= mz;
  return new Float32Array(o);
}
/* The Supports workflow check's tunnel block (tools/nso_support_exposed_test.js). */
function tunnelBlock(x0, x1, z1) {
  const xs = [x0, x0 + 12, x1 - 12, x1], zs = [0, 8, 20, z1], cells = [];
  for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) if (!(i === 1 && k === 1)) cells.push([i, k]);
  const has = (i, k) => cells.some(c => c[0] === i && c[1] === k);
  const out = [];
  const quad = (a, b, c, d, want) => {
    const u = b.map((x, i) => x - a[i]), w = c.map((x, i) => x - a[i]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const flip = n[0] * want[0] + n[1] * want[1] + n[2] * want[2] < 0;
    for (const tri of flip ? [[a, c, b], [a, d, c]] : [[a, b, c], [a, c, d]]) for (const q of tri) out.push(...q);
  };
  for (const [i, k] of cells) {
    const xa = xs[i], xb = xs[i + 1], za = zs[k], zb = zs[k + 1];
    quad([xa, 0, za], [xb, 0, za], [xb, 0, zb], [xa, 0, zb], [0, -1, 0]);
    quad([xa, 40, za], [xb, 40, za], [xb, 40, zb], [xa, 40, zb], [0, 1, 0]);
    for (const [ni, nk, d, e] of [[i - 1, k, [-1, 0], [xa, za, xa, zb]], [i + 1, k, [1, 0], [xb, za, xb, zb]],
                                  [i, k - 1, [0, -1], [xa, za, xb, za]], [i, k + 1, [0, 1], [xa, zb, xb, zb]]]) {
      if (!has(ni, nk)) quad([e[0], 0, e[1]], [e[2], 0, e[3]], [e[2], 40, e[3]], [e[0], 40, e[1]], [d[0], 0, d[1]]);
    }
  }
  return new Float32Array(out);
}
const planJSON = (p) => JSON.stringify(p, (k, v) => ArrayBuffer.isView(v) ? Array.from(v) : v);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
for (const [label, soup, opts] of [
  ['box tilted 30 deg (12 triangles: under the index floor, so identical by construction)', tilted(new Float32Array(box([0, 0, 0], [40, 12, 6])), 30), {}],
  ['tunnel block at 6 mm (64 triangles, 21 points, 15 only the piece can hold)', tunnelBlock(60, 100, 30), { pitchMm: 6 }],
  ['tunnel block, resting on the piece', tunnelBlock(60, 100, 30), { pitchMm: 6, restOnModel: true }]]) {
  const was = SA._setIndexMinTris(Infinity);
  const walked = ST.planTree(soup, Object.assign({ skipList: [] }, opts));
  SA._setIndexMinTris(was[0], was[1]);
  const indexed = ST.planTree(soup, Object.assign({ skipList: [] }, opts));
  /* ...and with the crossing / far-field inside test on even this small a piece */
  const was2 = SA._setIndexMinTris(16, 1);
  const forced = ST.planTree(soup, Object.assign({ skipList: [] }, opts));
  SA._setIndexMinTris(was2[0], was2[1]);
  const a = planJSON(walked), b = planJSON(indexed), c = planJSON(forced);
  check(`${label}: the plan is the same JSON, byte for byte`, a === b && a === c && walked.ok,
    `${walked.beacons && walked.beacons.length} points, ${walked.members && walked.members.length} members, ${a.length} bytes`);
}

console.log('\n=== 7. THE WEDGE: 377 points, 49,026 triangles, under ' + WEDGE_BUDGET_S + ' s ===');
{
  const t0 = Date.now();
  const p = ST.planTree(CLAMP, { skipList: [], regionId: 0 });
  const secs = (Date.now() - t0) / 1000;
  const json = planJSON(p);
  console.log('        planned in ' + secs.toFixed(1) + ' s (it took 478 s when every query walked the piece)');
  check('the big underside: 377 support points, all held', p.ok && p.beacons.length === 377 && p.held === 377,
    `${p.beacons && p.beacons.length} points, ${p.held} held, ${p.members && p.members.length} members`);
  check(`TIMING GATE: planTree on the wedge's 377 points takes under ${WEDGE_BUDGET_S} s`, secs < WEDGE_BUDGET_S, secs.toFixed(1) + ' s');
  check('...and is the plan it has always been (pinned by hash)', sha(json) === WEDGE_PLAN_SHA, sha(json) + (sha(json) === WEDGE_PLAN_SHA ? '' : '  expected ' + WEDGE_PLAN_SHA));
}

console.log('\n' + (fail ? 'FAILED' : 'PASSED') + '  ' + (fail ? fail + ' of ' + (pass + fail) : 'all ' + pass));
if (fail) { for (const f of FAILS) console.log('  - ' + f); process.exit(1); }
