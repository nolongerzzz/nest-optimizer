/* ============================================================
   Pottery Wheel - the live sliders.

   THE PIECE IS A RECIPE (app-wheel.js, "7g. THE RECIPE"), and every slider is
   one live value in it. Nothing is baked into the piece, so nothing is ever shut
   off: the form is rebuilt from the ball, in the order a potter works, whenever
   any slider moves.

     Starter Ball   drops the ball (25 mm radius unless Scale says otherwise) and
                    starts a recipe on it
     Scale          the size of the ball - at any time, under everything else
     W              the wall: how thin the disc may press and the walls open
     Thick          press the ball flat (the top comes down, the diameter grows)
     Deep           push in to open it (the clay rises into walls)
     Pull at        where on the piece, as a percentage of its height
     Pull           how far out (or in) the wall goes there
     Soft           how wide the pull spreads, as a percentage of the height
     Trim           take this much off the base
     Rim +          add height at the rim (needs a straight wall)

   drag a slider   the piece itself changes, live, as a PREVIEW: nothing is set,
                   and the Undo stack does not move
   let go          that is Set: one Undo step. The RECIPE stays editable - the next
                   drag, on any slider, starts from the ball again
   Escape          puts the preview away

   THERE IS NOTHING TO TYPE INTO. Each slider is a label, the track and what it
   says (the read-out), on one row; the number is the slider's own, through the
   shared helper's optional-box form (app-live-slider.js).

   A LIMIT IS NOT A REFUSAL. A slider the current shape cannot fully honour (Deep
   on a 3 mm disc, a Pull that would take the wall under the nozzle floor, Rim +
   on a curved wall) is CLAMPED to what it can do and the read-out says so - the
   slider is never disabled. Each slider's range follows what is upstream of it
   (Deep's maximum depends on how far Thick has pressed), and is re-read on every
   preview.

   THE PREVIEW NEVER TOUCHES THE PIECE. The placed mesh's geometry is swapped for
   a throwaway one (Pull's own mechanism) with its bottom kept where the real
   piece's bottom is, m.rawTris is untouched, and ending the preview puts the
   original geometry back. A new ball, Escape, the menu closing, or anything else
   changing the piece ends it first (NSO_wheelUI.end).
   ============================================================ */
(function () {
  'use strict';
  if (typeof document === 'undefined' || typeof NSO_wheelBuild !== 'function') return;

  function $(id) { return document.getElementById(id); }

  var DEFS = {};            // by key
  var handles = {};         // nsoLiveSlider handles, by key
  var LIVE = null;          // the preview in flight: { mesh, origGeo, geo, origH }
  var draft = null;         // uncommitted edits to the recipe, between a drag and its release
  var pending = NSO_wheelNewRecipe({});   // the recipe the sliders hold while no piece is on the wheel
  var lastRanges = null;

  function trim(x, step) {
    var st = String(step || 0.1), dot = st.indexOf('.');
    var d = dot < 0 ? 0 : st.length - dot - 1;
    var k = Math.pow(10, Math.max(d, 1));
    return String(Math.round(x * k) / k);
  }
  function sliderVal(d) { var v = parseFloat(($(d.slider) || {}).value); return isFinite(v) ? v : undefined; }

  /* ------------------------------------------------------------ read-out */
  function readout(text, bad) {
    var el = $('wheel-readout');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('carve-bad', !!bad);
  }

  function describe(b, head) {
    var rMax = 0;
    for (var i = 0; i < b.piece.outer.length; i++) if (b.piece.outer[i].r > rMax) rMax = b.piece.outer[i].r;
    if (b.piece.inner) for (i = 0; i < b.piece.inner.length; i++) if (b.piece.inner[i].r > rMax) rMax = b.piece.inner[i].r;
    var sp = NSO_wheelSpan(b.piece.outer);
    var line = (head ? head + ' ' : '') + 'Ø' + (2 * rMax).toFixed(1) + ' × ' + (sp.hi - sp.lo).toFixed(1) + ' mm';
    var st = NSO_wheelStatus(b.piece, line);
    return b.notes.length ? st + ' - ' + b.notes.join('; ') : st;
  }

  /* ------------------------------------------------------------ the preview */
  function modelNow() { return NSO_wheelHome ? NSO_wheelModel() : null; }

  function entryOf(m) {
    if (!m || typeof state === 'undefined' || !state.placed) return null;
    for (var i = 0; i < state.placed.length; i++) {
      if (state.placed[i] && state.placed[i].sourceId === m.id) return state.placed[i];
    }
    return null;
  }

  function end() {
    var L = LIVE;
    LIVE = null;
    draft = null;
    if (!L) return;
    var restored = false;
    if (L.mesh && L.geo && L.mesh.geometry === L.geo && L.origGeo) { L.mesh.geometry = L.origGeo; restored = true; }
    if (L.geo) L.geo.dispose();
    /* The white edge follows the geometry: put it back on the original (the house
       edge cache has it, so this is a lookup, not a rebuild). */
    if (restored && L.entry && typeof refreshOutline === 'function') refreshOutline(L.entry);
  }

  /* The throwaway geometry for a piece of the wheel, with its bottom where the
     real piece's bottom is: a display geometry is centred on its own bounding
     box, so a piece taller or shorter than the real one moves by half the
     difference. */
  function previewGeometry(piece, origH) {
    var geo = rawResultToDisplayGeometry(NSO_wheelRevolve(piece));
    var bb = geo.boundingBox;
    geo.translate(0, ((bb.max.y - bb.min.y) - origH) / 2, 0);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }

  function draw(piece, m) {
    var e = entryOf(m);
    if (!e || !e.mesh) return false;
    if (LIVE && LIVE.mesh !== e.mesh) { var keep = draft; end(); draft = keep; }
    if (!LIVE) LIVE = { mesh: e.mesh, entry: e, origGeo: e.mesh.geometry, geo: null, origH: m.size.y };
    var geo = previewGeometry(piece, LIVE.origH);
    var old = LIVE.geo;
    NSO_wheelWear(geo, piece);          // the white edge is drawn from the piece's own profile
    LIVE.mesh.geometry = geo;
    LIVE.geo = geo;
    if (old) old.dispose();
    /* THE WHITE EDGE STAYS ON, AND ON THE SHAPE YOU ARE SEEING. It is a child
       line built from the mesh's geometry, so a swapped geometry used to leave the
       old piece's edge hanging there; the house refreshOutline rebuilds it for the
       preview (and caches it on the throwaway geometry). */
    if (typeof refreshOutline === 'function') refreshOutline(e);
    return true;
  }

  /* ------------------------------------------------------------ the sliders */
  function define(key, d) { d.key = key; DEFS[key] = d; }

  define('scale', { slider: 'rng-wheel-scale', read: 'out-wheel-scale', unit: ' mm',
    fmt: function (v) { return v === null ? '—' : 'Ø' + trim(2 * v, 1) + ' mm'; },
    get: function (r) { return r.ball.ballRadius || NSO_WHEEL_DEFAULT_BALL_RADIUS; },
    put: function (r, v) { r.ball.ballRadius = v > 0 ? v : undefined; } });
  define('wall', { slider: 'rng-wheel-wall', read: 'out-wheel-wall', unit: ' mm',
    get: function (r) { return r.ball.wall || 3; },
    put: function (r, v) { r.ball.wall = v > 0 ? v : undefined; } });
  define('thick', { slider: 'rng-wheel-flat', read: 'out-wheel-flat', unit: ' mm',
    get: function (r, R) { return r.thick == null ? (R && R.thick ? R.thick.max : 0) : r.thick; },
    put: function (r, v, R) { r.thick = (R && R.thick && v >= R.thick.max - 0.05) ? null : v; } });
  define('depth', { slider: 'rng-wheel-depth', read: 'out-wheel-depth', unit: ' mm',
    get: function (r) { return r.depth || 0; },
    put: function (r, v) { r.depth = v < 0.05 ? 0 : v; } });
  define('pullz', { slider: 'rng-wheel-pull-z', read: 'out-wheel-pull-z', unit: ' %',
    get: function (r) { return Math.round((r.pull.z == null ? 0.5 : r.pull.z) * 100); },
    put: function (r, v) { r.pull.z = v / 100; } });
  define('pulldr', { slider: 'rng-wheel-pull-dr', read: 'out-wheel-pull-dr', unit: ' mm',
    fmt: function (v) { return v === null ? '—' : (v > 0 ? '+' : '') + trim(v, 0.5) + ' mm'; },
    get: function (r) { return r.pull.dr || 0; },
    put: function (r, v) { r.pull.dr = v; } });
  define('wide', { slider: 'rng-wheel-soft', read: 'out-wheel-soft', unit: ' %',
    get: function (r) { return Math.round((r.pull.wide == null ? 0.25 : r.pull.wide) * 100); },
    put: function (r, v) { r.pull.wide = v / 100; } });
  define('trim', { slider: 'rng-wheel-trim', read: 'out-wheel-trim', unit: ' mm',
    get: function (r) { return r.trim || 0; },
    put: function (r, v) { r.trim = v < 0.05 ? 0 : v; } });
  define('rim', { slider: 'rng-wheel-rim', read: 'out-wheel-rim', unit: ' mm',
    get: function (r) { return r.rim || 0; },
    put: function (r, v) { r.rim = v < 0.05 ? 0 : v; } });

  function paintRead(d) {
    var read = $(d.read), slider = $(d.slider);
    if (!read || !slider) return;
    var v = parseFloat(slider.value);
    read.textContent = d.fmt ? d.fmt(isFinite(v) ? v : null) : (isFinite(v) ? trim(v, slider.step) + d.unit : '—');
  }

  /* A slider's range, from the build that has just been done. Never disables:
     a slider that has nothing to do right now sits at its end, with the reason
     as its tooltip. */
  function range(d, min, max, step, why) {
    var slider = $(d.slider);
    if (!slider) return;
    if (!(max > min)) max = min + step;
    slider.min = String(min); slider.max = String(max); slider.step = String(step);
    if (slider.dataset.title === undefined) slider.dataset.title = slider.title || '';
    slider.title = why ? (why + ' - ' + slider.dataset.title) : slider.dataset.title;
  }

  function applyRanges(R) {
    lastRanges = R;
    var th = R.thick || { min: 0, max: 0 };
    range(DEFS.thick, th.min, th.max, 0.1, th.why);
    range(DEFS.depth, 0, R.push ? R.push.max : 0, 0.1, R.push && R.push.max <= 0 ? R.push.why : null);
    var sw = R.pull ? R.pull.swing : 10;
    range(DEFS.pulldr, -sw, sw, 0.5);
    range(DEFS.trim, 0, R.trim ? R.trim.max : 0, 0.1, R.trim && R.trim.max <= 0.1 ? 'nothing to take off the base' : null);
    range(DEFS.rim, 0, R.rim ? R.rim.max : 60, 0.5);
  }

  /* Put every slider (and its read-out) at the recipe's value, clamped into its
     own range. The recipe is the truth; the sliders only say it. */
  function show(recipe, R) {
    Object.keys(DEFS).forEach(function (k) {
      var d = DEFS[k], slider = $(d.slider);
      if (!slider) return;
      var v = d.get(recipe, R);
      var lo = parseFloat(slider.min), hi = parseFloat(slider.max);
      if (isFinite(lo) && isFinite(hi)) v = Math.min(hi, Math.max(lo, v));
      slider.value = String(v);
      paintRead(d);
    });
  }

  function committed() { return NSO_wheelHome ? NSO_wheelHome.recipe : pending; }

  /* Edit the draft (a copy of the committed recipe) from the slider being moved. */
  function readDraft(only) {
    var base = committed();
    if (!draft) draft = NSO_wheelCloneRecipe(base);
    if (only) {
      var v = sliderVal(only);
      if (v !== undefined) only.put(draft, v, lastRanges);
    }
    return draft;
  }

  /* One build of whatever the sliders say now: draw it, say it, re-range. */
  function preview(only) {
    var r = readDraft(only);
    var m = modelNow();
    if (NSO_wheelHome) {
      var sync = NSO_wheelSync();
      if (!sync.ok) { end(); readout(sync.reason, true); return; }
      m = sync.model;
      var paint = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
      if (paint > 0) { readout('Pottery Wheel stood down - ' + paint + ' painted face(s). Clear paint to throw.', true); return; }
      NSO_wheelSelect(m);          // the sliders act on the wheel's piece: it is the selected one, so it wears the white edge
    }
    var b = NSO_wheelBuild(r);
    if (!b.ok) { readout(b.reason, true); return; }
    applyRanges(b.ranges);
    if (!m) {
      pending = NSO_wheelCloneRecipe(r);
      readout('Starter ball will be - ' + describe(b, '') + '. Press Starter Ball to drop it.', false);
      return;
    }
    draw(b.piece, m);
    readout('Preview - ' + describe(b, '') + '. Let go to set it.', b.notes.length > 0);
  }

  function set(only) {
    var r = readDraft(only);
    if (!NSO_wheelHome) {                           // nothing on the wheel: the sliders hold the recipe for the next ball
      pending = NSO_wheelCloneRecipe(r); draft = null;
      preview();
      return;
    }
    end();
    var res = NSO_wheelSetRecipe(r, 'On the wheel');
    draft = null;
    refresh();
    if (res && !res.ok) { var st = $('status'); if (st) readout(st.textContent, true); }
  }

  function bind(d) {
    var slider = $(d.slider);
    if (!slider) return;
    var handle = window.nsoLiveSlider
      ? window.nsoLiveSlider.bind({ slider: d.slider, read: d.read, unit: d.unit, onLive: function () { preview(d); } })
      : null;
    handles[d.key] = handle;
    slider.addEventListener('input', function () { paintRead(d); });   // the helper writes value + unit; say it our way after it
    if (!handle) slider.addEventListener('input', function () { preview(d); });   // no helper module: plain and unthrottled
    /* Let go of the slider is Set. */
    slider.addEventListener('change', function () { if (handle) handle.cancel(); set(d); });
    paintRead(d);
  }

  /* ------------------------------------------------------------ keeping in step */
  function refresh() {
    var r = committed();
    var b = NSO_wheelBuild(r);
    if (b.ok) { applyRanges(b.ranges); }
    show(r, b.ok ? b.ranges : null);
    if (!LIVE) {
      if (NSO_wheelHome && b.ok) readout(describe(b, 'On the wheel -'), b.notes.length > 0);
      else if (b.ok) readout('Press Starter Ball to drop a ball of clay. It will be ' + describe(b, '').replace(/ - .*$/, '') + '.');
      else readout(b.reason, true);
    }
  }

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
    var m2 = NSO_wheelHome ? NSO_wheelModel() : null;
    if (m2) NSO_wheelOutline(m2);       // keep the white edge on whatever the piece is now
    seen = { home: NSO_wheelHome, raw: m2 ? m2.rawTris : null };
    refresh();
  }

  /* Flatten and Open are one-click presets: they move their own slider to its
     far end, live, and set it. They bake nothing - drag the slider back. */
  function preset(key, toMax) {
    var d = DEFS[key], slider = $(d.slider);
    if (!slider) return;
    slider.value = String(toMax ? parseFloat(slider.max) : parseFloat(slider.min));
    paintRead(d);
    set(d);
  }

  function wire() {
    Object.keys(DEFS).forEach(function (k) { bind(DEFS[k]); });
    var f = $('btn-wheel-flatten'), o = $('btn-wheel-open');
    if (f) { f.dataset.nsoWired = '1'; f.addEventListener('click', function () { preset('thick', false); }); }
    if (o) { o.dataset.nsoWired = '1'; o.addEventListener('click', function () { preset('depth', true); }); }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && (LIVE || draft)) { end(); refresh(); }
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
