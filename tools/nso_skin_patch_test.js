/* A skin pattern as its own printable object: both variants, all three
   patterns, every mesh through the canonical checker.
     node tools/nso_skin_patch_test.js      exit 0 = every gate held

   Part 1 - the audit this feature rests on (Task 1), asserted rather than
     described. The relief IS an independent structure: the same 30 x 30 face
     gives BIT-IDENTICAL relief triangles on two hosts that differ everywhere
     else. And it is NOT a printable object on its own: taken alone it is a
     zero-thickness open sheet, Euler 1, with the pattern's height and nothing
     below it. Both halves are pinned, because the design follows from the
     second one - the extraction path has to give the relief a host of its own.
   Part 2 - the bordered washer: one closed shell, Euler 2, 0 piercing, the
     rim proud of the tips, the pocket floor really carrying the relief, and
     the refusal at margin 0 (where the pattern's end walls land in the pocket
     wall's own plane - 2488 piercing pairs before the guard).
   Part 3 - the loose patch: closed, real walls, no backing plate (measured as
     volume, not asserted), the ties that make a zigzag one component instead
     of 15, and the foot without which the zigzag's flank reads 0.367 mm.
   Part 4 - the canonical checker on all six, twice: --gate (the standard
     closure check) and --gate --non-solid (which trades the open-edge count
     for the 0.42 mm wall/gap check). Both must pass, which is the answer to
     "should it be flagged": the flag is not what stands between these files
     and a pass.
   Part 5 - the committed fixtures are what this code builds today.
   Part 6 - degenerate geometry: no zero-area triangles, no sliver, and every
     triangle's shortest edge above the weld radius. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const NSO_Skin = require('../nso_skin.js');
const NSO_SkinPatch = require('../nso_skin_patch.js');
const { writeSTL } = require('./nso_stl_io.js');
const { box } = require('./nso_skin_samples.js');
const { buildOne, PATTERNS, VARIANTS, signedVolume } = require('./nso_skin_patch_samples.js');

const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-skinpatch-'));

function meshValidate(file, extra) {
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'].concat(extra || []);
  return JSON.parse(execFileSync('python3', args, { encoding: 'utf8', maxBuffer: 64 << 20 }));
}
function validate(soup, tag, extra) {
  const f = path.join(tmp, tag + '.stl');
  writeSTL(f, soup, tag);
  return meshValidate(f, extra);
}
const summary = v => 'tris ' + v.triangles + ', open ' + v.open_edges + ', nm ' + v.nonmanifold_edges +
  ', euler ' + v.euler_characteristic + ', degen ' + v.degenerate_tris +
  ', pierce ' + v.self_intersection.pierce + ', bbox ' + JSON.stringify(v.bbox_size);
const verdictOf = v => (v.verdict_fails && v.verdict_fails.length) ? v.verdict_fails.join('; ') : 'PASS';

/* ------------------------------------------------------------------ part 1 */
console.log('\n=== 1. the audit: the relief is independent, and it is a sheet ===');
{
  /* the relief triangles of a result, as a key set: everything at or above
     the skinned face's own plane */
  const key = (s, t) => Array.from(s.slice(t * 9, t * 9 + 9)).map(x => x.toFixed(6)).join(',');
  const reliefSet = (soup, baseZ) => {
    const set = new Set();
    for (let t = 0; t < soup.length / 9; t++) {
      let zmin = Infinity;
      for (let k = 0; k < 3; k++) zmin = Math.min(zmin, soup[t * 9 + k * 3 + 2]);
      if (zmin >= baseZ - 1e-6) set.add(key(soup, t));
    }
    return set;
  };
  for (const pattern of PATTERNS) {
    /* two hosts under the same 30 x 30 +Z face: an 8 mm block and a 2 mm plate */
    const r1 = NSO_Skin.applySkinToFace(box(-15, 15, -15, 15, 0, 8), { dir: [0, 0, 1], pattern });
    const r2 = NSO_Skin.applySkinToFace(box(-15, 15, -15, 15, 0, 2), { dir: [0, 0, 1], pattern });
    check(pattern + ': both hosts skinned', r1.ok && r2.ok, (r1.reason || '') + (r2.reason || ''));
    const shifted = new Float32Array(r2.tris);
    for (let i = 2; i < shifted.length; i += 3) shifted[i] += 6;
    const a = reliefSet(r1.tris, 8), b = reliefSet(shifted, 8);
    let same = a.size === b.size && a.size > 0;
    if (same) for (const k of a) if (!b.has(k)) { same = false; break; }
    check(pattern + ': relief is BIT-IDENTICAL across two different hosts', same,
      a.size + ' vs ' + b.size + ' triangles, host wall fans ' + r1.wallTrisFanned + '/' + r2.wallTrisFanned);

    /* the same relief, alone: an open sheet with no underside */
    const keep = [];
    for (let t = 0; t < r1.tris.length / 9; t++) {
      let zmin = Infinity;
      for (let k = 0; k < 3; k++) zmin = Math.min(zmin, r1.tris[t * 9 + k * 3 + 2]);
      if (zmin >= 8 - 1e-6) for (let i = 0; i < 9; i++) keep.push(r1.tris[t * 9 + i]);
    }
    const v = validate(new Float32Array(keep), 'relief_only_' + pattern);
    check(pattern + ': the relief ALONE is an open sheet, not a solid',
      v.open_edges > 0 && v.euler_characteristic === 1 && near(v.bbox_size[2], r1.tipHeight, 1e-5),
      'open ' + v.open_edges + ', euler ' + v.euler_characteristic + ', z extent ' + v.bbox_size[2] +
      ' = the skin height exactly, nothing below it');
  }
}

/* ------------------------------------------------------------------ part 2 */
console.log('\n=== 2. the bordered washer ===');
for (const pattern of PATTERNS) {
  const r = NSO_SkinPatch.buildPatch({ variant: 'bordered', pattern });
  check(pattern + ': built', r.ok, r.reason);
  if (!r.ok) continue;
  const v = validate(r.tris, 'bordered_' + pattern);
  check(pattern + ': ONE closed shell, Euler 2, 0 piercing',
    v.open_edges === 0 && v.nonmanifold_edges === 0 && v.euler_characteristic === 2 &&
    v.self_intersection.pierce === 0 && r.components === 1, summary(v));
  check(pattern + ': the rim stands ' + NSO_SkinPatch.PROUD + ' mm PROUD of the tips',
    near(r.rimTopZ - r.tipsZ, r.proud, 1e-6) && r.rimTopZ > r.tipsZ,
    'rim top ' + r.rimTopZ.toFixed(3) + ' vs tips ' + r.tipsZ.toFixed(3));
  check(pattern + ': the relief really is on the pocket floor',
    near(r.pocket.floorZ, r.floor, 1e-9) && near(r.tipsZ, r.floor + r.tipHeight, 1e-6) &&
    r.tipArea > 0, 'floor z ' + r.floor + ', tips ' + r.tipsZ.toFixed(3) + ', contact ' + r.tipArea.toFixed(2) + ' mm²');
  check(pattern + ': overall ' + NSO_SkinPatch.SIZE + ' x ' + NSO_SkinPatch.SIZE + ' mm, rim ' + r.rim + ' mm',
    near(v.bbox_size[0], NSO_SkinPatch.SIZE, 1e-4) && near(v.bbox_size[1], NSO_SkinPatch.SIZE, 1e-4) &&
    near(v.bbox_size[2], r.rimTopZ, 1e-4), JSON.stringify(v.bbox_size));
  check(pattern + ': every wall it adds is at least one extrusion line',
    r.minWall >= NSO_SkinPatch.MIN_WALL - 1e-9, r.minWall + ' mm (rim ' + r.rim + ', floor ' + r.floor + ')');
  check(pattern + ': not advised non-solid - the rim closes it', r.nonSolidAdvised === false);
}
{
  const bad = NSO_SkinPatch.buildPatch({ variant: 'bordered', pattern: 'crosshatch', margin: 0 });
  check('margin 0 is refused (the pattern would land in the pocket wall\'s plane)',
    bad.ok === false && /margin > 0/.test(bad.reason), bad.reason);
  const thin = NSO_SkinPatch.buildPatch({ variant: 'bordered', pattern: 'crosshatch', rim: 0.2 });
  check('a rim under one extrusion line is refused', thin.ok === false && /rim wall/.test(thin.reason), thin.reason);
  const nofit = NSO_SkinPatch.buildPatch({ variant: 'bordered', pattern: 'ring', W: 8, D: 8 });
  check('a ring that does not fit the pocket is refused, not clipped', nofit.ok === false, nofit.reason);
}

/* ------------------------------------------------------------------ part 3 */
console.log('\n=== 3. the loose patch ===');
for (const pattern of PATTERNS) {
  const r = NSO_SkinPatch.buildPatch({ variant: 'loose', pattern });
  check(pattern + ': built', r.ok, r.reason);
  if (!r.ok) continue;
  const v = validate(r.tris, 'loose_' + pattern);
  check(pattern + ': closed - 0 open, 0 non-manifold, 0 piercing',
    v.open_edges === 0 && v.nonmanifold_edges === 0 && v.self_intersection.pierce === 0, summary(v));
  check(pattern + ': ONE component, so it is a patch and not loose sticks',
    r.components === 1, r.components + (r.ties ? ' (on ' + r.ties + ' tie(s))' : ''));
  check(pattern + ': real walls, at least one extrusion line',
    r.minWall >= NSO_SkinPatch.MIN_WALL - 1e-9, r.minWall + ' mm, tapering to ' + r.tipWall);
  check(pattern + ': genuine thickness, not a surface - height ' + r.height.toFixed(2) + ' mm',
    near(v.bbox_size[2], r.height, 1e-4) && v.bbox_size[2] > 0 && Math.abs(v.signed_volume) > 0,
    'z ' + v.bbox_size[2] + ', volume ' + v.signed_volume.toFixed(3));
  /* NO BACKING PLATE: a full plate over the footprint would be at least
     footprint x back; the patch is a small fraction of its own bounding box. */
  const bboxVol = v.bbox_size[0] * v.bbox_size[1] * v.bbox_size[2];
  check(pattern + ': no backing plate - the gaps between features are empty',
    Math.abs(v.signed_volume) < 0.6 * bboxVol,
    'volume ' + Math.abs(v.signed_volume).toFixed(2) + ' of a ' + bboxVol.toFixed(2) + ' mm³ box = ' +
    (100 * Math.abs(v.signed_volume) / bboxVol).toFixed(1) + '%');
  check(pattern + ': advised non-solid (a free-standing one-line lattice)', r.nonSolidAdvised === true);
  /* the volume ANALYTICALLY, which is the hard version of "no backing plate":
     a plate would add footprint x thickness and there is nowhere for it to
     hide in a closed form. The crosshatch's ribs are prismatic, so its solid
     is exactly its tip area times its height; the ring's is the tapered
     annulus looseRing computes from its own radii. */
  if (pattern === 'crosshatch') {
    check(pattern + ': volume IS tip area x height exactly - prismatic ribs, no plate',
      near(Math.abs(v.signed_volume), r.tipArea * r.tipHeight, 1e-3),
      v.signed_volume.toFixed(4) + ' vs ' + (r.tipArea * r.tipHeight).toFixed(4) + ' mm³ (' +
      r.info.ribsU + ' + ' + r.info.ribsV + ' ribs)');
  }
  if (pattern === 'ring') {
    /* against the POLYGONAL volume, not the circular one: the ring is built
       from `segments` flat facets, so a regular n-gon's area ratio to its
       circumcircle - (n/2pi) sin(2pi/n), 0.999283 at the default 96 - is the
       honest figure for the mesh that exists. Comparing to pi r² instead
       leaves a 0.0124 mm³ gap that is the tessellation, not a defect. */
    const n = r.params.segments;
    const ngon = (n / (2 * Math.PI)) * Math.sin(2 * Math.PI / n);
    check(pattern + ': volume IS the analytic tapered annulus, at ' + n + ' segments',
      near(Math.abs(v.signed_volume), r.info.volume * ngon, 1e-3),
      v.signed_volume.toFixed(4) + ' vs ' + (r.info.volume * ngon).toFixed(4) +
      ' mm³ (circular ' + r.info.volume.toFixed(4) + ' x ' + ngon.toFixed(6) + ')');
  }
}
{
  /* the ties, and what the patch is without them */
  const tied = NSO_SkinPatch.buildPatch({ variant: 'loose', pattern: 'zigzag' });
  const untied = NSO_SkinPatch.buildPatch({ variant: 'loose', pattern: 'zigzag', ties: 0 });
  check('zigzag with ties: 0 really is separate ridges',
    untied.ok && untied.components === untied.info.ridges && untied.components > 1,
    untied.components + ' components, ' + untied.info.ridges + ' ridges');
  check('the ties turn them into ONE component', tied.components === 1 && tied.ties === 2,
    tied.ties + ' ties ' + tied.tieWidth + ' mm wide');
  const vu = validate(untied.tris, 'loose_zigzag_untied');
  check('and the untied one is still closed, just several shells',
    vu.open_edges === 0 && vu.self_intersection.pierce === 0 &&
    vu.euler_characteristic === 2 * untied.components, summary(vu));
  /* the foot: without it the flank reads under one extrusion line */
  const noFoot = NSO_SkinPatch.buildPatch({ variant: 'loose', pattern: 'zigzag', back: 0 });
  const vn = validate(noFoot.tris, 'loose_zigzag_nofoot', ['--non-solid']);
  check('without the foot the zigzag flank reads under 0.42 mm - the reason it exists',
    vn.wall && vn.wall.thin_faces > 0 && vn.wall.min_wall_mm < NSO_SkinPatch.MIN_WALL,
    'thinnest ' + (vn.wall ? vn.wall.min_wall_mm.toFixed(3) : '?') + ' mm on ' +
    (vn.wall ? vn.wall.thin_faces : '?') + ' face(s), and it is still closed (open ' + vn.open_edges + ')');
  const vf = validate(tied.tris, 'loose_zigzag_foot', ['--non-solid']);
  check('with the ' + tied.back + ' mm foot it reads at or above 0.42 mm',
    vf.wall && vf.wall.thin_faces === 0 && vf.wall.min_wall_mm >= NSO_SkinPatch.MIN_WALL - 1e-4,
    'thinnest ' + (vf.wall ? vf.wall.min_wall_mm.toFixed(4) : '?') + ' mm');
  check('the crosshatch needs no foot (prismatic ribs) and the ring none either',
    NSO_SkinPatch.LOOSE_BACK.crosshatch === 0 && NSO_SkinPatch.LOOSE_BACK.ring === 0 &&
    NSO_SkinPatch.LOOSE_BACK.zigzag === NSO_SkinPatch.MIN_WALL, JSON.stringify(NSO_SkinPatch.LOOSE_BACK));
  /* no pattern here may put a third height on a shared edge mid-span */
  let cross = 0;
  for (const pattern of ['crosshatch', 'zigzag']) {
    const r = NSO_SkinPatch.buildPatch({ variant: 'loose', pattern });
    cross += r.info.crossings || 0;
  }
  check('no wall crossing (which would need a vertex the cell tops do not have)', cross === 0, cross);
}

/* ------------------------------------------------------------------ part 4 */
console.log('\n=== 4. the canonical checker on all six, both ways ===');
for (const pattern of PATTERNS) {
  for (const variant of VARIANTS) {
    const r = NSO_SkinPatch.buildPatch({ variant, pattern });
    if (!r.ok) { check(variant + ' ' + pattern + ': built', false, r.reason); continue; }
    const plain = validate(r.tris, 'gate_' + variant + '_' + pattern);
    const flagged = validate(r.tris, 'gate_' + variant + '_' + pattern, ['--non-solid']);
    check(variant + ' ' + pattern + ': --gate (standard closure) PASS',
      plain.verdict_fails.length === 0, verdictOf(plain));
    check(variant + ' ' + pattern + ': --gate --non-solid (wall/gap at ' +
      NSO_SkinPatch.MIN_WALL + ' mm) PASS',
      flagged.verdict_fails.length === 0,
      verdictOf(flagged) + ' - wall ' + (flagged.wall && flagged.wall.min_wall_mm !== null
        ? flagged.wall.min_wall_mm.toFixed(4) + ' mm, ' + flagged.wall.sheet_faces + ' sheet face(s)'
        : 'none within probe'));
  }
}

/* ------------------------------------------------------------------ part 5 */
console.log('\n=== 5. the committed fixtures are what this code builds ===');
{
  const dir = path.join(ROOT, 'fixtures', 'skin-patches');
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'skin-patches.json'), 'utf8'));
  for (const pattern of PATTERNS) for (const variant of VARIANTS) {
    const kk = pattern + '_' + variant;
    const want = mf.patches[kk];
    check(kk + ': in the manifest', !!want);
    if (!want) continue;
    const file = path.join(dir, want.file);
    check(kk + ': ' + want.file + ' committed', fs.existsSync(file));
    if (!fs.existsSync(file)) continue;
    const fresh = buildOne(pattern, variant);
    const tmpf = path.join(tmp, 'fx_' + kk + '.stl');
    writeSTL(tmpf, fresh.tris, 'NSO skin patch ' + variant + ' ' + pattern);
    check(kk + ': byte-identical to a fresh build',
      fs.readFileSync(file).equals(fs.readFileSync(tmpf)));
    check(kk + ': manifest numbers match the build',
      want.tris === fresh.meta.tris && want.components === fresh.meta.components &&
      near(want.tip_area_mm2, fresh.meta.tip_area_mm2, 1e-6) &&
      want.min_wall_mm === fresh.meta.min_wall_mm &&
      want.non_solid_advised === fresh.meta.non_solid_advised,
      'tris ' + want.tris + ', comp ' + want.components + ', contact ' + want.tip_area_mm2.toFixed(3) +
      ' mm², wall ' + want.min_wall_mm + ', non-solid advised ' + want.non_solid_advised);
    const v = meshValidate(file, ['--non-solid']);
    check(kk + ': the committed file passes --gate --non-solid too', v.verdict_fails.length === 0, verdictOf(v));
  }
}

/* ------------------------------------------------------------------ part 6 */
console.log('\n=== 6. no degenerate geometry ===');
for (const pattern of PATTERNS) for (const variant of VARIANTS) {
  const r = NSO_SkinPatch.buildPatch({ variant, pattern });
  if (!r.ok) continue;
  let zeroArea = 0, shortest = Infinity, smallest = Infinity;
  for (let t = 0; t < r.tris.length / 9; t++) {
    const p = [0, 1, 2].map(k => [r.tris[t * 9 + k * 3], r.tris[t * 9 + k * 3 + 1], r.tris[t * 9 + k * 3 + 2]]);
    const e = [0, 1, 2].map(k => {
      const a = p[k], b = p[(k + 1) % 3];
      return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    });
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const w = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const area = 0.5 * Math.hypot(n[0], n[1], n[2]);
    if (area < 1e-12) zeroArea++;
    if (area < smallest) smallest = area;
    shortest = Math.min(shortest, Math.min(e[0], e[1], e[2]));
  }
  check(variant + ' ' + pattern + ': no zero-area triangle, no edge under the weld radius',
    zeroArea === 0 && shortest > 1e-4,
    'smallest area ' + smallest.toExponential(2) + ' mm², shortest edge ' + shortest.toFixed(4) + ' mm');
}

console.log('\nfiles: ' + tmp);
if (fails) { console.log('\n' + fails + ' gate(s) FAILED'); process.exit(1); }
console.log('\nall gates held');
