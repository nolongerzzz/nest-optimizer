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
 * the planner's own reason in the card.
 *
 * SLICE SETTINGS. The card has the rows G-scope's Slice side has (nozzle,
 * layer, walls, infill and its pattern, support below, brim, interface), its
 * own: they start at the plate's printer profile's values (the template's) and
 * go back to them when another printer is picked or Profile values is pressed.
 * A value changed from the template's is written into a copy of the template's
 * project settings (configOverlay / withOverlay), so the engine, the planner,
 * the G-code's CONFIG_BLOCK and the file's project_settings.config agree; an
 * untouched card slices exactly as the template does. The nozzle is the
 * profile's (another needs its own start / end blocks). The interface rule is
 * one choice with G-scope's (its page keeps it: nsoSupportInterfaceRule), read
 * on the page and handed to the worker. Changing a setting makes the slice
 * stale, as moving a piece does.
 *
 * G-SCOPE IS NOT TOUCHED. This file reads the plate through G-scope's public
 * plateObjects() and hands a finished file to its openFile(); it never reads
 * or writes G-scope's Slice settings rows, and no G-scope file loads the planner.
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

  // ---- the card's Slice settings ---------------------------------------------
  //
  // The rows G-scope's Slice side has, kept by the card itself: { nozzle, layer, walls,
  // density (%), pattern ('grid' | 'zigzag' | 'lines'), angle (deg), brim ('auto' |
  // 'outer' | 'none'), interfaceRule ('column' | null) }. They start at the template's
  // values; a value the owner changed is written into a copy of the template's project
  // settings (configOverlay), so the engine, the planner, the G-code's CONFIG_BLOCK and
  // the file's project_settings.config all read the same number. The nozzle is the
  // profile's: another nozzle needs its own start / end blocks.
  var SETTINGS_DEFAULT = { nozzle: 0.4, layer: 0.2, walls: 2, density: 15, pattern: 'grid', angle: 30, brim: 'auto', interfaceRule: null };
  var PATTERN_TO_CONFIG = { grid: 'grid', zigzag: 'zig-zag', lines: 'line' };
  var PATTERN_FROM_CONFIG = { grid: 'grid', 'zig-zag': 'zigzag', zigzag: 'zigzag', line: 'lines', lines: 'lines' };
  var BRIM_TO_CONFIG = { auto: 'auto_brim', outer: 'outer_only', none: 'no_brim' };

  function cfgRaw(config, key) {
    var v = config ? config[key] : null;
    if (Array.isArray(v)) v = v[0];
    return v == null ? '' : String(v).trim();
  }

  /** The Slice settings a template's project settings hold (the card's starting values). */
  function settingsFromConfig(config) {
    var PL = lazy('nso-print-planner.js', 'NSOPrintPlanner');
    if (!config || !PL) return Object.assign({}, SETTINGS_DEFAULT);
    var eng = PL.engineOptions(config), o = eng.over;
    return {
      nozzle: eng.nozzleMm, layer: o.layerMm, walls: o.wallLoops, density: Math.round(o.sparseDensity * 100),
      pattern: PATTERN_FROM_CONFIG[cfgRaw(config, 'sparse_infill_pattern')] || o.sparsePattern,
      angle: o.supportThresholdDeg, brim: o.brimType, interfaceRule: null
    };
  }

  /** The settings, each clamped to what its row takes. */
  function cleanSettings(s) {
    s = s || {};
    var n = function (v, d, lo, hi) { v = parseFloat(v); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
    var D = SETTINGS_DEFAULT;
    return {
      nozzle: n(s.nozzle, D.nozzle, 0.1, 2),
      layer: Math.round(n(s.layer, D.layer, 0.05, 0.3) * 1000) / 1000,
      walls: Math.round(n(s.walls, D.walls, 1, 10)),
      density: Math.round(n(s.density, D.density, 0, 100)),
      pattern: PATTERN_TO_CONFIG[s.pattern] ? s.pattern : D.pattern,
      angle: Math.round(n(s.angle, D.angle, 1, 89)),
      brim: BRIM_TO_CONFIG[s.brim] ? s.brim : D.brim,
      interfaceRule: s.interfaceRule === 'column' ? 'column' : null
    };
  }

  /**
   * { config key: value } for every setting that differs from the template's own (only those:
   * an untouched card slices exactly as the template does). Throws on a nozzle the profile is not.
   */
  function configOverlay(config, settings) {
    var s = cleanSettings(settings), base = settingsFromConfig(config), out = {};
    if (Math.abs(s.nozzle - base.nozzle) > 1e-6) {
      throw new Error('This printer profile is for a ' + base.nozzle + ' mm nozzle; a ' + s.nozzle + ' mm nozzle needs its own profile.');
    }
    if (Math.abs(s.layer - base.layer) > 1e-6) out.layer_height = String(s.layer);
    if (s.walls !== base.walls) out.wall_loops = String(s.walls);
    if (s.density !== base.density) out.sparse_infill_density = s.density + '%';
    if (s.pattern !== base.pattern) out.sparse_infill_pattern = PATTERN_TO_CONFIG[s.pattern];
    if (s.angle !== base.angle) out.support_threshold_angle = String(s.angle);
    if (s.brim !== base.brim) out.brim_type = BRIM_TO_CONFIG[s.brim];
    return out;
  }

  /** A copy of the template's project settings with the overlay written in (and listed as the process's own changes). */
  function withOverlay(config, over) {
    var keys = Object.keys(over);
    if (!keys.length) return config;
    var out = Object.assign({}, config);
    keys.forEach(function (k) {
      out[k] = Array.isArray(config[k]) ? config[k].map(function () { return over[k]; }) : over[k];
    });
    var diffs = config.different_settings_to_system;
    if (Array.isArray(diffs) && diffs.length) {
      diffs = diffs.slice();
      var had = diffs[0] ? String(diffs[0]).split(';').filter(Boolean) : [];
      keys.forEach(function (k) { if (had.indexOf(k) < 0) had.push(k); });
      diffs[0] = had.sort().join(';');
      out.different_settings_to_system = diffs;
    }
    return out;
  }

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
    /* the column rule's stack the supports card draws ("- interface", m.nsoSupport.stack) is shown, not sliced: the slicer lays it from the part */
    return pieces.filter(function (p) { return !p.stack; }).map(function (p) {
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
   * @param opts     { onStage(name, info), settings }  stages 'slicing' then 'writing'; `settings` are the card's
   *                 Slice settings (null: the template's values, and the interface rule G-scope's page holds)
   * @returns {Promise<{ok, reason, bytes, stats, features, objects}>}  never rejects:
   *   a refusal (the engine's, the planner's) comes back as ok:false with its words.
   */
  function build(objects, assets, opts) {
    opts = opts || {};
    var stage = opts.onStage || function () {};
    var SL = lazy('nso_slicer.js', 'NSO_Slicer'), PL = lazy('nso-print-planner.js', 'NSOPrintPlanner');
    if (!SL) return Promise.resolve({ ok: false, reason: 'The slicer (nso_slicer.js) did not load - check console.' });
    if (!PL) return Promise.resolve({ ok: false, reason: 'The print planner (nso-print-planner.js) did not load - check console.' });
    var settings = opts.settings ? cleanSettings(opts.settings) : null, over = {}, config = assets.config;
    return Promise.resolve().then(function () {
      if (settings) { over = configOverlay(assets.config, settings); config = withOverlay(assets.config, over); }
      var eng = PL.engineOptions(config);
      var o = SL.defaultsFor(eng.nozzleMm, Object.assign({ emitGcode: false }, eng.over));
      /* the planner reads two patterns off a config (grid, else zigzag); the card's own is the slicer's */
      if (settings) o.sparsePattern = settings.pattern;
      /* a sheet of more interface layers than the slicer's default says so (the card's Dense: 3): the slicer types its top 3 layers interface, as G-scope's Slice does */
      var ni = 0;
      objects.forEach(function (ob) { if (ob.interfaceLayers > ni) ni = ob.interfaceLayers; });
      if (ni > 2 && (eng.over || {}).supportInterfaceLayers == null) o.supportInterfaceLayers = ni;
      /* ...and a Dense sheet's own thicker layers (Bambu's 0.275): the supports are cut on their own layer grid, as G-scope's Slice does */
      var sl = 0;
      objects.forEach(function (ob) { if (ob.sheetLayerMm > sl) sl = ob.sheetLayerMm; });
      if (sl > 0 && (eng.over || {}).supportLayerMaxMm == null) o.supportLayerMaxMm = 0.28;
      /* the interface rule (docs/SUPPORT-GATE.md): the card's setting - one choice shared with G-scope's Slice settings, read on the
         page and handed in, since a worker has no window - else the page's own; the same on the printed file as in the preview */
      var rule = settings ? settings.interfaceRule
        : typeof window !== 'undefined' && typeof window.nsoSupportInterfaceRule === 'function' ? window.nsoSupportInterfaceRule() : null;
      if (rule && (eng.over || {}).supportInterfaceRule == null) o.supportInterfaceRule = rule;
      stage('slicing', { objects: objects.length });
      return SL.run(objects, o);
    }).then(function (res) {
      if (!res.ok) return { ok: false, reason: 'Slice refused: ' + res.reason };
      stage('writing', { layers: res.planes.length });
      return PL.toGcode3mf(res, { config: config, printer: assets.printer, configOver: over }).then(function (out) {
        var seen = {};
        out.plan.layers.forEach(function (l) { l.features.forEach(function (f) { seen[f] = 1; }); });
        var st = out.plan.stats;
        return {
          ok: true, reason: '', bytes: out.bytes, features: Object.keys(seen), objects: out.plan.labels.length,
          labels: out.plan.labels.map(function (l) { return { id: l.id, name: l.name, index: l.index }; }),     // the gcode's OBJECT_ID of each object, in the order they were given
          stats: { layers: st.layers, seconds: st.seconds.total, grams: st.grams, filamentMm: st.filamentMm, maxZ: st.maxZ },
          settings: settings, changed: Object.keys(over)                                                         // what was sliced with, and what differs from the profile
        };
      });
    }).catch(function (err) {
      // the planner's refusal (toGcode3mf rejects with plan().reason), or whatever stopped the slice
      return { ok: false, reason: (err && err.message) || String(err) };
    });
  }

  /** The settings in a few words, for the readout: "0.12 mm layers, 3 walls, 20 % grid, support below 30°, brim auto". */
  function settingsWords(st) {
    return st.layer + ' mm layers, ' + st.walls + ' wall' + (st.walls === 1 ? '' : 's') + ', ' + st.density + ' % ' + st.pattern +
      ', support below ' + st.angle + '°, brim ' + st.brim;
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
  function buildForWorker(objects, assets, onStage, settings) {
    return build(objects, assets, { onStage: onStage, settings: settings || null }).then(function (r) {
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
    fileName: fileName, build: build, fmtTime: fmtTime, describe: describe, buildForWorker: buildForWorker,
    SETTINGS_DEFAULT: SETTINGS_DEFAULT, settingsFromConfig: settingsFromConfig, cleanSettings: cleanSettings,
    configOverlay: configOverlay, withOverlay: withOverlay
  };

  // ===========================================================================
  // The card
  // ===========================================================================

  if (typeof document === 'undefined' || !document.getElementById) return api;

  var $ = function (id) { return document.getElementById(id); };
  var S = { busy: false, job: null, result: null, sig: null, setSig: null, pieces: null, profile: null, assets: {}, timer: null, t0: 0, stage: '', hook: null, exporting: false,
            seededFor: null, touched: false };

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
      return { name: o.name, soup: o.positions, sourceId: o.sourceId, support: !!sup, brim: !!(sup && sup.brim), stack: !!(sup && sup.stack), hostSourceId: sup ? sup.hostSourceId : undefined, interfaceLayers: sup ? sup.interfaceLayers : undefined, sheetLayerMm: sup ? sup.sheetLayerMm : undefined,
               nonSolid: !!(pm && typeof root.nsoNonSolid === 'function' && root.nsoNonSolid(pm)),
               settings: m && m.slicerSettings ? Object.assign({}, m.slicerSettings) : null };      // a support's own slicer overrides ride into a 3MF
    });
  }

  // ---- the card's Slice settings -----------------------------------------------

  var SET_IDS = ['slice-set-nozzle', 'slice-set-layer', 'slice-set-walls', 'slice-set-density', 'slice-set-pattern',
                 'slice-set-angle', 'slice-set-brim', 'slice-set-iface'];

  /** The interface rule, one choice shared with G-scope's Slice settings (its page keeps it). */
  function interfaceRule() {
    return typeof root.nsoSupportInterfaceRule === 'function' && root.nsoSupportInterfaceRule() === 'column' ? 'column' : null;
  }

  /** The settings as the card's rows hold them, clamped. */
  function readSettings() {
    var v = function (id) { var el = $(id); return el ? el.value : undefined; };
    return cleanSettings({
      nozzle: v('slice-set-nozzle'), layer: v('slice-set-layer'), walls: v('slice-set-walls'), density: v('slice-set-density'),
      pattern: v('slice-set-pattern'), angle: v('slice-set-angle'), brim: v('slice-set-brim'),
      interfaceRule: $('slice-set-iface') ? v('slice-set-iface') : interfaceRule()
    });
  }

  /** The rows to these values (the interface row shows the shared choice). */
  function showSettings(st) {
    var set = function (id, val) { var el = $(id); if (el && val != null) el.value = String(val); };
    set('slice-set-nozzle', st.nozzle); set('slice-set-layer', st.layer); set('slice-set-walls', st.walls);
    set('slice-set-density', st.density); set('slice-set-pattern', st.pattern); set('slice-set-angle', st.angle);
    set('slice-set-brim', st.brim);
    set('slice-set-iface', interfaceRule() || '');
  }

  /** The rows back to the profile's values: the template's when the card has it, else the profile's usual ones (the same, for both
   *  profiles) until the open card has fetched it (seedFromTemplate). */
  function seedSettings(profile) {
    S.seededFor = profile ? profile.id : null;
    S.touched = false;
    var known = profile && S.assets[profile.id];
    showSettings(known ? settingsFromConfig(known.config) : SETTINGS_DEFAULT);
  }

  /** The open card fetches its profile's template once, and rows nobody has changed take its values. */
  function seedFromTemplate(profile) {
    if (!profile || S.assets[profile.id] || S.touched || S.seeding === profile.id) return;
    S.seeding = profile.id;
    loadAssets(profile).then(function (a) {
      S.seeding = null;
      if (S.seededFor === profile.id && !S.touched && !S.busy) { showSettings(settingsFromConfig(a.config)); refresh(); }
    }, function () { S.seeding = null; /* not served: the rows keep the usual values, and Slice says which file is missing */ });
  }

  function setSettingsOpen(on) {
    var box = $('slice-settings'), b = $('slice-settings-toggle');
    if (box) box.hidden = !on;
    if (b) b.setAttribute('aria-expanded', String(!!on));
  }

  function settingsSignature() { return JSON.stringify(readSettings()); }

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
  function runAway(objects, assets, onStage, settings) {
    var urls = engineUrls();
    var canWorker = urls && typeof Worker === 'function' && typeof Blob === 'function' && root.URL && URL.createObjectURL;
    if (!canWorker) {
      var dead = false;
      return {
        cancel: function () { dead = true; },
        promise: new Promise(function (go) { setTimeout(go, 0); }).then(function () {
          return build(objects, assets, { onStage: onStage, settings: settings || null });
        }).then(function (r) { if (dead) return new Promise(function () {}); return r; })
      };
    }
    var code = 'importScripts(' + urls.map(function (u) { return JSON.stringify(u); }).join(',') + ');\n' +
      'self.onmessage = function (e) {\n' +
      '  var d = e.data;\n' +
      '  self.NSO_Print.buildForWorker(d.objects, d.assets, function (s, info) { self.postMessage({ stage: s, info: info }); }, d.settings)\n' +
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
      w.postMessage({ objects: objects, assets: assets, settings: settings || null }, move);
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
    SET_IDS.concat(['slice-settings-reset']).forEach(function (id) { var el = $(id); if (el) el.disabled = !!on; });
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

  function isFresh() { return !!(S.result && S.result.ok && S.sig === plateSignature() && S.setSig === settingsSignature()); }

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
    // a printer picked since the rows were set starts them again at its profile's values
    if (!S.busy && (p ? p.id : null) !== S.seededFor) seedSettings(p);
    var menu = $('menu-slice'), iface = $('slice-set-iface');
    if (menu && menu.open) seedFromTemplate(p);
    if (iface && !S.busy) iface.value = interfaceRule() || '';           // G-scope may have changed the shared choice
    if (S.result && S.result.ok && !S.busy && !isFresh()) readout(staleWords(), true);
    syncActions();
  }

  function staleWords() {
    return S.sig !== plateSignature() ? 'The plate changed since this slice. Press Slice to slice it again.'
      : 'The Slice settings changed since this slice. Press Slice to slice it again.';
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
    var settings = readSettings();
    S.result = null; S.pieces = null;
    var sig = plateSignature(), setSig = JSON.stringify(settings);
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
      mine.run = runAway(objects, assets, onStage, settings);
      return mine.run.promise;
    }).then(function (r) {
      if (mine.cancelled || !r) return ended({ ok: false, reason: 'Slice cancelled.', cancelled: true });
      S.job = null;
      if (!r.ok) { setBusy(false); S.result = null; readout(r.reason, true); say('Slice: ' + r.reason, true); return ended({ ok: false, reason: r.reason }); }
      S.result = r; S.sig = sig; S.setSig = setSig; S.pieces = pieces; S.profile = profile; S.settings = settings;
      setBusy(false);
      var sup = pieces.filter(function (p) { return p.support && !p.brim && !p.stack; }).length;
      readout(describe(r) + ' - ' + pieces.length + ' object' + (pieces.length === 1 ? '' : 's') + (sup ? ' (' + sup + ' support' + (sup === 1 ? '' : 's') + ')' : '') +
              (r.changed && r.changed.length ? ' - ' + settingsWords(settings) : ''), false);
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
    if (!isFresh()) { refresh(); readout(staleWords(), true); return null; }
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
    var rec = { name: f.name, bytes: f.bytes, pieces: S.pieces, labels: S.result.labels || [], profile: S.profile, settings: S.settings || null };
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
        var run = runAway(pieceObjects(sub, assets.printer.bed), assets, function () {}, rec.settings);
        return run ? run.promise : build(pieceObjects(sub, assets.printer.bed), assets, { settings: rec.settings || null });
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
    bind('slice-settings-toggle', function () { var box = $('slice-settings'); setSettingsOpen(!!(box && box.hidden)); });
    bind('slice-settings-reset', function () { seedSettings(profileFor(plateId())); refresh(); });
    SET_IDS.forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('change', function () {
        if (id !== 'slice-set-iface') S.touched = true;           // the interface is a preference, not a profile value
        if (id === 'slice-set-iface' && typeof root.nsoSetSupportInterfaceRule === 'function') root.nsoSetSupportInterfaceRule(el.value);
        refresh();
      });
    });
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
