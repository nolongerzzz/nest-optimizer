/* The rasters the raster-to-flat-line checks are fed, and the STLs they build.
 *     node tools/nso_raster_fixtures.js            regenerate fixtures/raster-lines/
 *     node tools/nso_raster_fixtures.js --check    byte-diff, exit 1 on drift
 *
 * WHY THESE RASTERS AND NOT SOME OTHER PICTURE. The reference case is the real
 * two-layer interface from the G-code investigation: a boustrophedon zigzag,
 * one direction per layer, with the second layer turned 90 degrees across the
 * first. So the raster is drawn at the SAME numbers the shipped loose zigzag
 * patch uses - 30 x 30 mm, 15 lines, 2.0 mm pitch, the line centres exactly
 * where NSO_Skin's ribIntervals(30, 1.2, 2.0, 0) puts its ridges (1, 3, ...,
 * 29 mm) - so the contact figures this produces and the ones
 * tools/nso_raster_line_audit.js measures off the shipped patch are the same
 * measurement of the same interface and differ in the SECTION alone.
 *
 * The stroke width DRAWN is deliberately not the line width printed: the
 * rasters are stroked 5 px (0.25 mm) and 13 px (0.65 mm) and both must come
 * back as a 0.42 mm line, because the picture supplies the centreline and the
 * caller supplies the section. The thin stroke is the reference; the fat one is
 * the fixture that proves it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const RL = require('../nso_raster_lines.js');
const { writePGM, writePBM } = require('./nso_pnm.js');
const { writeSTL } = require('./nso_stl_io.js');

const OUT = path.resolve(__dirname, '..', 'fixtures', 'raster-lines');

/* the reference interface's own numbers - the shipped zigzag's, not new ones */
const SIZE = 30;          /* mm, A_SIZE / NSO_SkinPatch.SIZE */
const PITCH = 2.0;        /* mm, NSO_Skin.PATTERNS.zigzag.defaults.pitch */
const LINES = 15;         /* ribIntervals(30, 1.2, 2.0, 0).length */
const FIRST = 1.0;        /* the first ridge's centre: start 0.4 + rib 1.2 / 2 */
/* How far the boustrophedon's END TURNS stop short of the footprint edge, and
 * this one IS a measurement rather than a copied figure. The turn is a rail
 * running ACROSS the lines, so in the layer above - which is this layer turned
 * 90 degrees - it lies PARALLEL to that layer's lines, and if it lands within
 * one line width of the outermost of them the two bond along the rail's whole
 * length instead of at a point. Measured on this raster, 15 lines at 2.0 mm
 * pitch whose centres the trace puts at 1.025, 3.025, ... mm:
 *     inset 1.00  the rail lands ON the 1.025 line: 197 patches, welds 2.42 mm
 *                 long, 55.90 mm^2 at a 0.42 mm line - 41% worse than a clean
 *                 crossing interface, from the path alone
 *     inset 0.50  0.5 mm of clearance: clean at 0.42 mm, and at 0.61 mm the
 *                 rail is closer than one line width - 197 patches, 2.61 mm
 *                 welds, 87.98 mm^2
 *     inset 0.25  0.775 mm of clearance, more than the widest measured line:
 *                 225 isolated crossings at BOTH widths, every one exactly
 *                 w x w, widest patch one line width across
 * So 0.25. tools/nso_raster_lines_test.js holds all three. */
const INSET = 0.25;
const PPMM = 20;          /* px per mm - 600 x 600 for a 30 mm patch */

/* ------------------------------------------------------------ rasterising */

/* Polylines in MILLIMETRES stroked into a grayscale raster. Ink is black (0).
 * `aa` shades the half-pixel band at the stroke's edge instead of stepping it,
 * so a fixture exists that only a threshold can read. */
function stroke(polylines, opts) {
  const o = opts || {};
  const ppmm = o.ppmm || PPMM;
  const w = Math.round((o.size || SIZE) * ppmm), h = w;
  const r = (o.strokePx || 5) / 2;
  const data = new Uint8Array(w * h).fill(255);
  const segs = [];
  for (const pl of polylines) {
    for (let k = 0; k + 1 < pl.length; k++) {
      segs.push([pl[k][0] * ppmm, (o.size || SIZE) * ppmm - pl[k][1] * ppmm,
                 pl[k + 1][0] * ppmm, (o.size || SIZE) * ppmm - pl[k + 1][1] * ppmm]);
    }
  }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const px = i + 0.5, py = j + 0.5;
    let best = Infinity;
    for (const s of segs) {
      const dx = s[2] - s[0], dy = s[3] - s[1], L2 = dx * dx + dy * dy;
      let t = L2 > 0 ? ((px - s[0]) * dx + (py - s[1]) * dy) / L2 : 0;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const d = Math.hypot(px - (s[0] + t * dx), py - (s[1] + t * dy));
      if (d < best) best = d;
    }
    if (o.aa) {
      const f = Math.max(0, Math.min(1, best - r + 0.5));   /* 0 inside, 1 outside */
      data[j * w + i] = Math.round(255 * f);
    } else if (best <= r) {
      data[j * w + i] = 0;
    }
  }
  return { width: w, height: h, data: data, channels: 1, ppmm: ppmm };
}

/* --------------------------------------------------------- the path shapes */

/* The real thing: a boustrophedon zigzag. Up the first line, across the top to
 * the second, down it, across the bottom to the third - one continuous path,
 * which is what a slicer emits and what makes this a zigzag rather than 15
 * separate lines. */
function zigzagPath(inset) {
  const ins = inset == null ? INSET : inset;
  const y0 = ins, y1 = SIZE - ins, pts = [];
  for (let k = 0; k < LINES; k++) {
    const x = FIRST + k * PITCH;
    if (k % 2 === 0) { pts.push([x, y0], [x, y1]); } else { pts.push([x, y1], [x, y0]); }
  }
  return [pts];
}

/* 15 lines each way in ONE picture: what the shipped crosshatch draws, and the
 * case that proves a 4-way crossing traces to a degree-4 junction whose pad is
 * the width x width square and nothing more. */
function crosshatchPath() {
  const a = INSET, b = SIZE - INSET, out = [];
  for (let k = 0; k < LINES; k++) {
    const c = FIRST + k * PITCH;
    out.push([[c, a], [c, b]]);
    out.push([[a, c], [b, c]]);
  }
  return out;
}

const RASTERS = [
  { name: 'zigzag-layer', paths: zigzagPath(), strokePx: 5, ext: 'pbm',
    note: 'the reference: one layer of the real two-layer zigzag, 15 lines at 2.0 mm pitch, stroked 5 px = 0.25 mm' },
  { name: 'zigzag-layer-fat', paths: zigzagPath(), strokePx: 13, ext: 'pbm',
    note: 'the same centrelines drawn 13 px = 0.65 mm wide - the traced line must still come out 0.42 mm' },
  { name: 'zigzag-layer-aa', paths: zigzagPath(), strokePx: 3, aa: true, ppmm: 10, ext: 'pgm',
    note: 'the same centrelines, anti-aliased grayscale at 10 px/mm - only a threshold can read it' },
  { name: 'crosshatch', paths: crosshatchPath(), strokePx: 5, ext: 'pbm',
    note: '15 lines each way in one raster - 225 four-way junctions' }
];

/* ------------------------------------------------------------------ build */

function buildAll() {
  const out = [];
  for (const spec of RASTERS) {
    const img = stroke(spec.paths, { strokePx: spec.strokePx, aa: spec.aa, ppmm: spec.ppmm });
    const r = RL.buildFromImage(img, { mmPerPixel: 1 / img.ppmm, simplify: 1.5 });
    if (!r.ok) throw new Error(spec.name + ': ' + r.reason);
    out.push({ spec: spec, img: img, build: r });
  }
  return out;
}

function meta(rec) {
  const r = rec.build;
  return {
    raster: rec.spec.name + '.' + rec.spec.ext,
    note: rec.spec.note,
    raster_px: [rec.img.width, rec.img.height],
    px_per_mm: rec.img.ppmm,
    stroke_px: rec.spec.strokePx,
    antialiased: !!rec.spec.aa,
    mm_per_px: r.mmPerPixel,
    threshold: r.image.threshold,
    ink_px: r.image.inkPixels,
    skeleton_px: r.image.skeletonPixels,
    traced_paths: r.tracedPaths,
    trace_vertices: r.traceVertices,
    simplify_px: r.simplifyPx,
    path_vertices: r.pathVertices,
    nodes: r.nodes, segments: r.segments, junctions: r.junctions, max_degree: r.maxDegree,
    line_length_mm: +r.lineLength.toFixed(6),
    line_width_mm: r.width, line_height_mm: r.height,
    tris: r.tris_count, components: r.components,
    unique_edges: r.uniqueEdges, open_edges: r.openEdges, nonmanifold_edges: r.nonManifoldEdges,
    closed: r.closed,
    extent_mm: r.extent.map(x => +x.toFixed(6)),
    describe: r.describe
  };
}

function main() {
  const check = process.argv.includes('--check');
  fs.mkdirSync(OUT, { recursive: true });
  const built = buildAll();
  const index = { generated_by: 'tools/nso_raster_fixtures.js', entries: [] };
  let drift = 0;
  for (const rec of built) {
    const pgm = path.join(OUT, rec.spec.name + '.' + rec.spec.ext);
    const stl = path.join(OUT, rec.spec.name + '.stl');
    const m = meta(rec);
    index.entries.push(m);
    const pgmBuf = (() => {
      const tmp = pgm + '.tmp';
      const w = rec.spec.ext === 'pbm' ? writePBM : writePGM;
      w(tmp, rec.img.width, rec.img.height, rec.img.data, rec.spec.note);
      const b = fs.readFileSync(tmp); fs.unlinkSync(tmp); return b;
    })();
    const stlBuf = (() => {
      const tmp = stl + '.tmp';
      writeSTL(tmp, rec.build.tris, 'NSO raster lines ' + rec.spec.name);
      const b = fs.readFileSync(tmp); fs.unlinkSync(tmp); return b;
    })();
    for (const [file, buf] of [[pgm, pgmBuf], [stl, stlBuf]]) {
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
    console.log('       ' + m.describe);
  }
  const jf = path.join(OUT, 'raster-lines.json');
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
  if (check && drift) {
    console.log('\n' + drift + ' fixture(s) drifted - rerun without --check if the change is intended');
    process.exit(1);
  }
  console.log('\n' + (check ? 'fixtures match' : 'fixtures written'));
}

module.exports = { stroke, zigzagPath, crosshatchPath, RASTERS, buildAll, SIZE, PITCH, LINES, FIRST, INSET, PPMM, OUT };
if (require.main === module) main();
