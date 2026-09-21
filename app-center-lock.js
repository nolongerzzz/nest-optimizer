/* Center lock — rough top-down placement, one step ahead of Seat and Align.
 *
 * Align matches EDGES: it finds a flat wall on A facing B and snaps B's
 * bounding edge onto it. Seat matches a SKIN: it pushes B's outer face down
 * onto A's surface along the plug normal. Both need B to already be roughly
 * where it belongs, and both are defined by geometry at the mating face.
 *
 * Center lock is the step before either. It ignores edges and skins entirely:
 * it takes one reference point on B (bounding-box centre or centroid, seen
 * top-down) and one target point on A (the same reference by default, or a
 * point the user clicked), and slides B in XZ until B's reference sits on the
 * target. Y is untouched beyond the bed settle every XZ move already does.
 *
 * Because the move is a pure XZ translation and modelGroup carries no
 * transform of its own, the delta applied to placed.x / placed.z lands on the
 * world reference point one-for-one: after the move B's reference IS the
 * target, to float precision. That exactness is what tools/nso_center_lock_test.js
 * pins, along with the fact that a Seat or an Align called straight afterwards
 * behaves exactly as it does on any other pose.
 *
 * Nothing here re-implements pose math that already exists. It reuses
 * meshLocalBox3 (world AABB), meshToWorldSoup (world triangle soup),
 * applyPlacedXZ (the one writer of a placed piece's XZ), and
 * snapshotPlacedPose + pushUndo (the one undo entry for a pose change).
 */
(function () {
  'use strict';

  var REF_BBOX = 'bbox';
  var REF_CENTROID = 'centroid';

  /* ---- reference points, both read top-down (X and Z only) ---- */

  /* Centre of the piece's world axis-aligned box. meshLocalBox3 is the app's
     own world-AABB helper - the same one Center X/Z and Align already read. */
  function boxCentreXZ(mesh) {
    var b = meshLocalBox3(mesh);
    if (!isFinite(b.min.x) || !isFinite(b.max.x)) return null;
    return { x: (b.min.x + b.max.x) / 2, z: (b.min.z + b.max.z) / 2 };
  }

  /* Volume centroid by tetrahedron decomposition about the origin: for each
     triangle (a,b,c) the tet (0,a,b,c) has signed volume det(a,b,c)/6 and
     centroid (a+b+c)/4, and the signed pieces of a closed surface sum to the
     solid. Exact for any watertight soup, and for a box it is the box centre.
     A soup that is open, or so thin the signed volumes cancel, has no such
     centroid - reported as null so the caller can fall back rather than
     divide by a number that is noise. */
  function volumeCentroid(soup) {
    var V = 0, cx = 0, cy = 0, cz = 0;
    var n = (soup.length / 9) | 0;
    for (var t = 0; t < n; t++) {
      var o = t * 9;
      var ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
      var bx = soup[o + 3], by = soup[o + 4], bz = soup[o + 5];
      var gx = soup[o + 6], gy = soup[o + 7], gz = soup[o + 8];
      var det = ax * (by * gz - bz * gy) - ay * (bx * gz - bz * gx) + az * (bx * gy - by * gx);
      var v = det / 6;
      V += v;
      cx += v * (ax + bx + gx) / 4;
      cy += v * (ay + by + gy) / 4;
      cz += v * (az + bz + gz) / 4;
    }
    return { V: V, x: cx, y: cy, z: cz };
  }

  /* Area-weighted centroid of the surface. Always defined, so this is what an
     open or degenerate soup falls back to. */
  function areaCentroid(soup) {
    var A = 0, cx = 0, cz = 0;
    var n = (soup.length / 9) | 0;
    for (var t = 0; t < n; t++) {
      var o = t * 9;
      var ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
      var ux = soup[o + 3] - ax, uy = soup[o + 4] - ay, uz = soup[o + 5] - az;
      var vx = soup[o + 6] - ax, vy = soup[o + 7] - ay, vz = soup[o + 8] - az;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var ar = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
      if (!isFinite(ar) || ar <= 0) continue;
      A += ar;
      cx += ar * (ax + soup[o + 3] + soup[o + 6]) / 3;
      cz += ar * (az + soup[o + 5] + soup[o + 8]) / 3;
    }
    if (!(A > 0)) return null;
    return { x: cx / A, z: cz / A, kind: 'area' };
  }

  function centroidXZ(mesh) {
    var soup = meshToWorldSoup(mesh);
    if (!soup || !soup.length) return null;
    var c = volumeCentroid(soup);
    // A closed solid's volume is a fair fraction of its box. Well under that
    // means the signed pieces cancelled - an open shell, or a sheet - and the
    // quotient would be noise, so use the surface centroid instead.
    var b = meshLocalBox3(mesh);
    var boxVol = Math.max(1e-9,
      (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z));
    if (isFinite(c.V) && Math.abs(c.V) > 1e-4 * boxVol) {
      return { x: c.x / c.V, z: c.z / c.V, kind: 'volume' };
    }
    return areaCentroid(soup);
  }

  function refPointXZ(mesh, mode) {
    if (!mesh) return null;
    if (mode === REF_CENTROID) {
      var c = centroidXZ(mesh);
      if (c) return c;
      // Centroid asked for but not computable: say so rather than silently
      // locking on a different point than the label promises.
      return null;
    }
    var b = boxCentreXZ(mesh);
    return b ? { x: b.x, z: b.z, kind: 'bbox' } : null;
  }

  /* ---- which two pieces ---- */

  function getRefMode() {
    var el = document.getElementById('center-lock-ref');
    return (el && el.value === REF_CENTROID) ? REF_CENTROID : REF_BBOX;
  }

  /* Same preconditions the Join card's other pair tools use: a live Join with
     A and B both picked. A is the piece that stays put and supplies the
     target; B is the piece that moves. */
  function pair() {
    var idA = state.editId;
    var idB = state.joinPartnerId;
    if (!state.joinSession || idA == null || idB == null || idA === idB) return null;
    var findPlaced = function (id) {
      return state.placed.find(function (p) { return p && p.sourceId === id && p.mesh; });
    };
    var a = findPlaced(idA), b = findPlaced(idB);
    if (!a || !b) return null;
    return { a: a, b: b };
  }

  /* ---- the move ---- */

  function run() {
    var pr = pair();
    if (!pr) {
      setStatus('Start Join, Pick A and B, then Center lock', true);
      return false;
    }
    var mode = getRefMode();
    pr.a.mesh.updateMatrixWorld(true);
    pr.b.mesh.updateMatrixWorld(true);

    var target = pickedTargetFor(pr.a);
    var targetTag;
    if (target) {
      targetTag = 'picked point';
    } else {
      target = refPointXZ(pr.a.mesh, mode);
      targetTag = mode === REF_CENTROID ? "A's centroid" : "A's box centre";
    }
    if (!target) {
      setStatus('Center lock failed - no centroid for A. Try Bounding-box centre', true);
      return false;
    }

    var ref = refPointXZ(pr.b.mesh, mode);
    if (!ref) {
      setStatus('Center lock failed - no centroid for B. Try Bounding-box centre', true);
      return false;
    }

    var dx = target.x - ref.x;
    var dz = target.z - ref.z;

    pushUndo(snapshotPlacedPose(state.placed.indexOf(pr.b)));
    // applyPlacedXZ is the one writer of a placed piece's XZ - it keeps
    // placed.x/z and mesh.position in step and re-settles the piece on the
    // bed, exactly as Align and Center X/Z leave it for Seat.
    applyPlacedXZ(pr.b, pr.b.x + dx, pr.b.z + dz);

    var moved = Math.sqrt(dx * dx + dz * dz);
    var refTag = (ref.kind === 'bbox') ? 'box centre'
               : (ref.kind === 'area') ? 'surface centroid'
               : 'centroid';
    setStatus('Center locked - B\'s ' + refTag + ' on ' + targetTag
      + ', moved ' + moved.toFixed(2) + 'mm - now Seat or Align');
    return true;
  }

  /* ---- the optional picked target ---- */

  /* A stored pick only counts while it still belongs to the piece now in slot
     A. Re-picking A without re-picking the point would otherwise lock onto a
     point on a piece that is no longer the target. */
  function pickedTargetFor(placedA) {
    var t = state.centerLockTarget;
    if (!t) return null;
    if (t.sourceId !== placedA.sourceId) return null;
    return { x: t.x, z: t.z };
  }

  function clearTarget(quiet) {
    state.centerLockTarget = null;
    syncUI();
    if (!quiet) setStatus('Center lock target cleared - back to A\'s own centre');
  }

  function armPick() {
    if (!pair()) {
      setStatus('Start Join, Pick A and B, then pick a target', true);
      return;
    }
    if (state.centerLockArmed) {
      state.centerLockArmed = false;
      syncUI();
      setStatus('Center lock pick cancelled');
      return;
    }
    disarmOthers();
    state.centerLockArmed = true;
    syncUI();
    setStatus('Center lock: click the target point on A');
  }

  /* Two armed modes on one canvas means one of them silently never fires:
     app-core asks this hook before the Join block and stops the event there,
     so a live Measure or Carve would be left lit and dead. Turn them off on
     the way in, the same way app-measure.js does it - the two that have a
     button go off THROUGH the button, because a flag written behind its back
     leaves the button lit and doing nothing. state.maskPaint is
     false | 'exclude' | 'select', so the click has to go to whichever paint
     button is actually live. */
  function disarmOthers() {
    var el = function (id) { return document.getElementById(id); };
    if (state.maskPaint) {
      var paintBtn = el(state.maskPaint === 'select' ? 'btn-mask-select' : 'btn-mask-paint');
      if (paintBtn) paintBtn.click();
    }
    if (state.carveArmed) {
      var carveBtn = el('btn-carve');
      if (carveBtn) carveBtn.click();
      else state.carveArmed = false;
    }
    if (state.measureOn) {
      var measureBtn = el('btn-measure');
      if (measureBtn) measureBtn.click();
      else state.measureOn = false;
    }
    if (typeof window.nsoBrushArmed === 'function' && window.nsoBrushArmed()) {
      var brushBtn = el('btn-brush');
      if (brushBtn) brushBtn.click();
      else if (typeof window.nsoBrushSetArmed === 'function') window.nsoBrushSetArmed(false);
    }
    if (state.seatHereArmed) {
      var seatBtn = el('btn-seat-here');
      if (seatBtn) seatBtn.click();
      else state.seatHereArmed = false;
    }
    state.softenArmed = false;
    state.capArmed = false;
    if (typeof clearFacePick === 'function') clearFacePick();
  }

  /* Called from app-core's canvas pointerdown while a pick is armed. Returns
     true when the click was consumed here. The raycaster is already set from
     this event by the caller, the same contract Soften and Cap run under. */
  function takesClick(event) {
    if (!state.centerLockArmed) return false;
    if (!state.modelGroup || !state.raycaster) return false;
    if (event && event.button !== 0) return false;
    var pr = pair();
    if (!pr) {
      state.centerLockArmed = false;
      syncUI();
      setStatus('Center lock pick cancelled - A and B are no longer both picked', true);
      return true;
    }
    var hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    if (!hits.length) return false; // clicked empty space: let the orbit have it
    var obj = hits[0].object;
    while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
    var idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
    var hitPlaced = (typeof idx === 'number') ? state.placed[idx] : null;
    if (!hitPlaced) return false;
    if (hitPlaced === pr.b) {
      setStatus('That is B, the piece that moves. Click the target on A', true);
      return true;
    }
    if (hitPlaced !== pr.a) {
      setStatus('Target must be on A. Click A, or press Pick target again to cancel', true);
      return true;
    }
    // Top-down: only the click's X and Z matter; its height on A does not.
    state.centerLockTarget = {
      sourceId: pr.a.sourceId,
      x: hits[0].point.x,
      z: hits[0].point.z
    };
    state.centerLockArmed = false;
    syncUI();
    // One gesture: picking the point is also the request to lock onto it.
    run();
    return true;
  }

  /* ---- UI ---- */

  function syncUI() {
    var pr = pair();
    var ready = !!pr;
    var lock = document.getElementById('btn-center-lock');
    var pick = document.getElementById('btn-center-lock-pick');
    var sel = document.getElementById('center-lock-ref');
    if (lock) lock.disabled = !ready;
    if (sel) sel.disabled = !ready;
    if (pick) {
      pick.disabled = !ready;
      pick.classList.toggle('tool-active', !!state.centerLockArmed);
      var has = ready && !!state.centerLockTarget
        && state.centerLockTarget.sourceId === pr.a.sourceId;
      pick.textContent = state.centerLockArmed ? 'Click A...'
        : has ? 'Target set ✓' : 'Pick target';
    }
  }

  function bind() {
    var lock = document.getElementById('btn-center-lock');
    if (lock) lock.addEventListener('click', function () { run(); });
    var pick = document.getElementById('btn-center-lock-pick');
    if (pick) {
      pick.addEventListener('click', armPick);
      // Right-click the pick button to drop a stored target without arming.
      pick.addEventListener('contextmenu', function (ev) {
        ev.preventDefault();
        if (state.centerLockTarget) clearTarget(false);
      });
    }
    syncUI();
  }

  window.NSO_CenterLock = {
    run: run,
    armPick: armPick,
    clearTarget: clearTarget,
    takesClick: takesClick,
    syncUI: syncUI,
    refPointXZ: refPointXZ,
    REF_BBOX: REF_BBOX,
    REF_CENTROID: REF_CENTROID
  };
  // app-core's pointerdown looks this up by name, the same hook shape paint
  // uses for nsoMaskTakesClick.
  window.nsoCenterLockTakesClick = takesClick;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
