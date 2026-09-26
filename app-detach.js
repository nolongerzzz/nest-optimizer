/* app-detach.js - Detach a detected flange from a piece, and Reattach it
 * somewhere else. The app layer over nso_detach.js.
 *
 * Cut menu, below Crop. Two buttons:
 *
 *   Detach flange   on the cutter's piece. NSO_Flange.detect finds the flange,
 *                   NSO_Detach.detach caps the piece on its own neck wall and
 *                   lifts the flange out whole. The piece keeps its place and
 *                   its id and becomes the hull. The flange lands on the plate
 *                   beside it as its own piece, "<name> - Flange", a real one
 *                   (export it, move it, check it). One Undo puts both back.
 *   Reattach        arms a click, like Attach. Click the point on a piece
 *                   where the flange's root should go. The flange keeps lying
 *                   the way it lay (its plate normal is kept) and reaches out
 *                   of the clicked face as squarely as a flat plate can: the
 *                   face normal with its part along the plate normal taken
 *                   out. Assemble's attach seats it (rim gap + one extrusion
 *                   line, length kept), app-join.js's union joins it, and the
 *                   flange piece is used up. One Undo puts both back.
 *
 * Thin on purpose, like app-assemble.js. Every measurement is in
 * nso_detach.js / nso_assemble.js (THREE-free, node-tested: npm run
 * detach:test). The union is app-join.js's, the commit is app-sculpt.js's,
 * the click -> raw-frame mapping is app-assemble.js's (nsoAttachRawPick).
 *
 * PAINT SCOPE: WHOLE-PIECE, for both, per the scoping rule in docs/HANDOFF.md.
 * Detach hands back a hull that is a new soup: every triangle has been
 * through rawCut's weld and, on a wall that steps, through the seal. The
 * flange is a new piece. No face of the old piece survives as itself to
 * carry its paint. Reattach's union replaces every triangle of the piece it
 * lands on, exactly as Attach's does. nsoMaskCount(m) > 0 stands either down
 * and names the count.
 */
(function () {
  'use strict';

  var busy = false;

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function readout(msg) { var el = $('detach-readout'); if (el) el.textContent = msg; }
  function fail(reason) { say(reason, true); readout(reason); return { ok: false, reason: reason }; }

  function modelById(id) { return state.models.find(function (x) { return x && x.id === id; }) || null; }

  /* The piece Reattach puts back: the one selected on the plate if it is a
     detached flange, else the newest detached flange still in the model list
     (an Undo of a Reattach puts one back, carrying its mark). */
  function detachedModel() {
    var sel = (state.selectedIndex >= 0 && state.placed[state.selectedIndex]) ? state.placed[state.selectedIndex] : null;
    var m = sel ? modelById(sel.sourceId) : null;
    if (m && m.detached) return m;
    for (var i = state.models.length - 1; i >= 0; i--) if (state.models[i] && state.models[i].detached) return state.models[i];
    return null;
  }

  function refresh() {
    var rb = $('btn-reattach');
    if (rb) rb.disabled = !detachedModel() && !state.reattachArmed;
  }

  /* Take pieces off the plate and out of the model list, keeping what Undo
     needs to put each back where it was. No undo step of its own. */
  function takeOff(ids) {
    var drop = new Set(ids), removed = [];
    state.placed.forEach(function (p, i) { if (p && drop.has(p.sourceId)) removed.push({ placed: p, placedIndex: i }); });
    removed.forEach(function (r) {
      r.model = modelById(r.placed.sourceId);
      r.modelIndex = state.models.indexOf(r.model);
    });
    state.placed = state.placed.filter(function (p) { return !(p && drop.has(p.sourceId)); });
    state.models = state.models.filter(function (m) { return !drop.has(m.id); });
    removed.forEach(function (r) { if (r.placed.mesh && r.placed.mesh.parent) r.placed.mesh.parent.remove(r.placed.mesh); });
    state.placed.forEach(function (p, i) { if (p.mesh) p.mesh.userData.placedIndex = i; });
    state.selectedIndex = -1;
    return removed;
  }

  /* NSO_sculptCommitRaw pushes its own replace step. Detach and Reattach
     each change TWO things (one piece's geometry, and a piece added or used
     up), so that step is taken back off the stack and folded into one
     'featureSwap' step, which app-core's undoLast undoes as one. */
  function commitSwap(m, soup, undoType, txt, extra) {
    if (typeof NSO_sculptCommitRaw !== 'function') return false;
    var before = state.undoStack.length;
    if (!NSO_sculptCommitRaw(m, soup, undoType, txt)) return false;
    var rep = state.undoStack.length > before ? state.undoStack.pop() : null;
    extra.replace = rep;
    extra.type = 'featureSwap';
    pushUndo(extra);
    return true;
  }

  /* ------------------------------------------------------------ Detach */

  window.nsoDetachRun = function (modelId) {
    if (busy) return { ok: false, reason: 'busy' };
    if (typeof NSO_Flange === 'undefined' || typeof NSO_Detach === 'undefined') {
      return fail('Detach needs nso_flange.js and nso_detach.js');
    }
    var m = modelId != null ? modelById(modelId) : ((typeof getActiveModel === 'function') ? getActiveModel() : null);
    if (!m) return fail('Detach: open the cutter and select a piece first');
    if (!(m.rawTris && m.rawAxis === 'zup' && m.rawTris.length >= 36)) {
      return fail('Detach needs a raw piece - "' + m.name + '" has no untransformed soup');
    }
    /* PAINT SCOPE: WHOLE-PIECE - see the header. */
    var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (painted > 0) {
      return fail('Detach stood down - ' + painted + ' painted face(s); the hull is a new soup and ' +
        'cannot hold a face still. Clear paint to detach.');
    }
    busy = true;
    try {
      var det = NSO_Flange.detect(m.rawTris);
      if (!det.flanges.length) return fail('Detach: nothing to detach - ' + NSO_Flange.describe(det));
      var r = NSO_Detach.detach(m.rawTris, det.flanges[0]);
      if (!r.ok) return fail('Detach refused - piece unchanged: ' + r.reason);

      /* The in-page transcription of the canonical checker, as Crop gates. */
      var ch = (typeof NSO_cropCensus === 'function') ? NSO_cropCensus(r.hull) : null;
      var cf = (typeof NSO_cropCensus === 'function') ? NSO_cropCensus(r.piece.soup) : null;
      if (!ch || !cf) return fail('Detach unavailable - the mesh checker (NSO_Repair) is not loaded; piece unchanged');
      if (ch.open || ch.nm || ch.degen || cf.open || cf.nm || cf.degen) {
        return fail('Detach refused - piece unchanged (checker: hull open ' + ch.open + ' nm ' + ch.nm +
          ', flange open ' + cf.open + ' nm ' + cf.nm + ')');
      }

      var placed = state.placed.find(function (p) { return p && p.sourceId === m.id; });
      var name = (m.name || 'piece') + ' - Flange';
      var geo = rawResultToDisplayGeometry(r.piece.soup);
      var txt = r.reason;

      /* The flange first, so a failure to add it leaves the piece alone. */
      var id = addModel(name, geo, {
        rawTris: r.piece.soup, rawAxis: 'zup', centerOffset: computeCenterOffsetFromRaw(r.piece.soup),
        keepSelection: true, silent: true
      });
      if (id == null) return fail('Detach refused - piece unchanged: the flange is too small to be a piece');
      var made = modelById(id);
      made.detached = { piece: r.piece, fromId: m.id, fromName: m.name, raw: made.rawTris };

      if (!commitSwap(m, r.hull, 'detachReplace', txt,
                      { addedIds: [id], removed: [], label: 'Undo: Detach reverted' })) {
        takeOff([id]);
        return fail('Detach refused - piece unchanged: the commit was rejected');
      }
      if (placed && made) {
        var x = placed.x + (placed.width || m.size.x) / 2 + made.size.x / 2 + 6;
        placeModelMovable(made, x, placed.z);
      }
      if (typeof renderModelList === 'function') renderModelList();
      if (typeof updateAdjustUI === 'function') updateAdjustUI();
      say(txt);
      readout('Detached: ' + name + ' (' + r.volumes.piece.toFixed(1) + ' mm³). Reattach puts it back elsewhere.');
      refresh();
      return { ok: true, detach: r, flangeId: id, hullId: m.id, reason: txt };
    } catch (err) {
      console.error('[detach]', err);
      return fail('Detach failed - nothing changed (' + ((err && err.message) || err) + ')');
    } finally {
      busy = false;
    }
  };

  /* ---------------------------------------------------------- Reattach */

  function setArmed(on) {
    state.reattachArmed = !!on;
    var btn = $('btn-reattach');
    if (btn) {
      btn.setAttribute('aria-pressed', state.reattachArmed ? 'true' : 'false');
      btn.classList.toggle('is-armed', state.reattachArmed);
    }
    refresh();
    if (!state.reattachArmed) { say('Reattach off'); return; }
    if (!detachedModel()) { state.reattachArmed = false; refresh(); fail('Reattach: detach a flange first'); return; }
    /* Disarm the other click-owning modes by their own buttons, as Attach does. */
    if (state.attachArmed) { var ab = $('btn-stock-attach'); if (ab) ab.click(); else state.attachArmed = false; }
    if (state.maskPaint) {
      var pb = $(state.maskPaint === 'select' ? 'btn-mask-select' : 'btn-mask-paint');
      if (pb) pb.click();
    }
    if (state.carveArmed) { var cb = $('btn-carve'); if (cb) cb.click(); else state.carveArmed = false; }
    if (state.measureOn) { var mb = $('btn-measure'); if (mb) mb.click(); else state.measureOn = false; }
    if (state.seatHereArmed && typeof window.nsoSeatHereDisarm === 'function') window.nsoSeatHereDisarm();
    say('Reattach armed - click the point on a piece where the flange\'s root should go. ' +
        'Click Reattach again to stop.');
  }

  function hitPiece(event, skipId) {
    if (!state.renderer || !state.camera || !state.modelGroup) return null;
    if (typeof setPointerFromEvent === 'function') setPointerFromEvent(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    var hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].faceIndex == null || !hits[i].face) continue;
      var obj = hits[i].object;
      while (obj && (!obj.userData || obj.userData.placedIndex == null) && obj.parent) obj = obj.parent;
      var idx = (obj && obj.userData) ? obj.userData.placedIndex : undefined;
      if (typeof idx === 'number' && state.placed[idx] && state.placed[idx].sourceId != null &&
          state.placed[idx].sourceId !== skipId) {
        return { hit: hits[i], index: idx, placed: state.placed[idx] };
      }
    }
    return null;
  }

  /* app-core's onCanvasPointerDown asks this with Attach, before a move drag. */
  window.nsoReattachTakesClick = function (event) {
    if (!state.reattachArmed || !event || event.button !== 0) return false;
    var fm = detachedModel();
    var t = hitPiece(event, fm ? fm.id : null);
    if (!t) return false;
    if (busy) { say('Reattach: the last one is still running', true); return true; }
    var n = t.hit.face.normal;
    window.nsoReattachAt(t.placed, [t.hit.point.x, t.hit.point.y, t.hit.point.z], [n.x, n.y, n.z], null);
    return true;
  };

  /* One reattach, through the same path the click takes. Exposed so the drive
     check runs it rather than a copy. overrides: { dir, up } in the target
     piece's raw frame, for a caller that knows them. */
  window.nsoReattachAt = function (placed, worldPoint, localNormal, overrides) {
    if (busy) return Promise.resolve({ ok: false, reason: 'busy' });
    busy = true;
    return runReattach(placed, worldPoint, localNormal, overrides || {})
      .catch(function (err) {
        console.error('[reattach]', err);
        return fail('Reattach failed - nothing changed (' + ((err && err.message) || err) + ')');
      })
      .then(function (r) { busy = false; refresh(); return r; });
  };

  async function runReattach(placed, worldPoint, localNormal, ov) {
    if (typeof NSO_Detach === 'undefined' || typeof NSO_Assemble === 'undefined') return fail('Reattach needs nso_detach.js and nso_assemble.js');
    if (typeof NSO_unionSoups !== 'function') return fail('Reattach needs app-join.js for the union');
    if (typeof window.nsoAttachRawPick !== 'function') return fail('Reattach needs app-assemble.js for the click mapping');
    var fm = detachedModel();
    if (!fm) return fail('Reattach: detach a flange first');
    if (fm.rawTris !== fm.detached.raw) {
      return fail('Reattach: "' + fm.name + '" was changed after it was detached - Reattach puts back the ' +
        'piece Detach made');
    }
    if (!placed || placed.sourceId == null) return fail('Reattach: nothing was clicked');
    var m = modelById(placed.sourceId);
    if (!m || m.id === fm.id) return fail('Reattach: click the piece the flange should go on, not the flange');
    if (!(m.rawTris && m.rawAxis === 'zup' && m.rawTris.length >= 9)) {
      return fail('Reattach needs a raw piece - "' + m.name + '" has no untransformed soup');
    }
    /* PAINT SCOPE: WHOLE-PIECE - see the header. */
    var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (painted > 0) {
      return fail('Reattach stood down - ' + painted + ' painted face(s); the union replaces every ' +
        'triangle on the piece and cannot hold a face still. Clear paint to reattach.');
    }
    var pick = window.nsoAttachRawPick(m, placed.mesh, worldPoint, localNormal);
    if (pick.error) return fail(pick.error);

    var piece = fm.detached.piece;
    var up = ov.up || piece.frame.up;
    var dir = ov.dir;
    if (!dir) {
      /* Out of the clicked face, as squarely as a flat plate can: the face
         normal with its part along the plate's normal taken out. */
      var n = pick.dir, a = n[0] * up[0] + n[1] * up[1] + n[2] * up[2];
      dir = [n[0] - a * up[0], n[1] - a * up[1], n[2] - a * up[2]];
      var L = Math.hypot(dir[0], dir[1], dir[2]);
      if (L < 0.2) {
        return fail('Reattach refused - nothing changed: that face faces along the flange\'s own plate normal, ' +
          'so a flat plate cannot come out of it. Click a side face.');
      }
      dir = [dir[0] / L, dir[1] / L, dir[2] / L];
    }

    var r = NSO_Detach.reattach(m.rawTris, piece, { at: pick.at, dir: dir, up: up });
    if (!r.ok) return fail('Reattach refused - nothing changed: ' + r.reason);

    say('Reattaching (loading CSG kernel)...');
    var u = await NSO_unionSoups(m.rawTris, r.soup);
    if (!u.ok || !u.soup || u.soup.length < 9 || (u.parts != null && u.parts !== 1)) {
      return fail('Reattach refused - nothing changed: the union ' + (u.reason ? '- ' + u.reason : 'missed') +
        (u.parts > 1 ? ' (' + u.parts + ' parts)' : ''));
    }
    var fin = NSO_Detach.finishUnion(u.soup);
    if (!fin.ok) return fail('Reattach refused - nothing changed: ' + fin.reason);
    var chk = NSO_Detach.unionCheck(m.rawTris, r.soup, fin.soup, r, piece);
    if (!chk.ok) return fail('Reattach refused - nothing changed: ' + chk.reason);
    var cc = (typeof NSO_cropCensus === 'function') ? NSO_cropCensus(fin.soup) : null;
    if (!cc) return fail('Reattach unavailable - the mesh checker (NSO_Repair) is not loaded; nothing changed');
    if (cc.open || cc.nm || cc.degen) {
      return fail('Reattach refused - nothing changed (checker: open ' + cc.open + ', non-manifold ' + cc.nm +
        ', degenerate ' + cc.degen + ')');
    }

    var txt = 'Reattached ' + fm.name + ' - seated ' + r.engageMm.toFixed(3) + ' mm (' +
      r.rootGapMm.toFixed(3) + ' mm rim gap + ' + (r.marginMm == null ? 'as asked' : r.marginMm.toFixed(2) + ' mm floor') +
      '), ' + r.exposedLengthMm.toFixed(2) + ' mm proud' + (r.keptLength ? ', full length' : '') + '; ' +
      chk.reason + '; ' + (fin.soup.length / 9) + ' tris, 0 open / 0 non-manifold';
    if (r.growWarning) txt += ' - ' + r.growWarning;

    var removed = takeOff([fm.id]);
    if (!commitSwap(m, fin.soup, 'reattachReplace', txt,
                    { addedIds: [], removed: removed, label: 'Undo: Reattach reverted' })) {
      removed.forEach(function (x) {
        state.models.splice(Math.min(x.modelIndex, state.models.length), 0, x.model);
        state.placed.splice(Math.min(x.placedIndex, state.placed.length), 0, x.placed);
        if (x.placed.mesh && state.modelGroup) state.modelGroup.add(x.placed.mesh);
      });
      state.placed.forEach(function (p, i) { if (p.mesh) p.mesh.userData.placedIndex = i; });
      return fail('Reattach refused - nothing changed: the commit was rejected');
    }
    if (typeof renderModelList === 'function') renderModelList();
    if (typeof updateOptimizeButton === 'function') updateOptimizeButton();
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    if (state.reattachArmed) setArmed(false);
    say(txt);
    readout(txt);
    return { ok: true, attach: r, union: { parts: u.parts, tris: fin.soup.length / 9 }, check: chk,
             modelId: m.id, flangeId: fm.id, reason: txt };
  }

  function bind(id, ev, fn) {
    var el = $(id);
    if (!el || el.dataset.nsoWired === '1') return;
    el.dataset.nsoWired = '1';
    el.addEventListener(ev, fn);
  }

  function wire() {
    bind('btn-detach', 'click', function () { window.nsoDetachRun(); });
    bind('btn-reattach', 'click', function () { setArmed(!state.reattachArmed); });
    refresh();
  }
  window.nsoDetachRefresh = refresh;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
