/* A raster of line art -> a flat, thin, watertight STL. Node only.
 *
 *   node tools/nso_raster_lines_cli.js IN.(pbm|pgm|ppm) OUT.stl [options]
 *
 *   --width MM        printed line width (default 0.42, the measured Bambu
 *                     line and one extrusion line at a 0.4 nozzle; the
 *                     measured range runs to 0.61)
 *   --height MM       printed line height (default 0.3, the layer height)
 *   --mm-per-px X     scale. Default 0.1 mm/px
 *   --size MM         instead of --mm-per-px: the raster's full pixel WIDTH
 *                     becomes this many mm
 *   --threshold N     0..255, a pixel is ink BELOW it (default 128)
 *   --invert          ink is the light side instead
 *   --simplify PX     Douglas-Peucker tolerance in pixels (default 1.0)
 *   --min-segment MM  shortest segment kept; shorter ones collapse into the
 *                     corner they round off (default = the line width)
 *   --base-z MM       the z the underside sits at (default 0)
 *   --layers N        stack N copies, each turned 90 degrees from the one
 *                     below and set down on it - the two-layer interface
 *                     construction, in one file (default 1)
 *   --json            print the report as JSON instead of prose
 *
 * The image decoding is netpbm only, because nso_raster_lines.js decodes
 * nothing: in the browser a canvas hands it an ImageData for every format the
 * browser can open. To bring a PNG or a JPEG through here, convert it first
 * (`magick in.png out.pgm`, or any viewer's "export as PGM").
 */
'use strict';

const path = require('path');
const RL = require('../nso_raster_lines.js');
const { readPNM } = require('./nso_pnm.js');
const { writeSTL } = require('./nso_stl_io.js');

function usage(msg) {
  if (msg) console.error('error: ' + msg + '\n');
  console.error(require('fs').readFileSync(__filename, 'utf8').split('*/')[0]
    .split('\n').slice(1).map(l => l.replace(/^ \* ?/, '').replace(/^ \*$/, '')).join('\n'));
  process.exit(msg ? 2 : 0);
}

function main(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage();
    if (a === '--invert') { opt.invert = true; continue; }
    if (a === '--json') { opt.json = true; continue; }
    if (a.startsWith('--')) {
      const v = argv[++i];
      if (v === undefined) usage('missing value for ' + a);
      opt[a.slice(2)] = v;
      continue;
    }
    pos.push(a);
  }
  if (pos.length !== 2) usage('needs exactly an input raster and an output STL');
  const [inFile, outFile] = pos;
  const num = (k, d) => (opt[k] === undefined ? d : Number(opt[k]));

  const img = readPNM(inFile);
  const layers = Math.max(1, num('layers', 1) | 0);
  const build = {
    width: num('width', RL.LINE_WIDTH),
    height: num('height', RL.LINE_HEIGHT),
    threshold: num('threshold', 128),
    invert: !!opt.invert,
    simplify: num('simplify', 1.0),
    baseZ: num('base-z', 0)
  };
  if (opt['min-segment'] !== undefined) build.minSegment = num('min-segment');
  if (opt['mm-per-px'] !== undefined) build.mmPerPixel = num('mm-per-px');
  else if (opt.size !== undefined) build.widthMM = num('size');
  else build.mmPerPixel = 0.1;

  const r = RL.buildFromImage(img, build);
  if (!r.ok) { console.error('refused: ' + r.reason); process.exit(1); }

  /* the stack: each layer the one below turned 90 degrees about the raster's
     own centre, set down on it. One soup, several shells - exactly what two
     stacked pieces are, and what the contact measurement wants to see. */
  const W = img.width * r.mmPerPixel, D = img.height * r.mmPerPixel;
  const cx = W / 2, cy = D / 2;
  let tris = r.tris;
  if (layers > 1) {
    const all = [];
    for (let k = 0; k < layers; k++) {
      const th = k * Math.PI / 2, c = Math.cos(th), s = Math.sin(th), dz = k * r.height;
      for (let i = 0; i < r.tris.length; i += 3) {
        const x = r.tris[i] - cx, y = r.tris[i + 1] - cy;
        all.push(x * c - y * s + cx, x * s + y * c + cy, r.tris[i + 2] + dz);
      }
    }
    tris = new Float32Array(all);
  }
  const n = writeSTL(outFile, tris, 'NSO raster lines ' + path.basename(inFile));

  if (opt.json) {
    const out = Object.assign({}, r, { tris: undefined, layers: layers, stlTriangles: n, out: outFile });
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(r.describe);
    console.log('  raster      ' + r.image.w + ' x ' + r.image.h + ' px, ' + r.image.inkPixels +
      ' ink -> ' + r.image.skeletonPixels + ' skeleton px in ' + r.image.thinningPasses + ' passes' +
      ' (threshold ' + r.image.threshold + (r.image.invert ? ', inverted' : '') + ')');
    console.log('  trace       ' + r.tracedPaths + ' path(s), ' + r.traceVertices +
      ' pixel vertices -> ' + r.pathVertices + ' after simplify ' + r.simplifyPx + ' px');
    console.log('  section     ' + r.width + ' mm wide x ' + r.height + ' mm tall, base z ' + r.baseZ);
    console.log('  solid       ' + r.pads + ' pad(s) + ' + r.quads + ' quad(s), ' + r.walls +
      ' boundary wall(s), ' + r.tris_count + ' triangles, ' + r.components + ' component(s)');
    console.log('  wrote       ' + outFile + ' - ' + n + ' triangle(s)' +
      (layers > 1 ? ', ' + layers + ' layers each turned 90 deg from the last' : ''));
  }
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { main };
