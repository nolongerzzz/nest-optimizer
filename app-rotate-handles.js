/* Rotation handles - a grab target for freehand rotation, per axis.

   WHAT WAS THERE BEFORE. Nothing, for a placed piece. A piece on the plate
   rotated only in steps, through buttons: Yaw 90 (rotateSelected), Tip 90,
   Roll 90, and Pitch / Bank in 15 degree clicks. The one freehand rotation
   in the whole app is `state.editYawDragging` in app-core.js, and it is a
   different thing in a different place - it is armed only while the CUTTER
   is open, it drags the edit preview rather than a placed piece, and it maps
   a HORIZONTAL drag to yaw at 0.15 deg/px with a comment saying it is
   deliberately low. None of the buttons are touched here; see the bottom of
   this file for what that promise is worth and how it is checked.

   THE TWO AXES. X is pitch, stored in `p.tiltX` in degrees - the same field
   the Pitch buttons move in 15s. Y is yaw, stored in `p.rotY` in RADIANS -
   the same field the 90 buttons move. Both are read and written through
   angleOf/setAngle below so the units live in exactly one place; everything
   else in this file is degrees.

   THE MAPPING is a dial, not a gain: the pointer's angle about the guide's
   centre is the rotation. Trace 30 degrees around the arc and the piece
   turns 30 degrees, which is why dragging the handle needs no sensitivity
   constant at all. The trackball is the exception and is discussed there. */
(function () {
  'use strict';

  var ARC_WINDOW_DEG = 45;      // how much of the path is on screen at once
  var ARC_LEAD = 2 / 3;         // ...and how much of that sits AHEAD of you
  var TICK_DEG = 1;             // gradations along the visible arc
  var SNAP_STEP_DEG = 45;       // soft detents: 45 and, being a multiple, 90
  var NUDGE_DEG = 1;            // one arrow press

  /* Soft snap, lifted from plateGridSnapAxis in app-core.js rather than
     reinvented - same function, same two constants, angles instead of mm:

         f(d) = sign(d) * R * ((1 - S) * u + S * u^2),   u = |d| / R

     f(R) = R so nothing jumps as the pull starts, f(0) = 0 so the detent is
     exactly reachable rather than merely approached, and f'(d) >= 1 - S > 0
     everywhere so the piece always turns the way the pointer went. R is half
     the step, so every angle lies in exactly one detent's pull and the field
     has no seams. The most it can ever displace you is S*R/4 = 4.5 degrees. */
  var SNAP_STRENGTH = 0.8;
  var SNAP_RADIUS_DEG = SNAP_STEP_DEG / 2;

  function softSnapDeg(deg) {
    var near = Math.round(deg / SNAP_STEP_DEG) * SNAP_STEP_DEG;
    var d = deg - near, a = Math.abs(d);
    if (a >= SNAP_RADIUS_DEG) return deg;
    var u = a / SNAP_RADIUS_DEG;
    var pulled = SNAP_RADIUS_DEG * ((1 - SNAP_STRENGTH) * u + SNAP_STRENGTH * u * u);
    return near + (d < 0 ? -pulled : pulled);
  }

  /* ---- locks -------------------------------------------------------------
     A mode, not a property of a piece: the checkbox means "I am working on
     one axis right now", and it would be a trap if it silently changed
     meaning when the selection did. A locked axis has no handle to grab and
     refuses its arrow keys. */
  function locked(axis) {
    return !!(typeof state !== 'undefined' && state &&
              (axis === 'x' ? state.rotLockX : state.rotLockY));
  }
  function setLock(axis, on) {
    if (typeof state === 'undefined' || !state) return;
    if (axis === 'x') state.rotLockX = !!on; else state.rotLockY = !!on;
    var chk = document.getElementById(axis === 'x' ? 'chk-rot-lock-x' : 'chk-rot-lock-y');
    if (chk) chk.checked = !!on;
    refresh();
    if (typeof setStatus === 'function') {
      setStatus('Rotation ' + axis.toUpperCase() + (on ? ' locked' : ' unlocked') +
                ' - ' + modeLabel());
    }
  }

  /* Which control is on the piece right now. Both axes free is ONE handle,
     not two: a trackball that takes a drag in any direction, because two
     dials side by side cannot express a rotation that is a bit of each. */
  function mode() {
    var lx = locked('x'), ly = locked('y');
    if (lx && ly) return 'none';
    if (!lx && !ly) return 'trackball';
    return lx ? 'y' : 'x';
  }
  function modeLabel() {
    var m = mode();
    return m === 'none' ? 'both axes locked' :
           m === 'trackball' ? 'trackball: drag any direction' :
           'single axis: ' + m.toUpperCase();
  }

  /* ---- the piece, and its angle on an axis ------------------------------- */
  function piece() {
    if (typeof state === 'undefined' || !state || !state.placed) return null;
    var p = state.placed[state.selectedIndex];
    return (p && p.mesh) ? p : null;
  }
  function angleOf(p, axis) {
    if (!p) return 0;
    return axis === 'x' ? (p.tiltX || 0) : ((p.rotY || 0) * 180 / Math.PI);
  }
  function setAngle(p, axis, deg) {
    if (!p) return;
    var d = ((deg % 360) + 540) % 360 - 180;          // to (-180, 180]
    if (axis === 'x') p.tiltX = d; else p.rotY = d * Math.PI / 180;
    if (typeof applyMeshRotation === 'function') applyMeshRotation(p);
    if (typeof refreshOutline === 'function') refreshOutline(p);
  }

  /* ---- the arc window ----------------------------------------------------
     45 degrees of the path, scrolling with the drag so the travel you are
     about to make is always drawn. Two thirds of the window sits ahead of
     the current angle and a third behind, so there is somewhere to have come
     from without the window being half wasted on it.

     The gradations are at whole degrees of the PIECE's angle and move with
     the window, which is what makes the thing read as a scrolling tape
     rather than a fixed protractor the piece slides under. */
  function arcWindow(deg) {
    var lead = ARC_WINDOW_DEG * ARC_LEAD;
    var start = deg - (ARC_WINDOW_DEG - lead);
    var end = start + ARC_WINDOW_DEG;
    var ticks = [];
    var first = Math.ceil(start / TICK_DEG) * TICK_DEG;
    for (var t = first; t <= end + 1e-9; t += TICK_DEG) {
      ticks.push({ deg: +t.toFixed(6),
                   major: Math.abs(t / SNAP_STEP_DEG - Math.round(t / SNAP_STEP_DEG)) < 1e-9,
                   frac: (t - start) / ARC_WINDOW_DEG });
    }
    return { start: start, end: end, span: ARC_WINDOW_DEG, at: deg, ticks: ticks };
  }

  /* ---- dragging ---------------------------------------------------------- */
  var drag = null;

  function beginDrag(axis, x, y, cx, cy) {
    var p = piece();
    if (!p) return false;
    if (axis !== 'trackball' && locked(axis)) return false;
    if (axis === 'trackball' && mode() !== 'trackball') return false;
    if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'rotate')) return false;
    if (typeof pushUndo === 'function' && typeof snapshotPlacedPose === 'function')
      pushUndo(snapshotPlacedPose(state.selectedIndex));
    drag = { axis: axis, cx: cx, cy: cy, lastX: x, lastY: y,
             lastA: Math.atan2(y - cy, x - cx) * 180 / Math.PI,
             raw: { x: angleOf(p, 'x'), y: angleOf(p, 'y') } };
    if (state.controls) state.controls.enabled = false;
    return true;
  }

  /* TRACKBALL SENSITIVITY, and the one number in this file that is a matter
     of taste rather than geometry.

     A single-axis drag needs no constant: it is a dial, and the pointer's
     own angle about the centre IS the rotation. The trackball cannot work
     that way - a drag in an arbitrary direction has no single centre to go
     round - so it maps pixels to degrees, and there the two axes do NOT want
     the same number.

     Y is the one that runs away. It is the axis the piece spins about while
     sitting flat on the plate, so a whole turn of it is visible edge-on and
     every degree reads; X pitches the piece toward or away from you, where
     the same degree is foreshortened to almost nothing near the top and
     bottom of its travel. Equal gains make Y feel about twice as fast as X
     for the same hand movement. Y is given half of X's, which lands them in
     the same place by eye. */
  var GAIN_X_DEG_PER_PX = 0.5;
  var GAIN_Y_DEG_PER_PX = 0.25;

  function moveDrag(x, y) {
    var p = piece();
    if (!drag || !p) return null;
    var out = {};
    if (drag.axis === 'trackball') {
      var dx = x - drag.lastX, dy = y - drag.lastY;
      drag.lastX = x; drag.lastY = y;
      drag.raw.y += dx * GAIN_Y_DEG_PER_PX;
      drag.raw.x += dy * GAIN_X_DEG_PER_PX;
      setAngle(p, 'y', softSnapDeg(drag.raw.y));
      setAngle(p, 'x', softSnapDeg(drag.raw.x));
      out.x = angleOf(p, 'x'); out.y = angleOf(p, 'y');
    } else {
      /* The dial. The pointer's angle about the guide's centre, differenced
         so the grab point does not have to be on the arc to start with, and
         unwrapped so a drag through the +/-180 seam keeps counting. */
      var a = Math.atan2(y - drag.cy, x - drag.cx) * 180 / Math.PI;
      var da = a - drag.lastA;
      while (da > 180) da -= 360;
      while (da < -180) da += 360;
      drag.lastA = a;
      drag.raw[drag.axis] += da;
      setAngle(p, drag.axis, softSnapDeg(drag.raw[drag.axis]));
      out[drag.axis] = angleOf(p, drag.axis);
    }
    refresh();
    if (typeof setStatus === 'function') {
      setStatus('Rotate ' + (drag.axis === 'trackball' ? 'XY' : drag.axis.toUpperCase()) +
                ' - X ' + angleOf(p, 'x').toFixed(0) + '°, Y ' + angleOf(p, 'y').toFixed(0) + '°');
    }
    return out;
  }

  function endDrag() {
    if (!drag) return;
    drag = null;
    if (typeof state !== 'undefined' && state && state.controls) state.controls.enabled = true;
    if (typeof updateExportButton === 'function') updateExportButton();
    refresh();
  }

  /* ---- keyboard ----------------------------------------------------------
     Left/right nudge X, up/down nudge Y, one degree a press. Held down, the
     browser's own key repeat does the repeating - the handler does not test
     event.repeat, which is the whole of "hold to keep going". */
  function nudge(axis, dir) {
    var p = piece();
    if (!p) return false;
    if (locked(axis)) return false;
    if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'rotate')) return false;
    if (typeof pushUndo === 'function' && typeof snapshotPlacedPose === 'function')
      pushUndo(snapshotPlacedPose(state.selectedIndex));
    setAngle(p, axis, angleOf(p, axis) + dir * NUDGE_DEG);
    refresh();
    if (typeof setStatus === 'function')
      setStatus('Rotate ' + axis.toUpperCase() + ' ' + angleOf(p, axis).toFixed(0) + '°');
    return true;
  }

  var KEYS = { ArrowLeft: ['x', -1], ArrowRight: ['x', 1],
               ArrowUp: ['y', -1], ArrowDown: ['y', 1] };

  /* Whether this menu owns the input right now. Asked of nsoInputMode rather
     than read off `#menu-rotate.open` directly, and the difference is the
     whole of the collision this file used to be half of.

     Tilt in app-tip-orient.js claims the same four arrows off #menu-tip. Two
     handlers each reading their own <details> are only exclusive if something
     guarantees one <details> - and the toggle-driven accordion does not, since
     toggle arrives a task later. Opening two menus in one turn left both open,
     and one ArrowUp then nudged AND tilted the same piece. nsoInputMode
     resolves the owner synchronously and collapses that state on the spot, so
     both handlers asking in the same turn get one answer between them.

     Without the arbiter on the page this falls back to the old read, which is
     right whenever the bar is in a sane state and is better than the tool
     going dead. */
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
    var t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' ||
              t.isContentEditable)) return;
    if (!piece()) return;
    if (locked(k[0])) return;
    ev.preventDefault();
    nudge(k[0], k[1]);
  }

  /* ---- the handles in the scene ----------------------------------------- */
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

  var COLOR = { x: 0xf472b6, y: 0x38bdf8, trackball: 0xfbbf24 };

  function ballAt(axis, radius, deg) {
    var geo = new THREE.SphereGeometry(Math.max(1.6, radius * 0.09), 16, 12);
    var mat = new THREE.MeshBasicMaterial({ color: COLOR[axis], depthTest: false,
                                            transparent: true, opacity: 0.95 });
    var m = new THREE.Mesh(geo, mat);
    m.renderOrder = 1000;
    m.userData.nsoRotateHandle = axis;
    var a = deg * Math.PI / 180;
    if (axis === 'x') m.position.set(0, Math.sin(a) * radius, Math.cos(a) * radius);
    else m.position.set(Math.cos(a) * radius, 0, Math.sin(a) * radius);
    return m;
  }

  function arcLine(axis, radius, win) {
    var pts = [], steps = 48;
    for (var i = 0; i <= steps; i++) {
      var d = win.start + (win.end - win.start) * (i / steps);
      var a = d * Math.PI / 180;
      pts.push(axis === 'x' ? new THREE.Vector3(0, Math.sin(a) * radius, Math.cos(a) * radius)
                            : new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
    }
    var geo = new THREE.BufferGeometry().setFromPoints(pts);
    var mat = new THREE.LineBasicMaterial({ color: COLOR[axis], depthTest: false,
                                            transparent: true, opacity: 0.75 });
    var l = new THREE.Line(geo, mat);
    l.renderOrder = 999;
    return l;
  }

  /* The 1 degree gradations, drawn as one line segment set so 46 ticks cost
     one draw call rather than 46. Every 45th is long - those are the detents. */
  function tickLines(axis, radius, win) {
    var pts = [];
    for (var i = 0; i < win.ticks.length; i++) {
      var t = win.ticks[i];
      var a = t.deg * Math.PI / 180;
      var r0 = radius * (t.major ? 0.88 : 0.945), r1 = radius * 1.03;
      if (axis === 'x') {
        pts.push(new THREE.Vector3(0, Math.sin(a) * r0, Math.cos(a) * r0));
        pts.push(new THREE.Vector3(0, Math.sin(a) * r1, Math.cos(a) * r1));
      } else {
        pts.push(new THREE.Vector3(Math.cos(a) * r0, 0, Math.sin(a) * r0));
        pts.push(new THREE.Vector3(Math.cos(a) * r1, 0, Math.sin(a) * r1));
      }
    }
    var geo = new THREE.BufferGeometry().setFromPoints(pts);
    var mat = new THREE.LineBasicMaterial({ color: COLOR[axis], depthTest: false,
                                            transparent: true, opacity: 0.5 });
    var l = new THREE.LineSegments(geo, mat);
    l.renderOrder = 999;
    return l;
  }

  /* The guide and its grab target exist only while this menu owns the input.

     They used to be drawn on whatever was selected, for as long as it was
     selected, and app-core's pointerdown hit-tests this group AHEAD of
     select-and-drag - so the ball was a live rotation control in the Tip menu
     and in the Move menu, where the user had asked for neither. Emptying the
     group is the teardown: clearGroup disposes every geometry and material,
     so there is nothing left in the scene for a ray to find. Hiding it would
     not have been enough, because `visible` is exactly the flag the picker
     was already trusting. */
  function refresh() {
    var g = ensureGroup();
    if (!g) return;
    clearGroup(g);
    var p = piece();
    var m = mode();
    if (!p || m === 'none' || !menuOwnsInput()) { g.visible = false; return; }
    g.visible = true;
    var r = Math.max(8, (Math.max(p.width || 0, p.depth || 0, p.height || 0) / 2) * 1.45);
    g.position.copy(p.mesh.position);
    if (m === 'trackball') {
      g.add(ballAt('trackball', r, 0));
      g.add(arcLine('x', r, arcWindow(angleOf(p, 'x'))));
      g.add(arcLine('y', r, arcWindow(angleOf(p, 'y'))));
    } else {
      var win = arcWindow(angleOf(p, m));
      g.add(arcLine(m, r, win));
      g.add(tickLines(m, r, win));
      g.add(ballAt(m, r, angleOf(p, m)));
    }
  }

  /* ---- wiring ------------------------------------------------------------ */
  function bind() {
    ['x', 'y'].forEach(function (axis) {
      var chk = document.getElementById(axis === 'x' ? 'chk-rot-lock-x' : 'chk-rot-lock-y');
      if (chk && !chk._rotBound) {
        chk._rotBound = true;
        chk.addEventListener('change', function () { setLock(axis, chk.checked); });
        chk.checked = locked(axis);
      }
    });
    if (!document._rotKeysBound) {
      document._rotKeysBound = true;
      document.addEventListener('keydown', onKeyDown);
    }
    /* Losing the menu ends any drag in flight before the guide goes: endDrag
       is what gives OrbitControls back, and a drag abandoned mid-way would
       otherwise leave the camera frozen with no handle left to release it. */
    if (window.nsoInputMode) {
      window.nsoInputMode.register('menu-rotate', {
        activate: refresh,
        teardown: function () { if (drag) endDrag(); refresh(); }
      });
    }
    refresh();
  }

  window.nsoRotate = {
    mode: mode, modeLabel: modeLabel,
    locked: locked, setLock: setLock,
    angleOf: function (axis) { return angleOf(piece(), axis); },
    setAngle: function (axis, deg) { setAngle(piece(), axis, deg); refresh(); },
    nudge: nudge,
    softSnapDeg: softSnapDeg,
    arcWindow: arcWindow,
    beginDrag: beginDrag, moveDrag: moveDrag, endDrag: endDrag,
    dragging: function () { return !!drag; },
    /* The un-snapped accumulator. The dial is 1:1 with the pointer's angle;
       the soft detents then displace what is SHOWN by at most 4.5 degrees.
       Both claims are worth checking, and only this exposes the first. */
    rawAngle: function (axis) { return drag ? drag.raw[axis] : null; },
    refresh: refresh,
    handleCount: function () { var g = ensureGroup(); return g ? g.children.length : 0; },
    constants: { ARC_WINDOW_DEG: ARC_WINDOW_DEG, ARC_LEAD: ARC_LEAD, TICK_DEG: TICK_DEG,
                 SNAP_STEP_DEG: SNAP_STEP_DEG, SNAP_STRENGTH: SNAP_STRENGTH,
                 SNAP_RADIUS_DEG: SNAP_RADIUS_DEG, NUDGE_DEG: NUDGE_DEG,
                 GAIN_X_DEG_PER_PX: GAIN_X_DEG_PER_PX, GAIN_Y_DEG_PER_PX: GAIN_Y_DEG_PER_PX }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
