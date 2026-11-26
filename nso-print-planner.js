/*
 * NSO print planner
 * -----------------
 * The in-house slicer's toolpath (nso_slicer.js sliceObjects()) as the G-code
 * Bambu Studio itself would write for the same plate: speeds, accelerations,
 * retraction, wipe, z-hop, temperatures and fans taken from the printer
 * template, so a .gcode.3mf made from it prints on the printer without a
 * slice in Studio (docs/PRINT-PLANNER.md).
 *
 * ENGINE ONLY. No card, no UI, nothing in the page loads it. nso_slicer.js's
 * toGcode() stays as it is: it is G-scope's own text (a toolpath to read), not
 * a printable file. This module never feeds G-scope.
 *
 * INPUT. The shared engine's result:
 *   res.planes                 [{ printZ, h }]
 *   res.objects[i].layers[j]   { printZ, h, paths: [{ feature, width, closed, pts }], sectionPolys }
 * and the printer template's project settings (the object Studio saves in
 * Metadata/project_settings.config) plus NSO's cooling profile. Features are
 * Bambu's own names; a support object's paths are typed Support / Support
 * interface / Support transition by the engine and are written under those
 * names.
 *
 * WHAT THE TEMPLATE OWNS, AND WHAT NSO OWNS
 *   template   every speed, acceleration, retraction, z-hop, wipe, temperature,
 *              bed temperature, filament flow ratio and volumetric limit
 *   NSO        the 14 cooling keys (nso-cooling-profiles.js): fans, slowdown
 *
 * THE FILAMENT (docs/FILAMENTS.md). The template's filament is PLA. Another
 * filament is the caller's: its keys written into the config it hands over
 * (type, temperatures, volumetric limit, retraction), its cooling as
 * opts.cooling, its own filament start G-code as opts.filamentStart. The start
 * block follows the config: the filament's type, its flush speed and
 * temperature, and the purge line's speed (Bambu's outer_wall_volumetric_speed)
 * are tokens in the frozen block, so a 3.2 mm^3/s TPU is not purged at PLA's 12.
 *
 * TEMPERATURE STEPS (opts.tempSteps { stepC, bandMm }). The nozzle temperature
 * changes by stepC at every bandMm of height: a layer whose underside is at or
 * above n x bandMm prints at nozzle_temperature + n x stepC. Written as M104
 * (no wait: an M109 parks the nozzle on the part while it settles) at the layer
 * change. A step outside the filament's nozzle_temperature_range is refused.
 *
 * BRIDGE TEMPERATURE (opts.bridgeTemp, docs/FILAMENTS.md). A layer's bridges are
 * printed at their own nozzle temperature. A hotend takes tens of seconds to
 * change, so the change is made off the part: the filament is retracted, the nozzle is lifted and parked where the printer
 * purges (PARK), M109 waits there, a little is primed and wiped off, and the
 * nozzle comes back. It is done at a layer change, for a whole stretch: a layer
 * with bridges over open air (BRIDGE_TEMP_MIN_MM or more: one over sparse infill is held from below) prints whole at the bridge
 * temperature, and so does the layer over it; the layer after that the same
 * park brings the layer's own temperature back. One change in and one out a
 * stretch. The park is each printer's own moves: the A1 mini's only, so far.
 *
 * HOW A SPEED IS CHOSEN (measured on the owner's A1 mini and P1S slices)
 *   v = min(feature speed, filament_max_volumetric_speed / bead area)
 *   - bead area is the stadium nso-gcode-lines.js inverts: h (w - h) + pi h^2 / 4
 *   - the first layer takes initial_layer_speed (walls, supports) or
 *     initial_layer_infill_speed (infill, bottom surface)
 *   - uniform_cooling: a layer faster than slow_down_layer_time is slowed to
 *     one common speed (never under slow_down_min_speed); quality_first scales
 *     every move by one factor instead
 *   E = bead area x length / filament area x filament_flow_ratio (Bambu's 0.98)
 *
 * API
 *   settingsFrom(config, cooling)   -> the numbers the planner uses
 *   plan(res, opts)                 -> { ok, gcode, layers, stats, settings }
 *   coolingValues(profileId)        -> NSO's cooling keys as numbers
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSOPrintPlanner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var node = typeof module === 'object' && module.exports;
  var Cooling = node ? require('./nso-cooling-profiles.js') : root.NSOCoolingProfiles;
  var lazy = function (file, global) { return node ? require('./' + file) : root[global]; };

  var EPS = 1e-9;
  var RETRACT_DURING_WIPE = 0.95;      // Bambu wipes 0.76 of 0.8 and retracts the last 0.04 after (A1 mini slice)
  var SPIRAL_R = 1.2;                  // mm, the layer-change z-hop circle (Bambu's runs 1.217)
  var BRIDGE_TEMP_MIN_MM = 10;         // a layer with less bridge than this is not a bridge layer
  var BRIDGE_TEMP_COVER = 1;           // layers over a bridge layer that stay at the bridge temperature (laid straight onto the bridge)
  var BRIDGE_TEMP_JOIN = 2;            // warm layers between two cold stretches that are not worth coming up for
  var BRIDGE_TEMP_LIFT = 0.4;          // mm the nozzle is lifted to leave for the park (the timelapse hook's own)
  var BRIDGE_TEMP_PRIME = 1;           // mm of filament primed at the park once the temperature is reached, beyond the retraction
  /* COOL WAIT (opts.coolWait, s): a layer that, slowed to slow_down_min_speed, still prints faster than this is followed by a wait off the part -
     lifted, moved aside, the fan on - for the rest of it, so the next layer goes down on plastic that has set. The owner's CR-TPU capsule
     (A1 mini, 2026-11-25): necks 1.5 mm across printed in 2 s a layer at 10 mm/s, the tip stayed soft, bent under the nozzle and wound into a knot
     at the same height twice. No filament is spent on it (a sacrificial pillar would be). */
  var COOL_WAIT_LIFT = 1;              // mm above the layer just printed
  var COOL_WAIT_AWAY = 10;             // mm off the layer's own outline, in X
  var COOL_WAIT_MIN = 0.5;             // s: a shorter wait is not worth the moves
  var BRIDGE_TEMP_SECONDS = 15;        // what one change is counted as in the print's time: the owner timed the wait at 10-12 s (A1 mini, 235 <-> 215), plus the moves
  /* Where a printer waits for a nozzle temperature in the middle of a print, by its frozen id: its own moves, off its own G-code.
     A1 mini: the purge position at the left end of the gantry (the start block purges at X-13.5; the timelapse hook goes there every
     layer by "G1 X0 Y{CY} F18000" then "G1 X-13.0 F3000"), and the wipe is the start block's "wipe and shake", all three passes of it
     (two left a tail of TPU on the part: the owner's prints of 2026-11-14). {CY} is the plate's
     first-layer centre, as the hook has it. The P1S's chute is behind the bed and has its own moves: not written yet. */
  /* the printers whose Studio puts the timelapse at the layer change, before the layer's first travel: a core-XY's (Studio's GCode.cpp:
     need_insert_timelapse_gcode_for_traditional is an i3's - the A1 mini's, after its first run of walls). The owner's P1S slices, single
     and multi-colour, all have it there: the spiral lift, the photo, then the object and the travel. */
  var HOOK_AT_LAYER_START = { 'p1s-0.4': true };
  /* the printers whose Studio writes the objects still to print (M639; see the planner's "THE OBJECTS STILL TO PRINT") */
  var REMAINING = { 'p1s-0.4': true };
  var PARK = {
    'a1mini-0.4': {
      go: ['G1 X0 Y{CY} F18000', 'G1 X-13.5 F3000'],
      wipe: ['G1 X0 F30000 ;wipe and shake', 'G1 X-13.5 F3000', 'G1 X0 F30000 ;wipe and shake', 'G1 X-13.5 F3000', 'G1 X0 F12000 ;wipe and shake']
    }
  };

  // ===========================================================================
  // Settings
  // ===========================================================================

  /** A config value as a string: the first slot of a per-filament array. */
  function raw(config, key) {
    var v = config[key];
    if (Array.isArray(v)) v = v[0];
    return v == null ? '' : String(v).trim();
  }

  /** A number from the config. "N%" is N percent of `base` when a base is
   *  given, else N. Absent or empty -> `def`. */
  function num(config, key, def, base) {
    var s = raw(config, key);
    if (s === '') return def;
    var n = parseFloat(s);
    if (!isFinite(n)) return def;
    return s.charAt(s.length - 1) === '%' && base != null ? base * n / 100 : n;
  }

  /** NSO's 14 cooling keys as numbers ("50%" -> 50, "uniform_cooling" kept). */
  function coolingValues(profileIdOrValues) {
    var v = typeof profileIdOrValues === 'object' && profileIdOrValues
      ? profileIdOrValues : Cooling.resolveValues(profileIdOrValues);
    var out = {};
    Object.keys(v).forEach(function (k) {
      out[k] = /^[a-z_]+$/.test(v[k]) && isNaN(+v[k]) ? v[k] : parseFloat(v[k]);
    });
    return out;
  }

  /**
   * The planner's numbers. `config` is the template's project_settings object;
   * `cooling` is NSO's cooling profile (an id, or the resolved key map), and
   * wins over the template's own value for each of its 14 keys.
   */
  function settingsFrom(config, cooling) {
    var cool = coolingValues(cooling == null ? Cooling.DEFAULT_PROFILE_ID : cooling);
    var def = num(config, 'default_acceleration', 6000);
    var travel = num(config, 'travel_speed', 300);
    var accel = function (key, fallback) {
      var a = num(config, key, 0, def);
      return a > 0 ? a : fallback;
    };
    var bedType = raw(config, 'curr_bed_type') || 'Textured PEI Plate';
    var bedKey = {
      'Cool Plate': 'cool_plate_temp', 'Engineering Plate': 'eng_plate_temp',
      'High Temp Plate': 'hot_plate_temp', 'Textured PEI Plate': 'textured_plate_temp',
      'Supertack Plate': 'supertack_plate_temp'
    }[bedType] || 'textured_plate_temp';
    var nozzleT = num(config, 'nozzle_temperature', 220);
    // the filament's own retraction length (Studio's filament_retraction_length: 'nil' is "the printer's")
    var retractLen = num(config, 'filament_retraction_length', NaN);
    if (!isFinite(retractLen)) retractLen = num(config, 'retraction_length', 0.8);
    /* ...and so with the rest of the filament's retraction (Studio's filament "setting overrides"): each is the printer's unless the
       filament names its own */
    var own = function (filKey, key, def) { var v = num(config, filKey, NaN); return isFinite(v) ? v : num(config, key, def); };
    var retractV = own('filament_retraction_speed', 'retraction_speed', 30);
    var maxVol = num(config, 'filament_max_volumetric_speed', 12);
    var flushV = num(config, 'filament_flush_volumetric_speed', 0);
    var flushT = num(config, 'filament_flush_temp', 0);
    var rangeHigh = num(config, 'nozzle_temperature_range_high', 240);
    // Bambu's outer_wall_volumetric_speed (the start block's purge line): the outer wall's speed x its bead, never over the filament's limit
    var layerMm0 = num(config, 'layer_height', 0.2);
    var owVol = num(config, 'outer_wall_speed', 60) * beadArea(num(config, 'outer_wall_line_width', 0.42), layerMm0);
    if (maxVol > 0 && owVol > maxVol) owVol = maxVol;
    var S = {
      nozzleMm: num(config, 'nozzle_diameter', 0.4),
      infillWidthMm: num(config, 'sparse_infill_line_width', 0.45),   // the width the slicer lays a bridge's lines at (beadOf of a bridge over open air)
      layerMm: num(config, 'layer_height', 0.2),
      firstLayerMm: num(config, 'initial_layer_print_height', 0.2),
      speed: {
        outer: num(config, 'outer_wall_speed', 60),
        inner: num(config, 'inner_wall_speed', 60),
        sparse: num(config, 'sparse_infill_speed', 100),
        solid: num(config, 'internal_solid_infill_speed', 100),
        top: num(config, 'top_surface_speed', 60),
        first: num(config, 'initial_layer_speed', 30),
        firstInfill: num(config, 'initial_layer_infill_speed', 60),
        travel: travel,
        firstTravel: num(config, 'initial_layer_travel_speed', travel),
        support: num(config, 'support_speed', 60),
        interface: num(config, 'support_interface_speed', 40),
        bridge: num(config, 'bridge_speed', 25),
        gap: num(config, 'gap_infill_speed', 50),
        overhang: [num(config, 'overhang_1_4_speed', 0), num(config, 'overhang_2_4_speed', 50),
                   num(config, 'overhang_3_4_speed', 30), num(config, 'overhang_4_4_speed', 10)]
      },
      accel: {
        def: def,
        outer: accel('outer_wall_acceleration', def),
        inner: accel('inner_wall_acceleration', def),
        sparse: accel('sparse_infill_acceleration', def),
        solid: accel('internal_solid_infill_acceleration', def),
        top: accel('top_surface_acceleration', def),
        first: accel('initial_layer_acceleration', def),
        travel: accel('travel_acceleration', def),
        firstTravel: accel('initial_layer_travel_acceleration', def),
        short: accel('travel_short_distance_acceleration', def),
        bridge: accel('bridge_acceleration', def),
        support: accel('support_acceleration', def),
        interface: accel('support_interface_acceleration', def)
      },
      retract: {
        length: retractLen,
        speed: retractV,
        deretractSpeed: own('filament_deretraction_speed', 'deretraction_speed', retractV),
        restartExtra: num(config, 'retract_restart_extra', 0),
        hop: own('filament_z_hop', 'z_hop', 0.4),
        onLayerChange: num(config, 'retract_when_changing_layer', 1) !== 0,
        wipe: own('filament_wipe', 'wipe', 1) !== 0,
        wipeDistance: own('filament_wipe_distance', 'wipe_distance', 2),
        // Bambu's retract_before_wipe: this share of the retraction is pulled standing still, before the wipe; the rest during it
        beforeWipe: Math.max(0, Math.min(1, own('filament_retract_before_wipe', 'retract_before_wipe', 0) / 100)),
        // Bambu's seam_gap: a loop stops this short of its start (a % of the nozzle, or mm)
        seamGapMm: (function () { var v = String(raw(config, 'seam_gap') || '15%'); var n = parseFloat(v); if (!(n >= 0)) n = 15; return /%/.test(v) ? n / 100 * num(config, 'nozzle_diameter', 0.4) : n; })(),
        minTravel: own('filament_retraction_minimum_travel', 'retraction_minimum_travel', 1)
      },
      filament: {
        diameter: num(config, 'filament_diameter', 1.75),
        flow: num(config, 'filament_flow_ratio', 1),
        maxVolumetric: maxVol,
        bridgeFlow: num(config, 'bridge_flow', 1),
        thickBridges: num(config, 'thick_bridges', 0) === 1,                  // a bridge over open air as the round strand (Bambu's default: off)
        thickInternalBridges: num(config, 'thick_internal_bridges', 1) !== 0, // a bridge over sparse infill as the round strand (Bambu's default: on)
        type: raw(config, 'filament_type') || 'PLA',
        flushVolumetric: flushV > 0 ? flushV : maxVol,          // Studio's flush_volumetric_speeds
        flushTemp: flushT > 0 ? flushT : rangeHigh,             // Studio's flush_temperatures
        outerWallVolumetric: owVol
      },
      temp: {
        bedType: bedType,
        nozzle: nozzleT,
        nozzleInitial: num(config, 'nozzle_temperature_initial_layer', nozzleT),
        rangeLow: num(config, 'nozzle_temperature_range_low', 190),
        rangeHigh: rangeHigh,
        bed: num(config, bedKey, 60),
        bedInitial: num(config, bedKey + '_initial_layer', num(config, bedKey, 60))
      },
      fan: {
        closeFirst: num(config, 'close_fan_the_first_x_layers', 1),
        aux: num(config, 'auxiliary_fan', 0) === 1,
        auxPercent: num(config, 'additional_cooling_fan_speed', 0),
        closeAux: num(config, 'close_additional_fan_first_x_layers', 1)
      },
      jerk: num(config, 'machine_max_jerk_x', 9),
      cooling: cool
    };
    return S;
  }


  /**
   * The engine's options for a template: the nozzle, layer heights, line
   * widths, walls, shells and infill the printer's process profile names, so
   * the toolpath is cut the way Studio would cut it. Pass the result to
   * sliceObjects() (via NSO_Slicer.defaultsFor(nozzle, over)). Not applied here:
   * the planner takes whatever slice it is given.
   * @returns {{nozzleMm, over}}  defaultsFor(nozzleMm, over)
   */
  /* the project's pattern names the engine draws as themselves; every other one is its lines (zigzag) */
  var ENGINE_PATTERNS = { grid: 'grid', concentric: 'concentric', archimedeanchords: 'archimedeanchords', '3dhoneycomb': '3dhoneycomb', gyroid: 'gyroid', cubic: 'cubic', adaptivecubic: 'adaptivecubic', honeycomb: 'honeycomb', lightning: 'lightning' };
  var ENGINE_SURFACES = { concentric: 'concentric', archimedeanchords: 'archimedeanchords', hilbertcurve: 'hilbertcurve', octagramspiral: 'octagramspiral',
                         monotonic: 'monotonic', monotonicline: 'monotonicline' };

  /* a line width key: its own value, 0 / absent the profile's line_width, absent too: null (the slicer's own) */
  function lw(config, key) {
    var v = num(config, key, 0);
    if (!(v > 0)) v = num(config, 'line_width', 0);
    return v > 0 ? v : null;
  }
  function engineOptions(config) {
    var pct = function (key, def) { var v = num(config, key, def * 100); return v / 100; };
    var nozzle = num(config, 'nozzle_diameter', 0.4);
    var over = {
      layerMm: num(config, 'layer_height', 0.2),
      firstLayerMm: num(config, 'initial_layer_print_height', 0.2),
      outerWallWidthMm: lw(config, 'outer_wall_line_width') || 0.42,
      innerWallWidthMm: lw(config, 'inner_wall_line_width') || 0.42,
      infillWidthMm: lw(config, 'sparse_infill_line_width') || 0.42,
      supportWidthMm: lw(config, 'support_line_width') || 0.42,
      /* every line the profile sizes (Studio's Line width section; 0 there is the profile's line_width) */
      topWidthMm: lw(config, 'top_surface_line_width'),
      solidWidthMm: lw(config, 'internal_solid_infill_line_width'),
      firstLayerWidthMm: lw(config, 'initial_layer_line_width'),
      firstLayerInfillWidthMm: lw(config, 'initial_layer_infill_line_width'),
      topDensity: pct('top_surface_density', 1),
      bottomDensity: pct('bottom_surface_density', 1),
      topColorPenetrationLayers: raw(config, 'top_color_penetration_layers') !== '' ? num(config, 'top_color_penetration_layers', 5) : undefined,
      bottomColorPenetrationLayers: raw(config, 'bottom_color_penetration_layers') !== '' ? num(config, 'bottom_color_penetration_layers', 3) : undefined,
      wallLoops: num(config, 'wall_loops', 2),
      topShellLayers: num(config, 'top_shell_layers', 3),
      bottomShellLayers: num(config, 'bottom_shell_layers', 3),
      topShellThicknessMm: num(config, 'top_shell_thickness', 0),
      bottomShellThicknessMm: num(config, 'bottom_shell_thickness', 0),
      sparseDensity: pct('sparse_infill_density', 0.15),
      sparsePattern: ENGINE_PATTERNS[raw(config, 'sparse_infill_pattern')] || 'zigzag',
      infillDirectionDeg: num(config, 'infill_direction', 45),
      detectThinWall: num(config, 'detect_thin_wall', 0) === 1,
      // the wall generator and Arachne's six levers (nso_slicer.js arachneWalls); a percentage is of the nozzle, as the slicer takes it
      wallGenerator: raw(config, 'wall_generator') === 'arachne' ? 'arachne' : 'classic',
      wallTransitionAngleDeg: num(config, 'wall_transition_angle', 10),
      wallTransitionFilterMargin: pct('wall_transition_filter_deviation', 0.25),
      wallTransitionLength: pct('wall_transition_length', 1),
      wallDistributionCount: num(config, 'wall_distribution_count', 1),
      minBeadWidth: pct('min_bead_width', 0.85),
      minFeatureSize: pct('min_feature_size', 0.25),
      supportThresholdDeg: num(config, 'support_threshold_angle', 30),
      // the project's own brim: auto_brim (a tall thin part gets one), outer_only / outer_and_inner (every part), no_brim
      brimType: ({ auto_brim: 'auto', outer_only: 'outer', outer_and_inner: 'outer', no_brim: 'none' })[raw(config, 'brim_type')] || 'none',
      brimWidthMm: num(config, 'brim_width', 5),
      brimObjectGapMm: num(config, 'brim_object_gap', 0.1),
      // the raft (nso_slicer.js raftPlan): Bambu's raft_layers, its contact gap and expansion, and the line spacings it lays them at
      raftLayers: num(config, 'raft_layers', 0),
      raftContactMm: num(config, 'raft_contact_distance', 0.1),
      raftExpansionMm: num(config, 'raft_expansion', 1.5),
      raftBaseSpacingMm: num(config, 'support_base_pattern_spacing', 2.5),
      raftInterfaceSpacingMm: num(config, 'support_interface_spacing', 0.5),
      supportInterfaceSpacingMm: num(config, 'support_interface_spacing', 0.5),
      // the stack's first layer turns support_angle + 90; its top crosses the part's bridge, laid at bridge_angle (0: Studio's own choice)
      supportAngleDeg: num(config, 'support_angle', 0),
      bridgeAngleDeg: num(config, 'bridge_angle', 0)
    };
    /* where the G-code's origin is in the slicer's frame: the pieces are placed about the bed's middle (printable_area), the G-code is the plate
       less the extruder offset - a monotonic line top lies on Studio's grid of the G-code itself (docs/SLICER.md "Monotonic") */
    var paRaw = config ? config.printable_area : null;
    var pa = (Array.isArray(paRaw) ? paRaw : String(paRaw || '').split(',')).map(function (q) { var m = /(-?[\d.]+)\s*x\s*(-?[\d.]+)/.exec(q); return m ? [+m[1], +m[2]] : null; }).filter(Boolean);
    if (pa.length >= 3) {
      var bx = Math.max.apply(null, pa.map(function (q) { return q[0]; })), by = Math.max.apply(null, pa.map(function (q) { return q[1]; })), eo = extruderOffset(config);
      over.gridOriginMm = [eo.x - bx / 2, eo.y - by / 2];
    }
    /* a surface or the solid infill the project draws in rings (the other patterns are the engine's lines) */
    var own = function (key) { return ENGINE_SURFACES[raw(config, key)] || null; };
    if (own('internal_solid_infill_pattern')) over.solidPattern = own('internal_solid_infill_pattern');
    if (own('top_surface_pattern')) over.topPattern = own('top_surface_pattern');
    if (own('bottom_surface_pattern')) over.bottomPattern = own('bottom_surface_pattern');
    return { nozzleMm: nozzle, over: over };
  }

  // ===========================================================================
  // Features -> speed and acceleration
  // ===========================================================================

  function beadArea(w, h) { return h * (w - h) + Math.PI * h * h / 4; }

  var WALL = { 'Outer wall': 1, 'Inner wall': 1, 'Overhang wall': 1, 'Floating vertical shell': 1 };
  var SUPPORT = { 'Support': 1, 'Support interface': 1, 'Support transition': 1 };

  /**
   * The feature's configured speed and acceleration (mm/s, mm/s^2) on a layer,
   * before the volumetric limit and the layer-time slowdown.
   */
  function featureSpeed(S, feature, first) {
    var sp = S.speed, ac = S.accel, v, a;
    switch (feature) {
      case 'Outer wall': v = sp.outer; a = ac.outer; break;
      case 'Inner wall': v = sp.inner; a = ac.inner; break;
      case 'Floating vertical shell': v = sp.inner; a = ac.inner; break;
      // The engine does not grade an overhang by how far it hangs; the 4/4
      // speed is the slowest and the safe one (Bambu's own 4/4 is 10 mm/s)
      case 'Overhang wall': v = sp.overhang[3] > 0 ? sp.overhang[3] : sp.outer; a = ac.outer; break;
      case 'Sparse infill': v = sp.sparse; a = ac.sparse; break;
      case 'Internal solid infill': v = sp.solid; a = ac.solid; break;
      case 'Top surface': v = sp.top; a = ac.top; break;
      case 'Bottom surface': v = sp.solid; a = ac.solid; break;
      case 'Bridge': v = sp.bridge; a = ac.bridge; break;
      case 'Gap infill': v = sp.gap; a = ac.inner; break;
      case 'Support': v = sp.support; a = ac.support; break;
      // Bambu's transition layers print at the support speed (decision, see the docs)
      case 'Support transition': v = sp.support; a = ac.support; break;
      case 'Support interface': v = sp.interface; a = ac.interface; break;
      default: v = sp.inner; a = ac.inner;
    }
    if (first) {
      var infill = feature === 'Sparse infill' || feature === 'Internal solid infill' ||
                   feature === 'Bottom surface' || feature === 'Top surface' || feature === 'Gap infill';
      v = Math.min(v, infill ? sp.firstInfill : sp.first);
      a = ac.first;
    }
    return { v: v, a: a };
  }

  /**
   * What a path prints at: its width and bead height, and its area.
   * A BRIDGE IS BAMBU'S, BY ITS KIND (the owner's Studio slices, each with thick_bridges = 0: the A1 mini coupon, the P1S mouse, the CR-TPU
   * towers). Over open air (`free`, the slicer's path.free) it is a line of the layer's own height - Studio writes LAYER_HEIGHT 0.2 and a
   * LINE_WIDTH of 0.40 to 0.43 for it - unless the profile asks for thick bridges; over sparse infill it is the round strand of the
   * nozzle's diameter (Studio's 0.4 x 0.4, thick_internal_bridges) unless the profile turns that off. bridge_flow scales either. NSO laid
   * every bridge as the round strand: 1.6 times the plastic of Studio's over a gap, and for a filament held to a volumetric limit a slower one.
   */
  function beadOf(S, feature, width, h, free) {
    if (feature === 'Bridge') {
      if (free ? S.filament.thickBridges : S.filament.thickInternalBridges) {
        var d = S.nozzleMm * Math.sqrt(S.filament.bridgeFlow);
        return { w: d, h: d, area: beadArea(d, d) };
      }
      var wb = width * S.filament.bridgeFlow;                 /* the line's own width, as much narrower as the bridge flow asks */
      return { w: wb, h: h, area: beadArea(width, h) * S.filament.bridgeFlow };
    }
    return { w: width, h: h, area: beadArea(width, h) };
  }

  // ===========================================================================
  // Time: a move is a trapezoid
  // ===========================================================================

  /** Seconds to cover `len` mm at `v` mm/s, starting and ending at rest, with
   *  acceleration `a` mm/s^2. */
  function moveSeconds(len, v, a) {
    if (!(len > 0)) return 0;
    if (!(v > 0)) return 0;
    if (!(a > 0)) return len / v;
    var ramp = v * v / a;                 // distance of the up-and-down ramps together
    return len >= ramp ? len / v + v / a : 2 * Math.sqrt(len / a);
  }

  /**
   * Seconds for a run of straight moves the machine takes without stopping:
   * [{ l: length, ux, uy: direction, v: speed cap, a: acceleration }].
   * The machine's own look-ahead, in the classic-jerk form: a corner is taken
   * at the speed that changes the velocity vector by no more than `jerk`
   * (jerk / |u1 - u2|, never above either move's speed), and the run starts
   * and ends at `jerk` (or the move's speed if lower); acceleration limits each
   * move's entry and exit both ways (backward then forward pass), and each move
   * is then a trapezoid - or a triangle when it is too short to reach its cap.
   */
  function runSeconds(segs, jerk) {
    var n = segs.length;
    if (!n) return 0;
    var j = new Array(n + 1), i;
    j[0] = Math.min(segs[0].v, jerk);
    j[n] = Math.min(segs[n - 1].v, jerk);
    for (i = 1; i < n; i++) {
      var p = segs[i - 1], q = segs[i];
      var du = Math.hypot(p.ux - q.ux, p.uy - q.uy);
      j[i] = Math.min(p.v, q.v, du > 1e-9 ? jerk / du : Infinity);
    }
    for (i = n - 1; i >= 0; i--) j[i] = Math.min(j[i], Math.sqrt(j[i + 1] * j[i + 1] + 2 * segs[i].a * segs[i].l));
    for (i = 0; i < n; i++) j[i + 1] = Math.min(j[i + 1], Math.sqrt(j[i] * j[i] + 2 * segs[i].a * segs[i].l));
    var t = 0;
    for (i = 0; i < n; i++) {
      var sg = segs[i], ve = j[i], vx = j[i + 1];
      var vp = Math.sqrt((2 * sg.a * sg.l + ve * ve + vx * vx) / 2);
      if (vp > sg.v) {
        t += (sg.v - ve) / sg.a + (sg.v - vx) / sg.a +
          (sg.l - (sg.v * sg.v - ve * ve) / (2 * sg.a) - (sg.v * sg.v - vx * vx) / (2 * sg.a)) / sg.v;
      } else {
        t += (vp - ve) / sg.a + (vp - vx) / sg.a;
      }
    }
    return t;
  }

  /** One path at speed `v`: the look-ahead over its own corners. */
  function itemSeconds(it, v, S) {
    for (var i = 0; i < it.segs.length; i++) { it.segs[i].v = v; it.segs[i].a = it.a; }
    return runSeconds(it.segs, S.jerk);
  }

  /** One straight travel. */
  function travelSeconds(d, v, a, S) {
    return d > 0 ? runSeconds([{ l: d, ux: 1, uy: 0, v: v, a: a }], S.jerk) : 0;
  }


  /**
   * The print's time, line by line, from the G-code the planner itself wrote
   * (and Studio's: the same function times both files - print:planner holds it
   * to Studio's own prediction on three of its slices). F, M204 and the moves
   * are read back; each run of XY moves goes through the look-ahead
   * (runSeconds), anything that stops the machine (a Z-only move, a retraction
   * on its own) ends the run. Arcs are cut to 0.3 mm chords.
   * @param {string[]} lines
   * @param {{jerk, zMax, accel}} o
   * @returns {{seconds, times}} times[i]: seconds from the first line to the end of line i's move
   */
  function estimateLines(lines, o) {
    o = o || {};
    var jerk = o.jerk || 9, zMax = o.zMax || 30;
    var F = 1000, A = o.accel || 6000, x = 0, y = 0, z = 0, t = 0;
    var times = new Float64Array(lines.length);
    var run = [], runLine = [];
    function flush() {
      if (!run.length) return;
      var segs = run, t0 = t;
      // the look-ahead over the run, with each move's end time kept
      var n = segs.length, j = new Array(n + 1), i;
      j[0] = Math.min(segs[0].v, jerk); j[n] = Math.min(segs[n - 1].v, jerk);
      for (i = 1; i < n; i++) {
        var p = segs[i - 1], q = segs[i], du = Math.hypot(p.ux - q.ux, p.uy - q.uy);
        j[i] = Math.min(p.v, q.v, du > 1e-9 ? jerk / du : Infinity);
      }
      for (i = n - 1; i >= 0; i--) j[i] = Math.min(j[i], Math.sqrt(j[i + 1] * j[i + 1] + 2 * segs[i].a * segs[i].l));
      for (i = 0; i < n; i++) j[i + 1] = Math.min(j[i + 1], Math.sqrt(j[i] * j[i] + 2 * segs[i].a * segs[i].l));
      for (i = 0; i < n; i++) {
        var sg = segs[i], ve = j[i], vx = j[i + 1], vp = Math.sqrt((2 * sg.a * sg.l + ve * ve + vx * vx) / 2);
        t += vp > sg.v
          ? (sg.v - ve) / sg.a + (sg.v - vx) / sg.a + (sg.l - (sg.v * sg.v - ve * ve) / (2 * sg.a) - (sg.v * sg.v - vx * vx) / (2 * sg.a)) / sg.v
          : (vp - ve) / sg.a + (vp - vx) / sg.a;
        times[runLine[i]] = t;
      }
      run = []; runLine = [];
      return t0;
    }
    for (var li = 0; li < lines.length; li++) {
      var s = lines[li], m;
      if (typeof s !== 'string') { times[li] = t; continue; }
      if (s.charCodeAt(0) === 77 && (m = /^M204 S(\d+)/.exec(s))) { A = +m[1]; times[li] = t; continue; }
      /* a dwell in ms (NSO's cool wait writes G4 P; Studio's own dwells are G4 S and stay uncounted, as its estimate leaves them) */
      if (s.charCodeAt(0) === 71 && (m = /^G4 P(\d+)/.exec(s))) { flush(); t += +m[1] / 1000; times[li] = t; continue; }
      if (!/^G[0123] /.test(s)) { times[li] = t; continue; }
      var w = {};
      s.replace(/([XYZEFIJP])(-?[\d.]+)/g, function (a, k, v) { w[k] = +v; return a; });
      if (w.F !== undefined) F = w.F;
      var v = Math.max(F / 60, 0.1), g = +s.charAt(1);
      var nx = w.X !== undefined ? w.X : x, ny = w.Y !== undefined ? w.Y : y, nz = w.Z !== undefined ? w.Z : z;
      var dxy = Math.hypot(nx - x, ny - y), dz = nz - z;
      if (g === 2 || g === 3) {
        var cx = x + (w.I || 0), cy = y + (w.J || 0), r = Math.hypot(w.I || 0, w.J || 0);
        var full = w.X === undefined && w.Y === undefined;
        var a0 = Math.atan2(y - cy, x - cx), a1 = full ? a0 : Math.atan2(ny - cy, nx - cx), sweep = a1 - a0;
        if (g === 2) { while (sweep >= 1e-9) sweep -= 2 * Math.PI; if (full) sweep = -2 * Math.PI; }
        else { while (sweep <= -1e-9) sweep += 2 * Math.PI; if (full) sweep = 2 * Math.PI; }
        var cn = Math.max(1, Math.ceil(Math.abs(sweep) * r / 0.3)), px = x, py = y;
        for (var k = 1; k <= cn; k++) {
          var ang = a0 + sweep * k / cn, qx = cx + r * Math.cos(ang), qy = cy + r * Math.sin(ang);
          var l2 = Math.hypot(qx - px, qy - py) + Math.abs(dz) / cn;
          if (l2 > 1e-9) { run.push({ l: l2, ux: (qx - px) / l2, uy: (qy - py) / l2, v: v, a: A }); runLine.push(li); }
          px = qx; py = qy;
        }
        x = nx; y = ny; z = nz;
        continue;
      }
      if (dxy < 1e-9 && Math.abs(dz) < 1e-9) {
        if (w.E !== undefined) { flush(); t += Math.abs(w.E) / v; }
        times[li] = t; continue;
      }
      if (dxy < 1e-9) { flush(); t += Math.abs(dz) / Math.min(v, zMax); z = nz; times[li] = t; continue; }
      var l = Math.hypot(dxy, dz);
      run.push({ l: l, ux: (nx - x) / l, uy: (ny - y) / l, v: v, a: A }); runLine.push(li);
      x = nx; y = ny; z = nz;
    }
    flush();
    return { seconds: t, times: times };
  }

  // ===========================================================================
  // Small geometry
  // ===========================================================================

  function fmt(v, d) {
    var s = (Math.abs(v) < 0.5 * Math.pow(10, -d) ? 0 : v).toFixed(d);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    // Bambu writes .5, not 0.5, and -.5, not -0.5
    return s.replace(/^(-?)0\./, '$1.');
  }
  /** A number as a comment or a tag writes it: 0.2, not .2. */
  function fc(v, d) {
    var s = (Math.abs(v) < 0.5 * Math.pow(10, -d) ? 0 : v).toFixed(d);
    return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  }
  function fx(v) { return fmt(v, 3); }
  function fe(v) { return fmt(v, 5); }

  function dist(a, b) { return Math.hypot(b[0] - a[0], b[1] - a[1]); }

  function pathLength(pts) {
    var l = 0;
    for (var i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
    return l;
  }

  /** Even-odd point-in-rings (the engine's sectionPolys hold outers and holes). */
  function insideRings(rings, x, y) {
    var c = false;
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var a = ring[i], b = ring[j];
        if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
      }
    }
    return c;
  }

  /** A straight travel that stays inside the layer's own section (sampled). */
  function travelInside(rings, p, q) {
    if (!rings || !rings.length) return false;
    var d = dist(p, q);
    var n = Math.max(2, Math.ceil(d / 0.5));
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      if (!insideRings(rings, p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)) return false;
    }
    return true;
  }

  /** A path less its last `mm`. */
  function trimEnd(pts, mm) {
    var out = pts.slice(), left = mm;
    while (out.length > 1 && left > EPS) {
      var a = out[out.length - 2], b = out[out.length - 1], d = dist(a, b);
      if (d <= left + EPS) { out.pop(); left -= d; continue; }
      out[out.length - 1] = [b[0] + (a[0] - b[0]) * left / d, b[1] + (a[1] - b[1]) * left / d];
      left = 0;
    }
    return out;
  }
  /** A loop's wipe: from where it stopped, on over its start for `wipeMm` (Bambu's, past the seam). */
  function wipeForward(from, loop, wipeMm) {
    var out = [from], left = wipeMm, cur = from;
    for (var i = 0; i < loop.length && left > EPS; i++) {
      var b = loop[i], d = dist(cur, b);
      if (d <= EPS) continue;
      if (d <= left) { out.push(b); left -= d; cur = b; }
      else { out.push([cur[0] + (b[0] - cur[0]) * left / d, cur[1] + (b[1] - cur[1]) * left / d]); left = 0; }
    }
    return out;
  }

  /** The last `wipeMm` of a path walked backwards: the wipe. */
  /* oneStroke (a top surface): the wipe goes back along the last stroke only - not on round the zig-zag's turns, where it folded over the
     short strokes of a corner and left a curl on the face; the rest of the retraction is taken standing (the Gulf logo's letters, 2026-11-23) */
  function wipePath(pts, wipeMm, oneStroke) {
    var out = [pts[pts.length - 1]];
    var left = oneStroke && pts.length > 1 ? Math.min(wipeMm, dist(pts[pts.length - 1], pts[pts.length - 2])) : wipeMm;
    for (var i = pts.length - 1; i > 0 && left > EPS; i--) {
      var a = pts[i], b = pts[i - 1];
      var d = dist(a, b);
      if (d <= EPS) continue;
      if (d <= left) { out.push(b); left -= d; }
      else { out.push([a[0] + (b[0] - a[0]) * left / d, a[1] + (b[1] - a[1]) * left / d]); left = 0; }
    }
    return out;
  }

  // ===========================================================================
  // Planning one layer
  // ===========================================================================

  /**
   * The layer's items in print order (object by object, the engine's path order
   * inside each), every one carrying what the emitter and the time model need.
   */
  function layerItems(res, li, S) {
    var plane = res.planes[li];
    var first = li === 0;
    var items = [];
    res.objects.forEach(function (ob, oi) {
      var L = ob.layers[li];
      if (!L || !L.paths.length) return;
      var rings = [];
      /* WHERE A TRAVEL NEED NOT RETRACT: Studio's (GCode::needs_retraction, reduce_infill_retraction) is a travel wholly inside the layer's
         sparse infill; every other travel of a part retracts and lifts - its tower slice retracts 371 of 377 times from an outer wall to
         solid infill. NSO took the whole section: a travel off the end of a wall that hung over an edge, across the solid, went at the
         layer's height, and the nozzle dragged the soft CR-TPU lip it had just laid (the owner, 2026-11-15, layer 41 of his tower level).
         A part's layer now carries its sparse region (sparsePolys); a support's travels keep its section, as Studio's keep its islands. */
      (L.sparsePolys ? L.sparsePolys : (L.sectionPolys || [])).forEach(function (p) { rings.push(p); });
      L.paths.forEach(function (p) {
        var pts = p.closed && p.pts.length ? p.pts.concat([p.pts[0]]) : p.pts;
        if (pts.length < 2) return;
        /* A LOOP ENDS AS BAMBU'S DOES (the owner's P1S prints: every trunk, then the 2x pillars and domes, split straight up the seam): a wall or a
           support ring (not a brim: Studio closes those) stops the seam gap short
           of its start and wipes on FORWARD over its own cooled start (loop) - the wipe back over the bead just laid, retracting, dragged the seam
           open on a 15 mm trunk ring */
        var loop = null;
        if (p.closed && p.feature !== 'Brim' && S.retract.seamGapMm > 0) {
          var full = pathLength(pts);
          if (full > 4 * S.retract.seamGapMm) { loop = pts; pts = trimEnd(pts, S.retract.seamGapMm); }
        }
        var bead = beadOf(S, p.feature, p.width, L.h || plane.h, !!p.free);
        var fs = featureSpeed(S, p.feature, first);
        /* a hanging wall that spans (the slicer's path.span) is a bridge: the bridge's speed, and no slowing for the layer's time */
        var spans = p.feature === 'Overhang wall' && !!p.span && !first;
        if (spans) fs = { v: S.speed.hang != null ? S.speed.hang : S.speed.bridge, a: S.accel.bridge };
        var vCap = S.filament.maxVolumetric > 0 ? S.filament.maxVolumetric / bead.area : Infinity;
        var v = Math.min(fs.v, vCap);
        var segs = [];
        for (var q = 1; q < pts.length; q++) {
          var sx = pts[q][0] - pts[q - 1][0], sy = pts[q][1] - pts[q - 1][1], sl = Math.hypot(sx, sy);
          if (sl > 1e-9) segs.push({ l: sl, ux: sx / sl, uy: sy / sl, v: 0, a: 0 });
        }
        items.push({
          obj: oi, slot: p.slot != null ? p.slot : (L.slot || 0), feature: p.feature, glide: !!p.glide, thin: !!p.thinWall, keep: p.feature === 'Bridge' || spans, pts: pts, closed: !!p.closed, loop: loop, segs: segs,
          bead: bead, vFeature: fs.v, vWipe: v, v: v, a: fs.a, len: pathLength(pts), rings: rings
        });
      });
    });
    return items;
  }

  /** Travel from the end of item k-1 to the start of item k: whether it
   *  retracts, hops, and how far. Fills `it.travel`. */
  function planTravels(items, S, from, retractAtEnd) {
    var pos = from;
    items.forEach(function (it, k) {
      var start = it.pts[0];
      var prev = k ? items[k - 1] : null;
      var d = pos ? dist(pos, start) : 0;
      var sameObj = prev && prev.obj === it.obj;
      var retract;
      if (!pos) retract = false;
      else if (prev && !sameObj) retract = true;            // from one object to another: always
      else if (d < S.retract.minTravel - EPS) retract = false;
      else if (sameObj && travelInside(it.rings, pos, start)) retract = false;
      else if (sameObj && it.glide) retract = false;   /* run to run inside one fill piece (the slicer's path.glide: a top run, a monotonic line, a gap woven in) */
      else retract = true;
      it.travel = { from: pos, d: d, retract: retract, hop: retract && S.retract.hop > 0 };
      if (prev) prev.retractAfter = retract;
      pos = it.pts[it.pts.length - 1];
    });
    if (items.length) items[items.length - 1].retractAfter = retractAtEnd;
    return pos;
  }

  /** Seconds the layer takes with every extrusion capped at `cap` mm/s
   *  (uniform_cooling), or scaled by `cap` (quality_first, cap < 1). */
  function layerSecondsOf(items, S, mode, cap) {
    var t = 0;
    var minV = S.cooling.slow_down_min_speed;
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      var v = it.v;
      if (cap != null) {
        if (it.keep) v = it.v;                                 // a bridge keeps its speed (and a wall that spans as one)
        else if (mode === 'quality_first') v = Math.max(Math.min(minV, it.v), it.v * cap);
        else v = Math.min(it.v, Math.max(cap, Math.min(minV, it.v)));
      }
      t += itemSeconds(it, v, S);
      if (it.travel.d > 0) t += travelSeconds(it.travel.d, S.speed.travel, S.accel.travel, S);
      if (it.travel.retract) t += 2 * S.retract.length / S.retract.speed;
    }
    return t;
  }

  /**
   * Layer cooling. Returns { seconds, cap, mode }: the layer's time before any
   * slowdown, and the speed (uniform) or factor (quality_first) that brings it
   * to slow_down_layer_time, or null when it needs none.
   */
  var layerSeconds = layerSecondsOf;
  function coolLayer(items, S, first, extraSeconds) {
    var c = S.cooling, ex = extraSeconds || 0;
    /* a filament change on the layer counts towards its time, as Studio's cooling buffer counts the whole layer's G-code: the owner's
       3-colour pyramid's change layers print at full speed where the layers beside them slow down */
    var layerSeconds = function (it, S0, logic, cap) { return layerSecondsOf(it, S0, logic, cap) + ex; };
    var t0 = layerSeconds(items, S, c.cooling_slowdown_logic, null);
    var out = { seconds: t0, cap: null, mode: c.cooling_slowdown_logic };
    if (first || !c.slow_down_for_layer_cooling || !(t0 < c.slow_down_layer_time) || !items.length) return out;
    var quality = c.cooling_slowdown_logic === 'quality_first';
    var lo = quality ? 0 : c.slow_down_min_speed, hi = quality ? 1 : Math.max.apply(null, items.map(function (i) { return i.v; }));
    // the layer at its slowest allowed: if even that is too fast, that is the cap
    if (layerSeconds(items, S, c.cooling_slowdown_logic, lo) <= c.slow_down_layer_time) { out.cap = lo; return out; }
    for (var n = 0; n < 40; n++) {
      var mid = (lo + hi) / 2;
      if (layerSeconds(items, S, c.cooling_slowdown_logic, mid) > c.slow_down_layer_time) lo = mid; else hi = mid;
    }
    out.cap = hi;
    return out;
  }

  /** The part-cooling fan for a layer, 0-255 (Bambu: between fan_min_speed at
   *  fan_cooling_layer_time and fan_max_speed at slow_down_layer_time). */
  function fanFor(S, layerIndex, layerSeconds0) {
    var c = S.cooling;
    if (layerIndex < S.fan.closeFirst) return 0;
    var lo = c.fan_min_speed, hi = c.fan_max_speed;
    var t = layerSeconds0;
    var pct;
    if (t >= c.fan_cooling_layer_time) pct = lo;
    else if (t <= c.slow_down_layer_time) pct = hi;
    else pct = lo + (hi - lo) * (c.fan_cooling_layer_time - t) / (c.fan_cooling_layer_time - c.slow_down_layer_time);
    return Math.round(pct * 255) / 100;
  }

  // ===========================================================================
  // The frozen blocks
  // ===========================================================================

  /** A number as the template writes it: 17, not 17.0000. */
  function tnum(v) { return String(+(+v).toFixed(4)); }
  /** A computed feed rate as Studio writes it: six significant digits (299.339, 6033.27, 720). */
  function gnum(v) { return String(+(+v).toPrecision(6)); }

  /* ===================== Studio's G-code templates (the filament change) =====================
     STUDIO'S PLACEHOLDER LANGUAGE, the part its printer templates use: [name] and {expression} put a value in,
     {if e} {elsif e} {else} {endif} keep or drop the text between them - newlines and all, which is how Studio's
     output keeps its blank lines. An expression has numbers, "strings", names, name[index], + - * / %, comparisons,
     && || ! and brackets. A number is written as C++'s ostream writes a double (six significant digits); a whole
     one without a point. A name the values do not hold is an error, not a blank: a template this does not know
     must not print. (Studio: src/libslic3r/PlaceholderParser.cpp.) */
  function studioNumber(v) {
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return v;
    if (!isFinite(v)) return String(v);
    if (Number.isInteger(v)) return String(v);
    var g = +v.toPrecision(6);
    return String(g);
  }
  function studioExpr(src, vars) {
    var toks = [], re = /\s*(?:(\d+\.\d*|\.\d+|\d+)|("(?:[^"\\]|\\.)*")|([A-Za-z_][A-Za-z0-9_]*)|(==|!=|>=|<=|&&|\|\||[-+*\/%()<>!\[\]]))/y, m;
    re.lastIndex = 0;
    while (re.lastIndex < src.length) {
      var at = re.lastIndex;
      m = re.exec(src);
      if (!m) { if (/^\s*$/.test(src.slice(at))) break; throw new Error('template: cannot read "' + src + '" at ' + at); }
      if (m[1] != null) toks.push({ n: +m[1] });
      else if (m[2] != null) toks.push({ s: m[2].slice(1, -1).replace(/\\(.)/g, '$1') });
      else if (m[3] != null) toks.push({ id: m[3] });
      else toks.push({ op: m[4] });
    }
    var i = 0;
    function peek(o) { return toks[i] && toks[i].op === o; }
    function eat(o) { if (!peek(o)) throw new Error('template: expected ' + o + ' in "' + src + '"'); i++; }
    function val(name) {
      if (name === 'true') return true;
      if (name === 'false') return false;
      if (!Object.prototype.hasOwnProperty.call(vars, name)) throw new Error('template: no value for ' + name);
      return vars[name];
    }
    function primary() {
      var t = toks[i++];
      if (!t) throw new Error('template: "' + src + '" ends early');
      if (t.n != null) return t.n;
      if (t.s != null) return t.s;
      if (t.op === '(') { var v = or(); eat(')'); return v; }
      if (t.op === '-') return -unary();
      if (t.op === '!') return !truth(unary());
      if (t.id) {
        if (t.id === 'and' || t.id === 'or' || t.id === 'not') throw new Error('template: word operators are not read');
        var v2 = val(t.id);
        if (peek('[')) {
          eat('['); var k = or(); eat(']');
          if (!Array.isArray(v2)) throw new Error('template: ' + t.id + ' is not a list');
          k = Math.trunc(+k);
          return v2[k >= 0 && k < v2.length ? k : 0];
        }
        if (Array.isArray(v2)) return v2[0];
        return v2;
      }
      throw new Error('template: unexpected ' + (t.op || '') + ' in "' + src + '"');
    }
    function unary() { return primary(); }
    function truth(v) { return typeof v === 'string' ? v.length > 0 : !!v; }
    function mul() {
      var v = unary();
      for (;;) {
        if (peek('*')) { i++; v = v * unary(); }
        else if (peek('/')) { i++; v = v / unary(); }
        else if (peek('%')) { i++; v = v % unary(); }
        else return v;
      }
    }
    function add() {
      var v = mul();
      for (;;) {
        if (peek('+')) { i++; var r = mul(); v = (typeof v === 'string' || typeof r === 'string') ? String(v) + String(r) : v + r; }
        else if (peek('-')) { i++; v = v - mul(); }
        else return v;
      }
    }
    function rel() {
      var v = add();
      for (;;) {
        if (peek('<')) { i++; v = v < add(); } else if (peek('>')) { i++; v = v > add(); }
        else if (peek('<=')) { i++; v = v <= add(); } else if (peek('>=')) { i++; v = v >= add(); }
        else return v;
      }
    }
    function eq() {
      var v = rel();
      for (;;) {
        if (peek('==')) { i++; var a = rel(); v = typeof v === 'string' || typeof a === 'string' ? String(v) === String(a) : v == a; }   // eslint-disable-line eqeqeq
        else if (peek('!=')) { i++; var b = rel(); v = typeof v === 'string' || typeof b === 'string' ? String(v) !== String(b) : v != b; }   // eslint-disable-line eqeqeq
        else return v;
      }
    }
    function and() { var v = eq(); while (peek('&&')) { i++; var r = eq(); v = truth(v) && truth(r); } return v; }
    function or() { var v = and(); while (peek('||')) { i++; var r = and(); v = truth(v) || truth(r); } return v; }
    var out = or();
    if (i < toks.length) throw new Error('template: "' + src + '" has more after it');
    return { v: out, truth: truth(out) };
  }
  /** A Studio template's text with `vars` put in (the language above): the text, newlines as Studio leaves them. */
  function studioTemplate(text, vars) {
    var out = '', stack = [], live = function () { return stack.every(function (f) { return f.on; }); };
    var i = 0, n = text.length;
    while (i < n) {
      var c = text.charAt(i);
      if (c === '{') {
        var j = text.indexOf('}', i);
        if (j < 0) throw new Error('template: an unclosed {');
        var body = text.slice(i + 1, j).trim();
        var mIf = /^if\s+([\s\S]*)$/.exec(body), mEl = /^elsif\s*([\s\S]*)$/.exec(body);
        if (mIf) {
          var parentLive = live();
          var on = parentLive && studioExpr(mIf[1], vars).truth;
          stack.push({ on: on, done: on, parent: parentLive });
        } else if (mEl) {
          var top = stack[stack.length - 1];
          if (!top) throw new Error('template: elsif without if');
          if (top.done || !top.parent) top.on = false;
          else { top.on = studioExpr(mEl[1], vars).truth; top.done = top.on; }
        } else if (body === 'else') {
          var t2 = stack[stack.length - 1];
          if (!t2) throw new Error('template: else without if');
          t2.on = t2.parent && !t2.done; t2.done = true;
        } else if (body === 'endif') {
          if (!stack.pop()) throw new Error('template: endif without if');
        } else if (live()) {
          out += studioNumber(studioExpr(body, vars).v);
        }
        i = j + 1;
        continue;
      }
      if (c === '[') {
        var mv = /^\[([A-Za-z_][A-Za-z0-9_]*)\]/.exec(text.slice(i, i + 80));
        if (mv) {
          if (live()) {
            if (!Object.prototype.hasOwnProperty.call(vars, mv[1])) throw new Error('template: no value for ' + mv[1]);
            var vv = vars[mv[1]];
            out += studioNumber(Array.isArray(vv) ? vv[0] : vv);
          }
          i += mv[0].length;
          continue;
        }
      }
      if (live()) out += c;
      i++;
    }
    if (stack.length) throw new Error('template: an {if} is not closed');
    return out;
  }
  /** The template's extruder_offset as {x, y} mm ('0x2' on the P1S). */
  function extruderOffset(config) {
    var v = config && config.extruder_offset;
    if (Array.isArray(v)) v = v[0];
    var m = /^\s*(-?[\d.]+)\s*x\s*(-?[\d.]+)/.exec(String(v == null ? '' : v));
    return m ? { x: +m[1], y: +m[2] } : { x: 0, y: 0 };
  }

  /**
   * MULTI-COLOUR: what a filament change needs from the template's project settings (docs/MULTICOLOR.md). The values are Studio's own
   * (GCode.cpp set_extruder, 02.09): the purge volume from flush_volumes_matrix (row: the old slot, column: the new) times flush_multiplier,
   * less grab_length's worth, as filament length, in at most 4 equal parts of about 135 mm^3; a filament's own setting over the printer's
   * where it has one ('nil' is none); a per-filament list may hold two entries a filament (its two extruder variants: the standard nozzle's
   * first). Returns { initial, block(), endLines(), startLines(), temp(), toolchangeLength(), count } or { error }.
   */
  function multiColour(config, res, Pr, S) {
    var list = function (k) { var v = config[k]; return Array.isArray(v) ? v : v == null ? [] : String(v).split(/[;,]/); };
    var n = Math.max(list('filament_colour').length, list('filament_type').length);
    if (!config.change_filament_gcode) return { error: 'this printer template has no filament change G-code (change_filament_gcode), so it cannot change colour' };
    var per = function (k, slot) { var l = list(k); return l.length === n ? l[slot] : l.length === 2 * n ? l[2 * slot] : l[0]; };
    var eff = function (fk, mk, slot) { var v = per(fk, slot); return v != null && v !== 'nil' && v !== '' ? v : list(mk)[0]; };
    var maxSlot = -1, first = -1, firstPlane = Infinity;
    res.objects.forEach(function (ob) {
      ob.layers.forEach(function (L, li) {
        if (!L || !L.paths || !L.paths.length) return;
        L.paths.forEach(function (pa) {
          var sl = pa.slot != null ? pa.slot : (L.slot || 0);
          if (sl > maxSlot) maxSlot = sl;
          if (li < firstPlane || (li === firstPlane && sl < first)) { firstPlane = li; first = sl; }
        });
      });
    });
    if (maxSlot >= n) return { error: 'a part prints with filament ' + (maxSlot + 1) + ', but the project has ' + n + ' filament' + (n === 1 ? '' : 's') };
    var slots = []; for (var q = 0; q < n; q++) slots.push(q);
    var num = function (v) { return +v; };
    var matrix = list('flush_volumes_matrix').map(num), mult = num(list('flush_multiplier')[0] || 1), grab = num(list('grab_length')[0] || 0);
    var areaOf = function (slot) { var d = num(per('filament_diameter', slot) || 1.75); return Math.fround(Math.PI / 4 * d * d); };
    var plateKey = { 'Cool Plate': 'cool_plate_temp', 'Engineering Plate': 'eng_plate_temp', 'High Temp Plate': 'hot_plate_temp',
                     'Textured PEI Plate': 'textured_plate_temp', 'Supertack Plate': 'supertack_plate_temp' }[String(Array.isArray(config.curr_bed_type) ? config.curr_bed_type[0] : config.curr_bed_type)] || 'textured_plate_temp';
    var base = {
      filament_type: slots.map(function (q) { return per('filament_type', q); }),
      long_retractions_when_cut: slots.map(function (q) { return num(eff('filament_long_retractions_when_cut', 'long_retractions_when_cut', q)); }),
      retraction_distances_when_cut: slots.map(function (q) { return num(eff('filament_retraction_distances_when_cut', 'retraction_distances_when_cut', q)); }),
      flush_volumetric_speeds: slots.map(function (q) { return num(per('filament_flush_volumetric_speed', q)) || num(per('filament_max_volumetric_speed', q)); }),
      flush_temperatures: slots.map(function (q) { return num(per('filament_flush_temp', q)) || num(list('nozzle_temperature_range_high')[q] != null ? list('nozzle_temperature_range_high')[q] : per('nozzle_temperature_range_high', q)); }),
      initial_layer_print_height: num(list('initial_layer_print_height')[0]),
      initial_layer_acceleration: num(list('initial_layer_acceleration')[0]),
      default_acceleration: num(list('default_acceleration')[0]),
      x_after_toolchange: 0, y_after_toolchange: 0, z_after_toolchange: 0
    };
    var tp = travelPoints(config, res);
    base.travel_point_1_x = tp[0][0]; base.travel_point_1_y = tp[0][1];
    base.travel_point_2_x = tp[1][0]; base.travel_point_2_y = tp[1][1];
    base.travel_point_3_x = tp[2][0]; base.travel_point_3_y = tp[2][1];
    var tempOf = function (slot, firstLayer) { return num(per(firstLayer ? 'nozzle_temperature_initial_layer' : 'nozzle_temperature', slot)); };
    var tcLen = function (slot) { return num(eff('filament_retract_length_toolchange', 'retract_length_toolchange', slot)); };
    var M = {
      n: n, initial: first < 0 ? 0 : first, count: 0, changes: [], types: base.filament_type,
      flushMatrix: slots.map(function (a) { return slots.map(function (b) { return num(matrix[a * n + b] || 0) * mult; }); }),
      temp: tempOf, toolchangeLength: tcLen,
      /** the old filament's end G-code, as lines (Studio: its text, a newline added if it has none) */
      endLines: function (slot) {
        var t = studioTemplate(per('filament_end_gcode', slot) || '', { current_extruder: slot, layer_num: 0 });
        if (t && t.charAt(t.length - 1) !== '\n') t += '\n';
        return t ? t.slice(0, -1).split('\n') : [];
      },
      /** the new filament's start G-code, as lines */
      startLines: function (slot) {
        var t = studioTemplate(per('filament_start_gcode', slot) || '', {
          current_extruder: slot, layer_num: 0,
          bed_temperature: slots.map(function (q) { return num(per(plateKey, q)); }),
          bed_temperature_initial_layer: slots.map(function (q) { return num(per(plateKey + '_initial_layer', q)); }),
          activate_air_filtration: slots.map(function (q) { return num(per('activate_air_filtration', q) || 0); }),
          support_air_filtration: num(list('support_air_filtration')[0] || 0),
          during_print_exhaust_fan_speed_num: slots.map(function (q) { return Math.floor(255 * num(per('during_print_exhaust_fan_speed', q) || 0) / 100); })
        });
        if (t && t.charAt(t.length - 1) !== '\n') t += '\n';
        return t ? t.slice(0, -1).split('\n') : [];
      },
      /** The change block from `from` to `to` (0-based slots) at the layer printing at `z`: { lines, extruded, accel, z }. fIn: the F the line
       *  before it left in force (null: not known, nothing dropped at its first line). */
      block: function (from, to, z, firstLayer, fIn) {
        M.count++;
        var b = M.blockAt(from, to, z, firstLayer, fIn, M.count);
        M.changes.push({ from: from, to: to, z: z, purgeMm3: b.purgeMm3 });
        return b;
      },
      /** the same block as the count-th change, without counting it (a layer's cooling counts the change's time before it is written) */
      blockAt: function (from, to, z, firstLayer, fIn, count) {
        var area = areaOf(to);
        var wv = Math.fround(num(matrix[from * n + to] || 0) * mult);
        wv = Math.fround(Math.max(0, wv - grab * area));
        var wl = Math.fround(wv / area);
        var cnt = Math.min(4, Math.round(wv / 135));
        if (cnt === 0 && wv > 0) cnt = 1;
        var unit = cnt ? Math.fround(wl / cnt) : 0;
        var v = Object.assign({}, base, {
          next_extruder: to, previous_extruder: from, max_layer_z: z, layer_z: z, toolchange_count: count,
          old_filament_temp: tempOf(from, firstLayer), new_filament_temp: tempOf(to, firstLayer),
          old_retract_length_toolchange: tcLen(from), new_retract_length_toolchange: tcLen(to), flush_length: wl
        });
        for (var k = 1; k <= 4; k++) v['flush_length_' + k] = k <= cnt ? unit : 0;
        var text = studioTemplate(String(config.change_filament_gcode), v);
        if (text.charAt(text.length - 1) === '\n') text = text.slice(0, -1);
        var lines = dropRepeatedF(text.split('\n'), fIn).lines, out = [], ext = 0, acc = null, zz = null;
        lines.forEach(function (l) {
          out.push(l);
          var mt = /^T(\d+)\s*$/.exec(l);
          /* Studio's processor marks after a T how many changes are still to come (the pyramid: 2, 1, 0; the Gulf logo's ten: 9 ... 0) */
          if (mt && +mt[1] < 255) out.push('M73 E' + Math.max(0, (M.total != null ? M.total : count) - count));
          var me = /^G[01]\b[^;]*\bE(-?[\d.]+)/.exec(l);
          if (me && !/^G92/.test(l)) ext += +me[1];
          var ma = /^M204 S(\d+(?:\.\d+)?)/.exec(l); if (ma) acc = +ma[1];
          var mz = /^G[01]\b[^;]*\bZ(-?[\d.]+)/.exec(l); if (mz) zz = +mz[1];
        });
        return { lines: out, extruded: ext, accel: acc, z: zz, purgeMm3: wv };
      }
    };
    return M;
  }

  /**
   * The three points of Studio's path to the filament cutter for the second change (GCode.cpp get_path_of_change_filament): from the
   * template's start_end_points (the path's start and end, P1S: 30,-3 and 54,245) and the cutter's corner (bed_exclude_area's third
   * point + 2), a free strip of x across the plate's objects (each object's x range widened 2 mm). [[x,y],[x,y],[x,y]].
   */
  function travelPoints(config, res) {
    var def = [[54, 0], [54, 0], [54, 245]];
    var pts = config.start_end_points, ex = config.bed_exclude_area;
    var xy = function (s) { var m = /^\s*(-?[\d.]+)\s*x\s*(-?[\d.]+)/.exec(String(s)); return m ? [+m[1], +m[2]] : null; };
    if (!Array.isArray(pts) || pts.length !== 2 || !Array.isArray(ex) || ex.length !== 4) return def;
    var sp = xy(pts[0]), ep = xy(pts[1]), c2 = xy(ex[2]);
    if (!sp || !ep || !c2) return def;
    var cutY = c2[1] + 2, startX = sp[0], endX = ep[0], endY = ep[1], fromLeft = true;
    var intervals = [];
    res.objects.forEach(function (ob) {
      var b = ob.bbox;
      if (!b) {
        b = { x0: Infinity, x1: -Infinity, y0: Infinity };
        ob.layers.forEach(function (L) { if (L && L.paths) L.paths.forEach(function (p) { p.pts.forEach(function (q) { if (q[0] < b.x0) b.x0 = q[0]; if (q[0] > b.x1) b.x1 = q[0]; if (q[1] < b.y0) b.y0 = q[1]; }); }); });
        if (!isFinite(b.x0)) return;
      }
      if (b.x0 < startX && b.y0 < cutY) fromLeft = false;
      var sc = [b.x0 - 2, b.x1 + 2], merged = null, keep = [];
      intervals.forEach(function (iv) {
        if (iv[1] >= sc[0] && iv[0] <= sc[1]) merged = merged ? [Math.min(iv[0], merged[0]), Math.max(iv[1], merged[1])] : [Math.min(iv[0], sc[0]), Math.max(iv[1], sc[1])];
        else keep.push(iv);
      });
      if (merged) { keep.push(merged); intervals = keep; } else intervals.push(sc);
    });
    intervals.sort(function (a, b) { return a[0] - b[0]; });
    var avail = [], at = 0;
    intervals.forEach(function (iv) { if (iv[0] > at) avail.push([at, iv[0]]); at = iv[1]; });
    avail.push([at, 255]);
    var path = 255;
    for (var i = 0; i < avail.length; i++) {
      var a = avail[i];
      if (a[0] > endX) { var d = a[0] - endX; path = Math.abs(endX - path) < d ? path : a[0]; break; }
      if (a[1] >= endX) { path = endX; break; }
      if (!fromLeft && a[1] < startX) continue;
      path = a[1];
    }
    return path < startX ? [[startX, cutY], [path, cutY], [path, endY]] : [[path, 0], [path, 0], [path, endY]];
  }

  // ===========================================================================
  // THE PRIME TOWER (docs/MULTICOLOR.md, step 5)
  // ===========================================================================
  /* Studio 02.09.01.70's rectangular tower for one nozzle (WipeTower.cpp: plan_toolchange, plan_tower_new, finish_layer_new,
     tool_change_new, toolchange_wipe_new; GCode.cpp: WipeTowerIntegration::append_tcr and post_process_wipe_tower_moves), as its writer
     writes it - single precision, the moves rewritten into plate coordinates the way Studio's post-processing rewrites them - checked on
     the owner's 3-colour pyramid with the tower on (2026-11-22). Built from the layer the print starts on up to the last filament change,
     at the project's wipe_tower_x / y, or - when a piece is there on NSO's plate - at the clear spot nearest it.
       - every tower layer prints first on its layer, after the layer change;
       - a layer without a change: the rectangle inside the wall, its sparse grid (solid on the first layer), the outer wall; the first
         layer adds the brim, the next layers a shrinking chamfer;
       - a change: the outer wall with a gap where the purge starts, in the wall's filament (the most used one) - before the change when
         the old filament is that one or neither is, after it when the new one is; the change itself (Studio's change block, the same as
         without a tower); the new filament primes filament_prime_volume across the tower, line by line, slow at first;
       - the nozzle leaves the tower wiped along its last line and lifted slowly (prime_tower_lift_speed).
     Not written: rib walls, two materials that do not stick to each other (two blocks), the side scrape, interface features. */
  var f32 = Math.fround;
  var WT_MIN_DEPTH = [[5, 5], [100, 20], [250, 40], [350, 60]];          /* WipeTower::min_depth_per_height */
  var WT_SLOPE = Math.tan(3 * Math.PI / 180);                             /* the slope of Studio's lifting travel (0.4 mm over 7.63) */
  function wtLimitDepth(h) {
    for (var i = 0; i < WT_MIN_DEPTH.length; i++) {
      var c = WT_MIN_DEPTH[i];
      if (c[0] >= h) return c[1];
      var nx = WT_MIN_DEPTH[i + 1];
      if (!nx) return c[1];
      if (nx[0] > h) return c[1] + (h - c[0]) / (nx[0] - c[0]) * (nx[1] - c[1]);
    }
    return 0;
  }
  function wtF3(v) { var s = v.toFixed(3); return s === '-0.000' ? '0.000' : s; }

  /** Studio's WipeTowerWriter: a move's X / Y only when it changes, E with four decimals, F only when it changes, the acceleration before
   *  a move when it changes (extruding: the layer's; travelling: the travel's). Positions in single precision, tower coordinates. */
  function WTWriter(o) {
    this.o = o; this.lines = []; this.x = f32(o.x); this.y = f32(o.y); this.F = 0; this.A = 0; this.e = 0;
  }
  WTWriter.prototype.acc = function (travel) {
    var a = travel ? this.o.accT : this.o.accN;
    if (this.o.accMax > 0 && a > this.o.accMax) a = this.o.accMax;
    if (!a || a === this.A) return;
    this.A = a; this.lines.push('M204 S' + a);
  };
  WTWriter.prototype.move = function (x, y, e, f) {
    x = f32(x); y = f32(y);
    var mx = Math.abs(x - this.x) > 1e-4, my = Math.abs(y - this.y) > 1e-4;
    if (!mx && !my && e === 0 && (!f || f === this.F)) return this;
    this.acc(e === 0);
    var s = 'G1';
    if (mx) s += ' X' + wtF3(x);
    if (my) s += ' Y' + wtF3(y);
    if (e !== 0) s += ' E' + e.toFixed(4);
    if (f && f !== this.F) { s += ' F' + Math.floor(f + 0.5); this.F = f; }
    if (e > 0) this.e += e;
    this.x = x; this.y = y;
    this.lines.push(s);
    return this;
  };
  WTWriter.prototype.travel = function (x, y, f) { return this.move(x, y, 0, f || 0); };
  WTWriter.prototype.extrude = function (x, y, f) {
    var dx = f32(f32(x) - this.x), dy = f32(f32(y) - this.y);
    return this.move(x, y, f32(f32(Math.sqrt(f32(dx * dx + dy * dy))) * this.o.flow), f || 0);
  };
  /** E alone (a retraction is a negative load) */
  WTWriter.prototype.load = function (e, f) {
    if (e === 0 && (!f || f === this.F)) return this;
    var s = 'G1';
    if (e !== 0) s += ' E' + e.toFixed(4);
    if (f && f !== this.F) { s += ' F' + Math.floor(f + 0.5); this.F = f; }
    this.lines.push(s);
    return this;
  };
  WTWriter.prototype.feedrate = function (f) { if (f !== this.F) { this.lines.push('G1 F' + Math.floor(f + 0.5)); this.F = f; } return this; };

  /**
   * The tower of a plate, or null (no change, or the project's tower is off), or { error }. layerSlot[pj]: the slot each printing layer
   * prints with; planes: res.planes of the printing layers, in order. The tower stands at the project's wipe_tower_x / y when that is clear of
   * the pieces, else at the first clear spot along the back of the bed.
   */
  function primeTower(config, S, MC, printingPlanes, layerSeq, objBoxes, bed, OFF) {
    var list = function (k) { var v = config[k]; return Array.isArray(v) ? v : v == null ? [] : String(v).split(/[;,]/); };
    var one = function (k, d) { var v = list(k)[0]; return v == null || v === '' ? d : v; };
    if (String(one('enable_prime_tower', '0')) !== '1') return null;
    var n = MC.n;
    var per = function (k, slot) { var l = list(k); return l.length === n ? l[slot] : l.length === 2 * n ? l[2 * slot] : l[0]; };
    /* the changes of each layer: its filaments in their order (layerSeq, the colour plan), from the one loaded */
    var changes = [], cur = MC.initial, last = -1;
    layerSeq.forEach(function (seq, pj) {
      var list0 = [];
      seq.forEach(function (sl) { if (sl !== cur) { list0.push({ from: cur, to: sl }); cur = sl; } });
      changes.push(list0);
      if (list0.length) last = pj;
    });
    if (last < 0) return null;
    if (+one('prime_tower_rib_wall', 0)) return { error: 'the project\'s prime tower has rib walls; NSO writes the plain rectangular tower so far. In Bambu Studio turn off the prime tower\'s Rib wall (Others > Prime tower), save the project and open it again.' };
    var cats = {}; changes.forEach(function (cl) { cl.forEach(function (c) { cats[per('filament_adhesiveness_category', c.from)] = 1; cats[per('filament_adhesiveness_category', c.to)] = 1; }); });
    if (Object.keys(cats).length > 1) return { error: 'the plate changes between filaments Studio keeps apart on the prime tower (different materials); NSO writes a tower of one material so far.' };
    var nozzle = +one('nozzle_diameter', 0.4);
    var W = f32(+one('prime_tower_width', 35)), lwSet = +one('prime_tower_line_width', 0);
    var w = f32(lwSet > 0 ? lwSet : f32(f32(nozzle) * 1.25));
    var gap = parseFloat(one('prime_tower_infill_gap', '100')) / 100 || 1;
    var brim = +one('prime_tower_brim_width', 3), maxSpeed = f32(+one('prime_tower_max_speed', 90) * 60);
    var firstSpeed = f32(S.speed.first), travelF = f32(S.speed.travel * 60);
    var liftF = +one('prime_tower_lift_speed', 90) * 60;
    var gapWall = +one('prime_tower_skip_points', 1) !== 0, lineIroning = +one('prime_tower_line_ironing', 1) !== 0;
    var accN = Math.floor(S.accel.def + 0.5), accT = Math.floor(S.accel.travel + 0.5);
    var accFN = Math.floor(S.accel.first + 0.5), accFT = Math.floor(S.accel.firstTravel + 0.5);
    var accMax = +one('machine_max_acceleration_extruding', 0);
    var PI4 = f32(1 - f32(Math.PI) / 4);
    var spacingFor = function (h) { return f32(w - f32(f32(h) * PI4)); };
    var areaOf = function (slot) { var d = +per('filament_diameter', slot) || 1.75; return f32(f32(Math.PI / 4) * f32(d * d)); };
    var flowFor = function (h, slot) { return f32(f32(f32(h) * spacingFor(h)) / areaOf(slot)); };
    var vol2len = function (v, h) { return Math.max(0, f32(f32(v) / f32(f32(h) * spacingFor(h)))); };
    var maxE = function (slot) { var v = +per('filament_max_volumetric_speed', slot); return v ? f32(f32(v) / areaOf(slot)) : 0; };
    var feedFor = function (slot, flow, first) {
      if (first) return Math.min(f32(firstSpeed * 60), maxSpeed);
      var me = maxE(slot);
      return me ? Math.min(f32(f32(60 * me) / flow), maxSpeed) : maxSpeed;
    };
    var retractOf = function (slot) {
      var own = per('filament_retraction_length', slot), len = own != null && own !== 'nil' && own !== '' ? +own : +one('retraction_length', 0.8);
      var ownV = per('filament_retraction_speed', slot), v = ownV != null && ownV !== 'nil' && ownV !== '' ? +ownV : +one('retraction_speed', 30);
      return { len: f32(len), F: f32(v * 60) };
    };
    var layers = [];
    for (var pj = 0; pj <= last; pj++) {
      var pl = printingPlanes[pj], h = f32(pl.h), req = 0;
      var cl = changes[pj].map(function (c) {
        var wlen = vol2len(+per('filament_prime_volume', c.to) || 0, h);
        var r = f32(Math.ceil(wlen / f32(W - 2 * w)) * w);
        req = f32(req + r);
        return { from: c.from, to: c.to, req: r, wipeLen: wlen };
      });
      layers.push({ pj: pj, z: pl.printZ, h: h, changes: cl, req: req });
    }
    var maxDepth = 0; layers.forEach(function (L) { if (L.req > maxDepth) maxDepth = L.req; });
    var extra = gap, minDepth = wtLimitDepth(layers[layers.length - 1].z);
    if (maxDepth + 1e-9 < minDepth) extra = Math.max(f32(minDepth / maxDepth), extra);
    /* a layer's depth: the deepest change at or above it (Studio carries the band's depth down); the first layer purges solid */
    var below = 0;
    for (var q = layers.length - 1; q >= 0; q--) {
      var Lq = layers[q], at0 = 0;
      Lq.req = f32(Lq.req * extra);
      Lq.changes.forEach(function (c) {
        c.req = f32(c.req * extra);
        c.at = at0; at0 = f32(at0 + c.req);                       /* where its band starts, from the block's start */
        if (q === 0) c.wipeLen = f32(f32(c.req / w) * f32(W - 2 * w));
      });
      if (Lq.req > below) below = Lq.req;
      Lq.depth = below;
    }
    var D = f32(f32(maxDepth * extra) + w);
    layers.forEach(function (L) {
      L.yShift = 0;
      if (L.depth < D - w - 1e-6) { var dy0 = extra * w, s0 = (D - L.depth) / 2; L.yShift = f32(Math.round(s0 / dy0) * dy0); }
    });
    /* the wall's filament: the one on the tower on most layers (Studio's get_wall_filament_for_all_layer) */
    var counts = {}, curT = MC.initial;
    layers.forEach(function (L) {
      if (!L.changes.length) { counts[curT] = (counts[curT] || 0) + 1; return; }
      var used = {};
      L.changes.forEach(function (c, i) {
        if (i === 0) { counts[c.from] = (counts[c.from] || 0) + 1; used[c.from] = 1; }
        if (!used[c.to]) counts[c.to] = (counts[c.to] || 0) + 1;
        used[c.to] = 1;
      });
      curT = L.changes[L.changes.length - 1].to;
    });
    var wallSlot = -1, wallN = 0;
    Object.keys(counts).map(Number).sort(function (a, b) { return a - b; }).forEach(function (s) { if (counts[s] > wallN) { wallN = counts[s]; wallSlot = s; } });
    /* the brim (first layer) and how far it reaches. Studio's loops step out by the line spacing cut to 1e-5 mm (scaled() truncates): the
       pyramid's brim steps 0.45707 where the spacing is 0.457080 - its loops' E (0.4495 on the second, 0.6331 on the fourth), the
       outermost loop at 56.579, the bed-mesh box from 56.5786 and the way round the tower at 74.978 / 54.579 / 227.199 all need it */
    var loopStep = function (h) { return Math.floor(spacingFor(h) * 1e5 + 1e-7) / 1e5; };
    var sp0 = spacingFor(layers[0].h);
    var brimLoops = Math.max(0, Math.floor((brim + sp0 / 2) / sp0));
    var ext = brimLoops * loopStep(layers[0].h);
    /* where it stands: the project's spot if it clears every piece by 2 mm, else the first clear spot along the back */
    var clear = function (x, y) {
      var bx0 = x - ext - 2, by0 = y - ext - 2, bx1 = x + W + ext + 2, by1 = y + D + ext + 2;
      if (bx0 < 0 || by0 < 0 || bx1 > bed.x || by1 > bed.y) return false;
      return objBoxes.every(function (b) { return b.x1 < bx0 || b.x0 > bx1 || b.y1 < by0 || b.y0 > by1; });
    };
    var tx = +one('wipe_tower_x', NaN), ty = +one('wipe_tower_y', NaN), moved = false;
    if (!(isFinite(tx) && isFinite(ty) && clear(tx, ty))) {
      /* the clear spot nearest the project's (on a 1 mm grid, inside the bed by 3 mm) */
      moved = true;
      var found = null, best = Infinity, wantX = isFinite(tx) ? tx : bed.x * 0.644, wantY = isFinite(ty) ? ty : bed.y * 0.85;
      for (var yy = Math.ceil(ext + 3); yy + D + ext + 3 <= bed.y; yy++) {
        for (var xx = Math.ceil(ext + 3); xx + W + ext + 3 <= bed.x; xx++) {
          var dd = (xx - wantX) * (xx - wantX) + (yy - wantY) * (yy - wantY);
          if (dd < best && clear(xx, yy)) { best = dd; found = [xx, yy]; }
        }
      }
      if (!found) return { error: 'there is no room on the plate for the prime tower (' + W + ' x ' + (+D.toFixed(1)) + ' mm and its brim): move the pieces closer together, or turn the tower off in the project.' };
      tx = found[0]; ty = found[1];
    }
    var T = {
      x: f32(tx), y: f32(ty), W: W, D: D, w: w, last: last, layers: layers, wallSlot: wallSlot, moved: moved,
      box: { x0: f32(tx) - ext, y0: f32(ty) - ext, x1: f32(tx) + W + ext, y1: f32(ty) + D + ext },
      liftF: liftF, travelF: travelF, ltr: true, count: 0, maxSpeed: maxSpeed,
      ox: f32(OFF.x), oy: f32(OFF.y)
    };
    T.lineTag = (+w).toFixed(6);
    /** Which of the layer's changes the wall goes with (get_wall_filament_for_layer): { k, before } - before change 0 when the old
     *  filament is the wall's (or no change brings the wall's in: the old one, of its kind, stands in); else after the change that brings
     *  the wall's filament in. null: no change on the layer, the wall (and grid) alone. */
    T.wallAt = function (pj) {
      var cl = layers[pj].changes;
      if (!cl.length) return null;
      var wallIdx = cl[0].from === wallSlot || cl.some(function (c) { return c.to === wallSlot; }) ? wallSlot : cl[0].from;
      /* generate_new makes the wall at each change that fits and keeps the last: before change 0 when its old filament is the wall's, after
         any change that brings the wall's in (the Gulf logo at 1.2: grey to black, black to grey, the wall grey - after the second) */
      var at = { k: 0, before: true };
      for (var i = 0; i < cl.length; i++) {
        if (i === 0 && cl[0].from === wallIdx) at = { k: 0, before: true };
        else if (cl[i].to === wallIdx) at = { k: i, before: false };
      }
      return at;
    };
    var writerFor = function (L, slot, x, y) {
      var first = L.pj === 0;
      return new WTWriter({ x: x, y: y, flow: flowFor(L.h, slot), accN: first ? accFN : accN, accT: first ? accFT : accT, accMax: accMax });
    };
    var header = function (L) { return ['; LAYER_HEIGHT: ' + (+L.h).toFixed(6), '; FEATURE: Prime tower', '; LINE_WIDTH: ' + T.lineTag]; };
    /** Studio's post-processing of the tower's moves (post_process_wipe_tower_moves): each G1 rewritten in plate coordinates, X and Y only
     *  when they change from the line before. pp: { old, pos } carried through one visit. */
    T.post = function () { return { old: null, pos: [0, 0] }; };
    T.reset = function (pp, pos) { pp.old = null; pp.pos = [f32(pos[0]), f32(pos[1])]; };
    T.rewrite = function (lines, pp) {
      return lines.map(function (line) {
        if (!/^G[123] /.test(line)) return line;
        var px = pp.pos[0], py = pp.pos[1];
        var rest = line.replace(/([XY])(-?[\d.]+)/g, function (a, k, v) { if (k === 'X') px = f32(+v); else py = f32(+v); return ''; });
        pp.pos = [px, py];
        var gxv = f32(px + T.x), gyv = f32(py + T.y), old = pp.old;
        if (old && gxv === old[0] && gyv === old[1]) return line;
        var s = line.slice(0, 3);
        if (!old || gxv !== old[0]) s += ' X' + wtF3(f32(gxv - T.ox));
        if (!old || gyv !== old[1]) s += ' Y' + wtF3(f32(gyv - T.oy));
        pp.old = [gxv, gyv];
        return s + ' ' + rest.slice(3);
      });
    };
    T.plate = function (p) { return [f32(p[0] + T.x), f32(p[1] + T.y)]; };

    /* THE OUTER WALL (generate_support_wall_new): the rectangle, with a gap of 2.5 lines each way around where each of this layer's purges
       starts (remove_points_from_polygon) */
    var gapWallPolylines = function (box, skips) {
      var x0 = box[0], y0 = box[1], x1 = box[2], y1 = box[3];
      if (!skips || !skips.length) return { lines: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]], poly: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] };
      var range = f32(2.5 * w), mx = f32((x0 + x1) / 2), r = Math.min(range, f32((x1 - x0) / 2 * 0.9));
      /* from the bottom edge's middle, counter-clockwise, with add_extra_point's two points either side of it */
      var pts = [[mx, y0], [f32(mx + r), y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0], [f32(mx - r), y0]];
      var m = pts.length, marks = [];
      skips.forEach(function (skip, id) {
        var isLeft = Math.abs(skip[0]) < W / 2, hit = -1, at = null;
        for (var j = 0; j < m && hit < 0; j++) {
          var a = pts[j], b = pts[(j + 1) % m];
          if (Math.abs(a[0] - b[0]) > 1e-9) continue;                       /* the ray is horizontal: only an upright edge meets it */
          var t1 = isLeft ? skip[0] - a[0] : a[0] - skip[0], lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
          if (t1 >= -1e-6 && skip[1] >= lo - 1e-6 && skip[1] <= hi + 1e-6) { hit = j; at = [a[0], skip[1]]; }
        }
        if (hit < 0) return;
        var walk = function (fwd) {
          var left = range, p = at, i = fwd ? (hit + 1) % m : hit;
          for (var guard = 0; guard < 2 * m; guard++) {
            var q = pts[i], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (d >= left) {
              var e = fwd ? (i - 1 + m) % m : i, pp2 = [f32(p[0] + (q[0] - p[0]) * left / d), f32(p[1] + (q[1] - p[1]) * left / d)];
              return { p: pp2, after: e, d: Math.hypot(pp2[0] - pts[e][0], pp2[1] - pts[e][1]) };
            }
            left -= d; p = q; i = fwd ? (i + 1) % m : (i - 1 + m) % m;
          }
          return { p: p, after: i, d: 0 };
        };
        var bw = walk(false), fw = walk(true);
        marks.push({ p: bw.p, after: bw.after, d: bw.d, id: id, end: 'b' }, { p: fw.p, after: fw.after, d: fw.d, id: id, end: 'f' });
      });
      if (!marks.length) return gapWallPolylines(box, null);
      /* the polygon with every gap's two ends in it */
      var full = [];
      for (var k = 0; k < m; k++) {
        full.push({ p: pts[k] });
        marks.filter(function (mk) { return mk.after === k; }).sort(function (a, b) { return a.d - b.d; }).forEach(function (mk) { full.push(mk); });
      }
      var polyAll = full.map(function (e) { return e.p; });
      /* cut open at each gap: from its 'b' end round to its 'f' end nothing is drawn */
      var skipping = {}, open0 = false;
      full.forEach(function (e) { if (e.end === 'f' && !skipping[e.id]) skipping[e.id] = 'pending'; });
      /* a gap that wraps past the bottom middle is open at the start */
      var startIn = {};
      marks.forEach(function (mk) { if (mk.end === 'b') { var bi = full.indexOf(mk), fi = full.indexOf(marks.filter(function (x) { return x.id === mk.id && x.end === 'f'; })[0]); if (bi > fi) startIn[mk.id] = 1; } });
      var inside = Object.keys(startIn).length > 0, active = Object.assign({}, startIn);
      var out = [], cur = [];
      for (var u = 0; u <= full.length; u++) {
        var e = full[u % full.length];
        if (e.end === 'f' && active[e.id]) { delete active[e.id]; if (!Object.keys(active).length) { cur = [e.p]; } continue; }
        if (Object.keys(active).length) continue;
        cur.push(e.p);
        if (e.end === 'b') { out.push(cur); cur = []; active[e.id] = 1; }
      }
      if (cur.length > 1) out.push(cur);
      /* Studio's polylines start at the bottom middle; drop the points on a straight run (its simplify) */
      out = out.map(function (pl) {
        return pl.filter(function (p, i) {
          if (i === 0 || i === pl.length - 1) return true;
          var a = pl[i - 1], b = pl[i + 1];
          return Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) > 1e-9;
        });
      }).filter(function (pl) { return pl.length > 1; });
      return { lines: out, poly: polyAll };
    };
    /** generate_path: start at the segment that starts nearest the nozzle, go round, a gap crossed retracted */
    var drawWall = function (wr, polylines, feed, rt) {
      var segs = [];
      polylines.forEach(function (pl) { for (var i = 0; i + 1 < pl.length; i++) segs.push([pl[i], pl[i + 1]]); });
      if (!segs.length) return [];
      var best = 0, bd = Infinity;
      segs.forEach(function (s, i) { var d = f32(Math.pow(f32(s[0][0] - wr.x), 2) + Math.pow(f32(s[0][1] - wr.y), 2)); if (d < bd) { bd = d; best = i; } });
      var drawn = [];
      wr.travel(segs[best][0][0], segs[best][0][1]);
      wr.extrude(segs[best][1][0], segs[best][1][1], feed);
      drawn.push(segs[best][0], segs[best][1]);
      for (var k = 1; k < segs.length; k++) {
        var s = segs[(best + k) % segs.length];
        if (Math.hypot(s[0][0] - wr.x, s[0][1] - wr.y) > 1e-4) {
          wr.load(-rt.len, rt.F); wr.travel(s[0][0], s[0][1], 600); wr.load(rt.len, rt.F);
          drawn = [s[0]];
        }
        wr.extrude(s[1][0], s[1][1], feed);
        drawn.push(s[1]);
      }
      return drawn;
    };
    /** a rectangle loop from the corner nearest the nozzle, counter-clockwise (writer.polygon) */
    var drawLoop = function (wr, r, feed) {
      var cs = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]], best = 0, bd = Infinity;
      cs.forEach(function (c, i) { var d = Math.pow(c[0] - wr.x, 2) + Math.pow(c[1] - wr.y, 2); if (d < bd) { bd = d; best = i; } });
      wr.travel(cs[best][0], cs[best][1]);
      for (var k = 1; k <= 4; k++) wr.extrude(cs[(best + k) % 4][0], cs[(best + k) % 4][1], feed);
      return cs.map(function (c, i) { return cs[(best + i) % 4]; });     /* from the start corner, counter-clockwise */
    };
    /* where each purge of the layer starts its band, on the wall (get_wall_skip_points) */
    var skipPoints = function (L) {
      if (!gapWall) return [];
      var i = L.pj % 4;
      return L.changes.map(function (c) {
        var s0 = f32(w + L.yShift + c.at), wd = c.req;
        if (i === 0) return [0, s0];
        if (i === 1) return [W, f32(s0 + wd - f32(extra * w))];
        if (i === 2) return [W, s0];
        return [0, f32(s0 + wd - f32(extra * w))];
      });
    };

    /**
     * finish_layer_new: the layer's wall (and, without a change, the rectangle and grid inside it; the brim / chamfer). Returns
     * { lines (as Studio's writer writes them, tower coordinates), start, end (tower coordinates), wipe: [points the wipe follows, tower
     * coordinates], e, slot }.
     */
    T.finish = function (pj, fill, slot) {
      var L = layers[pj], first = pj === 0, ys = L.yShift;
      var fb = [w, f32(w + ys), f32(W - w), f32(L.depth - w + ys)];          /* x0 y0 x1 y1 */
      var start = T.ltr ? [fb[2], fb[3]] : [fb[0], fb[3]];
      var wr = writerFor(L, slot, start[0], start[1]);
      wr.lines = header(L).concat(['; WIPE_TOWER_START']);
      var feed = feedFor(slot, wr.o.flow, first), rt = retractOf(slot);
      if (fill) {
        /* the rectangle round the grid (rectangle_fill_box) */
        var cs = [[fb[0], fb[1]], [fb[2], fb[1]], [fb[2], fb[3]], [fb[0], fb[3]]];
        var ic = 0;
        if (wr.x - fb[0] > fb[2] - wr.x) ic = 1;
        if (wr.y - fb[1] > fb[3] - wr.y) ic = ic === 0 ? 3 : 2;
        wr.travel(cs[ic][0], wr.y); wr.travel(wr.x, cs[ic][1]);
        for (var k = 1; k <= 4; k++) wr.extrude(cs[(ic + k) % 4][0], cs[(ic + k) % 4][1], feed);
        var dy = f32(fb[3] - fb[1] - w), left = f32(fb[0] + 2 * w), right = f32(fb[2] - 2 * w);
        if (dy > w) {
          wr.travel(f32(fb[0] + 2 * w), fb[1]);
          wr.lines.push(';--------------------', '; CP EMPTY GRID START', '; layer #' + (pj + 2));
          if (first) {
            left = f32(left - w); right = f32(right + w);
            var y = f32(fb[1] + w), nn = Math.floor(dy / w), spc = nn > 1 ? f32(f32(dy - w) / (nn - 1)) : 0;
            for (var r = 0; r < nn; r++) { wr.extrude(wr.x, y, feed); wr.extrude(r % 2 ? left : right, y); y = f32(y + spc); }
            wr.extrude(wr.x, fb[3]);
          } else {
            wr.extrude(f32(fb[0] + 2 * w), fb[3], feed);
            var nb = 1 + Math.floor((right - left) / 10), dxb = nb > 0 ? f32(f32(right - left) / nb) : 0;
            for (var b = 1; b <= nb; b++) { var xb = f32(left + f32(dxb * b)); wr.travel(xb, wr.y); wr.extrude(xb, b % 2 ? fb[1] : fb[3]); }
          }
          wr.lines.push('; CP EMPTY GRID END', ';------------------', '', '', '', '', '', '');
        }
      }
      /* the outer wall */
      var box = [0, f32(ys), W, f32(L.depth + w + ys)];
      var gw = gapWallPolylines(box, fill ? null : skipPoints(L));
      var drawn = drawWall(wr, gw.lines, feed, rt);
      var ring = null;
      /* the brim, then a chamfer one loop narrower a layer (brim_chamfer_loops_num; none once the depth changes) */
      var sp = spacingFor(L.h), loops = Math.max(0, Math.floor((brim + sp / 2) / sp)), st3 = loopStep(L.h);
      if (!first) loops = L.depth !== layers[0].depth ? 0 : Math.max(0, Math.min(loops, Math.floor(3 / sp)) - pj);
      var r0 = box.slice();
      for (var lp = 0; lp < loops; lp++) {
        var o3 = (lp + 1) * st3;
        r0 = [f32(box[0] - o3), f32(box[1] - o3), f32(box[2] + o3), f32(box[3] + o3)];
        ring = drawLoop(wr, r0, feed);
      }
      /* the wipe goes back along what was drawn last (add_wipe_path: the polygon from the nearest point, reversed) */
      var wipe;
      if (ring) wipe = [ring[0], ring[3], ring[2], ring[1], ring[0]];
      else {
        var poly = gw.poly, bi2 = 0, bd2 = Infinity;
        poly.forEach(function (p, i) { var d = Math.pow(p[0] - wr.x, 2) + Math.pow(p[1] - wr.y, 2); if (d < bd2) { bd2 = d; bi2 = i; } });
        wipe = [];
        for (var u = 0; u <= poly.length; u++) wipe.push(poly[(bi2 - u + poly.length) % poly.length]);
      }
      wr.lines.push('; WIPE_TOWER_END');
      return { lines: wr.lines, start: start, end: [wr.x, wr.y], wipe: wipe, e: wr.e, slot: slot, drawn: drawn };
    };

    /**
     * finish_block: on a layer whose purges do not fill the tower's depth, the rest of the band - its rectangle and a sparse grid - so
     * the purges of the layers above have something under them. null when the purges fill it. NSO prints it in the visit that carries
     * the wall, just before the wall (Studio picks the visit by the band's filament: the same lines, maybe another visit).
     */
    T.blockFill = function (pj, slot) {
      var L = layers[pj], first = pj === 0, ys = L.yShift;
      if (!L.changes.length) return null;
      var y0 = f32(w + ys + L.req), y1 = f32(w + ys + L.depth - w);
      if (y1 - y0 <= 1e-3) return null;
      var fb = [w, y0, f32(W - w), y1];
      var start = T.ltr ? [fb[2], fb[3]] : [fb[0], fb[3]];
      var wr = writerFor(L, slot, start[0], start[1]);
      wr.lines = header(L).concat(['; WIPE_TOWER_START']);
      var feed = feedFor(slot, wr.o.flow, first);
      var cs = [[fb[0], fb[1]], [fb[2], fb[1]], [fb[2], fb[3]], [fb[0], fb[3]]], ic = 0;
      if (wr.x - fb[0] > fb[2] - wr.x) ic = 1;
      if (wr.y - fb[1] > fb[3] - wr.y) ic = ic === 0 ? 3 : 2;
      for (var k = 1; k <= 4; k++) wr.extrude(cs[(ic + k) % 4][0], cs[(ic + k) % 4][1], feed);
      var dy = f32(fb[3] - fb[1] - w), left = f32(fb[0] + 2 * w), right = f32(fb[2] - 2 * w);
      if (dy > w) {
        wr.travel(f32(fb[0] + 2 * w), fb[1]);
        wr.lines.push(';--------------------', '; CP EMPTY GRID START', '; layer #' + (pj + 2));
        wr.extrude(f32(fb[0] + 2 * w), fb[3], feed);
        var nb = 1 + Math.floor((right - left) / 10), dxb = nb > 0 ? f32(f32(right - left) / nb) : 0;
        for (var b = 1; b <= nb; b++) { var xb = f32(left + f32(dxb * b)); wr.travel(xb, wr.y); wr.extrude(xb, b % 2 ? fb[1] : fb[3]); }
        wr.lines.push('; CP EMPTY GRID END', ';------------------', '', '', '', '', '', '');
      }
      wr.lines.push('; WIPE_TOWER_END');
      return { lines: wr.lines, start: start, end: [wr.x, wr.y], wipe: [[wr.x, wr.y], [wr.x, fb[1]]], e: wr.e, slot: slot };
    };

    /** get_next_pos: where the purge starts on this layer */
    var purgeStart = function (L, k) {
      var c = L.changes[k];
      var xl = w, xr = f32(W - w), y0 = f32(w + L.yShift + c.at), depth = c.req, first = L.pj === 0;
      var dy = first ? w : f32(extra * w);
      var yOff = Math.max(0, f32(depth - dy));
      var cnt = Math.max(1, Math.ceil(c.wipeLen / f32(xr - xl)));
      yOff = Math.min(f32((cnt - 1) * dy), yOff);
      var i = L.pj % 4;
      if (i === 0) return [xl, y0];
      if (i === 1) return [xr, f32(y0 + yOff)];
      if (i === 2) return [xr, y0];
      return [xl, f32(y0 + yOff)];
    };
    T.purgeStart = function (pj, k) { return purgeStart(layers[pj], k); };

    /**
     * toolchange_wipe_new: the new filament primes across the tower, a line at a time (line ironing at the start of the first), slow at
     * first. Returns { lines (from the tag to the end of the change's text), start, end, wipe, e }.
     */
    T.purge = function (pj, k, dry) {
      var L = layers[pj], c = L.changes[k], first = pj === 0, slot = c.to, start = purgeStart(L, k);
      var wr = writerFor(L, slot, start[0], start[1]);
      wr.lines = ['; CP_TOOLCHANGE_WIPE CT0 FL' + (first ? 1 : 0)];
      if (first) wr.lines.push('; LINE_WIDTH: ' + T.lineTag);
      var rt = retractOf(slot), xl = w, xr = f32(W - w), ld = f32(w + L.yShift + c.at), lu = f32(ld + c.req);
      var dy = first ? w : f32(extra * w), xToWipe = c.wipeLen;
      var target = feedFor(slot, wr.o.flow, first);
      var map = [f32(0.33 * target), f32(0.375 * target), f32(0.458 * target), f32(0.875 * target), Math.min(target, f32(f32(0.875 * target) + 50))];
      var ltr = (pj + 3) % 4 >= 2, fromUp = pj % 2 === 1, ws = map[0];
      for (var i = 0; ; i++) {
        if (i < map.length) ws = map[i];
        if (i === 0 && gapWall && lineIroning) {
          var il = 3, sgn = ltr ? 1 : -1, dx = (ltr ? xr : xl) - wr.x;
          if (Math.abs(dx) < il) il = Math.abs(dx);
          wr.extrude(wr.x + sgn * il, wr.y, ws);
          wr.load(-rt.len, rt.F);
          wr.travel(wr.x - sgn * 1.5 * il, wr.y, 600);
          wr.travel(wr.x + sgn * 1.5 * il, wr.y, 240);
          wr.load(rt.len, rt.F);
        }
        wr.extrude(ltr ? xr : xl, wr.y, ws);
        if (!fromUp && wr.y + dy - 1e-4 > lu - w) break;
        if (fromUp && wr.y - dy + 1e-4 < ld) break;
        xToWipe = f32(xToWipe - f32(xr - xl));
        if (xToWipe < 1e-3) break;
        wr.extrude(wr.x, fromUp ? f32(wr.y - dy) : f32(wr.y + dy));
        ltr = !ltr;
      }
      var wipe = [[wr.x, wr.y], [!ltr ? W : 0, wr.y]];
      /* the next thing on the tower goes the other way, unless this was the layer's last change */
      if (k < L.changes.length - 1) ltr = !ltr;
      if (!dry) T.ltr = ltr;
      wr.lines.push('; WIPE_TOWER_END', 'M220 R');
      wr.feedrate(travelF);
      wr.lines.push('G4 S0', 'G92 E0', '; CP TOOLCHANGE END', ';------------------', '', '');
      return { lines: wr.lines, start: start, end: [wr.x, wr.y], wipe: wipe, e: wr.e, slot: slot };
    };
    /** the header of a change's text, before the old filament's end G-code */
    T.changeHead = function (pj, fromType, toType) {
      T.count++;
      return header(layers[pj]).concat([';--------------------', '; CP TOOLCHANGE START', '; toolchange #' + T.count,
        '; material : ' + fromType + ' -> ' + toType, ';--------------------', 'M220 B', 'M220 S100', '; WIPE_TOWER_START']);
    };
    /** the merge's travel between two parts of a visit (merge_tcr), as the writer writes it */
    T.mergeTravel = function (to) { return 'G1 X' + wtF3(to[0]) + ' Y' + wtF3(to[1]) + ' F' + Math.round(maxSpeed); };

    /**
     * The way to the tower after a change (generate_path_to_wipe_tower): from where the change block left the nozzle, round the tower's
     * box (its brim, 2 mm out) to the side the purge starts from. Plate coordinates; the last point is the purge's start.
     */
    T.approach = function (from, to) {
      var bx = [T.box.x0 - 2, T.box.y0 - 2, T.box.x1 + 2, T.box.y1 + 2];
      var poly = [[bx[0], bx[1]], [bx[2], bx[1]], [bx[2], bx[3]], [bx[0], bx[3]]];
      var width = bx[2] - bx[0];
      if (bx[0] < 0 || bx[1] < 0 || bx[2] > bed.x || bx[3] > bed.y) return [to];
      var v = Math.abs(to[0] - bx[0]) < width / 2 ? -1 : 1;
      var hit = -1, p = null;
      for (var i = 0; i < 4 && hit < 0; i++) {
        var a = poly[i], b = poly[(i + 1) % 4];
        if (Math.abs(a[0] - b[0]) > 1e-9) continue;
        var t1 = (a[0] - to[0]) * v, lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
        if (t1 >= 0 && to[1] >= lo && to[1] <= hi) { hit = i; p = [a[0], to[1]]; }
      }
      if (hit < 0) return [to];
      var hit2 = -1, p2 = null;
      for (var j = 0; j < 4 && hit2 < 0; j++) {
        if (j === hit) continue;
        var c = poly[j], d = poly[(j + 1) % 4];
        var x = segX(from, p, c, d);
        if (x) { hit2 = j; p2 = x; }
      }
      if (hit2 < 0) return [p, to];
      var around = function (fwd) {
        var path = [p2], len = 0, i0 = fwd ? (hit2 + 1) % 4 : hit2, end = fwd ? hit : (hit + 1) % 4, i = i0;
        len += Math.pow(p2[0] - poly[i0][0], 2) + Math.pow(p2[1] - poly[i0][1], 2);
        while (i !== end) {
          var ni = fwd ? (i + 1) % 4 : (i + 3) % 4;
          len += Math.pow(poly[i][0] - poly[ni][0], 2) + Math.pow(poly[i][1] - poly[ni][1], 2);
          path.push(poly[i]); i = ni;
        }
        path.push(poly[end]); path.push(p);
        len += Math.pow(p[0] - poly[end][0], 2) + Math.pow(p[1] - poly[end][1], 2);
        return { path: path, len: len };
      };
      var A1 = around(true), A2 = around(false);
      return (A1.len < A2.len ? A1.path : A2.path).concat([to]);
    };
    T.slopeLen = function (hop) { return hop / WT_SLOPE; };
    return T;
  }
  /** where segment a-b crosses segment c-d, or null */
  function segX(a, b, c, d) {
    var rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
    var den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;
    var t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den, u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return [a[0] + t * rx, a[1] + t * ry];
  }

  /**
   * THE ORDER OF EACH LAYER'S FILAMENTS (Studio's ToolOrderUtils: reorder_filaments_for_minimum_flush_volume, get_extruders_order,
   * solve_extruder_order_with_forcast): layer by layer, the order of its filaments that purges the least over it and the next layer
   * together, from the one loaded - every order of both tried, the cheapest kept, a tie to the fewer changes, else the first found;
   * a layer of one filament is that one. M: the purge table [from][to]; sets: each layer's filaments, ascending; start: the one loaded (or
   * null). Returns each layer's order.
   */
  function orderColours(M, sets, start) {
    var nextPerm = function (a) {
      var i = a.length - 2; while (i >= 0 && a[i] >= a[i + 1]) i--;
      if (i < 0) return false;
      var j = a.length - 1; while (a[j] <= a[i]) j--;
      var t = a[i]; a[i] = a[j]; a[j] = t;
      for (var l = i + 1, r = a.length - 1; l < r; l++, r--) { t = a[l]; a[l] = a[r]; a[r] = t; }
      return true;
    };
    var forecast = function (cur, next, from) {
      cur = cur.slice().sort(function (a, b) { return a - b; });
      var best = Infinity, bestCh = Infinity, seq = null;
      var changes = function (c, n2) { var k = 0, p = from; [c, n2].forEach(function (s) { s.forEach(function (e) { if (p != null && p !== e) k++; p = e; }); }); return k; };
      do {
        var p = from, cc = 0;
        cur.forEach(function (e) { if (p != null) cc += M[p][e]; p = e; });
        if (cc > best) continue;
        var nx = next.slice().sort(function (a, b) { return a - b; });
        do {
          var p2 = p, t = cc;
          nx.forEach(function (e) { if (p2 != null) t += M[p2][e]; p2 = e; });
          var ch = changes(cur, nx);
          if (t < best || (t === best && ch < bestCh)) { best = t; seq = cur.slice(); bestCh = ch; }
        } while (nextPerm(nx));
      } while (nextPerm(cur));
      return seq;
    };
    var out = [], c = start;
    sets.forEach(function (S0, i) {
      var seq = S0.length < 2 ? S0.slice() : forecast(S0, sets[i + 1] || [], c);
      out.push(seq);
      if (seq.length) c = seq[seq.length - 1];
    });
    return out;
  }

  /** Studio's cooling buffer writes a G0 / G1's F only when it changes: the F of each such line that repeats the one in force is dropped
   *  (" F3000" out of "G1 X90 F3000" after "G1 Y265 F3000"). `f` is the F in force before the first line; returns { lines, f }. */
  function dropRepeatedF(lines, f) {
    var out = lines.map(function (l) {
      var m = /^(G[01]\b[^;]*?)\s+F(\d+(?:\.\d+)?)(\b[^;]*)(;.*)?$/.exec(l);
      if (!m) return l;
      var v = +m[2];
      if (f != null && v === f) { var rest = (m[1] + m[3]).replace(/\s+$/, ''); return m[4] != null ? rest + ' ' + m[4] : rest; }
      f = v;
      return l;
    });
    return { lines: out, f: f };
  }

  /**
   * A frozen block as lines of text with the plate's numbers put in
   * (tools/print-planner/freeze.js says what each token is). There is no
   * template language here: a block holds a handful of tokens, plus
   *   { hook: 'spaghetti', line }          kept unless opts.spaghetti === false
   *   { zTop: [..], zTopElse: [..], cap }  the end block's "lift the head" pair
   * and "@M73 <seconds>" lines, which come through as they are for the caller
   * to turn into M73 P/R once it knows the print's time.
   * The filament's tokens (absent from `v`: PLA at the frozen slice's own numbers are
   * the caller's to give - plan() always does):
   *   {FTYPE}            filament_type
   *   {FLUSHF}           flush_volumetric_speeds / 2.4053 * 60
   *   {FLUSHT}           flush_temperatures
   *   {OW*n} {OW/2.4}    outer_wall_volumetric_speed times n (the purge line's feeds), or / 2.4
   *   {PLA?a:b}          the template's {if filament_type == "PLA"} a {else} b; b may be FLUSHT
   *   {?PLA} {?PLAHOT}   at a line's start: the line is the template's only for PLA
   *                      (PLAHOT: and a bed over 45). Another filament has no such line;
   *                      PLA on a cooler bed has an empty one
   * @param {Array} lines  a frozen start / afterStart / beforeEnd / end
   * @param {object} v     { nozzle, nozzleT, bed, bedMax, box:{x,y,w,h}, cy, maxZ, filamentType, flushV, flushT, ow }
   */
  /**
   * THE START BLOCK FOR ANOTHER NOZZLE. The frozen start is the owner's Studio slice at a 0.4 nozzle; Bambu's start G-code for the P1S's other
   * nozzles (Studio 02.09.01.70, "Bambu Lab P1S 0.x nozzle template machine_start_gcode") differs from its 0.4 one in three places, put here:
   * the header line names the nozzle; at 0.2 and 0.6 the second chamber-fan line (PLA on a bed over 45) runs the fan full (S255) over a 50 C bed;
   * at 0.6 the purge line lays more (E25 where 0.4's E15, E1.166 where its E0.7). The A1 mini's start is the same text for every nozzle.
   */
  function nozzleFrozen(Pr, config) {
    if (!Pr || !config) return Pr;
    var nz = String(raw(config, 'nozzle_diameter') || Pr.nozzle || '0.4');
    if (!Pr.nozzle || +nz === +Pr.nozzle || !/P1S/i.test(String(Pr.printer || ''))) return Pr;
    var plaHot = 0, start = Pr.start.map(function (l) {
      if (typeof l !== 'string') return l;
      if (/^;===== machine: P1S-[\d.]+ =/.test(l)) return l.replace(/P1S-[\d.]+/, 'P1S-' + nz);
      if (/^\{\?PLAHOT\}\s*M106 P3 S180$/.test(l) && ++plaHot === 2 && (+nz === 0.2 || +nz === 0.6)) return l.replace('S180', 'S{CHF}');
      if (+nz === 0.6) {
        if (/^G0 X240 E15 /.test(l)) return l.replace('E15', 'E25');
        if (/^G0 X18 E15 /.test(l)) return l.replace('E15', 'E25');
        if (/^G0 Y11 E0\.700 /.test(l)) return l.replace('Y11 E0.700', 'Y15 E1.166');
        if (/^G0 Y1\.5 E0\.700$/.test(l)) return 'G0 Y1.5 E1.166';
      }
      return l;
    });
    return Object.assign({}, Pr, { start: start, nozzle: nz });
  }

  function thaw(lines, v, opts) {
    opts = opts || {};
    var pla = String(v.filamentType || 'PLA') === 'PLA';
    var sub = function (s) {
      if (s.charAt(0) === '{' && s.charAt(1) === '?') {
        var cond = /^\{\?(PLAHOT|PLA)\}/.exec(s);
        if (cond) {
          if (!pla) return null;
          if (cond[1] === 'PLAHOT' && !((v.bedMax != null ? v.bedMax : v.bed) > 45)) return '';
          s = s.slice(cond[0].length);
        }
      }
      return s
        .replace(/\{PLA\?([^:}]*):([^}]*)\}/g, function (a, yes, no) { var t = pla ? yes : no; return t === 'FLUSHT' ? tnum(v.flushT) : t; })
        .replace(/\{FTYPE\}/g, String(v.filamentType || 'PLA'))
        .replace(/\{FLUSHF\}/g, function () { return gnum(v.flushV / 2.4053 * 60); })
        .replace(/\{FLUSHT\}/g, function () { return tnum(v.flushT); })
        .replace(/\{OW\*(\d+)\}/g, function (a, n) { return gnum(v.ow * +n); })
        .replace(/\{OW\/2\.4\}/g, function () { return gnum(v.ow / 2.4); })
        .replace(/\{N-20\}/g, tnum(v.nozzle - 20)).replace(/\{N-40\}/g, tnum(v.nozzle - 40))
        .replace(/\{N\}/g, tnum(v.nozzle)).replace(/\{T\}/g, tnum(v.nozzleT)).replace(/\{B\}/g, tnum(v.bed))
        /* the bed-mesh box as Studio prints it, six significant digits (Y4.06651 on the owner's A1 mini PETG slice; four decimals wrote 4.0665) */
        .replace(/\{BX\}/g, gnum(v.box.x)).replace(/\{BY\}/g, gnum(v.box.y))
        .replace(/\{BW\}/g, gnum(v.box.w)).replace(/\{BH\}/g, gnum(v.box.h))
        .replace(/\{CY\}/g, tnum(v.cy))
        .replace(/\{CHF\}/g, ((v.bedMax != null ? v.bedMax : v.bed) > 50) ? '255' : '180')
        .replace(/\{Z\+0\.4\}/g, tnum(v.maxZ + 0.4)).replace(/\{Z\+0\.5\}/g, tnum(v.maxZ + 0.5))
        .replace(/\{Z\+100\}/g, tnum(v.maxZ + 100)).replace(/\{Z\+98\}/g, tnum(v.maxZ + 98));
    };
    var out = [];
    lines.forEach(function (l) {
      if (typeof l === 'string') { var t = sub(l); if (t !== null) out.push(t); }
      else if (l.hook) { if (opts[l.hook] !== false) out.push(l.line); }
      else if (l.zTop) (v.maxZ + 100 < l.cap ? l.zTop : l.zTopElse).forEach(function (z) { out.push(sub(z)); });
      else throw new Error('unknown frozen element ' + JSON.stringify(l));
    });
    return out;
  }

  /** The first layer's box as Studio's bed-leveling line has it (G29 A X Y I J):
   *  the first layer's beads, each widened by half its line width. */
  function firstLayerBox(res) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    res.objects.forEach(function (ob) {
      var L = ob.layers[0];
      if (!L) return;
      L.paths.forEach(function (p) {
        var hw = p.width / 2;
        p.pts.forEach(function (q) {
          if (q[0] - hw < x0) x0 = q[0] - hw; if (q[0] + hw > x1) x1 = q[0] + hw;
          if (q[1] - hw < y0) y0 = q[1] - hw; if (q[1] + hw > y1) y1 = q[1] + hw;
        });
      });
    });
    return isFinite(x0) ? { x: +x0.toFixed(4), y: +y0.toFixed(4), w: +(x1 - x0).toFixed(4), h: +(y1 - y0).toFixed(4) } : null;
  }


  // ===========================================================================
  // Markers, as Bambu writes them
  // ===========================================================================

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function base64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      s += B64.charAt(a >> 2) + B64.charAt(((a & 3) << 4) | (b >> 4)) +
           (i + 1 < bytes.length ? B64.charAt(((b & 15) << 2) | (c >> 6)) : '=') +
           (i + 2 < bytes.length ? B64.charAt(c & 63) : '=');
    }
    return s;
  }

  /**
   * The mask M624 takes: one bit per object, by its place in the plate's label
   * order, as a 64-bit little-endian integer in base64. Measured on the owner's
   * two-object A1 mini slice: the first object is AQAAAAAAAAA=, the second
   * AgAAAAAAAAA=, both of them AwAAAAAAAAA=. (The third follows the same law,
   * BAAAAAAAAAA=; no Bambu slice with three objects is in the repo to confirm it.)
   */
  function objectMask(indexes) {
    var bytes = [0, 0, 0, 0, 0, 0, 0, 0];
    indexes.forEach(function (i) {
      if (i < 0 || i > 63) throw new Error('object ' + i + ' does not fit M624\'s 64-bit mask');
      bytes[i >> 3] |= 1 << (i & 7);
    });
    return base64(bytes);
  }

  /** Studio's "18m 34s" / "1h 2m 3s". */
  function duration(sec) {
    sec = Math.round(sec);
    var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    var out = [];
    if (d) out.push(d + 'd');
    if (d || h) out.push(h + 'h');
    if (d || h || m) out.push(m + 'm');
    out.push(s + 's');
    return out.join(' ');
  }

  /** The per-layer hook (timelapse photo, nozzle-clog check) as Studio expands
   *  time_lapse_gcode for this layer, from the printer's frozen variants. */
  function hookLines(Pr, layerNo, z, cy, flags, wrap) {
    var v = Pr.hooks.variants[Math.min(layerNo, 4)];
    var tl = flags.timelapse !== false && v.timelapse.length, clog = flags.clog !== false && v.clog.length;
    if (!tl && !clog) return [];
    var zh = z + 0.4;
    var sub = function (s) {
      return s.replace(/\{ZH:3\}/g, zh.toFixed(3)).replace(/\{ZH\}/g, tnum(zh)).replace(/\{CY\}/g, tnum(cy));
    };
    var lines = [].concat(v.pre, tl ? v.timelapse : [], clog ? v.clog : [], v.post).map(sub);
    return lines;
  }

  /** A changed value as the CONFIG_BLOCK holds it: once per slot the line had (a per-filament key on a two-filament
   *  template: "220,220", PLA;PLA, "a b";"a b"), in quotes when Studio would quote it (a value with a space, a separator or a quote). */
  function configValue(was, value) {
    var slots = [], cur = '', q = false, sep = '';
    for (var i = 0; i < was.length; i++) {
      var c = was.charAt(i);
      if (q) { cur += c; if (c === '\\') { cur += was.charAt(++i); } else if (c === '"') q = false; }
      else if (c === '"') { q = true; cur += c; }
      else if (c === ',' || c === ';') { if (!sep) sep = c; if (c === sep) { slots.push(cur); cur = ''; } else cur += c; }
      else cur += c;
    }
    slots.push(cur);
    var quote = function (x) {
      x = String(x);
      return /[\s;,"]/.test(x) ? '"' + x.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"' : x;
    };
    /* a list (a painted project's filaments: one entry a slot): each entry as Studio writes it, joined as the line joins its slots */
    if (Array.isArray(value)) {
      /* Studio joins numbers with ',' and words with ';' (filament_colour = #8E9089;#FFFFFF;#000000, filament_type = PLA;PLA;PLA) */
      var sp = sep || (value.every(function (x) { return /^(-?[\d.]+%?|nil)$/.test(String(x)); }) ? ',' : ';');
      return value.map(quote).join(sp);
    }
    /* a single value Studio did not quote (a plain string option: printer_settings_id = Bambu Lab A1 mini 0.6 nozzle) stays bare */
    if (slots.length < 2 && was.charAt(0) !== '"') return String(value).replace(/\n/g, '\\n');
    var text = quote(value);
    if (slots.length < 2) return text;
    return slots.map(function () { return text; }).join(sep);
  }


  /** The CONFIG_BLOCK: Studio's own for this printer, with NSO's cooling keys put in, and any process
   *  setting the caller changed from the template (`over`, { key: value } - the Slice card's settings). */
  function configLines(Pr, S, over) {
    var map = typeof S.coolingId === 'object' && S.coolingId ? S.coolingId : Cooling.resolveValues(S.coolingId);
    return Pr.configBlock.map(function (l) {
      var m = /^; ([^ =]+) = (.*)$/.exec(l);
      if (m && over && Object.prototype.hasOwnProperty.call(over, m[1])) return '; ' + m[1] + ' = ' + configValue(m[2], over[m[1]]);
      if (!m || !Object.prototype.hasOwnProperty.call(map, m[1])) return l;
      /* NSO's cooling keys on every filament: a painted project's count of them when it brings its list */
      var slots = over && Array.isArray(over.filament_colour) ? over.filament_colour.length : m[2].split(',').length;
      var v = [];
      for (var i = 0; i < slots; i++) v.push(map[m[1]]);
      return '; ' + m[1] + ' = ' + v.join(',');
    });
  }

  /** afterStart with the template filament's own start G-code (everything before Studio's ";VT0" line) replaced by another filament's. */
  function withFilamentStart(afterStart, lines) {
    if (!lines) return afterStart;
    var at = -1;
    for (var i = 0; i < afterStart.length; i++) if (typeof afterStart[i] === 'string' && /^;VT\d/.test(afterStart[i])) { at = i; break; }
    if (at < 0) throw new Error('the printer\'s frozen afterStart has no ";VT0" line to put the filament\'s start G-code before');
    return lines.concat(afterStart.slice(at));
  }

  // ===========================================================================
  // The plan
  // ===========================================================================

  /**
   * Supports on their own layer grid (the slicer's supportLayerMaxMm: object.planes
   * beside res.planes) put into ONE timeline: every height any object prints at,
   * ascending, each object's layers on the heights it has (null elsewhere). A slice
   * with no own grids comes back untouched, so nothing changes for it.
   */
  function alignGrids(res) {
    if (!res.objects.some(function (ob) { return ob.planes; })) return res;
    var key = function (z) { return Math.round(z * 10000); };
    var by = {}, zs = [];
    var add = function (pl, h) { var k = key(pl.printZ); if (!by[k]) { by[k] = { printZ: pl.printZ, h: h }; zs.push(by[k]); } };
    res.planes.forEach(function (pl) { add(pl, pl.h); });
    res.objects.forEach(function (ob) {
      if (!ob.planes) return;
      ob.planes.forEach(function (pl, i) { var L = ob.layers[i]; if (L && L.paths && L.paths.length) add(pl, L.h || pl.h); });
    });
    zs.sort(function (a, b) { return a.printZ - b.printZ; });
    var at = {};
    zs.forEach(function (pl, i) { at[key(pl.printZ)] = i; });
    var objects = res.objects.map(function (ob) {
      var src = ob.planes || res.planes, layers = new Array(zs.length);
      for (var i = 0; i < zs.length; i++) layers[i] = null;
      src.forEach(function (pl, i) {
        var j = at[key(pl.printZ)];
        if (j != null && ob.layers[i]) layers[j] = ob.layers[i];
      });
      var o2 = Object.assign({}, ob, { layers: layers });
      delete o2.planes;
      return o2;
    });
    return Object.assign({}, res, { planes: zs, objects: objects });
  }

  /**
   * @param {object} res    sliceObjects() result
   * @param {object} opts
   *   config   the printer template's project settings (the object)
   *   printer  the printer's frozen blocks (fixtures/print-planner/<id>/frozen.json)
   *   cooling  a cooling profile id (default NSO's default) or the resolved keys
   *   hooks    { spaghetti, timelapse, clog }: false leaves one out; default as the template
   *   labelIds the objects' label ids (default 1001, 1002 ...)
   *   configOver  { key: value } process settings changed from the template (already in `config`), written into the CONFIG_BLOCK
   *   filamentStart  the filament's own start G-code, expanded (lines): it replaces the template filament's, which opens afterStart
   *   tempSteps   { stepC, bandMm }: the nozzle temperature changes by stepC at every bandMm of height (see the head of this file)
   *   bridgeTemp  the nozzle temperature a layer's bridges print at, changed at the printer's park (see the head of this file)
   *   bridgeTempFrom  a layer number (the first is 1): from it to the top every layer prints at bridgeTemp
   * @returns {{ok, reason, gcode, layers, stats, settings, labels}}
   */
  function plan(res, opts) {
    opts = opts || {};
    if (!res || !res.ok) return { ok: false, reason: 'nothing to plan: ' + (res && res.reason || 'no slice') };
    res = alignGrids(res);
    if (!opts.config) return { ok: false, reason: 'the printer template\'s project settings (opts.config) are required' };
    if (!opts.printer) return { ok: false, reason: 'the printer\'s frozen start / end (opts.printer) is required' };
    var Pr = nozzleFrozen(opts.printer, opts.config);
    var cooling = opts.cooling == null ? Cooling.DEFAULT_PROFILE_ID : opts.cooling;
    var S = settingsFrom(opts.config, cooling);
    S.coolingId = cooling;
    /* HANGING WALL SPEED (opts.hangSpeed, docs/FILAMENTS.md): a wall that hangs over open air from end to end (the slicer's path.span) prints
       at the bridge's speed, as Studio's does; a filament can slow it on its own (CR-TPU: the owner's tower level of 2026-11-15, its front lip
       sagging at 42 mm/s). Never faster than the bridge's speed, and the max flow still holds it. */
    var coolWait = opts.coolWait > 0 ? +opts.coolWait : 0;
    /* THE COOL PILLAR (opts.coolPillarObj: the index of the app's pillar object): printed first on each layer, the wait spent over it */
    /* PAUSE AT (opts.pauseAt: heights, mm): before the first layer at or over each, the nozzle retracts, lifts 5 mm, goes to the printer's park
       (the A1 mini's purge spot; elsewhere the plate's back-left corner) and the printer pauses (Bambu's machine_pause_gcode, M400 U1) - for
       the owner's steady chuck, set over a thin stem by hand; the layer's own travel brings the nozzle back down */
    var pauseAt = (opts.pauseAt || []).map(Number).filter(function (h) { return h > 0; }).sort(function (a, b) { return a - b; }), pauseK = 0, pauseStat = [];
    var pillarObj = opts.coolPillarObj != null && opts.coolPillarObj >= 0 ? +opts.coolPillarObj : -1;
    S.speed.hang = opts.hangSpeed > 0 ? Math.min(+opts.hangSpeed, S.speed.bridge) : S.speed.bridge;
    var F = S.filament, R = S.retract;
    var filA = Math.PI * F.diameter * F.diameter / 4;

    if (res.objects.length > 64) return { ok: false, reason: 'M624\'s mask holds 64 objects; the plate has ' + res.objects.length };
    var box = firstLayerBox(res);
    if (!box) return { ok: false, reason: 'nothing prints on the first layer' };
    var bed = Pr.bed;
    if (box.x < 0 || box.y < 0 || box.x + box.w > bed.x || box.y + box.h > bed.y) {
      return { ok: false, reason: 'the first layer (' + box.x.toFixed(1) + ',' + box.y.toFixed(1) + ' to ' + (box.x + box.w).toFixed(1) +
        ',' + (box.y + box.h).toFixed(1) + ') is not on the ' + Pr.printer + '\'s ' + bed.x + ' x ' + bed.y + ' mm bed' };
    }
    // the layers that print, in order
    var printing = [];
    for (var pi = 0; pi < res.planes.length; pi++) {
      if (res.objects.some(function (ob) { var Lr = ob.layers[pi]; return Lr && Lr.paths.length; })) printing.push(pi);
    }
    var top = res.planes[printing[printing.length - 1]].printZ;
    if (top > bed.z) return { ok: false, reason: 'the print is ' + top.toFixed(1) + ' mm tall; the ' + Pr.printer + ' prints ' + bed.z + ' mm' };
    var vals = { nozzle: S.temp.nozzleInitial, nozzleT: S.temp.nozzle, bed: S.temp.bedInitial, bedMax: Math.max(S.temp.bed, S.temp.bedInitial), box: box,
                 cy: box.y + box.h / 2, maxZ: top,
                 filamentType: F.type, flushV: F.flushVolumetric, flushT: F.flushTemp, ow: F.outerWallVolumetric };
    // ---- the temperature steps: each printing layer's nozzle temperature (the first layer keeps its own)
    var steps = opts.tempSteps && +opts.tempSteps.stepC && +opts.tempSteps.bandMm > 0
      ? { stepC: +opts.tempSteps.stepC, bandMm: +opts.tempSteps.bandMm } : null;
    var layerTemp = function (pl) {
      if (!steps) return S.temp.nozzle;
      return S.temp.nozzle + Math.floor((pl.printZ - pl.h + 1e-6) / steps.bandMm) * steps.stepC;
    };
    var bridgeT = opts.bridgeTemp != null && isFinite(+opts.bridgeTemp) ? +opts.bridgeTemp : null;
    if (bridgeT != null) {
      if (!PARK[Pr.id]) return { ok: false, reason: 'a bridge temperature needs the printer\'s own park and wipe moves, and they are written for the A1 mini only so far. Clear Bridge temp to slice for the ' + Pr.printer + '.' };
      if (bridgeT < S.temp.rangeLow || bridgeT > S.temp.rangeHigh) {
        return { ok: false, reason: 'the bridge temperature is ' + bridgeT + ' \u00b0C; this filament prints between ' + S.temp.rangeLow + ' and ' + S.temp.rangeHigh + ' \u00b0C.' };
      }
    }
    var bridgeStat = { temp: bridgeT, changes: 0, layers: 0 };
    var waitStat = { seconds: coolWait, layers: 0, total: 0 };
    /* THE STRETCH (the owner's print, 2026-11-14: cooled for the bridge lines, back up for the fill beside and over them, layer after layer).
       A layer with bridges prints whole at the bridge temperature - its walls over the gap and the fill beside the bridge too - and so do the
       BRIDGE_TEMP_COVER layers over it, which are laid straight onto the bridge. Stretches a few layers apart are one. So the nozzle changes
       once going in and once coming out, both at a layer change. */
    var coldLayer = [];
    if (bridgeT != null) {
      var hasBridge = printing.map(function (li0, pj0) {
        if (pj0 === 0) return false;
        var len = 0;
        res.objects.forEach(function (ob) {
          var Lr = ob.layers[li0];
          /* a bridge over open air (the slicer's path.free): one over sparse infill is held from below and prints well hot */
          if (Lr) Lr.paths.forEach(function (pth) { if (pth.feature === 'Bridge' && pth.free) len += pathLength(pth.closed ? pth.pts.concat([pth.pts[0]]) : pth.pts); });
        });
        return len >= BRIDGE_TEMP_MIN_MM;
      });
      var lastB = -Infinity;
      hasBridge.forEach(function (hb, pj0) {
        if (hb) {
          if (pj0 - lastB <= BRIDGE_TEMP_COVER + BRIDGE_TEMP_JOIN) for (var f0 = Math.max(0, lastB); f0 < pj0; f0++) coldLayer[f0] = true;
          lastB = pj0; bridgeStat.layers++;
        }
        coldLayer[pj0] = hb || pj0 - lastB <= BRIDGE_TEMP_COVER;
      });
      /* FROM A LAYER ON (opts.bridgeTempFrom, the card's "from layer"; Bambu's layer numbers, the first is 1): every layer from there to the
         top prints at the bridge temperature - one change in, none out. The owner's CR-TPU tower level (2026-11-15): 235 for the walls under
         the roof, 215 from the layer after the cone's tip through the bridge and the roof. */
      var fromL = +opts.bridgeTempFrom;
      if (fromL >= 2) for (var fl = fromL - 1; fl < printing.length; fl++) coldLayer[fl] = true;
    }
    var bands = [];
    if (steps) {
      for (var bi = 1; bi < printing.length; bi++) {
        var bpl = res.planes[printing[bi]], bt = layerTemp(bpl);
        if (!bands.length || bands[bands.length - 1].temp !== bt) bands.push({ temp: bt, fromZ: +(bpl.printZ - bpl.h).toFixed(4), layer: bi + 1 });
      }
      var bad = bands.filter(function (b) { return b.temp < S.temp.rangeLow || b.temp > S.temp.rangeHigh; })[0];
      if (bad) {
        return { ok: false, reason: 'the temperature steps reach ' + bad.temp + ' \u00b0C at ' + bad.fromZ + ' mm; this filament prints between ' +
          S.temp.rangeLow + ' and ' + S.temp.rangeHigh + ' \u00b0C. Change the start temperature, the step or the band height.' };
      }
    }
    var hooks = opts.hooks || {};
    var flags = { spaghetti: hooks.spaghetti !== false, timelapse: hooks.timelapse !== false, clog: hooks.clog !== false };

    var nObj = res.objects.length;
    var labelled = nObj > 1;                       // Studio labels objects when the plate has more than one
    var ids = res.objects.map(function (o, i) { return opts.labelIds && opts.labelIds[i] != null ? opts.labelIds[i] : 1001 + i; });
    var allMask = objectMask(res.objects.map(function (o, i) { return i; }));
    var idList = ids.join(',');

    /* MULTI-COLOUR (docs/MULTICOLOR.md): a layer of an object carries the filament slot it prints with (L.slot, 0-based; the app sets it from
       the piece's paint). With more than one slot, or one that is not the first, the print changes filament the way Studio's does: its own
       change block (the template's change_filament_gcode) with the purge from its table, at the layer change or between two objects. */
    var usedSlots = {};
    var slotsOf = function (L) { var o2 = {}; L.paths.forEach(function (p) { o2[p.slot != null ? p.slot : (L.slot || 0)] = 1; }); return Object.keys(o2).map(Number); };
    res.objects.forEach(function (ob) { ob.layers.forEach(function (L) { if (L && L.paths && L.paths.length) slotsOf(L).forEach(function (k) { usedSlots[k] = 1; }); }); });
    var MC = (Object.keys(usedSlots).length > 1 || !usedSlots[0]) ? multiColour(opts.config, res, Pr, S) : null;
    if (MC && MC.error) return { ok: false, reason: MC.error };
    /* the extruder's offset (the P1S template's extruder_offset is 0x2): Studio writes every move of the print that far back, the bed-mesh box
       not (the owner's 3-colour pyramid: printed 2 mm below its G29 box, in Y); custom blocks are the printer's own coordinates */
    var OFF = extruderOffset(opts.config);
    var gx = function (v) { return fx(v - OFF.x); }, gy = function (v) { return fx(v - OFF.y); };
    var hookAtStart = !!HOOK_AT_LAYER_START[Pr.id];
    /* THE PRIME TOWER (primeTower): when the project has it on and the plate changes filament; written for the P1S's layer change so far */
    var TW = null, towerNote = null, colourPlan = null;
    if (MC) {
      /* THE ORDER OF THE COLOURS (Studio's reorder_filaments_for_minimum_flush_volume): each layer's filaments in the order that purges the
         least over it and the next layer, from the one loaded - the owner's Gulf logo: white; white grey black; black grey white; white grey
         black; black white grey; black grey, as Studio's */
      var layerSets = printing.map(function (li0) {
        var seen = {};
        res.objects.forEach(function (ob) { var Lr = ob.layers[li0]; if (Lr && Lr.paths && Lr.paths.length) slotsOf(Lr).forEach(function (k) { seen[k] = 1; }); });
        return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
      });
      colourPlan = orderColours(MC.flushMatrix, layerSets, null);
      if (colourPlan[0] && colourPlan[0].length) MC.initial = colourPlan[0][0];
      var curC = MC.initial; MC.total = 0;
      colourPlan.forEach(function (sq) { sq.forEach(function (sl) { if (sl !== curC) { MC.total++; curC = sl; } }); });
      var objBoxes = res.objects.map(function (ob) {
        var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        ob.layers.forEach(function (Lr) { if (Lr && Lr.paths) Lr.paths.forEach(function (p) { var hw = (p.width || 0.5) / 2; p.pts.forEach(function (q) {
          if (q[0] - hw < b.x0) b.x0 = q[0] - hw; if (q[0] + hw > b.x1) b.x1 = q[0] + hw; if (q[1] - hw < b.y0) b.y0 = q[1] - hw; if (q[1] + hw > b.y1) b.y1 = q[1] + hw; }); }); });
        return b;
      }).filter(function (b) { return isFinite(b.x0); });
      var tw = primeTower(opts.config, S, MC, printing.map(function (li0) { return res.planes[li0]; }), colourPlan, objBoxes, bed, OFF);
      if (tw && tw.error) return { ok: false, reason: tw.error };
      if (tw && !hookAtStart) towerNote = 'the prime tower is written for the P1S so far: this ' + Pr.printer + ' plate changes filament without one';
      else TW = tw;
    }
    if (TW) {
      /* the bed-mesh box takes the tower and its brim in (Studio's G29 on the pyramid with the tower: X56.5786, from the brim's edge) */
      var bx1 = Math.max(box.x + box.w, TW.box.x1), by1 = Math.max(box.y + box.h, TW.box.y1);
      box.x = +Math.min(box.x, TW.box.x0).toFixed(4); box.y = +Math.min(box.y, TW.box.y0).toFixed(4);
      box.w = +(bx1 - box.x).toFixed(4); box.h = +(by1 - box.y).toFixed(4);
      vals.cy = box.y + box.h / 2;
    }

    // ---- the writer: every line with the print's clock at that line
    var W = { lines: [] };
    var put = function (l) { W.lines.push(l); };
    var st = { nozzleT: S.temp.nozzleInitial, x: null, y: null, z: 0, fan: null, layerFan: null, aux: null, A: null, feature: null, lw: null, lh: null, retracted: false,
               openObj: -1, objId: -1, pending: null, extruded: 0, slot: MC ? MC.initial : 0, retractLen: null, bySlot: {} };
    /** M204 only when the acceleration changes, as Studio writes it. */
    var accel = function (a) { var v = fmt(a, 0); if (st.A !== v) { put('M204 S' + v); st.A = v; } };
    var travelV = function (first) { return first ? S.speed.firstTravel : S.speed.travel; };
    var travelA = function (first) { return first ? S.accel.firstTravel : S.accel.travel; };

    thaw(Pr.start, vals, flags).forEach(function (l) {
      var m = /^@M73 (\d+)$/.exec(l);
      /* the first filament is loaded in the start block: its slot, when it is not the first (Studio's [initial_extruder]) */
      if (!m && MC && MC.initial !== 0 && typeof l === 'string') l = l.replace(/^(M62[01] S)0(A\b)/, '$1' + MC.initial + '$2').replace(/^(\s*T)0$/, '$1' + MC.initial);
      put(m ? { at: +m[1] } : l);
    });
    /* THE OBJECTS STILL TO PRINT (Studio 02.09.01.70 on the P1S, the owner's eight-part desk hanger, 2026-11-20): with more than one
       object on the plate Studio writes the set still to print, as M624's mask - after the start block (every object), at the layer
       change where an object has printed its last layer (after that layer's M625), and empty after the last one. Not yet seen in an
       A1 mini slice, so written for the P1S only. */
    var remainingOn = labelled && REMAINING[Pr.id];
    var lastPj = res.objects.map(function (ob) {
      for (var q = printing.length - 1; q >= 0; q--) { var Lq = ob.layers[printing[q]]; if (Lq && Lq.paths && Lq.paths.length) return q; }
      return -1;
    });
    var remainingAt = function (pj0) { var r = []; lastPj.forEach(function (q, oi) { if (q >= pj0) r.push(oi); }); return r; };
    var remaining = null;
    var putRemaining = function (list) {
      put('; remaining object ids: ' + list.map(function (oi) { return ids[oi]; }).join(','));
      put('M639 ' + objectMask(list));
      remaining = list;
    };
    if (remainingOn) putRemaining(remainingAt(0));          /* the start block ends at '; MACHINE_START_GCODE_END'; the filament's start follows */
    thaw(withFilamentStart(Pr.afterStart, opts.filamentStart), vals, flags).forEach(function (l) { put(l); });
    if (TW) {
      /* with a tower Studio first goes to the first layer's height plus a lift (the pyramid: G1 Z.6), and lifts from there at the layer change */
      accel(S.accel.travel);
      st.z = res.planes[printing[0]].printZ + R.hop;
      put('G1 Z' + fx(st.z) + ' F' + fmt(S.speed.travel * 60, 0));
    }
    var bodyFrom = W.lines.length;

    var layers = [];
    var startPos = null;
    var layerNo = 0;
    var totalLayers = printing.length;

    function openObject(oi) {
      if (st.objId !== oi) { put('; OBJECT_ID: ' + ids[oi]); st.objId = oi; }
      if (labelled) {
        put('; start printing object, unique label id: ' + ids[oi]);
        put('M624 ' + objectMask([oi]));
        st.openObj = oi;
      }
    }
    function closeObject() {
      if (labelled && st.openObj >= 0) {
        put('; stop printing object, unique label id: ' + ids[st.openObj]);
        put('M625');
        st.openObj = -1;
      }
    }
    /** COOL WAIT: retracted, up COOL_WAIT_LIFT, aside COOL_WAIT_AWAY off the layer's outline in X (to the right, else the left), and a wait of
     *  the rest of the layer's minimum time with the layer's fan still on. The next layer's own travel brings the nozzle back down. */
    function coolWaitOff(w, over) {
      if (!st.retracted && R.length > 0) { put('G1 E-' + fe(R.length) + ' F' + fmt(R.speed * 60, 0)); st.retracted = true; st.retractLen = R.length; }
      /* over the pillar's first point when the layer starts on it (the ooze goes into the pillar), else off the layer's outline */
      var ax = over ? over[0] : w.box.x1 + COOL_WAIT_AWAY <= bed.x - 2 ? w.box.x1 + COOL_WAIT_AWAY : Math.max(2, w.box.x0 - COOL_WAIT_AWAY);
      var ay = over ? over[1] : Math.max(2, Math.min(bed.y - 2, (w.box.y0 + w.box.y1) / 2));
      var zl = st.z + COOL_WAIT_LIFT;
      put('; NSO cool wait: ' + w.seconds.toFixed(1) + ' s' + (over ? ' over the cool pillar' : ''));
      accel(S.accel.travel);
      put('G1 Z' + fx(zl) + ' F' + fmt(S.speed.travel * 60, 0));
      put('G1 X' + gx(ax) + ' Y' + gy(ay) + ' F' + fmt(S.speed.travel * 60, 0));
      put('G4 P' + Math.round(w.seconds * 1000));
      st.x = ax; st.y = ay; st.z = zl;
      waitStat.layers++; waitStat.total += w.seconds;
    }
    /** PAUSE AT: retracted, 5 mm up, to the park, M400 U1 (the template's machine_pause_gcode). */
    function pauseHere(zLayer) {
      if (!st.retracted && R.length > 0) { put('G1 E-' + fe(R.length) + ' F' + fmt(R.speed * 60, 0)); st.retracted = true; st.retractLen = R.length; }
      var zl = Math.min(bed.z, st.z + 5);
      put('; PAUSE_PRINT');
      put('; NSO pause before the layer at ' + fc(zLayer, 4) + ' mm');
      accel(S.accel.travel);
      put('G1 Z' + fx(zl) + ' F' + fmt(S.speed.travel * 60, 0));
      if (PARK[Pr.id]) PARK[Pr.id].go.forEach(function (l) { put(l.replace(/\{CY\}/g, tnum(vals.cy))); });
      else put('G1 X' + fx(10) + ' Y' + fx(bed.y - 10) + ' F' + fmt(S.speed.travel * 60, 0));
      put((raw(opts.config, 'machine_pause_gcode') || 'M400 U1').replace(/\\n/g, '\n'));
      st.z = zl; st.x = null; st.y = null;
      pauseStat.push(+zLayer.toFixed(2));
    }
    function spiral(zUp, first) {
      put('G17');
      put('G3 Z' + fx(zUp) + ' I' + fx(SPIRAL_R) + ' J0 P1  F' + fmt(travelV(first) * 60, 0));
    }
    /** The wipe and retraction that end the path pending in `st` (Studio writes
     *  them after the next marker, so a layer's last wipe follows CHANGE_LAYER). */
    function flushRetract() {
      var pd = st.pending;
      if (!pd) return;
      st.pending = null;
      if (!pd.it.retractAfter || R.length <= 0) return;
      if (R.wipe && R.wipeDistance > 0 && pd.lastPts.length > 1) {
        /* retract_before_wipe: that share standing still at the path's end, so the nozzle leaves with the pressure already off it (the owner's TPU
           string test: retracting along the wipe drags a nozzle still pushing through the soft wall it has just laid). The rest during the wipe;
           with all of it before, the wipe is a bare move. */
        var before = +fe(R.length * R.beforeWipe), rest = +(R.length - before).toFixed(5);
        if (before > 0) put('G1 E-' + fe(before) + ' F' + fmt(R.speed * 60, 0));
        put('; WIPE_START');
        put('G1 F' + fmt(pd.it.vWipe * 60, 3));
        st.lastF = pd.it.vWipe * 60;
        accel(S.accel.def);
        var wp = pd.it.loop ? wipeForward(pd.lastPts[pd.lastPts.length - 1], pd.it.loop, R.wipeDistance) : wipePath(pd.lastPts, R.wipeDistance, pd.it.feature === 'Top surface');
        var wl = pathLength(wp);
        var spent = 0;
        for (var q = 1; q < wp.length; q++) {
          // what the file says, so the cycle sums to the retraction to the last digit
          var share = +fe(rest * RETRACT_DURING_WIPE * dist(wp[q - 1], wp[q]) / wl);
          put('G1 X' + gx(wp[q][0]) + ' Y' + gy(wp[q][1]) + (share > 0 ? ' E-' + fe(share) : ''));
          spent += share;
        }
        put('; WIPE_END');
        var tail = +(rest - spent).toFixed(5);
        if (tail > 0) put('G1 E-' + fe(tail) + ' F' + fmt(R.speed * 60, 0));
      } else {
        put('G1 E-' + fe(R.length) + ' F' + fmt(R.speed * 60, 0));
      }
      st.retracted = true;
      st.retractLen = R.length;
    }
    function deretract() {
      if (!st.retracted) return;
      /* after a filament change the filament is out by the change's own length (retract_length_toolchange), and goes back by that */
      put('G1 E' + fe((st.retractLen != null ? st.retractLen : R.length) + R.restartExtra) + ' F' + fmt(R.deretractSpeed * 60, 0));
      st.retracted = false;
      st.retractLen = null;
    }
    /**
     * A FILAMENT CHANGE, as Studio's set_extruder writes it with no prime tower (GCode.cpp): the retraction topped up to the change's length,
     * the old filament's end G-code, the template's change block (MC.block: the purge from its table, the cut, the new slot loaded), the fans
     * and the nozzle temperature put back, and the new filament's start G-code. Ends lifted 3 mm, retracted by the new filament's change length.
     */
    function changeFilament(to, z, first) {
      var from = st.slot;
      if (!st.retracted) { put('G1 E-' + fe(R.length) + ' F' + fmt(R.speed * 60, 0)); st.retracted = true; st.retractLen = R.length; }
      var have = st.retractLen != null ? st.retractLen : R.length, more = MC.toolchangeLength(from) - have, fIn = null;
      if (more > 1e-9) { put('G1 E-' + fe(more) + ' F' + fmt(R.speed * 60, 0)); fIn = R.speed * 60; }
      MC.endLines(from).forEach(put);
      var blk = MC.block(from, to, z, first, fIn);
      blk.lines.forEach(put);
      if (blk.accel != null) st.A = fmt(blk.accel, 0);
      if (blk.z != null) st.z = blk.z;
      st.bySlot[to] = (st.bySlot[to] || 0) + blk.extruded;
      st.extruded += blk.extruded;
      /* Studio's _FORCE_RESUME_FAN_SPEED: the block turned the fans off; the layer's come back */
      put(fanLine(st.fan == null ? 0 : st.fan));
      if (S.fan.aux) put('M106 P2 S' + fc(st.aux == null ? 0 : st.aux, 2));
      var T = MC.temp(to, first);
      put('M104 S' + fmt(T, 0) + ' ; set nozzle temperature');
      st.nozzleT = T;
      MC.startLines(to).forEach(put);
      st.retracted = true;
      st.retractLen = MC.toolchangeLength(to);
      st.slot = to;
      st.feature = null; st.lw = null;
      return true;
    }
    /**
     * The wipe of the path just printed before a filament change (Studio's retract(toolchange): the wipe pulls the change's own length, at
     * the tower's speed), then the lift. Leaves the nozzle lifted and retracted by `len`.
     */
    function changeWipe(len, z) {
      var pd = st.pending;
      st.pending = null;
      if (pd && R.wipe && R.wipeDistance > 0 && pd.lastPts.length > 1) {
        var wF = TW.maxSpeed;
        put('; WIPE_START');
        put('G1 F' + fmt(wF, 3));
        st.lastF = wF;
        accel(S.accel.def);
        var wp = pd.it.loop ? wipeForward(pd.lastPts[pd.lastPts.length - 1], pd.it.loop, R.wipeDistance) : wipePath(pd.lastPts, R.wipeDistance, pd.it.feature === 'Top surface');
        var wl = pathLength(wp), spent = 0;
        for (var q = 1; q < wp.length; q++) {
          var share = +fe(len * RETRACT_DURING_WIPE * dist(wp[q - 1], wp[q]) / wl);
          put('G1 X' + gx(wp[q][0]) + ' Y' + gy(wp[q][1]) + (share > 0 ? ' E-' + fe(share) : ''));
          spent += share;
        }
        put('; WIPE_END');
        var tail = +(len - spent).toFixed(5);
        if (tail > 0) put('G1 E-' + fe(tail) + ' F' + fmt(R.speed * 60, 0));
      } else {
        put('G1 E-' + fe(len) + ' F' + fmt(R.speed * 60, 0));
      }
      st.retracted = true; st.retractLen = len;
      spiral(z + R.hop, false);
    }
    /**
     * ONE VISIT TO THE TOWER (primeTower), as Studio's append_tcr writes it: on a layer with no change, the wall (and grid) at the start of
     * the layer; else one visit a change (k), where the layer's filaments change - the wall in the old filament before the change, the
     * change and the new filament's purge across the tower, or the wall after it (TW.wallAt). Then the wipe along the last line, the
     * retraction and the slow lift. `entry`: 'start' (after the layer change's hook: lifted, retracted) or 'mid' (from the path just
     * printed, its wipe not yet written). Leaves the nozzle lifted and retracted.
     */
    function towerVisit(pj, k, z, first, entry) {
      var L = TW.layers[pj], ch = k >= 0 ? L.changes[k] : null, pp = TW.post(), wa = TW.wallAt(pj);
      var finishBefore = !ch || (wa && wa.k === k && wa.before), finishAfter = !!(ch && wa && wa.k === k && !wa.before);
      var travelAcc = first ? S.accel.firstTravel : S.accel.travel;
      var fin = null, pur = null, lastPart = null, putE = function (e, slot) { st.bySlot[slot] = (st.bySlot[slot] || 0) + e; st.extruded += e; };
      /* the tower's lines go through Studio's cooling buffer too: an F the line before left in force is dropped */
      var fIn0 = null, towerPut = function (lines, f) { var d = dropRepeatedF(lines, f); d.lines.forEach(put); return d.f; };
      var onTower = false;
      if (finishBefore) {
        fin = TW.finish(pj, !ch && !L.changes.length, st.slot);
        var bf = ch ? TW.blockFill(pj, st.slot) : null;              /* the rest of a band the layer's purges leave, before the wall */
        var sp = TW.plate((bf || fin).start);
        /* the way in: down onto the tower and the filament back (Studio's is_finish_first travel) */
        if (entry === 'mid') {
          flushRetract();
          closeObject();
          accel(travelA(first));
          spiral(z + R.hop, first);
          put('G1 X' + gx(sp[0]) + ' Y' + gy(sp[1]) + ' Z' + fx(z + R.hop));
        } else if (first) { put('G1 X' + gx(sp[0]) + ' Y' + gy(sp[1])); put('M204 S' + fmt(travelAcc, 0)); }
        else { put('M204 S' + fmt(travelAcc, 0)); put('G1 X' + gx(sp[0]) + ' Y' + gy(sp[1])); }
        st.A = fmt(travelAcc, 0);
        put('G1 Z' + fx(z));
        deretract();
        TW.reset(pp, (bf || fin).start);
        if (bf) { fIn0 = towerPut(TW.rewrite(bf.lines, pp), R.deretractSpeed * 60); putE(bf.e, st.slot); }
        fIn0 = towerPut(TW.rewrite((bf ? [TW.mergeTravel(fin.start)] : []).concat(fin.lines), pp), bf ? fIn0 : R.deretractSpeed * 60);
        putE(fin.e, st.slot);
        lastPart = fin;
        onTower = true;
      }
      if (ch) {
        var from = ch.from, to = ch.to, types = MC.types || [];
        if (entry === 'mid' && !onTower) closeObject();
        TW.changeHead(pj, types[from] || 'PLA', types[to] || 'PLA').forEach(put);
        /* [filament_end_gcode]: the retraction to the change's length (from the path just printed: wiped; on the tower: lifted after), the
           old filament's end G-code */
        var tcFrom = MC.toolchangeLength(from), fIn = R.speed * 60;
        if (entry === 'mid' && !onTower) { changeWipe(tcFrom, z); fIn = travelV(false) * 60; }
        else {
          if (!st.retracted) put('G1 E-' + fe(tcFrom) + ' F' + fmt(R.speed * 60, 0));
          else if (tcFrom - (st.retractLen != null ? st.retractLen : R.length) > 1e-9) put('G1 E-' + fe(tcFrom - (st.retractLen != null ? st.retractLen : R.length)) + ' F' + fmt(R.speed * 60, 0));
          if (onTower) { spiral(z + R.hop, false); fIn = travelV(false) * 60; }
        }
        st.retracted = true;
        MC.endLines(from).forEach(put);
        put('');
        /* [change_filament_gcode] */
        put('; FilamentChangeGCodeStart');
        var blk = MC.block(from, to, z, first, fIn);
        blk.lines.forEach(put);
        put('; FilamentChangeGCodeEnd');
        if (blk.accel != null) st.A = fmt(blk.accel, 0);
        putE(blk.extruded, to);
        put(fanLine(st.fan == null ? 0 : st.fan));
        if (S.fan.aux) put('M106 P2 S' + fc(st.aux == null ? 0 : st.aux, 2));
        /* the way to the purge's start, round the tower (generate_path_to_wipe_tower), from where the block left the nozzle */
        var lx = null, ly = null;
        blk.lines.forEach(function (l) {
          var m = /^G[01]\b([^;]*)/.exec(l);
          if (!m) return;
          var mx = /X(-?[\d.]+)/.exec(m[1]), my = /Y(-?[\d.]+)/.exec(m[1]);
          if (mx) lx = +mx[1]; if (my) ly = +my[1];
        });
        var startT = TW.purgeStart(pj, k), startP = TW.plate(startT);
        var path = TW.approach([(lx == null ? 0 : lx) + OFF.x, (ly == null ? 0 : ly) + OFF.y], startP);
        var hop = R.hop, lifted = false, at = null, slope = TW.slopeLen(hop);
        var go = function (p) {
          if (lifted || !(hop > 0)) { put('G1 X' + gx(p[0]) + ' Y' + gy(p[1])); at = p; return; }
          var d = Math.hypot(p[0] - at[0], p[1] - at[1]);
          if (d > slope) {
            var q = [at[0] + (p[0] - at[0]) * slope / d, at[1] + (p[1] - at[1]) * slope / d];
            put('G1 X' + gx(q[0]) + ' Y' + gy(q[1]) + ' Z' + fx(z + hop));
          }
          put('G1 X' + gx(p[0]) + ' Y' + gy(p[1]) + ' Z' + fx(z + hop));
          lifted = true; at = p;
        };
        if (path.length > 1) {
          put('G1 X' + gx(path[0][0]) + ' Y' + gy(path[0][1]) + ' F' + fmt(S.speed.travel * 60, 0));
          if (!onTower && entry === 'start') { put('M204 S' + fmt(travelAcc, 0)); st.A = fmt(travelAcc, 0); }
          put('G1 Z' + fx(z));
          at = path[0];
          for (var pi2 = 1; pi2 < path.length - 1; pi2++) go(path[pi2]);
        }
        put('');
        /* [filament_start_gcode]: the new filament's start G-code, the last stretch, down and the filament back */
        st.nozzleT = MC.temp(to, first);
        MC.startLines(to).forEach(put);
        if (path.length > 1) go(path[path.length - 1]);
        else put('G1 X' + gx(startP[0]) + ' Y' + gy(startP[1]) + ' F' + fmt(S.speed.travel * 60, 0));
        put('G1 Z' + fx(z));
        put('G1 E' + fe(MC.toolchangeLength(to)) + ' F' + fmt(R.deretractSpeed * 60, 0));
        st.retracted = false; st.retractLen = null;
        put('');
        put('G4 S0');
        st.slot = to;
        pur = TW.purge(pj, k);
        TW.reset(pp, pur.start);
        fIn0 = towerPut(TW.rewrite(pur.lines, pp), R.deretractSpeed * 60);
        putE(pur.e, to);
        lastPart = pur;
        if (finishAfter) {
          var bf2 = TW.blockFill(pj, to);
          if (bf2) { fIn0 = towerPut(TW.rewrite([TW.mergeTravel(bf2.start)].concat(bf2.lines), pp), fIn0); putE(bf2.e, to); }
          fin = TW.finish(pj, false, to);
          towerPut(TW.rewrite([TW.mergeTravel(fin.start)].concat(fin.lines), pp), fIn0);
          putE(fin.e, to);
          lastPart = fin;
        }
      }
      put('');
      /* out: the wipe along what was drawn last, the rest of the retraction, the slow lift (Studio's retract after append_tcr) */
      var endP = TW.plate(lastPart.end), wp = wipeForward(endP, lastPart.wipe.slice(1).map(TW.plate), R.wipeDistance);
      var wsPct = parseFloat((Array.isArray(opts.config.wipe_speed) ? opts.config.wipe_speed[0] : opts.config.wipe_speed) || 80) / 100;
      var wipeF = st.lastF != null ? st.lastF : S.speed.travel * 60 * wsPct;
      var wl = pathLength(wp), spent = 0;
      put('; WIPE_START');
      put('G1 F' + fmt(wipeF, 3));
      st.lastF = wipeF;
      if (first) { put('M204 S' + fmt(S.accel.first, 0)); }
      for (var q = 1; q < wp.length; q++) {
        var share = +fe(R.length * RETRACT_DURING_WIPE * dist(wp[q - 1], wp[q]) / wl);
        put('G1 X' + gx(wp[q][0]) + ' Y' + gy(wp[q][1]) + (share > 0 ? ' E-' + fe(share) : ''));
        spent += share;
      }
      put('; WIPE_END');
      var tail = +(R.length - spent).toFixed(5);
      if (tail > 0) put('G1 E-' + fe(tail) + ' F' + fmt(R.speed * 60, 0));
      st.retracted = true; st.retractLen = R.length;
      if (first) put('M204 S' + fmt(travelAcc, 0));
      put('G17');
      put('G3 Z' + fx(z + R.hop) + ' I' + fx(SPIRAL_R) + ' J0 P1  F' + fmt(TW.liftF, 0));
      st.z = z + R.hop;
      st.x = wp[wp.length - 1][0]; st.y = wp[wp.length - 1][1];
      st.A = null;                                   /* Studio forgets the acceleration after the tower: the next travel writes it */
      st.feature = null; st.lw = null;
      st.objId = -1;
    }
    function emitHook(li, z) {
      var h = hookLines(Pr, layerNo, z, vals.cy, flags);
      if (!h.length) return;
      if (labelled && Pr.hooks.wrap) {
        put('; object ids of layer ' + layerNo + ' start: ' + idList);
        put('M624 ' + allMask);
      }
      h.forEach(function (l) { put(l); });
      if (labelled && Pr.hooks.wrap) {
        put('; object ids of this layer' + layerNo + ' end: ' + idList);
        put('M625');
      }
    }
    /** Where in the layer the hook goes: after the first run of walls (before the first
     *  infill), else after the first object; -1 = before the layer's first path. */
    function hookAfter(items) {
      var n = items.length;
      for (var k = 0; k + 1 < n; k++) {
        if (WALL[items[k].feature] && !WALL[items[k + 1].feature]) return k;
      }
      for (var j = 0; j + 1 < n; j++) if (items[j + 1].obj !== items[0].obj) return j;
      return n > 1 ? 0 : -1;
    }

    for (var pj = 0; pj < printing.length; pj++) {
      var li = printing[pj];
      var pl = res.planes[li];
      var first = pj === 0;
      var lastLayer = pj === printing.length - 1;
      layerNo = pj + 1;
      var items = layerItems(res, li, S);
      if (MC) {
        /* a layer's filaments: the one loaded first, then the others in slot order (Studio's tool ordering keeps the last of a layer for the
           start of the next); a path before a change ends wiped and retracted */
        var order = colourPlan[pj] || [];
        items = items.map(function (it, i) { return { it: it, i: i }; }).sort(function (a, b) {
          return order.indexOf(a.it.slot) - order.indexOf(b.it.slot) || a.i - b.i;
        }).map(function (x) { return x.it; });
      }
      if (pillarObj >= 0 && !MC) items = items.filter(function (it) { return it.obj === pillarObj; }).concat(items.filter(function (it) { return it.obj !== pillarObj; }));
      var endPos = planTravels(items, S, startPos, first ? true : R.onLayerChange);
      items[items.length - 1].retractAfter = lastLayer ? true : R.onLayerChange;
      var hookAt = hookAtStart ? -2 : hookAfter(items);      /* -2: the timelapse goes at the layer change (HOOK_AT_LAYER_START) */
      if (hookAt >= 0) items[hookAt].retractAfter = true;
      if (MC) for (var kc = 1; kc < items.length; kc++) if (items[kc].slot !== items[kc - 1].slot) items[kc - 1].retractAfter = true;
      /* the layer's filament changes, timed (their moves, as the cooling counts the layer's) */
      var changeSec = 0;
      if (TW && pj <= TW.last) {
        /* the tower's part of the layer, timed with it (Studio's cooling counts the tower's moves in the layer's time) */
        var Lt = TW.layers[pj], tl = [];
        tl = tl.concat(TW.finish(pj, !Lt.changes.length, st.slot).lines);
        Lt.changes.forEach(function (c0, kk) { tl = tl.concat(TW.purge(pj, kk, true).lines); });
        changeSec += estimateLines(tl, { jerk: S.jerk, accel: S.accel.def }).seconds;
      }
      if (MC) {
        var cs = st.slot, nth = MC.count;
        items.forEach(function (it) {
          if (it.slot === cs) return;
          nth++;
          changeSec += estimateLines(MC.blockAt(cs, it.slot, pl.printZ, first, null, nth).lines, { jerk: S.jerk, accel: S.accel.def }).seconds;
          cs = it.slot;
        });
      }
      var cool = coolLayer(items, S, first, changeSec);
      var fan = fanFor(S, pj, cool.seconds);
      // reduce_fan_stop_start_freq: a layer keeps the fan it has unless the new one is 2 % or more away
      if (st.layerFan != null && pj >= S.fan.closeFirst + 1 && S.cooling.reduce_fan_stop_start_freq && Math.abs(fan - st.layerFan) < 2.55 * 2) fan = st.layerFan;
      st.layerFan = fan;
      var aux = auxFanFor(S, pj);
      if (cool.cap != null) {
        items.forEach(function (it) {
          if (it.keep) return;
          if (cool.mode === 'quality_first') it.v = Math.max(Math.min(S.cooling.slow_down_min_speed, it.v), it.v * cool.cap);
          else it.v = Math.min(it.v, Math.max(cool.cap, Math.min(S.cooling.slow_down_min_speed, it.v)));
        });
      }
      /* COOL WAIT: what this layer still lacks of opts.coolWait at the speeds it now prints at, waited out off the part before the next one */
      if (coolWait && !first && !lastLayer) {
        var lackS = coolWait - (layerSecondsOf(items, S, cool.mode, null) + changeSec);
        if (lackS >= COOL_WAIT_MIN) {
          var wb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
          items.forEach(function (it) { it.pts.forEach(function (q) { if (q[0] < wb.x0) wb.x0 = q[0]; if (q[0] > wb.x1) wb.x1 = q[0]; if (q[1] < wb.y0) wb.y0 = q[1]; if (q[1] > wb.y1) wb.y1 = q[1]; }); });
          st.coolWait = { seconds: lackS, box: wb };
        }
      }
      var rec = { index: li, number: layerNo, z: pl.printZ, h: pl.h, seconds: cool.seconds, slowdownCap: cool.cap, fan: fan,
                  features: [], items: items.length, lineFrom: W.lines.length };
      layers.push(rec);
      var z = pl.printZ;

      // ----- the layer change
      put('; CHANGE_LAYER');
      put('; Z_HEIGHT: ' + fc(z, 4));
      put('; LAYER_HEIGHT: ' + fc(pl.h, 4));
      st.lh = pl.h;
      if (first) {
        put('G1 E-' + fe(R.length) + ' F' + fmt(R.speed * 60, 0));
        st.retracted = true;
      } else {
        flushRetract();
        closeObject();
        if (st.coolWait) { coolWaitOff(st.coolWait, items[0] && items[0].obj === pillarObj ? items[0].pts[0] : null); st.coolWait = null; }
        if (pauseK < pauseAt.length && z >= pauseAt[pauseK] - 1e-6) {
          while (pauseK < pauseAt.length && z >= pauseAt[pauseK] - 1e-6) pauseK++;
          pauseHere(z);
        }
        if (remainingOn) { var nowR = remainingAt(pj); if (nowR.length < remaining.length) putRemaining(nowR); }
      }
      put('; layer num/total_layer_count: ' + layerNo + '/' + totalLayers);
      put('; update layer progress');
      put('M73 L' + layerNo);
      put('M991 S0 P' + (layerNo - 1) + ' ;notify layer change');
      if (pj === 1) {
        if (!steps && S.temp.nozzle !== S.temp.nozzleInitial) put('M104 S' + fmt(S.temp.nozzle, 0));
        if (!steps) st.nozzleT = S.temp.nozzle;
        if (S.temp.bed !== S.temp.bedInitial) put('M140 S' + fmt(S.temp.bed, 0));
      }
      /* (a nozzle still at the bridge temperature of the layer before is brought back at the park, not here) */
      if (steps && pj >= 1 && !st.bridgeCold) {
        var wantT = layerTemp(pl);
        if (wantT !== st.nozzleT) { put('M104 S' + fmt(wantT, 0) + ' ; NSO temperature step'); st.nozzleT = wantT; }
      }
      // ----- the bridge temperature: this layer's own, cold through a whole stretch of bridge layers (coldLayer)
      var layerT = pj === 0 ? S.temp.nozzleInitial : layerTemp(pl);
      /** The temperature the layer prints at, when the nozzle has to go to the park for it: asked before the layer's first path only. */
      var parkFor = function (k) {
        if (bridgeT == null || k !== 0) return null;
        var want = coldLayer[pj] ? bridgeT : layerT;
        return want !== st.nozzleT && (want === bridgeT || st.bridgeCold) ? want : null;
      };
      /** Retracted, lifted, to the park; wait for `temp`; prime and wipe. Ends retracted, lifted, at the park's last move. */
      var parkAt = function (temp) {
        if (!st.retracted && R.length > 0) { put('G1 E-' + fe(R.length) + ' F' + fmt(R.speed * 60, 0)); st.retracted = true; }
        var subP = function (l) { return l.replace(/\{CY\}/g, tnum(vals.cy)); };
        put('; NSO bridge temperature: ' + fmt(temp, 0) + (temp === bridgeT ? ' for the bridges' : ' after the bridges'));
        accel(S.accel.travel);
        put('G1 Z' + fx(z + Math.max(R.hop, BRIDGE_TEMP_LIFT)));
        PARK[Pr.id].go.forEach(function (l) { put(subP(l)); });
        put('M109 S' + fmt(temp, 0));
        var prime = (st.retracted ? R.length : 0) + BRIDGE_TEMP_PRIME;
        put('G1 E' + fe(prime) + ' F' + gnum(F.flushVolumetric / 2.4053 * 60));
        st.extruded += BRIDGE_TEMP_PRIME;
        if (R.length > 0) { put('G1 E-' + fe(R.length) + ' F' + fmt(R.speed * 60, 0)); st.retracted = true; } else st.retracted = false;
        PARK[Pr.id].wipe.forEach(function (l) { put(subP(l)); });
        st.nozzleT = temp; st.bridgeCold = temp === bridgeT;
        bridgeStat.changes++;
      };
      rec.nozzle = pj === 0 ? S.temp.nozzleInitial : layerTemp(pl);
      if (fan !== st.fan) { put(fanLine(fan)); st.fan = fan; }
      if (S.fan.aux && aux !== st.aux) { put('M106 P2 S' + fc(aux, 2)); st.aux = aux; }
      if (pj === 1) { put('; open powerlost recovery'); put('M1003 S1'); }
      st.objId = -1;
      var layerFan = fan;
      var featuresSeen = {};
      if (hookAt === -1) emitHook(li, z);

      items.forEach(function (it, k) {
        var t = it.travel, glided = false;
        var pt = it.pts[0];
        var tFirst = first;
        var prev = k ? items[k - 1] : null;
        var parkT = parkFor(k);
        // ----- the boundary and the travel to this path
        if (k === 0 && hookAtStart) {
          /* STUDIO'S CORE-XY LAYER CHANGE (the P1S): lift - on the first layer straight up from the bed, after it the spiral - then the
             timelapse, then a filament change if the layer starts on another, then the object, the travel (its F dropped when the lift's is
             in force, as Studio's cooling buffer drops it) and down to the layer */
          if (parkT != null) parkAt(parkT);
          var liftF = travelV(first) * 60;
          accel(first ? S.accel.firstTravel : S.accel.travel);
          var lifted = R.hop > 0 && (first || R.onLayerChange);
          if (lifted) { if (first) put('G1 Z' + fx(st.z + R.hop) + ' F' + fmt(liftF, 0)); else spiral(st.z + R.hop, false); }
          emitHook(li, z);
          var towerNow = TW && pj <= TW.last && (!TW.layers[pj].changes.length || it.slot !== st.slot);
          if (towerNow) {
            /* the tower first - on a layer with no change, or one that starts on another filament - then the object, from the tower's slow
               lift; a layer that starts on the loaded filament goes to the tower at its first change */
            towerVisit(pj, TW.layers[pj].changes.length ? 0 : -1, z, first, 'start');
            st.towerK = TW.layers[pj].changes.length ? 1 : 0;
            openObject(it.obj);
            accel(travelA(first));
            put('G1 X' + gx(pt[0]) + ' Y' + gy(pt[1]) + ' F' + fmt(liftF, 0));
          } else {
            st.towerK = 0;
            var changed = MC && it.slot !== st.slot ? changeFilament(it.slot, z, first) : false;
            openObject(it.obj);
            put('G1 X' + gx(pt[0]) + ' Y' + gy(pt[1]) + (lifted && !changed ? '' : ' F' + fmt(liftF, 0)));
          }
          put('G1 Z' + fx(z));
          deretract();
        } else if (k === 0) {
          if (parkT != null) parkAt(parkT);
          var changed0 = MC && it.slot !== st.slot ? changeFilament(it.slot, z, first) : false;
          openObject(it.obj);
          if (first) {
            accel(S.accel.firstTravel);
            put('G1 X' + gx(pt[0]) + ' Y' + gy(pt[1]) + ' F' + fmt(S.speed.firstTravel * 60, 0));
            if (R.hop > 0) put('G1 Z' + fx(z + R.hop));
            put('G1 Z' + fx(z));
          } else {
            accel(S.accel.travel);
            if (changed0) {
              put('G1 X' + gx(pt[0]) + ' Y' + gy(pt[1]) + ' F' + fmt(S.speed.travel * 60, 0));
              put('G1 Z' + fx(z));
            } else if (R.hop > 0 && R.onLayerChange) {
              var zUp = st.z + R.hop;
              spiral(zUp, false);
              put('G1 X' + gx(pt[0]) + ' Y' + gy(pt[1]) + ' Z' + fx(zUp) + ' F' + fmt(S.speed.travel * 60, 0));
              put('G1 Z' + fx(z));
            } else {
              put('G1 X' + gx(pt[0]) + ' Y' + gy(pt[1]) + ' Z' + fx(z) + ' F' + fmt(S.speed.travel * 60, 0));
            }
          }
          deretract();
        } else if (MC && it.slot !== st.slot && TW && pj <= TW.last) {
          /* a change between two paths of a layer, at the tower: from the path just printed to the tower and back to the next path */
          towerVisit(pj, st.towerK, z, first, 'mid');
          st.towerK++;
          openObject(it.obj);
          accel(travelA(first));
          put('G1 X' + gx(pt[0]) + ' Y' + gy(pt[1]) + ' F' + fmt(travelV(first) * 60, 0));
          put('G1 Z' + fx(z));
          deretract();
        } else if (MC && it.slot !== st.slot) {
          /* a change between two paths of a layer (two objects of different filaments): closed out, changed, and back down to the layer */
          if (parkT != null) prev.retractAfter = true;
          flushRetract();
          closeObject();
          if (parkT != null) parkAt(parkT);
          changeFilament(it.slot, z, first);
          openObject(it.obj);
          accel(travelA(first));
          put('G1 X' + gx(pt[0]) + ' Y' + gy(pt[1]) + ' F' + fmt(travelV(first) * 60, 0));
          put('G1 Z' + fx(z));
          deretract();
        } else {
          if (parkT != null) prev.retractAfter = true;          // the path before a park ends as a travel's does: wiped and retracted
          flushRetract();
          var atHop = false;
          if (k - 1 === hookAt) {
            // the hook: lift in a circle, close the object, the photo, open the object again
            /* the head leaves for the photo whatever the lift: the way back is a travel with its own F and Z, never a glide (with no z hop - CR-TPU
               since 2026-11-25 - a top run's glide after the hook went at the hook's F18000) */
            if (R.hop > 0) spiral(z + R.hop, first);
            atHop = true;
            closeObject();
            emitHook(li, z);
            openObject(it.obj);
          } else if (it.obj !== prev.obj) {
            closeObject();
            openObject(it.obj);
          }
          /* the park is no object's: a skipped object must not take the temperature change with it */
          if (parkT != null) { closeObject(); parkAt(parkT); openObject(it.obj); atHop = true; }
          if (t.retract || atHop) {
            accel(travelA(first));
            if (atHop) put('G1 X' + gx(pt[0]) + ' Y' + gy(pt[1]) + ' F' + fmt(travelV(first) * 60, 0));
            else if (t.hop) put('G1 X' + gx(pt[0]) + ' Y' + gy(pt[1]) + ' Z' + fx(z + R.hop) + ' F' + fmt(travelV(first) * 60, 0));
            else put('G1 X' + gx(pt[0]) + ' Y' + gy(pt[1]) + ' F' + fmt(travelV(first) * 60, 0));
            if (atHop || t.hop) put('G1 Z' + fx(z));
            deretract();
          } else if (it.glide && !atHop) {
            /* a monotonic line's step to its next line (the slicer's path.glide): Studio's ExtrusionMultiPath writes it as a bare move at the line's
               own speed and acceleration - "G1 X Y", no F, no M204 - so the nozzle steps across and goes on */
            put('G1 X' + gx(pt[0]) + ' Y' + gy(pt[1]));
            glided = true;
          } else {
            accel(t.d < 2 ? S.accel.short : travelA(first));
            put('G1 X' + gx(pt[0]) + ' Y' + gy(pt[1]) + ' F' + fmt(travelV(first) * 60, 0));
          }
        }
        // ----- the path
        if (it.feature !== st.feature) {
          put('; FEATURE: ' + it.feature);
          st.feature = it.feature; st.lw = null;
        }
        if (Math.abs(st.lh - it.bead.h) > 1e-9) { put('; LAYER_HEIGHT: ' + fc(it.bead.h, 6)); st.lh = it.bead.h; }
        if (st.lw !== it.bead.w) { put('; LINE_WIDTH: ' + fc(it.bead.w, 6)); st.lw = it.bead.w; }
        featuresSeen[it.feature] = 1;
        var bridgeFan = (it.feature === 'Bridge' || it.feature === 'Overhang wall') &&
          S.cooling.enable_overhang_bridge_fan && pj >= S.fan.closeFirst;
        var fanNow = bridgeFan ? Math.max(layerFan, Math.round(S.cooling.overhang_fan_speed * 255) / 100) : layerFan;
        if (fanNow !== st.fan) { put(fanLine(fanNow)); st.fan = fanNow; }
        if (!(glided && Math.abs(st.lastF - it.v * 60) < 1e-6)) put('G1 F' + fmt(it.v * 60, 3));
        st.lastF = it.v * 60;
        accel(it.a);
        var x = pt[0], y = pt[1];
        var lastPts = [it.pts[0]];
        for (var m = 1; m < it.pts.length; m++) {
          var tx = +fx(it.pts[m][0]), ty = +fx(it.pts[m][1]);
          var d = Math.hypot(tx - x, ty - y);
          if (!(d > 5e-4)) continue;
          var e = it.bead.area * d / filA * F.flow;
          put('G1 X' + gx(tx) + ' Y' + gy(ty) + ' E' + fe(e));
          st.extruded += e;
          st.bySlot[it.slot] = (st.bySlot[it.slot] || 0) + e;
          x = tx; y = ty;
          lastPts.push([tx, ty]);
        }
        st.x = x; st.y = y; st.z = z;
        st.pending = { it: it, lastPts: lastPts };
        if (bridgeFan && (k + 1 >= items.length || (items[k + 1].feature !== 'Bridge' && items[k + 1].feature !== 'Overhang wall'))) {
          put(fanLine(layerFan)); st.fan = layerFan;
        }
      });
      rec.features = Object.keys(featuresSeen);
      rec.lineTo = W.lines.length;
      startPos = endPos;
    }

    // ----- the last path: closed out the way a layer change would, then the lift
    if (printing.length > 1) { put('; close powerlost recovery'); put('M1003 S0'); }
    flushRetract();
    accel(S.accel.travel);
    if (R.hop > 0) spiral(top + R.hop, false);
    closeObject();
    if (remainingOn) putRemaining([]);
    var bodyTo = W.lines.length;
    // the time, from the lines themselves
    var est = estimateLines(W.lines.slice(bodyFrom, bodyTo), { jerk: S.jerk, accel: S.accel.def });
    var bodySeconds = est.seconds + bridgeStat.changes * BRIDGE_TEMP_SECONDS;   // each change at the park, counted, not measured
    /* THE START ROUTINE'S TIME, FOR THIS FILAMENT (the owner, 2026-11-15: Studio read NSO's TPU string test as 6 m 54 s of preparation, NSO
       had counted 5 m 40 s). Pr.timing.startSeconds is measured on the Studio slice the block was frozen from, a PLA one; the block's purges run
       at the filament's own flush speed (3.2 mm^3/s for TPU, 12 for PLA), so the same block takes longer. The difference is the block's own
       moves timed twice - with this print's values and with the frozen slice's - so the waits for temperature, which are the printer's, stay
       as measured. */
    var startS = Pr.timing.startSeconds;
    if (Pr.values) {
      var startTime = function (v) { return estimateLines(thaw(Pr.start, v, flags).filter(function (l) { return typeof l === 'string' && l.charAt(0) !== '@'; }).map(function (l) { return l.trim(); })   /* the purges are indented inside M620 */, { jerk: S.jerk, accel: S.accel.def }).seconds; };
      var refVals = Object.assign({}, vals, { nozzle: Pr.values.nozzle, nozzleT: Pr.values.nozzleT, filamentType: Pr.values.filamentType, flushV: Pr.values.flushV, flushT: Pr.values.flushT, ow: Pr.values.ow });
      startS = Math.max(0, startS + startTime(vals) - startTime(refVals));
    }
    var lineTime = function (i) { return startS + est.times[i - bodyFrom]; };
    layers.forEach(function (rec) {
      rec.clockFrom = rec.lineFrom > bodyFrom ? lineTime(rec.lineFrom - 1) : startS;
      rec.clockTo = lineTime(rec.lineTo - 1);
    });

    thaw(Pr.beforeEnd, vals, flags).forEach(function (l) { put(l); });
    thaw(Pr.end, vals, flags).forEach(function (l) { if (l.charAt(0) !== '@') put(l); });

    // ----- the file
    var totalSeconds = startS + bodySeconds + Pr.timing.endSeconds;
    var lengthMm = st.extruded + (Pr.purgeMm || 0);
    var volume = lengthMm * filA;
    var density = opts.configOver && parseFloat(opts.configOver.filament_density) > 0 ? parseFloat(opts.configOver.filament_density)
      : parseFloat((/^; filament_density = ([\d.]+)/m.exec(Pr.configBlock.join('\n')) || [0, 1.24])[1]);
    var cfgOf = function (k) { var m = new RegExp('^; ' + k + ' = (.*)$', 'm').exec(Pr.configBlock.join('\n')); return m ? m[1] : ''; };
    var heights = res.objects.map(function (ob) {
      var h = 0; ob.layers.forEach(function (Ly) { if (Ly && Ly.paths.length) h = Math.max(h, Ly.printZ); });
      return h;
    });
    var slotTotals = null;
    if (MC) {
      /* MULTI-COLOUR: each slot's length, volume and weight - what it printed, its purges, and the start block's purge for the first -
         as Studio's header lists them, one a filament of the project */
      var lst = function (k) { var v = opts.config[k]; return Array.isArray(v) ? v : v == null ? [] : String(v).split(/[;,]/); };
      slotTotals = [];
      for (var sl = 0; sl < MC.n; sl++) {
        var dia = +(lst('filament_diameter')[sl] || F.diameter), den = +(lst('filament_density')[sl] || density);
        var mm = (st.bySlot[sl] || 0) + (sl === MC.initial ? (Pr.purgeMm || 0) : 0);
        var vol = mm * Math.PI * dia * dia / 4;
        slotTotals.push({ slot: sl, mm: mm, volume: vol, grams: vol / 1000 * den, density: den, diameter: dia });
      }
      lengthMm = slotTotals.reduce(function (a, t) { return a + t.mm; }, 0);
      volume = slotTotals.reduce(function (a, t) { return a + t.volume; }, 0);
    }
    var joinT = function (key, d) { return slotTotals.map(function (t) { return t[key].toFixed(d); }).join(','); };
    var head = ['; HEADER_BLOCK_START', '; BambuStudio ' + Pr.studio,
      '; model printing time: ' + duration(bodySeconds) + '; total estimated time: ' + duration(totalSeconds),
      '; total layer number: ' + totalLayers,
      '; total filament length [mm] : ' + (slotTotals ? joinT('mm', 2) : lengthMm.toFixed(2)),
      '; total filament volume [cm^3] : ' + (slotTotals ? joinT('volume', 2) : volume.toFixed(2)),              // mm^3 under Studio's label, as Studio writes it
      '; total filament weight [g] : ' + (slotTotals ? joinT('grams', 2) : (volume / 1000 * density).toFixed(2))];
    if (labelled) {
      head.push('; model label id: ' + idList);
      head.push('; object max height: ' + heights.map(function (h) { return h.toFixed(2); }).join(','));
    }
    head.push('; filament_density: ' + (slotTotals ? slotTotals.map(function (t) { return gnum(t.density); }).join(',') : cfgOf('filament_density')));
    head.push('; filament_diameter: ' + (slotTotals ? slotTotals.map(function (t) { return gnum(t.diameter); }).join(',') : cfgOf('filament_diameter')));
    head.push('; max_z_height: ' + top.toFixed(2));
    head.push('; filament: ' + (slotTotals ? slotTotals.filter(function (t) { return t.mm > 0; }).map(function (t) { return t.slot + 1; }).join(',') : '1'));
    head.push('; support_material_on_wipe_tower: 0');
    head.push('; HEADER_BLOCK_END');

    var outLines = head.concat(['', '; CONFIG_BLOCK_START'], configLines(Pr, S, opts.configOver), ['; CONFIG_BLOCK_END', '', '; EXECUTABLE_BLOCK_START']);
    var mark = function (t) {
      t = Math.min(t, totalSeconds);
      return { p: Math.floor(100 * t / totalSeconds), r: Math.floor((totalSeconds - t) / 60) };
    };
    var m0 = mark(0);
    outLines.push('M73 P0 R' + m0.r);
    var lastP = 0, lastR = m0.r;
    var emitMark = function (t) {
      var mk = mark(t);
      var p = Math.max(lastP, mk.p), r = Math.min(lastR, mk.r);
      if (p === lastP && r === lastR) return;
      outLines.push('M73 P' + p + ' R' + r);
      lastP = p; lastR = r;
    };
    for (var i = 0; i < W.lines.length; i++) {
      var ln = W.lines[i];
      if (typeof ln !== 'string') { emitMark(ln.at); continue; }
      if (i >= bodyFrom && i < bodyTo && /^G[123] X/.test(ln)) emitMark(lineTime(i > bodyFrom ? i - 1 : i));
      outLines.push(ln);
    }
    outLines.push('M73 P100 R0');
    outLines.push('; EXECUTABLE_BLOCK_END');
    outLines.push('');

    return {
      ok: true, reason: '', gcode: outLines.join('\n'), layers: layers, settings: S,
      labels: ids.map(function (id, i) { return { id: id, name: res.objects[i].name, index: i, maxHeight: heights[i] }; }),
      labelled: labelled,
      stats: {
        layers: totalLayers, maxZ: top, filamentMm: lengthMm, bodyFilamentMm: st.extruded, volumeMm3: volume,
        grams: slotTotals ? slotTotals.reduce(function (a, t) { return a + t.grams; }, 0) : volume / 1000 * density, box: box,
        filaments: slotTotals ? slotTotals.map(function (t) { return { slot: t.slot, mm: t.mm, grams: t.grams }; }) : null,
        changes: MC ? MC.changes.slice() : null,
        /* the prime tower: where it stands (plate coordinates, its brim's edge) and on how many layers; or why there is none */
        tower: TW ? { x: TW.x, y: TW.y, width: TW.W, depth: TW.D, box: [TW.box.x0, TW.box.y0, TW.box.x1, TW.box.y1], layers: TW.last + 1, moved: TW.moved } : null,
        towerNote: towerNote,
        pauses: pauseStat.length ? pauseStat : null,
        coolWait: coolWait ? { seconds: coolWait, layers: waitStat.layers, total: +waitStat.total.toFixed(1) } : null,
        bridgeTemp: bridgeT != null ? { temp: bridgeT, changes: bridgeStat.changes, layers: bridgeStat.layers, secondsEach: BRIDGE_TEMP_SECONDS, fromLayer: +opts.bridgeTempFrom >= 2 ? +opts.bridgeTempFrom : null } : null,
        tempBands: steps ? bands : null,                       // the temperature steps as written: [{ temp, fromZ, layer }]
        seconds: { start: startS, body: bodySeconds, end: Pr.timing.endSeconds, total: totalSeconds }
      }
    };
  }

  // ===========================================================================
  // The .gcode.3mf
  // ===========================================================================

  /**
   * plan(), then the Bambu .gcode.3mf around it (nso-gcode3mf-write.js): the
   * template's project settings with NSO's cooling keys on every filament slot,
   * the objects named, the time and weight from the plan. Studio opens it as a
   * project and sends it to the printer without slicing it.
   * @returns {Promise<{bytes, plan, fields}>}
   */
  function toGcode3mf(res, opts) {
    var P = plan(res, opts);
    if (!P.ok) return Promise.reject(new Error(P.reason));
    var G3 = lazy('nso-gcode3mf-write.js', 'NSO_Gcode3mf'), W3 = lazy('nso-3mf.js', 'NSO3MF');
    if (!G3 || !W3) return Promise.reject(new Error('nso-gcode3mf-write.js and nso-3mf.js are required'));
    var cooling = opts.cooling == null ? Cooling.DEFAULT_PROFILE_ID : opts.cooling;
    var values = typeof cooling === 'object' ? cooling : Cooling.resolveValues(cooling);
    var settings = W3.overlayProjectSettings(opts.config, values);
    var first = P.layers[0];
    return G3.writeDetailed({
      gcode: P.gcode,
      config: settings,
      objects: P.labels.map(function (l) { return { identify_id: String(l.id), name: l.name }; }),
      printer: { model_id: opts.printer.modelId, nozzle: opts.printer.nozzle },
      estimate: { seconds: P.stats.seconds.total, grams: P.stats.grams, firstLayerSeconds: first.clockTo - first.clockFrom },
      wipeTower: P.stats.tower ? { bbox: P.stats.tower.box } : null,
      date: opts.date
    }).then(function (w) { return { bytes: w.bytes, plan: P, fields: w.fields }; });
  }

  function fanLine(v) { return 'M106 S' + fc(v, 2); }

  /** The auxiliary (chamber-side) fan on printers that have one: off for
   *  close_additional_fan_first_x_layers, then additional_cooling_fan_speed %. */
  function auxFanFor(S, layerIndex) {
    if (!S.fan.aux || layerIndex < S.fan.closeAux) return 0;
    return Math.floor(S.fan.auxPercent * 255 / 100);          /* Studio's set_additional_fan: (int)(255.0 * speed / 100.0), 70 % is 178 */
  }

  return {
    settingsFrom: settingsFrom,
    engineOptions: engineOptions,
    extruderOffset: extruderOffset,
    coolingValues: coolingValues,
    featureSpeed: featureSpeed,
    beadOf: beadOf,
    beadArea: beadArea,
    moveSeconds: moveSeconds,
    runSeconds: runSeconds,
    estimateLines: estimateLines,
    plan: plan,
    toGcode3mf: toGcode3mf,
    thaw: thaw,
    studioTemplate: studioTemplate,
    dropRepeatedF: dropRepeatedF,
    configValue: configValue,
    firstLayerBox: firstLayerBox,
    objectMask: objectMask,
    duration: duration,
    SPIRAL_R: SPIRAL_R,
    RETRACT_DURING_WIPE: RETRACT_DURING_WIPE
  };
});
