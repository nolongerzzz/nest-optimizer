/* nso_raster_lines.js - a 2D raster of line art becomes a flat, thin extruded
   solid: a real printed line's section, not a relief profile.

   Loads as a classic script (window.NSO_RasterLines) and as a Node module
   (require('../nso_raster_lines.js')). Pure geometry: no DOM, no Three.js, no
   image decoding. A mesh is the app's raw soup - 9 numbers per triangle, Z up,
   millimetres - the same currency nso_skin.js and nso_skin_patch.js speak.

   ---------------------------------------------------------------------------
   WHY THIS EXISTS - the section, measured
   ---------------------------------------------------------------------------
   tools/nso_raster_line_audit.js is the audit and carries the numbers; the
   three that decide the design are these. Two copies of the shipped loose
   zigzag patch, stacked and turned 90 degrees across each other the way Bambu
   builds a two-layer interface:

     - every ridge crossing bonds over 0.42 x 1.20 mm = 0.5040 mm^2, because a
       standing sawtooth ridge is 0.42 mm at its CREST and 1.20 mm where it
       meets the plate, and the upper copy presents its WIDE end to the
       interface. A real printed line is the same width top and bottom, so a
       real crossing bonds over 0.42 x 0.42 = 0.1764 mm^2. 2.857x, and the
       ratio is exactly base/tip.
     - hold the path and the angle fixed and turn the upper copy over, so a
       0.42 mm crest meets a 0.42 mm crest: 0.1764 mm^2 per crossing, to the
       digit. Same 225 crossings. The section is the whole variable.
     - the shipped crosshatch is a different fault and not this one: its ribs
       are prismatic, 0.42 mm top and bottom, but ONE layer already runs ribs
       BOTH ways, so a 90 degree copy's underside is the same lattice as the
       tips under it and 519.75 mm^2 - every square millimetre of tip - welds
       in a single patch.

   So a printed interface needs a path that runs in ONE direction per layer and
   a section that is flat and thin. The path is exactly what a raster of a
   toolpath already holds, and the section is two numbers. That is this module:
   take the path from the image, take the section from the measured line.

   ---------------------------------------------------------------------------
   THE MEASURED LINE - tonight's Bambu values, and one of them is not new
   ---------------------------------------------------------------------------
   LINE_HEIGHT     0.30 mm   layer height
   LINE_WIDTH      0.42 mm   extrusion width, the narrow end of the measured
                             0.42 - 0.61 mm range. It is also nso_skin.js's
                             crosshatch rib, nso_skin_patch.js's MIN_WALL and
                             the threshold mesh_validate.py --min-wall carries:
                             one extrusion line at a 0.4 mm nozzle. The
                             measured value and the repo's own figure are the
                             same number, which is why it is the default.
   LINE_WIDTH_MAX  0.61 mm   the wide end, for the widest real line

   Both are parameters on every entry point. Nothing here infers a width from
   the image: the raster gives the CENTRELINE, the caller gives the section.
   That is the whole reason to trace rather than to extrude the black pixels -
   a traced toolpath printed at 0.42 mm is 0.42 mm wide whatever the stroke
   width of the picture happened to be, and it has no stair steps.

   ---------------------------------------------------------------------------
   THE PIPELINE
   ---------------------------------------------------------------------------
   toMask      threshold to a binary ink mask. Black is ink; `invert` flips it.
   thin        Zhang-Suen, to a one-pixel skeleton. The picture's stroke width
               is discarded here, on purpose - see above.
   tracePaths  the skeleton as a graph, walked into polylines. A pixel's
               neighbours are counted in the REDUCED 8-neighbourhood (a
               diagonal is ignored when a shared 4-neighbour already connects
               it), without which every diagonal staircase reads as a junction.
   simplify    Douglas-Peucker, which is what turns a staircase back into the
               straight line it was drawn as.
   extrudeFlat the polylines as one flat solid of the given section.

   ---------------------------------------------------------------------------
   WHY extrudeFlat IS A PLANAR SUBDIVISION AND NOT ONE PRISM PER LINE
   ---------------------------------------------------------------------------
   "Extrude each traced line as a flat thin solid" written literally is one
   closed prism per polyline, and at every crossing two of them occupy the same
   millimetre of space. Each prism is closed, so an open-edge count sees
   nothing wrong - and the union is self-intersecting, which is what
   mesh_validate.py's piercing axis exists to catch and what the skin-patch
   work already paid for twice (2590 and 2488 piercing pairs, both invisible to
   a closure check). A slicer's own repair would have to fix it, and the
   contact geometry at a crossing - the one thing this module is for - would be
   whatever that repair decided.

   Every line here shares one extrusion height, which is Task 4's scope
   ("uniform extrusion height, no height-map relief"), so the solid is a PRISM
   over a 2D region and the union can be done once, in the plane, exactly:

     - each graph NODE gets a convex PAD - the junction, the corner or the
       cap - built from where the incident lines' boundary lines meet;
     - each graph EDGE gets a QUAD between its two pads' attach edges;
     - pads and quads meet edge-to-edge by construction, sharing the identical
       two points, so they tile the region as a planar subdivision;
     - top faces at z = height, bottom faces at z = 0, and a wall on exactly
       those edges used by ONE face - the region's boundary.

   Every edge of the result is then used by exactly two triangles: an interior
   edge by two tops and two bottoms, a boundary edge by a top, a bottom and the
   two triangles of its wall. Watertight by construction and with no
   self-intersection, for the same reason nso_skin_patch.js's looseGrid is:
   every face between material and air is emitted exactly once.

   A 4-way crossing's pad is then exactly the w x w square the audit measures,
   which is the point.

   Two things this construction can be asked to do and cannot, both COUNTED
   and both refused by name rather than silently welded:
     tightSegments  a segment shorter than the pads at its two ends need. The
                    pads would overlap. `simplify` at or above half the line
                    width normally removes these; `minSegment` reports the
                    shortest that survived.
     overlapPairs   two lines that pass within a line width of each other
                    without meeting at a node. From a skeleton this cannot
                    happen - crossing strokes share pixels and become a node -
                    but extrudeFlat is a public entry point and hand-built
                    paths can do it.
*/
(function (root) {
  'use strict';

  /* ------------------------------------------- tonight's measured line */
  var LINE_HEIGHT = 0.3;      /* mm, layer height */
  var LINE_WIDTH = 0.42;      /* mm, extrusion width - also MIN_WALL */
  var LINE_WIDTH_MAX = 0.61;  /* mm, the wide end of the measured range */

  /* A join is mitred until the mitre runs further than this many half-widths
     from the node, then bevelled. 4 is SVG's own stroke-miterlimit default. A
     mitre is exact for the turns a traced toolpath makes (a zigzag's end turn
     is 90 degrees or blunter); the bevel is there so a hairpin cannot throw a
     spike across the piece. */
  var MITER_LIMIT = 4;

  /* How many DRAWN stroke widths a skeleton bridge may be and still be read as
     a crossing artefact rather than a feature - see collapseBridges. The bound
     a crossing of angle t can produce is 1 / sin(t) stroke widths, so 2.5
     covers every crossing down to about 24 degrees; shallower than that and
     two strokes genuinely do merge into one in the ink. */
  var BRIDGE_STROKES = 2.5;

  /* ---------------------------------------------------------- vectors */
  function unit2(d) { var L = Math.hypot(d[0], d[1]); return L > 0 ? [d[0] / L, d[1] / L] : [0, 0]; }
  function cross2(a, b) { return a[0] * b[1] - a[1] * b[0]; }
  function dot2(a, b) { return a[0] * b[0] + a[1] * b[1]; }
  function left2(u) { return [-u[1], u[0]]; }          /* rot 90 CCW */

  /* ------------------------------------------------------------ mask */

  /* toMask(image, opts) -> { w, h, bits } or a reason string.
     image: { width, height, data, channels? } - a browser ImageData is exactly
     this shape (channels 4). channels defaults to data.length/(w*h), so a
     plain grayscale array works too.
     opts: threshold 0..255 (default 128; a pixel is INK when its luminance is
     BELOW it, i.e. black draws), invert (ink is the light side instead),
     alphaFloor (default 8: a pixel more transparent than this is never ink,
     so a PNG's transparent background does not read as black). */
  function toMask(image, opts) {
    var o = opts || {};
    if (!image || !(image.width > 0) || !(image.height > 0) || !image.data) {
      return 'toMask needs { width, height, data }';
    }
    var w = image.width | 0, h = image.height | 0, d = image.data;
    var ch = image.channels || Math.round(d.length / (w * h));
    if (!(ch === 1 || ch === 2 || ch === 3 || ch === 4)) {
      return 'toMask: ' + d.length + ' samples is not 1, 2, 3 or 4 channels of ' + w + ' x ' + h;
    }
    if (d.length < w * h * ch) return 'toMask: data is shorter than ' + w + ' x ' + h + ' x ' + ch;
    var thr = o.threshold == null ? 128 : o.threshold;
    var af = o.alphaFloor == null ? 8 : o.alphaFloor;
    var inv = !!o.invert;
    var bits = new Uint8Array(w * h), ink = 0;
    for (var i = 0; i < w * h; i++) {
      var p = i * ch, lum, a = 255;
      if (ch === 1) lum = d[p];
      else if (ch === 2) { lum = d[p]; a = d[p + 1]; }
      else { lum = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; if (ch === 4) a = d[p + 3]; }
      var on = a >= af && (inv ? lum >= thr : lum < thr);
      if (on) { bits[i] = 1; ink++; }
    }
    return { w: w, h: h, bits: bits, ink: ink, threshold: thr, invert: inv };
  }

  /* ----------------------------------------------------------- thinning */

  /* Zhang-Suen, to a one-pixel-wide 8-connected skeleton. The classical two
     sub-iterations, unchanged: B is the number of ink neighbours, A the number
     of 0->1 transitions walking P2..P9..P2 clockwise from north. */
  function thin(mask) {
    var w = mask.w, h = mask.h;
    var a = Uint8Array.from(mask.bits), i, j;
    var N = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
    var nb = new Array(8);
    var passes = 0, changed = true;
    function at(x, y) { return (x < 0 || y < 0 || x >= w || y >= h) ? 0 : a[y * w + x]; }
    while (changed) {
      changed = false;
      for (var step = 0; step < 2; step++) {
        var kill = [];
        for (j = 0; j < h; j++) for (i = 0; i < w; i++) {
          if (!a[j * w + i]) continue;
          var B = 0, A = 0, k;
          for (k = 0; k < 8; k++) { nb[k] = at(i + N[k][0], j + N[k][1]); B += nb[k]; }
          if (B < 2 || B > 6) continue;
          for (k = 0; k < 8; k++) if (!nb[k] && nb[(k + 1) & 7]) A++;
          if (A !== 1) continue;
          var p2 = nb[0], p4 = nb[2], p6 = nb[4], p8 = nb[6];
          if (step === 0) { if (p2 * p4 * p6 || p4 * p6 * p8) continue; }
          else { if (p2 * p4 * p8 || p2 * p6 * p8) continue; }
          kill.push(j * w + i);
        }
        if (kill.length) { changed = true; for (k = 0; k < kill.length; k++) a[kill[k]] = 0; }
        passes++;
      }
    }
    var ink = 0;
    for (i = 0; i < a.length; i++) ink += a[i];
    return { w: w, h: h, bits: a, ink: ink, passes: passes };
  }

  /* ------------------------------------------------------------ tracing */

  /* The skeleton as a graph, then walked into polylines in PIXEL coordinates
     (x right, y down, a pixel's centre at i + 0.5, j + 0.5).

     Adjacency is the REDUCED 8-neighbourhood: a diagonal neighbour is dropped
     when either 4-neighbour it shares with the centre is also ink, because the
     connection is already there through that 4-neighbour. Without this every
     step of a diagonal staircase reads as a degree-3 junction and a single
     drawn line comes back as dozens of stubs. The rule is symmetric - the two
     shared 4-neighbours are the same pair seen from either end - so the
     adjacency really is a graph. */
  function tracePaths(skel) {
    var w = skel.w, h = skel.h, b = skel.bits;
    function at(x, y) { return (x < 0 || y < 0 || x >= w || y >= h) ? 0 : b[y * w + x]; }
    var STRAIGHT = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    var DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    var adj = new Map();
    var i, j, k, key;
    function K(x, y) { return y * w + x; }
    for (j = 0; j < h; j++) for (i = 0; i < w; i++) {
      if (!b[j * w + i]) continue;
      var list = [];
      for (k = 0; k < 4; k++) {
        var s = STRAIGHT[k];
        if (at(i + s[0], j + s[1])) list.push(K(i + s[0], j + s[1]));
      }
      for (k = 0; k < 4; k++) {
        var dg = DIAG[k];
        if (!at(i + dg[0], j + dg[1])) continue;
        if (at(i + dg[0], j) || at(i, j + dg[1])) continue;   /* already connected */
        list.push(K(i + dg[0], j + dg[1]));
      }
      adj.set(K(i, j), list);
    }
    var paths = [], used = new Set();
    function ek(a, c) { return a < c ? a + ':' + c : c + ':' + a; }
    function pt(kk) { return [(kk % w) + 0.5, Math.floor(kk / w) + 0.5]; }
    /* from a node, along one unused incident edge, until the next node */
    function walk(start, first) {
      var pts = [pt(start)], prev = start, cur = first;
      used.add(ek(prev, cur));
      pts.push(pt(cur));
      for (;;) {
        var nx = adj.get(cur), pick = -1;
        if (nx.length !== 2) break;                 /* a node: stop here */
        for (var q = 0; q < nx.length; q++) {
          if (nx[q] === prev) continue;
          if (used.has(ek(cur, nx[q]))) continue;
          pick = nx[q];
        }
        if (pick < 0) break;
        used.add(ek(cur, pick));
        prev = cur; cur = pick;
        pts.push(pt(cur));
      }
      return pts;
    }
    var keys = Array.from(adj.keys()).sort(function (x, y) { return x - y; });
    /* 1. every edge that leaves a node (degree != 2), including isolated dots */
    for (k = 0; k < keys.length; k++) {
      key = keys[k];
      var nb2 = adj.get(key);
      if (nb2.length === 2) continue;
      if (!nb2.length) { paths.push([pt(key)]); continue; }   /* an isolated pixel */
      for (var q2 = 0; q2 < nb2.length; q2++) {
        if (used.has(ek(key, nb2[q2]))) continue;
        paths.push(walk(key, nb2[q2]));
      }
    }
    /* 2. what is left is closed loops of degree-2 pixels - start anywhere */
    for (k = 0; k < keys.length; k++) {
      key = keys[k];
      var nb3 = adj.get(key);
      if (nb3.length !== 2) continue;
      for (var q3 = 0; q3 < nb3.length; q3++) {
        if (used.has(ek(key, nb3[q3]))) continue;
        var loop = walk(key, nb3[q3]);
        /* close it: the walk stops when it runs out of unused edges, one pixel
           short of where it began */
        var a0 = loop[0], a1 = loop[loop.length - 1];
        if (Math.abs(a0[0] - a1[0]) <= 1 && Math.abs(a0[1] - a1[1]) <= 1 && loop.length > 2) loop.push(a0.slice());
        paths.push(loop);
      }
    }
    return paths;
  }

  /* --------------------------------------------------------- simplify */

  /* Douglas-Peucker, tolerance in the same units as the points. Endpoints are
     kept by construction, so a junction stays exactly where the trace put it
     and two paths that meet there still meet. */
  function simplify(pts, tol) {
    if (!(tol > 0) || pts.length < 3) return pts.slice();
    var keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var seg = stack.pop(), a = seg[0], c = seg[1];
      if (c <= a + 1) continue;
      var pa = pts[a], pc = pts[c];
      var ex = pc[0] - pa[0], ey = pc[1] - pa[1], L = Math.hypot(ex, ey);
      var worst = -1, wi = -1;
      for (var i = a + 1; i < c; i++) {
        var p = pts[i], dist;
        if (L < 1e-12) dist = Math.hypot(p[0] - pa[0], p[1] - pa[1]);
        else dist = Math.abs(ex * (p[1] - pa[1]) - ey * (p[0] - pa[0])) / L;
        if (dist > worst) { worst = dist; wi = i; }
      }
      if (worst > tol) { keep[wi] = 1; stack.push([a, wi], [wi, c]); }
    }
    var out = [];
    for (var k = 0; k < pts.length; k++) if (keep[k]) out.push(pts[k]);
    return out;
  }

  /* Collapse a segment shorter than `minLen` into the CORNER its two
     neighbours make, until none is left.

     Why this exists. Zhang-Suen CHAMFERS a right angle - the skeleton of a 90
     degree turn cuts the corner over two or three pixels - so a traced
     boustrophedon corner comes back as a stub a fraction of a millimetre long
     at 45 degrees, which survives Douglas-Peucker because it really is that far
     off the chord. A stub shorter than the line width cannot be drawn as a flat
     line of that width at all: the joins at its two ends need more length than
     it has, which is the `tightSegments` refusal.

     Why the collapse is to the INTERSECTION of the two neighbouring segments
     and not to a dropped vertex, which is what this function did first and
     which was measured being wrong: dropping one end of the stub folds the
     chamfer into the long line next to it and TILTS it - 0.25 mm of drift over
     a 29 mm line, half a degree - and half a degree of skew turns a crossing
     of two 0.42 mm lines from 0.176400 mm^2 into 0.176410. The stub is a
     rounded corner; its corner is where the two straight runs meet, and putting
     the vertex there leaves both of them exactly straight and leaves the
     residual wherever the chamfer actually was.

     Endpoints are never moved - they are the junctions other paths meet at - so
     a stub at either end of the path collapses by dropping its inner vertex,
     which is the only choice that keeps the junction where the trace put it. */
  function collapseShort(pts, minLen) {
    if (!(minLen > 0) || pts.length < 3) return pts.slice();
    var p = pts.map(function (q) { return [q[0], q[1]]; });
    for (var guard = 0; guard < pts.length + 8; guard++) {
      var worst = -1, wl = Infinity, i;
      for (i = 0; i + 1 < p.length; i++) {
        var L = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
        if (L < minLen && L < wl) { wl = L; worst = i; }
      }
      if (worst < 0) break;
      if (p.length < 3) break;
      if (worst === 0) { p.splice(1, 1); continue; }               /* keep p[0] */
      if (worst === p.length - 2) { p.splice(p.length - 2, 1); continue; }
      var x = lineMeet(p[worst - 1], p[worst], p[worst + 1], p[worst + 2]);
      p.splice(worst, 2, x || [(p[worst][0] + p[worst + 1][0]) / 2,
                               (p[worst][1] + p[worst + 1][1]) / 2]);
    }
    return p;
  }
  /* where the line a->b meets the line c->d, or null when they are parallel */
  function lineMeet(a, b, c, d) {
    var r = [b[0] - a[0], b[1] - a[1]], s2 = [d[0] - c[0], d[1] - c[1]];
    var den = cross2(r, s2);
    if (Math.abs(den) < 1e-12) return null;
    var t = cross2([c[0] - a[0], c[1] - a[1]], s2) / den;
    return [a[0] + t * r[0], a[1] + t * r[1]];
  }

  /* Weld graph NODES closer together than `minLen` into one, and drop the
     stubs between them.

     collapseShort above fixes a short segment INSIDE a polyline, where one end
     is a free vertex it may move. It cannot fix a short segment whose BOTH ends
     are junctions, and a diagonal crossing is exactly that case: an X of two 45
     degree strokes does not thin to one clean degree-4 pixel the way a
     right-angled X does - Zhang-Suen leaves a little cluster of Y-junctions
     joined by one-pixel bridges. Measured on the 45 degree crosshatch reference,
     15 lines each way at 0.05 mm/px: 960 graph nodes where a clean lattice has
     225 junctions and 60 line ends, 900 paths shorter than 0.1 mm, closest node
     pair exactly one pixel apart. extrudeFlat then refuses the lot, correctly -
     a 0.05 mm segment cannot carry a 0.42 mm line's joins.

     So: cluster the endpoints within `minLen` of each other, move every one of
     them to its cluster's centroid, and drop the paths that collapse to nothing.
     The four arms of a crossing then meet at ONE point and the junction is the
     degree-4 node it always was. Iterated, because welding two clusters can
     bring a third within reach, with a guard so a pathological input cannot
     spin. Endpoints DO move here, unlike in collapseShort - that is the whole
     operation - but only by under one line width, and only onto the centroid of
     the cluster they were already part of. */
  function weldNodes(paths, minLen) {
    if (!(minLen > 0)) return paths.map(function (p) { return p.slice(); });
    var out = paths.map(function (p) { return p.map(function (q) { return [q[0], q[1]]; }); });
    for (var pass = 0; pass < 8; pass++) {
      var ends = [], i, k;
      for (i = 0; i < out.length; i++) {
        if (out[i].length < 2) continue;
        ends.push({ p: out[i][0], path: i, at: 0 });
        ends.push({ p: out[i][out[i].length - 1], path: i, at: out[i].length - 1 });
      }
      if (!ends.length) break;
      /* cluster by proximity, bucketed so this does not go quadratic */
      var parent = ends.map(function (_, ix) { return ix; });
      function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
      var cell = minLen, buckets = new Map();
      for (i = 0; i < ends.length; i++) {
        var cx = Math.floor(ends[i].p[0] / cell), cy = Math.floor(ends[i].p[1] / cell);
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
          var bk = (cx + dx) + ':' + (cy + dy);
          var list = buckets.get(bk);
          if (!list) continue;
          for (k = 0; k < list.length; k++) {
            var j = list[k];
            if (Math.hypot(ends[i].p[0] - ends[j].p[0], ends[i].p[1] - ends[j].p[1]) >= minLen) continue;
            var ra = find(i), rb = find(j);
            if (ra !== rb) parent[ra] = rb;
          }
        }
        var ok = cx + ':' + cy;
        if (!buckets.has(ok)) buckets.set(ok, []);
        buckets.get(ok).push(i);
      }
      /* the centroid of each cluster, and whether anything moved at all */
      var sum = new Map(), moved = false;
      for (i = 0; i < ends.length; i++) {
        var r = find(i), acc = sum.get(r);
        if (!acc) { acc = [0, 0, 0]; sum.set(r, acc); }
        acc[0] += ends[i].p[0]; acc[1] += ends[i].p[1]; acc[2]++;
      }
      for (i = 0; i < ends.length; i++) {
        var c = sum.get(find(i));
        var nx = c[0] / c[2], ny = c[1] / c[2];
        if (Math.abs(nx - ends[i].p[0]) > 1e-12 || Math.abs(ny - ends[i].p[1]) > 1e-12) moved = true;
        out[ends[i].path][ends[i].at] = [nx, ny];
      }
      /* drop what collapsed: a path with no length left to carry a line */
      out = out.filter(function (p) {
        if (p.length < 2) return false;
        var L = 0;
        for (var q = 0; q + 1 < p.length; q++) L += Math.hypot(p[q + 1][0] - p[q][0], p[q + 1][1] - p[q][1]);
        return L >= minLen;
      });
      if (!moved) break;
    }
    return out;
  }

  /* --------------------------------------------------- skeleton bridges */

  /* A path whose BOTH ends are junctions and which is too short to be a drawn
     feature is not a feature: it is what Zhang-Suen leaves where two strokes
     CROSS, and it has to go or the crossing reads as two junctions with a
     little rail between them instead of the one X the picture shows.

     weldNodes above is the same repair at a different scale and does not reach
     this case. Its radius is `minLen` - the PRINTED line width, 0.42 mm - and
     that was calibrated on the synthetic references, every one of which crosses
     at 90 degrees. The bridge a crossing leaves is not that size. Two strokes
     of drawn width w meeting at angle t overlap in a rhombus whose long
     diagonal is w / sin(t), and the bridge lies inside it, so:

         bridge <= w / sin(t)

     At 90 degrees that is w, and w on the synthetic references is a 5 px
     stroke - 0.25 mm, comfortably under the 0.42 mm weld, which is why nothing
     caught this. Measured on fixtures/raster-real/skew-cross.png, a picture
     drawn by Chromium rather than by this repo: mean drawn width 12.1 px, the
     two strokes 44 degrees apart, so the bound is 12.1 / sin(44) = 17.4 px and
     the bridge really there is 17.8 px - 0.890 mm, twice the weld radius. It
     survived, and one crossing came back as 5 paths and 2 junctions.

     So the scale of this repair is the DRAWN stroke width, which the rest of
     the module throws away on purpose (the picture gives the centreline, the
     caller gives the section) and which is exactly the right ruler here. It is
     measured off the mask - ink pixels over skeleton pixels is the mean width
     of the stroke - and never guessed.

     The gate that makes this safe is not the length, it is the DEGREE. A free
     line end has degree 1 and a T's stem has degree 1 at its far end, so
     neither can ever be caught: both ends must already be junctions. What is
     left after that is a rail between two junctions shorter than one crossing
     can make, and in line art that is a skeletonisation artefact every time.

     Runs AFTER weldNodes, so the short clusters are already gone and this sees
     only the long bridges weldNodes cannot reach - which is also why it does
     not disturb any existing fixture. */
  function collapseBridges(paths, maxLen) {
    if (!(maxLen > 0)) return paths.map(function (p) { return p.slice(); });
    var out = paths.map(function (p) { return p.map(function (q) { return [q[0], q[1]]; }); });
    var base = function (e) { return out[e.path][e.at]; };
    /* the vertex next to the node along that arm - the arm's direction at the
       node, and the far end of the baseline the through-line is drawn through */
    var adj = function (e) { var q = out[e.path]; return e.at === 0 ? q[1] : q[q.length - 2]; };
    var away = function (e) { var a = base(e), b = adj(e); return unit2([b[0] - a[0], b[1] - a[1]]); };

    /* WHERE THE MERGED NODE GOES, and this is the part that had to be measured.
       The centroid of the two ends is the obvious answer and it is wrong in
       exactly the way collapseShort's dropped vertex was wrong above: it sits
       at the MIDDLE OF THE BRIDGE rather than where the two strokes actually
       cross, and both arms tilt to reach it. Measured on skew-cross.png, whose
       lines are drawn at 23 and 67 degrees: the centroid brings the mesh back
       at 22 degrees - a whole degree of skew on a 9.5 mm arm - and the module's
       own contact figures are sensitive to half of that.
       So pair the four arms into the two through-lines - each arm at one end
       continues into the arm at the other end that points back at it - and put
       the node where those two lines MEET. That is the crossing the picture
       has. Returns null when the arms do not pair into two through-lines (not
       an X: a degree-4 node, a Y-cluster, two near-parallel strokes), and the
       caller falls back to the centroid, which is honest for those. */
    function crossing(A, B, bridge) {
      if (A.ends.length !== 3 || B.ends.length !== 3) return null;
      var notBridge = function (e) { return e.path !== bridge; };
      var a = A.ends.filter(notBridge), b = B.ends.filter(notBridge);
      if (a.length !== 2 || b.length !== 2) return null;
      /* arm a[0] continues into whichever of b points most nearly back at it */
      var d0 = away(a[0]);
      var s0 = dot2(d0, away(b[0])), s1 = dot2(d0, away(b[1]));
      var j = s0 <= s1 ? 0 : 1;
      /* -0.5 is 120 degrees: anything blunter than that is not one line
         carrying on through the crossing, it is a corner */
      if (Math.min(s0, s1) > -0.5) return null;
      if (dot2(away(a[1]), away(b[1 - j])) > -0.5) return null;
      var x = lineMeet(adj(a[0]), adj(b[j]), adj(a[1]), adj(b[1 - j]));
      if (!x) return null;                              /* the two lines are parallel */
      /* and it has to land ON the crossing: a glancing pair meets far away */
      var mx = (A.p[0] + B.p[0]) / 2, my = (A.p[1] + B.p[1]) / 2;
      if (Math.hypot(x[0] - mx, x[1] - my) > maxLen) return null;
      return x;
    }

    for (var pass = 0; pass < 16; pass++) {
      var i, k, e;
      /* every path end, grouped by the node it sits on. Endpoints are exact
         here: simplify, collapseShort and dropCollinear all leave them where
         the trace put them, on purpose, so identity is the vertex key. */
      var nodes = new Map();
      for (i = 0; i < out.length; i++) {
        if (out[i].length < 2) continue;
        for (e = 0; e < 2; e++) {
          var at = e === 0 ? 0 : out[i].length - 1;
          var kk = vkey(out[i][at]), nd = nodes.get(kk);
          if (!nd) { nd = { p: [out[i][at][0], out[i][at][1]], ends: [] }; nodes.set(kk, nd); }
          nd.ends.push({ path: i, at: at });
        }
      }

      /* Collapse every qualifying bridge whose two nodes are still free this
         pass. One bridge per merged pair keeps the geometry above exact and
         unambiguous; a chain of bridges resolves over the passes instead. */
      var claimed = new Set(), drop = new Uint8Array(out.length), moves = [];
      for (i = 0; i < out.length; i++) {
        var pth = out[i];
        if (pth.length < 2) continue;
        var ka = vkey(pth[0]), kb = vkey(pth[pth.length - 1]);
        if (ka === kb) continue;                       /* a closed loop is not a bridge */
        if (claimed.has(ka) || claimed.has(kb)) continue;
        var A = nodes.get(ka), B = nodes.get(kb);
        if (A.ends.length < 3 || B.ends.length < 3) continue;
        var L = 0;
        for (k = 0; k + 1 < pth.length; k++) {
          L += Math.hypot(pth[k + 1][0] - pth[k][0], pth[k + 1][1] - pth[k][1]);
        }
        if (L > maxLen) continue;
        var x = crossing(A, B, i);
        if (!x) x = [(A.p[0] + B.p[0]) / 2, (A.p[1] + B.p[1]) / 2];
        claimed.add(ka); claimed.add(kb);
        drop[i] = 1;
        moves.push({ A: A, B: B, to: x });
      }
      if (!moves.length) break;

      /* the arms that ended at either node now end at the crossing */
      moves.forEach(function (m) {
        [m.A, m.B].forEach(function (n) {
          for (var q = 0; q < n.ends.length; q++) {
            out[n.ends[q].path][n.ends[q].at] = [m.to[0], m.to[1]];
          }
        });
      });
      out = out.filter(function (q, ix) { return !drop[ix] && q.length >= 2; });
    }
    return out;
  }

  /* Drop a vertex whose turn is straight to within `eps` radians. DP leaves
     these only where two traced paths were joined end to end; a pad of zero
     area is correct geometry (the two quads then share their end edge
     exactly), but one of 1e-12 mm^2 is a sliver, so they go. */
  function dropCollinear(pts, eps) {
    if (pts.length < 3) return pts.slice();
    var e = eps == null ? 1e-7 : eps;
    var out = [pts[0]], i;
    for (i = 1; i < pts.length - 1; i++) {
      var a = out[out.length - 1], b = pts[i], c = pts[i + 1];
      var u = unit2([b[0] - a[0], b[1] - a[1]]), v = unit2([c[0] - b[0], c[1] - b[1]]);
      if (Math.abs(cross2(u, v)) > e || dot2(u, v) < 0) out.push(b);
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /* -------------------------------------------------------- extrusion */

  var QUANT = 1e7;   /* vertex identity, 1e-7 mm - two orders under the weld */
  function vkey(p) { return Math.round(p[0] * QUANT) + '_' + Math.round(p[1] * QUANT); }

  /* How close a pad's own wedge point may come to a shared attach point before
     it is dropped as the same point, as a fraction of the line width. See the
     pad builder: 2% of a line is a sixth of a pixel at the reference raster's
     0.05 mm/px, and it is only ever the pad's private vertices that move. */
  var WEDGE_SNAP = 0.02;

  /* An incident edge's two attach corners, stored ON the inc entry so the pad
     and the quad that meet there read the SAME two points rather than each
     recomputing them from the same formula. Identical either way until the pad
     merges a pair (see the pad builder) - and then the quad follows for free,
     which is the whole reason they live here. */
  function cornersOf(nd, ic, a) {
    var nn = left2(ic.u), t = ic.t;
    ic.R = [nd.p[0] - a * nn[0] + t * ic.u[0], nd.p[1] - a * nn[1] + t * ic.u[1]];
    ic.L = [nd.p[0] + a * nn[0] + t * ic.u[0], nd.p[1] + a * nn[1] + t * ic.u[1]];
  }

  /* Drop the tagged-droppable points that sit on top of a kept neighbour. */
  function snapWedges(tagged, eps) {
    var n = tagged.length, out = [], i;
    var near2 = function (a, b) {
      return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
    };
    for (i = 0; i < n; i++) {
      var cur = tagged[i];
      if (cur.keep) { out.push(cur.p); continue; }
      var prev = tagged[(i - 1 + n) % n], next = tagged[(i + 1) % n];
      if ((prev.keep && near2(cur.p, prev.p)) || (next.keep && near2(cur.p, next.p))) continue;
      out.push(cur.p);
    }
    return out;
  }

  /* extrudeFlat(paths, opts) -> { ok, tris, ... }
     paths: arrays of [x, y] in millimetres, already in the plane.
     opts:  width (LINE_WIDTH), height (LINE_HEIGHT), baseZ (0 - the z the
            underside sits at, so a second layer can be stacked on the first),
            miterLimit (MITER_LIMIT).
     There is no "build it anyway" flag. A skipped tight segment leaves the pads
     at its two ends with attach edges nothing matches, so the result is open;
     an accepted overlap self-intersects. Either way what came back would not be
     the watertight solid this function's whole contract is, so both are
     refusals and the reason says what to change. */
  function extrudeFlat(paths, opts) {
    var o = opts || {};
    var wid = o.width == null ? LINE_WIDTH : o.width;
    var hgt = o.height == null ? LINE_HEIGHT : o.height;
    var z0 = o.baseZ || 0;
    var ml = o.miterLimit == null ? MITER_LIMIT : o.miterLimit;
    if (!(wid > 0)) return { ok: false, reason: 'line width must be positive' };
    if (!(hgt > 0)) return { ok: false, reason: 'line height must be positive' };
    if (!paths || !paths.length) return { ok: false, reason: 'no paths to extrude' };
    /* extrudeFlat takes a LIST of paths, each a list of [x, y]. Handing it one
       path directly reads as a list of two-number paths and used to come back
       as the unhelpful "no segment longer than 1e-7 mm", so it is named. */
    for (var vi = 0; vi < paths.length; vi++) {
      var vp = paths[vi];
      if (!vp || typeof vp.length !== 'number') {
        return { ok: false, reason: 'path ' + vi + ' is not an array of [x, y] points' };
      }
      for (var vj = 0; vj < vp.length; vj++) {
        var vq = vp[vj];
        if (!vq || vq.length < 2 || !isFinite(vq[0]) || !isFinite(vq[1])) {
          return { ok: false, reason: 'path ' + vi + ', point ' + vj + ' is not a finite [x, y]' +
            ' - extrudeFlat takes a LIST of paths, so one path on its own must be wrapped: [path]' };
        }
      }
    }
    var a = wid / 2;
    var corners = function (nd, ic) { cornersOf(nd, ic, a); };

    /* ---- the graph: interned nodes, segments between them */
    var nodeOf = new Map(), nodes = [];
    function node(p) {
      var k = vkey(p);
      if (nodeOf.has(k)) return nodeOf.get(k);
      var n = { p: [p[0], p[1]], inc: [] };
      nodeOf.set(k, n); nodes.push(n);
      return n;
    }
    var segs = [], segOf = new Map(), dropped = 0, dots = 0;
    for (var pi = 0; pi < paths.length; pi++) {
      var path = paths[pi];
      if (!path || path.length < 2) { dots++; continue; }
      for (var q = 0; q + 1 < path.length; q++) {
        var A = node(path[q]), B = node(path[q + 1]);
        if (A === B) { dropped++; continue; }         /* zero length after interning */
        var ka = vkey(A.p), kb = vkey(B.p);
        var sk = ka < kb ? ka + '|' + kb : kb + '|' + ka;
        if (segOf.has(sk)) { dropped++; continue; }   /* the same line twice */
        var d = [B.p[0] - A.p[0], B.p[1] - A.p[1]];
        var s = { A: A, B: B, L: Math.hypot(d[0], d[1]), u: unit2(d) };
        segOf.set(sk, s); segs.push(s);
        A.inc.push({ seg: s, u: s.u });               /* u points away from A */
        B.inc.push({ seg: s, u: [-s.u[0], -s.u[1]] });
      }
    }
    if (!segs.length) return { ok: false, reason: 'the paths hold no segment longer than 1e-7 mm' };

    /* ---- per node: the pad, and how far each incident line attaches out */
    var pads = [], degMax = 0, junctions = 0;
    for (var ni = 0; ni < nodes.length; ni++) {
      var nd = nodes[ni], inc = nd.inc, deg = inc.length;
      if (deg > degMax) degMax = deg;
      if (deg >= 3) junctions++;
      inc.sort(function (x, y) { return Math.atan2(x.u[1], x.u[0]) - Math.atan2(y.u[1], y.u[0]); });
      for (var e = 0; e < deg; e++) inc[e].t = 0;
      if (deg === 1) { corners(nd, inc[0]); continue; }   /* butt cap, attach at 0 */
      var wedges = [];
      for (var e2 = 0; e2 < deg; e2++) {
        var cu = inc[e2], nu = inc[(e2 + 1) % deg];
        var nA = left2(cu.u), nB = left2(nu.u);
        var rhs = [-a * (nA[0] + nB[0]), -a * (nA[1] + nB[1])];
        var den = cross2(cu.u, nu.u), t, s2;
        if (Math.abs(den) < 1e-12) {
          if (dot2(cu.u, nu.u) > 0) {
            return { ok: false, reason: 'two lines leave the same point in the same direction at ' +
              nd.p[0].toFixed(4) + ', ' + nd.p[1].toFixed(4) + ' - they would overlap' };
          }
          t = 0; s2 = 0;                              /* straight through */
        } else {
          /* t*cu.u - s*nu.u = rhs, crossed with nu.u and with cu.u in turn.
             Both denominators are `den`: cross(nu.u, cu.u) is -den, and the
             sign it carries is the one that puts the INNER wedge's mitre at
             +a and the OUTER wedge's at -a rather than the other way round. */
          t = cross2(rhs, nu.u) / den;
          s2 = cross2(rhs, cu.u) / den;
        }
        var cap = ml * a, bevel = false;
        if (t > cap || s2 > cap) { t = Math.min(t, cap); s2 = Math.min(s2, cap); bevel = true; }
        wedges.push({ i: e2, t: t, s: s2, bevel: bevel });
        if (t > cu.t) cu.t = t;
        if (s2 > nu.t) nu.t = s2;
      }
      /* the pad polygon, CCW: out along each line's right boundary to its
         attach edge, across, back in along its left boundary, then the wedge.

         Each point is tagged, because the two kinds are NOT interchangeable.
         An ATTACH point is shared, bit for bit, with the end of the quad that
         meets the pad there - move or drop one and the mesh opens. A WEDGE
         point is the pad's alone.

         When a junction's arms are exactly perpendicular the wedge point lands
         exactly ON the attach point and dedupe drops it as a duplicate. When
         they are a fraction of a degree off - which is what a junction welded
         from a thinning cluster always is (see weldNodes) - it lands a few
         microns away instead and leaves a sliver: measured on the 45 degree
         crosshatch, 776 triangles over aspect 100, the worst a 0.0037 mm edge
         against a 0.30 mm one. So a wedge point within WEDGE_SNAP of the point
         beside it is dropped, and an attach point never is. The pad then
         changes shape by at most WEDGE_SNAP, which is 2% of a line width. */
      var snap = wid * WEDGE_SNAP, e3;
      for (e3 = 0; e3 < deg; e3++) corners(nd, inc[e3]);
      /* Where the wedge between edge i and edge i+1 all but vanishes, edge i's
         LEFT corner and edge i+1's RIGHT corner are the same corner of the
         junction and miss each other only by the arms' angular error. Both are
         shared with a quad, so neither can be dropped - they are MERGED, to
         their midpoint, on the inc entries the quads read their own corners
         from. One corner, two quads, no sliver, and watertight by the same
         argument as before because there is still exactly one point. */
      for (e3 = 0; e3 < deg; e3++) {
        var A1 = inc[e3], B1 = inc[(e3 + 1) % deg];
        if (deg < 2 || Math.hypot(A1.L[0] - B1.R[0], A1.L[1] - B1.R[1]) > snap) continue;
        var mx = (A1.L[0] + B1.R[0]) / 2, my = (A1.L[1] + B1.R[1]) / 2;
        A1.L = [mx, my];
        B1.R = [mx, my];
        wedges[e3].merged = true;
      }
      var poly = [];
      for (e3 = 0; e3 < deg; e3++) {
        var ic = inc[e3], nn = left2(ic.u);
        poly.push({ p: ic.R, keep: true });
        poly.push({ p: ic.L, keep: true });
        var wg = wedges[e3], jn = inc[(e3 + 1) % deg], nj = left2(jn.u);
        if (!wg.merged) {
          poly.push({ p: [nd.p[0] + a * nn[0] + wg.t * ic.u[0], nd.p[1] + a * nn[1] + wg.t * ic.u[1]], keep: false });
          if (wg.bevel) {
            poly.push({ p: [nd.p[0] - a * nj[0] + wg.s * jn.u[0], nd.p[1] - a * nj[1] + wg.s * jn.u[1]], keep: false });
          }
        }
      }
      pads.push({ centre: nd.p, poly: dedupe(snapWedges(poly, snap)) });
    }

    /* ---- the quads, and the two things that can go wrong */
    var quads = [], tight = [], minSeg = Infinity;
    for (var si = 0; si < segs.length; si++) {
      var sg = segs[si];
      var ta = incOf(sg.A, sg).t, tb = incOf(sg.B, sg).t;
      if (sg.L < minSeg) minSeg = sg.L;
      if (ta + tb >= sg.L - 1e-9) { tight.push({ seg: sg, need: ta + tb }); continue; }
      /* the four corners the two pads published. At B the incident entry's own
         direction is -u, so its left and right are this segment's right and
         left - hence the crossed read, which is the only subtlety here. */
      var iA = incOf(sg.A, sg), iB = incOf(sg.B, sg);
      quads.push({ poly: [iA.R, iB.L, iB.R, iA.L] });
    }
    if (tight.length) {
      var t0 = tight[0].seg;
      return { ok: false, reason: tight.length + ' segment(s) are shorter than the joins at their ends need' +
        ' (shortest ' + minSeg.toFixed(4) + ' mm, the worst needs ' + tight[0].need.toFixed(4) + ' mm at ' +
        t0.A.p[0].toFixed(3) + ', ' + t0.A.p[1].toFixed(3) + ') - raise `simplify`, or lower `width`',
        tightSegments: tight.length, minSegment: minSeg };
    }

    /* ---- the faces, and the one condition the whole construction rests on */
    var faces = pads.map(function (p) { return { poly: p.poly, fan: p.centre }; })
      .concat(quads.map(function (q) { return { poly: q.poly, fan: null }; }))
      .filter(function (fc) { return fc.poly.length >= 3 && Math.abs(area2(fc.poly)) > 1e-14; });
    for (var fj = 0; fj < faces.length; fj++) {
      if (area2(faces[fj].poly) < 0) faces[fj].poly = faces[fj].poly.slice().reverse();
      faces[fj].tris = fanTris(faces[fj]);
    }
    /* Pads and quads TILE the region: they may share edges and corners, and
       their interiors must not meet. That is the whole correctness condition -
       satisfied by construction for the paths a skeleton trace produces, and
       violated by two lines that run within a line width of each other without
       meeting at a node (a hairpin whose arms fold back over themselves, a line
       ending part-way along another). Measured rather than argued, on the
       triangles themselves, as real intersection area: touching along an edge
       is 0 and correctly passes. */
    var overlaps = faceOverlaps(faces, wid);
    if (overlaps.length) {
      var o1 = overlaps[0];
      return { ok: false, reason: overlaps.length + ' pair(s) of line faces overlap by up to ' +
        o1.area.toExponential(2) + ' mm^2 near ' + o1.at[0].toFixed(3) + ', ' + o1.at[1].toFixed(3) +
        ' - two lines run within one line width of each other without meeting at a node, so the' +
        ' solid would self-intersect. Raise `simplify`, lower `width`, or split the path at the crossing.',
        overlapPairs: overlaps.length, tightSegments: tight.length, minSegment: minSeg };
    }

    /* ---- top, bottom, walls */
    var out = [];
    var edgeUse = new Map();
    var zTop = z0 + hgt;
    function P3(p, z) { return [p[0], p[1], z]; }
    function tri(p, q, r) { out.push(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2]); }
    for (var fi = 0; fi < faces.length; fi++) {
      var fc = faces[fi], poly = fc.poly, kk;
      for (kk = 0; kk < fc.tris.length; kk++) {
        var tt = fc.tris[kk];
        tri(P3(tt[0], zTop), P3(tt[1], zTop), P3(tt[2], zTop));
        tri(P3(tt[0], z0), P3(tt[2], z0), P3(tt[1], z0));
      }
      var m = poly.length;
      for (kk = 0; kk < m; kk++) {
        var e1 = poly[kk], e2v = poly[(kk + 1) % m];
        var k1 = vkey(e1), k2 = vkey(e2v);
        var ke = k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
        if (edgeUse.has(ke)) edgeUse.get(ke).n++;
        else edgeUse.set(ke, { n: 1, a: e1, b: e2v });
      }
    }
    var walls = 0, badEdges = 0;
    edgeUse.forEach(function (rec) {
      if (rec.n === 2) return;
      if (rec.n > 2) { badEdges++; return; }
      var A2 = rec.a, B2 = rec.b;
      tri(P3(A2, z0), P3(B2, z0), P3(B2, zTop));
      tri(P3(A2, z0), P3(B2, zTop), P3(A2, zTop));
      walls++;
    });
    if (badEdges) {
      return { ok: false, reason: badEdges + ' edge(s) are shared by more than two faces - the paths' +
        ' overlap in a way this builder cannot tile' };
    }
    var tris = new Float32Array(out);
    var census = edgeCensus(tris);
    return {
      ok: true, tris: tris, tris_count: (tris.length / 9) | 0,
      width: wid, height: hgt, baseZ: z0, miterLimit: ml,
      paths: paths.length, isolatedPoints: dots, droppedSegments: dropped,
      nodes: nodes.length, segments: segs.length, junctions: junctions, maxDegree: degMax,
      pads: pads.length, quads: quads.length, faces: faces.length, walls: walls,
      tightSegments: tight.length, overlapPairs: overlaps.length, minSegment: minSeg,
      lineLength: segs.reduce(function (s3, g) { return s3 + g.L; }, 0),
      extent: extentOf(tris), components: countComponents(tris),
      openEdges: census.open, nonManifoldEdges: census.nonManifold, uniqueEdges: census.edges,
      closed: census.open === 0 && census.nonManifold === 0
    };
  }

  function incOf(nd, seg) {
    for (var i = 0; i < nd.inc.length; i++) if (nd.inc[i].seg === seg) return nd.inc[i];
    return { t: 0 };
  }
  function dedupe(poly) {
    var out = [], i;
    for (i = 0; i < poly.length; i++) {
      var p = poly[i];
      if (out.length && vkey(out[out.length - 1]) === vkey(p)) continue;
      out.push(p);
    }
    while (out.length > 1 && vkey(out[0]) === vkey(out[out.length - 1])) out.pop();
    return out;
  }
  function area2(poly) {
    var s = 0;
    for (var i = 0; i < poly.length; i++) {
      var q = poly[(i + 1) % poly.length];
      s += poly[i][0] * q[1] - q[0] * poly[i][1];
    }
    return s / 2;
  }
  /* A face as triangles: a pad fans from its node, which is interior to every
     strip that meets there and so sees the whole pad; a quad fans from a
     corner, being convex. */
  function fanTris(fc) {
    var poly = fc.poly, m = poly.length, out = [], k;
    if (fc.fan) {
      for (k = 0; k < m; k++) out.push([fc.fan, poly[k], poly[(k + 1) % m]]);
    } else {
      for (k = 1; k + 1 < m; k++) out.push([poly[0], poly[k], poly[k + 1]]);
    }
    return out;
  }

  /* Pairs of faces whose interiors overlap, by real intersection area, over a
     uniform grid so this stays linear-ish in the number of faces. Triangles of
     the SAME face are skipped - a fan's own triangles share edges by
     construction - and so is a zero intersection, which is what two faces that
     merely abut produce. */
  function faceOverlaps(faces, wid) {
    var cell = Math.max(wid * 4, 1e-6), buckets = new Map(), items = [], i, k;
    for (i = 0; i < faces.length; i++) {
      var ft = faces[i].tris;
      for (k = 0; k < ft.length; k++) items.push({ f: i, t: ft[k], box: triBox(ft[k]) });
    }
    for (i = 0; i < items.length; i++) {
      var b = items[i].box;
      for (var cx = Math.floor(b[0] / cell); cx <= Math.floor(b[2] / cell); cx++) {
        for (var cy = Math.floor(b[1] / cell); cy <= Math.floor(b[3] / cell); cy++) {
          var ck = cx + ':' + cy;
          if (!buckets.has(ck)) buckets.set(ck, []);
          buckets.get(ck).push(i);
        }
      }
    }
    var seen = new Set(), out = [];
    buckets.forEach(function (list) {
      for (var x = 0; x < list.length; x++) for (var y = x + 1; y < list.length; y++) {
        var ia = list[x], ib = list[y];
        if (items[ia].f === items[ib].f) continue;
        var pk = ia < ib ? ia + '|' + ib : ib + '|' + ia;
        if (seen.has(pk)) continue;
        seen.add(pk);
        var ba = items[ia].box, bb = items[ib].box;
        if (ba[0] > bb[2] || bb[0] > ba[2] || ba[1] > bb[3] || bb[1] > ba[3]) continue;
        var cp = clipPoly(items[ia].t, items[ib].t);
        if (cp.length < 3) continue;
        var ar = Math.abs(area2(cp));
        if (ar <= 1e-12) continue;
        out.push({ area: ar, at: cp[0] });
      }
    });
    return out;
  }
  function triBox(t) {
    return [Math.min(t[0][0], t[1][0], t[2][0]), Math.min(t[0][1], t[1][1], t[2][1]),
            Math.max(t[0][0], t[1][0], t[2][0]), Math.max(t[0][1], t[1][1], t[2][1])];
  }
  /* Sutherland-Hodgman: `poly` clipped to the CCW convex `clip`. */
  function clipPoly(poly, clip) {
    var cur = poly, i, j;
    if (area2(clip) < 0) clip = clip.slice().reverse();
    if (area2(cur) < 0) cur = cur.slice().reverse();
    for (i = 0; i < clip.length && cur.length; i++) {
      var ca = clip[i], cb = clip[(i + 1) % clip.length];
      var ex = cb[0] - ca[0], ey = cb[1] - ca[1], next = [];
      for (j = 0; j < cur.length; j++) {
        var p1 = cur[j], p2 = cur[(j + 1) % cur.length];
        var s1 = ex * (p1[1] - ca[1]) - ey * (p1[0] - ca[0]);
        var s2 = ex * (p2[1] - ca[1]) - ey * (p2[0] - ca[0]);
        if (s1 >= 0) next.push(p1);
        if ((s1 > 0 && s2 < 0) || (s1 < 0 && s2 > 0)) {
          var tt = s1 / (s1 - s2);
          next.push([p1[0] + (p2[0] - p1[0]) * tt, p1[1] + (p2[1] - p1[1]) * tt]);
        }
      }
      cur = next;
    }
    return cur;
  }
  function extentOf(soup) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], i, k;
    for (i = 0; i < soup.length; i += 3) for (k = 0; k < 3; k++) {
      if (soup[i + k] < lo[k]) lo[k] = soup[i + k];
      if (soup[i + k] > hi[k]) hi[k] = soup[i + k];
    }
    return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  }
  /* The soup's own edge census - every edge of a closed manifold is used by
     exactly two triangles. MEASURED here rather than claimed, so `closed` in
     the report is a number and not a promise; mesh_validate.py remains the
     authority, and the checks run it on everything this builds. */
  function edgeCensus(soup) {
    var n = (soup.length / 9) | 0, count = new Map(), i, e;
    function vk(t, k) {
      var o = t * 9 + k * 3;
      return Math.round(soup[o] * 1e4) + '_' + Math.round(soup[o + 1] * 1e4) + '_' + Math.round(soup[o + 2] * 1e4);
    }
    for (i = 0; i < n; i++) {
      var k3 = [vk(i, 0), vk(i, 1), vk(i, 2)];
      for (e = 0; e < 3; e++) {
        var a = k3[e], b = k3[(e + 1) % 3];
        if (a === b) continue;
        var ek = a < b ? a + '|' + b : b + '|' + a;
        count.set(ek, (count.get(ek) || 0) + 1);
      }
    }
    var open = 0, nm = 0;
    count.forEach(function (c) { if (c === 1) open++; else if (c > 2) nm++; });
    return { open: open, nonManifold: nm, edges: count.size };
  }

  /* edge-connected components - the same union-find nso_skin_patch.js uses */
  function countComponents(soup) {
    var n = (soup.length / 9) | 0, parent = new Array(n), i;
    for (i = 0; i < n; i++) parent[i] = i;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function vk(t, k) {
      var o = t * 9 + k * 3;
      return Math.round(soup[o] * 1e4) + '_' + Math.round(soup[o + 1] * 1e4) + '_' + Math.round(soup[o + 2] * 1e4);
    }
    var owner = new Map();
    for (i = 0; i < n; i++) {
      var k3 = [vk(i, 0), vk(i, 1), vk(i, 2)];
      for (var e = 0; e < 3; e++) {
        var A = k3[e], B = k3[(e + 1) % 3], ek = A < B ? A + '|' + B : B + '|' + A;
        if (owner.has(ek)) { var r1 = find(owner.get(ek)), r2 = find(i); if (r1 !== r2) parent[r1] = r2; }
        else owner.set(ek, i);
      }
    }
    var roots = new Set();
    for (i = 0; i < n; i++) roots.add(find(i));
    return roots.size;
  }

  /* --------------------------------------------------------- the whole run */

  /* buildFromImage(image, opts) -> { ok, tris, ... } - never a half result.
     Scale, in order of precedence:
       mmPerPixel        explicit
       widthMM           the image's full pixel width becomes this many mm
     with widthMM defaulting to nothing and mmPerPixel to 0.1 mm/px, which is
     the only figure here that is a convenience rather than a measurement and
     is reported back so it cannot be mistaken for one.
     Y is FLIPPED: an image's first row is its top, and +Y is up in the plate. */
  function buildFromImage(image, opts) {
    var o = opts || {};
    var mask = toMask(image, o);
    if (typeof mask === 'string') return { ok: false, reason: mask };
    if (!mask.ink) return { ok: false, reason: 'no ink: every pixel is on the ' +
      (o.invert ? 'dark' : 'light') + ' side of threshold ' + mask.threshold };
    var sk = thin(mask);
    if (!sk.ink) return { ok: false, reason: 'thinning left nothing - the ink is ' + mask.ink + ' pixel(s)' };
    var px = tracePaths(sk);
    if (!px.length) return { ok: false, reason: 'the skeleton traced no path' };
    var scale = o.mmPerPixel != null ? o.mmPerPixel
      : (o.widthMM != null ? o.widthMM / mask.w : 0.1);
    if (!(scale > 0)) return { ok: false, reason: 'the scale must be positive' };
    var simpPx = o.simplify == null ? 1.0 : o.simplify;   /* pixels */
    /* the shortest segment the section can carry; the line width is the
       natural figure and nothing smaller is meaningful - see collapseShort */
    var minSeg = o.minSegment == null ? (o.width == null ? LINE_WIDTH : o.width) : o.minSegment;
    var H = mask.h;
    var paths = [], vertsIn = 0, vertsOut = 0;
    for (var i = 0; i < px.length; i++) {
      var p = px[i];
      vertsIn += p.length;
      if (p.length < 2) continue;
      var mm = simplify(p, simpPx).map(function (q) { return [q[0] * scale, (H - q[1]) * scale]; });
      var s = dropCollinear(collapseShort(mm, minSeg));
      if (s.length < 2) continue;
      vertsOut += s.length;
      paths.push(s);
    }
    if (!paths.length) return { ok: false, reason: 'every traced path was a single point' };
    /* the graph-level pass: junction clusters a diagonal crossing leaves behind
       (see weldNodes), then the per-path cleanup again, because welding moves
       endpoints and can leave a short first or last segment behind it */
    var beforeWeld = paths.length;
    paths = weldNodes(paths, minSeg);
    var afterWeld = paths.length;
    /* then the bridges weldNodes cannot reach - see collapseBridges. The ruler
       is the DRAWN stroke width, measured: ink pixels over skeleton pixels is
       the stroke's mean width in pixels. BRIDGE_STROKES of those is the bound
       for a crossing down to about 24 degrees, and the degree gate - a
       junction at BOTH ends - is what keeps it off real line ends. */
    var strokePx = sk.ink > 0 ? mask.ink / sk.ink : 0;
    var bridge = o.bridge != null ? o.bridge : BRIDGE_STROKES * strokePx * scale;
    paths = collapseBridges(paths, bridge);
    var afterBridge = paths.length;
    paths = paths.map(function (q) {
      return dropCollinear(collapseShort(q, minSeg));
    }).filter(function (q) { return q.length >= 2; });
    if (!paths.length) return { ok: false, reason: 'welding the junction clusters left no path' };
    var r = extrudeFlat(paths, o);
    if (!r.ok) return r;
    r.image = { w: mask.w, h: mask.h, inkPixels: mask.ink, skeletonPixels: sk.ink,
      threshold: mask.threshold, invert: mask.invert, thinningPasses: sk.passes };
    r.mmPerPixel = scale;
    r.simplifyPx = simpPx;
    r.minSegmentAsked = minSeg;
    r.tracedPaths = px.length;
    r.traceVertices = vertsIn;
    r.pathVertices = vertsOut;
    r.weldedPaths = beforeWeld - afterWeld;      /* stubs the node weld removed */
    r.bridgedPaths = afterWeld - afterBridge;    /* crossing bridges collapsed after it */
    /* both reported, because both are conveniences derived from the picture
       rather than figures the caller gave, and neither may be mistaken for one */
    r.strokePx = strokePx;
    r.bridgeAsked = bridge;
    r.describe = 'flat lines ' + r.width + ' mm wide x ' + r.height + ' mm tall from a ' +
      mask.w + ' x ' + mask.h + ' raster at ' + scale + ' mm/px - ' + r.paths + ' path(s), ' +
      r.segments + ' segment(s), ' + r.junctions + ' junction(s), ' +
      r.lineLength.toFixed(2) + ' mm of line, ' +
      r.extent.map(function (x) { return x.toFixed(2); }).join(' x ') + ' mm, ' +
      r.components + ' component(s), ' + (r.closed ? 'closed' : r.openEdges + ' OPEN edge(s)');
    return r;
  }

  var api = {
    LINE_HEIGHT: LINE_HEIGHT, LINE_WIDTH: LINE_WIDTH, LINE_WIDTH_MAX: LINE_WIDTH_MAX,
    MITER_LIMIT: MITER_LIMIT, BRIDGE_STROKES: BRIDGE_STROKES,
    toMask: toMask, thin: thin, tracePaths: tracePaths,
    simplify: simplify, collapseShort: collapseShort, weldNodes: weldNodes,
    dropCollinear: dropCollinear, collapseBridges: collapseBridges,
    extrudeFlat: extrudeFlat, buildFromImage: buildFromImage,
    extentOf: extentOf, countComponents: countComponents, edgeCensus: edgeCensus
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_RasterLines = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
