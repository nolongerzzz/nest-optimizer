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

   Every rotation here is about a fixed axis of the plate - vertical (Turn),
   the plate's X (Lean front/back), the plate's Z (Lean side/side). A click or
   a drag step is one world-axis rotation premultiplied onto the piece's
   orientation, and the result is decomposed back into the SAME pose fields,
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
    turn: { axis: [0, 1, 0], e1: [0, 0, 1], e2: [1, 0, 0], color: 0x38bdf8, css: '#38bdf8',
            label: 'Turn', chk: 'chk-rot-ring-turn' },
    fb:   { axis: [1, 0, 0], e1: [0, 1, 0], e2: [0, 0, 1], color: 0xf472b6, css: '#f472b6',
            label: 'Lean front/back', chk: 'chk-rot-ring-fb' },
    ss:   { axis: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0], color: 0xfbbf24, css: '#fbbf24',
            label: 'Lean side/side', chk: 'chk-rot-ring-ss' }
  };
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
  function writePose(p, q) {
    var e = decompose(q, fieldEuler(p));
    p.tiltX = clean(wrapDeg(e.x * DEG - (p.tipX || 0) * 90 - (p.flipX ? 180 : 0)), 9);
    p.rotY = clean(wrapPi(e.y), 12);
    p.tiltZ = clean(wrapDeg(e.z * DEG - (p.tipZ || 0) * 90), 9);
    if (typeof applyMeshRotation === 'function') applyMeshRotation(p);
    if (typeof refreshOutline === 'function') refreshOutline(p);
  }

  /* R(axis, deg) * q0: a turn about the PLATE's axis, whatever q0 already is. */
  function turned(q0, ring, deg) {
    return new THREE.Quaternion().setFromAxisAngle(v3(RINGS[ring].axis), deg * RAD).multiply(q0);
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
    var A = v3(RINGS[ring].axis), best = null, bestLen = -1;
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach(function (b) {
      var v = v3(b).applyQuaternion(q);
      var len = 1 - Math.pow(v.dot(A), 2);
      if (len > bestLen + 1e-9) { bestLen = len; best = b; }
    });
    return best;
  }
  function ringAngleDeg(q, ring, b) {
    var R = RINGS[ring], v = v3(b).applyQuaternion(q);
    return Math.atan2(v.dot(v3(R.e2)), v.dot(v3(R.e1))) * DEG;
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
    var d = look.dot(v3(RINGS[ring].axis));
    return d < 0 ? -1 : 1;
  }

  /* ---- turning ----------------------------------------------------------- */
  function refuse(p) {
    return typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'rotate');
  }
  function undoPoint() {
    if (typeof pushUndo === 'function' && typeof snapshotPlacedPose === 'function')
      pushUndo(snapshotPlacedPose(state.selectedIndex));
  }

  /* One step of `deg` about a ring, no snap - a click, a key. */
  function stepBy(ring, deg) {
    var p = piece();
    if (!p || !RINGS[ring]) return false;
    if (refuse(p)) return false;
    undoPoint();
    p.mesh.updateMatrixWorld(true);
    writePose(p, turned(p.mesh.quaternion.clone(), ring, deg));
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
    undoPoint();
    p.mesh.updateMatrixWorld(true);
    var q0 = p.mesh.quaternion.clone();
    var b = refAxis(q0, ring);
    drag = { ring: ring, dir: dir, x0: x, y0: y, cx: cx, cy: cy,
             lastA: Math.atan2(y - cy, x - cx) * DEG, raw: 0, applied: 0,
             sign: dialSign(ring), q0: q0, b: b, abs0: ringAngleDeg(q0, ring, b),
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
    writePose(p, turned(drag.q0, drag.ring, drag.applied));
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
      var p = piece();
      if (p) {
        p.mesh.updateMatrixWorld(true);
        writePose(p, turned(p.mesh.quaternion.clone(), d.ring, d.dir * STEP_DEG));
        if (arrowAt[d.ring] != null) arrowAt[d.ring] += d.dir * STEP_DEG * RAD;
        say(d.ring, d.dir * STEP_DEG * d.sign, false);
      }
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
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
  }

  function ringRadius(p) {
    return Math.max(8, (Math.max(p.width || 0, p.depth || 0, p.height || 0) / 2) * 1.45);
  }
  function arrowSize(r) { return Math.min(14, Math.max(3.5, r * 0.26)); }
  /* The two arrowheads sit either side of arrowAt[ring], a little apart,
     pointing away from each other along the ring. */
  function arrowGap(r) { return arrowSize(r) * 0.8 / r; }
  function ringPoint(ring, r, t) {
    var R = RINGS[ring];
    return v3(R.e1).multiplyScalar(Math.cos(t) * r).add(v3(R.e2).multiplyScalar(Math.sin(t) * r));
  }
  function ringTangent(ring, t) {
    var R = RINGS[ring];
    return v3(R.e1).multiplyScalar(-Math.sin(t)).add(v3(R.e2).multiplyScalar(Math.cos(t)));
  }

  /* Where a ring's arrowheads go when it is first drawn: the point of the
     ring nearest the camera, so they face you rather than hide behind the
     piece. After that they ride the ring with the piece. */
  function defaultArrowAt(ring, centre) {
    if (!state.camera) return 0;
    var R = RINGS[ring];
    var v = state.camera.position.clone().sub(centre);
    var u = v.dot(v3(R.e1)), w = v.dot(v3(R.e2));
    return Math.hypot(u, w) < 1e-6 ? 0 : Math.atan2(w, u);
  }

  function colourFor(ring) {
    var lit = drag && drag.ring === ring;
    if (lit && Date.now() < flashUntil) return { c: 0xffffff, o: 1 };
    return { c: RINGS[ring].color, o: lit ? 1 : 0.7 };
  }

  function addRing(g, ring, r) {
    var col = colourFor(ring);
    var tube = Math.max(0.3, r * 0.016) * (drag && drag.ring === ring ? 1.8 : 1);
    var geo = new THREE.TorusGeometry(r, tube, 6, 160);
    // Torus lies in XY with its axis on Z; turn Z onto the ring's axis.
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1), v3(RINGS[ring].axis)));
    var mat = new THREE.MeshBasicMaterial({ color: col.c, depthTest: false, depthWrite: false,
                                            transparent: true, opacity: col.o });
    var m = new THREE.Mesh(geo, mat);
    m.renderOrder = 999;
    m.userData.nsoRotateRing = ring;          // the track: drawn, never a handle
    g.add(m);

    var t = arrowAt[ring], h = arrowSize(r), gap = arrowGap(r);
    [1, -1].forEach(function (dir) {
      var at = t + dir * gap;
      var pos = ringPoint(ring, r, at);
      var tan = ringTangent(ring, at).multiplyScalar(dir);
      var handle = { ring: ring, dir: dir };
      var cone = new THREE.Mesh(new THREE.ConeGeometry(h * 0.45, h, 18),
        new THREE.MeshBasicMaterial({ color: col.c, depthTest: false, depthWrite: false,
                                      transparent: true, opacity: Math.min(1, col.o + 0.25) }));
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
    if (!p || !list.length || !menuOwnsInput()) { g.visible = false; return; }
    g.visible = true;
    g.position.copy(p.mesh.position);
    g.updateMatrixWorld(true);
    var r = ringRadius(p);
    list.forEach(function (ring) {
      if (arrowAt[ring] == null) arrowAt[ring] = defaultArrowAt(ring, g.position);
      addRing(g, ring, r);
    });
  }

  /* An arrowhead's place on screen, in client pixels - for the checks, and
     for the readout after a key press. */
  function handleScreen(ring, dir) {
    var p = piece();
    if (!p || !state.camera || !state.renderer || arrowAt[ring] == null) return null;
    var r = ringRadius(p);
    var w = ringPoint(ring, r, arrowAt[ring] + (dir || 1) * arrowGap(r)).add(p.mesh.position);
    var v = w.project(state.camera);
    var c = state.renderer.domElement.getBoundingClientRect();
    return { x: c.left + (v.x * 0.5 + 0.5) * c.width, y: c.top + (-v.y * 0.5 + 0.5) * c.height };
  }
  function centreScreen() {
    var p = piece();
    if (!p || !state.camera || !state.renderer) return null;
    var v = p.mesh.position.clone().project(state.camera);
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
    /* Losing the menu ends any drag in flight before the rings go - endDrag
       gives OrbitControls back - and puts the ring choice back to Turn only,
       which is what makes the next opening start fresh. */
    if (window.nsoInputMode) {
      window.nsoInputMode.register('menu-rotate', {
        activate: refresh,
        teardown: function () { if (drag) endDrag(true); hideReadout(); resetSession(); refresh(); }
      });
    }
    refresh();
  }

  window.nsoRotate = {
    rings: function () { return shownRings(); },
    setRing: setRing,
    activeRing: activeRing,
    step: function (ring, dir) { return stepBy(ring, (dir < 0 ? -1 : 1) * STEP_DEG); },
    /* A programmatic turn of `deg` about a ring's plate axis, no snap, no
       Undo point - what a click does, without the click. */
    turn: function (ring, deg) {
      var p = piece();
      if (!p || !RINGS[ring]) return false;
      p.mesh.updateMatrixWorld(true);
      writePose(p, turned(p.mesh.quaternion.clone(), ring, deg));
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
    ringCount: function () {
      var g = ensureGroup();
      return g ? g.children.filter(function (c) { return c.userData.nsoRotateRing; }).length : 0;
    },
    constants: { STEP_DEG: STEP_DEG, SNAP_STEP_DEG: SNAP_STEP_DEG,
                 SNAP_WITHIN_DEG: SNAP_WITHIN_DEG, CLICK_SLOP_PX: CLICK_SLOP_PX,
                 AXES: { turn: RINGS.turn.axis, fb: RINGS.fb.axis, ss: RINGS.ss.axis } }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
