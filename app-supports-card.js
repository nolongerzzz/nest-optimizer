/* ===================== Supports: the card =====================
   The column's SUPPORTS drop-down (make/edit group, after Seat): one card on
   the main page, a verb with a state. docs/SUPPORTS-CARD.md.

   No dots on the mesh. Each hanging AREA (one region of the beacon grid) is
   outlined faintly on the surface: an outline of the area's cells, not a grid.

   DETECT FIRST. Opening the card, or picking another piece while it is open,
   runs detection at once on the selected piece (the only piece on the plate,
   when nothing is selected). Every hanging area is outlined, and the card says
   "N hanging areas at 60\u00b0 on <piece>" with the angle editable right there:
   a new angle re-detects. Nothing is generated yet.
   IDLE      the areas are editable before GENERATE: a click on an outline
             leaves that area out (it dims) or puts it back; Shift-click on the
             piece adds a spot (one beacon, outlined like the rest). Nothing
             builds on a click. Style, Size and "May rest on the part" sit under
             GENERATE.
   BUILDING  GENERATE was pressed. The card is locked and one bar fills under
             the readout: "Planning 142 / 377 \u00b7 38 %" (beacons settled),
             then "Building 12 / 40 \u00b7 30 %" (trunks swept), the phase word
             changing as the build moves on; the bottom-right status says the
             same. A phase with no count (detecting, welding) shows its word
             and the seconds, "Welding \u00b7 14 s", on a bar that only moves;
             no percent is ever guessed. Escape cancels: the worker is
             terminated, the plate is as it was, Undo has nothing new. The
             planner runs in a worker so the page, the counter and the watchdog
             stay live; the watchdog is 60 s, and when it fires the bar is
             replaced by "Could not build: ...".
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
                 NSO_SupportGridpack.solid. The same planner G-scope's row
                 calls. Each solid it hands back says which beacons and which
                 area it holds (regionIds), so "this area's supports" and
                 "this support" are lookups on the piece's label, never a
                 geometry test.
     the pieces  every solid lands as its own plate piece, through
                 addModelFromZUpGeometry + placeModelMovable, labelled
                 m.nsoSupport = { card: true, hostSourceId, regionId, keys,
                 holds, ... }. G-scope sees it as a support (never a host);
                 its own row leaves card supports alone (supportsFor).

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
  var ANGLE_DEFAULT = 60;        // faces within 60 deg of horizontal: Bambu's 30 deg overhang threshold (90 - 60)
  var ANGLE_MIN = 1, ANGLE_MAX = 89;
  var ANGLE_DEBOUNCE_MS = 220;   // typing "3" on the way to "30" does not detect at 3
  var JOIN_PITCHES = 1.5;        // a manual beacon this close to a region joins it (the grid's own z rule)
  var PICK_PITCHES = 1.0;        // a click this close to a beacon is in that beacon's area
  var UP_MAX = 0.26;             // a face whose normal points up more than this (15 deg) holds nothing
  var ORDER = 30;                // over the piece and its outline
  var WATCHDOG_MS = 60000;       // a build that has not ended by now is stopped, and says so
  var ELAPSED_FROM_MS = 10000;   // a build the planner has said nothing about counts seconds once it has run this long
  var SLICE_MS = 250;            // on the page, a build gives the page a turn after this much work (repaint, Escape, the clock); a turn costs a frame of the 3D view
  /* The phases a build goes through, in order, as the planner names them
     (nso_support_gridpack.js, PROGRESS). A phase never goes back. */
  var PHASE_WORD = { detecting: 'Detecting', planning: 'Planning', building: 'Building', welding: 'Welding' };
  var PHASE_RANK = { detecting: 0, planning: 1, building: 2, welding: 3 };
  /* The planner's files, in index.html's order: what the build worker loads. */
  var ENGINE = ['nso_thickness.js', 'nso_support_beacons.js', 'nso_support_aim.js', 'nso_path_sweep.js',
    'nso_support_tree.js', 'nso_support_gridpack.js'];
  /* The card's state when the picked piece has no beacons at all. Detection
     only asks what hangs in air; a tall, thin piece that may sway as it
     prints is a different question, not asked yet, and the words say so. */
  var NOTHING = 'Nothing hangs in air. Tall-and-thin sway isn\'t checked yet.';

  var S = {
    open: false, hostId: null, selSupport: null, busy: false,
    det: null, occ: {}, eff: null, layer: null, raf: 0, sig: '', mem: {}, msg: null,
    geo: null, angle: ANGLE_DEFAULT, angleTimer: 0,
    watchdogMs: WATCHDOG_MS, planner: null, job: null, elapsed: 0,
    prog: null, listeners: [], said: null
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
    var det = sk.reason ? null : window.NSO_SupportAim.detectOverhangs(soup, opts);
    var err = sk.reason || (det && !det.ok ? det.reason : null) ||
      (det && !det.beacons ? (det.beaconsReason || 'no beacon grid') : null);
    S.det = { key: key, soup: soup, opts: opts, det: det, error: err, minZ: boundsOf(soup).lo[2] };
    return S.det;
  }

  function editsOf(m) {
    if (!m.nsoSupportEdits) m.nsoSupportEdits = { ops: [], serial: 0 };
    return m.nsoSupportEdits;
  }
  function memOf(id) {
    if (!S.mem[id]) S.mem[id] = { unreach: {}, built: false };
    return S.mem[id];
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
    if (!D || D.error) return { beacons: [], regions: [], pitch: 3, error: D ? D.error : 'that piece is gone' };
    var det = D.det, p = placedOf(S.hostId), m = modelOf(S.hostId);
    var pitch = det.grid ? det.grid.pitch : 3;
    var regionOf = new Map();
    (det.beaconRegions || []).forEach(function (r) { r.beacons.forEach(function (b) { regionOf.set(b, r.id); }); });
    /* A detected beacon is named by where it is, not by its place in the list:
       a new angle detects a different set, and the supports already standing
       (and the spots a build could not reach) must still find their beacons. */
    var list = (det.beacons || []).map(function (b) {
      return { key: 'd' + b.x.toFixed(2) + ',' + b.y.toFixed(2) + ',' + b.z.toFixed(2), x: b.x, y: b.y, z: b.z,
        normal: b.normal.slice(), need: b.need, region: regionOf.get(b), manual: false };
    });
    var left = {};
    var next = (det.beaconRegions || []).length;
    editsOf(m).ops.forEach(function (op) {
      var w = localToUp(p, op.p);
      if (op.op === 'add') {
        var n = localDirToUp(p, op.n), best = null, bd = Infinity;
        list.forEach(function (b) { var d = dist(pt(b), w); if (d < bd) { bd = d; best = b; } });
        var side = n[2] > -0.5;
        list.push({ key: 'm' + op.id, x: w[0], y: w[1], z: w[2], normal: n,
          need: { kind: side ? 'side' : 'face', manual: true }, manual: true,
          region: best && bd <= JOIN_PITCHES * pitch ? best.region : next++ });
      } else if (op.op === 'exclude' || op.op === 'include') {
        var near = null, nd = Infinity;
        list.forEach(function (b) { var d = dist(pt(b), w); if (d < nd) { nd = d; near = b; } });
        if (near && nd <= PICK_PITCHES * 1.5 * pitch) { if (op.op === 'exclude') left[near.region] = true; else delete left[near.region]; }
      }
    });
    var by = {};
    list.forEach(function (b) { (by[b.region] = by[b.region] || []).push(b); });
    var regions = Object.keys(by).map(Number).sort(function (a, b) { return a - b; }).map(function (id) {
      var B = by[id], c = [0, 0, 0], n = [0, 0, 0];
      B.forEach(function (b) { for (var k = 0; k < 3; k++) { c[k] += pt(b)[k] / B.length; n[k] += b.normal[k]; } });
      var L = Math.hypot(n[0], n[1], n[2]) || 1;
      return { id: id, beacons: B, point: c, normal: [n[0] / L, n[1] / L, n[2] / L], excluded: !!left[id] };
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
    eff.beacons.forEach(function (b) { out[b.key] = holds[b.key] || (lost[b.key] ? 'unreachable' : 'planned'); });
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
    if (rg.beacons.some(function (b) { return st[b.key] === 'unreachable'; })) return 'unreachable';
    if (rg.beacons.every(function (b) { return st[b.key] === 'held' || st[b.key] === 'rest'; })) return 'held';
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
    var m = modelOf(S.hostId);
    return plural(a.areas, 'hanging area', 'hanging areas') + ' at ' + S.angle + '\u00b0 on ' + (m ? m.name : 'the piece') +
      (a.left ? ' \u00b7 ' + a.left + ' left out' : '');
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
    if (!S.open || S.hostId == null || !state.scene) return;
    var eff = S.eff;
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
    if (!S.eff.beacons.length) return 'nothing';
    if (S.busy) return 'building';
    return memOf(S.hostId).built ? 'built' : 'idle';
  }

  /* What a build says when the planner has told it nothing (a planner set
     with setPlanner that does not report): "Building\u2026", and the seconds once
     it has run past ELAPSED_FROM_MS. */
  function buildingLine() {
    return S.elapsed * 1000 >= ELAPSED_FROM_MS ? 'Building\u2026 ' + S.elapsed + ' s' : 'Building\u2026';
  }
  /* The percent of a counted phase: the nearest whole number, but 100 only
     when the work is done (1999 of 2000 is 99), and null when there is no
     count - a phase that has none shows its word and the seconds instead. */
  function percentOf(pg) {
    if (!pg || pg.done == null || !(pg.total > 0)) return null;
    return pg.done >= pg.total ? 100 : Math.min(99, Math.round(100 * pg.done / pg.total));
  }
  /* "Planning 142 / 377 \u00b7 38 %", or "Welding \u00b7 14 s" for a phase with no
     count. The seconds are the build's own, the ones the watchdog counts. */
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
    if (hasHost && eff && !eff.error && eff.beacons.length) { st = statesFor(eff); a = areaStats(eff, st); }
    if (card) { card.dataset.state = cs; card.classList.toggle('is-locked', !!S.busy); }
    document.body.classList.toggle('sup-card-open', !!S.open);
    if (S.msg) { text = S.msg.text; bad = !!S.msg.bad; }
    else if (cs === 'pick') text = 'Click a piece to see where it needs holding.';
    else if (cs === 'error') { text = eff.error; bad = true; }
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
    if (note) note.textContent = S.angle + '\u00b0 \u00b7 Bambu ' + (90 - S.angle) + '\u00b0';
    var ang = $('sup-angle');
    if (ang && document.activeElement !== ang && ang.value !== String(S.angle)) ang.value = String(S.angle);
    drawRows(cs === 'built' && st ? rowsFor(eff, st) : []);
    paintBar();
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
      '|' + S.angle;
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
      '  if (d.plan) {\n' +                       // the trunks of a plan, swept (NSO_SupportGridpack.parts)
      '    if (d.plan.rawTris === null) d.plan.rawTris = self.soup;\n' +
      '    self.NSO_SupportGridpack.parts(d.plan, d.opts).then(function (tp) { self.postMessage({ id: d.id, parts: tp }); },\n' +
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
  /* The trunks of a plan swept (NSO_SupportGridpack.parts), on the job's
     worker too, so that stretch of work is off the page as well. Without a
     worker it is swept here, a trunk at a time, with a turn for the page
     between (yieldFn). Progress comes back to onProgress as it is posted. */
  function partsAway(job, plan, onProgress, yieldFn) {
    if (job.worker === undefined) job.worker = startWorker();
    if (!job.worker) return window.NSO_SupportGridpack.parts(plan, { onProgress: onProgress, yieldFn: yieldFn });
    return new Promise(function (resolve, reject) {
      var w = job.worker.w, id = ++job.seq;
      w.onmessage = function (e) {
        if (e.data.id !== id) return;
        if (e.data.progress) { if (onProgress) onProgress(e.data.progress, e.data.at); return; }
        if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.parts);
      };
      w.onerror = function (e) { reject(new Error((e && e.message) || 'the planner stopped')); };
      /* A plan from the worker comes back without the piece (rawTris null), and the worker puts its own copy back. */
      w.postMessage({ id: id, plan: plan, opts: {} });
    });
  }

  /* One area through the planner: the PLANNING step. Resolves { result } when
     there is nothing to build (the planner refused it, or put every spot
     inside the piece), else { rid, t, keyOf, landingOf, unreach } - the plan,
     for building and welding to take up. */
  function planArea(job, D, rid, beacons, o, onProgress) {
    var bs = beacons.map(function (b) { return { x: b.x, y: b.y, z: b.z, normal: b.normal, regionId: rid, key: b.key }; });
    var opts = Object.assign({}, D.opts, { beacons: bs, style: o.style, restOnModel: o.rest });
    if (o.sideMm != null) opts.sideMm = o.sideMm;
    return planAway(job, D.soup, opts, onProgress).then(function (t) {
      if (!t || typeof t !== 'object') throw new Error('the planner gave no plan');
      var keyOf = function (id) { return t.beacons && t.beacons[id] ? t.beacons[id].key : null; };
      if (!t.ok) {
        var all = t.inside && t.inside.length ? beacons.map(function (b) { return b.key; }) : [];
        return { result: { ok: !!all.length, rid: rid, solids: [], unreachable: all, reason: t.reason } };
      }
      var landingOf = {};
      t.trunks.forEach(function (tr) { tr.beacons.forEach(function (id) { landingOf[id] = tr.landing; }); });
      return { rid: rid, t: t, keyOf: keyOf, landingOf: landingOf, unreach: t.unreachable.concat(t.inside).map(keyOf) };
    });
  }
  /* The area's answer, from its plan and what welding made of it: { ok, rid,
     solids, unreachable, reason }, each solid { soup, keys, holds, landing }
     in the planner's own words - nothing is aimed or moved here. */
  function areaResult(a, u) {
    if (!u.ok) return { ok: false, rid: a.rid, solids: [], unreachable: [], reason: u.reason };
    var solids = u.solids.map(function (x) {
      var holds = {};
      x.beacons.forEach(function (id) { holds[a.keyOf(id)] = a.landingOf[id] === 'rest' ? 'rest' : 'held'; });
      return { soup: x.soup, keys: x.beacons.map(a.keyOf), holds: holds, landing: x.landing, regionIds: x.regionIds };
    });
    return { ok: true, rid: a.rid, solids: solids, unreachable: a.unreach, sideMm: a.t.sideMm, reason: a.t.reason };
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
    return function () {
      var mm = modelOf(hostId);
      if (mm) mm.nsoSupportEdits = { ops: ops.slice(), serial: serial };
      memOf(hostId).unreach = JSON.parse(JSON.stringify(unreach));
      memOf(hostId).built = built;
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
   *   building               each area's trunks swept (nso_support_gridpack parts), in the worker
   *   welding                each area's unions (weld), on the page - the one stretch the page does
   * and tells the bar as it goes (note). Planning and building have counts
   * (beacons settled, trunks swept) summed over every area; detecting and
   * welding have none, and the bar says so.
   *
   * A build ENDS IN A STATE. Planning is all that can take long, and it makes
   * no change to the plate: the plate is touched in one stretch of
   * synchronous code at the very end (commit), and only if the build is still
   * live. So a refusal, an exception, Escape or the watchdog - which stop the
   * worker and mark the build dead - leave the plate exactly as it was, with
   * no Undo step; the card says "Could not build: <why> - nothing was added"
   * (or "Build cancelled - nothing was added") and is back in the state it
   * was in before.
   */
  function build() {
    if (S.busy) return Promise.resolve({ ok: false, reason: 'busy' });
    var host = placedOf(S.hostId), hm = modelOf(S.hostId), D = detect();
    if (!host || !D || D.error) return Promise.resolve({ ok: false, reason: D ? D.error : 'no piece' });
    var eff = S.eff = effective(), o = cardOpts(), hostId = S.hostId;
    var regs = eff.regions.filter(function (r) { return !r.excluded; });
    var removeIds = supportsOf(hostId).map(function (m) { return m.id; });
    if (!regs.length) {
      S.msg = { text: 'Every area is left out. Click one to put it back.', bad: true };
      sync();
      return Promise.resolve({ ok: false, reason: 'nothing to build' });
    }
    var job = { seq: 0, dead: false, t0: Date.now(), worker: undefined, sentSoup: false, stop: null, timer: 0, clock: 0, rank: -1 };
    var limit = S.watchdogMs, secs = Math.round(limit / 100) / 10;
    function late() { var e = new Error('the planner was still working after ' + secs + ' s'); e.timeout = true; return e; }
    var spots = regs.reduce(function (n, r) { return n + r.beacons.length; }, 0);
    S.job = job; S.busy = true; S.msg = null; S.elapsed = 0; S.prog = null; sync();
    var guard = new Promise(function (go, stop) { job.stop = stop; });
    job.timer = setTimeout(function () { job.stop(late()); }, limit);
    job.clock = setInterval(function () { S.elapsed = Math.floor((Date.now() - job.t0) / 1000); sync(); }, 1000);

    /* A turn for the page between units of work on it: the bar repaints, the
       clock and Escape are heard. It also reads the clock (a unit that blocks
       the thread cannot be interrupted, so it is caught after) and refuses to
       go on once the build is dead. */
    var sliceFrom = Date.now();
    function pause() {
      if (job.dead) throw new Error('the build was stopped');
      if (Date.now() - job.t0 > limit) throw late();
      if (Date.now() - sliceFrom < SLICE_MS) return undefined;
      return new Promise(function (go) { setTimeout(go, 0); }).then(function () {
        sliceFrom = Date.now();
        if (job.dead) throw new Error('the build was stopped');
      });
    }

    var areas = [], solidsOf = [], chain = new Promise(function (go) {
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
        var at = settledBefore, mine = rg.beacons.length;
        settledBefore += mine;
        return planArea(job, D, rg.id, rg.beacons, o, function (m, sent) {
          /* Each area's planner starts with its own 'detecting'; note() drops
             it once the build is past that phase. The counts are this
             build's, summed over the areas. */
          note(job, m && m.phase === 'planning' ? { phase: 'planning', done: at + m.done, total: spots, own: mine, ownDone: m.done } : m, sent);
        }).then(function (a) {
          areas.push(a);
          return pause() || new Promise(function (go) { setTimeout(go, 0); });
        });
      });
    });

    /* 2. BUILDING: the trunks of every area that has a plan, swept. */
    var swept = [];
    chain = chain.then(function () {
      if (job.dead) return null;
      /* Every area has been through the planner, and every spot in it is settled (an area the planner
         refused counts: its spots are named unreachable or inside). */
      note(job, { phase: 'planning', done: spots, total: spots, own: spots, ownDone: spots });
      var live = areas.filter(function (a) { return a.t; });
      var trunks = live.reduce(function (n, a) { return n + a.t.trunks.length; }, 0), before = 0, next = Promise.resolve();
      live.forEach(function (a) {
        next = next.then(function () {
          var at = before;
          before += a.t.trunks.length;
          return partsAway(job, a.t, function (m, sent) {
            note(job, m && m.phase === 'building' ? { phase: 'building', done: at + m.done, total: trunks } : m, sent);
          }, pause).then(function (tp) { swept.push({ a: a, tp: tp }); });
        });
      });
      return next.then(function () { stopWorker(job); });     // the worker's work is done; welding is the page's
    });

    /* 3. WELDING: every area's unions, joined into solids. */
    chain = chain.then(function () {
      if (job.dead) return null;
      var next = Promise.resolve();
      swept.forEach(function (x) {
        next = next.then(function () {
          if (!x.tp.ok) { solidsOf.push({ a: x.a, u: { ok: false, reason: x.tp.reason } }); return null; }
          return gp().weld(x.a.t, x.tp, { yieldFn: pause, onProgress: function (m) { note(job, m); } })
            .then(function (u) { solidsOf.push({ a: x.a, u: u }); });
        });
      });
      return next;
    });

    /* The one place the plate changes. Synchronous from the first removal to
       the Undo step, so nothing can interleave; on any failure inside it
       everything is put back and no step is recorded. */
    function commit() {
      if (job.dead) return { ok: false, reason: 'the build was stopped' };
      var results = areas.map(function (a) {
        if (!a.t) return a.result;
        var x = solidsOf.find(function (y) { return y.a === a; });
        return areaResult(a, x ? x.u : { ok: false, reason: 'the area was not built' });
      });
      var failed = results.filter(function (r) { return !r.ok; });
      if (failed.length) return { ok: false, reason: failed[0].reason || 'the planner refused' };
      var undo = snapshot(), removed = [], added = [], n = 0, mem = memOf(hostId);
      try {
        removed = removePieces(removeIds);
        mem.unreach = {};
        for (var i = 0; i < results.length; i++) {
          var r = results[i];
          mem.unreach[r.rid] = r.unreachable.slice();
          for (var k = 0; k < r.solids.length; k++) {
            var sd = r.solids[k];
            var meta = { card: true, hostSourceId: hostId, hostName: hm.name, regionId: r.rid, style: o.style,
              sideMm: r.sideMm || o.sideMm, rest: o.rest, angleDeg: S.angle, keys: sd.keys, holds: sd.holds, landing: sd.landing };
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
      clearTimeout(job.timer); clearInterval(job.clock);
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
    if (!ids.length && !(reset && (mem.built || Object.keys(mem.unreach).length))) return { ok: false, reason: 'nothing to take off' };
    var undo = snapshot();
    var removed = removePieces(ids);
    if (reset) { mem.unreach = {}; mem.built = false; }
    pushUndo({ type: 'supportSwap', removed: removed, addedIds: [], label: label, onUndone: undo });
    S.msg = null;
    afterCommit();
    return { ok: true, removed: ids.slice() };
  }

  function generate() {
    if (S.hostId == null) return Promise.resolve({ ok: false, reason: 'no piece' });
    S.eff = effective();
    if (S.eff.error || !S.eff.beacons.length) { refresh(); return Promise.resolve({ ok: false, reason: S.eff.error || 'nothing needs holding' }); }
    return build();
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
    if (S.job && S.job.stop) { var j = S.job; j.dead = true; j.stop(new Error('the card was closed')); }
    clearTimeout(S.angleTimer); S.angleTimer = 0;
    S.open = false; S.hostId = null; S.selSupport = null; S.msg = null; S.det = null; S.occ = {};
    dispose(S.layer); S.layer = null;
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
    var h = hitAt(ev);
    if (!h) return;                                 // empty space: the view still orbits
    if (isSupport(h.id)) selectSupport(h.id);
    else if (h.id !== S.hostId) pick(h.id);
    else if (ev.shiftKey) addBeacon(h.p, h.n);
    else {
      var area = areaAt(ev);
      if (area != null) toggleArea(area);           // nothing builds on a click
      else if (S.selSupport != null || S.msg) { S.selSupport = null; S.msg = null; pick(S.hostId); }
    }
    ev.stopImmediatePropagation(); ev.preventDefault();
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
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    sync();
  }
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
    /** The watchdog, ms: a build still running past it is stopped. Default 60000. */
    watchdogMs: function (v) { if (v !== undefined) S.watchdogMs = v > 0 ? +v : WATCHDOG_MS; return S.watchdogMs; },
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
        host: S.hostId, state: cardState(), error: eff.error || null, pitch: eff.pitch, angle: S.angle,
        beacons: eff.beacons.map(function (b) {
          return { key: b.key, p: pt(b), normal: b.normal, region: b.region, manual: b.manual, kind: b.need && b.need.kind, state: st[b.key] };
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
    supports: function (hostId) { return supportsOf(hostId == null ? S.hostId : hostId); }
  };
})();

if (typeof window !== 'undefined') window.NSO_SUPPORTS_CARD = NSO_SUPPORTS_CARD;
