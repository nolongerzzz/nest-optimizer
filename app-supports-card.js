/* ===================== Supports: the card =====================
   The column's SUPPORTS drop-down (make/edit group, after Seat): one card on
   the main page that shows where a piece needs holding and builds supports
   for it. docs/SUPPORTS-CARD.md.

   FLOW. Open the card, click a piece. Its beacons - the spots that need
   holding - appear on it, grouped into regions, each region with a small
   count badge; the card says "N spots need holding in M regions".
     ALL      build every region (replacing every support on this piece)
     NONE     remove every support on this piece, and drop its edits
     a badge, or one of its beacons: that region alone is built - or, when it
              has supports, they come off. Nothing else on the piece changes.
     a built support: it is selected (the app's own highlight); REMOVE takes
              that one only. The app's own Remove works on it too.
     shift-click on the piece: a manual beacon there (side or underside, from
              the clicked face). It joins the nearest region, or starts one.
     PAINT    Hold adds beacons where the stroke goes, at the grid pitch; Skip
              takes them away, so nothing is built there.
   Every build, removal and edit is ONE Undo (a supportSwap step; its
   onUndone puts the card's own record of the piece back).

   WHAT IS REUSED, AND NOTHING HERE REPLACES
     detection   NSO_SupportAim.detectOverhangs - its beacon grid (det.beacons,
                 det.beaconRegions, nso_support_beacons.js), read as it comes.
     planning    NSO_SupportTree.planTree with opts.beacons: the detected set
                 with the edits applied, one region per call, then
                 NSO_SupportGridpack.solid. The same planner G-scope's row
                 calls. Each solid it hands back says which beacons and which
                 region it holds (regionIds), so "this region's supports" and
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
  var BEACON = { planned: 0xffffff, held: 0x22c55e, rest: 0xf59e0b, unreachable: 0xff2d2d };
  var BACKING = 0x0b0f17;
  var ANGLE_DEG = 45;            // detectOverhangs' own default
  var JOIN_PITCHES = 1.5;        // a manual beacon this close to a region joins it (the grid's own z rule)
  var PAINT_R_PITCHES = 0.5;     // the paint stroke's radius: one grid row wide
  var UP_MAX = 0.26;             // a face whose normal points up more than this (15 deg) holds nothing
  var ORDER = 30;                // over the piece and its outline
  /* The card's state when the picked piece has no beacons at all. Detection
     only asks what hangs in air; a tall, thin piece that may sway as it
     prints is a different question, not asked yet, and the words say so. */
  var NOTHING = 'Nothing hangs in air. Tall-and-thin sway isn\'t checked yet.';

  var S = {
    open: false, hostId: null, selSupport: null, paint: null, stroke: null, busy: false,
    det: null, occ: {}, eff: null, layer: null, ring: null, raf: 0, sig: '', mem: {}, msg: null
  };

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
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
    if (!S.mem[id]) S.mem[id] = { unreach: {} };
    return S.mem[id];
  }

  /*
   * The beacons the card shows and builds: the detected set, then the edits
   * in the order they were made. A manual beacon joins the region of the
   * nearest beacon within JOIN_PITCHES pitches, or starts a region of its
   * own (numbered after detection's); a Skip disc takes out every beacon
   * within its radius - detected or manual, as the list stands then.
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
      }
    });
    var by = {};
    list.forEach(function (b) { (by[b.region] = by[b.region] || []).push(b); });
    var regions = Object.keys(by).map(Number).sort(function (a, b) { return a - b; }).map(function (id) {
      var B = by[id], c = [0, 0, 0], n = [0, 0, 0];
      B.forEach(function (b) { for (var k = 0; k < 3; k++) { c[k] += pt(b)[k] / B.length; n[k] += b.normal[k]; } });
      var L = Math.hypot(n[0], n[1], n[2]) || 1;
      return { id: id, beacons: B, point: c, normal: [n[0] / L, n[1] / L, n[2] / L] };
    });
    return { beacons: list, regions: regions, pitch: pitch, error: null };
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
  function counts(eff, st) {
    var c = { held: 0, rest: 0, unreachable: 0, planned: 0 };
    eff.beacons.forEach(function (b) { c[st[b.key]]++; });
    return c;
  }
  function readoutLine(c) {
    return c.held + ' held from the plate · ' + c.rest + ' resting on the part · ' + c.unreachable + ' unreachable';
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

  function badgeTexture(text, fill) {
    var c = document.createElement('canvas');
    c.width = 96; c.height = 96;
    var g = c.getContext('2d');
    g.fillStyle = '#0b0f17'; g.beginPath(); g.arc(48, 48, 46, 0, Math.PI * 2); g.fill();
    g.fillStyle = fill; g.beginPath(); g.arc(48, 48, 39, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#0b0f17';
    g.font = 'bold ' + (text.length > 2 ? 32 : 40) + 'px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 48, 51);
    var t = new THREE.CanvasTexture(c);
    t.needsUpdate = true;
    return t;
  }

  function markSize() {
    var D = S.det, b = D ? boundsOf(D.soup) : null;
    var span = b ? Math.max(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]) : 40;
    return Math.max(0.5, Math.min(3, span * 0.025));
  }

  function draw() {
    dispose(S.layer); S.layer = null;
    if (!S.open || S.hostId == null || !state.scene) return;
    var eff = S.eff;
    if (!eff || !eff.beacons.length) return;
    var st = statesFor(eff), g = new THREE.Group();
    g.name = 'supportsCardOverlay';
    var B = eff.beacons, r = markSize() * 0.4, nn = Infinity;
    for (var i = 0; i < B.length && i < 400; i++) for (var j = i + 1; j < B.length; j++) nn = Math.min(nn, dist(pt(B[i]), pt(B[j])));
    if (isFinite(nn)) r = Math.max(0.12, Math.min(r, nn * 0.3));
    var z = new THREE.Vector3(0, 0, 1), y = new THREE.Vector3(0, 1, 0);
    B.forEach(function (b) {
      var n = b.normal, nv = upToView(n).normalize(), col = BEACON[st[b.key]];
      function put(geo, color, liftMm, order, axis, backing) {
        var m = overlay(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: color, side: THREE.DoubleSide,
          transparent: true, opacity: 0.98, depthWrite: false, depthTest: false })), order);
        m.position.copy(upToView([b.x + n[0] * liftMm, b.y + n[1] * liftMm, b.z + n[2] * liftMm]));
        m.quaternion.setFromUnitVectors(axis, nv);
        m.userData.beacon = b; m.userData.backing = !!backing; m.userData.state = st[b.key];
        g.add(m);
      }
      var kind = (b.need && b.need.kind) || 'face';
      if (kind === 'ridge' || kind === 'side') {
        put(new THREE.CylinderGeometry(r * 0.42, r * 0.42, r * 2.6, 8), BACKING, r * 1.3, ORDER, y, true);
        put(new THREE.CylinderGeometry(r * 0.26, r * 0.26, r * 2.6, 8), col, r * 1.3 + 0.01, ORDER + 1, y, false);
      } else {
        put(new THREE.CircleGeometry(r * 1.3, 20), BACKING, 0.04, ORDER, z, true);
        put(new THREE.CircleGeometry(r, 20), col, 0.06, ORDER + 1, z, false);
      }
    });
    var lift = markSize() * 2.2;
    eff.regions.forEach(function (rg) {
      var built = cardSupports(S.hostId, rg.id).length > 0;
      var anyUn = rg.beacons.some(function (b) { return st[b.key] === 'unreachable'; });
      var fill = built ? (anyUn ? '#f59e0b' : '#22c55e') : (anyUn ? '#ff6b6b' : '#ffffff');
      var sp = overlay(new THREE.Sprite(new THREE.SpriteMaterial({ map: badgeTexture(String(rg.beacons.length), fill),
        depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: false })), ORDER + 3);
      sp.scale.set(0.045, 0.045, 1);
      sp.position.copy(upToView([rg.point[0] + rg.normal[0] * lift, rg.point[1] + rg.normal[1] * lift, rg.point[2] + rg.normal[2] * lift]));
      sp.userData.region = rg.id; sp.userData.built = built; sp.userData.count = rg.beacons.length;
      g.add(sp);
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

  /* The card's state: 'idle' (no piece picked), 'error' (detection refused),
     'nothing' (the piece has no beacons: NOTHING, where the spot count sits,
     and nothing that would build is live) or 'spots'. */
  function cardState() {
    if (S.hostId == null || !placedOf(S.hostId) || !S.eff) return 'idle';
    if (S.eff.error) return 'error';
    return S.eff.beacons.length ? 'spots' : 'nothing';
  }

  function sync() {
    var head = $('sup-count'), read = $('sup-read'), card = $('supports-card');
    var hasHost = S.hostId != null && !!placedOf(S.hostId);
    var eff = S.eff, text, bad = false, cs = cardState();
    if (card) card.dataset.state = cs;
    if (S.msg) { text = S.msg.text; bad = !!S.msg.bad; }
    else if (cs === 'idle') text = 'Click a piece to see where it needs holding.';
    else if (cs === 'error') { text = eff.error; bad = true; }
    else if (cs === 'nothing') text = NOTHING;
    else text = plural(eff.beacons.length, 'spot needs', 'spots need') + ' holding in ' + plural(eff.regions.length, 'region', 'regions') + '.';
    if (head) { head.textContent = text; head.classList.toggle('is-bad', bad); }
    var r = '';
    if (hasHost && eff && eff.beacons.length && !S.busy) {
      var st = statesFor(eff), c = counts(eff, st);
      if (c.held || c.rest || c.unreachable) r = readoutLine(c);
    }
    if (read && !S.busy) read.textContent = r;
    var some = hasHost && eff && !eff.error;
    var en = function (id, on) { var e = $(id); if (e) e.disabled = !on || S.busy; };
    en('btn-sup-all', cs === 'spots');
    en('btn-sup-none', some && (supportsOf(S.hostId).length > 0 || editsOf(modelOf(S.hostId)).ops.length > 0));
    en('btn-sup-remove', S.selSupport != null && !!modelOf(S.selSupport));
    en('btn-sup-paint', some);
    var pb = $('btn-sup-paint');
    if (pb) { pb.setAttribute('aria-pressed', S.paint ? 'true' : 'false'); pb.classList.toggle('is-armed', !!S.paint); pb.textContent = S.paint ? 'Paint: on' : 'Paint'; }
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
      '|' + JSON.stringify(memOf(S.hostId).unreach).length + '|' + ((typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0);
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
    var rd = $('sup-read');
    if (rd) rd.textContent = m.name + ' - Remove takes this one only.';
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
    var unreach = JSON.parse(JSON.stringify(memOf(hostId).unreach));
    return function () {
      var mm = modelOf(hostId);
      if (mm) mm.nsoSupportEdits = { ops: ops.slice(), serial: serial };
      memOf(hostId).unreach = JSON.parse(JSON.stringify(unreach));
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
   * Build the regions `rids` (planned one at a time, in order) and put every
   * solid on the plate, taking `removeIds` off first: one undo step for the
   * lot. A plan that reaches nothing adds nothing; its spots are remembered
   * as unreachable until the region is built again or cleared.
   */
  function build(rids, removeIds, label) {
    if (S.busy) return Promise.resolve({ ok: false, reason: 'busy' });
    var host = placedOf(S.hostId), hm = modelOf(S.hostId), D = detect();
    if (!host || !D || D.error) return Promise.resolve({ ok: false, reason: D ? D.error : 'no piece' });
    var eff = S.eff = effective(), o = cardOpts(), hostId = S.hostId;
    var regs = rids.map(function (id) { return eff.regions.find(function (r) { return r.id === id; }); }).filter(Boolean);
    if (!regs.length && !removeIds.length) return Promise.resolve({ ok: false, reason: 'nothing to build' });
    S.busy = true; S.msg = null; sync();
    var rd = $('sup-read'); if (rd) rd.textContent = 'Building...';
    say('Building supports for ' + hm.name + '...');
    var results = [], chain = Promise.resolve();
    regs.forEach(function (rg) {
      chain = chain.then(function () { return planRegion(D, rg.id, rg.beacons, o).then(function (r) { results.push(r); }); });
    });
    return chain.then(function () {
      var failed = results.filter(function (r) { return !r.ok; });
      if (failed.length) {
        S.busy = false;
        S.msg = { text: 'Not built: ' + failed[0].reason, bad: true };
        say('Supports not built - nothing changed. ' + failed[0].reason, true);
        refresh();
        return { ok: false, reason: failed[0].reason };
      }
      var undo = snapshot();
      var removed = removePieces(removeIds), added = [], n = supportsOf(hostId).length;
      var mem = memOf(hostId);
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
            say('Supports not built - nothing changed (' + pl.reason + ')', true);
            afterCommit();
            return { ok: false, reason: pl.reason };
          }
          added.push(pl.id);
        }
      }
      if (added.length || removed.length) {
        pushUndo({ type: 'supportSwap', removed: removed, addedIds: added, label: label, onUndone: undo });
      }
      S.busy = false;
      afterCommit();
      var c = counts(S.eff, statesFor(S.eff));
      var line = readoutLine(c);
      say('Supports for ' + hm.name + ': ' + plural(added.length, 'support', 'supports') + ' built' +
        (removed.length ? ', ' + removed.length + ' taken off' : '') + ' - ' + line + '. One Undo puts it back.');
      return { ok: true, added: added, removed: removed.map(function (x) { return x.placed.sourceId; }), counts: c, readout: line };
    }).catch(function (err) {
      console.error('[supports card]', err);
      S.busy = false;
      S.msg = { text: 'Something went wrong - nothing was built.', bad: true };
      refresh();
      return { ok: false, reason: (err && err.message) || String(err) };
    });
  }

  /* Supports off, one undo step; `clearEdits` (NONE) drops the piece's
     edits and remembered spots too, and Undo puts those back as well. */
  function takeOff(ids, label, clearEdits, rids) {
    if (S.busy || S.hostId == null) return { ok: false, reason: S.busy ? 'busy' : 'no piece' };
    var m = modelOf(S.hostId), mem = memOf(S.hostId);
    if (!ids.length && !(clearEdits && (editsOf(m).ops.length || Object.keys(mem.unreach).length)) &&
        !(rids && rids.some(function (r) { return mem.unreach[r]; }))) return { ok: false, reason: 'nothing to take off' };
    var undo = snapshot();
    var removed = removePieces(ids);
    if (clearEdits) { m.nsoSupportEdits = { ops: [], serial: editsOf(m).serial }; mem.unreach = {}; }
    (rids || []).forEach(function (r) { delete mem.unreach[r]; });
    pushUndo({ type: 'supportSwap', removed: removed, addedIds: [], label: label, onUndone: undo });
    S.msg = null;
    afterCommit();
    say(label.replace(/^Undo: /, 'Took off ').replace(/ restored$/, '') + ' - one Undo puts ' + (removed.length === 1 ? 'it' : 'them') + ' back.');
    return { ok: true, removed: ids.slice() };
  }

  function all() {
    if (S.hostId == null) return Promise.resolve({ ok: false, reason: 'no piece' });
    var eff = S.eff = effective();
    if (eff.error || !eff.beacons.length) { refresh(); return Promise.resolve({ ok: false, reason: eff.error || 'nothing needs holding' }); }
    return build(eff.regions.map(function (r) { return r.id; }), supportsOf(S.hostId).map(function (m) { return m.id; }),
      'Undo: supports on the piece put back as they were');
  }
  function none() {
    return takeOff(supportsOf(S.hostId).map(function (m) { return m.id; }), 'Undo: every support on the piece restored', true);
  }
  function toggleRegion(rid) {
    if (S.hostId == null) return Promise.resolve({ ok: false, reason: 'no piece' });
    var have = cardSupports(S.hostId, rid).map(function (m) { return m.id; });
    if (have.length || memOf(S.hostId).unreach[rid]) {
      return Promise.resolve(takeOff(have, 'Undo: region ' + (rid + 1) + '\'s supports restored', false, [rid]));
    }
    return build([rid], [], 'Undo: region ' + (rid + 1) + '\'s supports taken off');
  }
  function removeSelected() {
    if (S.selSupport == null || !modelOf(S.selSupport)) return { ok: false, reason: 'no support selected' };
    var id = S.selSupport;
    S.selSupport = null;
    return takeOff([id], 'Undo: support restored', false);
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
  function overlayAt(ev) {
    if (!S.layer) return null;
    setPointerFromEvent(ev);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    var badges = S.layer.children.filter(function (o) { return o.isSprite; });
    var hits = state.raycaster.intersectObjects(badges, false);
    if (hits.length) return { region: hits[0].object.userData.region, badge: true };
    if (S.paint) return null;
    var dots = S.layer.children.filter(function (o) { return o.userData.beacon && !o.userData.backing; });
    hits = state.raycaster.intersectObjects(dots, false);
    if (hits.length) return { region: hits[0].object.userData.beacon.region, beacon: hits[0].object.userData.beacon.key };
    return null;
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
    say('A spot to hold added on ' + m.name + (b ? ' (region ' + (b.region + 1) + ')' : '') + ' - it is built on the next All or region click.');
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
    say(S.paint === 'skip' ? 'Skipped - ' + S.eff.beacons.length + ' spots left to hold.' : 'Painted - ' + S.eff.beacons.length + ' spots to hold.');
  }

  function setPaint(mode) {
    S.paint = mode === 'hold' || mode === 'skip' ? mode : null;
    var sel = $('sel-sup-paint');
    if (S.paint && sel) sel.value = S.paint;
    if (!S.paint) showRing(null);
    S.msg = null;
    refresh();
    if (S.paint) say('Paint ' + (S.paint === 'hold' ? 'Hold: drag on the piece to add spots to hold' : 'Skip: drag over spots to leave them unsupported') + '. Click Paint again to stop.');
  }

  /* --------------------------------------------------------- open, close */

  function tick() {
    if (!S.open) return;
    var menu = $('menu-supports');
    if (menu && !menu.open) { close(); return; }
    if (!S.busy && !S.stroke) {
      if (S.hostId != null && !placedOf(S.hostId)) { S.hostId = null; S.selSupport = null; refresh(); }
      else if (signature() !== S.sig) refresh();
    }
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
  }

  /* --------------------------------------------------------- the pointer */

  function onCanvas(ev) { return state.renderer && ev.target === state.renderer.domElement; }

  function onDown(ev) {
    if (!S.open || S.busy || ev.button !== 0 || !onCanvas(ev)) return;
    var taken = false;
    var o = S.hostId != null ? overlayAt(ev) : null;
    if (o) { toggleRegion(o.region); taken = true; }
    else {
      var h = hitAt(ev);
      if (!h) return;                               // empty space: the view still orbits
      taken = true;
      if (isSupport(h.id)) selectSupport(h.id);
      else if (h.id !== S.hostId) pick(h.id);
      else if (S.paint && S.eff && !S.eff.error) {
        var m = modelOf(S.hostId), E = editsOf(m);
        S.stroke = { undo: snapshot(), ops: E.ops.slice(), serial: E.serial, last: null, changed: false };
        if (state.controls) state.controls.enabled = false;
        strokeTo(h);
      } else if (ev.shiftKey) addBeacon(h.p, h.n);
      else if (S.selSupport != null || S.msg) { S.selSupport = null; S.msg = null; pick(S.hostId); }
    }
    if (taken) { ev.stopImmediatePropagation(); ev.preventDefault(); }
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
    on('btn-sup-all', 'click', function () { all(); });
    on('btn-sup-none', 'click', function () { none(); });
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
    all: all,
    none: none,
    toggleRegion: toggleRegion,
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
        regions: eff.regions.map(function (r) {
          return { id: r.id, count: r.beacons.length, point: r.point, normal: r.normal, built: S.hostId != null && cardSupports(S.hostId, r.id).length > 0 };
        }),
        count: ($('sup-count') || {}).textContent || '', read: ($('sup-read') || {}).textContent || ''
      };
    },
    supports: function (hostId) { return supportsOf(hostId == null ? S.hostId : hostId); }
  };
})();

if (typeof window !== 'undefined') window.NSO_SUPPORTS_CARD = NSO_SUPPORTS_CARD;
