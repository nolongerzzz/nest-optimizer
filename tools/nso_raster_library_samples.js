/* The traced-line pieces in the Library, built from the REAL images.
 *     node tools/nso_raster_library_samples.js            write library/traced_*.stl
 *     node tools/nso_raster_library_samples.js --check    byte-diff, writes nothing
 *
 * These are catalog entries, so the one thing that matters is where they come
 * from. Every one is built by nso_raster_lines.js from a file in
 * fixtures/raster-real/ - a picture Chromium drew, not this repo - and every
 * one of those pictures is validated by tools/nso_raster_real_test.js against
 * its own ground truth and against tools/nso_raster_image_probe.js before it
 * gets here. Nothing in this list is a shape invented to look right.
 *
 * What each one is FOR, since a coupon with no purpose is clutter:
 *
 *   traced_cross_23-67    two strokes crossing once at 23 and 67 degrees. This
 *                         is the piece that found the bug: the crossing came
 *                         back as two junctions with a 0.89 mm rail between
 *                         them until collapseBridges. It is the interface
 *                         crossing the module exists for, at an angle no
 *                         synthetic fixture used.
 *   traced_parallel_113   two isolated strokes at 113 degrees that touch
 *                         nothing - two components, and the piece whose
 *                         section can be measured straight off the mesh. It is
 *                         the width coupon: both bands are 0.4202 mm across
 *                         although the picture was drawn at 7 px.
 *   traced_hand_stroke    one hand-drawn wobbly stroke. It is the piece that
 *                         shows the tracer following a line it did not expect
 *                         rather than straightening it: the traced directions
 *                         span 7 to 34 degrees, inside the 6.9 to 39.1 the
 *                         stroke was actually drawn with.
 *
 * All at 30 mm wide, the footprint the skin patches and skin samples use, so a
 * traced coupon and a patch coupon are the same size on the plate. Z up,
 * millimetres, resting on z = 0.
 *
 * Every piece is a one-extrusion-line lattice - 0.42 mm walls, the repo's own
 * minimum - so all three are flagged non-solid in the catalog, for the reason
 * the loose skin patches are.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const RL = require('../nso_raster_lines.js');
const ANG = require('./nso_line_angle.js');
const { readPNG } = require('./nso_png.js');
const { writeSTL } = require('./nso_stl_io.js');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'fixtures', 'raster-real');
const OUT = path.join(ROOT, 'library');
const TRUTH = JSON.parse(fs.readFileSync(path.join(SRC, 'ground-truth.json'), 'utf8'));

const SIZE_MM = 30;

const SAMPLES = [
  { out: 'traced_cross_23-67.stl',  from: 'skew-cross.png',  header: 'nso traced lines: 23/67 crossing' },
  { out: 'traced_parallel_113.stl', from: 'two-apart.png',   header: 'nso traced lines: 113 parallel pair' },
  { out: 'traced_hand_stroke.stl',  from: 'hand-stroke.png', header: 'nso traced lines: hand-drawn stroke' }
];

function build(spec) {
  const src = TRUTH.images.find(i => i.file === spec.from);
  if (!src) throw new Error(spec.from + ' is not in ground-truth.json');
  const r = RL.buildFromImage(readPNG(path.join(SRC, spec.from)),
    { widthMM: SIZE_MM, simplify: 1.5 });
  if (!r.ok) throw new Error(spec.from + ': ' + r.reason);
  /* the catalog must not be able to carry a piece the checks would reject */
  if (!r.closed) throw new Error(spec.out + ' is not closed: ' + r.openEdges + ' open edge(s)');
  if (r.components !== src.components) {
    throw new Error(spec.out + ': ' + r.components + ' component(s) for a picture with ' + src.components);
  }
  if (r.junctions !== src.junctions) {
    throw new Error(spec.out + ': ' + r.junctions + ' junction(s) for a picture with ' + src.junctions);
  }
  return { r, src };
}

function main() {
  const checkOnly = process.argv.includes('--check');
  let drift = 0;
  const manifest = {
    note: 'Built from fixtures/raster-real/, which tools/nso_raster_real_test.js validates against its own ground truth first.',
    sizeMM: SIZE_MM, lineWidth: RL.LINE_WIDTH, lineHeight: RL.LINE_HEIGHT, pieces: []
  };

  for (const spec of SAMPLES) {
    const { r, src } = build(spec);
    const file = path.join(OUT, spec.out);
    /* writeSTL only writes to a path, so --check builds into a temp file and
       byte-diffs that rather than trusting the one already on disk */
    const tmp = path.join(os.tmpdir(), 'nso-raster-' + spec.out);
    writeSTL(tmp, r.tris, spec.header);
    const fresh = fs.readFileSync(tmp);
    fs.unlinkSync(tmp);

    const bands = ANG.bands(ANG.wallHistogram(r.tris), 1, 0.05).map(b => b.centre);
    manifest.pieces.push({
      file: spec.out, from: spec.from, shows: src.shows,
      tris: r.tris_count, paths: r.paths, junctions: r.junctions, components: r.components,
      closed: r.closed, lineLength: Math.round(r.lineLength * 1000) / 1000,
      extent: r.extent.map(v => Math.round(v * 1000) / 1000),
      meshAngles: bands, bridgedPaths: r.bridgedPaths, nonSolid: true
    });

    if (checkOnly) {
      const have = fs.existsSync(file) ? fs.readFileSync(file) : null;
      const same = have && have.equals(fresh);
      console.log('  ' + (same ? 'ok   ' : 'DRIFT') + ' ' + spec.out +
        ' (' + r.tris_count + ' tris, ' + r.paths + ' path(s), ' + r.junctions + ' junction(s))');
      if (!same) drift++;
    } else {
      fs.writeFileSync(file, fresh);
      console.log('  wrote library/' + spec.out + ' - ' + r.describe);
    }
  }

  const mf = path.join(OUT, 'traced-lines.json');
  const text = JSON.stringify(manifest, null, 2) + '\n';
  if (checkOnly) {
    const have = fs.existsSync(mf) ? fs.readFileSync(mf, 'utf8') : null;
    const same = have === text;
    console.log('  ' + (same ? 'ok   ' : 'DRIFT') + ' traced-lines.json');
    if (!same) drift++;
  } else {
    fs.writeFileSync(mf, text);
    console.log('  wrote library/traced-lines.json');
  }

  if (checkOnly) {
    console.log(drift ? '\n' + drift + ' file(s) DRIFTED from what this code builds' : '\nlibrary traced lines match');
    process.exit(drift ? 1 : 0);
  }
}

main();
