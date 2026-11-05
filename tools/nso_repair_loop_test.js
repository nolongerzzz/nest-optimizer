#!/usr/bin/env node
/* repair:loop - the check -> fix loop, headless.
 *
 *   node tools/nso_repair_loop_test.js        exit 0 = every gate held
 *
 * nso_patch.js is held to the canonical checker (tools/mesh_validate.py) on STLs written from its
 * output, and the fix the Findings card chooses is held to the geometry of each finding. The page
 * itself (the buttons, Undo, the re-scan) is tools/nso_findings_drive_check.js.
 *
 *   1. LOOPS. Every open loop is found, with the right edge count; a flat rim is told from a curved
 *      one by its flatness (the slab that holds it, 0.05 mm).
 *   2. PATCH. fixtures/damage/shape-sphere_hole.stl: one row, PATCH; after: 0 open edges, manifold,
 *      wound one way, canonical PASS; every triangle the piece had kept byte for byte; the fill's
 *      rim normals match the neighbours' within 5 degrees (and a flat cap's do not - the measure
 *      must tell them apart); the fill lies on the sphere it was cut from.
 *   3. FIX ALL. shape-sphere_holes-shredded: one item per cluster, each PATCH; every item run in
 *      order leaves 0 open edges, 0 non-manifold, 0 mis-wound.
 *   4. BRIDGE. shape-tube_severed (a closed C): one advisory item, BRIDGE; after, one closed tube
 *      (a single shell, Euler 0, canonical PASS), the slot's volume back. shape-tube_severed-apart,
 *      two slots, bridged one after the other: one closed tube.
 *      thin_shell_cup(_thin): the two rims are one BRIDGE pair; after, one closed shell.
 *   5. CAP. A flat-topped box with a hole in the lid (fixtures/repair/box_lid_hole.stl): CAP; the
 *      cap lies in the lid's plane, the volume is the whole box's.
 *   6. THICKEN OUT. thin_shell_cup_thin: the mm that reaches two nozzle widths, filled in.
 *   7. damage.json. Every file's counts before are the ones the generator promised, and each fix
 *      the card chooses brings its own count to 0.
 *   8. THE CHOICE ITSELF, on every fixture: flat rim CAP, curved rim PATCH, a pair BRIDGE, no clean
 *      loop REPAIR (whole piece), thin THICKEN OUT. (nso_findings_test.js pins the rows; this pins
 *      that the fix then does what its button says.)
 *   9. MERGE SHELLS. library/box_closed.stl: "2 overlapping shells, 74 piercing pairs", one MERGE SHELLS
 *      item; after the merge (nso_csg.js NSO_shellMergeCore, the verbs' own) 0 piercing pairs and a
 *      canonical PASS. A lid with a triangle gone cannot be merged (the card offers no MERGE SHELLS for an open
 *      piece, and the merge itself says so in words); contact is not overlap.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./nso_repair_loop_lib.js');

const W = L.engine(), P = W.NSO_Patch, D = W.NSO_Defects, F = W.NSO_Findings;
let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) pass++; else fail++;
  if (!cond || process.env.VERBOSE) console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
}
const items = (soup) => { const r = D.locate(soup, {}); return { r, rows: F.rows(r, F.group(r)) }; };
const flat = rows => [].concat(...rows.map(x => (x.items || []).map(i => Object.assign({ rowKind: x.kind, advisory: !!x.advisory }, i))));

console.log('repair:loop - nso_patch.js and the card\'s choice of fix\n');

/* ------------------------------------------------------------------ 1. loops */
console.log('1. loops');
{
  const hole = L.soupOf('damage/shape-sphere_hole.stl'), loops = P.loops(hole);
  ok(loops.length === 1 && loops[0].n === 7 && loops.unclosed === 0, 'sphere_hole: one loop of 7 edges', JSON.stringify(loops.map(l => l.n)));
  const d = P.describe(hole, loops[0]);
  ok(!d.planar && d.planarMm > 0.05 && d.planarMm < 0.07, 'its rim is curved: flatness ' + d.planarMm.toFixed(4) + ' mm against the 0.05 mm limit');
  const lid = L.soupOf('repair/box_lid_hole.stl'), ll = P.loops(lid);
  const built = require('./nso_repair_loop_fixtures.js').boxLidHole();
  ok(built.length === lid.length && L.sameBytes(built, lid), 'fixtures/repair/box_lid_hole.stl is what tools/nso_repair_loop_fixtures.js builds', built.length / 9 + ' tris');
  ok(ll.length === 1 && ll[0].n === 22 && P.describe(lid, ll[0]).planar && P.describe(lid, ll[0]).planarMm === 0, 'box lid: one flat loop of 22 edges');
  const shred = L.soupOf('damage/shape-sphere_holes-shredded.stl'), sl = P.loops(shred);
  ok(sl.reduce((a, l) => a + l.n, 0) === 221 && sl.unclosed === 0, 'shredded: the loops hold every one of the 221 open edges', sl.map(l => l.n).join('+'));
  ok(sl.every((l, i) => l.id === i), 'loop ids are the places in the list');
  const flap = L.soupOf('repair/synth_flap.stl');
  ok(P.loops(flap).length === 0 && P.loops(flap).unclosed === 1, 'synth_flap: the free sides are no closed loop, and it says so');
}

/* ------------------------------------------------------------------ 2. PATCH */
console.log('2. PATCH on shape-sphere_hole');
{
  const hole = L.soupOf('damage/shape-sphere_hole.stl'), { r, rows } = items(hole);
  const its = flat(rows);
  ok(rows.length === 1 && rows[0].kind === 'open' && its.length === 1 && its[0].fix === 'patch' && its[0].fixLabel === 'PATCH',
     'one row, one item, the button reads PATCH', JSON.stringify(its.map(i => i.fixLabel)));
  ok(/^Hole, curved rim$/.test(its[0].text), 'in plain words: ' + its[0].text);
  const res = L.applyItem(W, hole, its[0]);
  ok(res.ok, 'the fix ran', res.reason);
  const topo = P.topology(res.soup);
  ok(topo.open === 0 && topo.nm === 0 && topo.badWinding === 0 && topo.degenerate === 0, 'after: 0 open edges, manifold, wound one way',
     JSON.stringify(topo));
  ok(topo.shells === 1 && topo.euler === 2, 'one closed shell, Euler 2');
  ok(L.sameBytes(res.soup, hole, hole.length), 'every triangle the piece had is kept byte for byte');
  const can = L.canonical(res.soup, 'hole_patch');
  ok(can.open === 0 && can.nm === 0 && can.winding === 0 && can.pierce === 0 && can.verdict === 'PASS', 'tools/mesh_validate.py: PASS', JSON.stringify(can));
  const steps = L.rimNormalSteps(P, res.soup, hole.length / 9);
  ok(steps.length === 7 && steps[steps.length - 1] <= 5, 'the fill\'s rim normals match the neighbours within 5 degrees',
     'worst ' + steps[steps.length - 1].toFixed(2) + ' over ' + steps.length + ' rim vertices');
  const capSteps = L.rimNormalSteps(P, P.cap(hole, [0]).soup, hole.length / 9);
  ok(capSteps[capSteps.length - 1] > 5, 'a flat cap does not (worst ' + capSteps[capSteps.length - 1].toFixed(2) + ' degrees) - so the measure tells them apart');
  // the fill lies on the sphere it was cut from: radius 4.822, centre (0, 0, 4.822)
  let dev = 0;
  for (let t = hole.length / 9; t < res.soup.length / 9; t++) for (let k = 0; k < 3; k++) {
    const o = t * 9 + k * 3;
    dev = Math.max(dev, Math.abs(Math.hypot(res.soup[o], res.soup[o + 1], res.soup[o + 2] - 4.822) - 4.822));
  }
  ok(dev < 0.01, 'the fill lies on the sphere it was cut from, within ' + dev.toFixed(4) + ' mm');
  ok(res.filled[0].method === 'fitted surface' && res.filled[0].curved, 'by the fitted surface (the same rule as Lift 3\'s repair fill)', res.filled[0].method);
  const again = P.patch(hole, [0]);
  ok(L.sameBytes(again.soup, res.soup) && again.soup.length === res.soup.length, 'the same piece gives the same bytes twice');
  const bad = P.patch(hole, [7]);
  ok(!bad.ok && /no open loop/.test(bad.reason), 'a loop that is not there is refused in words', bad.reason);
}

/* ------------------------------------------------------------------ 3. Fix all */
console.log('3. Fix all on shape-sphere_holes-shredded');
{
  const shred = L.soupOf('damage/shape-sphere_holes-shredded.stl'), { rows } = items(shred);
  const its = flat(rows);
  ok(its.length === 2 && its.every(i => i.fix === 'patch'), 'one item per cluster, each PATCH', its.map(i => i.fixLabel).join(','));
  ok(rows[0].title === '2 holes, 221 open edges', 'the row still says what the check counted', rows[0].title);
  const all = L.fixAllLoops(W, shred);
  ok(all.steps.length === 2 && all.steps.every(s => s.ok), 'every item ran', all.steps.map(s => s.ok + (s.reason ? ':' + s.reason : '')).join(' '));
  const topo = P.topology(all.soup);
  ok(topo.open === 0 && topo.nm === 0 && topo.badWinding === 0, 'after: 0 open edges, manifold, wound one way', JSON.stringify(topo));
  ok(L.sameBytes(all.soup, shred, shred.length), 'the piece\'s own 1015 triangles are kept byte for byte');
  const can = L.canonical(all.soup, 'shred_all');
  ok(can.open === 0 && can.nm === 0 && can.winding === 0 && can.degenerate === 0, 'tools/mesh_validate.py: 0 open, 0 non-manifold, 0 mis-wound',
     JSON.stringify(can));
  console.log('     (reported, not gated: ' + can.pierce + ' piercing pairs where a fill crosses a neighbouring fragment; ' + can.verdict + ')');
  const first = all.steps[0].before, second = all.steps[1].before;
  ok(first.openEdges === 221 && second.openEdges < 221 && second.openEdges > 0, 'each fix took its own cluster: 221 open, then ' + second.openEdges);
}

/* ------------------------------------------------------------------ 4. BRIDGE */
console.log('4. BRIDGE');
{
  const tube = L.soupOf('damage/shape-tube_severed.stl'), { r, rows } = items(tube);
  const its = flat(rows);
  ok(r.verdict === 'PASS' && rows.length === 1 && rows[0].kind === 'gap' && rows[0].advisory && its.length === 1,
     'a severed tube passes Check and has one advisory row', rows.map(x => x.kind).join(','));
  ok(its[0].fix === 'bridge' && its[0].fixLabel === 'BRIDGE' && /^Gap 1\.0 mm between two faces$/.test(its[0].text), 'one item, reading BRIDGE: ' + its[0].text);
  const before = P.topology(tube), res = L.applyItem(W, tube, its[0]);
  ok(res.ok, 'the fix ran', res.reason);
  const topo = P.topology(res.soup);
  ok(topo.open === 0 && topo.nm === 0 && topo.badWinding === 0 && topo.shells === 1 && topo.euler === 0,
     'after: one closed tube (one shell, Euler ' + before.euler + ' -> ' + topo.euler + ')', JSON.stringify(topo));
  const can = L.canonical(res.soup, 'tube_bridge');
  ok(can.verdict === 'PASS' && can.euler === 0 && can.pierce === 0 && can.open === 0 && can.nm === 0, 'tools/mesh_validate.py: PASS, genus 1', JSON.stringify(can));
  const dv = can.volume - L.canonical(tube, 'tube_before').volume;
  ok(Math.abs(dv - 1.0 * 1.3805 * 11.0979) < 0.6, 'the slot\'s volume is back: ' + dv.toFixed(3) + ' mm3 (slot 1.0 x 1.38 x 11.10)');
  ok(D.locate(res.soup, {}).gaps.length === 0, 'and Check finds no gap left');

  const apart = L.soupOf('damage/shape-tube_severed-apart.stl');
  ok(P.topology(apart).shells === 2 && D.locate(apart, {}).gaps.length === 2, 'two slots: two bodies, two gaps');
  let s = apart, steps = 0;
  for (let g = 0; g < 4; g++) {
    const { rows: rr } = items(s), it = flat(rr).find(i => i.fix === 'bridge');
    if (!it) break;
    const o = L.applyItem(W, s, it);
    if (!o.ok) break;
    s = o.soup; steps++;
  }
  const t2 = P.topology(s);
  ok(steps === 2 && t2.shells === 1 && t2.euler === 0 && t2.open === 0 && t2.nm === 0, 'bridged one after the other: one closed ring (2 steps, Euler 0)', JSON.stringify(t2));

  for (const f of ['open/thin_shell_cup.stl', 'open/thin_shell_cup_thin.stl']) {
    const cup = L.soupOf(f), rr = items(cup).rows, it = flat(rr).filter(i => i.fix === 'bridge');
    ok(it.length === 1 && /^Gap 1\.2 mm between two edges$/.test(it[0].text), f + ': the two rims are one BRIDGE pair', it.map(i => i.text).join(';'));
    const o = L.applyItem(W, cup, it[0]), t3 = P.topology(o.soup);
    ok(o.ok && t3.open === 0 && t3.nm === 0 && t3.badWinding === 0 && t3.shells === 1 && t3.euler === 2, f + ': after, one closed shell', JSON.stringify(t3));
    ok(L.canonical(o.soup, 'cup').open === 0, f + ': canonical sees no open edge');
  }
  // two pipe ends are not a pair: they face away from each other
  const pipe = (() => {
    const out = [], n = 24, R = 5, r2 = 4, H = 6;
    const pt = (rad, a, z) => [rad * Math.cos(a), rad * Math.sin(a), z];
    for (let i = 0; i < n; i++) {
      const a0 = 2 * Math.PI * i / n, a1 = 2 * Math.PI * (i + 1) / n;
      const q = (A, B, C, Dd) => out.push(...A, ...B, ...C, ...A, ...C, ...Dd);
      q(pt(R, a0, 0), pt(R, a1, 0), pt(R, a1, H), pt(R, a0, H));        // outer wall
      q(pt(r2, a0, 0), pt(r2, a0, H), pt(r2, a1, H), pt(r2, a1, 0));    // inner wall, reversed
    }
    return new Float32Array(out);
  })();
  const pr = P.plan(pipe);
  ok(P.loops(pipe).length === 4, 'an open pipe has four rims');
  ok(pr.pairs.length === 2 && pr.pairs.every(p => Math.abs(pr.loops[p.a].centre[2] - pr.loops[p.b].centre[2]) < 1e-6),
     'each end\'s two rims are a pair (the end is an annulus) and the pipe\'s two ends, facing away from each other, are not bridged together',
     JSON.stringify(pr.pairs.map(p => [p.a, p.b, p.kind])));
}

/* ------------------------------------------------------------------ 5. CAP */
console.log('5. CAP on a box with a hole in the lid');
{
  const lid = L.soupOf('repair/box_lid_hole.stl'), { r, rows } = items(lid), its = flat(rows);
  ok(r.openEdges === 22 && its.length === 1 && its[0].fix === 'cap' && its[0].fixLabel === 'CAP' && its[0].text === 'Hole, flat rim',
     'one row, the button reads CAP', JSON.stringify(its.map(i => i.fixLabel + ':' + i.text)));
  const res = L.applyItem(W, lid, its[0]), topo = P.topology(res.soup);
  ok(res.ok && topo.open === 0 && topo.nm === 0 && topo.badWinding === 0 && topo.shells === 1 && topo.euler === 2, 'after: closed, manifold', JSON.stringify(topo));
  const can = L.canonical(res.soup, 'lid_cap');
  ok(can.verdict === 'PASS' && Math.abs(can.volume - 24 * 24 * 12) < 1e-3, 'canonical PASS, volume ' + can.volume.toFixed(3) + ' = 24 x 24 x 12');
  let off = 0;
  for (let t = lid.length / 9; t < res.soup.length / 9; t++) for (let k = 0; k < 3; k++) off = Math.max(off, Math.abs(res.soup[t * 9 + k * 3 + 2] - 12));
  ok(off === 0, 'every cap corner is in the lid\'s plane (z = 12)', 'off by ' + off);
  ok(L.sameBytes(res.soup, lid, lid.length), 'the box\'s own triangles are kept byte for byte');
  const pat = P.patch(lid, [0]);
  ok(pat.ok && L.sameBytes(pat.soup, res.soup) && pat.soup.length === res.soup.length, 'Patch on a flat rim falls back to the same flat cap');
  // a cap faces out whichever way the hole faces: turn the box over
  const flip = new Float32Array(lid.length);
  for (let i = 0; i < lid.length; i += 3) { flip[i] = lid[i]; flip[i + 1] = lid[i + 1]; flip[i + 2] = 12 - lid[i + 2]; }
  for (let t = 0; t < flip.length / 9; t++) { for (let k = 0; k < 3; k++) { const a = t * 9 + 3 + k, b = t * 9 + 6 + k, x = flip[a]; flip[a] = flip[b]; flip[b] = x; } }
  const pf = P.cap(flip, [0]);
  ok(pf.ok && P.topology(pf.soup).open === 0 && P.topology(pf.soup).badWinding === 0, 'and a hole in the floor (facing down) is wound the right way too');
  // synth_hole: the cube's 3-edge hole
  const sh = L.soupOf('repair/synth_hole.stl'), shi = flat(items(sh).rows);
  ok(shi.length === 1 && shi[0].fix === 'cap', 'synth_hole (a missing triangle) is CAP');
  const so = L.applyItem(W, sh, shi[0]);
  ok(so.ok && P.topology(so.soup).open === 0 && P.topology(so.soup).badWinding === 0 && Math.abs(L.canonical(so.soup, 'synth').volume - 8000) < 1e-3, 'and the cube is whole again: volume 8000');
}

/* ------------------------------------------------------------------ 6. THICKEN OUT */
console.log('6. THICKEN OUT');
{
  const cup = L.soupOf('open/thin_shell_cup_thin.stl'), { r, rows } = items(cup);
  const t = flat(rows).find(i => i.fix === 'thickenOut');
  ok(t && t.fixLabel === 'THICKEN OUT' && t.scope === 'whole piece', 'the thin wall row offers THICKEN OUT', t && t.fixLabel);
  ok(t && t.mm === 0.56 && Math.abs(r.wall.minWallMm + t.mm - 0.8) < 0.01, 'with the mm that reaches two nozzle widths: ' + (t && t.mm) + ' (0.249 + 0.56 = 0.809)');
  const noThin = flat(items(L.soupOf('open/thin_shell_cup.stl')).rows).find(i => i.fix === 'thickenOut');
  ok(!noThin, 'a wall that is thick enough offers nothing');
}

/* ------------------------------------------------------------------ 7. damage.json */
console.log('7. every damage fixture: the promised counts before, the fix\'s own count 0 after');
{
  const dj = JSON.parse(fs.readFileSync(path.join(L.ROOT, 'fixtures', 'damage', 'damage.json'), 'utf8'));
  let n = 0;
  for (const e of dj.entries) {
    const soup = L.soupOf('damage/' + e.stl), r = D.locate(soup, {}), x = e.expected, tag = e.stl + ': ';
    n++;
    ok(r.soupTris === x.triangles && r.openEdges === x.open_edges && r.nonManifoldEdges === x.nonmanifold_edges &&
       r.flippedEdges === x.inconsistent_winding_edges && r.degenerateTris === x.degenerate_tris && r.pierce === x.piercing,
       tag + 'before: the counts damage.json promises', JSON.stringify({ tris: r.soupTris, open: r.openEdges, nm: r.nonManifoldEdges, wind: r.flippedEdges, pierce: r.pierce }));
    const rows = F.rows(r, F.group(r)), its = flat(rows);
    const loopFixes = its.filter(i => ['cap', 'patch', 'bridge'].includes(i.fix));
    if (!loopFixes.length) continue;
    const out = L.fixAllLoops(W, soup, { advisory: true }), topo = P.topology(out.soup), t2 = D.locate(out.soup, {});
    ok(out.steps.length > 0 && out.steps.every(s => s.ok), tag + 'every fix the card chose ran', out.steps.map(s => s.ok + (s.reason ? ':' + s.reason : '')).join(' '));
    ok(topo.open === 0 && topo.nm === 0 && topo.badWinding === 0, tag + 'after: 0 open, 0 non-manifold, 0 mis-wound', JSON.stringify(topo));
    ok(t2.openEdges === 0 && (t2.gaps || []).length === 0, tag + 'and Check finds no open edge or gap left');
    if (x.open_edges === 0) ok(topo.shells === 1 && topo.euler === 0, tag + 'one closed tube');
  }
  ok(n === dj.entries.length && n >= 12, 'all ' + n + ' damage entries were held to damage.json');
}

/* ------------------------------------------------------------------ 8. the choice */
console.log('8. the choice of fix, on every fixture that has a hole');
{
  const CASES = [
    ['damage/shape-sphere_hole.stl', ['patch']], ['damage/shape-sphere_hole-painted.stl', ['patch']],   // a flat RIM in a sphere: the surround curves, so PATCH (was CAP)
    ['damage/shape-sphere_holes-shredded.stl', ['patch', 'patch']], ['damage/shape-cylinder_holes-light.stl', ['cap', 'patch']],
    ['open/open_clip.stl', ['patch']], ['open/thin_shell_cup.stl', ['bridge']], ['repair/synth_hole.stl', ['cap']],
    ['repair/synth_tjunction.stl', ['cap']], ['repair/synth_flap.stl', ['sealRepair', 'sealRepair']], ['repair/box_lid_hole.stl', ['cap']]
  ];
  for (const [f, want] of CASES) {
    const got = flat(items(L.soupOf(f)).rows).map(i => i.fix);
    ok(JSON.stringify(got) === JSON.stringify(want), f + ': ' + got.join(', '), 'want ' + want.join(', '));
  }
  // every fix a loop item names is one the engine can run, on its own
  for (const f of ['damage/shape-cylinder_holes-light.stl', 'open/open_clip.stl', 'open/fabric_weave.stl']) {
    const soup = L.soupOf(f), out = L.fixAllLoops(W, soup), topo = P.topology(out.soup);
    ok(topo.open === 0 && topo.nm === 0 && topo.badWinding === 0, f + ': every item run leaves it closed and manifold', JSON.stringify(topo));
  }
}

/* ------------------------------------------------------------------ 9. MERGE SHELLS */
/* library/box_closed.stl is a tray and a lid slab laid through one another (74 piercing pairs). Check names it as
   overlapping shells with one MERGE SHELLS item; the fix is NSO_shellMergeCore (nso_csg.js, the shipped file, the
   same merge the boolean verbs make for their own operation) and after it the piece is one closed solid to the
   canonical checker. A shell that is itself open cannot be merged into a closed solid: the merge says so in words.
   A piece whose shells only touch, or that is one shell, gets no MERGE SHELLS. */
async function mergeShells() {
  console.log('9. MERGE SHELLS on library/box_closed.stl');
  const fsx = require('fs'), vm = require('vm');
  const { csgContext } = require('./nso_csg_node.js');
  const { readSTL } = require('./nso_stl_io.js');
  const K = csgContext();
  vm.runInContext(fsx.readFileSync(path.join(L.ROOT, 'NSO_Repair.js'), 'utf8'), K, { filename: 'NSO_Repair.js' });
  const box = new Float32Array(readSTL(path.join(L.ROOT, 'library', 'box_closed.stl')));
  const { r, rows } = items(box), its = flat(rows);
  const row = rows.find(x => x.kind === 'pierce');
  ok(r.pierce === 74 && r.shells === 2 && r.overlapShells === 2, 'the report: 74 piercing pairs, 2 shells, both overlapping',
     JSON.stringify({ pierce: r.pierce, shells: r.shells, overlapShells: r.overlapShells }));
  ok(row && /^2 overlapping shells, 74 piercing pairs - shells passing through each other$/.test(row.title), 'the row: ' + (row && row.title));
  const pi = (row && row.items) || [];
  ok(pi.length === 2 && pi[0].fix === 'mergeShells' && pi[0].fixLabel === 'MERGE SHELLS' && pi[0].scope === 'whole piece' &&
     its.filter(i => i.fix === 'mergeShells').length === 1, 'two items on the row, the first as it was: MERGE SHELLS, whole piece', JSON.stringify(its.map(i => i.fixLabel)));
  ok(pi[1] && pi[1].fix === 'splitShells' && pi[1].fixLabel === 'SPLIT SHELLS' && pi[1].scope === 'whole piece' && pi[1].manual === true &&
     its.filter(i => i.fix === 'splitShells').length === 1, 'and SPLIT SHELLS beside it, whole piece, never part of Fix all (shells-as-pieces)');
  const m = await K.NSO_shellMergeCore(box);
  ok(m.ok && m.shells === 2, 'the merge ran on 2 shells', m.reason);
  const after = items(m.soup);
  ok(after.r.pierce === 0 && after.r.overlapShells === 0 && after.r.openEdges === 0 && after.r.nonManifoldEdges === 0,
     'after: 0 piercing pairs, no overlapping shells, 0 open, 0 non-manifold',
     JSON.stringify({ pierce: after.r.pierce, overlap: after.r.overlapShells, open: after.r.openEdges, nm: after.r.nonManifoldEdges }));
  ok(!flat(after.rows).some(i => i.fix === 'mergeShells' || i.fix === 'splitShells'), 'and the card offers MERGE SHELLS and SPLIT SHELLS no more');
  const can = L.canonical(m.soup, 'merge_shells');
  ok(can.verdict === 'PASS' && can.pierce === 0 && can.open === 0 && can.nm === 0, 'canonical checker: PASS, 0 piercing, closed', JSON.stringify(can));
  ok(Math.abs(Math.abs(can.volume) - m.volumeMm3) < 1e-2 * m.volumeMm3, 'the solid\'s volume is the union\'s: ' + Math.abs(can.volume).toFixed(1) + ' mm3',
     String(m.volumeMm3));
  // unmendable: the lid slab with a triangle gone is no closed shell, so no closed solid can come of the merge
  const open = box.slice(0, box.length - 9);
  const ro = items(open);
  ok(ro.r.overlapShells === 2 && !flat(ro.rows).some(i => i.fix === 'mergeShells' || i.fix === 'splitShells'),
     'an open lid still counts as overlapping shells, but the row stays the plain piercing row (no MERGE SHELLS, no SPLIT SHELLS) until its hole is closed');
  const mo = await K.NSO_shellMergeCore(open);
  ok(!mo.ok && /^a shell is not closed, so there is no solid to merge/.test(mo.reason), 'its merge refuses in words: ' + mo.reason);
  // contact is not overlap: a mark standing on a bar's face
  const bx = (x0, y0, z0, x1, y1, z1) => { const vv = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]], F2 = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]], o = []; F2.forEach(f => f.forEach(i => o.push(...vv[i]))); return o; };
  const marked = new Float32Array(bx(0, 0, 0, 60, 10, 6).concat(bx(50, 7, 6, 58, 10, 9)));
  const rm = items(marked);
  ok(rm.r.overlapShells === 0 && !flat(rm.rows).some(i => i.fix === 'mergeShells' || i.fix === 'splitShells'), 'shells that only touch: no MERGE SHELLS, no SPLIT SHELLS',
     JSON.stringify({ pierce: rm.r.pierce, overlap: rm.r.overlapShells }));
}

mergeShells().catch(e => { ok(false, 'MERGE SHELLS threw', e && e.stack); }).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log(fail ? 'FAIL' : 'PASS');
  process.exit(fail ? 1 : 0);
});
