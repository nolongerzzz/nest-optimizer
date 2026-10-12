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
// app-extend.js; nothing in this file reads a shape.
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

   THE CARD READS THE SHAPE FIRST. Its first line is nso_section.js's reading
   in print terms - Ring / Rod / Bar with the numbers a person measures, or the
   three sizes and, in plain words, the gate that decided the piece is neither
   and what still applies - with the build-volume verdict appended. Under it,
   one compact row per field (label | field | unit or hold | Set), and only
   the rows nso_section.js's NSO_sectionVerbs says apply:

     Length / Width / Height   the piece's own axes as it lies - Height its Z,
                       Length the longer of its X and Y, Width the shorter;
                       never the plate's. Each one is Extend / Shorten along
                       that axis (NSO_extendRaw with the axis forced), so the
                       material goes in or comes out inside one clean
                       constant-section band and every wall, floor, hole,
                       pocket and lip keeps its size. An axis with no such band
                       gets no row. A ring or rod shows Length only.
     Outer Ø / Wall    a ring (nso_ring.js): outer and bore together (wall
                       kept), or the bore alone (outer kept). Part 2's Bore Ø
                       row is gone: Outer Ø and Wall between them reach every
                       bore, and the third field only restated the other two.
     Diameter          a rod.
     Offset            Fatten and Shrink, folded in: the outside moves by the
                       mm entered and the inner faces follow (NSO_scaleOffsetRaw
                       above). Shown on every piece but a ring or rod, where Outer Ø /
                       Diameter and Length already do its job.
     Whole x           today's uniform factor. Reset to 1 on every selection,
                       bake and pose change.
     Longest           today's longest-edge target, prefilled with the longest
                       edge. Hidden when a named field shows the same number.
     Fit to plate      the largest uniform factor that fits the machine.

   Every field shows nso_section.js's one display precision (NSO_sectionShow)
   and repopulates whenever the selection, the piece's soup or its pose on the
   plate changes, whoever changed it.
--------------------------------------------------------------------------- */

/* The section reading for a piece, cached on its soup: a bake replaces
   rawTris with a new array, so the cache can never serve a stale shape, and
   a selection change or a size-line refresh costs nothing. */
var NSO_scaleSectionCache = (typeof WeakMap === 'function') ? new WeakMap() : null;
function NSO_scaleSectionOf(m) {
  var soup = (m && m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null;
  if (!soup || typeof NSO_sectionRead !== 'function') return null;
  if (NSO_scaleSectionCache && NSO_scaleSectionCache.has(soup)) return NSO_scaleSectionCache.get(soup);
  var s = NSO_sectionRead(soup);
  if (NSO_scaleSectionCache) NSO_scaleSectionCache.set(soup, s);
  return s;
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
    return o.over_mm.toFixed(1) + ' mm too ' + NSO_SCALE_FIT_WORD[o.axis];
  }).join(', ') + ' for ' + name;
}

/* The card's first line, readout and verdict. Returned as well as rendered
   so the drive check reads the same string the user does. */
function NSO_scaleReadoutText(m) {
  if (!m || !m.size) return 'Select a piece to resize.';
  var s = NSO_scaleSectionOf(m);
  var line = s ? NSO_sectionReadout(s)
    : (m.size.x.toFixed(1) + ' × ' + m.size.z.toFixed(1) + ' × ' + m.size.y.toFixed(1) + ' W × D × H');
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
  if (rep.fits) {
    if (typeof setStatus === 'function') {
      setStatus('Fit to plate: already fits ' + name + ' (' + size.x.toFixed(1) + ' wide, ' + size.y.toFixed(1) +
                ' deep, ' + size.z.toFixed(1) + ' tall in ' + printer.bedX + ' × ' + printer.bedY + ' × ' +
                printer.buildZ + ') - nothing changed');
    }
    return { ok: true, changed: false, factor: 1, fits: true };
  }
  var factor = Math.min(printer.bedX / size.x, printer.bedY / size.y, printer.buildZ / size.z);
  var r = NSO_scaleSelectedModel({ factor: factor });
  if (!r.ok) return r;
  var after = NSO_Printer.fit(NSO_Printer.fromDisplaySize(m.size), printer);
  var worst = rep.over[0];
  var txt = 'Fit to plate: ×' + factor.toFixed(6) + ' - ' + NSO_SCALE_FIT_NOUN[worst.axis] + ' ' +
    worst.size_mm.toFixed(1) + ' → ' + (worst.size_mm * factor).toFixed(1) + ' mm, now ' +
    m.size.x.toFixed(1) + ' wide, ' + m.size.z.toFixed(1) + ' deep, ' + m.size.y.toFixed(1) + ' tall; ' +
    (after.fits ? 'fits ' + name : 'STILL over: ' + after.reason);
  if (typeof setStatus === 'function') setStatus(txt, !after.fits);
  if (typeof nsoScaleRefresh === 'function') nsoScaleRefresh();
  r.factor = factor; r.changed = true; r.fits = after.fits; r.fitReport = after;
  return r;
}

/* The house lifecycle every card verb shares: a selected raw piece, no paint
   (PAINT SCOPE: WHOLE-PIECE, the Scale card's own category in
   docs/HANDOFF.md - each verb moves faces all over one side of the piece and
   the rims they share, so no face can be promised untouched), then the
   headless call, then one NSO_sculptCommitRaw - one Undo step. */
function NSO_scaleCardApply(label, undoType, run, describe) {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  if (!m) {
    if (typeof setStatus === 'function') setStatus('Select a piece first', true);
    return { ok: false, reason: 'no selection' };
  }
  var soup = (m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null;
  if (!soup) {
    if (typeof setStatus === 'function') setStatus(label + ' needs a raw piece - unchanged', true);
    return { ok: false, reason: 'no rawTris' };
  }
  var painted = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (painted > 0) {
    if (typeof setStatus === 'function') {
      setStatus('Scale stood down - ' + painted + ' painted face(s); ' + label + ' moves faces all over ' +
                'one side of the piece and the rims they share. Clear paint to resize.', true);
    }
    return { ok: false, reason: 'painted faces: ' + painted, painted: painted };
  }
  var r = run(soup, m);
  if (!r.ok) {
    if (typeof setStatus === 'function') setStatus(label + ' refused - piece unchanged (' + r.reason + ')', true);
    return r;
  }
  var txt = label + ' done - ' + describe(r);
  if (typeof NSO_sculptCommitRaw === 'function' && !NSO_sculptCommitRaw(m, r.tris, undoType, txt)) {
    if (typeof setStatus === 'function') setStatus(label + ' failed to commit - piece unchanged', true);
    return { ok: false, reason: 'commit failed' };
  }
  if (typeof nsoScaleRefresh === 'function') nsoScaleRefresh();
  return r;
}

/* A ring or rod verb on the selected piece: 'outer' | 'wall' | 'diameter'
   (and 'bore', which nso_ring.js still answers; the card no longer offers
   it), to `value` mm. nso_ring.js does the geometry and every refusal. */
var NSO_SCALE_RING_LABEL = { outer: 'Outer Ø', bore: 'Bore Ø', wall: 'Wall', diameter: 'Diameter' };
function NSO_scaleRingApply(verb, value) {
  return NSO_scaleCardApply(NSO_SCALE_RING_LABEL[verb] || verb, 'ringReplace',
    function (soup) { return NSO_ringApplyRaw(soup, verb, value); },
    function (r) { return NSO_ringDescribe(r); });
}

/* Length / Width / Height: Extend or Shorten along the piece's own axis that
   NSO_sectionVerbs named for it. The band logic was already per axis
   (NSO_extendBands and NSO_extendRaw take any of X, Y, Z), so nothing in
   app-extend.js changed for this: the axis is forced rather than detected,
   and a refusal - Shorten's "can remove up to N mm here" among them - is
   Extend's own. undo type 'extendReplace', as Extend's own button. */
var NSO_SCALE_AXIS_LABEL = { length: 'Length', width: 'Width', height: 'Height' };
function NSO_scaleAxisApply(verb, value) {
  var label = NSO_SCALE_AXIS_LABEL[verb] || verb;
  return NSO_scaleCardApply(label, 'extendReplace', function (soup, m) {
    var s = NSO_scaleSectionOf(m), dim = s && s.verbs ? s.verbs[verb] : null;
    if (!dim) {
      return { ok: false, reason: (s ? s.why || s.reason : 'no reading') + ' - no straight run to stretch along its ' +
               label.toLowerCase() };
    }
    if (!(value > 0)) return { ok: false, reason: label + ' must be a positive number of mm' };
    return NSO_extendRaw(soup, { axis: dim.axisIdx, length: +value });
  }, function (r) {
    return r.axis.toUpperCase() + ' ' + NSO_sectionShow(r.lengthBefore) + ' → ' + NSO_sectionShow(r.lengthAfter) +
      ' mm (' + (r.mode === 'shorten' ? 'removed' : 'inserted') + ' at ' + r.axis.toUpperCase() + ' ' +
      r.cut.toFixed(2) + '), every other coordinate unchanged (' + r.crossSectionDrift + ' drifted)';
  });
}

/* Offset: Fatten and Shrink as one signed number. undo type 'offsetReplace'. */
function NSO_scaleOffsetApply(mm) {
  return NSO_scaleCardApply('Offset', 'offsetReplace', function (soup, m) {
    var s = NSO_scaleSectionOf(m);
    return NSO_scaleOffsetRaw(soup, mm, { innerWord: (s && s.shape === 'round') ? 'bore' : 'bore or pocket' });
  }, function (r) {
    var f = NSO_sectionShow, a = r.spanBefore, b = r.spanAfter;
    return (r.mm > 0 ? 'out ' : 'in ') + Math.abs(r.mm) + ' mm, ' + f(a[0]) + ' × ' + f(a[1]) + ' × ' + f(a[2]) +
      ' → ' + f(b[0]) + ' × ' + f(b[1]) + ' × ' + f(b[2]) + ' mm (X × Y × Z); ' +
      (r.innerFaces ? r.innerFaces + ' inner face(s) followed, walls kept' : 'no inner faces - an even offset');
  });
}

if (typeof document !== 'undefined') {
  (function wireScaleCard() {
    // Every field the card has: [key, input id, row id]. The verbs table in
    // nso_section.js decides which rows show.
    var FIELDS = [
      ['length', 'scale-length', 'scale-length-row'],
      ['width', 'scale-width', 'scale-width-row'],
      ['height', 'scale-height', 'scale-height-row'],
      ['outer', 'scale-ring-outer', 'scale-ring-outer-row'],
      ['wall', 'scale-ring-wall', 'scale-ring-wall-row'],
      ['diameter', 'scale-rod-diameter', 'scale-rod-diameter-row'],
      ['offset', 'scale-offset', 'scale-offset-row'],
      ['factor', 'scale-factor', 'scale-factor-row'],
      ['longest', 'scale-target', 'scale-longest-row']
    ];
    var prefill = {};

    // Read only while the card is open. The reading walks the whole soup -
    // about a second on a 49k-triangle piece - and updateEditSize fires on
    // every import, selection and bake anywhere in the app; a shut card has
    // nobody to show it to. Opening the menu reads it (the toggle listener in
    // wire()), and data-stale says which state the line is in.
    function cardOpen() {
      var menu = document.getElementById('menu-scale');
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

    // Every field, from the reading. Whole x is 1 and Offset empty: a factor
    // or an offset is a change, not a measurement, so neither carries over.
    function populate(s) {
      var v = s ? s.verbs : null, f = NSO_sectionShow, val = {};
      if (v) {
        ['length', 'width', 'height'].forEach(function (k) { if (v[k]) val[k] = f(v[k].mm); });
        if (v.length && s.shape === 'round') val.length = f(s.lengthMm);
        if (v.outer) { val.outer = f(s.outer.diameterMm); val.wall = f(s.wallMm); }
        if (v.diameter) val.diameter = f(s.outer.diameterMm);
        val.longest = f(v.longestMm);
      }
      val.factor = '1';
      val.offset = '';
      FIELDS.forEach(function (fd) {
        var el = document.getElementById(fd[1]);
        prefill[fd[0]] = val[fd[0]] != null ? val[fd[0]] : '';
        if (el) el.value = prefill[fd[0]];
      });
    }

    function show(s) {
      var v = s ? s.verbs : null;
      var on = {
        length: !!(v && v.length), width: !!(v && v.width), height: !!(v && v.height),
        outer: !!(v && v.outer), wall: !!(v && v.wall), diameter: !!(v && v.diameter),
        offset: !!(v && v.offset), factor: true, longest: !v || v.longest
      };
      FIELDS.forEach(function (fd) {
        var row = document.getElementById(fd[2]);
        if (row) row.hidden = !on[fd[0]];
      });
    }

    var lastSig = null, lastSoup = null;
    function readout(force) {
      var el = document.getElementById('scale-readout');
      if (!el) return;
      if (!cardOpen()) { el.dataset.stale = '1'; return; }
      el.dataset.stale = '0';
      var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
      el.textContent = NSO_scaleReadoutText(m);
      var s = m ? NSO_scaleSectionOf(m) : null;
      show(s);
      var soup = m ? m.rawTris : null, sig = signature(m);
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
      var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
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

    function guarded(name, fn) {
      try { fn(); } catch (err) {
        console.error('[scale]', err);
        if (typeof setStatus === 'function') {
          setStatus(name + ' failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
        }
      }
      readout();
    }

    function fieldValue(k, id) {
      var el = document.getElementById(id);
      return { raw: el ? el.value : '', num: el ? parseFloat(el.value) : NaN, same: !!el && el.value === prefill[k] };
    }
    var LABEL = { length: 'Length', width: 'Width', height: 'Height', outer: 'Outer Ø', wall: 'Wall',
                  diameter: 'Diameter', offset: 'Offset', factor: 'Whole ×', longest: 'Longest' };

    function apply(k, id) {
      var fv = fieldValue(k, id);
      if (k === 'factor') return NSO_scaleSelectedModel({ factor: fv.num });
      if (k === 'longest') {
        if (fv.same) { if (typeof setStatus === 'function') setStatus('Longest: that is the current longest edge - type a new one'); return; }
        return NSO_scaleSelectedModel({ axis: 'longest', targetMm: fv.num });
      }
      if (k === 'offset') {
        if (!(isFinite(fv.num) && fv.num !== 0)) {
          if (typeof setStatus === 'function') setStatus('Offset: type how far to move the outside, in mm - positive grows, negative shrinks');
          return;
        }
        return NSO_scaleOffsetApply(fv.num);
      }
      if (fv.same) {
        if (typeof setStatus === 'function') setStatus(LABEL[k] + ': that is the current value - type a new one');
        return;
      }
      if (k === 'length' || k === 'width' || k === 'height') return NSO_scaleAxisApply(k, fv.num);
      return NSO_scaleRingApply(k, fv.num);
    }

    var BUTTON = { length: 'btn-scale-length', width: 'btn-scale-width', height: 'btn-scale-height',
                   outer: 'btn-scale-ring-outer', wall: 'btn-scale-ring-wall', diameter: 'btn-scale-rod-diameter',
                   offset: 'btn-scale-offset', factor: 'btn-scale-factor', longest: 'btn-scale-dim' };
    function wire() {
      FIELDS.forEach(function (fd) {
        var btn = document.getElementById(BUTTON[fd[0]]);
        if (btn && btn.dataset.nsoWired !== '1') {
          btn.dataset.nsoWired = '1';
          btn.addEventListener('click', function () { guarded(LABEL[fd[0]], function () { apply(fd[0], fd[1]); }); });
        }
      });
      var fit = document.getElementById('btn-scale-fit');
      if (fit && fit.dataset.nsoWired !== '1') {
        fit.dataset.nsoWired = '1';
        fit.addEventListener('click', function () { guarded('Fit to plate', NSO_scaleFitToPlate); });
      }
      var menu = document.getElementById('menu-scale');
      if (menu && menu.dataset.nsoScaleWired !== '1') {
        menu.dataset.nsoScaleWired = '1';
        menu.addEventListener('toggle', function () { if (menu.open) { readout(true); startWatch(); } });
      }
      // The verdict names the machine, so a plate change re-reads it.
      ['plate-select', 'custom-w', 'custom-d', 'custom-h'].forEach(function (id) {
        var el = document.getElementById(id);
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

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
    setTimeout(wire, 0);
  })();
}
