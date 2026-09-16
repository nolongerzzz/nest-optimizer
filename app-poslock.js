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
   Unlock position button in the viewport bar. */
(function () {
  var OUTLINE_COLOR = 0x2dd4bf;   // teal - unused by paint (yellow), A (orange), B (green), non-solid (purple)

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

  /* The gate the move paths call. Returns true when `p` is locked, and says
     so; the caller returns without moving and without an undo entry. `verb`
     names what was refused so the status line reads "Locked - drag refused". */
  window.nsoPosLockBlocks = function (p, verb) {
    if (!window.nsoPosLockedPlaced(p)) return false;
    var idx = (typeof state !== 'undefined' && state.placed) ? state.placed.indexOf(p) : -1;
    var m = modelOf(p);
    if (typeof setStatus === 'function') {
      setStatus('Locked - ' + (verb || 'move') + ' refused on ' + (m ? m.name : ('#' + (idx + 1))) +
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
  }
  function syncButton() {
    var btn = document.getElementById('btn-lock-pos');
    if (!btn) return;
    var p = selectedPlaced();
    var on = window.nsoPosLockedPlaced(p);
    btn.disabled = !p;
    btn.textContent = on ? '🔓 Unlock position' : '🔒 Lock position';
    btn.classList.toggle('is-locked', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    if (p && on) {
      // The move and pose buttons are refused anyway; grey them so the lock
      // is obvious before the click, not only after it.
      for (var i = 0; i < ADJUST_IDS.length; i++) {
        var el = document.getElementById(ADJUST_IDS[i]);
        if (el) el.disabled = true;
      }
      var status = document.getElementById('adjust-status');
      if (status) status.textContent = 'Locked #' + (state.selectedIndex + 1) + ' - position held; Unlock position to move it';
    }
  }
  // Called by app-core after every selection change and list rebuild (so a
  // bake that swaps the mesh gets its outline back), and by Undo.
  window.nsoPosLockRefresh = function () {
    syncOutlines();
    syncListTags();
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
      setStatus(on
        ? 'Locked position - ' + m.name + ' stays put: drag, nudge, raise/lower and the pose buttons are refused. Seat, Center, Align and Skin still work'
        : 'Unlocked position - ' + m.name + ' can be moved again');
    }
    return true;
  };

  function bind() {
    var btn = document.getElementById('btn-lock-pos');
    if (btn && !btn._posLockBound) {
      btn.addEventListener('click', function () {
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
    window.nsoPosLockRefresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
