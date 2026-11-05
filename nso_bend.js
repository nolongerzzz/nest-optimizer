// ===================== Bend: a pipe / plate bender =====================
// Headless: no DOM, no Three.js, no app state. Runs under node for the
// self-test (tools/nso_bend_test.js) and under a classic script tag in the
// browser, where app-bend.js puts a panel on it.
//
// Speaks rawTris: the flat Float32Array triangle soup, 9 floats per triangle,
// in the piece's own (Z-up, print) frame.
//
// THE PROMISE, Extend's: the cross-section is held EXACT. A bend carries each
// section rigidly round the arc, so a plate's thickness, a tube's bore and
// wall and a rod's diameter do not change. Everything past the bend is carried
// rigidly: its vertices keep their distances to each other. Nothing is scaled
// and nothing is smoothed. Everything before the bend does not move at all -
// its coordinates are copied through bit for bit.
//
// WHERE IT WORKS. Only inside one clean constant-section band - Extend's own
// band finder (NSO_extendBands, app-extend.js), a gap between two consecutive
// layers of vertices along the axis that every triangle crossing it crosses
// as a wall (n.u = 0). No vertex lies inside a band, so the piece there is a
// pure extrusion: every plane across it cuts the same section. The section is
// read where the bend will be, and classed with nso_section.js's own fit
// (NSO_sectionClassLoop): a rectangular section bends toward one of its four
// sides; anything else may also be rolled in 15-degree steps.
//
// HOW, in four lines:
//   1. cut every wall crossing the band at the two ends of the bend zone,
//      a = Where - L/2 and b = Where + L/2, L = radius x angle;
//   2. keep everything before a where it is;
//   3. sweep the section round the arc between a and b - NSO_PathSweep's
//      sweepArc, radial stations, so every station IS the section;
//   4. carry everything after b rigidly round with the arc's end (arcTail).
//
// The splice needs no weld. The cut point of a crossing edge is a pure
// function of the edge and the plane, so the piece before a and the arc's
// first ring compute the same numbers, and the arc's last ring is arcTail of
// the very points the piece after b is cut at.
//
// THE NUMBERS THAT ARE POLICY, stated:
//   default radius   2.5 x the section's width in the bend direction
//   inside radius    at least NSO_BEND_MIN_INSIDE_MM (0.01 mm). At radius =
//                    width / 2 the inside face reaches the bend axis and its
//                    triangles have no area; past it the face turns inside
//                    out. 0.01 mm is a crease, not a bend, and is still many
//                    float32 steps wide anywhere on a plate.
//   band margin      NSO_BEND_MARGIN_MM (0.1 mm, Extend's Shorten margin) of
//                    straight band left on each side of the zone, so the walls
//                    either side do not become slivers no later tool can read.
//   steps            sag of the outermost surface <= 0.02 mm, and (added)
//                    zone volume within 0.05% - see NSO_PathSweep.arcSteps.
//   size             at most 2,000,000 triangles out.
//
// PAINT SCOPE: WHOLE-PIECE. See docs/HANDOFF.md for the rule. A bend moves
// every face past the zone and rebuilds every wall the zone crosses; no face
// beyond Where can be promised to stay where it was. app-bend.js stands the
// bake down on any paint (nsoMaskCount(m) > 0) and names the count.

var NSO_BEND_MAX_TRIS = 2000000;
var NSO_BEND_MIN_INSIDE_MM = 0.01;
var NSO_BEND_MARGIN_MM = 0.1;
var NSO_BEND_RADIUS_FACTOR = 2.5;
var NSO_BEND_SAG_MM = 0.02;
var NSO_BEND_VOLUME_STEP_FRAC = 5e-4;     // per-step volume budget, NSO_PathSweep.arcSteps
var NSO_BEND_SECTION_TOL_MM = 1e-4;       // every station congruent to the section
var NSO_BEND_VOLUME_TOL = 1e-3;           // zone volume vs A x centroid travel
var NSO_BEND_RIGID_TOL_MM = 1e-9;         // the tail, before float32 storage
var NSO_BEND_ROLL_STEP_DEG = 15;

function NSO_bendSweepLib() {
  if (typeof NSO_PathSweep !== 'undefined' && NSO_PathSweep) return NSO_PathSweep;
  if (typeof globalThis !== 'undefined' && globalThis.NSO_PathSweep) return globalThis.NSO_PathSweep;
  return null;
}

var NSO_bendF32 = (typeof Math.fround === 'function') ? Math.fround
  : (function () { var f = new Float32Array(1); return function (x) { f[0] = x; return f[0]; }; })();

function NSO_bendAxisName(k) { return 'XYZ'[k]; }
function NSO_bendFmt(x, dp) { return (+x).toFixed(dp == null ? 1 : dp); }

/* =====================================================================
   1. The axis

   The piece's own length, as it lies: the LONGEST of X, Y and Z that has a
   clean constant-section band (Extend's band finder, per axis), longest
   first so the common case scans one axis. Not Extend's least-oblique pick:
   every plate that has been bent once has all its normals square to its
   width, so the least-oblique axis of a bent plate is its width, every time,
   and a second bend could never be asked for along its length.

   Only when no axis has a band does Extend's detector speak, for the
   refusal: turned off X, Y and Z, curved all over, or (straight but) no
   constant stretch anywhere.
   ===================================================================== */
function NSO_bendAxis(soup, opts) {
  opts = opts || {};
  if (typeof NSO_extendDetectAxis !== 'function' || typeof NSO_extendBands !== 'function') {
    return { ok: false, reason: 'app-extend.js must be loaded - Bend uses its axis detector and band finder' };
  }
  if (opts.axis != null) {
    var fk = (typeof opts.axis === 'string') ? 'xyz'.indexOf(opts.axis.toLowerCase()) : (opts.axis | 0);
    if (!(fk >= 0 && fk <= 2)) return { ok: false, gate: 'axis', reason: 'the axis must be X, Y or Z' };
    var fs = NSO_extendBands(soup, fk, {});
    if (!fs.ok) return { ok: false, gate: 'no-band', reason: NSO_bendNoBandWords(NSO_bendAxisName(fk)) };
    return { ok: true, axisIdx: fk, axis: NSO_bendAxisName(fk), scan: fs, forced: true };
  }
  var ext = [0, 1, 2].map(function (a) { var sp = NSO_bendSpanAlong(soup, a); return { a: a, len: sp.length }; });
  ext.sort(function (p, q) { return q.len - p.len || p.a - q.a; });
  for (var i = 0; i < 3; i++) {
    if (!(ext[i].len > 0)) continue;
    var sc = NSO_extendBands(soup, ext[i].a, {});
    if (!sc.ok) continue;
    // A band only across a shorter extent: is the piece's length turned off
    // the axes? (A plate turned 30° about Z is a clean extrusion through its
    // 3 mm thickness, and nothing else.) Its long direction, if it has a
    // distinct one, says so.
    if (i > 0) {
      var pd = NSO_bendPrincipal(soup);
      if (pd && pd.offAxisDeg > 1) {
        return { ok: false, gate: 'off-axis',
                 reason: 'its length runs ' + pd.offAxisDeg.toFixed(1) + '° off X, Y and Z - Bend works only along X, Y or Z. ' +
                         'Turn the piece onto an axis first.' };
      }
    }
    return { ok: true, axisIdx: ext[i].a, axis: NSO_bendAxisName(ext[i].a), scan: sc };
  }
  var det = NSO_extendDetectAxis(soup, {});
  if (det.offCardinal) {
    return { ok: false, gate: 'off-axis', detect: det,
             reason: 'its straight axis is turned ' + det.cov.offAxisDeg.toFixed(1) + '° off X, Y and Z - Bend works ' +
                     'only along X, Y or Z. Turn the piece onto an axis first.' };
  }
  if (!det.ok && !det.ambiguous && det.census) {
    var best = det.census.slice().sort(function (a, b) { return a.obliqueFrac - b.obliqueFrac; })[0];
    return { ok: false, gate: 'curved', detect: det,
             reason: 'it has no straight axis - it is curved or tapered all over (' +
                     Math.round(best.obliqueFrac * 100) + '% of its surface), so there is no straight stretch to bend' };
  }
  if (!det.ok && !det.census) return { ok: false, gate: 'soup', reason: det.reason };
  return { ok: false, gate: 'no-band', reason: NSO_bendNoBandWords(NSO_bendAxisName(ext[0].a)) };
}

/* The piece's long direction: the top eigenvector of the area-weighted
   covariance of its triangles' centroids, when it is distinct (the top
   eigenvalue at least 1.5x the next - a disc or a square has none), and how
   far it is turned off the nearest of X, Y and Z. Null if not distinct. */
function NSO_bendPrincipal(soup) {
  // Second moments of the surface, exact per triangle: for a uniform
  // triangle, E[x xT] = (sum vi viT + s sT) / 12 with s = a + b + c.
  var n = (soup.length / 9) | 0, W = 0, m = [0, 0, 0], C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    var ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
    var vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
    var a = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    if (!(a > 0)) continue;
    var sv = [soup[o] + soup[o + 3] + soup[o + 6], soup[o + 1] + soup[o + 4] + soup[o + 7], soup[o + 2] + soup[o + 5] + soup[o + 8]];
    W += a;
    for (var p = 0; p < 3; p++) {
      m[p] += a * sv[p] / 3;
      for (var q = 0; q < 3; q++) {
        var vv = soup[o + p] * soup[o + q] + soup[o + 3 + p] * soup[o + 3 + q] + soup[o + 6 + p] * soup[o + 6 + q];
        C[p][q] += a * (vv + sv[p] * sv[q]) / 12;
      }
    }
  }
  if (!(W > 0)) return null;
  for (var p2 = 0; p2 < 3; p2++) m[p2] /= W;
  for (var p3 = 0; p3 < 3; p3++) for (var q3 = 0; q3 < 3; q3++) C[p3][q3] = C[p3][q3] / W - m[p3] * m[q3];
  var V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (var sweep = 0; sweep < 64; sweep++) {
    var P = 0, Q = 1, best = Math.abs(C[0][1]);
    if (Math.abs(C[0][2]) > best) { best = Math.abs(C[0][2]); P = 0; Q = 2; }
    if (Math.abs(C[1][2]) > best) { best = Math.abs(C[1][2]); P = 1; Q = 2; }
    if (best < 1e-18 * (C[0][0] + C[1][1] + C[2][2] + 1e-300)) break;
    var th = 0.5 * Math.atan2(2 * C[P][Q], C[Q][Q] - C[P][P]), co = Math.cos(th), si = Math.sin(th), r;
    for (r = 0; r < 3; r++) { var cp = C[r][P], cq = C[r][Q]; C[r][P] = co * cp - si * cq; C[r][Q] = si * cp + co * cq; }
    for (r = 0; r < 3; r++) { var pc = C[P][r], qc = C[Q][r]; C[P][r] = co * pc - si * qc; C[Q][r] = si * pc + co * qc; }
    for (r = 0; r < 3; r++) { var vp = V[r][P], vq = V[r][Q]; V[r][P] = co * vp - si * vq; V[r][Q] = si * vp + co * vq; }
  }
  var ev = [0, 1, 2].map(function (i) { return { l: C[i][i], v: [V[0][i], V[1][i], V[2][i]] }; }).sort(function (x, y) { return y.l - x.l; });
  if (!(ev[0].l > 1.5 * ev[1].l)) return null;
  var ab = ev[0].v.map(Math.abs), top = Math.max(ab[0], ab[1], ab[2]);
  return { dir: ev[0].v, offAxisDeg: Math.acos(Math.min(1, top)) * 180 / Math.PI };
}

function NSO_bendNoBandWords(A) {
  return 'its section is not constant anywhere along ' + A + ' - it tapers or changes (knuckles, steps) all along, ' +
         'so there is no straight stretch to bend';
}

/* =====================================================================
   2. The section where the bend goes

   In a clean band every crossing triangle has exactly two edges crossing the
   gap: one walked from the far side to the near side (its "down" edge), one
   back (its "up" edge). The section on any plane in the band is one segment
   per crossing triangle, from its down edge's point to its up edge's point -
   and that is already the orientation sweepArc wants (material on the left
   about +u), because the triangle's outward normal is (q - p) x u. A crossing
   edge is shared by two triangles, down for one and up for the other, so the
   segments chain into closed loops by edge alone.
   ===================================================================== */

function NSO_bendVertKey(x, y, z) { return x + ',' + y + ',' + z; }

/* The crossing triangles and edges of a band, chained into loops. */
function NSO_bendChain(soup, k, band) {
  var n = (soup.length / 9) | 0, cut = band.cut;
  var edges = new Map(), byDown = new Map(), tris = [];
  var bad = null;
  for (var t = 0; t < n && !bad; t++) {
    var o = t * 9;
    var s0 = soup[o + k], s1 = soup[o + 3 + k], s2 = soup[o + 6 + k];
    var above = (s0 > cut) + (s1 > cut) + (s2 > cut);
    if (above === 0 || above === 3) continue;
    var down = null, up = null;
    for (var e = 0; e < 3; e++) {
      var i0 = o + e * 3, i1 = o + ((e + 1) % 3) * 3;
      var a0 = soup[i0 + k] > cut, a1 = soup[i1 + k] > cut;
      if (a0 === a1) continue;
      var lo = a0 ? i1 : i0, hi = a0 ? i0 : i1;
      var key = NSO_bendVertKey(soup[lo], soup[lo + 1], soup[lo + 2]) + '|' + NSO_bendVertKey(soup[hi], soup[hi + 1], soup[hi + 2]);
      if (!edges.has(key)) {
        edges.set(key, { key: key, lo: [soup[lo], soup[lo + 1], soup[lo + 2]], hi: [soup[hi], soup[hi + 1], soup[hi + 2]] });
      }
      if (a0) down = key; else up = key;
    }
    if (down == null || up == null) { bad = 'a crossing triangle has no edge back'; break; }
    if (byDown.has(down)) { bad = 'two walls leave the same edge - the band is not one closed outline (non-manifold or flipped faces)'; break; }
    byDown.set(down, { tri: t, up: up });
    tris.push(t);
  }
  if (bad) return { ok: false, reason: bad };
  var loops = [], seen = new Set();
  byDown.forEach(function (v, start) {
    if (seen.has(start)) return;
    var loop = [], at = start, guard = 0;
    while (!seen.has(at) && guard++ <= byDown.size) {
      seen.add(at);
      loop.push(edges.get(at));
      var nx = byDown.get(at);
      if (!nx) { bad = 'the section outline does not close (an open edge in the band)'; return; }
      at = nx.up;
    }
    if (at !== start) { bad = bad || 'the section outline does not close (an open edge in the band)'; return; }
    loops.push(loop);
  });
  if (bad) return { ok: false, reason: bad };
  if (seen.size !== byDown.size || byDown.size !== edges.size) {
    return { ok: false, reason: 'the band\'s walls are not one consistently wound outline (an open or flipped face)' };
  }
  return { ok: true, loops: loops, crossing: tris, edgeCount: edges.size };
}

/* Where a crossing edge meets the plane s: the axis coordinate is s exactly,
   the other two run along the edge. An edge parallel to the axis gives back
   its own cross-section coordinates, untouched. */
function NSO_bendEdgePoint(edge, k, s) {
  var lo = edge.lo, hi = edge.hi, f = (s - lo[k]) / (hi[k] - lo[k]);
  var p = [lo[0] + (hi[0] - lo[0]) * f, lo[1] + (hi[1] - lo[1]) * f, lo[2] + (hi[2] - lo[2]) * f];
  p[k] = s;
  return p;
}

/* Area and centroid of the loops (outlines count +, bores -) in the two
   cross axes, and each loop's own signed area. */
function NSO_bendLoopsArea(loops2) {
  var A = 0, cx = 0, cy = 0, per = [];
  for (var l = 0; l < loops2.length; l++) {
    var p = loops2[l], a = 0, x = 0, y = 0;
    for (var i = 0; i < p.length; i++) {
      var q = p[(i + 1) % p.length], cr = p[i][0] * q[1] - q[0] * p[i][1];
      a += cr; x += (p[i][0] + q[0]) * cr; y += (p[i][1] + q[1]) * cr;
    }
    per.push(a / 2);
    A += a / 2; cx += x / 6; cy += y / 6;
  }
  return { area: A, centroid: A !== 0 ? [cx / A, cy / A] : [0, 0], per: per };
}

/* The cross axes of k, in the order whose cross product is +k. */
function NSO_bendCross(k) { return [(k + 1) % 3, (k + 2) % 3]; }

/* The section on the band's middle plane, read in the cross axes.
   class: nso_section.js's fit of the outer loop (round / rectangular / null). */
function NSO_bendSection(soup, k, band) {
  var ch = NSO_bendChain(soup, k, band);
  if (!ch.ok) return ch;
  var c = NSO_bendCross(k);
  var loops3 = ch.loops.map(function (lp) { return lp.map(function (e) { return NSO_bendEdgePoint(e, k, band.cut); }); });
  var loops2 = loops3.map(function (lp) { return lp.map(function (p) { return [p[c[0]], p[c[1]]]; }); });
  var ar = NSO_bendLoopsArea(loops2);
  var outer = 0;
  for (var i = 1; i < ar.per.length; i++) if (ar.per[i] > ar.per[outer]) outer = i;
  var cls = null;
  if (typeof NSO_sectionClassLoop === 'function') {
    var fit = NSO_sectionClassLoop(loops2[outer]);
    cls = fit.cls;
  }
  var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  loops2.forEach(function (lp) { lp.forEach(function (p) {
    for (var j = 0; j < 2; j++) { if (p[j] < lo[j]) lo[j] = p[j]; if (p[j] > hi[j]) hi[j] = p[j]; }
  }); });
  return { ok: true, chain: ch, loops2: loops2, cross: c, area: ar.area, centroid: ar.centroid,
           cls: cls, rectangular: cls === 'rectangular', lo: lo, hi: hi, loopCount: loops2.length };
}

/* =====================================================================
   3. Toward: the piece's four sides, and a roll for a section that is not
      a rectangle
   ===================================================================== */

// '+Z' -> { axis: 2, sign: 1 }
function NSO_bendParseSide(side) {
  var m = /^\s*([+\-−]?)\s*([xyzXYZ])\s*$/.exec(String(side == null ? '' : side));
  if (!m) return null;
  return { axis: 'xyz'.indexOf(m[2].toLowerCase()), sign: (m[1] === '-' || m[1] === '−') ? -1 : 1 };
}

function NSO_bendSideName(s) { return (s.sign > 0 ? '+' : '−') + NSO_bendAxisName(s.axis); }

/* The four sides of a piece along axis k: the plus and minus of its two
   cross axes, Z (up) first when it is one of them. */
function NSO_bendSides(k) {
  var c = NSO_bendCross(k).slice().sort(function (a, b) { return (b === 2) - (a === 2) || a - b; });
  var out = [];
  c.forEach(function (a) { [1, -1].forEach(function (sg) {
    var s = { axis: a, sign: sg };
    out.push({ key: NSO_bendSideName(s).replace('−', '-'), name: NSO_bendSideName(s), axis: a, sign: sg,
               label: a === 2 ? (sg > 0 ? 'Up (+Z)' : 'Down (−Z)') : NSO_bendSideName(s) });
  }); });
  return out;
}

function NSO_bendTrig(deg) {
  var q = deg / 90, k = Math.round(q);
  if (Math.abs(q - k) < 1e-12) return [[1, 0], [0, 1], [-1, 0], [0, -1]][((k % 4) + 4) % 4];
  var r = deg * Math.PI / 180;
  return [Math.cos(r), Math.sin(r)];
}

/* The fold direction: the side's unit vector turned by `rollDeg` about +k. */
function NSO_bendToward(k, side, rollDeg) {
  var d = [0, 0, 0];
  d[side.axis] = side.sign;
  if (!rollDeg) return d;
  var u = [0, 0, 0]; u[k] = 1;
  var b = [u[1] * d[2] - u[2] * d[1], u[2] * d[0] - u[0] * d[2], u[0] * d[1] - u[1] * d[0]];
  var cs = NSO_bendTrig(rollDeg);
  return [d[0] * cs[0] + b[0] * cs[1], d[1] * cs[0] + b[1] * cs[1], d[2] * cs[0] + b[2] * cs[1]];
}

/* Span of the section along a cross-plane direction d (3D, perpendicular to
   k): min and max of p.d over every section point. The extremes of a
   polygon are at its corners, and every corner of a band's section is a
   crease edge parallel to the axis, so this is exact. */
function NSO_bendSpan(sec, d) {
  var c = sec.cross, lo = Infinity, hi = -Infinity;
  sec.loops2.forEach(function (lp) { lp.forEach(function (p) {
    var h = p[0] * d[c[0]] + p[1] * d[c[1]];
    if (h < lo) lo = h; if (h > hi) hi = h;
  }); });
  return { lo: lo, hi: hi, width: hi - lo, mid: (lo + hi) / 2 };
}

/* =====================================================================
   4. Reading a piece: what the panel offers
   ===================================================================== */

// The clean bands along k, as mm from the near (low) end.
function NSO_bendBandsMm(scan, min) {
  return scan.clean.map(function (b) {
    return { lo: b.lo, hi: b.hi, cut: b.cut, width: b.width, fromMm: b.lo - min, toMm: b.hi - min, band: b };
  });
}

function NSO_bendSpanAlong(soup, k) {
  var mn = Infinity, mx = -Infinity;
  for (var i = k; i < soup.length; i += 3) { var v = soup[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  return { min: mn, max: mx, length: mx - mn };
}

/* opts.axis forces the axis, as everywhere. Returns what the panel needs:
   the axis, the length, the clean bands, the section's class and the four
   sides with the section's width toward each, and defaults. */
function NSO_bendRead(soup, opts) {
  opts = opts || {};
  var out = { ok: false, reason: '' };
  if (!soup || soup.length < 9 || soup.length % 9) { out.reason = 'not a triangle soup'; return out; }
  var ax = NSO_bendAxis(soup, opts);
  if (!ax.ok) { out.reason = ax.reason; out.gate = ax.gate; return out; }
  var k = ax.axisIdx, sp = NSO_bendSpanAlong(soup, k);
  out.axisIdx = k; out.axis = ax.axis; out.min = sp.min; out.max = sp.max; out.lengthMm = sp.length;
  var scan = ax.scan;
  out.scan = scan;
  out.bands = NSO_bendBandsMm(scan, sp.min);
  var best = scan.best;
  var sec = NSO_bendSection(soup, k, best);
  if (!sec.ok) { out.reason = 'its section cannot be read: ' + sec.reason; out.gate = 'section'; return out; }
  out.section = sec;
  out.rectangular = sec.rectangular;
  out.sides = NSO_bendSides(k).map(function (s) {
    var d = NSO_bendToward(k, s, 0), w = NSO_bendSpan(sec, d).width;
    return { key: s.key, name: s.name, label: s.label, axis: s.axis, sign: s.sign, widthMm: w,
             radiusMm: NSO_BEND_RADIUS_FACTOR * w };
  });
  // The thin way first: a plate folds across its thickness. Up wins a tie.
  var thin = out.sides.slice().sort(function (a, b) { return a.widthMm - b.widthMm; })[0];
  out.defaultToward = out.sides.filter(function (s) { return s.widthMm === thin.widthMm; })[0].key;
  out.defaultWhereMm = Math.round((best.cut - sp.min) * 10) / 10;
  out.ok = true;
  return out;
}

/* =====================================================================
   5. The checks on the result - every one measured on the output buffer
   ===================================================================== */

/* Exact-bit topology: welds only vertices that are the same float32 triple
   (+0 and -0 are one value). open = an edge used once, nm = more than twice,
   flip = used twice the same way round, degen = a triangle with zero area.
   Numeric all the way down - a hash on the coordinates' bits and one sort of
   the edge keys - because a string-keyed map took 10 s on a 1.2M-triangle
   bend and this runs on every one. */
function NSO_bendTopology(soup) {
  var imul = Math.imul, floor = Math.floor;      // locals: a hot loop, and a vm sandbox's globals are slow
  var n = (soup.length / 9) | 0, refs = n * 3;
  var bits = new Uint32Array(soup.buffer, soup.byteOffset, n * 9);
  var size = 1; while (size < refs * 2) size <<= 1;
  var table = new Int32Array(size).fill(-1), keys = new Uint32Array(refs * 3), vid = new Int32Array(refs), nv = 0;
  for (var i = 0; i < refs; i++) {
    var x = bits[i * 3], y = bits[i * 3 + 1], z = bits[i * 3 + 2];
    if (x === 0x80000000) x = 0; if (y === 0x80000000) y = 0; if (z === 0x80000000) z = 0;
    var h = imul(x ^ imul(y, 0x9e3779b1) ^ imul(z, 0x85ebca77), 0xc2b2ae3d);
    h = (h ^ (h >>> 15)) & (size - 1);
    for (;;) {
      var e = table[h];
      if (e < 0) { table[h] = nv; keys[nv * 3] = x; keys[nv * 3 + 1] = y; keys[nv * 3 + 2] = z; vid[i] = nv++; break; }
      if (keys[e * 3] === x && keys[e * 3 + 1] === y && keys[e * 3 + 2] === z) { vid[i] = e; break; }
      h = (h + 1) & (size - 1);
    }
  }
  var ek = new Float64Array(refs), ne = 0, degen = 0, SH = 67108864;
  for (var t = 0; t < n; t++) {
    var a = vid[t * 3], b = vid[t * 3 + 1], c = vid[t * 3 + 2];
    if (a === b || b === c || a === c) degen++;
    else {
      var o = t * 9;
      var ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
      var vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
      if (uy * vz - uz * vy === 0 && uz * vx - ux * vz === 0 && ux * vy - uy * vx === 0) degen++;
    }
    for (var k = 0; k < 3; k++) {
      var p = k === 0 ? a : k === 1 ? b : c, q = k === 0 ? b : k === 1 ? c : a;
      if (p === q) continue;
      ek[ne++] = ((p < q ? p : q) * SH + (p < q ? q : p)) * 2 + (p < q ? 1 : 0);
    }
  }
  var sorted = ek.subarray(0, ne).sort();
  var open = 0, nm = 0, flip = 0, edges = 0;
  for (var j = 0; j < ne;) {
    var base = floor(sorted[j] / 2), cnt = 0, fwd = 0;
    while (j < ne && floor(sorted[j] / 2) === base) { cnt++; fwd += sorted[j] % 2; j++; }
    edges++;
    if (cnt === 1) open++;
    else if (cnt > 2) nm++;
    else if (fwd !== 1) flip++;
  }
  return { tris: n, verts: nv, edges: edges, open: open, nm: nm, flip: flip, degen: degen, euler: nv - edges + n };
}

/* Signed volume, about a reference point so a piece far from the origin
   does not lose its digits to cancellation. */
function NSO_bendVolume(soup, ref) {
  var v = 0, rx = ref ? ref[0] : 0, ry = ref ? ref[1] : 0, rz = ref ? ref[2] : 0;
  for (var o = 0; o + 8 < soup.length; o += 9) {
    var ax = soup[o] - rx, ay = soup[o + 1] - ry, az = soup[o + 2] - rz;
    var bx = soup[o + 3] - rx, by = soup[o + 4] - ry, bz = soup[o + 5] - rz;
    var cx = soup[o + 6] - rx, cy = soup[o + 7] - ry, cz = soup[o + 8] - rz;
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/* Does any triangle of `far` meet any triangle of `near`? Only the two outer
   parts can meet: the arc lies between the plane at its start and the plane
   at its end, the near part behind the first and the far part beyond the
   second (for any angle up to 180 degrees), so the arc touches each only at
   its own shared ring. Box-pruned, then NSO_Repair's own triangle test.
   Returns { checked, pairs, kind } - kind 'pierce' or 'coplanar'. */
function NSO_bendCrossCheck(near, far) {
  var tt = (typeof NSO_Repair !== 'undefined' && NSO_Repair && NSO_Repair._triTriIntersect) ? NSO_Repair._triTriIntersect : null;
  function box(s) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < s.length; i += 3) for (var c = 0; c < 3; c++) {
      var v = s[i + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v;
    }
    return { lo: lo, hi: hi };
  }
  var EPS = 1e-9;
  var BN = box(near), BF = box(far);
  function overlaps(lo, hi, B) {
    for (var c = 0; c < 3; c++) if (hi[c] < B.lo[c] - EPS || lo[c] > B.hi[c] + EPS) return false;
    return true;
  }
  if (!overlaps(BN.lo, BN.hi, BF)) return { checked: true, pairs: 0, candidates: 0, boxes: 'apart' };
  if (!tt) return { checked: false, pairs: 0, reason: 'NSO_Repair is not loaded' };
  function cands(s, B) {
    var out = [];
    for (var o = 0; o + 8 < s.length; o += 9) {
      var lo = [Math.min(s[o], s[o + 3], s[o + 6]), Math.min(s[o + 1], s[o + 4], s[o + 7]), Math.min(s[o + 2], s[o + 5], s[o + 8])];
      var hi = [Math.max(s[o], s[o + 3], s[o + 6]), Math.max(s[o + 1], s[o + 4], s[o + 7]), Math.max(s[o + 2], s[o + 5], s[o + 8])];
      if (overlaps(lo, hi, B)) out.push({ o: o, lo: lo, hi: hi, s: s });
    }
    return out;
  }
  var cn = cands(near, BF), cf = cands(far, BN);
  if (!cn.length || !cf.length) return { checked: true, pairs: 0, candidates: 0 };
  // Sweep and prune along the axis the two candidate sets spread furthest on.
  var all = cn.map(function (x) { x.side = 0; return x; }).concat(cf.map(function (x) { x.side = 1; return x; }));
  var ext = [0, 1, 2].map(function (c) {
    var lo = Infinity, hi = -Infinity;
    all.forEach(function (x) { if (x.lo[c] < lo) lo = x.lo[c]; if (x.hi[c] > hi) hi = x.hi[c]; });
    return hi - lo;
  });
  var ax = ext.indexOf(Math.max(ext[0], ext[1], ext[2]));
  all.sort(function (p, q) { return p.lo[ax] - q.lo[ax]; });
  var active = [[], []], pairs = 0, kind = null;
  function V(x, i) { return [x.s[x.o + i * 3], x.s[x.o + i * 3 + 1], x.s[x.o + i * 3 + 2]]; }
  for (var i = 0; i < all.length; i++) {
    var x = all[i], other = active[1 - x.side];
    for (var j = other.length - 1; j >= 0; j--) {
      var y = other[j];
      if (y.hi[ax] < x.lo[ax] - EPS) { other.splice(j, 1); continue; }
      var hitBox = true;
      for (var c = 0; c < 3; c++) if (y.hi[c] < x.lo[c] - EPS || x.hi[c] < y.lo[c] - EPS) { hitBox = false; break; }
      if (!hitBox) continue;
      var r = tt(V(x, 0), V(x, 1), V(x, 2), V(y, 0), V(y, 1), V(y, 2));
      if (r === 'pierce' || r === 'coplanar') { pairs++; if (!kind || r === 'pierce') kind = r; if (pairs >= 64) break; }
    }
    if (pairs >= 64) break;
    active[x.side].push(x);
  }
  return { checked: true, pairs: pairs, kind: kind, candidates: cn.length + cf.length };
}

/* =====================================================================
   6. The bend

   opts.where     mm along the piece from its near (low) end - the middle of
                  the bend zone, where a plate bender's mark goes
   opts.angle     degrees, 1 to 180
   opts.radius    mm to the section's centre line (the middle of its span in
                  the bend direction); blank: 2.5 x that span
   opts.toward    '+X' | '-X' | '+Y' | ... - the side the piece folds toward
   opts.roll      degrees about the axis, in 15-degree steps; only for a
                  section that is not rectangular
   opts.axis      force the axis, as Extend's opts.axis
   opts.gate      default true
   opts.selfCheck default true: refuse a far arm folded into the near one

   Returns { ok, reason, tris, ... }. On refusal tris is the ORIGINAL soup,
   the contract Extend and Smooth have, so a caller can swap unconditionally.
   ===================================================================== */
function NSO_bendRaw(soup, opts) {
  opts = opts || {};
  var t0 = Date.now();
  var res = { ok: false, reason: '', tris: soup };
  function refuse(gate, why) { res.gate = gate; res.reason = why; res.tris = soup; return res; }
  var S = NSO_bendSweepLib();
  if (!S || typeof S.sweepArc !== 'function') return refuse('lib', 'nso_path_sweep.js must be loaded - Bend sweeps the section with its sweepArc');
  if (!soup || soup.length < 9 || soup.length % 9) return refuse('soup', 'not a triangle soup');

  // --- the numbers asked for ---
  var angleDeg = +opts.angle;
  if (!isFinite(angleDeg) || angleDeg < 1 || angleDeg > 180) return refuse('angle', 'the angle must be 1 to 180 degrees, got ' + opts.angle);
  var whereMm = +opts.where;
  if (opts.where == null || opts.where === '' || !isFinite(whereMm)) return refuse('where', 'say where to bend, in mm from the near end');
  var roll = opts.roll == null || opts.roll === '' ? 0 : +opts.roll;
  if (!isFinite(roll) || Math.abs(roll / NSO_BEND_ROLL_STEP_DEG - Math.round(roll / NSO_BEND_ROLL_STEP_DEG)) > 1e-9) {
    return refuse('roll', 'Roll goes in ' + NSO_BEND_ROLL_STEP_DEG + '° steps, got ' + opts.roll);
  }
  roll = Math.round(roll / NSO_BEND_ROLL_STEP_DEG) * NSO_BEND_ROLL_STEP_DEG;
  roll = ((roll % 360) + 360) % 360;
  res.angleDeg = angleDeg; res.whereMm = whereMm; res.roll = roll;

  // --- the axis ---
  var ax = NSO_bendAxis(soup, opts);
  if (!ax.ok) return refuse(ax.gate, ax.reason);
  var k = ax.axisIdx, A = ax.axis;
  res.axisIdx = k; res.axis = A;
  var side = NSO_bendParseSide(opts.toward);
  if (!side) return refuse('toward', 'say which side it folds toward: one of ' + NSO_bendSides(k).map(function (s) { return s.name; }).join(', '));
  if (side.axis === k) {
    return refuse('toward', 'it cannot fold toward ' + NSO_bendSideName(side) + ' - that is along its own length (' + A +
      '); fold toward ' + NSO_bendSides(k).map(function (s) { return s.name; }).join(', '));
  }
  res.toward = NSO_bendSideName(side);

  var sp = NSO_bendSpanAlong(soup, k);
  res.lengthMm = sp.length;
  if (!(whereMm > 0 && whereMm < sp.length)) {
    return refuse('where', 'Where must be inside the piece - it is ' + NSO_bendFmt(sp.length) + ' mm long along ' + A + ', asked for ' + NSO_bendFmt(whereMm) + ' mm');
  }
  var W = sp.min + whereMm;

  // --- a clean band at Where ---
  var scan = ax.scan;
  var bands = NSO_bendBandsMm(scan, sp.min);
  res.bands = bands;
  var host = null;
  for (var bi = 0; bi < bands.length; bi++) if (bands[bi].lo < W && W < bands[bi].hi) host = bands[bi];
  function nearestBand(fitLen) {
    // The nearest band whose usable middle could hold a zone of length fitLen,
    // and how far Where would have to move to reach it.
    var best = null;
    bands.forEach(function (b) {
      var lo = b.fromMm + NSO_BEND_MARGIN_MM + fitLen / 2, hi = b.toMm - NSO_BEND_MARGIN_MM - fitLen / 2;
      if (!(hi >= lo)) return;
      var to = whereMm < lo ? lo : (whereMm > hi ? hi : whereMm), dist = Math.abs(to - whereMm);
      if (!best || dist < best.dist) best = { b: b, to: to, dist: dist };
    });
    return best;
  }
  function bandWords(b) { return NSO_bendFmt(b.fromMm) + '–' + NSO_bendFmt(b.toMm) + ' mm (' + NSO_bendFmt(b.width) + ' mm long)'; }
  if (!host) {
    var nb = null;
    bands.forEach(function (b) {
      var dist = whereMm < b.fromMm ? b.fromMm - whereMm : whereMm - b.toMm;
      if (!nb || dist < nb.dist) nb = { b: b, dist: dist };
    });
    return refuse('no-band-here', 'there is no straight stretch at ' + NSO_bendFmt(whereMm) + ' mm - the section changes there (a taper, ' +
      'a step or a feature). The nearest straight stretch runs ' + bandWords(nb.b) + ', ' + NSO_bendFmt(nb.dist) + ' mm away.');
  }
  res.band = { fromMm: host.fromMm, toMm: host.toMm, widthMm: host.width };

  // --- the section there, and Toward against it ---
  var sec = NSO_bendSection(soup, k, host.band);
  if (!sec.ok) return refuse('section', 'its section at ' + NSO_bendFmt(whereMm) + ' mm cannot be read: ' + sec.reason);
  res.sectionClass = sec.cls || 'other';
  if (roll && sec.rectangular) {
    return refuse('roll', 'Roll is for a round or shaped section; this one is rectangular, so it folds toward one of its four sides');
  }
  var d = NSO_bendToward(k, side, roll);
  var u = [0, 0, 0]; u[k] = 1;
  var span = NSO_bendSpan(sec, d);
  var w = span.width;
  res.widthMm = w;
  var R = (opts.radius == null || opts.radius === '') ? NSO_BEND_RADIUS_FACTOR * w : +opts.radius;
  if (!(R > 0) || !isFinite(R)) return refuse('radius', 'the radius must be a positive number of mm, got ' + opts.radius);
  res.radius = R;
  var minR = w / 2 + NSO_BEND_MIN_INSIDE_MM;
  var minShow = Math.ceil(minR * 100 - 1e-6) / 100;
  res.minRadius = minShow;
  if (R < minR - 1e-9) {
    return refuse('radius', 'a ' + NSO_bendFmt(R, 2) + ' mm radius is tighter than half the section\'s ' + NSO_bendFmt(w, 2) +
      ' mm width toward ' + res.toward + ' - the inside face would turn inside out. The smallest radius that works is ' +
      minShow.toFixed(2) + ' mm (a ' + NSO_BEND_MIN_INSIDE_MM + ' mm inside radius).');
  }

  // --- the zone ---
  var theta = angleDeg * Math.PI / 180, L = R * theta;
  var a = W - L / 2, b = W + L / 2;
  res.zone = { fromMm: a - sp.min, toMm: b - sp.min, lengthMm: L };
  if (!(a >= host.lo + NSO_BEND_MARGIN_MM && b <= host.hi - NSO_BEND_MARGIN_MM)) {
    var fit = nearestBand(L);
    var msg = 'the bend needs ' + NSO_bendFmt(L) + ' mm of straight piece (' + NSO_bendFmt(R, 2) + ' mm radius × ' + NSO_bendFmt(angleDeg, 0) +
      '°), from ' + NSO_bendFmt(a - sp.min) + ' to ' + NSO_bendFmt(b - sp.min) + ' mm; the straight stretch at ' + NSO_bendFmt(whereMm) +
      ' mm runs ' + bandWords(host) + ', and ' + NSO_BEND_MARGIN_MM + ' mm of it must stay straight at each end.';
    if (fit) {
      msg += (fit.b === host ? ' Move Where ' : ' The nearest stretch that holds it runs ' + bandWords(fit.b) + ': move Where ') +
        NSO_bendFmt(fit.dist) + ' mm, to ' + NSO_bendFmt(fit.to) + ' mm.';
    } else {
      var longest = bands.slice().sort(function (p, q) { return q.width - p.width; })[0];
      var maxR = (longest.width - 2 * NSO_BEND_MARGIN_MM) / theta;
      msg += ' No straight stretch on this piece is that long - the longest is ' + NSO_bendFmt(longest.width) + ' mm; ' +
        (maxR >= minR ? 'at ' + NSO_bendFmt(angleDeg, 0) + '° the radius can be at most ' + NSO_bendFmt(Math.floor(maxR * 100) / 100, 2) + ' mm, or bend less.'
                      : 'bend less.');
    }
    res.nearest = fit;
    return refuse('zone', msg);
  }

  // --- the size it would come to ---
  var ch = NSO_bendChain(soup, k, host.band);
  if (!ch.ok) return refuse('section', 'its section at ' + NSO_bendFmt(whereMm) + ' mm cannot be read: ' + ch.reason);
  var n = (soup.length / 9) | 0, M = ch.edgeCount;
  var rOut = -Infinity;
  var origin = [0, 0, 0];
  origin[k] = a;
  var c2 = sec.cross;
  // the centre line: the section's middle along d; any point on it along b.
  origin[c2[0]] = d[c2[0]] * span.mid; origin[c2[1]] = d[c2[1]] * span.mid;
  rOut = R + (span.hi - span.mid);
  var steps = S.arcSteps(theta, rOut, { sagMm: NSO_BEND_SAG_MM, volFrac: NSO_BEND_VOLUME_STEP_FRAC });
  // Each crossing wall leaves a triangle on one side and a quad (two) on the other.
  var pieceTris = 3 * ch.crossing.length;
  var predicted = n - ch.crossing.length + pieceTris + 2 * M * steps;
  res.predictedTris = predicted;
  if (predicted > NSO_BEND_MAX_TRIS) {
    return refuse('size', 'the bent piece would have ' + predicted.toLocaleString('en-US') + ' triangles, past the ' +
      NSO_BEND_MAX_TRIS.toLocaleString('en-US') + ' limit - the arc needs ' + steps + ' steps round ' + M + ' section points');
  }

  // --- build ---
  var arc = { origin: origin, tangent: u, toward: d, radius: R, angle: theta };
  var F = S.arcFrame(arc);
  if (!F.ok) return refuse('arc', F.reason);
  var pa = new Map(), pb = new Map();
  ch.loops.forEach(function (lp) { lp.forEach(function (e) {
    pa.set(e.key, NSO_bendEdgePoint(e, k, a));
    pb.set(e.key, NSO_bendEdgePoint(e, k, b));
  }); });
  var loopsA = ch.loops.map(function (lp) { return lp.map(function (e) { return pa.get(e.key); }); });
  var loopsB = ch.loops.map(function (lp) { return lp.map(function (e) { return pb.get(e.key); }); });
  var sw = S.sweepArc({ arc: arc, loops: loopsA, loopsEnd: loopsB, steps: steps, minInsideMm: 0 });
  if (!sw.ok) return refuse('sweep', 'the arc could not be swept: ' + sw.reason);

  var out = new Float32Array(predicted * 9), w9 = 0;
  var nearTris = 0, farTris = 0, farFrom = [];
  function put(p) { out[w9++] = p[0]; out[w9++] = p[1]; out[w9++] = p[2]; }
  var crossingSet = new Set(ch.crossing);
  var farVerts = [];
  function tail(x, y, z) { return S.arcTail(F, [x, y, z]); }

  for (var t = 0; t < n; t++) {
    var o = t * 9;
    if (!crossingSet.has(t)) {
      var smax = Math.max(soup[o + k], soup[o + 3 + k], soup[o + 6 + k]);
      if (smax < W) {                                   // before the bend: verbatim
        for (var q = 0; q < 9; q++) out[w9++] = soup[o + q];
        nearTris++;
      } else {                                          // past it: rigid
        var at0 = w9;
        for (var vv = 0; vv < 3; vv++) {
          var src = [soup[o + vv * 3], soup[o + vv * 3 + 1], soup[o + vv * 3 + 2]];
          put(tail(src[0], src[1], src[2]));
          farVerts.push(src);
        }
        farFrom.push(at0);
        farTris++;
      }
      continue;
    }
    // A crossing wall: its piece before a, kept; its piece after b, turned.
    var V = [[soup[o], soup[o + 1], soup[o + 2]], [soup[o + 3], soup[o + 4], soup[o + 5]], [soup[o + 6], soup[o + 7], soup[o + 8]]];
    var nearP = [], farP = [];
    for (var e2 = 0; e2 < 3; e2++) {
      var P0 = V[e2], P1 = V[(e2 + 1) % 3], b0 = P0[k] < W, b1 = P1[k] < W;
      if (b0) nearP.push(P0); else farP.push(P0);
      if (b0 !== b1) {
        var lo = b0 ? P0 : P1, hi = b0 ? P1 : P0;
        var key = NSO_bendVertKey(lo[0], lo[1], lo[2]) + '|' + NSO_bendVertKey(hi[0], hi[1], hi[2]);
        nearP.push(pa.get(key));
        farP.push(pb.get(key));
      }
    }
    for (var f1 = 1; f1 + 1 < nearP.length; f1++) { put(nearP[0]); put(nearP[f1]); put(nearP[f1 + 1]); nearTris++; }
    var farT = farP.map(function (p) { return tail(p[0], p[1], p[2]); });
    for (var f2 = 1; f2 + 1 < farT.length; f2++) {
      farFrom.push(w9);
      put(farT[0]); put(farT[f2]); put(farT[f2 + 1]); farTris++;
      farVerts.push(farP[0], farP[f2], farP[f2 + 1]);
    }
  }
  var nearEnd = w9;
  out.set(sw.tris, w9); w9 += sw.tris.length;
  if (w9 !== out.length) return refuse('build', 'internal: built ' + (w9 / 9) + ' triangles, predicted ' + predicted);

  res.counts = { trisIn: n, trisOut: predicted, crossing: ch.crossing.length, sectionPoints: M, steps: steps,
                 arcTris: sw.tris.length / 9, nearTris: nearTris, farTris: farTris, loops: ch.loops.length };
  res.steps = steps;
  res.sweep = sw.stats;

  // --- gates, on `out` ---
  var gate = opts.gate == null || !!opts.gate;
  if (gate) {
    // 1. topology: nothing the input did not already have
    var tIn = NSO_bendTopology(soup), tOut = NSO_bendTopology(out);
    res.topology = { before: tIn, after: tOut };
    if (tOut.open > tIn.open) return refuse('gate', 'open edges rose ' + tIn.open + ' -> ' + tOut.open);
    if (tOut.nm > tIn.nm) return refuse('gate', 'non-manifold edges rose ' + tIn.nm + ' -> ' + tOut.nm);
    if (tOut.flip > tIn.flip) return refuse('gate', 'inconsistently wound edges rose ' + tIn.flip + ' -> ' + tOut.flip);
    if (tOut.degen > tIn.degen) return refuse('gate', 'zero-area triangles rose ' + tIn.degen + ' -> ' + tOut.degen);

    // 2. every station is the section, moved rigidly - read back off the
    //    stored float32 numbers, in that station's own frame
    var C0 = [F.o[0] + F.d[0] * R, F.o[1] + F.d[1] * R, F.o[2] + F.d[2] * R];
    var worstSec = 0;
    for (var i = 0; i <= steps; i++) {
      var tt = i === steps ? 1 : i / steps, phi = tt * theta;
      var cph = i === steps ? F.c : Math.cos(phi), sph = i === steps ? F.s : Math.sin(phi);
      for (var l = 0; l < loopsA.length; l++) {
        for (var j = 0; j < loopsA[l].length; j++) {
          var pA = loopsA[l][j], pB = loopsB[l][j];
          var want = [pA[0] + (pB[0] - pA[0]) * tt, pA[1] + (pB[1] - pA[1]) * tt, pA[2] + (pB[2] - pA[2]) * tt];
          var hW = 0, gW = 0;
          for (var c = 0; c < 3; c++) { hW += (want[c] - F.o[c]) * F.d[c]; gW += (want[c] - F.o[c]) * F.b[c]; }
          var got = sw.rings[i][l][j];
          var gx = NSO_bendF32(got[0]) - C0[0], gy = NSO_bendF32(got[1]) - C0[1], gz = NSO_bendF32(got[2]) - C0[2];
          var vu = gx * F.u[0] + gy * F.u[1] + gz * F.u[2], vd = gx * F.d[0] + gy * F.d[1] + gz * F.d[2];
          var vb = gx * F.b[0] + gy * F.b[1] + gz * F.b[2];
          var rho = vu * sph - vd * cph, offPlane = vu * cph + vd * sph;
          var dev = Math.hypot((R - rho) - hW, vb - gW, offPlane);
          if (dev > worstSec) worstSec = dev;
        }
      }
    }
    res.sectionWorstMm = worstSec;
    if (!(worstSec <= NSO_BEND_SECTION_TOL_MM)) {
      return refuse('gate', 'a station is ' + worstSec.toExponential(3) + ' mm off the section, over the ' + NSO_BEND_SECTION_TOL_MM + ' mm limit');
    }

    // 3. the far part is rigid: every pair of consecutive far vertices keeps
    //    its distance through the transform (float64, before storage), and
    //    the stored number is the nearest float32 to it.
    var worstRigid = 0, worstStore = 0;
    for (var fv = 0; fv < farVerts.length; fv++) {
      var p1 = farVerts[fv], p2 = farVerts[(fv + 1) % farVerts.length];
      var q1 = S.arcTail(F, p1), q2 = S.arcTail(F, p2);
      var d0 = Math.hypot(p1[0] - p2[0], p1[1] - p2[1], p1[2] - p2[2]);
      var d1 = Math.hypot(q1[0] - q2[0], q1[1] - q2[1], q1[2] - q2[2]);
      if (Math.abs(d1 - d0) > worstRigid) worstRigid = Math.abs(d1 - d0);
    }
    for (var ff = 0; ff < farFrom.length; ff++) {
      for (var v3 = 0; v3 < 3; v3++) {
        var ex = S.arcTail(F, farVerts[ff * 3 + v3]);
        for (var c3 = 0; c3 < 3; c3++) {
          var st = out[farFrom[ff] + v3 * 3 + c3];
          if (st !== NSO_bendF32(ex[c3])) worstStore++;
        }
      }
    }
    res.rigidWorstMm = worstRigid;
    if (!(worstRigid <= NSO_BEND_RIGID_TOL_MM)) return refuse('gate', 'the far part is not rigid: a distance moved ' + worstRigid.toExponential(3) + ' mm');
    if (worstStore) return refuse('gate', worstStore + ' stored far coordinate(s) are not the nearest float32 to the rigid position');

    // 4. volume: the arc holds A x the length the section's centroid travels
    var ref = [(sp.min + sp.max) / 2, 0, 0];
    ref[k] = W; ref[c2[0]] = (sec.lo[0] + sec.hi[0]) / 2; ref[c2[1]] = (sec.lo[1] + sec.hi[1]) / 2;
    var vIn = NSO_bendVolume(soup, ref), vOut = NSO_bendVolume(out, ref);
    var cen3 = [0, 0, 0]; cen3[c2[0]] = sec.centroid[0]; cen3[c2[1]] = sec.centroid[1];
    var hc = (cen3[0] - F.o[0]) * d[0] + (cen3[1] - F.o[1]) * d[1] + (cen3[2] - F.o[2]) * d[2];
    var Asec = sec.area, travel = (R - hc) * theta;
    var zoneGot = vOut - vIn + Asec * L, zoneWant = Asec * travel;
    res.volume = { before: vIn, after: vOut, sectionArea: Asec, centroidRadius: R - hc, centroidTravelMm: travel,
                   zoneMeasured: zoneGot, zoneExpected: zoneWant, zoneRelErr: (zoneGot - zoneWant) / zoneWant,
                   pieceExpected: vIn - Asec * L + zoneWant, pieceRelErr: (vOut - (vIn - Asec * L + zoneWant)) / Math.abs(vIn - Asec * L + zoneWant) };
    if (!(Math.abs(res.volume.zoneRelErr) <= NSO_BEND_VOLUME_TOL)) {
      return refuse('gate', 'the arc holds ' + zoneGot.toFixed(3) + ' mm³ where the section times its centroid\'s travel is ' +
        zoneWant.toFixed(3) + ' mm³ (' + (100 * res.volume.zoneRelErr).toFixed(3) + '%, limit 0.1%)');
    }
  }

  // 5. an arm folded into the body. Only the near and far parts can meet.
  if (opts.selfCheck == null || opts.selfCheck) {
    var nearOnly = new Float32Array(nearTris * 9), farOnly = new Float32Array(farTris * 9), nq = 0, fq = 0;
    // near and far triangles are interleaved in `out` (input order); split them.
    var farStarts = new Set(farFrom);
    for (var oo = 0; oo < nearEnd; oo += 9) {
      if (farStarts.has(oo)) { farOnly.set(out.subarray(oo, oo + 9), fq); fq += 9; }
      else { nearOnly.set(out.subarray(oo, oo + 9), nq); nq += 9; }
    }
    var cc = NSO_bendCrossCheck(nearOnly, farOnly);
    res.selfCheck = cc;
    if (cc.pairs > 0) {
      return refuse('self', 'folding ' + NSO_bendFmt(angleDeg, 0) + '° here would put the far arm ' +
        (cc.kind === 'coplanar' ? 'flat against' : 'through') + ' the piece before the bend (' + cc.pairs + (cc.pairs >= 64 ? '+' : '') +
        ' crossing face pairs) - bend less, use a larger radius, or bend further from the end');
    }
  }

  res.ok = true;
  res.tris = out;
  res.ms = Date.now() - t0;
  return res;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { NSO_bendRaw: NSO_bendRaw, NSO_bendRead: NSO_bendRead, NSO_bendTopology: NSO_bendTopology };
}
