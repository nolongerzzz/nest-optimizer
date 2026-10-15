// ===================== Tube neck: a pinch or a bulge along a tube =====================
// Headless: no DOM, no Three.js, no app state. Runs under node for the
// self-test (tools/nso_tube_neck_test.js) and under a classic script tag in
// the browser, where the Tube edge card's third verb (app-tube-edge.js) calls
// it. docs/TUBE-EDGE.md, "Neck".
//
// NECK: anywhere along a tube's length, not only at its ends, the wall moves
// in (a pinch, Δr < 0) or out (a bulge, Δr > 0) over a band of a given
// Length centred where the tube was clicked:
//
//   SMOOTH  the mid-wall follows a cosine, r = r_mid + Δr·(1 − cos 2πs/L)/2:
//           it leaves the tube tangent at both ends of the band and reaches
//           Δr at its middle (the waist), easing in and out the same way.
//   FUNNEL  straight in and straight out: a taper to the waist and back,
//           the wall bent sharp on the inside of each corner and round on
//           the outside, as sheet bends.
//
// THE SECTION CARRIED EXACTLY, as Flare and Roll carry it. Smooth: both faces
// are offsets of the mid-wall curve, t/2 either side along its normal; when
// the curve turns no tighter than t/2 (refused otherwise, in words) neither
// offset cusps, and the distance between them is t everywhere. Funnel: at
// each of its three corners the face on the inside of the bend is a sharp
// corner K and the face on the outside goes round K on an arc of radius t, so
// the wall holds t through the corner too. The wall is gated on the meridian
// at 0.02 mm, and the tube's axis and ends are not touched.
//
// THE AXIS is read with Tube edge's own ring reader (NSO_tubeEdgeRead, on the
// highest open end): the end's fitted centre and its face normal. THE WALL AT
// THE BAND is read off the mesh: every triangle the band crosses must be a
// piece of one of two cylinders about that axis - its normal square to the
// axis, its vertices all at one radius, the outside facing out and the bore
// facing in. That gives the outside radius, the bore and the wall t at the
// neck; anything else there (a neck already made, a taper, a flange, the end)
// refuses in words, naming where along the tube the wall stops being straight.
// So necks may not overlap, and need not be told apart from other shaping.
//
// THE BUILD. On each face the triangles the band crosses are taken out: a
// band of the cylinder between two whole rings of its vertices (the ring
// below the band and the ring above it - for a Stock tube, its two end rings).
// The lower ring's vertices are carried up through the stations, each along
// its own radial line, so the new face shares that ring's edges bit for bit;
// the last station is zipped to the upper ring by angle (the two rings need
// not have the same count or angles - an imported part's need not). Everything
// else - the ends, the other necks, the rest of the wall - is copied bit for
// bit. Several necks on one tube: each is its own commit, its own Undo.
//
// THE GATES, on the output buffer: topology (open / non-manifold / flipped /
// zero-area may not rise, Euler unchanged - Bend's counter, NSO_bendTopology),
// the volume against Pappus (π∫r²dh of each new face against its straight
// wall, times its ring's polygon factor), and the wall: every station of each
// face against the other face's polyline, t ± 0.02.
//
// REFUSALS, before anything is built, in words, the piece unchanged:
//   - no open round end to read the axis from (Tube edge's words);
//   - the band would run past an end of the tube;
//   - the wall is not straight across the band (a neck already there, or the
//     piece's own shape): necks may not overlap, and how far to move it;
//   - the pinch would close the bore below 2 nozzle widths across;
//   - a Smooth neck too short for its Δr (its bends tighter than t/2), a
//     Funnel too short (its taper past 75°).
//
// PAINT SCOPE: WHOLE-PIECE - the caller's (app-tube-edge.js), as Tube edge's.

var NSO_TN_SAG_MM = 0.01;            // chord sag on every curved face of the neck
var NSO_TN_WALL_TOL_MM = 0.02;       // wall through the neck vs the tube's wall
var NSO_TN_BORE_NOZZLES = 2;         // the bore at the waist: at least 2 nozzle widths across
var NSO_TN_AXIAL_SIN = 1e-4;         // a straight wall triangle: its normal this square to the axis
var NSO_TN_RADIUS_TOL_MM = 1e-3;     // one cylinder: every vertex within this of one radius
var NSO_TN_RING_TOL_MM = 1e-4;       // one ring: every vertex within this of one height
var NSO_TN_STATION_MIN_MM = 1e-4;    // a straight station closer than this to its ring is not laid
var NSO_TN_MAX_TAPER_DEG = 75;       // Funnel: the taper, off the axis
var NSO_TN_VOLUME_TOL = 5e-3;        // volume change vs Pappus
var NSO_TN_MAX_TRIS = 2000000;
var NSO_TN_MAX_STEPS = 4096;         // Smooth: stations along the band, at most

function NSO_tnFmt(x, dp) { return (+x).toFixed(dp == null ? 2 : dp); }
function NSO_tnSigned(x, dp) { return (x > 0 ? '+' : x < 0 ? '−' : '') + NSO_tnFmt(Math.abs(x), dp); }

/* =====================================================================
   1. Read the tube: the axis off its end, and per vertex and triangle where
      it sits about that axis
   ===================================================================== */

/* Returns { ok, reason, soup, weld, tube: { center, axis, frame, hMin, hMax,
   lengthMm, endRo, endRi }, VH, VR (per vertex: height along the axis from
   the end, radius from it), TH0, TH1, TNA, TNR (per triangle: its height
   range, its normal along the axis and along its own radial line) }. */
function NSO_tubeNeckRead(soup, opts) {
  var res = { ok: false, reason: '' };
  if (typeof NSO_tubeEdgeRead !== 'function') {
    res.reason = 'nso_tube_edge.js must be loaded - Neck reads the tube\'s axis with its end reader and carries no copy of it';
    return res;
  }
  if (!soup || soup.length < 9 || soup.length % 9) { res.reason = 'not a triangle soup'; return res; }
  res.soup = soup;
  var f32 = (soup instanceof Float32Array) ? soup : new Float32Array(soup);
  var er = NSO_tubeEdgeRead(f32, {});
  if (!er.ok) {
    res.reason = 'Neck reads the tube\'s axis off an open, circular end, and ' + er.reason.replace(/\. Flare and Roll work on .*$/, '').replace(/^that end/, 'the end');
    return res;
  }
  var end = er.end, W = er.weld, C = end.center, a = end.axis, P = W.P;
  var nv = W.nv, n = W.n;
  var VH = new Float64Array(nv), VR = new Float64Array(nv), hMin = Infinity, hMax = -Infinity;
  for (var v = 0; v < nv; v++) {
    var wx = P[v * 3] - C[0], wy = P[v * 3 + 1] - C[1], wz = P[v * 3 + 2] - C[2];
    var h = wx * a[0] + wy * a[1] + wz * a[2];
    VH[v] = h;
    VR[v] = Math.hypot(wx - h * a[0], wy - h * a[1], wz - h * a[2]);
    if (h < hMin) hMin = h; if (h > hMax) hMax = h;
  }
  var TH0 = new Float64Array(n), TH1 = new Float64Array(n), TNA = new Float64Array(n), TNR = new Float64Array(n);
  for (var t = 0; t < n; t++) {
    var i0 = W.vid[t * 3], i1 = W.vid[t * 3 + 1], i2 = W.vid[t * 3 + 2];
    TH0[t] = Math.min(VH[i0], VH[i1], VH[i2]); TH1[t] = Math.max(VH[i0], VH[i1], VH[i2]);
    var Nx = W.N[t * 3], Ny = W.N[t * 3 + 1], Nz = W.N[t * 3 + 2];
    TNA[t] = Nx * a[0] + Ny * a[1] + Nz * a[2];
    // the centroid's radial line
    var cx = (P[i0 * 3] + P[i1 * 3] + P[i2 * 3]) / 3 - C[0], cy = (P[i0 * 3 + 1] + P[i1 * 3 + 1] + P[i2 * 3 + 1]) / 3 - C[1],
        cz = (P[i0 * 3 + 2] + P[i1 * 3 + 2] + P[i2 * 3 + 2]) / 3 - C[2];
    var ch = cx * a[0] + cy * a[1] + cz * a[2], ex = cx - ch * a[0], ey = cy - ch * a[1], ez = cz - ch * a[2], el = Math.hypot(ex, ey, ez);
    TNR[t] = el > 1e-12 ? (Nx * ex + Ny * ey + Nz * ez) / el : 0;
  }
  res.weld = W; res.VH = VH; res.VR = VR; res.TH0 = TH0; res.TH1 = TH1; res.TNA = TNA; res.TNR = TNR;
  res.tube = { center: C, axis: a, frame: NSO_teFrame(a), hMin: hMin, hMax: hMax, lengthMm: hMax - hMin, endRo: end.Ro, endRi: end.Ri };
  res.ok = true;
  res.reason = 'tube ' + NSO_tnFmt(hMax - hMin) + ' mm long, Ø' + NSO_tnFmt(2 * end.Ro) + ' at its end';
  return res;
}

/* Where along the tube a height is, in words: mm in from the end the axis
   was read off (the tube lies at h <= 0 behind it). */
function NSO_tnIn(h) { return NSO_tnFmt(Math.max(0, -h)); }

/* =====================================================================
   2. The wall across the band: two cylinders, or why not
   ===================================================================== */

function NSO_tnBand(rd, ha, hb) {
  var W = rd.weld, n = W.n, eps = 1e-6, out = { ok: false, reason: '' };
  var tube = rd.tube, hMin = tube.hMin, hMax = tube.hMax;
  var outer = [], inner = [], bent = [], degen = 0;
  var oLo = Infinity, oHi = -Infinity, iLo = Infinity, iHi = -Infinity;
  for (var t = 0; t < n; t++) {
    if (!(rd.TH1[t] > ha + eps && rd.TH0[t] < hb - eps)) continue;
    if (W.degen[t]) { degen++; continue; }
    if (Math.abs(rd.TNA[t]) > NSO_TN_AXIAL_SIN || Math.abs(rd.TNR[t]) < 0.5) { bent.push(t); continue; }
    var lo = Infinity, hi = -Infinity;
    for (var k = 0; k < 3; k++) { var r = rd.VR[W.vid[t * 3 + k]]; if (r < lo) lo = r; if (r > hi) hi = r; }
    if (rd.TNR[t] > 0) { outer.push(t); if (lo < oLo) oLo = lo; if (hi > oHi) oHi = hi; }
    else { inner.push(t); if (lo < iLo) iLo = lo; if (hi > iHi) iHi = hi; }
  }
  if (degen) { out.reason = 'the wall has ' + degen + ' zero-area triangle(s) where the neck would go - Repair it first'; return out; }
  if (bent.length) {
    // the shaped stretch: every non-straight triangle of the wall (not an end
    // face), merged into runs along the axis; the run(s) this band meets
    var iv = [];
    for (var q = 0; q < n; q++) {
      if (W.degen[q]) continue;
      if (Math.abs(rd.TNA[q]) <= NSO_TN_AXIAL_SIN && Math.abs(rd.TNR[q]) >= 0.5) continue;
      if (Math.abs(rd.TNA[q]) > 0.999 && (rd.TH1[q] < hMin + 1e-6 || rd.TH0[q] > hMax - 1e-6)) continue;   // an end face
      iv.push([rd.TH0[q], rd.TH1[q]]);
    }
    iv.sort(function (x, y) { return x[0] - y[0]; });
    var runs = [];
    iv.forEach(function (x) {
      var last = runs[runs.length - 1];
      if (last && x[0] <= last[1] + 1e-6) { if (x[1] > last[1]) last[1] = x[1]; }
      else runs.push([x[0], x[1]]);
    });
    var hit = runs.filter(function (x) { return x[1] > ha + eps && x[0] < hb - eps; });
    var p = Infinity, q2 = -Infinity;
    hit.forEach(function (x) { if (x[0] < p) p = x[0]; if (x[1] > q2) q2 = x[1]; });
    if (!hit.length) { bent.forEach(function (t2) { p = Math.min(p, rd.TH0[t2]); q2 = Math.max(q2, rd.TH1[t2]); }); }
    var move = Math.min(q2 - ha, hb - p);
    out.shaped = { from: p, to: q2, moveMm: move };
    out.reason = 'the wall is not straight from ' + NSO_tnIn(q2) + ' to ' + NSO_tnIn(p) + ' mm in from the end, where this neck would go (' +
      NSO_tnIn(hb) + ' to ' + NSO_tnIn(ha) + ' mm) - a neck already there, or the piece\'s own shape. Necks may not overlap, and a neck ' +
      'is made on a straight stretch of tube: move it ' + NSO_tnFmt(move) + ' mm or more along the tube, or shorten it';
    return out;
  }
  if (!outer.length || !inner.length) {
    out.reason = 'there is no ' + (outer.length ? 'bore' : 'outside wall') + ' across the band - Neck works on a tube, a wall round a bore';
    return out;
  }
  if (oHi - oLo > NSO_TN_RADIUS_TOL_MM || iHi - iLo > NSO_TN_RADIUS_TOL_MM) {
    out.reason = 'the wall is not one tube across the band - its ' + (oHi - oLo > NSO_TN_RADIUS_TOL_MM ? 'outside runs from Ø' + NSO_tnFmt(2 * oLo) + ' to Ø' + NSO_tnFmt(2 * oHi)
      : 'bore runs from Ø' + NSO_tnFmt(2 * iLo) + ' to Ø' + NSO_tnFmt(2 * iHi)) + '. Neck works on a straight stretch of one tube';
    return out;
  }
  var Ro = (oLo + oHi) / 2, Ri = (iLo + iHi) / 2;
  if (!(Ro > Ri)) { out.reason = 'internal: the bore reads wider than the outside'; return out; }
  out.ok = true; out.outerTris = outer; out.innerTris = inner; out.Ro = Ro; out.Ri = Ri; out.wallMm = Ro - Ri;
  return out;
}

/* The boundary of one face's band: its two rings, each in the order the
   band's own triangles walk it. Returns { ok, reason, lower, upper } with
   lower / upper = { v: [vertex ids], h }. */
function NSO_tnRings(rd, tris) {
  var W = rd.weld, inSet = new Set(tris), next = new Map(), tangled = 0, edges = 0;
  tris.forEach(function (t) {
    for (var k = 0; k < 3; k++) {
      var u = NSO_teAcross(W, t * 3 + k);
      if (u >= 0 && inSet.has(u)) continue;
      if (u < 0) { tangled++; continue; }
      var a = W.vid[t * 3 + k], b = W.vid[t * 3 + (k + 1) % 3];
      if (next.has(a)) tangled++;
      next.set(a, b); edges++;
    }
  });
  var loops = [], seen = new Set();
  next.forEach(function (b0, a0) {
    if (seen.has(a0)) return;
    var lp = [], v = a0, guard = 0;
    while (!seen.has(v) && next.has(v) && guard++ <= edges) { seen.add(v); lp.push(v); v = next.get(v); }
    if (v !== a0) tangled++;
    loops.push(lp);
  });
  var res = { ok: false, reason: '' };
  var words = ' - Neck rebuilds the wall between two whole rings of its vertices round the tube, and here its triangles do not run in rings (an imported mesh tessellated across the axis?)';
  if (tangled) { res.reason = 'the wall\'s edges are open or shared more than twice where the neck would go - Repair it first'; return res; }
  if (loops.length !== 2) { res.reason = 'the wall where the neck would go is bounded by ' + loops.length + ' outline(s), not two rings' + words; return res; }
  var rings = loops.map(function (lp) {
    var lo = Infinity, hi = -Infinity, s = 0;
    lp.forEach(function (v) { var h = rd.VH[v]; if (h < lo) lo = h; if (h > hi) hi = h; s += h; });
    return { v: lp, h: s / lp.length, spread: hi - lo };
  });
  if (rings[0].spread > NSO_TN_RING_TOL_MM || rings[1].spread > NSO_TN_RING_TOL_MM) {
    res.reason = 'the wall where the neck would go is not bounded by flat rings (one runs ' + NSO_tnFmt(Math.max(rings[0].spread, rings[1].spread), 3) + ' mm along the axis)' + words;
    return res;
  }
  rings.sort(function (x, y) { return x.h - y.h; });
  res.ok = true; res.lower = rings[0]; res.upper = rings[1];
  return res;
}

/* =====================================================================
   3. The profile: the two faces' meridians, (r, h), from the band's lower
      end ha to its upper end hb
   ===================================================================== */

function NSO_tnArc(c, rad, a0, a1, out) {
  var sweep = Math.abs(a1 - a0), ns = NSO_teArcSteps(rad, sweep);
  for (var i = 1; i <= ns; i++) {
    var ang = a0 + (a1 - a0) * i / ns;
    out.push([c[0] + rad * Math.cos(ang), c[1] + rad * Math.sin(ang)]);
  }
}

/* Returns { ok, reason, O, I, waistBoreR, waistOuterR, taperDeg? }. */
function NSO_tnProfile(band, ha, hb, dr, L, prof) {
  var res = { ok: false, reason: '' };
  var Ro = band.Ro, Ri = band.Ri, t = Ro - Ri, hm = (ha + hb) / 2, O, I;
  if (prof === 'smooth') {
    // the tightest bend of r = rm + dr (1 - cos ws) / 2 is at its ends and its
    // waist, where it runs along the axis: curvature dr w^2 / 2
    var w = 2 * Math.PI / L, kmax = Math.abs(dr) * w * w / 2;
    if (1 / kmax < t / 2 - 1e-9) {
      res.reason = 'a ' + NSO_tnFmt(L, 1) + ' mm smooth neck is too short to move a ' + NSO_tnFmt(t) + ' mm wall by ' + NSO_tnSigned(dr) +
        ' mm - its bends would turn tighter than half the wall (radius ' + NSO_tnFmt(1 / kmax) + ' mm, under ' + NSO_tnFmt(t / 2) +
        ') and fold its inside face. At that Δr it needs ' + NSO_tnFmt(Math.PI * Math.sqrt(t * Math.abs(dr)) + 0.005) + ' mm or more';
      return res;
    }
    var rm = (Ro + Ri) / 2;
    var at = function (s, side) {
      var rp = dr / 2 * w * Math.sin(w * s), nn = Math.sqrt(1 + rp * rp);
      return [rm + dr * (1 - Math.cos(w * s)) / 2 + side * (t / 2) / nn, ha + s - side * (t / 2) * rp / nn];
    };
    // stations at equal steps of the band, halved until every chord of both
    // faces sags no more than NSO_TN_SAG_MM from its face
    var N = 8;
    for (;;) {
      var worst = 0;
      [1, -1].forEach(function (side) {
        for (var k = 0; k < N; k++) {
          var A = at(L * k / N, side), B = at(L * (k + 1) / N, side), M = at(L * (k + 0.5) / N, side);
          var d = NSO_teSegDist(M, A, B).d;
          if (d > worst) worst = d;
        }
      });
      if (worst <= NSO_TN_SAG_MM) break;
      N *= 2;
      if (N > NSO_TN_MAX_STEPS) { res.reason = 'internal: the neck needs more than ' + NSO_TN_MAX_STEPS + ' stations to hold its sag'; return res; }
    }
    O = []; I = [];
    for (var j = 0; j <= N; j++) { O.push(at(L * j / N, 1)); I.push(at(L * j / N, -1)); }
    O[0] = [Ro, ha]; I[0] = [Ri, ha]; O[N] = [Ro, hb]; I[N] = [Ri, hb];
    res.steps = N;
  } else {
    // FUNNEL. The face on the inside of the first bend, Fc, is the bore for a
    // pinch (the wall turns toward the axis) and the outside for a bulge; the
    // other face is Fx. Fc is sharp at K0 = (rc, ha) and at K2 = (rc, hb); Fx
    // is sharp at the waist, K1 = (rx + dr, hm), and Fc goes round K1 on an
    // arc of radius t, as Fx goes round K0 and K2. The taper's two faces are
    // the lines through K0 and K1 a wall apart: D = K1 - K0 = lam T + t sx n,
    // n = (T_h, -T_r) (square to the taper, toward Fx by sx).
    var pinch = dr < 0, rc = pinch ? Ri : Ro, rx = pinch ? Ro : Ri, sx = rx > rc ? 1 : -1;
    var K0 = [rc, ha], K1 = [rx + dr, hm];
    var Dr = K1[0] - K0[0], Dh = K1[1] - K0[1], d2 = Dr * Dr + Dh * Dh;
    if (!(d2 > t * t * (1 + 1e-9))) {
      res.reason = 'a ' + NSO_tnFmt(L, 1) + ' mm funnel neck is too short to bend a ' + NSO_tnFmt(t) + ' mm wall in and out again - lengthen it';
      return res;
    }
    var lam = Math.sqrt(d2 - t * t);
    var Tr = (lam * Dr - t * sx * Dh) / d2, Th = (t * sx * Dr + lam * Dh) / d2;
    var taper = Math.atan2(Math.abs(Tr), Th) * 180 / Math.PI;
    res.taperDeg = taper;
    if (!(Th > 0) || taper > NSO_TN_MAX_TAPER_DEG + 1e-9) {
      res.reason = 'a ' + NSO_tnFmt(L, 1) + ' mm funnel neck moving a ' + NSO_tnFmt(t) + ' mm wall by ' + NSO_tnSigned(dr) + ' mm would taper ' +
        (Th > 0 ? NSO_tnFmt(taper, 1) + '°' : 'past square') + ' off the axis, past the ' + NSO_TN_MAX_TAPER_DEG + '° limit - lengthen it or use less Δr';
      return res;
    }
    var nr = sx * Th, nh = -sx * Tr;              // the taper's normal, from Fc toward Fx
    var aOut = Math.atan2(0, sx), aN = Math.atan2(nh, nr), aNeg = Math.atan2(-nh, -nr), aIn = Math.atan2(0, -sx);
    // keep each arc the short way round
    var near = function (a0, a1) { while (a1 - a0 > Math.PI) a1 -= 2 * Math.PI; while (a0 - a1 > Math.PI) a1 += 2 * Math.PI; return a1; };
    var Fc = [K0.slice(), [K1[0] - t * nr, K1[1] - t * nh]];
    NSO_tnArc(K1, t, aNeg, near(aNeg, aIn), Fc);
    Fc[Fc.length - 1] = [K1[0] - t * sx, hm];
    var Fx = [[rx, ha]];
    NSO_tnArc(K0, t, aOut, near(aOut, aN), Fx);
    Fx.push(K1.slice());
    var mirror = function (H) {
      var full = H.slice();
      for (var m = H.length - 2; m >= 0; m--) full.push([H[m][0], 2 * hm - H[m][1]]);
      full[full.length - 1] = [H[0][0], hb];
      return full;
    };
    Fc = mirror(Fc); Fx = mirror(Fx);
    O = pinch ? Fx : Fc; I = pinch ? Fc : Fx;
  }
  var bore = Infinity, oMin = Infinity, oMax = -Infinity, iMax = -Infinity;
  I.forEach(function (q) { if (q[0] < bore) bore = q[0]; if (q[0] > iMax) iMax = q[0]; });
  O.forEach(function (q) { if (q[0] < oMin) oMin = q[0]; if (q[0] > oMax) oMax = q[0]; });
  for (var c = 1; c < O.length; c++) if (!(O[c][1] > O[c - 1][1] - 1e-12)) { res.reason = 'internal: the outside face doubles back along the axis'; return res; }
  for (var c2 = 1; c2 < I.length; c2++) if (!(I[c2][1] > I[c2 - 1][1] - 1e-12)) { res.reason = 'internal: the bore doubles back along the axis'; return res; }
  res.ok = true; res.O = O; res.I = I; res.t = t;
  res.waistBoreR = dr < 0 ? bore : iMax;
  res.waistOuterR = dr < 0 ? oMin : oMax;
  return res;
}

/* The wall through the neck: every station of each face against the other
   face's polyline, run on straight past both ends of the band (the tube's
   wall goes on there), so no station is measured to an end. */
function NSO_tnWallCheck(O, I, t) {
  function ext(Q) { var a = Q[0], b = Q[Q.length - 1]; return [[a[0], a[1] - 2 * t]].concat(Q, [[b[0], b[1] + 2 * t]]); }
  var Oe = ext(O), Ie = ext(I), lo = Infinity, hi = -Infinity, n = 0;
  function one(A, B) {
    for (var i = 0; i < A.length; i++) {
      var best = Infinity;
      for (var j = 0; j + 1 < B.length; j++) { var d = NSO_teSegDist(A[i], B[j], B[j + 1]).d; if (d < best) best = d; }
      n++; if (best < lo) lo = best; if (best > hi) hi = best;
    }
  }
  one(O, Ie); one(I, Oe);
  return { lo: lo, hi: hi, n: n };
}

/* =====================================================================
   4. The neck
   ===================================================================== */

/* opts: point [x, y, z] (raw frame: the band is centred where it projects
   onto the axis) or at (mm in from the end the axis is read off); blank, the
   middle of the tube. length (mm), dr (mm: < 0 pinch, > 0 bulge), profile
   'smooth' | 'funnel', nozzle (mm), read (a NSO_tubeNeckRead of this soup).
   Returns { ok, reason, tris (the input when refused), band, wall, volume,
   counts, ... }. */
function NSO_tubeNeckRaw(soup, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '', tris: soup, verb: 'neck' };
  var f32in = (soup instanceof Float32Array) ? soup : new Float32Array(soup);
  var rd = opts.read && opts.read.ok && opts.read.soup === soup ? opts.read : NSO_tubeNeckRead(f32in, opts);
  res.read = rd;
  if (!rd.ok) { res.reason = rd.reason; return res; }
  var tube = rd.tube, W = rd.weld, C = tube.center, a = tube.axis, nozzle = NSO_teNozzle(opts);
  res.nozzleMm = nozzle; res.tube = tube;

  var L = +opts.length, dr = +opts.dr, prof = opts.profile === 'funnel' ? 'funnel' : 'smooth';
  if (opts.length == null || opts.length === '' || !(L > 0) || !isFinite(L)) { res.reason = 'enter the neck\'s length in mm, more than 0'; return res; }
  if (opts.dr == null || opts.dr === '' || !isFinite(dr)) { res.reason = 'enter the neck\'s Δr in mm: below 0 pinches, above 0 bulges'; return res; }
  if (dr === 0) { res.reason = 'a Δr of 0 is no neck - below 0 pinches the tube, above 0 bulges it'; return res; }
  var h0;
  if (opts.point) {
    var p = opts.point;
    h0 = (p[0] - C[0]) * a[0] + (p[1] - C[1]) * a[1] + (p[2] - C[2]) * a[2];
  } else if (opts.at != null && opts.at !== '' && isFinite(+opts.at)) h0 = -(+opts.at);
  else h0 = (tube.hMin + tube.hMax) / 2;
  var ha = h0 - L / 2, hb = h0 + L / 2;
  res.band = { h0: h0, ha: ha, hb: hb, lengthMm: L, atMm: -h0 };

  if (ha < tube.hMin - 1e-6 || hb > tube.hMax + 1e-6) {
    res.reason = 'a ' + NSO_tnFmt(L, 1) + ' mm neck centred ' + NSO_tnIn(h0) + ' mm in would run past the end of the tube (it is ' +
      NSO_tnFmt(tube.lengthMm) + ' mm long) - centre it at least ' + NSO_tnFmt(L / 2) + ' mm in from either end, or shorten it';
    return res;
  }
  var band = NSO_tnBand(rd, ha, hb);
  res.wallRead = band;
  if (!band.ok) { res.reason = band.reason; if (band.shaped) res.shaped = band.shaped; return res; }
  var Ro = band.Ro, Ri = band.Ri, t = band.wallMm;
  res.band.Ro = Ro; res.band.Ri = Ri; res.band.wallMm = t;

  // the bore limit: a pinch may narrow it to no less than 2 nozzle widths across
  var boreMin = NSO_TN_BORE_NOZZLES * nozzle;
  if (dr < 0 && 2 * (Ri + dr) < boreMin - 1e-5) {          // 1e-5: a float32 radius's last bit
    var most = Ri - boreMin / 2;
    res.reason = 'a pinch of ' + NSO_tnFmt(-dr) + ' mm would close the bore - the Ø' + NSO_tnFmt(2 * Ri) + ' bore would come to ' +
      (Ri + dr > 0 ? 'Ø' + NSO_tnFmt(2 * (Ri + dr)) : 'nothing') + ' at the waist, under the bore limit of Ø' + NSO_tnFmt(boreMin) + ' (' +
      NSO_TN_BORE_NOZZLES + ' nozzle widths at a ' + NSO_tnFmt(nozzle, 1) + ' mm nozzle). This bore pinches by ' + NSO_tnFmt(most) + ' mm at most';
    res.maxPinchMm = most;
    return res;
  }

  var pr = NSO_tnProfile(band, ha, hb, dr, L, prof);
  res.profile = pr;
  if (!pr.ok) { res.reason = pr.reason; return res; }
  var wall = NSO_tnWallCheck(pr.O, pr.I, t);
  res.wall = { minMm: wall.lo, maxMm: wall.hi, stations: wall.n, wantMm: t };
  if (!(wall.lo >= t - NSO_TN_WALL_TOL_MM && wall.hi <= t + NSO_TN_WALL_TOL_MM)) {
    res.reason = 'internal: the wall through the neck reads ' + NSO_tnFmt(wall.lo, 3) + '–' + NSO_tnFmt(wall.hi, 3) + ' mm, not ' + NSO_tnFmt(t, 3) + ' ± ' + NSO_TN_WALL_TOL_MM;
    return res;
  }

  var RO = NSO_tnRings(rd, band.outerTris);
  if (!RO.ok) { res.reason = RO.reason; return res; }
  var RI = NSO_tnRings(rd, band.innerTris);
  if (!RI.ok) { res.reason = RI.reason; return res; }

  var built = NSO_tnBuild(f32in, rd, [
    { tris: band.outerTris, rings: RO, R: Ro, M: pr.O },
    { tris: band.innerTris, rings: RI, R: Ri, M: pr.I }], ha, hb);
  if (!built.ok) { res.reason = built.reason; return res; }
  var out = built.tris;
  res.counts = { trisIn: W.n, trisOut: out.length / 9, removed: built.removed, added: built.added };
  if (res.counts.trisOut > NSO_TN_MAX_TRIS) {
    res.reason = 'the result would have ' + res.counts.trisOut + ' triangles, past the ' + NSO_TN_MAX_TRIS + ' limit';
    return res;
  }

  // ---- gates, on the output ----
  if (typeof NSO_bendTopology === 'function') {
    var T0 = NSO_bendTopology(f32in), T1 = NSO_bendTopology(out);
    res.topology = { before: T0, after: T1 };
    if (T1.open > T0.open || T1.nm > T0.nm || T1.flip > T0.flip || T1.degen > T0.degen || T1.euler !== T0.euler) {
      res.reason = 'internal: the result is not welded (open ' + T0.open + '→' + T1.open + ', non-manifold ' + T0.nm + '→' + T1.nm +
        ', flipped ' + T0.flip + '→' + T1.flip + ', zero-area ' + T0.degen + '→' + T1.degen + ', Euler ' + T0.euler + '→' + T1.euler + ')';
      return res;
    }
  }
  // Pappus: each face's π∫r²dh against its straight wall's, times its ring's
  // polygon factor; the bore's comes off
  function r2dh(M) {
    var s = 0;
    for (var i = 0; i + 1 < M.length; i++) {
      var A = M[i], B = M[i + 1];
      s += (B[1] - A[1]) * (A[0] * A[0] + A[0] * B[0] + B[0] * B[0]) / 3;
    }
    return s;
  }
  function pf(nSeg) { return nSeg * Math.sin(2 * Math.PI / nSeg) / (2 * Math.PI); }
  var pappus = Math.PI * (pf(RO.lower.v.length) * (r2dh(pr.O) - Ro * Ro * L) - pf(RI.lower.v.length) * (r2dh(pr.I) - Ri * Ri * L));
  var vol0 = NSO_teVolume(f32in, C), vol1 = NSO_teVolume(out, C);
  res.volume = { before: vol0, after: vol1, change: vol1 - vol0, pappus: pappus };
  if (!(Math.abs((vol1 - vol0) - pappus) <= NSO_TN_VOLUME_TOL * Math.abs(pappus) + 1e-3)) {
    res.reason = 'internal: the volume changed by ' + NSO_tnFmt(vol1 - vol0, 3) + ' mm³, not Pappus\'s ' + NSO_tnFmt(pappus, 3);
    return res;
  }

  res.ok = true;
  res.tris = out;
  res.wallMm = t;
  res.dr = dr; res.lengthMm = L; res.profileName = prof;
  res.waistBoreDiaMm = 2 * pr.waistBoreR;
  res.waistOuterDiaMm = 2 * pr.waistOuterR;
  res.meridian = { outer: pr.O, inner: pr.I };
  res.reason = NSO_tubeNeckDescribe(res);
  return res;
}

/* The new faces: on each, the band's triangles out; the lower ring's
   vertices carried up through the stations along their own radial lines;
   the last station zipped to the upper ring by angle. */
function NSO_tnBuild(soup, rd, faces, ha, hb) {
  var W = rd.weld, P = W.P, tube = rd.tube, C = tube.center, a = tube.axis, fr = tube.frame, f32 = NSO_teF32;
  var skip = new Uint8Array(W.n), removed = 0, planned = 0;
  var TWO = 2 * Math.PI;
  function theta(x, y, z) {
    var wx = x - C[0], wy = y - C[1], wz = z - C[2];
    return Math.atan2(wx * fr.e2[0] + wy * fr.e2[1] + wz * fr.e2[2], wx * fr.e1[0] + wy * fr.e1[1] + wz * fr.e1[2]);
  }
  // the angle a ring turns through, walked in order
  function turn(ids) {
    var s = 0;
    for (var i = 0; i < ids.length; i++) {
      var A = ids[i] * 3, B = ids[(i + 1) % ids.length] * 3;
      var d = theta(P[B], P[B + 1], P[B + 2]) - theta(P[A], P[A + 1], P[A + 2]);
      d -= TWO * Math.round(d / TWO); s += d;
    }
    return s;
  }
  var plans = [];
  for (var f = 0; f < faces.length; f++) {
    var F = faces[f], lower = F.rings.lower, upper = F.rings.upper, R = F.R, M = F.M;
    var sgn = turn(lower.v) > 0 ? 1 : -1;
    var up = upper.v.slice().reverse();
    if (!(turn(up) * sgn > 0)) return { ok: false, reason: 'internal: the wall\'s two rings run the same way round - its band is not wound as one face' };
    var st = [];
    if (ha - lower.h > NSO_TN_STATION_MIN_MM) st.push([R, ha]);
    for (var k = 1; k + 1 < M.length; k++) st.push(M[k]);
    if (upper.h - hb > NSO_TN_STATION_MIN_MM) st.push([R, hb]);
    var n = lower.v.length, rings = [];
    var R0 = new Float32Array(n * 3);
    for (var j = 0; j < n; j++) { var v = lower.v[j] * 3; R0[j * 3] = P[v]; R0[j * 3 + 1] = P[v + 1]; R0[j * 3 + 2] = P[v + 2]; }
    rings.push(R0);
    for (var s = 0; s < st.length; s++) {
      var Rk = new Float32Array(n * 3), dr = st[s][0] - R, dh = st[s][1] - lower.h;
      for (var j2 = 0; j2 < n; j2++) {
        var v2 = lower.v[j2], X = P[v2 * 3], Y = P[v2 * 3 + 1], Z = P[v2 * 3 + 2];
        var wx = X - C[0], wy = Y - C[1], wz = Z - C[2], h = wx * a[0] + wy * a[1] + wz * a[2];
        var ex = wx - h * a[0], ey = wy - h * a[1], ez = wz - h * a[2], el = Math.hypot(ex, ey, ez);
        ex /= el; ey /= el; ez /= el;
        Rk[j2 * 3] = f32(X + dr * ex + dh * a[0]);
        Rk[j2 * 3 + 1] = f32(Y + dr * ey + dh * a[1]);
        Rk[j2 * 3 + 2] = f32(Z + dr * ez + dh * a[2]);
      }
      rings.push(Rk);
    }
    var U = new Float32Array(up.length * 3);
    for (var u = 0; u < up.length; u++) { var vu = up[u] * 3; U[u * 3] = P[vu]; U[u * 3 + 1] = P[vu + 1]; U[u * 3 + 2] = P[vu + 2]; }
    F.tris.forEach(function (t) { if (!skip[t]) { skip[t] = 1; removed++; } });
    planned += 2 * n * (rings.length - 1) + n + up.length;
    plans.push({ rings: rings, n: n, U: U, m: up.length, sgn: sgn });
  }
  var out = new Float32Array((W.n - removed + planned) * 9), w = 0;
  for (var t = 0; t < W.n; t++) {
    if (skip[t]) continue;
    for (var q = 0; q < 9; q++) out[w++] = soup[t * 9 + q];
  }
  function put(A, i, B, j, Cc, k) {
    out[w++] = A[i * 3]; out[w++] = A[i * 3 + 1]; out[w++] = A[i * 3 + 2];
    out[w++] = B[j * 3]; out[w++] = B[j * 3 + 1]; out[w++] = B[j * 3 + 2];
    out[w++] = Cc[k * 3]; out[w++] = Cc[k * 3 + 1]; out[w++] = Cc[k * 3 + 2];
  }
  plans.forEach(function (pl) {
    var rings = pl.rings, n = pl.n;
    // bands: the lower ring in the order the band walked it, so the first
    // band walks every ring edge the way the removed triangles did
    for (var i = 0; i + 1 < rings.length; i++) {
      for (var j = 0; j < n; j++) {
        var j1 = (j + 1) % n;
        put(rings[i], j, rings[i], j1, rings[i + 1], j1);
        put(rings[i], j, rings[i + 1], j1, rings[i + 1], j);
      }
    }
    // the zip: the last station (in the lower ring's order, its turning way)
    // to the upper ring reversed to run the same way, merged by angle
    var A = rings[rings.length - 1], B = pl.U, m = pl.m, sg = pl.sgn;
    function ang(Q, i) { return sg * theta(Q[i * 3], Q[i * 3 + 1], Q[i * 3 + 2]); }
    var base = ang(A, 0);
    function rel(x) { var d = x - base; d -= TWO * Math.floor(d / TWO); return d; }
    var ao = [];
    for (var j3 = 0; j3 < n; j3++) ao.push(j3 === 0 ? 0 : rel(ang(A, j3)));
    ao.push(TWO);
    var m0 = 0, bestA = Infinity;
    for (var m1 = 0; m1 < m; m1++) {
      var d0 = rel(ang(B, m1)); if (d0 > Math.PI) d0 -= TWO;
      if (Math.abs(d0) < bestA) { bestA = Math.abs(d0); m0 = m1; }
    }
    var ai = [], prevA = null;
    for (var q2 = 0; q2 <= m; q2++) {
      var av = rel(ang(B, (m0 + q2) % m));
      if (q2 === 0) { if (av > Math.PI) av -= TWO; }
      else { while (av <= prevA) av += TWO; }
      if (q2 === m) av = ai[0] + TWO;
      ai.push(av); prevA = av;
    }
    var jo = 0, ki = 0;
    while (jo < n || ki < m) {
      var pA = jo % n, pA1 = (jo + 1) % n, qB = (m0 + ki) % m, qB1 = (m0 + ki + 1) % m;
      if (jo < n && (ki >= m || ao[jo + 1] <= ai[ki + 1])) { put(A, pA, A, pA1, B, qB); jo++; }
      else { put(A, pA, B, qB1, B, qB); ki++; }
    }
  });
  if (w !== out.length) return { ok: false, reason: 'internal: built ' + w / 9 + ' triangles, planned ' + out.length / 9 };
  return { ok: true, tris: out, removed: removed, added: planned };
}

/* One line: what was done, the numbers that matter. */
function NSO_tubeNeckDescribe(r) {
  var b = r.band, pinch = r.dr < 0;
  return (pinch ? 'Pinch ' : 'Bulge ') + NSO_tnSigned(r.dr) + ' mm over ' + NSO_tnFmt(r.lengthMm, 1) + ' mm, ' + r.profileName +
    ', centred ' + NSO_tnIn(b.h0) + ' mm in: bore Ø' + NSO_tnFmt(2 * b.Ri) + ' → Ø' + NSO_tnFmt(r.waistBoreDiaMm) + ', outside Ø' +
    NSO_tnFmt(2 * b.Ro) + ' → Ø' + NSO_tnFmt(r.waistOuterDiaMm) + ' at the waist · wall ' + NSO_tnFmt(r.wallMm) + ' held (' +
    NSO_tnFmt(r.wall.minMm, 3) + '–' + NSO_tnFmt(r.wall.maxMm, 3) + ' mm through the neck)';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NSO_tubeNeckRead: NSO_tubeNeckRead, NSO_tubeNeckRaw: NSO_tubeNeckRaw, NSO_tubeNeckDescribe: NSO_tubeNeckDescribe };
}
