/* nso_crosshatch.js - a crosshatch breakaway interface built the way a printer
   builds one: ONE direction of lines per layer, two layers, the upper turned
   across the lower.

   Loads as a classic script (window.NSO_Crosshatch) and as a Node module
   (require('../nso_crosshatch.js')). Pure geometry on top of
   nso_raster_lines.js: no DOM, no Three.js, a mesh is the app's raw soup
   (9 numbers per triangle, Z up, millimetres).

   ---------------------------------------------------------------------------
   THE DEFECT THIS EXISTS TO FIX, AND THE NUMBER
   ---------------------------------------------------------------------------
   `nso_skin.js`'s `crosshatch` is a RIB LATTICE: one layer that already runs
   ribs along BOTH in-plane axes. That is the right shape for a relief standing
   on a face whose mating piece is a flat plate - the contact is the lattice's
   tip area and `NSO_Skin.tipContactArea` measures it correctly.

   It is the wrong shape for a two-layer breakaway interface, and
   `tools/nso_raster_line_audit.js` measured how wrong. Stack the shipped loose
   crosshatch patch and turn the upper copy 90 degrees across the lower - how
   Bambu builds an interface - and the upper copy's underside is THE SAME
   LATTICE as the tips beneath it. The two coincide instead of crossing:

       519.750 mm^2 in ONE patch spanning the entire 30 x 30 footprint
       = 100.0% of the tip area, 2947 crossings' worth of bonding in one weld

   A rotation by 90 degrees maps the lattice onto itself, so there is no angle
   at which a bidirectional layer crosses a bidirectional layer. The fault is
   not the section (the ribs are prismatic - 0.42 mm top and bottom, asserted
   in the audit) and it is not the pitch. It is that a printed LAYER runs lines
   in ONE direction and gets its crossing from the NEXT layer.

   So this module builds the interface as what it is: two layers, each a single
   direction, the second crossing the first. At the shipped 1.2 mm pitch on the
   same footprint:

       110.2500 mm^2 in 625 isolated patches, every one exactly 0.176400 mm^2
       (= width x width), none spanning more than one line width's diagonal

   ---------------------------------------------------------------------------
   THE SECTION IS THE RASTER TRACER'S, NOT A NEW ONE
   ---------------------------------------------------------------------------
   The lines are built by `NSO_RasterLines.extrudeFlat`, unchanged - the planar
   subdivision that gives a flat printed line's real section (`width` at the
   underside and `width` at the top, `height` tall) and makes a 4-way crossing's
   pad exactly the width x width square. docs/RASTER-LINES.md carries why that
   is a planar subdivision and not one prism per line.

   What is NOT reused is the raster round trip. `extrudeFlat` takes polylines,
   and a crosshatch's centrelines are known exactly from three numbers, so
   drawing them into a picture and thinning it back to a skeleton would only add
   Zhang-Suen's chamfers and junction clusters to a path that was already exact.
   The round trip is still MEASURED - tools/nso_crosshatch_test.js part 6 strokes
   this module's own paths into a raster, traces them back and compares - because
   "the two agree" is worth knowing and is the answer to whether re-tiling needs
   a raster at all. It does not.

   ---------------------------------------------------------------------------
   THE LAYOUT, AND WHY THE SPAN IS QUANTISED
   ---------------------------------------------------------------------------
   One layer is a boustrophedon: up the first line, a turn across to the second,
   down that one, and so on - one continuous path, which is what a slicer emits
   and what makes a layer one component.

       line centres   c_k = width/2 + turnOffset + k * pitch,  k = 0 .. repeats-1
       end turns      at width/2 and span - width/2
       span           (repeats - 1) * pitch + 2 * turnOffset + width
                      = repeats * pitch + width   at the default turnOffset

   `c_k` DOES NOT DEPEND ON `repeats`. Adding a repeat appends a line; it never
   moves one that is already there, and pitch, width and the open channel
   (pitch - width) are bit-identical at every size. That is the whole of
   re-tiling - see `fitRepeats` - and it is why a target span is a target: the
   achievable spans step by one pitch and there is nothing between them. The
   residual is reported, never absorbed by stretching the pattern.

   THE END TURN'S OFFSET IS HALF A PITCH, and that is a measurement, not a
   taste. A boustrophedon's turn is a rail that runs ACROSS its own layer's
   lines, so in the layer above it lies PARALLEL to that layer's lines; within
   one line width of them the interface bonds along the rail instead of at a
   point (docs/RASTER-LINES.md, "one finding about the path"). Half a pitch puts
   the turn in the middle of the channel the other layer leaves, so the
   clearance is turnOffset - width = pitch/2 - width, and `plan` REFUSES an
   offset that does not leave one:

       pitch 1.2, width 0.42   clearance 0.18 mm   built
       pitch 1.2, width 0.61   clearance -0.01     refused by name
       pitch 0.84 (fine), 0.42 clearance 0.00      refused by name

   `ends: 'open'` is the way out and is the honest one: the lines are left as
   separate parallel lines with no turns at all, which is several components and
   is REPORTED rather than hidden - the same call `nso_skin_patch.js` makes for a
   zigzag patch with `ties: 0`. The contact is identical either way (measured:
   the same 625 patches of the same 0.176400 mm^2), because the turns are placed
   exactly where they touch nothing.

   ---------------------------------------------------------------------------
   THE ANGLE
   ---------------------------------------------------------------------------
   A slicer prints an interface layer at 45 degrees to the part's axes and the
   next at 135, which is where the 90 between them comes from. `angle` names the
   angle LAYER 1's LINES RUN AT, not the rotation applied - the same convention
   and the same reason as `tools/nso_raster_fixtures.js`'s `ANGLE`, where naming
   the rotation instead once put the lines on the wrong diagonal. The pattern is
   laid out in its own span x span frame and TURNED RIGIDLY as a whole, so every
   contact figure is invariant under `angle` and the test asserts that equality
   rather than assuming it.

   ---------------------------------------------------------------------------
   THE GUARD: ONE DIRECTION PER LAYER, CHECKED RATHER THAN INTENDED
   ---------------------------------------------------------------------------
   `directionCensus` histograms a layer's segment directions by LENGTH, and
   `build` refuses a layer whose second direction family carries more than
   `maxCrossShare` (default 0.25) of the line length. A boustrophedon's turns are
   3.7% of it. A bidirectional lattice - the defect - is 50%, so the old
   crosshatch handed to this guard is refused by name. The guard is on the paths,
   so it fires before any geometry is built, and it is exported so a check can
   feed it the defect directly.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   NSO_Crosshatch.DEFAULTS
   NSO_Crosshatch.spanFor(repeats, pitch, width, turnOffset)   -> mm
   NSO_Crosshatch.fitRepeats(targetSpan, pitch, width, mode, turnOffset)
        mode 'nearest' (default) | 'down' | 'up'        -> { repeats, span, residual, ... }
   NSO_Crosshatch.plan(opts)                            -> plan | reason string
   NSO_Crosshatch.layerPaths(plan, which)               -> [[ [x,y], ... ], ...]
   NSO_Crosshatch.directionCensus(paths)                -> { families, crossShare, ... }
   NSO_Crosshatch.oneDirection(paths, maxCrossShare)    -> null, or the refusal
   NSO_Crosshatch.build(opts)                           -> { ok, reason?, tris, layers, ... }
   NSO_Crosshatch.retile(opts, { W, D, fit })           -> build() at a new span

   SCOPE, explicitly: geometry only, and NOT wired into the app's UI - the same
   scope line the raster importer ships under. The interface is TWO closed
   shells touching at z = height, which is what two stacked pieces are; a caller
   that wants one object takes one layer.
*/
(function (root) {
  'use strict';

  var RL = (typeof module !== 'undefined' && module.exports)
    ? require('./nso_raster_lines.js')
    : (root && root.NSO_RasterLines);

  /* The measured printed line, from the importer's own defaults - not restated
     here, so there is one place for them to change. */
  var LINE_WIDTH = RL ? RL.LINE_WIDTH : 0.42;
  var LINE_HEIGHT = RL ? RL.LINE_HEIGHT : 0.3;
  /* NSO_Skin.PATTERNS.crosshatch.defaults.pitch - the shipped crosshatch's own
     figure, so the fixed version is the same pattern at the same numbers and
     the comparison in the audit is like for like. Asserted equal to it in
     tools/nso_crosshatch_test.js rather than kept in step by hand. */
  var PITCH = 1.2;
  var ANGLE = 45;        /* degrees the LINES of layer 1 run at */

  var DEFAULTS = {
    W: 30, D: 30,        /* target footprint, mm - quantised to whole repeats */
    pitch: PITCH,
    width: LINE_WIDTH,
    height: LINE_HEIGHT,
    angle: ANGLE,
    ends: 'turn',        /* 'turn' = boustrophedon, 'open' = separate lines */
    turnOffset: null,    /* how far the end turn sits from the outermost line;
                            null = pitch/2, the middle of the other layer's
                            channel. A parameter so the constraint below can be
                            MEASURED rather than asserted - see the test. */
    fit: 'nearest',      /* how a target span is snapped: nearest | down | up */
    baseZ: 0,
    maxCrossShare: 0.25, /* the one-direction guard, see the header */
    /* A CONTROL, not a printable proposal: it builds the end-turn weld the
       clearance rule exists to prevent, so the rule can be measured rather than
       asserted. tools/nso_crosshatch_test.js part 5 is the only caller. */
    allowWeldingTurns: false
  };

  function round6(x) { return Math.round(x * 1e6) / 1e6; }

  /* ----------------------------------------------------------- re-tiling */

  /* The span `repeats` lines occupy: the outermost centres are half a pitch
     inside the two end turns, and each end turn adds its own half width. */
  function spanFor(repeats, pitch, width, turnOffset) {
    var off = turnOffset == null ? pitch / 2 : turnOffset;
    return (repeats - 1) * pitch + 2 * off + width;
  }

  /* Whole repeats only. `residual` is what the target asked for and the tiling
     cannot give - reported, never taken out of the pitch. */
  function fitRepeats(targetSpan, pitch, width, mode, turnOffset) {
    var off = turnOffset == null ? pitch / 2 : turnOffset;
    var exact = (targetSpan - width - 2 * off) / pitch + 1;
    var r;
    if (mode === 'down') r = Math.floor(exact + 1e-9);
    else if (mode === 'up') r = Math.ceil(exact - 1e-9);
    else r = Math.round(exact);
    if (!(r >= 1)) r = 1;
    var span = spanFor(r, pitch, width, off);
    return {
      repeats: r, span: span, spanAsked: targetSpan,
      residual: span - targetSpan, exactRepeats: exact,
      quantum: pitch, mode: mode || 'nearest'
    };
  }

  /* ---------------------------------------------------------- the layout */

  function withDefaults(opts) {
    var o = {}, k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) o[k] = DEFAULTS[k];
    if (opts) for (k in opts) if (Object.prototype.hasOwnProperty.call(opts, k) && opts[k] != null) o[k] = opts[k];
    return o;
  }

  /* A plan, or a reason string - the refusal convention nso_skin.js uses. */
  function plan(opts) {
    var o = withDefaults(opts);
    if (!RL) return 'NSO_RasterLines not loaded';
    if (!(o.width > 0)) return 'the line width must be positive';
    if (!(o.height > 0)) return 'the line height must be positive';
    if (!(o.pitch > o.width)) {
      return 'pitch ' + o.pitch + ' mm does not clear the ' + o.width + ' mm line - neighbouring ' +
        'lines would touch and the layer would be solid, not a lattice';
    }
    if (o.ends !== 'turn' && o.ends !== 'open') {
      return 'ends must be "turn" (a boustrophedon) or "open" (separate lines), not "' + o.ends + '"';
    }
    if (!(o.W > 0) || !(o.D > 0)) return 'the footprint must be positive';
    /* THE END TURN'S CLEARANCE. The turn runs across its own layer's lines, so
       in the other layer it is PARALLEL to that layer's lines; half a pitch is
       where the other layer's channel is, and the clearance left is
       turnOffset - width. At or below zero the two bond along the turn's whole
       length instead of at a point - measured, docs/RASTER-LINES.md. With
       ends: 'open' there is no turn to weld, but the offset still sets where
       the outermost line sits inside the span, so it is honoured either way. */
    var turnOffset = o.turnOffset == null ? o.pitch / 2 : o.turnOffset;
    if (!(turnOffset > 0)) return 'the end turn offset must be positive';
    var fu = fitRepeats(o.W, o.pitch, o.width, o.fit, turnOffset);
    var fv = fitRepeats(o.D, o.pitch, o.width, o.fit, turnOffset);
    var clearance = turnOffset - o.width;
    if (o.ends === 'turn' && !(clearance > 0) && !o.allowWeldingTurns) {
      return 'end turns at ' + round6(turnOffset) + ' mm from the outermost line do not clear the ' + o.width +
        ' mm line of the layer above: clearance ' + round6(clearance) + ' mm. A turn lying within one ' +
        'line width of the other layer\'s lines welds along its whole length. Raise the pitch above ' +
        round6(2 * o.width) + ' mm, or use ends: "open" and accept separate lines.';
    }
    if (fu.repeats < 1 || fv.repeats < 1) {
      return 'no full repeat fits a ' + o.W + ' x ' + o.D + ' mm footprint at pitch ' + o.pitch;
    }
    var half = o.width / 2;
    function centres(n) {
      var c = [], i;
      for (i = 0; i < n; i++) c.push(half + turnOffset + i * o.pitch);
      return c;
    }
    return {
      pitch: o.pitch, width: o.width, height: o.height, channel: round6(o.pitch - o.width),
      angle: o.angle, ends: o.ends, baseZ: o.baseZ, maxCrossShare: o.maxCrossShare,
      repeatsU: fu.repeats, repeatsV: fv.repeats,
      spanU: fu.span, spanV: fv.span,
      spanAskedU: o.W, spanAskedV: o.D,
      residualU: round6(fu.residual), residualV: round6(fv.residual),
      fit: o.fit, quantum: o.pitch,
      /* layer 1's lines run along V at these U offsets; layer 2's along U at
         these V offsets. Neither list depends on the OTHER axis' repeat count,
         and neither depends on its own - see the header. */
      centresU: centres(fu.repeats), centresV: centres(fv.repeats),
      turnLo: half, turnHiU: fu.span - half, turnHiV: fv.span - half,
      turnOffset: round6(turnOffset), turnClearance: round6(clearance),
      crossings: fu.repeats * fv.repeats,
      contactPerCrossing: round6(o.width * o.width),
      contactPredicted: round6(fu.repeats * fv.repeats * o.width * o.width),
      interfaceZ: o.baseZ + o.height,
      totalHeight: 2 * o.height
    };
  }

  /* The rigid turn that puts layer 1's lines at `angle`. The shapes below are
     laid out with layer 1's lines along +V (90 degrees), so the rotation is
     angle - 90 and layer 2's lines, along +U, land at angle + 90. */
  function turnPaths(paths, pl) {
    var th = (pl.angle - 90) * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
    var cx = pl.spanU / 2, cy = pl.spanV / 2;
    return paths.map(function (path) {
      return path.map(function (q) {
        var x = q[0] - cx, y = q[1] - cy;
        return [x * c - y * s + cx, x * s + y * c + cy];
      });
    });
  }

  /* One layer's centrelines, in millimetres, already turned.
     which 1: lines along V, tiled across U.  which 2: the other way. */
  function layerPaths(pl, which) {
    var alongV = which !== 2;
    var cs = alongV ? pl.centresU : pl.centresV;
    var lo = pl.turnLo, hi = alongV ? pl.turnHiV : pl.turnHiU;
    var paths = [], k;
    if (pl.ends === 'open') {
      for (k = 0; k < cs.length; k++) {
        paths.push(alongV ? [[cs[k], lo], [cs[k], hi]] : [[lo, cs[k]], [hi, cs[k]]]);
      }
    } else {
      /* one continuous boustrophedon, which is what a slicer emits */
      var pts = [];
      for (k = 0; k < cs.length; k++) {
        var a = (k % 2 === 0) ? lo : hi, b = (k % 2 === 0) ? hi : lo;
        pts.push(alongV ? [cs[k], a] : [a, cs[k]]);
        pts.push(alongV ? [cs[k], b] : [b, cs[k]]);
      }
      paths.push(pts);
    }
    return turnPaths(paths, pl);
  }

  /* ------------------------------------------------- the one-direction guard

     Segment directions, undirected (a line at 200 degrees is a line at 20),
     binned to a degree and weighted by LENGTH - a direction's share of the line
     is what matters, not how many segments carry it. The same weighting
     tools/nso_line_angle.js uses on the mesh; this one is on the paths, so it
     can refuse before anything is built. */
  function directionCensus(paths, binDeg) {
    var bin = binDeg == null ? 1 : binDeg;
    var acc = new Map(), total = 0, i, k;
    for (i = 0; i < paths.length; i++) {
      var p = paths[i];
      for (k = 0; k + 1 < p.length; k++) {
        var dx = p[k + 1][0] - p[k][0], dy = p[k + 1][1] - p[k][1];
        var L = Math.sqrt(dx * dx + dy * dy);
        if (!(L > 1e-9)) continue;
        var deg = Math.atan2(dy, dx) * 180 / Math.PI;
        deg = ((deg % 180) + 180) % 180;
        var key = Math.round(deg / bin) * bin % 180;
        acc.set(key, (acc.get(key) || 0) + L);
        total += L;
      }
    }
    var families = Array.from(acc.entries())
      .map(function (e) { return { deg: e[0], length: e[1], share: total > 0 ? e[1] / total : 0 }; })
      .sort(function (a, b) { return b.length - a.length; });
    /* the cross family is what runs across the dominant one; everything that is
       neither is counted too, so an oblique third family cannot hide */
    var dom = families.length ? families[0].deg : 0;
    var crossLen = 0, otherLen = 0;
    for (i = 0; i < families.length; i++) {
      if (families[i].deg === dom) continue;
      var d = Math.abs(((families[i].deg - dom) % 180 + 180) % 180 - 90);
      if (d <= bin) crossLen += families[i].length; else otherLen += families[i].length;
    }
    return {
      families: families, total: total,
      dominant: dom, dominantShare: families.length ? families[0].share : 0,
      crossLength: crossLen, crossShare: total > 0 ? crossLen / total : 0,
      obliqueLength: otherLen, obliqueShare: total > 0 ? otherLen / total : 0
    };
  }

  /* The guard as its own entry point, so a caller building a layer by hand can
     ask the same question `build` asks. Returns null when the layer is
     single-direction, or the reason string when it is not. */
  function oneDirection(paths, maxCrossShare) {
    return crossRefusal(directionCensus(paths), maxCrossShare);
  }

  /* the same verdict on a census already taken, so `build` measures once */
  function crossRefusal(census, maxCrossShare) {
    var max = maxCrossShare == null ? DEFAULTS.maxCrossShare : maxCrossShare;
    if (census.crossShare <= max + 1e-12) return null;
    return 'this layer runs lines in TWO directions: ' +
      (census.dominantShare * 100).toFixed(1) + '% at ' + census.dominant + ' deg and ' +
      (census.crossShare * 100).toFixed(1) + '% across it, over the ' + (max * 100) +
      '% a layer\'s end turns may take. A layer that already crosses itself cannot be crossed ' +
      'by the layer above - a 90 degree copy maps the lattice onto itself and the interface welds ' +
      'over its whole footprint (measured: 519.750 mm^2 in ONE patch, tools/nso_raster_line_audit.js). ' +
      'A printed layer runs lines in one direction and gets its crossing from the next layer.';
  }

  /* ------------------------------------------------------------- building */

  function build(opts) {
    var pl = plan(opts);
    if (typeof pl === 'string') return { ok: false, reason: pl };
    var out = [], layers = [], which, total = 0;
    for (which = 1; which <= 2; which++) {
      var paths = layerPaths(pl, which);
      var census = directionCensus(paths);
      /* THE GUARD. A printed layer runs lines in one direction; its turns are a
         few percent of the line. A bidirectional lattice is half and half, and
         that is the defect this module exists to fix, so it is refused here
         rather than measured later. */
      var bad = crossRefusal(census, pl.maxCrossShare);
      if (bad) return { ok: false, reason: 'layer ' + which + ': ' + bad, census: census };
      var r = RL.extrudeFlat(paths, {
        width: pl.width, height: pl.height,
        baseZ: pl.baseZ + (which === 1 ? 0 : pl.height)
      });
      if (!r.ok) return { ok: false, reason: 'layer ' + which + ': ' + r.reason, layer: r };
      r.census = census;
      r.lineDirection = census.dominant;
      layers.push(r);
      out.push(r.tris);
      total += r.tris.length;
    }
    var tris = new Float32Array(total);
    for (var oi = 0, at = 0; oi < out.length; oi++) { tris.set(out[oi], at); at += out[oi].length; }
    var res = {
      ok: true, tris: tris, tris_count: (tris.length / 9) | 0,
      plan: pl, layers: layers,
      pitch: pl.pitch, width: pl.width, height: pl.height, channel: pl.channel,
      angle: pl.angle, ends: pl.ends,
      repeatsU: pl.repeatsU, repeatsV: pl.repeatsV,
      spanU: pl.spanU, spanV: pl.spanV,
      spanAskedU: pl.spanAskedU, spanAskedV: pl.spanAskedV,
      residualU: pl.residualU, residualV: pl.residualV,
      centresU: pl.centresU.slice(), centresV: pl.centresV.slice(),
      crossings: pl.crossings,
      contactPerCrossing: pl.contactPerCrossing,
      contactPredicted: pl.contactPredicted,
      interfaceZ: pl.interfaceZ, totalHeight: pl.totalHeight,
      extent: RL.extentOf(tris),
      shells: 2,
      components: layers[0].components + layers[1].components,
      closed: layers[0].closed && layers[1].closed,
      openEdges: layers[0].openEdges + layers[1].openEdges,
      nonManifoldEdges: layers[0].nonManifoldEdges + layers[1].nonManifoldEdges,
      /* a free-standing one-extrusion-line lattice is docs/NON-SOLID.md's
         printable-fabric case, and two shells is not one closed solid - the
         same call nso_skin_patch.js's loose variant makes */
      nonSolidAdvised: true
    };
    res.describe = 'crosshatch interface, two layers of ' + pl.width + ' x ' + pl.height +
      ' mm flat lines at ' + pl.pitch + ' mm pitch (' + pl.channel + ' mm channel), lines at ' +
      pl.angle + ' and ' + ((pl.angle + 90) % 180) + ' deg - ' +
      pl.repeatsU + ' x ' + pl.repeatsV + ' lines over ' +
      pl.spanU.toFixed(2) + ' x ' + pl.spanV.toFixed(2) + ' mm, ' +
      pl.crossings + ' crossings of ' + pl.contactPerCrossing.toFixed(6) + ' mm^2 = ' +
      pl.contactPredicted.toFixed(4) + ' mm^2, ' + res.tris_count + ' tris in ' +
      res.shells + ' shell(s), ' + (res.closed ? 'closed' : res.openEdges + ' OPEN edge(s)');
    return res;
  }

  /* Re-tile to a new footprint: the SAME pitch, width, height and channel, a
     different number of whole repeats. Not a scale - `build` lays the centres
     out from the pitch alone, so every line the old size had is in the same
     place in the new one. */
  function retile(opts, target) {
    var t = target || {};
    var o = withDefaults(opts);
    if (t.W != null) o.W = t.W;
    if (t.D != null) o.D = t.D;
    if (t.fit != null) o.fit = t.fit;
    return build(o);
  }

  var api = {
    LINE_WIDTH: LINE_WIDTH, LINE_HEIGHT: LINE_HEIGHT, PITCH: PITCH, ANGLE: ANGLE,
    DEFAULTS: DEFAULTS,
    spanFor: spanFor, fitRepeats: fitRepeats,
    plan: plan, layerPaths: layerPaths,
    directionCensus: directionCensus, oneDirection: oneDirection,
    build: build, retile: retile
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_Crosshatch = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
