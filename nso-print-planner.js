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
    var S = {
      nozzleMm: num(config, 'nozzle_diameter', 0.4),
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
        length: num(config, 'retraction_length', 0.8),
        speed: num(config, 'retraction_speed', 30),
        deretractSpeed: num(config, 'deretraction_speed', num(config, 'retraction_speed', 30)),
        restartExtra: num(config, 'retract_restart_extra', 0),
        hop: num(config, 'z_hop', 0.4),
        onLayerChange: num(config, 'retract_when_changing_layer', 1) !== 0,
        wipe: num(config, 'wipe', 1) !== 0,
        wipeDistance: num(config, 'wipe_distance', 2),
        minTravel: num(config, 'retraction_minimum_travel', 1)
      },
      filament: {
        diameter: num(config, 'filament_diameter', 1.75),
        flow: num(config, 'filament_flow_ratio', 1),
        maxVolumetric: num(config, 'filament_max_volumetric_speed', 12),
        bridgeFlow: num(config, 'bridge_flow', 1)
      },
      temp: {
        bedType: bedType,
        nozzle: nozzleT,
        nozzleInitial: num(config, 'nozzle_temperature_initial_layer', nozzleT),
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
  function engineOptions(config) {
    var pct = function (key, def) { var v = num(config, key, def * 100); return v / 100; };
    var nozzle = num(config, 'nozzle_diameter', 0.4);
    var over = {
      layerMm: num(config, 'layer_height', 0.2),
      firstLayerMm: num(config, 'initial_layer_print_height', 0.2),
      outerWallWidthMm: num(config, 'outer_wall_line_width', 0.42),
      innerWallWidthMm: num(config, 'inner_wall_line_width', 0.42),
      infillWidthMm: num(config, 'sparse_infill_line_width', 0.42),
      wallLoops: num(config, 'wall_loops', 2),
      topShellLayers: num(config, 'top_shell_layers', 3),
      bottomShellLayers: num(config, 'bottom_shell_layers', 3),
      topShellThicknessMm: num(config, 'top_shell_thickness', 0),
      bottomShellThicknessMm: num(config, 'bottom_shell_thickness', 0),
      sparseDensity: pct('sparse_infill_density', 0.15),
      sparsePattern: raw(config, 'sparse_infill_pattern') === 'grid' ? 'grid' : 'zigzag',
      infillDirectionDeg: num(config, 'infill_direction', 45),
      detectThinWall: num(config, 'detect_thin_wall', 0) === 1,
      supportThresholdDeg: num(config, 'support_threshold_angle', 30),
      // the project's own brim: auto_brim (a tall thin part gets one), outer_only / outer_and_inner (every part), no_brim
      brimType: ({ auto_brim: 'auto', outer_only: 'outer', outer_and_inner: 'outer', no_brim: 'none' })[raw(config, 'brim_type')] || 'none',
      brimWidthMm: num(config, 'brim_width', 5),
      brimObjectGapMm: num(config, 'brim_object_gap', 0.1)
    };
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

  /** What a path prints at: its width and bead height (a bridge is a round
   *  bead of the nozzle's diameter, as Bambu's is), and its area. */
  function beadOf(S, feature, width, h) {
    if (feature === 'Bridge') {
      var d = S.nozzleMm * Math.sqrt(S.filament.bridgeFlow);
      return { w: d, h: d, area: beadArea(d, d) };
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

  /** The last `wipeMm` of a path walked backwards: the wipe. */
  function wipePath(pts, wipeMm) {
    var out = [pts[pts.length - 1]];
    var left = wipeMm;
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
      (L.sectionPolys || []).forEach(function (p) { rings.push(p); });
      L.paths.forEach(function (p) {
        var pts = p.closed && p.pts.length ? p.pts.concat([p.pts[0]]) : p.pts;
        if (pts.length < 2) return;
        var bead = beadOf(S, p.feature, p.width, L.h || plane.h);
        var fs = featureSpeed(S, p.feature, first);
        var vCap = S.filament.maxVolumetric > 0 ? S.filament.maxVolumetric / bead.area : Infinity;
        var v = Math.min(fs.v, vCap);
        var segs = [];
        for (var q = 1; q < pts.length; q++) {
          var sx = pts[q][0] - pts[q - 1][0], sy = pts[q][1] - pts[q - 1][1], sl = Math.hypot(sx, sy);
          if (sl > 1e-9) segs.push({ l: sl, ux: sx / sl, uy: sy / sl, v: 0, a: 0 });
        }
        items.push({
          obj: oi, feature: p.feature, thin: !!p.thinWall, pts: pts, closed: !!p.closed, segs: segs,
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
  function layerSeconds(items, S, mode, cap) {
    var t = 0;
    var minV = S.cooling.slow_down_min_speed;
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      var v = it.v;
      if (cap != null) {
        if (it.feature === 'Bridge') v = it.v;                 // a bridge keeps its speed
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
  function coolLayer(items, S, first) {
    var c = S.cooling;
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

  /**
   * A frozen block as lines of text with the plate's numbers put in
   * (tools/print-planner/freeze.js says what each token is). There is no
   * template language here: a block holds a handful of tokens, plus
   *   { hook: 'spaghetti', line }          kept unless opts.spaghetti === false
   *   { zTop: [..], zTopElse: [..], cap }  the end block's "lift the head" pair
   * and "@M73 <seconds>" lines, which come through as they are for the caller
   * to turn into M73 P/R once it knows the print's time.
   * @param {Array} lines  a frozen start / afterStart / beforeEnd / end
   * @param {object} v     { nozzle, nozzleT, bed, box:{x,y,w,h}, cy, maxZ }
   */
  function thaw(lines, v, opts) {
    opts = opts || {};
    var sub = function (s) {
      return s
        .replace(/\{N-20\}/g, tnum(v.nozzle - 20)).replace(/\{N-40\}/g, tnum(v.nozzle - 40))
        .replace(/\{N\}/g, tnum(v.nozzle)).replace(/\{T\}/g, tnum(v.nozzleT)).replace(/\{B\}/g, tnum(v.bed))
        .replace(/\{BX\}/g, tnum(v.box.x)).replace(/\{BY\}/g, tnum(v.box.y))
        .replace(/\{BW\}/g, tnum(v.box.w)).replace(/\{BH\}/g, tnum(v.box.h))
        .replace(/\{CY\}/g, tnum(v.cy))
        .replace(/\{Z\+0\.4\}/g, tnum(v.maxZ + 0.4)).replace(/\{Z\+0\.5\}/g, tnum(v.maxZ + 0.5))
        .replace(/\{Z\+100\}/g, tnum(v.maxZ + 100)).replace(/\{Z\+98\}/g, tnum(v.maxZ + 98));
    };
    var out = [];
    lines.forEach(function (l) {
      if (typeof l === 'string') out.push(sub(l));
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

  /** The CONFIG_BLOCK: Studio's own for this printer, with NSO's cooling keys put in. */
  function configLines(Pr, S) {
    var map = Cooling.resolveValues(S.coolingId);
    return Pr.configBlock.map(function (l) {
      var m = /^; ([^ =]+) = (.*)$/.exec(l);
      if (!m || !Object.prototype.hasOwnProperty.call(map, m[1])) return l;
      var slots = m[2].split(',').length;
      var v = [];
      for (var i = 0; i < slots; i++) v.push(map[m[1]]);
      return '; ' + m[1] + ' = ' + v.join(',');
    });
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
   * @returns {{ok, reason, gcode, layers, stats, settings, labels}}
   */
  function plan(res, opts) {
    opts = opts || {};
    if (!res || !res.ok) return { ok: false, reason: 'nothing to plan: ' + (res && res.reason || 'no slice') };
    res = alignGrids(res);
    if (!opts.config) return { ok: false, reason: 'the printer template\'s project settings (opts.config) are required' };
    if (!opts.printer) return { ok: false, reason: 'the printer\'s frozen start / end (opts.printer) is required' };
    var Pr = opts.printer;
    var cooling = opts.cooling == null ? Cooling.DEFAULT_PROFILE_ID : opts.cooling;
    var S = settingsFrom(opts.config, cooling);
    S.coolingId = cooling;
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
    var vals = { nozzle: S.temp.nozzleInitial, nozzleT: S.temp.nozzle, bed: S.temp.bedInitial, box: box,
                 cy: box.y + box.h / 2, maxZ: top };
    var hooks = opts.hooks || {};
    var flags = { spaghetti: hooks.spaghetti !== false, timelapse: hooks.timelapse !== false, clog: hooks.clog !== false };

    var nObj = res.objects.length;
    var labelled = nObj > 1;                       // Studio labels objects when the plate has more than one
    var ids = res.objects.map(function (o, i) { return opts.labelIds && opts.labelIds[i] != null ? opts.labelIds[i] : 1001 + i; });
    var allMask = objectMask(res.objects.map(function (o, i) { return i; }));
    var idList = ids.join(',');

    // ---- the writer: every line with the print's clock at that line
    var W = { lines: [] };
    var put = function (l) { W.lines.push(l); };
    var st = { x: null, y: null, z: 0, fan: null, layerFan: null, aux: null, A: null, feature: null, lw: null, lh: null, retracted: false,
               openObj: -1, objId: -1, pending: null, extruded: 0 };
    /** M204 only when the acceleration changes, as Studio writes it. */
    var accel = function (a) { var v = fmt(a, 0); if (st.A !== v) { put('M204 S' + v); st.A = v; } };
    var travelV = function (first) { return first ? S.speed.firstTravel : S.speed.travel; };
    var travelA = function (first) { return first ? S.accel.firstTravel : S.accel.travel; };

    thaw(Pr.start, vals, flags).forEach(function (l) {
      var m = /^@M73 (\d+)$/.exec(l);
      put(m ? { at: +m[1] } : l);
    });
    thaw(Pr.afterStart, vals, flags).forEach(function (l) { put(l); });
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
        put('; WIPE_START');
        put('G1 F' + fmt(pd.it.vWipe * 60, 3));
        accel(S.accel.def);
        var wp = wipePath(pd.lastPts, R.wipeDistance);
        var wl = pathLength(wp);
        var spent = 0;
        for (var q = 1; q < wp.length; q++) {
          // what the file says, so the cycle sums to the retraction to the last digit
          var share = +fe(R.length * RETRACT_DURING_WIPE * dist(wp[q - 1], wp[q]) / wl);
          put('G1 X' + fx(wp[q][0]) + ' Y' + fx(wp[q][1]) + ' E-' + fe(share));
          spent += share;
        }
        put('; WIPE_END');
        put('G1 E-' + fe(+(R.length - spent).toFixed(5)) + ' F' + fmt(R.speed * 60, 0));
      } else {
        put('G1 E-' + fe(R.length) + ' F' + fmt(R.speed * 60, 0));
      }
      st.retracted = true;
    }
    function deretract() {
      if (!st.retracted) return;
      put('G1 E' + fe(R.length + R.restartExtra) + ' F' + fmt(R.deretractSpeed * 60, 0));
      st.retracted = false;
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
      var endPos = planTravels(items, S, startPos, first ? true : R.onLayerChange);
      items[items.length - 1].retractAfter = lastLayer ? true : R.onLayerChange;
      var hookAt = hookAfter(items);
      if (hookAt >= 0) items[hookAt].retractAfter = true;
      var cool = coolLayer(items, S, first);
      var fan = fanFor(S, pj, cool.seconds);
      // reduce_fan_stop_start_freq: a layer keeps the fan it has unless the new one is 2 % or more away
      if (st.layerFan != null && pj >= S.fan.closeFirst + 1 && S.cooling.reduce_fan_stop_start_freq && Math.abs(fan - st.layerFan) < 2.55 * 2) fan = st.layerFan;
      st.layerFan = fan;
      var aux = auxFanFor(S, pj);
      if (cool.cap != null) {
        items.forEach(function (it) {
          if (it.feature === 'Bridge') return;
          if (cool.mode === 'quality_first') it.v = Math.max(Math.min(S.cooling.slow_down_min_speed, it.v), it.v * cool.cap);
          else it.v = Math.min(it.v, Math.max(cool.cap, Math.min(S.cooling.slow_down_min_speed, it.v)));
        });
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
      }
      put('; layer num/total_layer_count: ' + layerNo + '/' + totalLayers);
      put('; update layer progress');
      put('M73 L' + layerNo);
      put('M991 S0 P' + (layerNo - 1) + ' ;notify layer change');
      if (pj === 1) {
        if (S.temp.nozzle !== S.temp.nozzleInitial) put('M104 S' + fmt(S.temp.nozzle, 0));
        if (S.temp.bed !== S.temp.bedInitial) put('M140 S' + fmt(S.temp.bed, 0));
      }
      if (fan !== st.fan) { put(fanLine(fan)); st.fan = fan; }
      if (S.fan.aux && aux !== st.aux) { put('M106 P2 S' + fc(aux, 2)); st.aux = aux; }
      if (pj === 1) { put('; open powerlost recovery'); put('M1003 S1'); }
      st.objId = -1;
      var layerFan = fan;
      var featuresSeen = {};
      if (hookAt === -1) emitHook(li, z);

      items.forEach(function (it, k) {
        var t = it.travel;
        var pt = it.pts[0];
        var tFirst = first;
        var prev = k ? items[k - 1] : null;
        // ----- the boundary and the travel to this path
        if (k === 0) {
          openObject(it.obj);
          if (first) {
            accel(S.accel.firstTravel);
            put('G1 X' + fx(pt[0]) + ' Y' + fx(pt[1]) + ' F' + fmt(S.speed.firstTravel * 60, 0));
            if (R.hop > 0) put('G1 Z' + fx(z + R.hop));
            put('G1 Z' + fx(z));
          } else {
            accel(S.accel.travel);
            if (R.hop > 0 && R.onLayerChange) {
              var zUp = st.z + R.hop;
              spiral(zUp, false);
              put('G1 X' + fx(pt[0]) + ' Y' + fx(pt[1]) + ' Z' + fx(zUp) + ' F' + fmt(S.speed.travel * 60, 0));
              put('G1 Z' + fx(z));
            } else {
              put('G1 X' + fx(pt[0]) + ' Y' + fx(pt[1]) + ' Z' + fx(z) + ' F' + fmt(S.speed.travel * 60, 0));
            }
          }
          deretract();
        } else {
          flushRetract();
          var atHop = false;
          if (k - 1 === hookAt) {
            // the hook: lift in a circle, close the object, the photo, open the object again
            if (R.hop > 0) { spiral(z + R.hop, first); atHop = true; }
            closeObject();
            emitHook(li, z);
            openObject(it.obj);
          } else if (it.obj !== prev.obj) {
            closeObject();
            openObject(it.obj);
          }
          if (t.retract || atHop) {
            accel(travelA(first));
            if (atHop) put('G1 X' + fx(pt[0]) + ' Y' + fx(pt[1]) + ' F' + fmt(travelV(first) * 60, 0));
            else if (t.hop) put('G1 X' + fx(pt[0]) + ' Y' + fx(pt[1]) + ' Z' + fx(z + R.hop) + ' F' + fmt(travelV(first) * 60, 0));
            else put('G1 X' + fx(pt[0]) + ' Y' + fx(pt[1]) + ' F' + fmt(travelV(first) * 60, 0));
            if (atHop || t.hop) put('G1 Z' + fx(z));
            deretract();
          } else {
            accel(t.d < 2 ? S.accel.short : travelA(first));
            put('G1 X' + fx(pt[0]) + ' Y' + fx(pt[1]) + ' F' + fmt(travelV(first) * 60, 0));
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
        put('G1 F' + fmt(it.v * 60, 3));
        accel(it.a);
        var x = pt[0], y = pt[1];
        var lastPts = [it.pts[0]];
        for (var m = 1; m < it.pts.length; m++) {
          var tx = +fx(it.pts[m][0]), ty = +fx(it.pts[m][1]);
          var d = Math.hypot(tx - x, ty - y);
          if (!(d > 5e-4)) continue;
          var e = it.bead.area * d / filA * F.flow;
          put('G1 X' + fx(tx) + ' Y' + fx(ty) + ' E' + fe(e));
          st.extruded += e;
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
    var bodyTo = W.lines.length;
    // the time, from the lines themselves
    var est = estimateLines(W.lines.slice(bodyFrom, bodyTo), { jerk: S.jerk, accel: S.accel.def });
    var bodySeconds = est.seconds;
    var lineTime = function (i) { return Pr.timing.startSeconds + est.times[i - bodyFrom]; };
    layers.forEach(function (rec) {
      rec.clockFrom = rec.lineFrom > bodyFrom ? lineTime(rec.lineFrom - 1) : Pr.timing.startSeconds;
      rec.clockTo = lineTime(rec.lineTo - 1);
    });

    thaw(Pr.beforeEnd, vals, flags).forEach(function (l) { put(l); });
    thaw(Pr.end, vals, flags).forEach(function (l) { if (l.charAt(0) !== '@') put(l); });

    // ----- the file
    var totalSeconds = Pr.timing.startSeconds + bodySeconds + Pr.timing.endSeconds;
    var lengthMm = st.extruded + (Pr.purgeMm || 0);
    var volume = lengthMm * filA;
    var density = parseFloat((/^; filament_density = ([\d.]+)/m.exec(Pr.configBlock.join('\n')) || [0, 1.24])[1]);
    var cfgOf = function (k) { var m = new RegExp('^; ' + k + ' = (.*)$', 'm').exec(Pr.configBlock.join('\n')); return m ? m[1] : ''; };
    var heights = res.objects.map(function (ob) {
      var h = 0; ob.layers.forEach(function (Ly) { if (Ly && Ly.paths.length) h = Math.max(h, Ly.printZ); });
      return h;
    });
    var head = ['; HEADER_BLOCK_START', '; BambuStudio ' + Pr.studio,
      '; model printing time: ' + duration(bodySeconds) + '; total estimated time: ' + duration(totalSeconds),
      '; total layer number: ' + totalLayers,
      '; total filament length [mm] : ' + lengthMm.toFixed(2),
      '; total filament volume [cm^3] : ' + volume.toFixed(2),              // mm^3 under Studio's label, as Studio writes it
      '; total filament weight [g] : ' + (volume / 1000 * density).toFixed(2)];
    if (labelled) {
      head.push('; model label id: ' + idList);
      head.push('; object max height: ' + heights.map(function (h) { return h.toFixed(2); }).join(','));
    }
    head.push('; filament_density: ' + cfgOf('filament_density'));
    head.push('; filament_diameter: ' + cfgOf('filament_diameter'));
    head.push('; max_z_height: ' + top.toFixed(2));
    head.push('; filament: 1');
    head.push('; support_material_on_wipe_tower: 0');
    head.push('; HEADER_BLOCK_END');

    var outLines = head.concat(['', '; CONFIG_BLOCK_START'], configLines(Pr, S), ['; CONFIG_BLOCK_END', '', '; EXECUTABLE_BLOCK_START']);
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
        grams: volume / 1000 * density, box: box,
        seconds: { start: Pr.timing.startSeconds, body: bodySeconds, end: Pr.timing.endSeconds, total: totalSeconds }
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
      date: opts.date
    }).then(function (w) { return { bytes: w.bytes, plan: P, fields: w.fields }; });
  }

  function fanLine(v) { return 'M106 S' + fc(v, 2); }

  /** The auxiliary (chamber-side) fan on printers that have one: off for
   *  close_additional_fan_first_x_layers, then additional_cooling_fan_speed %. */
  function auxFanFor(S, layerIndex) {
    if (!S.fan.aux || layerIndex < S.fan.closeAux) return 0;
    return Math.round(S.fan.auxPercent * 255 / 100);
  }

  return {
    settingsFrom: settingsFrom,
    engineOptions: engineOptions,
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
    firstLayerBox: firstLayerBox,
    objectMask: objectMask,
    duration: duration,
    SPIRAL_R: SPIRAL_R,
    RETRACT_DURING_WIPE: RETRACT_DURING_WIPE
  };
});
