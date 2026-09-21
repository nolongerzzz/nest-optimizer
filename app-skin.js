/* app-skin.js - the Skin face button: apply a contact skin (nso_skin.js) to
   one flat face of piece A, in place, as a bake.

   Which face, in this order:
     1. the SELECTED face, if the piece has one - the target the user painted
        with Paint Selected (app-mask.js, nsoMaskSelected). Its raw plane is
        handed to nso_skin.js as direction AND offset, so the pick is that
        face exactly, an inner one (a pocket floor) included.
     2. otherwise the auto-pick by direction: in a Join session with a partner
        B, the flat face of A that looks at B (the breakaway interface);
        outside a Join, A's top face (+Z in the raw file axes, the face that
        points up on the plate). nso_skin.js takes the planar face whose
        normal is within 30 degrees of it, outermost if several are parallel.
   An explicit selection OVERRIDES the auto-pick, it does not add to it: Skin
   takes exactly one face, so there is nothing for the two to share. The
   status line says which of the two named the face. Once the skin is on,
   the selection is consumed (the face it named is now relief, not a face),
   and Undo puts geometry and selection back together.
   Either way the face must be a rectangle, or Skin refuses. The piece is
   otherwise untouched: the other faces keep their planes, only the wall
   triangles that border the skinned face are re-fanned so the seam has no
   T-junction.

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
   geometry rebuilt from the new rawTris, placed instance re-seated.

   ---------------------------------------------------------------------------
   SKIN WRAP - the same skin on several faces at once
   ---------------------------------------------------------------------------
   `Skin wrap` (NSO_skinWrapModel) is "wrap" in this app's own sense, the one
   Soften's Full wrap already has: one click covers all six faces of a box
   instead of the one face you picked. It is NOT a curved wrap - every face
   still has to be a flat rectangle, and a cylinder's side is refused exactly
   as it always was (docs/HANDOFF.md, "Skin wrap + the double skin" and
   its parked ticket "the OTHER wrap", which records what a curved one would
   take and why it is a different engine).

   PAINT SCOPE: SUB-REGION, per face, the same rule as the single-face bake -
   an excluded face is left alone and NAMED in the status line, it does not
   stand the wrap down. A face that cannot take a skin (not a rectangle, no
   flat pick) is skipped and named too: the set the wrap acts on is "the flat
   rectangular faces that are not painted out", so leaving one out is the
   definition, not a half-result. A face that refuses for any other reason
   does stand the whole wrap down with the piece untouched. The SELECT target
   is a single-face idea and the wrap ignores it; the status says so when one
   is set.

   ---------------------------------------------------------------------------
   DOUBLE SKIN - layer 2, composed or free
   ---------------------------------------------------------------------------
   The `Layer 2` select adds a second pattern; `Free` decides which kind:
     off              one layer, as before.
     composed         layer 2 rides on layer 1's TIPS in one pass, one closed
                      shell, nothing else changes. The contact is the
                      intersection of the two tip sets, so the status reports
                      it against layer 1 alone - a second layer whose features
                      line up with layer 1's only makes the relief taller, and
                      that has to be visible rather than implied away.
     free             layer 2 is its OWN shell: a sheet resting on layer 1's
                      tips with its own relief on top, a second breakaway
                      interface. The piece then carries two shells, so this
                      bake SETS THE NON-SOLID FLAG on it and says so. That is
                      the flag's own case (docs/NON-SOLID.md): a deliberate,
                      visible declaration that this piece is not meant to be a
                      closed solid. Undo takes the flag off with the geometry
                      (app-core.js pushUndo snapshots it, like the paint). */

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

/* The Layer 2 controls, read once: { pattern, free } or null for off. */
function NSO_skinLayer2FromUI() {
  if (typeof document === 'undefined') return null;
  var sel = document.getElementById('skin-layer2');
  var v = sel ? String(sel.value || 'off') : 'off';
  if (!v || v === 'off') return null;
  var free = document.getElementById('chk-skin-free');
  return { pattern: v, free: !!(free && free.checked) };
}

/* A face of the piece, named the way the paint names it. */
function NSO_skinFaceAxis(n) {
  for (var a = 0; a < 3; a++) if (Math.abs(n[a]) > 0.999) return { axisIdx: a, keepMin: n[a] < 0 };
  return { axisIdx: null, keepMin: false };
}
function NSO_skinFaceLabel(n) {
  var ax = NSO_skinFaceAxis(n);
  return ax.axisIdx == null ? 'a face' : ((ax.keepMin ? '-' : '+') + 'XYZ'[ax.axisIdx]);
}
/* Paint on THIS face - the sub-region scope, asked the same two ways the
   single-face bake asks it (a click on an outer face records axis and side). */
function NSO_skinFacePainted(m, n, d) {
  if (typeof nsoMaskIsExcludedRaw !== 'function') return false;
  var ax = NSO_skinFaceAxis(n);
  return !!(nsoMaskIsExcludedRaw(m, n, d, ax.axisIdx, ax.keepMin, false) || nsoMaskIsExcludedRaw(m, n, d));
}

/* The faces a wrap takes: the six axis faces this piece actually has, less
   the ones paint excludes. Each is resolved to its own plane offset first, so
   the pick is that face exactly and cannot drift onto a rib wall of a face
   skinned earlier in the same wrap. */
function NSO_skinWrapFaces(m, soup) {
  var dirs = NSO_Skin.BOX_DIRS, faces = [], painted = [], missing = [];
  for (var i = 0; i < dirs.length; i++) {
    var d = dirs[i];
    var f = NSO_Skin.findFace(soup, d);
    if (!f) { missing.push(NSO_skinFaceLabel(d)); continue; }
    var nm = NSO_skinFaceLabel(f.n);
    if (NSO_skinFacePainted(m, f.n, f.d)) { painted.push(nm); continue; }
    faces.push({ dir: d, plane: f.d, name: nm });
  }
  return { faces: faces, painted: painted, missing: missing };
}

/* What a Skin bake leaves behind on the piece.

   The bake rewrites rawTris and nothing else: which pattern made that relief,
   at what parameters, over which faces, was only ever in the status line. The
   record is what the 3MF scene block writes (nso-3mf-scene.js) so a reopened
   plate can say "crosshatch, wrapped, +Z and -Z" instead of showing a relief
   nobody can name.

   It is PROVENANCE, not a replay buffer: the geometry in the file already
   carries the skin, nothing re-bakes from this, and a later bake overwrites
   it. Undo restores the geometry; the record goes with it, below. */
function NSO_recordSkin(m, info) {
  if (!m || !info || !info.pattern) return;
  m.skin = {
    pattern: String(info.pattern),
    scope: info.scope === 'wrap' ? 'wrap' : 'face',
    mode: info.mode == null ? null : String(info.mode),
    faces: Array.isArray(info.faces) ? info.faces.map(String) : [],
    layer2: (info.layer2 && info.layer2.pattern)
      ? { pattern: String(info.layer2.pattern), free: !!info.layer2.free }
      : null,
    params: (info.params && typeof info.params === 'object') ? info.params : null
  };
}

/* Skin every flat rectangular face of the piece that is not painted out.
   opts: { pattern, params, mode, layer2 }. */
function NSO_skinWrapModel(m, opts) {
  opts = opts || {};
  var say = function (t, err) { if (typeof setStatus === 'function') setStatus(t, err); };
  if (!m) { say('Select a piece first', true); return { ok: false, reason: 'no selection' }; }
  if (typeof NSO_Skin === 'undefined' || !NSO_Skin) { say('Skin module missing', true); return { ok: false, reason: 'NSO_Skin not loaded' }; }
  var soupIn = (m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null;
  if (!soupIn) { say('Skin wrap needs a raw piece - unchanged', true); return { ok: false, reason: 'no rawTris' }; }

  var pick = NSO_skinWrapFaces(m, soupIn);
  if (!pick.faces.length) {
    say('Skin wrap stood down - no face left to wrap' +
        (pick.painted.length ? ' (' + pick.painted.join(', ') + ' painted)' : '') + ' - piece unchanged', true);
    return { ok: false, reason: 'no unpainted flat face', painted: pick.painted };
  }
  var r = NSO_Skin.applySkinWrap(soupIn, {
    faces: pick.faces, pattern: opts.pattern || 'crosshatch', params: opts.params,
    mode: opts.mode, layer2: opts.layer2, skipUnskinnable: true
  });
  if (!r.ok) { say('Skin wrap refused - piece unchanged (' + r.reason + ')', true); return r; }

  var names = r.faces.map(function (f) { return f.name; }).join(', ');
  var txt = 'Wrapped ' + r.count + ' face' + (r.count === 1 ? '' : 's') + ' (' + names + ') - ' +
    r.faces[0].describe + ', tips +' + r.faces[0].tipHeight.toFixed(2) + 'mm, contact ' +
    r.tipArea.toFixed(1) + 'mm² over all of them, ' + (r.tris.length / 9) + ' tris';
  if (pick.painted.length) txt += ' - left painted: ' + pick.painted.join(', ');
  if (pick.missing.length) txt += ' - no flat face that way: ' + pick.missing.join(', ');
  if (r.skipped.length) txt += ' - skipped: ' + r.skipped.map(function (x) { return x.name + ' (' + x.reason + ')'; }).join('; ');
  if (typeof nsoMaskSelected === 'function' && nsoMaskSelected(m)) txt += ' - the target face is a single-face idea, the wrap ignores it';
  if (r.nonSolid) txt += ' - ' + (r.shells - 1) + ' free layer(s): flagged non-solid';

  if (typeof NSO_sculptCommitRaw === 'function') {
    NSO_sculptCommitRaw(m, r.tris, 'skinReplace', txt);
    NSO_recordSkin(m, {
      pattern: opts.pattern || 'crosshatch', scope: 'wrap', mode: opts.mode,
      faces: r.faces.map(function (f) { return f.name; }),
      layer2: opts.layer2, params: opts.params
    });
    if (r.nonSolid && typeof window.nsoNonSolidSet === 'function') window.nsoNonSolidSet(m, true, { noUndo: true, silent: true });
  }
  return r;
}

/* Skin the active piece. opts: { pattern, params, mode, dir, layer2 }.
   Returns nso_skin's result (ok:false + reason on any stand-down). */
function NSO_skinFaceOfModel(m, opts) {
  opts = opts || {};
  var say = function (t, err) { if (typeof setStatus === 'function') setStatus(t, err); };
  if (!m) { say('Select piece A first', true); return { ok: false, reason: 'no selection' }; }
  if (typeof NSO_Skin === 'undefined' || !NSO_Skin) { say('Skin module missing', true); return { ok: false, reason: 'NSO_Skin not loaded' }; }
  var soupIn = (m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null;
  if (!soupIn) { say('Skin needs a raw piece - unchanged', true); return { ok: false, reason: 'no rawTris' }; }
  var pattern = opts.pattern || 'crosshatch';
  /* the target: the painted selection first, the direction auto-pick after */
  var sel = (typeof nsoMaskSelected === 'function') ? nsoMaskSelected(m) : null;
  var dir, plane = null, source;
  if (opts.dir) { dir = opts.dir; source = 'given direction'; }
  else if (sel) { dir = sel.n.slice(); plane = sel.d; source = 'selected target'; }
  else {
    dir = NSO_skinDirForModel(m);
    source = (dir[2] === 1 && dir[0] === 0 && dir[1] === 0) ? 'auto-pick: top face' : 'auto-pick: faces B';
  }

  var face = NSO_Skin.findFace(soupIn, dir, plane);
  if (!face) {
    if (sel && plane != null) {
      say('Skin refused - the selected target (' + nsoMaskFaceName(sel) + ') is not a flat face of this piece any more; clear paint and select again', true);
      return { ok: false, reason: 'selected face not found on the piece' };
    }
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

  var r = NSO_Skin.applySkinToFace(soupIn, { dir: dir, plane: plane, pattern: pattern, params: opts.params, mode: opts.mode, layer2: opts.layer2 });
  if (!r.ok) {
    say('Skin refused - piece unchanged (' + r.reason + ')', true);
    return r;
  }
  var inner = plane != null && !!sel.inner;
  var txt = 'Skinned ' + (axisIdx == null ? 'face' : ((inner ? 'inner ' : '') + (r.face.n[axisIdx] < 0 ? '-' : '+') + 'XYZ'[axisIdx] + ' face')) +
    ' - ' + r.describe + ', tips ' + (r.mode === 'recess' ? 'at the old face' : '+' + r.tipHeight.toFixed(2) + 'mm') +
    ', contact ' + r.tipArea.toFixed(1) + 'mm²';
  /* A composed layer 2 can leave the contact exactly where it was (its
     features landing on layer 1's), so the status carries both numbers
     rather than letting "double skin" imply a reduction. */
  if (r.layer2 && r.layer2.mode === 'composed' && r.layer1TipArea != null) {
    txt += ' (layer 1 alone: ' + r.layer1TipArea.toFixed(1) + 'mm²)';
  }
  if (r.freeLayer) {
    txt += ', free layer ' + r.freeLayer.sheet + 'mm thick resting on layer 1\'s tips' +
      (r.freeLayer.gap ? ' with a ' + r.freeLayer.gap + 'mm gap' : '');
  }
  txt += ', ' + (r.tris.length / 9) + ' tris - Seat gap 0 puts B on the tips' +
    ' - target: ' + source;
  if (r.nonSolid) txt += ' - two shells: flagged non-solid';
  r.target = source;
  /* The commit's undo entry snapshots the paint (pushUndo fills prevMask),
     so the selection is consumed AFTER it and comes back with the geometry
     on Undo. noUndo: this is part of the skin step, not a step of its own. */
  if (typeof NSO_sculptCommitRaw === 'function') {
    NSO_sculptCommitRaw(m, r.tris, 'skinReplace', txt);
    NSO_recordSkin(m, {
      pattern: pattern, scope: 'face', mode: opts.mode,
      faces: [axisIdx == null ? 'face' : ((r.face.n[axisIdx] < 0 ? '-' : '+') + 'XYZ'[axisIdx])],
      layer2: opts.layer2, params: opts.params
    });
    if (sel && typeof nsoMaskSelectClear === 'function') nsoMaskSelectClear(m, { noUndo: true });
    /* A free layer leaves the piece with two shells. The flag is set AFTER
       the commit, noUndo, for the same reason the selection is consumed
       there: the commit's undo entry snapshots it (pushUndo, app-core.js),
       so one Undo puts the geometry and the flag back together. */
    if (r.nonSolid && typeof window.nsoNonSolidSet === 'function') window.nsoNonSolidSet(m, true, { noUndo: true, silent: true });
  }
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
          NSO_skinFaceOfModel(m, { pattern: sel ? sel.value : 'crosshatch', layer2: NSO_skinLayer2FromUI() });
        } catch (err) {
          console.error('[skin]', err);
          if (typeof setStatus === 'function') setStatus('Skin failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
        }
      });
      var wrapBtn = document.getElementById('btn-skin-wrap');
      if (wrapBtn && wrapBtn.dataset.nsoWired !== '1') {
        wrapBtn.dataset.nsoWired = '1';
        wrapBtn.addEventListener('click', function () {
          try {
            var sel2 = document.getElementById('skin-pattern');
            var m2 = (typeof getActiveModel === 'function') ? getActiveModel() : null;
            NSO_skinWrapModel(m2, { pattern: sel2 ? sel2.value : 'crosshatch', layer2: NSO_skinLayer2FromUI() });
          } catch (err) {
            console.error('[skin wrap]', err);
            if (typeof setStatus === 'function') setStatus('Skin wrap failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
          }
        });
      }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
