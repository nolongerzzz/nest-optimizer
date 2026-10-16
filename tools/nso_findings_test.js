#!/usr/bin/env node
/* Findings, in node: nso-findings.js held to NSO_Defects' own report.
 *
 *   node tools/nso_findings_test.js       exit 0 = every assertion held
 *
 * nso-findings.js sorts the marks NSO_Defects.locate() returns into problems
 * (one per hole, one per patch of doubled edges, ...) and writes the card's
 * rows. Nothing in it may change a count, so this pins, on the damage, open
 * and repair fixtures:
 *
 *   1. CONSERVATION. Every marked edge and triangle lands in exactly one
 *      problem: the problems' counts sum to the report's marks, and no index
 *      is in two problems.
 *   2. THE PLACES ARE THE ONES THE GENERATORS MADE. The fixtures say how many
 *      places they broke (fixtures/damage/README.md, fixtures/open/README.md):
 *      5 duplicated patches, 32 weld collisions, 10 separate ribbons, one fin
 *      crossing 5 warps. The grouping must find exactly those, and a hole must
 *      be a boundary loop - except where two loops share a pinch vertex, which
 *      is one hole to look at and is pinned as such.
 *   3. THE ROWS SAY THE REPORT'S NUMBERS. Every count in a row title is the
 *      report's own field, the clean row appears exactly when the verdict is
 *      PASS, and a fault with no place to point at (winding, degenerate) is
 *      named rather than leaving a FAIL under an empty list.
 *   3b. THE FIX THAT FITS. Every finding is an item with the one fix chosen
 *      from its own geometry (nso_patch.js plan / gaps): a flat rim CAP, a
 *      curved rim PATCH, two openings or two end faces within twice the wall
 *      BRIDGE, anything that is no clean loop REPAIR (whole piece), a thin wall
 *      THICKEN OUT with the mm that reaches two nozzle widths. The gap between
 *      faces is advisory: it never moves a verdict and it is the only row on
 *      a piece that otherwise passes.
 *   4. NON-SOLID SCOPE. Flagged, the open row is declared - no fix button -
 *      and the clean row still shows; the grouping and the counts do not move.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readSTL } = require('./nso_stl_io.js');

const ROOT = path.join(__dirname, '..');

function loadBrowser() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  for (const f of ['NSO_Repair.js', 'nso_patch.js', 'nso-defects.js', 'nso-findings.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  }
  if (!sandbox.window.NSO_Findings) throw new Error('nso-findings.js did not attach to window');
  return sandbox.window;
}
const W = loadBrowser();
const D = W.NSO_Defects;
const F = W.NSO_Findings;

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) pass++;
  else fail++;
  if (!cond || process.env.VERBOSE) {
    console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + label + (detail !== undefined ? ' - ' + detail : ''));
  }
}

function soupOf(rel) {
  const s = readSTL(path.join(ROOT, 'fixtures', rel));
  const t = s.tris || s.soup || s;
  return t instanceof Float32Array ? t : new Float32Array(t);
}

/* The known places on every fixture. holes / nm / pierce / thin are the
   number of PROBLEMS; the report's own counts are asserted against the
   report, not against this table. `loops` is the report's boundaryLoops, and
   where holes < loops the reason is written next to it. */
const KNOWN = {
  'damage/shape-sphere_hole.stl':                { holes: 1, loops: 1, fixes: ['patch'] },
  'damage/shape-sphere_hole-painted.stl':        { holes: 1, loops: 1, fixes: ['cap'] },
  // "12 sites grown together ... 2 loops" in the README is the generator's
  // exact topology; the checker's loop walk splits them at 2 pinch vertices
  // into 4 cycles. Two holes to look at.
  'damage/shape-sphere_holes-shredded.stl':      { holes: 2, loops: 4, pinched: true, fixes: ['patch', 'patch'] },
  // "2 loops: one pinched at the cap centre" - the pinched one walks as two.
  'damage/shape-cylinder_holes-light.stl':       { holes: 2, loops: 3, pinched: true, fixes: ['cap', 'patch'] },
  'damage/shape-sphere_nm-duplicate.stl':        { nm: 1, fixes: ['sealRepair'] },
  'damage/shape-sphere_nm-duplicate-flipped.stl': { nm: 5, fixes: ['sealRepair'] },    // "5 patches (68 faces)"
  'damage/shape-torus_weld-collide.stl':         { nm: 1 },
  'damage/shape-torus_weld-shredded.stl':        { nm: 32 },   // "32 weld collisions"
  'damage/shape-sphere_winding-flip.stl':        { unplaced: true },
  'damage/shape-torus_weld-near.stl':            { clean: true },
  // A C: closed, so Check passes. The slot is two end faces looking at each
  // other, 1 mm apart across a 1.38 mm wall - one advisory gap, one BRIDGE.
  'damage/shape-tube_severed.stl':               { gaps: 1, gapOnly: true, fixes: ['bridge'] },
  'damage/shape-tube_severed-apart.stl':         { gaps: 2, gapOnly: true, fixes: ['bridge', 'bridge'] },
  'open/open_clip.stl':                          { holes: 1, loops: 1, fixes: ['patch'] },
  'open/open_clip_selfint.stl':                  { holes: 2, loops: 2, pierce: 1, fixes: ['patch', 'cap'] },
  // the two rims of a double-skinned shell, 1.2 mm apart: one pair, one BRIDGE
  'open/thin_shell_cup.stl':                     { holes: 2, loops: 2, fixes: ['bridge'] },
  'open/thin_shell_cup_thin.stl':                { holes: 2, loops: 2, thin: 1, fixes: ['bridge', 'thickenOut'] },
  'open/thin_shell_cup_selfint.stl':             { holes: 3, loops: 3, pierce: 1, fixes: ['bridge', 'cap'] },
  'open/thin_shell_cup_cracked.stl':             { holes: 3, loops: 3, nm: 3, pierce: 1, fixes: ['bridge', 'cap', 'sealRepair'] },
  'open/fabric_weave.stl':                       { holes: 10, loops: 10, fixes: Array(10).fill('patch') },  // ten separate ribbons
  'open/fabric_weave_selfint.stl':               { holes: 10, loops: 10, pierce: 5, thin: 5 }, // one weft through 5 warps
  'repair/synth_hole.stl':                       { holes: 1, loops: 1, fixes: ['cap'] },
  'repair/synth_tjunction.stl':                  { holes: 1, loops: 1, fixes: ['cap'] },
  'repair/synth_dup_exact.stl':                  { nm: 1 },
  'repair/synth_dup_reversed.stl':               { nm: 1 },
  // The flap's two free sides are open and its hinge is non-manifold; the
  // loop walk finds no closed cycle in two edges, so loops is 0 - one hole.
  'repair/synth_flap.stl':                       { holes: 1, loops: 0, nm: 1, fixes: ['sealRepair', 'sealRepair'] },
  'box-20mm.stl':                                { clean: true }
};

function members(problems) {
  const seen = new Set();
  let dup = 0, total = 0;
  for (const p of problems) for (const i of p.members) { total++; if (seen.has(i)) dup++; seen.add(i); }
  return { total, dup, seen };
}

console.log('findings - nso-findings.js against NSO_Defects\n');

for (const rel of Object.keys(KNOWN)) {
  const k = KNOWN[rel];
  const soup = soupOf(rel);
  const r = D.locate(soup, {});
  const P = F.group(r);
  console.log(rel);

  /* 1. conservation */
  const runs = { open: [r.marks.openEdges, 6], nonManifold: [r.marks.nonManifoldEdges, 6],
                 pierce: [r.marks.pierceTris, 9], thin: [r.marks.thinTris, 9] };
  for (const kind of F.KINDS.filter(x => x !== 'gap')) {
    const [flat, stride] = runs[kind];
    const n = flat.length / stride;
    const m = members(P[kind]);
    const sum = P[kind].reduce((a, p) => a + p.count, 0);
    ok(sum === n && m.total === n && m.seen.size === n && m.dup === 0,
       rel + ': every ' + kind + ' mark is in exactly one problem', n + ' marks, ' + sum + ' in problems, ' + m.dup + ' twice');
    ok(P[kind].every((p, i) => p.number === i + 1), rel + ': ' + kind + ' problems numbered 1..n');
    ok(P[kind].every((p, i) => i === 0 || P[kind][i - 1].count >= p.count),
       rel + ': ' + kind + ' biggest first');
    // each problem's centre is the middle of its own marks' box
    ok(P[kind].every(p => p.radius >= 0 && p.center.every((c, a) => c >= p.lo[a] - 1e-9 && c <= p.hi[a] + 1e-9)),
       rel + ': ' + kind + ' centres inside their own marks');
  }
  ok(P.gap.length === (r.gaps || []).length && P.gap.every((p, i) => p.number === i + 1 && p.count === 1),
     rel + ': one problem per gap', P.gap.length + ' for ' + (r.gaps || []).length);
  ok(P.gap.length === (k.gaps || 0), rel + ': gaps between faces', P.gap.length + ' (want ' + (k.gaps || 0) + ')');
  ok(r.marks.openEdges.length / 6 === r.openEdges, rel + ': report open edges = marked open edges');
  ok(r.marks.nonManifoldEdges.length / 6 === r.nonManifoldEdges, rel + ': report non-manifold = marked');

  /* 2. the places */
  ok(P.open.length === (k.holes || 0), rel + ': holes', P.open.length + ' (want ' + (k.holes || 0) + ')');
  ok(P.nonManifold.length === (k.nm || 0), rel + ': doubled/pinched places', P.nonManifold.length + ' (want ' + (k.nm || 0) + ')');
  ok(P.pierce.length === (k.pierce || 0), rel + ': piercing places', P.pierce.length + ' (want ' + (k.pierce || 0) + ')');
  ok(P.thin.length === (k.thin || 0), rel + ': thin places', P.thin.length + ' (want ' + (k.thin || 0) + ')');
  if (k.loops !== undefined) {
    ok(r.boundaryLoops === k.loops, rel + ': the report\'s boundary loops', r.boundaryLoops + ' (want ' + k.loops + ')');
    if (!k.pinched && k.loops > 0) ok(P.open.length === r.boundaryLoops, rel + ': one hole per boundary loop');
  }

  /* 3. the rows */
  const rows = F.rows(r, P);
  const byKind = Object.fromEntries(rows.map(x => [x.kind, x]));
  const has = kind => !!byKind[kind];
  ok(has('open') === r.openEdges > 0, rel + ': open row iff open edges');
  ok(has('nonManifold') === r.nonManifoldEdges > 0, rel + ': doubled/pinched row iff non-manifold edges');
  ok(has('pierce') === r.pierce > 0, rel + ': piercing row iff piercing pairs');
  ok(has('thin') === (r.wall.thinFaces > 0), rel + ': thin row iff thin faces');
  ok(has('clean') === (r.verdict === 'PASS' && !(r.gaps || []).length), rel + ': green row iff PASS and no gap', r.verdict);
  if (k.clean) ok(r.verdict === 'PASS' && rows.length === 1 && rows[0].kind === 'clean', rel + ': clean piece is one green row');
  if (k.gapOnly) {
    ok(r.verdict === 'PASS' && rows.length === 1 && rows[0].kind === 'gap' && rows[0].advisory, rel + ': a gap on a passing piece is the one advisory row',
       rows.map(x => x.kind).join(','));
  }
  ok(has('gap') === ((r.gaps || []).length > 0), rel + ': gap row iff gaps');
  if (k.fixes) {
    const fx = [].concat(...rows.map(x => (x.items || []).map(i => i.fix)));
    ok(JSON.stringify(fx) === JSON.stringify(k.fixes), rel + ': the fix chosen for each finding', JSON.stringify(fx) + ' (want ' + JSON.stringify(k.fixes) + ')');
    for (const row of rows) for (const it of (row.items || [])) {
      ok(it.fixLabel === F.FIX_LABEL[it.fix] || (it.fix === 'thickenOut' && it.fixLabel === 'THICKEN OUT'), rel + ': ' + it.fix + ' button reads ' + it.fixLabel);
      ok(/^[A-Z]/.test(it.text) && !/\n/.test(it.text), rel + ': ' + it.fix + ' item wording is plain', JSON.stringify(it.text));
    }
  }
  if (has('open')) {
    ok(byKind.open.title === P.open.length + ' hole' + (P.open.length === 1 ? '' : 's') + ', ' +
                            r.openEdges + ' open edge' + (r.openEdges === 1 ? '' : 's'),
       rel + ': open row title', JSON.stringify(byKind.open.title));
    ok(!byKind.open.declared && byKind.open.items.length > 0, rel + ': open row has an item per hole or pair');
    const covers = new Set([].concat(...byKind.open.items.map(i => i.problems)));
    ok(covers.size === P.open.length, rel + ': every hole is on exactly one item', covers.size + ' of ' + P.open.length);
  }
  if (has('nonManifold')) {
    ok(byKind.nonManifold.title.indexOf(r.nonManifoldEdges + ' doubled or pinched edge') >= 0 &&
       byKind.nonManifold.title.indexOf(P.nonManifold.length + ' place') === 0,
       rel + ': doubled/pinched row title', JSON.stringify(byKind.nonManifold.title));
    ok(byKind.nonManifold.items.length === 1 && byKind.nonManifold.items[0].fix === 'sealRepair' &&
       /whole piece/.test(byKind.nonManifold.items[0].text), rel + ': doubled/pinched row offers REPAIR and says whole piece');
  }
  if (has('pierce')) {
    ok(byKind.pierce.title.indexOf(r.pierce + ' piercing pair') >= 0, rel + ': piercing row title', JSON.stringify(byKind.pierce.title));
    ok(!byKind.pierce.items.length && /No tool/.test(byKind.pierce.handledBy), rel + ': piercing row has no button and says so');
  }
  if (has('thin')) {
    ok(byKind.thin.title.indexOf(r.wall.thinFaces + ' face') >= 0 &&
       byKind.thin.title.indexOf(r.wall.minWallMm.toFixed(3)) >= 0, rel + ': thin row title', JSON.stringify(byKind.thin.title));
    const ti = byKind.thin.items[0];
    ok(byKind.thin.items.length === 1 && ti.fix === 'thickenOut' && ti.mm > 0, rel + ': thin row offers THICKEN OUT with a mm', JSON.stringify(ti && ti.mm));
    ok(ti && Math.abs((r.wall.minWallMm + ti.mm) - F.TWO_LINES_MM) < 0.0101 && r.wall.minWallMm + ti.mm >= F.TWO_LINES_MM - 1e-9,
       rel + ': the mm reaches two nozzle widths (0.8)', r.wall.minWallMm.toFixed(3) + ' + ' + (ti && ti.mm) + ' = ' + (ti && (r.wall.minWallMm + ti.mm).toFixed(3)));
  }
  for (const row of rows) ok(row.meaning && /\.$/.test(row.meaning), rel + ': ' + row.kind + ' row has its sentence');
  const un = F.unplaced(r);
  if (k.unplaced) {
    ok(r.verdict === 'FAIL' && rows.length === 0 && un.length > 0,
       rel + ': a FAIL with nothing to ring is named, not an empty card', JSON.stringify(un));
  }
  ok((r.verdict === 'FAIL') === (rows.some(x => x.kind !== 'clean' && !x.declared && !x.advisory) || un.length > 0),
     rel + ': the card shows something wrong exactly when the verdict is FAIL');

  /* 4. non-solid */
  if (r.openEdges) {
    const rs = D.locate(soup, { nonSolid: true });
    const Ps = F.group(rs);
    const rowsS = F.rows(rs, Ps);
    const o = rowsS.find(x => x.kind === 'open');
    ok(o && o.declared && !o.items.length && /declared/.test(o.title), rel + ': flagged, the open row is declared with no button');
    ok(Ps.open.length === P.open.length && rs.openEdges === r.openEdges, rel + ': flagged, the openings are the same openings');
    ok(rowsS.some(x => x.kind === 'clean') === (rs.verdict === 'PASS' && !rs.gaps.length), rel + ': flagged, green row iff PASS', rs.verdict);
  }
}

/* The before/after sentence. */
console.log('\nbefore / after');
ok(F.beforeNow({ openEdges: 221 }, { openEdges: 0 }, 'open') === 'Before: 221 open edges. Now: 0.', 'the ticket\'s own sentence');
ok(F.beforeNow({ nonManifoldEdges: 1 }, { nonManifoldEdges: 0 }, 'nonManifold') === 'Before: 1 doubled or pinched edge. Now: 0.', 'singular');
ok(F.beforeNow({ wall: { thinFaces: 96 } }, { wall: { thinFaces: 96 } }, 'thin') === 'Before: 96 thin faces. Now: 96.', 'thin, unchanged');

/* Clustering on its own: two loops a hair apart are one problem, two loops
   further apart are two. */
console.log('\nclustering');
{
  const sq = (x, z) => [x, 0, z, x + 1, 0, z, x + 1, 0, z, x + 1, 0, z + 1, x + 1, 0, z + 1, x, 0, z + 1, x, 0, z + 1, x, 0, z];
  const near = F._clusterEdges(sq(0, 0).concat(sq(1.03, 0)), F.JOIN_EDGE);
  const far = F._clusterEdges(sq(0, 0).concat(sq(1.2, 0)), F.JOIN_EDGE);
  ok(near.length === 1, 'loops 0.03 mm apart are one hole', near.length);
  ok(far.length === 2, 'loops 0.2 mm apart are two holes', far.length);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
console.log(fail ? 'FAIL' : 'PASS');
process.exit(fail ? 1 : 0);
