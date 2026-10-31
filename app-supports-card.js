/* ===================== Supports: the card =====================
   The column's SUPPORTS drop-down (make/edit group, after Seat): one card on
   the main page, a verb with a state. docs/SUPPORTS-CARD.md.

   No dots on the mesh. Each hanging AREA (one region of the beacon grid) is
   outlined faintly on the surface: an outline of the area's cells, not a grid.

   DETECT FIRST. Opening the card, or picking another piece while it is open,
   runs detection at once on the selected piece (the only piece on the plate,
   when nothing is selected). Every hanging area is outlined, and the card says
   "N hanging areas at 35\u00b0 on <piece>" with the angle editable right there:
   a new angle re-detects. Nothing is generated yet.
   IDLE      the areas are editable before GENERATE: a click on an outline
             leaves that area out (it dims) or puts it back; Shift-click on the
             piece adds a spot (one beacon, outlined like the rest). Nothing
             builds on a click. Style, Size and "May rest on the part" sit under
             GENERATE.
   BUILDING  GENERATE was pressed. The card is locked and ONE bar fills under
             the readout, 0 to 100 % over the whole build: "Planning 142 / 344
             \u00b7 21 %" (beacons settled), then "Building 41 / 436 \u00b7 55 %"
             (the sheet's tips settled, then the trunks swept), the phase word
             changing as the build moves on; the bottom-right status says the
             same. The count is the phase's own; the percent is the build's
             (PHASE_SPAN), and 100 only when the last unit is done. A phase with
             no count (detecting) shows its word and the seconds,
             "Detecting \u00b7 0 s", on a bar that only moves; no count is ever
             guessed. Escape cancels: the worker is terminated, the plate is as
             it was, Undo has nothing new. The planner runs in a worker so the
             page, the counter and the watchdog stay live. The WATCHDOG is
             silence, not time: it fires when the planner has said nothing for
             60 s (every progress message resets it), and a build still running
             at 10 min is stopped however it reports; either way the bar is
             replaced by "Could not build: ... - nothing was added".
   BUILT     "Built: M supports \u00b7 held H \u00b7 unsupported K \u00b7 unreachable U".
             Every area is exactly one of the three: held (every spot held from
             the plate or resting on the part), unreachable (tried, no route to
             the plate), unsupported (left out, or the planner gave it nothing).
             The ones that need a look have a row under the readout; a click on
             a row frames the area. GENERATE is now REGENERATE (it replaces every
             support on the piece); REMOVE ALL sits beside it. A click on a built
             support picks it; REMOVE takes that one. Areas the plate could not
             reach stay outlined in red.
   A build ENDS IN A STATE, every time: BUILT, or "Could not build: <reason> -
   nothing was added" (planner refusal, exception, or the watchdog). On a
   failure the plate is exactly as before and Undo has nothing to undo.
   Every state change - leaving an area out, a manual spot, a build, a removal -
   is ONE Undo (a supportSwap step; its onUndone puts the card's own record of
   the piece back). The angle is a setting, like Style: not an Undo step.

   GENERATE FOR PLATE. With two or more pieces on the plate the card offers
   "Generate for plate" (#sup-plate). It is not a "nothing selected" state: it
   is switched on, and it highlights every real (non-support) piece first, as a
   selection does, while detection runs on each of them; the readout says
   "N pieces \u00b7 M hanging areas at 35\u00b0". GENERATE then loops the build
   above over the pieces in plate order - each with its own left-out areas, fed
   tips and circles, in the card's mode; Style, Size, "May rest" and the angle
   are the card's, shared. ONE bar fills over the whole plate ("Piece 2 of 6 \u00b7
   Planning 142 / 344 \u00b7 21 %": the counts are the piece's, the percent is the
   plate's, weighted by each piece's spots), and the plate is touched once, at
   the very end, in one stretch: every piece's supports are replaced, ONE Undo
   step takes them all back. Escape, the watchdog or an exception stops
   everything, as for one piece: the plate as it was, no Undo step. A piece with
   nothing hanging, with every area left out, or one the planner refuses is
   reported in its own row and does not cancel the others. The watchdog is the
   same silence (60 s with no message); the 10 min ceiling is per piece (it is
   started again as each piece begins), not for the plate. A piece's supports
   must not touch another piece or its supports, so the supports already built
   for the earlier pieces of the run are handed to the later ones as occluders
   (opts.occluders, the option detection and the planner already take for the
   other pieces' bodies); the engine is not changed.
   The option goes off when it is switched off, when a piece is picked, when a
   piece is added or removed or the plate cleared, on Undo, and when the card
   closes - and it takes its highlight with it (the selection outline, one per
   piece; none is left behind or doubled).

   WHAT IS REUSED, AND NOTHING HERE REPLACES
     detection   NSO_SupportAim.detectOverhangs - its beacon grid (det.beacons,
                 det.beaconRegions, nso_support_beacons.js), read as it comes.
     planning    NSO_SupportTree.planTree with opts.beacons: the detected set
                 with the edits applied, one area per call, then
                 NSO_SupportGridpack.parts (with the interface sheet) and
                 .shells - every part its own closed shell, no weld: the
                 slicer fills an object's overlapping shells as one
                 (support:shells holds the layers to the welded support's).
                 The same planner G-scope's row calls. Each solid it hands
                 back says which beacons and which area it holds (regionIds),
                 so "this area's supports" and "this support" are lookups on
                 the piece's label, never a geometry test.
     the pieces  every solid lands as its own plate piece, through
                 addModelFromZUpGeometry + placeModelMovable, labelled
                 m.nsoSupport = { card: true, hostSourceId, regionId, keys,
                 holds, ... }. G-scope sees it as a support (never a host);
                 its own row leaves card supports alone (supportsFor).

   AUTO \u00b7 ASSISTED \u00b7 CUSTOM (docs/SUPPORTS-CARD.md section 6). A switch at the
   top of the card feeds the planner's opts.feed (nso_support_gridpack.js,
   docs/SUPPORT-GRIDPACK.md section 7). AUTO is everything above, unchanged:
   no feed is sent. ASSISTED shows the detected spots as clickable points on
   the piece (a click turns one off or on: off is not a tip). CUSTOM shows
   none: a click on the piece's underside places a tip, a click on a tip takes
   it away. Both take landing zones - circles on the plate - and, once built,
   an ERASE tool. Three tools, one at a time, so that the pointer is only ever
   claimed by what is switched on: TIPS (the default: the points on the
   piece), CIRCLES (draw / resize / move / delete the zones; the plate is
   drawn on, so orbit first, then switch it on, then switch it off to orbit
   again) and ERASE (hover a built member and what it holds up lights; a click
   removes it and the plan is made again). The user's points, circles and
   erasures live on the piece (m.nsoSupportFeed, in its own frame, circles in
   the plate's) and outlive a REGENERATE; REMOVE ALL and CLEAR PLATE forget them.

   TUNE (Custom only). A collapsed section with four numbers - trunk top
   (mm), trunk growth (deg), lean limit (deg), node spacing (mm) - the planner's
   feed.knobs (docs/SUPPORT-GRIDPACK.md section 7), each starting at today's
   value. They are card settings, like the angle and the size: not an Undo
   step, not on the piece, kept when the mode changes away from Custom and when
   REMOVE ALL runs. Nothing rebuilds as one is typed: a field that no longer
   matches what the standing build was made with marks the build STALE (the
   readout dims and says so) and REGENERATE is the set button. A field at its
   default is not sent: with all four at default the feed has no knobs at all.

   FRAME. The piece's world soup, Z up, millimetres (meshToWorldSoup, then
   (x, -z, y)), as Bridge and G-scope read it. Edits are stored in the piece's
   own mesh frame, so they move with it.

   PAINT SCOPE: SUB-REGION (detection), as G-scope's row: painted faces
   (nsoMaskFaceList) are the skipList, shifted into the world frame when the
   piece is only moved, refused by name when it is turned AND painted. The
   piece itself is never written; supports are new pieces. */
var NSO_SUPPORTS_CARD = (function () {
  'use strict';

  var STYLES = { strut: 'Straight strut', tree: 'Tree', 'gecko-hand': 'Gecko-hand' };
  /* The outline of an area: faint white while it will be built, grey once it
     is left out, red when the plate could not reach all of it. */
  var OUTLINE = { on: 0xffffff, off: 0x7b8494, red: 0xff2d2d };
  var OUTLINE_ALPHA = { on: 0.55, off: 0.6, red: 0.95 };
  /* The angle is the tilt off the plate: a face within ANGLE of horizontal
     hangs (nso_support_aim.js: n.z < -cos(angle)). Bambu's support threshold
     is measured the same way, from horizontal - not from vertical - so its 30
     is our 30 (measured on fixtures/supports/simple_overhang.3mf: Bambu, tree
     slim at 30, supported only the arc's underside within 30 deg of
     horizontal, z 41.4 - 46.2, 254 mm^2, and printed the 40 - 60 deg stretch
     as overhang walls). The default is a hair more sensitive than Bambu's;
     the label names Bambu's for comparison. */
  var ANGLE_DEFAULT = 35;
  var BAMBU_ANGLE = 30;          // Bambu Studio's default support_threshold_angle
  var ANGLE_MIN = 1, ANGLE_MAX = 89;
  var ANGLE_DEBOUNCE_MS = 220;   // typing "3" on the way to "30" does not detect at 3
  var JOIN_PITCHES = 1.5;        // a manual beacon this close to a region joins it (the grid's own z rule)
  var PICK_PITCHES = 1.0;        // a click this close to a beacon is in that beacon's area
  /* PAINT (docs/SUPPORT-FOOTPRINT.md section 10): a stroke over the piece asks for supports where it goes. Its samples are kept 0.5 mm apart on the surface; it asks
     for a spot every 2 mm along it (a spot joins the area of the nearest one as a manual spot does, or starts an area), and the cells the brush covered that no
     detected footprint holds are a footprint of their own for the raft - laid to the brush's edge. A footprint painted over keeps its plate to its edge too. */
  var PAINT_R_DEFAULT = 2;       // the brush's radius, mm (the Brush field is its diameter)
  var PAINT_STEP_MM = 0.5;
  var PAINT_SPOT_MM = 2;
  var PAINT_MARGIN_MM = 0.02;
  var PAINT_MAX = 6000;          // samples in one stroke
  var PAINT_COL = 0xe879f9;
  /* a stroke asks for supports only on the faces the card calls hanging at its angle (a face's normal below -cos(angle)): the raft's layers step up a slope that gentle, a steeper flank is the stair's */
  function paintNz() { return -Math.cos(Math.max(20, Math.min(60, S.angle)) * Math.PI / 180); }
  var UP_MAX = 0.26;            // a face whose normal points up more than this (15 deg) holds nothing
  var ORDER = 30;                // over the piece and its outline
  var MARK_ORDER = 900;          // the markers (spots, tips, circles, the eraser's light) draw over everything, as the rotate rings do
  var PICK_PX = 9;               // a spot / a tip / a circle's edge is under the pointer within this many pixels
  var ZONE_MIN_R = 1.5;          // a circle dragged smaller than this (mm) is a click, not a circle
  var MODES = { auto: 'Auto', assisted: 'Assisted', custom: 'Custom' };
  var TOOLS = { tips: true, circles: true, erase: true };
  /* TUNE: the feed's knobs (nso_support_gridpack.js, THE KNOBS), today's values.
     A knob is a finite number above 0; the trunk's growth may be 0 (a straight
     trunk). The planner does not clamp them and neither does the card. */
  var KNOBS = [
    { key: 'trunkTipMm', id: 'sup-knob-tip', def: 2, word: 'Trunk top', zeroOk: false },
    { key: 'trunkAngleDeg', id: 'sup-knob-growth', def: 5.5, word: 'Trunk growth', zeroOk: true },
    { key: 'leanDeg', id: 'sup-knob-lean', def: 30, word: 'Lean limit', zeroOk: false },
    { key: 'nodeMm', id: 'sup-knob-node', def: 5, word: 'Node spacing', zeroOk: false }
  ];
  var OFF_TOL_MM = 0.3;          // a toggled-off spot is found again within this of where it was
  var WATCHDOG_MS = 60000;       // a build the planner has said nothing about for this long is stopped, and says so
  var CEILING_MS = 600000;       // a build still running at 10 min is stopped however it reports: a runaway
  var ELAPSED_FROM_MS = 10000;   // a build the planner has said nothing about counts seconds once it has run this long
  var SLICE_MS = 250;            // on the page, a build gives the page a turn after this much work (repaint, Escape, the clock); a turn costs a frame of the 3D view
  /* The phases a build goes through, in order, as the planner names them
     (nso_support_gridpack.js, PROGRESS). A phase never goes back. Each
     counted phase fills its share of the one bar: planning the first half,
     building the second (measured on the standing clamp: plan 3.4 s, build
     3.1 s). */
  var PHASE_WORD = { detecting: 'Detecting', planning: 'Planning', building: 'Building' };
  var PHASE_RANK = { detecting: 0, planning: 1, building: 2 };
  var PHASE_SPAN = { planning: [0, 50], building: [50, 100] };
  /* The planner's files, in index.html's order: what the build worker loads. */
  var ENGINE = ['nso_thickness.js', 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js',
    'nso_support_tree.js', 'nso_support_gridpack.js', 'nso_raster_lines.js', 'nso_crosshatch.js', 'nso_support_interface.js'];
  /* What the build asks of NSO_SupportGridpack.parts: every tip that meets the
     part ends in a flat cap under the interface sheet (nso_support_interface.js,
     sheet(): 2 transition and 2 interface layers at 0.84 mm, each a loop
     and a serpentine inside it, on the caps, 0.18 mm under the part), its
     layers left as they are (foldSheets: false), and every trunk
     stands on its foot with no pad drawn (footPads: 'shared') - the pads are
     drawn at the end over every area's feet at once (shareFeet, in commit).
     Nothing is welded: NSO_SupportGridpack.shells hands every part back as its
     own closed shell, grouped into the supports weld() would have made. The
     weld was 16 of the clamp's 23 s and made no layer a slicer prints any
     different (support:shells); nothing on the plate needs a support to be
     one shell (the booleans merge a piece's shells for themselves: the
     overlap merge in nso-helpers.js). */
  /* sheetPerimeter: the sheet and its caps keep to where the part is over them, not out over the air past its edge */
  var PARTS_OPTS = { interface: true, foldSheets: false, footPads: 'shared', sheetPerimeter: true, sheetRegionPlate: true, sheetSlabPlate: true, sheetRegionFlare: true };
  /* The sheet's line pitch and its interface layers are the build's own: DENSE is Bambu's (support_interface_spacing 0.1: lines
     0.46 mm apart, and 3 interface layers over the 2 of transition, as the reference slice lays every head); OPEN is the 0.84 mm
     and 2 + 2 layers the first prints were made with. */
  function oneTrunkOn(o) { return S.mode === 'auto' && !!o.one && o.style === 'tree'; }
  function partsOptsOf(o) {
    /* Dense belongs to the one-trunk build: its sheet is planned over the thinned tips the reference's is. A hand-placed row of three
       tips (Custom) did not form a sheet at 0.47 mm that it forms at 0.84 (support:custom), so the other builds stay Open. */
    var SI = window.NSO_SupportInterface, dense = !!o && o.dense !== false && oneTrunkOn(o);
    var out = dense && SI && SI.SHEET && SI.SHEET.densePitchMm ? Object.assign({}, PARTS_OPTS, { sheetPitchMm: SI.SHEET.densePitchMm, interfaceLayers: SI.SHEET.denseInterfaceLayers, sheetLayerMm: SI.SHEET.denseSheetLayerMm, sheetRegionSlopes: true, sheetFlatGapMm: SI.SHEET.denseFlatGapMaxMm, sheetStairLegMm: SI.SHEET.denseStairLegMm }) : Object.assign({}, PARTS_OPTS);
    /* THE PLATFORM is the tree's own (the owner's: raft is a support type of its own; the platform under a flat face - the interface and the transition
       laid from each footprint and its height, layer by layer - is the original branch / transition / interface, and was only tied to the Raft box).
       Auto (the one-trunk tree) always lays it. The box now gates only the builds that are not Auto: off, their sheet is built from the tips alone, as it
       was before the region plate (docs/SUPPORT-FOOTPRINT.md section 9). */
    if (o && o.raft === false && !oneTrunkOn(o)) { out.sheetRegionPlate = false; out.sheetSlabPlate = false; out.sheetRegionFlare = false; }
    return out;
  }
  /* The card's state when the picked piece has no beacons at all. Detection
     only asks what hangs in air; a tall, thin piece that may sway as it
     prints is a different question, not asked yet, and the words say so. */
  var NOTHING = 'Nothing hangs in air. Tall-and-thin sway isn\'t checked yet.';
  var ALL_BLOCKED = 'Every spot is inside a Supports Blocker. Move or resize one to let supports in.';

  /* SUPPORTS BLOCKERS (nso_support_blockers.js, app-support-blockers.js, docs/SUPPORT-BLOCKERS.md): boxes on the plate, in the plate's
     own frame, held on state.supportBlockers. No support is made in one. The card takes the spots a box holds out of its list
     (effective), cuts the held part out of the area's footprint (the outline, and the surface the sheet is laid over), and hands the
     boxes to the planner as obstacles, as it hands it the other pieces. A plate with no box is built exactly as it was. */
  function BL() { return window.NSO_SupportBlockers || null; }
  function boxesNow() { return (typeof state !== 'undefined' && state && state.supportBlockers && BL()) ? state.supportBlockers : []; }
  function boxesKey() {
    var b = boxesNow();
    return b.length ? b.map(function (x) { return x.c.map(function (v) { return Math.round(v * 1000); }).concat(x.h.map(function (v) { return Math.round(v * 1000); })).join(','); }).join(';') : '';
  }
  /* the clipped footprints are re-traced on a raster: kept by the footprint, the boxes and the spots it was cut for */
  var CLIPPED = typeof WeakMap === 'function' ? new WeakMap() : null;
  function clippedFp(fp, all, boxes, pitch) {
    var key = boxesKey() + '|' + all.length, hit = CLIPPED && CLIPPED.get(fp);
    if (hit && hit.key === key) return hit.fp;
    var out = BL().clipFootprint(fp, all, boxes, pitch);
    if (CLIPPED) CLIPPED.set(fp, { key: key, fp: out });
    return out;
  }
  /* what the planner is to avoid: the other pieces, and the boxes */
  function occludersOf(D) {
    var boxes = boxesNow();
    return ((D.opts && D.opts.occluders) || []).concat(boxes.length ? BL().soups(boxes) : []);
  }

  var S = {
    open: false, hostId: null, selSupport: null, busy: false,
    det: null, occ: {}, eff: null, layer: null, raf: 0, sig: '', mem: {}, msg: null,
    geo: null, angle: ANGLE_DEFAULT, angleTimer: 0,
    watchdogMs: WATCHDOG_MS, ceilingMs: CEILING_MS, planner: null, job: null, elapsed: 0,
    prog: null, listeners: [], said: null, knobs: {},
    paint: false, stroke: null, paintLayer: null,
    mode: 'auto', tool: 'tips', pts: null, zoneLayer: null, eraseLayer: null, hot: null, hover: null, sel: null, drag: null,
    /* GENERATE FOR PLATE: on/off; the pieces it was switched on for; the pieces lit (the outline each one holds); what
       each was last detected as; the piece the card was on before; what the plate reads now; the run's place on the bar;
       and why a piece was left out of the last build */
    wide: false, wideIds: [], lit: [], dets: {}, wideFrom: null, wideView: null, run: null, wideNotes: {}
  };

  function $(id) { return document.getElementById(id); }
  function modelOf(id) { return (state.models || []).find(function (m) { return m && m.id === id; }) || null; }
  function placedOf(id) { return (state.placed || []).find(function (p) { return p && p.sourceId === id && p.mesh; }) || null; }
  function isSupport(id) { var m = modelOf(id); return !!(m && m.nsoSupport); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  /* The pieces a plate-wide build is for: every placed piece that is not a support, in plate order. */
  function realPieces() {
    return (state.placed || []).filter(function (p) { return p && p.mesh && !isSupport(p.sourceId); });
  }
  function realIds() { return realPieces().map(function (p) { return p.sourceId; }); }
  /* Run fn with the card pointed at another piece, then put it back. effective(), statesFor(), snapshot() and the rest
     read the picked piece off S, so a plate-wide read or build is each of them called once a piece: the piece's own
     code, its own remembered state. What was detected for the piece is kept (S.dets) for the next time. */
  function asHost(id, fn) {
    var keep = { h: S.hostId, d: S.det, e: S.eff };
    S.hostId = id; S.det = S.dets[id] || null;
    try { return fn(); }
    finally { if (S.det) S.dets[id] = S.det; S.hostId = keep.h; S.det = keep.d; S.eff = keep.e; }
  }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
  function pt(b) { return [b.x, b.y, b.z]; }

  /* ------------------------------------------------------------- frames */

  function poseKey(p) {
    p.mesh.updateMatrixWorld(true);
    return p.sourceId + '|' + p.mesh.geometry.uuid + '|' + Array.prototype.map.call(p.mesh.matrixWorld.elements,
      function (v) { return v.toPrecision(10); }).join(',');
  }
  function worldUp(mesh) {
    var s = meshToWorldSoup(mesh), out = new Float32Array(s.length);
    for (var i = 0; i < s.length; i += 3) { out[i] = s[i]; out[i + 1] = -s[i + 2]; out[i + 2] = s[i + 1]; }
    return out;
  }
  function boundsOf(soup) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < soup.length; i++) {
      var k = i % 3;
      if (soup[i] < lo[k]) lo[k] = soup[i];
      if (soup[i] > hi[k]) hi[k] = soup[i];
    }
    return { lo: lo, hi: hi };
  }
  function upToView(q) { return new THREE.Vector3(q[0], q[2], -q[1]); }
  function viewToUp(v) { return [v.x, -v.z, v.y]; }
  /* Edits live in the piece's mesh frame, so they ride along when it moves. */
  function upToLocal(p, q) { return p.mesh.worldToLocal(upToView(q)).toArray(); }
  function localToUp(p, l) { return viewToUp(p.mesh.localToWorld(new THREE.Vector3(l[0], l[1], l[2]))); }
  function upDirToLocal(p, n) {
    var inv = new THREE.Matrix4().copy(p.mesh.matrixWorld).invert();
    return upToView(n).transformDirection(inv).toArray();
  }
  function localDirToUp(p, l) { return viewToUp(new THREE.Vector3(l[0], l[1], l[2]).transformDirection(p.mesh.matrixWorld)); }

  /* ----------------------------------------------------- what the piece is */

  function others(hostId) {
    return (state.placed || []).filter(function (p) { return p && p.mesh && p.sourceId !== hostId && !isSupport(p.sourceId); });
  }
  function occluderSoup(p) {
    var k = poseKey(p), c = S.occ[p.sourceId];
    if (!c || c.key !== k) { c = { key: k, soup: worldUp(p.mesh) }; S.occ[p.sourceId] = c; }
    return c.soup;
  }

  /* The painted faces, in the frame detection runs in (G-scope's rule). */
  function skipListFor(m, p, soup) {
    var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (!painted) return { list: [] };
    if (p.rotY || p.flipX || p.tipX || p.tipZ || p.tiltX || p.tiltZ) {
      return { list: null, reason: '"' + m.name + '" is painted and turned: its painted faces are recorded in the ' +
        'file\'s own axes and cannot follow the turn. Clear the paint, or turn it back.' };
    }
    var list = (typeof nsoMaskFaceList === 'function') ? nsoMaskFaceList(m) : [];
    if (list === null) return { list: null, reason: '"' + m.name + '" has a painted patch with no axis to name it by.' };
    if (!m.rawTris) return { list: null, reason: '"' + m.name + '" is painted but has no raw mesh.' };
    var rb = boundsOf(m.rawTris), wb = boundsOf(soup);
    var t = [wb.lo[0] - rb.lo[0], wb.lo[1] - rb.lo[1], wb.lo[2] - rb.lo[2]];
    return { list: list.map(function (e) { return Object.assign({}, e, { d: e.d == null ? null : e.d + t[e.axisIdx] }); }) };
  }

  /* Detection for the picked piece, cached on its pose and the others'. */
  function detect() {
    var p = placedOf(S.hostId), m = modelOf(S.hostId);
    if (!p || !m) return null;
    var occ = others(S.hostId);
    var key = poseKey(p) + '#' + occ.map(poseKey).join('#') + '#' + ((typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0) + '@' + S.angle;
    if (S.det && S.det.key === key) return S.det;
    var soup = worldUp(p.mesh), sk = skipListFor(m, p, soup);
    /* beaconInsetMm: a spot stands at least this far in from the edge of the surface it holds (docs/SUPPORT-FOOTPRINT.md) */
    var SBm = window.NSO_SupportBeacons, opts = { skipList: sk.list, angleDeg: S.angle, occluders: occ.map(occluderSoup), beaconInsetMm: SBm && SBm.INSET_PRODUCT_MM || 0, beaconSeedMm: SBm && SBm.SEED_PITCH_PRODUCT_MM || 0, beaconBridgeMinMm: SBm && SBm.BRIDGE_MIN_PRODUCT_MM || 0 };
    /* A BIG piece is read in a worker (detection is 10 s of JS on the vase, and
       the card used to freeze the page for all of it on opening). The card
       says "measuring…" and redraws when the read comes back. */
    if (!sk.reason && bigPiece(soup)) return detectInWorker(key, soup, opts, S.hostId);
    return settle(key, soup, opts, sk.reason ? null : window.NSO_SupportAim.detectOverhangs(soup, opts), sk.reason, S.hostId);
  }

  var PENDING = { pending: true };
  function bigPiece(soup) {
    return !!(window.NSO_BVH && window.NSO_BVH.isBig(soup.length / 9) && window.NSO_Work && window.NSO_Work.isAvailable());
  }
  /* `id` is the piece the read was for: a worker's answer comes back when the card may be on another piece (or, for the
     plate, on none), and is filed under the piece it was read for. */
  function settle(key, soup, opts, det, reason, id) {
    var err = reason || (det && !det.ok ? det.reason : null) ||
      (det && !det.beacons ? (det.beaconsReason || 'no beacon grid') : null);
    S.det = { key: key, soup: soup, opts: opts, det: det, error: err, minZ: boundsOf(soup).lo[2] };
    if (id != null) S.dets[id] = S.det;
    return S.det;
  }
  function detectInWorker(key, soup, opts, id) {
    if (S.detJob && S.detJob.key === key) return PENDING;
    if (S.detJob) { S.detJob.job.cancel(); S.detJob = null; }
    var job = window.NSO_Work.run('support-detect', ['nso_thickness.js', 'nso_support_beacons.js', 'nso_support_aim.js'],
      'NSO_SupportAim.detectOverhangs', [soup, opts]);
    var mine = S.detJob = { key: key, job: job };
    job.promise.then(function (det) {
      if (S.detJob !== mine) return;
      S.detJob = null;
      settle(key, soup, opts, det, null, id);
      if (S.open) refresh();
    }, function (err) {
      if (S.detJob !== mine) return;
      S.detJob = null;
      settle(key, soup, opts, null, 'Could not read the piece (' + ((err && err.message) || err) + ').', id);
      if (S.open) refresh();
    });
    return PENDING;
  }

  function editsOf(m) {
    if (!m.nsoSupportEdits) m.nsoSupportEdits = { ops: [], serial: 0 };
    return m.nsoSupportEdits;
  }
  function memOf(id) {
    if (!S.mem[id]) S.mem[id] = { unreach: {}, built: false, members: [], zonesEmpty: [], builtKnobs: '' };
    return S.mem[id];
  }
  /* What the user fed in, on the piece: tips and toggled-off spots in its own
     frame (they ride along when it moves), circles in the plate's (x, y, r,
     mm, Z up), and the ids the eraser has taken out. Kept across GENERATE;
     REMOVE ALL and CLEAR PLATE forget it. */
  function feedOf(m) {
    if (!m.nsoSupportFeed) m.nsoSupportFeed = { tips: [], off: [], zones: [], erased: [], serial: 0 };
    return m.nsoSupportFeed;
  }
  function feedCopy(f) { return f ? JSON.parse(JSON.stringify(f)) : null; }
  function feedEmpty(f) { return !f || !(f.tips.length || f.off.length || f.zones.length || f.erased.length); }
  function tipIdOf(q, given) { return window.NSO_SupportGridpack.tipId(q, given); }

  /* TUNE. S.knobs holds what the four fields say, as numbers (NaN for a field
     that is empty or not a number); a knob not in it is at its default. */
  function knobOk(K, v) { return typeof v === 'number' && isFinite(v) && (K.zeroOk ? v >= 0 : v > 0); }
  function knobValue(K) { return K.key in S.knobs ? S.knobs[K.key] : K.def; }
  function knobBad() {
    var K = KNOBS.find(function (k) { return !knobOk(k, knobValue(k)); });
    return K ? K.word + ' must be a number' + (K.zeroOk ? ', 0 or more.' : ' above 0.') : null;
  }
  /* The knobs a build sends: only those that differ from the default, or null
     when none do (a feed with no knobs at all is today's plan). */
  function knobsGiven() {
    var out = null;
    KNOBS.forEach(function (K) {
      var v = knobValue(K);
      if (knobOk(K, v) && v !== K.def) { out = out || {}; out[K.key] = v; }
    });
    return out;
  }
  /* What a build was made with, or what the fields say now, as one string: the
     two are compared to tell a stale build. A field that is not a number reads
     '?', so it never matches a build. Auto and Assisted send no knobs. */
  function knobKey(given, bad) { return bad ? '?' + JSON.stringify(given) : given ? JSON.stringify(given) : ''; }
  function knobsNow() { return S.mode === 'custom' ? knobKey(knobsGiven(), knobBad()) : ''; }
  function knobsChanged() { return KNOBS.filter(function (K) { var v = knobValue(K); return !knobOk(K, v) || v !== K.def; }).length; }
  function tuneStale() {
    if (S.mode !== 'custom' || S.hostId == null) return false;
    var mem = memOf(S.hostId);
    return !!mem.built && mem.builtKnobs !== knobsNow();
  }

  /*
   * The beacons the card shows and builds: the detected set, then the edits
   * in the order they were made. A manual beacon joins the area of the
   * nearest beacon within JOIN_PITCHES pitches, or starts an area of its
   * own (numbered after detection's). An 'exclude' leaves out the area of the beacon nearest its point, an
   * 'include' puts it back (the list as it stands then, so ids stay put).
   */
  function effective() {
    var D = detect();
    if (D === PENDING) return { beacons: [], regions: [], pitch: 3, error: null, measuring: true };
    if (!D || D.error) return { beacons: [], regions: [], pitch: 3, error: D ? D.error : 'that piece is gone' };
    var det = D.det, p = placedOf(S.hostId), m = modelOf(S.hostId);
    var pitch = det.grid ? det.grid.pitch : 3;
    var regionOf = new Map();
    (det.beaconRegions || []).forEach(function (r) { r.beacons.forEach(function (b) { regionOf.set(b, r.id); }); });
    /* A detected beacon is named by where it is, not by its place in the list:
       a new angle detects a different set, and the supports already standing
       (and the spots a build could not reach) must still find their beacons. */
    var custom = S.mode === 'custom', fed = S.mode !== 'auto', F = fed ? feedOf(m) : null;   // Auto never touches the piece's feed
    /* CUSTOM has no detected spots: the tips are the only input. */
    var list = custom ? [] : (det.beacons || []).map(function (b) {
      return { key: 'd' + b.x.toFixed(2) + ',' + b.y.toFixed(2) + ',' + b.z.toFixed(2), x: b.x, y: b.y, z: b.z,
        normal: b.normal.slice(), need: b.need, region: regionOf.get(b), manual: false };
    });
    var left = {};
    var next = custom ? 0 : (det.beaconRegions || []).length, ops = editsOf(m).ops;
    /* A tip joins an area the way a manual spot does. */
    if (custom) F.tips.forEach(function (t) {
      var w = localToUp(p, t.p), n = localDirToUp(p, t.n), best = null, bd = Infinity;
      list.forEach(function (b) { var d = dist(pt(b), w); if (d < bd) { bd = d; best = b; } });
      list.push({ key: 'u' + t.id, x: w[0], y: w[1], z: w[2], normal: n, need: { kind: n[2] > -0.5 ? 'side' : 'face', tip: true },
        manual: false, tip: true, tipId: t.id, region: best && bd <= JOIN_PITCHES * pitch ? best.region : next++ });
    });
    ops.forEach(function (op, i) {
      if (op.op !== 'add' || custom) return;
      var w = localToUp(p, op.p), n = localDirToUp(p, op.n), best = null, bd = Infinity;
      list.forEach(function (b) { var d = dist(pt(b), w); if (d < bd) { bd = d; best = b; } });
      var side = n[2] > -0.5;
      list.push({ key: 'm' + op.id, x: w[0], y: w[1], z: w[2], normal: n,
        need: { kind: side ? 'side' : 'face', manual: true }, manual: true, op: i,
        region: best && bd <= JOIN_PITCHES * pitch ? best.region : next++ });
    });
    /* PAINT: a stroke asks for a spot every PAINT_SPOT_MM along it, on the faces that do not look up; each joins the area of the nearest spot as a
       manual one does, or starts an area of its own. In Custom they are tips. */
    ops.forEach(function (op, i) {
      if (op.op !== 'paint') return;
      paintSpotsOf(op, p).forEach(function (s, k) {
        var best = null, bd = Infinity;
        list.forEach(function (b) { var d = dist(pt(b), s.w); if (d < bd) { bd = d; best = b; } });
        list.push({ key: 'p' + op.id + '.' + k, x: s.w[0], y: s.w[1], z: s.w[2], normal: s.n, need: { kind: s.n[2] > -0.5 ? 'side' : 'face', manual: true, paint: true },
          manual: true, paint: true, op: i, tip: custom, region: best && bd <= JOIN_PITCHES * pitch ? best.region : next++ });
      });
    });
    /* AN AREA THE LAST BUILD HELD IN PART: the spots it could not reach are
       an area of their own (numbered after the rest), so the area it held
       reads held and the lost spots are named where they are - the arc's
       top, held, was called "unreachable" for three spots at its foot. */
    var lost = {}, kept = {}, un = memOf(S.hostId).unreach, mixed = {};
    Object.keys(un).forEach(function (r) { un[r].forEach(function (k) { lost[k] = true; }); });
    cardSupports(S.hostId).forEach(function (sp) { Object.keys(sp.nsoSupport.holds || {}).forEach(function (k) { kept[k] = true; }); });
    list.forEach(function (b) {
      var g = mixed[b.region] || (mixed[b.region] = { lost: 0, kept: 0 });
      if (lost[b.key]) g.lost++; else if (kept[b.key]) g.kept++;
    });
    Object.keys(mixed).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) {
      if (mixed[r].lost && mixed[r].kept) mixed[r].split = next++;
    });
    list.forEach(function (b) { var g = mixed[b.region]; if (g && g.split != null && lost[b.key]) b.region = g.split; });
    /* left out and put back: the area of the spot nearest the click, as the
       list stood then (the spots added before it) */
    ops.forEach(function (op, i) {
      if (fed || (op.op !== 'exclude' && op.op !== 'include')) return;   // the areas are Auto's: a fed card works spot by spot
      var w = localToUp(p, op.p), near = null, nd = Infinity;
      list.forEach(function (b) { if (b.manual && b.op > i) return; var d = dist(pt(b), w); if (d < nd) { nd = d; near = b; } });
      if (near && nd <= PICK_PITCHES * 1.5 * pitch) { if (op.op === 'exclude') left[near.region] = true; else delete left[near.region]; }
    });
    /* OFF: a spot the user turned off, or the eraser took out (a tip id the
       planner was told to leave out). Not a tip: it is not built, not counted. */
    if (fed) {
      var gone = F.off.map(function (o) { return localToUp(p, o.p); }), erased = {};
      F.erased.forEach(function (id) { erased[id] = true; });
      list.forEach(function (b) {
        b.id = tipIdOf(pt(b), !!b.tip);
        if (erased[b.id]) { b.off = true; b.erased = true; }
        else if (!b.tip && gone.some(function (w) { return dist(pt(b), w) <= OFF_TOL_MM; })) b.off = true;
      });
    }
    /* SUPPORTS BLOCKERS: a spot a box holds is not planned, outlined or counted; the area keeps the rest, and its footprint is cut where the box was */
    var boxes = boxesNow(), every = list, nBlocked = 0;
    if (boxes.length) { var cut = BL().filterBeacons(list, boxes); list = cut.kept; nBlocked = cut.held.length; }
    var allBy = {};
    if (boxes.length) every.forEach(function (b) { (allBy[b.region] = allBy[b.region] || []).push(b); });
    var by = {};
    list.forEach(function (b) { (by[b.region] = by[b.region] || []).push(b); });
    var regions = Object.keys(by).map(Number).sort(function (a, b) { return a - b; }).map(function (id) {
      var B = by[id], c = [0, 0, 0], n = [0, 0, 0];
      B.forEach(function (b) { for (var k = 0; k < 3; k++) { c[k] += pt(b)[k] / B.length; n[k] += b.normal[k]; } });
      var L = Math.hypot(n[0], n[1], n[2]) || 1;
      var dr = (det.beaconRegions || [])[id];
      return { id: id, beacons: B, point: c, normal: [n[0] / L, n[1] / L, n[2] / L],
        fp: !custom && dr && dr.footprint ? (boxes.length ? clippedFp(dr.footprint, allBy[id] || B, boxes, pitch) : dr.footprint) : null,      // the detector's outline of the surface (an area a build split has none of its own), with what a blocker holds cut away
        excluded: fed ? B.every(function (b) { return b.off; }) : !!left[id] };
    });
    return { beacons: list, regions: regions, pitch: pitch, origin: det.grid ? det.grid.origin : [0, 0], error: null, blocked: nBlocked };
  }

  /* -------------------------------------------------- supports and states */

  /* The supports standing on the plate for a piece. The app's own Remove
     takes a piece off the plate and keeps its model, so the model list
     alone would still count it. */
  function supportsOf(hostId) {
    return (state.models || []).filter(function (m) {
      return m && m.nsoSupport && m.nsoSupport.hostSourceId === hostId && !!placedOf(m.id);
    });
  }
  function cardSupports(hostId, regionId) {
    return supportsOf(hostId).filter(function (m) {
      return m.nsoSupport.card && !m.nsoSupport.brim && (regionId == null || m.nsoSupport.regionId === regionId);
    });
  }

  /* A beacon's state, read off the supports on the plate now and what the
     last build could not reach. */
  function statesFor(eff) {
    var holds = {};
    cardSupports(S.hostId).forEach(function (m) {
      var h = m.nsoSupport.holds || {};
      Object.keys(h).forEach(function (k) { holds[k] = h[k]; });
    });
    var un = memOf(S.hostId).unreach, lost = {}, out = {};
    Object.keys(un).forEach(function (r) { un[r].forEach(function (k) { lost[k] = true; }); });
    eff.beacons.forEach(function (b) { out[b.key] = b.off ? 'off' : holds[b.key] || (lost[b.key] ? 'unreachable' : 'planned'); });
    return out;
  }
  /* What one area is, over everything on the piece: HELD when every one of its
     spots is held from the plate or rests on the part; UNREACHABLE when the
     last build tried it and the plate could not reach at least one spot (an
     area with a lost spot is never counted held); UNSUPPORTED otherwise - left
     out, or something the planner skipped or a Remove took off. Each area is
     exactly one of the three, so the three counts add up to every area. */
  function areaKind(rg, st) {
    if (rg.excluded) return 'unsupported';
    var on = rg.beacons.filter(function (b) { return st[b.key] !== 'off'; });     // a spot that is off is not a tip
    if (on.some(function (b) { return st[b.key] === 'unreachable'; })) return 'unreachable';
    if (on.every(function (b) { return st[b.key] === 'held' || st[b.key] === 'rest'; })) return 'held';
    return 'unsupported';
  }
  /* areas: not left out (what GENERATE would build); left: left out; the
     rest are the BUILT line's three. */
  function areaStats(eff, st) {
    var out = { total: eff.regions.length, areas: 0, left: 0, held: 0, unsupported: 0, unreachable: 0,
      supports: cardSupports(S.hostId).length };
    eff.regions.forEach(function (rg) {
      if (rg.excluded) out.left++; else out.areas++;
      out[areaKind(rg, st)]++;
    });
    return out;
  }
  function builtLine(a) {
    return 'Built: ' + plural(a.supports, 'support', 'supports') + ' \u00b7 held ' + a.held +
      ' \u00b7 unsupported ' + a.unsupported + ' \u00b7 unreachable ' + a.unreachable;
  }
  function idleLine(a) {
    var m = modelOf(S.hostId), name = m ? m.name : 'the piece';
    if (S.mode === 'auto') {
      return plural(a.areas, 'hanging area', 'hanging areas') + ' at ' + S.angle + '\u00b0 on ' + name +
        (a.left ? ' \u00b7 ' + a.left + ' left out' : '') + blockedTail(S.eff);
    }
    var eff = S.eff, on = eff.beacons.filter(function (b) { return !b.off; }).length, off = eff.beacons.length - on, z = feedOf(m).zones.length;
    var tail = (off ? ' \u00b7 ' + off + ' off' : '') + (z ? ' \u00b7 ' + plural(z, 'circle', 'circles') : '') + blockedTail(eff);
    if (S.mode === 'custom') return (on ? plural(on, 'tip', 'tips') : 'No tips yet') + ' on ' + name + tail;
    return plural(on, 'spot', 'spots') + ' at ' + S.angle + '\u00b0 on ' + name + tail;
  }
  /* the spots the Supports Blockers hold, said where the card counts what it will build */
  function blockedTail(eff) { return eff && eff.blocked ? ' \u00b7 ' + plural(eff.blocked, 'spot', 'spots') + ' blocked' : ''; }
  var WHY = { unsupported: 'left out or skipped', unreachable: 'no route to the plate' };
  /* The rows under the BUILT line: every area that is not held, in order. */
  function rowsFor(eff, st) {
    var rows = [];
    eff.regions.forEach(function (rg) {
      var k = areaKind(rg, st);
      if (k === 'held') return;
      var why = k === 'unsupported' ? (rg.excluded ? 'left out' : 'not held') : WHY[k];
      rows.push({ area: rg.id, kind: k, why: why, spots: rg.beacons.length,
        text: 'Area ' + (rg.id + 1) + ' \u00b7 ' + k + ' \u00b7 ' + why + ' \u00b7 ' + plural(rg.beacons.length, 'spot', 'spots') });
    });
    return rows;
  }

  /* -------------------------------------------------------------- the plate */

  /* What the plate reads now: every piece the option was switched on for, each read by the piece's own code (effective,
     statesFor, areaStats - asHost points the card at it), and the sums. A piece is read only once the one before it has
     been (a big piece is read in a worker, one at a time); `pending` says one is still being measured. */
  function wideRead() {
    var out = { pieces: [], pending: false, totals: { pieces: 0, areas: 0, left: 0, blocked: 0, spots: 0, held: 0, unsupported: 0, unreachable: 0, supports: 0, built: 0 } };
    for (var i = 0; i < S.wideIds.length; i++) {
      var r = asHost(S.wideIds[i], wideReadOne);
      out.pieces.push(r);
      if (r.measuring) { out.pending = true; break; }
      var T = out.totals;
      T.pieces++; T.areas += r.a.areas; T.left += r.a.left; T.blocked += r.eff && r.eff.blocked || 0; T.spots += r.spots; T.held += r.a.held;
      T.unsupported += r.a.unsupported; T.unreachable += r.a.unreachable; T.supports += r.a.supports;
      if (r.a.supports) T.built++;
    }
    return out;
  }
  function wideReadOne() {
    var id = S.hostId, m = modelOf(id), eff = effective(), none = { areas: 0, left: 0, held: 0, unsupported: 0, unreachable: 0, total: 0, supports: 0 };
    if (eff.measuring) return { id: id, name: m ? m.name : '', measuring: true };
    var live = !eff.error && (eff.beacons.length || S.mode === 'custom');
    var st = live ? statesFor(eff) : {}, a = live ? areaStats(eff, st) : Object.assign({}, none, { supports: cardSupports(id).length });
    return { id: id, name: m ? m.name : 'the piece', eff: eff, st: st, a: a, error: eff.error || null, built: !!memOf(id).built,
      spots: eff.beacons.filter(function (b) { return !b.off; }).length };
  }
  /* The card's state on the plate: the single piece's own words ('measuring', 'nothing', 'building', 'built', 'idle'). */
  function wideState(W) {
    if (!W || W.pending) return 'measuring';
    if (!W.pieces.some(function (r) { return r.eff && r.eff.beacons.length; }) && S.mode !== 'custom') return 'nothing';
    if (S.busy) return 'building';
    return W.pieces.some(function (r) { return r.built; }) ? 'built' : 'idle';
  }
  function wideIdleLine(W) {
    var T = W.totals, what = S.mode === 'auto' ? plural(T.areas, 'hanging area', 'hanging areas')
      : S.mode === 'custom' ? plural(T.spots, 'tip', 'tips') : plural(T.spots, 'spot', 'spots');
    return plural(T.pieces, 'piece', 'pieces') + ' \u00b7 ' + what + ' at ' + S.angle + '\u00b0' + (T.left ? ' \u00b7 ' + T.left + ' left out' : '') + (T.blocked ? ' \u00b7 ' + plural(T.blocked, 'spot', 'spots') + ' blocked' : '');
  }
  function wideBuiltLine(W) {
    var T = W.totals;
    return 'Built: ' + plural(T.supports, 'support', 'supports') + ' on ' + plural(T.built, 'piece', 'pieces') +
      ' \u00b7 held ' + T.held + ' \u00b7 unsupported ' + T.unsupported + ' \u00b7 unreachable ' + T.unreachable;
  }
  /* The rows under the BUILT line: one for every piece that needs a look - nothing hangs on it, every area of it is left
     out, the planner refused it, or some of its areas are unsupported or unreachable. A click selects and frames it. */
  function wideRows(W) {
    var rows = [];
    (W ? W.pieces : []).forEach(function (r) {
      if (r.measuring) return;
      var why, kind = 'unsupported', note = S.wideNotes[r.id];
      if (r.error) why = 'could not read it: ' + r.error;
      else if (!r.eff.beacons.length) why = r.eff.blocked ? 'every spot is in a blocker' : S.mode === 'custom' ? 'no tips' : 'no hanging area';
      else if (!r.a.areas) why = 'every area left out';
      else if (note) why = note;
      else if (r.a.unreachable || r.a.unsupported) {
        kind = r.a.unreachable ? 'unreachable' : 'unsupported';
        why = (r.a.unreachable ? 'unreachable ' + r.a.unreachable : '') + (r.a.unreachable && r.a.unsupported ? ' \u00b7 ' : '') +
          (r.a.unsupported ? 'unsupported ' + r.a.unsupported : '');
      } else return;
      rows.push({ piece: r.id, kind: kind, why: why, text: r.name + ' \u00b7 ' + why });
    });
    return rows;
  }
  /* The option: shown while the card is open and two or more pieces stand on the plate. */
  function syncPlate() {
    var row = $('sup-plate-row'), box = $('sup-plate');
    if (row) row.hidden = !(S.open && (S.wide || realIds().length >= 2));
    if (box) { box.checked = !!S.wide; box.disabled = !!S.busy; }
  }

  /* ------------------------------------------------------------- drawing */

  function dispose(o) {
    if (!o) return;
    if (o.parent) o.parent.remove(o);
    o.traverse(function (x) {
      if (x.geometry) x.geometry.dispose();
      if (x.material) { if (x.material.map) x.material.map.dispose(); x.material.dispose(); }
    });
  }
  function overlay(o, order) {
    o.renderOrder = order; o.userData.skipXray = true; o.frustumCulled = false;
    return o;
  }

  function markSize() {
    var D = S.det, b = D ? boundsOf(D.soup) : null;
    var span = b ? Math.max(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]) : 40;
    return Math.max(0.5, Math.min(3, span * 0.025));
  }

  /*
   * One area's cells and outline. Each cell is a quad (Z up) with its face's
   * normal: a cell of the beacon grid (cell i = floor((x - origin) / pitch)),
   * lifted onto the plane through its beacon; a side spot (a wall's rib, no
   * plan footprint) is a pitch-wide square in the plane across its normal.
   * The outline is the edges of those cells that no other cell of the area
   * shares - the cells the detector marked, not a pad around the points.
   */
  function geometryOf(rg, eff) {
    var pitch = eff.pitch, ox = eff.origin[0], oy = eff.origin[1], seen = {}, count = {}, grid = [], cells = [], segs = [];
    /* THE AREA'S OWN OUTLINE (rg.fp, from the detector: docs/SUPPORT-FOOTPRINT.md): the edge of the surface the spots hold, traced on
       the piece, not the edges of the grid cells they were found in - a cell at the rim of a surface is mostly air, and its outline
       hung over the edge. A spot the footprint does not cover (a crease, a tip, a side spot, one placed by hand) keeps its cell. */
    var fp = rg.fp || null, planes = [];
    if (fp) {
      var surf = rg.beacons.filter(function (b) { return !b.manual && !b.tip && b.need && (b.need.kind === 'face' || b.need.kind === 'gap' || (b.need.kind === 'edge' && b.need.corner)); });
      if (surf.length) {
        surf.forEach(function (b) { planes.push({ p: [b.x, b.y, b.z], n: b.normal }); });
        fp.loops.forEach(function (L) {
          for (var q = 0; q < L.length; q++) {
            var a = L[q], e = L[(q + 1) % L.length], mx = (a[0] + e[0]) / 2, my = (a[1] + e[1]) / 2, nb = null, nd = Infinity;
            surf.forEach(function (b) { var d = Math.hypot(b.x - mx, b.y - my); if (d < nd) { nd = d; nb = b; } });
            var dx = e[0] - a[0], dy = e[1] - a[1], dl = Math.hypot(dx, dy) || 1;
            /* the surface lies on the left of travel: the ribbon is laid toward it */
            segs.push([a, e, nb.normal, [mx - dy / dl, my + dx / dl, (a[2] + e[2]) / 2]]);
          }
        });
      } else fp = null;
    }
    function ek(i0, j0, i1, j1) { return i0 < i1 || (i0 === i1 && j0 < j1) ? i0 + ',' + j0 + ',' + i1 + ',' + j1 : i1 + ',' + j1 + ',' + i0 + ',' + j0; }
    function lift(b, x, y) {
      var n = b.normal;
      return [x, y, b.z - (n[0] * (x - b.x) + n[1] * (y - b.y)) / n[2]];
    }
    function edgesOf(c) {
      return [[c.i, c.j, c.i + 1, c.j], [c.i + 1, c.j, c.i + 1, c.j + 1], [c.i + 1, c.j + 1, c.i, c.j + 1], [c.i, c.j + 1, c.i, c.j]];
    }
    rg.beacons.forEach(function (b) {
      var n = b.normal;
      if (fp && !b.manual && !b.tip && b.need && (b.need.kind === 'face' || b.need.kind === 'gap' || (b.need.kind === 'edge' && b.need.corner))) return;   // the outline above
      if (Math.abs(n[2]) < 0.3) {
        var u = Math.abs(n[2]) < 0.9 ? [-n[1], n[0], 0] : [1, 0, 0], L = Math.hypot(u[0], u[1], u[2]);
        u = [u[0] / L, u[1] / L, u[2] / L];
        var w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]], h = pitch / 2, q = [];
        [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (c) {
          q.push([b.x + (u[0] * c[0] + w[0] * c[1]) * h, b.y + (u[1] * c[0] + w[1] * c[1]) * h, b.z + (u[2] * c[0] + w[2] * c[1]) * h]);
        });
        cells.push({ quad: q, n: n });
        for (var k = 0; k < 4; k++) segs.push([q[k], q[(k + 1) % 4], n, [b.x, b.y, b.z]]);
        return;
      }
      var i = Math.floor((b.x - ox) / pitch), j = Math.floor((b.y - oy) / pitch), key = i + ',' + j;
      if (seen[key]) return;
      seen[key] = true;
      grid.push({ i: i, j: j, b: b });
    });
    grid.forEach(function (c) {
      edgesOf(c).forEach(function (e) { var k = ek(e[0], e[1], e[2], e[3]); count[k] = (count[k] || 0) + 1; });
    });
    grid.forEach(function (c) {
      var mid = lift(c.b, ox + (c.i + 0.5) * pitch, oy + (c.j + 0.5) * pitch);
      cells.push({ quad: [lift(c.b, ox + c.i * pitch, oy + c.j * pitch), lift(c.b, ox + (c.i + 1) * pitch, oy + c.j * pitch),
        lift(c.b, ox + (c.i + 1) * pitch, oy + (c.j + 1) * pitch), lift(c.b, ox + c.i * pitch, oy + (c.j + 1) * pitch)], n: c.b.normal });
      edgesOf(c).forEach(function (e) {
        if (count[ek(e[0], e[1], e[2], e[3])] !== 1) return;
        segs.push([lift(c.b, ox + e[0] * pitch, oy + e[1] * pitch), lift(c.b, ox + e[2] * pitch, oy + e[3] * pitch), c.b.normal, mid]);
      });
    });
    return { cells: cells, segs: segs, fp: fp, planes: planes };
  }
  /* is (x, y) inside a footprint: the loops' even-odd (an outer loop and a hole in it) */
  function inFootprint(fp, x, y) {
    var inn = false;
    fp.loops.forEach(function (L) {
      for (var q = 0, w = L.length - 1; q < L.length; w = q++) {
        if ((L[q][1] > y) !== (L[w][1] > y) && x < (L[w][0] - L[q][0]) * (y - L[q][1]) / (L[w][1] - L[q][1]) + L[q][0]) inn = !inn;
      }
    });
    return inn;
  }

  /* Segments as thin ribbons lying on the surface (a 1 px line would vanish
     at any distance): each a quad along the segment, in the plane of the face,
     on the inside of the area's boundary so it does not hide under the part's
     own edge line. */
  function ribbons(segs, width, lift) {
    var pos = new Float32Array(segs.length * 18), o = 0;
    segs.forEach(function (sg) {
      var p = sg[0], q = sg[1], n = sg[2];
      var d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], L = Math.hypot(d[0], d[1], d[2]) || 1;
      d = [d[0] / L, d[1] / L, d[2] / L];
      var s = [n[1] * d[2] - n[2] * d[1], n[2] * d[0] - n[0] * d[2], n[0] * d[1] - n[1] * d[0]];
      var c = sg[3], to = [c[0] - p[0], c[1] - p[1], c[2] - p[2]];
      if (s[0] * to[0] + s[1] * to[1] + s[2] * to[2] < 0) s = [-s[0], -s[1], -s[2]];
      var v = [[p, 0], [q, 0], [q, 1], [p, 0], [q, 1], [p, 1]];
      v.forEach(function (e) {
        var u = upToView([e[0][0] + s[0] * width * e[1] + n[0] * lift, e[0][1] + s[1] * width * e[1] + n[1] * lift, e[0][2] + s[2] * width * e[1] + n[2] * lift]);
        pos[o++] = u.x; pos[o++] = u.y; pos[o++] = u.z;
      });
    });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return g;
  }

  function draw() { drawAreas(); drawPaint(); }
  function drawAreas() {
    dispose(S.layer); S.layer = null; S.geo = null;
    dispose(S.pts); S.pts = null; dispose(S.zoneLayer); S.zoneLayer = null; dispose(S.eraseLayer); S.eraseLayer = null; S.hot = null;
    if (!S.open || S.hostId == null || !state.scene) return;
    var eff = S.eff;
    if (S.mode !== 'auto') { if (eff && !eff.error) drawMarkers(eff); return; }    // a fed card has points, not outlined areas
    if (!eff || !eff.regions.length) return;
    var st = statesFor(eff), g = new THREE.Group(), width = markSize() * 0.6;
    g.name = 'supportsCardOverlay';
    S.geo = {};
    eff.regions.forEach(function (rg) {
      var geo = S.geo[rg.id] = geometryOf(rg, eff);
      var red = !rg.excluded && memOf(S.hostId).built &&
        rg.beacons.some(function (b) { return st[b.key] === 'unreachable'; });
      var kind = rg.excluded ? 'off' : red ? 'red' : 'on';
      var m = overlay(new THREE.Mesh(ribbons(geo.segs, width, 0.06), new THREE.MeshBasicMaterial({
        color: OUTLINE[kind], side: THREE.DoubleSide, transparent: true, opacity: OUTLINE_ALPHA[kind],
        depthWrite: false, depthTest: false })), ORDER);
      m.userData.area = rg.id; m.userData.outline = kind; m.userData.cells = rg.beacons.length;
      g.add(m);
    });
    state.scene.add(g);
    S.layer = g;
  }

  /* --------------------------------------------------------------- words */

  /* The card's state: 'pick' (no piece picked), 'error' (detection refused),
     'nothing' (the piece has no beacons: NOTHING, where the count sits, and
     nothing that would build is live), then the workflow's own three: 'idle'
     (areas outlined, nothing built), 'building', 'built'. */
  function cardState() {
    if (S.hostId == null || !placedOf(S.hostId) || !S.eff) return 'pick';
    if (S.eff.error) return 'error';
    if (S.eff.measuring) return 'measuring';
    if (!S.eff.beacons.length && S.mode !== 'custom') return 'nothing';     // Custom starts empty: the tips are the input
    if (S.busy) return 'building';
    return memOf(S.hostId).built ? 'built' : 'idle';
  }

  /* What a build says when the planner has told it nothing (a planner set
     with setPlanner that does not report): "Building\u2026", and the seconds once
     it has run past ELAPSED_FROM_MS. */
  function buildingLine() {
    return S.elapsed * 1000 >= ELAPSED_FROM_MS ? 'Building\u2026 ' + S.elapsed + ' s' : 'Building\u2026';
  }
  /* The build's percent, from where the phase that is counting stands: its
     share of the bar (PHASE_SPAN) filled by done / total, to the nearest
     whole number - but 100 only when the last phase's work is done (1999 of
     2000 is 99) - and null when there is no count: a phase that has none
     shows its word and the seconds instead. */
  function percentOf(pg) {
    if (!pg || pg.done == null || !(pg.total > 0) || !PHASE_SPAN[pg.phase]) return null;
    var sp = PHASE_SPAN[pg.phase], f = Math.min(1, pg.done / pg.total);
    if (f >= 1 && sp[1] >= 100) return 100;
    return Math.min(99, Math.round(sp[0] + (sp[1] - sp[0]) * f));
  }
  /* The percent the bar shows: the phase's (percentOf) for one piece; for the plate, the share of the plate the pieces
     before this one are (S.run.from, by spots) plus this piece's own percent of its share (S.run.span). Never down: a
     piece starts where the last ended. 100 only when the last piece's last unit is done. */
  function percentNow() {
    var run = S.run, own = percentOf(S.prog);
    if (!run) return own;
    var f = run.from + run.span * (own == null ? 0 : own / 100);
    if (own === 100 && run.k === run.n) return 100;
    return Math.min(99, Math.round(f * 100));
  }
  /* "Planning 142 / 344 \u00b7 21 %", or "Detecting \u00b7 0 s" for a phase with no
     count. The seconds are the build's own. For the plate it begins "Piece 2 of 6 \u00b7 ": the counts are the piece's,
     the percent is the plate's. */
  function progressLine() {
    var pg = S.prog, run = S.run, pre = run ? 'Piece ' + run.k + ' of ' + run.n + ' \u00b7 ' : '';
    if (!pg) return pre + buildingLine();
    var word = PHASE_WORD[pg.phase];
    return pre + (percentOf(pg) == null ? word + ' \u00b7 ' + S.elapsed + ' s'
      : word + ' ' + pg.done + ' / ' + pg.total + ' \u00b7 ' + percentNow() + ' %');
  }
  /* The one bar, under the readout: shown while a build runs, filled to the
     phase's percent, or sweeping when the phase has no count. The readout and
     the bottom-right status say the same words as the bar. */
  function paintBar() {
    var bar = $('sup-progress'), fill = bar && bar.firstElementChild, on = !!(S.open && S.busy);
    if (bar) {
      bar.hidden = !on;
      if (on) {
        var pc = S.run ? percentNow() : percentOf(S.prog), line = progressLine();
        bar.classList.toggle('is-indeterminate', pc == null);
        bar.dataset.phase = S.prog ? S.prog.phase : '';
        if (pc == null) bar.removeAttribute('aria-valuenow'); else bar.setAttribute('aria-valuenow', String(pc));
        bar.setAttribute('aria-valuetext', line);
        if (fill) fill.style.width = pc == null ? '' : pc + '%';
      }
    }
    if (S.busy) {
      var line2 = progressLine(), head = $('sup-count');
      if (head && head.textContent !== line2) head.textContent = line2;
      if (S.said !== line2 && typeof setStatus === 'function') { S.said = line2; setStatus(line2, false); }
    }
  }
  /* The status line is the app's, and a build is done with it: clear it if it still
     says what the build last put there. */
  function unsay() {
    var el = $('status');
    if (S.said != null && el && el.textContent === S.said && typeof setStatus === 'function') setStatus('', false);
    S.said = null;
  }

  function sync() {
    var head = $('sup-count'), card = $('supports-card'), wide = S.wide, W = wide ? S.wideView : null;
    var hasHost = !wide && S.hostId != null && !!placedOf(S.hostId);
    var eff = S.eff, text, bad = false, cs = wide ? wideState(W) : cardState(), a = null, st = null;
    if (hasHost && eff && !eff.error && (eff.beacons.length || S.mode === 'custom')) { st = statesFor(eff); a = areaStats(eff, st); }
    if (card) { card.dataset.mode = S.mode; card.dataset.tool = S.tool; card.dataset.state = cs; card.dataset.stale = hasHost && cs === 'built' && tuneStale() ? '1' : '0'; card.dataset.plate = wide ? '1' : '0'; card.classList.toggle('is-locked', !!S.busy); }
    document.body.classList.toggle('sup-card-open', !!S.open);
    if (S.msg) { text = S.msg.text; bad = !!S.msg.bad; }
    else if (cs === 'pick') text = 'Click a piece to see where it needs holding.';
    else if (cs === 'error') { text = eff.error; bad = true; }
    else if (cs === 'measuring') text = 'measuring\u2026';
    else if (cs === 'nothing') text = eff && eff.blocked ? ALL_BLOCKED : NOTHING;
    else if (cs === 'building') text = progressLine();
    else if (cs === 'built') text = wide ? wideBuiltLine(W) : builtLine(a);
    else text = wide ? wideIdleLine(W) : idleLine(a);
    var stale = hasHost && cs === 'built' && tuneStale();
    if (stale && !S.msg) text += ' \u00b7 out of date: Tune has changed';
    if (head) { head.textContent = text; head.classList.toggle('is-bad', bad); head.classList.toggle('is-stale', stale); }
    var en = function (id, on) { var e = $(id); if (e) e.disabled = !on || !!S.busy || SL.busy; };
    var go = $('btn-sup-all');
    if (go) { go.textContent = cs === 'building' ? buildingLine() : cs === 'built' ? 'Regenerate' : 'Generate'; go.classList.toggle('is-stale', stale); }
    en('btn-sup-all', (cs === 'idle' || cs === 'built') && (wide ? !!(W && W.totals.areas > 0) : a && a.areas > 0));
    var none = $('btn-sup-none'), rm = $('btn-sup-remove');
    var wasBuilt = hasHost && memOf(S.hostId).built && (cs === 'built' || cs === 'building');
    if (none) none.hidden = !wasBuilt;          // REMOVE ALL and REMOVE stay per piece: not on the plate's card
    if (rm) rm.hidden = !wasBuilt;
    en('btn-sup-none', cs === 'built' && !wide);
    en('btn-sup-remove', cs === 'built' && !wide && S.selSupport != null && !!modelOf(S.selSupport));
    ['sup-angle', 'sup-style', 'sup-size', 'sup-rest', 'sup-one', 'sup-interface', 'sup-brim', 'sup-raft'].forEach(function (id) { var e = $(id); if (e) e.disabled = !!S.busy; });
    var note = $('sup-angle-note');
    if (note) note.textContent = S.angle + '\u00b0 \u00b7 Bambu ' + BAMBU_ANGLE + '\u00b0';
    var ang = $('sup-angle');
    if (ang && document.activeElement !== ang && ang.value !== String(S.angle)) ang.value = String(S.angle);
    drawRows(cs === 'built' ? (wide ? wideRows(W) : st ? rowsFor(eff, st) : []) : []);
    syncSlice();
    syncSwitch(cs);
    syncTune(cs, stale);
    syncPlate();
    paintBar();
  }

  /* TUNE: shown in Custom only (hidden, not emptied: the values stay for when it
     comes back, and so does whether it was open). The note under the fields
     says what is true now - a field that is not a number, a build that is out of
     date - and the summary counts the fields that are not at their default. */
  function syncTune(cs, stale) {
    var sec = $('sup-tune');
    if (!sec) return;
    sec.hidden = S.mode !== 'custom';
    KNOBS.forEach(function (K) {
      var e = $(K.id);
      if (!e) return;
      e.disabled = !!S.busy;
      e.classList.toggle('is-bad', !knobOk(K, knobValue(K)));
      e.setAttribute('aria-invalid', knobOk(K, knobValue(K)) ? 'false' : 'true');
    });
    var n = knobsChanged(), bad = knobBad(), note = $('sup-tune-note'), cnt = $('sup-tune-count'), df = $('sup-tune-defaults');
    if (cnt) cnt.textContent = n ? n + ' changed' : '';
    if (note) {
      note.textContent = bad || (stale ? 'Changed since the last build. Regenerate to build with it.' : n && cs !== 'built' ? 'Generate builds with these.' : '');
      note.classList.toggle('is-bad', !!bad);
      note.classList.toggle('is-stale', !bad && !!stale);
    }
    if (df) df.disabled = !!S.busy || !n;
  }

  /* THE SWITCH AND THE TOOLS. Auto \u00b7 Assisted \u00b7 Custom; under it, in the two
     fed modes, the tool that holds the pointer: TIPS (the points on the piece),
     CIRCLES (draw on the plate) or ERASE (after a build). One at a time; the
     hint under the card says what the one that is on does. */
  var HINT = {
    assisted: 'Click a point to turn it off, or on. Shift-click the piece to add a spot. Then Circles: where the supports may land.',
    custom: 'Click the underside of the piece to place a tip; click a tip to take it away. Then Circles: where the supports may land.',
    circles: 'Drawing circles on the plate: drag to draw one, drag its edge to resize, drag inside to move, click one then Delete to remove it. Stop (Esc) to orbit.',
    erase: 'Erasing: hover a built member to light it and what it holds; click to remove it. Stop (Esc) to go on.',
    plate: 'Every piece is lit. Generate builds supports for all of them in one go; one Undo takes them all back. Click a piece to work on it alone.',
    paint: 'Painting: drag over the piece where supports are missing - each stroke asks for tips and a raft right under it, one Undo each. Orbit by dragging off the piece, or with Alt held; press Paint again (or Esc) to put the brush down.'
  };
  function syncSwitch(cs) {
    var fed = S.mode !== 'auto', hasHost = S.hostId != null && !!placedOf(S.hostId);
    Object.keys(MODES).forEach(function (k) {
      var b = $('sup-mode-' + k);
      if (b) { b.classList.toggle('is-on', S.mode === k); b.setAttribute('aria-pressed', S.mode === k ? 'true' : 'false'); b.disabled = !!S.busy; }
    });
    var tools = $('sup-tools');
    if (tools) tools.hidden = !fed || S.wide;                    // the tools work on one piece's points: not on the plate
    var canErase = fed && hasHost && eraseReady();
    Object.keys(TOOLS).forEach(function (k) {
      var b = $('sup-tool-' + k);
      if (!b) return;
      b.classList.toggle('is-on', S.tool === k);
      b.setAttribute('aria-pressed', S.tool === k ? 'true' : 'false');
      b.disabled = !!S.busy || !hasHost || (k === 'erase' && !canErase);
    });
    var hint = $('sup-hint');
    if (hint) {
      if (hint.dataset.auto == null) hint.dataset.auto = hint.textContent;
      hint.textContent = S.wide ? HINT.plate : S.paint ? HINT.paint : !fed ? hint.dataset.auto : S.tool === 'tips' ? HINT[S.mode] : HINT[S.tool];
    }
    var pb = $('sup-paint'), pc = $('sup-paint-clear'), pr = $('sup-paint-row');
    if (pr) pr.hidden = !!S.wide || !S.open;
    if (pb) { pb.classList.toggle('is-on', !!S.paint); pb.setAttribute('aria-pressed', S.paint ? 'true' : 'false'); pb.disabled = !!S.busy || !hasHost || !!S.wide; }
    if (pc) pc.disabled = !!S.busy || !hasHost || !paintCount();
    var pbr = $('sup-brush'); if (pbr) pbr.disabled = !!S.busy;
    paintCursor();
  }
  function paintCursor() {
    var cv = state.renderer && state.renderer.domElement;
    if (!cv) return;
    var want = !S.open ? '' : S.paint ? 'crosshair' : S.mode === 'auto' ? '' : S.tool === 'circles' ? 'crosshair' : (S.tool === 'erase' && S.hover) || (S.tool === 'tips' && S.hot != null) ? 'pointer' : '';
    if (want || S.cursorSet) { cv.style.cursor = want; S.cursorSet = !!want; }
  }

  /* The short list under the readout: one row for every area that is not
     held. Rebuilt only when it changes, so a click on a row is not eaten by a
     redraw between the press and the release. */
  function drawRows(rows) {
    var ul = $('sup-rows');
    if (!ul) return;
    var key = JSON.stringify(rows.map(function (r) { return [r.piece == null ? r.area : 'p' + r.piece, r.kind, r.why, r.text]; }));
    ul.hidden = !rows.length;
    if (ul.dataset.key === key) return;
    ul.dataset.key = key;
    ul.textContent = '';
    rows.forEach(function (r) {
      var li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.className = 'sup-row sup-row-' + r.kind;
      b.textContent = r.text;
      if (r.piece != null) {
        b.dataset.piece = String(r.piece);
        b.title = 'Select this piece and frame it';
        b.addEventListener('click', function () { pickAndFrame(r.piece); });
      } else {
        b.dataset.area = String(r.area);
        b.title = 'Frame this area';
        b.addEventListener('click', function () { frameArea(r.area); });
      }
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  /* Bring an area to the middle of the view: the camera keeps the way it is
     looking and moves in until the area fills a good part of it. */
  function frameArea(rid) {
    var rg = S.eff && S.eff.regions.find(function (r) { return r.id === rid; });
    var cam = state.camera, ctl = state.controls;
    if (!rg || !cam || !ctl) return { ok: false, reason: 'no such area' };
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    rg.beacons.forEach(function (b) { pt(b).forEach(function (v, k) { lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v); }); });
    var c = [0, 1, 2].map(function (k) { return (lo[k] + hi[k]) / 2; });
    var r = Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 + S.eff.pitch, S.eff.pitch * 1.5);
    var f = frameView(c, r);
    return { ok: true, area: rid, dist: f.dist, radius: r };
  }
  /* The camera keeps the way it is looking and moves in until a sphere (centre c, Z up; radius r) fills a good part of it. */
  function frameView(c, r) {
    var cam = state.camera, ctl = state.controls;
    var target = upToView(c), dir = cam.position.clone().sub(ctl.target);
    if (dir.lengthSq() < 1e-9) dir.set(0, 0.5, 1);
    dir.normalize();
    var half = Math.min(cam.fov || 45, 90) * Math.PI / 360;
    var d = Math.max(r / Math.sin(half) * 1.15, 8);
    ctl.target.copy(target);
    cam.position.copy(target).addScaledVector(dir, d);
    cam.updateProjectionMatrix();
    ctl.update();
    cam.updateMatrixWorld();
    return { dist: d };
  }
  /* A piece to the middle of the view (its row on the plate's card): the sphere round its world box. */
  function framePiece(id) {
    var p = placedOf(id), cam = state.camera, ctl = state.controls;
    if (!p || !cam || !ctl) return { ok: false, reason: 'no such piece' };
    var b = boundsOf(occluderSoup(p)), c = [0, 1, 2].map(function (k) { return (b.lo[k] + b.hi[k]) / 2; });
    var r = Math.max(Math.hypot(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]) / 2, 5);
    var f = frameView(c, r);
    return { ok: true, piece: id, dist: f.dist, radius: r };
  }
  /* A row on the plate's card: the piece is picked (the plate option goes off, the card is on that piece, as if it were
     clicked) and framed. */
  function pickAndFrame(id) {
    var r = pick(id);
    if (r && r.ok) framePiece(id);
    return r;
  }

  /* Recompute what the piece shows, redraw, and say it. On the plate: what each piece shows, summed. */
  function refresh() {
    if (S.wide) {
      S.wideView = wideRead();
      draw();                                // the host is none: nothing of any one piece is drawn - the lit pieces are the picture
      sync();
      S.sig = signature();
      return;
    }
    S.eff = S.hostId != null && placedOf(S.hostId) ? effective() : null;
    draw();
    sync();
    S.sig = signature();
  }

  /* What the card shows is a function of this: when it changes, refresh() runs (tick). */
  function signature() {
    if (S.wide) return S.open ? 'plate|' + S.wideIds.map(function (id) { return asHost(id, hostSignature); }).join('#') + '|' + S.angle + '|' + S.mode : '';
    return hostSignature();
  }
  function hostSignature() {
    if (!S.open) return '';
    if (S.hostId == null) return 'none|' + realIds().join(',');     // a piece added or taken off changes whether the plate option is offered
    var p = placedOf(S.hostId), m = modelOf(S.hostId);
    if (!p || !m) return 'gone';
    return poseKey(p) + '|' + others(S.hostId).map(function (q) { return q.sourceId + ':' + q.mesh.position.toArray().join(','); }).join(';') +
      '|' + supportsOf(S.hostId).map(function (q) { return q.id; }).join(',') + '|' + editsOf(m).ops.length +
      '|' + JSON.stringify(memOf(S.hostId).unreach).length + '|' + memOf(S.hostId).built + '|' + ((typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0) +
      '|' + S.angle + '|' + S.mode + '|' + (m.nsoSupportFeed ? JSON.stringify(m.nsoSupportFeed).length : 0) + '|' + boxesKey();
  }

  /* ------------------------------------------------------------- picking */

  function pick(id) {
    S.msg = null;
    if (id == null) { S.hostId = null; S.selSupport = null; refresh(); return { ok: false }; }
    if (isSupport(id)) {
      S.msg = { text: 'That\'s a support; pick the piece it holds.', bad: true };
      sync();
      return { ok: false, reason: 'support' };
    }
    if (S.wide) setWide(false);                                  // a piece picked: the plate option is over, the card is on that piece
    if (S.hostId !== id) { S.det = null; S.selSupport = null; }
    S.hostId = id;
    var idx = state.placed.findIndex(function (q) { return q && q.sourceId === id; });
    if (idx >= 0 && typeof selectPlaced === 'function') selectPlaced(idx);
    refresh();
    return { ok: true, beacons: S.eff.beacons.length, regions: S.eff.regions.length };
  }

  function selectSupport(id) {
    var m = modelOf(id);
    if (!m || !m.nsoSupport || m.nsoSupport.hostSourceId !== S.hostId) return pick(id);
    S.msg = null;
    S.selSupport = id;
    var idx = state.placed.findIndex(function (q) { return q && q.sourceId === id; });
    if (idx >= 0 && typeof selectPlaced === 'function') selectPlaced(idx);
    sync();
    return { ok: true, id: id };
  }

  /* ------------------------------------------------------------ building */

  function cardOpts() {
    var st = $('sup-style'), sz = $('sup-size'), rs = $('sup-rest');
    var style = st && STYLES[st.value] ? st.value : 'tree';
    var size = sz ? parseFloat(sz.value) : NaN;
    var one = $('sup-one'), it = $('sup-interface'), br = $('sup-brim'), rf = $('sup-raft');
    return { brim: !br || !!br.checked, raft: !rf || !!rf.checked, style: style, sideMm: isFinite(size) ? size : null, rest: !!(rs && rs.checked), knobs: S.mode === 'custom' ? knobsGiven() : null,
      one: !one || !!one.checked, dense: !it || it.value !== 'open' };
  }

  /* THE PLANNER'S THREAD. planTree is one synchronous call that can run for
     minutes on a big piece (measured: 289 s for the 377 spots under
     library/v9_mirror_factory.stl), and a thread that is inside it cannot
     repaint, count seconds or fire a watchdog. So a build plans in a worker
     that loads the same engine files, and a watchdog on the page can really
     stop it: terminate() ends the call. The plan crosses back as plain data and
     the union (NSO_unionSoups, wasm) stays here, on the page. A page that
     cannot start a worker plans in-thread and can only be held to the clock
     after the fact. `planner` (setPlanner) replaces all of it: the seam a test
     forces a slow or a failing planner through. */
  function engineUrls() {
    var out = [];
    for (var i = 0; i < ENGINE.length; i++) {
      var el = document.querySelector('script[src^="' + ENGINE[i] + '"]');
      if (!el || !el.src) return null;
      out.push(el.src);
    }
    return out;
  }
  function startWorker() {
    var urls = engineUrls();
    if (!urls || typeof Worker !== 'function' || typeof Blob !== 'function' || !window.URL || !URL.createObjectURL) return null;
    var code = 'importScripts(' + urls.map(function (u) { return JSON.stringify(u); }).join(',') + ');\n' +
      'self.onmessage = function (e) {\n' +
      '  var d = e.data, plan;\n' +
      '  d.opts.onProgress = function (m) { self.postMessage({ id: d.id, progress: m, at: Date.now() }); };\n' +
      '  if (d.soup) self.soup = d.soup;\n' +     // the piece comes once per build: the same array is indexed once, not once an area
      '  if (d.plan) {\n' +                       // a plan built: its parts swept (NSO_SupportGridpack.parts), handed back as shells
      '    if (d.plan.rawTris === null) d.plan.rawTris = self.soup;\n' +
      '    var GP = self.NSO_SupportGridpack;\n' +
      '    GP.parts(d.plan, d.opts).then(function (tp) { self.postMessage({ id: d.id, built: tp && tp.ok ? GP.shells(d.plan, tp) : tp }); },\n' +
      '      function (err) { self.postMessage({ id: d.id, error: (err && err.message) || String(err) }); });\n' +
      '    return;\n' +
      '  }\n' +
      '  try { plan = self.NSO_SupportTree.planTree(self.soup, d.opts); } catch (err) {\n' +
      '    self.postMessage({ id: d.id, error: (err && err.message) || String(err) }); return; }\n' +
      '  if (plan && plan.rawTris) plan.rawTris = null;\n' +     // the page has the piece; parts() below puts it back from self.soup
      '  try { self.postMessage({ id: d.id, plan: plan }); } catch (err) {\n' +
      '    self.postMessage({ id: d.id, error: "the plan could not be passed back: " + ((err && err.message) || String(err)) }); }\n' +
      '};\n';
    var url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), w;
    try { w = new Worker(url); } catch (err) { URL.revokeObjectURL(url); return null; }
    return { w: w, url: url };
  }
  function stopWorker(job) {
    if (!job || !job.worker) return;
    try { job.worker.w.terminate(); } catch (e) { /* already gone */ }
    try { URL.revokeObjectURL(job.worker.url); } catch (e) { /* ditto */ }
    job.worker = null;
  }
  /* planTree(soup, opts) -> Promise of the plan, on the job's worker. The
     planner's progress, { phase, done, total }, comes back to onProgress as it
     is posted, with the time (ms since the epoch) the worker posted it; a
     planner set with setPlanner gets it as opts.onProgress too. */
  function planAway(job, soup, opts, onProgress) {
    if (S.planner) return Promise.resolve().then(function () { return S.planner(soup, Object.assign({}, opts, { onProgress: onProgress })); });
    if (job.worker === undefined) job.worker = startWorker();
    if (!job.worker) {
      return new Promise(function (go) { setTimeout(go, 0); }).then(function () {
        return window.NSO_SupportTree.planTree(soup, Object.assign({}, opts, { onProgress: onProgress }));
      });
    }
    return new Promise(function (resolve, reject) {
      var w = job.worker.w, id = ++job.seq;
      w.onmessage = function (e) {
        if (e.data.id !== id) return;
        if (e.data.progress) { if (onProgress) onProgress(e.data.progress, e.data.at); return; }
        if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.plan);
      };
      w.onerror = function (e) { reject(new Error((e && e.message) || 'the planner stopped')); };
      /* The piece goes over once. Every area is planned against the same
         array, whose spatial index the planner then finds again: a fresh copy
         per area was indexed afresh each time (about 0.4 s of 49k triangles). */
      w.postMessage({ id: id, soup: job.sentSoup ? null : soup, opts: opts });
      job.sentSoup = true;
    });
  }
  /* A plan BUILT, on the job's worker too, so that stretch of work is off
     the page as well: its parts swept (NSO_SupportGridpack.parts) and handed
     back as shells (.shells) - solid()'s answer, { ok, solids, reason }, with
     no weld. Without a worker it is swept here, a trunk at a time, with a
     turn for the page between (yieldFn). Progress comes back to onProgress
     as it is posted. */
  function buildAway(job, plan, onProgress, yieldFn) {
    if (job.worker === undefined) job.worker = startWorker();
    var GP = window.NSO_SupportGridpack;
    if (!job.worker) {
      return GP.parts(plan, Object.assign({ onProgress: onProgress, yieldFn: yieldFn }, job.parts || PARTS_OPTS)).then(function (tp) {
        return tp && tp.ok ? GP.shells(plan, tp) : tp;
      });
    }
    return new Promise(function (resolve, reject) {
      var w = job.worker.w, id = ++job.seq;
      w.onmessage = function (e) {
        if (e.data.id !== id) return;
        if (e.data.progress) { if (onProgress) onProgress(e.data.progress, e.data.at); return; }
        if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.built);
      };
      w.onerror = function (e) { reject(new Error((e && e.message) || 'the planner stopped')); };
      /* A plan from the worker comes back without the piece (rawTris null), and the worker puts its own copy back. */
      w.postMessage({ id: id, plan: plan, opts: Object.assign({}, job.parts || PARTS_OPTS) });
    });
  }

  /* ONE TRUNK ACROSS SMALL AREAS. Bambu stands one trunk under a head whose underside it finds in pieces (a flat rim round a
     cavity is three or four little areas): so Auto with one trunk plans areas together while the planner says one trunk can
     feed them (NSO_SupportGridpack.oneTrunkGroups, docs/SUPPORT-ONE-TRUNK.md). Each area still has its own answer, outline and
     status; the group's support is the first area's. */
  function groupAreas(regs, o) {
    var GP = window.NSO_SupportGridpack;
    if (!oneTrunkOn(o) || !GP || typeof GP.oneTrunkGroups !== 'function') return regs.map(function (r) { return [r]; });
    var groups = GP.oneTrunkGroups(regs.map(function (r) { return { id: r.id, pts: r.beacons.filter(function (b) { return !b.off; }) }; }));
    return groups.map(function (g) { return g.map(function (i) { return regs[i]; }); });
  }
  /* One area through the planner: the PLANNING step. Resolves { result } when
     there is nothing to build (the planner refused it, or put every spot
     inside the piece), else { rid, t, keyOf, landingOf, unreach } - the plan,
     for building to take up. */
  /* The planner's feed for one area (opts.feed, docs/SUPPORT-GRIDPACK.md
     section 7); null in Auto, which sends none. Assisted hands the area's
     spots over as it always has and names the ones turned off; Custom hands
     over the area's tips alone. Both carry the circles and the erasures. */
  function feedFor(m, beacons, rid, knobs) {
    if (S.mode === 'auto') return null;
    var F = feedOf(m), feed = { mode: S.mode, landingZones: F.zones.map(function (z) { return { x: z.x, y: z.y, r: z.r }; }), excluded: F.erased.slice() };
    if (S.mode === 'custom') {
      feed.tips = beacons.filter(function (b) { return !b.off; }).map(function (b) { return { x: b.x, y: b.y, z: b.z, key: b.key, regionId: rid }; });
      if (knobs) feed.knobs = Object.assign({}, knobs);       // Tune: only the fields that are not at their default
    } else {
      feed.beaconsOff = beacons.filter(function (b) { return b.off && !b.erased; }).map(function (b) { return b.id; });
    }
    return feed;
  }
  function planArea(job, D, rid, beacons, o, onProgress, feed, legacy) {
    var bs = beacons.map(function (b) { return { x: b.x, y: b.y, z: b.z, normal: b.normal, regionId: b.rid != null ? b.rid : rid, key: b.key }; });
    var opts = Object.assign({}, D.opts, { beacons: bs, style: o.style, restOnModel: o.rest });
    if (boxesNow().length) opts.occluders = occludersOf(D);       // a Supports Blocker is an obstacle, as another piece is
    /* AUTO builds as Bambu's tree slim does: ONE trunk to a cluster of tips (nso_support_gridpack.js planOneTrunk,
       docs/SUPPORT-ONE-TRUNK.md). Straight struts are one post a spot by definition, the gecko hand is the lattice's, and a support
       that may rest on the part has legs the one-trunk crown does not make (it stands on the plate only): with "may rest" the one-trunk
       build runs first, and the spots it could not reach (legacy) are planned again alone, with the lattice that may rest on the part. */
    if (!feed && !legacy && oneTrunkOn(o)) opts.oneTrunk = true;
    if (feed) opts.feed = feed;
    if (feed && feed.mode === 'custom') delete opts.beacons;         // Custom plans its tips alone: no beacon list goes with them
    if (o.sideMm != null) opts.sideMm = o.sideMm;
    return planAway(job, D.soup, opts, onProgress).then(function (t) {
      if (!t || typeof t !== 'object') throw new Error('the planner gave no plan');
      var keyOf = function (id) { return t.beacons && t.beacons[id] ? t.beacons[id].key : null; };
      /* every tip of the area left out (the eraser took the last one): nothing to build, and nothing wrong */
      if (!t.ok && feed && /^no tips to plan/.test(t.reason || '')) return { result: { ok: true, rid: rid, solids: [], unreachable: [], members: [], zonesEmpty: null } };
      if (!t.ok) {
        var all = t.inside && t.inside.length ? beacons.map(function (b) { return b.key; }) : [];
        return { result: { ok: !!all.length, rid: rid, solids: [], unreachable: all, reason: t.reason } };
      }
      var landingOf = {};
      t.trunks.forEach(function (tr) { tr.beacons.forEach(function (id) { landingOf[id] = tr.landing; }); });
      return { rid: rid, t: t, keyOf: keyOf, landingOf: landingOf, unreach: t.unreachable.concat(t.inside).map(keyOf) };
    });
  }
  /* The area's answer, from its plan and what building made of it: { ok, rid,
     solids, unreachable, reason }, each solid { soup, keys, holds, landing }
     in the planner's own words - nothing is aimed or moved here. */
  function areaResult(a, u) {
    if (!u.ok) return { ok: false, rid: a.rid, solids: [], unreachable: [], reason: u.reason };
    var solids = u.solids.map(function (x) {
      var holds = {};
      x.beacons.forEach(function (id) { holds[a.keyOf(id)] = a.landingOf[id] === 'rest' ? 'rest' : 'held'; });
      return { soup: x.soup, keys: x.beacons.map(a.keyOf), holds: holds, landing: x.landing, regionIds: x.regionIds, feet: x.feet };
    });
    /* ONE TRUNK: a spot the planner thinned away is held through the tip it lies beside (plan.oneTrunk.covered), and is said held
       with that tip's own landing - it is part of the same support */
    ((a.t.oneTrunk && a.t.oneTrunk.covered) || []).forEach(function (cv) {
      solids.forEach(function (sd) {
        if (sd.holds[cv.byKey] && !sd.holds[cv.key]) { sd.holds[cv.key] = sd.holds[cv.byKey]; sd.keys.push(cv.key); }
      });
    });
    /* ...and a spot on the plate's first layers (the low edge of a tipped part) is held by the plate: said held, with the first support */
    ((a.t.oneTrunk && a.t.oneTrunk.onPlate) || []).forEach(function (op) {
      if (solids.length && !solids[0].holds[op.key]) { solids[0].holds[op.key] = 'held'; solids[0].keys.push(op.key); }
    });
    return { ok: true, rid: a.rid, solids: solids, unreachable: a.unreach, sideMm: a.t.sideMm, plateZ: a.t.plateZ, reason: a.t.reason,
      members: u.members || [], zonesEmpty: a.t.zonesEmpty || null };
  }

  /* THE FEET, over every area at once (nso_support_gridpack.js shareFeet,
     docs/SUPPORT-GRIDPACK.md "Feet"): each area was built with its trunks on
     their feet and no pad; here one pad is drawn under every group of feet,
     whatever area they hold up, and the supports that stand on one pad
     become ONE support - two supports whose first layers overlapped were the
     path conflict Bambu Studio reported on the 2026-10-20 print. The joined
     support is the first area's that holds it, and carries every spot it
     holds. A result with no feet to share (a planner seam, a support resting
     on the part) passes through as it was. */
  function shareFeet(results, D) {
    var GP = window.NSO_SupportGridpack, live = results.filter(function (r) { return r.ok && r.solids.length; });
    if (!GP || typeof GP.shareFeet !== 'function' || !live.some(function (r) { return r.solids.some(function (x) { return x.feet && x.feet.length; }); })) return results;
    var sf = GP.shareFeet(live.map(function (r) { return { solids: r.solids }; }), D.soup,
      { plateZ: live[0].plateZ, occluders: occludersOf(D) });
    if (!sf.ok) throw new Error(sf.reason);
    var out = live.map(function (r) { return Object.assign({}, r, { solids: [] }); });
    sf.objects.forEach(function (ob) {
      var keys = [], holds = {}, lands = {}, rids = [];
      ob.from.forEach(function (f) {
        var x = live[f[0]].solids[f[1]];
        keys = keys.concat(x.keys);
        Object.keys(x.holds).forEach(function (k) { holds[k] = x.holds[k]; });
        lands[x.landing] = true;
        (x.regionIds || []).forEach(function (id) { if (rids.indexOf(id) < 0) rids.push(id); });
      });
      var ls = Object.keys(lands);
      out[ob.from[0][0]].solids.push({ soup: ob.soup, keys: keys, holds: holds, landing: ls.length === 1 ? ls[0] : 'mixed', regionIds: rids });
    });
    return results.map(function (r) { var k = live.indexOf(r); return k < 0 ? r : out[k]; });
  }

  /* Take pieces off the plate and out of the model list, recorded the way
     supportSwap puts them back. No undo step by itself. */
  function removePieces(ids) {
    var drop = new Set(ids), removed = [];
    state.placed.forEach(function (p, i) { if (p && drop.has(p.sourceId)) removed.push({ placed: p, placedIndex: i }); });
    removed.forEach(function (r) { r.model = modelOf(r.placed.sourceId); r.modelIndex = state.models.indexOf(r.model); });
    state.placed = state.placed.filter(function (p) { return !(p && drop.has(p.sourceId)); });
    state.models = state.models.filter(function (m) { return !drop.has(m.id); });
    removed.forEach(function (r) { if (r.placed.mesh && r.placed.mesh.parent) r.placed.mesh.parent.remove(r.placed.mesh); });
    state.placed.forEach(function (p, i) { if (p.mesh) p.mesh.userData.placedIndex = i; });
    state.selectedIndex = -1;
    return removed;
  }
  function restorePieces(removed) {
    removed.slice().sort(function (a, b) { return a.modelIndex - b.modelIndex; }).forEach(function (r) {
      if (state.models.indexOf(r.model) < 0) state.models.splice(Math.min(r.modelIndex, state.models.length), 0, r.model);
    });
    removed.slice().sort(function (a, b) { return a.placedIndex - b.placedIndex; }).forEach(function (r) {
      if (state.placed.indexOf(r.placed) < 0) state.placed.splice(Math.min(r.placedIndex, state.placed.length), 0, r.placed);
      if (r.placed.mesh && state.modelGroup && !r.placed.mesh.parent) state.modelGroup.add(r.placed.mesh);
    });
    state.placed.forEach(function (p, i) { if (p.mesh) p.mesh.userData.placedIndex = i; });
  }
  function dropAdded(ids) {
    var drop = new Set(ids);
    state.placed.forEach(function (p) { if (p && drop.has(p.sourceId) && p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh); });
    state.placed = state.placed.filter(function (p) { return !(p && drop.has(p.sourceId)); });
    state.models = state.models.filter(function (m) { return !drop.has(m.id); });
  }

  /* One solid onto the plate exactly where it was planned, read back off the
     scene before it is kept (G-scope's placeSupport, without the contact
     test: the label is the planner's, not a measurement). */
  function placeSolid(soup, meta, hostPlaced, hostMinZ, name) {
    var b = boundsOf(soup);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(soup), 3));
    var id = addModelFromZUpGeometry(name, geo, { keepSelection: true, silent: true });
    if (!id) return { ok: false, reason: 'a support could not be added' };
    var m = modelOf(id);
    m.nsoSupport = meta;
    /* the sheet is a thin wall (under a bead): the slicer settings it needs
       go out on the support's object (NSO_SupportInterface.SHEET) */
    var SI = window.NSO_SupportInterface;
    if (SI && SI.SHEET && SI.SHEET.slicerSettings) m.slicerSettings = Object.assign({}, SI.SHEET.slicerSettings);
    /* the brim is one layer of concentric walls: ten loops of the line, no infill, no top (Studio prints it as the brim it is) */
    if (meta.brim) m.slicerSettings = { wall_generator: 'classic', detect_thin_wall: '0', wall_loops: '10', sparse_infill_density: '0%', top_shell_layers: '0', bottom_shell_layers: '1' };
    var entry = placeModelMovable(m, (b.lo[0] + b.hi[0]) / 2, -(b.lo[1] + b.hi[1]) / 2);
    entry.mesh.position.y = (b.lo[2] + b.hi[2]) / 2;
    entry.liftY = (hostPlaced.liftY || 0) + (b.lo[2] - hostMinZ);
    entry.mesh.updateMatrixWorld(true);
    var back = worldUp(entry.mesh), err = 0;
    if (back.length !== soup.length) err = Infinity;
    else for (var i = 0; i < soup.length; i++) err = Math.max(err, Math.abs(back[i] - soup[i]));
    if (!(err <= 1e-3)) { dropAdded([id]); return { ok: false, reason: 'a support did not land where it was built' }; }
    return { ok: true, id: id };
  }

  function snapshot() {
    var m = modelOf(S.hostId), hostId = S.hostId;
    var ops = editsOf(m).ops.slice(), serial = editsOf(m).serial;
    var unreach = JSON.parse(JSON.stringify(memOf(hostId).unreach)), built = memOf(hostId).built;
    var feed = feedCopy(m.nsoSupportFeed), members = memOf(hostId).members, zonesEmpty = memOf(hostId).zonesEmpty, builtKnobs = memOf(hostId).builtKnobs;
    return function () {
      var mm = modelOf(hostId);
      if (mm) mm.nsoSupportEdits = { ops: ops.slice(), serial: serial };
      if (mm) mm.nsoSupportFeed = feedCopy(feed) || undefined;
      memOf(hostId).unreach = JSON.parse(JSON.stringify(unreach));
      memOf(hostId).members = members; memOf(hostId).zonesEmpty = zonesEmpty;
      memOf(hostId).built = built; memOf(hostId).builtKnobs = builtKnobs;
      S.sel = null; S.hover = null;
      if (S.tool === 'erase' && !eraseReady()) S.tool = 'tips';
      if (S.selSupport != null && !modelOf(S.selSupport)) S.selSupport = null;
      if (S.open) refresh();
    };
  }

  function afterCommit() {
    if (typeof renderModelList === 'function') renderModelList();
    if (typeof updateOptimizeButton === 'function') updateOptimizeButton();
    if (typeof updateEditSize === 'function') updateEditSize();
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    if (typeof updateUndoBtn === 'function') updateUndoBtn();
    if (S.selSupport != null && !modelOf(S.selSupport)) S.selSupport = null;
    var idx = state.placed.findIndex(function (q) { return q && q.sourceId === S.hostId; });
    if (S.selSupport == null && idx >= 0 && typeof selectPlaced === 'function') selectPlaced(idx);
    refresh();
  }

  /*
   * GENERATE / REGENERATE: build every area not left out and put every solid
   * on the plate, taking every support already on the piece off first: one
   * undo step for the lot. An area the plan cannot reach adds nothing; its
   * spots are remembered as unreachable until the next build or REMOVE ALL.
   *
   * The work goes PHASE BY PHASE, every area through a phase before the next
   * begins, so the bar's phase word only ever moves forward:
   *   detecting / planning   each area through the planner, in the worker
   *   building               each area's sheet and trunks (nso_support_gridpack
   *                          parts), handed back as shells (.shells), in the worker
   * and tells the bar as it goes (note). Planning and building have counts
   * (beacons settled; the sheet's tips settled, then trunks swept - buildUnits)
   * summed over every area; detecting has none, and the bar says so.
   *
   * THE WATCHDOG IS SILENCE. Every message the planner posts (heard) puts it
   * back to S.watchdogMs; it fires only when nothing has come for that long,
   * so a build that is still reporting is never taken for hung. A build still
   * running at S.ceilingMs is stopped however it reports.
   *
   * A build ENDS IN A STATE. It makes no change to the plate until the end:
   * the plate is touched in one stretch of synchronous code at the very end
   * (commit), and only if the build is still live. So a refusal, an
   * exception, Escape or the watchdog - which stop the worker and mark the
   * build dead - leave the plate exactly as it was, with no Undo step; the
   * card says "Could not build: <why> - nothing was added" (or "Build
   * cancelled - nothing was added") and is back in the state it was in before.
   */
  function build(pre) {
    if (S.busy || SL.busy) return Promise.resolve({ ok: false, reason: 'busy' });          // a slice reads the plate: it is not changed under it
    var host = placedOf(S.hostId), hm = modelOf(S.hostId), D = detect();
    if (D === PENDING) return Promise.resolve({ ok: false, reason: 'still measuring' });
    if (!host || !D || D.error) return Promise.resolve({ ok: false, reason: D ? D.error : 'no piece' });
    var eff = S.eff = effective(), o = cardOpts(), hostId = S.hostId;
    if (pre && pre.lattice) o.one = false;                             // the retry below: the one-trunk build's feet ringed the piece
    var regs = eff.regions.filter(function (r) { return !r.excluded; });
    var removeIds = supportsOf(hostId).map(function (m) { return m.id; });
    if (!regs.length) {
      S.msg = { text: eff.blocked && !eff.beacons.length ? ALL_BLOCKED : 'Every area is left out. Click one to put it back.', bad: true };
      sync();
      return Promise.resolve({ ok: false, reason: 'nothing to build' });
    }
    var spots = regs.reduce(function (n, r) { return n + r.beacons.filter(function (b) { return !b.off; }).length; }, 0);
    var J = startJob(), job = J.job;
    var c = { hostId: hostId, hm: hm, host: host, D: D, o: o, regs: regs, spots: spots }, pr = null;

    /* One frame and a tick first: the card and the bar are on screen before the planner starts. */
    var chain = new Promise(function (go) {
      requestAnimationFrame(function () { setTimeout(go, 0); });
    }).then(function () { return runPiece(J, c, false); }).then(function (r) {
      pr = r;
      if (job.dead) return null;
      pr.s = settleResults(pr.areas, pr.builtOf, D);
      return pr.s.ok ? brimStep(c, pr.s.results) : null;
    });

    /* The one place the plate changes. Synchronous from the first removal to
       the Undo step, so nothing can interleave; on any failure inside it
       everything is put back and no step is recorded. */
    function commit() {
      if (job.dead) return { ok: false, reason: 'the build was stopped' };
      var s = pr.s || settleResults(pr.areas, pr.builtOf, D);
      if (!s.ok) return { ok: false, reason: s.reason };
      var results = s.results;
      var undo = (pre && pre.undo) || snapshot(), removed = [], added = [], mem = memOf(hostId);
      try {
        removed = removePieces(removeIds);
        placeResults(c, results, added);
      } catch (err) {
        dropAdded(added); restorePieces(removed); undo();
        return { ok: false, reason: (err && err.message) || String(err), undone: true };
      }
      mem.built = true;
      mem.builtKnobs = knobKey(S.mode === 'custom' ? o.knobs : null, false);
      pushUndo({ type: 'supportSwap', removed: removed, addedIds: added,
        label: removed.length ? 'Undo: supports on the piece put back as they were' : 'Undo: supports taken off', onUndone: undo });
      return { ok: true, added: added, removed: removed.map(function (x) { return x.placed.sourceId; }) };
    }

    return finishJob(J, chain.then(commit), afterCommit, function (res) {
      return { ok: true, added: res.added, removed: res.removed,
        stats: areaStats(S.eff, statesFor(S.eff)), line: ($('sup-count') || {}).textContent || '' };
    }).then(function (r) {
      /* ONE TRUNK'S FEET ARE FAT (a trunk is as wide at the plate as its height asks, 18 mm for the 72 mm clamp) and a ring of them
         round the clamp's post leaves the pad round the piece no way out to the open air. The lattice builds the same piece (its feet
         are not that big), so the card builds it again that way, and says so. Nothing was added by the first try. */
      if (r && !r.ok && !(pre && pre.lattice) && oneTrunkOn(o) && /could not be opened to the outside/.test(r.reason || '')) {
        return build({ undo: pre && pre.undo, lattice: true }).then(function (r2) {
          if (r2 && r2.ok) { S.msg = { text: 'One trunk\'s feet ringed the piece, so it is built with the lattice', bad: false }; sync(); }
          return r2;
        });
      }
      return r;
    });
  }

  /*
   * One build's bookkeeping, a piece's or the plate's: the job (the worker, the
   * clock, the timers), the WATCHDOG (silence: heard() puts it back to
   * S.watchdogMs on every message and it fires only when nothing has come for
   * that long), the CEILING (S.ceilingMs from when arm() was last called: a
   * piece's build arms it once, at the start; the plate's arms it again as each
   * piece begins, so it is a ceiling per piece and not on the plate's total) and
   * pause(): a turn for the page between units of work on it, so the bar
   * repaints and the clock and Escape are heard. It also reads the clocks (a
   * unit that blocks the thread cannot be interrupted, so it is caught after)
   * and refuses to go on once the build is dead.
   */
  function startJob() {
    var job = { seq: 0, dead: false, t0: Date.now(), heard: Date.now(), worker: undefined, sentSoup: false, stop: null, timer: 0, ceiling: 0, clock: 0, rank: -1, what: 'the build' };
    job.capFrom = job.t0;
    var limit = S.watchdogMs, secs = Math.round(limit / 100) / 10, cap = S.ceilingMs;
    function late() { var e = new Error('the planner was still working after ' + secs + ' s'); e.timeout = true; return e; }
    function runaway() {
      var e = new Error(job.what + ' was still running after ' + (cap % 60000 ? Math.round(cap / 100) / 10 + ' s' : cap / 60000 + ' min'));
      e.timeout = true; return e;
    }
    /* The planner said something: the watchdog starts again from now. */
    function heard() {
      if (job.dead) return;
      job.heard = Date.now();
      clearTimeout(job.timer);
      job.timer = setTimeout(function () { job.stop(late()); }, limit);
    }
    function arm() {
      clearTimeout(job.ceiling);
      job.capFrom = Date.now();
      job.ceiling = setTimeout(function () { job.stop(runaway()); }, cap);
    }
    var sliceFrom = Date.now();
    function pause() {
      if (job.dead) throw new Error('the build was stopped');
      if (Date.now() - job.heard > limit) throw late();
      if (Date.now() - job.capFrom > cap) throw runaway();
      if (Date.now() - sliceFrom < SLICE_MS) return undefined;
      return new Promise(function (go) { setTimeout(go, 0); }).then(function () {
        sliceFrom = Date.now();
        if (job.dead) throw new Error('the build was stopped');
      });
    }
    S.job = job; S.busy = true; S.msg = null; S.elapsed = 0; S.prog = null; sync();
    var guard = new Promise(function (go, stop) { job.stop = stop; });
    heard();
    arm();
    job.clock = setInterval(function () { S.elapsed = Math.floor((Date.now() - job.t0) / 1000); sync(); }, 1000);
    return { job: job, heard: heard, pause: pause, arm: arm, guard: guard };
  }
  function endJob(job) {
    job.dead = true;
    clearTimeout(job.timer); clearTimeout(job.ceiling); clearInterval(job.clock);
    stopWorker(job);
    if (S.job === job) S.job = null;
    S.busy = false; S.elapsed = 0; S.prog = null; S.run = null;
    unsay();
  }
  /* A build ENDS IN A STATE: `work` (the plate's one stretch of change, or its refusal) raced against the guard (Escape,
     the watchdog, the ceiling, the card closing). `settled` is what a build that changed the plate and put it back
     calls; `done` makes the answer of one that built. */
  function finishJob(J, work, settled, done) {
    var job = J.job;
    work.catch(function () { /* the race below has the answer; a late one must not go unhandled */ });
    function fail(reason, restored) {
      S.msg = { text: 'Could not build: ' + String(reason || 'no reason given').replace(/[.\s]+$/, '') + ' - nothing was added', bad: true };
      if (restored) settled(); else refresh();     // the plate was not touched: leave its selection alone
      return { ok: false, reason: reason, line: ($('sup-count') || {}).textContent || '' };
    }
    return Promise.race([work, J.guard]).then(function (res) {
      endJob(job);
      if (!res.ok) return fail(res.reason, res.undone);
      settled();
      return done(res);
    }, function (err) {
      endJob(job);
      if (err && err.cancelled) {
        S.msg = { text: 'Build cancelled - nothing was added', bad: false };
        refresh();
        return { ok: false, reason: 'cancelled', cancelled: true, line: ($('sup-count') || {}).textContent || '' };
      }
      if (!err || !err.timeout) console.error('[supports card]', err);
      return fail((err && err.message) || String(err));
    });
  }

  /*
   * One piece through the planner and the builder: its areas planned one by one, then every area's sheet and trunks
   * built and handed back as shells. c: { hm, D, regs, spots, o }. Resolves { areas, builtOf }. The piece's worker is
   * stopped at the end unless `keep` (the plate's next piece uses it).
   */
  function runPiece(J, c, keep) {
    var job = J.job, hm = c.hm, D = c.D, o = c.o, regs = c.regs, spots = c.spots, areas = [], builtOf = [], chain = Promise.resolve();
    job.parts = partsOptsOf(o);                       // this piece's sheet: Dense in the one-trunk build, Open in every other
    /* the sheet fills the contact surface the detector traced (docs/SUPPORT-FOOTPRINT.md), whatever tips were planned for it */
    if (D && D.det && window.NSO_SupportBeacons && window.NSO_SupportBeacons.footprintsOf) {
      var bx = boxesNow();      // ...less what a blocker holds
      job.parts.sheetFootprints = bx.length ? BL().footprintsOf(D.det.beaconRegions, bx, D.det.grid ? D.det.grid.pitch : 3) : window.NSO_SupportBeacons.footprintsOf(D.det.beaconRegions);
    }
    /* ...and the paint: the cells the brush covered, laid to its edge (paintFootprints) */
    if (job.parts.sheetRegionPlate && c.hm && paintOps(c.hm).length) job.parts.sheetFootprints = paintFootprints(c.hm, c.host, job.parts.sheetFootprints || []);
    var gp = function () { return window.NSO_SupportGridpack; };

    /* 1. PLANNING (detecting, then beacons settled), area by area. */
    var settledBefore = 0;
    groupAreas(regs, o).forEach(function (grp) {
      var rg = grp[0], beacons = grp.length === 1 ? rg.beacons : [].concat.apply([], grp.map(function (g) {
        return g.beacons.map(function (b) { return Object.assign({}, b, { rid: g.id }); });
      }));
      /* the areas a group takes in are planned with its first: they get an empty, ok answer of their own, so every area has one */
      grp.slice(1).forEach(function (g) { chain = chain.then(function () { areas.push({ result: { ok: true, rid: g.id, solids: [], unreachable: [], members: [], zonesEmpty: null } }); }); });
      chain = chain.then(function () {
        if (job.dead) return null;
        var at = settledBefore, mine = beacons.filter(function (b) { return !b.off; }).length;
        settledBefore += mine;
        return planArea(job, D, rg.id, beacons, o, function (m, sent) {
          /* Each area's planner starts with its own 'detecting'; note() drops
             it once the build is past that phase. The counts are this
             build's, summed over the areas. */
          J.heard();
          note(job, m && m.phase === 'planning' ? { phase: 'planning', done: at + m.done, total: spots, own: mine, ownDone: m.done } : m, sent);
        }, feedFor(hm, beacons, rg.id, o.knobs)).then(function (a) {
          areas.push(a);
          /* MAY REST ON THE PART: the one-trunk build stands on the plate only; what it could not reach is asked of the lattice that may rest on the part */
          var left = o.rest && oneTrunkOn(o) && a.t && a.unreach ? beacons.filter(function (b) { return !b.off && a.unreach.indexOf(b.key) >= 0; }) : [];
          if (!left.length) return J.pause() || new Promise(function (go) { setTimeout(go, 0); });
          return planArea(job, D, rg.id, left, o, null, null, true).then(function (a2) {
            if (a2 && a2.t) {
              a.unreach = a.unreach.filter(function (k) { return a2.unreach.indexOf(k) >= 0; });
              a2.unreach = a.unreach.slice();
              areas.push(a2);
            }
            return J.pause() || new Promise(function (go) { setTimeout(go, 0); });
          });
        });
      });
    });

    /* 2. BUILDING: every area that has a plan, its sheet and trunks built
       and handed back as shells. The count is every area's buildUnits. */
    chain = chain.then(function () {
      if (job.dead) return null;
      /* Every area has been through the planner, and every spot in it is settled (an area the planner
         refused counts: its spots are named unreachable or inside). */
      note(job, { phase: 'planning', done: spots, total: spots, own: spots, ownDone: spots });
      var live = areas.filter(function (a) { return a.t; });
      var units = live.map(function (a) { return gp().buildUnits(a.t, job.parts || PARTS_OPTS); });
      var total = units.reduce(function (n, k) { return n + k; }, 0), before = 0, next = Promise.resolve();
      live.forEach(function (a, k) {
        next = next.then(function () {
          if (job.dead) return null;
          var at = before;
          before += units[k];
          return buildAway(job, a.t, function (m, sent) {
            J.heard();
            note(job, m && m.phase === 'building' ? { phase: 'building', done: at + m.done, total: total, own: units[k], ownDone: m.done } : m, sent);
          }, J.pause).then(function (u) { builtOf.push({ a: a, u: u }); });
        });
      });
      return next.then(function () { if (!keep) stopWorker(job); });
    });
    return chain.then(function () { return { areas: areas, builtOf: builtOf }; });
  }

  /* THE BRIM (docs/SLICER.md "The brim"): built with the supports, one layer thick round the piece's foot, 5 mm, off every pad and every other
     body (NSO_Slicer.brimFor: Bambu's ring round a tall thin stem, which meets the tree's pad and does not join it). It is one more solid of
     the piece's first result, flagged brim: placed as a plate piece of its own (named "- brim", never counted as a support) and sliced
     as role 'brim'. Resolves the words the card says, or null when there is nothing to say; never rejects: a build without a brim is
     still a build. c: { D, o }, results: settleResults'. */
  function brimStep(c, results) {
    var SL = window.NSO_Slicer;
    if (!c.o.brim || !SL || typeof SL.brimFor !== 'function' || typeof SL.loadKernel !== 'function') return Promise.resolve(null);
    var live = results.filter(function (r) { return r.ok && r.solids.length; });
    if (!live.length) return Promise.resolve(null);
    var avoid = [].concat.apply([], live.map(function (r) { return r.solids.map(function (sd) { return sd.soup; }); })).concat((c.D.opts && c.D.opts.occluders) || []);
    return SL.loadKernel({}).then(function (wasm) {
      var r = SL.brimFor(c.D.soup, { brimType: 'auto' }, wasm, avoid, live[0].plateZ);
      if (!r.ok || !r.needed || !r.soup.length) return { none: r.reason || 'no room' };
      live[0].solids.push({ soup: r.soup, keys: [], holds: {}, landing: 'plate', regionIds: [], brim: true });
      return { loops: r.loops, areaMm2: r.areaMm2 };
    }).catch(function (err) { console.error('[supports card] brim', err); return null; });
  }

  /* A piece's areas and what building made of them: its results (solids, feet shared) - or why the planner would not. */
  function settleResults(areas, builtOf, D) {
    var results = areas.map(function (a) {
      if (!a.t) return a.result;
      var x = builtOf.find(function (y) { return y.a === a; });
      return areaResult(a, x ? x.u : { ok: false, reason: 'the area was not built' });
    });
    var failed = results.filter(function (r) { return !r.ok; });
    if (failed.length) return { ok: false, reason: failed[0].reason || 'the planner refused' };
    try { results = shareFeet(results, D); } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
    return { ok: true, results: results };
  }

  /* A piece's results onto the plate: the card's memory of it, then each solid as a piece of its own. Throws if one
     does not land (the caller puts everything back). c: { hostId, hm, host, D, o }. */
  function placeResults(c, results, added) {
    var mem = memOf(c.hostId), o = c.o, n = 0;
    mem.unreach = {};
    /* a fed build names its members (the eraser's targets), and which
       circles nothing landed in (empty in every area that was planned) */
    mem.members = S.mode === 'auto' ? [] : [].concat.apply([], results.map(function (r) { return r.members || []; }));
    var zl = results.map(function (r) { return r.zonesEmpty; }).filter(Boolean);
    mem.zonesEmpty = S.mode === 'auto' || !zl.length ? [] : zl[0].filter(function (zi) { return zl.every(function (l) { return l.indexOf(zi) >= 0; }); });
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      mem.unreach[r.rid] = r.unreachable.slice();
      for (var k = 0; k < r.solids.length; k++) {
        var sd = r.solids[k];
        var meta = { card: true, hostSourceId: c.hostId, hostName: c.hm.name, regionId: r.rid, style: o.style,
          sideMm: r.sideMm || o.sideMm, rest: o.rest, angleDeg: S.angle, mode: S.mode, keys: sd.keys, holds: sd.holds, landing: sd.landing };
        if (sd.brim) meta.brim = true;
        meta.sheetLayerMm = partsOptsOf(o).sheetLayerMm || 0;               /* a Dense sheet's layers are this thick: the slicer cuts the supports on their own layer grid then */
        meta.interfaceLayers = partsOptsOf(o).interfaceLayers || 2;      /* how many interface layers its sheet has: the slicer reads a 3-layer sheet as one */
        var pl = placeSolid(sd.soup, meta, c.host, c.D.minZ, sd.brim ? c.hm.name + ' - brim' : c.hm.name + ' - support ' + (r.rid + 1) + '.' + (++n) + ' (' + STYLES[o.style] + ')');
        if (!pl.ok) throw new Error(pl.reason);
        added.push(pl.id);
      }
    }
  }

  /*
   * GENERATE for the plate: the piece's build, above, once for every piece, in plate order - each piece's own
   * remembered state (the areas left out, the tips and circles fed in), the card's mode, style, size and angle. ONE bar
   * ("Piece 2 of 6 · Planning 142 / 344 · 21 %": the counts are the piece's, the percent is the plate's, by spots).
   * The plate is touched once, at the very end, and ONE Undo step takes every piece's supports back; before that
   * nothing has changed, so Escape, the watchdog or an exception ends it with the plate as it was and no step.
   *
   * A piece with nothing hanging (or every area left out) is not built, and one the planner refuses is not built
   * either: each is a row of its own on the card, and the others go on. Its supports, if it has any, stay.
   *
   * Pieces do not touch: each piece is planned with the supports the earlier pieces of this run have built added to
   * the occluders (D.opts.occluders - the option that already keeps a piece's supports off the other pieces' bodies),
   * so a later piece's trunks, feet and pads are routed round them. The engine is not changed.
   */
  function buildWide() {
    if (S.busy) return Promise.resolve({ ok: false, reason: 'busy' });
    var W = wideRead();
    if (W.pending) return Promise.resolve({ ok: false, reason: 'still measuring' });
    var o = cardOpts(), todo = [], left = [];
    S.wideIds.forEach(function (id) {
      asHost(id, function () {
        var D = detect(), hm = modelOf(id), host = placedOf(id);
        if (!hm || !host) { left.push({ id: id, name: hm ? hm.name : '', why: 'the piece is gone' }); return; }
        if (D === PENDING || !D || D.error) { left.push({ id: id, name: hm.name, why: 'could not read it: ' + (D && D.error ? D.error : 'still measuring') }); return; }
        var eff = effective(), regs = eff.regions.filter(function (r) { return !r.excluded; });
        if (!regs.length) { left.push({ id: id, name: hm.name, why: eff.beacons.length ? 'every area left out' : S.mode === 'custom' ? 'no tips' : 'no hanging area' }); return; }
        todo.push({ hostId: id, hm: hm, host: host, D: D, o: o, regs: regs,
          spots: regs.reduce(function (n, r) { return n + r.beacons.filter(function (b) { return !b.off; }).length; }, 0),
          removeIds: supportsOf(id).map(function (m) { return m.id; }) });
      });
    });
    if (!todo.length) {
      S.msg = { text: 'Nothing to build on the plate: ' + wordsFor(left) + '.', bad: true };
      sync();
      return Promise.resolve({ ok: false, reason: 'nothing to build', pieces: left });
    }
    /* each piece's share of the bar: its spots (a piece with none still counts one) over the plate's */
    var total = todo.reduce(function (n, c) { return n + Math.max(1, c.spots); }, 0), at = 0;
    todo.forEach(function (c) { c.from = at / total; at += Math.max(1, c.spots); c.span = Math.max(1, c.spots) / total; });
    S.run = { k: 1, n: todo.length, from: 0, span: todo[0].span };
    var J = startJob(), job = J.job;
    var finals = [], built = [], refused = [];

    var chain = new Promise(function (go) {
      requestAnimationFrame(function () { setTimeout(go, 0); });
    });
    todo.forEach(function (c, k) {
      chain = chain.then(function () {
        if (job.dead) return null;
        /* a new piece: its own phases from the top, its own copy of the piece in the worker, its own ceiling */
        S.run = { k: k + 1, n: todo.length, from: c.from, span: c.span };
        job.what = c.hm.name; job.rank = -1; job.sentSoup = false; S.prog = null;
        J.arm(); paintBar();
        var Dp = Object.assign({}, c.D, { opts: Object.assign({}, c.D.opts, { occluders: (c.D.opts.occluders || []).concat(finals) }) });
        var cc = Object.assign({}, c, { D: Dp });
        return runPiece(J, cc, true).then(function (pr) {
          var s = settleResults(pr.areas, pr.builtOf, Dp);
          if (!s.ok) { refused.push({ id: c.hostId, name: c.hm.name, why: 'refused: ' + String(s.reason || 'no reason given').replace(/[.\s]+$/, '') }); return; }
          return brimStep(cc, s.results).then(function () {
            built.push({ c: cc, results: s.results });
            s.results.forEach(function (r) { r.solids.forEach(function (sd) { finals.push(sd.soup); }); });
          });
        });
      });
    });

    /* The one place the plate changes: every piece's old supports off, every piece's new ones on, one Undo step. */
    function commit() {
      if (job.dead) return { ok: false, reason: 'the build was stopped' };
      if (!built.length) return { ok: false, reason: 'no piece could be built: ' + wordsFor(left.concat(refused)) };
      var snaps = [], removed = [], added = [], removeIds = [];
      built.forEach(function (b) { removeIds = removeIds.concat(b.c.removeIds); });
      try {
        built.forEach(function (b) { snaps.push(asHost(b.c.hostId, snapshot)); });
        removed = removePieces(removeIds);
        built.forEach(function (b) { placeResults(b.c, b.results, added); });
      } catch (err) {
        dropAdded(added); restorePieces(removed); snaps.forEach(function (f) { f(); });
        return { ok: false, reason: (err && err.message) || String(err), undone: true };
      }
      built.forEach(function (b) {
        var mem = memOf(b.c.hostId);
        mem.built = true;
        mem.builtKnobs = knobKey(S.mode === 'custom' ? o.knobs : null, false);
      });
      pushUndo({ type: 'supportSwap', removed: removed, addedIds: added,
        label: removed.length ? 'Undo: supports on the plate put back as they were' : 'Undo: supports taken off the plate',
        onUndone: function () {
          setWide(false);                                 // the lit pieces go with the supports
          snaps.forEach(function (f) { f(); });
        } });
      S.wideNotes = {};
      refused.forEach(function (r) { S.wideNotes[r.id] = r.why; });
      return { ok: true, added: added, removed: removed.map(function (x) { return x.placed.sourceId; }) };
    }

    return finishJob(J, chain.then(commit), afterCommitWide, function (res) {
      var W2 = S.wideView || wideRead(), by = {};
      W2.pieces.forEach(function (r) { by[r.id] = r; });
      var pieces = S.wideIds.map(function (id) {
        var r = by[id], lf = left.concat(refused).find(function (x) { return x.id === id; });
        return { id: id, name: r ? r.name : '', built: built.some(function (b) { return b.c.hostId === id; }), why: lf ? lf.why : null,
          supports: r && r.a ? r.a.supports : 0, areas: r && r.a ? r.a.total : 0, held: r && r.a ? r.a.held : 0,
          unsupported: r && r.a ? r.a.unsupported : 0, unreachable: r && r.a ? r.a.unreachable : 0 };
      });
      return { ok: true, added: res.added, removed: res.removed, pieces: pieces, totals: Object.assign({}, W2.totals),
        rows: wideRows(W2), line: ($('sup-count') || {}).textContent || '' };
    });
  }
  /* "Box (no hanging area), Tunnel (refused: no route)", for a message. */
  function wordsFor(list) {
    var w = list.slice(0, 3).map(function (x) { return (x.name || 'a piece') + ' (' + x.why + ')'; });
    return w.join(', ') + (list.length > 3 ? ' and ' + (list.length - 3) + ' more' : '');
  }
  /* The plate was changed and put back, or built: the lists that show pieces, then the card. */
  function afterCommitWide() {
    if (typeof renderModelList === 'function') renderModelList();
    if (typeof updateOptimizeButton === 'function') updateOptimizeButton();
    if (typeof updateEditSize === 'function') updateEditSize();
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    if (typeof updateUndoBtn === 'function') updateUndoBtn();
    if (S.wide && !wideHolds()) setWide(false);
    else if (S.open) refresh();
  }

  /* What the planner has said, taken up by the bar. A phase never goes back
     (every area's planner opens with its own 'detecting'), a count never
     goes down or past its total (one that does is dropped, not clamped), and
     a message with no count is a phase with none: the bar shows its word and
     the seconds. Listeners (onProgress) hear
     every message that is kept, repeats included, so the cadence is theirs
     to read. `sent` is when the worker posted it (the page may take it up
     later: a frame of the 3D view can hold the page's thread for a while). */
  function note(job, m, sent) {
    if (job.dead || S.job !== job || !m || !(m.phase in PHASE_RANK)) return;
    var rank = PHASE_RANK[m.phase], counted = isFinite(m.done) && isFinite(m.total) && m.total > 0;
    /* A count that makes no sense (below 0, past its total, past its own
       area's share) is not shown: the bar never says more than it was told. */
    if (counted && (m.done < 0 || m.done > m.total || (m.own != null && (m.ownDone < 0 || m.ownDone > m.own)))) return;
    var next = { phase: m.phase, done: counted ? m.done : null, total: counted ? m.total : null };
    if (rank < job.rank) return;
    if (rank === job.rank && counted && S.prog && S.prog.done != null && next.done < S.prog.done) return;
    job.rank = rank;
    S.prog = next;
    paintBar();
    var now = Date.now();
    var say = { phase: next.phase, done: next.done, total: next.total, percent: percentNow(), line: progressLine(),
      ms: now - job.t0, sent: (sent || now) - job.t0 };
    S.listeners.slice().forEach(function (fn) { try { fn(say); } catch (err) { /* a listener must not stop the build */ } });
  }

  /* Escape stops the build that is running: the worker is terminated, the
     plate is as it was, Undo has nothing new. */
  function cancel() {
    var job = S.job;
    if (!job || job.dead || !job.stop) return { ok: false, reason: 'not building' };
    var e = new Error('the build was cancelled');
    e.cancelled = true;
    job.stop(e);
    return { ok: true };
  }
  function onKey(ev) {
    var typing = ev.target && /^(INPUT|SELECT|TEXTAREA)$/.test(ev.target.tagName);
    if (S.open && !S.busy && S.paint && ev.key === 'Escape' && !typing) {          // a stroke in the air is dropped, then the brush is put down
      if (S.stroke) { S.stroke = null; drawPaint(); } else setPaint(false);
      ev.preventDefault(); ev.stopImmediatePropagation();
      return;
    }
    if (S.open && !S.busy && S.mode !== 'auto' && !typing) {
      if (ev.key === 'Escape' && (S.tool === 'circles' || S.tool === 'erase')) {      // stop the tool: the view orbits again
        setTool(S.tool);
        ev.preventDefault(); ev.stopImmediatePropagation();
        return;
      }
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && S.tool === 'circles' && S.sel != null && !S.drag) {
        removeZone(S.sel);
        ev.preventDefault(); ev.stopImmediatePropagation();
        return;
      }
    }
    if (ev.key !== 'Escape' || !S.busy || !S.job) return;
    cancel();
    ev.preventDefault(); ev.stopImmediatePropagation();
  }

  /* Supports off, one undo step; the card goes back to IDLE (`reset`) when
     every support on the piece is taken off. Its spots, left-out areas and
     paint stay: they are the piece's own edits, each its own Undo. */
  function takeOff(ids, label, reset) {
    if (S.busy || S.hostId == null) return { ok: false, reason: S.busy ? 'busy' : 'no piece' };
    var mem = memOf(S.hostId);
    var fh = modelOf(S.hostId);
    if (!ids.length && !(reset && (mem.built || Object.keys(mem.unreach).length || (fh && !feedEmpty(fh.nsoSupportFeed))))) return { ok: false, reason: 'nothing to take off' };
    var undo = snapshot();
    var removed = removePieces(ids);
    if (reset) {
      mem.unreach = {}; mem.built = false; mem.members = []; mem.zonesEmpty = []; mem.builtKnobs = '';
      var mh = modelOf(S.hostId);
      if (mh) mh.nsoSupportFeed = undefined;                         // the card's reset: the user's points, circles and erasures go too
      if (S.tool === 'erase') S.tool = 'tips';
      S.sel = null;
    }
    pushUndo({ type: 'supportSwap', removed: removed, addedIds: [], label: label, onUndone: undo });
    S.msg = null;
    afterCommit();
    return { ok: true, removed: ids.slice() };
  }

  function generate(pre) {
    if (S.wide) return generateWide();
    if (S.hostId == null) return Promise.resolve({ ok: false, reason: 'no piece' });
    var badKnob = S.mode === 'custom' ? knobBad() : null;
    if (badKnob) { S.msg = { text: badKnob, bad: true, knob: true }; sync(); return Promise.resolve({ ok: false, reason: badKnob }); }
    S.eff = effective();
    if (S.eff.error || !S.eff.beacons.length) { refresh(); return Promise.resolve({ ok: false, reason: S.eff.error || 'nothing needs holding' }); }
    return build(pre);
  }
  function generateWide() {
    var badKnob = S.mode === 'custom' ? knobBad() : null;
    if (badKnob) { S.msg = { text: badKnob, bad: true, knob: true }; sync(); return Promise.resolve({ ok: false, reason: badKnob }); }
    if (!wideHolds()) { setWide(false); return Promise.resolve({ ok: false, reason: 'the plate changed' }); }
    return buildWide();
  }
  function removeAll() {
    if (S.hostId == null) return { ok: false, reason: 'no piece' };
    return takeOff(supportsOf(S.hostId).map(function (m) { return m.id; }), 'Undo: every support on the piece restored', true);
  }
  function removeSelected() {
    if (S.selSupport == null || !modelOf(S.selSupport)) return { ok: false, reason: 'no support selected' };
    var id = S.selSupport;
    S.selSupport = null;
    return takeOff([id], 'Undo: support restored', false);
  }

  /*
   * Leave an area out of the next build, or put it back: one Undo step, an
   * edit on the piece like a manual or painted spot. Nothing is built or
   * taken off - the supports already standing stay until REGENERATE.
   */
  function toggleArea(rid) {
    var host = placedOf(S.hostId), m = modelOf(S.hostId), eff = S.eff;
    if (!host || !m || !eff || eff.error || S.busy) return { ok: false, reason: S.busy ? 'busy' : 'no piece' };
    var rg = eff.regions.find(function (r) { return r.id === rid; });
    if (!rg) return { ok: false, reason: 'no such area' };
    var undo = snapshot(), E = editsOf(m), was = rg.excluded;
    E.ops.push({ op: was ? 'include' : 'exclude', p: upToLocal(host, pt(rg.beacons[0])) });
    pushEdit(undo, was ? 'Undo: area left out again' : 'Undo: area put back');
    S.msg = null;
    refresh();
    return { ok: true, area: rid, excluded: !was };
  }

  /* --------------------------------------------------------- beacon edits */

  /* Under a pointer event: the first placed piece hit, the point and the
     face's outward normal in Z-up world. */
  function hitAt(ev) {
    if (!state.raycaster || !state.camera || !state.renderer) return null;
    setPointerFromEvent(ev);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    var meshes = (state.placed || []).filter(function (p) { return p && p.mesh && p.mesh.visible !== false; })
      .map(function (p) { return p.mesh; });
    var hits = state.raycaster.intersectObjects(meshes, false);
    if (!hits.length) return null;
    var h = hits[0], p = (state.placed || []).find(function (q) { return q && q.mesh === h.object; });
    if (!p) return null;
    var n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : new THREE.Vector3(0, -1, 0);
    return { placed: p, id: p.sourceId, p: viewToUp(h.point), n: viewToUp(n) };
  }
  /* The area under the pointer: the nearest of the areas' cells along the
     ray. The outlines show through the piece (an overhang's underside is
     rarely in view), so the cell under the pointer counts whether or not the
     face in front of it is the one it is on. */
  function areaAt(ev) {
    if (!S.geo || !state.raycaster || !state.camera) return null;
    setPointerFromEvent(ev);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    var ray = state.raycaster.ray, best = null, bd = Infinity, hit = new THREE.Vector3();
    var ro = viewToUp(ray.origin), rd = viewToUp(ray.direction);       // the same ray, Z up (a rotation: distances along it are the same)
    Object.keys(S.geo).forEach(function (id) {
      var gf = S.geo[id];
      /* an area with an outline of its own is hit where the ray meets the plane of one of its spots inside that outline */
      if (gf.fp) gf.planes.forEach(function (pl) {
        var den = pl.n[0] * rd[0] + pl.n[1] * rd[1] + pl.n[2] * rd[2];
        if (Math.abs(den) < 1e-6) return;
        var t = (pl.n[0] * (pl.p[0] - ro[0]) + pl.n[1] * (pl.p[1] - ro[1]) + pl.n[2] * (pl.p[2] - ro[2])) / den;
        if (t < 0 || t >= bd) return;
        if (inFootprint(gf.fp, ro[0] + t * rd[0], ro[1] + t * rd[1])) { bd = t; best = Number(id); }
      });
      gf.cells.forEach(function (c) {
        var q = c.quad.map(upToView);
        var at = ray.intersectTriangle(q[0], q[1], q[2], false, hit) || ray.intersectTriangle(q[0], q[2], q[3], false, hit);
        if (at) { var d = at.distanceTo(ray.origin); if (d < bd) { bd = d; best = Number(id); } }
      });
    });
    return best;
  }

  function pushEdit(undo, label) {
    pushUndo({ type: 'supportSwap', removed: [], addedIds: [], label: label, onUndone: undo });
    if (typeof updateUndoBtn === 'function') updateUndoBtn();
  }

  /* A manual beacon at a Z-up point on the picked piece, from the face's own
     normal. Refused on a face that looks up. */
  function addBeacon(p, n) {
    var host = placedOf(S.hostId), m = modelOf(S.hostId);
    if (!host || !m) return { ok: false, reason: 'no piece' };
    if (n[2] > UP_MAX) {
      S.msg = { text: 'That face looks up - nothing hangs from it. Shift-click a side or the underside.', bad: true };
      sync();
      return { ok: false, reason: 'face looks up' };
    }
    var undo = snapshot(), E = editsOf(m);
    E.ops.push({ op: 'add', id: ++E.serial, p: upToLocal(host, p), n: upDirToLocal(host, n) });
    pushEdit(undo, 'Undo: manual spot taken away');
    S.msg = null;
    refresh();
    var b = S.eff.beacons.find(function (x) { return x.key === 'm' + E.serial; });
    return { ok: true, key: 'm' + E.serial, region: b ? b.region : null };
  }


  /* ---------------------------------------------------------------- paint */

  function paintOps(m) { return m ? editsOf(m).ops.filter(function (o) { return o.op === 'paint'; }) : []; }
  function paintCount() { return paintOps(modelOf(S.hostId)).length; }
  function brushR() {
    var e = $('sup-brush'), v = e ? parseFloat(e.value) : NaN;
    return v > 0 ? Math.min(10, Math.max(0.4, v / 2)) : PAINT_R_DEFAULT;
  }
  /* the spots a stroke asks for: its samples thinned to PAINT_SPOT_MM, the faces that look up left out; [{ w: Z-up point, n: Z-up normal }] */
  function paintSpotsOf(op, p) {
    var out = [];
    (op.pts || []).forEach(function (s) {
      var n = localDirToUp(p, s.n);
      if (n[2] > paintNz()) return;
      var w = localToUp(p, s.p);
      for (var k = 0; k < out.length; k++) if (dist(out[k].w, w) < PAINT_SPOT_MM) return;
      out.push({ w: w, n: n });
    });
    return out;
  }
  /* The footprints the raft is laid on, with the paint in them: a detected footprint the brush went over keeps its plate to its edge
     (marginMm); the cells the brush covered that no detected footprint holds are footprints of their own (zl, zh from the stroke's heights and
     the brush's reach), traced from the covered cells as the raft traces its layers. */
  function paintFootprints(m, host, fps) {
    var SI = window.NSO_SupportInterface, R = SI && SI.region, pts = [], CELL = 0.2;
    if (!R || !m || !host) return fps;
    paintOps(m).forEach(function (op) {
      (op.pts || []).forEach(function (s) {
        var n = localDirToUp(host, s.n);
        if (n[2] > paintNz()) return;
        var w = localToUp(host, s.p);
        pts.push([w[0], w[1], w[2], op.r || PAINT_R_DEFAULT]);
      });
    });
    if (!pts.length) return fps;
    var inLoops = function (loops, x, y) {
      var inn = false;
      for (var li = 0; li < loops.length; li++) {
        var L = loops[li];
        for (var q = 0, w = L.length - 1; q < L.length; w = q++) if ((L[q][1] > y) !== (L[w][1] > y) && x < (L[w][0] - L[q][0]) * (y - L[q][1]) / (L[w][1] - L[q][1]) + L[q][0]) inn = !inn;
      }
      return inn;
    };
    var out = fps.map(function (f) {
      var painted = pts.some(function (q) { return q[2] >= f.zl - 0.5 && q[2] <= f.zh + 1.5 && inLoops(f.loops, q[0], q[1]); });
      return painted ? Object.assign({}, f, { marginMm: PAINT_MARGIN_MM }) : f;
    });
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(function (q) { x0 = Math.min(x0, q[0] - q[3]); y0 = Math.min(y0, q[1] - q[3]); x1 = Math.max(x1, q[0] + q[3]); y1 = Math.max(y1, q[1] + q[3]); });
    var ox = x0 - 2 * CELL, oy = y0 - 2 * CELL, nx = Math.ceil((x1 - ox) / CELL) + 3, ny = Math.ceil((y1 - oy) / CELL) + 3, N = nx * ny, M = new Uint8Array(N);
    if (N > 4e6) return out;                                      // a stroke across the whole plate: not a region to trace
    pts.forEach(function (q) {
      var rc = Math.ceil(q[3] / CELL), ci = Math.round((q[0] - ox) / CELL), cj = Math.round((q[1] - oy) / CELL);
      for (var dj = -rc; dj <= rc; dj++) for (var di = -rc; di <= rc; di++) {
        if (Math.hypot(di, dj) * CELL > q[3]) continue;
        var k = (cj + dj) * nx + ci + di;
        if (k >= 0 && k < N) M[k] = 1;
      }
    });
    for (var cj2 = 0; cj2 < ny; cj2++) for (var ci2 = 0; ci2 < nx; ci2++) {
      var k2 = cj2 * nx + ci2;
      if (!M[k2]) continue;
      var xx = ox + ci2 * CELL, yy = oy + cj2 * CELL;
      for (var fi = 0; fi < fps.length; fi++) if (inLoops(fps[fi].loops, xx, yy)) { M[k2] = 0; break; }
    }
    /* the pieces of what is left, each with the heights of the strokes that touch it */
    var lab = new Int32Array(N), comps = [];
    for (var s0 = 0; s0 < N; s0++) {
      if (!M[s0] || lab[s0]) continue;
      var id = comps.length + 1, stack = [s0], cells = 0;
      lab[s0] = id;
      while (stack.length) {
        var c = stack.pop(); cells++;
        var cx = c % nx;
        [c - 1, c + 1, c - nx, c + nx].forEach(function (d) {
          if (d < 0 || d >= N || M[d] === 0 || lab[d]) return;
          if ((d === c - 1 && cx === 0) || (d === c + 1 && cx === nx - 1)) return;
          lab[d] = id; stack.push(d);
        });
      }
      comps.push({ id: id, cells: cells, zl: Infinity, zh: -Infinity });
    }
    pts.forEach(function (q) {
      var ci = Math.round((q[0] - ox) / CELL), cj = Math.round((q[1] - oy) / CELL), rc = Math.ceil(q[3] / CELL), seen = {};
      for (var dj = -rc; dj <= rc; dj++) for (var di = -rc; di <= rc; di++) {
        var k = (cj + dj) * nx + ci + di;
        if (k < 0 || k >= N || !lab[k] || seen[lab[k]]) continue;
        seen[lab[k]] = 1;
        var cp = comps[lab[k] - 1], reach = q[3] * 1.2 + 0.3;
        cp.zl = Math.min(cp.zl, q[2] - reach); cp.zh = Math.max(cp.zh, q[2] + reach);
      }
    });
    comps.forEach(function (cp) {
      if (cp.cells * CELL * CELL < 1 || !isFinite(cp.zl)) return;
      var Mc = new Uint8Array(N);
      for (var q = 0; q < N; q++) if (lab[q] === cp.id) Mc[q] = 1;
      var loops = R.isoLoops(R.edtCells(Mc, nx, ny), nx, ny, 0.5).map(function (ring) {
        return ring.map(function (v) { return [ox + v[0] * CELL, oy + v[1] * CELL]; });
      }).filter(function (L) { return L.length >= 4; });
      if (loops.length) out.push({ zl: cp.zl, zh: cp.zh, loops: loops, marginMm: PAINT_MARGIN_MM, painted: true });
    });
    return out;
  }

  /* The brush's hit: the first face along the pointer's ray, through the piece if need be, that the card calls hanging (paintNz) - so a stroke over the
     top of the piece, from above, paints the underside the card outlines through it, as the outline is seen. Null when the ray meets no such face. */
  function hitDown(ev) {
    var host = placedOf(S.hostId);
    if (!host || !host.mesh || !state.raycaster || !state.camera || !state.renderer) return null;
    setPointerFromEvent(ev);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    /* from above, the faces that hang are the back faces of the mesh, which a ray does not meet unless the material is double-sided for the cast */
    var mats = [].concat(host.mesh.material || []), was = mats.map(function (m) { return m.side; });
    mats.forEach(function (m) { m.side = THREE.DoubleSide; });
    var hits = state.raycaster.intersectObject(host.mesh, false);
    mats.forEach(function (m, k) { m.side = was[k]; });
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (!h.face) continue;
      var n = viewToUp(h.face.normal.clone().transformDirection(h.object.matrixWorld));
      if (n[2] <= paintNz()) return { placed: host, id: host.sourceId, p: viewToUp(h.point), n: n };
    }
    return null;
  }
  function setPaint(on) {
    if (on && (S.hostId == null || !placedOf(S.hostId) || S.wide)) return { ok: false, reason: S.wide ? 'on the plate: pick one piece' : 'no piece' };
    S.paint = !!on;
    if (!on) S.stroke = null;
    if (on && (S.tool === 'circles' || S.tool === 'erase')) { endDragQuiet(); S.tool = 'tips'; }
    sync();
    drawPaint();
    return { ok: true, on: S.paint };
  }
  function endDragQuiet() { if (S.drag) cancelDrag(); }
  function round3(v) { return Math.round(v * 1000) / 1000; }
  function addStrokePoint(h) {
    var st = S.stroke, host = placedOf(S.hostId);
    if (!st || !host || h.id !== S.hostId || st.pts.length >= PAINT_MAX) return;
    var l = upToLocal(host, h.p);
    if (st.last && Math.hypot(l[0] - st.last[0], l[1] - st.last[1], l[2] - st.last[2]) < PAINT_STEP_MM) return;
    st.last = l;
    st.pts.push({ p: l.map(round3), n: upDirToLocal(host, h.n).map(round3) });
  }
  function commitStroke(pts, r) {
    var m = modelOf(S.hostId);
    if (!m || !pts.length) return { ok: false, reason: 'nothing painted' };
    var undo = snapshot(), E = editsOf(m);
    E.ops.push({ op: 'paint', id: ++E.serial, r: r, pts: pts });
    pushEdit(undo, 'Undo: painted area taken away');
    S.msg = null;
    refresh();
    return { ok: true, id: E.serial };
  }
  function endStroke() {
    var st = S.stroke;
    S.stroke = null;
    if (!st || !st.pts.length) { drawPaint(); return null; }
    S.noClickUntil = Date.now() + 400;                     // the click the browser sends after this release is the stroke's, not the app's: it would pick or drop a piece
    return commitStroke(st.pts, st.r);
  }
  /* a stroke by number, for the page's own callers (tests, a script): [{ p: [x, y, z], n: [nx, ny, nz] }] in Z up, the brush's radius in mm */
  function paintStroke(list, r) {
    var host = placedOf(S.hostId);
    if (!host || !modelOf(S.hostId)) return { ok: false, reason: 'no piece' };
    S.stroke = { pts: [], last: null, r: r > 0 ? +r : PAINT_R_DEFAULT };
    list.forEach(function (s) { addStrokePoint({ id: S.hostId, p: s.p, n: s.n }); });
    return endStroke() || { ok: false, reason: 'nothing painted' };
  }
  function clearPaint() {
    var m = modelOf(S.hostId);
    if (!m || !paintCount()) return { ok: false, reason: 'no paint' };
    var undo = snapshot(), E = editsOf(m);
    E.ops = E.ops.filter(function (o) { return o.op !== 'paint'; });
    pushEdit(undo, 'Undo: paint put back');
    refresh();
    return { ok: true };
  }
  /* the paint, drawn over the piece: one translucent dot for every sample, the size of the brush */
  /* the host's triangles for the stain, in the piece's own frame: the big ones cut until no edge is over 1 mm (so a stain can follow a brush's edge across a flat
     face), each with its centre and its normal; kept while the mesh is the same */
  function stainTris(host) {
    var geo = host.mesh.geometry, c = S.stainCache;
    if (c && c.geo === geo && c.count === geo.attributes.position.count) return c;
    var pos = geo.attributes.position, idx = geo.index, nT = idx ? idx.count / 3 : pos.count / 3, out = [], MAXE = 1.0, cap = 600000;
    function vert(i) { return [pos.getX(i), pos.getY(i), pos.getZ(i)]; }
    function push(a, b, d, depth) {
      var e0 = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), e1 = Math.hypot(d[0] - b[0], d[1] - b[1], d[2] - b[2]), e2 = Math.hypot(a[0] - d[0], a[1] - d[1], a[2] - d[2]);
      if (depth < 6 && Math.max(e0, e1, e2) > MAXE && out.length < cap) {
        var ab = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], bd = [(b[0] + d[0]) / 2, (b[1] + d[1]) / 2, (b[2] + d[2]) / 2], da = [(d[0] + a[0]) / 2, (d[1] + a[1]) / 2, (d[2] + a[2]) / 2];
        push(a, ab, da, depth + 1); push(ab, b, bd, depth + 1); push(da, bd, d, depth + 1); push(ab, bd, da, depth + 1);
        return;
      }
      var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, L = Math.hypot(nx, ny, nz) || 1;
      out.push({ v: [a, b, d], c: [(a[0] + b[0] + d[0]) / 3, (a[1] + b[1] + d[1]) / 3, (a[2] + b[2] + d[2]) / 3], n: [nx / L, ny / L, nz / L] });
    }
    for (var t = 0; t < nT; t++) {
      var i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      push(vert(i0), vert(i1), vert(i2), 0);
    }
    S.stainCache = { geo: geo, count: pos.count, tris: out };
    return S.stainCache;
  }
  /* THE STAIN: the paint is drawn ON the faces the brush covered - the piece's own triangles, lifted 0.03 mm, those within a brush radius of a sample that hang (a wall or a
     top face under the brush is not painted: it asks for nothing) - and not as discs in the air over it: where the brush went is where the stain is. Twice: solid on the
     face (hidden when the face is behind the piece, from above), and faint through the piece, so a stroke over the top of the piece shows the underside it painted. */
  function drawPaint() {
    dispose(S.paintLayer); S.paintLayer = null;
    var m = modelOf(S.hostId), host = placedOf(S.hostId);
    if (!S.open || S.wide || !m || !host || !host.mesh || !host.mesh.geometry || !state.scene || typeof THREE === 'undefined') return;
    var items = [];
    paintOps(m).forEach(function (op) { (op.pts || []).forEach(function (s) { items.push([s.p, op.r || PAINT_R_DEFAULT]); }); });
    if (S.stroke) S.stroke.pts.forEach(function (s) { items.push([s.p, S.stroke.r]); });
    if (!items.length) return;
    host.mesh.updateMatrixWorld(true);
    var E = host.mesh.matrixWorld.elements, sc = Math.hypot(E[0], E[1], E[2]) || 1, nzMax = paintNz();
    var rMax = 0;
    items.forEach(function (it) { rMax = Math.max(rMax, it[1]); });
    var cell = Math.max(0.5, rMax), grid = new Map();
    items.forEach(function (it, i) {
      var k = Math.floor(it[0][0] / cell) + ',' + Math.floor(it[0][1] / cell) + ',' + Math.floor(it[0][2] / cell);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    });
    var tris = stainTris(host).tris, pos = [], LIFT = 0.03;
    for (var t = 0; t < tris.length; t++) {
      var tr = tris[t];
      /* hanging: the normal's Z-up component (the view's y) under the card's limit */
      var wy = (E[1] * tr.n[0] + E[5] * tr.n[1] + E[9] * tr.n[2]) / sc;
      if (wy > nzMax) continue;
      var cx = Math.floor(tr.c[0] / cell), cy = Math.floor(tr.c[1] / cell), cz = Math.floor(tr.c[2] / cell), hit = false;
      for (var dx = -1; dx <= 1 && !hit; dx++) for (var dy = -1; dy <= 1 && !hit; dy++) for (var dz = -1; dz <= 1 && !hit; dz++) {
        var lst = grid.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
        if (!lst) continue;
        for (var q = 0; q < lst.length; q++) {
          var it2 = items[lst[q]], p = it2[0], r2 = it2[1] * it2[1];
          var d0 = (tr.c[0] - p[0]) * (tr.c[0] - p[0]) + (tr.c[1] - p[1]) * (tr.c[1] - p[1]) + (tr.c[2] - p[2]) * (tr.c[2] - p[2]);
          if (d0 <= r2) { hit = true; break; }
        }
      }
      if (!hit) continue;
      for (var k2 = 0; k2 < 3; k2++) pos.push(tr.v[k2][0] + tr.n[0] * LIFT, tr.v[k2][1] + tr.n[1] * LIFT, tr.v[k2][2] + tr.n[2] * LIFT);
    }
    if (!pos.length) return;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    var g = new THREE.Group();
    g.name = 'supportsCardPaint';
    function layer(opacity, depthTest, order) {
      var mat = new THREE.MeshBasicMaterial({ color: PAINT_COL, side: THREE.DoubleSide, transparent: true, opacity: opacity, depthTest: depthTest, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false; mesh.matrix.copy(host.mesh.matrixWorld); mesh.matrixWorldNeedsUpdate = true;
      mesh.renderOrder = order; mesh.userData.skipXray = true; mesh.frustumCulled = false;
      return mesh;
    }
    g.add(layer(0.16, false, MARK_ORDER), layer(0.6, true, MARK_ORDER + 1));
    S.paintMat = E.join(',');
    S.paintLayer = g;
    if (typeof nsoHelpers !== 'undefined') nsoHelpers.attach(state.scene, g, 'supports-card'); else state.scene.add(g);
  }

  /* ------------------------------------------------------------- markers */

  /* The spots (Assisted) or the tips (Custom), the circles, and the eraser's
     light: drawn over everything (depth test off, MARK_ORDER), and they own the
     pointer while their tool is on - hit-tested by the card on the press, as the
     rotate rings are, and never by the scene (nsoHelpers.attach: no raycast). */
  function mark(o) {
    o.renderOrder = MARK_ORDER; o.userData.skipXray = true; o.frustumCulled = false;
    if (typeof nsoHelpers !== 'undefined') nsoHelpers.attach(state.scene, o, 'supports-card'); else state.scene.add(o);
    return o;
  }
  function dotMap(ring) {
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var g = c.getContext('2d');
    g.beginPath(); g.arc(32, 32, 28, 0, Math.PI * 2);
    if (ring) { g.lineWidth = 9; g.strokeStyle = '#fff'; g.stroke(); g.beginPath(); g.arc(32, 32, 11, 0, Math.PI * 2); }
    g.fillStyle = '#fff'; g.fill();
    var t = new THREE.CanvasTexture(c);
    return t;
  }
  var COL = { on: 0xf1f5f9, off: 0x566074, bad: 0xff2d2d, tip: 0xffb020, hot: 0xffe066, held: 0x86efac };
  function spotColor(b, st) {
    if (b.off) return COL.off;
    if (st[b.key] === 'unreachable') return COL.bad;
    return b.tip ? COL.tip : st[b.key] === 'held' || st[b.key] === 'rest' ? COL.held : COL.on;
  }
  function drawMarkers(eff) {
    var st = statesFor(eff), n = eff.beacons.length, tips = S.mode === 'custom';
    if (n) {
      var pos = new Float32Array(n * 3), col = new Float32Array(n * 3), c = new THREE.Color();
      eff.beacons.forEach(function (b, i) {
        var v = upToView(pt(b));
        pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
        c.setHex(spotColor(b, st)); col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      });
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      var pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: tips ? 14 : 8, sizeAttenuation: false, vertexColors: true,
        map: dotMap(tips), alphaTest: 0.25, transparent: true, depthTest: false, depthWrite: false }));
      pts.name = 'supportsCardPoints';
      pts.userData.keys = eff.beacons.map(function (b) { return b.key; });
      S.pts = mark(pts);
    }
    drawZones();
    drawErase();
  }
  /* The width the plate's circles are drawn at: about two pixels, wherever the camera is. */
  function mmPerPx(v) {
    var cam = state.camera, el = state.renderer && state.renderer.domElement;
    if (!cam || !el) return 0.2;
    return Math.max(1e-3, cam.position.distanceTo(v) * 2 * Math.tan((cam.fov || 45) * Math.PI / 360) / Math.max(1, el.clientHeight));
  }
  function drawZones() {
    dispose(S.zoneLayer); S.zoneLayer = null;
    var m = modelOf(S.hostId);
    if (!S.open || S.mode === 'auto' || !m || !state.scene) return;
    var F = feedOf(m), mem = memOf(S.hostId);
    if (!F.zones.length) return;
    var g = new THREE.Group();
    g.name = 'supportsCardZones';
    F.zones.forEach(function (z, i) {
      var sel = S.tool === 'circles' && S.sel === i, empty = mem.built && mem.zonesEmpty.indexOf(i) >= 0;
      var color = sel ? 0xfacc15 : empty ? 0xff2d2d : 0x38bdf8, w = mmPerPx(new THREE.Vector3(z.x, 0, -z.y)) * (sel ? 3 : 2);
      var ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(0.01, z.r - w), z.r + w, 72),
        new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }));
      var disc = new THREE.Mesh(new THREE.CircleGeometry(z.r, 72),
        new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide, transparent: true, opacity: sel ? 0.22 : 0.12, depthTest: false, depthWrite: false }));
      [ring, disc].forEach(function (o) { o.rotation.x = -Math.PI / 2; o.position.set(z.x, 0.08, -z.y); o.renderOrder = MARK_ORDER; g.add(o); });
    });
    S.zoneLayer = mark(g);
  }

  /* -------------------------------------------- the points: spots and tips */

  function edit(label, fn) {
    var m = modelOf(S.hostId), host = placedOf(S.hostId);
    if (!m || !host || S.busy) return { ok: false, reason: S.busy ? 'busy' : 'no piece' };
    var undo = snapshot(), r = fn(feedOf(m), m, host);
    if (r === false) return { ok: false, reason: 'nothing changed' };
    pushEdit(undo, label);
    S.msg = null;
    refresh();
    return Object.assign({ ok: true }, r && typeof r === 'object' ? r : {});
  }
  function spotByKey(key) { return S.eff && S.eff.beacons.find(function (b) { return b.key === key; }); }

  /* ASSISTED: a click on a spot turns it off (it is not a tip) or back on. A
     spot the eraser took out is put back the same way. */
  function toggleSpot(key) {
    if (S.mode !== 'assisted') return { ok: false, reason: 'not Assisted' };
    var b = spotByKey(key);
    if (!b) return { ok: false, reason: 'no such spot' };
    return edit(b.off ? 'Undo: spot turned off again' : 'Undo: spot turned back on', function (F, m, host) {
      var w = pt(b);
      if (b.erased) { F.erased = F.erased.filter(function (id) { return id !== b.id; }); return { key: key, off: false }; }
      if (b.off) {
        F.off = F.off.filter(function (o) { return dist(localToUp(host, o.p), w) > OFF_TOL_MM; });
        return { key: key, off: false };
      }
      F.off.push({ p: upToLocal(host, w) });
      return { key: key, off: true };
    });
  }
  /* CUSTOM: a click on the piece places a tip there, from the face's own
     normal; refused on a face that looks up. */
  function placeTip(p, n) {
    if (S.mode !== 'custom') return { ok: false, reason: 'not Custom' };
    if (n[2] > UP_MAX) {
      S.msg = { text: 'That face looks up - nothing hangs from it. Click a side or the underside.', bad: true };
      sync();
      return { ok: false, reason: 'face looks up' };
    }
    return edit('Undo: tip taken away', function (F, m, host) {
      var id = ++F.serial;
      F.tips.push({ id: id, p: upToLocal(host, p), n: upDirToLocal(host, n) });
      return { id: id };
    });
  }
  function removeTip(id) {
    if (S.mode !== 'custom') return { ok: false, reason: 'not Custom' };
    return edit('Undo: tip put back', function (F) {
      var k = F.tips.findIndex(function (t) { return t.id === id; });
      if (k < 0) return false;
      F.tips.splice(k, 1);
      return { id: id };
    });
  }
  /* The spot or tip under the pointer, in pixels: a tip before a spot. */
  function spotAt(ev) {
    if (!S.eff || !state.camera || !state.renderer) return null;
    var el = state.renderer.domElement, r = el.getBoundingClientRect(), best = null, bd = Infinity, v = new THREE.Vector3();
    state.camera.updateMatrixWorld();
    S.eff.beacons.forEach(function (b) {
      v.copy(upToView(pt(b))).project(state.camera);
      if (v.z > 1 || v.z < -1) return;
      var dx = r.left + (v.x * 0.5 + 0.5) * r.width - ev.clientX, dy = r.top + (-v.y * 0.5 + 0.5) * r.height - ev.clientY;
      var d = Math.hypot(dx, dy) - (b.tip ? 4 : 0);
      if (d <= PICK_PX && d < bd) { bd = d; best = b; }
    });
    return best;
  }
  function markerDown(ev) {
    var b = spotAt(ev);
    if (!b) return false;
    if (S.mode === 'custom') removeTip(b.tipId); else toggleSpot(b.key);
    return true;
  }
  function setHot(i) {
    if (!S.pts || S.hot === i) return;
    var col = S.pts.geometry.getAttribute('color'), st = statesFor(S.eff), c = new THREE.Color();
    if (S.hot != null && S.eff.beacons[S.hot]) { c.setHex(spotColor(S.eff.beacons[S.hot], st)); col.setXYZ(S.hot, c.r, c.g, c.b); }
    if (i != null) { c.setHex(COL.hot); col.setXYZ(i, c.r, c.g, c.b); }
    col.needsUpdate = true;
    S.hot = i;
    paintCursor();
  }

  /* ------------------------------------------------------------- circles */

  function zonesOf() { var m = modelOf(S.hostId); return m && S.mode !== 'auto' ? feedOf(m).zones : []; }
  /* The pointer on the plate (Z up, mm), or null off the plate: the ray meets the
     plane through the pieces, so a circle may be drawn under one. */
  function plateAt(ev) {
    if (!state.raycaster || !state.camera || !state.renderer) return null;
    setPointerFromEvent(ev);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    var hit = new THREE.Vector3();
    if (!state.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return null;
    var pl = typeof getCurrentPlate === 'function' ? getCurrentPlate() : null;
    if (pl && (Math.abs(hit.x) > pl.w / 2 || Math.abs(hit.z) > pl.d / 2)) return null;
    return { x: hit.x, y: -hit.z, v: hit };
  }
  function zoneAt(P) {
    var zs = zonesOf(), tol = mmPerPx(P.v) * PICK_PX;
    for (var i = zs.length - 1; i >= 0; i--) {
      var d = Math.hypot(P.x - zs[i].x, P.y - zs[i].y);
      if (Math.abs(d - zs[i].r) <= tol) return { i: i, edge: true };
    }
    for (i = zs.length - 1; i >= 0; i--) {
      if (Math.hypot(P.x - zs[i].x, P.y - zs[i].y) < zs[i].r) return { i: i, edge: false };
    }
    return null;
  }
  /* The press, with CIRCLES on. On the plate it is ours: on a circle's edge it
     resizes, inside a circle it moves (or, with no travel, selects) and on bare
     plate it draws a new one from its centre. Off the plate it is the view's. */
  function circleDown(ev) {
    var m = modelOf(S.hostId), P = plateAt(ev);
    if (!m || !P) return false;
    var hit = zoneAt(P), F = feedOf(m), zs = F.zones;
    var d = { undo: snapshot(), mode: hit ? (hit.edge ? 'size' : 'move') : 'new', i: hit ? hit.i : -1, from: P, was: hit ? Object.assign({}, zs[hit.i]) : null, moved: false, id: ev.pointerId };
    if (hit) {
      S.sel = hit.i;
    } else {
      S.sel = null;
    }
    S.drag = d;
    window.addEventListener('pointermove', dragMove, true);
    window.addEventListener('pointerup', dragUp, true);
    drawZones(); sync();
    return true;
  }
  function dragMove(ev) {
    var d = S.drag, P = plateAt(ev) || (d && lastPlate);
    if (!d || !P) return;
    lastPlate = P;
    var m = modelOf(S.hostId), zs = m ? feedOf(m).zones : null;
    if (!zs) return;
    var travel = Math.hypot(P.x - d.from.x, P.y - d.from.y);
    if (travel < mmPerPx(P.v) * 3 && !d.moved) return;           // a click is not a drag
    d.moved = true;
    if (d.mode === 'new') {
      var r = travel;
      if (d.i < 0 && r >= ZONE_MIN_R) { zs.push({ x: d.from.x, y: d.from.y, r: r }); d.i = zs.length - 1; S.sel = d.i; }
      else if (d.i >= 0) zs[d.i].r = Math.max(ZONE_MIN_R, r);
    } else if (d.mode === 'size') {
      zs[d.i].r = Math.max(ZONE_MIN_R, Math.hypot(P.x - zs[d.i].x, P.y - zs[d.i].y));
    } else {
      zs[d.i].x = d.was.x + (P.x - d.from.x);
      zs[d.i].y = d.was.y + (P.y - d.from.y);
    }
    drawZones();
  }
  var lastPlate = null;
  function endDrag() {
    window.removeEventListener('pointermove', dragMove, true);
    window.removeEventListener('pointerup', dragUp, true);
    var d = S.drag; S.drag = null; lastPlate = null;
    return d;
  }
  function dragUp() {
    var d = endDrag();
    if (!d) return;
    var m = modelOf(S.hostId);
    if (d.moved && m) {
      pushEdit(d.undo, d.mode === 'new' ? 'Undo: circle taken away' : d.mode === 'size' ? 'Undo: circle back to its size' : 'Undo: circle back where it was');
      S.msg = null;
      refresh();
    } else { drawZones(); sync(); }
  }
  function cancelDrag() {
    var d = endDrag();
    if (d) { d.undo(); }
  }
  function removeZone(i) {
    return edit('Undo: circle put back', function (F) {
      if (!F.zones[i]) return false;
      F.zones.splice(i, 1);
      S.sel = null;
      return { zone: i };
    });
  }
  /* A circle by number, for the page's own callers (tests, a script). */
  function addZone(x, y, r) {
    if (S.mode === 'auto') return { ok: false, reason: 'Auto takes no landing circles' };
    if (!(r >= ZONE_MIN_R)) return { ok: false, reason: 'too small' };
    return edit('Undo: circle taken away', function (F) { F.zones.push({ x: +x, y: +y, r: +r }); S.sel = F.zones.length - 1; return { zone: F.zones.length - 1 }; });
  }

  /* -------------------------------------------------------------- eraser */

  function eraseReady() {
    var mem = S.hostId != null ? memOf(S.hostId) : null;
    return !!(mem && mem.built && mem.members.length && S.mode !== 'auto' && supportsOf(S.hostId).length);
  }
  var RANK = { tip: 0, sheet: 1, branch: 2, trunk: 3, pad: 4 };
  /* A member and everything it holds up: the members whose carries are among
     its own and that sit above it in the tree (a tip, a branch, a trunk; the
     sheet under the part rides with what carries its tips). */
  function litBy(id) {
    var mem = memOf(S.hostId), M = mem.members.find(function (x) { return x.id === id; });
    if (!M) return [];
    var has = {};
    M.carries.forEach(function (t) { has[t] = true; });
    return mem.members.filter(function (x) {
      if (x.id === id) return true;
      return RANK[x.kind] < RANK[M.kind] && x.carries.length && x.carries.every(function (t) { return has[t]; });
    });
  }
  /* The built member under the pointer: nearest, in pixels, to its line (its
     two ends), within PICK_PX; a pad or a sheet is never one (the planner does
     not erase those on their own). Ties go to the one nearer the camera. */
  function memberAt(ev) {
    if (!S.hostId || !state.camera || !state.renderer) return null;
    var el = state.renderer.domElement, r = el.getBoundingClientRect(), best = null, bd = Infinity, bz = Infinity;
    state.camera.updateMatrixWorld();
    function px(q) {
      var v = upToView(q).project(state.camera);
      return [r.left + (v.x * 0.5 + 0.5) * r.width, r.top + (-v.y * 0.5 + 0.5) * r.height, v.z];
    }
    memOf(S.hostId).members.forEach(function (M) {
      if (M.kind !== 'tip' && M.kind !== 'branch' && M.kind !== 'trunk') return;
      var a = px(M.from), b = px(M.to), dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
      var t = L2 ? Math.max(0, Math.min(1, ((ev.clientX - a[0]) * dx + (ev.clientY - a[1]) * dy) / L2)) : 0;
      var d = Math.hypot(a[0] + dx * t - ev.clientX, a[1] + dy * t - ev.clientY), z = a[2] + (b[2] - a[2]) * t;
      if (d > PICK_PX) return;
      if (d < bd - 1.5 || (Math.abs(d - bd) <= 1.5 && z < bz)) { bd = d; bz = z; best = M.id; }
    });
    return best;
  }
  function drawErase() {
    dispose(S.eraseLayer); S.eraseLayer = null;
    if (!S.open || S.tool !== 'erase' || !S.hover || !state.scene) return;
    var g = new THREE.Group(), mem = memOf(S.hostId);
    g.name = 'supportsCardErase';
    litBy(S.hover).forEach(function (M) {
      var a = upToView(M.from), b = upToView(M.to), len = a.distanceTo(b);
      if (len < 1e-6) return;
      var hot = M.id === S.hover, rad = hot ? 0.9 : 0.6;
      var cyl = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, 10, 1, false),
        new THREE.MeshBasicMaterial({ color: hot ? 0xff7a1a : 0xffd27a, transparent: true, opacity: hot ? 0.95 : 0.85, depthTest: false, depthWrite: false }));
      cyl.position.copy(a).add(b).multiplyScalar(0.5);
      cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      cyl.renderOrder = MARK_ORDER + 1;
      g.add(cyl);
    });
    S.eraseLayer = mark(g);
  }
  function hoverMember(id) {
    if (S.hover === id) return;
    S.hover = id;
    drawErase();
    paintCursor();
  }
  /* ERASE: the member is taken out and the plan made again - every support on
     the piece replaced, one Undo. A build that cannot finish leaves the
     member where it was. */
  function eraseMember(id) {
    var m = modelOf(S.hostId);
    if (S.busy || !m || !eraseReady() || !memOf(S.hostId).members.some(function (x) { return x.id === id; })) return Promise.resolve({ ok: false, reason: 'nothing to erase' });
    var undo = snapshot(), F = feedOf(m);
    F.erased.push(id);
    S.hover = null;
    return generate({ undo: undo }).then(function (res) { if (!res.ok) undo(); return res; });
  }

  /* ----------------------------------------------- the switch and the tools */

  function setMode(k) {
    if (!MODES[k]) return { ok: false, reason: 'no such mode' };
    if (S.busy) return { ok: false, reason: 'busy' };
    cancelDrag();
    S.mode = k; S.tool = 'tips'; S.sel = null; S.hover = null; S.msg = null;
    refresh();
    return { ok: true, mode: k };
  }
  /* TUNE: a field typed in is read at once and nothing is built - the card only
     notes that the build is out of date. DEFAULTS puts all four back. Neither is
     an Undo step: they are settings, as the angle is. */
  function setKnob(key, v) {
    var K = KNOBS.find(function (k) { return k.key === key; });
    if (!K) return { ok: false, reason: 'no such knob' };
    if (S.busy) return { ok: false, reason: 'busy' };
    var n = typeof v === 'number' ? v : (String(v).trim() === '' ? NaN : Number(v));
    if (n === K.def) delete S.knobs[key]; else S.knobs[key] = n;
    var el = $(K.id);
    if (el && document.activeElement !== el && el.value !== String(v)) el.value = String(v);
    if (S.msg && S.msg.knob) S.msg = null;
    sync();
    return { ok: true, value: knobValue(K) };
  }
  function tuneDefaults() {
    if (S.busy) return { ok: false, reason: 'busy' };
    S.knobs = {};
    KNOBS.forEach(function (K) { var e = $(K.id); if (e) e.value = String(K.def); });
    if (S.msg && S.msg.knob) S.msg = null;
    sync();
    return { ok: true };
  }
  function setTool(k) {
    if (!TOOLS[k]) return { ok: false, reason: 'no such tool' };
    if (S.busy || S.mode === 'auto') return { ok: false, reason: S.busy ? 'busy' : 'Auto has no tools' };
    if (k === 'erase' && !eraseReady()) return { ok: false, reason: 'nothing built to erase' };
    cancelDrag();
    S.paint = false; S.stroke = null;                          // one thing holds the pointer at a time
    S.tool = k === S.tool && k !== 'tips' ? 'tips' : k;       // a tool that is on, pressed again, is stopped
    S.sel = null; S.hover = null; S.msg = null;
    draw(); sync();
    return { ok: true, tool: S.tool };
  }
  /* CLEAR PLATE: the models are gone, so is everything the card kept about
     them - the host, the tips, circles and erasures fed in, what was detected. */
  function forgetAll() {
    cancelDrag();
    S.mem = {}; S.hostId = null; S.selSupport = null; S.det = null; S.dets = {}; S.eff = null; S.occ = {};
    S.tool = 'tips'; S.sel = null; S.hover = null; S.hot = null; S.paint = false; S.stroke = null;
    /* the pieces are gone and so are their meshes, outline and all: nothing to take down, only the option to end */
    S.wide = false; S.wideIds = []; S.wideView = null; S.wideNotes = {}; S.wideFrom = null; S.lit = []; S.run = null;
    if (S.open) refresh();
  }

  /* ---------------------------------------------- the plate option, lit */

  var LIT = { color: 0xdc2626, intensity: 0.55 };      // a selection's own look (selectPlaced)

  /* Every real piece lit as a selection is: the red tint and the white outline. The outline is the app's own
     (refreshOutline, which draws for the selected piece only, so each piece is "selected" for the call and none is when
     it returns), kept in the piece's own p.outline slot - the one slot clearSelectionOutline, selectPlaced, the undo
     restore (nsoDropOutline) and refreshOutline already strip, so one outline per piece and nothing left behind. */
  function light() {
    unlight();
    if (typeof clearSelectionOutline === 'function') clearSelectionOutline();
    state.selectedIndex = -1;
    S.lit = [];
    state.placed.forEach(function (p, i) {
      if (!p || !p.mesh || isSupport(p.sourceId)) return;
      p.mesh.material.emissive = new THREE.Color(LIT.color);
      p.mesh.material.emissiveIntensity = LIT.intensity;
      state.selectedIndex = i;
      if (typeof refreshOutline === 'function') refreshOutline(p, { now: true });     // on screen before it returns, as it was
      S.lit.push({ p: p, line: p.outline || null });
    });
    state.selectedIndex = -1;
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    if (typeof renderModelList === 'function') renderModelList();
    if (typeof nsoInputMode !== 'undefined' && nsoInputMode) setTimeout(function () { nsoInputMode.refresh(); }, 0);
  }
  /* Take back exactly what light() put up: an outline still ours comes off and is disposed; a piece the user has since
     selected keeps the selection's own look. */
  function unlight() {
    var lit = S.lit || [];
    S.lit = [];
    lit.forEach(function (e) {
      var p = e.p;
      if (e.line && p.outline === e.line) {
        if (p.mesh) p.mesh.remove(e.line);
        if (e.line.geometry) e.line.geometry.dispose();
        if (e.line.material) e.line.material.dispose();
        p.outline = null;
      }
      if (p.mesh && p.mesh.material && state.placed[state.selectedIndex] !== p) {
        p.mesh.material.emissive = new THREE.Color(0x000000);
        p.mesh.material.emissiveIntensity = 0;
      }
    });
  }
  /* The highlight IS the option: while it stands the option is on. Anything that takes it down - a piece picked, added
     or removed, an Undo that restores the plate - ends the option with it. */
  function wideHolds() {
    if (!S.wide || state.selectedIndex >= 0) return false;
    if (realIds().join(',') !== S.wideIds.join(',')) return false;
    return S.lit.every(function (e) { return placedOf(e.p.sourceId) === e.p && (!e.line || e.p.outline === e.line); });
  }

  /* GENERATE FOR PLATE, on or off. On: the card lets go of its piece, every piece is lit and read. Off (the box, or
     `pick` true): the highlight comes off; with `pick` the piece the card was on before is picked again. */
  function setWide(on, opt) {
    on = !!on;
    if (on === S.wide) return { ok: true, on: S.wide };
    if (S.busy) return { ok: false, reason: 'busy' };
    if (on) {
      if (!S.open) return { ok: false, reason: 'the card is closed' };
      var ids = realIds();
      if (ids.length < 2) return { ok: false, reason: 'the plate needs two or more pieces' };
      cancelDrag();
      if (S.detJob) { S.detJob.job.cancel(); S.detJob = null; }
      S.wideFrom = S.hostId; S.wide = true; S.wideIds = ids; S.wideNotes = {}; S.wideView = null;
      S.hostId = null; S.selSupport = null; S.det = null; S.eff = null; S.msg = null;
      S.tool = 'tips'; S.sel = null; S.hover = null; S.hot = null;
      light();
      refresh();
      return { ok: true, on: true, pieces: ids.length };
    }
    var back = S.wideFrom;
    S.wide = false; S.wideIds = []; S.wideView = null; S.wideNotes = {}; S.wideFrom = null; S.msg = null; S.det = null; S.run = null;
    if (S.detJob) { S.detJob.job.cancel(); S.detJob = null; }
    unlight();
    if (opt && opt.pick && back != null && placedOf(back)) pick(back); else if (S.open) refresh();
    return { ok: true, on: false };
  }

  /* DELETE PLATE / CLEAR PLATE with other beds standing (app-beds.js): forget the named pieces' tips, circles,
     erasures and detection, and the host if it is one of them. Another bed's pieces keep theirs. */
  function forget(ids) {
    var gone = {};
    (ids || []).forEach(function (id) { gone[id] = true; });
    cancelDrag();
    Object.keys(S.mem).forEach(function (k) { if (gone[k]) delete S.mem[k]; });
    Object.keys(S.occ).forEach(function (k) { if (gone[k]) delete S.occ[k]; });
    if (S.hostId != null && gone[S.hostId]) {
      S.hostId = null; S.selSupport = null; S.det = null; S.eff = null;
      S.tool = 'tips'; S.sel = null; S.hover = null; S.hot = null;
    } else if (S.selSupport != null && gone[S.selSupport]) S.selSupport = null;
    if (S.open) refresh();
  }

  /* --------------------------------------------------------- open, close */

  /* The piece the card should be on: the app's selection when it is a piece
     (not a support), else the only piece on the plate. */
  function wanted() {
    var sel = state.selectedIndex >= 0 ? state.placed[state.selectedIndex] : null;
    if (sel && sel.mesh && !isSupport(sel.sourceId)) return sel.sourceId;
    if (sel && sel.mesh) return null;                 // a support is selected: stay on its piece
    var all = (state.placed || []).filter(function (p) { return p && p.mesh && !isSupport(p.sourceId); });
    return all.length === 1 ? all[0].sourceId : null;
  }

  function tick() {
    if (!S.open) return;
    var menu = $('menu-supports');
    if (menu && !menu.open) { close(); return; }
    if (!S.busy) {
      if (S.wide && !wideHolds()) setWide(false);     // the lit pieces are what the option is: lost (a piece picked, added, removed, an Undo) - so is it
      if (S.wide) {
        if (signature() !== S.sig) refresh();
      } else {
        var w = wanted();
        if (S.hostId != null && !placedOf(S.hostId)) { S.hostId = null; S.selSupport = null; refresh(); }
        else if (w != null && w !== S.hostId && state.selectedIndex >= 0) pick(w);   // the app's selection moved: detect there
        else if (S.hostId == null && w != null) pick(w);
        else if (signature() !== S.sig) refresh();
        else if (S.paintLayer && placedOf(S.hostId) && placedOf(S.hostId).mesh && placedOf(S.hostId).mesh.matrixWorld.elements.join(',') !== S.paintMat) drawPaint();
        else if (S.zoneLayer && state.camera) {
          var cd = Math.round(state.camera.position.length() * 20);
          if (cd !== S.camKey) { S.camKey = cd; drawZones(); }
        }
      }
    }
    S.raf = requestAnimationFrame(tick);
  }
  /* Opening the card detects at once, on the selected piece. */
  function open() {
    if (S.open) return;
    S.open = true; S.hostId = null; S.selSupport = null; S.msg = null; S.det = null; S.dets = {}; S.occ = {};
    var w = wanted();
    if (w != null) pick(w); else refresh();
    S.raf = requestAnimationFrame(tick);
  }
  function close() {
    if (S.detJob) { S.detJob.job.cancel(); S.detJob = null; }
    if (S.job && S.job.stop) { var j = S.job; j.dead = true; j.stop(new Error('the card was closed')); }
    clearTimeout(S.angleTimer); S.angleTimer = 0;
    cancelDrag();
    if (S.wide) { S.wide = false; S.wideIds = []; S.wideView = null; S.wideNotes = {}; S.wideFrom = null; S.run = null; unlight(); }
    S.open = false; S.hostId = null; S.selSupport = null; S.msg = null; S.det = null; S.dets = {}; S.occ = {};
    S.tool = 'tips'; S.sel = null; S.hover = null; S.hot = null; S.paint = false; S.stroke = null;
    dispose(S.layer); S.layer = null; dispose(S.pts); S.pts = null; dispose(S.zoneLayer); S.zoneLayer = null; dispose(S.eraseLayer); S.eraseLayer = null; dispose(S.paintLayer); S.paintLayer = null;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    sync();
  }

  /* The angle, as typed. A number outside 1..89 is said so and changes
     nothing; a good one re-detects once the typing has paused. */
  function setAngle(v, now) {
    var a = typeof v === 'number' ? v : parseFloat(v);
    if (!(a >= ANGLE_MIN && a <= ANGLE_MAX)) {
      S.msg = { text: 'The angle is between ' + ANGLE_MIN + '\u00b0 and ' + ANGLE_MAX + '\u00b0.', bad: true };
      sync();
      return { ok: false, reason: 'angle out of range' };
    }
    clearTimeout(S.angleTimer); S.angleTimer = 0;
    var go = function () {
      S.angleTimer = 0;
      if (S.busy) return;
      S.angle = a; S.msg = null; S.det = null; S.dets = {};
      refresh();
    };
    if (now) go(); else S.angleTimer = setTimeout(go, ANGLE_DEBOUNCE_MS);
    return { ok: true, angle: a };
  }

  /* ------------------------------------------------------ slice and preview */

  /* SLICE AND PREVIEW, the card's last button: the Slice card's own slice of the plate (every piece, supports included, for the plate's
     printer - app-print.js), then its own Preview in G-scope. Nothing here slices or opens anything itself, and the Slice card is as it
     was; this is the shortest way from the supports just built to the layers they print as. The card says how far it has got on a
     line under the button (the Slice card's stage line, word for word), and Cancel stops the slice. */
  var SL = { busy: false, last: null };
  function sliceLine(text, bad) {
    var el = $('sup-slice-line');
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
    el.classList.toggle('is-bad', !!bad);
  }
  function syncSlice() {
    var go = $('btn-sup-slice'), cx = $('btn-sup-slice-cancel');
    if (go) { go.disabled = SL.busy || !!S.busy; go.textContent = SL.busy ? 'Slicing\u2026' : 'Slice and Preview'; }
    if (cx) cx.hidden = !SL.busy;
  }
  function sliceAndPreview() {
    var P = window.NSO_Print && window.NSO_Print.card;
    if (SL.busy) return Promise.resolve({ ok: false, reason: 'busy' });
    if (S.busy) { sliceLine('Wait for the build to end, then slice.', true); return Promise.resolve({ ok: false, reason: 'building' }); }
    if (!P || !P.sliceAndPreview) { sliceLine('The slicer did not load - check console.', true); return Promise.resolve({ ok: false, reason: 'no slicer' }); }
    SL.busy = true; sync(); sliceLine('Slicing the plate', false);
    return P.sliceAndPreview({ onStage: function (t) { if (SL.busy) sliceLine(t, false); } }).then(function (r) {
      SL.busy = false; SL.last = r;
      if (r.ok) {
        sliceLine('', false);
        var menu = $('menu-supports');
        if (menu && menu.open) menu.open = false;              // G-scope has the view now
      } else sliceLine(r.reason, !r.cancelled);
      sync();
      return r;
    });
  }
  function cancelSlice() {
    var P = window.NSO_Print && window.NSO_Print.card;
    if (SL.busy && P && P.cancel) P.cancel();
  }

  /* --------------------------------------------------------- the pointer */

  function onCanvas(ev) { return state.renderer && ev.target === state.renderer.domElement; }

  function onDown(ev) {
    if (!S.open || S.busy || ev.button !== 0 || !onCanvas(ev)) return;
    var fed = S.mode !== 'auto', swallow = function () { ev.stopImmediatePropagation(); ev.preventDefault(); };
    if (S.wide) {                                   // on the plate a click on a piece picks it (the option goes off); anything else is the view's
      var hw = hitAt(ev);
      if (hw && !isSupport(hw.id)) { pick(hw.id); swallow(); }
      return;
    }
    /* THE BRUSH owns a press on the piece (a drag paints; the view does not orbit); a press anywhere else is the view's */
    if (S.paint && !ev.altKey) {                          // Alt held: the press is the view's, over the piece too (orbit without putting the brush down)
      var hp = hitDown(ev);
      if (hp) {
        S.stroke = { pts: [], last: null, r: brushR() };
        addStrokePoint(hp);
        drawPaint();
        swallow();
      }
      return;
    }
    /* The markers own the pointer while their tool is on (a press on one is not
       the view's); a press on nothing of theirs falls through, so the view
       still orbits. CIRCLES owns the plate, and says so on the card: stop it to orbit. */
    if (fed && S.tool === 'circles') { if (circleDown(ev)) swallow(); return; }
    if (fed && S.tool === 'erase') {
      var mid = memberAt(ev);
      if (mid) { swallow(); eraseMember(mid); }
      return;
    }
    if (fed && markerDown(ev)) { swallow(); return; }
    var h = hitAt(ev);
    if (!h) return;                                 // empty space: the view still orbits
    if (isSupport(h.id)) selectSupport(h.id);
    else if (h.id !== S.hostId) pick(h.id);
    else if (S.mode === 'custom') placeTip(h.p, h.n);       // a click on the piece is a tip
    else if (ev.shiftKey) addBeacon(h.p, h.n);              // Auto and Assisted: a spot of your own
    else if (fed) { if (S.selSupport != null || S.msg) { S.selSupport = null; S.msg = null; pick(S.hostId); } }
    else {
      var area = areaAt(ev);
      if (area != null) toggleArea(area);           // nothing builds on a click
      else if (S.selSupport != null || S.msg) { S.selSupport = null; S.msg = null; pick(S.hostId); }
    }
    swallow();
  }

  var hoverRaf = 0, lastMove = null;
  function hoverAt(ev) {
    if (S.tool === 'erase') { if (eraseReady()) hoverMember(memberAt(ev)); }
    else if (S.tool === 'tips' && S.pts) { var b = spotAt(ev); setHot(b ? S.eff.beacons.indexOf(b) : null); }
    return S.tool === 'erase' ? S.hover : S.hot;
  }
  var paintRaf = 0;
  function onMove(ev) {
    if (S.stroke) {                                       // the brush is down: every sample the pointer made since the last event, on the piece
      if (!S.open || S.busy || !onCanvas(ev)) return;
      var evs = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : null;
      (evs && evs.length ? evs : [ev]).forEach(function (e) { var h = hitDown(e); if (h) addStrokePoint(h); });
      if (!paintRaf) paintRaf = requestAnimationFrame(function () { paintRaf = 0; if (S.stroke) drawPaint(); });
      return;
    }
    if (!S.open || S.busy || S.mode === 'auto' || S.drag || !onCanvas(ev)) return;
    lastMove = ev;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(function () { hoverRaf = 0; if (lastMove && S.open && !S.busy && !S.drag) hoverAt(lastMove); });
  }

  function wire() {
    var menu = $('menu-supports');
    if (!menu || menu.dataset.nsoWired === '1') return;
    menu.dataset.nsoWired = '1';
    menu.addEventListener('toggle', function () { if (menu.open) open(); else close(); });
    var on = function (id, ev, fn) { var e = $(id); if (e) e.addEventListener(ev, fn); };
    on('btn-sup-all', 'click', function () { generate(); });
    on('btn-sup-none', 'click', function () { removeAll(); });
    on('btn-sup-remove', 'click', function () { removeSelected(); });
    on('sup-plate', 'change', function () { setWide($('sup-plate').checked, { pick: true }); syncPlate(); });
    on('sup-angle', 'input', function () { setAngle($('sup-angle').value, false); });
    on('sup-angle', 'change', function () { setAngle($('sup-angle').value, true); });
    KNOBS.forEach(function (K) { on(K.id, 'input', function () { setKnob(K.key, $(K.id).value); }); });
    on('sup-tune-defaults', 'click', function () { tuneDefaults(); });
    Object.keys(MODES).forEach(function (k) { on('sup-mode-' + k, 'click', function () { setMode(k); }); });
    Object.keys(TOOLS).forEach(function (k) { on('sup-tool-' + k, 'click', function () { setTool(k); }); });
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', function () { if (S.stroke) endStroke(); }, true);
    window.addEventListener('click', function (ev) { if (S.noClickUntil && Date.now() < S.noClickUntil && S.paint) { S.noClickUntil = 0; ev.stopImmediatePropagation(); ev.preventDefault(); } }, true);
    window.addEventListener('pointercancel', function () { if (S.stroke) { S.stroke = null; drawPaint(); } }, true);
    on('btn-sup-slice', 'click', function () { sliceAndPreview(); });
    on('btn-sup-slice-cancel', 'click', function () { cancelSlice(); });
    on('sup-paint', 'click', function () { setPaint(!S.paint); });
    on('sup-paint-clear', 'click', function () { clearPaint(); });
    window.addEventListener('keydown', onKey, true);
    sync();
  }
  /* The markers are scene helpers (nso-helpers.js): put away on leave-tool and
     Clear, redrawn after an Undo. */
  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('supports-card', {
    live: function () { return S.open && !S.wide && (S.mode !== 'auto' || S.paint || !!S.paintLayer); },       // Auto draws what it always drew, and is left as it was (but for the paint); the plate has no points
    close: function () { var menu = $('menu-supports'); if (menu && menu.open) menu.open = false; else if (S.open) close(); },
    clear: function () { dispose(S.pts); S.pts = null; dispose(S.zoneLayer); S.zoneLayer = null; dispose(S.eraseLayer); S.eraseLayer = null; dispose(S.paintLayer); S.paintLayer = null; },
    refresh: function () { if (S.open) refresh(); }
  });
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }

  return {
    STYLES: Object.assign({}, STYLES),
    isOpen: function () { return S.open; },
    host: function () { return S.hostId; },
    pick: pick,
    generate: generate,
    removeAll: removeAll,
    toggleArea: toggleArea,
    frameArea: frameArea,
    selectSupport: selectSupport,
    selected: function () { return S.selSupport; },
    removeSelected: removeSelected,
    addBeacon: addBeacon,
    /** The brush: on / off (no argument: is it on). paintStroke([{ p, n }], r) paints one stroke in Z up; clearPaint takes it all off; paintCount counts the strokes. */
    paint: function (on) { return on === undefined ? S.paint : setPaint(on); },
    paintStroke: paintStroke,
    clearPaint: clearPaint,
    paintCount: paintCount,
    busy: function () { return S.busy; },
    /** The tool that holds the pointer, so that nothing else answers a press: 'paint', 'circles', 'erase', or null (app-support-blockers.js stands down for them). */
    pointerTool: function () { return S.open ? (S.stroke || S.paint ? 'paint' : S.mode !== 'auto' && (S.tool === 'circles' || S.tool === 'erase') ? S.tool : null) : null; },
    /** Slice and Preview: the Slice card's slice of the plate, then G-scope. Resolves { ok, reason, previewed }. */
    sliceAndPreview: sliceAndPreview,
    cancelSlice: cancelSlice,
    sliceBusy: function () { return SL.busy; },
    /** The angle detection runs at (degrees); setting one re-detects at once. */
    angle: function (v) { if (v !== undefined) setAngle(v, true); return S.angle; },
    /** The watchdog, ms: a build the planner has said nothing about for this long is stopped. Default 60000. */
    watchdogMs: function (v) { if (v !== undefined) S.watchdogMs = v > 0 ? +v : WATCHDOG_MS; return S.watchdogMs; },
    /** The ceiling, ms: a build still running this long after GENERATE is stopped however it reports. Default 600000. */
    ceilingMs: function (v) { if (v !== undefined) S.ceilingMs = v > 0 ? +v : CEILING_MS; return S.ceilingMs; },
    /** Stop the build that is running, as Escape does: nothing is added, Undo has nothing new. */
    cancel: cancel,
    /** fn({ phase, done, total, percent, line, ms, sent }) hears every progress message a build keeps; returns the function that stops it. ms: when the page took it up; sent: when the worker posted it - the planner's own cadence, which the page's frames do not blur. */
    onProgress: function (fn) {
      if (typeof fn !== 'function') return function () {};
      S.listeners.push(fn);
      return function () { var k = S.listeners.indexOf(fn); if (k >= 0) S.listeners.splice(k, 1); };
    },
    /** What the bar shows now: null when no build is running, else { phase, done, total, percent, line }. */
    progress: function () {
      return S.busy ? { phase: S.prog ? S.prog.phase : null, done: S.prog ? S.prog.done : null, total: S.prog ? S.prog.total : null,
        percent: percentNow(), line: progressLine(), piece: S.run ? S.run.k : null, pieces: S.run ? S.run.n : null } : null;
    },
    /** A test seam: fn(soup, opts) -> Promise of a plan replaces the worker's planTree (opts.onProgress takes its progress); null restores it. */
    setPlanner: function (fn) { S.planner = typeof fn === 'function' ? fn : null; },
    /** What the card shows now: beacons with their states, regions, rows, the words. */
    view: function () {
      var eff = S.eff || { beacons: [], regions: [], pitch: 3 };
      var st = S.hostId != null && eff.beacons.length ? statesFor(eff) : {};
      return {
        host: S.hostId, state: S.wide ? wideState(S.wideView) : cardState(), mode: S.mode, tool: S.tool, error: eff.error || null, pitch: eff.pitch, angle: S.angle,
        beacons: eff.beacons.map(function (b) {
          return { key: b.key, p: pt(b), normal: b.normal, region: b.region, manual: b.manual, kind: b.need && b.need.kind, state: st[b.key], off: !!b.off, tip: !!b.tip };
        }),
        areas: eff.regions.map(function (r) {
          return { id: r.id, count: r.beacons.length, point: r.point, normal: r.normal, excluded: !!r.excluded,
            footprint: !!(S.geo && S.geo[r.id] && S.geo[r.id].fp), outlineEdges: S.geo && S.geo[r.id] ? S.geo[r.id].segs.length : null,
            kind: S.hostId != null && eff.beacons.length ? areaKind(r, st) : null,
            built: r.beacons.some(function (b) { return st[b.key] === 'held' || st[b.key] === 'rest'; }) };
        }),
        stats: S.hostId != null && eff.beacons.length ? areaStats(eff, st) : null,
        rows: S.hostId != null && eff.beacons.length && cardState() === 'built' ? rowsFor(eff, st) : [],
        count: ($('sup-count') || {}).textContent || ''
      };
    },
    supports: function (hostId) { return supportsOf(hostId == null ? S.hostId : hostId); },

    /** GENERATE FOR PLATE: plate(true) lights every piece and reads each; plate(false) puts the card back on the piece it was on; plate() says whether it is on. */
    plate: function (on) { if (on !== undefined) return setWide(on, { pick: true }); return S.wide; },
    /** What the plate card shows now (null when the option is off): the pieces with their areas, the sums, the rows, the readout, how many are lit. */
    plateView: function () {
      if (!S.wide) return null;
      var W = S.wideView || { pieces: [], totals: {}, pending: true };
      return {
        on: true, ids: S.wideIds.slice(), state: wideState(S.wideView), pending: !!W.pending, totals: Object.assign({}, W.totals),
        pieces: W.pieces.map(function (r) {
          return r.measuring ? { id: r.id, name: r.name, measuring: true } : { id: r.id, name: r.name, error: r.error, built: r.built, spots: r.spots,
            areas: r.a.areas, total: r.a.total, left: r.a.left, held: r.a.held, unsupported: r.a.unsupported, unreachable: r.a.unreachable, supports: r.a.supports };
        }),
        rows: S.wideView ? wideRows(S.wideView) : [], lit: S.lit.length, outlines: S.lit.filter(function (e) { return e.line && e.p.outline === e.line; }).length,
        count: ($('sup-count') || {}).textContent || ''
      };
    },
    /** Select a piece and frame it (what a click on its row does). */
    pickAndFrame: pickAndFrame,

    /** Tune: the four values, which of them are not at their default (what a build sends as feed.knobs, or null), the standing build's, and whether it is out of date. */
    tune: function () {
      var mem = S.hostId != null ? memOf(S.hostId) : null;
      return {
        values: KNOBS.reduce(function (o, K) { o[K.key] = knobValue(K); return o; }, {}),
        given: knobsGiven(), invalid: knobBad(), changed: knobsChanged(),
        shown: !!($('sup-tune') && !$('sup-tune').hidden), open: !!($('sup-tune') && $('sup-tune').open),
        builtWith: mem && mem.built ? mem.builtKnobs : null, stale: tuneStale()
      };
    },
    /** Set one Tune field (what typing in it does): nothing is rebuilt. */
    setKnob: setKnob,
    /** Put all four Tune fields back to the defaults (the Defaults button). */
    tuneDefaults: tuneDefaults,
    /** Auto, Assisted or Custom (a setting, like the angle: not an Undo step). */
    mode: function (k) { if (k !== undefined) setMode(k); return S.mode; },
    /** The tool that holds the pointer in a fed mode: 'tips', 'circles' or 'erase'; the one that is on, asked again, is stopped. */
    tool: function (k) { if (k !== undefined) setTool(k); return S.tool; },
    toggleSpot: toggleSpot,
    placeTip: placeTip,
    removeTip: removeTip,
    addZone: addZone,
    removeZone: removeZone,
    selectZone: function (i) { S.sel = i == null ? null : i; drawZones(); sync(); return S.sel; },
    /** Erase a built member by id (what a click on it does): the plan is made again. */
    eraseMember: eraseMember,
    /** The built members the eraser can hit, as the last build named them. */
    members: function () { return memOf(S.hostId == null ? -1 : S.hostId).members.slice(); },
    /** Where on the page (client pixels) a spot / tip / circle's edge is, for a real click. */
    screenOf: function (kind, key) {
      var el = state.renderer && state.renderer.domElement, r = el && el.getBoundingClientRect(), q = null;
      if (!r || !state.camera) return null;
      if (kind === 'spot' || kind === 'tip') { var b = spotByKey(key); q = b && upToView(pt(b)); }
      else if (kind === 'zone') { var z = zonesOf()[key]; q = z && new THREE.Vector3(z.x, 0, -z.y); }
      else if (kind === 'zone-edge') { var e = zonesOf()[key]; q = e && new THREE.Vector3(e.x + e.r, 0, -e.y); }
      else if (kind === 'member') {
        var M = memOf(S.hostId).members.find(function (x) { return x.id === key; });
        q = M && upToView([(M.from[0] + M.to[0]) / 2, (M.from[1] + M.to[1]) / 2, (M.from[2] + M.to[2]) / 2]);
      }
      if (!q) return null;
      state.camera.updateMatrixWorld();
      var v = q.clone().project(state.camera);
      return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
    },
    /** What the markers show now: the spots / tips drawn, how many are off, the circles, which is selected, what the eraser has lit. */
    markers: function () {
      var eff = S.eff || { beacons: [] }, m = S.hostId != null ? modelOf(S.hostId) : null, F = m && m.nsoSupportFeed;
      return {
        mode: S.mode, tool: S.tool,
        points: S.pts ? eff.beacons.length : 0, off: eff.beacons.filter(function (b) { return b.off; }).length,
        tips: F ? F.tips.length : 0, zones: F ? F.zones.map(function (z) { return { x: z.x, y: z.y, r: z.r }; }) : [],
        selected: S.sel, hot: S.hot != null && eff.beacons[S.hot] ? eff.beacons[S.hot].key : null,
        erased: F ? F.erased.slice() : [], zonesEmpty: S.hostId != null ? memOf(S.hostId).zonesEmpty.slice() : [],
        hover: S.hover, lit: S.hover && S.hostId != null ? litBy(S.hover).map(function (x) { return x.id; }) : [],
        eraseLayer: S.eraseLayer ? S.eraseLayer.children.length : 0, eraseReady: S.hostId != null && eraseReady()
      };
    },
    /** Forget every host's tips, toggles, circles and erasures (what CLEAR PLATE does). */
    forgetAll: forgetAll,
    /** Forget only these pieces (ids): what CLEAR PLATE does when other plates stand beside the one cleared. */
    forget: forget
  };
})();

if (typeof window !== 'undefined') window.NSO_SUPPORTS_CARD = NSO_SUPPORTS_CARD;
