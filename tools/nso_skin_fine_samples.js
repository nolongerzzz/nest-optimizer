#!/usr/bin/env node
/* The tighter-pitch and double-sided skin patches, written where the Library
   tab can load them.

     node tools/nso_skin_fine_samples.js            -> library/ + the manifest
     node tools/nso_skin_fine_samples.js --check     byte-diff, writes nothing

   WHY library/ AND NOT fixtures/. app-library.js's CATALOG is a list of FLAT
   FILENAMES served from `library/` - that is the only place the Library tab
   looks. The six patches the original patch ticket shipped live in
   `fixtures/skin-patches/` and are generated and byte-gated by
   tools/nso_skin_patch_samples.js; this tool does not touch them. It copies
   them into `library/` under the same names so the catalog can reach them,
   and it BUILDS the new pieces there:

     patch_crosshatch-fine_loose.stl      the fine lattice alone
     patch_crosshatch-fine_sandwich.stl   double-sided, fine pitch
     patch_crosshatch_sandwich.stl        double-sided at the shipped 1.2 pitch

   NO _bordered PIECE IS SHIPPED TO library/ ANY MORE. The bordered variant
   set the pattern in a solid rim on a 0.6 mm floor, and that construction
   bonds to a stacked part at 2.857x the contact of a true flat line, which
   makes it useless as a separating washer. The four that used to be here -
   crosshatch, crosshatch-fine, zigzag and ring - were deleted from library/
   and from app-library.js's CATALOG together. This tool no longer builds or
   copies them, so --check no longer demands them.

   The variant itself is untouched: NSO_SkinPatch.buildPatch still builds it,
   fixtures/skin-patches/ still holds and gates the three bordered fixtures,
   and tools/nso_skin_patch_samples.js still writes them. What changed is only
   which samples the Library tab ships.

   The last one is not decoration: a sandwich test needs its own A/B, and the
   1.2 sandwich is the control the fine one is measured against. The copies
   are byte-compared against `fixtures/skin-patches/` on --check, so the
   Library tab can never drift from the gated fixtures.

   All four built here are 30 x 30 mm - SIZE in nso_skin_patch.js, the same
   face the committed skin samples skin, so a patch and the sample it came from
   are the same pattern over the same area and any of them can go on one plate
   beside a slicer's own auto-support sample for a real comparison. (Of the six
   copied in, five are 30 x 30 too; the loose ring is 2 x rOut = 10 x 10 and
   says so in its own manifest, which is why nothing here asserts a blanket
   footprint - see expectations().)

   tools/nso_skin_fine_test.js drives every one of these through
   mesh_validate.py and measures the open channel the pitch leaves;
   tools/nso_skin_fine_drive_check.js loads each catalog row through the real
   Library UI. */
'use strict';

const fs = require('fs');
const path = require('path');
const NSO_SkinPatch = require('../nso_skin_patch.js');
const { writeSTL } = require('./nso_stl_io.js');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'library');
const PATCHES = path.join(ROOT, 'fixtures', 'skin-patches');
const MANIFEST = path.join(ROOT, 'fixtures', 'skin-fine', 'skin-fine.json');

/* built here */
const BUILDS = [
  { pattern: 'crosshatch-fine', variant: 'loose' },
  { pattern: 'crosshatch-fine', variant: 'sandwich' },
  { pattern: 'crosshatch', variant: 'sandwich' }
];

/* copied from the gated fixtures so the Library tab can reach them. `loose`
   only - the `bordered` fixtures are still generated and gated over in
   fixtures/skin-patches/, they are just no longer shipped as library pieces. */
const COPIES = [];
for (const pattern of ['crosshatch', 'zigzag', 'ring']) {
  COPIES.push('patch_' + pattern + '_loose.stl');
}

/* Every file this tool puts in library/, in the order app-library.js's CATALOG
   lists them - grouped by pattern, not by which of the two lists above built
   it. tools/nso_skin_fine_drive_check.js asserts the shipped list matches this
   exactly, so the two cannot drift. */
const CATALOG_FILES = [
  'patch_crosshatch_loose.stl',
  'patch_crosshatch_sandwich.stl',
  'patch_crosshatch-fine_loose.stl',
  'patch_crosshatch-fine_sandwich.stl',
  'patch_zigzag_loose.stl',
  'patch_ring_loose.stl'
];

/* file -> the bbox it should load at, from whichever manifest owns it. The
   four built here come from skin-fine.json, the six copied ones from the
   gated skin-patches.json. NOT a blanket 30 x 30: a loose ring is 2 x rOut
   across and says so, which is exactly the kind of thing a blanket assertion
   would paper over. */
function expectations() {
  const out = {};
  const fine = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  for (const k of Object.keys(fine.patches)) {
    const m = fine.patches[k];
    out[m.file] = { extent: m.extent_mm, tris: m.tris };
  }
  const gated = JSON.parse(fs.readFileSync(path.join(PATCHES, 'skin-patches.json'), 'utf8'));
  for (const k of Object.keys(gated.patches)) {
    const m = gated.patches[k];
    out['patch_' + m.pattern + '_' + m.variant + '.stl'] = { extent: m.extent_mm, tris: m.tris };
  }
  return out;
}

function fileFor(pattern, variant) {
  return 'patch_' + pattern + '_' + variant + '.stl';
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

function buildOne(pattern, variant, opts) {
  const r = NSO_SkinPatch.buildPatch(Object.assign({ pattern, variant }, opts || {}));
  if (!r.ok) throw new Error(variant + ' ' + pattern + ': ' + r.reason);
  const meta = {
    file: fileFor(pattern, variant),
    pattern, variant,
    describe: r.describe, describe_full: r.describeFull,
    params: r.params,
    /* the channel the pitch leaves, which is what decides printability -
       stated here so the manifest carries it and the test measures it */
    pitch_mm: r.params.pitch, rib_mm: r.params.rib,
    channel_mm: +(r.params.pitch - r.params.rib).toFixed(6),
    extent_mm: r.extent.map(x => +x.toFixed(6)),
    min_wall_mm: +r.minWall.toFixed(6), tip_wall_mm: r.tipWall,
    tip_height_mm: r.tipHeight, tips_z: +r.tipsZ.toFixed(6),
    tip_area_mm2: +r.tipArea.toFixed(6),
    volume: signedVolume(r.tris),
    tris: r.tris_count,
    components: r.components,
    closed: r.closed,
    non_solid_advised: r.nonSolidAdvised
  };
  if (variant === 'bordered') {
    meta.floor_mm = r.floor; meta.rim_mm = r.rim; meta.proud_mm = r.proud;
    meta.rim_top_z = +r.rimTopZ.toFixed(6);
    meta.pocket_mm = { W: +r.pocket.W.toFixed(6), D: +r.pocket.D.toFixed(6), floor_z: r.pocket.floorZ };
    meta.margin_mm = r.margin;
  } else if (variant === 'sandwich') {
    meta.frame_mm = +r.frame.toFixed(6);
    meta.frame_nominal_mm = r.frameNominal;
    meta.frame_area_mm2 = +r.frameArea.toFixed(6);
    meta.pattern_area_mm2 = +r.patternArea.toFixed(6);
    /* the same number twice on purpose: a prismatic lattice presents the same
       set on both faces, and the manifest says so rather than implying it */
    meta.top_area_mm2 = +r.topArea.toFixed(6);
    meta.bottom_area_mm2 = +r.bottomArea.toFixed(6);
    meta.floor_mm = 0;
  } else {
    meta.back_mm = r.back; meta.ties = r.ties; meta.tie_width_mm = r.tieWidth;
    meta.margin_mm = r.margin;
  }
  return { tris: r.tris, meta, result: r };
}

function writeSamples(opts) {
  const check = !!(opts && opts.check);
  if (!check) {
    fs.mkdirSync(LIB, { recursive: true });
    fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  }
  const manifest = { generator: 'tools/nso_skin_fine_samples.js', units: 'mm', up: 'Z', patches: {} };
  let diffs = 0;

  /* the four new pieces */
  for (const b of BUILDS) {
    const { tris, meta } = buildOne(b.pattern, b.variant);
    const key = b.pattern + '_' + b.variant;
    manifest.patches[key] = meta;
    const dest = path.join(LIB, meta.file);
    const tmp = dest + '.tmp';
    writeSTL(tmp, tris, key);
    const fresh = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);
    if (check) {
      const same = fs.existsSync(dest) && Buffer.compare(fresh, fs.readFileSync(dest)) === 0;
      if (!same) { diffs++; console.log('DIFF library/' + meta.file); }
    } else {
      fs.writeFileSync(dest, fresh);
    }
    console.log(
      (b.variant + ' ' + b.pattern).padEnd(32) +
      ' extent ' + meta.extent_mm.map(x => x.toFixed(2)).join(' x ') +
      '  pitch ' + meta.pitch_mm + '  channel ' + meta.channel_mm +
      '  contact ' + meta.tip_area_mm2.toFixed(2) + ' mm^2' +
      '  tris ' + meta.tris + '  comp ' + meta.components +
      (meta.non_solid_advised ? '  non-solid advised' : ''));
  }

  /* the six already-gated patches, copied in so the catalog can reach them */
  for (const f of COPIES) {
    const src = fs.readFileSync(path.join(PATCHES, f));
    const dest = path.join(LIB, f);
    if (check) {
      const same = fs.existsSync(dest) && Buffer.compare(src, fs.readFileSync(dest)) === 0;
      if (!same) { diffs++; console.log('DIFF library/' + f + ' (against fixtures/skin-patches/)'); }
    } else {
      fs.writeFileSync(dest, src);
    }
  }
  manifest.copied_from_fixtures = COPIES;
  manifest.catalog_files = CATALOG_FILES;

  const text = JSON.stringify(manifest, null, 2) + '\n';
  if (check) {
    const same = fs.existsSync(MANIFEST) && fs.readFileSync(MANIFEST, 'utf8') === text;
    if (!same) { diffs++; console.log('DIFF ' + path.relative(ROOT, MANIFEST)); }
    console.log(diffs === 0
      ? '\nall ' + (CATALOG_FILES.length + 1) + ' files byte-identical'
      : '\n' + diffs + ' file(s) differ');
    if (diffs) process.exitCode = 1;
  } else {
    fs.writeFileSync(MANIFEST, text);
    console.log('\nwrote ' + CATALOG_FILES.length + ' STL(s) to library/ and ' + path.relative(ROOT, MANIFEST));
  }
  return manifest;
}

module.exports = { buildOne, writeSamples, signedVolume, expectations,
  BUILDS, COPIES, CATALOG_FILES, fileFor, LIB, MANIFEST };

if (require.main === module) {
  writeSamples({ check: process.argv.includes('--check') });
}
