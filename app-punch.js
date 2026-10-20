// ===================== Punch: the card =====================
// The geometry is nso_punch.js (headless, tools/nso_punch_test.js); this file
// is the card on it, in SUBTRACT, under Carve. docs/PUNCH.md.
//
// Punch arms the card. A click on a face of a piece places the hole there,
// normal to the face; the card's numbers shape it:
//   Ø        the hole (default 3.0)
//   Depth    Through, or mm (a field appears)
//   Pattern  None · Grid · Radial
//     Grid   Rows, Cols, Pitch (one field; × splits it into X and Y), Anchor
//            Corner | Centre - the click is the grid's first hole or its middle
//     Radial Count, Radius - on a circle about the click, the first along u
// and PUNCH or Cancel.
//
// While the card is open:
//   - a GHOST of every hole sits in the piece, drawn through it: the very
//     cutter PUNCH subtracts, amber, its entry ring on the surface. A hole the
//     pattern lays off the face is drawn grey, where it would have been, and
//     counted in the readout. A refusal draws the holes it would have made in
//     red and says why; PUNCH is off;
//   - HANDLES (the neck's pattern, app-tube-edge.js): the first hole's RING is
//     Ø - drag it out or in; the ANCHOR (the hole at the click, or the cross
//     there when no hole is) drags across the face, on the face; for Grid the
//     FAR-CORNER hole is the pitch, for Radial any hole is the radius. Steps of
//     0.5 mm, 0.1 with Shift. The arrows nudge the anchor 1 mm along the face
//     (0.1 with Shift), the way the arrow points on screen. Escape puts a drag
//     back; with none it disarms. Hover lights the handle and names its value.
//     A press on a handle is taken at the window, ahead of app-core and
//     OrbitControls, so a handle's drag never orbits; a press on bare plate is
//     never taken, so the view still orbits while Punch is armed
//     (tools/nso_pick_release_test.js).
//
// PUNCH subtracts every hole in ONE boolean (NSO_subtractSoups, so a big
// piece goes to the boolean worker, docs/BOOLEAN-WORKER.md) and commits
// through the sculpt commit, undo type 'punchReplace': one Undo puts the piece
// back. If it runs longer than 300 ms the #226 bar sweeps under the readout
// (NSO_BoolBusy). The card stays armed for the next face; the fields stay.
//
// PAINT SCOPE: WHOLE-PIECE. Per the scoping rule in docs/HANDOFF.md: a hole
// runs through as many faces as it meets on its way, curved ones too, and
// paint names its faces by axis and side - so any paint stands it down,
// naming the count: nsoMaskCount(m) is the whole test.

var PUNCH_GHOST_COLOR = 0xf59e0b;       // Bend's ghost
var PUNCH_RING_COLOR = 0xffc83d;        // Bend's marker frame
var PUNCH_HANDLE_COLOR = 0xff8a3d;      // the pitch / radius holes, told from the rest
var PUNCH_DROP_COLOR = 0x94a3b8;        // a hole that fell off the face
var PUNCH_BAD_COLOR = 0xf87171;         // the holes a refusal would have made
var PUNCH_HOT_COLOR = 0xffffff;         // the handle under the pointer, or in hand
var PUNCH_RENDER_ORDER = 20;
var PUNCH_STEP_MM = 0.5;                // a drag's step
var PUNCH_KEY_MM = 1;                   // an arrow key
var PUNCH_FINE_MM = 0.1;                // either, with Shift
var PUNCH_HIT_PX = 8;                   // how near a ring the pointer must be to take it
var PUNCH_BAR_MS = 300;                 // a PUNCH this slow shows the bar

function NSO_punchUI() {
  if (typeof state === 'undefined') return {};
  if (!state.punch) {
    state.punch = { open: false, modelId: null, soup: null, hit: null, plan: null, key: '', ghost: null,
                    raf: 0, drag: null, hover: null, said: null, busy: false };
  }
  return state.punch;
}
function NSO_punchEl(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
function NSO_punchModel() {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  return (m && m.rawTris && m.rawAxis === 'zup') ? m : null;
}
function NSO_punchMeshOf(m) {
  if (!m || typeof state === 'undefined') return null;
  var p = (state.placed || []).find(function (q) { return q && q.sourceId === m.id && q.mesh; });
  return p ? p.mesh : null;
}
// Raw (z up) <-> the piece's display frame: (x, z, -y) - centerOffset.
function NSO_punchRawToDisplay(m, p) {
  var o = m.centerOffset || { x: 0, y: 0, z: 0 };
  return [p[0] - o.x, p[2] - o.y, -p[1] - o.z];
}
function NSO_punchDisplayToRaw(m, d) {
  var o = m.centerOffset || { x: 0, y: 0, z: 0 };
  return [d.x + o.x, -(d.z + o.z), d.y + o.y];
}
function NSO_punchFmt(v) { return (Math.round(v * 10) / 10).toFixed(1); }

/* ---------------------------------------------------------------- the card */

function NSO_punchPattern() {
  var on = document.querySelector('#punch-pattern-row .btn[aria-pressed="true"]');
  return on ? on.getAttribute('data-pattern') : 'none';
}
function NSO_punchAnchor() {
  var on = document.querySelector('#punch-anchor-row .btn[aria-pressed="true"]');
  return on ? on.getAttribute('data-anchor') : 'corner';
}
function NSO_punchSplit() {
  var b = NSO_punchEl('btn-punch-pitch-xy');
  return !!(b && b.getAttribute('aria-pressed') === 'true');
}
/* The card's numbers as NSO_Punch.plan opts. */
function NSO_punchOpts() {
  function num(id) { var el = NSO_punchEl(id); return el && el.value !== '' ? +el.value : NaN; }
  var depthSel = NSO_punchEl('sel-punch-depth');
  var o = { diaMm: num('inp-punch-dia'), depth: depthSel && depthSel.value === 'mm' ? num('inp-punch-depth') : 'through',
            pattern: NSO_punchPattern() };
  if (o.pattern === 'grid') {
    var px = num('inp-punch-pitch');
    o.rows = num('inp-punch-rows'); o.cols = num('inp-punch-cols');
    o.pitchX = px; o.pitchY = NSO_punchSplit() ? num('inp-punch-pitch-y') : px;
    o.anchor = NSO_punchAnchor();
  } else if (o.pattern === 'radial') {
    o.n = num('inp-punch-count'); o.R = num('inp-punch-radius');
  }
  return o;
}
function NSO_punchSyncRows() {
  var pat = NSO_punchPattern(), split = NSO_punchSplit();
  var g = NSO_punchEl('punch-grid-rows'), r = NSO_punchEl('punch-radial-rows');
  if (g) g.hidden = pat !== 'grid';
  if (r) r.hidden = pat !== 'radial';
  var py = NSO_punchEl('punch-pitch-y-row'), dm = NSO_punchEl('punch-depth-mm-row'), ds = NSO_punchEl('sel-punch-depth');
  if (py) py.hidden = !split;
  var lab = NSO_punchEl('punch-pitch-label');
  if (lab) lab.textContent = split ? 'Pitch X' : 'Pitch';
  if (dm) dm.hidden = !(ds && ds.value === 'mm');
}
function NSO_punchPress(rowId, btn) {
  document.querySelectorAll('#' + rowId + ' .btn').forEach(function (b) { b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
}

function NSO_punchReadout(text, bad) {
  var el = NSO_punchEl('punch-readout');
  if (el) { el.textContent = text; el.classList.toggle('is-bad', !!bad); }
  NSO_punchUI().said = { text: text, bad: !!bad };
}
function NSO_punchSyncButtons() {
  var B = NSO_punchUI(), go = NSO_punchEl('btn-punch-go');
  if (go) go.disabled = !!B.busy || !(B.plan && B.plan.ok);
}

/* --------------------------------------------------------------- the plan */

// Run the engine on the current click and numbers; draw the ghost, say what it is.
function NSO_punchPreview() {
  var B = NSO_punchUI(), m = NSO_punchModel();
  if (!B.open) return null;
  if (!m || !B.hit || B.modelId !== m.id) {
    B.plan = null; B.key = '';
    NSO_punchClearGhost();
    NSO_punchReadout(m ? 'Click a face of the piece to place the hole.' : 'Click a face of a piece to place the hole.');
    NSO_punchSyncButtons();
    return null;
  }
  var o = NSO_punchOpts(), key = m.id + '|' + JSON.stringify(B.hit) + '|' + JSON.stringify(o);
  if (B.key === key && B.soup === m.rawTris && B.plan) { NSO_punchSyncButtons(); return B.plan; }
  var pl;
  try { pl = NSO_Punch.plan(m.rawTris, B.hit, o); }
  catch (err) { pl = { ok: false, holes: [], reason: (err && err.message) || String(err) }; }
  B.plan = pl; B.key = key; B.soup = m.rawTris;
  NSO_punchDraw(m);
  if (pl.ok) NSO_punchReadout(pl.dropped ? pl.reason + ' · the grey ' + (pl.dropped === 1 ? 'one is' : 'ones are') + ' dropped' : pl.reason);
  else NSO_punchReadout('Punch: ' + pl.reason, true);
  NSO_punchSyncButtons();
  return pl;
}

/* ---------------------------------------------------------------- drawing */

function NSO_punchClearGhost() {
  var B = NSO_punchUI();
  if (!B.ghost) return;
  if (B.ghost.parent) B.ghost.parent.remove(B.ghost);
  B.ghost.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  B.ghost = null;
}
// The holes a ghost draws: kept, or the ones a refusal would have made.
function NSO_punchHoles(pl) { return pl ? (pl.ok ? pl.holes : (pl.wouldBe || [])) : []; }
// Which hole is which handle: 'dia' the first's ring, 'pitch' / 'radius' the
// pattern's own, 'anchor' the hole at the click.
function NSO_punchRoleOf(H, idx, o) {
  if (o.pattern === 'grid' && o.rows * o.cols > 1 && H.n === o.rows * o.cols) return 'pitch';
  if (o.pattern === 'radial') return 'radius';
  if (H.n === 1 && (o.pattern === 'none' || o.anchor !== 'centre')) return 'anchor';
  return null;
}
function NSO_punchFrame(a) {
  var e1 = Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [-a[2], 0, a[0]], L = Math.hypot(e1[0], e1[1], e1[2]);
  e1 = [e1[0] / L, e1[1] / L, e1[2] / L];
  return [e1, [a[1] * e1[2] - a[2] * e1[1], a[2] * e1[0] - a[0] * e1[2], a[0] * e1[1] - a[1] * e1[0]]];
}
function NSO_punchCircle(c, a, r, n) {
  var f = NSO_punchFrame(a), pts = [];
  for (var i = 0; i < n; i++) {
    var t = 2 * Math.PI * i / n, cs = Math.cos(t) * r, sn = Math.sin(t) * r;
    pts.push([c[0] + cs * f[0][0] + sn * f[1][0], c[1] + cs * f[0][1] + sn * f[1][1], c[2] + cs * f[0][2] + sn * f[1][2]]);
  }
  return pts;
}
function NSO_punchLine(m, pts, color, loop, tag) {
  var geo = new THREE.BufferGeometry(), flat = [];
  pts.forEach(function (p) { var d = NSO_punchRawToDisplay(m, p); flat.push(d[0], d[1], d[2]); });
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(flat), 3));
  var L = new (loop ? THREE.LineLoop : THREE.LineSegments)(geo, new THREE.LineBasicMaterial({ color: color, transparent: true, depthTest: false, depthWrite: false }));
  L.renderOrder = PUNCH_RENDER_ORDER + 1; L.userData.skipXray = true; L.raycast = function () {}; L.frustumCulled = false;
  if (tag) { L.userData.punchHandle = tag; L.userData.punchColor = color; }
  return L;
}
function NSO_punchDraw(m) {
  NSO_punchClearGhost();
  var B = NSO_punchUI(), pl = B.plan;
  if (typeof THREE === 'undefined' || !state.scene || !pl || !B.hit) return;
  var o = NSO_punchOpts(), hot = B.drag ? B.drag.handle : B.hover;
  var group = new THREE.Group();
  group.name = 'punchGhost';
  group.matrixAutoUpdate = false;
  var holes = NSO_punchHoles(pl), cut = NSO_Punch.cutters({ holes: holes });
  holes.forEach(function (H, i) {
    var soup = cut[i], flat = new Float32Array(soup.length);
    for (var k = 0; k < soup.length; k += 3) {
      var d = NSO_punchRawToDisplay(m, [soup[k], soup[k + 1], soup[k + 2]]);
      flat[k] = d[0]; flat[k + 1] = d[1]; flat[k + 2] = d[2];
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(flat, 3));
    geo.computeVertexNormals();
    var g = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: pl.ok ? PUNCH_GHOST_COLOR : PUNCH_BAD_COLOR, transparent: true,
      opacity: 0.4, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    g.renderOrder = PUNCH_RENDER_ORDER; g.userData.skipXray = true; g.userData.punchHole = H.n; g.raycast = function () {};
    g.frustumCulled = false;
    group.add(g);
    var role = NSO_punchRoleOf(H, i, o), col = !pl.ok ? PUNCH_BAD_COLOR : (role === 'pitch' || role === 'radius') ? PUNCH_HANDLE_COLOR : PUNCH_RING_COLOR;
    var ringTag = i === 0 ? 'dia' : null;
    var ring = NSO_punchLine(m, NSO_punchCircle(H.centre, H.axis, H.dia / 2, 64), hot === ringTag && ringTag ? PUNCH_HOT_COLOR : col, true, ringTag);
    group.add(ring);
  });
  (pl.droppedAt || []).forEach(function (D) {
    var ring = NSO_punchLine(m, NSO_punchCircle(D.point, D.axis, o.diaMm / 2, 48), PUNCH_DROP_COLOR, true, null);
    ring.userData.punchDropped = D.n;
    group.add(ring);
  });
  // the anchor: a cross at the click, along the face's u and v
  var F = pl.frame;
  if (F) {
    var s = Math.max(1.5, (o.diaMm || 3) * 0.35), c = F.o;
    var cr = [[c[0] - s * F.u[0], c[1] - s * F.u[1], c[2] - s * F.u[2]], [c[0] + s * F.u[0], c[1] + s * F.u[1], c[2] + s * F.u[2]],
              [c[0] - s * F.v[0], c[1] - s * F.v[1], c[2] - s * F.v[2]], [c[0] + s * F.v[0], c[1] + s * F.v[1], c[2] + s * F.v[2]]];
    group.add(NSO_punchLine(m, cr, hot === 'anchor' ? PUNCH_HOT_COLOR : PUNCH_RING_COLOR, false, 'anchor'));
  }
  if (typeof nsoHelpers !== 'undefined') nsoHelpers.attach(state.scene, group, 'punch'); else state.scene.add(group);
  B.ghost = group;
  NSO_punchFollow();
}
function NSO_punchFollow() {
  var B = NSO_punchUI(), m = NSO_punchModel(), mesh = m && NSO_punchMeshOf(m);
  if (!mesh || !B.ghost) return;
  mesh.updateMatrixWorld(true);
  B.ghost.matrix.copy(mesh.matrixWorld);
  B.ghost.matrixWorldNeedsUpdate = true;
}
function NSO_punchLight(handle) {
  var B = NSO_punchUI();
  if (!B.ghost) return;
  B.ghost.children.forEach(function (o) {
    if (o.userData.punchHandle) o.material.color.setHex(o.userData.punchHandle === handle ? PUNCH_HOT_COLOR : o.userData.punchColor);
  });
}

/* ------------------------------------------------------------ the pointer */

// The pointer's ray in the piece's raw frame: { o, d }, d a unit vector.
function NSO_punchRawRay(m, clientX, clientY) {
  var mesh = NSO_punchMeshOf(m);
  if (!mesh || !state.raycaster || !state.camera || !state.renderer) return null;
  setPointerFromEvent({ clientX: clientX, clientY: clientY });
  state.raycaster.setFromCamera(state.pointer, state.camera);
  mesh.updateMatrixWorld(true);
  var inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  var o = state.raycaster.ray.origin.clone().applyMatrix4(inv);
  var p = state.raycaster.ray.origin.clone().add(state.raycaster.ray.direction).applyMatrix4(inv).sub(o);
  var O = NSO_punchDisplayToRaw(m, o), d = [p.x, -p.z, p.y], n = Math.hypot(d[0], d[1], d[2]);
  return n > 0 ? { o: O, d: [d[0] / n, d[1] / n, d[2] / n] } : null;
}
// A raw point on the screen, in client pixels.
function NSO_punchScreen(m, raw) {
  var mesh = NSO_punchMeshOf(m);
  var v = new THREE.Vector3().fromArray(NSO_punchRawToDisplay(m, raw)).applyMatrix4(mesh.matrixWorld).project(state.camera);
  var r = state.renderer.domElement.getBoundingClientRect();
  return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height, z: v.z };
}
// Where a ray meets the plane through `at` square to `n`: the raw point, or null.
function NSO_punchOnPlane(ray, at, n) {
  var dn = ray.d[0] * n[0] + ray.d[1] * n[1] + ray.d[2] * n[2];
  if (Math.abs(dn) < 1e-6) return null;
  var t = ((at[0] - ray.o[0]) * n[0] + (at[1] - ray.o[1]) * n[1] + (at[2] - ray.o[2]) * n[2]) / dn;
  return [ray.o[0] + t * ray.d[0], ray.o[1] + t * ray.d[1], ray.o[2] + t * ray.d[2]];
}

/* The piece under (x, y), its point and face normal in the piece's raw frame.
   A press on another piece selects it first. */
function NSO_punchPick(clientX, clientY) {
  if (!state.renderer || !state.camera || !state.modelGroup) return null;
  setPointerFromEvent({ clientX: clientX, clientY: clientY });
  state.raycaster.setFromCamera(state.pointer, state.camera);
  var hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
  for (var i = 0; i < hits.length; i++) {
    if (!hits[i].face) continue;
    var obj = hits[i].object;
    while (obj && (!obj.userData || obj.userData.placedIndex == null) && obj.parent) obj = obj.parent;
    var idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
    if (typeof idx !== 'number' || !state.placed[idx] || state.placed[idx].sourceId == null) continue;
    var mesh = state.placed[idx].mesh;
    mesh.updateMatrixWorld(true);
    var local = hits[i].point.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
    var n = hits[i].face.normal;
    return { index: idx, sourceId: state.placed[idx].sourceId, local: local, normal: [n.x, -n.z, n.y] };
  }
  return null;
}
// Place the hole at (x, y): false when the press is not on a piece.
function NSO_punchPlaceAt(clientX, clientY) {
  var B = NSO_punchUI(), t = NSO_punchPick(clientX, clientY);
  if (!t) return false;
  var m = NSO_punchModel();
  if (!m || m.id !== t.sourceId) {
    if (typeof selectPlaced === 'function') selectPlaced(t.index);
    m = NSO_punchModel();
  }
  if (!m || m.id !== t.sourceId) { NSO_punchReadout('Punch: that piece cannot be read here.', true); return true; }
  if (typeof NSO_bendFrameMatches === 'function' && !NSO_bendFrameMatches(m)) {
    B.hit = null; B.modelId = m.id; NSO_punchClearGhost();
    NSO_punchReadout('Punch: the piece was turned since it was loaded - bake its pose first, then punch.', true);
    NSO_punchSyncButtons();
    return true;
  }
  B.modelId = m.id;
  B.hit = { point: NSO_punchDisplayToRaw(m, t.local), normal: t.normal };
  NSO_punchPreview();
  return true;
}

/* What is under the pointer: 'dia' (the first hole's ring), 'anchor' (the
   cross, or the hole at the click), 'pitch' (the grid's far corner), 'radius'
   (a radial hole), or null - with the hole it is on. */
function NSO_punchHitAt(clientX, clientY) {
  var B = NSO_punchUI(), m = NSO_punchModel(), pl = B.plan;
  if (!B.open || !m || !pl || !B.ghost || !NSO_punchMeshOf(m) || B.modelId !== m.id) return null;
  var o = NSO_punchOpts(), holes = NSO_punchHoles(pl);
  function segD(a, b) {
    var ex = b.x - a.x, ey = b.y - a.y, L2 = ex * ex + ey * ey;
    var t = L2 > 0 ? Math.max(0, Math.min(1, ((clientX - a.x) * ex + (clientY - a.y) * ey) / L2)) : 0;
    return Math.hypot(clientX - a.x - t * ex, clientY - a.y - t * ey);
  }
  // 1. the first hole's ring
  if (holes.length) {
    var pts = NSO_punchCircle(holes[0].centre, holes[0].axis, holes[0].dia / 2, 48).map(function (p) { return NSO_punchScreen(m, p); });
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      if (a.z < 1 && b.z < 1 && segD(a, b) <= PUNCH_HIT_PX) return { handle: 'dia', hole: holes[0] };
    }
  }
  // 2. the anchor's cross
  if (pl.frame) {
    var c = NSO_punchScreen(m, pl.frame.o);
    if (c.z < 1 && Math.hypot(clientX - c.x, clientY - c.y) <= PUNCH_HIT_PX * 1.5) return { handle: 'anchor', hole: null };
  }
  // 3. inside a hole's ring, on screen: the hole's own role
  var best = null, bd = Infinity;
  holes.forEach(function (H, k) {
    var role = NSO_punchRoleOf(H, k, o);
    if (!role) return;
    var cs = NSO_punchScreen(m, H.centre);
    var ring = NSO_punchCircle(H.centre, H.axis, H.dia / 2, 16).map(function (p) { return NSO_punchScreen(m, p); });
    var rr = 0;
    ring.forEach(function (q) { rr = Math.max(rr, Math.hypot(q.x - cs.x, q.y - cs.y)); });
    var d = Math.hypot(clientX - cs.x, clientY - cs.y);
    if (cs.z < 1 && d <= Math.max(rr, PUNCH_HIT_PX) && d < bd) { bd = d; best = { handle: role, hole: H }; }
  });
  return best;
}

/* ------------------------------------------------------------ the handles */

function NSO_punchSnap(d, fine) { var st = fine ? PUNCH_FINE_MM : PUNCH_STEP_MM; return Math.round(d / st) * st; }
function NSO_punchSetField(id, v) { var el = NSO_punchEl(id); if (el) el.value = NSO_punchFmt(v); }
// A handle's value, in words.
function NSO_punchHandleText(handle) {
  var o = NSO_punchOpts();
  if (handle === 'dia') return 'Ø ' + NSO_punchFmt(o.diaMm) + ' mm';
  if (handle === 'pitch') return 'Pitch ' + NSO_punchFmt(o.pitchX) + (NSO_punchSplit() ? ' × ' + NSO_punchFmt(o.pitchY) : '') + ' mm';
  if (handle === 'radius') return 'Radius ' + NSO_punchFmt(o.R) + ' mm';
  if (handle === 'anchor') return 'Anchor - drag it across the face';
  return '';
}
function NSO_punchSayHandle(handle) {
  var B = NSO_punchUI(), last = B.said || { text: '—', bad: false }, t = NSO_punchHandleText(handle), el = NSO_punchEl('punch-readout');
  if (el) { el.textContent = t ? t + ' · ' + last.text : last.text; el.classList.toggle('is-bad', !!last.bad); }
}
function NSO_punchHover(handle) {
  var B = NSO_punchUI();
  if (B.hover === handle) return;
  B.hover = handle;
  NSO_punchLight(handle);
  var cv = state.renderer && state.renderer.domElement;
  if (cv) cv.classList.toggle('punch-cur-grab', !!handle);
  if (handle) NSO_punchSayHandle(handle);
  else if (B.said) NSO_punchReadout(B.said.text, B.said.bad);
}

// A press on a handle: what the drag is read against, fixed at the press.
function NSO_punchDragBegin(hit, ev) {
  var B = NSO_punchUI(), m = NSO_punchModel(), pl = B.plan, ray = m && NSO_punchRawRay(m, ev.clientX, ev.clientY);
  if (!ray || !pl || !pl.frame) return false;
  var o = NSO_punchOpts(), F = pl.frame, D = { handle: hit.handle, x0: ev.clientX, y0: ev.clientY, last: '',
    undo: { hit: JSON.parse(JSON.stringify(B.hit)), fields: NSO_punchFieldsNow() } };
  if (hit.handle === 'dia') {
    var H = hit.hole, q = NSO_punchOnPlane(ray, H.centre, H.axis);
    if (!q) return false;
    D.centre = H.centre; D.axis = H.axis; D.dia0 = o.diaMm; D.r0 = NSO_punchOffAxis(q, H.centre, H.axis);
  } else {
    var q2 = NSO_punchOnPlane(ray, F.o, F.n);
    if (!q2) return false;
    D.frame = F; D.at0 = NSO_punchUV(q2, F); D.hit0 = JSON.parse(JSON.stringify(B.hit)); D.o = o;
    if (hit.handle === 'pitch') {
      var k = o.anchor === 'centre' ? 0.5 : 1;
      D.far0 = [k * (o.cols - 1) * o.pitchX, k * (o.rows - 1) * o.pitchY]; D.k = k;
    } else if (hit.handle === 'radius') {
      var hv = NSO_punchUV(hit.hole.centre, F);
      D.dir = Math.hypot(hv[0], hv[1]) > 1e-9 ? [hv[0] / Math.hypot(hv[0], hv[1]), hv[1] / Math.hypot(hv[0], hv[1])] : [1, 0];
      D.R0 = o.R;
    }
  }
  B.drag = D;
  if (state.controls) state.controls.enabled = false;
  NSO_punchLight(hit.handle);
  NSO_punchSayHandle(hit.handle);
  return true;
}
function NSO_punchOffAxis(q, c, a) {
  var w = [q[0] - c[0], q[1] - c[1], q[2] - c[2]], t = w[0] * a[0] + w[1] * a[1] + w[2] * a[2];
  return Math.hypot(w[0] - t * a[0], w[1] - t * a[1], w[2] - t * a[2]);
}
function NSO_punchUV(q, F) {
  var w = [q[0] - F.o[0], q[1] - F.o[1], q[2] - F.o[2]];
  return [w[0] * F.u[0] + w[1] * F.u[1] + w[2] * F.u[2], w[0] * F.v[0] + w[1] * F.v[1] + w[2] * F.v[2]];
}
function NSO_punchFieldsNow() {
  var out = {};
  ['inp-punch-dia', 'inp-punch-pitch', 'inp-punch-pitch-y', 'inp-punch-radius'].forEach(function (id) { var el = NSO_punchEl(id); if (el) out[id] = el.value; });
  return out;
}
function NSO_punchDragMove(ev) {
  var B = NSO_punchUI(), D = B.drag, m = NSO_punchModel();
  if (!D || !m) return;
  var ray = NSO_punchRawRay(m, ev.clientX, ev.clientY), fine = !!ev.shiftKey;
  if (!ray) return;
  var key;
  if (D.handle === 'dia') {
    var q = NSO_punchOnPlane(ray, D.centre, D.axis);
    if (!q) return;
    var dia = Math.max(PUNCH_FINE_MM, Math.round((D.dia0 + NSO_punchSnap(2 * (NSO_punchOffAxis(q, D.centre, D.axis) - D.r0), fine)) * 10) / 10);
    key = 'd' + dia;
    if (key !== D.last) { D.last = key; NSO_punchSetField('inp-punch-dia', dia); NSO_punchPreview(); }
  } else {
    var q2 = NSO_punchOnPlane(ray, D.frame.o, D.frame.n);
    if (!q2) return;
    var uv = NSO_punchUV(q2, D.frame), du = uv[0] - D.at0[0], dv = uv[1] - D.at0[1];
    if (D.handle === 'anchor') {
      var sx = NSO_punchSnap(du, fine), sy = NSO_punchSnap(dv, fine);
      key = 'a' + sx + ',' + sy;
      if (key !== D.last) {
        D.last = key;
        var s = NSO_Punch.slide(m.rawTris, D.hit0, sx, sy, D.o);
        if (s.ok) { B.hit = { point: s.point, normal: s.normal }; NSO_punchPreview(); }
      }
    } else if (D.handle === 'pitch') {
      var fx = D.far0[0] + du, fy = D.far0[1] + dv, o = D.o, px, py;
      if (NSO_punchSplit()) {
        px = o.cols > 1 ? fx / (D.k * (o.cols - 1)) : o.pitchX;
        py = o.rows > 1 ? fy / (D.k * (o.rows - 1)) : o.pitchY;
      } else {
        var a = o.cols - 1, b = o.rows - 1;
        px = py = (fx * a + fy * b) / (D.k * (a * a + b * b));
      }
      px = Math.max(PUNCH_FINE_MM, NSO_punchSnap(px, fine)); py = Math.max(PUNCH_FINE_MM, NSO_punchSnap(py, fine));
      key = 'p' + px + ',' + py;
      if (key !== D.last) {
        D.last = key;
        NSO_punchSetField('inp-punch-pitch', px);
        if (NSO_punchSplit()) NSO_punchSetField('inp-punch-pitch-y', py);
        NSO_punchPreview();
      }
    } else if (D.handle === 'radius') {
      var R = Math.max(PUNCH_FINE_MM, NSO_punchSnap(D.R0 + du * D.dir[0] + dv * D.dir[1], fine));
      key = 'r' + R;
      if (key !== D.last) { D.last = key; NSO_punchSetField('inp-punch-radius', R); NSO_punchPreview(); }
    }
  }
  NSO_punchSayHandle(D.handle);
}
// End a drag: kept (a release), or put back where it began (Escape, the card going away).
function NSO_punchDragEnd(keep) {
  var B = NSO_punchUI(), D = B.drag;
  if (!D) return;
  B.drag = null;
  if (state.controls) state.controls.enabled = true;
  if (!keep) {
    B.hit = D.undo.hit;
    Object.keys(D.undo.fields).forEach(function (id) { var el = NSO_punchEl(id); if (el) el.value = D.undo.fields[id]; });
  }
  B.key = '';
  B.hover = null;
  NSO_punchPreview();
  var cv = state.renderer && state.renderer.domElement;
  if (cv) cv.classList.remove('punch-cur-grab');
}

// One arrow key: nudge the anchor along the face, the way the arrow points on screen.
function NSO_punchNudge(key, fine) {
  var B = NSO_punchUI(), m = NSO_punchModel(), pl = B.plan;
  if (!m || !pl || !pl.frame || !B.hit) return false;
  var F = pl.frame, st = fine ? PUNCH_FINE_MM : PUNCH_KEY_MM;
  var want = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[key];
  var c = NSO_punchScreen(m, F.o), best = null, bd = -Infinity;
  [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
    var p = [F.o[0] + d[0] * F.u[0] + d[1] * F.v[0], F.o[1] + d[0] * F.u[1] + d[1] * F.v[1], F.o[2] + d[0] * F.u[2] + d[1] * F.v[2]];
    var s = NSO_punchScreen(m, p), sx = s.x - c.x, sy = s.y - c.y, L = Math.hypot(sx, sy);
    var score = L > 1e-6 ? (sx * want[0] + sy * want[1]) / L : -1;
    if (score > bd) { bd = score; best = d; }
  });
  var s2 = NSO_Punch.slide(m.rawTris, B.hit, best[0] * st, best[1] * st, NSO_punchOpts());
  if (!s2.ok) { NSO_punchReadout('Punch: the anchor stops at the edge of the face.', true); return true; }
  B.hit = { point: s2.point, normal: s2.normal };
  NSO_punchPreview();
  NSO_punchSayHandle('anchor');
  return true;
}

/* --------------------------------------------------------------- PUNCH */

// PAINT SCOPE: WHOLE-PIECE - see the header and docs/HANDOFF.md.
async function NSO_punchGo() {
  var B = NSO_punchUI(), m = NSO_punchModel();
  if (B.busy) return { ok: false, reason: 'busy' };
  function refuse(why) {
    if (typeof setStatus === 'function') setStatus('Punch refused - piece unchanged (' + why + ')', true);
    NSO_punchReadout('Punch: ' + why, true);
    return { ok: false, reason: why };
  }
  if (!m) return refuse('select a piece and click a face first');
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    if (typeof setStatus === 'function') {
      setStatus('Punch stood down - ' + painted + ' painted face(s); a hole runs through every face it meets. Clear paint to punch.', true);
    }
    return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
  }
  var pl = NSO_punchPreview();
  if (!pl) return refuse('click a face first');
  if (!pl.ok) return refuse(pl.reason);
  var soup0 = m.rawTris, hit = B.hit, o = NSO_punchOpts(), job = null;
  B.busy = true;
  NSO_punchSyncButtons();
  NSO_punchReadout('Punching…');
  var bar = setTimeout(function () {
    if (B.busy && typeof NSO_BoolBusy !== 'undefined') job = NSO_BoolBusy.begin('Punching', 'punch-readout');
  }, PUNCH_BAR_MS);
  try {
    // Work as is (nso-helpers.js, nsoOverlap): overlapping shells are merged for the boolean
    var sol = (typeof nsoOverlap !== 'undefined' && nsoOverlap) ? await nsoOverlap.solid(m, null, 'punch-readout') : { ok: true, merged: false };
    if (!sol.ok) return refuse(sol.cancelled ? 'stopped' : sol.reason);
    var soup = sol.merged ? sol.soup : soup0;
    if (sol.merged) {
      pl = NSO_Punch.plan(soup, hit, o);
      if (!pl.ok) return refuse(pl.reason);
    }
    var cut = NSO_Punch.cutters(pl), tool;
    if (cut.length > 1 && NSO_Punch.cuttersOverlap(pl)) {
      // cutters that meet in air are one solid first, so the kernel is handed a closed tool
      tool = cut[0];
      for (var i = 1; i < cut.length; i++) {
        var u = await NSO_unionSoups(tool, cut[i], { label: 'Punching', host: 'punch-readout' });
        if (!u || !u.ok) return refuse((u && u.reason) || 'the cutters would not join');
        tool = u.soup;
      }
    } else {
      var n = 0;
      cut.forEach(function (c) { n += c.length; });
      tool = new Float32Array(n);
      n = 0;
      cut.forEach(function (c) { tool.set(c, n); n += c.length; });
    }
    var res = await NSO_subtractSoups(soup, tool, { label: 'Punching', host: 'punch-readout' });
    if (!res || !res.ok || !res.soup || res.soup.length < 9) {
      return refuse(res && res.cancelled ? 'stopped' : res && res.timedOut ? 'it ran too long and was stopped' : (res && res.reason) || 'the boolean returned nothing');
    }
    if (NSO_punchModel() !== m || m.rawTris !== soup0) return refuse('the piece changed while it was punched');
    var txt = 'Punch done - ' + pl.reason + (sol.merged ? ' - ' + sol.note : '');
    if (!NSO_sculptCommitRaw(m, res.soup, 'punchReplace', txt)) return refuse('the result could not be committed');
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    // armed for the next face: the click goes, the numbers stay
    B.hit = null; B.plan = null; B.key = '';
    NSO_punchClearGhost();
    NSO_punchReadout('Punched ' + pl.holes.length + (pl.holes.length === 1 ? ' hole' : ' holes') + ' - click the next face.');
    return { ok: true, holes: pl.holes.length, plan: pl };
  } catch (err) {
    console.error('[punch]', err);
    return refuse((err && err.message) || String(err));
  } finally {
    clearTimeout(bar);
    if (job) job.end();
    B.busy = false;
    NSO_punchSyncButtons();
  }
}

/* -------------------------------------------------------------- open, close */

function NSO_punchOpen() {
  var B = NSO_punchUI(), card = NSO_punchEl('punch-card'), btn = NSO_punchEl('btn-punch');
  // one click-owning tool at a time: Carve takes a press on a piece too
  if (state.carveArmed) { var cb = NSO_punchEl('btn-carve'); if (cb) cb.click(); }
  B.open = true; B.hit = null; B.plan = null; B.key = '';
  B.modelId = (NSO_punchModel() || {}).id || null;
  if (card) card.hidden = false;
  if (btn) { btn.setAttribute('aria-pressed', 'true'); btn.setAttribute('aria-expanded', 'true'); btn.classList.add('is-on'); }
  NSO_punchSyncRows();
  NSO_punchPreview();
  if (typeof setStatus === 'function') setStatus('Punch armed - click a face to place the hole. Escape to stop.');
  NSO_punchTick();
}
function NSO_punchClose() {
  var B = NSO_punchUI(), card = NSO_punchEl('punch-card'), btn = NSO_punchEl('btn-punch');
  if (B.drag) NSO_punchDragEnd(false);
  B.hover = null;
  B.open = false; B.hit = null; B.plan = null; B.key = '';
  if (card) card.hidden = true;
  if (btn) { btn.setAttribute('aria-pressed', 'false'); btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('is-on'); }
  NSO_punchClearGhost();
  var cv = state.renderer && state.renderer.domElement;
  if (cv) cv.classList.remove('punch-cur-grab');
  if (B.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(B.raf);
  B.raf = 0;
}

// Punch's session, for the helper registry (nso-helpers.js): leave-tool and
// Clear close it, an Undo under it re-plans it.
if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('punch', {
  live: function () { return !!NSO_punchUI().open; },
  close: NSO_punchClose,
  clear: NSO_punchClearGhost,
  refresh: function () { var B = NSO_punchUI(); B.key = ''; NSO_punchPreview(); }
});

// Per frame while open: follow the piece; start over when the selection
// changes, re-plan when its soup does (another bake, Undo).
function NSO_punchTick() {
  var B = NSO_punchUI();
  if (!B.open) return;
  // one click-owning tool at a time: Carve or Paint armed over Punch puts Punch away
  if (!B.busy && (state.carveArmed || state.maskPaint)) { NSO_punchClose(); return; }
  var m = NSO_punchModel();
  if ((m ? m.id : null) !== B.modelId) { B.modelId = m ? m.id : null; B.hit = null; NSO_punchPreview(); }
  else if (m && B.hit && m.rawTris !== B.soup && !B.busy) NSO_punchPreview();
  else NSO_punchFollow();
  B.raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(NSO_punchTick) : 0;
}

/* For the drive check: what the card shows. */
function nsoPunchState() {
  var B = NSO_punchUI(), pl = B.plan;
  var kids = B.ghost ? B.ghost.children : [];
  return {
    open: !!B.open, busy: !!B.busy, hit: B.hit, ok: !!(pl && pl.ok), reason: pl ? pl.reason : '',
    ghosts: kids.filter(function (o) { return o.userData.punchHole != null; }).length,
    dropped: kids.filter(function (o) { return o.userData.punchDropped != null; }).length,
    holes: pl ? NSO_punchHoles(pl).map(function (H) { return { n: H.n, centre: H.centre, axis: H.axis, dia: H.dia, depth: H.depth, lift: H.lift }; }) : [],
    readout: (NSO_punchEl('punch-readout') || {}).textContent || '', bad: !!(NSO_punchEl('punch-readout') || { classList: { contains: function () { return false; } } }).classList.contains('is-bad'),
    drag: B.drag ? B.drag.handle : null
  };
}
/* For the drive check: a handle's point on screen - 'dia' (the first ring at
   angle 0, or `out` mm further out), 'anchor', 'pitch' / 'radius' (that hole's centre). */
function nsoPunchHandleScreen(handle, out) {
  var B = NSO_punchUI(), m = NSO_punchModel(), pl = B.plan;
  if (!m || !pl) return null;
  var holes = NSO_punchHoles(pl), o = NSO_punchOpts();
  if (handle === 'dia') {
    var H = holes[0];
    if (!H) return null;
    var e = NSO_punchFrame(H.axis)[0], r = H.dia / 2 + (out || 0);
    return NSO_punchScreen(m, [H.centre[0] + r * e[0], H.centre[1] + r * e[1], H.centre[2] + r * e[2]]);
  }
  if (handle === 'anchor') return pl.frame ? NSO_punchScreen(m, pl.frame.o) : null;
  var hole = holes.find(function (h, k) { return NSO_punchRoleOf(h, k, o) === handle; });
  return hole ? NSO_punchScreen(m, hole.centre) : null;
}

if (typeof document !== 'undefined') {
  (function wirePunch() {
    function onDown(ev) {
      var B = NSO_punchUI();
      if (!B.open || ev.button !== 0 || !state.raycaster || !state.camera || !state.renderer) return;
      if (ev.target !== state.renderer.domElement) return;
      if (B.drag) NSO_punchDragEnd(false);
      if (B.busy) {
        if (NSO_punchPick(ev.clientX, ev.clientY)) { ev.stopImmediatePropagation(); ev.preventDefault(); }
        return;
      }
      var hit = NSO_punchHitAt(ev.clientX, ev.clientY);
      if (hit && NSO_punchDragBegin(hit, ev)) {
        // out of a field, so the arrows are the anchor's after the drag
        var f = document.activeElement, card = NSO_punchEl('punch-card');
        if (f && card && card.contains(f) && typeof f.blur === 'function') f.blur();
        ev.stopImmediatePropagation();
        ev.preventDefault();
        return;
      }
      if (!NSO_punchPlaceAt(ev.clientX, ev.clientY)) return;
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
    function onMove(ev) {
      var B = NSO_punchUI();
      if (B.drag) { NSO_punchDragMove(ev); ev.stopImmediatePropagation(); ev.preventDefault(); return; }
      if (!B.open || !state.renderer || ev.target !== state.renderer.domElement || ev.buttons) {
        if (B.hover) NSO_punchHover(null);
        return;
      }
      var h = NSO_punchHitAt(ev.clientX, ev.clientY);
      NSO_punchHover(h ? h.handle : null);
    }
    function onUp(ev) {
      var B = NSO_punchUI();
      if (!B.drag) return;
      NSO_punchDragEnd(ev.type === 'pointerup');
      ev.stopImmediatePropagation();
    }
    var KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
    function onKey(ev) {
      var B = NSO_punchUI();
      if (!B.open || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.key === 'Escape' && B.drag) {
        NSO_punchDragEnd(false);
        ev.preventDefault(); ev.stopImmediatePropagation();
        return;
      }
      var t = ev.target, text = t && ((t.tagName === 'INPUT' && t.type !== 'checkbox') || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (text || (t && t.tagName === 'SELECT' && ev.key !== 'Escape')) return;
      // a top-bar menu that owns the arrows (Rotate, Tip, Move) keeps them (app-input-mode.js)
      var IM = window.nsoInputMode, owner = IM && IM.active && IM.active();
      if (owner && IM.registered && IM.registered().indexOf(owner) >= 0) return;
      if (ev.key === 'Escape') {
        if (B.busy) return;                 // app-bool-busy.js's Escape stops the boolean
        NSO_punchClose();
        if (typeof setStatus === 'function') setStatus('Punch off');
        ev.preventDefault(); ev.stopImmediatePropagation();
        return;
      }
      var k = KEYS[ev.key];
      if (!k || B.drag || B.busy || !B.plan) return;
      NSO_punchNudge(k, ev.shiftKey);
      ev.preventDefault(); ev.stopImmediatePropagation();
    }
    function wire() {
      var btn = NSO_punchEl('btn-punch');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () { if (NSO_punchUI().open) NSO_punchClose(); else NSO_punchOpen(); });
      var go = NSO_punchEl('btn-punch-go'), cancel = NSO_punchEl('btn-punch-cancel');
      if (go) go.addEventListener('click', function () { NSO_punchGo(); });
      if (cancel) cancel.addEventListener('click', NSO_punchClose);
      [['punch-pattern-row', 'data-pattern'], ['punch-anchor-row', 'data-anchor']].forEach(function (row) {
        document.querySelectorAll('#' + row[0] + ' .btn').forEach(function (b) {
          b.addEventListener('click', function () { NSO_punchPress(row[0], b); NSO_punchSyncRows(); NSO_punchPreview(); });
        });
      });
      var xy = NSO_punchEl('btn-punch-pitch-xy');
      if (xy) xy.addEventListener('click', function () {
        var on = !NSO_punchSplit(), px = NSO_punchEl('inp-punch-pitch'), py = NSO_punchEl('inp-punch-pitch-y');
        xy.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on && px && py) py.value = px.value;      // Y starts where the one pitch was
        NSO_punchSyncRows(); NSO_punchPreview();
      });
      ['inp-punch-dia', 'sel-punch-depth', 'inp-punch-depth', 'inp-punch-rows', 'inp-punch-cols', 'inp-punch-pitch',
       'inp-punch-pitch-y', 'inp-punch-count', 'inp-punch-radius'].forEach(function (id) {
        var el = NSO_punchEl(id);
        if (!el) return;
        el.addEventListener('change', function () { NSO_punchSyncRows(); NSO_punchPreview(); });
        if (el.tagName === 'INPUT') el.addEventListener('input', function () { NSO_punchPreview(); });
      });
      // Capture on window: ahead of app-core's canvas handler, so a click that
      // places the hole does not also start a drag or a selection.
      window.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
      window.addEventListener('keydown', onKey, true);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
