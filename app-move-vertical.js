/* Move menu - the guidance arrows, and the vertical placement mode.

   TWO MODES, one menu.

   NORMAL (the checkbox clear). Exactly what Move did before, plus four
   arrows drawn around the selected piece. They are decoration: they carry
   no listener and their raycast is stubbed out, so a click goes straight
   through them to whatever is behind. Free drag and the nudge buttons are
   untouched.

   VERTICAL (the checkbox set). For dropping a piece onto the top face of
   another, or sliding it down against a wall - the job where a top-down
   view tells you nothing. The camera goes to eye level with the piece from
   just outside the plate, a slider appears beside it, and the arrow keys
   become a fine positioner. Free drag goes off, because the whole point is
   that a drag on this view moves the piece in a plane you cannot judge.

   THE STEP. Raise/Lower moved 2 mm a click and the horizontal nudges still
   do. That is a long way at this scale - two layers of a 1 mm wall, or five
   of a 0.4 mm one - and it is why this mode exists at all. The arrows here
   move 0.25 mm: about one layer at a common 0.2 mm height, fine enough to
   close a seam by eye and still 4 presses to a millimetre when held. */
(function () {
  'use strict';

  var STEP_MM = 0.25;             // the micro-nudge, vertical and lateral
  var LIFT_MAX = 80;              // liftSelected's own clamp, mirrored here
  var CAM_MARGIN_MM = 60;         // how far beyond the plate edge the eye sits

  function piece() {
    if (typeof state === 'undefined' || !state || !state.placed) return null;
    var p = state.placed[state.selectedIndex];
    return (p && p.mesh) ? p : null;
  }
  function say(t, bad) { if (typeof setStatus === 'function') setStatus(t, !!bad); }
  /* Whether this menu owns the input right now - asked of nsoInputMode, not
     read off `#menu-move.open`. Rotate and Tilt claim the same four arrows
     off two other <details>; the accordion meant to keep one open runs off
     `toggle`, which arrives a task late, so all three guards could be true at
     once. The arbiter answers synchronously and collapses that state. */
  function menuOpen() {
    if (window.nsoInputMode) return window.nsoInputMode.owns('menu-move');
    var d = document.getElementById('menu-move');
    return !!(d && d.open);
  }
  function on() {
    return !!(typeof state !== 'undefined' && state && state.moveVertical);
  }

  /* ---- the four decorative arrows --------------------------------------- */
  var arrows = null;

  function ensureArrows() {
    if (typeof THREE === 'undefined' || typeof state === 'undefined' || !state || !state.scene)
      return null;
    if (!arrows) {
      arrows = new THREE.Group();
      arrows.name = 'nso-move-arrows';
      state.scene.add(arrows);
    }
    return arrows;
  }

  /* Decoration, and made so structurally rather than by promising it.
     An empty raycast() means the picker cannot return these however the
     pointer is aimed, so no click routing anywhere has to know they exist
     and none of them can shadow the piece underneath. */
  function makeArrow(dir, r, color) {
    var geo = new THREE.ConeGeometry(Math.max(1.2, r * 0.07), Math.max(3.2, r * 0.2), 14);
    var mat = new THREE.MeshBasicMaterial({ color: color, depthTest: false,
                                            transparent: true, opacity: 0.55 });
    var m = new THREE.Mesh(geo, mat);
    m.raycast = function () {};
    m.userData.nsoMoveArrow = dir.name;
    m.renderOrder = 998;
    m.position.set(dir.x * r, 0, dir.z * r);
    // point the cone outward, away from the piece
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(dir.x, 0, dir.z).normalize());
    return m;
  }

  var DIRS = [{ name: 'back', x: 0, z: 1 }, { name: 'fwd', x: 0, z: -1 },
              { name: 'right', x: 1, z: 0 }, { name: 'left', x: -1, z: 0 }];

  function refreshArrows() {
    var g = ensureArrows();
    if (!g) return;
    while (g.children.length) {
      var c = g.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
    var p = piece();
    if (!p || !menuOpen()) { g.visible = false; return; }
    g.visible = true;
    var r = Math.max(10, (Math.max(p.width || 0, p.depth || 0) / 2) + 6);
    g.position.set(p.mesh.position.x, Math.max(1.5, (p.height || 4) * 0.25), p.mesh.position.z);
    for (var i = 0; i < DIRS.length; i++) g.add(makeArrow(DIRS[i], r, 0x7dd3fc));
  }

  /* ---- the reference frame for left / right -----------------------------
     Side to side RELATIVE TO THE NEAREST OTHER PIECE: the axis is the one
     perpendicular, in the plate's plane, to the line joining the two. So
     "right" slides the piece around its neighbour rather than along some
     world axis the view may not even be showing.

     It is genuinely situational, and that is the point - in a crowded
     scene which piece is nearest can change under you. With nothing else
     on the plate there is no such line, so it falls back to world X and
     says which frame it used. */
  function lateralAxis() {
    var p = piece();
    if (!p) return null;
    var best = null, bestD = Infinity;
    for (var i = 0; i < state.placed.length; i++) {
      if (i === state.selectedIndex) continue;
      var q = state.placed[i];
      if (!q || !q.mesh) continue;
      var dx = q.x - p.x, dz = q.z - p.z;
      var d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = q; }
    }
    if (!best || bestD < 1e-9) return { x: 1, z: 0, ref: null };
    var len = Math.sqrt(bestD);
    var tx = (best.x - p.x) / len, tz = (best.z - p.z) / len;
    return { x: -tz, z: tx, ref: best, dist: len };   // perpendicular, in XZ
  }

  /* ---- the moves --------------------------------------------------------- */
  function lift(dir) {
    var p = piece();
    if (!p) return false;
    if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'raise/lower')) return false;
    undo();
    p.liftY = Math.max(0, Math.min(LIFT_MAX, (p.liftY || 0) + dir * STEP_MM));
    if (typeof applyMeshRotation === 'function') applyMeshRotation(p);
    if (typeof refreshOutline === 'function') refreshOutline(p);
    syncSlider();
    refreshArrows();
    say('Lift ' + p.liftY.toFixed(2) + ' mm');
    return true;
  }

  function strafe(dir) {
    var p = piece();
    if (!p) return false;
    if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'move')) return false;
    var ax = lateralAxis();
    if (!ax) return false;
    undo();
    var nx = p.x + ax.x * dir * STEP_MM, nz = p.z + ax.z * dir * STEP_MM;
    if (typeof applyPlacedXZ === 'function') applyPlacedXZ(p, nx, nz);
    else { p.x = nx; p.z = nz; if (typeof applyMeshRotation === 'function') applyMeshRotation(p); }
    if (typeof refreshOutline === 'function') refreshOutline(p);
    refreshArrows();
    say(ax.ref ? ('Side ' + STEP_MM + ' mm across the line to the nearest piece (' +
                  ax.dist.toFixed(1) + ' mm away)')
               : ('Side ' + STEP_MM + ' mm along X - nothing else on the plate to work from'));
    return true;
  }

  /* ---- the camera --------------------------------------------------------
     Eye level with the piece, outside the plate looking in. Level is the
     whole point: a top-down view cannot show you a gap between two things
     stacked, and that gap is what this mode exists to close. The eye is put
     on the line from the plate's centre out through the piece, so the piece
     is between the camera and the middle of the scene rather than hidden
     behind whatever else is on the bed. */
  function frameHorizon() {
    var p = piece();
    if (!p || !state.camera) return false;
    var plate = (typeof getCurrentPlate === 'function') ? getCurrentPlate() : null;
    var halfW = (plate && plate.w ? plate.w : 180) / 2;
    var halfD = (plate && plate.d ? plate.d : 180) / 2;
    var dx = p.x, dz = p.z, len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) { dx = 0; dz = 1; len = 1; }
    dx /= len; dz /= len;
    var dist = Math.max(halfW, halfD) + CAM_MARGIN_MM;
    var eyeY = p.mesh.position.y;
    state.camera.position.set(dx * dist, eyeY, dz * dist);
    var target = new THREE.Vector3(p.mesh.position.x, eyeY, p.mesh.position.z);
    state.camera.lookAt(target);
    if (state.controls) {
      state.controls.target.copy(target);
      state.controls.update();
    }
    return true;
  }

  /* ---- the slider --------------------------------------------------------- */
  function sliderEl() { return document.getElementById('move-vert-slider'); }

  /* The slider is an overlay over the viewport with pointer-events on, so it
     has to go when this menu stops owning the input and not merely when the
     mode does - a panel left hanging there eats clicks aimed at the plate. */
  function syncSlider() {
    var el = sliderEl(), p = piece();
    if (!el) return;
    if (!on() || !p || !menuOpen()) { el.parentElement.hidden = true; return; }
    el.parentElement.hidden = false;
    el.value = String(p.liftY || 0);
    var out = document.getElementById('move-vert-read');
    if (out) out.textContent = (p.liftY || 0).toFixed(2) + ' mm';
    place();
  }

  /* Beside the piece: the slider is an overlay, so it is put where the piece
     projects to on screen rather than parented into the scene. */
  function place() {
    var el = sliderEl(), p = piece();
    if (!el || !p || !state.camera || !state.renderer) return;
    var wrap = el.parentElement;
    var r = state.renderer.domElement.getBoundingClientRect();
    var v = p.mesh.position.clone().project(state.camera);
    var x = (v.x * 0.5 + 0.5) * r.width;
    var y = (-v.y * 0.5 + 0.5) * r.height;
    wrap.style.left = Math.round(Math.max(8, Math.min(r.width - 60, x + 40))) + 'px';
    wrap.style.top = Math.round(Math.max(8, Math.min(r.height - 180, y - 90))) + 'px';
  }

  /* ---- mode ---------------------------------------------------------------- */
  function setOn(v) {
    if (typeof state === 'undefined' || !state) return;
    state.moveVertical = !!v;
    var chk = document.getElementById('chk-move-vertical');
    if (chk) chk.checked = !!v;
    if (v) {
      frameHorizon();
      say('Vertical placement - arrows move ' + STEP_MM + ' mm, drag is off');
    } else {
      /* The view is left exactly where it ended up. Snapping back would
         undo whatever the user did with the orbit while they were in here. */
      say('Vertical placement off - drag is back');
    }
    syncSlider();
    refreshArrows();
  }

  /* ---- keyboard ------------------------------------------------------------
     Scoped to the Move menu being open, the same rule the Tip menu's arrows
     follow, so two menus can both use plain arrows without a collision.
     Only live in vertical mode; normal Move keeps whatever it had.

     No event.repeat guard, so holding an arrow repeats at the OS's rate. */
  function onKeyDown(ev) {
    if (!menuOpen() || !on()) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return;
    var t = ev.target;
    if (t && (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (t && t.tagName === 'INPUT' && t.id !== 'move-vert-slider') return;
    if (!piece()) return;
    var k = ev.key;
    if (k === 'ArrowUp') { ev.preventDefault(); lift(1); }
    else if (k === 'ArrowDown') { ev.preventDefault(); lift(-1); }
    else if (k === 'ArrowRight') { ev.preventDefault(); strafe(1); }
    else if (k === 'ArrowLeft') { ev.preventDefault(); strafe(-1); }
  }

  function undo() {
    if (typeof pushUndo === 'function' && typeof snapshotPlacedPose === 'function')
      pushUndo(snapshotPlacedPose(state.selectedIndex));
  }

  function bind() {
    var chk = document.getElementById('chk-move-vertical');
    if (chk && !chk._mvBound) {
      chk._mvBound = true;
      chk.addEventListener('change', function () { setOn(chk.checked); });
    }
    var sl = sliderEl();
    if (sl && !sl._mvBound) {
      sl._mvBound = true;
      sl.addEventListener('input', function () {
        var p = piece();
        if (!p) return;
        if (typeof nsoPosLockBlocks === 'function' && nsoPosLockBlocks(p, 'raise/lower')) return;
        p.liftY = Math.max(0, Math.min(LIFT_MAX, parseFloat(sl.value) || 0));
        if (typeof applyMeshRotation === 'function') applyMeshRotation(p);
        if (typeof refreshOutline === 'function') refreshOutline(p);
        var out = document.getElementById('move-vert-read');
        if (out) out.textContent = p.liftY.toFixed(2) + ' mm';
        refreshArrows();
      });
    }
    var menu = document.getElementById('menu-move');
    if (menu && !menu._mvBound) {
      menu._mvBound = true;
      menu.addEventListener('toggle', function () { refreshArrows(); syncSlider(); });
    }
    if (!document._mvKeysBound) {
      document._mvKeysBound = true;
      document.addEventListener('keydown', onKeyDown);
    }
    /* Leaving the menu takes the mode down with it, and says so once.

       It used to survive: state.moveVertical is read by app-core's
       startMoveDrag, which belongs to no menu, so free drag went on being
       refused from every other menu - with a message naming a mode the user
       had left and a box they could not see to clear. A refusal nobody can
       act on is indistinguishable from the app being stuck, and that is a
       large part of what the lag report was. Turning it off through setOn is
       what keeps the checkbox, the slider and the camera honest about it. */
    if (window.nsoInputMode) {
      window.nsoInputMode.register('menu-move', {
        activate: function () { refreshArrows(); syncSlider(); },
        teardown: function () {
          if (on()) setOn(false);
          refreshArrows();
          syncSlider();
        }
      });
    }
    refreshArrows();
    syncSlider();
  }

  window.nsoMoveVertical = {
    on: on, setOn: setOn,
    step: STEP_MM,
    camMargin: CAM_MARGIN_MM,
    lift: lift, strafe: strafe,
    lateralAxis: lateralAxis,
    frameHorizon: frameHorizon,
    refreshArrows: refreshArrows,
    syncSlider: syncSlider,
    arrowCount: function () { var g = ensureArrows(); return g && g.visible ? g.children.length : 0; },
    arrowsPickable: function () {
      var g = ensureArrows();
      if (!g) return false;
      return g.children.some(function (c) { return c.raycast && c.raycast.length !== 0; });
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
