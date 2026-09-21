// ===================== Fatten: cross-section only =====================
//
// Fatten grows or shrinks the CROSS-SECTION of an axis-aligned, straight
// piece and leaves its LENGTH alone. A 20 mm pin whose 3 mm shaft is 0.4 mm
// too slim for its hole becomes a 20 mm pin with a 3.8 mm shaft - not a
// 20.8 mm pin, which is what a whole-surface offset gives you and what
// Scale-to-size gives you in all three axes at once.
//
// WHAT THIS FILE IS, stated up front: it is a WRAPPER. There is no offset
// maths in it, and there must never be any. Two shipped, tested pieces do all
// of the work and are called, not copied:
//
//   NSO_extendDetectAxis   (app-extend.js)  which way is this piece straight?
//   _thickenOffsetSoup     (app-finish.js)  move this side of the skin by d
//
// Fatten is the sentence that joins them: detect the axis, mark the faces
// PARALLEL to it, and hand that mark to Thicken as the set it may move. The
// faces that are not parallel - the end caps, the end chamfers - stay behind
// as held planes, and holding them is exactly what holds the length. Growing
// is Thicken's offset with a positive d; shrinking is the same call with a
// negative one, which its maths has always supported (only the button's own
// "type a positive number" gate did not, and that gate now asks the caller).
//
// The whole of the addition Thicken needed for this is a `mayMove` face
// filter, documented on _thickenOffsetSoup. It is strictly a narrowing: a
// face still has to be on the asked side first, and with the filter absent
// Thicken behaves and reads out exactly as it did before Fatten existed.
// If you are here to add a second offset path, stop - the bug is somewhere
// else.
//
// SCOPE - deliberately identical to Extend's, because it is Extend's axis
// detector that decides. Everything Extend refuses, Fatten refuses, in the
// same words and for the same reason:
//
//   1. AXIS-ALIGNED ONLY. X, Y or Z. An off-cardinal piece is refused by
//      name, not silently offset along a tilted cross-section.
//   2. STRAIGHT SECTIONS ONLY. A cone, a wedge, a blob, a bent tube: there
//      is no one direction the surface is swept along, so "the cross-section"
//      is not a thing that exists to grow.
//   3. NO DOMINANT AXIS is a refusal too. A 20 mm cube is straight three
//      ways and cannot tell you which one you meant; pass opts.axis.
//   4. THE OUTER SIDE. Fatten moves the outside of the piece, which is what
//      "the cross-section grows" means. A bore or a slot is Thicken in's job
//      and is not wrapped here.
//   5. RAW PIECES ONLY, as Extend requires, so that the face filter and the
//      offset are computed over the same triangles in the same order.
//
// SAFETY: Fatten adds no gate of its own beyond the length promise below. It
// inherits, by construction rather than by copy, every gate Thicken already
// respects - the face-inversion refusal (an offset bigger than the feature it
// grows into, which for a shrink is the wall it eats), the piercing
// self-intersection count, the nozzle-square pocket floor, and the paint
// stand-down. Note what that does NOT include: Thicken does not consult
// NSO_Thickness.floorFor, so neither does Fatten. Wiring a printability floor
// into an offset belongs in Thicken, once, where both tools would get it -
// putting one here would be the fork this file exists to avoid.
//
// PAINT SCOPE: WHOLE-PIECE. Per the scoping rule in docs/HANDOFF.md, the
// question is whether the feature acts on an identifiable sub-region. It does
// not: every face parallel to the axis moves, and the rim vertices those faces
// share with the held caps move with them, so no face on the piece can be
// promised untouched. Any paint anywhere stands the whole bake down, naming
// the count. nsoMaskCount(m) is the whole test, exactly as for Thicken, whose
// own check then runs again underneath as a backstop.

/* =====================================================================
   1. Which faces are the cross-section

   A face may move iff its normal is perpendicular to the axis, |n.u| ~ 0 -
   the same "this surface is swept along u" test Extend's census is built on,
   and answered with the same per-triangle tolerance, NSO_extendTriTol. That
   tolerance is relative on purpose: the identical flat wall reads |n.u|
   3.4e-9 at the origin and 2.8e-6 at a +1400 mm offset, so a fixed constant
   is either too tight far out or too loose near in. See the derivation in
   app-extend.js section 1.

   Everything else is HELD, and each kind of held face earns its keep:

     end caps (|n x u| ~ 0)   hold the length. This is the whole mechanism.
     end chamfers (oblique)   hold their own PLANE, which is not the same as
                              holding their size. The ring where a chamfer
                              meets the shaft slides ALONG the chamfer as the
                              shaft moves, so the angle and the position
                              survive and the width follows: pin.stl grown
                              0.5 mm takes its 0.1 mm chamfer to 0.6 mm, with
                              the end face itself untouched. That is the only
                              answer available while both the end face and the
                              chamfer plane stay put, and it is the right one -
                              a whole-surface Thicken eats the chamfer instead.
                              It is also asymmetric: growing slides the ring
                              into the shaft and is free, shrinking slides it
                              toward the END and is bounded by the chamfer's
                              own width, past which the inversion gate refuses.
                              Measured both ways in tools/nso_fatten_test.js.
     slivers with no usable normal
                              held, and counted in the status line rather than
                              waved through on an enormous tolerance. Thicken
                              already drops sub-THICKEN_VOTE_AREA faces from
                              the vertex solve, so a held sliver only pins a
                              vertex when it is big enough to be a real face -
                              in which case holding it is the right answer.
   ===================================================================== */

// Returns { mayMove, move, hold, untrusted, worstAlong } - mayMove is the
// Uint8Array _thickenOffsetSoup takes, one entry per input triangle.
function NSO_fattenCrossSectionFaces(rawTris, axisIdx, opts) {
  opts = opts || {};
  var n = (rawTris.length / 9) | 0;
  var mayMove = new Uint8Array(n);
  var move = 0, hold = 0, untrusted = 0, worstAlong = 0;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    var ux = rawTris[o + 3] - rawTris[o], uy = rawTris[o + 4] - rawTris[o + 1], uz = rawTris[o + 5] - rawTris[o + 2];
    var vx = rawTris[o + 6] - rawTris[o], vy = rawTris[o + 7] - rawTris[o + 1], vz = rawTris[o + 8] - rawTris[o + 2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(L > 0)) { hold++; continue; }            // degenerate: no normal, no move
    var tol = NSO_extendTriTol(rawTris, o, axisIdx, opts.perpK, opts.maxPerpTol);
    if (!tol.trusted) { untrusted++; hold++; continue; }
    var along = Math.abs([nx, ny, nz][axisIdx]) / L;
    if (along <= tol.perp) {
      mayMove[t] = 1; move++;
      if (along > worstAlong) worstAlong = along;
    } else hold++;
  }
  return { mayMove: mayMove, move: move, hold: hold, untrusted: untrusted, worstAlong: worstAlong };
}

/* =====================================================================
   2. The length promise, measured on the result

   Extend holds its cross-section bit for bit and can, because it writes one
   coordinate and copies the other two. Fatten cannot make the mirror-image
   promise that cheaply: a vertex shared between a moving wall and a held cap
   is placed by Thicken's plane solve, which satisfies the cap's n.p' = n.p in
   float64 and then stores a float32 - so its axial coordinate lands within a
   rounding of where it started, not on it.

   So the promise is stated in the unit that is actually available: the axial
   extent after the bake differs from the extent before by at most
   FATTEN_LENGTH_ULPS float32 ULPs at the coordinate magnitude in play. Not a
   millimetre figure, for Extend's reason (app-extend.js section 1a): one ULP
   is 1.9e-6 mm at 20 mm and 1.2e-4 mm at 1500 mm, and no constant passes both.
   Measured, off the output buffer, before anything is committed - a refusal
   here leaves the piece untouched and pushes no undo.

   In practice it is exact: the measured residual is 0, not merely small, on
   every fixture in tools/nso_fatten_test.js - and by two different routes,
   both worth knowing.

     pin.stl      its end caps are bounded by held chamfers, so the extreme
                  vertices touch no moving face at all and Thicken copies them
                  through verbatim.
     a cylinder   its cap rim IS the moving wall's rim, so those vertices are
                  solved - and the held cap plane pins the axial component to
                  zero, which survives the float32 store on the value it
                  started from.

   The allowance is there for the case where the second route rounds rather
   than landing, which no fixture has yet produced.
   ===================================================================== */

var FATTEN_LENGTH_ULPS = 8;

function NSO_fattenLengthGate(axisIdx, ulps) {
  var allow = (ulps == null) ? FATTEN_LENGTH_ULPS : +ulps;
  return function (soupIn, working) {
    var a = NSO_extendLengthToReach(soupIn, axisIdx, 0);
    var b = NSO_extendLengthToReach(working, axisIdx, 0);
    var drift = b.current - a.current;
    var tol = allow * NSO_extendUlp32(Math.max(Math.abs(b.min), Math.abs(b.max)));
    if (Math.abs(drift) > tol) {
      return 'the length moved - ' + 'xyz'[axisIdx].toUpperCase() + ' extent ' +
        a.current.toFixed(6) + ' \u2192 ' + b.current.toFixed(6) + ' mm, off by ' +
        drift.toExponential(3) + ' mm against an allowance of ' + tol.toExponential(3) +
        ' mm (' + allow + ' float32 ULPs)';
    }
    return null;
  };
}

/* =====================================================================
   3. The wrapper

   Detect, mark, delegate. Every refusal below is either Extend's detector
   speaking or Thicken's gates speaking; Fatten's own contribution is the
   length gate and the words "grow" and "shrink".
   ===================================================================== */

// dir   'grow' | 'shrink'
// mm    how much, positive, in millimetres of offset (so a round shaft's
//       DIAMETER changes by 2 x mm - the number is a surface offset, which is
//       the same number the Thicken box holds and means the same thing)
// opts  passed through to NSO_extendDetectAxis (opts.axis forces the axis)
//       and to NSO_fattenCrossSectionFaces; opts.lengthUlps tunes the gate
function NSO_fattenSelectedModel(dir, mm, opts) {
  opts = opts || {};
  var grow = (dir !== 'shrink');
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  if (!m) {
    if (typeof setStatus === 'function') setStatus('Select a piece first', true);
    return { ok: false, reason: 'no selection' };
  }
  if (!(mm > 0)) {
    if (typeof setStatus === 'function') setStatus('Fatten failed - enter a positive mm value', true);
    return { ok: false, reason: 'bad mm' };
  }
  // Raw only, for Extend's reason: the face filter is indexed by triangle, so
  // the detector and the offset have to be looking at the same soup in the
  // same order. Requiring rawTris here also guarantees thickenSelectedModel
  // takes its raw path below rather than rebuilding a soup from the display
  // geometry.
  var soupIn = (m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null;
  if (!soupIn) {
    if (typeof setStatus === 'function') setStatus('Fatten needs a raw piece - unchanged', true);
    return { ok: false, reason: 'no rawTris' };
  }
  var paintedCount = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (paintedCount > 0) {
    if (typeof setStatus === 'function') {
      setStatus('Fatten stood down - ' + paintedCount + ' painted face(s); every face parallel to the ' +
                'axis moves, and the rims it shares with the held caps move with it. Clear paint to fatten.', true);
    }
    return { ok: false, reason: 'painted faces: ' + paintedCount, painted: paintedCount };
  }

  var det = NSO_extendDetectAxis(soupIn, opts);
  if (!det.ok) {
    if (typeof setStatus === 'function') setStatus('Fatten refused - ' + det.reason, true);
    return { ok: false, reason: det.reason, detect: det };
  }
  var k = det.axisIdx;
  var faces = NSO_fattenCrossSectionFaces(soupIn, k, opts);
  if (faces.move === 0) {
    var why = 'no face is parallel to ' + det.axis.toUpperCase() +
      ' - there is no cross-section wall to move (' + faces.hold + ' face(s) held, ' +
      faces.untrusted + ' with no usable normal)';
    if (typeof setStatus === 'function') setStatus('Fatten refused - ' + why, true);
    return { ok: false, reason: why, detect: det, faces: faces };
  }

  var r = thickenSelectedModel('out', grow ? +mm : -mm, {
    mayMove: faces.mayMove,
    signed: true,
    gate: NSO_fattenLengthGate(k, opts.lengthUlps),
    label: 'Fatten',
    modeLabel: grow ? 'grow' : 'shrink',
    mmLabel: mm,                          // the direction is already in the word
    sideWord: 'cross-section',
    undoType: 'fattenReplace',
    note: function () {
      return '; ' + det.axis.toUpperCase() + ' length held' +
        (faces.untrusted ? ', ' + faces.untrusted + ' sliver(s) with no usable normal held' : '');
    }
  });
  if (r) { r.detect = det; r.faces = faces; r.axis = det.axis; r.axisIdx = k; }
  return r || { ok: false, reason: 'Thicken returned nothing' };
}

/* ---------------------------------------------------------------------------
   4. UI entry point. Two buttons and the mm box they share.

   Blank box: like Extend's, the first click reports what the piece actually is
   - detected axis and the cross-section extents across it - and fills the box
   with a starting figure, so the user edits a real number instead of guessing
   which way the tool thinks the piece points.
--------------------------------------------------------------------------- */
if (typeof document !== 'undefined') {
  (function wireFattenButtons() {
    function readBox() {
      var inp = document.getElementById('inp-fatten-mm');
      var v = inp ? parseFloat(inp.value) : NaN;
      return (isFinite(v) && v > 0) ? v : NaN;
    }
    function describe() {
      var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
      var soup = (m && m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null;
      if (!soup) {
        if (typeof setStatus === 'function') setStatus('Select a raw piece first', true);
        return;
      }
      var det = NSO_extendDetectAxis(soup, {});
      if (!det.ok) {
        if (typeof setStatus === 'function') setStatus('Fatten refused - ' + det.reason, true);
        return;
      }
      var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (var i = 0; i < soup.length; i += 3) {
        for (var c = 0; c < 3; c++) {
          var v = soup[i + c];
          if (v < lo[c]) lo[c] = v;
          if (v > hi[c]) hi[c] = v;
        }
      }
      var across = [0, 1, 2].filter(function (c) { return c !== det.axisIdx; })
        .map(function (c) { return 'xyz'[c].toUpperCase() + ' ' + (hi[c] - lo[c]).toFixed(2); }).join(', ');
      var inp = document.getElementById('inp-fatten-mm');
      if (inp) inp.value = '0.5';
      if (typeof setStatus === 'function') {
        setStatus('Fatten: this piece runs along ' + det.axis.toUpperCase() + ' (' +
          (hi[det.axisIdx] - lo[det.axisIdx]).toFixed(2) + ' mm, held). Cross-section ' + across +
          ' mm. Set an offset and press Fatten or Shrink.');
      }
    }
    function run(dir) {
      try {
        var mm = readBox();
        if (!(mm > 0)) { describe(); return; }
        NSO_fattenSelectedModel(dir, mm);
      } catch (err) {
        console.error('[fatten]', err);
        if (typeof setStatus === 'function') {
          setStatus('Fatten failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
        }
      }
    }
    function wire() {
      var pairs = [['btn-fatten-grow', 'grow'], ['btn-fatten-shrink', 'shrink']];
      for (var i = 0; i < pairs.length; i++) {
        var btn = document.getElementById(pairs[i][0]);
        if (!btn || btn.dataset.nsoWired === '1') continue;
        btn.dataset.nsoWired = '1';
        btn.addEventListener('click', (function (d) { return function () { run(d); }; })(pairs[i][1]));
      }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
