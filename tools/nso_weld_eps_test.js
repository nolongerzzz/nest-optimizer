#!/usr/bin/env node
// Regression test for NSO_weldEpsFor (app-join.js).
//
//   node tools/nso_weld_eps_test.js
//
// The bug: the cap was min(want, shortestEdge/3), and a minimum is an outlier
// statistic. Two 1.499e-5 edges out of 98,586 on the tape fixture pinned the
// whole mesh to 4.997e-6, and at that tolerance a sound part reads as open.
// Found independently three times (Manifold/repair, sculpt, CSG).
//
// Loads the shipped app-join.js function by slicing its source, so the browser
// file stays a classic script with no module idiom. Prints real numbers.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const { readSTL } = require(path.join(ROOT, 'tools/nso_stl_io.js'));

function sliceFn(file, name) {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  const start = lines.findIndex(l => l.startsWith('function ' + name + '('));
  if (start < 0) throw new Error(name + ' not found in ' + file);
  let depth = 0, seen = false, end = -1;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; seen = true; }
      else if (ch === '}') depth--;
    }
    if (seen && depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error(name + ' has no closing brace');
  return lines.slice(start, end + 1).join('\n');
}

const ctx = { Math, Map, Set, console, Float32Array, Float64Array, Int32Array, Uint8Array, isFinite };
vm.createContext(ctx);
for (const [f, n] of [
  ['app-join.js', 'NSO_weldEpsFor'],
  ['app-join.js', 'NSO_edgeStats'],
  ['app-finish.js', 'weldSoupVerts'],
  ['app-sculpt.js', 'NSO_buildAdjacency'],
]) vm.runInContext(sliceFn(f, n), ctx, { filename: f + ':' + n });
const { NSO_weldEpsFor, NSO_edgeStats, weldSoupVerts, NSO_buildAdjacency } = ctx;

// The rule as it shipped before the fix, kept so the test shows the delta.
function preFixRule(soup, want) {
  const n = (soup.length / 9) | 0;
  let minE = Infinity;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    for (let e = 0; e < 3; e++) {
      const a = o + e * 3, b = o + ((e + 1) % 3) * 3;
      const L = Math.hypot(soup[a] - soup[b], soup[a + 1] - soup[b + 1], soup[a + 2] - soup[b + 2]);
      if (L > 1e-9 && L < minE) minE = L;
    }
  }
  return isFinite(minE) ? Math.min(want, minE / 3) : want;
}

const TAPE = 'fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl';
let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ok    ' + label + (detail ? '  — ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  — ' + detail : '')); }
}

console.log('\nNSO_weldEpsFor — sliver-poisoned tolerance\n');

// ---------- 1. the fixture that exposed the bug ----------
const tape = readSTL(path.join(ROOT, TAPE));
const tris = s => (s.length / 9) | 0;
console.log('  ' + TAPE.replace(/^.*\//, '') + '  ' + tris(tape) + ' tris');

for (const want of [0.08, 0.22]) {
  const before = preFixRule(tape, want);
  const after = NSO_weldEpsFor(tape, want);
  console.log('\n  want=' + want + '   pre-fix ' + before.toExponential(4) + '   now ' + after.toExponential(4));
  ok(before < 1e-5, 'pre-fix rule really was sliver-poisoned', before.toExponential(4));
  // 2e-5..3e-4 is the window measured with NSO_buildAdjacency where this part
  // welds to V-E+F = 2, 0 open, 0 non-manifold.
  ok(after >= 2e-5 && after <= 3e-4, 'fixed rule lands in the part’s safe window', after.toExponential(4));

  const welded = weldSoupVerts(tape, after);
  const st = NSO_edgeStats(welded);
  ok(st.open === 0 && st.nm === 0, 'boolean pre-weld leaves it closed', 'open=' + st.open + ' nm=' + st.nm);
  ok(tris(welded) === tris(tape), 'and drops no triangles', tris(welded) + ' tris');

  const stBefore = NSO_edgeStats(weldSoupVerts(tape, before));
  ok(stBefore.open > 0, 'pre-fix tolerance did report false open edges', 'open=' + stBefore.open);
}

// Clustering welder agrees on the same part.
const adj = NSO_buildAdjacency(tape, { tol: NSO_weldEpsFor(tape, 0.08), rawTol: true });
console.log('');
ok(adj.ok && adj.openEdges === 0 && adj.nmEdges === 0
   && (adj.vertCount - adj.edgeCount + adj.triCount) === 2,
   'NSO_buildAdjacency at the fixed tolerance: V-E+F=2, 0 open, 0 nm',
   'V-E+F=' + (adj.vertCount - adj.edgeCount + adj.triCount) + ' open=' + adj.openEdges + ' nm=' + adj.nmEdges);

// ---------- 2. the guard the cap was written for still holds ----------
// Pervasive fine detail is a feature scale, not slivers: it must NOT be
// rejected, or the weld eats the piece's own geometry.
function fineGrid(edge, nx, ny) {           // nx*ny quads of side `edge`, split
  const out = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const x = i * edge, y = j * edge;
    out.push(x, y, 0, x + edge, y, 0, x, y + edge, 0);
    out.push(x + edge, y, 0, x + edge, y + edge, 0, x, y + edge, 0);
  }
  return new Float32Array(out);
}
console.log('');
const fine = fineGrid(0.034, 40, 40);       // the wrap1 0.034 mm case, 3200 tris
const fineEps = NSO_weldEpsFor(fine, 0.08);
// 1e-4 relative, not exact: the grid is a Float32Array, so i*edge round-trips
// through float32 and the measured edge differs from 0.034 by a few 1e-6.
ok(Math.abs(fineEps - 0.034 / 3) / (0.034 / 3) < 1e-4,
   'pervasive 0.034 mm detail still caps at edge/3, not at want',
   fineEps.toPrecision(8) + ' vs ' + (0.034 / 3).toPrecision(8));

// One sliver dropped into that same grid must not move the cap much.
const poisoned = new Float32Array(fine.length + 9);
poisoned.set(fine);
poisoned.set([0, 0, 5, 1.5e-5, 0, 5, 0, 1.5e-5, 5], fine.length);
const poisonedEps = NSO_weldEpsFor(poisoned, 0.08);
ok(poisonedEps > 1e-3,
   'one added sliver does not pin the grid (pre-fix would give 5.0e-6)',
   poisonedEps.toExponential(4) + ' vs pre-fix ' + preFixRule(poisoned, 0.08).toExponential(4));

// ---------- 3. small meshes are untouched ----------
// Under 1000 edges the sliver bound is zero, so the rule is the old rule.
console.log('');
let identical = 0, moved = [];
const stls = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.stl')) stls.push(p);
  }
})(path.join(ROOT, 'fixtures'));
for (const p of stls) {
  let s; try { s = readSTL(p); } catch (e) { continue; }
  if (!s || !s.length) continue;
  for (const want of [0.08, 0.22]) {
    const a = preFixRule(s, want), b = NSO_weldEpsFor(s, want);
    if (Math.abs(a - b) / Math.max(a, b) < 1e-9) identical++;
    else moved.push(path.basename(p) + ' want=' + want);
  }
}
ok(moved.every(m => m.startsWith('tape_on-edge')),
   'only the sliver fixture changes across fixtures/',
   identical + ' identical, ' + moved.length + ' moved: ' + (moved.join(', ') || 'none'));

// ---------- 4. fail-safe ----------
console.log('');
for (const [label, input] of [['null', null], ['undefined', undefined],
                              ['empty soup', new Float32Array(0)]]) {
  let r, threw = false;
  try { r = NSO_weldEpsFor(input, 0.08); } catch (e) { threw = true; }
  ok(!threw && r === 0.08, label + ' returns want unchanged', threw ? 'threw' : String(r));
}
// A soup whose every edge is degenerate has nothing to measure.
const degen = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]);
let dr, dthrew = false;
try { dr = NSO_weldEpsFor(degen, 0.08); } catch (e) { dthrew = true; }
ok(!dthrew && dr === 0.08, 'all-degenerate soup returns want unchanged', dthrew ? 'threw' : String(dr));

console.log('\n----------------------------------------------------------');
console.log(pass + ' passed, ' + fail + ' failed');
console.log(fail ? 'FAIL' : 'PASS');
process.exit(fail ? 1 : 0);
