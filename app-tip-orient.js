/* Tip menu - orientation: Tip on side, Stand, Flip, Tip on face, and the
   keyboard for Tilt.

   WHAT THE POSE IS. A placed piece's orientation lives in five fields that
   app-core's applyMeshRotation composes into one Euler XYZ:

       rotation.set(tipX*90 + tiltX + flip,   rotY,   tipZ*90 + tiltZ)

   Three of those are quarter-turn counters and two are free degrees, which
   is fine for buttons that step but cannot express "put THIS face down" for
   a face at an arbitrary angle. So everything here works in quaternions and
   writes the answer back through one function, setOrientFromQuat, which
   zeroes the quarter-turn counters and puts the whole orientation in the
   free fields. applyMeshRotation then re-seats the piece on the plate by its
   new bounding box, exactly as it does for every existing button.

   The current orientation is read from p.mesh.quaternion rather than
   recomposed from the five fields. applyMeshRotation has already written it,
   and recomposing it here would be a second copy of that formula waiting to
   disagree with the first. */
(function () {
  'use strict';

  var DOWN = null;                        // built lazily; THREE may not be up yet

  function piece() {
    if (typeof state === 'undefined' || !state || !state.placed) return null;
    var p = state.placed[state.selectedIndex];
    return (p && p.mesh) ? p : null;
  }

  function blocked(p, what) {
    return (typeof nsoPosLockBlocks === 'function') && nsoPosLockBlocks(p, what);
  }

  function setOrientFromQuat(p, q) {
    var e = new THREE.Euler().setFromQuaternion(q, 'XYZ');
    p.tipX = 0; p.tipZ = 0; p.flipX = false;
    p.tiltX = e.x * 180 / Math.PI;
    p.rotY = e.y;
    p.tiltZ = e.z * 180 / Math.PI;
    if (typeof applyMeshRotation === 'function') applyMeshRotation(p);
    if (typeof refreshOutline === 'function') refreshOutline(p);
    if (typeof updateExportButton === 'function') updateExportButton();
  }

  /* Turn the piece by R about a WORLD axis: premultiply, so the axis means
     the same thing however the piece is already lying. */
  function turnBy(p, q) {
    var next = q.clone().multiply(p.mesh.quaternion.clone());
    setOrientFromQuat(p, next);
  }

  /* ---- Tip on side ------------------------------------------------------
     Lay it down on its long horizontal edge: pivot a quarter turn about the
     axis that edge RUNS ALONG, which is the longer of the two horizontal
     dimensions the piece currently presents. A piece 80 long and 40 deep has
     its long bottom edges running along X, so it tips about X and lands on
     the side face; 40 by 80 tips about Z instead. Reading the dimensions
     each time rather than assuming an axis is what makes this work on a
     piece that has already been turned. */
  function tipOnSide() {
    var p = piece();
    if (!p) { say('Select a piece first', true); return false; }
    if (blocked(p, 'tip on side')) return false;
    undo();
    var w = p.width || 0, d = p.depth || 0;
    var axis = (w >= d) ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    turnBy(p, new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 2));
    say('Tip on side - onto its long ' + (w >= d ? 'X' : 'Z') + ' edge');
    return true;
  }

  /* ---- Stand ------------------------------------------------------------
     Stand it up on its end: bring the LONGEST dimension vertical.

     This is new behaviour and it is deliberate. btn-tip used to call
     tipSelected(), a quarter turn about X that cycles which face is down -
     and for the common piece, longer in X than in Z, that lands on exactly
     the orientation "Tip on side" now produces. Two buttons in one menu
     doing the same thing to the same piece is the thing the rename was
     meant to clear up, and the ticket asks for the three to be distinct.

     tipSelected() itself is untouched and still exported: the lock checks
     call it directly and assert on its own refusal wording. What changed is
     only which function this button calls. */
  function standOnEnd() {
    var p = piece();
    if (!p) { say('Select a piece first', true); return false; }
    if (blocked(p, 'stand')) return false;
    undo();
    var w = p.width || 0, d = p.depth || 0, h = p.height || 0;
    var q;
    if (w >= d && w >= h) {
      q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
      say('Stand - on its end, the ' + w.toFixed(0) + ' mm axis upright');
    } else if (d >= w && d >= h) {
      q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      say('Stand - on its end, the ' + d.toFixed(0) + ' mm axis upright');
    } else {
      /* Already the tallest thing about it, so there is nothing to stand up.
         Turn it a quarter about X instead, which is what this button did
         before and keeps a second press from being a dead click. */
      q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
      say('Stand - already upright, turned a quarter instead');
    }
    turnBy(p, q);
    return true;
  }

  /* ---- Flip -------------------------------------------------------------
     Upside-down from wherever it is now: half a turn about a HORIZONTAL
     axis, so whatever face is against the plate ends up on top. About world
     X, which is horizontal whatever the piece has been doing - a half turn
     about the piece's own up-axis would only spin it where it stands. */
  function flipOver() {
    var p = piece();
    if (!p) { say('Select a piece first', true); return false; }
    if (blocked(p, 'flip')) return false;
    undo();
    turnBy(p, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
    say('Flip - upside down');
    return true;
  }

  /* ---- Tip on face ------------------------------------------------------
     Click a face and it becomes the face the piece rests on. The rotation is
     the one that takes that face's CURRENT world normal to straight down,
     which is a two-vector problem and exactly what setFromUnitVectors
     answers; composing it with where the piece already is leaves everything
     else about the orientation alone.

     An edge click lands on one of the two triangles that meet there and
     tips onto that one - which is what "rest on that edge" means for a
     piece that has to sit on something flat. */
  function tipOnFaceFromHit(hit) {
    var p = piece();
    if (!p || !hit || !hit.face || !hit.object) return false;
    if (blocked(p, 'tip on face')) return false;
    var n = hit.face.normal.clone()
      .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
      .normalize();
    if (!isFinite(n.x) || n.lengthSq() < 1e-9) { say('Click a face on the piece', true); return false; }
    if (!DOWN) DOWN = new THREE.Vector3(0, -1, 0);
    undo();
    turnBy(p, new THREE.Quaternion().setFromUnitVectors(n, DOWN));
    say('Tip on face - that face is on the plate');
    return true;
  }

  /* The arming, following the same contract every other picker in this app
     keeps (app-mask.js states it): one picking mode at a time, the others
     put away THROUGH their own buttons so nothing is left lit and dead, and
     the button carries is-armed plus aria-pressed. */
  function setArmed(on) {
    if (typeof state === 'undefined' || !state) return;
    /* The others go away FIRST, and the order is load-bearing now. This tool
       is itself listed in disarmOthers - it has to be, or arming Paint or the
       Brush leaves it armed behind them and app-core routes it first - so
       calling that list AFTER setting the flag had it disarm itself on the
       way up. Same call, one line earlier, and arming is idempotent again. */
    if (on && typeof window.nsoMaskDisarmOthers === 'function') window.nsoMaskDisarmOthers();
    state.tipFaceArmed = !!on;
    var b = document.getElementById('btn-tip-face');
    if (b) {
      b.classList.toggle('is-armed', !!on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.textContent = on ? 'Click a face…' : 'Tip on face';
    }
    if (on) say('Tip on face - click the face to rest it on');
  }
  function toggleArmed() {
    var p = piece();
    if (!state.tipFaceArmed && !p) { say('Select a piece first', true); return false; }
    setArmed(!state.tipFaceArmed);
    return true;
  }

  /* ---- Tilt, and its keyboard -------------------------------------------
     The four Tilt buttons are unchanged - tiltSelected and bankSelected,
     15 degrees a press, each lifting one edge. The keys do exactly what
     clicking them does, by calling the same functions.

     SCOPED TO THE OPEN MENU, not bound globally. Arrow keys are a scarce
     thing and more than one tool wants them; the rule this follows is that
     they belong to whichever menu is open, so Tilt hears them only while
     the Tip menu is showing. Nothing else has to know, and two tools can
     both use plain arrows without a modifier or a collision.

     Hold to repeat is the OS's own key repeat - there is no event.repeat
     guard here, and that absence IS the feature. */
  var TILT_KEYS = {
    ArrowUp:    function () { return call(tiltSelected, 1, 'pitch'); },
    ArrowDown:  function () { return call(tiltSelected, -1, 'pitch'); },
    ArrowRight: function () { return call(bankSelected, 1, 'bank'); },
    ArrowLeft:  function () { return call(bankSelected, -1, 'bank'); }
  };
  function call(fn, dir) {
    if (typeof fn !== 'function') return false;
    if (!piece()) return false;
    fn(dir);
    return true;
  }

  /* Whether this menu owns the input right now - asked of nsoInputMode, not
     read off `#menu-tip.open`. Rotate's arrows and Move's arrows are the same
     four keys off two other <details>, and three handlers each reading their
     own element are exclusive only if something guarantees one is open. The
     accordion that was meant to is driven by `toggle`, which arrives a task
     late, so two menus open in one turn had one ArrowUp tilting 15 degrees
     and nudging a degree of yaw at the same time. The arbiter answers from
     the DOM at the moment it is asked and ends the ambiguity on the spot.

     menuOpen stays the exported name because that is what it means to a
     caller outside this file, and the checks read it. */
  function menuOpen() {
    if (window.nsoInputMode) return window.nsoInputMode.owns('menu-tip');
    var d = document.getElementById('menu-tip');
    return !!(d && d.open);
  }

  function onKeyDown(ev) {
    var fn = TILT_KEYS[ev.key];
    if (!fn) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return;
    if (!menuOpen()) return;                       // the scope rule, in one line
    var t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' ||
              t.isContentEditable)) return;
    if (!piece()) return;
    ev.preventDefault();
    fn();
  }

  /* ---- plumbing ---------------------------------------------------------- */
  function say(t, bad) { if (typeof setStatus === 'function') setStatus(t, !!bad); }
  function undo() {
    if (typeof pushUndo === 'function' && typeof snapshotPlacedPose === 'function')
      pushUndo(snapshotPlacedPose(state.selectedIndex));
  }

  function bind() {
    var wire = function (id, fn) {
      var b = document.getElementById(id);
      if (b && !b._tipBound) { b._tipBound = true; b.addEventListener('click', fn); }
    };
    wire('btn-flip', tipOnSide);          // the old Edge button, renamed and re-aimed
    wire('btn-tip', standOnEnd);          // the old Tip button; tipSelected() itself is untouched
    wire('btn-flip-over', flipOver);
    wire('btn-tip-face', toggleArmed);
    if (!document._tipKeysBound) {
      document._tipKeysBound = true;
      document.addEventListener('keydown', onKeyDown);
    }
    /* Leaving the menu disarms Tip on face, THROUGH setArmed, so the button
       stops being lit and aria-pressed follows. It used to stay armed: the
       flag is read by app-core's pointerdown, which is not scoped to any
       menu, so a left click on a piece from the Rotate or Move menu re-seated
       it onto the face clicked - a piece turning over with nothing on screen
       to say why. An armed picker belongs to the menu it was armed from. */
    if (window.nsoInputMode) {
      window.nsoInputMode.register('menu-tip', {
        teardown: function () {
          if (typeof state !== 'undefined' && state && state.tipFaceArmed) setArmed(false);
        }
      });
    }
  }

  window.nsoTipOrient = {
    tipOnSide: tipOnSide,
    standOnEnd: standOnEnd,
    flipOver: flipOver,
    tipOnFaceFromHit: tipOnFaceFromHit,
    armed: function () { return !!(typeof state !== 'undefined' && state && state.tipFaceArmed); },
    setArmed: setArmed,
    toggleArmed: toggleArmed,
    menuOpen: menuOpen,
    keysHandled: Object.keys(TILT_KEYS),
    orientation: function () {
      var p = piece();
      if (!p) return null;
      p.mesh.updateMatrixWorld(true);
      var q = p.mesh.quaternion;
      var up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);       // the piece's own up
      return { up: { x: +up.x.toFixed(6), y: +up.y.toFixed(6), z: +up.z.toFixed(6) },
               size: { w: +(p.width || 0).toFixed(4), d: +(p.depth || 0).toFixed(4),
                       h: +(p.height || 0).toFixed(4) } };
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
