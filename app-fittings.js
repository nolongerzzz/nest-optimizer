/* app-fittings.js - the Fittings card (Gen+ > Fittings): a slip-on Cap, a threaded End for the selected tube, a Nipple, Coupler,
   Adapter, Plug and Screw cap, and a 2- or 3-way Splitter (plain or with threaded ends) - picked from tiles, adjusted with sliders
   against a LIVE PREVIEW on the plate, and baked by Add to plate. Each puts a NEW piece on the plate, selected, beside whatever was
   selected - it edits nothing. The geometry is nso_fittings.js and nso_thread.js (headless, tools/nso_fittings_test.js,
   tools/nso_thread_test.js); what is here is what only the app can do: draw the tiles, read the selected tube, resolve the numbers, show
   the preview (app-piece-preview.js), add the piece. docs/FITTINGS.md, docs/THREADS.md.

   THE TILES are drawn from the generators, not from files (the Stock shelf's way, nsoStockShelf.paint): the Cap is a GENERIC slip-on
   cap (it needs no tube to be drawn), the tube ends are a sleeve with an amber tube going into it, the splitters are tubes laid out as
   the splitter lays them, the rest are nso_thread.js's own fittings at G1/2. Trunk end / Branch ends are three tiles each (plain, male,
   female), drawn the same way.

   THE SLIDERS are every number the card has (app-live-slider.js: the box is the number, the slider writes it, a typed value may pass the
   slider's end): Fit and Deep (cap and tube end), Ø, Wall, Branch Ø, Angle, Trunk, Branch (splitter), T length and T fit (threads). The
   selects (End, Thread, Thread 2) and the tiles are the choices. Three numbers start at an automatic value and FOLLOW what they depend on
   until they are moved: Deep (0.75 x the tube's Ø, 8 to 30), Branch Ø (3/4 or 2/3 of the trunk's) and T length (about six pitches, 8 to
   25); the engine is handed only a number the user moved, so its own default is what is used otherwise. Rows a kind does not use are put
   away.

   THE PREVIEW is the translucent copy of what Add to plate would drop. Cap and Tube end read the SELECTED tube (NSO_Fittings.readTube, the
   Tube-edge reader, cached per tube and end); with none selected the preview is a generic Ø20 x 2 tube's, labelled so, and Add to plate is
   off. A click that changes the selection rebuilds it. The splitter is built on the boolean kernel (~0.2-0.5 s): its refusals are said at
   once without the kernel, and while it builds the old preview stays and a newer change supersedes an older build (only the latest is
   shown). Add to plate is off until the preview shown is the one the card now says.

   PAINT SCOPE: NONE. A fitting reads no face of anything and writes to no face: the selected piece is read for its end and its footprint
   only. See docs/HANDOFF.md, "Scoping". */

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function num(id) { var el = $(id); return el && el.value !== '' && isFinite(+el.value) ? +el.value : null; }
  function val(id) { var el = $(id); return el ? el.value : ''; }
  function r2(x) { return Math.round(x * 100) / 100; }
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

  /* "cap 1", "splitter 2": the label and the next number up from the highest the plate's pieces carry, so an Undo hands its number back. */
  function nextName(label) {
    var top = 0, re = new RegExp('^' + label.replace(/[-+./()]/g, '\\$&') + ' (\\d+)$');
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

  /* Put a soup on the plate as a piece of its own - Stock's drop, step for step: added silently (the selection is moved below), one
     'addModels' Undo entry, placed in the nearest free spot, selected. */
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

  /* ================================================================ the card's state */

  var SPLIT = { split2: 2, split3: 3 };
  var TUBE_KINDS = ['cap', 'tubemale', 'tubefemale'];
  var THREAD_KINDS = ['tubemale', 'tubefemale', 'nipple', 'coupler', 'adapter', 'plug', 'screwcap'];
  var KINDS = ['cap', 'tubemale', 'tubefemale', 'split2', 'split3', 'nipple', 'coupler', 'adapter', 'plug', 'screwcap'];
  var NAME = { cap: 'Cap', tubemale: 'Tube end (male)', tubefemale: 'Tube end (female)', split2: '2-way splitter', split3: '3-way splitter',
               nipple: 'Nipple', coupler: 'Coupler', adapter: 'Adapter', plug: 'Plug', screwcap: 'Screw cap' };
  /* the numbers: box id, and what it was moved off (touched) - Deep, Branch Ø and T length follow what they depend on until moved */
  var FIELDS = {
    gap: 'inp-fx-gap', depth: 'inp-fx-depth', od: 'inp-fx-od', wall: 'inp-fx-wall', bod: 'inp-fx-bod',
    angle: 'inp-fx-angle', trunk: 'inp-fx-trunk', branch: 'inp-fx-branch', tlen: 'inp-fx-tlen', tfit: 'inp-fx-tfit'
  };
  var S = { kind: 'cap', trunkEnd: 'plain', branchEnd: 'plain', touched: {}, tiles: false, ok: false, busy: false, last: null,
            tubeSoup: null, tubeKey: '', tubeVal: null, selKey: '', seq: 0, want: null, running: false, done: null };

  function menu() { return $('menu-fittings'); }
  /* open, and so is every menu it sits in (Gen+): a preview for a card nobody can see is clutter */
  function isOpen() {
    var m = menu();
    for (var d = m; d; d = d.parentElement && d.parentElement.closest('details')) if (!d.open) return false;
    return !!m;
  }
  function PV() { return window.nsoPiecePreview; }
  function haveFx() { return typeof NSO_Fittings !== 'undefined'; }
  function haveTh() { return typeof NSO_Thread !== 'undefined'; }

  /* ---------------------------------------------------------------- the fields */
  function unitOf(name) { return name === 'angle' ? '°' : ' mm'; }
  function setField(name, v) {
    var box = $(FIELDS[name]), sl = $(FIELDS[name] + '-slider'), rd = $('fx-' + name + '-read'), t = String(r2(v));
    if (box) box.value = t;
    if (sl) sl.value = t;
    if (rd) rd.textContent = t + unitOf(name);
  }
  function isSplit() { return !!SPLIT[S.kind]; }
  function threadsOf() {
    var t1 = val('sel-fx-tsize') || 'G1/2', t2 = val('sel-fx-tsize2') || t1;
    return { t1: t1, t2: t2 };
  }
  function pitchOf(id) { var s = haveTh() ? NSO_Thread.spec(id, {}) : null; return s && s.ok ? s.spec.P : 1.5; }
  function autoTlen() {
    var t = threadsOf(), P = S.kind === 'adapter' ? Math.max(pitchOf(t.t1), pitchOf(t.t2)) : pitchOf(t.t1);
    return Math.max(8, Math.min(25, Math.round(6 * P)));
  }
  function autoBod() { var w = SPLIT[S.kind] || 2, od = num(FIELDS.od); return od == null ? null : Math.round(od * (w === 2 ? 0.75 : 0.65) * 10) / 10; }
  /* the values the untouched ones follow, written into their boxes (not into the engine) */
  function syncAuto(tubeOd) {
    if (!S.touched.tlen) setField('tlen', autoTlen());
    if (!S.touched.bod) { var b = autoBod(); if (b != null) setField('bod', b); }
    if (!S.touched.depth && tubeOd) setField('depth', haveFx() ? NSO_Fittings.capDepthFor(tubeOd) : 15);
  }
  function touch(name) { S.touched[name] = true; }

  /* ---------------------------------------------------------------- the tube */
  function capEndPoint(m) {
    if (val('sel-fx-end') === 'bottom') {
      var s = m.rawTris, lo = Infinity, cx = 0, cy = 0, n = 0;
      for (var i = 2; i < s.length; i += 3) if (s[i] < lo) lo = s[i];
      for (var j = 0; j < s.length; j += 3) if (s[j + 2] < lo + 1e-3) { cx += s[j]; cy += s[j + 1]; n++; }
      return n ? [cx / n, cy / n, lo] : null;
    }
    return null;                                    // the reader's own default: the highest end
  }
  /* The selected tube's end, read once per (piece, end, what it is for): { ok, od, wall } | { ok: false, reason } | { none: true } */
  function tubeInfo(what) {
    var m = selected();
    if (!m) return { none: true };
    var pt = capEndPoint(m), key = m.id + '|' + (pt ? pt.join(',') : 'top') + '|' + what;
    if (S.tubeSoup === m.rawTris && S.tubeKey === key) return S.tubeVal;
    var t;
    try { t = NSO_Fittings.readTube(m.rawTris, { point: pt }, what === 'cap' ? 'cap' : 'sleeve', what === 'cap' ? 'A cap fits the open, round end of a tube.' : 'A threaded end fits the open, round end of a tube.'); }
    catch (e) { t = { ok: false, reason: (e && e.message) || String(e) }; }
    S.tubeSoup = m.rawTris; S.tubeKey = key; S.tubeVal = t;
    return t;
  }
  function selKey() { var m = selected(); return m ? m.id + ':' + m.rawTris.length : ''; }

  /* ---------------------------------------------------------------- what the card makes */

  function splitterOpts(ways) {
    var o = { ways: ways, od: num(FIELDS.od), wall: num(FIELDS.wall), angle: num(FIELDS.angle), trunkLen: num(FIELDS.trunk), branchLen: num(FIELDS.branch) };
    if (S.touched.bod) o.branchOd = num(FIELDS.bod);
    if (S.trunkEnd !== 'plain' || S.branchEnd !== 'plain') {
      var t = threadsOf();
      o.trunkEnd = S.trunkEnd; o.trunkThread = t.t1; o.branchEnd = S.branchEnd; o.branchThread = t.t2;
      if (S.touched.tlen) o.threadLen = num(FIELDS.tlen);
      o.fit = num(FIELDS.tfit);
    }
    return o;
  }

  /* a kind that needs no kernel: { ok, items: [{ label, soup, reason }], text, generic } or { ok: false, reason } */
  function buildSync(kind) {
    var one = function (label, r) { return r.ok ? { ok: true, items: [{ label: label, soup: r.soup, reason: r.reason, info: r.info }], text: r.reason } : { ok: false, reason: r.reason }; };
    if (TUBE_KINDS.indexOf(kind) >= 0) {
      if (!haveFx() || (kind !== 'cap' && !haveTh())) return { ok: false, reason: kind === 'cap' ? 'Fittings needs nso_fittings.js' : 'Fittings needs nso_thread.js' };
      var t = tubeInfo(kind === 'cap' ? 'cap' : 'sleeve'), generic = false;
      if (t.none) { t = { ok: true, od: 20, wall: 2 }; generic = true; }
      else if (!t.ok) return { ok: false, reason: t.reason };
      syncAuto(t.od);
      var gap = num(FIELDS.gap), depth = S.touched.depth ? num(FIELDS.depth) : null, r;
      try {
        if (kind === 'cap') r = NSO_Fittings.cap({ od: t.od, wall: t.wall, gap: gap, depth: depth });
        else {
          var th = threadsOf();
          r = NSO_Thread.sleeve({ tubeOd: t.od, tubeWall: t.wall, gap: gap, depth: depth, end: kind === 'tubemale' ? 'male' : 'female', size: th.t1, thread: S.touched.tlen ? num(FIELDS.tlen) : null, fit: num(FIELDS.tfit) });
        }
      } catch (e) { r = { ok: false, reason: (e && e.message) || String(e) }; }
      var th2 = threadsOf();
      var label = kind === 'cap' ? 'cap' : 'tube end ' + (kind === 'tubemale' ? 'male' : 'female') + ' ' + th2.t1;
      var b = one(label, r);
      if (b.ok) b.generic = generic;
      return b;
    }
    if (!haveTh()) return { ok: false, reason: 'Fittings needs nso_thread.js' };
    var T = threadsOf();
    syncAuto(null);
    var o = { kind: { nipple: 'nipple', coupler: 'coupler', adapter: 'adapter', plug: 'plug', screwcap: 'cap' }[kind], size: T.t1, thread: S.touched.tlen ? num(FIELDS.tlen) : null, fit: num(FIELDS.tfit) };
    if (kind === 'adapter') o.size2 = T.t2;
    try { r = NSO_Thread.fitting(o); } catch (e) { r = { ok: false, reason: (e && e.message) || String(e) }; }
    var nm = { nipple: 'nipple', coupler: 'coupler', adapter: 'adapter', plug: 'plug', screwcap: 'screw cap' }[kind] + ' ' + T.t1 + (kind === 'adapter' && T.t2 !== T.t1 ? '-' + T.t2 : '');
    return one(nm, r);
  }

  /* the splitter, on the kernel: { ok, items, text } | { ok: false, reason } */
  async function buildSplit(ways, o) {
    var wasm = await NSO_CSG.load();
    var r = await NSO_Fittings.splitter(o, wasm, { soupToManifold: NSO_CSG.soupToManifold });
    return r.ok ? { ok: true, items: [{ label: 'splitter ' + ways + '-way', soup: r.soup, reason: r.reason, info: r.info }], text: r.reason } : { ok: false, reason: r.reason };
  }

  /* ---------------------------------------------------------------- the preview */

  function ghostClear() { if (PV()) PV().clear('fittings'); }
  function ghostShow(items) { if (PV()) PV().show('fittings', items.map(function (it) { return it.soup; })); }
  function setAdd(on) { var b = $('btn-fx-add'); if (b) b.disabled = !on; S.ok = !!on; }
  /* a refusal: the preview goes, Add to plate goes off, and the reason is said in red, headed with what it is for ("2-way: ...", "Cap: ...") */
  var HEAD = { cap: 'Cap', tubemale: 'Tube end (male)', tubefemale: 'Tube end (female)', split2: '2-way', split3: '3-way', nipple: 'Nipple', coupler: 'Coupler',
               adapter: 'Adapter', plug: 'Plug', screwcap: 'Screw cap' };
  function fail(reason) { ghostClear(); setAdd(false); S.last = null; readout(HEAD[S.kind] + ': ' + reason, true); }
  function show(b, key) {
    ghostShow(b.items);
    S.last = { key: key, kind: S.kind, items: b.items, text: b.text, generic: !!b.generic };
    setAdd(!b.generic);
    readout((b.generic ? 'Preview for a generic Ø20 × 2 tube (select a tube to size it) - ' : 'Preview - ') + b.text);
  }
  function currentKey() { return S.kind + '|' + selKey() + '|' + val('sel-fx-end') + '|' + S.trunkEnd + '|' + S.branchEnd + '|' + val('sel-fx-tsize') + '|' + val('sel-fx-tsize2') + '|' +
                          Object.keys(FIELDS).map(function (k) { return val(FIELDS[k]); }).join(',') + '|' + JSON.stringify(S.touched); }

  /* the preview, now. A splitter's is async; the others are instant. */
  function refresh() {
    if (!isOpen()) { ghostClear(); S.want = null; return Promise.resolve(null); }
    S.selKey = selKey();
    if (!SPLIT[S.kind]) {
      S.want = null;
      var b = buildSync(S.kind);
      if (!b.ok) { fail(b.reason); return Promise.resolve(b); }
      show(b, currentKey());
      return Promise.resolve(b);
    }
    var ways = SPLIT[S.kind];
    if (!haveFx()) { fail('Fittings needs nso_fittings.js'); return Promise.resolve(null); }
    syncAuto(null);
    var o = splitterOpts(ways), sz = NSO_Fittings.splitterSize(o);
    if (!sz.ok) { S.want = null; fail(sz.reason); return Promise.resolve({ ok: false, reason: sz.reason }); }   // said at once, no kernel
    var key = currentKey();
    if (S.last && S.last.key === key && PV() && PV().count()) { setAdd(true); return Promise.resolve(S.last); }
    S.want = { o: o, key: key, ways: ways, kind: S.kind };
    setAdd(false);
    S.busy = true;
    readout('Building the ' + ways + '-way splitter…');
    if (!S.running) {
      S.running = true;
      S.done = (async function () {
        try {
          while (S.want) {
            var job = S.want; S.want = null;
            var res;
            try { res = await buildSplit(job.ways, job.o); }
            catch (e) { res = { ok: false, reason: 'the boolean kernel failed - ' + ((e && e.message) || e) }; }
            if (S.want) continue;                            // a newer change is waiting: this one is stale
            if (!isOpen() || S.kind !== job.kind) continue;
            if (job.key !== currentKey()) continue;
            if (res.ok) show(res, job.key); else fail(res.reason);
          }
        } finally { S.running = false; S.busy = false; }
      })();
    }
    return S.done;
  }
  var timer = 0;
  function soon() { if (timer) return; timer = setTimeout(function () { timer = 0; refresh(); }, 30); }

  /* ---------------------------------------------------------------- the choice */

  function syncRows() {
    var k = S.kind, split = isSplit(), tube = TUBE_KINDS.indexOf(k) >= 0, thr = THREAD_KINDS.indexOf(k) >= 0;
    var endsOn = split && (S.trunkEnd !== 'plain' || S.branchEnd !== 'plain');
    var anyFemale = S.trunkEnd === 'female' || S.branchEnd === 'female';
    var on = {
      end: tube, gap: tube, depth: tube,
      od: split, wall: split, bod: split, angle: split, trunk: split, branch: split, fromtube: split,
      threads: thr || endsOn, tsize2: k === 'adapter' || (split && S.branchEnd !== 'plain'), tlen: thr || endsOn,
      tfit: k === 'tubefemale' || k === 'coupler' || k === 'adapter' || k === 'screwcap' || (split && anyFemale)
    };
    Object.keys(on).forEach(function (n) { var el = $('fx-row-' + n); if (el) el.hidden = !on[n]; });
    var ends = $('fx-ends-row'); if (ends) ends.hidden = !split;
    document.querySelectorAll('#fx-kind-row [data-kind]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-kind') === k ? 'true' : 'false'); });
    document.querySelectorAll('#fx-trunkend-row [data-end]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-end') === S.trunkEnd ? 'true' : 'false'); });
    document.querySelectorAll('#fx-branchend-row [data-end]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-end') === S.branchEnd ? 'true' : 'false'); });
  }
  function selectKind(kind) {
    if (KINDS.indexOf(kind) < 0) return false;
    S.kind = kind; S.last = null;
    syncRows(); refresh();
    return true;
  }
  function selectEnd(which, end) {
    if (['plain', 'male', 'female'].indexOf(end) < 0) return false;
    if (which === 't') S.trunkEnd = end; else S.branchEnd = end;
    S.last = null;
    syncRows(); refresh();
    return true;
  }

  /* ---------------------------------------------------------------- the bake */

  /* Add to plate: drop what the preview shows (a splitter built now if the preview shown is not the card's current one). */
  async function bake(kind) {
    if (kind && kind !== S.kind) { S.kind = kind; S.last = null; syncRows(); }
    var tag = NAME[S.kind], b;
    if (TUBE_KINDS.indexOf(S.kind) >= 0 && !selected()) {
      var msg = S.kind === 'cap' ? 'Select a tube: the cap is made for its end.' : 'Select a tube: the threaded end is made for its end.';
      say(tag + ': select the tube it fits over first', true); readout(msg, true);
      return { ok: false, reason: 'no selection' };
    }
    if (SPLIT[S.kind]) {
      if (!haveFx()) { say('Fittings needs nso_fittings.js', true); return { ok: false, reason: 'NSO_Fittings not loaded' }; }
      var o = splitterOpts(SPLIT[S.kind]), sz = NSO_Fittings.splitterSize(o);
      if (!sz.ok) { say(tag + ' refused - nothing added: ' + sz.reason, true); readout(SPLIT[S.kind] + '-way: ' + sz.reason, true); return sz; }
      if (S.running && S.done) await S.done;               // let the preview in flight land
      if (S.last && S.last.key === currentKey() && S.last.kind === S.kind) b = { ok: true, items: S.last.items, text: S.last.text };
      else {
        S.busy = true; readout('Building the ' + SPLIT[S.kind] + '-way splitter…');
        try { b = await buildSplit(SPLIT[S.kind], o); } catch (e) { b = { ok: false, reason: 'the boolean kernel failed to load - ' + ((e && e.message) || e) }; }
        S.busy = false;
      }
    } else b = buildSync(S.kind);
    if (!b.ok) { say(tag + ' refused - nothing added: ' + b.reason, true); readout((SPLIT[S.kind] ? SPLIT[S.kind] + '-way' : tag) + ': ' + b.reason, true); return { ok: false, reason: b.reason }; }
    ghostClear();                                           // so the drop's free-spot search is not looking at the preview
    var it = b.items[0], put = addPiece(it.label, it.soup, it.reason);
    var res = { ok: put.ok, reason: it.reason, info: it.info, modelId: put.modelId, name: put.name, placedIndex: put.placedIndex, added: put.ok };
    readout(it.reason);
    S.last = null;
    if (isOpen()) refresh();                                // the preview stands beside what was just added
    return res;
  }

  /* "Ø from tube": the selected tube's outside Ø and wall into the trunk's fields. */
  function fromTube() {
    var m = selected();
    if (!m) { readout('Select a tube to take its Ø and wall from.', true); return { ok: false, reason: 'no selection' }; }
    var rd = (typeof NSO_tubeEdgeRead === 'function') ? NSO_tubeEdgeRead(m.rawTris, { point: capEndPoint(m) }) : { ok: false, reason: 'nso_tube_edge.js is not loaded' };
    if (!rd.ok) { readout('Ø from tube: ' + rd.reason, true); return { ok: false, reason: rd.reason }; }
    var e = rd.end;
    setField('od', 2 * e.Ro); setField('wall', e.wallMm);
    S.touched.od = true; S.touched.wall = true; S.touched.bod = false; S.last = null;
    if (isSplit() && isOpen()) refresh();
    else readout('Trunk Ø' + (2 * e.Ro).toFixed(2) + ', wall ' + e.wallMm.toFixed(2) + ' mm - from the selected tube. Branch Ø follows it: ¾ of it (2-way) or ⅔ (3-way).');
    return { ok: true, od: 2 * e.Ro, wall: e.wallMm };
  }

  /* ---------------------------------------------------------------- the tiles */

  function tileArt(id) {
    var A = PV().art, F = NSO_Fittings, T = NSO_Thread, ST = (typeof NSO_Stock !== 'undefined') ? NSO_Stock : null;
    var tube = function (ro, wall, h) { return ST.revolve(ST.profileTube(ro, ro - wall, h), 40); };
    var fit = function (kind, o) { return T.fitting(Object.assign({ kind: kind, size: 'G1/2' }, o || {})).soup; };
    var split = function (ways) {
      var parts = [tube(10, 2, 25)], angle = 35, az = ways === 2 ? [0, 180] : [0, 120, 240];
      az.forEach(function (a) { parts.push(A.xform(tube(ways === 2 ? 7.5 : 6.5, 2, 30), A.mul3(A.rotZ(a * Math.PI / 180), A.rotY(angle * Math.PI / 180)), [0, 0, 25])); });
      return A.join.apply(null, parts);
    };
    var sleeveWithTube = function (end) {
      var sl = T.sleeve({ tubeOd: 20, tubeWall: 2, size: 'G1/2', end: end }), tb = tube(10, 2, 16);
      var n1 = sl.soup.length / 9;
      return { soup: A.join(sl.soup, A.moveZ(tb, -14)), view: { yaw: 0.62, elev: end === 'female' ? 0.8 : 0.5 }, tint: function (t) { return t >= n1 ? A.AMBER : null; } };
    };
    switch (id) {
      case 'cap': return { soup: F.cap({ od: 20, wall: 2 }).soup, view: { yaw: 0.62, elev: 0.8 } };            // a generic slip-on cap: no tube needed
      case 'tubemale': return sleeveWithTube('male');
      case 'tubefemale': return sleeveWithTube('female');
      case 'split2': return { soup: split(2), view: { yaw: 0.3, elev: 0.5 } };
      case 'split3': return { soup: split(3), view: { yaw: 0.3, elev: 0.6 } };
      case 'nipple': return { soup: fit('nipple'), view: { yaw: 0.62, elev: 0.5 } };
      case 'coupler': return { soup: fit('coupler'), view: { yaw: 0.62, elev: 0.8 } };
      case 'adapter': return { soup: fit('adapter', { size2: 'G3/4' }), view: { yaw: 0.62, elev: 0.6 } };
      case 'plug': return { soup: fit('plug'), view: { yaw: 0.62, elev: 0.5 } };
      case 'screwcap': return { soup: fit('cap'), view: { yaw: 0.62, elev: 0.8 } };
      case 'end-plain': return { soup: tube(10, 2, 14), view: { yaw: 0.62, elev: 0.75 } };
      case 'end-male': return { soup: T.sleeve({ tubeOd: 20, tubeWall: 2, size: 'G1/2', end: 'male', depth: 4 }).soup, view: { yaw: 0.62, elev: 0.5 } };
      case 'end-female': return { soup: T.sleeve({ tubeOd: 20, tubeWall: 2, size: 'G1/2', end: 'female', depth: 4 }).soup, view: { yaw: 0.62, elev: 0.8 } };
    }
    return null;
  }
  function drawTiles() {
    if (S.tiles || !haveFx() || !haveTh() || !PV() || typeof NSO_Stock === 'undefined') return 0;
    var paint = window.nsoStockShelf && window.nsoStockShelf.paint;
    if (typeof paint !== 'function') return 0;
    S.tiles = true;
    var done = 0;
    document.querySelectorAll('#menu-fittings .fs-tile').forEach(function (b) {
      var c = b.querySelector('canvas');
      if (!c) return;
      var id = b.getAttribute('data-kind') || ('end-' + b.getAttribute('data-end')), art;
      try { art = tileArt(id); } catch (e) { art = null; }
      if (art && paint(c, art.soup, art.tint, art.view)) { c.setAttribute('data-drawn', '1'); done++; }
    });
    return done;
  }

  /* ---------------------------------------------------------------- wiring */

  function wire() {
    var m = menu();
    if (!m || m.dataset.nsoWired === '1') return;
    m.dataset.nsoWired = '1';
    document.querySelectorAll('#fx-kind-row [data-kind]').forEach(function (b) { b.addEventListener('click', function () { selectKind(b.getAttribute('data-kind')); }); });
    document.querySelectorAll('#fx-trunkend-row [data-end]').forEach(function (b) { b.addEventListener('click', function () { selectEnd('t', b.getAttribute('data-end')); }); });
    document.querySelectorAll('#fx-branchend-row [data-end]').forEach(function (b) { b.addEventListener('click', function () { selectEnd('b', b.getAttribute('data-end')); }); });
    ['sel-fx-end', 'sel-fx-tsize', 'sel-fx-tsize2'].forEach(function (id) { var el = $(id); if (el) el.addEventListener('change', function () { S.last = null; refresh(); }); });
    Object.keys(FIELDS).forEach(function (name) {
      var id = FIELDS[name];
      if (window.nsoLiveSlider) {
        window.nsoLiveSlider.bind({ slider: id + '-slider', box: id, read: 'fx-' + name + '-read', unit: unitOf(name), onLive: function () { touch(name); soon(); } });
      } else {                                              // no live slider module: the box and the slider still say one number
        var box = $(id), sl = $(id + '-slider'), rd = $('fx-' + name + '-read');
        if (box) box.addEventListener('input', function () { touch(name); if (sl) sl.value = box.value; if (rd) rd.textContent = box.value + unitOf(name); soon(); });
        if (sl) sl.addEventListener('input', function () { if (box) box.value = sl.value; touch(name); if (rd) rd.textContent = sl.value + unitOf(name); soon(); });
      }
    });
    var add = $('btn-fx-add');
    if (add) add.addEventListener('click', function () {
      Promise.resolve().then(function () { return bake(); }).catch(function (err) {
        if (typeof console !== 'undefined') console.error('[fittings]', err);
        S.busy = false;
        say('Fittings failed - nothing added (' + ((err && err.message) || err) + ')', true);
      });
    });
    var ft = $('btn-fx-fromtube');
    if (ft) ft.addEventListener('click', function () { fromTube(); });
    var onToggle = function () { if (isOpen()) { drawTiles(); refresh(); } else { ghostClear(); S.want = null; } };
    for (var d = m; d; d = d.parentElement && d.parentElement.closest('details')) d.addEventListener('toggle', onToggle);
    // a click that selects another piece (or an Undo, a Remove) moves where the drop would land, and changes the tube a cap reads
    window.addEventListener('pointerup', function () {
      if (!isOpen()) return;
      setTimeout(function () {
        if (selKey() !== S.selKey && (TUBE_KINDS.indexOf(S.kind) >= 0 || isSplit())) { S.last = null; refresh(); }
        else if (PV() && PV().state().owner === 'fittings') PV().place();
      }, 0);
    }, true);
    if (haveFx()) { setField('gap', NSO_Fittings.DEFAULTS.gap); setField('od', NSO_Fittings.DEFAULTS.od); setField('wall', NSO_Fittings.DEFAULTS.wall);
                    setField('angle', NSO_Fittings.DEFAULTS.angle); setField('trunk', NSO_Fittings.DEFAULTS.trunkLen); setField('branch', NSO_Fittings.DEFAULTS.branchLen); }
    if (haveTh()) setField('tfit', NSO_Thread.DEFAULTS.fit);
    syncAuto(20);
    syncRows();
    if (isOpen()) { drawTiles(); refresh(); }
  }

  window.nsoFittings = {
    // each bakes that kind with the card's numbers now (what Add to plate does for the chosen tile)
    cap: function () { return bake('cap'); },
    splitter: function (ways) { return bake(ways === 3 ? 'split3' : 'split2'); },
    tubeEnd: function (end) { return bake(end === 'female' ? 'tubefemale' : 'tubemale'); },
    threaded: function (kind) { return bake({ nipple: 'nipple', coupler: 'coupler', adapter: 'adapter', plug: 'plug', cap: 'screwcap' }[kind] || kind); },
    fromTube: fromTube, busy: function () { return S.busy; },
    add: bake, select: selectKind, end: selectEnd, preview: refresh, drawTiles: drawTiles,
    // the drop every generated piece shares (Gen+ > Fasteners uses it too), and where it would land (the preview uses it)
    addPiece: addPiece, spotFor: spotFor,
    state: function () {
      var g = PV() ? PV().state() : { owner: null, count: 0, ghost: [] }, mine = g.owner === 'fittings';
      return { kind: S.kind, trunkEnd: S.trunkEnd, branchEnd: S.branchEnd, ghosts: mine ? g.count : 0, ghost: mine ? g.ghost : [], ok: S.ok, busy: S.busy, open: isOpen(), tiles: S.tiles,
               touched: Object.assign({}, S.touched), generic: !!(S.last && S.last.generic) };
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
