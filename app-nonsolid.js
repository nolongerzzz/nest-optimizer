/* Non-solid flag. A deliberate, visible, per-piece declaration that this
   piece is not meant to be a closed solid - a vase-mode clip, a single-wall
   squishy shell, a woven sheet of separate strands - so the checks that
   exist only to enforce "fully enclosed" stand aside for it.

   Same shape as mask6's paint (app-mask.js): set by the user on one piece,
   never inferred from the geometry, shown on the piece while it is set, and
   read back by every consumer through ONE accessor rather than re-derived.
   An open mesh with the flag off is still an open mesh and every check
   treats it as one; that is the point. The flag is not a verdict about the
   geometry, it is a statement of intent, and only a person can make it.

   What reads it, and what each does with it, is the table in
   docs/NON-SOLID.md. The short version, and the rule for anything new:

     SKIPPED with the flag  - only the requirement that the surface be
                              closed: open-edge counts, hole filling, flap
                              and orphan peeling, and volume-based budgets
                              (a signed volume means nothing without an
                              inside).
     STILL RUN              - self-intersection, degenerate triangles,
                              non-manifold edges, winding consistency, and
                              every input-validity check. Those catch real
                              defects on any surface, closed or not.

   Stored on the model object as `m.nonSolid` (boolean). In-memory only, like
   the paint: it does not survive an export/import round trip, and the 3MF
   writer does not carry it. */
(function () {
  function activeModel() {
    return (typeof getActiveModel === 'function') ? getActiveModel() : null;
  }

  /* ---- what everything downstream asks ---- */

  // The supported way in. Consumers call this; nothing re-derives intent from
  // open-edge counts, and nothing sets the flag but the user.
  window.nsoNonSolid = function (m) {
    return !!(m && m.nonSolid === true);
  };

  /* ---- setting it ---- */

  function syncCheckbox() {
    const chk = document.getElementById('chk-non-solid');
    if (!chk) return;
    const m = activeModel();
    chk.disabled = !m;
    chk.checked = window.nsoNonSolid(m);
  }
  function syncListTags() {
    const rows = document.querySelectorAll('#model-list .model-item');
    rows.forEach(function (row) {
      const id = Number(row.dataset.editId);
      const m = state.models.find(function (mm) { return mm.id === id; });
      const on = window.nsoNonSolid(m);
      let tag = row.querySelector('.tag-nonsolid');
      if (on && !tag) {
        tag = document.createElement('span');
        tag.className = 'tag tag-nonsolid';
        tag.title = 'Flagged non-solid: closure checks stand aside for this piece';
        tag.textContent = 'non-solid';
        const name = row.querySelector('.name');
        if (name && name.nextSibling) row.insertBefore(tag, name.nextSibling);
        else row.appendChild(tag);
      } else if (!on && tag) {
        tag.remove();
      }
    });
  }
  // Called by app-core after every selection change and list rebuild, and by
  // Undo, so the checkbox and the list tag always show the active piece.
  window.nsoNonSolidRefresh = function () {
    syncCheckbox();
    syncListTags();
  };

  window.nsoNonSolidSet = function (m, on, opts) {
    if (!m) return false;
    on = !!on;
    if (window.nsoNonSolid(m) === on) { window.nsoNonSolidRefresh(); return false; }
    if (!(opts && opts.noUndo) && typeof pushUndo === 'function') {
      pushUndo({ type: 'nonSolidReplace', modelId: m.id, prev: !on });
    }
    m.nonSolid = on;
    window.nsoNonSolidRefresh();
    // opts.silent: the flag is part of a bigger step that writes its own line
    // (Skin's free layer sets the flag and names it in the same status), and
    // a second setStatus would wipe the line that says what was actually
    // baked. The flag itself still shows on the checkbox and the list tag.
    if (!(opts && opts.silent) && typeof setStatus === 'function') {
      setStatus(on
        ? 'Flagged non-solid - ' + m.name + ': closure checks stand aside; ' +
          'self-intersection, degenerate and winding checks still apply'
        : 'Non-solid flag cleared - ' + m.name + ' is expected to be a closed solid again');
    }
    return true;
  };

  function bind() {
    const chk = document.getElementById('chk-non-solid');
    if (chk && !chk._nonSolidBound) {
      chk.addEventListener('change', function () {
        const m = activeModel();
        if (!m) {
          chk.checked = false;
          if (typeof setStatus === 'function') setStatus('Select a piece in the list first', true);
          return;
        }
        window.nsoNonSolidSet(m, chk.checked);
      });
      chk._nonSolidBound = true;
    }
    window.nsoNonSolidRefresh();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
