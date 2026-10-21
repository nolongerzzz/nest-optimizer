// ===================== Bend: the panel =====================
// The geometry is nso_bend.js (headless, tools/nso_bend_test.js); this file is
// the panel on it, in Finish -> Shape, under Extend. docs/BEND.md.
//
// Four inputs - Where (mm from the near end), Angle, Radius (blank: 2.5 x the
// section's width that way), Toward (the piece's four sides; a Roll in 15°
// steps for a section that is not a rectangle) - then Bend or Cancel.
//
// While the panel is open:
//   - a GHOST of the result sits on the piece, drawn the way Crop's lifted
//     ghost is (amber, 0.75), from the very soup Bend would commit: every
//     change runs NSO_bendRaw and the ghost is what came back, so the picture
//     and the bake cannot disagree. A refusal takes the ghost away and the
//     readout says why;
//   - a flat MARKER stands across the piece at Where, built the way Cut's
//     blade is (#151): a thin translucent sheet and an amber frame, neither
//     depth-tested, so it reads through the piece from any angle;
//   - a click on the piece sets Where to the point clicked along its length.
//
// Bend commits through the sculpt commit (undo type 'bendReplace'), so one
// Undo puts the whole piece back, and the piece re-seats on the plate the way
// any bake does. No multi-bend recording, no drag handle, no stock generator:
// a second bend is Bend again, on the straight band that is left.
//
// PAINT SCOPE: WHOLE-PIECE. Per the scoping rule in docs/HANDOFF.md: a bend
// moves every face past the zone and rebuilds every wall the zone crosses, so
// no face can be promised untouched. Any paint stands it down, naming the
// count: nsoMaskCount(m) is the whole test.

var BEND_GHOST_COLOR = 0xf59e0b;           // Crop's lifted ghost
var BEND_MARK_COLOR = 0xffc83d;            // Cut's blade frame
var BEND_MARK_FILL = 0x101010;
var BEND_MARK_FILL_OPACITY = 0.38;
var BEND_MARK_RENDER_ORDER = 20;
var BEND_MARK_OVERHANG_MM = 1;

function NSO_bendUI() {
  if (typeof state === 'undefined') return {};
  if (!state.bend) state.bend = { open: false, modelId: null, soup: null, read: null, result: null, key: '', ghost: null, marker: null, raf: 0 };
  return state.bend;
}

function NSO_bendEl(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }

function NSO_bendModel() {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  return (m && m.rawTris && m.rawAxis === 'zup') ? m : null;
}

function NSO_bendMeshOf(m) {
  if (!m || typeof state === 'undefined') return null;
  var p = (state.placed || []).find(function (q) { return q && q.sourceId === m.id && q.mesh; });
  return p ? p.mesh : (state.previewMesh || null);
}

// The panel's numbers as NSO_bendRaw opts.
function NSO_bendOpts() {
  function num(id) { var el = NSO_bendEl(id); return el && el.value !== '' ? +el.value : null; }
  var sel = NSO_bendEl('sel-bend-toward'), rollRow = NSO_bendEl('bend-roll-row');
  return {
    where: num('inp-bend-where'), angle: num('inp-bend-angle'), radius: num('inp-bend-radius'),
    toward: sel ? sel.value : '+Z',
    roll: (rollRow && !rollRow.hidden) ? (num('inp-bend-roll') || 0) : 0
  };
}

/* Display frame <-> raw frame. display = (x, z, -y) - centerOffset (the load
   transform, rawResultToDisplayGeometry); so raw axis 0 is display x, raw 1 is
   display -z, raw 2 is display y. */
function NSO_bendRawToDisplayAxis(k) { return k === 0 ? { a: 'x', s: 1 } : k === 1 ? { a: 'z', s: -1 } : { a: 'y', s: 1 }; }
function NSO_bendRawCoordToDisplay(m, k, c) {
  var off = m.centerOffset || { x: 0, y: 0, z: 0 };
  return k === 0 ? c - off.x : k === 1 ? -c - off.z : c - off.y;
}
function NSO_bendDisplayCoordToRaw(m, k, v) {
  var off = m.centerOffset || { x: 0, y: 0, z: 0 };
  return k === 0 ? v + off.x : k === 1 ? -(v + off.z) : v + off.y;
}

// The display mesh is the raw soup, moved by the load transform - unless the
// piece was turned in place since, which Crop's Move checks the same way.
function NSO_bendFrameMatches(m) {
  if (!m.geometry || !m.geometry.attributes || !m.geometry.attributes.position || !m.centerOffset) return false;
  if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
  var bb = m.geometry.boundingBox, s = m.rawTris, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (var i = 0; i < s.length; i += 3) for (var c = 0; c < 3; c++) { var v = s[i + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v; }
  return Math.abs((hi[0] - lo[0]) - (bb.max.x - bb.min.x)) < 1e-3 && Math.abs((hi[2] - lo[2]) - (bb.max.y - bb.min.y)) < 1e-3 &&
         Math.abs((hi[1] - lo[1]) - (bb.max.z - bb.min.z)) < 1e-3;
}

/* THE PIECE'S FRAME. Bend finds the piece's length along a raw axis, and a
   pose is baked into the geometry when it ends (app-core.js
   nsoBakePlacedPose), so a bar turned 30 degrees has no raw axis along its
   length any more. Bend works in the piece's frame instead - pieceFrame
   (nso-bounds.js), the one every tool reads: when the footprint's long side
   is not on a raw axis (taken modulo a quarter turn), Bend reads, previews,
   marks and is clicked on the soup turned about the vertical to put that
   side on raw X (`f`, a stand-in model), and its result is turned back
   before it is committed. `T` carries f's display frame into the mesh's.
   A piece lying square is its own frame: f is the model, T the identity. */
function NSO_bendSpace(m) {
  var mesh = NSO_bendMeshOf(m), B = NSO_bendUI();
  var same = { f: m, T: null, toRaw: function (t) { return t; } };
  if (typeof THREE === 'undefined' || !mesh || typeof nsoBounds === 'undefined' || !nsoBounds.pieceFrame || typeof nsoRawTurnRows !== 'function') return same;
  mesh.updateMatrixWorld(true);
  var fr = nsoBounds.pieceFrame(mesh);
  if (!fr) return same;
  var inv = new THREE.Matrix4().copy(mesh.matrixWorld).invert();
  var L = fr.long.clone().transformDirection(inv);
  var phi = Math.atan2(-L.z, L.x);                        // the long side's heading in the mesh's frame
  phi -= Math.round(phi / (Math.PI / 2)) * (Math.PI / 2);  // a quarter turn is a raw axis already
  if (Math.abs(phi) < 1e-6) return same;
  var key = phi.toFixed(9);
  if (B.space && B.space.m === m && B.space.raw === m.rawTris && B.space.key === key) return B.space;
  var q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -phi);
  var R = nsoRawTurnRows(q), Ri = nsoRawTurnRows(q.clone().invert());
  var soup = nsoTurnRaw(m.rawTris, R);
  var geo = rawResultToDisplayGeometry(soup);
  var f = { id: m.id, name: m.name, rawTris: soup, rawAxis: 'zup', geometry: geo,
            centerOffset: computeCenterOffsetFromRaw(soup) };
  /* f-local x' = R (x + oM) - cF, so x = R^-1 (x' + cF) - oM */
  if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
  var off = m.centerOffset || { x: 0, y: 0, z: 0 };
  var gc = m.geometry.boundingBox.getCenter(new THREE.Vector3());
  var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], r = m.rawTris;
  for (var i = 0; i < r.length; i += 3) {
    var d = [r[i], r[i + 2], -r[i + 1]];
    for (var k = 0; k < 3; k++) { if (d[k] < lo[k]) lo[k] = d[k]; if (d[k] > hi[k]) hi[k] = d[k]; }
  }
  var oM = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2).sub(gc);
  var cF = new THREE.Vector3(f.centerOffset.x, f.centerOffset.y, f.centerOffset.z);
  var T = new THREE.Matrix4().makeTranslation(-oM.x, -oM.y, -oM.z)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q.clone().invert()))
    .multiply(new THREE.Matrix4().makeTranslation(cF.x, cF.y, cF.z));
  B.space = { m: m, raw: m.rawTris, key: key, f: f, T: T,
              toRaw: function (t) { return nsoTurnRaw(t, Ri); } };
  return B.space;
}

/* ---------------------------------------------------------------- drawing */

function NSO_bendRemoveGhost() {
  var B = NSO_bendUI();
  if (B.ghost) {
    if (B.ghost.parent) B.ghost.parent.remove(B.ghost);
    if (B.ghost.geometry) B.ghost.geometry.dispose();
    if (B.ghost.material) B.ghost.material.dispose();
    B.ghost = null;
  }
}

function NSO_bendRemoveMarker() {
  var B = NSO_bendUI();
  if (B.marker) {
    if (B.marker.parent) B.marker.parent.remove(B.marker);
    B.marker.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    B.marker = null;
  }
}

function NSO_bendSetGhost(m, tris) {
  NSO_bendRemoveGhost();
  if (typeof THREE === 'undefined' || !state.scene || !tris || typeof rawResultToDisplayGeometry !== 'function') return;
  var geo = rawResultToDisplayGeometry(tris, m.centerOffset);
  var g = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: BEND_GHOST_COLOR, transparent: true, opacity: 0.75, metalness: 0.05, roughness: 0.5,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  g.name = 'bendGhost';
  g.userData.bendGhost = true;
  g.userData.skipXray = true;
  g.matrixAutoUpdate = false;
  nsoHelpers.attach(state.scene, g, 'bend');
  NSO_bendUI().ghost = g;
  NSO_bendFollow();
}

// The marker: Cut's blade, across the piece's axis at Where, in the piece's
// own display frame.
function NSO_bendSetMarker(m, k, rawCoord) {
  NSO_bendRemoveMarker();
  if (typeof THREE === 'undefined' || !state.scene || !m.geometry) return;
  if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
  var bb = m.geometry.boundingBox, ax = NSO_bendRawToDisplayAxis(k);
  var AX = ['x', 'y', 'z'], dk = AX.indexOf(ax.a), du = (dk + 1) % 3, dv = (dk + 2) % 3;
  var lo = [bb.min.x, bb.min.y, bb.min.z], hi = [bb.max.x, bb.max.y, bb.max.z];
  var c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  c[dk] = NSO_bendRawCoordToDisplay(m, k, rawCoord);
  var hu = (hi[du] - lo[du]) / 2 + BEND_MARK_OVERHANG_MM, hv = (hi[dv] - lo[dv]) / 2 + BEND_MARK_OVERHANG_MM;
  function pt(a, b) { var p = c.slice(); p[du] += a; p[dv] += b; return p; }
  var group = new THREE.Group();
  group.name = 'bendMarker';
  group.matrixAutoUpdate = false;
  function overlay(o) {
    o.renderOrder = BEND_MARK_RENDER_ORDER; o.userData.skipXray = true; o.userData.bendMarker = true;
    o.raycast = function () {}; o.frustumCulled = false; return o;
  }
  var quad = [pt(-hu, -hv), pt(hu, -hv), pt(hu, hv), pt(-hu, hv)];
  var sheet = new THREE.BufferGeometry();
  sheet.setAttribute('position', new THREE.BufferAttribute(new Float32Array(quad.flat()), 3));
  sheet.setIndex([0, 1, 2, 0, 2, 3]);
  group.add(overlay(new THREE.Mesh(sheet, new THREE.MeshBasicMaterial({
    color: BEND_MARK_FILL, transparent: true, opacity: BEND_MARK_FILL_OPACITY, side: THREE.DoubleSide, depthTest: false, depthWrite: false }))));
  var frame = new THREE.BufferGeometry();
  frame.setAttribute('position', new THREE.BufferAttribute(new Float32Array([quad[0], quad[1], quad[1], quad[2], quad[2], quad[3], quad[3], quad[0]].flat()), 3));
  var frameLine = overlay(new THREE.LineSegments(frame, new THREE.LineBasicMaterial({
    color: BEND_MARK_COLOR, transparent: true, depthTest: false, depthWrite: false })));
  frameLine.userData.bendFrame = true;
  group.add(frameLine);
  group.userData.plane = { axis: ax.a, value: c[dk] };
  nsoHelpers.attach(state.scene, group, 'bend');
  NSO_bendUI().marker = group;
  NSO_bendFollow();
}

// Ghost and marker ride the piece's world transform.
function NSO_bendFollow() {
  var B = NSO_bendUI(), m = NSO_bendModel(), mesh = m && NSO_bendMeshOf(m);
  if (!mesh) return;
  mesh.updateMatrixWorld(true);
  var T = NSO_bendSpace(m).T;
  [B.ghost, B.marker].forEach(function (o) {
    if (!o) return;
    o.matrix.copy(mesh.matrixWorld);
    if (T) o.matrix.multiply(T);
    o.matrixWorldNeedsUpdate = true;
  });
}

/* ---------------------------------------------------------------- the panel */

function NSO_bendReadout(text, bad) {
  var el = NSO_bendEl('bend-readout');
  if (el) { el.textContent = text; el.classList.toggle('is-bad', !!bad); }
}

// Read the selected piece and fill the panel's defaults.
function NSO_bendLoad() {
  var B = NSO_bendUI(), m = NSO_bendModel();
  B.modelId = m ? m.id : null; B.soup = m ? m.rawTris : null; B.result = null; B.key = '';
  if (!m) { B.read = null; NSO_bendReadout('Select a piece to bend.', true); NSO_bendClear(); return; }
  var rd;
  try { rd = NSO_bendRead(NSO_bendSpace(m).f.rawTris); } catch (err) { rd = { ok: false, reason: (err && err.message) || String(err) }; }
  B.read = rd;
  var sel = NSO_bendEl('sel-bend-toward'), rollRow = NSO_bendEl('bend-roll-row');
  if (!rd.ok) {
    if (sel) sel.innerHTML = '';
    NSO_bendReadout('Bend: ' + rd.reason, true);
    NSO_bendClear();
    NSO_bendSyncButtons();
    return;
  }
  if (sel) {
    sel.innerHTML = '';
    rd.sides.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s.key; o.textContent = s.label;
      sel.appendChild(o);
    });
    sel.value = rd.defaultToward;
  }
  if (rollRow) rollRow.hidden = !!rd.rectangular;
  var w = NSO_bendEl('inp-bend-where'), a = NSO_bendEl('inp-bend-angle'), r = NSO_bendEl('inp-bend-radius'), ro = NSO_bendEl('inp-bend-roll');
  if (w) { w.value = rd.defaultWhereMm.toFixed(1); w.max = String(Math.floor(rd.lengthMm * 10) / 10); }
  if (a && !(+a.value >= 1 && +a.value <= 180)) a.value = '90';
  if (r) r.value = '';
  if (ro) ro.value = '0';
  NSO_bendRadiusHint();
  NSO_bendPreview();
}

function NSO_bendRadiusHint() {
  var B = NSO_bendUI(), r = NSO_bendEl('inp-bend-radius'), sel = NSO_bendEl('sel-bend-toward');
  if (!r || !B.read || !B.read.ok) return;
  var s = B.read.sides.filter(function (x) { return sel && x.key === sel.value; })[0];
  r.placeholder = s ? 'auto ' + NSO_sectionShowSafe(s.radiusMm) : 'auto';
}
function NSO_sectionShowSafe(x) { return (typeof NSO_sectionShow === 'function') ? NSO_sectionShow(x) : (+x).toFixed(1); }

function NSO_bendClear() { NSO_bendRemoveGhost(); NSO_bendRemoveMarker(); }

function NSO_bendSyncButtons() {
  var B = NSO_bendUI(), go = NSO_bendEl('btn-bend-go');
  if (go) go.disabled = !(B.result && B.result.ok);
}

// Run the bend on the current numbers; show the ghost or say why not.
function NSO_bendPreview() {
  var B = NSO_bendUI(), m = NSO_bendModel();
  if (!B.open || !m || !B.read || !B.read.ok) { NSO_bendSyncButtons(); return null; }
  var o = NSO_bendOpts();
  var key = m.id + '|' + JSON.stringify(o);
  if (B.key === key && B.soup === m.rawTris && B.result) { NSO_bendSyncButtons(); return B.result; }
  var r, f = NSO_bendSpace(m).f;
  try { r = NSO_bendRaw(f.rawTris, o); } catch (err) { r = { ok: false, reason: (err && err.message) || String(err) }; }
  B.result = r; B.key = key; B.soup = m.rawTris;
  var k = B.read.axisIdx, plane = B.read.min + (+o.where || 0);
  var aligned = NSO_bendFrameMatches(f);
  if (aligned && o.where != null) NSO_bendSetMarker(f, k, plane); else NSO_bendRemoveMarker();
  if (r.ok) {
    if (aligned) NSO_bendSetGhost(f, r.tris); else NSO_bendRemoveGhost();
    NSO_bendReadout(NSO_bendFmtDeg(r.angleDeg) + ' toward ' + r.toward + (r.roll ? ' rolled ' + r.roll + '°' : '') +
      ' at ' + r.whereMm.toFixed(1) + ' mm, radius ' + r.radius.toFixed(2) + ' mm · the arc runs ' + r.zone.fromMm.toFixed(1) +
      '–' + r.zone.toMm.toFixed(1) + ' mm · ' + r.counts.trisIn + ' → ' + r.counts.trisOut + ' faces' +
      (aligned ? '' : ' · (no ghost: the piece was turned since it was loaded)'));
  } else {
    NSO_bendRemoveGhost();
    NSO_bendReadout('Bend: ' + r.reason, true);
  }
  NSO_bendSyncButtons();
  return r;
}
function NSO_bendFmtDeg(d) { return (Math.round(d * 10) / 10) + '°'; }

function NSO_bendOpen() {
  var B = NSO_bendUI(), panel = NSO_bendEl('bend-panel'), btn = NSO_bendEl('btn-bend');
  B.open = true;
  if (panel) panel.hidden = false;
  if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.classList.add('is-on'); }
  NSO_bendLoad();
  NSO_bendTick();
}

function NSO_bendClose() {
  var B = NSO_bendUI(), panel = NSO_bendEl('bend-panel'), btn = NSO_bendEl('btn-bend');
  B.open = false; B.result = null; B.key = '';
  if (panel) panel.hidden = true;
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('is-on'); }
  NSO_bendClear();
  if (B.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(B.raf);
  B.raf = 0;
}

/* Bend's session, for the helper registry (nso-helpers.js). Leave-tool and
   Clear close it here: before, nothing did, so a session left open over a
   tube outlived Clear and drew its marker through the next piece loaded. An
   Undo under an open panel reloads it from the piece as it now is. */
if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('bend', {
  live: function () { return !!NSO_bendUI().open; },
  close: NSO_bendClose,
  clear: NSO_bendClear,
  refresh: function () { var B = NSO_bendUI(); B.key = ''; B.result = null; NSO_bendLoad(); }
});

// Per frame while open: follow the piece, and start over when the selection
// or the piece's soup changes under the panel (another bake, Undo, a click on
// another piece).
function NSO_bendTick() {
  var B = NSO_bendUI();
  if (!B.open) return;
  var m = NSO_bendModel();
  if ((m ? m.id : null) !== B.modelId || (m && m.rawTris !== B.soup)) NSO_bendLoad();
  else NSO_bendFollow();
  B.raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(NSO_bendTick) : 0;
}

// PAINT SCOPE: WHOLE-PIECE - see the header and docs/HANDOFF.md.
function NSO_bendSelectedModel(opts) {
  var m = NSO_bendModel();
  if (!m) { if (typeof setStatus === 'function') setStatus('Select a piece first', true); return { ok: false, reason: 'no selection' }; }
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    if (typeof setStatus === 'function') {
      setStatus('Bend stood down - ' + painted + ' painted face(s); a bend moves every face past it. Clear paint to bend.', true);
    }
    return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
  }
  var B = NSO_bendUI(), r, space = NSO_bendSpace(m);
  var o = opts || NSO_bendOpts();
  var key = m.id + '|' + JSON.stringify(o);
  if (!opts && B.result && B.key === key && B.soup === m.rawTris) r = B.result;
  else r = NSO_bendRaw(space.f.rawTris, o);
  if (!r.ok) {
    if (typeof setStatus === 'function') setStatus('Bend refused - piece unchanged (' + r.reason + ')', true);
    return r;
  }
  var hBefore = m.size ? m.size.y : null;
  var txt = 'Bend done - ' + NSO_bendFmtDeg(r.angleDeg) + ' toward ' + r.toward + (r.roll ? ' rolled ' + r.roll + '°' : '') + ' at ' +
    r.whereMm.toFixed(1) + ' mm, radius ' + r.radius.toFixed(2) + ' mm; ' + r.counts.trisIn + ' → ' + r.counts.trisOut +
    ' faces; section held to ' + r.sectionWorstMm.toExponential(1) + ' mm';
  NSO_sculptCommitRaw(m, space.toRaw(r.tris), 'bendReplace', txt);
  // The commit re-seats it on the plate. A bend that rises out of the plate's
  // plane leaves it standing up - say so, with the numbers.
  var hAfter = m.size ? m.size.y : null;
  if (hBefore != null && hAfter != null && Math.abs(hAfter - hBefore) > 0.05 && typeof setStatus === 'function') {
    setStatus(txt + '; re-seated on the plate, it now stands ' + hAfter.toFixed(1) + ' mm tall (was ' + hBefore.toFixed(1) + ' mm)');
  }
  r.heightBefore = hBefore; r.heightAfter = hAfter;
  return r;
}

if (typeof document !== 'undefined') {
  (function wireBend() {
    function onDown(ev) {
      var B = NSO_bendUI();
      if (!B.open || ev.button !== 0 || !state.raycaster || !state.camera || !state.renderer) return;
      if (ev.target !== state.renderer.domElement) return;
      var m = NSO_bendModel(), mesh = m && NSO_bendMeshOf(m);
      if (!mesh || !B.read || !B.read.ok) return;
      setPointerFromEvent(ev);
      state.raycaster.setFromCamera(state.pointer, state.camera);
      var hits = state.raycaster.intersectObject(mesh, false);
      if (!hits.length) return;
      mesh.updateMatrixWorld(true);
      var space = NSO_bendSpace(m);
      var toF = new THREE.Matrix4().copy(mesh.matrixWorld);
      if (space.T) toF.multiply(space.T);
      var local = hits[0].point.clone().applyMatrix4(toF.invert());
      var k = B.read.axisIdx, ax = NSO_bendRawToDisplayAxis(k);
      var raw = NSO_bendDisplayCoordToRaw(space.f, k, local[ax.a]);
      var where = Math.round((raw - B.read.min) * 10) / 10;
      var w = NSO_bendEl('inp-bend-where');
      if (w) w.value = where.toFixed(1);
      NSO_bendPreview();
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
    function wire() {
      var btn = NSO_bendEl('btn-bend');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () { if (NSO_bendUI().open) NSO_bendClose(); else NSO_bendOpen(); });
      var go = NSO_bendEl('btn-bend-go'), cancel = NSO_bendEl('btn-bend-cancel');
      if (go) go.addEventListener('click', function () {
        try {
          var r = NSO_bendSelectedModel();
          if (r && r.ok) NSO_bendClose();
        } catch (err) {
          console.error('[bend]', err);
          if (typeof setStatus === 'function') setStatus('Bend failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
        }
      });
      if (cancel) cancel.addEventListener('click', NSO_bendClose);
      ['inp-bend-where', 'inp-bend-angle', 'inp-bend-radius', 'inp-bend-roll'].forEach(function (id) {
        var el = NSO_bendEl(id);
        if (el) el.addEventListener('change', NSO_bendPreview);
      });
      var sel = NSO_bendEl('sel-bend-toward');
      if (sel) sel.addEventListener('change', function () { NSO_bendRadiusHint(); NSO_bendPreview(); });
      // Capture on window: ahead of app-core's canvas handler, so a click that
      // sets Where does not also start a drag or a selection.
      window.addEventListener('pointerdown', onDown, true);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
