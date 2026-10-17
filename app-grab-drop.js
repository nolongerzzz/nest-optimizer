/* ============================================================
   app-grab-drop.js - GRAB AND DROP, and the floating state.
   After app-core.js (the move drag it rides on), app-seat-surface.js
   (NSO_seatPieceAt) and nso-helpers.js.

   GRAB. A press on any piece and a drag (past SLOP pixels - a click is
   still a click) carries it: it follows the pointer over the scene, the
   piece itself looked through. Where it is let go decides where it lands:

     over a piece    it SEATS onto that surface at the point under the
                     pointer, outside it, at the Seat gap - Seat here's own
                     seat (NSO_seatPieceAt: the same plan, the same gap rule,
                     the same paint scope, the same refusals). The piece a
                     lifted feature came off is a piece like any other.
     over the plate  it lands on the plate at that point (To plate): the
                     plate half of the drag is app-core's move drag, grid
                     snap, neighbour magnet and fence lines included.
     over nothing    it stays where it was let go, in the air, and is still
                     grabbable.

   Escape mid-drag puts it back where it was. Each drop is ONE Undo - the
   pose it was carried from (a posePlaced step, or for a seat that has to
   turn the piece the seat's own geometry step with that pose on it). A drop
   places; it never fuses - Join stays the deliberate step.

   Refused in words, and the piece goes back: a drop onto a support piece
   (a support is generated for its host and is not somewhere to stand
   anything), and a drop onto itself.

   FLOATING IS A STATE. A piece in the air carries how far up it is as
   liftY - the record every exporter already writes (buildCombinedGeometry,
   the 3MF build and scene block) - and the invariant this file keeps is
   the one settlePlacedOnBed reads: the piece's lowest point is 0.2 + liftY.
   Move's nudges (applyPlacedXZ -> settlePlacedOnBed), the vertical slider
   and arrows, Rotate, Tip (applyMeshRotation) and Seat here all keep it, so
   nothing brings a floating piece down except To plate or a drop onto the
   plate. Lift lands a lifted feature where it stood (app-lift-plate.js),
   which is in the air whenever it stood on top of something.

   PAINT SCOPE: none of its own. A drop over the plate or into the air is a
   move. A drop onto a piece is NSO_seatPieceAt, whose scope is Seat here's
   (whole-piece on the carried piece, and only when the seat has to turn
   it) - stated in app-seat-surface.js and docs/SEAT-SURFACE.md.
   ============================================================ */
(function () {
  'use strict';

  var SLOP = 3;                 // px a press travels before it is a drag
  var BED = 0.2;                // the bed baseline every piece is squared onto
  var OK = 0x22c55e, BAD = 0xef4444;

  var g = null;                 // the grab in progress
  var layer = null;

  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function modelOf(q) {
    return q ? (state.models || []).find(function (m) { return m && m.id === q.sourceId; }) || null : null;
  }
  function nameOf(q) { var m = modelOf(q); return '"' + ((m && m.name) || (q && q.name) || 'piece') + '"'; }
  function isSupport(q) { var m = modelOf(q); return !!(m && m.nsoSupport); }
  function f2(x) { return (+x).toFixed(2); }

  function ray(ev) {
    setPointerFromEvent(ev);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    return state.raycaster;
  }

  /** The piece's lowest point, as drawn. */
  function bottomOf(p) { p.mesh.updateMatrixWorld(true); return meshLocalBox3(p.mesh).min.y; }

  /** liftY from where the piece is drawn: the floating state's one rule. */
  function recordHeight(p) {
    var b = bottomOf(p);
    if (b < BED) { p.mesh.position.y += BED - b; p.mesh.updateMatrixWorld(true); b = BED; }
    p.liftY = b - BED > 1e-6 ? b - BED : 0;
    return p.liftY;
  }

  function placeAt(p, pos) {
    p.mesh.position.copy(pos);
    p.mesh.updateMatrixWorld(true);
    recordHeight(p);
    p.x = p.mesh.position.x; p.z = p.mesh.position.z;
    if (typeof refreshOutline === 'function') refreshOutline(p);
  }

  /** Put the carried piece back exactly as it was picked up - the
      posePlaced Undo, without the Undo. */
  function restore(G) {
    var e = G.from, p = G.p;
    if (!e || !p) return;
    p.x = e.x; p.z = e.z;
    p.rotY = e.rotY || 0; p.flipX = !!e.flipX;
    p.tipX = e.tipX || 0; p.tipZ = e.tipZ || 0;
    p.tiltX = e.tiltX || 0; p.tiltZ = e.tiltZ || 0;
    p.liftY = e.liftY || 0;
    p.width = e.width; p.depth = e.depth; p.height = e.height;
    if (p.mesh) {
      applyMeshRotation(p);
      if (typeof refreshOutline === 'function') refreshOutline(p);
    }
    applyPlacedXZ(p, p.x, p.z);
    restoreMeshY(p, e.meshY);
  }

  // ---------------------------------------------------------------- what is under the pointer

  /** The nearest other piece under the pointer, else the bed, else nothing.
      The carried piece is looked through. */
  function under(ev) {
    var rc = ray(ev), self = g && g.p;
    var kids = state.modelGroup ? state.modelGroup.children.filter(function (c) { return !self || c !== self.mesh; }) : [];
    var hits = nsoHelpers.pieceHits(rc.intersectObjects(kids, false));
    var piece = null;
    for (var i = 0; i < hits.length; i++) {
      var idx = hits[i].object.userData.placedIndex, q = typeof idx === 'number' ? state.placed[idx] : null;
      if (q && q.mesh === hits[i].object && q.sourceId != null && hits[i].face) { piece = { placed: q, hit: hits[i] }; break; }
    }
    var bed = state.plateMesh ? rc.intersectObject(state.plateMesh, false)[0] : null;
    if (piece && (!bed || piece.hit.distance <= bed.distance)) {
      var n = piece.hit.face.normal.clone().transformDirection(piece.hit.object.matrixWorld).normalize();
      return { kind: 'piece', placed: piece.placed, point: piece.hit.point.clone(), normal: n };
    }
    if (bed) return { kind: 'plate', point: bed.point.clone() };
    return { kind: 'air' };
  }

  // ---------------------------------------------------------------- the helper: the target boxed, the drop point marked

  function ensureLayer() {
    if (!state.scene) return null;
    if (!layer) { layer = new THREE.Group(); layer.name = 'grabDrop'; layer.renderOrder = 9; }
    if (layer.parent !== state.scene) nsoHelpers.attach(state.scene, layer, 'grab-drop');
    return layer;
  }
  /* Empty AND out of the scene. The group used to stay on screen after the
     drag that drew in it, empty, and Watch named it a phantom - "a grab-drop
     helper is still on screen" - because the session behind it had ended.
     It is put back (ensureLayer) by the next drawTarget, and by nothing else:
     a drag that never went over a piece never has a helper. */
  function clearLayer() {
    if (!layer) return;
    for (var i = layer.children.length - 1; i >= 0; i--) {
      var c = layer.children[i];
      layer.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
    if (layer.parent) layer.parent.remove(layer);
  }
  function drawTarget(u, bad) {
    if (!ensureLayer()) return;
    clearLayer();
    if (!u) return;
    var col = bad ? BAD : OK;
    var box = meshLocalBox3(u.placed.mesh);
    var bh = new THREE.Box3Helper(box, col);
    bh.material.depthTest = false; bh.material.transparent = true;
    var dot = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 12),
      new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.9 }));
    dot.position.copy(u.point);
    layer.add(bh); layer.add(dot);
    nsoHelpers.attach(state.scene, layer, 'grab-drop');
  }

  // ---------------------------------------------------------------- the drag

  /** app-core's startMoveDrag, once the drag has started. */
  function begin(p, idx, ev) {
    g = null;
    if (!p || !p.mesh) return false;
    var rc = ray(ev);
    p.mesh.updateMatrixWorld(true);
    var hit = rc.intersectObject(p.mesh, false)[0];
    var at = hit ? hit.point.clone() : meshLocalBox3(p.mesh).getCenter(new THREE.Vector3());
    g = {
      p: p, idx: idx, from: snapshotPlacedPose(idx),
      x0: ev.clientX, y0: ev.clientY, live: false, mode: null,
      grabOff: p.mesh.position.clone().sub(at), plane: null, over: null, cancelled: false, said: ''
    };
    return true;
  }

  function tell(key, msg, bad) { if (g.said !== key) { g.said = key; say(msg, bad); } }

  /** app-core's dragMovePlaced asks this first. true: handled here (still
      inside the slop, over a piece, over nothing). false: over the plate -
      app-core's move drag places it there. */
  function move(ev) {
    if (!g) return false;
    if (!g.live) {
      if (Math.hypot(ev.clientX - g.x0, ev.clientY - g.y0) < SLOP) return true;
      g.live = true;
    }
    var p = g.p, u = under(ev);
    if (u.kind === 'plate') {
      g.mode = 'plate'; g.over = null; g.plane = null;
      clearLayer();
      p.liftY = 0;                     // the plate drag settles it onto the bed
      tell('plate', 'Over the plate - let go to set ' + nameOf(p) + ' down there. Esc puts it back.');
      return false;
    }
    if (u.kind === 'piece') {
      g.mode = 'piece'; g.over = u; g.plane = null;
      var bad = isSupport(u.placed);
      drawTarget(u, bad);
      /* Shown resting off the surface along its normal; the seat itself is
         worked out on release, on the real surfaces. */
      var box = meshLocalBox3(p.mesh), c = box.getCenter(new THREE.Vector3()), h = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      var n = u.normal, reach = Math.abs(n.x) * h.x + Math.abs(n.y) * h.y + Math.abs(n.z) * h.z;
      var want = u.point.clone().addScaledVector(n, reach + 0.2);
      placeAt(p, p.mesh.position.clone().add(want.sub(c)));
      if (bad) tell('sup' + u.placed.sourceId, nameOf(u.placed) + ' is a support piece - nothing is dropped onto a support. Let go and ' + nameOf(p) + ' goes back.', true);
      else {
        var gap = typeof readSeatGapInput === 'function' ? readSeatGapInput() : NaN;
        tell('on' + u.placed.sourceId, 'Over ' + nameOf(u.placed) + ' - let go to seat ' + nameOf(p) + ' there' +
          (isFinite(gap) ? ' at the Seat gap (' + NSO_formatSeatGap(gap) + ')' : '') + '. Esc puts it back.');
      }
      return true;
    }
    // nothing under it: it follows the pointer on a plane square to the view,
    // through the point it was grabbed by
    g.mode = 'air'; g.over = null;
    clearLayer();
    var rc = state.raycaster;
    if (!g.plane) {
      var grabAt = p.mesh.position.clone().sub(g.grabOff), dir = new THREE.Vector3();
      state.camera.getWorldDirection(dir);
      g.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir.negate(), grabAt);
    }
    var hitP = new THREE.Vector3();
    if (rc.ray.intersectPlane(g.plane, hitP)) placeAt(p, hitP.add(g.grabOff));
    tell('air', 'Over nothing - let go to leave ' + nameOf(p) + ' in the air where it is. Esc puts it back.');
    return true;
  }

  /** app-core's endMoveDrag. { handled: true } when the drop was done here
      (its Undo and its words); otherwise app-core finishes a plate drag. */
  function end() {
    if (!g) return null;
    var G = g, p = G.p;
    g = null;
    clearLayer();
    if (G.cancelled) {
      restore(G);
      say('Put back - ' + nameOf(p) + ' is where it was picked up. Nothing changed.');
      return { handled: true, mode: 'cancel' };
    }
    if (!G.live) return { handled: false, mode: 'none', from: G.from };
    if (G.mode === 'plate' || !G.mode) return { handled: false, mode: 'plate', from: G.from };
    if (G.mode === 'air') {
      pushUndo(G.from);
      say(nameOf(p) + ' left in the air, ' + f2(p.liftY) + ' mm over the bed - it stays there; grab it again, or To plate ' +
        'brings it down. One Undo (Ctrl+Z) puts it back.');
      return { handled: true, mode: 'air', liftY: p.liftY };
    }
    // over a piece: back to where it came from first, so the seat's one Undo
    // returns it there
    var T = G.over && G.over.placed;
    restore(G);
    if (!T) return { handled: true, mode: 'piece', ok: false };
    if (T === p) {
      say('That is ' + nameOf(p) + ' itself - a piece cannot be dropped onto itself. It is back where it was.', true);
      return { handled: true, mode: 'piece', ok: false, reason: 'itself' };
    }
    if (isSupport(T)) {
      say(nameOf(T) + ' is a support piece - nothing is dropped onto a support. ' + nameOf(p) + ' is back where it was.', true);
      return { handled: true, mode: 'piece', ok: false, reason: 'support' };
    }
    if (typeof window.NSO_seatPieceAt !== 'function') {
      say('Dropping onto a piece needs app-seat-surface.js - ' + nameOf(p) + ' is back where it was.', true);
      return { handled: true, mode: 'piece', ok: false, reason: 'no seat' };
    }
    var pt = G.over.point;
    var r = window.NSO_seatPieceAt(T, [pt.x, pt.y, pt.z], p, { undoType: 'dropSeatReplace' },
      { verb: 'Drop', a: nameOf(T), b: nameOf(p), seated: 'Dropped onto ' + nameOf(T) + ': seated' });
    if (r && r.ok && r.applied) {
      if (typeof refreshOutline === 'function') refreshOutline(p);
      say(r.applied.status + '. One Undo (Ctrl+Z) puts it back.');
      return { handled: true, mode: 'piece', ok: true, onto: T.sourceId, seat: r };
    }
    // the seat said why; the piece is where it was picked up
    return { handled: true, mode: 'piece', ok: false, reason: r && r.reason, seat: r };
  }

  /** Escape mid-drag: put it back, no Undo. */
  function cancel() {
    if (!g) return false;
    g.cancelled = true;
    if (state.moveDragging && typeof endMoveDrag === 'function') endMoveDrag();
    else end();
    return true;
  }

  window.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Escape' || !g) return;
    ev.preventDefault();
    ev.stopPropagation();
    cancel();
  }, true);

  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('grab-drop', {
    live: function () { return !!g; },
    close: cancel,
    clear: clearLayer
  });

  window.nsoGrab = {
    begin: begin,
    move: move,
    end: end,
    cancel: cancel,
    active: function () { return !!g; },
    live: function () { return !!(g && g.live); },
    mode: function () { return g ? g.mode : null; },
    over: function () { return g && g.over ? g.over.placed.sourceId : null; },
    layer: function () { return layer; },
    SLOP: SLOP
  };
})();
