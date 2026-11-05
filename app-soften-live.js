/* ============================================================
   Soften, live - the app layer over app-finish.js's softenCompute and
   commitSoften, in the shape app-thicken-live.js gave Thicken.

   Soften used to be a button and a drop-down: arm it, click a face, and the
   bake happened on that click with whatever the drop-down said. Nothing was
   shown first. Now:

     Soften                    opens the card. A shelf of four tiles - Round,
                               Corners, Corners+edges, Bevel - each a small
                               cube with its top face softened by the real
                               engine in that mode, the surface the style
                               changes lit green, so the picture is what the
                               style does and not an artist's idea of it.
                               Nothing is on the piece yet.

                               ONE FACE, NOT THE WHOLE CUBE, because that is
                               where the four differ. Wrapped whole, a box
                               comes out the same for Round and for
                               Corners+edges (twelve quarter-round edges and
                               eight ball corners either way); softened a face
                               at a time - which is how Soften treats a cut
                               end, a tube, anything that is not a box - Round
                               rounds the face's rim, Corners puts a ball on
                               each corner and leaves the edges square,
                               Corners+edges does both with the setback blend,
                               and Bevel cuts flat.
     a tile                    the style. The piece turns to a ghost and what
                               Soften would leave is drawn over it: the whole
                               result faint, the surface that changed bright.
     R slider / box            the radius. Every move re-runs the engine with
                               that number - the same call the bake makes - so
                               the preview follows the slider at the pace the
                               engine can keep (app-live-slider.js).
     Soften again              bakes it: the soup that is on screen, installed
                               by commitSoften, the function every Soften bake
                               has always ended in. Same Undo step, same paint
                               and outline handling. There is no second
                               calculation that could disagree with the ghost.
     Cancel / Escape           drops the ghost; the piece was never touched.

   WHAT NEEDS A CLICK. Nothing, for a box (Full wrap) or a piece with pockets
   the wrap can name: the whole piece is previewed the moment a style is
   picked. A piece the wrap cannot do - a cut end, a tube, anything that is not
   a box - is softened one face at a time, as it always was: click a face and
   it is added to the preview, click it again to take it off. Full wrap off
   asks for faces on a box too. softenCompute decides which of these a piece
   is; this file only reads its answer ({ needPick }).

   The pocket wraps go through the boolean kernel, which is asynchronous: their
   preview arrives a moment after the change, and a change made while one is
   running waits for it (state.nsoWrapBusy is the engine's own flag).

   PAINT SCOPE: as Soften's was. softenCompute reads the paint and leaves a
   painted-out face square; the preview shows exactly that.
   ============================================================ */
(function () {
  'use strict';

  var GHOST_OPACITY = 0.2;
  var CLICK_PX = 5, CLICK_MS = 600;
  var NAMES = { fillet: 'Round', corners: 'Corners', cornersedges: 'Corners+edges', chamfer: 'Bevel' };

  /* The tiles: a 10 mm cube with its top face softened at 2.8 mm, drawn lit from
     the same side as Stock's, with whatever is not a flat face of the cube in
     the ghost's green. */
  var TILE_CUBE = 10, TILE_R = 2.8, TILE_HI = [74, 222, 128];

  var on = false, style = null;
  var m = null, soupRef = null, mesh = null, group = null;
  var picks = [];                       // faces named so far: { axisIdx, keepMin, plane, recessed }
  var plan = null;                      // what softenCompute last handed `commit`
  var refused = null, needPick = false, waiting = false, needsFaces = false, kind = null;
  var seq = 0, rerun = false, dirty = false, raf = 0;
  var drawn = { result: null, changed: null, edges: null };
  var ghostSaved = null, baseIdx = null;
  var press = null, tilesDrawn = false, liveHandle = null;
  // Pick edges: the box edges named this bake (NSO_boxEdgeFaces numbers), what is drawn for them
  var edgeOn = false, edgePicks = [], needEdges = false, edgeDrawn = null;
  var EDGE_PX = 14;                     // a click within this many pixels of an edge names it

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function fmt(v) { return (Math.round(v * 100) / 100).toString(); }
  function engineReady() {
    return typeof softenCompute === 'function' && typeof commitSoften === 'function' &&
           typeof getEdgeTreat === 'function' && typeof getActiveModel === 'function';
  }

  function rNow() {
    var v = parseFloat(($('inp-soften-r') || {}).value);
    return isFinite(v) && v > 0 ? v : 0.5;
  }
  function fullWrapNow() { return typeof getFullWrap === 'function' ? !!getFullWrap() : true; }
  function hudText() { var e = $('status'); return e ? e.textContent : ''; }

  function meshOf(model) {
    if (typeof cutMeshOf === 'function') return cutMeshOf(model);
    var pl = (state.placed || []).find(function (p) { return p && p.sourceId === model.id && p.mesh; });
    return pl ? pl.mesh : null;
  }

  /* ---------------------------------------------------------------
     Tiles
     --------------------------------------------------------------- */

  function tiles() {
    var shelf = $('soften-shelf');
    return shelf ? Array.prototype.slice.call(shelf.querySelectorAll('button[data-style]')) : [];
  }

  function onCubeFace(soup, t, h) {
    var o = t * 9;
    for (var k = 0; k < 3; k++) {
      if (Math.abs(Math.abs(soup[o + k]) - h) < 1e-3 && Math.abs(Math.abs(soup[o + 3 + k]) - h) < 1e-3 &&
          Math.abs(Math.abs(soup[o + 6 + k]) - h) < 1e-3) return true;
    }
    return false;
  }

  function drawTiles() {
    if (tilesDrawn) return 0;
    if (typeof rawBoxSoup !== 'function' || typeof softenSelectedFace !== 'function' ||
        !window.nsoStockShelf || typeof window.nsoStockShelf.paint !== 'function') return 0;
    tilesDrawn = true;
    var h = TILE_CUBE / 2, cube = rawBoxSoup([-h, -h, -h], [h, h, h]), done = 0;
    tiles().forEach(function (btn) {
      var canvas = btn.querySelector('canvas');
      if (!canvas) return;
      var soup = null, st = btn.getAttribute('data-style');
      // the +Z face, softenSelectedFace's own arguments: axis 2, keep the lower side, the plane it is on
      try { soup = softenSelectedFace(cube, 2, false, TILE_R, st, h); } catch (e) { soup = null; }
      if (!soup || soup.length < 9) return;
      var lit = function (t) { return onCubeFace(soup, t, h) ? null : TILE_HI; };
      if (window.nsoStockShelf.paint(canvas, soup, lit)) { canvas.setAttribute('data-drawn', '1'); done++; }
    });
    return done;
  }

  function markTiles() {
    tiles().forEach(function (btn) {
      var lit = !!on && btn.getAttribute('data-style') === style;
      btn.classList.toggle('is-picked', lit);
      btn.setAttribute('aria-pressed', lit ? 'true' : 'false');
    });
  }

  /* ---------------------------------------------------------------
     The ghost
     --------------------------------------------------------------- */

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

  function openView() {
    group = new THREE.Group();
    group.userData.skipXray = true;
    group.userData.nsoSoftenGroup = true;
    nsoHelpers.attach(mesh, group, 'soften');
    ghost(true);
  }
  function clearDrawn() {
    disposeObj(drawn.result); disposeObj(drawn.changed); disposeObj(drawn.edges);
    drawn = { result: null, changed: null, edges: null };
  }
  function closeView() {
    clearEdges();
    clearDrawn();
    if (group && group.parent) group.parent.remove(group);
    group = null;
    ghost(false);
  }

  /* Soup -> the piece mesh's own frame (app-thicken-live.js's localGeo). */
  function localPositions(soup) {
    var f = (typeof nsoRawFrameOf === 'function') ? nsoRawFrameOf(m) : null;
    var n = soup.length / 3, pos = new Float32Array(soup.length);
    for (var i = 0; i < n; i++) {
      var p = [soup[i * 3], soup[i * 3 + 1], soup[i * 3 + 2]];
      var q = f ? nsoLocalPointFromRaw(f, p) : p;
      pos[i * 3] = q[0]; pos[i * 3 + 1] = q[1]; pos[i * 3 + 2] = q[2];
    }
    return pos;
  }
  function geoOf(pos) {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }

  /* Which result triangles are the piece's own and which Soften made. A result
     triangle is the piece's own when it lies in a plane the piece already had:
     a box face re-cut by the wrap is, a fillet band or a corner patch is not.
     Planes are keyed by their normal (to 0.005) and listed by offset, so one
     lookup answers it. It is the picture's emphasis only - nothing bakes from
     it. */
  function triPlane(s, o) {
    var ux = s[o + 3] - s[o], uy = s[o + 4] - s[o + 1], uz = s[o + 5] - s[o + 2];
    var vx = s[o + 6] - s[o], vy = s[o + 7] - s[o + 1], vz = s[o + 8] - s[o + 2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l < 1e-9) return null;
    nx /= l; ny /= l; nz /= l;
    // opposite windings are one plane: face the normal into the half-space it points at first
    if (nx < -1e-6 || (Math.abs(nx) <= 1e-6 && (ny < -1e-6 || (Math.abs(ny) <= 1e-6 && nz < 0)))) { nx = -nx; ny = -ny; nz = -nz; }
    return { key: Math.round(nx * 200) + ',' + Math.round(ny * 200) + ',' + Math.round(nz * 200),
             d: nx * s[o] + ny * s[o + 1] + nz * s[o + 2] };
  }
  function planeIndex(soup) {
    var map = new Map(), n = (soup.length / 9) | 0;
    for (var t = 0; t < n; t++) {
      var p = triPlane(soup, t * 9);
      if (!p) continue;
      var arr = map.get(p.key);
      if (!arr) { arr = []; map.set(p.key, arr); }
      var seen = false;
      for (var i = 0; i < arr.length; i++) if (Math.abs(arr[i] - p.d) < 0.01) { seen = true; break; }
      if (!seen) arr.push(p.d);
    }
    return map;
  }
  function onOldPlane(idx, soup, t) {
    var p = triPlane(soup, t * 9);
    if (!p) return true;
    var arr = idx.get(p.key);
    if (!arr) return false;
    for (var i = 0; i < arr.length; i++) if (Math.abs(arr[i] - p.d) < 0.03) return true;
    return false;
  }

  function drawPlan() {
    clearDrawn();
    if (!plan || !group) return;
    if (!baseIdx) baseIdx = planeIndex(soupRef);
    var soup = plan.soup, n = (soup.length / 9) | 0;
    var pos = localPositions(soup), keep = [];
    for (var t = 0; t < n; t++) if (!onOldPlane(baseIdx, soup, t)) keep.push(t);
    plan.changedTris = keep.length;
    plan.totalTris = n;

    drawn.result = new THREE.Mesh(geoOf(pos), new THREE.MeshStandardMaterial({
      color: 0x38bdf8, roughness: 0.55, metalness: 0, transparent: true, opacity: 0.45,
      side: THREE.DoubleSide, depthWrite: false }));
    drawn.result.renderOrder = 41;
    group.add(drawn.result);

    if (keep.length) {
      var cp = new Float32Array(keep.length * 9);
      for (var i = 0; i < keep.length; i++) cp.set(pos.subarray(keep[i] * 9, keep[i] * 9 + 9), i * 9);
      var cg = geoOf(cp);
      drawn.changed = new THREE.Mesh(cg, new THREE.MeshStandardMaterial({
        color: 0x4ade80, emissive: 0x14532d, emissiveIntensity: 0.5, roughness: 0.6, metalness: 0,
        transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
      drawn.changed.renderOrder = 42;
      group.add(drawn.changed);
      drawn.edges = new THREE.LineSegments(new THREE.EdgesGeometry(cg, 25),
        new THREE.LineBasicMaterial({ color: 0xbbf7d0, transparent: true, opacity: 0.9, depthTest: false }));
      drawn.edges.renderOrder = 43;
      group.add(drawn.edges);
    }
  }

  /* ---------------------------------------------------------------
     Pick edges: the box's twelve edges drawn on the ghost, a click names one
     --------------------------------------------------------------- */

  function baseSoup() {
    return (m && m.softenRun && m.rawTris === m.softenRun.result) ? m.softenRun.base : (m ? m.rawTris : null);
  }
  function boxNow() {
    return (typeof rawSolidBox === 'function' && baseSoup()) ? rawSolidBox(baseSoup()) : null;
  }
  function localOf(p) {
    var f = (typeof nsoRawFrameOf === 'function') ? nsoRawFrameOf(m) : null;
    var q = f ? nsoLocalPointFromRaw(f, p) : p;
    return new THREE.Vector3(q[0], q[1], q[2]);
  }
  function edgeSegs() {
    var b = boxNow();
    if (!b || !window.NSO_BoxEdges) return null;
    return NSO_BoxEdges.segments(b.lo, b.hi).map(function (e) {
      return { id: e.id, a: localOf(e.p), b: localOf(e.q) };
    });
  }
  function clearEdges() {
    if (!edgeDrawn) return;
    edgeDrawn.forEach(disposeObj);
    edgeDrawn = null;
  }
  function drawEdges() {
    clearEdges();
    if (!edgeOn || !group) return;
    var segs = edgeSegs();
    if (!segs) return;
    edgeDrawn = [];
    var pos = [], span = 0;
    segs.forEach(function (e) {
      pos.push(e.a.x, e.a.y, e.a.z, e.b.x, e.b.y, e.b.z);
      span = Math.max(span, e.a.distanceTo(e.b));
    });
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    var all = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: 0xe0f2fe, transparent: true, opacity: 0.55, depthTest: false }));
    all.renderOrder = 44;
    group.add(all); edgeDrawn.push(all);
    // a picked edge is a bar, so it reads from across the plate; a line would be one pixel
    var rad = Math.max(0.25, span / 160);
    segs.forEach(function (e) {
      if (edgePicks.indexOf(e.id) < 0) return;
      var len = e.a.distanceTo(e.b);
      var bar = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len, 10),
        new THREE.MeshBasicMaterial({ color: 0xfb923c, transparent: true, opacity: 0.95, depthTest: false }));
      bar.position.copy(e.a).add(e.b).multiplyScalar(0.5);
      bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), e.b.clone().sub(e.a).normalize());
      bar.renderOrder = 45;
      group.add(bar); edgeDrawn.push(bar);
    });
  }
  function syncEdgeUi() {
    var clr = $('btn-soften-edges-clear');
    if (clr) clr.hidden = !(on && edgeOn && edgePicks.length);
    var chk = $('chk-soften-edges');
    if (chk && chk.checked !== edgeOn) chk.checked = edgeOn;
  }

  function setEdgeMode(v) {
    v = !!v;
    if (v === edgeOn) return edgeOn;
    edgeOn = v;
    if (on) {
      if (edgeOn && !boxNow()) { say('Pick edges needs a plain box - this piece is not one', true); }
      drawEdges();
      if (style) dirty = true;
      readout();
    }
    syncEdgeUi();
    return edgeOn;
  }

  /* Name an edge (or take it back off). `id` is NSO_boxEdgeFaces's number. */
  function toggleEdge(id) {
    if (!on || !(id >= 0 && id < 12)) return false;
    var at = edgePicks.indexOf(id);
    if (at >= 0) edgePicks.splice(at, 1); else edgePicks.push(id);
    drawEdges(); syncEdgeUi();
    if (style) recompute(); else readout();
    return true;
  }

  function clearEdgePicks() {
    if (!edgePicks.length) return false;
    edgePicks = [];
    drawEdges(); syncEdgeUi();
    if (style) recompute(); else readout();
    return true;
  }

  /* The edge nearest the click on the screen, within EDGE_PX; where two are as near,
     the one nearer the camera. */
  function edgeAtEvent(event) {
    var segs = edgeSegs();
    if (!segs || !state.camera || !state.renderer) return null;
    var r = state.renderer.domElement.getBoundingClientRect();
    mesh.updateMatrixWorld(true);
    var px = event.clientX - r.left, py = event.clientY - r.top, best = null;
    var toScreen = function (v) {
      var w = v.clone().applyMatrix4(mesh.matrixWorld), d = w.distanceTo(state.camera.position);
      w.project(state.camera);
      return { x: (w.x + 1) / 2 * r.width, y: (1 - w.y) / 2 * r.height, d: d, ok: w.z > -1 && w.z < 1 };
    };
    segs.forEach(function (e) {
      var A = toScreen(e.a), B = toScreen(e.b);
      if (!A.ok && !B.ok) return;
      var dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy;
      var t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - A.x) * dx + (py - A.y) * dy) / l2)) : 0;
      var cx = A.x + t * dx, cy = A.y + t * dy, dist = Math.hypot(px - cx, py - cy);
      if (dist > EDGE_PX) return;
      var depth = A.d + t * (B.d - A.d);
      if (!best || dist < best.dist - 3 || (Math.abs(dist - best.dist) <= 3 && depth < best.depth)) best = { id: e.id, dist: dist, depth: depth };
    });
    return best ? best.id : null;
  }
  function pickEdgeFromEvent(event) {
    if (!boxNow()) { say('Pick edges needs a plain box - this piece is not one', true); return false; }
    var id = edgeAtEvent(event);
    if (id == null) { say('Soften: click right on an edge of the box - the white lines are the ones you can pick'); return false; }
    return toggleEdge(id);
  }

  /* ---------------------------------------------------------------
     The preview: softenCompute, with a commit that keeps what it is handed
     --------------------------------------------------------------- */

  function deliver(my) {
    return function (model, run, soup, firstOfRun, jobs, text) {
      if (!on || my !== seq) return;                 // a newer change has replaced this one
      if (rerun) { rerun = false; waiting = false; dirty = true; return; }
      plan = { soup: soup, run: run, firstOfRun: firstOfRun, jobs: jobs, text: text, R: rNow(), style: style };
      waiting = false; refused = null; needPick = false; needEdges = false;
      drawPlan();
      readout();
    };
  }

  function recompute() {
    dirty = false;
    if (!on) return;
    if (state.nsoWrapBusy) { rerun = true; waiting = true; readout(); return; }   // a pocket wrap is in flight
    var my = ++seq;
    plan = null; refused = null; needPick = false; needEdges = false; waiting = false; rerun = false; kind = null;
    clearDrawn();
    if (!style) { readout(); return; }
    state.edgeTreat = style;                    // the pocket wraps read the mode through getEdgeTreat()
    var res;
    try {
      res = softenCompute(m, { R: rNow(), mode: style, fullWrap: fullWrapNow(),
                               edgePick: edgeOn, edges: edgePicks.slice(),
                               newJobs: picks.map(function (p) { return { axisIdx: p.axisIdx, keepMin: p.keepMin, plane: p.plane, recessed: p.recessed }; }) },
                          deliver(my));
    } catch (e) {
      res = { ok: false, reason: 'Soften failed - ' + ((e && e.message) || e) };
      say(res.reason, true);
    }
    kind = res.kind || null;
    needPick = !!res.needPick;
    needEdges = !!res.needEdges;
    needsFaces = needPick || res.kind === 'faces';
    if (!plan) {
      if (res.ok && res.pending) {
        if (state.nsoWrapBusy) waiting = true; else refused = hudText();     // refused with its reason on the HUD
      } else if (!res.ok && !res.needPick && !res.needEdges) {
        refused = res.reason || hudText();
      }
    }
    if (plan) say('Soften preview: ' + plan.text + '. Press Soften to bake it.');
    else if (needEdges) say('Soften (' + NAMES[style] + '): click an edge of the box to ' + (style === 'chamfer' ? 'bevel' : 'round') + ' it - it previews here.');
    else if (needPick) say('Soften (' + NAMES[style] + '): click the face to soften - it previews here.');
    readout();
  }

  function readout() {
    var el = $('soften-readout'), btn = $('btn-soften'), text, bad = false;
    markTiles();
    if (btn) {
      btn.classList.toggle('is-on', !!on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    if (!on) { if (el) el.textContent = ''; return; }
    if (!style) text = 'Pick a style above: the piece previews it here, and Soften bakes it.';
    else if (waiting) text = NAMES[style] + ' R ' + fmt(rNow()) + ' - working it out…';
    else if (plan) text = plan.text + ' — press Soften to bake it.';     // the engine's sentence already names the style and R
    else if (needEdges) text = NAMES[style] + ' R ' + fmt(rNow()) + ': click the edges to ' + (style === 'chamfer' ? 'bevel' : 'round') +
                               ' on the box (white lines) — each click picks or un-picks one, and it previews here.';
    else if (needPick) text = NAMES[style] + ' R ' + fmt(rNow()) + ': click the face to soften' +
                              (picks.length ? ' (' + picks.length + ' picked)' : '') + ' — it previews here.';
    else { text = NAMES[style] + ' R ' + fmt(rNow()) + ' refused — ' + (refused || 'nothing to preview'); bad = true; }
    if (el) { el.textContent = text; el.classList.toggle('is-refused', bad); }
  }

  /* ---------------------------------------------------------------
     Arm / put away
     --------------------------------------------------------------- */

  function showPanel(v) {
    var p = $('soften-panel');
    if (p) p.hidden = !v;
  }

  function arm() {
    if (!engineReady()) { say('Soften needs app-finish.js', true); return { ok: false, reason: 'no engine' }; }
    var model = getActiveModel();
    if (!model) { say('Select a piece first', true); return { ok: false, reason: 'no piece' }; }
    if (!model.rawTris || model.rawAxis !== 'zup') {
      say('Soften needs a Square-split or loaded raw piece', true);
      return { ok: false, reason: 'no raw soup' };
    }
    var ms = meshOf(model);
    if (!ms) { say('Soften: put the piece on the plate first. Nothing changed.', true); return { ok: false, reason: 'not placed' }; }
    on = true; style = null;
    m = model; soupRef = model.rawTris; mesh = ms;
    picks = []; plan = null; refused = null; needPick = false; waiting = false; needsFaces = false; kind = null;
    baseIdx = null; rerun = false; dirty = false;
    edgePicks = []; needEdges = false;
    state.softenArmed = true;                    // the repo's "Soften is the tool in hand" flag
    if (typeof clearFacePick === 'function') clearFacePick();
    openView();
    drawEdges(); syncEdgeUi();
    drawTiles();
    showPanel(true);
    readout();
    say('Soften: pick a style - Round, Corners, Corners+edges or Bevel. The piece previews it; Soften bakes it.');
    tick();
    return { ok: true };
  }

  function teardown(baked) {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    seq++;                                       // anything still in the kernel is nobody's now
    closeView();
    showPanel(false);
    on = false; style = null;
    state.softenArmed = false;
    if (!baked && typeof clearFacePick === 'function') clearFacePick();     // a bake leaves its own cage
    edgePicks = []; needEdges = false; syncEdgeUi();
    m = null; soupRef = null; mesh = null; plan = null; picks = []; baseIdx = null; press = null;
    refused = null; needPick = false; waiting = false; needsFaces = false; kind = null; rerun = false;
    if (liveHandle) liveHandle.cancel();
    readout();
  }

  function cancel(quiet) {
    if (!on) return false;
    teardown(false);
    if (!quiet) say('Soften cancelled - nothing changed');
    return true;
  }

  /* The piece moved on under the card (another selection, an Undo, a cut, a
     bake) or another tool took the hand: the ghost no longer describes it. */
  function stale() {
    if (!on) return false;
    if (!state.softenArmed) { cancel(true); return true; }       // another tool took over; it has its own words
    var cur = getActiveModel();
    var same = cur === m && m.rawTris === soupRef && meshOf(m) === mesh;
    if (!same) {
      cancel(true);
      say('Soften put away - the piece or the selection changed under it. Nothing was baked.');
      return true;
    }
    return false;
  }

  function tick() {
    raf = 0;
    if (!on) return;
    if (stale()) return;
    if (waiting && !state.nsoWrapBusy && !plan) {            // the kernel finished without a result: it refused
      waiting = false;
      if (rerun) { rerun = false; dirty = true; } else { refused = hudText(); readout(); }
    }
    if (dirty && !state.nsoWrapBusy) recompute();
    raf = requestAnimationFrame(tick);
  }

  /* ---------------------------------------------------------------
     Style, radius, faces
     --------------------------------------------------------------- */

  function pickStyle(s) {
    if (!NAMES[s]) return { ok: false, reason: 'no such style' };
    if (!on) { var a = arm(); if (!a.ok) return a; }
    style = s;
    recompute();
    return { ok: !!plan || needPick, style: s, planned: !!plan, needPick: needPick };
  }

  /* Name a face (or take it back off) for the pieces that are softened a face
     at a time. `pick` is storeFacePick's answer. */
  function toggleFace(pk) {
    if (typeof nsoMaskIsExcludedPick === 'function' &&
        nsoMaskIsExcludedPick(m, pk.rawAxisIdx, pk.rawKeepMin, pk.rawPlane, pk.recessed)) {
      say('That face is painted out - include it first, or pick another face', true);
      return false;
    }
    var at = -1;
    for (var i = 0; i < picks.length; i++) if (picks[i].axisIdx === pk.rawAxisIdx && picks[i].keepMin === pk.rawKeepMin) at = i;
    if (at >= 0) picks.splice(at, 1);
    else picks.push({ axisIdx: pk.rawAxisIdx, keepMin: pk.rawKeepMin, plane: pk.rawPlane, recessed: !!pk.recessed });
    if (!picks.length && typeof clearFacePick === 'function') clearFacePick();
    recompute();
    return true;
  }

  function pickFromEvent(event) {
    if (!on || !mesh || !state.camera || !state.renderer) return false;
    if (edgeOn) return pickEdgeFromEvent(event);
    if (!style) { say('Soften: pick a style first - the tiles above', true); return false; }
    if (!needsFaces) return false;               // a box or pocket wrap needs no face named
    var r = state.renderer.domElement.getBoundingClientRect();
    var ndc = new THREE.Vector2(((event.clientX - r.left) / r.width) * 2 - 1, -((event.clientY - r.top) / r.height) * 2 + 1);
    var rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, state.camera);
    mesh.updateMatrixWorld(true);
    var hits = rc.intersectObject(mesh, false).filter(function (h) { return h.faceIndex != null; });
    if (!hits.length) return false;
    var pk = (typeof storeFacePick === 'function') ? storeFacePick(hits[0]) : null;   // says why itself when it cannot
    if (!pk || pk.wrapAll) return false;
    return toggleFace(pk);
  }

  /* ---------------------------------------------------------------
     Bake
     --------------------------------------------------------------- */

  function bake() {
    if (!on) return { ok: false, reason: 'Soften is not open' };
    if (stale()) return { ok: false, reason: 'the piece changed - Soften put away' };
    if (liveHandle && liveHandle.pending()) { liveHandle.cancel(); recompute(); }   // a slider move still waiting its turn
    else if (dirty) recompute();
    if (!style) { say('Soften: pick a style first - Round, Corners, Corners+edges or Bevel', true); return { ok: false, reason: 'no style' }; }
    if (waiting) { say('Soften: still working out the preview - press Soften again in a moment', true); return { ok: false, reason: 'working' }; }
    if (!plan) {
      var why = needPick ? 'click the face to soften first' : ('nothing to bake - ' + (refused || 'no preview'));
      say('Soften: ' + why, true);
      return { ok: false, reason: why };
    }
    var p = plan, model = m;
    closeView();                                 // the bake swaps the piece's mesh under the ghost
    commitSoften(model, p.run, p.soup, p.firstOfRun, p.jobs, p.text);
    teardown(true);
    return { ok: true, soup: p.soup, text: p.text, style: p.style, R: p.R };
  }

  function pressSoften() { return on ? bake() : arm(); }

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
    pickFromEvent(event);
  }

  function bind() {
    tiles().forEach(function (btn) {
      if (btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () { pickStyle(btn.getAttribute('data-style')); });
    });
    var cancelBtn = $('btn-soften-cancel');
    if (cancelBtn && cancelBtn.dataset.nsoWired !== '1') {
      cancelBtn.dataset.nsoWired = '1';
      cancelBtn.addEventListener('click', function () { cancel(); });
    }
    var edgeChk = $('chk-soften-edges');
    if (edgeChk && edgeChk.dataset.nsoWired !== '1') {
      edgeChk.dataset.nsoWired = '1';
      edgeChk.addEventListener('change', function () { setEdgeMode(edgeChk.checked); });
    }
    var edgeClr = $('btn-soften-edges-clear');
    if (edgeClr && edgeClr.dataset.nsoWired !== '1') {
      edgeClr.dataset.nsoWired = '1';
      edgeClr.addEventListener('click', function () { clearEdgePicks(); });
    }
    var wrap = $('chk-full-wrap');
    if (wrap && wrap.dataset.nsoWired !== '1') {
      wrap.dataset.nsoWired = '1';
      wrap.addEventListener('change', function () { if (on) { picks = []; dirty = true; } });
    }
    if (!liveHandle && window.nsoLiveSlider) {
      liveHandle = window.nsoLiveSlider.bind({
        slider: 'inp-soften-slider', box: 'inp-soften-r', read: 'soften-slider-read', unit: ' mm',
        onLive: function () { if (on && style) recompute(); }
      });
    }
    if (typeof state === 'undefined' || !state.renderer || !state.renderer.domElement || state._softenLiveBound) return;
    state._softenLiveBound = true;
    state.renderer.domElement.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', function () { press = null; });
    window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && on) cancel(); });
  }

  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('soften', {
    live: function () { return on; },
    close: function () { cancel(); }
  });

  /* For the drive checks, leaveTool and app-core: the same paths the controls run. */
  window.nsoSoftenLive = {
    press: pressSoften, arm: arm, cancel: cancel, bake: bake, pickStyle: pickStyle,
    on: function () { return on; },
    drawTiles: drawTiles,
    info: function () {
      return on ? {
        style: style, R: rNow(), kind: kind, ok: !!plan, needPick: needPick, waiting: waiting, picks: picks.length,
        edgeMode: edgeOn, edges: edgePicks.slice(), needEdges: needEdges,
        reason: refused, text: plan ? plan.text : null, soup: plan ? plan.soup : null,
        changedTris: plan ? plan.changedTris : null, totalTris: plan ? plan.totalTris : null,
        readout: ($('soften-readout') || {}).textContent, modelId: m.id
      } : null;
    },
    setEdgeMode: setEdgeMode,
    pickEdge: function (id) { return on ? toggleEdge(id) : false; },     // for a check that names an edge rather than aiming a click
    clearEdges: clearEdgePicks,
    edgeAt: function (event) { return on && edgeOn ? edgeAtEvent(event) : null; },
    edgeSegments: function () { return on ? edgeSegs() : null; },
    pickFace: function (pk) { return on && style ? toggleFace(pk) : false; },   // for a check that names a face rather than aiming a click
    objects: function () { return { group: group, result: drawn.result, changed: drawn.changed, edges: drawn.edges, mesh: mesh }; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
