/* Triple join — A-B-C in one press, as two ordinary junctions back to back.
 *
 * WHAT THIS IS NOT. It is not a new way to place pieces. Every millimetre it
 * moves is moved by Center lock (app-center-lock.js) and Seat (support)
 * (seatBitAtGap in app-join.js), called exactly as their own buttons call
 * them. There is no positioning math in this file: it picks the pieces, it
 * picks the gap, and it decides WHEN each primitive runs. That is the whole
 * of it, and it is deliberate - the seat's corner-ray fit and the lock's
 * exactness are pinned by suites that know nothing about this file, and they
 * go on being the same code with the same pins.
 *
 * WHY IT EXISTS. A three-piece stack was already possible by hand: pick A and
 * B, Center lock, Seat, then re-pick B and C and do it again. Two things went
 * wrong every time. The re-pick is easy to get backwards (C onto B is not B
 * onto C), and the gap slider is ONE slider - so the second seam silently
 * inherited whatever the first seam was set to. A test coupon with a real
 * 0.18 mm release gap at one seam and a solid weld at the other could not be
 * built in one pass at all; you set the slider, seated, moved the slider,
 * re-picked, seated again, and hoped you had not mixed them up.
 *
 * So: three slots, two gaps, one press. Each junction carries its own gap
 * across the whole of the slider's range - air gap, touching, or overlap -
 * and the two are independent by construction, because they are two separate
 * numbers read from two separate inputs and handed to two separate calls.
 *
 * THE TWO MODES differ in ONE step: which rough placement runs before the
 * seat.
 *
 *   Vertical stack   - Center lock exactly as its button runs it: the mover's
 *                      reference point onto the host's, in X AND Z. The mover
 *                      lands over the host, NSO_raiseBuriedBitClear lifts it
 *                      clear of the host's top, and the seat punches down.
 *                      This is the stacking path tools/nso_seat_side_test.js
 *                      section 11 pins.
 *
 *   Horizontal run   - the same Center lock reference points (its exported
 *                      refPointXZ, honouring the same bbox/centroid selector)
 *                      with the delta applied on the CROSS axis only. The
 *                      axis the two pieces are separated along is left alone,
 *                      so they stay side by side and the seat punches
 *                      sideways - the path tools/nso_seat_side_test.js pins
 *                      for a pair. Which axis is which is the same question
 *                      Center X / Center Z already answer (centerJoinAxis's
 *                      punchIsX): the run axis is the one with the larger
 *                      separation, and centring ON it is what would pull the
 *                      mover into the host.
 *
 * The seat still chooses its own punch axis from the pose it is handed, as it
 * always has. The mode chooses the pose; it does not overrule the seat.
 *
 * WHY CHAINING IS SAFE. Junction two seats C onto B, and seatBitAtGap starts
 * by calling settlePlacedOnBed on its host. B is at that moment floating on
 * top of A. It does not fall: the seat that put it there wrote
 * placedB.liftY = boxBottom - 0.2, and settlePlacedOnBed puts the box bottom
 * back on 0.2 + liftY. The settle is idempotent on a seated piece, so
 * junction one's gap survives junction two untouched - pinned directly in
 * tools/nso_join_triple_test.js rather than left as an argument.
 *
 * UNDO. Four entries, the same four a hand-run pair of junctions leaves:
 * lock, seat, lock, seat. Nothing here collapses them, so backing out of a
 * triple join is the same gesture as backing out of the steps it replaces.
 */
(function () {
  'use strict';

  var MODE_VERTICAL = 'vertical';
  var MODE_HORIZONTAL = 'horizontal';

  function el(id) { return document.getElementById(id); }

  function getMode() {
    var sel = el('triple-mode');
    return (sel && sel.value === MODE_HORIZONTAL) ? MODE_HORIZONTAL : MODE_VERTICAL;
  }

  /* The Center lock reference selector, read the same way Center lock reads
     it, so the triple locks on whatever the card is set to rather than on a
     second opinion of its own. */
  function refMode() {
    var sel = el('center-lock-ref');
    var CL = window.NSO_CenterLock;
    return (sel && CL && sel.value === CL.REF_CENTROID) ? CL.REF_CENTROID : (CL ? CL.REF_BBOX : 'bbox');
  }

  function placedOf(sourceId) {
    if (sourceId == null) return null;
    return state.placed.find(function (p) { return p && p.sourceId === sourceId && p.mesh; }) || null;
  }

  /* Three distinct pieces, all on the plate, inside a live Join. Same
     precondition shape the card's other pair tools use, one slot wider. */
  function trio() {
    var a = state.editId, b = state.joinPartnerId, c = state.joinThirdId;
    if (!state.joinSession) return null;
    if (a == null || b == null || c == null) return null;
    if (a === b || b === c || a === c) return null;
    var pa = placedOf(a), pb = placedOf(b), pc = placedOf(c);
    if (!pa || !pb || !pc) return null;
    return { ids: [a, b, c], placed: [pa, pb, pc] };
  }

  /* ---- the gaps ---- */

  /* readSeatGapInput's rules, on whichever input is asked for: NaN when the
     input is missing or its value is outside its own declared range, and the
     value snapped to the 0.01 step so the seat is asked for exactly the
     number the readout shows. Sharing the reader is the point - two gap
     inputs that disagreed with the slider about what -0.18 means would be a
     bug nobody would look for here. */
  function readGap(id) {
    return (typeof readSeatGapInput === 'function') ? readSeatGapInput(id) : NaN;
  }

  function fmtGap(v) {
    return (typeof NSO_formatSeatGap === 'function') ? NSO_formatSeatGap(v) : String(v);
  }

  /* What a gap means in words - the same three cases seatBitAtGap prints. */
  function gapWord(g) {
    if (g < 0) return 'air gap ' + Math.abs(g).toFixed(2) + 'mm';
    if (g > 0) return 'overlap ' + g.toFixed(2) + 'mm';
    return 'touching';
  }

  function syncGapReadouts() {
    if (typeof updateSeatGapReadout === 'function') {
      updateSeatGapReadout('triple-gap-ab', 'triple-gap-ab-value');
      updateSeatGapReadout('triple-gap-bc', 'triple-gap-bc-value');
    }
  }

  /* ---- rough placement: Center lock, per mode ---- */

  /* Vertical: the shipped button, unchanged. It reads the pair off
     state.editId / state.joinPartnerId, which the caller has just set, and
     it honours a target picked on the host exactly as it does by hand. */
  function roughLockVertical() {
    var CL = window.NSO_CenterLock;
    if (!CL) return { ok: false, reason: 'Center lock is not loaded' };
    if (CL.run()) return { ok: true };
    return { ok: false, reason: (CL.lastError && CL.lastError()) || 'center lock refused' };
  }

  /* Horizontal: Center lock's own reference points, its delta applied on the
     cross axis only. Nothing is computed here that Center lock does not
     already compute - the mode only decides which of the two components of
     its delta is applied. */
  function roughLockHorizontal(host, mover) {
    var CL = window.NSO_CenterLock;
    if (!CL) return { ok: false, reason: 'Center lock is not loaded' };
    host.mesh.updateMatrixWorld(true);
    mover.mesh.updateMatrixWorld(true);
    var m = refMode();
    var target = CL.refPointXZ(host.mesh, m);
    var ref = CL.refPointXZ(mover.mesh, m);
    if (!target || !ref) {
      return { ok: false, reason: 'no centroid for this pair - try Bounding-box centre' };
    }
    var dx = target.x - ref.x;
    var dz = target.z - ref.z;
    /* No separation at all means there is no run axis to keep: the two are
       already stacked one over the other, and centring either way would only
       confirm it. Say so rather than quietly seating a vertical stack under
       a label that says horizontal. */
    if (!(Math.abs(dx) > 1e-9 || Math.abs(dz) > 1e-9)) {
      return {
        ok: false,
        reason: 'the two pieces sit on the same spot - slide them apart first, '
              + 'or use Vertical stack'
      };
    }
    var runIsX = Math.abs(dx) >= Math.abs(dz);
    var nx = mover.x + (runIsX ? 0 : dx);
    var nz = mover.z + (runIsX ? dz : 0);
    pushUndo(snapshotPlacedPose(state.placed.indexOf(mover)));
    applyPlacedXZ(mover, nx, nz);
    return { ok: true, runAxis: runIsX ? 'x' : 'z' };
  }

  /* ---- one junction: rough placement, then Seat (support) at its own gap ---- */

  function junction(hostId, moverId, gap, mode) {
    // The primitives read the pair off the card's own slots, so the slots
    // ARE the argument. Set them, run, and the caller puts them back.
    state.editId = hostId;
    state.joinPartnerId = moverId;
    var host = placedOf(hostId), mover = placedOf(moverId);
    if (!host || !mover) return { ok: false, reason: 'both pieces must be on the plate' };

    var lock = (mode === MODE_HORIZONTAL)
      ? roughLockHorizontal(host, mover)
      : roughLockVertical();
    if (!lock.ok) return lock;

    var seat = seatBitAtGap(host, mover, gap);
    if (!seat || !seat.ok) {
      return { ok: false, reason: (seat && seat.reason) || 'seat refused' };
    }
    return { ok: true, seat: seat, runAxis: lock.runAxis };
  }

  /* ---- the sequence ---- */

  function run() {
    var t = trio();
    if (!t) {
      setStatus('Start Join, then pick three different pieces A, B and C', true);
      return false;
    }
    var gapAB = readGap('triple-gap-ab');
    var gapBC = readGap('triple-gap-bc');
    if (!isFinite(gapAB) || !isFinite(gapBC)) {
      setStatus('A junction gap is missing or out of range - nothing joined', true);
      return false;
    }
    var mode = getMode();
    var keepA = state.editId, keepB = state.joinPartnerId;
    var restore = function () {
      state.editId = keepA;
      state.joinPartnerId = keepB;
      renderModelList();
      updateEditSize();
      updateJoinUI();
    };

    var r1 = junction(t.ids[0], t.ids[1], gapAB, mode);
    if (!r1.ok) {
      restore();
      setStatus('Triple join stopped at A-B, nothing else moved - ' + r1.reason, true);
      return false;
    }
    var r2 = junction(t.ids[1], t.ids[2], gapBC, mode);
    if (!r2.ok) {
      restore();
      // A-B really is seated and really is still there; saying so is the
      // difference between "undo twice" and "undo four times".
      setStatus('Triple join stopped at B-C - ' + r2.reason
        + ' - A-B is seated at ' + gapWord(gapAB) + ' and was left alone', true);
      return false;
    }
    restore();
    var how = (mode === MODE_HORIZONTAL) ? 'in a row' : 'stacked';
    setStatus('Joined A-B-C ' + how
      + ' - A-B ' + gapWord(gapAB) + ' (measured ' + r1.seat.measured.toFixed(3) + 'mm)'
      + ', B-C ' + gapWord(gapBC) + ' (measured ' + r2.seat.measured.toFixed(3) + 'mm)');
    return true;
  }

  /* ---- UI ---- */

  function syncUI() {
    var ready = !!trio();
    var btn = el('btn-join-triple');
    if (btn) btn.disabled = !ready;
    var box = el('triple-join');
    if (box) box.classList.toggle('triple-ready', ready);
    syncGapReadouts();
  }

  function bind() {
    var slotC = el('join-slot-c');
    if (slotC) slotC.addEventListener('click', function () { armJoinSlot('c'); });
    var btn = el('btn-join-triple');
    if (btn) btn.addEventListener('click', function () { run(); });
    ['triple-gap-ab', 'triple-gap-bc'].forEach(function (id) {
      var input = el(id);
      if (!input) return;
      input.addEventListener('input', syncGapReadouts);
      input.addEventListener('change', syncGapReadouts);
    });
    var mode = el('triple-mode');
    if (mode) mode.addEventListener('change', syncUI);
    syncUI();
  }

  window.NSO_TripleJoin = {
    run: run,
    syncUI: syncUI,
    trio: trio,
    readGap: readGap,
    getMode: getMode,
    MODE_VERTICAL: MODE_VERTICAL,
    MODE_HORIZONTAL: MODE_HORIZONTAL
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
