/*
 * G-scope Lift - take any detail off a flat face, and leave the face flat.
 * The app side of nso_lift.js. READ docs/LIFT.md FIRST.
 * ----------------------------------------------------------------------------
 *
 * One mode, one slider, in G-scope's sidebar ("Features - lift off a flat
 * face"), on the plate:
 *
 *   1. Pick base face, then click the flat face the details stand on. Its
 *      plane is fitted to the coplanar patch round the click
 *      (NSO_Lift.analyse). A curved face, or one not flat within the stated
 *      tolerance, is refused in plain words and nothing changes.
 *   2. What stands proud of it is drawn over the piece, coloured by height
 *      (blue low, red high); the base itself is tinted green. "How far out
 *      counts" decides what is offered: an island standing out MORE than it.
 *      What is lower is drawn grey; what runs over the face's edge is part of
 *      the body, not drawn, and counted by name in the read-out.
 *   3. Click an island to choose it (magenta); Shift-click adds or removes.
 *      A click anywhere else on a piece picks that face as the base instead.
 *   4. Lift. The piece keeps its place and id and becomes the leftover plate:
 *      every triangle it had, bit for bit, minus the lifted islands, plus a
 *      flat cap where each stood. Each island becomes its own closed piece
 *      with a flat back, placed on free plate nearest the piece it came off
 *      (nsoFreeSpot, app-core.js - Picture's placement, now shared). One
 *      Undo ('featureSwap', the step Detach takes) puts everything back.
 *
 * FRAME. Picking is done in G-scope's view of the plate (world, Z-up mm);
 * the geometry runs on the piece's RAW soup (m.rawTris), which is what the
 * piece is and what replaces it. The two are the same triangles in the same
 * order (meshToWorldSoup walks the display geometry built from rawTris), and
 * the clicked triangle is checked to be the same shape in both before
 * anything is read off it. So the plate keeps its pose, and every triangle
 * not lifted stays exactly the number it was. A lifted piece is a new piece
 * in that raw frame: a base whose normal is the raw +Z (a plate lying as it
 * was made) puts its flat back on the bed.
 *
 * WHAT IS REUSED
 *   geometry    NSO_Lift.analyse / offered / lift (nso_lift.js), whose caps
 *               are rawFlatCapLoops (app-cut.js)
 *   the swap    NSO_sculptCommitRaw (app-sculpt.js) + the 'featureSwap' undo
 *               step app-detach.js folds it into
 *   new pieces  addModel + placeModelMovable, as Detach adds its flange
 *   placement   nsoFreeSpot (app-core.js)
 *   the view    G-scope's click hook, onDocument, toView, openPlate
 *
 * PAINT SCOPE: WHOLE-PIECE, per the scoping rule in docs/HANDOFF.md. Lift
 * replaces the piece's soup: the lifted islands' faces leave it and a cap is
 * added on the base face, so a painted face could lose its triangles or gain
 * new ones. nsoMaskCount(m) > 0 stands it down and names the count.
 *
 * NON-SOLID SCOPE: the leftover plate is gated on staying closed only when
 * the source was closed (nso_lift.js); every lifted piece must be closed.
 * nsoNonSolid(m) is not read - nothing here closes, peels or drops boundary
 * the piece arrived with.
 */
/* global THREE, state, setStatus, addModel, placeModelMovable, pushUndo, applyPlacedXZ,
          nsoFreeSpot, nsoMaskCount, NSO_sculptCommitRaw, rawResultToDisplayGeometry,
          computeCenterOffsetFromRaw, rawFlatCapLoops, renderModelList, updateOptimizeButton,
          updateEditSize, updateAdjustUI */
'use strict';

var NSO_GSCOPE_LIFT = (function () {
  var BASE_TINT = 0x22c55e, CHOSEN = 0xff2bd6, LOW = 0x6b7280;

  var on = false;
  var minH = null;            // the slider, mm
  var host = null;            // { name, sourceId } of the piece the base is on
  var A = null;               // NSO_Lift.analyse on that piece's rawTris
  var analysedRaw = null;     // the rawTris A was taken on
  var chosen = new Set();     // island ids
  var layer = null;
  var lastLift = null;        // { modelId, raw, seed } - for the Undo redraw
  var busy = false;

  function $(id) { return document.getElementById(id); }
  function MS() { return window.NSO_MICROSCOPE; }
  function LF() { return window.NSO_Lift; }
  function modelOf(id) { return (state.models || []).find(function (m) { return m && m.id === id; }) || null; }
  function plateDoc() {
    var d = MS() && MS().getDoc();
    return (d && d.kind === 'mesh' && d.source === 'plate') ? d : null;
  }
  function f2(x) { return (+x).toFixed(2); }

  /** The status line: G-scope's own read-out, and the app's line. */
  function say(msg, bad) {
    var r = $('ms-lift-read');
    if (r) { r.textContent = msg; r.classList.toggle('ms-bad', !!bad); }
    if (typeof setStatus === 'function') setStatus(msg, !!bad);
  }

  function defaultMin() { return LF() ? LF().defaultMinHeight() : 0.42; }

  // =========================================================================
  // The base
  // =========================================================================

  function hostObject(d) {
    return (d && host) ? d.objects.find(function (o) { return o.sourceId === host.sourceId; }) || null : null;
  }

  function edgeLens(p, o) {
    var a = [p[o], p[o + 1], p[o + 2]], b = [p[o + 3], p[o + 4], p[o + 5]], c = [p[o + 6], p[o + 7], p[o + 8]];
    function L(u, v) { return Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]); }
    return [L(a, b), L(b, c), L(c, a)];
  }

  /**
   * Pick the face under triangle `tri` of G-scope object `o` as the base.
   * Refusals leave everything as it was. The click path and the drive check
   * both come through here.
   */
  function pickBase(o, tri) {
    if (!LF()) return fail('Lift needs nso_lift.js');
    if (!plateDoc()) {
      return fail('Lift works on pieces on the plate - send this to the plate (Export to plate), then open ' +
        'the plate here with G-scope\'s rail button. Nothing changed.');
    }
    var m = o && modelOf(o.sourceId);
    if (!m) return fail('Lift: that is not a piece on the plate - nothing changed');
    if (!(m.rawTris && m.rawAxis === 'zup')) {
      return fail('Lift needs a raw piece - "' + m.name + '" has no untransformed soup. Nothing changed.');
    }
    var nt = m.rawTris.length / 9;
    if (o.positions.length / 9 !== nt || !(tri >= 0 && tri < nt)) {
      return fail('Lift: "' + m.name + '" on the plate does not match its own mesh (' + o.positions.length / 9 +
        ' against ' + nt + ' triangles) - nothing changed');
    }
    var a = edgeLens(o.positions, tri * 9), b = edgeLens(m.rawTris, tri * 9);
    for (var k = 0; k < 3; k++) {
      if (Math.abs(a[k] - b[k]) > 1e-3 * Math.max(1, b[k])) {
        return fail('Lift: the clicked triangle of "' + m.name + '" is not the same shape in its mesh - the piece ' +
          'is scaled on the plate. Nothing changed.');
      }
    }
    var t0 = Date.now();
    var r = LF().analyse(m.rawTris, tri);
    if (!r.ok) return fail((/^Lift/.test(r.reason) ? '' : 'Lift: ') + r.reason + (/[.]$/.test(r.reason) ? '' : '.') + ' Nothing changed.', r);
    host = { name: o.name, sourceId: o.sourceId };
    A = r;
    analysedRaw = m.rawTris;
    chosen = new Set();
    syncSlider();
    draw();
    var msg = readout();
    say(msg);
    return { ok: true, analysis: A, ms: Date.now() - t0, reason: msg };
  }

  function fail(reason, r) {
    say(reason, true);
    return { ok: false, reason: reason, refused: r && r.refused };
  }

  /** The slider runs from 0 to the tallest island, rounded up. */
  function syncSlider() {
    var s = $('ms-lift-height'), rd = $('ms-lift-height-read');
    if (minH == null) minH = defaultMin();
    if (s) {
      var top = 0;
      if (A) A.islands.forEach(function (I) { if (I.status === 'ok' && I.heightMm > top) top = I.heightMm; });
      var max = Math.max(1, Math.ceil(Math.max(top, minH) * 100 + 1) / 100);
      s.max = String(max);
      s.value = String(minH);
    }
    if (rd) rd.textContent = f2(minH) + ' mm';
  }

  function setMinHeight(h) {
    var v = +h;
    if (!(v >= 0) || !isFinite(v)) return minH;
    minH = v;
    // A choice the slider no longer offers is dropped.
    if (A) {
      var off = new Set(LF().offered(A, minH));
      chosen.forEach(function (id) { if (!off.has(id)) chosen.delete(id); });
    }
    syncSlider();
    draw();
    if (A) say(readout());
    return minH;
  }

  function readout() {
    if (!A) return on ? 'Click the flat face the details stand on.' : 'Pick base face, then click the flat face the details stand on.';
    var ok = A.islands.filter(function (I) { return I.status === 'ok'; });
    var off = LF().offered(A, minH), low = ok.length - off.length, body = A.islands.length - ok.length;
    var hs = off.map(function (id) { return A.islands[id].heightMm; });
    var n = A.plane.n;
    var face = (Math.abs(n[2]) === 1 ? (n[2] > 0 ? 'top' : 'underside') + ' face at z ' + f2(n[2] * A.plane.d) :
      'face (normal ' + n.map(function (x) { return x.toFixed(2); }).join(', ') + ')');
    var parts = ['Base: the ' + face + ' of ' + host.name + ', ' + A.base.areaMm2.toFixed(1) + ' mm², flat within ' +
      (A.plane.tolMm * 1000).toFixed(1) + ' µm.'];
    if (!A.islands.length) parts.push('Nothing stands proud of it.');
    else {
      parts.push(off.length + ' detail' + (off.length === 1 ? '' : 's') + ' stand' + (off.length === 1 ? 's' : '') +
        ' out more than ' + f2(minH) + ' mm' +
        (off.length ? ' (' + f2(Math.min.apply(null, hs)) + ' - ' + f2(Math.max.apply(null, hs)) + ' mm)' : '') + '.');
      if (low) parts.push(low + ' lower, not offered (grey).');
      if (body) parts.push(body + ' run' + (body === 1 ? 's' : '') + ' over the edge of the face: part of the body, not a detail.');
    }
    if (chosen.size) {
      parts.push(chosen.size + ' chosen - Lift takes ' + (chosen.size === 1 ? 'it' : 'them') + ' off.');
    } else if (off.length) parts.push('Click a detail to choose it; Shift-click for several.');
    return parts.join(' ');
  }

  // =========================================================================
  // Choosing
  // =========================================================================

  function choose(id, additive) {
    if (!A || !A.islands[id]) return { ok: false, reason: 'no such detail' };
    var I = A.islands[id];
    if (I.status !== 'ok') return fail('Lift: that ' + I.reason + '.');
    if (!(I.heightMm > minH)) {
      return fail('Lift: that detail stands out only ' + f2(I.heightMm) + ' mm, not more than ' + f2(minH) +
        ' mm - lower "How far out counts" to offer it.');
    }
    if (additive) { if (chosen.has(id)) chosen.delete(id); else chosen.add(id); }
    else chosen = new Set([id]);
    draw();
    say(readout());
    return { ok: true, chosen: Array.from(chosen) };
  }

  function clearChoice() { chosen = new Set(); draw(); say(readout()); }

  function clickHook(nx, ny, e) {
    if (!on || busy) return false;
    if (MS().mode() !== 'orbit') return false;
    var d = MS().getDoc(), v = MS().getView();
    if (!d || d.kind !== 'mesh' || !v) return false;
    var rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx, ny), v.camera);
    var meshes = Object.keys(v.overviewMeshes).map(function (k) { return v.overviewMeshes[k]; })
      .filter(function (m) { return m.visible && m.material && m.material.visible !== false && m.userData.object; });
    var hits = rc.intersectObjects(meshes, false);
    if (!hits.length || hits[0].faceIndex == null) return false;
    var o = hits[0].object.userData.object, tri = hits[0].faceIndex;
    if (!plateDoc()) { pickBase(o, tri); return true; }
    if (A && host && o.sourceId === host.sourceId && A.islandOf[tri] >= 0) {
      choose(A.islandOf[tri], !!(e && e.shiftKey));
      return true;
    }
    pickBase(o, tri);
    return true;
  }

  // =========================================================================
  // Drawing: the base tinted, islands by height, chosen ones magenta
  // =========================================================================

  function ensureLayer() {
    var v = MS() && MS().getView();
    if (!v) return null;
    if (!layer) { layer = new THREE.Group(); layer.name = 'gscopeLift'; layer.renderOrder = 9; }
    if (layer.parent !== v.scene) v.scene.add(layer);
    return layer;
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

  /** Blue (low) -> red (high) across the offered heights. */
  function heightColour(h, lo, hi) {
    var t = hi > lo ? Math.max(0, Math.min(1, (h - lo) / (hi - lo))) : 1;
    return new THREE.Color().setHSL(0.66 * (1 - t), 0.9, 0.55);
  }

  function overlay(o, tris, colourOf, opacity) {
    var P = o.positions, pos = new Float32Array(tris.length * 9), col = new Float32Array(tris.length * 9);
    tris.forEach(function (t, i) {
      var c = colourOf(t);
      for (var k = 0; k < 3; k++) {
        var q = MS().toView(P[t * 9 + k * 3], P[t * 9 + k * 3 + 1], P[t * 9 + k * 3 + 2]);
        pos[i * 9 + k * 3] = q.x; pos[i * 9 + k * 3 + 1] = q.y; pos[i * 9 + k * 3 + 2] = q.z;
        col[i * 9 + k * 3] = c.r; col[i * 9 + k * 3 + 1] = c.g; col[i * 9 + k * 3 + 2] = c.b;
      }
    });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: opacity < 1, opacity: opacity, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    }));
  }

  function draw() {
    if (!ensureLayer()) return;
    clearLayer();
    var d = plateDoc(), o = hostObject(d);
    layer.visible = on;
    syncPanel();
    if (!on || !A || !o) return;
    var off = new Set(LF().offered(A, minH)), lo = Infinity, hi = -Infinity;
    off.forEach(function (id) { var h = A.islands[id].heightMm; if (h < lo) lo = h; if (h > hi) hi = h; });
    var baseC = new THREE.Color(BASE_TINT);
    layer.add(overlay(o, A.base.list, function () { return baseC; }, 0.35));
    var shown = [], low = [], pick = [];
    A.islands.forEach(function (I) {
      if (I.status !== 'ok') return;
      var into = chosen.has(I.id) ? pick : off.has(I.id) ? shown : low;
      I.tris.forEach(function (t) { into.push(t); });
    });
    var cPick = new THREE.Color(CHOSEN), cLow = new THREE.Color(LOW);
    if (low.length) layer.add(overlay(o, low, function () { return cLow; }, 0.6));
    if (shown.length) {
      layer.add(overlay(o, shown, function (t) { return heightColour(A.islands[A.islandOf[t]].heightMm, lo, hi); }, 1));
    }
    if (pick.length) layer.add(overlay(o, pick, function () { return cPick; }, 1));
  }

  // =========================================================================
  // Lift
  // =========================================================================

  /** Take pieces off the plate and out of the model list. No undo step. */
  function takeOff(ids) {
    var drop = new Set(ids);
    state.placed.forEach(function (p) { if (p && drop.has(p.sourceId) && p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh); });
    state.placed = state.placed.filter(function (p) { return !(p && drop.has(p.sourceId)); });
    state.models = state.models.filter(function (m) { return !drop.has(m.id); });
    state.placed.forEach(function (p, i) { if (p.mesh) p.mesh.userData.placedIndex = i; });
  }

  /** G-scope's plate again, the camera left where the user had it. */
  function reread() {
    var v = MS().getView();
    var pos = v ? v.camera.position.clone() : null, tgt = v ? v.controls.target.clone() : null;
    MS().openPlate();
    if (v && pos) { v.camera.position.copy(pos); v.controls.target.copy(tgt); v.controls.update(); }
  }

  /** Analyse a piece again from a raw triangle, quietly; false when it is gone. */
  function reanalyse(sourceId, seed) {
    var d = plateDoc(), m = modelOf(sourceId);
    var o = d && d.objects.find(function (x) { return x.sourceId === sourceId; });
    if (!o || !m || !(seed >= 0)) { host = null; A = null; analysedRaw = null; chosen = new Set(); draw(); return false; }
    var r = LF().analyse(m.rawTris, seed);
    if (!r.ok) { host = null; A = null; analysedRaw = null; chosen = new Set(); draw(); return false; }
    host = { name: o.name, sourceId: sourceId };
    A = r; analysedRaw = m.rawTris; chosen = new Set();
    syncSlider();
    draw();
    return true;
  }

  function lift(ids) {
    if (busy) return { ok: false, reason: 'busy' };
    var want = ids ? ids.slice() : Array.from(chosen);
    if (!A || !host) return fail('Lift: pick the base face first');
    if (!want.length) return fail('Lift: nothing is chosen - click a detail first');
    var m = modelOf(host.sourceId);
    if (!m || m.rawTris !== analysedRaw) {
      return fail('Lift: "' + (m ? m.name : host.name) + '" changed since its face was picked - pick it again. Nothing changed.');
    }
    /* PAINT SCOPE: WHOLE-PIECE - see the header. */
    var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (painted > 0) {
      return fail('Lift stood down - ' + painted + ' painted face(s); the piece gets a new soup and cannot hold ' +
        'a face still. Clear paint to lift.');
    }
    var placed = state.placed.find(function (p) { return p && p.sourceId === m.id; });
    if (!placed) return fail('Lift: "' + m.name + '" is not on the plate - nothing changed');
    busy = true;
    try {
      var r = LF().lift(m.rawTris, A, want, { rawFlatCapLoops: window.rawFlatCapLoops || (typeof rawFlatCapLoops === 'function' ? rawFlatCapLoops : null) });
      if (!r.ok) return fail('Lift refused - nothing changed: ' + r.reason);

      /* The pieces first, so a failure to add one leaves the plate alone. */
      var added = [], names = [];
      for (var i = 0; i < r.pieces.length; i++) {
        var pc = r.pieces[i];
        var name = (m.name || 'piece') + ' - lifted ' + (pc.id + 1);
        var id = addModel(name, rawResultToDisplayGeometry(pc.soup), {
          rawTris: pc.soup, rawAxis: 'zup', centerOffset: computeCenterOffsetFromRaw(pc.soup),
          keepSelection: true, silent: true
        });
        if (id == null) {
          takeOff(added);
          return fail('Lift refused - nothing changed: detail ' + (pc.id + 1) + ' is too small to be a piece ' +
            '(under 0.1 mm across one way)');
        }
        added.push(id); names.push(name);
      }

      var seed = A.seed, before = 0;
      var gone = new Set();
      want.forEach(function (id) { A.islands[id].tris.forEach(function (t) { gone.add(t); }); });
      gone.forEach(function (t) { if (t < seed) before++; });
      var memo = { modelId: m.id, raw: m.rawTris, seed: seed };

      var txt = 'Lifted ' + r.pieces.length + ' detail' + (r.pieces.length === 1 ? '' : 's') + ' off ' + m.name +
        ' (' + r.volumes.pieces.toFixed(2) + ' mm³): it is flat where ' + (r.pieces.length === 1 ? 'it' : 'they') +
        ' stood, every other triangle as it was, and ' + (r.pieces.length === 1 ? 'the new piece is' : 'the new pieces are') +
        ' on free plate beside it. One Undo (Ctrl+Z) puts it all back.';
      var before0 = state.undoStack.length;
      if (typeof NSO_sculptCommitRaw !== 'function' || !NSO_sculptCommitRaw(m, r.plate, 'liftReplace', txt)) {
        takeOff(added);
        return fail('Lift refused - nothing changed: the commit was rejected');
      }
      var rep = state.undoStack.length > before0 ? state.undoStack.pop() : null;
      pushUndo({ type: 'featureSwap', replace: rep, addedIds: added.slice(), removed: [], label: 'Undo: Lift reverted',
        onUndone: function () { afterUndo(memo); } });

      /* Each new piece onto free plate, nearest the piece it came off. */
      var spots = [];
      added.forEach(function (id2) {
        var made = modelOf(id2);
        var entry = placeModelMovable(made, placed.x, placed.z);
        if (!entry) return;
        var at = nsoFreeSpot(entry, { x: placed.x, z: placed.z });
        applyPlacedXZ(entry, at.x, at.z);
        spots.push(at);
      });
      if (typeof renderModelList === 'function') renderModelList();
      if (typeof updateOptimizeButton === 'function') updateOptimizeButton();
      if (typeof updateEditSize === 'function') updateEditSize();
      if (typeof updateAdjustUI === 'function') updateAdjustUI();
      lastLift = memo;

      var off = spots.filter(function (s) { return !s.onBed; }).length;
      if (off) txt += ' ' + off + ' did not fit on the bed and sit beside it, clear of every piece.';
      reread();
      reanalyse(m.id, seed - before);
      say(txt + (A ? ' ' + readout() : ''), off > 0);
      return { ok: true, lift: r, addedIds: added, names: names, hostId: m.id, spots: spots, reason: txt };
    } catch (err) {
      console.error('[lift]', err);
      return fail('Lift failed - nothing changed (' + ((err && err.message) || err) + ')');
    } finally {
      busy = false;
    }
  }

  /** The Lift step was undone: the plate is back; redraw G-scope over it. */
  function afterUndo(memo) {
    if (!MS() || !MS().isOpen() || !plateDoc()) { host = null; A = null; analysedRaw = null; chosen = new Set(); return; }
    reread();
    var m = modelOf(memo.modelId);
    if (on && m && m.rawTris === memo.raw) reanalyse(memo.modelId, memo.seed);
    else { host = null; A = null; analysedRaw = null; chosen = new Set(); draw(); }
    say('Undo: Lift reverted - the piece and its details are back as they were.' + (A ? ' ' + readout() : ''));
  }

  // =========================================================================
  // Panel
  // =========================================================================

  function setOn(v) {
    on = !!v;
    if (on && MS() && MS().mode() !== 'orbit') MS().setMode('orbit');
    var b = $('ms-btn-lift-mode');
    if (b) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.classList.toggle('active', on); }
    if (!on) { chosen = new Set(); }
    draw();
    say(on ? readout() : 'Lift off. Pick base face to start again.');
    return on;
  }

  function syncPanel() {
    var row = $('ms-lift-row'), d = MS() && MS().getDoc();
    if (row) row.style.display = d && d.kind === 'mesh' ? 'block' : 'none';
    var lb = $('ms-btn-lift'), cb = $('ms-btn-lift-clear');
    if (lb) { lb.disabled = !(on && A && chosen.size); lb.textContent = chosen.size > 1 ? 'Lift ' + chosen.size : 'Lift'; }
    if (cb) cb.disabled = !(on && chosen.size);
  }

  function onDocument() {
    // A new document: keep the base only if it is the same piece, unchanged.
    var d = plateDoc(), m = host && modelOf(host.sourceId);
    if (!d || !m || m.rawTris !== analysedRaw || !hostObject(d)) { host = null; A = null; analysedRaw = null; chosen = new Set(); }
    if (!d && on && MS().getDoc() && MS().getDoc().kind !== 'mesh') on = false;
    draw();
    var r = $('ms-lift-read');
    if (r && !busy) r.textContent = readout();
  }

  function bind(id, ev, fn) {
    var el = $(id);
    if (el && el.dataset.wired !== '1') { el.dataset.wired = '1'; el.addEventListener(ev, fn); }
  }

  function mount() {
    if (!MS()) return;
    MS().addClickHook(clickHook);
    MS().onDocument(onDocument);
    minH = defaultMin();
    bind('ms-btn-lift-mode', 'click', function () { setOn(!on); });
    bind('ms-btn-lift', 'click', function () { lift(); });
    bind('ms-btn-lift-clear', 'click', clearChoice);
    bind('ms-lift-height', 'input', function () { setMinHeight(parseFloat($('ms-lift-height').value)); });
    syncSlider();
    syncPanel();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }

  return {
    setOn: setOn,
    isOn: function () { return on; },
    pickBase: function (name, tri) {
      var d = MS() && MS().getDoc(), o = d && d.objects && d.objects.find(function (x) { return x.name === name; });
      if (!o) return fail('Lift: no piece named ' + name);
      return pickBase(o, tri);
    },
    choose: choose,
    clearChoice: clearChoice,
    chosen: function () { return Array.from(chosen); },
    setMinHeight: setMinHeight,
    minHeight: function () { return minH; },
    defaultMinHeight: defaultMin,
    analysis: function () { return A; },
    offered: function () { return A ? LF().offered(A, minH) : []; },
    host: function () { return host ? Object.assign({}, host) : null; },
    lift: lift,
    readout: readout,
    layer: function () { return layer; }
  };
})();

if (typeof window !== 'undefined') window.NSO_GSCOPE_LIFT = NSO_GSCOPE_LIFT;
