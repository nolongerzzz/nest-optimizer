#!/usr/bin/env node
/* NSO_PaintDelete - the geometry and the gate, against shipped fixtures.
 *
 * No browser: this is the module talking to NSO_Repair and to real STLs, the
 * way tools/nso_repair_regress.js does. The app half is proved separately, in
 * real Chromium, by tools/nso_paint_delete_drive_check.js.
 *
 * Every mesh this suite produces and accepts is written out and put through
 * the canonical checker, tools/mesh_validate.py --gate. A number this file
 * asserts and a verdict that checker gives are two different authorities, and
 * a result is only correct when both agree.
 *
 * Run: node tools/nso_paint_delete_test.js        exit 0 = every gate held
 *      node tools/nso_paint_delete_test.js -v     print every checked value
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
global.window = global;
require(path.join(ROOT, 'NSO_Repair.js'));
require(path.join(ROOT, 'nso_paint_delete.js'));
const R = global.NSO_Repair;
const D = global.NSO_PaintDelete;
const { readSTL, writeSTL } = require('./nso_stl_io.js');

const VERBOSE = process.argv.includes('-v');
const fx = f => path.join(ROOT, 'fixtures', f);
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-paint-delete-'));

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; if (VERBOSE) console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}
function head(t) { console.log('\n== ' + t + ' =='); }

/* A painted entry in exactly the shape app-mask.js records one. The app never
   builds these by hand - nsoFaceFromHit does - but a click is not available
   here, and the drive check is what proves the two shapes are the same. */
const outer = (axisIdx, keepMin) => {
  const n = [0, 0, 0]; n[axisIdx] = keepMin ? -1 : 1;
  return { n, d: 0, axisIdx, keepMin, inner: false, dispAxis: axisIdx, dispSign: keepMin ? -1 : 1 };
};
const inner = (axisIdx, keepMin, at) => {
  const n = [0, 0, 0]; n[axisIdx] = keepMin ? -1 : 1;
  return { n, d: keepMin ? -at : at, axisIdx, keepMin, inner: true,
           dispAxis: axisIdx, dispSign: keepMin ? -1 : 1, dispPlane: at };
};
// The plane a click on triangle t would record when the face has no axis to
// name - a curved shell, which is what 40921 and the pinch fixtures are.
function planeOf(r, t) {
  const o = t * 9;
  const a = [r[o], r[o + 1], r[o + 2]];
  const b = [r[o + 3], r[o + 4], r[o + 5]];
  const c = [r[o + 6], r[o + 7], r[o + 8]];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const L = Math.hypot(n[0], n[1], n[2]);
  n = [n[0] / L, n[1] / L, n[2] / L];
  return { n, d: n[0] * a[0] + n[1] * a[1] + n[2] * a[2],
           axisIdx: null, keepMin: null, inner: false, dispAxis: null, dispSign: null };
}

/* The canonical checker, on the mesh this module actually produced. --gate
   exits 1 on any failed verdict check; --non-solid tells it an open piece is
   deliberate, which is exactly what a plain face delete makes. */
function canonical(name, rawTris, opts) {
  const file = path.join(OUT, name + '.stl');
  writeSTL(file, rawTris);
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), '--gate', '--json'];
  if (opts && opts.nonSolid) args.push('--non-solid');
  args.push(file);
  let out = '', code = 0;
  try {
    out = execFileSync('python3', args, { encoding: 'utf8' });
  } catch (e) {
    code = e.status == null ? 1 : e.status;
    out = (e.stdout || '') + (e.stderr || '');
  }
  let json = null;
  try { json = JSON.parse(out); } catch (e) { /* the gate's own text on a crash */ }
  return { code, json, out, file };
}

/* ------------------------------------------------------------------ *
 * 1. the selector is app-mask.js's overlay predicate, and says so
 * ------------------------------------------------------------------ */
head('1. the selector agrees with app-mask.js on what "the same face" is');
{
  const mask = fs.readFileSync(path.join(ROOT, 'app-mask.js'), 'utf8');
  const mod = fs.readFileSync(path.join(ROOT, 'nso_paint_delete.js'), 'utf8');
  const nOf = s => (s.match(/N_TOL\s*=\s*([0-9.e-]+)/) || [])[1];
  const dOf = s => (s.match(/D_TOL\s*=\s*([0-9.e-]+)/) || [])[1];
  check('N_TOL matches app-mask.js and the module reports it',
        nOf(mask) === nOf(mod) && Number(nOf(mod)) === D.N_TOL,
        'app-mask ' + nOf(mask) + ' / module ' + nOf(mod));
  check('D_TOL matches app-mask.js and the module reports it',
        dOf(mask) === dOf(mod) && Number(dOf(mod)) === D.D_TOL,
        'app-mask ' + dOf(mask) + ' / module ' + dOf(mod));
  check('module declares its paint scope', /PAINT SCOPE:\s*SUB-REGION/.test(mod));

  // Selection is by face, and a face the piece does not have selects nothing.
  const cube = readSTL(fx('box-20mm.stl'));
  check('one outer face of a cube is 2 triangles', D.select(cube, [outer(2, false)]).count === 2);
  check('all six outer faces are all 12', D.select(cube, [0, 1, 2].flatMap(a => [outer(a, false), outer(a, true)])).count === 12);
  check('a plane the piece has no face on selects nothing',
        D.select(cube, [inner(2, false, 3.7)]).count === 0);
}

/* ------------------------------------------------------------------ *
 * 2. component counting agrees with NSO_Repair, fixture for fixture
 * ------------------------------------------------------------------ */
head('2. shell mode counts the same components NSO_Repair does');
for (const f of ['box-20mm.stl', 'box_open.stl', 'repair/thingi10k/40921.stl',
                 'repair/thingi10k/39644.stl', 'repair/synth_pinch_2sheet_safe.stl',
                 'fixture_sphere_curved.stl']) {
  const r = readSTL(fx(f));
  const nTri = r.length / 9;
  const mine = D._componentsOf(D._edgeMap(R._weldToIndexed(r, R.WELD_TOL), nTri), nTri).count;
  const theirs = R.inspect(r, { selfIntersections: false }).components;
  check(f + ': components', mine === theirs, mine + ' vs ' + theirs);
}

/* ------------------------------------------------------------------ *
 * 3. the clean cases
 * ------------------------------------------------------------------ */
head('3a. box-20mm: delete the Z+ face, leave the rim open');
{
  const r = readSTL(fx('box-20mm.stl'));
  const x = D.commit(r, [outer(2, false)], { mode: 'face' });
  check('applied', x.report.applied, x.report.reason);
  check('removed exactly the face', x.report.removedTris === 2, String(x.report.removedTris));
  check('12 -> 10 triangles', x.report.after.tris === 10, String(x.report.after.tris));
  check('the rim, and only the rim, opened', x.report.after.openEdges === 4, String(x.report.after.openEdges));
  check('predicted odd edges match the measured result',
        x.report.gate.oddPredicted === x.report.after.oddEdges,
        x.report.gate.oddPredicted + ' vs ' + x.report.after.oddEdges);
  check('one boundary loop', x.report.after.boundaryLoops === 1, String(x.report.after.boundaryLoops));
  check('no new self-intersections', x.report.after.selfIntersections === 0);
  check('still one body', x.report.after.components === 1);
  check('a new array came back', x.rawTris !== r);
  const c = canonical('cube_open_top', x.rawTris, { nonSolid: true });
  check('canonical checker passes it as a deliberate open piece', c.code === 0,
        c.json ? 'verdict ' + c.json.verdict : c.out.slice(-200));
}

head('3b. box_open: delete the whole pocket and seal it - the solid block back');
{
  const r = readSTL(fx('box_open.stl'));
  const before = R.inspect(r);
  const pocket = [inner(2, false, 2), inner(0, false, 2), inner(0, true, 58),
                  inner(1, false, 2), inner(1, true, 38)];
  check('the piece starts as a 60x40x25 box with a pocket',
        before.tris === 68 && before.watertight && Math.abs(before.volume - 13632) < 1e-6,
        before.tris + ' tris, vol ' + before.volume.toFixed(3));

  const cut = D.commit(r, pocket, { mode: 'face' });
  check('cut: applied', cut.report.applied, cut.report.reason);
  check('cut: floor + 4 walls = 10 triangles', cut.report.removedTris === 10, String(cut.report.removedTris));
  check('cut: the pocket mouth is the only opening', cut.report.after.openEdges === 4 &&
        cut.report.after.boundaryLoops === 1,
        cut.report.after.openEdges + ' open, ' + cut.report.after.boundaryLoops + ' loop(s)');

  const sealed = D.commit(r, pocket, { mode: 'face', seal: true });
  check('sealed: applied', sealed.report.applied, sealed.report.reason);
  check('sealed: the shipped repair filled one hole',
        sealed.report.seal && sealed.report.seal.applied && sealed.report.seal.holesFilled === 1,
        JSON.stringify(sealed.report.seal));
  check('sealed: watertight again', sealed.report.after.watertight);
  check('sealed: it is the solid block, exactly',
        Math.abs(sealed.report.after.volume - 60000) < 1e-6,
        sealed.report.after.volume.toFixed(6) + ' mm^3');
  check('sealed: no self-intersections', sealed.report.after.selfIntersections === 0);
  const c = canonical('box_open_pocket_filled', sealed.rawTris);
  check('canonical checker passes the filled block', c.code === 0,
        c.json ? 'verdict ' + c.json.verdict + ', euler ' + c.json.euler_characteristic : c.out.slice(-200));
}

head('3c. 40921: delete one of the two shells - 5 self-intersections to 0');
{
  const r = readSTL(fx('repair/thingi10k/40921.stl'));
  const x = D.commit(r, [planeOf(r, 0)], { mode: 'shell' });
  check('applied', x.report.applied, x.report.reason);
  check('one whole shell went', x.report.componentsRemoved === 1);
  check('186 -> 96 triangles', x.report.after.tris === 96, String(x.report.after.tris));
  check('self-intersections 5 -> 0',
        x.report.gate.selfIntBefore === 5 && x.report.gate.selfIntAfter === 0,
        x.report.gate.selfIntBefore + ' -> ' + x.report.gate.selfIntAfter);
  check('watertight before and after, nothing opened',
        x.report.before.watertight && x.report.after.watertight &&
        x.report.after.oddEdges === 0);
  check('two bodies became one', x.report.after.components === 1, String(x.report.after.components));
  check('the 17 bowtie vertices went with it', x.report.after.pinchVerts === 0,
        String(x.report.after.pinchVerts));
  // The two shells are nothing like the same size, so this pins down WHICH one
  // went as well as that one did.
  check('the volume is the surviving shell\'s alone',
        Math.abs(x.report.before.volume - 9551.052) < 1e-3 &&
        Math.abs(x.report.after.volume - 998.707) < 1e-3,
        x.report.before.volume.toFixed(3) + ' -> ' + x.report.after.volume.toFixed(3));
  const c = canonical('40921_one_shell', x.rawTris);
  check('canonical checker passes the surviving shell', c.code === 0,
        c.json ? 'verdict ' + c.json.verdict + ', selfint ' +
                 JSON.stringify(c.json.self_intersection) : c.out.slice(-200));
}

head('3d. out-box-corners-r05: delete the top and seal across a 5-edge rim');
{
  const r = readSTL(fx('out-box-corners-r05.stl'));
  const x = D.commit(r, [outer(2, false)], { mode: 'face', seal: true });
  check('applied', x.report.applied, x.report.reason);
  check('the rim was fanned shut', x.report.seal.applied && x.report.seal.holesFilled === 1);
  check('watertight', x.report.after.watertight);
  check('the top is flat, so the volume is unmoved',
        Math.abs(x.report.after.volume - x.report.before.volume) < 1e-6,
        x.report.before.volume.toFixed(6) + ' -> ' + x.report.after.volume.toFixed(6));
  check('no self-intersections', x.report.after.selfIntersections === 0);
  const c = canonical('corners_r05_resealed', x.rawTris);
  check('canonical checker passes it', c.code === 0,
        c.json ? 'verdict ' + c.json.verdict : c.out.slice(-200));
}

head('3e. deliberately open pieces: a shell delete does not demand a closed result');
{
  /* What a shell delete owes is that it opened nothing, not that what is left
     is a closed solid. Demanding the latter would refuse every shell delete on
     a piece that is open ON PURPOSE (docs/NON-SOLID.md) - which is exactly
     where "get that loose sheet off" comes up most. */
  const cup = readSTL(fx('open/thin_shell_cup.stl'));
  const x = D.commit(cup, [planeOf(cup, 0)], { mode: 'shell' });
  check('thin_shell_cup: applied even though the piece is open', x.report.applied, x.report.reason);
  check('thin_shell_cup: one of the two shells went', x.report.componentsRemoved === 1 &&
        x.report.after.components === 1, x.report.gate.compBefore + ' -> ' + x.report.gate.compAfter);
  check('thin_shell_cup: it opened nothing - the odd count only fell',
        x.report.after.oddEdges === 48 && x.report.before.oddEdges === 96,
        x.report.before.oddEdges + ' -> ' + x.report.after.oddEdges);
  const c = canonical('thin_shell_cup_one_shell', x.rawTris, { nonSolid: true });
  check('thin_shell_cup: canonical checker passes the survivor as an open piece', c.code === 0,
        c.json ? 'verdict ' + c.json.verdict : c.out.slice(-200));

  /* A patch with no axis to name is stored as a bare plane, and a bare plane
     can sit on more than one body. Three of the weave's ten strands are
     coplanar with the one clicked, so all three go - and the report says
     three, rather than the delete quietly taking more than it reported. */
  const weave = readSTL(fx('open/fabric_weave.stl'));
  const w = D.commit(weave, [planeOf(weave, 0)], { mode: 'shell' });
  check('fabric_weave: applied', w.report.applied, w.report.reason);
  check('fabric_weave: a coplanar plane can name several shells, and it says how many',
        w.report.componentsRemoved === 3 && w.report.after.components === 7,
        w.report.componentsRemoved + ' shell(s), ' + w.report.gate.compBefore + ' -> ' + w.report.gate.compAfter);
  check('fabric_weave: it opened nothing', w.report.after.oddEdges === 588 &&
        w.report.before.oddEdges === 840,
        w.report.before.oddEdges + ' -> ' + w.report.after.oddEdges);

  // ...and a caller who DOES want a closed solid can still say so.
  const strict = D.commit(cup, [planeOf(cup, 0)], { mode: 'shell', requireWatertight: true });
  check('and requireWatertight is still there for a caller who wants it',
        !strict.report.applied && strict.report.gate.blocked.indexOf('watertight') >= 0 &&
        strict.rawTris === cup, strict.report.reason);
}

/* ------------------------------------------------------------------ *
 * 4. the refusals - every clause, on a shipped fixture
 * ------------------------------------------------------------------ */
head('4. every gate clause refuses, and hands back the caller\'s own array');

function refuses(name, file, entries, opts, clause) {
  const r = readSTL(fx(file));
  const x = D.commit(r, entries, opts);
  check(name + ': declined', !x.report.applied && x.report.declined, x.report.reason);
  check(name + ': blocked by "' + clause + '"',
        x.report.gate.blocked.indexOf(clause) >= 0 || x.report.reason.indexOf(clause) >= 0,
        JSON.stringify(x.report.gate.blocked));
  check(name + ': the caller\'s own array came straight back', x.rawTris === r);
  check(name + ': after equals before, deltas are zero',
        x.report.triDelta === 0 && x.report.volumeDelta === 0 &&
        x.report.after === x.report.before);
  return x;
}

refuses('empty (every face of a cube)', 'box-20mm.stl',
        [0, 1, 2].flatMap(a => [outer(a, false), outer(a, true)]), { mode: 'face' }, 'empty');

refuses('empty (39644 is one shell, so "delete this shell" is "delete it all")',
        'repair/thingi10k/39644.stl', [inner(1, false, 3)], { mode: 'shell' }, 'empty');

refuses('nothing (a plane this piece has no face on)', 'box-20mm.stl',
        [inner(2, false, 3.7)], { mode: 'face' }, 'nothing');

refuses('shatter (39644 inner Z+ at 6 splits the piece in two)',
        'repair/thingi10k/39644.stl', [inner(2, false, 6)], { mode: 'face' }, 'shatter');

refuses('shatter (box_open\'s top is all that holds the liner to the shell)',
        'box_open.stl', [outer(2, false)], { mode: 'face' }, 'shatter');

refuses('watertight (a cube with its lid off, when a closed solid was asked for)',
        'box-20mm.stl', [outer(2, false)], { mode: 'face', requireWatertight: true }, 'watertight');

refuses('watertight (out-box-round-r05: the repair will not fill that rim)',
        'out-box-round-r05.stl', [outer(2, false)], { mode: 'face', seal: true }, 'watertight');

/* The self-intersection clause is the one deletion alone cannot trip, because
   removing triangles cannot make two survivors cross. Sealing can. Normally
   NSO_Repair's own gate catches it first and declines the fill, which is what
   the case just above measures - so to prove THIS gate is a real backstop and
   not decoration riding on that one, hand the seal NSO_Repair's gate turned
   off and watch this module refuse anyway. */
{
  const x = refuses('selfInt (the same rim, with the repair\'s own gate off)',
                    'out-box-round-r05.stl', [outer(2, false)],
                    { mode: 'face', seal: true, sealOptions: { gate: false } }, 'selfInt');
  check('selfInt: it really was the fill that crossed the piece',
        x.report.gate.selfIntBefore === 0 && x.report.gate.selfIntAfter === 1,
        x.report.gate.selfIntBefore + ' -> ' + x.report.gate.selfIntAfter);
  check('selfInt: the rejected mesh is reported, not mistaken for the result',
        x.report.rejected && x.report.rejected.selfIntersections === 1 &&
        x.report.after.selfIntersections === 0);
}

head('5. inputs that are not geometry are declined, not crashed on');
{
  const r = readSTL(fx('box-20mm.stl'));
  check('no paint at all', D.commit(r, [], { mode: 'face' }).report.declined);
  check('null soup', D.commit(null, [outer(2, false)], {}).ok === false);
  const ragged = new Float32Array(20);
  check('not a whole number of triangles', D.commit(ragged, [outer(2, false)], {}).ok === false);
  const nan = readSTL(fx('box-20mm.stl')).slice(); nan[5] = NaN;
  check('a non-finite coordinate', D.commit(nan, [outer(2, false)], {}).ok === false);
  // A caller with no metrics has no gate, and a delete with no gate is not
  // one this module will perform.
  const noRepair = D.commit(r, [outer(2, false)], { repair: {} });
  check('NSO_Repair absent means no gate, so no delete',
        noRepair.ok === false && noRepair.rawTris === r, noRepair.report.reason);
}

head('6. idempotency and identity');
{
  const r = readSTL(fx('box-20mm.stl'));
  const once = D.commit(r, [outer(2, false)], { mode: 'face' });
  // The Z+ face is gone; the same paint now names the NEW outer extreme on
  // Z+, which after removing the lid is the top rim of the walls - no
  // triangle has its normal, so the second pass finds nothing and declines.
  const twice = D.commit(once.rawTris, [outer(2, false)], { mode: 'face' });
  check('a second delete of the same face finds nothing', twice.report.declined,
        twice.report.reason);
  check('and returns the array it was given', twice.rawTris === once.rawTris);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
console.log('meshes written to ' + OUT);
process.exit(fail === 0 ? 0 : 1);
