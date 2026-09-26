/*
 * G-scope supports - overhang markers, point-click generation, and editing
 * one support at a time. The support-generation phase G-scope's selection
 * seam was left for (docs/GCODE-MICROSCOPE.md, "The selection seam").
 * ----------------------------------------------------------------------------
 *
 * READ docs/GCODE-SUPPORTS.md FIRST.
 *
 * WHAT IS REUSED, AND NOTHING HERE REPLACES
 *   detection   NSO_SupportAim.detectOverhangs, called as it is and read as it
 *               comes back. A marker is one of its `regions`, drawn where the
 *               region says it is: `point` (the aim point, on the surface) and
 *               `tris` (the flagged triangles). Nothing here re-tests an angle
 *               or casts a ray.
 *   generation  straight strut  NSO_SupportAim.plan
 *               tree            NSO_SupportTree.planTree + unionParts
 *               gecko-hand      the same, branchStyle 'gecko-hand'
 *               Each is called with the SAME soup and the SAME options the
 *               marker's detection ran with, plus `regionId` and `sideMm`, so
 *               the region a marker shows is the region the generator plans
 *               for. No geometry is built in this file.
 *   the piece   a support lands as its own plate piece through
 *               addModelFromZUpGeometry + placeModelMovable - the ordinary
 *               ingest - and one `addModels` undo step.
 *   selection   G-scope's own seam: clicking a support selects it with
 *               NSO_MICROSCOPE.selectObjects(), i.e. setSelection().
 *
 * FRAME. Detection and generation run on the piece's WORLD soup in the file's
 * Z-up millimetres - what G-scope's plate document already holds for every
 * piece (meshToWorldSoup, remapped). That is the print orientation: a piece
 * the user has tipped needs supports where it overhangs NOW, not where its
 * file did. The support comes out in the same frame, so it is placed by its
 * own bounding box with no rotation and no guess, and the placement is then
 * READ BACK off the scene and compared to the generator's output before the
 * step is kept.
 *
 * PAINT SCOPE: SUB-REGION (detection) - per docs/HANDOFF.md, "Scoping".
 *   detection   SUB-REGION, inherited from nso_support_aim.js: the piece's
 *               painted faces (nsoMaskFaceList) are passed as skipList, so a
 *               painted face never gets a marker. The list is in the piece's
 *               raw frame; it is shifted into the world frame when the piece
 *               is only translated, and refused by name when the piece is
 *               turned AND painted - a plane cannot be carried through a turn
 *               by a shift.
 *   generate    NONE - it adds a piece and edits none; the host piece is never
 *               written.
 *   remove /    WHOLE-PIECE, on the SUPPORT: a support is one piece, and it is
 *   adjust      selected, removed or replaced whole. No face-level selection
 *               is involved, so there is nothing for paint to scope.
 */
/* global THREE, state, setStatus, addModelFromZUpGeometry, placeModelMovable,
          pushUndo, meshToWorldSoup, nsoMaskCount, nsoMaskFaceList,
          renderModelList, updateOptimizeButton, updateEditSize, updateAdjustUI,
          NSO_edgeStats */
'use strict';

var NSO_GSCOPE_SUPPORT = (function () {
  var STYLES = { strut: 'Straight strut', tree: 'Tree', 'gecko-hand': 'Gecko-hand' };
  var MARK_RED = 0xff2d2d;
  var MARK_GREEN = 0x22c55e;

  var on = false;              // markers shown
  var angleDeg = 45;
  var scan = [];               // [{ host, opts, det, error }] for the current doc
  var markers = [];            // [{ host, region, ping, overlay, supported }]
  var layer = null;            // THREE.Group in G-scope's scene
  var pop = null;              // { kind: 'new'|'edit', marker?, supportId? }
  var busy = false;

  function $(id) { return document.getElementById(id); }
  function MS() { return window.NSO_MICROSCOPE; }
  function SA() { return window.NSO_SupportAim; }
  function ST() { return window.NSO_SupportTree; }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }

  function modelOf(id) {
    return (state.models || []).find(function (m) { return m && m.id === id; }) || null;
  }
  function isSupportId(id) { var m = modelOf(id); return !!(m && m.nsoSupport); }

  function plateDoc() {
    var d = MS() && MS().getDoc();
    return (d && d.kind === 'mesh' && d.source === 'plate') ? d : null;
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

  // =========================================================================
  // The options detection and generation share
  // =========================================================================

  /** The pieces that can carry supports: every plate piece that is not one. */
  function hostsOf(d) {
    return (d ? d.objects : []).filter(function (o) { return !isSupportId(o.sourceId); });
  }

  /**
   * The painted faces, in the frame detection runs in. Raw-frame planes are
   * shifted by the piece's translation; a turned piece's cannot be, and that
   * is refused rather than guessed.
   */
  function skipListFor(host) {
    var m = modelOf(host.sourceId);
    var painted = (m && typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (!painted) return { list: [] };
    var p = state.placed[host.placedIndex] || {};
    if (p.rotY || p.flipX || p.tipX || p.tipZ || p.tiltX || p.tiltZ) {
      return { list: null, reason: '"' + host.name + '" is painted and turned: its painted faces are ' +
        'recorded in the file\'s own axes and cannot be carried through a turn, so its overhangs ' +
        'are not scanned. Clear the paint, or turn it back.' };
    }
    var list = (typeof nsoMaskFaceList === 'function') ? nsoMaskFaceList(m) : [];
    if (list === null) return { list: null, reason: '"' + host.name + '" has a painted patch with no ' +
      'axis to name it by, so its overhang scan cannot leave it out' };
    if (!m.rawTris) return { list: null, reason: '"' + host.name + '" is painted but has no raw mesh' };
    var rb = boundsOf(m.rawTris), wb = host.bounds;
    var t = [wb.minX - rb.lo[0], wb.minY - rb.lo[1], wb.minZ - rb.lo[2]];
    return { list: list.map(function (e) {
      return Object.assign({}, e, { d: e.d == null ? null : e.d + t[e.axisIdx] });
    }) };
  }

  /** detectOverhangs' options for one host. The generator gets these too. */
  function optsFor(d, host) {
    var sk = skipListFor(host);
    return {
      opts: {
        skipList: sk.list,
        angleDeg: angleDeg,
        occluders: hostsOf(d).filter(function (o) { return o !== host; })
          .map(function (o) { return o.positions; })
      },
      reason: sk.reason || null
    };
  }

  // =========================================================================
  // Detection -> markers
  // =========================================================================

  function runScan() {
    scan = [];
    var d = plateDoc();
    if (!d || !SA()) return scan;
    hostsOf(d).forEach(function (host) {
      var o = optsFor(d, host);
      if (o.reason) { scan.push({ host: host, opts: o.opts, det: null, error: o.reason }); return; }
      var det = SA().detectOverhangs(host.positions, o.opts);
      scan.push({ host: host, opts: o.opts, det: det, error: det.ok ? null : det.reason });
    });
    return scan;
  }

  function supportsFor(hostSourceId, regionId) {
    return (state.models || []).filter(function (m) {
      return m && m.nsoSupport && m.nsoSupport.hostSourceId === hostSourceId &&
        (regionId == null || m.nsoSupport.regionId === regionId);
    });
  }

  /*
   * DOES IT STILL STAND THERE? A support records the host and region it was
   * built for, but that is a label, not a fact: move, turn or mirror the host
   * (or the support) and the label still matches while the support stands
   * under nothing. So a region is green only when a support labelled for it
   * ALSO touches it where the region is NOW - read off the plate document,
   * both pieces in the same world Z-up frame:
   *
   *   some support vertex lies over one of the region's own flagged
   *   triangles (its closest point on the triangle is its projection, to
   *   within LATERAL_MM), at a signed distance along the triangle's outward
   *   normal between -embedMm (into the piece: tree tips and contact
   *   interfaces sink in) and +GAP_MM (a hair of air below it; float noise).
   *
   * embedMm is the larger of 1 mm and the support's own size. The generators'
   * contacts sit at 0 (a strut's top face is the surface) or up to ~0.5 mm
   * in (a round tree tip); a region that has moved away by a mirror, turn or
   * shift is millimetres off, far outside the band.
   */
  var GAP_MM = 0.02, LATERAL_MM = 0.02;

  function closestOnTri(p, a, b, c) {
    // Ericson, Real-Time Collision Detection 5.1.5.
    function sub(u, v) { return [u[0] - v[0], u[1] - v[1], u[2] - v[2]]; }
    function dot(u, v) { return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]; }
    function at(u, s, v, t) { return [a[0] + u[0] * s + v[0] * t, a[1] + u[1] * s + v[1] * t, a[2] + u[2] * s + v[2] * t]; }
    var ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    var d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a.slice();
    var bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b.slice();
    var vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(ab, d1 / (d1 - d3), ac, 0);
    var cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c.slice();
    var vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(ab, 0, ac, d2 / (d2 - d6));
    var va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      var w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
    }
    var den = 1 / (va + vb + vc);
    return at(ab, vb * den, ac, vc * den);
  }

  /**
   * The vertices of support soup S that touch region `region` of host soup P
   * - over one of its flagged triangles, inside the band above. With `only`
   * (vertex indices), just those are tested. Returns { hit: [indices],
   * tested, nearestMm } - nearestMm the best lateral miss, for the reason.
   */
  function contactsOn(S, P, region, sideMm, only) {
    var embed = Math.max(1, +sideMm || 0);
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    var tris = region.tris.map(function (t) {
      var o = t * 9, a = [P[o], P[o + 1], P[o + 2]], b = [P[o + 3], P[o + 4], P[o + 5]], c = [P[o + 6], P[o + 7], P[o + 8]];
      for (var k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], a[k], b[k], c[k]); hi[k] = Math.max(hi[k], a[k], b[k], c[k]);
      }
      var u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      var n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
      var L = Math.hypot(n[0], n[1], n[2]) || 1;
      return { a: a, b: b, c: c, n: [n[0] / L, n[1] / L, n[2] / L] };
    });
    var pad = embed + GAP_MM + LATERAL_MM, hit = [], nearest = Infinity;
    var n = only ? only.length : S.length / 3;
    for (var q = 0; q < n; q++) {
      var vi = only ? only[q] : q, i = vi * 3;
      if (!(i + 2 < S.length)) continue;
      var x = S[i], y = S[i + 1], z = S[i + 2];
      if (x < lo[0] - pad || x > hi[0] + pad || y < lo[1] - pad || y > hi[1] + pad ||
          z < lo[2] - pad || z > hi[2] + pad) continue;
      for (var j = 0; j < tris.length; j++) {
        var T = tris[j];
        var sd = (x - T.a[0]) * T.n[0] + (y - T.a[1]) * T.n[1] + (z - T.a[2]) * T.n[2];
        if (sd > GAP_MM || sd < -embed) continue;
        var pr = [x - T.n[0] * sd, y - T.n[1] * sd, z - T.n[2] * sd];
        var cl = closestOnTri(pr, T.a, T.b, T.c);
        var lat = Math.hypot(cl[0] - pr[0], cl[1] - pr[1], cl[2] - pr[2]);
        if (lat <= LATERAL_MM) { hit.push(vi); break; }
        nearest = Math.min(nearest, lat);
      }
    }
    return { hit: hit, tested: n, nearestMm: nearest };
  }

  /**
   * Whether support piece `sup` (a plate-document object) still stands under
   * `region` of `host` where the region is now: EVERY vertex that touched the
   * region when the support was placed (meta.contacts, recorded by
   * placeSupport) must touch it still. Testing only those - the support's own
   * contacts - keeps a trunk that a moved host happens to pass through from
   * counting as support; requiring all of them keeps a support slid half off
   * its overhang from counting as standing.
   */
  function touches(sup, host, region, meta) {
    var c = meta && meta.contacts;
    if (!c || !c.length) return { ok: false, reason: 'no contacts were recorded when it was placed' };
    var r = contactsOn(sup.positions, host.positions, region, meta.sideMm, c);
    return { ok: r.hit.length === c.length, touching: r.hit.length, contacts: c.length };
  }

  /**
   * The supports that are labelled for this region AND still touch it now.
   * `labelled` is what the label alone says; `standing` what the geometry
   * says; a label whose support no longer touches is `stale`.
   */
  function standingFor(d, host, region) {
    var labelled = supportsFor(host.sourceId, region.id);
    var standing = [], stale = [];
    labelled.forEach(function (m) {
      var o = d && d.objects.find(function (x) { return x.sourceId === m.id; });
      var t = o ? touches(o, host, region, m.nsoSupport) : { ok: false, reason: 'not on the plate' };
      (t.ok ? standing : stale).push({ id: m.id, name: m.name, touch: t });
    });
    return { labelled: labelled.length, standing: standing, stale: stale };
  }

  function clearLayer() {
    if (!layer) return;
    for (var i = layer.children.length - 1; i >= 0; i--) {
      var c = layer.children[i];
      layer.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
  }

  function ensureLayer() {
    var v = MS() && MS().getView();
    if (!v) return null;
    if (!layer) {
      layer = new THREE.Group();
      layer.name = 'gscopeSupportMarkers';
      layer.renderOrder = 10;
    }
    if (layer.parent !== v.scene) v.scene.add(layer);
    return layer;
  }

  /**
   * One marker per region: the region's own flagged triangles, lifted a hair
   * off the surface and tinted, and a ping - a sphere at the region's aim
   * point with a ring round it in the plane of the face. Red where no support
   * stands for it yet, green where one does.
   */
  function drawMarkers() {
    markers = [];
    if (!layer) ensureLayer();
    if (!layer) return;
    clearLayer();
    layer.visible = on;
    var d = plateDoc();
    if (!on || !d) { syncPanel(); return; }
    var span = 0;
    d.objects.forEach(function (o) {
      span = Math.max(span, o.bounds.maxX - o.bounds.minX, o.bounds.maxY - o.bounds.minY, o.bounds.maxZ - o.bounds.minZ);
    });
    var pingR = Math.max(0.5, Math.min(3, span * 0.025));

    scan.forEach(function (s) {
      if (!s.det || !s.det.ok) return;
      s.det.regions.forEach(function (r) {
        var st = standingFor(d, s.host, r);
        var supported = st.standing.length > 0;
        var col = supported ? MARK_GREEN : MARK_RED;
        var P = s.host.positions, lift = 0.02;
        var pos = new Float32Array(r.tris.length * 9);
        r.tris.forEach(function (t, i) {
          for (var v = 0; v < 3; v++) {
            var o = t * 9 + v * 3;
            var q = MS().toView(P[o] + r.normal[0] * lift, P[o + 1] + r.normal[1] * lift, P[o + 2] + r.normal[2] * lift);
            pos[i * 9 + v * 3] = q.x; pos[i * 9 + v * 3 + 1] = q.y; pos[i * 9 + v * 3 + 2] = q.z;
          }
        });
        var og = new THREE.BufferGeometry();
        og.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        var overlay = new THREE.Mesh(og, new THREE.MeshBasicMaterial({
          color: col, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
          depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        }));
        var at = MS().toView(r.point[0], r.point[1], r.point[2]);
        var ping = new THREE.Mesh(new THREE.SphereGeometry(pingR, 20, 14),
          new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.95 }));
        ping.position.copy(at);
        ping.renderOrder = 12;
        var ring = new THREE.Mesh(new THREE.RingGeometry(pingR * 1.6, pingR * 2.1, 32),
          new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, depthTest: false,
            transparent: true, opacity: 0.8 }));
        ring.position.copy(at);
        // The ring lies in the face: its own +Z turned onto the region normal.
        var nView = MS().toView(r.normal[0], r.normal[1], r.normal[2]);
        var n0 = MS().toView(0, 0, 0);
        ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1),
          nView.sub(n0).normalize());
        ring.renderOrder = 11;
        var mk = { host: s.host, region: r, ping: ping, ring: ring, overlay: overlay, supported: supported,
          stale: st.stale.map(function (x) { return x.name; }) };
        ping.userData.marker = mk; overlay.userData.marker = mk; ring.userData.marker = mk;
        layer.add(overlay); layer.add(ring); layer.add(ping);
        markers.push(mk);
      });
    });
    syncPanel();
  }

  /** Re-scan and redraw, e.g. after the plate changed under G-scope. */
  function refresh() {
    if (!plateDoc()) { scan = []; markers = []; clearLayer(); syncPanel(); return; }
    if (on) runScan();
    drawMarkers();
  }

  function setOn(v) {
    on = !!v;
    if (on && !plateDoc() && MS()) MS().openPlate();
    refresh();
    var b = $('ms-btn-overhangs');
    if (b) b.classList.toggle('active', on);
  }

  // =========================================================================
  // Generation - the three proven generators, behind one call
  // =========================================================================

  /**
   * The generator's own call for one marker. Returns a Promise of
   * { ok, soup, plan, reason }. The soup is exactly what the generator (and,
   * for a tree, unionParts) handed back - nothing is done to it here.
   */
  function planFor(host, regionId, style, sideMm, baseOpts) {
    var o = Object.assign({}, baseOpts, { regionId: regionId });
    if (sideMm != null) o.sideMm = +sideMm;
    if (style === 'strut') {
      var p = SA().plan(host.positions, o);
      return Promise.resolve(p.ok ? { ok: true, soup: p.soup, plan: p, reason: p.reason }
                                  : { ok: false, plan: p, reason: p.reason });
    }
    if (style !== 'tree' && style !== 'gecko-hand') {
      return Promise.resolve({ ok: false, reason: 'unknown support style ' + JSON.stringify(style) });
    }
    if (!ST()) return Promise.resolve({ ok: false, reason: 'nso_support_tree.js is not loaded' });
    o.branchStyle = style === 'gecko-hand' ? 'gecko-hand' : 'square';
    var t = ST().planTree(host.positions, o);
    if (!t.ok) return Promise.resolve({ ok: false, plan: t, reason: t.reason });
    return ST().unionParts(t.parts).then(function (u) {
      return u.ok ? { ok: true, soup: u.soup, plan: t, union: u, reason: t.reason }
                  : { ok: false, plan: t, union: u, reason: u.reason };
    });
  }

  /** The world soup a placed mesh really shows, in Z-up millimetres. */
  function worldZUp(mesh) {
    var s = meshToWorldSoup(mesh), out = new Float32Array(s.length);
    for (var i = 0; i < s.length; i += 3) { out[i] = s[i]; out[i + 1] = -s[i + 2]; out[i + 2] = s[i + 1]; }
    return out;
  }

  /**
   * Put a generated soup on the plate exactly where it was generated. Returns
   * { ok, id, entry, maxErrMm } or a refusal. Not an undo step by itself:
   * the caller pushes the one step the user sees.
   */
  function placeSupport(soup, meta, host, detOpts) {
    var hostPlaced = state.placed[host.placedIndex];
    if (!hostPlaced) return { ok: false, reason: 'the piece is no longer on the plate' };
    var b = boundsOf(soup);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(soup), 3));
    var name = host.name + ' - support ' + (supportsFor(host.sourceId).length + 1) +
      ' (' + STYLES[meta.style] + ')';
    var id = addModelFromZUpGeometry(name, geo, { keepSelection: true, silent: true });
    if (!id) return { ok: false, reason: 'the support could not be added' };
    var m = modelOf(id);
    m.nsoSupport = meta;
    // x / z from the soup's own box (view z is -y); y so its bottom sits
    // where the generator put it, and the export's liftY carries the same
    // offset from the host's bottom that the scene shows.
    var entry = placeModelMovable(m, (b.lo[0] + b.hi[0]) / 2, -(b.lo[1] + b.hi[1]) / 2);
    entry.mesh.position.y = (b.lo[2] + b.hi[2]) / 2;
    entry.liftY = (hostPlaced.liftY || 0) + (b.lo[2] - host.bounds.minZ);
    entry.mesh.updateMatrixWorld(true);

    // Read it back off the scene: the support must stand exactly where the
    // generator built it. Same triangle order, so compared value for value.
    var back = worldZUp(entry.mesh), err = 0;
    if (back.length !== soup.length) err = Infinity;
    else for (var i = 0; i < soup.length; i++) err = Math.max(err, Math.abs(back[i] - soup[i]));
    if (!(err <= 1e-3)) {
      removePieces([id]);
      return { ok: false, reason: 'the placed support did not land where it was generated (' +
        err.toExponential(2) + ' mm off) - nothing was added' };
    }
    // What it touches, now, on the region it was made for: the contacts
    // standingFor() holds it to from here on (see touches()).
    var reg = regionOf(host, meta, detOpts);
    meta.contacts = reg ? contactsOn(soup, host.positions, reg, meta.sideMm).hit : [];
    return { ok: true, id: id, entry: entry, maxErrMm: err, name: name, contacts: meta.contacts.length };
  }

  /** The host's region a support is labelled for: detection run again on
      the host as it is, with the SAME options generation used (taken before
      any old support came off the plate - read afterwards, the plate
      document still holds the removed piece and would count it as an
      occluder). */
  function regionOf(host, meta, detOpts) {
    var det = (detOpts && SA()) ? SA().detectOverhangs(host.positions, detOpts) : null;
    return det && det.ok ? det.regions.find(function (r) { return r.id === meta.regionId; }) || null : null;
  }

  /** Take pieces off the plate and out of the model list. No undo step. */
  function removePieces(ids) {
    var drop = new Set(ids);
    var removed = [];
    state.placed.forEach(function (p, i) {
      if (p && drop.has(p.sourceId)) removed.push({ placed: p, placedIndex: i });
    });
    removed.forEach(function (r) {
      var m = modelOf(r.placed.sourceId);
      r.model = m;
      r.modelIndex = state.models.indexOf(m);
    });
    state.placed = state.placed.filter(function (p) { return !(p && drop.has(p.sourceId)); });
    state.models = state.models.filter(function (m) { return !drop.has(m.id); });
    removed.forEach(function (r) { if (r.placed.mesh && r.placed.mesh.parent) r.placed.mesh.parent.remove(r.placed.mesh); });
    state.placed.forEach(function (p, i) { if (p.mesh) p.mesh.userData.placedIndex = i; });
    state.selectedIndex = -1;
    if (typeof renderModelList === 'function') renderModelList();
    if (typeof updateOptimizeButton === 'function') updateOptimizeButton();
    if (typeof updateEditSize === 'function') updateEditSize();
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    return removed;
  }

  /**
   * Read the plate again after a support was added, changed or removed, and
   * leave the camera where the user had it: they were looking under a piece
   * on purpose, and a re-read that snaps back to the overview throws that away.
   */
  function reread() {
    var v = MS().getView();
    var pos = v ? v.camera.position.clone() : null, tgt = v ? v.controls.target.clone() : null;
    MS().openPlate();
    if (v && pos) { v.camera.position.copy(pos); v.controls.target.copy(tgt); v.controls.update(); }
  }

  function hostBySourceId(d, sid) {
    return d ? d.objects.find(function (o) { return o.sourceId === sid; }) || null : null;
  }

  /**
   * Generate a support for one marker: host piece, region id, style, size.
   * The whole click path runs through here, and so does the drive check.
   */
  function generateAt(hostName, regionId, style, sideMm) {
    if (busy) return Promise.resolve({ ok: false, reason: 'busy' });
    var d = plateDoc();
    if (!d) return Promise.resolve({ ok: false, reason: 'G-scope is not on the plate' });
    var host = d.objects.find(function (o) { return o.name === hostName; });
    if (!host || isSupportId(host.sourceId)) return Promise.resolve({ ok: false, reason: 'no such piece: ' + hostName });
    var o = optsFor(d, host);
    if (o.reason) { say('Support refused - ' + o.reason, true); return Promise.resolve({ ok: false, reason: o.reason }); }
    busy = true;
    say('Generating a ' + STYLES[style] + ' support...');
    return planFor(host, regionId, style, sideMm, o.opts).then(function (g) {
      if (!g.ok) { say('Support refused - nothing added: ' + g.reason, true); return g; }
      var meta = { hostSourceId: host.sourceId, hostName: host.name, regionId: regionId, style: style,
        sideMm: g.plan.sideMm || (g.plan.aim && g.plan.aim.sideMm) || +sideMm, angleDeg: angleDeg,
        point: g.plan.region ? g.plan.region.point.slice() : null };
      var pl = placeSupport(g.soup, meta, host, o.opts);
      if (!pl.ok) { say('Support refused - ' + pl.reason, true); return pl; }
      if (typeof pushUndo === 'function') {
        pushUndo({ type: 'addModels', ids: [pl.id], editId: state.editId, cutT: state.cutT });
      }
      say('Support added - ' + pl.name + ', ' + (g.soup.length / 9) + ' triangles; ' + g.reason);
      reread();                          // the support is now a piece
      return { ok: true, id: pl.id, soup: g.soup, plan: g.plan, maxErrMm: pl.maxErrMm, name: pl.name };
    }).catch(function (err) {
      console.error('[g-scope support]', err);
      say('Support failed - nothing added (' + ((err && err.message) || err) + ')', true);
      return { ok: false, reason: (err && err.message) || String(err) };
    }).then(function (r) { busy = false; return r; });
  }

  /** One support off the plate, one undo step. */
  function removeSupport(id) {
    var m = modelOf(id);
    if (!m || !m.nsoSupport) return { ok: false, reason: 'that piece is not a G-scope support' };
    var removed = removePieces([id]);
    if (typeof pushUndo === 'function') {
      pushUndo({ type: 'supportSwap', removed: removed, addedIds: [], label: 'Undo: support restored' });
    }
    say('Removed ' + m.name + ' - Undo puts it back');
    closePop();
    if (plateDoc()) reread();
    return { ok: true, removed: id };
  }

  /** Regenerate one support with a new style / size, replacing it: one step. */
  function adjustSupport(id, style, sideMm) {
    var m = modelOf(id);
    if (!m || !m.nsoSupport) return Promise.resolve({ ok: false, reason: 'that piece is not a G-scope support' });
    var d = plateDoc();
    var host = hostBySourceId(d, m.nsoSupport.hostSourceId);
    if (!host) return Promise.resolve({ ok: false, reason: 'the piece this support holds up is gone' });
    var o = optsFor(d, host);
    if (o.reason) return Promise.resolve({ ok: false, reason: o.reason });
    if (busy) return Promise.resolve({ ok: false, reason: 'busy' });
    busy = true;
    var regionId = m.nsoSupport.regionId;
    return planFor(host, regionId, style, sideMm, o.opts).then(function (g) {
      if (!g.ok) { say('Support change refused - unchanged: ' + g.reason, true); return g; }
      var removed = removePieces([id]);
      var meta = Object.assign({}, m.nsoSupport, { style: style,
        sideMm: g.plan.sideMm || (g.plan.aim && g.plan.aim.sideMm) || +sideMm });
      var pl = placeSupport(g.soup, meta, host, o.opts);
      if (!pl.ok) {
        // Put the old one back exactly as it was; no step was recorded.
        removed.forEach(function (r) {
          state.models.splice(Math.min(r.modelIndex, state.models.length), 0, r.model);
          state.placed.splice(Math.min(r.placedIndex, state.placed.length), 0, r.placed);
          if (r.placed.mesh && state.modelGroup) state.modelGroup.add(r.placed.mesh);
        });
        say('Support change refused - unchanged: ' + pl.reason, true);
        return pl;
      }
      if (typeof pushUndo === 'function') {
        pushUndo({ type: 'supportSwap', removed: removed, addedIds: [pl.id], label: 'Undo: support change reverted' });
      }
      say('Support changed - ' + pl.name + ', ' + (g.soup.length / 9) + ' triangles');
      closePop();
      reread();
      return { ok: true, id: pl.id, replaced: id, soup: g.soup, plan: g.plan };
    }).catch(function (err) {
      console.error('[g-scope support]', err);
      return { ok: false, reason: (err && err.message) || String(err) };
    }).then(function (r) { busy = false; return r; });
  }

  // =========================================================================
  // Clicks: a marker opens "generate", a support opens "edit"
  // =========================================================================

  function clickHook(nx, ny, e) {
    var d = plateDoc(), v = MS().getView();
    if (!d || !v) return false;
    var rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx, ny), v.camera);
    // Pings sit on top of everything (depthTest off), so a ping under the
    // cursor wins even when the piece is in front of it.
    if (on && markers.length) {
      var pings = rc.intersectObjects(markers.map(function (m) { return m.ping; }), false);
      if (!pings.length) pings = rc.intersectObjects(markers.map(function (m) { return m.overlay; }), false);
      if (pings.length) { openPopNew(pings[0].object.userData.marker, e); return true; }
    }
    var sup = Object.keys(v.overviewMeshes).map(function (k) { return v.overviewMeshes[k]; })
      .filter(function (m) { return m.visible && m.userData.object && isSupportId(m.userData.object.sourceId); });
    if (!sup.length) return false;
    var all = rc.intersectObjects(Object.keys(v.overviewMeshes).map(function (k) { return v.overviewMeshes[k]; })
      .filter(function (m) { return m.visible; }), false);
    if (!all.length) return false;
    var hit = all[0].object.userData.object;
    if (!hit || !isSupportId(hit.sourceId)) return false;
    selectSupport(hit.sourceId, e);
    return true;
  }

  function selectSupport(id, e) {
    var d = plateDoc();
    var o = d && d.objects.find(function (x) { return x.sourceId === id; });
    if (!o) return false;
    MS().selectObjects([o.name], 'support');
    openPopEdit(id, e);
    return true;
  }

  function placePop(e) {
    var el = $('ms-support-pop'), host = $('ms-viewport');
    if (!el || !host) return;
    el.hidden = false;
    var r = host.getBoundingClientRect();
    var x = e ? e.clientX - r.left + 14 : 80, y = e ? e.clientY - r.top + 14 : 80;
    x = Math.max(8, Math.min(r.width - el.offsetWidth - 90, x));
    y = Math.max(8, Math.min(r.height - el.offsetHeight - 8, y));
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }

  function openPopNew(mk, e) {
    pop = { kind: 'new', marker: mk };
    var r = mk.region;
    var tilt = Math.acos(Math.min(1, Math.max(-1, -r.normal[2]))) * 180 / Math.PI;
    $('ms-sp-title').textContent = 'Overhang ' + (r.id + 1) + ' on ' + mk.host.name;
    $('ms-sp-sub').textContent = r.areaMm2.toFixed(1) + ' mm², ' + tilt.toFixed(0) +
      '° off flat, ' + r.dropMm.toFixed(1) + ' mm above the plate' +
      (mk.supported ? ' - already has a support' :
        mk.stale && mk.stale.length ? ' - ' + mk.stale.join(', ') + ' was made for it but no longer ' +
          'touches it (a piece was moved, turned or mirrored)' : '');
    $('ms-sp-read').textContent = '';
    showButtons('new');
    placePop(e);
  }

  function openPopEdit(id, e) {
    var m = modelOf(id);
    pop = { kind: 'edit', supportId: id };
    $('ms-sp-title').textContent = m.name;
    $('ms-sp-sub').textContent = 'Holds up overhang ' + (m.nsoSupport.regionId + 1) + ' on ' +
      m.nsoSupport.hostName + '. Change it, or remove it - one Undo either way.';
    $('ms-sp-style').value = m.nsoSupport.style;
    $('ms-sp-size').value = String(+m.nsoSupport.sideMm.toFixed(2));
    $('ms-sp-read').textContent = '';
    showButtons('edit');
    placePop(e);
  }

  function showButtons(kind) {
    [['ms-sp-generate', kind === 'new'], ['ms-sp-apply', kind === 'edit'], ['ms-sp-remove', kind === 'edit']]
      .forEach(function (b) { var el = $(b[0]); if (el) el.style.display = b[1] ? '' : 'none'; });
  }

  function closePop() {
    pop = null;
    var el = $('ms-support-pop');
    if (el) el.hidden = true;
  }

  function popGenerate() {
    if (!pop || pop.kind !== 'new') return null;
    var mk = pop.marker;
    $('ms-sp-read').textContent = 'Generating...';
    return generateAt(mk.host.name, mk.region.id, $('ms-sp-style').value, parseFloat($('ms-sp-size').value))
      .then(function (r) {
        if (r.ok) closePop(); else if ($('ms-sp-read')) $('ms-sp-read').textContent = 'Refused: ' + r.reason;
        return r;
      });
  }

  function popApply() {
    if (!pop || pop.kind !== 'edit') return null;
    $('ms-sp-read').textContent = 'Regenerating...';
    return adjustSupport(pop.supportId, $('ms-sp-style').value, parseFloat($('ms-sp-size').value))
      .then(function (r) { if (!r.ok && $('ms-sp-read')) $('ms-sp-read').textContent = 'Refused: ' + r.reason; return r; });
  }

  // =========================================================================
  // Panel
  // =========================================================================

  function syncPanel() {
    var row = $('ms-support-row');
    var d = MS() && MS().getDoc();
    if (row) row.style.display = d && d.kind === 'mesh' ? 'block' : 'none';
    var read = $('ms-support-read');
    if (!read) return;
    if (!plateDoc()) { read.textContent = 'Supports are placed on plate pieces: Read the plate first.'; return; }
    if (!on) { read.textContent = 'Show overhangs to see where the pieces need support.'; return; }
    var errs = scan.filter(function (s) { return s.error; });
    var red = markers.filter(function (m) { return !m.supported; }).length;
    var nSup = (state.models || []).filter(function (m) { return m && m.nsoSupport; }).length;
    var stale = [];
    markers.forEach(function (m) { if (!m.supported) (m.stale || []).forEach(function (n) { stale.push(n); }); });
    read.textContent = markers.length + ' overhang(s) found at ' + angleDeg + '° - ' + red +
      ' unsupported (red), ' + (markers.length - red) + ' supported (green); ' + nSup +
      ' support piece(s). Click a marker to generate there; click a support to change or remove it.' +
      (stale.length ? ' No longer touching the overhang it was made for (red): ' + stale.join(', ') + '.' : '') +
      (errs.length ? ' ' + errs.map(function (s) { return s.error; }).join(' ') : '');
  }

  function bind(id, ev, fn) {
    var el = $(id);
    if (el && el.dataset.wired !== '1') { el.dataset.wired = '1'; el.addEventListener(ev, fn); }
  }

  function mount() {
    if (!MS()) return;
    MS().addClickHook(clickHook);
    MS().onDocument(function () { closePop(); ensureLayer(); refresh(); });
    bind('ms-btn-overhangs', 'click', function () { setOn(!on); });
    bind('ms-overhang-angle', 'change', function () {
      var a = parseFloat($('ms-overhang-angle').value);
      if (a > 0 && a < 90) { angleDeg = a; refresh(); } else $('ms-overhang-angle').value = String(angleDeg);
    });
    bind('ms-sp-generate', 'click', popGenerate);
    bind('ms-sp-apply', 'click', popApply);
    bind('ms-sp-remove', 'click', function () { if (pop && pop.kind === 'edit') removeSupport(pop.supportId); });
    bind('ms-sp-cancel', 'click', closePop);
    syncPanel();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }

  return {
    STYLES: Object.assign({}, STYLES),
    setOn: setOn,
    isOn: function () { return on; },
    setAngle: function (a) { angleDeg = +a; refresh(); },
    refresh: refresh,
    scan: function () { return scan; },
    markers: function () { return markers; },
    optsFor: function (hostName) {
      var d = plateDoc(), h = d && d.objects.find(function (o) { return o.name === hostName; });
      return h ? optsFor(d, h) : null;
    },
    planFor: function (hostName, regionId, style, sideMm) {
      var d = plateDoc(), h = d && d.objects.find(function (o) { return o.name === hostName; });
      if (!h) return Promise.resolve({ ok: false, reason: 'no such piece' });
      return planFor(h, regionId, style, sideMm, optsFor(d, h).opts);
    },
    generateAt: generateAt,
    removeSupport: removeSupport,
    adjustSupport: adjustSupport,
    selectSupport: selectSupport,
    standing: function (hostName, regionId) {
      var d = plateDoc(), s = scan.find(function (x) { return x.host.name === hostName; });
      var r = s && s.det && s.det.ok && s.det.regions.find(function (x) { return x.id === regionId; });
      return r ? standingFor(d, s.host, r) : null;
    },
    supports: function () { return (state.models || []).filter(function (m) { return m && m.nsoSupport; }); },
    popGenerate: popGenerate,
    popApply: popApply,
    closePop: closePop
  };
})();

if (typeof window !== 'undefined') window.NSO_GSCOPE_SUPPORT = NSO_GSCOPE_SUPPORT;
