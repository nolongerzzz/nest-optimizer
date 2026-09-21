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

   PAINT SCOPE, THE CREATE PATH: NONE - the New stock button reads no existing
   geometry unless you ask it to match a piece's proportions, and even then it
   reads that piece's bounding box and nothing else, writing to no face of it.
   No face of any piece is touched, which is a stronger statement than "paint
   is respected". See docs/HANDOFF.md, "Scoping" - `none` is a category there.
   The UPDATE path, added with live editing below, is a different answer to
   the same question and is WHOLE-PIECE; both rows are in the HANDOFF roster,
   and the update path's is the one tools/nso_paint_scope_test.js asserts,
   because a row in that roster needs a paint test to point at.

   The new piece arrives through addModelFromZUpGeometry (app-core.js), the
   one ingest path an imported STL takes, so the block has rawTris exactly as
   a loaded file does and every later tool - Carve, Hollow, Cut, Seat, Skin,
   auto-aim support, both exporters - sees an ordinary piece.

   THE SHAPE LIST IS nso_stock.js's, NOT THIS FILE'S. The <option> values in
   index.html are NSO_Stock.SHAPES spelled out, and what each shape's one
   free-text box means lives in the PROP table below - one row per shape,
   read by the parse, by the label and by the Match checkbox alike. Adding a
   shape is a closed form and a meridian in the module, a row here and an
   <option> there; nothing in this file solves for anything.

   ---------------------------------------------------------------------------
   LIVE EDITING - the card adjusts the piece it made, it does not make another
   ---------------------------------------------------------------------------
   New stock ADDS. That is right the first time and wrong every time after:
   before this, seeing a 50% margin instead of 30% meant pressing New stock
   again, which left a second block on the plate and left your positioning,
   your pose and your selection on the first one. Measured before the change:
   two presses, two pieces, two meshes, and the second one placed 31.96 mm to
   the side of the first.

   So the button opens a SESSION on the piece it made, and every control on
   the card then edits THAT piece in place. This is the Pottery Wheel's
   pattern, deliberately and not by coincidence:

     the wheel      NSO_wheelSession holds the profile; each move derives a
                    new profile from it and bakes the revolve onto the SAME
                    model through NSO_sculptCommitRaw.
     here           `session` holds the model id and a fingerprint of the soup
                    this file last wrote; each control change re-sizes from the
                    card and bakes onto the SAME model through the same call.

   What survives an adjustment, because NSO_sculptCommitRaw is what every bake
   in this app already goes through: the model id, the model's place in the
   list, the placed entry and its index, its x / z on the plate, its pose
   fields, and the selection. What does not: the THREE.Mesh instance, which
   that function disposes and rebuilds from the new geometry - for Stock
   exactly as for Smooth, Extend, Fatten, Hollow and the wheel. "Same object"
   here means the same PIECE, not the same Mesh; changing that is a change to
   every bake in the app and is not this ticket.

   THE SESSION CLOSES RATHER THAN OVERWRITING SOMEBODY ELSE'S WORK. It is not
   enough to remember which piece was made: a person who makes a block, hollows
   it, and then nudges the waste margin must not lose the hollow. So the
   fingerprint of what this file last wrote is checked before every update, and
   a piece that no longer matches it has been baked by another tool - the
   session ends, says so once, and the card goes back to making new blocks.

   PAINT SCOPE: WHOLE-PIECE, for the UPDATE path only. Per the scoping rule in
   docs/HANDOFF.md: an update re-generates the whole block from the card, so
   there is no face it can promise to leave alone and no sub-region to scope a
   check to - the same reading Smooth, Thicken, Fatten and Fusion have. Any
   paint anywhere stands the update down, naming the count, and the session
   ends rather than leaving the card silently inert. The CREATE path is still
   `none`: it reads no existing geometry except a reference piece's bounding
   box when Match is ticked, and writes to no face of anything.

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

  /* ------------------------------------------------ the shape-specific box

     ONE field, not one per shape, because all but one of them would be blank
     at any moment. What it means follows the selector, and this table is the
     only place that mapping is written down - the parse below, the label and
     the placeholder in syncShape(), and the Match checkbox's own answer all
     read it rather than each carrying a switch of their own.

     A box is the exception and keeps its own branch: three numbers rather than
     one or two, and they are proportions rather than ratios.

       first / second   the nso_stock.js option each number fills
       zeroOk           whether the SECOND number may be 0. A cone's taper of
                        0 is a true point and is the default; a tube with no
                        wall is not a tube.
       ref              whether "Match selected piece" means anything here. A
                        sphere has one measurement and a torus's tube ratio is
                        not something a bounding box can say, so both refuse a
                        reference by name in nso_stock.js and the checkbox is
                        disabled rather than left to fail on the press. */
  var PROP = {
    cylinder:  { first: 'ratio', label: 'h/d', ph: 'e.g. 2', ref: true,
                 hint: 'Cylinder height over diameter. Blank means the target\'s own height over its diameter.' },
    cone:      { first: 'ratio', second: 'taper', zeroOk: true, label: 'h/d[:taper]', ph: 'e.g. 2 or 2:0.4', ref: true,
                 hint: 'Cone height over base diameter, optionally followed by a taper - the top radius over the base radius, 0 for a true point and under 1 always. Blank means the target\'s own height over its diameter, to a point.' },
    tube:      { first: 'ratio', second: 'tubeWall', label: 'h/d[:wall]', ph: 'e.g. 2 or 2:0.25', ref: true,
                 hint: 'Tube height over outer diameter, optionally followed by the wall as a fraction of the outer radius (default 0.25). Blank means the target\'s own height over its diameter.' },
    torus:     { first: 'tubeRatio', label: 'tube/ring', ph: 'e.g. 0.35', ref: false,
                 hint: 'Torus tube radius over ring radius, strictly between 0 and 1 - at 1 the hole closes up. Blank means 0.35. A torus is never as tall as it is wide, so there is no height-over-diameter to read off the target.' },
    capsule:   { first: 'ratio', label: 'h/d', ph: 'e.g. 2', ref: true,
                 hint: 'Capsule total height over diameter, more than 1 - at exactly 1 it is a sphere. Blank means the target\'s own height over its diameter when the target is taller than it is wide, and 2 when it is not.' },
    ellipsoid: { first: 'ratio', label: 'h/d', ph: 'e.g. 1.5', ref: true,
                 hint: 'Ellipsoid height over diameter. 1 is a sphere, under 1 is squashed, over 1 is stretched. Blank means the target\'s own height over its diameter.' },
    box:       { label: 'x:y:z', ph: 'e.g. 2:1:1', ref: true,
                 hint: 'Box proportions, any scale - the block is grown or shrunk until it holds the material the target needs. Blank means the target\'s own bounding box.' }
  };

  function proportionsOf(shape) {
    var spec = PROP[shape];
    var raw = ($('inp-stock-prop') || {}).value;
    if (!raw || !String(raw).trim()) return {};
    var txt = String(raw).trim();
    if (!spec) return {};                       // sphere: the box is hidden
    if (shape === 'box') {
      var parts = txt.split(/[:x,\s]+/).filter(function (s) { return s.length; }).map(parseFloat);
      if (parts.length !== 3 || !parts.every(function (n) { return isFinite(n) && n > 0; })) {
        return { error: 'the box proportions box wants three positive numbers, e.g. 2:1:1' };
      }
      return { proportions: { x: parts[0], y: parts[1], z: parts[2] } };
    }
    /* One or two plain numbers, "a" or "a:b", for every other shape. */
    var nums = txt.split(/[:x,\s]+/).filter(function (s) { return s.length; }).map(parseFloat);
    var max = spec.second ? 2 : 1;
    if (!nums.length || nums.length > max || !nums.every(function (n) { return isFinite(n); })) {
      return { error: 'the ' + shape + ' box wants ' + (spec.second ? 'one or two numbers' : 'one number') +
        ' - ' + spec.label + ', e.g. ' + spec.ph.replace(/^e\.g\. /, '') };
    }
    if (!(nums[0] > 0)) {
      return { error: 'the first number in the ' + shape + ' box (' + spec.label +
        ') has to be positive - got ' + nums[0] };
    }
    var out = {};
    out[spec.first] = nums[0];
    if (nums.length > 1) {
      if (!(nums[1] > 0 || (spec.zeroOk && nums[1] === 0))) {
        return { error: 'the second number in the ' + shape + ' box (' + spec.label + ') has to be ' +
          (spec.zeroOk ? 'zero or more' : 'positive') + ' - got ' + nums[1] };
      }
      out[spec.second] = nums[1];
    }
    return out;
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

    /* Whatever the shape box parsed, verbatim. Copied as a whole rather than
       field by field: a per-field list here is a list that has to be extended
       every time a shape gains an option, and the way it fails is silent -
       the field parses, nothing complains, and the module quietly uses its
       default instead. PROP already says which options exist; this does not
       need a second opinion. */
    var p = proportionsOf(shape);
    if (p.error) return { error: p.error };
    for (var pk in p) if (Object.prototype.hasOwnProperty.call(p, pk)) o[pk] = p[pk];

    var match = $('chk-stock-match');
    if (match && match.checked) {
      if (!(PROP[shape] && PROP[shape].ref)) {
        return { error: shape === 'sphere'
          ? 'A sphere has one measurement, so there are no proportions to match - pick another shape, or untick Match'
          : 'A torus is measured by its tube radius over its ring radius, which a reference piece\'s bounding box cannot say - give the tube ratio directly, or untick Match' };
      }
      var ref = referenceSoup();
      if (ref.error) return { error: ref.error };
      o.like = ref.soup;
      o.likeName = ref.name;
    }

    var over = $('chk-stock-oversize');
    if (over && over.checked) o.warnOnly = true;
    return { opts: o };
  }

  /* ------------------------------------------------------------- session

     { modelId, tris, sum } - which piece the card is editing, and a
     fingerprint of the soup this file last wrote to it. The fingerprint is a
     triangle count and a coordinate sum: cheap, and it does not have to be
     cryptographic. It only has to notice the difference between "nobody has
     touched this" and "Hollow / Fatten / Attach / Smooth has been over it",
     and every one of those changes both numbers. */
  var session = null;

  function fingerprint(soup) {
    var sum = 0;
    for (var i = 0; i < soup.length; i++) sum += soup[i];
    return { tris: (soup.length / 9) | 0, sum: sum };
  }
  function sessionModel() {
    if (!session) return null;
    var m = (state && state.models) ? state.models.find(function (x) { return x && x.id === session.modelId; }) : null;
    return m || null;
  }
  function endSession(why) {
    if (!session) return;
    session = null;
    if (why) say(why, false);
  }
  /* Exposed so a drive check can read the session rather than infer it. */
  function sessionInfo() {
    return session ? { modelId: session.modelId, tris: session.tris } : null;
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

    /* OPEN THE SESSION, and select the piece through the app's one selection
       path. Both are needed for the card to edit what it just made: a session
       with nothing selected would be edited from a card the user is not
       looking at, and an editId written behind selectPlaced's back would leave
       the red outline on whatever was selected before - the split that
       docs/INTEGRATION.md finding 3 was about in Clone. */
    session = { modelId: id };
    var madeModel = state.models.find(function (x) { return x && x.id === id; });
    if (madeModel && madeModel.rawTris) {
      var fp0 = fingerprint(madeModel.rawTris);
      session.tris = fp0.tris; session.sum = fp0.sum;
    }
    var placedIdx = (state.placed || []).findIndex(function (p) { return p && p.sourceId === id; });
    if (placedIdx >= 0 && typeof selectPlaced === 'function') selectPlaced(placedIdx);

    say(txt, false);
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    return r;
  }

  /* --------------------------------------------------------------- update

     One control moved. Re-size from the card and bake onto the piece the
     session is holding - same model, same place on the plate, same pose, same
     selection.

     Every way out of this that is not a successful bake leaves the piece
     exactly as it was; the refusals below are in the order the answers become
     knowable, so nothing is generated before it is known that it may be. */
  function update(reason) {
    if (!session) return { ok: false, reason: 'no live piece' };
    var m = sessionModel();
    if (!m) { session = null; return { ok: false, reason: 'the piece is gone' }; }

    /* The card edits the piece it is pointed at, and nothing else. Selecting
       another piece is how a person says "I have moved on", and the Match
       checkbox in particular is about the SELECTION, so an update that fired
       while another piece was selected would resize the wrong block. */
    var active = (typeof getActiveModel === 'function') ? getActiveModel() : null;
    if (!active || active.id !== session.modelId) { session = null; return { ok: false, reason: 'another piece is selected' }; }

    /* Somebody else has been over it - Hollow, Fatten, Attach, Smooth, a Cut.
       Their work wins; the card stops editing and says so once. */
    if (!(m.rawTris && m.rawTris.length)) {
      endSession('Stock: "' + m.name + '" no longer has a raw soup, so the card has stopped editing it - press New stock for a new block');
      return { ok: false, reason: 'no rawTris' };
    }
    var fp = fingerprint(m.rawTris);
    if (session.tris != null && (fp.tris !== session.tris || fp.sum !== session.sum)) {
      endSession('Stock: "' + m.name + '" has been changed by another tool, so the card has stopped editing it - your work is kept. Press New stock for a new block.');
      return { ok: false, reason: 'piece changed elsewhere' };
    }

    /* PAINT SCOPE: WHOLE-PIECE - see the header. An update re-generates the
       whole block, so there is no face it can hold still. */
    var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
    if (painted > 0) {
      endSession('Stock stood down - ' + painted + ' painted face(s); an adjustment re-generates the whole block and cannot hold a face still. The card has stopped editing "' + m.name + '".');
      return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
    }

    var read = readUI();
    if (read.error) { say(read.error, true); return { ok: false, reason: read.error }; }
    var opts = read.opts;
    if (!opts.height) { say('Set a target height first (mm) - "' + m.name + '" is unchanged', true); return { ok: false, reason: 'no target height' }; }
    /* The same build-volume gate New stock applies, against the machine the
       Plate card is pointed at, before any geometry is built. */
    if (typeof NSO_fitCurrentPrinter === 'function') opts.printer = NSO_fitCurrentPrinter();

    var r;
    try { r = NSO_Stock.make(opts); }
    catch (e) { say('Stock update failed - "' + m.name + '" unchanged (' + ((e && e.message) || e) + ')', true); return { ok: false, reason: (e && e.message) || String(e) }; }
    if (!r.ok) { say('Stock update refused - "' + m.name + '" unchanged: ' + r.reason, true); return r; }

    var s = r.sizing;
    var txt = 'Stock updated in place - ' + s.measure_text + ', ' +
      s.need_volume.toFixed(0) + ' mm^3 (' + s.shell_volume.toFixed(0) + ' mm^3 shell +' +
      Math.round(s.waste * 100) + '% waste)';
    if (opts.likeName) txt += ', matched to ' + opts.likeName;
    if (s.warnings && s.warnings.length) txt += ' - ' + s.warnings.join('; ');

    if (typeof NSO_sculptCommitRaw !== 'function') { say('Stock update needs app-sculpt.js to commit', true); return { ok: false, reason: 'no commit path' }; }

    /* ONE UNDO ENTRY PER SESSION, not one per keystroke.

       NSO_sculptCommitRaw pushes an undo entry every time, which is right for
       a bake somebody pressed a button for and wrong for a number field being
       nudged: a dozen adjustments would bury everything else on the stack. So
       the FIRST adjustment of a session keeps its entry - the one that takes
       the piece back to the block as it was made - and every later one drops
       the entry it just pushed. "Undo" then means "put the block back the way
       it was before I started adjusting", which is the only thing a person
       could want from it here.

       Done locally rather than by teaching NSO_sculptCommitRaw a mode,
       because this is the first tool in the app that edits on a field change
       and one caller is not yet a pattern. The wheel's live drag has the same
       problem and does push per frame; if a second tool wants this, it moves
       into pushUndo as a coalesce flag and both take it. */
    var depth = (state.undoStack || []).length;
    var ok = NSO_sculptCommitRaw(m, r.soup, 'stockReplace', txt);
    if (!ok) { say('Stock update refused - "' + m.name + '" unchanged: the commit was rejected', true); return { ok: false, reason: 'commit rejected' }; }
    if (session.undoPushed && state.undoStack.length === depth + 1) state.undoStack.pop();
    else session.undoPushed = true;
    if (typeof updateUndoBtn === 'function') updateUndoBtn();

    var fp2 = fingerprint(m.rawTris);
    session.tris = fp2.tris; session.sum = fp2.sum;
    if (typeof updateAdjustUI === 'function') updateAdjustUI();
    r.modelId = m.id;
    r.updated = true;
    r.why = reason || '';
    return r;
  }

  /* The proportions box means something different per shape, so its label, its
     placeholder and its tooltip follow the selector, and it goes away entirely
     for a sphere - which has one measurement and nothing to proportion. A
     field that says "x:y:z" while a cylinder is picked is a field that gets
     filled in wrong. Only that one label changes: the wall, the nozzle and the
     waste margin apply to every shape and stay put.

     All of it comes off PROP, so adding a shape is a row in that table and an
     <option> in index.html. The one thing NOT in the table is which shapes
     hide the row: that is "has no second measurement at all", which is the
     sphere alone and is the absence of a PROP entry. */
  function syncShape() {
    var shape = (($('sel-stock-shape') || {}).value) || 'sphere';
    var lab = $('lab-stock-prop'), inp = $('inp-stock-prop'), row = $('row-stock-prop');
    if (!lab || !inp || !row) return;
    var spec = PROP[shape];
    if (spec) {
      row.hidden = false;
      lab.textContent = spec.label;
      inp.placeholder = spec.ph;
      inp.title = spec.hint;
    } else {
      row.hidden = true;
      inp.value = '';
    }
    /* Match is about reading a height over a diameter off a piece's bounding
       box, so it is offered exactly where that means something. Cleared as
       well as disabled, so switching to a sphere or a torus cannot leave a
       ticked box that the next press would refuse on. */
    var match = $('chk-stock-match');
    if (match) {
      match.disabled = !(spec && spec.ref);
      if (match.disabled) match.checked = false;
    }
  }

  function bind(id, ev, fn) {
    var el = $(id);
    if (!el || el.dataset.nsoWired === '1') return;
    el.dataset.nsoWired = '1';
    el.addEventListener(ev, fn);
  }

  /* Every control on the card, and the one reason they are listed rather than
     queried: this file must not start editing a piece because some OTHER
     card's field moved. A querySelector over the menu would pick up whatever
     lands in it next. */
  var LIVE_FIELDS = ['sel-stock-shape', 'inp-stock-height', 'inp-stock-radius',
    'inp-stock-wall', 'inp-stock-nozzle', 'inp-stock-waste', 'inp-stock-prop',
    'chk-stock-match', 'chk-stock-oversize'];

  /* A number field fires `input` on every keystroke, and typing 4-5 in an
     empty box goes through "4" on the way. Waiting for the typing to settle
     means the piece is re-generated once per value the person meant, not once
     per digit - and a 96-segment sphere is 18k triangles, so the difference
     is visible. `change` fires on blur and on a spinner click and is already
     the settled value, so it goes straight through.

     Deliberately NOT the wheel's per-frame cadence: a drag has no keystrokes
     to wait for, and a number box is not a drag. */
  var QUIET_MS = 160;
  var timer = null;
  function later(reason) {
    if (!session) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; live(reason); }, QUIET_MS);
  }
  function live(reason) {
    if (!session) return;
    try { update(reason); }
    catch (err) {
      if (typeof console !== 'undefined') console.error('[stock]', err);
      say('Stock update failed - the piece is unchanged (' + ((err && err.message) || err) + ')', true);
    }
  }

  function wire() {
    bind('btn-stock-make', 'click', function () { run(null); });
    bind('sel-stock-shape', 'change', syncShape);
    for (var i = 0; i < LIVE_FIELDS.length; i++) {
      (function (id) {
        var el = $(id);
        if (!el || el.dataset.nsoStockLive === '1') return;
        el.dataset.nsoStockLive = '1';
        el.addEventListener('change', function () { if (timer) { clearTimeout(timer); timer = null; } live(id); });
        if (el.tagName === 'INPUT' && el.type === 'number') {
          el.addEventListener('input', function () { later(id); });
        }
      })(LIVE_FIELDS[i]);
    }
    syncShape();
  }

  window.nsoStockRun = run;
  window.nsoStockUpdate = update;
  window.nsoStockSession = sessionInfo;
  window.nsoStockEndSession = function () { endSession(''); };
  window.nsoStockReadUI = readUI;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();
