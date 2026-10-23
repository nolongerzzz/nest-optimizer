/* ============================================================
   app-grab-drop.js - GRAB AND DROP, and the floating state.
   After app-core.js (the move drag it rides on), app-seat-surface.js
   (NSO_seatPieceAt) and nso-helpers.js.

   LIFT'S DROP, AND NOTHING ELSE'S. A plate drag - Move, and any tool that
   moves a piece on the plate without naming a surface - is flat: XY only,
   the height settled once on release (app-core.js, docs/MOVE.md). This file
   is the one gesture that is not: the grab of a piece Lift left in the air
   (app-lift-plate.js ownsDrop; app-core's startMoveDrag asks at the press).
   Dragged past SLOP pixels - a click is still a click - it follows the
   pointer over the scene, the piece itself looked through. Where it is let
   go decides where it lands:

     over a piece    it SEATS onto that surface at the point under the
                     pointer, outside it, at the Seat gap - Seat here's own
                     seat (NSO_seatPieceAt: the same plan, the same gap rule,
                     the same paint scope, the same refusals). The piece a
                     lifted feature came off is a piece like any other.
     over the plate  it lands on the plate at that point (To plate): the
                     plate half of the drag is app-core's move drag with the
                     piece coming down onto the bed, grid snap included.
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

   OTHER PLATES. The state machine above does not know it is on the main
   plate. (G-scope's plate carries its own pieces with this same code; that
   is its own gesture, unchanged.) begin() takes an optional WORLD - the few things that differ: how
   the pointer becomes a ray, what is under it, where a piece's pose is read
   and put back, what a drop in the air and a drop onto a piece do. The
   default world (MAIN, below) is the main plate, unchanged. G-scope's second
   plate (app-microscope.js) hands its own, so a piece pulled onto it, or
   moved about on it, is carried by this same code with this same wording.

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
  var MAIN = null;              // the main plate's world (below)
  function W() { return (g && g.W) || MAIN; }

  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function modelOf(q) {
    return q ? (state.models || []).find(function (m) { return m && m.id === q.sourceId; }) || null : null;
  }
  function nameOfMain(q) { var m = modelOf(q); return '"' + ((m && m.name) || (q && q.name) || 'piece') + '"'; }
  function nameOf(q) { return W().nameOf(q); }
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
  function underMain(ev) {
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

  // ---------------------------------------------------------------- the main plate's world

  /* What differs between plates. MAIN is the main plate, exactly as this file
     always worked; a plate that is not the main one hands its own to begin().
       ray(ev)            the pointer as a THREE.Raycaster
       camera()           the camera it looks through
       under(ev, self)    { kind: 'piece', placed, point, normal } | { kind: 'plate', point } | { kind: 'air' }
       meshOf / boxOf / posOf / hitOn / keyOf / nameOf / isSupport   a piece, read
       snapshot / restore / placeAt                                  a piece's pose, kept, put back, moved
       onPlate(G, ev, u)  over the plate: true when it moved the piece, false to leave that to app-core's drag
       endPlate / endAir / seat(G, T, point)   the three drops
       onCancel(G)        after Escape has put it back
       finishCancel()     how Escape ends a carry (default: end())
       scene() / attach(scene, layer)   where the target helper is drawn */
  MAIN = {
    name: 'plate',
    ray: ray,
    camera: function () { return state.camera; },
    under: function (ev) { return underMain(ev); },
    meshOf: function (q) { return q && q.mesh; },
    boxOf: function (q) { return meshLocalBox3(q.mesh); },
    posOf: function (q) { return q.mesh.position.clone(); },
    hitOn: function (q, rc) { q.mesh.updateMatrixWorld(true); return rc.intersectObject(q.mesh, false)[0]; },
    keyOf: function (q) { return q.sourceId; },
    nameOf: nameOfMain,
    isSupport: function (q) { var m = modelOf(q); return !!(m && m.nsoSupport); },
    snapshot: function (q, idx) { return snapshotPlacedPose(idx); },
    restore: restore,
    placeAt: placeAt,
    onPlate: function (G) { G.p.liftY = 0; return false; },   // the plate drag settles it onto the bed
    endAir: function (G) {
      var p = G.p;
      pushUndo(G.from);
      say(nameOfMain(p) + ' left in the air, ' + f2(p.liftY) + ' mm over the bed - it stays there; grab it again, or To plate ' +
        'brings it down. One Undo (Ctrl+Z) puts it back.');
      return { handled: true, mode: 'air', liftY: p.liftY };
    },
    seat: function (G, T, pt) {
      var p = G.p;
      if (typeof window.NSO_seatPieceAt !== 'function') {
        say('Dropping onto a piece needs app-seat-surface.js - ' + nameOfMain(p) + ' is back where it was.', true);
        return { handled: true, mode: 'piece', ok: false, reason: 'no seat' };
      }
      var r = window.NSO_seatPieceAt(T, [pt.x, pt.y, pt.z], p, { undoType: 'dropSeatReplace' },
        { verb: 'Drop', a: nameOfMain(T), b: nameOfMain(p), seated: 'Dropped onto ' + nameOfMain(T) + ': seated' });
      if (r && r.ok && r.applied) {
        if (typeof refreshOutline === 'function') refreshOutline(p);
        say(r.applied.status + '. One Undo (Ctrl+Z) puts it back.');
        return { handled: true, mode: 'piece', ok: true, onto: T.sourceId, seat: r };
      }
      // the seat said why; the piece is where it was picked up
      return { handled: true, mode: 'piece', ok: false, reason: r && r.reason, seat: r };
    },
    onCancel: function () {},
    finishCancel: function () {
      if (state.moveDragging && typeof endMoveDrag === 'function') endMoveDrag(); else end();
    },
    scene: function () { return state.scene; },
    attach: function (scene, lyr) { nsoHelpers.attach(scene, lyr, 'grab-drop'); }
  };

  // ---------------------------------------------------------------- the helper: the target boxed, the drop point marked

  function ensureLayer() {
    var sc = W().scene();
    if (!sc) return null;
    if (!layer) { layer = new THREE.Group(); layer.name = 'grabDrop'; layer.renderOrder = 9; }
    if (layer.parent !== sc) W().attach(sc, layer);
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
    var box = W().boxOf(u.placed);
    var bh = new THREE.Box3Helper(box, col);
    bh.material.depthTest = false; bh.material.transparent = true;
    var dot = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 12),
      new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.9 }));
    dot.position.copy(u.point);
    layer.add(bh); layer.add(dot);
    W().attach(W().scene(), layer);
  }

  // ---------------------------------------------------------------- the drag

  /** app-core's startMoveDrag, once the drag has started. */
  function begin(p, idx, ev, world, opts) {
    g = null;
    var w = world || MAIN;
    if (!p || !w.meshOf(p)) return false;
    var rc = w.ray(ev);
    var hit = w.hitOn(p, rc);
    var at = hit ? hit.point.clone() : w.boxOf(p).getCenter(new THREE.Vector3());
    g = {
      W: w, p: p, idx: idx, from: w.snapshot(p, idx),
      x0: ev.clientX, y0: ev.clientY, live: !!(opts && opts.live), mode: null,
      grabOff: w.posOf(p).sub(at), plane: null, over: null, cancelled: false, said: ''
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
    var p = g.p, w = g.W, u = w.under(ev, p);
    if (u.kind === 'plate') {
      g.mode = 'plate'; g.over = null; g.plane = null;
      clearLayer();
      tell('plate', 'Over the plate - let go to set ' + nameOf(p) + ' down there. Esc puts it back.');
      // the main plate's own drag settles it onto the bed (false); another
      // plate slides it there itself (true)
      return w.onPlate(g, ev, u);
    }
    if (u.kind === 'piece') {
      g.mode = 'piece'; g.over = u; g.plane = null;
      var bad = w.isSupport(u.placed);
      drawTarget(u, bad);
      /* Shown resting off the surface along its normal; the seat itself is
         worked out on release, on the real surfaces. */
      var box = w.boxOf(p), c = box.getCenter(new THREE.Vector3()), h = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      var n = u.normal, reach = Math.abs(n.x) * h.x + Math.abs(n.y) * h.y + Math.abs(n.z) * h.z;
      var want = u.point.clone().addScaledVector(n, reach + 0.2);
      w.placeAt(p, w.posOf(p).add(want.sub(c)));
      if (bad) tell('sup' + w.keyOf(u.placed), nameOf(u.placed) + ' is a support piece - nothing is dropped onto a support. Let go and ' + nameOf(p) + ' goes back.', true);
      else {
        var gap = typeof readSeatGapInput === 'function' ? readSeatGapInput() : NaN;
        tell('on' + w.keyOf(u.placed), 'Over ' + nameOf(u.placed) + ' - let go to seat ' + nameOf(p) + ' there' +
          (isFinite(gap) ? ' at the Seat gap (' + NSO_formatSeatGap(gap) + ')' : '') + '. Esc puts it back.');
      }
      return true;
    }
    // nothing under it: it follows the pointer on a plane square to the view,
    // through the point it was grabbed by
    g.mode = 'air'; g.over = null;
    clearLayer();
    var rc = w.ray(ev);
    if (!g.plane) {
      var grabAt = w.posOf(p).sub(g.grabOff), dir = new THREE.Vector3();
      w.camera().getWorldDirection(dir);
      g.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir.negate(), grabAt);
    }
    var hitP = new THREE.Vector3();
    if (rc.ray.intersectPlane(g.plane, hitP)) w.placeAt(p, hitP.add(g.grabOff));
    tell('air', 'Over nothing - let go to leave ' + nameOf(p) + ' in the air where it is. Esc puts it back.');
    return true;
  }

  /** app-core's endMoveDrag. { handled: true } when the drop was done here
      (its Undo and its words); otherwise app-core finishes a plate drag. */
  function end() {
    if (!g) return null;
    var G = g, p = G.p, w = G.W;
    clearLayer();
    var nm = function (q) { return w.nameOf(q); };
    var done = function (r) { g = null; return r; };
    if (G.cancelled) {
      w.restore(G);
      say('Put back - ' + nm(p) + ' is where it was picked up. Nothing changed.');
      w.onCancel(G);
      return done({ handled: true, mode: 'cancel' });
    }
    if (!G.live) return done({ handled: false, mode: 'none', from: G.from });
    if (G.mode === 'plate' || !G.mode) {
      return done(w.endPlate ? w.endPlate(G) : { handled: false, mode: 'plate', from: G.from });
    }
    if (G.mode === 'air') return done(w.endAir(G));
    // over a piece: back to where it came from first, so the seat's one Undo
    // returns it there
    var T = G.over && G.over.placed;
    w.restore(G);
    if (!T) return done({ handled: true, mode: 'piece', ok: false });
    if (T === p) {
      say('That is ' + nm(p) + ' itself - a piece cannot be dropped onto itself. It is back where it was.', true);
      return done({ handled: true, mode: 'piece', ok: false, reason: 'itself' });
    }
    if (w.isSupport(T)) {
      say(nm(T) + ' is a support piece - nothing is dropped onto a support. ' + nm(p) + ' is back where it was.', true);
      return done({ handled: true, mode: 'piece', ok: false, reason: 'support' });
    }
    return done(w.seat(G, T, G.over.point));
  }

  /** Escape mid-drag: put it back, no Undo. */
  function cancel() {
    if (!g) return false;
    g.cancelled = true;
    if (g.W.finishCancel) g.W.finishCancel(); else end();
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
    over: function () { return g && g.over ? g.W.keyOf(g.over.placed) : null; },
    world: function () { return g ? g.W : null; },
    layer: function () { return layer; },
    SLOP: SLOP
  };
})();
