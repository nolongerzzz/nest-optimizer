#!/usr/bin/env node
/* Standing regression gate for NSO_Repair.
 *
 *   node tools/nso_repair_regress.js              # run everything
 *   node tools/nso_repair_regress.js -v           # print every checked value
 *   node tools/nso_repair_regress.js --skip-missing
 *                                                 # do not fail on fixtures that
 *                                                 # are not in the tree (see the
 *                                                 # thingi10k note below)
 *
 * Exit code 0 only if every expectation matched. Any drift prints the case, the
 * key, expected vs actual, and exits 1. These numbers are the contract: if a
 * change to NSO_Repair.js moves one of them, that is the change asking to be
 * looked at, not the test asking to be updated.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readSTL, loadRepairModule } = require('./nso_stl_io.js');

const ROOT = path.join(__dirname, '..');
const FX = path.join(ROOT, 'fixtures', 'repair');
const THINGI = path.join(FX, 'thingi10k');
const R = loadRepairModule(path.join(ROOT, 'NSO_Repair.js'));

const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');
const SKIP_MISSING = process.argv.includes('--skip-missing');

/* Float comparison helper: written as ~(value) or ~(value, tol). */
function approx(v, tol) { return { __approx: v, tol: tol == null ? 1e-9 : tol }; }

/* ------------------------------------------------------------------ *
 * What commit() produced, flattened to the keys the cases assert on.
 * ------------------------------------------------------------------ */
function observe(raw, result) {
  const r = result.report;
  const flat = {
    'ok': result.ok,
    'applied': r.applied,
    'declined': r.declined,
    'unchanged': result.rawTris === raw,
    'triDelta': r.triDelta,
    'volumeDelta': r.volumeDelta,
    'gate.blocked': (r.gate.blockedStages || []).join(','),
    'gate.selfIntBefore': r.gate.selfIntBefore,
    'gate.selfIntAfter': r.gate.selfIntAfter
  };
  for (const side of ['before', 'after']) {
    if (!r[side]) continue;
    for (const k of Object.keys(r[side])) flat[side + '.' + k] = r[side][k];
  }
  for (const k of Object.keys(r.counts)) flat['counts.' + k] = r.counts[k];
  return flat;
}

/* ------------------------------------------------------------------ *
 * The cases
 * ------------------------------------------------------------------ */

/* Every number below was measured against this module, on these fixtures, and
 * is reproduced in docs/NSO_Repair.md. The cube fixtures all derive from one
 * 20 mm cube whose exact volume is 8000 mm^3 and whose 12 triangles carry a
 * single named defect, so the volume arithmetic is checkable by hand: one
 * bottom triangle of that cube spans a tetrahedron of exactly 8000/12 =
 * 666.667 mm^3 against the origin. */
const SYNTHETIC = [
  {
    name: 'hole — one missing triangle is refilled',
    file: 'synth_hole.stl',
    expect: {
      'ok': true, 'applied': true, 'unchanged': false,
      'before.tris': 11, 'before.openEdges': 3, 'before.boundaryLoops': 1,
      'before.watertight': false, 'before.volume': approx(7333.333333333333, 1e-9),
      'after.tris': 12, 'after.oddEdges': 0, 'after.watertight': true,
      'after.volume': approx(8000, 1e-9), 'after.selfIntersections': 0,
      'counts.holesFilled': 1, 'counts.holeTrisAdded': 1,
      'triDelta': 1, 'volumeDelta': approx(666.6666666666667, 1e-9)
    }
  },
  {
    name: 'exact duplicate — the second copy goes, the shell is restored',
    file: 'synth_dup_exact.stl',
    expect: {
      'ok': true, 'applied': true,
      'before.tris': 13, 'before.nonManifoldEdges': 3, 'before.volume': approx(8666.666666666666, 1e-9),
      'after.tris': 12, 'after.oddEdges': 0, 'after.watertight': true,
      'after.volume': approx(8000, 1e-9),
      'counts.exactDuplicatesRemoved': 1, 'counts.reversedDuplicatesRemoved': 0,
      'triDelta': -1, 'volumeDelta': approx(-666.6666666666667, 1e-9)
    }
  },
  {
    name: 'real + reversed duplicate — the FLIPPED copy goes, not the real one',
    file: 'synth_dup_reversed.stl',
    expect: {
      'ok': true, 'applied': true,
      'before.tris': 13, 'before.nonManifoldEdges': 3, 'before.volume': approx(7333.333333333333, 1e-9),
      'after.tris': 12, 'after.oddEdges': 0, 'after.watertight': true,
      // 8000, not 6666.67: keeping the wrong copy would leave the shell inside out here
      'after.volume': approx(8000, 1e-9),
      'counts.exactDuplicatesRemoved': 0, 'counts.reversedDuplicatesRemoved': 1,
      'triDelta': -1, 'volumeDelta': approx(666.6666666666667, 1e-9)
    }
  },
  {
    name: 'floating flap — peeled, volume untouched',
    file: 'synth_flap.stl',
    expect: {
      'ok': true, 'applied': true,
      'before.tris': 13, 'before.openEdges': 2, 'before.nonManifoldEdges': 1,
      'before.volume': approx(8000, 1e-9),
      'after.tris': 12, 'after.oddEdges': 0, 'after.watertight': true,
      'after.volume': approx(8000, 1e-9),
      'counts.flapTrisRemoved': 1,
      'triDelta': -1, 'volumeDelta': approx(0, 1e-9)
    }
  },
  {
    name: 'T-junction — one split, volume EXACTLY preserved',
    file: 'synth_tjunction.stl',
    expect: {
      'ok': true, 'applied': true,
      'before.tris': 13, 'before.openEdges': 3, 'before.volume': approx(8000, 1e-9),
      'after.tris': 14, 'after.oddEdges': 0, 'after.watertight': true,
      // the inserted vertex is exactly on the edge, so the split adds no volume
      'after.volume': approx(8000, 1e-9),
      'counts.tJunctionSplits': 1,
      'triDelta': 1, 'volumeDelta': approx(0, 1e-9)
    }
  },
  {
    name: 'near-duplicate vertices — welded, tri count and volume unmoved',
    file: 'synth_near_dup_vertex.stl',
    expect: {
      'ok': true, 'applied': true,
      'before.tris': 12, 'after.tris': 12, 'after.watertight': true,
      'counts.weldedNear': 20,
      'triDelta': 0, 'volumeDelta': approx(0, 1e-9)
    },
    /* The weld is the whole repair here, and neither tri count nor volume can
     * show it. What shows it is that the OUTPUT survives an exact-match weld,
     * which the input does not: 36 open edges before, 0 after. */
    extra(raw, result) {
      const before = R.inspect(raw, { weldTol: 1e-12, selfIntersections: false });
      const after = R.inspect(result.rawTris, { weldTol: 1e-12, selfIntersections: false });
      return {
        'exactWeld.before.openEdges': before.openEdges,
        'exactWeld.before.verts': before.verts,
        'exactWeld.after.openEdges': after.openEdges,
        'exactWeld.after.verts': after.verts
      };
    },
    expectExtra: {
      'exactWeld.before.openEdges': 36, 'exactWeld.before.verts': 21,
      'exactWeld.after.openEdges': 0, 'exactWeld.after.verts': 8
    }
  },
  {
    name: '2-sheet pinch, SAFE angle — separates cleanly, gate passes',
    file: 'synth_pinch_2sheet_safe.stl',
    expect: {
      'ok': true, 'applied': true, 'unchanged': false,
      'before.tris': 12, 'before.pinchVerts': 1, 'before.watertight': true,
      'before.selfIntersections': 0, 'before.components': 2,
      'after.tris': 12, 'after.pinchVerts': 0, 'after.watertight': true,
      'after.selfIntersections': 0, 'after.components': 2,
      'counts.pinchVertsSplit': 1,
      'gate.blocked': '',
      'triDelta': 0, 'volumeDelta': approx(-25.180563933319718, 1e-9)
    }
  },
  {
    name: '2-sheet pinch, TIGHT angle — gate blocks 0->12, file left unchanged',
    file: 'synth_pinch_2sheet_tight.stl',
    expect: {
      'ok': true, 'applied': false, 'declined': true,
      // the caller's own array comes straight back
      'unchanged': true,
      'before.tris': 20, 'before.pinchVerts': 1, 'before.watertight': true,
      'before.selfIntersections': 0,
      'after.tris': 20, 'after.pinchVerts': 1, 'after.selfIntersections': 0,
      'counts.pinchVertsSplit': 0,
      'gate.blocked': 'pinch-separate:selfInt 0->12',
      'triDelta': 0, 'volumeDelta': approx(0, 1e-9)
    }
  }
];

/* Two meshes already in the repo, used as real-geometry cases that run today.
 * box-20mm is the local stand-in for the 40921 no-op baseline. */
const REPO = [
  {
    name: 'repo box-20mm — clean mesh, true no-op',
    file: path.join(ROOT, 'fixtures', 'box-20mm.stl'),
    expect: {
      'ok': true, 'applied': false, 'declined': false,
      'unchanged': true,                      // same array object handed back
      'before.tris': 12, 'before.oddEdges': 0, 'before.watertight': true,
      'before.selfIntersections': 0,
      'after.tris': 12, 'after.watertight': true,
      'before.volume': approx(8000, 1e-9), 'after.volume': approx(8000, 1e-9),
      'counts.tJunctionSplits': 0, 'counts.weldedNear': 0,
      'triDelta': 0, 'volumeDelta': approx(0, 1e-12),
      'gate.blocked': ''
    }
  },
  {
    name: 'repo out-box-square-half — degenerate tri hiding a T-junction',
    file: path.join(ROOT, 'fixtures', 'out-box-square-half.stl'),
    expect: {
      'ok': true, 'applied': true,
      'before.tris': 20, 'before.degenerateTris': 1, 'before.watertight': true,
      'before.volume': approx(4000, 1e-9),
      // one triangle dropped, one split added: the count lands back on 20
      'after.tris': 20, 'after.degenerateTris': 0, 'after.watertight': true,
      'after.volume': approx(4000, 1e-9),
      'counts.degenerateRemoved': 1, 'counts.tJunctionSplits': 1,
      'triDelta': 0, 'volumeDelta': approx(0, 1e-12)
    }
  }
];

/* ------------------------------------------------------------------ *
 * Thingi10K cases.
 *
 * These three files are NOT in the repo. Outbound network in the build
 * environment is restricted to a short allowlist and thingiverse.com is not on
 * it, so they could not be fetched — see docs/NSO_Repair.md "Thingi10K
 * fixtures". The expectations below are transcribed from the ticket and have
 * NOT been verified against this implementation; they are marked provisional
 * and the runner says so rather than reporting a pass it did not earn.
 *
 * Drop 40921.stl / 37825.stl / 39644.stl into fixtures/repair/thingi10k/ and
 * these run with no other change.
 * ------------------------------------------------------------------ */
const THINGI_CASES = [
  {
    name: 'thingi10k 40921 — clean baseline, must be a no-op',
    file: path.join(THINGI, '40921.stl'),
    provisional: true,
    expect: {
      'ok': true, 'applied': false, 'unchanged': true,
      'before.watertight': true, 'after.watertight': true,
      'counts.tJunctionSplits': 0, 'counts.weldedNear': 0,
      'counts.degenerateRemoved': 0, 'counts.exactDuplicatesRemoved': 0,
      'counts.reversedDuplicatesRemoved': 0, 'counts.flapTrisRemoved': 0,
      'counts.holesFilled': 0, 'counts.pinchVertsSplit': 0,
      'triDelta': 0, 'volumeDelta': approx(0, 1e-9)
    }
  },
  {
    name: 'thingi10k 37825 — self-touching single sheet, out of scope, declines',
    file: path.join(THINGI, '37825.stl'),
    provisional: true,
    expect: {
      'ok': true, 'applied': false, 'unchanged': true, 'triDelta': 0,
      'volumeDelta': approx(0, 1e-9)
    }
  },
  {
    name: 'thingi10k 39644 — 3-sheet closed solid, gate blocks 0->9',
    file: path.join(THINGI, '39644.stl'),
    provisional: true,
    expect: {
      'ok': true, 'applied': false, 'unchanged': true,
      'gate.selfIntBefore': 0,
      'gate.blocked': 'pinch-separate:selfInt 0->9',
      'triDelta': 0, 'volumeDelta': approx(0, 1e-9)
    }
  }
];

/* ------------------------------------------------------------------ *
 * Tolerance-boundary cases. These turn the claims in docs/NSO_Repair.md into
 * assertions, so the documented numbers cannot quietly drift either.
 * ------------------------------------------------------------------ */

function cubeSoup(L) {
  const h = L / 2;
  const A = [-h, -h, -h], B = [h, -h, -h], C = [h, h, -h], D = [-h, h, -h];
  const E = [-h, -h, h], F = [h, -h, h], G = [h, h, h], H = [-h, h, h];
  const t = [];
  const q = (a, b, c, d) => { t.push(...a, ...b, ...c); t.push(...a, ...c, ...d); };
  q(A, D, C, B); q(E, F, G, H); q(A, B, F, E); q(C, D, H, G); q(A, E, H, D); q(B, C, G, F);
  return t;
}

function ulp32(x) {
  const e = Math.floor(Math.log2(Math.abs(x)));
  return Math.pow(2, e - 23);
}

/* WELD_TOL, two ways.
 *
 *   strict:   each copy of a shared corner is pushed one float32 ulp off, in
 *             opposite directions, so two copies disagree by two ulps. This is
 *             the worst realistic case — a corner arrived at by two different
 *             code paths. The weld holds while 2*ulp(coord) stays inside
 *             WELD_TOL and gives up the moment it does not, which lands exactly
 *             on a float32 binade boundary.
 *
 *   loaded:   copies that agree bit for bit, which is what a mesh read from an
 *             STL looks like. Nothing has to be tolerated, so this holds at
 *             every scale.
 */
function weldBoundary() {
  const SIGN = [1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, 1];
  const rows = {};
  for (const L of [20, 500, 1020, 1024, 2000, 10000]) {
    const jit = ulp32(L / 2);
    const raw = new Float32Array(cubeSoup(L).map((v, i) => v + SIGN[i % SIGN.length] * jit));
    const r = R.commit(raw).report;
    rows['weld.strict.L' + L] = (r.after && r.after.watertight && r.after.verts === 8) ? 'welded' : 'split';
  }
  for (const L of [20, 1024, 10000, 50000]) {
    const raw = new Float32Array(cubeSoup(L));
    const r = R.commit(raw).report;
    rows['weld.loaded.L' + L] = (r.after && r.after.watertight && r.after.verts === 8) ? 'welded' : 'split';
  }
  return rows;
}

/* SPLIT_EPS: the T-junction cube, scaled up and pushed through Float32Array at
 * each scale. The split must still fire and the volume must still come out
 * exact. */
function splitBoundary() {
  const rows = {};
  for (const L of [20, 500, 5000, 50000]) {
    const h = L / 2, M = [h, 0, h];
    const A = [-h, -h, -h], B = [h, -h, -h], C = [h, h, -h], D = [-h, h, -h];
    const E = [-h, -h, h], F = [h, -h, h], G = [h, h, h], H = [-h, h, h];
    const t = [];
    const q = (a, b, c, d) => { t.push(...a, ...b, ...c); t.push(...a, ...c, ...d); };
    const tr = (a, b, c) => t.push(...a, ...b, ...c);
    q(A, D, C, B); tr(E, F, M); tr(E, M, G); tr(E, G, H);
    q(A, B, F, E); q(C, D, H, G); q(A, E, H, D); q(B, C, G, F);
    const r = R.commit(new Float32Array(t)).report;
    rows['split.L' + L + '.splits'] = r.counts.tJunctionSplits;
    rows['split.L' + L + '.watertight'] = r.after.watertight;
    rows['split.L' + L + '.volExact'] = Math.abs(r.after.volume - L * L * L) / (L * L * L) < 1e-9;
  }
  return rows;
}

const TOLERANCE = [
  {
    name: 'WELD_TOL 1e-4 — float32 scale boundary',
    run: weldBoundary,
    expect: {
      /* |coord| < 512 mm: ulp is 3.05e-5, two of them 6.1e-5, inside WELD_TOL. */
      'weld.strict.L20': 'welded', 'weld.strict.L500': 'welded', 'weld.strict.L1020': 'welded',
      /* |coord| >= 512 mm: ulp doubles to 6.1e-5, two of them 1.22e-4, outside
       * it. The boundary is the float32 binade step, not a gradual fade. */
      'weld.strict.L1024': 'split', 'weld.strict.L2000': 'split', 'weld.strict.L10000': 'split',
      /* Bit-identical copies need no tolerance at all, at any size. */
      'weld.loaded.L20': 'welded', 'weld.loaded.L1024': 'welded',
      'weld.loaded.L10000': 'welded', 'weld.loaded.L50000': 'welded'
    }
  },
  {
    name: 'SPLIT_EPS 5e-3 — survives the Float32Array round-trip at every scale',
    run: splitBoundary,
    expect: {
      'split.L20.splits': 1, 'split.L20.watertight': true, 'split.L20.volExact': true,
      'split.L500.splits': 1, 'split.L500.watertight': true, 'split.L500.volExact': true,
      'split.L5000.splits': 1, 'split.L5000.watertight': true, 'split.L5000.volExact': true,
      'split.L50000.splits': 1, 'split.L50000.watertight': true, 'split.L50000.volExact': true
    }
  }
];

/* ------------------------------------------------------------------ *
 * Fail-safe cases. Whatever goes in, commit() must return rather than throw,
 * and must hand back the caller's own array when it cannot help.
 * ------------------------------------------------------------------ */
const FAILSAFE = [
  ['null input', null, { ok: false, unchanged: true }],
  ['undefined input', undefined, { ok: false, unchanged: true }],
  ['empty soup', new Float32Array(0), { ok: false, unchanged: true }],
  ['ragged soup (10 floats)', new Float32Array(10), { ok: false, unchanged: true }],
  ['non-array input', 'not a mesh', { ok: false, unchanged: true }],
  ['NaN coordinate', 'NAN', { ok: false, unchanged: true }],
  ['Infinite coordinate', 'INF', { ok: false, unchanged: true }]
];

/* ------------------------------------------------------------------ *
 * Compare + report
 * ------------------------------------------------------------------ */

let failures = [];
let missing = [];
let passed = 0;
let provisionalSkipped = 0;

function cmp(caseName, actual, expected) {
  const bad = [];
  for (const key of Object.keys(expected)) {
    const want = expected[key];
    const got = actual[key];
    let ok;
    if (want && typeof want === 'object' && '__approx' in want) {
      ok = typeof got === 'number' && Math.abs(got - want.__approx) <= want.tol;
    } else {
      ok = got === want;
    }
    if (!ok) {
      const w = (want && typeof want === 'object' && '__approx' in want)
        ? '~' + want.__approx + ' (+/-' + want.tol + ')' : JSON.stringify(want);
      bad.push('    ' + key + ': expected ' + w + ', got ' + JSON.stringify(got));
    } else if (VERBOSE) {
      console.log('    ok  ' + key + ' = ' + JSON.stringify(got));
    }
  }
  if (bad.length) {
    failures.push(caseName + '\n' + bad.join('\n'));
    console.log('  FAIL  ' + caseName);
    console.log(bad.join('\n'));
  } else {
    passed++;
    console.log('  ok    ' + caseName);
  }
}

function runFixtureCase(c) {
  const file = path.isAbsolute(c.file) ? c.file : path.join(FX, c.file);
  if (!fs.existsSync(file)) {
    const label = c.name + '  [file not in tree: ' + path.relative(ROOT, file) + ']';
    if (c.provisional) {
      provisionalSkipped++;
      console.log('  MISS  ' + label);
      console.log('        expectations are transcribed from the ticket and unverified;');
      console.log('        drop the file in and this case runs as written.');
    } else {
      console.log('  MISS  ' + label);
    }
    missing.push(path.relative(ROOT, file));
    return;
  }
  if (c.provisional) {
    console.log('  note  ' + c.name + ' — expectations are PROVISIONAL (from the ticket,');
    console.log('        never yet run against this module). A failure here may mean the');
    console.log('        module is wrong OR that the transcribed number is.');
  }
  const raw = readSTL(file);
  const result = R.commit(raw);
  let actual = observe(raw, result);
  if (c.extra) actual = Object.assign(actual, c.extra(raw, result));
  const expected = Object.assign({}, c.expect, c.expectExtra || {});
  cmp(c.name, actual, expected);
}

function main() {
  console.log('NSO_Repair regression suite');
  console.log('module: ' + R.VERSION + '   WELD_TOL=' + R.WELD_TOL + '   SPLIT_EPS=' + R.SPLIT_EPS);
  console.log('');

  console.log('synthetic fixtures');
  SYNTHETIC.forEach(runFixtureCase);

  console.log('');
  console.log('repo meshes');
  REPO.forEach(runFixtureCase);

  console.log('');
  console.log('thingi10k fixtures');
  THINGI_CASES.forEach(runFixtureCase);

  console.log('');
  console.log('tolerance boundaries');
  for (const c of TOLERANCE) cmp(c.name, c.run(), c.expect);

  console.log('');
  console.log('fail-safe');
  for (const [label, input, want] of FAILSAFE) {
    let inp = input;
    if (input === 'NAN') { inp = readSTL(path.join(ROOT, 'fixtures', 'box-20mm.stl')); inp[0] = NaN; }
    if (input === 'INF') { inp = readSTL(path.join(ROOT, 'fixtures', 'box-20mm.stl')); inp[1] = Infinity; }
    let res;
    try {
      res = R.commit(inp);
    } catch (e) {
      failures.push(label + '\n    commit() threw: ' + e.message);
      console.log('  FAIL  ' + label + ' — commit() threw: ' + e.message);
      continue;
    }
    cmp(label, { ok: res.ok, unchanged: res.rawTris === inp }, want);
  }

  console.log('');
  console.log('----------------------------------------------------------');
  console.log(passed + ' passed, ' + failures.length + ' failed, ' + missing.length + ' fixture(s) missing');

  if (missing.length) {
    console.log('');
    console.log('missing fixtures:');
    for (const m of missing) console.log('  ' + m);
    console.log('see fixtures/repair/thingi10k/README.md for how to supply these.');
  }

  if (failures.length) {
    console.log('');
    console.log('FAILED — ' + failures.length + ' case(s) drifted from the documented numbers.');
    return 1;
  }
  if (missing.length && !SKIP_MISSING) {
    console.log('');
    console.log('INCOMPLETE — every case that could run passed, but ' + missing.length +
                ' fixture(s) are absent, so the suite did not verify them.');
    console.log('Re-run with --skip-missing to accept that as a pass.');
    return 2;
  }
  console.log('');
  console.log('PASS' + (missing.length ? ' (' + missing.length + ' fixture(s) skipped)' : ''));
  return 0;
}

process.exit(main());
