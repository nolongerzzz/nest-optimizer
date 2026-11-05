#!/usr/bin/env node
/* Standalone skin-pattern patches: the relief as its own printable object,
   three patterns x two variants.

     node tools/nso_skin_patch_samples.js            -> fixtures/skin-patches/
     node tools/nso_skin_patch_samples.js out/dir
     node tools/nso_skin_patch_samples.js --check     byte-diff, writes nothing

   Per pattern it writes
     patch_<pattern>_bordered.stl   the washer: the pattern inside a solid rim
     patch_<pattern>_loose.stl      the pattern's features alone, solid
   and one skin-patches.json with every number the checker is asked to
   confirm: the overall extent, the walls, the tips plane, the contact area,
   volume, triangle count, component count, and the non-solid recommendation.

   Geometry: Z up, millimetres, resting on z = 0 - a patch is exported as its
   own object and the plate is where it lands. The footprint is 30 x 30, the
   face A_SIZE in tools/nso_skin_samples.js, so a patch and the skin sample it
   came from are the same pattern over the same area.

   Nothing here re-implements the patterns: nso_skin_patch.js builds both
   variants on nso_skin.js, and the bordered one is skinned by
   NSO_Skin.applySkinToFace itself. tools/nso_skin_patch_test.js drives the
   same builds through mesh_validate.py, and
   tools/nso_skin_patch_drive_check.js presses the shipped button and checks
   the file the browser downloads. */
'use strict';

const fs = require('fs');
const path = require('path');
const NSO_SkinPatch = require('../nso_skin_patch.js');
const { writeSTL } = require('./nso_stl_io.js');

const ROOT = path.resolve(__dirname, '..');

const PATTERNS = ['crosshatch', 'zigzag', 'ring'];
const VARIANTS = ['bordered', 'loose'];

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
    pattern, variant,
    describe: r.describe, describe_full: r.describeFull,
    params: r.params,
    extent_mm: r.extent.map(x => +x.toFixed(6)),
    min_wall_mm: r.minWall, tip_wall_mm: r.tipWall,
    tip_height_mm: r.tipHeight, tips_z: +r.tipsZ.toFixed(6),
    tip_area_mm2: r.tipArea,
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
  } else {
    meta.back_mm = r.back; meta.ties = r.ties; meta.tie_width_mm = r.tieWidth;
    meta.margin_mm = r.margin;
  }
  return { tris: r.tris, meta, result: r };
}

function writeSamples(outDir, opts) {
  const check = !!(opts && opts.check);
  if (!check) fs.mkdirSync(outDir, { recursive: true });
  const manifest = {
    generated_by: 'tools/nso_skin_patch_samples.js',
    units: 'mm, Z up, resting on z = 0',
    conventions: {
      min_wall_mm: NSO_SkinPatch.MIN_WALL, floor_mm: NSO_SkinPatch.FLOOR,
      rim_mm: NSO_SkinPatch.RIM, proud_mm: NSO_SkinPatch.PROUD,
      footprint_mm: NSO_SkinPatch.SIZE
    },
    patches: {}
  };
  let differed = 0;
  for (const pattern of PATTERNS) {
    for (const variant of VARIANTS) {
      const { tris, meta } = buildOne(pattern, variant);
      const name = 'patch_' + pattern + '_' + variant + '.stl';
      const file = path.join(outDir, name);
      if (check) {
        const tmp = file + '.tmp-check';
        writeSTL(tmp, tris, 'NSO skin patch ' + variant + ' ' + pattern);
        const same = fs.existsSync(file) && fs.readFileSync(file).equals(fs.readFileSync(tmp));
        fs.unlinkSync(tmp);
        if (!same) { differed++; console.log('DIFFERS  ' + name); }
      } else {
        writeSTL(file, tris, 'NSO skin patch ' + variant + ' ' + pattern);
      }
      manifest.patches[pattern + '_' + variant] = Object.assign({ file: name }, meta);
      console.log((variant + ' ' + pattern).padEnd(20) +
        ' extent ' + meta.extent_mm.map(x => x.toFixed(2)).join(' x ') +
        '  walls ' + meta.min_wall_mm + (meta.tip_wall_mm < meta.min_wall_mm ? '->' + meta.tip_wall_mm : '') +
        '  tips z ' + meta.tips_z.toFixed(2) +
        '  contact ' + meta.tip_area_mm2.toFixed(2) + ' mm^2' +
        '  tris ' + meta.tris + '  comp ' + meta.components +
        (meta.non_solid_advised ? '  non-solid advised' : ''));
    }
  }
  const mf = path.join(outDir, 'skin-patches.json');
  const text = JSON.stringify(manifest, null, 2) + '\n';
  if (check) {
    const same = fs.existsSync(mf) && fs.readFileSync(mf, 'utf8') === text;
    if (!same) { differed++; console.log('DIFFERS  skin-patches.json'); }
    if (differed) { console.log('\n' + differed + ' file(s) differ - re-run without --check'); process.exit(1); }
    console.log('\nall ' + (PATTERNS.length * VARIANTS.length + 1) + ' files byte-identical');
  } else {
    fs.writeFileSync(mf, text);
  }
  return manifest;
}

module.exports = { buildOne, writeSamples, PATTERNS, VARIANTS, signedVolume };

if (require.main === module) {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const rest = args.filter(a => a !== '--check');
  const outDir = rest[0] ? path.resolve(rest[0]) : path.join(ROOT, 'fixtures', 'skin-patches');
  writeSamples(outDir, { check });
  if (!check) console.log('wrote ' + outDir);
}
