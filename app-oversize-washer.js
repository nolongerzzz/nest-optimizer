/* app-oversize-washer.js - the export mode for a deliberately close-contact,
   OVERSIZED washer sandwich: a patch or shim larger than the piece it sits on,
   placed by hand at a typed gap and exported as it stands.

   ---------------------------------------------------------------------------
   WHAT ACTUALLY BLOCKED THIS, MEASURED BEFORE ANY OF IT WAS WRITTEN
   ---------------------------------------------------------------------------
   Nothing at export does. Neither exporter looks at geometry: exportSTLs()
   runs buildCombinedGeometry() and writes the bytes, export3MF() builds its
   objects and writes the archive, and the only refusal either carries is
   "Nothing to export - run Optimize first". A washer in hard contact with its
   target - true minimum surface-to-surface distance 0.000 mm - already exports
   from both routes. The piercing-pair and coplanar-contact numbers this repo
   quotes are the CHECKER's (tools/mesh_validate.py) and the Check-piece
   overlay's (app-defects.js); neither is wired to an export button. There was
   no export gate here to relax, and this file does not add one.

   The one hard refusal that blocked the workflow is in the SEAT, and it is the
   corner-ray fit's own footprint limit. NSO_seatFlushBitToHull casts one ray
   from each corner of the bit's outer face along the punch axis; a washer that
   overhangs its target has corners standing over open air, the rays miss, and
   the seat returns "corner N missed hull along punch axis" and moves nothing.
   Measured on a 30 x 30 sandwich patch over library/box_bit_12x8x8.stl (9 mm
   of overhang in X, 11 mm in Z): Seat (support) refuses at every value the
   slider can express - 0, -0.18, +0.05, -0.25 - with that same line. Two more
   refusals live on the same path and are named here for the same reason: the
   straddle refusal (NSO_seatStraddle) and the gap residual limit
   (NSO_SEAT_GAP_RESIDUAL_LIMIT).

   Two other things the audit looked for and did not find, said plainly so the
   next person does not go looking again: there is no Skin-pattern clearance
   warning that escalates to a hard block - NSO_Thickness.cutWarning() ends
   "- reported, not blocked" and every skin readout is a describe string - and
   there is no numeric gap control anywhere in the app. The gap slider is a
   range input clamped to -0.25 .. +0.05, so a deliberate half-millimetre
   squeeze could not be ASKED for, let alone refused.

   ---------------------------------------------------------------------------
   WHAT THIS MODE IS
   ---------------------------------------------------------------------------
   A checkbox and a millimetre field on the Join card. With the checkbox clear
   nothing here runs and Seat (support) is the seat it has always been. With it
   set, Seat (support) stops going through the corner-ray fit and instead:

     - takes the gap from the TYPED field, not the slider, so a gap outside the
       slider's range can be asked for at all;
     - aims straight down through B's own box centre onto A - which is where
       Center lock has just put it - so no viewport click is needed and B's XZ
       is not touched;
     - places B through the shipped measured-clearance solve
       (NSO_seatHereAt -> NSO_SeatSurface.plan, center:false), the same solve
       Seat here already uses and the same one tools/nso_seat_surface_test.js
       pins. Nothing about that solve is reimplemented or relaxed here: it has
       no corner rays and therefore no footprint limit, which is the whole
       reason the oversized case goes through it.

   One consequence of reusing that path rather than copying it, said plainly:
   a washer that is not already facing the target gets TURNED onto it and
   baked into its own axes, exactly as Seat here does and under Seat here's
   own paint guard. A washer Center lock has just put flat on a flat top is
   the case this mode is for, and there the turn is zero and nothing is baked.

   ---------------------------------------------------------------------------
   THE REPORT, AND WHY IT IS A REPORT
   ---------------------------------------------------------------------------
   Modelled on cutClearanceFor / NSO_Thickness.cutWarning (app-join.js, "NOZZLE-
   SAFETY READOUT FOR A CUT"), clause by clause:

     - it is measured BEFORE anything moves, from the pose the user built, so
       it answers the question the seat is about to answer;
     - every failure path returns null, because a measurement that cannot be
       taken must not fail a placement that is otherwise sound;
     - it is appended to the status line and the placement is committed either
       way, and it ends in the same four words the cut readout ends in.

   The finding is only printed when there IS one - a corner ray that misses, or
   a straddle - exactly as cutWarning() returns '' for a clean cut. What is
   ALWAYS printed is the measurement: the gap that was asked for, the TRUE
   minimum surface-to-surface distance that came out (NSO_SeatSurface's own
   minDistance, not a corner residual and not the number that was requested),
   and the overhang in X and Z that made the corner-ray fit refuse in the first
   place. A mode whose point is that it does not refuse has to be louder about
   what it measured, not quieter.

   Scope: Seat (support) only, and only while the checkbox is set. Seat flush,
   Seat here, Align, Skin, Subtract and both exporters are untouched, and with
   the checkbox clear this file's only effect on the app is the one `armed()`
   call app-join.js makes. */
(function () {
  'use strict';

  var FLAG_ID = 'chk-oversize-washer';
  var GAP_ID = 'oversize-gap';

  /* A box edge is flush to within the pad meshBandExtent already allows a
     wall, so anything under this is not an overhang, it is Float32. */
  var OVERHANG_TOL = 0.05;

  function $(id) { return (typeof document === 'undefined') ? null : document.getElementById(id); }
  function say(msg, bad) { if (typeof setStatus === 'function') setStatus(msg, !!bad); }

  /* Armed only by the checkbox being present AND set. Asked by app-join.js on
     every Seat (support) click, so it must never throw. */
  function armed() {
    var el = $(FLAG_ID);
    return !!(el && el.checked && !el.disabled);
  }

  /* The typed gap in mm, or NaN when the field is missing, empty, not a
     number, or outside its own min/max. Never a silent fallback - the same
     contract readSeatGapInput() has for the slider. Snapped to the field's
     0.01 step so the placement asks for exactly the number that is shown. */
  function readGap() {
    var el = $(GAP_ID);
    if (!el) return NaN;
    if (String(el.value).trim() === '') return NaN;
    var v = Number(el.value);
    if (!isFinite(v)) return NaN;
    var lo = Number(el.min), hi = Number(el.max);
    if (isFinite(lo) && v < lo - 1e-9) return NaN;
    if (isFinite(hi) && v > hi + 1e-9) return NaN;
    return Math.round(v * 100) / 100;
  }

  /* How far B's world box stands outside A's, per horizontal axis. This is
     the quantity the corner-ray fit cannot cope with, so it is the quantity
     the status line names. Null when either box cannot be read. */
  function overhangOf(meshA, meshB) {
    if (typeof meshLocalBox3 !== 'function') return null;
    var ba = meshLocalBox3(meshA), bb = meshLocalBox3(meshB);
    if (!ba || !bb || !isFinite(ba.min.x) || !isFinite(bb.min.x)) return null;
    var x = Math.max(0, ba.min.x - bb.min.x, bb.max.x - ba.max.x);
    var z = Math.max(0, ba.min.z - bb.min.z, bb.max.z - ba.max.z);
    return { x: x, z: z, any: (x > OVERHANG_TOL || z > OVERHANG_TOL) };
  }

  /* What the corner-ray fit would say about this pose, asked with the fit's
     own helpers and moving nothing. Null on any failure, by the cutClearance
     rule: a finding that cannot be measured must not become a refusal.

     `off` is the fit's own offset convention for gap mode - the mating face
     lands `off` OUTSIDE the skin, so off = -gap - which is what
     NSO_seatStraddle is given inside NSO_seatFlushBitToHull. */
  function cornerRayVerdict(meshA, meshB, off) {
    try {
      if (typeof NSO_plugFrame !== 'function' || typeof NSO_nearestSkinHit !== 'function'
          || typeof NSO_outerFaceCorners !== 'function' || typeof NSO_seatRayOrigins !== 'function'
          || typeof meshToWorldSoup !== 'function' || typeof THREE === 'undefined') return null;
      meshA.updateWorldMatrix(true, false);
      meshB.updateWorldMatrix(true, false);
      var hull = meshToWorldSoup(meshA);
      if (!hull || !hull.length) return null;
      if (!meshA.geometry.boundingBox) meshA.geometry.computeBoundingBox();
      var hc = new THREE.Vector3();
      meshA.geometry.boundingBox.getCenter(hc);
      hc.applyMatrix4(meshA.matrixWorld);
      var fr = NSO_plugFrame(meshB, hc, hull);
      var origins = NSO_seatRayOrigins(NSO_outerFaceCorners(fr));
      var miss = 0;
      for (var i = 0; i < origins.length; i++) {
        if (!NSO_nearestSkinHit(hull, origins[i], fr.punch)) miss++;
      }
      var straddle = null;
      if (typeof NSO_seatStraddle === 'function') straddle = NSO_seatStraddle(hull, meshB, hc, off);
      return { miss: miss, rays: origins.length, straddle: straddle };
    } catch (e) {
      console.warn('[oversize washer] corner-ray probe skipped:', (e && e.message) ? e.message : e);
      return null;
    }
  }

  /* The ONE wording for what the corner-ray fit would have done, so this file
     cannot say it two ways. '' when the fit would have been happy - there is
     no finding then, and cutWarning() is silent in the same case. */
  function cornerRayWarning(v) {
    if (!v) return '';
    if (v.miss > 0) {
      return 'corner-ray fit would refuse here: ' + v.miss + ' of ' + v.rays +
             ' rays miss the target along the punch axis';
    }
    if (v.straddle) {
      return 'corner-ray fit would refuse here: the target face cuts through the washer, ' +
             v.straddle.proudBy.toFixed(2) + 'mm of it standing proud';
    }
    return '';
  }

  /* The point on A directly under B's box centre - where Center lock has just
     put B - found with the fit's own ray caster. Null when B's centre is not
     over A at all, which is a real condition and is reported rather than
     guessed around. */
  function aimPointUnderB(meshA, meshB) {
    if (typeof meshLocalBox3 !== 'function' || typeof meshToWorldSoup !== 'function'
        || typeof NSO_nearestSkinHit !== 'function' || typeof THREE === 'undefined') return null;
    var hull = meshToWorldSoup(meshA);
    if (!hull || !hull.length) return null;
    var ba = meshLocalBox3(meshA), bb = meshLocalBox3(meshB);
    if (!isFinite(ba.max.y) || !isFinite(bb.min.x)) return null;
    var cx = (bb.min.x + bb.max.x) / 2, cz = (bb.min.z + bb.max.z) / 2;
    /* start clear above A's top so the first hit going down is A's top
       surface, not a wall the origin happens to sit inside */
    var o = new THREE.Vector3(cx, ba.max.y + Math.max(1, ba.max.y - ba.min.y), cz);
    var hit = NSO_nearestSkinHit(hull, o, new THREE.Vector3(0, -1, 0));
    return hit ? [hit.x, hit.y, hit.z] : null;
  }

  function describeAsk(gap) {
    if (gap < 0) return 'air gap ' + Math.abs(gap).toFixed(2) + 'mm asked';
    if (gap > 0) return 'overlap ' + gap.toFixed(2) + 'mm asked';
    return 'touching, gap 0.00mm asked';
  }

  /* Seat (support) in oversized mode. Called only from seatSupportBitToHull,
     only while armed(), and it owns the status line from here. */
  function seat(placedA, placedB) {
    if (!placedA || !placedB || !placedA.mesh || !placedB.mesh) {
      say('Both pieces must be on the plate', true);
      return { ok: false, reason: 'no pair' };
    }
    if (typeof window.NSO_seatHereAt !== 'function') {
      say('Oversized washer mode needs app-seat-surface.js - nothing placed', true);
      return { ok: false, reason: 'no measured-clearance path' };
    }
    var gap = readGap();
    if (!isFinite(gap)) {
      say('Oversized washer gap is empty or out of range - nothing placed', true);
      return { ok: false, reason: 'no gap' };
    }

    placedA.mesh.updateWorldMatrix(true, false);
    placedB.mesh.updateWorldMatrix(true, false);

    /* measured on the pose the user built, before anything moves */
    var over = overhangOf(placedA.mesh, placedB.mesh);
    var verdict = cornerRayVerdict(placedA.mesh, placedB.mesh, -gap);

    var point = aimPointUnderB(placedA.mesh, placedB.mesh);
    if (!point) {
      say('Oversized washer mode: nothing of the target lies under the washer\'s centre' +
          ' - Center lock it onto A first, then place', true);
      return { ok: false, reason: 'centre not over A' };
    }

    /* The placement itself: the shipped measured-clearance seat, with
       center:false so the XZ Center lock set is carried through untouched. */
    var plan = window.NSO_seatHereAt(placedA, point, { gap: gap, center: false });
    if (!plan || !plan.ok) {
      /* Its own status already names why, and it left the piece alone. This
         mode relaxes the corner-ray fit's refusals, not the measurement's:
         a gap that cannot be measured cannot be placed at. */
      return plan || { ok: false, reason: 'placement refused' };
    }

    var measured = (plan.applied && isFinite(plan.applied.clearanceAfter))
      ? plan.applied.clearanceAfter : NaN;

    var msg = 'Oversized washer placed - ' + describeAsk(gap) + ', true minimum ' +
              (isFinite(measured) ? measured.toFixed(3) : '-') + 'mm';
    if (gap >= 0 && plan.contactOffset != null && isFinite(plan.offsetAlongNormal)) {
      msg += ' (' + (plan.contactOffset - plan.offsetAlongNormal).toFixed(3) + 'mm past first contact)';
    }
    if (over) {
      msg += ' - overhang ' + over.x.toFixed(2) + 'mm X / ' + over.z.toFixed(2) + 'mm Z';
    }
    var warn = cornerRayWarning(verdict);
    if (warn) msg += ' - ' + warn + ' - reported, not blocked';
    say(msg);
    plan.oversize = {
      gap: gap, measured: measured, overhang: over, cornerRays: verdict,
      warning: warn, status: msg
    };
    return plan;
  }

  /* The field is only meaningful while the checkbox is set; saying so on the
     status line once, when it is toggled, is cheaper than a tooltip nobody
     opens. Nothing else in the app is touched by the toggle. */
  function wire() {
    var flag = $(FLAG_ID);
    if (!flag || flag.dataset.nsoWired === '1') return;
    flag.dataset.nsoWired = '1';
    flag.addEventListener('change', function () {
      var g = readGap();
      say(flag.checked
        ? 'Oversized washer mode ON - Seat (support) places at the typed gap (' +
          (isFinite(g) ? g.toFixed(2) + ' mm' : 'not set') + '), measures the true minimum' +
          ' distance and reports the corner-ray verdict instead of refusing on it'
        : 'Oversized washer mode OFF - Seat (support) is the corner-ray seat again');
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }

  window.NSO_OversizeWasher = {
    armed: armed,
    readGap: readGap,
    overhangOf: overhangOf,
    cornerRayVerdict: cornerRayVerdict,
    cornerRayWarning: cornerRayWarning,
    aimPointUnderB: aimPointUnderB,
    seat: seat,
    OVERHANG_TOL: OVERHANG_TOL
  };
})();
