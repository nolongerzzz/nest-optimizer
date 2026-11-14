/*
 * G-scope Slice - the in-house slicer (nso_slicer.js), on demand, for any
 * piece G-scope has open: the plate as it stands, or an STL / 3MF.
 * ----------------------------------------------------------------------------
 *
 * READ docs/SLICER.md FIRST.
 *
 * THE ONE PATH. Slice writes G-code TEXT in the shape a real Bambu slice has,
 * reads it back with NSOGcodeLines.parseGcode - the parser every imported
 * .gcode.3mf goes through - and opens the result with
 * NSO_MICROSCOPE.openToolpathResult, the entry a .gcode.3mf import uses. So
 * the legend, Pick a line, Isolate, the layer slider, Clear from view, Crop and
 * both exports act on an in-house slice exactly as on an imported one: from
 * the parser down, nothing can tell them apart, and nothing here re-implements
 * any of it.
 *
 * NORMAL ○━━● SLICE. The card's switch (docs/GSCOPE.md item 12) is this
 * module's: Normal (#ms-cam-normal) is the mesh, Slice (#ms-cam-slice) the
 * toolpaths - a toggle between the mesh and its slice, not a camera. The side
 * it shows is the document's (NSO_MICROSCOPE.cardSide: a toolpath is the Slice
 * side), and the card shows that side's rows. Slice slices the open mesh at
 * once with whatever the Slice settings hold. The settings are a Slice-side
 * row, folded by default; their defaults are the plate's printer profile (0.4
 * mm nozzle, 0.2 mm layers on the A1 mini), set again at the start of every
 * visit, and kept across every Normal / Slice round trip inside one. The
 * Features list is then the slice's own, one row per feature the slice
 * printed, each a checkbox - and nothing else: no rows for overhangs or
 * conflicts, which are the Supports tool's to show (its own markers) and this
 * panel's report line's to state. Normal goes back to the mesh through
 * backToMesh(), which re-opens it - so the whole part comes back as G-scope
 * opens it: nothing selected, nothing isolated, nothing hidden. On a mesh,
 * Normal is the plain re-frame it always was (NSO_MICROSCOPE.normalView); a
 * sliced FILE has no mesh, so there Normal is off.
 *
 * THE PIECE STAYS EXPORTABLE. While a slice is shown, the Slice section keeps
 * Export piece to plate / Export piece as STL for the piece(s) it was made
 * from - no selection needed, nothing to go back for. They build the same
 * geometry, take the same name and make the same calls as G-scope's own
 * Export to plate / Export as STL do for a loaded piece.
 *
 * WHAT IT READS. The mesh document's own objects - Z-up millimetre soups,
 * already in the world frame for plate pieces (G-scope's plate route reads them
 * off the scene with meshToWorldSoup). All pieces are sliced together, in one
 * frame, dropped onto the plate together, so two pieces that overlap in a
 * layer are reported as a conflict, by layer number.
 *
 * PAINT SCOPE: NONE - Slice reads geometry and writes nothing. Export piece to
 * plate adds a copy of the piece as a new piece and edits none, as G-scope's
 * own Export to plate does. Paint has nothing to protect from either
 * (docs/HANDOFF.md, "Scoping"; the same category as Skin patch's).
 *
 * SUPPORTS ARE SLICED AS SUPPORT. A plate piece labelled m.nsoSupport (the
 * Supports card's, G-scope's own) goes to the slicer with role 'support' and
 * its host's id (hostSourceId); every piece goes with its own id (sourceId).
 * The slicer types the support's lines Support / Support transition / Support
 * interface from its geometry and credits the host with what the support's
 * top covers, so the readout says "needs support" only of what is left
 * uncovered and names the support that holds the rest; a support's own line
 * says what it holds, never its own sheet as an overhang. With no support on
 * the plate the slice is the one it always was.
 *
 * NON-SOLID SCOPE (docs/NON-SOLID.md): read through nsoNonSolid for plate
 * pieces, never inferred. A piece flagged non-solid is sliced with
 * gapCloseMm 0: its open section chains are left open and counted, not
 * chorded shut, because its open edges are the design. A file opened straight
 * into G-scope has no flag to read and is sliced as a solid.
 */
/* global state, setStatus, addModelFromZUpGeometry, pushUndo, geometryToBinarySTL,
          downloadBlob, THREE */
'use strict';

var NSO_GSCOPE_SLICE = (function () {
  var busy = false;
  var last = null;          // { source: {label, objects, opts}, result, name } of the last slice
  var pending = null;       // handed to the next document open

  function $(id) { return document.getElementById(id); }
  function MS() { return window.NSO_MICROSCOPE; }
  function SL() { return window.NSO_Slicer; }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }

  function num(id, dflt) {
    var el = $(id);
    var v = el ? parseFloat(el.value) : NaN;
    return isFinite(v) ? v : dflt;
  }

  // --- the plate's printer profile: the settings' defaults --------------------
  //
  // The plate's printer (app-core.js state.plate, the Plate select) gives a slice
  // its nozzle and layer height. The A1 mini is the owner's printer, and their own
  // Bambu slice says what it prints with: "Bambu Lab A1 mini 0.4 nozzle",
  // "0.20mm Standard @BBL A1M" (fixtures/supports/top_clip_x2_supports.gcode.3mf,
  // fixtures/README.md). Any other printer takes the app's nozzle
  // (nso_thickness.js NOZZLE_DEFAULT, 0.4) and half of it - the slicer's own
  // default (nso_slicer.js defaultsFor). Walls 2, 15 % grid and support below
  // 30 degrees are the same Bambu profile's, whatever the nozzle.
  var PRINTER_SLICE = { a1mini: { nozzle: 0.4, layer: 0.2 }, p1s: { nozzle: 0.4, layer: 0.2 } };
  var SLICE_REST = { walls: 2, density: 15, pattern: 'grid', surface: 'zigzag', angle: 30, brim: 'auto' };

  /* THE INTERFACE RULE (nso_slicer.js supportInterfaceRule; docs/SUPPORT-GATE.md): a preference, not a profile setting - kept in this
     browser, never reset by seedSettings, and read by the left bar's Slice card as well as by Slice (one choice: its interface row sets it
     through nsoSetSupportInterfaceRule). '' is the sheet typing, 'column' the rule. THE COLUMN RULE BY DEFAULT (the owner): a browser that
     holds no choice slices with it - the tree as the owner prints it; the sheet typing only when chosen ('' kept). */
  var IFACE_RULE_KEY = 'nso.supportInterfaceRule';
  var ifaceRuleMem = 'column';   /* the choice when the browser keeps nothing */
  function ifaceRule() {
    var v = ifaceRuleMem;
    try { var st = localStorage.getItem(IFACE_RULE_KEY); if (st != null) v = st; } catch (e) { /* storage off: the memory */ }
    return v === 'column' ? 'column' : null;
  }
  function showIfaceRule() { var el = $('ms-slice-iface-rule'); if (el) el.value = ifaceRule() || ''; }
  function setIfaceRule(v) {
    v = v === 'column' ? 'column' : '';
    ifaceRuleMem = v;
    try { localStorage.setItem(IFACE_RULE_KEY, v); } catch (er) { /* not kept past this page */ }
    showIfaceRule();
  }
  window.nsoSupportInterfaceRule = ifaceRule;
  window.nsoSetSupportInterfaceRule = setIfaceRule;
  if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('change', function (e) {
    if (!e.target || e.target.id !== 'ms-slice-iface-rule') return;
    setIfaceRule(e.target.value);
  });

  /** { printer, nozzle, layer } for the plate's printer, read as it is now. */
  function profileDefaults() {
    var id = (typeof state !== 'undefined' && state && state.plate) || null;
    var p = id && PRINTER_SLICE[id];
    var T = window.NSO_Thickness;
    var nz = p ? p.nozzle : ((T && T.NOZZLE_DEFAULT) || 0.4);
    return { printer: id, nozzle: nz, layer: p ? p.layer : Math.round(nz * 0.5 * 100) / 100 };
  }

  /** The settings back to the printer profile's (the start of every visit). */
  function seedSettings() {
    var d = profileDefaults();
    var set = function (id, v) { var el = $(id); if (el) el.value = String(v); };
    set('ms-slice-nozzle', d.nozzle);
    set('ms-slice-layer', d.layer);
    set('ms-slice-walls', SLICE_REST.walls);
    set('ms-slice-density', SLICE_REST.density);
    set('ms-slice-pattern', SLICE_REST.pattern);
    set('ms-slice-surface', SLICE_REST.surface);
    set('ms-slice-angle', SLICE_REST.angle);
    set('ms-slice-brim', SLICE_REST.brim);
    showIfaceRule();
    return d;
  }

  /** The Slice settings row, folded or open. */
  function setSettingsOpen(on) {
    var box = $('ms-slice-settings'), b = $('ms-slice-settings-toggle');
    if (box) box.hidden = !on;
    if (b) b.setAttribute('aria-expanded', String(!!on));
  }

  /** The slicer's options, from the panel. Widths are the repo's measured floor for the nozzle. */
  function panelOpts() {
    var nozzle = num('ms-slice-nozzle', profileDefaults().nozzle);
    var layer = num('ms-slice-layer', nozzle / 2);
    var over = {
      layerMm: layer, firstLayerMm: layer,
      wallLoops: Math.max(1, Math.round(num('ms-slice-walls', 2))),
      sparseDensity: Math.max(0, Math.min(1, num('ms-slice-density', 15) / 100)),
      supportThresholdDeg: num('ms-slice-angle', 30)
    };
    var pat = $('ms-slice-pattern');
    if (pat && pat.value) over.sparsePattern = pat.value;
    var surf = $('ms-slice-surface');
    if (surf && surf.value && surf.value !== 'zigzag') over.solidPattern = surf.value;   /* the surfaces and the solid infill: Bambu's three rows as one */   /* rings throughout: the surfaces and the solid infill too */
    var brim = $('ms-slice-brim');
    over.brimType = brim && brim.value ? brim.value : SLICE_REST.brim;
    var rule = ifaceRule();
    if (rule) over.supportInterfaceRule = rule;
    /* the raft (nso_slicer.js raftPlan): its own system under everything on the plate, Bambu's raft_layers / raft_contact_distance */
    over.raftLayers = Math.max(0, Math.round(num('ms-slice-raft', 0)));
    over.raftContactMm = Math.max(0, num('ms-slice-raft-gap', 0.1));
    /* the interface angle is the supports card's choice (Studio 2.9's 3.6 by default): G-scope's slice lays the stack as Generate's does */
    var ia = $('slice-set-iface-angle'); over.supportInterfaceAngle = ia && ia.value ? ia.value : 'studio36';
    return { nozzleMm: nozzle, over: over };
  }

  /** Is the plate piece behind a mesh-document object flagged non-solid? */
  function nonSolidOf(o) {
    if (o.placedIndex == null || typeof state === 'undefined' || !state || !state.placed) return false;
    var p = state.placed[o.placedIndex];
    var m = p && (state.models || []).find(function (x) { return x && x.id === p.sourceId; });
    return !!(m && typeof window.nsoNonSolid === 'function' && window.nsoNonSolid(m));
  }

  /** The support label (m.nsoSupport) of the plate piece behind a mesh-document object, or null. */
  function supportOf(o) {
    if (o.sourceId == null || typeof state === 'undefined' || !state || !state.models) return null;
    var m = state.models.find(function (x) { return x && x.id === o.sourceId; });
    return m && m.nsoSupport ? m.nsoSupport : null;
  }

  /** The plate piece (state.models entry) behind a mesh-document object, or null. */
  function modelOfObject(o) {
    if (o.sourceId == null || typeof state === 'undefined' || !state || !state.models) return null;
    return state.models.find(function (x) { return x && x.id === o.sourceId; }) || null;
  }

  function refuse(why) {
    var read = $('ms-slice-read');
    if (read) read.textContent = why;
    say(why, true);
    return Promise.resolve({ ok: false, reason: why });
  }

  /**
   * Slice what G-scope has open. Resolves with { ok, reason, result, doc }.
   * `optsOver` (for checks) overrides the panel.
   */
  function slice(optsOver) {
    if (busy) return Promise.resolve({ ok: false, reason: 'already slicing' });
    var d = MS() && MS().getDoc();
    if (!d) return refuse('Open something first: Import an STL / 3MF, or Read plate (IMPORT ▾).');
    if (d.kind !== 'mesh') return refuse('This is already a toolpath. Slice works on a mesh - the plate, an STL or a 3MF.');
    if (!SL()) return refuse('The slicer (nso_slicer.js) did not load - check console.');
    if (!window.NSOGcodeLines) return refuse('The toolpath reader did not load - check console.');

    var po = panelOpts();
    var opts = SL().defaultsFor(po.nozzleMm, Object.assign({}, po.over, optsOver || {}));
    /* the supports' own count of top interface layers (the card's 0 - 3) is the slicer's */
    var ni = -1;
    d.objects.forEach(function (o) { var su = supportOf(o); if (su && su.interfaceLayers != null && su.interfaceLayers > ni) ni = su.interfaceLayers; });
    if (ni >= 0 && !(optsOver && optsOver.supportInterfaceLayers != null)) opts.supportInterfaceLayers = ni;
    /* ...and a Dense sheet's thicker layers (Bambu's 0.275) mean the supports are cut on their own layer grid, as Bambu's independent support layer height does */
    var sl = 0;
    d.objects.forEach(function (o) { var su = supportOf(o); if (su && su.sheetLayerMm > sl) sl = su.sheetLayerMm; });
    if (sl > 0 && !(optsOver && optsOver.supportLayerMaxMm != null)) opts.supportLayerMaxMm = 0.28;
    var flagged = [];
    var objects = d.objects.map(function (o) {
      var ns = nonSolidOf(o);
      if (ns) flagged.push(o.name);
      var sup = supportOf(o);
      /* a support the supports card drew as it prints is sliced as the tree it was built as */
      var soup = sup && typeof window.nsoSupportSliceSoup === 'function' ? window.nsoSupportSliceSoup(modelOfObject(o), o.positions) : o.positions;
      return { name: o.name, soup: soup, gapCloseMm: ns ? 0 : undefined, key: o.sourceId,
               role: sup ? (sup.brim ? 'brim' : 'support') : 'part', hostKey: sup ? sup.hostSourceId : undefined };
    });
    var source = { label: d.name, objects: d.objects, docSource: d.source, subtitle: d.subtitle };
    busy = true;
    syncPanel();                          // the switch busy, the Slice report up for its progress
    var read = $('ms-slice-read');
    if (read) read.textContent = 'Slicing ' + objects.length + ' object(s)...';
    say('Slicing ' + d.name + '...');
    var t0 = Date.now();
    // one frame for the status line to paint before the work starts
    return new Promise(function (res) { setTimeout(res, 0); })
      .then(function () {
        return SL().run(objects, opts);
      })
      .then(function (r) {
        if (!r.ok) return refuse('Slice refused: ' + r.reason);
        var parsed = window.NSOGcodeLines.parseGcode(r.gcode);
        if (!parsed.moves.length) return refuse('The slice has no extrusion moves - nothing thick enough for one line.');
        var name = d.name + ' - NSO slice (' + opts.nozzleMm + ' mm nozzle, ' + opts.layerMm + ' mm layers)';
        pending = { source: source, result: r, name: name, flagged: flagged, ms: Date.now() - t0 };
        /* each support is an object of its own in the G-code (OBJECT_ID: the slice's object id): which head it holds,
           so Compare Pieces takes a head with its supports, as Bambu's slice labels them */
        var pieceHeads = new Map();
        (r.objects || []).forEach(function (o) {
          if (o.role === 'part' || o.hostKey == null) return;
          var h = r.objects.find(function (q) { return q.role === 'part' && q.key != null && q.key === o.hostKey; });
          if (h) pieceHeads.set(String(o.id), String(h.id));
        });
        var nd = MS().openToolpathResult(name, {
          plate: 1, part: 'NSO in-house slice', plates: [1], parsed: parsed, groups: null, warnings: parsed.warnings,
          pieceHeads: pieceHeads
        });
        if (!nd) { pending = null; return refuse('G-scope could not open the slice.'); }
        say('Sliced ' + d.name + ': ' + r.planes.length + ' layers, ' + parsed.moves.length + ' moves' +
            (r.conflicts.length ? ' - CONFLICT on ' + conflictLayers(r).length + ' layer(s)' : ''), !!r.conflicts.length);
        return { ok: true, reason: '', result: r, doc: nd, parsed: parsed };
      })
      .catch(function (err) {
        console.error(err);
        return refuse('Slice failed: ' + (err && err.message ? err.message : err));
      })
      .then(function (out) {
        busy = false;
        syncPanel();
        // a refusal's own words stay in the report (syncPanel writes the mesh's intro)
        if (out && !out.ok && out.reason) { var rd = $('ms-slice-read'); if (rd) rd.textContent = out.reason; }
        return out;
      });
  }

  function conflictLayers(r) {
    var s = {};
    r.conflicts.forEach(function (c) { s[c.layer] = 1; });
    return Object.keys(s).map(Number).sort(function (a, b) { return a - b; });
  }

  /** Re-open the mesh the current slice was made from. */
  function backToMesh() {
    var s = shownSource() || (last && last.source);
    if (!s) return null;
    if (s.docSource === 'plate' && MS().openPlate) return MS().openPlate();
    return MS().openObjects(s.label, s.objects, { source: s.docSource, subtitle: s.subtitle });
  }

  // --- the piece, exportable while its slice is shown ----------------------

  function baseName(n) {
    return String(n).replace(/\.gcode\.3mf$/i, '').replace(/\.(stl|3mf)$/i, '');
  }

  /** The source of the slice G-scope is showing now, or null. */
  function shownSource() {
    var d = MS() && MS().getDoc();
    return d && d.nsoSlice && d.nsoSlice.source ? d.nsoSlice.source : null;
  }

  /** The piece(s) as one Z-up geometry - the objects' own triangles, as G-scope exports a loaded piece. */
  function pieceGeometry(src) {
    var objs = src.objects.filter(function (o) { return o.positions && o.positions.length >= 9; });
    var total = objs.reduce(function (a, o) { return a + o.positions.length; }, 0);
    if (!total) return null;
    var positions = new Float32Array(total), at = 0;
    objs.forEach(function (o) { positions.set(o.positions, at); at += o.positions.length; });
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geo;
  }

  /** G-scope's own naming for an exported piece. */
  function pieceLabel(src) {
    var objs = src.objects;
    var what = objs.length === 1 ? objs[0].name
      : objs.length + ' ' + (src.docSource === 'plate' ? 'pieces' : 'objects');
    return src.docSource === 'plate' ? what : baseName(src.label) + ' - ' + what;
  }

  /** The piece onto the plate as its own object, with undo - G-scope's Export to plate. */
  function exportPieceToPlate() {
    var src = shownSource();
    if (!src) { say('No slice is shown, so there is no piece to export from here', true); return null; }
    var geo = pieceGeometry(src);
    if (!geo) { say('The piece has no triangles to export', true); return null; }
    var label = pieceLabel(src);
    var id = addModelFromZUpGeometry(label, geo);
    if (!id) { say('Export to plate failed - nothing was added', true); return null; }
    if (typeof pushUndo === 'function') {
      pushUndo({ type: 'addModels', ids: [id], editId: state.editId, cutT: state.cutT });
    }
    var tris = geo.attributes.position.count / 3;
    MS().close();
    say('Export to plate ok - "' + label + '" is its own object (' + tris + ' triangles)');
    return id;
  }

  /** The piece straight to an STL file - G-scope's Export as STL. */
  function exportPieceAsSTL() {
    var src = shownSource();
    if (!src) { say('No slice is shown, so there is no piece to export from here', true); return null; }
    var geo = pieceGeometry(src);
    if (!geo) { say('The piece has no triangles to export', true); return null; }
    var buffer = geometryToBinarySTL(geo);
    var name = pieceLabel(src).replace(/\s+/g, '_').replace(/[\/\\?%*:|"<>]/g, '') + '.stl';
    downloadBlob(new Blob([buffer], { type: 'application/octet-stream' }), name);
    say('Downloaded ' + name + ' (' + (geo.attributes.position.count / 3) + ' triangles)');
    return name;
  }

  // --- Normal / Slice view --------------------------------------------------

  /** Is G-scope showing one of our slices? */
  function showingSlice() {
    var d = MS() && MS().getDoc();
    return !!(d && d.nsoSlice);
  }

  /* ONE SLICE FOR THE PLATE (the owner: "It needs to be one slice"). The plate has one slice: the one Generate makes (or the Supports card's
     Slice section re-makes), NSO_Print.card's. Slice on the plate shows that slice - the file Generate wrote, as Preview opens it - and slices
     nothing of its own; with no slice of the plate as it stands, it runs that same card slice, which Preview and Export then share. Only a
     file opened straight into G-scope (an STL / 3MF, no plate) is sliced here. */
  function plateCard() { var P = window.NSO_Print && window.NSO_Print.card; return P && P.previewInGscope && P.slice && P.report && P.canSlice && P.canSlice() ? P : null; }
  function platesSlice() {
    var P = plateCard(), d = MS().getDoc(), t0 = Date.now();
    var source = { label: d.name, objects: d.objects, docSource: d.source, subtitle: d.subtitle };
    var flagged = d.objects.filter(function (o) { return nonSolidOf(o); }).map(function (o) { return o.name; });
    busy = true; syncPanel();
    var read = $('ms-slice-read');
    var made = P.fresh() ? Promise.resolve({ ok: true, already: true }) : (function () {
      if (read) read.textContent = 'Slicing the plate - its one slice (Generate\'s, made again for the plate as it stands)...';
      say('Slicing the plate...');
      return P.slice({ onStage: function (t) { if (read && busy) read.textContent = t; } });
    })();
    return made.then(function (r) {
      if (!r || !r.ok) { busy = false; syncPanel(); return refuse(r && r.reason ? r.reason : 'The plate did not slice.'); }
      var rep = P.report();
      if (!rep) { busy = false; syncPanel(); return refuse('The plate changed while it was slicing. Slice again.'); }
      var o = rep.options || {};
      pending = { source: source, result: rep, name: d.name + ' - NSO slice (' + o.nozzleMm + ' mm nozzle, ' + o.layerMm + ' mm layers)', flagged: flagged, ms: Date.now() - t0, plate: true };
      if (!P.previewInGscope({ asSlice: true })) { pending = null; busy = false; syncPanel(); return refuse('G-scope could not open the plate\'s slice.'); }
      return new Promise(function (res) {
        var n = 0, wait = function () {
          var nd = MS().getDoc();
          if (nd && nd.kind === 'toolpath' && nd.nsoSlice && nd.nsoSlice.result === rep) return res({ ok: true, reason: '', result: rep, doc: nd, plate: true, sliced: !r.already });
          if (++n > 600) return res(refuse('G-scope could not open the plate\'s slice.'));
          setTimeout(wait, 50);
        };
        wait();
      }).then(function (out) { busy = false; syncPanel(); return out; });
    }, function (err) {
      busy = false; syncPanel();
      return refuse('Slice failed: ' + (err && err.message ? err.message : err));
    });
  }

  /** Slice: the plate's one slice for the plate (above); an STL / 3MF opened here, sliced now. A toolpath is the Slice side already. */
  function sliceView() {
    var d = MS() && MS().getDoc();
    if (busy) return Promise.resolve({ ok: false, reason: 'already slicing' });
    if (showingSlice() || (d && d.kind === 'toolpath')) return Promise.resolve({ ok: true, reason: 'already in Slice view', doc: d });
    if (d && d.kind === 'mesh' && d.source === 'plate' && plateCard()) return platesSlice();
    return slice();
  }

  /** Normal: from a slice, back to its mesh (the plate's slice: the plate); on a mesh, the re-frame Normal always was. */
  function normalView() {
    if (busy) return null;
    if (showingSlice()) return backToMesh();
    var d = MS() && MS().getDoc();
    if (d && d.nsoPlateSlice && MS().openPlate) return MS().openPlate();
    return MS() ? MS().normalView() : null;
  }

  /** The switch's side: the card's (a toolpath - a slice made here, or a sliced file - is 'slice'). */
  function viewMode() {
    var M = MS();
    if (M && M.cardSide) return M.cardSide();
    return showingSlice() ? 'slice' : 'normal';
  }

  /** Off without dropping the keyboard: G-scope's own setDisabled (Escape stays the panel's). */
  function off(el, yes) {
    var M = MS();
    if (!el) return;
    if (M && M.setDisabled) M.setDisabled(el, yes); else el.disabled = !!yes;
  }

  function syncToggle() {
    var d = MS() && MS().getDoc();
    var on = viewMode() === 'slice';
    var n = $('ms-cam-normal'), c = $('ms-cam-slice'), sw = $('ms-camera-row');
    if (n) {
      n.classList.toggle('active', !on);
      n.setAttribute('aria-pressed', String(!on));
      // From a slice made here, Normal is its mesh, and from the plate's slice the plate; a sliced file has no mesh to go back to.
      off(n, busy || (on && !(d && (d.nsoSlice || d.nsoPlateSlice))));
    }
    if (c) {
      c.classList.toggle('active', on);
      c.setAttribute('aria-pressed', String(on));
      c.setAttribute('aria-busy', String(busy));
      // A mesh can be sliced; a toolpath is the Slice side already (a click there changes nothing).
      off(c, busy || !d);
    }
    if (sw) sw.classList.toggle('is-busy', busy);
  }

  /** "support 1.1" out of "<host> - support 1.1 (Tree)": the card's name, less the host and the style. */
  function supportLabel(name, hostName) {
    var n = String(name);
    if (hostName && n.indexOf(hostName + ' - ') === 0) n = n.slice(hostName.length + 3);
    return n.replace(/\s*\([^)]*\)$/, '');
  }

  /**
   * What the slice says about each piece's overhangs. With no support in the
   * slice a region reads "z 12.00 (61.2 mm² on plate)", as it always did.
   * With supports, a region they hold is credited: only what is left
   * uncovered needs support, and the covering support is named.
   */
  function overhangWords(ob) {
    var need = [], held = [], by = {}, total = 0;
    ob.overhang.forEach(function (g) {
      var z = 'z ' + g.firstZ.toFixed(2);
      var plain = z + ' (' + g.footprintMm2.toFixed(1) + ' mm² on ' + g.standsOn + ')';
      if (g.coveredMm2 == null || !g.coveredBy.length) { need.push(plain); return; }
      var names = g.coveredBy.map(function (c) { by[c.id] = 1; return supportLabel(c.name, ob.name); }).join(' + ');
      total += g.coveredMm2;
      if (g.uncoveredMm2 > 0) {
        need.push(z + ': ' + g.footprintMm2.toFixed(1) + ' mm² overhang, ' + g.coveredMm2.toFixed(1) + ' covered by ' + names +
          ', ' + g.uncoveredMm2.toFixed(1) + ' uncovered');
      } else held.push(z + ' (' + g.coveredMm2.toFixed(1) + ' mm², ' + names + ')');
    });
    var n = Object.keys(by).length;
    if (!need.length) {
      return held.length ? 'no support needed (' + n + ' support' + (n === 1 ? ' covers ' : 's cover ') + total.toFixed(1) + ' mm²)'
        : 'no support needed';
    }
    return 'needs support at ' + need.join(', ') + (held.length ? '; held by support at ' + held.join(', ') : '');
  }

  /** A support object's own line: what it holds, never its own sheet as an overhang (that is held by design). */
  function supportWords(sp) {
    var who = sp.hostName ? 'support for ' + sp.hostName : 'support (its piece is not in this slice)';
    if (!sp.sheets.length) return who + ': no sheet under ' + (sp.hostName ? 'it' : 'a piece');
    return who + ': ' + sp.tips + ' tip' + (sp.tips === 1 ? '' : 's') + ', sheet at z ' + sp.zLo.toFixed(2) + '–' + sp.zHi.toFixed(2);
  }

  function report(r, flagged) {
    var lines = [];
    var o = r.options;
    lines.push((r.fileLayers || r.planes.length) + ' layers at ' + o.layerMm + ' mm, walls ' + o.outerWallWidthMm + ' mm x ' + o.wallLoops +
      ', ' + Math.round(o.sparseDensity * 100) + ' % ' + ({ zigzag: 'rectilinear', archimedeanchords: 'archimedean chords', '3dhoneycomb': '3D honeycomb', adaptivecubic: 'adaptive cubic' }[o.sparsePattern] || o.sparsePattern) + ', support below ' + o.supportThresholdDeg + '° (' + r.ms + ' ms).');
    r.objects.forEach(function (ob) {
      if (ob.role === 'raft') { lines.push('Raft: ' + r.raft.layers + ' layer' + (r.raft.layers === 1 ? '' : 's') + ' (' + r.raft.base + ' base, ' + r.raft.interface + ' interface), top at ' + r.raft.topMm.toFixed(2) + ' mm; the plate stands on it at ' + r.raft.liftMm.toFixed(2) + ' mm.'); return; }
      var wc = Object.keys(ob.wallCountHistogram).map(function (k) { return k + '×' + ob.wallCountHistogram[k]; }).join(' ');
      lines.push(ob.name + ': ' + (ob.role === 'support' ? supportWords(ob.support) : 'walls per layer ' + wc + '; ' + overhangWords(ob)) +
        (ob.sectionStats.openChains ? '; ' + ob.sectionStats.openChains + ' open section chain(s)' +
          (ob.nonSolid ? ' left open (non-solid)' : ', ' + ob.sectionStats.closedByGap + ' closed, ' + ob.sectionStats.droppedChains + ' dropped') : '') +
        (ob.flipped ? '; mesh wound inside out' : '') + '.');
    });
    if (r.conflicts.length) lines.push('CONFLICT: pieces print into each other on layer ' + conflictLayers(r).join(', ') + '.');
    if (flagged && flagged.length) lines.push('Non-solid (open by design): ' + flagged.join(', ') + '.');
    return lines.join(' ');
  }

  function syncPanel() {
    var d = MS() && MS().getDoc();
    var ours = !!(d && d.nsoSlice);
    syncToggle();
    var exp = $('ms-slice-export-row');
    if (exp) exp.style.display = ours ? 'flex' : 'none';
    // The Slice report is a readout, in the dock: up while a mesh (what Slice would
    // slice) or a slice made here is open, and while a slice is being made.
    var rd = $('ms-slice-readout');
    if (rd) rd.style.display = busy || (d && (d.kind === 'mesh' || ours)) ? '' : 'none';
    var note = $('ms-slice-settings-note');
    var plate = !!(d && ((d.kind === 'mesh' && d.source === 'plate' && plateCard()) || d.nsoPlateSlice));
    if (note) note.textContent = plate
      ? 'The plate has one slice: Generate\'s. Its settings are the Supports card\'s (its Slice section); these are for an STL / 3MF opened here.'
      : d && d.kind === 'toolpath' && !ours
      ? 'This file is sliced already: the settings are for a slice made here, from a mesh.'
      : 'From the plate\'s printer profile. They take effect on the next slice: Normal, then Slice again.';
    var read = $('ms-slice-read');
    if (!read || busy) return;
    if (ours) read.textContent = report(d.nsoSlice.result, d.nsoSlice.flagged);
    else if (d && d.kind === 'mesh' && plate) read.textContent = 'Slice (the switch) shows the plate\'s slice - the one Generate made, as Preview opens it; ' +
      'with none for the plate as it stands, it makes that slice (the Supports card\'s settings).';
    else if (d && d.kind === 'mesh') read.textContent = 'Slice (the switch) slices every object into real layers, walls and infill with the in-house slicer and lists its features.';
  }

  function bind(id, ev, fn) {
    var el = $(id);
    if (el && el.dataset.wired !== '1') { el.dataset.wired = '1'; el.addEventListener(ev, fn); }
  }

  var visit = false;          // the settings were seeded for this visit

  function mount() {
    if (!MS()) return;
    MS().onDocument(function (d) {
      if (pending && d && d.kind === 'toolpath') { d.nsoSlice = pending; last = pending; }
      pending = null;
      var open = MS().isOpen && MS().isOpen();
      // A visit's first document takes the printer profile as it is then; CLOSE
      // (the panel shut, nothing open) ends the visit and folds the row.
      if (d && open && !visit) { visit = true; seedSettings(); }
      if (!d && !open) { visit = false; setSettingsOpen(false); }
      syncPanel();
    });
    bind('ms-cam-slice', 'click', function () { sliceView(); });
    bind('ms-cam-normal', 'click', function () { normalView(); });
    // the track between them flips to the other side, as its button would
    var track = document.querySelector('#ms-camera-row .ms-switch-track');
    if (track && track.dataset.wired !== '1') {
      track.dataset.wired = '1';
      track.addEventListener('click', function () {
        var other = $(viewMode() === 'slice' ? 'ms-cam-normal' : 'ms-cam-slice');
        if (other && !other.disabled) other.click();
      });
    }
    bind('ms-slice-settings-toggle', 'click', function () {
      var box = $('ms-slice-settings');
      var opening = !!(box && box.hidden), M = window.NSO_MICROSCOPE;
      if (opening && M && M.pushStep) M.pushStep(function () { var b = $('ms-slice-settings'); if (!b || b.hidden) return false; setSettingsOpen(false); return true; });
      setSettingsOpen(opening);
    });
    bind('ms-btn-slice-export-plate', 'click', exportPieceToPlate);
    bind('ms-btn-slice-export-stl', 'click', exportPieceAsSTL);
    bind('ms-slice-nozzle', 'change', function () {
      var n = num('ms-slice-nozzle', profileDefaults().nozzle), lay = $('ms-slice-layer');
      if (lay) lay.value = String(Math.round(n * 0.5 * 100) / 100);
    });
    seedSettings();
    syncPanel();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
  }

  return {
    slice: slice,
    sliceView: sliceView,
    normalView: normalView,
    viewMode: viewMode,
    syncToggle: syncToggle,
    syncPanel: syncPanel,
    /** The plate's printer profile's settings: { printer, nozzle, layer }. */
    profileDefaults: profileDefaults,
    seedSettings: seedSettings,
    setSettingsOpen: setSettingsOpen,
    backToMesh: backToMesh,
    exportPieceToPlate: exportPieceToPlate,
    exportPieceAsSTL: exportPieceAsSTL,
    last: function () { return last; },
    busy: function () { return busy; },
    panelOpts: panelOpts,
    /** The readout's words for a slice result (what #ms-slice-read shows). */
    report: report
  };
})();

if (typeof window !== 'undefined') window.NSO_GSCOPE_SLICE = NSO_GSCOPE_SLICE;
