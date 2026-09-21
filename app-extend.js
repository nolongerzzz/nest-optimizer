// ===================== Extend: axis-preserving stretch =====================
// Headless geometry only in sections 1-5: no DOM, no Three.js, no app state,
// so the same file runs under node for the self-test (tools/nso_extend_test.js)
// and under a classic script tag in the browser. Section 6 is the commit half.
//
// Speaks rawTris, the flat Float32Array triangle soup with 9 floats per
// triangle that Cut, Soften and Sculpt all pass around.
//
// WHAT THIS IS, stated up front. Extend lengthens a piece along ONE straight
// axis and holds the cross-section perpendicular to that axis EXACTLY fixed.
// Not "nearly", not "to within a tolerance" - the two coordinates that are not
// the axis are copied through bit for bit, and the gate at the end of
// NSO_extendRaw proves it on every run. That is the whole point: the numbers a
// piece is designed around live in the cross-section. A strap's flex
// thickness, a hinge barrel's bore, a boss's screw clearance, a cable
// channel's internal width - none of them may move because the piece got
// longer. Scale-to-size moves all three axes and would change every one of
// them; that is a different tool for a different job.
//
// HOW, in one line: find a slab along the axis where the surface is a pure
// extrusion, cut there, and translate everything past the cut. No vertex is
// interpolated, no triangle is re-tessellated, the index-free soup keeps its
// exact triangle order, and only one of the three coordinates is ever written.
//
// OUT OF SCOPE, named so the next ticket does not have to re-derive it:
//
//   1. TAPERED PIECES where the taper is the functional feature. A draft
//      angle, a cone, a wedge: there is no slab with a constant cross-section
//      to insert length into, so section 4 finds no clean band and section 5
//      refuses by name. Note which case this is NOT: pin.stl's 0.1 mm end
//      chamfers are an END feature, not a taper along the axis. Its shaft is a
//      19.8 mm clean band and Extend lengthens it correctly, carrying both
//      chamfers along untouched. Measured, not assumed - see docs/EXTEND.md
//      "The pin.stl finding".
//
//   2. ORGANIC / CURVED-AXIS geometry with no single dominant straight
//      direction. A blob or a sphere has oblique normals almost everywhere on
//      every axis; section 3 measures that as an area fraction and refuses.
//      A piece whose axis is a curve (a bent tube) is the same refusal: there
//      is no ONE direction, and stretching along a chord would shear it.
//
//   3. RE-TILING A REPEATING PATTERN. Extend inserts length; it does not add
//      or renumber features. Stretching a hinge knuckle makes ONE finger
//      longer rather than adding a finger, and stretching a textured skin
//      patch stretches the border cells rather than laying down more of them.
//      Both are correct for what this tool promises and wrong for what a
//      re-tiling tool would promise. "Stretch the border, re-tile the
//      interior" is a separate, later ticket and must not be bolted on here.
//
//   4. SHORTENING. Every gate below is written for delta > 0. Removing length
//      can drive the cut past a feature at the far end and eat it, and
//      nothing here would notice. Section 5 refuses delta <= 0 by name.
//
//   5. OFF-CARDINAL AXES. See section 3: the bit-for-bit promise is only
//      deliverable when the axis is X, Y or Z, so a piece whose dominant axis
//      is oblique is refused rather than silently stretched to within a
//      rounding error. Section 3 says so with the angle it measured.

/* =====================================================================
   1. Float32 reality

   Every coordinate in a rawTris soup is a float32, whether it arrived from
   an STL on disk or from a bake inside the app. Two consequences run through
   this whole file, and both are measured rather than assumed.

   (a) YOU CANNOT LAND ON AN ARBITRARY LENGTH. Asking for 47.3 mm on a piece
       whose far face sits at x = 1400 does not give 47.3 mm, because
       fround(1400 + delta) is quantised to a 1.2e-4 mm grid. Section 5
       therefore PROBES: it applies a delta, measures what it actually got,
       corrects by the measured error, and reports the residual it could not
       remove. It never assumes the arithmetic was exact.

   (b) A FIXED TOLERANCE IS THE WRONG SHAPE for the perpendicularity test in
       section 2. Measured (tools/nso_extend_test.js, "tolerance is relative"):
       a wall triangle that is exactly parallel to the axis in real arithmetic
       reads |n.u| = 3.4e-9 at the origin and 2.8e-6 at a +1400 mm offset -
       the same triangle, the same shape, three orders of magnitude apart,
       purely from float32 spacing. A fixed 1e-6 gate passes the first and
       FAILS the second. The tolerance has to be derived from the numbers the
       triangle is actually made of.

   This is the same lesson NSO_sculptWeldTol and NSO_weldEpsFor learned about
   weld distance, arriving at the same place from the other end: there, one
   sliver poisoned a tolerance taken from the strict minimum; here, a fixed
   constant is either too tight far from the origin or too loose near it.
   Neither is a number you can pick once and write down.
   ===================================================================== */

// Spacing between consecutive float32 values at magnitude m. The unit every
// "how close is close enough" question in this file is answered in.
function NSO_extendUlp32(m) {
  m = Math.abs(+m);
  if (!(m > 0)) return 1.4012984643248171e-45;      // smallest subnormal
  if (!isFinite(m)) return Infinity;
  var b = new ArrayBuffer(4), f = new Float32Array(b), u = new Uint32Array(b);
  f[0] = m;
  if (!isFinite(f[0]) || f[0] === 0) return 1.4012984643248171e-45;
  var before = f[0];
  u[0] += 1;
  var d = f[0] - before;
  return (d > 0 && isFinite(d)) ? d : 1.4012984643248171e-45;
}

// Round to the nearest float32, the way storing into a Float32Array does.
var NSO_extendFround = (typeof Math.fround === 'function')
  ? Math.fround
  : (function () { var f = new Float32Array(1); return function (x) { f[0] = x; return f[0]; }; })();

// How far the unit normal of ONE triangle can tilt purely from float32
// storage, expressed in the same units as |n.u| - a sine, so it is directly
// comparable to the perpendicularity and cap tests in section 2.
//
// Derivation: the unnormalised normal is N = (B-A) x (C-A) and |N| = 2*area.
// Move each vertex by at most d and N moves by at most about 2*d*maxEdge, so
// the unit normal turns by at most d*maxEdge/area. d is one float32 ULP at the
// magnitude of the coordinates that actually feed the component under test:
//
//   perpendicularity (n.u):  n.u is the 2D cross product of the two edges
//                            projected into the CROSS-SECTION plane. It never
//                            touches an axis coordinate at all, so its error
//                            is driven by the cross-section coordinates only.
//   cap (|n x u|):           driven by every coordinate of the triangle.
//
// k is a safety factor on a bound that is already an over-estimate; 4 leaves
// the measured worst case about 25x inside the gate (see the test's tolerance
// table) while staying ~240x below the shallowest taper anyone drafts (1
// degree is |n.u| = 0.017).
//
// Returns { perp, cap, trusted }. trusted is false when the triangle is such a
// sliver that the bound exceeds maxPerpTol - its normal carries no usable
// direction at all, and section 4 treats an untrusted straddler as a refusal
// rather than waving it through on an enormous tolerance.
function NSO_extendTriTol(t, o, axisIdx, k, maxPerpTol) {
  k = (k > 0) ? k : 4;
  maxPerpTol = (maxPerpTol > 0) ? maxPerpTol : 1e-3;
  var ux = t[o + 3] - t[o], uy = t[o + 4] - t[o + 1], uz = t[o + 5] - t[o + 2];
  var vx = t[o + 6] - t[o], vy = t[o + 7] - t[o + 1], vz = t[o + 8] - t[o + 2];
  var wx = t[o + 6] - t[o + 3], wy = t[o + 7] - t[o + 4], wz = t[o + 8] - t[o + 5];
  var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  var twoA = Math.sqrt(nx * nx + ny * ny + nz * nz);
  var maxEdge = Math.max(
    Math.sqrt(ux * ux + uy * uy + uz * uz),
    Math.sqrt(vx * vx + vy * vy + vz * vz),
    Math.sqrt(wx * wx + wy * wy + wz * wz));
  if (!(twoA > 0) || !(maxEdge > 0)) return { perp: Infinity, cap: Infinity, trusted: false };
  var maxCross = 0, maxAny = 0;
  for (var v = 0; v < 3; v++) {
    for (var c = 0; c < 3; c++) {
      var a = Math.abs(t[o + v * 3 + c]);
      if (a > maxAny) maxAny = a;
      if (c !== axisIdx && a > maxCross) maxCross = a;
    }
  }
  var perp = k * NSO_extendUlp32(maxCross) * maxEdge / twoA;
  var cap = k * NSO_extendUlp32(maxAny) * maxEdge / twoA;
  return { perp: perp, cap: cap, trusted: (perp <= maxPerpTol) };
}

/* =====================================================================
   2. Per-axis normal census

   The one fact that decides everything: a surface patch whose normal is
   everywhere perpendicular to u is, by definition, swept by straight lines
   parallel to u. Length can be inserted into it and nothing about its shape
   changes. So classify every triangle against a candidate axis u:

     perp     |n.u| ~ 0     a side wall. Extrudable.
     cap      |n x u| ~ 0   an end face. Rides along on the translation.
     oblique  anything else. A taper, a chamfer, a curve, a dome.

   Area-weighted, because a 5000-triangle fillet and a 2-triangle wall are
   not the same amount of evidence. No feature names anywhere: the census
   does not know what a leg or a strut is, and must not learn.
   ===================================================================== */
function NSO_extendAxisCensus(rawTris, axisIdx, opts) {
  opts = opts || {};
  var n = (rawTris.length / 9) | 0;
  var perpA = 0, capA = 0, oblA = 0, totalA = 0;
  var untrusted = 0, worstPerpTol = 0;
  var mn = Infinity, mx = -Infinity;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    for (var v = 0; v < 3; v++) {
      var c = rawTris[o + v * 3 + axisIdx];
      if (c < mn) mn = c;
      if (c > mx) mx = c;
    }
    var ux = rawTris[o + 3] - rawTris[o], uy = rawTris[o + 4] - rawTris[o + 1], uz = rawTris[o + 5] - rawTris[o + 2];
    var vx = rawTris[o + 6] - rawTris[o], vy = rawTris[o + 7] - rawTris[o + 1], vz = rawTris[o + 8] - rawTris[o + 2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(L > 0)) continue;                       // degenerate: no normal, no vote
    var area = L * 0.5;
    totalA += area;
    var comp = [nx, ny, nz];
    var along = Math.abs(comp[axisIdx]) / L;      // |n.u|
    var across = Math.sqrt(Math.max(0, 1 - along * along));   // |n x u|
    var tol = NSO_extendTriTol(rawTris, o, axisIdx, opts.perpK, opts.maxPerpTol);
    if (tol.perp > worstPerpTol && isFinite(tol.perp)) worstPerpTol = tol.perp;
    if (!tol.trusted) { untrusted++; oblA += area; continue; }
    if (along <= tol.perp) perpA += area;
    else if (across <= tol.cap) capA += area;
    else oblA += area;
  }
  return {
    axisIdx: axisIdx,
    axis: 'xyz'[axisIdx],
    totalArea: totalA,
    perpArea: perpA, capArea: capA, obliqueArea: oblA,
    perpFrac: totalA > 0 ? perpA / totalA : 0,
    capFrac: totalA > 0 ? capA / totalA : 0,
    obliqueFrac: totalA > 0 ? oblA / totalA : 1,
    untrusted: untrusted,
    worstPerpTol: worstPerpTol,
    min: mn, max: mx, extent: (isFinite(mn) && isFinite(mx)) ? (mx - mn) : 0
  };
}

/* =====================================================================
   3. Which axis, and is there one at all

   Generic by construction. The census in section 2 is the only input, and
   it is a pure normal-distribution measurement - it has no notion of legs,
   struts, straps or barrels, and adding one would be a bug. The axis with
   the least oblique area is the piece's own answer to "which way am I
   straight".

   Three separate ways this refuses, each with its own name:

   NO STRAIGHT AXIS      the best axis still has more oblique area than
                         maxOblique. A sphere reads 87-97% oblique on every
                         axis; a blob 89-94%. Nothing here can be stretched
                         without shearing it.

   NO DOMINANT AXIS      two axes are equally straight AND equally long. A
                         20 mm cube is the honest example: it is a perfect
                         extrusion three different ways and the piece cannot
                         tell you which one you meant. Pass opts.axis.

   OFF-CARDINAL          the piece is straight, but not along X, Y or Z.
                         Refused on purpose. Translating by delta*u with an
                         oblique u writes all three coordinates, and the
                         cross-section then survives only to within a float32
                         rounding error instead of bit for bit. That is a
                         different promise from the one at the top of this
                         file, so it gets a different mode, not a quiet
                         downgrade here. Rotate the piece onto an axis first.
                         Diagnosed from the area-weighted normal covariance,
                         whose least eigenvector is the best straight
                         direction in the continuum, not just among the three.
   ===================================================================== */

// Least-eigenvector of the area-weighted normal covariance: the best straight
// axis over ALL directions, used only to tell an off-cardinal piece from a
// genuinely curved one so the refusal can say which it is.
function NSO_extendCovarianceAxis(rawTris) {
  var n = (rawTris.length / 9) | 0, total = 0;
  var m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    var ux = rawTris[o + 3] - rawTris[o], uy = rawTris[o + 4] - rawTris[o + 1], uz = rawTris[o + 5] - rawTris[o + 2];
    var vx = rawTris[o + 6] - rawTris[o], vy = rawTris[o + 7] - rawTris[o + 1], vz = rawTris[o + 8] - rawTris[o + 2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(L > 0)) continue;
    var a = L * 0.5; nx /= L; ny /= L; nz /= L; total += a;
    var u3 = [nx, ny, nz];
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) m[i][j] += a * u3[i] * u3[j];
  }
  if (!(total > 0)) return null;
  for (var i2 = 0; i2 < 3; i2++) for (var j2 = 0; j2 < 3; j2++) m[i2][j2] /= total;
  // Jacobi. 3x3 symmetric, converges in a handful of sweeps.
  var V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (var s = 0; s < 64; s++) {
    var p = 0, q = 1, best = Math.abs(m[0][1]);
    if (Math.abs(m[0][2]) > best) { best = Math.abs(m[0][2]); p = 0; q = 2; }
    if (Math.abs(m[1][2]) > best) { best = Math.abs(m[1][2]); p = 1; q = 2; }
    if (best < 1e-18) break;
    var th = 0.5 * Math.atan2(2 * m[p][q], m[q][q] - m[p][p]);
    var c = Math.cos(th), sn = Math.sin(th), k;
    for (k = 0; k < 3; k++) { var akp = m[k][p], akq = m[k][q]; m[k][p] = c * akp - sn * akq; m[k][q] = sn * akp + c * akq; }
    for (k = 0; k < 3; k++) { var apk = m[p][k], aqk = m[q][k]; m[p][k] = c * apk - sn * aqk; m[q][k] = sn * apk + c * aqk; }
    for (k = 0; k < 3; k++) { var vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - sn * vkq; V[k][q] = sn * vkp + c * vkq; }
  }
  var ev = [
    { v: [V[0][0], V[1][0], V[2][0]], l: m[0][0] },
    { v: [V[0][1], V[1][1], V[2][1]], l: m[1][1] },
    { v: [V[0][2], V[1][2], V[2][2]], l: m[2][2] }
  ].sort(function (a2, b2) { return a2.l - b2.l; });
  var u = ev[0].v;
  var ab = [Math.abs(u[0]), Math.abs(u[1]), Math.abs(u[2])];
  var k2 = ab.indexOf(Math.max(ab[0], ab[1], ab[2]));
  var offSin = Math.sqrt(Math.max(0, 1 - ab[k2] * ab[k2]));
  return {
    axis: u, eigen: [ev[0].l, ev[1].l, ev[2].l],
    nearestCardinal: k2, offAxisSin: offSin,
    offAxisDeg: Math.asin(Math.min(1, offSin)) * 180 / Math.PI
  };
}

// opts.axis          'x'|'y'|'z'|0|1|2 - skip detection, use this axis
// opts.maxOblique    default 0.5. The cheap early-out only: the real gate on
//                    "can length be inserted here" is the band scan in
//                    section 4, which is local and exact. This one exists to
//                    give a blob a clear refusal instead of a confusing one.
// opts.offAxisDeg    default 1.0. Above this the covariance axis counts as
//                    off-cardinal and the refusal says so.
// opts.tieFrac       default 0.01. Two axes whose oblique fractions are
//                    within this are "equally straight" and the tie goes to
//                    the longer one; if the extents are also within tieFrac
//                    of each other, there is no dominant axis.
function NSO_extendDetectAxis(rawTris, opts) {
  opts = opts || {};
  var out = { ok: false, reason: '', census: null };
  if (!rawTris || rawTris.length < 9 || (rawTris.length % 9) !== 0) {
    out.reason = 'not a triangle soup'; return out;
  }
  var census = [
    NSO_extendAxisCensus(rawTris, 0, opts),
    NSO_extendAxisCensus(rawTris, 1, opts),
    NSO_extendAxisCensus(rawTris, 2, opts)
  ];
  out.census = census;

  if (opts.axis != null) {
    var forced = (typeof opts.axis === 'string') ? 'xyz'.indexOf(opts.axis.toLowerCase()) : (opts.axis | 0);
    if (!(forced >= 0 && forced <= 2)) { out.reason = 'opts.axis must be x, y, z, 0, 1 or 2'; return out; }
    out.ok = true; out.axisIdx = forced; out.axis = 'xyz'[forced];
    out.forced = true; out.best = census[forced];
    return out;
  }

  var maxOblique = (opts.maxOblique == null) ? 0.5 : +opts.maxOblique;
  var tieFrac = (opts.tieFrac == null) ? 0.01 : +opts.tieFrac;
  var offAxisDeg = (opts.offAxisDeg == null) ? 1.0 : +opts.offAxisDeg;

  var order = census.slice().sort(function (a, b) { return a.obliqueFrac - b.obliqueFrac; });
  var best = order[0];
  out.cov = NSO_extendCovarianceAxis(rawTris);

  if (best.obliqueFrac > maxOblique) {
    // Curved, or straight but not along a coordinate axis. Say which.
    if (out.cov && out.cov.offAxisDeg > offAxisDeg && out.cov.eigen[1] / Math.max(out.cov.eigen[0], 1e-18) > 1.5) {
      out.reason = 'dominant axis is off-cardinal by ' + out.cov.offAxisDeg.toFixed(2) +
        ' deg - Extend holds the cross-section bit-for-bit only on X, Y or Z; rotate the piece onto an axis first';
      out.offCardinal = true;
      return out;
    }
    out.reason = 'no dominant straight axis - best is ' + best.axis + ' with ' +
      (best.obliqueFrac * 100).toFixed(1) + '% of surface area oblique (limit ' +
      (maxOblique * 100).toFixed(0) + '%); this piece is curved or tapered on every axis';
    return out;
  }

  // Equally straight? Then the longer one is the dominant one.
  var ties = census.filter(function (c) { return (c.obliqueFrac - best.obliqueFrac) <= tieFrac; });
  if (ties.length > 1) {
    ties.sort(function (a, b) { return b.extent - a.extent; });
    var longest = ties[0], runner = ties[1];
    var rel = longest.extent > 0 ? (longest.extent - runner.extent) / longest.extent : 0;
    if (rel <= tieFrac) {
      out.reason = 'no single dominant axis - ' + ties.length + ' axes (' +
        ties.map(function (c) { return c.axis; }).join(', ') + ') are equally straight and within ' +
        (tieFrac * 100).toFixed(0) + '% of the same length; pass opts.axis to say which one you meant';
      out.ambiguous = true;
      out.tied = ties.map(function (c) { return c.axis; });
      return out;
    }
    best = longest;
  }
  out.ok = true; out.axisIdx = best.axisIdx; out.axis = best.axis; out.best = best;
  return out;
}

/* =====================================================================
   4. Where to cut

   The vertices' own coordinates along the axis fall into distinct layers.
   Between two consecutive layers is a gap that no vertex lies inside, so a
   cut plane placed strictly inside it classifies every vertex unambiguously
   as above or below - no vertex sits ON the plane, and the classification
   cannot flip on a rounding.

   A gap is CLEAN when every triangle straddling it is perpendicular to the
   axis. That is the whole correctness argument, and it is worth stating
   exactly because it is stronger than it looks:

     A triangle with n.u = 0 lies in a plane that CONTAINS u. Translating any
     subset of its vertices along u leaves all three vertices in that same
     plane. So the triangle stays planar, keeps its normal, and stays on the
     same swept surface. It is not approximately preserved - it is the same
     face, longer.

   Triangles entirely below the cut do not move. Triangles entirely above it
   translate rigidly. Triangles straddling it stretch inside their own plane.
   Nothing is split, nothing is interpolated, the triangle count and the
   triangle ORDER are identical, and vertices that were coincident stay
   coincident because the shift is a function of the coordinate.

   Band choice: widest wins, because the widest band is the furthest from
   whatever features sit at either end. Among bands within 1% of the widest,
   the one nearest the middle of the piece wins, for the same reason.
   ===================================================================== */

// opts.minBandFrac  default 1e-3 of the axis extent. Only excludes gaps too
//                   thin to be a real slab; the ULP floor below is the one
//                   that actually protects the arithmetic.
// opts.minBandUlps  default 64. The gap must be at least this many float32
//                   ULPs wide at its own magnitude, so that its midpoint is
//                   strictly between the two layers and not equal to either.
function NSO_extendBands(rawTris, axisIdx, opts) {
  opts = opts || {};
  var out = { ok: false, reason: '', bands: [], clean: [], layers: 0 };
  var n = (rawTris.length / 9) | 0;
  var set = new Set();
  for (var t = 0; t < n; t++) for (var v = 0; v < 3; v++) set.add(rawTris[t * 9 + v * 3 + axisIdx]);
  var layers = Array.from(set).sort(function (a, b) { return a - b; });
  out.layers = layers.length;
  if (layers.length < 2) { out.reason = 'piece is flat along ' + 'xyz'[axisIdx]; return out; }
  var extent = layers[layers.length - 1] - layers[0];
  var minFrac = (opts.minBandFrac == null) ? 1e-3 : +opts.minBandFrac;
  var minUlps = (opts.minBandUlps == null) ? 64 : +opts.minBandUlps;
  var mid = (layers[0] + layers[layers.length - 1]) / 2;

  for (var i = 0; i < layers.length - 1; i++) {
    var lo = layers[i], hi = layers[i + 1], w = hi - lo;
    var cut = lo + w / 2;
    var band = {
      lo: lo, hi: hi, width: w, cut: cut,
      straddling: 0, worstAlong: 0, worstTol: 0, untrusted: 0, oblique: 0,
      clean: false, why: ''
    };
    out.bands.push(band);
    var ulpHere = NSO_extendUlp32(Math.max(Math.abs(lo), Math.abs(hi)));
    if (!(w >= minUlps * ulpHere)) { band.why = 'gap is ' + (w / ulpHere).toFixed(1) + ' ULPs wide, under ' + minUlps; continue; }
    if (!(w >= minFrac * extent)) { band.why = 'gap is ' + (100 * w / extent).toFixed(4) + '% of the extent, under ' + (100 * minFrac).toFixed(2) + '%'; continue; }
    if (!(cut > lo && cut < hi)) { band.why = 'midpoint is not strictly inside the gap in float64'; continue; }

    for (var t2 = 0; t2 < n; t2++) {
      var o = t2 * 9;
      var above = (rawTris[o + axisIdx] > cut) + (rawTris[o + 3 + axisIdx] > cut) + (rawTris[o + 6 + axisIdx] > cut);
      if (above === 0 || above === 3) continue;
      band.straddling++;
      var ux = rawTris[o + 3] - rawTris[o], uy = rawTris[o + 4] - rawTris[o + 1], uz = rawTris[o + 5] - rawTris[o + 2];
      var vx = rawTris[o + 6] - rawTris[o], vy = rawTris[o + 7] - rawTris[o + 1], vz = rawTris[o + 8] - rawTris[o + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
      var tol = NSO_extendTriTol(rawTris, o, axisIdx, opts.perpK, opts.maxPerpTol);
      if (isFinite(tol.perp) && tol.perp > band.worstTol) band.worstTol = tol.perp;
      if (!(L > 0) || !tol.trusted) { band.untrusted++; continue; }
      var along = Math.abs([nx, ny, nz][axisIdx]) / L;
      if (along > band.worstAlong) band.worstAlong = along;
      if (along > tol.perp) { band.oblique = (band.oblique || 0) + 1; }
    }
    if (band.straddling === 0) { band.why = 'no triangle crosses it - the piece is in two disconnected halves here'; continue; }
    if (band.untrusted > 0) { band.why = band.untrusted + ' straddling triangle(s) are slivers whose normal carries no usable direction'; continue; }
    if (band.oblique > 0) { band.why = band.oblique + ' of ' + band.straddling + ' straddling triangles are oblique (worst |n.u| ' + band.worstAlong.toExponential(2) + ' against a derived tolerance of ' + band.worstTol.toExponential(2) + ')'; continue; }
    band.clean = true;
    band.why = 'clean';
    out.clean.push(band);
  }

  if (!out.clean.length) {
    var widest = out.bands.slice().sort(function (a, b) { return b.width - a.width; })[0];
    out.reason = 'no constant cross-section band along ' + 'xyz'[axisIdx] + ' - ' +
      out.bands.length + ' gap(s) examined, none clean; widest (' + widest.width.toFixed(4) +
      ' mm) failed because ' + widest.why;
    return out;
  }
  var maxW = out.clean.reduce(function (a, b) { return Math.max(a, b.width); }, 0);
  var shortlist = out.clean.filter(function (b) { return b.width >= maxW * 0.99; });
  shortlist.sort(function (a, b) { return Math.abs(a.cut - mid) - Math.abs(b.cut - mid); });
  out.ok = true;
  out.best = shortlist[0];
  return out;
}

/* =====================================================================
   5. The stretch

   One coordinate is written. The other two are never touched, and the gate
   at the bottom proves it by comparing them element by element against the
   input rather than trusting that the loop did what it says.
   ===================================================================== */

// The bridge to the eventual "click an attachment point" UI, and deliberately
// the whole of it. The interaction is a picker; the primitive underneath is
// still "stretch to length N", so the picker only ever has to turn a point
// into a number and hand it over. Nothing else in this file knows the UI
// exists. See docs/EXTEND.md "What the UI is not, yet".
function NSO_extendLengthToReach(rawTris, axisIdx, targetCoord) {
  var n = (rawTris.length / 9) | 0, mn = Infinity, mx = -Infinity;
  for (var t = 0; t < n; t++) for (var v = 0; v < 3; v++) {
    var c = rawTris[t * 9 + v * 3 + axisIdx];
    if (c < mn) mn = c; if (c > mx) mx = c;
  }
  return { min: mn, max: mx, current: mx - mn, length: targetCoord - mn, gap: targetCoord - mx };
}

// opts.length    target extent along the detected axis, in mm
// opts.delta     add this much instead (mutually exclusive with length)
// opts.axis      force the axis, see NSO_extendDetectAxis
// opts.cut       force the cut coordinate, skipping the band scan's choice.
//                Still checked against the band scan - a forced cut that is
//                not inside a clean band is a refusal, not an override.
// opts.gate      default true
// opts.lengthUlps  default 2. How many float32 ULPs of residual length error
//                  are acceptable. NOT a millimetre figure: at 20 mm one ULP
//                  is 1.9e-6 mm and at 1500 mm it is 1.2e-4 mm, and no amount
//                  of care lands closer than the grid the coordinates live on.
//
// Returns { ok, reason, tris, ... }. On refusal tris is the ORIGINAL soup, so
// the caller can swap unconditionally - the same contract NSO_smoothGlobal has.
function NSO_extendRaw(rawTris, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '', tris: rawTris };
  if (!rawTris || rawTris.length < 9 || (rawTris.length % 9) !== 0) { res.reason = 'not a triangle soup'; return res; }

  var det = NSO_extendDetectAxis(rawTris, opts);
  res.detect = det;
  if (!det.ok) { res.reason = det.reason; return res; }
  var k = det.axisIdx;
  res.axisIdx = k; res.axis = det.axis;

  var span = NSO_extendLengthToReach(rawTris, k, 0);
  var len0 = span.current;
  res.lengthBefore = len0;
  if (!(len0 > 0)) { res.reason = 'piece has no extent along ' + det.axis; return res; }

  var target;
  if (opts.length != null) target = +opts.length;
  else if (opts.delta != null) target = len0 + (+opts.delta);
  else { res.reason = 'Extend needs opts.length or opts.delta'; return res; }
  if (!isFinite(target)) { res.reason = 'target length is not a finite number'; return res; }
  res.lengthTarget = target;

  var want = target - len0;
  if (!(want > 0)) {
    res.reason = 'Extend lengthens only - asked for ' + target.toFixed(4) + ' mm along ' +
      det.axis + ' but the piece is already ' + len0.toFixed(4) +
      ' mm; shortening would have to remove material and is out of scope';
    return res;
  }

  var scan = NSO_extendBands(rawTris, k, opts);
  res.bands = scan;
  if (!scan.ok) { res.reason = scan.reason; return res; }
  var band = scan.best;
  if (opts.cut != null) {
    var forcedCut = +opts.cut;
    var host = scan.clean.filter(function (b) { return forcedCut > b.lo && forcedCut < b.hi; })[0];
    if (!host) { res.reason = 'forced cut at ' + forcedCut + ' is not inside any clean band along ' + det.axis; return res; }
    band = { lo: host.lo, hi: host.hi, width: host.width, cut: forcedCut, straddling: host.straddling, worstAlong: host.worstAlong, worstTol: host.worstTol, clean: true, why: 'clean (forced cut)' };
  }
  res.cut = band.cut;
  res.band = band;

  // --- the float32 probe (section 1a). Predict, apply, MEASURE, correct. ---
  // fround(oldMax + delta) is a step function of delta, so the first guess
  // usually lands a fraction of an ULP off and no amount of algebra fixes it.
  // Measure the miss, add it back, keep whichever attempt actually measured
  // closest, and report the residual rather than claiming exactness.
  var oldMax = span.max, oldMin = span.min;
  var delta = want, bestDelta = want, bestErr = Infinity, probes = [];
  for (var it = 0; it < 4; it++) {
    var achieved = NSO_extendFround(oldMax + delta) - oldMin;
    var err = target - achieved;
    probes.push({ delta: delta, achieved: achieved, err: err });
    if (Math.abs(err) < Math.abs(bestErr)) { bestErr = err; bestDelta = delta; }
    if (err === 0) break;
    delta = delta + err;
  }
  res.probes = probes;
  delta = bestDelta;
  res.delta = delta;

  // --- apply: one coordinate, one function of it, nothing else ---
  var out = new Float32Array(rawTris);            // copies all three coords verbatim
  var cut = band.cut, n = (rawTris.length / 9) | 0;
  var movedVerts = 0;
  var beforeLayers = new Set(), afterLayers = new Set();
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    for (var v = 0; v < 3; v++) {
      var idx = o + v * 3 + k, c = rawTris[idx];
      if (c > cut) {
        var nc = NSO_extendFround(c + delta);
        out[idx] = nc;
        movedVerts++;
        beforeLayers.add(c); afterLayers.add(nc);
      }
    }
  }
  res.movedVertexRefs = movedVerts;
  res.movedLayers = beforeLayers.size;

  // --- gates. Every one of them measured on `out`, not predicted. ---
  if (opts.gate == null || opts.gate) {
    var bad = null;

    // 1. The promise. Both cross-section coordinates, every vertex, bit for
    //    bit. Cheap, total, and the reason this tool exists.
    var drift = 0, firstDrift = -1;
    for (var i = 0; i < rawTris.length; i++) {
      if ((i % 3) === k) continue;
      if (out[i] !== rawTris[i]) { drift++; if (firstDrift < 0) firstDrift = i; }
    }
    res.crossSectionDrift = drift;
    if (drift) bad = 'cross-section moved: ' + drift + ' non-axis coordinate(s) differ, first at float ' + firstDrift;

    // 2. The shift must stay injective. Two distinct layers rounding onto the
    //    same float32 would collapse a slab into nothing, and every edge and
    //    volume check downstream would still pass on the wreckage.
    else if (afterLayers.size !== beforeLayers.size) {
      bad = 'float32 shift collapsed ' + (beforeLayers.size - afterLayers.size) + ' of ' +
        beforeLayers.size + ' distinct layers onto each other';
    }

    else {
      // 3. Length actually achieved, measured off the output.
      var spanAfter = NSO_extendLengthToReach(out, k, 0);
      res.lengthAfter = spanAfter.current;
      res.residual = target - spanAfter.current;
      var ulpTol = ((opts.lengthUlps == null) ? 2 : +opts.lengthUlps) *
        NSO_extendUlp32(Math.max(Math.abs(spanAfter.min), Math.abs(spanAfter.max)));
      res.residualUlpTol = ulpTol;
      if (Math.abs(res.residual) > ulpTol) {
        bad = 'length landed ' + res.residual.toExponential(3) + ' mm off ' + target +
          ', outside ' + (opts.lengthUlps == null ? 2 : opts.lengthUlps) + ' float32 ULPs (' +
          ulpTol.toExponential(3) + ' mm) at this coordinate magnitude';
      }
      // 4. Order preserved: nothing that was below the cut may end up above
      //    something that was above it.
      else if (!(spanAfter.min === oldMin)) {
        bad = 'the fixed end moved: min was ' + oldMin + ', is now ' + spanAfter.min;
      }
    }

    if (bad) { res.reason = bad; res.tris = rawTris; return res; }
  } else {
    var spanNG = NSO_extendLengthToReach(out, k, 0);
    res.lengthAfter = spanNG.current;
    res.residual = target - spanNG.current;
  }

  // --- evidence, when the sculpt tier is loaded alongside ---
  if (typeof NSO_buildAdjacency === 'function' && typeof NSO_sculptMetrics === 'function') {
    var adjB = NSO_buildAdjacency(rawTris, {});
    var adjA = NSO_buildAdjacency(out, {});
    res.before = NSO_sculptMetrics(rawTris, adjB);
    res.after = NSO_sculptMetrics(out, adjA);
    if (opts.gate == null || opts.gate) {
      var t2bad = null;
      if (res.after.tris !== res.before.tris) t2bad = 'triangle count changed';
      else if (adjB.ok && adjA.ok && adjA.vertCount !== adjB.vertCount) t2bad = 'welded vertex count changed ' + adjB.vertCount + '->' + adjA.vertCount;
      else if (res.after.openPos > res.before.openPos) t2bad = 'open edges rose ' + res.before.openPos + '->' + res.after.openPos;
      else if (res.after.nmPos > res.before.nmPos) t2bad = 'non-manifold edges rose ' + res.before.nmPos + '->' + res.after.nmPos;
      else if (res.after.degenerate > res.before.degenerate) t2bad = 'degenerate triangles rose ' + res.before.degenerate + '->' + res.after.degenerate;
      else if (!(Math.abs(res.after.volume) > Math.abs(res.before.volume))) t2bad = 'volume did not grow (' + res.before.volume.toFixed(4) + ' -> ' + res.after.volume.toFixed(4) + ') - a longer piece has more material in it';
      if (t2bad) { res.reason = t2bad; res.tris = rawTris; return res; }
    }
    // The volume a stretch adds is the cut's cross-section times the shift.
    // Reported, not gated: it is the number that says what was actually swept.
    res.impliedCrossSection = (Math.abs(res.after.volume) - Math.abs(res.before.volume)) / delta;
  }

  res.ok = true;
  res.tris = out;
  return res;
}

/* =====================================================================
   6. App wiring

   commit() half of the house lifecycle, reusing NSO_sculptCommitRaw from
   app-sculpt.js verbatim rather than copying it: undo entry first, display
   geometry rebuilt from the new rawTris, placed instance re-seated. The undo
   type is its own string so the status line names Extend and not Smooth.
   ===================================================================== */

// PAINT SCOPE: WHOLE-PIECE. Per the scoping rule in docs/HANDOFF.md, the
// question is whether this feature acts on an identifiable sub-region. It does
// not. The cut plane splits the piece in two and translates one half, so every
// face on the moving side changes position and every side wall the cut passes
// through changes extent. There is no face Extend can promise to leave exactly
// where it was, which is precisely the promise the paint rule demands. So any
// paint anywhere on the piece stands the whole bake down, naming the count.
// nsoMaskCount(m) is the whole test.
function NSO_extendSelectedModel(opts) {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  if (!m) {
    if (typeof setStatus === 'function') setStatus('Select a piece first', true);
    return { ok: false, reason: 'no selection' };
  }
  var soupIn = (m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null;
  if (!soupIn) {
    if (typeof setStatus === 'function') setStatus('Extend needs a raw piece - unchanged', true);
    return { ok: false, reason: 'no rawTris' };
  }
  var paintedCount = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (paintedCount > 0) {
    if (typeof setStatus === 'function') {
      setStatus('Extend stood down - ' + paintedCount + ' painted face(s); the cut plane moves ' +
                'every face on one side of it. Clear paint to extend.', true);
    }
    return { ok: false, reason: 'painted faces: ' + paintedCount, painted: paintedCount };
  }
  opts = opts || {};
  var r = NSO_extendRaw(soupIn, opts);
  if (!r.ok) {
    if (typeof setStatus === 'function') setStatus('Extend refused - piece unchanged (' + r.reason + ')', true);
    return r;
  }
  var txt = 'Extend done - ' + r.axis.toUpperCase() + ' ' + r.lengthBefore.toFixed(3) +
    ' → ' + r.lengthAfter.toFixed(3) + ' mm, cut at ' + r.cut.toFixed(3) +
    ', cross-section unchanged (0 drifted coordinates)';
  NSO_extendCommit(m, r.tris, txt);
  return r;
}

function NSO_extendCommit(m, working, statusText) {
  if (typeof NSO_sculptCommitRaw === 'function') return NSO_sculptCommitRaw(m, working, 'extendReplace', statusText);
  return false;
}

/* ---------------------------------------------------------------------------
   UI entry point. A length box and a button, and that is the whole of it for
   this ticket.

   What it is NOT, on purpose: the "click the leg, click the attachment point,
   read the gap, confirm" flow. That flow is orchestration - a picker, a
   hit-test, a preview, and a chain into Seat-against-curved and washer
   placement - and none of it can be trusted until the primitive underneath is
   proven in isolation, which is what this ticket is for. The primitive it
   would call is already here and already exercised by the self-test:
   NSO_extendLengthToReach turns a picked coordinate into the number this box
   holds. See docs/EXTEND.md "What the UI is not, yet".

   Blank box: rather than failing, the first click reports what the piece
   actually is - detected axis and current length - and fills the box with it,
   so the user edits a real number instead of guessing one.
--------------------------------------------------------------------------- */
if (typeof document !== 'undefined') {
  (function wireExtendButton() {
    function wire() {
      var btn = document.getElementById('btn-extend');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () {
        try {
          var inp = document.getElementById('inp-extend-mm');
          var want = inp ? parseFloat(inp.value) : NaN;
          if (!(want > 0)) {
            var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
            var soup = (m && m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null;
            if (!soup) {
              if (typeof setStatus === 'function') setStatus('Select a raw piece first', true);
              return;
            }
            var det = NSO_extendDetectAxis(soup, {});
            if (!det.ok) {
              if (typeof setStatus === 'function') setStatus('Extend refused - ' + det.reason, true);
              return;
            }
            var sp = NSO_extendLengthToReach(soup, det.axisIdx, 0);
            if (inp) inp.value = sp.current.toFixed(2);
            if (typeof setStatus === 'function') {
              setStatus('Extend: this piece is ' + sp.current.toFixed(2) + ' mm along ' +
                        det.axis.toUpperCase() + '. Set a longer target and press Extend.');
            }
            return;
          }
          NSO_extendSelectedModel({ length: want });
        } catch (err) {
          console.error('[extend]', err);
          if (typeof setStatus === 'function') {
            setStatus('Extend failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
          }
        }
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
