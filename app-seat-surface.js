/* ============================================================
   Seat here — the app layer for seating a piece against a curved or
   irregular target. After app-join.js (meshToWorldSoup, NSO_localAABB,
   readSeatGapInput), after app-sculpt.js (NSO_sculptCommitRaw) and after
   nso_seat_surface.js (the geometry core).

   Thin on purpose, like app-carve.js: every measurement lives in
   nso_seat_surface.js, which is THREE-free and node-tested. What is here is
   the three things that can only be done in the app - arm a click, turn the
   core's plan into a pose the EXPORT will carry, and commit it the way every
   other geometry op commits.

   Why the orientation is baked into the piece's own triangles
   ----------------------------------------------------------
   Seating against a curve needs a free rotation, and this app has nowhere to
   put one. `applyMeshRotation` rebuilds every piece's rotation from quantised
   pose fields (90 deg yaw, 15 deg tilt/bank steps) and
   `buildCombinedGeometry` - what Export plate writes - does the same from
   `p.geometry`. Neither reads `mesh.quaternion`. The shipped tilt fit writes
   there anyway, so a tilted seat is visible on screen and absent from the
   file: measured in tools/nso_seat_curved_audit.js, a 0.3 rad tilt takes the
   scene box from 20 to 25.02 mm and leaves the export box at 20.

   So this feature never writes a free rotation to the mesh. It rotates the
   piece's own raw soup by the delta, expressed in raw axes, and leaves the
   pose fields exactly as they were - after which the piece is an ordinary
   unrotated piece as far as Align, the exporters, Repair and Check piece are
   concerned, and the scene and the file agree by construction.

   That is Local-Carve's contained-pose-state decision reached from the other
   side. The blade stays out of state.placed so it never meets the pose model;
   a seated piece has to BE in state.placed, so the pose model must never see
   anything it cannot hold.

   PAINT SCOPE: WHOLE-PIECE, and only on the piece being seated, and only
   when the seat actually has to re-orient it. See the scoping rule in
   docs/HANDOFF.md. Reasoning, stated rather than left to be re-derived:
     - the TARGET piece is only ever read, never modified, so its paint is
       untouched by construction and cannot block a seat;
     - a seat that needs no rotation changes no geometry at all - it is a
       move - so paint on the piece being seated is untouched too and does
       not block it either;
     - a seat that DOES rotate re-writes the whole soup in new axes. No
       sub-region survives that as itself: every face changes which axis it
       faces, so a mask recorded per axis and side would come back pointing
       at a different face. There is no sub-region to scope to, which makes
       whole-piece the only coherent reading, exactly as it is for Smooth,
       Repair, Thicken, Scale and Fusion.
   ============================================================ */
(function () {
  'use strict';

  /* Anything under this is not a rotation, it is float noise in the probe's
     area-weighted normal: a tessellated dome's facets average to the tangent
     to within a few thousandths of a degree. Below it the seat is a pure
     move, so no geometry is touched and no paint check is owed. */
  var ROTATION_FLOOR_DEG = 1e-3;

  /* The bed baseline every placed piece is squared onto, and the slack a
     Float32 world box carries at plate-sized coordinates. Same numbers the
     gap seat uses (NSO_SEAT_BED_EPS). */
  var BED = 0.2;
  var BED_EPS = 1e-6;

  var busy = false;

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }

  function setArmed(on) {
    state.seatHereArmed = !!on;
    var btn = $('btn-seat-here');
    if (btn) {
      btn.setAttribute('aria-pressed', state.seatHereArmed ? 'true' : 'false');
      btn.classList.toggle('is-armed', state.seatHereArmed);
    }
    if (!state.seatHereArmed) { say('Seat here off'); return; }
    /* disarm the other click-owning modes, the way Measure does */
    if (state.maskPaint) {
      var pb = $(state.maskPaint === 'select' ? 'btn-mask-select' : 'btn-mask-paint');
      if (pb) pb.click();
    }
    if (state.carveArmed) { var cb = $('btn-carve'); if (cb) cb.click(); else state.carveArmed = false; }
    if (state.measureOn) { var mb = $('btn-measure'); if (mb) mb.click(); else state.measureOn = false; }
    if (state.centerLockArmed) {
      var clb = $('btn-center-lock-pick');
      if (clb) clb.click(); else state.centerLockArmed = false;
    }
    state.softenArmed = false;
    state.capArmed = false;
    say('Seat here armed - click the point on A where B should sit. Click Seat here again to stop.');
  }

  /* Retire the arm without saying anything. Join's clearJoinSlots needs this:
     it is tidying up a session, not handing the canvas to another mode, and
     clicking the button there would print "Seat here off" over whatever line
     the caller had just set. A flag written behind the button's back would
     leave the button lit and dead, so the button's own state goes with it -
     the same reason app-center-lock.js's disarmOthers clicks instead. */
  window.nsoSeatHereDisarm = function () {
    if (!state.seatHereArmed) return false;
    state.seatHereArmed = false;
    var btn = $('btn-seat-here');
    if (btn) {
      btn.setAttribute('aria-pressed', 'false');
      btn.classList.remove('is-armed');
    }
    return true;
  };

  function hitPiece(event) {
    if (!state.renderer || !state.camera || !state.modelGroup) return null;
    if (typeof setPointerFromEvent === 'function') setPointerFromEvent(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    var hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    for (var i = 0; i < hits.length; i++) {
      if (hits[i].faceIndex == null) continue;
      var obj = hits[i].object;
      while (obj && (!obj.userData || obj.userData.placedIndex == null) && obj.parent) obj = obj.parent;
      var idx = (obj && obj.userData) ? obj.userData.placedIndex : undefined;
      if (typeof idx === 'number' && state.placed[idx] && state.placed[idx].sourceId != null) {
        return { hit: hits[i], index: idx, placed: state.placed[idx] };
      }
    }
    return null;
  }

  /* app-core's onCanvasPointerDown asks this before it starts a move drag -
     the same contract app-mask.js and app-carve.js have. */
  window.nsoSeatHereTakesClick = function (event) {
    if (!state.seatHereArmed || !event || event.button !== 0) return false;
    var t = hitPiece(event);
    if (!t) return false;
    if (busy) { say('Seat here: the last seat is still running - one at a time', true); return true; }
    busy = true;
    try { NSO_seatHereAt(t.placed, [t.hit.point.x, t.hit.point.y, t.hit.point.z]); }
    catch (err) {
      console.error('[seat here]', err);
      say('Seat here failed - nothing moved (' + ((err && err.message) || err) + ')', true);
    }
    busy = false;
    return true;
  };

  /* raw <-> display is one rotation: display = rotateX(-90) of raw
     (app-core's zUpToYUp, app-cut's rawResultToDisplayGeometry). So a
     rotation to be applied in DISPLAY space is conjugated by it to land in
     raw space. Nothing else about the mapping matters here, because
     NSO_sculptCommitRaw re-centres what it is given. */
  function rawQuatFor(deltaWorld, poseQuat) {
    var inDisplay = poseQuat.clone().invert().multiply(deltaWorld).multiply(poseQuat);
    var toRaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    var toDisp = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    return toRaw.clone().multiply(inDisplay).multiply(toDisp);
  }

  function rotateRawSoup(raw, q) {
    var n = raw.length, i;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], a;
    for (i = 0; i < n; i += 3) for (a = 0; a < 3; a++) {
      var v = raw[i + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
    var c = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
    var out = new Float32Array(n), p = new THREE.Vector3();
    for (i = 0; i < n; i += 3) {
      p.set(raw[i] - c.x, raw[i + 1] - c.y, raw[i + 2] - c.z).applyQuaternion(q).add(c);
      out[i] = p.x; out[i + 1] = p.y; out[i + 2] = p.z;
    }
    return out;
  }

  /* The world box the plan puts the piece in, read off the planned soup
     rather than re-derived from the pose - so the pose below is fitted to the
     geometry that was actually measured. */
  function plannedWorldBox(worldSoup, matrix) {
    var placed = NSO_SeatSurface.transformSoup(worldSoup, matrix);
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], i, a;
    for (i = 0; i < placed.length; i += 3) for (a = 0; a < 3; a++) {
      var v = placed[i + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
    return { lo: lo, hi: hi, soup: placed };
  }

  /* One seat. `target` is the placed piece that was clicked (A); the piece
     that moves is the Join partner (B). Returns the core's plan plus what was
     done with it, so the check can drive it headlessly and read numbers
     rather than status text. */
  window.NSO_seatHereAt = function (target, point, optsIn) {
    optsIn = optsIn || {};
    if (typeof NSO_SeatSurface === 'undefined' || !NSO_SeatSurface) {
      say('Seat here needs nso_seat_surface.js', true);
      return { ok: false, reason: 'core missing' };
    }
    var idA = target && target.sourceId;
    var idB = state.joinPartnerId;
    if (!state.joinSession || idA == null || idB == null) {
      say('Start Join, pick A and B, then click the point on A where B should sit', true);
      return { ok: false, reason: 'no join session' };
    }
    if (idA === idB) {
      say('That is B. Click the point on A - the piece B is being seated against', true);
      return { ok: false, reason: 'clicked the piece being seated' };
    }
    var placedB = state.placed.find(function (p) { return p && p.sourceId === idB && p.mesh; });
    if (!placedB) { say('B is not on the plate', true); return { ok: false, reason: 'no B' }; }
    if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(placedB, 'Seat here')) {
      return { ok: false, reason: 'position lock' };
    }
    var gap = (optsIn.gap !== undefined) ? Number(optsIn.gap)
      : (typeof readSeatGapInput === 'function' ? readSeatGapInput() : NaN);
    if (!isFinite(gap)) {
      say('Seat gap slider is missing or out of range - nothing seated', true);
      return { ok: false, reason: 'no gap' };
    }

    /* A onto the bed baseline first, the way the gap seat does (a piece that
       was dropped and never moved sits 0.1 mm higher than a settled one, and
       liftY - what the exports write - is measured from the settled
       baseline). Unlike the gap seat, this one was aimed at a point on A's
       surface, so the point has to travel with A: settling only ever moves a
       piece in y, so the same delta carries the aim exactly. */
    target.mesh.updateMatrixWorld(true);
    var yBefore = target.mesh.position.y;
    if (typeof settlePlacedOnBed === 'function') settlePlacedOnBed(target);
    target.mesh.updateMatrixWorld(true);
    var dySettle = target.mesh.position.y - yBefore;
    point = [point[0], point[1] + dySettle, point[2]];

    placedB.mesh.updateMatrixWorld(true);
    var hull = meshToWorldSoup(target.mesh);
    if (!hull || !hull.length) { say('A has no geometry to seat against', true); return { ok: false, reason: 'empty A' }; }
    var boxB = NSO_localAABB(placedB.mesh.geometry);
    var plan = NSO_SeatSurface.plan(hull, {
      soup: meshToWorldSoup(placedB.mesh),
      box: { min: boxB.min.toArray(), max: boxB.max.toArray() },
      matrix: placedB.mesh.matrixWorld.elements.slice()
    }, {
      point: point, gap: gap,
      normalRadius: optsIn.normalRadius, dihedralDeg: optsIn.dihedralDeg,
      roll: optsIn.roll, center: optsIn.center, maxTiltDeg: optsIn.maxTiltDeg
    });
    if (!plan.ok) { say('Seat here refused - nothing moved (' + plan.reason + ')', true); return plan; }

    var needsRotation = plan.rotationDeg > ROTATION_FLOOR_DEG;

    /* paint: whole-piece on B, and only when the soup is about to be
       rewritten in new axes - see the PAINT SCOPE note at the top */
    var modelB = state.models.find(function (m) { return m && m.id === idB; });
    if (needsRotation) {
      var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(modelB) : 0;
      if (painted > 0) {
        say('Seat here stood down - ' + painted + ' painted face(s) on B, and seating there turns B ' +
          plan.rotationDeg.toFixed(1) + ' degrees, which would leave the paint on a different face' +
          ' - clear it, or seat a face that already looks at the target', true);
        return { ok: false, reason: 'B is painted', plan: plan, painted: painted };
      }
      if (!modelB || !modelB.rawTris || modelB.rawAxis !== 'zup') {
        say('Seat here needs a raw piece for B - nothing moved', true);
        return { ok: false, reason: 'no rawTris on B', plan: plan };
      }
    }

    var wb = plannedWorldBox(meshToWorldSoup(placedB.mesh), plan.matrix);
    var height = wb.hi[1] - wb.lo[1];
    var lift = wb.lo[1] - BED;
    if (lift < -BED_EPS) {
      say('Seat here refused - that pose would put B ' + (-lift).toFixed(2) +
        'mm below the plate, so the gap could not be what was asked for. Aim at a face that' +
        ' does not look down, or raise A', true);
      return { ok: false, reason: 'below the plate', plan: plan };
    }
    if (lift < 0) lift = 0;
    var cx = (wb.lo[0] + wb.hi[0]) / 2, cz = (wb.lo[2] + wb.hi[2]) / 2;

    var pose = (typeof snapshotPlacedPose === 'function')
      ? snapshotPlacedPose(state.placed.indexOf(placedB)) : null;

    if (needsRotation) {
      var qDelta = new THREE.Quaternion(plan.quat[0], plan.quat[1], plan.quat[2], plan.quat[3]);
      var qRaw = rawQuatFor(qDelta, placedB.mesh.quaternion.clone());
      var newRaw = rotateRawSoup(modelB.rawTris, qRaw);
      /* NSO_sculptCommitRaw pushes the undo entry itself, and it carries the
         geometry but not the pose. One Seat here must be ONE Undo, so the
         pose snapshot goes on that same entry rather than on a second one. */
      if (!NSO_sculptCommitRaw(modelB, newRaw, 'seatSurfaceReplace', null)) {
        say('Seat here failed - B\'s geometry was not replaced, nothing moved', true);
        return { ok: false, reason: 'commit failed', plan: plan };
      }
      var top = state.undoStack[state.undoStack.length - 1];
      if (top && top.type === 'seatSurfaceReplace' && top.modelId === modelB.id) top.prevPose = pose;
    } else if (pose) {
      pushUndo(pose);
    }

    placedB.x = cx; placedB.z = cz; placedB.liftY = lift;
    applyMeshRotation(placedB);
    applyPlacedXZ(placedB, cx, cz);
    if (typeof refreshOutline === 'function') refreshOutline(placedB);
    placedB.mesh.updateMatrixWorld(true);

    /* What actually came out, measured on the pieces as the scene now holds
       them - not trusted from the plan. A pose fitted through liftY and the
       bed baseline is Float32 at plate coordinates, so this is the number the
       status line reports. */
    target.mesh.updateMatrixWorld(true);
    var after = NSO_SeatSurface.minDistance(
      NSO_SeatSurface.cullNear(meshToWorldSoup(target.mesh),
        (function () {
          var s = meshToWorldSoup(placedB.mesh);
          var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], i, a;
          for (i = 0; i < s.length; i += 3) for (a = 0; a < 3; a++) {
            var v = s[i + a];
            if (v < lo[a]) lo[a] = v;
            if (v > hi[a]) hi[a] = v;
          }
          return { lo: lo, hi: hi };
        })(), Math.max(2, 8 * Math.abs(gap) + 1)),
      meshToWorldSoup(placedB.mesh));

    var what;
    if (gap < 0) what = 'air gap ' + Math.abs(gap).toFixed(2) + 'mm';
    else if (gap > 0) what = 'overlap ' + gap.toFixed(2) + 'mm';
    else what = 'touching, gap 0.00mm';
    var msg = 'Seated on the ' + plan.kind + ' at that point - ' + what +
      ' (clearance ' + (isFinite(after) ? after.toFixed(3) : '-') + 'mm';
    /* For a gap that is not an air gap there is no clearance to report - both
       touching and overlapping measure zero - so the status carries the
       quantity that IS the request instead: how far past first contact the
       piece sits. Reporting the support-plane offset here would print 0.235
       for a requested 0.05 the moment the contact is not a flat square, which
       is the whole thing this seat stopped doing. */
    if (gap >= 0 && plan.contactOffset != null) {
      msg += ', ' + (plan.contactOffset - plan.offsetAlongNormal).toFixed(3) + 'mm past first contact';
    }
    msg += ')';
    msg += needsRotation
      ? ' - B turned ' + plan.rotationDeg.toFixed(1) + ' degrees and baked into its own axes'
      : ' - no turn needed, B was already facing it';
    say(msg);

    /* The record every Seat leaves on the piece it moved (NSO_recordSeat,
       app-join.js), which the 3MF scene block writes so a reopened plate says
       which gap a pair was seated at. Descriptive only - the pose is still the
       truth and nothing re-seats from it.

       `measured` keeps the coupon sign, as the other two seats do: an air gap
       is negative, so the clearance just measured is negated. A gap at or past
       first contact has no clearance to report - both read zero - so it
       records the depth it actually reached, which this seat solves for
       exactly. `kind` is 'support' because this is a gap seat, not the plug
       seat; `reference` is 'face' because the mating face is what the gap is
       measured from, and the schema's other value ('tips') means the skin-tips
       branch of the flat seat, which this one does not use. */
    if (typeof NSO_recordSeat === 'function') {
      NSO_recordSeat(placedB, target, {
        gap: gap, kind: 'support',
        measured: (gap < 0) ? (isFinite(after) ? -after : null) : gap,
        /* no `residual`: there is no corner-ray residual here, and the
           record's own normaliser reads a null as 0, which would claim a
           measurement this seat never takes. An absent key stays null. */
        reference: 'face'
      });
    }

    plan.applied = {
      rotated: needsRotation, x: cx, z: cz, liftY: lift, height: height,
      clearanceAfter: after, status: msg
    };
    return plan;
  };

  if (typeof document !== 'undefined') {
    (function wire() {
      function bind() {
        var btn = $('btn-seat-here');
        if (!btn || btn.dataset.nsoWired === '1') return;
        btn.dataset.nsoWired = '1';
        btn.addEventListener('click', function () { setArmed(!state.seatHereArmed); });
      }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
      else bind();
    })();
  }
})();
