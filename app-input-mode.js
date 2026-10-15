/* One menu owns the input. Exactly one, at one time, by construction.

   WHAT WENT WRONG. Three tickets - Rotate, Tip/Tilt and Move - each added a
   tool that wants the bare arrow keys and a click on the piece, and each
   scoped itself the same way: a document-level listener that reads its own
   `<details open>` and returns early if its menu is shut. Read on its own
   every one of those guards is correct. Together they are not, for three
   reasons, and all three were reproduced in the page before this file
   existed:

   1. THE GUARDS TRUSTED AN ACCORDION THAT IS NOT EXCLUSIVE. Nothing stops two
      `<details>` being open at once; what closed the others was a `toggle`
      listener, and toggle is dispatched in a QUEUED TASK, not synchronously.
      Open two menus in one turn - which is what a programmatic `.open = true`
      does, and what the drive harness does - and both are open when the next
      key arrives. One ArrowUp then answered twice: 15 degrees of Tilt AND a
      degree of Rotate, off one press. That is the "Tilt rotates on its own"
      report, and no amount of care inside either module could have prevented
      it, because each module was right and the pair was wrong.

   2. ONLY THE KEYBOARD WAS SCOPED AT ALL. Rotate's grab target is a ball and
      two arcs in the 3D scene, and nothing ever tied them to the Rotate menu:
      the group was drawn on whatever was selected and app-core's pointerdown
      hit-tested it FIRST, ahead of select-and-drag. So the guide appeared
      unasked in Tip and in Move, and a drag that landed on it rotated the
      piece from either. That is the "guide arrows appear without being
      invoked" report, and the other half of the phantom rotation.

   3. THE MODES OUTLIVED THEIR MENUS. `state.tipFaceArmed` stayed armed after
      leaving Tip, so a click on a piece anywhere re-seated it onto the face
      clicked. `state.moveVertical` stayed on after leaving Move, so free drag
      went on being refused everywhere, with the reason naming a menu the user
      had left. Clicks that are swallowed or refused read as lag; the profile
      says the same, because there is no throughput regression here to find -
      frame time and per-event cost are unchanged with these guides in the
      scene or stripped out of it. The app was not slow. It was answering the
      wrong question, or none.

   WHAT THIS IS. One place that decides which top-bar menu owns input, and
   tears the others down when the answer changes. Two properties matter:

   SYNCHRONOUS. owns() resolves the owner at the moment it is asked, from the
   DOM, and collapses an ambiguous state on the spot rather than waiting for a
   queued toggle. Two handlers asking during the same turn get the same single
   answer, so one press can only ever be answered once.

   TORN DOWN, NOT HIDDEN. Losing ownership runs the owner's teardown: the
   scene group is emptied and its geometry disposed, armed flags are cleared
   through the same path the button uses, overlays are put away. What is left
   behind cannot be hit, because it is not there.

   Nested menus (Gen+'s Wheel and Stock) and the shell's other drop-downs
   are not top bar menus and own no input here; app-join's page-wide
   one-panel rule still handles those, and still handles the ordinary
   closing of the bar's menus.
   This sits on top of it and makes the guarantee one the input handlers can
   actually rely on. The one place they do come in is leaveTool() below, the
   double-click that puts every tool away, menus and overlays included. */
(function () {
  'use strict';

  var TOPBAR = '.viewport-overlay-topbar';
  var owners = {};            // menu id -> { activate, teardown }
  var order = [];             // registration order, for a deterministic tie-break
  var current = null;         // the id that owns input as far as teardown knows

  function menus() {
    var bar = document.querySelector(TOPBAR);
    if (!bar) return [];
    return Array.prototype.slice.call(bar.querySelectorAll('.vp-top-menu'));
  }

  /* The owner, decided now, from the DOM.

     More than one CONTENDER open is not a state this returns an answer
     about: it is a state it ENDS. The newcomer - the open menu that is not
     the one already holding ownership - keeps it and the rest are shut
     here, in this turn, before the caller gets its answer. Falling back to
     the last in document order when every open menu is a newcomer keeps it
     deterministic rather than dependent on which handler happened to ask
     first. No menu is exempt: Cut used to be pinned open while the cutter
     was live, and is not any more - only one panel is open on the page
     (app-join.js), and the Cut and Crop cards arm the cutter while open and
     disarm it when shut (app-cut.js, cutWireCards). */
  function resolve() {
    var live = menus().filter(function (d) { return d.open; });
    if (!live.length) return null;
    if (live.length > 1) {
      var keep = null;
      for (var i = live.length - 1; i >= 0; i--) {
        if (live[i].id !== current) { keep = live[i]; break; }
      }
      if (!keep) keep = live[live.length - 1];
      live.forEach(function (d) { if (d !== keep) d.open = false; });
      return keep.id || null;
    }
    return live[0].id || null;
  }

  /* Hand ownership over. Every registered owner that is not the new one is
     torn down, including the one that already was not the owner - teardowns
     are idempotent and cheap, and running the full set is what makes a
     missed transition impossible rather than merely unlikely. */
  function sync() {
    var next = resolve();
    if (next === current) return current;
    current = next;
    for (var i = 0; i < order.length; i++) {
      var id = order[i];
      if (id !== current && owners[id].teardown) {
        try { owners[id].teardown(); } catch (e) { /* one bad teardown must not strand the rest */ }
      }
    }
    if (current && owners[current] && owners[current].activate) {
      try { owners[current].activate(); } catch (e) { }
    }
    return current;
  }

  /* Re-run the current owner's activate without a transition - for when what
     the owner DRAWS has to change although the owner has not. The selection
     moving to another piece is the whole of it: both guides are pinned to the
     selected piece, and before this they were refreshed by name from
     selectPlaced, so whichever module was added last was the one nobody
     remembered to add to that line. */
  function refreshOwner() {
    var id = sync();
    if (id && owners[id] && owners[id].activate) {
      try { owners[id].activate(); } catch (e) { }
    }
    return id;
  }

  function register(id, hooks) {
    if (!id) return;
    if (!owners[id]) order.push(id);
    owners[id] = hooks || {};
    /* A module that registers while its own menu is already open should be
       live, and every other registered owner should not be. */
    if (current === null) current = resolve();
    if (current === id && owners[id].activate) { try { owners[id].activate(); } catch (e) { } }
    else if (current !== id && owners[id].teardown) { try { owners[id].teardown(); } catch (e) { } }
  }

  function observe() {
    var bar = document.querySelector(TOPBAR);
    if (!bar || bar._nsoInputModeObserved) return;
    bar._nsoInputModeObserved = true;
    /* A MutationObserver rather than a toggle listener, for the two reasons
       toggle could not serve: it sees a programmatic `.open = true` as well as
       a click, and it runs as a microtask, so the teardown lands before the
       next event rather than a task later. */
    if (typeof MutationObserver === 'function') {
      new MutationObserver(function () { sync(); })
        .observe(bar, { attributes: true, subtree: true, attributeFilter: ['open'] });
    }
    bar.addEventListener('toggle', function () { sync(); }, true);
    sync();
  }

  /* LEAVE WHATEVER TOOL YOU ARE IN. One gesture - a double-click on the plate
     - and every tool that is live is put away, so moving from one tool to the
     next never starts with hunting for that tool's own way out.

     Each thing is closed THROUGH ITS OWN CLOSE PATH, the one its button runs,
     so state unwinds exactly as it would have: a flag written behind a
     button's back leaves the button lit and dead, which is the lesson every
     disarmOthers in the app was written from. A button is only the way in
     when pressing it can mean nothing but "off"; where it can mean more
     (Soften's bakes a ready piece; Pick target refuses once the Join pair is
     gone) the cancel branch it would have run is run instead.

     The roster is app-carve.js's disarmOthers() - paint, Seat here, brush,
     Measure, Soften, Cap, Center lock - plus what that list never had to
     cover because none of them sits in Carve's way: Carve itself, Attach,
     Reattach, Tip on face, and a Join session. Then the menus: the Cut tool
     (closeCutter, which also shuts its menu), every top-bar menu, the rest
     of the shell's drop-downs and the members open inside them (Gen+'s
     Wheel and Stock among them) and the right-click menu. The
     Rotate / Tip / Move owners are torn down by sync(), the same teardowns
     that run when another menu takes the input.

     Last, nso-helpers.js's teardown: every other live session closed and
     every helper a tool drew taken out of the scene.

     WHAT IT NEVER DOES: clear the selection, change a piece, or touch Undo.
     closeCutter is the one close path that deselects (its Close button means
     "done with this piece" as well), so the selection is taken before it and
     put back after - the cutter goes, the piece you were on stays picked.

     Returns the names of what it closed, for the checks; [] when nothing was
     live, in which case nothing was touched. */
  function leaveTool() {
    if (typeof state === 'undefined' || !state) return [];
    var left = [];
    var $ = function (id) { return document.getElementById(id); };
    var press = function (id) {
      var b = $(id);
      if (b && !b.disabled) { b.click(); return true; }
      return false;
    };
    var keepIndex = state.selectedIndex;
    var keepId = state.editId;

    /* ---- click-waiting modes ---- */
    if (state.carveArmed) {
      press('btn-carve');
      if (state.carveArmed) state.carveArmed = false;
      left.push('carve');
    }
    if (state.maskPaint) {
      press(state.maskPaint === 'select' ? 'btn-mask-select' : 'btn-mask-paint');
      if (state.maskPaint) state.maskPaint = false;
      left.push('paint');
    }
    if (state.seatHereArmed) {
      if (!press('btn-seat-here') && typeof window.nsoSeatHereDisarm === 'function') window.nsoSeatHereDisarm();
      if (state.seatHereArmed) state.seatHereArmed = false;
      left.push('seat-here');
    }
    if (typeof window.nsoBrushArmed === 'function' && window.nsoBrushArmed()) {
      press('btn-brush');
      if (window.nsoBrushArmed() && typeof window.nsoBrushSetArmed === 'function') window.nsoBrushSetArmed(false);
      left.push('brush');
    }
    if (typeof window.nsoPullArmed === 'function' && window.nsoPullArmed()) {
      press('btn-pull');
      if (window.nsoPullArmed() && typeof window.nsoPullSetArmed === 'function') window.nsoPullSetArmed(false);
      left.push('pull');
    }
    if (window.nsoFoam && window.nsoFoam.on()) {
      window.nsoFoam.cancel();
      left.push('foam');
    }
    if (state.measureOn) {
      press('btn-measure');
      if (state.measureOn) state.measureOn = false;
      left.push('measure');
    }
    /* Soften and Cap: their buttons' cancel branches, not the buttons. With
       Full wrap on, a second press of Soften on a ready piece BAKES it. */
    if (state.softenArmed) {
      state.softenArmed = false;
      if (typeof clearFacePick === 'function') clearFacePick();
      if (typeof setStatus === 'function') setStatus('Soften cancelled');
      left.push('soften');
    }
    if (state.capArmed) {
      state.capArmed = false;
      if (typeof clearFacePick === 'function') clearFacePick();
      if (typeof setStatus === 'function') setStatus('Cap cancelled');
      left.push('cap');
    }
    /* Pick target cancels itself on a second press while A and B are both
       picked, and refuses without cancelling once they are not - the flag
       write is for that second case, as every disarmOthers has it. */
    if (state.centerLockArmed) {
      press('btn-center-lock-pick');
      if (state.centerLockArmed) state.centerLockArmed = false;
      left.push('center-lock');
    }
    if (state.attachArmed) {
      press('btn-stock-attach');
      if (state.attachArmed) state.attachArmed = false;
      left.push('attach');
    }
    if (state.reattachArmed) {
      press('btn-reattach');
      if (state.reattachArmed) state.reattachArmed = false;
      left.push('reattach');
    }
    if (state.tipFaceArmed) {
      if (typeof nsoTipOrient !== 'undefined' && nsoTipOrient && nsoTipOrient.setArmed) nsoTipOrient.setArmed(false);
      if (state.tipFaceArmed) state.tipFaceArmed = false;
      left.push('tip-face');
    }
    /* Join: Cancel Join's own handler. It drops the picks and the slot armed
       for the next click, and retires Center lock and Seat here with them. */
    if (state.joinSession || state.joinArmed) {
      if (typeof clearJoinSlots === 'function') clearJoinSlots();
      else { state.joinSession = false; state.joinArmed = null; }
      left.push('join');
    }

    /* ---- the cutter: closeCutter, which shuts its menu ---- */
    if (state.cutterOpen && typeof closeCutter === 'function') {
      closeCutter(false);
      left.push('cut');
    }

    /* ---- menus ---- */
    var shut = function (d, name) {
      if (d && d.open) { d.open = false; left.push(name); }
    };
    var gen = $('menu-gen');
    if (gen) {
      shut(gen.querySelector('.vp-wheel-menu'), 'wheel');
      shut(gen.querySelector('.vp-stock-menu'), 'stock');
    }
    menus().forEach(function (d) { shut(d, d.id || 'menu'); });
    /* The shell's other drop-downs (Measure, Align, Join, Seat, Supports,
       Add, Subtract, the column's surface and check menus) own no input, so
       they are not in menus(), but they are panels on the plate all the same
       - and so are the members open inside the merged ones (Join, A-B-C;
       Gen+'s Picture and Photo). Plate & pieces is pinned open, not a
       drop-down, and is left as it is. */
    Array.prototype.forEach.call(document.querySelectorAll('.vp-col-menu'),
      function (d) { shut(d, d.id || 'menu'); });
    Array.prototype.forEach.call(document.querySelectorAll('.vp-shell-menu .vp-menu'),
      function (d) { shut(d, d.id || 'menu'); });
    /* The teardowns land now, not a microtask later off the observer. */
    sync();

    var ctx = $('ctx-menu');
    if (ctx && !ctx.classList.contains('hidden')) {
      if (typeof hideCtxMenu === 'function') hideCtxMenu(); else ctx.classList.add('hidden');
      left.push('context-menu');
    }

    /* ---- every helper still in the scene: the registry's one teardown ----
       Closes the sessions this list does not name (Bend, Tube edge, Bridge,
       the Check, G-scope's Lift and Overhangs) through their own close paths,
       then takes out whatever any tool left drawn (nso-helpers.js). */
    if (window.nsoHelpers) {
      window.nsoHelpers.teardown('leave').closed.forEach(function (n) {
        if (left.indexOf(n) < 0) left.push(n);
      });
    }

    /* ---- the selection is not this gesture's to change ---- */
    if (state.selectedIndex !== keepIndex || state.editId !== keepId) {
      if (keepIndex >= 0 && state.placed && state.placed[keepIndex] && typeof selectPlaced === 'function') {
        selectPlaced(keepIndex);
      }
      if (state.editId !== keepId && keepId != null &&
          state.models && state.models.some(function (m) { return m && m.id === keepId; })) {
        state.editId = keepId;
        if (typeof updateEditSize === 'function') updateEditSize();
        if (typeof renderModelList === 'function') renderModelList();
        if (typeof updateCutterUI === 'function') updateCutterUI();
      }
    }
    return left;
  }

  /* The gesture: a double-click on the plate's canvas. Only the canvas - a
     double-click on a button is still two clicks and in a number box it still
     selects a word, because neither ever reaches here. */
  function bindGesture() {
    if (typeof state === 'undefined' || !state || !state.renderer) return;
    var el = state.renderer.domElement;
    if (!el || el._nsoLeaveToolBound) return;
    el._nsoLeaveToolBound = true;
    el.addEventListener('dblclick', function (event) {
      event.preventDefault();
      leaveTool();
    });
  }

  window.nsoInputMode = {
    /* The one question every input handler should be asking. */
    owns: function (id) { return resolve() === id; },
    active: resolve,
    register: register,
    sync: sync,
    refresh: refreshOwner,
    leaveTool: leaveTool,
    /* For the checks: who is registered, and who is claiming to be live. */
    registered: function () { return order.slice(); }
  };

  window.leaveTool = leaveTool;

  function boot() { observe(); bindGesture(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setTimeout(boot, 0);
})();
