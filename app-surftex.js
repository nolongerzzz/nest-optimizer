// ===================== Wrap: the card =====================
// The geometry is nso_surftex.js (with nso_cdt.js and nso_weave.js under it; presets in nso_surftex_presets.js; headless,
// tools/nso_surftex_test.js); this file is the card on it, the left bar's WRAP, under Weave. docs/SURFTEX.md.
//
// A wrap is ONE feature - a ball, a spike or pyramid, a bump, a dent, a line - laid over a face on a lattice and baked into the piece.
//   1. FACE. The piece is cut into smooth faces (neighbouring triangles turned less than the Crease) and each is read: a flat face, a
//      cylinder's side, a tube's bore, a sphere or dome, or a contoured face. Pick one - it is tinted amber on the piece - or "All faces".
//   2. SKIN. A preset (one for each design on the two plates, and the five single features), or set the feature by hand:
//        Size / Length   the footprint, mm (a round feature's diameter, a pyramid's side, a line's width and length)
//        Height / Depth  how far a ball, spike, bump or ridge stands off the face / a dent or groove goes into it
//        Spacing / Row   centre to centre, across and between rows - or Density, features per cm2, which sets the spacing
//        Layout          grid, stagger, hex, diamond; Rotate turns each feature, Lattice turns the whole lattice
//   3. WRAP. Lays it: the face is replaced by a new patch that meets the old mesh rim corner for corner - no boolean. One Undo.
//   The card is live (app-surftex-live.js): Feature and Layout are tiles, and while the card is open the piece shows the wrap as a ghost,
//   redrawn as any number moves; WRAP installs the result that is on screen.
//
// PAINT SCOPE: WHOLE-PIECE. Per the scoping rule in docs/HANDOFF.md: a new patch renumbers triangles, and paint names its faces by
// axis and side - so any paint stands Wrap down, naming the count: nsoMaskCount(m) is the whole test (the same stand-down as Weave).

var SURFTEX_FACE_COLOR = 0xffc83d;

function NSO_surftexUI() {
  if (typeof state === 'undefined') return {};
  if (!state.surftex) state.surftex = { open: false, modelId: null, soup: null, reg: null, picked: -1, group: null, busy: false };
  return state.surftex;
}
function NSO_surftexEl(id) { return (typeof document !== 'undefined') ? document.getElementById(id) : null; }
function NSO_surftexModel() {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  return (m && m.rawTris && m.rawAxis === 'zup') ? m : null;
}
function NSO_surftexInt(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
function NSO_surftexReadout(text, bad) {
  var el = NSO_surftexEl('surftex-readout');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('bend-readout-bad', !!bad);
}

/* ---- the controls, read where they are used ------------------------------- */
var NSO_SURFTEX_FIELDS = [
  ['size', 'inp-surftex-size'], ['sizeV', 'inp-surftex-sizev'], ['height', 'inp-surftex-height'], ['depth', 'inp-surftex-depth'],
  ['spacing', 'inp-surftex-spacing'], ['spacingV', 'inp-surftex-row'], ['density', 'inp-surftex-density'], ['rot', 'inp-surftex-rot'],
  ['angle', 'inp-surftex-angle'], ['margin', 'inp-surftex-margin'], ['curve', 'inp-surftex-curve']
];
function NSO_surftexParams() {
  var p = {}, v;
  NSO_SURFTEX_FIELDS.forEach(function (f) {
    var el = NSO_surftexEl(f[1]);
    if (!el || el.value === '') return;
    v = parseFloat(el.value);
    if (isFinite(v)) p[f[0]] = v;
  });
  var sel = function (id) { var e = NSO_surftexEl(id); return e ? e.value : null; };
  p.motif = sel('sel-surftex-motif') || 'spike';
  p.layout = sel('sel-surftex-layout') || 'grid';
  p.sides = parseInt(sel('sel-surftex-sides') || '0', 10) || 0;
  p.profile = sel('sel-surftex-profile') || 'tri';
  var rg = NSO_surftexEl('chk-surftex-groove');
  p.ridge = !(rg && rg.checked);
  return p;
}
function NSO_surftexSetParams(p) {
  var R = (typeof NSO_SurfTex !== 'undefined') ? NSO_SurfTex.resolve(p) : p;
  NSO_SURFTEX_FIELDS.forEach(function (f) {
    var el = NSO_surftexEl(f[1]);
    if (!el) return;
    var given = p[f[0]];
    if (f[0] === 'density') { el.value = given > 0 ? given : ''; return; }
    if (f[0] === 'spacingV') { el.value = given > 0 ? given : ''; return; }
    if (f[0] === 'sizeV') { el.value = given > 0 ? given : ''; return; }
    el.value = given != null ? given : (R[f[0]] != null ? R[f[0]] : '');
  });
  var set = function (id, v) { var e = NSO_surftexEl(id); if (e && v != null) e.value = String(v); };
  set('sel-surftex-motif', p.motif); set('sel-surftex-layout', p.layout || 'grid'); set('sel-surftex-sides', p.sides || 0); set('sel-surftex-profile', p.profile || 'tri');
  var rg = NSO_surftexEl('chk-surftex-groove'); if (rg) rg.checked = p.ridge === false;
  NSO_surftexShowFields();
  if (window.nsoSurftexLive) window.nsoSurftexLive.sync();      // the tiles follow the selects a preset just filled
}
/* Only the fields that mean something for the feature chosen. */
function NSO_surftexShowFields() {
  var motif = (NSO_surftexEl('sel-surftex-motif') || {}).value || 'spike';
  var rg = NSO_surftexEl('chk-surftex-groove'), groove = rg && rg.checked;
  var show = function (id, on) { var e = NSO_surftexEl(id); if (e) e.style.display = on ? '' : 'none'; };
  show('fld-surftex-sides', motif === 'spike');
  show('fld-surftex-curve', motif === 'spike');
  show('fld-surftex-profile', motif === 'line');
  show('fld-surftex-groove', motif === 'line');
  show('fld-surftex-height', motif === 'spike' || motif === 'ball' || motif === 'bump' || (motif === 'line' && !groove));
  show('fld-surftex-depth', motif === 'dent' || (motif === 'line' && groove));
  var lenLabel = NSO_surftexEl('lbl-surftex-sizev');
  if (lenLabel) lenLabel.firstChild.nodeValue = motif === 'line' ? 'Length ' : 'Size ↔ ';
  show('fld-surftex-sizev', motif === 'line' || (motif !== 'line'));
}

/* ---- the piece's faces ---------------------------------------------------- */
function NSO_surftexRegions(m) {
  var B = NSO_surftexUI();
  var crease = parseFloat((NSO_surftexEl('inp-surftex-crease') || {}).value);
  if (!isFinite(crease)) crease = 30;
  if (B.reg && B.soup === m.rawTris && B.modelId === m.id && B.creaseUsed === crease) return B.reg;
  B.reg = NSO_SurfTex.regions(m.rawTris, { crease: crease, minArea: 2 });
  B.soup = m.rawTris; B.modelId = m.id; B.creaseUsed = crease; B.picked = -1;
  return B.reg;
}
function NSO_surftexFillFaces() {
  var sel = NSO_surftexEl('sel-surftex-face'), m = NSO_surftexModel(), B = NSO_surftexUI();
  if (!sel) return;
  sel.innerHTML = '';
  if (!m) { var o0 = document.createElement('option'); o0.value = '-1'; o0.textContent = 'select a piece first'; sel.appendChild(o0); B.picked = -1; NSO_surftexDraw(); if (window.nsoSurftexLive) window.nsoSurftexLive.refresh(); return; }
  var reg = NSO_surftexRegions(m), shown = reg.list.slice(0, 12), big = shown.length ? shown[0].area : 0;
  shown.forEach(function (r) {
    var o = document.createElement('option');
    o.value = String(r.id); o.textContent = (r.id + 1) + ' · ' + r.label;
    sel.appendChild(o);
  });
  if (shown.length > 1) {
    var oa = document.createElement('option'); oa.value = 'all'; oa.textContent = 'All of the above (' + shown.length + ' faces)'; sel.appendChild(oa);
  }
  if (!shown.length) { var o1 = document.createElement('option'); o1.value = '-1'; o1.textContent = 'no smooth face found'; sel.appendChild(o1); }
  B.picked = shown.length ? shown[0].id : -1;
  sel.value = shown.length ? String(shown[0].id) : '-1';
  NSO_surftexDraw();
  if (window.nsoSurftexLive) window.nsoSurftexLive.refresh();    // the faces are new: the preview is drawn again
}
function NSO_surftexPicks() {
  var m = NSO_surftexModel(), B = NSO_surftexUI(), sel = NSO_surftexEl('sel-surftex-face');
  if (!m || !B.reg || !sel) return [];
  if (sel.value === 'all') return B.reg.list.slice(0, 12);
  var id = parseInt(sel.value, 10);
  return B.reg.list.filter(function (r) { return r.id === id; });
}

/* ---- the highlight: the picked faces, tinted on the piece ----------------- */
function NSO_surftexClearDraw() {
  var B = NSO_surftexUI();
  if (B.group && B.group.parent) B.group.parent.remove(B.group);
  if (B.group) B.group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  B.group = null;
}
function NSO_surftexDraw() {
  var B = NSO_surftexUI(), m = NSO_surftexModel();
  NSO_surftexClearDraw();
  if (typeof THREE === 'undefined' || !m || !B.reg || !B.open) return;
  var placed = (state.placed || []).find(function (p) { return p && p.sourceId === m.id && p.mesh; });
  if (!placed) return;
  var picks = NSO_surftexPicks(), M = B.reg.M, o = m.centerOffset || { x: 0, y: 0, z: 0 }, pos = [], i, k;
  picks.forEach(function (r) {
    for (i = 0; i < r.tris.length; i++) {
      var t = r.tris[i];
      for (k = 0; k < 3; k++) { var v = 3 * M.vid[3 * t + k]; pos.push(M.P[v] - o.x, M.P[v + 2] - o.y, -M.P[v + 1] - o.z); }
    }
  });
  if (!pos.length) return;
  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  var mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: SURFTEX_FACE_COLOR, transparent: true, opacity: 0.32, depthTest: true, depthWrite: false,
    side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  mesh.renderOrder = 21; mesh.raycast = function () {}; mesh.frustumCulled = false; mesh.userData.skipXray = true;
  var g = new THREE.Group(); g.name = 'surftexHelpers'; g.add(mesh);
  placed.mesh.add(g);
  B.group = g;
}

/* ---- the wrap ------------------------------------------------------------- */
// PAINT SCOPE: WHOLE-PIECE - see the header and docs/HANDOFF.md.
//
// Two halves, so the live preview (app-surftex-live.js) can run the first and WRAP can install what it showed:
//   NSO_surftexCompute  everything Wrap decides, short of putting it on the piece -> { ok, res, text } | { ok: false, reason, painted? }
//   NSO_surftexWrap     the compute (or `opts.computed`, the preview's own result) and then the commit
function NSO_surftexCompute(opts) {
  opts = opts || {};
  var m = NSO_surftexModel();
  if (!m) return { ok: false, reason: 'select a piece first' };
  if (typeof NSO_SurfTex === 'undefined') return { ok: false, reason: 'nso_surftex.js is not loaded' };
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
  var reg = NSO_surftexRegions(m), picks = opts.picks || NSO_surftexPicks();
  if (!picks.length) return { ok: false, reason: 'pick a face' };
  var params = opts.params || NSO_surftexParams(), res;
  try { res = NSO_SurfTex.apply(m.rawTris, reg, picks, params); }
  catch (err) { console.error('[wrap]', err); return { ok: false, reason: (err && err.message) || String(err) }; }
  if (!res.ok) return { ok: false, reason: res.reason };
  var notes = [];
  res.perFace.forEach(function (f) { (f.stats.notes || []).forEach(function (n) { if (notes.indexOf(n) < 0) notes.push(n); }); });
  var txt = 'Wrapped ' + res.perFace.length + (res.perFace.length > 1 ? ' faces' : ' face') + ' - ' + NSO_surftexInt(res.stats.tiles) + ' features' +
    (res.stats.hmax > 0 ? ', up to +' + res.stats.hmax.toFixed(2) + ' mm' : '') + (res.stats.hmin < 0 ? ', down to ' + res.stats.hmin.toFixed(2) + ' mm' : '') +
    ', ' + NSO_surftexInt(res.removed) + ' triangles out, ' + NSO_surftexInt(res.added) + ' in, rims kept corner for corner' + (notes.length ? ' - ' + notes.join('; ') : '');
  return { ok: true, res: res, text: txt, model: m, picks: picks, params: params };
}
function NSO_surftexWrap(opts) {
  opts = opts || {};
  var B = NSO_surftexUI();
  function refuse(why) {
    if (typeof setStatus === 'function') setStatus('Wrap refused - piece unchanged (' + why + ')', true);
    NSO_surftexReadout('Wrap: ' + why, true);
    B.busy = false;
    return { ok: false, reason: why };
  }
  if (B.busy) return { ok: false, reason: 'busy' };
  var c = opts.computed || NSO_surftexCompute(opts);
  if (!c.ok) {
    if (c.painted) {
      if (typeof setStatus === 'function') setStatus('Wrap stood down - ' + c.painted + ' painted face(s); a new patch renumbers the triangles the paint names. Clear paint to wrap.', true);
      NSO_surftexReadout('Wrap: ' + c.painted + ' painted face(s) - clear paint first.', true);
      return { ok: false, reason: c.reason, painted: c.painted };
    }
    return refuse(c.reason);
  }
  var m = c.model, res = c.res, txt = c.text;
  NSO_surftexClearDraw();
  if (window.nsoSurftexLive) window.nsoSurftexLive.release();    // the ghost comes off before the bake swaps the piece's mesh
  if (typeof NSO_sculptCommitRaw !== 'function' || !NSO_sculptCommitRaw(m, res.soup, 'wrapReplace', txt)) return refuse('the result could not be committed');
  if (typeof updateAdjustUI === 'function') updateAdjustUI();
  B.reg = null; B.soup = null;                                // the soup is new: read the faces again
  NSO_surftexFillFaces();
  NSO_surftexReadout(txt);
  return res;
}

/* ---- open, close, wire ----------------------------------------------------- */
function NSO_surftexOpen() {
  var B = NSO_surftexUI(); B.open = true;
  if (window.nsoSurftexLive) window.nsoSurftexLive.open();
  NSO_surftexFillFaces();
  var m = NSO_surftexModel();
  NSO_surftexReadout(m ? 'Pick a face and a skin, then Wrap.' : 'Select a piece first.', !m);
}
function NSO_surftexClose() {
  var B = NSO_surftexUI(); B.open = false;
  NSO_surftexClearDraw();
  if (window.nsoSurftexLive) window.nsoSurftexLive.close();
}
function NSO_surftexFillPresets() {
  var sel = NSO_surftexEl('sel-surftex-preset');
  if (!sel || typeof NSO_SurfTex === 'undefined' || !NSO_SurfTex.PRESETS) return;
  sel.innerHTML = '';
  var custom = document.createElement('option'); custom.value = ''; custom.textContent = '— by hand —'; sel.appendChild(custom);
  [['design', 'The designs'], ['feature', 'One feature']].forEach(function (g) {
    var og = document.createElement('optgroup'); og.label = g[1];
    NSO_SurfTex.PRESETS.filter(function (p) { return p.group === g[0]; }).forEach(function (p) {
      var o = document.createElement('option'); o.value = p.id; o.textContent = p.name + (p.faces && p.faces !== 'any' ? '  (' + p.faces + ')' : '');
      o.title = (p.from ? 'from ' + p.from : '') + (p.measured ? ' - ' + p.measured : '');
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
}

if (typeof document !== 'undefined') {
  (function wireSurftex() {
    function wire() {
      var card = NSO_surftexEl('surftex-card');
      if (!card || card.dataset.nsoWired === '1') return;
      card.dataset.nsoWired = '1';
      NSO_surftexFillPresets();
      var menu = NSO_surftexEl('menu-surftex');
      if (menu) menu.addEventListener('toggle', function () { if (menu.open) NSO_surftexOpen(); else NSO_surftexClose(); });
      var on = function (id, ev, fn) { var e = NSO_surftexEl(id); if (e) e.addEventListener(ev, fn); };
      on('sel-surftex-preset', 'change', function () {
        var p = NSO_SurfTex.preset(this.value);
        if (!p) return;
        NSO_surftexSetParams(p.params);
        NSO_surftexReadout((p.from ? 'From ' + p.from + '. ' : '') + (p.measured ? 'Measured: ' + p.measured + '. ' : '') + 'Wraps ' + p.faces + ' faces; every number is yours to change.');
      });
      on('sel-surftex-face', 'change', function () { NSO_surftexDraw(); });
      on('inp-surftex-crease', 'change', function () { NSO_surftexFillFaces(); });
      on('sel-surftex-motif', 'change', function () { NSO_surftexShowFields(); var ps = NSO_surftexEl('sel-surftex-preset'); if (ps) ps.value = ''; });
      on('chk-surftex-groove', 'change', NSO_surftexShowFields);
      on('inp-surftex-density', 'input', function () {
        var sp = NSO_surftexEl('inp-surftex-spacing'); if (sp) sp.disabled = parseFloat(this.value) > 0;
      });
      on('btn-surftex-refresh', 'click', function () { var B = NSO_surftexUI(); B.reg = null; NSO_surftexFillFaces(); });
      on('btn-surftex-go', 'click', function () {
        var B = NSO_surftexUI();
        NSO_surftexReadout('Wrapping…');
        if (typeof setStatus === 'function') setStatus('Wrapping…');
        setTimeout(function () {
          try {
            // the live preview's own result when it is current: WRAP installs what was on screen, not a second calculation
            var r = NSO_surftexWrap({ computed: (window.nsoSurftexLive && window.nsoSurftexLive.fresh()) || undefined });
            if (r && r.ok && typeof setStatus === 'function') {
              var s = r.perFace.length + ' face(s), ' + NSO_surftexInt(r.stats.tiles) + ' features';
              setStatus('Wrap done - ' + s + '. One Undo puts the piece back.');
            }
          } catch (err) {
            console.error('[wrap]', err);
            if (typeof setStatus === 'function') setStatus('Wrap failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
          }
        }, 20);
      });
      on('btn-surftex-close', 'click', function () { if (menu) menu.open = false; NSO_surftexClose(); });
      NSO_surftexShowFields();
      // the model changed under us (another piece selected, an undo): refresh while open
      setInterval(function () {
        var B = NSO_surftexUI();
        if (!B.open) return;
        var m = NSO_surftexModel();
        if ((m && (m.rawTris !== B.soup || m.id !== B.modelId)) || (!m && B.soup)) { B.reg = null; B.soup = null; NSO_surftexFillFaces(); }
      }, 700);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NSO_surftexParams: NSO_surftexParams, NSO_surftexWrap: NSO_surftexWrap, NSO_surftexCompute: NSO_surftexCompute };
}
