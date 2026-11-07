/* ============================================================
   Pottery Wheel - live sliders.

   Every number on the Wheel card is a slider with a number box and a read-out
   (the house pattern: app-live-slider.js, as Hollow and Fasteners use it), and
   the piece answers while the slider is moving.

     drag a slider   the piece itself changes, live, as a PREVIEW - nothing is
                     committed and the Undo stack does not move. Pull draws a
                     GHOST instead (see below).
     let go          that is Set: one Undo step, no Set button (Pull's rule).
     type a number   it previews as you type; Enter or clicking away sets it.
     Escape          puts the preview away and the sliders back to the piece.

   WHAT EACH SLIDER DOES
     H R W N     size the next ball - and resize THIS one live while it is still
                 an untouched ball (NSO_wheelReball). Once anything has been done
                 to it they only set the next ball, and the read-out says so.
     Thick       Flatten, live: the top comes down, the diameter grows, the clay
                 is conserved (NSO_wheelFlatten). Sits at the piece's thickness.
     Deep        Open, live. Dragging it again re-opens the BALL to the new depth
                 (NSO_wheelBaseOf) - it adjusts, it does not stack a second.
     Z and Δr    Pull. A moveable GHOST of the pulled form over the real piece:
                 Z is where on the piece, Δr is how far out or in. The ghost
                 stops where the clay, the wall or the height runs out, and the
                 read-out says which (NSO_wheelPullClamped) - so a pull gives as
                 much as it can instead of failing. Letting go of Δr sets it and
                 puts Δr back to 0.
     Trim, Rim + live, like Thick; each adjusts its own last step.

   The ranges are the piece's own and are re-read after every move, Undo and new
   ball (NSO_wheelRanges): a slider that cannot do its move now is drawn
   disabled with the reason as its tooltip.

   THE PREVIEW NEVER TOUCHES THE PIECE. The placed mesh's geometry is swapped for
   a throwaway one (Pull's own mechanism) with its bottom kept where the real
   piece's bottom is, m.rawTris is untouched, and ending the preview puts the
   original geometry back. A real move, a new ball, Escape, the menu closing or
   anything else changing the piece ends it first (NSO_wheelUI.end).
   ============================================================ */
(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof NSO_wheelRun !== 'function') return;

  function $(id) { return document.getElementById(id); }

  var DEFS = {};            // by key: { slider, box, read, unit, fmt, ... }
  var handles = {};         // nsoLiveSlider handles, by key
  var LIVE = null;          // the preview in flight: { mode, mesh, origGeo, geo, ghost, origH }

  function trim(x, step) {
    var st = String(step || 0.1), dot = st.indexOf('.');
    var d = dot < 0 ? 0 : st.length - dot - 1;
    var k = Math.pow(10, Math.max(d, 1));
    return String(Math.round(x * k) / k);
  }
  function num(id) {
    var v = parseFloat(($(id) || {}).value);
    return isFinite(v) ? v : undefined;
  }
  function pos(id) { var v = num(id); return (v !== undefined && v > 0) ? v : undefined; }

  /* ------------------------------------------------------------ read-out */
  function readout(text, bad) {
    var el = $('wheel-readout');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('carve-bad', !!bad);
  }
  function idleReadout() {
    if (NSO_wheelSession && NSO_wheelHome) readout(NSO_wheelStatus(NSO_wheelSession, 'On the wheel'));
    else readout('Press Ball to drop a ball of clay.');
  }

  /* ------------------------------------------------------------ the preview */
  function entryOf(m) {
    if (!m || typeof state === 'undefined' || !state.placed) return null;
    for (var i = 0; i < state.placed.length; i++) {
      if (state.placed[i] && state.placed[i].sourceId === m.id) return state.placed[i];
    }
    return null;
  }

  function end() {
    var L = LIVE;
    if (!L) return;
    LIVE = null;
    if (L.mesh && L.geo && L.mesh.geometry === L.geo && L.origGeo) L.mesh.geometry = L.origGeo;
    if (L.geo) L.geo.dispose();
    if (L.ghost) {
      if (L.ghost.parent) L.ghost.parent.remove(L.ghost);
      if (L.ghost.geometry) L.ghost.geometry.dispose();
      if (L.ghost.material) L.ghost.material.dispose();
    }
  }

  /* The throwaway geometry for a piece of the wheel, with its bottom where the
     real piece's bottom is: a display geometry is centred on its own bounding
     box, so a piece that is taller or shorter than the real one is moved by
     half the difference. */
  function previewGeometry(piece, origH) {
    var soup = NSO_wheelRevolve(piece);
    var geo = rawResultToDisplayGeometry(soup);
    var bb = geo.boundingBox;
    geo.translate(0, ((bb.max.y - bb.min.y) - origH) / 2, 0);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }

  function ensure(mode, m) {
    var e = entryOf(m);
    if (!e || !e.mesh) return null;
    if (LIVE && (LIVE.mesh !== e.mesh || LIVE.mode !== mode)) end();
    if (!LIVE) LIVE = { mode: mode, mesh: e.mesh, origGeo: e.mesh.geometry, geo: null, ghost: null, origH: m.size.y };
    return LIVE;
  }

  function draw(mode, piece, m, clamped) {
    var L = ensure(mode, m);
    if (!L) return false;
    var geo = previewGeometry(piece, L.origH);
    if (mode === 'swap') {
      var old = L.geo;
      L.mesh.geometry = geo;
      L.geo = geo;
      if (old) old.dispose();
    } else {
      if (!L.ghost) {
        var mat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.5,
          metalness: 0.05, roughness: 0.5, depthWrite: false });
        L.ghost = new THREE.Mesh(geo, mat);
        L.ghost.renderOrder = 2;
        (L.mesh.parent || state.modelGroup || state.scene).add(L.ghost);
      } else {
        L.ghost.geometry.dispose();
        L.ghost.geometry = geo;
      }
      L.ghost.position.copy(L.mesh.position);
      L.ghost.quaternion.copy(L.mesh.quaternion);
      L.ghost.scale.copy(L.mesh.scale);
      /* Blue while it is all of what was asked; amber once it has been stopped. */
      L.ghost.material.color.setHex(clamped ? 0xf59e0b : 0x38bdf8);
    }
    return true;
  }

  /* Drop a ghost that no longer has a valid form to show (a refusal). */
  function dropGhost() {
    if (LIVE && LIVE.mode === 'ghost') end();
  }

  /* Run one move on a copy and draw it. `mode`: the piece itself ('swap') or a
     ghost over it ('ghost'). Returns the move's result. */
  function preview(move, opts, mode) {
    var sync = NSO_wheelSync();
    if (!sync.ok) { end(); readout(sync.reason, true); return sync; }
    var m = sync.model;
    var paint = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (paint > 0) { readout('Pottery Wheel stood down - ' + paint + ' painted face(s). Clear paint to throw.', true); return { ok: false }; }
    var base = NSO_wheelBaseOf(NSO_wheelSession, NSO_wheelHome.history, move);
    var r = NSO_wheelApply(move, base, opts);
    if (!r.ok) {
      if (mode === 'ghost') dropGhost();            // swap keeps the last good form on show
      readout(r.reason, true);
      return r;
    }
    draw(mode, r.piece, m, !!r.clamped);
    readout((mode === 'ghost' ? 'Ghost - ' : 'Preview - ') + NSO_wheelStatus(r.piece, r.reason) +
      (mode === 'ghost' ? '. Let go of Δr to set it.' : '. Let go to set it.'), false);
    return r;
  }

  function commit(move, opts, head) {
    NSO_wheelMarkSet(move);
    end();
    var r = NSO_wheelRun(move, opts, head);
    refresh();
    var st = $('status');
    if (r && !r.ok && st) readout(st.textContent, true);
    else idleReadout();
    return r;
  }

  /* ------------------------------------------------------------ the sliders */
  function ballOpts() {
    return { height: pos('inp-wheel-height'), radius: pos('inp-wheel-radius'),
             wall: pos('inp-wheel-wall'), nozzle: pos('inp-wheel-nozzle') };
  }
  function pullOpts() {
    var z = num('inp-wheel-pull-z'), dr = num('inp-wheel-pull-dr');
    return { z: z, dr: dr, clamp: true };
  }

  function paintRead(d) {
    var read = $(d.read), box = $(d.box);
    if (!read || !box) return;
    var v = parseFloat(box.value);
    read.textContent = d.fmt ? d.fmt(isFinite(v) ? v : null) : (isFinite(v) ? trim(v, $(d.slider).step) + d.unit : '—');
  }

  function define(key, d) { d.key = key; DEFS[key] = d; }

  define('height', { slider: 'rng-wheel-height', box: 'inp-wheel-height', read: 'out-wheel-height', unit: ' mm',
    fmt: function (v) { return v && v > 0 ? trim(v, 1) + ' mm' : 'auto'; },
    live: function () { ballLive(); }, set: function () { ballSet(); }, setOnType: false });
  define('radius', { slider: 'rng-wheel-radius', box: 'inp-wheel-radius', read: 'out-wheel-radius', unit: ' mm',
    fmt: function (v) { return v && v > 0 ? trim(v, 1) + ' mm' : 'auto'; },
    live: function () { ballLive(); }, set: function () { ballSet(); }, setOnType: false });
  define('wall', { slider: 'rng-wheel-wall', box: 'inp-wheel-wall', read: 'out-wheel-wall', unit: ' mm',
    live: function () { ballLive(); }, set: function () { ballSet(); }, setOnType: false });
  define('nozzle', { slider: 'rng-wheel-nozzle', box: 'inp-wheel-nozzle', read: 'out-wheel-nozzle', unit: ' mm',
    live: function () { ballLive(); }, set: function () { ballSet(); }, setOnType: false });

  define('flatten', { slider: 'rng-wheel-flat', box: 'inp-wheel-flat-h', read: 'out-wheel-flat', unit: ' mm', move: 'flatten',
    live: function () { preview('flatten', { height: num('inp-wheel-flat-h') }, 'swap'); },
    set: function () { commit('flatten', { height: num('inp-wheel-flat-h') }, 'Flattened'); }, setOnType: true });
  define('open', { slider: 'rng-wheel-depth', box: 'inp-wheel-depth', read: 'out-wheel-depth', unit: ' mm', move: 'open',
    live: function () { preview('open', { depth: num('inp-wheel-depth') }, 'swap'); },
    set: function () { commit('open', { depth: num('inp-wheel-depth') }, 'Opened'); }, setOnType: true });
  define('pullz', { slider: 'rng-wheel-pull-z', box: 'inp-wheel-pull-z', read: 'out-wheel-pull-z', unit: ' mm', move: 'pull',
    live: function () { pullLive(); }, set: function () { pullLive(); }, setOnType: false });
  define('pulldr', { slider: 'rng-wheel-pull-dr', box: 'inp-wheel-pull-dr', read: 'out-wheel-pull-dr', unit: ' mm', move: 'pull',
    fmt: function (v) { return v === null ? '—' : (v > 0 ? '+' : '') + trim(v, 0.5) + ' mm'; },
    live: function () { pullLive(); }, set: function () { pullSet(); }, setOnType: true });
  define('trim', { slider: 'rng-wheel-trim', box: 'inp-wheel-trim-z', read: 'out-wheel-trim', unit: ' mm', move: 'trim',
    live: function () { preview('trim', { z: num('inp-wheel-trim-z') }, 'swap'); },
    set: function () { commit('trim', { z: num('inp-wheel-trim-z') }, 'Trimmed'); }, setOnType: true });
  define('rim', { slider: 'rng-wheel-rim', box: 'inp-wheel-rim-mm', read: 'out-wheel-rim', unit: ' mm', move: 'rim',
    live: function () { preview('rim', { delta: num('inp-wheel-rim-mm') }, 'swap'); },
    set: function () { commit('rim', { delta: pos('inp-wheel-rim-mm') }, 'Rim extended'); }, setOnType: true });

  /* The ball sliders: resize an untouched ball live; otherwise they only set the next one. */
  function ballLive() {
    if (!NSO_wheelSession || !NSO_wheelIsPristine(NSO_wheelSession)) {
      end();
      readout(NSO_wheelSession
        ? 'The ball has been worked - these size the NEXT ball. Press Ball to drop it.'
        : 'These size the ball. Press Ball to drop it.', false);
      return;
    }
    preview('reball', ballOpts(), 'swap');
  }
  function ballSet() {
    if (NSO_wheelSession && NSO_wheelIsPristine(NSO_wheelSession)) commit('reball', ballOpts(), 'Ball resized');
  }

  /* Pull: Z only moves the ghost; Δr moves it out or in and, let go, sets it. */
  function pullLive() {
    var o = pullOpts();
    if (!(isFinite(o.z) && isFinite(o.dr))) return;
    if (Math.abs(o.dr) < 1e-9) { dropGhost(); idleReadout(); return; }
    preview('pull', o, 'ghost');
  }
  function pullSet() {
    var o = pullOpts();
    if (!(isFinite(o.z) && isFinite(o.dr)) || Math.abs(o.dr) < 1e-9) { end(); return; }
    var r = commit('pull', o, 'Pulled');
    var dr = $('inp-wheel-pull-dr'), sl = $('rng-wheel-pull-dr');
    if (dr) dr.value = '0';
    if (sl) sl.value = '0';
    paintRead(DEFS.pulldr);
    return r;
  }

  function bind(d) {
    var slider = $(d.slider), box = $(d.box);
    if (!slider || !box) return;
    var handle = window.nsoLiveSlider
      ? window.nsoLiveSlider.bind({ slider: d.slider, box: d.box, read: d.read, unit: d.unit, onLive: function () { d.live(); } })
      : null;
    handles[d.key] = handle;
    /* The helper writes its own read-out (value + unit); say it our way after it. */
    var after = function () { paintRead(d); };
    slider.addEventListener('input', after);
    box.addEventListener('input', after);
    if (!handle) {                       // no helper module: a plain, unthrottled version
      slider.addEventListener('input', function () { box.value = slider.value; d.live(); });
      box.addEventListener('input', function () { slider.value = box.value; d.live(); });
    }
    /* Let go of the slider (or Enter / click away in the box) is Set. */
    slider.addEventListener('change', function () { if (handle) handle.cancel(); d.set(); });
    box.addEventListener('change', function () {
      if (handle) handle.cancel();
      if (d.setOnType) d.set(); else d.live();
    });
    paintRead(d);
  }

  /* ------------------------------------------------------------ ranges */
  function setRange(key, r, why, keep) {
    var d = DEFS[key], slider = $(d.slider), box = $(d.box);
    if (!slider || !box) return;
    if (!r.on) {
      slider.disabled = true; box.disabled = true;
      slider.title = box.title = why || r.why || '';
      return;
    }
    slider.disabled = false; box.disabled = false;
    slider.title = box.title = '';
    slider.min = String(r.min); slider.max = String(r.max); slider.step = String(r.step);
    /* Thick, Deep and Trim say what the PIECE is, so they follow it. Rim + is an
       AMOUNT the person chose (set it, find the wall is not straight, straighten
       it, press again), so it keeps what it was set to. */
    var v = r.value;
    if (keep) {
      var was = parseFloat(box.value);
      if (isFinite(was)) v = Math.min(r.max, Math.max(r.min, was));
    }
    slider.value = String(v); box.value = trim(v, r.step);
    box.min = String(r.min); box.max = String(r.max);
    paintRead(d);
  }

  function refresh() {
    var home = NSO_wheelHome, piece = home ? NSO_wheelSession : null;
    var R = NSO_wheelRanges(piece, home && home.history);
    setRange('flatten', R.flatten);
    setRange('open', R.open);
    setRange('trim', R.trim);
    setRange('rim', R.rim, null, true);
    /* Pull: the two sliders share one range record. */
    var zs = $(DEFS.pullz.slider), zb = $(DEFS.pullz.box), ds = $(DEFS.pulldr.slider), db = $(DEFS.pulldr.box);
    if (!R.pull.on) {
      [zs, zb, ds, db].forEach(function (e) { if (e) { e.disabled = true; e.title = R.pull.why || ''; } });
    } else {
      [zs, zb, ds, db].forEach(function (e) { if (e) { e.disabled = false; e.title = ''; } });
      zs.min = String(R.pull.zMin); zs.max = String(R.pull.zMax); zs.step = String(R.pull.step);
      var z = parseFloat(zb.value);
      if (!isFinite(z) || z < R.pull.zMin || z > R.pull.zMax) z = (R.pull.zMin + R.pull.zMax) / 2;
      z = Math.round(z / R.pull.step) * R.pull.step;
      zs.value = String(z); zb.value = trim(z, R.pull.step); zb.min = String(R.pull.zMin); zb.max = String(R.pull.zMax);
      ds.min = String(R.pull.drMin); ds.max = String(R.pull.drMax); ds.step = String(R.pull.step);
      ds.value = '0'; db.value = '0';
      paintRead(DEFS.pullz); paintRead(DEFS.pulldr);
    }
    if (!LIVE) idleReadout();
  }

  /* ------------------------------------------------------------ keeping in step */
  function menuEl() { var b = $('btn-wheel-ball'); return b ? b.closest('details.vp-wheel-menu') : null; }
  function menuOpen() {
    for (var d = menuEl(); d; d = d.parentElement && d.parentElement.closest('details')) if (!d.open) return false;
    return !!menuEl();
  }

  var seen = { home: null, raw: null };
  function watch() {
    if (!menuOpen()) { end(); return; }
    if (LIVE) return;
    var m = NSO_wheelHome ? NSO_wheelModel() : null;
    var raw = m ? m.rawTris : null;
    if (seen.home === NSO_wheelHome && seen.raw === raw) return;
    /* Undo, or another tool, moved the piece under the wheel. */
    if (NSO_wheelHome) NSO_wheelSync();
    seen = { home: NSO_wheelHome, raw: NSO_wheelHome && NSO_wheelModel() ? NSO_wheelModel().rawTris : null };
    refresh();
  }

  function wire() {
    Object.keys(DEFS).forEach(function (k) { bind(DEFS[k]); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && LIVE) { end(); refresh(); idleReadout(); }
    });
    var menu = menuEl();
    if (menu) menu.addEventListener('toggle', function () { if (!menu.open) end(); else refresh(); });
    setInterval(watch, 300);
    refresh();
  }

  NSO_wheelUI = { end: end, refresh: function () { seen = { home: null, raw: null }; refresh(); } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
