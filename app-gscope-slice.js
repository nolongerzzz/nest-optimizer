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
 * NORMAL / SLICE VIEW. The View row's two buttons are this module's: one
 * toggle between the mesh and its slice, not a camera. Slice view
 * (#ms-cam-slice) slices the open mesh at once with whatever the Slice
 * settings hold - collapsed out of the way by default, their values kept
 * across every round trip because nothing resets them - and turns the
 * floating legend to its Detected features tab: walls, infill, top / bottom
 * and every overhang call, each a click to isolate. Normal (#ms-cam-normal)
 * goes back to the mesh through backToMesh(), which re-opens it - so the
 * whole part comes back as G-scope opens it: nothing selected, nothing
 * isolated, nothing hidden. On a mesh, Normal is the plain re-frame it always
 * was (NSO_MICROSCOPE.normalView).
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

  /** The slicer's options, from the panel. Widths are the repo's measured floor for the nozzle. */
  function panelOpts() {
    var nozzle = num('ms-slice-nozzle', 0.6);
    var layer = num('ms-slice-layer', nozzle / 2);
    var over = {
      layerMm: layer, firstLayerMm: layer,
      wallLoops: Math.max(1, Math.round(num('ms-slice-walls', 2))),
      sparseDensity: Math.max(0, Math.min(1, num('ms-slice-density', 15) / 100)),
      supportThresholdDeg: num('ms-slice-angle', 30)
    };
    var pat = $('ms-slice-pattern');
    if (pat && pat.value) over.sparsePattern = pat.value;
    return { nozzleMm: nozzle, over: over };
  }

  /** Is the plate piece behind a mesh-document object flagged non-solid? */
  function nonSolidOf(o) {
    if (o.placedIndex == null || typeof state === 'undefined' || !state || !state.placed) return false;
    var p = state.placed[o.placedIndex];
    var m = p && (state.models || []).find(function (x) { return x && x.id === p.sourceId; });
    return !!(m && typeof window.nsoNonSolid === 'function' && window.nsoNonSolid(m));
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
    if (!d) return refuse('Open something first: Read the plate, or Import an STL / 3MF.');
    if (d.kind !== 'mesh') return refuse('This is already a toolpath. Slice works on a mesh - the plate, an STL or a 3MF.');
    if (!SL()) return refuse('The slicer (nso_slicer.js) did not load - check console.');
    if (!window.NSOGcodeLines) return refuse('The toolpath reader did not load - check console.');

    var po = panelOpts();
    var opts = SL().defaultsFor(po.nozzleMm, Object.assign({}, po.over, optsOver || {}));
    var flagged = [];
    var objects = d.objects.map(function (o) {
      var ns = nonSolidOf(o);
      if (ns) flagged.push(o.name);
      return { name: o.name, soup: o.positions, gapCloseMm: ns ? 0 : undefined };
    });
    var source = { label: d.name, objects: d.objects, docSource: d.source, subtitle: d.subtitle };
    busy = true;
    syncToggle();
    var read = $('ms-slice-read');
    if (read) read.textContent = 'Slicing ' + objects.length + ' object(s)...';
    say('Slicing ' + d.name + '...');
    var t0 = Date.now();
    // one frame for the status line to paint before the work starts
    return new Promise(function (res) { setTimeout(res, 0); })
      .then(function () { return SL().run(objects, opts); })
      .then(function (r) {
        if (!r.ok) return refuse('Slice refused: ' + r.reason);
        var parsed = window.NSOGcodeLines.parseGcode(r.gcode);
        if (!parsed.moves.length) return refuse('The slice has no extrusion moves - nothing thick enough for one line.');
        var name = d.name + ' - NSO slice (' + opts.nozzleMm + ' mm nozzle, ' + opts.layerMm + ' mm layers)';
        pending = { source: source, result: r, name: name, flagged: flagged, ms: Date.now() - t0 };
        var nd = MS().openToolpathResult(name, {
          plate: 1, part: 'NSO in-house slice', plates: [1], parsed: parsed, groups: null, warnings: parsed.warnings
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

  /** Slice view: slice the open mesh now, with the settings as they stand. */
  function sliceView() {
    if (showingSlice()) return Promise.resolve({ ok: true, reason: 'already in Slice view', doc: MS().getDoc() });
    return slice();
  }

  /** Normal: from a slice, back to its mesh; on a mesh, the re-frame Normal always was. */
  function normalView() {
    if (busy) return null;
    if (showingSlice()) return backToMesh();
    return MS() ? MS().normalView() : null;
  }

  function viewMode() { return showingSlice() ? 'slice' : 'normal'; }

  function syncToggle() {
    var d = MS() && MS().getDoc();
    var on = showingSlice();
    var n = $('ms-cam-normal'), c = $('ms-cam-slice');
    if (n) {
      n.classList.toggle('active', !on);
      n.setAttribute('aria-pressed', String(!on));
      n.disabled = busy;
    }
    if (c) {
      c.classList.toggle('active', on);
      c.setAttribute('aria-pressed', String(on));
      c.setAttribute('aria-busy', String(busy));
      // A mesh can be sliced; an imported .gcode.3mf is a slice already.
      c.disabled = busy || !(d && (d.kind === 'mesh' || on));
      c.textContent = busy ? 'Slicing...' : 'Slice view';
    }
  }

  // --- the Detected features tab, on a slice --------------------------------

  var FAMILIES = [
    { key: 'walls', groups: ['Outer wall', 'Inner wall', 'Overhang wall'] },
    { key: 'infill', groups: ['Sparse infill', 'Internal solid infill'] },
    { key: 'skin', groups: ['Top surface', 'Bottom surface', 'Bridge'] }
  ];
  var OVERHANG_COLOR = 0xe5484d;

  function moves(d, groups) {
    return groups.reduce(function (a, g) { return a + (d.groups[g] ? d.groups[g].length : 0); }, 0);
  }

  /** The moves printed over one overhang region: its layers, inside its footprint's bounds. */
  function regionMoves(d, r, g) {
    var lo = r.planes[g.firstLayer].printZ - 1e-6, hi = r.planes[g.lastLayer].printZ + 1e-6;
    var pad = r.options.outerWallWidthMm || 0.5;
    return d.segments.filter(function (sg) {
      if (sg.feature === 'Travel' || !(sg.z >= lo && sg.z <= hi)) return false;
      var mx = (sg.x0 + sg.x1) / 2, my = (sg.y0 + sg.y1) / 2;
      return mx >= g.min[0] - pad && mx <= g.max[0] + pad && my >= g.min[1] - pad && my <= g.max[1] + pad;
    }).map(function (sg) { return sg.mv.index; });
  }

  function isolateOrSay(ok, what) {
    if (!ok) say(what + ': nothing of it is left to show', true);
    return ok;
  }

  /** The rows Slice view lists under Detected features: feature families, then overhang calls. */
  function detectedRows(d) {
    if (!d || !d.nsoSlice) return [];
    var r = d.nsoSlice.result, o = r.options;
    var rows = [], taken = { Travel: 1 };
    FAMILIES.forEach(function (f) {
      var have = f.groups.filter(function (g) { return !!d.groups[g]; });
      have.forEach(function (g) { taken[g] = 1; });
      if (!have.length) return;
      var n = moves(d, have);
      var label = f.key === 'walls'
        ? 'Walls - ' + o.wallLoops + ' loop' + (o.wallLoops === 1 ? '' : 's') + ', ' + o.outerWallWidthMm + ' mm (' + n + ')'
        : f.key === 'infill'
          ? 'Infill - ' + Math.round(o.sparseDensity * 100) + ' % ' + o.sparsePattern + ' (' + n + ')'
          : 'Top / bottom (' + n + ')';
      rows.push({ key: f.key, group: have[0], label: label,
        title: have.map(function (g) { return g + ': ' + d.groups[g].length + ' moves'; }).join('\n') +
          '\nClick to isolate them - every other feature hidden.',
        onClick: function () { return isolateOrSay(MS().isolateGroups(have), label); } });
    });
    Object.keys(d.groups).sort().forEach(function (g) {
      if (taken[g]) return;
      rows.push({ key: 'group:' + g, group: g, label: g + ' (' + d.groups[g].length + ')',
        title: 'Click to isolate ' + g + '.',
        onClick: function () { return isolateOrSay(MS().isolateGroups([g]), g); } });
    });
    r.objects.forEach(function (ob) {
      if (!ob.overhang.length) {
        rows.push({ key: 'overhang-none:' + ob.name, color: OVERHANG_COLOR, dim: true,
          label: 'Overhang: ' + ob.name + ' - none, no support needed',
          title: 'Nothing on ' + ob.name + ' prints steeper than ' + o.supportThresholdDeg + '° off the plate.' });
        return;
      }
      ob.overhang.forEach(function (g, i) {
        var label = 'Overhang: ' + ob.name + ' at z ' + g.firstZ.toFixed(2) + ' - support on ' + g.standsOn;
        rows.push({ key: 'overhang:' + ob.name + ':' + i, color: OVERHANG_COLOR, label: label,
          title: g.footprintMm2.toFixed(1) + ' mm² needs support below ' + o.supportThresholdDeg + '°, layers ' +
            (g.firstLayer + 1) + '-' + (g.lastLayer + 1) + ', standing on the ' + g.standsOn +
            '.\nClick to isolate the moves printed over it.',
          onClick: function () { return isolateOrSay(MS().isolateMoves(regionMoves(d, r, g), 'detected'), label); } });
      });
    });
    if (r.conflicts.length) {
      rows.push({ key: 'conflict', color: OVERHANG_COLOR,
        label: 'Conflict: pieces overlap on layer ' + conflictLayers(r).join(', '),
        title: 'Two pieces print into each other on these layers.' });
    }
    return rows;
  }

  function report(r, flagged) {
    var lines = [];
    var o = r.options;
    lines.push(r.planes.length + ' layers at ' + o.layerMm + ' mm, walls ' + o.outerWallWidthMm + ' mm x ' + o.wallLoops +
      ', ' + Math.round(o.sparseDensity * 100) + ' % ' + o.sparsePattern + ', support below ' + o.supportThresholdDeg + '° (' + r.ms + ' ms).');
    r.objects.forEach(function (ob) {
      var regions = ob.overhang.map(function (g) {
        return 'z ' + g.firstZ.toFixed(2) + ' (' + g.footprintMm2.toFixed(1) + ' mm² on ' + g.standsOn + ')';
      });
      var wc = Object.keys(ob.wallCountHistogram).map(function (k) { return k + '×' + ob.wallCountHistogram[k]; }).join(' ');
      lines.push(ob.name + ': walls per layer ' + wc + '; ' + (regions.length ? 'needs support at ' + regions.join(', ') : 'no support needed') +
        (ob.sectionStats.openChains ? '; ' + ob.sectionStats.openChains + ' open section chain(s)' +
          (ob.nonSolid ? ' left open (non-solid)' : ', ' + ob.sectionStats.closedByGap + ' closed, ' + ob.sectionStats.droppedChains + ' dropped') : '') +
        (ob.flipped ? '; mesh wound inside out' : '') + '.');
    });
    if (r.conflicts.length) lines.push('CONFLICT: pieces print into each other on layer ' + conflictLayers(r).join(', ') + '.');
    if (flagged && flagged.length) lines.push('Non-solid (open by design): ' + flagged.join(', ') + '.');
    return lines.join(' ');
  }

  function syncPanel() {
    var row = $('ms-slice-row');
    var d = MS() && MS().getDoc();
    var ours = !!(d && d.nsoSlice);
    if (row) row.style.display = d && (d.kind === 'mesh' || ours) ? 'block' : 'none';
    syncToggle();
    var exp = $('ms-slice-export-row');
    if (exp) exp.style.display = ours ? 'flex' : 'none';
    var read = $('ms-slice-read');
    if (!read || busy) return;
    if (ours) read.textContent = report(d.nsoSlice.result, d.nsoSlice.flagged);
    else if (d && d.kind === 'mesh') read.textContent = 'Slice view slices every ' + (d.source === 'plate' ? 'piece' : 'object') +
      ' into real layers, walls and infill with the in-house slicer and lists what it finds under Detected features.';
  }

  function bind(id, ev, fn) {
    var el = $(id);
    if (el && el.dataset.wired !== '1') { el.dataset.wired = '1'; el.addEventListener(ev, fn); }
  }

  function mount() {
    if (!MS()) return;
    MS().addDetectedSource(detectedRows);
    MS().onDocument(function (d) {
      if (pending && d && d.kind === 'toolpath') { d.nsoSlice = pending; last = pending; }
      pending = null;
      if (d && d.nsoSlice) {
        // The legend was built before the slice was attached: its rows now,
        // and the Detected features tab up.
        MS().refreshDetected();
        MS().setLegendTab('detected');
      }
      syncPanel();
    });
    bind('ms-cam-slice', 'click', function () { sliceView(); });
    bind('ms-cam-normal', 'click', function () { normalView(); });
    bind('ms-btn-slice-export-plate', 'click', exportPieceToPlate);
    bind('ms-btn-slice-export-stl', 'click', exportPieceAsSTL);
    bind('ms-slice-nozzle', 'change', function () {
      var n = num('ms-slice-nozzle', 0.6), lay = $('ms-slice-layer');
      if (lay) lay.value = String(Math.round(n * 0.5 * 100) / 100);
    });
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
    detectedRows: detectedRows,
    backToMesh: backToMesh,
    exportPieceToPlate: exportPieceToPlate,
    exportPieceAsSTL: exportPieceAsSTL,
    last: function () { return last; },
    busy: function () { return busy; },
    panelOpts: panelOpts
  };
})();

if (typeof window !== 'undefined') window.NSO_GSCOPE_SLICE = NSO_GSCOPE_SLICE;
