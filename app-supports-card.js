/* ===================== Supports: the card =====================
   The column's SUPPORTS drop-down (make/edit group, after Seat): one card on
   the main page, a verb with a state. docs/SUPPORTS-CARD.md.

   No dots on the mesh. Each overhang AREA (one region of the beacon grid) is
   outlined faintly on the surface: an outline of the area's cells, not a grid.

   IDLE      a piece is picked. The card says "N overhang areas"; GENERATE is
             the one big button; Style, Size and "May rest on the part" sit
             under it. A click on an outlined area leaves it out (outline
             grey, the count drops) or puts it back. Nothing builds on a click.
   BUILDING  GENERATE was pressed. The button reads "Building…", the card is
             locked, a spinner turns over the piece.
   BUILT     "Built: N supports · M of K areas held · J areas not reachable
             from the plate". GENERATE is now REGENERATE (it replaces every
             support on the piece); REMOVE ALL sits beside it. A click on a
             built support picks it; REMOVE takes that one. Areas the plate
             could not reach stay outlined in red.
   Paint Hold / Skip is a secondary row, collapsed; shift-click on the piece
   still adds a manual spot (an area of its own, or part of the nearest one).
   The HUD (#status) mirrors the state line and nothing else. Every state
   change - leaving an area out, a manual or painted spot, a build, a removal -
   is ONE Undo (a supportSwap step; its onUndone puts the card's own record of
   the piece back).

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
  var ANGLE_DEG = 45;            // detectOverhangs' own default
  var JOIN_PITCHES = 1.5;        // a manual beacon this close to a region joins it (the grid's own z rule)
  var PAINT_R_PITCHES = 0.5;     // the paint stroke's radius: one grid row wide
  var PICK_PITCHES = 1.0;        // a click this close to a beacon is in that beacon's area
  var UP_MAX = 0.26;             // a face whose normal points up more than this (15 deg) holds nothing
  var ORDER = 30;                // over the piece and its outline
  /* The card's state when the picked piece has no beacons at all. Detection
     only asks what hangs in air; a tall, thin piece that may sway as it
     prints is a different question, not asked yet, and the words say so. */
  var NOTHING = 'Nothing hangs in air. Tall-and-thin sway isn\'t checked yet.';

  var S = {
    open: false, hostId: null, selSupport: null, paint: null, stroke: null, busy: false,
    det: null, occ: {}, eff: null, layer: null, ring: null, raf: 0, sig: '', mem: {}, msg: null,
    hud: null, spin: null, geo: null
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
    var key = poseKey(p) + '#' + occ.map(poseKey).join('#') + '#' + ((typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0);
    if (S.det && S.det.key === key) return S.det;
    var soup = worldUp(p.mesh), sk = skipListFor(m, p, soup);
    var opts = { skipList: sk.list, angleDeg: ANGLE_DEG, occluders: occ.map(occluderSoup) };
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
   * own (numbered after detection's); a Skip disc takes out every beacon
   * within its radius - detected or manual, as the list stands then. An
   * 'exclude' leaves out the area of the beacon nearest its point, an
   * 'include' puts it back (the list as it stands then, so ids stay put).
   */
  function effective() {
    var D = detect();
    if (!D || D.error) return { beacons: [], regions: [], pitch: 3, error: D ? D.error : 'that piece is gone' };
    var det = D.det, p = placedOf(S.hostId), m = modelOf(S.hostId);
    var pitch = det.grid ? det.grid.pitch : 3;
    var regionOf = new Map();
    (det.beaconRegions || []).forEach(function (r) { r.beacons.forEach(function (b) { regionOf.set(b, r.id); }); });
    var list = (det.beacons || []).map(function (b, i) {
      return { key: 'd' + i, x: b.x, y: b.y, z: b.z, normal: b.normal.slice(), need: b.need, region: regionOf.get(b), manual: false };
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
      } else if (op.op === 'skip') {
        list = list.filter(function (b) { return dist(pt(b), w) > op.r; });
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
     last build of its region could not reach. */
  function statesFor(eff) {
    var holds = {};
    cardSupports(S.hostId).forEach(function (m) {
      var h = m.nsoSupport.holds || {};
      Object.keys(h).forEach(function (k) { holds[k] = h[k]; });
    });
    var un = memOf(S.hostId).unreach, out = {};
    eff.beacons.forEach(function (b) {
      out[b.key] = holds[b.key] || ((un[b.region] || []).indexOf(b.key) >= 0 ? 'unreachable' : 'planned');
    });
    return out;
  }
  /* The numbers on the BUILT line, over the areas not left out. An area is
     held when every one of its spots is held from the plate or rests on the
     part; it is not reachable when the plate could not reach at least one of
     them. (An area can be neither - spots taken off by hand - and one area is
     never both.) */
  function areaStats(eff, st) {
    var out = { areas: 0, left: 0, held: 0, unreachable: 0, supports: cardSupports(S.hostId).length };
    eff.regions.forEach(function (rg) {
      if (rg.excluded) { out.left++; return; }
      out.areas++;
      var all = rg.beacons.every(function (b) { return st[b.key] === 'held' || st[b.key] === 'rest'; });
      var un = rg.beacons.some(function (b) { return st[b.key] === 'unreachable'; });
      if (un) out.unreachable++; else if (all) out.held++;
    });
    return out;
  }
  function builtLine(a) {
    return 'Built: ' + plural(a.supports, 'support', 'supports') + ' \u00b7 ' + a.held + ' of ' + a.areas +
      (a.areas === 1 ? ' area' : ' areas') + ' held \u00b7 ' + plural(a.unreachable, 'area', 'areas') + ' not reachable from the plate';
  }
  function idleLine(a) {
    return plural(a.areas, 'overhang area', 'overhang areas') + (a.left ? ' \u00b7 ' + a.left + ' left out' : '');
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

  function showRing(hit) {
    if (S.ring) { dispose(S.ring); S.ring = null; }
    if (!hit || !S.paint || !state.scene || !S.eff) return;
    var R = S.eff.pitch * PAINT_R_PITCHES;
    var m = overlay(new THREE.Mesh(new THREE.RingGeometry(R * 0.86, R, 32), new THREE.MeshBasicMaterial({
      color: S.paint === 'skip' ? 0xff2d2d : 0x22d3ee, side: THREE.DoubleSide, transparent: true, opacity: 0.9,
      depthTest: false, depthWrite: false })), ORDER + 4);
    m.position.copy(upToView([hit.p[0] + hit.n[0] * 0.05, hit.p[1] + hit.n[1] * 0.05, hit.p[2] + hit.n[2] * 0.05]));
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), upToView(hit.n).normalize());
    m.name = 'supportsCardRing';
    state.scene.add(m);
    S.ring = m;
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

  /* The HUD says what the card's state line says, and nothing else. */
  function mirror(text, bad) {
    S.hud = text;
    if (typeof setStatus === 'function') setStatus(text, !!bad);
  }

  function spinner() {
    if (!S.spin) {
      var e = document.createElement('div');
      e.id = 'sup-spinner'; e.className = 'sup-spinner'; e.hidden = true;
      e.setAttribute('role', 'status'); e.setAttribute('aria-label', 'Building supports');
      document.body.appendChild(e);
      S.spin = e;
    }
    return S.spin;
  }
  /* A ring turning over the piece's middle while a build runs. */
  function placeSpinner() {
    var e = S.spin;
    if (!e || e.hidden) return;
    var p = placedOf(S.hostId);
    if (!p || !p.mesh || !state.camera || !state.renderer) return;
    var c = new THREE.Box3().setFromObject(p.mesh).getCenter(new THREE.Vector3()).project(state.camera);
    var r = state.renderer.domElement.getBoundingClientRect();
    e.style.left = (r.left + (c.x + 1) / 2 * r.width) + 'px';
    e.style.top = (r.top + (1 - c.y) / 2 * r.height) + 'px';
  }

  function sync() {
    var head = $('sup-count'), card = $('supports-card');
    var hasHost = S.hostId != null && !!placedOf(S.hostId);
    var eff = S.eff, text, bad = false, cs = cardState(), a = null;
    if (hasHost && eff && !eff.error && eff.beacons.length) a = areaStats(eff, statesFor(eff));
    if (card) { card.dataset.state = cs; card.classList.toggle('is-locked', !!S.busy); }
    if (S.msg) { text = S.msg.text; bad = !!S.msg.bad; }
    else if (cs === 'pick') text = 'Click a piece to see where it needs holding.';
    else if (cs === 'error') { text = eff.error; bad = true; }
    else if (cs === 'nothing') text = NOTHING;
    else if (cs === 'building') text = 'Building\u2026';
    else if (cs === 'built') text = builtLine(a);
    else text = idleLine(a);
    if (head) { head.textContent = text; head.classList.toggle('is-bad', bad); }
    if (S.open) mirror(text, bad);
    var some = hasHost && eff && !eff.error;
    var en = function (id, on) { var e = $(id); if (e) e.disabled = !on || !!S.busy; };
    var go = $('btn-sup-all');
    if (go) go.textContent = cs === 'building' ? 'Building\u2026' : cs === 'built' ? 'Regenerate' : 'Generate';
    en('btn-sup-all', (cs === 'idle' || cs === 'built') && a && a.areas > 0);
    var none = $('btn-sup-none'), rm = $('btn-sup-remove');
    var wasBuilt = hasHost && memOf(S.hostId).built && (cs === 'built' || cs === 'building');
    if (none) none.hidden = !wasBuilt;
    if (rm) rm.hidden = !wasBuilt;
    en('btn-sup-none', cs === 'built');
    en('btn-sup-remove', cs === 'built' && S.selSupport != null && !!modelOf(S.selSupport));
    en('btn-sup-paint', some);
    ['sel-sup-paint', 'sup-style', 'sup-size', 'sup-rest'].forEach(function (id) { var e = $(id); if (e) e.disabled = !!S.busy; });
    var pb = $('btn-sup-paint');
    if (pb) { pb.setAttribute('aria-pressed', S.paint ? 'true' : 'false'); pb.classList.toggle('is-armed', !!S.paint); pb.textContent = S.paint ? 'Paint: on' : 'Paint'; }
    var sp = spinner();
    sp.hidden = !(S.open && S.busy);
    placeSpinner();
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
      '|' + JSON.stringify(memOf(S.hostId).unreach).length + '|' + memOf(S.hostId).built + '|' + ((typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0);
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

  /* One region through the planner. Resolves { ok, rid, solids, unreachable,
     reason }: each solid { soup, keys, holds, landing } in the planner's
     own words - nothing is aimed or moved here. */
  function planRegion(D, rid, beacons, o) {
    var bs = beacons.map(function (b) { return { x: b.x, y: b.y, z: b.z, normal: b.normal, regionId: rid, key: b.key }; });
    var opts = Object.assign({}, D.opts, { beacons: bs, style: o.style, restOnModel: o.rest });
    if (o.sideMm != null) opts.sideMm = o.sideMm;
    var t = window.NSO_SupportTree.planTree(D.soup, opts);
    var keyOf = function (id) { return t.beacons && t.beacons[id] ? t.beacons[id].key : null; };
    if (!t.ok) {
      var all = t.inside && t.inside.length ? beacons.map(function (b) { return b.key; }) : [];
      return Promise.resolve({ ok: !!all.length, rid: rid, solids: [], unreachable: all, reason: t.reason });
    }
    var landingOf = {};
    t.trunks.forEach(function (tr) { tr.beacons.forEach(function (id) { landingOf[id] = tr.landing; }); });
    var unreach = t.unreachable.concat(t.inside).map(keyOf);
    return window.NSO_SupportGridpack.solid(t).then(function (u) {
      if (!u.ok) return { ok: false, rid: rid, solids: [], unreachable: [], reason: u.reason };
      var solids = u.solids.map(function (x) {
        var holds = {};
        x.beacons.forEach(function (id) { holds[keyOf(id)] = landingOf[id] === 'rest' ? 'rest' : 'held'; });
        return { soup: x.soup, keys: x.beacons.map(keyOf), holds: holds, landing: x.landing, regionIds: x.regionIds };
      });
      return { ok: true, rid: rid, solids: solids, unreachable: unreach, sideMm: t.sideMm, reason: t.reason };
    });
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
   * GENERATE / REGENERATE: build every area not left out (planned one at a
   * time, in order) and put every solid on the plate, taking every support
   * already on the piece off first: one undo step for the lot. An area the
   * plan cannot reach adds nothing; its spots are remembered as unreachable
   * until the next build or REMOVE ALL.
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
    S.busy = true; S.msg = null; sync();
    var results = [], chain = new Promise(function (go) {
      /* One frame and a tick first: the card and the spinner are on screen
         before the planner takes the thread. */
      requestAnimationFrame(function () { setTimeout(go, 0); });
    });
    regs.forEach(function (rg) {
      chain = chain.then(function () { return planRegion(D, rg.id, rg.beacons, o).then(function (r) { results.push(r); }); });
    });
    return chain.then(function () {
      var failed = results.filter(function (r) { return !r.ok; });
      if (failed.length) {
        S.busy = false;
        S.msg = { text: 'Not built: ' + failed[0].reason, bad: true };
        refresh();
        return { ok: false, reason: failed[0].reason };
      }
      var undo = snapshot();
      var removed = removePieces(removeIds), added = [], n = 0;
      var mem = memOf(hostId);
      mem.unreach = {};
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        mem.unreach[r.rid] = r.unreachable.slice();
        for (var k = 0; k < r.solids.length; k++) {
          var s = r.solids[k];
          var meta = { card: true, hostSourceId: hostId, hostName: hm.name, regionId: r.rid, style: o.style,
            sideMm: r.sideMm || o.sideMm, rest: o.rest, angleDeg: ANGLE_DEG, keys: s.keys, holds: s.holds, landing: s.landing };
          var pl = placeSolid(s.soup, meta, host, D.minZ, hm.name + ' - support ' + (r.rid + 1) + '.' + (++n) + ' (' + STYLES[o.style] + ')');
          if (!pl.ok) {
            dropAdded(added); restorePieces(removed); undo();
            S.busy = false;
            S.msg = { text: 'Not built: ' + pl.reason + '.', bad: true };
            afterCommit();
            return { ok: false, reason: pl.reason };
          }
          added.push(pl.id);
        }
      }
      mem.built = true;
      pushUndo({ type: 'supportSwap', removed: removed, addedIds: added,
        label: removed.length ? 'Undo: supports on the piece put back as they were' : 'Undo: supports taken off', onUndone: undo });
      S.busy = false;
      afterCommit();
      return { ok: true, added: added, removed: removed.map(function (x) { return x.placed.sourceId; }),
        stats: areaStats(S.eff, statesFor(S.eff)), line: ($('sup-count') || {}).textContent || '' };
    }).catch(function (err) {
      console.error('[supports card]', err);
      S.busy = false;
      S.msg = { text: 'Something went wrong - nothing was built.', bad: true };
      refresh();
      return { ok: false, reason: (err && err.message) || String(err) };
    });
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

  /* One paint sample: Hold adds a beacon here when none is within a grid
     pitch; Skip drops a disc that takes out every beacon inside it. */
  function paintSample(p, n) {
    var host = placedOf(S.hostId), m = modelOf(S.hostId), E = editsOf(m), eff = S.eff;
    if (!eff || eff.error) return false;
    if (S.paint === 'skip') {
      var R = eff.pitch * PAINT_R_PITCHES;
      E.ops.push({ op: 'skip', p: upToLocal(host, p), r: R });
      var before = eff.beacons.length;
      eff.beacons = eff.beacons.filter(function (b) { return dist(pt(b), p) > R; });
      return eff.beacons.length !== before;
    }
    if (n[2] > UP_MAX) return false;
    for (var i = 0; i < eff.beacons.length; i++) if (dist(pt(eff.beacons[i]), p) < eff.pitch * 0.999) return false;
    E.ops.push({ op: 'add', id: ++E.serial, p: upToLocal(host, p), n: upDirToLocal(host, n) });
    eff.beacons.push({ key: 'm' + E.serial, x: p[0], y: p[1], z: p[2], normal: n });   // spacing only; refresh() places it properly
    return true;
  }

  function strokeTo(h) {
    var s = S.stroke, step = S.eff.pitch * PAINT_R_PITCHES / 2, changed = false;
    if (s.last) {
      var d = dist(s.last, h.p), k = Math.max(1, Math.ceil(d / step));
      for (var i = 1; i <= k; i++) {
        var t = i / k;
        changed = paintSample([s.last[0] + (h.p[0] - s.last[0]) * t, s.last[1] + (h.p[1] - s.last[1]) * t,
          s.last[2] + (h.p[2] - s.last[2]) * t], h.n) || changed;
      }
    } else changed = paintSample(h.p, h.n);
    s.last = h.p.slice();
    if (changed) s.changed = true;
    refresh();
  }

  function endStroke() {
    var s = S.stroke;
    S.stroke = null;
    if (state.controls) state.controls.enabled = true;
    if (!s) return;
    var m = modelOf(S.hostId);
    if (!s.changed) { if (m) m.nsoSupportEdits = { ops: s.ops, serial: s.serial }; refresh(); return; }
    pushEdit(s.undo, S.paint === 'skip' ? 'Undo: skipped spots back' : 'Undo: painted spots taken away');
    refresh();
  }

  function setPaint(mode) {
    S.paint = mode === 'hold' || mode === 'skip' ? mode : null;
    var sel = $('sel-sup-paint');
    if (S.paint && sel) sel.value = S.paint;
    if (!S.paint) showRing(null);
    S.msg = null;
    refresh();
  }

  /* --------------------------------------------------------- open, close */

  function tick() {
    if (!S.open) return;
    var menu = $('menu-supports');
    if (menu && !menu.open) { close(); return; }
    if (!S.busy && !S.stroke) {
      if (S.hostId != null && !placedOf(S.hostId)) { S.hostId = null; S.selSupport = null; refresh(); }
      else if (signature() !== S.sig) refresh();
    } else placeSpinner();
    S.raf = requestAnimationFrame(tick);
  }
  function open() {
    if (S.open) return;
    S.open = true; S.hostId = null; S.selSupport = null; S.msg = null; S.det = null; S.occ = {};
    refresh();
    S.raf = requestAnimationFrame(tick);
  }
  function close() {
    if (S.stroke) endStroke();
    S.open = false; S.hostId = null; S.selSupport = null; S.paint = null; S.msg = null; S.det = null; S.occ = {};
    showRing(null);
    dispose(S.layer); S.layer = null;
    if (S.raf) cancelAnimationFrame(S.raf);
    S.raf = 0;
    sync();
    var el = $('status');
    if (el && S.hud != null && el.textContent === S.hud && typeof setStatus === 'function') setStatus('');
    S.hud = null;
  }

  /* --------------------------------------------------------- the pointer */

  function onCanvas(ev) { return state.renderer && ev.target === state.renderer.domElement; }

  function onDown(ev) {
    if (!S.open || S.busy || ev.button !== 0 || !onCanvas(ev)) return;
    var h = hitAt(ev);
    if (!h) return;                                 // empty space: the view still orbits
    if (isSupport(h.id)) selectSupport(h.id);
    else if (h.id !== S.hostId) pick(h.id);
    else if (S.paint && S.eff && !S.eff.error) {
      var m = modelOf(S.hostId), E = editsOf(m);
      S.stroke = { undo: snapshot(), ops: E.ops.slice(), serial: E.serial, last: null, changed: false };
      if (state.controls) state.controls.enabled = false;
      strokeTo(h);
    } else if (ev.shiftKey) addBeacon(h.p, h.n);
    else {
      var area = areaAt(ev);
      if (area != null) toggleArea(area);           // nothing builds on a click
      else if (S.selSupport != null || S.msg) { S.selSupport = null; S.msg = null; pick(S.hostId); }
    }
    ev.stopImmediatePropagation(); ev.preventDefault();
  }
  function onMove(ev) {
    if (!S.open) return;
    if (S.stroke) {
      var h = hitAt(ev);
      if (h && h.id === S.hostId) strokeTo(h); else S.stroke.last = null;
      showRing(h && h.id === S.hostId ? h : null);
      ev.stopImmediatePropagation();
      return;
    }
    if (S.paint && onCanvas(ev)) {
      var hv = hitAt(ev);
      showRing(hv && hv.id === S.hostId ? hv : null);
    }
  }
  function onUp(ev) {
    if (!S.open || !S.stroke) return;
    endStroke();
    ev.stopImmediatePropagation();
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
    on('btn-sup-paint', 'click', function () { setPaint(S.paint ? null : (($('sel-sup-paint') || {}).value || 'hold')); });
    on('sel-sup-paint', 'change', function () { if (S.paint) setPaint($('sel-sup-paint').value); });
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('keydown', function (e) {
      if (!S.open || e.key !== 'Escape') return;
      if (S.stroke) endStroke(); else if (S.paint) setPaint(null);
    }, true);
    sync();
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }

  return {
    STYLES: Object.assign({}, STYLES),
    PAINT_R_PITCHES: PAINT_R_PITCHES,
    isOpen: function () { return S.open; },
    host: function () { return S.hostId; },
    pick: pick,
    generate: generate,
    removeAll: removeAll,
    toggleArea: toggleArea,
    selectSupport: selectSupport,
    selected: function () { return S.selSupport; },
    removeSelected: removeSelected,
    addBeacon: addBeacon,
    setPaint: setPaint,
    paint: function () { return S.paint; },
    busy: function () { return S.busy; },
    /** What the card shows now: beacons with their states, regions, the words. */
    view: function () {
      var eff = S.eff || { beacons: [], regions: [], pitch: 3 };
      var st = S.hostId != null && eff.beacons.length ? statesFor(eff) : {};
      return {
        host: S.hostId, state: cardState(), error: eff.error || null, pitch: eff.pitch,
        beacons: eff.beacons.map(function (b) {
          return { key: b.key, p: pt(b), normal: b.normal, region: b.region, manual: b.manual, kind: b.need && b.need.kind, state: st[b.key] };
        }),
        areas: eff.regions.map(function (r) {
          return { id: r.id, count: r.beacons.length, point: r.point, normal: r.normal, excluded: !!r.excluded,
            built: S.hostId != null && cardSupports(S.hostId, r.id).length > 0 };
        }),
        stats: S.hostId != null && eff.beacons.length ? areaStats(eff, st) : null,
        count: ($('sup-count') || {}).textContent || '', hud: S.hud
      };
    },
    supports: function (hostId) { return supportsOf(hostId == null ? S.hostId : hostId); }
  };
})();

if (typeof window !== 'undefined') window.NSO_SUPPORTS_CARD = NSO_SUPPORTS_CARD;
