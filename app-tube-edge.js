// ===================== Tube edge: the card =====================
// The geometry is nso_tube_edge.js (headless, tools/nso_tube_edge_test.js);
// this file is the card on it, in Finish -> Shape, beside Bend.
// docs/TUBE-EDGE.md.
//
// Flare, Roll or Neck; Out for the first two (In refuses: not yet), then the
// verb's numbers:
//   Flare  Length, Angle and Δr (linked: edit either, the other follows),
//          Profile Straight or Trumpet
//   Roll   Radius, Angle (90 / 180 / 270 offered, any typed up to 360)
//   Neck   Length, Δr (below 0 pinches, above 0 bulges), Profile Smooth or
//          Funnel - nso_tube_neck.js, a band anywhere along the tube
// and Set or Cancel.
//
// While the card is open:
//   - a GHOST of the result sits on the piece, drawn as Bend's is (amber,
//     0.75), from the very soup Set would commit: every change runs
//     NSO_tubeEdgeRaw and the ghost is what came back. A refusal takes the
//     ghost away and the readout says why;
//   - an amber RING marks the end being treated, drawn through the piece -
//     for Neck, two rings mark the band's two ends;
//   - a click on the piece picks the end nearest the click (captured ahead
//     of select-and-drag, so the click does not move the piece). Bend's
//     "where" interaction, for an end. For Neck the click is where the band
//     is centred, along the tube.
//
// Set commits through the sculpt commit (undo type 'tubeEdgeReplace', or
// 'tubeNeckReplace' for a neck), so one Undo puts the whole piece back, and
// the piece re-seats on the plate the way any bake does. Several necks on one
// tube are several Sets, each its own Undo.
//
// PAINT SCOPE: WHOLE-PIECE. Per the scoping rule in docs/HANDOFF.md: the end
// face is taken out and the wall rebuilt past it, and the commit re-seats the
// whole piece, so no paint can be promised to land where it was. Any paint
// stands it down, naming the count: nsoMaskCount(m) is the whole test.

var TUBE_EDGE_GHOST_COLOR = 0xf59e0b;      // Bend's ghost
var TUBE_EDGE_RING_COLOR = 0xffc83d;       // Bend's marker frame
var TUBE_EDGE_RENDER_ORDER = 20;

function NSO_teUI() {
  if (typeof state === 'undefined') return {};
  if (!state.tubeEdge) {
    state.tubeEdge = { open: false, modelId: null, soup: null, read: null, point: null, result: null, key: '',
                       ghost: null, ring: null, raf: 0, lead: 'angle', readVerb: '', hidPiece: null };
  }
  return state.tubeEdge;
}
function NSO_teEl(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
function NSO_teModel() {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  return (m && m.rawTris && m.rawAxis === 'zup') ? m : null;
}
function NSO_teMeshOf(m) {
  if (!m || typeof state === 'undefined') return null;
  var p = (state.placed || []).find(function (q) { return q && q.sourceId === m.id && q.mesh; });
  return p ? p.mesh : (state.previewMesh || null);
}
// Raw (z up) -> the piece's display frame: (x, z, -y) - centerOffset.
function NSO_teRawToDisplay(m, p) {
  var o = m.centerOffset || { x: 0, y: 0, z: 0 };
  return [p[0] - o.x, p[2] - o.y, -p[1] - o.z];
}
function NSO_teDisplayToRaw(m, d) {
  var o = m.centerOffset || { x: 0, y: 0, z: 0 };
  return [d.x + o.x, -(d.z + o.z), d.y + o.y];
}

/* The card's numbers as NSO_tubeEdgeRaw opts. */
function NSO_teOpts() {
  function num(id) { var el = NSO_teEl(id); return el && el.value !== '' ? +el.value : null; }
  function val(id, d) { var el = NSO_teEl(id); return el ? el.value : d; }
  var B = NSO_teUI(), verb = val('sel-te-verb', 'flare');
  if (verb === 'neck') {
    return { verb: 'neck', point: B.point, length: num('inp-te-neck-length'), dr: num('inp-te-neck-dr'),
             profile: val('sel-te-neck-profile', 'smooth') };
  }
  var o = { verb: verb, direction: val('sel-te-dir', 'out'), point: B.point };
  if (verb === 'flare') {
    o.length = num('inp-te-length'); o.profile = val('sel-te-profile', 'straight');
    if (B.lead === 'dr') o.dr = num('inp-te-dr'); else o.angle = num('inp-te-angle');
  } else {
    o.radius = num('inp-te-radius'); o.angle = num('inp-te-roll-angle');
  }
  return o;
}

/* Angle and Δr are one number said two ways over the Length: edit either,
   the other follows; a new Length keeps whichever was edited last. */
function NSO_teLink(from) {
  var B = NSO_teUI(), L = NSO_teEl('inp-te-length'), A = NSO_teEl('inp-te-angle'), D = NSO_teEl('inp-te-dr');
  if (!L || !A || !D) return;
  if (from === 'angle' || from === 'dr') B.lead = from;
  var len = +L.value;
  if (!(len > 0)) return;
  if (B.lead === 'dr') {
    if (D.value === '' || !isFinite(+D.value)) return;
    A.value = String(Math.round(Math.atan2(+D.value, len) * 180 / Math.PI * 10) / 10);
  } else {
    if (A.value === '' || !isFinite(+A.value)) return;
    D.value = String(Math.round(len * Math.tan(+A.value * Math.PI / 180) * 100) / 100);
  }
}

/* ---------------------------------------------------------------- drawing */

function NSO_teRemoveGhost() {
  var B = NSO_teUI();
  if (B.ghost) {
    if (B.ghost.parent) B.ghost.parent.remove(B.ghost);
    if (B.ghost.geometry) B.ghost.geometry.dispose();
    if (B.ghost.material) B.ghost.material.dispose();
    B.ghost = null;
  }
  // a neck's ghost hid the piece it stands in: show it again
  if (B.hidPiece) { B.hidPiece.visible = true; B.hidPiece = null; }
}
function NSO_teRemoveRing() {
  var B = NSO_teUI();
  if (B.ring) {
    if (B.ring.parent) B.ring.parent.remove(B.ring);
    B.ring.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    B.ring = null;
  }
}
function NSO_teClear() { NSO_teRemoveGhost(); NSO_teRemoveRing(); }

// hidePiece: a neck's ghost lies inside the piece wherever it pinches, so
// while it is up the piece itself is hidden (the ghost is the whole result,
// and the band's rings mark where it changed); NSO_teRemoveGhost shows it.
function NSO_teSetGhost(m, tris, hidePiece) {
  NSO_teRemoveGhost();
  if (typeof THREE === 'undefined' || !state.scene || !tris || typeof rawResultToDisplayGeometry !== 'function') return;
  var geo = rawResultToDisplayGeometry(tris, m.centerOffset);
  var g = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: TUBE_EDGE_GHOST_COLOR, transparent: true, opacity: 0.75, metalness: 0.05, roughness: 0.5,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  g.name = 'tubeEdgeGhost';
  g.userData.tubeEdgeGhost = true;
  g.userData.skipXray = true;
  g.matrixAutoUpdate = false;
  nsoHelpers.attach(state.scene, g, 'tube-edge');
  NSO_teUI().ghost = g;
  var mesh = hidePiece ? NSO_teMeshOf(m) : null;
  if (mesh && mesh.visible) { mesh.visible = false; NSO_teUI().hidPiece = mesh; }
  NSO_teFollow();
}

// The end being treated: its two circles, amber, read through the piece.
function NSO_teSetRing(m, end) {
  NSO_teRemoveRing();
  if (typeof THREE === 'undefined' || !state.scene || !end) return;
  var group = new THREE.Group();
  group.name = 'tubeEdgeRing';
  group.matrixAutoUpdate = false;
  var C = end.center, e1 = end.frame.e1, e2 = end.frame.e2;
  [end.Ro, end.Ri].forEach(function (r) {
    var pts = [];
    for (var i = 0; i < 96; i++) {
      var a = 2 * Math.PI * i / 96, c = Math.cos(a) * r, s = Math.sin(a) * r;
      pts.push(NSO_teRawToDisplay(m, [C[0] + c * e1[0] + s * e2[0], C[1] + c * e1[1] + s * e2[1], C[2] + c * e1[2] + s * e2[2]]));
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts.flat()), 3));
    var line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: TUBE_EDGE_RING_COLOR, transparent: true, depthTest: false, depthWrite: false }));
    line.renderOrder = TUBE_EDGE_RENDER_ORDER; line.userData.skipXray = true; line.userData.tubeEdgeRing = true;
    line.raycast = function () {}; line.frustumCulled = false;
    group.add(line);
  });
  group.userData.center = NSO_teRawToDisplay(m, C);
  nsoHelpers.attach(state.scene, group, 'tube-edge');
  NSO_teUI().ring = group;
  NSO_teFollow();
}

// The neck's band: the outside circle at each of its two ends.
function NSO_teSetBandRing(m, r) {
  NSO_teRemoveRing();
  if (typeof THREE === 'undefined' || !state.scene || !r || !r.band || !r.tube) return;
  var tb = r.tube, b = r.band, C = tb.center, a = tb.axis, e1 = tb.frame.e1, e2 = tb.frame.e2;
  var rad = b.Ro != null ? b.Ro : tb.endRo;
  var group = new THREE.Group();
  group.name = 'tubeEdgeRing';
  group.matrixAutoUpdate = false;
  [b.ha, b.hb].forEach(function (h) {
    var pts = [], O = [C[0] + h * a[0], C[1] + h * a[1], C[2] + h * a[2]];
    for (var i = 0; i < 96; i++) {
      var ang = 2 * Math.PI * i / 96, c = Math.cos(ang) * rad, s = Math.sin(ang) * rad;
      pts.push(NSO_teRawToDisplay(m, [O[0] + c * e1[0] + s * e2[0], O[1] + c * e1[1] + s * e2[1], O[2] + c * e1[2] + s * e2[2]]));
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts.flat()), 3));
    var line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: TUBE_EDGE_RING_COLOR, transparent: true, depthTest: false, depthWrite: false }));
    line.renderOrder = TUBE_EDGE_RENDER_ORDER; line.userData.skipXray = true; line.userData.tubeEdgeRing = true;
    line.raycast = function () {}; line.frustumCulled = false;
    group.add(line);
  });
  group.userData.center = NSO_teRawToDisplay(m, [C[0] + b.h0 * a[0], C[1] + b.h0 * a[1], C[2] + b.h0 * a[2]]);
  group.userData.band = [b.ha, b.hb];
  state.scene.add(group);
  NSO_teUI().ring = group;
  NSO_teFollow();
}

function NSO_teFollow() {
  var B = NSO_teUI(), m = NSO_teModel(), mesh = m && NSO_teMeshOf(m);
  if (!mesh) return;
  mesh.updateMatrixWorld(true);
  [B.ghost, B.ring].forEach(function (o) {
    if (!o) return;
    o.matrix.copy(mesh.matrixWorld);
    o.matrixWorldNeedsUpdate = true;
  });
}

/* ---------------------------------------------------------------- the card */

function NSO_teReadout(text, bad) {
  var el = NSO_teEl('te-readout');
  if (el) { el.textContent = text; el.classList.toggle('is-bad', !!bad); }
}
function NSO_teSyncRows() {
  var verb = (NSO_teEl('sel-te-verb') || {}).value || 'flare';
  ['te-flare-rows'].forEach(function (id) { var el = NSO_teEl(id); if (el) el.hidden = verb !== 'flare'; });
  ['te-roll-rows'].forEach(function (id) { var el = NSO_teEl(id); if (el) el.hidden = verb !== 'roll'; });
  ['te-neck-rows'].forEach(function (id) { var el = NSO_teEl(id); if (el) el.hidden = verb !== 'neck'; });
  ['te-dir-row'].forEach(function (id) { var el = NSO_teEl(id); if (el) el.hidden = verb === 'neck'; });
}
function NSO_teSyncButtons() {
  var B = NSO_teUI(), go = NSO_teEl('btn-te-go');
  if (go) go.disabled = !(B.result && B.result.ok);
}

function NSO_teVerb() { return (NSO_teEl('sel-te-verb') || {}).value || 'flare'; }

// Read the selected piece (the end nearest B.point, else the top end; for a
// neck, the tube's axis) and fill the card's blank fields from the wall.
function NSO_teLoad() {
  var B = NSO_teUI(), m = NSO_teModel(), neck = NSO_teVerb() === 'neck';
  if (!m || m.id !== B.modelId) B.point = null;
  B.modelId = m ? m.id : null; B.soup = m ? m.rawTris : null; B.result = null; B.key = '';
  B.readVerb = neck ? 'neck' : 'end';
  if (!m) { B.read = null; NSO_teReadout('Select a tube to flare, roll or neck.', true); NSO_teClear(); NSO_teSyncButtons(); return; }
  var rd;
  try { rd = neck ? NSO_tubeNeckRead(m.rawTris) : NSO_tubeEdgeRead(m.rawTris, { point: B.point }); }
  catch (err) { rd = { ok: false, reason: (err && err.message) || String(err) }; }
  B.read = rd;
  if (!rd.ok) { NSO_teReadout((neck ? 'Neck: ' : 'Tube edge: ') + rd.reason, true); NSO_teClear(); NSO_teSyncButtons(); return; }
  if (neck) {
    // blank fields take defaults from the wall at the end: 7.5 walls long, in
    // by 2.5 walls (a 1.6 mm wall: 12 mm, -4)
    var tw = rd.tube.endRo - rd.tube.endRi;
    var NL = NSO_teEl('inp-te-neck-length'), ND = NSO_teEl('inp-te-neck-dr');
    if (NL && NL.value === '') NL.value = String(Math.max(4, Math.round(7.5 * tw)));
    if (ND && ND.value === '') ND.value = String(-Math.max(0.5, Math.round(5 * tw) / 2));
    NSO_teRemoveRing();
    NSO_tePreview();
    return;
  }
  {
    // blank fields take defaults from the wall; typed ones are kept
    var t = rd.end.wallMm;
    var L = NSO_teEl('inp-te-length'), A = NSO_teEl('inp-te-angle'), R = NSO_teEl('inp-te-radius'), RA = NSO_teEl('inp-te-roll-angle');
    if (L && L.value === '') L.value = String(Math.max(3, Math.round(4 * t)));
    if (A && A.value === '') A.value = '30';
    if (R && R.value === '') R.value = String(Math.max(1, Math.round(3 * t) / 2));
    if (RA && RA.value === '') RA.value = '180';
    NSO_teLink();
  }
  NSO_teSetRing(m, rd.end);
  NSO_tePreview();
}

// Run the treatment on the current numbers; show the ghost or say why not.
function NSO_tePreview() {
  var B = NSO_teUI(), m = NSO_teModel();
  if (B.open && m && B.readVerb !== (NSO_teVerb() === 'neck' ? 'neck' : 'end')) { NSO_teLoad(); return B.result; }
  if (!B.open || !m || !B.read || !B.read.ok) { NSO_teSyncButtons(); return null; }
  var o = NSO_teOpts(), neck = o.verb === 'neck';
  var key = m.id + '|' + JSON.stringify(o);
  if (B.key === key && B.soup === m.rawTris && B.result) { NSO_teSyncButtons(); return B.result; }
  o.read = B.read;
  var r;
  try { r = neck ? NSO_tubeNeckRaw(m.rawTris, o) : NSO_tubeEdgeRaw(m.rawTris, o); }
  catch (err) { r = { ok: false, reason: (err && err.message) || String(err) }; }
  B.result = r; B.key = key; B.soup = m.rawTris;
  if (neck) { if (r.band && r.tube) NSO_teSetBandRing(m, r); else NSO_teRemoveRing(); }
  var aligned = (typeof NSO_bendFrameMatches === 'function') ? NSO_bendFrameMatches(m) : true;
  if (r.ok) {
    if (aligned) NSO_teSetGhost(m, r.tris, neck); else NSO_teRemoveGhost();
    NSO_teReadout(r.reason + ' · ' + r.counts.trisIn + ' → ' + r.counts.trisOut + ' faces' +
      (aligned ? '' : ' · (no ghost: the piece was turned since it was loaded)'));
  } else {
    NSO_teRemoveGhost();
    NSO_teReadout((neck ? 'Neck: ' : 'Tube edge: ') + r.reason, true);
  }
  NSO_teSyncButtons();
  return r;
}

function NSO_teOpen() {
  var B = NSO_teUI(), panel = NSO_teEl('te-panel'), btn = NSO_teEl('btn-tube-edge');
  if (typeof NSO_bendUI === 'function' && NSO_bendUI().open && typeof NSO_bendClose === 'function') NSO_bendClose();
  B.open = true;
  if (panel) panel.hidden = false;
  if (btn) { btn.setAttribute('aria-expanded', 'true'); btn.classList.add('is-on'); }
  NSO_teSyncRows();
  NSO_teLoad();
  NSO_teTick();
}
function NSO_teClose() {
  var B = NSO_teUI(), panel = NSO_teEl('te-panel'), btn = NSO_teEl('btn-tube-edge');
  B.open = false; B.result = null; B.key = '';
  if (panel) panel.hidden = true;
  if (btn) { btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('is-on'); }
  NSO_teClear();
  if (B.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(B.raf);
  B.raf = 0;
}

// Tube edge's session, for the helper registry (nso-helpers.js) - Bend's
// contract: leave-tool and Clear close it, an Undo under it reloads it.
if (typeof nsoHelpers !== 'undefined') nsoHelpers.owner('tube-edge', {
  live: function () { return !!NSO_teUI().open; },
  close: NSO_teClose,
  clear: NSO_teClear,
  refresh: NSO_teLoad
});

// Per frame while open: follow the piece, and start over when the selection
// or the piece's soup changes under the card (another bake, Undo, another piece).
function NSO_teTick() {
  var B = NSO_teUI();
  if (!B.open) return;
  // Bend and Tube edge share the piece and the click: one card at a time.
  if (typeof NSO_bendUI === 'function' && NSO_bendUI().open) { NSO_teClose(); return; }
  var m = NSO_teModel();
  if ((m ? m.id : null) !== B.modelId || (m && m.rawTris !== B.soup)) NSO_teLoad();
  else NSO_teFollow();
  B.raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(NSO_teTick) : 0;
}

// PAINT SCOPE: WHOLE-PIECE - see the header and docs/HANDOFF.md.
function NSO_teSelectedModel(opts) {
  var m = NSO_teModel();
  if (!m) { if (typeof setStatus === 'function') setStatus('Select a piece first', true); return { ok: false, reason: 'no selection' }; }
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    if (typeof setStatus === 'function') {
      setStatus('Tube edge stood down - ' + painted + ' painted face(s); it rebuilds the wall and re-seats the piece. Clear paint to flare, roll or neck.', true);
    }
    return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
  }
  var B = NSO_teUI(), r;
  var o = opts || NSO_teOpts(), neck = o.verb === 'neck', name = neck ? 'Neck' : 'Tube edge';
  var key = m.id + '|' + JSON.stringify(o);
  if (!opts && B.result && B.key === key && B.soup === m.rawTris) r = B.result;
  else r = neck ? NSO_tubeNeckRaw(m.rawTris, o) : NSO_tubeEdgeRaw(m.rawTris, o);
  if (!r.ok) {
    if (typeof setStatus === 'function') setStatus(name + ' refused - piece unchanged (' + r.reason + ')', true);
    return r;
  }
  var txt = name + ' done - ' + r.reason + '; ' + r.counts.trisIn + ' → ' + r.counts.trisOut + ' faces';
  NSO_sculptCommitRaw(m, r.tris, neck ? 'tubeNeckReplace' : 'tubeEdgeReplace', txt);
  return r;
}

if (typeof document !== 'undefined') {
  (function wireTubeEdge() {
    function onDown(ev) {
      var B = NSO_teUI();
      if (!B.open || ev.button !== 0 || !state.raycaster || !state.camera || !state.renderer) return;
      if (ev.target !== state.renderer.domElement) return;
      var m = NSO_teModel(), mesh = m && NSO_teMeshOf(m);
      if (!mesh) return;
      setPointerFromEvent(ev);
      state.raycaster.setFromCamera(state.pointer, state.camera);
      var hits = state.raycaster.intersectObject(mesh, false);
      if (!hits.length) return;
      mesh.updateMatrixWorld(true);
      var local = hits[0].point.clone().applyMatrix4(new THREE.Matrix4().copy(mesh.matrixWorld).invert());
      B.point = NSO_teDisplayToRaw(m, local);
      if (NSO_teVerb() === 'neck' && B.read && B.read.ok && B.readVerb === 'neck') NSO_tePreview(); else NSO_teLoad();
      ev.stopImmediatePropagation();
      ev.preventDefault();
    }
    function wire() {
      var btn = NSO_teEl('btn-tube-edge');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () { if (NSO_teUI().open) NSO_teClose(); else NSO_teOpen(); });
      var go = NSO_teEl('btn-te-go'), cancel = NSO_teEl('btn-te-cancel');
      if (go) go.addEventListener('click', function () {
        try {
          var r = NSO_teSelectedModel();
          if (r && r.ok) NSO_teClose();
        } catch (err) {
          console.error('[tube edge]', err);
          if (typeof setStatus === 'function') setStatus('Tube edge failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
        }
      });
      if (cancel) cancel.addEventListener('click', NSO_teClose);
      var verb = NSO_teEl('sel-te-verb');
      if (verb) verb.addEventListener('change', function () {
        // an end's click and a neck's are different places: a switch between
        // them starts from the default (the top end, the middle of the tube)
        var B = NSO_teUI();
        if (B.readVerb && B.readVerb !== (NSO_teVerb() === 'neck' ? 'neck' : 'end')) B.point = null;
        NSO_teSyncRows(); NSO_tePreview();
      });
      ['sel-te-dir', 'sel-te-profile', 'inp-te-radius', 'inp-te-roll-angle',
       'inp-te-neck-length', 'inp-te-neck-dr', 'sel-te-neck-profile'].forEach(function (id) {
        var el = NSO_teEl(id);
        if (el) el.addEventListener('change', NSO_tePreview);
      });
      [['inp-te-length', null], ['inp-te-angle', 'angle'], ['inp-te-dr', 'dr']].forEach(function (p) {
        var el = NSO_teEl(p[0]);
        if (el) el.addEventListener('change', function () { NSO_teLink(p[1]); NSO_tePreview(); });
      });
      // Capture on window: ahead of app-core's canvas handler, so a click that
      // picks the end does not also start a drag or a selection.
      window.addEventListener('pointerdown', onDown, true);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
