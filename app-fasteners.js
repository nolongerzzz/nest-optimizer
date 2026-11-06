/* app-fasteners.js - the Fasteners card (Gen+ > Fasteners): a threaded Rod, a Bolt (hex or socket head), a Nut and a
   Bolt + nut set - picked from tiles, adjusted with sliders against a LIVE PREVIEW on the plate, and baked by Add to plate.
   The geometry is nso_thread.js (headless, tools/nso_thread_test.js); what is here is what only the app can do: draw the
   tiles, read the fields, show the preview, drop the pieces (the drop Fittings uses, nsoFittings.addPiece: one Undo each).
   docs/THREADS.md.

   THE TILES are drawn from the generator, not from a file - the way the Stock shelf's are (app-stock.js, nsoStockShelf.paint):
   a Rod, a Bolt, a Nut, a Bolt + nut (the nut in amber), and the two head types (a hex head and a socket head, seen from
   above), each from nso_thread.js's own mesh at M8, painted once the first time the card opens. A bolt is drawn head up -
   it prints head down on the bed, a tile shows it the way it is held.

   THE SLIDERS are every number the card has: Ø, Pitch, Length, Fit, Nut thickness (app-live-slider.js: the box is the number,
   the slider writes it, a typed value may pass the slider's end). Size and Hand are selects. Size sets Ø, Pitch and the
   nut's thickness to its own and the sliders adjust from there; Ø and Pitch changed from the table make a thread of its own,
   named by its numbers (M7x1.5), and an unchanged one is exactly the table's (G1/2 is 20.955, not the box's 20.96).

   THE PREVIEW is a translucent copy of what Add to plate would drop (a set shows both pieces), standing where it would land -
   beside the selection, then the nearest free spot (nsoFittings.spotFor, the drop's own two steps) - rebuilt as any control
   moves, paced by the live slider. Nothing is on the plate until Add to plate: the preview is a helper in the scene, not a
   piece (it is not in state.placed or state.modelGroup, so it is not picked, packed or exported). It shows only while the menu is
   open AND a tile has been clicked (armed): opening the card shows none, and Add to plate disarms it - no ghost stands beside
   the piece just baked until a tile is clicked again. A choice that is refused clears it and says why, in red, and Add to plate is off.

   PAINT SCOPE: NONE. A fastener reads no face of anything and writes to no face. See docs/HANDOFF.md, "Scoping". */

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }
  function num(id) { var el = $(id); return el && el.value !== '' && isFinite(+el.value) ? +el.value : null; }
  function val(id) { var el = $(id); return el ? el.value : ''; }
  function readout(text, bad) {
    var el = $('fs-readout');
    if (el) { el.textContent = text; el.classList.toggle('is-bad', !!bad); }
  }
  function r2(x) { return Math.round(x * 100) / 100; }

  var KINDS = ['rod', 'bolt', 'nut', 'set'];
  var KIND_LENGTH = { rod: 40, bolt: 25, set: 25 };         // what Length starts at, until it is touched
  /* the five numbers: the box, the slider, the read-out, and what each says */
  var FIELDS = {
    major:  { box: 'inp-fs-major',  slider: 'inp-fs-major-slider',  read: 'fs-major-read' },
    pitch:  { box: 'inp-fs-pitch',  slider: 'inp-fs-pitch-slider',  read: 'fs-pitch-read' },
    length: { box: 'inp-fs-length', slider: 'inp-fs-length-slider', read: 'fs-length-read' },
    fit:    { box: 'inp-fs-fit',    slider: 'inp-fs-fit-slider',    read: 'fs-fit-read' },
    nutm:   { box: 'inp-fs-nutm',   slider: 'inp-fs-nutm-slider',   read: 'fs-nutm-read' }
  };
  /* armed: a tile has been clicked and not yet baked. Only then is there a preview - none on opening the card, none after a bake */
  var S = { kind: 'bolt', head: 'hex', touched: {}, tiles: false, ok: false, armed: false };

  function menu() { return $('menu-fasteners'); }
  /* open, and so is every menu it sits in (Gen+): a preview for a card nobody can see is clutter */
  function isOpen() {
    var m = menu();
    for (var d = m; d; d = d.parentElement && d.parentElement.closest('details')) if (!d.open) return false;
    return !!m;
  }
  function have() { return typeof NSO_Thread !== 'undefined'; }

  /* ---------------------------------------------------------------- the fields */

  /* write a number into a field - box, slider and read-out - without firing its live preview */
  function setField(name, v) {
    var F = FIELDS[name], box = $(F.box), sl = $(F.slider), rd = $(F.read);
    var t = String(r2(v));
    if (box) box.value = t;
    if (sl) sl.value = t;
    if (rd) rd.textContent = t + ' mm';
  }
  function showRead(name) {
    var F = FIELDS[name], v = num(F.box), rd = $(F.read), sl = $(F.slider);
    if (rd) rd.textContent = v === null ? '—' : r2(v) + ' mm';
    if (sl && v !== null) sl.value = String(v);
  }
  function table(size) { return (have() && NSO_Thread.SIZES[size]) || null; }
  function stdNut(major) { return have() ? NSO_Thread.hardware(major).nutM : 6.8; }

  /* A number was moved by the user. The nut's thickness follows the Ø (the standard nut for it) until it is moved itself. */
  function touch(name) {
    S.touched[name] = true;
    if (name === 'major' && !S.touched.nutm) { var ma = num(FIELDS.major.box); if (ma != null) setField('nutm', stdNut(ma)); }
  }

  /* Size chosen: Ø, Pitch and the nut's thickness go to the table's own (and are no longer "touched"). */
  function syncFromSize() {
    var t = table(val('sel-fs-size'));
    if (!t) return;
    setField('major', t.major); setField('pitch', t.pitch); setField('nutm', stdNut(t.major));
    S.touched.major = S.touched.pitch = S.touched.nutm = false;
  }

  /* the card's numbers as nso_thread.js's options: an unchanged Ø or pitch is not passed, so the table's own is used exactly */
  function inputs() {
    var size = val('sel-fs-size') || 'M8', t = table(size) || { major: 8, pitch: 1.25 };
    var o = { size: size, hand: val('sel-fs-hand') === 'left' ? 'left' : 'right' };
    var ma = num(FIELDS.major.box), pi = num(FIELDS.pitch.box);
    if (ma != null && Math.abs(ma - t.major) > 0.0051) o.major = ma;
    if (pi != null && Math.abs(pi - t.pitch) > 0.0051) o.pitch = pi;
    return { o: o, length: num(FIELDS.length.box), fit: num(FIELDS.fit.box), nutm: num(FIELDS.nutm.box), size: size };
  }

  /* what the current choice makes: { ok, items: [{ label, soup, reason, kind }], text } or { ok: false, reason } */
  function build(kind) {
    if (!have()) return { ok: false, reason: 'Fasteners needs nso_thread.js' };
    kind = kind || S.kind;
    var I = inputs(), items = [], r;
    function one(what, fn, label) {
      var q;
      try { q = fn(); } catch (e) { q = { ok: false, reason: (e && e.message) || String(e) }; }
      if (!q.ok) return { ok: false, reason: what + ': ' + q.reason };
      items.push({ label: label(q), soup: q.soup, reason: q.reason, kind: what, r: q });
      return null;
    }
    var bad = null;
    if (kind === 'rod') {
      bad = one('Rod', function () { return NSO_Thread.rod(Object.assign({}, I.o, { length: I.length != null ? I.length : 40 })); }, function (q) { return 'rod ' + q.info.size; });
    }
    if (!bad && (kind === 'bolt' || kind === 'set')) {
      bad = one('Bolt', function () { return NSO_Thread.bolt(Object.assign({}, I.o, { length: I.length != null ? I.length : 25, head: S.head })); }, function (q) { return 'bolt ' + q.info.size; });
    }
    if (!bad && (kind === 'nut' || kind === 'set')) {
      bad = one('Nut', function () { return NSO_Thread.nut(Object.assign({}, I.o, { fit: I.fit, thickness: S.touched.nutm && I.nutm != null ? I.nutm : undefined })); },
                function (q) { return 'nut ' + q.info.size; });
    }
    if (bad) return bad;
    return { ok: true, items: items, text: items.map(function (x) { return x.reason; }).join(' - and ') };
  }

  /* ---------------------------------------------------------------- the preview */

  /* the ghost is the shared one (app-piece-preview.js): beside the selection, one at a time, a scene helper and not a piece */
  var PV = function () { return window.nsoPiecePreview; };
  function ghostClear() { if (PV()) PV().clear('fasteners'); }
  function ghostShow(items) { if (PV()) PV().show('fasteners', items.map(function (it) { return it.soup; })); }

  function setAdd(on) { var b = $('btn-fs-add'); if (b) b.disabled = !on; S.ok = !!on; }

  /* the preview, now: build what the card says, show it, say what it is - or clear it and say why */
  function refresh() {
    if (!isOpen()) { ghostClear(); return null; }
    if (!S.armed) { ghostClear(); setAdd(false); readout('Pick Rod, Bolt, Nut or Bolt + nut to preview it'); return null; }
    var b = build();
    if (!b.ok) { ghostClear(); setAdd(false); readout(b.reason, true); return b; }
    ghostShow(b.items); setAdd(true);
    readout('Preview - ' + b.text);
    return b;
  }
  var timer = 0;
  function soon() { if (timer) return; timer = setTimeout(function () { timer = 0; refresh(); }, 30); }

  /* ---------------------------------------------------------------- the choice */

  function syncRows() {
    var k = S.kind;
    var show = function (id, on) { var el = $(id); if (el) el.hidden = !on; };
    show('fs-length-row', k !== 'nut');
    show('fs-head-row', k === 'bolt' || k === 'set');
    show('fs-fit-row', k === 'nut' || k === 'set');
    show('fs-nutm-row', k === 'nut' || k === 'set');
    document.querySelectorAll('#fs-kind-row [data-kind]').forEach(function (b) { b.setAttribute('aria-pressed', S.armed && b.getAttribute('data-kind') === k ? 'true' : 'false'); });
    document.querySelectorAll('#fs-head-row [data-head]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-head') === S.head ? 'true' : 'false'); });
  }
  function selectKind(kind) {
    if (KINDS.indexOf(kind) < 0) return false;
    var was = S.kind;
    S.kind = kind; S.armed = true;
    if (!S.touched.length && KIND_LENGTH[kind] && KIND_LENGTH[kind] !== KIND_LENGTH[was]) setField('length', KIND_LENGTH[kind]);
    syncRows();
    refresh();
    return true;
  }
  function selectHead(head) {
    if (head !== 'hex' && head !== 'socket') return false;
    S.head = head; syncRows(); refresh();   // a head choice only changes a preview that is already up
    return true;
  }

  /* ---------------------------------------------------------------- the bake */

  /* Add to plate: drop what the preview shows. A set is both or neither (built first, so a refusal on either adds nothing). */
  function bake(kind) {
    if (kind && kind !== S.kind) { S.kind = kind; syncRows(); }
    var b = build();
    var tag = { rod: 'Rod', bolt: 'Bolt', nut: 'Nut', set: 'Bolt + nut' }[S.kind];
    if (!b.ok) { say(tag + ' refused - nothing added: ' + b.reason, true); readout(b.reason, true); return { ok: false, reason: b.reason }; }
    var add = window.nsoFittings && window.nsoFittings.addPiece;
    if (typeof add !== 'function') { say('Fasteners needs the Fittings card (app-fittings.js)', true); return { ok: false, reason: 'no addPiece' }; }
    ghostClear();                                           // so the drop's free-spot search is not looking at the preview
    var made = [];
    b.items.forEach(function (it) {
      var put = add(it.label, it.soup, it.reason);
      made.push({ ok: put.ok, name: put.name, modelId: put.modelId, placedIndex: put.placedIndex, reason: it.reason, kind: it.kind });
    });
    readout('Added ' + made.map(function (m) { return m.name; }).join(' and ') + ' - ' + b.text);
    var res = { ok: made.every(function (m) { return m.ok; }), pieces: made, reason: b.text };
    if (made.length === 1) { res.modelId = made[0].modelId; res.name = made[0].name; res.placedIndex = made[0].placedIndex; res.added = made[0].ok; }
    else { res.bolt = made[0]; res.nut = made[1]; }
    /* baked: disarm. No new ghost beside the piece just added - the next one starts when a tile is clicked again */
    S.armed = false; syncRows(); setAdd(false); ghostClear();
    return res;
  }

  /* ---------------------------------------------------------------- the tiles */

  var A = function () { return window.nsoPiecePreview.art; };
  function tileArt(name) {
    var T = NSO_Thread, a = A(), flipUp = a.flipUp, moveZ = a.moveZ, join = a.join, AMBER = a.AMBER, bolt, nut, body;
    switch (name) {
      case 'rod': return { soup: T.rod({ size: 'M8', length: 16 }).soup };
      case 'bolt': return { soup: flipUp(T.bolt({ size: 'M8', length: 14 }).soup), view: { yaw: 0.62, elev: 0.5 } };
      case 'nut': return { soup: T.nut({ size: 'M8', thickness: 7 }).soup, view: { yaw: 0.62, elev: 0.9 } };
      case 'set':
        bolt = T.bolt({ size: 'M8', length: 16 }); nut = T.nut({ size: 'M8', thickness: 6.8 });
        body = flipUp(bolt.soup);
        var n1 = body.length / 9;
        return { soup: join(body, moveZ(nut.soup, -(bolt.info.headK + 16) + 1.5)), view: { yaw: 0.62, elev: 0.5 }, tint: function (t) { return t >= n1 ? AMBER : null; } };
      case 'hex': return { soup: flipUp(T.bolt({ size: 'M8', length: 3.5 }).soup), view: { yaw: 0.62, elev: 0.85 } };
      case 'socket': return { soup: flipUp(T.bolt({ size: 'M8', length: 3.5, head: 'socket' }).soup), view: { yaw: 0.62, elev: 1.0 } };
    }
    return null;
  }
  function drawTiles() {
    if (S.tiles || !have()) return 0;
    var paint = window.nsoStockShelf && window.nsoStockShelf.paint;
    if (typeof paint !== 'function') return 0;
    S.tiles = true;
    var done = 0;
    document.querySelectorAll('#menu-fasteners .fs-tile').forEach(function (b) {
      var c = b.querySelector('canvas');
      if (!c) return;
      var art;
      try { art = tileArt(b.getAttribute('data-kind') || b.getAttribute('data-head')); } catch (e) { art = null; }
      if (art && paint(c, art.soup, art.tint, art.view)) { c.setAttribute('data-drawn', '1'); done++; }
    });
    return done;
  }

  /* ---------------------------------------------------------------- wiring */

  function wire() {
    var m = menu();
    if (!m || m.dataset.nsoWired === '1') return;
    m.dataset.nsoWired = '1';
    document.querySelectorAll('#fs-kind-row [data-kind]').forEach(function (b) { b.addEventListener('click', function () { selectKind(b.getAttribute('data-kind')); }); });
    document.querySelectorAll('#fs-head-row [data-head]').forEach(function (b) { b.addEventListener('click', function () { selectHead(b.getAttribute('data-head')); }); });
    var size = $('sel-fs-size'), hand = $('sel-fs-hand');
    if (size) size.addEventListener('change', function () { syncFromSize(); refresh(); });
    if (hand) hand.addEventListener('change', function () { refresh(); });
    Object.keys(FIELDS).forEach(function (name) {
      var F = FIELDS[name];
      if (window.nsoLiveSlider) {
        window.nsoLiveSlider.bind({ slider: F.slider, box: F.box, read: F.read, unit: ' mm', onLive: function () { touch(name); soon(); } });
      } else {                                              // no live slider module: the box and the slider still say one number
        var box = $(F.box), sl = $(F.slider);
        if (box) box.addEventListener('input', function () { touch(name); showRead(name); soon(); });
        if (sl) sl.addEventListener('input', function () { if (box) box.value = sl.value; touch(name); showRead(name); soon(); });
      }
    });
    var add = $('btn-fs-add');
    if (add) add.addEventListener('click', function () {
      try { bake(); } catch (err) {
        if (typeof console !== 'undefined') console.error('[fasteners]', err);
        say('Fasteners failed - nothing added (' + ((err && err.message) || err) + ')', true);
      }
    });
    var onToggle = function () { if (isOpen()) { drawTiles(); refresh(); } else ghostClear(); };
    for (var d = m; d; d = d.parentElement && d.parentElement.closest('details')) d.addEventListener('toggle', onToggle);
    // a click that selects another piece (or an Undo, a Remove) moves where the drop would land: stand the preview there
    window.addEventListener('pointerup', function () { if (isOpen() && PV() && PV().count()) setTimeout(function () { if (PV().state().owner === 'fasteners') PV().place(); }, 0); }, true);
    if (have()) {
      var f = $(FIELDS.fit.box); if (f && !S.touched.fit) setField('fit', NSO_Thread.DEFAULTS.fit);
      syncFromSize(); setField('length', KIND_LENGTH[S.kind]);
    }
    syncRows();
    if (isOpen()) { drawTiles(); refresh(); }
  }

  window.nsoFasteners = {
    // each bakes that kind with the card's numbers now (what the Add to plate button does for the chosen tile)
    rod: function () { return bake('rod'); }, bolt: function () { return bake('bolt'); }, nut: function () { return bake('nut'); }, set: function () { return bake('set'); },
    add: bake, select: selectKind, head: selectHead, preview: refresh, build: build, drawTiles: drawTiles,
    state: function () {
      var g = PV() ? PV().state() : { owner: null, count: 0, ghost: [] }, mine = g.owner === 'fasteners';
      return { kind: S.kind, head: S.head, ghosts: mine ? g.count : 0, ok: S.ok, open: isOpen(), tiles: S.tiles, touched: Object.assign({}, S.touched), ghost: mine ? g.ghost : [] };
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
