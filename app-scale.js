// ===================== Scale: resize a piece to a real dimension =====================
// The uniform-scale primitives, and the Scale card that reads the piece first:
//
//   Whole x    the plain multiplier, the honest primitive everything else here
//              is built on; a user sometimes just wants "half".
//   Longest    type the mm the longest bounding-box edge should end up, and the
//              factor is solved for you (NSO_scaleSolve, which still takes a
//              single display axis underneath - the card no longer offers one;
//              see the UI section at the bottom for why).
//   Fit to plate  the largest uniform factor that fits the current machine.
//
// The card's first line and its Length verb come from nso_section.js and
// app-extend.js; a capsule's, sphere's, ellipsoid's or torus's rows come from
// nso_shapes.js. Nothing in this file fits a shape itself.
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
   1b. Offset - Fatten and Shrink, folded into one number

   The outside moves by `mm` (positive grows, negative shrinks) and the wall
   is KEPT: every inner face moves the same way as the outer face across the
   wall from it. A ring's bore moves with its outside; a tray's inner walls
   and floor top follow its outer walls and bottom, so every wall and floor
   comes out the thickness it went in. On a solid with no inner faces it is
   the plain even offset.

   NOT A SECOND OFFSET. The geometry is Thicken's own vertex solve,
   _thickenOffsetSoup (app-finish.js), with its outer / inner classification
   (the faces on the convex hull, and the smooth creases that lead to them,
   are outer; everything else is inner) and its new `wallKept` mode. What this
   adds is the two refusals the brief names, each one measured on the result:

     the bore closing   an inner face turned inside out - the bore or pocket
                        had less room than the offset took from it
     the floor          a section of the result measures under
                        NSO_Thickness.floorFor(nozzle) (0.42 mm at 0.4) where
                        the piece did not already - or a solid section went
                        through zero, which is the same limit reached harder

   and Thicken's own piercing check (NSO_Repair.inspect), so the moved faces
   cannot cross the piece.
   ===================================================================== */

/* A small width: two decimals, three under 0.1 mm. */
function NSO_scaleFmtSmall(x) { return x < 0.1 ? x.toFixed(3) : x.toFixed(2); }

/* opts.nozzle      default NSO_Thickness.NOZZLE_DEFAULT (0.4)
   opts.innerWord   what the inner faces are called in a refusal - 'bore' on a
                    ring, 'pocket' on a tray; default 'bore or pocket' */
function NSO_scaleOffsetRaw(soup, mm, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '', limit: null, tris: soup, mm: +mm };
  if (!soup || soup.length < 9 || soup.length % 9 !== 0) { res.reason = 'not a triangle soup'; return res; }
  mm = +mm;
  if (!isFinite(mm) || mm === 0) {
    res.reason = 'enter an offset in mm - positive grows the outside, negative shrinks it';
    return res;
  }
  if (typeof _thickenOffsetSoup !== 'function') {
    res.reason = 'app-finish.js must be loaded - the offset is Thicken\'s own vertex solve';
    return res;
  }
  var T = (typeof NSO_Thickness !== 'undefined') ? NSO_Thickness : null;
  var nozzle = (opts.nozzle > 0) ? +opts.nozzle : (T ? T.NOZZLE_DEFAULT : 0.4);
  var floor = T ? T.floorFor(nozzle) : null;
  res.floorMm = floor;
  var amt = Math.abs(mm).toFixed(2).replace(/\.?0+$/, '');
  var innerWord = opts.innerWord || 'bore or pocket';
  var b0 = NSO_scaleRawBounds(soup);

  // The floor, on the piece's own three extents first. Each one is two faces
  // on the hull moving apart (or together) by the offset, so its new size is
  // known before anything moves - and a solid section going through zero
  // folds every face along it flat, which the inversion count below does not
  // see (a face folded to zero area has no direction left to have turned).
  if (floor != null && mm < 0) {
    var kMin = 0;
    for (var k = 1; k < 3; k++) if (b0.span[k] < b0.span[kMin]) kMin = k;
    var want = b0.span[kMin] + 2 * mm;
    if (want < floor) {
      res.limit = 'floor';
      res.reason = 'its ' + 'XYZ'[kMin] + ' size of ' + b0.span[kMin].toFixed(2) + ' mm would ' +
        (want > 0 ? 'drop to ' + want.toFixed(2) + ' mm' : 'go through zero') + ', under the ' +
        floor.toFixed(2) + ' mm floor for a ' + nozzle + ' mm nozzle - the most it can shrink is ' +
        Math.max(0, Math.floor((b0.span[kMin] - floor) / 2 * 100) / 100).toFixed(2) + ' mm';
      return res;
    }
  }

  var r;
  try { r = _thickenOffsetSoup(soup, 'out', mm, { wallKept: true }); }
  catch (err) { r = { reason: (err && err.message) || String(err) }; }
  if (!r || !r.soup) {
    // The extents were checked above, so a face that turns now is a feature
    // running out of room: any inner one is the bore or pocket closing (its
    // cap rims turn with it - the tube's annulus folds once its bore has
    // crossed the axis); only outer ones is a feature on the outside.
    if (r && r.flippedInner > 0) {
      res.limit = 'bore';
      res.reason = 'the ' + innerWord + ' would close - ' + amt + ' mm is more than the room inside it (' +
        r.flippedInner + ' inner face(s) would turn inside out)';
      res.flipped = r.flipped; res.flippedInner = r.flippedInner;
    } else if (r && r.flipped > 0) {
      // Thicken's own inversion gate, reached on the outside: a chamfer, a
      // fillet strip or a rib narrower than the shrink. Neither a bore nor
      // the floor, so it is named as what it is.
      res.limit = 'feature';
      res.reason = amt + ' mm is more than a feature on the outside has room for - ' + (r.flipped - r.flippedInner) +
        ' outer face(s) would turn inside out' +
        (isFinite(r.flippedMinWidth) ? ', the narrowest ' + NSO_scaleFmtSmall(r.flippedMinWidth) + ' mm across' : '');
    } else res.reason = (r && r.reason) || 'the offset produced nothing';
    return res;
  }
  var out = r.soup;

  if (T && typeof T.measureMesh === 'function') {
    var after = T.measureMesh(out, { nozzle: nozzle });
    res.thinAfter = after;
    if (!after.pass && after.min_mm != null) {
      var before = T.measureMesh(soup, { nozzle: nozzle });
      res.thinBefore = before;
      // Thinner than the floor, and thinner than it was: the offset did that.
      // A piece already under the floor that the offset leaves no thinner is
      // not this tool's refusal to make.
      if (!(before.min_mm != null && after.min_mm >= before.min_mm - 1e-4)) {
        res.limit = 'floor';
        res.reason = 'a section would drop to ' + after.min_mm.toFixed(2) + ' mm, under the ' +
          floor.toFixed(2) + ' mm floor for a ' + nozzle + ' mm nozzle';
        return res;
      }
    }
  }

  if (typeof NSO_Repair !== 'undefined' && NSO_Repair && typeof NSO_Repair.inspect === 'function') {
    var pb = NSO_Repair.inspect(soup).selfIntersections, pa = NSO_Repair.inspect(out).selfIntersections;
    if (pa > pb) {
      res.limit = 'pierce';
      res.reason = 'the moved faces would cross the piece (piercing pairs ' + pb + ' -> ' + pa + ')';
      return res;
    }
  }

  var t0 = NSO_scaleTopoStats(soup, NSO_SCALE_WELD_Q, NSO_SCALE_AREA_EPS);
  var t1 = NSO_scaleTopoStats(out, NSO_SCALE_WELD_Q, NSO_SCALE_AREA_EPS);
  if (t1.degen > t0.degen || t1.open > t0.open || t1.nm > t0.nm) {
    res.limit = 'floor';
    res.reason = 'a section would fold flat (degenerate faces ' + t0.degen + ' -> ' + t1.degen + ', open edges ' +
      t0.open + ' -> ' + t1.open + ')';
    return res;
  }

  var b1 = NSO_scaleRawBounds(out);
  res.ok = true; res.tris = out;
  res.spanBefore = b0.span; res.spanAfter = b1.span;
  res.moved = r.moved; res.approx = r.approx;
  res.outerFaces = 0; res.innerFaces = 0;
  for (var f = 0; f < r.outer.length; f++) { if (r.outer[f]) res.outerFaces++; else res.innerFaces++; }
  return res;
}

/* =====================================================================
   1c. Units at the card's edge - mm or inches

   Everything above, and every engine the card calls, works in millimetres
   and only ever will. The card's mm | in toggle converts at the edge and
   nowhere else: what the card shows (its readout, its boxes, their labels
   and limits, the messages its verbs say) and what the person types. Typing
   1 with inches shown hands the engine exactly 1 * 25.4 mm. Switching the
   toggle moves no vertex.

   Inches show to 3 decimal places. A number the person typed is echoed as
   typed (NSO_scaleTyped), never cut to 3 places.

   Engine reasons arrive as finished mm sentences ("under the 0.42 mm floor
   for a 0.4 mm nozzle"), so NSO_scaleText rewrites their figures rather than
   each engine learning about inches. It converts a number, or a run of them
   joined by × / → / of / slash, that ends in "mm"; a bare Ø figure, which
   is always a length; and "number of mm" / "in mm" / "many mm". A length
   an engine prints with no unit and no Ø is invisible to it - the card's
   own lines are therefore composed unit by unit (NSO_scaleLen) instead.
   ===================================================================== */

var NSO_SCALE_MM_PER_IN = 25.4;
var NSO_SCALE_UNIT_KEY = 'nso.scale.unit';
var NSO_scaleUnitNow = 'mm';

function NSO_scaleIn() { return NSO_scaleUnitNow === 'in'; }

/* What the person typed, in the unit shown, as millimetres for the engine. */
function NSO_scaleToMm(v) { v = +v; return NSO_scaleIn() ? v * NSO_SCALE_MM_PER_IN : v; }

/* A length for display, without its unit: inches to 3 places, or the mm
   text exactly as the caller has always written it (`mmFmt` is a digit
   count or a function). */
function NSO_scaleLen(mm, mmFmt) {
  if (NSO_scaleIn()) return (+mm / NSO_SCALE_MM_PER_IN).toFixed(3);
  return typeof mmFmt === 'function' ? mmFmt(mm) : (+mm).toFixed(mmFmt == null ? 2 : mmFmt);
}

/* ' mm' or ' in', for the end of a figure. */
function NSO_scaleU() { return NSO_scaleIn() ? ' in' : ' mm'; }

/* A value the person typed, echoed back in inches: at least 3 places and as
   many more as they typed (the mm round trip's float noise trimmed at 12
   significant figures). */
function NSO_scaleTyped(mm) {
  var v = +(+mm / NSO_SCALE_MM_PER_IN).toPrecision(12), s = String(v);
  var dot = s.indexOf('.');
  return (dot < 0 || s.length - dot - 1 < 3) && !/e/i.test(s) ? v.toFixed(3) : s;
}

var NSO_SCALE_NUM = '-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?';
var NSO_SCALE_TEXT_RE = new RegExp(
  '(Ø?' + NSO_SCALE_NUM + '(?:(?:\\s*(?:×|x|→|->|/)\\s*|\\s+of(?:\\s+its)?\\s+)Ø?' + NSO_SCALE_NUM + ')*)\\s?mm\\b' +
  '|Ø(' + NSO_SCALE_NUM + ')' +
  '|\\b(number of|in|many) mm\\b', 'g');

/* One mm figure as an inch figure. An exponent stays an exponent - those
   are residuals ("off by 1.2e-6 mm"), and 3 places would read them as 0. */
function NSO_scaleTextNum(n) {
  var v = parseFloat(n) / NSO_SCALE_MM_PER_IN;
  var e = /^-?\d+(?:\.(\d+))?e/i.exec(n);
  return e ? v.toExponential(Math.max(1, (e[1] || '').length)) : v.toFixed(3);
}

/* An engine's mm sentence in the unit shown. The identity with mm shown. */
function NSO_scaleText(str) {
  if (!NSO_scaleIn() || str == null) return str;
  var num = new RegExp(NSO_SCALE_NUM, 'g');
  return String(str).replace(NSO_SCALE_TEXT_RE, function (all, chain, dia, words) {
    if (chain) return chain.replace(num, NSO_scaleTextNum) + ' in';
    if (dia) return 'Ø' + NSO_scaleTextNum(dia);
    return words + ' inches';
  });
}

/* A box's limit or step in inches. The step goes to the next 1 / 2 / 5 at
   or above the exact conversion (0.1 mm -> 0.005 in); each limit is moved
   inward onto that step's grid, because a number box steps from its min -
   min 0.004 with step 0.005 would make the arrows land on 1.004, not 1. */
function NSO_scaleInchStep(stepMm) {
  var x = stepMm / NSO_SCALE_MM_PER_IN, p = Math.pow(10, Math.floor(Math.log10(x)));
  var m = [1, 2, 5, 10].find(function (k) { return k * p >= x * (1 - 1e-9); });
  return +(m * p).toPrecision(6);
}
function NSO_scaleInchLimit(mm, step, side) {
  var k = mm / NSO_SCALE_MM_PER_IN / step;
  k = side === 'min' ? Math.ceil(k - 1e-9) : Math.floor(k + 1e-9);
  return +(k * step).toPrecision(9);
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

/* What a done uniform scale says after "Scale done - ". Composed figure by
   figure in the unit the card shows (1c); with mm shown it is the line this
   has always said. The before figure is the solver's own span
   (spanBeforeMm): for Longest it is the edge the factor was solved on,
   whichever axis that is. */
function NSO_scaleDescribe(r) {
  var L = NSO_scaleLen, u = NSO_scaleU(), inch = NSO_scaleIn();
  var txt;
  if (r.axis) {
    txt = NSO_scaleAxisLabel(r.axis) + ' ' +
      L(r.spanBeforeMm, 3) + ' → ' +
      L(r.measuredMm, 3) + u + ' (asked ' + (inch ? NSO_scaleTyped(r.targetMm) + u : r.targetMm) + ', off by ' +
      (inch ? r.errMm / NSO_SCALE_MM_PER_IN : r.errMm).toExponential(1) + u + '), factor ' + r.factor.toFixed(6);
  } else {
    txt = 'factor ' + r.factor.toFixed(6);
  }
  return txt + ', size ' + L(r.after.span.x, 2) + ' x ' + L(r.after.span.y, 2) +
         ' x ' + L(r.after.span.z, 2) + u + ', open ' + r.after.stats.open +
         ', nm ' + r.after.stats.nm;
}

/* A uniform scale as a card verb (see NSO_scaleCardTry). spec is
   { axis, targetMm } or { factor }. */
function NSO_scaleUniformVerb(spec) {
  return {
    label: 'Scale', undoType: 'scaleReplace',
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
    paint: 'a uniform scale moves every vertex and cannot hold a face still. Clear paint to scale.',
    run: function (soup) { return NSO_scaleSoup(soup, spec); },
    describe: NSO_scaleDescribe
  };
}

/* Scale the selected piece. spec is { axis, targetMm } or { factor }.
 * Returns the result object so the console and the drive check can read the
 * before/after numbers rather than parsing the status line. */
function NSO_scaleSelectedModel(spec) {
  return NSO_scaleCardApply(NSO_scaleUniformVerb(spec));
}

/* ---------------------------------------------------------------------------
   UI. Self-wired here rather than in a shared button block, so adding a tool
   does not touch a fat file. Guarded on `document`.

   THE CARD READS THE SHAPE FIRST. Its first line is nso_section.js's reading
   in print terms - Ring / Rod / Bar with the numbers a person measures, or the
   three sizes and, in plain words, the gate that decided the piece is neither
   and what still applies - with the build-volume verdict appended. Under it,
   one compact row per field (label | field | unit or hold), and only the rows
   nso_section.js's NSO_sectionVerbs says apply:

     Length / Width / Height   the piece's own axes as it lies - Height its Z,
                       Length the longer of its X and Y, Width the shorter;
                       never the plate's. Each one is Extend / Shorten along
                       that axis (NSO_extendRaw with the axis forced), so the
                       material goes in or comes out inside one clean
                       constant-section band and every wall, floor, hole,
                       pocket and lip keeps its size. An axis with no such band
                       gets no row. A ring or rod shows its one axis under
                       the same names - Height when the axis is its Z - and
                       its readout, holds and done lines say the same word.
     Outer Ø / Bore Ø / Wall
                       a ring (nso_ring.js), for pipe work: each moves ONE face
                       and the done line reports the other two. Outer Ø the
                       outside (bore kept), Bore Ø the bore (outer kept), Wall
                       the bore by thickness (outer kept); the length is held
                       by all three. Outer Ø's old move - the bore with it,
                       wall kept - is Offset's, which a ring does not show
                       (it moves the ends too); Outer Ø then Bore Ø does it.
     Diameter          a rod.
     Offset            Fatten and Shrink, folded in: the outside moves by the
                       mm entered and the inner faces follow (NSO_scaleOffsetRaw
                       above). Shown on every piece but a ring or rod, where Outer Ø,
                       Bore Ø / Diameter and Length do its job. The sentence
                       under it says what wall kept means for a thin feature:
                       lid_strap's 0.6 mm strap stays 0.6 mm.
     Shape rows        a capsule's Length and Diameter, a sphere's or
                       ellipsoid's A, B and C, a torus's Ring Ø and Tube Ø
                       (nso_shapes.js) - a Stock piece by its tag, anything
                       else by its vertices. They replace Length / Width /
                       Height, the ring rows and Offset; each changes one thing.
     Whole x           today's uniform factor. Reset to 1 on every selection,
                       bake and pose change.
     Longest           today's longest-edge target, prefilled with the longest
                       edge. Hidden when a named field shows the same number.
     Fit to plate      the largest uniform factor that fits the machine.

   Every field shows nso_section.js's one display precision (NSO_sectionShow)
   and repopulates whenever the selection, the piece's soup or its pose on the
   plate changes, whoever changed it.

   THE FIELDS ARE LIVE - there is no Set. Typing applies (debounced
   NSO_SCALE_LIVE_MS): the verb runs on the piece as it was when the edit
   began, and the viewport, the readout and the other fields follow. Leaving
   the field (blur, Tab, Enter) commits it: one Undo step for the whole edit,
   however many values were typed on the way. Escape puts back the value the
   field had when the edit began, and the piece with it. A value the piece
   refuses says why under the field, in red, while it is typed; the piece
   stays at the last good value, and leaving the field on it commits nothing.
   Fit to plate stays a button.
--------------------------------------------------------------------------- */

/* The section reading for a piece, cached on its soup: a bake replaces
   rawTris with a new array, so the cache can never serve a stale shape, and
   a selection change or a size-line refresh costs nothing. */
var NSO_scaleSectionCache = (typeof WeakMap === 'function') ? new WeakMap() : null;
function NSO_scaleSectionOf(m) {
  var raw = (m && m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null;
  if (!raw || typeof NSO_sectionRead !== 'function') return null;
  var soup = NSO_scaleSpaceOf(m, raw).f;
  if (NSO_scaleSectionCache && NSO_scaleSectionCache.has(soup)) return NSO_scaleSectionCache.get(soup);
  var s = NSO_scaleAsItLies(NSO_sectionRead(soup), soup, NSO_scaleBodyRows(m, raw));
  if (NSO_scaleSectionCache) NSO_scaleSectionCache.set(soup, s);
  return s;
}

/* How many of Length / Width / Height the piece had as it was LOADED - its
   soup turned back by the turns baked into it since (bakedQ, app-core.js).
   A piece the pose verbs never turned reads as it is. */
var NSO_scaleBodyCache = (typeof WeakMap === 'function') ? new WeakMap() : null;
function NSO_scaleBodyRows(m, raw) {
  if (NSO_scaleBodyCache && NSO_scaleBodyCache.has(raw)) return NSO_scaleBodyCache.get(raw);
  var p = (m && typeof state !== 'undefined' && state.placed)
    ? state.placed.find(function (q) { return q && q.sourceId === m.id; }) : null;
  var soup = raw;
  if (p && p.bakedQ && typeof THREE !== 'undefined' && typeof nsoRawTurnRows === 'function') {
    var bq = new THREE.Quaternion(p.bakedQ[0], p.bakedQ[1], p.bakedQ[2], p.bakedQ[3]);
    if (Math.abs(Math.abs(bq.w) - 1) > 1e-12) soup = nsoTurnRaw(raw, nsoRawTurnRows(bq.invert()));
  }
  var r = (soup === raw) ? NSO_sectionRead(raw) : NSO_sectionRead(soup);
  var v = r && r.verbs, n = v ? ['length', 'width', 'height'].filter(function (k) { return v[k]; }).length : 0;
  if (r && r.shape === 'round') n = 0;
  if (NSO_scaleBodyCache) NSO_scaleBodyCache.set(raw, n);
  return n;
}

/* THE PIECE'S FRAME. Length, Width and Height are the piece's as it LIES:
   Length and Width along the level long and short sides of its footprint,
   Height the plate vertical - pieceFrame (nso-bounds.js), the one frame every
   tool reads. Every pose action is baked into the geometry when it ends
   (app-core.js nsoBakePlacedPose), so the raw soup's own axes say nothing
   about how a turned piece lies. The card reads and runs every verb on the
   soup turned about the vertical to put the footprint's long side on raw X
   (`f`); each result is turned back before it is committed (`toRaw`). A
   piece whose long side is on a raw axis already (a quarter turn is) is its
   own frame: f is its soup, bit for bit.

   HELD for the soup: the turn is worked out once per soup, when the card
   first reads it - while that soup is the piece's - and kept, so a live edit,
   which runs every keystroke on the soup it began from, keeps the frame it
   began with however the edit reshapes the piece. */
var NSO_scaleSpaceCache = (typeof WeakMap === 'function') ? new WeakMap() : null;
function NSO_scaleSpaceOf(m, raw) {
  raw = raw || (m ? m.rawTris : null);
  var same = { f: raw, toRaw: function (t) { return t; } };
  if (!raw) return same;
  if (NSO_scaleSpaceCache && NSO_scaleSpaceCache.has(raw)) return NSO_scaleSpaceCache.get(raw);
  var space = same;
  var p = (m && typeof state !== 'undefined' && state.placed)
    ? state.placed.find(function (q) { return q && q.sourceId === m.id && q.mesh; }) : null;
  if (p && raw === m.rawTris && typeof THREE !== 'undefined' && typeof nsoBounds !== 'undefined' &&
      nsoBounds.pieceFrame && typeof nsoRawTurnRows === 'function') {
    var fr = nsoBounds.pieceFrame(p);
    if (fr) {
      /* the soup as it lies: first the turn its mesh carries (none once a pose
         is baked; a pose a non-verb wrote onto the record otherwise), then
         about the vertical to put the footprint's long side on X */
      p.mesh.updateMatrixWorld(true);
      var phi = Math.atan2(-fr.long.z, fr.long.x);              // the long side's heading on the plate
      phi -= Math.round(phi / (Math.PI / 2)) * (Math.PI / 2);   // a quarter turn is a raw axis already
      var mq = p.mesh.quaternion.clone(), turned = Math.abs(Math.abs(mq.w) - 1) > 1e-12;
      if (Math.abs(phi) >= 1e-6 || turned) {
        var q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -phi).multiply(mq);
        var Ri = nsoRawTurnRows(q.clone().invert());
        space = { f: nsoTurnRaw(raw, nsoRawTurnRows(q)), toRaw: function (t) { return nsoTurnRaw(t, Ri); } };
      }
    }
  }
  if (NSO_scaleSpaceCache) NSO_scaleSpaceCache.set(raw, space);
  return space;
}

/* A turn keeps the rows. Where the section reader finds a straight run along
   a frame axis the row is that run's (Extend / Shorten, as ever). A piece
   turned off its own axes - leaned, most often - has no straight run along a
   level line any more, and would lose rows it had as it was loaded; when it
   reads fewer of Length / Width / Height as it lies than it did then
   (`bodyRows`), every missing one is the piece's extent along that frame axis,
   and typing a value STRETCHES it there, every point scaled about the middle
   along that one axis. A piece that had no straight run to begin with (a cone,
   a blob) is not given one; rings, rods and the recognised shapes keep their
   own rows. */
function NSO_scaleAsItLies(s, soup, bodyRows) {
  if (!s || !s.verbs || s.shape === 'round' || typeof NSO_sectionAxisWord !== 'function') return s;
  var v = s.verbs, b = NSO_scaleRawBounds(soup);
  var have = ['length', 'width', 'height'].filter(function (k) { return v[k]; }).length;
  if (!b || have === 3 || !(bodyRows > have)) return s;
  var out = {}, k;
  for (k in s) out[k] = s[k];
  var nv = {};
  for (k in v) nv[k] = Array.isArray(v[k]) ? v[k].slice() : v[k];
  [0, 1, 2].forEach(function (i) {
    var word = NSO_sectionAxisWord(s, i);
    if (nv[word]) return;
    nv[word] = { axisIdx: i, axis: 'xyz'.charAt(i), mm: b.span[i], stretch: true };
  });
  nv.named = ['length', 'width', 'height'].filter(function (n) { return nv[n]; });
  if (v.outer || v.diameter) nv.named.push(v.outer ? 'outer' : 'diameter');
  if (v.bore) nv.named.push('bore');
  if (v.wall) nv.named.push('wall');
  var longest = Math.max(b.span[0], b.span[1], b.span[2]);
  nv.longest = !['length', 'width', 'height'].some(function (n) {
    return NSO_sectionShow(nv[n].mm) === NSO_sectionShow(longest);
  });
  nv.longestMm = longest;
  out.verbs = nv;
  var stretched = ['length', 'width', 'height'].filter(function (n) { return nv[n].stretch; });
  out.reason = (s.why || s.reason) + ', so ' + stretched.map(function (n) { return n; }).join(', ') +
    (stretched.length > 1 ? ' stretch' : ' stretches') + ' as it lies' + (nv.offset ? ', an even offset' : '') +
    ' and whole-piece scaling apply';
  return out;
}

/* Stretch along raw axis k of `soup` to `targetMm`: every point scaled about
   the box's middle along k alone, solved to the target the way a uniform scale
   is (Float32, a few passes), and gated the way it is - at the weld grid and
   area of the smaller of 1 and the factor, so a stretch that only spreads
   points apart is not read as tearing and one that squeezes them is. */
function NSO_scaleStretchRaw(soup, k, targetMm) {
  var b = NSO_scaleRawBounds(soup);
  if (!b) return { ok: false, reason: 'piece has no measurable bounds' };
  var span0 = b.span[k];
  if (!(span0 > 0)) return { ok: false, reason: 'the piece is flat that way (span 0) - nothing to stretch' };
  if (!isFinite(targetMm) || targetMm <= 0) return { ok: false, reason: 'must be a positive number of mm' };
  if (targetMm < NSO_SCALE_MIN_SPAN_MM) {
    return { ok: false, reason: 'would leave the piece ' + targetMm + ' mm that way, under the ' + NSO_SCALE_MIN_SPAN_MM + ' mm floor' };
  }
  var c = b.center[k], f = targetMm / span0, best = null;
  for (var pass = 0; pass < NSO_SCALE_MAX_PASSES; pass++) {
    if (!isFinite(f) || f <= 0) break;
    var out = new Float32Array(soup);
    for (var i = k; i < out.length; i += 3) out[i] = c + (soup[i] - c) * f;
    var got = NSO_scaleRawBounds(out).span[k], err = Math.abs(got - targetMm);
    if (!best || err < best.err) best = { f: f, tris: out, got: got, err: err };
    if (err <= NSO_SCALE_TOL_MM || !(got > 0)) break;
    f = f * (targetMm / got);
  }
  if (!best) return { ok: false, reason: 'could not solve a stretch for that size' };
  if (best.f < NSO_SCALE_MIN_FACTOR || best.f > NSO_SCALE_MAX_FACTOR) {
    return { ok: false, reason: 'a stretch of ' + best.f.toPrecision(4) + ' is outside ' + NSO_SCALE_MIN_FACTOR + '..' + NSO_SCALE_MAX_FACTOR };
  }
  var gate = NSO_scaleGate(soup, best.tris, Math.min(1, best.f));
  if (!gate.ok) return { ok: false, reason: gate.reason, stats: gate };
  return { ok: true, tris: best.tris, stretch: true, factor: best.f, axisIdx: k,
           lengthBefore: span0, lengthAfter: best.got, errMm: best.err };
}

/* A capsule, sphere / ellipsoid or torus (nso_shapes.js), or null. A Stock
   piece's tag answers at once; anything else is recognised off its vertices,
   along the section reader's axis where it has one, and tagged so the next
   read is free. A piece that is none of them is remembered as none, on its
   soup, so a selection or pose change does not fit it again. */
var NSO_scaleNotShape = (typeof WeakMap === 'function') ? new WeakMap() : null;
function NSO_scaleShapeOf(m) {
  var raw = (m && m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null;
  if (!raw || typeof NSO_shapeRead !== 'function') return null;
  var soup = NSO_scaleSpaceOf(m, raw).f;
  var tag = NSO_shapeTagOf(soup);
  if (tag) return tag;
  if (NSO_scaleNotShape && NSO_scaleNotShape.has(soup)) return null;
  var p = NSO_shapeRead(soup, NSO_scaleSectionOf(m));
  if (!p && NSO_scaleNotShape) NSO_scaleNotShape.set(soup, true);
  return p;
}

/* The bed's three directions as words. W / D / H on this card are a bar's
   section sides, so the build-volume verdict does not reuse the letters. */
var NSO_SCALE_FIT_WORD = { x: 'wide', y: 'deep', z: 'tall' };
var NSO_SCALE_FIT_NOUN = { x: 'width', y: 'depth', z: 'height' };

/* The build-volume verdict for one piece, in print terms: the same report the
   plate's own warning reads - "5.0 mm too wide for A1 Mini". */
function NSO_scaleFitVerdict(m) {
  if (!m || typeof NSO_fitCheckAll !== 'function') return '';
  var all = NSO_fitCheckAll();
  if (!all) return '';
  var rep = null;
  for (var i = 0; i < all.pieces.length; i++) if (all.pieces[i].modelId === m.id) rep = all.pieces[i];
  if (!rep) return '';
  var name = String(rep.printer_name || '').replace(/^(Bambu|Creality) /, '');
  if (rep.fits) return 'fits ' + name;
  return rep.over.map(function (o) {
    return NSO_scaleLen(o.over_mm, 1) + NSO_scaleU() + ' too ' + NSO_SCALE_FIT_WORD[o.axis];
  }).join(', ') + ' for ' + name;
}

/* The card's first line, readout and verdict. Returned as well as rendered
   so the drive check reads the same string the user does. */
function NSO_scaleReadoutText(m) {
  if (!m || !m.size) return 'Select a piece to resize.';
  var sh = NSO_scaleShapeOf(m);
  var s = sh ? null : NSO_scaleSectionOf(m);
  // With inches shown every figure goes through the card's unit edge (1c);
  // with mm shown both hooks are left unset and the line is unchanged.
  var inch = NSO_scaleIn();
  var show = inch ? function (x) { return NSO_scaleLen(x); } : null;
  var line = sh ? NSO_shapeReadout(sh, function (x) { return NSO_scaleLen(x, NSO_sectionShow); })
    : s ? NSO_sectionReadout(s, show, inch ? NSO_scaleText : null)
    : (NSO_scaleLen(m.size.x, 1) + ' × ' + NSO_scaleLen(m.size.z, 1) + ' × ' + NSO_scaleLen(m.size.y, 1) + ' W × D × H');
  var fit = NSO_scaleFitVerdict(m);
  return fit ? line + ' · ' + fit : line;
}

/* Fit to plate: the largest uniform factor that fits the current machine.
   The factor is min(limit / size) over the bed's three axes, read off the
   same report NSO_fitCheckAll gives the plate warning, so "fits" here and
   "fits" there are one rule (nso_printer.js's fit, its 1e-4 mm slack, no bed
   margin). A uniform factor is the same in every frame, so it applies to the
   raw soup unchanged. Already fits: say so, change nothing. */
function NSO_scaleFitToPlate() {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  if (!m || !m.size) {
    if (typeof setStatus === 'function') setStatus('Select a piece first', true);
    return { ok: false, reason: 'no selection' };
  }
  var printer = (typeof NSO_fitCurrentPrinter === 'function') ? NSO_fitCurrentPrinter() : null;
  if (!printer || typeof NSO_Printer === 'undefined') {
    if (typeof setStatus === 'function') setStatus('Fit to plate needs the printer profiles - unchanged', true);
    return { ok: false, reason: 'no printer' };
  }
  var size = NSO_Printer.fromDisplaySize(m.size);
  var rep = NSO_Printer.fit(size, printer);
  var name = String(printer.name || '').replace(/^(Bambu|Creality) /, '');
  // Bare figures with mm shown, as always; each one carries "in" with inches
  // shown, since the status line is shared with tools that stay in mm.
  var inch = NSO_scaleIn(), L = function (mm) { return NSO_scaleLen(mm, 1) + (inch ? ' in' : ''); };
  var bed = function (mm) { return inch ? NSO_scaleLen(mm) : mm; };
  if (rep.fits) {
    if (typeof setStatus === 'function') {
      setStatus('Fit to plate: already fits ' + name + ' (' + L(size.x) + ' wide, ' + L(size.y) +
                ' deep, ' + L(size.z) + ' tall in ' + bed(printer.bedX) + ' × ' + bed(printer.bedY) + ' × ' +
                bed(printer.buildZ) + (inch ? ' in' : '') + ') - nothing changed');
    }
    return { ok: true, changed: false, factor: 1, fits: true };
  }
  var factor = Math.min(printer.bedX / size.x, printer.bedY / size.y, printer.buildZ / size.z);
  var r = NSO_scaleSelectedModel({ factor: factor });
  if (!r.ok) return r;
  var after = NSO_Printer.fit(NSO_Printer.fromDisplaySize(m.size), printer);
  var worst = rep.over[0];
  var txt = 'Fit to plate: ×' + factor.toFixed(6) + ' - ' + NSO_SCALE_FIT_NOUN[worst.axis] + ' ' +
    NSO_scaleLen(worst.size_mm, 1) + ' → ' + NSO_scaleLen(worst.size_mm * factor, 1) + NSO_scaleU() + ', now ' +
    L(m.size.x) + ' wide, ' + L(m.size.z) + ' deep, ' + L(m.size.y) + ' tall; ' +
    (after.fits ? 'fits ' + name : 'STILL over: ' + NSO_scaleText(after.reason));
  if (typeof setStatus === 'function') setStatus(txt, !after.fits);
  if (typeof nsoScaleRefresh === 'function') nsoScaleRefresh();
  r.factor = factor; r.changed = true; r.fits = after.fits; r.fitReport = after;
  return r;
}

/* The house lifecycle every card verb shares, without the commit: a selected
   raw piece, no paint (PAINT SCOPE: WHOLE-PIECE, the Scale card's own
   category in docs/HANDOFF.md - each verb moves faces all over one side of
   the piece and the rims they share, so no face can be promised untouched),
   then the headless call on `soup` - the piece's own, or the one a live
   field's edit began from. Nothing is touched and nothing is said: the result
   carries the status line (`status`) and the reason alone (`inline`, what a
   live field shows under itself).

   verb: { label, undoType, paint, run(soup) -> engine result, describe(r) } */
function NSO_scaleCardTry(verb, m, soup) {
  var no = function (reason, status, inline) {
    return { ok: false, reason: reason, status: status, inline: inline || status };
  };
  if (!m) return no('no selection', 'Select a piece first');
  soup = soup || ((m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null);
  if (!soup) return no('no rawTris', verb.label + ' needs a raw piece - unchanged', 'needs a raw piece');
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    var p = no('painted faces: ' + painted, 'Scale stood down - ' + painted + ' painted face(s); ' + verb.paint,
      painted + ' painted face(s) - clear paint to resize');
    p.painted = painted;
    return p;
  }
  /* in the piece's frame, as it lies (NSO_scaleSpaceOf), and turned back */
  var space = NSO_scaleSpaceOf(m, soup);
  var r = verb.run(space.f);
  if (!r.ok) {
    r.inline = NSO_scaleText(r.reason);
    r.status = verb.label + ' refused - piece unchanged (' + r.inline + ')';
    return r;
  }
  if (r.tris) r.tris = space.toRaw(r.tris);
  r.said = verb.describe(r);
  r.status = verb.label + ' done - ' + r.said;
  return r;
}

/* Try, then one NSO_sculptCommitRaw - one Undo step. */
function NSO_scaleCardApply(verb) {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  var r = NSO_scaleCardTry(verb, m);
  if (!r.ok) {
    if (typeof setStatus === 'function') setStatus(r.status, true);
    return r;
  }
  if (typeof NSO_sculptCommitRaw === 'function' && !NSO_sculptCommitRaw(m, r.tris, verb.undoType, r.status)) {
    if (typeof setStatus === 'function') setStatus(verb.label + ' failed to commit - piece unchanged', true);
    return { ok: false, reason: 'commit failed' };
  }
  if (typeof nsoScaleRefresh === 'function') nsoScaleRefresh();
  return r;
}

/* The reading of a soup, for a verb that runs on it: a live field's verbs
   run on the soup its edit began from, which is not the piece's while the
   edit is shown. */
function NSO_scaleSectionOfSoup(soup) {
  return NSO_scaleSectionOf(soup ? { rawTris: soup, rawAxis: 'zup' } : null);
}

var NSO_SCALE_FACES_PAINT = ' moves faces all over one side of the piece and the rims they share. Clear paint to resize.';

/* A ring or rod verb: 'outer' | 'bore' | 'wall' | 'diameter', to `value` mm.
   nso_ring.js does the geometry and every refusal. */
var NSO_SCALE_RING_LABEL = { outer: 'Outer Ø', bore: 'Bore Ø', wall: 'Wall', diameter: 'Diameter' };
function NSO_scaleRingVerb(verb, value) {
  var label = NSO_SCALE_RING_LABEL[verb] || verb;
  return {
    label: label, undoType: 'ringReplace', paint: label + NSO_SCALE_FACES_PAINT,
    run: function (soup) { return NSO_ringApplyRaw(soup, verb, value); },
    describe: function (r) {
      // nso_ring.js's own figures with mm shown (a ring at the card's one
      // display precision); each one carries "in" with inches shown.
      return NSO_ringDescribe(r, NSO_scaleIn() ? function (x) { return NSO_scaleLen(x) + ' in'; } : null);
    }
  };
}
function NSO_scaleRingApply(verb, value) { return NSO_scaleCardApply(NSO_scaleRingVerb(verb, value)); }

/* Length / Width / Height: Extend or Shorten along the piece's own axis that
   NSO_sectionVerbs named for it. The band logic was already per axis
   (NSO_extendBands and NSO_extendRaw take any of X, Y, Z), so nothing in
   app-extend.js changed for this: the axis is forced rather than detected,
   and a refusal - Shorten's "can remove up to N mm here" among them - is
   Extend's own. undo type 'extendReplace', as Extend's own button. */
var NSO_SCALE_AXIS_LABEL = { length: 'Length', width: 'Width', height: 'Height' };
function NSO_scaleAxisVerb(verb, value) {
  var label = NSO_SCALE_AXIS_LABEL[verb] || verb;
  return {
    label: label, undoType: 'extendReplace', paint: label + NSO_SCALE_FACES_PAINT,
    run: function (soup) {
      var s = NSO_scaleSectionOfSoup(soup), dim = s && s.verbs ? s.verbs[verb] : null;
      if (!dim) {
        return { ok: false, reason: (s ? s.why || s.reason : 'no reading') + ' - no straight run to stretch along its ' +
                 label.toLowerCase() };
      }
      if (!(value > 0)) return { ok: false, reason: label + ' must be a positive number of mm' };
      if (dim.stretch) return NSO_scaleStretchRaw(soup, dim.axisIdx, +value);
      return NSO_extendRaw(soup, { axis: dim.axisIdx, length: +value });
    },
    describe: function (r) {
      var L = NSO_scaleLen, f = NSO_sectionShow;
      if (r.stretch) {
        return label + ' ' + L(r.lengthBefore, f) + ' → ' + L(r.lengthAfter, f) + NSO_scaleU() +
          ', stretched ' + (verb === 'height' ? 'up the plate vertical' : 'along its footprint\'s ' +
          (verb === 'length' ? 'long' : 'short') + ' side') + ' as it lies (×' + r.factor.toFixed(4) + ' that way, about the middle)';
      }
      return r.axis.toUpperCase() + ' ' + L(r.lengthBefore, f) + ' → ' + L(r.lengthAfter, f) +
        NSO_scaleU() + ' (' + (r.mode === 'shorten' ? 'removed' : 'inserted') + ' at ' + r.axis.toUpperCase() + ' ' +
        L(r.cut, 2) + (NSO_scaleIn() ? ' in' : '') + '), every other coordinate unchanged (' + r.crossSectionDrift + ' drifted)';
    }
  };
}
function NSO_scaleAxisApply(verb, value) { return NSO_scaleCardApply(NSO_scaleAxisVerb(verb, value)); }

/* A shape row - Length / Diameter on a capsule, A · B · C on a sphere or
   ellipsoid, Ring Ø / Tube Ø on a torus - to `value` mm. nso_shapes.js does
   the geometry and every refusal and tags the result, so the card reads the
   new shape back without fitting it again. undo type 'scaleReplace'. */
function NSO_scaleShapeVerb(row, value) {
  var label = (typeof NSO_SHAPE_ROW_LABEL !== 'undefined' && NSO_SHAPE_ROW_LABEL[row]) || row;
  return {
    label: label, undoType: 'scaleReplace', paint: label + NSO_SCALE_FACES_PAINT,
    // Read off the soup it runs on: a live field's edit runs on the soup it
    // began from, which is not the piece's while the edit is shown.
    run: function (soup) {
      var sh = NSO_scaleShapeOf({ rawTris: soup, rawAxis: 'zup' });
      if (!sh) return { ok: false, reason: 'the piece no longer reads as a capsule, sphere, ellipsoid or torus' };
      return NSO_shapeApplyRaw(soup, sh, row, +value);
    },
    describe: function (r) {
      var f = function (x) { return NSO_scaleLen(x, NSO_sectionShow); }, u = NSO_scaleU();
      var keep = { capLength: 'the hemispheres moved, not reshaped', capDiameter: 'length kept, the ends still hemispheres',
                   ellA: 'B and C untouched', ellB: 'A and C untouched', ellC: 'A and B untouched',
                   ringDia: 'tube section unchanged', tubeDia: r.shape && r.shape.wall != null ? 'ring Ø and wall kept' : 'ring Ø kept' };
      return r.label + ' ' + f(r.valueBefore) + ' → ' + f(r.valueAfter) + u + ' (' + keep[row] + '); now ' +
        NSO_shapeReadout(r.shape, f);
    }
  };
}
function NSO_scaleShapeApply(row, value) { return NSO_scaleCardApply(NSO_scaleShapeVerb(row, value)); }

/* Offset: Fatten and Shrink as one signed number. undo type 'offsetReplace'. */
function NSO_scaleOffsetVerb(mm) {
  return {
    label: 'Offset', undoType: 'offsetReplace', paint: 'Offset' + NSO_SCALE_FACES_PAINT,
    run: function (soup) {
      var s = NSO_scaleSectionOfSoup(soup);
      return NSO_scaleOffsetRaw(soup, mm, { innerWord: (s && s.shape === 'round') ? 'bore' : 'bore or pocket' });
    },
    describe: function (r) {
      // With inches shown "in 0.100 in" would read twice, so the direction is
      // spelt out; the amount is echoed as typed.
      var inch = NSO_scaleIn(), u = NSO_scaleU(), a = r.spanBefore, b = r.spanAfter;
      var f = function (x) { return NSO_scaleLen(x, NSO_sectionShow); };
      return (inch ? (r.mm > 0 ? 'outward ' : 'inward ') : (r.mm > 0 ? 'out ' : 'in ')) +
        (inch ? NSO_scaleTyped(Math.abs(r.mm)) : Math.abs(r.mm)) + u + ', ' + f(a[0]) + ' × ' + f(a[1]) + ' × ' + f(a[2]) +
        ' → ' + f(b[0]) + ' × ' + f(b[1]) + ' × ' + f(b[2]) + u + ' (X × Y × Z); ' +
        (r.innerFaces ? r.innerFaces + ' inner face(s) followed, walls kept' : 'no inner faces - an even offset');
    }
  };
}
function NSO_scaleOffsetApply(mm) { return NSO_scaleCardApply(NSO_scaleOffsetVerb(mm)); }

/* A card field's verb, `value` in mm (Whole x: a plain factor). */
function NSO_scaleCardVerb(k, value) {
  if (k === 'factor') return NSO_scaleUniformVerb({ factor: value });
  if (k === 'longest') return NSO_scaleUniformVerb({ axis: 'longest', targetMm: value });
  if (k === 'offset') return NSO_scaleOffsetVerb(value);
  if (NSO_SCALE_AXIS_LABEL[k]) return NSO_scaleAxisVerb(k, value);
  if (typeof NSO_SHAPE_ROW_LABEL !== 'undefined' && NSO_SHAPE_ROW_LABEL[k]) return NSO_scaleShapeVerb(k, value);
  return NSO_scaleRingVerb(k, value);
}

// How long a live field waits after the last keystroke before it applies.
var NSO_SCALE_LIVE_MS = 80;

if (typeof document !== 'undefined') {
  (function wireScaleCard() {
    // Every field the card has: [key, input id, row id]. The verbs table in
    // nso_section.js decides which rows show.
    var FIELDS = [
      ['length', 'scale-length', 'scale-length-row'],
      ['width', 'scale-width', 'scale-width-row'],
      ['height', 'scale-height', 'scale-height-row'],
      ['outer', 'scale-ring-outer', 'scale-ring-outer-row'],
      ['bore', 'scale-ring-bore', 'scale-ring-bore-row'],
      ['wall', 'scale-ring-wall', 'scale-ring-wall-row'],
      ['diameter', 'scale-rod-diameter', 'scale-rod-diameter-row'],
      ['offset', 'scale-offset', 'scale-offset-row'],
      ['capLength', 'scale-cap-length', 'scale-cap-length-row'],
      ['capDiameter', 'scale-cap-diameter', 'scale-cap-diameter-row'],
      ['ellA', 'scale-ell-a', 'scale-ell-a-row'],
      ['ellB', 'scale-ell-b', 'scale-ell-b-row'],
      ['ellC', 'scale-ell-c', 'scale-ell-c-row'],
      ['ringDia', 'scale-torus-ring', 'scale-torus-ring-row'],
      ['tubeDia', 'scale-torus-tube', 'scale-torus-tube-row'],
      ['factor', 'scale-factor', 'scale-factor-row'],
      ['longest', 'scale-target', 'scale-longest-row']
    ];
    var LABEL = { length: 'Length', width: 'Width', height: 'Height', outer: 'Outer Ø', bore: 'Bore Ø', wall: 'Wall',
                  diameter: 'Diameter', offset: 'Offset', factor: 'Whole ×', longest: 'Longest',
                  capLength: 'Length', capDiameter: 'Diameter', ellA: 'A', ellB: 'B', ellC: 'C',
                  ringDia: 'Ring Ø', tubeDia: 'Tube Ø' };
    // What the card last put in each field: the value an edit starts from,
    // and what Escape puts back.
    var prefill = {};
    // The edit in progress, one field at a time (see edit() below).
    var sess = null;

    function byId(id) { return document.getElementById(id); }
    function active() { return (typeof getActiveModel === 'function') ? getActiveModel() : null; }
    function fieldOf(k) { for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i][0] === k) return FIELDS[i]; return null; }

    // Read only while the card is open. The reading walks the whole soup -
    // about a second on a 49k-triangle piece - and updateEditSize fires on
    // every import, selection and bake anywhere in the app; a shut card has
    // nobody to show it to. Opening the menu reads it (the toggle listener in
    // wire()), and data-stale says which state the line is in.
    function cardOpen() {
      var menu = byId('menu-scale');
      return !menu || menu.open;
    }

    function placedOf(m) {
      return (m && typeof state !== 'undefined' && state.placed)
        ? state.placed.find(function (p) { return p && p.sourceId === m.id; }) : null;
    }
    // What "the piece changed" means to the card: which piece, which soup
    // (every bake replaces rawTris with a new array) and how it sits on the
    // plate (Yaw, Tip, Roll and Lift change the fit verdict, not the soup).
    function signature(m) {
      var p = placedOf(m);
      return [m ? m.id : '', p ? [p.rotY || 0, p.tipX || 0, p.tipZ || 0, p.liftY || 0, p.x, p.z].join(',') : ''].join('|');
    }

    // Every field, from the reading, in the unit shown. Whole x is 1 and
    // Offset empty: a factor or an offset is a change, not a measurement, so
    // neither carries over. The field being edited is left as it is - the
    // edit is what changed the piece.
    function populate(s) {
      var v = s ? s.verbs : null, val = {};
      var f = function (x) { return NSO_scaleLen(x, NSO_sectionShow); };
      var sv = lastShape ? NSO_shapeRowValues(lastShape) : null;
      if (sv) {
        Object.keys(sv).forEach(function (k) { val[k] = f(sv[k]); });
        var e = NSO_shapeExpectedSpan(lastShape);
        val.longest = f(Math.max(e[0], e[1], e[2]));
      }
      if (v) {
        ['length', 'width', 'height'].forEach(function (k) { if (v[k]) val[k] = f(v[k].mm); });
        if (v.outer) { val.outer = f(s.outer.diameterMm); val.bore = f(s.bore.diameterMm); val.wall = f(s.wallMm); }
        if (v.diameter) val.diameter = f(s.outer.diameterMm);
        val.longest = f(v.longestMm);
      }
      val.factor = '1';
      val.offset = '';
      FIELDS.forEach(function (fd) {
        if (sess && sess.k === fd[0]) return;
        var el = byId(fd[1]);
        prefill[fd[0]] = val[fd[0]] != null ? val[fd[0]] : '';
        if (el) el.value = prefill[fd[0]];
      });
    }

    // A recognised shape replaces the section rows with its own: each one
    // changes one thing, and a Length / Width / Height band stretch or an
    // even offset on top of them would only say the same less exactly.
    function show(s) {
      var v = s ? s.verbs : null, sh = lastShape;
      var on = {
        length: !!(v && v.length), width: !!(v && v.width), height: !!(v && v.height),
        outer: !!(v && v.outer), bore: !!(v && v.bore), wall: !!(v && v.wall), diameter: !!(v && v.diameter),
        offset: !!(v && v.offset), factor: true, longest: !v || v.longest
      };
      if (sh) {
        var rows = NSO_SHAPE_ROWS[sh.shape] || [], vals = NSO_shapeRowValues(sh);
        ['length', 'width', 'height', 'outer', 'bore', 'wall', 'diameter', 'offset'].forEach(function (k) { on[k] = false; });
        rows.forEach(function (k) { on[k] = true; });
        var b = NSO_shapeExpectedSpan(sh), longest = Math.max(b[0], b[1], b[2]);
        on.longest = !rows.some(function (k) { return NSO_sectionShow(vals[k]) === NSO_sectionShow(longest); });
      }
      // The row being typed in stays, whatever the piece it is making reads as.
      if (sess) on[sess.k] = true;
      FIELDS.forEach(function (fd) {
        var row = byId(fd[2]);
        if (row) row.hidden = !on[fd[0]];
      });
    }

    var lastSig = null, lastSoup = null, lastReading = null, lastShape = null;
    function readout(force) {
      var el = byId('scale-readout');
      if (!el) return;
      var m = active();
      // Another piece selected mid-edit: the field has been left, so the
      // edit is kept, on the piece it was made on.
      if (sess && m !== sess.m) finish(true);
      if (!cardOpen()) { el.dataset.stale = '1'; return; }
      el.dataset.stale = '0';
      el.textContent = NSO_scaleReadoutText(m);
      lastShape = m ? NSO_scaleShapeOf(m) : null;
      var s = (m && !lastShape) ? NSO_scaleSectionOf(m) : null;
      show(s);
      var soup = m ? m.rawTris : null, sig = signature(m);
      lastReading = s;
      relabel();
      if (force === true || soup !== lastSoup || sig !== lastSig) {
        lastSoup = soup; lastSig = sig;
        populate(s);
      }
    }
    window.nsoScaleRefresh = function () { readout(true); };

    // updateEditSize is not called by every bake (Thicken commits through its
    // own path) nor by a pose change, so while the card is open the selected
    // piece is watched once per frame - its identity, its soup's identity and
    // its pose - and the card re-reads when any of them moves, whoever moved
    // it. Only while open.
    var watching = false, seen = null;
    function key() {
      var m = active();
      return { m: m, soup: m ? m.rawTris : null, sig: signature(m) };
    }
    function watch() {
      if (!cardOpen()) { watching = false; return; }
      var k = key();
      if (!seen || k.m !== seen.m || k.soup !== seen.soup || k.sig !== seen.sig) { seen = k; readout(); }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(watch);
      else watching = false;
    }
    function startWatch() {
      if (watching) return;
      watching = true;
      seen = key();
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(watch);
    }

    /* ---- live fields ----
       An edit is one field from the moment it is typed in until it is left.
       It keeps the piece and the soup it began from, and every value typed
       runs its verb on THAT soup - never on the last one shown - so typing
       60 then 65 gives exactly what 65 alone would, and what the field
       commits is what a single Set used to.

       The piece follows through NSO_sculptCommitRaw, the one bake path. The
       first value shown writes the edit's undo entry (its "before" is the
       soup the edit began from); later ones swap the piece with pushUndo
       held off, so the edit stays one step. Going back to where it began -
       Escape, the value cleared or typed back, or leaving on a refused value
       - is that entry undone. */
    function edit(k) {
      if (sess && sess.k === k) return sess;
      if (sess) finish(true);
      var fd = fieldOf(k), m = active();
      sess = { k: k, el: byId(fd[1]), start: prefill[k] != null ? prefill[k] : '', m: m,
               soup: (m && m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null,
               entry: null, last: null, timer: 0 };
      return sess;
    }

    // The field's text as a verb, in mm; null when it asks for no change
    // (empty, the value the edit began from, Whole x 1, Offset 0).
    function verbOf(s) {
      var t = String(s.el.value).trim(), num = parseFloat(t);
      if (t === '' || !isFinite(num)) return null;
      if (s.k === 'factor') return num === 1 ? null : NSO_scaleCardVerb('factor', num);
      if (s.k === 'offset') return num === 0 ? null : NSO_scaleCardVerb('offset', NSO_scaleToMm(num));
      if (s.start !== '' && num === +s.start) return null;
      return NSO_scaleCardVerb(s.k, NSO_scaleToMm(num));
    }

    function withoutUndo(fn) {
      var push = window.pushUndo;
      window.pushUndo = function () {};
      try { return fn(); } finally { window.pushUndo = push; }
    }
    function topEntry() {
      return (typeof state !== 'undefined' && state.undoStack) ? state.undoStack[state.undoStack.length - 1] : null;
    }

    // The reason under the field, red, while the typed value is refused.
    function whyOf(k) {
      var fd = fieldOf(k), id = fd[1] + '-why', p = byId(id);
      var row = byId(fd[2]);
      if (!p && row) {
        p = document.createElement('p');
        p.id = id;
        p.className = 'hint scale-why';
        p.setAttribute('aria-live', 'polite');
        p.hidden = true;
        row.insertAdjacentElement('afterend', p);
      }
      return p;
    }
    // The reason is part of the field's description only while it shows.
    function mark(s, text) {
      var p = whyOf(s.k), el = s.el;
      if (p) { p.textContent = text || ''; p.hidden = !text; }
      if (!el) return;
      if (el.dataset.nsoDescribed == null) el.dataset.nsoDescribed = el.getAttribute('aria-describedby') || '';
      var said = el.dataset.nsoDescribed;
      if (text) {
        el.setAttribute('aria-invalid', 'true');
        el.setAttribute('aria-describedby', (said + ' ' + (p ? p.id : '')).trim());
      } else {
        el.removeAttribute('aria-invalid');
        if (said) el.setAttribute('aria-describedby', said); else el.removeAttribute('aria-describedby');
      }
    }

    // Back to the soup the edit began from.
    function putBack(s) {
      if (!s.entry) return;
      var entry = s.entry;
      s.entry = null;
      if (topEntry() === entry && typeof undoLastDiscard === 'function') undoLastDiscard();
      else if (s.m && s.soup && s.m.rawTris !== s.soup) {
        withoutUndo(function () { NSO_sculptCommitRaw(s.m, s.soup, 'scaleReplace', ''); });
      }
    }

    // Apply what the field says now.
    function preview(s) {
      if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
      var verb = verbOf(s), r = null;
      if (verb) {
        try { r = NSO_scaleCardTry(verb, s.m, s.soup); } catch (err) {
          console.error('[scale]', err);
          var why = NSO_scaleText((err && err.message) || String(err));
          r = { ok: false, reason: why, inline: why, status: LABEL[s.k] + ' failed - piece unchanged (' + why + ')' };
        }
      }
      s.last = r;
      if (r && !r.ok) { mark(s, r.inline); return; }   // the piece stays at the last good value
      mark(s, '');
      if (!r) {
        var had = !!s.entry;
        putBack(s);
        if (had && typeof setStatus === 'function') setStatus(LABEL[s.k] + ': as it was');
        return;
      }
      // An undo taken mid-edit (it can only be the edit's own) leaves no entry to fold into.
      if (s.entry && topEntry() !== s.entry) s.entry = null;
      var line = verb.label + ': ' + r.said + ' - leave the field to keep it, Esc to put it back';
      var ok = s.entry
        ? withoutUndo(function () { return NSO_sculptCommitRaw(s.m, r.tris, verb.undoType, line); })
        : NSO_sculptCommitRaw(s.m, r.tris, verb.undoType, line);
      if (ok && !s.entry) s.entry = topEntry();
      if (!ok) s.last = { ok: false, reason: 'commit failed', status: verb.label + ' failed to commit - piece unchanged' };
    }

    // Leave the edit: keep it (blur, Tab, Enter) or put it back (Escape).
    // Leaving on a refused value commits nothing.
    function finish(keep) {
      var s = sess;
      if (!s) return null;
      sess = null;
      if (keep && s.timer) preview(s);   // the last keystroke counts
      if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
      mark(s, '');
      var r = s.last;
      if (keep && r && r.ok) {
        s.entry = null;
        if (typeof setStatus === 'function') setStatus(r.status);
        readout(true);
        return r;
      }
      var moved = !!s.entry;
      putBack(s);
      if (s.el) s.el.value = s.start;
      if (typeof setStatus === 'function') {
        if (keep && r) setStatus(r.status, true);
        else if (!keep && (moved || r)) setStatus(LABEL[s.k] + ': put back - piece unchanged');
      }
      if (moved || r) readout(true);
      return r;
    }

    /* ---- the mm | in toggle ----
       The card's labels, aria-labels, unit hints, titles and each length
       box's min / max / step are written in mm in index.html. The first
       relabel() records each one as it stands (data-mm-*), and every later
       one rewrites from that record, so toggling any number of times never
       compounds a conversion. Whole x has no unit and is skipped. */
    function loadUnit() {
      var saved = null;
      try { saved = localStorage.getItem(NSO_SCALE_UNIT_KEY); } catch (e) {}
      NSO_scaleUnitNow = saved === 'in' ? 'in' : 'mm';
    }
    function relabel() {
      var inch = NSO_scaleIn();
      // A ring's or rod's axis goes by the name its row has, so "length kept" /
      // "the length is held" say height on one stood up (NSO_sectionAxisWord).
      var s = lastReading, axisWord = (s && s.shape === 'round') ? NSO_sectionAxisWord(s, s.axisIdx) : 'length';
      var swap = function (t, word) {
        t = t.replace(/\blength (kept|is held)\b/g, axisWord + ' $1');
        return inch ? t.replace(/\bmm\b/g, word) : t;
      };
      FIELDS.forEach(function (fd) {
        if (fd[0] === 'factor') return;
        var el = byId(fd[1]), row = byId(fd[2]);
        if (el) {
          var d = el.dataset;
          if (d.mmStep == null) { d.mmMin = el.min; d.mmMax = el.max; d.mmStep = el.step; d.mmAria = el.getAttribute('aria-label') || ''; }
          if (inch) {
            var st = NSO_scaleInchStep(+d.mmStep);
            el.step = String(st);
            el.min = String(NSO_scaleInchLimit(+d.mmMin, st, 'min'));
            el.max = String(NSO_scaleInchLimit(+d.mmMax, st, 'max'));
          } else { el.step = d.mmStep; el.min = d.mmMin; el.max = d.mmMax; }
          el.setAttribute('aria-label', swap(d.mmAria, 'inches'));
        }
        var hint = row ? row.querySelector('.hint') : null;
        if (hint) {
          if (hint.dataset.mmText == null) hint.dataset.mmText = hint.textContent;
          hint.textContent = swap(hint.dataset.mmText, 'in');
        }
      });
      // A row's sentence carries figures, not just the unit word: converted
      // figure by figure, like an engine's reason.
      document.querySelectorAll('#scale-rows .scale-note').forEach(function (n) {
        if (n.dataset.mmText == null) n.dataset.mmText = n.textContent;
        n.textContent = NSO_scaleText(n.dataset.mmText);
      });
      document.querySelectorAll('#scale-card button[title], #scale-rows input[title]').forEach(function (b) {
        if (b.dataset.mmTitle == null) b.dataset.mmTitle = b.title;
        b.title = swap(b.dataset.mmTitle, 'inches');
      });
      ['mm', 'in'].forEach(function (u) {
        var b = byId('btn-scale-unit-' + u);
        if (b) b.setAttribute('aria-pressed', NSO_scaleUnitNow === u ? 'true' : 'false');
      });
    }
    // Switch the unit shown. Display only: the piece, its undo stack and its
    // pose are not touched; the readout and the boxes re-read in the new
    // unit. An edit still open is left first, as a click on the toggle does.
    function setUnit(u) {
      u = u === 'in' ? 'in' : 'mm';
      if (sess) finish(true);
      var was = NSO_scaleUnitNow;
      NSO_scaleUnitNow = u;
      try { localStorage.setItem(NSO_SCALE_UNIT_KEY, u); } catch (e) {}
      relabel();
      if (was === u) return;
      readout();
      populate(lastReading);
    }

    function wireField(fd) {
      var k = fd[0], el = byId(fd[1]);
      if (!el || el.dataset.nsoWired === '1') return;
      el.dataset.nsoWired = '1';
      whyOf(k);
      el.addEventListener('focus', function () { edit(k); });
      el.addEventListener('input', function () {
        var s = edit(k);
        if (s.timer) clearTimeout(s.timer);
        s.timer = setTimeout(function () { if (sess === s) preview(s); }, NSO_SCALE_LIVE_MS);
      });
      el.addEventListener('blur', function () { if (sess && sess.k === k) finish(true); });
      // A value set from outside, with the field not focused (a script, an
      // autofill): the same edit, begun and left at once. While focused,
      // change is the spinner or Enter, both handled as typing.
      el.addEventListener('change', function () {
        if (document.activeElement === el) return;
        if (sess && sess.k === k) finish(true);
        else if (el.value !== (prefill[k] != null ? prefill[k] : '')) { edit(k); finish(true); }
      });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (sess && sess.k === k) finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (sess && sess.k === k) finish(false);
        }
      });
    }

    function wire() {
      ['mm', 'in'].forEach(function (u) {
        var b = byId('btn-scale-unit-' + u);
        if (b && b.dataset.nsoWired !== '1') {
          b.dataset.nsoWired = '1';
          b.addEventListener('click', function () { setUnit(u); });
        }
      });
      relabel();
      FIELDS.forEach(wireField);
      var fit = byId('btn-scale-fit');
      if (fit && fit.dataset.nsoWired !== '1') {
        fit.dataset.nsoWired = '1';
        fit.addEventListener('click', function () {
          if (sess) finish(true);
          try { NSO_scaleFitToPlate(); } catch (err) {
            console.error('[scale]', err);
            if (typeof setStatus === 'function') {
              setStatus('Fit to plate failed - piece unchanged (' + NSO_scaleText((err && err.message) || String(err)) + ')', true);
            }
          }
          readout();
        });
      }
      var menu = byId('menu-scale');
      if (menu && menu.dataset.nsoScaleWired !== '1') {
        menu.dataset.nsoScaleWired = '1';
        menu.addEventListener('toggle', function () { if (menu.open) { readout(true); startWatch(); } });
      }
      // The verdict names the machine, so a plate change re-reads it.
      ['plate-select', 'custom-w', 'custom-d', 'custom-h'].forEach(function (id) {
        var el = byId(id);
        if (el && el.dataset.nsoScaleWired !== '1') {
          el.dataset.nsoScaleWired = '1';
          el.addEventListener('change', function () { readout(); });
          el.addEventListener('input', function () { readout(); });
        }
      });
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

    loadUnit();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
    setTimeout(wire, 0);
  })();
}
