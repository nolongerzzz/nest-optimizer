/* ============================================================
   Thicken out / Thicken in, live - the app layer over app-finish.js's
   _thickenOffsetSoup / thickenSelectedModel.

   The engine is not touched and is not asked anything new. What was a button
   that baked the number in a box is a slider that shows the result first:

     Thicken out / Thicken in   arm it. The piece turns to a ghost and the
                                faces that would move are drawn where they
                                would land - the wall growing out, or into the
                                cavity.
     slider                     the mm. Every move re-runs _thickenOffsetSoup
                                with that number: the same call, the same
                                arguments, Set makes. The 1.5 that used to be a
                                number box is its readout (the ARROWS on the
                                Thicken row still step it).
     click a face               just that wall thickens - the surface the click
                                landed on, grown across creases shallower than
                                THICKEN_SMOOTH_DEG (the engine's own idea of
                                "one surface"): a box's face, a cylinder's whole
                                side. Click it again, or Whole piece, for the
                                whole piece. None picked is the whole piece.
     Set                        thickenSelectedModel(mode, mm, { mayMove }) -
                                the SAME function the buttons used to call, with
                                the wall as the engine's own mayMove filter
                                (added for Fatten; "a 0 forbids that face from
                                moving"). Deterministic, so the soup it bakes is
                                the ghost's soup bit for bit; every gate it ever
                                had (paint, inversion, piercing) is still its.
                                One Undo, 'thickenReplace', as before.
     Cancel / Escape            drops the ghost; the piece was never touched.

   Per-face needed no engine call that did not exist: mayMove is the filter.
   A wall on the wrong side for the verb (an outside face with Thicken in) is
   the engine's own refusal - "no face on the asked side survives" - and the
   readout says it.

   NOT SLOWED: only _thickenOffsetSoup runs on a slider move. The piercing
   check (NSO_Repair, the slow part) runs when the slider is let go, so a
   ghost that Set would refuse says so before Set is pressed, and Set stays
   greyed.

   PAINT SCOPE: WHOLE-PIECE, as for Thicken (docs/HANDOFF.md, "Scoping"). A
   painted face stands the control down at arm time with Thicken's own words.
   ============================================================ */
(function () {
  'use strict';

  var GHOST_OPACITY = 0.2;
  var MOVE_EPS = 1e-6;            // mm: a vertex that moved less than this has not moved
  var CLICK_PX = 5, CLICK_MS = 600;

  var on = false, mode = 'out';
  var m = null, soupRef = null, geoRef = null, usingRaw = false, mesh = null;
  var group = null, movedObj = null, edgeObj = null, wallObj = null;
  var ghostSaved = null;
  var topo = null;                // { soupRef, nf, tri, fn, outer, vertFaces } for the wall pick
  var wall = null;                // { mayMove: Uint8Array, count, seed }
  var last = null;                // { mode, mm, wall, res, soup, gateWhy }
  var dirty = false, raf = 0;
  var press = null;
  var pierceBase = null;

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function engineReady() {
    return typeof _thickenOffsetSoup === 'function' && typeof thickenSelectedModel === 'function' &&
           typeof _thickenIndex === 'function' && typeof _thickenFaceNormals === 'function' &&
           typeof _thickenClassifyOuter === 'function';
  }

  function slider() { return $('inp-thicken-mm'); }
  function mmNow() {
    var v = parseFloat((slider() || {}).value);
    return isFinite(v) && v > 0 ? v : 1.5;
  }
  function fmt(v) { return (Math.round(v * 100) / 100).toString(); }

  /* ---------------------------------------------------------------
     The piece
     --------------------------------------------------------------- */

  function meshOf(model) {
    if (typeof cutMeshOf === 'function') return cutMeshOf(model);
    var pl = (state.placed || []).find(function (p) { return p && p.sourceId === model.id && p.mesh; });
    return pl ? pl.mesh : null;
  }

  /* The soup Thicken works on - thickenSelectedModel's own choice, so the
     ghost and the bake read the same triangles. */
  function soupOfModel(model) {
    if (model.rawTris && model.rawAxis === 'zup') return { soup: model.rawTris, raw: true };
    var geo = model.geometry;
    if (!geo || !geo.attributes || !geo.attributes.position) return null;
    var pos = geo.attributes.position, index = geo.index, out = [];
    if (index) for (var i = 0; i < index.count; i++) { var vi = index.getX(i); out.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi)); }
    else for (var j = 0; j < pos.count; j++) out.push(pos.getX(j), pos.getY(j), pos.getZ(j));
    return out.length >= 9 ? { soup: new Float32Array(out), raw: false } : null;
  }

  /* Soup triangles -> the piece mesh's own frame (app-foam.js's localGeo). */
  function localGeo(soup) {
    var f = (usingRaw && typeof nsoRawFrameOf === 'function') ? nsoRawFrameOf(m) : null;
    var n = soup.length / 3, pos = new Float32Array(soup.length);
    for (var i = 0; i < n; i++) {
      var p = [soup[i * 3], soup[i * 3 + 1], soup[i * 3 + 2]];
      var q = f ? nsoLocalPointFromRaw(f, p) : p;
      pos[i * 3] = q[0]; pos[i * 3 + 1] = q[1]; pos[i * 3 + 2] = q[2];
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return g;
  }

  function disposeObj(o) {
    if (!o) return;
    if (o.parent) o.parent.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  }

  function ghost(onOff) {
    var mats = mesh ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
    if (onOff) {
      ghostSaved = { skip: !!mesh.userData.skipXray, mats: mats.map(function (mt) {
        return { mt: mt, transparent: mt.transparent, opacity: mt.opacity, depthWrite: mt.depthWrite,
                 depthTest: mt.depthTest, wireframe: mt.wireframe };
      }) };
      mesh.userData.skipXray = true;
      mats.forEach(function (mt) {
        mt.transparent = true; mt.opacity = GHOST_OPACITY; mt.depthWrite = false; mt.depthTest = true;
        mt.wireframe = false; mt.needsUpdate = true;
      });
    } else if (ghostSaved) {
      ghostSaved.mats.forEach(function (s) {
        s.mt.transparent = s.transparent; s.mt.opacity = s.opacity; s.mt.depthWrite = s.depthWrite;
        s.mt.depthTest = s.depthTest; s.mt.wireframe = s.wireframe; s.mt.needsUpdate = true;
      });
      if (mesh) mesh.userData.skipXray = ghostSaved.skip;
      ghostSaved = null;
    }
  }

  /* ---------------------------------------------------------------
     The wall: what "a face" is for this control
     --------------------------------------------------------------- */

  function topology() {
    if (topo && topo.soupRef === soupRef) return topo;
    var ix = _thickenIndex(soupRef);
    var fn = _thickenFaceNormals(ix.pos, ix.tri);
    var sign = fn.signedVolume < 0 ? -1 : 1;
    var outer = _thickenClassifyOuter(ix.pos, ix.tri, fn, sign);
    var nf = ix.tri.length / 3, nv = ix.pos.length / 3, vertFaces = new Array(nv);
    for (var f = 0; f < nf; f++) {
      if (!fn.ok[f]) continue;
      for (var k = 0; k < 3; k++) { var v = ix.tri[f * 3 + k]; (vertFaces[v] || (vertFaces[v] = [])).push(f); }
    }
    topo = { soupRef: soupRef, nf: nf, tri: ix.tri, fn: fn, outer: outer, vertFaces: vertFaces };
    return topo;
  }

  /* The clicked triangle grown across creases shallower than the engine's own
     THICKEN_SMOOTH_DEG, through shared corners as _thickenClassifyOuter walks
     them. A box face is its coplanar patch (the next face is 90 degrees away);
     a cylinder's side is the whole side. */
  function growWall(seed) {
    var T = topology();
    var cosSmooth = Math.cos((typeof THICKEN_SMOOTH_DEG === 'number' ? THICKEN_SMOOTH_DEG : 45) * Math.PI / 180);
    var may = new Uint8Array(T.nf), stack = [seed], count = 0;
    may[seed] = 1;
    while (stack.length) {
      var f = stack.pop(); count++;
      var nx = T.fn.n[f * 3], ny = T.fn.n[f * 3 + 1], nz = T.fn.n[f * 3 + 2];
      for (var k = 0; k < 3; k++) {
        var list = T.vertFaces[T.tri[f * 3 + k]];
        for (var i = 0; i < list.length; i++) {
          var g = list[i];
          if (may[g]) continue;
          if (nx * T.fn.n[g * 3] + ny * T.fn.n[g * 3 + 1] + nz * T.fn.n[g * 3 + 2] > cosSmooth) { may[g] = 1; stack.push(g); }
        }
      }
    }
    return { mayMove: may, count: count, seed: seed };
  }

  /* Pick the wall under a click. Every layer the ray crosses is a candidate:
     Thicken in wants the pocket wall behind the outside skin, so the first
     face on the asked side wins; when none is, the first face is taken and the
     engine says it is on the wrong side. */
  function pickWall(event) {
    if (!on || !mesh || !state.camera || !state.renderer) return false;
    var r = state.renderer.domElement.getBoundingClientRect();
    var ndc = new THREE.Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
    var rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, state.camera);
    mesh.updateMatrixWorld(true);
    var hits = rc.intersectObject(mesh, false).filter(function (h) { return h.faceIndex != null; });
    if (!hits.length) return false;
    var geo = mesh.geometry, nTri = ((geo.index ? geo.index.count : geo.attributes.position.count) / 3) | 0;
    if (nTri !== soupRef.length / 9) {
      say('Thicken: the picture of this piece and its triangles disagree - click Whole piece to thicken all of it', true);
      return false;
    }
    var T = topology();
    var want = mode === 'out' ? 1 : 0, seed = -1;
    for (var i = 0; i < hits.length; i++) {
      var f = hits[i].faceIndex;
      if (f < T.nf && T.fn.ok[f] && T.outer[f] === want) { seed = f; break; }
    }
    if (seed < 0) for (var j = 0; j < hits.length; j++) { var g = hits[j].faceIndex; if (g < T.nf && T.fn.ok[g]) { seed = g; break; } }
    if (seed < 0) return false;
    if (wall && wall.mayMove[seed]) clearWall(); else setWall(growWall(seed));
    return true;
  }

  function setWall(w) { wall = w; dirty = true; }
  function clearWall() { wall = null; dirty = true; }

  /* ---------------------------------------------------------------
     The ghost
     --------------------------------------------------------------- */

  function clearDrawn() {
    disposeObj(movedObj); movedObj = null;
    disposeObj(edgeObj); edgeObj = null;
    disposeObj(wallObj); wallObj = null;
  }

  function redraw() {
    dirty = false;
    clearDrawn();
    var mm = mmNow();
    var res;
    try { res = _thickenOffsetSoup(soupRef, mode, mm, wall ? { mayMove: wall.mayMove } : undefined); }
    catch (e) { res = { reason: (e && e.message) || 'error' }; }
    last = { mode: mode, mm: mm, wall: wall, res: res, soup: res && res.soup ? res.soup : null, gateWhy: null, gated: false };

    if (last.soup) {
      var out = [], n = soupRef.length / 9;
      for (var t = 0; t < n; t++) {
        var moved = false;
        for (var k = 0; k < 9; k++) if (Math.abs(last.soup[t * 9 + k] - soupRef[t * 9 + k]) > MOVE_EPS) { moved = true; break; }
        if (moved) for (var q = 0; q < 9; q++) out.push(last.soup[t * 9 + q]);
      }
      last.movedTris = out.length / 9;
      if (out.length) {
        var g = localGeo(new Float32Array(out));
        g.computeVertexNormals();
        movedObj = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
          color: 0x4ade80, emissive: 0x14532d, emissiveIntensity: 0.5, roughness: 0.6, metalness: 0,
          transparent: true, opacity: 0.62, side: THREE.DoubleSide, depthWrite: false }));
        movedObj.renderOrder = 42;
        group.add(movedObj);
        edgeObj = new THREE.LineSegments(new THREE.EdgesGeometry(g, 20),
          new THREE.LineBasicMaterial({ color: 0xbbf7d0, transparent: true, opacity: 0.95, depthTest: false }));
        edgeObj.renderOrder = 43;
        group.add(edgeObj);
      }
    }
    if (wall) {
      var wt = [];
      for (var f = 0; f < wall.mayMove.length; f++) if (wall.mayMove[f]) for (var c = 0; c < 9; c++) wt.push(soupRef[f * 9 + c]);
      wallObj = new THREE.Mesh(localGeo(new Float32Array(wt)), new THREE.MeshBasicMaterial({
        color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false }));
      wallObj.renderOrder = 44;
      group.add(wallObj);
    }
    readout();
  }

  /* Would Set be refused for piercing? The slow check, run on release. */
  function gate() {
    if (!on || !last || !last.soup) return;
    if (last.gated) return;
    last.gated = true;
    try {
      if (typeof NSO_Repair !== 'undefined' && NSO_Repair && typeof NSO_Repair.inspect === 'function') {
        if (pierceBase == null) pierceBase = NSO_Repair.inspect(soupRef).selfIntersections;
        var after = NSO_Repair.inspect(last.soup).selfIntersections;
        if (after > pierceBase) last.gateWhy = 'the moved faces would cross the piece (piercing pairs ' + pierceBase + '→' + after + ')';
      }
    } catch (e) { /* the bake runs the same check and says so */ }
    readout();
  }

  function readout() {
    var mm = mmNow();
    var read = $('thicken-read'), lr = $('thicken-level-read'), ro = $('thicken-readout'), set = $('btn-thicken-set'),
        whole = $('btn-thicken-whole');
    if (read) read.textContent = fmt(mm);
    if (lr) lr.textContent = fmt(mm);
    if (!on || !last) {
      if (set) set.disabled = true;
      if (whole) whole.disabled = true;
      return;
    }
    var res = last.res, text, bad = false;
    if (res && res.soup) {
      var side = mode === 'out' ? 'outer' : 'inner';
      text = 'Thicken ' + mode + ' ' + fmt(mm) + ' mm - ' + res.moved + ' ' + side + ' face(s) move, ' + res.held + ' held' +
             (wall ? ' (one wall: ' + wall.count + ' triangle(s) picked)' : ' (whole piece)');
      if (last.gateWhy) { text = 'Thicken ' + mode + ' ' + fmt(mm) + ' mm refused - ' + last.gateWhy; bad = true; }
    } else {
      var why = (res && res.reason) || 'piece unchanged';
      /* The engine's filter refusal is about the caller; for the person it is "that wall is on the other side". */
      if (wall && /^no face on the asked side survives/.test(why)) {
        why = 'the wall you picked is on the ' + (mode === 'out' ? 'inside' : 'outside') + ' - Thicken ' +
              (mode === 'out' ? 'in' : 'out') + ' moves it; click another face, or Whole piece';
      }
      text = 'Thicken ' + mode + ' ' + fmt(mm) + ' mm refused - ' + why;
      bad = true;
    }
    if (ro) { ro.textContent = text; ro.classList.toggle('is-refused', bad); }
    if (set) set.disabled = bad;
    if (whole) whole.disabled = !wall;
  }

  /* ---------------------------------------------------------------
     Arm / put away
     --------------------------------------------------------------- */

  function showPanel(v) {
    var p = $('thicken-panel');
    if (p) p.hidden = !v;
    [['btn-thicken-out', 'out'], ['btn-thicken-in', 'in']].forEach(function (x) {
      var b = $(x[0]);
      if (!b) return;
      var lit = !!v && mode === x[1];
      b.classList.toggle('is-on', lit);
      b.setAttribute('aria-pressed', lit ? 'true' : 'false');
    });
  }

  function arm(which) {
    if (!engineReady()) { say('Thicken needs app-finish.js', true); return { ok: false }; }
    if (on) {
      if (which === mode) { cancel(); return { ok: true, left: true }; }
      mode = which;                       // the other verb: same wall, same mm
      showPanel(true);
      dirty = true; redraw(); gate();
      return { ok: true, switched: true };
    }
    var model = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (!model) { say('Select a piece first', true); return { ok: false, reason: 'no piece' }; }
    var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(model) : 0;
    if (painted > 0) {
      say('Thicken stood down - ' + painted + ' painted face(s); the rim of the moving side ' +
          'is shared with the held faces, so no face can be promised untouched. Clear paint to thicken.', true);
      return { ok: false, reason: 'painted faces: ' + painted };
    }
    var src = soupOfModel(model);
    if (!src) { say('Thicken failed - piece unchanged', true); return { ok: false, reason: 'no soup' }; }
    var ms = meshOf(model);
    if (!ms) { say('Thicken: put the piece on the plate first. Nothing changed.', true); return { ok: false, reason: 'not placed' }; }

    on = true; mode = which;
    m = model; soupRef = src.soup; geoRef = model.geometry; usingRaw = src.raw; mesh = ms;
    wall = null; topo = null; pierceBase = null; last = null;
    openView();
    showPanel(true);
    redraw(); gate();
    say('Thicken ' + mode + ' - slide to see it on the piece; click a face to thicken just that wall; Set bakes it, Cancel drops it.');
    tick();
    return { ok: true };
  }

  function openView() {
    group = new THREE.Group();
    group.userData.skipXray = true;
    group.userData.nsoThickenGroup = true;
    nsoHelpers.attach(mesh, group, 'thicken');
    ghost(true);
  }
  function closeView() {
    clearDrawn();
    if (group && group.parent) group.parent.remove(group);
    group = null;
    ghost(false);
  }

  function teardown() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    closeView();
    showPanel(false);
    on = false;
    m = null; soupRef = null; geoRef = null; mesh = null; topo = null; wall = null; last = null; press = null; pierceBase = null;
    readout();
  }

  function cancel(quiet) {
    if (!on) return false;
    teardown();
    if (!quiet) say('Thicken cancelled - nothing changed');
    return true;
  }

  /* The piece moved on under the panel (another selection, an Undo, a bake):
     the ghost no longer describes it. */
  function stale() {
    if (!on) return false;
    var cur = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    var same = cur === m && (usingRaw ? m.rawTris === soupRef : m.geometry === geoRef) && meshOf(m) === mesh;
    if (!same) {
      cancel(true);
      say('Thicken put away - the piece or the selection changed under it. Nothing was set.');
      return true;
    }
    return false;
  }

  function tick() {
    raf = 0;
    if (!on) return;
    if (stale()) return;
    if (dirty) redraw();
    raf = requestAnimationFrame(tick);
  }

  /* ---------------------------------------------------------------
     Set
     --------------------------------------------------------------- */

  function set() {
    if (!on) return { ok: false, reason: 'Thicken is not armed' };
    if (stale()) return { ok: false, reason: 'the piece changed - Thicken put away' };
    if (dirty) redraw();
    if (!last || !last.soup) { say('Thicken ' + mode + ' ' + fmt(mmNow()) + ' mm refused - ' + ((last && last.res && last.res.reason) || 'nothing to set') + '; piece unchanged', true); return { ok: false }; }
    var ghostSoup = last.soup, picked = wall, kind = mode, mm = last.mm, keepMesh = mesh, keepModel = m;
    closeView();                                  // the bake swaps the piece's mesh under the ghost
    var opts = picked ? {
      mayMove: picked.mayMove,
      note: function () { return ' (one wall: ' + picked.count + ' triangle(s) picked)'; }
    } : undefined;
    var r = thickenSelectedModel(kind, mm, opts);
    if (r && r.ok) {
      teardown();
      r.ghostSoup = ghostSoup;
      return r;
    }
    // refused (the piercing gate, most likely): the piece is as it was; put the ghost back
    if (on && meshOf(keepModel) === keepMesh) { openView(); dirty = true; redraw(); if (last) { last.gateWhy = (r && r.reason) || 'refused'; last.gated = true; readout(); } }
    else teardown();
    return r || { ok: false };
  }

  /* ---------------------------------------------------------------
     Wiring
     --------------------------------------------------------------- */

  function onDown(event) {
    if (!on || event.button !== 0) { press = null; return; }
    press = { x: event.clientX, y: event.clientY, t: performance.now() };
  }
  /* A click, not a drag: the press lands where it let go, quickly. A drag is
     the orbit or a move and is nobody's pick. */
  function onUp(event) {
    var p = press; press = null;
    if (!p || !on || event.button !== 0) return;
    var cv = state.renderer && state.renderer.domElement;
    if (!cv || event.target !== cv) return;
    if (Math.abs(event.clientX - p.x) > CLICK_PX || Math.abs(event.clientY - p.y) > CLICK_PX) return;
    if (performance.now() - p.t > CLICK_MS) return;
    if (stale()) return;
    if (pickWall(event)) { redraw(); gate(); }
  }

  function bind() {
    [['btn-thicken-out', function () { arm('out'); }], ['btn-thicken-in', function () { arm('in'); }],
     ['btn-thicken-set', function () { set(); }], ['btn-thicken-cancel', function () { cancel(); }],
     ['btn-thicken-whole', function () { if (on) { clearWall(); redraw(); gate(); } }]].forEach(function (x) {
      var e = $(x[0]);
      if (e && e.dataset.nsoWired !== '1') { e.dataset.nsoWired = '1'; e.addEventListener('click', x[1]); }
    });
    var s = slider();
    if (s && s.dataset.nsoWired !== '1') {
      s.dataset.nsoWired = '1';
      s.addEventListener('input', function () { readout(); if (on) dirty = true; });
      s.addEventListener('change', function () { if (on) { if (dirty) redraw(); gate(); } });
    }
    if (typeof state === 'undefined' || !state.renderer || !state.renderer.domElement || state._thickenBound) return;
    state._thickenBound = true;
    state.renderer.domElement.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', function () { press = null; });
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && on) cancel(); });
  }

  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('thicken', {
    live: function () { return on; },
    close: function () { cancel(); }
  });

  /* For the drive checks and leaveTool: the same paths the controls run. */
  window.nsoThickenLive = {
    arm: arm, cancel: cancel, set: set,
    on: function () { return on; },
    info: function () {
      return on ? {
        mode: mode, mm: mmNow(), wall: wall ? { count: wall.count, seed: wall.seed } : null,
        ok: !!(last && last.soup), reason: last && last.res && last.res.reason, gateWhy: last && last.gateWhy,
        moved: last && last.res ? last.res.moved : null, held: last && last.res ? last.res.held : null,
        movedTris: last ? last.movedTris : null, soup: last ? last.soup : null,
        readout: ($('thicken-readout') || {}).textContent, modelId: m.id
      } : null;
    },
    pickTriangle: function (seed) {                  // for a check that names a triangle rather than aiming a click
      if (!on) return false;
      if (wall && wall.mayMove[seed]) clearWall(); else setWall(growWall(seed));
      redraw(); gate();
      return true;
    },
    objects: function () { return { group: group, moved: movedObj, edges: edgeObj, wall: wallObj, mesh: mesh }; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
