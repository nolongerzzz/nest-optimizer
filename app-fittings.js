/* app-fittings.js - the Fittings card (Gen+ > Fittings): a slip-on Cap for the selected tube, and a 2- or
   3-way Splitter. Each puts a NEW piece on the plate, selected, beside whatever was selected - it
   edits nothing. The geometry is nso_fittings.js (headless, tools/nso_fittings_test.js); what is here
   is what only the app can do: read the selected piece, resolve the blank fields, add the piece.
   docs/FITTINGS.md.

   CAP    reads the open end of the SELECTED tube (NSO_tubeEdgeRead, Tube edge's own reader) - its
          outside Ø and wall - and drops a cup for it: bore = Ø + 2 x Fit, wall and closed end = the
          tube's wall, Deep = how far the tube goes in. Fit and Deep blank take their defaults (0.25 mm;
          0.75 x Ø, 8 to 30). End: Top or Bottom of the tube.
   SPLITTER  2-way or 3-way, a piece of its own: trunk Ø, Wall, Branch Ø, Angle, and the trunk's and
          the branches' lengths. Blank fields take nso_fittings.js's defaults (they are the placeholders).
          "Ø from tube" copies the selected tube's Ø and wall into the fields, so a splitter can be made
          to match a pipe without typing - then they are numbers like any other.

   THREADS (docs/THREADS.md): Thread / Thread 2 pick the sizes (G, NPT, metric); T length and T fit are blank = auto / 0.2.
          TUBE END: male or female reads the SELECTED tube like the cap and drops a sleeve that takes it, a hex collar, then a
          threaded spigot or socket (a new piece; the tube is not changed). NIPPLE / COUPLER / ADAPTER / PLUG / SCREW CAP:
          threaded fittings of their own. TRUNK END / BRANCH ENDS on the splitter: plain, male (a spigot) or female (a socket).
          nso_thread.js builds the threads; a refusal says why and adds nothing.

   PAINT SCOPE: NONE. A fitting reads no face of anything and writes to no face: the selected piece is
   read for its end and its footprint only. See docs/HANDOFF.md, "Scoping". */

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function num(id) { var el = $(id); return el && el.value !== '' && isFinite(+el.value) ? +el.value : null; }
  function readout(text, bad) {
    var el = $('fx-readout');
    if (el) { el.textContent = text; el.classList.toggle('is-bad', !!bad); }
  }
  function selected() {
    var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    return (m && m.rawTris && m.rawAxis === 'zup') ? m : null;
  }

  /* mm between the selected piece and the one dropped beside it - what nsoFreeSpot keeps clear anyway. */
  var BESIDE_GAP = 6;

  /* "cap 1", "splitter 2": the label and the next number up from the highest the plate's pieces carry,
     so an Undo hands its number back. */
  function nextName(label) {
    var top = 0, re = new RegExp('^' + label.replace(/[-+]/g, '\\$&') + ' (\\d+)$');
    (state.models || []).forEach(function (m) {
      var hit = m && re.exec(m.name || '');
      if (hit) top = Math.max(top, parseInt(hit[1], 10));
    });
    return label + ' ' + (top + 1);
  }
  function wantedSpot(made) {
    var sel = (state.selectedIndex >= 0) ? state.placed[state.selectedIndex] : null;
    if (!sel || !sel.mesh) return { x: 0, z: 0, beside: null };
    var fp = (typeof placedFootprint === 'function') ? placedFootprint(sel) : null;
    var right = fp ? fp.maxx : sel.x + (sel.width || 0) / 2;
    var mid = fp ? (fp.minz + fp.maxz) / 2 : sel.z;
    var src = (state.models || []).find(function (x) { return x && x.id === sel.sourceId; });
    return { x: right + BESIDE_GAP + made.size.x / 2, z: mid, beside: (src && src.name) || sel.name || null };
  }

  /* Where a piece of this size would land if dropped now: beside the selection, then the nearest free spot - the same two steps addPiece
     takes. `mesh` (optional) is a preview's mesh, so the free-spot search measures the real footprint. { x, z, onBed, beside }. */
  function spotFor(sizeX, mesh) {
    var want = wantedSpot({ size: { x: sizeX } }), at = { x: want.x, z: want.z, onBed: true };
    if (mesh && typeof nsoFreeSpot === 'function') {
      var e = nsoFreeSpot({ mesh: mesh, x: want.x, z: want.z }, want);
      if (e) at = e;
    }
    at.beside = want.beside;
    return at;
  }

  /* Put a soup on the plate as a piece of its own - Stock's drop, step for step: added silently (the
     selection is moved below), one 'addModels' Undo entry, placed in the nearest free spot, selected. */
  function addPiece(label, soup, what) {
    if (typeof THREE === 'undefined' || typeof addModelFromZUpGeometry !== 'function') {
      say('Fittings needs the viewport', true);
      return { ok: false, reason: 'no ingest path' };
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(soup), 3));
    var name = nextName(label), editBefore = state.editId, cutBefore = state.cutT;
    var id = addModelFromZUpGeometry(name, g, { keepSelection: true, silent: true });
    if (id == null) {
      say('Fittings refused - the new piece looked empty', true);
      return { ok: false, reason: 'addModel refused' };
    }
    var made = state.models.find(function (x) { return x && x.id === id; });
    if (typeof pushUndo === 'function') pushUndo({ type: 'addModels', ids: [id], editId: editBefore, cutT: cutBefore });
    var want = wantedSpot(made), entry = placeModelMovable(made, want.x, want.z), at = { x: want.x, z: want.z, onBed: true };
    if (entry && typeof nsoFreeSpot === 'function') at = nsoFreeSpot(entry, want);
    if (entry && typeof applyPlacedXZ === 'function') applyPlacedXZ(entry, at.x, at.z);
    var idx = entry ? state.placed.indexOf(entry) : -1;
    if (idx >= 0 && typeof selectPlaced === 'function') selectPlaced(idx);
    if (typeof renderModelList === 'function') renderModelList();
    if (typeof updateOptimizeButton === 'function') updateOptimizeButton();
    if (typeof updateEditSize === 'function') updateEditSize();
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    var txt = 'Dropped ' + name + ' - ' + what + (want.beside ? ', beside ' + want.beside : '') + '.';
    if (!at.onBed) txt += ' The plate has no free room left - it sits past the edge.';
    say(txt, !at.onBed);
    return { ok: true, modelId: id, name: name, placedIndex: idx };
  }

  /* ---------------------------------------------------------------- the cap */

  function capEndPoint(m) {
    if ($('sel-fx-end') && $('sel-fx-end').value === 'bottom') {
      var s = m.rawTris, lo = Infinity, cx = 0, cy = 0, n = 0;
      for (var i = 2; i < s.length; i += 3) if (s[i] < lo) lo = s[i];
      for (var j = 0; j < s.length; j += 3) if (s[j + 2] < lo + 1e-3) { cx += s[j]; cy += s[j + 1]; n++; }
      return n ? [cx / n, cy / n, lo] : null;
    }
    return null;                                    // the reader's own default: the highest end
  }

  function makeCap() {
    var m = selected();
    if (!m) { say('Cap: select the tube it fits over first', true); readout('Select a tube: the cap is made for its end.', true); return { ok: false, reason: 'no selection' }; }
    if (typeof NSO_Fittings === 'undefined') { say('Fittings needs nso_fittings.js', true); return { ok: false, reason: 'NSO_Fittings not loaded' }; }
    var o = { gap: num('inp-fx-gap'), depth: num('inp-fx-depth'), point: capEndPoint(m) };
    var r;
    try { r = NSO_Fittings.capFromTube(m.rawTris, o); }
    catch (e) { r = { ok: false, reason: (e && e.message) || String(e) }; }
    if (!r.ok) { say('Cap refused - nothing added: ' + r.reason, true); readout('Cap: ' + r.reason, true); return r; }
    readout(r.reason);
    var put = addPiece('cap', r.soup, r.reason);
    r.modelId = put.modelId; r.name = put.name; r.placedIndex = put.placedIndex; r.added = put.ok;
    return r;
  }

  /* ------------------------------------------------------------- the splitter */

  var busy = false;
  function setBusy(on) {
    busy = on;
    ['btn-fx-cap', 'btn-fx-split2', 'btn-fx-split3', 'btn-fx-fromtube', 'btn-fx-tmale', 'btn-fx-tfemale', 'btn-fx-nipple', 'btn-fx-coupler', 'btn-fx-adapter', 'btn-fx-plug', 'btn-fx-tcap'].forEach(function (id) { var b = $(id); if (b) b.disabled = on; });
  }

  function val(id) { var el = $(id); return el ? el.value : ''; }
  function threadOpts() {
    var t1 = val('sel-fx-tsize') || 'G1/2', t2 = val('sel-fx-tsize2') || t1;
    return { t1: t1, t2: t2, len: num('inp-fx-tlen'), fit: num('inp-fx-tfit') };
  }

  function splitterOpts(ways) {
    var o = { ways: ways, od: num('inp-fx-od'), wall: num('inp-fx-wall'), branchOd: num('inp-fx-bod'), angle: num('inp-fx-angle'),
              trunkLen: num('inp-fx-trunk'), branchLen: num('inp-fx-branch') };
    var te = val('sel-fx-trunkend') || 'plain', be = val('sel-fx-branchend') || 'plain';
    if (te !== 'plain' || be !== 'plain') {
      var t = threadOpts();
      o.trunkEnd = te; o.trunkThread = t.t1; o.branchEnd = be; o.branchThread = t.t2; o.threadLen = t.len; o.fit = t.fit;
    }
    return o;
  }

  async function makeSplitter(ways) {
    if (busy) return { ok: false, reason: 'busy' };
    if (typeof NSO_Fittings === 'undefined') { say('Fittings needs nso_fittings.js', true); return { ok: false, reason: 'NSO_Fittings not loaded' }; }
    var o = splitterOpts(ways);
    var sz = NSO_Fittings.splitterSize(o);                  // refusals first, before the kernel is asked for anything
    if (!sz.ok) { say(ways + '-way splitter refused - nothing added: ' + sz.reason, true); readout(ways + '-way: ' + sz.reason, true); return sz; }
    setBusy(true);
    readout('Building the ' + ways + '-way splitter…');
    var wasm, r;
    try {
      wasm = await NSO_CSG.load();
      r = await NSO_Fittings.splitter(o, wasm, { soupToManifold: NSO_CSG.soupToManifold });
    } catch (e) { r = { ok: false, reason: 'the boolean kernel failed to load - ' + ((e && e.message) || e) }; }
    setBusy(false);
    if (!r.ok) { say(ways + '-way splitter refused - nothing added: ' + r.reason, true); readout(ways + '-way: ' + r.reason, true); return r; }
    readout(r.reason);
    var put = addPiece('splitter ' + ways + '-way', r.soup, r.reason);
    r.modelId = put.modelId; r.name = put.name; r.placedIndex = put.placedIndex; r.added = put.ok;
    return r;
  }

  /* ------------------------------------------------------------- threads */

  function dropThreaded(label, what, r) {
    if (!r.ok) { say(what + ' refused - nothing added: ' + r.reason, true); readout(what + ': ' + r.reason, true); return r; }
    readout(r.reason);
    var put = addPiece(label, r.soup, r.reason);
    r.modelId = put.modelId; r.name = put.name; r.placedIndex = put.placedIndex; r.added = put.ok;
    return r;
  }
  function needThread() {
    if (typeof NSO_Thread === 'undefined') { say('Fittings needs nso_thread.js', true); return false; }
    return true;
  }

  /* A threaded end for the SELECTED tube: a sleeve over it, a collar, a male spigot or female socket. */
  function makeTubeEnd(end) {
    var m = selected(), what = 'Tube end (' + end + ')';
    if (!m) { say(what + ': select the tube it fits over first', true); readout('Select a tube: the threaded end is made for its end.', true); return { ok: false, reason: 'no selection' }; }
    if (typeof NSO_Fittings === 'undefined' || !needThread()) return { ok: false, reason: 'not loaded' };
    var t = threadOpts(), o = { end: end, size: t.t1, thread: t.len, fit: t.fit, gap: num('inp-fx-gap'), depth: num('inp-fx-depth'), point: capEndPoint(m) };
    var r;
    try { r = NSO_Fittings.threadEndFromTube(m.rawTris, o); } catch (e) { r = { ok: false, reason: (e && e.message) || String(e) }; }
    return dropThreaded('tube end ' + end + ' ' + t.t1, what, r);
  }

  /* A threaded fitting of its own: nipple, coupler, adapter, plug, screw cap. */
  function makeThreaded(kind) {
    if (!needThread()) return { ok: false, reason: 'NSO_Thread not loaded' };
    var t = threadOpts(), o = { kind: kind, size: t.t1, thread: t.len, fit: t.fit };
    if (kind === 'adapter') o.size2 = t.t2;
    var r;
    try { r = NSO_Thread.fitting(o); } catch (e) { r = { ok: false, reason: (e && e.message) || String(e) }; }
    var label = { nipple: 'nipple', coupler: 'coupler', adapter: 'adapter', plug: 'plug', cap: 'screw cap' }[kind] + ' ' + t.t1 + (kind === 'adapter' && t.t2 !== t.t1 ? '-' + t.t2 : '');
    return dropThreaded(label, label.replace(/ .*/, '').replace(/^./, function (c) { return c.toUpperCase(); }), r);
  }

  /* "Ø from tube": the selected tube's outside Ø and wall into the trunk's fields. */
  function fromTube() {
    var m = selected();
    if (!m) { readout('Select a tube to take its Ø and wall from.', true); return { ok: false, reason: 'no selection' }; }
    var rd = (typeof NSO_tubeEdgeRead === 'function') ? NSO_tubeEdgeRead(m.rawTris, { point: capEndPoint(m) }) : { ok: false, reason: 'nso_tube_edge.js is not loaded' };
    if (!rd.ok) { readout('Ø from tube: ' + rd.reason, true); return { ok: false, reason: rd.reason }; }
    var od = $('inp-fx-od'), wall = $('inp-fx-wall'), e = rd.end;
    if (od) od.value = (2 * e.Ro).toFixed(2);
    if (wall) wall.value = e.wallMm.toFixed(2);
    readout('Trunk Ø' + (2 * e.Ro).toFixed(2) + ', wall ' + e.wallMm.toFixed(2) + ' mm - from the selected tube. Branch Ø blank is ¾ of it (2-way) or ⅔ (3-way).');
    return { ok: true, od: 2 * e.Ro, wall: e.wallMm };
  }

  function wire() {
    [['btn-fx-cap', function () { return makeCap(); }], ['btn-fx-split2', function () { return makeSplitter(2); }], ['btn-fx-split3', function () { return makeSplitter(3); }],
     ['btn-fx-fromtube', function () { return fromTube(); }],
     ['btn-fx-tmale', function () { return makeTubeEnd('male'); }], ['btn-fx-tfemale', function () { return makeTubeEnd('female'); }],
     ['btn-fx-nipple', function () { return makeThreaded('nipple'); }], ['btn-fx-coupler', function () { return makeThreaded('coupler'); }],
     ['btn-fx-adapter', function () { return makeThreaded('adapter'); }], ['btn-fx-plug', function () { return makeThreaded('plug'); }],
     ['btn-fx-tcap', function () { return makeThreaded('cap'); }]].forEach(function (q) {
      var b = $(q[0]);
      if (!b || b.dataset.nsoWired === '1') return;
      b.dataset.nsoWired = '1';
      b.addEventListener('click', function () {
        Promise.resolve().then(q[1]).catch(function (err) {
          if (typeof console !== 'undefined') console.error('[fittings]', err);
          setBusy(false);
          say('Fittings failed - nothing added (' + ((err && err.message) || err) + ')', true);
        });
      });
    });
    // the splitter's defaults are the fields' placeholders, so a blank field says what it will do
    if (typeof NSO_Fittings !== 'undefined') {
      var Dt = (typeof NSO_Thread !== 'undefined') ? NSO_Thread.DEFAULTS : null;
      if (Dt && $('inp-fx-tfit')) $('inp-fx-tfit').placeholder = String(Dt.fit);
      var D = NSO_Fittings.DEFAULTS, ph = { 'inp-fx-gap': D.gap, 'inp-fx-od': D.od, 'inp-fx-wall': D.wall, 'inp-fx-angle': D.angle, 'inp-fx-trunk': D.trunkLen, 'inp-fx-branch': D.branchLen };
      Object.keys(ph).forEach(function (id) { var el = $(id); if (el) el.placeholder = String(ph[id]); });
    }
  }

  window.nsoFittings = { cap: makeCap, splitter: makeSplitter, fromTube: fromTube, busy: function () { return busy; },
                         tubeEnd: makeTubeEnd, threaded: makeThreaded,
                         // the drop every generated piece shares (Gen+ > Fasteners uses it too): a new piece, selected, beside the selection, one Undo
                         addPiece: addPiece, spotFor: spotFor };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
