/* ===================== Supports Blockers: boxes no support is made in =====================
   docs/SUPPORT-BLOCKERS.md. The pure half is nso_support_blockers.js; the Supports card (app-supports-card.js) reads the
   boxes this file keeps on state.supportBlockers and leaves the spots, the surface and the room they hold without supports.

   A BLOCKER is a ghost box on the plate: { id, c: [x, y, z], h: [hx, hy, hz] } in the plate's frame (mm, Z up; the scene is
   (x, z, -y) of it). It is added from the card's SUPPORTS BLOCKER button - on the selected piece, or the middle of the plate -
   or from the right-click menu's "Add Supports Blocker...", where the click was (on the piece under it, else on the bare plate).
   There can be as many as you like, anywhere; boxes that overlap are one larger area.

   IN THE VIEW, while the Supports card is open:
     a box        a translucent red ghost with its edges drawn through the piece. A press on it picks it (yellow) and drags
                  it across the plate; Shift drags it up and down. A press that finds a piece in front of a box that is not the
                  picked one is the piece's, so the card's clicks on a piece still work; the picked box is grabbed through the
                  piece (a box put round a piece is, mostly, behind its skin). A click on nothing puts the pick away.
     the handles  on the picked box, a rail with a dart at each end, one on each of its six faces. Dragging one moves that face
                  and leaves the opposite one where it is - the box stretches (or shrinks, never below 1 mm).
     Delete       takes the picked box away (the card's Delete button does too); Clear takes them all. One Undo each. A move
                  or a stretch is one Undo however long the drag was.

   A DRAG IS A DRAFT: the card is told when the pointer is let go, not on every pixel, so the planner's detection and the footprint
   it re-traces are not asked 60 times a second. Escape puts the box back where the press found it.

   BEDS. The boxes belong to the active bed (state.supportBlockers is swapped with its pieces by app-beds.js); Clear plate wipes them.

   PAINT SCOPE: none. A blocker is a card setting, not a piece; no piece is written. */
(function () {
  'use strict';

  var DEFAULT_MM = 20;            // a new box is this big each way
  var MIN_HALF_MM = 0.5;          // no box under 1 mm each way
  var HIT_PX = 14;                // a handle is grabbed this close to it on screen
  var DRAW_PX = 34;               // and drawn this big
  var CLICK_PX = 4;               // a press that travels less than this is a click
  var COL = { fill: 0xef4444, edge: 0xff8a8a, sel: 0xfacc15, rail: 0xfbbf24, dart: 0xfde68a, held: 0xffffff };
  var FILL_ALPHA = 0.16, FILL_ALPHA_SEL = 0.26;
  var S = { sel: null, drag: null, group: null, fills: [], handles: [], hooked: false, down: null, draft: null };

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function BL() { return window.NSO_SupportBlockers; }
  function toWorld(p) { return new THREE.Vector3(p[0], p[2], -p[1]); }
  function round1(v) { return Math.round(v * 10) / 10; }

  /* the boxes: the bed's own list; during a drag, the list with the dragged box as the pointer has it */
  function stored() {
    if (!state.supportBlockers) state.supportBlockers = [];
    return state.supportBlockers;
  }
  function boxes() {
    var d = S.draft;
    return d ? stored().map(function (b) { return b.id === d.id ? d : b; }) : stored();
  }
  function boxById(id) { return stored().find(function (b) { return b.id === id; }) || null; }
  function copyAll(list) { return list.map(function (b) { return BL().copy(b); }); }
  function nextId() { return stored().reduce(function (m, b) { return Math.max(m, b.id); }, 0) + 1; }

  function cardOpen() { var m = $('menu-supports'); return !!(m && m.open); }
  function card() { return window.NSO_SUPPORTS_CARD || null; }
  function cardBusy() { var c = card(); return !!(c && c.busy && c.busy()); }
  /* the card's own tools that hold the pointer (the brush, the circles, the eraser): a press is theirs */
  function cardClaims() { var c = card(); return !!(c && c.pointerTool && c.pointerTool()); }
  function active() { return !!(state.scene && state.renderer && state.camera && cardOpen()); }

  /* ------------------------------------------------------------ the undo */

  /* before: the boxes as they were; picked: the box that was picked then (Undo of a Delete picks the box it brings back) */
  function pushStep(before, label, picked) {
    var snap = copyAll(before);
    pushUndo({ type: 'supportSwap', removed: [], addedIds: [], label: label, onUndone: function () {
      state.supportBlockers = copyAll(snap);
      S.sel = picked != null && boxById(picked) ? picked : (S.sel != null && boxById(S.sel) ? S.sel : null);
      S.draft = null;
      changed();
    } });
    if (typeof updateUndoBtn === 'function') updateUndoBtn();
  }

  /* what the boxes now are changed: redraw, say, and let the card see (it reads them by its signature at its next frame) */
  function changed() { draw(); sync(); }

  /* -------------------------------------------------------------- adding */

  function plateCentre() { return [0, 0]; }
  function hostBox() {
    var c = card(), id = c && c.host ? c.host() : null;
    var p = id != null ? (state.placed || []).find(function (q) { return q && q.sourceId === id && q.mesh; }) : null;
    if (!p) return null;
    p.mesh.updateMatrixWorld(true);
    var b = new THREE.Box3().setFromObject(p.mesh);
    if (b.isEmpty()) return null;
    return { lo: [b.min.x, -b.max.z, b.min.y], hi: [b.max.x, -b.min.z, b.max.y] };
  }

  /**
   * Put a blocker on the plate and pick it. spec: { at: [x, y, z] (its centre), size: mm or [w, d, h], onPlate: stand it on the plate }.
   * With no `at`: the middle of the selected piece, a third of its size, else the middle of the plate. One Undo.
   */
  function add(spec) {
    spec = spec || {};
    if (!BL()) return { ok: false, reason: 'the blockers did not load' };
    if (cardBusy()) { say('Supports Blocker: wait for the build to end', true); return { ok: false, reason: 'busy' }; }
    var size = spec.size, c = spec.at ? spec.at.slice() : null, onPlate = !!spec.onPlate;
    if (size == null) {
      var hb = !c ? hostBox() : null;
      size = hb ? Math.max(10, Math.min(40, Math.round(Math.max(hb.hi[0] - hb.lo[0], hb.hi[1] - hb.lo[1], hb.hi[2] - hb.lo[2]) / 3))) : DEFAULT_MM;
      if (hb) c = [(hb.lo[0] + hb.hi[0]) / 2, (hb.lo[1] + hb.hi[1]) / 2, (hb.lo[2] + hb.hi[2]) / 2];
    }
    var w = typeof size === 'number' ? [size, size, size] : size.slice();
    var h = w.map(function (v) { return Math.max(MIN_HALF_MM, v / 2); });
    if (!c) { var pc = plateCentre(); c = [pc[0], pc[1], h[2]]; onPlate = true; }
    if (onPlate || c[2] - h[2] < 0) c[2] = Math.max(c[2], h[2]);                    // not below the plate
    var before = copyAll(stored()), was = S.sel;
    var box = { id: nextId(), c: c.map(round3), h: h.map(round3) };
    stored().push(box);
    S.sel = box.id;
    pushStep(before, 'Undo: Supports Blocker taken away', was);
    changed();
    say('Supports Blocker added: no support is made inside it. Drag it to move it (Shift: up and down), drag a handle on a face to stretch it.');
    return { ok: true, id: box.id, box: BL().copy(box) };
  }
  function round3(v) { return Math.round(v * 1000) / 1000; }

  /* The 3D point under a client position: the piece first (its surface), else the bare plate. */
  function pointUnder(cx, cy) {
    if (!state.renderer || !state.camera || !state.raycaster) return null;
    setPointerFromEvent({ clientX: cx, clientY: cy });
    state.raycaster.setFromCamera(state.pointer, state.camera);
    var hits = state.raycaster.intersectObjects(state.modelGroup.children, true).filter(function (x) { return x.faceIndex != null; });
    if (typeof nsoHelpers !== 'undefined' && nsoHelpers.pieceHits) hits = nsoHelpers.pieceHits(hits);
    if (hits.length) return { p: [hits[0].point.x, -hits[0].point.z, hits[0].point.y], onPiece: true };
    var q = new THREE.Vector3(), ray = state.raycaster.ray;
    if (ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), q)) return { p: [q.x, -q.z, 0], onPiece: false };
    return null;
  }

  /**
   * The right-click menu's "Add Supports Blocker...": the Supports card opens (so the box can be seen and edited) and a box is put
   * where the click was - centred on the point of the piece under it, else standing on the bare plate there.
   */
  function addAtClient(at) {
    var m = $('menu-supports');
    if (m && !m.open) m.open = true;
    var u = at && isFinite(at.x) && isFinite(at.y) ? pointUnder(at.x, at.y) : null;
    return add(u ? { at: u.p, onPlate: !u.onPiece } : {});
  }

  /* ------------------------------------------------------------ removing */

  function remove(id) {
    if (cardBusy()) { say('Supports Blocker: wait for the build to end', true); return { ok: false, reason: 'busy' }; }
    var box = boxById(id);
    if (!box) return { ok: false, reason: 'no such blocker' };
    var before = copyAll(stored()), was = S.sel;
    state.supportBlockers = stored().filter(function (b) { return b.id !== id; });
    if (S.sel === id) S.sel = null;
    pushStep(before, 'Undo: Supports Blocker put back', was);
    changed();
    return { ok: true, id: id };
  }
  function removeSelected() { return S.sel == null ? { ok: false, reason: 'none picked' } : remove(S.sel); }
  function clear() {
    if (cardBusy()) { say('Supports Blocker: wait for the build to end', true); return { ok: false, reason: 'busy' }; }
    if (!stored().length) return { ok: false, reason: 'none' };
    var before = copyAll(stored()), was = S.sel;
    state.supportBlockers = [];
    S.sel = null;
    pushStep(before, 'Undo: Supports Blockers put back', was);
    changed();
    return { ok: true, count: before.length };
  }
  /* Clear plate: the boxes go with the pieces they were put round. No Undo, as Clear plate has none. */
  function forget() {
    state.supportBlockers = [];
    S.sel = null; S.drag = null; S.draft = null;
    changed();
  }

  /* ------------------------------------------------- moving and stretching */

  /**
   * Set a blocker's centre and / or half sizes by number (what a drag does at its end): one Undo. fields: { c, h }.
   */
  function set(id, fields) {
    if (cardBusy()) return { ok: false, reason: 'busy' };
    var box = boxById(id);
    if (!box) return { ok: false, reason: 'no such blocker' };
    var before = copyAll(stored());
    if (fields.c) box.c = fields.c.map(round3);
    if (fields.h) box.h = fields.h.map(function (v) { return round3(Math.max(MIN_HALF_MM, v)); });
    pushStep(before, 'Undo: Supports Blocker back where it was', S.sel);
    changed();
    return { ok: true, box: BL().copy(box) };
  }
  function select(id) {
    S.sel = id == null || !boxById(id) ? null : id;
    changed();
    return S.sel;
  }

  /* ------------------------------------------------------------- drawing */

  function undraw() {
    if (S.group) {
      if (S.group.parent) S.group.parent.remove(S.group);
      S.group.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    S.group = null; S.fills = []; S.handles = [];
  }

  function handlesOf(b) {
    var out = [];
    var ax = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    ['x', 'y', 'z'].forEach(function (nm, k) {
      [1, -1].forEach(function (sg) {
        var pos = b.c.slice(); pos[k] += sg * b.h[k];
        var dir = ax[k].map(function (v) { return v * sg; });
        out.push({ id: nm + (sg > 0 ? '+' : '-'), k: k, sg: sg, pos: toWorld(pos), dir: toWorld(dir).normalize() });
      });
    });
    return out;
  }

  function buildHandle(h, held) {
    var g = new THREE.Group();
    var mat = function (c, o) { return new THREE.MeshBasicMaterial({ color: c, depthTest: false, depthWrite: false, transparent: true, opacity: o }); };
    var rail = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.6, 6), mat(held ? COL.held : COL.rail, held ? 1 : 0.85));
    rail.renderOrder = 999;
    g.add(rail);
    [1, -1].forEach(function (sg) {
      var dart = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.9, 14), mat(held ? COL.held : COL.dart, 1));
      dart.position.y = sg * 0.85;
      if (sg < 0) dart.rotation.x = Math.PI;
      dart.renderOrder = 1000;
      g.add(dart);
    });
    var bead = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), mat(held ? COL.held : COL.rail, 1));
    bead.renderOrder = 1001;
    g.add(bead);
    g.position.copy(h.pos);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), h.dir);
    g.userData.blockerHandle = h.id;
    return g;
  }

  /* each handle keeps one size on screen, wherever the camera is */
  function rescale() {
    if (!S.group || !state.camera || !state.renderer) return;
    var cam = state.camera, rect = state.renderer.domElement.getBoundingClientRect();
    if (!rect.height) return;
    var perPx = 2 * Math.tan((cam.fov || 50) * Math.PI / 360) / rect.height;
    S.group.children.forEach(function (c) {
      if (!c.userData.blockerHandle) return;
      c.scale.setScalar(Math.max(1e-4, cam.position.distanceTo(c.position) * perPx * DRAW_PX / 2));
    });
  }

  function draw() {
    undraw();
    if (!active()) return;
    var list = boxes();
    if (!list.length) return;
    var g = new THREE.Group();
    g.name = 'supportBlockers';
    list.forEach(function (b) {
      var sel = b.id === S.sel;
      var geo = new THREE.BoxGeometry(2 * b.h[0], 2 * b.h[2], 2 * b.h[1]);
      var fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: sel ? COL.sel : COL.fill, transparent: true, opacity: sel ? FILL_ALPHA_SEL : FILL_ALPHA,
        depthWrite: false, side: THREE.DoubleSide }));
      fill.position.copy(toWorld(b.c));
      fill.renderOrder = 20;
      fill.userData.blockerId = b.id;
      fill.userData.skipXray = true;
      g.add(fill);
      S.fills.push(fill);
      var edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: sel ? COL.sel : COL.edge, transparent: true,
        opacity: sel ? 1 : 0.85, depthTest: false }));
      edges.position.copy(fill.position);
      edges.renderOrder = 21;
      edges.userData.skipXray = true;
      edges.raycast = function () {};                      // the fill is what a press hits
      g.add(edges);
    });
    var picked = list.find(function (b) { return b.id === S.sel; });
    S.handles = picked ? handlesOf(picked) : [];
    S.handles.forEach(function (h) { g.add(buildHandle(h, S.drag && S.drag.kind === 'handle' && S.drag.h.id === h.id)); });
    g.traverse(function (o) { o.frustumCulled = false; });
    if (typeof nsoHelpers !== 'undefined') nsoHelpers.attach(state.scene, g, 'supports-blockers', { interactive: true }); else state.scene.add(g);
    S.group = g;
    rescale();
    if (state.controls && state.controls.addEventListener && !S.hooked) { S.hooked = true; state.controls.addEventListener('change', rescale); }
  }

  /* --------------------------------------------------------- the card's side */

  function dims(b) { return round1(2 * b.h[0]) + ' × ' + round1(2 * b.h[1]) + ' × ' + round1(2 * b.h[2]) + ' mm'; }
  function sync() {
    var list = boxes(), n = list.length, areas = n ? BL().areas(list).length : 0;
    var del = $('sup-blocker-delete'), clr = $('sup-blocker-clear'), add_ = $('sup-blocker-add'), read = $('sup-blocker-read');
    var busy = cardBusy();
    if (add_) add_.disabled = busy;
    if (del) del.disabled = busy || S.sel == null;
    if (clr) clr.disabled = busy || !n;
    if (read) {
      var sel = list.find(function (b) { return b.id === S.sel; });
      read.hidden = !n || !cardOpen();
      read.textContent = n ? (n === 1 ? '1 blocker' : n + ' blockers' + (areas < n ? ' · ' + (areas === 1 ? '1 area' : areas + ' areas') : '')) +
        (sel ? ' · picked ' + dims(sel) + ' at x ' + round1(sel.c[0]) + ', y ' + round1(sel.c[1]) + ', z ' + round1(sel.c[2]) : '') : '';
    }
    var cv = state.renderer && state.renderer.domElement;
    if (cv && S.drag) cv.style.cursor = 'grabbing';
  }

  /* -------------------------------------------------------------- pointer */

  function onCanvas(ev) { return state.renderer && ev.target === state.renderer.domElement; }
  function consume(ev) { ev.stopImmediatePropagation(); ev.preventDefault(); }
  function setRay(ev) {
    setPointerFromEvent(ev);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    return state.raycaster.ray;
  }
  function screenOf(v) {
    var r = state.renderer.domElement.getBoundingClientRect(), p = v.clone().project(state.camera);
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height, behind: p.z > 1 };
  }
  function hitHandle(ev) {
    var best = null, bd = HIT_PX;
    S.handles.forEach(function (h) {
      var s = screenOf(h.pos);
      if (s.behind) return;
      var d = Math.hypot(s.x - ev.clientX, s.y - ev.clientY);
      if (d <= bd) { bd = d; best = h; }
    });
    return best;
  }
  /* the nearest box under the pointer, and how far along the ray */
  function boxHit(ev) {
    if (!S.fills.length) return null;
    setRay(ev);
    S.group.updateMatrixWorld(true);
    var hit = state.raycaster.intersectObjects(S.fills, false)[0];
    if (!hit) return null;
    return { id: hit.object.userData.blockerId, point: hit.point.clone(), dist: hit.distance };
  }
  /* is a piece's surface nearer along the ray than the box is? Then the press is the piece's */
  function pieceBefore(dist) {
    if (!state.modelGroup) return false;
    var hits = state.raycaster.intersectObjects(state.modelGroup.children, true).filter(function (x) { return x.faceIndex != null; });
    if (typeof nsoHelpers !== 'undefined' && nsoHelpers.pieceHits) hits = nsoHelpers.pieceHits(hits);
    return hits.length > 0 && hits[0].distance < dist - 1e-3;
  }
  // the parameter t where the line p0 + t d (d unit) passes closest to the ray
  function rayLineT(ray, p0, d) {
    var w = ray.origin.clone().sub(p0), r = ray.direction;
    var b = r.dot(d), dd = r.dot(w), e = d.dot(w), den = 1 - b * b;
    if (den < 1e-6) return null;
    return (e - b * dd) / den;
  }

  function beginBody(ev, hit) {
    var b = boxById(hit.id);
    if (!b) return;
    var ray = setRay(ev);
    S.drag = { kind: 'body', id: b.id, was: BL().copy(b), q: hit.point.clone(), vertical: !!ev.shiftKey, ray0: ray.clone(), moved: false, x: ev.clientX, y: ev.clientY, before: copyAll(stored()) };
    S.draft = BL().copy(b);
    if (state.controls) state.controls.enabled = false;
  }
  function beginHandle(h, ev) {
    var b = boxById(S.sel);
    if (!b) return;
    var ray = setRay(ev);
    S.drag = { kind: 'handle', id: b.id, h: h, was: BL().copy(b), t0: rayLineT(ray, h.pos, h.dir), moved: false, x: ev.clientX, y: ev.clientY, before: copyAll(stored()) };
    S.draft = BL().copy(b);
    if (state.controls) state.controls.enabled = false;
  }

  function applyDrag(ev) {
    var d = S.drag, ray = setRay(ev), was = d.was, b = S.draft;
    if (!d.moved && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < CLICK_PX) return;
    d.moved = true;
    if (d.kind === 'body') {
      if (d.vertical) {
        var up = new THREE.Vector3(0, 1, 0), t = rayLineT(ray, d.q, up), t0 = rayLineT(d.ray0, d.q, up);
        if (t == null || t0 == null) return;
        b.c = [was.c[0], was.c[1], was.c[2] + (t - t0)];
      } else {
        var q = new THREE.Vector3();
        if (!ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -d.q.y), q)) return;
        b.c = [was.c[0] + (q.x - d.q.x), was.c[1] - (q.z - d.q.z), was.c[2]];
      }
      return;
    }
    var h = d.h, t1 = rayLineT(ray, h.pos, h.dir);
    if (t1 == null || d.t0 == null) return;
    var delta = t1 - d.t0, k = h.k, h0 = was.h[k], hn = Math.max(MIN_HALF_MM, h0 + delta / 2);
    b.h = was.h.slice(); b.h[k] = hn;
    b.c = was.c.slice(); b.c[k] = was.c[k] + (hn - h0) * h.sg;
  }

  function endDrag(ok) {
    var d = S.drag;
    if (!d) return;
    S.drag = null;
    if (state.controls) state.controls.enabled = true;
    var draft = S.draft; S.draft = null;
    if (ok && d.moved && draft && boxById(d.id)) {
      var box = boxById(d.id);
      box.c = draft.c.map(round3); box.h = draft.h.map(round3);
      pushStep(d.before, d.kind === 'handle' ? 'Undo: Supports Blocker back to its size' : 'Undo: Supports Blocker back where it was', S.sel);
    }
    var cv = state.renderer && state.renderer.domElement;
    if (cv && cv.style.cursor === 'grabbing') cv.style.cursor = '';
    changed();
  }

  function onDown(ev) {
    S.down = null;
    if (ev.button !== 0 || !active() || !onCanvas(ev) || cardBusy() || cardClaims() || S.drag) return;
    var h = S.sel != null ? hitHandle(ev) : null;
    if (h) { beginHandle(h, ev); consume(ev); draw(); sync(); return; }
    var hit = boxHit(ev);
    if (hit && (hit.id === S.sel || !pieceBefore(hit.dist))) {      // the picked box is grabbed through the piece it is round
      if (S.sel !== hit.id) S.sel = hit.id;
      beginBody(ev, hit);
      consume(ev);
      draw(); sync();
      return;
    }
    S.down = { x: ev.clientX, y: ev.clientY };            // not ours: a click that goes nowhere puts the pick away (on release)
  }
  function onMove(ev) {
    if (!S.drag) return;
    applyDrag(ev);
    draw();
    sync();
  }
  function onUp(ev) {
    if (S.drag) { endDrag(true); return; }
    var d = S.down; S.down = null;
    if (d && ev && S.sel != null && Math.hypot(ev.clientX - d.x, ev.clientY - d.y) < CLICK_PX && active() && onCanvas(ev)) { S.sel = null; changed(); }
  }
  function onKey(ev) {
    if (!active()) return;
    var tag = ev.target && ev.target.tagName;
    if (ev.key === 'Escape' && S.drag) {                  // put the box back where the press found it
      S.draft = null; endDrag(false); ev.stopImmediatePropagation(); ev.preventDefault();
      return;
    }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && S.sel != null && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !cardBusy()) {
      removeSelected();
      ev.stopImmediatePropagation(); ev.preventDefault();          // the piece's own Delete is not this key's now
    }
  }

  /* --------------------------------------------------------------- wiring */

  function wire() {
    var menu = $('menu-supports');
    if (!menu || menu.dataset.nsoBlockersWired === '1') return;
    menu.dataset.nsoBlockersWired = '1';
    var on = function (id, fn) { var e = $(id); if (e) e.addEventListener('click', fn); };
    on('sup-blocker-add', function () { add({}); });
    on('sup-blocker-delete', function () { removeSelected(); });
    on('sup-blocker-clear', function () { clear(); });
    menu.addEventListener('toggle', function () { if (S.drag) endDrag(false); S.draft = null; changed(); });
    changed();
  }
  /* the press is heard before the card hears it: this file loads first and listens at once */
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', function () { if (S.drag) { S.draft = null; endDrag(false); } S.down = null; }, true);
  window.addEventListener('keydown', onKey, true);
  if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('supports-blockers', {
    live: function () { return !!S.group; },
    close: function () { undraw(); },
    clear: function () { undraw(); },
    refresh: function () { changed(); }
  });
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }

  window.NSO_SUPPORT_BLOCKERS = {
    MIN_MM: 2 * MIN_HALF_MM, DEFAULT_MM: DEFAULT_MM,
    add: add, addAtClient: addAtClient, remove: remove, removeSelected: removeSelected, clear: clear, forget: forget, set: set, select: select,
    list: function () { return copyAll(stored()); },
    selected: function () { return S.sel; },
    /** The areas the boxes make together (overlapping boxes are one). */
    areas: function () { return BL() ? BL().areas(stored()).map(function (g) { return g.map(function (b) { return b.id; }); }) : []; },
    /** Whether the boxes are drawn now, and how many handles the picked one shows. */
    view: function () { return { drawn: !!S.group, boxes: S.fills.length, handles: S.handles.length, picked: S.sel, dragging: !!S.drag }; },
    /** Where on the page (client pixels) a box's centre or a face's handle is, for a real press. */
    screenOf: function (id, face) {
      var b = boxById(id);
      if (!b || !state.renderer || !state.camera) return null;
      var v;
      if (face) { var hs = handlesOf(b).find(function (h) { return h.id === face; }); v = hs && hs.pos; } else v = toWorld(b.c);
      if (!v) return null;
      state.camera.updateMatrixWorld();
      return screenOf(v);
    },
    draw: draw, sync: sync
  };
})();
