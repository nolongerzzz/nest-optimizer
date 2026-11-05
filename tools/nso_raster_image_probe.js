/* What a source image REALLY contains, measured off its pixels. Node only.
 *
 * WHY THIS EXISTS. tools/nso_line_angle.js measures the angle of the finished
 * MESH, which is half of what a validation needs: it says what came out, not
 * whether what came out is what went in. The other half is the picture itself,
 * and it has to be measured by something that has never called the tracer -
 * otherwise "the trace agrees with the trace" is all that is being checked.
 *
 * So these are deliberately re-implemented rather than borrowed:
 *
 *   inkMask       its own threshold and its own luminance, not RL.toMask
 *   inkComponents 8-connected labelling of the RAW ink, not of a skeleton.
 *                 This is the connectivity ground truth: two strokes that do
 *                 not touch are two components in the ink, whatever the
 *                 tracer later decides about them.
 *   inkAngles     a straight Hough transform over the ink. For every candidate
 *                 direction it slides a window along that direction's normal
 *                 and takes the most ink any one window holds: a real straight
 *                 stroke drops all of its pixels into one window and scores
 *                 near its own pixel count, a wrong direction smears them out.
 *                 No skeleton, no tracing, no polylines - pixels only.
 *   strokeWidth   ink area over skeleton length is the usual estimate and it
 *                 needs a skeleton, so this does NOT use one: it takes the
 *                 median run length of ink along the scan direction most
 *                 across the stroke, which is a width measured in the ink.
 *
 * Angles come back in PLATE degrees - the finished solid's frame, +Y up - so
 * they are directly comparable with tools/nso_line_angle.js and with the
 * ground truth in fixtures/raster-real/ground-truth.json. An image's first row
 * is its top, so the image y axis is flipped on the way out, exactly as
 * buildFromImage flips it.
 */
'use strict';

function lum(d, p, ch) {
  if (ch === 1) return d[p];
  if (ch === 2) return d[p];
  return 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
}

/* { w, h, bits, ink } - 1 where the pixel is ink. Its own threshold, on
   purpose: nothing here may share code with the thing under test. */
function inkMask(image, opts) {
  const o = opts || {};
  const thr = o.threshold == null ? 128 : o.threshold;
  const inv = !!o.invert;
  const af = o.alphaFloor == null ? 8 : o.alphaFloor;
  const w = image.width | 0, h = image.height | 0, d = image.data;
  const ch = image.channels || Math.round(d.length / (w * h));
  const bits = new Uint8Array(w * h);
  let ink = 0;
  for (let i = 0; i < w * h; i++) {
    const p = i * ch;
    let a = 255;
    if (ch === 2) a = d[p + 1]; else if (ch === 4) a = d[p + 3];
    const L = lum(d, p, ch);
    if (a >= af && (inv ? L >= thr : L < thr)) { bits[i] = 1; ink++; }
  }
  return { w, h, bits, ink };
}

/* 8-connected components of the raw ink, with each one's pixel count. */
function inkComponents(mask, minPixels) {
  const min = minPixels == null ? 1 : minPixels;
  const { w, h, bits } = mask;
  const seen = new Uint8Array(w * h);
  const sizes = [];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!bits[s] || seen[s]) continue;
    let top = 0, n = 0;
    stack[top++] = s; seen[s] = 1;
    while (top) {
      const k = stack[--top]; n++;
      const x = k % w, y = (k / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const nk = ny * w + nx;
        if (bits[nk] && !seen[nk]) { seen[nk] = 1; stack[top++] = nk; }
      }
    }
    sizes.push(n);
  }
  sizes.sort((a, b) => b - a);
  return { count: sizes.filter(n => n >= min).length, sizes };
}

/* The median run of ink along whichever of the two scan axes cuts more nearly
   across the strokes - a stroke width taken in the ink, with no skeleton. */
function strokeWidth(mask) {
  const { w, h, bits } = mask;
  const runs = [[], []];
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x <= w; x++) {
      const on = x < w && bits[y * w + x];
      if (on) n++; else { if (n) runs[0].push(n); n = 0; }
    }
  }
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y <= h; y++) {
      const on = y < h && bits[y * w + x];
      if (on) n++; else { if (n) runs[1].push(n); n = 0; }
    }
  }
  const med = (a) => { if (!a.length) return 0; const b = a.slice().sort((p, q) => p - q); return b[b.length >> 1]; };
  const m0 = med(runs[0]), m1 = med(runs[1]);
  /* the SMALLER median is the one cutting across rather than along */
  return { px: Math.min(m0 || Infinity, m1 || Infinity), horizontal: m0, vertical: m1 };
}

/* Hough over the ink. Returns the strongest line directions, in PLATE degrees,
   each with the share of all ink the best window at that direction holds. */
function inkAngles(mask, opts) {
  const o = opts || {};
  const win = Math.max(1, Math.round(o.window == null ? 3 : o.window));  /* px, the ro window */
  const floor = o.floor == null ? 0.05 : o.floor;
  const suppress = o.suppress == null ? 8 : o.suppress;                  /* degrees */
  const { w, h, bits } = mask;
  const xs = [], ys = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bits[y * w + x]) { xs.push(x); ys.push(y); }
  const N = xs.length;
  if (!N) return [];
  const diag = Math.ceil(Math.hypot(w, h)) + 2;
  const score = new Float64Array(180);
  const best = new Int32Array(180);
  for (let t = 0; t < 180; t++) {
    const a = t * Math.PI / 180;
    /* the line's direction is (cos a, sin a) in IMAGE coords; ro is measured
       along its normal, so every pixel of one straight line shares a ro */
    const nx = -Math.sin(a), ny = Math.cos(a);
    const acc = new Int32Array(2 * diag + 1);
    for (let i = 0; i < N; i++) {
      acc[Math.round(xs[i] * nx + ys[i] * ny) + diag]++;
    }
    /* the most ink any `win`-wide band of ro holds */
    let run = 0, top = 0, topAt = 0;
    for (let k = 0; k < acc.length; k++) {
      run += acc[k];
      if (k >= win) run -= acc[k - win];
      if (run > top) { top = run; topAt = k; }
    }
    score[t] = top / N;
    best[t] = topAt - diag;
  }
  /* peaks, strongest first, with neighbours suppressed so one stroke is one row */
  const taken = new Uint8Array(180);
  const rows = [];
  for (;;) {
    let bt = -1, bs = 0;
    for (let t = 0; t < 180; t++) if (!taken[t] && score[t] > bs) { bs = score[t]; bt = t; }
    if (bt < 0 || bs < floor) break;
    /* image direction t -> plate direction: the y axis flips */
    rows.push({ deg: ((180 - bt) % 180 + 180) % 180, share: bs, rho: best[bt] });
    for (let d = -suppress; d <= suppress; d++) taken[((bt + d) % 180 + 180) % 180] = 1;
  }
  return rows;
}

/* The overall axis of the ink, by principal component, in PLATE degrees.
 *
 * This exists because inkAngles above is a STRAIGHT-line Hough and a hand-drawn
 * stroke is not straight. Run on the wobbly fixture it reports peaks at 41, 50
 * and 176 degrees alongside the real ones: a long wavy stroke has locally
 * straight pieces, and its overall span is nearly horizontal, so bands at those
 * angles really do collect a lot of ink. Those are not lines in the picture,
 * they are the instrument being asked the wrong question, and widening the
 * tolerance until they pass would be answering it wrong on purpose.
 *
 * The right question for a curved stroke is where it runs OVERALL, and that is
 * the principal axis of its ink - which for a stroke wobbled symmetrically
 * about a straight line is that line. Still pixels only, still no tracer. */
function inkAxis(mask) {
  const { w, h, bits } = mask;
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bits[y * w + x]) { n++; sx += x; sy += y; }
  if (n < 2) return null;
  const mx = sx / n, my = sy / n;
  let xx = 0, xy = 0, yy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!bits[y * w + x]) continue;
    const dx = x - mx, dy = y - my;
    xx += dx * dx; xy += dx * dy; yy += dy * dy;
  }
  /* the larger eigenvector of [[xx, xy], [xy, yy]] */
  const t = (xx + yy) / 2, d = Math.sqrt(Math.max(0, ((xx - yy) / 2) ** 2 + xy * xy));
  const l1 = t + d;
  let vx = xy, vy = l1 - xx;
  if (Math.abs(vx) < 1e-12 && Math.abs(vy) < 1e-12) { vx = 1; vy = 0; }
  /* image y is down; the plate's is up */
  const deg = Math.atan2(-vy, vx) * 180 / Math.PI;
  return { deg: ((deg % 180) + 180) % 180, elongation: d > 0 ? l1 / Math.max(1e-12, t - d) : Infinity, pixels: n };
}

module.exports = { inkMask, inkComponents, inkAngles, inkAxis, strokeWidth };
