/* Position lock. A per-piece, user-set flag that says "this piece is where I
   want it - do not let a stray drag or a mis-hit toolbar button move it".

   Same shape as mask6's paint (app-mask.js) and the non-solid flag
   (app-nonsolid.js): set by the user on one piece, never inferred, shown on
   the piece while it is set, read back through ONE accessor, undoable. It is
   stored on the model object as `m.posLock` (boolean) so it survives every
   bake that rebuilds the placed mesh (Skin, Soften, Smooth, Repair - they all
   swap `p.mesh` but keep `m`). In-memory only, like the paint: it is not
   written to the STL or the 3MF, and the plate exports read the same pose
   fields locked or not - `tools/nso_poslock_test.js` pins that the file is
   byte-identical either way.

   WHAT IT BLOCKS - the accidental-movement surface, every entry point that a
   click or a drag on the wrong piece reaches:
     drag on the viewport      startMoveDrag        (app-core.js)
     the four nudge arrows     nudgeSelected
     Raise / Lower             liftSelected
     the yaw / edge / tip / flat / pitch / bank buttons
                               rotateSelected, flipSelected, tipSelected,
                               rollSelected, bankSelected, tiltSelected
   Each of those asks `nsoPosLockBlocks(p, verb)` first. When the piece is
   locked it says so on the status line, pushes no undo entry, and returns.

   WHAT IT DOES NOT BLOCK - the operations that put a piece where it belongs
   in the first place: Seat flush, Seat (support), Center X / Z, Align edges,
   Skin face, the library's seat-on-arrival, Undo. None of them consult the
   flag. Lock a piece AFTER Seat has placed it; Seat on a locked piece still
   seats it, because the user pressed Seat.

   Indicator: a `locked` tag on the piece's row in the model list, a teal
   edge outline drawn over the piece in the viewport (a child of its mesh, so
   it follows every pose change the flag still allows), the toolbar's move
   and pose buttons disabled while a locked piece is selected, and the
   adjust-status line reading "Locked". The toggle is the Lock position /
   Unlock position button in the viewport bar.

   HOW MANY AT ONCE - all of them. The flag is one boolean per model object,
   so every piece carries its own; nothing is stored per-plate and nothing
   remembers "the locked piece". Lock as many as you like, in any order: the
   pieces you did not lock keep their outline-free look and stay selectable,
   draggable and nestable, and every indicator above is computed per piece on
   each refresh. The only thing that is one-at-a-time is the BUTTON, which
   acts on the current selection - that is the toggle's reach, not the flag's.
   `nsoPosLockCount()` reports how many are set, and the status line and the
   button's tooltip carry it so a plate with several locks reads back.

   THE PLATE LOCK - a second, deliberately separate concept, `state.plateLock`,
   toggled by the Lock plate / Unlock plate button (`#btn-plate-lock`). It
   holds the WHOLE CURRENT ARRANGEMENT - every piece's position relative to
   every other - in ONE action, and it refuses the same move surface on EVERY
   piece plus a repack (`Optimize plate`, which would otherwise rebuild the
   plate from scratch). It is NOT "lock each piece": it never writes a single
   `m.posLock`, so the per-piece flags underneath it are untouched and come
   back exactly as they were when the plate is unlocked. That is why there are
   two accessors and not one:

     nsoPosLocked(m) / nsoPosLockedPlaced(p)   THIS PIECE's own flag
     nsoPlateLocked()                          the arrangement is held
     nsoPosHeld(p)                             either - "cannot be moved"

   The move gate `nsoPosLockBlocks` reads `nsoPosHeld` and names which of the
   two refused the move, so the status line always says which button to press.
   Indicator: the plate border turns teal, the model list is marked held, the
   15 move/pose buttons are greyed whatever is selected, the per-piece toggle
   is disabled (its label still shows that piece's own flag), and
   adjust-status reads "Plate locked". Undo entry `plateLockReplace`. */
(function () {
  var OUTLINE_COLOR = 0x2dd4bf;   // teal - unused by paint (yellow), A (orange), B (green), non-solid (purple)
  var PLATE_BORDER_LOCKED = 0x2dd4bf;   // the same teal, on the plate border, for the plate lock
  var PLATE_BORDER_FREE = 0x38bdf8;     // what buildPlateMesh paints it (app-core.js)

  function modelOf(p) {
    if (!p || p.sourceId == null || typeof state === 'undefined' || !state.models) return null;
    for (var i = 0; i < state.models.length; i++) if (state.models[i].id === p.sourceId) return state.models[i];
    return null;
  }
  function selectedPlaced() {
    if (typeof state === 'undefined' || !state.placed) return null;
    var i = state.selectedIndex;
    return (i >= 0 && state.placed[i]) ? state.placed[i] : null;
  }

  /* ---- the accessors everything downstream uses ---- */

  // On a model object. Nothing re-derives this; nothing sets it but the user.
  window.nsoPosLocked = function (m) {
    return !!(m && m.posLock === true);
  };
  // On a placed entry (the plate's instance of a model).
  window.nsoPosLockedPlaced = function (p) {
    return window.nsoPosLocked(modelOf(p));
  };
  // How many pieces carry their own lock. Nothing gates on this; it is what
  // the status line and the button tooltip read so several locks are visible
  // without selecting each piece in turn.
  window.nsoPosLockCount = function () {
    if (typeof state === 'undefined' || !state.models) return 0;
    var n = 0;
    for (var i = 0; i < state.models.length; i++) if (window.nsoPosLocked(state.models[i])) n++;
    return n;
  };

  /* The plate lock: one flag for the whole arrangement, never a per-piece
     one. `state.plateLock` is the only thing it writes. */
  window.nsoPlateLocked = function () {
    return !!(typeof state !== 'undefined' && state.plateLock === true);
  };

  /* "Can this piece be moved at all" - the union of the two locks. This is
     what the gate reads; the two accessors above stay single-meaning so the
     plate lock can be lifted without touching one per-piece flag. */
  window.nsoPosHeld = function (p) {
    return window.nsoPlateLocked() || window.nsoPosLockedPlaced(p);
  };

  /* The gate the move paths call. Returns true when `p` cannot be moved, and
     says which lock refused it; the caller returns without moving and without
     an undo entry. `verb` names what was refused, so the status line reads
     "Locked - drag refused" or "Plate locked - drag refused". */
  window.nsoPosLockBlocks = function (p, verb) {
    var plate = window.nsoPlateLocked();
    if (!plate && !window.nsoPosLockedPlaced(p)) return false;
    var idx = (typeof state !== 'undefined' && state.placed) ? state.placed.indexOf(p) : -1;
    var m = modelOf(p);
    var name = m ? m.name : ('#' + (idx + 1));
    if (typeof setStatus === 'function') {
      setStatus(plate
        ? 'Plate locked - ' + (verb || 'move') + ' refused on ' + name +
          ' - the whole arrangement is held; press Unlock plate to move anything'
        : 'Locked - ' + (verb || 'move') + ' refused on ' + name +
          ' - press Unlock position to move it', true);
    }
    return true;
  };

  /* ---- the indicator in the viewport ---- */

  function findOutline(mesh) {
    if (!mesh || !mesh.children) return null;
    for (var i = 0; i < mesh.children.length; i++) {
      if (mesh.children[i].userData && mesh.children[i].userData.nsoLockOutline) return mesh.children[i];
    }
    return null;
  }
  function addOutline(p) {
    if (!p.mesh || !p.mesh.geometry || typeof THREE === 'undefined') return;
    var geo = new THREE.EdgesGeometry(p.mesh.geometry, 1);
    var mat = new THREE.LineBasicMaterial({ color: OUTLINE_COLOR, depthTest: false, transparent: true, opacity: 0.95 });
    var lines = new THREE.LineSegments(geo, mat);
    lines.name = 'nso-lock-outline';
    lines.userData.nsoLockOutline = true;
    lines.renderOrder = 999;
    lines.raycast = function () {};   // never a pick target; the piece under it is
    p.mesh.add(lines);
  }
  function removeOutline(p) {
    var o = findOutline(p && p.mesh);
    if (!o) return;
    p.mesh.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  }
  function syncOutlines() {
    if (typeof state === 'undefined' || !state.placed) return;
    for (var i = 0; i < state.placed.length; i++) {
      var p = state.placed[i];
      if (!p || !p.mesh) continue;
      var on = window.nsoPosLockedPlaced(p);
      var has = !!findOutline(p.mesh);
      if (on && !has) addOutline(p);
      else if (!on && has) removeOutline(p);
    }
  }

  /* ---- the indicator in the list, the button, the toolbar ---- */

  var ADJUST_IDS = ['btn-rot-left', 'btn-rot-right', 'btn-flip', 'btn-tip', 'btn-roll',
                    'btn-raise', 'btn-lower', 'btn-tilt-up', 'btn-tilt-dn', 'btn-bank-up', 'btn-bank-dn',
                    'btn-nudge-left', 'btn-nudge-right', 'btn-nudge-fwd', 'btn-nudge-back'];

  function syncListTags() {
    var rows = document.querySelectorAll('#model-list .model-item');
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var id = Number(row.dataset.editId);
      var m = null;
      for (var i = 0; i < state.models.length; i++) if (state.models[i].id === id) { m = state.models[i]; break; }
      var on = window.nsoPosLocked(m);
      var tag = row.querySelector('.tag-locked');
      if (on && !tag) {
        tag = document.createElement('span');
        tag.className = 'tag tag-locked';
        tag.title = 'Position locked: drag, nudge, raise/lower and the pose buttons are refused on this piece';
        tag.textContent = '🔒 locked';
        var name = row.querySelector('.name');
        if (name && name.nextSibling) row.insertBefore(tag, name.nextSibling);
        else row.appendChild(tag);
      } else if (!on && tag) {
        tag.remove();
      }
      row.classList.toggle('is-locked', on);
    }
    // The plate lock is not a per-piece flag, so it never touches the row's
    // `locked` tag - it marks the LIST, once.
    var list = document.getElementById('model-list');
    if (list) list.classList.toggle('is-plate-locked', window.nsoPlateLocked());
  }

  /* The plate lock's viewport indicator: the plate's own border, teal while
     the arrangement is held. buildPlateMesh rebuilds the border (and paints
     it cyan again) whenever the plate changes, so this re-applies on every
     refresh rather than only on the toggle. */
  function syncPlateIndicator() {
    if (typeof state === 'undefined' || !state.plateBorder || !state.plateBorder.material) return;
    var want = window.nsoPlateLocked() ? PLATE_BORDER_LOCKED : PLATE_BORDER_FREE;
    if (state.plateBorder.material.color.getHex() !== want) state.plateBorder.material.color.setHex(want);
  }
  function greyAdjust() {
    // The move and pose buttons are refused anyway; grey them so the lock is
    // obvious before the click, not only after it.
    for (var i = 0; i < ADJUST_IDS.length; i++) {
      var el = document.getElementById(ADJUST_IDS[i]);
      if (el) el.disabled = true;
    }
  }
  function syncButton() {
    var plate = window.nsoPlateLocked();
    var n = window.nsoPosLockCount();
    var pieces = (typeof state !== 'undefined' && state.placed) ? state.placed.length : 0;
    var p = selectedPlaced();
    var on = window.nsoPosLockedPlaced(p);

    var btn = document.getElementById('btn-lock-pos');
    if (btn) {
      // Label always reports THIS piece's own flag, even under a plate lock -
      // that is how the two stay readable as separate things. The toggle is
      // disabled under a plate lock because the plate lock is what is holding
      // the piece; lift it first and the per-piece flags are exactly as set.
      btn.disabled = !p || plate;
      btn.textContent = on ? '🔓 Unlock position' : '🔒 Lock position';
      btn.classList.toggle('is-locked', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.title = plate
        ? 'The plate is locked - the whole arrangement is held. Unlock plate first; this piece\'s own lock is ' +
          (on ? 'set' : 'not set') + ' and is untouched.'
        : "Lock the selected piece's position. A locked piece refuses drag, the nudge arrows, Raise/Lower and " +
          'the pose buttons, so a stray click cannot move it. Seat, Center, Align and Skin still place it. ' +
          'Any number of pieces can be locked at once - ' + n + ' of ' + pieces + ' locked now.';
    }

    var pbtn = document.getElementById('btn-plate-lock');
    if (pbtn) {
      // Never trap the lock: if the plate empties while it is on, the only
      // button that can lift it must stay reachable.
      pbtn.disabled = pieces === 0 && !plate;
      pbtn.textContent = plate ? '🔓 Unlock plate' : '🔒 Lock plate';
      pbtn.classList.toggle('is-locked', plate);
      pbtn.setAttribute('aria-pressed', plate ? 'true' : 'false');
      pbtn.title = plate
        ? 'The whole arrangement is held: every piece refuses drag, the nudge arrows, Raise/Lower, the pose ' +
          'buttons and a repack. ' + n + ' piece lock(s) underneath are untouched and come back on unlock.'
        : 'Lock the plate configuration: hold all ' + pieces + ' pieces where they are, in their current ' +
          'relative positions, in one action. Separate from the per-piece lock - it sets no piece flag.';
    }

    if (plate || (p && on)) greyAdjust();
    var status = document.getElementById('adjust-status');
    var line = window.nsoPosLockHudLine();
    if (status && line) status.textContent = line;
  }

  /* The one sentence the lock wants on the HUD line (`#adjust-status`), or
     null when neither lock is in force and the line belongs to whoever else
     is writing it.

     It is exported because `#adjust-status` has more than one author:
     `updateAdjustUI` writes "Selected #n", the paint writes its running
     count, and `app-sel-outline.js` wraps `selectPlaced` to put the paint's
     line back AFTER `updateAdjustUI` has run. That last one used to land on
     top of "Locked #n", so selecting a locked piece showed the bare HUD tag
     and the lock state fell off the screen - exactly when you want to read
     it. The paint's at-rest branch now asks here first (app-mask.js). */
  window.nsoPosLockHudLine = function () {
    if (typeof state === 'undefined') return null;
    var n = window.nsoPosLockCount();
    var pieces = state.placed ? state.placed.length : 0;
    if (window.nsoPlateLocked()) {
      return 'Plate locked - ' + pieces + ' piece' + (pieces === 1 ? '' : 's') +
        ' held in this arrangement; Unlock plate to move them' +
        (n ? ' (' + n + ' piece lock' + (n === 1 ? '' : 's') + ' set)' : '');
    }
    var p = selectedPlaced();
    if (p && window.nsoPosLockedPlaced(p)) {
      return 'Locked #' + (state.selectedIndex + 1) + ' - position held; Unlock position to move it' +
        (n > 1 ? ' (' + n + ' pieces locked)' : '');
    }
    // Not this piece, but say so when others are held, so a plate with locks
    // on it never reads as a plate with none.
    if (n) return (p ? 'Selected #' + (state.selectedIndex + 1) + ' - free to move' : 'Nothing selected') +
      ' - ' + n + ' piece' + (n === 1 ? '' : 's') + ' locked elsewhere';
    return null;
  };
  // Called by app-core after every selection change and list rebuild (so a
  // bake that swaps the mesh gets its outline back), and by Undo.
  window.nsoPosLockRefresh = function () {
    syncOutlines();
    syncListTags();
    syncPlateIndicator();
    syncButton();
  };

  /* ---- setting it ---- */

  window.nsoPosLockSet = function (m, on, opts) {
    if (!m) return false;
    on = !!on;
    if (window.nsoPosLocked(m) === on) { window.nsoPosLockRefresh(); return false; }
    if (!(opts && opts.noUndo) && typeof pushUndo === 'function') {
      pushUndo({ type: 'posLockReplace', modelId: m.id, prev: !on });
    }
    m.posLock = on;
    if (typeof updateAdjustUI === 'function') updateAdjustUI();   // re-enables the pose buttons on unlock
    window.nsoPosLockRefresh();
    if (typeof setStatus === 'function') {
      // The count rides along so a second, third, fourth lock reads back as
      // one more lock rather than as "the" lock.
      var n = window.nsoPosLockCount();
      var many = n > 1 ? ' - ' + n + ' pieces locked' : '';
      setStatus(on
        ? 'Locked position - ' + m.name + ' stays put: drag, nudge, raise/lower and the pose buttons are refused. Seat, Center, Align and Skin still work' + many
        : 'Unlocked position - ' + m.name + ' can be moved again' + (n ? ' - ' + n + ' piece' + (n === 1 ? '' : 's') + ' still locked' : ''));
    }
    return true;
  };

  /* The plate lock. ONE action for the whole arrangement, and the one thing
     it writes is `state.plateLock` - never a per-piece flag, so unlocking
     the plate restores exactly the piece locks that were set before it. */
  window.nsoPlateLockSet = function (on, opts) {
    if (typeof state === 'undefined') return false;
    on = !!on;
    if (window.nsoPlateLocked() === on) { window.nsoPosLockRefresh(); return false; }
    var pieces = state.placed ? state.placed.length : 0;
    if (on && pieces === 0) {
      if (typeof setStatus === 'function') setStatus('Nothing on the plate to lock', true);
      return false;
    }
    if (!(opts && opts.noUndo) && typeof pushUndo === 'function') {
      pushUndo({ type: 'plateLockReplace', prev: !on });
    }
    state.plateLock = on;
    if (typeof updateAdjustUI === 'function') updateAdjustUI();   // re-enables the pose buttons on unlock
    window.nsoPosLockRefresh();
    if (typeof setStatus === 'function') {
      var n = window.nsoPosLockCount();
      setStatus(on
        ? 'Plate locked - all ' + pieces + ' piece' + (pieces === 1 ? '' : 's') + ' held in this arrangement: drag, nudge, ' +
          'raise/lower, the pose buttons and Optimize plate are refused on every piece. ' +
          n + ' per-piece lock' + (n === 1 ? '' : 's') + ' untouched underneath. Seat, Center, Align and Skin still work'
        : 'Plate unlocked - the arrangement can change again' +
          (n ? '; ' + n + ' piece' + (n === 1 ? ' is' : 's are') + ' still locked on their own' : ''));
    }
    return true;
  };

  function bind() {
    var btn = document.getElementById('btn-lock-pos');
    if (btn && !btn._posLockBound) {
      btn.addEventListener('click', function () {
        if (window.nsoPlateLocked()) {
          if (typeof setStatus === 'function') {
            setStatus('Plate locked - press Unlock plate first; the per-piece locks are untouched underneath', true);
          }
          return;
        }
        var p = selectedPlaced();
        var m = modelOf(p);
        if (!m) {
          if (typeof setStatus === 'function') setStatus('Select a piece on the plate first', true);
          return;
        }
        window.nsoPosLockSet(m, !window.nsoPosLocked(m));
      });
      btn._posLockBound = true;
    }
    var pbtn = document.getElementById('btn-plate-lock');
    if (pbtn && !pbtn._plateLockBound) {
      pbtn.addEventListener('click', function () {
        window.nsoPlateLockSet(!window.nsoPlateLocked());
      });
      pbtn._plateLockBound = true;
    }
    window.nsoPosLockRefresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
