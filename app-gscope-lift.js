/*
 * G-scope Lift - take details off a face, and leave the face as it was round
 * them: flat on a flat face, the surrounding surface carried across on a
 * curved one.
 * The app side of nso_lift.js (Phase 1), nso_lift_auto.js (Lift 2) and
 * nso_lift_curved.js (Lift 3).
 * READ docs/LIFT.md FIRST.
 * ----------------------------------------------------------------------------
 *
 * One section, "Lift", in G-scope's sidebar, on the plate, with a two-way
 * switch:
 *
 *   PICK (Phase 1, unchanged on a flat face)
 *   1. Pick base face, then click the face the details stand on. A flat face
 *      is read as Phase 1 reads it: its plane is fitted to the coplanar patch
 *      round the click (NSO_Lift.analyse). A face Phase 1 refuses as curved
 *      is read from the height map instead (NSO_LiftAuto.analyse) when the
 *      map finds something standing on it; when it finds nothing, the
 *      refusal stands, in Phase 1's words, and nothing changes.
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
 *   LIFT 3 (curved bases). Every height-map read - Pick on a face Phase 1
 *   calls curved, and Strip - asks NSO_LiftAuto.analyse for { curved: true }:
 *   a detail whose base bends is no longer refused, it is cut along the
 *   surface round it and the plate is made good there with that surface
 *   carried across, welded to its neighbours at the rim (nso_lift_curved.js).
 *   On a flat face nothing changes: the same islands, the same flat cuts,
 *   bit for bit. What the fill cannot know (a detail bigger than the surface
 *   measured round it, rough neighbours) is said after the lift, in words.
 *
 *   STRIP (Lift 2)
 *   After Pick base face, everything the height map finds on that face, each
 *   island at its own plane, grouped by what it is geometrically: small
 *   dots, lines & squiggles, large shapes, and can't lift (with the reason
 *   in words). Each group has a tick box and a count; every liftable detail
 *   starts ticked; untick a group to keep it on the plate; a click on one
 *   island on the model ticks or unticks it alone. The islands are coloured
 *   by group. "Lift N": each ticked island its own closed piece on free
 *   plate, the plate left flat. "Remove N": the ticked details thrown away,
 *   the plate left flat, no pieces. One Undo puts everything back for either.
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
 *   geometry    NSO_Lift.analyse / offered / lift (nso_lift.js), and
 *               NSO_LiftAuto.analyse / offered / lift / remove
 *               (nso_lift_auto.js, with NSO_LiftCurved's fill for a curved
 *               base); all cap with rawFlatCapLoops (app-cut.js)
 *   the swap    NSO_sculptCommitRaw (app-sculpt.js) + the 'featureSwap' undo
 *               step app-detach.js folds it into
 *   new pieces  addModel + placeModelMovable, as Detach adds its flange
 *   placement   nsoFreeSpot (app-core.js)
 *   the view    G-scope's click hook, onDocument, toView, openPlate
 *
 * PAINT SCOPE: WHOLE-PIECE, per the scoping rule in docs/HANDOFF.md. Lift
 * and Remove replace the piece's soup: the lifted islands' faces leave it and
 * a cap is added on the base face, so a painted face could lose its
 * triangles or gain new ones. nsoMaskCount(m) > 0 stands both down and names
 * the count.
 *
 * NON-SOLID SCOPE: the leftover plate is gated on staying closed only when
 * the source was closed (nso_lift.js, nso_lift_auto.js); every lifted piece
 * must be closed. nsoNonSolid(m) is not read - nothing here closes, peels or
 * drops boundary the piece arrived with.
 */
/* global THREE, state, setStatus, addModel, placeModelMovable, pushUndo, applyPlacedXZ,
          nsoFreeSpot, nsoMaskCount, NSO_sculptCommitRaw, rawResultToDisplayGeometry,
          computeCenterOffsetFromRaw, rawFlatCapLoops, renderModelList, updateOptimizeButton,
          updateEditSize, updateAdjustUI */
'use strict';

var NSO_GSCOPE_LIFT = (function () {
  var BASE_TINT = 0x22c55e, CHOSEN = 0xff2bd6, LOW = 0x6b7280;
  // Strip's groups, by geometry only (NSO_LiftAuto.GROUPS)
  var GROUP_COLOUR = { dots: 0x38bdf8, lines: 0xf59e0b, large: 0xa855f7, cant: 0xb91c1c };

  var on = false;
  var minH = null;            // the slider, mm
  var host = null;            // { name, sourceId } of the piece the base is on
  var A = null;               // NSO_Lift.analyse on that piece's rawTris
  var analysedRaw = null;     // the rawTris A was taken on
  var chosen = new Set();     // island ids
  var layer = null;
  var lastLift = null;        // { modelId, raw, seed } - for the Undo redraw
  var busy = false;
  var tab = 'pick';           // 'pick' | 'strip'
  var ticked = { dots: true, lines: true, large: true };   // Strip's tick boxes

  function $(id) { return document.getElementById(id); }
  function MS() { return window.NSO_MICROSCOPE; }
  function LF() { return window.NSO_Lift; }
  function LA() { return window.NSO_LiftAuto; }
  /** The module that made the analysis: Phase 1, or the height map. */
  function GEO(a) { return a && a.kind === 'map' ? LA() : LF(); }
  function isMap() { return !!(A && A.kind === 'map'); }
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
    var r = analyseFor(m.rawTris, tri);
    if (!r.ok) return fail(r.reason, r);
    host = { name: o.name, sourceId: o.sourceId };
    A = r;
    analysedRaw = m.rawTris;
    chosen = new Set();
    syncSlider();
    if (tab === 'strip') tickAll();
    draw();
    var msg = readout();
    say(msg);
    return { ok: true, analysis: A, ms: Date.now() - t0, reason: msg };
  }

  /**
   * The finder for the switch. Strip: the height map. Pick: Phase 1 on a flat
   * face; on one Phase 1 refuses as curved, the height map when it finds
   * something on it - else the refusal, in Phase 1's words. A refusal comes
   * back { ok: false, reason } in full sentences ending "Nothing changed."
   */
  // Lift 3: a base that bends is followed, not refused (nso_lift_curved.js)
  var MAP_OPTS = { curved: true };

  function analyseFor(raw, tri, keepEmpty) {
    function words(x) { return (/^Lift/.test(x) ? '' : 'Lift: ') + x + (/[.]$/.test(x) ? '' : '.') + ' Nothing changed.'; }
    if (tab === 'strip') {
      if (!LA()) return { ok: false, reason: 'Strip needs nso_lift_auto.js. Nothing changed.' };
      var s = LA().analyse(raw, tri, MAP_OPTS);
      if (!s.ok) return { ok: false, refused: s.refused, reason: words(s.reason) };
      return s;
    }
    var r = LF().analyse(raw, tri);
    if (r.ok) return r;
    if (r.refused === 'curved' && LA()) {
      var q = LA().analyse(raw, tri, MAP_OPTS);
      if (q.ok && (q.islands.length || keepEmpty)) { q.curvedWords = r.reason; return q; }
      return { ok: false, refused: r.refused, reason: words(r.reason) +
        (q.ok ? ' Read as a height map instead, nothing stands out of it more than ' + q.map.thresholdMm.toFixed(2) + ' mm either.' : '') };
    }
    return { ok: false, refused: r.refused, reason: words(r.reason) };
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
      var off = new Set(GEO(A).offered(A, minH));
      chosen.forEach(function (id) { if (!off.has(id)) chosen.delete(id); });
      if (tab === 'strip') tickAll(true);
    }
    syncSlider();
    draw();
    if (A) say(readout());
    return minH;
  }

  function readout() {
    if (!A) {
      if (tab === 'strip') return on ? 'Click the face the details stand on: everything on it is found and grouped.' :
        'Pick base face, then click the face the details stand on: everything on it is found and grouped.';
      return on ? 'Click the flat face the details stand on.' : 'Pick base face, then click the flat face the details stand on.';
    }
    if (isMap()) return mapReadout();
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

  var GROUP_WORDS = { dots: ['small dot', 'small dots'], lines: ['line or squiggle', 'lines & squiggles'],
                      large: ['large shape', 'large shapes'], cant: ['can\'t lift', 'can\'t lift'] };
  function countOf(n, key) { return n + ' ' + GROUP_WORDS[key][n === 1 ? 0 : 1]; }

  /** Why the can't-lift ones can't, counted: "2 - the surface under it bends too much ...". */
  function cantWords() {
    var why = {};
    A.islands.forEach(function (I) {
      if (I.status === 'ok') return;
      var k = LA().WHY[I.status] || I.reason;
      why[k] = (why[k] || 0) + 1;
    });
    return Object.keys(why).map(function (k) { return why[k] + ': ' + k; });
  }

  /** How the offered ones come off: each at its own flat cut, or (Lift 3)
      along the surface it stands on. */
  function cutWords(ids, lifted) {
    var curved = ids.filter(function (id) { return A.islands[id].fill === 'curved'; }).length;
    if (!curved) return lifted ? 'each lifted at its own flat cut' : 'each at its own flat cut';
    return (curved === ids.length ? 'each ' : curved + ' of them ') + (lifted ? 'lifted along' : 'cut along') + ' the surface ' +
      (curved === 1 && ids.length === 1 ? 'it stands' : 'they stand') + ' on, the face made good where ' +
      (curved === 1 ? 'it stood' : 'they stood');
  }

  /** The read-out for a height-map analysis: Pick on a curved face, or Strip. */
  function mapReadout() {
    var off = LA().offered(A, minH), ok = A.islands.filter(function (I) { return I.status === 'ok'; });
    var low = ok.length - off.length, cant = A.islands.length - ok.length;
    var parts = [];
    if (A.curvedWords) parts.push('This face bends, so it is read from a height map instead of as one flat face.');
    parts.push('Base: the face round the click on ' + host.name + ', ' + A.base.areaMm2.toFixed(1) + ' mm², looking down it ' +
      '(' + A.map.cellMm.toFixed(2) + ' mm per cell' + (A.map.coarsened ? ' - ' + A.map.coarsened : '') + '); the base under the details ' +
      'follows a ball ' + A.map.ballMm.toFixed(1) + ' mm in radius rolled under it.');
    if (!A.islands.length) { parts.push('Nothing stands out of it more than ' + f2(A.map.thresholdMm) + ' mm.'); return parts.join(' '); }
    var hs = off.map(function (id) { return A.islands[id].heightMm; });
    if (tab === 'strip') {
      var g = { dots: 0, lines: 0, large: 0 };
      off.forEach(function (id) { g[A.islands[id].group]++; });
      var found = ['dots', 'lines', 'large'].filter(function (k) { return g[k]; }).map(function (k) { return countOf(g[k], k); });
      parts.push('Found ' + (found.length ? found.join(', ') : 'nothing to lift') + ' standing out more than ' + f2(minH) + ' mm' +
        (off.length ? ' (' + f2(Math.min.apply(null, hs)) + ' - ' + f2(Math.max.apply(null, hs)) + ' mm), ' + cutWords(off, false) : '') + '.');
    } else {
      parts.push(off.length + ' detail' + (off.length === 1 ? '' : 's') + ' stand' + (off.length === 1 ? 's' : '') + ' out more than ' +
        f2(minH) + ' mm' + (off.length ? ' (' + f2(Math.min.apply(null, hs)) + ' - ' + f2(Math.max.apply(null, hs)) + ' mm), ' + cutWords(off, true) : '') + '.');
    }
    if (low) parts.push(low + ' lower, not offered (grey).');
    if (cant) parts.push(cant + ' can\'t be lifted - ' + cantWords().join('; ') + '.');
    if (tab === 'strip') {
      if (chosen.size) parts.push(chosen.size + ' ticked: Lift ' + chosen.size + ' makes each its own piece, Remove ' + chosen.size +
        ' throws ' + (chosen.size === 1 ? 'it' : 'them') + ' away; either way the face is left ' +
        (Array.from(chosen).some(function (id) { return A.islands[id].fill === 'curved'; }) ? 'as it was round them' : 'flat') + ' where they stood.');
      else if (off.length) parts.push('Nothing ticked.');
      if (off.length) parts.push('Untick a group to keep it on the plate; click a detail to tick or untick it alone.');
    } else if (chosen.size) {
      parts.push(chosen.size + ' chosen - Lift takes ' + (chosen.size === 1 ? 'it' : 'them') + ' off.');
    } else if (off.length) parts.push('Click a detail to choose it; Shift-click for several.');
    return parts.join(' ');
  }

  // =========================================================================
  // Strip: the ticks
  // =========================================================================

  var manual = new Map();     // island id -> true / false: a click that overrides its group's tick

  /** Ticked = offered, and its group ticked (or ticked by a click), unless unticked by a click. */
  function tickAll(keepClicks) {
    if (!keepClicks) manual = new Map();
    chosen = new Set();
    if (!A || !isMap()) return;
    LA().offered(A, minH).forEach(function (id) {
      var I = A.islands[id], m = manual.get(id);
      if (m === true || (m !== false && ticked[I.group])) chosen.add(id);
    });
  }

  function setGroup(key, v) {
    if (!(key in ticked)) return { ok: false, reason: 'no such group' };
    ticked[key] = !!v;
    // a group's tick box decides for every one of its details again
    if (A) A.islands.forEach(function (I) { if (I.group === key) manual.delete(I.id); });
    tickAll(true);
    draw();
    if (A) say(readout());
    return { ok: true, chosen: Array.from(chosen) };
  }

  function toggle(id) {
    if (!A || !A.islands[id]) return { ok: false, reason: 'no such detail' };
    var I = A.islands[id];
    if (I.status !== 'ok') return fail('Lift: that can\'t be lifted - ' + I.reason + '.');
    if (!(I.heightMm > minH)) {
      return fail('Lift: that detail stands out only ' + f2(I.heightMm) + ' mm, not more than ' + f2(minH) +
        ' mm - lower "How far out counts" to offer it.');
    }
    manual.set(id, !chosen.has(id));
    tickAll(true);
    draw();
    say(readout());
    return { ok: true, chosen: Array.from(chosen) };
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

  function clearChoice() {
    if (tab === 'strip' && A) A.islands.forEach(function (I) { manual.set(I.id, false); });
    chosen = new Set(); draw(); say(readout());
  }

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
      if (tab === 'strip' && isMap()) toggle(A.islandOf[tri]);
      else choose(A.islandOf[tri], !!(e && e.shiftKey));
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
    // A helper (nso-helpers.js), in G-scope's own scene; put back whenever it
    // is drawn, since a leave, a Clear or an Undo takes it out.
    if (layer.parent !== v.scene) nsoHelpers.attach(v.scene, layer, 'gscope-lift');
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
    if (tab === 'strip' && isMap()) { drawStrip(o); return; }
    var off = new Set(GEO(A).offered(A, minH)), lo = Infinity, hi = -Infinity;
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

  /** Strip: every island coloured by its group - ticked ones solid, unticked
      ones faint, lower than the slider grey, can't-lift dark red. */
  function drawStrip(o) {
    var off = new Set(LA().offered(A, minH)), baseC = new THREE.Color(BASE_TINT);
    layer.add(overlay(o, A.base.list, function () { return baseC; }, 0.35));
    var on1 = [], faint = [], low = [], cant = [];
    A.islands.forEach(function (I) {
      var into = I.status !== 'ok' ? cant : !off.has(I.id) ? low : chosen.has(I.id) ? on1 : faint;
      I.tris.forEach(function (t) { into.push(t); });
    });
    var col = {};
    Object.keys(GROUP_COLOUR).forEach(function (k) { col[k] = new THREE.Color(GROUP_COLOUR[k]); });
    function byGroup(t) { return col[A.islands[A.islandOf[t]].group]; }
    var cLow = new THREE.Color(LOW);
    if (low.length) layer.add(overlay(o, low, function () { return cLow; }, 0.6));
    if (cant.length) layer.add(overlay(o, cant, function () { return col.cant; }, 0.8));
    if (faint.length) layer.add(overlay(o, faint, byGroup, 0.3));
    if (on1.length) layer.add(overlay(o, on1, byGroup, 1));
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
    var r = analyseFor(m.rawTris, seed, true);
    if (!r.ok) { host = null; A = null; analysedRaw = null; chosen = new Set(); draw(); return false; }
    host = { name: o.name, sourceId: sourceId };
    A = r; analysedRaw = m.rawTris; chosen = new Set();
    syncSlider();
    if (tab === 'strip') tickAll();
    draw();
    return true;
  }

  function lift(ids) { return commit(ids, 'lift'); }
  function remove(ids) { return commit(ids, 'remove'); }

  /** Lift (each detail its own piece) or Remove (the details thrown away):
      the same swap, the same one Undo. */
  function commit(ids, kind) {
    if (busy) return { ok: false, reason: 'busy' };
    var rem = kind === 'remove', Verb = rem ? 'Remove' : 'Lift';
    var want = ids ? ids.slice() : Array.from(chosen);
    if (!A || !host) return fail(Verb + ': pick the base face first');
    if (rem && !isMap()) return fail('Remove: switch to Strip and pick the face again - Remove works on what Strip finds');
    if (!want.length) return fail(Verb + ': nothing is chosen - click a detail first');
    var m = modelOf(host.sourceId);
    if (!m || m.rawTris !== analysedRaw) {
      return fail('Lift: "' + (m ? m.name : host.name) + '" changed since its face was picked - pick it again. Nothing changed.');
    }
    /* PAINT SCOPE: WHOLE-PIECE - see the header. */
    var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (painted > 0) {
      return fail(rem ? 'Remove stood down - ' + painted + ' painted face(s); the piece gets a new soup and cannot hold ' +
        'a face still. Clear paint to remove.' : 'Lift stood down - ' + painted + ' painted face(s); the piece gets a new soup and cannot hold ' +
        'a face still. Clear paint to lift.');
    }
    var placed = state.placed.find(function (p) { return p && p.sourceId === m.id; });
    if (!placed) return fail('Lift: "' + m.name + '" is not on the plate - nothing changed');
    busy = true;
    try {
      var deps = { rawFlatCapLoops: window.rawFlatCapLoops || (typeof rawFlatCapLoops === 'function' ? rawFlatCapLoops : null) };
      var r = rem ? LA().remove(m.rawTris, A, want, deps) : GEO(A).lift(m.rawTris, A, want, deps);
      if (!r.ok) return fail(Verb + ' refused - nothing changed: ' + r.reason);
      if (rem) r.pieces = [];

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
      var memo = { modelId: m.id, raw: m.rawTris, seed: seed, kind: kind };

      // Lift 3: where a detail stood on a curve, the surface round it is
      // carried across instead of a flat cap
      var nCurved = (rem ? r.removed : r.pieces).filter(function (pc) { return pc.fill; }).length;
      var where = nCurved ? (nCurved === want.length ? '' : 'flat where ' + (want.length - nCurved === 1 ? 'one' : 'some') + ' stood on a flat face, ') +
        'the surface round ' + (want.length === 1 ? 'it' : 'them') + ' carried across where ' + (want.length === 1 ? 'it' : 'they') +
        ' stood and welded to it at the rim' : 'flat where ' + (want.length === 1 ? 'it' : 'they') + ' stood';
      var txt = rem ? 'Removed ' + want.length + ' detail' + (want.length === 1 ? '' : 's') + ' from ' + m.name + ' (' +
        r.volumes.removed.toFixed(2) + ' mm³, thrown away): it is ' + where + ', and every other triangle is as it was. One Undo (Ctrl+Z) puts ' +
        (want.length === 1 ? 'it' : 'them') + ' back.' :
        'Lifted ' + r.pieces.length + ' detail' + (r.pieces.length === 1 ? '' : 's') + ' off ' + m.name +
        ' (' + r.volumes.pieces.toFixed(2) + ' mm³): it is ' + where + ', every other triangle as it was, and ' +
        (r.pieces.length === 1 ? 'the new piece is' : 'the new pieces are') + ' on free plate beside it. One Undo (Ctrl+Z) puts it all back.';
      if (r.notes && r.notes.length) txt += ' Note: ' + r.notes.join('; ') + '.';
      var before0 = state.undoStack.length;
      if (typeof NSO_sculptCommitRaw !== 'function' || !NSO_sculptCommitRaw(m, r.plate, 'liftReplace', txt)) {
        takeOff(added);
        return fail(Verb + ' refused - nothing changed: the commit was rejected');
      }
      var rep = state.undoStack.length > before0 ? state.undoStack.pop() : null;
      pushUndo({ type: 'featureSwap', replace: rep, addedIds: added.slice(), removed: [], label: 'Undo: ' + Verb + ' reverted',
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
      return fail(Verb + ' failed - nothing changed (' + ((err && err.message) || err) + ')');
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
    say('Undo: ' + (memo.kind === 'remove' ? 'Remove' : 'Lift') + ' reverted - the piece and its details are back as they were.' +
      (A ? ' ' + readout() : ''));
  }

  // =========================================================================
  // Panel
  // =========================================================================

  /* Lift's height map, for the helper registry. Closing is Lift's own off
     switch; an Undo is already redrawn by afterUndo, so refresh is draw(). */
  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('gscope-lift', {
    live: function () { return on; },
    close: function () { setOn(false); },
    clear: clearLayer,
    refresh: function () { draw(); }
  });

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

  /** Pick | Strip. A base already picked stays picked, read again by the
      other side's finder. */
  function setTab(t) {
    t = t === 'strip' ? 'strip' : 'pick';
    if (t === tab) { syncPanel(); return tab; }
    tab = t;
    var msg = null;
    if (A && host) {
      var m = modelOf(host.sourceId), seed = A.seed;
      if (m && m.rawTris === analysedRaw && LF()) {
        var r = analyseFor(m.rawTris, seed, true);
        if (r.ok) { A = r; chosen = new Set(); manual = new Map(); syncSlider(); if (tab === 'strip') tickAll(); }
        else { msg = r.reason; host = null; A = null; analysedRaw = null; chosen = new Set(); }
      }
    }
    draw();
    say(msg || readout(), !!msg);
    return tab;
  }

  /** Strip's rows: per group, liftable and standing out more than the slider. */
  function groupCounts() {
    var c = { dots: { n: 0, ticked: 0 }, lines: { n: 0, ticked: 0 }, large: { n: 0, ticked: 0 }, cant: { n: 0, ticked: 0 } };
    if (!A || !isMap()) return c;
    var off = new Set(LA().offered(A, minH));
    A.islands.forEach(function (I) {
      if (I.status !== 'ok') { c.cant.n++; return; }
      if (!off.has(I.id)) return;
      c[I.group].n++;
      if (chosen.has(I.id)) c[I.group].ticked++;
    });
    return c;
  }

  function syncGroups() {
    var box = $('ms-lift-groups');
    if (!box) return;
    var show = tab === 'strip' && !!A && isMap();
    box.style.display = show ? 'block' : 'none';
    if (!show) { box.innerHTML = ''; return; }
    var c = groupCounts(), html = [];
    (LA().GROUPS || []).forEach(function (G) {
      var k = G.key, n = c[k].n, cant = k === 'cant';
      var hex = '#' + ('000000' + GROUP_COLOUR[k].toString(16)).slice(-6);
      var count = cant || c[k].ticked === n || (!c[k].ticked && !ticked[k]) ? String(n) : c[k].ticked + ' of ' + n;
      html.push('<label class="ms-lift-group" title="' + G.words + '"><input type="checkbox" data-group="' + k + '"' +
        (cant ? ' disabled' : (ticked[k] ? ' checked' : '')) + (n ? '' : (cant ? '' : ' disabled')) + ' />' +
        '<span class="ms-lift-sw" style="background:' + hex + '"></span>' + G.label +
        '<span class="ms-lift-n" data-count="' + k + '">' + count + '</span></label>');
      if (cant && n) cantWords().forEach(function (w) { html.push('<p class="ms-lift-why">' + w.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</p>'); });
    });
    box.innerHTML = html.join('');
    ['dots', 'lines', 'large'].forEach(function (k) {
      var cb = box.querySelector('input[data-group="' + k + '"]');
      if (cb) cb.indeterminate = c[k].ticked > 0 && c[k].ticked < c[k].n;
    });
  }

  function syncPanel() {
    var row = $('ms-lift-row'), d = MS() && MS().getDoc();
    if (row) row.style.display = d && d.kind === 'mesh' ? 'block' : 'none';
    var tp = $('ms-lift-tab-pick'), ts = $('ms-lift-tab-strip');
    if (tp) { tp.classList.toggle('active', tab === 'pick'); tp.setAttribute('aria-pressed', tab === 'pick' ? 'true' : 'false'); }
    if (ts) { ts.classList.toggle('active', tab === 'strip'); ts.setAttribute('aria-pressed', tab === 'strip' ? 'true' : 'false'); }
    var strip = tab === 'strip';
    var lb = $('ms-btn-lift'), cb = $('ms-btn-lift-clear'), rb = $('ms-btn-lift-remove');
    if (lb) {
      lb.disabled = !(on && A && chosen.size);
      lb.textContent = strip ? 'Lift ' + chosen.size : (chosen.size > 1 ? 'Lift ' + chosen.size : 'Lift');
    }
    if (rb) {
      rb.style.display = strip ? '' : 'none';
      rb.disabled = !(on && A && isMap() && chosen.size);
      rb.textContent = 'Remove ' + chosen.size;
    }
    if (cb) { cb.style.display = strip ? 'none' : ''; cb.disabled = !(on && chosen.size); }
    syncGroups();
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
    bind('ms-btn-lift-remove', 'click', function () { remove(); });
    bind('ms-btn-lift-clear', 'click', clearChoice);
    bind('ms-lift-tab-pick', 'click', function () { setTab('pick'); });
    bind('ms-lift-tab-strip', 'click', function () { setTab('strip'); });
    bind('ms-lift-groups', 'change', function (e) {
      var k = e.target && e.target.getAttribute && e.target.getAttribute('data-group');
      if (k) setGroup(k, e.target.checked);
    });
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
    offered: function () { return A ? GEO(A).offered(A, minH) : []; },
    host: function () { return host ? Object.assign({}, host) : null; },
    lift: lift,
    remove: remove,
    setTab: setTab,
    tab: function () { return tab; },
    setGroup: setGroup,
    toggle: toggle,
    groups: groupCounts,
    ticked: function () { return Object.assign({}, ticked); },
    readout: readout,
    layer: function () { return layer; }
  };
})();

if (typeof window !== 'undefined') window.NSO_GSCOPE_LIFT = NSO_GSCOPE_LIFT;
