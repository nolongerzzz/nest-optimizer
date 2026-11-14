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
    // --- a support is hollow: the export's own overrides ---------------------
    supportWalls: {
      loops: 1, sparseDensity: 0, topShellLayers: 0, bottomShellLayers: 1,
      source: 'the two overrides every NSO support object carries in the Bambu project export (nso_support_interface.js SHEET.slicerSettings: ' +
              'wall_loops = 1, sparse_infill_density = 0%; docs/handoff/supports-no-infill.md) - a support is sliced with them on, as thinWall.supportsOn. Its shells: none on top (a ' +
              'trunk that narrows going up has a hair-thin top ring on every layer, which this slicer fills and Bambu does not: the trunk read as filled) and the first layer ' +
              'solid underneath (the pad), the one layer under a branch that leans out a bridge; no sparse island or narrow strip is printed solid (a trunk is a wall round a ' +
              'hollow, whatever its size)'
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

  /** A pattern by the name Bambu Studio's list gives it: this slicer's zigzag is its Rectilinear. */
  function patternLabel(p) { return p === 'zigzag' ? 'rectilinear' : p === 'archimedeanchords' ? 'archimedean chords' : p === 'hilbertcurve' ? 'hilbert curve' : p === 'octagramspiral' ? 'octagram spiral' : p === '3dhoneycomb' ? '3D honeycomb' : p === 'adaptivecubic' ? 'adaptive cubic' : p; }

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
      supportWidthMm: null,                // a support's plate (its interface and transition lines): support_line_width; null -> the infill's
      wallLoops: BAMBU_PROFILE_06.wallLoops,
      topShellLayers: BAMBU_PROFILE_06.topShellLayers,
      bottomShellLayers: BAMBU_PROFILE_06.bottomShellLayers,
      topShellThicknessMm: BAMBU_PROFILE_06.topShellThicknessMm,
      bottomShellThicknessMm: 0,
      sparseDensity: BAMBU_PROFILE_06.sparseDensity,
      sparsePattern: BAMBU_PROFILE_06.sparsePattern,   // 'grid' | 'zigzag' (Bambu's Rectilinear; 'rectilinear' is taken for it) | 'lines' | 'concentric' | 'archimedeanchords' | '3dhoneycomb' | 'gyroid' | 'cubic' | 'adaptivecubic' | 'honeycomb' | 'lightning'
      solidPattern: BAMBU_PROFILE_06.solidPattern,     // 'zigzag' | 'lines' | 'concentric' | 'archimedeanchords' | 'hilbertcurve' | 'octagramspiral': the internal solid infill, and the surfaces unless they say
      topPattern: null,                    // the top surface's own pattern ('concentric'); null -> solidPattern
      bottomPattern: null,                 // the first layer's own pattern ('concentric'); null -> solidPattern
      infillDirectionDeg: BAMBU_PROFILE_06.infillDirectionDeg,
      infillWallOverlap: BAMBU_PROFILE_06.infillWallOverlap,
      sliceClosingRadiusMm: BAMBU_PROFILE_06.sliceClosingRadiusMm,
      resolutionMm: BAMBU_PROFILE_06.resolutionMm,
      supportThresholdDeg: CONSTANTS.supportThresholdDeg.bambu,
      overhangMinAreaMm2: null,            // null -> one line width squared
      overhangEdgeFrac: 1,                 // a wall is Overhang wall when this share of its width hangs past the layer below: 1, the whole line (Bambu's: the six support heads' overhang length 44 / 41 / 103 / 83 mm against its 44 / 40 / 95 / 84); 0.5 is its centre, the rule before; null the same
      overhangSubMm: 0.2,                  // a wall edge is judged along its length at this step, not at its midpoint alone: a corner's ledge a few tenths of a mm long is an overhang wall (Bambu's, measured on the six support heads); 0/null: the midpoint only
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
      // A brim round a part's first layer (Bambu's brim_type / brim_width /
      // brim_object_gap: auto_brim, 5, 0.1 in the A1 mini and P1S profiles).
      // 'none' | 'auto' | 'outer'. Auto brims a part that is tall for its foot
      // (height over the root of its first layer's area at least
      // brimAutoRatio): the stem of a chalice, a tower. The brim stays
      // brimSupportGapMm off the first layer of every other object (a support's
      // pad): it meets the pad and does not join it. Off unless asked.
      brimType: 'none',
      brimWidthMm: 5,
      brimObjectGapMm: 0.1,
      brimLineWidthMm: null,               // null -> 1.25 x the nozzle (Bambu's first-layer line, 0.5 mm at 0.4)
      brimAutoRatio: 2,
      brimSupportGapMm: 0.02,
      supportLayerMaxMm: 0,                // 0 = supports are cut on the part's layers; 0.28 = on their own (Bambu's independent_support_layer_height): see sliceObjects
      supportInterfaceLayers: null,        // null -> CONSTANTS.supportSheet.interfaceLayers (2); a sheet of more says so
      supportInterfaceRule: null,          // 'column': the interface read off the part's layers column by column (columnRule; docs/SUPPORT-GATE.md); null: the sheet typing
      supportInterfaceSpacingMm: null,     // the gap between interface lines (Bambu's support_interface_spacing; the print planner reads the profile's): null -> the dense sheet's line + 0.04
      supportAngleDeg: 0,                  // Bambu's support_angle: the 'profile' stack's first layer turns this + 90
      bridgeAngleDeg: 0,                   // Bambu's bridge_angle: every Bridge laid at it (0: auto - over a support, Studio 02.09's 3.6 under the 'profile' / 'studio36' angles)
      supportInterfaceAngle: 'bridge',     // the column rule's stack angles (the app slices with the card's, 'profile' by default - app-print.js slicerOptions): 'profile' Bambu's own rule off the profile's support_angle / bridge_angle (its first layer at support_angle + 90, its top square to the bridge at bridge_angle - 0: Studio's 3.6 - one turn a layer down; the owner's 2x supp_ref at 20 / 45: 110, then 45 / 135 to a top at 135); 'bridge' its top square to the part's bridge over it; 'studio36' Studio 02.09's own (90, then 93.6 / 3.6 up to a top at 93.6, the part's bridges over supports at 3.6 - the owner's P1S print released clean); 'crosshatch' 110, then 45 / 135
      supportXyMm: 0.35,                   // the column rule's xy distance to the part at a support layer's own height (Bambu's support_object_xy_distance)
      /* BAMBU'S ADVANCED SUPPORT ROWS (docs/SUPPORT-ADVANCED.md). Each default is what this slicer did before the row existed. */
      supportBottomGapMm: null,            // support_bottom_z_distance: a support's layer keeps this far over a top face of the part under it (null: the support's mesh as built)
      supportZOverridesXy: false,          // top_z_overrides_xy_distance: under an overhang the support comes in to COLUMN_Z_OVER_XY_MM of the wall beside it, not the xy distance - the top distance decides
      supportInterfacePattern: 'default',  // support_interface_pattern: 'default' (the angle rule above) | 'rectilinear' (one direction) | 'rectilinear_interlaced' (a quarter turn a layer) | 'grid' (both, each layer) | 'concentric'
      supportBasePattern: 'default',       // support_base_pattern: 'default' (a line across each ring under a stack) | 'hollow' (walls alone) | 'rectilinear' | 'rectilinear-grid' (lines through the whole tree)
      supportBaseSpacingMm: 2.5,           // support_base_pattern_spacing: the base pattern's lines this far apart
      supportWallLoops: -1,                // tree_support_wall_count: -1 (or 0) automatic - one; else that many
      supportFirstLayerDensity: 1,         // raft_first_layer_density: a support's first layer filled this dense (1: solid)
      supportFirstLayerGapMm: null,        // support_object_first_layer_gap: a support's first layer this far from the part's (null: as built)
      supportExpansionMm: 0,               // support_expansion: the stack reaches this much further past an overhang's edge (or less far, negative)
      weldMm: 1e-4,
      dropToPlate: true,
      filamentDiameterMm: CONSTANTS.flow.filamentDiameterMm,
      emitGcode: true
    };
    if (over) Object.keys(over).forEach(function (k) { if (over[k] !== undefined) o[k] = over[k]; });
    /* rectilinear is Bambu's name for these lines (its profile's value: zig-zag): one name inside */
    ['sparsePattern', 'solidPattern', 'topPattern', 'bottomPattern'].forEach(function (k) { if (o[k] === 'rectilinear' || o[k] === 'zig-zag') o[k] = 'zigzag'; });
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
    var n = Math.floor(soup.length / 9), nIn = n * 3;
    /* the grid is an open-addressed table of cells keyed by their three integer coordinates (a string key per lookup was most of a big part's
       slice); each cell's points are a list in the order they were added, searched in the same order as before - the same V and T */
    var cap = 1; while (cap < nIn * 2) cap <<= 1;
    var mask = cap - 1;
    var kx = new Int32Array(cap), ky = new Int32Array(cap), kz = new Int32Array(cap), head = new Int32Array(cap).fill(-1), tail = new Int32Array(cap);
    var next = new Int32Array(Math.max(1, nIn));
    var V = new Float64Array(Math.max(3, nIn * 3)), nv = 0, T = new Int32Array(n * 3);
    var inv = 1 / q, q2 = q * q;
    function slot(cx, cy, cz) {
      var h = (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) & mask;
      while (head[h] >= 0 && (kx[h] !== cx || ky[h] !== cy || kz[h] !== cz)) h = (h + 1) & mask;
      return h;
    }
    for (var i = 0; i < nIn; i++) {
      var x = soup[i * 3], y = soup[i * 3 + 1], z = soup[i * 3 + 2];
      var cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
      var id = -1;
      for (var a = -1; a <= 1 && id < 0; a++) {
        for (var b = -1; b <= 1 && id < 0; b++) {
          for (var c = -1; c <= 1 && id < 0; c++) {
            var hs = slot(cx + a, cy + b, cz + c);
            for (var k = head[hs]; k >= 0; k = next[k]) {
              var j = k * 3, dx = V[j] - x, dy = V[j + 1] - y, dz = V[j + 2] - z;
              if (dx * dx + dy * dy + dz * dz <= q2) { id = k; break; }
            }
          }
        }
      }
      if (id < 0) {
        id = nv++;
        V[id * 3] = x; V[id * 3 + 1] = y; V[id * 3 + 2] = z;
        next[id] = -1;
        var h0 = slot(cx, cy, cz);
        if (head[h0] < 0) { head[h0] = id; tail[h0] = id; kx[h0] = cx; ky[h0] = cy; kz[h0] = cz; } else { next[tail[h0]] = id; tail[h0] = id; }
      }
      T[i] = id;
    }
    return { V: V.slice(0, nv * 3), T: T, nv: nv, nt: n };
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
  /**
   * A soup welded once (indexSoup) with each triangle's z range: what
   * sliceMesh reads, kept so a mesh cut again and again at heights of its own
   * (makeP's exactAt: the support typing asks one height at a time, hundreds of
   * times a plate) is not welded again for every cut. Same V / T, same bytes.
   */
  function prepSoup(soup, q) {
    var M = indexSoup(soup, q), V = M.V, T = M.T;
    var lo = new Float64Array(M.nt), hi = new Float64Array(M.nt), live = new Uint8Array(M.nt), degenerate = 0;
    for (var t = 0; t < M.nt; t++) {
      var a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
      if (a === b || b === c || a === c) { degenerate++; continue; }
      var za = V[a * 3 + 2], zb = V[b * 3 + 2], zc = V[c * 3 + 2];
      live[t] = 1; lo[t] = Math.min(za, zb, zc); hi[t] = Math.max(za, zb, zc);
    }
    return { soup: soup, q: q, M: M, lo: lo, hi: hi, live: live, degenerate: degenerate };
  }

  function sliceMesh(soup, planes, opts, pre) {
    var q = opts && opts.weldMm > 0 ? opts.weldMm : 1e-4;
    var gapClose = opts && opts.gapCloseMm != null ? opts.gapCloseMm : 2;
    if (!pre || pre.soup !== soup || pre.q !== q) pre = prepSoup(soup, q);
    var M = pre.M, V = M.V, T = M.T, nv = M.nv, LO = pre.lo, HI = pre.hi, LIVE = pre.live;
    var zs = planes.map(function (p) { return p.sliceZ; });
    var buckets = planes.map(function () { return []; });
    var degenerate = pre.degenerate;
    for (var t = 0; t < M.nt; t++) {
      if (!LIVE[t]) continue;
      // planes with lo < z <= hi can be crossed (vertex on the plane = above)
      var i0 = firstAbove(zs, LO[t]), i1 = firstAbove(zs, HI[t]) - 1;
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
    /* THE OPERATIONS ARE KEPT BY THEIR INPUTS. A section is never changed once made, so an operation asked again of the same sections (by identity)
       and the same numbers returns what it returned the first time - the same object, the same bytes. The support typing asks the host's layers
       the same unions, offsets and cuts for every support layer and every support on it (supp_ref_2x: most of its typing). Cleared by free(). */
    var ids = new WeakMap(), nextId = 0, opMemo = new Map();
    function idOf(x) { var v = ids.get(x); if (v == null) { v = ++nextId; ids.set(x, v); } return v; }
    function memo(key, make) { var r = opMemo.get(key); if (r === undefined) { r = make(); opMemo.set(key, r); } return r; }
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
        return memo('o' + idOf(cs) + ',' + d + ',' + (join || 'Miter') + ',' + (miter || 3), function () { return keep(cs.offset(d, join || 'Miter', miter || 3, 0)); });
      },
      union: function (a, b) { return memo('u' + idOf(a) + ',' + idOf(b), function () { return keep(a.add(b)); }); },
      unionAll: function (list) {
        var l = list.filter(function (x) { return x && !x.isEmpty(); });
        if (!l.length) return g.empty();
        if (l.length === 1) return l[0];
        return memo('U' + l.map(idOf).join(','), function () { return keep(CS.union(l)); });
      },
      diff: function (a, b) { return b.isEmpty() ? a : memo('d' + idOf(a) + ',' + idOf(b), function () { return keep(a.subtract(b)); }); },
      inter: function (a, b) { return memo('i' + idOf(a) + ',' + idOf(b), function () { return keep(a.intersect(b)); }); },
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
        return memo('s' + idOf(cs) + ',' + minArea, function () {
          var parts = g.parts(cs).filter(function (p) { return p.area() >= minArea; });
          return g.unionAll(parts);
        });
      },
      free: function () {
        for (var i = 0; i < arena.length; i++) { try { arena[i].delete(); } catch (e) { /* freed */ } }
        arena.length = 0;
        opMemo.clear();
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
  /**
   * inside(polys, x, y) for many points against the same polygons: each edge filed under the horizontal bands it spans, so a point is tested
   * against the edges of its band only. An edge that does not span the point's y never toggles the crossing count, and the edges that do are tested
   * by inside's own expression, so every answer is inside's.
   */
  function insideIndex(polys) {
    var ex = [], ymin = Infinity, ymax = -Infinity;
    for (var p = 0; p < polys.length; p++) {
      var poly = polys[p];
      for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        var yi = poly[i][1], yj = poly[j][1];
        if (yi === yj) continue;                       /* (yi > y) !== (yj > y) is never true */
        ex.push(poly[i][0], yi, poly[j][0], yj);
        if (yi < ymin) ymin = yi; if (yi > ymax) ymax = yi; if (yj < ymin) ymin = yj; if (yj > ymax) ymax = yj;
      }
    }
    var ne = ex.length / 4;
    if (!ne) return function () { return false; };
    var nb = Math.max(1, Math.min(4096, Math.ceil(ne / 4))), bh = (ymax - ymin) / nb || 1;
    var band = function (y) { var b = Math.floor((y - ymin) / bh); return b < 0 ? 0 : b >= nb ? nb - 1 : b; };
    var lists = [];
    for (var b = 0; b < nb; b++) lists.push([]);
    for (var e = 0; e < ne; e++) {
      var y0 = ex[e * 4 + 1], y1 = ex[e * 4 + 3], b0 = band(Math.min(y0, y1)), b1 = band(Math.max(y0, y1));
      for (var bb = b0; bb <= b1; bb++) lists[bb].push(e);
    }
    return function (x, y) {
      if (!(y >= ymin && y < ymax)) return false;
      var L = lists[band(y)], inn = false;
      for (var k = 0; k < L.length; k++) {
        var e4 = L[k] * 4, xi = ex[e4], yi = ex[e4 + 1], xj = ex[e4 + 2], yj = ex[e4 + 3];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inn = !inn;
      }
      return inn;
    };
  }

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
  /* Bambu's zig-zag down a narrow ribbon: the strokes taken in order along it, each starting on the side the last one ended (its connector runs along that edge, a line's pitch long),
     not the nearest end (which strings the strokes all one way with a short cross-over between). */
  function serpentine(segs, axisAng, maxLen) {
    var ca = Math.cos(axisAng), sa = Math.sin(axisAng), paths = [], path = null, prev = null;
    var tOf = function (p) { return p[0] * ca + p[1] * sa; }, nOf = function (p) { return -p[0] * sa + p[1] * ca; };
    var list = segs.slice().sort(function (u, v) { return (tOf(u.a) + tOf(u.b)) - (tOf(v.a) + tOf(v.b)); });
    list.forEach(function (sg) {
      var s0 = sg.a, s1 = sg.b;
      if (prev) { if (Math.abs(nOf(sg.b) - nOf(prev)) < Math.abs(nOf(sg.a) - nOf(prev))) { s0 = sg.b; s1 = sg.a; } }
      else if (nOf(s0) < nOf(s1)) { var tmp = s0; s0 = s1; s1 = tmp; }
      var dx = prev ? s0[0] - prev[0] : 0, dy = prev ? s0[1] - prev[1] : 0;
      if (path && Math.hypot(dx, dy) <= maxLen) path.pts.push(s0, s1);
      else { path = { closed: false, pts: [s0, s1] }; paths.push(path); }
      prev = s1;
    });
    return paths;
  }
  /** A closed ring smoothed along its length: resampled every 0.12 mm and averaged over a Gaussian window of sigma mm (a loop that follows a dome's section, which the union of the part's layers
   *  makes a scallop 0.1 mm deep every millimetre, is the polygon Bambu's mesh section is). A ring shorter than 6 sigma is left. */
  function smoothRing(ring, sigma) {
    var n = ring.length, step = 0.12, L = 0, i, seg = [];
    for (i = 0; i < n; i++) { var a = ring[i], b = ring[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]); seg.push(l); L += l; }
    if (L < 6 * sigma + 1e-6) return ring;
    var m = Math.max(8, Math.round(L / step)), ds = L / m, pts = [], k = 0, acc = 0;
    for (i = 0; i < m; i++) {
      var t = i * ds;
      while (acc + seg[k] < t - 1e-12 && k < n - 1) { acc += seg[k]; k++; }
      var a2 = ring[k], b2 = ring[(k + 1) % n], u = seg[k] > 0 ? (t - acc) / seg[k] : 0;
      pts.push([a2[0] + (b2[0] - a2[0]) * u, a2[1] + (b2[1] - a2[1]) * u]);
    }
    var half = Math.ceil(3 * sigma / ds), wts = [], ws = 0;
    for (i = -half; i <= half; i++) { var wv = Math.exp(-0.5 * (i * ds / sigma) * (i * ds / sigma)); wts.push(wv); ws += wv; }
    var out = [];
    for (i = 0; i < m; i++) {
      var sx = 0, sy = 0;
      for (var q = -half; q <= half; q++) { var p = pts[((i + q) % m + m) % m], wq = wts[q + half]; sx += p[0] * wq; sy += p[1] * wq; }
      out.push([sx / ws, sy / ws]);
    }
    var closed = out.concat([out[0]]), keep = simplifyIdx(closed, 0.01), res = [];            /* the moves are as long as Bambu's, not one per 0.12 mm */
    keep.forEach(function (ix) { if (ix < out.length) res.push(out[ix]); });
    return res.length >= 3 ? res : out;
  }

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
  // Concentric fill - rings that follow the region's outline
  // ===========================================================================

  /* Measured on a real Bambu Studio 02.09 slice (concentric.gcode.3mf: ten flat shapes, A1 mini, 0.4 nozzle, 0.2 layers, every surface and the
     solid infill concentric; docs/SLICER.md "Concentric"):
       - the outermost ring lies half a line spacing inside the fill region, each next one a whole spacing further in (0.377 at 0.42 / 0.2, 0.457
         at the first layer's 0.5): every ring but the innermost has the nominal width;
       - the middle takes up what the spacing does not divide: the beads across the region are its width over the spacing, rounded, and the last
         one or two share the remainder - an even count ends in a ring wider or narrower than the rest (0.354 - 0.63 against 0.42 / 0.5), an odd
         count in one line down the middle (0.55 - 0.69);
       - the rings print from the middle outward, each starting beside the last one's start (the seams in a row). */
  var CONCENTRIC_DOT_MM = 0.1;        // a middle with no length (a disc's) is a dot this long: the reference's is 0.11
  var CONCENTRIC_WIDTH_STEP_MM = 0.04; // a middle line's width follows the room along it in steps (the reference's: 0.556, 0.600, 0.643, 0.686)

  /** How deep a piece is: the largest inset that leaves something of it, within (0, hi]. */
  function insetDepth(g, cs, hi) {
    var lo = 0;
    for (var k = 0; k < 14; k++) {
      var mid = (lo + hi) / 2;
      if (g.isEmpty(g.offset(cs, -mid))) hi = mid; else lo = mid;
    }
    return lo;
  }

  /** Distance from a point to the outline of polys. */
  function outlineDistance(polys, x, y) {
    var best = Infinity;
    for (var k = 0; k < polys.length; k++) {
      var P = polys[k], n = P.length;
      for (var i = 0; i < n; i++) {
        var a = P[i], b = P[(i + 1) % n];
        var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
        var t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
        var d = Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
        if (d < best) best = d;
      }
    }
    return best;
  }

  /** A closed ring turned to start at its point nearest `at` (a new vertex where that falls inside an edge). */
  function ringFrom(pts, at) {
    var n = pts.length, best = Infinity, bi = 0, bt = 0;
    for (var i = 0; i < n; i++) {
      var a = pts[i], b = pts[(i + 1) % n];
      var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
      var t = l2 > 0 ? Math.max(0, Math.min(1, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dy) / l2)) : 0;
      var d = Math.hypot(at[0] - a[0] - t * dx, at[1] - a[1] - t * dy);
      if (d < best) { best = d; bi = i; bt = t; }
    }
    var out = [], a0 = pts[bi], b0 = pts[(bi + 1) % n];
    if (bt > 1e-6 && bt < 1 - 1e-6) out.push([a0[0] + bt * (b0[0] - a0[0]), a0[1] + bt * (b0[1] - a0[1])]);
    else if (bt <= 1e-6) bi = (bi + n - 1) % n;
    for (var k = 1; k <= n; k++) out.push(pts[(bi + k) % n]);
    return out;
  }

  /**
   * A region filled with rings parallel to its outline -> [{ closed, pts, width }], in print order (from each middle outward).
   *   w, h      the line's width and the layer's height
   *   pitch     ring to ring; the bead spacing for a solid fill, wider for a sparse one
   *   solid     the middle shares out the remainder (above); a sparse fill's rings stop where the next does not fit
   *   startAt   where the nozzle comes from, for the first seam
   */
  function concentricFill(g, cs, w, h, pitch, solid, startAt) {
    if (g.isEmpty(cs)) return [];
    var s = spacingOf(w, h), fat = w - s, out = [];
    var rings = function (c, inset, width) {
      g.polys(g.offset(c, -inset)).forEach(function (pl) { if (pl.length > 2) out.push({ closed: true, pts: pl, width: width }); });
    };
    /* one line down the middle of a piece 2r across at its widest, as wide as the room along it */
    var middle = function (c, r) {
      var polys = g.polys(c), wMid = 2 * r + fat;
      var med = medialPaths(polys, wMid, []);
      if (!med) {
        var core = g.polys(g.offset(c, -r * 0.98))[0] || polys[0], cx = 0, cy = 0;
        core.forEach(function (q) { cx += q[0] / core.length; cy += q[1] / core.length; });
        out.push({ closed: false, pts: [[cx - CONCENTRIC_DOT_MM / 2, cy], [cx + CONCENTRIC_DOT_MM / 2, cy]], width: wMid });
        return;
      }
      med.forEach(function (pa) {
        var pts = pa.closed ? pa.pts.concat([pa.pts[0]]) : pa.pts, run = null;
        for (var i = 0; i + 1 < pts.length; i++) {
          var a = pts[i], b = pts[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (2 * w)));
          for (var k = 0; k < n; k++) {
            var p0 = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n], p1 = [a[0] + (b[0] - a[0]) * (k + 1) / n, a[1] + (b[1] - a[1]) * (k + 1) / n];
            var room = 2 * outlineDistance(polys, (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
            var wk = room < 0.5 * s ? 0 : Math.round((Math.min(room, 2 * r) + fat) / CONCENTRIC_WIDTH_STEP_MM) * CONCENTRIC_WIDTH_STEP_MM;
            if (Math.abs(wk - wMid) < CONCENTRIC_WIDTH_STEP_MM) wk = wMid;
            if (run && run.width === wk) run.pts.push(p1);
            else { run = wk > 0 ? { closed: false, pts: [p0, p1], width: wk } : null; if (run) out.push(run); }
          }
        }
      });
    };
    /* the beads across a middle x spacings wide: a pair of rings takes up to 2.75 before a line goes between them (the reference's hexagon top
       keeps two at 2.50; its rectangle's first layer has two at 1.70) */
    var beads = function (x) { return x < 0.5 ? 0 : x < 1.5 ? 1 : x < 2.75 ? 2 : x < 3.5 ? 3 : 4; };
    /* a piece less than a spacing deep: nothing, a line, or one ring of its own width */
    var last = function (c, r) {
      var n = beads(2 * r / s);
      if (n === 1) middle(c, r);
      else if (n >= 2) rings(c, r / 2, r + fat);
    };
    var fill = function (c) {
      if (solid && g.isEmpty(g.offset(c, -2 * s))) {
        var r = insetDepth(g, c, 2 * s);
        if (beads(2 * r / s) <= 2) { last(c, r); return; }
        g.parts(g.offset(c, -s)).forEach(function (d) { last(d, insetDepth(g, d, s)); });
        rings(c, s / 2, w);
        return;
      }
      var ring = g.offset(c, -s / 2);
      if (g.isEmpty(ring)) return;
      g.parts(g.offset(c, -pitch)).forEach(fill);
      rings(c, s / 2, w);
    };
    g.parts(cs).forEach(fill);
    var cur = startAt || null;
    out.forEach(function (p) {
      if (p.closed) { if (cur) p.pts = ringFrom(p.pts, cur); cur = p.pts[0]; }
      else {
        var e = p.pts[p.pts.length - 1];
        if (cur && Math.hypot(e[0] - cur[0], e[1] - cur[1]) < Math.hypot(p.pts[0][0] - cur[0], p.pts[0][1] - cur[1])) p.pts.reverse();
        cur = p.pts[p.pts.length - 1];
      }
    });
    return out;
  }

  // ===========================================================================
  // Archimedean chords - one spiral, cut to the region
  // ===========================================================================

  /* Measured on a real Bambu Studio 02.09 slice (archimedeanchords.gcode.3mf: the ten shapes of the concentric plate, 9.8 mm tall, every pattern
     Archimedean chords; docs/SLICER.md "Archimedean chords"):
       - one spiral a fill: from its centre a straight stroke one pitch long at 135 degrees, then counter-clockwise outward, a pitch further out
         with every turn - the same on every layer (it is not turned with the layer);
       - the pitch is the bead spacing in a solid fill (0.377 at 0.42 / 0.2) and the spacing over the density in a sparse one (2.713 at 0.45, 15 %);
       - a solid fill's centre is the middle of the region's box in the frame turned 45 degrees (the infill direction); a sparse fill's is the
         middle of the object's own box, so every sparse layer lies on the one below;
       - the spiral is cut where it leaves the region; in a sparse fill the cut ends are joined along the walls. */
  var SPIRAL_START_DEG = 135;
  var SPIRAL_SAG_MM = 0.01;           // the spiral as a polyline: no further than this from the true curve

  /** The middle of polys' bounding box in the frame turned by angle (rad). */
  function turnedBoxCentre(polys, angle) {
    var c = Math.cos(angle), s = Math.sin(angle), u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    polys.forEach(function (P) { P.forEach(function (q) {
      var u = q[0] * c + q[1] * s, v = -q[0] * s + q[1] * c;
      if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
    }); });
    var um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
    return [um * c - vm * s, um * s + vm * c];
  }

  /**
   * An open polyline cut to the inside of polys (even-odd) -> its pieces in the line's own order:
   * [{ pts, a, b }], a / b where the piece starts / ends on the outline ({ p: polygon, e: edge, t: along it }) or null (the line's own end).
   */
  function clipLine(pts, polys) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, ne = 0;
    polys.forEach(function (P) { ne += P.length; P.forEach(function (q) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }); });
    if (!ne || pts.length < 2) return [];
    /* the outline's edges on a grid, so a segment meets only the edges near it */
    var cell = Math.max(0.5, Math.sqrt((x1 - x0) * (y1 - y0) / Math.max(1, ne)) * 2), nx = Math.max(1, Math.ceil((x1 - x0) / cell)), ny = Math.max(1, Math.ceil((y1 - y0) / cell));
    var grid = new Map(), cx = function (x) { var i = Math.floor((x - x0) / cell); return i < 0 ? 0 : i >= nx ? nx - 1 : i; }, cy = function (y) { var j = Math.floor((y - y0) / cell); return j < 0 ? 0 : j >= ny ? ny - 1 : j; };
    var E = [];
    polys.forEach(function (P, pi) {
      for (var e = 0; e < P.length; e++) {
        var a = P[e], b = P[(e + 1) % P.length], id = E.length;
        E.push({ p: pi, e: e, a: a, b: b });
        for (var i = cx(Math.min(a[0], b[0])); i <= cx(Math.max(a[0], b[0])); i++) for (var j = cy(Math.min(a[1], b[1])); j <= cy(Math.max(a[1], b[1])); j++) {
          var k = j * nx + i, l = grid.get(k);
          if (!l) grid.set(k, l = []);
          l.push(id);
        }
      }
    });
    var isIn = insideIndex(polys), seen = new Int32Array(E.length).fill(-1), out = [], cur = null;
    for (var n = 0; n + 1 < pts.length; n++) {
      var A = pts[n], B = pts[n + 1], dx = B[0] - A[0], dy = B[1] - A[1];
      if (Math.max(A[0], B[0]) < x0 || Math.min(A[0], B[0]) > x1 || Math.max(A[1], B[1]) < y0 || Math.min(A[1], B[1]) > y1) { if (cur) { out.push(cur); cur = null; } continue; }
      var cuts = [];
      for (var i2 = cx(Math.min(A[0], B[0])); i2 <= cx(Math.max(A[0], B[0])); i2++) for (var j2 = cy(Math.min(A[1], B[1])); j2 <= cy(Math.max(A[1], B[1])); j2++) {
        var l2 = grid.get(j2 * nx + i2);
        if (!l2) continue;
        for (var q = 0; q < l2.length; q++) {
          var id2 = l2[q];
          if (seen[id2] === n) continue;
          seen[id2] = n;
          var ed = E[id2], ex = ed.b[0] - ed.a[0], ey = ed.b[1] - ed.a[1], den = dx * ey - dy * ex;
          if (Math.abs(den) < 1e-14) continue;
          var t = ((ed.a[0] - A[0]) * ey - (ed.a[1] - A[1]) * ex) / den, u = ((ed.a[0] - A[0]) * dy - (ed.a[1] - A[1]) * dx) / den;
          if (t > 0 && t < 1 && u >= 0 && u < 1) cuts.push({ t: t, p: ed.p, e: ed.e, u: u });
        }
      }
      cuts.sort(function (c1, c2) { return c1.t - c2.t; });
      var t0 = 0, h0 = null;
      for (var c = 0; c <= cuts.length; c++) {
        var t1 = c < cuts.length ? cuts[c].t : 1, h1 = c < cuts.length ? cuts[c] : null;
        if (t1 - t0 > 1e-12) {
          var tm = (t0 + t1) / 2;
          if (isIn(A[0] + dx * tm, A[1] + dy * tm)) {
            if (!cur) cur = { pts: [[A[0] + dx * t0, A[1] + dy * t0]], a: h0 ? { p: h0.p, e: h0.e, t: h0.u } : null, b: null };
            cur.pts.push([A[0] + dx * t1, A[1] + dy * t1]);
            cur.b = h1 ? { p: h1.p, e: h1.e, t: h1.u } : null;
          } else if (cur) { out.push(cur); cur = null; }
        }
        t0 = t1; h0 = h1;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /**
   * A polygon's outline as a track: where a hit lies along it, and the points passed walking it.
   *   pos(h)            mm from vertex 0 to the hit { e, t }
   *   walk(h, dir, d)   the points from the hit on, d mm the way dir (+1 with the vertices, -1 against), the hit itself left out
   */
  function outlineTrack(P) {
    var n = P.length, cum = [0];
    for (var i = 0; i < n; i++) cum.push(cum[i] + Math.hypot(P[(i + 1) % n][0] - P[i][0], P[(i + 1) % n][1] - P[i][1]));
    var total = cum[n];
    var at = function (pos) {
      pos = ((pos % total) + total) % total;
      var lo = 0, hi = n - 1;
      while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (cum[mid] <= pos) lo = mid; else hi = mid - 1; }
      var l = cum[lo + 1] - cum[lo], t = l > 0 ? (pos - cum[lo]) / l : 0, a = P[lo], b = P[(lo + 1) % n];
      return { e: lo, pt: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
    };
    return {
      total: total,
      pos: function (h) { return cum[h.e] + h.t * (cum[h.e + 1] - cum[h.e]); },
      walk: function (h, dir, d) {
        var p0 = cum[h.e] + h.t * (cum[h.e + 1] - cum[h.e]), end = at(p0 + dir * d), out = [], e = h.e, guard = 0;
        if (dir > 0) { while (e !== end.e && guard++ <= n) { e = (e + 1) % n; out.push(P[e]); } }
        else { while (e !== end.e && guard++ <= n) { out.push(P[e]); e = (e - 1 + n) % n; } }
        if (h.e === end.e && d > cum[h.e + 1] - cum[h.e]) return out;      /* all the way round: not asked for */
        out.push(end.pt);
        return out;
      }
    };
  }

  /**
   * A region filled with one Archimedean spiral about `centre` -> [{ closed: false, pts }], from the middle outward.
   *   pitch    turn to turn
   *   linkMm   where the spiral leaves the region and comes back, the two cut ends are joined along the outline, the shorter way round, when
   *            that is no longer than this and no earlier join already runs there (0: never)
   *   hookMm   two ends left unjoined each turn this far along the outline towards the other (Bambu's infill anchor: 4 spacings); 0: none
   *   octagram the spiral of eight-pointed stars in place of the round one (below)
   */
  function spiralFill(polys, centre, pitch, linkMm, hookMm, octagram) {
    if (!polys.length || !(pitch > 0)) return [];
    var R = 0;
    polys.forEach(function (P) { P.forEach(function (q) { var d = Math.hypot(q[0] - centre[0], q[1] - centre[1]); if (d > R) R = d; }); });
    var a0 = SPIRAL_START_DEG * Math.PI / 180, line = [centre.slice()];
    if (octagram) {
      /* THE OCTAGRAM SPIRAL (octagramspiral.gcode: Bambu's, read off the circle's solid layer in spacings from the centre). Ring n is an
         eight-pointed star: its sides lie n spacings from the centre's axes (so ring to ring is one spacing), its points n (1 + sqrt 2) out,
         its notches n sqrt 2 out on the axes. From the centre the first stroke goes to (-1, 1) - 135 degrees, as the round spiral's - and each
         ring ends on the +Y axis, from where the line steps out to the next ring's first corner. The same on every layer. */
      var q2 = Math.SQRT2, at = function (x, y) { line.push([centre[0] + x * pitch, centre[1] + y * pitch]); };
      for (var n = 1; ; n++) {
        var k = n * (1 + q2), m = n * q2;
        if (n > 1) at(-n, (n - 1) * q2 + n);
        at(-n, n); at(-k, n); at(-m, 0); at(-k, -n); at(-n, -n); at(-n, -k); at(0, -m); at(n, -k); at(n, -n); at(k, -n); at(m, 0); at(k, n); at(n, n); at(n, k); at(0, m);
        if (n * pitch > R + pitch) break;                                         /* the star's sides are past the region's furthest point */
      }
    } else for (var phi = 0; ;) {
      var r = pitch * (1 + phi / (2 * Math.PI));
      line.push([centre[0] + r * Math.cos(a0 + phi), centre[1] + r * Math.sin(a0 + phi)]);
      if (r > R + pitch) break;
      phi += Math.min(0.35, Math.sqrt(8 * SPIRAL_SAG_MM / r));
    }
    var tracks = polys.map(function () { return null; }), used = polys.map(function () { return []; });
    var track = function (p) { return tracks[p] || (tracks[p] = outlineTrack(polys[p])); };
    /* how far the outline is free from pos the way dir, up to want */
    var freeFrom = function (p, pos, dir, want) {
      var T = track(p), best = want;
      used[p].forEach(function (iv) {
        var d0 = (((dir > 0 ? iv[0] - pos : pos - iv[1]) % T.total) + T.total) % T.total;      /* to the stretch's near end */
        var inside = ((((pos - iv[0]) % T.total) + T.total) % T.total) < iv[1] - iv[0] - 1e-9;
        if (inside) best = 0; else if (d0 < best) best = d0;
      });
      return best;
    };
    var take = function (p, pos, dir, len) { used[p].push(dir > 0 ? [pos, pos + len] : [pos - len, pos]); };
    var out = [], path = null, last = null;
    clipLine(line, polys).forEach(function (pc) {
      if (pathLength(pc.pts, false) < pitch / 8 && pc.a && pc.b) return;       /* a nick at a corner */
      var joined = false;
      if (path && last.b && pc.a && last.b.p === pc.a.p && (linkMm > 0 || hookMm > 0)) {
        var p = pc.a.p, T = track(p), pf = T.pos(last.b), pt = T.pos(pc.a);
        var fw = (((pt - pf) % T.total) + T.total) % T.total, dir = fw <= T.total - fw ? 1 : -1, len = dir > 0 ? fw : T.total - fw;
        if (len <= linkMm && freeFrom(p, pf, dir, len) >= len - 1e-9) {
          var way = T.walk(last.b, dir, len);
          way.pop();                                                             /* the far end is the next piece's first point */
          path.pts = path.pts.concat(way, pc.pts);
          take(p, pf, dir, len);
          joined = true;
        } else if (hookMm > 0) {
          var h1 = Math.min(freeFrom(p, pf, dir, hookMm), len / 2), h2 = Math.min(freeFrom(p, pt, -dir, hookMm), len / 2);
          if (h1 > hookMm / 4) { path.pts = path.pts.concat(T.walk(last.b, dir, h1)); take(p, pf, dir, h1); }
          if (h2 > hookMm / 4) { pc = { pts: T.walk(pc.a, -dir, h2).reverse().concat(pc.pts), a: pc.a, b: pc.b }; take(p, pt, -dir, h2); }
        }
      }
      if (!joined) { path = { closed: false, pts: pc.pts }; out.push(path); }
      last = pc;
    });
    return out;
  }

  // ===========================================================================
  // Hilbert curve - one space-filling line, cut to the region
  // ===========================================================================

  /* Measured on a real Bambu Studio 02.09 slice (hilbertcurve_3dhoneycomb.gcode.3mf: the concentric plate's shapes, every surface and the solid
     infill Hilbert curve; docs/SLICER.md "Hilbert curve"):
       - the curve runs on a square grid one bead spacing apart (0.377 at 0.42 / 0.2), turned 135 degrees: every stroke lies at 45 or 135;
       - it is the plain Hilbert curve of the smallest power of two that covers the region (128 across on every shape of the plate), its first
         corner at the low corner of the region's box in that frame - Bambu's region, which lies 0.85 x half the difference of the wall's spacing
         and the fill's outside this slicer's (0.013 mm at 0.45 / 0.42: the concentric rings' measure, found again in the grid's phase);
       - the same on every layer; cut where it leaves the region. */
  var HILBERT_FRAME_DEG = 135;

  /** The d-th point of the Hilbert curve on an n x n grid (n a power of two): from (0, 0) to (n - 1, 0). */
  function hilbertPoint(n, d) {
    var x = 0, y = 0, t = d;
    for (var sN = 1; sN < n; sN *= 2) {
      var rx = 1 & (t / 2), ry = 1 & (t ^ rx);
      if (ry === 0) {
        if (rx === 1) { x = sN - 1 - x; y = sN - 1 - y; }
        var tmp = x; x = y; y = tmp;
      }
      x += sN * rx; y += sN * ry;
      t = Math.floor(t / 4);
    }
    return [x, y];
  }

  /**
   * A region filled with the Hilbert curve -> [{ closed: false, pts }], in the curve's order.
   *   step     grid line to grid line
   *   linkMm   cut ends are joined along the outline when that is no longer than this (0: never)
   *   edgeMm   the first grid lines lie this far outside the region's box (above)
   */
  function hilbertFill(polys, step, linkMm, edgeMm) {
    if (!polys.length || !(step > 0)) return [];
    var a = HILBERT_FRAME_DEG * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    polys.forEach(function (P) { P.forEach(function (q) {
      var X = q[0] * c + q[1] * sn, Y = -q[0] * sn + q[1] * c;
      if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    }); });
    var need = Math.ceil(Math.max(x1 - x0, y1 - y0) / step) + 1, n = 2;
    while (n < need) n *= 2;
    if (n > 4096) return [];                                   /* 16 million strokes: not a fill */
    x0 -= edgeMm || 0; y0 -= edgeMm || 0;
    var ox = x0, oy = y0;
    /* the curve, straight runs as one stroke; only the part of it that can reach the box is made */
    var cols = Math.ceil((x1 - x0) / step) + 1, rows = Math.ceil((y1 - y0) / step) + 1;
    var pieces = [], line = null, prev = null;
    var visit = function (X, Y, size, d0) {
      /* a quadrant wholly off the box is skipped: the line breaks there */
      if (X >= cols || Y >= rows) { line = null; return; }
      if (size === 1) {
        var pt = hilbertPoint(n, d0);
        if (!line) { line = [pt]; pieces.push(line); }
        else if (line.length >= 2 && (line[line.length - 2][0] === pt[0] && prev[0] === pt[0] || line[line.length - 2][1] === pt[1] && prev[1] === pt[1])) line[line.length - 1] = pt;
        else line.push(pt);
        prev = pt;
        return;
      }
      var h = size / 2, q = h * h;
      for (var k = 0; k < 4; k++) { var cnr = hilbertPoint(n, d0 + k * q); visit(Math.floor(cnr[0] / h) * h, Math.floor(cnr[1] / h) * h, h, d0 + k * q); }
    };
    visit(0, 0, n, 0);
    var out = [], path = null, last = null, tracks = polys.map(function () { return null; });
    pieces.forEach(function (ln) {
      if (ln.length < 2) return;
      var world = ln.map(function (g2) { var X = ox + g2[0] * step, Y = oy + g2[1] * step; return [X * c - Y * sn, X * sn + Y * c]; });
      clipLine(world, polys).forEach(function (pc) {
        var joined = false;
        if (path && linkMm > 0 && last.b && pc.a && last.b.p === pc.a.p) {
          var T = tracks[pc.a.p] || (tracks[pc.a.p] = outlineTrack(polys[pc.a.p])), pf = T.pos(last.b), pt2 = T.pos(pc.a);
          var fw = (((pt2 - pf) % T.total) + T.total) % T.total, dir = fw <= T.total - fw ? 1 : -1, len = dir > 0 ? fw : T.total - fw;
          if (len <= linkMm) { var way = T.walk(last.b, dir, len); way.pop(); path.pts = path.pts.concat(way, pc.pts); joined = true; }
        }
        if (!joined) { path = { closed: false, pts: pc.pts }; out.push(path); }
        last = pc;
      });
    });
    return out;
  }

  // ===========================================================================
  // 3D honeycomb - wavy lines whose waves and direction change with height
  // ===========================================================================

  /* Measured on a real Bambu Studio 02.09 slice (hilbertcurve_3dhoneycomb.gcode.3mf: sparse infill 3D honeycomb, 15 %, 0.45 wide, 0.2 layers,
     over 210 layers; docs/SLICER.md "3D honeycomb"). In the frame turned 45 degrees (the infill direction), about the middle of the object's box:
       - a layer is one family of lines D = 3.579 apart, the middle one through the centre; each line is a square wave with slanted flanks:
         flats D - 2|a| long, a to one side of the line then a to the other, joined by flanks at 45 degrees to the line (so along X or Y on
         the plate); the wave is 2 D long, and next-door lines are mirror images, so they close in on each other and part again: the cells;
       - a, the flats' distance from the line, goes from + D/4 to - D/4 in 10 layers and back in the next 10, a twentieth of D a layer (0.179):
         the lines are straight every 10th layer; going down the lines run along the frame's first axis, coming back up along its second;
       - + D/4 falls on layer 5 (z 1.0), 25, 45...: a quarter of the 20 layers up from the plate.
     Two numbers are fitted to this one slice and stated, not known: D = (1 + sqrt(3)/2) / sqrt(2) x the spacing over the density (3.5802
     against the measured 3.5788), and the quarter, 5 layers, taken as the fewest layers that keep a flat's sideways step within a layer height
     (D / 4 over the layer height, rounded up: 4.47 -> 5). */
  var HONEYCOMB3D_SCALE = (1 + Math.sqrt(3) / 2) / Math.SQRT2;

  /** The 3D honeycomb's numbers for a layer: { D, a, family } - line spacing, the flats' signed distance from their line, 0 (lines along the frame's first axis) or 1. */
  function honeycomb3dAt(spacing, density, layerH, printZ) {
    var D = HONEYCOMB3D_SCALE * spacing / density, Q = Math.max(1, Math.ceil(D / (4 * layerH) - 1e-9));
    var n = (((Math.round(printZ / layerH) - Q) % (4 * Q)) + 4 * Q) % (4 * Q);
    return n < 2 * Q ? { D: D, a: D / 4 * (1 - n / Q), family: 0, quarter: Q } : { D: D, a: D / 4 * (-1 + (n - 2 * Q) / Q), family: 1, quarter: Q };
  }

  /**
   * A region filled with one layer of the 3D honeycomb -> [{ closed: false, pts }].
   *   centre   the lattice's middle (the object's box's)
   *   angle    the frame (rad): the infill direction
   *   cell     honeycomb3dAt()'s { D, a, family }
   *   linkMm   a line's end is joined to the next line's along the outline when that is no longer than this
   */
  function honeycomb3dFill(polys, centre, angle, cell, linkMm) {
    if (!polys.length || !(cell.D > 0)) return [];
    var c = Math.cos(angle), sn = Math.sin(angle), D = cell.D, T = 2 * D, a = cell.a, A = Math.abs(a), fam = cell.family;
    /* the frame: p along the lines, q across them, from the centre */
    var toPQ = function (pt) { var u = (pt[0] - centre[0]) * c + (pt[1] - centre[1]) * sn, v = -(pt[0] - centre[0]) * sn + (pt[1] - centre[1]) * c; return fam ? [v, u] : [u, v]; };
    var toXY = function (pp, qq) { var u = fam ? qq : pp, v = fam ? pp : qq; return [centre[0] + u * c - v * sn, centre[1] + u * sn + v * c]; };
    var p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
    polys.forEach(function (P) { P.forEach(function (pt) { var r = toPQ(pt); if (r[0] < p0) p0 = r[0]; if (r[0] > p1) p1 = r[0]; if (r[1] < q0) q0 = r[1]; if (r[1] > q1) q1 = r[1]; }); });
    var pieces = [];
    for (var k = Math.ceil((q0 - A) / D); k <= Math.floor((q1 + A) / D); k++) {
      var sg = (k % 2 === 0 ? 1 : -1) * a, line = [];
      if (A < 1e-9) line = [toXY(p0 - 1, k * D), toXY(p1 + 1, k * D)];
      else {
        for (var m = Math.floor((p0 - 1) / T); m <= Math.ceil((p1 + 1) / T); m++) {
          var b = m * T;
          line.push(toXY(b - T / 2 + A, k * D + sg), toXY(b - A, k * D + sg), toXY(b + A, k * D - sg), toXY(b + T / 2 - A, k * D - sg));
        }
      }
      var cut = clipLine(line, polys);
      if ((k % 2 + 2) % 2 === 1) cut = cut.reverse().map(function (pc) { return { pts: pc.pts.slice().reverse(), a: pc.b, b: pc.a }; });   /* there and back */
      pieces = pieces.concat(cut);
    }
    return chainAlongOutline(polys, pieces, linkMm);
  }

  // ===========================================================================
  // Gyroid - the layer's cut through the gyroid surface
  // ===========================================================================

  /* Measured on a real Bambu Studio 02.09 slice (OctogramSpiral_Gyroid.gcode.3mf: sparse infill gyroid, 15 %, 0.45 wide, 0.2 layers, 210 layers;
     docs/SLICER.md "Gyroid"). The lines of every layer lie on the gyroid
         cos X sin Y + cos Y sin Z + cos Z sin X = 0,    X, Y, Z = 2 pi / wavelength x (x, y, z)
     with x and y measured from the middle of the object's own box and z the layer's top from the plate: 145 000 points of four shapes over all
     210 layers lie on it within 0.03 mm, at one wavelength for all three axes, 6.988. That is 2 pi / 2.44 x the spacing over the density
     (6.9881 at 0.407 / 15 %): the factor is fitted to this one slice.
     A layer is cut as y(x) where |sin Z| >= |cos Z| - wavy lines along X, half a wavelength apart - and as x(y) elsewhere: the lines turn from
     one axis to the other every eighth of a wavelength up. */
  var GYROID_SCALE = 2 * Math.PI / 2.44;
  var GYROID_STEPS = 48;              // points a wavelength along a line (0.15 mm at 15 %)

  /**
   * A region filled with one layer of the gyroid -> [{ closed: false, pts }].
   *   centre   the surface's origin in the plane (the middle of the object's box)
   *   lam      the wavelength
   *   z        the layer's height
   *   linkMm   a line's end is joined to the next line's along the outline when that is no longer than this
   */
  function gyroidFill(polys, centre, lam, z, linkMm) {
    if (!polys.length || !(lam > 0)) return [];
    var k = 2 * Math.PI / lam, sz = Math.sin(k * z), cz = Math.cos(k * z), alongX = Math.abs(sz) >= Math.abs(cz);
    /* p runs along the lines, q across them, both in radians from the centre; the surface in (p, q): A(p) sin q' form below */
    var p0 = Infinity, p1 = -Infinity, q0 = Infinity, q1 = -Infinity;
    polys.forEach(function (P) { P.forEach(function (pt) {
      var X = k * (pt[0] - centre[0]), Y = k * (pt[1] - centre[1]), pp = alongX ? X : Y, qq = alongX ? Y : X;
      if (pp < p0) p0 = pp; if (pp > p1) p1 = pp; if (qq < q0) q0 = qq; if (qq > q1) q1 = qq;
    }); });
    var dp = 2 * Math.PI / GYROID_STEPS, n = Math.ceil((p1 - p0) / dp) + 2, base = [[], []], prevAng = null, turns = 0;
    for (var i = 0; i <= n; i++) {
      var pv = p0 - dp + i * dp, R, ang, rhs;
      if (alongX) { R = Math.hypot(Math.cos(pv), sz); ang = Math.atan2(sz, Math.cos(pv)); rhs = -cz * Math.sin(pv); }     /* cos X sin Y + sin Z cos Y = - cos Z sin X */
      else { R = Math.hypot(cz, Math.sin(pv)); ang = Math.atan2(Math.sin(pv), cz); rhs = -sz * Math.cos(pv); }            /* cos Z sin X + sin Y cos X = - sin Z cos Y */
      /* the angle followed along the line, without its jumps of a whole turn */
      if (prevAng !== null) { if (ang + turns - prevAng > Math.PI) turns -= 2 * Math.PI; else if (ang + turns - prevAng < -Math.PI) turns += 2 * Math.PI; }
      prevAng = ang + turns;
      var as = Math.asin(Math.max(-1, Math.min(1, rhs / R)));
      base[0].push([pv, as - prevAng]);
      base[1].push([pv, Math.PI - as - prevAng]);
    }
    var toXY = function (pv2, qv) { return alongX ? [centre[0] + pv2 / k, centre[1] + qv / k] : [centre[0] + qv / k, centre[1] + pv2 / k]; };
    /* every line that can reach the region: each of the two, a whole wavelength apart, in the order they lie */
    var lines = [];
    base.forEach(function (b) {
      var lo = Infinity, hi = -Infinity;
      b.forEach(function (pt) { if (pt[1] < lo) lo = pt[1]; if (pt[1] > hi) hi = pt[1]; });
      for (var m = Math.ceil((q0 - hi) / (2 * Math.PI)); m <= Math.floor((q1 - lo) / (2 * Math.PI)); m++) lines.push({ mid: (lo + hi) / 2 + m * 2 * Math.PI, shift: m * 2 * Math.PI, b: b });
    });
    lines.sort(function (l1, l2) { return l1.mid - l2.mid; });
    var pieces = [];
    lines.forEach(function (ln, li) {
      var cut = clipLine(ln.b.map(function (pt) { return toXY(pt[0], pt[1] + ln.shift); }), polys);
      if (li % 2 === 1) cut = cut.reverse().map(function (pc) { return { pts: pc.pts.slice().reverse(), a: pc.b, b: pc.a }; });   /* there and back */
      pieces = pieces.concat(cut);
    });
    return chainAlongOutline(polys, pieces, linkMm);
  }

  // ===========================================================================
  // Cubic, adaptive cubic and honeycomb - straight lines
  // ===========================================================================

  /* CUBIC and ADAPTIVE CUBIC, measured on real Bambu Studio 02.09 slices (cubic_sparse.gcode.3mf, Adaptivecubic_sparse.gcode.3mf: 15 %, 0.45
     wide, 0.2 layers; docs/SLICER.md "Cubic", "Adaptive cubic"). A layer is three families of straight lines 60 degrees apart; each family
     slides sideways by the layer height over sqrt 2 a layer, the first and third one way, the second the other: the lines are the cut through
     three sets of planes at right angles to each other - cubes standing on a corner.
       - cubic: the families at 45, 105 and 165 degrees (the infill direction and on), 3 spacings over the density apart (8.141), all three
         through the middle of the object's box at the plate (z 0);
       - adaptive cubic: the families at 0, 60 and 120 degrees, 11.023 apart - cubes 9.000 on edge, which is 3 x the line's WIDTH over the density
         (0.45 / 15 %; fitted to this one slice) - all three through the middle of the object's box in the cubes' own frame, in all three
         directions (a prism's: its middle in plan, at half its height). Bambu's cubes grow coarser deep inside a large part; none of the
         reference's parts (24 - 39 mm) is large enough to show it, so that is not measured and not done: every cell is the finest. */
  var CUBIC_SIGNS = [-1, 1, -1];

  /**
   * A region filled with one layer of three line families -> [{ closed: false, pts }].
   *   angle0   the first family's direction (rad); the others 60 and 120 degrees on
   *   pitch    line to line in a family
   *   at       [d0, d1, d2]: where one line of each family lies - its signed distance from the origin along the family's normal (-sin, cos)
   *   linkMm   a line's end is joined to the next line's along the outline when that is no longer than this
   */
  function linesFill(polys, angle0, pitch, at, linkMm) {
    if (!polys.length || !(pitch > 0)) return [];
    var pieces = [];
    for (var f = 0; f < 3; f++) {
      var an = angle0 + f * Math.PI / 3, dx = Math.cos(an), dy = Math.sin(an), nx = -dy, ny = dx;
      var t0 = Infinity, t1 = -Infinity, d0 = Infinity, d1 = -Infinity;
      polys.forEach(function (P) { P.forEach(function (q) { var t = q[0] * dx + q[1] * dy, d = q[0] * nx + q[1] * ny; if (t < t0) t0 = t; if (t > t1) t1 = t; if (d < d0) d0 = d; if (d > d1) d1 = d; }); });
      var row = 0;
      for (var m = Math.ceil((d0 - at[f]) / pitch); m <= Math.floor((d1 - at[f]) / pitch); m++, row++) {
        var d = at[f] + m * pitch;
        var cut = clipLine([[(t0 - 1) * dx + d * nx, (t0 - 1) * dy + d * ny], [(t1 + 1) * dx + d * nx, (t1 + 1) * dy + d * ny]], polys);
        if (row % 2 === 1) cut = cut.reverse().map(function (pc) { return { pts: pc.pts.slice().reverse(), a: pc.b, b: pc.a }; });
        pieces = pieces.concat(cut);
      }
    }
    return chainAlongOutline(polys, pieces, linkMm);
  }

  /** Where the cubic's three families lie on the layer at z, about `centre` (the middle of the object's box, at the plate). */
  function cubicAt(centre, angle0, z) {
    return CUBIC_SIGNS.map(function (sg, f) { var an = angle0 + f * Math.PI / 3; return -centre[0] * Math.sin(an) + centre[1] * Math.cos(an) + sg * z / Math.SQRT2; });
  }

  /**
   * The adaptive cubic's lattice for an object: { pitch, at(z) }. The cubes' three axes are the planes' normals; the lattice has a corner at
   * the middle of the object's box along each of them. pts: the object's points as flat x, y, z (z as printed).
   */
  function adaptiveCubicLattice(pts, edge) {
    var k = Math.sqrt(1.5), mids = CUBIC_SIGNS.map(function (sg, f) {
      var an = f * Math.PI / 3, ax = -Math.sin(an) / k, ay = Math.cos(an) / k, az = -sg / Math.SQRT2 / k, lo = Infinity, hi = -Infinity;
      for (var i = 0; i + 2 < pts.length; i += 3) { var t = pts[i] * ax + pts[i + 1] * ay + pts[i + 2] * az; if (t < lo) lo = t; if (t > hi) hi = t; }
      return (lo + hi) / 2;
    });
    return { pitch: edge * k, at: function (z) { return CUBIC_SIGNS.map(function (sg, f) { return k * mids[f] + sg * z / Math.SQRT2; }); } };
  }

  /* HONEYCOMB, measured on a real Bambu Studio 02.09 slice (honeycomb_sparse.gcode.3mf: 15 %, 0.45 wide; docs/SLICER.md "Honeycomb"). One
     lattice of regular hexagons for the whole object: two spacings over the density across the flats (5.427), a pair of edges along 135
     degrees (the infill direction and a quarter turn), the others at 75 and 15. A layer draws it as zigzag lines along one of the three edge
     directions - 135 on the first sparse layer of the reference (layer 4), 75 on the next, 15 on the third, and round again: where two
     zigzags meet they run side by side a spacing apart (the doubled walls), each half a spacing off the hexagons' true edge. A hexagon's
     middle lies (W, a) from the middle of the object's box, W the spacing over the density and a the hexagon's side (2 W / sqrt 3): read off
     ten shapes, the same on each - but one density, so that it scales with W is stated, not measured. */
  /**
   * A region filled with one layer of the honeycomb -> [{ closed: false, pts }].
   *   centre   the middle of the object's box
   *   angle    the infill direction (rad)
   *   turn     0, 1 or 2: which of the three edge directions this layer's zigzags follow (the layer's index modulo 3)
   *   W        the spacing over the density;  spacing  the bead's
   */
  function honeycombFill(polys, centre, angle, turn, W, spacing, linkMm) {
    if (!polys.length || !(W > 0)) return [];
    var a = 2 * W / Math.sqrt(3), fa = angle - turn * Math.PI / 3, c = Math.cos(fa), sn = Math.sin(fa);
    /* the layer's frame: q across the zigzags, p along them, from a hexagon's middle */
    var hx = centre[0] + W, hy = centre[1] + a;
    var toQP = function (pt) { return [(pt[0] - hx) * c + (pt[1] - hy) * sn, -(pt[0] - hx) * sn + (pt[1] - hy) * c]; };
    var toXY = function (q, pp) { return [hx + q * c - pp * sn, hy + q * sn + pp * c]; };
    var q0 = Infinity, q1 = -Infinity, p0 = Infinity, p1 = -Infinity;
    polys.forEach(function (P) { P.forEach(function (pt) { var r = toQP(pt); if (r[0] < q0) q0 = r[0]; if (r[0] > q1) q1 = r[0]; if (r[1] < p0) p0 = r[1]; if (r[1] > p1) p1 = r[1]; }); });
    var half = a / 2 + spacing / (2 * Math.sqrt(3)), pieces = [], row = 0;
    /* column m: the hexagons' edges along p at q = m W, centred 3 a apart - at the middle's own height on odd columns, 1.5 a off on even ones */
    for (var m = Math.floor(q0 / W) - 1; m <= Math.ceil(q1 / W); m++, row++) {
      var cm = (((m % 2) + 2) % 2 === 1) ? 0 : 1.5 * a, line = [];
      for (var k = Math.floor((p0 - cm) / (3 * a)) - 1; k <= Math.ceil((p1 - cm) / (3 * a)) + 1; k++) {
        var cc = cm + 3 * a * k;
        line.push(toXY(m * W + spacing / 2, cc - half), toXY(m * W + spacing / 2, cc + half), toXY((m + 1) * W - spacing / 2, cc + 1.5 * a - half), toXY((m + 1) * W - spacing / 2, cc + 1.5 * a + half));
      }
      var cut = clipLine(line, polys);
      if (row % 2 === 1) cut = cut.reverse().map(function (pc) { return { pts: pc.pts.slice().reverse(), a: pc.b, b: pc.a }; });
      pieces = pieces.concat(cut);
    }
    return chainAlongOutline(polys, pieces, linkMm);
  }

  // ===========================================================================
  // Lightning - only what holds the roofs up
  // ===========================================================================

  /* LIGHTNING, on a real Bambu Studio 02.09 slice (Lightning_sparse.gcode.3mf: the plate's ten shapes, 35.8 - 43.6 mm tall, 15 %, 0.45 wide;
     docs/SLICER.md "Lightning"). Bambu grows trees: the sparse layers are empty from the bottom shell up to 39 - 89 layers under the top shell,
     then branches rooted on the walls reach further in with every layer, until on the last layer under the top they lie about sqrt 2 spacings
     over the density apart (the length laid over the area inside the walls is 0.247 - 0.268 on all ten shapes; 0.261 = 1 / (sqrt 2 x 2.713)).
     The trees themselves are grown by a procedure this slicer does not have, and a black-box reading cannot recover it. What is laid here is
     what the trees are for, by their own measures:
       - a roof - sparse infill with none over it - is carried by straight lines sqrt 2 spacings over the density apart, along the infill
         direction, each running from wall to wall;
       - a layer down, every line is two stubs, one from each wall, each ending one layer height short of where the stub above ended (45
         degrees: the reference's square, 23 mm inside its walls, has its last branch 57 layers under the top - 11.4 mm for 11.5 mm of half
         width); a stub is printed while it is longer than a line is wide;
       - the lines keep to the same places on every layer (they are laid about the middle of the object's box), so each lies on the one below.
     So the plastic is where Bambu's is and about as much (tools/nso_slicer_test.js), in combs where Bambu draws trees. */
  var LIGHTNING_SPREAD = Math.SQRT2;  // the roof lines' spacing, in spacings over the density
  function dirOf(o) { return o.infillDirectionDeg * Math.PI / 180; }

  /**
   * Lightning for one object: adds each layer's 'Sparse infill' paths to layers[i].paths.
   *   sparseAt   the layers' sparse regions (CrossSections; undefined where a layer has none)
   *   PL         the layers' planes ({ h })
   *   centre     the middle of the object's box: one scan line passes through it
   */
  function lightningFill(g, layers, sparseAt, PL, centre, angle, o) {
    var c = Math.cos(angle), sn = Math.sin(angle), need = new Map();   /* scan line -> [[u0, u1]...] the layer above needs held, already drawn in */
    var uOf = function (pt) { return pt[0] * c + pt[1] * sn; };
    for (var i = layers.length - 1; i >= 0; i--) {
      var sp = sparseAt[i];
      if (!sp || g.isEmpty(sp)) { need = new Map(); continue; }
      var h = PL[i].h, w = o.infillWidthMm, pitch = LIGHTNING_SPREAD * spacingOf(w, h) / Math.min(1, o.sparseDensity);
      var phase = (-centre[0] * sn + centre[1] * c) % pitch;
      /* the roof: this layer's sparse infill with no sparse infill over it */
      var above = sparseAt[i + 1], roof = above && !g.isEmpty(above) ? g.diff(sp, above) : sp, roofBy = new Map();
      if (!g.isEmpty(roof)) scanFill(g.polys(roof), angle, pitch, phase).forEach(function (sg) {
        var l = roofBy.get(sg.line); if (!l) roofBy.set(sg.line, l = []);
        l.push([Math.min(uOf(sg.a), uOf(sg.b)), Math.max(uOf(sg.a), uOf(sg.b))]);
      });
      var next = new Map(), L = layers[i];
      scanFill(g.polys(sp), angle, pitch, phase).forEach(function (sg) {
        var ua = uOf(sg.a), ub = uOf(sg.b), A = ua <= ub ? sg.a : sg.b, B = ua <= ub ? sg.b : sg.a, a = Math.min(ua, ub), b = Math.max(ua, ub), m = (a + b) / 2;
        /* how far in the stub from each wall has to reach: the furthest thing to hold on its half of the line */
        var xL = -Infinity, xR = Infinity;
        (need.get(sg.line) || []).concat(roofBy.get(sg.line) || []).forEach(function (iv) {
          var lo = Math.max(iv[0], a), hi = Math.min(iv[1], b);
          if (hi <= lo) return;
          if (lo < m) xL = Math.max(xL, Math.min(hi, m));
          if (hi > m) xR = Math.min(xR, Math.max(lo, m));
        });
        var at = function (u) { var t = (u - a) / (b - a); return [A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]; };
        var keep = next.get(sg.line); if (!keep) next.set(sg.line, keep = []);
        if (xL >= m - 1e-9 && xR <= m + 1e-9) L.paths.push({ feature: 'Sparse infill', width: w, closed: false, pts: [A, B] });
        else {
          if (xL - a > w) L.paths.push({ feature: 'Sparse infill', width: w, closed: false, pts: [A, at(xL)] });
          if (b - xR > w) L.paths.push({ feature: 'Sparse infill', width: w, closed: false, pts: [at(xR), B] });
        }
        /* what the layer below holds: each stub, a layer height shorter */
        if (xL - h - a > w) keep.push([a, xL - h]);
        if (b - xR - h > w) keep.push([xR + h, b]);
      });
      need = next;
    }
  }

  /**
   * Pieces of clipLine's, in order, as paths: one piece's end joined to the next one's start along the outline, the shorter way round, when
   * both lie on the same polygon, that way is no longer than linkMm and no earlier join already runs along any of it (a stretch of wall is
   * traced once).
   */
  function chainAlongOutline(polys, pieces, linkMm) {
    var out = [], path = null, last = null, tracks = polys.map(function () { return null; }), used = polys.map(function () { return []; });
    pieces.forEach(function (pc) {
      var joined = false;
      if (path && linkMm > 0 && last.b && pc.a && last.b.p === pc.a.p) {
        var pi = pc.a.p, Tr = tracks[pi] || (tracks[pi] = outlineTrack(polys[pi])), pf = Tr.pos(last.b), pt2 = Tr.pos(pc.a);
        var fw = (((pt2 - pf) % Tr.total) + Tr.total) % Tr.total, dir = fw <= Tr.total - fw ? 1 : -1, len = dir > 0 ? fw : Tr.total - fw;
        var from = dir > 0 ? pf : pt2;                                         /* the stretch, as [from, from + len) going with the vertices */
        var free = len <= linkMm && !used[pi].some(function (iv) {
          var gap = (((iv[0] - from) % Tr.total) + Tr.total) % Tr.total;        /* from this stretch's start on to the other's */
          return gap < len - 1e-9 || gap + iv[1] > Tr.total + 1e-9;             /* it starts inside this one, or wraps round onto it */
        });
        if (free) { var way = Tr.walk(last.b, dir, len); way.pop(); path.pts = path.pts.concat(way, pc.pts); used[pi].push([from, len]); joined = true; }
      }
      if (!joined) { path = { closed: false, pts: pc.pts }; out.push(path); }
      last = pc;
    });
    return out;
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
    /* A RAFT (o.raftLayers; Bambu's raft_layers) lifts the whole plate: the parts and supports stand on its top, raftContactMm over it, and
       their first layer is an ordinary one (Bambu: 2.9 + 0.1 + 0.2 with 10 raft layers, 2.3 + 0.1 + 0.16 with 8) */
    var rp = raftPlan(o);
    if (rp) objs = objs.filter(function (ob) { return ob.role !== 'brim'; });        /* a raft is the plate's hold: no brim with it */
    var shiftZ = (o.dropToPlate ? -zMin : 0) + (rp ? rp.lift : 0);
    var planes = slicePlanes(zMin, zMax, rp ? Object.assign({}, o, { firstLayerMm: o.layerMm }) : o).map(function (p) {
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

      /* an object cut on the planes `pl` (the shared ones, or - a support, when supportLayerMaxMm is on - its own) */
      /* a support's section with its small holes filled (under 2 mm2): the Negative Sphere's apex is a ring of support 0.4 wide round a 1.2 mm hole (the support
         mesh is hollow there) and Bambu prints a disc on it - the ring alone is eaten by the wall's inset and the apex loses its top layer */
      function fillSmallHoles(cs) {
        if (g.isEmpty(cs)) return cs;
        var any = false, keep = g.polys(cs).filter(function (Pl) {
          var a2 = 0;
          for (var q = 0; q < Pl.length; q++) { var u = Pl[q], v = Pl[(q + 1) % Pl.length]; a2 += u[0] * v[1] - v[0] * u[1]; }
          if (a2 < 0 && -a2 / 2 < SUPPORT_HOLE_FILL_MM2) { any = true; return false; }
          return true;
        });
        return any ? g.of(keep, 'Positive') : cs;
      }
      function makeP(ob, oi, pl) {
        // Per-object override: a piece the user flagged non-solid is sliced
        // with gapCloseMm 0 - its open edges are the design, not a hole to
        // chord shut (the caller reads the flag; this module never infers it).
        var smOpts = ob.gapCloseMm != null ? { weldMm: o.weldMm, gapCloseMm: ob.gapCloseMm } : o;
        var pre = ob.soup && ob.soup.length ? prepSoup(ob.soup, smOpts && smOpts.weldMm > 0 ? smOpts.weldMm : 1e-4) : null;   /* welded once: the layers and every exact cut read it */
        var sm = sliceMesh(ob.soup, pl, smOpts, pre);
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
          cs = g.simplify(cs, o.resolutionMm);
          return ob.role === 'support' ? fillSmallHoles(cs) : cs;
        });
        /* the part cut at heights of its own choosing (soup frame, ascending sliceZ): the same section, orientation and closing as its layers - for the
           support typing's exact reach (typeSupports, byDepth) */
        /* kept by the height itself (the same float, so the same bytes): every support on this part asks it for the same layer heights */
        var exMemo = new Map();
        var exactAt = function (zsl) {
          var miss = [], asked = new Set();
          zsl.forEach(function (z) { if (!exMemo.has(z) && !asked.has(z)) { asked.add(z); miss.push(z); } });
          if (miss.length) {
            var sm2 = sliceMesh(ob.soup, miss.map(function (z) { return { sliceZ: z }; }), smOpts, pre);
            sm2.sections.forEach(function (sec, i) {
              if (flipped) sec.loops.forEach(function (l) { l.reverse(); });
              var cs = g.of(sec.loops, 'Positive');
              if (closeR > 0 && !g.isEmpty(cs)) cs = g.offset(g.offset(cs, closeR, 'Miter'), -closeR, 'Miter');
              exMemo.set(miss[i], g.simplify(cs, o.resolutionMm));
            });
          }
          return zsl.map(function (z) { return exMemo.get(z); });
        };
        return { name: ob.name || ('object ' + (oi + 1)), id: oi, mesh: sm, S: S, flipped: flipped, exactAt: exactAt, soupOk: !!(ob.soup && ob.soup.length), soup: ob.soup && ob.soup.length ? ob.soup : null,
                 nonSolid: ob.gapCloseMm === 0,
                 role: ob.role === 'support' ? 'support' : ob.role === 'brim' ? 'brim' : 'part', key: ob.key, hostKey: ob.hostKey,
                 thin: ob.detectThinWall != null ? !!ob.detectThinWall
                   : (ob.role === 'support' ? CONSTANTS.thinWall.supportsOn : !!o.detectThinWall),
                 layers: [], planes: pl === planes ? null : pl };
      }
      var perObject = objs.map(function (ob, oi) { return makeP(ob, oi, planes); });

      // Layers, object by object.
      var buildLayers = function (P) {
        var PL = P.planes || planes;
        var S = P.S, n = PL.length;
        var sparsePrev = g.empty();
        var lightningAt = null;                                   /* lightning: each layer's sparse region, by layer */
        /* A SUPPORT IS HOLLOW, as its export says (SHEET.slicerSettings: wall_loops 1, sparse_infill_density 0%) and as Bambu's own tree is: one wall
           round the trunk and no filler inside it. The shells (the first layers, the top under a sheet) stay the profile's. */
        var oS = P.role === 'support' ? Object.assign({}, o, { wallLoops: o.supportWallLoops >= 1 ? Math.round(o.supportWallLoops) : CONSTANTS.supportWalls.loops, sparseDensity: CONSTANTS.supportWalls.sparseDensity, narrowSparseMm: 0, minSparseAreaMm2: 0 }) : o;
        var TT = P.role === 'support' ? CONSTANTS.supportWalls.topShellLayers : T, BB = P.role === 'support' ? CONSTANTS.supportWalls.bottomShellLayers : B;
        if (P.role === 'brim') {
          /* a brim built with the supports (brimFor): one layer, its section printed as the brim's own loops, nothing else */
          for (var bi = 0; bi < n; bi++) {
            var BL = { index: bi, printZ: PL[bi].printZ, h: PL[bi].h, paths: [], areaMm2: g.area(S[bi]), wallCount: 0 };
            if (bi === 0 && !g.isEmpty(S[0])) { BL.paths = brimLoops(g, S[0], o, PL[0].h); BL.brimLoops = BL.paths.length; }
            P.layers.push(BL);
          }
          return;
        }
        for (var i = 0; i < n; i++) {
          var h = PL[i].h;
          var region = S[i];
          var L = { index: i, printZ: PL[i].printZ, h: h, paths: [], areaMm2: g.area(region) };
          P.layers.push(L);
          if (g.isEmpty(region)) { L.wallCount = 0; sparsePrev = g.empty(); continue; }

          var above = i + 1 < n ? S[i + 1] : g.empty();
          var below = i > 0 ? S[i - 1] : null;
          // Detect thin wall: the thin islands come out of the region and
          // print as their centre passes; with none, the region is as it was
          var thin = P.thin ? thinWalls(g, region, o) : null;
          /* a support has one loop and no top shell: the one-wall-on-top rule has no loop to drop there, and left to run it kept the fill out from under
             whatever stands on the layer - a pad with a pocket between its trunks printed hollow under every trunk, their second layer over air */
          var per = perimeters(g, thin ? thin.rest : region, h, oS, oS.onlyOneWallTop && P.role !== 'support' ? above : null);
          L.wallCount = per.wallCount;
          L.wallLoopsByDepth = per.loops.map(function (lp) { return g.polys(lp.cs).length; });

          // --- overhang (Task 5): this section outside the one below, grown
          // by the printable step h / tan(threshold)
          var step = h / Math.tan(th);
          var over = below ? g.diff(region, g.offset(below, step)) : g.empty();
          over = g.dropSmall(over, minOver);
          L.overhangCs = over;
          L.overhangMm2 = g.area(over);
          var belowPolys = below ? g.polys(below) : null, belowIn = belowPolys ? insideIndex(belowPolys) : null;

          per.loops.slice().reverse().forEach(function (lp) {     // inner walls first, outer last
            var feat = lp.depth === 0 ? 'Outer wall' : 'Inner wall';
            var w = lp.depth === 0 ? o.outerWallWidthMm : o.innerWallWidthMm;
            loopsOf(g, lp.cs).forEach(function (path) {
              splitOverhang(path, belowPolys, i, w, o.overhangEdgeFrac, o.overhangSubMm, belowIn).forEach(function (piece) {
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
          for (var k = 1; k <= TT; k++) {
            var up = i + k < n ? S[i + k] : g.empty();
            cover = cover ? g.inter(cover, up) : up;
          }
          for (var kb = 1; kb <= BB; kb++) {
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
          var narrowR = (oS.narrowSparseMm != null ? oS.narrowSparseMm : 1.7 * spacingOf(o.infillWidthMm, h)) / 2;
          if (narrowR > 0 && !g.isEmpty(sparse)) {
            var opened = g.offset(g.offset(sparse, -narrowR), narrowR);
            var narrow = g.diff(sparse, opened);
            if (g.area(narrow) > 1e-6) { solid = g.union(solid, narrow); sparse = g.inter(sparse, opened); }
          }
          // a sparse island too small to hold infill is printed solid
          if (oS.minSparseAreaMm2 > 0) {
            var small = g.unionAll(g.parts(sparse).filter(function (p) { return p.area() < oS.minSparseAreaMm2; }));
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
          /* A concentric fill's room. The fill region bounds bead CENTRES (perimeters: 0.85 x the wall's spacing in from the last loop); the rings
             are laid from the beads' outer edge, and the reference's outermost ring lies 0.85 x the mean of the wall's spacing and its own from the
             last loop (0.333 at 0.45 / 0.42, 0.388 at the first layer's 0.5 / 0.5). So the region grows by the difference plus half a spacing -
             along the walls only: where a piece borders another fill of the same layer it keeps its edge. */
          function ringRoom(cs, onTop) {
            /* a top surface under one wall (onlyOneWallTop) lies along the outer wall, everything else along the last inner one */
            var wWall = oS.wallLoops > 1 && !(onTop && oS.onlyOneWallTop) ? o.innerWallWidthMm : o.outerWallWidthMm;
            var grow = sInf / 2 + (1 - o.infillWallOverlap) * (spacingOf(wWall, h) - sInf) / 2;
            return g.union(cs, g.inter(g.offset(cs, grow), g.diff(g.offset(inner, grow), inner)));
          }
          function solidFill(cs, feat, pattern) {
            if (g.isEmpty(cs)) return;
            if (pattern === 'hilbertcurve') {
              g.parts(cs).forEach(function (pc) {
                hilbertFill(g.polys(pc), sInf, solidJoin, (1 - o.infillWallOverlap) * (spacingOf(oS.wallLoops > 1 && !(feat === 'Top surface' && oS.onlyOneWallTop) ? o.innerWallWidthMm : o.outerWallWidthMm, h) - sInf) / 2).forEach(function (pth) {
                  L.paths.push({ feature: feat, width: wInf, closed: false, pts: pth.pts });
                });
              });
              return;
            }
            if (pattern === 'archimedeanchords' || pattern === 'octagramspiral') {
              /* one spiral a piece, about the middle of its box in the infill direction's frame */
              g.parts(cs).forEach(function (pc) {
                var pp = g.polys(pc);
                spiralFill(pp, turnedBoxCentre(pp, dirA), sInf, solidJoin, 0, pattern === 'octagramspiral').forEach(function (pth) {
                  L.paths.push({ feature: feat, width: wInf, closed: false, pts: pth.pts });
                });
              });
              return;
            }
            if (pattern === 'concentric') {
              var lastP = L.paths.length ? L.paths[L.paths.length - 1] : null;
              concentricFill(g, ringRoom(cs, feat === 'Top surface'), wInf, h, sInf, true, lastP ? (lastP.closed ? lastP.pts[0] : lastP.pts[lastP.pts.length - 1]) : null).forEach(function (pth) {
                L.paths.push({ feature: feat, width: pth.width, closed: pth.closed, pts: pth.pts });
              });
              return;
            }
            var polys = g.polys(cs);
            /* a support's first layer at its own density (Bambu's Initial layer density): the lines that much further apart */
            var sFill = P.role === 'support' && i === 0 && o.supportFirstLayerDensity > 0 && o.supportFirstLayerDensity < 1 ? sInf / Math.max(0.2, o.supportFirstLayerDensity) : sInf;
            connect(scanFill(polys, solidAngle, sFill, 0), sFill > sInf ? 3 * sFill : solidJoin, hull).forEach(function (pth) {
              L.paths.push({ feature: feat, width: wInf, closed: false, pts: pth.pts });
            });
          }
          /* a bridge's angle: the profile's bridge_angle (Bambu lays every bridge at it); else, under the column rule's 3.6 angles (Studio 02.09,
             bridge_angle 0), a part's bridge over its supports at 3.6, the supports' top square to it */
          var bridgeAt = null;
          if (o.bridgeAngleDeg) bridgeAt = o.bridgeAngleDeg * Math.PI / 180;
          else if ((o.supportInterfaceAngle === 'studio36' || o.supportInterfaceAngle === 'profile') && o.supportInterfaceRule === 'column' && P.role === 'part' && objs.some(function (ob) { return ob.role === 'support'; })) bridgeAt = STUDIO36_DEG * Math.PI / 180;
          var sa0 = solidAngle;
          if (i > 0 && bridgeAt != null) { solidAngle = bridgeAt; solidFill(bottomOpen, 'Bridge'); solidAngle = sa0; }
          else solidFill(bottomOpen, i === 0 ? 'Bottom surface' : 'Bridge', i === 0 ? (o.bottomPattern || o.solidPattern) : null);   /* a bridge is straight lines, whatever the pattern */
          if (o.bridgeAngleDeg) solidAngle = bridgeAt;
          solidFill(bridgeInner, 'Bridge');
          solidAngle = sa0;
          solidFill(topOnly, 'Top surface', o.topPattern || o.solidPattern);
          solidFill(internal, 'Internal solid infill', o.solidPattern);

          /* a spiral and a 3D honeycomb are laid about the middle of the object's own box on every layer, so each layer's lines lie on the last one's */
          if (!P.boxCentre && !g.isEmpty(sparse) && ({ archimedeanchords: 1, '3dhoneycomb': 1, gyroid: 1, cubic: 1, adaptivecubic: 1, honeycomb: 1 })[o.sparsePattern]) {
            var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
            S.forEach(function (sec) { if (g.isEmpty(sec)) return; var bb = sec.bounds(); bx0 = Math.min(bx0, bb.min[0]); by0 = Math.min(by0, bb.min[1]); bx1 = Math.max(bx1, bb.max[0]); by1 = Math.max(by1, bb.max[1]); });
            P.boxCentre = [(bx0 + bx1) / 2, (by0 + by1) / 2];
          }
          var dens = Math.min(1, oS.sparseDensity);
          var lineFill = null;
          if (!g.isEmpty(sparse) && dens > 0) {
            if (o.sparsePattern === 'cubic') lineFill = linesFill(g.polys(sparse), dirA, 3 * sInf / dens, cubicAt(P.boxCentre, dirA, PL[i].printZ), o.sparseAnchorMaxMm);
            else if (o.sparsePattern === 'adaptivecubic') {
              if (!P.cubes) {
                /* the object's points as printed: its triangles' corners, or - a section with no mesh behind it - its layers' outlines */
                var pts3 = [];
                if (P.soup) for (var q3 = 0; q3 + 2 < P.soup.length; q3 += 3) pts3.push(P.soup[q3], P.soup[q3 + 1], P.soup[q3 + 2] + shiftZ);
                else S.forEach(function (sec, li) { g.polys(sec).forEach(function (pl) { pl.forEach(function (pt) { pts3.push(pt[0], pt[1], PL[li].printZ - PL[li].h, pt[0], pt[1], PL[li].printZ); }); }); });
                P.cubes = adaptiveCubicLattice(pts3, 3 * wInf / dens);
              }
              lineFill = linesFill(g.polys(sparse), 0, P.cubes.pitch, P.cubes.at(PL[i].printZ), o.sparseAnchorMaxMm);
            } else if (o.sparsePattern === 'lightning') {
              /* laid when the whole object's layers are known, from the top down (lightningFill) */
              if (!P.boxCentre) { var lb = region.bounds(); P.boxCentre = [(lb.min[0] + lb.max[0]) / 2, (lb.min[1] + lb.max[1]) / 2]; }
              (lightningAt || (lightningAt = []))[i] = sparse;
              lineFill = [];
            } else if (o.sparsePattern === 'honeycomb') lineFill = honeycombFill(g.polys(sparse), P.boxCentre, dirA, i % 3, sInf / dens, sInf, o.sparseAnchorMaxMm);
          }
          if (lineFill) {
            lineFill.forEach(function (pth) { L.paths.push({ feature: 'Sparse infill', width: wInf, closed: false, pts: pth.pts }); });
          } else if (!g.isEmpty(sparse) && oS.sparseDensity > 0 && o.sparsePattern === 'gyroid') {
            gyroidFill(g.polys(sparse), P.boxCentre, GYROID_SCALE * sInf / Math.min(1, oS.sparseDensity), PL[i].printZ, o.sparseAnchorMaxMm).forEach(function (pth) {
              L.paths.push({ feature: 'Sparse infill', width: wInf, closed: false, pts: pth.pts });
            });
          } else if (!g.isEmpty(sparse) && oS.sparseDensity > 0 && o.sparsePattern === '3dhoneycomb') {
            honeycomb3dFill(g.polys(sparse), P.boxCentre, dirA, honeycomb3dAt(sInf, Math.min(1, oS.sparseDensity), o.layerMm, PL[i].printZ), o.sparseAnchorMaxMm).forEach(function (pth) {
              L.paths.push({ feature: 'Sparse infill', width: wInf, closed: false, pts: pth.pts });
            });
          } else if (!g.isEmpty(sparse) && oS.sparseDensity > 0 && o.sparsePattern === 'archimedeanchords') {
            spiralFill(g.polys(sparse), P.boxCentre, sInf / Math.min(1, oS.sparseDensity), o.sparseAnchorMaxMm, 4 * sInf).forEach(function (pth) {
              L.paths.push({ feature: 'Sparse infill', width: wInf, closed: false, pts: pth.pts });
            });
          } else if (!g.isEmpty(sparse) && oS.sparseDensity > 0 && o.sparsePattern === 'concentric') {
            /* sparse rings: the first along the walls, the rest a spacing over the density apart (stated: the reference has no sparse layer) */
            var lastS = L.paths.length ? L.paths[L.paths.length - 1] : null;
            concentricFill(g, ringRoom(sparse), wInf, h, sInf / Math.min(1, oS.sparseDensity), false, lastS ? (lastS.closed ? lastS.pts[0] : lastS.pts[lastS.pts.length - 1]) : null).forEach(function (pth) {
              L.paths.push({ feature: 'Sparse infill', width: pth.width, closed: pth.closed, pts: pth.pts });
            });
          } else if (!g.isEmpty(sparse) && oS.sparseDensity > 0) {
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
        if (lightningAt) lightningFill(g, P.layers, lightningAt, PL, P.boxCentre, dirOf(o), o);
      };
      var colRule = function (P) { if (P.role === 'support' && o.supportInterfaceRule === 'column') columnRule(g, P, perObject, planes, o); };
      /* claims (columnRule: one stack, one owner) in the pass whose sections print: the shared grid's when the supports keep it, else the own grids'
         below - the shared pass then finds each support's tops with the whole stack over it, so every support's grid runs up to the stack (with the
         claims there, the second support's grid stopped under its tips and the stack laid on another grid: 140 layers more, a gap under the sheet) */
      var ownPass = o.supportLayerMaxMm > 0 && perObject.some(function (P) { return P.role === 'support'; });
      perObject._colClaim = ownPass ? null : [];
      /* a support's first layer stands its first-layer gap off the part's (Bambu's Support/object first layer gap) - on the shared grid and on a
         support's own (below) */
      var firstGap = function (P) {
        if (!(o.supportFirstLayerGapMm != null && o.supportFirstLayerGapMm >= 0) || P.role !== 'support' || !P.S[0] || g.isEmpty(P.S[0])) return;
        var first = [];
        perObject.forEach(function (Q) { if (Q.role === 'part' && (P.hostKey == null || Q.key === P.hostKey) && Q.S[0] && !g.isEmpty(Q.S[0])) first.push(Q.S[0]); });
        if (first.length) P.S[0] = g.diff(P.S[0], g.offset(g.unionAll(first), o.supportFirstLayerGapMm));
      };
      perObject.forEach(firstGap);
      perObject.forEach(function (P) { colRule(P); buildLayers(P); });

      /* THE SUPPORT'S OWN LAYERS (o.supportLayerMaxMm; Bambu's independent_support_layer_height). A support is not cut on the part's 0.2 grid: its layers run
         from the first layer up to each top of its sheets (where it meets the part) in the fewest equal steps of at most supportLayerMaxMm - 0.2755 mm on a
         flat sheet, so the plate's 2 + 3 layers are 1.38 mm thick, not 1.0 - and the grid is the part's again where a stair's tops follow each other
         closer than that. The tops are found by typing the supports once on the shared grid; each support is then cut again on its own. */
      var ownGrids = false;
      if (o.supportLayerMaxMm > 0 && perObject.some(function (P) { return P.role === 'support'; })) {
        typeSupports(g, perObject, planes, o, minOver);
        perObject._colClaim = [];
        perObject.forEach(function (P, k) {
          if (P.role !== 'support') return;
          var own = supportGrid(P, planes, o.supportLayerMaxMm, shiftZ);
          if (!own) return;
          var P2 = makeP(objs[k], k, own);
          firstGap(P2);
          var claims = perObject._colClaim;
          perObject[k] = P2;
          perObject._colClaim = claims;
          colRule(P2);
          buildLayers(P2);
          ownGrids = true;
        });
      }


      /* THE SUPPORT AS IT PRINTS (o.columnStackOnly): each support's sections on its own grid after the column rule (S: the whole of it, I / T: its
         interface and transition), as hole-free pieces in the soup's frame - the supports card draws the support from them, so the generator shows
         what the slice prints (the rule lays the interface only when slicing: the generator showed a bare tree) */
      /* ...and with the whole slice (o.columnStacks): the supports card's Generate slices the plate once, draws its supports from this and keeps
         the slice itself for Preview - one slice, not one to draw and another to print */
      var stacks = null;
      if (o.columnStackOnly || o.columnStacks) {
        stacks = perObject.filter(function (P) { return P.role === 'support' && P.col; }).map(function (P) {
          var SPp = P.planes || planes, layers = [];
          SPp.forEach(function (pl, i) {
            var I = P.col.I[i], Tt = P.col.T[i], Sx = P.S[i];
            var hasI = I && !g.isEmpty(I), hasT = Tt && !g.isEmpty(Tt), hasS = Sx && !g.isEmpty(Sx);
            if (!hasI && !hasT && !hasS) return;
            /* S: the layer's whole support as it prints (the tree cut where it is blocked, the stack, the cups), I / T its interface and transition */
            /* printed: the layer has lines (a piece too small for one is cut but not printed) */
            var Lp = P.layers && P.layers[i], printed = !!(Lp && Lp.paths && Lp.paths.length);
            layers.push({ z0: pl.printZ - pl.h - shiftZ, z1: pl.printZ - shiftZ, printed: printed, I: hasI ? holeFree(g, I) : [], T: hasT ? holeFree(g, Tt) : [], S: hasS ? holeFree(g, Sx) : [] });
          });
          return { key: P.key, name: P.name, layers: layers };
        });
        if (o.columnStackOnly) return { ok: true, shiftZ: shiftZ, stacks: stacks };
      }

      if (!rp) addBrims(g, perObject, planes, o);
      var raftOb = rp ? addRaft(g, perObject, o, rp) : null;

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
            if (perObject[a].planes || perObject[b].planes) continue;         // on different grids: below
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

      if (ownGrids) {
        /* a support on its own grid against a part: its layer, and the part's layer that holds the height of its middle */
        perObject.forEach(function (Ps) {
          if (!Ps.planes) return;
          perObject.forEach(function (Pq) {
            if (Pq === Ps || Pq.planes) return;
            Ps.S.forEach(function (Sa, i) {
              if (g.isEmpty(Sa)) return;
              var zm = Ps.planes[i].printZ - Ps.planes[i].h / 2, k = -1;
              for (var q = 0; q < planes.length; q++) if (planes[q].printZ - planes[q].h <= zm + 1e-9 && zm <= planes[q].printZ + 1e-9) { k = q; break; }
              if (k < 0 || g.isEmpty(Pq.S[k])) return;
              var ov = g.inter(Sa, Pq.S[k]), ar = g.area(ov);
              if (ar > 1e-6) conflicts.push({ layer: i + 1, index: i, printZ: Ps.planes[i].printZ, a: Ps.name, b: Pq.name, areaMm2: ar, polys: g.polys(ov) });
            });
          });
        });
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
            id: P.id, name: P.name, flipped: P.flipped, nonSolid: P.nonSolid, role: P.role, planes: P.planes || null,
            key: P.key, hostKey: P.hostKey,       /* the caller's own: G-scope groups a support with the head it holds */
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
      if (stacks) result.stacks = stacks;
      if (raftOb) { result.objects.push(raftOb); result.raft = { layers: rp.N, base: rp.nB, interface: rp.nI, topMm: rp.top, liftMm: rp.lift }; }
      result.ms = Date.now() - t0;
      result.report = describe(result);
      if (o.emitGcode) result.gcode = toGcode(result);
      return result;
    } finally {
      g.free();
    }
  }

  /**
   * A brim region's loops, printed as Bambu prints its brim: the region shrunk
   * half a line, then a first-layer spacing at a time, every loop a path of
   * feature 'Brim' - the outer boundary's loops first (outermost first), then
   * the hole's. A ring 4.9 mm wide gives 5 + 5 = 10 loops.
   */
  function brimLoops(g, cs, o, h) {
    var w = o.brimLineWidthMm > 0 ? o.brimLineWidthMm : o.nozzleMm * 1.25, sp = spacingOf(w, h), outer = [], inner = [];
    for (var k = 0; k < 64; k++) {
      var c = g.offset(cs, -(w / 2 + k * sp), 'Round');
      if (g.isEmpty(c)) break;
      g.polys(c).forEach(function (pl) { (signedArea(pl) > 0 ? outer : inner).push({ feature: 'Brim', width: w, closed: true, pts: pl }); });
    }
    return outer.concat(inner.reverse());
  }

  /** Does this part want a brim? 'outer' every part; 'auto' one tall for its foot. */
  function brimWanted(o, heightMm, footMm2) {
    if (!o.brimType || o.brimType === 'none') return false;
    return o.brimType === 'outer' || heightMm / Math.sqrt(Math.max(footMm2, 1e-6)) >= o.brimAutoRatio;
  }

  /**
   * THE BRIM AS A SOLID, for the supports card: the brim a part wants (brimWanted;
   * `over` carries brimType 'auto' | 'outer' and the rest of the brim options) as one
   * layer of material round its foot, built to be placed on the plate with the part's
   * supports and sliced as role 'brim'. soup: the part (z up, anywhere), `avoid`: the
   * soups it must stay off (the supports already built: their pads, other pieces);
   * a brim stays brimSupportGapMm off each one's first layer. zPlate: the z the first
   * layer stands on (the part's lowest point by default). Returns { ok, needed,
   * soup (the ring's prism, one first layer thick), polys, areaMm2, loops } - needed
   * false when the part stands on a wide foot.
   */
  function brimFor(soup, over, wasm, avoid, zPlate) {
    var o = defaultsFor(over && over.nozzleMm, over);
    if (!(o.brimWidthMm > 0)) return { ok: true, needed: false, reason: 'brim width 0' };
    var g = geometry(wasm);
    try {
      var zMin = Infinity, zMax = -Infinity;
      for (var i = 2; i < soup.length; i += 3) { if (soup[i] < zMin) zMin = soup[i]; if (soup[i] > zMax) zMax = soup[i]; }
      var planes = slicePlanes(zMin, zMax, o);
      if (!planes.length) return { ok: true, needed: false, reason: 'no first layer' };
      function section0(sp) {
        var sm = sliceMesh(sp, [{ index: 0, printZ: planes[0].printZ, sliceZ: planes[0].sliceZ - zMin + (function () { var m = Infinity; for (var q = 2; q < sp.length; q += 3) if (sp[q] < m) m = sp[q]; return m; })(), h: planes[0].h }], o);
        var tot = 0;
        sm.sections.forEach(function (sec) { sec.loops.forEach(function (l) { tot += signedArea(l); }); });
        if (tot < 0) sm.sections.forEach(function (sec) { sec.loops.forEach(function (l) { l.reverse(); }); });
        var cs = g.of(sm.sections[0].loops, 'Positive');
        return g.simplify(o.sliceClosingRadiusMm > 0 && !g.isEmpty(cs) ? g.offset(g.offset(cs, o.sliceClosingRadiusMm, 'Miter'), -o.sliceClosingRadiusMm, 'Miter') : cs, o.resolutionMm);
      }
      var S0 = section0(soup);
      if (g.isEmpty(S0)) return { ok: true, needed: false, reason: 'the part has no first layer' };
      var outers = g.polys(S0).filter(function (p) { return signedArea(p) > 0; });
      if (!brimWanted(o, zMax - zMin, g.area(S0))) return { ok: true, needed: false, reason: 'stands on a wide foot' };
      var w = o.brimLineWidthMm > 0 ? o.brimLineWidthMm : o.nozzleMm * 1.25, gap = Math.max(0, o.brimObjectGapMm || 0);
      var region = g.of(outers, 'Positive');
      var ring = g.diff(g.offset(region, o.brimWidthMm, 'Round'), g.offset(region, gap, 'Round'));
      var av = [];
      (avoid || []).forEach(function (sp) {
        if (!sp || sp.length < 9) return;
        var lo = Infinity;
        for (var q = 2; q < sp.length; q += 3) if (sp[q] < lo) lo = sp[q];
        /* an avoided soup is cut where the first layer is: at the plate, not at its own lowest point (a part that does not stand on it has none) */
        if (zPlate != null && lo > zPlate + planes[0].h) return;
        var c = section0(sp);
        if (!g.isEmpty(c)) av.push(c);
      });
      if (av.length) ring = g.diff(ring, g.offset(g.unionAll(av), o.brimSupportGapMm != null ? o.brimSupportGapMm : 0.02, 'Round'));
      ring = g.dropSmall(ring, 1);
      if (g.isEmpty(ring)) return { ok: true, needed: true, soup: new Float32Array(0), polys: [], areaMm2: 0, loops: 0, reason: 'no room for a brim' };
      var z0 = zPlate != null ? zPlate : zMin, h = planes[0].h;
      var polys = g.polys(ring), prism = new wasm.CrossSection(polys, 'Positive').extrude(h);
      var mesh = prism.getMesh(), np = mesh.numProp, V = mesh.vertProperties, Tv = mesh.triVerts, out = new Float32Array(Tv.length * 3);
      for (var t = 0; t < Tv.length; t++) {
        out[t * 3] = V[Tv[t] * np]; out[t * 3 + 1] = V[Tv[t] * np + 1]; out[t * 3 + 2] = V[Tv[t] * np + 2] + z0;
      }
      try { prism.delete(); } catch (e) { /* freed */ }
      return { ok: true, needed: true, soup: out, polys: polys, areaMm2: g.area(ring), loops: brimLoops(g, ring, o, h).length };
    } finally {
      g.free();
    }
  }

  /**
   * THE BRIM. Round the first layer of a part (outer boundary only): loops
   * stepped one first-layer spacing apart from brimObjectGapMm out to
   * brimWidthMm (Bambu's six test heads: 10 loops of 0.5 mm line at 0.457
   * spacing, the first 0.1 mm off the wall, the outermost printed first). Each
   * loop is cut where it would come within half a line of another object's first
   * layer - the support's pad - so brim and pad touch at the edges and never
   * join; a run shorter than a millimetre is dropped. Printed before everything
   * else on the first layer, as feature 'Brim'.
   */
  /* THE RAFT (Bambu's raft, read off its own slices: fixtures/supports/supp_ref_raft.gcode.3mf, 10 layers under the six heads' trees, and
     raft_circle.gcode.3mf, 8 under a 50 mm disc with no support). Its own system between the plate and the first layer of everything on it,
     whatever that is - a part, a support or both. N layers: the top half (rounded up) interface, the rest base, Prusa's split (1: one interface,
     2: 1 + 1, 3: 1 + 2, 10: 5 + 5). The first at the first layer's height, the rest 0.75 x the nozzle (0.3 at 0.4: z 0.2, 0.5, 0.8 ...). Features
     as Bambu writes them: base Support, interface Support interface. The region: the first layer of everything, grown raft_expansion (1.5) under
     the top layer and 0.5 more under the others (the circle: 1.5 and 2.0 past the disc), the first layer RAFT.firstExtraMm more again (the circle's
     solid first layer, 2.9 - 3.4). Lines: the first layer solid along Y, the base along X at support_base_pattern_spacing (2.5 -> 2.86 apart),
     the interface at support_interface_spacing (0.1 -> 0.45 apart along Y under a tree; 0.5 -> 0.89 apart, 45 / 135 in turn, under a part alone),
     each layer one zig-zag joined along its edge. A support's first layer has a layer of its own under it on the raft's top, raftContactMm thick
     (Bambu's 0.1 layer at 3.0 under each trunk). */
  var RAFT = { layerOfNozzle: 0.75, baseExtraMm: 0.5, firstExtraMm: 1.0 };
  function raftPlan(o) {
    var N = Math.max(0, Math.min(50, Math.round(+o.raftLayers || 0)));
    if (!N) return null;
    var nI = Math.ceil(N / 2), nB = N - nI, h1 = Math.max(o.layerMm, RAFT.layerOfNozzle * o.nozzleMm), z = 0, layers = [];
    for (var k = 0; k < N; k++) {
      var h = k === 0 ? o.firstLayerMm : h1;
      z = Math.round((z + h) * 1e6) / 1e6;
      layers.push({ printZ: z, h: h, kind: k < nB ? 'base' : 'interface', iface: k - nB });
    }
    var gap = o.raftContactMm != null && o.raftContactMm >= 0 ? +o.raftContactMm : 0.1;
    return { N: N, nB: nB, nI: nI, layers: layers, top: z, gap: gap, lift: Math.round((z + gap) * 1e6) / 1e6 };
  }
  function addRaft(g, perObject, o, rp) {
    var feet = [], supFeet = [];
    perObject.forEach(function (P) {
      var S0 = P.S && P.S[0];
      if (!S0 || g.isEmpty(S0)) return;
      feet.push(S0);
      if (P.role === 'support') supFeet.push(S0);
    });
    if (!feet.length) return null;
    var F = g.unionAll(feet), w = o.supportWidthMm > 0 ? o.supportWidthMm : o.infillWidthMm;
    var exp = o.raftExpansionMm != null ? +o.raftExpansionMm : 1.5, withSup = supFeet.length > 0;
    var baseSp = o.raftBaseSpacingMm != null ? +o.raftBaseSpacingMm : 2.5, ifSp = o.raftInterfaceSpacingMm != null ? +o.raftInterfaceSpacingMm : 0.5;
    var planesR = [], layers = [];
    function fill(region, ang, pitch, feature, h, out) {
      var inner = g.offset(region, -w / 2);
      if (g.isEmpty(inner)) return;
      var segs = scanFill(g.polys(inner), ang, pitch, 0);
      if (segs.length) connect(segs, pitch + 2 * w + 1, g.polys(g.offset(region, 1e-3))).forEach(function (pth) {
        out.push({ feature: feature, width: w, closed: false, pts: pth.pts, raft: true, overhangMm: 0, overhangRuns: [] });
      });
    }
    rp.layers.forEach(function (rl, k) {
      var top = k === rp.N - 1, grow = exp + (rp.N > 1 && !top ? RAFT.baseExtraMm : 0) + (rp.N > 1 && k === 0 ? RAFT.firstExtraMm : 0);
      var R = g.offset(F, grow, 'Round'), out = [], sp = spacingOf(w, rl.h);
      if (rl.kind === 'base') {
        if (k === 0) fill(R, Math.PI / 2, w, 'Support', rl.h, out);
        else fill(R, 0, baseSp + sp, 'Support', rl.h, out);
      } else {
        var ang = withSup ? Math.PI / 2 : (rl.iface % 2 ? 3 : 1) * Math.PI / 4;
        fill(R, ang, ifSp + sp, 'Support interface', rl.h, out);
      }
      planesR.push({ index: k, printZ: rp.layers[k].printZ, sliceZ: null, h: rl.h });
      layers.push({ index: k, printZ: rl.printZ, h: rl.h, areaMm2: g.area(R), wallCount: 0, wallLoopsByDepth: [], thinWalls: 0, areas: null, overhangMm2: 0,
                    overhangPolys: [], sectionPolys: g.polys(R), paths: out });
    });
    if (withSup && rp.gap > 1e-6) {
      /* under each support's first layer, a layer that closes the contact gap (it stands on the raft, as Bambu's trunk does) */
      var Sg = g.unionAll(supFeet), out2 = [];
      g.polys(Sg).forEach(function (pl) { if (pl.length > 2) out2.push({ feature: 'Support', width: w, closed: true, pts: pl.map(function (q) { return q; }), raft: true, overhangMm: 0, overhangRuns: [] }); });
      var inS = g.offset(Sg, -w / 2);
      if (!g.isEmpty(inS)) fill(inS, Math.PI / 2, 2 * w, 'Support', rp.gap, out2);
      planesR.push({ index: rp.N, printZ: rp.lift, sliceZ: null, h: rp.gap });
      layers.push({ index: rp.N, printZ: rp.lift, h: rp.gap, areaMm2: g.area(Sg), wallCount: 0, wallLoopsByDepth: [], thinWalls: 0, areas: null, overhangMm2: 0,
                    overhangPolys: [], sectionPolys: g.polys(Sg), paths: out2 });
    }
    return { id: 'raft', name: 'Raft', flipped: false, nonSolid: false, role: 'raft', planes: planesR, support: null, triangles: 0, degenerate: 0,
             sectionStats: { openChains: 0, stitched: 0, closedByGap: 0, droppedChains: 0 }, wallCountHistogram: {}, layers: layers, overhang: [] };
  }

  function addBrims(g, perObject, planes, o) {
    if (!o.brimType || o.brimType === 'none' || !(o.brimWidthMm > 0)) return;
    var w = o.brimLineWidthMm > 0 ? o.brimLineWidthMm : o.nozzleMm * 1.25, gap = Math.max(0, o.brimObjectGapMm || 0);
    var sp = spacingOf(w, planes[0].h), N = Math.floor((o.brimWidthMm - gap - w) / sp + 1e-9) + 1;
    if (N < 1) return;
    perObject.forEach(function (P) {
      if (P.role !== 'part' || !P.layers.length) return;
      /* a part on supports: its brim is the supports card's (Brim round the foot, a brim object of its own) or none - never the auto brim
         round its trunks' feet (the owner: Brim round the foot off is no brim) */
      if (perObject.some(function (Q) { return (Q.role === 'brim' || Q.role === 'support') && Q.hostKey != null && Q.hostKey === P.key; })) return;
      var S0 = P.S[0];
      if (!S0 || g.isEmpty(S0)) return;
      var outers = g.polys(S0).filter(function (p) { return signedArea(p) > 0; });
      if (!outers.length) return;
      var top = 0;
      P.layers.forEach(function (L) { if (L.areaMm2 > 0 && L.printZ > top) top = L.printZ; });
      if (!brimWanted(o, top, g.area(S0))) return;
      var region = g.of(outers, 'Positive');
      var others = [];
      perObject.forEach(function (Q) { if (Q !== P && Q.S[0] && !g.isEmpty(Q.S[0])) others.push(Q.S[0]); });
      var forb = others.length ? g.polys(g.offset(g.unionAll(others), w / 2 + (o.brimSupportGapMm || 0))) : [];
      var out = [];
      for (var k = N - 1; k >= 0; k--) {                          // the outermost first
        g.polys(g.offset(region, gap + w / 2 + k * sp, 'Round')).forEach(function (loop) {
          if (signedArea(loop) <= 0) return;                  // a pinched-off pocket is not brimmed
          var pts = [], flags = [], STEP = 0.2, m = loop.length;
          for (var i = 0; i < m; i++) {
            var a = loop[i], b = loop[(i + 1) % m], len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len / STEP));
            for (var t = 0; t < n; t++) {
              var x = a[0] + (b[0] - a[0]) * t / n, y = a[1] + (b[1] - a[1]) * t / n;
              pts.push([x, y]); flags.push(forb.length ? inside(forb, x, y) : false);
            }
          }
          var first = flags.indexOf(true);
          if (first < 0) { out.push({ feature: 'Brim', width: w, closed: true, pts: loop }); return; }
          var runs = [], cur = null, np = pts.length;
          for (var j = 1; j <= np; j++) {
            var idx = (first + j) % np;
            if (!flags[idx]) { if (!cur) { cur = []; runs.push(cur); } cur.push(pts[idx]); } else cur = null;
          }
          runs.forEach(function (r) {
            if (r.length * STEP >= 1) out.push({ feature: 'Brim', width: w, closed: false, pts: r });
          });
        });
      }
      var L0 = P.layers[0];
      L0.paths = out.concat(L0.paths);
      L0.brimLoops = N;
    });
  }

  /**
   * Split a wall loop into runs over material (below it) and over air. A run
   * is over air when its edges' midpoints fall outside the layer below's
   * section. The first layer is never an overhang.
   */
  function splitOverhang(path, belowPolys, layerIndex, width, frac, subMm, belowIn) {
    var pts = path.pts;
    if (layerIndex === 0 || !belowPolys) return [{ over: false, closed: true, pts: pts }];
    var n = pts.length;
    var sub = subMm > 0 ? subMm : 0;
    /* One flag per stretch of the loop. An edge is judged at its midpoint (the rule as it was) - and, with `sub` (mm), along its length at that step,
       so a few tenths of a millimetre of overhang at an edge's end, a corner's ledge, are found where the midpoint alone sits over the layer below. */
    var P = [pts[0]], flags = [];
    /* the point judged is the line's centre moved (frac - 0.5) widths toward the material - frac 1: its inner edge - along the normal to the right of the
       travel (material is on the left of a loop's travel). A line whose inner edge is over air hangs whole. */
    var reach = (frac != null && width > 0) ? (0.5 - frac) * width : 0, rnx = 0, rny = 0;
    function over(x, y) { return !(belowIn ? belowIn(x + rnx * reach, y + rny * reach) : inside(belowPolys, x + rnx * reach, y + rny * reach)); }
    for (var i = 0; i < n; i++) {
      var p = pts[i], q = pts[(i + 1) % n];
      var ex = q[0] - p[0], ey = q[1] - p[1], el = Math.hypot(ex, ey);
      var k = sub > 0 ? Math.max(1, Math.ceil(el / sub - 1e-9)) : 1;
      if (el > 0) { rnx = ey / el; rny = -ex / el; }
      if (k === 1) {
        flags.push(over((p[0] + q[0]) / 2, (p[1] + q[1]) / 2));
        P.push(q);
        continue;
      }
      var sf = [];
      for (var u = 0; u < k; u++) { var t = (u + 0.5) / k; sf.push(over(p[0] + ex * t, p[1] + ey * t)); }
      /* the legacy midpoint rule decides an edge that is uniform; a mixed edge is cut where the flag changes */
      var uni = true;
      for (u = 1; u < k; u++) if (sf[u] !== sf[0]) { uni = false; break; }
      if (uni) { flags.push(sf[0]); P.push(q); continue; }
      for (u = 0; u < k; u++) {
        flags.push(sf[u]);
        P.push(u === k - 1 ? q : [p[0] + ex * (u + 1) / k, p[1] + ey * (u + 1) / k]);
      }
    }
    P.pop();                                   /* the closing point repeats the first */
    pts = P; n = pts.length;
    var any = false, all = true;
    for (var m = 0; m < n; m++) { if (flags[m]) any = true; else all = false; }
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

  var DOME_HOLE_MM2 = 8.0;   /* the largest hole of a dome's cup filled for its transition disc */
  var SUPPORT_HOLE_FILL_MM2 = 2.0;   /* a hole in a support's section smaller than this is filled (the dome apex's ring) */

  /**
   * A support's own layers (Bambu's independent support layer height): from the first layer up through each top of its sheets (P.sheet.sheets[].zHi,
   * found on the shared grid) and its last layer, each stretch in the fewest equal steps of at most maxH. Planes in the slicer's own shape.
   */
  function supportGrid(P, planes, maxH, shiftZ) {
    var z0 = planes[0].printZ, zEnd = z0, anchors = [];
    P.layers.forEach(function (L) { if (L.areaMm2 > 0 && L.printZ > zEnd) zEnd = L.printZ; });
    ((P.sheet && P.sheet.sheets) || []).forEach(function (sh) { anchors.push(sh.zHi); });
    anchors.push(zEnd);
    anchors = anchors.filter(function (a) { return a > z0 + 1e-6 && a <= zEnd + 1e-6; }).sort(function (a, b) { return a - b; });
    var zs = [z0], prev = z0;
    anchors.forEach(function (a) {
      var d = a - prev;
      if (d < 1e-6) return;
      /* a stretch after the first stands off the sheet top below it by one part layer, and the sheet above it by one more (Bambu's, measured on the Negative Sphere and the Sphere:
         10.4, then 10.6, then 12 equal steps to 13.8, then 14.0 and 14.2 - not 14 steps from 10.4 to 14.0). The last stretch ends on the support's own last layer: no sheet above it. */
      /* (under the column rule the anchors are the contacts themselves - a dome's lowest, then each one over it - and Bambu's stretch runs in equal steps right up to one: 10.6 to 13.8 in 12, no layer stood off under it) */
      var colGrid = P.sheet && P.sheet.rule === 'column';
      var hp = planes[0].h, offS = prev > z0 + 1e-6 && d > 4 * hp - 1e-6 ? hp : 0, offE = offS && !colGrid && a < zEnd - 1e-6 ? hp : 0;
      if (offS) { zs.push(prev + offS); prev += offS; d = a - prev; }
      var n = Math.max(1, Math.ceil((d - offE) / maxH - 1e-9));
      for (var q = 1; q <= n; q++) zs.push(prev + (d - offE) * q / n);
      if (offE) zs.push(a);
      prev = a;
    });
    if (zs.length < 2) return null;
    return zs.map(function (z, i) {
      var h = i === 0 ? planes[0].h : z - zs[i - 1];
      return { index: i, printZ: z, sliceZ: z - shiftZ - h / 2, h: h };
    });
  }

  /** Layers k of the host's planes whose underside is within gap + one layer over the top of layer i of the support's planes `sp`. */
  function layersOverX(sp, i, hostPl, gap) {
    var out = [];
    for (var k = 0; k < hostPl.length; k++) {
      var d = hostPl[k].printZ - hostPl[k].h - sp[i].printZ;
      if (d > gap + sp[i].h + 1e-6) break;
      if (d >= -1e-6) out.push(k);
    }
    return out;
  }

  /** Layers i of the support's planes `sp` whose top is within gap + one layer under the underside of layer k of the host's planes. */
  function layersUnderX(hostPl, k, sp, gap) {
    var out = [], under = hostPl[k].printZ - hostPl[k].h;
    for (var i = sp.length - 1; i >= 0; i--) {
      var d = under - sp[i].printZ;
      if (d < -1e-6) continue;
      if (d > gap + sp[i].h + 1e-6) break;
      out.push(i);
    }
    return out;
  }

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

  /* ===========================================================================
     THE COLUMN RULE (o.supportInterfaceRule 'column'; docs/SUPPORT-GATE.md). One owner for the interface, and no constant
     per head: the stack under the part is read off the part's own layers, column by column, as Bambu lays it.

       blocked(i)   the part at support layer i's own height, grown by the xy distance (supportXyMm), and the part whose
                    underside lies less than the gap (supportGapMm) over the layer's top: no support there, ever
       contact(i)   where the next layer up would be blocked: the part's underside within gap + that layer over layer i
       footprint    where the support stands under the part within reach (the generator's sheet, its caps and the tops of its
                    tips): the stack is laid there whole, on every layer it is not blocked
       rank         a column's layers counted down from its contact through the layers it is not blocked on: rank 0 - NI-1
                    interface, NI - NI+NT-1 transition, deeper the tree (the support's own section, Support)

     columnRule() cuts every layer of the support to it (the section less blocked, plus the stack) before its paths are built;
     columnType() then lays the stack: each region one loop and a zig-zag, the tree outside it Support.
     =========================================================================== */
  var COLUMN_REACH_MM = 0.4;     /* the footprint: the support within gap + (NI + NT) layers + this under the part */
  var COLUMN_FILL_IN_MM = 0.3;   /* a region's zig-zag ends this far in from its loop's line (the regional plate's IFILL_IN_MM) */
  var COLUMN_MIN_MM2 = 0.05;
  var COLUMN_SPILL_MM2 = 0.005;  /* a thin ring's bead may reach this much under or into the part (none to speak of: several rings at 0.05 touched 0.6 mm2) */
  var COLUMN_EDGE_OUT_MM = 0.38;  /* the overhang grown this much is the footprint: Bambu's loop centre 0.17 past the face's edge, and half a line */
  var COLUMN_CUP_REACH_MM = 0;     /* THE CUP, OFF (the owner, the 2x Oblique on the A1 mini: "Remove that bar and all of the patches" - on a slope the cup was a rail of Support under the stair's edge, and patches on the branches under the stack; Bambu has neither). 0.25 built it: */
  var COLUMN_CUP_REACH_MM_WAS = 0.25;  /* THE CUP: a stack's lowest layer further than this past what is under it is cantilevered (its edge loop's bead
                                      would stand on less than half its width) */
  var COLUMN_TWIG_MM2 = 0.6;       /* a piece of the support's section smaller than this is a twig (a 0.85 mm thin column is 0.57) */
  var COLUMN_RISER_XY_MM = 0.2;   /* a support layer keeps this off the part's layers in the gap over it (a stair's riser): Bambu's 2x Oblique, none closer than 0.18 */
  var COLUMN_TWIG_XY_MM = 0.2;     /* ...and keeps this off the part sideways, not the tree's xy distance */
  var COLUMN_CUP_BRIDGE_MM = 2;     /* a stack bridges a gap up to twice this between tips: no cup under the bridge */
  var COLUMN_CUP_HOLD_MM = 0.3;    /* a cup's ring stands within this of the ring or tree under it (a line's width less a margin) */
  var COLUMN_CUP_FIRST_MM = 0.1;   /* the cup's first ring: this far in from the stack's edge, under its edge loop */
  var COLUMN_CUP_MIN_MM2 = 2;      /* ...over at least this much of it (a sliver of half a mm2 walled a whole dome's stack: Circular's collar) */
  var COLUMN_CUP_RING_MM = 0.9;    /* the cup's wall: two lines */
  var COLUMN_CUP_DEG = 45;
  var COLUMN_CUP_HOLE_MM2 = 3;      /* ...not under a plate with a hole bigger than this (a rim round a cavity) */         /* ...stepping in this steeply going down */
  var COLUMN_LAND_MM = 0;        /* under the stack a column may run on down as Support (the base) until it stands on the support's own material, at most this far.
                                    0: no base - the transition spans between the tree's tips, as Bambu's does (a base of 3 mm printed as a block under every plate) */
  var COLUMN_TUBE_FILL_BELOW_MM = 1;     /* the tree's rings are crossed with base lines from this far under the part's lowest stack up (Bambu's) */
  var COLUMN_TUBE_MID_SNAP_MM = 0.4, COLUMN_TUBE_MID_MIN_MM = 0.5;   /* ...and a ring no line of the grid crosses takes one across its middle */
  var COLUMN_TUBE_FILL_MAX_MM = 2.6;     /* ...a line across a RING (a branch near its top), no longer: branches joined into one body are hollow, and a line across that lies over air */
  var COLUMN_TUBE_RING_MAX_MM2 = 6;      /* ...and only a piece this small is a ring (a 2 mm tip is 3.1 mm2, 2.6 across 5.3) */
  var COLUMN_Z_OVER_XY_MM = 0.2;         /* Z overrides X/Y: the least a support keeps from a wall beside it under an overhang */
  var COLUMN_TUBE_FILL_PITCH_MM = 2.5;   /* ...that far apart: Bambu's support_base_pattern_spacing */
  var COLUMN_BASE_PITCH_MM = 2;  /* the base's lines (Support), as far apart as this: the transition over it spans no more */
  /* the loops a stack's piece is laid with: one half a line in from its edge; a piece narrower than a line (a dome's or a cone's ring of contact,
     a few tenths wide) one loop down its middle (its outer edge in by half its mean width, 2 x area / perimeter), as Bambu lays such a ring - and
     that only where its bead stays out of the part and from under it (a line's width spilled under the part welds; into the xy clearance it does not). No loop: the piece is not laid. */
  /* a region as hole-free outlines (for a prism each): a piece with a hole is cut into strips STACK_STRIP_MM wide, then narrower, until none has one */
  var STACK_STRIP_MM = 1;
  function holeFree(g, cs) {
    var out = [];
    var hasHole = function (pc) { return g.polys(pc).some(function (Q) { var a2 = 0; for (var q = 0; q < Q.length; q++) { var u = Q[q], v = Q[(q + 1) % Q.length]; a2 += u[0] * v[1] - v[0] * u[1]; } return a2 < 0; }); };
    var take = function (pc, w, depth) {
      if (!hasHole(pc) || depth > 3) { g.polys(pc).forEach(function (Q) { var a2 = 0; for (var q = 0; q < Q.length; q++) { var u = Q[q], v = Q[(q + 1) % Q.length]; a2 += u[0] * v[1] - v[0] * u[1]; } if (a2 > 0) out.push(Q.map(function (pt) { return [pt[0], pt[1]]; })); }); return; }
      var x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      g.polys(pc).forEach(function (Q) { Q.forEach(function (pt) { x0 = Math.min(x0, pt[0]); x1 = Math.max(x1, pt[0]); y0 = Math.min(y0, pt[1]); y1 = Math.max(y1, pt[1]); }); });
      for (var x = x0; x < x1; x += w) {
        var band = g.inter(pc, g.of([[[x, y0 - 1], [x + w, y0 - 1], [x + w, y1 + 1], [x, y1 + 1]]], 'Positive'));
        if (!g.isEmpty(band)) g.parts(band).forEach(function (bp) { take(bp, w / 4, depth + 1); });
      }
    };
    g.parts(cs).forEach(function (pc) { take(pc, STACK_STRIP_MM, 0); });
    return out;
  }
  function columnLoops(g, pc, wI, Bj) {
    var loops = g.polys(g.offset(pc, -wI / 2));
    if (loops.length) return loops;
    var per = 0; g.polys(pc).forEach(function (Q) { for (var q = 0; q < Q.length; q++) { var u = Q[q], v = Q[(q + 1) % Q.length]; per += Math.hypot(v[0] - u[0], v[1] - u[1]); } });
    var tw = per > 0 ? 2 * g.area(pc) / per : 0;
    if (!(tw > 0.02)) return [];
    return g.polys(g.offset(pc, -0.45 * tw)).filter(function (Q) {
      var a2 = 0; for (var q = 0; q < Q.length; q++) { var u = Q[q], v = Q[(q + 1) % Q.length]; a2 += u[0] * v[1] - v[0] * u[1]; }
      if (!(a2 > 0)) return false;
      if (!Bj || g.isEmpty(Bj)) return true;
      var rp = g.of([Q], 'Positive'), bead = g.diff(g.offset(rp, wI / 2), g.offset(rp, -wI / 2));
      return g.area(g.inter(bead, Bj)) <= COLUMN_SPILL_MM2;
    });
  }
  function columnRule(g, P, perObject, planes, o) {
    var C = CONSTANTS.supportSheet;
    var NI = o.supportInterfaceLayers != null ? o.supportInterfaceLayers : C.interfaceLayers, NT = C.transitionLayers;
    var gap = o.supportGapMm, xy = o.supportXyMm != null ? o.supportXyMm : 0.35, SP = P.planes || planes, n = SP.length;
    var botGap = o.supportBottomGapMm > 0 ? o.supportBottomGapMm : 0, zOver = !!o.supportZOverridesXy, edgeOut = Math.max(0, COLUMN_EDGE_OUT_MM + (+o.supportExpansionMm || 0));
    var hMax = 0; SP.forEach(function (p) { if (p.h > hMax) hMax = p.h; });
    var reach = gap + (NI + NT) * hMax + COLUMN_REACH_MM;
    var parts = perObject.filter(function (Q) { return Q.role === 'part'; });
    var host = P.hostKey != null ? parts.find(function (Q) { return Q.key != null && Q.key === P.hostKey; }) || null : null;
    var hosts = host ? [host] : parts;
    var U = function (list) { return list.length ? g.unionAll(list) : null; };
    /* the part's overhang at each of its layers, at the threshold angle (supportThresholdDeg): the layer's section past the one under it by more than
       a layer / tan(angle) */
    /* a piece of the part's section smaller than a bead (a line squared: a dome's pole a hair under the slice plane) is not printed: it makes no
       contact and no overhang (it made a contact of its own a layer under the dome's, and the support's grid was anchored there, off Bambu's) */
    var specMm2 = o.outerWallWidthMm * o.outerWallWidthMm;
    var th = (o.supportThresholdDeg || 30) * Math.PI / 180, ovByK = [], zLo = SP[0].printZ, zHi = SP[n - 1].printZ + reach;
    for (var k3 = 1; k3 < planes.length; k3++) {
      if (planes[k3].printZ < zLo || planes[k3].printZ - planes[k3].h > zHi) continue;
      var ovk = [];
      hosts.forEach(function (Q) {
        if (g.isEmpty(Q.S[k3])) return;
        var ov = g.isEmpty(Q.S[k3 - 1]) ? Q.S[k3] : g.diff(Q.S[k3], g.offset(Q.S[k3 - 1], planes[k3].h / Math.tan(th)));
        if (!g.isEmpty(ov)) ov = g.dropSmall(ov, specMm2);
        if (!g.isEmpty(ov)) ovk.push(ov);
      });
      if (ovk.length) ovByK[k3] = U(ovk);
    }
    /* Z overrides X/Y: what of the part stands anywhere over each plane (its shadow), worked down from the top once */
    var shadow = null;
    if (zOver) {
      shadow = []; var acc = null;
      for (var ks = planes.length - 1; ks >= 0; ks--) {
        hosts.forEach(function (Q) { if (!g.isEmpty(Q.S[ks])) acc = acc ? g.union(acc, Q.S[ks]) : Q.S[ks]; });
        shadow[ks] = acc;
      }
    }
    var blocked = [], blockedHard = [], blockedTree = [], blockedTwig = [], contact = [], near = [];
    for (var i = 0; i < n; i++) {
      var zt = SP[i].printZ, zb = zt - SP[i].h, hn = i + 1 < n ? SP[i + 1].h : planes[0].h;
      var lat = [], ver = [], up = [], nr = [], upOv = [], bot = [];
      for (var k = 0; k < planes.length; k++) {
        var pz = planes[k].printZ, b = pz - planes[k].h;
        if (b > zt + reach) break;
        /* the part's top face a bottom distance or less under this layer (supportBottomGapMm): the layer does not stand on it */
        if (botGap > 0 && pz <= zb + 1e-6 && zb - pz < botGap - 1e-6) hosts.forEach(function (Q) { if (!g.isEmpty(Q.S[k])) bot.push(Q.S[k]); });
        if (pz <= zb + 1e-6) continue;
        var cs = [], csUp = [];
        hosts.forEach(function (Q) { if (!g.isEmpty(Q.S[k])) { cs.push(Q.S[k]); var big = g.dropSmall(Q.S[k], specMm2); if (!g.isEmpty(big)) csUp.push(big); } });
        if (!cs.length) continue;
        var d = b - zt;
        if (d < -1e-6) Array.prototype.push.apply(lat, cs);
        else if (d < gap - 1e-6) Array.prototype.push.apply(ver, cs);
        else if (d < gap + hn - 1e-6) { Array.prototype.push.apply(up, csUp); if (ovByK[k]) upOv.push(ovByK[k]); }
        if (d >= -1e-6) Array.prototype.push.apply(nr, cs);
      }
      var bl = [], L0 = U(lat), V0 = U(ver), hard = [], B0 = U(bot);
      var NR = null;
      if (zOver) { for (var kz = 0; kz < planes.length; kz++) if (planes[kz].printZ - planes[kz].h >= zt - 1e-6) { NR = shadow[kz]; break; } }
      /* the part beside a layer, grown by the xy distance - or, with Z overrides X/Y, by COLUMN_Z_OVER_XY_MM where the part stands over the layer */
      var sideOf = function (X) { return NR && xy > COLUMN_Z_OVER_XY_MM ? g.union(g.diff(g.offset(X, xy), g.diff(NR, X)), g.offset(X, COLUMN_Z_OVER_XY_MM)) : g.offset(X, xy); };
      if (L0) {
        /* Z OVERRIDES X/Y: under the part (where it stands within reach over this layer) the support keeps the top distance and comes in to
           COLUMN_Z_OVER_XY_MM of the wall beside it; elsewhere the xy distance, as ever */
        bl.push(sideOf(L0));
        hard.push(L0);
      }
      if (B0) { bl.push(B0); hard.push(B0); }
      /* ...and the part a gap or less over it (a slope's next layer, its riser) kept the gap's own distance sideways (COLUMN_RISER_XY_MM): a stair's
         tread stood to the riser's edge, a bead's corner under every overhang wall up the slope (the owner's 2x Oblique welded: 8 % of its
         support beads within 0.1 mm of the part, Bambu's 02.09 none under 0.15) - the treads now end short of it, a slope parallel to the part's */
      if (V0) { bl.push(g.offset(V0, COLUMN_RISER_XY_MM)); hard.push(V0); }
      /* a contact reaches past the edge of an overhang as the footprint does (not past a wall: the part's section beside it is no underside) */
      var UP = U(up), UO = U(upOv);
      blocked.push(U(bl)); blockedHard.push(U(hard)); contact.push(UP && UO ? g.union(UP, g.offset(UO, edgeOut)) : UP); near.push(U(nr));
      /* the tree (the support's own section, not the stack) keeps the xy distance from the part just over it too: a branch climbing past an
         overhang's edge (into a cavity, by the rim's hole) stood a bead's width under the rim's first layer */
      blockedTree.push(V0 ? U([U(bl), sideOf(V0)]) : U(bl));
      /* a twig (a horn's tip, a thin column: a piece of the support's section under COLUMN_TWIG_MM2) keeps COLUMN_TWIG_XY_MM: Bambu's horn
         stands its ring a hair off the wall under the shoulder it catches */
      var blT = []; if (L0) blT.push(g.offset(L0, COLUMN_TWIG_XY_MM)); if (V0) blT.push(g.offset(V0, COLUMN_TWIG_XY_MM));
      blockedTwig.push(U(blT));
    }
    /* the footprint, in plan: the support's sections where the part stands within reach over them, closed by half a line */
    var fp = [];
    for (var i2 = 0; i2 < n; i2++) if (near[i2] && !g.isEmpty(P.S[i2])) { var x = g.inter(P.S[i2], near[i2]); if (!g.isEmpty(x)) fp.push(x); }
    var F = U(fp);
    if (!F || g.isEmpty(F)) { P.col = null; return; }
    var r0 = o.outerWallWidthMm / 2;
    F = g.offset(g.offset(F, r0), -r0);
    /* THE FOOTPRINT IS THE OVERHANG: the part's underside where it is an overhang at the threshold angle (supportThresholdDeg) - a layer's
       section past the one under it by more than a layer / tan(angle) - grown COLUMN_EDGE_OUT_MM (Bambu's interface loop runs 0.17 mm past the
       face's edge: the region's edge is that and half a line). Each overhang region is taken whole where the generator's support serves it
       (meets its footprint above); a dome's steep flank is not an overhang, and is the tree's to hold (Bambu's tips). */
    var ovs = ovByK.filter(function (x) { return x && !g.isEmpty(x); });
    var FT = U(ovs);
    if (FT && !g.isEmpty(FT)) {
      var served = g.parts(g.offset(FT, edgeOut)).filter(function (pc) { return g.area(g.inter(pc, F)) > COLUMN_MIN_MM2; });
      if (served.length) F = g.unionAll(served);
    }
    if (typeof process !== 'undefined' && process.env && process.env.NSO_COLUMN_DEBUG) console.log('column footprint: overhang ' + (FT ? g.area(FT).toFixed(1) : '-') + ' mm2 in ' + ovs.length + ' pieces, footprint now ' + g.area(F).toFixed(1));
    var avail = [], I = [], T = [], R0 = [], rank = [];
    for (var i3 = 0; i3 < n; i3++) avail.push(blocked[i3] ? g.diff(F, blocked[i3]) : F);
    /* ranks, top down: rank r at layer i is the column available here whose rank r - 1 is on the layer above */
    for (var i4 = n - 1; i4 >= 0; i4--) {
      var rk = [];
      /* past an overhang's edge the band is a contact on neighbouring layers: both start a stack, and the column holds 4 interface layers -
         as Bambu's own do on a slope or a dome (13 - 24 % of their columns); following the topmost contact alone cut the plates' match */
      rk.push(contact[i4] ? g.inter(avail[i4], contact[i4]) : null);
      for (var r = 1; r < NI + NT; r++) {
        var above = i4 + 1 < n ? rank[i4 + 1][r - 1] : null;
        rk.push(above && !g.isEmpty(above) ? g.inter(avail[i4], above) : null);
      }
      rank[i4] = rk.map(function (cs) { return cs && !g.isEmpty(cs) ? g.dropSmall(cs, COLUMN_MIN_MM2) : null; });
    }
    /* THE BASE: under the stack's last rank a column runs on down through the layers it is not blocked on, as Support, until the support's own
       section is there to stand on (it stops on it), at most COLUMN_LAND_MM - a column that lands nowhere goes, with what stood on it (below) */
    var hMin = Infinity; SP.forEach(function (p) { if (p.h < hMin) hMin = p.h; });
    var K = COLUMN_LAND_MM > 0 ? Math.max(1, Math.ceil(COLUMN_LAND_MM / hMin)) : 0, deepK = [], deep = [];
    for (var i7 = n - 1; i7 >= 0; i7--) {
      var dk = [];
      for (var k2 = 0; k2 < K; k2++) {
        var src = k2 === 0 ? (i7 + 1 < n ? rank[i7 + 1][NI + NT - 1] : null) : (i7 + 1 < n ? deepK[i7 + 1][k2 - 1] : null);
        if (!src || g.isEmpty(src)) { dk.push(null); continue; }
        var dd = g.inter(avail[i7], src);
        if (!g.isEmpty(P.S[i7])) dd = g.diff(dd, P.S[i7]);
        dk.push(g.isEmpty(dd) ? null : g.dropSmall(dd, COLUMN_MIN_MM2));
      }
      deepK[i7] = dk;
      var dl = dk.filter(function (cs) { return cs && !g.isEmpty(cs); });
      deep[i7] = dl.length ? g.unionAll(dl) : null;
    }
    var D = [];
    for (var i5 = 0; i5 < n; i5++) {
      var iL = rank[i5].slice(0, NI).filter(function (cs) { return cs && !g.isEmpty(cs); });
      var tL = rank[i5].slice(NI).filter(function (cs) { return cs && !g.isEmpty(cs); });
      var Ii = U(iL), Ti = U(tL);
      if (Ii && Ti) Ti = g.diff(Ti, Ii);
      Ii = Ii && !g.isEmpty(Ii) ? Ii : null; Ti = Ti && !g.isEmpty(Ti) ? Ti : null;
      /* the support's section on this layer: never where it is blocked, and the stack laid whole - each piece of the stack only where it
         stands on something (the layer below as it is now built): a piece the grown footprint laid over air goes, and what stood on it */
      var S = P.S[i5], base = null;
      if (!g.isEmpty(S)) {
        var twigs = [], boughs = [];
        g.parts(S).forEach(function (pc) { (g.area(pc) < COLUMN_TWIG_MM2 ? twigs : boughs).push(pc); });
        var cut = function (list, B) { if (!list.length) return null; var u = g.unionAll(list); return B ? g.diff(u, B) : u; };
        var bb = [cut(boughs, blockedTree[i5]), cut(twigs, blockedTwig[i5])].filter(function (cs) { return cs && !g.isEmpty(cs); });
        base = bb.length ? (bb.length > 1 ? g.union(bb[0], bb[1]) : bb[0]) : g.diff(S, S);   /* all of it cut: an empty section, not the uncut one */
      }
      var wI0 = o.supportWidthMm > 0 ? o.supportWidthMm : o.infillWidthMm;
      var layable = function (cs) {
        if (!cs) return null;
        var keep = g.parts(cs).filter(function (pc) { return columnLoops(g, pc, wI0, blockedHard[i5]).length > 0; });
        return keep.length ? g.unionAll(keep) : null;
      };
      Ii = layable(Ii); Ti = layable(Ti);
      var Di = deep[i5] ? (Ii || Ti ? g.diff(deep[i5], Ii && Ti ? g.union(Ii, Ti) : Ii || Ti) : deep[i5]) : null;
      if (Di && g.isEmpty(Di)) Di = null;
      /* ONE STACK, ONE OWNER (the owner's mouse: 16 supports under one part each laid the whole interface and transition under it - 8.8 x Bambu's
         lines on the same plates, 55 g of interface against 6; the 2x Oblique's two supports laid two stacks, one's transition over the other's
         interface). A support lays only what no support before it in this slice has laid at a height its layer meets (perObject._colClaim), and its
         own section stops under what another's stack holds: the stack is printed once, by the first support that lays it */
      var claimZt = SP[i5].printZ, claimZb = claimZt - SP[i5].h, Cl = null;
      if (perObject._colClaim && perObject._colClaim.length) {
        var cl = perObject._colClaim.filter(function (c) { return Math.min(c.zt, claimZt) - Math.max(c.zb, claimZb) > 1e-6; }).map(function (c) { return c.region; });
        Cl = cl.length ? (cl.length > 1 ? g.unionAll(cl) : cl[0]) : null;
      }
      if (Cl) {
        var less = function (cs) { if (!cs) return null; var r = g.diff(cs, Cl); r = g.isEmpty(r) ? null : g.dropSmall(r, COLUMN_MIN_MM2); return r && !g.isEmpty(r) ? r : null; };
        Ii = less(Ii); Ti = less(Ti); Di = less(Di);
        if (base && !g.isEmpty(base)) base = g.diff(base, Cl);
      }
      if (i5 > 0 && Di) {
        var keepD = g.parts(Di).filter(function (pc) { return !g.isEmpty(P.S[i5 - 1]) && g.area(g.inter(pc, P.S[i5 - 1])) > COLUMN_MIN_MM2; });
        Di = keepD.length ? g.unionAll(keepD) : null;
      }
      D.push(Di);
      if (i5 > 0 && (Ii || Ti)) {
        var under = P.S[i5 - 1];
        var held = function (cs) {
          if (!cs) return null;
          var keep = g.parts(cs).filter(function (pc) { return g.area(g.inter(pc, under)) > COLUMN_MIN_MM2 || (base && g.area(g.inter(pc, base)) > COLUMN_MIN_MM2); });
          return keep.length ? g.unionAll(keep) : null;
        };
        if (g.isEmpty(under)) { Ii = null; Ti = null; } else { Ii = held(Ii); Ti = held(Ti); }
        if (R0[i5 - 1] === undefined) { /* nothing */ }
      }
      I.push(Ii); T.push(Ti); R0.push(Ii && rank[i5][0] ? g.inter(rank[i5][0], Ii) : null);
      var parts2 = [];
      if (base) parts2.push(base);
      if (Ii) parts2.push(Ii);
      if (Ti) parts2.push(Ti);
      if (Di) parts2.push(Di);
      P.S[i5] = parts2.length ? g.unionAll(parts2) : (base || S);
      if (perObject._colClaim) {
        var mine = [Ii, Ti, Di].filter(function (cs) { return cs && !g.isEmpty(cs); });
        if (mine.length) perObject._colClaim.push({ zb: claimZb, zt: claimZt, region: mine.length > 1 ? g.unionAll(mine) : mine[0] });
      }
    }
    /* THE CUP (the owner's: "the interfaces supported from below, within bridge tolerances"; Bambu's dome supports flare up to the plate's edge).
       Where a stack's lowest layer reaches further than COLUMN_CUP_REACH_MM past the tree under it, a ring wall (COLUMN_CUP_RING_MM wide) stands
       under its edge and steps in a layer's height each layer down (45 deg: every step printable) until it lands on the tree or closes - one
       wall, the branches inside it keep their own. */
    if (COLUMN_CUP_REACH_MM > 0 && !(typeof process !== 'undefined' && process.env && process.env.NSO_NO_CUP)) {
      var cupStep = Math.tan(COLUMN_CUP_DEG * Math.PI / 180);
      for (var ic = n - 1; ic >= 1; ic--) {   /* top down: a cup built under a wider layer holds the narrower layers under it too */
        var stk = I[ic] && T[ic] ? g.union(I[ic], T[ic]) : I[ic] || T[ic];
        if (!stk) continue;
        var stkB = I[ic - 1] && T[ic - 1] ? g.union(I[ic - 1], T[ic - 1]) : I[ic - 1] || T[ic - 1];
        var bottom = stkB ? g.diff(stk, stkB) : stk;
        if (g.isEmpty(bottom)) continue;
        bottom = g.dropSmall(bottom, COLUMN_MIN_MM2);
        g.parts(bottom).forEach(function (pc) {
          /* a plate with a hole (a rim round a cavity) has nothing for a cup to close onto: its rings narrow into the air. Its branches hold it,
             as Bambu's rims are held */
          /* a stack widening up a dome: its lowest layer here is a ring round the stack below - the cup stands under the whole of it */
          var C0 = pc;
          if (stkB) { var cu = g.parts(g.union(pc, stkB)).filter(function (q) { return !g.isEmpty(g.inter(q, pc)); }); if (cu.length) C0 = g.unionAll(cu); }
          var holeArea = 0;
          g.polys(C0).forEach(function (Q) { var a2 = 0; for (var q = 0; q < Q.length; q++) { var u = Q[q], v = Q[(q + 1) % Q.length]; a2 += u[0] * v[1] - v[0] * u[1]; } if (a2 < 0) holeArea += -a2 / 2; });
          if (holeArea > COLUMN_CUP_HOLE_MM2) return;
          var tree = P.S[ic - 1];
          /* the piece's cantilever: its part further than the reach from what stands under it. Between tips a plate BRIDGES (the tree closed over
             gaps of COLUMN_CUP_BRIDGE_MM each side is what holds it); a dome's stack stepping out over the layer under it more than
             COLUMN_CUP_REACH_MM past that is cantilevered (its ring is over nothing: its own lower layer is the edge it steps from) */
          var stepOut = stkB && !g.isEmpty(g.inter(g.offset(pc, 0.05), stkB));
          /* a plate's lowest layer (no stack under it) stands on its tips (the planner's spots fill every plate, nso_support_gridpack.js fillSpots): no
             wall round its edge - that was a block round the branches (the owner's: "the branches turning into a block") */
          if (!stepOut) return;
          var held = g.isEmpty(tree) ? tree : g.offset(g.offset(tree, COLUMN_CUP_BRIDGE_MM), -COLUMN_CUP_BRIDGE_MM);
          var far = g.isEmpty(tree) ? pc : g.diff(pc, g.offset(held, COLUMN_CUP_REACH_MM));
          if (g.isEmpty(far) || g.area(far) < COLUMN_CUP_MIN_MM2) return;
          var C = C0, rings = [], landed = false;
          for (var jc = ic - 1; jc >= 0; jc--) {
            /* the cup narrows a layer's height a layer (its first ring right under the stack's edge loop), but not off the tree: where it is over a
               branch already it stops there (it closes onto the tree, not past it) */
            var underJ = P.S[jc], Cn = g.offset(C, jc === ic - 1 ? -COLUMN_CUP_FIRST_MM : -SP[jc + 1].h * cupStep);
            C = !g.isEmpty(underJ) ? g.union(Cn, g.inter(C, g.offset(underJ, -COLUMN_CUP_RING_MM / 2))) : Cn;
            if (g.isEmpty(C)) break;
            var ring = g.diff(C, g.offset(C, -COLUMN_CUP_RING_MM)), ring0 = g.area(ring);
            /* a ring the part cuts (it would stand round the cut, its rings above in the air there) ends the cup, unlanded */
            if (blockedTree[jc]) { ring = g.diff(ring, blockedTree[jc]); if (ring0 - g.area(ring) > COLUMN_MIN_MM2) break; }
            ring = g.dropSmall(ring, COLUMN_MIN_MM2);
            if (g.isEmpty(ring)) break;
            rings.push({ j: jc, ring: ring });
            /* landed: no part of the ring further than a line from the tree under it */
            var under = jc > 0 ? P.S[jc - 1] : null;                   /* what the ring stands on: the layer under it */
            if (jc === 0 || (!g.isEmpty(under) && g.area(g.diff(ring, g.offset(under, o.outerWallWidthMm))) < COLUMN_MIN_MM2)) { landed = true; break; }
          }
          /* a cup that closes before it reaches the tree would hang its last ring in the air: none is built (a rim's ring narrows from both
             sides and closed over air) */
          if (typeof process !== 'undefined' && process.env && process.env.NSO_CUP_DEBUG) { var bb = g.bbox ? g.bbox(C0) : null; console.log('cup ' + P.name + ' z ' + SP[ic].printZ.toFixed(3) + ' piece ' + g.area(pc).toFixed(2) + ' C0 ' + g.area(C0).toFixed(2) + ' far ' + g.area(far).toFixed(2) + ' rings ' + rings.length + (rings.length ? ' down to z ' + SP[rings[rings.length - 1].j].printZ.toFixed(3) : '') + (landed ? ' LANDED' : ' dropped') + ' ' + JSON.stringify(g.polys(C0).map(function (Q) { var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; Q.forEach(function (v) { x0 = Math.min(x0, v[0]); x1 = Math.max(x1, v[0]); y0 = Math.min(y0, v[1]); y1 = Math.max(y1, v[1]); }); return [+x0.toFixed(1), +x1.toFixed(1), +y0.toFixed(1), +y1.toFixed(1)]; }))); }
          /* every ring stands on what is under it: from the landing up, a ring keeps only what is within COLUMN_CUP_HOLD_MM of the ring or the
             tree under it - a band narrowing from both sides (a horseshoe of rim) closes over the air, and that much of it is not built */
          if (landed) {
            var kept = [];
            for (var rr = rings.length - 1; rr >= 0; rr--) {
              var rg = rings[rr], belowJ = rg.j > 0 ? P.S[rg.j - 1] : null;
              if (rr < rings.length - 1) {
                var prev = kept.length ? kept[kept.length - 1] : null;
                var rest = prev && prev.j === rg.j - 1 ? (g.isEmpty(belowJ) ? prev.ring : g.union(belowJ, prev.ring)) : belowJ;
                rg = { j: rg.j, ring: g.isEmpty(rest) ? null : g.dropSmall(g.inter(rg.ring, g.offset(rest, COLUMN_CUP_HOLD_MM)), COLUMN_MIN_MM2) };
                if (!rg.ring || g.isEmpty(rg.ring)) break;
              }
              kept.push(rg);
            }
            /* ...and a cup whose rings stop short of the stack holds nothing: its kept rings were a slab a layer under the stack, the air between them
               (the Negative Sphere2's horseshoe ends) - all or nothing */
            if (kept.length === rings.length) kept.forEach(function (r) { P.S[r.j] = g.isEmpty(P.S[r.j]) ? r.ring : g.union(P.S[r.j], r.ring); });
          }
        });
      }
    }
    if (typeof process !== 'undefined' && process.env && process.env.NSO_COLUMN_DEBUG) {
      var A = function (cs) { return cs && !g.isEmpty(cs) ? g.area(cs).toFixed(2) : '-'; };
      console.log('column rule ' + P.name + ' (' + (host ? host.name : 'all parts') + '): footprint ' + A(F) + ' mm2');
      for (var i6 = 0; i6 < n; i6++) if (SP[i6].printZ > +process.env.NSO_COLUMN_DEBUG) console.log('  z ' + SP[i6].printZ.toFixed(3) + ' S ' + A(P.S[i6]) + ' blocked∩F ' + A(blocked[i6] ? g.inter(F, blocked[i6]) : null) + ' contact∩F ' + A(contact[i6] ? g.inter(F, contact[i6]) : null) + ' I ' + A(I[i6]) + ' T ' + A(T[i6]));
    }
    P.col = { I: I, T: T, D: D, R0: R0, NI: NI, NT: NT, footprint: F, blocked: blocked, blockedHard: blockedHard, rank: rank };
  }

  /* the stack laid: each of a layer's regions one loop round its edge (half a line in) and a zig-zag inside it at Bambu's interface
     pitch (a line and 0.04), the first layer of a stack at 110 degrees; every path outside the stack is Support.
     SQUARE TO THE BRIDGE (Bambu Studio 02.09, the owner's mouse1 slice: transition 90, then 93.6 / 3.6 / 93.6 under a bridge at 3.6; the
     owner: "every interface is square from the bridge above - parallel lines weld easier"): above its first layer a stack takes the angle
     of the part's layer that bridges its top - the top layer square to it, and so on down, one turn a layer. */
  var STUDIO36_DEG = 3.6;   /* Studio 02.09's bridge over the owner's mouse1 supports, and the stack's turn under it (layers 210 - 219) */
  function columnType(g, P, SP, o, host, planes, hostStacks) {
    var wI = o.supportWidthMm > 0 ? o.supportWidthMm : o.infillWidthMm, pitch = wI + 0.04, aD = (o.infillDirectionDeg || 45) * Math.PI / 180;
    var counts = { 'Support': 0, 'Support transition': 0, 'Support interface': 0 }, stackIdx = [], regs = [], sheets = [], up = [];
    var NI = P.col.NI, NT = P.col.NT;
    P.layers.forEach(function (L, j) {
      var I = P.col.I[j], T = P.col.T[j];
      var R = I && T ? g.union(I, T) : I || T;
      regs[j] = R;
      stackIdx[j] = R && j > 0 && regs[j - 1] && g.area(g.inter(R, regs[j - 1])) > 0.05 ? stackIdx[j - 1] + 1 : 0;
    });
    /* how many of the stack's layers lie over each one, and the angle of the part's layer on its top (the solid fill's: infillDirectionDeg, turned a
       quarter on every other layer - its Bridge over the stack is laid at it) */
    /* the lowest stack under the part - any of its supports' (a stack has one owner: the 2x Oblique's second tree owned none, and every one of its
       rings stood hollow - the owner's "the tips are still not complete on the other tree") */
    var tubeFillFrom = null, hostFillFrom = null;
    (hostStacks || []).forEach(function (st) { var zf = st.zb - COLUMN_TUBE_FILL_BELOW_MM; if (tubeFillFrom == null || zf < tubeFillFrom) tubeFillFrom = zf; if (hostFillFrom == null || zf < hostFillFrom) hostFillFrom = zf; });
    for (var jf = 0; jf < P.layers.length; jf++) if (regs[jf] && !g.isEmpty(regs[jf])) { var zf2 = SP[jf].printZ - SP[jf].h - COLUMN_TUBE_FILL_BELOW_MM; if (tubeFillFrom == null || zf2 < tubeFillFrom) tubeFillFrom = zf2; break; }
    for (var ju = P.layers.length - 1; ju >= 0; ju--) up[ju] = regs[ju] && ju + 1 < P.layers.length && regs[ju + 1] && stackIdx[ju + 1] === stackIdx[ju] + 1 ? up[ju + 1] + 1 : 0;
    var PLh = (host && host.planes) || planes, dirB = (o.infillDirectionDeg || 0) * Math.PI / 180;
    /* the bridge over a stack's top: the lowest of the part's layers over it (within 1.5 mm) whose Bridge / Bottom surface lines cross the top's
       region - their own direction (the longest run's), so a slope's or a dome's stack takes the layer that really rests on it, gap or none;
       else the part's first layer a gap over the top, by the solid fill's turn */
    var bridgeMemo = {};
    function bridgeAngleOver(jt) {
      if (bridgeMemo[jt] !== undefined) return bridgeMemo[jt];
      var res = null, zt = SP[jt].printZ, Rt = regs[jt];
      var HL = host && host.layers;
      if (HL && Rt && PLh) {
        var Rtp = g.polys(g.offset(Rt, 0.2));
        for (var ih = 0; ih < PLh.length && res == null; ih++) {
          if (!(PLh[ih].printZ > zt + 1e-6) || PLh[ih].printZ > zt + 1.5) continue;
          var Lh = HL[ih], bestL = 0;
          if (!Lh || !Lh.paths) continue;
          Lh.paths.forEach(function (pth) {
            if (pth.feature !== 'Bridge' && pth.feature !== 'Bottom surface') return;
            for (var q = 1; q < pth.pts.length; q++) {
              var a = pth.pts[q - 1], b = pth.pts[q], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
              if (l > bestL && inside(Rtp, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) { bestL = l; res = Math.atan2(b[1] - a[1], b[0] - a[0]); }
            }
          });
          if (res != null && bestL < 0.6) res = null;                       /* a stub is no direction */
        }
      }
      if (res == null && PLh && PLh.length) {
        var zg = zt + (o.supportGapMm || 0);                                  /* the part's first layer over the stack is a gap over its top */
        for (var ig = 0; ig < PLh.length; ig++) if (PLh[ig].printZ - PLh[ig].h >= zg - 1e-6) { res = ig % 2 === 0 ? dirB : dirB + Math.PI / 2; break; }
      }
      bridgeMemo[jt] = res;
      return res;
    }
    P.layers.forEach(function (L, j) {
      var I = P.col.I[j], T = P.col.T[j], R = regs[j];
      if (P.col.R0[j]) sheets.push({ topLayer: j, zLo: SP[Math.max(0, j - NI - NT + 1)].printZ - SP[Math.max(0, j - NI - NT + 1)].h, zHi: SP[j].printZ, areaMm2: g.area(P.col.R0[j]), tips: 0 });
      var out = [];
      var Rp = R ? g.polys(g.offset(R, 1e-3)) : [];
      L.paths.forEach(function (p) {
        if (p.colPlate) { out.push(p); return; }
        if (!Rp.length) { p.feature = 'Support'; out.push(p); return; }
        /* the tree's paths outside the stack: a path is cut where it runs into a region (the region's own loop replaces the wall there) */
        var pts = p.pts, np = pts.length, m = p.closed ? np : np - 1, dense = [];
        for (var e = 0; e < m; e++) {
          var a = pts[e], b = pts[(e + 1) % np], l = Math.hypot(b[0] - a[0], b[1] - a[1]), ns = Math.max(1, Math.ceil(l / 0.2));
          for (var q = 0; q < ns; q++) dense.push([a[0] + (b[0] - a[0]) * q / ns, a[1] + (b[1] - a[1]) * q / ns]);
        }
        if (!p.closed && np) dense.push(pts[np - 1]);
        var inn = dense.map(function (pt) { return inside(Rp, pt[0], pt[1]); });
        if (!inn.some(Boolean)) { p.feature = 'Support'; out.push(p); return; }
        var run = [];
        /* ...and a run shorter than a millimetre is no line (a dab where a ring's cut ends meet the stack: the owner's "patches") */
        var flush = function () { var lr = 0; for (var qq = 1; qq < run.length; qq++) lr += Math.hypot(run[qq][0] - run[qq - 1][0], run[qq][1] - run[qq - 1][1]); if (run.length >= 2 && lr >= 1) { var np2 = {}; Object.keys(p).forEach(function (kk) { np2[kk] = p[kk]; }); np2.pts = run; np2.closed = false; np2.feature = 'Support'; out.push(np2); } run = []; };
        for (var q2 = 0; q2 < dense.length; q2++) { if (inn[q2]) flush(); else run.push(dense[q2]); }
        if (p.closed && run.length && !inn[0]) { run.push(dense[0]); }
        flush();
      });
      if (R) {
        var mode = o.supportInterfaceAngle || 'bridge', ang;
        if (mode === 'studio36') ang = stackIdx[j] === 0 ? Math.PI / 2 : (STUDIO36_DEG * Math.PI / 180) + Math.PI / 2 + (up[j] % 2) * Math.PI / 2;
        else if (mode === 'profile') ang = stackIdx[j] === 0 ? ((o.supportAngleDeg || 0) + 90) * Math.PI / 180 : ((o.bridgeAngleDeg || STUDIO36_DEG) + 90 + (up[j] % 2) * 90) * Math.PI / 180;
        else if (mode === 'crosshatch') ang = stackIdx[j] === 0 ? 110 * Math.PI / 180 : (stackIdx[j] % 2 === 1 ? aD : aD + Math.PI / 2);
        else {
          var bA = stackIdx[j] > 0 ? bridgeAngleOver(j + up[j]) : null;
          ang = stackIdx[j] === 0 ? 110 * Math.PI / 180 : bA != null ? bA + Math.PI / 2 + (up[j] % 2) * Math.PI / 2 : (stackIdx[j] % 2 === 1 ? aD : aD + Math.PI / 2);
        }
        [[I, 'Support interface'], [T, 'Support transition']].forEach(function (rg) {
          if (!rg[0]) return;
          g.parts(rg[0]).forEach(function (pc) {
            var loops = columnLoops(g, pc, wI, P.col.blockedHard[j]);
            loops.forEach(function (ring) { if (ring.length > 2) out.push({ feature: rg[1], width: wI, closed: true, pts: ring, typed: true, colPlate: true }); });
          });
          var inner = g.offset(rg[0], -(wI / 2 + COLUMN_FILL_IN_MM));
          if (g.isEmpty(inner)) return;
          /* 'profile' (Bambu's rule): each point turns by its own depth under the contact over it (columnRule's ranks), not the region's -
             a slope's stack is a top contact all the way up (Bambu's 2x Oblique: 135 on every 0.2 layer), the flat sheet under it one turn a
             layer; a stack's lowest layer (its last rank) at support_angle + 90 */
          var fills = [[inner, ang]];
          if (mode === 'profile' && P.col.rank && P.col.rank[j]) {
            fills = [];
            var rem = inner, RK = P.col.rank[j];
            for (var r = 0; r < RK.length && !g.isEmpty(rem); r++) {
              if (!RK[r]) continue;
              var pcR = g.inter(rem, RK[r]);
              if (g.isEmpty(pcR)) continue;
              rem = g.diff(rem, RK[r]);
              g.parts(pcR).forEach(function (q) {
                var first = r === RK.length - 1;
                fills.push([q, first ? ((o.supportAngleDeg || 0) + 90) * Math.PI / 180 : ((o.bridgeAngleDeg || STUDIO36_DEG) + 90 + (r % 2) * 90) * Math.PI / 180]);
              });
            }
            if (!g.isEmpty(rem)) fills.push([rem, ang]);
          }
          /* the profile's interface spacing (support_interface_spacing: the gap between lines) over a bead's spacing - 0.5 lays them 0.86 apart,
             Bambu's own on the owner's P1S print that released clean; 0.1 the 0.46 of the dense sheet. Without one, the dense sheet's line + 0.04 */
          var pj = o.supportInterfaceSpacingMm != null ? spacingOf(wI, SP[j].h || 0.2) + o.supportInterfaceSpacingMm : pitch;
          var hullR = g.polys(g.offset(rg[0], 1e-3));
          /* THE INTERFACE PATTERN (Bambu's Interface pattern; 'default' is the angle rule above): Rectilinear lays every layer of a stack one way
             (the stack's first layer's), Rectilinear interlaced turns a quarter a layer, Grid lays both ways on every layer at twice the spacing,
             Concentric rings in from the region's edge */
          var ipat = o.supportInterfacePattern || 'default';
          if (ipat !== 'default') {
            var a0 = mode === 'profile' ? ((o.supportAngleDeg || 0) + 90) * Math.PI / 180 : mode === 'studio36' ? Math.PI / 2 : 110 * Math.PI / 180;
            if (ipat === 'concentric') {
              concentricFill(g, inner, wI, SP[j].h || 0.2, pj, false, null).forEach(function (pth) {
                if (pth.pts.length > 1) out.push({ feature: rg[1], width: wI, closed: !!pth.closed, pts: pth.pts, sheetFill: true, colPlate: true });
              });
              return;
            }
            fills = ipat === 'grid' ? [[inner, a0, 2 * pj], [inner, a0 + Math.PI / 2, 2 * pj]]
              : ipat === 'rectilinear_interlaced' ? [[inner, a0 + (stackIdx[j] % 2) * Math.PI / 2]] : [[inner, a0]];
          }
          fills.forEach(function (fl) {
            if (fl[2]) { var sg2 = scanFill(g.polys(fl[0]), fl[1], fl[2], 0); if (sg2.length) connect(sg2, 3 * fl[2], hullR).forEach(function (pth) { out.push({ feature: rg[1], width: wI, closed: false, pts: pth.pts, sheetFill: true, colPlate: true }); }); return; }
            var segs = scanFill(g.polys(fl[0]), fl[1], pj, 0);
            if (segs.length) connect(segs, 3 * pj, hullR).forEach(function (pth) {
              out.push({ feature: rg[1], width: wI, closed: false, pts: pth.pts, sheetFill: true, colPlate: true });
            });
          });
        });
      }
      /* LINES INSIDE THE TUBE NEAR THE TOP (the owner's 2x Oblique against Bambu's: "both should have been within the tube"). Bambu's branch rings
         carry its base pattern inside - rectilinear, a line or two across a ring - in half its rings from the stack's foot up and seldom lower; ours
         were hollow, and the cup drew the lines outside the tube instead. From COLUMN_TUBE_FILL_BELOW_MM under the lowest stack of the part's
         supports, each tree piece is crossed at COLUMN_TUBE_FILL_PITCH_MM at one angle (each layer's lines on the last's) */
      /* THE BASE PATTERN (Bambu's Base pattern and its spacing): 'hollow' the walls alone; 'rectilinear' lines through every piece of the tree on
         every layer, one way (Pattern angle), each layer's on the last's; 'rectilinear-grid' both ways; 'default' the ring lines below */
      var bpat = o.supportBasePattern || 'default', bPitch = o.supportBaseSpacingMm > 0 ? o.supportBaseSpacingMm : COLUMN_TUBE_FILL_PITCH_MM;
      if ((bpat === 'rectilinear' || bpat === 'rectilinear-grid') && !g.isEmpty(P.S[j])) {
        var treeB = R ? g.diff(P.S[j], R) : P.S[j], inB = g.isEmpty(treeB) ? treeB : g.offset(treeB, -wI * 0.75), aB = (o.supportAngleDeg || 0) * Math.PI / 180;
        if (!g.isEmpty(inB)) (bpat === 'rectilinear-grid' ? [aB, aB + Math.PI / 2] : [aB]).forEach(function (ab) {
          scanFill(g.polys(inB), ab, bPitch, 0).forEach(function (sg) {
            if (Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]) >= 1) out.push({ feature: 'Support', width: wI, closed: false, pts: [sg.a, sg.b], sheetFill: true, colPlate: true });
          });
        });
      }
      if (bpat === 'default' && tubeFillFrom != null && SP[j].printZ >= tubeFillFrom && !g.isEmpty(P.S[j])) {
        var treeJ = R ? g.diff(P.S[j], R) : P.S[j];
        if (!g.isEmpty(treeJ)) g.parts(treeJ).forEach(function (pc) {
          var inC = g.offset(pc, -wI * 0.5);
          if (g.isEmpty(inC)) return;
          if (pc.area() > COLUMN_TUBE_RING_MAX_MM2) return;                     /* no ring: branches joined into one body, hollow */
          /* ...and only a ring UNDER A STACK: one of this support's own stacks within COLUMN_TUBE_FILL_BELOW_MM over it (a support that holds a low
             rim and a high plate started every ring's lines at the low rim's height - deep under the high plate, over hollow), or - a tree that owns
             no stack - from the lowest of the part's other supports', as before */
          var under = hostFillFrom != null && SP[j].printZ >= hostFillFrom;
          for (var jj = j + 1; !under && jj < P.layers.length && SP[jj].printZ - SP[jj].h - SP[j].printZ <= COLUMN_TUBE_FILL_BELOW_MM + 1e-6; jj++)
            if (regs[jj] && !g.isEmpty(regs[jj]) && g.area(g.inter(regs[jj], g.offset(pc, 0.5))) > 0.05) under = true;
          if (!under) return;
          var cs2 = scanFill(g.polys(inC), aD, bPitch, 0), got = 0;
          cs2.forEach(function (sg) {
            var a0 = sg.a, b0 = sg.b;
            var lnF = Math.hypot(b0[0] - a0[0], b0[1] - a0[1]);
            if (lnF > COLUMN_TUBE_FILL_MAX_MM) { got++; return; }      /* no ring: a body of branches joined, hollow - a line across it would lie over air */
            if (lnF >= 1) { out.push({ feature: 'Support', width: wI, closed: false, pts: [a0, b0], sheetFill: true, colPlate: true }); got++; }
          });
          /* A RING THE GRID MISSES (the owner: "the tips are still not complete" - a tip's ring is 1.5 - 2 mm across, the grid's lines 2.5 apart, and
             most tips' rings stood hollow up to the stack): one line across its middle, on a COLUMN_TUBE_MID_SNAP_MM grid so a straight tip's lines
             lie on one another, as Bambu lays a line in every lobe */
          if (!got) {
            var cA = Math.cos(aD), sA = Math.sin(aD), yLo = Infinity, yHi = -Infinity;
            g.polys(inC).forEach(function (pl) { pl.forEach(function (q) { var yr = -q[0] * sA + q[1] * cA; if (yr < yLo) yLo = yr; if (yr > yHi) yHi = yr; }); });
            var yMid = Math.round((yLo + yHi) / 2 / COLUMN_TUBE_MID_SNAP_MM) * COLUMN_TUBE_MID_SNAP_MM;
            if (!(yMid > yLo && yMid < yHi)) yMid = (yLo + yHi) / 2;
            scanFill(g.polys(inC), aD, 1e6, yMid).forEach(function (sg) {
              var lnM = Math.hypot(sg.b[0] - sg.a[0], sg.b[1] - sg.a[1]);
              if (lnM >= COLUMN_TUBE_MID_MIN_MM && lnM <= COLUMN_TUBE_FILL_MAX_MM) out.push({ feature: 'Support', width: wI, closed: false, pts: [sg.a, sg.b], sheetFill: true, colPlate: true });
            });
          }
        });
      }
      var Dj = P.col.D && P.col.D[j];
      if (Dj) {
        var dIn = g.offset(Dj, -wI);
        if (!g.isEmpty(dIn)) {
          var dsegs = scanFill(g.polys(dIn), stackIdx[j] % 2 ? aD : aD + Math.PI / 2, COLUMN_BASE_PITCH_MM, 0);
          if (dsegs.length) connect(dsegs, 1.5 * COLUMN_BASE_PITCH_MM, g.polys(g.offset(Dj, 1e-3))).forEach(function (pth) {
            out.push({ feature: 'Support', width: wI, closed: false, pts: pth.pts, sheetFill: true, colPlate: true });
          });
        }
      }
      out.forEach(function (p) { p.overhangMm = p.overhangMm || 0; p.overhangRuns = p.overhangRuns || []; counts[p.feature] = (counts[p.feature] || 0) + 1; });
      L.paths = out;
    });
    if (typeof process !== 'undefined' && process.env && process.env.NSO_COLUMN_DEBUG) console.log('column sheets ' + P.name + ' (' + (P.planes ? 'own grid' : 'shared grid') + '): tops at ' + sheets.map(function (sh) { return sh.zHi.toFixed(3) + ' (' + sh.areaMm2.toFixed(2) + ' mm2)'; }).join(', '));
    P.sheet = {
      hostName: host ? host.name : null, hostFound: !!host, sheets: sheets, tips: 0,
      zLo: sheets.length ? Math.min.apply(null, sheets.map(function (s) { return s.zLo; })) : null,
      zHi: sheets.length ? Math.max.apply(null, sheets.map(function (s) { return s.zHi; })) : null,
      pathCounts: counts, overhangPaths: { 'Support': 0, 'Support transition': 0, 'Support interface': 0 }, overhangMm: { 'Support': 0, 'Support transition': 0, 'Support interface': 0 },
      rule: 'column'
    };
  }
  function typeSupports(g, perObject, planes, o, minOver) {
    var C = CONSTANTS.supportSheet;
    var NI = o.supportInterfaceLayers != null ? o.supportInterfaceLayers : C.interfaceLayers, NT = C.transitionLayers, R = C.closeMm;   /* o.supportInterfaceLayers: a sheet built with more (sheet() opts.interfaceLayers) */
    var gap = o.supportGapMm, w = o.outerWallWidthMm;
    /* a top may lie a layer further under the host than a sheet does: a
       stair's band stands its back edge up to 0.55 mm under the part (its
       width in whole beads), so the one a layer lands on can lie a layer
       further below it (C.stairLayers) */
    var stairHOf = function (SP) { return (C.stairLayers || 0) * (SP.length ? SP[SP.length - 1].h : 0.2); };
    var parts = perObject.filter(function (Q) { return Q.role === 'part'; });
    /* the column rule's stacks of every support, by the part they hold (columnType's tube fill reads the part's lowest) */
    var stacksBy = {};
    perObject.forEach(function (Q) {
      if (Q.role !== 'support' || !Q.col) return;
      var SPq = Q.planes || planes, arr = stacksBy[Q.hostKey != null ? Q.hostKey : '*'] || (stacksBy[Q.hostKey != null ? Q.hostKey : '*'] = []);
      for (var jq = 0; jq < Q.layers.length; jq++) if ((Q.col.I[jq] && !g.isEmpty(Q.col.I[jq])) || (Q.col.T[jq] && !g.isEmpty(Q.col.T[jq]))) { arr.push({ z: SPq[jq].printZ, zb: SPq[jq].printZ - SPq[jq].h }); break; }
    });
    perObject.forEach(function (P) {
      if (P.role !== 'support') return;
      var SP = P.planes || planes;                                             // this support's own layers, and `planes` the part's
      var n = SP.length, stairH = stairHOf(SP);
      var host = P.hostKey != null ? parts.find(function (Q) { return Q.key != null && Q.key === P.hostKey; }) || null : null;
      var hosts = host ? [host] : parts;
      P.host = host;
      var feet = [];
      P.footAt = function (i) {
        if (i < 0 || i >= n || g.isEmpty(P.S[i])) return g.empty();
        if (!feet[i]) feet[i] = g.offset(g.offset(P.S[i], R), -R);
        return feet[i];
      };
      if (P.col) { columnType(g, P, SP, o, host, planes, stacksBy[P.hostKey != null ? P.hostKey : '*']); return; }
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
      /* the test before the islands, kept by layer and host union (both of a layer's exposedParts ask it) */
      var reachMemo = new WeakMap();
      function reaches(i, H) {
        var m = reachMemo.get(H);
        if (!m) { m = {}; reachMemo.set(H, m); }
        if (!(i in m)) m[i] = g.area(g.inter(P.S[i], H)) > 1e-6;
        return m[i];
      }
      /* `cover` may be a function: it is made only when the layer reaches under the host (most do not) */
      function topUnder(i, over, cover, grow, open) {
        if (open == null) open = w / 2;
        var H = g.unionAll(over.map(function (x) { return x.cs; }));
        // most layers reach under no host at all: one test, before the islands
        if (!reaches(i, H)) return null;
        var isl = g.parts(P.S[i]).filter(function (p) { return g.area(g.inter(p, H)) > 1e-6; });
        if (!isl.length) return null;
        var t = g.offset(g.offset(g.unionAll(isl), R), -R);
        if (typeof cover === 'function') cover = cover();
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
      function exposedParts(i, over) {
        return { a: topUnder(i, over, function () { return P.footAt(i + 1); }, R), b: sloped(topUnder(i, over, function () { return filled(P.footAt(i + 1)); }, w / 4, w / 4), i) };
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
        var ks = layersOverX(SP, i, planes, gap + stairH);
        var keep = g.parts(cs).filter(function (pc) {
          var bb = [Infinity, Infinity, -Infinity, -Infinity], A = g.area(pc);
          g.polys(pc).forEach(function (Q) { Q.forEach(function (q) { bb[0] = Math.min(bb[0], q[0]); bb[1] = Math.min(bb[1], q[1]); bb[2] = Math.max(bb[2], q[0]); bb[3] = Math.max(bb[3], q[1]); }); });
          if (!(Math.max(bb[2] - bb[0], bb[3] - bb[1]) >= C.stairRunMm) || !(A > 0)) return false;
          for (var n = 0; n < ks.length; n++) {
            var cov = 0;
            hosts.forEach(function (Q) { if (!g.isEmpty(Q.S[ks[n]])) cov += g.area(g.inter(pc, Q.S[ks[n]])); });
            /* a ceiling that covers it whole is a flat ceiling's when it stands the gap over it (the host's first layer over a flat sheet); it is air's, and the
               island a top, when it stands well further over (the Negative Sphere apex's ring, ceiling 0.4 mm over it) */
            if (cov > 1e-6) return cov / A < C.stairCoverShare || planes[ks[n]].printZ - planes[ks[n]].h - SP[i].printZ > gap + stairH / 2 + 1e-6;
          }
          return false;
        });
        return keep.length ? g.unionAll(keep) : null;
      }
      function overAt(i, d) {
        var over = [];
        layersOverX(SP, i, planes, d).forEach(function (k) {
          hosts.forEach(function (Q) { if (!g.isEmpty(Q.S[k])) over.push({ Q: Q, cs: Q.S[k] }); });
        });
        return over;
      }
      var topsF = [], topsS = [];
      for (var i = 0; i < n; i++) {
        tops.push(null); topsF.push(null); topsS.push(null);
        if (g.isEmpty(P.S[i])) continue;
        var over = overAt(i, gap);
        var ep = over.length ? exposedParts(i, over) : { a: null, b: null };
        var t = ep.a && ep.b ? g.union(ep.a, ep.b) : ep.a || ep.b, tS = ep.b;
        /* A STAIR'S STRIP (C.stairLayers): a band whole beads wide, so the
           one a layer of the part lands on can lie a layer further
           under it than a sheet does - a top there too, where it is OUTSIDE
           the support's next layer (a flat sheet's I1 seen through a channel
           of I2 is not) */
        if (stairH > 0) {
          var deep = overAt(i, gap + stairH);
          if (deep.length > over.length) {
            var t2 = sloped(topUnder(i, deep, function () { return filled(P.footAt(i + 1)); }, w / 4, w / 4), i);
            if (t2) { t = t ? g.union(t, t2) : t2; tS = tS ? g.union(tS, t2) : t2; over = deep; }
          }
        }
        if (!t) continue;
        tops[i] = t; topsS[i] = tS;
        topsF[i] = ep.a;
        over.forEach(function (x) { if (!g.isEmpty(g.inter(x.cs, t))) held[x.Q.id] = x.Q; });
      }
      // Each top down through its stack: a layer's islands that overlap the
      // sheet's islands on the layer above are the sheet's (each layer's lines
      // cross the ones above), for NI + NT layers; the islands under the last
      // that overlap it are its tips.
      var reachMm = gap + (NI + NT + 2) * (SP.length ? SP[SP.length - 1].h : 0.2);
      function underPart(j, U) {
        var over = overAt(j, reachMm);
        if (!over.length) return false;
        var H = g.unionAll(over.map(function (x) { return x.cs; })), a = g.area(U);
        return a > 0 && g.area(g.inter(U, H)) >= 0.5 * a;
      }
      var zones = P.layers.map(function () { return { i: [], t: [], is: [], ts: [] }; });
      var sheets = [];
      tops.forEach(function (tAll, i0) {
        if (!tAll) return;
        var lowest = i0, tipsN = 0, mLast = 0;
        /* a flat sheet's top and a stair's strip are walked down apart: the stair's zones are held to the part's nearness below (STAIR ZONES) */
        [{ cs: topsF[i0], stair: false }, { cs: topsS[i0], stair: true }].forEach(function (comp) {
        var t = comp.cs;
        if (!t || g.isEmpty(t)) return;
        var lvl = g.parts(P.S[i0]).filter(function (p) { return !g.isEmpty(g.inter(p, t)); });
        var lo = i0, m = 0, prevFoot = null;
        /* past NI + NT the transition runs on while a layer repeats the
           footprint of the one over it: a stair's strips stand several
           layers alike where the slope is steep (the run under a top is the
           same sheet, as T1 and T2 are) */
        for (; lvl.length; m++) {
          var j = i0 - m, U = g.unionAll(lvl), foot = g.offset(g.offset(U, R), -R);
          if (m >= NI + NT && !(prevFoot && g.area(g.diff(foot, prevFoot)) + g.area(g.diff(prevFoot, foot)) <= w * w)) break;
          /* ...and only while it lies under the part: a column or a crown's body stands the same layer after layer, and is the tree under
             the sheet, not the sheet - Support, as Bambu's tree is, where the stair's strips stand alike on a steep wall only within reach */
          if (m >= NI + NT && !underPart(j, U)) break;
          (comp.stair ? (m < NI ? zones[j].is : zones[j].ts) : (m < NI ? zones[j].i : zones[j].t)).push(U);
          zones[j].topI = Math.max(zones[j].topI == null ? 0 : zones[j].topI, i0);
          lo = j; prevFoot = foot;
          if (j - 1 < 0) { lvl = []; break; }
          lvl = g.parts(P.S[j - 1]).filter(function (p) { return g.area(g.inter(p, U)) > 1e-6; });
        }
        lowest = Math.min(lowest, lo); mLast = Math.max(mLast, m); tipsN = Math.max(tipsN, m >= NI + NT ? lvl.length : 0);
        });
        sheets.push({ topLayer: i0, zLo: SP[lowest].printZ - SP[lowest].h, zHi: SP[i0].printZ,
                      areaMm2: g.area(tAll), tips: tipsN });
      });
      /* A DOME'S FLANK: AN INTERFACE DEEPER THAN ITS REACH STEPS DOWN (Bambu's rule: the NI layers under the part's underside are interface, the NT under those transition, and a cell
         with the part further over it than that is the tree's; the walk's transition stays as it is). The walk down from a top finds a stack's ring only where it is wider than a line; a flank steps a few tenths
         of a mm a layer, so the walk typed its whole disc one way (Circular z 8.52: 69 mm of interface to Bambu's 39). The plate's fringe, where no part is over it at all,
         keeps the type the walk gave it. */
      var ZONE_REACH_TRIM_MM = 0.1, ZONE_FAR_MM = 3, ZONE_DOME_TRIM_MM = 0.2, DOME_PLATEAU_RATIO = 1.11;
      for (var jz = 0; jz < SP.length; jz++) {
        if (g.isEmpty(P.S[jz]) || !zones[jz] || !(zones[jz].i.length || zones[jz].t.length)) continue;
        var hj = SP[jz].h, hostUat = function (jj, X) {
          var parts = [];
          layersOverX(SP, jj, planes, X).forEach(function (k) { hosts.forEach(function (Q) { if (!g.isEmpty(Q.S[k])) parts.push(Q.S[k]); }); });
          return parts.length ? g.unionAll(parts) : g.empty();
        }, hostU = function (X) { return hostUat(jz, X); };
        /* UNDER A DOME THE INTERFACE'S REACH IS SHORTER: the part over a stack's top grows from the interface's reach to the transition's (a dome: 1.15 x in area on the Sphere; a flat floor 1.0), and
           Bambu's interface there is the inner part only (the Sphere's plate at 9.32: transition outside R 2.4, interface in it; ours was all interface) */
        var tjz = zones[jz].topI != null ? zones[jz].topI : jz, hjt = SP[tjz].h, trimI = ZONE_REACH_TRIM_MM;
        if (ZONE_DOME_TRIM_MM > 0) {
          var aI1 = hostUat(tjz, gap + (NI - 1) * hjt - ZONE_REACH_TRIM_MM), aT1 = hostUat(tjz, gap + (NI + NT - 1) * hjt - ZONE_REACH_TRIM_MM);
          if (!g.isEmpty(aI1) && !g.isEmpty(aT1) && g.area(aT1) > DOME_PLATEAU_RATIO * g.area(aI1)) trimI = ZONE_DOME_TRIM_MM;
        }
        var UI = hostU(gap + (NI - 1) * hj - trimI), UT = hostU(gap + (NI + NT - 1) * hj - ZONE_REACH_TRIM_MM), UF = hostU(ZONE_FAR_MM);
        var oI = zones[jz].i.length ? g.unionAll(zones[jz].i) : g.empty(), oT = zones[jz].t.length ? g.unionAll(zones[jz].t) : g.empty();
        var keep = g.diff(g.union(oI, oT), g.diff(UF, UT)), fr = g.diff(keep, UT);
        var nI = g.union(g.inter(g.inter(keep, UI), oI), g.inter(fr, oI));                   /* a walk's transition stays transition: only an interface that lies deeper than the reach steps down */
        var nT = g.diff(keep, nI);
        nI = g.dropSmall(nI, 0.05); nT = g.dropSmall(nT, 0.05);
        zones[jz].i = g.isEmpty(nI) ? [] : [nI]; zones[jz].t = g.isEmpty(nT) ? [] : [nT];
      }
      var counts = { 'Support': 0, 'Support transition': 0, 'Support interface': 0 };
      /* STAIR ZONES. A stair's strips stand beside the posts that hold them, and a post is one island with the strip it touches (a row of posts is
         one blade): the zone of a stair's strip, walked down by islands, took the whole blade with it. A stair's zone holds only where the part is
         over the line within the stack's own depth - the interface layers and the transition under them, and a layer for the strip's back edge, as
         Bambu types what lies under its overhang - so a column further down is the tree under the sheet: Support. A flat sheet keeps its islands
         (a dome's flat sheet lies up to its reach under the part at the rim, and is all sheet). A path that is part sheet and part tree is split
         where its type changes (a loop of a strip with a post's wall on it is an interface run and a support run). */
      var hIm = P.layers.length ? SP[SP.length - 1].h : 0.2;
      var dIn = gap + (NI - 1) * hIm + 0.25, dTr = gap + (NI + NT - 1) * hIm + 0.35;
      function hostPolys(j, d) {
        var over = overAt(j, d);
        return over.length ? g.polys(g.unionAll(over.map(function (x) { return x.cs; }))) : [];
      }
      function inPolys(polys, x, y) { return polys.length ? inside(polys, x, y) : false; }
      /* the part's sections whose underside lies 0 - d over the top of support layer j: EXACTLY that reach (overAt adds a layer to it). Bambu's top support layer lies a layer
         and the gap under the part (0.4: 14.8 under a part that starts at 15.2); each one under it a support layer further, so a layer is interface while the part is within
         that + (NI - 1) of its layers over it, transition within NT more, whatever the part's slope does (a slope's cells are typed one by one) */
      var exactOn = o.supportLayerMaxMm > 0;
      function hostExCs(j, d) {
        var cs = [], sz = SP[j].printZ;
        if (exactOn) prepExact();
        for (var k = 0; k < planes.length; k++) {
          var dk = planes[k].printZ - planes[k].h - sz;
          if (dk > d + 1e-6) break;
          if (dk < -1e-6) continue;
          /* a layer whose middle lies over the reach is not the part at that height: the exact cut there stands for it (a slope's edge then moves
             smoothly from one support layer to the next, not by the part's layers) */
          if (exactOn && Q0exact && planes[k].printZ - planes[k].h / 2 - sz > d + 1e-6) break;
          hosts.forEach(function (Q) { if (!g.isEmpty(Q.S[k])) cs.push(Q.S[k]); });
        }
        if (exactOn && Q0exact) {
          var key = Math.round((sz + d - exShift) * 1e5);
          hosts.forEach(function (Q) { var e = Q.exactGet && Q.exactGet(key); if (e && !g.isEmpty(e)) cs.push(e); });
        }
        return cs.length ? g.unionAll(cs) : null;
      }
      /* the host cut at each support layer's two reaches (the interface's and the transition's), in one pass per host */
      var Q0exact = false, exShift = 0, exDone = false;
      function prepExact() {
        if (exDone) return;
        exDone = true;
        exShift = planes.length ? planes[0].printZ - planes[0].h / 2 - planes[0].sliceZ : 0;
        var zs = {};
        P.layers.forEach(function (L, j) {
          if (!L.paths.length) return;
          [dInEx(j), dTrEx(j), dCl(j, dInEx(j)) + REACH_EXTRA_MM, dCl(j, dTrEx(j)) + REACH_EXTRA_MM, PLATE_UP_MM, PLATE_UP_LOW_MM].forEach(function (dd) { var z = SP[j].printZ + dd - exShift; zs[Math.round(z * 1e5)] = z; });
        });
        /* each height is cut when it is first read (most never are: a layer's six reaches, and only some are asked); exactAt keeps it by its height */
        hosts.forEach(function (Q) {
          if (!Q.exactAt || !Q.soupOk) return;
          Q.exactGet = function (key) { return Object.prototype.hasOwnProperty.call(zs, key) ? Q.exactAt([zs[key]])[0] : undefined; };
          Q0exact = true;
        });
      }
      function hostEx(j, d) { var u = hostExCs(j, d); return u ? g.polys(u) : []; }
      /* the part's exact section at a printed height (a cavity's hole, to the corner): cut once, by height */
      var cavEx = {};
      function cavSection(zPrint) {
        if (!exactOn) return null;
        prepExact();
        if (!Q0exact) return null;
        var key = Math.round(zPrint * 1e5);
        if (!(key in cavEx)) {
          var us = [];
          hosts.forEach(function (Q) { if (!Q.exactAt || !Q.soupOk) return; var c = Q.exactAt([zPrint - exShift])[0]; if (c && !g.isEmpty(c)) us.push(c); });
          cavEx[key] = us.length ? g.unionAll(us) : null;
        }
        return cavEx[key];
      }
      var DOEX = gap + hIm + 0.03;
      function dInEx(j) { return DOEX + (NI - 1) * SP[j].h; }
      function dTrEx(j) { return DOEX + (NI + NT - 1) * SP[j].h; }
      /* a stack's layers all lie under the one face its top layer stands under: no reach runs past that face's own height (Bambu's lower layers repeat the top's outline on a dome and a flat floor; a plane's slide along it until it) */
      function dCl(j, d) { var ti = zones[j] && zones[j].topI; return ti == null ? d : Math.min(d, Math.max(DOEX, SP[ti].printZ - SP[j].printZ + DOEX)); }
      var SPLIT_MIN_MM = 0.6;
      var PINCH_INSET_MM = 0.1;      /* the loop's inset where the region is too narrow for a line's half-width on each side */
      var TRANS_FILL_OPEN_MM = 0.4;
      var RIBBON_T_RATIO = 3;
      var RIBBON_SERPENTINE = true;
      var IFILL_RIBBON_MM = 0.38;   /* the ridge's ribbon: Bambu's zig-zag stands this far in from each loop's line (strokes 1.1 mm across a 0.46 band, not the whole ribbon)  */
      var IFILL_IN_MM = 0.3;   /* the interface's hatch runs from loop to loop, as the transition's does (it was the slab inset a whole wall: only the wide parts of a ring were filled, and Bambu's interface ring is filled round); it stops this far short of the loops' line. 0.2 laid a line 0.2 mm from the loop beside it, on top of it (the diamond's side strips had 3 lines to Bambu's 2: line length x1.13); 0.3 puts the line where Bambu's is (0.98 mm from the outer loop) and the length at x1.05. The transition's hatch reaches its loops in Bambu's (0.3 there left it 15 % short) */
      var REGION_FILL_GAP_MM = 0.04;
      var PLANAR_2ND_DIFF = 0.12;   /* a zone whose area's second difference over three layers is under this share of it is a plane's */
      var EXACT_OUTLINE = true;       /* A RIBBON PLATE (the ridge) is Bambu's: each layer the part's EXACT section at the layer's reach (one section, not the union of the layers up to it; the reach never past the stack top's own face: dCl), the loops' centre PLATE_OUT_MM + 0.12 past it (measured on all six pieces: the outer edge stands 0.33 - 0.38 past the outline). Domes keep the union cut: a single section at that reach is far wider than theirs. */
      var REACH_EXTRA_MM = 0;   /* the section is read this much higher: a plane's edge moves 2.75 mm for 1 mm of height, and Bambu's plate stood 0.19 mm past ours on the downhill side */
      var PLATE_OUT_MM = -0.11;
      var LOOP_SMOOTH_MM = 0.4, HOLE_SNAP_MM = 0.3, CONE_REACH_MM = 0.18, DISC_REACH_MM = 0.24, DISC_CLOSING = 0.88, DISC_CLIP_MM = -0.07, PLATE_UP_LOW_MM = 0.1, PLATE_UP_LOW_N = 4, RIBBON_SLAB_RATIO = 2;      /* the ridge's first plates (its rounded end, the slab still wide): the uphill edge stands 0.1 over the layer, and the slab is a ribbon from a ratio of 2 (Bambu cycles its hatch there too) */
      var PLATE_UP_MM = 0.21;      /* the uphill edge: the plate stops where the part's section 0.21 mm over the layer begins (the face there stands 0.21 over it; Bambu's ribbon is 0.9 mm of the face's height, ours was 1.05) */
      var PLATE_BAND_MM = 0.7;      /* how far past the support mesh's footprint the outline may run */
      var CURVED_SHRINK_MM = 0.1;   /* on a curved face (the zone changes layer on layer) the host cut is this much narrower: a dome's plate was out past Bambu's */
      var HOST_GROW_MM = 0.2;   /* on a flat floor the part's host cut (the typing's reach) is this much wider: the plate's loops stand past the face's edge, and cells there were typed transition where Bambu's are interface */
      var THIN_SLAB_MIN_MM2 = 3;   /* a ribbon (one ring, no hole) at least this big keeps its loop though it is narrower than the wall's inset: the Oblique's top layers (a dome's thin ring is not: Bambu stops a layer lower there) */
      var LOOP_IN_FLAT_MM = -0.15; /* on a layer whose zones keep their size from a neighbour (a flat floor) the loops lie this far in (negative: out past the slab's edge): Bambu's loop centrelines stand 0.2 - 0.25 mm past the face's edge on both sides of a flat ring */
      var LOOP_IN_MM = 0.12;   /* the region loops lie this far in from the slab's edge (not half a line: Bambu's plate stands 0.4 mm past ours on the flat-floored pieces) */
      var REGIONAL_PLATE = true;     /* a support's own grid lays its plate by regions (below) */
      /* A plate's lines turn with its own layers, not the support's: Bambu lays the first layer of a stack at 110 degrees, then 45, 135, 45, 135... up it. A stack's layer
         is the next of the one under it where the two stand over each other. */
      var FIRST_LAYER_DEG = 110;
      var RIBBON_CYCLE = true;
      var RIBBON_RATIO = 2.5, RIBBON_PARALLEL_DEG = 30;
      /* a ring's long axis (the direction of the most spread of its outline) and how much longer it is than wide */
      function ringAxis(ring) {
        var pts = [], n = ring.length;
        for (var e = 0; e < n; e++) {
          var a = ring[e], b = ring[(e + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.max(1, Math.ceil(l / 0.4));
          for (var u = 0; u < k; u++) pts.push([a[0] + (b[0] - a[0]) * u / k, a[1] + (b[1] - a[1]) * u / k]);
        }
        if (pts.length < 3) return null;
        var mx = 0, my = 0; pts.forEach(function (q) { mx += q[0]; my += q[1]; }); mx /= pts.length; my /= pts.length;
        var sxx = 0, syy = 0, sxy = 0; pts.forEach(function (q) { var dx = q[0] - mx, dy = q[1] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; });
        var tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det)), l1 = tr / 2 + disc, l2 = tr / 2 - disc;
        return { ang: 0.5 * Math.atan2(2 * sxy, sxx - syy), ratio: l2 > 1e-9 ? Math.sqrt(l1 / l2) : 99 };
      }
      var stackIdx = [], sheetOf = [];
      P.layers.forEach(function (L, jj) {
        var zz = zones[jj], all = zz.i.concat(zz.t, zz.is, zz.ts);
        sheetOf[jj] = all.length ? g.unionAll(all) : null;
        var below = jj > 0 ? sheetOf[jj - 1] : null;
        stackIdx[jj] = sheetOf[jj] && below && g.area(g.inter(sheetOf[jj], below)) > 0.05 ? (stackIdx[jj - 1] || 0) + 1 : 0;
      });
      P.layers.forEach(function (L, j) {
        if (!L.paths.length) return;
        var zi = zones[j].i.length ? g.polys(g.offset(g.unionAll(zones[j].i), w / 2)) : [];
        var zt = zones[j].t.length ? g.polys(g.offset(g.unionAll(zones[j].t), w / 2)) : [];
        /* a zone that touches a stair's strip - a strip's front seen as a flat top, a post one island with it - is held to the part's nearness with the stair's
           (a flat sheet's islands elsewhere on the layer are not: a dome's flat sheet lies up to its reach under the part) */
        var stairU = (zones[j].is.length || zones[j].ts.length) ? g.unionAll(zones[j].is.concat(zones[j].ts)) : null;
        var flatI = [], flatT = [], stI = zones[j].is.slice(), stT = zones[j].ts.slice();
        function touchesStair(cs) { return !!stairU && g.area(g.inter(cs, stairU)) > 1e-6; }
        /* on a support's own layer grid (Bambu's independent support layer height) every zone is typed by the part's nearness, as a stair's is: a sloped plate
           is interface where the part is within the interface layers over it and transition within the transition layers over that, cell by cell - not whole
           islands, which made the one island all interface */
        var byDepth = o.supportLayerMaxMm > 0;
        zones[j].i.forEach(function (cs) { (byDepth || touchesStair(cs) ? stI : flatI).push(cs); });
        zones[j].t.forEach(function (cs) { (byDepth || touchesStair(cs) ? stT : flatT).push(cs); });
        var stairAt = stI.length > 0 || stT.length > 0;
        var zis = stI.length ? g.polys(g.offset(g.unionAll(stI), w / 2)) : [];
        var zts = stT.length ? g.polys(g.offset(g.unionAll(stT), w / 2)) : [];
        zi = flatI.length ? g.polys(g.offset(g.unionAll(flatI), w / 2)) : [];
        zt = flatT.length ? g.polys(g.offset(g.unionAll(flatT), w / 2)) : [];
        var hI = null, hT = null;
        /* THE SHEET IS LINES, NOT A WALL (the support is hollow, above): where a layer is the sheet's - interface or transition, the zone a flat sheet's islands or a
           stair's strips make, the stair's held to the part's nearness - its region is filled solid, as Bambu lays its interface, inside the one wall the support
           has. The tree under the sheet stays hollow. */
        if (zi.length || zt.length || zis.length || zts.length) {
          var zc = flatI.concat(flatT);
          var zcs = stI.concat(stT);
          var sheetCs = zc.length ? g.unionAll(zc) : g.empty();
          if (zcs.length) {
            var stairCs = g.unionAll(zcs);
            if (byDepth) { var hD = hostExCs(j, dTrEx(j)); if (hD) stairCs = g.inter(stairCs, hD); }
            else {
              var hostD = overAt(j, dTr);
              if (hostD.length) stairCs = g.inter(stairCs, g.unionAll(hostD.map(function (x) { return x.cs; })));
            }
            sheetCs = g.isEmpty(sheetCs) ? stairCs : g.union(sheetCs, stairCs);
          }
          /* THE DOME'S CUP: a support head under a dome is a hollow cup - a ring of section round a hole of a few mm2 - and Bambu's transition layer under the dome is a
             disc across it. A hole of under DOME_HOLE_MM2 that lies wholly under the part within the transition's reach and not within the interface's (a hole under the
             interface's reach is a tree head's, which stays open: Circular's, Sphere's) is filled for the plate. */
          var Sj = P.S[j];
          if (!g.isEmpty(Sj) && byDepth) {
            var dropH = [], hTx = null, hIx = null, holeKeep = g.polys(Sj).filter(function (Q) {
              var a2 = 0;
              for (var q = 0; q < Q.length; q++) { var u = Q[q], v = Q[(q + 1) % Q.length]; a2 += u[0] * v[1] - v[0] * u[1]; }
              var ar = -a2 / 2;
              if (!(a2 < 0 && ar >= SUPPORT_HOLE_FILL_MM2 && ar < DOME_HOLE_MM2)) return true;
              if (!hTx) { hTx = hostExCs(j, dTrEx(j)) || g.empty(); hIx = hostExCs(j, dInEx(j)) || g.empty(); }
              var hole = g.of([Q.slice().reverse()], 'Positive');
              if (g.area(g.inter(hole, hTx)) >= 0.8 * ar && g.area(g.inter(hole, hIx)) <= 0.2 * ar) { dropH.push(Q); return false; }
              return true;
            });
            if (dropH.length) {
              Sj = g.of(holeKeep, 'Positive');
              sheetCs = g.union(sheetCs, g.of(dropH.map(function (Q) { return Q.slice().reverse(); }), 'Positive'));          /* the zone is the ring's too: its hole is the sheet's */
            }
          }
          var inSheet = g.isEmpty(sheetCs) ? g.empty() : g.offset(g.inter(Sj, sheetCs), -(o.outerWallWidthMm * 1.0));
          if (!g.isEmpty(inSheet) || (byDepth && REGIONAL_PLATE && !g.isEmpty(sheetCs) && g.parts(g.inter(Sj, sheetCs)).some(function (pp) { return pp.area() >= THIN_SLAB_MIN_MM2 && g.polys(pp).length === 1; }))) {      /* a slab narrower than the wall's inset has no inside, but its loop is still Bambu's */
            var wI = o.supportWidthMm > 0 ? o.supportWidthMm : o.infillWidthMm, sI = spacingOf(wI, P.layers[j].h || 0.2), aD = (o.infillDirectionDeg || 45) * Math.PI / 180, aJ = byDepth && REGIONAL_PLATE ? (stackIdx[j] === 0 ? FIRST_LAYER_DEG * Math.PI / 180 : (stackIdx[j] % 2 === 1 ? aD : aD + Math.PI / 2)) : (j % 2 === 0) ? aD : aD + Math.PI / 2;
            var hullS = g.polys(g.offset(inSheet, wI / 2 + 1e-4));
            /* the sheet is the layer's only fill there: a fill the support's own shells laid inside it (the bottom shell of a sheet's first layer, which stands on a
               hollow tree) is the same ground twice - a transition layer with double the lines. The walls stay. */
            L.paths = L.paths.filter(function (q) {
              if (q.sheetFill || /wall$/i.test(q.feature) || !q.pts.length) return true;
              for (var qi = 0; qi < q.pts.length; qi++) if (!inside(hullS, q.pts[qi][0], q.pts[qi][1])) return true;
              return false;
            });
            /* ON A SUPPORT'S OWN GRID the plate is laid by its regions, as Bambu lays it: the interface region and the transition region each have their loop, and the
               interface its zig-zag; a narrow transition strip is its loop alone. (Typing one fill by position left a strip a line or none by the phase of the lines.) */
            var regional = byDepth && REGIONAL_PLATE;
            if (regional) sI = wI + REGION_FILL_GAP_MM;           /* Bambu's interface lines stand 0.46 mm apart (a line and 0.04), on every layer height */
            var fillCs = inSheet;
            if (regional) {
              /* the hatch runs from loop to loop (Bambu's zig-zag meets the loops): its ground is the slab inset to the loops' own line, not the wall's width in */
              var zArea = function (jj) { var q = zones[jj]; return q && (q.i.length || q.t.length) ? g.area(g.unionAll(q.i.concat(q.t))) : 0; };
              var a0 = zArea(j), steady = false;
              [j - 1, j + 1].forEach(function (jj) { var a1 = zArea(jj); if (a1 > 0 && a0 > 0 && Math.abs(a1 - a0) <= 0.03 * a0) steady = true; });
              /* a plane (the oblique ridge) grows its zone by the same amount every layer: the second difference of the zone's area is nil; a curved face (a dome, a diamond's cup) does not */
              var zAreaAll = function (jj) { var q = zones[jj]; var all = q ? q.i.concat(q.t, q.is, q.ts) : []; return all.length ? g.area(g.unionAll(all)) : 0; };
              var b0 = zAreaAll(j), bMinus = zAreaAll(j - 1), bPlus = zAreaAll(j + 1), planar = b0 > 0 && bMinus > 0 && bPlus > 0 && Math.abs(bPlus - 2 * b0 + bMinus) <= PLANAR_2ND_DIFF * b0;
              /* a ribbon (one long thin slab: the ridge's plate) lies along a plane; a ring or a disc (a dome's) does not */
              var ribbonAngled = false;
              var ribbonSlab = (function () {
                var pp = g.parts(g.inter(Sj, sheetCs)), big = null;
                pp.forEach(function (q) { if (!big || q.area() > big.area()) big = q; });
                if (!big) return false;
                var ax = ringAxis(g.polys(big)[0]);
                return !!ax && ax.ratio >= RIBBON_SLAB_RATIO;
              })();
              if (RIBBON_CYCLE && ribbonSlab) {
                /* Bambu's ridge plate: the transition layers at 110, the interface's first and then every third at 20, the rest at 110 (measured: 20, 110, 20, then 110, 110, 20 on, over the
                   0.2 mm layers) - the two directions cross the ribbon at 65 and 25 degrees, so a line is ~0.5 or ~1 mm and the lines 0.5 or 1.1 mm along it */
                var sx = stackIdx[j];
                aJ = ((sx === 2 || (sx >= 4 && (sx - 4) % 3 === 0)) ? 20 : 110) * Math.PI / 180;
                ribbonAngled = true;
              }
              /* A CAVITY CEILING'S PLATES (a negative sphere's): the ceiling closes in above the plate, and Bambu draws each layer with the cavity's own outline - the part's EXACT
                 section there, its hole - at one height: the layer + CONE_REACH_MM, and not lower than the flat run's (the disc's) top layer + DISC_REACH_MM. Measured on the Negative
                 Sphere and the Negative Sphere2, whose discs differ by 0.7 mm in radius, on all five of their cone layers: 0.48 and 0.55 within 0.03. The hole's own corners are the
                 plate's (the apex is a ten-sided ring: Bambu's top layers are ten-sided). A ceiling that does not close in (a flat one) keeps the support's own section. */
              var cavGround = null;
              if (!ribbonSlab && DISC_REACH_MM > 0 && !g.isEmpty(Sj) && !g.isEmpty(sheetCs)) {
                var dTop = j, tIdx = zones[j] && zones[j].topI;
                if (steady) for (var jj2 = j + 1; jj2 < SP.length && (tIdx == null || jj2 <= tIdx); jj2++) { var a2z = zArea(jj2), a1z = zArea(jj2 - 1); if (a2z > 0 && a1z > 0 && Math.abs(a2z - a1z) <= 0.03 * a1z) dTop = jj2; else break; }
                var plate0 = g.polys(g.inter(Sj, sheetCs))[0], px = 0, py = 0;
                if (plate0 && plate0.length) {
                  plate0.forEach(function (v) { px += v[0]; py += v[1]; }); px /= plate0.length; py /= plate0.length;
                  var holeAtZ = function (zT) {                                              /* the hole of the part's exact section at zT that holds the plate's middle: a region, or null */
                    var hsx = cavSection(zT), found = null;
                    if (hsx) g.polys(hsx).forEach(function (R0) {
                      var s2 = 0; for (var q = 0; q < R0.length; q++) { var u = R0[q], v = R0[(q + 1) % R0.length]; s2 += u[0] * v[1] - v[0] * u[1]; }
                      if (s2 < 0 && inside([R0.slice().reverse()], px, py)) found = g.of([R0.slice().reverse()], 'Positive');
                    });
                    return found;
                  };
                  var zStar = Math.max(SP[j].printZ + CONE_REACH_MM, steady ? SP[dTop].printZ + DISC_REACH_MM : 0), hStar = holeAtZ(zStar), hLow = holeAtZ(SP[j].printZ - 0.3);
                  if (hStar && hLow && g.area(hStar) < DISC_CLOSING * g.area(hLow)) {
                    var win = g.offset(hLow, 1.0), clipH = g.offset(hStar, (steady ? LOOP_IN_FLAT_MM : LOOP_IN_MM) - w / 2 + DISC_CLIP_MM);      /* the drawn edge is the hole's: the loop stands loopIn in from the slab's edge and half a line out */
                    var plateN = g.inter(clipH, g.offset(g.inter(g.inter(Sj, sheetCs), win), PLATE_BAND_MM));
                    if (!g.isEmpty(plateN)) { Sj = g.union(g.diff(Sj, win), plateN); sheetCs = g.union(g.diff(sheetCs, win), plateN); cavGround = plateN; }
                  } else if (hStar && HOLE_SNAP_MM > 0) {
                    /* A HOLE THAT STAYS OPEN: the ring's inner loop is the part's own hole - a true circle in Bambu's (R 3.82, 0.002 mm off a fit) - and the slab's, rastered, is a staircase
                       of 0.04 - 0.16 mm. The hole keeps its size (the slab's) and takes the part's shape: the exact hole, offset by the difference of their equivalent radii. */
                    var holeOf = function (cs) {
                      var found = null;
                      g.polys(cs).forEach(function (R0) {
                        var s2 = 0; for (var q = 0; q < R0.length; q++) { var u = R0[q], v = R0[(q + 1) % R0.length]; s2 += u[0] * v[1] - v[0] * u[1]; }
                        if (s2 < 0 && inside([R0.slice().reverse()], px, py)) found = g.of([R0.slice().reverse()], 'Positive');
                      });
                      return found;
                    };
                    var hSj = holeOf(Sj), hSh = holeOf(sheetCs);
                    if (hSj) {
                      var dR = Math.sqrt(g.area(hSj) / Math.PI) - Math.sqrt(g.area(hStar) / Math.PI);
                      if (Math.abs(dR) <= HOLE_SNAP_MM) {
                        var newHole = g.offset(hStar, dR);
                        Sj = g.diff(g.union(Sj, hSj), newHole);
                        if (hSh) sheetCs = g.diff(g.union(sheetCs, hSh), newHole);
                      }
                    }
                  }
                }
              }
              /* A STEADY ZONE UNDER A DOME IS NOT A FLAT FLOOR: a dome's plateau layers keep their size too (Bambu's Sphere: 2.58 - 2.61 on every layer from the fourth), but the part over
                 them is not flat - its section grows from the interface's reach to the transition's (1.15 - 1.16 x in area at the stack's top layer on the Sphere, 1.0 on a flat ring, 1.04 - 1.08 on the Negative Spheres' filleted floor) - and its loops lie in from the slab's edge
                 (0.12) as on any dome, not out past it (0.15: ours stood 0.25 too far out, 2.83 and 2.90 to 2.60) */
              var flatFloor = steady;
              if (steady && DOME_PLATEAU_RATIO > 0) {
                var tj0 = zones[j].topI != null ? zones[j].topI : j;                  /* a stack stands under one face: its top layer's reaches say what the face is */
                var hI0 = hostExCs(tj0, dInEx(tj0)), hT0 = hostExCs(tj0, dTrEx(tj0));
                if (hI0 && hT0 && !g.isEmpty(hI0) && !g.isEmpty(hT0) && g.area(hT0) > DOME_PLATEAU_RATIO * g.area(hI0)) flatFloor = false;
              }
              var loopIn = flatFloor ? LOOP_IN_FLAT_MM : LOOP_IN_MM;
              var inLoop = g.offset(g.inter(Sj, sheetCs), -loopIn);
              hullS = g.polys(g.offset(inLoop, wI / 2 + 1e-4));
              var ZI = stI.length ? g.offset(g.unionAll(stI), w / 2) : g.empty(), ZT = stT.length ? g.offset(g.unionAll(stT), w / 2) : g.empty();
              if (cavGround) { if (!g.isEmpty(ZI)) ZI = g.union(ZI, cavGround); if (!g.isEmpty(ZT)) ZT = g.union(ZT, cavGround); }
              var hIc = hostExCs(j, dInEx(j)), hTc = hostExCs(j, dTrEx(j));
              if (hIc && steady && HOST_GROW_MM > 0) hIc = g.offset(hIc, HOST_GROW_MM);
              if (hTc && steady && HOST_GROW_MM > 0) hTc = g.offset(hTc, HOST_GROW_MM);
              if (EXACT_OUTLINE && !steady && ribbonSlab && Q0exact) {
                var exAt = function (d) { var key = Math.round((SP[j].printZ + d - exShift) * 1e5), u = null; hosts.forEach(function (Q) { var e = Q.exactGet && Q.exactGet(key); if (e && !g.isEmpty(e)) u = u ? g.union(u, e) : e; }); return u; };
                var eI = exAt(dCl(j, dInEx(j)) + REACH_EXTRA_MM), eT = exAt(dCl(j, dTrEx(j)) + REACH_EXTRA_MM);
                if (eI && eT) {
                  var XO = PLATE_OUT_MM + loopIn;
                  hIc = g.offset(eI, XO); hTc = g.offset(eT, XO);
                  /* the ground: past the mesh's footprint as far as the outline goes, and never into the part at this height (its own section, the gap and a line's half) */
                  var own = [];
                  planes.forEach(function (pl, k) { if (pl.printZ > SP[j].printZ - SP[j].h + 1e-6 && pl.printZ - pl.h < SP[j].printZ - 1e-6) hosts.forEach(function (Q) { if (!g.isEmpty(Q.S[k])) own.push(Q.S[k]); }); });
                  var ownCs = own.length ? g.offset(g.unionAll(own), gap + w / 2 + 0.03) : g.empty();
                  var topJ = zones[j] && zones[j].topI != null ? zones[j].topI : j, eU = PLATE_UP_MM > 0 && topJ > j ? exAt(stackIdx[j] <= PLATE_UP_LOW_N ? PLATE_UP_LOW_MM : PLATE_UP_MM) : null;     /* the stack's top layer keeps its crest */
                  if (eU) { Sj = g.diff(Sj, eU); sheetCs = g.diff(sheetCs, eU); }
                  var ground = g.inter(g.offset(g.inter(Sj, sheetCs), PLATE_BAND_MM), hTc);
                  if (eU) ground = g.diff(ground, eU);
                  if (!g.isEmpty(ownCs)) ground = g.diff(ground, ownCs);
                  Sj = g.union(Sj, ground); sheetCs = g.union(sheetCs, ground);
                  if (!g.isEmpty(ZI)) ZI = g.union(ZI, ground);
                  if (!g.isEmpty(ZT)) ZT = g.union(ZT, ground);
                  inLoop = g.offset(g.inter(Sj, sheetCs), -loopIn);
                  hullS = g.polys(g.offset(inLoop, wI / 2 + 1e-4));
                }
              } else
              if (!planar && !steady && CURVED_SHRINK_MM > 0) { if (hIc) hIc = g.offset(hIc, -CURVED_SHRINK_MM); if (hTc) hTc = g.offset(hTc, -CURVED_SHRINK_MM); }
              var Ireg = hIc && !g.isEmpty(ZI) ? g.inter(g.inter(g.offset(inLoop, -(ribbonSlab ? IFILL_RIBBON_MM : IFILL_IN_MM)), ZI), hIc) : g.empty();
              var Zall = g.isEmpty(ZI) ? ZT : g.isEmpty(ZT) ? ZI : g.union(ZI, ZT);
              var Treg = hTc && !g.isEmpty(Zall) ? g.diff(g.inter(g.inter(inLoop, Zall), hTc), Ireg) : g.empty();
              var slabI = hIc && !g.isEmpty(ZI) ? g.inter(g.inter(Sj, ZI), hIc) : g.empty();
              var slabT = hTc && !g.isEmpty(Zall) ? g.diff(g.inter(g.inter(Sj, Zall), hTc), slabI) : g.empty();
              /* a transition strip is filled where the slab it lies in is wider than 2 x TRANS_FILL_OPEN_MM (the Negative Spheres' ring, 1.8 - 2.3 mm: Bambu zig-zags it; the
                 Oblique's ribbon, under 1 mm: its loop alone) */
              /* ...a ribbon of transition (the Oblique's, one long thin strip) beside an interface is its loop alone however wide; a ring's narrow strips (the Negative Spheres') are zig-zagged,
                 and so is a ribbon that is all transition (the ridge's first two plates, with no interface on the layer: Bambu's zig-zag at 110 across the whole band) */
              var slabTR = g.isEmpty(slabT) ? slabT : g.unionAll(g.parts(slabT).filter(function (q) { var ax = ringAxis(g.polys(q)[0]); return !ax || ax.ratio < RIBBON_T_RATIO || g.isEmpty(slabI); }));
              var openT = g.isEmpty(slabTR) ? slabTR : g.offset(g.offset(slabTR, -TRANS_FILL_OPEN_MM), TRANS_FILL_OPEN_MM);
              var wideT = g.isEmpty(Treg) || g.isEmpty(openT) ? g.empty() : g.inter(Treg, openT);
              /* the ridge's ribbon: the zig-zag stands IFILL_RIBBON_MM in from the interface's own loop line on both sides - not from the sheet's union (its far edge is the transition's border, outside the loop) */
              if (ribbonSlab && !g.isEmpty(slabI)) Ireg = g.offset(g.offset(slabI, -loopIn), -IFILL_RIBBON_MM);
              fillCs = g.isEmpty(Ireg) ? wideT : g.isEmpty(wideT) ? Ireg : g.union(Ireg, wideT);
              /* the loops sit where the support's own wall sits (the slab's edge, half a line in): regions taken on the whole layer, not inside its wall */
              [[slabI, 'Support interface'], [slabT, 'Support transition']].forEach(function (rg) {
                if (g.isEmpty(rg[0])) return;
                var inner = g.offset(rg[0], -loopIn);
                /* a strip of the region narrower than a line has no loop inside it (the inset removes it: the Negative Spheres' ring pinches to 0.35 mm and fell
                   into crescents); there the loop runs nearer the edge - one line down the strip, as Bambu's - and the ring stays whole */
                {
                  var near = g.offset(rg[0], -PINCH_INSET_MM);
                  var bridge = g.isEmpty(near) ? near : g.isEmpty(inner) ? near : g.diff(near, g.offset(inner, PINCH_INSET_MM + 0.02));
                  bridge = g.isEmpty(bridge) ? bridge : g.dropSmall(bridge, 0.02);
                  if (!g.isEmpty(bridge)) inner = g.isEmpty(inner) ? g.inter(near, g.offset(bridge, wI)) : g.union(inner, g.inter(near, g.offset(bridge, wI / 2 + 0.05)));
                }
                g.polys(inner).forEach(function (ring) {
                  if (ring.length > 2) L.paths.push({ feature: rg[1], width: wI, closed: true, pts: (!flatFloor && !ribbonSlab && !cavGround && LOOP_SMOOTH_MM > 0) ? smoothRing(ring, LOOP_SMOOTH_MM) : ring, typed: true });
                });
              });
            }
            /* a ribbon is crossed, never run along: a strip whose long axis the layer's lines would lie within RIBBON_PARALLEL_DEG of takes the stack's other direction (a line
               down a strip is one bead where Bambu's zig-zag crosses it) */
            var fillSegs = [], serpPaths = [];
            if (!g.isEmpty(fillCs)) {
              if (!(byDepth && REGIONAL_PLATE)) fillSegs = scanFill(g.polys(fillCs), aJ, sI, 0);
              else g.parts(fillCs).forEach(function (pp) {
                var rings = g.polys(pp), ang = aJ, ax = ringAxis(rings[0]);
                if (ax && ax.ratio >= RIBBON_RATIO) {
                  var dd = Math.abs(((ax.ang - aJ) % Math.PI + Math.PI) % Math.PI); dd = Math.min(dd, Math.PI - dd);
                  if (dd < RIBBON_PARALLEL_DEG * Math.PI / 180 && !ribbonAngled) ang = aJ + Math.PI / 2;
                }
                var ss = scanFill(rings, ang, sI, 0);
                if (ribbonAngled && ax && RIBBON_SERPENTINE && ss.length > 1) serpPaths = serpPaths.concat(serpentine(ss, ax.ang, 3 * sI));
                else fillSegs = fillSegs.concat(ss);
              });
            }
            serpPaths.forEach(function (pth) { L.paths.push({ feature: 'Support', width: wI, closed: false, pts: pth.pts, sheetFill: true }); });
            if (fillSegs.length) connect(fillSegs, 3 * sI, hullS).forEach(function (pth) {
              L.paths.push({ feature: 'Support', width: wI, closed: false, pts: pth.pts, sheetFill: true });
            });
          }
        }
        function labelAt(x, y) {
          if (zi.length && inside(zi, x, y)) return 'Support interface';
          if (zt.length && inside(zt, x, y)) return 'Support transition';
          if (zis.length || zts.length) {
            if (!hT) { hI = byDepth ? hostEx(j, dInEx(j)) : hostPolys(j, dIn); hT = byDepth ? hostEx(j, dTrEx(j)) : hostPolys(j, dTr); }
            if (zis.length && inside(zis, x, y) && inPolys(hI, x, y)) return 'Support interface';
            if ((zis.length && inside(zis, x, y) || zts.length && inside(zts, x, y)) && inPolys(hT, x, y)) return 'Support transition';
          }
          return 'Support';
        }
        var out = [];
        L.paths.forEach(function (p) {
          var pts = p.pts, np = pts.length, m = p.closed ? np : np - 1;
          if (p.typed) { out.push(p); counts[p.feature]++; return; }                      /* a region's own loop: its type is its region's */
          if (m < 1) { p.feature = 'Support'; out.push(p); counts[p.feature]++; return; }
          /* the path's segments, each typed at its middle (a long one at three places, the majority) */
          var lab = [], len = [];
          for (var e = 0; e < m; e++) {
            var a = pts[e], b = pts[(e + 1) % np], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
            len.push(l);
            if (!(zi.length || zt.length || zis.length || zts.length)) { lab.push('Support'); continue; }
            var votes = {}, ks = l > 0.5 ? [1 / 6, 0.5, 5 / 6] : [0.5];
            ks.forEach(function (k) { var q = labelAt(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k); votes[q] = (votes[q] || 0) + 1; });
            lab.push(Object.keys(votes).sort(function (u, v) { return votes[v] - votes[u]; })[0]);
          }
          /* a run shorter than SPLIT_MIN_MM is its neighbour's (a flicker where a wall crosses the zone's edge) */
          var runs = [];
          lab.forEach(function (q, e) { var r = runs[runs.length - 1]; if (r && r.f === q) { r.to = e; r.l += len[e]; } else runs.push({ f: q, from: e, to: e, l: len[e] }); });
          if (p.closed && runs.length > 1 && runs[0].f === runs[runs.length - 1].f) { var lastR = runs.pop(); runs[0].from = lastR.from - m; runs[0].l += lastR.l; }
          for (var guard = 0; guard < 8 && runs.length > 1; guard++) {
            var ri = -1, mn = SPLIT_MIN_MM;
            runs.forEach(function (r, q) { if (r.l < mn) { mn = r.l; ri = q; } });
            if (ri < 0) break;
            var prevR = runs[(ri + runs.length - 1) % runs.length], nextR = runs[(ri + 1) % runs.length], take = prevR.l >= nextR.l ? prevR : nextR;
            runs[ri].f = take.f;
            var merged = [];
            runs.forEach(function (r) { var q = merged[merged.length - 1]; if (q && q.f === r.f) { q.to = r.to; q.l += r.l; } else merged.push({ f: r.f, from: r.from, to: r.to, l: r.l }); });
            if (p.closed && merged.length > 1 && merged[0].f === merged[merged.length - 1].f) { var lm = merged.pop(); merged[0].from = lm.from - m; merged[0].l += lm.l; }
            runs = merged;
          }
          /* a wall run that lies in the interface or the transition is the region's loop (laid above), not a second line beside it */
          var dropWall = byDepth && REGIONAL_PLATE && /wall$/i.test(p.feature || '');
          if (runs.length <= 1) {
            var f1 = runs.length ? runs[0].f : 'Support';
            if (dropWall && f1 !== 'Support') return;
            p.feature = f1; out.push(p); counts[p.feature]++; return;
          }
          runs.forEach(function (r) {
            if (dropWall && r.f !== 'Support') return;
            var piece = [], from = r.from, to = r.to;
            for (var e2 = from; e2 <= to; e2++) { var idx = ((e2 % np) + np) % np; piece.push(pts[idx]); }
            piece.push(pts[(((to + 1) % np) + np) % np]);
            var np2 = {};
            Object.keys(p).forEach(function (kk) { np2[kk] = p[kk]; });
            np2.pts = piece; np2.closed = false; np2.feature = r.f;
            out.push(np2); counts[r.f]++;
          });
        });
        L.paths = out;
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
        var out = [];
        sups.forEach(function (P) {
          var under = P.planes ? layersUnderX(planes, k, P.planes, o.supportGapMm) : layersUnder(planes, k, o.supportGapMm);
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
  function overhangRegions(g, P, planesShared, linkMm, cover) {
    var planes = P.planes || planesShared;
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
    /* what lies below a region's first layer is the union of layers 0..firstLayer-1; regions come out in rising first-layer order, so one running union
       serves them all (re-unioning every layer below for each region took ring8's 192 regions 270 s of a 290 s slice) */
    var belowAcc = g.empty(), belowTo = 0;
    return regions.map(function (r) {
      for (; belowTo < r.firstLayer; belowTo++) belowAcc = g.union(belowAcc, P.S[belowTo]);
      var belowAll = belowAcc;
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
      Math.round(res.options.sparseDensity * 100) + ' % ' + patternLabel(res.options.sparsePattern) + ', support below ' +
      res.options.supportThresholdDeg + ' deg');
    res.objects.forEach(function (ob) {
      if (ob.role === 'raft') { lines.push(ob.name + ': ' + res.raft.layers + ' layer(s) - ' + res.raft.base + ' base, ' + res.raft.interface + ' interface - top at ' + res.raft.topMm.toFixed(2) + ' mm, the plate on it at ' + res.raft.liftMm.toFixed(2)); return; }
      var st = ob.sectionStats;
      var hist = Object.keys(ob.wallCountHistogram).sort().map(function (k) {
        return k + ' wall' + (k === '1' ? '' : 's') + ' x' + ob.wallCountHistogram[k];
      }).join(', ');
      var need = ob.role === 'support' || ob.role === 'brim' ? null
        : ob.overhang.filter(function (r) { return r.uncoveredMm2 == null || r.uncoveredMm2 > 0; }).length;
      var sp = ob.support;
      lines.push(ob.name + ': ' + hist + '; ' +
        (need == null ? (ob.role === 'brim' ? 'a brim, ' + (ob.layers[0].brimLoops || 0) + ' loop(s)' : 'support for ' + (sp.hostName || 'no piece in this slice') + ', ' + sp.tips + ' tip(s), ' +
          sp.sheets.length + ' sheet(s)') : need + ' support-need region(s)') +
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
    /* the layers in the order they print: the part's planes and every support's own, by height (a support on its own grid prints between the part's) */
    var zOrder = [], seenZ = {};
    var addZ = function (z) { var k = Math.round(z * 10000); if (!seenZ[k]) { seenZ[k] = true; zOrder.push(z); } };
    res.planes.forEach(function (pl) { addZ(pl.printZ); });
    res.objects.forEach(function (ob) { if (ob.planes) ob.planes.forEach(function (pl) { addZ(pl.printZ); }); });
    zOrder.sort(function (a, b) { return a - b; });
    var layerAt = function (ob, z) {
      var pls = ob.planes || res.planes;
      // layers are in order: a binary search for the one at z
      var lo = 0, hi = pls.length - 1;
      while (lo <= hi) { var mid = (lo + hi) >> 1, dz = pls[mid].printZ - z; if (Math.abs(dz) < 5e-5) return ob.layers[mid]; if (dz < 0) lo = mid + 1; else hi = mid - 1; }
      return null;
    };
    for (var zi = 0; zi < zOrder.length; zi++) {
      var zNow = zOrder[zi], hFirst = null;
      var present = res.objects.map(function (ob) { var lay = layerAt(ob, zNow); return lay && lay.paths.length ? { ob: ob, lay: lay } : null; }).filter(Boolean);
      var shared = res.planes.filter(function (pl) { return Math.abs(pl.printZ - zNow) < 5e-5; })[0];
      if (!present.length && !shared) continue;
      var plH = shared ? shared.h : present[0].lay.h;
      L.push('; CHANGE_LAYER');
      L.push('; Z_HEIGHT: ' + fmt(zNow, 4));
      L.push('; LAYER_HEIGHT: ' + fmt(plH, 4));
      L.push('G1 Z' + fmt(zNow, 4) + ' F1200');
      present.forEach(function (it) {
        var ob = it.ob, lay = it.lay, pl = { h: lay.h };
        if (Math.abs(lay.h - plH) > 1e-6) L.push('; LAYER_HEIGHT: ' + fmt(lay.h, 4));
        L.push('; OBJECT_ID: ' + ob.id);
        var feat = null;
        lay.paths.forEach(function (p) {
          var pts = p.closed ? p.pts.concat([p.pts[0]]) : p.pts;
          if (pts.length < 2) return;
          if (p.feature !== feat) { feat = p.feature; L.push('; FEATURE: ' + feat); }
          var area = beadArea(p.width, pl.h);
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
    brimFor: brimFor,
    brimWanted: brimWanted,
    thinWalls: thinWalls,
    medialPaths: medialPaths,
    concentricFill: concentricFill,
    spiralFill: spiralFill,
    hilbertFill: hilbertFill,
    honeycomb3dFill: honeycomb3dFill,
    honeycomb3dAt: honeycomb3dAt,
    gyroidFill: gyroidFill,
    linesFill: linesFill,
    cubicAt: cubicAt,
    adaptiveCubicLattice: adaptiveCubicLattice,
    honeycombFill: honeycombFill,
    lightningFill: lightningFill,
    GYROID_SCALE: GYROID_SCALE,
    hilbertPoint: hilbertPoint,
    clipLine: clipLine,
    patternLabel: patternLabel,
    toGcode: toGcode,
    describe: describe,
    loadKernel: loadKernel,
    run: run
  };
});
