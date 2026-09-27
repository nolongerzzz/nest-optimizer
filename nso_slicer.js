/*
 * NSO in-house slicer - real layer-by-layer slicing, for reverse-engineering
 * and internal iteration.
 * ----------------------------------------------------------------------------
 *
 * READ docs/SLICER.md FIRST. It carries the library audit (Task 1), the
 * measurement every rule below is taken from, and the validation against real
 * Bambu Studio slices - agreement AND disagreement.
 *
 * A genuine slicer whose layers, walls, infill and overhang calls can be read
 * line by line in G-scope, and measured against a real slice.
 *
 * THE PIPELINE, and who does each step
 *
 *   1. layers     slicePlanes()     - print_z / slice_z per layer, the
 *                                     classic scheme (slice at mid-layer).
 *   2. sections   sliceMesh()       - EXACT triangle/plane intersection, in
 *                                     this file. Segments are chained by the
 *                                     mesh EDGE they cross, not by float
 *                                     proximity, so a closed mesh yields
 *                                     closed loops with no tolerance at all;
 *                                     orientation comes from each triangle's
 *                                     winding. A mesh that is not closed is
 *                                     still sliced: its open chains are joined
 *                                     end to end within `gapCloseMm` and the
 *                                     count is reported, never hidden.
 *   3. regions    Clipper2          - the loops are filled with the Positive
 *                                     rule and every offset / union /
 *                                     difference / intersection after that is
 *                                     Clipper2 (Boost licence), reached
 *                                     through the manifold-3d build this repo
 *                                     already vendors (vendor/manifold/,
 *                                     Apache-2.0), as `wasm.CrossSection`.
 *   4. walls      perimeters()      - offset inward by MEASURED line widths.
 *   5. shells     classify()        - top / bottom solid layers by region
 *                                     booleans against the layers above and
 *                                     below; bridges; sparse interior.
 *   6. infill     scanFill() +      - genuine scanline clipping of a line
 *                 connect()           family against the region, then a
 *                                     zig-zag connection along the boundary.
 *                                     'grid' is two families per layer,
 *                                     'zigzag' / 'lines' one family alternating.
 *   7. overhang   overhangs()       - per-layer geometry: this layer's section
 *                                     minus the layer below grown by the
 *                                     printable step h / tan(threshold). It
 *                                     shares nothing with
 *                                     NSO_SupportAim.detectOverhangs (facet
 *                                     normals + a downward ray), which is the
 *                                     point: the two can be compared.
 *   8. G-code     toGcode()         - Bambu-style tags (; CHANGE_LAYER,
 *                                     ; Z_HEIGHT, ; LAYER_HEIGHT, ; FEATURE),
 *                                     E from the stadium flow model that
 *                                     nso-gcode-lines.js inverts, so the
 *                                     result goes through parseGcode() and into
 *                                     G-scope exactly as an imported
 *                                     .gcode.3mf does.
 *
 * FRAME. Soups are the app's raw convention: 9 floats per triangle, Z up,
 * millimetres. Objects are dropped onto the plate together (one shift, their
 * relative placement kept) unless `dropToPlate: false`.
 *
 * API
 *   CONSTANTS                          the measured defaults, each with its source
 *   defaultsFor(nozzleMm, opts)        -> full options for a nozzle
 *   slicePlanes(zMin, zMax, opts)      -> [{ index, printZ, sliceZ, h }]
 *   sliceMesh(soup, planes, opts)      -> per-plane { loops, openChains, ... } (pure JS)
 *   geometry(wasm)                     -> the Clipper2 adapter (arena-managed)
 *   sliceObjects(objects, opts, wasm)  -> { ok, reason, layers, objects, overhang, gcode, report }
 *   run(objects, opts)                 -> Promise of the same, loading the kernel itself
 *   toGcode(result, opts)              -> string
 *   scanFill(polys, angleRad, spacing, phase) -> segments (pure JS)
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSO_Slicer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // ===========================================================================
  // Task 6 - the measured constants, each cited to where it was measured.
  // ===========================================================================
  //
  // Nothing here is a generic slicer default. A value is either measured off a
  // real file in this repo (and re-measured by a check on every run), or it is
  // a figure this repo already locked in and cites. `source` says which.

  var LINE_RATIO = 1.05;

  var CONSTANTS = {
    // --- line widths ---------------------------------------------------------
    wallWidth: {
      ratio: LINE_RATIO,
      at04: 0.42, at06: 0.63,
      source: 'nso_thickness.js floorFor(): one extrusion line = 1.05 x nozzle - ' +
              '0.42 mm at a 0.4 nozzle, 0.63 mm at 0.6 (tools/nso_wall_thickness_test.js pins both; ' +
              'docs/WALL-THICKNESS.md, docs/SKIN-CROSSHATCH-PITCH.md)'
    },
    // What real Bambu Studio set and printed at the 0.6 nozzle, for comparison.
    bambuLine06: {
      settingMm: 0.62, recoveredMm: 0.609,
      source: 'fixtures/3mf/tabletop.gcode.3mf and supportwithinsupport.gcode.3mf, the user\'s ' +
              'own Bambu slices: line_width = 0.62 in the config block; 0.609 mm is the width ' +
              'recovered from each wall move\'s own E (nso-gcode-lines.js widthFromExtrusion). ' +
              'tools/nso_slicer_bambu_check.js re-measures both'
    },
    // --- the classic perimeter / infill geometry, measured on a real slice ---
    // All four were measured on supportwithinsupport.gcode.3mf's lower block,
    // whose 30.000 x 30.000 mm footprint is known independently of the
    // toolpath (Metadata/plate_1.json bbox_objects). docs/SLICER.md, section 3.
    perimeterRule: {
      outerInsetIsHalfWidth: true,        // measured 0.3096 mm at w 0.62 (w/2 = 0.310)
      spacingIsStadium: true,             // measured 0.556 mm = w - h(1 - pi/4) = 0.5556
      infillInsetOfSpacing: 0.85,         // measured 0.472 mm = 0.85 x 0.5556 (infill_wall_overlap 15%)
      gridSpacingPerFamily: '2 x spacing / density',   // measured 7.408 mm at 15 %
      source: 'fixtures/3mf/supportwithinsupport.gcode.3mf, layers 1-22 (docs/SLICER.md section 3)'
    },
    // --- support: when a layer needs holding up ------------------------------
    supportThresholdDeg: {
      bambu: 30, nsoAim: 45,
      source: 'support_threshold_angle = 30 in both real Bambu slices\' config blocks; 45 is ' +
              'NSO_SupportAim.ANGLE_DEFAULT_DEG, which that file itself marks "stated, not measured"'
    },
    // --- the tree's own measured taper law -----------------------------------
    treeTaper: {
      tipDiameterMm: 2, angleDeg: 5,
      measured: { interceptMm: 1.97, slope: 0.172, r2: 0.988, slices: 1824, rmsMm: 0.085 },
      baseFlareMm: 1.35,
      source: 'docs/SUPPORT-TREE-SHAPE.md Finding 1, re-derived by npm run tree:shape from ' +
              'fixtures/3mf/tabletop.gcode.3mf: eqD = 1.97 + 0.172 x depth below the interface ' +
              '(r2 0.988); built as d = 2 + 2 tan 5 deg x depth (nso_support_tree.js TIP_DIAMETER_MM, ' +
              'DIAMETER_ANGLE_DEG)'
    },
    treeWall: {
      lines: 1, fromDiameterMm: 2.2,
      source: 'docs/SUPPORT-TREE-SHAPE.md Finding 2: every tree slice 2.2 mm and wider is a tube ' +
              'with ONE support line of wall (0.62 mm median against a 0.61 mm line)'
    },
    // --- where the support meets the piece -----------------------------------
    supportGap: {
      designMm: 0.18, measuredMm: 0.182,
      source: 'nso_support_interface.js GAP_MM (Seat (support) -0.18); 0.1820 mm is the tape ' +
              'artifact\'s closest approach, measured three ways from the 3MF\'s own vertices ' +
              '(commit 131c524, tools/nso_tri_distance.js). At 0.2 mm layers it leaves one empty ' +
              'layer between interface and piece'
    },
    interfaceStrand: {
      nso: { widthMm: 0.42, pitchMm: 1.2, layers: 2 },
      bambuMeasured: { widthMm: 0.61, pitchMm: 1.09, layers: 2 },
      source: 'NSO: nso_support_interface.js / nso_crosshatch.js (0.42 mm lines at 1.2 mm, one ' +
              'direction per layer, two layers). Bambu: tabletop.gcode.3mf support interface, ' +
              'strand 0.61 mm (tools/gcode-test/gcode-zfilter-check.js) at a 1.09 mm pitch ' +
              '(docs/SUPPORT-TREE.md section 1, npm run tree:reference)'
    },
    // --- the flow model, shared with the importer ----------------------------
    flow: {
      filamentDiameterMm: 1.75,
      source: 'stadium cross-section A = h(w - h) + pi h^2 / 4, the exact model ' +
              'nso-gcode-lines.js inverts to read a width back out of E'
    }
  };

  // The Bambu settings of the two real slices this repo holds, for the
  // settings a real print profile carries that the constants above do not.
  // Every value is copied from their config blocks (both files agree).
  var BAMBU_PROFILE_06 = {
    nozzleMm: 0.6, layerMm: 0.3, firstLayerMm: 0.3, lineWidthMm: 0.62,
    wallLoops: 2, topShellLayers: 3, bottomShellLayers: 3, topShellThicknessMm: 0.8,
    sparseDensity: 0.15, sparsePattern: 'grid', solidPattern: 'zigzag', infillDirectionDeg: 45,
    infillWallOverlap: 0.15, sliceClosingRadiusMm: 0.049, resolutionMm: 0.012, supportThresholdDeg: 30,
    onlyOneWallTop: true, minSparseAreaMm2: 15
  };

  function wallWidthFor(nozzle) {
    var d = (typeof nozzle === 'number' && nozzle > 0) ? nozzle : 0.4;
    return Math.round(d * LINE_RATIO * 1e6) / 1e6;
  }

  /** Line spacing of a stadium bead: w - h (1 - pi/4). Measured, see CONSTANTS. */
  function spacingOf(w, h) { return w - h * (1 - Math.PI / 4); }

  /** Cross-section area of a stadium bead - nso-gcode-lines.js areaFromWidth. */
  function beadArea(w, h) { return h * (w - h) + Math.PI * h * h / 4; }

  /**
   * Full options for a nozzle. Walls and infill take the repo's measured line
   * width for that nozzle (0.42 / 0.63); everything else defaults to the
   * settings of the real Bambu profile above, so a comparison against a real
   * slice is like for like. Any field can be overridden.
   */
  function defaultsFor(nozzleMm, over) {
    var n = (typeof nozzleMm === 'number' && nozzleMm > 0) ? nozzleMm : 0.4;
    var w = wallWidthFor(n);
    var o = {
      nozzleMm: n,
      layerMm: Math.round(n * 0.5 * 1e6) / 1e6,
      firstLayerMm: null,                  // null -> layerMm
      outerWallWidthMm: w,
      innerWallWidthMm: w,
      infillWidthMm: w,
      wallLoops: BAMBU_PROFILE_06.wallLoops,
      topShellLayers: BAMBU_PROFILE_06.topShellLayers,
      bottomShellLayers: BAMBU_PROFILE_06.bottomShellLayers,
      topShellThicknessMm: BAMBU_PROFILE_06.topShellThicknessMm,
      bottomShellThicknessMm: 0,
      sparseDensity: BAMBU_PROFILE_06.sparseDensity,
      sparsePattern: BAMBU_PROFILE_06.sparsePattern,   // 'grid' | 'zigzag' | 'lines'
      solidPattern: BAMBU_PROFILE_06.solidPattern,     // 'zigzag' | 'lines'
      infillDirectionDeg: BAMBU_PROFILE_06.infillDirectionDeg,
      infillWallOverlap: BAMBU_PROFILE_06.infillWallOverlap,
      sliceClosingRadiusMm: BAMBU_PROFILE_06.sliceClosingRadiusMm,
      resolutionMm: BAMBU_PROFILE_06.resolutionMm,
      supportThresholdDeg: CONSTANTS.supportThresholdDeg.bambu,
      overhangMinAreaMm2: null,            // null -> one line width squared
      onlyOneWallTop: BAMBU_PROFILE_06.onlyOneWallTop,
      topWallMergeMm: null,                // null -> 2 x outer wall width (measured fit)
      topWallKeepMm: null,                 // null -> merge + 0.985 x (w / 0.62) (measured fit)
      narrowSparseMm: null,                // null -> 1.7 x infill spacing (bracketed by two real slices)
      minSparseAreaMm2: BAMBU_PROFILE_06.minSparseAreaMm2,
      sparseAnchorMaxMm: 20,
      // An open section chain (a hole in the mesh) is closed by a straight
      // chord when its ends are this close; wider, it is dropped and counted.
      // STATED, not measured - a robustness choice for damaged input.
      gapCloseMm: 2,
      weldMm: 1e-4,
      dropToPlate: true,
      filamentDiameterMm: CONSTANTS.flow.filamentDiameterMm,
      emitGcode: true
    };
    if (over) Object.keys(over).forEach(function (k) { if (over[k] !== undefined) o[k] = over[k]; });
    if (!(o.firstLayerMm > 0)) o.firstLayerMm = o.layerMm;
    return o;
  }

  // ===========================================================================
  // Task 2 - layers and exact sections (pure JS)
  // ===========================================================================

  /**
   * The layer stack: print_z is the top of each layer (what the nozzle prints
   * at, and what ; Z_HEIGHT carries), slice_z the plane its section is cut on,
   * half a layer down - the classic scheme. Layers run while the slice plane is
   * still inside the part.
   */
  function slicePlanes(zMin, zMax, opts) {
    var h0 = opts.firstLayerMm, h = opts.layerMm;
    var out = [];
    var top = zMax - zMin;
    var pz = h0, hh = h0;
    for (var i = 0; ; i++) {
      var sz = pz - hh / 2;
      if (!(sz < top - 1e-9)) break;
      out.push({ index: i, printZ: zMin + pz, sliceZ: zMin + sz, h: hh });
      hh = h; pz += h;
      if (i > 200000) break;                     // a guard, not a limit anyone meets
    }
    return out;
  }

  /**
   * Index a soup: vertices welded within `q` mm, first representative wins -
   * the rule tools/mesh_validate.py applies, at the repo's one weld tolerance
   * (1e-4 mm, nso_thickness.js WELD_TOL). A grid of cell `q` and its 27
   * neighbours, so two points either side of a cell boundary still weld.
   */
  function indexSoup(soup, q) {
    var n = Math.floor(soup.length / 9);
    var grid = new Map();
    var V = [], T = new Int32Array(n * 3);
    var inv = 1 / q, q2 = q * q;
    for (var i = 0; i < n * 3; i++) {
      var x = soup[i * 3], y = soup[i * 3 + 1], z = soup[i * 3 + 2];
      var cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
      var id = -1;
      for (var a = -1; a <= 1 && id < 0; a++) {
        for (var b = -1; b <= 1 && id < 0; b++) {
          for (var c = -1; c <= 1 && id < 0; c++) {
            var cell = grid.get((cx + a) + ',' + (cy + b) + ',' + (cz + c));
            if (!cell) continue;
            for (var k = 0; k < cell.length; k++) {
              var j = cell[k] * 3, dx = V[j] - x, dy = V[j + 1] - y, dz = V[j + 2] - z;
              if (dx * dx + dy * dy + dz * dz <= q2) { id = cell[k]; break; }
            }
          }
        }
      }
      if (id < 0) {
        id = V.length / 3;
        V.push(x, y, z);
        var key = cx + ',' + cy + ',' + cz;
        var l = grid.get(key);
        if (!l) grid.set(key, [id]); else l.push(id);
      }
      T[i] = id;
    }
    return { V: Float64Array.from(V), T: T, nv: V.length / 3, nt: n };
  }

  /**
   * Exact sections of one mesh at every plane.
   *
   * Symbolic perturbation: a vertex exactly ON a plane counts as above it, so
   * every triangle crosses a plane in 0 or 2 edges and a face lying in the
   * plane contributes nothing. A crossing point is keyed by its EDGE (the
   * sorted vertex pair) and computed from the edge's sorted end points, so the
   * two triangles sharing an edge produce bit-identical points and the chain
   * closes by key, never by distance.
   *
   * Orientation: walking a triangle's edges in winding order, the section
   * segment runs from the edge that crosses DOWN to the edge that crosses UP.
   * For an outward-wound closed mesh that makes outer loops counter-clockwise
   * and holes clockwise - asserted on a tube by tools/nso_slicer_test.js.
   */
  function sliceMesh(soup, planes, opts) {
    var q = opts && opts.weldMm > 0 ? opts.weldMm : 1e-4;
    var gapClose = opts && opts.gapCloseMm != null ? opts.gapCloseMm : 2;
    var M = indexSoup(soup, q);
    var V = M.V, T = M.T, nv = M.nv;
    var zs = planes.map(function (p) { return p.sliceZ; });
    var buckets = planes.map(function () { return []; });
    var degenerate = 0;
    for (var t = 0; t < M.nt; t++) {
      var a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
      if (a === b || b === c || a === c) { degenerate++; continue; }
      var za = V[a * 3 + 2], zb = V[b * 3 + 2], zc = V[c * 3 + 2];
      var lo = Math.min(za, zb, zc), hi = Math.max(za, zb, zc);
      // planes with lo < z <= hi can be crossed (vertex on the plane = above)
      var i0 = firstAbove(zs, lo), i1 = firstAbove(zs, hi) - 1;
      for (var k = i0; k <= i1; k++) buckets[k].push(t);
    }

    var out = [];
    for (var pi = 0; pi < planes.length; pi++) {
      out.push(sectionAt(V, T, nv, buckets[pi], zs[pi], gapClose));
    }
    return { sections: out, vertices: nv, triangles: M.nt, degenerate: degenerate };
  }

  /** First index with arr[i] > v (arr ascending). */
  function firstAbove(arr, v) {
    var lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid] <= v) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function sectionAt(V, T, nv, tris, z0, gapClose) {
    var segStart = [], segEnd = [], ptOfKey = new Map();
    function crossing(i, j) {
      var lo = i < j ? i : j, hi = i < j ? j : i;
      var key = lo * nv + hi;
      if (!ptOfKey.has(key)) {
        var z1 = V[lo * 3 + 2], z2 = V[hi * 3 + 2];
        var s = (z0 - z1) / (z2 - z1);
        ptOfKey.set(key, [V[lo * 3] + (V[hi * 3] - V[lo * 3]) * s,
                          V[lo * 3 + 1] + (V[hi * 3 + 1] - V[lo * 3 + 1]) * s]);
      }
      return key;
    }
    for (var n = 0; n < tris.length; n++) {
      var t = tris[n];
      var v = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
      var above = [V[v[0] * 3 + 2] >= z0, V[v[1] * 3 + 2] >= z0, V[v[2] * 3 + 2] >= z0];
      if (above[0] === above[1] && above[1] === above[2]) continue;
      var up = -1, down = -1;
      for (var e = 0; e < 3; e++) {
        var f = (e + 1) % 3;
        if (!above[e] && above[f]) up = e;
        else if (above[e] && !above[f]) down = e;
      }
      segStart.push(crossing(v[down], v[(down + 1) % 3]));
      segEnd.push(crossing(v[up], v[(up + 1) % 3]));
    }

    // Chain by edge key. A non-manifold edge can start more than one segment,
    // so each key holds a list.
    var byStart = new Map();
    for (var s = 0; s < segStart.length; s++) {
      var lst = byStart.get(segStart[s]);
      if (!lst) { lst = []; byStart.set(segStart[s], lst); }
      lst.push(s);
    }
    var used = new Uint8Array(segStart.length);
    var loops = [], chains = [];
    for (var s0 = 0; s0 < segStart.length; s0++) {
      if (used[s0]) continue;
      // An open chain met from its middle is stitched to its head below
      // (joinChains, exact end-to-start first).
      var first = s0;
      var guard = 0;
      var chainKeys = [segStart[s0]];
      used[s0] = 1;
      var cur = s0, closed = false;
      while (guard++ < 1e7) {
        var endKey = segEnd[cur];
        if (endKey === segStart[first]) { closed = true; break; }
        var nexts = byStart.get(endKey), nx = -1;
        if (nexts) for (var q2 = 0; q2 < nexts.length; q2++) if (!used[nexts[q2]]) { nx = nexts[q2]; break; }
        if (nx < 0) { chainKeys.push(endKey); break; }
        chainKeys.push(endKey);
        used[nx] = 1;
        cur = nx;
      }
      var pts = chainKeys.map(function (k) { return ptOfKey.get(k); });
      if (closed) loops.push(dedupe(pts));
      else chains.push(pts);
    }

    // An open chain can be the tail of another open chain found from its
    // middle: stitch exact end-to-start matches first, then close the gaps.
    var openCount = chains.length, stitched = 0, closedByGap = 0, dropped = 0;
    if (chains.length) {
      var res = joinChains(chains, gapClose);
      stitched = res.stitched; closedByGap = res.closed; dropped = res.dropped;
      res.loops.forEach(function (l) { loops.push(dedupe(l)); });
    }
    loops = loops.filter(function (l) { return l.length >= 3; });
    return { z: z0, loops: loops, openChains: openCount, stitched: stitched,
             closedByGap: closedByGap, droppedChains: dropped, segments: segStart.length };
  }

  function dedupe(pts) {
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i], q = out[out.length - 1];
      if (q && Math.abs(q[0] - p[0]) < 1e-9 && Math.abs(q[1] - p[1]) < 1e-9) continue;
      out.push(p);
    }
    if (out.length > 1) {
      var a = out[0], b = out[out.length - 1];
      if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) out.pop();
    }
    return out;
  }

  /** Greedy end-to-start joining of open chains within `tol`; what cannot close is dropped. */
  function joinChains(chains, tol) {
    var live = chains.map(function (c) { return c.slice(); });
    var loops = [], stitched = 0, closed = 0;
    var d2 = function (a, b) { var dx = a[0] - b[0], dy = a[1] - b[1]; return dx * dx + dy * dy; };
    var tol2 = tol * tol;
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < live.length; i++) {
        var c = live[i];
        if (!c) continue;
        var end = c[c.length - 1];
        if (c.length >= 3 && d2(end, c[0]) <= tol2) { loops.push(c); live[i] = null; closed++; changed = true; continue; }
        var best = -1, bd = tol2;
        for (var j = 0; j < live.length; j++) {
          if (j === i || !live[j]) continue;
          var dd = d2(end, live[j][0]);
          if (dd <= bd) { bd = dd; best = j; }
        }
        if (best >= 0) {
          live[i] = c.concat(bd === 0 ? live[best].slice(1) : live[best]);
          live[best] = null;
          stitched++;
          changed = true;
        }
      }
    }
    var dropped = live.filter(Boolean).length;
    return { loops: loops, stitched: stitched, closed: closed, dropped: dropped };
  }

  function signedArea(poly) {
    var a = 0;
    for (var i = 0, n = poly.length; i < n; i++) {
      var p = poly[i], q = poly[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  // ===========================================================================
  // Task 1 - the geometry backend: Clipper2 through manifold's CrossSection
  // ===========================================================================

  /**
   * Every CrossSection made during one slice goes into an arena and is freed
   * with it - WASM objects are not garbage collected.
   *
   * Two binding facts the adapter exists for, both found by probing
   * vendor/manifold/manifold.js 3.5.3:
   *   - `new CrossSection([])` throws (its polygons2vec reads polygons[0]),
   *     so an empty section is built from one degenerate triangle;
   *   - a polygon list whose FIRST polygon has fewer than 3 points is taken
   *     for a single polygon of points, so short polygons are filtered out
   *     before they reach it.
   */
  function geometry(wasm) {
    if (!wasm || !wasm.CrossSection) throw new Error('geometry(): the manifold-3d kernel (with CrossSection) is not loaded');
    var CS = wasm.CrossSection;
    var arena = [];
    function keep(x) { arena.push(x); return x; }
    var EMPTY_POLY = [[[0, 0], [0, 0], [0, 0]]];
    function clean(polys) {
      return (polys || []).filter(function (p) { return p && p.length >= 3; });
    }
    var g = {
      empty: function () { return keep(new CS(EMPTY_POLY, 'Positive')); },
      of: function (polys, rule) {
        var c = clean(polys);
        return keep(new CS(c.length ? c : EMPTY_POLY, rule || 'Positive'));
      },
      offset: function (cs, d, join, miter) {
        if (cs.isEmpty()) return cs;
        return keep(cs.offset(d, join || 'Miter', miter || 3, 0));
      },
      union: function (a, b) { return keep(a.add(b)); },
      unionAll: function (list) {
        var l = list.filter(function (x) { return x && !x.isEmpty(); });
        if (!l.length) return g.empty();
        if (l.length === 1) return l[0];
        return keep(CS.union(l));
      },
      diff: function (a, b) { return b.isEmpty() ? a : keep(a.subtract(b)); },
      inter: function (a, b) { return keep(a.intersect(b)); },
      simplify: function (cs, eps) { return cs.isEmpty() || !(eps > 0) ? cs : keep(cs.simplify(eps)); },
      area: function (cs) { return cs.area(); },
      isEmpty: function (cs) { return cs.isEmpty(); },
      polys: function (cs) { return cs.isEmpty() ? [] : cs.toPolygons(); },
      parts: function (cs) {
        if (cs.isEmpty()) return [];
        var d = cs.decompose();
        d.forEach(keep);
        return d;
      },
      /** Drop islands smaller than minArea. */
      dropSmall: function (cs, minArea) {
        if (cs.isEmpty() || !(minArea > 0)) return cs;
        var parts = g.parts(cs).filter(function (p) { return p.area() >= minArea; });
        return g.unionAll(parts);
      },
      free: function () {
        for (var i = 0; i < arena.length; i++) { try { arena[i].delete(); } catch (e) { /* freed */ } }
        arena.length = 0;
      },
      arenaSize: function () { return arena.length; }
    };
    return g;
  }

  // ===========================================================================
  // Task 4 - scanline infill (pure JS)
  // ===========================================================================

  /**
   * One family of parallel lines at `angle`, `spacing` apart, clipped to the
   * region (polygons with holes, as Clipper hands them back: outer CCW, holes
   * CW, non-self-intersecting). Lines sit at phase + k * spacing in the rotated
   * frame, a GLOBAL grid, so a family lands on the same lines on every layer.
   * Crossings are half-open in y (y0 <= y < y1), so a line through a vertex is
   * counted once. Returns [{ a:[x,y], b:[x,y], line:k }] ordered by line, then
   * along it.
   */
  function scanFill(polys, angle, spacing, phase) {
    if (!(spacing > 0) || !polys.length) return [];
    var c = Math.cos(angle), s = Math.sin(angle);
    var edges = [];
    var yMin = Infinity, yMax = -Infinity;
    polys.forEach(function (poly) {
      var n = poly.length;
      for (var i = 0; i < n; i++) {
        var p = poly[i], q = poly[(i + 1) % n];
        // rotate by -angle
        var x0 = p[0] * c + p[1] * s, y0 = -p[0] * s + p[1] * c;
        var x1 = q[0] * c + q[1] * s, y1 = -q[0] * s + q[1] * c;
        if (y0 === y1) continue;
        var lo = Math.min(y0, y1), hi = Math.max(y0, y1);
        edges.push({ ylo: lo, yhi: hi, x0: x0, y0: y0, x1: x1, y1: y1 });
        if (lo < yMin) yMin = lo;
        if (hi > yMax) yMax = hi;
      }
    });
    if (!edges.length) return [];
    edges.sort(function (e1, e2) { return e1.ylo - e2.ylo; });
    var ph = phase || 0;
    var k0 = Math.ceil((yMin - ph) / spacing), k1 = Math.floor((yMax - ph) / spacing);
    var out = [];
    var active = [], ei = 0;
    for (var k = k0; k <= k1; k++) {
      var y = ph + k * spacing;
      while (ei < edges.length && edges[ei].ylo <= y) active.push(edges[ei++]);
      active = active.filter(function (e) { return e.yhi > y; });
      var xs = [];
      for (var a = 0; a < active.length; a++) {
        var e = active[a];
        if (e.ylo <= y && y < e.yhi) xs.push(e.x0 + (e.x1 - e.x0) * (y - e.y0) / (e.y1 - e.y0));
      }
      xs.sort(function (u, v) { return u - v; });
      for (var j = 0; j + 1 < xs.length; j += 2) {
        if (xs[j + 1] - xs[j] < 1e-6) continue;
        out.push({
          a: [xs[j] * c - y * s, xs[j] * s + y * c],
          b: [xs[j + 1] * c - y * s, xs[j + 1] * s + y * c],
          line: k
        });
      }
    }
    return out;
  }

  /** Even-odd point in polygon set. */
  function inside(polys, x, y) {
    var inn = false;
    for (var p = 0; p < polys.length; p++) {
      var poly = polys[p];
      for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inn = !inn;
      }
    }
    return inn;
  }

  /**
   * Connect scan segments into paths: from the end of the current path, go to
   * the NEAREST free segment end - of any family - when the connector is short
   * (<= maxLen) and runs inside the printable area (its midpoint is tested
   * against `hull`, the region grown to the beads' outer edge). Otherwise
   * travel, and start a new path at the nearest free end.
   *
   * With one family (solid infill) the nearest end is the next line's, so this
   * is a zig-zag. With the grid's two families it walks the lattice the way
   * the real slice does: supportwithinsupport's sparse layers join a 45 deg
   * line to the nearest 135 deg line along the boundary, with anchors of
   * 2.22 / 4.11 / 6.37 mm, never the 10.48 mm hop to the next line of the same
   * family (docs/SLICER.md section 3). 'lines' passes maxLen 0: never joined.
   */
  function connect(segs, maxLen, hull, startAt) {
    var n = segs.length;
    if (!n) return [];
    var used = new Uint8Array(n);
    var paths = [];
    var cur = startAt || segs[0].a;
    var d2 = function (p, q) { var dx = p[0] - q[0], dy = p[1] - q[1]; return dx * dx + dy * dy; };
    var left = n;
    var path = null;
    var maxLen2 = maxLen * maxLen;
    while (left > 0) {
      var best = -1, bd = Infinity, flip = false;
      for (var i = 0; i < n; i++) {
        if (used[i]) continue;
        var da = d2(cur, segs[i].a), db = d2(cur, segs[i].b);
        if (da < bd) { bd = da; best = i; flip = false; }
        if (db < bd) { bd = db; best = i; flip = true; }
      }
      var sg = segs[best];
      var s0 = flip ? sg.b : sg.a, s1 = flip ? sg.a : sg.b;
      var join = path && bd <= maxLen2 &&
        (!hull || inside(hull, (cur[0] + s0[0]) / 2, (cur[1] + s0[1]) / 2));
      if (join) path.pts.push(s0, s1);
      else { path = { closed: false, pts: [s0, s1] }; paths.push(path); }
      used[best] = 1; left--;
      cur = s1;
    }
    return paths;
  }

  // ===========================================================================
  // Tasks 3-5 - one object, all layers
  // ===========================================================================

  function loopsOf(g, cs) {
    return g.polys(cs).map(function (p) { return { closed: true, pts: p }; });
  }

  /**
   * Walls for one layer region. Loop 0 (the outer wall) is the region shrunk
   * by half the outer line width; loop 1 is loop 0 shrunk by half of each
   * spacing; every later loop by one inner spacing. Spacing is the stadium
   * spacing w - h(1 - pi/4). All three rules were measured on a real Bambu
   * slice (CONSTANTS.perimeterRule). A loop that offsets to nothing is where
   * the part is too thin for it - the region gets fewer walls there, exactly
   * as a thin rib does in the real file.
   *
   * `above` (the next layer's section), when onlyOneWallTop is on: loops after
   * the first are dropped over the part of the layer left exposed on top
   * (Bambu's top_one_wall_type) - the measured fit is described inside.
   */
  function perimeters(g, region, h, o, above) {
    var we = o.outerWallWidthMm, wi = o.innerWallWidthMm;
    var se = spacingOf(we, h), si = spacingOf(wi, h);
    var keepIn = 1 - o.infillWallOverlap;
    var loops = [];
    var cur = g.offset(region, -we / 2);
    var lastSpacing = se, count = 0, keep = null;
    if (!g.isEmpty(cur)) {
      loops.push({ depth: 0, cs: cur });
      count = 1;
      var from = cur;
      if (above) {
        // One wall on top surfaces (Bambu top_one_wall_type = all top, set in
        // both real slices). Measured black-box on supportwithinsupport's
        // z 8.1 layer: the part of the layer left exposed by the layer above -
        // after that layer is grown by topWallMergeMm, which merges the 1.125 mm
        // gaps between its 13 ribs - loses its extra walls, and so does
        // everything within topWallKeepMm of it. At 2 w and 2 w + 0.985 mm
        // (w 0.62) the inner loop lands on Bambu's at 75.204 / 79.260 to 1 um.
        var merge = o.topWallMergeMm != null ? o.topWallMergeMm : 2 * we;
        var keepD = o.topWallKeepMm != null ? o.topWallKeepMm : merge + 0.985 * we / 0.62;
        var exposed = g.diff(cur, g.offset(above, merge));
        if (!g.isEmpty(exposed)) {
          keep = g.diff(cur, g.offset(exposed, keepD));
          from = keep;
        }
      }
      var next = g.offset(from, -(se / 2 + si / 2));
      for (var k = 1; k < o.wallLoops && !g.isEmpty(next); k++) {
        loops.push({ depth: k, cs: next });
        cur = next; lastSpacing = si; count = k + 1;
        next = g.offset(cur, -si);
      }
    }
    // Infill boundary (bead CENTRES): the innermost loop moved in by the
    // measured 0.85 x spacing (infill_wall_overlap 15 %).
    var innerEdge = count ? g.offset(cur, -lastSpacing * keepIn) : g.empty();
    if (keep && count >= 1) {
      // Where the extra walls were dropped, the (top) infill runs out to the
      // outer wall, and stops 0.85 spacing short of the inner loop that runs
      // along the kept part's edge.
      var outerOnly = g.diff(g.offset(loops[0].cs, -se * keepIn), g.offset(keep, -si * (1 - keepIn)));
      innerEdge = count > 1 ? g.union(innerEdge, outerOnly) : outerOnly;
    }
    return { loops: loops, wallCount: count, infillRegion: innerEdge };
  }

  function sliceObjects(objects, opts, wasm) {
    var o = defaultsFor(opts && opts.nozzleMm, opts);
    var t0 = Date.now();
    var objs = (objects || []).filter(function (ob) { return ob && ob.soup && ob.soup.length >= 9; });
    if (!objs.length) return { ok: false, reason: 'nothing to slice - no object has any triangles' };

    // one shared frame: drop everything onto the plate together
    var zMin = Infinity, zMax = -Infinity;
    objs.forEach(function (ob) {
      for (var i = 2; i < ob.soup.length; i += 3) {
        if (ob.soup[i] < zMin) zMin = ob.soup[i];
        if (ob.soup[i] > zMax) zMax = ob.soup[i];
      }
    });
    var shiftZ = o.dropToPlate ? -zMin : 0;
    var planes = slicePlanes(zMin, zMax, o).map(function (p) {
      return { index: p.index, printZ: p.printZ + shiftZ, sliceZ: p.sliceZ, h: p.h };
    });
    if (!planes.length) return { ok: false, reason: 'the part is thinner than one layer' };

    var g = geometry(wasm);
    try {
      var T = Math.max(o.topShellLayers, Math.ceil((o.topShellThicknessMm || 0) / o.layerMm - 1e-9));
      var B = Math.max(o.bottomShellLayers, Math.ceil((o.bottomShellThicknessMm || 0) / o.layerMm - 1e-9));
      var closeR = o.sliceClosingRadiusMm > 0 ? o.sliceClosingRadiusMm : 0;
      var th = o.supportThresholdDeg * Math.PI / 180;
      var minOver = o.overhangMinAreaMm2 != null ? o.overhangMinAreaMm2 : o.outerWallWidthMm * o.outerWallWidthMm;

      var perObject = objs.map(function (ob, oi) {
        // Per-object override: a piece the user flagged non-solid is sliced
        // with gapCloseMm 0 - its open edges are the design, not a hole to
        // chord shut (the caller reads the flag; this module never infers it).
        var sm = sliceMesh(ob.soup, planes, ob.gapCloseMm != null ? { weldMm: o.weldMm, gapCloseMm: ob.gapCloseMm } : o);
        var flipped = false;
        var total = 0;
        sm.sections.forEach(function (sec) { sec.loops.forEach(function (l) { total += signedArea(l); }); });
        if (total < 0) {                      // wound inside out: every loop reversed
          flipped = true;
          sm.sections.forEach(function (sec) { sec.loops.forEach(function (l) { l.reverse(); }); });
        }
        var S = sm.sections.map(function (sec) {
          var cs = g.of(sec.loops, 'Positive');
          if (closeR > 0 && !g.isEmpty(cs)) cs = g.offset(g.offset(cs, closeR, 'Miter'), -closeR, 'Miter');
          // Bambu's `resolution` (0.012 mm in both real slices): the section is
          // simplified to that deviation - it also drops the collinear points a
          // quad face split into two triangles leaves in every loop.
          return g.simplify(cs, o.resolutionMm);
        });
        return { name: ob.name || ('object ' + (oi + 1)), id: oi, mesh: sm, S: S, flipped: flipped,
                 nonSolid: ob.gapCloseMm === 0,
                 layers: [] };
      });

      // Layers, object by object.
      perObject.forEach(function (P) {
        var S = P.S, n = planes.length;
        var sparsePrev = g.empty();
        for (var i = 0; i < n; i++) {
          var h = planes[i].h;
          var region = S[i];
          var L = { index: i, printZ: planes[i].printZ, h: h, paths: [], areaMm2: g.area(region) };
          P.layers.push(L);
          if (g.isEmpty(region)) { L.wallCount = 0; sparsePrev = g.empty(); continue; }

          var above = i + 1 < n ? S[i + 1] : g.empty();
          var below = i > 0 ? S[i - 1] : null;
          var per = perimeters(g, region, h, o, o.onlyOneWallTop ? above : null);
          L.wallCount = per.wallCount;
          L.wallLoopsByDepth = per.loops.map(function (lp) { return g.polys(lp.cs).length; });

          // --- overhang (Task 5): this section outside the one below, grown
          // by the printable step h / tan(threshold)
          var step = h / Math.tan(th);
          var over = below ? g.diff(region, g.offset(below, step)) : g.empty();
          over = g.dropSmall(over, minOver);
          L.overhangCs = over;
          L.overhangMm2 = g.area(over);
          var belowPolys = below ? g.polys(below) : null;

          per.loops.slice().reverse().forEach(function (lp) {     // inner walls first, outer last
            var feat = lp.depth === 0 ? 'Outer wall' : 'Inner wall';
            var w = lp.depth === 0 ? o.outerWallWidthMm : o.innerWallWidthMm;
            loopsOf(g, lp.cs).forEach(function (path) {
              splitOverhang(path, belowPolys, i).forEach(function (piece) {
                L.paths.push({ feature: piece.over ? 'Overhang wall' : feat, width: w,
                               closed: piece.closed, pts: piece.pts });
              });
            });
          });

          // --- shells (top / bottom solid) and sparse
          var inner = per.infillRegion;
          var cover = null;
          for (var k = 1; k <= T; k++) {
            var up = i + k < n ? S[i + k] : g.empty();
            cover = cover ? g.inter(cover, up) : up;
          }
          for (var kb = 1; kb <= B; kb++) {
            var dn = i - kb >= 0 ? S[i - kb] : g.empty();
            cover = cover ? g.inter(cover, dn) : dn;
          }
          if (!cover) cover = region;
          var solid = g.diff(inner, cover);
          var sparse = g.inter(inner, cover);
          // A sparse strip too narrow to hold infill is printed solid. The width
          // is bracketed by the two real slices: 0.875 mm strips (under
          // supportwithinsupport's ribs) came out solid, 1.0 mm strips (over the
          // tabletop's leg arms) came out sparse; 1.7 x spacing = 0.944 mm at
          // 0.62 / 0.3 sits inside that bracket (docs/SLICER.md section 3).
          var narrowR = (o.narrowSparseMm != null ? o.narrowSparseMm : 1.7 * spacingOf(o.infillWidthMm, h)) / 2;
          if (narrowR > 0 && !g.isEmpty(sparse)) {
            var opened = g.offset(g.offset(sparse, -narrowR), narrowR);
            var narrow = g.diff(sparse, opened);
            if (g.area(narrow) > 1e-6) { solid = g.union(solid, narrow); sparse = g.inter(sparse, opened); }
          }
          // a sparse island too small to hold infill is printed solid
          if (o.minSparseAreaMm2 > 0) {
            var small = g.unionAll(g.parts(sparse).filter(function (p) { return p.area() < o.minSparseAreaMm2; }));
            if (!g.isEmpty(small)) { solid = g.union(solid, small); sparse = g.diff(sparse, small); }
          }
          var top = g.inter(solid, g.diff(region, above));
          var bottomOpen = below ? g.inter(solid, g.diff(region, below)) : solid;
          // internal bridge: solid laid straight onto the previous layer's sparse
          var bridgeInner = below ? g.inter(g.diff(solid, bottomOpen), sparsePrev) : g.empty();
          var wInfB = o.infillWidthMm;
          // An internal bridge needs room to be one: over strips narrower than
          // two lines (the tabletop's 1.0 mm leg arms) Bambu printed plain
          // solid infill, over the 27 mm field under supportwithinsupport's
          // lid a bridge. Opened by one line width.
          if (!g.isEmpty(bridgeInner)) bridgeInner = g.offset(g.offset(bridgeInner, -wInfB), wInfB);
          var topOnly = g.diff(top, bottomOpen);
          var internal = g.diff(g.diff(g.diff(solid, top), bottomOpen), bridgeInner);
          // Solid strips left between top surfaces narrower than the narrow
          // width (supportwithinsupport z 8.1: 0.875 mm under each rib) print
          // as part of the top surface, as they did in the real slice.
          if (!g.isEmpty(topOnly) && !g.isEmpty(internal) && narrowR > 0) {
            var intNarrow = g.diff(internal, g.offset(g.offset(internal, -narrowR), narrowR));
            if (g.area(intNarrow) > 1e-6) { topOnly = g.union(topOnly, intNarrow); internal = g.diff(internal, intNarrow); }
          }
          L.areas = {
            solid: g.area(solid), sparse: g.area(sparse), top: g.area(topOnly),
            bottom: g.area(bottomOpen), bridge: g.area(bridgeInner), internal: g.area(internal)
          };

          var wInf = o.infillWidthMm, sInf = spacingOf(wInf, h);
          var dirA = (o.infillDirectionDeg) * Math.PI / 180;
          var solidAngle = (i % 2 === 0) ? dirA : dirA + Math.PI / 2;
          var hull = g.polys(g.offset(inner, wInf / 2 + 1e-4));
          var solidJoin = o.solidPattern === 'lines' ? 0 : 3 * sInf;
          function solidFill(cs, feat) {
            if (g.isEmpty(cs)) return;
            var polys = g.polys(cs);
            connect(scanFill(polys, solidAngle, sInf, 0), solidJoin, hull).forEach(function (pth) {
              L.paths.push({ feature: feat, width: wInf, closed: false, pts: pth.pts });
            });
          }
          solidFill(bottomOpen, i === 0 ? 'Bottom surface' : 'Bridge');
          solidFill(bridgeInner, 'Bridge');
          solidFill(topOnly, 'Top surface');
          solidFill(internal, 'Internal solid infill');

          if (!g.isEmpty(sparse) && o.sparseDensity > 0) {
            var sp = g.polys(sparse);
            var fams, lineSp;
            if (o.sparsePattern === 'grid') {
              lineSp = 2 * sInf / o.sparseDensity;
              fams = [dirA, dirA + Math.PI / 2];
            } else {
              lineSp = sInf / o.sparseDensity;
              fams = [(i % 2 === 0) ? dirA : dirA + Math.PI / 2];
            }
            var join = o.sparsePattern === 'lines' ? 0 : o.sparseAnchorMaxMm;
            var pool = [];
            fams.forEach(function (ang) { pool = pool.concat(scanFill(sp, ang, lineSp, 0)); });
            connect(pool, join, hull).forEach(function (pth) {
              L.paths.push({ feature: 'Sparse infill', width: wInf, closed: false, pts: pth.pts });
            });
          }
          sparsePrev = sparse;
        }
      });

      // --- overhang regions in 3D, per object: layer islands linked upward
      // --- conflicts: two objects printing into the same place on one layer.
      // Beads reach exactly to the section outline (the outer wall sits half
      // a line inside it), so two objects' printed beads overlap on a layer
      // exactly where their sections do. Layers are numbered from 1, the way
      // Bambu Studio numbers them in its own messages.
      var conflicts = [];
      for (var ci = 0; ci < planes.length; ci++) {
        for (var a = 0; a < perObject.length; a++) {
          for (var b = a + 1; b < perObject.length; b++) {
            var Sa = perObject[a].S[ci], Sb = perObject[b].S[ci];
            if (g.isEmpty(Sa) || g.isEmpty(Sb)) continue;
            var ov = g.inter(Sa, Sb);
            var ar = g.area(ov);
            if (ar > 1e-6) {
              conflicts.push({ layer: ci + 1, index: ci, printZ: planes[ci].printZ, a: perObject[a].name,
                               b: perObject[b].name, areaMm2: ar, polys: g.polys(ov) });
            }
          }
        }
      }

      var linkMm = o.layerMm / Math.tan(th) + o.outerWallWidthMm;
      var overhang = perObject.map(function (P) { return overhangRegions(g, P, planes, linkMm); });

      var result = {
        ok: true,
        reason: '',
        options: o,
        planes: planes,
        shiftZ: shiftZ,
        conflicts: conflicts,
        objects: perObject.map(function (P, oi) {
          var wc = {};
          P.layers.forEach(function (L) { if (L.areaMm2 > 0) wc[L.wallCount] = (wc[L.wallCount] || 0) + 1; });
          var st = { openChains: 0, stitched: 0, closedByGap: 0, droppedChains: 0 };
          P.mesh.sections.forEach(function (s) {
            st.openChains += s.openChains; st.stitched += s.stitched;
            st.closedByGap += s.closedByGap; st.droppedChains += s.droppedChains;
          });
          return {
            id: P.id, name: P.name, flipped: P.flipped, nonSolid: P.nonSolid,
            triangles: P.mesh.triangles, degenerate: P.mesh.degenerate,
            sectionStats: st,
            wallCountHistogram: wc,
            layers: P.layers.map(function (L) {
              return {
                index: L.index, printZ: L.printZ, h: L.h, areaMm2: L.areaMm2,
                wallCount: L.wallCount || 0, wallLoopsByDepth: L.wallLoopsByDepth || [],
                areas: L.areas || null, overhangMm2: L.overhangMm2 || 0,
                overhangPolys: L.overhangCs ? g.polys(L.overhangCs) : [],
                sectionPolys: g.polys(P.S[L.index]),
                paths: L.paths
              };
            }),
            overhang: overhang[oi]
          };
        }),
        ms: 0
      };
      result.ms = Date.now() - t0;
      result.report = describe(result);
      if (o.emitGcode) result.gcode = toGcode(result);
      return result;
    } finally {
      g.free();
    }
  }

  /**
   * Split a wall loop into runs over material (below it) and over air. A run
   * is over air when its edges' midpoints fall outside the layer below's
   * section. The first layer is never an overhang.
   */
  function splitOverhang(path, belowPolys, layerIndex) {
    var pts = path.pts;
    if (layerIndex === 0 || !belowPolys) return [{ over: false, closed: true, pts: pts }];
    var n = pts.length;
    var flags = [];
    var any = false, all = true;
    for (var i = 0; i < n; i++) {
      var p = pts[i], q = pts[(i + 1) % n];
      var f = !inside(belowPolys, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      flags.push(f);
      if (f) any = true; else all = false;
    }
    if (!any) return [{ over: false, closed: true, pts: pts }];
    if (all) return [{ over: true, closed: true, pts: pts }];
    // rotate so we start at a change of state, then cut into runs
    var s = 0;
    while (flags[s] === flags[(s + n - 1) % n]) s++;
    var runs = [];
    var cur = null;
    for (var k = 0; k < n; k++) {
      var e = (s + k) % n;
      if (!cur || cur.over !== flags[e]) {
        cur = { over: flags[e], closed: false, pts: [pts[e]] };
        runs.push(cur);
      }
      cur.pts.push(pts[(e + 1) % n]);
    }
    return runs;
  }

  /**
   * Link each layer's overhang islands into 3D regions: an island belongs to
   * the region of any island on the layer below it touches. For each region,
   * also say what a support under it would stand on: its footprint against
   * everything of the object printed below its first layer ('plate' where
   * nothing is, 'model' where the piece itself is).
   */
  function overhangRegions(g, P, planes, linkMm) {
    var regions = [];
    var prev = [];      // [{ cs, region }]
    for (var i = 0; i < P.layers.length; i++) {
      var L = P.layers[i];
      var cur = [];
      if (L.overhangCs && !g.isEmpty(L.overhangCs)) {
        g.parts(L.overhangCs).forEach(function (isl) {
          var owner = null;
          for (var k = 0; k < prev.length; k++) {
            // A growing overhang (a sphere's underside) puts each layer's
            // island one printable step OUTSIDE the last one's, so islands
            // link across that step plus a line, not only where they touch.
            var touch = g.inter(g.offset(prev[k].cs, linkMm), isl);
            if (!g.isEmpty(touch)) { owner = prev[k].region; break; }
          }
          if (!owner) {
            owner = { id: regions.length, firstLayer: i, lastLayer: i, layers: 0, areaMm2: 0,
                      firstZ: planes[i].printZ - planes[i].h, footprint: null,
                      min: [Infinity, Infinity], max: [-Infinity, -Infinity] };
            regions.push(owner);
          }
          owner.lastLayer = i;
          owner.layers++;
          var a = isl.area();
          owner.areaMm2 += a;
          owner.footprint = owner.footprint ? g.union(owner.footprint, isl) : isl;
          var b = isl.bounds();
          owner.min[0] = Math.min(owner.min[0], b.min[0]); owner.min[1] = Math.min(owner.min[1], b.min[1]);
          owner.max[0] = Math.max(owner.max[0], b.max[0]); owner.max[1] = Math.max(owner.max[1], b.max[1]);
          cur.push({ cs: isl, region: owner });
        });
      }
      prev = cur;
    }
    return regions.map(function (r) {
      var belowAll = g.unionAll(P.S.slice(0, r.firstLayer));
      var fp = r.footprint;
      var fpA = g.area(fp);
      var onModel = g.area(g.inter(fp, belowAll));
      return {
        id: r.id, firstLayer: r.firstLayer, lastLayer: r.lastLayer, layers: r.layers,
        firstZ: r.firstZ, areaMm2: r.areaMm2, footprintMm2: fpA,
        footprintPolys: g.polys(fp),
        overPlateMm2: fpA - onModel, overModelMm2: onModel,
        standsOn: onModel <= 1e-6 ? 'plate' : (fpA - onModel <= 1e-6 ? 'model' : 'both'),
        min: r.min, max: r.max
      };
    });
  }

  function describe(res) {
    var lines = [];
    lines.push(res.planes.length + ' layers at ' + res.options.layerMm + ' mm (first ' + res.options.firstLayerMm +
      ' mm), walls ' + res.options.outerWallWidthMm + ' / ' + res.options.innerWallWidthMm + ' mm, ' +
      Math.round(res.options.sparseDensity * 100) + ' % ' + res.options.sparsePattern + ', support below ' +
      res.options.supportThresholdDeg + ' deg');
    res.objects.forEach(function (ob) {
      var st = ob.sectionStats;
      var hist = Object.keys(ob.wallCountHistogram).sort().map(function (k) {
        return k + ' wall' + (k === '1' ? '' : 's') + ' x' + ob.wallCountHistogram[k];
      }).join(', ');
      lines.push(ob.name + ': ' + hist + '; ' + ob.overhang.length + ' support-need region(s)' +
        (st.openChains ? '; ' + st.openChains + ' open section chain(s) - ' + st.closedByGap + ' closed across a gap, ' +
          st.droppedChains + ' dropped' : '') + (ob.flipped ? '; mesh was wound inside out - read reversed' : ''));
    });
    if (res.conflicts && res.conflicts.length) {
      var byLayer = {};
      res.conflicts.forEach(function (c) { byLayer[c.layer] = (byLayer[c.layer] || 0) + c.areaMm2; });
      lines.push('CONFLICT - objects overlap on ' + Object.keys(byLayer).length + ' layer(s): ' +
        Object.keys(byLayer).map(function (k) { return 'layer ' + k + ' (' + byLayer[k].toFixed(2) + ' mm^2)'; }).join(', '));
    }
    return lines.join('\n');
  }

  // ===========================================================================
  // Task 8 - the toolpath as Bambu-style G-code text
  // ===========================================================================

  function fmt(v, d) { return (Math.abs(v) < 0.5 * Math.pow(10, -d) ? 0 : v).toFixed(d); }

  /**
   * The slice as G-code text in the shape a real Bambu slice has - the tags
   * nso-gcode-lines.js reads, M83 relative E, E written from the stadium flow
   * model so parseGcode() recovers each move's width.
   */
  function toGcode(res, opts) {
    var o = res.options;
    var filD = o.filamentDiameterMm;
    var filA = Math.PI * filD * filD / 4;
    var L = [];
    L.push('; HEADER_BLOCK_START');
    L.push('; generated by NSO in-house slicer (nso_slicer.js)');
    L.push('; total layer number: ' + res.planes.length);
    L.push('; HEADER_BLOCK_END');
    L.push('M83');
    L.push('G90');
    var x = null, y = null;
    for (var i = 0; i < res.planes.length; i++) {
      var pl = res.planes[i];
      L.push('; CHANGE_LAYER');
      L.push('; Z_HEIGHT: ' + fmt(pl.printZ, 4));
      L.push('; LAYER_HEIGHT: ' + fmt(pl.h, 4));
      L.push('G1 Z' + fmt(pl.printZ, 4) + ' F1200');
      res.objects.forEach(function (ob) {
        var lay = ob.layers[i];
        if (!lay || !lay.paths.length) return;
        L.push('; OBJECT_ID: ' + ob.id);
        var feat = null;
        lay.paths.forEach(function (p) {
          var pts = p.closed ? p.pts.concat([p.pts[0]]) : p.pts;
          if (pts.length < 2) return;
          if (p.feature !== feat) { feat = p.feature; L.push('; FEATURE: ' + feat); }
          var area = beadArea(p.width, pl.h);
          // E is computed from the coordinates AS WRITTEN (rounded to 4
          // decimals), so a reader recovers each move's width exactly even on
          // a move a few microns long.
          var sx = fmt(pts[0][0], 4), sy = fmt(pts[0][1], 4);
          L.push('G0 X' + sx + ' Y' + sy);
          x = +sx; y = +sy;
          for (var k = 1; k < pts.length; k++) {
            var tx = fmt(pts[k][0], 4), ty = fmt(pts[k][1], 4);
            var nx = +tx, ny = +ty;
            var d = Math.hypot(nx - x, ny - y);
            if (!(d > 5e-4)) continue;
            L.push('G1 X' + tx + ' Y' + ty + ' E' + fmt(area * d / filA, 7));
            x = nx; y = ny;
          }
        });
      });
    }
    L.push('; CONFIG_BLOCK_START');
    L.push('; filament_diameter = ' + filD);
    L.push('; nozzle_diameter = ' + o.nozzleMm);
    L.push('; layer_height = ' + o.layerMm);
    L.push('; initial_layer_print_height = ' + o.firstLayerMm);
    L.push('; outer_wall_line_width = ' + o.outerWallWidthMm);
    L.push('; inner_wall_line_width = ' + o.innerWallWidthMm);
    L.push('; sparse_infill_line_width = ' + o.infillWidthMm);
    L.push('; wall_loops = ' + o.wallLoops);
    L.push('; top_shell_layers = ' + o.topShellLayers);
    L.push('; bottom_shell_layers = ' + o.bottomShellLayers);
    L.push('; sparse_infill_density = ' + Math.round(o.sparseDensity * 100) + '%');
    L.push('; sparse_infill_pattern = ' + o.sparsePattern);
    L.push('; support_threshold_angle = ' + o.supportThresholdDeg);
    L.push('; CONFIG_BLOCK_END');
    return L.join('\n') + '\n';
  }

  // ===========================================================================
  // Loading the kernel
  // ===========================================================================

  /**
   * The manifold-3d kernel, from wherever this runtime keeps it: opts.wasm,
   * the app's NSO_CSG loader (browser), or the vendored copy (Node).
   */
  function loadKernel(opts) {
    if (opts && opts.wasm) return Promise.resolve(opts.wasm);
    if (root && root.NSO_CSG && typeof root.NSO_CSG.load === 'function') return root.NSO_CSG.load();
    if (typeof require === 'function' && typeof process !== 'undefined') {
      var path = require('path');
      var url = 'file://' + path.join(__dirname, 'vendor', 'manifold', 'manifold.js');
      return import(url).then(function (mod) { return (mod.default || mod)(); })
        .then(function (w) { w.setup(); return w; });
    }
    return Promise.reject(new Error('no manifold-3d kernel available to slice with'));
  }

  function run(objects, opts) {
    return loadKernel(opts).then(function (wasm) { return sliceObjects(objects, opts || {}, wasm); });
  }

  return {
    CONSTANTS: CONSTANTS,
    BAMBU_PROFILE_06: BAMBU_PROFILE_06,
    wallWidthFor: wallWidthFor,
    spacingOf: spacingOf,
    beadArea: beadArea,
    defaultsFor: defaultsFor,
    slicePlanes: slicePlanes,
    sliceMesh: sliceMesh,
    signedArea: signedArea,
    geometry: geometry,
    scanFill: scanFill,
    connect: connect,
    inside: inside,
    sliceObjects: sliceObjects,
    toGcode: toGcode,
    describe: describe,
    loadKernel: loadKernel,
    run: run
  };
});
