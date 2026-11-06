/* app-extract-bit.js - Extract bit's card side: pick the void, see it, then make it.

   The click is the SELECTION. Extract bit used to guess which void you meant (the biggest), and gave a slotted
   tube from a bolt and a whole blob from a head. Now:

     1. Extract bit arms the click: "click inside the void - on a wall of it, or its bottom".
     2. A click on a piece finds the void THAT click is in (nso_void.js) and makes the bit from it (the real
        boolean, nso_csg.js), and draws that bit in place in amber, the piece turned to a ghost round it: a LIVE PREVIEW of exactly what Make bit
        will bake. Nothing is on the plate yet, and the piece is not touched.
     3. Not the void you meant? Click another wall (it is found again), or move the Lid R slider: all the way left is automatic (the
        smallest ball that closes over the opening); a bigger one reaches across a wider opening, a smaller one stops
        short of the dents next to it. The preview follows the box.
     4. Make bit (or Enter) bakes it: a piece beside the source, one Undo. Only Make bit bakes - the Extract bit button
        arms and disarms. Escape puts the preview away; again, it stops the tool.

   The detection and the bake are extractBitDetect / extractBitCommit in app-join.js. The preview is a helper
   (nso-helpers.js owner 'extract-bit-live'), swept with the others. */
(function () {
  'use strict';
  var armed = false, busy = false, redo = false, pending = null, lastPick = null, seq = 0, timer = 0, raf = 0;
  var preview = null;                      // { group, mesh, pieces: [{ mesh, saved }] }
  var GHOST_OPACITY = 0.22;

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function tick() { return new Promise(function (r) { setTimeout(r, 30); }); }
  /* Lid R is the slider's number; all the way left (0) is automatic. */
  function lidR() {
    var el = $('inp-extract-slider');
    var v = el ? parseFloat(el.value) : NaN;
    return (isFinite(v) && v > 0) ? v : undefined;
  }
  /* True when the user has set a reach - the slider is off its automatic stop, and not merely showing the ball that was used. */
  var manual = false;

  /* ---- Lid R: one slider; all the way left is automatic ---- */
  function slider() { return $('inp-extract-slider'); }
  function showRead(text) { var el = $('extract-r-read'); if (el) el.textContent = text; }
  /* After a detection: the slider's reach fits the piece, and (when automatic) sits where the ball that was used is. */
  function showReach(r) {
    var sl = slider();
    if (sl && r && r.span) {
      var mx = Math.max(2, Math.ceil(1.3 * r.span));
      sl.max = String(mx);
      sl.step = mx > 40 ? '0.5' : '0.1';
      if (!manual) sl.value = String(r.R);          // a script's write: it fires no input event
    }
    showRead(r ? (r.auto ? 'auto - ' : '') + r.R + ' mm' : 'auto');
  }
  function reachChanged() {
    if (!armed || !lastPick) return;
    if (busy) { redo = true; return; }
    clearTimeout(timer);
    timer = setTimeout(function () { if (armed && lastPick) { if (busy) redo = true; else detect(lastPick); } }, 150);
  }

  function syncControls() {
    var btn = $('btn-extract-bit');
    if (btn) {
      btn.setAttribute('aria-pressed', armed ? 'true' : 'false');
      btn.classList.toggle('is-armed', armed);
    }
    var make = $('btn-extract-make');
    if (make) make.hidden = !pending;
  }

  /* ---- the live preview: the piece turns to a ghost and the bit shows inside it, as Hollow's cavity does ---- */
  function ghostOn(mesh) {
    var mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    var saved = { skip: !!mesh.userData.skipXray, mats: mats.map(function (mt) {
      return { mt: mt, transparent: mt.transparent, opacity: mt.opacity, depthWrite: mt.depthWrite, depthTest: mt.depthTest, wireframe: mt.wireframe };
    }) };
    mesh.userData.skipXray = true;
    mats.forEach(function (mt) {
      mt.transparent = true; mt.opacity = GHOST_OPACITY; mt.depthWrite = false; mt.depthTest = true; mt.wireframe = false; mt.needsUpdate = true;
    });
    return saved;
  }
  function ghostOff(mesh, saved) {
    saved.mats.forEach(function (s) {
      s.mt.transparent = s.transparent; s.mt.opacity = s.opacity; s.mt.depthWrite = s.depthWrite;
      s.mt.depthTest = s.depthTest; s.mt.wireframe = s.wireframe; s.mt.needsUpdate = true;
    });
    mesh.userData.skipXray = saved.skip;
  }

  function clearPreview() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (!preview) return;
    var P = preview;
    preview = null;
    if (P.group.parent) P.group.parent.remove(P.group);
    P.mesh.geometry.dispose();
    P.mesh.material.dispose();
    P.pieces.forEach(function (q) { ghostOff(q.mesh, q.saved); });
  }

  function drawPreview(bit) {
    clearPreview();
    if (!state.scene || typeof THREE === 'undefined') return;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bit.soup), 3));
    g.computeVertexNormals();
    var mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0xffb020, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    mesh.renderOrder = 42;
    mesh.userData.skipXray = true;
    var group = new THREE.Group();
    group.userData.skipXray = true;
    group.userData.nsoExtractPreview = true;
    group.add(mesh);
    if (typeof nsoHelpers !== 'undefined') nsoHelpers.attach(state.scene, group, 'extract-bit-live');
    else state.scene.add(group);
    /* Every mesh drawn for this piece goes to a ghost (the plate keeps more than one for a piece). */
    var pieces = [];
    state.scene.traverse(function (o) {
      if (o.isMesh && o.userData && o.userData.sourceId === bit.sourceId && o.userData.placedIndex != null) pieces.push(o);
    });
    preview = { group: group, mesh: mesh, pieces: pieces.map(function (o) { return { mesh: o, saved: ghostOn(o) }; }) };
    /* The preview is of THIS piece in THIS place: if it changes under the ghost, the ghost goes. */
    var p = state.placed[bit.index];
    var stamp = p ? [p.sourceId, p.x, p.z, p.mesh && p.mesh.position.y, p.mesh && p.mesh.geometry] : null;
    (function watch() {
      if (!preview) return;
      var q = state.placed[bit.index];
      var now = q ? [q.sourceId, q.x, q.z, q.mesh && q.mesh.position.y, q.mesh && q.mesh.geometry] : null;
      if (!stamp || !now || stamp.some(function (v, i) { return v !== now[i]; })) { drop('the piece changed - click the void again'); return; }
      raf = requestAnimationFrame(watch);
    })();
  }

  function drop(why) {
    pending = null; lastPick = null; seq++; redo = false;
    if (!manual) showRead('auto');
    clearPreview();
    syncControls();
    if (why) say('Extract bit: ' + why);
  }

  /* ---- finding the void for one pick ---- */
  async function detect(pick) {
    var my = ++seq;
    busy = true;
    pending = null; syncControls();
    say('Finding the void…');
    await tick();                                 // let the words reach the screen before the page thread is busy
    var r;
    try { r = await extractBitDetect(pick.index, pick.point, pick.normal, { R: lidR() }); }
    catch (err) { console.error('[extract-bit]', err); r = { ok: false, reason: (err && err.message) || String(err) }; }
    busy = false;
    if (my !== seq) return r;                     // a newer click or Escape has taken over
    if (redo && armed && lastPick) { redo = false; return detect(lastPick); }   // Lid R moved while this one ran: draw the latest
    if (!r.ok) {
      clearPreview();
      say(r.cancelled ? 'Extract stopped - nothing changed' : 'Extract failed - ' + r.reason + ' - click another wall instead.', !r.cancelled);
      syncControls();
      return r;
    }
    pending = r;
    showReach(r);
    drawPreview(r);
    syncControls();
    say('Extract bit preview - the amber is the void you clicked (' + Math.round(r.volumeMm3) + ' mm3, lid R ' + r.R + ' mm' +
        (r.auto ? ' auto' : '') + '). Make bit to bake it; click another wall to choose again; Lid R changes its reach; Esc cancels.');
    return r;
  }

  function make() {
    if (!pending) return false;
    var bit = pending;
    if (!extractBitCommit(bit)) return false;
    drop(null);
    setArmed(false, true);
    return true;
  }

  function setArmed(on, quiet) {
    armed = !!on;
    if (!armed) {
      drop(null);
      manual = false;                              // the next time starts on automatic
      var sl0 = slider(); if (sl0) sl0.value = '0';
      showRead('auto');
    }
    syncControls();
    if (armed) say('Extract bit - click inside the void you want: a wall of it, or its bottom. It is shown before it is made. Escape stops.');
    else if (!quiet) say('Extract bit off');
  }

  /* The button arms and disarms, and nothing else: only Make bit (or Enter) bakes, so a second press of the button never
     makes a bit the user was still looking at. */
  function press() {
    setArmed(!armed);
    return Promise.resolve(armed);
  }

  /* ---- the click ---- */
  function hitPiece(event) {
    if (!state.renderer || !state.camera || !state.modelGroup) return null;
    if (typeof setPointerFromEvent === 'function') setPointerFromEvent(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    var hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].faceIndex == null || !hits[i].face) continue;
      var obj = hits[i].object;
      if (obj.userData && obj.userData.nsoExtractPreview) continue;
      while (obj && (!obj.userData || obj.userData.placedIndex == null) && obj.parent) obj = obj.parent;
      var idx = (obj && obj.userData) ? obj.userData.placedIndex : undefined;
      if (typeof idx === 'number' && state.placed[idx] && state.placed[idx].sourceId != null) {
        return { hit: hits[i], index: idx };
      }
    }
    return null;
  }

  /* The tool lives on the Subtract card: it is armed only while that card is open. */
  function cardOpen() { var d = $('menu-bit'); return !d || !!d.open; }

  /* app-core's onCanvasPointerDown asks this before it starts a move drag - the contract paint, carve and attach keep. */
  window.nsoExtractTakesClick = function (event) {
    if (!armed || !event || event.button !== 0) return false;
    /* The card was shut some way this file did not hear of (a double click on its button, another card opening over it):
       stand down at once, so the click moves the piece instead of scanning for a void. */
    if (!cardOpen()) { setArmed(false, true); return false; }
    var t = hitPiece(event);
    if (!t) return false;
    if (busy) { say('Extract bit: still finding the last void - one at a time', true); return true; }
    if (typeof selectPlaced === 'function') selectPlaced(t.index);
    var n = t.hit.face.normal.clone().transformDirection(t.hit.object.matrixWorld).normalize();
    lastPick = { index: t.index, point: [t.hit.point.x, t.hit.point.y, t.hit.point.z], normal: [n.x, n.y, n.z] };
    detect(lastPick);
    return true;
  };

  /* The same call the click makes, for the drive checks and anything else that has a point and a normal. */
  window.nsoExtractBit = {
    press: press,
    armed: function () { return armed; },
    pending: function () { return pending; },
    previewShown: function () { return !!preview; },
    pick: function (pick) { if (!armed) setArmed(true); lastPick = pick; return detect(pick); },
    make: function () { return make(); },
    cancel: function () { setArmed(false); }
  };

  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('extract-bit-live', {
    live: function () { return !!preview; },
    close: function () { drop(null); },
    clear: function () { clearPreview(); pending = null; syncControls(); },
    refresh: function () { }
  });

  function wire() {
    var make2 = $('btn-extract-make');
    if (make2 && !make2.dataset.nsoWired) { make2.dataset.nsoWired = '1'; make2.addEventListener('click', make); }
    var sl = slider();
    if (sl && !sl.dataset.nsoWired) {
      sl.dataset.nsoWired = '1';
      sl.addEventListener('input', function () {
        var v = parseFloat(sl.value);
        manual = isFinite(v) && v > 0;
        showRead(manual ? v + ' mm' : 'auto');
        reachChanged();
      });
    }
    /* Escape: the preview first, then the tool. Enter makes the bit - but not out of a box someone is typing in. */
    window.addEventListener('keydown', function (e) {
      if (!armed) return;
      if (e.key === 'Escape') {
        if (pending || preview) { drop('preview put away - click inside a void'); } else setArmed(false);
      } else if (e.key === 'Enter' && pending && !(e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))) {
        e.preventDefault(); make();
      }
    });
    /* Shutting the Subtract card, by whatever route, ends it: an armed tool nobody can see would take every click on a piece. */
    var card = $('menu-bit');
    if (card && !card.dataset.nsoExtractWired) {
      card.dataset.nsoExtractWired = '1';
      card.addEventListener('toggle', function () { if (!card.open && armed) setArmed(false, true); });
    }
    /* Another tool's button ends this one: its click would otherwise be taken here, under it. */
    document.addEventListener('click', function (e) {
      if (!armed || !e.target || !e.target.closest) return;
      var b = e.target.closest('button, summary');
      if (b && b.id !== 'btn-extract-bit' && b.id !== 'btn-extract-make') setArmed(false, true);
    }, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
})();
