/* The crosshatch interface this repo builds today, written out and byte-diffed.
 *     node tools/nso_crosshatch_fixtures.js            regenerate fixtures/crosshatch/
 *     node tools/nso_crosshatch_fixtures.js --check    byte-diff, exit 1 on drift
 *
 * WHY THESE FOUR. The reference is the shipped crosshatch's OWN numbers - 1.2 mm
 * pitch, a 0.42 mm rib, a 30 mm footprint - so that what is written here and
 * what tools/nso_raster_line_audit.js measures off the shipped loose patch are
 * the same pattern at the same figures and differ in the CONSTRUCTION alone:
 * one layer of ribs both ways there, two layers of one direction each here.
 *
 *   layer1 / layer2   one printed layer, on its own. Each is a closed shell and
 *                     passes the canonical checker clean - it is what a piece
 *                     ends or starts with.
 *   interface         the two of them, layer 2 set down on layer 1's top. Two
 *                     shells touching at z = 0.3, which is what two stacked
 *                     pieces are.
 *   interface-45      THE RE-TILE. The same pitch, the same 0.42 mm line, the
 *                     same 0.78 mm channel, a 45 mm target instead of 30 - so
 *                     the only thing that differs from `interface` is the NUMBER
 *                     OF REPEATS. crosshatch.json carries both, and the check
 *                     asserts the first 25 line centres are identical between
 *                     them bit for bit, which a scale could not be.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const C = require('../nso_crosshatch.js');
const { writeSTL } = require('./nso_stl_io.js');
const ANG = require('./nso_line_angle.js');
const { interfaceContact } = require('./nso_contact_area.js');

const OUT = path.resolve(__dirname, '..', 'fixtures', 'crosshatch');

/* the shipped crosshatch's own figures - see the header */
const SIZE = 30;
const RETILE = 45;

function measure(built) {
  const ct = interfaceContact(built.layers[0].tris, built.layers[1].tris, { plane: built.interfaceZ });
  return {
    contact_mm2: +ct.area.toFixed(6),
    contact_patches: ct.patches,
    patch_area_min_mm2: +Math.min.apply(null, ct.patchAreas).toFixed(6),
    patch_area_max_mm2: +Math.max.apply(null, ct.patchAreas).toFixed(6),
    widest_patch_span_mm: +ct.maxPatchSpan.toFixed(6)
  };
}

function angleOf(tris) {
  const h = ANG.wallHistogram(tris);
  return {
    dominant_deg: ANG.dominantBand(h, 1).centre,
    dominant_share: +ANG.dominantBand(h, 1).share.toFixed(5),
    share_45: +ANG.bandShare(h, 45, 1).toFixed(5),
    share_135: +ANG.bandShare(h, 135, 1).toFixed(5),
    axis_aligned_share: +(ANG.bandShare(h, 0, 1) + ANG.bandShare(h, 90, 1)).toFixed(5)
  };
}

function entry(name, built, note) {
  const pl = built.plan;
  return {
    stl: name + '.stl',
    note: note,
    pitch_mm: pl.pitch, line_width_mm: pl.width, line_height_mm: pl.height,
    channel_mm: pl.channel,
    lines_deg: [pl.angle, (pl.angle + 90) % 180],
    ends: pl.ends,
    end_turn_offset_mm: pl.turnOffset, end_turn_clearance_mm: pl.turnClearance,
    repeats: [pl.repeatsU, pl.repeatsV],
    span_mm: [+pl.spanU.toFixed(6), +pl.spanV.toFixed(6)],
    span_asked_mm: [pl.spanAskedU, pl.spanAskedV],
    residual_mm: [pl.residualU, pl.residualV],
    line_centres_mm: pl.centresU.map(x => +x.toFixed(6)),
    crossings: pl.crossings,
    tris: built.tris_count, shells: built.shells, components: built.components,
    open_edges: built.openEdges, nonmanifold_edges: built.nonManifoldEdges,
    extent_mm: built.extent.map(x => +x.toFixed(6)),
    interface_z_mm: +built.interfaceZ.toFixed(6),
    total_height_mm: +built.totalHeight.toFixed(6),
    contact: measure(built),
    layer1_angle: angleOf(built.layers[0].tris),
    layer2_angle: angleOf(built.layers[1].tris),
    describe: built.describe
  };
}

function buildAll() {
  const ref = C.build({ W: SIZE, D: SIZE });
  if (!ref.ok) throw new Error('reference: ' + ref.reason);
  const big = C.retile({ W: SIZE, D: SIZE }, { W: RETILE, D: RETILE });
  if (!big.ok) throw new Error('re-tile: ' + big.reason);
  return { ref, big };
}

function main() {
  const check = process.argv.includes('--check');
  fs.mkdirSync(OUT, { recursive: true });
  const { ref, big } = buildAll();
  const files = [
    ['layer1', ref.layers[0].tris],
    ['layer2', ref.layers[1].tris],
    ['interface', ref.tris],
    ['interface-45', big.tris]
  ];
  const index = {
    generated_by: 'tools/nso_crosshatch_fixtures.js',
    entries: [
      entry('interface', ref, 'the reference: two one-direction layers at the shipped crosshatch\'s ' +
        'own 1.2 mm pitch and 0.42 mm rib, a 30 mm target. layer1.stl and layer2.stl are its two ' +
        'layers on their own.'),
      entry('interface-45', big, 'the SAME pattern re-tiled to a 45 mm target: more repeats, ' +
        'pitch / width / channel and every shared line centre unchanged.')
    ]
  };
  let drift = 0;
  for (const [name, tris] of files) {
    const file = path.join(OUT, name + '.stl');
    const tmp = file + '.tmp';
    writeSTL(tmp, tris, 'NSO crosshatch ' + name);
    const buf = fs.readFileSync(tmp); fs.unlinkSync(tmp);
    if (check) {
      const have = fs.existsSync(file) ? fs.readFileSync(file) : null;
      const same = have && have.equals(buf);
      console.log('  ' + (same ? 'ok   ' : 'DRIFT') + ' ' + path.relative(process.cwd(), file) +
        ' (' + buf.length + ' bytes)' + (same ? '' : have ? ' - was ' + have.length : ' - missing'));
      if (!same) drift++;
    } else {
      fs.writeFileSync(file, buf);
      console.log('  wrote ' + path.relative(process.cwd(), file) + ' (' + buf.length + ' bytes)');
    }
  }
  const jf = path.join(OUT, 'crosshatch.json');
  const jtxt = JSON.stringify(index, null, 2) + '\n';
  if (check) {
    const have = fs.existsSync(jf) ? fs.readFileSync(jf, 'utf8') : null;
    const same = have === jtxt;
    console.log('  ' + (same ? 'ok   ' : 'DRIFT') + ' ' + path.relative(process.cwd(), jf));
    if (!same) drift++;
  } else {
    fs.writeFileSync(jf, jtxt);
    console.log('  wrote ' + path.relative(process.cwd(), jf));
  }
  for (const e of index.entries) console.log('       ' + e.describe);
  if (check && drift) {
    console.log('\n' + drift + ' fixture(s) drifted - rerun without --check if the change is intended');
    process.exit(1);
  }
  console.log('\n' + (check ? 'fixtures match' : 'fixtures written'));
}

module.exports = { buildAll, entry, measure, OUT, SIZE, RETILE };
if (require.main === module) main();
