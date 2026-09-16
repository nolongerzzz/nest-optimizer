/* app-skin.js - the Skin face button: apply a contact skin (nso_skin.js) to
   one flat face of piece A, in place, as a bake.

   Which face: in a Join session with a partner B, the flat face of A that
   looks at B (the breakaway interface). Otherwise A's top face (+Z in the raw
   file axes, the face that points up on the plate). The pick is by direction:
   nso_skin.js takes the planar face whose normal is within 30 degrees of it,
   outermost if several are parallel, and refuses anything that is not a
   rectangle. The piece is otherwise untouched: the other faces keep their
   planes, only the wall triangles that border the skinned face are re-fanned
   so the seam has no T-junction.

   PAINT SCOPE: SUB-REGION. This bake acts on one identifiable face, so it
   checks paint on THAT face only, through nsoMaskIsExcludedRaw with the raw
   plane the face pick found (axis and side too when the face is axis-aligned,
   which is how a click on an outer face records itself). Paint anywhere else
   on the piece does not block it: the other faces stay exactly as they were,
   their planes included, so the rule "a painted face stays untouched by any
   bake" holds for them by construction. A painted target face stands the bake
   down and the status names it. This is the same rule as Smooth's
   whole-piece stand-down applied at a different scope, not a laxer reading -
   see docs/HANDOFF.md "Scoping".

   Lifecycle is the house one, through NSO_sculptCommitRaw (app-sculpt.js):
   undo entry first ('skinReplace', wired in app-core.js undoLast), display
   geometry rebuilt from the new rawTris, placed instance re-seated. */

/* Raw-axis direction from A toward its Join partner, or +Z (top). */
function NSO_skinDirForModel(m) {
  var up = [0, 0, 1];
  if (typeof state === 'undefined' || !state.joinSession || state.joinPartnerId == null || state.joinPartnerId === m.id) return up;
  var pA = state.placed.find(function (p) { return p && p.sourceId === m.id && p.mesh; });
  var pB = state.placed.find(function (p) { return p && p.sourceId === state.joinPartnerId && p.mesh; });
  if (!pA || !pB) return up;
  pA.mesh.updateMatrixWorld(true); pB.mesh.updateMatrixWorld(true);
  var ca = new THREE.Box3().setFromObject(pA.mesh).getCenter(new THREE.Vector3());
  var cb = new THREE.Box3().setFromObject(pB.mesh).getCenter(new THREE.Vector3());
  var d = cb.sub(ca);
  if (d.lengthSq() < 1e-12) return up;
  /* world -> A's display-local frame -> raw file axes ((x,y,z)_Yup = (x,-z,y)_Zup) */
  var q = new THREE.Quaternion();
  pA.mesh.getWorldQuaternion(q);
  d.applyQuaternion(q.invert()).normalize();
  return [d.x, -d.z, d.y];
}

/* Skin the active piece. opts: { pattern, params, mode, dir }.
   Returns nso_skin's result (ok:false + reason on any stand-down). */
function NSO_skinFaceOfModel(m, opts) {
  opts = opts || {};
  var say = function (t, err) { if (typeof setStatus === 'function') setStatus(t, err); };
  if (!m) { say('Select piece A first', true); return { ok: false, reason: 'no selection' }; }
  if (typeof NSO_Skin === 'undefined' || !NSO_Skin) { say('Skin module missing', true); return { ok: false, reason: 'NSO_Skin not loaded' }; }
  var soupIn = (m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null;
  if (!soupIn) { say('Skin needs a raw piece - unchanged', true); return { ok: false, reason: 'no rawTris' }; }
  var pattern = opts.pattern || 'crosshatch';
  var dir = opts.dir || NSO_skinDirForModel(m);

  var face = NSO_Skin.findFace(soupIn, dir);
  if (!face) {
    say('Skin refused - no flat face of A looks that way', true);
    return { ok: false, reason: 'no flat face within 30 degrees' };
  }
  /* paint on the target face wins */
  var axisIdx = null, keepMin = false;
  for (var a = 0; a < 3; a++) if (Math.abs(face.n[a]) > 0.999) { axisIdx = a; keepMin = face.n[a] < 0; }
  if (typeof nsoMaskIsExcludedRaw === 'function' &&
      (nsoMaskIsExcludedRaw(m, face.n, face.d, axisIdx, keepMin, false) || nsoMaskIsExcludedRaw(m, face.n, face.d))) {
    var faceName = axisIdx == null ? 'the target face' : ((keepMin ? '-' : '+') + 'XYZ'[axisIdx] + ' face');
    say('Skin stood down - ' + faceName + ' is painted; clear paint on it to skin it', true);
    return { ok: false, reason: 'target face painted', face: face };
  }

  var r = NSO_Skin.applySkinToFace(soupIn, { dir: dir, pattern: pattern, params: opts.params, mode: opts.mode });
  if (!r.ok) {
    say('Skin refused - piece unchanged (' + r.reason + ')', true);
    return r;
  }
  var txt = 'Skinned ' + (axisIdx == null ? 'face' : ((r.face.n[axisIdx] < 0 ? '-' : '+') + 'XYZ'[axisIdx] + ' face')) +
    ' - ' + r.describe + ', tips ' + (r.mode === 'recess' ? 'at the old face' : '+' + r.tipHeight.toFixed(2) + 'mm') +
    ', contact ' + r.tipArea.toFixed(1) + 'mm², ' + (r.tris.length / 9) + ' tris - Seat gap 0 puts B on the tips';
  if (typeof NSO_sculptCommitRaw === 'function') NSO_sculptCommitRaw(m, r.tris, 'skinReplace', txt);
  return r;
}

if (typeof document !== 'undefined') {
  (function wireSkinButton() {
    function wire() {
      var btn = document.getElementById('btn-skin-face');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () {
        try {
          var sel = document.getElementById('skin-pattern');
          var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
          NSO_skinFaceOfModel(m, { pattern: sel ? sel.value : 'crosshatch' });
        } catch (err) {
          console.error('[skin]', err);
          if (typeof setStatus === 'function') setStatus('Skin failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
        }
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
