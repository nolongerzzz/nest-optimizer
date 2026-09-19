/* app-stock.js - the New stock button: put a correctly-sized blank on the
   plate, before any tool that starts from one.

   Thin on purpose, the way app-hollow.js and app-skin-patch.js are thin: all
   the arithmetic and all the geometry live in nso_stock.js, which is
   THREE-free and node-tested, and all the floor lives in nso_thickness.js.
   What is here is the four things that can only be done in the app - read the
   controls, resolve the machine the user is actually pointed at, add the
   piece, and say what happened.

   NOT A BAKE. Every geometry tool in this app replaces the active piece's
   geometry through NSO_sculptCommitRaw. This one ADDS A PIECE and edits none,
   which is why it is its own file, its own menu, and not a fifth button on
   the Pottery Wheel's card: the wheel's Ball starts a wheel SESSION and bakes
   a vessel onto the selection, and that is a different act from putting a
   block on the plate.

   PAINT SCOPE: NONE - it reads no existing geometry unless you ask it to
   match a piece's proportions, and even then it reads that piece's bounding
   box and nothing else, writing to no face of it. No face of any piece is
   touched, which is a stronger statement than "paint is respected". See
   docs/HANDOFF.md, "Scoping" - `none` is a category there, and it is why this
   file is not in tools/nso_paint_scope_test.js's roster: that roster is the
   paint-AWARE features and a row in it needs a paint test to assert.

   The new piece arrives through addModelFromZUpGeometry (app-core.js), the
   one ingest path an imported STL takes, so the block has rawTris exactly as
   a loaded file does and every later tool - Carve, Hollow, Cut, Seat, Skin,
   auto-aim support, both exporters - sees an ordinary piece.

   ---------------------------------------------------------------------------
   THE BUILD VOLUME IS THE MACHINE THE USER IS POINTED AT
   ---------------------------------------------------------------------------
   NSO_fitCurrentPrinter() (app-fit.js) is the app's one resolution path from
   the Plate card - including the custom plate's live W / D / H fields - to an
   nso_printer.js profile. It is passed into the sizing, so the refusal
   happens BEFORE any geometry is built and before anything lands on the
   plate. That is the whole point of checking at generation time: a block that
   cannot be printed never becomes a piece the user then has to delete.

   The one case that is a warning and not a refusal is a stock block bigger
   than the machine whose TARGET still fits. That is a block somebody means to
   split with Cut, so the checkbox says so in those words and nso_stock.js's
   warnOnly carries it. */

(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }

  /* A number box, or undefined when it is blank - so "blank" reaches
     nso_stock.js as "no opinion" and picks up that module's stated default
     rather than a zero this file invented. */
  function num(id) {
    var el = $(id);
    var v = el ? parseFloat(el.value) : NaN;
    return isFinite(v) ? v : undefined;
  }
  function positive(id) {
    var v = num(id);
    return (typeof v === 'number' && v > 0) ? v : undefined;
  }

  /* The shape-specific box: "x:y:z" for a box, a single height/diameter
     number for a cylinder, ignored for a sphere. One field rather than three,
     because two of the three would be blank at any moment. */
  function proportionsOf(shape) {
    var raw = ($('inp-stock-prop') || {}).value;
    if (!raw || !String(raw).trim()) return {};
    var txt = String(raw).trim();
    if (shape === 'cylinder') {
      var k = parseFloat(txt);
      if (!(isFinite(k) && k > 0)) return { error: 'the cylinder ratio box wants one positive number - height over diameter, e.g. 2 for twice as tall as it is wide' };
      return { ratio: k };
    }
    if (shape === 'box') {
      var parts = txt.split(/[:x,\s]+/).filter(function (s) { return s.length; }).map(parseFloat);
      if (parts.length !== 3 || !parts.every(function (n) { return isFinite(n) && n > 0; })) {
        return { error: 'the box proportions box wants three positive numbers, e.g. 2:1:1' };
      }
      return { proportions: { x: parts[0], y: parts[1], z: parts[2] } };
    }
    return {};
  }

  /* The selected piece's raw soup, for "match the selected piece". The same
     rawAxis check Thicken and Hollow make: a piece with only a display
     geometry is centred and rotated, so its extents are not the ones the user
     is looking at, and it is refused by name rather than read anyway. */
  function referenceSoup() {
    var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (!m) return { error: 'Match needs a piece selected - pick one, or untick Match' };
    if (!(m.rawTris && m.rawAxis === 'zup' && m.rawTris.length >= 9)) {
      return { error: 'Match needs a raw piece - "' + m.name + '" has no untransformed soup to read proportions off' };
    }
    return { soup: m.rawTris, name: m.name };
  }

  function readUI() {
    var shape = (($('sel-stock-shape') || {}).value) || 'sphere';
    var o = {
      shape: shape,
      height: positive('inp-stock-height'),
      radius: positive('inp-stock-radius'),
      wall: positive('inp-stock-wall'),
      nozzle: positive('inp-stock-nozzle')
    };
    /* Waste is typed as a PERCENTAGE because that is how a person says it, and
       passed as a fraction because that is what the module takes. 0 is a legal
       answer and must survive the conversion, so it is tested for finiteness
       and not for truthiness. */
    var w = num('inp-stock-waste');
    if (typeof w === 'number' && w >= 0) o.waste = w / 100;

    var p = proportionsOf(shape);
    if (p.error) return { error: p.error };
    if (p.proportions) o.proportions = p.proportions;
    if (p.ratio) o.ratio = p.ratio;

    var match = $('chk-stock-match');
    if (match && match.checked) {
      if (shape === 'sphere') return { error: 'A sphere has one measurement, so there are no proportions to match - pick Box or Cylinder, or untick Match' };
      var ref = referenceSoup();
      if (ref.error) return { error: ref.error };
      o.like = ref.soup;
      o.likeName = ref.name;
    }

    var over = $('chk-stock-oversize');
    if (over && over.checked) o.warnOnly = true;
    return { opts: o };
  }

  /* Generate and add. Exposed on window so the drive check runs the same path
     the button runs rather than a parallel copy of it. */
  function run(overrides) {
    if (typeof NSO_Stock === 'undefined' || !NSO_Stock) {
      say('New stock needs nso_stock.js', true);
      return { ok: false, reason: 'NSO_Stock not loaded' };
    }
    if (typeof THREE === 'undefined' || typeof addModelFromZUpGeometry !== 'function') {
      say('New stock needs the viewport', true);
      return { ok: false, reason: 'no ingest path' };
    }

    var read = readUI();
    if (read.error) { say(read.error, true); return { ok: false, reason: read.error }; }
    var opts = read.opts;
    if (overrides) for (var k in overrides) if (Object.prototype.hasOwnProperty.call(overrides, k)) opts[k] = overrides[k];

    if (!opts.height) {
      say('Set a target height first (mm) - the stock is sized from the piece you mean to make', true);
      return { ok: false, reason: 'no target height' };
    }

    /* The machine the Plate card is pointed at, custom fields and all. Passed
       in rather than looked up inside nso_stock.js, which has no app state by
       design - see its header. */
    if (typeof NSO_fitCurrentPrinter === 'function') opts.printer = NSO_fitCurrentPrinter();

    var r;
    try {
      r = NSO_Stock.make(opts);
    } catch (e) {
      say('New stock failed - nothing added (' + ((e && e.message) || e) + ')', true);
      return { ok: false, reason: (e && e.message) || String(e) };
    }
    if (!r.ok) {
      say('New stock refused - nothing added: ' + r.reason, true);
      return r;
    }

    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(r.soup), 3));
    var name = 'stock_' + r.sizing.shape + '_' + Math.round(opts.height) + 'mm';
    var id = addModelFromZUpGeometry(name + '.stl', g);
    if (id == null) {
      say('New stock refused - the new piece looked empty', true);
      return { ok: false, reason: 'addModel refused' };
    }
    r.modelId = id;

    var s = r.sizing;
    var txt = 'Added ' + name + ' - ' + s.measure_text + ', ' +
      s.need_volume.toFixed(0) + ' mm^3 (' + s.shell_volume.toFixed(0) + ' mm^3 shell +' +
      Math.round(s.waste * 100) + '% waste)';
    if (opts.likeName) txt += ', matched to ' + opts.likeName;
    if (!s.encloses_target) {
      txt += ' - note: this block does NOT enclose the ' + s.height.toFixed(0) + ' x ' +
        (2 * s.radius).toFixed(0) + ' mm target, so it is material for it, not a block to carve it out of';
    }
    if (s.warnings && s.warnings.length) txt += ' - ' + s.warnings.join('; ');
    say(txt, false);
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    return r;
  }

  /* The proportions box means something different per shape, so its label and
     its placeholder follow the selector, and it goes away entirely for a
     sphere - which has one measurement and nothing to proportion. A field that
     says "x:y:z" while a cylinder is picked is a field that gets filled in
     wrong. Only that one label is hidden: the wall, the nozzle and the waste
     margin apply to all three shapes and stay put. */
  function syncShape() {
    var shape = (($('sel-stock-shape') || {}).value) || 'sphere';
    var lab = $('lab-stock-prop'), inp = $('inp-stock-prop'), row = $('row-stock-prop');
    if (!lab || !inp || !row) return;
    if (shape === 'box') {
      row.hidden = false;
      lab.textContent = 'x:y:z';
      inp.placeholder = 'e.g. 2:1:1';
      inp.title = 'Box proportions, any scale - the block is grown or shrunk until it holds the material the target needs. Blank means the target\'s own bounding box.';
    } else if (shape === 'cylinder') {
      row.hidden = false;
      lab.textContent = 'h/d';
      inp.placeholder = 'e.g. 2';
      inp.title = 'Cylinder height over diameter. Blank means the target\'s own height over its diameter.';
    } else {
      row.hidden = true;
      inp.value = '';
    }
    var match = $('chk-stock-match');
    if (match) {
      match.disabled = (shape === 'sphere');
      if (shape === 'sphere') match.checked = false;
    }
  }

  function bind(id, ev, fn) {
    var el = $(id);
    if (!el || el.dataset.nsoWired === '1') return;
    el.dataset.nsoWired = '1';
    el.addEventListener(ev, fn);
  }

  function wire() {
    bind('btn-stock-make', 'click', function () { run(null); });
    bind('sel-stock-shape', 'change', syncShape);
    syncShape();
  }

  window.nsoStockRun = run;
  window.nsoStockReadUI = readUI;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
