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
  check('HANDOFF.md points at the rule', /docs\/NON-SOLID\.md/.test(read('docs/HANDOFF.md')));
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
