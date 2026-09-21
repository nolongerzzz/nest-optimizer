// ===================== Scale: resize a piece to a real dimension =====================
// Two ways to resize one piece, and the first is the one this file exists for:
//
//   Set size   pick an axis (or the longest bounding-box edge), type the mm you
//              want that dimension to end up, and the factor is solved for you.
//   Scale by   the plain multiplier, kept because it is the honest primitive the
//              first one is built on and a user sometimes just wants "half".
//
// Before this file the app had NO scale control of any kind - not a factor box,
// not a dimension box. A piece's size came from the file, and only Cut, Thicken,
// Solidify and the Finish bakes changed it. So "make this exactly 50 mm tall"
// had no answer at all; that is the gap, not "factor-only".
//
// SCOPE: UNIFORM scale only. "50 mm tall" on a part means the part at 50 mm, not
// a part squashed on one axis - non-uniform scale changes wall thicknesses,
// hole roundness and print orientation angles independently, and nothing
// downstream here (Cut's raw mapping, the packer's footprint, Soften's radius)
// expects that. One factor, all three axes. If a per-axis stretch is ever
// wanted it is a different feature with a different name.
//
// Everything in section 1 is headless: a flat Float32Array soup in, a new one
// out, no DOM, no Three.js, no app state.

/* =====================================================================
   1. Headless geometry

   The soup is rawTris: Z-up, 9 floats per triangle, exactly what Cut and
   Soften pass around. The DISPLAY axes a user reads off the size line are
   Y-up - zUpToYUp rotates -90 degrees about X - so the two disagree, and the
   mapping is fixed and small:

       display X  =  raw X          display Y (height)  =  raw Z
       display Z  = -raw Y

   Same mapping computeCenterOffsetFromRaw already encodes as {x: cx, y: cz,
   z: -cy}. A uniform scale commutes with that rotation, so a factor solved on
   the raw axis is the factor the display axis gets. The sign on display Z is
   irrelevant to a SPAN, which is what every dimension here is.
   ===================================================================== */

// Display-axis name -> index into the raw soup's triples.
var NSO_SCALE_AXIS_TO_RAW = { x: 0, y: 2, z: 1 };

// Guard rails. A factor outside this is a typo, not a resize: a 40 mm part at
// 1e4 is a 400 m part, and at 1e-4 it is 4 microns. Both are refusals, not
// results. The 0.1 mm floor is the same one addModel uses to call a loaded
// mesh empty, so a scale can never produce a piece the loader would reject.
var NSO_SCALE_MIN_FACTOR = 1e-4;
var NSO_SCALE_MAX_FACTOR = 1e4;
var NSO_SCALE_MIN_SPAN_MM = 0.1;

/* Axis-aligned bounds of a raw soup, in raw axes. */
function NSO_scaleRawBounds(soup) {
  var min = [Infinity, Infinity, Infinity];
  var max = [-Infinity, -Infinity, -Infinity];
  for (var i = 0; i < soup.length; i += 3) {
    for (var k = 0; k < 3; k++) {
      var v = soup[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!isFinite(min[0])) return null;
  return {
    min: min, max: max,
    span: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  };
}

/* The piece's display-axis spans {x, y, z}, read off a raw soup. */
function NSO_scaleDisplaySpan(soup) {
  var b = NSO_scaleRawBounds(soup);
  if (!b) return null;
  return { x: b.span[0], y: b.span[2], z: b.span[1] };
}

/* Uniform scale about the soup's own bounding-box centre.
 *
 * About the CENTRE, not the origin, and the reason is float32. The soup is a
 * Float32Array and stays one - a fixture on disk and the same fixture in the
 * browser are meant to be bit-identical. Scaling about a far-away origin would
 * push every coordinate through a larger exponent than it needs and spend
 * mantissa bits on the offset rather than on the shape. The display geometry is
 * re-centred downstream anyway (rawResultToDisplayGeometry calls geo.center()),
 * so the centre is free as well as the most accurate choice. */
function NSO_scaleRawTris(soup, factor) {
  var b = NSO_scaleRawBounds(soup);
  if (!b) return null;
  var out = new Float32Array(soup.length);
  var cx = b.center[0], cy = b.center[1], cz = b.center[2];
  for (var i = 0; i < soup.length; i += 3) {
    out[i]     = cx + (soup[i]     - cx) * factor;
    out[i + 1] = cy + (soup[i + 1] - cy) * factor;
    out[i + 2] = cz + (soup[i + 2] - cz) * factor;
  }
  return out;
}

/* Topology + degeneracy, measured at a quantisation the CALLER picks.
 *
 * This is the whole reason the gate below does not just call NSO_edgeStats.
 * That one welds on a fixed 1e-4 mm grid, which is right for a bake that leaves
 * the piece the same size and WRONG for one that does not: scale a mesh up by
 * 10 and two vertices that shared a grid cell no longer do, so a sound mesh
 * reads as newly open; scale it down and distinct vertices merge, so a torn one
 * reads as freshly healed. Neither is a fact about the mesh. Hand the after
 * mesh a grid divided by the factor and the two measurements are of the same
 * shape at the same relative tolerance, so a difference is a real difference.
 *
 * `areaEps` gets the same treatment - triangle area scales by factor squared,
 * so the caller scales the threshold rather than the answer drifting. */
function NSO_scaleTopoStats(soup, q, areaEps) {
  var n = (soup.length / 9) | 0;
  function key(o) {
    return Math.round(soup[o] * q) + '_' + Math.round(soup[o + 1] * q) + '_' + Math.round(soup[o + 2] * q);
  }
  var edges = new Map();
  var verts = new Map();
  var degen = 0;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    var k = [key(o), key(o + 3), key(o + 6)];
    for (var j = 0; j < 3; j++) verts.set(k[j], 1);
    var ux = soup[o + 3] - soup[o],     uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
    var vx = soup[o + 6] - soup[o],     vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (Math.sqrt(nx * nx + ny * ny + nz * nz) * 0.5 < areaEps) degen++;
    for (var e = 0; e < 3; e++) {
      var a = k[e], b2 = k[(e + 1) % 3];
      if (a === b2) continue;   // a zero-length edge is not a hole
      var ek = a < b2 ? (a + '|' + b2) : (b2 + '|' + a);
      edges.set(ek, (edges.get(ek) || 0) + 1);
    }
  }
  var open = 0, nm = 0;
  edges.forEach(function (c) { if (c === 1) open++; else if (c > 2) nm++; });
  return { tris: n, verts: verts.size, edges: edges.size, open: open, nm: nm, degen: degen };
}

/* Signed volume of a soup, by the divergence theorem. Scales by factor^3. */
function NSO_scaleVolume(soup) {
  var v = 0;
  for (var t = 0; t < soup.length; t += 9) {
    v += (soup[t]     * (soup[t + 4] * soup[t + 8] - soup[t + 5] * soup[t + 7])
        - soup[t + 1] * (soup[t + 3] * soup[t + 8] - soup[t + 5] * soup[t + 6])
        + soup[t + 2] * (soup[t + 3] * soup[t + 7] - soup[t + 4] * soup[t + 6]));
  }
  return v / 6;
}

// Grid the gate measures the BEFORE mesh on. 1e-4 mm, the same relative
// tolerance NSO_edgeStats uses, so a piece's numbers here match the ones the
// rest of the app quotes for it at its current size.
var NSO_SCALE_WELD_Q = 1e4;
var NSO_SCALE_AREA_EPS = 1e-12;   // matches tools/stl_watertight_check.py --degen

// How close to the requested millimetre the solver is asked to land, and how
// many corrections it may spend getting there. See NSO_scaleSolve.
var NSO_SCALE_TOL_MM = 1e-6;
var NSO_SCALE_MAX_PASSES = 4;

/* Solve the factor that puts `targetMm` on `axis`, then apply it.
 *
 * target / span is the factor in exact arithmetic. It is not the factor in
 * float32: the soup is a Float32Array, so every scaled coordinate is rounded to
 * 24 bits of mantissa, and the SPAN - a difference of two of those - lands a few
 * ULPs off the number asked for. On a 50 mm target that is around 4e-6 mm, far
 * under any printer's resolution, but "exactly 50 mm" is what the control says
 * so it is what it should deliver.
 *
 * So measure what float32 actually produced and correct: f *= target / measured.
 * Each pass re-derives from the ORIGINAL soup rather than re-scaling the last
 * result, so the rounding error does not compound - the pass count is a budget
 * for finding the best factor, not a chain of approximations. The best result
 * seen is the one returned, so the loop can never make a piece worse than the
 * single division would have.
 *
 * Measured, because a correction loop that never corrects anything is just
 * cost. Over 200,000 random (offset, extent, target) triples: 8,660 improved,
 * 0 worsened, 191,340 unchanged, best gain 2.3e-4 mm in two passes. The
 * unchanged majority is the easy case - a piece near the origin, where one
 * division already lands on the nearest float32 to the target and the leftover
 * error is |float32(target) - target|, irreducible by any factor. The 4% that
 * improve are meshes whose coordinates sit far from the origin, which is any
 * STL exported without recentring: both ends of the span then round on a much
 * coarser grid than the span itself and the first quotient misses by many
 * ULPs. tools/nso_wire_scale_test.js section 8b reproduces one.
 *
 * `axis` is a DISPLAY axis name ('x' | 'y' | 'z') or 'longest' for the longest
 * bounding-box edge, which is the "overall size" a user means when they do not
 * care which way the part is lying. */
function NSO_scaleSolve(soup, axis, targetMm) {
  var b = NSO_scaleRawBounds(soup);
  if (!b) return { ok: false, reason: 'piece has no measurable bounds' };

  var rawIdx;
  if (axis === 'longest') {
    rawIdx = 0;
    if (b.span[1] > b.span[rawIdx]) rawIdx = 1;
    if (b.span[2] > b.span[rawIdx]) rawIdx = 2;
  } else if (NSO_SCALE_AXIS_TO_RAW[axis] !== undefined) {
    rawIdx = NSO_SCALE_AXIS_TO_RAW[axis];
  } else {
    return { ok: false, reason: 'unknown axis "' + axis + '"' };
  }

  var span0 = b.span[rawIdx];
  if (!(span0 > 0)) {
    return { ok: false, reason: 'the piece is flat on that axis (span 0) - nothing to scale to' };
  }
  if (!isFinite(targetMm) || targetMm <= 0) {
    return { ok: false, reason: 'target must be a positive number of mm' };
  }

  var f = targetMm / span0;
  var best = null;
  for (var pass = 0; pass < NSO_SCALE_MAX_PASSES; pass++) {
    if (!isFinite(f) || f <= 0) break;
    var tris = NSO_scaleRawTris(soup, f);
    if (!tris) break;
    var got = NSO_scaleRawBounds(tris).span[rawIdx];
    var err = Math.abs(got - targetMm);
    if (!best || err < best.err) best = { factor: f, tris: tris, got: got, err: err, passes: pass + 1 };
    if (err <= NSO_SCALE_TOL_MM || !(got > 0)) break;
    f = f * (targetMm / got);
  }
  if (!best) return { ok: false, reason: 'could not solve a factor for that target' };
  return {
    ok: true, factor: best.factor, tris: best.tris,
    measuredMm: best.got, errMm: best.err, passes: best.passes,
    axis: axis, rawIdx: rawIdx, spanBeforeMm: span0
  };
}

/* The one gate. Uniform positive scale is a bijection on coordinates, so it
 * cannot change topology in exact arithmetic - the only thing that can go wrong
 * is float32 collapsing two distinct coordinates into one, or a triangle that
 * was merely thin becoming flat. Both show up as a change in these numbers when
 * the after mesh is measured at the scaled tolerance, and neither shows up in a
 * fixed-grid comparison, which is the trap this avoids. */
function NSO_scaleGate(before, after, factor) {
  var sBefore = NSO_scaleTopoStats(before, NSO_SCALE_WELD_Q, NSO_SCALE_AREA_EPS);
  var sAfter = NSO_scaleTopoStats(after, NSO_SCALE_WELD_Q / factor, NSO_SCALE_AREA_EPS * factor * factor);
  var bad = null;
  if (sAfter.tris !== sBefore.tris) bad = 'triangle count changed ' + sBefore.tris + '->' + sAfter.tris;
  else if (sAfter.verts !== sBefore.verts) bad = 'distinct vertices changed ' + sBefore.verts + '->' + sAfter.verts;
  else if (sAfter.edges !== sBefore.edges) bad = 'distinct edges changed ' + sBefore.edges + '->' + sAfter.edges;
  else if (sAfter.open !== sBefore.open) bad = 'open edges changed ' + sBefore.open + '->' + sAfter.open;
  else if (sAfter.nm !== sBefore.nm) bad = 'non-manifold edges changed ' + sBefore.nm + '->' + sAfter.nm;
  else if (sAfter.degen > sBefore.degen) bad = 'degenerate triangles rose ' + sBefore.degen + '->' + sAfter.degen;
  return { ok: !bad, reason: bad, before: sBefore, after: sAfter };
}

/* Headless end to end: soup + spec -> scaled soup, or a refusal with a reason.
 *
 * spec is either { axis, targetMm } or { factor }. Nothing here touches app
 * state, so the self-test and the button run the same code. */
function NSO_scaleSoup(soup, spec) {
  if (!soup || soup.length < 9 || soup.length % 9 !== 0) {
    return { ok: false, reason: 'not a triangle soup' };
  }
  spec = spec || {};
  var solved = null;
  var factor;
  if (spec.axis !== undefined && spec.axis !== null) {
    solved = NSO_scaleSolve(soup, spec.axis, +spec.targetMm);
    if (!solved.ok) return solved;
    factor = solved.factor;
  } else {
    factor = +spec.factor;
    if (!isFinite(factor) || factor <= 0) return { ok: false, reason: 'factor must be a positive number' };
  }

  if (factor < NSO_SCALE_MIN_FACTOR || factor > NSO_SCALE_MAX_FACTOR) {
    return { ok: false, reason: 'factor ' + factor.toPrecision(4) + ' is outside ' +
             NSO_SCALE_MIN_FACTOR + '..' + NSO_SCALE_MAX_FACTOR };
  }

  var spanBefore = NSO_scaleDisplaySpan(soup);
  var tris = solved ? solved.tris : NSO_scaleRawTris(soup, factor);
  if (!tris) return { ok: false, reason: 'piece has no measurable bounds' };
  var spanAfter = NSO_scaleDisplaySpan(tris);

  var smallest = Math.min(spanAfter.x, spanAfter.y, spanAfter.z);
  if (smallest < NSO_SCALE_MIN_SPAN_MM) {
    return { ok: false, reason: 'would leave the piece ' + smallest.toFixed(4) +
             ' mm on its shortest axis, under the ' + NSO_SCALE_MIN_SPAN_MM + ' mm floor' };
  }

  var gate = NSO_scaleGate(soup, tris, factor);
  if (!gate.ok) return { ok: false, reason: gate.reason, stats: gate };

  return {
    ok: true, tris: tris, factor: factor,
    before: { span: spanBefore, volume: NSO_scaleVolume(soup), stats: gate.before },
    after: { span: spanAfter, volume: NSO_scaleVolume(tris), stats: gate.after },
    axis: solved ? solved.axis : null,
    // The chosen axis's span before and after, in mm. Carried explicitly
    // because 'longest' is not a fixed axis - reading it back off
    // before.span would have to re-decide which edge was longest.
    spanBeforeMm: solved ? solved.spanBeforeMm : null,
    targetMm: solved ? +spec.targetMm : null,
    measuredMm: solved ? solved.measuredMm : null,
    errMm: solved ? solved.errMm : null,
    passes: solved ? solved.passes : 0
  };
}

/* =====================================================================
   2. App wiring

   The house lifecycle, same as Smooth, Skin and Carve: refuse before you
   touch anything, then hand the new soup to NSO_sculptCommitRaw, which
   writes the undo entry, rebuilds the display geometry and re-seats the
   placed instance. The undo type is 'scaleReplace'; its row lives in
   UNDO_REPLACE_LABEL in app-core.js.
   ===================================================================== */

/* Which display axis the control is asking about, as a label. */
function NSO_scaleAxisLabel(axis) {
  if (axis === 'x') return 'X';
  if (axis === 'y') return 'height';
  if (axis === 'z') return 'Z';
  return 'longest edge';
}

/* Scale the selected piece. spec is { axis, targetMm } or { factor }.
 * Returns the result object so the console and the drive check can read the
 * before/after numbers rather than parsing the status line. */
function NSO_scaleSelectedModel(spec) {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  if (!m) {
    if (typeof setStatus === 'function') setStatus('Select a piece first', true);
    return { ok: false, reason: 'no selection' };
  }
  var soup = (m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null;
  if (!soup) {
    if (typeof setStatus === 'function') setStatus('Scale needs a raw piece - unchanged', true);
    return { ok: false, reason: 'no rawTris' };
  }

  // Standing rule: a painted face stays untouched by ANY bake.
  //
  // PAINT SCOPE: WHOLE-PIECE. A uniform scale moves every vertex on the piece
  // and there is no sub-region to scope the check to, so by the scoping rule
  // in docs/HANDOFF.md any painted face stands the whole operation down - the
  // same answer Smooth gives, for the same reason. The roster row is in that
  // file's scoping table and in tools/nso_paint_scope_test.js.
  //
  // Worth stating why this is not merely inherited: a mask entry is a plane
  // {n, d}, and under a uniform scale about the bbox centre the normal is
  // unchanged while d moves, so the paint COULD in principle be carried
  // through by rescaling d. That is a second mapping from a plane back to a
  // face - exactly the re-derivation the standing rule forbids - and it would
  // have to agree with app-mask.js's own recorded axis and side. Until the
  // mask stores something scale-invariant, refusing is the honest answer and
  // the user clears the paint, scales, and repaints on a piece whose planes
  // are the ones app-mask.js actually recorded.
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    if (typeof setStatus === 'function') {
      setStatus('Scale stood down - ' + painted + ' painted face(s); a uniform scale moves ' +
                'every vertex and cannot hold a face still. Clear paint to scale.', true);
    }
    return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
  }

  var r = NSO_scaleSoup(soup, spec);
  if (!r.ok) {
    if (typeof setStatus === 'function') setStatus('Scale refused - piece unchanged (' + r.reason + ')', true);
    return r;
  }

  var txt;
  if (r.axis) {
    txt = 'Scale done - ' + NSO_scaleAxisLabel(r.axis) + ' ' +
      r.before.span[r.axis === 'longest' ? 'x' : r.axis].toFixed(3) + ' → ' +
      r.measuredMm.toFixed(3) + ' mm (asked ' + r.targetMm + ', off by ' +
      r.errMm.toExponential(1) + ' mm), factor ' + r.factor.toFixed(6);
  } else {
    txt = 'Scale done - factor ' + r.factor.toFixed(6);
  }
  txt += ', size ' + r.after.span.x.toFixed(2) + ' x ' + r.after.span.y.toFixed(2) +
         ' x ' + r.after.span.z.toFixed(2) + ' mm, open ' + r.after.stats.open +
         ', nm ' + r.after.stats.nm;

  if (typeof NSO_sculptCommitRaw === 'function') {
    if (!NSO_sculptCommitRaw(m, r.tris, 'scaleReplace', txt)) {
      if (typeof setStatus === 'function') setStatus('Scale failed to commit - piece unchanged', true);
      return { ok: false, reason: 'commit failed' };
    }
  }
  if (typeof nsoScaleRefresh === 'function') nsoScaleRefresh();
  return r;
}

/* ---------------------------------------------------------------------------
   UI. Self-wired here rather than in a shared button block, so adding a tool
   does not touch a fat file. Guarded on `document`.

   The readout is the point of the card: it names the piece's current size on
   every axis, so "50 mm tall" is typed against a number the user can see
   rather than against a guess.
--------------------------------------------------------------------------- */
if (typeof document !== 'undefined') {
  (function wireScaleCard() {
    function readout() {
      var el = document.getElementById('scale-readout');
      if (!el) return;
      var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
      if (!m || !m.size) { el.textContent = 'Select a piece to resize.'; return; }
      var longest = Math.max(m.size.x, m.size.y, m.size.z);
      el.textContent = m.size.x.toFixed(2) + ' x ' + m.size.y.toFixed(2) + ' x ' +
        m.size.z.toFixed(2) + ' mm (X x H x Z), longest ' + longest.toFixed(2) + ' mm';
    }
    window.nsoScaleRefresh = readout;

    function run(spec) {
      try {
        NSO_scaleSelectedModel(spec);
      } catch (err) {
        console.error('[scale]', err);
        if (typeof setStatus === 'function') {
          setStatus('Scale failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
        }
      }
      readout();
    }

    function wire() {
      var dim = document.getElementById('btn-scale-dim');
      if (dim && dim.dataset.nsoWired !== '1') {
        dim.dataset.nsoWired = '1';
        dim.addEventListener('click', function () {
          var axis = (document.getElementById('scale-axis') || {}).value || 'longest';
          var target = parseFloat((document.getElementById('scale-target') || {}).value);
          run({ axis: axis, targetMm: target });
        });
      }
      var fac = document.getElementById('btn-scale-factor');
      if (fac && fac.dataset.nsoWired !== '1') {
        fac.dataset.nsoWired = '1';
        fac.addEventListener('click', function () {
          var f = parseFloat((document.getElementById('scale-factor') || {}).value);
          run({ factor: f });
        });
      }
      readout();
    }

    // The readout has to follow the selection, and the app already has one
    // place that means "the selected piece's size line is stale":
    // updateEditSize, which every selection change, bake and undo calls. Wrap
    // it once rather than adding a second notification path that can fall out
    // of step with the first. app-cut.js has already run by the time this
    // file is parsed, so the binding exists to wrap.
    if (typeof window.updateEditSize === 'function' && !window.updateEditSize._nsoScaleWrapped) {
      var inner = window.updateEditSize;
      var wrapped = function () { var r = inner.apply(this, arguments); readout(); return r; };
      wrapped._nsoScaleWrapped = true;
      window.updateEditSize = wrapped;
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
    setTimeout(wire, 0);
  })();
}
