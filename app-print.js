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
 * THE FILAMENT (docs/FILAMENTS.md). The printer template's filament is PLA. The card's
 * Filament row picks another (FILAMENTS: its Studio keys, its cooling, its own start
 * G-code), and four rows set what a filament is tuned by - nozzle and first-layer
 * temperature, bed temperature, max flow (the volumetric limit every speed is held to).
 * An empty row is the filament's own value. Temp step + every N mm changes the nozzle
 * temperature by height (the planner's tempSteps): any model is a temperature tower.
 *
 * G-SCOPE IS NOT TOUCHED. This file reads the plate through G-scope's public
 * plateObjects() and hands a finished file to its openFile(); it never reads
 * or writes G-scope's Slice settings rows, and no G-scope file loads the planner.
 *
 * TWO HALVES, ONE FILE
 *   the pure half   profileFor, pieceObjects, build, fileName, readTemplate.
 *                   No DOM. It loads on the page, in the slice worker
 *                   (importScripts) and in Node (tools/print-slice-check.js).
 *   the card        guarded by `document`; binds #slice-card, the Slice section at the foot of the supports card (#menu-supports).
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
   * `frozen` is the planner's start / end for it. A1 mini first; then the P1S plate, from the
   * owner's own P1S project and its slice (mouse1). The picker's "A1 / X1C 256" plate has no
   * profile: P1S G-code is not sent to an A1 (a bed-slinger, another start block).
   */
  var PROFILES = {
    a1mini: {
      id: 'a1mini-0.4', short: 'A1 mini', label: 'Bambu Lab A1 mini, 0.4 nozzle',
      template: 'fixtures/bambu-templates/a1mini-0.4/project_test.3mf',
      frozen: 'fixtures/print-planner/a1mini-0.4/frozen.json'
    },
    /* the P1S plate (its own: an A1's G-code is another printer's): the owner's P1S project, mouse1.3mf (Studio 02.09.01.70, Bambu PLA
       Basic @BBL P1S, 0.20mm Standard @BBL X1C, Textured PEI); its start / end frozen from that project's own slice */
    p1s: {
      id: 'p1s-0.4', short: 'P1S', label: 'Bambu Lab P1S, 0.4 nozzle',
      template: 'fixtures/bambu-templates/p1s-0.4/project_test.3mf',
      frozen: 'fixtures/print-planner/p1s-0.4/frozen.json'
    }
  };
  var SETTINGS_PART = 'Metadata/project_settings.config';

  // The files the slice worker loads, in order: the page's own <script> tags
  // (a ?v= bump is picked up), so each must be one of them.
  var ENGINE = ['nso-cooling-profiles.js', 'nso-3mf.js', 'nso-3mf-read.js', 'nso_paint.js', 'nso_paint_segment.js', 'nso_csg.js', 'nso_slicer.js',
                'nso-print-planner.js', 'nso-gcode3mf-write.js', 'app-print.js'];

  // ---- the card's Slice settings ---------------------------------------------
  //
  // The rows G-scope's Slice side has, kept by the card itself: { nozzle, layer, walls,
  // density (%), pattern ('grid' | 'zigzag' | 'lines' | 'concentric' | 'archimedeanchords' | '3dhoneycomb' | 'gyroid' | 'cubic' |
  // 'adaptivecubic' | 'honeycomb' | 'lightning'), surface ('zigzag' |
  // 'concentric' | 'archimedeanchords' | 'hilbertcurve' | 'octagramspiral': the top, the bottom and the solid infill), angle (deg), brim ('auto' |
  // 'outer' | 'none'), interfaceRule ('column' | null) }. They start at the template's
  // values; a value the owner changed is written into a copy of the template's project
  // settings (configOverlay), so the engine, the planner, the G-code's CONFIG_BLOCK and
  // the file's project_settings.config all read the same number. The nozzle is the
  // profile's: another nozzle needs its own start / end blocks.
  var SETTINGS_DEFAULT = { nozzle: 0.4, layer: 0.2, walls: 2, density: 15, pattern: 'grid', surface: 'zigzag', angle: 30, brim: 'auto', raft: 0, raftGap: 0.1, ifaceAngle: 'studio36', interfaceRule: null,
                           /* the filament: the profile's own; a null row is the filament's value (filamentBase); no temperature steps */
                           filament: 'profile', nozzleTemp: null, firstTemp: null, bedTemp: null, maxFlow: null, tempStep: 0, tempBand: 10,
                           /* TUNING (docs/FILAMENTS.md "Bridges and stringing"): the bridge's speed and flow are the process's (the profile's 50 mm/s
                              and 1); the flow ratio, the retraction and the z-hop are the filament's - a null row is the filament's own */
                           bridgeSpeed: null, bridgeFlow: null, hangSpeed: null, bridgeFirst: null, flowRatio: null, retractLen: null, retractSpeed: null, retractBefore: null, zHop: null,
                           /* the bridges' own nozzle temperature, changed at the printer's park: null is the filament's own (none for the
                              profile's PLA, 215 for CR-TPU on the A1 mini), 0 is none whatever the filament */
                           bridgeTemp: null,
                           /* the layer (Bambu's numbers, the first is 1) from which every layer to the top prints at the bridge temperature: null is
                              only the bridges' own stretches */
                           bridgeTempFrom: null,
                           /* BAMBU'S ADVANCED SUPPORT ROWS (docs/SUPPORT-ADVANCED.md). They start at the printer profile's values (settingsFromConfig);
                              these are Bambu's own defaults, for a card with no profile. NSO's old numbers (top 0.18, first layer solid, a bridge of
                              5 mm not held) are the Print card's built-in saved setting "NSO classic" */
                           supDensity: 90, supExpand: -1, supWalls: -1, supTopZ: 0.2, supBottomZ: 0.2, supBase: 'default', supBaseSpacing: 2.5, supAngle: 0,
                           supIfacePattern: 'default', supIfaceSpacing: 0.5, supExpansion: 0, supXy: 0.35, supZOverXy: false, supFirstGap: 0.2, supBridge: 0, supIndep: true,
                           /* THE WALL GENERATOR (docs/SLICER.md "Arachne"): Classic, or Arachne's variable-width walls with its six levers - Studio's own
                              names and defaults, the four percentages of the nozzle's diameter */
                           wallGen: 'classic', wallAngle: 10, wallFilter: 25, wallTransLen: 100, wallDist: 1, minWall: 85, minFeature: 25,
                           /* TOP / BOTTOM SHELLS (Strength), Studio's four: the layers, and a thickness that adds layers to a count of one or more
                              (0 layers is none: the owner's TPU feet as pure 3D honeycomb - no walls, no shells) */
                           topLayers: 5, topThick: 1, botLayers: 3, botThick: 0,
                           /* THE PROJECT (plateProject): a Studio project's own process changes, { file, keys }, when the plate's parts are its - every
                              key goes into the slice as the project has it (the rows show the ones they have); null: the printer profile alone */
                           project: null };   /* the card's own defaults (the owner's view): Studio 2.9's 3.6 - the owner's mouse1 on the P1S released clean with it */
  var SUP_BASE_TO_CONFIG = { 'default': 'default', rectilinear: 'rectilinear', 'rectilinear-grid': 'rectilinear-grid', hollow: 'hollow' };
  var SUP_IFACE_TO_CONFIG = { 'default': 'auto', rectilinear: 'rectilinear', concentric: 'concentric', rectilinear_interlaced: 'rectilinear_interlaced', grid: 'grid' };
  var IFACE_ANGLES = { profile: 1, bridge: 1, studio36: 1, crosshatch: 1 };   /* nso_slicer.js supportInterfaceAngle: NSO's own, no profile key - a testing ground for interfaces */
  var PATTERN_TO_CONFIG = { grid: 'grid', zigzag: 'zig-zag', lines: 'line', concentric: 'concentric', archimedeanchords: 'archimedeanchords', '3dhoneycomb': '3dhoneycomb', gyroid: 'gyroid', cubic: 'cubic', adaptivecubic: 'adaptivecubic', honeycomb: 'honeycomb', lightning: 'lightning' };
  var PATTERN_FROM_CONFIG = { grid: 'grid', 'zig-zag': 'zigzag', zigzag: 'zigzag', line: 'lines', lines: 'lines', concentric: 'concentric', archimedeanchords: 'archimedeanchords', '3dhoneycomb': '3dhoneycomb', gyroid: 'gyroid', cubic: 'cubic', adaptivecubic: 'adaptivecubic', honeycomb: 'honeycomb', lightning: 'lightning', rectilinear: 'zigzag' };
  /* the surfaces row: the top, the bottom and the solid infill as one choice (Bambu's three rows); zigzag is its Rectilinear and what any
     other pattern of a template (monotonic...) is sliced as */
  var SURFACE_TO_CONFIG = { zigzag: 'zig-zag', concentric: 'concentric', archimedeanchords: 'archimedeanchords', hilbertcurve: 'hilbertcurve', octagramspiral: 'octagramspiral' };
  var SURFACE_KEYS = ['top_surface_pattern', 'bottom_surface_pattern', 'internal_solid_infill_pattern'];
  var PATTERN_LABEL = { zigzag: 'rectilinear', archimedeanchords: 'archimedean chords', hilbertcurve: 'hilbert curve', octagramspiral: 'octagram spiral', '3dhoneycomb': '3D honeycomb', adaptivecubic: 'adaptive cubic' };
  var BRIM_TO_CONFIG = { auto: 'auto_brim', outer: 'outer_only', none: 'no_brim' };

  // ---- filaments ---------------------------------------------------------------
  //
  // 'profile' is the printer template's own filament (PLA). Every other entry is a filament NSO prints with on these printers:
  //   keys     its Bambu Studio filament keys, written over the template's on every filament slot (so the planner, the CONFIG_BLOCK
  //            and project_settings.config all hold them). Only keys the template has are written.
  //   cooling  what it changes of NSO's cooling keys (nso-cooling-profiles.js) - the planner's fans and layer-time slowdown; an object, or
  //            a function of the template's config when the printers differ
  //   start    its filament start G-code, expanded for a bed temperature (the template's is the PLA filament's)
  //   studioId the Studio filament preset the file names, for the printer
  //
  // CR-TPU (Creality, 95A, no RFID, external spool only). The keys are Bambu Studio's Generic TPU (fdm_filament_tpu > Generic TPU
  // @base: 3.2 mm^3/s, 0.4 mm retraction, flow ratio 1, fan 100 %), with the owner's A1 mini temperature tower of 2026-11-13 on top:
  // 235 C nozzle (240 and 235 the cleanest walls; the spool's range is 210-240). The bed is Studio's own for the printer, which is what
  // that tower printed on: 30 C on the A1 mini (Generic TPU @BBL A1M), 35 C on the P1S (Generic TPU).
  // The start G-code is Studio's expansion of the Generic TPU filament's, as its own slice of that tower has it
  // (fixtures/print-planner/<printer>/studio-generic-tpu-tower.gcode.3mf): the fan line only over 30 C, then one line of a space - and
  // on the P1S (Generic TPU @base's text, not the A1M preset's) an empty line after it.
  // On the P1S it prints as the owner's own Studio preset does (Generic TPU with their edits, its slice of 2026-11-18 a squishy cube:
  // fixtures/print-planner/p1s-0.4/studio-owner-cr-tpu-squishy.slim.gcode.3mf): 220 C, first layer too, bed 30 on every plate,
  // 3 mm^3/s, the fan 40 - 65 %, overhangs past 50 % at 70 %. The A1 mini keeps what its prints found (215, first layer 235).
  //
  // ELEGOO PETG (an ELEGOO spool; the owner's Studio slices: fixtures/print-planner/a1mini-0.4/studio-owner-elegoo-petg.slim.gcode.3mf,
  // fixtures/print-planner/p1s-0.4/studio-owner-generic-petg.slim.gcode.3mf). The keys are Bambu Studio's Generic PETG (fdm_filament_pet)
  // as it is, untouched: 255 C, first layer too, 12 mm^3/s, flow ratio 0.95, bed 70 - on the P1S that printed better than the owner's
  // ELEGOO-PETG preset (245 C, flow ratio 1, bed 75: their second P1S PETG print, 2026-11-20). The A1 mini keeps the owner's
  // ELEGOO-PETG-A1mini preset (from Generic PETG @BBL A1M: 245 C, 10 mm^3/s), not yet printed against Generic. Both: the fan off for 3
  // layers, then 40 - 90 % (overhangs past 10 % at 90), no aux fan; the chamber fan at 180 over a 60 C bed, 255 over 80.
  var isA1Mini = function (config) { return /A1 mini/i.test(cfgRaw(config, 'printer_model') + cfgRaw(config, 'printer_settings_id')); };
  var TPU_START = function (bed, config) {
    var fan = bed > 35 ? 'M106 P3 S255' : bed > 30 ? 'M106 P3 S180' : null;
    return ['; filament start gcode'].concat(fan ? [fan] : [], isA1Mini(config) ? [' '] : [' ', '']);
  };
  var PETG_START = function (bed) {
    var fan = bed > 80 ? 'M106 P3 S255' : bed > 60 ? 'M106 P3 S180' : null;
    return ['; filament start gcode'].concat(fan ? [fan] : [], ['', '']);
  };
  var FILAMENTS = {
    profile: { id: 'profile', label: 'Profile (PLA)' },
    'cr-tpu': {
      id: 'cr-tpu', label: 'Creality CR-TPU 95A', external: true,
      keys: {
        filament_type: 'TPU', filament_ids: 'GFU99', filament_vendor: 'Generic',
        nozzle_temperature: '215', nozzle_temperature_initial_layer: '235',   // 215: the owner's prints of 2026-11-14/15 (below)
        nozzle_temperature_range_low: '200', nozzle_temperature_range_high: '250',
        cool_plate_temp: '30', cool_plate_temp_initial_layer: '30', eng_plate_temp: '30', eng_plate_temp_initial_layer: '30',
        hot_plate_temp: '35', hot_plate_temp_initial_layer: '35', textured_plate_temp: '35', textured_plate_temp_initial_layer: '35',
        supertack_plate_temp: '0', supertack_plate_temp_initial_layer: '0',
        filament_max_volumetric_speed: '3.2', filament_flow_ratio: '1', filament_retraction_length: '0.4',
        filament_density: '1.24', temperature_vitrification: '30', filament_adhesiveness_category: '600', filament_cost: '20',
        close_fan_the_first_x_layers: '1', additional_cooling_fan_speed: '70', close_additional_fan_first_x_layers: '1'
      },
      cooling: function (config) {
        var c = { fan_min_speed: '100', fan_max_speed: '100', fan_cooling_layer_time: '100', slow_down_layer_time: '8', slow_down_min_speed: '10' };
        return isA1Mini(config) ? c : Object.assign(c, { fan_min_speed: '40', fan_max_speed: '65', overhang_fan_speed: '70', overhang_fan_threshold: '50%' });   /* the owner's P1S preset */
      },
      /* ITS OWN DIALS (docs/FILAMENTS.md "The filament holds its dials"): the rows that are not a Studio filament key but were found for this
         filament, so picking it is all a job needs. The nozzle prints at 215 (the first layer at 235, for the bed): the owner's A1 mini prints
         of 2026-11-14/15 - the string test clean at 210-220 once the cones were printed one at a time, where 235 strung top to bottom, and the
         tower level's roof flat at a flat 215 once a bridge reached onto its pillars and filled its gap wall to wall. 215 is also the bridge
         temperature that had held the roof at 235, so the filament asks for no bridge temperature of its own: no stop at the park. */
      /* No Hanging wall speed of its own: 10 mm/s on those walls (the window's lip) was tried on the owner's 215 level of 2026-11-15 and
         made the lip no better and the bridges worse, so they print at the bridge's speed, as Studio's do. */
      tune: function () { return {}; },
      /* ITS SLICER RULES: a fill piece under 1 mm is not laid (the slicer's NO CRUMBS) - at the tip of the tower level's roof a 0.03 mm corner
         of solid infill got the whole prime and retraction, and the owner's print of 2026-11-15 hung whole lines off that tip */
      slicer: { shortFillMm: 1 },
      /* what the printer's own Studio preset changes of those keys */
      printerKeys: function (config) {
        var bed30 = { hot_plate_temp: '30', hot_plate_temp_initial_layer: '30', textured_plate_temp: '30', textured_plate_temp_initial_layer: '30' };
        /* the P1S: the owner's own preset (above) */
        return isA1Mini(config) ? bed30 : Object.assign(bed30, { nozzle_temperature: '220', nozzle_temperature_initial_layer: '220', filament_max_volumetric_speed: '3', filament_cost: '25' });
      },
      start: TPU_START,
      studioId: function (config) { return isA1Mini(config) ? 'Generic TPU @BBL A1M' : 'Generic TPU'; }
    },
    'elegoo-petg': {
      id: 'elegoo-petg', label: 'ELEGOO PETG',
      keys: {
        filament_type: 'PETG', filament_ids: 'GFG99', filament_vendor: 'Generic',
        nozzle_temperature: '255', nozzle_temperature_initial_layer: '255', nozzle_temperature_range_low: '220', nozzle_temperature_range_high: '270',
        cool_plate_temp: '0', cool_plate_temp_initial_layer: '0', eng_plate_temp: '70', eng_plate_temp_initial_layer: '70',
        hot_plate_temp: '70', hot_plate_temp_initial_layer: '70', textured_plate_temp: '70', textured_plate_temp_initial_layer: '70',
        supertack_plate_temp: '70', supertack_plate_temp_initial_layer: '70',
        filament_max_volumetric_speed: '12', filament_flow_ratio: '0.95',
        filament_density: '1.27', temperature_vitrification: '60', filament_adhesiveness_category: '300', filament_cost: '30',
        close_fan_the_first_x_layers: '3', additional_cooling_fan_speed: '0', close_additional_fan_first_x_layers: '3'
      },
      cooling: { overhang_fan_threshold: '10%', overhang_fan_speed: '90', fan_min_speed: '40', fan_cooling_layer_time: '30', fan_max_speed: '90',
                 slow_down_layer_time: '12', slow_down_min_speed: '20' },
      /* ITS OWN DIALS: the support's top gap 0.33 mm - two layers of air under the part at 0.2 mm layers. The owner's Supporttest in PETG on the
         A1 mini (Bambu's slice at 0.33, 2026-11-23: every support broke off cleanly or fell off; fixtures/supports/supporttest_petg_a1m*,
         npm run support:gate-petg - NSO at 0.33 is Bambu's interface, two layers of air under all of it). The profile's 0.2 leaves one, and
         PETG welds to itself where PLA lets go. */
      tune: function () { return { supTopZ: 0.33 }; },
      printerKeys: function (config) {
        /* the A1 mini: the owner's ELEGOO-PETG-A1mini preset; the P1S: Generic PETG as it is */
        return isA1Mini(config) ? { nozzle_temperature: '245', nozzle_temperature_initial_layer: '245', filament_max_volumetric_speed: '10' } : {};
      },
      start: PETG_START,
      studioId: function (config) { return isA1Mini(config) ? 'ELEGOO-PETG-A1mini' : 'Generic PETG'; }
    }
  };
  /* the rows that are a filament's: each the config key the planner reads (the bed's is its plate's, bedKeyOf) */
  var BED_KEYS = { 'Cool Plate': 'cool_plate_temp', 'Engineering Plate': 'eng_plate_temp', 'High Temp Plate': 'hot_plate_temp',
                   'Textured PEI Plate': 'textured_plate_temp', 'Supertack Plate': 'supertack_plate_temp' };
  function bedKeyOf(config) { return BED_KEYS[cfgRaw(config, 'curr_bed_type')] || 'textured_plate_temp'; }

  function filamentOf(id) { return Object.prototype.hasOwnProperty.call(FILAMENTS, id) ? FILAMENTS[id] : FILAMENTS.profile; }

  /** The filament's Studio keys for this template: { key: value }, only keys the template holds (and the preset's name). */
  function filamentKeys(config, id) {
    var f = filamentOf(id), out = {};
    if (!f.keys) return out;
    var keys = Object.assign({}, f.keys, f.printerKeys ? f.printerKeys(config) : {});
    Object.keys(keys).forEach(function (k) { if (config[k] !== undefined) out[k] = keys[k]; });
    if (config.filament_settings_id !== undefined) out.filament_settings_id = f.studioId(config);
    return out;
  }

  /** What the four filament rows are when empty: the filament's own nozzle, first-layer and bed temperature and max flow on this template. */
  function filamentBase(config, id) {
    var PL = lazy('nso-print-planner.js', 'NSOPrintPlanner');
    if (!config || !PL) return null;
    var keys = filamentKeys(config, id);
    var S = PL.settingsFrom(Object.keys(keys).length ? withOverlay(config, keys) : config);
    var f = filamentOf(id);
    return Object.assign({ nozzleTemp: S.temp.nozzle, firstTemp: S.temp.nozzleInitial, bedTemp: S.temp.bedInitial, maxFlow: S.filament.maxVolumetric,
             rangeLow: S.temp.rangeLow, rangeHigh: S.temp.rangeHigh,
             flowRatio: S.filament.flow, retractLen: S.retract.length, retractSpeed: S.retract.speed, retractBefore: Math.round(S.retract.beforeWipe * 100), zHop: S.retract.hop,
             /* the bridge's rows: the profile's speed and flow, no bridge temperature - unless the filament brings its own (tune) */
             bridgeSpeed: S.speed.bridge, bridgeFlow: S.filament.bridgeFlow, hangSpeed: null, bridgeTemp: null,
             /* the support's top gap: the profile's, unless the filament brings its own (tune: PETG's 0.33) */
             supTopZ: numOf(cfgRaw(config, 'support_top_z_distance'), SETTINGS_DEFAULT.supTopZ) }, f.tune ? f.tune(config) : {});
  }

  function cfgRaw(config, key) {
    var v = config ? config[key] : null;
    if (Array.isArray(v)) v = v[0];
    return v == null ? '' : String(v).trim();
  }

  function numOf(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
  function pctOf(v, d) { var n = parseFloat(String(v == null ? '' : v).replace('%', '')); return isFinite(n) ? n : d; }
  /** The Slice settings a template's project settings hold (the card's starting values). */
  function settingsFromConfig(config) {
    var PL = lazy('nso-print-planner.js', 'NSOPrintPlanner');
    if (!config || !PL) return Object.assign({}, SETTINGS_DEFAULT);
    var eng = PL.engineOptions(config), o = eng.over, D0 = SETTINGS_DEFAULT;
    return {
      nozzle: eng.nozzleMm, layer: o.layerMm, walls: o.wallLoops, density: Math.round(o.sparseDensity * 100),
      pattern: PATTERN_FROM_CONFIG[cfgRaw(config, 'sparse_infill_pattern')] || o.sparsePattern,
      surface: o.solidPattern && SURFACE_TO_CONFIG[o.solidPattern] ? o.solidPattern : 'zigzag',
      angle: o.supportThresholdDeg, brim: o.brimType, raft: Math.round(o.raftLayers || 0), raftGap: o.raftContactMm != null ? o.raftContactMm : 0.1, ifaceAngle: 'studio36', interfaceRule: null,
      filament: 'profile', nozzleTemp: null, firstTemp: null, bedTemp: null, maxFlow: null, tempStep: 0, tempBand: 10,
      bridgeSpeed: null, bridgeFlow: null, hangSpeed: null, bridgeFirst: null, flowRatio: null, retractLen: null, retractSpeed: null, retractBefore: null, zHop: null, bridgeTemp: null, bridgeTempFrom: null,
      /* the support rows start at the PROFILE's values (the owner's: the Print card's rows are the profile's until changed), read off Bambu's own
         keys; a key the profile does not hold is this slicer's own default */
      supDensity: pctOf(cfgRaw(config, 'raft_first_layer_density'), D0.supDensity), supExpand: numOf(cfgRaw(config, 'raft_first_layer_expansion'), D0.supExpand),
      supWalls: numOf(cfgRaw(config, 'tree_support_wall_count'), D0.supWalls), supTopZ: numOf(cfgRaw(config, 'support_top_z_distance'), D0.supTopZ),
      supBottomZ: numOf(cfgRaw(config, 'support_bottom_z_distance'), D0.supBottomZ),
      supBase: SUP_BASE_TO_CONFIG[cfgRaw(config, 'support_base_pattern')] ? cfgRaw(config, 'support_base_pattern') : D0.supBase,
      supBaseSpacing: numOf(cfgRaw(config, 'support_base_pattern_spacing'), D0.supBaseSpacing),
      supAngle: o.supportAngleDeg != null ? o.supportAngleDeg : D0.supAngle,
      supIfacePattern: (function (v) { return v === 'auto' ? 'default' : SUP_IFACE_TO_CONFIG[v] ? v : D0.supIfacePattern; })(cfgRaw(config, 'support_interface_pattern')),
      supIfaceSpacing: o.supportInterfaceSpacingMm != null ? o.supportInterfaceSpacingMm : D0.supIfaceSpacing,
      supExpansion: numOf(cfgRaw(config, 'support_expansion'), D0.supExpansion), supXy: numOf(cfgRaw(config, 'support_object_xy_distance'), D0.supXy),
      supZOverXy: cfgRaw(config, 'top_z_overrides_xy_distance') === '1', supFirstGap: numOf(cfgRaw(config, 'support_object_first_layer_gap'), D0.supFirstGap),
      supBridge: numOf(cfgRaw(config, 'max_bridge_length'), D0.supBridge), supIndep: cfgRaw(config, 'independent_support_layer_height') !== '0',
      /* the wall generator and Arachne's levers, the profile's (both real profiles: classic, Studio's defaults for the rest) */
      wallGen: cfgRaw(config, 'wall_generator') === 'arachne' ? 'arachne' : 'classic',
      wallAngle: numOf(cfgRaw(config, 'wall_transition_angle'), D0.wallAngle), wallFilter: pctOf(cfgRaw(config, 'wall_transition_filter_deviation'), D0.wallFilter),
      wallTransLen: pctOf(cfgRaw(config, 'wall_transition_length'), D0.wallTransLen), wallDist: numOf(cfgRaw(config, 'wall_distribution_count'), D0.wallDist),
      minWall: pctOf(cfgRaw(config, 'min_bead_width'), D0.minWall), minFeature: pctOf(cfgRaw(config, 'min_feature_size'), D0.minFeature),
      topLayers: o.topShellLayers, topThick: o.topShellThicknessMm, botLayers: o.bottomShellLayers, botThick: o.bottomShellThicknessMm,
      project: null
    };
  }

  /** A project's changes as the settings carry them: { file, keys: { key: 'value' } } (each value a string, a list's first), or null. */
  function projectOf(pj) {
    if (!pj || !pj.keys || typeof pj.keys !== 'object') return null;
    var keys = {};
    Object.keys(pj.keys).forEach(function (k) { var v = pj.keys[k]; if (Array.isArray(v)) v = v[0]; if (v != null) keys[k] = String(v); });
    return { file: String(pj.file || ''), keys: keys };
  }

  /* KEYS A PROJECT NEVER HANDS OVER: what names the presets, and what is the printer's or the plate's own - the card's printer profile keeps
     those (its start and end G-code, its bed). Only the process's changes are taken (different_settings_to_system, first entry). */
  var PROJECT_SKIP = /^(print_settings_id|inherits|compatible_printers|compatible_printers_condition|from|name|version|printer_|machine_|bed_|curr_bed_type|first_layer_print_sequence|other_layers_print_sequence)/;

  /**
   * The Studio project the plate's parts came from (the file their pieces were opened from, when the import kept its project settings -
   * app-core.js import3MF), and what the Print card takes from it: { file, keys, preset, printer, filament, objects } or null when the
   * parts are not all one project's.
   *   keys      the process settings the project changed from its system preset (different_settings_to_system, first entry): each as
   *             the project has it - what Studio sliced it with
   *   preset    its process preset (print_settings_id); printer its printer_model; filament its filament_settings_id
   *   objects   the objects with settings of their own (Studio's Objects tab), [{ name, keys }]: not taken - this slicer slices a plate
   *             with one set of settings
   */
  function plateProject() {
    var reg = root && root.nsoProjects;
    if (!reg || typeof state === 'undefined' || !state || !state.placed) return null;
    var files = [];
    state.placed.forEach(function (p) {
      var m = p && (state.models || []).find(function (x) { return x && x.id === p.sourceId; });
      if (!m || m.nsoSupport) return;
      var f = m.sourceFile || null;
      if (files.indexOf(f) < 0) files.push(f);
    });
    if (files.length !== 1 || !files[0] || !reg[files[0]]) return null;
    var cfg = reg[files[0]].config || {}, diffs = cfg.different_settings_to_system;
    var list = Array.isArray(diffs) && diffs[0] ? String(diffs[0]).split(';').filter(Boolean) : [];
    var keys = {};
    list.forEach(function (k) { if (!PROJECT_SKIP.test(k) && cfg[k] != null) keys[k] = Array.isArray(cfg[k]) ? String(cfg[k][0]) : String(cfg[k]); });
    return { file: files[0], keys: keys, preset: cfgRaw(cfg, 'print_settings_id'), printer: cfgRaw(cfg, 'printer_model'), filament: cfgRaw(cfg, 'filament_settings_id'),
             objects: (reg[files[0]].objects || []).map(function (o) { return { name: o.name, keys: Object.keys(o.keys) }; }) };
  }

  /** The settings, each clamped to what its row takes. */
  function cleanSettings(s) {
    s = s || {};
    var n = function (v, d, lo, hi) { v = parseFloat(v); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
    /* a filament row: a number in its range, or null (empty: the filament's own value) */
    var opt = function (v, lo, hi, dp) { v = parseFloat(v); if (!isFinite(v)) return null; var k = Math.pow(10, dp); return Math.round(Math.max(lo, Math.min(hi, v)) * k) / k; };
    var D = SETTINGS_DEFAULT, r2 = function (v) { return Math.round(v * 100) / 100; };
    return {
      nozzle: n(s.nozzle, D.nozzle, 0.1, 2),
      layer: Math.round(n(s.layer, D.layer, 0.05, 0.3) * 1000) / 1000,
      walls: Math.round(n(s.walls, D.walls, 0, 10)),   /* 0: no walls, the infill to the outline (Studio's wall_loops = 0) */
      density: Math.round(n(s.density, D.density, 0, 100)),
      pattern: s.pattern === 'rectilinear' ? 'zigzag' : PATTERN_TO_CONFIG[s.pattern] ? s.pattern : D.pattern,   /* rectilinear: Bambu's name for zigzag */
      surface: s.surface === 'rectilinear' ? 'zigzag' : SURFACE_TO_CONFIG[s.surface] ? s.surface : D.surface,
      angle: Math.round(n(s.angle, D.angle, 1, 89)),
      brim: BRIM_TO_CONFIG[s.brim] ? s.brim : D.brim,
      raft: Math.round(n(s.raft, D.raft, 0, 30)),
      raftGap: Math.round(n(s.raftGap, D.raftGap, 0, 1) * 100) / 100,
      ifaceAngle: IFACE_ANGLES[s.ifaceAngle] ? s.ifaceAngle : D.ifaceAngle,
      interfaceRule: s.interfaceRule === 'column' ? 'column' : null,
      filament: filamentOf(s.filament).id,
      nozzleTemp: opt(s.nozzleTemp, 170, 300, 0), firstTemp: opt(s.firstTemp, 170, 300, 0), bedTemp: opt(s.bedTemp, 0, 110, 0),
      maxFlow: opt(s.maxFlow, 0.5, 40, 2),
      tempStep: Math.round(n(s.tempStep, D.tempStep, -25, 25)), tempBand: Math.round(n(s.tempBand, D.tempBand, 1, 100) * 10) / 10,
      bridgeSpeed: opt(s.bridgeSpeed, 1, 300, 1), bridgeFlow: opt(s.bridgeFlow, 0.5, 1.5, 2), hangSpeed: opt(s.hangSpeed, 1, 300, 1), bridgeFirst: s.bridgeFirst === true || s.bridgeFirst === 'on' ? true : s.bridgeFirst === false || s.bridgeFirst === 'off' ? false : null,
      flowRatio: opt(s.flowRatio, 0.8, 1.2, 3), retractLen: opt(s.retractLen, 0, 3, 2), retractSpeed: opt(s.retractSpeed, 5, 80, 0), retractBefore: opt(s.retractBefore, 0, 100, 0), zHop: opt(s.zHop, 0, 2, 2),
      bridgeTemp: (function (v) { v = parseFloat(v); return !isFinite(v) ? null : v <= 0 ? 0 : Math.round(Math.max(170, Math.min(300, v))); })(s.bridgeTemp),   /* 0: none */
      bridgeTempFrom: (function (v) { v = parseFloat(v); return !isFinite(v) || v < 2 ? null : Math.round(Math.min(100000, v)); })(s.bridgeTempFrom),   /* under 2: none */
      supDensity: Math.round(n(s.supDensity, D.supDensity, 10, 100)),
      supExpand: (function (v) { return v < 0 ? -1 : r2(v); })(n(s.supExpand, D.supExpand, -1, 10)),
      supWalls: Math.round(n(s.supWalls, D.supWalls, -1, 5)),
      supTopZ: r2(n(s.supTopZ, D.supTopZ, 0, 2)), supBottomZ: r2(n(s.supBottomZ, D.supBottomZ, 0, 2)),
      supBase: SUP_BASE_TO_CONFIG[s.supBase] ? s.supBase : D.supBase,
      supBaseSpacing: r2(n(s.supBaseSpacing, D.supBaseSpacing, 0.5, 20)),
      supAngle: Math.round(n(s.supAngle, D.supAngle, 0, 180)),
      supIfacePattern: s.supIfacePattern === 'auto' ? 'default' : SUP_IFACE_TO_CONFIG[s.supIfacePattern] ? s.supIfacePattern : D.supIfacePattern,
      supIfaceSpacing: r2(n(s.supIfaceSpacing, D.supIfaceSpacing, 0, 5)),
      supExpansion: r2(n(s.supExpansion, D.supExpansion, -2, 5)),
      supXy: r2(n(s.supXy, D.supXy, 0, 3)),
      supZOverXy: s.supZOverXy === true || s.supZOverXy === 'true' || s.supZOverXy === '1' || s.supZOverXy === 1,
      supFirstGap: r2(n(s.supFirstGap, D.supFirstGap, 0, 3)),
      supBridge: r2(n(s.supBridge, D.supBridge, 0, 100)),
      supIndep: !(s.supIndep === false || s.supIndep === 'false' || s.supIndep === '0' || s.supIndep === 0),
      wallGen: s.wallGen === 'arachne' ? 'arachne' : 'classic',
      wallAngle: Math.round(n(s.wallAngle, D.wallAngle, 1, 59)),
      wallFilter: Math.round(n(s.wallFilter, D.wallFilter, 0, 100)),
      wallTransLen: Math.round(n(s.wallTransLen, D.wallTransLen, 1, 500)),
      wallDist: Math.round(n(s.wallDist, D.wallDist, 1, 10)),
      minWall: Math.round(n(s.minWall, D.minWall, 5, 100)),
      minFeature: Math.round(n(s.minFeature, D.minFeature, 0, 100)),
      topLayers: Math.round(n(s.topLayers, D.topLayers, 0, 100)), topThick: r2(n(s.topThick, D.topThick, 0, 20)),
      botLayers: Math.round(n(s.botLayers, D.botLayers, 0, 100)), botThick: r2(n(s.botThick, D.botThick, 0, 20)),
      project: projectOf(s.project)
    };
  }

  /**
   * { config key: value } for every setting that differs from the template's own (only those:
   * an untouched card slices exactly as the template does). Throws on a nozzle the profile is not.
   */
  function configOverlay(config, settings) {
    /* A PROJECT'S CHANGES FIRST: every key it changed, as it has it - the rows then start at the project's values, and a row moved off
       one writes its own over it */
    var s = cleanSettings(settings), proj = s.project ? s.project.keys : null, out = {};
    if (proj) Object.keys(proj).forEach(function (k) { if (cfgRaw(config, k) !== proj[k].trim()) out[k] = proj[k]; });
    var base = settingsFromConfig(proj && Object.keys(out).length ? withOverlay(config, out) : config);
    if (Math.abs(s.nozzle - base.nozzle) > 1e-6) {
      throw new Error('This printer profile is for a ' + base.nozzle + ' mm nozzle; a ' + s.nozzle + ' mm nozzle needs its own profile.');
    }
    if (Math.abs(s.layer - base.layer) > 1e-6) out.layer_height = String(s.layer);
    if (s.walls !== base.walls) out.wall_loops = String(s.walls);
    if (s.density !== base.density) out.sparse_infill_density = s.density + '%';
    if (s.pattern !== base.pattern) {
      out.sparse_infill_pattern = PATTERN_TO_CONFIG[s.pattern];
    }
    if (s.surface !== base.surface) SURFACE_KEYS.forEach(function (k) { out[k] = SURFACE_TO_CONFIG[s.surface]; });
    if (s.angle !== base.angle) out.support_threshold_angle = String(s.angle);
    if (s.brim !== base.brim) out.brim_type = BRIM_TO_CONFIG[s.brim];
    if (s.raft !== base.raft) out.raft_layers = String(s.raft);
    if (Math.abs(s.raftGap - base.raftGap) > 1e-6) out.raft_contact_distance = String(s.raftGap);
    /* the support rows, by Bambu's keys: only one that differs from what the card started at */
    if (s.supDensity !== base.supDensity) out.raft_first_layer_density = s.supDensity + '%';
    if (s.supExpand !== base.supExpand) out.raft_first_layer_expansion = String(s.supExpand);
    if (s.supWalls !== base.supWalls) out.tree_support_wall_count = String(s.supWalls);
    if (Math.abs(s.supTopZ - base.supTopZ) > 1e-6) out.support_top_z_distance = String(s.supTopZ);
    if (Math.abs(s.supBottomZ - base.supBottomZ) > 1e-6) out.support_bottom_z_distance = String(s.supBottomZ);
    if (s.supBase !== base.supBase) out.support_base_pattern = SUP_BASE_TO_CONFIG[s.supBase];
    if (Math.abs(s.supBaseSpacing - base.supBaseSpacing) > 1e-6) out.support_base_pattern_spacing = String(s.supBaseSpacing);
    if (s.supAngle !== base.supAngle) out.support_angle = String(s.supAngle);
    if (s.supIfacePattern !== base.supIfacePattern) out.support_interface_pattern = SUP_IFACE_TO_CONFIG[s.supIfacePattern];
    if (Math.abs(s.supIfaceSpacing - base.supIfaceSpacing) > 1e-6) out.support_interface_spacing = String(s.supIfaceSpacing);
    if (Math.abs(s.supExpansion - base.supExpansion) > 1e-6) out.support_expansion = String(s.supExpansion);
    if (Math.abs(s.supXy - base.supXy) > 1e-6) out.support_object_xy_distance = String(s.supXy);
    if (s.supZOverXy !== base.supZOverXy) out.top_z_overrides_xy_distance = s.supZOverXy ? '1' : '0';
    if (Math.abs(s.supFirstGap - base.supFirstGap) > 1e-6) out.support_object_first_layer_gap = String(s.supFirstGap);
    if (Math.abs(s.supBridge - base.supBridge) > 1e-6) out.max_bridge_length = String(s.supBridge);
    if (s.supIndep !== base.supIndep) out.independent_support_layer_height = s.supIndep ? '1' : '0';
    /* the wall generator and Arachne's levers, by Studio's keys (a percentage of the nozzle, as Studio writes it) */
    if (s.wallGen !== base.wallGen) out.wall_generator = s.wallGen;
    if (s.wallAngle !== base.wallAngle) out.wall_transition_angle = String(s.wallAngle);
    if (s.wallFilter !== base.wallFilter) out.wall_transition_filter_deviation = s.wallFilter + '%';
    if (s.wallTransLen !== base.wallTransLen) out.wall_transition_length = s.wallTransLen + '%';
    if (s.wallDist !== base.wallDist) out.wall_distribution_count = String(s.wallDist);
    if (s.minWall !== base.minWall) out.min_bead_width = s.minWall + '%';
    if (s.minFeature !== base.minFeature) out.min_feature_size = s.minFeature + '%';
    /* the shells, by Studio's keys */
    if (s.topLayers !== base.topLayers) out.top_shell_layers = String(s.topLayers);
    if (Math.abs(s.topThick - base.topThick) > 1e-6) out.top_shell_thickness = String(s.topThick);
    if (s.botLayers !== base.botLayers) out.bottom_shell_layers = String(s.botLayers);
    if (Math.abs(s.botThick - base.botThick) > 1e-6) out.bottom_shell_thickness = String(s.botThick);
    /* the filament: its own keys, then the rows that differ from its own values */
    var fk = filamentKeys(config, s.filament);
    Object.keys(fk).forEach(function (k) { if (cfgRaw(config, k) !== fk[k]) out[k] = fk[k]; });
    var fb = filamentBase(config, s.filament);
    if (fb) {
      var bk = bedKeyOf(config);
      if (s.nozzleTemp != null && s.nozzleTemp !== fb.nozzleTemp) out.nozzle_temperature = String(s.nozzleTemp);
      if (s.firstTemp != null && s.firstTemp !== fb.firstTemp) out.nozzle_temperature_initial_layer = String(s.firstTemp);
      if (s.bedTemp != null && s.bedTemp !== fb.bedTemp) { out[bk] = String(s.bedTemp); out[bk + '_initial_layer'] = String(s.bedTemp); }
      if (s.maxFlow != null && Math.abs(s.maxFlow - fb.maxFlow) > 1e-6) out.filament_max_volumetric_speed = String(s.maxFlow);
      /* the filament's own flow ratio, retraction and z-hop: Studio's filament keys (its "setting overrides": the printer's keys are left as
         they are, as Studio leaves them - its TPU slice retracts 0.4 with retraction_length = 0.8 in the file) */
      if (s.flowRatio != null && Math.abs(s.flowRatio - fb.flowRatio) > 1e-6) out.filament_flow_ratio = String(s.flowRatio);
      if (s.retractLen != null && Math.abs(s.retractLen - fb.retractLen) > 1e-6) out.filament_retraction_length = String(s.retractLen);
      if (s.retractBefore != null && s.retractBefore !== fb.retractBefore) out.filament_retract_before_wipe = s.retractBefore + '%';
      if (s.retractSpeed != null && s.retractSpeed !== fb.retractSpeed) { out.filament_retraction_speed = String(s.retractSpeed); out.filament_deretraction_speed = String(s.retractSpeed); }
      if (s.zHop != null && Math.abs(s.zHop - fb.zHop) > 1e-6) out.filament_z_hop = String(s.zHop);
      /* the bridge's speed and flow: the row's, else the filament's own; written where that is not the template's */
      var bSpeed = s.bridgeSpeed != null ? s.bridgeSpeed : fb.bridgeSpeed, bFlow = s.bridgeFlow != null ? s.bridgeFlow : fb.bridgeFlow;
      if (Math.abs(bSpeed - numOf(cfgRaw(config, 'bridge_speed'), bSpeed)) > 1e-6) out.bridge_speed = String(bSpeed);
      if (Math.abs(bFlow - numOf(cfgRaw(config, 'bridge_flow'), bFlow)) > 1e-6) out.bridge_flow = String(bFlow);
    }
    return out;
  }

  /** The keys of an overlay that are a filament's (they are listed under the filament in different_settings_to_system, not the process). */
  var FILAMENT_KEY = /^(filament_|nozzle_temperature|temperature_vitrification|close_fan_|additional_cooling_|close_additional_|(cool|eng|hot|textured|supertack)_plate_temp)/;

  /** The bridge temperature a slice is made with: the row's (0: none), else the filament's own on this printer; null for none. */
  /** Whether a layer's open-air bridges go before its walls: the row's (bridgeFirst true / false), else the filament's own, else no. */
  function bridgeFirstOf(config, settings) {
    if (!settings) return false;
    if (settings.bridgeFirst === true || settings.bridgeFirst === false) return settings.bridgeFirst;
    var fb = filamentBase(config, settings.filament);
    return !!(fb && fb.bridgeFirst);
  }
  /** The speed a wall hanging over open air prints at, for the planner: the row's, else the filament's own, else none (the bridge's speed). */
  function hangSpeedOf(config, settings) {
    if (!settings) return null;
    if (settings.hangSpeed != null) return settings.hangSpeed > 0 ? settings.hangSpeed : null;
    var fb = filamentBase(config, settings.filament);
    return fb && fb.hangSpeed ? fb.hangSpeed : null;
  }
  function bridgeTempOf(config, settings) {
    if (!settings) return null;
    if (settings.bridgeTemp != null) return settings.bridgeTemp > 0 ? settings.bridgeTemp : null;
    var fb = filamentBase(config, settings.filament);
    return fb && fb.bridgeTemp ? fb.bridgeTemp : null;
  }

  /** What the planner is told beside the config: the filament's cooling (undefined: NSO's default profile), its start G-code, the temperature steps. */
  function plannerExtras(config, settings) {
    if (!settings) return { cooling: undefined, filamentStart: undefined, tempSteps: undefined, bridgeTemp: undefined, bridgeTempFrom: undefined, hangSpeed: undefined };
    var f = filamentOf(settings.filament), PL = lazy('nso-print-planner.js', 'NSOPrintPlanner'), CP = lazy('nso-cooling-profiles.js', 'NSOCoolingProfiles');
    var S = PL.settingsFrom(config);
    return {
      cooling: f.cooling && CP ? Object.assign({}, CP.resolveValues(CP.DEFAULT_PROFILE_ID), typeof f.cooling === 'function' ? f.cooling(config) : f.cooling) : undefined,
      filamentStart: f.start ? f.start(Math.max(S.temp.bed, S.temp.bedInitial), config) : undefined,
      tempSteps: settings.tempStep ? { stepC: settings.tempStep, bandMm: settings.tempBand } : undefined,
      bridgeTemp: bridgeTempOf(config, settings) || undefined,
      bridgeTempFrom: bridgeTempOf(config, settings) && settings.bridgeTempFrom ? settings.bridgeTempFrom : undefined,
      hangSpeed: hangSpeedOf(config, settings) || undefined
    };
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
      var add = function (slot, list) {
        if (!list.length) return;
        var had = diffs[slot] ? String(diffs[slot]).split(';').filter(Boolean) : [];
        list.forEach(function (k) { if (had.indexOf(k) < 0) had.push(k); });
        diffs[slot] = had.sort().join(';');
      };
      /* [process, each filament ..., printer]: a filament's key is its filament's own change, any other the process's */
      var fil = keys.filter(function (k) { return FILAMENT_KEY.test(k) && k !== 'filament_settings_id'; });
      add(0, keys.filter(function (k) { return !FILAMENT_KEY.test(k); }));
      for (var fi = 1; fi < diffs.length - 1; fi++) add(fi, fil);
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
               sheetLayerMm: p.support ? p.sheetLayerMm : undefined,
               paint: p.support ? null : (p.paint || null) };            /* its painted colours (nso_paint.js): the layers' filament slots */
    });
  }

  /**
   * "Name - A1 mini.gcode.3mf". The name is the file the pieces were opened from (a piece's `file`, else its own name - an STL's piece is
   * named after its file already): a 3MF's objects carry whatever its designer called them (the owner's string test came out as
   * "IngeniousLeelo-Habbi"), and the file's name is the one its owner knows. Pieces of more than one file: the piece count.
   */
  function fileName(pieces, profile) {
    var parts = pieces.filter(function (p) { return !p.support; });
    var from = parts.map(function (p) { return String(p.file || p.name || ''); }).filter(function (n, i, a) { return a.indexOf(n) === i; });
    var base = from.length === 1 && from[0] ? from[0] : (parts.length || pieces.length) + ' pieces';
    base = String(base).replace(/(\.gcode)?\.(stl|3mf)$/i, '').replace(/[\/\\?%*:|"<>]/g, '').replace(/\s+/g, ' ').trim() || 'plate';
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
  /**
   * The slicer's options for a slice of `objects` (each may carry interfaceLayers / sheetLayerMm) on the printer `assets`, with the
   * card's Slice `settings` (cleaned; null: the template's values and the page's interface rule): { o, config, over }. The ONE place
   * they are made - build() slices with them, and the supports card draws the supports it builds from a slice with them
   * (sliceOptionsForPlate), so the plate shows what the slice prints.
   */
  function slicerOptions(SL, PL, objects, assets, settings) {
    var over = {}, config = assets.config;
    if (settings) over = configOverlay(assets.config, settings);
    if (Object.keys(over).length) config = withOverlay(assets.config, over);
    var eng = PL.engineOptions(config);
    var o = SL.defaultsFor(eng.nozzleMm, Object.assign({ emitGcode: false }, eng.over));
    /* the planner reads two patterns off a config (grid, else zigzag); the card's own is the slicer's */
    if (settings) o.sparsePattern = settings.pattern;
    if (settings && bridgeFirstOf(assets.config, settings)) o.bridgeFirst = true;   /* the filament's choice, or the row's */
    if (settings && filamentOf(settings.filament).slicer) Object.assign(o, filamentOf(settings.filament).slicer);   /* the filament's own slicer rules */
    /* the supports' own count of top interface layers (the card's 0 - 3) is the slicer's, as G-scope's Slice does */
    var ni = -1;
    objects.forEach(function (ob) { if (ob.interfaceLayers != null && ob.interfaceLayers > ni) ni = ob.interfaceLayers; });
    if (ni >= 0 && (eng.over || {}).supportInterfaceLayers == null) o.supportInterfaceLayers = ni;
    /* ...and a Dense sheet's own thicker layers (Bambu's 0.275): the supports are cut on their own layer grid, as G-scope's Slice does */
    var sl = 0;
    objects.forEach(function (ob) { if (ob.sheetLayerMm > sl) sl = ob.sheetLayerMm; });
    if (sl > 0 && (eng.over || {}).supportLayerMaxMm == null) o.supportLayerMaxMm = 0.28;
    /* the interface rule (docs/SUPPORT-GATE.md): the card's setting - one choice shared with G-scope's Slice settings, read on the
       page and handed in, since a worker has no window - else the page's own; the same on the printed file as in the preview */
    var rule = settings ? settings.interfaceRule
      : typeof window !== 'undefined' && typeof window.nsoSupportInterfaceRule === 'function' ? window.nsoSupportInterfaceRule() : null;
    if (rule && (eng.over || {}).supportInterfaceRule == null) o.supportInterfaceRule = rule;
    /* the interface angle (supportInterfaceAngle): the profile's (Bambu's rule), square to the bridge, Studio 02.09's 3.6, or the old crosshatch - the card's choice */
    o.supportInterfaceAngle = (settings && settings.ifaceAngle) || SETTINGS_DEFAULT.ifaceAngle;   /* no settings: the card's default (3.6) - the same file either way */
    /* BAMBU'S ADVANCED SUPPORT ROWS: the card's values are the slicer's. A row at its default hands the slicer what it used before (the bottom
       distance and the first layer gap are handed over only when changed: at their defaults the support's own mesh keeps them). */
    /* ...and with no settings at all (G-scope's view of a loose piece, a test): the profile's own values, which is where the rows start -
       the same file as the card's untouched rows make (docs/PRINT-CARD.md "Starting values") */
    if (!settings && typeof settingsFromConfig === 'function') settings = Object.assign(settingsFromConfig(assets.config), { __profile: true });
    if (settings) {
      var cs = cleanSettings(settings), D = SETTINGS_DEFAULT;
      o.supportFirstLayerDensity = cs.supDensity / 100;
      o.supportWallLoops = cs.supWalls;
      o.supportGapMm = cs.supTopZ;
      if (Math.abs(cs.supBottomZ - 0.2) > 1e-6) o.supportBottomGapMm = cs.supBottomZ;                 /* 0.2: the foot as Generate carves it */
      o.supportBasePattern = cs.supBase;
      o.supportBaseSpacingMm = cs.supBaseSpacing;
      o.supportInterfacePattern = cs.supIfacePattern;
      o.supportExpansionMm = cs.supExpansion;
      o.supportXyMm = cs.supXy;
      o.supportZOverridesXy = cs.supZOverXy;
      if (Math.abs(cs.supFirstGap - 0.2) > 1e-6) o.supportFirstLayerGapMm = cs.supFirstGap;         /* 0.2: the pad as it is drawn */
      if (!cs.supIndep) o.supportLayerMaxMm = 0;
    }
    return { o: o, config: config, over: over };
  }

  /**
   * How the Slice card would slice the plate now - its printer's profile and its Slice settings - for objects like `objects` (their
   * interfaceLayers / sheetLayerMm): a Promise of { o: the slicer's options, dx, dy: the shift pieceObjects() puts every piece through
   * (the plate's centre to the bed's) }, or null when no printer is picked or the engines are not loaded. The supports card's drawing of
   * the supports it builds is a slice with these, at the bed's coordinates (the slicer's layers can differ with where a piece stands).
   */
  function sliceOptionsForPlate(objects) {
    var profile = profileFor(plateId());
    var SL = lazy('nso_slicer.js', 'NSO_Slicer'), PL = lazy('nso-print-planner.js', 'NSOPrintPlanner');
    if (!profile || !SL || !PL) return Promise.resolve(null);
    var settings = readSettings();
    return loadAssets(profile).then(function (assets) {
      var bed = assets.printer.bed;
      return { o: slicerOptions(SL, PL, objects || [], assets, settings).o, dx: bed.x / 2, dy: bed.y / 2 };
    });
  }

  /**
   * MULTI-COLOUR, STEP 2 (docs/MULTICOLOR.md): each layer of a painted piece prints with the filament its paint has at the layer's
   * mid-height - the plane Studio slices at, and where its slice of the owner's 3-colour pyramid changed filament (8.6, 15.4, 21.6: the first
   * layer whose middle is past each band's edge). The layer's slot (0-based) goes on the slicer's layer (L.slot) for the planner; a piece with
   * no paint prints with the first filament. A layer whose outline crosses two colours (a logo on a face, two parts of different
   * filaments) is not split between them yet: refused, with where. Also puts each object's footprint on it (bbox, the plate's frame), for
   * the filament change's travel path. Returns null, or the refusal.
   */
  function layerSlots(objects, res) {
    var P = lazy('nso_paint.js', 'NSO_Paint');
    if (!res.objects || res.objects.length !== objects.length) return null;
    for (var k = 0; k < objects.length; k++) {
      var ob = objects[k], ro = res.objects[k], soup = ob.soup;
      if (soup && soup.length) {
        var b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
        for (var i = 0; i < soup.length; i += 3) {
          if (soup[i] < b.x0) b.x0 = soup[i]; if (soup[i] > b.x1) b.x1 = soup[i];
          if (soup[i + 1] < b.y0) b.y0 = soup[i + 1]; if (soup[i + 1] > b.y1) b.y1 = soup[i + 1];
        }
        ro.bbox = b;
      }
      if (!ob.paint || !P || !P.fits(ob.paint, soup.length)) continue;
      if (ro.segmented) continue;                      /* the slicer split it by colour: each path carries its slot */
      /* the leaves, by height: each its z range, filament and the triangle to cut */
      var leaves = [];
      P.eachLeaf(soup, ob.paint, function (p, q, r, f) {
        leaves.push({ lo: Math.min(p[2], q[2], r[2]), hi: Math.max(p[2], q[2], r[2]), f: f, t: [p, q, r] });
      });
      leaves.sort(function (a, b2) { return a.lo - b2.lo; });
      var maxF = 0;
      for (var li = 0; li < res.planes.length; li++) {
        var L = ro.layers[li];
        if (!L || !L.paths || !L.paths.length) continue;
        var pl = res.planes[li], h = L.h || pl.h, zc = pl.printZ - h / 2;
        var len = {};
        for (var j = 0; j < leaves.length && leaves[j].lo < zc; j++) {
          var lf = leaves[j];
          if (lf.hi <= zc) continue;
          var t = lf.t, cut = [];
          for (var e = 0; e < 3; e++) {
            var A = t[e], B = t[(e + 1) % 3];
            if ((A[2] - zc) * (B[2] - zc) < 0) { var u = (zc - A[2]) / (B[2] - A[2]); cut.push([A[0] + u * (B[0] - A[0]), A[1] + u * (B[1] - A[1])]); }
          }
          if (cut.length === 2) len[lf.f] = (len[lf.f] || 0) + Math.hypot(cut[1][0] - cut[0][0], cut[1][1] - cut[0][1]);
        }
        var fs = Object.keys(len).map(Number), tot = 0, best = 0;
        fs.forEach(function (f) { tot += len[f]; if (!best || len[f] > len[best]) best = f; });
        if (!fs.length) continue;
        /* a sliver of another colour (a leaf's edge just touching the plane) is not a second colour: under 1 % of the outline */
        if (len[best] < tot * 0.99) {
          return 'Multi-colour: ' + (ob.name || 'a piece') + ' has ' + fs.length + ' colours in one layer (at ' + pl.printZ.toFixed(2) +
            ' mm: filaments ' + fs.sort().join(', ') + '). A layer of one piece prints in one colour for now; colours that share a layer ' +
            '(a logo on a face) come next.';
        }
        L.slot = best - 1;
        if (best > maxF) maxF = best;
      }
    }
    return null;
  }

  /* the keys a painted project brings that are not a list of its filaments: the purge table and the colours' map */
  var MC_KEYS = /^(flush_volumes_matrix|flush_volumes_vector|flush_multiplier|filament_map)$/;
  /* ...and its prime tower: on or off, where it stands, its size and its walls (the planner's primeTower) */
  var TOWER_KEYS = /^(enable_prime_tower|prime_tower_\w+|wipe_tower_\w+|prime_volume_mode)$/;
  /**
   * MULTI-COLOUR (docs/MULTICOLOR.md): a plate whose painted pieces use more than one filament slices with their Studio project's filaments -
   * its slots' colours, types, temperatures and purge table - over the printer profile's template, which holds one filament (or two). The
   * per-filament lists of the project (one entry a filament, or two: a filament's two extruder variants) replace the template's; the rest of
   * the template stays. Returns assets with that config and `filamentOver` (the keys, for the file's CONFIG_BLOCK), or the assets as they
   * were; { error } when the paint uses a filament the project does not have.
   */
  function withProjectFilaments(assets, pieces) {
    var P = lazy('nso_paint.js', 'NSO_Paint');
    var painted = (pieces || []).filter(function (p) { return p && p.paint && !p.support; });
    if (!painted.length || !P) return assets;
    var most = 0, file = null;
    painted.forEach(function (p) { P.filaments(p.paint).forEach(function (f) { if (f > most) most = f; }); if (!file && p.file) file = p.file; });
    if (most <= 1) return assets;
    var reg = root && root.nsoProjects, proj = file && reg && reg[file] ? reg[file].config : null;
    if (!proj) return { error: 'This piece is painted in ' + most + ' filaments, but the Studio project it came from (its filament list) is not open: open the project file again.' };
    var listOf = function (v) { return Array.isArray(v) ? v : v == null ? [] : String(v).split(/[;,]/); };
    var n = listOf(proj.filament_colour).length;
    if (n < most) return { error: 'This piece is painted with filament ' + most + ', but its project has ' + n + ' filament' + (n === 1 ? '' : 's') + '.' };
    var tpl = assets.config, cfg = Object.assign({}, tpl), over = {};
    var tn = listOf(tpl.filament_settings_id).length || 1;
    /* a key of the template's filaments (one entry a filament, or two: a filament's extruder variants) that the project lists for its own */
    Object.keys(proj).forEach(function (k) {
      if (!Object.prototype.hasOwnProperty.call(tpl, k)) return;
      var v = proj[k], t = tpl[k];
      var perFil = Array.isArray(t) && (t.length === tn || t.length === 2 * tn) && Array.isArray(v) && (v.length === n || v.length === 2 * n) &&
                   (t.length === tn) === (v.length === n);
      if (!perFil && !MC_KEYS.test(k) && !TOWER_KEYS.test(k)) return;
      cfg[k] = Array.isArray(v) ? v.slice() : v;
      /* the G-code's CONFIG_BLOCK lists a filament once: a key kept per extruder variant gives its standard nozzle's (Studio: nozzle_temperature
         = 220,220,220 where the project has six) */
      over[k] = perFil && v.length === 2 * n ? v.filter(function (x, i) { return i % 2 === 0; }) : cfg[k];
    });
    /* which settings each filament changed from its preset: the project's, one entry a filament between the process's and the printer's */
    var pd = proj.different_settings_to_system, td = tpl.different_settings_to_system;
    if (Array.isArray(pd) && pd.length === n + 2 && Array.isArray(td) && td.length >= 2) cfg.different_settings_to_system = [td[0]].concat(pd.slice(1, n + 1), [td[td.length - 1]]);
    return Object.assign({}, assets, { config: cfg, filamentOver: over });
  }

  function build(objects, assets, opts) {
    opts = opts || {};
    var stage = opts.onStage || function () {};
    var SL = lazy('nso_slicer.js', 'NSO_Slicer'), PL = lazy('nso-print-planner.js', 'NSOPrintPlanner');
    lazy('nso_paint.js', 'NSO_Paint'); lazy('nso_paint_segment.js', 'NSO_PaintSegment');      /* a painted piece's colours, split for the slicer */
    if (!SL) return Promise.resolve({ ok: false, reason: 'The slicer (nso_slicer.js) did not load - check console.' });
    if (!PL) return Promise.resolve({ ok: false, reason: 'The print planner (nso-print-planner.js) did not load - check console.' });
    var settings = opts.settings ? cleanSettings(opts.settings) : null, over = {}, config = assets.config;
    return Promise.resolve().then(function () {
      var so = slicerOptions(SL, PL, objects, assets, settings);
      over = so.over; config = so.config;
      if (opts.stacks) so.o.columnStacks = true;       /* the supports card's Generate: the supports as they print come back with the file */
      stage('slicing', { objects: objects.length });
      return SL.run(objects, so.o);
    }).then(function (res) {
      if (!res.ok) return { ok: false, reason: 'Slice refused: ' + res.reason };
      var mixed = layerSlots(objects, res);
      if (mixed) return { ok: false, reason: mixed };
      stage('writing', { layers: res.planes.length });
      var ex = plannerExtras(config, settings);
      /* a painted project's filaments go into the file's CONFIG_BLOCK as lists, under the card's own changes */
      if (assets.filamentOver) over = Object.assign({}, assets.filamentOver, over);
      return PL.toGcode3mf(res, { config: config, printer: assets.printer, configOver: over, cooling: ex.cooling, filamentStart: ex.filamentStart, tempSteps: ex.tempSteps, bridgeTemp: ex.bridgeTemp, bridgeTempFrom: ex.bridgeTempFrom, hangSpeed: ex.hangSpeed }).then(function (out) {
        var seen = {};
        out.plan.layers.forEach(function (l) { l.features.forEach(function (f) { seen[f] = 1; }); });
        var st = out.plan.stats;
        return {
          ok: true, reason: '', bytes: out.bytes, features: Object.keys(seen), objects: out.plan.labels.length,
          labels: out.plan.labels.map(function (l) { return { id: l.id, name: l.name, index: l.index }; }),     // the gcode's OBJECT_ID of each object, in the order they were given
          stats: { layers: st.layers, seconds: st.seconds.total, startSeconds: st.seconds.start, grams: st.grams, filamentMm: st.filamentMm, maxZ: st.maxZ, tempBands: st.tempBands || null, bridgeTemp: st.bridgeTemp || null,
                   changes: st.changes ? st.changes.length : 0, tower: st.tower || null, towerNote: st.towerNote || null },
          tune: settings ? tuneWords(config, ex.hangSpeed) : null,                                                             // the bridge and retraction numbers it prints with
          filament: filamentWords(config, settings),                                                             // what it prints with, in words
          settings: settings, changed: Object.keys(over),                                                        // what was sliced with, and what differs from the profile
          stacks: res.stacks ? stacksToPlate(res.stacks, assets.printer.bed) : null,                             // the supports as they print, in the plate's frame
          raft: raftToPlate(res, assets.printer.bed),                                                            // the raft as it prints, for the plate to draw
          report: sliceReport(res, out.plan.labels, st.layers)                                                              // what G-scope's Slice says of it (no paths)
        };
      });
    }).catch(function (err) {
      // the planner's refusal (toGcode3mf rejects with plan().reason), or whatever stopped the slice
      return { ok: false, reason: (err && err.message) || String(err) };
    });
  }

  /** The slice in G-scope's words (app-gscope-slice.js report): the slicer's result less its paths - each object's walls, overhangs and
   *  support, the options, the layers, the conflicts - each object under the OBJECT_ID the file prints it as. G-scope shows the plate's one
   *  slice with it (its Slice switch opens this slice, never one of its own). */
  function sliceReport(res, labels, fileLayers) {
    var idOf = {};
    (labels || []).forEach(function (l) { idOf[l.index] = l.id; });
    var opt = {};
    Object.keys(res.options || {}).forEach(function (k) { var v = res.options[k]; if (v == null || typeof v !== 'object') opt[k] = v; });
    return {
      ok: true, ms: res.ms, options: opt, raft: res.raft || null, fileLayers: fileLayers,   /* the file's layers (the support's own grid among the part's) */
      planes: (res.planes || []).map(function (p) { return { printZ: p.printZ, h: p.h }; }),
      conflicts: (res.conflicts || []).map(function (c) { return { layer: c.layer, index: c.index, printZ: c.printZ, a: c.a, b: c.b, areaMm2: c.areaMm2 }; }),
      objects: (res.objects || []).map(function (ob, i) {
        var sp = ob.support;
        return {
          id: idOf[i] != null ? idOf[i] : ob.id, key: ob.key, name: ob.name, role: ob.role, hostKey: ob.hostKey, flipped: !!ob.flipped, nonSolid: !!ob.nonSolid,
          wallCountHistogram: ob.wallCountHistogram || {}, sectionStats: ob.sectionStats || {},
          layers: [{ brimLoops: ob.layers && ob.layers[0] ? ob.layers[0].brimLoops || 0 : 0 }],
          overhang: (ob.overhang || []).map(function (g) {
            return { firstZ: g.firstZ, footprintMm2: g.footprintMm2, standsOn: g.standsOn, coveredMm2: g.coveredMm2, uncoveredMm2: g.uncoveredMm2,
                     coveredBy: (g.coveredBy || []).map(function (c) { return { id: c.id, name: c.name }; }) };
          }),
          support: sp ? { hostName: sp.hostName, tips: sp.tips, zLo: sp.zLo, zHi: sp.zHi, sheets: (sp.sheets || []).map(function () { return {}; }) } : null
        };
      })
    };
  }

  /** The slicer's stacks (nso_slicer.js o.columnStacks) back from the bed's frame to the plate's (pieceObjects' shift undone). */
  function stacksToPlate(stacks, bed) {
    var dx = bed.x / 2, dy = bed.y / 2;
    var back = function (polys) { return polys.map(function (poly) { return poly.map(function (pt) { return [pt[0] - dx, pt[1] - dy]; }); }); };
    return stacks.map(function (st) {
      return { key: st.key, name: st.name, layers: st.layers.map(function (L) { return { z0: L.z0, z1: L.z1, printed: L.printed, S: back(L.S), I: back(L.I), T: back(L.T) }; }) };
    });
  }

  /** The raft's layers (nso_slicer.js addRaft) in the plate's frame: xy back from the bed's, z in the pieces' own frame (the raft lies
   *  under z 0, `lift` deep - the plate stands on it), each layer's outlines (holes and all) and whether it is interface. Null without one. */
  function raftToPlate(res, bed) {
    var ob = (res.objects || []).filter(function (x) { return x.role === 'raft'; })[0];
    if (!ob || !res.raft) return null;
    var dx = bed.x / 2, dy = bed.y / 2, sz = res.shiftZ || 0;
    return { lift: res.raft.liftMm, layers: ob.layers.map(function (L) {
      return { z0: L.printZ - L.h - sz, z1: L.printZ - sz, iface: L.paths.some(function (pth) { return pth.feature === 'Support interface'; }),
               polys: (L.sectionPolys || []).map(function (poly) { return poly.map(function (pt) { return [pt[0] - dx, pt[1] - dy]; }); }) };
    }) };
  }

  /** The filament a config prints with, in a few words (null with no settings: the profile's, untouched). */
  function filamentWords(config, settings) {
    if (!settings) return null;
    var PL = lazy('nso-print-planner.js', 'NSOPrintPlanner'), S = PL.settingsFrom(config), f = filamentOf(settings.filament);
    return f.label + ', ' + S.temp.nozzle + ' \u00b0C' + (S.temp.nozzleInitial !== S.temp.nozzle ? ' (first layer ' + S.temp.nozzleInitial + ')' : '') +
      ', bed ' + S.temp.bedInitial + ' \u00b0C, ' + S.filament.maxVolumetric + ' mm\u00b3/s';
  }
  /** The bridge and retraction numbers a config prints with, for the readout: "bridges 12 mm/s (flow 0.9), retract 0.8 mm at 30 mm/s, z-hop 0.4 mm".
   *  The bridge speed is what is printed: the row's, held under the filament's max flow over the bridge's round bead. */
  function tuneWords(config, hang) {
    var PL = lazy('nso-print-planner.js', 'NSOPrintPlanner'), S = PL.settingsFrom(config);
    var r1 = function (v) { return Math.round(v * 10) / 10; };
    return 'bridges ' + r1(bridgeSpeedOf(S)) + ' mm/s (flow ' + S.filament.bridgeFlow + ')' + (hang > 0 && hang < bridgeSpeedOf(S) ? ', hanging walls ' + r1(hang) + ' mm/s' : '') + ', flow ratio ' + S.filament.flow + ', retract ' + S.retract.length + ' mm at ' + S.retract.speed +
      ' mm/s, z-hop ' + S.retract.hop + ' mm';
  }
  /** The bridge temperature as written, for the readout: "bridges at 212 °C on 3 layers: 6 nozzle temperature changes at the park, about 3 min". */
  function bridgeTempWords(b) {
    if (!b) return '';
    if (!b.changes) return 'bridge temp ' + b.temp + ' \u00b0C set, but no layer has enough bridge for it';
    if (b.fromLayer) return b.temp + ' \u00b0C from layer ' + b.fromLayer + ' to the top' + (b.layers ? ' (bridges on ' + b.layers + ' layer' + (b.layers === 1 ? '' : 's') + ')' : '') +
      ': ' + b.changes + ' nozzle temperature change' + (b.changes === 1 ? '' : 's') + ' at the park, about ' + fmtTime(b.changes * b.secondsEach);
    return 'bridges at ' + b.temp + ' \u00b0C on ' + b.layers + ' layer' + (b.layers === 1 ? '' : 's') + ': ' + b.changes + ' nozzle temperature change' + (b.changes === 1 ? '' : 's') +
      ' at the park, about ' + fmtTime(b.changes * b.secondsEach);
  }
  /** The speed a bridge over open air prints at: bridge_speed, never over what the max flow allows its bead. */
  function bridgeSpeedOf(S) {
    var PL = lazy('nso-print-planner.js', 'NSOPrintPlanner');
    var area = PL.beadOf(S, 'Bridge', S.infillWidthMm, S.layerMm, true).area;      /* a bridge over open air (the planner's own bead for it) */
    return S.filament.maxVolumetric > 0 ? Math.min(S.speed.bridge, S.filament.maxVolumetric / area) : S.speed.bridge;
  }

  /** The temperature steps as written, for the readout: 240, 235, 230 in 10 mm bands. */
  function bandWords(bands, bandMm) {
    if (!bands || bands.length < 2) return '';
    return 'temperature steps ' + bands.map(function (b) { return b.temp; }).join(', ') + ' \u00b0C in ' + bandMm + ' mm bands';
  }

  /** The settings in a few words, for the readout: "0.12 mm layers, 3 walls, 20 % grid, support below 30°, brim auto". */
  function settingsWords(st) {
    return st.layer + ' mm layers, ' + st.walls + ' wall' + (st.walls === 1 ? '' : 's') + ', ' + st.density + ' % ' + (PATTERN_LABEL[st.pattern] || st.pattern) + (st.surface && st.surface !== 'zigzag' ? ', ' + (PATTERN_LABEL[st.surface] || st.surface) + ' surfaces' : '') +
      ', support below ' + st.angle + '°, ' + (st.raft > 0 ? 'raft ' + st.raft + ' layer' + (st.raft === 1 ? '' : 's') + ' (no brim)' : 'brim ' + st.brim);
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
    var s = r.stats, out = s.layers + ' layers - ' + fmtTime(s.seconds) + ' - ' + s.grams.toFixed(1) + ' g filament';
    /* MULTI-COLOUR (docs/MULTICOLOR.md): the changes, and the prime tower - where it went when the project's spot was under a piece */
    if (s.changes) {
      out += ' - ' + s.changes + ' filament change' + (s.changes === 1 ? '' : 's');
      if (s.tower) out += ', prime tower ' + (+s.tower.width.toFixed(1)) + ' x ' + (+s.tower.depth.toFixed(1)) + ' mm' + (s.tower.moved ? ' (moved clear of the pieces)' : '');
      else if (s.towerNote) out += ' (' + s.towerNote + ')';
    }
    return out;
  }

  /** Worker entry (see the card): build, with the file's bytes moved rather than copied. */
  function buildForWorker(objects, assets, onStage, settings, extra) {
    return build(objects, assets, { onStage: onStage, settings: settings || null, stacks: !!(extra && extra.stacks) }).then(function (r) {
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
    fileName: fileName, gcodeName: gcodeName, build: build, withProjectFilaments: withProjectFilaments, layerSlots: layerSlots, fmtTime: fmtTime, describe: describe, buildForWorker: buildForWorker,
    SETTINGS_DEFAULT: SETTINGS_DEFAULT, settingsFromConfig: settingsFromConfig, cleanSettings: cleanSettings,
    configOverlay: configOverlay, withOverlay: withOverlay, plateProject: plateProject,
    FILAMENTS: FILAMENTS, filamentBase: filamentBase, filamentKeys: filamentKeys, filamentWords: filamentWords, bandWords: bandWords, tuneWords: tuneWords, bridgeTempWords: bridgeTempWords, bridgeTempOf: bridgeTempOf, hangSpeedOf: hangSpeedOf
  };

  // ===========================================================================
  // The card
  // ===========================================================================

  if (typeof document === 'undefined' || !document.getElementById) return api;

  var $ = function (id) { return document.getElementById(id); };
  var S = { busy: false, job: null, result: null, sig: null, setSig: null, pieces: null, profile: null, assets: {}, timer: null, t0: 0, stage: '', hook: null, exporting: false,
            seededFor: null, touched: false,
            project: null, projectSeen: undefined, projectOff: null };   /* the project the rows are from (plateProject), the one last seen, and one Profile values let go */

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
      /* a support the supports card drew as it prints is sliced as the tree it was built as (nsoSupportSliceSoup) */
      var soup = sup && typeof root.nsoSupportSliceSoup === 'function' ? root.nsoSupportSliceSoup(m, o.positions) : o.positions;
      return { name: o.name, file: m && m.sourceFile ? m.sourceFile : null, soup: soup, sourceId: o.sourceId, support: !!sup, brim: !!(sup && sup.brim), hostSourceId: sup ? sup.hostSourceId : undefined, interfaceLayers: sup ? sup.interfaceLayers : undefined, sheetLayerMm: sup ? sup.sheetLayerMm : undefined,
               nonSolid: !!(pm && typeof root.nsoNonSolid === 'function' && root.nsoNonSolid(pm)),
               /* its painted colours, while its triangles are the ones they were read with (the soup keeps the piece's order) */
               paint: !sup && m && m.paint && root.NSO_Paint && root.NSO_Paint.fits(m.paint, (o.positions || []).length) ? m.paint : null,
               settings: m && m.slicerSettings ? Object.assign({}, m.slicerSettings) : null };      // a support's own slicer overrides ride into a 3MF
    });
  }

  // ---- the card's Slice settings -----------------------------------------------

  var SET_IDS = ['slice-set-nozzle', 'slice-set-layer', 'slice-set-walls', 'slice-set-density', 'slice-set-pattern', 'slice-set-surface',
                 'slice-set-angle', 'slice-set-brim', 'slice-set-raft', 'slice-set-raft-gap', 'slice-set-iface-angle', 'slice-set-iface',
                 'slice-set-filament', 'slice-set-nozzle-temp', 'slice-set-first-temp', 'slice-set-bed-temp', 'slice-set-max-flow',
                 'slice-set-temp-step', 'slice-set-temp-band',
                 'slice-set-bridge-speed', 'slice-set-bridge-flow', 'slice-set-hang-speed', 'slice-set-bridge-temp', 'slice-set-bridge-temp-from', 'slice-set-flow-ratio', 'slice-set-retract-len', 'slice-set-retract-speed', 'slice-set-retract-before', 'slice-set-zhop',
                 /* Bambu's Advanced support rows, on the Supports card (docs/SUPPORT-ADVANCED.md) */
                 'slice-set-sup-density', 'slice-set-sup-expand', 'slice-set-sup-walls', 'slice-set-sup-topz', 'slice-set-sup-bottomz', 'slice-set-sup-base',
                 'slice-set-sup-base-spacing', 'slice-set-sup-angle', 'slice-set-sup-iface-pattern', 'slice-set-sup-iface-spacing', 'slice-set-sup-expansion',
                 'slice-set-sup-xy', 'slice-set-sup-zover', 'slice-set-sup-first-gap', 'slice-set-sup-bridge', 'slice-set-sup-indep',
                 /* the wall generator and Arachne's levers (Quality) */
                 'slice-set-wall-gen', 'slice-set-wall-angle', 'slice-set-wall-filter', 'slice-set-wall-translen', 'slice-set-wall-dist', 'slice-set-min-wall', 'slice-set-min-feature',
                 /* the top / bottom shells (Strength) */
                 'slice-set-top-layers', 'slice-set-top-thick', 'slice-set-bot-layers', 'slice-set-bot-thick'];
  /* the wall generator's rows: the row, and its name in the settings */
  var WALL_ROWS = [['slice-set-wall-gen', 'wallGen'], ['slice-set-wall-angle', 'wallAngle'], ['slice-set-wall-filter', 'wallFilter'], ['slice-set-wall-translen', 'wallTransLen'],
                   ['slice-set-wall-dist', 'wallDist'], ['slice-set-min-wall', 'minWall'], ['slice-set-min-feature', 'minFeature'],
                   /* ...and the shells' four rows, read and shown the same way */
                   ['slice-set-top-layers', 'topLayers'], ['slice-set-top-thick', 'topThick'], ['slice-set-bot-layers', 'botLayers'], ['slice-set-bot-thick', 'botThick']];
  /** Arachne's six levers show under the generator only when it is Arachne (Classic has none of them). */
  function wallRows() {
    var sel = $('slice-set-wall-gen'), box = $('slice-arachne-rows');
    if (box) box.hidden = !(sel && sel.value === 'arachne');
  }
  var SUP_ROWS = [['slice-set-sup-density', 'supDensity'], ['slice-set-sup-expand', 'supExpand'], ['slice-set-sup-walls', 'supWalls'], ['slice-set-sup-topz', 'supTopZ'],
                  ['slice-set-sup-bottomz', 'supBottomZ'], ['slice-set-sup-base', 'supBase'], ['slice-set-sup-base-spacing', 'supBaseSpacing'], ['slice-set-sup-angle', 'supAngle'],
                  ['slice-set-sup-iface-pattern', 'supIfacePattern'], ['slice-set-sup-iface-spacing', 'supIfaceSpacing'], ['slice-set-sup-expansion', 'supExpansion'],
                  ['slice-set-sup-xy', 'supXy'], ['slice-set-sup-zover', 'supZOverXy'], ['slice-set-sup-first-gap', 'supFirstGap'], ['slice-set-sup-bridge', 'supBridge'],
                  ['slice-set-sup-indep', 'supIndep']];
  /* the four rows that are a filament's own numbers: the row, and its name in the settings */
  var FILAMENT_SUP_ROWS = [['slice-set-sup-topz', 'supTopZ']];
  var FILAMENT_ROWS = [['slice-set-nozzle-temp', 'nozzleTemp'], ['slice-set-first-temp', 'firstTemp'], ['slice-set-bed-temp', 'bedTemp'], ['slice-set-max-flow', 'maxFlow'],
                       ['slice-set-flow-ratio', 'flowRatio'], ['slice-set-retract-len', 'retractLen'], ['slice-set-retract-speed', 'retractSpeed'], ['slice-set-retract-before', 'retractBefore'], ['slice-set-zhop', 'zHop'],
                       ['slice-set-bridge-speed', 'bridgeSpeed'], ['slice-set-bridge-flow', 'bridgeFlow'], ['slice-set-hang-speed', 'hangSpeed'], ['slice-set-bridge-temp', 'bridgeTemp']];

  /** The line under the bridge rows: the speed a bridge will really print at (the row's, or what the filament's max flow allows). */
  function bridgeNote() {
    var el = $('slice-bridge-note');
    if (!el) return;
    var cfg = knownConfig(), PL = lazy('nso-print-planner.js', 'NSOPrintPlanner'), text = '';
    if (cfg && PL) {
      try {
        var st = readSettings(), c2 = withOverlay(cfg, configOverlay(cfg, st)), Sx = PL.settingsFrom(c2), v = bridgeSpeedOf(Sx);
        if (v < Sx.speed.bridge - 0.05) {
          text = 'Bridges print at ' + (Math.round(v * 10) / 10) + ' mm/s: the max flow of ' + Sx.filament.maxVolumetric + ' mm\u00b3/s holds them under the ' +
            Sx.speed.bridge + ' set here.';
        }
      } catch (err) { text = ''; }
    }
    el.textContent = text;
    el.hidden = !text;
  }

  /** The plate's printer's template settings, once the card has fetched them (else null). */
  function knownConfig() {
    var p = profileFor(plateId()), a = p && S.assets[p.id];
    return a ? a.config : null;
  }

  /** The four filament rows at the picked filament's own values (a filament just picked, or the template just fetched). */
  function showFilamentRows() {
    var sel = $('slice-set-filament'), base = filamentBase(knownConfig(), sel ? sel.value : 'profile');
    FILAMENT_ROWS.forEach(function (r) { var el = $(r[0]); if (el) el.value = base && base[r[1]] != null ? String(base[r[1]]) : ''; });
    /* the support rows a filament holds (its tune): picking it puts its value in the row - a number typed there afterwards wins */
    FILAMENT_SUP_ROWS.forEach(function (r) { var el = $(r[0]); if (el && base && base[r[1]] != null) el.value = String(base[r[1]]); });
  }

  /** The line under the filament rows: what the picked filament needs of the owner, and the temperature steps as they will be written. */
  function filamentNote() {
    var el = $('slice-filament-note');
    if (!el) return;
    var st = readSettings(), f = filamentOf(st.filament), base = filamentBase(knownConfig(), st.filament), parts = [];
    if (f.external) parts.push(f.label + ': external spool only, not the AMS. When sending, untick the AMS and flow dynamics calibration.');
    if (f.tune && base) parts.push(base.bridgeTemp ? 'It brings its own bridge temperature (' + base.bridgeTemp + ' \u00b0C, under Quality; 0 there turns it off).'
      : 'Its bridges print at its own nozzle temperature: no stop at the park. A Bridge temp typed under Quality changes that for this job.');
    if (st.tempStep) {
      var t0 = st.nozzleTemp != null ? st.nozzleTemp : base ? base.nozzleTemp : null, t1 = st.firstTemp != null ? st.firstTemp : base ? base.firstTemp : null;
      if (t0 != null) {
        parts.push('Temperature steps: ' + t0 + ', ' + (t0 + st.tempStep) + ', ' + (t0 + 2 * st.tempStep) + ' \u00b0C ... one band every ' + st.tempBand +
          ' mm of height, first layer ' + t1 + ' \u00b0C' + (base ? '. This filament prints between ' + base.rangeLow + ' and ' + base.rangeHigh + ' \u00b0C.' : '.'));
      }
    }
    el.textContent = parts.join(' ');
    el.hidden = !parts.length;
  }

  /** The interface rule, one choice shared with G-scope's Slice settings (its page keeps it). */
  function interfaceRule() {
    if ($('sup-on')) return 'column';                      /* the Print card: the column rule, no choice (the sheet typing stays in the engine for the gates) */
    return typeof root.nsoSupportInterfaceRule === 'function' && root.nsoSupportInterfaceRule() === 'column' ? 'column' : null;
  }

  /** The settings as the card's rows hold them, clamped. */
  function readSettings() {
    var v = function (id) { var el = $(id); return el ? (el.type === 'checkbox' ? !!el.checked : el.value) : undefined; };
    var sup = {}; SUP_ROWS.concat(WALL_ROWS).forEach(function (r) { sup[r[1]] = v(r[0]); });
    return cleanSettings(Object.assign(sup, {
      nozzle: v('slice-set-nozzle'), layer: v('slice-set-layer'), walls: v('slice-set-walls'), density: v('slice-set-density'),
      pattern: v('slice-set-pattern'), surface: v('slice-set-surface'), angle: $('slice-set-angle') ? v('slice-set-angle') : v('sup-angle'), brim: v('slice-set-brim'),   /* ONE angle: with no row of its own, the Print card's */
      raft: v('slice-set-raft'), raftGap: v('slice-set-raft-gap'), ifaceAngle: v('slice-set-iface-angle'),
      interfaceRule: $('slice-set-iface') ? v('slice-set-iface') : interfaceRule(),
      filament: v('slice-set-filament'), nozzleTemp: v('slice-set-nozzle-temp'), firstTemp: v('slice-set-first-temp'),
      bedTemp: v('slice-set-bed-temp'), maxFlow: v('slice-set-max-flow'), tempStep: v('slice-set-temp-step'), tempBand: v('slice-set-temp-band'),
      bridgeSpeed: v('slice-set-bridge-speed'), bridgeFlow: v('slice-set-bridge-flow'), hangSpeed: v('slice-set-hang-speed'), bridgeTemp: v('slice-set-bridge-temp'), bridgeTempFrom: v('slice-set-bridge-temp-from'),
      flowRatio: v('slice-set-flow-ratio'), retractLen: v('slice-set-retract-len'), retractSpeed: v('slice-set-retract-speed'), retractBefore: v('slice-set-retract-before'), zHop: v('slice-set-zhop'),
      project: S.project
    }));
  }

  /** The rows to these values (the interface row shows the shared choice). */
  function showSettings(st) {
    var set = function (id, val) { var el = $(id); if (!el || val == null) return; if (el.type === 'checkbox') el.checked = !!val; else el.value = String(val); };
    var full = cleanSettings(st); SUP_ROWS.concat(WALL_ROWS).forEach(function (r) { set(r[0], full[r[1]]); });
    wallRows();
    set('slice-set-nozzle', st.nozzle); set('slice-set-layer', st.layer); set('slice-set-walls', st.walls);
    set('slice-set-density', st.density); set('slice-set-pattern', st.pattern); set('slice-set-surface', st.surface); set('slice-set-angle', st.angle);
    /* ONE angle: the Print card's Angle starts at the profile's support threshold too (the card reads its areas again at it). The rows are
       seeded more than once - when the page opens, and again when the printer's template has been fetched - so an angle changed since the
       last seed is the owner's and is left alone: only Profile values (S.seedForce) lays the profile's over it. */
    if (!$('slice-set-angle') && $('sup-on') && st.angle != null && $('sup-angle')) {
      var fld = $('sup-angle'), mine = S.seedAngle == null || String(fld.value) === String(S.seedAngle) || !!S.seedForce;
      if (mine && String(fld.value) !== String(st.angle)) {
        fld.value = String(st.angle);
        if (root.NSO_SUPPORTS_CARD && typeof root.NSO_SUPPORTS_CARD.angle === 'function') { try { root.NSO_SUPPORTS_CARD.angle(st.angle); } catch (err) { /* the card is closed: its field holds the value */ } }
      }
      if (mine) S.seedAngle = st.angle;
    }
    set('slice-set-brim', st.brim); set('slice-set-raft', st.raft); set('slice-set-raft-gap', st.raftGap); set('slice-set-iface-angle', st.ifaceAngle);
    set('slice-set-iface', interfaceRule() || '');
    /* the filament: a null row shows the filament's own value (empty until the template is fetched) */
    set('slice-set-filament', filamentOf(st.filament).id); set('slice-set-temp-step', st.tempStep == null ? 0 : st.tempStep); set('slice-set-temp-band', st.tempBand == null ? 10 : st.tempBand);
    set('slice-set-bridge-temp-from', st.bridgeTempFrom == null ? '' : st.bridgeTempFrom);
    showFilamentRows();
    FILAMENT_ROWS.forEach(function (r) { if (st[r[1]] != null) set(r[0], st[r[1]]); });
    filamentNote(); bridgeNote();
  }

  /** The rows back to the profile's values: the template's when the card has it, else the profile's usual ones (the same, for both
   *  profiles) until the open card has fetched it (seedFromTemplate). */
  function seedSettings(profile, reset) {
    S.seededFor = profile ? profile.id : null;
    S.touched = false;
    /* Profile values lets the plate's project go (its Project settings button brings it back) */
    if (reset && S.project) { S.projectOff = S.project.file; S.project = null; }
    var known = profile && S.assets[profile.id];
    S.seedForce = !!reset;
    try { showSettings(known ? settingsFromConfig(S.project ? withOverlay(known.config, projectOverlay(known.config)) : known.config) : SETTINGS_DEFAULT); } finally { S.seedForce = false; }
    seeded(!!reset);
    if (known && S.project) relayProject(known.config);
    projectLine();
  }
  /**
   * WHO WINS. A project stands where the printer profile stood: the saved setting the card shows lays its rows over it as over the profile
   * (seeded) - and then the rows the project itself changed are the project's again. What the owner set in Studio is what a slice to
   * compare with Studio's must have; the saved setting keeps every other row.
   */
  function relayProject(config) {
    if (!S.project) return;
    var plain = settingsFromConfig(config), mine = settingsFromConfig(withOverlay(config, projectOverlay(config))), st = readSettings(), moved = 0;
    Object.keys(mine).forEach(function (k) {
      if (k === 'project' || JSON.stringify(mine[k]) === JSON.stringify(plain[k])) return;
      if (JSON.stringify(st[k]) !== JSON.stringify(mine[k])) { st[k] = mine[k]; moved++; }
    });
    if (!moved) return;
    S.seedForce = true;
    try { showSettings(st); } finally { S.seedForce = false; }
  }
  /** The project's keys that differ from this template (what its rows start at). */
  function projectOverlay(config) {
    var out = {};
    if (S.project) Object.keys(S.project.keys).forEach(function (k) { if (cfgRaw(config, k) !== S.project.keys[k].trim()) out[k] = S.project.keys[k]; });
    return out;
  }
  /**
   * THE PLATE'S PROJECT: parts opened from a Studio project slice with its settings, from the moment they are on the plate (Profile values
   * lets it go, Project settings brings it back); parts that are not one project's are the profile's again. Looked at whenever the card
   * refreshes, twice a second, and before every slice (which waits for the rows) - so G-scope's Slice, with the card shut, has them too.
   * A promise of the rows being set while they are being set (the template is fetched first), else null.
   */
  function checkProject() {
    if (S.busy) return null;
    var pj = plateProject(), pk = pj ? pj.file + '|' + JSON.stringify(pj.keys) : null;
    if (pk === S.projectSeen) return S.projectPending || null;
    S.projectSeen = pk;
    if (pj && S.projectOff !== pj.file) return useProject(pj);
    if (!pj && S.project) { S.project = null; S.projectInfo = null; seedSettings(profileFor(plateId())); return null; }
    projectLine();
    return null;
  }
  /** The rows to the plate's project (plateProject): its changes over the printer profile's template, fetched first. A promise. */
  function useProject(pj) {
    var profile = profileFor(plateId());
    S.project = pj ? projectOf(pj) : null;
    S.projectInfo = pj || null;
    if (pj) S.projectOff = null;
    projectLine();
    if (!profile) return null;
    var done = S.projectPending = loadAssets(profile).then(function (a) {
      if (S.projectPending === done) S.projectPending = null;
      if (S.busy || profileFor(plateId()) !== profile) return;
      S.seedForce = true;
      try { showSettings(settingsFromConfig(S.project ? withOverlay(a.config, projectOverlay(a.config)) : a.config)); } finally { S.seedForce = false; }
      seeded(false);                       /* the saved setting shown lays its rows over the project's... */
      relayProject(a.config);              /* ...and what the project changed is the project's again */
      S.touched = true;
      projectLine(); filamentNote(); bridgeNote(); refresh();
    }, function () { if (S.projectPending === done) S.projectPending = null; /* not served: Slice says which file is missing */ });
    return done;
  }
  /** The line under the printer: the project the rows are from, what it changed, and what is not taken. */
  function projectLine() {
    var box = $('slice-project'), txt = $('slice-project-note'), use = $('slice-project-use');
    if (!box) return;
    var pj = S.projectInfo, on = !!(S.project && pj);
    var seen = plateProject();
    box.hidden = !seen;
    if (!seen) return;
    if (use) { use.hidden = on; use.textContent = 'Project settings'; }
    if (!on) { txt.textContent = seen.file + ' is a Studio project: Project settings slices it with the settings it was sliced with in Studio (' + Object.keys(seen.keys).length + ' changed).'; return; }
    var ks = Object.keys(pj.keys), prof = profileFor(plateId()), a = prof && S.assets[prof.id], tplPreset = a ? cfgRaw(a.config, 'print_settings_id') : '', tplPrinter = a ? cfgRaw(a.config, 'printer_model') : '';
    var parts = ['Rows from ' + pj.file + '\'s project settings - the ' + ks.length + ' it changed' + (pj.preset ? ' from ' + pj.preset : '') + ': ' +
      ks.map(function (k) { return k + ' ' + pj.keys[k]; }).join(', ') + '.'];
    if (pj.preset && tplPreset && pj.preset !== tplPreset) parts.push('Its process is ' + pj.preset + ', the printer profile\'s ' + tplPreset + ': only what it changed is taken.');
    if (pj.printer && tplPrinter && pj.printer !== tplPrinter) parts.push('It was sliced for the ' + pj.printer + ', the plate is the ' + tplPrinter + '.');
    if (pj.filament) parts.push('Its filament: ' + pj.filament + ' (the Filament row is the card\'s).');
    if (pj.objects && pj.objects.length) parts.push(pj.objects.map(function (o) { return (o.name || 'an object') + ' has its own ' + o.keys.join(', '); }).join('; ') + ' in the project: not taken (one set of settings a plate).');
    txt.textContent = parts.join(' ');
  }
  /* the rows have been put to the profile's values: the Supports card's saved settings (app-supports-card.js) lay their own back over them - a
     saved setting holds through a reload and a change of printer - unless this was the Reset button, which is the owner asking for the profile's */
  function seeded(reset) { if (root && typeof root.nsoSliceRowsSeeded === 'function') { try { root.nsoSliceRowsSeeded(reset); } catch (err) { /* the card's own */ } } }

  /** The open card fetches its profile's template once, and rows nobody has changed take its values. */
  function seedFromTemplate(profile) {
    if (!profile || S.assets[profile.id] || S.seeding === profile.id) return;
    if (S.touched) {
      /* rows already changed: fetch the template all the same, so an empty filament row can show the filament's own value */
      S.seeding = profile.id;
      loadAssets(profile).then(function () {
        S.seeding = null;
        if (S.seededFor !== profile.id || S.busy) return;
        var base = filamentBase(knownConfig(), ($('slice-set-filament') || {}).value);
        FILAMENT_ROWS.forEach(function (r) { var el = $(r[0]); if (el && el.value === '' && base && base[r[1]] != null) el.value = String(base[r[1]]); });
        filamentNote(); refresh();
      }, function () { S.seeding = null; });
      return;
    }
    S.seeding = profile.id;
    loadAssets(profile).then(function (a) {
      S.seeding = null;
      if (S.seededFor === profile.id && !S.touched && !S.busy) { showSettings(settingsFromConfig(S.project ? withOverlay(a.config, projectOverlay(a.config)) : a.config)); seeded(false); refresh(); }
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
      var pm = (state.models || []).find(function (m) { return m && m.id === p.sourceId; });
      var ns = !!(pm && typeof root.nsoNonSolid === 'function' && root.nsoNonSolid(pm));          /* a piece flagged non-solid slices otherwise */
      parts.push(p.sourceId + ':' + (p.mesh.geometry ? p.mesh.geometry.uuid : '') + ':' + p.mesh.matrixWorld.elements.join(',') + (ns ? ':ns' : ''));
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
  function runAway(objects, assets, onStage, settings, extra) {
    var urls = engineUrls();
    var canWorker = urls && typeof Worker === 'function' && typeof Blob === 'function' && root.URL && URL.createObjectURL;
    if (!canWorker) {
      var dead = false;
      return {
        cancel: function () { dead = true; },
        promise: new Promise(function (go) { setTimeout(go, 0); }).then(function () {
          return build(objects, assets, { onStage: onStage, settings: settings || null, stacks: !!(extra && extra.stacks) });
        }).then(function (r) { if (dead) return new Promise(function () {}); return r; })
      };
    }
    var code = 'importScripts(' + urls.map(function (u) { return JSON.stringify(u); }).join(',') + ');\n' +
      'self.onmessage = function (e) {\n' +
      '  var d = e.data;\n' +
      '  self.NSO_Print.buildForWorker(d.objects, d.assets, function (s, info) { self.postMessage({ stage: s, info: info }); }, d.settings, d.extra)\n' +
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
      w.postMessage({ objects: objects, assets: assets, settings: settings || null, extra: extra || null }, move);
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
    ['btn-slice-export', 'btn-slice-saveas', 'btn-slice-preview'].forEach(function (id) { var b = $(id); if (b) b.disabled = !ok; });
  }

  /** The profile line, and a slice shown stale when the plate has moved on. */
  /* THE RAFT ON THE PLATE (the owner: "draw the raft on plate too"). A slice with a raft lifts everything on the plate the raft's height
     (nso_slicer.js raftPlan); the plate is drawn as it prints: the bed (its surface, grid, border and ticks - display only) lowered by that
     lift and the raft's layers drawn between it and the pieces, the base Support's light green, the interface a darker one. The pieces do
     not move (the slice stays the plate's), and the raft is no piece: never picked, never sliced, never exported. It goes when the slice
     it came from is the plate's no more. */
  var RAFT_VIEW = { group: null, lowered: null, key: null };
  function bedParts() {
    if (typeof state === 'undefined' || !state) return [];
    return [state.plateMesh, state.plateGrid, state.plateBorder].concat(state.plateTicks || []).filter(function (o) { return o && o.position; });
  }
  function clearRaftView() {
    if (RAFT_VIEW.group) {
      if (RAFT_VIEW.group.parent) RAFT_VIEW.group.parent.remove(RAFT_VIEW.group);
      RAFT_VIEW.group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
      RAFT_VIEW.mats.forEach(function (m) { m.dispose(); });
    }
    if (RAFT_VIEW.lowered) RAFT_VIEW.lowered.forEach(function (e) { e[0].position.y = e[1]; });
    if (RAFT_VIEW.watch) clearInterval(RAFT_VIEW.watch);
    RAFT_VIEW = { group: null, lowered: null, key: null, watch: 0 };
  }
  function signedArea2(poly) { var a = 0; for (var i = 0, n = poly.length; i < n; i++) { var u = poly[i], v = poly[(i + 1) % n]; a += u[0] * v[1] - v[0] * u[1]; } return a / 2; }
  function insidePoly(poly, x, y) {
    var c = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  /* a layer's outlines as three.js shapes: each outer loop with the holes inside it */
  function raftShapes(polys) {
    var outers = [], holes = [];
    polys.forEach(function (pl) { if (pl.length >= 3) (signedArea2(pl) > 0 ? outers : holes).push(pl); });
    return outers.map(function (o) {
      var sh = new THREE.Shape(o.map(function (pt) { return new THREE.Vector2(pt[0], pt[1]); }));
      holes.forEach(function (h) { if (insidePoly(o, h[0][0], h[0][1])) sh.holes.push(new THREE.Path(h.map(function (pt) { return new THREE.Vector2(pt[0], pt[1]); }))); });
      return sh;
    });
  }
  function showRaftView(raft) {
    clearRaftView();
    if (!raft || !raft.layers || !raft.layers.length || typeof THREE === 'undefined' || typeof state === 'undefined' || !state || !state.scene) return false;
    var g = new THREE.Group(), base = new THREE.MeshStandardMaterial({ color: 0x4ade80, roughness: 0.85, metalness: 0 }),
        face = new THREE.MeshStandardMaterial({ color: 0x15803d, roughness: 0.85, metalness: 0 }), none = function () {};
    g.name = 'nso-raft-view';
    raft.layers.forEach(function (L) {
      var shapes = raftShapes(L.polys || []), h = L.z1 - L.z0;
      if (!shapes.length || !(h > 0)) return;
      var geo = new THREE.ExtrudeGeometry(shapes, { depth: h, bevelEnabled: false, curveSegments: 1 });
      geo.translate(0, 0, L.z0);
      var m = new THREE.Mesh(geo, L.iface ? face : base);
      m.rotation.x = -Math.PI / 2;               /* Z-up mm to the scene's Y-up: (x, y, z) -> (x, z, -y) */
      m.raycast = none;                          /* no piece: a click goes through it */
      m.castShadow = false; m.receiveShadow = true;
      g.add(m);
    });
    if (!g.children.length) { base.dispose(); face.dispose(); return false; }
    state.scene.add(g);
    RAFT_VIEW.group = g; RAFT_VIEW.mats = [base, face];
    RAFT_VIEW.lowered = bedParts().map(function (o) { var y = o.position.y; o.position.y = y - raft.lift; return [o, y]; });
    /* nothing tells this card the plate changed: while a raft is drawn it looks once a second, and a piece moved or a setting changed takes it off */
    RAFT_VIEW.watch = setInterval(function () { if (!S.busy && S.sig && !isFresh()) refresh(); }, 1000);
    return true;
  }

  function refresh() {
    var p = profileFor(plateId());
    S.shownPlate = plateId();
    var line = $('slice-profile');
    if (line) {
      line.textContent = p ? p.label : 'No printer profile for the ' + ((typeof PLATES !== 'undefined' && PLATES[plateId()]) ? PLATES[plateId()].name : 'selected') +
        ' plate yet. Slice works on the A1 mini and the P1S plates.';
      line.classList.toggle('is-bad', !p);
    }
    // a printer picked since the rows were set starts them again at its profile's values
    if (!S.busy && (p ? p.id : null) !== S.seededFor) seedSettings(p);
    checkProject();
    var menu = $('menu-supports'), iface = $('slice-set-iface');
    if (menu && menu.open) seedFromTemplate(p);
    if (iface && !S.busy) iface.value = interfaceRule() || '';           // G-scope may have changed the shared choice
    if (S.result && S.result.ok && !S.busy && !isFresh()) readout(staleWords(), true);
    if (RAFT_VIEW.group && (S.busy || !isFresh())) clearRaftView();          // the raft drawn is the fresh slice's, or none
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
    /* the plate's project first: a plate just opened from a Studio project slices with its settings, the rows set before they are read */
    var pend = checkProject();
    return pend ? pend.then(function () { return sliceNow(hook); }, function () { return sliceNow(hook); }) : sliceNow(hook);
  }
  function sliceNow(hook) {
    if (S.busy) return Promise.resolve({ ok: false, reason: 'busy' });
    var profile = profileFor(plateId());
    function stop(reason, quietly) {
      if (!quietly) readout(reason, true);
      return { ok: false, reason: reason };
    }
    if (!profile) { refresh(); return Promise.resolve(stop('Pick the A1 mini or the P1S plate to slice for.')); }
    var pieces;
    /* hook.pieces: the plate as the supports card is about to leave it (its new supports not placed yet, the ones they replace left out) */
    try { pieces = hook && hook.pieces ? hook.pieces : readPieces(); } catch (err) { console.error(err); pieces = null; }
    if (pieces === null) return Promise.resolve(stop('The plate reader (G-scope\'s) did not load - check console.'));
    if (!pieces.length) return Promise.resolve(stop('Nothing on the plate to slice.'));
    var settings = readSettings();
    S.result = null; S.pieces = null;
    clearRaftView();
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
      assets = withProjectFilaments(assets, pieces);
      if (assets.error) return { ok: false, reason: assets.error };
      var objects = pieceObjects(pieces, assets.printer.bed);
      mine.run = runAway(objects, assets, onStage, settings, { stacks: !!(hook && hook.stacks) });
      return mine.run.promise;
    }).then(function (r) {
      if (mine.cancelled || !r) return ended({ ok: false, reason: 'Slice cancelled.', cancelled: true });
      S.job = null;
      if (!r.ok) { setBusy(false); S.result = null; readout(r.reason, true); say('Slice: ' + r.reason, true); return ended({ ok: false, reason: r.reason }); }
      S.result = r; S.sig = sig; S.setSig = setSig; S.pieces = pieces; S.profile = profile; S.settings = settings;
      try { showRaftView(r.raft); } catch (err) { console.error('[slice] raft view', err); }
      setBusy(false);
      var sup = pieces.filter(function (p) { return p.support && !p.brim; }).length;
      var procChanged = (r.changed || []).filter(function (k) { return !FILAMENT_KEY.test(k); }), filChanged = (r.changed || []).length > procChanged.length;
      var steps = bandWords(r.stats.tempBands, settings.tempBand);
      /* the bridge and retraction numbers, when a filament other than the profile's prints or one of those rows was changed */
      var tuned = (r.changed || []).some(function (k) { return /^(bridge_|filament_(flow_ratio|retraction_|deretraction_|z_hop))/.test(k); });
      readout(describe(r) + ' - ' + pieces.length + ' object' + (pieces.length === 1 ? '' : 's') + (sup ? ' (' + sup + ' support' + (sup === 1 ? '' : 's') + ')' : '') +
              (procChanged.length ? ' - ' + settingsWords(settings) : '') + (filChanged && r.filament ? ' - ' + r.filament : '') + (tuned && r.tune ? ' - ' + r.tune : '') +
              (steps ? ' - ' + steps : '') + (r.stats.bridgeTemp ? ' - ' + bridgeTempWords(r.stats.bridgeTemp) : ''), false);
      say('Sliced for the ' + profile.short + ': ' + describe(r));
      refresh();                          // a piece moved while it ran: the readout says so, and Export stays shut
      return ended({ ok: true, reason: '', line: describe(r), fresh: isFresh(), stacks: r.stacks || null });
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

  /**
   * The supports card's Generate sliced the plate before its supports were placed (hook.pieces, each new support under a key of its own); once
   * placed, the slice is the plate's: `ids` maps those keys to the pieces' ids, and the slice is signed for the plate as it now stands - its
   * drawing is not what is sliced (nsoSupportSliceSoup), so the slice is fresh for Preview and Export.
   */
  function adopt(ids) {
    if (!S.result || !S.result.ok || !S.pieces) return false;
    S.pieces = S.pieces.map(function (p) { return ids && ids[p.sourceId] != null ? Object.assign({}, p, { sourceId: ids[p.sourceId] }) : p; });
    S.sig = plateSignature();
    if (!RAFT_VIEW.group && S.result.raft) { try { showRaftView(S.result.raft); } catch (err) { console.error('[slice] raft view', err); } }
    refresh();
    return true;
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
    saveBytes(f.bytes, f.name);
    say('Downloaded ' + f.name);
  }

  function previewInGscope(how) {
    var f = freshFile();
    if (!f) return false;
    var MS = root.NSO_MICROSCOPE;
    if (!MS || !MS.openFile) { readout('G-scope did not load - check console.', true); return false; }
    var asSlice = !!(how && how.asSlice && MS.openSlice);     /* G-scope's Slice switch: the plate's slice, not an imported file */
    var menu = $('menu-supports');
    if (menu) menu.open = false;
    // a copy: G-scope reads the bytes, and the card keeps its file for Export
    var rec = { name: f.name, bytes: f.bytes, pieces: S.pieces, labels: S.result.labels || [], profile: S.profile, settings: S.settings || null };
    /* MULTI-PLATE PREVIEW (the owner: "allow multi plate preview, since we have up to 6 plates"): with more than one bed, bed N's slice
       lands on G-scope's plate N, so plate 1's preview stays when plate 2's opens - two support runs side by side, ready for Compare.
       One bed: the active G-scope plate, as ever. */
    var B = root.NSO_BEDS, where = B && B.count && B.count() > 1 ? { plate: B.activeNumber() } : undefined;
    var opened = (asSlice ? MS.openSlice : MS.openFile)(f.name, f.bytes.slice().buffer, where);
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
  /** A name a person typed, as a .gcode.3mf's: no path characters, and the ending put back if it was dropped. '' for nothing usable. */
  function gcodeName(typed) {
    var n = String(typed == null ? '' : typed).replace(/[\/\\?%*:|"<>]/g, '').replace(/\s+/g, ' ').trim().replace(/(\.gcode)?(\.3mf)?$/i, '');
    return n ? n + '.gcode.3mf' : '';
  }
  /**
   * Save as: the sliced file under a name (and, where the browser has a save dialog, in a folder) its owner picks. Chrome and Edge open the
   * system's save dialog (showSaveFilePicker); Safari and Firefox have none for a page, so the name is asked for and the file goes to
   * Downloads under it. Resolves the name saved, or '' when it was cancelled.
   */
  function saveAs(bytes, suggested) {
    if (typeof root.showSaveFilePicker === 'function') {
      return root.showSaveFilePicker({ suggestedName: suggested, types: [{ description: 'Bambu sliced file', accept: { 'application/octet-stream': ['.3mf'] } }] })
        .then(function (h) { return h.createWritable().then(function (w) { return w.write(new Blob([bytes])).then(function () { return w.close(); }); }).then(function () { return h.name; }); })
        .catch(function (err) { if (err && err.name === 'AbortError') return ''; throw err; });
    }
    var typed = typeof root.prompt === 'function' ? root.prompt('Save the sliced file as:', suggested) : suggested;
    var name = gcodeName(typed);
    if (!name) return Promise.resolve('');
    saveBytes(bytes, name);
    return Promise.resolve(name);
  }
  function exportFileAs() {
    var f = freshFile();
    if (!f) return;
    saveAs(f.bytes, f.name).then(function (name) { if (name) say('Saved ' + name); })
      .catch(function (err) { console.error('[save as]', err); say('Save as failed: ' + ((err && err.message) || err), true); });
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
    /* the Slice card is the supports card's last section (Generate slices the plate; this re-slices it with changed settings, and exports) */
    if (!$('slice-card')) return;
    var menu = $('menu-supports');
    var bind = function (id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); };
    bind('btn-slice-go', function () { slice(); });
    bind('btn-slice-cancel', cancel);
    bind('btn-slice-export', exportFile);
    bind('btn-slice-saveas', exportFileAs);
    bind('btn-slice-preview', previewInGscope);
    bind('slice-settings-toggle', function () { var box = $('slice-settings'); setSettingsOpen(!!(box && box.hidden)); });
    bind('slice-settings-reset', function () { seedSettings(profileFor(plateId()), true); refresh(); });
    bind('slice-project-use', function () { var pj = plateProject(); if (pj) useProject(pj); });
    SET_IDS.forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('change', function () {
        if (id !== 'slice-set-iface') S.touched = true;           // the interface is a preference, not a profile value
        if (id === 'slice-set-iface' && typeof root.nsoSetSupportInterfaceRule === 'function') root.nsoSetSupportInterfaceRule(el.value);
        if (id === 'slice-set-filament') showFilamentRows();      // another filament: its own temperatures, max flow, flow ratio and retraction in its rows
        if (id === 'slice-set-wall-gen') wallRows();              // Arachne: its levers; Classic: none
        filamentNote(); bridgeNote();
        refresh();
      });
    });
    bind('ms-btn-plate-gcode3mf', function () { exportFromCard('gcode3mf', false); });
    bind('ms-btn-plate-3mf', function () { exportFromCard('3mf', false); });
    bind('ms-btn-sel-gcode3mf', function () { exportFromCard('gcode3mf', true); });
    bind('ms-btn-sel-3mf', function () { exportFromCard('3mf', true); });
    if (menu) menu.addEventListener('toggle', function () { if (menu.open) refresh(); });
    /* the plate picker is the printer: the line, the settings and a slice's freshness follow it at once */
    var plateSel = $('plate-select');
    if (plateSel) plateSel.addEventListener('change', function () { setTimeout(refresh, 0); });
    /* ...and a printer changed by anything but a hand on that picker (a file opened that brings its plate, a plate switched, an Undo): the line
       said "A1 mini" under a Printer row that said P1S. The open card looks twice a second and follows. */
    setInterval(function () { if (menu && menu.open && !S.busy && plateId() !== S.shownPlate) refresh(); }, 500);
    setInterval(checkProject, 500);       /* a Studio project put on the plate (or taken off it), card open or shut */
    refresh();
  }

  api.sliceOptionsForPlate = sliceOptionsForPlate;
  api.card = { raftView: function () { return RAFT_VIEW.group ? { layers: RAFT_VIEW.group.children.length, lowered: RAFT_VIEW.lowered.length } : null; }, slice: slice, sliceAndPreview: sliceAndPreview, cancel: cancel, adopt: adopt, fresh: function () { return isFresh(); }, report: function () { return isFresh() ? S.result.report || null : null; }, canSlice: function () { return !!profileFor(plateId()); }, readPieces: function () { return readPieces(); }, exportFile: exportFile, previewInGscope: previewInGscope, refresh: refresh,
               exportSlice: exportSlice, exportFromCard: exportFromCard, indicesFor: indicesFor,
               state: function () { return { busy: S.busy, result: S.result, fresh: isFresh() }; } };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  return api;
});
