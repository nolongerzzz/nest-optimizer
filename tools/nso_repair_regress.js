#!/usr/bin/env node
/* Standing regression gate for NSO_Repair.
 *
 *   node tools/nso_repair_regress.js              # run everything
 *   node tools/nso_repair_regress.js -v           # print every checked value
 *   node tools/nso_repair_regress.js --skip-missing
 *                                                 # treat an absent fixture as a
 *                                                 # pass instead of exit 2
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
  for (const side of ['before', 'after', 'rejected']) {
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
 * Thingi10K cases. All three MEASURED against this module on the real files.
 *
 * Two of the three expectations originally transcribed from the ticket did not
 * survive contact with the data. What the files actually are:
 *
 *   40921 is NOT a clean baseline. It is two shells meeting at 17 bowtie
 *   vertices, and the proof is arithmetic: Euler characteristic V-E+F is -13
 *   as it stands, and an odd characteristic is impossible for any closed
 *   orientable surface. Splitting the 17 bowties gives exactly 4 = two spheres,
 *   and takes self-intersections from 5 to 0. The ticket's "clean, watertight"
 *   reading comes from an edge-based check - the repo's own
 *   tools/stl_watertight_check.py calls this file OK - and an edge count cannot
 *   see a vertex pinch. So this is a repair case, not a no-op case.
 *
 *   37825 and 39644 decline, exactly as the ticket says, though 39644 is
 *   stopped by the odd-edge gate rather than the self-intersection gate. See
 *   docs/NSO_Repair.md for why the 0->9 figure is not reproduced.
 * ------------------------------------------------------------------ */
const THINGI_CASES = [
  {
    /* Two shells joined at 17 bowtie vertices. The repair separates them and
     * the result is two clean spheres: 186 triangles in, 186 out, 17 new
     * vertices, self-intersections 5 -> 0. Volume moves 0.19% because each of
     * the 34 vertex copies is nudged off the contact point; that is the cost of
     * the separation, not an error. */
    name: 'thingi10k 40921 — two shells at 17 bowties, separated',
    file: path.join(THINGI, '40921.stl'),
    expect: {
      'ok': true, 'applied': true, 'declined': false, 'unchanged': false,
      'before.tris': 186, 'before.verts': 80, 'before.oddEdges': 0,
      'before.watertight': true, 'before.components': 2,
      'before.pinchVerts': 17, 'before.selfIntersections': 5,
      'before.volume': approx(9551.05247151165, 1e-9),
      'after.tris': 186, 'after.verts': 97, 'after.oddEdges': 0,
      'after.watertight': true, 'after.components': 2,
      'after.pinchVerts': 0, 'after.selfIntersections': 0,
      'after.volume': approx(9371.584480469384, 1e-9),
      'counts.pinchVertsSplit': 17, 'counts.holesFilled': 0,
      'counts.tJunctionSplits': 0, 'counts.degenerateRemoved': 0,
      'gate.blocked': '',
      'triDelta': 0, 'volumeDelta': approx(-179.46799104226557, 1e-9)
    },
    /* Euler characteristic is the whole argument for this case, so assert it
     * rather than leaving it in a comment. Also assert the repair settles:
     * a second pass must find nothing. */
    extra(raw, result) {
      const b = R.inspect(raw, { selfIntersections: false });
      const a = R.inspect(result.rawTris, { selfIntersections: false });
      const second = R.commit(result.rawTris);
      return {
        'euler.before': b.verts - b.uniqueEdges + b.tris,
        'euler.after': a.verts - a.uniqueEdges + a.tris,
        'idempotent.applied': second.report.applied,
        'idempotent.unchanged': second.rawTris === result.rawTris
      };
    },
    expectExtra: {
      'euler.before': -13,   // odd: impossible for a closed orientable surface
      'euler.after': 4,      // two spheres
      'idempotent.applied': false,
      'idempotent.unchanged': true
    }
  },
  {
    /* One sheet touching itself along a single 4-use edge. Separating it opens
     * a slit, and the only way to close that slit is to bridge a neck at a
     * width nobody specified — 0.1 mm here, straight out of NUDGE_FRAC. Hole
     * fill refuses to close a seam this repair opened itself, the slit stays
     * open, and the odd-edge gate then discards the whole thing. Declining is
     * the correct result: see docs/NSO_Repair.md "37825". */
    name: 'thingi10k 37825 — self-touching single sheet, out of scope, declines',
    file: path.join(THINGI, '37825.stl'),
    expect: {
      'ok': true, 'applied': false, 'declined': true, 'unchanged': true,
      'before.tris': 162, 'before.nonManifoldEdges': 1, 'before.oddEdges': 1,
      'before.components': 1, 'before.pinchVerts': 2,
      'before.selfIntersections': 0,
      'before.volume': approx(30322.464647864635, 1e-9),
      // after === before: the caller gets the input back untouched
      'after.tris': 162, 'after.oddEdges': 1, 'after.pinchVerts': 2,
      'after.volume': approx(30322.464647864635, 1e-9),
      // what was thrown away: the slit, 1 open loop, 4 odd edges
      'rejected.oddEdges': 4, 'rejected.openEdges': 4,
      'rejected.boundaryLoops': 1, 'rejected.components': 1,
      'gate.blocked': 'final:oddEdges',
      'triDelta': 0, 'volumeDelta': approx(0, 1e-12)
    }
  },
  {
    /* A closed solid with an internal partition wall attached along a 30x30
     * rectangle of 4 three-use edges — the "3-sheet closed solid". Separating
     * the sheets detaches the wall, which takes one solid to three and opens 8
     * odd edges. The gate discards it and the file is returned untouched. */
    name: 'thingi10k 39644 — 3-sheet closed solid, gate blocks, file unchanged',
    file: path.join(THINGI, '39644.stl'),
    expect: {
      'ok': true, 'applied': false, 'declined': true, 'unchanged': true,
      'before.tris': 290, 'before.nonManifoldEdges': 4, 'before.oddEdges': 4,
      'before.components': 1, 'before.pinchVerts': 4,
      'before.selfIntersections': 0,
      'before.volume': approx(26322.32738959441, 1e-9),
      'after.tris': 290, 'after.oddEdges': 4, 'after.components': 1,
      'after.volume': approx(26322.32738959441, 1e-9),
      // what was thrown away: one solid taken to three, 8 odd edges,
      // and 7.1% of the volume with it
      'rejected.components': 3, 'rejected.oddEdges': 8,
      'rejected.openEdges': 8, 'rejected.tris': 292,
      'gate.blocked': 'final:oddEdges',
      'triDelta': 0, 'volumeDelta': approx(0, 1e-12)
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
    console.log('  MISS  ' + c.name + '  [file not in tree: ' + path.relative(ROOT, file) + ']');
    missing.push(path.relative(ROOT, file));
    return;
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
