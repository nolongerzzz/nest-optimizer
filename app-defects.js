/* Check piece — the canonical checker's findings, painted on the mesh.
 *
 * WHAT IT IS. One button. It runs the canonical battery (nso-defects.js,
 * which is tools/mesh_validate.py's checks in the browser) on the SELECTED
 * piece and draws what it found where it found it: the open edges as red
 * lines along the actual boundary, the non-manifold edges as orange lines,
 * the triangles of every piercing pair as red patches, and the faces the
 * wall/gap raycast measured under the nozzle floor as violet patches. The
 * numbers still go to the status line; the point of this file is that you no
 * longer have to go and find them.
 *
 * ON DEMAND, NOT LIVE. The check is a snapshot, taken when the button is
 * pressed, of the piece as it was then. It is not re-run on drag, on rotate,
 * on Undo or on every bake: the self-intersection pass is a BVH self-traversal
 * over every triangle and the wall pass casts a ray from every centroid, which
 * is seconds of work on a real part and not something to hang off a mousemove.
 * So the overlay has exactly two ways to end - the button, or the piece
 * changing under it - and `nsoDefectsRefresh` takes the second: the marks hang
 * off `p.mesh`, every bake swaps `p.mesh`, and a swap drops the marks and says
 * the check is stale rather than leaving yesterday's holes drawn on today's
 * geometry. Moving, rotating and seating the piece keep it, because the marks
 * are children and the defects move with the mesh they are on.
 *
 * REUSED, NOT REINVENTED. The drawing is the shape the app already has three
 * of:
 *   app-poslock.js  a THREE.LineSegments child of `p.mesh`, depthTest off,
 *                   renderOrder high, `raycast` stubbed so it is never a pick
 *                   target - this file's two line layers are that, in two
 *                   other colours.
 *   app-mask.js     a THREE.Mesh of selected triangles, unlit MeshBasicMaterial,
 *                   transparent, depthWrite off, renderOrder above the helpers
 *                   - this file's two patch layers are that.
 *   app-nonsolid.js the per-piece accessor shape: one exported reader
 *                   (`nsoDefectsReport`), one refresh, and a flag that is
 *                   passed in rather than inferred.
 *
 * WHERE IT DIFFERS, AND WHY. The paint keeps depthTest ON so a painted face on
 * the far side stays behind the solid: the paint answers "which face did I
 * click", and a click can only land on a face you can see. Defect marks answer
 * "where is the problem", and a piercing pair is usually INSIDE the piece
 * where nothing outside can see it, so every layer here has depthTest off and
 * shows through. That is the same call the lock outline and the plate's fence
 * lines already make.
 *
 * COLOURS. Nothing on the plate uses these two. Red 0xff2d2d for the things
 * that are holes or collisions (open edges, piercing pairs); orange 0xff8c1a
 * for non-manifold edges, the other topology fault, so the two read apart at a
 * glance; violet 0xc084fc for thin walls, which is deliberately the same
 * violet as the non-solid tag in the model list and the Non-solid flag's
 * accent, because the wall/gap check is that flag's own positive check
 * (docs/NON-SOLID.md §4). Piece sky blue, selection rose, paint yellow,
 * target pink, lock teal, A orange-in-a-join, B green, armed cyan - all
 * untouched.
 *
 * NON-SOLID SCOPE. This file reads `nsoNonSolid(m)` and passes it to
 * `NSO_Defects.locate` as `opts.nonSolid`; it never derives intent from an
 * edge count. The flag changes the VERDICT only - open edges stop being a
 * failure - and changes no measurement, so a piece flagged non-solid still
 * gets its boundary drawn in red, now labelled as declared rather than as a
 * fault. docs/NON-SOLID.md §3, the rule for new consumers. */
(function () {
  'use strict';

  var OPEN_COLOR = 0xff2d2d;    // open boundary edges
  var NM_COLOR   = 0xff8c1a;    // non-manifold edges
  var PIERCE_COLOR = 0xff2d2d;  // triangles of a piercing pair
  var THIN_COLOR = 0xc084fc;    // wall/gap under the nozzle floor

  /* Above the paint (40) and the target (41), so a piece that is both painted
     and checked shows the check on top - the check is the transient one. */
  var ORDER_PATCH = 50;
  var ORDER_LINE  = 52;

  /* One record, because the check is per piece and on demand. Null when
     nothing is drawn. `host` is the mesh the marks were added to, which is how
     a bake is detected: a bake builds a new mesh, so host stops being the
     piece's current mesh. */
  var shown = null;   // { modelId, host, group, report }

  function activeModel() {
    return (typeof getActiveModel === 'function') ? getActiveModel() : null;
  }
  function placedFor(m) {
    if (!m || typeof state === 'undefined' || !state.placed) return null;
    for (var i = 0; i < state.placed.length; i++) {
      var p = state.placed[i];
      if (p && p.sourceId === m.id && p.mesh) return p;
    }
    return null;
  }
  function modelById(id) {
    if (typeof state === 'undefined' || !state.models) return null;
    for (var i = 0; i < state.models.length; i++) if (state.models[i].id === id) return state.models[i];
    return null;
  }

  /* ---- raw space -> the piece's own display space ---- */

  /* The display mesh is the raw soup turned by rotateX(-90deg) and then moved
     (rawResultToDisplayGeometry, app-cut.js): dispX = rawX, dispY = rawZ,
     dispZ = -rawY, then a translation. The rotation is fixed; the translation
     is NOT assumed, because a piece centred by `geometry.center()` and one
     translated by a parent's offset do not carry the same one, and a piece
     rebuilt by the kernel carries whatever the kernel left. So it is measured:
     turn the soup, take its bounding box, take the display mesh's bounding
     box, and the difference between the two centres IS the translation. That
     is exact for any rigid offset and needs nothing stored on the model. */
  function frameFor(rawTris, geometry) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i + 2 < rawTris.length; i += 3) {
      var d = [rawTris[i], rawTris[i + 2], -rawTris[i + 1]];
      for (var k = 0; k < 3; k++) {
        if (d[k] < lo[k]) lo[k] = d[k];
        if (d[k] > hi[k]) hi[k] = d[k];
      }
    }
    if (!(lo[0] <= hi[0])) return null;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    var bb = geometry.boundingBox;
    return [
      (bb.min.x + bb.max.x) / 2 - (lo[0] + hi[0]) / 2,
      (bb.min.y + bb.max.y) / 2 - (lo[1] + hi[1]) / 2,
      (bb.min.z + bb.max.z) / 2 - (lo[2] + hi[2]) / 2
    ];
  }
  /* In place: a flat run of raw xyz triples becomes display xyz triples. */
  function toDisplay(flat, off) {
    var out = new Float32Array(flat.length);
    for (var i = 0; i + 2 < flat.length; i += 3) {
      out[i]     = flat[i] + off[0];
      out[i + 1] = flat[i + 2] + off[1];
      out[i + 2] = -flat[i + 1] + off[2];
    }
    return out;
  }

  /* ---- the layers ---- */

  function lineLayer(xyz, color, name) {
    if (!xyz.length) return null;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(xyz, 3));
    var mat = new THREE.LineBasicMaterial({
      color: color, depthTest: false, depthWrite: false, transparent: true, opacity: 1
    });
    var o = new THREE.LineSegments(g, mat);
    o.name = name;
    o.renderOrder = ORDER_LINE;
    o.raycast = function () {};
    o.userData.nsoDefectMark = true;
    return o;
  }
  function patchLayer(xyz, color, name) {
    if (!xyz.length) return null;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(xyz, 3));
    /* DoubleSide: a piercing fin is seen from whichever side the camera
       happens to be on, and a thin wall's inner face points away from you by
       definition. The paint is FrontSide because it marks an outward face;
       these mark a solid's insides. */
    var mat = new THREE.MeshBasicMaterial({
      color: color, side: THREE.DoubleSide, transparent: true, opacity: 0.85,
      depthTest: false, depthWrite: false
    });
    var o = new THREE.Mesh(g, mat);
    o.name = name;
    o.renderOrder = ORDER_PATCH;
    o.raycast = function () {};
    o.userData.nsoDefectMark = true;
    /* X-ray walks every mesh under modelGroup and turns it into a depth-less
       wireframe (applyXrayView, app-join.js). It has an opt-out for exactly
       this case; the marks are already depth-less and a wireframe patch is
       not readable. */
    o.userData.skipXray = true;
    return o;
  }

  function disposeTree(o) {
    if (!o) return;
    if (o.children) for (var i = o.children.length - 1; i >= 0; i--) disposeTree(o.children[i]);
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  }
  function clearMarks() {
    if (!shown) return;
    if (shown.group && shown.group.parent) shown.group.parent.remove(shown.group);
    disposeTree(shown.group);
    shown = null;
  }

  /* ---- the HUD line ---- */

  function fmt(r) {
    var bits = [];
    bits.push(r.openEdges + ' open');
    bits.push(r.nonManifoldEdges + ' non-manifold');
    bits.push(r.pierce + ' piercing');
    if (r.wall && r.wall.thinFaces) {
      bits.push(r.wall.thinFaces + ' thin (' + r.wall.minWallMm.toFixed(3) + ' mm)');
    } else if (r.wall && r.wall.thresholdMm > 0) {
      bits.push('wall ok' + (r.wall.minWallMm != null ? ' (' + r.wall.minWallMm.toFixed(3) + ' mm)' : ' (all sheet)'));
    }
    return bits.join(', ');
  }
  /* What is measured and what is PAINTED are not the same list, and the line
     says so rather than letting a FAIL with nothing drawn look like a bug.
     Winding and degenerate triangles are in the verdict because the validator
     puts them there; they have no place on the mesh that would read as
     anything (a zero-area triangle has no area to colour), so they are
     reported as numbers and named here as unpainted. */
  function unpainted(r) {
    var n = [];
    if (r.flippedEdges) n.push(r.flippedEdges + ' inconsistent winding');
    if (r.degenerateTris) n.push(r.degenerateTris + ' degenerate');
    if (r.coplanar) n.push(r.coplanar + ' coplanar contact');
    return n;
  }
  function hud(text) {
    var el = document.getElementById('adjust-status');
    if (el) el.textContent = text;
  }

  /* ---- the accessors everything downstream uses ---- */

  // The last report, or null. Nothing re-runs the check to answer a question.
  window.nsoDefectsReport = function () { return shown ? shown.report : null; };
  // Is the overlay up, and on which piece.
  window.nsoDefectsShownFor = function () { return shown ? shown.modelId : null; };

  /* The one line the check wants on the HUD (`#adjust-status`) while its marks
     are on screen, or null. Exported for the same reason nsoPosLockHudLine is:
     that element has several authors, and the paint's at-rest branch
     (app-mask.js) is the one that runs last after a selection. Without this,
     clicking the piece to look at the marks put the bare HUD tag back and the
     verdict fell off the screen - exactly when you are reading it. */
  window.nsoDefectsHudLine = function () {
    if (!shown) return null;
    var m = activeModel();
    var mine = m && shown.modelId === m.id;
    var other = mine ? null : modelById(shown.modelId);
    return 'Check ' + (mine ? '' : (other ? other.name + ' ' : 'other piece ')) +
      shown.report.verdict + ' - ' + fmt(shown.report);
  };

  /* ---- running it ---- */

  /* Runs the battery on the selected piece and draws it. Returns the report,
     or null with a status line saying why not. Synchronous: the button defers
     the call by a frame so the "Checking..." line paints first, and the tests
     call this directly. */
  window.nsoDefectsShow = function () {
    var m = activeModel();
    if (!m) {
      if (typeof setStatus === 'function') setStatus('Select a piece first - the check runs on one piece', true);
      return null;
    }
    var p = placedFor(m);
    if (!p) {
      if (typeof setStatus === 'function') setStatus('Put ' + m.name + ' on the plate first', true);
      return null;
    }
    if (typeof window.NSO_Defects === 'undefined') {
      if (typeof setStatus === 'function') setStatus('Checker not loaded', true);
      return null;
    }
    var raw = (typeof getModelRawSoup === 'function') ? getModelRawSoup(m) : m.rawTris;
    if (!raw || !raw.length) {
      if (typeof setStatus === 'function') setStatus('No geometry to check on ' + m.name, true);
      return null;
    }

    clearMarks();

    var nonSolid = (typeof window.nsoNonSolid === 'function') ? window.nsoNonSolid(m) : false;
    var report;
    try {
      report = window.NSO_Defects.locate(raw, { nonSolid: nonSolid });
    } catch (e) {
      console.warn('nsoDefectsShow', e);
      if (typeof setStatus === 'function') setStatus('Check failed: ' + ((e && e.message) || e), true);
      return null;
    }

    var off = frameFor(raw, p.mesh.geometry);
    if (!off) {
      if (typeof setStatus === 'function') setStatus('Check ran but could not be placed on ' + m.name, true);
      return null;
    }

    var group = new THREE.Group();
    group.name = 'nso-defect-marks';
    group.userData.nsoDefectMark = true;
    var mk = report.marks;
    var layers = [
      patchLayer(toDisplay(mk.thinTris, off), THIN_COLOR, 'nso-defect-thin'),
      patchLayer(toDisplay(mk.pierceTris, off), PIERCE_COLOR, 'nso-defect-pierce'),
      lineLayer(toDisplay(mk.nonManifoldEdges, off), NM_COLOR, 'nso-defect-nonmanifold'),
      lineLayer(toDisplay(mk.openEdges, off), OPEN_COLOR, 'nso-defect-open')
    ];
    var drawn = 0;
    for (var i = 0; i < layers.length; i++) if (layers[i]) { group.add(layers[i]); drawn++; }
    p.mesh.add(group);

    shown = { modelId: m.id, host: p.mesh, group: group, report: report };
    syncButton();

    if (typeof setStatus === 'function') {
      var un = unpainted(report);
      var line = 'Check ' + m.name + ': ' + report.verdict + ' - ' + fmt(report);
      if (!drawn) line += ' - nothing to paint, the piece is clean on every check that has a place on it';
      if (nonSolid && report.openEdges) line += ' - open edges shown but not counted against it (non-solid)';
      if (un.length) line += ' - also ' + un.join(', ') + ' (counted, not painted)';
      setStatus(line, report.verdict === 'FAIL');
    }
    hud('Check ' + report.verdict + ' - ' + fmt(report));
    return report;
  };

  window.nsoDefectsHide = function () {
    clearMarks();
    syncButton();
    return true;
  };

  /* ---- staleness, the button, the wiring ---- */

  /* A bake swaps `p.mesh`, and the marks are children of the old one, so they
     go with it. This notices that and drops the record, so the button, the
     reader and the HUD never claim a check that is no longer on screen. It
     also covers the piece being deleted or taken off the plate. */
  function dropIfStale() {
    if (!shown) return false;
    var m = modelById(shown.modelId);
    var p = m ? placedFor(m) : null;
    if (p && p.mesh === shown.host && shown.group.parent === shown.host) return false;
    clearMarks();
    return true;
  }

  /* The button is about the SELECTED piece, always. It reads Hide check only
     when the marks on screen are this piece's; with another piece's check up
     it still offers to check this one, and running it replaces the other. One
     check at a time, and never a button whose label is about a piece you are
     not looking at. */
  function mineShown() {
    var m = activeModel();
    return !!(shown && m && shown.modelId === m.id);
  }
  function syncButton() {
    var btn = document.getElementById('btn-check-defects');
    if (!btn) return;
    var m = activeModel();
    var mine = mineShown();
    btn.disabled = !m;
    btn.textContent = mine ? 'Hide check' : 'Check piece';
    btn.classList.toggle('is-on', mine);
    btn.setAttribute('aria-pressed', mine ? 'true' : 'false');
    btn.title = 'Run the canonical checker on this piece and paint what it finds ON the mesh: ' +
      'red lines on open edges, orange on non-manifold edges, red patches on the triangles of every ' +
      'piercing pair, violet on faces whose wall or gap measures under ' +
      (window.NSO_Defects ? window.NSO_Defects.NOZZLE_MIN_WALL : 0.42) + ' mm. ' +
      'A snapshot, not a live check - it clears itself when a bake changes the piece.' +
      (shown && !mine ? ' A check on ' + ((modelById(shown.modelId) || {}).name || 'another piece') +
        ' is on screen; running this one replaces it.' : '');
  }

  /* Called by app-core from `updateAdjustUI` (every selection change) and
     `renderModelList` (every list rebuild - which is what a bake, a delete and
     an Undo all end with, so all three drop the marks they left behind). */
  window.nsoDefectsRefresh = function () {
    var dropped = dropIfStale();
    syncButton();
    // The HUD, not setStatus: the bake that changed the piece has just
    // written its own status line and this must not wipe it.
    if (dropped) hud('Check cleared - the piece changed; press Check piece again');
  };

  function bind() {
    var btn = document.getElementById('btn-check-defects');
    if (btn && !btn._defectsBound) {
      btn.addEventListener('click', function () {
        if (mineShown()) { window.nsoDefectsHide(); if (typeof setStatus === 'function') setStatus('Check cleared'); return; }
        var m = activeModel();
        if (!m) {
          if (typeof setStatus === 'function') setStatus('Select a piece first - the check runs on one piece', true);
          return;
        }
        // The battery is seconds of work on a real part. Paint the line
        // first, run on the next frame, so the button never looks dead.
        if (typeof setStatus === 'function') setStatus('Checking ' + m.name + '...');
        hud('Checking ' + m.name + '...');
        btn.disabled = true;
        setTimeout(function () {
          try { window.nsoDefectsShow(); } finally { syncButton(); }
        }, 0);
      });
      btn._defectsBound = true;
    }
    syncButton();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
