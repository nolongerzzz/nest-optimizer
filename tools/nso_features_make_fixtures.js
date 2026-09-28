#!/usr/bin/env node
/* Deterministic generator for fixtures/features/: one known-clean hull with
 * real functional features on it, each built by tools/nso_features.js from
 * its own definition, with its ground truth in features.json.
 *
 *   node tools/nso_features_make_fixtures.js            # write fixtures/features/ + nest-library copies
 *   node tools/nso_features_make_fixtures.js --check    # regenerate to a temp dir and byte-diff
 *
 * The arrangement of tools/nso_damage_make_fixtures.js, kept exactly: a file
 * named <hull>_<what>.stl with a header that says what it is, a manifest
 * carrying the exact numbers the canonical checker must read off every file,
 * the Library-flagged ones copied into a nest-library checkout when there is
 * one, and a --check that byte-diffs all of it. What the manifest carries
 * beyond the census is each feature's ground truth: its root (where it meets
 * the hull), its cell (where it lives), its volume and area, what it adds to
 * the topology, and what each detector must say about it.
 * tools/nso_features_test.js holds every file to it. */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const FX = require('./nso_features.js');
const { writeSTL } = require('./nso_stl_io.js');
const LIBDIR = require('./nso_library_dir.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'fixtures', 'features');
const LIB = LIBDIR.libraryDir();

/* [file, features, what, library?]
   `library` marks the ones copied into nest-library and listed in the Library
   under Test Fixtures: the whole set on one hull, and each feature alone. */
const FIXTURES = [
  ['feature-hull_all.stl', FX.ORDER,
   'flange, handle, bracket, lid and hinge on one hull', true],
  ['feature-hull_flange.stl', ['flange'], 'a 2.5 mm flange, 15 mm out along a 60 mm root', true],
  ['feature-hull_handle.stl', ['handle'], 'an arch handle, 8 mm rod, 21 mm clear - genus 1', true],
  ['feature-hull_bracket.stl', ['bracket'], 'a gusseted angle bracket, 3 mm, 20 mm arm', true],
  ['feature-hull_lid.stl', ['lid'], 'a lid seated on a pocket, plug 0.5 mm clear - one void', true],
  ['feature-hull_hinge.stl', ['hinge'], 'a print-in-place knuckle hinge, 0.5 mm clear - 2 bodies', true],
  /* The bracket without its gussets: by nso_flange's rule its arm IS a
     flange, and the manifest says the detector must find it. Kept out of the
     Library - it is a pin on the definition, not a piece to try things on. */
  ['feature-hull_angle-unbraced.stl', ['angle'], 'the bracket without its gussets - a flange by the rule', false]
];

/* What each detector must report on a file: nso_flange.js for the flange
   (and the unbraced angle's arm, which by its rule is one), and
   nso_face_features.js's four rules for the rest - each finds exactly its
   own feature and nothing else (tools/nso_face_features_test.js). */
function detectors(types) {
  const flanges = types.filter(t => t === 'flange' || t === 'angle');
  const out = { flange: { count: flanges.length, features: flanges } };
  for (const rule of ['handle', 'bracket', 'lid', 'hinge']) {
    const own = types.filter(t => t === rule);
    out[rule] = { count: own.length, features: own };
  }
  return out;
}

async function buildOne(spec) {
  const [file, types, what] = spec;
  const p = await FX.build({ features: types.map(type => ({ type })) });
  return { file, types, what, p };
}

async function build(dir, libDir) {
  fs.mkdirSync(dir, { recursive: true });
  const entries = [];
  for (const spec of FIXTURES) {
    const { file, types, what, p } = await buildOne(spec);
    writeSTL(path.join(dir, file), p.soup, 'NSO feature fixture: ' + what);
    if (spec[3] && libDir) fs.copyFileSync(path.join(dir, file), path.join(libDir, file));
    entries.push({
      stl: file, what, library: !!spec[3],
      host: { size: p.host.size, keep: p.keep, volume: p.host_volume, surface_area: p.host_area },
      features: p.features,
      declared: p.declared,
      detectors: detectors(types),
      expected: p.expected
    });
  }
  const manifest = {
    generator: 'tools/nso_features_make_fixtures.js',
    checker: 'tools/mesh_validate.py --json (weld 0.0001)',
    note: '`expected` is what the canonical checker must report (`piercing` is self_intersection.pierce). ' +
          'Each feature: `roots` is where it meets the hull and their area; `cells` (world AABBs) hold it and ' +
          'nothing else, so piece n cells = the feature (tools/nso_features.js detach()); `truth` is its ' +
          'own ground truth. `declared` is what the definitions add up to, stated before the output is read.',
    entries
  };
  fs.writeFileSync(path.join(dir, 'features.json'), JSON.stringify(manifest, null, 2) + '\n');
  return entries;
}

async function main() {
  if (process.argv.includes('--check')) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-features-fx-'));
    await build(tmp, null);
    let bad = 0;
    const cmp = (a, b, label) => {
      let B = null;
      try { B = fs.readFileSync(b); } catch (e) { /* absent */ }
      const same = B && fs.readFileSync(a).equals(B);
      console.log((same ? '  ok    ' : '  DRIFT ') + label + (B ? '' : ' (missing)'));
      if (!same) bad++;
    };
    for (const spec of FIXTURES) {
      cmp(path.join(tmp, spec[0]), path.join(OUT, spec[0]), 'fixtures/features/' + spec[0]);
      if (spec[3] && LIB) cmp(path.join(tmp, spec[0]), path.join(LIB, spec[0]), 'nest-library/' + spec[0]);
      else if (spec[3]) LIBDIR.skip('nest-library/' + spec[0] + ' byte-identical to fixtures/features/');
    }
    cmp(path.join(tmp, 'features.json'), path.join(OUT, 'features.json'), 'fixtures/features/features.json');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(bad ? 1 : 0);
  }
  if (!LIB) LIBDIR.skip('copying the Library pieces into nest-library (no checkout)');
  for (const e of await build(OUT, LIB)) {
    console.log('  wrote ' + e.stl + '  ' + e.expected.triangles + ' tris' + (e.library && LIB ? '  (+ nest-library/)' : ''));
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { FIXTURES, build, OUT, LIB, detectors };
