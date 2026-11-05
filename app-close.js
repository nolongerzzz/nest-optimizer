// ===================== Close: the card =====================
// The geometry is nso_close.js (headless, tools/nso_close_test.js); this file
// is the card on it, in ADD, under Bridge. docs/CLOSE.md.
//
// Close puts a lid across an open end: a tube's end, an open box, any rim.
// While the card is open:
//   - HOVER outlines the rim under the pointer (its outer edge and the opening),
//     violet, drawn through the piece; a place that is not an open end shows
//     nothing and the readout says why;
//   - a CLICK picks that rim (captured ahead of select-and-drag, so the click
//     does not move the piece): it is outlined crimson, Thick is filled with the
//     wall there (editable), and a GHOST of the result - drawn as Tube edge's
//     is, from the very soup Set would commit - shows the lid. Inset sinks the
//     lid that far below the rim. A refusal takes the ghost away and says why.
//
// Set commits through the sculpt commit (undo type 'closeReplace'), so one
// Undo puts the whole piece back, and the piece re-seats on the plate the way
// any bake does.
//
// PAINT SCOPE: WHOLE-PIECE. Per the scoping rule in docs/HANDOFF.md: the
// opening's wall is cut and capped, and the commit re-seats the whole piece,
// so no paint can be promised to land where it was. Any paint stands it down,
// naming the count: nsoMaskCount(m) is the whole test.

var CLOSE_GHOST_COLOR = 0xf59e0b;       // Tube edge's ghost
var CLOSE_PICK_COLOR = 0xe11d48;        // crimson: reads on the amber ghost and the blue piece
var CLOSE_HOVER_COLOR = 0xa855f7;       // violet: the rim under the pointer
var CLOSE_RENDER_ORDER = 20;
var CLOSE_HINT = 'Click an open box or tube anywhere near its open end - the wall or the rim.';

function NSO_closeUI() {
  if (typeof state === 'undefined') return {};
  if (!state.close) {
    state.close = { open: false, modelId: null, soup: null, read: null, point: null, tri: null, result: null, key: '',
                    ghost: null, pick: null, hover: null, hoverKey: '', raf: 0, moveEv: null };
  }
  return state.close;
}
function NSO_closeEl(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
function NSO_closeModel() {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  return (m && m.rawTris && m.rawAxis === 'zup') ? m : null;
}
function NSO_closeMeshOf(m) {
  if (!m || typeof state === 'undefined') return null;
  var p = (state.placed || []).find(function (q) { return q && q.sourceId === m.id && q.mesh; });
  return p ? p.mesh : (state.previewMesh || null);
}
// Raw (z up) -> the piece's display frame: (x, z, -y) - centerOffset.
function NSO_closeRawToDisplay(m, p) {
  var o = m.centerOffset || { x: 0, y: 0, z: 0 };
  return [p[0] - o.x, p[2] - o.y, -p[1] - o.z];
}
function NSO_closeDisplayToRaw(m, d) {
  var o = m.centerOffset || { x: 0, y: 0, z: 0 };
  return [d.x + o.x, -(d.z + o.z), d.y + o.y];
}

/* The card's numbers as NSO_closeRaw opts. */
function NSO_closeOpts() {
  function num(id) { var el = NSO_closeEl(id); return el && el.value !== '' ? +el.value : null; }
  var B = NSO_closeUI();
  return { point: B.point, tri: B.tri, thickness: num('inp-close-thick'), inset: num('inp-close-inset') };
}

/* ---------------------------------------------------------------- drawing */

function NSO_closeDispose(o) {
  if (!o) return;
  if (o.parent) o.parent.remove(o);
  o.traverse(function (q) { if (q.geometry) q.geometry.dispose(); if (q.material) q.material.dispose(); });
}
function NSO_closeRemoveGhost() { var B = NSO_closeUI(); NSO_closeDispose(B.ghost); B.ghost = null; }
function NSO_closeRemovePick() { var B = NSO_closeUI(); NSO_closeDispose(B.pick); B.pick = null; }
function NSO_closeRemoveHover() { var B = NSO_closeUI(); NSO_closeDispose(B.hover); B.hover = null; B.hoverKey = ''; }
function NSO_closeClear() { NSO_closeRemoveGhost(); NSO_closeRemovePick(); NSO_closeRemoveHover(); }

function NSO_closeSetGhost(m, tris) {
  NSO_closeRemoveGhost();
  if (typeof THREE === 'undefined' || !state.scene || !tris || typeof rawResultToDisplayGeometry !== 'function') return;
  var geo = rawResultToDisplayGeometry(tris, m.centerOffset);
  var g = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: CLOSE_GHOST_COLOR, transparent: true, opacity: 0.75, metalness: 0.05, roughness: 0.5,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  g.name = 'closeGhost';
  g.userData.closeGhost = true;
  g.userData.skipXray = true;
  g.matrixAutoUpdate = false;
  g.raycast = function () {};
  nsoHelpers.attach(state.scene, g, 'close');
  NSO_closeUI().ghost = g;
  NSO_closeFollow();
}

// A rim: its outer edge and its opening, as two line loops read through the piece.
function NSO_closeRimLines(m, rim, color, name) {
  var group = new THREE.Group();
  group.name = name;
  group.matrixAutoUpdate = false;
  [rim.outer, rim.inner].forEach(function (loop) {
    var pts = [];
    loop.forEach(function (p) { pts.push.apply(pts, NSO_closeRawToDisplay(m, p)); });
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    var line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: color, transparent: true, depthTest: false, depthWrite: false }));
    line.renderOrder = CLOSE_RENDER_ORDER; line.userData.skipXray = true; line.userData.closeRim = true;
    line.raycast = function () {}; line.frustumCulled = false;
    group.add(line);
  });
  group.userData.loops = [rim.outer.length, rim.inner.length];
  nsoHelpers.attach(state.scene, group, 'close');
  return group;
}
function NSO_closeSetPick(m, rim) {
  NSO_closeRemovePick();
  if (typeof THREE === 'undefined' || !state.scene || !rim) return;
  NSO_closeUI().pick = NSO_closeRimLines(m, rim, CLOSE_PICK_COLOR, 'closeRim');
  NSO_closeFollow();
}
function NSO_closeSetHover(m, rim, key) {
  var B = NSO_closeUI();
  if (B.hover && B.hoverKey === key) return;
  NSO_closeRemoveHover();
  if (typeof THREE === 'undefined' || !state.scene || !rim) return;
  B.hover = NSO_closeRimLines(m, rim, CLOSE_HOVER_COLOR, 'closeHover');
  B.hoverKey = key;
  NSO_closeFollow();
}

function NSO_closeFollow() {
  var B = NSO_closeUI(), m = NSO_closeModel(), mesh = m && NSO_closeMeshOf(m);
  if (!mesh) return;
  mesh.updateMatrixWorld(true);
  [B.ghost, B.pick, B.hover].forEach(function (o) {
    if (!o) return;
    o.matrix.copy(mesh.matrixWorld);
    o.matrixWorldNeedsUpdate = true;
  });
}

/* ---------------------------------------------------------------- the card */

function NSO_closeReadout(text, bad) {
  var el = NSO_closeEl('close-readout');
  if (el) { el.textContent = text; el.classList.toggle('is-bad', !!bad); }
}
function NSO_closeSyncButtons() {
  var B = NSO_closeUI(), go = NSO_closeEl('btn-close-go');
  if (go) go.disabled = !(B.result && B.result.ok);
}

// Read the rim at B.point; fill Thick with the wall there.
function NSO_closeLoad() {
  var B = NSO_closeUI(), m = NSO_closeModel();
  if (!m || m.id !== B.modelId) { B.point = null; B.tri = null; }
  B.modelId = m ? m.id : null; B.soup = m ? m.rawTris : null; B.result = null; B.key = ''; B.read = null;
  NSO_closeRemoveGhost(); NSO_closeRemovePick();
  if (!m) { NSO_closeReadout('Select a piece with an open end.', true); NSO_closeSyncButtons(); return; }
  if (!B.point) { NSO_closeReadout(CLOSE_HINT, false); NSO_closeSyncButtons(); return; }
  var rd;
  try { rd = NSO_closeRead(m.rawTris, { point: B.point, tri: B.tri }); }
  catch (err) { rd = { ok: false, reason: (err && err.message) || String(err) }; }
  B.read = rd;
  if (!rd.ok) { NSO_closeReadout('Close: ' + rd.reason, true); NSO_closeSyncButtons(); return; }
  var T = NSO_closeEl('inp-close-thick');
  if (T) T.value = String(Math.round(rd.rim.wallMm * 100) / 100);
  NSO_closeSetPick(m, rd.rim);
  NSO_closePreview();
}

// Build the lid on the current numbers; show the ghost or say why not.
function NSO_closePreview() {
  var B = NSO_closeUI(), m = NSO_closeModel();
  if (!B.open || !m || !B.read || !B.read.ok) { NSO_closeSyncButtons(); return null; }
  var o = NSO_closeOpts();
  var key = m.id + '|' + JSON.stringify(o);
  if (B.key === key && B.soup === m.rawTris && B.result) { NSO_closeSyncButtons(); return B.result; }
  o.read = B.read;
  var r;
  try { r = NSO_closeRaw(m.rawTris, o); }
  catch (err) { r = { ok: false, reason: (err && err.message) || String(err) }; }
  B.result = r; B.key = key; B.soup = m.rawTris;
  var aligned = (typeof NSO_bendFrameMatches === 'function') ? NSO_bendFrameMatches(m) : true;
  if (r.ok) {
    if (aligned) NSO_closeSetGhost(m, r.tris); else NSO_closeRemoveGhost();
    NSO_closeReadout(r.reason + ' · ' + r.counts.trisIn + ' → ' + r.counts.trisOut + ' faces' +
      (aligned ? '' : ' · (no ghost: the piece was turned since it was loaded)'));
  } else {
    NSO_closeRemoveGhost();
    NSO_closeReadout('Close: ' + r.reason, true);
  }
  NSO_closeSyncButtons();
  return r;
}

function NSO_closeOpen() {
  var B = NSO_closeUI(), panel = NSO_closeEl('close-panel'), btn = NSO_closeEl('btn-close');
  // Tube edge, Bend and Bridge take the same click on the piece: one card at a time.
  if (typeof NSO_teUI === 'function' && NSO_teUI().open && typeof NSO_teClose === 'function') NSO_teClose();
  if (typeof NSO_bendUI === 'function' && NSO_bendUI().open && typeof NSO_bendClose === 'function') NSO_bendClose();
  if (typeof NSO_bridgeUI === 'function' && NSO_bridgeUI().open && typeof NSO_bridgeClose === 'function') NSO_bridgeClose();
  B.open = true; B.point = null; B.tri = null;
  var I = NSO_closeEl('inp-close-inset');
  if (I && I.value === '') I.value = '0';
  if (panel) panel.hidden = false;
  if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.classList.add('is-on'); }
  NSO_closeLoad();
  NSO_closeTick();
}
function NSO_closeClose() {
  var B = NSO_closeUI(), panel = NSO_closeEl('close-panel'), btn = NSO_closeEl('btn-close');
  B.open = false; B.result = null; B.key = ''; B.read = null; B.point = null; B.tri = null; B.moveEv = null;
  if (panel) panel.hidden = true;
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('is-on'); }
  NSO_closeClear();
  if (B.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(B.raf);
  B.raf = 0;
}

// Close's session, for the helper registry (nso-helpers.js) - Tube edge's
// contract: leave-tool and Clear close it, an Undo under it reloads it.
if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('close', {
  live: function () { return !!NSO_closeUI().open; },
  close: NSO_closeClose,
  clear: NSO_closeClear,
  refresh: NSO_closeLoad
});

// The rim under a pointer event, or null: { m, point, tri, read }.
function NSO_closeRimAt(ev) {
  if (!state.raycaster || !state.camera || !state.renderer || ev.target !== state.renderer.domElement) return null;
  var m = NSO_closeModel(), mesh = m && NSO_closeMeshOf(m);
  if (!mesh) return null;
  setPointerFromEvent(ev);
  state.raycaster.setFromCamera(state.pointer, state.camera);
  var hits = state.raycaster.intersectObject(mesh, false);
  if (!hits.length) return null;
  mesh.updateMatrixWorld(true);
  var local = hits[0].point.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
  var point = NSO_closeDisplayToRaw(m, local), tri = hits[0].faceIndex != null ? hits[0].faceIndex : null;
  var rd;
  try { rd = NSO_closeRead(m.rawTris, { point: point, tri: tri }); } catch (err) { rd = { ok: false, reason: String(err) }; }
  return { m: m, point: point, tri: tri, read: rd };
}

// Per frame while open: follow the piece, the hover outline (one read per
// frame, however many moves came in), and start over when the selection or
// the piece's soup changes under the card.
function NSO_closeTick() {
  var B = NSO_closeUI();
  if (!B.open) return;
  if ((typeof NSO_teUI === 'function' && NSO_teUI().open) || (typeof NSO_bendUI === 'function' && NSO_bendUI().open) ||
      (typeof NSO_bridgeUI === 'function' && NSO_bridgeUI().open)) { NSO_closeClose(); return; }
  var m = NSO_closeModel();
  if ((m ? m.id : null) !== B.modelId || (m && m.rawTris !== B.soup)) NSO_closeLoad();
  if (B.moveEv) {
    var ev = B.moveEv, at = null;
    B.moveEv = null;
    try { at = NSO_closeRimAt(ev); } catch (err) { at = null; }
    if (at && at.read.ok) {
      var r0 = at.read.rim.inner[0];
      NSO_closeSetHover(at.m, at.read.rim, at.m.id + '|' + at.read.rim.innerVids.length + '|' + r0.join(','));
      if (!B.read || !B.read.ok) NSO_closeReadout('Under the pointer: ' + at.read.reason + ' - click to close it.', false);
    } else {
      NSO_closeRemoveHover();
      if (!B.read) NSO_closeReadout(at && at.read && !at.read.ok ? 'Under the pointer: ' + at.read.reason : CLOSE_HINT, !!(at && !at.read.ok));
    }
  }
  NSO_closeFollow();
  B.raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(NSO_closeTick) : 0;
}

// PAINT SCOPE: WHOLE-PIECE - see the header and docs/HANDOFF.md.
function NSO_closeSelectedModel(opts) {
  var m = NSO_closeModel();
  if (!m) { if (typeof setStatus === 'function') setStatus('Select a piece first', true); return { ok: false, reason: 'no selection' }; }
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    if (typeof setStatus === 'function') {
      setStatus('Close stood down - ' + painted + ' painted face(s); it cuts the opening\'s wall and re-seats the piece. Clear paint to close it.', true);
    }
    return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
  }
  var B = NSO_closeUI(), r;
  var o = opts || NSO_closeOpts();
  var key = m.id + '|' + JSON.stringify(o);
  if (!opts && B.result && B.key === key && B.soup === m.rawTris) r = B.result;
  else r = NSO_closeRaw(m.rawTris, o);
  if (!r.ok) {
    if (typeof setStatus === 'function') setStatus('Close refused - piece unchanged (' + r.reason + ')', true);
    return r;
  }
  var txt = 'Close done - ' + r.reason + '; ' + r.counts.trisIn + ' → ' + r.counts.trisOut + ' faces';
  NSO_sculptCommitRaw(m, r.tris, 'closeReplace', txt);
  return r;
}

if (typeof document !== 'undefined') {
  (function wireClose() {
    function onDown(ev) {
      var B = NSO_closeUI();
      if (!B.open || ev.button !== 0) return;
      var at = NSO_closeRimAt(ev);
      if (!at) return;                      // empty space: the view still orbits
      B.point = at.point; B.tri = at.tri;
      NSO_closeLoad();
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
    function onMove(ev) {
      var B = NSO_closeUI();
      if (!B.open || ev.buttons) return;
      B.moveEv = ev;
    }
    function wire() {
      var btn = NSO_closeEl('btn-close');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () { if (NSO_closeUI().open) NSO_closeClose(); else NSO_closeOpen(); });
      var go = NSO_closeEl('btn-close-go'), cancel = NSO_closeEl('btn-close-cancel');
      if (go) go.addEventListener('click', function () {
        try {
          var r = NSO_closeSelectedModel();
          if (r && r.ok) NSO_closeClose();
        } catch (err) {
          console.error('[close]', err);
          if (typeof setStatus === 'function') setStatus('Close failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
        }
      });
      if (cancel) cancel.addEventListener('click', NSO_closeClose);
      ['inp-close-thick', 'inp-close-inset'].forEach(function (id) {
        var el = NSO_closeEl(id);
        if (el) el.addEventListener('change', NSO_closePreview);
      });
      // Capture on window: ahead of app-core's canvas handler, so a click that
      // picks the rim does not also start a drag or a selection.
      window.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointermove', onMove, true);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
