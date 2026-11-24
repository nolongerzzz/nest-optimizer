/* ============================================================
   Feature size - the Scale card's section for ONE feature of a piece: a tab,
   a boss, a rib, a slot, a pocket. docs/FEATURE-SIZE.md. The geometry is
   nso_feature_size.js (headless, tools/nso_feature_size_test.js); this file
   is the card section on it, after app-scale.js.

   THE SECTION works as the rest of the Scale card does: a number box per
   size with a slider under it, a ghost of the result on the piece while the
   numbers move, Set (or Enter) bakes it as one Undo, Cancel (or Escape)
   drops it and the piece was never touched.

     Feature size   arm it. The piece turns to a ghost.
     click          on a feature of the selected piece: the feature is found
                    (its faces lit blue) and its Length, Width and Height -
                    measured in its own frame, Height out of the face it
                    stands on (a recess's depth into it) - fill the boxes.
     Shift-click    another feature, sized with the first: every picked one
                    gets the typed size, each about its own middle - the two
                    tabs of a lid at once. A click on a picked one drops it.
     Keep ends |    how it resizes (nso_feature_size.js): Keep ends moves
     Stretch        the ends and keeps their corners, eases and rounds;
                    Stretch scales the whole feature (a round pin stays round).
     the boxes      every change re-runs the resize and draws the moved faces
                    green where they would land; a size it refuses says why
                    in red and Set waits.

   THE MM | IN TOGGLE is the Scale card's: the boxes show and take the unit
   the card shows (NSO_scaleIn), and the engine is given millimetres.

   ONE PREVIEW AT A TIME. Touching the card's own rows puts this away (the two
   would ghost the same piece), and arming this drops the card's preview.

   PAINT SCOPE: WHOLE-PIECE, as for Thicken: a painted piece stands this down
   at arm time, in words.
   ============================================================ */
(function () {
  'use strict';
  if (typeof NSO_FeatureSize === 'undefined') return;

  var FS = NSO_FeatureSize;
  var GHOST_OPACITY = 0.2;
  var CLICK_PX = 5, CLICK_MS = 600;
  var KEYS = ['length', 'width', 'height'];
  var LABEL = { length: 'Length', width: 'Width', height: 'Height' };

  var on = false, mode = 'keep';
  var m = null, mesh = null, soupRef = null, ix = null, group = null, ghostSaved = null;
  var regions = [];              // what find() returned, one per picked feature
  var start = {};                // the first feature's size when it was picked, mm
  var last = null;               // the last resize: { ok, soup, reason, target }
  var dirty = false, raf = 0, press = null;
  var pierceBase = null, gateTimer = 0;
  var objs = { picked: null, moved: null, edges: null };

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function inch() { return typeof NSO_scaleIn === 'function' && NSO_scaleIn(); }
  function MMI() { return typeof NSO_SCALE_MM_PER_IN === 'number' ? NSO_SCALE_MM_PER_IN : 25.4; }
  function show(mm) { return inch() ? (mm / MMI()).toFixed(3) : String(Math.round(mm * 100) / 100); }
  function toMm(v) { v = +v; return inch() ? v * MMI() : v; }
  function unit() { return inch() ? 'in' : 'mm'; }
  function f2(x) { return (Math.round(x * 100) / 100).toFixed(2); }

  function meshOf(model) {
    if (typeof cutMeshOf === 'function') return cutMeshOf(model);
    var pl = (state.placed || []).find(function (p) { return p && p.sourceId === model.id && p.mesh; });
    return pl ? pl.mesh : null;
  }

  /* ---------------- drawing ---------------- */

  function dispose(o) {
    if (!o) return;
    if (o.parent) o.parent.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  }
  function localGeo(flat) {
    var f = typeof nsoRawFrameOf === 'function' ? nsoRawFrameOf(m) : null;
    var pos = new Float32Array(flat.length);
    for (var i = 0; i < flat.length; i += 3) {
      var q = f ? nsoLocalPointFromRaw(f, [flat[i], flat[i + 1], flat[i + 2]]) : [flat[i], flat[i + 1], flat[i + 2]];
      pos[i] = q[0]; pos[i + 1] = q[1]; pos[i + 2] = q[2];
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }
  function trisOf(soup, list) {
    var out = new Float32Array(list.length * 9);
    list.forEach(function (f, k) { for (var c = 0; c < 9; c++) out[k * 9 + c] = soup[f * 9 + c]; });
    return out;
  }
  function ghost(onOff) {
    var mats = mesh ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    if (onOff) {
      ghostSaved = { skip: !!mesh.userData.skipXray, mats: mats.map(function (mt) {
        return { mt: mt, transparent: mt.transparent, opacity: mt.opacity, depthWrite: mt.depthWrite, depthTest: mt.depthTest };
      }) };
      mesh.userData.skipXray = true;
      mats.forEach(function (mt) { mt.transparent = true; mt.opacity = GHOST_OPACITY; mt.depthWrite = false; mt.needsUpdate = true; });
    } else if (ghostSaved) {
      ghostSaved.mats.forEach(function (s) {
        s.mt.transparent = s.transparent; s.mt.opacity = s.opacity; s.mt.depthWrite = s.depthWrite; s.mt.depthTest = s.depthTest; s.mt.needsUpdate = true;
      });
      if (mesh) mesh.userData.skipXray = ghostSaved.skip;
      ghostSaved = null;
    }
  }
  function clearDrawn() { Object.keys(objs).forEach(function (k) { dispose(objs[k]); objs[k] = null; }); }

  function redraw() {
    dirty = false;
    clearDrawn();
    last = null;
    if (!on || !group) return;
    if (!regions.length) { readout(); return; }
    var target = targetNow(), changedAny = KEYS.some(function (k) { return target[k] != null; });
    if (changedAny) {
      var r;
      try { r = FS.resize(soupRef, regions, target, mode); } catch (e) { r = { ok: false, reason: (e && e.message) || 'error' }; }
      last = r; last.target = target;
      if (r.ok) soonGate();
    }
    /* the picked faces, blue, where they stand now */
    var picked = [];
    regions.forEach(function (R) { picked = picked.concat(R.faces); });
    if (!(last && last.ok)) {
      objs.picked = new THREE.Mesh(localGeo(trisOf(soupRef, picked)), new THREE.MeshBasicMaterial({
        color: last && !last.ok ? 0xef4444 : 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false }));
      objs.picked.renderOrder = 44;
      group.add(objs.picked);
    } else {
      /* the result: the picked features, green, where they land (the faces
         round a foot stretch to follow, and are left to the ghost) */
      var res = last.soup, moved = [];
      picked.forEach(function (f) { var g = last.faceMap ? last.faceMap[f] : f; if (g >= 0) moved.push(g); });
      var g = localGeo(trisOf(res, moved));
      objs.moved = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: 0x4ade80, emissive: 0x14532d, emissiveIntensity: 0.5, roughness: 0.6, metalness: 0,
        transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
      objs.moved.renderOrder = 42;
      group.add(objs.moved);
      objs.edges = new THREE.LineSegments(new THREE.EdgesGeometry(g, 20),
        new THREE.LineBasicMaterial({ color: 0xbbf7d0, transparent: true, opacity: 0.95, depthTest: false }));
      objs.edges.renderOrder = 43;
      group.add(objs.edges);
    }
    readout();
  }

  /* THE PIERCE GATE. A fold is caught by the engine; a feature grown INTO
     another part of the piece (a slot widened through a wall beside it) is
     not a fold - it is one surface crossing another. NSO_Repair.inspect
     counts the piercing pairs, as Thicken's gate does: more after than before
     and the size is refused, in words. It is the slow part, so it runs once
     the numbers have stopped moving, and again at Set. */
  function gate() {
    gateTimer = 0;
    if (!on || !last || !last.ok || last.gated) return;
    last.gated = true;
    try {
      if (typeof NSO_Repair !== 'undefined' && NSO_Repair && typeof NSO_Repair.inspect === 'function') {
        if (pierceBase == null) pierceBase = NSO_Repair.inspect(soupRef).selfIntersections;
        var after = NSO_Repair.inspect(last.soup).selfIntersections;
        if (after > pierceBase) {
          last.ok = false;
          last.reason = 'at that size the feature would cut into another part of the piece (piercing pairs ' + pierceBase + '→' + after + ') - make it smaller';
          dirtyDraw();
        }
      }
    } catch (e) { /* no verdict: Set runs it again */ }
    readout();
  }
  function soonGate() { if (gateTimer) clearTimeout(gateTimer); gateTimer = setTimeout(gate, 220); }
  /* redraw the picked faces red without re-running the resize */
  function dirtyDraw() {
    clearDrawn();
    var picked = [];
    regions.forEach(function (R) { picked = picked.concat(R.faces); });
    objs.picked = new THREE.Mesh(localGeo(trisOf(soupRef, picked)), new THREE.MeshBasicMaterial({
      color: 0xef4444, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false }));
    objs.picked.renderOrder = 44;
    if (group) group.add(objs.picked);
  }

  /* ---------------- the boxes ---------------- */

  function box(k) { return $('scale-feature-' + k); }
  function slider(k) { return $('scale-feature-' + k + '-slider'); }

  /* What Set would bake: every box that says something other than the size
     the feature had, in mm. A box left as it was is no change. */
  function targetNow() {
    var t = {};
    KEYS.forEach(function (k) {
      var b = box(k);
      if (!b || String(b.value).trim() === '') return;
      var mm = toMm(b.value);
      if (!isFinite(mm)) return;
      if (start[k] != null && Math.abs(mm - start[k]) < (inch() ? 0.0005 * MMI() : 0.005)) return;
      t[k] = mm;
    });
    return t;
  }

  function populate() {
    KEYS.forEach(function (k) {
      var b = box(k), s = slider(k);
      if (!b) return;
      var v = start[k];
      b.value = v != null ? show(v) : '';
      b.disabled = v == null;
      var hint = $('scale-feature-' + k + '-unit');
      if (hint) hint.textContent = unit();
      if (s) {
        if (v == null || !(v > 0)) { s.disabled = true; return; }
        var step = inch() ? 0.001 : 0.01, lo = v / 4, hi = v * 4;
        if (inch()) { lo /= MMI(); hi /= MMI(); }
        s.disabled = false;
        s.min = String(+lo.toFixed(3)); s.max = String(+hi.toFixed(3)); s.step = String(step);
        s.value = b.value;
      }
    });
  }

  function readout() {
    var el = $('scale-feature-readout'), note = $('scale-feature-note'), set = $('btn-scale-feature-set'), cancel = $('btn-scale-feature-cancel');
    if (set) set.disabled = !(on && last && last.ok);
    if (cancel) cancel.disabled = !on;
    ['keep', 'stretch'].forEach(function (x) {
      var b = $('btn-scale-feature-' + x);
      if (b) { b.setAttribute('aria-pressed', mode === x ? 'true' : 'false'); b.classList.toggle('is-on', mode === x); }
    });
    var hl = $('scale-feature-label-height');
    if (hl) hl.textContent = regions.length && regions[0].kind === 'recessed' ? 'Depth' : 'Height';
    if (!el) return;
    if (!on) { el.textContent = 'Resize one feature - a tab, boss, slot or pocket - and leave the rest of the piece alone.'; if (note) { note.textContent = ''; note.classList.remove('scale-bad'); } return; }
    if (!regions.length) {
      el.textContent = 'Click a tab, boss, rib, slot or pocket on ' + (m && m.name ? m.name : 'the piece') + '. Shift-click adds another.';
      if (note) { note.textContent = ''; note.classList.remove('scale-bad'); }
      return;
    }
    var R0 = regions[0], fr = R0.frame;
    var u = unit(), d = function (x) { return show(x); };
    el.textContent = (regions.length > 1 ? regions.length + ' features picked, sized together - ' : '') +
      (R0.kind === 'recessed' ? 'A recess ' : 'A raised feature ') + d(fr.length) + ' × ' + d(fr.width) + ' × ' + d(fr.height) + ' ' + u +
      (R0.kind === 'recessed' ? ' deep' : ' tall') +
      (regions.length > 1 && regions.some(function (R) { return Math.abs(R.frame.length - fr.length) > 0.01 || Math.abs(R.frame.width - fr.width) > 0.01 || Math.abs(R.frame.height - fr.height) > 0.01; }) ? ' (the others differ - each gets the typed size)' : '') +
      '. Shift-click adds another; a click on a picked one drops it.';
    if (!note) return;
    if (!last) { note.textContent = 'Type a size or move a slider to see it on the piece. Set bakes it; nothing changes until then.'; note.classList.remove('scale-bad'); }
    else if (!last.ok) { note.textContent = 'Refused: ' + last.reason; note.classList.add('scale-bad'); }
    else {
      var s = last.sizes && last.sizes[0];
      note.textContent = 'Preview: ' + (s ? d(s.length) + ' × ' + d(s.width) + ' × ' + d(s.height) + ' ' + u : '') +
        (regions.length > 1 ? ' on all ' + regions.length : '') + (last.refloored ? ' (the face round its foot laid again)' : '') + ' - Set bakes it, Esc drops it.';
      note.classList.remove('scale-bad');
    }
  }

  /* ---------------- arm / pick ---------------- */

  function showPanel(v) {
    var p = $('scale-feature-panel'), b = $('btn-scale-feature');
    if (p) p.hidden = !v;
    if (b) { b.setAttribute('aria-pressed', v ? 'true' : 'false'); b.classList.toggle('is-on', !!v); }
  }

  function arm() {
    if (on) { cancel(); return { ok: true, left: true }; }
    var model = typeof getActiveModel === 'function' ? getActiveModel() : null;
    if (!model) { say('Feature size: select a piece first', true); return { ok: false, reason: 'no piece' }; }
    if (!(model.rawTris && model.rawAxis === 'zup' && model.rawTris.length >= 9)) { say('Feature size: this piece has no untransformed soup to work on', true); return { ok: false, reason: 'no soup' }; }
    var painted = typeof nsoMaskCount === 'function' ? nsoMaskCount(model) : 0;
    if (painted > 0) {
      say('Feature size stood down - ' + painted + ' painted face(s); the faces round a feature stretch with it, so no face can be promised untouched. Clear paint first.', true);
      return { ok: false, reason: 'painted faces: ' + painted };
    }
    var ms = meshOf(model);
    if (!ms) { say('Feature size: put the piece on the plate first. Nothing changed.', true); return { ok: false, reason: 'not placed' }; }
    var sc = $('btn-scale-cancel');
    if (sc && !sc.disabled) sc.click();                       // the card's own preview goes first: one ghost at a time
    on = true; m = model; mesh = ms; soupRef = model.rawTris; ix = FS.index(soupRef); regions = []; start = {}; last = null;
    group = new THREE.Group();
    group.userData.skipXray = true;
    if (typeof nsoHelpers !== 'undefined') nsoHelpers.attach(mesh, group, 'scale-feature'); else mesh.add(group);
    ghost(true);
    showPanel(true);
    populate();
    readout();
    say('Feature size - click a tab, boss, slot or pocket on the piece; Shift-click adds another.');
    tick();
    return { ok: true };
  }

  function teardown() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (gateTimer) { clearTimeout(gateTimer); gateTimer = 0; }
    clearDrawn();
    if (group && group.parent) group.parent.remove(group);
    group = null;
    ghost(false);
    on = false; m = null; mesh = null; soupRef = null; ix = null; regions = []; start = {}; last = null; press = null; pierceBase = null;
    showPanel(false);
    populate();
    readout();
  }

  function cancel(quiet) {
    if (!on) return false;
    teardown();
    if (!quiet) say('Feature size: put away - piece unchanged');
    return true;
  }

  function pickAt(event) {
    if (!on || !mesh || !state.camera || !state.renderer) return false;
    var r = state.renderer.domElement.getBoundingClientRect();
    var ndc = new THREE.Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
    var rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, state.camera);
    mesh.updateMatrixWorld(true);
    var hits = rc.intersectObject(mesh, false).filter(function (h) { return h.faceIndex != null; });
    if (!hits.length) return false;
    var geo = mesh.geometry, nTri = ((geo.index ? geo.index.count : geo.attributes.position.count) / 3) | 0;
    if (nTri !== soupRef.length / 9) { say('Feature size: the picture of this piece and its triangles disagree - Undo and redo the last change, then try again', true); return false; }
    return pickTri(hits[0].faceIndex, !!event.shiftKey);
  }

  /* The feature on triangle `tri`: replaces the pick, or (add) joins it; a
     triangle already in a picked feature drops that feature. */
  function pickTri(tri, add) {
    if (!on) return false;
    for (var i = 0; i < regions.length; i++) {
      if (regions[i].faces.indexOf(tri) >= 0) {
        regions.splice(i, 1);
        if (!regions.length) start = {};
        dirty = true;
        say('Feature size: dropped that one' + (regions.length ? ' - ' + regions.length + ' still picked' : ''));
        return true;
      }
    }
    var R = FS.find(soupRef, tri, { ix: ix });
    if (!R.ok) { say('Feature size: ' + R.reason, true); return false; }
    if (add && regions.length) regions.push(R);
    else {
      regions = [R];
      start = { length: R.frame.length, width: R.frame.width, height: R.frame.height };
      populate();
    }
    dirty = true;
    say('Feature size: ' + (R.kind === 'recessed' ? 'a recess ' : 'a raised feature ') + f2(R.frame.length) + ' × ' + f2(R.frame.width) + ' × ' + f2(R.frame.height) + ' mm' +
      (regions.length > 1 ? ' - ' + regions.length + ' picked' : ''));
    return true;
  }

  /* ---------------- set ---------------- */

  function set() {
    if (!on) return { ok: false, reason: 'not armed' };
    if (stale()) return { ok: false, reason: 'the piece changed' };
    if (dirty) redraw();
    if (gateTimer) { clearTimeout(gateTimer); gateTimer = 0; }
    if (last && last.ok && !last.gated) gate();
    if (!last || !last.ok) { say('Feature size: ' + (last ? 'refused - ' + last.reason : 'nothing to set - type a size first') + '; piece unchanged', true); return { ok: false, reason: last ? last.reason : 'nothing' }; }
    var r = last, model = m, n = regions.length, tgt = r.target;
    var words = KEYS.filter(function (k) { return tgt[k] != null; }).map(function (k) { return (k === 'height' && regions[0].kind === 'recessed' ? 'Depth' : LABEL[k]) + ' ' + f2(tgt[k]); }).join(', ');
    var status = 'Feature size: ' + (n > 1 ? n + ' features' : (regions[0].kind === 'recessed' ? 'a recess' : 'a feature')) + ' set to ' + words + ' mm (' + (mode === 'keep' ? 'ends kept' : 'stretched') + ')';
    /* the picks, on the new soup, so the section stays on them for the next change */
    var seeds = regions.map(function (R) { return r.faceMap ? r.faceMap[R.seed] : R.seed; });
    var add = regions.length > 1;
    teardown();
    var ok = typeof NSO_sculptCommitRaw === 'function' && NSO_sculptCommitRaw(model, r.soup, 'featureSizeReplace', status);
    if (!ok) { say('Feature size failed to commit - piece unchanged', true); teardown(); return { ok: false, reason: 'commit failed' }; }
    say(status);
    if (typeof updateEditSize === 'function') updateEditSize();
    /* armed again on the same piece, the same features picked */
    var again = arm();
    if (again.ok) seeds.forEach(function (t, i) { if (t >= 0) pickTri(t, add && i > 0); });
    if (on) redraw();
    say(status);
    return { ok: true, sizes: r.sizes, refloored: r.refloored };
  }

  /* ---------------- upkeep ---------------- */

  function stale() {
    if (!on) return false;
    var cur = typeof getActiveModel === 'function' ? getActiveModel() : null;
    if (cur === m && m.rawTris === soupRef && meshOf(m) === mesh) return false;
    cancel(true);
    say('Feature size put away - the piece or the selection changed under it. Nothing was set.');
    return true;
  }
  function tick() {
    raf = 0;
    if (!on || stale()) return;
    if (dirty) redraw();
    raf = requestAnimationFrame(tick);
  }

  function onDown(event) {
    if (!on || event.button !== 0) { press = null; return; }
    press = { x: event.clientX, y: event.clientY, t: performance.now() };
  }
  function onUp(event) {
    var p = press; press = null;
    if (!p || !on || event.button !== 0) return;
    var cv = state.renderer && state.renderer.domElement;
    if (!cv || event.target !== cv) return;
    if (Math.abs(event.clientX - p.x) > CLICK_PX || Math.abs(event.clientY - p.y) > CLICK_PX) return;
    if (performance.now() - p.t > CLICK_MS) return;
    if (stale()) return;
    pickAt(event);
  }

  function bindCanvas() {
    if (typeof state === 'undefined' || !state.renderer || !state.renderer.domElement || state._scaleFeatureBound) return;
    state._scaleFeatureBound = true;
    state.renderer.domElement.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', function () { press = null; });
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && on) cancel(); });
  }

  function bind() {
    bindCanvas();
    var b = $('btn-scale-feature');
    if (!b || b.dataset.nsoWired === '1') return;
    b.dataset.nsoWired = '1';
    b.addEventListener('click', function () { arm(); });
    $('btn-scale-feature-set').addEventListener('click', function () { set(); });
    $('btn-scale-feature-cancel').addEventListener('click', function () { cancel(); });
    ['keep', 'stretch'].forEach(function (x) {
      $('btn-scale-feature-' + x).addEventListener('click', function () { mode = x; dirty = true; readout(); });
    });
    KEYS.forEach(function (k) {
      var bx = box(k), sl = slider(k);
      bx.addEventListener('input', function () { if (sl && !sl.disabled) sl.value = bx.value; dirty = true; });
      if (sl) sl.addEventListener('input', function () { bx.value = sl.value; dirty = true; });
      var keys = function (e) {
        if (e.key === 'Enter') { e.preventDefault(); set(); }
        else if (e.key === 'Escape' && on) { e.preventDefault(); e.stopPropagation(); cancel(); }
      };
      bx.addEventListener('keydown', keys);
      if (sl) sl.addEventListener('keydown', keys);
    });
    /* the card's own rows: one preview at a time */
    var rows = $('scale-rows');
    if (rows) ['focusin', 'input'].forEach(function (t) { rows.addEventListener(t, function () { if (on) cancel(true); }, true); });
    /* the card's mm | in toggle, however it is switched: its pressed state is the unit */
    var inBtn = $('btn-scale-unit-in');
    if (inBtn && typeof MutationObserver !== 'undefined') {
      new MutationObserver(function () { populate(); dirty = true; readout(); }).observe(inBtn, { attributes: true, attributeFilter: ['aria-pressed'] });
    }
    populate();
    var menu = $('menu-scale');
    if (menu) menu.addEventListener('toggle', function () { if (!menu.open) cancel(true); });
    readout();
  }

  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('scale-feature', {
    live: function () { return on; },
    close: function () { cancel(true); },
    clear: function () { clearDrawn(); }
  });

  /* For the drive check: the same paths the controls run. */
  window.nsoScaleFeature = {
    arm: arm, cancel: cancel, set: set, pickTri: pickTri,
    on: function () { return on; },
    info: function () {
      return on ? {
        modelId: m.id, mode: mode, picked: regions.map(function (R) { return { kind: R.kind, seed: R.seed, faces: R.faces.length, length: R.frame.length, width: R.frame.width, height: R.frame.height }; }),
        target: targetNow(), ok: !!(last && last.ok), reason: last && !last.ok ? last.reason : null,
        sizes: last && last.ok ? last.sizes : null, refloored: last && last.ok ? last.refloored : 0,
        drawn: { picked: !!objs.picked, moved: !!objs.moved },
        readout: ($('scale-feature-readout') || {}).textContent, note: ($('scale-feature-note') || {}).textContent
      } : null;
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
