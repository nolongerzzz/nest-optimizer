// ===================== Section reader: what shape is this piece? =====================
// Headless: no DOM, no Three.js, no app state. Runs under node for the
// self-test (tools/nso_section_test.js) and under a classic script tag in the
// browser, where the Scale card reads its first line from it.
//
// Given a raw soup (Z-up, print frame, 9 floats per triangle) it answers
//
//   { shape: 'round' | 'rectangular' | 'other', hollow, axis, lengthMm,
//     outer, bore, wallMm, reason, ... }
//
// so a tool can offer only what applies: a ring's outer / bore / wall, a bar's
// width / depth, and nothing of either for a piece that is neither.
//
// NOTHING HERE IS A SECOND COPY. Three things are read, and each one is the
// existing tool's own code:
//
//   the axis     NSO_extendDetectAxis (app-extend.js) - same scope, same
//                refusals. One exception, taken the way nso_stock.js's
//                proportionsFrom already takes it: AMBIGUOUS (a cube, a
//                square bar) is not a refusal here. Extend refuses it because
//                it cannot tell which axis to lengthen; a cube's section is the
//                same along every tied axis, so reading it is exactly right.
//                The longest tied axis stands in and `axisTied` lists them all.
//   the run      NSO_extendBands (app-extend.js) - the clean constant-section
//                gaps Extend cuts in. Where the section is constant is the
//                question "is this an extrusion" asks, and Extend has already
//                answered it per gap.
//   the section  rawCutOpen -> rawPlaneBoundaryEdges -> rawBuildLoopsFromCutEdges
//                (app-cut.js) - the Cut tool's own loop walker, at mid-length -
//                and rawNestLoops, the nesting rule rawFlatCapLoops caps by.
//
// WHAT THIS ADDS is two fits on the outer loop, each with a stated tolerance,
// and the order the gates run in. Every `other` carries a worded reason.
//
// THE GATES, in order; the first that fails names the answer:
//
//   1. a straight axis           Extend's detector. "no straight axis: ..."
//   2. a constant section        the clean run through mid-length covers at
//                                least NSO_SECTION_MIN_RUN of the length. A
//                                capsule's barrel is half of it; its domes are
//                                not "a rod of length L", whatever the middle
//                                says.
//   3. the loops                 1 loop is solid, a loop inside a loop is
//                                hollow, anything else is `other`.
//   4. the fit                   outer loop round or rectangular, within
//                                tolerance; a bore the same class as the outer
//                                and, if round, concentric.
//
// TOLERANCES, stated:
//
//   round        the whole loop - vertices AND edges, measured exactly per
//                segment - inside an annulus max(0.05 mm, 1% of r) wide about
//                its fitted centre, r being the circle the vertices sit on
//                (their mean radius). 1% admits any regular tessellation of 23 or more
//                segments (sagitta r(1 - cos(pi/n)) <= 0.01 r for n >= 22.2);
//                the 0.05 mm floor is under a 0.4 mm nozzle's resolution. An
//                8-gon of r 10 is 0.76 mm off and reads as an octagon, not a
//                rod.
//   rectangular  every point of the loop within max(0.05 mm, 1% of the shorter
//                side) of the loop's own axis-aligned bounding rectangle,
//                measured exactly per segment (the distance to the rectangle's
//                boundary is the min of four linear functions along a segment,
//                so its maximum is at an end or where two of them cross).
//   concentric   a round bore's centre within the bore's own round tolerance
//                of the outer centre.
//
// IN PRINT TERMS. The raw soup IS the print frame: x is the bed's width (W),
// y its depth (D), z the height (H) - nso_printer.js's fromDisplaySize writes
// down the same mapping from the other side. `sizes` is the bounding box in
// those terms. A bar's section is reported as widthMm >= depthMm, the wider
// side first, so the answer does not depend on which way the piece is turned.

var NSO_SECTION_MIN_RUN = 0.9;          // constant section over >= 90% of the length
var NSO_SECTION_TOL_FLOOR_MM = 0.05;    // absolute floor on both fit tolerances
var NSO_SECTION_TOL_FRAC = 0.01;        // relative part: of r (round), of the shorter side (rect)

/* The circle a loop is round to. The CENTRE is the least-squares (Kasa) fit
   through the loop's points, centred on their mean for conditioning. The
   RADIUS is the circle the outline is inscribed in - the MEAN distance of its
   corner points (its vertices) from that centre - because that is the circle
   a tessellator put the vertices on: a revolved 96-gon of radius r has every
   vertex at exactly r and its chords dip inside, never outside. The
   least-squares radius would land between the two and report neither the
   generator's r nor anything a caliper reads. The mean rather than the
   largest, because a real export is not a perfect polygon: MINI_TPU_TEST's
   outer vertices sit at r 9.9995 - 10.0006, and the largest alone reads
   Ø20.0012 where the mean reads Ø20.0000.

   The DEVIATION is the width of the thinnest annulus about that centre that
   holds the whole closed polyline, measured exactly per segment: the distance
   to the centre is convex along a segment, so its extremes are the two ends
   and the foot of the perpendicular. For a regular n-gon it is the sagitta
   r(1 - cos(pi/n)): 0.0107 mm at r 20, n 96; 0.761 mm at r 10, n 8. */
function NSO_sectionFitCircle(p2) {
  var n = p2.length, mx = 0, my = 0, i;
  for (i = 0; i < n; i++) { mx += p2[i][0]; my += p2[i][1]; }
  mx /= n; my /= n;
  var Suu = 0, Svv = 0, Suv = 0, Suuu = 0, Svvv = 0, Suvv = 0, Svuu = 0;
  for (i = 0; i < n; i++) {
    var u = p2[i][0] - mx, v = p2[i][1] - my;
    Suu += u * u; Svv += v * v; Suv += u * v;
    Suuu += u * u * u; Svvv += v * v * v; Suvv += u * v * v; Svuu += v * u * u;
  }
  var det = Suu * Svv - Suv * Suv;
  if (!(Math.abs(det) > 0)) return null;
  var bu = 0.5 * (Suuu + Suvv), bv = 0.5 * (Svvv + Svuu);
  var c = [(bu * Svv - bv * Suv) / det + mx, (Suu * bv - Suv * bu) / det + my];
  var rMax = 0, rMin = Infinity, rad = new Array(n);
  for (i = 0; i < n; i++) rad[i] = Math.hypot(p2[i][0] - c[0], p2[i][1] - c[1]);
  // The corners: points at least as far out as both neighbours. Where the
  // section crosses a wall quad's diagonal it lands mid-chord, a sagitta
  // inside the circle; where it crosses a vertical edge it lands on a vertex.
  // The corners are the vertices, and their MEAN radius is the circle they
  // were put on - the largest alone would let one noisy vertex set the size.
  var rSum = 0, rCnt = 0;
  for (i = 0; i < n; i++) {
    if (rad[i] >= rad[(i + n - 1) % n] && rad[i] >= rad[(i + 1) % n]) { rSum += rad[i]; rCnt++; }
  }
  for (i = 0; i < n; i++) {
    var a = p2[i], b = p2[(i + 1) % n];
    var ax = a[0] - c[0], ay = a[1] - c[1], ex = b[0] - a[0], ey = b[1] - a[1];
    var d0 = Math.hypot(ax, ay);
    var L2 = ex * ex + ey * ey, t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * ex + ay * ey) / L2)) : 0;
    var dm = Math.hypot(ax + t * ex, ay + t * ey);
    if (d0 > rMax) rMax = d0;
    if (d0 < rMin) rMin = d0;
    if (dm < rMin) rMin = dm;
  }
  var r = rCnt ? rSum / rCnt : rMax;
  return { center: c, r: r, rMax: rMax, rMin: rMin, corners: rCnt, devMm: rMax - rMin,
           tolMm: Math.max(NSO_SECTION_TOL_FLOOR_MM, NSO_SECTION_TOL_FRAC * r) };
}

/* The loop against its own axis-aligned bounding rectangle. */
function NSO_sectionFitRect(p2) {
  var n = p2.length, u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity, i;
  for (i = 0; i < n; i++) {
    var p = p2[i];
    if (p[0] < u0) u0 = p[0]; if (p[0] > u1) u1 = p[0];
    if (p[1] < v0) v0 = p[1]; if (p[1] > v1) v1 = p[1];
  }
  // Distance to the boundary of the rectangle, for a point inside it, is
  // min(u-u0, u1-u, v-v0, v1-v): four linear functions of t along a segment.
  function lin(a, b) {
    return [[a[0] - u0, b[0] - a[0]], [u1 - a[0], a[0] - b[0]], [a[1] - v0, b[1] - a[1]], [v1 - a[1], a[1] - b[1]]];
  }
  function at(f, t) { var m = Infinity; for (var k = 0; k < 4; k++) m = Math.min(m, f[k][0] + f[k][1] * t); return m; }
  var dev = 0;
  for (i = 0; i < n; i++) {
    var f = lin(p2[i], p2[(i + 1) % n]);
    var ts = [0, 1];
    for (var j = 0; j < 4; j++) for (var k = j + 1; k < 4; k++) {
      var ds = f[j][1] - f[k][1];
      if (ds !== 0) { var tt = (f[k][0] - f[j][0]) / ds; if (tt > 0 && tt < 1) ts.push(tt); }
    }
    for (var q = 0; q < ts.length; q++) dev = Math.max(dev, at(f, ts[q]));
  }
  var su = u1 - u0, sv = v1 - v0;
  return { lo: [u0, v0], hi: [u1, v1], span: [su, sv], devMm: dev,
           tolMm: Math.max(NSO_SECTION_TOL_FLOOR_MM, NSO_SECTION_TOL_FRAC * Math.min(su, sv)) };
}

/* Both fits on one loop, and which class (if any) it is. */
function NSO_sectionClassLoop(p2) {
  var c = NSO_sectionFitCircle(p2), r = NSO_sectionFitRect(p2);
  var cls = null;
  if (c && c.devMm <= c.tolMm) cls = 'round';
  else if (r.devMm <= r.tolMm) cls = 'rectangular';
  // The nearer miss, for the reason: whichever is fewer of its own tolerances off.
  var nearer = (c && c.devMm / c.tolMm <= r.devMm / r.tolMm) ? 'round' : 'rectangular';
  return { cls: cls, circle: c, rect: r, nearer: nearer };
}

/* The clean constant-section run through a plane, from Extend's own band scan.
   A run is a maximal chain of consecutive clean gaps; it breaks at a gap that
   is not clean and at any layer that carries a face lying IN it (a shoulder, a
   step) - two clean gaps either side of a step have different sections. */
function NSO_sectionRuns(soup, k, bands) {
  var n = (soup.length / 9) | 0, capLayer = new Set();
  for (var t = 0; t < n; t++) {
    var o = t * 9, a = soup[o + k];
    if (soup[o + 3 + k] === a && soup[o + 6 + k] === a) capLayer.add(a);
  }
  var runs = [], cur = null;
  for (var i = 0; i < bands.length; i++) {
    var b = bands[i];
    if (!b.clean) { cur = null; continue; }
    if (cur && cur.hi === b.lo && !capLayer.has(b.lo)) { cur.hi = b.hi; cur.bands.push(b); }
    else { cur = { lo: b.lo, hi: b.hi, bands: [b] }; runs.push(cur); }
  }
  return runs;
}

function NSO_sectionAxisName(k) { return 'XYZ'[k]; }

/* ONE DISPLAY PRECISION for the readout and every field: one decimal, and a
   second only when the one-decimal figure is off the real value by more than
   NSO_SECTION_SHOW_TOL. MINI_TPU_TEST's bore is Ø18.0047: it shows 18.0 in
   the header and 18.0 in the field, not 18.0 in one and 18.005 in the other. */
var NSO_SECTION_SHOW_TOL = 0.01;
function NSO_sectionShow(x) {
  x = +x;
  if (!isFinite(x)) return String(x);
  var one = x.toFixed(1);
  return Math.abs(+one - x) > NSO_SECTION_SHOW_TOL ? x.toFixed(2) : one;
}

/* A section loop's corners: its points with collinear runs taken out. */
function NSO_sectionCorners(p2) {
  var n = p2.length, out = [];
  for (var i = 0; i < n; i++) {
    var a = p2[(i + n - 1) % n], b = p2[i], c = p2[(i + 1) % n];
    var cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    var la = Math.hypot(b[0] - a[0], b[1] - a[1]), lc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (Math.abs(cr) > 1e-9 * Math.max(1e-12, la * lc)) out.push(b);
  }
  return out;
}

/* Which sides of a loop's bounding rectangle the outline only partly covers -
   a U-section's open top shows as two separate stretches of outline on that
   side. Returns [{ axis, hi }] in section-plane terms (axis 0 / 1). */
function NSO_sectionOpenSides(p2, rect, tol) {
  var open = [], n = p2.length;
  for (var ax = 0; ax < 2; ax++) for (var hiSide = 0; hiSide < 2; hiSide++) {
    var at = hiSide ? rect.hi[ax] : rect.lo[ax], ivs = [];
    for (var i = 0; i < n; i++) {
      var a = p2[i], b = p2[(i + 1) % n];
      if (Math.abs(a[ax] - at) <= tol && Math.abs(b[ax] - at) <= tol) {
        var u = 1 - ax, x0 = Math.min(a[u], b[u]), x1 = Math.max(a[u], b[u]);
        if (x1 - x0 > tol) ivs.push([x0, x1]);
      }
    }
    ivs.sort(function (p, q) { return p[0] - q[0]; });
    var runs = 0, end = -Infinity;
    for (var j = 0; j < ivs.length; j++) { if (ivs[j][0] > end + tol) runs++; end = Math.max(end, ivs[j][1]); }
    if (runs >= 2) open.push({ axis: ax, hi: !!hiSide });
  }
  return open;
}

/* A side of the section, named the way the piece is: its own Z is up. */
function NSO_sectionSideName(rawAxis, hi) {
  if (rawAxis === 2) return hi ? 'at the top' : 'at the bottom';
  return 'on its ' + (hi ? '+' : '-') + 'XYZ'[rawAxis] + ' side';
}

/* opts.detect   passed to NSO_extendDetectAxis (opts.axis forces the axis)
   opts.minRun   default NSO_SECTION_MIN_RUN */
function NSO_sectionRead(soup, opts) {
  opts = opts || {};
  var out = {
    ok: true, shape: 'other', hollow: false, axis: null, axisIdx: -1, axisTied: null,
    lengthMm: null, outer: null, bore: null, wallMm: null, reason: '', detail: '',
    sizes: null, run: null, plane: null, loops: 0
  };
  if (!soup || soup.length < 9 || (soup.length % 9) !== 0) {
    out.ok = false; out.reason = 'not a triangle soup'; return out;
  }
  if (typeof NSO_extendDetectAxis !== 'function' || typeof NSO_extendBands !== 'function' ||
      typeof rawCutOpen !== 'function' || typeof rawBuildLoopsFromCutEdges !== 'function' ||
      typeof rawNestLoops !== 'function') {
    out.ok = false;
    out.reason = 'app-extend.js and app-cut.js must be loaded - the section reader uses their axis ' +
      'detector and loop walker and carries no copy of either';
    return out;
  }

  var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (var i = 0; i < soup.length; i += 3) for (var c = 0; c < 3; c++) {
    var v = soup[i + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v;
  }
  out.sizes = { w: hi[0] - lo[0], d: hi[1] - lo[1], h: hi[2] - lo[2] };

  // Every one of the piece's own axes, with the widest clean constant-section
  // band along it - Extend's own band scan, run per axis. An axis with no
  // clean band gets no field on the card: there is nowhere to insert or
  // remove length without moving a feature.
  out.axes = [0, 1, 2].map(function (a) {
    var sc = NSO_extendBands(soup, a, {});
    return { idx: a, name: NSO_sectionAxisName(a), extentMm: hi[a] - lo[a], scan: sc,
             bandMm: sc.ok ? sc.best.width : 0, ok: !!sc.ok };
  });

  // ---- 1. the straight axis: Extend's detector, Extend's refusals ----
  var det = NSO_extendDetectAxis(soup, opts.detect || {});
  out.detect = det;
  if (!det.ok && det.ambiguous) {
    var longest = det.census.slice().sort(function (a, b) { return b.extent - a.extent; })[0];
    det = { ok: true, axisIdx: longest.axisIdx, axis: longest.axis, census: det.census,
            ambiguous: true, tied: det.tied };
    out.axisTied = det.tied.map(function (a) { return a.toUpperCase(); });
  }
  if (!det.ok) {
    out.detail = det.reason;
    if (det.offCardinal) {
      out.gate = 'off-axis';
      out.why = 'its straight axis is turned ' + Math.round(det.cov.offAxisDeg) + '° off its own X, Y and Z';
    } else if (det.census) {
      var best = det.census.slice().sort(function (a, b) { return a.obliqueFrac - b.obliqueFrac; })[0];
      out.gate = 'curved';
      out.why = 'it is curved or tapered all over (' + Math.round(best.obliqueFrac * 100) + '% of its surface)';
    } else { out.gate = 'soup'; out.why = det.reason; }
    return NSO_sectionFinish(out);
  }
  var k = det.axisIdx;
  out.axisIdx = k; out.axis = NSO_sectionAxisName(k);
  out.lengthMm = hi[k] - lo[k];
  if (!(out.lengthMm > 0)) { out.gate = 'flat'; out.why = 'it is flat along ' + out.axis; return NSO_sectionFinish(out); }

  // ---- the section plane: mid-length, or the middle of the gap beside it if
  //      mid-length lands exactly on a layer of vertices ----
  var scan = out.axes[k].scan;
  out.bands = scan;
  var mid = (lo[k] + hi[k]) / 2, plane = mid, host = null;
  for (var bi = 0; bi < scan.bands.length; bi++) {
    var b = scan.bands[bi];
    if (b.lo < mid && mid < b.hi) { host = b; break; }
    if (b.hi === mid) {
      var nb = scan.bands[bi + 1];
      host = (nb && nb.width > b.width) ? nb : b;
      plane = host.cut;
      break;
    }
  }
  out.plane = plane;

  // ---- 2. a constant section over most of the length ----
  var runs = NSO_sectionRuns(soup, k, scan.bands);
  var run = null;
  for (var ri = 0; ri < runs.length; ri++) if (runs[ri].lo < plane && plane < runs[ri].hi) run = runs[ri];
  var minRun = (opts.minRun == null) ? NSO_SECTION_MIN_RUN : +opts.minRun;
  if (run) out.run = { lo: run.lo, hi: run.hi, lengthMm: run.hi - run.lo, frac: (run.hi - run.lo) / out.lengthMm };

  // ---- the section itself, through the Cut tool's own walker ----
  var walked;
  try {
    var kept = rawCutOpen(soup, k, plane, true);
    walked = kept ? rawBuildLoopsFromCutEdges(rawPlaneBoundaryEdges(kept, k, plane), k, 1e-9)
                  : { loops: [], degreeIssues: [] };
  } catch (err) {
    out.gate = 'walk'; out.why = 'its section could not be traced (' + ((err && err.message) || err) + ')';
    return NSO_sectionFinish(out);
  }
  out.loops = walked.loops.length;

  if (!run) {
    out.gate = 'no-run';
    out.why = scan.ok ? 'its section changes at the middle of its ' + out.axis + ' length'
                      : 'its section changes all along ' + out.axis + ' - no stretch of it is the same shape';
    out.detail = scan.ok ? '' : scan.reason;
    return NSO_sectionFinish(out);
  }
  if (out.run.frac < minRun) {
    out.gate = 'short-run';
    out.why = 'only ' + NSO_sectionShow(out.run.lengthMm) + ' of its ' + NSO_sectionShow(out.lengthMm) +
      ' mm along ' + out.axis + ' keeps one section - the ends are shaped';
    return NSO_sectionFinish(out);
  }

  // ---- 3. the loops, by nesting ----
  if (walked.degreeIssues.length) {
    out.gate = 'tangled'; out.why = 'its section outline is tangled (' + walked.degreeIssues.length + ' branch point(s))';
    return NSO_sectionFinish(out);
  }
  if (!walked.loops.length) { out.gate = 'empty'; out.why = 'it has no section at mid-length'; return NSO_sectionFinish(out); }
  var L;
  try { L = rawNestLoops(walked.loops, k); }
  catch (err2) { out.gate = 'nesting'; out.why = 'its section outlines overlap'; return NSO_sectionFinish(out); }
  if (L.length > 2) { out.gate = 'loops'; out.why = 'its section is ' + L.length + ' separate outlines'; return NSO_sectionFinish(out); }
  if (L.length === 2 && !(L[0].depth + L[1].depth === 1)) {
    out.gate = 'loops'; out.why = 'its section is two separate outlines side by side'; return NSO_sectionFinish(out);
  }
  var oi = L.length === 1 ? 0 : (L[0].depth === 0 ? 0 : 1);
  var outerL = L[oi], boreL = L.length === 2 ? L[1 - oi] : null;
  out.hollow = !!boreL;

  // ---- 4. the fits ----
  var fo = NSO_sectionClassLoop(outerL.p2);
  out.fit = { outer: fo };
  if (!fo.cls) {
    out.gate = 'shape';
    out.why = NSO_sectionShapeWhy(outerL.p2, fo, k);
    return NSO_sectionFinish(out);
  }
  var fb = boreL ? NSO_sectionClassLoop(boreL.p2) : null;
  out.fit.bore = fb;
  if (fb && fb.cls !== fo.cls) {
    out.gate = 'bore-shape';
    out.why = 'its outside is ' + fo.cls + ' but its hole is ' + (fb.cls || 'neither round nor rectangular');
    return NSO_sectionFinish(out);
  }

  if (fo.cls === 'round') {
    var C = fo.circle;
    out.outer = { diameterMm: 2 * C.r, center: C.center, devMm: C.devMm, tolMm: C.tolMm };
    if (fb) {
      var B = fb.circle, ecc = Math.hypot(B.center[0] - C.center[0], B.center[1] - C.center[1]);
      if (ecc > B.tolMm) {
        out.outer = null;
        out.gate = 'eccentric';
        out.why = 'its hole is ' + NSO_sectionShow(ecc) + ' mm off centre';
        return NSO_sectionFinish(out);
      }
      out.bore = { diameterMm: 2 * B.r, center: B.center, devMm: B.devMm, tolMm: B.tolMm, eccentricityMm: ecc };
      out.wallMm = C.r - B.r;
    }
    out.shape = 'round';
    out.why = 'round within ' + C.devMm.toFixed(3) + ' of ' + C.tolMm.toFixed(3) + ' mm' +
      (fb ? ', bore within ' + fb.circle.devMm.toFixed(3) + ' mm' : '');
    return NSO_sectionFinish(out);
  }

  // rectangular: the wider side is W, and the bore's sides follow the outer's.
  var R = fo.rect, wi = R.span[0] >= R.span[1] ? 0 : 1, di = 1 - wi;
  out.outer = { widthMm: R.span[wi], depthMm: R.span[di], devMm: R.devMm, tolMm: R.tolMm,
                widthAxis: NSO_sectionAxisName([0, 1, 2].filter(function (a) { return a !== k; })[wi]) };
  if (fb) {
    var Q = fb.rect;
    var walls = [Q.lo[0] - R.lo[0], R.hi[0] - Q.hi[0], Q.lo[1] - R.lo[1], R.hi[1] - Q.hi[1]];
    out.bore = { widthMm: Q.span[wi], depthMm: Q.span[di], devMm: Q.devMm, tolMm: Q.tolMm, wallsMm: walls };
    out.wallMm = Math.min.apply(null, walls);
  }
  out.shape = 'rectangular';
  out.why = 'rectangular within ' + R.devMm.toFixed(3) + ' of ' + R.tolMm.toFixed(3) + ' mm' +
    (fb ? ', bore within ' + fb.rect.devMm.toFixed(3) + ' mm' : '');
  return NSO_sectionFinish(out);
}

/* The fit gate, in plain words: what the section IS, not how far it is from
   what it is not. "2.0 mm off rectangular" read as an out-of-square box when
   the box was a tray. */
function NSO_sectionShapeWhy(p2, fo, k) {
  var o = [0, 1, 2].filter(function (a) { return a !== k; });
  var corners = NSO_sectionCorners(p2);
  var along = ' along ' + NSO_sectionAxisName(k);
  if (fo.nearer === 'round') {
    return 'its section' + along + ' is a ' + corners.length + '-sided polygon, not a circle (' +
      NSO_sectionShow(fo.circle.devMm) + ' mm off round)';
  }
  var open = NSO_sectionOpenSides(p2, fo.rect, Math.max(1e-6, 1e-6 * Math.max(fo.rect.span[0], fo.rect.span[1])));
  if (open.length === 1 && corners.length === 8) {
    return 'its section' + along + ' is a U - open ' + NSO_sectionSideName(o[open[0].axis], open[0].hi) +
      ' - not a closed rectangle';
  }
  if (corners.length === 6) return 'its section' + along + ' is an L-shape, not a plain rectangle';
  return 'its section' + along + ' is a stepped outline with ' + corners.length + ' corners, not a plain rectangle';
}

/* The name the piece's own axis k goes by, as the piece lies: Height its Z,
   Length the longer of its X and Y, Width the shorter (X on a tie). One
   vocabulary (#145) for every row, the readout and the ring verbs' lines. */
function NSO_sectionAxisWord(s, k) {
  if (k === 2) return 'height';
  var lenIdx = (!s || !s.sizes || s.sizes.w >= s.sizes.d) ? 0 : 1;
  return k === lenIdx ? 'length' : 'width';
}

/* What the card can offer, decided once, here, from the reading - so the
   readout's "so ... apply" and the card's fields cannot disagree.

     round, hollow   its axis (if it has a clean band), named the way a box's
                     would be as it lies - Height if the axis is its Z, else
                     Length or Width by the rule below - then Outer Ø, Wall
     round, solid    its axis, named the same way, then Diameter
     anything else   Length / Width / Height for each of the piece's own axes
                     that has a clean band. Height is the piece's own Z, Length
                     the longer of its X and Y, Width the shorter.

   offset (Fatten / Shrink as one wall-kept offset) shows on every piece but a
   ring or rod, where Outer Ø / Diameter and Length already do its job. On
   anything else it is the only way to thicken a piece evenly: Length / Width
   / Height insert material in one band each, which on a stepped piece (an L,
   lid_strap's strap) moves the step's position rather than offsetting it.
   Longest shows only where it is not the same number as a named field
   already on the card. */
function NSO_sectionVerbs(s) {
  var v = { length: null, width: null, height: null, outer: false, wall: false, diameter: false,
            offset: true, longest: true, named: [] };
  if (!s || !s.axes) return v;
  function dim(a) { return { axisIdx: a.idx, axis: a.name, mm: a.extentMm, bandMm: a.bandMm }; }
  function word(a) { return NSO_sectionAxisWord(s, a.idx); }
  if (s.shape === 'round') {
    var A = s.axes[s.axisIdx];
    if (A.ok) v[word(A)] = dim(A);
    if (s.hollow) { v.outer = true; v.wall = true; } else v.diameter = true;
    v.offset = false;
  } else {
    s.axes.forEach(function (a) { if (a.ok) v[word(a)] = dim(a); });
  }
  var longest = Math.max(s.sizes.w, s.sizes.d, s.sizes.h);
  var namedMm = [];
  ['length', 'width', 'height'].forEach(function (n) { if (v[n]) { v.named.push(n); namedMm.push(v[n].mm); } });
  if (v.outer || v.diameter) { v.named.push(v.outer ? 'outer' : 'diameter'); namedMm.push(s.outer.diameterMm); }
  if (v.wall) v.named.push('wall');
  v.longest = !namedMm.some(function (mm) { return NSO_sectionShow(mm) === NSO_sectionShow(longest); });
  v.longestMm = longest;
  return v;
}

/* The reason line: the gate that decided, then what still applies. */
function NSO_sectionFinish(out) {
  out.verbs = NSO_sectionVerbs(out);
  if (out.shape !== 'other') { out.reason = out.why; return out; }
  var v = out.verbs, can = [];
  if (v.length) can.push('length');
  if (v.width) can.push('width');
  if (v.height) can.push('height');
  if (v.offset) can.push('an even offset');
  can.push('whole-piece scaling');
  var all = v.length && v.width && v.height;
  var list = can.length > 1 ? can.slice(0, -1).join(', ') + ' and ' + can[can.length - 1] : can[0];
  out.reason = out.why + ', so ' + (all ? '' : 'only ') + list + ' apply';
  return out;
}

/* The readout's first line, in print terms. Kept here, headless, so the test
   holds the wording the card shows.

   show and say are the Scale card's unit edge (app-scale.js): show formats a
   length in mm for display, say passes a plain-words reason through. Both
   default to the millimetre line this has always been. */
function NSO_sectionReadout(s, show, say) {
  var f = show || NSO_sectionShow;
  if (!s || !s.sizes) return 'No piece to read.';
  if (s.shape === 'round') {
    // its axis under the name its row has: "height 40.62" stood up
    var along = ' · ' + NSO_sectionAxisWord(s, s.axisIdx) + ' ' + f(s.lengthMm);
    if (s.hollow) {
      return 'Ring Ø' + f(s.outer.diameterMm) + ' outer · Ø' + f(s.bore.diameterMm) + ' bore · wall ' +
        f(s.wallMm) + along;
    }
    return 'Rod Ø' + f(s.outer.diameterMm) + along;
  }
  // Bars and everything else: the piece's own Length / Width / Height, the
  // same names the card's fields use (Height its own Z; Length the longer of
  // X and Y). Part 1's "W × D × L" named a bar's section sides instead.
  var X = s.sizes.w, Y = s.sizes.d, lwh = f(Math.max(X, Y)) + ' L × ' + f(Math.min(X, Y)) + ' W × ' + f(s.sizes.h) + ' H';
  if (s.shape === 'rectangular') {
    var t = 'Bar ' + lwh;
    if (s.hollow) t += ' · bore ' + f(s.bore.widthMm) + ' × ' + f(s.bore.depthMm) + ' · wall ' + f(s.wallMm);
    return t;
  }
  return lwh + ' · ' + (say ? say(s.reason) : s.reason);
}
