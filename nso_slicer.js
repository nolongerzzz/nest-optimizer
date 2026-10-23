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
 *   4b. thin      thinWalls()       - Detect thin wall: a piece under 1.05 x
 *                                     the bead is ONE pass down its medial
 *                                     centreline (medialPaths), at the bead's
 *                                     width; the rest gets its walls as ever.
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
 *   7b. supports  typeSupports()    - an object passed with role 'support' is
 *                                     printed as support, the way Bambu prints
 *                                     its own: every line of it is Support,
 *                                     Support transition or Support interface,
 *                                     never a wall or infill. Which layer is
 *                                     which is read off the geometry: where its
 *                                     top lies within gap + one layer under the
 *                                     host's underside, its top 2 layers are the
 *                                     interface and the 2 below the transition.
 *                                     The host's overhang regions are credited
 *                                     with what those tops cover.
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
 * OBJECTS. { name, soup, gapCloseMm?, role?, key?, hostKey?, detectThinWall? }. role is 'part'
 * (the default) or 'support'; a support names the part it holds by that
 * part's key (hostKey). With no support among them the slice is exactly what
 * it was before roles existed. detectThinWall (Detect thin wall, classic
 * walls) defaults to on for a support - every NSO support carries
 * detect_thin_wall = 1 - and to opts.detectThinWall (off) for a part.
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
 *   thinWalls(g, region, opts)         -> the thin pieces' centre passes, or null (Detect thin wall)
 *   medialPaths(polys, w, restPolys)   -> a thin piece's centreline as paths (pure JS)
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
    // --- a support object's own layers, read off its geometry ---------------
    supportSheet: {
      interfaceLayers: 2, transitionLayers: 2, closeMm: 0.5, stairLayers: 1, stairRunMm: 2, stairCoverShare: 0.9,
      source: 'nso_support_interface.js sheet(): SHEET_ROLES transition, transition, interface, ' +
              'interface - two one-direction transition layers under two interface layers, open ' +
              'lines at 0.84 mm (0.40 line + 0.44 channel since supports-print-1). closeMm is STATED, not measured: a ' +
              'closing that shuts channels up to 1.0 mm, so a sheet layer of lines reads as the ' +
              'footprint it holds (finish()\'s 1.2 mm patches leave 0.78 mm)'
    },
    // --- thin walls: Classic walls with Detect thin wall on -----------------
    thinWall: {
      ratio: 1.05, minMm: 0.13, supportsOn: true,
      source: 'ratio STATED, not measured: an island is a thin wall when nothing of it but corner / ' +
              'junction specks survives shrinking by half of 1.05 x the bead (0.441 mm at 0.42) - so NSO\'s ' +
              '0.40 sheet (0.95 bead, printed in one pass by Bambu Studio, classic walls + Detect thin wall, ' +
              'the owner\'s breakaway print 2026-10-20) and its 0.43 one are both one centre pass, and a wall ' +
              'of 1.05 bead or more keeps its loops. Drawn at the bead\'s own width: Bambu\'s thin wall measured ' +
              'E/mm 0.0307 = its outer wall\'s. minMm STATED: classic walls with thin walls on print a wall from ' +
              '0.13 mm up as one pass (PR #256\'s reading of Bambu Studio\'s behaviour); narrower is nothing. supportsOn: every NSO support object carries detect_thin_wall = 1 ' +
              '(nso_support_interface.js SHEET.slicerSettings), so a support is sliced with it on'
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
    onlyOneWallTop: true, minSparseAreaMm2: 15, detectThinWall: false
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
      // Detect thin wall (classic walls): an island under the thin width is
      // printed as one centre pass. Off, as in both real profiles
      // (detect_thin_wall = 0); a support object is sliced with it on
      // (CONSTANTS.thinWall.supportsOn), and an object can say either way.
      detectThinWall: BAMBU_PROFILE_06.detectThinWall,
      thinWallMm: null,                    // null -> CONSTANTS.thinWall.ratio x outer wall width
      // An open section chain (a hole in the mesh) is closed by a straight
      // chord when its ends are this close; wider, it is dropped and counted.
      // STATED, not measured - a robustness choice for damaged input.
      gapCloseMm: 2,
      // A support object (role 'support') holds its host where its top lies
      // within this gap + one layer under the host's underside.
      supportGapMm: CONSTANTS.supportGap.designMm,
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

  // ===========================================================================
  // Thin walls - Classic walls with Detect thin wall on (one centre pass)
  // ===========================================================================
  //
  // Bambu Studio with the classic wall generator and Detect thin wall on
  // prints a modelled wall narrower than its bead as ONE pass down the wall's
  // middle, at the bead's own width: NSO's 0.40 mm support sheet printed that
  // way (one pass per line, E/mm 0.0307 = the outer wall's; the owner's
  // breakaway print, 2026-10-20 - docs/SLICER.md section 6). Without it the
  // classic inset (w/2) keeps nothing of such a wall, or a sliver drawn out
  // and back. This is Classic semantics, not Arachne: one fixed width, no
  // variable bead.
  //
  // WHAT IS THIN. The layer region shrunk by half the thin width
  // (CONSTANTS.thinWall: 1.05 x the bead, STATED) and grown back is what
  // holds a wall of its own - less the specks a corner or a junction of thin
  // walls leaves (an L of a 0.40 strip keeps a 0.47 mm circle, a T a 0.50
  // one: under half a bead across). The rest of the region, opened by
  // CONSTANTS.thinWall.minMm (0.13: narrower is nothing, as before), is thin;
  // a piece of it with a centreline a bead long or more is printed as that
  // centreline and nothing else, and comes out of the region. Everything
  // else keeps the wall / infill treatment it always had, and a layer with
  // no such piece is sliced exactly as before. A thin piece
  // that meets a walled part (a sheet line against a trunk) runs on into it
  // to the part's outer wall.
  //
  // THE CENTRELINE (medialPaths, pure JS): the island is rasterised at
  // THIN_PX pixels a bead, thinned to a one-pixel skeleton (Zhang-Suen, a
  // textbook method), traced into a graph of chains between ends and
  // junctions, its spurs (a chain from a junction to an end shorter than a
  // bead: the medial axis's prongs into corners and line ends) pruned, each
  // chain straightened (a corner the raster rounds put back where its two
  // fitted lines cross), and the graph drawn as the fewest paths that draw
  // every chain once (an Euler trail per pair of odd nodes). A closed thin
  // loop is one closed path; a serpentine joined to it at one point
  // continues it - the loop, then the serpentine, no travel between. A free
  // end is placed half the local width short of the piece's edge, so the
  // bead ends flush.

  var THIN_PX = 20;                 // pixels a bead (0.021 mm at 0.42): centreline within half of one
  var THIN_MAX_PX = 4e6;            // a larger island is rasterised coarser, never more pixels than this

  /**
   * The thin pieces of a layer region and their centre passes, or null when
   * there is none (the caller then slices the region exactly as before).
   * -> { rest: the region less those pieces (walls and infill as ever), paths: [{ closed, pts }], pieces }
   */
  function thinWalls(g, region, o) {
    var w = o.outerWallWidthMm;
    var tw = o.thinWallMm > 0 ? o.thinWallMm : CONSTANTS.thinWall.ratio * w;
    // what holds a wall of its own: the region shrunk by half the thin width,
    // less the specks a corner or junction of thin walls leaves, grown back
    var core = g.parts(g.offset(region, -tw / 2)).filter(function (c) {
      var b = c.bounds();
      return Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]) >= w / 2;
    });
    var body = g.offset(g.unionAll(core), tw / 2);
    var rest0 = g.inter(region, body);
    // the rest, opened by the thinnest wall printed (CONSTANTS.thinWall.minMm:
    // narrower is nothing - and so is a sliver along a curved edge the
    // opening did not quite give back), piece by piece
    var thin = g.diff(region, body);
    if (g.isEmpty(thin)) return null;
    var tmin = CONSTANTS.thinWall.minMm;
    thin = g.offset(g.offset(thin, -tmin / 2), tmin / 2);
    var restPolys = g.isEmpty(rest0) ? [] : g.polys(g.offset(rest0, w / 20));
    var keep = [], paths = [];
    g.parts(thin).forEach(function (pc) {
      if (!(pc.area() >= w * w / 4)) return;
      var mine = medialPaths(g.polys(pc), w, restPolys);
      if (!mine) return;
      keep.push(pc);
      paths = paths.concat(mine);
    });
    if (!keep.length) return null;
    return { rest: g.diff(region, g.unionAll(keep)), paths: paths, pieces: keep.length };
  }

  /**
   * The medial centreline of one thin piece (polygons with holes, as Clipper
   * hands them back), as extrusion paths: [{ closed, pts }]. null when it has
   * none a bead long (a blob, not a wall: it keeps the classic treatment).
   * restPolys: the walled part beside it, slightly grown - an end that meets
   * it runs on into it.
   */
  function medialPaths(polys, w, restPolys) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    polys.forEach(function (P) { P.forEach(function (q) {
      if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0];
      if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1];
    }); });
    if (!(x1 > x0 && y1 > y0)) return null;
    var p = Math.max(w / THIN_PX, Math.sqrt((x1 - x0) * (y1 - y0) / THIN_MAX_PX));
    var nx = Math.ceil((x1 - x0) / p) + 5, ny = Math.ceil((y1 - y0) / p) + 5;
    var ox = x0 - 2 * p, oy = y0 - 2 * p;
    var img = new Uint8Array(nx * ny);
    var edges = [], bnd = [];
    polys.forEach(function (P) {
      for (var i = 0; i < P.length; i++) {
        var a = P[i], b = P[(i + 1) % P.length];
        bnd.push(a, b);
        if (a[1] !== b[1]) edges.push(a, b);
      }
    });
    // pixel centres inside, even-odd (Clipper's polygons do not overlap)
    var xs = [];
    for (var j = 0; j < ny; j++) {
      var y = oy + (j + 0.5) * p;
      xs.length = 0;
      for (var e = 0; e < edges.length; e += 2) {
        var A = edges[e], B = edges[e + 1];
        if ((A[1] <= y) !== (B[1] <= y)) xs.push(A[0] + (y - A[1]) * (B[0] - A[0]) / (B[1] - A[1]));
      }
      xs.sort(function (u, v) { return u - v; });
      for (var t = 0; t + 1 < xs.length; t += 2) {
        var i0 = Math.max(0, Math.ceil((xs[t] - ox) / p - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[t + 1] - ox) / p - 0.5));
        for (var i = i0; i <= i1; i++) img[j * nx + i] = 1;
      }
    }
    thinImage(img, nx, ny);
    var G = skeletonGraph(img, nx, ny, function (k) { return [ox + (k % nx + 0.5) * p, oy + (Math.floor(k / nx) + 0.5) * p]; });
    pruneSpurs(G, w);
    if (!G.edges.some(function (ed) { return ed; })) return null;
    G.edges.forEach(function (ed) { ed.pts = straighten(ed, G, w, 2 * p); });
    var paths = eulerPaths(G);
    var total = 0;
    paths.forEach(function (pa) {
      trimEnds(pa, bnd, w, restPolys || []);
      total += pathLength(pa.pts, pa.closed);
    });
    if (!(total >= w)) return null;
    return paths.map(function (pa) { return { closed: pa.closed, pts: pa.pts }; });
  }

  /** Zhang-Suen thinning, in place: one-pixel-wide, 8-connected skeleton. */
  function thinImage(img, nx, ny) {
    var live = [];
    for (var k = 0; k < img.length; k++) if (img[k]) live.push(k);
    var N = [-nx, -nx + 1, 1, nx + 1, nx, nx - 1, -1, -nx - 1];      // P2..P9, clockwise from north
    var nb = new Array(8);
    for (var changed = true; changed;) {
      changed = false;
      for (var step = 0; step < 2; step++) {
        var del = [];
        for (var q = 0; q < live.length; q++) {
          var c = live[q];
          if (!img[c]) continue;
          var Bn = 0;
          for (var d = 0; d < 8; d++) { nb[d] = img[c + N[d]]; Bn += nb[d]; }
          if (Bn < 2 || Bn > 6) continue;
          var An = 0;
          for (var d2 = 0; d2 < 8; d2++) if (!nb[d2] && nb[(d2 + 1) % 8]) An++;
          if (An !== 1) continue;
          if (step === 0 ? (nb[0] && nb[2] && nb[4]) || (nb[2] && nb[4] && nb[6])
                         : (nb[0] && nb[2] && nb[6]) || (nb[0] && nb[4] && nb[6])) continue;
          del.push(c);
        }
        for (var r = 0; r < del.length; r++) img[del[r]] = 0;
        if (del.length) changed = true;
      }
      live = live.filter(function (k2) { return img[k2]; });
    }
    // a 2 x 2 block thinning leaves: drop its simple pixels (one 8-transition)
    for (var again = true; again;) {
      again = false;
      for (var s = 0; s < live.length; s++) {
        var c2 = live[s];
        if (!img[c2] || !(img[c2 + 1] && img[c2 + nx] && img[c2 + nx + 1])) continue;
        [c2, c2 + 1, c2 + nx, c2 + nx + 1].some(function (m) {
          var b = N.map(function (o2) { return img[m + o2]; });
          var tr = 0;
          for (var d3 = 0; d3 < 8; d3++) if (!b[d3] && b[(d3 + 1) % 8]) tr++;
          if (tr === 1) { img[m] = 0; again = true; return true; }
          return false;
        });
      }
      live = live.filter(function (k3) { return img[k3]; });
    }
  }

  /**
   * The skeleton as a graph: nodes where it ends or branches, edges the pixel
   * chains between them (mm points, node to node). A diagonal step is taken
   * only where no 4-neighbour of both pixels is on (a staircase is a line).
   * Junction pixels next to each other are one node.
   */
  function skeletonGraph(img, nx, ny, at) {
    var N8 = [-nx, 1, nx, -1, -nx + 1, nx + 1, nx - 1, -nx - 1];
    function nbrs(k) {
      var out = [];
      for (var d = 0; d < 8; d++) {
        var m = k + N8[d];
        if (!img[m]) continue;
        if (d >= 4) {                    // diagonal: skip it when a shared 4-neighbour is on
          var dx = (m % nx) - (k % nx), dy = Math.floor(m / nx) - Math.floor(k / nx);
          if (img[k + dx] || img[k + dy * nx]) continue;
        }
        out.push(m);
      }
      return out;
    }
    var pix = [];
    for (var k = 0; k < img.length; k++) if (img[k]) pix.push(k);
    var deg = new Map();
    pix.forEach(function (k2) { deg.set(k2, nbrs(k2).length); });
    // nodes: every pixel that is not a plain chain pixel, adjacent ones merged
    var nodeOf = new Map(), nodes = [];
    pix.forEach(function (k3) {
      if (deg.get(k3) === 2 || nodeOf.has(k3)) return;
      var id = nodes.length, members = [], stack = [k3];
      nodeOf.set(k3, id);
      while (stack.length) {
        var c = stack.pop();
        members.push(c);
        nbrs(c).forEach(function (m) { if (deg.get(m) !== 2 && !nodeOf.has(m) && deg.get(c) > 2 && deg.get(m) > 2) { nodeOf.set(m, id); stack.push(m); } });
      }
      var sx = 0, sy = 0;
      members.forEach(function (m) { var q = at(m); sx += q[0]; sy += q[1]; });
      nodes.push({ pt: [sx / members.length, sy / members.length], deg: 0 });
    });
    var edges = [], seen = new Set();
    function walk(startNode, from, first) {
      var pts = [nodes[startNode].pt], prev = from, cur = first;
      if (seen.has(Math.min(from, first) + ',' + Math.max(from, first))) return;
      for (var guard = 0; guard < img.length; guard++) {
        seen.add(Math.min(prev, cur) + ',' + Math.max(prev, cur));
        if (nodeOf.has(cur)) {
          pts.push(nodes[nodeOf.get(cur)].pt);
          edges.push({ a: startNode, b: nodeOf.get(cur), pts: pts });
          return;
        }
        pts.push(at(cur));
        var nx2 = nbrs(cur).filter(function (m) { return m !== prev; });
        if (nx2.length !== 1) return;                  // cannot happen on a chain pixel; dropped if it does
        prev = cur; cur = nx2[0];
      }
    }
    nodeOf.forEach(function (id, k4) {
      nbrs(k4).forEach(function (m) { if (nodeOf.get(m) !== id) walk(id, k4, m); });
    });
    // what is left is closed rings with no node: one node on each
    pix.forEach(function (k5) {
      if (nodeOf.has(k5)) return;
      var nb = nbrs(k5);
      if (seen.has(Math.min(k5, nb[0]) + ',' + Math.max(k5, nb[0]))) return;
      var id = nodes.length;
      nodes.push({ pt: at(k5), deg: 0 });
      nodeOf.set(k5, id);
      walk(id, k5, nb[0]);
    });
    return { nodes: nodes, edges: edges };
  }

  function nodeDegrees(G) {
    G.nodes.forEach(function (nd) { nd.deg = 0; });
    G.edges.forEach(function (ed) { if (ed) { G.nodes[ed.a].deg++; G.nodes[ed.b].deg++; } });
  }

  /**
   * Drop the spurs - chains from a junction to a free end shorter than a
   * bead (the medial axis's prongs into a corner, or the fork at a line's
   * end) - and pieces shorter than a bead standing alone; then join the
   * chains through every node left with two.
   */
  function pruneSpurs(G, w) {
    for (var round = 0; round < 4; round++) {
      nodeDegrees(G);
      var cut = false;
      G.edges.forEach(function (ed, i) {
        if (!ed || ed.a === ed.b) return;
        var da = G.nodes[ed.a].deg, db = G.nodes[ed.b].deg;
        var spur = (da === 1 && db >= 3) || (db === 1 && da >= 3) || (da === 1 && db === 1);
        if (spur && pathLength(ed.pts, false) < w) { G.edges[i] = null; cut = true; }
      });
      nodeDegrees(G);
      // join through nodes of degree 2
      G.nodes.forEach(function (nd, id) {
        if (nd.deg !== 2) return;
        var two = [];
        G.edges.forEach(function (ed, i) { if (ed && (ed.a === id || ed.b === id)) two.push(i); });
        if (two.length !== 2) return;                          // a ring through this node alone
        var e1 = G.edges[two[0]], e2 = G.edges[two[1]];
        var p1 = e1.b === id ? e1.pts : e1.pts.slice().reverse(), s1 = e1.b === id ? e1.a : e1.b;
        var p2 = e2.a === id ? e2.pts : e2.pts.slice().reverse(), s2 = e2.a === id ? e2.b : e2.a;
        G.edges[two[0]] = { a: s1, b: s2, pts: p1.concat(p2.slice(1)) };
        G.edges[two[1]] = null;
        cut = true;
      });
      if (!cut) break;
    }
    G.edges = G.edges.filter(Boolean);
    nodeDegrees(G);
  }

  /** Douglas-Peucker to `eps`, ends kept: the indices kept. */
  function simplifyIdx(pts, eps) {
    if (pts.length < 3) return pts.map(function (q, i) { return i; });
    var keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var s = stack.pop(), a = pts[s[0]], b = pts[s[1]];
      var dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), best = -1, bd = eps;
      for (var i = s[0] + 1; i < s[1]; i++) {
        var q = pts[i];
        var d = L > 1e-12 ? Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / L : Math.hypot(q[0] - a[0], q[1] - a[1]);
        if (d > bd) { bd = d; best = i; }
      }
      if (best > 0) { keep[best] = 1; stack.push([s[0], best], [best, s[1]]); }
    }
    var out = [];
    for (var k = 0; k < pts.length; k++) if (keep[k]) out.push(k);
    return out;
  }

  /** The least-squares line through points: { c: centroid, d: unit direction } (null under 3). */
  function fitLine(pts) {
    if (pts.length < 3) return null;
    var cx = 0, cy = 0;
    pts.forEach(function (q) { cx += q[0]; cy += q[1]; });
    cx /= pts.length; cy /= pts.length;
    var sxx = 0, syy = 0, sxy = 0;
    pts.forEach(function (q) { var dx = q[0] - cx, dy = q[1] - cy; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; });
    var th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { c: [cx, cy], d: [Math.cos(th), Math.sin(th)] };
  }

  function crossLines(A, B) {
    var den = A.d[0] * B.d[1] - A.d[1] * B.d[0];
    if (Math.abs(den) < 0.2) return null;                  // under ~12 deg between them: no corner
    var t = ((B.c[0] - A.c[0]) * B.d[1] - (B.c[1] - A.c[1]) * B.d[0]) / den;
    return [A.c[0] + A.d[0] * t, A.c[1] + A.d[1] * t];
  }

  /**
   * One chain of skeleton pixels as a polyline. Its corners are found on a
   * coarse simplification (Douglas-Peucker to a quarter bead: the raster
   * rounds a corner by about that much): a vertex turning 15 deg or more,
   * with the vertices after it joined by segments under 3/4 bead, is one
   * corner when the lines either side of it turn 30 deg or more - and it is
   * put where its two lines cross: each line fitted (least squares) to the
   * chain's pixels along it, less the stretch near either end where the
   * raster rounds, when that lies within half a bead of where the raster
   * put the corner. Between corners, the pixels are simplified to `eps`. A
   * ring with no junction on it starts in the middle of its longest line, so
   * no corner sits on its seam. Nodes never move.
   */
  function straighten(ed, G, w, eps) {
    var raw = ed.pts;
    if (ed.a === ed.b && G.nodes[ed.a].deg === 2 && raw.length > 8) {
      var first = simplifyIdx(raw, w / 4), bi = 0, bl = -1;
      for (var q0 = 0; q0 + 1 < first.length; q0++) {
        var l0 = Math.hypot(raw[first[q0 + 1]][0] - raw[first[q0]][0], raw[first[q0 + 1]][1] - raw[first[q0]][1]);
        if (l0 > bl) { bl = l0; bi = (first[q0] + first[q0 + 1]) >> 1; }
      }
      raw = raw.slice(bi, raw.length - 1).concat(raw.slice(0, bi + 1));
      G.nodes[ed.a].pt = raw[0];
    }
    var C = simplifyIdx(raw, w / 4);
    var P = function (k) { return raw[C[k]]; };
    var segLen = function (k) { return Math.hypot(P(k + 1)[0] - P(k)[0], P(k + 1)[1] - P(k)[1]); };
    var turn = function (k) {
      var a = P(k - 1), b = P(k), c = P(k + 1);
      var u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
      return Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]));
    };
    // the line along coarse segment k: its pixels, less a stretch at each end
    var lineOf = function (k) {
      var L = segLen(k), cut = Math.min(0.6 * w, 0.3 * L), a = P(k), b = P(k + 1), pts = [];
      for (var j = C[k]; j <= C[k + 1]; j++) {
        var q = raw[j];
        if (Math.hypot(q[0] - a[0], q[1] - a[1]) >= cut && Math.hypot(q[0] - b[0], q[1] - b[1]) >= cut) pts.push(q);
      }
      return fitLine(pts);
    };
    // anchors: the ends, and each corner (a group of turns) as one point
    var anchors = [{ i: 0, pt: raw[0], corner: false }];
    var dirOf = function (k) { return Math.atan2(P(k + 1)[1] - P(k)[1], P(k + 1)[0] - P(k)[0]); };
    for (var k = 1; k + 1 < C.length; k++) {
      if (turn(k) < Math.PI / 12) continue;
      var k1 = k;
      while (k1 + 2 < C.length && segLen(k1) < 0.75 * w) k1++;
      var tot = Math.abs(((dirOf(k1) - dirOf(k - 1)) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
      if (tot < Math.PI / 6) { k = k1; continue; }
      var A = lineOf(k - 1), B = lineOf(k1), X = A && B ? crossLines(A, B) : null;
      var mid = P((k + k1) >> 1);
      if (!X || Math.hypot(X[0] - mid[0], X[1] - mid[1]) > w / 2) X = k === k1 ? P(k) : null;
      if (X) anchors.push({ i: C[k], j: C[k1], pt: X, corner: true });
      else for (var kk = k; kk <= k1; kk++) anchors.push({ i: C[kk], j: C[kk], pt: P(kk), corner: false });
      k = k1;
    }
    anchors.push({ i: raw.length - 1, pt: raw[raw.length - 1], corner: false });
    // between anchors: the pixels, off the rounded corners, simplified
    var out = [anchors[0].pt];
    for (var t = 0; t + 1 < anchors.length; t++) {
      var A0 = anchors[t], B0 = anchors[t + 1];
      var from = A0.j != null ? A0.j : A0.i, to = B0.i;
      var sub = [A0.pt];
      for (var j2 = from + 1; j2 < to; j2++) {
        var q2 = raw[j2];
        if (A0.corner && Math.hypot(q2[0] - A0.pt[0], q2[1] - A0.pt[1]) < 0.6 * w) continue;
        if (B0.corner && Math.hypot(q2[0] - B0.pt[0], q2[1] - B0.pt[1]) < 0.6 * w) continue;
        sub.push(q2);
      }
      sub.push(B0.pt);
      simplifyIdx(sub, eps).slice(1).forEach(function (m) { out.push(sub[m]); });
    }
    return out;
  }

  function pathLength(pts, closed) {
    var l = 0;
    for (var i = 0; i + 1 < pts.length; i++) l += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (closed && pts.length > 2) l += Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]);
    return l;
  }

  /**
   * The fewest paths that draw every chain once. Per connected piece: its
   * odd nodes paired nearest first by stand-in edges, one Euler circuit
   * (Hierholzer), cut at the stand-ins. A piece with no odd node is one
   * closed path. A path starts at its end with the more chains, so a loop
   * with a serpentine joined to it is drawn loop first. Each path carries
   * which of its points are nodes (`fixed`).
   */
  function eulerPaths(G) {
    var E = G.edges.map(function (ed) { return { a: ed.a, b: ed.b, pts: ed.pts, real: true }; });
    var adj = G.nodes.map(function () { return []; });
    E.forEach(function (ed, i) { adj[ed.a].push(i); if (ed.b !== ed.a) adj[ed.b].push(i); });
    var comp = G.nodes.map(function () { return -1; }), nc = 0;
    G.nodes.forEach(function (nd, s) {
      if (comp[s] >= 0 || !adj[s].length) return;
      var st = [s]; comp[s] = nc;
      while (st.length) {
        var v = st.pop();
        adj[v].forEach(function (i) { var u = E[i].a === v ? E[i].b : E[i].a; if (comp[u] < 0) { comp[u] = nc; st.push(u); } });
      }
      nc++;
    });
    var out = [];
    for (var c = 0; c < nc; c++) {
      var mine = [];
      G.nodes.forEach(function (nd, v) { if (comp[v] === c) mine.push(v); });
      var odd = mine.filter(function (v) { return G.nodes[v].deg % 2 === 1; });
      var open = odd.length > 0;
      while (odd.length) {                               // nearest pairs
        var a = odd.shift(), bi = 0, bd = Infinity;
        odd.forEach(function (b, i) {
          var d = Math.hypot(G.nodes[a].pt[0] - G.nodes[b].pt[0], G.nodes[a].pt[1] - G.nodes[b].pt[1]);
          if (d < bd) { bd = d; bi = i; }
        });
        var b2 = odd.splice(bi, 1)[0];
        E.push({ a: a, b: b2, pts: [G.nodes[a].pt, G.nodes[b2].pt], real: false });
        adj[a].push(E.length - 1); adj[b2].push(E.length - 1);
      }
      var start = mine.reduce(function (m, v) { return G.nodes[v].deg > G.nodes[m].deg ? v : m; }, mine[0]);
      // Hierholzer: the circuit as (node, edge taken into it)
      var used = new Uint8Array(E.length), ptr = {}, stack = [{ v: start, e: -1 }], circ = [];
      while (stack.length) {
        var top = stack[stack.length - 1], l = adj[top.v], k = ptr[top.v] || 0;
        while (k < l.length && used[l[k]]) k++;
        ptr[top.v] = k;
        if (k < l.length) {
          var ei = l[k]; used[ei] = 1;
          stack.push({ v: E[ei].a === top.v ? E[ei].b : E[ei].a, e: ei });
        } else circ.push(stack.pop());
      }
      circ.reverse();                                      // circ[0] = start, circ[i].e leads circ[i-1] -> circ[i]
      var steps = [];
      for (var q = 1; q < circ.length; q++) steps.push({ from: circ[q - 1].v, to: circ[q].v, e: circ[q].e });
      if (open) {                                          // begin right after a stand-in, cut at each
        var r0 = steps.findIndex(function (st2) { return !E[st2.e].real; });
        steps = steps.slice(r0 + 1).concat(steps.slice(0, r0 + 1));
      }
      var runs = [], run = [];
      steps.forEach(function (st3) {
        if (E[st3.e].real) run.push(st3); else { if (run.length) runs.push(run); run = []; }
      });
      if (run.length) runs.push(run);
      runs.forEach(function (rn) {
        var s0 = rn[0].from, s1 = rn[rn.length - 1].to;
        if (open && G.nodes[s1].deg > G.nodes[s0].deg) {
          rn = rn.slice().reverse().map(function (st4) { return { from: st4.to, to: st4.from, e: st4.e }; });
        }
        var pts = [], fixed = [];
        rn.forEach(function (st5, i) {
          var ed = E[st5.e];
          var seg = ed.a === st5.from ? ed.pts : ed.pts.slice().reverse();
          for (var m = i === 0 ? 0 : 1; m < seg.length; m++) { pts.push(seg[m]); fixed.push(m === 0 || m === seg.length - 1); }
        });
        var closed = !open && rn.length && rn[0].from === rn[rn.length - 1].to;
        if (closed) { pts.pop(); fixed.pop(); }
        out.push({ closed: !!closed, pts: pts, fixed: fixed, endDeg: [G.nodes[rn[0].from].deg, G.nodes[rn[rn.length - 1].to].deg] });
      });
    }
    return out;
  }

  /** Distance from q along unit dir to the first boundary edge it meets (Infinity if none). */
  function rayToEdges(q, dir, edges) {
    var best = Infinity;
    for (var e = 0; e < edges.length; e += 2) {
      var A = edges[e], B = edges[e + 1];
      var sx = B[0] - A[0], sy = B[1] - A[1], den = dir[0] * sy - dir[1] * sx;
      if (Math.abs(den) < 1e-12) continue;
      var t = ((A[0] - q[0]) * sy - (A[1] - q[1]) * sx) / den;
      var u = ((A[0] - q[0]) * dir[1] - (A[1] - q[1]) * dir[0]) / den;
      if (t > 0 && u >= 0 && u <= 1 && t < best) best = t;
    }
    return best;
  }
  function distToEdges(q, edges) {
    var best = Infinity;
    for (var e = 0; e < edges.length; e += 2) {
      var A = edges[e], B = edges[e + 1], dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
      var t = L2 > 0 ? Math.max(0, Math.min(1, ((q[0] - A[0]) * dx + (q[1] - A[1]) * dy) / L2)) : 0;
      var d = Math.hypot(q[0] - A[0] - t * dx, q[1] - A[1] - t * dy);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * A free end, flush: on the line of its last segment, half the local width
   * short of the island's edge ahead (the local width read one bead back).
   */
  function trimEnds(pa, all, w, restPolys) {
    if (pa.closed || pa.pts.length < 2) return;
    var P = pa.pts, n = P.length, ends = [null, null];
    [0, 1].forEach(function (side) {
      if (pa.endDeg[side] !== 1) return;
      var e = side === 0 ? P[0] : P[n - 1], f = side === 0 ? P[1] : P[n - 2];
      var L = Math.hypot(e[0] - f[0], e[1] - f[1]);
      if (!(L > 1e-9)) return;
      var dir = [(e[0] - f[0]) / L, (e[1] - f[1]) / L];
      var back = Math.min(L / 2, w);
      var half = distToEdges([e[0] - dir[0] * back, e[1] - dir[1] * back], all);
      var ahead = rayToEdges(f, dir, all);
      if (!isFinite(ahead) || !isFinite(half)) return;
      var hit = [f[0] + dir[0] * ahead, f[1] + dir[1] * ahead];
      // an end that meets a walled part runs on into it, to its outer wall's centre
      var t = restPolys.length && inside(restPolys, hit[0], hit[1]) ? ahead + w / 2 : Math.max(L / 2, ahead - half);
      ends[side] = [f[0] + dir[0] * t, f[1] + dir[1] * t];
    });
    // both ends from the points as traced (a two-point path's ends are each other's)
    if (ends[0]) P[0] = ends[0];
    if (ends[1]) P[n - 1] = ends[1];
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
                 role: ob.role === 'support' ? 'support' : 'part', key: ob.key, hostKey: ob.hostKey,
                 thin: ob.detectThinWall != null ? !!ob.detectThinWall
                   : (ob.role === 'support' ? CONSTANTS.thinWall.supportsOn : !!o.detectThinWall),
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
          // Detect thin wall: the thin islands come out of the region and
          // print as their centre passes; with none, the region is as it was
          var thin = P.thin ? thinWalls(g, region, o) : null;
          var per = perimeters(g, thin ? thin.rest : region, h, o, o.onlyOneWallTop ? above : null);
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

          if (thin) {
            thin.paths.forEach(function (pa) {
              L.paths.push({ feature: 'Outer wall', width: o.outerWallWidthMm, closed: pa.closed, pts: pa.pts, thinWall: true });
            });
            L.thinWalls = thin.paths.length;
            if (!L.wallCount) L.wallCount = 1;
          }

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
      var withSupports = perObject.some(function (P) { return P.role === 'support'; });
      if (withSupports) typeSupports(g, perObject, planes, o, minOver);
      var overhang = perObject.map(function (P) {
        return overhangRegions(g, P, planes, linkMm, withSupports && P.role === 'part' ? coverFor(g, P, perObject, planes, o, minOver) : null);
      });

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
            id: P.id, name: P.name, flipped: P.flipped, nonSolid: P.nonSolid, role: P.role,
            support: P.sheet || null,
            triangles: P.mesh.triangles, degenerate: P.mesh.degenerate,
            sectionStats: st,
            wallCountHistogram: wc,
            layers: P.layers.map(function (L) {
              return {
                index: L.index, printZ: L.printZ, h: L.h, areaMm2: L.areaMm2,
                wallCount: L.wallCount || 0, wallLoopsByDepth: L.wallLoopsByDepth || [], thinWalls: L.thinWalls || 0,
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

  // ===========================================================================
  // Supports - a support object prints as support, and holds its host up
  // ===========================================================================

  /** Layers k whose underside (printZ - h) is within gap + one layer over layer i's top. */
  function layersOver(planes, i, gap) {
    var out = [];
    for (var k = i + 1; k < planes.length; k++) {
      var d = planes[k].printZ - planes[k].h - planes[i].printZ;
      if (d > gap + planes[i].h + 1e-6) break;
      if (d >= -1e-6) out.push(k);
    }
    return out;
  }

  /** Layers i whose top is within gap + one layer under layer k's underside. */
  function layersUnder(planes, k, gap) {
    var out = [];
    for (var i = k - 1; i >= 0; i--) {
      var d = planes[k].printZ - planes[k].h - planes[i].printZ;
      if (d > gap + planes[i].h + 1e-6) break;
      if (d >= -1e-6) out.push(i);
    }
    return out;
  }

  /** Share of a path's length whose edge midpoints fall inside `polys`. */
  function shareInside(path, polys) {
    if (!polys.length) return 0;
    var pts = path.pts, n = pts.length, m = path.closed ? n : n - 1;
    var all = 0, inn = 0;
    for (var i = 0; i < m; i++) {
      var p = pts[i], q = pts[(i + 1) % n];
      var l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      all += l;
      if (inside(polys, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2)) inn += l;
    }
    return all > 0 ? inn / all : 0;
  }

  /**
   * Type every line of every support object, and say what each one is.
   *
   * THE SHEET IS FOUND, NOT TAGGED. A support's TOP is the part of a layer
   * under one of its hosts' sections within gap + one layer above (the host's
   * underside), with nothing of the support itself over it: the islands of
   * the layer that reach under the host, closed by closeMm so a layer of
   * lines reads as the footprint it covers, less what is within closeMm of
   * the support's own next layer - but outside that layer's filled outline
   * only what is within half a line of it - opened by half a line (a strip
   * narrower than a line is an edge, not a top). A stair
   * (nso_support_interface.js, THE STAIR) is a top at every layer: each
   * strip's exposed edge lies under the part, outside the next strip, a
   * little up the slope - within closeMm of it, the next strip hid it. From each top down the sheet is
   * followed island by island - a layer's islands that overlap the sheet's on
   * the layer above, as each layer's lines cross the ones above (the bottom
   * transition layer runs tip to tip, past the top's footprint): the top 2
   * layers are Support interface, the 2 under them Support transition.
   * Every other line of the object is Support. A path takes the zone (the
   * islands, grown by half a line) holding most of its length.
   *
   * The host is the part the support names (hostKey = that part's key); a
   * support that names none in this slice is read against every part.
   * Writes P.host, P.footAt(i) (the closed layer, for the host's credit) and
   * P.sheet (the readout's numbers).
   */
  var OVER_STEP_MM = 0.1;
  function typeSupports(g, perObject, planes, o, minOver) {
    var C = CONSTANTS.supportSheet;
    var NI = C.interfaceLayers, NT = C.transitionLayers, R = C.closeMm;
    var gap = o.supportGapMm, w = o.outerWallWidthMm;
    /* a top may lie a layer further under the host than a sheet does: a
       stair's band stands its back edge up to 0.55 mm under the part (its
       width in whole beads), so the one a layer lands on can lie a layer
       further below it (C.stairLayers) */
    var stairH = (C.stairLayers || 0) * (planes.length ? planes[planes.length - 1].h : 0.2);
    var parts = perObject.filter(function (Q) { return Q.role !== 'support'; });
    var n = planes.length;
    perObject.forEach(function (P) {
      if (P.role !== 'support') return;
      var host = P.hostKey != null ? parts.find(function (Q) { return Q.key != null && Q.key === P.hostKey; }) || null : null;
      var hosts = host ? [host] : parts;
      P.host = host;
      var feet = [];
      P.footAt = function (i) {
        if (i < 0 || i >= n || g.isEmpty(P.S[i])) return g.empty();
        if (!feet[i]) feet[i] = g.offset(g.offset(P.S[i], R), -R);
        return feet[i];
      };
      var tops = [], held = {};
      /* a footprint with its holes filled: what lies OUTSIDE a layer, not in
         a channel of it */
      function filled(cs) {
        return g.isEmpty(cs) ? cs : g.of(g.polys(cs).filter(function (Pl) {
          var a2 = 0;
          for (var q = 0; q < Pl.length; q++) { var u = Pl[q], v = Pl[(q + 1) % Pl.length]; a2 += u[0] * v[1] - v[0] * u[1]; }
          return a2 > 0;
        }), 'Positive');
      }
      /* the part of layer i under the host's sections `over` - closed, less
         `cover` grown by half a line, opened by half a line */
      function topUnder(i, over, cover, grow, open) {
        if (open == null) open = w / 2;
        var H = g.unionAll(over.map(function (x) { return x.cs; }));
        // most layers reach under no host at all: one test, before the islands
        if (!(g.area(g.inter(P.S[i], H)) > 1e-6)) return null;
        var isl = g.parts(P.S[i]).filter(function (p) { return g.area(g.inter(p, H)) > 1e-6; });
        if (!isl.length) return null;
        var t = g.offset(g.offset(g.unionAll(isl), R), -R);
        t = g.diff(t, g.offset(cover, grow));
        t = g.dropSmall(g.offset(g.offset(t, -open), open), minOver);
        return g.isEmpty(t) ? null : t;
      }
      /* the part of a layer under the host that its next layer does not
         cover: within closeMm of that layer is covered (a flat sheet's I1,
         lines across, reaches past I2's closed footprint by more than half a
         line - the coupon's leg at z 6.00 read as a top, T T I I became
         T I I I); OUTSIDE the next layer's filled outline only a quarter line
         of it is, where that part lies under a slope (sloped(): a stair's next band stands
         a little up the slope, and closeMm of it hid the band's exposed
         edge) */
      function exposed(i, over) {
        var a = topUnder(i, over, P.footAt(i + 1), R), b = sloped(topUnder(i, over, filled(P.footAt(i + 1)), w / 4, w / 4), i);
        return a && b ? g.union(a, b) : a || b;
      }
      /* of a stair's tops (the two allowances: against a quarter line of the
         next layer and opened by a quarter line, as a band one line wide
         shows an edge narrower than a line - the arc at z 38.20: 0.33 mm),
         the islands under a SLOPED underside: the first layer of the part
         over one covers only some of it (a band's edge lies under the
         part's overhang, which steps up the slope a layer at a time), and it
         runs C.stairRunMm or more. Under a flat ceiling the first layer over
         it covers it whole - the coupon's leg at z 6.20, where the tops of
         two tips cut at the gap beside its sheet (2.3 x 0.8 mm) read as a
         top and made T T I I read T I I I. */
      function sloped(cs, i) {
        if (!cs) return null;
        var ks = layersOver(planes, i, gap + stairH);
        var keep = g.parts(cs).filter(function (pc) {
          var bb = [Infinity, Infinity, -Infinity, -Infinity], A = g.area(pc);
          g.polys(pc).forEach(function (Q) { Q.forEach(function (q) { bb[0] = Math.min(bb[0], q[0]); bb[1] = Math.min(bb[1], q[1]); bb[2] = Math.max(bb[2], q[0]); bb[3] = Math.max(bb[3], q[1]); }); });
          if (!(Math.max(bb[2] - bb[0], bb[3] - bb[1]) >= C.stairRunMm) || !(A > 0)) return false;
          for (var n = 0; n < ks.length; n++) {
            var cov = 0;
            hosts.forEach(function (Q) { if (!g.isEmpty(Q.S[ks[n]])) cov += g.area(g.inter(pc, Q.S[ks[n]])); });
            if (cov > 1e-6) return cov / A < C.stairCoverShare;
          }
          return false;
        });
        return keep.length ? g.unionAll(keep) : null;
      }
      function overAt(i, d) {
        var over = [];
        layersOver(planes, i, d).forEach(function (k) {
          hosts.forEach(function (Q) { if (!g.isEmpty(Q.S[k])) over.push({ Q: Q, cs: Q.S[k] }); });
        });
        return over;
      }
      for (var i = 0; i < n; i++) {
        tops.push(null);
        if (g.isEmpty(P.S[i])) continue;
        var over = overAt(i, gap);
        var t = over.length ? exposed(i, over) : null;
        /* A STAIR'S STRIP (C.stairLayers): a band whole beads wide, so the
           one a layer of the part lands on can lie a layer further
           under it than a sheet does - a top there too, where it is OUTSIDE
           the support's next layer (a flat sheet's I1 seen through a channel
           of I2 is not) */
        if (stairH > 0) {
          var deep = overAt(i, gap + stairH);
          if (deep.length > over.length) {
            var t2 = sloped(topUnder(i, deep, filled(P.footAt(i + 1)), w / 4, w / 4), i);
            if (t2) { t = t ? g.union(t, t2) : t2; over = deep; }
          }
        }
        if (!t) continue;
        tops[i] = t;
        over.forEach(function (x) { if (!g.isEmpty(g.inter(x.cs, t))) held[x.Q.id] = x.Q; });
      }
      // Each top down through its stack: a layer's islands that overlap the
      // sheet's islands on the layer above are the sheet's (each layer's lines
      // cross the ones above), for NI + NT layers; the islands under the last
      // that overlap it are its tips.
      var zones = P.layers.map(function () { return { i: [], t: [] }; });
      var sheets = [];
      tops.forEach(function (t, i0) {
        if (!t) return;
        var lvl = g.parts(P.S[i0]).filter(function (p) { return !g.isEmpty(g.inter(p, t)); });
        var lo = i0, m = 0, prevFoot = null;
        /* past NI + NT the transition runs on while a layer repeats the
           footprint of the one over it: a stair's strips stand several
           layers alike where the slope is steep (the run under a top is the
           same sheet, as T1 and T2 are) */
        for (; lvl.length; m++) {
          var j = i0 - m, U = g.unionAll(lvl), foot = g.offset(g.offset(U, R), -R);
          if (m >= NI + NT && !(prevFoot && g.area(g.diff(foot, prevFoot)) + g.area(g.diff(prevFoot, foot)) <= w * w)) break;
          (m < NI ? zones[j].i : zones[j].t).push(U);
          lo = j; prevFoot = foot;
          if (j - 1 < 0) { lvl = []; break; }
          lvl = g.parts(P.S[j - 1]).filter(function (p) { return g.area(g.inter(p, U)) > 1e-6; });
        }
        sheets.push({ topLayer: i0, zLo: planes[lo].printZ - planes[lo].h, zHi: planes[i0].printZ,
                      areaMm2: g.area(t), tips: m >= NI + NT ? lvl.length : 0 });
      });
      var counts = { 'Support': 0, 'Support transition': 0, 'Support interface': 0 };
      P.layers.forEach(function (L, j) {
        if (!L.paths.length) return;
        var zi = zones[j].i.length ? g.polys(g.offset(g.unionAll(zones[j].i), w / 2)) : [];
        var zt = zones[j].t.length ? g.polys(g.offset(g.unionAll(zones[j].t), w / 2)) : [];
        L.paths.forEach(function (p) {
          var si = zi.length ? shareInside(p, zi) : 0;
          var st = zt.length && si < 0.5 ? shareInside(p, zt) : 0;
          p.feature = si >= 0.5 ? 'Support interface' : (si + st >= 0.5 ? 'Support transition' : 'Support');
          counts[p.feature]++;
        });
      });
      /* OVERHANG, as a slicer types a wall: a line of the support whose
         centre leaves the layer under it - that layer read as the footprint it
         holds (closed by closeMm, as above), grown by half a line - is over
         air there. Each path's length over air (p.overhangMm, sampled every
         OVER_STEP_MM along it) and its spans over air, run by run
         (p.overhangRuns); a path with any is an overhang. Typing only: the
         G-code is the same. */
      var airN = { 'Support': 0, 'Support transition': 0, 'Support interface': 0 }, airMm = { 'Support': 0, 'Support transition': 0, 'Support interface': 0 };
      P.layers.forEach(function (L, j) {
        if (!L.paths.length || j === 0) return;
        var under = g.polys(g.offset(P.footAt(j - 1), w / 2)).map(function (Pl) {
          var b = [Infinity, Infinity, -Infinity, -Infinity];
          Pl.forEach(function (q) { b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); });
          return { pl: Pl, b: b };
        });
        function onUnder(x, y) {
          var inn = false;
          for (var k = 0; k < under.length; k++) {
            var u = under[k];
            if (x < u.b[0] || x > u.b[2] || y < u.b[1] || y > u.b[3]) continue;
            if (inside([u.pl], x, y)) inn = !inn;
          }
          return inn;
        }
        L.paths.forEach(function (p) {
          var pts = p.pts, m = p.closed ? pts.length : pts.length - 1, air = 0, runs = [], run = 0, first = null;
          for (var e = 0; e < m; e++) {
            var a = pts[e], b2 = pts[(e + 1) % pts.length], len = Math.hypot(b2[0] - a[0], b2[1] - a[1]);
            var ns = Math.max(1, Math.ceil(len / OVER_STEP_MM));
            for (var q = 0; q < ns; q++) {
              var t = (q + 0.5) / ns;
              if (!onUnder(a[0] + (b2[0] - a[0]) * t, a[1] + (b2[1] - a[1]) * t)) { air += len / ns; run += len / ns; }
              else if (run > 0) { if (first == null) first = runs.length; runs.push(run); run = 0; }
              else if (first == null) first = -1;
            }
          }
          /* a closed path's last run goes on into its first, where both lie over air */
          if (run > 0) { if (p.closed && first === 0 && runs.length) runs[0] += run; else runs.push(run); }
          p.overhangMm = air;
          /* the spans over air, each a run of the path between the things under it */
          p.overhangRuns = runs;
          if (air > 0) { airN[p.feature]++; airMm[p.feature] += air; }
        });
      });
      var heldBy = Object.keys(held).map(function (k) { return held[k]; });
      P.sheet = {
        hostName: host ? host.name : (heldBy.length ? heldBy.map(function (Q) { return Q.name; }).join(', ') : null),
        hostFound: !!host,
        sheets: sheets,
        tips: sheets.reduce(function (a, s) { return a + s.tips; }, 0),
        zLo: sheets.length ? Math.min.apply(null, sheets.map(function (s) { return s.zLo; })) : null,
        zHi: sheets.length ? Math.max.apply(null, sheets.map(function (s) { return s.zHi; })) : null,
        pathCounts: counts,
        overhangPaths: airN,
        overhangMm: airMm
      };
    });
  }

  /**
   * What holds part Q up: for its layer k, each support that holds Q (names
   * it, or names no part in this slice) with the closed layers whose tops
   * lie within gap + one layer under k's underside.
   */
  function coverFor(g, Q, perObject, planes, o, minOver) {
    var sups = perObject.filter(function (P) { return P.role === 'support' && (P.host === Q || !P.host); });
    if (!sups.length) return null;
    return {
      openMm: o.outerWallWidthMm / 2,
      minMm2: minOver,
      at: function (k) {
        var under = layersUnder(planes, k, o.supportGapMm);
        var out = [];
        sups.forEach(function (P) {
          var cs = g.unionAll(under.map(function (i) { return P.footAt(i); }));
          if (!g.isEmpty(cs)) out.push({ sup: P, cs: cs });
        });
        return out;
      }
    };
  }

  /**
   * Link each layer's overhang islands into 3D regions: an island belongs to
   * the region of any island on the layer below it touches. For each region,
   * also say what a support under it would stand on: its footprint against
   * everything of the object printed below its first layer ('plate' where
   * nothing is, 'model' where the piece itself is).
   *
   * `cover` (coverFor(), only when the slice holds supports): each island is
   * also cut by what the supports under it hold, layer by layer, and the
   * region says how much of its footprint is covered, by which support, and
   * what is left: the uncovered part opened by half a line and its islands
   * under the overhang floor dropped - a strip narrower than a line beside a
   * sheet is bridged by the first layer, as any overhang under that floor is.
   */
  function overhangRegions(g, P, planes, linkMm, cover) {
    var regions = [];
    var prev = [];      // [{ cs, region }]
    var coverCache = new Map();
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
                      min: [Infinity, Infinity], max: [-Infinity, -Infinity], open: null, by: {} };
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
          if (cover) {
            var held = coverAt(i);
            var rest = held.length ? g.diff(isl, g.unionAll(held.map(function (c) { return c.cs; }))) : isl;
            owner.open = owner.open ? g.union(owner.open, rest) : rest;
            held.forEach(function (c) {
              var piece = g.inter(isl, c.cs);
              if (g.isEmpty(piece)) return;
              var e = owner.by[c.sup.id] || (owner.by[c.sup.id] = { sup: c.sup, cs: null });
              e.cs = e.cs ? g.union(e.cs, piece) : piece;
            });
          }
          cur.push({ cs: isl, region: owner });
        });
      }
      prev = cur;
    }
    function coverAt(i) {
      if (!coverCache.has(i)) coverCache.set(i, cover.at(i));
      return coverCache.get(i);
    }
    return regions.map(function (r) {
      var belowAll = g.unionAll(P.S.slice(0, r.firstLayer));
      var fp = r.footprint;
      var fpA = g.area(fp);
      var onModel = g.area(g.inter(fp, belowAll));
      var out = {
        id: r.id, firstLayer: r.firstLayer, lastLayer: r.lastLayer, layers: r.layers,
        firstZ: r.firstZ, areaMm2: r.areaMm2, footprintMm2: fpA,
        footprintPolys: g.polys(fp),
        overPlateMm2: fpA - onModel, overModelMm2: onModel,
        standsOn: onModel <= 1e-6 ? 'plate' : (fpA - onModel <= 1e-6 ? 'model' : 'both'),
        min: r.min, max: r.max
      };
      if (cover) {
        // Nothing under it: all of it is uncovered, slivers and all.
        var any = Object.keys(r.by).length > 0;
        var open = any ? g.dropSmall(g.offset(g.offset(r.open, -cover.openMm), cover.openMm), cover.minMm2) : fp;
        var openA = any ? g.area(open) : fpA;
        out.uncoveredMm2 = openA;
        out.uncoveredPolys = g.polys(open);
        out.coveredMm2 = Math.max(0, fpA - openA);
        out.coveredBy = Object.keys(r.by).map(function (k) {
          return { id: r.by[k].sup.id, name: r.by[k].sup.name, mm2: g.area(r.by[k].cs) };
        }).sort(function (a, b) { return b.mm2 - a.mm2; });
      }
      return out;
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
      var need = ob.role === 'support' ? null
        : ob.overhang.filter(function (r) { return r.uncoveredMm2 == null || r.uncoveredMm2 > 0; }).length;
      var sp = ob.support;
      lines.push(ob.name + ': ' + hist + '; ' +
        (need == null ? 'support for ' + (sp.hostName || 'no piece in this slice') + ', ' + sp.tips + ' tip(s), ' +
          sp.sheets.length + ' sheet(s)' : need + ' support-need region(s)') +
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
    thinWalls: thinWalls,
    medialPaths: medialPaths,
    toGcode: toGcode,
    describe: describe,
    loadKernel: loadKernel,
    run: run
  };
});
