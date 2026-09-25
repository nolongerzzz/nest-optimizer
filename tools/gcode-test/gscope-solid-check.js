#!/usr/bin/env node
/*
 * G-scope "Export as solid" - the headless half. No browser.
 *
 *  1. RUNS. The parser's `run` numbering breaks on exactly the things that
 *     stop a bead (travel, wipe, retraction, Z move, G92 reposition) and on
 *     nothing else (F-only lines, M-codes, FEATURE tags, E-only primes, G92 E,
 *     an arc's chords). A synthetic file with one of each.
 *  2. CHAINS. `chainsOf` caps where a run starts, where a selection skips a
 *     move, and nowhere else.
 *  3. THE CLOSED SWEEP. `NSO_PathSweep.sweepClosed` on a square loop: no caps,
 *     closed, 2-manifold, volume = section x centreline exactly; a twisted
 *     space loop is refused by name.
 *  4. REAL SLICES. Both committed `.gcode.3mf` files, every move: every shell
 *     closed, 2-manifold, consistently wound, positive; solid volume equals the
 *     toolpath view's volume plus the counted seam closures; every forced split
 *     is a named sweep refusal.
 *  5. CANONICAL CHECKER. tools/mesh_validate.py --gate on the exported solid:
 *     a single run PASSES where the same moves as toolpath prisms FAIL; a
 *     sample of shells from every feature passes one by one; a whole stacked
 *     selection has no open edges and no piercing pairs.
 *
 * Run: node tools/gcode-test/gscope-solid-check.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const G = require('../../nso-gcode-lines.js');
const SO = require('../../nso-gcode-solid.js');
const S = require('../../nso_path_sweep.js');

const REPO = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
function ok(cond, what) {
  if (cond) { pass++; console.log('  ok   ' + what); } else { fail++; console.log('  FAIL ' + what); }
}
function section(t) { console.log('\n' + t); }

// --- mesh helpers, independent of the builder --------------------------------

function soupVolume(t) { return SO.signedVolume(t, 0, t.length); }

/** Exact-coordinate edge audit of ONE closed shell: open, non-manifold, winding. */
function edgeAudit(t) {
  const key = (i) => t[i] + ',' + t[i + 1] + ',' + t[i + 2];
  const dir = new Map();
  for (let o = 0; o < t.length; o += 9) {
    const v = [key(o), key(o + 3), key(o + 6)];
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3];
      const k = a + '|' + b;
      dir.set(k, (dir.get(k) || 0) + 1);
    }
  }
  let open = 0, nonManifold = 0, winding = 0;
  for (const [k, n] of dir) {
    const [a, b] = k.split('|');
    const back = dir.get(b + '|' + a) || 0;
    if (n > 1) winding++;
    if (back === 0) open++;
    else if (n + back > 2) nonManifold++;
  }
  return { open, nonManifold, winding };
}

function writeSTL(soup, file) {
  const n = soup.length / 9, b = Buffer.alloc(84 + n * 50);
  b.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) b.writeFloatLE(soup[t * 9 + k], 84 + t * 50 + 12 + k * 4);
  fs.writeFileSync(file, b);
}

function validate(file) {
  let out;
  try {
    out = execFileSync('python3', [path.join(REPO, 'tools', 'mesh_validate.py'), file, '--json'],
      { encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (e) { out = e.stdout; }
  const r = JSON.parse(out);
  const si = r.self_intersection || {};
  return { open: r.open_edges, nm: r.nonmanifold_edges, winding: r.inconsistent_winding_edges,
           degen: r.degenerate_tris, pierce: si.pierce || 0, coplanar: si.coplanar || 0,
           volume: r.signed_volume, verdict: r.verdict };
}

// ===========================================================================
section('1. Runs - where the parser says the bead stops');
// ===========================================================================
{
  const gc = [
    '; filament_diameter = 1.75', 'M83', 'G90',
    '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; LAYER_HEIGHT: 0.2',
    'G1 X0 Y0 Z0.2 F3000',
    '; FEATURE: Outer wall',
    'G1 X10 Y0 E0.5',              // 0 run A
    'G1 F1200',                    //   feed only - not a stop
    'M106 S255',                   //   fan - not a stop
    'G1 X10 Y10 E0.5',             // 1 run A
    '; FEATURE: Inner wall',       //   feature tag - not a stop
    'G1 X0 Y10 E0.5',              // 2 run A
    'G1 E0.1',                     //   E-only prime - not a stop
    'G92 E0',                      //   E reset - not a stop
    'G2 X0 Y0 I0 J-5 E0.8',        // 3.. run A (arc chords, still one bead)
    'G1 X5 Y5 F9000',              //   travel -> stop
    'G1 X6 Y5 E0.05',              // run B
    'G1 E-0.8',                    //   retract -> stop
    'G1 X7 Y5 E0.05',              // run C
    'G1 X8 Y5 E-0.4',              //   wipe (moves while retracting) -> stop
    'G1 X9 Y5 E0.05',              // run D  (starts at 8,5)
    'G1 Z0.6',                     //   Z hop -> stop
    'G1 Z0.2',
    'G1 X10 Y5 E0.05',             // run E
    'G92 X20',                     //   reposition -> stop
    'G1 X21 Y5 E0.05',             // run F
  ].join('\n');
  const p = G.parseGcode(gc);
  const runs = p.moves.map((m) => m.run);
  const arcMoves = p.moves.filter((m) => m.index >= 3 && m.run === p.moves[0].run).length;
  ok(runs.slice(0, 3).every((r) => r === runs[0]), 'feed / fan / FEATURE / prime / G92 E do not break a run');
  ok(arcMoves > 1 && p.moves.slice(0, 3 + arcMoves).every((m) => m.run === runs[0]),
     'an arc\'s ' + arcMoves + ' chords are the same run as the lines before it');
  const distinct = [...new Set(runs)];
  ok(distinct.length === 6, 'six runs: A, then one per travel / retract / wipe / Z hop / G92 X (got ' + distinct.length + ')');
  ok(JSON.stringify(p.meta.runBreaks) === JSON.stringify({ travel: 1, retract: 2, zmove: 1, reposition: 1 }),
     'breaks counted by cause: ' + JSON.stringify(p.meta.runBreaks));
  ok(p.meta.runCount === 6, 'meta.runCount = 6');
  const arcEnd = p.moves[2 + arcMoves];
  ok(arcEnd.x1 === 0 && arcEnd.y1 === 0, 'an arc\'s last chord ends ON the commanded point (0, 0), bit for bit');

  // chains
  const all = SO.chainsOf(p.moves);
  ok(all.length === 6 && all[0].startedBy === 'first' && all.slice(1).every((c) => c.startedBy === 'run'),
     'chainsOf: one chain per run, each after the first started by a real stop');
  const gap = SO.chainsOf(p.moves.filter((m) => m.index !== 1));
  ok(gap.length === 7 && gap[1].startedBy === 'selection', 'a selection that skips a move caps the bead there, labelled "selection"');
  ok(SO.chainsOf(p.moves.slice().reverse()).length === 6, 'chainsOf sorts: print order, whatever order the selection came in');
}

// ===========================================================================
section('2. The closed sweep');
// ===========================================================================
{
  const prof = [[-0.1, -0.2], [0.1, -0.2], [0.1, 0.2], [-0.1, 0.2]];     // h 0.2, w 0.4
  const sq = [[0, 0, 0.1], [10, 0, 0.1], [10, 10, 0.1], [0, 10, 0.1]];
  const r = S.sweepClosed({ points: sq, profile: prof, up: [0, 0, 1] });
  ok(r.ok && r.closed, 'a square loop sweeps closed');
  const a = edgeAudit(r.tris);
  ok(a.open === 0 && a.nonManifold === 0 && a.winding === 0, 'no caps, and still closed and 2-manifold: ' + JSON.stringify(a));
  ok(r.tris.length / 9 === 2 * 4 * 4, '32 triangles: 4 walls x 2 per segment, no cap triangles');
  const v = soupVolume(r.tris);
  ok(Math.abs(v - 0.08 * 40) < 1e-5, 'volume = section 0.08 x centreline 40 = 3.2 exactly (got ' + v.toFixed(9) + ')');
  ok(r.stats.holonomy < 1e-12, 'a flat loop brings its frame home: holonomy ' + r.stats.holonomy.toExponential(2));
  const twisted = S.sweepClosed({ points: [[0, 0, 0], [10, 0, 0], [10, 10, 5], [0, 10, -3]], profile: prof });
  ok(!twisted.ok && /does not close its frame/.test(twisted.reason), 'a twisted space loop is refused by name, not forced: ' + (twisted.reason || '').slice(0, 60) + '...');
  const tight = S.sweepClosed({ points: [[0, 0, 0], [10, 0, 0], [10, 0.3, 0], [0, 0.3, 0]], profile: prof, up: [0, 0, 1] });
  ok(!tight.ok && tight.failAt && tight.failAt.segment != null, 'a loop narrower than its bead is refused with failAt ' + JSON.stringify(tight.failAt));
  const openR = S.sweep({ points: sq.concat([sq[0]]), profile: prof, up: [0, 0, 1] });
  ok(openR.ok && Math.abs(soupVolume(openR.tris) - v) < 1e-5,
     'the same loop swept OPEN encloses the same volume (the mitre is volume-neutral; the caps only meet)');
}

// ===========================================================================
section('3. Real slices - every move');
// ===========================================================================
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gscope-solid-'));
const slices = {};
(async () => {
  for (const name of ['supportwithinsupport', 'tabletop']) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(REPO, 'fixtures', '3mf', name + '.gcode.3mf')));
    const res = await G.readSlicedGcode3MF(bytes);
    const p = res.parsed;
    slices[name] = p;
    const t0 = Date.now();
    const b = SO.buildSolid(p.moves);
    const ms = Date.now() - t0;
    const st = b.stats;
    console.log('  ' + name + ': ' + p.moves.length + ' moves, ' + p.meta.runCount + ' runs ' +
                JSON.stringify(p.meta.runBreaks) + ' -> ' + st.chains + ' chains, ' + st.shells + ' shells (' +
                st.closedLoops + ' seam-closed, ' + st.forcedSplits.length + ' forced splits), ' + ms + ' ms');
    ok(st.moves === p.moves.length, name + ': every move is in the solid');
    ok(st.starts.discontinuous === 0, name + ': the parser\'s runs are geometrically continuous (0 discontinuous joins)');
    ok(st.starts.run === p.meta.runCount - 1, name + ': a chain starts exactly where a run does (' + st.starts.run + ' + first)');
    let bad = 0, neg = 0;
    for (const sh of b.shells) {
      const t = b.positions.subarray(sh.triStart * 9, (sh.triStart + sh.triCount) * 9);
      const a = edgeAudit(t);
      if (a.open || a.nonManifold || a.winding) bad++;
      if (!(sh.volume > 0)) neg++;
    }
    ok(bad === 0, name + ': all ' + b.shells.length + ' shells closed, 2-manifold, consistently wound (' + bad + ' not)');
    ok(neg === 0, name + ': every shell encloses positive volume (outward normals)');
    const rel = Math.abs(st.solidVolume - st.expectedVolume) / st.expectedVolume;
    ok(rel < 1e-5, name + ': solid volume ' + st.solidVolume.toFixed(4) + ' = section x centreline ' +
       st.expectedVolume.toFixed(4) + ' (rel ' + rel.toExponential(2) + ', float32 storage)');
    const id = Math.abs(st.expectedVolume - (st.toolpathVolume + st.seamAddedMm3)) / st.expectedVolume;
    ok(id < 1e-9, name + ': = toolpath-view volume ' + st.toolpathVolume.toFixed(4) + ' + seam closures ' +
       st.seamAddedMm3.toFixed(4) + ' exactly (rel ' + id.toExponential(2) + ')');
    ok(st.forcedSplits.every((f) => /miter has eaten|doubles back|crosses itself/.test(f.reason)),
       name + ': every forced split is a named sweep refusal, never an unexplained cut');
    ok(st.droppedSteps === 0, name + ': no step dropped for being under the float32 floor');
  }

  // =========================================================================
  section('4. Canonical checker - tools/mesh_validate.py');
  // =========================================================================
  const p = slices.supportwithinsupport;
  const inner = p.moves.filter((m) => m.feature === 'Inner wall');
  const loop = SO.chainsOf(inner)[5].moves;
  const one = SO.buildSolid(loop);
  const fOne = path.join(TMP, 'one-run.solid.stl'), fPr = path.join(TMP, 'one-run.prisms.stl');
  writeSTL(one.positions, fOne);
  writeSTL(G.buildLineGeometry(loop).positions, fPr);
  const vOne = validate(fOne), vPr = validate(fPr);
  console.log('  one Inner wall run, solid : ' + JSON.stringify(vOne));
  console.log('  same moves as prisms      : ' + JSON.stringify(vPr));
  ok(vOne.verdict === 'PASS' && vOne.open === 0 && vOne.nm === 0 && vOne.pierce === 0,
     'one continuous run exported as solid PASSES the full gate (open 0, non-manifold 0, pierce 0)');
  ok(vPr.verdict === 'FAIL' && vPr.pierce > 0,
     'the same moves as per-move prisms FAIL it (' + vPr.pierce + ' piercing pairs at the corners) - what the sweep fixes');
  ok(Math.abs(vOne.volume - vPr.volume) / vPr.volume < 1e-3,
     'and hold the same material: ' + vOne.volume.toFixed(4) + ' vs ' + vPr.volume.toFixed(4) +
     ' mm^3 (difference = the seam closure, ' + one.stats.seamAddedMm3.toFixed(4) + ')');

  // One shell of every kind, from every feature: closed loops, open runs, the
  // pieces of a forced split.
  const all = SO.buildSolid(p.moves);
  const byKind = new Map();
  all.shells.forEach((sh, i) => {
    const k = sh.feature + (sh.closed ? ' closed' : ' open');
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(i);
  });
  const splitMoves = new Set(all.stats.forcedSplits.map((f) => f.moveIndex));
  const splitShell = all.shells.findIndex((sh) => sh.moveIds.some((id) => splitMoves.has(id)));
  const sample = [];
  for (const [, ids] of byKind) sample.push(ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]);
  if (splitShell >= 0) sample.push(splitShell);
  const uniq = [...new Set(sample)];
  let passN = 0;
  const fails = [];
  uniq.forEach((i) => {
    const sh = all.shells[i];
    const f = path.join(TMP, 'shell-' + i + '.stl');
    writeSTL(all.positions.subarray(sh.triStart * 9, (sh.triStart + sh.triCount) * 9), f);
    const r = validate(f);
    if (r.verdict === 'PASS') passN++; else fails.push(sh.feature + '#' + i + ' ' + JSON.stringify(r));
  });
  console.log('  sampled ' + uniq.length + ' shells over ' + byKind.size + ' feature/kind groups: ' + passN + ' PASS');
  fails.forEach((f) => console.log('    ' + f));
  ok(passN === uniq.length, 'every sampled shell, alone, PASSES the full gate - including a piece of a forced split');

  // Then EVERY shell of the file, through the same validator in one Python
  // process (its own validate(), default gate, nothing re-implemented).
  const dirAll = path.join(TMP, 'all');
  fs.mkdirSync(dirAll);
  all.shells.forEach((sh, i) => writeSTL(all.positions.subarray(sh.triStart * 9, (sh.triStart + sh.triCount) * 9),
    path.join(dirAll, String(i).padStart(5, '0') + '.stl')));
  const py = [
    'import sys, json, pathlib',
    'sys.path.insert(0, ' + JSON.stringify(path.join(REPO, 'tools')) + ')',
    'import mesh_validate as mv',
    'fails = []',
    'files = sorted(pathlib.Path(' + JSON.stringify(dirAll) + ').glob("*.stl"))',
    'for f in files:',
    '    r = mv.validate(f, mv.WELD_TOL, 100.0, True, mv.SELFINT_EPS)',
    '    if r["verdict"] != "PASS": fails.append([f.name, r["verdict_fails"]])',
    'print(json.dumps({"n": len(files), "fails": fails}))',
  ].join('\n');
  const batch = JSON.parse(execFileSync('python3', ['-c', py], { encoding: 'utf8', maxBuffer: 64 << 20 }));
  batch.fails.slice(0, 5).forEach((f) => console.log('    ' + JSON.stringify(f)));
  ok(batch.n === all.shells.length && batch.fails.length === 0,
     'ALL ' + batch.n + ' shells of supportwithinsupport, one by one, PASS the full gate (' + batch.fails.length + ' fail)');

  // A stacked selection: 45 Inner wall loops, one per layer, touching face to face.
  const stack = SO.buildSolid(inner);
  const fSt = path.join(TMP, 'inner-stack.solid.stl');
  writeSTL(stack.positions, fSt);
  const vSt = validate(fSt);
  console.log('  45 stacked Inner wall loops: ' + JSON.stringify(vSt));
  ok(vSt.open === 0 && vSt.degen === 0 && vSt.pierce === 0,
     'a stacked multi-run selection: open 0, degenerate 0, pierce 0 - watertight, nothing passes through anything');
  ok(vSt.nm > 0,
     'and its non-manifold edges are where one layer\'s bead sits on the next (' + vSt.nm + '): separate shells touching, which is what the beads are - merging them would be the union this does not do');

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n' + (fail ? 'FAIL' : 'PASS') + '  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
