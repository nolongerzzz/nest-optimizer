#!/usr/bin/env node
/* Picture -> relief slab (nso_relief.js), headless.
 *
 *   node tools/nso_relief_test.js        exit 0 = every gate held
 *
 * Every case below is checked twice over: by the module's own edge census
 * (taken on the index buffer before the soup is returned) and by the
 * CANONICAL checker, tools/mesh_validate.py, on the STL actually written -
 * open / non-manifold / odd / winding / degenerate all 0, Euler 2, no
 * piercing or coplanar pairs, positive volume. Heights are read back off the
 * SOUP, not off the module's own heights array, so "the height is right" is
 * measured on the geometry that would be printed.
 *
 *   1. the 8 x 8 checker        heights exactly base / base + relief, the
 *                               triangle count exact, the pattern where the
 *                               picture put it
 *   2. a gradient               heights monotone along it, both ways round
 *   3. a 1-px line scan         one raised ridge, full height, 1 px wide at
 *                               half height, centred on the pixel
 *   4. a photo                  fixtures/relief/camera.png at Levels 2, 4, 16
 *                               and smooth - closed, inside the budget
 *   5. turned 90 degrees        every case above, the picture rotated: the
 *                               same triangle count, the height grid the
 *                               same grid rotated, closed
 *   6. the budget               a 4000 x 4000 picture at 0.1 mm/sample is
 *                               refused by name with the Detail that fits,
 *                               and that Detail does fit
 *   7. the card's number        plan() is build()'s count, not an estimate
 *   8. classic script           loads in a vm sandbox as window.NSO_Relief
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFile } = require('child_process');
const R = require('../nso_relief.js');
const { readPNG } = require('./nso_png.js');
const { writeSTL } = require('./nso_stl_io.js');

const ROOT = path.join(__dirname, '..');
const MV = path.join(ROOT, 'tools', 'mesh_validate.py');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nso-relief-'));
const f32 = Math.fround;

let pass = 0, fail = 0;
const FAILS = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok    ' + name + (detail ? '   ' + detail : '')); }
  else { fail++; FAILS.push(name); console.log('  FAIL  ' + name + (detail ? '   ' + detail : '')); }
}

/* ------------------------------------------------------------- pictures */

function gray(w, h, fn) {
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = fn(x, y);
  return { width: w, height: h, data: d, channels: 1 };
}
/* 8 x 8 squares, `sq` px each; the top-left square is dark. */
const checker = sq => gray(8 * sq, 8 * sq, (x, y) => ((Math.floor(x / sq) + Math.floor(y / sq)) % 2) ? 255 : 0);
/* dark at the left, bright at the right */
const gradient = () => gray(256, 64, x => x);
/* white, one black column one pixel wide */
const LINE_COL = 20;
const lineScan = () => gray(64, 32, x => (x === LINE_COL ? 0 : 255));

/* 90 degrees clockwise: new (x', y') is old (x = y', y = H - 1 - x'). */
function rotateCW(img) {
  const W = img.width, H = img.height, ch = img.channels || 4;
  const d = new Uint8Array(W * H * ch);
  for (let y2 = 0; y2 < W; y2++) {
    for (let x2 = 0; x2 < H; x2++) {
      const src = ((H - 1 - x2) * W + y2) * ch, dst = (y2 * H + x2) * ch;
      for (let c = 0; c < ch; c++) d[dst + c] = img.data[src + c];
    }
  }
  return { width: H, height: W, data: d, channels: ch };
}

/* ------------------------------------------------------- read the soup */

/* Every distinct vertex of the soup with its z, keyed by its exact x,y. */
function vertices(soup) {
  const m = new Map();
  for (let i = 0; i < soup.length; i += 3) {
    const k = soup[i] + ',' + soup[i + 1];
    const z = soup[i + 2];
    if (!m.has(k)) m.set(k, []);
    const zs = m.get(k);
    if (zs.indexOf(z) < 0) zs.push(z);
  }
  return m;
}
/* The top surface's z at each (x, y): the larger of the two z at an outline
   point (the bottom is the other), the only one elsewhere. */
function topZ(soup) {
  const out = new Map();
  vertices(soup).forEach((zs, k) => out.set(k, Math.max.apply(null, zs)));
  return out;
}
function volumeOf(s) {
  let v = 0;
  for (let o = 0; o < s.length; o += 9) {
    v += s[o] * (s[o + 4] * s[o + 8] - s[o + 5] * s[o + 7])
       - s[o + 1] * (s[o + 3] * s[o + 8] - s[o + 5] * s[o + 6])
       + s[o + 2] * (s[o + 3] * s[o + 7] - s[o + 4] * s[o + 6]);
  }
  return v / 6;
}
/* The top-vertex z down one row of samples (sample row j), left to right,
   with the sample-centre x of each. */
function rowProfile(r, j) {
  const g = r.grid, Hm = r.sizeMm[1];
  const top = topZ(r.rawTris);
  const y = f32(Hm - (j + 0.5) * g.dy);
  const out = [];
  for (let i = 0; i < g.nx; i++) {
    const x = f32((i + 0.5) * g.dx);
    out.push({ x: x, z: top.get(x + ',' + y) });
  }
  return out;
}

/* ---------------------------------------------------- the canonical check */

const pending = [];
const TABLE = [];
function canonical(tag, r, extra) {
  const file = path.join(TMP, tag.replace(/[^A-Za-z0-9_.-]+/g, '_') + '.stl');
  writeSTL(file, r.rawTris, 'nso relief ' + tag);
  const row = Object.assign({ tag: tag, samples: r.samples, triangles: r.triangles,
    mmPerPixel: r.mmPerPixel, size: r.sizeMm, census: r.census, volume: volumeOf(r.rawTris) }, extra || {});
  TABLE.push(row);
  pending.push(limit(() => new Promise(resolve => {
    execFile('python3', [MV, file, '--json'], { maxBuffer: 1 << 28 }, (err, out) => {
      row.v = err ? { error: String(err) } : JSON.parse(out);
      resolve();
    });
  })));
}
/* at most four checkers at once - each holds a whole mesh in Python */
let running = 0;
const queue = [];
function limit(job) {
  return new Promise(done => {
    const go = () => { running++; job().then(() => { running--; done(); if (queue.length) queue.shift()(); }); };
    if (running < 4) go(); else queue.push(go);
  });
}
function judgeCanonical(row) {
  const v = row.v, t = row.tag;
  if (v.error) { check(t + ': the canonical checker ran', false, v.error); return; }
  check(t + ': canonical - closed, manifold, one winding, nothing degenerate',
    v.open_edges === 0 && v.nonmanifold_edges === 0 && v.odd_edges === 0 &&
    v.inconsistent_winding_edges === 0 && v.degenerate_tris === 0,
    'open ' + v.open_edges + ', nm ' + v.nonmanifold_edges + ', odd ' + v.odd_edges +
    ', winding ' + v.inconsistent_winding_edges + ', degenerate ' + v.degenerate_tris);
  check(t + ': canonical - Euler 2, one closed shell', v.euler_characteristic === 2,
    'chi ' + v.euler_characteristic);
  check(t + ': canonical - no self-intersecting pairs',
    v.self_intersection.pierce === 0 && v.self_intersection.coplanar === 0,
    v.self_intersection.pierce + ' pierce, ' + v.self_intersection.coplanar + ' coplanar over ' +
    v.self_intersection.pairs_tested + ' pairs');
  check(t + ': canonical - the checker read the triangles the module counted',
    v.triangles === row.triangles, v.triangles + ' vs ' + row.triangles);
  check(t + ': canonical - positive volume, the same the soup gives',
    v.signed_volume > 0 && Math.abs(v.signed_volume - row.volume) / row.volume < 1e-6,
    v.signed_volume.toFixed(3) + ' mm^3');
  check(t + ': canonical - the box is the slab asked for',
    Math.abs(v.bbox_size[0] - row.size[0]) < 1e-4 && Math.abs(v.bbox_size[1] - row.size[1]) < 1e-4 &&
    Math.abs(v.bbox_size[2] - row.size[2]) < 1e-4 && Math.abs(v.bbox_min[2]) < 1e-9,
    v.bbox_size.map(x => x.toFixed(3)).join(' x ') + ' mm, resting on z = 0');
  check(t + ': canonical verdict PASS', v.verdict === 'PASS', v.verdict + ' ' + (v.verdict_fails || []).join(', '));
  row.slivers = v.sliver_tris;
}

function censusOk(tag, r) {
  const c = r.census;
  check(tag + ': built, and the module\'s own census closed it',
    r.ok && c && c.closed && c.open === 0 && c.nonManifold === 0 && c.windingClashes === 0 && c.chi === 2,
    r.ok ? ('V ' + c.V + ' E ' + c.E + ' F ' + c.F + ' chi ' + c.chi) : r.reason);
  check(tag + ': the count is the closed form', r.ok && r.triangles === R.triangleCount(r.grid.nx, r.grid.ny) &&
    r.rawTris.length === r.triangles * 9, r.ok ? r.triangles + ' triangles' : '');
  check(tag + ': inside the budget', r.ok && r.triangles <= R.MAX_TRIANGLES,
    r.ok ? R.formatCount(r.triangles) + ' <= ' + R.formatCount(R.MAX_TRIANGLES) : '');
}

/* The rotated build carries the same heights, rotated. */
function rotationSame(tag, a, b) {
  const ga = a.grid, gb = b.grid;
  check(tag + ' turned 90: the grid turned with it', gb.nx === ga.ny && gb.ny === ga.nx,
    ga.nx + ' x ' + ga.ny + ' -> ' + gb.nx + ' x ' + gb.ny);
  check(tag + ' turned 90: the same triangle count', a.triangles === b.triangles, a.triangles + ' / ' + b.triangles);
  let worst = 0, exact = 0, n = 0;
  for (let j2 = 0; j2 < gb.ny; j2++) {
    for (let i2 = 0; i2 < gb.nx; i2++) {
      const hb = b.heights[j2 * gb.nx + i2];
      const ha = a.heights[(ga.ny - 1 - i2) * ga.nx + j2];
      const d = Math.abs(ha - hb);
      if (d > worst) worst = d;
      if (d === 0) exact++;
      n++;
    }
  }
  check(tag + ' turned 90: every sample\'s height is the unturned one\'s', worst <= 1e-12,
    exact + ' of ' + n + ' bit-identical, worst ' + worst.toExponential(2));
  censusOk(tag + ' turned 90', b);
}

/* ======================================================================== */
const BASE = 1, RELIEF = 2;

console.log('=== 1. the 8 x 8 checker ===');
const CHK = {};
{
  /* 8 px squares at 0.25 mm/px, 0.5 mm cells: 4 x 4 cells a square, and
     every cell lies inside one square. */
  const img = checker(8);
  const r = R.build(img, { widthMm: 16, sampleMm: 0.5, baseMm: BASE, reliefMm: RELIEF, levels: 2 });
  CHK.r = r; CHK.img = img;
  censusOk('checker', r);
  check('checker: 32 x 32 samples, exactly 4,620 triangles',
    r.grid.nx === 32 && r.grid.ny === 32 && r.triangles === 4620,
    r.grid.nx + ' x ' + r.grid.ny + ', ' + r.triangles + ' = 4*33*33 + 4*66');
  const zs = new Set();
  topZ(r.rawTris).forEach(z => zs.add(z));
  check('checker: the top carries exactly two heights, base and base + relief, to the bit',
    zs.size === 2 && zs.has(f32(BASE)) && zs.has(f32(BASE + RELIEF)),
    Array.from(zs).sort().join(', ') + ' mm');
  let right = 0;
  for (let j = 0; j < 32; j++) for (let i = 0; i < 32; i++) {
    const dark = ((Math.floor(i / 4) + Math.floor(j / 4)) % 2) === 0;
    if (r.heights[j * 32 + i] === (dark ? 1 : 0)) right++;
  }
  check('checker: every dark square is up and every light one down, dark is up', right === 1024, right + ' of 1024 samples');
  const tl = rowProfile(r, 0)[0].z;
  check('checker: the picture\'s top-left square is at the slab\'s +Y, -X corner, raised',
    tl === f32(BASE + RELIEF), 'z ' + tl);
  const rb = R.build(img, { widthMm: 16, sampleMm: 0.5, baseMm: BASE, reliefMm: RELIEF, levels: 2, darkIsUp: false });
  let flipped = 0;
  for (let k = 0; k < 1024; k++) if (rb.heights[k] === 1 - r.heights[k]) flipped++;
  check('checker: Bright is up turns every sample over', flipped === 1024, flipped + ' of 1024');
  canonical('checker 8x8 / 16 mm / 0.5 / L2', r);

  /* the literal 8 x 8 pixel checker, 2 samples a pixel */
  const s = R.build(checker(1), { widthMm: 8, sampleMm: 0.5, baseMm: BASE, reliefMm: RELIEF, levels: 2 });
  censusOk('checker 8 px', s);
  const zs2 = new Set(); topZ(s.rawTris).forEach(z => zs2.add(z));
  check('checker 8 px: 16 x 16 samples, exactly 1,292 triangles, two heights',
    s.grid.nx === 16 && s.triangles === 1292 && zs2.size === 2 && zs2.has(f32(BASE)) && zs2.has(f32(BASE + RELIEF)),
    s.triangles + ' triangles, heights ' + Array.from(zs2).sort().join(', '));
  canonical('checker 8x8 px / 8 mm / 0.5 / L2', s);
}

console.log('\n=== 2. a gradient ===');
const GRD = {};
for (const L of [0, 2, 4, 16]) {
  const img = gradient();
  const tag = 'gradient ' + (L ? 'L' + L : 'smooth');
  const r = R.build(img, { widthMm: 40, sampleMm: 0.25, baseMm: BASE, reliefMm: RELIEF, levels: L });
  GRD[L] = r;
  censusOk(tag, r);
  let mono = true, rows = 0;
  for (let j = 0; j < r.grid.ny; j++) {
    const p = rowProfile(r, j);
    for (let i = 1; i < p.length; i++) if (!(p[i].z <= p[i - 1].z)) mono = false;
    rows++;
  }
  const p0 = rowProfile(r, 0);
  check(tag + ': the top falls monotonically from the dark end to the bright one, every row',
    mono, rows + ' rows, ' + p0[0].z.toFixed(4) + ' -> ' + p0[p0.length - 1].z.toFixed(4) + ' mm');
  check(tag + ': the dark end is at full height and the bright end at the base',
    p0[0].z === f32(BASE + RELIEF) && p0[p0.length - 1].z === f32(BASE),
    p0[0].z + ' / ' + p0[p0.length - 1].z);
  if (L) {
    const lv = new Set(Array.from(r.heights));
    check(tag + ': at most ' + L + ' bands plus their anti-aliased edges, never more than the grid has', lv.size >= L,
      lv.size + ' distinct heights');
  }
  const rb = R.build(img, { widthMm: 40, sampleMm: 0.25, baseMm: BASE, reliefMm: RELIEF, levels: L, darkIsUp: false });
  let up = true;
  for (let j = 0; j < rb.grid.ny; j += 7) {
    const p = rowProfile(rb, j);
    for (let i = 1; i < p.length; i++) if (!(p[i].z >= p[i - 1].z)) up = false;
  }
  check(tag + ': with Bright is up it rises the other way', up);
  canonical(tag + ' / 40 mm / 0.25', r);
}

console.log('\n=== 3. a 1-px line scan ===');
const LIN = {};
for (const L of [2, 0]) {
  const img = lineScan();
  const tag = 'line ' + (L ? 'L' + L : 'smooth');
  /* 64 px over 32 mm: 0.5 mm a pixel, 2 samples a pixel */
  const r = R.build(img, { widthMm: 32, sampleMm: 0.25, baseMm: BASE, reliefMm: RELIEF, levels: L });
  LIN[L] = r;
  censusOk(tag, r);
  check(tag + ': the picture\'s scale is reported back', r.mmPerPixel === 0.5, r.mmPerPixel + ' mm/px');
  check(tag + ': auto-contrast read the line - 1 px in 64 is over 1% of the picture',
    r.contrast.source === 'percentile' && r.contrast.lo === 0 && r.contrast.hi === 255,
    r.contrast.source + ' ' + r.contrast.lo + '..' + r.contrast.hi);
  let oneRidge = true, widthsOk = true, fwhm = null, centre = null;
  const px = r.mmPerPixel;
  for (let j = 0; j < r.grid.ny; j++) {
    const p = rowProfile(r, j);
    const up = p.map(q => q.z > f32(BASE));
    let runs = 0;
    for (let i = 0; i < up.length; i++) if (up[i] && (i === 0 || !up[i - 1])) runs++;
    if (runs !== 1) oneRidge = false;
    /* the width at half height, read off the linear top between sample centres */
    const half = BASE + RELIEF / 2, cross = [];
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i];
      if ((a.z - half) * (b.z - half) < 0) cross.push(a.x + (half - a.z) / (b.z - a.z) * (b.x - a.x));
    }
    if (cross.length !== 2) { widthsOk = false; continue; }
    const w = cross[1] - cross[0], c = (cross[0] + cross[1]) / 2;
    if (Math.abs(w - px) > 1e-5) widthsOk = false;
    if (fwhm == null) { fwhm = w; centre = c; }
  }
  check(tag + ': exactly one raised ridge in every row', oneRidge, r.grid.ny + ' rows');
  check(tag + ': the ridge is one pixel wide at half height, in every row', widthsOk && Math.abs(fwhm - px) < 1e-5,
    'FWHM ' + (fwhm == null ? '-' : fwhm.toFixed(5)) + ' mm vs 1 px = ' + px + ' mm');
  check(tag + ': centred on the pixel the line is in', centre != null && Math.abs(centre - (LINE_COL + 0.5) * px) < 1e-5,
    'centre ' + (centre == null ? '-' : centre.toFixed(5)) + ' mm vs ' + ((LINE_COL + 0.5) * px) + ' mm');
  const peak = Math.max.apply(null, rowProfile(r, 5).map(q => q.z));
  check(tag + ': and it stands the full relief', peak === f32(BASE + RELIEF), 'peak ' + peak + ' mm');
  canonical(tag + ' / 32 mm / 0.25', r);
}

console.log('\n=== 4. a photo - fixtures/relief/camera.png ===');
const PHOTO = readPNG(path.join(ROOT, 'fixtures', 'relief', 'camera.png'));
console.log('   ' + PHOTO.width + ' x ' + PHOTO.height + ', ' + PHOTO.channels + ' channel(s); CC0, see fixtures/relief/README.md');
const PHO = {};
for (const L of [2, 4, 16, 0]) {
  const tag = 'photo ' + (L ? 'L' + L : 'smooth');
  const t0 = Date.now();
  const r = R.build(PHOTO, { widthMm: 60, sampleMm: 0.2, baseMm: BASE, reliefMm: RELIEF, levels: L });
  const ms = Date.now() - t0;
  PHO[L] = r;
  censusOk(tag, r);
  const hs = new Set(Array.from(r.heights));
  let onLevel = 0;
  for (let k = 0; k < r.heights.length; k++) {
    const h = r.heights[k];
    if (!L || Math.abs(h * (L - 1) - Math.round(h * (L - 1))) < 1e-12) onLevel++;
  }
  console.log('   ' + tag + ': ' + r.describe + ' (' + ms + ' ms)');
  console.log('   ' + tag + ': contrast ' + r.contrast.source + ' ' + r.contrast.lo + '..' + r.contrast.hi +
    ', ' + hs.size + ' distinct heights' + (L ? ', ' + (100 * onLevel / r.heights.length).toFixed(2) + '% of samples on one of the ' + L + ' levels' : ''));
  check(tag + ': the auto-contrast stretched the 1st..99th percentile', r.contrast.source === 'percentile' &&
    r.contrast.lo > r.contrast.min && r.contrast.hi < r.contrast.max,
    r.contrast.lo + '..' + r.contrast.hi + ' inside ' + r.contrast.min + '..' + r.contrast.max);
  canonical(tag + ' / 60 mm / 0.2', r, { distinct: hs.size, onLevel: L ? onLevel / r.heights.length : null, ms: ms });
}

console.log('\n=== 5. turned 90 degrees ===');
{
  const turned = (img, widthMm, opts) => R.build(rotateCW(img), Object.assign({}, opts, { widthMm: widthMm }));
  const ck = turned(CHK.img, CHK.r.sizeMm[1], { sampleMm: 0.5, baseMm: BASE, reliefMm: RELIEF, levels: 2 });
  rotationSame('checker', CHK.r, ck);
  const zs = new Set(); topZ(ck.rawTris).forEach(z => zs.add(z));
  check('checker turned 90: still exactly base and base + relief', zs.size === 2 && zs.has(f32(BASE)) && zs.has(f32(BASE + RELIEF)));
  canonical('checker turned 90', ck);
  for (const L of [0, 16]) {
    const g = turned(gradient(), GRD[L].sizeMm[1], { sampleMm: 0.25, baseMm: BASE, reliefMm: RELIEF, levels: L });
    rotationSame('gradient ' + (L ? 'L' + L : 'smooth'), GRD[L], g);
    canonical('gradient ' + (L ? 'L' + L : 'smooth') + ' turned 90', g);
  }
  const ln = turned(lineScan(), LIN[2].sizeMm[1], { sampleMm: 0.25, baseMm: BASE, reliefMm: RELIEF, levels: 2 });
  rotationSame('line L2', LIN[2], ln);
  canonical('line L2 turned 90', ln);
  for (const L of [2, 4, 16, 0]) {
    const p = turned(PHOTO, PHO[L].sizeMm[1], { sampleMm: 0.2, baseMm: BASE, reliefMm: RELIEF, levels: L });
    const tag = 'photo ' + (L ? 'L' + L : 'smooth');
    rotationSame(tag, PHO[L], p);
    canonical(tag + ' turned 90', p);
  }
}

console.log('\n=== 6. the budget ===');
{
  const big = { width: 4000, height: 4000, data: new Uint8Array(4000 * 4000), channels: 1 };
  for (let i = 0; i < big.data.length; i++) big.data[i] = (i * 2654435761 >>> 24) & 255;
  const r = R.build(big, { widthMm: 100, sampleMm: 0.1 });
  check('4000 x 4000 at 0.1 mm/sample, 100 mm wide: refused', !r.ok && r.refused === 'budget', r.reason);
  check('...by name: the count, the budget, and the Detail that fits',
    /4,016,012 triangles/.test(r.reason) && /400,000 budget/.test(r.reason) && /Detail 0\.32 mm\/sample fits/.test(r.reason),
    'suggests ' + r.suggestSampleMm + ' mm/sample, ' + r.suggestTriangles + ' triangles');
  check('...and nothing was built', r.rawTris == null);
  const t0 = Date.now();
  const ok = R.build(big, { widthMm: 100, sampleMm: r.suggestSampleMm });
  check('the suggested Detail really fits, and builds closed', ok.ok && ok.triangles <= R.MAX_TRIANGLES && ok.census.closed,
    R.formatCount(ok.triangles) + ' triangles in ' + (Date.now() - t0) + ' ms');
  const finer = R.plan(4000, 4000, { widthMm: 100, sampleMm: Math.round((r.suggestSampleMm - 0.01) * 100) / 100 });
  check('...and it is the finest that does: 0.01 mm finer is over', !finer.ok, R.formatCount(finer.triangles) + ' triangles');
  const own = R.build(gradient(), { widthMm: 40, sampleMm: 0.25, maxTriangles: 1000 });
  check('a budget passed in is the budget used', !own.ok && /1,000 budget/.test(own.reason), own.reason);
}

console.log('\n=== 7. the card\'s number is the build\'s ===');
{
  let same = true, n = 0;
  for (const [img, w, s] of [[CHK.img, 16, 0.5], [gradient(), 40, 0.25], [gradient(), 33.3, 0.37], [lineScan(), 32, 0.25],
                             [PHOTO, 60, 0.2], [PHOTO, 47, 0.33], [checker(1), 8, 3]]) {
    const p = R.plan(img.width, img.height, { widthMm: w, sampleMm: s });
    const b = R.build(img, { widthMm: w, sampleMm: s });
    if (!(p.triangles === b.triangles && p.samples === b.samples && p.mmPerPixel === b.mmPerPixel)) same = false;
    n++;
  }
  check('plan() gives build()\'s triangles, samples and mm/px, on ' + n + ' grids', same);
}

console.log('\n=== 8. edge cases the solid must survive ===');
{
  const flat = R.build(gray(10, 10, () => 128), { widthMm: 10, sampleMm: 1 });
  check('a flat grey picture has no contrast: a slab of base alone, closed', flat.ok && flat.contrast.source === 'flat' &&
    flat.census.closed && Math.max.apply(null, Array.from(flat.heights)) === 0 && flat.sizeMm[2] === R.DEFAULTS.baseMm,
    flat.contrast.source + ', ' + flat.sizeMm[2] + ' mm tall');
  const sparse = R.build(gray(200, 200, (x, y) => (x === 100 && y < 100) ? 0 : 255), { widthMm: 20, sampleMm: 0.1, levels: 2 });
  check('ink under 1% of the picture: the percentiles coincide and the stretch falls back to min/max',
    sparse.ok && sparse.contrast.source === 'minmax' && Math.max.apply(null, Array.from(sparse.heights)) === 1,
    sparse.contrast.source + ', ' + (100 * 100 / 40000).toFixed(2) + '% ink');
  const one = R.build(gray(3, 3, (x) => x * 100), { widthMm: 3, sampleMm: 3 });
  check('a single-sample grid still closes', one.ok && one.grid.nx === 1 && one.census.closed, one.triangles + ' triangles');
  const rgba = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 0]), channels: 4 };
  const ra = R.build(rgba, { widthMm: 2, sampleMm: 1, levels: 2 });
  check('RGBA: a transparent pixel is paper, not ink', ra.ok && ra.heights[0] === 1 && ra.heights[1] === 0,
    Array.from(ra.heights).join(', '));
  const badBase = R.build(gradient(), { baseMm: 0 });
  check('a zero base is refused by name - the slab needs a floor', !badBase.ok && /Base/.test(badBase.reason), badBase.reason);
  const badLv = R.build(gradient(), { levels: 1 });
  check('Levels 1 is refused by name', !badLv.ok && /Levels/.test(badLv.reason), badLv.reason);
}

console.log('\n=== 9. loads as a classic script ===');
{
  const ctx = { Math, Map, Set, Float32Array, Float64Array, Int32Array, Uint8Array, Array, Object, String, isFinite, Error, window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'nso_relief.js'), 'utf8'), ctx, { filename: 'nso_relief.js' });
  const W = ctx.window.NSO_Relief;
  check('window.NSO_Relief is attached', !!W && typeof W.build === 'function' && typeof W.plan === 'function');
  const r = W && W.build(CHK.img, { widthMm: 16, sampleMm: 0.5 });
  check('...and builds the checker the same there', r && r.ok && r.triangles === 4620);
}

Promise.all(pending).then(() => {
  console.log('\n=== the canonical checker, every slab above ===');
  for (const row of TABLE) judgeCanonical(row);

  console.log('\n=== the table ===');
  const pad = (s, n) => (String(s) + ' '.repeat(n)).slice(0, n);
  console.log('  ' + pad('case', 34) + pad('samples', 10) + pad('triangles', 11) + pad('mm/px', 9) +
    pad('size mm', 22) + pad('chi', 4) + pad('verdict', 8) + pad('slivers', 8) + 'volume mm^3');
  for (const row of TABLE) {
    console.log('  ' + pad(row.tag, 34) + pad(R.formatCount(row.samples), 10) + pad(R.formatCount(row.triangles), 11) +
      pad(+row.mmPerPixel.toPrecision(4), 9) + pad(row.size.map(x => +x.toFixed(2)).join(' x '), 22) +
      pad(row.v && row.v.euler_characteristic, 4) + pad(row.v && row.v.verdict, 8) + pad(row.slivers, 8) +
      row.volume.toFixed(2));
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.log('failing:'); for (const f of FAILS) console.log('  - ' + f); }
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
});
