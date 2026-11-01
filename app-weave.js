// ===================== Weave: the card =====================
// The geometry is nso_weave.js (and nso_cdt.js under it; headless, tools/nso_weave_test.js); this file is the
// card on it, the left bar's WEAVE, under Text. docs/WEAVE.md.
//
// Every corner of a mesh is a place it can be cut. WEAVE cuts a patch of a piece's surface out along its own
// triangles - like a puzzle piece - clones that surface as a fresh, evenly woven patch, and reattaches it
// corner for corner: the new patch's rim IS the rim, so the join is watertight with nothing to weld or repair.
// The surface is cloned, not flattened: a curved palm, a groove, a saddle come back as they were. Work on it (an
// engraving, a boss) is bridged, the face carried across it. It is the clean way to take engraved text off a scan
// (docs/RESURFACE.md is the other).
//
//   1. CUT with the LASSO: press on the piece and draw round the part. The loop is drawn flat on the screen but cuts
//      like a cylinder along the view: it takes the surface that faces you inside it, whatever the surface does there
//      (curves, grooves, walls). Shift adds another loop, Alt takes one away (what Alt takes from inside stays a hole);
//      Grow and Shrink move the edge one ring of triangles. It is the surface facing you that is cut, so it works
//      through X-RAY, where the plate (amber), its rim corners (the points it is cut at) and the new weave (green)
//      are drawn over the wireframe.
//   2. WEAVE. Clones the surface into the new patch and draws it. Nothing is changed yet. Smooth bridges the work;
//      Follow keeps the plate exactly and only re-weaves it. Pitch is the triangle size (blank: the plate's own).
//      Work the loop's edge crosses (a letter half inside) stays as it is, and the readout says how many; a refusal
//      says why in words (the patch would be too fine, there is no face left round the work).
//   3. REATTACH. Puts the new patch in place of the old, rim to rim - mesh surgery, no boolean - one Undo
//      (weaveReplace).
//
// PAINT SCOPE: WHOLE-PIECE. Per the scoping rule in docs/HANDOFF.md: a new patch renumbers triangles, and paint
// names its faces by axis and side - so any paint stands Weave down, naming the count: nsoMaskCount(m) is the
// whole test (the same stand-down as Text).

var WEAVE_PLATE_COLOR = 0xffc83d;       // the cut-out piece
var WEAVE_RIM_COLOR = 0xffffff;         // its rim
var WEAVE_NEW_COLOR = 0x34d399;         // the new weave
var WEAVE_BAD_COLOR = 0xf87171;         // a cut that cannot be woven, and the corners that stand on work
var WEAVE_RENDER_ORDER = 22;

function NSO_weaveUI() {
  if (typeof state === 'undefined') return {};
  if (!state.weave) {
    state.weave = { open: false, modelId: null, soup: null, M: null, cen: null, raw: null, mask: null, patch: null, plan: null,
                    fit: 'smooth', keep: null, drag: null, lasso: null, group: null, dirty: false, raf: 0, said: null, busy: false, bad: null, svg: null };
  }
  return state.weave;
}
function NSO_weaveEl(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
function NSO_weaveModel() {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  return (m && m.rawTris && m.rawAxis === 'zup') ? m : null;
}
function NSO_weaveMeshOf(m) {
  if (!m || typeof state === 'undefined') return null;
  var p = (state.placed || []).find(function (q) { return q && q.sourceId === m.id && q.mesh; });
  return p ? p.mesh : null;
}
// Raw (z up) <-> the piece's display frame: (x, z, -y) - centerOffset.
function NSO_weaveToDisplay(m, x, y, z) {
  var o = m.centerOffset || { x: 0, y: 0, z: 0 };
  return [x - o.x, z - o.y, -y - o.z];
}
function NSO_weaveFmt(v, d) { var k = Math.pow(10, d == null ? 1 : d); return (Math.round(v * k) / k).toFixed(d == null ? 1 : d); }
function NSO_weaveInt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

function NSO_weaveReadout(text, bad) {
  var el = NSO_weaveEl('weave-readout');
  if (el) { el.textContent = text; el.classList.toggle('is-bad', !!bad); }
  NSO_weaveUI().said = { text: text, bad: !!bad };
}
function NSO_weaveSyncButtons() {
  var B = NSO_weaveUI(), go = NSO_weaveEl('btn-weave-go'), at = NSO_weaveEl('btn-weave-attach');
  var cut = !!(B.patch && B.patch.ok);
  if (go) go.disabled = B.busy || !cut;
  if (at) at.disabled = B.busy || !(B.plan && B.plan.ok);
  [['btn-weave-smooth', 'smooth'], ['btn-weave-follow', 'follow']].forEach(function (p) {
    var b = NSO_weaveEl(p[0]); if (b) b.setAttribute('aria-pressed', B.fit === p[1] ? 'true' : 'false');
  });
  var cv = state.renderer && state.renderer.domElement;
  if (cv) cv.classList.toggle('weave-cur', !!B.open);
}
function NSO_weaveOpts() {
  var B = NSO_weaveUI(), pitch = NSO_weaveEl('inp-weave-pitch'), v = pitch && pitch.value !== '' ? +pitch.value : NaN;
  var o = { fit: B.fit };
  if (v > 0) o.pitch = v;
  return o;
}

/* ------------------------------------------------------------ the mesh */

// The welded mesh of the active piece (the engine caches it by soup), and each triangle's centre in the display frame.
function NSO_weaveEnsure(m) {
  var B = NSO_weaveUI();
  if (B.soup === m.rawTris && B.modelId === m.id && B.M) return B.M;
  if (typeof NSO_Weave === 'undefined') return null;
  B.M = NSO_Weave.prepare(m.rawTris);
  B.soup = m.rawTris; B.modelId = m.id;
  var n = B.M.n, cen = new Float32Array(3 * n), nrm = new Float32Array(3 * n), t, c;
  for (t = 0; t < n; t++) {
    c = NSO_Weave.centroid(B.M, t);
    var d = NSO_weaveToDisplay(m, c[0], c[1], c[2]);
    cen[3 * t] = d[0]; cen[3 * t + 1] = d[1]; cen[3 * t + 2] = d[2];
    // the normal in the display frame: (x, z, -y)
    nrm[3 * t] = B.M.nrm[3 * t]; nrm[3 * t + 1] = B.M.nrm[3 * t + 2]; nrm[3 * t + 2] = -B.M.nrm[3 * t + 1];
  }
  B.cen = cen; B.raw = nrm;
  B.mask = null; B.patch = null; B.plan = null; B.bad = null; B.dirty = true;
  return B.M;
}
function NSO_weaveReset(keepReadout) {
  var B = NSO_weaveUI();
  B.mask = null; B.patch = null; B.plan = null; B.bad = null; B.drag = null; B.keep = null; B.dirty = true;
  NSO_weaveLassoEnd();
  NSO_weaveDraw();
  NSO_weaveSyncButtons();
  if (!keepReadout) NSO_weaveReadout(NSO_weaveHint());
}
function NSO_weaveHint() {
  return 'Weave: press on the piece and draw round the part to cut out (Shift adds a loop, Alt takes one away).';
}

/* ----------------------------------------------------------- the pointer */

// The piece under (x, y): { tri, point (display, local), normal (display, local) } or null. Only the active piece is asked.
function NSO_weavePick(clientX, clientY) {
  var m = NSO_weaveModel(), mesh = m && NSO_weaveMeshOf(m);
  if (!mesh || !state.raycaster || !state.camera || !state.renderer) return null;
  setPointerFromEvent({ clientX: clientX, clientY: clientY });
  state.raycaster.setFromCamera(state.pointer, state.camera);
  mesh.updateMatrixWorld(true);
  var hits = state.raycaster.intersectObject(mesh, false);
  for (var i = 0; i < hits.length; i++) {
    if (hits[i].faceIndex == null) continue;
    var local = hits[i].point.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
    return { tri: hits[i].faceIndex, local: local };
  }
  return null;
}
// a display-frame point back to the raw frame
function NSO_weaveToRaw(m, d) {
  var o = m.centerOffset || { x: 0, y: 0, z: 0 };
  return [d.x + o.x, -(d.z + o.z), d.y + o.y];
}

/* Fold a new selection into the cut: Shift adds, Alt takes away (and what it takes from inside the cut stays a hole: close()
   would otherwise fill it as it fills a letter's counter), else it replaces. */
function NSO_weaveCombine(fresh, ev) {
  var B = NSO_weaveUI(), M = B.M;
  if (!fresh) return null;
  if (!B.mask || !(ev && (ev.shiftKey || ev.altKey))) { B.keep = null; return fresh; }
  var out = Uint8Array.from(B.mask), t;
  if (!B.keep) B.keep = new Uint8Array(M.n);
  if (ev.altKey) { for (t = 0; t < M.n; t++) if (fresh[t]) { out[t] = 0; B.keep[t] = 1; } }
  else { for (t = 0; t < M.n; t++) if (fresh[t]) { out[t] = 1; B.keep[t] = 0; } }
  return out;
}

/* A new cut: close it (islands, pinches, one piece), cut it, say what it is. */
function NSO_weaveSetCut(mask, quick) {
  var B = NSO_weaveUI(), M = B.M;
  B.plan = null; B.bad = null;
  if (!mask || !NSO_Weave.count(mask)) { B.mask = null; B.patch = null; B.dirty = true; NSO_weaveDraw(); NSO_weaveSyncButtons(); NSO_weaveReadout(NSO_weaveHint()); return; }
  if (quick) { B.mask = mask; B.patch = null; B.dirty = true; NSO_weaveDraw(); return; }
  var c = NSO_Weave.close(M, mask, { keep: B.keep });
  B.mask = c.mask;
  B.patch = NSO_Weave.patch(M, B.mask);
  B.dirty = true;
  NSO_weaveDraw();
  NSO_weaveSyncButtons();
  var pt = B.patch;
  if (!pt.ok) { NSO_weaveReadout('Weave: ' + pt.reason, true); return; }
  NSO_weaveReadout('Cut: ' + NSO_weaveInt(pt.tris.length) + ' triangles, ' + NSO_weaveFmt(pt.area) + ' mm², rim ' + NSO_weaveInt(pt.rimCorners) + ' corners' +
    (pt.holes ? ', ' + pt.holes + (pt.holes === 1 ? ' hole' : ' holes') : '') + '. Press WEAVE.');
}

function NSO_weaveDown(ev) {
  var B = NSO_weaveUI(), m = NSO_weaveModel();
  if (!m || B.busy) return false;
  if (typeof NSO_bendFrameMatches === 'function' && !NSO_bendFrameMatches(m)) {
    NSO_weaveReadout('Weave: the piece was turned since it was loaded - bake its pose first.', true);
    return true;
  }
  var M = NSO_weaveEnsure(m);
  if (!M) return false;
  var pk = NSO_weavePick(ev.clientX, ev.clientY);
  if (!pk) return false;                                              // a press off the piece orbits as ever
  B.drag = { pts: [[ev.clientX, ev.clientY]], ev: ev, moved: false };
  NSO_weaveLassoStart(ev.clientX, ev.clientY);
  if (state.controls) state.controls.enabled = false;
  return true;
}
function NSO_weaveMove(ev) {
  var B = NSO_weaveUI(), D = B.drag;
  if (!D) return;
  var last = D.pts[D.pts.length - 1];
  if (Math.hypot(ev.clientX - last[0], ev.clientY - last[1]) < 4) return;
  D.pts.push([ev.clientX, ev.clientY]); D.moved = true; D.ev = ev;
  NSO_weaveLassoMove(D.pts);
}
function NSO_weaveUp(ev, keep) {
  var B = NSO_weaveUI(), D = B.drag, m = NSO_weaveModel();
  if (!D) return;
  B.drag = null;
  if (state.controls) state.controls.enabled = true;
  NSO_weaveLassoEnd();
  if (!keep || !m || !B.M) { NSO_weaveSetCut(B.mask && B.patch ? B.mask : null); return; }
  var fresh = D.pts.length >= 3 ? NSO_weaveLassoSelect(m, D.pts) : null;
  if (!fresh) { NSO_weaveReadout('Weave: that loop holds no surface - draw a loop round part of the piece.', true); return; }
  NSO_weaveSetCut(NSO_weaveCombine(fresh, ev || D.ev));
}

/* ------------------------------------------------------------------ lasso */

function NSO_weaveLassoStart(x, y) {
  var B = NSO_weaveUI();
  NSO_weaveLassoEnd();
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.id = 'weave-lasso';
  var pl = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  pl.setAttribute('points', x + ',' + y);
  svg.appendChild(pl);
  document.body.appendChild(svg);
  B.svg = svg;
}
function NSO_weaveLassoMove(pts) {
  var B = NSO_weaveUI();
  if (!B.svg) return;
  B.svg.firstChild.setAttribute('points', pts.map(function (p) { return p[0] + ',' + p[1]; }).join(' '));
}
function NSO_weaveLassoEnd() {
  var B = NSO_weaveUI();
  if (B.svg && B.svg.parentNode) B.svg.parentNode.removeChild(B.svg);
  B.svg = null;
}
/* The triangles that face the camera and whose centres fall inside the loop, joined to the one under its middle. */
function NSO_weaveLassoSelect(m, pts) {
  var B = NSO_weaveUI(), M = B.M, mesh = NSO_weaveMeshOf(m);
  if (!mesh || !state.camera || !state.renderer) return null;
  state.camera.updateMatrixWorld(true); mesh.updateMatrixWorld(true);
  var rect = state.renderer.domElement.getBoundingClientRect();
  var mvp = new THREE.Matrix4().multiplyMatrices(state.camera.projectionMatrix, state.camera.matrixWorldInverse).multiply(mesh.matrixWorld), e = mvp.elements;
  var mw = mesh.matrixWorld.elements, cam = state.camera.position;
  var minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, cx = 0, cy = 0, i;
  pts.forEach(function (p) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); cx += p[0]; cy += p[1]; });
  cx /= pts.length; cy /= pts.length;
  var cand = new Uint8Array(M.n), best = -1, bd = Infinity, n = M.n, any = 0;
  for (var t = 0; t < n; t++) {
    var x = B.cen[3 * t], y = B.cen[3 * t + 1], z = B.cen[3 * t + 2];
    var w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (w <= 1e-9) continue;
    var sx = rect.left + ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w + 1) / 2 * rect.width;
    if (sx < minx || sx > maxx) continue;
    var sy = rect.top + (1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w) / 2 * rect.height;
    if (sy < miny || sy > maxy) continue;
    var inside = false;
    for (i = 0, k = pts.length - 1; i < pts.length; k = i++) {
      var a = pts[i], b = pts[k];
      if ((a[1] > sy) !== (b[1] > sy) && sx < (b[0] - a[0]) * (sy - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    if (!inside) continue;
    // facing the camera: the world normal against the way to the camera
    var nx = B.raw[3 * t], ny = B.raw[3 * t + 1], nz = B.raw[3 * t + 2];
    var wx = mw[0] * nx + mw[4] * ny + mw[8] * nz, wy = mw[1] * nx + mw[5] * ny + mw[9] * nz, wz = mw[2] * nx + mw[6] * ny + mw[10] * nz;
    var px = mw[0] * x + mw[4] * y + mw[8] * z + mw[12], py = mw[1] * x + mw[5] * y + mw[9] * z + mw[13], pz = mw[2] * x + mw[6] * y + mw[10] * z + mw[14];
    if (wx * (cam.x - px) + wy * (cam.y - py) + wz * (cam.z - pz) <= 0) continue;
    cand[t] = 1; any++;
    var d = (sx - cx) * (sx - cx) + (sy - cy) * (sy - cy);
    if (d < bd) { bd = d; best = t; }
  }
  var k;
  if (!any) return null;
  var seed = NSO_weavePick(cx, cy);
  var s = seed && cand[seed.tri] ? seed.tri : best;
  var mask = NSO_Weave.flood(M, s, function (t2) { return cand[t2] === 1; });
  return NSO_Weave.count(mask) ? mask : null;
}

/* ------------------------------------------------------------------ drawing */

function NSO_weaveClearDraw() {
  var B = NSO_weaveUI();
  if (!B.group) return;
  if (B.group.parent) B.group.parent.remove(B.group);
  B.group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  B.group = null;
}
function NSO_weaveDraw() {
  var B = NSO_weaveUI(), m = NSO_weaveModel();
  NSO_weaveClearDraw();
  if (typeof THREE === 'undefined' || !state.scene || !m || !B.M || !B.mask) return;
  var M = B.M, group = new THREE.Group(), pt = B.patch, bad = pt && !pt.ok;
  group.name = 'weaveHelpers'; group.matrixAutoUpdate = false;
  function mark(o, order) { o.renderOrder = WEAVE_RENDER_ORDER + (order || 0); o.userData.skipXray = true; o.raycast = function () {}; o.frustumCulled = false; return o; }
  // the plate
  var pos = [], t, k;
  for (t = 0; t < M.n; t++) {
    if (!B.mask[t]) continue;
    for (k = 0; k < 3; k++) { var v = 3 * M.vid[3 * t + k], d = NSO_weaveToDisplay(m, M.P[v], M.P[v + 1], M.P[v + 2]); pos.push(d[0], d[1], d[2]); }
  }
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  group.add(mark(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: bad ? WEAVE_BAD_COLOR : WEAVE_PLATE_COLOR, transparent: true, opacity: 0.28,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide })), 0));
  // the rim: its edges, and its corners - the places it is cut at
  if (pt && pt.loops) {
    var lines = [], dots = [];
    pt.loops.forEach(function (L) {
      for (var q = 0; q < L.length; q++) {
        var a = 3 * L[q], b = 3 * L[(q + 1) % L.length], da = NSO_weaveToDisplay(m, M.P[a], M.P[a + 1], M.P[a + 2]), db = NSO_weaveToDisplay(m, M.P[b], M.P[b + 1], M.P[b + 2]);
        lines.push(da[0], da[1], da[2], db[0], db[1], db[2]);
        dots.push(da[0], da[1], da[2]);
      }
    });
    var lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lines), 3));
    group.add(mark(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: WEAVE_RIM_COLOR, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false })), 1));
    var dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(dots), 3));
    group.add(mark(new THREE.Points(dg, new THREE.PointsMaterial({ color: WEAVE_PLATE_COLOR, size: 4, sizeAttenuation: false, transparent: true, depthTest: false, depthWrite: false })), 2));
  }
  // the new weave
  var pl = B.plan;
  if (pl && pl.ok) {
    var wp = [], P = M.P, V = pl.newV, no = pl.nOld;
    for (var i = 0; i < pl.T.length; i++) {
      var id = pl.T[i], x, y, z;
      if (id < no) { x = P[3 * id]; y = P[3 * id + 1]; z = P[3 * id + 2]; } else { x = V[3 * (id - no)]; y = V[3 * (id - no) + 1]; z = V[3 * (id - no) + 2]; }
      var dd = NSO_weaveToDisplay(m, x, y, z); wp.push(dd[0], dd[1], dd[2]);
    }
    var wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(wp), 3));
    group.add(mark(new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ color: WEAVE_NEW_COLOR, wireframe: true, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false })), 3));
  }
  // corners that stand on work
  if (B.bad && B.bad.length) {
    var bp = [];
    B.bad.forEach(function (v) { var dd2 = NSO_weaveToDisplay(m, M.P[3 * v], M.P[3 * v + 1], M.P[3 * v + 2]); bp.push(dd2[0], dd2[1], dd2[2]); });
    var bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bp), 3));
    group.add(mark(new THREE.Points(bg, new THREE.PointsMaterial({ color: WEAVE_BAD_COLOR, size: 7, sizeAttenuation: false, transparent: true, depthTest: false, depthWrite: false })), 4));
  }
  if (typeof nsoHelpers !== 'undefined') nsoHelpers.attach(state.scene, group, 'weave'); else state.scene.add(group);
  B.group = group;
  NSO_weaveFollow();
}
function NSO_weaveFollow() {
  var B = NSO_weaveUI(), m = NSO_weaveModel(), mesh = m && NSO_weaveMeshOf(m);
  if (!mesh || !B.group) return;
  mesh.updateMatrixWorld(true);
  B.group.matrix.copy(mesh.matrixWorld);
  B.group.matrixWorldNeedsUpdate = true;
}

/* ------------------------------------------------------------------ the buttons */

function NSO_weaveGrow(dir) {
  var B = NSO_weaveUI(), m = NSO_weaveModel();
  if (!m || !B.M || !B.mask) { NSO_weaveReadout('Weave: cut a piece first.', true); return; }
  var mask = dir > 0 ? NSO_Weave.grow(B.M, B.mask, 1) : NSO_Weave.shrink(B.M, B.mask, 1);
  NSO_weaveSetCut(mask);
}
function NSO_weaveGo() {
  var B = NSO_weaveUI(), m = NSO_weaveModel();
  if (B.busy) return;
  if (!m || !B.M || !B.patch || !B.patch.ok) { NSO_weaveReadout('Weave: cut a piece first.', true); return; }
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    if (typeof setStatus === 'function') setStatus('Weave stood down - ' + painted + ' painted face(s); a new patch renumbers the triangles the paint names. Clear paint to weave.', true);
    NSO_weaveReadout('Weave: ' + painted + ' painted face(s) - clear paint first.', true);
    return;
  }
  B.busy = true; B.plan = null; B.bad = null;
  NSO_weaveSyncButtons();
  NSO_weaveReadout('Weaving…');
  var soup = m.rawTris, patch = B.patch, opts = NSO_weaveOpts();
  setTimeout(function () {
    var r;
    try { r = NSO_Weave.weave(B.M, patch, opts); }
    catch (err) { console.error('[weave]', err); r = { ok: false, reason: (err && err.message) || String(err) }; }
    B.busy = false;
    if (NSO_weaveModel() !== m || m.rawTris !== soup) { NSO_weaveReset(); return; }
    if (!r.ok) {
      B.bad = r.rimBad || null;
      NSO_weaveReadout('Weave: ' + r.reason, true);
      B.dirty = true; NSO_weaveDraw(); NSO_weaveSyncButtons();
      return;
    }
    B.plan = r;
    var s = r.stats;
    NSO_weaveReadout('Woven: ' + NSO_weaveInt(s.oldTris) + ' → ' + NSO_weaveInt(s.newTris) + ' triangles at ' + NSO_weaveFmt(s.pitch, 2) + ' mm, the surface cloned' +
      (s.workArea > 0 ? ' · bridged ' + NSO_weaveFmt(s.workArea) + ' mm² of work up to ' + NSO_weaveFmt(s.workDepth, 2) + ' mm deep' : '') +
      (s.keptFeatures > 0 ? ' · ' + s.keptFeatures + (s.keptFeatures === 1 ? ' feature crosses' : ' features cross') + ' the lasso\'s edge and ' + (s.keptFeatures === 1 ? 'stays' : 'stay') + ' as ' + (s.keptFeatures === 1 ? 'it is' : 'they are') + ' (draw it wider to take ' + (s.keptFeatures === 1 ? 'it' : 'them') + ')' : '') +
      ' · rim kept, all ' + NSO_weaveInt(s.rimCorners) + ' corners. REATTACH puts it in.');
    B.dirty = true; NSO_weaveDraw(); NSO_weaveSyncButtons();
  }, 30);
}
/* A bake swaps the piece's mesh for a fresh one, solid; while X-ray is on, this puts the new one back in it with the
   app's own X-ray settings (applyXrayToMaterial, app-join.js - not reachable from here), so the woven patch is seen
   the way the cut was. */
function NSO_weaveKeepXray() {
  if (typeof state === 'undefined' || !state.xray || !state.modelGroup) return;
  state.modelGroup.traverse(function (obj) {
    if (!obj.isMesh || !obj.material || (obj.userData && obj.userData.skipXray)) return;
    (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(function (mat) {
      if (mat.wireframe) return;
      mat.wireframe = true; mat.transparent = true; mat.opacity = 0.95; mat.depthWrite = false; mat.depthTest = false;
      if (mat.userData._xraySavedEmissive == null) {
        mat.userData._xraySavedEmissive = mat.emissive ? mat.emissive.getHex() : 0;
        mat.userData._xraySavedEmissiveInt = mat.emissiveIntensity || 0;
      }
      if (mat.emissive) mat.emissive.setHex(0x7dd3fc);
      mat.emissiveIntensity = 1.1;
      mat.needsUpdate = true;
    });
  });
}
// PAINT SCOPE: WHOLE-PIECE - see the header and docs/HANDOFF.md.
function NSO_weaveAttach() {
  var B = NSO_weaveUI(), m = NSO_weaveModel();
  function refuse(why) {
    if (typeof setStatus === 'function') setStatus('Weave refused - piece unchanged (' + why + ')', true);
    NSO_weaveReadout('Weave: ' + why, true);
    return { ok: false, reason: why };
  }
  if (B.busy) return { ok: false, reason: 'busy' };
  if (!m) return refuse('select a piece first');
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    if (typeof setStatus === 'function') setStatus('Weave stood down - ' + painted + ' painted face(s). Clear paint to weave.', true);
    return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
  }
  if (!B.plan || !B.plan.ok || !B.mask) return refuse('press WEAVE first - the new patch is drawn green');
  var res;
  try { res = NSO_Weave.apply(m.rawTris, B.plan, B.mask); }
  catch (err) { console.error('[weave]', err); return refuse((err && err.message) || String(err)); }
  if (!res.ok) return refuse(res.reason);
  var s = B.plan.stats;
  var txt = 'Weave done - ' + NSO_weaveInt(res.removed) + ' triangles out, ' + NSO_weaveInt(res.added) + ' in, rim kept corner for corner' +
    (s.workArea > 0 ? ', work bridged (' + NSO_weaveFmt(s.workArea) + ' mm²)' : '');
  if (!NSO_sculptCommitRaw(m, res.soup, 'weaveReplace', txt)) return refuse('the result could not be committed');
  if (typeof updateAdjustUI === 'function') updateAdjustUI();
  NSO_weaveKeepXray();
  B.soup = null;                                            // the soup is new: read it again
  NSO_weaveReset(true);
  NSO_weaveReadout('Reattached - ' + NSO_weaveInt(res.removed) + ' → ' + NSO_weaveInt(res.added) + ' triangles. Cut the next patch.');
  return { ok: true, removed: res.removed, added: res.added };
}

/* -------------------------------------------------------------- open, close */

function NSO_weaveOpen() {
  var B = NSO_weaveUI();
  if (B.open) return;
  if (state.carveArmed) { var cb = NSO_weaveEl('btn-carve'); if (cb) cb.click(); }
  if (typeof NSO_punchClose === 'function' && state.punch && state.punch.open) NSO_punchClose();
  B.open = true;
  B.mask = null; B.patch = null; B.plan = null; B.bad = null; B.drag = null; B.soup = null;
  var m = NSO_weaveModel();
  B.modelId = m ? m.id : null;
  NSO_weaveSyncButtons();
  NSO_weaveReadout(NSO_weaveHint());
  if (typeof setStatus === 'function') setStatus('Weave open - draw a lasso round the part to cut out, then WEAVE. Close the menu or press Escape to stop.');
  NSO_weaveTick();
}
function NSO_weaveClose() {
  var B = NSO_weaveUI();
  if (B.drag) { B.drag = null; if (state.controls) state.controls.enabled = true; }
  NSO_weaveLassoEnd();
  B.open = false; B.mask = null; B.keep = null; B.patch = null; B.plan = null; B.bad = null; B.soup = null; B.M = null; B.cen = null; B.raw = null;
  NSO_weaveClearDraw();
  if (B.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(B.raf);
  B.raf = 0;
  var cv = state.renderer && state.renderer.domElement;
  if (cv) cv.classList.remove('weave-cur');
  var menu = NSO_weaveEl('menu-weave');
  if (menu && menu.open) menu.open = false;
}
// Weave's session, for the helper registry (nso-helpers.js): leave-tool and Clear close it, an Undo under it re-reads it.
if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('weave', {
  live: function () { return !!NSO_weaveUI().open; },
  close: NSO_weaveClose,
  clear: NSO_weaveClearDraw,
  refresh: function () { var B = NSO_weaveUI(); B.soup = null; NSO_weaveReset(); }
});

// Per frame while open: follow the piece; start over when the selection changes or its soup does (a bake, an Undo).
function NSO_weaveTick() {
  var B = NSO_weaveUI();
  if (!B.open) return;
  if (!B.busy && (state.carveArmed || state.maskPaint || (state.punch && state.punch.open))) { NSO_weaveClose(); return; }
  var m = NSO_weaveModel();
  if ((m ? m.id : null) !== B.modelId || (m && B.soup && B.soup !== m.rawTris && !B.busy)) {
    B.modelId = m ? m.id : null; B.soup = null; B.M = null;
    NSO_weaveReset();
  } else NSO_weaveFollow();
  B.raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(NSO_weaveTick) : 0;
}

/* For the drive check: what the card shows, and a way to cut without a pointer. */
function nsoWeaveState() {
  var B = NSO_weaveUI(), pt = B.patch, pl = B.plan, kids = B.group ? B.group.children : [];
  return {
    open: !!B.open, fit: B.fit, busy: !!B.busy,
    cut: B.mask && B.M ? NSO_Weave.count(B.mask) : 0,
    patch: pt ? { ok: !!pt.ok, reason: pt.reason || '', tris: pt.tris ? pt.tris.length : 0, rim: pt.rimCorners || 0, area: pt.area || 0, holes: pt.holes || 0 } : null,
    plan: pl ? { ok: !!pl.ok, stats: pl.stats || null } : null,
    bad: B.bad ? B.bad.length : 0,
    drawn: kids.length, fills: kids.filter(function (o) { return o.isMesh && !o.material.wireframe; }).length, wires: kids.filter(function (o) { return o.isMesh && o.material.wireframe; }).length,
    readout: (NSO_weaveEl('weave-readout') || {}).textContent || '',
    bad_readout: !!(NSO_weaveEl('weave-readout') && NSO_weaveEl('weave-readout').classList.contains('is-bad')),
    go: !(NSO_weaveEl('btn-weave-go') || { disabled: true }).disabled, attach: !(NSO_weaveEl('btn-weave-attach') || { disabled: true }).disabled
  };
}
if (typeof document !== 'undefined') {
  (function wireWeave() {
    function onDown(ev) {
      var B = NSO_weaveUI();
      if (!B.open || ev.button !== 0 || !state.raycaster || !state.camera || !state.renderer) return;
      if (ev.target !== state.renderer.domElement) return;
      if (B.drag) NSO_weaveUp(ev, false);
      if (B.busy) { if (NSO_weavePick(ev.clientX, ev.clientY)) { ev.stopImmediatePropagation(); ev.preventDefault(); } return; }
      if (!NSO_weaveDown(ev)) return;                       // a press off the piece orbits as ever
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
    function onMove(ev) {
      var B = NSO_weaveUI();
      if (!B.drag) return;
      NSO_weaveMove(ev);
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
    function onUp(ev) {
      var B = NSO_weaveUI();
      if (!B.drag) return;
      NSO_weaveUp(ev, ev.type === 'pointerup');
      ev.stopImmediatePropagation();
    }
    function onKey(ev) {
      var B = NSO_weaveUI();
      if (!B.open || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      var t = ev.target, typing = t && ((t.tagName === 'INPUT' && t.type !== 'checkbox') || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing) { if (ev.key === 'Escape') { t.blur(); ev.preventDefault(); ev.stopImmediatePropagation(); } return; }
      if (ev.key !== 'Escape') return;
      if (B.drag) { B.drag = null; if (state.controls) state.controls.enabled = true; NSO_weaveLassoEnd(); NSO_weaveSetCut(B.mask && B.patch ? B.mask : null); ev.preventDefault(); ev.stopImmediatePropagation(); return; }
      if (B.busy) return;
      if (B.mask) { NSO_weaveReset(); ev.preventDefault(); ev.stopImmediatePropagation(); return; }     // the first Escape lets go of the cut
      NSO_weaveClose();
      if (typeof setStatus === 'function') setStatus('Weave off');
      ev.preventDefault(); ev.stopImmediatePropagation();
    }
    function wire() {
      var menu = NSO_weaveEl('menu-weave');
      if (!menu || menu.dataset.nsoWired === '1') return;
      menu.dataset.nsoWired = '1';
      menu.addEventListener('toggle', function () { if (menu.open) NSO_weaveOpen(); else if (NSO_weaveUI().open) NSO_weaveClose(); });
      function on(id, fn) { var b = NSO_weaveEl(id); if (b) b.addEventListener('click', fn); }
      on('btn-weave-grow', function () { NSO_weaveGrow(1); });
      on('btn-weave-shrink', function () { NSO_weaveGrow(-1); });
      on('btn-weave-clear', function () { NSO_weaveReset(); });
      on('btn-weave-smooth', function () { var B = NSO_weaveUI(); B.fit = 'smooth'; B.plan = null; B.bad = null; B.dirty = true; NSO_weaveDraw(); NSO_weaveSyncButtons(); });
      on('btn-weave-follow', function () { var B = NSO_weaveUI(); B.fit = 'follow'; B.plan = null; B.bad = null; B.dirty = true; NSO_weaveDraw(); NSO_weaveSyncButtons(); });
      on('btn-weave-go', function () { NSO_weaveGo(); });
      on('btn-weave-attach', function () { NSO_weaveAttach(); });
      on('btn-weave-cancel', function () { NSO_weaveClose(); });
      var pitch = NSO_weaveEl('inp-weave-pitch');
      if (pitch) pitch.addEventListener('input', function () { var B = NSO_weaveUI(); if (B.plan) { B.plan = null; B.dirty = true; NSO_weaveDraw(); NSO_weaveSyncButtons(); } });
      // Capture on window: ahead of app-core's canvas handler, so a press that cuts does not also orbit or select.
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
