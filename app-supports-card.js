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
  var UP_MAX = 0.26;             // a face whose normal points up more than this (15 deg) holds nothing
  var ORDER = 30;                // over the piece and its outline
  var MARK_ORDER = 900;          // the markers (spots, tips, circles, the eraser's light) draw over everything, as the rotate rings do
  var PICK_PX = 9;               // a spot / a tip / a circle's edge is under the pointer within this many pixels
  var ZONE_MIN_R = 1.5;          // a circle dragged smaller than this (mm) is a click, not a circle
  var MODES = { auto: 'Auto', assisted: 'Assisted', custom: 'Custom' };
  var TOOLS = { tips: true, circles: true, erase: true };
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
  var PARTS_OPTS = { interface: true, foldSheets: false, footPads: 'shared' };
  /* The card's state when the picked piece has no beacons at all. Detection
     only asks what hangs in air; a tall, thin piece that may sway as it
     prints is a different question, not asked yet, and the words say so. */
  var NOTHING = 'Nothing hangs in air. Tall-and-thin sway isn\'t checked yet.';

  var S = {
    open: false, hostId: null, selSupport: null, busy: false,
    det: null, occ: {}, eff: null, layer: null, raf: 0, sig: '', mem: {}, msg: null,
    geo: null, angle: ANGLE_DEFAULT, angleTimer: 0,
    watchdogMs: WATCHDOG_MS, ceilingMs: CEILING_MS, planner: null, job: null, elapsed: 0,
    prog: null, listeners: [], said: null,
    mode: 'auto', tool: 'tips', pts: null, zoneLayer: null, eraseLayer: null, hot: null, hover: null, sel: null, drag: null
  };

  function $(id) { return document.getElementById(id); }
  function modelOf(id) { return (state.models || []).find(function (m) { return m && m.id === id; }) || null; }
  function placedOf(id) { return (state.placed || []).find(function (p) { return p && p.sourceId === id && p.mesh; }) || null; }
  function isSupport(id) { var m = modelOf(id); return !!(m && m.nsoSupport); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
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
    var opts = { skipList: sk.list, angleDeg: S.angle, occluders: occ.map(occluderSoup) };
    /* A BIG piece is read in a worker (detection is 10 s of JS on the vase, and
       the card used to freeze the page for all of it on opening). The card
       says "measuring…" and redraws when the read comes back. */
    if (!sk.reason && bigPiece(soup)) return detectInWorker(key, soup, opts);
    return settle(key, soup, opts, sk.reason ? null : window.NSO_SupportAim.detectOverhangs(soup, opts), sk.reason);
  }

  var PENDING = { pending: true };
  function bigPiece(soup) {
    return !!(window.NSO_BVH && window.NSO_BVH.isBig(soup.length / 9) && window.NSO_Work && window.NSO_Work.isAvailable());
  }
  function settle(key, soup, opts, det, reason) {
    var err = reason || (det && !det.ok ? det.reason : null) ||
      (det && !det.beacons ? (det.beaconsReason || 'no beacon grid') : null);
    S.det = { key: key, soup: soup, opts: opts, det: det, error: err, minZ: boundsOf(soup).lo[2] };
    return S.det;
  }
  function detectInWorker(key, soup, opts) {
    if (S.detJob && S.detJob.key === key) return PENDING;
    if (S.detJob) { S.detJob.job.cancel(); S.detJob = null; }
    var job = window.NSO_Work.run('support-detect', ['nso_thickness.js', 'nso_support_beacons.js', 'nso_support_aim.js'],
      'NSO_SupportAim.detectOverhangs', [soup, opts]);
    var mine = S.detJob = { key: key, job: job };
    job.promise.then(function (det) {
      if (S.detJob !== mine) return;
      S.detJob = null;
      settle(key, soup, opts, det, null);
      if (S.open) refresh();
    }, function (err) {
      if (S.detJob !== mine) return;
      S.detJob = null;
      settle(key, soup, opts, null, 'Could not read the piece (' + ((err && err.message) || err) + ').');
      if (S.open) refresh();
    });
    return PENDING;
  }

  function editsOf(m) {
    if (!m.nsoSupportEdits) m.nsoSupportEdits = { ops: [], serial: 0 };
    return m.nsoSupportEdits;
  }
  function memOf(id) {
    if (!S.mem[id]) S.mem[id] = { unreach: {}, built: false, members: [], zonesEmpty: [] };
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
    var by = {};
    list.forEach(function (b) { (by[b.region] = by[b.region] || []).push(b); });
    var regions = Object.keys(by).map(Number).sort(function (a, b) { return a - b; }).map(function (id) {
      var B = by[id], c = [0, 0, 0], n = [0, 0, 0];
      B.forEach(function (b) { for (var k = 0; k < 3; k++) { c[k] += pt(b)[k] / B.length; n[k] += b.normal[k]; } });
      var L = Math.hypot(n[0], n[1], n[2]) || 1;
      return { id: id, beacons: B, point: c, normal: [n[0] / L, n[1] / L, n[2] / L],
        excluded: fed ? B.every(function (b) { return b.off; }) : !!left[id] };
    });
    return { beacons: list, regions: regions, pitch: pitch, origin: det.grid ? det.grid.origin : [0, 0], error: null };
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
      return m.nsoSupport.card && (regionId == null || m.nsoSupport.regionId === regionId);
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
        (a.left ? ' \u00b7 ' + a.left + ' left out' : '');
    }
    var eff = S.eff, on = eff.beacons.filter(function (b) { return !b.off; }).length, off = eff.beacons.length - on, z = feedOf(m).zones.length;
    var tail = (off ? ' \u00b7 ' + off + ' off' : '') + (z ? ' \u00b7 ' + plural(z, 'circle', 'circles') : '');
    if (S.mode === 'custom') return (on ? plural(on, 'tip', 'tips') : 'No tips yet') + ' on ' + name + tail;
    return plural(on, 'spot', 'spots') + ' at ' + S.angle + '\u00b0 on ' + name + tail;
  }
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
    return { cells: cells, segs: segs };
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

  function draw() {
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
  /* "Planning 142 / 344 \u00b7 21 %", or "Detecting \u00b7 0 s" for a phase with no
     count. The seconds are the build's own. */
  function progressLine() {
    var pg = S.prog;
    if (!pg) return buildingLine();
    var word = PHASE_WORD[pg.phase];
    return percentOf(pg) == null ? word + ' \u00b7 ' + S.elapsed + ' s'
      : word + ' ' + pg.done + ' / ' + pg.total + ' \u00b7 ' + percentOf(pg) + ' %';
  }
  /* The one bar, under the readout: shown while a build runs, filled to the
     phase's percent, or sweeping when the phase has no count. The readout and
     the bottom-right status say the same words as the bar. */
  function paintBar() {
    var bar = $('sup-progress'), fill = bar && bar.firstElementChild, on = !!(S.open && S.busy);
    if (bar) {
      bar.hidden = !on;
      if (on) {
        var pc = percentOf(S.prog), line = progressLine();
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
    var head = $('sup-count'), card = $('supports-card');
    var hasHost = S.hostId != null && !!placedOf(S.hostId);
    var eff = S.eff, text, bad = false, cs = cardState(), a = null, st = null;
    if (hasHost && eff && !eff.error && (eff.beacons.length || S.mode === 'custom')) { st = statesFor(eff); a = areaStats(eff, st); }
    if (card) { card.dataset.mode = S.mode; card.dataset.tool = S.tool; card.dataset.state = cs; card.classList.toggle('is-locked', !!S.busy); }
    document.body.classList.toggle('sup-card-open', !!S.open);
    if (S.msg) { text = S.msg.text; bad = !!S.msg.bad; }
    else if (cs === 'pick') text = 'Click a piece to see where it needs holding.';
    else if (cs === 'error') { text = eff.error; bad = true; }
    else if (cs === 'measuring') text = 'measuring\u2026';
    else if (cs === 'nothing') text = NOTHING;
    else if (cs === 'building') text = progressLine();
    else if (cs === 'built') text = builtLine(a);
    else text = idleLine(a);
    if (head) { head.textContent = text; head.classList.toggle('is-bad', bad); }
    var en = function (id, on) { var e = $(id); if (e) e.disabled = !on || !!S.busy; };
    var go = $('btn-sup-all');
    if (go) go.textContent = cs === 'building' ? buildingLine() : cs === 'built' ? 'Regenerate' : 'Generate';
    en('btn-sup-all', (cs === 'idle' || cs === 'built') && a && a.areas > 0);
    var none = $('btn-sup-none'), rm = $('btn-sup-remove');
    var wasBuilt = hasHost && memOf(S.hostId).built && (cs === 'built' || cs === 'building');
    if (none) none.hidden = !wasBuilt;
    if (rm) rm.hidden = !wasBuilt;
    en('btn-sup-none', cs === 'built');
    en('btn-sup-remove', cs === 'built' && S.selSupport != null && !!modelOf(S.selSupport));
    ['sup-angle', 'sup-style', 'sup-size', 'sup-rest'].forEach(function (id) { var e = $(id); if (e) e.disabled = !!S.busy; });
    var note = $('sup-angle-note');
    if (note) note.textContent = S.angle + '\u00b0 \u00b7 Bambu ' + BAMBU_ANGLE + '\u00b0';
    var ang = $('sup-angle');
    if (ang && document.activeElement !== ang && ang.value !== String(S.angle)) ang.value = String(S.angle);
    drawRows(cs === 'built' && st ? rowsFor(eff, st) : []);
    syncSwitch(cs);
    paintBar();
  }

  /* THE SWITCH AND THE TOOLS. Auto \u00b7 Assisted \u00b7 Custom; under it, in the two
     fed modes, the tool that holds the pointer: TIPS (the points on the piece),
     CIRCLES (draw on the plate) or ERASE (after a build). One at a time; the
     hint under the card says what the one that is on does. */
  var HINT = {
    assisted: 'Click a point to turn it off, or on. Shift-click the piece to add a spot. Then Circles: where the supports may land.',
    custom: 'Click the underside of the piece to place a tip; click a tip to take it away. Then Circles: where the supports may land.',
    circles: 'Drawing circles on the plate: drag to draw one, drag its edge to resize, drag inside to move, click one then Delete to remove it. Stop (Esc) to orbit.',
    erase: 'Erasing: hover a built member to light it and what it holds; click to remove it. Stop (Esc) to go on.'
  };
  function syncSwitch(cs) {
    var fed = S.mode !== 'auto', hasHost = S.hostId != null && !!placedOf(S.hostId);
    Object.keys(MODES).forEach(function (k) {
      var b = $('sup-mode-' + k);
      if (b) { b.classList.toggle('is-on', S.mode === k); b.setAttribute('aria-pressed', S.mode === k ? 'true' : 'false'); b.disabled = !!S.busy; }
    });
    var tools = $('sup-tools');
    if (tools) tools.hidden = !fed;
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
      hint.textContent = !fed ? hint.dataset.auto : S.tool === 'tips' ? HINT[S.mode] : HINT[S.tool];
    }
    paintCursor();
  }
  function paintCursor() {
    var cv = state.renderer && state.renderer.domElement;
    if (!cv) return;
    var want = !S.open || S.mode === 'auto' ? '' : S.tool === 'circles' ? 'crosshair' : (S.tool === 'erase' && S.hover) || (S.tool === 'tips' && S.hot != null) ? 'pointer' : '';
    if (want || S.cursorSet) { cv.style.cursor = want; S.cursorSet = !!want; }
  }

  /* The short list under the readout: one row for every area that is not
     held. Rebuilt only when it changes, so a click on a row is not eaten by a
     redraw between the press and the release. */
  function drawRows(rows) {
    var ul = $('sup-rows');
    if (!ul) return;
    var key = JSON.stringify(rows.map(function (r) { return [r.area, r.kind, r.why]; }));
    ul.hidden = !rows.length;
    if (ul.dataset.key === key) return;
    ul.dataset.key = key;
    ul.textContent = '';
    rows.forEach(function (r) {
      var li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.className = 'sup-row sup-row-' + r.kind; b.dataset.area = String(r.area);
      b.textContent = r.text;
      b.title = 'Frame this area';
      b.addEventListener('click', function () { frameArea(r.area); });
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
    return { ok: true, area: rid, dist: d, radius: r };
  }

  /* Recompute what the piece shows, redraw, and say it. */
  function refresh() {
    S.eff = S.hostId != null && placedOf(S.hostId) ? effective() : null;
    draw();
    sync();
    S.sig = signature();
  }

  function signature() {
    if (!S.open || S.hostId == null) return '';
    var p = placedOf(S.hostId), m = modelOf(S.hostId);
    if (!p || !m) return 'gone';
    return poseKey(p) + '|' + others(S.hostId).map(function (q) { return q.sourceId + ':' + q.mesh.position.toArray().join(','); }).join(';') +
      '|' + supportsOf(S.hostId).map(function (q) { return q.id; }).join(',') + '|' + editsOf(m).ops.length +
      '|' + JSON.stringify(memOf(S.hostId).unreach).length + '|' + memOf(S.hostId).built + '|' + ((typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0) +
      '|' + S.angle + '|' + S.mode + '|' + (m.nsoSupportFeed ? JSON.stringify(m.nsoSupportFeed).length : 0);
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
    return { style: style, sideMm: isFinite(size) ? size : null, rest: !!(rs && rs.checked) };
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
      return GP.parts(plan, Object.assign({ onProgress: onProgress, yieldFn: yieldFn }, PARTS_OPTS)).then(function (tp) {
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
      w.postMessage({ id: id, plan: plan, opts: Object.assign({}, PARTS_OPTS) });
    });
  }

  /* One area through the planner: the PLANNING step. Resolves { result } when
     there is nothing to build (the planner refused it, or put every spot
     inside the piece), else { rid, t, keyOf, landingOf, unreach } - the plan,
     for building to take up. */
  /* The planner's feed for one area (opts.feed, docs/SUPPORT-GRIDPACK.md
     section 7); null in Auto, which sends none. Assisted hands the area's
     spots over as it always has and names the ones turned off; Custom hands
     over the area's tips alone. Both carry the circles and the erasures. */
  function feedFor(m, beacons, rid) {
    if (S.mode === 'auto') return null;
    var F = feedOf(m), feed = { mode: S.mode, landingZones: F.zones.map(function (z) { return { x: z.x, y: z.y, r: z.r }; }), excluded: F.erased.slice() };
    if (S.mode === 'custom') {
      feed.tips = beacons.filter(function (b) { return !b.off; }).map(function (b) { return { x: b.x, y: b.y, z: b.z, key: b.key, regionId: rid }; });
    } else {
      feed.beaconsOff = beacons.filter(function (b) { return b.off && !b.erased; }).map(function (b) { return b.id; });
    }
    return feed;
  }
  function planArea(job, D, rid, beacons, o, onProgress, feed) {
    var bs = beacons.map(function (b) { return { x: b.x, y: b.y, z: b.z, normal: b.normal, regionId: rid, key: b.key }; });
    var opts = Object.assign({}, D.opts, { beacons: bs, style: o.style, restOnModel: o.rest });
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
      { plateZ: live[0].plateZ, occluders: (D.opts && D.opts.occluders) || [] });
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
    var feed = feedCopy(m.nsoSupportFeed), members = memOf(hostId).members, zonesEmpty = memOf(hostId).zonesEmpty;
    return function () {
      var mm = modelOf(hostId);
      if (mm) mm.nsoSupportEdits = { ops: ops.slice(), serial: serial };
      if (mm) mm.nsoSupportFeed = feedCopy(feed) || undefined;
      memOf(hostId).unreach = JSON.parse(JSON.stringify(unreach));
      memOf(hostId).members = members; memOf(hostId).zonesEmpty = zonesEmpty;
      memOf(hostId).built = built;
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
    if (S.busy) return Promise.resolve({ ok: false, reason: 'busy' });
    var host = placedOf(S.hostId), hm = modelOf(S.hostId), D = detect();
    if (D === PENDING) return Promise.resolve({ ok: false, reason: 'still measuring' });
    if (!host || !D || D.error) return Promise.resolve({ ok: false, reason: D ? D.error : 'no piece' });
    var eff = S.eff = effective(), o = cardOpts(), hostId = S.hostId;
    var regs = eff.regions.filter(function (r) { return !r.excluded; });
    var removeIds = supportsOf(hostId).map(function (m) { return m.id; });
    if (!regs.length) {
      S.msg = { text: 'Every area is left out. Click one to put it back.', bad: true };
      sync();
      return Promise.resolve({ ok: false, reason: 'nothing to build' });
    }
    var job = { seq: 0, dead: false, t0: Date.now(), heard: Date.now(), worker: undefined, sentSoup: false, stop: null, timer: 0, ceiling: 0, clock: 0, rank: -1 };
    var limit = S.watchdogMs, secs = Math.round(limit / 100) / 10, cap = S.ceilingMs;
    function late() { var e = new Error('the planner was still working after ' + secs + ' s'); e.timeout = true; return e; }
    function runaway() {
      var e = new Error('the build was still running after ' + (cap % 60000 ? Math.round(cap / 100) / 10 + ' s' : cap / 60000 + ' min'));
      e.timeout = true; return e;
    }
    /* The planner said something: the watchdog starts again from now. */
    function heard() {
      if (job.dead) return;
      job.heard = Date.now();
      clearTimeout(job.timer);
      job.timer = setTimeout(function () { job.stop(late()); }, limit);
    }
    var spots = regs.reduce(function (n, r) { return n + r.beacons.filter(function (b) { return !b.off; }).length; }, 0);
    S.job = job; S.busy = true; S.msg = null; S.elapsed = 0; S.prog = null; sync();
    var guard = new Promise(function (go, stop) { job.stop = stop; });
    heard();
    job.ceiling = setTimeout(function () { job.stop(runaway()); }, cap);
    job.clock = setInterval(function () { S.elapsed = Math.floor((Date.now() - job.t0) / 1000); sync(); }, 1000);

    /* A turn for the page between units of work on it: the bar repaints, the
       clock and Escape are heard. It also reads the clocks (a unit that blocks
       the thread cannot be interrupted, so it is caught after) and refuses to
       go on once the build is dead. */
    var sliceFrom = Date.now();
    function pause() {
      if (job.dead) throw new Error('the build was stopped');
      if (Date.now() - job.heard > limit) throw late();
      if (Date.now() - job.t0 > cap) throw runaway();
      if (Date.now() - sliceFrom < SLICE_MS) return undefined;
      return new Promise(function (go) { setTimeout(go, 0); }).then(function () {
        sliceFrom = Date.now();
        if (job.dead) throw new Error('the build was stopped');
      });
    }

    var areas = [], builtOf = [], chain = new Promise(function (go) {
      /* One frame and a tick first: the card and the bar are on screen
         before the planner starts. */
      requestAnimationFrame(function () { setTimeout(go, 0); });
    });
    var gp = function () { return window.NSO_SupportGridpack; };

    /* 1. PLANNING (detecting, then beacons settled), area by area. */
    var settledBefore = 0;
    regs.forEach(function (rg) {
      chain = chain.then(function () {
        if (job.dead) return null;
        var at = settledBefore, mine = rg.beacons.filter(function (b) { return !b.off; }).length;
        settledBefore += mine;
        return planArea(job, D, rg.id, rg.beacons, o, function (m, sent) {
          /* Each area's planner starts with its own 'detecting'; note() drops
             it once the build is past that phase. The counts are this
             build's, summed over the areas. */
          heard();
          note(job, m && m.phase === 'planning' ? { phase: 'planning', done: at + m.done, total: spots, own: mine, ownDone: m.done } : m, sent);
        }, feedFor(hm, rg.beacons, rg.id)).then(function (a) {
          areas.push(a);
          return pause() || new Promise(function (go) { setTimeout(go, 0); });
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
      var units = live.map(function (a) { return gp().buildUnits(a.t, PARTS_OPTS); });
      var total = units.reduce(function (n, k) { return n + k; }, 0), before = 0, next = Promise.resolve();
      live.forEach(function (a, k) {
        next = next.then(function () {
          if (job.dead) return null;
          var at = before;
          before += units[k];
          return buildAway(job, a.t, function (m, sent) {
            heard();
            note(job, m && m.phase === 'building' ? { phase: 'building', done: at + m.done, total: total, own: units[k], ownDone: m.done } : m, sent);
          }, pause).then(function (u) { builtOf.push({ a: a, u: u }); });
        });
      });
      return next.then(function () { stopWorker(job); });
    });

    /* The one place the plate changes. Synchronous from the first removal to
       the Undo step, so nothing can interleave; on any failure inside it
       everything is put back and no step is recorded. */
    function commit() {
      if (job.dead) return { ok: false, reason: 'the build was stopped' };
      var results = areas.map(function (a) {
        if (!a.t) return a.result;
        var x = builtOf.find(function (y) { return y.a === a; });
        return areaResult(a, x ? x.u : { ok: false, reason: 'the area was not built' });
      });
      var failed = results.filter(function (r) { return !r.ok; });
      if (failed.length) return { ok: false, reason: failed[0].reason || 'the planner refused' };
      try { results = shareFeet(results, D); } catch (err) { return { ok: false, reason: (err && err.message) || String(err) }; }
      var undo = (pre && pre.undo) || snapshot(), removed = [], added = [], n = 0, mem = memOf(hostId);
      try {
        removed = removePieces(removeIds);
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
            var meta = { card: true, hostSourceId: hostId, hostName: hm.name, regionId: r.rid, style: o.style,
              sideMm: r.sideMm || o.sideMm, rest: o.rest, angleDeg: S.angle, mode: S.mode, keys: sd.keys, holds: sd.holds, landing: sd.landing };
            var pl = placeSolid(sd.soup, meta, host, D.minZ, hm.name + ' - support ' + (r.rid + 1) + '.' + (++n) + ' (' + STYLES[o.style] + ')');
            if (!pl.ok) throw new Error(pl.reason);
            added.push(pl.id);
          }
        }
      } catch (err) {
        dropAdded(added); restorePieces(removed); undo();
        return { ok: false, reason: (err && err.message) || String(err), undone: true };
      }
      mem.built = true;
      pushUndo({ type: 'supportSwap', removed: removed, addedIds: added,
        label: removed.length ? 'Undo: supports on the piece put back as they were' : 'Undo: supports taken off', onUndone: undo });
      return { ok: true, added: added, removed: removed.map(function (x) { return x.placed.sourceId; }) };
    }

    var work = chain.then(commit);
    work.catch(function () { /* the race below has the answer; a late one must not go unhandled */ });
    function over() {
      job.dead = true;
      clearTimeout(job.timer); clearTimeout(job.ceiling); clearInterval(job.clock);
      stopWorker(job);
      if (S.job === job) S.job = null;
      S.busy = false; S.elapsed = 0; S.prog = null;
      unsay();
    }
    function fail(reason, restored) {
      S.msg = { text: 'Could not build: ' + String(reason || 'no reason given').replace(/[.\s]+$/, '') + ' - nothing was added', bad: true };
      if (restored) afterCommit(); else refresh();     // the plate was not touched: leave its selection alone
      return { ok: false, reason: reason, line: ($('sup-count') || {}).textContent || '' };
    }
    return Promise.race([work, guard]).then(function (res) {
      over();
      if (!res.ok) return fail(res.reason, res.undone);
      afterCommit();
      return { ok: true, added: res.added, removed: res.removed,
        stats: areaStats(S.eff, statesFor(S.eff)), line: ($('sup-count') || {}).textContent || '' };
    }, function (err) {
      over();
      if (err && err.cancelled) {
        S.msg = { text: 'Build cancelled - nothing was added', bad: false };
        refresh();
        return { ok: false, reason: 'cancelled', cancelled: true, line: ($('sup-count') || {}).textContent || '' };
      }
      if (!err || !err.timeout) console.error('[supports card]', err);
      return fail((err && err.message) || String(err));
    });
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
    var say = { phase: next.phase, done: next.done, total: next.total, percent: percentOf(next), line: progressLine(),
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
      mem.unreach = {}; mem.built = false; mem.members = []; mem.zonesEmpty = [];
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
    if (S.hostId == null) return Promise.resolve({ ok: false, reason: 'no piece' });
    S.eff = effective();
    if (S.eff.error || !S.eff.beacons.length) { refresh(); return Promise.resolve({ ok: false, reason: S.eff.error || 'nothing needs holding' }); }
    return build(pre);
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
    Object.keys(S.geo).forEach(function (id) {
      S.geo[id].cells.forEach(function (c) {
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
  function setTool(k) {
    if (!TOOLS[k]) return { ok: false, reason: 'no such tool' };
    if (S.busy || S.mode === 'auto') return { ok: false, reason: S.busy ? 'busy' : 'Auto has no tools' };
    if (k === 'erase' && !eraseReady()) return { ok: false, reason: 'nothing built to erase' };
    cancelDrag();
    S.tool = k === S.tool && k !== 'tips' ? 'tips' : k;       // a tool that is on, pressed again, is stopped
    S.sel = null; S.hover = null; S.msg = null;
    draw(); sync();
    return { ok: true, tool: S.tool };
  }
  /* CLEAR PLATE: the models stay in the list, and forget what was fed in. */
  function forgetAll() {
    cancelDrag();
    (state.models || []).forEach(function (m) { if (m) m.nsoSupportFeed = undefined; });
    Object.keys(S.mem).forEach(function (k) { S.mem[k].members = []; S.mem[k].zonesEmpty = []; });
    S.tool = 'tips'; S.sel = null; S.hover = null;
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
      var w = wanted();
      if (S.hostId != null && !placedOf(S.hostId)) { S.hostId = null; S.selSupport = null; refresh(); }
      else if (w != null && w !== S.hostId && state.selectedIndex >= 0) pick(w);   // the app's selection moved: detect there
      else if (S.hostId == null && w != null) pick(w);
      else if (signature() !== S.sig) refresh();
      else if (S.zoneLayer && state.camera) {
        var cd = Math.round(state.camera.position.length() * 20);
        if (cd !== S.camKey) { S.camKey = cd; drawZones(); }
      }
    }
    S.raf = requestAnimationFrame(tick);
  }
  /* Opening the card detects at once, on the selected piece. */
  function open() {
    if (S.open) return;
    S.open = true; S.hostId = null; S.selSupport = null; S.msg = null; S.det = null; S.occ = {};
    var w = wanted();
    if (w != null) pick(w); else refresh();
    S.raf = requestAnimationFrame(tick);
  }
  function close() {
    if (S.detJob) { S.detJob.job.cancel(); S.detJob = null; }
    if (S.job && S.job.stop) { var j = S.job; j.dead = true; j.stop(new Error('the card was closed')); }
    clearTimeout(S.angleTimer); S.angleTimer = 0;
    cancelDrag();
    S.open = false; S.hostId = null; S.selSupport = null; S.msg = null; S.det = null; S.occ = {};
    S.tool = 'tips'; S.sel = null; S.hover = null; S.hot = null;
    dispose(S.layer); S.layer = null; dispose(S.pts); S.pts = null; dispose(S.zoneLayer); S.zoneLayer = null; dispose(S.eraseLayer); S.eraseLayer = null;
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
      S.angle = a; S.msg = null; S.det = null;
      refresh();
    };
    if (now) go(); else S.angleTimer = setTimeout(go, ANGLE_DEBOUNCE_MS);
    return { ok: true, angle: a };
  }

  /* --------------------------------------------------------- the pointer */

  function onCanvas(ev) { return state.renderer && ev.target === state.renderer.domElement; }

  function onDown(ev) {
    if (!S.open || S.busy || ev.button !== 0 || !onCanvas(ev)) return;
    var fed = S.mode !== 'auto', swallow = function () { ev.stopImmediatePropagation(); ev.preventDefault(); };
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
  function onMove(ev) {
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
    on('sup-angle', 'input', function () { setAngle($('sup-angle').value, false); });
    on('sup-angle', 'change', function () { setAngle($('sup-angle').value, true); });
    Object.keys(MODES).forEach(function (k) { on('sup-mode-' + k, 'click', function () { setMode(k); }); });
    Object.keys(TOOLS).forEach(function (k) { on('sup-tool-' + k, 'click', function () { setTool(k); }); });
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('keydown', onKey, true);
    sync();
  }
  /* The markers are scene helpers (nso-helpers.js): put away on leave-tool and
     Clear, redrawn after an Undo. */
  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('supports-card', {
    live: function () { return S.open && S.mode !== 'auto'; },       // Auto draws what it always drew, and is left as it was
    close: function () { var menu = $('menu-supports'); if (menu && menu.open) menu.open = false; else if (S.open) close(); },
    clear: function () { dispose(S.pts); S.pts = null; dispose(S.zoneLayer); S.zoneLayer = null; dispose(S.eraseLayer); S.eraseLayer = null; },
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
    busy: function () { return S.busy; },
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
        percent: percentOf(S.prog), line: progressLine() } : null;
    },
    /** A test seam: fn(soup, opts) -> Promise of a plan replaces the worker's planTree (opts.onProgress takes its progress); null restores it. */
    setPlanner: function (fn) { S.planner = typeof fn === 'function' ? fn : null; },
    /** What the card shows now: beacons with their states, regions, rows, the words. */
    view: function () {
      var eff = S.eff || { beacons: [], regions: [], pitch: 3 };
      var st = S.hostId != null && eff.beacons.length ? statesFor(eff) : {};
      return {
        host: S.hostId, state: cardState(), mode: S.mode, tool: S.tool, error: eff.error || null, pitch: eff.pitch, angle: S.angle,
        beacons: eff.beacons.map(function (b) {
          return { key: b.key, p: pt(b), normal: b.normal, region: b.region, manual: b.manual, kind: b.need && b.need.kind, state: st[b.key], off: !!b.off, tip: !!b.tip };
        }),
        areas: eff.regions.map(function (r) {
          return { id: r.id, count: r.beacons.length, point: r.point, normal: r.normal, excluded: !!r.excluded,
            kind: S.hostId != null && eff.beacons.length ? areaKind(r, st) : null,
            built: r.beacons.some(function (b) { return st[b.key] === 'held' || st[b.key] === 'rest'; }) };
        }),
        stats: S.hostId != null && eff.beacons.length ? areaStats(eff, st) : null,
        rows: S.hostId != null && eff.beacons.length && cardState() === 'built' ? rowsFor(eff, st) : [],
        count: ($('sup-count') || {}).textContent || ''
      };
    },
    supports: function (hostId) { return supportsOf(hostId == null ? S.hostId : hostId); },

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
    forgetAll: forgetAll
  };
})();

if (typeof window !== 'undefined') window.NSO_SUPPORTS_CARD = NSO_SUPPORTS_CARD;
