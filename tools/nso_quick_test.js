#!/usr/bin/env node
/* fixtures/quick/ - the gate on the fast set.
 *
 *     node tools/nso_quick_test.js        exit 0 = every gate held
 *
 * tools/nso_quick_fixtures.js --check byte-diffs the files against what the
 * shipped code builds today. That is a DRIFT check and it would happily pass
 * on a set that had quietly become slow, heavy or broken, as long as it had
 * become so before the last regeneration. This is the check on what the set
 * IS, and it reads the committed files off disk rather than rebuilding them,
 * so every number below is a fact about the bytes in the repository:
 *
 *   QUICK      every piece inside the stated print budget, and the whole set
 *              inside a stated total. The promise the directory is named for.
 *   CHEAP      a triangle ceiling for the set. A fixture set a tool cannot be
 *              run over casually is not the set this one is trying to be.
 *   REAL       the canonical checker (tools/mesh_validate.py), the same one
 *              every other fixture in this repo goes through, per file - with
 *              the genus each shape is SUPPOSED to have written down rather
 *              than read off the mesh.
 *   DISTINCT   no two pieces the same bytes. A set with a duplicate in it is
 *              a set that tests one thing twice and claims two.
 *   HONEST     the manifest describes the files, measured off the files.
 *   LOADABLE   every piece the Library offers really is in nest-library and
 *              really is what fixtures/quick/ holds, byte for byte. Read from a
 *              nest-library checkout (tools/nso_library_dir.js); SKIPped, out
 *              loud, without one.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readSTL } = require('./nso_stl_io.js');
const G = require('./nso_quick_fixtures.js');

const ROOT = path.resolve(__dirname, '..');
const LIBDIR = require('./nso_library_dir');
const OUT = G.OUT;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

/* The ceilings. Stated here rather than derived from the set, because a
   ceiling computed from the thing it is meant to constrain constrains nothing
   - it would move with every regeneration and never fail. Today's measured
   figures are in the comments so the headroom is visible. */
const TOTAL_TRI_CEILING = 20000;      // measured: 8584
const TOTAL_PRINT_CEILING_S = 3600;   // measured: 2700 s = 45 min, solid

const MANIFEST = JSON.parse(fs.readFileSync(path.join(OUT, 'quick.json'), 'utf8'));

/* =====================================================================
   1. The manifest describes what is actually on disk
   ===================================================================== */
console.log('== 1. the manifest is about the files, and every file is in it ==');
{
  const onDisk = fs.readdirSync(OUT).filter(f => f.endsWith('.stl')).sort();
  const listed = MANIFEST.entries.map(e => e.stl).sort();
  check('every .stl in the directory has a manifest entry, and vice versa',
    onDisk.join(',') === listed.join(','),
    onDisk.length + ' on disk, ' + listed.length + ' listed');

  /* Re-measured off the committed bytes, through the same reader the fixture
     tools use - not off the soup the generator held in memory. */
  for (const e of MANIFEST.entries) {
    const tris = readSTL(path.join(OUT, e.stl));
    const b = G.bbox(tris), vol = G.meshVolume(tris), top = G.topology(tris);
    const t = G.printTime(vol, b.size[2]);
    const ok = tris.length / 9 === e.tris &&
      b.size.every((x, i) => Math.abs(x - e.bbox_mm[i]) < 1e-3) &&
      Math.abs(vol - e.volume_mm3) / Math.abs(e.volume_mm3) < 1e-6 &&
      Math.abs(t.seconds - e.print.seconds) < 0.1 &&
      top.genus === e.topology.genus;
    check(e.stl + ': the file measures what the manifest says it does', ok,
      (tris.length / 9) + ' tris, ' + vol.toFixed(3) + ' mm^3, ' +
      (t.seconds / 60).toFixed(2) + ' min, genus ' + top.genus);
  }
}

/* =====================================================================
   2. QUICK - the promise the directory is named for
   ===================================================================== */
console.log('\n== 2. every piece is quick to print, and the set is quick as a whole ==');
{
  const over = MANIFEST.entries.filter(e => e.print.seconds > G.PRINT_BUDGET_S);
  check('every piece is inside the ' + (G.PRINT_BUDGET_S / 60) + '-minute solid budget',
    over.length === 0, over.map(e => e.stl).join(', ') || 'slowest is ' +
    MANIFEST.slowest.stl + ' at ' + (MANIFEST.slowest.seconds / 60).toFixed(2) + ' min');
  check('...and the whole set prints solid in under ' + (TOTAL_PRINT_CEILING_S / 60) + ' minutes',
    MANIFEST.total_print_s < TOTAL_PRINT_CEILING_S,
    (MANIFEST.total_print_s / 60).toFixed(1) + ' min for ' + MANIFEST.entries.length + ' pieces');

  /* The model is the worst case and says so. Asserting that here rather than
     in prose means nobody can quietly swap it for an optimistic one: 100%
     infill is the most material a slicer can put down, so the figure is an
     upper bound on a real print and not an estimate of one. */
  check('the print model is written into the manifest, with its assumption',
    /100% infill/.test(MANIFEST.print_model.assumes) &&
    MANIFEST.print_model.layer_mm === G.PRINT.layer_mm &&
    MANIFEST.print_model.line_mm === G.PRINT.line_mm &&
    MANIFEST.print_model.speed_mm_s === G.PRINT.speed_mm_s,
    MANIFEST.print_model.formula);
  /* And it is monotone in volume at a fixed height, which is the only
     property anything downstream should rely on. */
  const a = G.printTime(100, 10), b = G.printTime(200, 10);
  check('...and it is monotone in volume, which is all it is good for',
    b.seconds > a.seconds, a.seconds + ' s -> ' + b.seconds + ' s for twice the material');
}

/* =====================================================================
   3. CHEAP - a tool can be run over the whole set without waiting
   ===================================================================== */
console.log('\n== 3. the whole set is cheap to walk ==');
{
  check('the set is under ' + TOTAL_TRI_CEILING + ' triangles in total',
    MANIFEST.total_tris < TOTAL_TRI_CEILING, MANIFEST.total_tris + ' triangles');
  const boxes = MANIFEST.entries.filter(e => e.kind === 'box');
  check('the five plain boxes are twelve triangles each and nothing more',
    boxes.length === 5 && boxes.every(e => e.tris === 12),
    boxes.map(e => e.stl + ':' + e.tris).join(' '));
  const heaviest = MANIFEST.entries.reduce((x, y) => (y.tris > x.tris ? y : x));
  check('...and the heaviest round piece is a fraction of a shipped 96-segment blank',
    heaviest.tris < 4000, heaviest.stl + ' at ' + heaviest.tris +
    ' tris, against 18240 for a 96-segment sphere');
}

/* =====================================================================
   4. REAL - the canonical checker, per file
   ===================================================================== */
console.log('\n== 4. every piece is a closed solid, by the canonical checker ==');
{
  /* The genus each piece is supposed to be, written down. A tube and a torus
     have a hole through them; a plate is a slab and does not. Read off the
     mesh instead and the check would agree with whatever was generated. */
  const WANT_GENUS = { 'shape-tube.stl': 1, 'shape-torus.stl': 1 };
  for (const e of MANIFEST.entries) {
    const v = JSON.parse(execFileSync('python3',
      [path.join(ROOT, 'tools', 'mesh_validate.py'), path.join(OUT, e.stl), '--json'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
    const g = WANT_GENUS[e.stl] || 0;
    const clean = v.open_edges === 0 && v.nonmanifold_edges === 0 && v.odd_edges === 0 &&
      v.inconsistent_winding_edges === 0 && v.degenerate_tris === 0 &&
      v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0 &&
      v.signed_volume > 0 && v.euler_characteristic === 2 - 2 * g;
    check(e.stl + ': closed, wound right, no self-intersection, genus ' + g, clean,
      v.open_edges + ' open, ' + v.nonmanifold_edges + ' nm, ' +
      v.self_intersection.pierce + ' pierce, euler ' + v.euler_characteristic +
      ' (want ' + (2 - 2 * g) + ')');
  }
}

/* =====================================================================
   5. DISTINCT, and the one claim the shape half of the set exists to make
   ===================================================================== */
console.log('\n== 5. thirteen different pieces, and eight of them one material figure ==');
{
  const bytes = new Map();
  let dupes = [];
  for (const e of MANIFEST.entries) {
    const b = fs.readFileSync(path.join(OUT, e.stl)).toString('latin1');
    if (bytes.has(b)) dupes.push(bytes.get(b) + ' == ' + e.stl);
    bytes.set(b, e.stl);
  }
  check('no two pieces are the same bytes', dupes.length === 0, dupes.join(', ') || 'all distinct');
  /* An ellipsoid at the target's own h/d of 1 WOULD have duplicated the
     sphere, exactly - which is nso_stock.js's own assertion and is the reason
     this one piece is asked for with a ratio. */
  check('...and the ellipsoid is the piece that had to be asked for, to avoid exactly that',
    MANIFEST.per_shape_overrides && MANIFEST.per_shape_overrides.ellipsoid &&
    MANIFEST.per_shape_overrides.ellipsoid.ratio > 1,
    JSON.stringify(MANIFEST.per_shape_overrides));

  const shapes = MANIFEST.entries.filter(e => e.kind === 'shape');
  check('all eight stock shapes are in the set',
    shapes.length === 8, shapes.map(e => e.shape).join(', '));
  /* THE CLAIM: one target, one material figure, eight shapes. The spread is
     their own tessellation deficits and nothing else - wider here than the
     0.098% the shipped 96-segment blanks show, because these are built at 32,
     which is the price of the set being cheap to walk. Bounded AND pinned:
     the loose bound below would pass on real drift, so the line under it
     asserts the spread IS the torus's own deficit against the exact box. */
  const need = shapes.map(e => e.sizing.need_volume_mm3);
  check('...every one sized from the SAME target asks for the same material',
    Math.max(...need) - Math.min(...need) < 1e-6, need[0].toFixed(6) + ' mm^3');
  const vols = shapes.map(e => e.volume_mm3);
  const spread = (Math.max(...vols) - Math.min(...vols)) / Math.max(...vols);
  check('...and the meshes hold it to within their own tessellation',
    spread < 0.02, vols.map(v => v.toFixed(1)).join(' / ') + ' mm^3 (' +
    (spread * 100).toFixed(3) + '% spread at ' + MANIFEST.target.segments + ' segments)');
  {
    const box = shapes.find(e => e.shape === 'box');       // exact, the ceiling
    const tor = shapes.find(e => e.shape === 'torus');     // furthest under, the floor
    check('...and that spread is the box against the torus, and nothing else',
      Math.abs(spread - (1 - tor.volume_mm3 / box.volume_mm3)) < 1e-9 &&
      Math.max(...vols) === box.volume_mm3 && Math.min(...vols) === tor.volume_mm3,
      (spread * 100).toFixed(4) + '% vs the torus\'s ' +
      ((1 - tor.volume_mm3 / box.volume_mm3) * 100).toFixed(4) + '% under the exact box');
  }
  check('...which is each one\'s built volume x its polygon factor, per shape',
    shapes.every(e => Math.abs(e.volume_mm3 -
      e.sizing.built_volume_mm3 * e.sizing.polygon_factor) /
      e.volume_mm3 < 1e-6),
    'to 1e-6 relative, float32 STL storage being the whole residual');
  /* And the target itself is small, which is WHY the set is fast. */
  check('the target behind them is a 10 mm piece, not a scaled-down big one',
    MANIFEST.target.height === 10 && MANIFEST.target.radius === 5,
    JSON.stringify(MANIFEST.target));
}

/* =====================================================================
   6. LOADABLE - the Library offers these, and offers the real files
   ===================================================================== */
console.log('\n== 6. the pieces the Library offers are these pieces ==');
{
  const cat = fs.readFileSync(path.join(ROOT, 'app-library.js'), 'utf8');
  const listed = (cat.match(/\{\s*file:\s*'([^']+)'[^}]*category:\s*'([^']+)'/g) || [])
    .map(row => ({
      file: (row.match(/file:\s*'([^']+)'/) || [])[1],
      category: (row.match(/category:\s*'([^']+)'/) || [])[1]
    }));
  const quick = listed.filter(r => fs.existsSync(path.join(OUT, r.file)));
  check('the catalog carries rows for pieces from this set', quick.length > 0,
    quick.length + ' row(s): ' + quick.map(r => r.file).join(', '));
  let mismatched = [], missing = [];
  const NL = LIBDIR.libraryDir();
  for (const r of NL ? quick : []) {
    const lib = path.join(NL, r.file);
    if (!fs.existsSync(lib)) { missing.push(r.file); continue; }
    if (!fs.readFileSync(lib).equals(fs.readFileSync(path.join(OUT, r.file)))) {
      mismatched.push(r.file);
    }
  }
  if (NL) {
    check('...and every one of them is really in nest-library, where the catalog fetches from',
      missing.length === 0, missing.join(', ') || 'all present');
    check('...byte-identical to the fixture it was taken from, so they cannot drift apart',
      mismatched.length === 0, mismatched.join(', ') || 'all identical');
  } else {
    LIBDIR.skip('...every one of them is really in nest-library, byte-identical to its fixture');
  }
  const cats = [...new Set(quick.map(r => r.category))];
  check('...and they are categorized, in a category the taxonomy declares',
    cats.length > 0 && cats.every(c => new RegExp("'" + c + "'").test(
      (cat.match(/^\s*var CATEGORIES = \[[^\]]*\]/m) || [''])[0])),
    cats.join(', '));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
process.exit(fail === 0 ? 0 : 1);
