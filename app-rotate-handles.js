/* Rotate rings - three full rings on the selected piece, one per axis of the
   PLATE, each turned by the arrowheads it carries.

   WHAT WAS WRONG WITH THE ARC AND THE TRACKBALL. Three things, and each one
   made the control say one thing and do another:

   1. THE GUIDE AND THE MOTION DISAGREED. A pose is stored as Euler angles
      that applyMeshRotation composes in a fixed order -

          mesh.rotation.set(tipX*90 + tiltX + flip,  rotY,  tipZ*90 + tiltZ)

      - an XYZ Euler, so the matrix is Rx * Ry * Rz. Writing rotY moves the
      MIDDLE factor, which turns the piece about the Y axis as Rx has already
      tilted it. The handle wrote rotY and drew a flat ring, so on a pitched
      piece the arc showed one axis and the piece turned about another.
   2. THE DIAL HAD NO VIEW TERM. It mapped the pointer's screen angle straight
      to degrees, so from the far side of the plate the same circle on screen
      turned the piece the other way.
   3. THE MAGNETIC DETENT pulled the piece up to 4.5 degrees off the pointer,
      everywhere in the travel.

   WHAT THIS DOES INSTEAD.

   Turn is about the plate's vertical; the two leans are about the PIECE's
   own axes as it lies - Lean front/back its own X (a roll about its length),
   Lean side/side its own Z (end-over-end along its length) - so each
   lean ring is drawn in the piece's frame and the ring you grab is the
   motion you get (frameOf). A Turn step is premultiplied onto the piece's
   orientation, a lean step postmultiplied (turned), and either way the
   result is decomposed back into the SAME pose fields,
   in the same XYZ order applyMeshRotation composes them in (writePose below).
   Nothing that reads those fields has to know this file exists: export, Undo
   snapshots, Join's NSO_rotateRawSoupByPlacedPose, Mirror and the Tip menu
   all read the fields or the mesh applyMeshRotation builds from them, and
   both say exactly what this wrote. tipX, tipZ and flipX are NEVER written
   here: they stay the whole quarter-turn counts Tip 90 and Roll 90 step, and
   the continuous part goes in tiltX, rotY and tiltZ.

   The drag is still a dial - the pointer's angle about the ring's projected
   centre - but signed by which side of the ring the camera is on (the dot of
   the look vector with the ring's axis), so clockwise on screen is clockwise
   on the piece from every side. See dialSign.

   The snap is a plain hard snap: inside 3 degrees of a quarter turn the
   piece sits ON the quarter turn, and outside it the piece is exactly where
   the pointer says. Only during a drag. A click is always exactly 1 degree. */
(function () {
  'use strict';

  var STEP_DEG = 1;             // one click on an arrowhead, one arrow key
  var SNAP_STEP_DEG = 90;       // the quarter turns
  var SNAP_WITHIN_DEG = 3;      // ...and how close the hard snap catches
  var CLICK_SLOP_PX = 4;        // a press that travels less than this is a click
  var FLASH_MS = 240;           // the one flash on landing in a snap

  var DEG = 180 / Math.PI, RAD = Math.PI / 180;

  /* The three rings. `e1, e2` span the ring's plane with e1 x e2 = axis, so a
     point at angle t, c + r (cos t e1 + sin t e2), moves the right-handed
     positive way about the axis as t grows. Colours match the checkboxes. */
  var RINGS = {
    turn: { frame: 'plate', axis: [0, 1, 0], e1: [0, 0, 1], e2: [1, 0, 0],
            color: 0x38bdf8, css: '#38bdf8', label: 'Turn', chk: 'chk-rot-ring-turn' },
    fb:   { frame: 'piece', local: [1, 0, 0],
            color: 0xf472b6, css: '#f472b6', label: 'Lean front/back', chk: 'chk-rot-ring-fb' },
    ss:   { frame: 'piece', local: [0, 0, 1],
            color: 0xfbbf24, css: '#fbbf24', label: 'Lean side/side', chk: 'chk-rot-ring-ss' }
  };
  var UP = [0, 1, 0];

  /* WHICH AXIS EACH RING IS. Turn is the plate's vertical, always: it stays
     level, and a turn is about the plate however the piece lies. The two
     leans are the PIECE's own axes as it currently lies, so they turn with
     it - at rest exactly #135's rings, plate X and plate Z, and after that
     wherever the piece has taken them. Lean front/back is its own X, its
     length: its ring lies ACROSS the piece and rolls it, the front edge going
     up or down and no end lifting. Lean side/side is its own Z, the line
     across its width: its ring runs ALONG the piece and tips it end-over-end.
     Turn a bar 45 degrees and lean it side/side: its long axis rises at the
     same 45 degree heading, with no twist. A lean about the PLATE's axis
     there would have swung it sideways as it rose.

     frameOf gives a ring's axis A and the two vectors e1, e2 spanning its
     plane (e1 x e2 = A), in world terms, for the orientation q. For a lean
     ring e1 is kept level - the horizontal line in the ring's plane - so the
     ring's scale reads 0 with the piece's end flat and 90 with it upright,
     and turning about A itself leaves A, and so the whole frame, where it was.
     Only when A is straight up is there no level line; the piece's own most
     nearly perpendicular axis stands in. */
  function frameOf(ring, q) {
    var R = RINGS[ring];
    if (R.frame === 'plate') return { A: v3(R.axis), e1: v3(R.e1), e2: v3(R.e2) };
    var A = v3(R.local).applyQuaternion(q).normalize();
    var e1 = v3(UP).cross(A);
    if (e1.lengthSq() < 1e-12) {
      var best = null, bl = -1;
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach(function (b) {
        var w = v3(b).applyQuaternion(q), l = 1 - Math.pow(w.dot(A), 2);
        if (l > bl) { bl = l; best = w; }
      });
      e1 = best.projectOnPlane(A);
    }
    e1.normalize();
    return { A: A, e1: e1, e2: A.clone().cross(e1).normalize() };
  }
  function pieceQ() {
    var p = piece();
    if (!p) return new THREE.Quaternion();
    p.mesh.updateMatrixWorld(true);
    return p.mesh.quaternion.clone();
  }
  var ORDER = ['turn', 'fb', 'ss'];

  function v3(a) { return new THREE.Vector3(a[0], a[1], a[2]); }

  /* ---- which rings, for this Rotate session ------------------------------
     Turn only on every opening. The choice lasts while the menu does and is
     not saved anywhere: the teardown that runs when Rotate loses the input
     puts it back (resetSession). */
  var shown = null;
  var lastTouched = null;       // the ring whose arrowhead was pressed last
  var arrowAt = {};             // ring -> angle on the ring where its arrowheads sit
  function resetSession() {
    shown = { turn: true, fb: false, ss: false };
    lastTouched = null;
    arrowAt = {};
    syncBoxes();
  }
  function syncBoxes() {
    ORDER.forEach(function (k) {
      var c = document.getElementById(RINGS[k].chk);
      if (c) c.checked = !!shown[k];
    });
  }
  function shownRings() { return ORDER.filter(function (k) { return shown[k]; }); }
  function setRing(k, on) {
    if (!RINGS[k]) return;
    shown[k] = !!on;
    if (!on && drag && drag.ring === k) endDrag(true);
    if (!on && lastTouched === k) lastTouched = null;
    syncBoxes();
    refresh();
  }
  /* The keyboard's ring: the one last touched, else the only one shown, else
     Turn - the ring every session starts with. */
  function activeRing() {
    var list = shownRings();
    if (lastTouched && shown[lastTouched]) return lastTouched;
    if (list.length === 1) return list[0];
    if (shown.turn) return 'turn';
    return list[0] || null;
  }

  /* ---- the piece --------------------------------------------------------- */
  function piece() {
    if (typeof state === 'undefined' || !state || !state.placed) return null;
    var p = state.placed[state.selectedIndex];
    return (p && p.mesh) ? p : null;
  }

  /* ---- Task 1: the math ------------------------------------------------- */
  function wrapPi(a) {                       // to (-pi, pi]
    a = a % (2 * Math.PI);
    if (a > Math.PI) a -= 2 * Math.PI;
    if (a <= -Math.PI) a += 2 * Math.PI;
    return a;
  }
  function wrapDeg(d) { return wrapPi(d * RAD) * DEG; }
  function clean(v, digits) { v = +v.toFixed(digits); return v === 0 ? 0 : v; }   // no -0, no 1e-17

  /* The three Euler angles applyMeshRotation hands THREE, read off the fields
     - not recomposed into a rotation, only summed the way it sums them. */
  function fieldEuler(p) {
    return {
      x: (p.tipX || 0) * (Math.PI / 2) + (p.tiltX || 0) * RAD + (p.flipX ? Math.PI : 0),
      y: p.rotY || 0,
      z: (p.tipZ || 0) * (Math.PI / 2) + (p.tiltZ || 0) * RAD
    };
  }

  /* An orientation back to XYZ Euler angles - the order applyMeshRotation
     composes them in, so composing the answer gives this orientation back.

     Every orientation has two XYZ readings, (x, y, z) and (x+pi, pi-y, z+pi).
     THREE's own setFromQuaternion always takes the one with y in [-90, 90],
     which would turn a flat piece yawed to 100 degrees into (180, 80, 180):
     the same rotation, but rotY no longer says 100 and the 90-degree buttons,
     which add to rotY, would then turn it the other way. So the reading
     closest to the piece's current fields is kept, and a drag through 90
     comes out (0, 100, 0) as anyone reading the record would expect.

     At y = +/-90 (gimbal lock) only x+z or x-z is determined; z is held where
     it was and x takes the rest, which again keeps the fields continuous. */
  function decompose(q, prev) {
    var e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;   // column-major
    var m11 = e[0], m12 = e[4], m13 = e[8];
    var m22 = e[5], m23 = e[9];
    var m32 = e[6], m33 = e[10];
    var cy = Math.hypot(m11, m12);
    prev = prev || { x: 0, y: 0, z: 0 };
    if (cy < 1e-7) {
      var y = m13 > 0 ? Math.PI / 2 : -Math.PI / 2;
      var t = Math.atan2(m32, m22);           // x + z at +90, x - z at -90
      var z = prev.z;
      return { x: m13 > 0 ? t - z : t + z, y: y, z: z };
    }
    var a = { x: Math.atan2(-m23, m33), y: Math.atan2(m13, cy), z: Math.atan2(-m12, m11) };
    var b = { x: a.x + Math.PI, y: Math.atan2(m13, -cy), z: a.z + Math.PI };
    var dist = function (s) {
      return Math.abs(wrapPi(s.x - prev.x)) + Math.abs(wrapPi(s.y - prev.y)) +
             Math.abs(wrapPi(s.z - prev.z));
    };
    return dist(b) < dist(a) ? b : a;
  }

  /* Put an orientation on the piece, through the fields. tipX, tipZ and flipX
     are left as they are - whole quarter-turn counts that other buttons step -
     and what is left over goes in the free fields. */
  function writePose(p, q, held) {
    var e = decompose(q, fieldEuler(p));
    p.tiltX = clean(wrapDeg(e.x * DEG - (p.tipX || 0) * 90 - (p.flipX ? 180 : 0)), 9);
    p.rotY = clean(wrapPi(e.y), 12);
    p.tiltZ = clean(wrapDeg(e.z * DEG - (p.tipZ || 0) * 90), 9);
    if (typeof applyMeshRotation === 'function') applyMeshRotation(p);
    /* Held: applyMeshRotation has set the rotation and measured the new box
       (width, depth, height all current); only its seat is undone, putting
       the bounding-sphere centre back on the pivot. */
    if (held && hold && hold.p === p) {
      p.mesh.position.copy(hold.pivot).sub(hold.cL.clone().applyQuaternion(p.mesh.quaternion));
      p.mesh.updateMatrixWorld(true);
      hold.lastPos.copy(p.mesh.position);
      hold.lastQ.copy(p.mesh.quaternion);
    }
    if (typeof refreshOutline === 'function') refreshOutline(p);
  }

  /* A turn of `deg` on a ring. Turn: R(vertical, deg) * q0, on the PLATE's
     side - about the plate, whatever q0 already is. The leans: q0 * R(own
     axis, deg), on the PIECE's side - about the piece's own axis as it lies.
     (The same thing as R(q0 * axis, deg) * q0, which is why frameOf's A is the
     axis the dial and the snap measure about.) */
  function turned(q0, ring, deg) {
    var R = RINGS[ring];
    if (R.frame === 'plate')
      return new THREE.Quaternion().setFromAxisAngle(v3(R.axis), deg * RAD).multiply(q0);
    return q0.clone().multiply(new THREE.Quaternion().setFromAxisAngle(v3(R.local), deg * RAD));
  }

  /* Where the piece stands on a ring, in degrees, for the snap to act on.

     A world-axis turn has no "rotY" to read once the piece is leaned, so this
     measures it: the piece's own axis that lies most nearly in the ring's
     plane, projected into that plane, at its angle about the ring's axis.
     That angle moves by EXACTLY d under a turn of d about the axis - the
     projection of R(axis,d) v is the projection of v turned by d - so snapping
     it to a quarter turn puts that edge of the piece square to the plate.
     Which of the piece's axes is measured is fixed when a drag starts. */
  function refAxis(q, ring) {
    var A = frameOf(ring, q).A, best = null, bestLen = -1;
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach(function (b) {
      var v = v3(b).applyQuaternion(q);
      var len = 1 - Math.pow(v.dot(A), 2);
      if (len > bestLen + 1e-9) { bestLen = len; best = b; }
    });
    return best;
  }
  /* `F` is the ring's frame to measure in - for a drag, the one it started
     in, which a turn about the ring's own axis leaves unchanged anyway. */
  function ringAngleDeg(q, ring, b, F) {
    F = F || frameOf(ring, q);
    var v = v3(b).applyQuaternion(q);
    return Math.atan2(v.dot(F.e2), v.dot(F.e1)) * DEG;
  }

  /* The hard snap: within SNAP_WITHIN_DEG of a quarter turn, the quarter
     turn; anywhere else, the angle untouched. No pull on either side. */
  function inSnap(deg) {
    return Math.abs(deg - Math.round(deg / SNAP_STEP_DEG) * SNAP_STEP_DEG) <= SNAP_WITHIN_DEG;
  }
  function hardSnapDeg(deg) {
    return inSnap(deg) ? Math.round(deg / SNAP_STEP_DEG) * SNAP_STEP_DEG : deg;
  }

  /* The direction of a drag. The pointer's angle about the ring's projected
     centre, in screen terms (y down, so a growing angle is clockwise), times
     the sign of look . axis. Derivation, for the record: a positive turn
     about A reads counter-clockwise to an eye looking down A from its tip -
     look . A < 0 - so there clockwise on screen is a negative turn, and the
     factor is -1; from the other side it is +1. So the same circle drawn on
     screen turns the piece the same way as the eye sees it, from either side.
     Edge-on (look . A = 0) there is no clockwise to speak of; +1 is used. */
  function dialSign(ring) {
    if (typeof state === 'undefined' || !state || !state.camera) return 1;
    var look = new THREE.Vector3();
    state.camera.getWorldDirection(look);
    var d = look.dot(frameOf(ring, pieceQ()).A);
    return d < 0 ? -1 : 1;
  }

  /* ---- turning ----------------------------------------------------------- */
  function refuse(p) {
    return typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'rotate');
  }
  function undoPoint() {
    if (typeof pushUndo !== 'function' || typeof snapshotPlacedPose !== 'function') return;
    var snap = snapshotPlacedPose(state.selectedIndex);
    /* Inside a run the mesh is held, not seated; the Undo point records the
       height this pose seats at, so Undo restores a seated pose as before. */
    if (snap && hold && holdIntact() && hold.p === state.placed[state.selectedIndex])
      snap.meshY = seatedY(hold.p);
    pushUndo(snap);
  }

  /* One step of `deg` about a ring, no snap - a click, a key. */
  function stepBy(ring, deg) {
    var p = piece();
    if (!p || !RINGS[ring]) return false;
    if (refuse(p)) return false;
    /* a key press is a click without the mouse: one run per ring and way */
    var way = deg < 0 ? -1 : 1;
    if (hold && (hold.ring !== ring || hold.dir !== way)) seat();
    undoPoint();
    startHold(p, ring, way);
    p.mesh.updateMatrixWorld(true);
    writePose(p, turned(p.mesh.quaternion.clone(), ring, deg), true);
    seatLater();
    if (arrowAt[ring] != null) arrowAt[ring] += deg * RAD;
    lastTouched = ring;
    if (typeof updateExportButton === 'function') updateExportButton();
    refresh();
    say(ring, deg * dialSign(ring), false);
    return true;
  }

  /* ---- dragging ----------------------------------------------------------
     A press on an arrowhead starts this. It is a click until the pointer has
     travelled CLICK_SLOP_PX; released before that, it steps one degree the way
     the arrowhead points. Past it, it is a dial round the ring. One Undo
     point either way, taken at the press. */
  var drag = null;

  function beginDrag(handle, x, y, cx, cy) {
    var ring = handle && handle.ring ? handle.ring : handle;
    var dir = handle && handle.dir ? handle.dir : 1;
    var p = piece();
    if (!p || !RINGS[ring] || !shown[ring]) return false;
    if (refuse(p)) return false;
    /* a press on the arrowhead a run is on continues it; any other press
       puts that run down first */
    if (hold && (hold.p !== p || hold.ring !== ring || hold.dir !== dir || !holdIntact())) seat();
    undoPoint();
    startHold(p, ring, dir);
    if (hold.timer) { clearTimeout(hold.timer); hold.timer = 0; }   // held for as long as it is pressed
    p.mesh.updateMatrixWorld(true);
    var q0 = p.mesh.quaternion.clone();
    var b = refAxis(q0, ring);
    drag = { ring: ring, dir: dir, x0: x, y0: y, cx: cx, cy: cy,
             lastA: Math.atan2(y - cy, x - cx) * DEG, raw: 0, applied: 0,
             sign: dialSign(ring), q0: q0, b: b, F: frameOf(ring, q0),
             abs0: ringAngleDeg(q0, ring, b),
             arrow0: arrowAt[ring], moved: false, snapped: false };
    /* Starting inside a snap is not landing in one: no flash on the way out. */
    drag.snapped = inSnap(drag.abs0);
    lastTouched = ring;
    if (state.controls) state.controls.enabled = false;
    refresh();
    return true;
  }

  function moveDrag(x, y) {
    var p = piece();
    if (!drag || !p) return null;
    var a = Math.atan2(y - drag.cy, x - drag.cx) * DEG;
    var da = a - drag.lastA;
    while (da > 180) da -= 360;
    while (da < -180) da += 360;
    drag.lastA = a;
    drag.raw += drag.sign * da;
    if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) < CLICK_SLOP_PX) return null;
    drag.moved = true;
    var want = drag.abs0 + drag.raw;
    var at = hardSnapDeg(want);
    var snapped = inSnap(want);
    if (snapped && !drag.snapped) flash();
    drag.snapped = snapped;
    drag.applied = at - drag.abs0;
    writePose(p, turned(drag.q0, drag.ring, drag.applied), true);
    if (drag.arrow0 != null) arrowAt[drag.ring] = drag.arrow0 + drag.applied * RAD;
    refresh();
    say(drag.ring, drag.applied * drag.sign, snapped, x, y);
    return { raw: drag.raw, applied: drag.applied, snapped: snapped };
  }

  /* `abandon` is the menu going away under a held arrowhead: whatever was
     dragged stays, but a press that never became a drag does not then step. */
  function endDrag(abandon) {
    if (!drag) return;
    var d = drag;
    drag = null;
    if (typeof state !== 'undefined' && state && state.controls) state.controls.enabled = true;
    if (!d.moved && !abandon) {
      /* a click: a step about the held pivot, the run seated RUN_MS on */
      var p = piece();
      if (p) {
        p.mesh.updateMatrixWorld(true);
        writePose(p, turned(p.mesh.quaternion.clone(), d.ring, d.dir * STEP_DEG), true);
        if (arrowAt[d.ring] != null) arrowAt[d.ring] += d.dir * STEP_DEG * RAD;
        say(d.ring, d.dir * STEP_DEG * d.sign, false);
      }
      seatLater();
    } else {
      seat();                   // a drag is put down on release; so is an abandoned press
    }
    hideReadoutSoon();
    if (typeof updateExportButton === 'function') updateExportButton();
    refresh();
  }

  /* ---- the readout -------------------------------------------------------
     Degrees turned since the press, with the way it went AS SEEN FROM HERE -
     the same sense the dial reads the pointer in - so dragging a full lap
     clockwise reads 360 and on past it. The status line says the same. */
  var readout = null, readoutTimer = null, flashUntil = 0;
  function fmtDeg(d) {
    var a = Math.abs(d);
    return (Math.abs(a - Math.round(a)) < 0.05 ? Math.round(a) : a.toFixed(1)) + '°';
  }
  function readoutText(ring, seenDeg, snapped) {
    return RINGS[ring].label + ' ' + fmtDeg(seenDeg) +
      (Math.abs(seenDeg) < 1e-9 ? '' : (seenDeg > 0 ? ' ⟳' : ' ⟲')) +
      (snapped ? ' · square' : '');
  }
  function say(ring, seenDeg, snapped, x, y) {
    var t = readoutText(ring, seenDeg, snapped);
    lastReadout = t;
    if (typeof setStatus === 'function') setStatus('Rotate - ' + t);
    if (!readout) {
      readout = document.createElement('div');
      readout.className = 'nso-rot-readout';
      readout.setAttribute('aria-live', 'polite');
      document.body.appendChild(readout);
    }
    readout.textContent = t;
    readout.style.setProperty('--rot-accent', RINGS[ring].css);
    if (x == null && drag) { x = drag.x0; y = drag.y0; }
    if (x == null) {
      var s = handleScreen(ring, 1);
      if (s) { x = s.x; y = s.y; }
    }
    if (x != null) { readout.style.left = (x + 16) + 'px'; readout.style.top = (y - 30) + 'px'; }
    readout.hidden = false;
    if (readoutTimer) { clearTimeout(readoutTimer); readoutTimer = null; }
    if (!drag) hideReadoutSoon();
  }
  var lastReadout = '';
  function hideReadoutSoon() {
    if (readoutTimer) clearTimeout(readoutTimer);
    readoutTimer = setTimeout(function () { if (readout && !drag) readout.hidden = true; }, 1400);
  }
  function hideReadout() {
    if (readoutTimer) { clearTimeout(readoutTimer); readoutTimer = null; }
    if (readout) readout.hidden = true;
  }
  var flashes = 0;
  function flash() {
    flashes++;
    flashUntil = Date.now() + FLASH_MS;
    setTimeout(refresh, FLASH_MS + 10);
  }

  /* ---- keyboard ----------------------------------------------------------
     One degree on the keyboard's ring (activeRing): Right or Up turns it
     clockwise as seen from here, Left or Down anticlockwise - the dial's own
     sense. Held down, the browser's key repeat does the repeating. */
  function nudge(dir) {
    var ring = activeRing();
    if (!ring) return false;
    return stepBy(ring, dir * STEP_DEG * dialSign(ring));
  }
  var KEYS = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };

  /* Whether this menu owns the input right now. Asked of nsoInputMode rather
     than read off `#menu-rotate.open` directly: Tilt and Move claim the same
     four arrows off their own menus, and the arbiter is what guarantees one
     press is answered once (app-input-mode.js has the whole story). */
  function menuOwnsInput() {
    if (window.nsoInputMode) return window.nsoInputMode.owns('menu-rotate');
    var d = document.getElementById('menu-rotate');
    return !!(d && d.open);
  }

  function onKeyDown(ev) {
    var k = KEYS[ev.key];
    if (!k) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (!menuOwnsInput()) return;                  // the scope rule, in one line
    /* Text fields keep their arrows. A checkbox does not use them, and the
       ring boxes are exactly what has focus right after one is ticked - so
       they are let through, or adding a ring would deafen the keys. */
    var t = ev.target;
    if (t && ((t.tagName === 'INPUT' && t.type !== 'checkbox') || t.tagName === 'SELECT' ||
              t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (!piece() || !activeRing()) return;
    ev.preventDefault();
    nudge(k);
  }

  /* ---- Task 2: the rings in the scene ----------------------------------- */
  var group = null;

  function ensureGroup() {
    if (typeof THREE === 'undefined' || typeof state === 'undefined' || !state || !state.scene)
      return null;
    if (!group) {
      group = new THREE.Group();
      group.name = 'nso-rotate-handles';
      group.renderOrder = 999;
      state.scene.add(group);
    }
    return group;
  }
  function clearGroup(g) {
    while (g.children.length) {
      var c = g.children.pop();
      /* A sprite's geometry is THREE's one shared quad, and its texture is
         cached in labelTexture - only its material is its own. */
      if (c.geometry && !c.isSprite) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
  }

  /* ---- the radius --------------------------------------------------------
     One size for the machine, not one per piece: 45% of the bed's shorter
     side, read from the plate the app is set to (getCurrentPlate - the
     PLATES preset or the custom size), so an A1 Mini's rings are 81 mm in
     radius - a 162 mm ring inside its 180 mm bed - and a 256 mm bed's 115.2.
     Sized off the piece, a long bar got rings wider than the bed and a small
     part tiny ones, and every bake re-sized them. A piece bigger than the
     rings is fine - the arrowheads are the handles, not the ring body - and
     a small one sits inside rings it can be seen through. Ticks, labels'
     offset, the tube and the arrowheads are all fractions of this radius. */
  var RING_BED_FRACTION = 0.45, RING_FALLBACK_MM = 81;
  function bedShortSide() {
    var pl = (typeof getCurrentPlate === 'function') ? getCurrentPlate() : null;
    var w = pl && Number(pl.w), d = pl && Number(pl.d);
    return (w > 0 && d > 0) ? Math.min(w, d) : 0;
  }
  function ringRadius() {
    var b = bedShortSide();
    return b ? b * RING_BED_FRACTION : RING_FALLBACK_MM;
  }

  /* ---- the pivot -----------------------------------------------------------
     A turn is about the centre of the piece's bounding sphere - the centre
     of its own geometry's sphere, which the load centres on the mesh origin.
     applyMeshRotation then re-seats the piece on the plate from its NEW box,
     so on every step of a turn the centre rose and fell with the box, and the
     rings, sitting on it, walked away from under the pointer.

     So while a turn is in hand the pivot is HELD: taken once, at the press,
     and the piece is turned about that fixed point - free to pass through
     the plate on the way, which is expected and not clamped - with the rings
     standing on it. The piece is seated on the plate once, when the turn is
     put down, and the rings move to the seated centre in that one step.

     "In hand" is a drag from press to release, and a RUN of clicks on one
     arrowhead (or presses of one arrow key) less than RUN_MS apart: the run
     is seated RUN_MS after its last step, so fifteen clicks of a degree turn
     about one pivot and land once. A single step lands RUN_MS after it.

     The pose fields are written on every step as before - only the mesh's
     height is held - so export, Undo and everything else that reads the
     record never sees anything but a seated pose: every Undo point taken
     inside a run records the height the piece will be seated at. */
  var RUN_MS = 600;
  var hold = null;              // { p, pivot, cL, lastPos, lastQ, ring, dir, timer }
  function localCentre(mesh) {
    var g = mesh.geometry;
    if (!g) return new THREE.Vector3();
    if (!g.boundingSphere) g.computeBoundingSphere();
    return g.boundingSphere ? g.boundingSphere.center.clone() : new THREE.Vector3();
  }
  function seatedY(p) { return (p.height || 0) / 2 + 0.2 + (p.liftY || 0); }
  /* the hold is still ours: the piece is exactly where the last held step
     left it - nothing else (an Undo, another tool) has moved it since */
  function holdIntact() {
    var p = hold && hold.p;
    return !!(p && p.mesh && p.mesh.position.distanceTo(hold.lastPos) < 1e-9 &&
              Math.abs(p.mesh.quaternion.dot(hold.lastQ)) > 1 - 1e-12);
  }
  function startHold(p, ring, dir) {
    if (hold && (hold.p !== p || !holdIntact())) dropHold();
    if (hold) return hold;
    p.mesh.updateMatrixWorld(true);
    var cL = localCentre(p.mesh);
    hold = { p: p, cL: cL, pivot: cL.clone().applyMatrix4(p.mesh.matrixWorld),
             lastPos: p.mesh.position.clone(), lastQ: p.mesh.quaternion.clone(),
             ring: ring, dir: dir, timer: 0 };
    return hold;
  }
  function dropHold() {
    if (hold && hold.timer) clearTimeout(hold.timer);
    hold = null;
  }
  /* Put the turn down: seat the piece on the plate, once, as
     applyMeshRotation always has, and let the rings follow in one step. */
  function seat() {
    if (!hold) return;
    var h = hold;
    var mine = holdIntact();
    dropHold();
    if (!mine) return;          // something else has already re-placed it
    if (typeof applyMeshRotation === 'function') applyMeshRotation(h.p);
    if (typeof refreshOutline === 'function') refreshOutline(h.p);
    if (typeof updateExportButton === 'function') updateExportButton();
    refresh();
  }
  function seatLater() {
    if (!hold) return;
    if (hold.timer) clearTimeout(hold.timer);
    hold.timer = setTimeout(seat, RUN_MS);
  }

  /* About the 14 mm they were on #141's rings, which were 66 mm in radius on
     the drive-check's box - now a straight fraction of the radius, so a
     bigger bed's rings carry bigger arrowheads. */
  function arrowSize(r) { return r * 0.18; }
  /* The two arrowheads sit either side of arrowAt[ring], a little apart,
     pointing away from each other along the ring. */
  function arrowGap(r) { return arrowSize(r) * 0.8 / r; }
  function ringPoint(F, r, t) {
    return F.e1.clone().multiplyScalar(Math.cos(t) * r).add(F.e2.clone().multiplyScalar(Math.sin(t) * r));
  }
  function ringTangent(F, t) {
    return F.e1.clone().multiplyScalar(-Math.sin(t)).add(F.e2.clone().multiplyScalar(Math.cos(t)));
  }

  /* Where a ring's arrowheads go when it is first drawn: the point of the
     ring nearest the camera, so they face you rather than hide behind the
     piece. After that they ride the ring with the piece. */
  function defaultArrowAt(F, centre) {
    if (!state.camera) return 0;
    var v = state.camera.position.clone().sub(centre);
    var u = v.dot(F.e1), w = v.dot(F.e2);
    return Math.hypot(u, w) < 1e-6 ? 0 : Math.atan2(w, u);
  }

  /* ---- weights -----------------------------------------------------------
     At rest every ring is drawn the same. While one is dragged the rails get
     QUIETER, not louder: the active ring thins and goes see-through so the
     piece reads through it at the moment its angle is being judged, and the
     other two fade to a trace. The arrowhead under the pointer keeps full
     weight, so the grab point never goes soft. Colours never change - the one
     white is the snap's flash. Release, and refresh draws rest weight again. */
  var WEIGHT = {
    rest:     { tube: 1,   ring: 0.7,  arrow: 0.95, ticks: 0.4,  label: 0.9 },
    active:   { tube: 0.6, ring: 0.35, arrow: 0.35, ticks: 0.2,  label: 0.45 },
    inactive: { tube: 1,   ring: 0.12, arrow: 0.12, ticks: 0.06, label: 0.12 }
  };
  /* A press is not yet a drag: a click on an arrowhead leaves the rails at
     rest weight, and they go quiet only once the pointer has really moved. */
  function dragging() { return !!(drag && drag.moved); }
  function weightFor(ring) {
    if (!dragging()) return WEIGHT.rest;
    return drag.ring === ring ? WEIGHT.active : WEIGHT.inactive;
  }
  function restTube(r) { return Math.max(0.3, r * 0.016); }

  function colourFor(ring) {
    var lit = drag && drag.ring === ring;
    if (lit && Date.now() < flashUntil) return { c: 0xffffff, o: 1 };
    return { c: RINGS[ring].color, o: weightFor(ring).ring };
  }

  /* ---- the scale ---------------------------------------------------------
     Ticks on the ring's outer edge - short every 15, longer every 45, longest
     on the quarters - and 0 / 90 / 180 / 270 beside the quarters. All of it
     is in the ring's own frame (the same e1, e2 the snap measures in), so it
     turns with nothing: it is the fixed scale the piece turns against, and a
     snapped quarter turn puts the piece's measured axis exactly on a
     labelled tick. Ticks are one line-segment set per ring, one draw call. */
  var TICK_LEN = { 15: 0.045, 45: 0.08, 90: 0.12 };   // x radius
  function tickClass(deg) { return deg % 90 === 0 ? 90 : deg % 45 === 0 ? 45 : 15; }
  function tickOuter(r) { return r + restTube(r) + TICK_LEN[90] * r; }
  function labelRadius(r) { return tickOuter(r) + 0.09 * r; }
  function noRaycast() {}

  function addTicks(g, ring, F, r, w) {
    var R = RINGS[ring], e1 = F.e1, e2 = F.e2, pts = [];
    var r0 = r + restTube(r);
    for (var d = 0; d < 360; d += 15) {
      var t = d * RAD, dir = e1.clone().multiplyScalar(Math.cos(t)).add(e2.clone().multiplyScalar(Math.sin(t)));
      pts.push(dir.clone().multiplyScalar(r0), dir.clone().multiplyScalar(r0 + TICK_LEN[tickClass(d)] * r));
    }
    var l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: R.color, depthTest: false, depthWrite: false,
                                    transparent: true, opacity: w.ticks }));
    l.renderOrder = 999;
    l.raycast = noRaycast;
    l.userData.nsoRotateTicks = ring;
    g.add(l);
  }

  /* The four labels: sprites, so they always face the camera, and sized in
     SCREEN terms (sizeAttenuation off) so they read the same at any zoom.
     One canvas texture per ring and label, made once and kept. */
  var LABEL_PX = 0.032;          // label height as a fraction of the view's height, roughly
  var labelTextures = {};
  function labelTexture(ring, text) {
    var key = ring + ':' + text;
    if (labelTextures[key]) return labelTextures[key];
    var cv = document.createElement('canvas');
    cv.width = 128; cv.height = 64;
    var x = cv.getContext('2d');
    x.font = '700 44px system-ui, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineWidth = 8; x.strokeStyle = 'rgba(10, 16, 30, 0.9)';
    x.strokeText(text, 64, 34);
    x.fillStyle = RINGS[ring].css;
    x.fillText(text, 64, 34);
    var tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    return (labelTextures[key] = tex);
  }
  /* Each label sits a few degrees past its tick, along its own ring. The
     three rings cross on the plate's axes, so every quarter of one ring is
     the same point as a quarter of another - Turn's 0 and Lean front/back's
     90 are both straight out along Z. Centred on the tick, two labels print
     on top of each other; nudged along their own rings, whose tangents differ
     there, they part. */
  var LABEL_SHIFT_DEG = 9;
  function addLabels(g, ring, F, r, w) {
    var e1 = F.e1, e2 = F.e2, lr = labelRadius(r);
    [0, 90, 180, 270].forEach(function (d) {
      var t = (d + LABEL_SHIFT_DEG) * RAD;
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture(ring, String(d)),
        depthTest: false, depthWrite: false, transparent: true, opacity: w.label,
        sizeAttenuation: false }));
      sp.position.copy(e1.clone().multiplyScalar(Math.cos(t) * lr).add(e2.clone().multiplyScalar(Math.sin(t) * lr)));
      sp.scale.set(LABEL_PX * 2, LABEL_PX, 1);
      sp.renderOrder = 1001;
      sp.raycast = noRaycast;
      sp.userData.nsoRotateLabel = { ring: ring, deg: d };
      g.add(sp);
    });
  }

  function addRing(g, ring, F, r) {
    var col = colourFor(ring), w = weightFor(ring);
    var tube = restTube(r) * w.tube;
    var geo = new THREE.TorusGeometry(r, tube, 6, 160);
    // Torus lies in XY with its axis on Z: carry X, Y, Z onto e1, e2, A.
    geo.applyMatrix4(new THREE.Matrix4().makeBasis(F.e1, F.e2, F.A));
    var mat = new THREE.MeshBasicMaterial({ color: col.c, depthTest: false, depthWrite: false,
                                            transparent: true, opacity: col.o });
    var m = new THREE.Mesh(geo, mat);
    m.renderOrder = 999;
    m.userData.nsoRotateRing = ring;          // the track: drawn, never a handle
    g.add(m);
    addTicks(g, ring, F, r, w);
    addLabels(g, ring, F, r, w);

    var t = arrowAt[ring], h = arrowSize(r), gap = arrowGap(r);
    [1, -1].forEach(function (dir) {
      var at = t + dir * gap;
      var pos = ringPoint(F, r, at);
      var tan = ringTangent(F, at).multiplyScalar(dir);
      var handle = { ring: ring, dir: dir };
      /* the arrowhead under the pointer keeps full weight through a drag */
      var held = dragging() && drag.ring === ring && drag.dir === dir;
      var cone = new THREE.Mesh(new THREE.ConeGeometry(h * 0.45, h, 18),
        new THREE.MeshBasicMaterial({ color: held ? RINGS[ring].color : col.c, depthTest: false,
                                      depthWrite: false, transparent: true,
                                      opacity: held ? 1 : (col.c === 0xffffff ? 1 : w.arrow) }));
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tan);
      cone.position.copy(pos);
      cone.renderOrder = 1000;
      cone.userData.nsoRotateHandle = handle;
      g.add(cone);
      /* A grab target a little bigger than the cone, drawn as nothing. The
         raycaster still finds it: it tests the geometry, not the material. */
      var hit = new THREE.Mesh(new THREE.SphereGeometry(h * 0.7, 10, 8),
        new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.copy(pos);
      hit.userData.nsoRotateHandle = handle;
      g.add(hit);
    });
  }

  /* The rings exist only while this menu owns the input. Losing it EMPTIES
     the group, disposing every geometry and material, so there is nothing
     left in the scene for app-core's pointerdown to hit - it hit-tests this
     group ahead of select-and-drag, and `visible` is the flag it trusts. */
  function refresh() {
    var g = ensureGroup();
    if (!g) return;
    clearGroup(g);
    var p = piece();
    var list = shown ? shownRings() : [];
    if (hold && !holdIntact()) dropHold();      // re-placed under us: nothing held any more
    if (!p || !list.length || !menuOwnsInput()) { g.visible = false; return; }
    g.visible = true;
    g.position.copy(ringCentre(p));
    g.updateMatrixWorld(true);
    var r = ringRadius(), q = p.mesh.quaternion.clone();
    list.forEach(function (ring) {
      var F = frameOf(ring, q);
      if (arrowAt[ring] == null) arrowAt[ring] = defaultArrowAt(F, g.position);
      addRing(g, ring, F, r);
    });
  }

  /* Where the rings stand: on the held pivot while a turn is in hand,
     otherwise on the piece's bounding-sphere centre as it sits. */
  function ringCentre(p) {
    if (hold && hold.p === p && holdIntact()) return hold.pivot.clone();
    p.mesh.updateMatrixWorld(true);
    return localCentre(p.mesh).applyMatrix4(p.mesh.matrixWorld);
  }

  /* An arrowhead's place on screen, in client pixels - for the checks, and
     for the readout after a key press. */
  function handleScreen(ring, dir) {
    var p = piece();
    if (!p || !state.camera || !state.renderer || arrowAt[ring] == null) return null;
    var r = ringRadius();
    var w = ringPoint(frameOf(ring, pieceQ()), r, arrowAt[ring] + (dir || 1) * arrowGap(r)).add(ringCentre(p));
    var v = w.project(state.camera);
    var c = state.renderer.domElement.getBoundingClientRect();
    return { x: c.left + (v.x * 0.5 + 0.5) * c.width, y: c.top + (-v.y * 0.5 + 0.5) * c.height };
  }
  function centreScreen() {
    var p = piece();
    if (!p || !state.camera || !state.renderer) return null;
    var v = ringCentre(p).project(state.camera);
    var c = state.renderer.domElement.getBoundingClientRect();
    return { x: c.left + (v.x * 0.5 + 0.5) * c.width, y: c.top + (-v.y * 0.5 + 0.5) * c.height };
  }

  /* ---- wiring ------------------------------------------------------------ */
  function bind() {
    if (!shown) resetSession();
    ORDER.forEach(function (k) {
      var chk = document.getElementById(RINGS[k].chk);
      if (chk && !chk._rotBound) {
        chk._rotBound = true;
        chk.addEventListener('change', function () { setRing(k, chk.checked); });
        chk.checked = !!shown[k];
      }
    });
    if (!document._rotKeysBound) {
      document._rotKeysBound = true;
      document.addEventListener('keydown', onKeyDown);
    }
    /* A different machine is a different ring size: redraw once app-core
       has switched the plate (its own change handler runs first). */
    var plateSel = document.getElementById('plate-select');
    if (plateSel && !plateSel._rotBound) {
      plateSel._rotBound = true;
      plateSel.addEventListener('change', function () { setTimeout(refresh, 0); });
    }
    /* Losing the menu ends any drag in flight before the rings go - endDrag
       gives OrbitControls back - and puts the ring choice back to Turn only,
       which is what makes the next opening start fresh. */
    if (window.nsoInputMode) {
      window.nsoInputMode.register('menu-rotate', {
        activate: refresh,
        teardown: function () { if (drag) endDrag(true); seat(); hideReadout(); resetSession(); refresh(); }
      });
    }
    refresh();
  }

  window.nsoRotate = {
    rings: function () { return shownRings(); },
    setRing: setRing,
    activeRing: activeRing,
    step: function (ring, dir) { return stepBy(ring, (dir < 0 ? -1 : 1) * STEP_DEG); },
    /* A programmatic turn of `deg` about a ring's axis - the plate's vertical
       for Turn, the piece's own X / Z for the leans - no Undo point and no
       lock check: what a click does, without the click. The pose
       buttons (app-core's rotateSelected / tiltSelected / bankSelected) call
       this and keep their own Undo, lock and status around it.

       opts.snap: land on a quarter turn if the turn ends within the hard
       snap of one - the drag's own snap, measured the drag's own way
       (ringAngleDeg on the piece's axis nearest the ring's plane), so a 90
       degree button from 2 degrees off square lands ON square and a run of
       them stays exact. Off by default: a click, a key and a tilt step are
       exactly what they say. */
    turn: function (ring, deg, opts) {
      var p = piece();
      if (!p || !RINGS[ring]) return false;
      p.mesh.updateMatrixWorld(true);
      var q0 = p.mesh.quaternion.clone();
      if (opts && opts.snap) {
        var abs0 = ringAngleDeg(q0, ring, refAxis(q0, ring));
        deg = hardSnapDeg(abs0 + deg) - abs0;
      }
      writePose(p, turned(q0, ring, deg));
      refresh();
      return true;
    },
    nudge: nudge,
    beginDrag: beginDrag, moveDrag: moveDrag, endDrag: endDrag,
    dragging: function () { return !!drag; },
    dragState: function () {
      return drag ? { ring: drag.ring, raw: drag.raw, applied: drag.applied, sign: drag.sign,
                      moved: drag.moved, snapped: drag.snapped } : null;
    },
    /* A ring's axis in the world, now: the plate's vertical for Turn, the
       piece's own Z / X as it lies for the two leans. */
    ringAxis: function (ring) { return RINGS[ring] ? frameOf(ring, pieceQ()).A.toArray() : null; },
    ringFrame: function (ring) {
      if (!RINGS[ring]) return null;
      var F = frameOf(ring, pieceQ());
      return { A: F.A.toArray(), e1: F.e1.toArray(), e2: F.e2.toArray() };
    },
    /* The piece's angle on a ring as the snap sees it (see ringAngleDeg). */
    ringAngle: function (ring) {
      var p = piece();
      if (!p) return null;
      p.mesh.updateMatrixWorld(true);
      var q = p.mesh.quaternion;
      return ringAngleDeg(q, ring, refAxis(q, ring));
    },
    dialSign: dialSign,
    hardSnapDeg: hardSnapDeg,
    decompose: decompose,
    readout: function () { return lastReadout; },
    readoutShown: function () { return !!(readout && !readout.hidden); },
    flashes: function () { return flashes; },
    handleScreen: handleScreen,
    centreScreen: centreScreen,
    refresh: refresh,
    handleCount: function () {
      var g = ensureGroup();
      return g ? g.children.filter(function (c) {   // arrowheads drawn, not their grab spheres
        return c.userData.nsoRotateHandle && c.material && c.material.visible;
      }).length : 0;
    },
    /* The ring radius: 45% of the bed's shorter side, the same for every piece. */
    ringRadius: function () { return ringRadius(); },
    /* The piece a turn is holding on its pivot (unseated) right now, or null -
       nso-watch asks, so a turn in hand is not reported as a piece off its bed. */
    holding: function () { return hold && holdIntact() ? hold.p : null; },
    pivot: function () { return hold && holdIntact() ? hold.pivot.toArray() : null; },
    ringCentre: function () { var p = piece(); return p ? ringCentre(p).toArray() : null; },
    /* Put a run down now, as its timer would. */
    seat: seat,
    weights: WEIGHT,
    ringCount: function () {
      var g = ensureGroup();
      return g ? g.children.filter(function (c) { return c.userData.nsoRotateRing; }).length : 0;
    },
    constants: { STEP_DEG: STEP_DEG, SNAP_STEP_DEG: SNAP_STEP_DEG,
                 SNAP_WITHIN_DEG: SNAP_WITHIN_DEG, CLICK_SLOP_PX: CLICK_SLOP_PX,
                 RING_BED_FRACTION: RING_BED_FRACTION, RUN_MS: RUN_MS, TICK_LEN: TICK_LEN,
                 LABEL_SHIFT_DEG: LABEL_SHIFT_DEG,
                 LOCAL: { fb: RINGS.fb.local, ss: RINGS.ss.local } }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
