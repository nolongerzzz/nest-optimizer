/*
 * Slice card (main plate) - the plate sliced for its printer, and the file it
 * makes. UI only, download only (docs/PRINT-PLANNER.md, "The Slice card").
 *
 * A SLICE button in the left bar opens a card that slices EVERY piece on the
 * plate, supports included, with the shared engine (nso_slicer.js) and the
 * print planner (nso-print-planner.js), for the plate's printer profile. When
 * it finishes the card reads out layers, estimated time and filament grams,
 * and offers two actions:
 *   Export .gcode.3mf    the packaged file (nso-gcode3mf-write.js), downloaded
 *   Preview in G-scope   that same file through G-scope's existing .gcode.3mf
 *                        import (NSO_MICROSCOPE.openFile) - read-only, so the
 *                        supports read as Support / Support interface /
 *                        Support transition
 * A plate the planner refuses (off the bed, too tall, no first layer) shows
 * the planner's own reason in the card. Nothing else is invented: no settings
 * here; the printer template's values are used as they are.
 *
 * G-SCOPE IS NOT TOUCHED. This file reads the plate through G-scope's public
 * plateObjects() and hands a finished file to its openFile(); it never reads
 * or writes G-scope's Slice settings, and no G-scope file loads the planner.
 * Print settings belong to the plate's printer profile, not to G-scope's panel.
 *
 * TWO HALVES, ONE FILE
 *   the pure half   profileFor, pieceObjects, build, fileName, readTemplate.
 *                   No DOM. It loads on the page, in the slice worker
 *                   (importScripts) and in Node (tools/print-slice-check.js).
 *   the card        guarded by `document`; binds #menu-slice.
 *
 * THE SLICE RUNS IN A WORKER. The engine is synchronous JS (a 40-layer plate is
 * seconds, a big one a minute), so a worker loads the same engine files the
 * page loaded - found from the page's own <script> tags - and does slice, plan
 * and pack there; the page stays alive and the card shows the stage and the
 * seconds. tools/nso_slice_pool.js is the Node-only pool and is not used here.
 *
 * COORDINATES. The viewport's plate is centred on (0, 0); a printer's bed has
 * its origin at the front-left corner. G-scope's plateObjects() hands back
 * Z-up millimetres about the centre, so every piece is moved by half the
 * printer's bed in X and Y before it is sliced (the planner refuses a plate
 * that is not on the bed rather than clipping it).
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSO_Print = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var node = typeof module === 'object' && module.exports;
  var lazy = function (file, global) { return node ? require('./' + file) : root[global]; };

  // ===========================================================================
  // The pure half
  // ===========================================================================

  /**
   * The plate picker's printers that have a profile. `template` is the project
   * the printer's settings come from (an unzipped Metadata/project_settings.config);
   * `frozen` is the planner's start / end for it. A1 mini first; the P1S uses the
   * project it already has (the owner's P1S slice). The picker's "A1 / P1S / X1C 256"
   * plate takes the P1S profile: it is the 256 mm one the planner has.
   */
  var PROFILES = {
    a1mini: {
      id: 'a1mini-0.4', short: 'A1 mini', label: 'Bambu Lab A1 mini, 0.4 nozzle',
      template: 'fixtures/bambu-templates/a1mini-0.4/project_test.3mf',
      frozen: 'fixtures/print-planner/a1mini-0.4/frozen.json'
    },
    a1: {
      id: 'p1s-0.4', short: 'P1S', label: 'Bambu Lab P1S, 0.4 nozzle',
      template: 'fixtures/supports/simple_overhang_p1s.gcode.3mf',
      frozen: 'fixtures/print-planner/p1s-0.4/frozen.json'
    }
  };
  var SETTINGS_PART = 'Metadata/project_settings.config';

  // The files the slice worker loads, in order: the page's own <script> tags
  // (a ?v= bump is picked up), so each must be one of them.
  var ENGINE = ['nso-cooling-profiles.js', 'nso-3mf.js', 'nso-3mf-read.js', 'nso_csg.js', 'nso_slicer.js',
                'nso-print-planner.js', 'nso-gcode3mf-write.js', 'app-print.js'];

  /** The profile for a plate picker id, or null. */
  function profileFor(plateId) {
    return Object.prototype.hasOwnProperty.call(PROFILES, plateId) ? PROFILES[plateId] : null;
  }

  /** The template's project settings (the object) out of the bytes of a 3MF / .gcode.3mf. */
  function readTemplate(bytes) {
    var R = lazy('nso-3mf-read.js', 'NSO3MFRead');
    if (!R || !R.openZip) return Promise.reject(new Error('nso-3mf-read.js did not load'));
    var zip = R.openZip(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    return Promise.resolve(zip.read(SETTINGS_PART)).then(function (b) {
      if (!b) throw new Error('the printer template has no ' + SETTINGS_PART);
      return JSON.parse(new TextDecoder().decode(b));
    });
  }

  /**
   * The plate's pieces as the engine's input. `pieces` are what the plate gives:
   *   { name, soup (Z-up mm about the plate's centre), sourceId, support, hostSourceId, nonSolid }
   * A support is typed by the engine (role 'support'); it is not retyped here.
   * A piece flagged non-solid is sliced with its open edges left open, as G-scope's
   * Slice does it. `bed` is the printer's { x, y }.
   */
  function pieceObjects(pieces, bed) {
    var dx = bed.x / 2, dy = bed.y / 2;
    return pieces.map(function (p) {
      var soup = new Float32Array(p.soup.length);
      for (var i = 0; i < soup.length; i += 3) {
        soup[i] = p.soup[i] + dx;
        soup[i + 1] = p.soup[i + 1] + dy;
        soup[i + 2] = p.soup[i + 2];
      }
      return { name: p.name, soup: soup, key: p.sourceId, gapCloseMm: p.nonSolid ? 0 : undefined,
               role: p.support ? (p.brim ? 'brim' : 'support') : 'part', hostKey: p.support ? p.hostSourceId : undefined,
               interfaceLayers: p.support ? p.interfaceLayers : undefined,
               sheetLayerMm: p.support ? p.sheetLayerMm : undefined };
    });
  }

  /** "Name - A1 mini.gcode.3mf": the one piece's name, else the piece count. */
  function fileName(pieces, profile) {
    var parts = pieces.filter(function (p) { return !p.support; });
    var base = parts.length === 1 ? parts[0].name : (parts.length || pieces.length) + ' pieces';
    base = String(base).replace(/\.(stl|3mf)$/i, '').replace(/[\/\\?%*:|"<>]/g, '').replace(/\s+/g, ' ').trim() || 'plate';
    return base + ' - ' + profile.short + '.gcode.3mf';
  }

  /**
   * Slice the objects, plan the G-code, pack the .gcode.3mf.
   * @param objects  pieceObjects()
   * @param assets   { config (the template's project settings), printer (the frozen start / end) }
   * @param opts     { onStage(name, info) }  'slicing' then 'writing'
   * @returns {Promise<{ok, reason, bytes, stats, features, objects}>}  never rejects:
   *   a refusal (the engine's, the planner's) comes back as ok:false with its words.
   */
  function build(objects, assets, opts) {
    opts = opts || {};
    var stage = opts.onStage || function () {};
    var SL = lazy('nso_slicer.js', 'NSO_Slicer'), PL = lazy('nso-print-planner.js', 'NSOPrintPlanner');
    if (!SL) return Promise.resolve({ ok: false, reason: 'The slicer (nso_slicer.js) did not load - check console.' });
    if (!PL) return Promise.resolve({ ok: false, reason: 'The print planner (nso-print-planner.js) did not load - check console.' });
    return Promise.resolve().then(function () {
      var eng = PL.engineOptions(assets.config);
      var o = SL.defaultsFor(eng.nozzleMm, Object.assign({ emitGcode: false }, eng.over));
      /* a sheet of more interface layers than the slicer's default says so (the card's Dense: 3): the slicer types its top 3 layers interface, as G-scope's Slice does */
      var ni = 0;
      objects.forEach(function (ob) { if (ob.interfaceLayers > ni) ni = ob.interfaceLayers; });
      if (ni > 2 && (eng.over || {}).supportInterfaceLayers == null) o.supportInterfaceLayers = ni;
      /* ...and a Dense sheet's own thicker layers (Bambu's 0.275): the supports are cut on their own layer grid, as G-scope's Slice does */
      var sl = 0;
      objects.forEach(function (ob) { if (ob.sheetLayerMm > sl) sl = ob.sheetLayerMm; });
      if (sl > 0 && (eng.over || {}).supportLayerMaxMm == null) o.supportLayerMaxMm = 0.28;
      stage('slicing', { objects: objects.length });
      return SL.run(objects, o);
    }).then(function (res) {
      if (!res.ok) return { ok: false, reason: 'Slice refused: ' + res.reason };
      stage('writing', { layers: res.planes.length });
      return PL.toGcode3mf(res, { config: assets.config, printer: assets.printer }).then(function (out) {
        var seen = {};
        out.plan.layers.forEach(function (l) { l.features.forEach(function (f) { seen[f] = 1; }); });
        var st = out.plan.stats;
        return {
          ok: true, reason: '', bytes: out.bytes, features: Object.keys(seen), objects: out.plan.labels.length,
          labels: out.plan.labels.map(function (l) { return { id: l.id, name: l.name, index: l.index }; }),     // the gcode's OBJECT_ID of each object, in the order they were given
          stats: { layers: st.layers, seconds: st.seconds.total, grams: st.grams, filamentMm: st.filamentMm, maxZ: st.maxZ }
        };
      });
    }).catch(function (err) {
      // the planner's refusal (toGcode3mf rejects with plan().reason), or whatever stopped the slice
      return { ok: false, reason: (err && err.message) || String(err) };
    });
  }

  /** Seconds as "1 h 05 min" / "42 min" / "30 s". */
  function fmtTime(sec) {
    var s = Math.round(sec);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h) return h + ' h ' + (m < 10 ? '0' : '') + m + ' min';
    if (m) return m + ' min';
    return s + ' s';
  }

  /** The readout line: layers, estimated time, filament. */
  function describe(r) {
    return r.stats.layers + ' layers - ' + fmtTime(r.stats.seconds) + ' - ' + r.stats.grams.toFixed(1) + ' g filament';
  }

  /** Worker entry (see the card): build, with the file's bytes moved rather than copied. */
  function buildForWorker(objects, assets, onStage) {
    return build(objects, assets, { onStage: onStage }).then(function (r) {
      var b = r.bytes, move = [];
      if (b) {
        if (b.byteOffset !== 0 || b.byteLength !== b.buffer.byteLength) r.bytes = b = b.slice();
        move.push(b.buffer);
      }
      return { result: r, move: move };
    });
  }

  var api = {
    PROFILES: PROFILES, ENGINE: ENGINE, profileFor: profileFor, readTemplate: readTemplate, pieceObjects: pieceObjects,
    fileName: fileName, build: build, fmtTime: fmtTime, describe: describe, buildForWorker: buildForWorker
  };

  // ===========================================================================
  // The card
  // ===========================================================================

  if (typeof document === 'undefined' || !document.getElementById) return api;

  var $ = function (id) { return document.getElementById(id); };
  var S = { busy: false, job: null, result: null, sig: null, pieces: null, profile: null, assets: {}, timer: null, t0: 0, stage: '', hook: null, exporting: false };

  function say(msg, isErr) {
    if (typeof setStatus === 'function') setStatus(msg, !!isErr);
    else if (isErr) console.error(msg); else console.log(msg);
  }

  /** The card's one voice: a readout line, or a refusal in red. */
  function readout(text, bad) {
    var el = $('slice-readout');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-bad', !!bad);
  }

  function plateId() { return typeof state !== 'undefined' && state ? state.plate : null; }

  /** The plate's pieces as pieceObjects() takes them, off G-scope's reader of the plate. */
  function readPieces() {
    var MS = root.NSO_MICROSCOPE;
    if (!MS || !MS.plateObjects) return null;
    return MS.plateObjects().map(function (o) {
      var m = (state.models || []).find(function (x) { return x && x.id === o.sourceId; });
      var sup = m && m.nsoSupport ? m.nsoSupport : null;
      var placed = o.placedIndex != null ? state.placed[o.placedIndex] : null;
      var pm = placed && (state.models || []).find(function (x) { return x && x.id === placed.sourceId; });
      return { name: o.name, soup: o.positions, sourceId: o.sourceId, support: !!sup, brim: !!(sup && sup.brim), hostSourceId: sup ? sup.hostSourceId : undefined, interfaceLayers: sup ? sup.interfaceLayers : undefined, sheetLayerMm: sup ? sup.sheetLayerMm : undefined,
               nonSolid: !!(pm && typeof root.nsoNonSolid === 'function' && root.nsoNonSolid(pm)),
               settings: m && m.slicerSettings ? Object.assign({}, m.slicerSettings) : null };      // a support's own slicer overrides ride into a 3MF
    });
  }

  /** What the plate is now, in a line: a slice made from another plate is not this one's. */
  function plateSignature() {
    var parts = [plateId()];
    state.placed.forEach(function (p) {
      if (!p || !p.mesh) return;
      p.mesh.updateMatrixWorld(true);
      parts.push(p.sourceId + ':' + (p.mesh.geometry ? p.mesh.geometry.uuid : '') + ':' + p.mesh.matrixWorld.elements.join(','));
    });
    return parts.join('|');
  }

  function fetchAsset(path, kind) {
    return fetch(path).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return kind === 'json' ? r.json() : r.arrayBuffer();
    }).catch(function (err) {
      throw new Error('Can\'t load ' + path + ' (' + ((err && err.message) || err) + '). It is a static file served next to index.html - ' +
        'check that the fixtures/ folder is on the server.');
    });
  }

  /** The profile's template settings and frozen blocks, fetched once. */
  function loadAssets(profile) {
    if (S.assets[profile.id]) return Promise.resolve(S.assets[profile.id]);
    return Promise.all([fetchAsset(profile.frozen, 'json'), fetchAsset(profile.template, 'bytes')]).then(function (a) {
      return readTemplate(new Uint8Array(a[1])).then(function (config) {
        return (S.assets[profile.id] = { printer: a[0], config: config });
      });
    });
  }

  function engineUrls() {
    var out = [];
    for (var i = 0; i < ENGINE.length; i++) {
      var el = document.querySelector('script[src^="' + ENGINE[i] + '"]');
      if (!el || !el.src) return null;
      out.push(el.src);
    }
    return out;
  }

  /**
   * The slice on a worker: { cancel(), promise }. A progress message per stage
   * comes back to onStage. A page that cannot start a worker slices in-thread
   * (and freezes while it does).
   */
  function runAway(objects, assets, onStage) {
    var urls = engineUrls();
    var canWorker = urls && typeof Worker === 'function' && typeof Blob === 'function' && root.URL && URL.createObjectURL;
    if (!canWorker) {
      var dead = false;
      return {
        cancel: function () { dead = true; },
        promise: new Promise(function (go) { setTimeout(go, 0); }).then(function () {
          return build(objects, assets, { onStage: onStage });
        }).then(function (r) { if (dead) return new Promise(function () {}); return r; })
      };
    }
    var code = 'importScripts(' + urls.map(function (u) { return JSON.stringify(u); }).join(',') + ');\n' +
      'self.onmessage = function (e) {\n' +
      '  var d = e.data;\n' +
      '  self.NSO_Print.buildForWorker(d.objects, d.assets, function (s, info) { self.postMessage({ stage: s, info: info }); })\n' +
      '    .then(function (o) { self.postMessage({ result: o.result }, o.move); },\n' +
      '          function (err) { self.postMessage({ error: (err && err.message) || String(err) }); });\n' +
      '};\n';
    var url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), w;
    try { w = new Worker(url); } catch (err) { URL.revokeObjectURL(url); return null; }
    var done = false;
    var promise = new Promise(function (resolve, reject) {
      w.onmessage = function (e) {
        if (e.data.stage) { onStage(e.data.stage, e.data.info); return; }
        done = true;
        if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.result);
      };
      w.onerror = function (ev) { done = true; reject(new Error((ev && ev.message) || 'the slicer stopped')); };
      var move = objects.map(function (o) { return o.soup.buffer; });
      w.postMessage({ objects: objects, assets: assets }, move);
    }).then(function (r) { cleanup(); return r; }, function (err) { cleanup(); throw err; });
    function cleanup() { try { w.terminate(); } catch (e) { /* gone */ } try { URL.revokeObjectURL(url); } catch (e2) { /* ditto */ } }
    return {
      cancel: function () { if (!done) { done = true; cleanup(); } },
      promise: promise
    };
  }

  // ---- the card's state -----------------------------------------------------

  function setBusy(on) {
    S.busy = on;
    var go = $('btn-slice-go'), cancel = $('btn-slice-cancel'), bar = $('slice-progress'), stage = $('slice-stage');
    if (go) go.disabled = on;
    if (cancel) cancel.hidden = !on;
    if (bar) bar.hidden = !on;
    if (stage) stage.hidden = !on;
    if (!on && S.timer) { clearInterval(S.timer); S.timer = null; }
    syncActions();
  }

  function stageText() {
    var secs = Math.round((Date.now() - S.t0) / 1000);
    var el = $('slice-stage');
    if (el) el.textContent = S.stage + ' - ' + secs + ' s';
    if (S.hook && S.hook.onStage) S.hook.onStage(S.stage + ' - ' + secs + ' s');
  }

  function onStage(name, info) {
    S.stage = name === 'slicing'
      ? 'Slicing ' + info.objects + ' object' + (info.objects === 1 ? '' : 's')
      : 'Writing the G-code and packing the file (' + info.layers + ' layers)';
    stageText();
  }

  function isFresh() { return !!(S.result && S.result.ok && S.sig === plateSignature()); }

  /** Export and Preview exist only for a slice of the plate as it stands. */
  function syncActions() {
    var ok = !S.busy && isFresh();
    ['btn-slice-export', 'btn-slice-preview'].forEach(function (id) { var b = $(id); if (b) b.disabled = !ok; });
  }

  /** The profile line, and a slice shown stale when the plate has moved on. */
  function refresh() {
    var p = profileFor(plateId());
    var line = $('slice-profile');
    if (line) {
      line.textContent = p ? p.label : 'No printer profile for the ' + ((typeof PLATES !== 'undefined' && PLATES[plateId()]) ? PLATES[plateId()].name : 'selected') +
        ' plate yet. Slice works on the A1 mini and the A1 / P1S / X1C plate.';
      line.classList.toggle('is-bad', !p);
    }
    if (S.result && S.result.ok && !S.busy && !isFresh()) {
      readout('The plate changed since this slice. Press Slice to slice it again.', true);
    }
    syncActions();
  }

  /**
   * Slice the plate. Returns a promise of { ok, reason, cancelled } that never rejects, so another card can go on from it
   * (Supports > Slice and Preview); the Slice card's own button ignores it. `hook.onStage(text)` hears the stage line as
   * the card shows it, and `hook.onDone(result)` hears how it ended - the card's readout is the Slice card's, unchanged.
   */
  function slice(hook) {
    if (S.busy) return Promise.resolve({ ok: false, reason: 'busy' });
    var profile = profileFor(plateId());
    function stop(reason, quietly) {
      if (!quietly) readout(reason, true);
      return { ok: false, reason: reason };
    }
    if (!profile) { refresh(); return Promise.resolve(stop('Pick the A1 mini or the A1 / P1S / X1C plate to slice for.')); }
    var pieces;
    try { pieces = readPieces(); } catch (err) { console.error(err); pieces = null; }
    if (pieces === null) return Promise.resolve(stop('The plate reader (G-scope\'s) did not load - check console.'));
    if (!pieces.length) return Promise.resolve(stop('Nothing on the plate to slice.'));
    S.result = null; S.pieces = null;
    var sig = plateSignature();
    readout('', false);
    S.hook = hook || null;
    S.t0 = Date.now(); S.stage = 'Loading the ' + profile.short + ' profile';
    setBusy(true);
    stageText();
    S.timer = setInterval(stageText, 500);
    var mine = S.job = { cancelled: false, run: null, over: false, finish: null }, told;
    var result = new Promise(function (go) { told = go; });
    /* how it ended, once: by itself, or by Cancel (a worker that is stopped answers nothing) */
    function ended(r) {
      if (mine.over) return r;
      mine.over = true;
      if (S.hook === (hook || null)) S.hook = null;
      if (hook && hook.onDone) hook.onDone(r);
      told(r);
      return r;
    }
    mine.finish = ended;
    loadAssets(profile).then(function (assets) {
      if (mine.cancelled) return null;
      var objects = pieceObjects(pieces, assets.printer.bed);
      mine.run = runAway(objects, assets, onStage);
      return mine.run.promise;
    }).then(function (r) {
      if (mine.cancelled || !r) return ended({ ok: false, reason: 'Slice cancelled.', cancelled: true });
      S.job = null;
      if (!r.ok) { setBusy(false); S.result = null; readout(r.reason, true); say('Slice: ' + r.reason, true); return ended({ ok: false, reason: r.reason }); }
      S.result = r; S.sig = sig; S.pieces = pieces; S.profile = profile;
      setBusy(false);
      var sup = pieces.filter(function (p) { return p.support && !p.brim; }).length;
      readout(describe(r) + ' - ' + pieces.length + ' object' + (pieces.length === 1 ? '' : 's') + (sup ? ' (' + sup + ' support' + (sup === 1 ? '' : 's') + ')' : ''), false);
      say('Sliced for the ' + profile.short + ': ' + describe(r));
      refresh();                          // a piece moved while it ran: the readout says so, and Export stays shut
      return ended({ ok: true, reason: '', line: describe(r), fresh: isFresh() });
    }).catch(function (err) {
      if (mine.cancelled) return ended({ ok: false, reason: 'Slice cancelled.', cancelled: true });
      S.job = null; S.result = null;
      setBusy(false);
      var why = (err && err.message) || String(err);
      readout(why, true);
      console.error('[slice]', err);
      say('Slice failed: ' + why, true);
      return ended({ ok: false, reason: why });
    });
    return result;
  }

  function cancel() {
    if (!S.busy || !S.job) return;
    var job = S.job;
    job.cancelled = true;
    if (job.run) job.run.cancel();
    S.job = null;
    setBusy(false);
    readout('Slice cancelled.', false);
    if (job.finish) job.finish({ ok: false, reason: 'Slice cancelled.', cancelled: true });
  }

  /** The finished file, or null (with the reason in the card) when the plate has moved on. */
  function freshFile() {
    if (!S.result || !S.result.ok) return null;
    if (!isFresh()) { refresh(); readout('The plate changed since this slice. Press Slice to slice it again.', true); return null; }
    return { bytes: S.result.bytes, name: fileName(S.pieces, S.profile) };
  }

  function exportFile() {
    var f = freshFile();
    if (!f) return;
    var blob = new Blob([f.bytes], { type: 'application/octet-stream' });
    if (typeof downloadBlob === 'function') downloadBlob(blob, f.name);
    else {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = f.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }
    say('Downloaded ' + f.name);
  }

  function previewInGscope() {
    var f = freshFile();
    if (!f) return false;
    var MS = root.NSO_MICROSCOPE;
    if (!MS || !MS.openFile) { readout('G-scope did not load - check console.', true); return false; }
    var menu = $('menu-slice');
    if (menu) menu.open = false;
    // a copy: G-scope reads the bytes, and the card keeps its file for Export
    var rec = { name: f.name, bytes: f.bytes, pieces: S.pieces, labels: S.result.labels || [], profile: S.profile };
    var opened = MS.openFile(f.name, f.bytes.slice().buffer);
    // G-scope's Export card then offers this slice (exportSlice): the document carries what it was made from
    if (opened && opened.then) opened.then(function (d) {
      if (!d) return;
      d.nsoPlateSlice = rec;
      if (d.importOf) d.importOf.nsoPlateSlice = rec;
      if (MS.refreshExport) MS.refreshExport();
    });
    return true;
  }

  // ---- G-scope's Export card, for a slice made here ----------------------------

  function saveBytes(bytes, name, type) {
    var blob = new Blob([bytes], { type: type || 'application/octet-stream' });
    if (typeof downloadBlob === 'function') downloadBlob(blob, name);
    else {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    }
  }
  /** The slice's objects (indices into rec.pieces) a list of G-code OBJECT_IDs stands for (null: the one unlabelled object of a one-piece plate). */
  function indicesFor(rec, ids) {
    var byId = {};
    (rec.labels || []).forEach(function (l) { byId[String(l.id)] = l.index; });
    var out = [];
    (ids || []).forEach(function (id) {
      var k = id == null ? (rec.labels && rec.labels.length === 1 ? 0 : null) : byId[String(id)];
      if (k != null && out.indexOf(k) < 0) out.push(k);
    });
    return out.sort(function (a, b) { return a - b; });
  }
  /** What a selection of pieces takes with it: the supports (and brim) that hold them. */
  function withSupports(rec, idx) {
    var set = {}, hosts = {};
    idx.forEach(function (i) { set[i] = true; var p = rec.pieces[i]; if (p && !p.support) hosts[p.sourceId] = true; });
    rec.pieces.forEach(function (p, i) { if (p.support && hosts[p.hostSourceId]) set[i] = true; });
    return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
  }
  function exportBusy(on, text) {
    S.exporting = on;
    ['ms-btn-plate-gcode3mf', 'ms-btn-plate-3mf', 'ms-btn-sel-gcode3mf', 'ms-btn-sel-3mf'].forEach(function (id) { var b = $(id); if (b) b.disabled = !!on; });
    if (text) say(text, false);
  }

  /**
   * Download what G-scope is showing, as the slice it came from, whole or for the pieces selected in it.
   *   rec    the document's nsoPlateSlice
   *   kind   'gcode3mf' - the sliced file: the whole plate's is the file as it was made, a selection is sliced again, alone, with the
   *                       supports that hold it (the same profile and the same engine, so its layers are the plate's own);
   *          '3mf'      - the pieces as a Bambu Studio project (the Export card's 3MF writer, the cooling profile it has chosen)
   *   ids    null: the whole plate; else the G-code OBJECT_IDs of the selection (G-scope's selectedObjectIds())
   * Resolves { ok, reason, name }; never rejects.
   */
  function exportSlice(rec, kind, ids) {
    if (!rec || !rec.pieces) return Promise.resolve({ ok: false, reason: 'There is no slice here to export.' });
    if (S.exporting) return Promise.resolve({ ok: false, reason: 'busy' });
    var idx = null;
    if (ids) {
      idx = withSupports(rec, indicesFor(rec, ids));
      if (!idx.length) { say('Nothing in the selection is one of the slice\'s pieces.', true); return Promise.resolve({ ok: false, reason: 'no pieces in the selection' }); }
    }
    var sub = idx ? idx.map(function (i) { return rec.pieces[i]; }) : rec.pieces;
    var what = idx ? 'the selection' : 'the plate';
    function fail(why) { exportBusy(false); say('Export failed: ' + why, true); return { ok: false, reason: why }; }
    if (kind === 'gcode3mf') {
      if (!idx) { saveBytes(rec.bytes, rec.name); say('Downloaded ' + rec.name); return Promise.resolve({ ok: true, name: rec.name }); }
      exportBusy(true, 'Slicing ' + what + ' (' + sub.length + ' object' + (sub.length === 1 ? '' : 's') + ')...');
      return loadAssets(rec.profile).then(function (assets) {
        var run = runAway(pieceObjects(sub, assets.printer.bed), assets, function () {});
        return run ? run.promise : build(pieceObjects(sub, assets.printer.bed), assets, {});
      }).then(function (r) {
        if (!r.ok) return fail(r.reason);
        var name = fileName(sub, rec.profile);
        saveBytes(r.bytes, name);
        exportBusy(false);
        say('Downloaded ' + name + ' - ' + describe(r));
        return { ok: true, name: name };
      }).catch(function (err) { console.error('[export slice]', err); return fail((err && err.message) || String(err)); });
    }
    if (kind === '3mf') {
      var N3 = root.NSO3MF, plate = typeof root.getCurrentPlate === 'function' ? root.getCurrentPlate() : null;
      if (!N3 || !N3.build3MF) { say('The 3MF writer did not load - check console.', true); return Promise.resolve({ ok: false, reason: '3MF writer missing' }); }
      var dx = (plate ? plate.w : rec.profile ? 180 : 180) / 2, dy = (plate ? plate.d : 180) / 2;
      var objects = sub.map(function (p, i) {
        var flat = new Array(p.soup.length);
        for (var k = 0; k < p.soup.length; k += 3) { flat[k] = p.soup[k] + dx; flat[k + 1] = p.soup[k + 1] + dy; flat[k + 2] = p.soup[k + 2]; }
        var mesh = N3.indexTriangleSoup(flat), o = { name: p.name || ('piece_' + (i + 1)), vertices: mesh.vertices, triangles: mesh.triangles };
        if (p.settings) o.settings = Object.assign({}, p.settings);
        return o;
      });
      exportBusy(true, 'Building the 3MF of ' + what + '...');
      var profileId = typeof root.getCoolingProfileId === 'function' ? root.getCoolingProfileId() : undefined;
      return N3.build3MF({ objects: objects, profileId: profileId, plateName: plate ? plate.name : 'plate' }).then(function (res) {
        var name = fileName(sub, rec.profile).replace(/\.gcode\.3mf$/i, '.3mf');
        saveBytes(res.bytes, name, 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml');
        exportBusy(false);
        say('Downloaded ' + name + ' - ' + sub.length + ' object' + (sub.length === 1 ? '' : 's'));
        return { ok: true, name: name };
      }).catch(function (err) { console.error('[export 3mf]', err); return fail((err && err.message) || String(err)); });
    }
    return Promise.resolve({ ok: false, reason: 'unknown format' });
  }
  /** The Export card's four buttons: this slice, whole or selected, as .gcode.3mf or .3mf. */
  function exportFromCard(kind, selected) {
    var MS = root.NSO_MICROSCOPE, d = MS && MS.getDoc && MS.getDoc(), rec = d && d.nsoPlateSlice;
    if (!rec) return Promise.resolve({ ok: false, reason: 'no slice' });
    return exportSlice(rec, kind, selected ? MS.selectedObjectIds() : null);
  }

  /**
   * Slice the plate and open the slice in G-scope (the Supports card's Slice and Preview): the Slice card's own slice, then
   * its own Preview in G-scope. Resolves { ok, reason, previewed }; a slice that fails, is cancelled, or is out of date by the
   * time it is done is not opened. `hook` is slice()'s.
   */
  function sliceAndPreview(hook) {
    return slice(hook).then(function (r) {
      if (!r.ok) return { ok: false, reason: r.reason, cancelled: !!r.cancelled, previewed: false };
      if (!isFresh()) return { ok: false, reason: 'The plate changed while it was slicing. Press Slice and Preview again.', previewed: false };
      var opened = previewInGscope();
      return opened ? { ok: true, reason: '', line: r.line, previewed: true } : { ok: false, reason: 'G-scope did not open the slice - check console.', previewed: false };
    });
  }

  function mount() {
    var menu = $('menu-slice');
    if (!menu) return;
    var bind = function (id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); };
    bind('btn-slice-go', function () { slice(); });
    bind('btn-slice-cancel', cancel);
    bind('btn-slice-export', exportFile);
    bind('btn-slice-preview', previewInGscope);
    bind('ms-btn-plate-gcode3mf', function () { exportFromCard('gcode3mf', false); });
    bind('ms-btn-plate-3mf', function () { exportFromCard('3mf', false); });
    bind('ms-btn-sel-gcode3mf', function () { exportFromCard('gcode3mf', true); });
    bind('ms-btn-sel-3mf', function () { exportFromCard('3mf', true); });
    menu.addEventListener('toggle', function () { if (menu.open) refresh(); });
    refresh();
  }

  api.card = { slice: slice, sliceAndPreview: sliceAndPreview, cancel: cancel, exportFile: exportFile, previewInGscope: previewInGscope, refresh: refresh,
               exportSlice: exportSlice, exportFromCard: exportFromCard, indicesFor: indicesFor,
               state: function () { return { busy: S.busy, result: S.result, fresh: isFresh() }; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  return api;
});
