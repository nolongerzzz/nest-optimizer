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

   Nested menus (Gen+'s Wheel and Stock) and the Finish overlay are not top
   bar menus and are none of this file's business; app-join's per-overlay
   accordion still handles those, and still handles the ordinary closing of
   the bar's menus. This sits on top of it and makes the guarantee one the
   input handlers can actually rely on. */
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

  /* PINNED: open on screen, but not a candidate for input.

     Cut is the one, and only while the cutter TOOL is live - not merely
     while its dropdown is open. Once the cutter is running, the controls
     that drive it (Split, Close, the plane's readout) live in that
     dropdown, and you need them to stay reachable while you step over to
     another menu to line the piece up. So it is exempt from the closing
     below.

     It is exempt from OWNING, too, and that is the part that keeps this
     file's guarantee intact. A pinned menu open alongside another is two
     panels on screen but still exactly one owner of input, so a key press
     is still answered once - the thing this whole file exists to promise.
     It costs nothing here because the cutter registers no owner at all:
     its input is a drag on the red plane, hit-tested in app-core against
     state.cutterOpen, and it never went through ownership. Were that to
     change, a pinned owner would need a rule of its own, and this comment
     is where to start.

     state may not exist yet when a stray toggle fires during load, hence
     the guard rather than a bare read. */
  function isPinned(d) {
    return d && d.id === 'menu-cut' &&
           typeof state !== 'undefined' && state && !!state.cutterOpen;
  }

  /* The owner, decided now, from the DOM.

     More than one CONTENDER open is not a state this returns an answer
     about: it is a state it ENDS. The newcomer - the open menu that is not
     the one already holding ownership - keeps it and the rest are shut
     here, in this turn, before the caller gets its answer. Falling back to
     the last in document order when every open menu is a newcomer keeps it
     deterministic rather than dependent on which handler happened to ask
     first. Pinned menus sit outside all of it: never closed, never kept,
     and never the answer unless nothing else is open. */
  function resolve() {
    var open = menus().filter(function (d) { return d.open; });
    if (!open.length) return null;
    var live = open.filter(function (d) { return !isPinned(d); });
    /* Only the pinned menu is open, so it is the owner by default - there
       is nothing for it to collide with. */
    if (!live.length) return open[0].id || null;
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

  window.nsoInputMode = {
    /* The one question every input handler should be asking. */
    owns: function (id) { return resolve() === id; },
    active: resolve,
    register: register,
    sync: sync,
    refresh: refreshOwner,
    /* For the checks: who is registered, and who is claiming to be live. */
    registered: function () { return order.slice(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observe);
  else observe();
  setTimeout(observe, 0);
})();
