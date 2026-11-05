/* app-skin-patch.js - the Skin patch button: bake a skin pattern as ITS OWN
   printable piece, instead of onto the face of a piece you already have.

   Not a bake on the selection. Every other Skin control replaces the active
   piece's geometry through NSO_sculptCommitRaw; this one ADDS A NEW PIECE and
   leaves the selection's geometry alone, so there is nothing to undo on the
   selected piece and no paint scope to check. That is why it is a separate
   file and a separate row rather than a third mode of app-skin.js.

   PAINT SCOPE: NONE - it reads no existing geometry at all. The patch is
   built from the pattern's own parameters, so no face of any piece is
   touched, which is a stronger statement than "paint is respected". See
   docs/HANDOFF.md, "Scoping" - `none` is a category there, and it is why this
   file is not in tools/nso_paint_scope_test.js's roster: that roster is the
   paint-AWARE features and a row in it needs a paint test to assert.

   The new piece arrives through addModelFromZUpGeometry (app-core.js), the
   one ingest path an imported STL takes: the raw Z-up soup is captured before
   the display transform, so the patch has rawTris exactly as a loaded file
   does and every later tool - Seat, Repair, Check piece, both exporters -
   sees an ordinary piece. Nothing here writes a file; the patch goes out
   through the Format selector and the two export buttons like anything else.

   ---------------------------------------------------------------------------
   THE TWO VARIANTS, AND WHY ONE OF THEM SETS THE NON-SOLID FLAG
   ---------------------------------------------------------------------------
   The geometry, the thickness conventions and the measurements are all in
   nso_skin_patch.js; this file only picks a variant and says what happened.

     bordered   the washer: the pattern inside a solid rim that stands proud
                of its tips. One closed shell. NO flag - the rim closes and
                stiffens it, and flagging it would only remove a check it
                passes.
     loose      the pattern's features alone, solid, no rim and no backing
                plate. SETS THE NON-SOLID FLAG and says so in its status.

   The flag on the loose patch is the same kind of declaration Skin's free
   layer already makes (docs/NON-SOLID.md, "Also set by one bake"): nothing is
   measured off the mesh, the user asked for a construction whose whole point
   is that it is a free-standing one-extrusion-line lattice - the
   printable-fabric case that file names - and the flag follows from the
   request. It is NOT the inference that file rules out. Measured, and stated
   plainly because it matters: a loose patch is CLOSED as built (0 open edges,
   0 non-manifold, 0 piercing; it passes --gate and --gate --non-solid alike),
   so the flag is not what lets it through a check. What the flag does is
   stand down the stages that would quietly trim a lattice if it ever stopped
   being closed - Repair's hole fill, flap peel and orphan-component drop -
   and say to the next person that the openness would be intended.

   Undo: the patch is a new piece, so Undo is the ordinary one for an added
   piece. The flag is set with noUndo and silent for the same reason
   app-skin.js sets it that way - it belongs to the step that added the piece,
   not to a step of its own, and the status line naming the patch must survive. */

/* The patch controls, read once: { variant, pattern }. */
function NSO_skinPatchFromUI() {
  if (typeof document === 'undefined') return { variant: 'bordered', pattern: 'crosshatch' };
  var v = document.getElementById('skin-patch-variant');
  var p = document.getElementById('skin-pattern');
  return {
    variant: (v && v.value) || 'bordered',
    pattern: (p && p.value) || 'crosshatch'
  };
}

/* Build a standalone patch and add it as a new piece.
   opts: { variant, pattern, params, ... } - everything NSO_SkinPatch takes.
   Returns the build result with `modelId` on it, or { ok:false, reason }. */
function NSO_skinPatchAdd(opts) {
  opts = opts || {};
  var say = function (t, err) { if (typeof setStatus === 'function') setStatus(t, err); };
  if (typeof NSO_SkinPatch === 'undefined' || !NSO_SkinPatch) {
    say('Skin patch module missing', true); return { ok: false, reason: 'NSO_SkinPatch not loaded' };
  }
  if (typeof THREE === 'undefined' || typeof addModelFromZUpGeometry !== 'function') {
    say('Skin patch needs the viewport', true); return { ok: false, reason: 'no ingest path' };
  }
  var r = NSO_SkinPatch.buildPatch(opts);
  if (!r.ok) { say('Skin patch refused - nothing added (' + r.reason + ')', true); return r; }

  var g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(r.tris), 3));
  var name = 'patch_' + r.pattern + '_' + r.variant;
  var id = addModelFromZUpGeometry(name + '.stl', g);
  if (id == null) { say('Skin patch refused - the new piece looked empty', true); return { ok: false, reason: 'addModel refused' }; }
  r.modelId = id;

  var txt = 'Added ' + name + ' - ' + r.describeFull + ', ' + r.tris_count + ' tris';
  if (r.variant === 'bordered') {
    txt += ' - the rim takes the handling, the pattern does not';
  } else {
    txt += ' - the pattern alone: two shells is not the point, a one-line lattice is';
  }
  if (r.nonSolidAdvised) txt += ' - flagged non-solid';
  say(txt);
  if (r.nonSolidAdvised) {
    var m = null, i;
    for (i = 0; i < state.models.length; i++) if (state.models[i].id === id) m = state.models[i];
    if (m && typeof window.nsoNonSolidSet === 'function') {
      window.nsoNonSolidSet(m, true, { noUndo: true, silent: true });
    }
  }
  return r;
}

if (typeof document !== 'undefined') {
  (function wireSkinPatchButton() {
    function wire() {
      var btn = document.getElementById('btn-skin-patch');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () {
        try {
          NSO_skinPatchAdd(NSO_skinPatchFromUI());
        } catch (err) {
          console.error('[skin patch]', err);
          if (typeof setStatus === 'function') setStatus('Skin patch failed - nothing added (' + ((err && err.message) || err) + ')', true);
        }
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
