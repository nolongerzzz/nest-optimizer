/* app-patch.js - Patch: fill an open loop with a surface that continues the
 * curvature round it. The app side of nso_patch.js; docs/PATCH.md.
 *
 * TWO DOORS, ONE ENGINE.
 *
 *   ADD > Patch. Arm it on a piece with a hole in it. Hovering outlines the
 *   open loop under the cursor (the loop is a hole, so there is nothing to
 *   hit: the loop whose outline the pointer is inside, on screen, is the one
 *   lit). A click patches that loop. One Undo per click. Click Patch again,
 *   or press Escape, to put it away.
 *
 *   The Findings card's PATCH, CAP and BRIDGE buttons (app-findings.js). They
 *   call window.nsoRepairRun(spec), which is this file's one commit path, with
 *   the fix the card chose for that finding and the finding's anchor vertices.
 *   The card then re-scans.
 *
 * Both run on the piece's raw Z-up soup (getModelRawSoup), through
 * NSO_Patch.patch / .cap / .bridgeLoops / .bridgeFaces, and replace the piece
 * the way every bake does: one Undo entry holding the old geometry, the old
 * raw soup, the old centre offset and size. patchReplace / capReplace /
 * bridgeReplace are rows in app-core.js's UNDO_REPLACE_LABEL.
 *
 * PAINT SCOPE: SUB-REGION (docs/HANDOFF.md, "Scoping"). Patch, Cap and Bridge
 * of two open loops only APPEND triangles: every triangle already on the piece
 * is kept byte for byte, so no painted or excluded face can be touched, and
 * the faces added take no paint of their own. Paint is a plane on the piece,
 * not a list of triangles, so it survives the rebuild as it survives every bake.
 * Bridge of two END FACES removes those faces, so it asks nsoMaskCount first
 * and stands down on any paint, naming the count. */
/* global THREE, state, setStatus, pushUndo, getModelRawSoup, rawResultToDisplayGeometry,
          computeCenterOffsetFromRaw, settlePlacedOnBed, nsoReseatPlacedPose, renderModelList,
          updateEditSize, updateUndoBtn, nsoMaskCount, getActiveModel, nsoHelpers */
(function () {
  'use strict';

  var HOVER_COLOR = 0xfacc15;
  var FOUND_COLOR = 0x38bdf8;
  var HOVER_PX = 14;               // a pointer this close to a rim picks that loop even outside it
  var UNDO = { cap: 'capReplace', patch: 'patchReplace', bridge: 'bridgeReplace' };

  var armed = false, busy = false, layer = null, hoverId = -1, cache = null, lastMsg = '';

  function NP() { return window.NSO_Patch; }
  function $(id) { return document.getElementById(id); }
  function activeModel() { return (typeof getActiveModel === 'function') ? getActiveModel() : null; }
  function placedFor(m) {
    if (!m || !state.placed) return null;
    for (var i = 0; i < state.placed.length; i++) {
      var p = state.placed[i];
      if (p && p.sourceId === m.id && p.mesh) return p;
    }
    return null;
  }
  function say(text, bad) {
    lastMsg = text;
    if (typeof setStatus === 'function') setStatus(text, !!bad);
    var r = $('patch-readout');
    if (r) { r.textContent = text; r.classList.toggle('carve-bad', !!bad); }
  }

  /* ---- raw -> the piece's display space (app-defects.js's measure) ---- */
  function frameFor(raw, geometry) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i + 2 < raw.length; i += 3) {
      var d = [raw[i], raw[i + 2], -raw[i + 1]];
      for (var k = 0; k < 3; k++) { if (d[k] < lo[k]) lo[k] = d[k]; if (d[k] > hi[k]) hi[k] = d[k]; }
    }
    if (!(lo[0] <= hi[0])) return null;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    var bb = geometry.boundingBox;
    return [(bb.min.x + bb.max.x) / 2 - (lo[0] + hi[0]) / 2,
            (bb.min.y + bb.max.y) / 2 - (lo[1] + hi[1]) / 2,
            (bb.min.z + bb.max.z) / 2 - (lo[2] + hi[2]) / 2];
  }
  function toDisplay(p, off) { return [p[0] + off[0], p[2] + off[1], -p[1] + off[2]]; }

  /* ---- commit: one Undo ---- */

  function commit(m, working, undoType) {
    var prev = { geometry: m.geometry.clone(), raw: m.rawTris, axis: m.rawAxis, off: m.centerOffset, size: { x: m.size.x, y: m.size.y, z: m.size.z } };
    pushUndo({
      type: undoType, modelId: m.id,
      prevGeometry: prev.geometry, prevRawTris: prev.raw, prevRawAxis: prev.axis,
      prevCenterOffset: prev.off, prevSize: prev.size
    });
    var geo = rawResultToDisplayGeometry(working);
    geo.computeBoundingBox();
    var size = new THREE.Vector3();
    geo.boundingBox.getSize(size);
    m.geometry = geo;
    m.rawTris = working;
    m.rawAxis = 'zup';
    m.centerOffset = computeCenterOffsetFromRaw(working);
    m.size = { x: size.x, y: size.y, z: size.z };
    var pe = placedFor(m);
    if (pe) {
      var px = pe.x, pz = pe.z;
      if (pe.mesh && state.modelGroup) {
        state.modelGroup.remove(pe.mesh);
        if (pe.mesh.material) {
          if (Array.isArray(pe.mesh.material)) pe.mesh.material.forEach(function (mt) { mt.dispose(); });
          else pe.mesh.material.dispose();
        }
      }
      var mat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, metalness: 0.05, roughness: 0.4, emissive: 0x0a3a5c, emissiveIntensity: 0.25 });
      var mesh = new THREE.Mesh(m.geometry, mat);
      mesh.position.set(px, m.size.y / 2 + 0.3, pz);
      mesh.userData.sourceId = m.id;
      mesh.userData.placedIndex = state.placed.indexOf(pe);
      state.modelGroup.add(mesh);
      pe.mesh = mesh; pe.geometry = m.geometry;
      pe.width = m.size.x; pe.depth = m.size.z; pe.height = m.size.y;
      if (typeof settlePlacedOnBed === 'function') settlePlacedOnBed(pe);
      if (typeof nsoReseatPlacedPose === 'function') nsoReseatPlacedPose(pe);
    }
    if (typeof updateEditSize === 'function') updateEditSize();
    if (typeof renderModelList === 'function') renderModelList();
    if (typeof updateUndoBtn === 'function') updateUndoBtn();
    cache = null;
  }

  /* ---- the verbs, as the card and the tool both call them ----

     spec: { fix: 'patch' | 'cap' | 'bridge', anchors: [[x,y,z], ...], faces?: true }
     anchors are vertices of the loops (raw space); the loops are found again on
     the piece as it stands now. Returns { ok, reason?, text, fix } and, on
     success, has changed the piece with one Undo entry. */
  function run(spec) {
    var np = NP();
    var m = activeModel();
    var label = spec.fix === 'bridge' ? 'Bridge' : spec.fix === 'cap' ? 'Cap' : 'Patch';
    function fail(why) { say(label + ' failed - ' + why + '; piece unchanged', true); return { ok: false, reason: why, fix: spec.fix }; }
    if (!np) return fail('nso_patch.js is not loaded');
    if (!m) { say('Select a piece first', true); return { ok: false, reason: 'no selection', fix: spec.fix }; }
    var soup = getModelRawSoup(m);
    if (!soup || soup.length < 27) return fail('the piece has no mesh');
    var before = np.topology(soup), r, how = '';
    if (spec.fix === 'bridge' && spec.faces) {
      var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
      if (painted > 0) {
        say('Bridge stood down - ' + painted + ' painted face(s); joining two faces takes them off the piece. Clear paint to bridge.', true);
        return { ok: false, reason: 'painted faces: ' + painted, fix: spec.fix, painted: painted };
      }
      var gs = np.gaps(soup), g = null, bd = 0.2;
      gs.forEach(function (x) {
        var d = Math.max(Math.hypot(x.a.centroid[0] - spec.anchors[0][0], x.a.centroid[1] - spec.anchors[0][1], x.a.centroid[2] - spec.anchors[0][2]),
                         Math.hypot(x.b.centroid[0] - spec.anchors[1][0], x.b.centroid[1] - spec.anchors[1][1], x.b.centroid[2] - spec.anchors[1][2]));
        if (d <= bd) { bd = d; g = x; }
      });
      if (!g) return fail('that gap is not on the piece any more');
      r = np.bridgeFaces(soup, g);
      how = 'Bridge joined two faces ' + g.gapMm.toFixed(1) + ' mm apart';
    } else {
      var ids = np.loopsAt(soup, spec.anchors);
      if (ids.some(function (i) { return i < 0; })) return fail('that opening is not on the piece any more');
      if (spec.fix === 'bridge') {
        if (ids.length !== 2 || ids[0] === ids[1]) return fail('Bridge needs two different openings');
        r = np.bridgeLoops(soup, ids[0], ids[1]);
        how = 'Bridge joined two openings';
      } else {
        var uniq = ids.filter(function (v, i) { return ids.indexOf(v) === i; });
        r = spec.fix === 'cap' ? np.cap(soup, uniq) : np.patch(soup, uniq);
        how = (spec.fix === 'cap' ? 'Cap' : 'Patch') + ' closed ' + uniq.length + ' opening' + (uniq.length === 1 ? '' : 's');
      }
    }
    if (!r || !r.ok) return fail((r && r.reason) || 'nothing to do');
    var after = np.topology(r.soup);
    commit(m, r.soup, UNDO[spec.fix]);
    /* One line per hole filled: its size, the surface the fill follows and how closely - or,
       never silently, that no fit could be made and what was done instead (nso_patch.js readout). */
    var holes = (r.filled && np.readout) ? r.filled.map(np.readout) : [];
    var text = how + ' - open edges ' + before.open + '→' + after.open + ', NM ' + before.nm + '→' + after.nm +
               (holes.length ? '. ' + holes.join('. ') : '') + '. One Undo puts it back.';
    say(text);
    return { ok: true, text: text, holes: holes, fix: spec.fix, before: before, after: after, result: r };
  }
  window.nsoRepairRun = run;

  /* ------------------------------------------------------------------ the tool */

  function ensureLoops() {
    var m = activeModel(), p = placedFor(m);
    if (!m || !p || !NP()) { cache = null; return null; }
    var raw = getModelRawSoup(m);
    if (cache && cache.raw === raw && cache.host === p.mesh) return cache;
    var off = frameFor(raw, p.mesh.geometry);
    if (!off) { cache = null; return null; }
    var list = NP().loops(raw).map(function (L) {
      var disp = L.pts.map(function (q) { return toDisplay(q, off); });
      return { id: L.id, n: L.n, raw: L.pts, disp: disp, anchor: L.pts[0], perimeterMm: L.perimeterMm };
    });
    cache = { raw: raw, host: p.mesh, model: m, off: off, loops: list };
    return cache;
  }

  function project(host, pt, out) {
    var v = new THREE.Vector3(pt[0], pt[1], pt[2]).applyMatrix4(host.matrixWorld).project(state.camera);
    return [v.x, v.y, v.z];
  }
  function loopAtPointer(ev) {
    var C = ensureLoops();
    if (!C || !state.renderer || !state.camera) return null;
    var rect = state.renderer.domElement.getBoundingClientRect();
    var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) return null;
    C.host.updateMatrixWorld(true);
    var best = null;
    C.loops.forEach(function (L) {
      var P2 = L.disp.map(function (q) {
        var s = project(C.host, q);
        return [(s[0] + 1) / 2 * rect.width, (1 - s[1]) / 2 * rect.height];
      });
      var inside = false, area = 0, j = P2.length - 1, i;
      for (i = 0; i < P2.length; j = i++) {
        var a = P2[i], b = P2[j];
        if ((a[1] > my) !== (b[1] > my) && mx < (b[0] - a[0]) * (my - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
        area += a[0] * b[1] - b[0] * a[1];
      }
      area = Math.abs(area) / 2;
      var near = Infinity;
      for (i = 0; i < P2.length; i++) {
        var p0 = P2[i], p1 = P2[(i + 1) % P2.length], dx = p1[0] - p0[0], dy = p1[1] - p0[1], l2 = dx * dx + dy * dy;
        var t = l2 > 0 ? Math.max(0, Math.min(1, ((mx - p0[0]) * dx + (my - p0[1]) * dy) / l2)) : 0;
        near = Math.min(near, Math.hypot(mx - p0[0] - t * dx, my - p0[1] - t * dy));
      }
      var score = inside ? area : (near <= HOVER_PX ? 1e12 + near : null);
      if (score != null && (!best || score < best.score)) best = { loop: L, score: score };
    });
    return best ? best.loop : null;
  }

  function clearLayer() {
    if (!layer) return;
    if (layer.parent) layer.parent.remove(layer);
    layer.children.forEach(function (c) { if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose(); });
    layer = null;
  }
  function line(pts, color, order) {
    var arr = [];
    pts.forEach(function (q) { arr.push(q[0], q[1], q[2]); });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    var o = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: color, depthTest: false, transparent: true, opacity: 1 }));
    o.renderOrder = order;
    o.raycast = function () {};
    o.frustumCulled = false;
    o.userData.skipXray = true;
    return o;
  }
  function draw() {
    clearLayer();
    if (!armed) return;
    var C = ensureLoops();
    if (!C) return;
    layer = new THREE.Group();
    layer.name = 'nso-patch-outline';
    C.loops.forEach(function (L) { if (L.id !== hoverId) layer.add(line(L.disp, FOUND_COLOR, 55)); });
    var hov = C.loops.filter(function (L) { return L.id === hoverId; })[0];
    if (hov) layer.add(line(hov.disp, HOVER_COLOR, 56));
    if (typeof nsoHelpers !== 'undefined') nsoHelpers.attach(C.host, layer, 'patch');
    else C.host.add(layer);
  }

  function disarmOthers() {
    if (state.carveArmed) { var c = $('btn-carve'); if (c) c.click(); else state.carveArmed = false; }
    if (state.maskPaint) {
      var pb = $(state.maskPaint === 'select' ? 'btn-mask-select' : 'btn-mask-paint');
      if (pb) pb.click();
    }
    if (state.seatHereArmed) { var s = $('btn-seat-here'); if (s) s.click(); else state.seatHereArmed = false; }
    if (typeof window.nsoBrushArmed === 'function' && window.nsoBrushArmed()) { var br = $('btn-brush'); if (br) br.click(); }
    if (state.measureOn) { var mb = $('btn-measure'); if (mb) mb.click(); else state.measureOn = false; }
    var lb = $('btn-lift');
    if (lb && lb.getAttribute('aria-pressed') === 'true') lb.click();
    state.softenArmed = false;
    state.capArmed = false;
    state.centerLockArmed = false;
  }

  function sync() {
    var b = $('btn-patch');
    if (b) { b.setAttribute('aria-pressed', armed ? 'true' : 'false'); b.classList.toggle('is-on', armed); }
    var r = $('patch-readout');
    if (r) r.hidden = !armed;
  }

  function setArmed(on) {
    on = !!on;
    if (on === armed) { sync(); return armed; }
    armed = on;
    hoverId = -1;
    if (!armed) { clearLayer(); cache = null; sync(); say('Patch off.'); return armed; }
    disarmOthers();
    var C = ensureLoops();
    sync();
    if (!NP()) say('Patch needs nso_patch.js', true);
    else if (!C) say('Select a piece to patch first', true);
    else if (!C.loops.length) say('Patch: no hole on this piece - Check piece shows what else is wrong.');
    else say('Patch: ' + C.loops.length + ' hole' + (C.loops.length === 1 ? '' : 's') + ' found. Hover one to outline it; click to fill it with a surface that continues what is round it.');
    draw();
    return armed;
  }

  var moveEv = null, moveRaf = false;
  function onMove(ev) {
    if (!armed || busy || ev.buttons) return;
    moveEv = ev;
    if (moveRaf) return;
    moveRaf = true;
    requestAnimationFrame(function () {
      moveRaf = false;
      var e = moveEv; moveEv = null;
      if (!e || !armed) return;
      var onCanvas = !!state.renderer && e.target === state.renderer.domElement;
      if (!onCanvas) return;
      var L = loopAtPointer(e), id = L ? L.id : -1;
      if (id !== hoverId) { hoverId = id; draw(); }
    });
  }

  /* app-core's pointerdown asks this first: a click that lands on a hole while
     Patch is armed is Patch's, and must not also start a move drag. */
  function takesClick(ev) {
    if (!armed || !ev || ev.button !== 0) return false;
    if (busy) return true;
    var L = loopAtPointer(ev);
    if (!L) return false;
    var anchor = L.anchor;
    busy = true;
    setTimeout(function () {
      try {
        var res = (typeof window.nsoFindingsRunTool === 'function')
          ? window.nsoFindingsRunTool({ fix: 'patch', anchors: [anchor] })
          : run({ fix: 'patch', anchors: [anchor] });
        return res;
      } finally { busy = false; hoverId = -1; cache = null; draw(); }
    }, 0);
    return true;
  }
  window.nsoPatchTakesClick = takesClick;

  function onKey(ev) { if (armed && ev.key === 'Escape') setArmed(false); }

  window.nsoPatchState = function () {
    var C = armed ? ensureLoops() : null;
    return { armed: armed, hover: hoverId, loops: C ? C.loops.map(function (L) { return { id: L.id, n: L.n, anchor: L.anchor }; }) : [], message: lastMsg };
  };
  window.nsoPatchSetArmed = setArmed;
  window.nsoPatchLoopAt = loopAtPointer;

  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('patch', {
    live: function () { return armed; },
    close: function () { setArmed(false); },
    clear: clearLayer,
    refresh: function () { cache = null; draw(); }
  });

  function mount() {
    var b = $('btn-patch');
    if (b && b.dataset.wired !== '1') { b.dataset.wired = '1'; b.addEventListener('click', function () { setArmed(!armed); }); }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('keydown', onKey);
    sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
