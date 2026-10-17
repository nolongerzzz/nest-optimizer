// ===================== Bridge: the card =====================
// The geometry is nso_bridge.js (headless, tools/nso_bridge_test.js); this
// file is the card on it, in the left column's Shape drop-down, beside Extend
// (and Bend, on the top row). docs/BRIDGE.md.
//
// One verb. Open Bridge, and while it is open:
//   - HOVER: whatever is under the pointer that Bridge could take lights up -
//     a face (its triangles), an edge (a bar along the whole straight edge) or
//     a point (a dot) - and the readout names it;
//   - CLICK on one (it stays marked), orbit, pan and zoom as much as you like -
//     nothing is held, so the camera is free - then CLICK on another: the web
//     between them is built at once and drawn as a GHOST (amber, as Bend's),
//     from the very soup Set would weld. A line from the marked place follows
//     the pointer meanwhile. A refusal draws nothing and says why in the
//     readout, in red. A click on empty space, Escape, or a click on the
//     marked place again drops the mark (and any web on it); a click on
//     another place while a web is showing moves its second end there;
//   - SET welds it: the two pieces (or the one, when both ends are on it)
//     leave the plate and one new piece takes their place, exactly where they
//     stood. One Undo puts every input back as it was. CANCEL drops the
//     pending web; pressed with nothing pending it closes the card.
// Repeat as often as wanted: the card stays open after a Set.
//
// What is picked chooses the web (nso_bridge.js): face -> face a band,
// point -> point a string (Ø field), edge -> edge a sheet (thickness field).
//
// Both pieces are read in the plate's world frame, Z up (meshToWorldSoup, then
// (x, -z, y)), so their poses are in the numbers and the result needs none.
//
// PAINT SCOPE: WHOLE-PIECE, on BOTH pieces. Per the scoping rule in
// docs/HANDOFF.md: a band drops both faces' caps and splits the walls round
// them, and a string or sheet goes through the boolean kernel, which rebuilds
// every face - so no face on either piece can be promised untouched, and the
// new piece is a new model. Any paint on either piece stands it down, naming
// the count: nsoMaskCount(m) is the whole test.

var BRIDGE_GHOST_COLOR = 0xf59e0b;      // Bend's ghost, Crop's lifted ghost
var BRIDGE_HOVER_COLOR = 0x22d3ee;
var BRIDGE_PICK_COLOR = 0xffc83d;       // Cut's blade frame
var BRIDGE_RENDER_ORDER = 21;
var BRIDGE_EDGE_PX = 8;                 // a press this close to a face's straight edge picks the edge
var BRIDGE_CLICK_PX = 4;                // a press that travels farther than this is an orbit, not a click

function NSO_bridgeUI() {
  if (typeof state === 'undefined') return {};
  if (!state.bridge) {
    state.bridge = { open: false, idx: {}, hover: null, a: null, b: null, plan: null,
                     press: null, last: null, camKey: '',
                     overlay: null, ghost: null, line: null, busy: false, raf: 0, key: '' };
  }
  return state.bridge;
}
function NSO_bridgeEl(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }

/* ------------------------------------------------------------ the pieces */

function NSO_bridgePlacedBySource(id) {
  return (state.placed || []).find(function (p) { return p && p.sourceId === id && p.mesh; }) || null;
}
function NSO_bridgeModel(id) { return (state.models || []).find(function (m) { return m.id === id; }) || null; }
// The overlap guard (nso-helpers.js, nsoOverlap): '' for clean solids, else the
// sentence naming the first piece with overlapping shells. Bridge and Connect
// ask it before the kernel; a band welds without the kernel and never asks.
function NSO_bridgeOverlap(ids) {
  return (typeof nsoOverlap !== 'undefined' && nsoOverlap) ? nsoOverlap.refusalOfModels(ids.map(NSO_bridgeModel)) : '';
}

// A placed piece's pose, as a string: its world matrix and its geometry.
function NSO_bridgePoseKey(p) {
  p.mesh.updateMatrixWorld(true);
  return p.sourceId + '|' + p.mesh.geometry.uuid + '|' + Array.prototype.map.call(p.mesh.matrixWorld.elements,
    function (v) { return v.toPrecision(12); }).join(',');
}

// World soup, Z up, and its topology - cached until the piece moves or changes.
function NSO_bridgeIndexFor(p) {
  var B = NSO_bridgeUI(), key = NSO_bridgePoseKey(p), c = B.idx[p.sourceId];
  if (c && c.key === key) return c;
  var s = meshToWorldSoup(p.mesh), up = new Float32Array(s.length);
  for (var i = 0; i < s.length; i += 3) { up[i] = s[i]; up[i + 1] = -s[i + 2]; up[i + 2] = s[i + 1]; }
  c = { key: key, soup: up, T: NSO_Bridge.index(up), sourceId: p.sourceId };
  B.idx[p.sourceId] = c;
  return c;
}

function NSO_bridgeUpToDisplay(q) { return new THREE.Vector3(q[0], q[2], -q[1]); }

/* What is under a pointer event: the piece, and what Bridge would take there. */
function NSO_bridgeTargetAt(ev) {
  if (!state.raycaster || !state.camera || !state.renderer) return null;
  setPointerFromEvent(ev);
  state.raycaster.setFromCamera(state.pointer, state.camera);
  var meshes = (state.placed || []).filter(function (p) { return p && p.mesh && p.mesh.visible !== false; }).map(function (p) { return p.mesh; });
  var hits = state.raycaster.intersectObjects(meshes, false);
  if (!hits.length) return null;
  var h = hits[0], p = (state.placed || []).find(function (q) { return q && q.mesh === h.object; });
  if (!p || h.faceIndex == null) return null;
  var c = NSO_bridgeIndexFor(p);
  var w = h.point, up = [w.x, -w.z, w.y];
  // BRIDGE_EDGE_PX on screen, in mm at the hit's depth.
  var dist = state.camera.position.distanceTo(w), H = state.renderer.domElement.clientHeight || 600;
  var mmPerPx = state.camera.isPerspectiveCamera
    ? 2 * dist * Math.tan((state.camera.fov * Math.PI / 180) / 2) / H
    : (state.camera.top - state.camera.bottom) / (state.camera.zoom || 1) / H;
  var t = NSO_Bridge.pick(c.T, h.faceIndex, up, { edgeTolMm: BRIDGE_EDGE_PX * mmPerPx });
  if (!t || !t.kind) return null;
  return { sourceId: p.sourceId, placed: p, cache: c, target: t, world: w.clone() };
}

/* ---------------------------------------------------------------- drawing */

function NSO_bridgeDispose(o) {
  if (!o) return;
  if (o.parent) o.parent.remove(o);
  o.traverse(function (x) { if (x.geometry) x.geometry.dispose(); if (x.material) x.material.dispose(); });
}
function NSO_bridgeOverlay(o, order) {
  o.renderOrder = order || BRIDGE_RENDER_ORDER; o.userData.skipXray = true; o.userData.bridgeOverlay = true;
  o.raycast = function () {}; o.frustumCulled = false;
  return o;
}

// One target drawn: a face's triangles, an edge's bar, a point's dot.
function NSO_bridgeTargetObject(sel, color) {
  var t = sel.target, g = new THREE.Group();
  if (t.kind === 'face') {
    var soup = sel.cache.soup, tris = t.face.tris, arr = new Float32Array(tris.length * 9), v = 0;
    tris.forEach(function (ti) {
      for (var k = 0; k < 3; k++) {
        var o = ti * 9 + k * 3, d = NSO_bridgeUpToDisplay([soup[o], soup[o + 1], soup[o + 2]]);
        arr[v++] = d.x; arr[v++] = d.y; arr[v++] = d.z;
      }
    });
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    g.add(NSO_bridgeOverlay(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: color, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthTest: false, depthWrite: false }))));
  } else if (t.kind === 'edge') {
    var a = NSO_bridgeUpToDisplay(t.a), b = NSO_bridgeUpToDisplay(t.b), L = a.distanceTo(b);
    var r = Math.max(0.15, Math.min(0.6, L * 0.01));
    var cyl = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L, 10, 1, false), new THREE.MeshBasicMaterial({
      color: color, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }));
    cyl.position.copy(a.clone().add(b).multiplyScalar(0.5));
    cyl.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    g.add(NSO_bridgeOverlay(cyl));
  }
  var dot = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8), new THREE.MeshBasicMaterial({
    color: color, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }));
  dot.position.copy(NSO_bridgeUpToDisplay(t.point));
  if (t.kind !== 'point') dot.scale.setScalar(0.6);
  g.add(NSO_bridgeOverlay(dot, BRIDGE_RENDER_ORDER + 1));
  g.userData.kind = t.kind;
  return g;
}

function NSO_bridgeDrawPicks() {
  var B = NSO_bridgeUI();
  NSO_bridgeDispose(B.overlay); B.overlay = null;
  if (typeof THREE === 'undefined' || !state.scene) return;
  var g = new THREE.Group();
  g.name = 'bridgeOverlay';
  if (B.hover && !(B.a && B.hover.sourceId === B.a.sourceId && B.hover.target.tri === B.a.target.tri && B.hover.target.kind === B.a.target.kind)) {
    var h = NSO_bridgeTargetObject(B.hover, BRIDGE_HOVER_COLOR); h.userData.role = 'hover'; g.add(h);
  }
  [B.a, B.b].forEach(function (s, i) {
    if (!s) return;
    var o = NSO_bridgeTargetObject(s, BRIDGE_PICK_COLOR); o.userData.role = i ? 'b' : 'a'; g.add(o);
  });
  nsoHelpers.attach(state.scene, g, 'bridge');
  B.overlay = g;
}

function NSO_bridgeDrawLine(from, to) {
  var B = NSO_bridgeUI();
  NSO_bridgeDispose(B.line); B.line = null;
  if (!from || !to || typeof THREE === 'undefined' || !state.scene) return;
  var geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  B.line = NSO_bridgeOverlay(new THREE.Line(geo, new THREE.LineBasicMaterial({
    color: BRIDGE_PICK_COLOR, transparent: true, depthTest: false, depthWrite: false })), BRIDGE_RENDER_ORDER + 2);
  B.line.name = 'bridgeLine';
  nsoHelpers.attach(state.scene, B.line, 'bridge');
}

function NSO_bridgeSetGhost(soupUp) {
  var B = NSO_bridgeUI();
  NSO_bridgeDispose(B.ghost); B.ghost = null;
  if (!soupUp || typeof THREE === 'undefined' || !state.scene) return;
  var arr = new Float32Array(soupUp.length);
  for (var i = 0; i < soupUp.length; i += 3) { arr[i] = soupUp[i]; arr[i + 1] = soupUp[i + 2]; arr[i + 2] = -soupUp[i + 1]; }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  geo.computeVertexNormals();
  var m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: BRIDGE_GHOST_COLOR, transparent: true, opacity: 0.75, metalness: 0.05, roughness: 0.5, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  m.name = 'bridgeGhost';
  m.userData.bridgeGhost = true; m.userData.skipXray = true;
  nsoHelpers.attach(state.scene, m, 'bridge');
  B.ghost = m;
}

/* --------------------------------------------------------------- the card */

function NSO_bridgeReadout(text, bad) {
  var el = NSO_bridgeEl('bridge-readout');
  if (el) { el.textContent = text; el.classList.toggle('is-bad', !!bad); }
}
function NSO_bridgeOpts() {
  function num(id) { var el = NSO_bridgeEl(id); return el && el.value !== '' && isFinite(+el.value) ? +el.value : null; }
  var o = {};
  var d = num('inp-bridge-dia'); if (d != null) o.diameterMm = d;
  var t = num('inp-bridge-thick'); if (t != null) o.thicknessMm = t;
  return o;
}
function NSO_bridgeSyncRows() {
  var B = NSO_bridgeUI(), k = B.plan ? B.plan.kind : null;
  var dia = NSO_bridgeEl('bridge-dia-row'), th = NSO_bridgeEl('bridge-thick-row'), go = NSO_bridgeEl('btn-bridge-go');
  if (dia) dia.hidden = k !== 'string';
  if (th) th.hidden = k !== 'sheet';
  if (go) go.disabled = !(B.plan && B.plan.ok) || B.busy;
}

// The two picks -> a plan, a ghost and the readout. Refusals are words.
function NSO_bridgePreview() {
  var B = NSO_bridgeUI();
  NSO_bridgeSetGhost(null);
  if (!B.a || !B.b) { B.plan = null; NSO_bridgeSyncRows(); return null; }
  var ids = [B.a.sourceId], pieces = [B.a.cache.soup];
  if (B.b.sourceId !== B.a.sourceId) { ids.push(B.b.sourceId); pieces.push(B.b.cache.soup); }
  var o = NSO_bridgeOpts(), p;
  try {
    p = NSO_Bridge.plan(pieces, { piece: 0, target: B.a.target }, { piece: ids.indexOf(B.b.sourceId), target: B.b.target }, o);
  } catch (err) { p = { ok: false, reason: (err && err.message) || String(err) }; }
  if (p.ok && p.kind !== 'band') { var ov = NSO_bridgeOverlap(ids); if (ov) p = { ok: false, reason: ov, overlap: true }; }
  p.ids = ids;
  p.keys = [B.a.cache.key, B.b.cache.key];
  B.plan = p;
  // Thickness field: the default goes in as its hint.
  var thIn = NSO_bridgeEl('inp-bridge-thick');
  if (thIn && p.kind === 'sheet') {
    var dm = p.ok ? p.defaultMm : null;
    if (dm == null) { try { dm = NSO_Bridge.sheetDefault(pieces, { piece: 0, target: B.a.target }, { piece: ids.indexOf(B.b.sourceId), target: B.b.target }, o).mm; } catch (e) { dm = null; } }
    if (dm != null) thIn.placeholder = 'auto ' + (+dm).toFixed(1);
  }
  if (p.ok) {
    NSO_bridgeSetGhost(p.web);
    NSO_bridgeReadout(p.text[0].toUpperCase() + p.text.slice(1) + ' · Set welds it', false);
  } else {
    NSO_bridgeReadout('Bridge: ' + p.reason, true);
  }
  NSO_bridgeSyncRows();
  return p;
}

function NSO_bridgeClearPicks() {
  var B = NSO_bridgeUI();
  B.a = null; B.b = null; B.plan = null;
  NSO_bridgeSetGhost(null); NSO_bridgeDrawLine(null); NSO_bridgeDrawPicks();
  NSO_bridgeSyncRows();
}

var NSO_BRIDGE_HINT = 'Click a face, an edge or a point, orbit if you like, then click another. Esc or empty space starts over.';

function NSO_bridgeOpen() {
  var B = NSO_bridgeUI(), panel = NSO_bridgeEl('bridge-panel'), btn = NSO_bridgeEl('btn-bridge');
  B.open = true; B.idx = {};
  if (panel) panel.hidden = false;
  if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.classList.add('is-on'); }
  NSO_bridgeClearPicks();
  NSO_bridgeReadout(NSO_BRIDGE_HINT, false);
  NSO_bridgeTick();
}

function NSO_bridgeClose() {
  var B = NSO_bridgeUI(), panel = NSO_bridgeEl('bridge-panel'), btn = NSO_bridgeEl('btn-bridge');
  B.open = false; B.hover = null; B.idx = {};
  if (panel) panel.hidden = true;
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('is-on'); }
  NSO_bridgeClearPicks();
  NSO_bridgeDispose(B.overlay); B.overlay = null;
  if (B.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(B.raf);
  B.raf = 0;
}

// Bridge's session, for the helper registry (nso-helpers.js). An Undo under
// an open card drops the pending web: it was planned on pieces as they were.
if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('bridge', {
  live: function () { return !!NSO_bridgeUI().open; },
  close: NSO_bridgeClose,
  clear: function () {
    var B = NSO_bridgeUI();
    [B.overlay, B.line, B.ghost].forEach(NSO_bridgeDispose);
    B.overlay = B.line = B.ghost = null;
  },
  refresh: function () { NSO_bridgeUI().idx = {}; NSO_bridgeClearPicks(); }
});

// Cancel: drop the pending web; with none pending, close the card.
function NSO_bridgeCancel() {
  var B = NSO_bridgeUI();
  if (B.a || B.b || B.plan) { NSO_bridgeClearPicks(); NSO_bridgeReadout(NSO_BRIDGE_HINT, false); }
  else NSO_bridgeClose();
}

// Per frame while open: the card goes when its drop-down shuts (one panel at
// a time), and the picks go when a picked piece moved, changed or left.
function NSO_bridgeTick() {
  var B = NSO_bridgeUI();
  if (!B.open) return;
  var panel = NSO_bridgeEl('bridge-panel');
  var menu = panel && panel.closest ? panel.closest('details') : null;
  if (menu && !menu.open) { NSO_bridgeClose(); return; }
  if (!B.busy && (B.a || B.b)) {
    var stale = [B.a, B.b].some(function (s) {
      if (!s) return false;
      var p = NSO_bridgePlacedBySource(s.sourceId);
      return !p || NSO_bridgePoseKey(p) !== s.cache.key;
    });
    if (stale) { NSO_bridgeClearPicks(); NSO_bridgeReadout('The pieces moved - pick again. ' + NSO_BRIDGE_HINT, false); }
  }
  // The camera moved under a still pointer (wheel, orbit damping): the hover
  // and the line from the mark follow it.
  if (B.a && !B.b && !B.press && B.last && state.camera) {
    state.camera.updateMatrixWorld();
    var ck = state.camera.matrixWorld.elements.join(',') + '|' + (state.camera.zoom || 1) + '|' + (state.camera.fov || 0);
    if (ck !== B.camKey) { B.camKey = ck; try { NSO_bridgeHoverAt(B.last); } catch (err) { /* a frame without it */ } }
  }
  B.raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(NSO_bridgeTick) : 0;
}

/* ------------------------------------------------------------------ Set */

function NSO_bridgeSay(text, bad) { if (typeof setStatus === 'function') setStatus(text, bad); }

/* Weld the pending plan and put the result on the plate in place of its
   inputs. One undo step (supportSwap: the new piece off, every input back
   exactly as it was - model, placed record, mesh, pose). */
function NSO_bridgeSet() {
  var B = NSO_bridgeUI(), p = B.plan;
  if (!p || !p.ok) return Promise.resolve({ ok: false, reason: p ? p.reason : 'nothing to bridge - pick two places' });
  if (B.busy) return Promise.resolve({ ok: false, reason: 'busy' });
  var models = p.ids.map(NSO_bridgeModel), placed = p.ids.map(NSO_bridgePlacedBySource);
  if (models.some(function (m) { return !m; }) || placed.some(function (q) { return !q; })) {
    NSO_bridgeClearPicks();
    return Promise.resolve({ ok: false, reason: 'a picked piece is no longer on the plate' });
  }
  // ids[0] is the first pick's piece, ids[1] the second's when it is another.
  var want = p.ids.length === 2 ? p.keys : [p.keys[0]];
  if (placed.some(function (q, i) { return NSO_bridgePoseKey(q) !== want[i]; })) {
    NSO_bridgeClearPicks();
    NSO_bridgeReadout('The pieces moved - pick again.', true);
    return Promise.resolve({ ok: false, reason: 'the pieces moved since they were picked' });
  }
  var painted = models.reduce(function (s, m) { return s + ((typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0); }, 0);
  if (painted > 0) {
    var why = 'Bridge stood down - ' + painted + ' painted face(s); a bridge rebuilds both pieces into a new one. Clear paint to bridge.';
    NSO_bridgeSay(why, true); NSO_bridgeReadout(why, true);
    return Promise.resolve({ ok: false, reason: 'painted faces: ' + painted, painted: painted });
  }
  if (p.kind !== 'band') {
    var overlap = NSO_bridgeOverlap(p.ids);
    if (overlap) {
      NSO_bridgeSay('Bridge refused - pieces unchanged (' + overlap + ')', true); NSO_bridgeReadout('Bridge: ' + overlap, true);
      return Promise.resolve({ ok: false, reason: overlap, overlap: true });
    }
  }
  B.busy = true; NSO_bridgeSyncRows();
  if (p.kind !== 'band') NSO_bridgeSay('Bridging (loading CSG kernel)...');
  var unionFn = (typeof NSO_unionSoups === 'function') ? NSO_unionSoups : null;
  return NSO_Bridge.weld(p, { union: unionFn }).then(function (r) {
    B.busy = false;
    if (!r.ok) {
      NSO_bridgeSay('Bridge refused - pieces unchanged (' + r.reason + ')', true);
      NSO_bridgeReadout('Bridge: ' + r.reason, true);
      NSO_bridgeSyncRows();
      return r;
    }
    var c = NSO_bridgeCommit(r.soup, models, placed);
    if (!c.ok) {
      NSO_bridgeSay('Bridge failed - pieces unchanged (' + c.reason + ')', true);
      NSO_bridgeReadout('Bridge: ' + c.reason, true);
      NSO_bridgeSyncRows();
      return c;
    }
    var t = r.topo || {};
    var msg = 'Bridge done - ' + p.text + '; ' + (models.length === 2 ? 'two pieces are one' : 'the piece is closed on itself') +
      ', ' + (r.soup.length / 9) + ' faces, ' + (r.kernel ? r.kernel.open : t.open) + ' open edge(s). One Undo puts ' +
      (models.length === 2 ? 'both back.' : 'it back.');
    NSO_bridgeSay(msg);
    NSO_bridgeClearPicks();
    NSO_bridgeReadout('Bridged. ' + NSO_BRIDGE_HINT, false);
    r.newId = c.id;
    return r;
  }).catch(function (err) {
    B.busy = false; NSO_bridgeSyncRows();
    console.error('[bridge]', err);
    NSO_bridgeSay('Bridge failed - pieces unchanged (' + ((err && err.message) || err) + ')', true);
    return { ok: false, reason: (err && err.message) || String(err) };
  });
}

function NSO_bridgeCommit(soupUp, models, placed) {
  var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (var i = 0; i < soupUp.length; i++) { var k = i % 3; if (soupUp[i] < lo[k]) lo[k] = soupUp[i]; if (soupUp[i] > hi[k]) hi[k] = soupUp[i]; }
  // The inputs come off first, recorded the way G-scope's supportSwap wants them.
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
  state.placed = state.placed.filter(function (q) { return !(q && drop.has(q.sourceId)); });
  state.models = state.models.filter(function (m) { return !drop.has(m.id); });
  removed.forEach(function (r) { if (r.placed.mesh && r.placed.mesh.parent) r.placed.mesh.parent.remove(r.placed.mesh); });
  state.placed.forEach(function (q, j) { if (q.mesh) q.mesh.userData.placedIndex = j; });

  var name = models.map(function (m) { return m.name; }).filter(function (n, j, a) { return a.indexOf(n) === j; }).join(' + ');
  if (!/\(bridged\)$/.test(name)) name += ' (bridged)';
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(soupUp), 3));
  var id = addModelFromZUpGeometry(name, geo, { keepSelection: true, silent: true });
  if (!id) { putBack(); return { ok: false, reason: 'the bridged piece could not be added' }; }
  var m = NSO_bridgeModel(id);
  var entry = placeModelMovable(m, (lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2);
  entry.mesh.position.y = (lo[2] + hi[2]) / 2;
  // Resting where the inputs rested: the plate puts a piece's bottom at 0.2-0.3.
  entry.liftY = lo[2] > 0.35 ? lo[2] - 0.3 : 0;
  entry.mesh.updateMatrixWorld(true);
  // Read it back off the scene: it must stand exactly where it was welded.
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
    return { ok: false, reason: 'the bridged piece did not land where it was welded (' + (isFinite(err) ? err.toExponential(2) : 'size') + ' mm off)' };
  }
  if (typeof pushUndo === 'function') {
    pushUndo({ type: 'supportSwap', removed: removed, addedIds: [id], label: 'Undo: Bridge reverted - ' +
      (models.length === 2 ? 'both pieces back as they were' : 'the piece back as it was') });
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

// Is this pick the very place the other one marked? A face is the same face
// wherever on it the click lands, an edge the same straight run, a point the
// same spot to within a few pixels.
function NSO_bridgeSameTarget(x, y) {
  if (!x || !y || x.sourceId !== y.sourceId || x.target.kind !== y.target.kind) return false;
  var tx = x.target, ty = y.target;
  if (tx.kind === 'face') return tx.tri === ty.tri || tx.face.tris.indexOf(ty.tri) >= 0;
  if (tx.kind === 'edge') {
    function same(p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6; }
    return (same(tx.a, ty.a) && same(tx.b, ty.b)) || (same(tx.a, ty.b) && same(tx.b, ty.a));
  }
  var r = state.renderer.domElement.getBoundingClientRect();
  function px(t) {
    var v = NSO_bridgeUpToDisplay(t.point).project(state.camera);
    return [(v.x + 1) / 2 * r.width, (1 - v.y) / 2 * r.height];
  }
  var pa = px(tx), pb = px(ty);
  return Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) <= BRIDGE_EDGE_PX;
}

// The pointer is at (clientX, clientY): light what is under it and, with a
// place marked and no second one yet, run the line out to it (or, off the
// pieces, to where the pointer's ray is at the mark's depth).
function NSO_bridgeHoverAt(pt) {
  var B = NSO_bridgeUI();
  B.last = { clientX: pt.clientX, clientY: pt.clientY };
  var sel = null;
  try { sel = NSO_bridgeTargetAt(pt); } catch (err) { sel = null; }
  B.hover = sel;
  if (B.a && !B.b) {
    var to = sel ? sel.world : null;
    if (!to) {
      var p0 = NSO_bridgeUpToDisplay(B.a.target.point), d = state.camera.position.distanceTo(p0);
      to = state.raycaster.ray.at(d, new THREE.Vector3());
    }
    NSO_bridgeDrawLine(NSO_bridgeUpToDisplay(B.a.target.point), to);
  }
  NSO_bridgeDrawPicks();
  if (!B.a) NSO_bridgeReadout(sel ? 'Under the pointer: ' + sel.target.text + ' - click to mark it.' : NSO_BRIDGE_HINT, false);
  else if (!B.b) NSO_bridgeReadout('From the ' + B.a.target.text + (sel && !NSO_bridgeSameTarget(B.a, sel)
    ? ' - click the ' + sel.target.text + ' to bridge to it.' : ' - click another place; orbit first if you like. Esc clears it.'), false);
  return sel;
}

// A click (press and release without travelling) at ev.
function NSO_bridgeClick(ev) {
  var B = NSO_bridgeUI(), sel = null;
  try { sel = NSO_bridgeTargetAt(ev); } catch (err) { sel = null; }
  if (!sel || NSO_bridgeSameTarget(B.a, sel)) {
    // empty space, or the marked place again: let go of the mark
    if (B.a) { NSO_bridgeClearPicks(); B.hover = sel; NSO_bridgeDrawPicks(); NSO_bridgeReadout(NSO_BRIDGE_HINT, false); }
    return;
  }
  B.hover = sel;
  if (!B.a) {
    NSO_bridgeSetGhost(null);
    B.a = sel; B.b = null; B.plan = null;
    NSO_bridgeDrawPicks();
    NSO_bridgeReadout('From the ' + sel.target.text + ' - click another place; orbit first if you like. Esc clears it.', false);
    NSO_bridgeSyncRows();
    return;
  }
  B.b = sel;
  NSO_bridgeDrawLine(null);
  NSO_bridgeDrawPicks();
  NSO_bridgePreview();
}

if (typeof document !== 'undefined') {
  (function wireBridge() {
    function onCanvas(ev) { return state.renderer && ev.target === state.renderer.domElement; }
    function onMove(ev) {
      var B = NSO_bridgeUI();
      if (!B.open || B.busy || typeof NSO_Bridge === 'undefined') return;
      var pr = B.press;
      if (pr && ev.pointerId === pr.id && Math.hypot(ev.clientX - pr.x, ev.clientY - pr.y) > BRIDGE_CLICK_PX) pr.moved = true;
      if (!onCanvas(ev)) return;
      NSO_bridgeHoverAt(ev);
    }
    // A press only starts a click. One that lands on a piece is ours (it must
    // not also select or drag the piece); one on empty space is left alone, so
    // the view still orbits. Nothing is captured: the camera is free.
    function onDown(ev) {
      var B = NSO_bridgeUI();
      if (B.press && ev.pointerId !== B.press.id) { B.press.multi = true; return; }   // a second finger: a pinch, not a click
      B.press = null;
      if (!B.open || B.busy || ev.button !== 0 || !onCanvas(ev) || typeof NSO_Bridge === 'undefined') return;
      var sel = null;
      try { sel = NSO_bridgeTargetAt(ev); } catch (err) { sel = null; }
      B.press = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: false, multi: false, onTarget: !!sel };
      if (!sel) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
    function onUp(ev) {
      var B = NSO_bridgeUI(), pr = B.press;
      if (!pr || ev.pointerId !== pr.id) return;
      B.press = null;
      if (pr.onTarget) ev.stopImmediatePropagation();          // its press was ours, so is its release
      if (!B.open || B.busy || ev.button !== 0 || pr.moved || pr.multi || !onCanvas(ev) || typeof NSO_Bridge === 'undefined') return;
      if (Math.hypot(ev.clientX - pr.x, ev.clientY - pr.y) > BRIDGE_CLICK_PX) return;
      NSO_bridgeClick(ev);
    }
    function onCancel() { NSO_bridgeUI().press = null; }
    function onKey(ev) {
      var B = NSO_bridgeUI();
      if (!B.open || ev.key !== 'Escape' || !B.a) return;
      NSO_bridgeClearPicks();
      NSO_bridgeReadout(NSO_BRIDGE_HINT, false);
    }
    function wire() {
      var btn = NSO_bridgeEl('btn-bridge');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () { if (NSO_bridgeUI().open) NSO_bridgeClose(); else NSO_bridgeOpen(); });
      var go = NSO_bridgeEl('btn-bridge-go'), cancel = NSO_bridgeEl('btn-bridge-cancel');
      if (go) go.addEventListener('click', function () { NSO_bridgeSet(); });
      if (cancel) cancel.addEventListener('click', NSO_bridgeCancel);
      ['inp-bridge-dia', 'inp-bridge-thick'].forEach(function (id) {
        var el = NSO_bridgeEl(id);
        if (el) el.addEventListener('change', function () { if (NSO_bridgeUI().a && NSO_bridgeUI().b) NSO_bridgePreview(); });
      });
      // Capture on window: ahead of app-core's canvas handler, so a press on a
      // piece does not also select or drag it. Empty space falls through.
      window.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onCancel, true);
      window.addEventListener('keydown', onKey, true);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
