/* ============================================================
   Cut plate - the Cut card's WHOLE-PLATE blade: the planning core. THREE-free
   and DOM-free, so the whole file runs under node (tools/nso_cut_plate_test.js);
   the app layer is app-cut-plate.js.

   Why this exists
   ---------------
   Print-testing a set of pieces that share a long column (a support reference
   plate: six pieces, each a 5 mm pillar from the bed up to the feature under
   test) means printing the same pillar six times, every time. Shortening it
   once, on every piece at the same height, is one blade across the plate:

     - the blade is a horizontal plane at HEIGHT mm above the bed, one number
       for the whole plate, on a slider;
     - KEEP ABOVE (the default) cuts away everything under the blade and sets
       what is left back down on the bed: every piece the blade crosses comes
       out HEIGHT mm shorter, whatever its shape, and the feature up top is
       untouched. KEEP BELOW is the same cut the other way up: everything
       above the blade goes and the pieces keep their feet.

   The cut itself is the app's own raw cut (app-cut.js rawCut: the cap is the
   section, closed and checked); this file only decides WHERE and WHETHER, in
   the piece's own raw frame (Z up - the frame height lives in), and moves the
   kept part. It never touches the engine.

   Height
   ------
   A piece stands on the bed with its lowest point at `liftY` (0 on the bed,
   more for a piece Lifted or Seated on another). The blade at HEIGHT is
   therefore at raw z = zmin + HEIGHT - liftY. A piece is cut only if the blade
   clears both its ends by MIN_SIDE_MM (the distance Cut itself demands of a
   side): a piece lower than the blade, or a lifted one the blade passes
   under, is left exactly as it is, and the plan says so by name.
   ============================================================ */
(function (root) {
  'use strict';

  /* What Cut itself demands of each side (app-core.js MIN_CUT_SIDE_MM). */
  var MIN_SIDE_MM = 1;
  var KEEPS = ['above', 'below'];

  /* The raw soup's z range. */
  function zRange(raw) {
    var lo = Infinity, hi = -Infinity;
    for (var i = 2; i < raw.length; i += 3) {
      var z = raw[i];
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
    return { lo: lo, hi: hi };
  }

  /* The blade height, in mm above the bed, is snapped to the 0.1 mm grid every
     other Cut number lives on. */
  function snap(h) { return Math.round(Number(h) * 10) / 10; }

  /* What the blade does to ONE piece.
       raw    the piece's raw soup (Z up)
       opts   { height, keep: 'above' | 'below', liftY, minSide }
     opts.range { lo, hi } stands in for the soup's z range (the slider asks
     the same question at every step and need not rebuild a soup to do it).
     -> { cut: boolean, why: string|null, zmin, zmax, tall, plane, removed, after,
          keep, drop }
     `cut` false means the piece stays as it is, and `why` names the reason in
     plain words. `plane` is the raw z the cut is made at; `removed` the mm of
     piece that goes; `after` the piece's height once cut; `drop` how far the
     kept part is moved down in raw z (KEEP ABOVE: the whole way, so the cut face
     becomes the new foot; KEEP BELOW: 0). */
  function plan(raw, opts) {
    opts = opts || {};
    var keep = opts.keep === 'below' ? 'below' : 'above';
    var min = opts.minSide != null ? opts.minSide : MIN_SIDE_MM;
    var lift = Number(opts.liftY) || 0;
    var h = Number(opts.height);
    var r = opts.range || (raw && raw.length >= 9 ? zRange(raw) : { lo: NaN, hi: NaN });
    var tall = r.hi - r.lo;
    var out = { cut: false, why: null, zmin: r.lo, zmax: r.hi, tall: tall, plane: null, removed: 0, after: tall,
                keep: keep, drop: 0, height: h, liftY: lift };
    if (!isFinite(tall) || !(tall > 0)) { out.why = 'it has no height'; return out; }
    if (!isFinite(h)) { out.why = 'no blade height'; return out; }
    var inside = h - lift;                       // the blade's height above THIS piece's lowest point
    if (inside < min) {
      out.why = lift > 0 && inside < 0
        ? 'it stands ' + lift.toFixed(1) + ' mm up, above the blade'
        : 'the blade is less than ' + min + ' mm up its foot';
      return out;
    }
    if (tall - inside < min) {
      out.why = tall < inside
        ? 'it is only ' + tall.toFixed(1) + ' mm tall, lower than the blade'
        : 'the blade is less than ' + min + ' mm from its top';
      return out;
    }
    out.cut = true;
    out.plane = r.lo + inside;
    if (keep === 'above') { out.removed = inside; out.after = tall - inside; out.drop = inside; }
    else { out.removed = tall - inside; out.after = inside; out.drop = 0; }
    return out;
  }

  /* A copy of the soup moved by dz in z, in float32 as the soup is. */
  function shiftZ(raw, dz) {
    var out = new Float32Array(raw.length);
    for (var i = 0; i < raw.length; i += 3) {
      out[i] = raw[i];
      out[i + 1] = raw[i + 1];
      out[i + 2] = Math.fround(raw[i + 2] - dz);
    }
    return out;
  }

  /* The cut: `cutFn(raw, axisIdx, plane, keepMin)` is the app's cutOneSide
     (rawCut with its closed-section check), handed in so this file has no
     engine of its own. keepMin true keeps coord >= plane (the upper part). */
  function apply(raw, p, cutFn) {
    if (!p || !p.cut) throw new Error('nothing to cut');
    var kept = cutFn(raw, 2, p.plane, p.keep === 'above');
    return p.drop ? shiftZ(kept, p.drop) : kept;
  }

  /* The plan for a whole plate, and the numbers the readout is made of.
       pieces  [{ id, name, raw | range, liftY }]
     -> { plans: [{ id, name, plan }], cut, total, untouched: [{name, why}], tallest,
          removedMin, removedMax, afterMax } */
  function planPlate(pieces, opts) {
    var plans = [], untouched = [], cut = 0, tallest = 0, rmin = Infinity, rmax = 0, amax = 0;
    (pieces || []).forEach(function (pc) {
      var p = plan(pc.raw, { height: opts.height, keep: opts.keep, liftY: pc.liftY, minSide: opts.minSide, range: pc.range });
      plans.push({ id: pc.id, name: pc.name, plan: p });
      if (isFinite(p.tall) && p.tall + (Number(pc.liftY) || 0) > tallest) tallest = p.tall + (Number(pc.liftY) || 0);
      if (p.cut) {
        cut++;
        if (p.removed < rmin) rmin = p.removed;
        if (p.removed > rmax) rmax = p.removed;
        if (p.after > amax) amax = p.after;
      } else untouched.push({ id: pc.id, name: pc.name, why: p.why });
    });
    return { plans: plans, cut: cut, total: plans.length, untouched: untouched, tallest: tallest,
             removedMin: cut ? rmin : 0, removedMax: rmax, afterMax: amax };
  }

  /* How high the slider runs: just under the tallest piece (the blade must clear
     its top by MIN_SIDE_MM), and from MIN_SIDE_MM up. Both on the 0.1 grid, the
     top rounded DOWN so the end of the slider is never a position that cuts
     nothing. */
  function heightRange(pieces, minSide) {
    var min = minSide != null ? minSide : MIN_SIDE_MM, top = 0;
    (pieces || []).forEach(function (pc) {
      var r = pc.range || zRange(pc.raw);
      var t = r.hi - r.lo + (Number(pc.liftY) || 0);
      if (isFinite(t) && t > top) top = t;
    });
    var lo = Math.ceil(min * 10 - 1e-9) / 10;
    var hi = Math.floor((top - min) * 10 + 1e-9) / 10;
    if (!(hi >= lo)) return { lo: lo, hi: lo, tallest: top, ok: false };
    return { lo: lo, hi: hi, tallest: top, ok: true };
  }

  var api = { MIN_SIDE_MM: MIN_SIDE_MM, KEEPS: KEEPS, zRange: zRange, snap: snap, plan: plan, shiftZ: shiftZ,
              apply: apply, planPlate: planPlate, heightRange: heightRange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NSO_CutPlate = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));
