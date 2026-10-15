/*
 * Lift on the plate - the SUBTRACT card's LIFT verb.
 * The app side of nso_lift_auto.js (Lift 2) and nso_lift_curved.js (Lift 3);
 * the engine is unchanged, only where and how it is driven.
 * READ docs/LIFT.md FIRST (section 7 is this file).
 * ----------------------------------------------------------------------------
 *
 * ARM. Lift on a selected piece runs detection ONCE: the rolling-ball height
 * map (NSO_LiftAuto.analyse, { curved: true }) looking straight down onto the
 * piece, from the face it lies with up. The result is cached per piece soup
 * (a WeakMap keyed by m.rawTris) until the piece changes, so an Undo that
 * puts a soup back finds its features already read. The card says
 * "N features found" - liftable, and standing out more than "How far out
 * counts" (default 0.42 mm, NSO_Thickness.floorFor(0.4), as G-scope had it).
 *
 * PICK (the default). Hovering the piece outlines the feature under the
 * cursor; the island is the engine's (an island whose surround leans more
 * than 35 degrees off the view is refused by it, and said so). A click lifts
 * it. Shift-click gathers several, and they lift together when Shift is let
 * go. Each click, or each Shift group, is one Undo.
 *
 * STRIP. One button: a short untick list of what was found, grouped (e.g.
 * "line x1 . large shape x1 (12 parts) . dots x20 . bare plate"), Confirm /
 * Cancel. Confirm lifts every ticked feature in one step, one Undo.
 *
 * WHAT A LIFT DOES. As G-scope's Lift did, unchanged: the piece keeps its
 * place and id and becomes the leftover plate (NSO_sculptCommitRaw, every
 * other triangle bit for bit, flat - or on a curved base, the surface round
 * it carried across - where each feature stood); each feature becomes its
 * own closed piece named "<piece> - lifted N", an ordinary piece (Pieces
 * list, Move, Join, Export, Remove), placed on free plate nearest the piece
 * it came off (nsoFreeSpot). One 'featureSwap' Undo step (Detach's) puts it
 * all back.
 *
 * FRAME. The map runs on the piece's RAW soup (m.rawTris), the frame the
 * pieces are made in. The view is the world's up carried into that frame
 * through the piece's mesh, so a piece lying as it was made reads straight
 * down raw +Z. The display mesh is the same triangles in the same order
 * (rawResultToDisplayGeometry / the importer), checked before a hover or a
 * click is read off it.
 *
 * PAINT SCOPE: WHOLE-PIECE, per the scoping rule in docs/HANDOFF.md. A lift
 * replaces the piece's soup: the lifted features' faces leave it and a cap is
 * added where they stood, so a painted face could lose its triangles or gain
 * new ones. nsoMaskCount(m) > 0 stands it down and names the count.
 *
 * NON-SOLID SCOPE: the leftover plate is gated on staying closed only when
 * the source was closed (nso_lift_auto.js); every lifted piece must be
 * closed. nsoNonSolid(m) is not read.
 *
 * G-scope's Features row (app-gscope-lift.js) reads the same cache through
 * NSO_LIFT_PLATE.detectSoup, so the two always count the same features.
 */
/* global THREE, state, setStatus, addModel, placeModelMovable, pushUndo, applyPlacedXZ,
          nsoFreeSpot, nsoMaskCount, NSO_sculptCommitRaw, rawResultToDisplayGeometry,
          computeCenterOffsetFromRaw, rawFlatCapLoops, renderModelList, updateOptimizeButton,
          updateEditSize, updateAdjustUI, selectPlaced, nsoHelpers */
'use strict';

var NSO_LIFT_PLATE = (function () {
  var MAP_OPTS = { curved: true };          // Lift 3: a base that bends is followed
  var UP_DEG = 20;                          // a seed face looks within this of the view
  var BIN_MM = 0.05;                        // seed faces binned by height, this fine
  var HOVER = 0xfacc15, PENDING = 0xff2bd6, FOUND = 0x38bdf8;

  function LA() { return typeof window !== 'undefined' ? window.NSO_LiftAuto : null; }
  function LF() { return typeof window !== 'undefined' ? window.NSO_Lift : null; }
  function $(id) { return typeof document !== 'undefined' ? document.getElementById(id) : null; }
  function f2(x) { return (+x).toFixed(2); }

  // =========================================================================
  // Detection, cached per soup
  // =========================================================================

  var cache = new WeakMap();               // soup -> { key, r }

  function nkey(n) { return n.map(function (x) { return x.toFixed(6); }).join(','); }

  /** Seed triangles for the map: faces looking within UP_DEG of the view,
      binned by height; the bins with the most area first (the face the
      details stand on is the biggest one looking up), then the single
      biggest such triangle. */
  function seeds(soup, n) {
    var bins = new Map(), cosUp = Math.cos(UP_DEG * Math.PI / 180), bestT = -1, bestA = 0;
    for (var o = 0, t = 0; o + 8 < soup.length; o += 9, t++) {
      var ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
      var vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
      var cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      var L = Math.hypot(cx, cy, cz);
      if (!(L > 1e-12)) continue;
      if ((cx * n[0] + cy * n[1] + cz * n[2]) / L < cosUp) continue;
      var h = ((soup[o] + soup[o + 3] + soup[o + 6]) * n[0] + (soup[o + 1] + soup[o + 4] + soup[o + 7]) * n[1] +
               (soup[o + 2] + soup[o + 5] + soup[o + 8]) * n[2]) / 3;
      var k = Math.round(h / BIN_MM), b = bins.get(k);
      if (!b) { b = { area: 0, t: -1, a: 0 }; bins.set(k, b); }
      b.area += L / 2;
      if (L / 2 > b.a) { b.a = L / 2; b.t = t; }
      if (L / 2 > bestA) { bestA = L / 2; bestT = t; }
    }
    var out = Array.from(bins.values()).sort(function (a, b) { return b.area - a.area; })
      .slice(0, 4).map(function (b) { return b.t; });
    if (bestT >= 0 && out.indexOf(bestT) < 0) out.push(bestT);
    return out;
  }

  /**
   * The features on `soup`, looking down `n` (default raw +Z). Once per soup
   * and view: a second call with the same soup is the first call's answer.
   * -> { ok, A, seed, ms, cached } or { ok: false, refused, reason }.
   */
  function detectSoup(soup, n) {
    n = n || [0, 0, 1];
    var key = nkey(n), hit = soup && cache.get(soup);
    if (hit && hit.key === key) return Object.assign({}, hit.r, { cached: true });
    var r = detectNow(soup, n);
    if (soup) cache.set(soup, { key: key, r: r });
    return Object.assign({}, r, { cached: false });
  }

  function detectNow(soup, n) {
    var t0 = Date.now();
    if (!LA()) return { ok: false, refused: 'deps', reason: 'Lift needs nso_lift_auto.js. Nothing changed.' };
    if (!soup || soup.length < 36) return { ok: false, refused: 'empty', reason: 'Lift: there is no mesh to lift from. Nothing changed.' };
    var S = seeds(soup, n);
    if (!S.length) {
      return { ok: false, refused: 'noface', reason: 'Lift: this piece has no face looking up for details to stand on. Nothing changed.' };
    }
    var M = LA().index(soup), empty = null, last = null;
    for (var i = 0; i < S.length; i++) {
      var r = LA().analyse(soup, S[i], Object.assign({ M: M, normal: n }, MAP_OPTS));
      if (r.ok && r.islands.length) return { ok: true, A: r, seed: S[i], ms: Date.now() - t0 };
      if (r.ok && !empty) empty = r;
      if (!r.ok) last = r;
    }
    if (empty) return { ok: true, A: empty, seed: empty.seed, ms: Date.now() - t0 };
    return { ok: false, refused: last && last.refused, reason: 'Lift: ' + ((last && last.reason) || 'nothing to read') + '. Nothing changed.' };
  }

  /** Liftable, and standing out more than minH. */
  function offered(A, minH) { return A ? LA().offered(A, minH) : []; }

  // =========================================================================
  // The grouped breakdown (Strip's list, G-scope's Features)
  // =========================================================================

  var WORDS = { dots: ['dot', 'dots'], lines: ['line', 'lines'], large: ['large shape', 'large shapes'] };
  var KEYS = ['lines', 'large', 'dots'];

  /** Per group: the offered ids, and how many parts the necks divide its
      large shapes into (data from the engine; nothing is split). */
  function groups(A, minH) {
    var g = {};
    KEYS.forEach(function (k) { g[k] = { key: k, ids: [], parts: 0 }; });
    var cant = 0, low = 0, off = new Set(offered(A, minH));
    (A ? A.islands : []).forEach(function (I) {
      if (I.status !== 'ok') { cant++; return; }
      if (!off.has(I.id)) { low++; return; }
      var G = g[I.group] || g.large;
      G.ids.push(I.id);
      G.parts += (I.necks && I.necks.parts) || 1;
    });
    return { list: KEYS.map(function (k) { return g[k]; }).filter(function (G) { return G.ids.length; }), cant: cant, low: low };
  }

  function groupWords(G) {
    var n = G.ids.length;
    return (n === 1 ? WORDS[G.key][0] : WORDS[G.key][1]) + ' ×' + n + (G.parts > n ? ' (' + G.parts + ' parts)' : '');
  }

  /** "line x1 . large shape x1 (12 parts) . dots x20 . bare plate", for the
      groups ticked; the last item is what the plate is left as. */
  function breakdown(A, minH, tickedKeys) {
    var gs = groups(A, minH), parts = [], kept = 0;
    gs.list.forEach(function (G) {
      if (!tickedKeys || tickedKeys[G.key] !== false) parts.push(groupWords(G));
      else kept += G.ids.length;
    });
    kept += gs.cant + gs.low;
    parts.push(kept ? 'the plate keeps ' + kept : 'bare plate');
    return parts.join(' · ');
  }

  // =========================================================================
  // The card
  // =========================================================================

  var armed = false;
  var targetId = null;                      // the piece's model id
  var D = null;                             // detectSoup's answer for it
  var minH = null;
  var hoverId = -1;
  var pending = new Set();                  // a Shift group, not yet lifted
  var stripOpen = false;
  var stripTicks = { dots: true, lines: true, large: true };
  var busy = false;
  var layer = null;
  var lastMsg = '';

  function defaultMin() { return LF() ? LF().defaultMinHeight() : 0.42; }
  function modelOf(id) { return (state.models || []).find(function (m) { return m && m.id === id; }) || null; }
  function placedOf(id) { return (state.placed || []).find(function (p) { return p && p.sourceId === id; }) || null; }
  function A() { return D && D.ok ? D.A : null; }

  function say(msg, bad) {
    lastMsg = msg;
    var r = $('lift-readout');
    if (r) { r.textContent = msg; r.classList.toggle('carve-bad', !!bad); }
    if (typeof setStatus === 'function') setStatus(msg, !!bad);
  }
  function fail(msg) { say(msg, true); return { ok: false, reason: msg }; }

  /** The world's up, in the piece's raw frame (raw = display (x, -z, y)). */
  function viewOf(p) {
    if (!p || !p.mesh || typeof THREE === 'undefined') return [0, 0, 1];
    p.mesh.updateMatrixWorld(true);
    var q = new THREE.Quaternion();
    p.mesh.getWorldQuaternion(q);
    var u = new THREE.Vector3(0, 1, 0).applyQuaternion(q.invert());
    var n = [u.x, -u.z, u.y];
    return n.map(function (x) { return Math.abs(x) < 1e-6 ? 0 : Math.abs(Math.abs(x) - 1) < 1e-6 ? Math.sign(x) : x; });
  }

  /** Why this piece cannot be lifted from, in words; null when it can. */
  function refusalFor(m, p) {
    if (!m || !p) return 'Lift works on pieces on the plate - that is not one. Nothing changed.';
    if (!(m.rawTris && m.rawAxis === 'zup')) {
      return 'Lift needs a raw piece - "' + m.name + '" has no untransformed soup. Nothing changed.';
    }
    /* PAINT SCOPE: WHOLE-PIECE - see the header. */
    var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (painted > 0) {
      return 'Lift stood down - ' + painted + ' painted face(s) on "' + m.name + '"; the piece gets a new soup and cannot ' +
        'hold a face still. Clear paint to lift.';
    }
    var g = p.mesh && p.mesh.geometry, pos = g && g.attributes && g.attributes.position;
    if (!pos || g.index || pos.count * 3 !== m.rawTris.length) {
      return 'Lift: "' + m.name + '" on the plate does not match its own mesh - nothing changed.';
    }
    return null;
  }

  /** Point the card at a piece: read it (or its cached read) and say so. */
  function target(id) {
    var m = modelOf(id), p = placedOf(id);
    clearHover(); pending = new Set(); closeStrip(true);
    var why = refusalFor(m, p);
    if (why) { targetId = null; D = null; draw(); sync(); return fail(why); }
    targetId = id;
    D = detectSoup(m.rawTris, viewOf(p));
    syncSlider();
    draw(); sync();
    if (!D.ok) return fail(D.reason);
    say(readout());
    return { ok: true, count: offered(A(), minH).length, cached: D.cached, ms: D.ms };
  }

  /** Re-read the target if its soup changed (a lift, an Undo, any edit). */
  function refresh() {
    if (!armed || targetId == null) { draw(); sync(); return; }
    var m = modelOf(targetId), p = placedOf(targetId);
    if (!m || !p) { targetId = null; D = null; clearHover(); draw(); sync(); return; }
    D = detectSoup(m.rawTris, viewOf(p));
    if (hoverId >= 0 && !(A() && A().islands[hoverId])) hoverId = -1;
    syncSlider(); draw(); sync();
  }

  function readout() {
    if (!armed) return 'Lift off.';
    if (targetId == null) return 'Lift: click a piece on the plate to find what stands on it.';
    if (!D || !D.ok) return D ? D.reason : '';
    var m = modelOf(targetId), a = A(), gs = groups(a, minH), n = offered(a, minH).length;
    var parts = [];
    if (!a.islands.length) {
      parts.push('Nothing found on ' + m.name + ': nothing stands out of its top more than ' + f2(a.map.thresholdMm) + ' mm.');
      return parts.join(' ');
    }
    parts.push(n + ' feature' + (n === 1 ? '' : 's') + ' found on ' + m.name + ' standing out more than ' + f2(minH) + ' mm' +
      (n ? ': ' + gs.list.map(groupWords).join(' · ') : '') + '.');
    if (gs.low) parts.push(gs.low + ' lower, not offered.');
    if (gs.cant) {
      var why = {};
      a.islands.forEach(function (I) { if (I.status !== 'ok') { var k = I.status === 'slant' ? cantWords({ status: 'slant' }) : cantWords(I); why[k] = (why[k] || 0) + 1; } });
      parts.push(gs.cant + ' can\'t be lifted - ' + Object.keys(why).map(function (k) { return why[k] + ': ' + k; }).join('; ') + '.');
    }
    if (pending.size) parts.push(pending.size + ' gathered - let go of Shift to lift ' + (pending.size === 1 ? 'it' : 'them') + ' in one step.');
    else if (n) parts.push('Hover a feature to see it; click lifts it, Shift-click gathers several. Or Strip.');
    return parts.join(' ');
  }

  function syncSlider() {
    if (minH == null) minH = defaultMin();
    var s = $('lift-height'), rd = $('lift-height-read');
    if (s) {
      var top = 0, a = A();
      if (a) a.islands.forEach(function (I) { if (I.status === 'ok' && I.heightMm > top) top = I.heightMm; });
      s.max = String(Math.max(1, Math.ceil(Math.max(top, minH) * 100 + 1) / 100));
      s.value = String(minH);
    }
    if (rd) rd.textContent = f2(minH) + ' mm';
  }

  function setMinHeight(h) {
    var v = +h;
    if (!(v >= 0) || !isFinite(v)) return minH;
    minH = v;
    var off = new Set(offered(A(), minH));
    pending.forEach(function (id) { if (!off.has(id)) pending.delete(id); });
    syncSlider(); draw(); sync();
    if (armed && D) say(readout());
    return minH;
  }

  function sync() {
    var b = $('btn-lift');
    if (b) { b.setAttribute('aria-pressed', armed ? 'true' : 'false'); b.classList.toggle('is-armed', armed); }
    var panel = $('lift-panel');
    if (panel) panel.hidden = !armed;
    var a = A(), n = offered(a, minH).length;
    var c = $('lift-count');
    if (c) c.textContent = !armed || targetId == null ? '—' : !D || !D.ok ? 'nothing read' :
      n + ' feature' + (n === 1 ? '' : 's') + ' found';
    var sb = $('btn-lift-strip');
    if (sb) sb.disabled = !(armed && n && !busy);
    syncStrip();
    var r = $('lift-readout');
    if (r && armed && !busy && lastMsg !== r.textContent) r.textContent = lastMsg || readout();
  }

  // =========================================================================
  // Arming
  // =========================================================================

  /** One click-owning mode at a time, as Carve's disarmOthers. */
  function disarmOthers() {
    if (state.carveArmed) { var c = $('btn-carve'); if (c) c.click(); else state.carveArmed = false; }
    if (state.maskPaint) {
      var paintBtn = $(state.maskPaint === 'select' ? 'btn-mask-select' : 'btn-mask-paint');
      if (paintBtn) paintBtn.click();
    }
    if (state.seatHereArmed) { var s = $('btn-seat-here'); if (s) s.click(); else state.seatHereArmed = false; }
    if (typeof window.nsoBrushArmed === 'function' && window.nsoBrushArmed()) {
      var br = $('btn-brush');
      if (br) br.click(); else if (typeof window.nsoBrushSetArmed === 'function') window.nsoBrushSetArmed(false);
    }
    if (state.measureOn) { var mb = $('btn-measure'); if (mb) mb.click(); else state.measureOn = false; }
    state.softenArmed = false;
    state.capArmed = false;
    state.centerLockArmed = false;
  }

  function setArmed(on) {
    on = !!on;
    if (on === armed) { sync(); return armed; }
    armed = on;
    if (!armed) {
      clearHover(); pending = new Set(); closeStrip(true);
      targetId = null; D = null;
      draw(); sync();
      say('Lift off.');
      return armed;
    }
    disarmOthers();
    if (minH == null) minH = defaultMin();
    var p = state.placed && state.placed[state.selectedIndex];
    if (p && p.sourceId != null) target(p.sourceId);
    else { targetId = null; D = null; draw(); sync(); say(readout()); }
    return armed;
  }

  // =========================================================================
  // The pointer: hover outlines, click lifts, Shift-click gathers
  // =========================================================================

  /** The piece and raw triangle under a pointer event, or null. */
  function hitAt(ev) {
    if (!state.renderer || !state.camera || !state.modelGroup) return null;
    var rect = state.renderer.domElement.getBoundingClientRect();
    var nx = ((ev.clientX - rect.left) / rect.width) * 2 - 1, ny = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    if (nx < -1 || nx > 1 || ny < -1 || ny > 1) return null;
    var rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx, ny), state.camera);
    var hits = rc.intersectObjects(state.modelGroup.children, true);
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].faceIndex == null) continue;
      var obj = hits[i].object;
      while (obj && (!obj.userData || obj.userData.placedIndex == null) && obj.parent) obj = obj.parent;
      var idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      var p = typeof idx === 'number' ? state.placed[idx] : null;
      if (p && p.sourceId != null) return { placed: p, id: p.sourceId, tri: hits[i].faceIndex };
    }
    return null;
  }

  /** The feature at raw triangle `tri` of the target: { id, I } or null. */
  function featureAt(tri) {
    var a = A();
    if (!a || !(tri >= 0)) return null;
    var id = a.islandOf[tri];
    return id >= 0 ? { id: id, I: a.islands[id] } : null;
  }

  /** Why a found feature can't be lifted, in the plate's words. The engine's
      own words for 'slant' tell G-scope's user to click the face nearer it;
      on the plate the view is straight down, so the piece is what turns. */
  function cantWords(I) {
    if (I.status === 'slant') {
      return 'it stands where the piece slopes ' + (I.slantDeg != null ? (+I.slantDeg).toFixed(0) + '\u00b0' : 'too far') +
        ' away from looking up (35\u00b0 is the most Lift reads) - turn the piece so that side faces up';
    }
    return (LA().WHY[I.status] || I.reason);
  }

  /** Why a feature cannot be lifted at the slider, in words; null when it can. */
  function whyNot(I) {
    if (I.status !== 'ok') return 'Lift: that can\'t be lifted - ' + cantWords(I) + '.';
    if (!(I.heightMm > minH)) {
      return 'Lift: that stands out only ' + f2(I.heightMm) + ' mm, not more than ' + f2(minH) +
        ' mm - lower "How far out counts" to offer it.';
    }
    return null;
  }

  /* One raycast a frame, however many moves arrive in it. */
  var hoverEv = null, hoverRaf = false;
  function onMove(ev) {
    if (!armed || busy || stripOpen || targetId == null) return;
    if (ev.buttons) return;                   // orbiting or panning
    hoverEv = ev;
    if (hoverRaf) return;
    hoverRaf = true;
    requestAnimationFrame(function () {
      hoverRaf = false;
      var e = hoverEv; hoverEv = null;
      if (e && armed && !busy && !stripOpen) hoverAt(e);
    });
  }

  function hoverAt(ev) {
    var h = hitAt(ev), id = -1;
    if (h && h.id === targetId) { var f = featureAt(h.tri); if (f) id = f.id; }
    setHover(id);
  }

  function setHover(id) {
    if (id === hoverId) return;
    hoverId = id;
    draw();
    var a = A();
    if (id >= 0 && a) {
      var I = a.islands[id], why = whyNot(I);
      var r = $('lift-readout');
      var txt = why || ('A ' + (WORDS[I.group] ? WORDS[I.group][0] : 'feature') + ', ' + f2(I.heightMm) + ' mm high, ' +
        I.areaMm2.toFixed(1) + ' mm²' + ((I.necks && I.necks.parts > 1) ? ', ' + I.necks.parts + ' parts' : '') +
        ' - click to lift it, Shift-click to gather it.');
      if (r) { r.textContent = txt; r.classList.toggle('carve-bad', !!why); }
    } else if (armed) {
      var rr = $('lift-readout');
      if (rr) { rr.textContent = lastMsg || readout(); rr.classList.remove('carve-bad'); }
    }
  }
  function clearHover() { if (hoverId !== -1) { hoverId = -1; draw(); } }

  /** app-core's pointerdown asks this first (after Carve), as Carve's. */
  function takesClick(ev) {
    if (!armed || !ev || ev.button !== 0 || stripOpen) return false;
    var h = hitAt(ev);
    if (!h) return false;
    if (busy) { say('Lift: the last lift is still running - one at a time', true); return true; }
    if (h.id !== targetId) {
      // another piece: point the card at it (and select it)
      var idx = state.placed.indexOf(h.placed);
      if (idx >= 0 && typeof selectPlaced === 'function') selectPlaced(idx);
      target(h.id);
      return true;
    }
    var f = featureAt(h.tri);
    if (!f) { say('Lift: nothing to lift there - ' + (offered(A(), minH).length ? 'hover a feature first.' : 'nothing is found on this piece.')); return true; }
    var why = whyNot(f.I);
    if (why) { fail(why); return true; }
    if (ev.shiftKey) { gather(f.id); return true; }
    var ids = pending.size ? Array.from(pending) : [];
    if (ids.indexOf(f.id) < 0) ids.push(f.id);
    pending = new Set();
    setTimeout(function () { lift(ids); }, 0);
    return true;
  }

  function gather(id) {
    if (pending.has(id)) pending.delete(id); else pending.add(id);
    draw(); sync();
    say(readout());
    return Array.from(pending);
  }

  function onKeyUp(ev) {
    if (ev.key !== 'Shift' || !armed || !pending.size || busy) return;
    var ids = Array.from(pending);
    pending = new Set();
    lift(ids);
  }

  // =========================================================================
  // Strip: the untick list, Confirm / Cancel
  // =========================================================================

  function openStrip() {
    if (!armed || !A() || !offered(A(), minH).length) return fail('Strip: nothing is found to lift.');
    stripOpen = true;
    stripTicks = { dots: true, lines: true, large: true };
    pending = new Set(); clearHover();
    draw(); sync();
    say('Strip: untick what stays on the plate, then Confirm. One Undo puts it all back.');
    return { ok: true, list: stripList() };
  }
  function closeStrip(quiet) {
    if (!stripOpen) return;
    stripOpen = false;
    draw(); sync();
    if (!quiet) say(readout());
  }
  function stripIds() {
    var ids = [];
    groups(A(), minH).list.forEach(function (G) { if (stripTicks[G.key] !== false) ids = ids.concat(G.ids); });
    return ids;
  }
  function stripList() { return breakdown(A(), minH, stripTicks); }
  function setStripGroup(key, v) {
    if (!(key in stripTicks)) return null;
    stripTicks[key] = !!v;
    draw(); sync();
    return stripList();
  }
  function confirmStrip() {
    if (!stripOpen) return fail('Strip: open the list first.');
    var ids = stripIds();
    if (!ids.length) return fail('Strip: nothing is ticked - nothing changed.');
    stripOpen = false;
    return lift(ids, 'strip');
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  function syncStrip() {
    var box = $('lift-strip');
    if (!box) return;
    box.hidden = !(armed && stripOpen);
    if (box.hidden) return;
    var gs = groups(A(), minH), rows = $('lift-strip-rows');
    if (rows) {
      rows.innerHTML = gs.list.map(function (G) {
        return '<label class="lift-strip-row"><input type="checkbox" data-group="' + G.key + '"' +
          (stripTicks[G.key] !== false ? ' checked' : '') + ' /> ' + esc(groupWords(G)) + '</label>';
      }).join('') + (gs.cant ? '<p class="lift-strip-note">' + gs.cant + ' can\'t be lifted - they stay.</p>' : '') +
        (gs.low ? '<p class="lift-strip-note">' + gs.low + ' lower than ' + f2(minH) + ' mm - they stay.</p>' : '');
    }
    var sum = $('lift-strip-sum');
    if (sum) sum.textContent = stripList();
    var go = $('btn-lift-strip-go'), n = stripIds().length;
    if (go) { go.disabled = !n || busy; go.textContent = 'Confirm – lift ' + n; }
  }

  // =========================================================================
  // Lift: the swap, the pieces, one Undo
  // =========================================================================

  /** Take pieces off the plate and out of the model list. No undo step. */
  function takeOff(ids) {
    var drop = new Set(ids);
    state.placed.forEach(function (p) { if (p && drop.has(p.sourceId) && p.mesh && p.mesh.parent) p.mesh.parent.remove(p.mesh); });
    state.placed = state.placed.filter(function (p) { return !(p && drop.has(p.sourceId)); });
    state.models = state.models.filter(function (m) { return !drop.has(m.id); });
    state.placed.forEach(function (p, i) { if (p.mesh) p.mesh.userData.placedIndex = i; });
  }

  function lift(ids, how) {
    if (busy) return { ok: false, reason: 'busy' };
    var want = (ids || []).slice();
    var a = A();
    if (!armed || !a || targetId == null) return fail('Lift: arm Lift on a piece first.');
    if (!want.length) return fail('Lift: nothing is chosen - nothing changed.');
    for (var w = 0; w < want.length; w++) {
      var I0 = a.islands[want[w]];
      if (!I0) return fail('Lift: no such feature - nothing changed.');
      var why = whyNot(I0);
      if (why) return fail(why);
    }
    var m = modelOf(targetId), placed = placedOf(targetId);
    var refused = refusalFor(m, placed);
    if (refused) return fail(refused);
    // the features must be this soup's: a cached read is, anything else is read again first
    var cur = detectSoup(m.rawTris, viewOf(placed));
    if (!cur.ok || cur.A !== a) { D = cur; refresh(); return fail('Lift: "' + m.name + '" changed since it was read - read again, try once more. Nothing changed.'); }
    busy = true;
    clearHover();
    try {
      var deps = { rawFlatCapLoops: window.rawFlatCapLoops || (typeof rawFlatCapLoops === 'function' ? rawFlatCapLoops : null) };
      var r = LA().lift(m.rawTris, a, want, deps);
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
          return fail('Lift refused - nothing changed: feature ' + (pc.id + 1) + ' is too small to be a piece ' +
            '(under 0.1 mm across one way)');
        }
        added.push(id); names.push(name);
      }

      var nCurved = r.pieces.filter(function (pc2) { return pc2.fill; }).length;
      var where = nCurved ? (nCurved === want.length ? '' : 'flat where ' + (want.length - nCurved === 1 ? 'one' : 'some') + ' stood on a flat face, ') +
        'the surface round ' + (want.length === 1 ? 'it' : 'them') + ' carried across where ' + (want.length === 1 ? 'it' : 'they') +
        ' stood and welded to it at the rim' : 'flat where ' + (want.length === 1 ? 'it' : 'they') + ' stood';
      var txt = 'Lifted ' + r.pieces.length + ' feature' + (r.pieces.length === 1 ? '' : 's') + ' off ' + m.name +
        ' (' + r.volumes.pieces.toFixed(2) + ' mm³): it is ' + where + ', every other triangle as it was, and ' +
        (r.pieces.length === 1 ? 'the new piece is' : 'the new pieces are') + ' on free plate beside it. One Undo (Ctrl+Z) puts it all back.';
      if (r.notes && r.notes.length) txt += ' Note: ' + r.notes.join('; ') + '.';
      var before0 = state.undoStack.length;
      if (typeof NSO_sculptCommitRaw !== 'function' || !NSO_sculptCommitRaw(m, r.plate, 'liftReplace', txt)) {
        takeOff(added);
        return fail('Lift refused - nothing changed: the commit was rejected');
      }
      var rep = state.undoStack.length > before0 ? state.undoStack.pop() : null;
      pushUndo({ type: 'featureSwap', replace: rep, addedIds: added.slice(), removed: [], label: 'Undo: Lift reverted',
        onUndone: afterUndo });

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

      var offBed = spots.filter(function (s) { return !s.onBed; }).length;
      if (offBed) txt += ' ' + offBed + ' did not fit on the bed and sit beside it, clear of every piece.';
      busy = false;
      refresh();
      var left = offered(A(), minH).length;
      say(txt + ' ' + left + ' feature' + (left === 1 ? '' : 's') + ' left on it.', offBed > 0);
      return { ok: true, lift: r, addedIds: added, names: names, hostId: m.id, spots: spots, how: how || 'pick', reason: txt };
    } catch (err) {
      console.error('[lift]', err);
      return fail('Lift failed - nothing changed (' + ((err && err.message) || err) + ')');
    } finally {
      busy = false;
      sync();
    }
  }

  /** The Lift step was undone: the piece is back with its old soup, whose
      features are still in the cache. */
  function afterUndo() {
    pending = new Set(); hoverId = -1; stripOpen = false;
    refresh();
    if (armed) say('Undo: Lift reverted - the piece and its features are back as they were. ' + readout());
  }

  // =========================================================================
  // Drawing: every found feature outlined faintly, the hovered one bright,
  // a Shift group filled
  // =========================================================================

  function ensureLayer() {
    if (!state.scene || typeof THREE === 'undefined') return null;
    if (!layer) { layer = new THREE.Group(); layer.name = 'liftPlate'; layer.renderOrder = 9; }
    if (layer.parent !== state.scene) {
      if (typeof nsoHelpers !== 'undefined') nsoHelpers.attach(state.scene, layer, 'lift-plate');
      else state.scene.add(layer);
    }
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

  /** The outline of a set of triangles: the edges only one of them uses. */
  function outlineOf(P, tris) {
    var seen = new Map(), key = function (o) { return P[o].toFixed(4) + ',' + P[o + 1].toFixed(4) + ',' + P[o + 2].toFixed(4); };
    tris.forEach(function (t) {
      for (var k = 0; k < 3; k++) {
        var a = t * 9 + k * 3, b = t * 9 + ((k + 1) % 3) * 3, ka = key(a), kb = key(b);
        var e = ka < kb ? ka + '|' + kb : kb + '|' + ka, s = seen.get(e);
        if (s) s.n++; else seen.set(e, { n: 1, a: a, b: b });
      }
    });
    var out = [];
    seen.forEach(function (s) { if (s.n === 1) out.push(P[s.a], P[s.a + 1], P[s.a + 2], P[s.b], P[s.b + 1], P[s.b + 2]); });
    return out;
  }

  function lines(arr, colour, opacity) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: colour, transparent: opacity < 1, opacity: opacity, depthTest: false }));
  }
  function fill(P, tris, colour, opacity) {
    var pos = new Float32Array(tris.length * 9);
    tris.forEach(function (t, i) { for (var k = 0; k < 9; k++) pos[i * 9 + k] = P[t * 9 + k]; });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: opacity, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  }

  function draw() {
    if (!ensureLayer()) return;
    clearLayer();
    layer.visible = armed;
    var a = A(), p = targetId != null ? placedOf(targetId) : null;
    if (!armed || !a || !p || !p.mesh) return;
    var P = p.mesh.geometry.attributes.position.array;
    if (P.length !== modelOf(targetId).rawTris.length) return;
    p.mesh.updateMatrixWorld(true);
    layer.matrixAutoUpdate = false;
    layer.matrix.copy(p.mesh.matrixWorld);
    layer.matrixWorldNeedsUpdate = true;
    var off = offered(a, minH), all = [];
    var stripSet = stripOpen ? new Set(stripIds()) : null;
    off.forEach(function (id) { if (id !== hoverId && !pending.has(id)) all = all.concat(a.islands[id].tris); });
    if (all.length) layer.add(lines(outlineOf(P, all), FOUND, stripOpen ? 0.35 : 0.55));
    if (stripSet && stripSet.size) {
      var ticked = [];
      stripSet.forEach(function (id) { ticked = ticked.concat(a.islands[id].tris); });
      layer.add(fill(P, ticked, PENDING, 0.55));
    }
    if (pending.size) {
      var g = [];
      pending.forEach(function (id) { g = g.concat(a.islands[id].tris); });
      layer.add(fill(P, g, PENDING, 0.6));
      layer.add(lines(outlineOf(P, g), PENDING, 1));
    }
    if (hoverId >= 0 && a.islands[hoverId]) {
      var I = a.islands[hoverId], ok = !whyNot(I);
      layer.add(fill(P, I.tris, ok ? HOVER : 0xb91c1c, 0.45));
      layer.add(lines(outlineOf(P, I.tris), ok ? HOVER : 0xef4444, 1));
    }
  }

  // =========================================================================
  // Wiring
  // =========================================================================

  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('lift-plate', {
    live: function () { return armed; },
    close: function () { setArmed(false); },
    clear: clearLayer,
    refresh: function () { draw(); }
  });

  function bind(id, ev, fn) {
    var el = $(id);
    if (el && el.dataset.wired !== '1') { el.dataset.wired = '1'; el.addEventListener(ev, fn); }
  }

  function mount() {
    minH = defaultMin();
    bind('btn-lift', 'click', function () { setArmed(!armed); });
    bind('btn-lift-strip', 'click', function () { openStrip(); });
    bind('btn-lift-strip-go', 'click', function () { confirmStrip(); });
    bind('btn-lift-strip-cancel', 'click', function () { closeStrip(); });
    bind('lift-strip-rows', 'change', function (e) {
      var k = e.target && e.target.getAttribute && e.target.getAttribute('data-group');
      if (k) setStripGroup(k, e.target.checked);
    });
    bind('lift-height', 'input', function () { setMinHeight(parseFloat($('lift-height').value)); });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', function () { if (pending.size) { pending = new Set(); draw(); sync(); } });
    syncSlider();
    sync();
  }

  if (typeof window !== 'undefined') window.nsoLiftTakesClick = takesClick;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }

  return {
    detectSoup: detectSoup,
    viewFor: function (id) { return viewOf(placedOf(id)); },
    groups: groups,
    groupWords: groupWords,
    breakdown: breakdown,
    setArmed: setArmed,
    isArmed: function () { return armed; },
    target: target,
    targetId: function () { return targetId; },
    analysis: A,
    detection: function () { return D ? { ok: D.ok, cached: D.cached, ms: D.ms, seed: D.seed, reason: D.reason } : null; },
    offered: function () { return offered(A(), minH); },
    count: function () { return offered(A(), minH).length; },
    setMinHeight: setMinHeight,
    minHeight: function () { return minH; },
    hover: function () { return hoverId; },
    setHover: setHover,
    pending: function () { return Array.from(pending); },
    lift: lift,
    openStrip: openStrip,
    closeStrip: closeStrip,
    setStripGroup: setStripGroup,
    stripList: stripList,
    confirmStrip: confirmStrip,
    readout: readout,
    layer: function () { return layer; }
  };
})();

if (typeof window !== 'undefined') window.NSO_LIFT_PLATE = NSO_LIFT_PLATE;
