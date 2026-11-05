/* nso_printer.js - per-printer build volume, and the one "does it fit?" check.

   Loads as a classic script (window.NSO_Printer) and as a Node module
   (require('../nso_printer.js')). No DOM, no Three.js, no app state.

   ---------------------------------------------------------------------------
   SCOPE, stated first because it is the whole design
   ---------------------------------------------------------------------------
   This module answers exactly one question:

       Will this bounding box physically fit inside that machine?

   It is NOT a printability check. It does not know or care about bridging,
   overhangs, wall thickness, severed connections, supports, adhesion or
   warping. Those are separate, already-existing concerns with their own
   modules (nso_thickness.js for the nozzle floor, mesh_validate.py for the
   mesh itself), and folding any of them in here would make a warning that
   says "too big for your printer" start firing for reasons that have nothing
   to do with size. A piece that fits and is unprintable passes this check.
   That is correct.

   ---------------------------------------------------------------------------
   THE AXIS CONVENTION, once
   ---------------------------------------------------------------------------
   Every size this module takes or returns is in PRINTER axes:

       x, y   the bed footprint, millimetres
       z      build height, millimetres

   That is the raw-soup convention (Z up) and the convention printer
   manufacturers quote, so a rawTris bbox needs no conversion. The app's
   DISPLAY geometry is Y up - zUpToYUp() runs on import - so a display size
   goes through fromDisplaySize() first. The conversion is one line and it is
   written down here rather than at each call site, because a silently swapped
   height is exactly the bug this module exists to catch.

   ---------------------------------------------------------------------------
   THE PROFILE TABLE
   ---------------------------------------------------------------------------
   Keyed to match app-core.js's PLATES ids one-for-one, so the plate selector
   the app already has resolves straight into a profile with no mapping table
   in between. PLATES carries bed X/Y only; this adds the build height, which
   is the axis the plate picker has never modelled and the one a thrown vessel
   runs out of first.

   Where a single PLATES id covers several real machines, the build height is
   the LOWEST of them, named in `covers`. A warning that fires slightly early
   on the taller machine is a warning; one that stays silent on the shorter
   machine is a failed print. `prusa` is the case: MK4 is 220 mm tall, MK3S is
   210, and the id covers both, so 210 it is.

   These are manufacturer-published figures, transcribed, not measured here.
   A machine with a modified gantry or a raised bed is a `custom` profile.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   PROFILES                       the frozen table
   ids()                          -> ['a1mini', 'a1', ...]
   get(id)                        -> profile | null
   resolve(id, over)              -> profile, with `custom`'s live numbers folded in
   fromDisplaySize(size)          -> { x, y, z } in printer axes
   sizeOfRaw(rawTris)             -> { x, y, z } bbox size of a raw soup
   fit(size, profile, opts)       -> report
   describe(report)               -> one status line

   Every report has one shape:

     {
       kind: 'build-volume',
       printer, printer_name,
       bed_x_mm, bed_y_mm, build_z_mm, margin_mm,
       size: { x, y, z },
       fits,            // true when every axis is inside, as oriented
       over,            // [{ axis, size_mm, limit_mm, over_mm }], worst first
       worst_mm,        // the largest overhang, 0 when it fits
       rotatedFits,     // would a 90 deg turn about Z put the FOOTPRINT inside
       reason           // human-readable, always set
     }

   OUT OF SCOPE, named so the next ticket does not re-derive it: placing a
   piece at an arbitrary angle. A 260 x 20 mm bar does fit diagonally on a
   256 mm bed, and this module will say it does not fit. Only the 90 degree
   turn is reported, because that one is exact in one line and the packer
   (packModels in app-core.js) is the thing that owns placement. A piece that
   only fits on the diagonal deserves a human looking at it, not a silent pass.
*/

(function (root) {
  'use strict';

  var PROFILES = {
    a1mini: {
      id: 'a1mini', name: 'Bambu A1 Mini',
      bedX: 180, bedY: 180, buildZ: 180,
      covers: ['A1 Mini']
    },
    a1: {
      id: 'a1', name: 'Bambu A1 / P1S / X1C',
      bedX: 256, bedY: 256, buildZ: 256,
      covers: ['A1', 'P1S', 'X1C']
    },
    prusa: {
      /* MK4 is 250 x 210 x 220, MK3S is 250 x 210 x 210. One id, both
         machines, so the height is the shorter one - see the header. */
      id: 'prusa', name: 'Prusa MK4 / MK3S',
      bedX: 250, bedY: 210, buildZ: 210,
      covers: ['MK4 (220 mm tall)', 'MK3S (210 mm tall)']
    },
    ender: {
      id: 'ender', name: 'Creality Ender 3',
      bedX: 220, bedY: 220, buildZ: 250,
      covers: ['Ender 3', 'Ender 3 Pro', 'Ender 3 V2']
    },
    custom: {
      /* Placeholders. resolve('custom', {...}) folds in whatever the Plate
         card's W / D / H fields currently hold. */
      id: 'custom', name: 'Custom',
      bedX: 180, bedY: 180, buildZ: 180,
      covers: []
    }
  };

  function ids() {
    var out = [];
    for (var k in PROFILES) if (Object.prototype.hasOwnProperty.call(PROFILES, k)) out.push(k);
    return out;
  }

  function get(id) {
    return Object.prototype.hasOwnProperty.call(PROFILES, id) ? PROFILES[id] : null;
  }

  function positive(v, fallback) {
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : fallback;
  }

  /* A profile plus, for `custom`, the numbers the user is actually holding.
     `over` may carry bedX / bedY / buildZ, or the app's plate-shaped
     { w, d, h }; both spellings resolve, because the plate card speaks w/d and
     every other caller here speaks bed axes. */
  function resolve(id, over) {
    var base = get(id) || PROFILES.custom;
    over = over || {};
    var bedX = positive(over.bedX, positive(over.w, base.bedX));
    var bedY = positive(over.bedY, positive(over.d, base.bedY));
    var buildZ = positive(over.buildZ, positive(over.h, base.buildZ));
    if (bedX === base.bedX && bedY === base.bedY && buildZ === base.buildZ) return base;
    return {
      id: base.id, name: base.name,
      bedX: bedX, bedY: bedY, buildZ: buildZ,
      covers: base.covers
    };
  }

  /* Display geometry is Y up (zUpToYUp at import), printers are Z up. */
  function fromDisplaySize(size) {
    if (!size) return null;
    return { x: size.x, y: size.z, z: size.y };
  }

  /* Bounding-box size of a raw soup, already in printer axes. */
  function sizeOfRaw(rawTris) {
    if (!rawTris || rawTris.length < 9) return null;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < rawTris.length; i += 3) {
      for (var k = 0; k < 3; k++) {
        var v = rawTris[i + k];
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }
    return { x: hi[0] - lo[0], y: hi[1] - lo[1], z: hi[2] - lo[2] };
  }

  function round3(x) { return Math.round(x * 1000) / 1000; }

  /* opts.margin   mm of bed kept clear on every side; default 0, because the
                   question here is physical fit and nothing else. A caller
                   that wants a skirt allowance passes it explicitly.
     opts.epsilon  slack for float noise; default 1e-4 mm, the weld radius
                   this repo uses everywhere for "the same number". A piece
                   exactly as wide as the bed fits. */
  function fit(size, profile, opts) {
    opts = opts || {};
    var p = profile || PROFILES.custom;
    var margin = (typeof opts.margin === 'number' && opts.margin >= 0) ? opts.margin : 0;
    var eps = (typeof opts.epsilon === 'number' && opts.epsilon >= 0) ? opts.epsilon : 1e-4;

    var limX = p.bedX - 2 * margin;
    var limY = p.bedY - 2 * margin;
    var limZ = p.buildZ;   /* margin is a BED clearance; height has no rim */

    var rep = {
      kind: 'build-volume',
      printer: p.id, printer_name: p.name,
      bed_x_mm: p.bedX, bed_y_mm: p.bedY, build_z_mm: p.buildZ,
      margin_mm: margin,
      size: null,
      fits: true, over: [], worst_mm: 0,
      rotatedFits: false,
      reason: ''
    };

    if (!size || !isFinite(size.x) || !isFinite(size.y) || !isFinite(size.z)) {
      rep.fits = false;
      rep.reason = 'no measurable size - nothing checked';
      return rep;
    }
    rep.size = { x: size.x, y: size.y, z: size.z };

    var axes = [['x', size.x, limX], ['y', size.y, limY], ['z', size.z, limZ]];
    for (var i = 0; i < axes.length; i++) {
      var over = axes[i][1] - axes[i][2];
      if (over > eps) {
        rep.over.push({
          axis: axes[i][0],
          size_mm: round3(axes[i][1]),
          limit_mm: round3(axes[i][2]),
          over_mm: round3(over)
        });
      }
    }
    rep.over.sort(function (a, b) { return b.over_mm - a.over_mm; });
    rep.fits = rep.over.length === 0;
    rep.worst_mm = rep.over.length ? rep.over[0].over_mm : 0;

    /* A 90 degree turn about Z swaps the footprint axes and leaves height
       alone. Only interesting when the piece does NOT fit as it stands. */
    rep.rotatedFits = (size.y - limX <= eps) && (size.x - limY <= eps) && (size.z - limZ <= eps);

    if (rep.fits) {
      rep.reason = 'fits ' + p.name + ' (' + p.bedX + ' x ' + p.bedY + ' x ' + p.buildZ + ' mm)';
    } else {
      var parts = [];
      for (var j = 0; j < rep.over.length; j++) {
        var o = rep.over[j];
        parts.push(o.axis.toUpperCase() + ' ' + round3(o.size_mm) + ' mm is ' +
                   round3(o.over_mm) + ' mm over the ' + round3(o.limit_mm) + ' mm limit');
      }
      rep.reason = parts.join(', ');
      if (rep.rotatedFits) rep.reason += ' - turning it 90 deg about Z would fit';
    }
    return rep;
  }

  function describe(rep) {
    if (!rep) return '';
    if (rep.fits) return 'Fits ' + rep.printer_name + ' - ' + rep.reason;
    return 'TOO BIG for ' + rep.printer_name + ' - ' + rep.reason;
  }

  var API = {
    PROFILES: PROFILES,
    ids: ids,
    get: get,
    resolve: resolve,
    fromDisplaySize: fromDisplaySize,
    sizeOfRaw: sizeOfRaw,
    fit: fit,
    describe: describe
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Printer = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
