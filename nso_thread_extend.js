/* nso_thread_extend.js - make an existing screw's thread longer (or shorter) WITHOUT changing its pitch, its size or its profile.
   docs/THREADS.md, "Extend a screw's thread".

   Headless: no DOM, no THREE. Loads as a classic script (window.NSO_ThreadExtend) and as a Node module; tools/nso_thread_extend_test.js
   drives it, app-fasteners.js (Gen+ > Fasteners > Extend) is the card on it. The boolean kernel (Manifold, nso_csg.js) is handed in.

     NSO_ThreadExtend.read(soup, opts)                    -> { ok, reason, pitch, hand, majorDia, minorDia, zone, full, tip, turnsFull, ... }
     NSO_ThreadExtend.extend(soup, read, turns, wasm, h)  -> Promise { ok, reason, soup, info }

   THE IDEA. A helical thread is its own copy one pitch along its axis: moved P along the axis it lands on itself. So the part of a screw
   between two planes a whole number of pitches apart, inside the thread, is a SLAB that fits into a cut at either plane - the cross-
   section where it is cut is the same curve at both ends. To make the thread n turns longer: cut the screw across the thread (at `a`),
   move the tip side n x P along the axis, and fill the gap with copies of the slab [a - m P, a] (m turns at a time). The thread's own
   profile, flanks, crests, any bevel or run-out at the tip, the head and everything else are the screw's own: nothing is re-drawn.
   Shorter is the same with a slab taken out. The pieces overlap by a fraction of a pitch and are unioned on the kernel, so the two copies
   of the same helical surface in the overlap are one (they differ by tessellation only: microns).

   READING THE SCREW (read):
     axis     the solid's principal axis of inertia that is ITS axis of symmetry - the one whose two other moments are equal (a screw,
              rod, pin: any piece turned about one axis). Within 1.5 degrees of a world axis it is snapped to it (an exported part is
              almost always square to its frame, and a translation along a wrong axis would not land the thread on itself). The axis
              runs through the solid's centroid.
     profile  the outside radius along the axis at two angles, by rays from outside (bucketed by height so a ray sees only its slab).
     thread   the longest run of maxima a steady distance apart with a real depth: its spacing is the pitch, refined to the shift that
              makes the profile land on itself best (least squares over the whole run), and snapped to a whole 0.05 mm or a whole
              thread-per-inch when that fits as well.
     hand     at a quarter turn the profile has moved +P/4 along the axis (right-hand) or -P/4 (left).
     full     the part of the run where the thread is full depth (not the run-out at the tip or by the head): cuts are made only there.
     tip      the end of the piece the thread is nearer: that side moves; the other (the head) stays where it is.

   REFUSED, in words, nothing changed: no axis of symmetry; no thread found along it; under three full turns to cut in; more turns
   taken out than the thread has; a piece that is not a closed solid (the kernel refuses it: Repair it first).

   PAINT SCOPE: WHOLE-PIECE - the result is a new mesh for the whole piece (the app's commit replaces it; paint is cleared by the commit
   as for any bake). */

(function (root) {
  'use strict';

  var DEFAULTS = {
    snapDeg: 1.5,          // an axis this close to a world axis is the world axis
    minTurns: 3,           // full-depth turns the thread must have to be cut in
    simplify: 2e-4,        // mm: after the union, edges shorter than this are collapsed (the app welds at 1e-4)
    margin: 0.25           // of a pitch: how far inside the full-depth zone the cuts are kept
  };

  function fmt(x, dp) { return (+x).toFixed(dp == null ? 2 : dp); }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function unit(a) { var L = Math.sqrt(dot(a, a)); return L > 1e-300 ? [a[0] / L, a[1] / L, a[2] / L] : null; }

  /* ------------------------------------------------------------ the axis */

  /* volume, centroid and central second moments of a closed, outward-wound soup (signed tetrahedra from the origin) */
  function moments(s) {
    var V = 0, c = [0, 0, 0], S = [0, 0, 0, 0, 0, 0, 0, 0, 0], i, j;
    for (var o = 0; o < s.length; o += 9) {
      var a = [s[o], s[o + 1], s[o + 2]], b = [s[o + 3], s[o + 4], s[o + 5]], d = [s[o + 6], s[o + 7], s[o + 8]];
      var v = dot(a, cross(b, d)) / 6;
      V += v;
      for (i = 0; i < 3; i++) c[i] += v * (a[i] + b[i] + d[i]) / 4;
      var sm = [a[0] + b[0] + d[0], a[1] + b[1] + d[1], a[2] + b[2] + d[2]];
      for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) S[3 * i + j] += v / 20 * (a[i] * a[j] + b[i] * b[j] + d[i] * d[j] + sm[i] * sm[j]);
    }
    if (!(Math.abs(V) > 1e-9)) return null;
    for (i = 0; i < 3; i++) c[i] /= V;
    for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) S[3 * i + j] -= V * c[i] * c[j];
    return { V: V, c: c, S: S };
  }
  /* eigen-decomposition of a symmetric 3x3 (Jacobi): { val: [3], vec: [[3] x 3] } */
  function eig3(S) {
    var A = S.slice(), Vv = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (var sweep = 0; sweep < 50; sweep++) {
      var off = Math.abs(A[1]) + Math.abs(A[2]) + Math.abs(A[5]);
      if (off < 1e-15 * (Math.abs(A[0]) + Math.abs(A[4]) + Math.abs(A[8]) + 1e-300)) break;
      for (var p = 0; p < 2; p++) for (var q = p + 1; q < 3; q++) {
        var apq = A[3 * p + q];
        if (Math.abs(apq) < 1e-300) continue;
        var th = (A[3 * q + q] - A[3 * p + p]) / (2 * apq), t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        var cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
        for (var k = 0; k < 3; k++) {                         // A = J^T A J
          var akp = A[3 * k + p], akq = A[3 * k + q];
          A[3 * k + p] = cs * akp - sn * akq; A[3 * k + q] = sn * akp + cs * akq;
        }
        for (k = 0; k < 3; k++) {
          var apk = A[3 * p + k], aqk = A[3 * q + k];
          A[3 * p + k] = cs * apk - sn * aqk; A[3 * q + k] = sn * apk + cs * aqk;
        }
        for (k = 0; k < 3; k++) {
          var vkp = Vv[3 * k + p], vkq = Vv[3 * k + q];
          Vv[3 * k + p] = cs * vkp - sn * vkq; Vv[3 * k + q] = sn * vkp + cs * vkq;
        }
      }
    }
    return { val: [A[0], A[4], A[8]], vec: [[Vv[0], Vv[3], Vv[6]], [Vv[1], Vv[4], Vv[7]], [Vv[2], Vv[5], Vv[8]]] };
  }
  /* the axis of symmetry: the principal direction whose two other moments are the most nearly equal */
  function symmetryAxis(s, snapDeg) {
    var m = moments(s);
    if (!m) return { ok: false, reason: 'the piece has no volume - it is not a closed solid' };
    var e = eig3(m.S), best = -1, score = Infinity, i;
    var scale = Math.max(Math.abs(e.val[0]), Math.abs(e.val[1]), Math.abs(e.val[2]), 1e-12);
    for (i = 0; i < 3; i++) {
      var a = e.val[(i + 1) % 3], b = e.val[(i + 2) % 3], dEq = Math.abs(a - b) / scale, dSep = Math.abs(e.val[i] - (a + b) / 2) / scale;
      var sc = dEq - 0.25 * dSep;                            // the two others equal, this one apart
      if (sc < score) { score = sc; best = i; }
    }
    var u = unit(e.vec[best]), snapped = null;
    var cosSnap = Math.cos((snapDeg == null ? DEFAULTS.snapDeg : snapDeg) * Math.PI / 180);
    for (i = 0; i < 3; i++) if (Math.abs(u[i]) >= cosSnap) { snapped = 'xyz'[i]; u = [0, 0, 0]; u[i] = 1; }
    var a2 = e.val[(best + 1) % 3], b2 = e.val[(best + 2) % 3];
    return { ok: true, c: m.c, u: u, snapped: snapped, roundness: Math.abs(a2 - b2) / scale, volume: m.V };
  }
  /* an orthonormal frame round u: v, w with w = u x v (so theta measured from v toward w is counter-clockwise looking down -u) */
  function frameOf(u) {
    var t = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    var v = unit(cross(cross(u, t), u)), w = cross(u, v);
    return { u: u, v: v, w: w };
  }

  /* ------------------------------------------------------- the radial probe */
  /* the soup in the axis frame (x along v, y along w, z along u, from c), and its triangles bucketed by height */
  function probeOf(s, c, F) {
    var n = (s.length / 9) | 0, L = new Float64Array(s.length), zlo = Infinity, zhi = -Infinity, rmax = 0;
    for (var i = 0; i < s.length; i += 3) {
      var d = [s[i] - c[0], s[i + 1] - c[1], s[i + 2] - c[2]];
      var x = dot(d, F.v), y = dot(d, F.w), z = dot(d, F.u);
      L[i] = x; L[i + 1] = y; L[i + 2] = z;
      if (z < zlo) zlo = z; if (z > zhi) zhi = z;
      var r = Math.hypot(x, y); if (r > rmax) rmax = r;
    }
    var span = zhi - zlo, W = Math.max(0.2, span / 600), nb = Math.max(1, Math.ceil(span / W) + 1), bins = [];
    for (var b = 0; b < nb; b++) bins.push([]);
    for (var t = 0; t < n; t++) {
      var a = Math.min(L[9 * t + 2], L[9 * t + 5], L[9 * t + 8]), e = Math.max(L[9 * t + 2], L[9 * t + 5], L[9 * t + 8]);
      for (var k = Math.max(0, Math.floor((a - zlo) / W)); k <= Math.min(nb - 1, Math.floor((e - zlo) / W)); k++) bins[k].push(t);
    }
    /* the outermost surface at (theta, z): the first hit of a ray from outside toward the axis, as a radius (NaN: none) */
    function radius(th, z) {
      var k = Math.floor((z - zlo) / W);
      if (k < 0 || k >= nb) return NaN;
      var dx = -Math.cos(th), dy = -Math.sin(th), R = rmax + 1, ox = -dx * R, oy = -dy * R, best = Infinity, list = bins[k];
      for (var q = 0; q < list.length; q++) {
        var o = 9 * list[q];
        var e1x = L[o + 3] - L[o], e1y = L[o + 4] - L[o + 1], e1z = L[o + 5] - L[o + 2], e2x = L[o + 6] - L[o], e2y = L[o + 7] - L[o + 1], e2z = L[o + 8] - L[o + 2];
        var px = dy * e2z, py = -dx * e2z, pz = dx * e2y - dy * e2x;          // d x e2, d = (dx, dy, 0)
        var det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-14) continue;
        var tx = ox - L[o], ty = oy - L[o + 1], tz = z - L[o + 2], u = (tx * px + ty * py + tz * pz) / det;
        if (u < -1e-9 || u > 1 + 1e-9) continue;
        var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, vv = (dx * qx + dy * qy) / det;
        if (vv < -1e-9 || u + vv > 1 + 1e-9) continue;
        var tt = (e2x * qx + e2y * qy + e2z * qz) / det;
        if (tt > 0 && tt < best) best = tt;
      }
      return isFinite(best) ? R - best : NaN;
    }
    return { L: L, zlo: zlo, zhi: zhi, rmax: rmax, radius: radius };
  }

  /* -------------------------------------------------------- the thread */
  function interp(ys, z0, dz, z) {
    var f = (z - z0) / dz, i = Math.floor(f);
    if (i < 0 || i + 1 >= ys.length) return NaN;
    var a = ys[i], b = ys[i + 1]; return a + (b - a) * (f - i);
  }
  /* how badly the profile fails to land on itself moved by P (mean square, over [lo, hi - P]) */
  function mismatch(ys, z0, dz, lo, hi, P) {
    var s = 0, n = 0;
    for (var z = lo; z + P <= hi; z += dz) { var a = interp(ys, z0, dz, z), b = interp(ys, z0, dz, z + P); if (isFinite(a) && isFinite(b)) { s += (a - b) * (a - b); n++; } }
    return n ? s / n : Infinity;
  }

  function read(soup, opts) {
    opts = opts || {};
    var res = { ok: false, reason: '' };
    if (!soup || soup.length < 36 || soup.length % 9) { res.reason = 'there is no piece to read'; return res; }
    var ax = opts.axis ? { ok: true, c: opts.center || moments(soup).c, u: unit(opts.axis), snapped: null } : symmetryAxis(soup, opts.snapDeg);
    if (!ax.ok) { res.reason = ax.reason; return res; }
    if (!opts.axis && ax.roundness > 0.08) {
      res.reason = 'the piece is not turned about an axis (its section is not round: ' + fmt(ax.roundness * 100, 0) + '% out) - a screw, a bolt or a threaded rod is';
      return res;
    }
    var F = frameOf(ax.u), pr = probeOf(soup, ax.c, F), span = pr.zhi - pr.zlo;
    var dz = Math.max(0.004, Math.min(0.03, span / 3000)), z0 = pr.zlo + dz / 2, nz = Math.floor((span - dz) / dz), r0 = [], r90 = [], i;
    for (i = 0; i <= nz; i++) r0.push(pr.radius(0, z0 + i * dz));
    // extrema with hysteresis: a crest is a maximum a real depth above the roots either side
    var hyst = Math.max(0.03, pr.rmax * 0.004), ext = [], dir = 0, cand = 0;
    for (i = 1; i < r0.length; i++) {
      if (!isFinite(r0[i])) continue;
      if (!isFinite(r0[cand])) { cand = i; continue; }
      if (dir >= 0) { if (r0[i] > r0[cand]) cand = i; else if (r0[cand] - r0[i] > hyst) { ext.push({ i: cand, max: true }); dir = -1; cand = i; } }
      else { if (r0[i] < r0[cand]) cand = i; else if (r0[i] - r0[cand] > hyst) { ext.push({ i: cand, max: false }); dir = 1; cand = i; } }
    }
    var maxes = ext.filter(function (e) { return e.max; });
    // the longest run of crests a steady distance apart
    var bestRun = null;
    for (var a0 = 0; a0 + 2 < maxes.length; a0++) {
      var sp0 = maxes[a0 + 1].i - maxes[a0].i, b0 = a0 + 1;
      while (b0 + 1 < maxes.length && Math.abs((maxes[b0 + 1].i - maxes[b0].i) - sp0) <= Math.max(2, 0.08 * sp0)) b0++;
      if (b0 - a0 >= 2 && (!bestRun || b0 - a0 > bestRun.b - bestRun.a)) bestRun = { a: a0, b: b0 };
    }
    if (!bestRun) { res.reason = 'no thread found along the piece\'s axis (its outline does not rise and fall at a steady pitch)'; return res; }
    var iLo = maxes[bestRun.a].i, iHi = maxes[bestRun.b].i, P0 = (iHi - iLo) * dz / (bestRun.b - bestRun.a);
    var crest = -Infinity, rootR = Infinity;
    for (i = iLo; i <= iHi; i++) if (isFinite(r0[i])) { crest = Math.max(crest, r0[i]); rootR = Math.min(rootR, r0[i]); }
    var depth = crest - rootR;
    if (!(depth > 0.1) || !(P0 > 0.2)) { res.reason = 'no thread found along the piece\'s axis (a ' + fmt(depth, 2) + ' mm ripple is not one)'; return res; }
    // the run's ends, half a pitch past its outer crests; and the full-depth part of it: from its first full-depth root to its last.
    // (Bounded by roots, not by half a pitch past the crests: by the head the thread may run into a shank at crest height, and half a
    // pitch back from the first crest is then plain shank.)
    var runLo = z0 + iLo * dz - P0 / 2, runHi = z0 + iHi * dz + P0 / 2;
    var fullMins = ext.filter(function (e) { return !e.max && e.i > iLo && e.i < iHi && r0[e.i] <= rootR + 0.1 * depth; });
    if (fullMins.length < 2) { res.reason = 'no thread found along the piece\'s axis (under two full-depth roots)'; return res; }
    var fullLo = z0 + fullMins[0].i * dz, fullHi = z0 + fullMins[fullMins.length - 1].i * dz;
    // the pitch: the shift that makes the profile land on itself best, over as many turns as the run has
    // (one shift of many turns compares only a sliver of the run; one, half the run and the whole run together use all of it)
    var k = Math.max(1, Math.floor((fullHi - fullLo) / P0) - 1), lo = fullLo + 0.1 * P0, hi = fullHi - 0.1 * P0;
    var shifts = [1, Math.max(1, Math.round(k / 2)), k].filter(function (x, i, a) { return a.indexOf(x) === i; });
    var f = function (P) { var e = 0; shifts.forEach(function (j) { e += mismatch(r0, z0, dz, lo, hi, j * P); }); return e / shifts.length; };
    var A = P0 * 0.97, B = P0 * 1.03, g = (Math.sqrt(5) - 1) / 2, x1 = B - g * (B - A), x2 = A + g * (B - A), f1 = f(x1), f2 = f(x2);
    for (var it = 0; it < 60; it++) {
      if (f1 < f2) { B = x2; x2 = x1; f2 = f1; x1 = B - g * (B - A); f1 = f(x1); }
      else { A = x1; x1 = x2; f1 = f2; x2 = A + g * (B - A); f2 = f(x2); }
    }
    var P = (A + B) / 2, eP = f(P), snappedP = null;
    var cands = [Math.round(P / 0.05) * 0.05];
    for (var tpi = 4; tpi <= 80; tpi += 0.5) cands.push(25.4 / tpi);
    cands.forEach(function (c) { if (Math.abs(c - P) <= 0.002 * P && f(c) <= Math.max(eP * 1.5, eP + 1e-6) && (!snappedP || Math.abs(c - P) < Math.abs(snappedP - P))) snappedP = c; });
    if (snappedP) P = snappedP;
    var rms = Math.sqrt(f(P));
    // the hand: a quarter turn on, the profile has moved +P/4 along the axis for a right-hand thread
    var mid = (crest + rootR) / 2, rise = function (th) {
      var z = fullLo + P * 0.5, prev = pr.radius(th, z);
      for (var q = 1; q < Math.ceil(1.5 * P / (dz / 2)); q++) { var zz = z + q * dz / 2, r = pr.radius(th, zz); if (prev < mid && r >= mid) return zz - (dz / 2) * (r - mid) / (r - prev); prev = r; }
      return NaN;
    };
    var za = rise(0), zb = rise(Math.PI / 2), d = zb - za; d -= Math.round(d / P) * P;
    var hand = d > 0 ? 1 : -1;
    var handOk = Math.abs(Math.abs(d) - P / 4) < 0.2 * P;
    // which end is the tip: the end of the piece the thread is nearer
    var dLo = runLo - pr.zlo, dHi = pr.zhi - runHi, tip = dHi <= dLo ? 1 : -1;
    var turnsFull = (fullHi - fullLo) / P;
    if (turnsFull < DEFAULTS.minTurns) {
      res.reason = 'the thread has only ' + fmt(turnsFull, 1) + ' full turns - at least ' + DEFAULTS.minTurns + ' are needed to cut a whole pitch out of it cleanly';
      return res;
    }
    res.ok = true;
    res.axis = { c: ax.c, u: ax.u, v: F.v, w: F.w, snapped: ax.snapped };
    res.pitch = P; res.pitchSnapped = !!snappedP; res.hand = hand; res.handClear = handOk;
    res.majorDia = 2 * crest; res.minorDia = 2 * rootR; res.depth = depth;
    res.zone = { lo: runLo, hi: runHi }; res.full = { lo: fullLo, hi: fullHi }; res.span = { lo: pr.zlo, hi: pr.zhi };
    res.tip = tip; res.turnsFull = turnsFull; res.threadLength = runHi - runLo; res.fitRms = rms;
    res.reason = 'Thread found: Ø' + fmt(2 * crest) + ' / root Ø' + fmt(2 * rootR) + ', pitch ' + fmt(P, 3) + ' mm' + (snappedP ? '' : ' (measured)') + ', ' + (hand > 0 ? 'right' : 'left') + '-hand, ' +
      fmt(runHi - runLo, 1) + ' mm long (' + fmt(turnsFull, 1) + ' full turns)' + (ax.snapped ? ', along ' + ax.snapped.toUpperCase() : '');
    return res;
  }

  /* -------------------------------------------------------- the extension */

  /* the rigid map into the working frame - tip toward +z - and back. A proper rotation (no mirror), so the winding stays outward. */
  function workFrame(rd) {
    var s = rd.tip, u = rd.axis.u, v = rd.axis.v, w = rd.axis.w, c = rd.axis.c;
    var U = [u[0] * s, u[1] * s, u[2] * s], Wv = [w[0] * s, w[1] * s, w[2] * s];          // (v, s w, s u): det = s^2 = +1
    return {
      to: function (soup) {
        var o = new Float32Array(soup.length);
        for (var i = 0; i < soup.length; i += 3) {
          var d = [soup[i] - c[0], soup[i + 1] - c[1], soup[i + 2] - c[2]];
          o[i] = dot(d, v); o[i + 1] = dot(d, Wv); o[i + 2] = dot(d, U);
        }
        return o;
      },
      from: function (soup) {
        var o = new Float32Array(soup.length);
        for (var i = 0; i < soup.length; i += 3) {
          var x = soup[i], y = soup[i + 1], z = soup[i + 2];
          for (var k = 0; k < 3; k++) o[i + k] = c[k] + x * v[k] + y * Wv[k] + z * U[k];
        }
        return o;
      },
      z: function (zAxis) { return zAxis * s; }                // an axis height into the working frame
    };
  }

  /* ------------------------------------------------- an indexed mesh, cut */

  /* weld the soup by exact coordinates: { V: [[x, y, z]...], T: [[a, b, c]...] } (a CAD export shares its corners exactly) */
  function indexed(soup) {
    var ids = new Map(), V = [], T = [];
    for (var t = 0; t < soup.length / 9; t++) {
      var tri = [];
      for (var k = 0; k < 3; k++) {
        var o = 9 * t + 3 * k, key = soup[o] + ',' + soup[o + 1] + ',' + soup[o + 2], id = ids.get(key);
        if (id === undefined) { id = V.length; ids.set(key, id); V.push([soup[o], soup[o + 1], soup[o + 2]]); }
        tri.push(id);
      }
      if (tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) T.push(tri);
    }
    return { V: V, T: T };
  }

  /* cut the triangles T (of vertex array V, which gains the crossing points) at the plane z = c: { below, above } triangle lists and the
     cut as a closed LOOP of crossing points, in order round the axis (theta increasing). No vertex may lie on the plane (the caller keeps
     every plane clear of them). Refused (null) if the cut is not one loop going once round the axis. */
  function cut(V, T, c) {
    var crossed = new Map(), below = [], above = [], seg = new Map();
    function cx(a, b) {
      var lo = a < b ? a : b, hi = a < b ? b : a, key = lo * 4294967296 + hi, h = crossed.get(key);
      if (h !== undefined) return h;
      var A = V[lo], B = V[hi], t = (c - A[2]) / (B[2] - A[2]);
      h = V.length; V.push([A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1]), c]); crossed.set(key, h);
      return h;
    }
    for (var i = 0; i < T.length; i++) {
      var tr = T[i], up = [V[tr[0]][2] > c, V[tr[1]][2] > c, V[tr[2]][2] > c], nUp = up[0] + up[1] + up[2];
      if (nUp === 0) { below.push(tr); continue; }
      if (nUp === 3) { above.push(tr); continue; }
      var bp = [], ap = [], pts = [];
      for (var e = 0; e < 3; e++) {
        var a = tr[e], b = tr[(e + 1) % 3];
        (up[e] ? ap : bp).push(a);
        if (up[e] !== up[(e + 1) % 3]) { var x = cx(a, b); bp.push(x); ap.push(x); pts.push(x); }
      }
      for (var f = 1; f + 1 < bp.length; f++) below.push([bp[0], bp[f], bp[f + 1]]);
      for (f = 1; f + 1 < ap.length; f++) above.push([ap[0], ap[f], ap[f + 1]]);
      // the cut edge as the BELOW side walks it (its boundary runs this way round): from the point it enters on to the one it leaves by
      var p0 = pts[0], p1 = pts[1], inBelow = bp.indexOf(p0), nb = bp.indexOf(p1);
      if ((inBelow + 1) % bp.length === nb) seg.set(p0, p1); else seg.set(p1, p0);
    }
    // chain the cut edges into the loop
    if (!seg.size) return null;
    var start = seg.keys().next().value, loop = [start], cur = seg.get(start), guard = 0;
    while (cur !== start && cur !== undefined && guard++ < seg.size + 2) { loop.push(cur); cur = seg.get(cur); }
    if (cur !== start || loop.length !== seg.size) return null;                // more than one loop: not a solid screw's section
    // theta along it, unwrapped; the loop must go once round, and we want it counter-clockwise
    var th = loop.map(function (h) { return Math.atan2(V[h][1], V[h][0]); }), un = [th[0]], back = 0;
    for (i = 1; i < th.length; i++) { var d = th[i] - th[i - 1]; d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI; un.push(un[i - 1] + d); }
    var turn = un[un.length - 1] + (function () { var d = th[0] - th[th.length - 1]; return d - Math.round(d / (2 * Math.PI)) * 2 * Math.PI; })() - un[0];
    if (Math.abs(Math.abs(turn) - 2 * Math.PI) > 1e-3) return null;          // does not go once round the axis
    if (turn < 0) { loop.reverse(); un.reverse(); }                            // the same angles, walked the other way
    for (i = 1; i < un.length; i++) if (un[i] < un[i - 1] - 1e-9) back++;
    if (back) return null;                                                     // doubles back: the section is not one radius per angle
    // a cut edge shorter than the app's weld can tell apart (a sliver cut across) is collapsed: its end merges into its start, on both
    // sides, and the sliver's triangle on each side goes
    var MINE = 3e-4, gone = new Map();
    for (i = 0; i < loop.length && loop.length > 3; i++) {
      var u = loop[i], w = loop[(i + 1) % loop.length], pu = V[u], pw = V[w];
      if (Math.hypot(pu[0] - pw[0], pu[1] - pw[1]) >= MINE) continue;
      gone.set(w, u); loop.splice((i + 1) % loop.length, 1); i--;
    }
    if (gone.size) {
      var fix = function (Tl) {
        var outT = [];
        for (var q = 0; q < Tl.length; q++) {
          var t2 = Tl[q].map(function (h) { while (gone.has(h)) h = gone.get(h); return h; });
          if (t2[0] !== t2[1] && t2[1] !== t2[2] && t2[0] !== t2[2]) outT.push(t2);
        }
        return outT;
      };
      below = fix(below); above = fix(above);
    }
    return { below: below, above: above, loop: loop, collapsed: gone.size };
  }

  /* ZIP two cuts of the same section into one seam. A (loop of vertices at the seam's plane) and B (a loop elsewhere, `shift` along z
     from it) are the same curve drawn with different points. The seam is both point sets, in angle order; a point of one closer than
     `tol` to a point of the other is the same point (B's moves onto A's), and every other point is put into the other side's edge it
     falls in - the triangle on that edge is split, so no T-junction is left. After this both sides run through exactly the seam's points.
       sides: [{ loop, T (triangle lists, each split in place), shift }] for A and B; V gains the new points.
     Returns the seam as A's vertex ids (B's side refers to its own copies, mapped in mapB). */
  function zip(V, A, B, tol) {
    function polar(h, dz) { var p = V[h]; return { h: h, th: Math.atan2(p[1], p[0]), r: Math.hypot(p[0], p[1]), z: p[2] + dz }; }
    var pa = A.loop.map(function (h) { return polar(h, 0); }), pb = B.loop.map(function (h) { return polar(h, -B.shift); });
    // start both at their smallest angle
    function rot(arr) { var k = 0; for (var i = 1; i < arr.length; i++) if (arr[i].th < arr[k].th) k = i; return arr.slice(k).concat(arr.slice(0, k)); }
    pa = rot(pa); pb = rot(pb);
    var xy = function (q) { return [q.r * Math.cos(q.th), q.r * Math.sin(q.th)]; }, dist = function (p, q) { var u = xy(p), w = xy(q); return Math.hypot(u[0] - w[0], u[1] - w[1]); };
    // one-to-one: each B point to its nearest A point within tol (searched among A's neighbours by angle); the nearer B wins an A
    var thA = pa.map(function (q) { return q.th; }), matchOf = new Array(pa.length).fill(-1), dOf = new Array(pa.length).fill(Infinity);
    pb.forEach(function (q, jb) {
      var lo = 0, hi = thA.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (thA[mid] < q.th) lo = mid + 1; else hi = mid; }
      for (var o = -2; o <= 2; o++) {
        var ia = ((lo + o) % pa.length + pa.length) % pa.length, d = dist(pa[ia], q);
        if (d < tol && d < dOf[ia]) { dOf[ia] = d; matchOf[ia] = jb; }
      }
    });
    var bTaken = new Array(pb.length).fill(-1);
    matchOf.forEach(function (jb, ia) { if (jb >= 0 && (bTaken[jb] < 0 || dOf[ia] < dOf[bTaken[jb]])) bTaken[jb] = ia; });
    matchOf = matchOf.map(function (jb, ia) { return jb >= 0 && bTaken[jb] === ia ? jb : -1; });
    // the seam, in angle order: matched pairs at their A point's angle, the rest at their own
    var entries = [];
    pa.forEach(function (q, ia) { entries.push(matchOf[ia] >= 0 ? { th: q.th, a: q, b: pb[matchOf[ia]] } : { th: q.th, a: q }); });
    pb.forEach(function (q, jb) { if (bTaken[jb] < 0) entries.push({ th: q.th, b: q }); });
    entries.sort(function (p, q) { return p.th - q.th; });
    var merged = entries;
    // consecutive seam points still closer than the app's weld can tell apart are one point: on a side that owns both, the second is
    // collapsed into the first (its triangle on the short edge goes); on a side that owns only the second, the first takes it
    var MINE = 3e-4, posOf = function (m) { return m.a ? xy(m.a) : xy(m.b); };
    var collapse = function (Tls, from, to) {
      Tls.forEach(function (Tl) {
        for (var t = Tl.length - 1; t >= 0; t--) {
          var tr = Tl[t], k2 = tr.indexOf(from);
          if (k2 < 0) continue;
          tr[k2] = to;
          if (tr[0] === tr[1] || tr[1] === tr[2] || tr[0] === tr[2]) Tl.splice(t, 1);
        }
      });
    };
    for (var g = 0; g < merged.length && merged.length > 3; g++) {
      var e1 = merged[g], e2 = merged[(g + 1) % merged.length], p1 = posOf(e1), p2 = posOf(e2);
      if (Math.hypot(p1[0] - p2[0], p1[1] - p2[1]) >= MINE) continue;
      if (e2.a) { if (e1.a) collapse(A.T, e2.a.h, e1.a.h); else e1.a = e2.a; }
      if (e2.b) { if (e1.b) collapse(B.T, e2.b.h, e1.b.h); else e1.b = e2.b; }
      merged.splice((g + 1) % merged.length, 1); g--;
    }
    // the seam's points: A's own where it has one, else a new point at B's position on A's plane (and the other way round)
    var seamA = [], seamB = [];
    merged.forEach(function (m) {
      // (B's plane is A's + shift: a point carried from A to B is moved +shift, from B to A -shift)
      if (m.a && m.b) { seamA.push(m.a.h); V[m.b.h] = [V[m.a.h][0], V[m.a.h][1], V[m.a.h][2] + B.shift]; seamB.push(m.b.h); }
      else if (m.a) { seamA.push(m.a.h); var nb = V.length; V.push([V[m.a.h][0], V[m.a.h][1], V[m.a.h][2] + B.shift]); seamB.push(nb); m.newB = nb; }
      else { var na = V.length; V.push([V[m.b.h][0], V[m.b.h][1], V[m.b.h][2] - B.shift]); seamA.push(na); seamB.push(m.b.h); m.newA = na; }
    });
    // split each side's edges: between two of its own consecutive loop points, the new points that fall there
    function splitSide(seam, own, triSets) {
      var n = seam.length, runs = [], k0 = -1;
      for (var k = 0; k < n; k++) if (own(k)) { k0 = k; break; }
      if (k0 < 0) return;
      for (var q = 0; q < n; q++) {
        var k1 = (k0 + q) % n;
        if (!own(k1)) continue;
        var ins = [], k2 = (k1 + 1) % n;
        while (!own(k2)) { ins.push(seam[k2]); k2 = (k2 + 1) % n; }
        if (ins.length) runs.push({ u: seam[k1], v: seam[k2], ins: ins });
      }
      // the triangles on each split edge, found once per triangle list (an edge -> [list, triangle] index of the loop's edges only)
      var want = new Map();
      runs.forEach(function (rn) { want.set(rn.u < rn.v ? rn.u + '_' + rn.v : rn.v + '_' + rn.u, rn); });
      triSets.forEach(function (Tl) {
        var hits = [];
        for (var t = 0; t < Tl.length; t++) {
          var tr = Tl[t];
          for (var e = 0; e < 3; e++) {
            var x = tr[e], y = tr[(e + 1) % 3], key = x < y ? x + '_' + y : y + '_' + x, rn = want.get(key);
            if (rn) hits.push({ t: t, rn: rn, fwd: x === rn.u });
          }
        }
        // replace from the end, so the indices still to come stay valid
        hits.sort(function (p, q) { return q.t - p.t; });
        hits.forEach(function (hh) {
          var tr = Tl[hh.t], rn = hh.rn, iu = tr.indexOf(rn.u), iv = tr.indexOf(rn.v), o = tr[3 - iu - iv];
          var chain = hh.fwd ? [rn.u].concat(rn.ins, [rn.v]) : [rn.v].concat(rn.ins.slice().reverse(), [rn.u]);
          var repl = [];
          for (var c = 0; c + 1 < chain.length; c++) repl.push([chain[c], chain[c + 1], o]);
          Tl.splice.apply(Tl, [hh.t, 1].concat(repl));
        });
      });
    }
    var ownA = merged.map(function (m) { return !!m.a; }), ownB = merged.map(function (m) { return !!m.b; });
    splitSide(seamA, function (k) { return ownA[k]; }, A.T);
    splitSide(seamB, function (k) { return ownB[k]; }, B.T);
    return { seamA: seamA, seamB: seamB, merged: merged.length, shared: merged.filter(function (m) { return m.a && m.b; }).length };
  }

  /* turns > 0: that many turns longer; < 0: shorter. { ok, reason, soup, info } - no kernel: the pieces are stitched at exact seams. */
  function extend(soup, rd, turns) {
    var res = { ok: false, reason: '' };
    turns = Math.round(+turns || 0);
    if (!rd || !rd.ok) { res.reason = (rd && rd.reason) || 'read the thread first'; return res; }
    if (!turns) { res.reason = 'no change - 0 turns'; return res; }
    var P = rd.pitch, WF = workFrame(rd);
    var fa = WF.z(rd.full.lo), fb = WF.z(rd.full.hi), f0 = Math.min(fa, fb), f1 = Math.max(fa, fb), mg = DEFAULTS.margin * P;
    var avail = Math.floor((f1 - f0 - 2 * mg) / P);
    if (avail < 1) { res.reason = 'the thread is too short to cut a whole pitch out of it cleanly'; return res; }
    if (turns < 0 && -turns > avail) {
      res.reason = 'the thread has ' + fmt(rd.turnsFull, 1) + ' full turns - at most ' + avail + ' can be taken out of it (a little is kept at each end)';
      return res;
    }
    var work = WF.to(soup), M = indexed(work), V = M.V;
    // the cut planes, nudged clear of every vertex (a crossing on a vertex would make a zero-length edge)
    var chunk = Math.min(avail, Math.abs(turns)), planesFor = function (a) {
      if (turns > 0) { var ps = [a, a - chunk * P], last = turns % chunk; if (last) ps.push(a - last * P); return ps; }
      return [a, a - turns * P];
    };
    // points of the piece closer together than the app's weld (a flaw it came with): the cuts keep away from them, and the result says so
    var badZ = [], cellOf = new Map(), CW = 1e-4;
    for (var vi = 0; vi < V.length; vi++) {
      var p0 = V[vi], kx = Math.floor(p0[0] / CW), ky = Math.floor(p0[1] / CW), kz = Math.floor(p0[2] / CW);
      for (var ddx = -1; ddx <= 1; ddx++) for (var ddy = -1; ddy <= 1; ddy++) for (var ddz = -1; ddz <= 1; ddz++) {
        var lst = cellOf.get((kx + ddx) + ',' + (ky + ddy) + ',' + (kz + ddz));
        if (lst) lst.forEach(function (wj) { var q1 = V[wj]; if (Math.hypot(q1[0] - p0[0], q1[1] - p0[1], q1[2] - p0[2]) < CW) badZ.push(p0[2]); });
      }
      var key0 = kx + ',' + ky + ',' + kz; if (!cellOf.has(key0)) cellOf.set(key0, []); cellOf.get(key0).push(vi);
    }
    var keepOff = Math.max(0.3, 0.2 * P), farFromBad = function (c) { for (var q = 0; q < badZ.length; q++) if (Math.abs(badZ[q] - c) < keepOff) return false; return true; };
    var aBase = turns > 0 ? f1 - mg : f0 + mg, a = null;
    // lengthening copies a slab of the thread: take it from the longest stretch clear of those flaws (more, shorter slabs, the flaw not copied)
    if (turns > 0 && badZ.length) {
      var cuts = [f0 + mg].concat(badZ.filter(function (z) { return z > f0 && z < f1; }).sort(function (x, y) { return x - y; }), [f1 - mg]);
      var bestLo = null, bestHi = null;
      for (var ci = 0; ci + 1 < cuts.length; ci++) {
        var wlo = cuts[ci] + (ci ? keepOff : 0), whi = cuts[ci + 1] - (ci + 1 < cuts.length - 1 ? keepOff : 0);
        if (whi - wlo > (bestHi === null ? -Infinity : bestHi - bestLo)) { bestLo = wlo; bestHi = whi; }
      }
      var cleanTurns = bestHi !== null ? Math.floor((bestHi - bestLo) / P - 0.1) : 0;
      if (cleanTurns >= 1) { chunk = Math.min(chunk, cleanTurns); aBase = bestHi; }
    }
    // a plane is clear when no vertex is within 2e-4 of it and every edge it cuts (each triangle's two crossing points) is longer than
    // 5e-4: the app welds at 1e-4, and two crossing points a shallow edge apart would be welded into one
    var planeOk = function (c) {
      for (var t = 0; t < M.T.length; t++) {
        var tr = M.T[t], A = V[tr[0]], B = V[tr[1]], C = V[tr[2]], dA = A[2] - c, dB = B[2] - c, dC = C[2] - c;
        if (Math.abs(dA) < 2e-4 || Math.abs(dB) < 2e-4 || Math.abs(dC) < 2e-4) return false;
        if ((dA > 0) === (dB > 0) && (dB > 0) === (dC > 0)) continue;
        var pts = [], E = [[A, B, dA, dB], [B, C, dB, dC], [C, A, dC, dA]];
        for (var e = 0; e < 3; e++) if ((E[e][2] > 0) !== (E[e][3] > 0)) { var f = E[e][2] / (E[e][2] - E[e][3]), P1 = E[e][0], P2 = E[e][1]; pts.push([P1[0] + f * (P2[0] - P1[0]), P1[1] + f * (P2[1] - P1[1])]); }
        if (pts.length === 2 && Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]) < 5e-4) return false;
      }
      return true;
    };
    var vertexClear = function (c) { for (var v = 0; v < V.length; v++) if (Math.abs(V[v][2] - c) < 2e-4) return false; return true; };
    for (var pass = 0; pass < 3 && a === null; pass++) {                         // first a plane that cuts nothing short; failing that (a mesh
      for (var tries = 0; tries < 120 && a === null; tries++) {                 // with slivers thinner than that), one clear of the vertices
        var cand = aBase + (turns > 0 ? -1 : 1) * tries * 0.0137 * P, ps = planesFor(cand), clear = true;
        if (turns > 0 ? cand - chunk * P < f0 + mg - 1e-9 : cand + (-turns) * P > f1 - mg + 1e-9) break;   // every cut still inside the full-depth zone
        for (var q = 0; q < ps.length && clear; q++) if (!(pass ? vertexClear(ps[q]) : planeOk(ps[q])) || (pass < 2 && !farFromBad(ps[q]))) clear = false;
        if (clear) a = cand;
      }
    }
    if (a === null) { res.reason = 'internal: no clear plane to cut the thread at'; return res; }
    var tol = Math.min(0.02, 0.01 * P), flaws = badZ.length;                                          // points of the two cuts closer than this are one point
    var pieces = [], seamZ = null;
    var c1 = cut(V, M.T, a);
    if (!c1) { res.reason = 'the thread\'s section is not one closed outline going once round the axis (a hollow or a split screw is not read) - nothing changed'; return res; }
    if (turns > 0) {
      // the slabs: [a - c P, a], cut off the head side; each kind (a whole chunk, and the last, shorter one) zipped to the seam at a
      var lower = c1.below, upper = c1.above, kinds = {}, k, done = 0, plan = [];
      while (done < turns) { var c = Math.min(chunk, turns - done); plan.push(c); done += c; }
      plan.forEach(function (cc) {
        if (kinds[cc]) return;
        var cs = cut(V, lower.slice(), a - cc * P);
        if (!cs) { kinds[cc] = null; return; }
        // the slab's own copy of its bottom loop (moved by the zip, so the head side's mesh below the slab keeps its own)
        var slabT = cs.above.map(function (t) { return t.slice(); }), copy = new Map();
        cs.loop.forEach(function (h) { var n = V.length; V.push(V[h].slice()); copy.set(h, n); });
        slabT.forEach(function (t) { for (var x = 0; x < 3; x++) if (copy.has(t[x])) t[x] = copy.get(t[x]); });
        kinds[cc] = { T: slabT, bottom: cs.loop.map(function (h) { return copy.get(h); }) };
      });
      for (k in kinds) if (!kinds[k]) { res.reason = 'the thread\'s section is not one closed outline going once round the axis - nothing changed'; return res; }
      // zip every slab kind's bottom to the seam at a; the seam's points then go into the head side's top, the tip side's bottom and the
      // slabs' tops (all the same loop c1.loop) as well
      var seam = c1.loop.slice(), bottoms = {};
      Object.keys(kinds).forEach(function (kk, idx) {
        var K = kinds[kk], z = zip(V, { loop: seam, T: [lower, upper].concat(Object.keys(kinds).map(function (q2) { return kinds[q2].T; })) }, { loop: K.bottom, T: [K.T], shift: -kk * P }, tol);
        seam = z.seamA; bottoms[kk] = z.seamB;
        // a later kind zips against the grown seam: the earlier kinds' bottoms must take the new points too
        Object.keys(bottoms).forEach(function (q2) {
          if (q2 === kk || bottoms[q2].length === seam.length) return;
          var z2 = zip(V, { loop: seam, T: [] }, { loop: bottoms[q2], T: [kinds[q2].T], shift: -q2 * P }, tol); bottoms[q2] = z2.seamB;
        });
      });
      seamZ = seam;
      // assemble: one global vertex table; seam j's points are created once, at a + (turns done) P, and every piece meeting it uses them
      var out = [], G = [], seamIdx = [], placed = 0;
      var gv = function (p) { G.push(p); return G.length - 1; };
      var seamAt = function (j, zOff) { if (!seamIdx[j]) seamIdx[j] = seam.map(function (h) { return gv([V[h][0], V[h][1], V[h][2] + zOff]); }); return seamIdx[j]; };
      // a piece's triangles into the table, moved zOff along the axis; its vertices on a seam are that seam's (seamIds: the seam at a's
      // vertex ids, in seam order; botLoop: the slab's own bottom loop, in the same order)
      var emit = function (T, zOff, topSeam, botSeam, botLoop) {
        var map = new Map();
        if (topSeam) seam.forEach(function (h, q3) { map.set(h, topSeam[q3]); });
        if (botSeam) botLoop.forEach(function (h, q3) { map.set(h, botSeam[q3]); });
        T.forEach(function (t) {
          out.push(t.map(function (h) { var g = map.get(h); if (g === undefined) { g = gv([V[h][0], V[h][1], V[h][2] + zOff]); map.set(h, g); } return g; }));
        });
      };
      emit(lower, 0, seamAt(0, 0), null, null);
      plan.forEach(function (cc, jj) {
        var K = kinds[cc];
        emit(K.T, (placed + cc) * P, seamAt(jj + 1, (placed + cc) * P), seamAt(jj, placed * P), bottoms[cc]);
        placed += cc;
      });
      emit(upper, placed * P, seamAt(plan.length, placed * P), null, null);     // the tip side's bottom is the seam at a, moved on
      pieces = { out: out, G: G };
    } else {
      // shorter: the head side to a, the tip side from a + k P, moved back k P and zipped to it
      var kk2 = -turns, c2 = cut(V, c1.above.slice(), a + kk2 * P);
      if (!c2) { res.reason = 'the thread\'s section is not one closed outline going once round the axis - nothing changed'; return res; }
      var lowerS = c1.below, tipT = c2.above;
      var z3 = zip(V, { loop: c1.loop, T: [lowerS] }, { loop: c2.loop, T: [tipT], shift: kk2 * P }, tol);
      var G2 = [], out2 = [], seamG = z3.seamA.map(function (h) { G2.push(V[h].slice()); return G2.length - 1; });
      var mapL = new Map(), mapT = new Map();
      z3.seamA.forEach(function (h, q4) { mapL.set(h, seamG[q4]); });
      z3.seamB.forEach(function (h, q4) { mapT.set(h, seamG[q4]); });
      var emit2 = function (T, zOff, map) {
        T.forEach(function (t) { out2.push(t.map(function (h) { var g = map.get(h); if (g === undefined) { G2.push([V[h][0], V[h][1], V[h][2] + zOff]); g = G2.length - 1; map.set(h, g); } return g; })); });
      };
      emit2(lowerS, 0, mapL); emit2(tipT, -kk2 * P, mapT);
      pieces = { out: out2, G: G2 };
      seamZ = z3.seamA;
    }
    var G3 = pieces.G, outT = pieces.out;
    var s = new Float32Array(outT.length * 9), qq = 0;
    outT.forEach(function (t) { for (var x = 0; x < 3; x++) { var p = G3[t[x]]; s[qq++] = p[0]; s[qq++] = p[1]; s[qq++] = p[2]; } });
    res.ok = true;
    res.soup = WF.from(s);
    var L = turns * P;
    res.info = { turns: turns, lengthMm: L, pitch: P, threadLengthMm: rd.threadLength + L, seamPoints: seamZ ? seamZ.length : 0, cutAt: a, inheritedClosePairs: flaws };
    res.reason = 'Thread ' + (turns > 0 ? 'lengthened' : 'shortened') + ' by ' + Math.abs(turns) + ' turn' + (Math.abs(turns) === 1 ? '' : 's') + ' (' + fmt(Math.abs(L), 2) + ' mm): now ' +
      fmt(rd.threadLength + L, 1) + ' mm of thread, pitch ' + fmt(P, 3) + ' mm and Ø' + fmt(rd.majorDia) + ' as they were - the ' + (turns > 0 ? 'tip moved out' : 'tip moved in') + ', the head where it was' +
      (flaws ? ' - note: the piece came with ' + flaws + ' pair' + (flaws === 1 ? '' : 's') + ' of points closer than the 0.1 µm weld (Check & Repair shows it); they are kept as they were' : '');
    return res;
  }

  var API = { DEFAULTS: DEFAULTS, read: read, extend: extend, symmetryAxis: symmetryAxis, _moments: moments, _eig3: eig3 };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_ThreadExtend = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
