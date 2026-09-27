/*
 * G-scope Slice - the in-house slicer (nso_slicer.js), on demand, for any
 * piece G-scope has open: the plate as it stands, or an STL / 3MF.
 * ----------------------------------------------------------------------------
 *
 * READ docs/SLICER.md FIRST. It says what this slicer is for - reverse
 * engineering and internal iteration - and what it is not: a final-print
 * decision tool. A real print is sliced in Bambu Studio on the real nozzle.
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
 * WHAT IT READS. The mesh document's own objects - Z-up millimetre soups,
 * already in the world frame for plate pieces (G-scope's plate route reads them
 * off the scene with meshToWorldSoup). All pieces are sliced together, in one
 * frame, dropped onto the plate together, so two pieces that overlap in a
 * layer are reported as a conflict, by layer number.
 *
 * PAINT SCOPE: NONE - it reads geometry and writes nothing: no piece, no
 * face, no undo step. Paint has nothing to protect from it (docs/HANDOFF.md,
 * "Scoping"; the same category as Skin patch's).
 *
 * NON-SOLID SCOPE (docs/NON-SOLID.md): read through nsoNonSolid for plate
 * pieces, never inferred. A piece flagged non-solid is sliced with
 * gapCloseMm 0: its open section chains are left open and counted, not
 * chorded shut, because its open edges are the design. A file opened straight
 * into G-scope has no flag to read and is sliced as a solid.
 */
/* global state, setStatus */
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
    var btn = $('ms-btn-slice');
    if (btn) btn.disabled = true;
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
        if (btn) btn.disabled = false;
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
    if (!last || !last.source) return null;
    var s = last.source;
    if (s.docSource === 'plate' && MS().openPlate) return MS().openPlate();
    return MS().openObjects(s.label, s.objects, { source: s.docSource, subtitle: s.subtitle });
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
    lines.push('For inspection only - not a print file. Validate a real print in Bambu Studio.');
    return lines.join(' ');
  }

  function syncPanel() {
    var row = $('ms-slice-row');
    var d = MS() && MS().getDoc();
    var ours = !!(d && d.nsoSlice);
    if (row) row.style.display = d && (d.kind === 'mesh' || ours) ? 'block' : 'none';
    var btn = $('ms-btn-slice'), back = $('ms-btn-slice-back');
    if (btn) { btn.style.display = d && d.kind === 'mesh' ? '' : 'none'; btn.disabled = busy; }
    if (back) back.style.display = ours ? '' : 'none';
    var read = $('ms-slice-read');
    if (!read || busy) return;
    if (ours) read.textContent = report(d.nsoSlice.result, d.nsoSlice.flagged);
    else if (d && d.kind === 'mesh') read.textContent = 'Slice every ' + (d.source === 'plate' ? 'piece' : 'object') +
      ' into real layers, walls and infill with the in-house slicer, then inspect it here line by line.';
  }

  function bind(id, ev, fn) {
    var el = $(id);
    if (el && el.dataset.wired !== '1') { el.dataset.wired = '1'; el.addEventListener(ev, fn); }
  }

  function mount() {
    if (!MS()) return;
    MS().onDocument(function (d) {
      if (pending && d && d.kind === 'toolpath') { d.nsoSlice = pending; last = pending; }
      pending = null;
      syncPanel();
    });
    bind('ms-btn-slice', 'click', function () { slice(); });
    bind('ms-btn-slice-back', 'click', backToMesh);
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
    backToMesh: backToMesh,
    last: function () { return last; },
    busy: function () { return busy; },
    panelOpts: panelOpts
  };
})();

if (typeof window !== 'undefined') window.NSO_GSCOPE_SLICE = NSO_GSCOPE_SLICE;
