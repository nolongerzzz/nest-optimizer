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
        closeFirst: num(config, 'close_fan_the_first_x_layers', 1)
      },
      cooling: cool
    };
    return S;
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
   *  acceleration `a` mm/s^2. One trapezoid per path: a path is one chain of
   *  short collinear-ish moves, so the machine never stops inside it. */
  function moveSeconds(len, v, a) {
    if (!(len > 0)) return 0;
    if (!(v > 0)) return 0;
    if (!(a > 0)) return len / v;
    var ramp = v * v / a;                 // distance of the up-and-down ramps together
    return len >= ramp ? len / v + v / a : 2 * Math.sqrt(len / a);
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
        var bead = beadOf(S, p.feature, p.width, plane.h);
        var fs = featureSpeed(S, p.feature, first);
        var vCap = S.filament.maxVolumetric > 0 ? S.filament.maxVolumetric / bead.area : Infinity;
        var v = Math.min(fs.v, vCap);
        items.push({
          obj: oi, feature: p.feature, thin: !!p.thinWall, pts: pts, closed: !!p.closed,
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
      t += moveSeconds(it.len, v, it.a);
      if (it.travel.d > 0) t += moveSeconds(it.travel.d, S.speed.travel, S.accel.travel);
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
  // The plan
  // ===========================================================================

  /**
   * @param {object} res    sliceObjects() result
   * @param {object} opts   { config, cooling }
   * @returns {{ok, reason, gcode, layers, stats, settings}}
   */
  function plan(res, opts) {
    opts = opts || {};
    if (!res || !res.ok) return { ok: false, reason: 'nothing to plan: ' + (res && res.reason || 'no slice') };
    if (!opts.config) return { ok: false, reason: 'the printer template\'s project settings (opts.config) are required' };
    if (!opts.printer) return { ok: false, reason: 'the printer\'s frozen start / end (opts.printer) is required' };
    var Pr = opts.printer;
    var S = settingsFrom(opts.config, opts.cooling);
    var F = S.filament;
    var filA = Math.PI * F.diameter * F.diameter / 4;
    var out = [];
    var layers = [];
    var st = { x: null, y: null, z: 0, fan: null, feature: null, lw: null, F: null, A: null, extruded: 0, seconds: 0,
               retracted: false };

    var box = firstLayerBox(res);
    if (!box) return { ok: false, reason: 'nothing prints on the first layer' };
    var bed = Pr.bed;
    if (box.x < 0 || box.y < 0 || box.x + box.w > bed.x || box.y + box.h > bed.y) {
      return { ok: false, reason: 'the first layer (' + box.x.toFixed(1) + ',' + box.y.toFixed(1) + ' to ' + (box.x + box.w).toFixed(1) +
        ',' + (box.y + box.h).toFixed(1) + ') is not on the ' + Pr.printer + '\'s ' + bed.x + ' x ' + bed.y + ' mm bed' };
    }
    var lastPrinting = res.planes.length - 1;
    while (lastPrinting > 0 && !res.objects.some(function (ob) { var Lr = ob.layers[lastPrinting]; return Lr && Lr.paths.length; })) lastPrinting--;
    var top = res.planes[lastPrinting].printZ;
    if (top > bed.z) return { ok: false, reason: 'the print is ' + top.toFixed(1) + ' mm tall; the ' + Pr.printer + ' prints ' + bed.z + ' mm' };
    var vals = { nozzle: S.temp.nozzleInitial, nozzleT: S.temp.nozzle, bed: S.temp.bedInitial, box: box,
                 cy: box.y + box.h / 2, maxZ: top };
    var flags = { spaghetti: !opts.hooks || opts.hooks.spaghetti !== false };

    thaw(Pr.start, vals, flags).forEach(function (l) { if (l.charAt(0) !== '@') out.push(l); });
    thaw(Pr.afterStart, vals, flags).forEach(function (l) { out.push(l); });

    var startPos = null;
    for (var li = 0; li < res.planes.length; li++) {
      var pl = res.planes[li];
      var first = li === 0;
      var items = layerItems(res, li, S);
      var lastLayer = li === lastPrinting;
      if (!items.length) continue;
      var endPos = planTravels(items, S, startPos, first ? true : S.retract.onLayerChange);
      items[items.length - 1].retractAfter = lastLayer ? true : S.retract.onLayerChange;
      var cool = coolLayer(items, S, first);
      var fan = fanFor(S, li, cool.seconds);
      if (cool.cap != null) {
        items.forEach(function (it) {
          if (it.feature === 'Bridge') return;
          if (cool.mode === 'quality_first') it.v = Math.max(Math.min(S.cooling.slow_down_min_speed, it.v), it.v * cool.cap);
          else it.v = Math.min(it.v, Math.max(cool.cap, Math.min(S.cooling.slow_down_min_speed, it.v)));
        });
      }
      var rec = { index: li, z: pl.printZ, h: pl.h, seconds: cool.seconds, slowdownCap: cool.cap, fan: fan,
                  features: [], items: items.length };
      layers.push(rec);
      emitLayer(out, items, li, pl, S, st, fan, filA, rec, first, lastLayer);
      startPos = endPos;
    }
    thaw(Pr.beforeEnd, vals, flags).forEach(function (l) { out.push(l); });
    thaw(Pr.end, vals, flags).forEach(function (l) { if (l.charAt(0) !== '@') out.push(l); });
    // Until the Bambu CONFIG_BLOCK is written (the markers commit), the one key the importer needs
    out.push('; CONFIG_BLOCK_START');
    out.push('; filament_diameter = ' + F.diameter);
    out.push('; CONFIG_BLOCK_END');
    return {
      ok: true, reason: '', gcode: out.join('\n') + '\n', layers: layers, settings: S,
      stats: { filamentMm: st.extruded, layers: layers.length }
    };
  }

  function fanLine(v) { return 'M106 S' + fc(v, 2); }

  /** One layer's G-code. */
  function emitLayer(out, items, li, pl, S, st, fan, filA, rec, first, lastLayer) {
    var R = S.retract;
    var hop = R.hop;
    out.push('; CHANGE_LAYER');
    out.push('; Z_HEIGHT: ' + fc(pl.printZ, 4));
    out.push('; LAYER_HEIGHT: ' + fc(pl.h, 4));
    st.lh = pl.h;
    if (li === 1) {
      if (S.temp.nozzle !== S.temp.nozzleInitial) out.push('M104 S' + fmt(S.temp.nozzle, 0));
      if (S.temp.bed !== S.temp.bedInitial) out.push('M140 S' + fmt(S.temp.bed, 0));
    }
    if (fan !== st.fan) { out.push(fanLine(fan)); st.fan = fan; }
    var layerFan = fan;
    var featuresSeen = {};
    var curObj = -1;

    items.forEach(function (it, k) {
      var t = it.travel;
      var z = pl.printZ;
      var pt = it.pts[0];
      // ----- the travel to this path
      if (k === 0) {
        if (first) {
          out.push('G1 E-' + fe(R.length) + ' F' + fmt(R.speed * 60, 0));
          st.retracted = true;
          out.push('M204 S' + fmt(S.accel.firstTravel, 0));
          out.push('G1 X' + fx(pt[0]) + ' Y' + fx(pt[1]) + ' F' + fmt(S.speed.firstTravel * 60, 0));
          if (hop > 0) out.push('G1 Z' + fx(z + hop));
          out.push('G1 Z' + fx(z));
        } else {
          out.push('M204 S' + fmt(S.accel.travel, 0));
          if (hop > 0 && R.onLayerChange) {
            var zUp = st.z + hop;
            out.push('G17');
            out.push('G3 Z' + fx(zUp) + ' I' + fx(SPIRAL_R) + ' J0 P1  F' + fmt(S.speed.travel * 60, 0));
            out.push('G1 X' + fx(pt[0]) + ' Y' + fx(pt[1]) + ' Z' + fx(zUp) + ' F' + fmt(S.speed.travel * 60, 0));
          } else {
            out.push('G1 X' + fx(pt[0]) + ' Y' + fx(pt[1]) + ' Z' + fx(z) + ' F' + fmt(S.speed.travel * 60, 0));
          }
          if (hop > 0 && R.onLayerChange) out.push('G1 Z' + fx(z));
        }
        if (st.retracted) { out.push('G1 E' + fe(R.length + R.restartExtra) + ' F' + fmt(R.deretractSpeed * 60, 0)); st.retracted = false; }
      } else {
        var prevZ = z;
        if (t.retract) {
          out.push('M204 S' + fmt(S.accel.travel, 0));
          if (t.hop) out.push('G1 X' + fx(pt[0]) + ' Y' + fx(pt[1]) + ' Z' + fx(prevZ + hop) + ' F' + fmt(S.speed.travel * 60, 0));
          else out.push('G1 X' + fx(pt[0]) + ' Y' + fx(pt[1]) + ' F' + fmt(S.speed.travel * 60, 0));
          if (t.hop) out.push('G1 Z' + fx(prevZ));
          out.push('G1 E' + fe(R.length + R.restartExtra) + ' F' + fmt(R.deretractSpeed * 60, 0));
          st.retracted = false;
        } else {
          out.push('M204 S' + fmt(t.d < 2 ? S.accel.short : S.accel.travel, 0));
          out.push('G1 X' + fx(pt[0]) + ' Y' + fx(pt[1]) + ' F' + fmt(S.speed.travel * 60, 0));
        }
      }
      // ----- the path
      if (it.obj !== curObj) { curObj = it.obj; }
      if (it.feature !== st.feature) {
        out.push('; FEATURE: ' + it.feature);
        st.feature = it.feature; st.lw = null;
      }
      if (Math.abs(st.lh - it.bead.h) > 1e-9) { out.push('; LAYER_HEIGHT: ' + fc(it.bead.h, 6)); st.lh = it.bead.h; }
      if (st.lw !== it.bead.w) { out.push('; LINE_WIDTH: ' + fc(it.bead.w, 6)); st.lw = it.bead.w; }
      featuresSeen[it.feature] = 1;
      var bridgeFan = (it.feature === 'Bridge' || it.feature === 'Overhang wall') &&
        S.cooling.enable_overhang_bridge_fan && li >= S.fan.closeFirst;
      var fanNow = bridgeFan ? Math.max(layerFan, Math.round(S.cooling.overhang_fan_speed * 255) / 100) : layerFan;
      if (fanNow !== st.fan) { out.push(fanLine(fanNow)); st.fan = fanNow; }
      out.push('G1 F' + fmt(it.v * 60, 3));
      out.push('M204 S' + fmt(it.a, 0));
      var x = pt[0], y = pt[1];
      var lastPts = [it.pts[0]];
      for (var m = 1; m < it.pts.length; m++) {
        var tx = +fx(it.pts[m][0]), ty = +fx(it.pts[m][1]);
        var d = Math.hypot(tx - x, ty - y);
        if (!(d > 5e-4)) continue;
        var e = it.bead.area * d / filA * S.filament.flow;
        out.push('G1 X' + fx(tx) + ' Y' + fx(ty) + ' E' + fe(e));
        st.extruded += e;
        x = tx; y = ty;
        lastPts.push([tx, ty]);
      }
      st.x = x; st.y = y; st.z = z;
      // ----- the retraction after it
      if (it.retractAfter) {
        if (R.length > 0) {
          if (R.wipe && R.wipeDistance > 0 && lastPts.length > 1) {
            out.push('; WIPE_START');
            out.push('G1 F' + fmt(it.vWipe * 60, 3));
            out.push('M204 S' + fmt(S.accel.def, 0));
            var wp = wipePath(lastPts, R.wipeDistance);
            var wl = pathLength(wp);
            var spent = 0;
            for (var q = 1; q < wp.length; q++) {
              // what the file says, so the cycle sums to the retraction to the last digit
              var share = +fe(R.length * RETRACT_DURING_WIPE * dist(wp[q - 1], wp[q]) / wl);
              out.push('G1 X' + fx(wp[q][0]) + ' Y' + fx(wp[q][1]) + ' E-' + fe(share));
              spent += share;
            }
            out.push('; WIPE_END');
            out.push('G1 E-' + fe(+(R.length - spent).toFixed(5)) + ' F' + fmt(R.speed * 60, 0));
          } else {
            out.push('G1 E-' + fe(R.length) + ' F' + fmt(R.speed * 60, 0));
          }
          st.retracted = true;
        }
      }
      st.fan = fanNow;
      if (bridgeFan && (k + 1 >= items.length || (items[k + 1].feature !== 'Bridge' && items[k + 1].feature !== 'Overhang wall'))) {
        out.push(fanLine(layerFan)); st.fan = layerFan;
      }
    });
    if (lastLayer) {
      // the last path is wiped and retracted; lift off it before the end block
      out.push('M204 S' + fmt(S.accel.travel, 0));
      if (hop > 0) {
        out.push('G17');
        out.push('G3 Z' + fx(pl.printZ + hop) + ' I' + fx(SPIRAL_R) + ' J0 P1  F' + fmt(S.speed.travel * 60, 0));
      }
    }
    rec.features = Object.keys(featuresSeen);
  }

  return {
    settingsFrom: settingsFrom,
    coolingValues: coolingValues,
    featureSpeed: featureSpeed,
    beadOf: beadOf,
    beadArea: beadArea,
    moveSeconds: moveSeconds,
    plan: plan,
    thaw: thaw,
    firstLayerBox: firstLayerBox,
    SPIRAL_R: SPIRAL_R,
    RETRACT_DURING_WIPE: RETRACT_DURING_WIPE
  };
});
