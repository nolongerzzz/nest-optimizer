#!/usr/bin/env node
/* Deterministic generator for fixtures/damage/: known-clean fixtures with ONE
 * controlled defect each, injected by tools/nso_damage.js.
 *
 *   node tools/nso_damage_make_fixtures.js            # write fixtures/damage/ + nest-library copies
 *   node tools/nso_damage_make_fixtures.js --check    # regenerate to a temp dir and byte-diff
 *
 * The same arrangement as tools/nso_open_make_fixtures.js (PR #82): a clean
 * shape, one named defect, a file named <clean>_<defect>.stl, a header that
 * says what it is, and a --check that byte-diffs what is committed. What is
 * new is that the defect is not hand-placed in literals - it is a
 * parameterized call - and that every file carries, in damage.json, the exact
 * numbers the canonical checker must read off it. tools/nso_damage_test.js
 * holds each file to those numbers.
 *
 * Every source is a fixtures/quick/ piece (clean by tools/nso_quick_test.js,
 * and refused by nso_damage.js if it is not). Nothing is random: placement is
 * a seeded PRNG, and the seed is in the manifest. */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const D = require('./nso_damage.js');
const { readSTL, writeSTL } = require('./nso_stl_io.js');
const LIBDIR = require('./nso_library_dir.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'fixtures', 'damage');
/* The Library's files live in nolongerzzz/nest-library (app-library.js,
   source 'nest-library'). The library-flagged pieces are copied into a
   checkout of it when there is one; with none, the copy is skipped out loud. */
const LIB = LIBDIR.libraryDir();
const SRC = f => path.join(ROOT, 'fixtures', 'quick', f);

/* [file, source, type, params, what, library?]
   `library` marks the ones copied into nest-library and listed in the Library
   under Test Fixtures - one per defect class, plus the shredded extreme. */
const FIXTURES = [
  ['shape-sphere_hole.stl', 'shape-sphere.stl', 'hole', { severity: 'one', seed: 1 },
   'one small real hole', true],
  ['shape-sphere_holes-shredded.stl', 'shape-sphere.stl', 'hole', { severity: 'shredded', seed: 1 },
   'twelve sites grown into each other - half the sphere gone, 2 boundary loops', true],
  ['shape-sphere_hole-painted.stl', 'shape-sphere.stl', 'hole', { region: { faces: [0, 1, 2, 3, 4, 5, 6, 7] } },
   'faces 0-7 removed as a painted selection', false],
  ['shape-tube_severed.stl', 'shape-tube.stl', 'sever', { slots: 1, width: 1.0 },
   'ring wall severed by one 1 mm slot, capped: a C, genus 1 -> 0', true],
  ['shape-tube_severed-apart.stl', 'shape-tube.stl', 'sever', { slots: 2, width: 1.0 },
   'ring wall severed twice, capped: two bodies', false],
  ['shape-sphere_nm-duplicate.stl', 'shape-sphere.stl', 'nonManifold', { mode: 'duplicate', severity: 'one', seed: 1 },
   'one face duplicated in place, same winding', true],
  ['shape-sphere_nm-duplicate-flipped.stl', 'shape-sphere.stl', 'nonManifold', { mode: 'duplicate-flipped', severity: 'moderate', seed: 2 },
   'five patches (68 faces) duplicated in place, reversed winding', false],
  ['shape-sphere_winding-flip.stl', 'shape-sphere.stl', 'nonManifold', { mode: 'flip', severity: 'one', seed: 1 },
   'one face flipped in place, nothing added or removed', true],
  ['shape-torus_weld-collide.stl', 'shape-torus.stl', 'weld', { severity: 'one', distance: 5e-5, seed: 1 },
   'one vertex 5e-5 mm from a distinct neighbour - inside the 1e-4 weld', true],
  ['shape-torus_weld-near.stl', 'shape-torus.stl', 'weld', { severity: 'one', distance: 2e-4, seed: 1 },
   'the same split at 2e-4 mm - outside the weld, the clean control', false],
  ['shape-torus_weld-shredded.stl', 'shape-torus.stl', 'weld', { severity: 'shredded', distance: 5e-5, seed: 1 },
   'thirty-two weld collisions', false],
];

async function buildOne(spec) {
  const [file, source, type, params, what] = spec;
  const r = await D.apply(type, readSTL(SRC(source)), params);
  return { file, source, type, params, what, r };
}

async function build(dir, libDir) {
  fs.mkdirSync(dir, { recursive: true });
  const entries = [];
  for (const spec of FIXTURES) {
    const { file, source, type, params, what, r } = await buildOne(spec);
    const header = 'NSO damage fixture: ' + source.replace(/\.stl$/, '') + ' ' + type + ' - ' + what;
    writeSTL(path.join(dir, file), r.soup, header);
    if (spec[5] && libDir) fs.copyFileSync(path.join(dir, file), path.join(libDir, file));
    const e = { stl: file, source, type, params, what, library: !!spec[5], expected: r.expected };
    if (r.mode) e.mode = r.mode;
    if (type === 'hole') { e.removed_faces = r.removed_faces; e.boundary_loops = r.boundary_loops; }
    if (type === 'nonManifold') e.patch_faces = r.patch_faces;
    if (type === 'weld') e.sites = r.sites.map(s => ({ edge: s.edge, realized_distance: s.realized_distance, merges: s.merges }));
    if (type === 'sever') { e.before = r.before; e.bodies = r.bodies; e.genus_per_body = r.genus_per_body; e.slots = r.sites; }
    entries.push(e);
  }
  const manifest = {
    generator: 'tools/nso_damage_make_fixtures.js',
    checker: 'tools/mesh_validate.py --json (weld ' + D.WELD_TOL + ')',
    note: '`expected` is what the canonical checker must report; `piercing` is self_intersection.pierce.',
    entries
  };
  fs.writeFileSync(path.join(dir, 'damage.json'), JSON.stringify(manifest, null, 2) + '\n');
  return entries;
}

async function main() {
  if (process.argv.includes('--check')) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-damage-fx-'));
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
      cmp(path.join(tmp, spec[0]), path.join(OUT, spec[0]), 'fixtures/damage/' + spec[0]);
      if (spec[5] && LIB) cmp(path.join(tmp, spec[0]), path.join(LIB, spec[0]), 'nest-library/' + spec[0]);
      else if (spec[5]) LIBDIR.skip('nest-library/' + spec[0] + ' byte-identical to fixtures/damage/');
    }
    cmp(path.join(tmp, 'damage.json'), path.join(OUT, 'damage.json'), 'fixtures/damage/damage.json');
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(bad ? 1 : 0);
  }
  if (!LIB) LIBDIR.skip('copying the Library pieces into nest-library (no checkout)');
  for (const e of await build(OUT, LIB)) {
    console.log('  wrote ' + e.stl + '  ' + e.expected.triangles + ' tris' + (e.library && LIB ? '  (+ nest-library/)' : ''));
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { FIXTURES, build, OUT, LIB };
