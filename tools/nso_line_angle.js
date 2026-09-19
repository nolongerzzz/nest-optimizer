/* The angle a flat extruded line actually runs at, measured off the mesh.
 * Node only - a measuring instrument for the raster-line checks, not shipped.
 *
 * WHY THIS EXISTS. The reference raster tools/nso_raster_fixtures.js draws is
 * supposed to be a real printed interface layer, and a slicer prints those at
 * 45 degrees to the part's axes, not along them. Nothing measured that. The
 * first committed reference was drawn AXIS-ALIGNED - vertical lines joined by
 * horizontal turns - and every other number in the suite (line width, height,
 * watertightness, contact per crossing) was correct and angle-blind, so
 * nothing caught it. This file is the instrument that does, and the check
 * gates on it, so the orientation is now measured rather than assumed.
 *
 * HOW. Take the solid's VERTICAL wall triangles - the sides of the extruded
 * lines - and histogram each of their in-plane edge directions, weighted by
 * that edge's horizontal length, into 1-degree bins over 0..180 (direction is
 * undirected: a line at 200 degrees is a line at 20). A line of length L and
 * width w contributes 2L of wall at its own angle and 2w of end cap at 90
 * degrees to it, so a long thin line's own angle dominates its own weight -
 * which is what makes the share meaningful rather than a triangle count.
 *
 * Measured on the mesh and not on the traced path on purpose: the path is what
 * the tracer believes, the mesh is what ships. Both are available and the
 * check compares them (pathHistogram below), because agreement between them
 * is itself worth knowing.
 */
'use strict';

const { readSTL } = require('./nso_stl_io.js');

const BINS = 180;   /* 1 degree per bin, undirected */

function emptyHist() {
  return { bins: new Float64Array(BINS), total: 0 };
}

function addEdge(h, dx, dy, weight) {
  const len = Math.hypot(dx, dy);
  if (!(len > 1e-9)) return;                 /* a vertical edge has no direction */
  let deg = Math.atan2(dy, dx) * 180 / Math.PI;
  deg = ((deg % 180) + 180) % 180;
  h.bins[Math.round(deg) % BINS] += weight == null ? len : weight;
  h.total += weight == null ? len : weight;
}

/* The histogram of a raw soup's vertical-wall edge directions. */
function wallHistogram(soup, opts) {
  const o = opts || {};
  const flatTol = o.flatTol == null ? 1e-3 : o.flatTol;   /* |nz| below this = vertical wall */
  const h = emptyHist();
  const n = (soup.length / 9) | 0;
  for (let t = 0; t < n; t++) {
    const p = [];
    for (let k = 0; k < 3; k++) {
      const off = t * 9 + k * 3;
      p.push([soup[off], soup[off + 1], soup[off + 2]]);
    }
    const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    const nx = u[1] * v[2] - u[2] * v[1];
    const ny = u[2] * v[0] - u[0] * v[2];
    const nz = u[0] * v[1] - u[1] * v[0];
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-14) continue;                              /* degenerate */
    if (Math.abs(nz / L) > flatTol) continue;             /* a top or bottom face */
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      addEdge(h, p[b][0] - p[a][0], p[b][1] - p[a][1]);
    }
  }
  return h;
}

/* The same histogram straight off the traced polylines, weighted by segment
 * length - what the tracer believes, before any geometry is built. */
function pathHistogram(paths) {
  const h = emptyHist();
  for (const path of paths || []) {
    for (let k = 0; k + 1 < path.length; k++) {
      addEdge(h, path[k + 1][0] - path[k][0], path[k + 1][1] - path[k][1]);
    }
  }
  return h;
}

function fromSTL(file, opts) {
  return wallHistogram(readSTL(file), opts);
}

/* The share of the total weight within +/- `half` degrees of `centre`. */
function bandShare(h, centre, half) {
  if (!(h.total > 0)) return 0;
  const w = half == null ? 1 : half;
  let s = 0;
  for (let d = -w; d <= w; d++) s += h.bins[(((centre + d) % BINS) + BINS) % BINS];
  return s / h.total;
}

/* The heaviest +/- `half` band, scanned over every degree. Returns the band's
 * centre and its share, so "the dominant angle" is found rather than assumed. */
function dominantBand(h, half) {
  const w = half == null ? 1 : half;
  let best = { centre: 0, share: 0, peak: -1 };
  for (let c = 0; c < BINS; c++) {
    const s = bandShare(h, c, w);
    /* A band is a window, so neighbouring centres tie whenever the weight sits
       in one bin - 44+/-1 and 45+/-1 both cover bin 45. Break the tie on the
       CENTRE bin's own weight, or a family genuinely at 45 reports as 44. */
    if (s > best.share + 1e-12 || (Math.abs(s - best.share) <= 1e-12 && h.bins[c] > best.peak)) {
      best = { centre: c, share: s, peak: h.bins[c] };
    }
  }
  return { centre: best.centre, share: best.share };
}

/* Every band with at least `floor` of the weight, heaviest first, with
 * overlapping bands suppressed so two families read as two rows. */
function bands(h, half, floor) {
  const w = half == null ? 1 : half;
  const min = floor == null ? 0.02 : floor;
  const rows = [];
  const taken = new Uint8Array(BINS);
  const free = c => {
    for (let d = -w; d <= w; d++) if (taken[(((c + d) % BINS) + BINS) % BINS]) return false;
    return true;
  };
  for (;;) {
    let best = { centre: -1, share: 0, peak: -1 };
    for (let c = 0; c < BINS; c++) {
      if (!free(c)) continue;                  /* the whole band, not just its centre:
                                                  89+/-1 and 91+/-1 share bin 90 and are
                                                  the same family reported twice */
      const s = bandShare(h, c, w);
      if (s > best.share + 1e-12 || (Math.abs(s - best.share) <= 1e-12 && h.bins[c] > best.peak)) {
        best = { centre: c, share: s, peak: h.bins[c] };
      }
    }
    if (best.centre < 0 || best.share < min) break;
    rows.push(best);
    for (let d = -w; d <= w; d++) taken[(((best.centre + d) % BINS) + BINS) % BINS] = 1;
  }
  return rows;
}

function describe(h, half) {
  return bands(h, half).map(function (b) {
    return b.centre + '+/-' + (half == null ? 1 : half) + ' deg ' + (b.share * 100).toFixed(2) + '%';
  }).join(', ') + '  (' + h.total.toFixed(2) + ' mm of wall)';
}

module.exports = {
  BINS: BINS,
  wallHistogram: wallHistogram,
  pathHistogram: pathHistogram,
  fromSTL: fromSTL,
  bandShare: bandShare,
  dominantBand: dominantBand,
  bands: bands,
  describe: describe
};

/* node tools/nso_line_angle.js FILE.stl [...] - the histogram, as a table */
if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node tools/nso_line_angle.js FILE.stl [FILE.stl ...]');
    process.exit(2);
  }
  for (const f of files) {
    const h = fromSTL(f);
    const d = dominantBand(h, 1);
    console.log(f);
    console.log('  dominant  ' + d.centre + ' +/-1 deg   ' + (d.share * 100).toFixed(2) + '%');
    console.log('  bands     ' + describe(h, 1));
    console.log('  45 +/-1 ' + (bandShare(h, 45, 1) * 100).toFixed(2) + '%   ' +
      '90 +/-1 ' + (bandShare(h, 90, 1) * 100).toFixed(2) + '%   ' +
      '0 +/-1 ' + (bandShare(h, 0, 1) * 100).toFixed(2) + '%   ' +
      '135 +/-1 ' + (bandShare(h, 135, 1) * 100).toFixed(2) + '%');
  }
}
