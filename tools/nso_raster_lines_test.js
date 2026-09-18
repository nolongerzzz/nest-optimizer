/* Raster of line art -> flat thin STL: every stage, and the real reference
   interface end to end.
     node tools/nso_raster_lines_test.js       exit 0 = every gate held

   Part 1 - the mask. Black is ink, the threshold is a real threshold, and the
     refusals (an empty picture, a bad shape) come back by name.
   Part 2 - thinning and tracing. The claim that earns its own code: a pixel's
     neighbours are counted in the REDUCED 8-neighbourhood, without which a
     diagonal staircase reads as a pile of degree-3 junctions instead of one
     line. Asserted both ways.
   Part 3 - simplify, and the corner collapse. A Zhang-Suen chamfer is a stub
     shorter than the line width; collapsing it to the CORNER keeps the long
     runs exactly straight, and dropping a vertex instead tilts them - which is
     measured here rather than asserted, because the tilt is what made a
     crossing read 0.176410 instead of 0.176400.
   Part 4 - the section, which is the whole point of the feature: a line is
     exactly `width` x `height`, a four-way crossing bonds over exactly
     width x width, and every shape is watertight with no self-intersection.
     Plus the two refusals the planar-subdivision construction needs.
   Part 5 - TASK 3: the real two-layer reference. The committed raster through
     the shipped code path, the STL through the canonical checker, then two
     copies stacked and turned 90 degrees and the contact measured against
     the shipped loose zigzag patch measured the same way.
   Part 6 - the picture's stroke width and its grayscale must not reach the
     section: a 0.25 mm stroke, a 0.65 mm stroke and an anti-aliased raster at
     half the resolution all come out as the same 0.42 mm line.
   Part 7 - the crosshatch raster: 225 four-way junctions, genus 196, and a
     lattice that is one component.
   Part 8 - the end-turn inset, measured. A boustrophedon's turn is a rail
     lying parallel to the layer above's lines; put it within one line width of
     them and the interface bonds along the rail. The three insets.
   Part 9 - it loads as a classic script and works on `window`, which is what
     the next ticket's button needs, and buildFromImage takes an ImageData as
     canvas.getImageData hands it over.
   Part 10 - the committed fixtures are what this code builds today. */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const RL = require('../nso_raster_lines.js');
const NSO_SkinPatch = require('../nso_skin_patch.js');
const F = require('./nso_raster_fixtures.js');
const { readPNM } = require('./nso_pnm.js');
const { writeSTL } = require('./nso_stl_io.js');
const { interfaceContact, rotateZ, faceAreaAt } = require('./nso_contact_area.js');

const ROOT = path.resolve(__dirname, '..');
let fails = 0;
const check = (name, cond, detail) => {
  console.log('  ' + (cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? ' - ' + detail : ''));
  if (!cond) fails++;
};
const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const f = (x, n) => Number(x).toFixed(n == null ? 4 : n);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-rasterlines-'));

function meshValidate(soup, tag, extra) {
  const file = path.join(tmp, tag + '.stl');
  writeSTL(file, soup, tag);
  const args = [path.join(ROOT, 'tools', 'mesh_validate.py'), file, '--json'].concat(extra || []);
  /* --gate exits 1 on a failing verdict, which is a RESULT here and not an
     error - the 0.42 mm wall check is asserted to fail on a 0.3 mm layer. */
  let out;
  try { out = execFileSync('python3', args, { encoding: 'utf8', maxBuffer: 64 << 20 }); }
  catch (e) { out = String(e.stdout || ''); if (!out) throw e; }
  return JSON.parse(out);
}
const summary = v => 'tris ' + v.triangles + ', open ' + v.open_edges + ', nm ' + v.nonmanifold_edges +
  ', euler ' + v.euler_characteristic + ', degen ' + v.degenerate_tris + ', sliver ' + v.sliver_tris +
  ', winding ' + v.inconsistent_winding_edges + ', pierce ' + v.self_intersection.pierce +
  ', coplanar ' + v.self_intersection.coplanar;
const clean = v => v.open_edges === 0 && v.nonmanifold_edges === 0 && v.degenerate_tris === 0 &&
  v.sliver_tris === 0 && v.inconsistent_winding_edges === 0 && v.self_intersection.pierce === 0 &&
  v.self_intersection.coplanar === 0;
const verdictOf = v => (v.verdict_fails && v.verdict_fails.length) ? v.verdict_fails.join('; ') : 'PASS';

/* a tiny image from an ASCII picture - '#' is ink */
function pic(rows, channels) {
  const h = rows.length, w = rows[0].length;
  const ch = channels || 1;
  const data = new Uint8Array(w * h * ch).fill(255);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const on = rows[j][i] === '#';
    for (let c = 0; c < ch; c++) data[(j * w + i) * ch + c] = (ch === 4 && c === 3) ? 255 : (on ? 0 : 255);
  }
  return { width: w, height: h, data: data, channels: ch };
}

/* ------------------------------------------------------------------ part 1 */
console.log('\n=== 1. the mask: black is ink, and the threshold is real ===');
{
  const img = pic(['....', '.##.', '.##.', '....']);
  const m = RL.toMask(img);
  check('four black pixels read as four ink pixels', m.ink === 4 && m.w === 4 && m.h === 4, 'ink ' + m.ink);
  check('invert takes the light side instead', RL.toMask(img, { invert: true }).ink === 12,
    'ink ' + RL.toMask(img, { invert: true }).ink);
  /* a real grey ramp: 0, 64, 128, 192 across the row */
  const ramp = { width: 4, height: 1, data: new Uint8Array([0, 64, 128, 192]), channels: 1 };
  check('threshold 128: below is ink, at or above is not', RL.toMask(ramp).ink === 2,
    'ink ' + RL.toMask(ramp).ink);
  check('threshold 192 takes the three below it, not the one at it',
    RL.toMask(ramp, { threshold: 192 }).ink === 3, 'ink ' + RL.toMask(ramp, { threshold: 192 }).ink);
  check('threshold 1 takes only the black one', RL.toMask(ramp, { threshold: 1 }).ink === 1,
    'ink ' + RL.toMask(ramp, { threshold: 1 }).ink);
  /* RGBA, the shape a browser canvas hands over, and its alpha floor */
  const rgba = pic(['.#.'], 4);
  check('an RGBA ImageData needs no conversion', RL.toMask(rgba).ink === 1, 'ink ' + RL.toMask(rgba).ink);
  const tr = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 0]), channels: 4 };
  check('a transparent black pixel is not ink', RL.toMask(tr).ink === 1, 'ink ' + RL.toMask(tr).ink);
  check('a bad image is refused by name', typeof RL.toMask({ width: 3, height: 3, data: new Uint8Array(5) }) === 'string',
    String(RL.toMask({ width: 3, height: 3, data: new Uint8Array(5) })).slice(0, 60));
  const blank = RL.buildFromImage(pic(['...', '...']));
  check('a picture with no ink is refused, and says which side of the threshold',
    !blank.ok && /no ink/.test(blank.reason), blank.reason);
}

/* ------------------------------------------------------------------ part 2 */
console.log('\n=== 2. thinning, and the reduced neighbourhood that makes tracing work ===');
{
  /* a bar thins to one row, and its ENDS RETRACT by half the stroke width -
     the medial axis of a W x H rectangle is W - H long, not W. Worth pinning
     rather than discovering later: it is why a raster drawn with a fat stroke
     traces a marginally SHORTER path than the same centreline drawn thin
     (part 6: 469.53 mm against 468.15 mm), and why a stroke must not be drawn
     so fat that a short feature disappears into its own end caps. */
  for (const [W, H] of [[10, 5], [20, 5], [20, 3], [30, 5]]) {
    const rows = [];
    for (let j = 0; j < H + 2; j++) {
      let row = '';
      for (let i = 0; i < W + 2; i++) row += (j >= 1 && j <= H && i >= 1 && i <= W) ? '#' : '.';
      rows.push(row);
    }
    const sk2 = RL.thin(RL.toMask(pic(rows)));
    const p2 = RL.tracePaths(sk2);
    check('a ' + W + ' x ' + H + ' bar thins to ONE row of ' + (W - H) +
      ' - the ends retract by half the stroke width',
      sk2.ink === W - H && p2.length === 1 && p2[0].length === W - H,
      'skeleton ' + sk2.ink + ' px in ' + sk2.passes + ' passes, ' + p2.length + ' path of ' +
      (p2[0] ? p2[0].length : 0));
  }

  /* a pure diagonal: every pixel's only neighbours are diagonal */
  const diag = [];
  for (let j = 0; j < 8; j++) diag.push('........'.split('').map((c, i) => i === j ? '#' : '.').join(''));
  const dsk = RL.thin(RL.toMask(pic(diag)));
  const dp = RL.tracePaths(dsk);
  check('a pure diagonal traces as one path of 8', dp.length === 1 && dp[0].length === 8,
    dp.length + ' path(s), ' + (dp[0] ? dp[0].length : 0) + ' vertices');

  /* a STAIRCASE - the 8-connected case that needs the reduced neighbourhood.
     Counted naively, every step's corner pixel has three ink neighbours and
     reads as a junction. */
  const stair = ['##......', '.##.....', '..##....', '...##...', '....##..', '.....##.', '......##'];
  const ssk = { w: 8, h: 7, bits: new Uint8Array(56), ink: 0 };
  for (let j = 0; j < 7; j++) for (let i = 0; i < 8; i++) if (stair[j][i] === '#') { ssk.bits[j * 8 + i] = 1; ssk.ink++; }
  const sp = RL.tracePaths(ssk);
  /* the naive count, for the comparison this check exists to make */
  let naiveJunctions = 0;
  for (let j = 0; j < 7; j++) for (let i = 0; i < 8; i++) {
    if (!ssk.bits[j * 8 + i]) continue;
    let n = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const x = i + di, y = j + dj;
      if (x >= 0 && y >= 0 && x < 8 && y < 7 && ssk.bits[y * 8 + x]) n++;
    }
    if (n >= 3) naiveJunctions++;
  }
  check('the reduced neighbourhood: a 14 px staircase is ONE path, not a pile of stubs',
    sp.length === 1 && sp[0].length === 14,
    sp.length + ' path(s), ' + (sp[0] ? sp[0].length : 0) + ' vertices - a naive 8-neighbour count would ' +
    'call ' + naiveJunctions + ' of its 14 pixels junctions');
  check('and the naive count really would, so the rule is doing work', naiveJunctions === 12, String(naiveJunctions));

  /* a plus: one degree-4 junction, four arms */
  const plus = RL.thin(RL.toMask(pic(['..#..', '..#..', '#####', '..#..', '..#..'])));
  const pp = RL.tracePaths(plus);
  check('a plus traces as four arms from one junction', pp.length === 4,
    pp.length + ' path(s) of ' + pp.map(p => p.length).join('/'));
  /* a closed ring: no node anywhere, and the walk must still close it */
  const ring = RL.thin(RL.toMask(pic(['#####', '#...#', '#...#', '#...#', '#####'])));
  const rp = RL.tracePaths(ring);
  const first = rp[0][0], last = rp[0][rp[0].length - 1];
  check('a closed ring of degree-2 pixels traces as one CLOSED loop',
    rp.length === 1 && first[0] === last[0] && first[1] === last[1],
    rp.length + ' path(s), ' + rp[0].length + ' vertices, closed ' + (first[0] === last[0] && first[1] === last[1]));
}

/* ------------------------------------------------------------------ part 3 */
console.log('\n=== 3. simplify, and collapsing a chamfer to its corner ===');
{
  const stair = [];
  for (let k = 0; k <= 20; k++) stair.push([k, Math.round(k * 0.5)]);
  check('Douglas-Peucker turns a 21-vertex staircase into its two ends',
    RL.simplify(stair, 1).length === 2, RL.simplify(stair, 1).length + ' vertices');
  check('and at tolerance 0 keeps every one', RL.simplify(stair, 0).length === 21,
    RL.simplify(stair, 0).length + ' vertices');

  /* the real shape of the problem: a long run, a chamfer, another long run */
  const chamf = [[0, 0], [10, 0], [10.05, 0.15], [10.05, 10]];
  const col = RL.collapseShort(chamf, 0.42);
  check('a 0.158 mm chamfer collapses to a 3-vertex corner', col.length === 3,
    col.map(p => '(' + f(p[0], 3) + ',' + f(p[1], 3) + ')').join(' '));
  check('and it lands where the two straight runs MEET, leaving both exactly straight',
    near(col[1][0], 10.05, 1e-12) && near(col[1][1], 0, 1e-12) &&
    near(col[2][0], 10.05, 1e-12),
    'corner (' + f(col[1][0], 6) + ', ' + f(col[1][1], 6) + '), the vertical run at x ' + f(col[2][0], 6));
  check('endpoints are never moved - they are the junctions other paths meet at',
    col[0][0] === 0 && col[0][1] === 0 && near(col[col.length - 1][1], 10, 1e-12),
    '(' + col[0].join(',') + ') .. (' + col[col.length - 1].map(x => f(x, 3)).join(',') + ')');
  check('a straight-through vertex is dropped as collinear', RL.dropCollinear([[0, 0], [5, 0], [10, 0]]).length === 2,
    RL.dropCollinear([[0, 0], [5, 0], [10, 0]]).length + ' vertices');
}

/* ------------------------------------------------------------------ part 4 */
console.log('\n=== 4. the section, and watertightness by construction ===');
const SHAPES = [
  { tag: 'line', paths: [[[0, 0], [10, 0]]], euler: 2, vol: 10 * 0.42 * 0.3 },
  { tag: 'corner', paths: [[[0, 0], [10, 0], [10, 10]]], euler: 2 },
  { tag: 'cross', paths: [[[0, 5], [5, 5], [10, 5]], [[5, 0], [5, 5], [5, 10]]], euler: 2 },
  { tag: 'boustro', paths: [[[0, 0], [10, 0], [10, 2], [0, 2], [0, 4], [10, 4]]], euler: 2 },
  { tag: 'tee', paths: [[[0, 0], [5, 0], [10, 0]], [[5, 0], [5, 8]]], euler: 2 },
  { tag: 'ring', paths: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]], euler: 0 },
  { tag: 'star5', paths: [[[5, 5], [10, 5]], [[5, 5], [5, 10]], [[5, 5], [0, 5]], [[5, 5], [5, 0]], [[5, 5], [9, 9]]], euler: 2 },
  { tag: 'two', paths: [[[0, 0], [10, 0]], [[0, 5], [10, 5]]], euler: 4 }
];
{
  for (const s of SHAPES) {
    const r = RL.extrudeFlat(s.paths);
    check(s.tag + ': builds', r.ok, r.reason || (r.tris_count + ' triangles, ' + r.components + ' component(s)'));
    if (!r.ok) continue;
    /* the module's own edge census, before the checker is asked - `closed` in a
       report is a measurement here, not a promise */
    check(s.tag + ': the builder\'s own census says closed - 0 open, 0 non-manifold',
      r.closed && r.openEdges === 0 && r.nonManifoldEdges === 0,
      r.uniqueEdges + ' unique edges, ' + r.openEdges + ' open, ' + r.nonManifoldEdges + ' non-manifold');
    const v = meshValidate(r.tris, 'shape-' + s.tag);
    check(s.tag + ': watertight, no self-intersection, Euler ' + s.euler,
      clean(v) && v.euler_characteristic === s.euler, summary(v));
    check(s.tag + ': exactly ' + RL.LINE_HEIGHT + ' mm tall - one layer, nothing more',
      near(v.bbox_size[2], RL.LINE_HEIGHT, 1e-7), f(v.bbox_size[2], 7) + ' mm');
    /* the invariant every extrusion of a plane region has */
    const top = faceAreaAt(r.tris, [0, 0, 1], RL.LINE_HEIGHT, +1, 1e-6);
    const bot = faceAreaAt(r.tris, [0, 0, 1], 0, -1, 1e-6);
    check(s.tag + ': top area == bottom area == volume / height (a prism, not a taper)',
      near(top, bot, 1e-4) && near(v.signed_volume, top * RL.LINE_HEIGHT, 2e-4),
      'top ' + f(top, 4) + ', bottom ' + f(bot, 4) + ', volume ' + f(v.signed_volume, 5) +
      ' = ' + f(top * RL.LINE_HEIGHT, 5));
    if (s.vol !== undefined) {
      check(s.tag + ': volume is length x width x height exactly - a butt cap adds nothing',
        near(v.signed_volume, s.vol, 1e-5), f(v.signed_volume, 6) + ' vs ' + f(s.vol, 6));
    }
  }

  /* the section is the caller's, at both ends of the measured range */
  for (const w of [RL.LINE_WIDTH, RL.LINE_WIDTH_MAX, 1.0]) {
    for (const h of [RL.LINE_HEIGHT, 0.2]) {
      const r = RL.extrudeFlat([[[0, 0], [8, 0]]], { width: w, height: h });
      check('a line asked for ' + w + ' x ' + h + ' mm is exactly that',
        r.ok && near(r.extent[1], w, 1e-7) && near(r.extent[2], h, 1e-7),
        r.ok ? f(r.extent[1], 6) + ' x ' + f(r.extent[2], 6) : r.reason);
    }
  }

  /* the crossing pad: the number the whole feature is for */
  for (const w of [RL.LINE_WIDTH, RL.LINE_WIDTH_MAX]) {
    const lower = RL.extrudeFlat([[[0, 5], [5, 5], [10, 5]]], { width: w });
    const upper = RL.extrudeFlat([[[5, 0], [5, 5], [5, 10]]], { width: w, baseZ: RL.LINE_HEIGHT });
    const ct = interfaceContact(lower.tris, upper.tris, { plane: RL.LINE_HEIGHT });
    check('two ' + w + ' mm lines crossing at 90 deg bond over exactly ' + f(w * w) + ' mm^2, in one patch',
      ct.patches === 1 && near(ct.area, w * w, 1e-6),
      f(ct.area, 6) + ' mm^2, patch ' + ct.patchExtents[0].map(x => f(x, 4)).join(' x ') + ' mm');
  }
  /* and at 45 degrees it is w^2 / sin(theta), which is the right answer, not a bug */
  {
    const w = RL.LINE_WIDTH;
    const lower = RL.extrudeFlat([[[0, 0], [10, 0]]], { width: w });
    const upper = RL.extrudeFlat([[[5 - 5 / Math.SQRT2, -5 / Math.SQRT2], [5 + 5 / Math.SQRT2, 5 / Math.SQRT2]]],
      { width: w, baseZ: RL.LINE_HEIGHT });
    const ct = interfaceContact(lower.tris, upper.tris, { plane: RL.LINE_HEIGHT });
    check('at 45 deg the crossing is w^2 / sin 45 - the rhombus, as it should be',
      ct.patches === 1 && near(ct.area, w * w * Math.SQRT2, 2e-5),
      f(ct.area, 6) + ' vs ' + f(w * w * Math.SQRT2, 6));
  }

  /* the two refusals the construction needs */
  const hairpin = RL.extrudeFlat([[[0, 0], [10, 0], [0, 0.5]]]);
  check('a hairpin whose arms fold back inside one line width is REFUSED, by name',
    !hairpin.ok && /overlap/.test(hairpin.reason), hairpin.reason.slice(0, 96));
  const midTee = RL.extrudeFlat([[[0, 0], [10, 0]], [[5, 0], [5, 8]]]);
  check('a line ending part-way along another, with no node there, is REFUSED',
    !midTee.ok && /overlap/.test(midTee.reason), midTee.reason.slice(0, 96));
  const stub = RL.extrudeFlat([[[0, 0], [10, 0], [10.05, 0.15], [10.05, 10]]]);
  check('a segment shorter than its own joins is REFUSED and names the shortest',
    !stub.ok && /shorter than the joins/.test(stub.reason), stub.reason.slice(0, 110));
  check('and buildFromImage never hands one over - it collapses them first (part 3)',
    RL.extrudeFlat([RL.dropCollinear(RL.collapseShort([[0, 0], [10, 0], [10.05, 0.15], [10.05, 10]], 0.42))]).ok,
    RL.extrudeFlat([RL.dropCollinear(RL.collapseShort([[0, 0], [10, 0], [10.05, 0.15], [10.05, 10]], 0.42))]).reason || 'builds');
  const misshaped = RL.extrudeFlat([[0, 0], [10, 0]]);
  check('and a single path handed in unwrapped is refused by name, not by a puzzle',
    !misshaped.ok && /wrapped/.test(misshaped.reason), misshaped.reason.slice(0, 96));
  const dup = RL.extrudeFlat([[[0, 0], [10, 0]], [[0, 0], [5, 0]]]);
  check('two lines leaving one point in the SAME direction are refused',
    !dup.ok && /same direction/.test(dup.reason), dup.reason.slice(0, 90));
  check('a zero width is refused', !RL.extrudeFlat([[[0, 0], [1, 0]]], { width: 0 }).ok);
  check('a zero height is refused', !RL.extrudeFlat([[[0, 0], [1, 0]]], { height: 0 }).ok);
}

/* ------------------------------------------------------------------ part 5 */
console.log('\n=== 5. TASK 3: the real two-layer reference, end to end ===');
const REF = {};
{
  const file = path.join(F.OUT, 'zigzag-layer.pbm');
  const img = readPNM(file);
  check('the committed raster reads back as a ' + (F.SIZE * F.PPMM) + ' px square, 1 bit',
    img.width === F.SIZE * F.PPMM && img.height === F.SIZE * F.PPMM && img.format === 'P4',
    img.format + ' ' + img.width + ' x ' + img.height);
  const L1 = RL.buildFromImage(img, { mmPerPixel: 1 / F.PPMM, simplify: 1.5 });
  REF.L1 = L1;
  check('it builds', L1.ok, L1.reason || L1.describe);
  check('traced as ONE continuous boustrophedon path - ' + F.LINES + ' lines and ' + (F.LINES - 1) + ' end turns',
    L1.paths === 1 && L1.segments === 2 * F.LINES - 1 && L1.junctions === 0 && L1.maxDegree === 2,
    L1.paths + ' path(s), ' + L1.segments + ' segment(s), ' + L1.junctions + ' junction(s), max degree ' + L1.maxDegree);
  check('the section is tonight\'s measured line: ' + RL.LINE_WIDTH + ' mm wide, ' + RL.LINE_HEIGHT + ' mm tall',
    near(L1.width, 0.42, 0) && near(L1.height, 0.3, 0) && near(L1.extent[2], 0.3, 1e-7),
    L1.width + ' x ' + L1.height + ' mm asked, ' + f(L1.extent[2], 7) + ' mm measured in Z');
  check('and the footprint is the ' + F.SIZE + ' mm patch the shipped sample is, to a line width',
    near(L1.extent[0], F.SIZE - 2 * F.FIRST + RL.LINE_WIDTH, 0.15) && L1.extent[1] < F.SIZE + 1e-9,
    L1.extent.map(x => f(x, 3)).join(' x ') + ' mm');

  const v = meshValidate(L1.tris, 'ref-layer1');
  check('the STL is watertight with no self-intersection: ' + summary(v), clean(v) && v.euler_characteristic === 2);
  const g1 = meshValidate(L1.tris, 'ref-layer1', ['--gate']);
  check('--gate (the standard closure check): ' + verdictOf(g1), verdictOf(g1) === 'PASS');
  /* the wall/gap threshold, and why 0.42 is the wrong number for THIS piece */
  const g42 = meshValidate(L1.tris, 'ref-layer1', ['--gate', '--non-solid']);
  const g30 = meshValidate(L1.tris, 'ref-layer1', ['--gate', '--non-solid', '--min-wall', String(RL.LINE_HEIGHT)]);
  check('--gate --non-solid at 0.42 mm FAILS, and the failure is the 0.3 mm layer height itself',
    verdictOf(g42) !== 'PASS' && near(g42.wall.min_wall_mm, RL.LINE_HEIGHT, 1e-6),
    'thinnest ' + f(g42.wall.min_wall_mm, 4) + ' mm: ' + verdictOf(g42));
  check('at the layer height it PASSES - 0.42 mm is the NOZZLE figure, not a limit on layer height',
    verdictOf(g30) === 'PASS' && g30.wall.thin_faces === 0,
    'threshold ' + RL.LINE_HEIGHT + ' mm, thin faces ' + g30.wall.thin_faces + ': ' + verdictOf(g30));

  /* ---- the interface: the same layer, turned 90 degrees, set down on it */
  const L2 = rotateZ(L1.tris, 90, F.SIZE / 2, F.SIZE / 2, L1.height);
  const ct = interfaceContact(L1.tris, L2, { plane: L1.height });
  REF.ct = ct;
  const crossings = F.LINES * F.LINES;
  const ideal = crossings * RL.LINE_WIDTH * RL.LINE_WIDTH;
  console.log('    two layers, the second turned 90 deg and set down on the first:');
  console.log('      contact ' + f(ct.area, 4) + ' mm^2 in ' + ct.patches + ' patch(es);' +
    ' every patch ' + f(Math.min.apply(null, ct.patchAreas), 6) + ' .. ' +
    f(Math.max.apply(null, ct.patchAreas), 6) + ' mm^2, widest spans ' + f(ct.maxPatchSpan, 4) + ' mm');
  check('exactly ' + crossings + ' contact patches - ' + F.LINES + ' lines crossed by ' + F.LINES,
    ct.patches === crossings, String(ct.patches));
  check('every one is exactly width x width = ' + f(RL.LINE_WIDTH * RL.LINE_WIDTH, 6) + ' mm^2',
    ct.patchAreas.every(a => near(a, RL.LINE_WIDTH * RL.LINE_WIDTH, 1e-5)),
    'min ' + f(Math.min.apply(null, ct.patchAreas), 6) + ', max ' + f(Math.max.apply(null, ct.patchAreas), 6));
  check('the total is the ' + crossings + ' crossings and nothing else',
    near(ct.area, ideal, 1e-3), f(ct.area, 4) + ' vs ' + f(ideal, 4) + ' mm^2');
  /* SPAN_TOL: a traced line is not perfectly axis-aligned - Douglas-Peucker
     places its ends on skeleton pixels, so a 29 mm line can carry a tenth of a
     degree of skew and a crossing patch's bounding box is then 0.2% wider than
     the line. The AREA is exact regardless (asserted above); this is the box. */
  const SPAN_TOL = 1.005;
  check('no patch is longer than one line width - there is no weld anywhere',
    ct.maxPatchSpan <= RL.LINE_WIDTH * SPAN_TOL, f(ct.maxPatchSpan, 4) + ' mm vs ' +
    f(RL.LINE_WIDTH, 2) + ' mm + 0.5%');
  check('the interface is ' + f(2 * RL.LINE_HEIGHT, 2) + ' mm thick - two real layers, not more',
    near(L1.height * 2, 2 * RL.LINE_HEIGHT, 1e-9), f(L1.height * 2, 3) + ' mm');

  /* the controls the repo's other contact checks use: a gap, and an overlap */
  const apart = rotateZ(L1.tris, 90, F.SIZE / 2, F.SIZE / 2, L1.height + 0.05);
  const into = rotateZ(L1.tris, 90, F.SIZE / 2, F.SIZE / 2, L1.height - 0.05);
  const vApart = meshValidate(concat(L1.tris, apart), 'ref-apart');
  const vTouch = meshValidate(concat(L1.tris, L2), 'ref-touch');
  const vInto = meshValidate(concat(L1.tris, into), 'ref-into');
  check('control: 0.05 mm apart -> two closed shells, 0 piercing, 0 coplanar',
    vApart.open_edges === 0 && vApart.nonmanifold_edges === 0 && vApart.euler_characteristic === 4 &&
    vApart.self_intersection.pierce === 0 && vApart.self_intersection.coplanar === 0, summary(vApart));
  check('at gap 0 the checker sees coplanar CONTACT, which an air gap never produces',
    vTouch.self_intersection.coplanar === crossings * 4 && vTouch.euler_characteristic === 4,
    summary(vTouch) + ' (' + crossings + ' crossings x 4 triangle pairs)');
  check('control: 0.05 mm INTO the layer below -> piercing, as penetration must',
    vInto.self_intersection.pierce > 0, summary(vInto));
  check('and the two shells touch bit for bit: layer 1\'s top z == layer 2\'s bottom z',
    near(ct.plane, RL.LINE_HEIGHT, 1e-9), f(ct.plane, 9));

  /* ---- against the shipped loose zigzag patch, measured the same way */
  const patch = NSO_SkinPatch.buildPatch({ variant: 'loose', pattern: 'zigzag' });
  const pB = rotateZ(patch.tris, 90, NSO_SkinPatch.SIZE / 2, NSO_SkinPatch.SIZE / 2, patch.tipsZ);
  const pct = interfaceContact(patch.tris, pB, { plane: patch.tipsZ });
  console.log('    the same interface built from the shipped loose zigzag patch, for comparison:');
  console.log('      contact ' + f(pct.area, 3) + ' mm^2 in ' + pct.patches + ' patch(es), widest spans ' +
    f(pct.maxPatchSpan, 2) + ' mm, stack ' + f(patch.tipsZ + patch.extent[2], 2) + ' mm thick');
  check('the traced flat lines bond over ' + f(pct.area / ct.area, 2) + 'x LESS than the relief patch',
    pct.area / ct.area > 2.8, f(ct.area, 3) + ' vs ' + f(pct.area, 3) + ' mm^2');
  check('the relief patch welds continuously over 30 mm; the traced lines nowhere over one line width',
    near(pct.maxPatchSpan, NSO_SkinPatch.SIZE, 1e-4) && ct.maxPatchSpan <= RL.LINE_WIDTH * 1.005,
    f(pct.maxPatchSpan, 2) + ' mm vs ' + f(ct.maxPatchSpan, 4) + ' mm');
  check('and the interface is ' + f((patch.tipsZ + patch.extent[2]) / (2 * RL.LINE_HEIGHT), 2) + 'x thinner',
    near(patch.tipsZ + patch.extent[2], 2.04, 1e-6) && near(L1.height * 2, 0.6, 1e-9),
    f(L1.height * 2, 2) + ' mm vs ' + f(patch.tipsZ + patch.extent[2], 2) + ' mm');

  /* the widest measured line, through the same reference raster */
  const wide = RL.buildFromImage(img, { mmPerPixel: 1 / F.PPMM, simplify: 1.5, width: RL.LINE_WIDTH_MAX });
  const wB = rotateZ(wide.tris, 90, F.SIZE / 2, F.SIZE / 2, wide.height);
  const wct = interfaceContact(wide.tris, wB, { plane: wide.height });
  check('at the WIDEST measured line, ' + RL.LINE_WIDTH_MAX + ' mm, still ' + crossings +
    ' isolated crossings of exactly ' + f(RL.LINE_WIDTH_MAX * RL.LINE_WIDTH_MAX, 6) + ' mm^2',
    wct.patches === crossings && wct.patchAreas.every(a => near(a, RL.LINE_WIDTH_MAX * RL.LINE_WIDTH_MAX, 1e-5)) &&
    wct.maxPatchSpan <= RL.LINE_WIDTH_MAX * 1.005,
    f(wct.area, 4) + ' mm^2, widest patch ' + f(wct.maxPatchSpan, 4) + ' mm');
  check('and it is STILL less contact than the relief patch at the narrow line',
    wct.area < pct.area, f(wct.area, 3) + ' vs ' + f(pct.area, 3) + ' mm^2');
}
function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

/* ------------------------------------------------------------------ part 6 */
console.log('\n=== 6. the picture supplies the centreline, never the section ===');
{
  const thin = RL.buildFromImage(readPNM(path.join(F.OUT, 'zigzag-layer.pbm')), { mmPerPixel: 1 / F.PPMM, simplify: 1.5 });
  const fat = RL.buildFromImage(readPNM(path.join(F.OUT, 'zigzag-layer-fat.pbm')), { mmPerPixel: 1 / F.PPMM, simplify: 1.5 });
  const aa = RL.buildFromImage(readPNM(path.join(F.OUT, 'zigzag-layer-aa.pgm')), { mmPerPixel: 1 / 10, simplify: 1.5 });
  check('a 0.25 mm stroke and a 0.65 mm stroke both come out as a ' + RL.LINE_WIDTH + ' mm line',
    thin.ok && fat.ok && thin.width === RL.LINE_WIDTH && fat.width === RL.LINE_WIDTH &&
    near(thin.extent[0], fat.extent[0], 1e-9) &&
    near(thin.extent[0], (F.LINES - 1) * F.PITCH + RL.LINE_WIDTH, 1e-5),
    'ink ' + thin.image.inkPixels + ' vs ' + fat.image.inkPixels + ' px (2.3x), both ' + f(thin.width, 2) +
    ' mm wide; the run ACROSS the lines is ' + f(thin.extent[0], 3) + ' vs ' + f(fat.extent[0], 3) +
    ' mm = 14 x ' + F.PITCH + ' + one line width');
  check('and both trace to the same path: ' + thin.segments + ' segments either way',
    thin.segments === fat.segments && thin.tris_count === fat.tris_count,
    thin.segments + '/' + fat.segments + ' segments, ' + thin.tris_count + '/' + fat.tris_count + ' triangles');
  check('an anti-aliased grayscale raster at HALF the resolution traces the same path too',
    aa.ok && aa.segments === thin.segments && aa.tris_count === thin.tris_count && aa.mmPerPixel === 0.1,
    aa.segments + ' segments, ' + aa.tris_count + ' triangles at ' + aa.mmPerPixel + ' mm/px');
  /* the anti-aliased raster really is grey, and the threshold really reads it:
     the shaded fringe is about as many pixels again as the solid core */
  const aaImg = readPNM(path.join(F.OUT, 'zigzag-layer-aa.pgm'));
  const ink = t => RL.toMask(aaImg, { threshold: t }).ink;
  check('the threshold really is what reads the grey: ink rises with it, 1 < 128 < 254',
    ink(1) < ink(128) && ink(128) < ink(254),
    'threshold 1 -> ' + ink(1) + ', 128 -> ' + ink(128) + ', 254 -> ' + ink(254) + ' ink px');
  check('and the fringe is real geometry, not a rounding artefact - it nearly doubles the ink',
    ink(254) > ink(128) * 1.8, f(ink(254) / ink(128), 2) + 'x');
  for (const b of [thin, fat, aa]) {
    const v = meshValidate(b.tris, 'stroke-' + b.image.w + '-' + b.image.inkPixels);
    check('  ' + b.image.w + ' px raster, ' + b.image.inkPixels + ' ink: watertight, no self-intersection',
      clean(v) && v.euler_characteristic === 2, summary(v));
  }
}

/* ------------------------------------------------------------------ part 7 */
console.log('\n=== 7. the crosshatch raster: crossings become junctions ===');
{
  const r = RL.buildFromImage(readPNM(path.join(F.OUT, 'crosshatch.pbm')), { mmPerPixel: 1 / F.PPMM, simplify: 1.5 });
  check('builds', r.ok, r.reason || r.describe);
  check(F.LINES + ' lines each way trace to ' + (F.LINES * F.LINES) + ' four-way junctions',
    r.junctions === F.LINES * F.LINES && r.maxDegree === 4,
    r.junctions + ' junction(s), max degree ' + r.maxDegree + ', ' + r.segments + ' segments');
  check('and the lattice is ONE component - a patch you can pick up, not 30 sticks',
    r.components === 1, r.components + ' component(s)');
  const v = meshValidate(r.tris, 'crosshatch');
  const genus = (F.LINES - 1) * (F.LINES - 1);
  check('watertight, no self-intersection, and Euler ' + (2 - 2 * genus) + ' = genus ' + genus +
    ' = the ' + (F.LINES - 1) + ' x ' + (F.LINES - 1) + ' holes in the lattice',
    clean(v) && v.euler_characteristic === 2 - 2 * genus, summary(v));
  check('exactly ' + RL.LINE_HEIGHT + ' mm tall', near(v.bbox_size[2], RL.LINE_HEIGHT, 1e-7), f(v.bbox_size[2], 7));
  const top = faceAreaAt(r.tris, [0, 0, 1], RL.LINE_HEIGHT, +1, 1e-6);
  check('volume == top area x height: a flat prism, no taper anywhere',
    near(v.signed_volume, top * RL.LINE_HEIGHT, 2e-3), f(v.signed_volume, 5) + ' vs ' + f(top * RL.LINE_HEIGHT, 5));
}

/* ------------------------------------------------------------------ part 8 */
console.log('\n=== 8. the end turn is a rail, and where it sits is measured ===');
{
  const rows = [];
  for (const inset of [1.0, 0.5, F.INSET]) {
    const img = F.stroke(F.zigzagPath(inset), { strokePx: 5 });
    const r = RL.buildFromImage(img, { mmPerPixel: 1 / F.PPMM, simplify: 1.5 });
    if (!r.ok) { check('inset ' + inset + ' builds', false, r.reason); continue; }
    const B = rotateZ(r.tris, 90, F.SIZE / 2, F.SIZE / 2, r.height);
    const ct = interfaceContact(r.tris, B, { plane: r.height });
    rows.push({ inset: inset, ct: ct });
    console.log('    inset ' + f(inset, 2) + ' mm -> contact ' + f(ct.area, 3) + ' mm^2 in ' + ct.patches +
      ' patch(es), widest ' + f(ct.maxPatchSpan, 3) + ' mm');
  }
  const bad1 = rows.find(r => r.inset === 1.0), bad2 = rows.find(r => r.inset === 0.5);
  const good = rows.find(r => r.inset === F.INSET);
  check('inset 1.00: the turn rail lands ON the layer above\'s first line and WELDS along it',
    bad1 && bad1.ct.patches < F.LINES * F.LINES && bad1.ct.maxPatchSpan > 2,
    bad1 ? bad1.ct.patches + ' patches, widest ' + f(bad1.ct.maxPatchSpan, 3) + ' mm, ' +
      f(bad1.ct.area / good.ct.area, 2) + 'x the clean figure' : 'missing');
  check('inset 0.50: clean at ' + RL.LINE_WIDTH + ' mm, and only because 0.5 > 0.42',
    bad2 && bad2.ct.patches === F.LINES * F.LINES, bad2 ? String(bad2.ct.patches) + ' patches' : 'missing');
  {
    const img = F.stroke(F.zigzagPath(0.5), { strokePx: 5 });
    const r = RL.buildFromImage(img, { mmPerPixel: 1 / F.PPMM, simplify: 1.5, width: RL.LINE_WIDTH_MAX });
    const B = rotateZ(r.tris, 90, F.SIZE / 2, F.SIZE / 2, r.height);
    const c2 = interfaceContact(r.tris, B, { plane: r.height });
    check('  ... and NOT clean at ' + RL.LINE_WIDTH_MAX + ' mm, because 0.5 < 0.61',
      c2.patches < F.LINES * F.LINES && c2.maxPatchSpan > 2,
      c2.patches + ' patches, widest ' + f(c2.maxPatchSpan, 3) + ' mm, ' + f(c2.area, 3) + ' mm^2');
  }
  check('inset ' + F.INSET + ' - the committed one - clears the WIDEST measured line and is clean at both',
    good && good.ct.patches === F.LINES * F.LINES && good.ct.maxPatchSpan <= RL.LINE_WIDTH * 1.005,
    good ? good.ct.patches + ' patches, widest ' + f(good.ct.maxPatchSpan, 4) + ' mm' : 'missing');
  check('the finding, stated as a rule: the turn must clear one line width of the layer above\'s outer line',
    F.FIRST - F.INSET > RL.LINE_WIDTH_MAX,
    'clearance ' + f(F.FIRST - F.INSET, 3) + ' mm > the widest line ' + RL.LINE_WIDTH_MAX + ' mm');
}

/* ------------------------------------------------------------------ part 9 */
console.log('\n=== 9. it loads as a classic script, the way the browser will ===');
{
  /* the same vm sandbox tools/nso_stl_io.js uses for NSO_Repair: nothing
     node-specific is added to the module for the checks' benefit, and the next
     ticket's button needs it on `window`. */
  const vm = require('vm');
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'nso_raster_lines.js'), 'utf8'), sandbox,
    { filename: 'nso_raster_lines.js' });
  const api = sandbox.window.NSO_RasterLines;
  check('nso_raster_lines.js attaches itself to window', !!api,
    api ? Object.keys(api).length + ' exports' : 'nothing on window');
  const r = api && api.extrudeFlat([[[0, 0], [10, 0]]]);
  check('and builds the same solid there as it does under require()',
    !!r && r.ok && r.tris_count === 12 && near(r.extent[1], RL.LINE_WIDTH, 1e-7),
    r ? r.tris_count + ' triangles, ' + f(r.extent[1], 6) + ' mm wide' : 'no result');
  /* the shape canvas.getImageData hands over, unconverted */
  const imageData = { width: 12, height: 5, data: new Uint8Array(12 * 5 * 4).fill(255), channels: 4 };
  for (let i = 0; i < 12; i++) for (let c = 0; c < 3; c++) imageData.data[(2 * 12 + i) * 4 + c] = 0;
  const fromCanvas = api && api.buildFromImage(imageData, { mmPerPixel: 0.5 });
  check('and buildFromImage takes an ImageData as it comes - RGBA, no conversion',
    !!fromCanvas && fromCanvas.ok && fromCanvas.segments === 1,
    fromCanvas ? fromCanvas.describe : 'no result');
}

console.log('\n=== 10. the committed fixtures are what this code builds today ===');
{
  let out = '';
  try {
    out = execFileSync('node', [path.join(ROOT, 'tools', 'nso_raster_fixtures.js'), '--check'],
      { encoding: 'utf8' });
    check('every raster, STL and the JSON index match byte for byte', /fixtures match/.test(out),
      out.trim().split('\n').pop());
  } catch (e) {
    check('every raster, STL and the JSON index match byte for byte', false,
      String(e.stdout || e.message).trim().split('\n').slice(-3).join(' | '));
  }
}

console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'all checks held') + '\n');
process.exit(fails ? 1 : 0);
