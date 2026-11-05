/* Delete painted - the app half of nso_paint_delete.js.
 *
 * Self-wired here rather than in the shared button block, the same way
 * app-sculpt.js wires Smooth, so adding a destructive tool does not touch a
 * protected fat file.
 *
 * ---------------------------------------------------------------------------
 * WHICH PAINT THIS READS
 * ---------------------------------------------------------------------------
 * The SELECT list - the pink target, `nsoMaskSelected(m)`. Not the exclude
 * list. That is the whole reason this feature can exist without contradicting
 * the standing rule in docs/HANDOFF.md:
 *
 *     the yellow  "no bake may touch this face"   - still a veto, here too
 *     the pink    "this face is my target"        - the operand
 *
 * Skin face (app-skin.js) already reads the pink exactly this way. This is its
 * second consumer, not a new kind of paint and not a new reading of the old
 * kind. A target that is ALSO painted excluded stands the delete down and the
 * status names the face, word for word as Skin face does.
 *
 * PAINT SCOPE: SUB-REGION. The operand is one identifiable face, or the one
 * shell that face belongs to, so the exclude test is scoped to THAT face,
 * through nsoMaskIsExcludedRaw with the raw plane the pick recorded. Paint
 * anywhere else on the piece does not block it: every other face comes out
 * with its plane unmoved, so "a painted face stays untouched by any bake"
 * holds for them by construction. Same rule as Smooth's whole-piece
 * stand-down applied at a different scope, not a laxer reading - see
 * docs/HANDOFF.md "Scoping" and docs/PAINT-DELETE.md.
 *
 * ---------------------------------------------------------------------------
 * LIFECYCLE
 * ---------------------------------------------------------------------------
 * The house one, through NSO_sculptCommitRaw (app-sculpt.js): undo entry
 * first ('deleteReplace', wired in app-core.js undoLast), display geometry
 * rebuilt from the new rawTris, placed instance re-seated. The undo entry
 * carries prevMask as well as the geometry, so one step puts the piece AND
 * its target face back - the target is cleared on success, because the plane
 * it named is not a face of this piece any more and leaving it set would aim
 * the next click at geometry that is gone.
 * ---------------------------------------------------------------------------
 */

/* The mode the Delete button runs in, read off the select next to it.
 *   face        cut the face out and leave the rim open
 *   face-seal   cut it out and let the shipped repair close the rim; if it
 *               cannot, the whole delete is reverted
 *   shell       cut out the whole body that face belongs to
 */
function NSO_deleteMode() {
  var sel = (typeof document !== 'undefined') ? document.getElementById('sel-mask-delete') : null;
  var v = sel ? sel.value : 'face';
  return (v === 'shell' || v === 'face-seal') ? v : 'face';
}

function NSO_deleteFaceName(face) {
  if (!face) return 'that face';
  if (face.dispAxis == null) return 'that recessed face';
  return (face.inner ? 'the inner ' : 'the ') +
         'XYZ'.charAt(face.dispAxis) + (face.dispSign > 0 ? '+' : '-') + ' face';
}

/* Delete the target face on the selected piece. Returns the module's report
 * so a caller - or the console, or the drive check - can read every number
 * the status line had to summarise. */
function NSO_deletePaintedFace(opts) {
  opts = opts || {};
  var say = (typeof setStatus === 'function') ? setStatus : function () {};

  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  if (!m) {
    say('Select a piece first', true);
    return { ok: false, reason: 'no selection' };
  }
  if (!m.rawTris || m.rawAxis !== 'zup') {
    say('Delete needs a raw piece - split, wrap or boolean it first', true);
    return { ok: false, reason: 'no rawTris' };
  }
  if (typeof NSO_PaintDelete === 'undefined' || !NSO_PaintDelete ||
      typeof NSO_PaintDelete.commit !== 'function') {
    say('Delete is unavailable - nso_paint_delete.js did not load', true);
    return { ok: false, reason: 'module missing' };
  }

  var face = (typeof nsoMaskSelected === 'function') ? nsoMaskSelected(m) : null;
  if (!face) {
    say('Delete needs a target face - Paint Selected, click the face, then Delete', true);
    return { ok: false, reason: 'no target' };
  }

  /* PAINT SCOPE: SUB-REGION - see docs/HANDOFF.md "Scoping". The veto is the
   * exclude list, asked about THIS face only and through the raw plane the
   * pick recorded, never re-derived from a bounding box. Paint on any other
   * face of the piece is none of this operation's business, because no other
   * face moves. */
  var excluded = (typeof nsoMaskIsExcludedRaw === 'function') &&
    nsoMaskIsExcludedRaw(m, face.n, face.d, face.axisIdx, face.keepMin, face.inner);
  if (excluded) {
    var n = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    say('Delete stood down - ' + n + ' painted face(s); ' + NSO_deleteFaceName(face) +
        ' is painted excluded. Paint wins: clear the exclude paint on it to delete it.', true);
    return { ok: false, reason: 'target is painted excluded', painted: n };
  }

  var mode = opts.mode || NSO_deleteMode();
  var r;
  try {
    r = NSO_PaintDelete.commit(m.rawTris, [face], {
      mode: mode === 'shell' ? 'shell' : 'face',
      seal: mode === 'face-seal'
    });
  } catch (err) {
    say('Delete failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
    return { ok: false, reason: 'threw: ' + ((err && err.message) || err) };
  }

  if (!r.ok || !r.report.applied) {
    /* Refused. The module already handed back the caller's own array, so
     * there is nothing to put back - but say which clause stopped it and
     * with which numbers, because "Delete refused" on its own tells the user
     * nothing about whether to try the other mode. */
    say('Delete refused - piece unchanged (' + r.report.reason + ')', true);
    return r.report;
  }

  var rep = r.report;
  var txt = 'Delete done - ' + NSO_deleteFaceName(face) + ', ' +
    rep.removedTris + ' tri(s) removed' +
    (mode === 'shell' ? ' (' + rep.componentsRemoved + ' shell(s))' : '') +
    ', tris ' + rep.before.tris + '→' + rep.after.tris +
    ', open ' + rep.before.openEdges + '→' + rep.after.openEdges +
    ', self-int ' + rep.before.selfIntersections + '→' + rep.after.selfIntersections +
    (rep.seal ? (rep.seal.applied ? ', sealed' : ', seal declined') : '') +
    (rep.after.watertight ? '' : ' - the piece is now OPEN');

  /* The commit's undo entry snapshots the paint for us - pushUndo
   * (app-core.js) fills prevMask from nsoMaskSnapshot when the caller does
   * not - so the target is consumed AFTER it and comes back with the geometry
   * on Undo. Same order app-skin.js uses for the same reason. */
  var committed = (typeof NSO_sculptCommitRaw === 'function')
    ? NSO_sculptCommitRaw(m, r.rawTris, 'deleteReplace', txt)
    : false;
  if (!committed) {
    say('Delete could not rebuild the piece - unchanged', true);
    return { ok: false, reason: 'commit failed' };
  }

  /* The target named a plane that is not a face of this piece any more.
   * noUndo because the entry pushed just above already carries the snapshot -
   * two entries would make the user press Undo twice for one action. */
  if (typeof nsoMaskSelectClear === 'function') nsoMaskSelectClear(m, { noUndo: true });
  if (typeof nsoMaskRepaint === 'function') nsoMaskRepaint();
  if (typeof window.nsoMaskHudRefresh === 'function') window.nsoMaskHudRefresh();
  return rep;
}

if (typeof window !== 'undefined') window.NSO_deletePaintedFace = NSO_deletePaintedFace;

if (typeof document !== 'undefined') {
  (function wireDeleteButton() {
    function wire() {
      var btn = document.getElementById('btn-mask-delete');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () {
        try {
          NSO_deletePaintedFace();
        } catch (err) {
          console.error('[paint-delete]', err);
          if (typeof setStatus === 'function') {
            setStatus('Delete failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
          }
        }
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
    setTimeout(wire, 0);
  })();
}
