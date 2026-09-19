/* The crosshatch, rebuilt as two one-direction layers - the defect, the fix and
 * the re-tile, every figure measured.
 *     node tools/nso_crosshatch_test.js       exit 0 = every gate held
 *
 * Part 1 - THE DEFECT, and that it has no angle. The shipped loose crosshatch
 *   stacked the way Bambu stacks: 519.750 mm^2 in ONE patch over the whole
 *   footprint. Then the same measurement at 15, 30, 45 and 60 degrees, because
 *   "turn it further" is the obvious first idea and it does not work: a
 *   bidirectional layer cannot be crossed by a bidirectional layer at any angle.
 * Part 2 - THE GUARD. directionCensus on the defect's own centrelines reads
 *   50 / 50 and oneDirection refuses it by name, before any geometry is built.
 *   The fix's own layers read 96.3 / 3.7 and pass.
 * Part 3 - THE FIX, measured with the same instrument as the defect: 625
 *   isolated crossings of exactly width x width, none spanning more than one
 *   crossing square's diagonal. Plus the orientation, off the mesh.
 * Part 4 - the angle is a RIGID TURN, so every contact figure is identical at
 *   45 degrees and at 90 - asserted, not assumed - and the unturned footprint is
 *   exactly the span the plan claims.
 * Part 5 - THE END TURN's clearance, measured by building the weld it prevents.
 * Part 6 - the CANONICAL CHECKER (tools/mesh_validate.py) on one layer and on
 *   the stack, with the repo's own 0.05 mm apart / 0.05 mm into controls.
 * Part 7 - TASK 2: RE-TILING, and the scale control that shows why it is not a
 *   scale. Plus the raster round trip, which answers whether re-tracing a
 *   differently-sized canvas would have been the simpler implementation.
 * Part 8 - it loads as a classic script on `window`, like every other module.
 * Part 9 - the committed fixtures are what this code builds today.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const vm = require('vm');
const path = require('path');
const { execFileSync } = require('child_process');
const C = require('../nso_crosshatch.js');
const RL = require('../nso_raster_lines.js');
const NSO_Skin = require('../nso_skin.js');
const NSO_SkinPatch = require('../nso_skin_patch.js');
const F = require('./nso_raster_fixtures.js');
const FX = require('./nso_crosshatch_fixtures.js');
const { writeSTL } = require('./nso_stl_io.js');
const { interfaceContact, rotateZ } = require('./nso_contact_area.js');
const ANG = require('./nso_line_angle.js');

const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const f = (x, n) => Number(x).toFixed(n == null ? 4 : n);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-crosshatch-'));

function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}
function meshValidate(soup, tag, extra) {
  const file = path.join(tmp, tag + '.stl');
  writeSTL(file, soup, tag);
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'].concat(extra || []);
  /* --gate exits 1 on a failing verdict, which is a RESULT here, not an error */
  let out;
  try { out = execFileSync('python3', args, { encoding: 'utf8', maxBuffer: 64 << 20 }); }
  catch (e) { out = String(e.stdout || ''); if (!out) throw e; }
  return JSON.parse(out);
}
const summary = v => 'tris ' + v.triangles + ', open ' + v.open_edges + ', nm ' + v.nonmanifold_edges +
  ', euler ' + v.euler_characteristic + ', degen ' + v.degenerate_tris + ', sliver ' + v.sliver_tris +
  ', winding ' + v.inconsistent_winding_edges + ', pierce ' + v.self_intersection.pierce +
  ', coplanar ' + v.self_intersection.coplanar;
const clean = v => v.open_edges === 0 && v.nonmanifold_edges === 0 && v.degenerate_tris === 0 &&
  v.sliver_tris === 0 && v.inconsistent_winding_edges === 0 && v.self_intersection.pierce === 0 &&
  v.self_intersection.coplanar === 0;
const verdictOf = v => (v.verdict_fails && v.verdict_fails.length) ? v.verdict_fails.join('; ') : 'PASS';

/* the interface between a build's two layers, measured as real 2D polygon
   intersection in the plane they meet in - the same instrument the audit uses */
function contactOf(built) {
  return interfaceContact(built.layers[0].tris, built.layers[1].tris, { plane: built.interfaceZ });
}

const W = C.LINE_WIDTH;                 /* 0.42 mm */
const CROSS = W * W;                    /* 0.1764 mm^2 - a flat line's crossing */
const SPAN45 = W * Math.SQRT2;          /* the bbox of that square turned 45 deg */
const SIZE = NSO_SkinPatch.SIZE;        /* 30 mm, the sample footprint */

console.log('\n============================================================');
console.log(' The crosshatch as two one-direction layers');
console.log('============================================================');

/* ------------------------------------------------------------------ part 1 */
console.log('\n=== 1. the defect: a bidirectional layer has no crossing angle ===');
const defect = NSO_SkinPatch.buildPatch({ variant: 'loose', pattern: 'crosshatch' });
let defectCt = null;
{
  check('the shipped crosshatch really does run ribs BOTH ways in one layer',
    defect.ok && defect.info.ribsU === 25 && defect.info.ribsV === 25,
    defect.ok ? defect.info.ribsU + ' along U and ' + defect.info.ribsV + ' along V' : defect.reason);
  console.log('  two copies stacked, the upper turned by `rot`, measured in the interface plane:');
  const rows = [];
  for (const deg of [15, 30, 45, 60, 90]) {
    const B = rotateZ(defect.tris, deg, SIZE / 2, SIZE / 2, defect.tipsZ);
    const ct = interfaceContact(defect.tris, B, { plane: defect.tipsZ });
    rows.push({ deg, ct });
    if (deg === 90) defectCt = ct;
    console.log('    rot ' + String(deg).padStart(2) + ' deg   ' + f(ct.area, 3).padStart(8) + ' mm^2 in ' +
      String(ct.patches).padStart(3) + ' patch(es), widest spans ' + f(ct.maxPatchSpan, 2).padStart(5) + ' mm');
  }
  check('at 90 deg the whole tip area welds in ONE patch spanning the footprint',
    defectCt.patches === 1 && near(defectCt.area, 519.75, 1e-3) &&
    near(defectCt.area, defectCt.areaA, 1e-3) && near(defectCt.maxPatchSpan, SIZE, 1e-4),
    f(defectCt.area, 3) + ' mm^2 = 100.0% of its ' + f(defectCt.areaA, 3) + ' mm^2 of tips, span ' +
    f(defectCt.maxPatchSpan, 2) + ' mm');
  check('and NO angle fixes it - every one still welds over millimetres, never at a point',
    rows.every(r => r.ct.maxPatchSpan > 4 && r.ct.area > 200),
    'best: ' + f(Math.min.apply(null, rows.map(r => r.ct.area)), 3) + ' mm^2, shortest weld ' +
    f(Math.min.apply(null, rows.map(r => r.ct.maxPatchSpan)), 2) + ' mm');
  check('the reason is not the section: the rib is ' + W + ' mm top AND bottom',
    near(defect.minWall, W, 1e-9) && near(defect.tipWall, W, 1e-9),
    'wall ' + defect.minWall + ' -> tip ' + defect.tipWall + ' mm');
}

/* ------------------------------------------------------------------ part 2 */
console.log('\n=== 2. the guard: one direction per layer, refused on the paths ===');
{
  /* the defect's own centrelines, as tools/nso_raster_fixtures.js draws them:
     15 lines each way in ONE layer */
  const bad = F.crosshatchPath();
  const cen = C.directionCensus(bad);
  console.log('    the bidirectional layer\'s own line directions, weighted by length:');
  for (const fam of cen.families) console.log('      ' + String(fam.deg).padStart(3) + ' deg   ' +
    f(fam.share * 100, 2) + '%   ' + f(fam.length, 2) + ' mm');
  check('two families, half the line length each - that IS the defect, in one number',
    cen.families.length === 2 && near(cen.crossShare, 0.5, 1e-9), f(cen.crossShare, 4));
  const refusal = C.oneDirection(bad);
  check('oneDirection refuses it by name, before any geometry is built',
    typeof refusal === 'string' && /TWO directions/.test(refusal) && /519\.750/.test(refusal),
    String(refusal).slice(0, 96) + '...');
  const pl = C.plan({ W: SIZE, D: SIZE });
  check('the plan for a real interface is not a refusal', typeof pl === 'object', typeof pl === 'string' ? pl : 'ok');
  for (const which of [1, 2]) {
    const cen2 = C.directionCensus(C.layerPaths(pl, which));
    check('layer ' + which + ' passes: one direction plus its end turns, ' + f(cen2.crossShare * 100, 1) + '% across',
      C.oneDirection(C.layerPaths(pl, which)) === null && cen2.crossShare < 0.05 && cen2.obliqueShare === 0,
      f(cen2.dominantShare * 100, 2) + '% at ' + cen2.dominant + ' deg, ' +
      f(cen2.crossShare * 100, 2) + '% across it, ' + f(cen2.obliqueShare * 100, 2) + '% oblique');
  }
  check('build() runs the guard itself - the two layers cross each other, not themselves',
    C.build({ W: SIZE, D: SIZE }).layers.map(L => L.lineDirection).join('/') === '45/135',
    C.build({ W: SIZE, D: SIZE }).layers.map(L => L.lineDirection + ' deg').join(' and '));
}

/* ------------------------------------------------------------------ part 3 */
console.log('\n=== 3. the fix, measured with the same instrument ===');
const ref = C.build({ W: SIZE, D: SIZE });
const refCt = contactOf(ref);
{
  check('it builds', ref.ok, ref.ok ? ref.describe : ref.reason);
  check('the pitch, the rib and the height are the SHIPPED crosshatch\'s own numbers',
    ref.pitch === NSO_Skin.PATTERNS.crosshatch.defaults.pitch &&
    ref.width === NSO_Skin.PATTERNS.crosshatch.defaults.rib &&
    ref.width === NSO_SkinPatch.MIN_WALL && ref.height === RL.LINE_HEIGHT,
    'pitch ' + ref.pitch + ', line ' + ref.width + ' x ' + ref.height + ' mm');
  console.log('    contact ' + f(refCt.area, 4) + ' mm^2 in ' + refCt.patches + ' patch(es); every patch ' +
    f(Math.min.apply(null, refCt.patchAreas), 6) + ' .. ' + f(Math.max.apply(null, refCt.patchAreas), 6) +
    ' mm^2, widest spans ' + f(refCt.maxPatchSpan, 4) + ' mm');
  check('exactly ' + ref.crossings + ' contact patches - ' + ref.repeatsU + ' lines crossed by ' + ref.repeatsV,
    refCt.patches === ref.crossings, String(refCt.patches));
  check('every one is exactly width x width = ' + f(CROSS, 6) + ' mm^2',
    refCt.patchAreas.every(a => near(a, CROSS, 1e-5)),
    'min ' + f(Math.min.apply(null, refCt.patchAreas), 6) + ', max ' + f(Math.max.apply(null, refCt.patchAreas), 6));
  check('the total is the crossings and nothing else',
    near(refCt.area, ref.contactPredicted, 1e-3) && near(refCt.area, 110.25, 1e-3),
    f(refCt.area, 4) + ' vs ' + f(ref.contactPredicted, 4) + ' mm^2 predicted from the plan alone');
  check('NO WELD ANYWHERE: no patch spans more than one crossing square\'s diagonal',
    refCt.maxPatchSpan <= SPAN45 * 1.005,
    f(refCt.maxPatchSpan, 4) + ' mm vs w x sqrt2 = ' + f(SPAN45, 4) + ' + 0.5%');
  check('against the defect: ' + f(defectCt.area / refCt.area, 2) + 'x less bonding, and in ' +
    refCt.patches + ' dots instead of one ' + f(defectCt.maxPatchSpan, 0) + ' mm weld',
    defectCt.area / refCt.area > 4 && defectCt.patches === 1 && refCt.patches === ref.crossings,
    f(defectCt.area, 3) + ' mm^2 / 1 patch   vs   ' + f(refCt.area, 3) + ' mm^2 / ' + refCt.patches + ' patches');
  check('the interface is ' + f(2 * RL.LINE_HEIGHT, 2) + ' mm thick - two real layers, not more, ' +
    'and that IS the relief\'s own height, read as what it stood in for',
    near(ref.totalHeight, 2 * RL.LINE_HEIGHT, 1e-9) && near(ref.extent[2], 2 * RL.LINE_HEIGHT, 1e-6) &&
    near(defect.extent[2], ref.extent[2], 1e-6),
    f(ref.extent[2], 4) + ' mm measured on the mesh, against the relief\'s ' + f(defect.extent[2], 4));

  /* the orientation, off the shipped mesh - the gate the raster work put in */
  for (const [i, want] of [[0, 45], [1, 135]]) {
    const h = ANG.wallHistogram(ref.layers[i].tris);
    const dom = ANG.dominantBand(h, 1);
    check('layer ' + (i + 1) + '\'s lines run at ' + want + ' deg on the MESH, and nothing runs along an axis',
      dom.centre === want && dom.share > 0.9 &&
      ANG.bandShare(h, 0, 1) === 0 && ANG.bandShare(h, 90, 1) === 0,
      'dominant ' + dom.centre + ' +/-1 deg at ' + f(dom.share * 100, 2) + '%, axis-aligned ' +
      f((ANG.bandShare(h, 0, 1) + ANG.bandShare(h, 90, 1)) * 100, 2) + '%');
  }
  {
    const h = ANG.wallHistogram(ref.tris);
    check('the PAIR reads 50/50 - which is exactly what one bidirectional layer reads, so the ' +
      'measurement only means something PER LAYER',
      near(ANG.bandShare(h, 45, 1), 0.5, 1e-6) && near(ANG.bandShare(h, 135, 1), 0.5, 1e-6),
      f(ANG.bandShare(h, 45, 1) * 100, 2) + '% at 45, ' + f(ANG.bandShare(h, 135, 1) * 100, 2) + '% at 135');
  }
  /* the widest measured line, at a pitch that carries it */
  {
    const wide = C.build({ W: SIZE, D: SIZE, width: RL.LINE_WIDTH_MAX, pitch: 1.6 });
    const ct = contactOf(wide);
    check('at the widest measured line (' + RL.LINE_WIDTH_MAX + ' mm): every crossing exactly ' +
      f(RL.LINE_WIDTH_MAX * RL.LINE_WIDTH_MAX, 6) + ' mm^2',
      wide.ok && ct.patches === wide.crossings &&
      ct.patchAreas.every(a => near(a, RL.LINE_WIDTH_MAX * RL.LINE_WIDTH_MAX, 1e-5)),
      wide.ok ? ct.patches + ' patches, ' + f(ct.area, 4) + ' mm^2' : wide.reason);
  }
}

/* ------------------------------------------------------------------ part 4 */
console.log('\n=== 4. the angle is a rigid turn, so the contact is invariant ===');
{
  const flat = C.build({ W: SIZE, D: SIZE, angle: 90 });
  const fct = contactOf(flat);
  check('laid out axis-aligned, the footprint is EXACTLY the span the plan claims',
    near(flat.extent[0], flat.spanU, 1e-5) && near(flat.extent[1], flat.spanV, 1e-5),
    flat.extent.map(x => f(x, 4)).join(' x ') + ' mm vs ' + f(flat.spanU, 2) + ' x ' + f(flat.spanV, 2));
  check('turned to 45 deg, the contact is IDENTICAL - same patches, same total, same per patch',
    fct.patches === refCt.patches && near(fct.area, refCt.area, 1e-3) &&
    near(Math.max.apply(null, fct.patchAreas), Math.max.apply(null, refCt.patchAreas), 1e-5),
    f(fct.area, 6) + ' mm^2 / ' + fct.patches + ' at 90 deg   vs   ' + f(refCt.area, 6) + ' / ' + refCt.patches + ' at 45');
  check('only the patch BOX turns: w at 90 deg, w x sqrt2 at 45 - the fourth place the angle shows up',
    near(fct.maxPatchSpan, W, 1e-4) && near(refCt.maxPatchSpan, SPAN45, 1e-3),
    f(fct.maxPatchSpan, 4) + ' mm vs ' + f(refCt.maxPatchSpan, 4) + ' mm');
}

/* ------------------------------------------------------------------ part 5 */
console.log('\n=== 5. the end turn: half a pitch, and what happens below it ===');
{
  console.log('  the turn runs ACROSS its own layer\'s lines, so in the layer above it lies');
  console.log('  PARALLEL to that layer\'s lines. `turnOffset` moves it; the rest is held fixed:');
  const rows = [];
  for (const off of [0.6, 0.42, 0.3]) {
    const b = C.build({ W: SIZE, D: SIZE, turnOffset: off, allowWeldingTurns: true });
    const ct = contactOf(b);
    rows.push({ off, b, ct });
    console.log('    offset ' + f(off, 2) + ' mm (clearance ' + f(b.plan.turnClearance, 2).padStart(5) + ') -> ' +
      String(ct.patches).padStart(3) + ' patches, ' + f(ct.area, 4) + ' mm^2, widest spans ' +
      f(ct.maxPatchSpan, 3) + ' mm');
  }
  check('at half a pitch the turns touch nothing: ' + ref.crossings + ' isolated crossings',
    rows[0].ct.patches === ref.crossings && rows[0].ct.maxPatchSpan <= SPAN45 * 1.005,
    f(rows[0].ct.maxPatchSpan, 4) + ' mm');
  check('at one line width the turn abuts the outermost line and the patches MERGE into welds',
    rows[1].ct.patches < ref.crossings && rows[1].ct.maxPatchSpan > 3 * SPAN45,
    rows[1].ct.patches + ' patches, widest ' + f(rows[1].ct.maxPatchSpan, 3) + ' mm = ' +
    f(rows[1].ct.maxPatchSpan / SPAN45, 1) + ' crossing squares end to end');
  check('below it the turn overlaps the line and the AREA grows too',
    rows[2].ct.area > rows[0].ct.area + 1, f(rows[2].ct.area, 4) + ' vs ' + f(rows[0].ct.area, 4) + ' mm^2');
  const r61 = C.build({ W: SIZE, D: SIZE, width: RL.LINE_WIDTH_MAX });
  check('so a 1.2 mm pitch REFUSES the ' + RL.LINE_WIDTH_MAX + ' mm line by name, it does not build a weld',
    !r61.ok && /clearance -0\.01/.test(r61.reason), String(r61.reason).slice(0, 88) + '...');
  const rfine = C.build({ W: SIZE, D: SIZE, pitch: NSO_Skin.PATTERNS['crosshatch-fine'].defaults.pitch });
  check('and so does crosshatch-fine\'s 0.84 pitch - half of it IS one line width',
    !rfine.ok && /clearance 0 mm/.test(rfine.reason), String(rfine.reason).slice(0, 88) + '...');
  const open = C.build({ W: SIZE, D: SIZE, pitch: 0.84, ends: 'open' });
  const oct = contactOf(open);
  check('ends: "open" is the way out - no turns at all, and it REPORTS the loose lines',
    open.ok && open.components === open.repeatsU + open.repeatsV && oct.patches === open.crossings,
    open.ok ? open.components + ' components, ' + oct.patches + ' crossings of ' +
      f(Math.max.apply(null, oct.patchAreas), 6) + ' mm^2' : open.reason);
  const openRef = C.build({ W: SIZE, D: SIZE, ends: 'open' });
  const orc = contactOf(openRef);
  check('the turns contribute NOTHING to the contact: open and turned give the same figure',
    orc.patches === refCt.patches && near(orc.area, refCt.area, 1e-3),
    f(orc.area, 6) + ' / ' + orc.patches + ' open   vs   ' + f(refCt.area, 6) + ' / ' + refCt.patches + ' turned');
}

/* ------------------------------------------------------------------ part 6 */
console.log('\n=== 6. the canonical checker, tools/mesh_validate.py ===');
{
  const v1 = meshValidate(ref.layers[0].tris, 'layer1');
  check('one layer is watertight with no self-intersection: ' + summary(v1),
    clean(v1) && v1.euler_characteristic === 2);
  check('--gate (the standard closure check): ' + verdictOf(v1),
    verdictOf(meshValidate(ref.layers[0].tris, 'layer1', ['--gate'])) === 'PASS');
  const g42 = meshValidate(ref.layers[0].tris, 'layer1', ['--gate', '--non-solid']);
  const g30 = meshValidate(ref.layers[0].tris, 'layer1', ['--gate', '--non-solid', '--min-wall', String(RL.LINE_HEIGHT)]);
  check('--gate --non-solid at ' + W + ' mm FAILS, and the failure is the ' + RL.LINE_HEIGHT + ' mm layer height itself',
    verdictOf(g42) !== 'PASS' && near(g42.wall.min_wall_mm, RL.LINE_HEIGHT, 1e-6),
    'thinnest ' + f(g42.wall.min_wall_mm, 4) + ' mm: ' + verdictOf(g42));
  check('at the layer height it PASSES - ' + W + ' mm is the NOZZLE figure, not a limit on layer height',
    verdictOf(g30) === 'PASS' && g30.wall.thin_faces === 0,
    'threshold ' + RL.LINE_HEIGHT + ' mm, thin faces ' + g30.wall.thin_faces + ': ' + verdictOf(g30));
  /* the stack, and the repo's own two controls */
  const vTouch = meshValidate(ref.tris, 'touch');
  const apart = C.build({ W: SIZE, D: SIZE });
  const lift = dz => rotateZ(apart.layers[1].tris, 0, 0, 0, dz);
  const vApart = meshValidate(concat(ref.layers[0].tris, lift(0.05)), 'apart');
  const vInto = meshValidate(concat(ref.layers[0].tris, lift(-0.05)), 'into');
  check('control: 0.05 mm apart -> two closed shells, Euler 4, 0 piercing, 0 coplanar',
    vApart.open_edges === 0 && vApart.nonmanifold_edges === 0 && vApart.euler_characteristic === 4 &&
    vApart.self_intersection.pierce === 0 && vApart.self_intersection.coplanar === 0, summary(vApart));
  check('at gap 0 the checker sees contact, and it is exactly 4 coplanar + 8 piercing pairs PER CROSSING',
    vTouch.self_intersection.coplanar === ref.crossings * 4 &&
    vTouch.self_intersection.pierce === ref.crossings * 8 &&
    vTouch.euler_characteristic === 4 && vTouch.open_edges === 0,
    summary(vTouch) + ' (' + ref.crossings + ' crossings)');
  check('  - the same per-crossing signature the raster reference gives, so it scales with the ' +
    'crossings and is the contact, not penetration',
    vTouch.self_intersection.pierce / ref.crossings === 8, f(vTouch.self_intersection.pierce / ref.crossings, 3) +
    ' piercing pairs per crossing');
  check('control: 0.05 mm INTO the layer below -> far more piercing, as penetration must',
    vInto.self_intersection.pierce > vTouch.self_intersection.pierce, summary(vInto));
  check('and the two shells touch bit for bit: layer 1\'s top z == layer 2\'s bottom z',
    near(refCt.plane, RL.LINE_HEIGHT, 1e-9), f(refCt.plane, 9));
}

/* ------------------------------------------------------------------ part 7 */
console.log('\n=== 7. TASK 2 - resizing is a RE-TILE, not a scale ===');
{
  console.log('  fitRepeats: whole repeats only, and the residual is reported rather than absorbed');
  for (const t of [10, 20, 30, 45, 60]) {
    const r = C.fitRepeats(t, 1.2, W, 'nearest');
    console.log('    target ' + String(t).padStart(2) + ' mm -> ' + String(r.repeats).padStart(2) +
      ' repeats, span ' + f(r.span, 2) + ' mm, residual ' + f(r.residual, 3).padStart(6) + ' mm');
  }
  const small = C.build({ W: 20, D: 20 });
  const big = C.retile({ W: 20, D: 20 }, { W: 45, D: 45 });
  check('the span is quantised to the pitch: span = repeats x pitch + width, exactly',
    near(small.spanU, small.repeatsU * small.pitch + small.width, 1e-12) &&
    near(big.spanU, big.repeatsU * big.pitch + big.width, 1e-12),
    f(small.spanU, 4) + ' at ' + small.repeatsU + ' repeats, ' + f(big.spanU, 4) + ' at ' + big.repeatsU);
  check('pitch, line width, height and the open channel are BIT-IDENTICAL across the two sizes',
    small.pitch === big.pitch && small.width === big.width &&
    small.height === big.height && small.channel === big.channel,
    'pitch ' + big.pitch + ', line ' + big.width + ', channel ' + big.channel + ' mm at both');
  check('re-tiling APPENDS repeats: every line the ' + f(small.spanU, 2) + ' mm pattern had is in ' +
    'the same place in the ' + f(big.spanU, 2) + ' mm one, bit for bit',
    small.centresU.every((c, i) => c === big.centresU[i]) && big.repeatsU > small.repeatsU,
    small.repeatsU + ' centres identical, ' + (big.repeatsU - small.repeatsU) + ' appended');
  const smallCt = contactOf(small), bigCt = contactOf(big);
  check('and the crossing is the same crossing at both sizes: ' + f(CROSS, 6) + ' mm^2',
    smallCt.patchAreas.every(a => near(a, CROSS, 1e-5)) &&
    bigCt.patchAreas.every(a => near(a, CROSS, 1e-5)) &&
    smallCt.patches === small.crossings && bigCt.patches === big.crossings,
    small.crossings + ' crossings -> ' + big.crossings + ', every one ' +
    f(Math.max.apply(null, bigCt.patchAreas), 6) + ' mm^2');

  /* the two axes re-tile independently - the fixtures are square, this is not */
  {
    const ob = C.build({ W: 20, D: 40 });
    const oct = contactOf(ob);
    check('an oblong footprint re-tiles each axis on its own: ' + ob.repeatsU + ' x ' + ob.repeatsV +
      ' lines, ' + ob.crossings + ' crossings',
      ob.ok && oct.patches === ob.crossings && near(oct.area, ob.contactPredicted, 1e-3) &&
      oct.maxPatchSpan <= SPAN45 * 1.005 &&
      ob.centresU.every((c, i) => c === ob.centresV[i]),
      f(ob.spanU, 2) + ' x ' + f(ob.spanV, 2) + ' mm, ' + f(oct.area, 4) + ' mm^2 in ' +
      oct.patches + ' patches - and the two axes lay their lines out on the same rule');
  }

  /* THE CONTROL: the design pattern this replaces. Scale the small solid to the
     big one's span and measure what it did to the pattern. */
  const k = big.spanU / small.spanU;
  const scaled = new Float32Array(small.tris.length);
  for (let i = 0; i < small.tris.length; i++) scaled[i] = small.tris[i] * k;
  const sBox = RL.extentOf(scaled);
  console.log('  the control - the same 20 mm build SCALED by ' + f(k, 4) + ' to reach the same span:');
  console.log('    line width  ' + f(W * k, 4) + ' mm (asked for ' + W + ')      channel ' +
    f(small.channel * k, 4) + ' mm (asked for ' + small.channel + ')');
  console.log('    height      ' + f(sBox[2], 4) + ' mm (asked for ' + f(2 * RL.LINE_HEIGHT, 2) + ')');
  check('a scale moves EVERY figure the pattern is made of - width, channel, pitch and height',
    !near(W * k, W, 1e-6) && !near(small.channel * k, small.channel, 1e-6) &&
    !near(sBox[2], 2 * RL.LINE_HEIGHT, 1e-6),
    'width ' + W + ' -> ' + f(W * k, 4) + ', channel ' + small.channel + ' -> ' + f(small.channel * k, 4) +
    ', height ' + f(2 * RL.LINE_HEIGHT, 2) + ' -> ' + f(sBox[2], 4) + ' mm');
  check('  - and the crossing with it: ' + f(CROSS * k * k, 6) + ' mm^2 instead of ' + f(CROSS, 6),
    !near(CROSS * k * k, CROSS, 1e-6) && near(CROSS * k * k / CROSS, k * k, 1e-9),
    f(k * k, 4) + 'x per crossing, and ' + f(k * k, 4) + 'x on the same ' + small.crossings + ' of them');
  check('the re-tile changes the ONE thing that should change: the number of repeats',
    big.repeatsU !== small.repeatsU && big.width === small.width &&
    near(big.extent[2], small.extent[2], 1e-9),
    small.repeatsU + ' -> ' + big.repeatsU + ' repeats, everything else held');

  /* Does a re-tile need the raster tracer? Measured rather than argued. */
  console.log('  the raster round trip - this module\'s own paths stroked into a canvas sized for');
  console.log('  the pattern, thresholded, thinned, traced back, and built at the same fixed width:');
  for (const [pl, label] of [[C.plan({ W: 20, D: 20 }), '20 mm'], [C.plan({ W: 30, D: 30 }), '30 mm']]) {
    const paths = C.layerPaths(pl, 1);
    const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const p of paths) for (const q of p) for (let k2 = 0; k2 < 2; k2++) {
      if (q[k2] < lo[k2]) lo[k2] = q[k2];
      if (q[k2] > hi[k2]) hi[k2] = q[k2];
    }
    const canvas = Math.ceil(Math.max(hi[0] - lo[0], hi[1] - lo[1]) + 2 * F.MARGIN);
    const shifted = paths.map(p => p.map(q => [q[0] - lo[0] + F.MARGIN, q[1] - lo[1] + F.MARGIN]));
    const img = F.stroke(shifted, { strokePx: 5, ppmm: F.PPMM, size: canvas });
    const traced = RL.buildFromImage(img, { mmPerPixel: 1 / F.PPMM, simplify: 1.5 });
    const direct = RL.extrudeFlat(paths, { width: pl.width, height: pl.height });
    console.log('    ' + label + ' target -> a ' + canvas + ' mm canvas at ' + F.PPMM + ' px/mm (' +
      img.width + ' px): traced ' + traced.segments + ' segments / ' + traced.tris_count +
      ' tris, laid out directly ' + direct.segments + ' / ' + direct.tris_count);
    check('  re-tracing the ' + label + ' canvas gives back the same layer: same segments, same ' +
      'triangles, the same ' + pl.width + ' mm line',
      traced.ok && traced.segments === direct.segments && traced.tris_count === direct.tris_count &&
      traced.width === direct.width && near(traced.lineLength, direct.lineLength, 0.008 * direct.lineLength),
      traced.ok ? 'line length ' + f(traced.lineLength, 2) + ' vs ' + f(direct.lineLength, 2) + ' mm (' +
        f(100 * Math.abs(traced.lineLength - direct.lineLength) / direct.lineLength, 3) +
        '%, against the 0.8% the raster suite holds three strokes to)' : traced.reason);
  }
  console.log('  So the raster path WOULD re-tile correctly - it is just the longer way round to a');
  console.log('  path three numbers already give exactly. The layout ships; the round trip is a check.');
}

/* ------------------------------------------------------------------ part 8 */
console.log('\n=== 8. it loads as a classic script, on window ===');
{
  const sandbox = { window: {}, console: console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of ['nso_raster_lines.js', 'nso_crosshatch.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  }
  check('window.NSO_Crosshatch exists and carries the API',
    !!sandbox.window.NSO_Crosshatch && typeof sandbox.window.NSO_Crosshatch.build === 'function' &&
    typeof sandbox.window.NSO_Crosshatch.oneDirection === 'function',
    Object.keys(sandbox.window.NSO_Crosshatch || {}).join(', '));
  const r = sandbox.window.NSO_Crosshatch.build({ W: SIZE, D: SIZE });
  check('and builds the same thing in the browser as under Node',
    r.ok && r.tris_count === ref.tris_count && r.crossings === ref.crossings &&
    near(r.spanU, ref.spanU, 1e-12), r.ok ? r.describe : r.reason);
}

/* ------------------------------------------------------------------ part 9 */
console.log('\n=== 9. the committed fixtures are what this code builds today ===');
{
  let out = '', ok = true;
  try {
    out = execFileSync('node', [path.join(ROOT, 'tools', 'nso_crosshatch_fixtures.js'), '--check'],
      { encoding: 'utf8' });
  } catch (e) { ok = false; out = String(e.stdout || e.message); }
  check('fixtures/crosshatch/ byte-matches', ok && /fixtures match/.test(out),
    out.trim().split('\n').slice(-1)[0]);
  const idx = JSON.parse(fs.readFileSync(path.join(FX.OUT, 'crosshatch.json'), 'utf8'));
  const e0 = idx.entries[0], e1 = idx.entries[1];
  check('the two entries are the same pattern at two sizes - one re-tile apart',
    e0.pitch_mm === e1.pitch_mm && e0.line_width_mm === e1.line_width_mm &&
    e0.channel_mm === e1.channel_mm && e0.repeats[0] !== e1.repeats[0] &&
    e0.line_centres_mm.every((c, i) => c === e1.line_centres_mm[i]),
    e0.repeats[0] + ' -> ' + e1.repeats[0] + ' repeats, pitch/width/channel and the first ' +
    e0.line_centres_mm.length + ' centres unchanged');
  check('and the recorded contact is the crossings and nothing else, at both sizes',
    e0.contact.contact_patches === e0.crossings && e1.contact.contact_patches === e1.crossings &&
    near(e0.contact.patch_area_max_mm2, CROSS, 1e-5) && near(e1.contact.patch_area_max_mm2, CROSS, 1e-5) &&
    e0.contact.widest_patch_span_mm <= SPAN45 * 1.005 && e1.contact.widest_patch_span_mm <= SPAN45 * 1.005,
    e0.contact.contact_patches + ' and ' + e1.contact.contact_patches + ' patches of ' +
    f(e1.contact.patch_area_max_mm2, 6) + ' mm^2');
}

console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'all checks held') + '\n');
process.exit(fails ? 1 : 0);
