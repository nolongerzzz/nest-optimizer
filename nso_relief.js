/* nso_relief.js - a picture becomes a relief slab: a flat base with a dense
   heightfield on top, heights driven by the image, closed into one solid.

   Loads as a classic script (window.NSO_Relief) and as a Node module
   (require('../nso_relief.js')). Pure geometry: no DOM, no Three.js, no image
   decoding. It takes { width, height, data, channels } - exactly what a
   canvas hands back as an ImageData, and exactly what nso_raster_lines.js's
   buildFromImage already takes - and returns the app's raw soup: 9 numbers a
   triangle, Z up, millimetres.

   Trace raster turns line art into printed LINES and thresholds the picture
   to ink or not-ink. This is the other reading of a picture: every pixel is a
   height. What comes out prints as it is (a relief, or a lithophane held to
   the light) and is dense enough for the Brush to sculpt and lift.

   ---------------------------------------------------------------------------
   THE PIPELINE, in the order it runs
   ---------------------------------------------------------------------------
   grayscale      luminance, 0.299 R + 0.587 G + 0.114 B - nso_raster_lines.js's
                  toMask weights, so the two importers read one picture the
                  same way. Alpha is composited over WHITE: a transparent
                  background is paper, as app-raster.js already treats it.
   auto-contrast  the 1st and 99th percentiles of that luminance are stretched
                  to 0 and 1 and everything outside them clamps. When the two
                  percentiles coincide (a clean scan whose ink is under 1% of
                  the pixels reads paper at both) the stretch falls back to the
                  image's own min and max; a picture of one flat grey has no
                  contrast to stretch and makes a plain slab of base, with no
                  relief either way up. Which of the three happened is
                  reported as `contrast.source`.
   quantize       `levels` equal bands, floor(t * L) / (L - 1); null / 0 /
                  'smooth' leaves the stretched value continuous.
   resample       an EXACT box filter onto the sample grid: every sample is
                  the area-weighted mean of the picture over its own cell, the
                  cells tile the picture with no gap and no overlap, so nothing
                  aliases - a line thinner than a cell lowers that cell instead
                  of vanishing or strobing. Separable, so a 4000 px picture is
                  two linear passes. A cell lying wholly inside one value
                  returns THAT value exactly, not a float sum of it, which is
                  what lets the checker test assert base / base + relief to the
                  bit.

   Quantize comes BEFORE resample, in that order on purpose (it is the order
   the ticket fixed). The consequence, measured and reported rather than
   hidden: where a cell straddles a band edge it takes the box filter's mean,
   so a slab built at Levels N carries N heights in the bands and anti-aliased
   intermediate heights along their edges. A grid aligned with the picture
   (the 8 x 8 checker, every cell inside one square) has exactly N.

   ---------------------------------------------------------------------------
   THE SAMPLE GRID AND THE SOLID
   ---------------------------------------------------------------------------
   The picture is W x H pixels and widthMm wide, so mmPerPixel = widthMm / W
   and the slab is widthMm x (H * mmPerPixel). sampleMm sets the grid:
   nx = round(widthMm / sampleMm), ny = round(heightMm / sampleMm), at least 1
   each, and the cells are then exactly widthMm / nx by heightMm / ny so the
   slab is the size asked for.

   One top vertex sits at the CENTRE of every cell at z = base + h * relief.
   A ring of vertices on the slab's outline carries the nearest cell's height
   out to the edge, so the top covers the full widthMm x heightMm rather than
   stopping half a cell short. Every quad of that (nx + 2) x (ny + 2) grid is
   split on the same diagonal - one rule, no exceptions, so there is no
   T-junction anywhere by construction.

   The outline then drops straight down as four walls, one quad per outline
   edge, to a flat bottom at z = 0 that is the SAME grid - every top vertex
   has a twin straight below it - split on the same diagonal and wound the
   other way.

     triangles = 4 (nx + 1)(ny + 1)        top and bottom, 2 (nx+1)(ny+1) each
               + 4 (nx + ny + 2)           walls, two per outline edge

   WHY THE BOTTOM IS A FULL GRID AND NOT THE CHEAPEST FLOOR. The first version
   triangulated the bottom with no interior vertex at all - a strip of quads
   the full depth of the slab and a fan at each end, N - 2 triangles for the
   outline's N points, about half the triangles. It is closed, it passed the
   canonical checker, and it could not be sculpted. Measured on camera.png,
   Levels 8, 40 mm at 0.4 mm (tools/nso_relief_sculpt_test.js):
     - Smooth (NSO_smoothGlobal, the button's bake) REFUSED, "volume loss
       25.88% over budget" - the uniform Laplacian pulls each front-edge
       bottom vertex toward the far edge it shares a 40 mm strip triangle
       with, and the floor folds in;
     - the Brush's own gate REFUSED an emboss stroke, "T-junctions rose
       0 -> 18" headless and "self-intersections rose 0 -> 15" in the app -
       its refinement zone reaches down through a 2.7 mm slab to the floor
       and splits those long strip edges;
     - and the checker counted 388 slivers on the floor before anything ran.
   With the floor a grid under the top: Brush, Smooth and Cut all pass their
   own gates and the canonical checker, and the slab has 0 slivers. A floor
   whose connectivity is LOCAL is what lets a tool that reasons about
   neighbours treat the slab as an ordinary solid; the cost is the
   triangles, and the budget counts them.

   That count is closed form, so the card's live "~ N triangles" line is the
   same number build() produces, not an estimate of it, and the budget is
   decided before anything is allocated.

   Built indexed, emitted as a soup. The edge census is taken on the index
   buffer before anything is returned: every undirected edge used exactly
   twice, every directed edge once (the winding agrees across it), and
   V - E + F = 2 - one closed sphere-like shell. A census that fails is
   refused, not returned.

   ---------------------------------------------------------------------------
   ORIENTATION
   ---------------------------------------------------------------------------
   Picture x runs along +X; the picture's TOP row is at the slab's +Y edge, so
   seen from above (+Z) the slab reads as the picture does. The slab occupies
   [0, widthMm] x [0, heightMm] x [0, base + relief]; the app's ingest centres
   it anyway.

   ---------------------------------------------------------------------------
   TRIM - clip the flat plate off, leave the item's own edge
   ---------------------------------------------------------------------------
   A picture of one thing on a plain ground (a key on white, a cut-out, a
   logo) makes a relief of that thing standing on a rectangle of flat base.
   `trim` removes the rectangle and keeps the thing:

     off     the full slab, as above. The default; nothing below runs.
     outer   the item's outer edge only. Every hole inside it is filled - a
             bright highlight on a metal face is not a hole in the part.
     holes   the same, but a hole that is a real hole in the picture's item
             (a key ring's eye) stays one, through the base and all.

   How it decides, on the height grid the slab was already built from, after
   Levels / Bright is up / the box filter - so it reads the relief the card
   would print, not a second opinion about the picture:

     raised    a sample is the item when its height is above `trimAbove` (a
               fraction of Relief, default 0.1) - "anything above the base"
     bridge    a gap in the item narrower than about `trimBridgeMm` (default
               1 mm) is closed first - a morphological closing, whole
               samples only - so a bright face joined to the ground by a
               hairline slit is part of the item, not a bay in it
     fill      the ground is what floods in from the picture's edge across
               un-raised samples; an un-raised patch the flood does not
               reach is a hole. `outer` fills them all; `holes` fills only
               those under `trimSpeckPct` (default 1) of the item's area
     islands   raised patches under `trimSpeckPct` of the largest one are
               dropped: dust, a stray pixel, a JPEG halo that is not the item
     margin    `trimMarginMm` grows the item's outline outward by that much,
               a plate rim round the edge; 0 is the edge exactly
     contour   the cleaned mask is blurred once (3 x 3 box) and cut where it
               crosses one half: a smooth outline at a fraction of a sample,
               not a staircase of samples. The blur only places the edge, it
               never decides what is in: a sample the mask has in stays in
               and one it has out stays out (the blurred value is pushed to
               the right side of one half if it fell on the wrong one), so
               the trimmed solid has exactly the mask's holes and bays. A
               feature a sample wide keeps a hairline of an edge; Detail
               finer keeps it properly

   The cut is exact geometry, not a re-grid: every triangle of the slab's
   top is clipped to the contour. A cut point is shared by the two triangles
   either side of its grid edge, so it cannot open a crack; its height is the
   top's own height there, so the surface is the untrimmed one up to the edge
   (every kept sample is bit-identical). The cut point sits 0.1 to 0.9 of the
   way along its edge - never on a sample - which is what keeps every cut
   triangle a real triangle (no slivers) and every vertex a manifold one, at
   a cost of at most a tenth of a sample in where the edge falls. The floor
   is the same triangles under the top, wound the other way; the walls are
   whatever edge the top has no neighbour across. So the trimmed slab is
   closed by the same argument as the whole one.

   What stays true and what does not: `triangles` is the real count, and the
   budget gate is still the full slab's closed form (the trim can only drop
   triangles, it does not decide whether the picture is too fine). The slab
   keeps its frame - the item's own place in the picture - and `sizeMm` is
   the item's bounding box. The edge census reports `shells` and `holes` and
   closed means Euler = 2 shells - 2 holes, checked against a count of the
   top's boundary loops taken separately. A picture with no raised sample is
   refused by name.

   ---------------------------------------------------------------------------
   THE BUDGET
   ---------------------------------------------------------------------------
   maxTriangles, default 400,000. A picture and detail that would exceed it is
   refused BY NAME with the count it would have been and the finest
   sampleMm, in 0.01 mm steps, that fits - never silently coarsened.

   Not here, on purpose: region lift, vectorising, edge detection, colour.
*/
(function (root) {
  'use strict';

  var MAX_TRIANGLES = 400000;
  var DEFAULTS = {
    widthMm: 60, baseMm: 2, reliefMm: 2, sampleMm: 0.3, levels: 2, darkIsUp: true,
    maxTriangles: MAX_TRIANGLES,
    trim: 'off', trimAbove: 0.1, trimMarginMm: 0, trimSpeckPct: 1, trimBridgeMm: 1
  };
  var TRIM_MODES = ['off', 'outer', 'holes'];

  /* ---------------------------------------------------------------- input */

  function channelsOf(img) {
    if (img.channels) return img.channels | 0;
    var n = img.width * img.height;
    return n > 0 ? Math.round(img.data.length / n) : 4;
  }

  /* Luminance 0..255 per pixel, alpha composited over white paper. */
  function grayscale(img) {
    var w = img.width | 0, h = img.height | 0, d = img.data, ch = channelsOf(img);
    var n = w * h, out = new Float64Array(n), i, p, lum, a;
    for (i = 0; i < n; i++) {
      p = i * ch; a = 255;
      if (ch === 1) lum = d[p];
      else if (ch === 2) { lum = d[p]; a = d[p + 1]; }
      else { lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; if (ch === 4) a = d[p + 3]; }
      out[i] = a === 255 ? lum : (lum * a + 255 * (255 - a)) / 255;
    }
    return out;
  }

  /* -------------------------------------------------------- auto-contrast */

  var BINS_PER_UNIT = 16;                     /* 1/16 of a luminance step */
  var NBINS = 255 * BINS_PER_UNIT + 1;

  /* p-th percentile (0..1) of the luminance, as a bin value. The smallest
     value v with at least ceil(p * N) pixels at or below it. */
  function percentiles(gray) {
    var hist = new Float64Array(NBINS), n = gray.length, i;
    var mn = Infinity, mx = -Infinity;
    for (i = 0; i < n; i++) {
      var v = gray[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
      var b = Math.round(v * BINS_PER_UNIT);
      hist[b < 0 ? 0 : (b >= NBINS ? NBINS - 1 : b)]++;
    }
    function at(p) {
      var need = Math.max(1, Math.ceil(p * n)), cum = 0;
      for (var k = 0; k < NBINS; k++) { cum += hist[k]; if (cum >= need) return k / BINS_PER_UNIT; }
      return 255;
    }
    return { p1: at(0.01), p99: at(0.99), min: mn, max: mx };
  }

  function contrast(gray) {
    var pc = percentiles(gray);
    var lo = pc.p1, hi = pc.p99, source = 'percentile';
    if (!(hi > lo)) { lo = pc.min; hi = pc.max; source = 'minmax'; }
    if (!(hi > lo)) source = 'flat';
    var n = gray.length, t = new Float64Array(n), i;
    if (source !== 'flat') {
      var k = 1 / (hi - lo);
      for (i = 0; i < n; i++) {
        var v = (gray[i] - lo) * k;
        t[i] = v <= 0 ? 0 : (v >= 1 ? 1 : v);
      }
    }
    return { t: t, lo: lo, hi: hi, source: source, p1: pc.p1, p99: pc.p99, min: pc.min, max: pc.max };
  }

  /* ------------------------------------------------------------- quantize */

  function levelsOf(v) {
    if (v == null || v === 0 || v === 'smooth' || v === 'Smooth') return 0;
    return +v;
  }

  function quantize(t, L) {
    if (!L) return t;
    var n = t.length, out = new Float64Array(n), i, top = L - 1;
    for (i = 0; i < n; i++) {
      var b = Math.floor(t[i] * L);
      out[i] = (b >= top ? top : b) / top;
    }
    return out;
  }

  /* ------------------------------------------------------------- resample */

  /* For each of `count` output cells over `length` input pixels: the pixel
     span it covers and each pixel's share of the cell, as overlap / cell. */
  function spans(length, count) {
    var cw = length / count, out = new Array(count);
    for (var i = 0; i < count; i++) {
      var x0 = i * cw, x1 = (i === count - 1) ? length : (i + 1) * cw;
      var p0 = Math.floor(x0), p1 = Math.min(length, Math.ceil(x1));
      var px = [], wt = [];
      for (var p = p0; p < p1; p++) {
        var ov = Math.min(x1, p + 1) - Math.max(x0, p);
        if (ov > 0) { px.push(p); wt.push(ov); }
      }
      var s = 0, k;
      for (k = 0; k < wt.length; k++) s += wt[k];
      for (k = 0; k < wt.length; k++) wt[k] /= s;
      out[i] = { px: px, wt: wt };
    }
    return out;
  }

  /* Box mean of values v (W x H, row-major) onto nx x ny cells. A cell whose
     every contributing value is equal returns that value exactly. */
  function boxResample(v, W, H, nx, ny) {
    var sx = spans(W, nx), sy = spans(H, ny);
    var mid = new Float64Array(H * nx), r, i, k, s, mn, mx, sp, val;
    for (r = 0; r < H; r++) {
      var row = r * W;
      for (i = 0; i < nx; i++) {
        sp = sx[i]; s = 0; mn = Infinity; mx = -Infinity;
        for (k = 0; k < sp.px.length; k++) {
          val = v[row + sp.px[k]];
          s += val * sp.wt[k];
          if (val < mn) mn = val;
          if (val > mx) mx = val;
        }
        mid[r * nx + i] = (mn === mx) ? mn : s;
      }
    }
    var out = new Float64Array(nx * ny), j;
    for (j = 0; j < ny; j++) {
      sp = sy[j];
      for (i = 0; i < nx; i++) {
        s = 0; mn = Infinity; mx = -Infinity;
        for (k = 0; k < sp.px.length; k++) {
          val = mid[sp.px[k] * nx + i];
          s += val * sp.wt[k];
          if (val < mn) mn = val;
          if (val > mx) mx = val;
        }
        out[j * nx + i] = (mn === mx) ? mn : s;
      }
    }
    return out;
  }

  /* ----------------------------------------------------------- the budget */

  function triangleCount(nx, ny) {
    return 4 * (nx + 1) * (ny + 1) + 4 * (nx + ny + 2);
  }

  function gridFor(W, H, widthMm, sampleMm) {
    var heightMm = H * widthMm / W;
    var nx = Math.max(1, Math.round(widthMm / sampleMm));
    var ny = Math.max(1, Math.round(heightMm / sampleMm));
    return { nx: nx, ny: ny, dx: widthMm / nx, dy: heightMm / ny, widthMm: widthMm, heightMm: heightMm };
  }

  /* The finest sampleMm, in 0.01 mm steps, whose grid fits the budget. */
  function fittingSample(W, H, widthMm, budget) {
    var heightMm = H * widthMm / W;
    var s = Math.max(0.01, Math.ceil(Math.sqrt(4 * widthMm * heightMm / budget) * 100) / 100);
    for (var guard = 0; guard < 100000; guard++) {
      var g = gridFor(W, H, widthMm, s);
      if (triangleCount(g.nx, g.ny) <= budget) return s;
      s = Math.round(s * 100 + 1) / 100;
    }
    return null;
  }

  function fmt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function readOpts(o) {
    o = o || {};
    var r = {};
    for (var k in DEFAULTS) r[k] = (o[k] != null && o[k] !== '') ? o[k] : DEFAULTS[k];
    r.widthMm = +r.widthMm; r.baseMm = +r.baseMm; r.reliefMm = +r.reliefMm;
    r.sampleMm = +r.sampleMm; r.maxTriangles = +r.maxTriangles;
    r.levels = levelsOf(o.levels === undefined ? DEFAULTS.levels : o.levels);
    r.darkIsUp = o.darkIsUp == null ? DEFAULTS.darkIsUp : !!o.darkIsUp;
    r.trim = (o.trim == null || o.trim === '' || o.trim === false) ? 'off' : String(o.trim).toLowerCase();
    r.trimAbove = +r.trimAbove; r.trimMarginMm = +r.trimMarginMm; r.trimSpeckPct = +r.trimSpeckPct;
    r.trimBridgeMm = +r.trimBridgeMm;
    return r;
  }

  function checkImage(img) {
    if (!img || !img.data) return 'no image';
    var w = img.width, h = img.height;
    if (!(w >= 1 && h >= 1) || (w | 0) !== w || (h | 0) !== h) return 'the image is ' + w + ' x ' + h + ' pixels';
    var ch = channelsOf(img);
    if (!(ch >= 1 && ch <= 4)) return 'the image has ' + ch + ' channels; 1 to 4 are read';
    if (img.data.length < w * h * ch) return 'the image data is shorter than ' + w + ' x ' + h + ' x ' + ch;
    return null;
  }

  function checkOpts(o) {
    if (!(o.widthMm > 0) || !isFinite(o.widthMm)) return 'Width must be a positive number of mm';
    if (!(o.sampleMm > 0) || !isFinite(o.sampleMm)) return 'Detail must be a positive number of mm per sample';
    if (!(o.baseMm > 0) || !isFinite(o.baseMm)) return 'Base must be thicker than 0 mm - the slab needs a floor';
    if (!isFinite(o.reliefMm) || !(o.baseMm + Math.min(0, o.reliefMm) > 0)) {
      return 'Base + Relief must stay above 0 mm everywhere';
    }
    if (o.levels && !(o.levels >= 2 && (o.levels | 0) === o.levels)) {
      return 'Levels must be a whole number, 2 or more, or smooth';
    }
    if (!(o.maxTriangles > 0)) return 'the triangle budget must be positive';
    if (TRIM_MODES.indexOf(o.trim) < 0) return 'Trim must be one of ' + TRIM_MODES.join(', ') + ', not ' + o.trim;
    if (o.trim !== 'off') {
      if (!(o.trimAbove >= 0 && o.trimAbove < 1)) return 'Trim cut-off must be from 0 up to (not including) 1 of the relief';
      if (!(o.trimMarginMm >= 0) || !isFinite(o.trimMarginMm)) return 'Trim rim must be 0 mm or more';
      if (!(o.trimSpeckPct >= 0 && o.trimSpeckPct <= 100)) return 'Trim speck size must be 0 to 100 % of the item';
      if (!(o.trimBridgeMm >= 0) || !isFinite(o.trimBridgeMm)) return 'Trim gap bridge must be 0 mm or more';
    }
    return null;
  }

  /* What a build would produce, without building: the card's live line and
     the budget gate are both this. */
  function plan(width, height, opts) {
    var o = readOpts(opts);
    var bad = checkImage({ width: width, height: height, data: { length: Infinity }, channels: 1 }) || checkOpts(o);
    if (bad) return { ok: false, reason: bad };
    var g = gridFor(width, height, o.widthMm, o.sampleMm);
    var tris = triangleCount(g.nx, g.ny);
    var r = {
      ok: tris <= o.maxTriangles, nx: g.nx, ny: g.ny, samples: g.nx * g.ny, triangles: tris,
      mmPerPixel: o.widthMm / width, sampleMm: o.sampleMm, cellMm: [g.dx, g.dy],
      sizeMm: [g.widthMm, g.heightMm, o.baseMm + Math.max(0, o.reliefMm)], budget: o.maxTriangles,
      trim: o.trim, upperBound: o.trim !== 'off'      /* a trim only ever drops triangles: this is the untrimmed count */
    };
    if (!r.ok) {
      r.suggestSampleMm = fittingSample(width, height, o.widthMm, o.maxTriangles);
      var fit = gridFor(width, height, o.widthMm, r.suggestSampleMm);
      r.suggestTriangles = triangleCount(fit.nx, fit.ny);
      r.reason = 'a ' + width + ' x ' + height + ' picture ' + o.widthMm + ' mm wide at ' + o.sampleMm +
        ' mm/sample is ' + fmt(tris) + ' triangles, over the ' + fmt(o.maxTriangles) +
        ' budget - Detail ' + r.suggestSampleMm.toFixed(2) + ' mm/sample fits (' +
        fmt(r.suggestTriangles) + ' triangles)';
    }
    return r;
  }

  /* -------------------------------------------------------------- the mesh */

  /* Undirected and directed edge census on an index buffer. */
  function census(tri, V) {
    var und = new Map(), dir = new Map(), T = tri.length / 3, t, e;
    for (t = 0; t < T; t++) {
      for (e = 0; e < 3; e++) {
        var a = tri[t * 3 + e], b = tri[t * 3 + (e + 1) % 3];
        var lo = a < b ? a : b, hi = a < b ? b : a, k = lo * V + hi;
        und.set(k, (und.get(k) || 0) + 1);
        var dk = a * V + b;
        dir.set(dk, (dir.get(dk) || 0) + 1);
      }
    }
    var open = 0, nm = 0, wind = 0, deg = 0;
    und.forEach(function (c) { if (c === 1) open++; else if (c > 2) nm++; });
    dir.forEach(function (c) { if (c > 1) wind++; });
    for (t = 0; t < T; t++) {
      var i0 = tri[t * 3], i1 = tri[t * 3 + 1], i2 = tri[t * 3 + 2];
      if (i0 === i1 || i1 === i2 || i2 === i0) deg++;
    }
    var E = und.size;
    return { V: V, E: E, F: T, chi: V - E + T, open: open, nonManifold: nm,
             windingClashes: wind, degenerate: deg,
             closed: open === 0 && nm === 0 && wind === 0 && deg === 0 && V - E + T === 2 };
  }

  function buildMesh(hgt, g, o) {
    var nx = g.nx, ny = g.ny, dx = g.dx, dy = g.dy, Hm = g.heightMm;
    var NX = nx + 2, NY = ny + 2;
    var xs = new Float64Array(NX), ys = new Float64Array(NY), a, b;
    xs[0] = 0; xs[NX - 1] = g.widthMm;
    for (a = 1; a <= nx; a++) xs[a] = (a - 0.5) * dx;
    ys[0] = 0; ys[NY - 1] = Hm;
    for (b = 1; b <= ny; b++) ys[b] = (b - 0.5) * dy;

    var topCount = NX * NY;
    var V = 2 * topCount;
    var pos = new Float64Array(V * 3);
    for (b = 0; b < NY; b++) {
      var sj = Math.min(ny - 1, Math.max(0, b - 1));
      for (a = 0; a < NX; a++) {
        var si = Math.min(nx - 1, Math.max(0, a - 1));
        var id = b * NX + a, vt = id * 3, vb = (topCount + id) * 3;
        pos[vt] = pos[vb] = xs[a];
        pos[vt + 1] = pos[vb + 1] = Hm - ys[b];
        pos[vt + 2] = o.baseMm + hgt[sj * nx + si] * o.reliefMm;
        pos[vb + 2] = 0;
      }
    }
    function top(a2, b2) { return b2 * NX + a2; }
    function bot(a2, b2) { return topCount + b2 * NX + a2; }

    var T = triangleCount(nx, ny);
    var tri = new Int32Array(T * 3), n = 0;
    function put(i, j, k) { tri[n++] = i; tri[n++] = j; tri[n++] = k; }

    /* Top and bottom: every quad split on the v01-v10 diagonal, the top CCW
       seen from above, the bottom the same triangles wound the other way. */
    for (b = 0; b < NY - 1; b++) {
      for (a = 0; a < NX - 1; a++) {
        put(top(a, b + 1), top(a + 1, b + 1), top(a + 1, b));
        put(top(a, b + 1), top(a + 1, b), top(a, b));
        put(bot(a, b + 1), bot(a + 1, b), bot(a + 1, b + 1));
        put(bot(a, b + 1), bot(a, b), bot(a + 1, b));
      }
    }
    /* The outline, counter-clockwise seen from above: along the front edge
       (picture bottom, world y = 0) left to right, up the right side, back
       along the picture's top edge, down the left side. The top walks each
       outline edge p -> q, so its wall walks q -> p. */
    var loop = [];
    for (a = 0; a < NX - 1; a++) loop.push([a, NY - 1]);
    for (b = NY - 1; b > 0; b--) loop.push([NX - 1, b]);
    for (a = NX - 1; a > 0; a--) loop.push([a, 0]);
    for (b = 0; b < NY - 1; b++) loop.push([0, b]);
    for (var q = 0; q < loop.length; q++) {
      var P = loop[q], Q = loop[(q + 1) % loop.length];
      var tp = top(P[0], P[1]), tq = top(Q[0], Q[1]);
      var bp = bot(P[0], P[1]), bq = bot(Q[0], Q[1]);
      put(tq, tp, bp);
      put(tq, bp, bq);
    }

    if (n !== T * 3) throw new Error('nso_relief: built ' + n / 3 + ' triangles, the count says ' + T);
    return { pos: pos, tri: tri, V: V, T: T };
  }

  function toSoup(mesh) {
    var tri = mesh.tri, pos = mesh.pos, out = new Float32Array(tri.length * 3);
    for (var i = 0; i < tri.length; i++) {
      var v = tri[i] * 3;
      out[i * 3] = pos[v]; out[i * 3 + 1] = pos[v + 1]; out[i * 3 + 2] = pos[v + 2];
    }
    return out;
  }

  /* ----------------------------------------------------------------- trim */

  /* Connected components of the cells equal to `want` on an nx x ny grid.
     conn8: diagonal neighbours join; otherwise only the four sides do.
     -> { lab: Int32Array (component index, -1 where the cell is not `want`),
          area: [cells per component], border: [true when it touches the edge] } */
  function components(m, nx, ny, want, conn8) {
    var lab = new Int32Array(nx * ny).fill(-1), area = [], border = [], stack = [];
    var s0, c = 0, i, j, p, q, di, dj, ni, nj, a, b;
    for (s0 = 0; s0 < nx * ny; s0++) {
      if (m[s0] !== want || lab[s0] >= 0) continue;
      a = 0; b = false;
      lab[s0] = c; stack.push(s0);
      while (stack.length) {
        p = stack.pop(); a++;
        i = p % nx; j = (p - i) / nx;
        if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) b = true;
        for (dj = -1; dj <= 1; dj++) {
          for (di = -1; di <= 1; di++) {
            if ((di === 0 && dj === 0) || (!conn8 && di !== 0 && dj !== 0)) continue;
            ni = i + di; nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
            q = nj * nx + ni;
            if (m[q] === want && lab[q] < 0) { lab[q] = c; stack.push(q); }
          }
        }
      }
      area.push(a); border.push(b); c++;
    }
    return { lab: lab, area: area, border: border, count: c };
  }

  /* Squared distance, in cells, from every cell to the nearest cell set in m
     (Felzenszwalb & Huttenlocher's exact transform, one pass per axis). */
  function distSq(m, nx, ny) {
    var INF = 1e20, f = new Float64Array(Math.max(nx, ny)), d = new Float64Array(Math.max(nx, ny));
    var v = new Int32Array(Math.max(nx, ny)), z = new Float64Array(Math.max(nx, ny) + 1);
    var g = new Float64Array(nx * ny), i, j;
    function pass(len) {
      var k = 0, q, s;
      v[0] = 0; z[0] = -INF; z[1] = INF;
      for (q = 1; q < len; q++) {
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
        k++; v[k] = q; z[k] = s; z[k + 1] = INF;
      }
      k = 0;
      for (q = 0; q < len; q++) {
        while (z[k + 1] < q) k++;
        d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
      }
    }
    for (i = 0; i < nx * ny; i++) g[i] = m[i] ? 0 : INF;
    for (i = 0; i < nx; i++) {
      for (j = 0; j < ny; j++) f[j] = g[j * nx + i];
      pass(ny);
      for (j = 0; j < ny; j++) g[j * nx + i] = d[j];
    }
    for (j = 0; j < ny; j++) {
      for (i = 0; i < nx; i++) f[i] = g[j * nx + i];
      pass(nx);
      for (i = 0; i < nx; i++) g[j * nx + i] = d[i];
    }
    return g;
  }

  /* Morphological closing by rc samples (>= 1): dilate, then erode by the same
     distance, so a gap under about 2 rc closes and everything else stays. The
     picture's own edge does not erode the item. */
  function closeMask(m, nx, ny, rc) {
    var n = nx * ny, i, lim = rc * rc, d = distSq(m, nx, ny), D = new Uint8Array(n);
    for (i = 0; i < n; i++) D[i] = d[i] <= lim ? 1 : 0;
    var inv = new Uint8Array(n);
    for (i = 0; i < n; i++) inv[i] = D[i] ? 0 : 1;
    var e = distSq(inv, nx, ny), out = new Uint8Array(n);
    for (i = 0; i < n; i++) out[i] = (D[i] && e[i] > lim) ? 1 : 0;
    return out;
  }

  /* The item's mask on the sample grid: 1 where the item is, after the
     cut-off, islands, holes and rim described at the head of the file. */
  function trimMask(hgt, g, o) {
    var nx = g.nx, ny = g.ny, n = nx * ny, i, k;
    var m = new Uint8Array(n), raised = 0;
    for (i = 0; i < n; i++) if (hgt[i] > o.trimAbove) { m[i] = 1; raised++; }
    if (!raised) {
      return { ok: false, reason: 'nothing stands above the base (no sample is over ' +
        (o.trimAbove * 100) + '% of the relief) - there is no outline to trim to; lower the cut-off' };
    }
    var info = { raisedSamples: raised, bridgedSamples: 0, islandsDropped: 0, islandSamplesDropped: 0, holesFilled: 0, holeSamplesFilled: 0 };

    /* bridge: close hairline gaps first, in whole samples */
    var rb = o.trimBridgeMm / ((g.dx + g.dy) / 2);
    if (rb >= 1) {
      var cl = closeMask(m, nx, ny, rb);
      for (i = 0; i < n; i++) if (cl[i] && !m[i]) { m[i] = 1; info.bridgedSamples++; }
    }

    /* islands: raised patches (8-connected) far smaller than the largest */
    var fg = components(m, nx, ny, 1, true), big = 0;
    for (k = 0; k < fg.count; k++) if (fg.area[k] > big) big = fg.area[k];
    var minIsland = o.trimSpeckPct / 100 * big;
    for (i = 0; i < n; i++) {
      k = fg.lab[i];
      if (k >= 0 && fg.area[k] < minIsland) { m[i] = 0; info.islandSamplesDropped++; }
    }
    for (k = 0; k < fg.count; k++) if (fg.area[k] < minIsland) info.islandsDropped++;

    /* holes: ground (4-connected) the picture's edge does not reach */
    var item = 0;
    for (i = 0; i < n; i++) item += m[i];
    var bg = components(m, nx, ny, 0, false), minHole = o.trimSpeckPct / 100 * item;
    for (k = 0; k < bg.count; k++) {
      if (bg.border[k]) continue;
      if (o.trim === 'holes' && bg.area[k] >= minHole) continue;
      info.holesFilled++; info.holeSamplesFilled += bg.area[k];
    }
    for (i = 0; i < n; i++) {
      k = bg.lab[i];
      if (k >= 0 && !bg.border[k] && !(o.trim === 'holes' && bg.area[k] >= minHole)) m[i] = 1;
    }

    /* rim: every sample within the margin of the item joins it */
    var rc = o.trimMarginMm / ((g.dx + g.dy) / 2);
    if (rc > 0) {
      var d2 = distSq(m, nx, ny), lim = rc * rc;
      for (i = 0; i < n; i++) if (!m[i] && d2[i] <= lim) m[i] = 1;
    }
    info.itemSamples = 0;
    for (i = 0; i < n; i++) info.itemSamples += m[i];
    return { ok: true, mask: m, info: info };
  }

  /* One 3 x 3 box blur of the mask, edge samples repeated outward. */
  function blur3(m, nx, ny) {
    var out = new Float64Array(nx * ny), i, j, di, dj, s, ii, jj;
    for (j = 0; j < ny; j++) {
      for (i = 0; i < nx; i++) {
        s = 0;
        for (dj = -1; dj <= 1; dj++) {
          jj = Math.min(ny - 1, Math.max(0, j + dj));
          for (di = -1; di <= 1; di++) {
            ii = Math.min(nx - 1, Math.max(0, i + di));
            s += m[jj * nx + ii];
          }
        }
        out[j * nx + i] = s / 9;
      }
    }
    return out;
  }

  /* The slab clipped to the mask's contour. Same node grid as buildMesh (the
     (nx + 2) x (ny + 2) one with the rim ring), same diagonal in every quad,
     each top triangle cut where the blurred mask crosses one half. See the
     TRIM section at the head of the file. */
  function buildTrimmed(hgt, g, o, mask) {
    var nx = g.nx, ny = g.ny, dx = g.dx, dy = g.dy, Hm = g.heightMm;
    var NX = nx + 2, NY = ny + 2, N = NX * NY, a, b;
    var xs = new Float64Array(NX), ys = new Float64Array(NY);
    xs[0] = 0; xs[NX - 1] = g.widthMm;
    for (a = 1; a <= nx; a++) xs[a] = (a - 0.5) * dx;
    ys[0] = 0; ys[NY - 1] = Hm;
    for (b = 1; b <= ny; b++) ys[b] = (b - 0.5) * dy;

    var sm = blur3(mask, nx, ny);
    var F = new Float64Array(N), px = new Float64Array(N), py = new Float64Array(N), pz = new Float64Array(N);
    for (b = 0; b < NY; b++) {
      var sj = Math.min(ny - 1, Math.max(0, b - 1));
      for (a = 0; a < NX; a++) {
        var si = Math.min(nx - 1, Math.max(0, a - 1)), nd = b * NX + a;
        var sv = sm[sj * nx + si] - 0.5;
        F[nd] = mask[sj * nx + si] ? (sv > 0.01 ? sv : 0.01) : (sv < -0.01 ? sv : -0.01);
        px[nd] = xs[a]; py[nd] = Hm - ys[b];
        pz[nd] = o.baseMm + hgt[sj * nx + si] * o.reliefMm;
      }
    }

    var vx = [], vy = [], vz = [];
    var nodeId = new Int32Array(N).fill(-1), cutId = new Map();
    function nodeV(nd) {
      if (nodeId[nd] < 0) { nodeId[nd] = vx.length; vx.push(px[nd]); vy.push(py[nd]); vz.push(pz[nd]); }
      return nodeId[nd];
    }
    /* the cut point on the edge between an inside node and an outside one:
       the same vertex whichever of the two triangles asks for it */
    function cutV(inN, outN) {
      var key = inN < outN ? inN * N + outN : outN * N + inN, id = cutId.get(key);
      if (id !== undefined) return id;
      var t = F[inN] / (F[inN] - F[outN]);
      t = t < 0.1 ? 0.1 : (t > 0.9 ? 0.9 : t);
      id = vx.length;
      vx.push(px[inN] + t * (px[outN] - px[inN]));
      vy.push(py[inN] + t * (py[outN] - py[inN]));
      vz.push(pz[inN] + t * (pz[outN] - pz[inN]));
      cutId.set(key, id);
      return id;
    }

    var top = [];
    function d2(i, j) { var ex = vx[i] - vx[j], ey = vy[i] - vy[j]; return ex * ex + ey * ey; }
    function clip(n0, n1, n2) {
      var nds = [n0, n1, n2], poly = [], e, u, w, iu, iw;
      for (e = 0; e < 3; e++) {
        u = nds[e]; w = nds[(e + 1) % 3]; iu = F[u] > 0; iw = F[w] > 0;
        if (iu) poly.push(nodeV(u));
        if (iu !== iw) poly.push(iu ? cutV(u, w) : cutV(w, u));
      }
      if (poly.length < 3) return;
      top.push(poly[0], poly[1], poly[2]);
      if (poly.length === 4) {
        /* a quad: split on its shorter diagonal */
        if (d2(poly[0], poly[2]) <= d2(poly[1], poly[3])) top.push(poly[0], poly[2], poly[3]);
        else { top.length -= 3; top.push(poly[0], poly[1], poly[3], poly[1], poly[2], poly[3]); }
      }
    }
    for (b = 0; b < NY - 1; b++) {
      for (a = 0; a < NX - 1; a++) {
        var q00 = b * NX + a, q10 = q00 + 1, q01 = q00 + NX, q11 = q01 + 1;
        clip(q01, q11, q10);
        clip(q01, q10, q00);
      }
    }
    var nTop = top.length / 3;
    if (!nTop) {
      return { ok: false, reason: 'the item is too small to hold an outline at ' + o.sampleMm +
        ' mm/sample (under about two samples across) - make Detail finer or lower the cut-off' };
    }
    var n = vx.length, t, e2;

    /* walls go wherever the top has no neighbour across an edge */
    var have = new Set(), bnd = [];
    for (t = 0; t < nTop; t++) {
      for (e2 = 0; e2 < 3; e2++) have.add(top[t * 3 + e2] * n + top[t * 3 + (e2 + 1) % 3]);
    }
    for (t = 0; t < nTop; t++) {
      for (e2 = 0; e2 < 3; e2++) {
        var p = top[t * 3 + e2], q = top[t * 3 + (e2 + 1) % 3];
        if (!have.has(q * n + p)) bnd.push(p, q);
      }
    }
    var nWall = bnd.length / 2;
    var tri = new Int32Array((nTop * 2 + nWall * 2) * 3), k = 0;
    function put(i, j, l) { tri[k++] = i; tri[k++] = j; tri[k++] = l; }
    for (t = 0; t < nTop; t++) {
      var i0 = top[t * 3], i1 = top[t * 3 + 1], i2 = top[t * 3 + 2];
      put(i0, i1, i2);
      put(n + i0, n + i2, n + i1);
    }
    for (t = 0; t < nWall; t++) {
      var wp = bnd[t * 2], wq = bnd[t * 2 + 1];
      put(wq, wp, n + wp);
      put(wq, n + wp, n + wq);
    }

    var pos = new Float64Array(n * 2 * 3), i;
    for (i = 0; i < n; i++) {
      pos[i * 3] = pos[(n + i) * 3] = vx[i];
      pos[i * 3 + 1] = pos[(n + i) * 3 + 1] = vy[i];
      pos[i * 3 + 2] = vz[i];
      pos[(n + i) * 3 + 2] = 0;
    }

    /* the topology, counted two ways: the Euler characteristic off the
       index buffer, and shells and holes off the top's own boundary loops */
    var next = new Map(), pinched = 0, loops = 0, seen = new Set();
    for (t = 0; t < nWall; t++) {
      if (next.has(bnd[t * 2])) pinched++; else next.set(bnd[t * 2], bnd[t * 2 + 1]);
    }
    next.forEach(function (_, start) {
      if (seen.has(start)) return;
      var cur = start;
      while (!seen.has(cur) && next.has(cur)) { seen.add(cur); cur = next.get(cur); }
      loops++;
    });
    var uf = new Int32Array(n);
    for (i = 0; i < n; i++) uf[i] = i;
    function find(x) { while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; }
    for (t = 0; t < nTop; t++) {
      uf[find(top[t * 3 + 1])] = find(top[t * 3]);
      uf[find(top[t * 3 + 2])] = find(top[t * 3]);
    }
    var roots = new Set();
    for (t = 0; t < nTop; t++) roots.add(find(top[t * 3]));
    var shells = roots.size, holes = loops - shells;

    var cen = census(tri, n * 2);
    cen.shells = shells; cen.holes = holes; cen.loops = loops; cen.pinched = pinched;
    cen.expectedChi = 2 * shells - 2 * holes;
    cen.closed = cen.open === 0 && cen.nonManifold === 0 && cen.windingClashes === 0 &&
      cen.degenerate === 0 && pinched === 0 && cen.chi === cen.expectedChi;

    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, zMax = -Infinity, area = 0;
    for (i = 0; i < n; i++) {
      if (vx[i] < x0) x0 = vx[i]; if (vx[i] > x1) x1 = vx[i];
      if (vy[i] < y0) y0 = vy[i]; if (vy[i] > y1) y1 = vy[i];
      if (vz[i] > zMax) zMax = vz[i];
    }
    for (t = 0; t < nTop; t++) {
      var A = top[t * 3], B = top[t * 3 + 1], C = top[t * 3 + 2];
      area += ((vx[B] - vx[A]) * (vy[C] - vy[A]) - (vx[C] - vx[A]) * (vy[B] - vy[A])) / 2;
    }
    return { ok: true, pos: pos, tri: tri, V: n * 2, T: tri.length / 3, census: cen,
             bboxMm: [x0, y0, x1, y1], zTop: zMax, areaMm2: area, nTop: nTop };
  }

  /* ---------------------------------------------------------------- build */

  function build(img, opts) {
    var bad = checkImage(img);
    if (bad) return { ok: false, reason: bad };
    var o = readOpts(opts);
    bad = checkOpts(o);
    if (bad) return { ok: false, reason: bad };

    var W = img.width, H = img.height;
    var pl = plan(W, H, o);
    if (!pl.ok) {
      return { ok: false, reason: pl.reason, refused: 'budget', triangles: pl.triangles,
               budget: pl.budget, suggestSampleMm: pl.suggestSampleMm,
               suggestTriangles: pl.suggestTriangles, samples: pl.samples, mmPerPixel: pl.mmPerPixel };
    }

    var gray = grayscale(img);
    var c = contrast(gray);
    var q = quantize(c.t, o.levels);
    if (c.source === 'flat') q = new Float64Array(q.length);
    else if (o.darkIsUp) for (var i = 0; i < q.length; i++) q[i] = 1 - q[i];
    var g = gridFor(W, H, o.widthMm, o.sampleMm);
    var hgt = boxResample(q, W, H, g.nx, g.ny);

    var mesh, cen, trimInfo = null;
    if (o.trim === 'off') {
      mesh = buildMesh(hgt, g, o);
      cen = census(mesh.tri, mesh.V);
    } else {
      var tm = trimMask(hgt, g, o);
      if (!tm.ok) return { ok: false, reason: tm.reason };
      mesh = buildTrimmed(hgt, g, o, tm.mask);
      if (!mesh.ok) return { ok: false, reason: mesh.reason };
      cen = mesh.census;
      if (mesh.T > o.maxTriangles) {
        return { ok: false, refused: 'budget', triangles: mesh.T, budget: o.maxTriangles,
                 reason: 'the trimmed slab is ' + fmt(mesh.T) + ' triangles, over the ' + fmt(o.maxTriangles) + ' budget' };
      }
      trimInfo = Object.assign({
        mode: o.trim, above: o.trimAbove, marginMm: o.trimMarginMm, speckPct: o.trimSpeckPct,
        bridgeMm: o.trimBridgeMm, keptPct: 100 * mesh.areaMm2 / (g.widthMm * g.heightMm), areaMm2: mesh.areaMm2,
        bboxMm: mesh.bboxMm, shells: cen.shells, holes: cen.holes, fullTriangles: pl.triangles
      }, tm.info);
    }
    if (!cen.closed) {
      return { ok: false, reason: 'the slab did not close (' + cen.open + ' open, ' + cen.nonManifold +
               ' non-manifold, ' + cen.windingClashes + ' winding clash(es), chi ' + cen.chi +
               (trimInfo ? ', expected ' + cen.expectedChi + ', ' + cen.pinched + ' pinch(es)' : '') + ') - nothing made',
               census: cen };
    }

    var hMax = 0, hMin = 1;
    for (var k = 0; k < hgt.length; k++) { if (hgt[k] > hMax) hMax = hgt[k]; if (hgt[k] < hMin) hMin = hgt[k]; }
    var zTop = trimInfo ? mesh.zTop : o.baseMm + Math.max(hMax * o.reliefMm, hMin * o.reliefMm, 0);
    var sizeMm = trimInfo ? [mesh.bboxMm[2] - mesh.bboxMm[0], mesh.bboxMm[3] - mesh.bboxMm[1], zTop]
                          : [g.widthMm, g.heightMm, zTop];
    var r = {
      ok: true,
      rawTris: toSoup(mesh),
      samples: g.nx * g.ny,
      triangles: mesh.T,
      mmPerPixel: o.widthMm / W,
      grid: { nx: g.nx, ny: g.ny, dx: g.dx, dy: g.dy },
      sizeMm: sizeMm,
      trim: trimInfo,
      heights: hgt,
      contrast: { source: c.source, lo: c.lo, hi: c.hi, p1: c.p1, p99: c.p99, min: c.min, max: c.max },
      census: cen,
      opts: o
    };
    r.describe = 'relief ' + g.widthMm.toFixed(2) + ' x ' + g.heightMm.toFixed(2) + ' mm, base ' + o.baseMm +
      ' + relief ' + o.reliefMm + ' mm, ' + g.nx + ' x ' + g.ny + ' = ' + fmt(r.samples) + ' samples at ' +
      o.sampleMm + ' mm, ' + (o.levels ? o.levels + ' levels' : 'smooth') + ', ' +
      (o.darkIsUp ? 'dark' : 'bright') + ' is up, ' + (+r.mmPerPixel.toPrecision(4)) + ' mm/px - ' +
      fmt(r.triangles) + ' triangles, closed (chi ' + cen.chi + ')';
    if (trimInfo) {
      r.describe += ' - trimmed to the item\'s ' + (o.trim === 'holes' ? 'outline and holes' : 'outer edge') +
        ': ' + trimInfo.keptPct.toFixed(1) + '% of the slab kept, ' + trimInfo.shells + ' shell' +
        (trimInfo.shells === 1 ? '' : 's') + (trimInfo.holes ? ', ' + trimInfo.holes + ' hole' + (trimInfo.holes === 1 ? '' : 's') : '') +
        (trimInfo.islandsDropped ? ', ' + trimInfo.islandsDropped + ' speck' + (trimInfo.islandsDropped === 1 ? '' : 's') + ' dropped' : '');
    }
    return r;
  }

  var api = {
    MAX_TRIANGLES: MAX_TRIANGLES, DEFAULTS: DEFAULTS,
    grayscale: grayscale, contrast: contrast, quantize: quantize, boxResample: boxResample,
    triangleCount: triangleCount, gridFor: gridFor, fittingSample: fittingSample,
    plan: plan, build: build, census: census, formatCount: fmt,
    trimMask: trimMask, TRIM_MODES: TRIM_MODES
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_Relief = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
