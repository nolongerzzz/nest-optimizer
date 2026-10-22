#!/usr/bin/env node
/* The non-solid flag, pinned (docs/NON-SOLID.md).

   Three things this suite proves, on the fixtures in fixtures/open/ and on
   one of the skin samples:

     1. With the flag SET, every intentionally-open shape passes clean - the
        validator's gated verdict, the canonical watertight checker, and
        NSO_Repair.commit (which leaves the geometry alone instead of peeling
        strand ends and fanning rims shut).
     2. With the flag SET, every injected defect still fails: a fin through a
        floor, a fin through both walls of a cup, a weft woven through the
        warps, a wall dented under one extrusion line. The flag lifts the
        closure requirement and nothing else.
     3. Without the flag the same clean shapes fail on open edges and Repair
        modifies them - so the flag, and only the flag, is what unblocks them,
        and it is never inferred from the geometry.
     4. With the flag SET, a shape that is open on purpose AND carries real
        fixable defects is actually repaired, rather than having the whole
        repair thrown away by the odd-edge gate. Section 2b. Standing aside
        from closure never licensed the stages that keep running to leave the
        surface more open than they found it, and that is what used to
        happen: deleting a degenerate sliver unpairs its neighbours, and with
        hole fill skipped there was nothing left to put the seam back.

   Plus the paperwork the paint-scope suite pins for mask6: every consumer
   states NON-SOLID SCOPE in its own source and reads the flag through
   nsoNonSolid, so a consumer that re-derives intent from open-edge counts
   fails here before it ships. No browser; the wire test does the button.

   Run: node tools/nso_open_flag_test.js */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { readSTL, writeSTL, loadRepairModule } = require('./nso_stl_io.js');

const ROOT = path.resolve(__dirname, '..');
const FX = path.join(ROOT, 'fixtures', 'open');
const SKIN_A = path.join(ROOT, 'fixtures', 'skin-samples', 'skin_crosshatch_A.stl');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-open-flag-'));

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
/* docs/HANDOFF.md is a preamble and an index now; its sections are docs/handoff/*.md.
   The rule text these checks look for lives in one of them, so read them all. */
const readHandoff = () => ['docs/HANDOFF.md', ...fs.readdirSync(path.join(ROOT, 'docs', 'handoff')).sort().map(f => 'docs/handoff/' + f)]
  .map(read).join('\n');

/* ---- the validator, as a subprocess, the way CI and HANDOFF use it ---- */
function validate(file, flags) {
  const r = spawnSync('python3', [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json', '--gate'].concat(flags || []),
                      { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) throw r.error;
  let j = null;
  try { j = JSON.parse(r.stdout); } catch (e) { throw new Error('validator produced no JSON for ' + file + '\n' + r.stderr); }
  j.exit = r.status;
  return j;
}
function watertight(file, flags) {
  const r = spawnSync('python3', [path.join(ROOT, 'tools', 'stl_watertight_check.py'), file, '--odd', '--degen'].concat(flags || []),
                      { encoding: 'utf8' });
  return { exit: r.status, last: (r.stdout || '').trim().split('\n').slice(-1)[0] };
}
const fails = j => (j.verdict_fails || []).join('; ');

/* ---- 0. the fixtures are the ones the generator makes ---- */
console.log('== 0. fixtures/open is byte-identical to its generator ==');
{
  const r = spawnSync('node', [path.join(ROOT, 'tools', 'nso_open_make_fixtures.js'), '--check'], { encoding: 'utf8' });
  check('nso_open_make_fixtures.js --check exits 0', r.status === 0, (r.stdout || '').trim().split('\n').filter(l => /DRIFT/.test(l)).join(' '));
}

/* ---- 1. every consumer declares its scope and reads the flag ---- */
console.log('\n== 1. every consumer states NON-SOLID SCOPE in source and reads nsoNonSolid ==');
{
  const ROSTER = [
    { feature: 'Seal / Repair', file: 'app-finish.js',  reads: /nsoNonSolid\s*\(\s*m\s*\)/,
      standDown: /Seal stood down - ' \+ m\.name \+ ' is flagged non-solid/ },
    { feature: 'Smooth',        file: 'app-sculpt.js',  reads: /nsoNonSolid\s*\(\s*m\s*\)/,
      standDown: /over budget \(non-solid\)/ },
  ];
  for (const r of ROSTER) {
    const src = read(r.file);
    check(r.feature + ' (' + r.file + ') declares NON-SOLID SCOPE', /NON-SOLID SCOPE/.test(src));
    check('  ...and points at docs/NON-SOLID.md', /NON-SOLID SCOPE[\s\S]{0,200}?docs\/NON-SOLID\.md/.test(src));
    check('  ...and reads the flag through nsoNonSolid, not from edge counts', r.reads.test(src));
    check('  ...and carries its non-solid wording', r.standDown.test(src));
  }
  const rep = read('NSO_Repair.js');
  check('NSO_Repair.js declares NON-SOLID SCOPE', /NON-SOLID SCOPE/.test(rep));
  check('  ...and says the skip does not license leaving the surface more open',
        /seam-reclose[\s\S]{0,120}?closes only boundary this run opened/.test(rep));
  check('  ...takes opts.nonSolid and reports it', /nonSolid:\s*!!opts\.nonSolid/.test(rep));
  check('  ...skips exactly flap-peel, orphan-components and hole-fill',
        /note\('flap-peel', false, \{ skipped: 'nonSolid' \}\)/.test(rep) &&
        /note\('orphan-components', false, \{ skipped: 'nonSolid' \}\)/.test(rep) &&
        /note\('hole-fill', false, \{ skipped: 'nonSolid' \}\)/.test(rep));
  const flag = read('app-nonsolid.js');
  check('the model flag is set only by app-nonsolid.js (and restored by Undo)', /m\.nonSolid = on/.test(flag) &&
        !/\bm\.nonSolid\s*=/.test(read('app-finish.js') + read('app-sculpt.js') + read('app-join.js') + read('app-cut.js')));
  check('app-nonsolid.js never infers the flag from geometry', !/openEdges|open_edges|edgeStats|nsoSealScore|Watertight/.test(flag));
  check('index.html carries the checkbox and loads the module',
        /id="chk-non-solid"/.test(read('index.html')) && /app-nonsolid\.js/.test(read('index.html')));
  check('app-core undo knows nonSolidReplace', /entry\.type === 'nonSolidReplace'/.test(read('app-core.js')));
  const doc = read('docs/NON-SOLID.md');
  check('docs/NON-SOLID.md states the split', /still run/i.test(doc) && /skipped/i.test(doc) && /blanket bypass/i.test(doc));
  check('HANDOFF.md points at the rule', /docs\/NON-SOLID\.md/.test(readHandoff()));
}

/* ---- 2. NSO_Repair.commit with and without the flag ---- */
console.log('\n== 2. NSO_Repair.commit: the flag skips closure stages, keeps every defect gate ==');
const R = loadRepairModule(path.join(ROOT, 'NSO_Repair.js'));
const CLEAN = ['open_clip', 'thin_shell_cup', 'fabric_weave'];
const DEFECT = ['open_clip_selfint', 'thin_shell_cup_selfint', 'fabric_weave_selfint'];
for (const name of CLEAN) {
  const raw = readSTL(path.join(FX, name + '.stl'));
  const on = R.commit(raw, { nonSolid: true });
  const off = R.commit(raw);
  const c = on.report.counts;
  check(name + ': flag on -> no flap, orphan or hole work', c.flapTrisRemoved === 0 && c.orphanTrisRemoved === 0 && c.holesFilled === 0,
        JSON.stringify({ flap: c.flapTrisRemoved, orphan: c.orphanTrisRemoved, holes: c.holesFilled }));
  check(name + ': flag on -> open edges untouched', on.report.after.openEdges === on.report.before.openEdges,
        on.report.before.openEdges + ' -> ' + on.report.after.openEdges);
  check(name + ': flag on -> stages record why they stood aside',
        on.report.stages.filter(s => s.skipped === 'nonSolid').map(s => s.name).join(',') === 'flap-peel,orphan-components,hole-fill');
  check(name + ': flag on -> report carries nonSolid', on.report.nonSolid === true);
  check(name + ': flag on -> no self-intersections before or after', on.report.before.selfIntersections === 0 && on.report.after.selfIntersections === 0);
  // The hazard the flag exists for, kept visible: without it the same clean
  // shape is modified and reported as a success.
  const d = off.report.counts;
  check(name + ': flag OFF -> Repair alters the piece (the hazard, pinned)',
        off.report.applied === true && off.rawTris !== raw && (d.flapTrisRemoved > 0 || d.holesFilled > 0 || off.report.gate.blockedStages.length > 0),
        'flap ' + d.flapTrisRemoved + ', holes ' + d.holesFilled + ', gated ' + off.report.gate.blockedStages.join('|'));
}
for (const name of DEFECT) {
  const raw = readSTL(path.join(FX, name + '.stl'));
  const on = R.commit(raw, { nonSolid: true });
  check(name + ': flag on -> the pierce is measured, not hidden',
        on.report.before.selfIntersections > 0 && on.report.after.selfIntersections === on.report.before.selfIntersections,
        on.report.before.selfIntersections + ' -> ' + on.report.after.selfIntersections);
  const c = on.report.counts;
  check(name + ': flag on -> nothing peeled to make the pierce disappear', c.flapTrisRemoved === 0 && c.orphanTrisRemoved === 0);
}
{
  // Both final gates are untouched by the flag: a repair that would ADD a
  // self-intersection is still rolled back. synth_pinch_2sheet_tight is the
  // repo's own gated case; with the flag it must gate exactly the same way.
  const raw = readSTL(path.join(ROOT, 'fixtures', 'repair', 'synth_pinch_2sheet_tight.stl'));
  const on = R.commit(raw, { nonSolid: true });
  check('gated pinch case still gated with the flag on', on.rawTris === raw && /pinch-separate:selfInt/.test(on.report.gate.blockedStages.join(',')),
        on.report.gate.blockedStages.join('|'));
  // and a real hole in a real solid, flagged non-solid by mistake, is left
  // open rather than filled - the flag is the user's call, so it is honoured.
  const hole = readSTL(path.join(ROOT, 'fixtures', 'repair', 'synth_hole.stl'));
  const h = R.commit(hole, { nonSolid: true });
  check('synth_hole with the flag on is left open (user\'s call, honoured)', h.report.after.openEdges === 3 && h.report.counts.holesFilled === 0);
  const h2 = R.commit(hole);
  check('synth_hole without the flag is filled as before', h2.report.after.openEdges === 0 && h2.report.counts.holesFilled === 1);
}

/* ---- 2b. open ON PURPOSE and defective AT THE SAME TIME ---- */
/* The case the other fixtures cannot make: standing aside from closure must
 * not turn into standing aside from repair. thin_shell_cup_cracked is the cup,
 * still open at its two rims by design, carrying the defects a scan-derived
 * shell actually arrives with - 12 zero-area sliver stitches over T-junctions,
 * 3 reversed duplicate faces, and the same fin thin_shell_cup_selfint uses.
 *
 * Six of the twelve stitches are cut at 4e-4 of their edge, inside the margin
 * the T-junction split refuses to work in, so deleting those slivers leaves
 * six three-edge cracks that no later stage can re-stitch. Until this was
 * fixed, those 18 edges of the repair's OWN damage reached the final odd-edge
 * gate, which correctly read the piece as more open than it arrived and threw
 * away every genuine repair with them: odd 109 -> 118, applied false, file
 * returned untouched, with 9 non-manifold edges still in it.
 *
 * Every number below is measured, and the open-edge count is the load-bearing
 * one: 100 in, 100 out. The piece's own boundary - two 48-edge rims and the
 * fin's 4 - is bit-for-bit what the user handed over. */
console.log('\n== 2b. thin_shell_cup_cracked: open by design AND repairable, both at once ==');
{
  const raw = readSTL(path.join(FX, 'thin_shell_cup_cracked.stl'));
  const before = R.inspect(raw);
  check('fixture arrives open by design (2 rims + the fin) AND defective',
        before.openEdges === 100 && before.boundaryLoops === 3 && before.nonManifoldEdges === 9 &&
        before.degenerateTris === 12 && before.selfIntersections === 7,
        JSON.stringify({ open: before.openEdges, loops: before.boundaryLoops, nm: before.nonManifoldEdges,
                         degen: before.degenerateTris, pierce: before.selfIntersections }));

  const on = R.commit(raw, { nonSolid: true });
  const q = on.report, c = q.counts;
  check('flag on -> the repair is APPLIED, not discarded by the odd-edge gate',
        q.applied === true && q.declined === false && on.rawTris !== raw, q.reason);
  check('flag on -> odd edges FALL, they do not rise',
        q.gate.oddAfter < q.gate.oddBefore, q.gate.oddBefore + ' -> ' + q.gate.oddAfter);
  check('flag on -> the piece\'s own openings come back untouched',
        q.after.openEdges === q.before.openEdges && q.after.boundaryLoops === q.before.boundaryLoops,
        'open ' + q.before.openEdges + ' -> ' + q.after.openEdges +
        ', loops ' + q.before.boundaryLoops + ' -> ' + q.after.boundaryLoops);
  check('flag on -> the 9 non-manifold edges are actually fixed',
        q.before.nonManifoldEdges === 9 && q.after.nonManifoldEdges === 0 && c.reversedDuplicatesRemoved === 3);
  check('flag on -> the sliver stitches are stripped and 6 of them re-stitched',
        c.degenerateRemoved === 12 && c.tJunctionSplits === 6,
        'degenerate ' + c.degenerateRemoved + ', T-junction ' + c.tJunctionSplits);
  check('flag on -> and the 6 cracks the split could NOT reach are re-closed as seams',
        c.seamsReclosed === 6 && c.seamTrisAdded === 6 && c.holesFilled === 0,
        'seams ' + c.seamsReclosed + '/' + c.seamTrisAdded + ' tris, holes filled ' + c.holesFilled);
  const seam = q.stages.filter(x => x.name === 'seam-reclose')[0];
  check('flag on -> seam-reclose left the 3 loops the piece arrived with alone',
        !!seam && seam.reclosed === 6 && seam.preexisting === 3,
        seam ? 'reclosed ' + seam.reclosed + ', pre-existing ' + seam.preexisting : 'stage absent');
  check('flag on -> hole fill itself is still skipped, and still says so',
        q.stages.filter(x => x.skipped === 'nonSolid').map(x => x.name).join(',') ===
        'flap-peel,orphan-components,hole-fill');
  check('flag on -> the pierce is neither fixed nor hidden',
        q.before.selfIntersections === 7 && q.after.selfIntersections === 7);
  check('flag on -> nothing was peeled or dropped to get there',
        c.flapTrisRemoved === 0 && c.orphanTrisRemoved === 0);

  /* The repair settles: a second pass hands back the same geometry, float for
   * float. Its COUNTERS do not go quiet, and that is worth saying plainly -
   * the only closure a collinear crack has is a zero-area triangle, so the
   * next pass strips the six fans as degenerates and lays the same six back
   * down. The mesh is a fixed point; the tally is not. That trade is not new
   * and not the flag's: without the flag, hole fill has always ended
   * fixtures/tape_welded_clustered.stl on 7 degenerate fan triangles and
   * re-made them on every pass since. The flag now reaches the same fixed
   * point by the same trade, instead of refusing the repair outright. */
  const again = R.commit(on.rawTris, { nonSolid: true });
  const sameBytes = again.rawTris.length === on.rawTris.length &&
                    again.rawTris.every((v, i) => v === on.rawTris[i]);
  check('flag on -> a second pass returns the same geometry, float for float', sameBytes,
        again.rawTris.length / 9 + ' tris vs ' + on.rawTris.length / 9);
  check('flag on -> ...by re-laying the same 6 zero-area fans, not by finding new work',
        again.report.counts.degenerateRemoved === 6 && again.report.counts.seamsReclosed === 6 &&
        again.report.after.openEdges === 100 && again.report.after.nonManifoldEdges === 0,
        'degenerate ' + again.report.counts.degenerateRemoved + ', seams ' +
        again.report.counts.seamsReclosed + ', open ' + again.report.after.openEdges);

  /* WITHOUT the flag this same shape declines, and for a reason that has
   * nothing to do with this fix: hole fill is all-or-nothing, so fanning the
   * two rims shut - which is what "not flagged" asks for - self-intersects at
   * 166 pairs, the gate rolls the whole stage back including the six crack
   * fills, and the final odd-edge gate then stops the result. Pinned as the
   * measured behaviour it is, and as the reason an open piece wants the flag:
   * it is not a control that should pass. */
  const off = R.commit(raw);
  check('flag OFF -> declines, hole fill rolled back on the rim fan (unchanged by this fix)',
        off.report.applied === false && off.rawTris === raw &&
        /hole-fill:selfInt 7->166/.test(off.report.gate.blockedStages.join(',')),
        off.report.reason + ' | ' + off.report.gate.blockedStages.join(', '));
}

/* ---- 2c. the same thing on a real mesh ---- */
/* fixtures/tape_welded_clustered.stl is a 32,860-triangle part off the repo's
 * own bench, not a construction: 295 collinear sliver stitches, closed on
 * arrival. It is where this was found. Flagging it non-solid used to take the
 * odd-edge count from 0 to 15 and discard everything - 295 degenerates, 288
 * T-junctions and a drop of 56 piercing pairs, all thrown away over 15 edges
 * the repair had opened itself. The flag now lands on exactly the result the
 * unflagged path lands on, which is the point: the flag was never supposed to
 * change what the surviving stages achieve, only which stages survive. */
console.log('\n== 2c. tape_welded_clustered (real mesh, 32,860 tris): the flag stops costing the repair ==');
{
  const raw = readSTL(path.join(ROOT, 'fixtures', 'tape_welded_clustered.stl'));
  const on = R.commit(raw, { nonSolid: true }), off = R.commit(raw);
  const qa = on.report, qb = off.report;
  check('real mesh: 295 collinear sliver stitches, closed on arrival',
        qa.before.degenerateTris === 295 && qa.before.oddEdges === 0 && qa.before.selfIntersections === 185,
        'degen ' + qa.before.degenerateTris + ', odd ' + qa.before.oddEdges + ', pierce ' + qa.before.selfIntersections);
  check('flag on -> applied (this is the case that used to go 0 -> 15 and discard)',
        qa.applied === true && qa.gate.oddAfter === 0, qa.reason);
  check('flag on -> the whole repair survives: 295 degenerate, 288 T-junctions',
        qa.counts.degenerateRemoved === 295 && qa.counts.tJunctionSplits === 288);
  check('flag on -> 4 seams re-closed, 0 holes filled, nothing peeled',
        qa.counts.seamsReclosed === 4 && qa.counts.seamTrisAdded === 7 &&
        qa.counts.holesFilled === 0 && qa.counts.flapTrisRemoved === 0,
        'seams ' + qa.counts.seamsReclosed + '/' + qa.counts.seamTrisAdded + ' tris');
  check('flag on -> 56 fewer piercing pairs, a real improvement that used to be binned',
        qa.after.selfIntersections === 129 && qa.before.selfIntersections === 185);
  check('flag on and flag off now reach the same mesh',
        qa.after.oddEdges === qb.after.oddEdges && qa.after.tris === qb.after.tris &&
        qa.after.degenerateTris === qb.after.degenerateTris &&
        qa.after.selfIntersections === qb.after.selfIntersections,
        'odd ' + qa.after.oddEdges + '/' + qb.after.oddEdges + ', degen ' +
        qa.after.degenerateTris + '/' + qb.after.degenerateTris);
}

/* ---- 3. the validator's verdict ---- */
console.log('\n== 3. mesh_validate.py --gate: clean passes with the flag, defects fail with it, clean fails without it ==');
for (const name of CLEAN) {
  const f = path.join(FX, name + '.stl');
  const on = validate(f, ['--non-solid']);
  check(name + ': --non-solid -> PASS (exit 0)', on.exit === 0 && on.verdict === 'PASS', fails(on));
  check(name + ': ...with 0 winding, 0 degenerate, 0 non-manifold, 0 pierce',
        on.inconsistent_winding_edges === 0 && on.degenerate_tris === 0 && on.nonmanifold_edges === 0 && on.self_intersection.pierce === 0);
  const off = validate(f, []);
  check(name + ': without the flag -> FAIL on open edges only', off.exit === 1 && /^open edges \d+/.test(fails(off)) && off.verdict_fails.length === 1, fails(off));
}
for (const name of DEFECT) {
  const j = validate(path.join(FX, name + '.stl'), ['--non-solid']);
  check(name + ': --non-solid -> FAIL on the pierce', j.exit === 1 && /self-intersecting/.test(fails(j)), fails(j));
}
{
  /* The one fixture here that is open by design AND defective: the flag must
   * lift the open-edge count and nothing else, so all four other classes stay
   * in the verdict. This is the validator's half of section 2b. */
  const j = validate(path.join(FX, 'thin_shell_cup_cracked.stl'), ['--non-solid']);
  check('thin_shell_cup_cracked: --non-solid -> FAIL, and on every class except closure',
        j.exit === 1 && j.nonmanifold_edges === 9 && j.inconsistent_winding_edges === 9 &&
        j.degenerate_tris === 12 && j.self_intersection.pierce === 7 && !/open edges/.test(fails(j)),
        fails(j));
  check('  ...its 100 open edges are measured and not counted against it',
        j.open_edges === 100, String(j.open_edges));
}
{
  const j = validate(path.join(FX, 'thin_shell_cup_thin.stl'), ['--non-solid']);
  check('thin_shell_cup_thin: --non-solid -> FAIL on the wall check, not on closure',
        j.exit === 1 && /wall\/gap under 0\.42/.test(fails(j)) && !/open edges/.test(fails(j)), fails(j));
  check('  ...thinnest wall reads the 0.25 mm dent', j.wall.min_wall_mm > 0.24 && j.wall.min_wall_mm < 0.26, String(j.wall.min_wall_mm));
  const c = validate(path.join(FX, 'thin_shell_cup.stl'), ['--non-solid']);
  check('thin_shell_cup: wall reads 1.2 mm everywhere, no sheets', c.wall.min_wall_mm > 1.19 && c.wall.min_wall_mm < 1.21 && c.wall.sheet_faces === 0,
        String(c.wall.min_wall_mm) + ' mm, sheets ' + c.wall.sheet_faces);
  const k = validate(path.join(FX, 'open_clip.stl'), ['--non-solid']);
  check('open_clip: a single sheet is reported as sheets, not as thin', k.wall.sheet_faces === k.wall.faces_measured && k.wall.thin_faces === 0);
  const w = validate(path.join(FX, 'fabric_weave.stl'), ['--non-solid']);
  check('fabric_weave: crossing clearance is the wall figure (>= 2*amp*cos)', w.wall.min_wall_mm > 1.15 && w.wall.thin_faces === 0, String(w.wall.min_wall_mm));
}

/* ---- 4. a real skin sample: closed, passes either way; defect injected, fails with the flag ---- */
console.log('\n== 4. skin_crosshatch_A (tonight\'s skin sample) ==');
{
  const on = validate(SKIN_A, ['--non-solid']);
  check('skin_crosshatch_A: --non-solid -> PASS', on.exit === 0, fails(on));
  check('  ...it is a closed shell (0 open edges), so the flag changes nothing about it', on.open_edges === 0);
  check('  ...its 0.42 mm ribs sit AT the threshold and pass it', on.wall.thin_faces === 0 && Math.abs(on.wall.min_wall_mm - 0.42) < 1e-4, String(on.wall.min_wall_mm));
  const off = validate(SKIN_A, []);
  check('skin_crosshatch_A: without the flag -> PASS too', off.exit === 0, fails(off));
  // Inject a real defect: a fin standing through the rib lattice on the
  // skinned top face (z = 8..8.6), sharing no vertex with anything.
  const raw = readSTL(SKIN_A);
  const fin = new Float32Array([-4.1, 0.37, 7.5, -1.1, 0.37, 7.5, -1.1, 0.37, 9.5,
                                -4.1, 0.37, 7.5, -1.1, 0.37, 9.5, -4.1, 0.37, 9.5]);
  const bad = new Float32Array(raw.length + fin.length);
  bad.set(raw); bad.set(fin, raw.length);
  const badFile = path.join(TMP, 'skin_crosshatch_A_selfint.stl');
  writeSTL(badFile, bad, 'skin_crosshatch_A + fin');
  const j = validate(badFile, ['--non-solid']);
  check('skin_crosshatch_A + fin: --non-solid -> FAIL on the pierce', j.exit === 1 && /self-intersecting/.test(fails(j)), fails(j));
  check('  ...the fin\'s own 4 open edges are allowed, the pierce is not', j.open_edges === 4 && j.self_intersection.pierce > 0,
        'open ' + j.open_edges + ', pierce ' + j.self_intersection.pierce);
  const r = R.commit(bad, { nonSolid: true });
  check('  ...NSO_Repair with the flag reports the pierce and does not peel the fin away',
        r.report.before.selfIntersections > 0 && r.report.counts.flapTrisRemoved === 0 && r.report.counts.orphanTrisRemoved === 0,
        'selfInt ' + r.report.before.selfIntersections);
}

/* ---- 5. the canonical watertight checker ---- */
console.log('\n== 5. stl_watertight_check.py --odd --degen --non-solid ==');
{
  const a = watertight(path.join(FX, 'open_clip.stl'), ['--non-solid']);
  check('open_clip: --non-solid -> OK', a.exit === 0, a.last);
  const b = watertight(path.join(FX, 'open_clip.stl'));
  check('open_clip: without the flag -> FAIL odd edges', b.exit === 1 && /odd edges/.test(b.last), b.last);
  const nm = path.join(ROOT, 'fixtures', 'repair', 'thingi10k', '39644.stl');
  if (fs.existsSync(nm)) {
    const c = watertight(nm, ['--non-solid']);
    check('39644 (3-sheet, non-manifold edges): --non-solid still FAILS', c.exit === 1 && /non-manifold/.test(c.last), c.last);
  } else {
    console.log('  skip  39644.stl not present (thingi10k fixtures are not committed)');
  }
}

/* ---- 6. Smooth's gate, headless ---- */
console.log('\n== 6. NSO_smoothGlobal: the flag swaps the volume budget for an area budget ==');
{
  const ctx = { console, Math, Float32Array, Float64Array, Uint8Array, Int32Array, Uint32Array, Map, Set, Array, isFinite, Number, Object, JSON, String };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'app-sculpt.js'), 'utf8'), ctx, { filename: 'app-sculpt.js' });
  const raw = readSTL(path.join(FX, 'fabric_weave.stl'));
  const on = ctx.NSO_smoothGlobal(raw, { passes: 1, strength: 0.5, maxVolumeChange: 0.25, nonSolid: true });
  check('fabric_weave: with the flag one pass lands under the area budget', on.ok === true, on.reason);
  check('  ...open edges did not rise (delta gate still ran)', on.after.openPos <= on.before.openPos, on.before.openPos + ' -> ' + on.after.openPos);
  check('  ...triangle count and degenerates unchanged (those gates still ran)', on.after.tris === on.before.tris && on.after.degenerate === on.before.degenerate);
  // The point of the swap, measured on the cup: 20 hard passes take 60% of
  // the surface area, and the signed volume of the open shell reads a 94%
  // "loss" for the same change (60 passes push it negative). Both gates
  // refuse here; only the area figure describes what happened to the sheet.
  const cup = readSTL(path.join(FX, 'thin_shell_cup.stl'));
  const cOff = ctx.NSO_smoothGlobal(cup, { passes: 20, strength: 1, maxVolumeChange: 0.25 });
  const cOn = ctx.NSO_smoothGlobal(cup, { passes: 20, strength: 1, maxVolumeChange: 0.25, nonSolid: true });
  check('thin_shell_cup, 20 hard passes, no flag: refused on volume', cOff.ok === false && /^volume loss/.test(cOff.reason), cOff.reason);
  check('thin_shell_cup, 20 hard passes, flag: refused on surface area, volume never mentioned',
        cOn.ok === false && /^surface area loss/.test(cOn.reason) && /\(non-solid\)/.test(cOn.reason) && !/volume/.test(cOn.reason), cOn.reason);
  const aLoss = 1 - cOn.after.area / cOn.before.area, vLoss = 1 - Math.abs(cOff.after.volume) / Math.abs(cOff.before.volume);
  check('  ...and the two figures disagree by more than 25 points (volume is noise on an open shell)', vLoss - aLoss > 0.25,
        'volume ' + (vLoss * 100).toFixed(1) + '% vs area ' + (aLoss * 100).toFixed(1) + '%');
  // A modest over-budget case, so the area gate is shown to bite on its own
  // number and not only on a wreck.
  const clip = readSTL(path.join(FX, 'open_clip.stl'));
  const k = ctx.NSO_smoothGlobal(clip, { passes: 60, strength: 1, maxVolumeChange: 0.05, nonSolid: true });
  check('open_clip, 5% area budget: refused at ~10% area loss', k.ok === false && /surface area loss 9\.\d+% over budget/.test(k.reason), k.reason);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
