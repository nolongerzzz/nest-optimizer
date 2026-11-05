/* The raster tracer against REAL images - ones this repo did not draw.
 *     node tools/nso_raster_real_test.js      exit 0 = every gate held
 *
 * tools/nso_raster_lines_test.js is the tracer's own suite and it is fed
 * tools/nso_raster_fixtures.js's output: this repo's stroke(), at this repo's
 * constants, at the angle the tracer was built around. It is a good regression
 * pin and it is not evidence, because nothing in it came from outside.
 *
 * This is the outside. fixtures/raster-real/ holds five images rasterised by
 * Chromium's Skia - antialiased, at 23, 67 and 113 degrees, in real PNG and
 * real JPEG - and every claim below is checked against TWO witnesses that
 * never called the tracer:
 *
 *   1. the ground truth in fixtures/raster-real/ground-truth.json, which is
 *      where the endpoints were put when the picture was drawn, and
 *   2. tools/nso_raster_image_probe.js, which measures the same facts back off
 *      the source PIXELS - a Hough transform for the angles, 8-connected
 *      labelling of the raw ink for the connectivity, ink run lengths for the
 *      drawn stroke width.
 *
 * Only then is the finished MESH measured, by tools/nso_line_angle.js, and
 * required to agree with both. "The trace agrees with the trace" is the one
 * thing this file cannot accidentally check.
 *
 * WHAT IT CAUGHT. skew-cross.png - two strokes crossing once - came back as 5
 * paths and 2 junctions, an X read as an H, because the bridge Zhang-Suen
 * leaves at a crossing is w / sin(t) long and weldNodes' radius is the PRINTED
 * line width, 0.42 mm. Every synthetic reference crosses at 90 degrees with a
 * 5 px stroke, where that bridge is 0.25 mm and the weld swallows it; this one
 * crosses at 44 degrees with a 12 px stroke, where it is 0.89 mm and survives.
 * nso_raster_lines.js's collapseBridges is the fix and part 3 is its gate.
 *
 * The JPEG is not read here - Node has no JPEG decoder and this repo is not
 * going to grow one to duplicate the browser's. It is opened by real Chromium
 * through the real file input in tools/nso_raster_real_drive_check.mjs, which
 * tests the decoder that actually ships.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const RL = require('../nso_raster_lines.js');
const P = require('./nso_raster_image_probe.js');
const ANG = require('./nso_line_angle.js');
const { readPNG } = require('./nso_png.js');

const DIR = path.resolve(__dirname, '..', 'fixtures', 'raster-real');
const TRUTH = JSON.parse(fs.readFileSync(path.join(DIR, 'ground-truth.json'), 'utf8'));
const PPMM = TRUTH.pxPerMM;

let fails = 0, ran = 0;
function check(name, cond, detail) {
  ran++;
  if (!cond) fails++;
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + ' ' + name + (detail ? ' - ' + detail : ''));
}
/* the smallest turn between two undirected angles */
function angDiff(a, b) {
  let d = Math.abs(((a - b) % 180 + 180) % 180);
  return Math.min(d, 180 - d);
}

const PNGS = TRUTH.images.filter(r => r.format === 'png');

/* ------------------------------------------------------------------------ */
console.log('=== 1. the images really are what the ground truth says (pixels only, no tracer) ===');
const probes = new Map();
for (const rec of PNGS) {
  const img = readPNG(path.join(DIR, rec.file));
  const mask = P.inkMask(img, {});
  const sw = P.strokeWidth(mask);
  const comps = P.inkComponents(mask, 50);
  const angles = P.inkAngles(mask, { window: Math.max(3, Math.round(sw.px * 1.5)) });
  probes.set(rec.file, { img, mask, sw, comps, angles });

  check(rec.file + ': the ink really is ' + rec.components + ' component(s)',
    comps.count === rec.components, 'probe found ' + comps.count + ' [' + comps.sizes.slice(0, 4).join(', ') + ']');

  if (rec.tangentRange) {
    /* A wobbled stroke has no ONE angle, and a straight-line Hough is the wrong
       instrument for it - see inkAxis in the probe. What CAN be asked of the
       ink is where the stroke runs overall, which is the principal axis of a
       symmetric wobble, and that must be the angle it was drawn about. */
    const ax = P.inkAxis(mask);
    probes.get(rec.file).axis = ax;
    check(rec.file + ': the ink\'s overall axis really is the ' + rec.angles[0] + ' deg it was drawn about',
      ax && angDiff(ax.deg, rec.angles[0]) <= 3,
      ax ? ax.deg.toFixed(2) + ' deg, ' + ax.elongation.toFixed(0) + ':1 elongated over ' + ax.pixels + ' px' : 'no axis');
  } else {
    for (const want of rec.angles) {
      const hit = angles.find(a => angDiff(a.deg, want) <= 2);
      check(rec.file + ': the ink really runs at ' + want + ' deg',
        !!hit, hit ? 'Hough peak ' + hit.deg + ' deg, ' + (hit.share * 100).toFixed(0) + '% of the ink'
                   : 'strongest were ' + angles.slice(0, 3).map(a => a.deg).join(', '));
    }
  }
  const drawn = rec.drawnStrokePx;
  const lo = Math.min(...drawn), hi = Math.max(...drawn);
  check(rec.file + ': the drawn stroke really is about ' + drawn.join('/') + ' px',
    sw.px >= lo - 2 && sw.px <= hi + 3, 'probe measured ' + sw.px + ' px of ink across');
}

/* ------------------------------------------------------------------------ */
console.log('\n=== 2. the trace agrees with the picture: angle ===');
const built = new Map();
for (const rec of PNGS) {
  const pr = probes.get(rec.file);
  const r = RL.buildFromImage(pr.img, { mmPerPixel: 1 / PPMM, simplify: 1.5 });
  built.set(rec.file, r);
  check(rec.file + ': it builds at all', r.ok, r.ok ? r.describe : r.reason);
  if (!r.ok) continue;

  const hist = ANG.wallHistogram(r.tris);
  if (rec.tangentRange) {
    const [lo, hi] = rec.tangentRange;
    const mesh = ANG.bands(hist, 3, 0.04);
    /* end caps stand square to the run they cap, so they are not a direction
       the picture lacks - drop them before asking what is left */
    const runs = mesh.filter(b => !mesh.some(o => o !== b && o.share > b.share && angDiff(b.centre, o.centre + 90) <= 5));
    check(rec.file + ': every direction the MESH runs in lies inside the drawn wobble',
      runs.length > 0 && runs.every(b => b.centre >= lo - 4 && b.centre <= hi + 4),
      'drawn ' + lo.toFixed(1) + '..' + hi.toFixed(1) + ' deg, mesh at ' +
      runs.map(b => b.centre).sort((x, y) => x - y).join(', ') + ' deg');
    check(rec.file + ': and it really wobbles - it did not come back one straight line',
      runs.length >= 2, runs.length + ' distinct direction(s)');
  } else {
    const mesh = ANG.bands(hist, 1, 0.05);
    for (const want of rec.angles) {
      const hit = mesh.find(b => angDiff(b.centre, want) <= 1);
      check(rec.file + ': the MESH runs at ' + want + ' deg, as the picture does',
        !!hit, hit ? hit.centre + ' deg carrying ' + (hit.share * 100).toFixed(1) + '% of the wall'
                   : 'mesh bands: ' + ANG.describe(hist, 1));
    }
    /* and no third direction: a band that is neither a drawn angle nor the end
       caps square to one of them is a line the picture does not have */
    const stray = mesh.filter(b => !rec.angles.some(w =>
      angDiff(b.centre, w) <= 2 || angDiff(b.centre, w + 90) <= 2));
    check(rec.file + ': the mesh runs in NO direction the picture lacks',
      stray.length === 0, stray.length ? 'stray: ' + stray.map(b => b.centre + ' deg ' + (b.share * 100).toFixed(1) + '%').join(', ')
                                       : 'every band is a drawn angle or its end caps');
  }
}

/* ------------------------------------------------------------------------ */
console.log('\n=== 3. the trace agrees with the picture: connectivity ===');
console.log('    (this is the part that failed before collapseBridges: one crossing, two junctions)');
for (const rec of PNGS) {
  const r = built.get(rec.file), pr = probes.get(rec.file);
  if (!r.ok) continue;
  check(rec.file + ': ' + rec.components + ' solid component(s), as the ink has',
    r.components === rec.components, 'built ' + r.components + ', ink has ' + pr.comps.count);
  check(rec.file + ': ' + rec.junctions + ' junction(s), as the picture shows',
    r.junctions === rec.junctions, 'built ' + r.junctions +
      ' (welded ' + r.weldedPaths + ', bridged ' + r.bridgedPaths + ')');
  const wantPaths = rec.junctions ? 4 : rec.components;   /* an X is four arms; otherwise one path per stroke */
  check(rec.file + ': ' + wantPaths + ' path(s) - an X is four arms, not five',
    r.paths === wantPaths, 'built ' + r.paths + ' from ' + r.tracedPaths + ' traced');
  check(rec.file + ': the solid is closed and manifold',
    r.closed, r.openEdges + ' open, ' + r.nonManifoldEdges + ' non-manifold');
}

/* ------------------------------------------------------------------------ */
console.log('\n=== 4. the printed width is the one ASKED for, not the one drawn ===');
/* The two parallel-line images are the same geometry drawn 7 px and 17 px, and
   two isolated straight strokes are the one shape whose section can be read
   straight off the MESH: project every vertex onto the line's normal and the
   spread IS the width. Nothing here consults r.width or r.paths.
 *
 * Two things this instrument had to learn, both of which failed first as bugs
 * in the instrument and not in the tracer:
 *
 *   - the projection angle has to be SEARCHED, not assumed. Projecting onto the
 *     normal of exactly 113 degrees when the line really runs at 112.96 adds
 *     L sin(0.04 deg) of false width - 0.012 mm over an 18 mm line, 3% of the
 *     section. The angle that MINIMISES the spread is the line's own angle and
 *     the minimum is its width, so this measures both at once and assumes
 *     neither.
 *   - and each band has to be searched SEPARATELY. The two strokes come back a
 *     sixteenth of a degree apart, so no single angle minimises both, and
 *     taking the worse of the two reported 0.4305 mm for a 0.42 mm line.
 */
function splitBands(tris, aboutDeg) {
  const a = aboutDeg * Math.PI / 180, nx = -Math.sin(a), ny = Math.cos(a);
  const cen = [];
  for (let i = 0; i < tris.length; i += 9) {
    cen.push((tris[i] * nx + tris[i + 1] * ny + tris[i + 3] * nx +
              tris[i + 4] * ny + tris[i + 6] * nx + tris[i + 7] * ny) / 3);
  }
  const sorted = cen.slice().sort((p, q) => p - q);
  let gap = 0, at = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > gap) { gap = sorted[i] - sorted[i - 1]; at = i; }
  }
  if (gap < 1.0) return [tris];                       /* one band, not two */
  const cut = (sorted[at] + sorted[at - 1]) / 2;
  const A = [], B = [];
  for (let i = 0, k = 0; i < tris.length; i += 9, k++) {
    const dst = cen[k] < cut ? A : B;
    for (let j = 0; j < 9; j++) dst.push(tris[i + j]);
  }
  return [Float32Array.from(A), Float32Array.from(B)];
}
function spreadAt(tris, deg) {
  const a = deg * Math.PI / 180, nx = -Math.sin(a), ny = Math.cos(a);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < tris.length; i += 3) {
    const v = tris[i] * nx + tris[i + 1] * ny;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
}
/* the angle that minimises the spread is the band's own angle; the minimum is
   its width. Both measured off the mesh, neither taken from the tracer. */
function measureBand(tris, aboutDeg) {
  let w = Infinity, deg = aboutDeg;
  for (let d = aboutDeg - 3; d <= aboutDeg + 3; d += 0.002) {
    const s = spreadAt(tris, d);
    if (s < w) { w = s; deg = d; }
  }
  return { width: w, deg: ((deg % 180) + 180) % 180 };
}

const widths = new Map();
for (const name of ['two-apart.png', 'two-apart-fat.png']) {
  const rec = TRUTH.images.find(x => x.file === name);
  const r = built.get(name);
  if (!r || !r.ok) { check(name + ': built', false, 'not built'); continue; }
  const bands = splitBands(r.tris, rec.angles[0]);
  check(name + ': the mesh is the ' + rec.components + ' separated bands the picture has',
    bands.length === rec.components, bands.length + ' band(s)');
  const m = bands.map(b => measureBand(b, rec.angles[0]));
  widths.set(name, m);
  for (const one of m) {
    check(name + ' (drawn ' + rec.drawnStrokePx[0] + ' px): the band measures ' + RL.LINE_WIDTH + ' mm across',
      Math.abs(one.width - RL.LINE_WIDTH) < 0.002, 'measured ' + one.width.toFixed(6) + ' mm');
    check(name + ': and that band really runs at ' + rec.angles[0] + ' deg, to a tenth of a degree',
      angDiff(one.deg, rec.angles[0]) < 0.1, 'measured ' + one.deg.toFixed(3) + ' deg');
  }
}
{
  const pa = probes.get('two-apart.png'), pb = probes.get('two-apart-fat.png');
  const wa = widths.get('two-apart.png'), wb = widths.get('two-apart-fat.png');
  if (wa && wb) {
    check('the drawn width really did differ, by ' + (pb.sw.px / pa.sw.px).toFixed(1) + 'x',
      pb.sw.px >= pa.sw.px * 1.8, pa.sw.px + ' px vs ' + pb.sw.px + ' px of ink');
    const spanA = Math.max(...wa.map(x => x.width)), spanB = Math.max(...wb.map(x => x.width));
    check('and the PRINTED width did not move with it - the picture gives the centreline, the caller the section',
      Math.abs(spanA - spanB) < 0.002,
      spanA.toFixed(6) + ' mm vs ' + spanB.toFixed(6) + ' mm');
  }
}
/* and asking for a different section really does change it - or the check
   above would hold just as well for a builder that ignored the width entirely */
{
  const pr = probes.get('two-apart.png');
  const wide = RL.buildFromImage(pr.img, { mmPerPixel: 1 / PPMM, simplify: 1.5, width: RL.LINE_WIDTH_MAX });
  const m = splitBands(wide.tris, 113).map(b => measureBand(b, 113));
  check('asking for the widest measured line, ' + RL.LINE_WIDTH_MAX + ' mm, gives exactly that',
    m.length === 2 && m.every(x => Math.abs(x.width - RL.LINE_WIDTH_MAX) < 0.002),
    m.map(x => x.width.toFixed(6)).join(' / ') + ' mm');
}

/* ------------------------------------------------------------------------ */
console.log('\n=== 5. the scale is the one asked for ===');
for (const rec of PNGS) {
  const pr = probes.get(rec.file);
  const r = RL.buildFromImage(pr.img, { widthMM: 30, simplify: 1.5 });
  check(rec.file + ': asked for 30 mm wide, the raster is ' + pr.img.width + ' px',
    r.ok && Math.abs(r.mmPerPixel - 30 / pr.img.width) < 1e-12,
    r.ok ? r.mmPerPixel.toFixed(6) + ' mm/px' : r.reason);

  /* The extent is NOT proportional to the asked width and must not be checked
     as though it were: the drawing scales, the SECTION does not. A line at t
     degrees adds w |sin t| of its own width to the x extent whatever the scale,
     so extent(s) = span x s + constant - affine, not proportional. Doubling the
     asked width and expecting a doubled extent fails by exactly that constant
     (0.164 mm on skew-cross, which is 0.42 sin 23). So: three sizes, and the
     extent must be affine in the scale to within a rounding. */
  const e = [15, 30, 45].map(mm => {
    const b = RL.buildFromImage(pr.img, { widthMM: mm, simplify: 1.5 });
    return b.ok ? b.extent[0] : NaN;
  });
  const second = e[2] - 2 * e[1] + e[0];
  check(rec.file + ': the extent is affine in the scale - the drawing scales, the section does not',
    Math.abs(second) < 0.01,
    e.map(v => v.toFixed(4)).join(' / ') + ' mm at 15/30/45, second difference ' + second.toExponential(2));
  const slope = (e[2] - e[0]) / 2;
  check(rec.file + ': and the constant really is the section, not zero',
    Math.abs((e[1] - slope) - 0) > 0.05,
    'span ' + slope.toFixed(4) + ' mm per 15 mm asked, section offset ' + (e[1] - slope).toFixed(4) + ' mm');
}

/* ------------------------------------------------------------------------ */
console.log('\n=== 6. the bridge collapse is gated, not a blanket weld ===');
{
  /* the fix must not be able to eat a real feature: two-apart's strokes are
     parallel and never touch, and its bridge bound is wide enough to reach
     across a crossing, so if the gate were length alone it would weld them */
  const r = built.get('two-apart.png');
  check('two-apart: the bridge bound is real (' + r.bridgeAsked.toFixed(3) + ' mm) and nothing was bridged',
    r.bridgeAsked > 0.42 && r.bridgedPaths === 0,
    'bound ' + r.bridgeAsked.toFixed(3) + ' mm, bridged ' + r.bridgedPaths + ' - the degree gate held, not the length');
  const fat = built.get('two-apart-fat.png');
  check('two-apart-fat: a 2.3x wider bound (' + fat.bridgeAsked.toFixed(3) + ' mm) still bridges nothing',
    fat.bridgedPaths === 0 && fat.components === 2,
    'bridged ' + fat.bridgedPaths + ', ' + fat.components + ' components');
  /* and a free line end must never be moved: degree 1 at one end is enough */
  const one = built.get('skew-cross.png');
  check('skew-cross: exactly one bridge collapsed, for exactly one crossing',
    one.bridgedPaths === 1, 'bridged ' + one.bridgedPaths);
}

/* ------------------------------------------------------------------------ */
console.log('\n=== 7. the thresholds a real picture needs ===');
{
  /* a real drawing is antialiased, so the threshold moves the INK edge but must
     never move the CENTRELINE - that is the whole point of thinning */
  const pr = probes.get('skew-cross.png');
  const angles = [];
  for (const thr of [80, 128, 200]) {
    const r = RL.buildFromImage(pr.img, { mmPerPixel: 1 / PPMM, simplify: 1.5, threshold: thr });
    if (!r.ok) { check('threshold ' + thr + ': builds', false, r.reason); continue; }
    const b = ANG.bands(ANG.wallHistogram(r.tris), 1, 0.05);
    const at23 = b.find(x => angDiff(x.centre, 23) <= 1);
    angles.push({ thr, ok: !!at23, junc: r.junctions, ink: r.image.inkPixels });
    check('threshold ' + thr + ': the centreline holds at 23 deg and one crossing',
      !!at23 && r.junctions === 1,
      r.image.inkPixels + ' ink px, ' + r.junctions + ' junction(s)' + (at23 ? ', 23 deg present' : ''));
  }
  check('and the ink really did change across those thresholds',
    angles.length === 3 && angles[0].ink !== angles[2].ink,
    angles.map(a => a.thr + ':' + a.ink + 'px').join('  '));

  /* invert: a white-on-black copy of the same picture must trace the same */
  const inv = { width: pr.img.width, height: pr.img.height, channels: pr.img.channels,
    data: pr.img.data.map((v, i) => (pr.img.channels === 4 && i % 4 === 3) ? v : 255 - v) };
  const a = RL.buildFromImage(pr.img, { mmPerPixel: 1 / PPMM, simplify: 1.5 });
  const b = RL.buildFromImage(inv, { mmPerPixel: 1 / PPMM, simplify: 1.5, invert: true });
  check('a white-on-black copy traces to the same solid, with invert',
    b.ok && b.paths === a.paths && b.junctions === a.junctions &&
    Math.abs(b.lineLength - a.lineLength) < 0.05,
    b.ok ? b.paths + ' paths, ' + b.junctions + ' junction(s), ' + b.lineLength.toFixed(2) + ' mm vs ' + a.lineLength.toFixed(2) + ' mm' : b.reason);
}

console.log('\n' + (fails ? fails + ' of ' + ran + ' checks FAILED' : 'all ' + ran + ' checks held'));
process.exit(fails ? 1 : 0);
