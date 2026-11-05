// ===================== Connect: the card =====================
// The geometry is nso_connect.js (headless, tools/nso_connect_test.js); this
// file is the card on it, in its own drop-down in the column between Crop and
// Join. docs/CONNECT.md.
//
// NO GATE: the column button IS the switch. Opening the Connect drop-down opens
// the card and arms the anchor picks; shutting it - the column button again,
// Escape with nothing picked, another column button, a double-click on the plate
// - is what Cancel did with no picks: the picks, the ghost and the hover go.
// (wireCard, at the foot of this file; the Cut and Crop cards work the same way.)
//
// Bridge (app-bridge.js) is the quick gap-fill: the two picks decide the shape.
// Connect is the builder: the two anchors are only WHERE, the card decides WHAT
// runs between them - String, Ribbon, Tube or Tapered; along what PATH (Sag, mm,
// signed: 0 straight, + bows it up, - hangs it down); with what ENDS (Weld, Flat,
// Foot pad, Ball); and whether it is welded into the pieces or kept as a piece of
// its own.
//
// AN ANCHOR IS THE POINT UNDER THE CURSOR. Exactly there, on the surface: no
// snapping to a face's centre or an edge's midpoint, no classifying it as
// corner / edge / face. It leaves along the surface normal there - at an edge or
// a corner, the average of the normals of the faces that meet (NSO_Connect.anchor).
// The card says where: "Anchor A: on box_closed at 2.1 mm from its corner".
// SHIFT held while clicking keeps the old face centre / edge midpoint, for the
// rare time that is wanted.
//
// TWO CLICKS, NOT A DRAG. Open Connect, then:
//   - HOVER: whatever is under the pointer that Connect could take lights up -
//     a face, an edge (a bar along its whole straight edge) or a point (a dot) -
//     and the card names it. This is Bridge's own pick and overlay
//     (NSO_Bridge.pick; NSO_bridgeTargetAt / NSO_bridgeTargetObject).
//   - CLICK a piece: that is anchor A, and it stays marked. Nothing is held
//     down and nothing captures the pointer: orbit, pan and zoom as much as you
//     like - a line from A follows the pointer the whole time - then
//   - CLICK another place: anchor B. The connector is built at once and drawn as
//     a GHOST (amber, Bridge's), from the very soup Set would commit (a Foot pad's
//     or a Ball's disc and sphere ride in it, not yet unioned). A refusal
//     draws nothing and says why, in red. Changing the shape or any field
//     redraws the ghost at once - Sag and Ends included.
//   - Clicking an anchor again (within a mm of it) clears it. A click on nothing
//     clears the picks (an orbit drag does not: it has to stay put to count as a
//     click) and so does Escape (a second Escape, with none picked, shuts the
//     card). With both set, a click on a new place replaces B.
//   - SET commits it. Weld into A and B: the pieces leave the plate and one new
//     piece takes their place (or the one, when both anchors are on it). Keep
//     separate: the connector is added as a piece of its own and the pieces are
//     not touched. One Undo puts it all back. The card stays open after a Set
//     and is armed for the next pair: the picks clear, the fields keep their
//     values, the last connector stays welded or placed - Set as many in a row as
//     you like. CANCEL or ESCAPE drops the picks; pressed with none, it closes the
//     card.
//
// DRAW (the Draw switch beside Sag): the path is a freehand stroke instead of two anchors.
//   - PRESS anywhere on the plate or on a piece and DRAG: the stroke follows the
//     cursor across the plate and up onto the pieces it crosses (every move is a
//     ray - the plate where it meets none - with a step in the screen of at most a
//     few px, so a fast drag does not skip over a wall). It is drawn live, with the
//     connector it would make as the ghost (amber, Bridge's).
//   - RELEASE builds it: NSO_Connect.drawPlan smooths the stroke (Chaikin x2,
//     resampled at 1 mm, corners over 60 degrees kept) and sweeps the shape
//     along it. Result, Ends and Sag are the card's own; Sag is a lift of the
//     middle. Weld joins whatever the stroke touches - the pieces its ends stand
//     on and the ones it crosses on the way; a stroke that touches none is its own
//     piece. One Undo. The card stays armed for the next stroke.
//   - ESC mid-drag cancels the stroke and builds nothing.
//   Left-drag draws while Draw is on; a press that finds nothing under it, and the
//   right and middle buttons, still orbit and pan.
//
// A press that starts ON a piece belongs to Connect while the card is open (it
// would otherwise select the piece and start a move drag under the click); a
// press that starts anywhere else - the plate, the empty view - is never
// touched, so every orbit, pan and zoom works as it always does.
//
// Both pieces are read in the plate's world frame, Z up (meshToWorldSoup, then
// (x, -z, y)), so their poses are in the numbers and the result needs none.
//
// ATTACH shares the card (app-assemble.js): its button sits under Set / Cancel.
// While it is armed the clicks on a piece are its, not anchors - the pointer
// handlers below stand down on state.attachArmed - and Cancel and closing the
// card turn it off.
//
// PAINT SCOPE: WHOLE-PIECE, on every piece a WELD joins; none for Keep separate.
// Per the scoping rule in docs/HANDOFF.md: a weld goes through the boolean
// kernel, which rebuilds every face of the pieces it joins, so no face on
// either can be promised untouched and the new piece is a new model. Any paint
// on a piece to be welded stands it down, naming the count: nsoMaskCount(m) is
// the whole test. Keep separate adds a piece and changes none, so paint cannot
// be touched by it.

var CONNECT_GHOST_COLOR = 0xf59e0b;      // Bridge's ghost, Bend's
var CONNECT_HOVER_COLOR = 0x22d3ee;
var CONNECT_PICK_COLOR = 0xffc83d;
var CONNECT_RENDER_ORDER = 21;
var CONNECT_CLICK_PX = 5;                // a press that moves more than this is an orbit, not a click
var CONNECT_SAME_MM = 1.0;               // a click this close to a point anchor is that anchor
var NSO_CONNECT_HINT = 'Click anchor A on a piece, orbit as you like, then click anchor B.';
var NSO_CONNECT_DRAW_HINT = 'Draw: press on the plate or a piece and drag; release builds it. Esc cancels.';
var CONNECT_REST_Z = 0.2;                // where a piece rests on the plate: a stroke over bare plate rides there
var CONNECT_STROKE_PX = 5;               // the screen step between rays along a drag

function NSO_connectUI() {
  if (typeof state === 'undefined') return {};
  if (!state.connect) {
    state.connect = { open: false, hover: null, a: null, b: null, plan: null, overlay: null, ghost: null, line: null,
                      busy: false, raf: 0, press: null, soups: {}, timer: 0, draw: false, stroke: null };
  }
  return state.connect;
}
function NSO_connectEl(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }

/* ----------------------------------------------------------- the pieces */

// World soup, Z up - cached until the piece moves or changes. Bridge's own
// pose key says when.
function NSO_connectSoupFor(p) {
  var C = NSO_connectUI(), key = NSO_bridgePoseKey(p), c = C.soups[p.sourceId];
  if (c && c.key === key) return c.soup;
  var s = meshToWorldSoup(p.mesh), up = new Float32Array(s.length);
  for (var i = 0; i < s.length; i += 3) { up[i] = s[i]; up[i + 1] = -s[i + 2]; up[i + 2] = s[i + 1]; }
  C.soups[p.sourceId] = { key: key, soup: up };
  return up;
}

function NSO_connectReady() {
  return typeof NSO_Bridge !== 'undefined' && typeof NSO_Connect !== 'undefined' && typeof NSO_bridgeTargetAt === 'function' &&
         typeof NSO_bridgeTargetObject === 'function';
}

// The anchor as the engine will use it: where the connector really starts - the
// clicked point, or (Shift) the face's centroid / the edge's midpoint.
function NSO_connectAnchorPoint(sel) {
  var t = sel.target;
  if (t.centre && t.kind === 'face') return t.centroid;
  if (t.centre && t.kind === 'edge') return [(t.a[0] + t.b[0]) / 2, (t.a[1] + t.b[1]) / 2, (t.a[2] + t.b[2]) / 2];
  return t.point;
}

// The pick, made the anchor: exactly the clicked point (Shift: the old centre),
// and the words for where it is.
function NSO_connectResolve(sel, shift) {
  var m = NSO_bridgeModel(sel.sourceId);
  var r = NSO_Connect.anchor(sel.cache.T, sel.target, { centre: !!shift, name: m ? m.name : null, cornerPickMm: NSO_connectPickMm(sel.world) });
  return { sourceId: sel.sourceId, placed: sel.placed, cache: sel.cache, world: sel.world, target: r.target, text: r.text, cornerMm: r.cornerMm };
}

// Bridge's edge-pick distance - BRIDGE_EDGE_PX on screen - in mm at the click's depth: how near a corner is "at" it.
function NSO_connectPickMm(world) {
  var cam = state.camera, H = (state.renderer && state.renderer.domElement.clientHeight) || 600;
  if (!cam || !world) return 0;
  var mm = cam.isPerspectiveCamera ? 2 * cam.position.distanceTo(world) * Math.tan((cam.fov * Math.PI / 180) / 2) / H
                                   : (cam.top - cam.bottom) / (cam.zoom || 1) / H;
  return (typeof BRIDGE_EDGE_PX === 'number' ? BRIDGE_EDGE_PX : 8) * mm;
}

// Is this the very place the other one marks? A click within a mm of an anchor
// is that anchor - on any kind of surface, so two anchors can still stand on one face.
function NSO_connectSame(x, y) {
  if (!x || !y || x.sourceId !== y.sourceId) return false;
  var a = NSO_connectAnchorPoint(x), b = NSO_connectAnchorPoint(y);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < CONNECT_SAME_MM;
}

/* ---------------------------------------------------------------- drawing */

function NSO_connectDrawPicks() {
  var C = NSO_connectUI();
  NSO_bridgeDispose(C.overlay); C.overlay = null;
  if (typeof THREE === 'undefined' || !state.scene) return;
  var g = new THREE.Group();
  g.name = 'connectOverlay';
  if (C.hover && !NSO_connectSame(C.hover, C.a) && !NSO_connectSame(C.hover, C.b)) {
    var h = NSO_bridgeTargetObject(C.hover, CONNECT_HOVER_COLOR); h.userData.role = 'hover'; g.add(h);
  }
  [C.a, C.b].forEach(function (s, i) {
    if (!s) return;
    var o = NSO_bridgeTargetObject(s, CONNECT_PICK_COLOR); o.userData.role = i ? 'b' : 'a';
    // Where the connector actually starts (the clicked point; Shift: a face's centroid, an edge's midpoint).
    var m = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), new THREE.MeshBasicMaterial({
      color: CONNECT_PICK_COLOR, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }));
    m.position.copy(NSO_bridgeUpToDisplay(NSO_connectAnchorPoint(s)));
    o.add(NSO_bridgeOverlay(m, CONNECT_RENDER_ORDER + 1));
    g.add(o);
  });
  nsoHelpers.attach(state.scene, g, 'connect');
  C.overlay = g;
}

function NSO_connectDrawLine(from, to) {
  var C = NSO_connectUI();
  NSO_bridgeDispose(C.line); C.line = null;
  if (!from || !to || typeof THREE === 'undefined' || !state.scene) return;
  var geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  C.line = NSO_bridgeOverlay(new THREE.Line(geo, new THREE.LineBasicMaterial({
    color: CONNECT_PICK_COLOR, transparent: true, depthTest: false, depthWrite: false })), CONNECT_RENDER_ORDER + 2);
  C.line.name = 'connectLine';
  nsoHelpers.attach(state.scene, C.line, 'connect');
}

/* ------------------------------------------------------------- the stroke */

function NSO_connectDrawOn() { var el = NSO_connectEl('chk-connect-draw'); return !!(el && el.checked); }

// What is under the pointer for a stroke: a piece (its point and the soup's face normal, Z up) or the plate (where a piece rests).
function NSO_connectSample(ev) {
  if (!state.raycaster || !state.camera || !state.renderer) return null;
  setPointerFromEvent(ev);
  state.raycaster.setFromCamera(state.pointer, state.camera);
  var placed = (state.placed || []).filter(function (p) { return p && p.mesh && p.mesh.visible !== false; });
  var best = null, hits = state.raycaster.intersectObjects(placed.map(function (p) { return p.mesh; }), false);
  if (hits.length && hits[0].faceIndex != null) {
    var h = hits[0], q = placed.find(function (p) { return p.mesh === h.object; }), c = q && NSO_bridgeIndexFor(q);
    if (c) best = { d: h.distance, p: [h.point.x, -h.point.z, h.point.y], n: [c.T.nrm[h.faceIndex * 3], c.T.nrm[h.faceIndex * 3 + 1], c.T.nrm[h.faceIndex * 3 + 2]], sourceId: q.sourceId };
  }
  if (state.plateMesh && state.raycaster.intersectObject(state.plateMesh, false).length) {
    var w = new THREE.Vector3();
    if (state.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -CONNECT_REST_Z), w)) {
      var d = state.camera.position.distanceTo(w);
      if (!best || d < best.d) best = { d: d, p: [w.x, -w.z, w.y], n: [0, 0, 1], sourceId: null };
    }
  }
  return best;
}

// A stroke point from the pointer, and the ones between it and the last (a ray every few px, so a wall is not stepped over).
function NSO_connectStrokeAdd(ev) {
  var S = NSO_connectUI().stroke;
  if (!S) return;
  var from = S.last, to = { x: ev.clientX, y: ev.clientY }, steps = from ? Math.min(16, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / CONNECT_STROKE_PX)) : 1;
  for (var i = 1; i <= steps; i++) {
    var t = from ? i / steps : 1, smp = NSO_connectSample({ clientX: from ? from.x + (to.x - from.x) * t : to.x, clientY: from ? from.y + (to.y - from.y) * t : to.y });
    if (smp) S.raw.push(smp);
  }
  S.last = to;
  S.dirty = true;
}

// The stroke's pieces, in the order the plan indexes them, and its points in that index.
function NSO_connectStrokePlan(S) {
  var placed = (state.placed || []).filter(function (p) { return p && p.mesh && p.mesh.visible !== false; });
  var ids = placed.map(function (p) { return p.sourceId; });
  var pieces = placed.map(NSO_connectSoupFor);
  var o = NSO_connectOpts();
  o.plateZ = CONNECT_REST_Z;
  var p;
  try {
    p = NSO_Connect.drawPlan(pieces, S.raw.map(function (q) { return { p: q.p, n: q.n, piece: q.sourceId == null ? -1 : ids.indexOf(q.sourceId) }; }), o);
  } catch (err) { p = { ok: false, reason: (err && err.message) || String(err) }; }
  if (p.ok) {
    p.ids = p.welds.map(function (i) { return ids[i]; });
    p.keys = p.welds.map(function (i) { return NSO_bridgePoseKey(placed[i]); });
  }
  return p;
}

function NSO_connectDrawStroke(S) {
  var C = NSO_connectUI();
  NSO_bridgeDispose(C.line); C.line = null;
  if (!S || S.raw.length < 2 || typeof THREE === 'undefined' || !state.scene) return;
  var geo = new THREE.BufferGeometry().setFromPoints(S.raw.map(function (q) { return NSO_bridgeUpToDisplay(q.p); }));
  C.line = NSO_bridgeOverlay(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: CONNECT_PICK_COLOR, transparent: true, depthTest: false, depthWrite: false })), CONNECT_RENDER_ORDER + 2);
  C.line.name = 'connectStroke';
  nsoHelpers.attach(state.scene, C.line, 'connect');
}

// Per frame while a stroke is down: the line, and the ghost of what it would make.
function NSO_connectStrokeFrame() {
  var C = NSO_connectUI(), S = C.stroke;
  if (!S) return;
  S.raf = 0;
  if (!S.dirty) return;
  S.dirty = false;
  NSO_connectDrawStroke(S);
  var p = NSO_connectStrokePlan(S);
  S.plan = p;
  if (p.ok) { NSO_connectSetGhost(p.web); NSO_connectReadout(p.text + ' · release builds it', false); }
  else { NSO_connectSetGhost(null); NSO_connectReadout('Draw: ' + p.reason, false); }
}

function NSO_connectStrokeCancel(why) {
  var C = NSO_connectUI(), S = C.stroke;
  if (S && S.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(S.raf);
  C.stroke = null;
  NSO_connectSetGhost(null); NSO_connectDrawStroke(null);
  if (why) NSO_connectReadout(why, false);
}

function NSO_connectSetGhost(soupUp) {
  var C = NSO_connectUI();
  NSO_bridgeDispose(C.ghost); C.ghost = null;
  if (!soupUp || typeof THREE === 'undefined' || !state.scene) return;
  var arr = new Float32Array(soupUp.length);
  for (var i = 0; i < soupUp.length; i += 3) { arr[i] = soupUp[i]; arr[i + 1] = soupUp[i + 2]; arr[i + 2] = -soupUp[i + 1]; }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  geo.computeVertexNormals();
  var m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: CONNECT_GHOST_COLOR, transparent: true, opacity: 0.75, metalness: 0.05, roughness: 0.5, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  m.name = 'connectGhost';
  m.userData.connectGhost = true; m.userData.skipXray = true;
  nsoHelpers.attach(state.scene, m, 'connect');
  C.ghost = m;
}

/* --------------------------------------------------------------- the card */

function NSO_connectReadout(text, bad) {
  var el = NSO_connectEl('connect-readout');
  if (el) { el.textContent = text; el.classList.toggle('is-bad', !!bad); }
}
function NSO_connectAnchorText() {
  var C = NSO_connectUI();
  [['a', C.a], ['b', C.b]].forEach(function (x) {
    var el = NSO_connectEl('connect-' + x[0] + '-text');
    if (el) el.textContent = NSO_connectAnchorLine(x[0], x[1]);
  });
}
// "Anchor A: on box_closed at 2.1 mm from its corner"
function NSO_connectAnchorLine(which, sel) {
  return 'Anchor ' + which.toUpperCase() + ': ' + (sel ? sel.text : '— click a piece');
}

function NSO_connectShape() { var el = NSO_connectEl('sel-connect-shape'); return el && el.value ? el.value : 'string'; }
function NSO_connectResult() {
  var els = typeof document !== 'undefined' ? document.getElementsByName('connect-result') : [];
  for (var i = 0; i < els.length; i++) if (els[i].checked) return els[i].value;
  return 'weld';
}
function NSO_connectEnds() { var el = NSO_connectEl('sel-connect-ends'); return el && el.value ? el.value : 'weld'; }
function NSO_connectOpts() {
  function num(id) { var el = NSO_connectEl(id); return el && el.value !== '' && isFinite(+el.value) ? +el.value : null; }
  var o = { shape: NSO_connectShape(), result: NSO_connectResult(), ends: NSO_connectEnds() };
  [['inp-connect-dia', 'diameterMm'], ['inp-connect-width', 'widthMm'], ['inp-connect-thick', 'thicknessMm'],
   ['inp-connect-tube-dia', 'tubeDiaMm'], ['inp-connect-wall', 'wallMm'], ['inp-connect-dia-a', 'diaAMm'],
   ['inp-connect-dia-b', 'diaBMm'], ['inp-connect-sag', 'sagMm']].forEach(function (f) { var v = num(f[0]); if (v != null) o[f[1]] = v; });
  return o;
}
function NSO_connectSyncRows() {
  var C = NSO_connectUI(), shape = NSO_connectShape();
  [['connect-string-rows', 'string'], ['connect-ribbon-rows', 'ribbon'], ['connect-tube-rows', 'tube'], ['connect-tapered-rows', 'tapered']].forEach(function (r) {
    var el = NSO_connectEl(r[0]); if (el) el.hidden = shape !== r[1];
  });
  var go = NSO_connectEl('btn-connect-go');
  if (go) go.disabled = !(C.plan && C.plan.ok) || C.busy;
}

// The picks -> a plan, a ghost and the readout. Refusals are words.
function NSO_connectPreview() {
  var C = NSO_connectUI();
  NSO_connectSetGhost(null);
  NSO_connectAnchorText();
  if (!C.a || !C.b) { C.plan = null; NSO_connectSyncRows(); return null; }
  var ids = [C.a.sourceId], pieces = [NSO_connectSoupFor(C.a.placed)];
  if (C.b.sourceId !== C.a.sourceId) { ids.push(C.b.sourceId); pieces.push(NSO_connectSoupFor(C.b.placed)); }
  var o = NSO_connectOpts();
  o.others = (state.placed || []).filter(function (q) { return q && q.mesh && q.mesh.visible !== false && ids.indexOf(q.sourceId) < 0; })
    .map(function (q) { var m = NSO_bridgeModel(q.sourceId); return { soup: NSO_connectSoupFor(q), name: m ? m.name : null }; });
  var p;
  try {
    p = NSO_Connect.plan(pieces, { piece: 0, target: C.a.target }, { piece: ids.indexOf(C.b.sourceId), target: C.b.target }, o);
  } catch (err) { p = { ok: false, reason: (err && err.message) || String(err) }; }
  p.ids = ids;
  p.keys = [NSO_bridgePoseKey(C.a.placed), NSO_bridgePoseKey(C.b.placed)];
  C.plan = p;
  if (p.ok) {
    NSO_connectSetGhost(p.web);
    NSO_connectReadout(NSO_connectAnchorLine('a', C.a) + ' · ' + NSO_connectAnchorLine('b', C.b) + ' · ' + p.text +
                       ' · Set ' + (p.result === 'weld' ? 'welds it' : 'adds it'), false);
  } else {
    NSO_connectReadout('Connect: ' + p.reason, true);
  }
  NSO_connectSyncRows();
  return p;
}

function NSO_connectClearPicks() {
  var C = NSO_connectUI();
  C.a = null; C.b = null; C.plan = null; C.press = null;
  NSO_connectSetGhost(null); NSO_connectDrawLine(null, null); NSO_connectDrawPicks();
  NSO_connectAnchorText(); NSO_connectSyncRows();
}

function NSO_connectOpen() {
  var C = NSO_connectUI(), panel = NSO_connectEl('connect-panel');
  C.open = true; C.soups = {};
  if (panel) panel.hidden = false;
  NSO_connectClearPicks();
  NSO_connectReadout(NSO_connectReady() ? (NSO_connectDrawOn() ? NSO_CONNECT_DRAW_HINT : NSO_CONNECT_HINT) : 'Connect needs Bridge\'s pick (nso_bridge.js, app-bridge.js) and nso_connect.js loaded.', !NSO_connectReady());
  NSO_connectTick();
}

function NSO_connectClose() {
  // Attach's button is in the card: shut the card and it is out of sight, so it is off.
  if (typeof state !== 'undefined' && state.attachArmed && typeof window.nsoAttachDisarm === 'function') window.nsoAttachDisarm();
  var C = NSO_connectUI(), panel = NSO_connectEl('connect-panel');
  C.open = false; C.hover = null; C.soups = {};
  NSO_connectStrokeCancel();
  if (panel) panel.hidden = true;
  NSO_connectClearPicks();
  NSO_bridgeDispose(C.overlay); C.overlay = null;
  if (C.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(C.raf);
  C.raf = 0;
}

// Connect's session, for the helper registry (nso-helpers.js). An Undo under an
// open card drops the picks: the connector was planned on pieces as they were.
if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('connect', {
  live: function () { return !!NSO_connectUI().open; },
  close: NSO_connectClose,
  clear: function () {
    var C = NSO_connectUI();
    [C.overlay, C.line, C.ghost].forEach(NSO_bridgeDispose);
    C.overlay = C.line = C.ghost = null;
  },
  refresh: function () { var C = NSO_connectUI(); C.soups = {}; NSO_connectClearPicks(); }
});

// Shut the card: the column drop-down closes and the session goes with it. The
// drop-down's own `open` is the switch (wireCard), so this only has to
// flip it; NSO_connectClose is called as well so the teardown has landed by
// the time this returns, not a microtask later.
function NSO_connectShut() {
  var menu = NSO_connectEl('menu-connect');
  if (menu && menu.open) menu.open = false;
  NSO_connectClose();
}

// Cancel (and Escape): drop the picks; with none, close the card.
function NSO_connectCancel() {
  var C = NSO_connectUI();
  if (C.stroke) { NSO_connectStrokeCancel('Stroke cancelled - nothing built. ' + NSO_CONNECT_DRAW_HINT); return; }
  if (C.a || C.b || C.plan) { NSO_connectClearPicks(); NSO_connectReadout(NSO_CONNECT_HINT, false); }
  else NSO_connectShut();
}

// Per frame while open: the card goes when its drop-down shuts (one panel at a
// time), and the picks go when a picked piece moved, changed or left. The
// camera is not a piece: orbiting never disturbs a pick.
function NSO_connectTick() {
  var C = NSO_connectUI();
  if (!C.open) return;
  var panel = NSO_connectEl('connect-panel');
  var menu = panel && panel.closest ? panel.closest('details') : null;
  if (menu && !menu.open) { NSO_connectClose(); return; }
  if (!C.busy && (C.a || C.b)) {
    var stale = [C.a, C.b].some(function (s) {
      if (!s) return false;
      var p = NSO_bridgePlacedBySource(s.sourceId);
      return !p || NSO_bridgePoseKey(p) !== s.cache.key;
    });
    if (stale) { NSO_connectClearPicks(); NSO_connectReadout('The pieces moved - pick again. ' + NSO_CONNECT_HINT, false); }
  }
  C.raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(NSO_connectTick) : 0;
}

/* ------------------------------------------------------------------ Set */

function NSO_connectSay(text, bad) { if (typeof setStatus === 'function') setStatus(text, bad); }

function NSO_connectSet() { return NSO_connectRun(NSO_connectUI().plan); }

// Build a plan: Set's, or a finished stroke's.
async function NSO_connectRun(p) {
  var C = NSO_connectUI();
  if (!p || !p.ok) return Promise.resolve({ ok: false, reason: p ? p.reason : 'nothing to connect - pick two anchors' });
  if (C.busy) return Promise.resolve({ ok: false, reason: 'busy' });
  var weld = p.result === 'weld';
  var models = p.ids.map(NSO_bridgeModel), placed = p.ids.map(NSO_bridgePlacedBySource);
  if (models.some(function (m) { return !m; }) || placed.some(function (q) { return !q; })) {
    NSO_connectClearPicks();
    return Promise.resolve({ ok: false, reason: 'a picked piece is no longer on the plate' });
  }
  var want = p.drawn ? p.keys : (p.ids.length === 2 ? p.keys : [p.keys[0]]);
  if (placed.some(function (q, i) { return NSO_bridgePoseKey(q) !== want[i]; })) {
    NSO_connectClearPicks();
    NSO_connectReadout('The pieces moved - pick again.', true);
    return Promise.resolve({ ok: false, reason: 'the pieces moved since they were picked' });
  }
  if (weld) {
    var painted = models.reduce(function (s, m) { return s + ((typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0); }, 0);
    if (painted > 0) {
      var why = 'Connect stood down - ' + painted + ' painted face(s); a weld rebuilds the pieces it joins into a new one. Clear paint to weld, or Keep separate.';
      NSO_connectSay(why, true); NSO_connectReadout(why, true);
      return Promise.resolve({ ok: false, reason: 'painted faces: ' + painted, painted: painted });
    }
  }
  var merged = '', wp = p;
  if (weld) {
    // busy while the shells are checked (and merged), so a second press does not start a second
    C.busy = true; NSO_connectSyncRows();
    var sol;
    try { sol = await NSO_bridgeSolidPlan(p, 'connect-readout'); }
    finally { C.busy = false; NSO_connectSyncRows(); }
    if (!sol.ok) {
      NSO_connectSay(sol.cancelled ? 'Connect stopped - pieces unchanged' : 'Connect refused - pieces unchanged (' + sol.reason + ')', !sol.cancelled);
      NSO_connectReadout('Connect: ' + sol.reason, !sol.cancelled);
      return Promise.resolve({ ok: false, reason: sol.reason, cancelled: !!sol.cancelled });
    }
    wp = sol.plan; merged = sol.note;
  }
  C.busy = true; NSO_connectSyncRows();
  if (weld || p.tips) NSO_connectSay('Connecting (loading CSG kernel)...');
  var unionFn = (typeof NSO_unionSoups === 'function')
    ? function (a, b) { return NSO_unionSoups(a, b, { label: 'Connecting', host: 'connect-readout' }); } : null;
  return NSO_Connect.weld(wp, { union: unionFn }).then(function (r) {
    C.busy = false;
    if (!r.ok) {
      NSO_connectSay('Connect refused - pieces unchanged (' + r.reason + ')', true);
      NSO_connectReadout('Connect: ' + r.reason, true);
      NSO_connectSyncRows();
      return r;
    }
    var c = NSO_connectCommit(r.soup, weld ? models : [], p.shape);
    if (!c.ok) {
      NSO_connectSay('Connect failed - pieces unchanged (' + c.reason + ')', true);
      NSO_connectReadout('Connect: ' + c.reason, true);
      NSO_connectSyncRows();
      return c;
    }
    var msg = p.drawn
      ? 'Connect done - ' + p.text + '; ' + (r.soup.length / 9) + ' faces. One Undo ' + (weld ? 'puts the piece' + (models.length > 1 ? 's' : '') + ' back.' : 'takes it off the plate.')
      : weld
      ? 'Connect done - ' + p.text + '; ' + (models.length === 2 ? 'two pieces are one' : 'the piece is closed on itself') + ', ' + (r.soup.length / 9) +
        ' faces. One Undo puts ' + (models.length === 2 ? 'both back.' : 'it back.')
      : 'Connect done - ' + p.text + '; ' + (r.soup.length / 9) + ' faces. One Undo takes it off the plate.';
    if (merged) msg += ' (' + merged + '.)';
    NSO_connectSay(msg);
    // Armed for the next pair: A and B clear, the fields keep their values. What
    // was hovered may be a piece the weld has just consumed.
    C.hover = null; C.soups = {};
    NSO_connectClearPicks();
    NSO_connectReadout('Connected. ' + (merged ? merged + '. ' : '') + (p.drawn ? NSO_CONNECT_DRAW_HINT : NSO_CONNECT_HINT), false);
    r.merged = merged;
    r.newId = c.id;
    return r;
  }).catch(function (err) {
    C.busy = false; NSO_connectSyncRows();
    console.error('[connect]', err);
    NSO_connectSay('Connect failed - pieces unchanged (' + ((err && err.message) || err) + ')', true);
    return { ok: false, reason: (err && err.message) || String(err) };
  });
}

/* Put the result on the plate. `models` are the inputs a weld consumes (none
   for Keep separate); it is ONE undo step either way (supportSwap: the new
   piece off, every input back exactly as it was - model, placed record, mesh,
   pose). */
function NSO_connectCommit(soupUp, models, shape) {
  var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (var i = 0; i < soupUp.length; i++) { var k = i % 3; if (soupUp[i] < lo[k]) lo[k] = soupUp[i]; if (soupUp[i] > hi[k]) hi[k] = soupUp[i]; }
  var drop = new Set(models.map(function (m) { return m.id; })), removed = [];
  state.placed.forEach(function (q, idx) { if (q && drop.has(q.sourceId)) removed.push({ placed: q, placedIndex: idx }); });
  removed.forEach(function (r) { r.model = NSO_bridgeModel(r.placed.sourceId); r.modelIndex = state.models.indexOf(r.model); });
  function putBack() {
    removed.slice().sort(function (x, y) { return x.modelIndex - y.modelIndex; }).forEach(function (r) {
      if (state.models.indexOf(r.model) < 0) state.models.splice(Math.min(r.modelIndex, state.models.length), 0, r.model);
    });
    removed.slice().sort(function (x, y) { return x.placedIndex - y.placedIndex; }).forEach(function (r) {
      if (state.placed.indexOf(r.placed) < 0) state.placed.splice(Math.min(r.placedIndex, state.placed.length), 0, r.placed);
      if (r.placed.mesh && state.modelGroup && !r.placed.mesh.parent) state.modelGroup.add(r.placed.mesh);
    });
    state.placed.forEach(function (q, j) { if (q.mesh) q.mesh.userData.placedIndex = j; });
  }
  if (drop.size) {
    state.placed = state.placed.filter(function (q) { return !(q && drop.has(q.sourceId)); });
    state.models = state.models.filter(function (m) { return !drop.has(m.id); });
    removed.forEach(function (r) { if (r.placed.mesh && r.placed.mesh.parent) r.placed.mesh.parent.remove(r.placed.mesh); });
    state.placed.forEach(function (q, j) { if (q.mesh) q.mesh.userData.placedIndex = j; });
  }

  var name;
  if (models.length) {
    name = models.map(function (m) { return m.name; }).filter(function (n, j, a) { return a.indexOf(n) === j; }).join(' + ');
    if (!/\(connected\)$/.test(name)) name += ' (connected)';
  } else {
    name = 'Connector (' + shape + ')';
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(soupUp), 3));
  var id = addModelFromZUpGeometry(name, geo, { keepSelection: true, silent: true });
  if (!id) { putBack(); return { ok: false, reason: 'the connected piece could not be added' }; }
  var m = NSO_bridgeModel(id);
  var entry = placeModelMovable(m, (lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2);
  entry.mesh.position.y = (lo[2] + hi[2]) / 2;
  // Resting where the inputs rested: the plate puts a piece's bottom at 0.2-0.3.
  entry.liftY = lo[2] > 0.35 ? lo[2] - 0.3 : 0;
  entry.mesh.updateMatrixWorld(true);
  // Read it back off the scene: it must stand exactly where it was built.
  var back = meshToWorldSoup(entry.mesh), err = 0;
  if (back.length !== soupUp.length) err = Infinity;
  else for (var t = 0; t < back.length; t += 3) {
    err = Math.max(err, Math.abs(back[t] - soupUp[t]), Math.abs(-back[t + 2] - soupUp[t + 1]), Math.abs(back[t + 1] - soupUp[t + 2]));
  }
  if (!(err <= 1e-3)) {
    if (entry.mesh.parent) entry.mesh.parent.remove(entry.mesh);
    state.placed = state.placed.filter(function (q) { return q !== entry; });
    state.models = state.models.filter(function (x) { return x.id !== id; });
    putBack();
    return { ok: false, reason: 'the connected piece did not land where it was built (' + (isFinite(err) ? err.toExponential(2) : 'size') + ' mm off)' };
  }
  if (typeof pushUndo === 'function') {
    pushUndo({ type: 'supportSwap', removed: removed, addedIds: [id], label: models.length
      ? 'Undo: Connect reverted - ' + (models.length === 2 ? 'both pieces back as they were' : 'the piece back as it was')
      : 'Undo: Connect reverted - the connector is off the plate' });
  }
  state.editId = id;
  state.selectedIndex = state.placed.indexOf(entry);
  if (typeof renderModelList === 'function') renderModelList();
  if (typeof updateOptimizeButton === 'function') updateOptimizeButton();
  if (typeof updateEditSize === 'function') updateEditSize();
  if (typeof updateAdjustUI === 'function') updateAdjustUI();
  if (typeof updateUndoBtn === 'function') updateUndoBtn();
  return { ok: true, id: id, entry: entry, maxErrMm: err };
}

/* ---------------------------------------------------------- the pointer */

// A click on a place: it sets, or clears, an anchor.
function NSO_connectClickPiece(pick, shift) {
  var C = NSO_connectUI(), sel = NSO_connectResolve(pick, shift);
  if (NSO_connectSame(sel, C.a)) C.a = null;
  else if (NSO_connectSame(sel, C.b)) C.b = null;
  else if (!C.a) C.a = sel;
  else if (!C.b) C.b = sel;
  else C.b = sel;                        // both set: the new place replaces B
  NSO_connectDrawLine(null, null);
  NSO_connectDrawPicks();
  if (C.a && C.b) NSO_connectPreview();
  else {
    C.plan = null; NSO_connectSetGhost(null); NSO_connectAnchorText(); NSO_connectSyncRows();
    NSO_connectReadout(C.a || C.b ? NSO_connectAnchorLine(C.a ? 'a' : 'b', C.a || C.b) + ' - orbit as you like, then click ' + (C.a ? 'B' : 'A') + '.' : NSO_CONNECT_HINT, false);
  }
}

if (typeof document !== 'undefined') {
  (function wireConnect() {
    function onCanvas(ev) { return state.renderer && ev.target === state.renderer.domElement; }
    function target(ev) {
      if (!NSO_connectReady()) return null;
      try { return NSO_bridgeTargetAt(ev); } catch (err) { return null; }
    }
    // Nothing is held down between the clicks, so this only runs for a pointer
    // that is just moving: an orbit drag (a button down) is left alone.
    function onMove(ev) {
      var C = NSO_connectUI();
      if (C.stroke) {                                        // a stroke is down: this is its drag
        if (!(ev.buttons & 1)) { onUp(ev); return; }          // (the button came up unseen)
        NSO_connectStrokeAdd(ev);
        if (!C.stroke.raf && typeof requestAnimationFrame === 'function') C.stroke.raf = requestAnimationFrame(NSO_connectStrokeFrame);
        return;
      }
      if (!C.open || C.busy || state.attachArmed || ev.buttons || !onCanvas(ev) || NSO_connectDrawOn()) return;
      var sel = target(ev);
      C.hover = sel;
      var held = C.a && !C.b ? C.a : (C.b && !C.a ? C.b : null);
      if (held) {
        var to = sel ? sel.world : null;
        if (!to) {
          // off the pieces: the line ends under the pointer at the anchor's depth
          var p0 = NSO_bridgeUpToDisplay(NSO_connectAnchorPoint(held)), d = state.camera.position.distanceTo(p0);
          to = state.raycaster.ray.at(d, new THREE.Vector3());
        }
        NSO_connectDrawLine(NSO_bridgeUpToDisplay(NSO_connectAnchorPoint(held)), to);
      }
      NSO_connectDrawPicks();
      if (!C.a && !C.b) NSO_connectReadout(sel ? 'Under the pointer: ' + sel.target.text + ' - click to make it anchor A.' : NSO_CONNECT_HINT, false);
    }
    // A press ON a piece is Connect's while the card is open (it would
    // otherwise select the piece and start a move drag under the click); a
    // press anywhere else is untouched, so orbit, pan and zoom are as always.
    function onDown(ev) {
      var C = NSO_connectUI();
      C.press = null;
      if (!C.open || C.busy || state.attachArmed || ev.button !== 0 || !onCanvas(ev)) return;
      if (NSO_connectDrawOn()) {
        // A press that finds the plate or a piece starts a stroke; one that finds nothing is an orbit as ever.
        if (!NSO_connectSample(ev)) return;
        C.stroke = { raw: [], last: null, dirty: false, raf: 0, plan: null };
        NSO_connectStrokeAdd(ev);
        ev.stopImmediatePropagation(); ev.preventDefault();
        return;
      }
      var sel = target(ev);
      C.press = { x: ev.clientX, y: ev.clientY, sel: sel, shift: !!ev.shiftKey };
      if (sel) { ev.stopImmediatePropagation(); ev.preventDefault(); }
    }
    function onUp(ev) {
      var C = NSO_connectUI(), pr = C.press;
      C.press = null;
      if (C.stroke) {                                        // the release: build the stroke
        var S = C.stroke;
        NSO_connectStrokeAdd(ev);
        if (S.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(S.raf);
        C.stroke = null;
        ev.stopImmediatePropagation();
        NSO_connectSetGhost(null); NSO_connectDrawStroke(null);
        var p = NSO_connectStrokePlan(S);
        if (!p.ok) { NSO_connectReadout('Draw: ' + p.reason, true); NSO_connectSay('Draw: ' + p.reason, true); return; }
        C.drawing = NSO_connectRun(p);
        return;
      }
      if (!C.open || !pr || C.busy || state.attachArmed || ev.button !== 0) return;
      if (Math.hypot(ev.clientX - pr.x, ev.clientY - pr.y) > CONNECT_CLICK_PX) return;     // an orbit drag, not a click
      if (!onCanvas(ev)) return;
      if (pr.sel) {
        // The press already named what was under it; the release is the click.
        NSO_connectClickPiece(pr.sel, ev.shiftKey || pr.shift);
        ev.stopImmediatePropagation();
      } else if (C.a || C.b) {
        NSO_connectClearPicks();
        NSO_connectReadout(NSO_CONNECT_HINT, false);
      }
    }
    function onKey(ev) {
      var C = NSO_connectUI();
      if (!C.open || ev.key !== 'Escape') return;
      // Escape with Attach armed is Attach's, as Cancel is: it stops, the anchors and the card stay.
      if (state.attachArmed && typeof window.nsoAttachDisarm === 'function') { window.nsoAttachDisarm(); return; }
      NSO_connectCancel();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    }
    // The column drop-down is the switch: open arms the picks, shut puts them
    // away. A MutationObserver on `open` rather than a 'toggle' listener, for
    // the reason app-join.js's one-panel rule gives (it sees a programmatic
    // `.open = true` too, and runs before the next event).
    function wireCard(menu) {
      if (typeof MutationObserver !== 'function') return;
      new MutationObserver(function () {
        var C = NSO_connectUI();
        if (menu.open && !C.open) NSO_connectOpen();
        else if (!menu.open && C.open) NSO_connectClose();
      }).observe(menu, { attributes: true, attributeFilter: ['open'] });
      if (menu.open && !NSO_connectUI().open) NSO_connectOpen();
    }
    function wire() {
      var menu = NSO_connectEl('menu-connect');
      if (!menu || menu.dataset.nsoWired === '1') return;
      menu.dataset.nsoWired = '1';
      wireCard(menu);
      var go = NSO_connectEl('btn-connect-go'), cancel = NSO_connectEl('btn-connect-cancel');
      if (go) go.addEventListener('click', function () { NSO_connectSet(); });
      var draw = NSO_connectEl('chk-connect-draw');
      if (draw) draw.addEventListener('change', function () {
        var C = NSO_connectUI();
        NSO_connectStrokeCancel(); C.hover = null;
        NSO_connectClearPicks();
        NSO_connectReadout(draw.checked ? NSO_CONNECT_DRAW_HINT : NSO_CONNECT_HINT, false);
      });
      if (cancel) cancel.addEventListener('click', function () {
        // Cancel with Attach armed is Attach's: it stops, the anchors and the card stay.
        if (state.attachArmed && typeof window.nsoAttachDisarm === 'function') { window.nsoAttachDisarm(); return; }
        NSO_connectCancel();
      });
      var redraw = function () { var C = NSO_connectUI(); if (C.a && C.b) NSO_connectPreview(); else NSO_connectSyncRows(); };
      // The ghost follows the fields as they change: a typed value after a short
      // pause, a finished one (change) at once.
      ['inp-connect-dia', 'inp-connect-width', 'inp-connect-thick', 'inp-connect-tube-dia', 'inp-connect-wall',
       'inp-connect-dia-a', 'inp-connect-dia-b', 'inp-connect-sag'].forEach(function (id) {
        var el = NSO_connectEl(id);
        if (!el) return;
        el.addEventListener('input', function () {
          var C = NSO_connectUI();
          if (C.timer) clearTimeout(C.timer);
          C.timer = setTimeout(function () { C.timer = 0; redraw(); }, 120);
        });
        el.addEventListener('change', function () { var C = NSO_connectUI(); if (C.timer) { clearTimeout(C.timer); C.timer = 0; } redraw(); });
      });
      var sel = NSO_connectEl('sel-connect-shape');
      if (sel) sel.addEventListener('change', function () { NSO_connectSyncRows(); redraw(); });
      var ends = NSO_connectEl('sel-connect-ends');
      if (ends) ends.addEventListener('change', redraw);
      var radios = document.getElementsByName('connect-result');
      for (var i = 0; i < radios.length; i++) radios[i].addEventListener('change', redraw);
      NSO_connectSyncRows();
      // Capture on window: ahead of app-core's canvas handler, so a press on a
      // piece does not also select or drag it.
      window.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('keydown', onKey, true);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
