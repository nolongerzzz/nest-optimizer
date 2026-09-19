#!/usr/bin/env node
/* Curving-path sweep - the canonical checker, stage by stage.
 *
 * docs/HANDOFF.md: "Pass/fail is math: tools/stl_watertight_check.py --odd
 * --degen plus the geometry probes the current ticket names. Never call a mesh
 * correct from a screenshot." So every stage here is written to a real binary
 * STL, handed to that script as a separate process, and only then measured.
 *
 * The stages climb one step at a time on purpose - straight, then one bend,
 * then a bend at the edge of the gate, then a rounded corner, then many joints
 * in 3D, then the whole thing 1400 mm from the origin. A failure names the
 * first stage that broke rather than "the sweep is wrong".
 *
 * Run: node tools/nso_path_sweep_canonical_check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('./nso_path_sweep_testlib.js');
const { writeSTL } = require('./nso_stl_io.js');

const S = T.loadSweep();
const OUT = path.join(T.REPO, 'out', 'pathsweep');
const CHECKER = path.join(T.REPO, 'tools', 'stl_watertight_check.py');
const DEG = Math.PI / 180;

fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

function bendPath(deg, up, out) {
  const t = deg * DEG;
  return [[0, 0, 0], [0, up, 0], [out * Math.sin(t), up + out * Math.cos(t), 0]];
}

let python = null;
function canonical(file) {
  if (python === null) {
    for (const cand of ['python3', 'python']) {
      try { execFileSync(cand, ['--version'], { stdio: 'ignore' }); python = cand; break; } catch (e) { /* next */ }
    }
    if (python === null) {
      throw new Error('no python3 on PATH - the canonical checker IS tools/stl_watertight_check.py ' +
                      'and this suite is not allowed to substitute its own opinion for it');
    }
  }
  try {
    execFileSync(python, [CHECKER, file, '--odd', '--degen'], { stdio: 'pipe' });
    return { ok: true, out: '' };
  } catch (err) {
    return { ok: false, out: String(err.stdout || '') + String(err.stderr || '') };
  }
}

// ---------------------------------------------------------------------------
const STAGES = [
  {
    name: '1-straight',
    what: 'a 2-point path - the straight-line case the curve has to reduce to',
    points: [[0, 0, 0], [0, 30, 0]],
    profile: S.profileRegular(16, 2)
  },
  {
    name: '2-single-bend-45',
    what: 'one 45 degree bend - the controlled case',
    points: bendPath(45, 20, 20),
    profile: S.profileRegular(16, 2)
  },
  {
    name: '3-bend-150-roomy',
    what: 'a 150 degree bend with room for its miter',
    points: bendPath(150, 60, 60),
    profile: S.profileRegular(16, 3)
  },
  {
    name: '4-bend-150-near-gate',
    what: 'the same bend 2% inside the r*tan(turn/2) gate, where the inner wall nearly folds',
    points: bendPath(150, 3 * Math.tan(75 * DEG) * 1.02, 3 * Math.tan(75 * DEG) * 1.02),
    profile: S.profileRegular(16, 3)
  },
  {
    name: '5-arc-rounded-90',
    what: 'a 90 degree corner rounded into 8 arc chords - 9 joints in a row',
    points: null,
    build: () => {
      const sub = S.arcSubdivide(bendPath(90, 40, 40), { radius: 10, segments: 8 });
      if (!sub.ok) throw new Error(sub.reason);
      return sub.pts;
    },
    profile: S.profileRegular(20, 2)
  },
  {
    name: '6-space-path-9pt',
    what: '9 points out of plane - 7 mitred joints, none of them axis-aligned',
    build: () => {
      const pts = [];
      for (let i = 0; i < 9; i++) {
        const t = i / 8;
        pts.push([14 * Math.sin(t * 2.2), 46 * t, 10 * Math.sin(t * 3.4) - 4 * t]);
      }
      return pts;
    },
    profile: S.profileRegular(12, 1.5)
  },
  {
    name: '7-off-origin-1400',
    what: 'stage 2 again, 1400 mm from the origin, where float32 spacing is 1.2e-4 mm',
    points: bendPath(45, 20, 20).map(p => [p[0] + 1400, p[1] + 1400, p[2]]),
    profile: S.profileRegular(16, 2)
  },
  {
    name: '8-thin-section',
    what: 'a 0.4 mm section - one nozzle width, the size a support branch actually is',
    points: bendPath(60, 25, 25),
    profile: S.profileRegular(12, 0.2)
  }
];

console.log('== every stage, written to disk and handed to tools/stl_watertight_check.py ==\n');
console.log('  stage                     tris   verts   open  nonmf  odd  degen  euler       volume   A*L err   checker');
console.log('  ' + '-'.repeat(108));

for (const st of STAGES) {
  const pts = st.build ? st.build() : st.points;
  const r = S.sweep({ points: pts, profile: st.profile });
  if (!r.ok) { check(st.name + ' builds', false, r.reason); continue; }

  const file = path.join(OUT, st.name + '.stl');
  writeSTL(file, r.tris, 'NSO path sweep ' + st.name);

  const topo = T.topology(r.tris);
  const bad = T.solidFailures(topo);
  const want = r.stats.profileArea * r.stats.pathLength;
  const volErr = Math.abs(topo.volume - want) / want;
  const can = canonical(file);

  console.log('  ' + st.name.padEnd(24) +
    String(topo.tris).padStart(6) + String(topo.verts).padStart(8) +
    String(topo.open).padStart(7) + String(topo.nonManifold).padStart(7) +
    String(topo.odd).padStart(5) + String(topo.degenerate).padStart(7) +
    String(topo.euler).padStart(7) +
    topo.volume.toFixed(4).padStart(13) + volErr.toExponential(1).padStart(10) +
    '   ' + (can.ok ? 'clean' : 'FAILED'));

  check(st.name + ': ' + st.what, bad.length === 0 && can.ok && volErr < 1e-5,
        [bad.join('; '), can.ok ? '' : can.out.trim(), volErr < 1e-5 ? '' : 'volume off by ' + volErr.toExponential(2)]
          .filter(Boolean).join(' | '));
}

// ---------------------------------------------------------------------------
// A negative control. The checker has to be able to FAIL, or a clean row above
// means nothing: an earlier ticket in this repo shipped a browser check that
// passed for the wrong reason, and the lesson was to prove the gate bites.
console.log('\n== the checker is actually checking ==');
{
  const r = S.sweep({ points: bendPath(45, 20, 20), profile: S.profileRegular(16, 2) });
  const holed = r.tris.slice(0, r.tris.length - 9 * 3);   // drop three triangles
  const file = path.join(OUT, '9-negative-control.stl');
  writeSTL(file, holed, 'NSO path sweep negative control');
  const can = canonical(file);
  const topo = T.topology(holed);
  check('the same sweep with 3 triangles removed fails the canonical checker',
        !can.ok, topo.open + ' open edges, checker ' + (can.ok ? 'PASSED (wrong)' : 'refused'));
}

console.log('\nSTLs written to ' + path.relative(T.REPO, OUT) + '/');
console.log((fail ? 'FAIL' : 'PASS') + '  ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failed: ' + FAILS.join(' | ')); process.exit(1); }
