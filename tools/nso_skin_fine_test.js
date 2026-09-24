/* The tighter crosshatch pitch, and the double-sided sandwich patch.
     node tools/nso_skin_fine_test.js      exit 0 = every gate held

   Part 1 - the audit (Task 1), asserted rather than described. `pitch` was
     ALREADY a parameter of the crosshatch, and the preset changes that one
     number and nothing else. The shipped 1.2 default is untouched, and every
     committed fixture still builds byte-identically.
   Part 2 - THE MEASUREMENT THAT DECIDES THE FEATURE: the open channel between
     ribs. mesh_validate.py's wall check cannot see it (it rays INWARD, so on
     a rib side wall it measures the rib's own 0.42 and reports a clean pass
     at every pitch down to 0.5, where the channel is 0.08 mm). Reversing the
     winding turns the same unmodified algorithm around and it measures the
     air instead. That number, against the repo's own nozzle line widths, is
     what says 0.84 is the floor at a 0.4 nozzle and 0.5-0.6 is not reachable.
   Part 3 - the canonical checker on every new piece, twice: --gate and
     --gate --non-solid.
   Part 4 - the sandwich patch is really double-sided: the two contact areas
     measured OFF THE MESH and equal, no floor membrane (volume is exactly
     contact x height - a plate has nowhere to hide in a closed form), one
     component, the frame really butted to the first rib, and the refusals for
     the patterns that are not prismatic.
   Part 5 - the library files are what this code builds, and the six copied
     ones are byte-identical to the gated fixtures.
   Part 6 - no degenerate geometry at the tighter pitch. */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const NSO_Skin = require('../nso_skin.js');
const NSO_SkinPatch = require('../nso_skin_patch.js');
const NSO_Thickness = require('../nso_thickness.js');
const { writeSTL } = require('./nso_stl_io.js');
const fine = require('./nso_skin_fine_samples.js');
const LIBDIR = require('./nso_library_dir');

const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-skinfine-'));

function meshValidate(file, extra) {
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'].concat(extra || []);
  return JSON.parse(execFileSync('python3', args, { encoding: 'utf8', maxBuffer: 256 << 20 }));
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

/* One extrusion line, the repo's own figure, for the two nozzles in use. */
const LINE_04 = NSO_Thickness.floorFor(0.4);   /* 0.42 */
const LINE_06 = NSO_Thickness.floorFor(0.6);   /* 0.63 */

/* ---------------------------------------------------------------- the trick

   mesh_validate.wall_thickness casts from every triangle's centroid along the
   INWARD normal - into the material - so on a rib's side wall it measures the
   rib and stops. The channel to the NEXT rib is on the other side of that
   face and no ray ever goes there. Reverse every triangle's winding and each
   normal flips, so the same unmodified checker rays outward: off a rib's side
   wall, across the gap, onto the facing rib. The distance it returns is the
   open channel. Nothing in mesh_validate.py is patched to do this - it is the
   shipped algorithm handed a mirrored input. */
function reverseWinding(s) {
  const o = new Float32Array(s.length);
  for (let i = 0; i < s.length; i += 9) {
    o[i] = s[i]; o[i + 1] = s[i + 1]; o[i + 2] = s[i + 2];
    o[i + 3] = s[i + 6]; o[i + 4] = s[i + 7]; o[i + 5] = s[i + 8];
    o[i + 6] = s[i + 3]; o[i + 7] = s[i + 4]; o[i + 8] = s[i + 5];
  }
  return o;
}
function channelOf(soup, tag) {
  const f = path.join(tmp, tag + '_rev.stl');
  writeSTL(f, reverseWinding(soup), tag);
  const j = meshValidate(f, ['--min-wall', String(LINE_06), '--wall-probe', '3']);
  return j.wall.min_wall_mm;
}

/* face areas at a given z, measured off the mesh - the builder is not asked */
function areaAtZ(soup, z, tol) {
  let a = 0;
  for (let i = 0; i < soup.length; i += 9) {
    if (Math.abs(soup[i + 2] - z) > tol || Math.abs(soup[i + 5] - z) > tol ||
        Math.abs(soup[i + 8] - z) > tol) continue;
    const ux = soup[i + 3] - soup[i], uy = soup[i + 4] - soup[i + 1];
    const vx = soup[i + 6] - soup[i], vy = soup[i + 7] - soup[i + 1];
    a += Math.abs(ux * vy - uy * vx) / 2;
  }
  return a;
}
function signedVolume(s) {
  let v = 0;
  for (let o = 0; o < s.length; o += 9) {
    v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7])
       - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6])
       + s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]);
  }
  return v / 6;
}

/* ------------------------------------------------------------------ part 1 */
console.log('=== 1. the audit: pitch was already a parameter, and only pitch moved ===');
{
  const base = NSO_Skin.PATTERNS.crosshatch.defaults;
  const fineD = NSO_Skin.PATTERNS['crosshatch-fine'].defaults;
  check('the shipped crosshatch default is STILL 1.2 mm pitch / 0.42 mm rib',
    base.pitch === 1.2 && base.rib === 0.42 && base.height === 0.6 && base.margin === null,
    JSON.stringify(base));
  check('the preset changes PITCH and nothing else',
    fineD.pitch === 0.84 && fineD.rib === base.rib && fineD.height === base.height &&
    fineD.margin === base.margin, JSON.stringify(fineD));
  check('pitch was reachable as a parameter all along - withDefaults honours it',
    NSO_Skin.withDefaults('crosshatch', { pitch: 0.84 }).pitch === 0.84 &&
    NSO_Skin.withDefaults('crosshatch').pitch === 1.2,
    'crosshatch at params {pitch:0.84} == the preset\'s geometry');
  /* and the proof that "a preset" is not "a second builder" */
  const viaParam = NSO_SkinPatch.buildPatch({ variant: 'loose', pattern: 'crosshatch', params: { pitch: 0.84 } });
  const viaName = NSO_SkinPatch.buildPatch({ variant: 'loose', pattern: 'crosshatch-fine' });
  let same = viaParam.ok && viaName.ok && viaParam.tris.length === viaName.tris.length;
  if (same) for (let i = 0; i < viaParam.tris.length; i++) if (viaParam.tris[i] !== viaName.tris[i]) { same = false; break; }
  check('the preset is BIT-IDENTICAL to the shipped crosshatch at pitch 0.84',
    same, viaName.tris_count + ' triangles, every one equal');
  check('the preset uses the crosshatch family, so no builder was added',
    NSO_Skin.familyOf('crosshatch-fine') === 'crosshatch' &&
    NSO_Skin.familyOf('zigzag') === 'zigzag' && NSO_Skin.familyOf('ring') === 'ring');
  check('an unknown name still answers with itself, so every refusal still fires',
    NSO_Skin.familyOf('nope') === 'nope' &&
    NSO_SkinPatch.buildPatch({ pattern: 'nope' }).ok === false);
}

/* ------------------------------------------------------------------ part 2 */
console.log('\n=== 2. the open channel between ribs - the number that decides it ===');
{
  /* First: show the canonical wall check CANNOT answer this, so the pass it
     gives at an unprintable pitch is never mistaken for evidence. */
  const tight = NSO_SkinPatch.buildPatch({ variant: 'loose', pattern: 'crosshatch', params: { pitch: 0.5 } });
  const w = validate(tight.tris, 'wall_p050', ['--non-solid']);
  check('the canonical wall check PASSES a 0.08 mm channel - it rays inward and measures the RIB',
    w.verdict_fails.length === 0 && near(w.wall.min_wall_mm, 0.42, 2e-3) && w.wall.thin_faces === 0,
    'reports ' + w.wall.min_wall_mm.toFixed(4) + ' mm (the rib), not 0.08 mm (the channel)');
  const ch = channelOf(tight.tris, 'chan_p050');
  check('...and reversed, the SAME checker measures the channel: 0.08 mm',
    near(ch, 0.08, 2e-3), ch.toFixed(4) + ' mm');
}
{
  const rows = [];
  for (const pitch of [1.2, 1.05, 0.92, 0.84]) {
    const r = NSO_SkinPatch.buildPatch({ variant: 'loose', pattern: 'crosshatch', params: { pitch } });
    const ch = channelOf(r.tris, 'chan_' + String(pitch).replace('.', 'p'));
    rows.push({ pitch, ch });
    check('pitch ' + pitch.toFixed(2) + ': channel measures pitch - rib exactly',
      near(ch, pitch - 0.42, 2e-3), ch.toFixed(4) + ' mm');
  }
  const fineCh = rows[rows.length - 1].ch;
  check('at the preset\'s 0.84, the channel is one FULL 0.4-nozzle extrusion line',
    fineCh >= LINE_04 - 1e-3, fineCh.toFixed(4) + ' mm vs ' + LINE_04 + ' mm = ' +
    (fineCh / LINE_04).toFixed(2) + 'x');
  check('0.84 is the FLOOR at a 0.4 nozzle - one step tighter (0.7) is under the line',
    (0.7 - 0.42) < LINE_04 && (0.84 - 0.42) >= LINE_04 - 1e-9,
    '0.7 pitch leaves ' + (0.7 - 0.42).toFixed(2) + ' mm = ' + ((0.7 - 0.42) / LINE_04).toFixed(2) + 'x a line');
  /* the honest ceiling: the target that was asked for, and why it is not it */
  for (const pitch of [0.6, 0.5]) {
    check('the asked-for ' + pitch.toFixed(2) + ' mm pitch is PAST the limit, not merely tight',
      (pitch - 0.42) < LINE_04,
      (pitch - 0.42).toFixed(2) + ' mm channel = ' + ((pitch - 0.42) / LINE_04).toFixed(2) +
      'x one 0.4-nozzle line (' + (LINE_04 / (pitch - 0.42)).toFixed(1) + 'x too tight)');
  }
  /* the 0.6 nozzle, which is why 1.2 stays the default */
  check('at a 0.6 nozzle one line is ' + LINE_06 + ' mm, so even 0.84 is NOT printable there',
    (0.84 - 0.42) < LINE_06, '0.42 mm channel = ' + ((0.84 - 0.42) / LINE_06).toFixed(2) + 'x a 0.6 line');
  check('the shipped 1.2 default is the one that clears a 0.6 nozzle - which is why it stays default',
    (1.2 - 0.42) >= LINE_06 && (0.42 + LINE_06) <= 1.2,
    '0.78 mm channel = ' + ((1.2 - 0.42) / LINE_06).toFixed(2) + 'x a 0.6 line; the 0.6-nozzle floor is ' +
    (0.42 + LINE_06).toFixed(2) + ' mm');
  check('density gained, stated as what it is: 1.2 -> 0.84 is 1.43x the ribs, not 2.4x',
    near(1.2 / 0.84, 1.4286, 1e-3), (1.2 / 0.84).toFixed(3) + 'x per axis');
}

/* ------------------------------------------------------------------ part 3 */
console.log('\n=== 3. the canonical checker on every new piece, both ways ===');
for (const b of fine.BUILDS) {
  const r = NSO_SkinPatch.buildPatch({ variant: b.variant, pattern: b.pattern });
  const tag = b.pattern.replace('-', '_') + '_' + b.variant;
  check(tag + ': built', r.ok, r.ok ? r.describeFull : r.reason);
  if (!r.ok) continue;
  const plain = validate(r.tris, 'gate_' + tag);
  const flagged = validate(r.tris, 'gate_' + tag, ['--non-solid']);
  check(tag + ': watertight - 0 open, 0 non-manifold, 0 piercing, 0 degenerate',
    plain.open_edges === 0 && plain.nonmanifold_edges === 0 &&
    plain.self_intersection.pierce === 0 && plain.degenerate_tris === 0, summary(plain));
  check(tag + ': --gate (standard closure) PASS', plain.verdict_fails.length === 0, verdictOf(plain));
  check(tag + ': --gate --non-solid (wall check at ' + NSO_SkinPatch.MIN_WALL + ' mm) PASS',
    flagged.verdict_fails.length === 0,
    verdictOf(flagged) + ' - wall ' + (flagged.wall && flagged.wall.min_wall_mm !== null
      ? flagged.wall.min_wall_mm.toFixed(4) + ' mm' : 'none within probe'));
  /* the wall check above is the RIB; this is the AIR, and both have to hold */
  const ch = channelOf(r.tris, 'gate_' + tag);
  check(tag + ': and the open channel is a printable ' + LINE_04 + ' mm at a 0.4 nozzle',
    ch >= LINE_04 - 1e-3, ch.toFixed(4) + ' mm');
  check(tag + ': 30 x 30 mm footprint, the skin-sample face',
    near(plain.bbox_size[0], 30, 1e-4) && near(plain.bbox_size[1], 30, 1e-4),
    JSON.stringify(plain.bbox_size));
  check(tag + ': every wall it adds is at least one extrusion line',
    r.minWall >= NSO_SkinPatch.MIN_WALL - 1e-9, r.minWall.toFixed(4) + ' mm');
}

/* ------------------------------------------------------------------ part 4 */
console.log('\n=== 4. the sandwich patch really is double-sided ===');
for (const pattern of ['crosshatch', 'crosshatch-fine']) {
  const r = NSO_SkinPatch.buildPatch({ variant: 'sandwich', pattern });
  check(pattern + ': built', r.ok, r.ok ? '' : r.reason);
  if (!r.ok) continue;
  const top = areaAtZ(r.tris, r.height, 1e-6);
  const bot = areaAtZ(r.tris, 0, 1e-6);
  check(pattern + ': the two contacts are EQUAL, measured off the mesh',
    near(top, bot, 1e-3) && top > 0,
    'top ' + top.toFixed(3) + ' mm2 vs bottom ' + bot.toFixed(3) + ' mm2');
  check(pattern + ': and both are the contact it reports',
    near(top, r.tipArea, 1e-3), r.tipArea.toFixed(3) + ' mm2');
  /* NO FLOOR: prismatic, so the solid is exactly contact x height. A membrane
     of any thickness anywhere would add to this and there is nowhere to hide
     it in a closed form. */
  const vol = Math.abs(signedVolume(r.tris));
  check(pattern + ': NO floor membrane - volume IS contact x height exactly',
    near(vol, r.tipArea * r.height, 1e-3),
    vol.toFixed(4) + ' vs ' + (r.tipArea * r.height).toFixed(4) + ' mm3');
  /* the same statement as a share of the bounding box, the way the loose
     variant states it - a 30x30x0.6 solid plate would be 540 mm3 */
  const v = validate(r.tris, 'sand_' + pattern.replace('-', '_'));
  const bbox = v.bbox_size[0] * v.bbox_size[1] * v.bbox_size[2];
  check(pattern + ': the gaps really are through-holes, not a thinned plate',
    vol < 0.85 * bbox, (100 * vol / bbox).toFixed(1) + '% of its ' + bbox.toFixed(0) + ' mm3 box');
  check(pattern + ': ONE component - the frame rib holds every rib end',
    r.components === 1, r.components + ' component(s)');
  check(pattern + ': the frame is a RIB, not a proud rim - it stands at the tips, not above them',
    r.proud === 0 && r.floor === 0 && near(r.height, r.params.height, 1e-9),
    'height ' + r.height + ' mm = the pattern height, floor 0, proud 0');
  /* the sliver the centring would otherwise leave */
  const fr = NSO_Skin.planeFrame([0, 0, 0], [1, 0, 0], [0, 1, 0], 30, 30);
  const plan = NSO_Skin.patternPlan(pattern, { margin: NSO_SkinPatch.MIN_WALL }, fr, 0);
  check(pattern + ': the frame was widened to MEET rib 1 - no sliver channel at the edge',
    near(r.frame, plan.ivU[0][0], 1e-9) && r.frame >= r.frameNominal,
    'nominal ' + r.frameNominal + ' -> built ' + r.frame.toFixed(3) +
    ' mm (the leftover it swallowed: ' + (r.frame - r.frameNominal).toFixed(3) + ' mm)');
  check(pattern + ': the pattern, not the frame, carries the contact',
    r.patternArea > 4 * r.frameArea,
    'pattern ' + r.patternArea.toFixed(1) + ' mm2 vs frame ' + r.frameArea.toFixed(1) + ' mm2');
  check(pattern + ': advised non-solid (a free-standing one-line lattice)', r.nonSolidAdvised === true);
}
{
  /* the fine sandwich is the denser one, which is the whole point */
  const a = NSO_SkinPatch.buildPatch({ variant: 'sandwich', pattern: 'crosshatch' });
  const b = NSO_SkinPatch.buildPatch({ variant: 'sandwich', pattern: 'crosshatch-fine' });
  check('the fine sandwich has more ribs per axis than the 1.2 control',
    b.info.ribsU > a.info.ribsU && b.info.ribsV > a.info.ribsV,
    a.info.ribsU + ' -> ' + b.info.ribsU + ' ribs per axis');
  check('...and more contact, so the two are a real A/B on one plate',
    b.tipArea > a.tipArea,
    a.tipArea.toFixed(1) + ' -> ' + b.tipArea.toFixed(1) + ' mm2 per face');
  /* refusals, by name and with the reason */
  const z = NSO_SkinPatch.buildPatch({ variant: 'sandwich', pattern: 'zigzag' });
  check('zigzag is REFUSED - it tapers, so its two faces are not the same pattern',
    z.ok === false && /not prismatic/.test(z.reason), z.reason);
  const g = NSO_SkinPatch.buildPatch({ variant: 'sandwich', pattern: 'ring' });
  check('ring is REFUSED - no height field, and a floorless frame would leave it floating',
    g.ok === false && /no height field/.test(g.reason), g.reason);
  const thin = NSO_SkinPatch.buildPatch({ variant: 'sandwich', pattern: 'crosshatch', frame: 0.2 });
  check('a frame under one extrusion line is refused', thin.ok === false && /frame/.test(thin.reason), thin.reason);
  /* 3 x 3 mm DOES fit - two ribs per axis - and is built rather than refused,
     which is the honest half of this pair. 1 x 1 leaves less than one rib
     after the frame and is refused by crosshatchPlan's own message. */
  const small = NSO_SkinPatch.buildPatch({ variant: 'sandwich', pattern: 'crosshatch', W: 3, D: 3 });
  check('a small-but-workable 3 x 3 mm patch is BUILT, not refused',
    small.ok === true && small.components === 1,
    small.ok ? small.info.ribsU + ' ribs per axis, frame ' + small.frame.toFixed(2) + ' mm' : small.reason);
  /* non-square: the frame is per-AXIS, because ribIntervals centres in each
     span independently and the two leftovers differ when W != D */
  for (const [W, D] of [[40, 20], [20, 40], [15, 15]]) {
    const r = NSO_SkinPatch.buildPatch({ variant: 'sandwich', pattern: 'crosshatch-fine', W, D });
    const tag = W + ' x ' + D + ' mm';
    if (!r.ok) { check(tag + ': built', false, r.reason); continue; }
    const v = validate(r.tris, 'sand_' + W + 'x' + D, ['--non-solid']);
    check(tag + ': watertight, one component, and --gate --non-solid PASS',
      v.open_edges === 0 && v.nonmanifold_edges === 0 && v.self_intersection.pierce === 0 &&
      v.degenerate_tris === 0 && r.components === 1 && v.verdict_fails.length === 0,
      summary(v) + ' | ' + verdictOf(v));
    check(tag + ': the frame is measured per axis, not once for both',
      r.frame > 0 && r.frameV > 0 && (W === D ? near(r.frame, r.frameV, 1e-9) : true),
      'frameU ' + r.frame.toFixed(3) + ', frameV ' + r.frameV.toFixed(3) + ' mm');
    const top = areaAtZ(r.tris, r.height, 1e-6), bot = areaAtZ(r.tris, 0, 1e-6);
    check(tag + ': still equal on both faces', near(top, bot, 1e-3),
      top.toFixed(3) + ' vs ' + bot.toFixed(3) + ' mm2');
  }
  const marg = NSO_SkinPatch.buildPatch({ variant: 'sandwich', pattern: 'crosshatch', margin: 2 });
  check('an explicit margin is REFUSED, not silently ignored - `frame` is the knob',
    marg.ok === false && /no margin/.test(marg.reason) && /frame/.test(marg.reason), marg.reason);
  const wide = NSO_SkinPatch.buildPatch({ variant: 'sandwich', pattern: 'crosshatch', frame: 1.2 });
  check('a wider frame is honoured, and still widened to meet rib 1',
    wide.ok === true && wide.frame >= 1.2 && wide.components === 1,
    'asked 1.2 -> built ' + wide.frame.toFixed(2) + ' mm');
  const nofit = NSO_SkinPatch.buildPatch({ variant: 'sandwich', pattern: 'crosshatch', W: 1, D: 1 });
  check('a patch too small for even one rib is refused, not clipped',
    nofit.ok === false && /too small/.test(nofit.reason), nofit.reason);
  /* and the variant that was NOT changed */
  check('bordered is untouched - still a floor membrane with the pattern on ONE side',
    NSO_SkinPatch.DEFAULTS.floor === NSO_SkinPatch.FLOOR &&
    NSO_SkinPatch.buildPatch({ variant: 'bordered', pattern: 'crosshatch' }).floor === 0.6,
    'floor ' + NSO_SkinPatch.FLOOR + ' mm, proud ' + NSO_SkinPatch.PROUD + ' mm');
}

/* ------------------------------------------------------------------ part 5 */
console.log('\n=== 5. the library files are what this code builds ===');
{
  const mf = JSON.parse(fs.readFileSync(fine.MANIFEST, 'utf8'));
  for (const b of fine.BUILDS) {
    const key = b.pattern + '_' + b.variant;
    const want = mf.patches[key];
    check(key + ': in the manifest', !!want);
    if (!want) continue;
    if (!fine.LIB) { LIBDIR.skip(key + ': library/' + want.file + ' committed, byte-identical, and gated'); continue; }
    const f = path.join(fine.LIB, want.file);
    check(key + ': library/' + want.file + ' committed', fs.existsSync(f));
    if (!fs.existsSync(f)) continue;
    const built = fine.buildOne(b.pattern, b.variant);
    const tmpf = path.join(tmp, want.file);
    writeSTL(tmpf, built.tris, key);
    check(key + ': byte-identical to a fresh build',
      Buffer.compare(fs.readFileSync(tmpf), fs.readFileSync(f)) === 0);
    check(key + ': manifest numbers match - tris ' + want.tris + ', channel ' + want.channel_mm +
      ' mm, contact ' + want.tip_area_mm2.toFixed(3) + ' mm2',
      built.meta.tris === want.tris && built.meta.components === want.components &&
      near(built.meta.tip_area_mm2, want.tip_area_mm2, 1e-6) &&
      near(built.meta.channel_mm, want.channel_mm, 1e-9));
    const v = meshValidate(f, ['--non-solid']);
    check(key + ': the committed file passes --gate --non-solid', v.verdict_fails.length === 0, verdictOf(v));
  }
  for (const f of fine.COPIES) {
    if (!fine.LIB) { LIBDIR.skip(f + ': library copy is byte-identical to the gated fixture'); continue; }
    const a = path.join(ROOT, 'fixtures', 'skin-patches', f);
    const b = path.join(fine.LIB, f);
    check(f + ': library copy is byte-identical to the gated fixture',
      fs.existsSync(b) && Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)) === 0);
  }
  /* every catalog row this ticket added must exist on disk */
  const cat = fs.readFileSync(path.join(ROOT, 'app-library.js'), 'utf8');
  for (const f of fine.CATALOG_FILES) {
    check(f + ': listed in app-library.js CATALOG', cat.indexOf("'" + f + "'") !== -1);
  }
}

/* ------------------------------------------------------------------ part 6 */
console.log('\n=== 6. no degenerate geometry at the tighter pitch ===');
for (const b of fine.BUILDS) {
  const r = NSO_SkinPatch.buildPatch({ variant: b.variant, pattern: b.pattern });
  if (!r.ok) continue;
  let minArea = Infinity, minEdge = Infinity;
  const s = r.tris;
  for (let i = 0; i < s.length; i += 9) {
    const ax = s[i], ay = s[i + 1], az = s[i + 2];
    const bx = s[i + 3], by = s[i + 4], bz = s[i + 5];
    const cx = s[i + 6], cy = s[i + 7], cz = s[i + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    minArea = Math.min(minArea, Math.sqrt(nx * nx + ny * ny + nz * nz) / 2);
    for (const e of [[ax - bx, ay - by, az - bz], [bx - cx, by - cy, bz - cz], [cx - ax, cy - ay, cz - az]]) {
      minEdge = Math.min(minEdge, Math.sqrt(e[0] * e[0] + e[1] * e[1] + e[2] * e[2]));
    }
  }
  check(b.variant + ' ' + b.pattern + ': no zero-area triangle, no edge under the weld radius',
    minArea > 1e-6 && minEdge > 1e-4,
    'smallest area ' + minArea.toExponential(2) + ' mm2, shortest edge ' + minEdge.toFixed(4) + ' mm');
}

console.log('\nfiles: ' + tmp);
if (fails) { console.log('\n' + fails + ' gate(s) FAILED'); process.exit(1); }
console.log('\nall gates held');
