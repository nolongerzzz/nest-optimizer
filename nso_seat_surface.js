/* ============================================================
   nso_seat_surface.js — seating a piece against a CURVED or IRREGULAR
   target at a controlled gap. Pure geometry: no THREE, no DOM, so it runs
   unchanged in the page (window.NSO_SeatSurface) and under Node.

   POSITIONING ONLY. This module answers "where does the second piece go",
   and nothing else. The SHAPE of the contact - a mating face cut to follow
   the curve, a compliant pad, a cup - is a separate layer and is deliberately
   not here; see docs/SEAT-SURFACE.md, "Deferred: contact geometry".

   WHY IT EXISTS (the audit, tools/nso_seat_curved_audit.js, measured
   through the real app)
   ---------------------------------------------------------------
   The shipped seat (NSO_seatFlushBitToHull, app-join.js) casts four rays
   from the corners of the bit's outer box face along one axis. A curved
   target falls away from any flat footprint, so those corners overhang it
   and the ray misses: a 20 mm bit over a 20 mm sphere, a bit 5 mm off the
   crown, the same bit over the organic blob and anything at all over the
   genus-1 groove all refuse outright with "corner N missed hull along punch
   axis". Where the rays DO land, gap mode reaches the skin-tips branch,
   which measures the right minimum - but reports a plain sphere to the user
   as a printed relief, and never orients the bit: it translates along the
   bit's own normal, so only a target whose local normal already matches the
   bit's mating face can be seated at all. There is no way to aim at a point.

   WHAT IS REUSED, AND NOT REWRITTEN
   ---------------------------------
   - NSO_Carve.probeTarget (nso_carve.js) already turns an arbitrary world
     point on an arbitrary surface into a local frame: an outward bisector, a
     sweep tangent, and the closest real surface point, with a dihedral merge
     that reads a tessellated dome as ONE smooth face instead of a field of
     edges. That is exactly the frame a seat needs, and it is the same frame
     a carve is placed in, so a seat and a carve at the same point agree.
   - NSO_Skin.supportExtreme (nso_skin.js) already measures the outermost
     point of a surface along a direction over a quad footprint, clipping
     every triangle to it. That is the measurement the validated skin-tips
     seat is built on, and it is orientation-agnostic - its frame comes from
     the footprint's own corners - so it serves a tilted mating face as it
     stands.
   - the gap sign convention is the one locked in tools/breakaway_coupons.py
     and shipped in Seat (support): NEGATIVE = an air gap of that size,
     POSITIVE = the piece penetrates by that much, 0 = touching. Nothing new
     is invented here.

   WHAT "THE GAP" MEANS HERE, EXACTLY
   ----------------------------------
   The gap is solved for on the REAL quantity, not inferred from a footprint:

     gap < 0   the TRUE MINIMUM DISTANCE between the two surfaces is |gap|
     gap = 0   the pieces are at FIRST CONTACT - touching, not overlapping
     gap > 0   the piece sits `gap` mm past first contact

   The support rule (below) still does the placing; the solve then corrects
   the offset along the contact normal. It matters because a support
   measurement over a footprint quad is NOT the minimum distance between two
   solids whenever the contact is not that flat square, and it is wrong in
   both directions: a round bit's footprint quad over-reaches its own end
   face, and an irregular target rising outside the footprint comes closer to
   the piece's flank than to its mating face. Measured on the organic blob
   with the round rod, over sixteen aim points: up to 0.61 mm of real
   clearance for a requested 0.18, which is twelve times the whole
   easy-release window. The solve removes all of it, and it does so WITHOUT
   modelling the contact's shape - which is why the shape layer can stay
   deferred.

   Where the contact really is the footprint quad - a flat-faced bit on a
   flat or convex face, which is every case the shipped seat was validated on
   - first contact and the support plane are the same offset, so `gap` here
   means exactly what it means in Seat (support). The generalisation does not
   move the validated case; it only stops the shape-dependent rule being
   wrong where it was.

   FREE ORIENTATION HAS TO BE BAKED, NOT POSED
   -------------------------------------------
   Measured in the audit: a rotation written to mesh.quaternion is visible in
   the scene and ABSENT from the export - buildCombinedGeometry rebuilds each
   piece's rotation from the quantised pose fields (90 deg yaw, 15 deg tilt)
   and never reads the mesh. So a seat that tilts through the quaternion,
   which is what the shipped tilt fit does, cannot be gated through the
   canonical checker at all. This module therefore hands its caller a
   rotation as DATA (a delta quaternion about a named pivot); app-seat-
   surface.js bakes it into the piece's own triangles and leaves the pose
   fields alone. That is the same contained-pose-state decision Local-Carve
   made for the blade, reached from the other side: a free orientation lives
   in the geometry, because the pose model cannot hold one.

   API
   ---
   NSO_SeatSurface.contactFrame(hullSoup, point, opts)
       -> { ok, kind, outward, tangent, point, radius, ... } | { ok:false, reason }

   NSO_SeatSurface.plan(hullSoup, bit, opts)
       hullSoup = the TARGET piece's world triangle soup (what the app's
                  meshToWorldSoup returns); never modified
       bit  = the piece being seated:
                soup   its WORLD triangle soup
                box    its LOCAL axis-aligned box, { min:[3], max:[3] }
                matrix its world matrix, 16 numbers in column-major order
                       (THREE's Matrix4.elements) - only used to place `box`
       opts = { point:[3], gap, normalRadius?, dihedralDeg?, roll?,
                center?, maxTiltDeg?, solve? }
       -> see RESULT below

   NSO_SeatSurface.minDistance(soupA, soupB)   exact, for the solve itself
   NSO_SeatSurface.transformSoup(soup, m)      column-major 4x4
   ============================================================ */
(function (root) {
  'use strict';

  var EPS = 1e-12;

  /* ---- plain 3-vectors ---- */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function unit(a) { var L = len(a); return L > 1e-15 ? mul(a, 1 / L) : null; }
  function finite3(p) {
    return !!p && p.length === 3 && isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]);
  }

  /* ---- column-major 4x4, THREE's Matrix4.elements order ---- */
  function xfPoint(m, p) {
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
            m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
  }
  function xfDir(m, p) {
    return [m[0] * p[0] + m[4] * p[1] + m[8] * p[2],
            m[1] * p[0] + m[5] * p[1] + m[9] * p[2],
            m[2] * p[0] + m[6] * p[1] + m[10] * p[2]];
  }
  function transformSoup(soup, m) {
    var out = new Float64Array(soup.length), i;
    for (i = 0; i < soup.length; i += 3) {
      out[i] = m[0] * soup[i] + m[4] * soup[i + 1] + m[8] * soup[i + 2] + m[12];
      out[i + 1] = m[1] * soup[i] + m[5] * soup[i + 1] + m[9] * soup[i + 2] + m[13];
      out[i + 2] = m[2] * soup[i] + m[6] * soup[i + 1] + m[10] * soup[i + 2] + m[14];
    }
    return out;
  }

  /* ---- quaternions as [x, y, z, w] ---- */
  /* shortest arc from unit a to unit b. The antiparallel case has no shortest
     arc, so the caller's `fallbackAxis` decides it rather than a library's
     arbitrary choice - at a seat that axis is the contact tangent, so a piece
     turned exactly back-to-front rolls about the surface, not about whatever
     axis happened to come out of a cross product with a world axis. */
  function quatFromTo(a, b, fallbackAxis) {
    var d = dot(a, b);
    if (d >= 1 - 1e-14) return [0, 0, 0, 1];
    if (d <= -1 + 1e-14) {
      var ax = unit(sub(fallbackAxis || [1, 0, 0], mul(a, dot(fallbackAxis || [1, 0, 0], a))));
      if (!ax) {
        var t = (Math.abs(a[0]) < 0.9) ? [1, 0, 0] : [0, 1, 0];
        ax = unit(sub(t, mul(a, dot(t, a))));
      }
      return [ax[0], ax[1], ax[2], 0];
    }
    var c = cross(a, b), s = Math.sqrt((1 + d) * 2);
    return [c[0] / s, c[1] / s, c[2] / s, s / 2];
  }
  function quatFromAxisAngle(ax, ang) {
    var h = ang / 2, s = Math.sin(h);
    return [ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(h)];
  }
  function quatMul(a, b) {                     /* a then b applied = b*a */
    return [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
    ];
  }
  function quatRotate(q, v) {
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var ix = w * v[0] + y * v[2] - z * v[1];
    var iy = w * v[1] + z * v[0] - x * v[2];
    var iz = w * v[2] + x * v[1] - y * v[0];
    var iw = -x * v[0] - y * v[1] - z * v[2];
    return [ix * w + iw * -x + iy * -z - iz * -y,
            iy * w + iw * -y + iz * -x - ix * -z,
            iz * w + iw * -z + ix * -y - iy * -x];
  }
  function quatAngleDeg(q) {
    return 2 * Math.acos(Math.min(1, Math.max(-1, Math.abs(q[3])))) * 180 / Math.PI;
  }
  /* the rigid world transform this plan applies, as a column-major 4x4 to
     LEFT-multiply onto the piece's current world matrix:
     p -> q*(p - pivot) + pivot + move */
  function deltaMatrix(q, pivot, move) {
    var ex = quatRotate(q, [1, 0, 0]), ey = quatRotate(q, [0, 1, 0]), ez = quatRotate(q, [0, 0, 1]);
    var t = add(sub(pivot, quatRotate(q, pivot)), move);
    return [ex[0], ex[1], ex[2], 0, ey[0], ey[1], ey[2], 0, ez[0], ez[1], ez[2], 0, t[0], t[1], t[2], 1];
  }

  /* ---- the two modules this one is built out of ---- */
  var _carve = null, _skin = null;
  function carveApi() {
    if (_carve) return _carve;
    if (root && root.NSO_Carve) { _carve = root.NSO_Carve; return _carve; }
    if (typeof require === 'function') { try { _carve = require('./nso_carve.js'); } catch (e) { _carve = null; } }
    return _carve;
  }
  function skinApi() {
    if (_skin) return _skin;
    if (root && root.NSO_Skin) { _skin = root.NSO_Skin; return _skin; }
    if (typeof require === 'function') { try { _skin = require('./nso_skin.js'); } catch (e) { _skin = null; } }
    return _skin;
  }

  /* ============================================================
     1. EXACT MINIMUM DISTANCE between two triangle soups

     Needed by the solve, so it lives in the module rather than in the check.
     tools/nso_soup_distance.js is a SECOND, independent implementation used
     by the gates, and tools/nso_seat_surface_test.js asserts the two agree
     on every fixture - the same discipline the self-intersection checker
     settled on, for the same reason.
     ============================================================ */

  function closestOnTri(p, a, b, c) {
    var ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    var d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a;
    var bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b;
    var vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, mul(ab, d1 / (d1 - d3)));
    var cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c;
    var vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, mul(ac, d2 / (d2 - d6)));
    var va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      return add(b, mul(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
    }
    var den = 1 / (va + vb + vc);
    return add(a, add(mul(ab, vb * den), mul(ac, vc * den)));
  }

  function segSeg2(p1, q1, p2, q2) {
    var d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
    var a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), s, t;
    if (a <= EPS && e <= EPS) return dot(r, r);
    if (a <= EPS) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
    else {
      var c = dot(d1, r);
      if (e <= EPS) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else {
        var b = dot(d1, d2), den = a * e - b * b;
        s = den !== 0 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
        else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
      }
    }
    var w = sub(add(p1, mul(d1, s)), add(p2, mul(d2, t)));
    return dot(w, w);
  }

  function segCrossesTri(p, q, a, b, c) {
    var dir = sub(q, p), e1 = sub(b, a), e2 = sub(c, a);
    var h = cross(dir, e2), det = dot(e1, h);
    if (Math.abs(det) < 1e-15) return false;
    var inv = 1 / det, s = sub(p, a), u = dot(s, h) * inv;
    if (u < -1e-12 || u > 1 + 1e-12) return false;
    var k = cross(s, e1), v = dot(dir, k) * inv;
    if (v < -1e-12 || u + v > 1 + 1e-12) return false;
    var tt = dot(e2, k) * inv;
    return tt >= -1e-12 && tt <= 1 + 1e-12;
  }

  function triTri2(A, B) {
    if (segCrossesTri(A[0], A[1], B[0], B[1], B[2]) || segCrossesTri(A[1], A[2], B[0], B[1], B[2]) ||
        segCrossesTri(A[2], A[0], B[0], B[1], B[2]) || segCrossesTri(B[0], B[1], A[0], A[1], A[2]) ||
        segCrossesTri(B[1], B[2], A[0], A[1], A[2]) || segCrossesTri(B[2], B[0], A[0], A[1], A[2])) return 0;
    var best = Infinity, i, j;
    var ea = [[A[0], A[1]], [A[1], A[2]], [A[2], A[0]]];
    var eb = [[B[0], B[1]], [B[1], B[2]], [B[2], B[0]]];
    for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) {
      var d = segSeg2(ea[i][0], ea[i][1], eb[j][0], eb[j][1]);
      if (d < best) best = d;
    }
    for (i = 0; i < 3; i++) {
      var qa = closestOnTri(A[i], B[0], B[1], B[2]);
      var da = sub(A[i], qa); if (dot(da, da) < best) best = dot(da, da);
      var qb = closestOnTri(B[i], A[0], A[1], A[2]);
      var db = sub(B[i], qb); if (dot(db, db) < best) best = dot(db, db);
    }
    return best;
  }

  function triAt(soup, t) {
    var o = t * 9;
    return [[soup[o], soup[o + 1], soup[o + 2]],
            [soup[o + 3], soup[o + 4], soup[o + 5]],
            [soup[o + 6], soup[o + 7], soup[o + 8]]];
  }
  function triBox(soup, t) {
    var o = t * 9, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], k, a, v;
    for (k = 0; k < 3; k++) for (a = 0; a < 3; a++) {
      v = soup[o + k * 3 + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
    return { lo: lo, hi: hi };
  }
  function boxGap2(x, y) {
    var s = 0, a, d;
    for (a = 0; a < 3; a++) { d = Math.max(0, Math.max(x.lo[a] - y.hi[a], y.lo[a] - x.hi[a])); s += d * d; }
    return s;
  }
  function soupBox(soup) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], i, a;
    for (i = 0; i < soup.length; i += 3) for (a = 0; a < 3; a++) {
      var v = soup[i + a];
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
    return { lo: lo, hi: hi };
  }

  function minDistance(soupA, soupB) {
    var nA = (soupA.length / 9) | 0, nB = (soupB.length / 9) | 0;
    if (!nA || !nB) return Infinity;
    var bA = [], bB = [], i, j;
    for (i = 0; i < nA; i++) bA.push(triBox(soupA, i));
    for (j = 0; j < nB; j++) bB.push(triBox(soupB, j));
    var all = soupBox(soupA);
    var order = [];
    for (j = 0; j < nB; j++) order.push(j);
    order.sort(function (p, q) { return boxGap2(bB[p], all) - boxGap2(bB[q], all); });
    var best = Infinity;
    for (var oj = 0; oj < nB; oj++) {
      j = order[oj];
      if (boxGap2(bB[j], all) > best) continue;
      var TB = triAt(soupB, j);
      for (i = 0; i < nA; i++) {
        if (boxGap2(bA[i], bB[j]) > best) continue;
        var d = triTri2(triAt(soupA, i), TB);
        if (d < best) best = d;
        if (best === 0) return 0;
      }
    }
    return Math.sqrt(best);
  }

  /* Every triangle of `soup` whose box is within `reach` of `box`. The solve
     runs this once and then bisects against a handful of triangles instead of
     the whole hull - a seat is a click, and the organic blob is 5,120
     triangles. Safe because the solve never moves the piece further than
     `reach` from where the prefilter was taken; plan() sizes it that way and
     reports `culledReach` so a check can confirm it. */
  function cullNear(soup, box, reach) {
    var n = (soup.length / 9) | 0, keep = [], i;
    var grown = { lo: [box.lo[0] - reach, box.lo[1] - reach, box.lo[2] - reach],
                  hi: [box.hi[0] + reach, box.hi[1] + reach, box.hi[2] + reach] };
    for (i = 0; i < n; i++) if (boxGap2(triBox(soup, i), grown) === 0) keep.push(i);
    var out = new Float64Array(keep.length * 9);
    for (i = 0; i < keep.length; i++) for (var a = 0; a < 9; a++) out[i * 9 + a] = soup[keep[i] * 9 + a];
    return out;
  }

  /* ============================================================
     2. THE CONTACT FRAME at an arbitrary point

     Straight through to NSO_Carve.probeTarget: one frame builder, so a seat
     and a carve aimed at the same point on the same surface agree by
     construction rather than by two similar-looking implementations.

     `radius` is how much surface the ORIENTATION is read from, and it is
     deliberately NOT the footprint: a flat face seated on a dome touches
     near one point, and averaging the normal over the whole footprint would
     tilt the piece to the chord of the curve instead of its tangent. The
     gap is measured over the whole footprint (below); the orientation is
     read locally, here.
     ============================================================ */

  /* a quarter of the piece's smallest extent, never below half a millimetre:
     small enough to read the tangent rather than the chord, big enough to
     span the facets of a tessellated curve rather than land on one of them. */
  var NORMAL_RADIUS_FRACTION = 0.25;
  var NORMAL_RADIUS_FLOOR = 0.5;

  /* probeTarget IDENTIFIES the feature - one smooth face, a real edge, a real
     corner - and that is what it is for. Its outward direction is not a
     tangent-accurate normal, and on a smooth surface it cannot be: it buckets
     triangles whose normals are within 5 degrees of each other and keeps the
     FIRST one's normal as the bucket's, weighted by the bucket's total area,
     so on a finely tessellated dome the answer depends on triangle order.
     Measured on a 240 x 480 sphere of radius 10: up to 2.5 degrees off the
     analytic normal, and no finer a mesh improves it.

     A carve does not care - a blade is aimed, not seated. A seat does: 2.5
     degrees across a 12 mm footprint is a quarter of a millimetre at the far
     edge, which is five times the whole easy-release window.

     So the feature comes from probeTarget and the NORMAL is then measured
     here, over the same neighbourhood: the true area-weighted mean of the
     triangle normals whose closest point to the aim is within the radius and
     which belong to the feature probeTarget picked (within the dihedral
     threshold of its direction). For a smooth surface that neighbourhood is
     symmetric about the tangent point, so the mean IS the tangent normal -
     0.03 degrees on the same sphere. At a real edge or corner the bisector is
     the feature, not a surface normal, so it is left exactly as probeTarget
     built it. */
  function refineNormal(hullSoup, point, radius, outward, cosDihedral) {
    var n = (hullSoup.length / 9) | 0, sum = [0, 0, 0], kept = 0, i;
    var r2 = radius * radius;
    for (i = 0; i < n; i++) {
      var o = i * 9;
      var a = [hullSoup[o], hullSoup[o + 1], hullSoup[o + 2]];
      var b = [hullSoup[o + 3], hullSoup[o + 4], hullSoup[o + 5]];
      var c = [hullSoup[o + 6], hullSoup[o + 7], hullSoup[o + 8]];
      var k, bad = false;
      for (k = 0; k < 3; k++) {
        var lo = Math.min(a[k], Math.min(b[k], c[k])), hi = Math.max(a[k], Math.max(b[k], c[k]));
        if (point[k] < lo - radius || point[k] > hi + radius) { bad = true; break; }
      }
      if (bad) continue;
      var cp = closestOnTri(point, a, b, c);
      var dv = sub(point, cp);
      if (dot(dv, dv) > r2) continue;
      var raw = cross(sub(b, a), sub(c, a));
      var area2 = len(raw);
      if (area2 <= 1e-12) continue;
      var nn = mul(raw, 1 / area2);
      if (dot(nn, outward) < cosDihedral) continue;
      sum = add(sum, mul(nn, area2 / 2));
      kept++;
    }
    var out = unit(sum);
    return (out && kept) ? { normal: out, tris: kept } : null;
  }

  function contactFrame(hullSoup, point, opts) {
    opts = opts || {};
    var C = carveApi();
    if (!C || !C.probeTarget) return { ok: false, reason: 'nso_carve.js is not loaded - no frame builder' };
    if (!finite3(point)) return { ok: false, reason: 'the target point must be three finite numbers' };
    var radius = Number(opts.radius);
    if (!(radius > 0)) return { ok: false, reason: 'the probe radius must be positive' };
    var probe = C.probeTarget(hullSoup, point, radius, { dihedralDeg: opts.dihedralDeg });
    if (!probe.ok) return { ok: false, reason: probe.reason };
    var outward = probe.outward.slice(), tangent = probe.tangent.slice(), refined = 0;
    if (probe.kind === 'face') {
      var dd = Number(opts.dihedralDeg);
      if (!(isFinite(dd) && dd > 0 && dd < 180)) dd = 20;
      var rf = refineNormal(hullSoup, probe.point, radius, outward, Math.cos(dd * Math.PI / 180));
      if (rf) {
        outward = rf.normal;
        refined = rf.tris;
        /* keep the tangent in the plane of the measured normal */
        var t = unit(sub(tangent, mul(outward, dot(tangent, outward))));
        if (t) tangent = t;
      }
    }
    return {
      ok: true,
      kind: probe.kind,
      point: probe.point.slice(),
      outward: outward,
      tangent: tangent,
      radius: radius,
      refinedFrom: refined,
      probeOutward: probe.outward.slice(),
      facesUsed: probe.facesUsed,
      facesFound: probe.facesFound,
      planesFound: probe.planesFound,
      offSurface: probe.offSurface
    };
  }

  /* ============================================================
     3. THE MATING FACE of the piece being seated

     The same convention the shipped seat uses (NSO_plugFrame /
     NSO_matingFaceCorners): a face of the piece's own local axis-aligned box.
     Which one is picked here comes from the TARGET, not from the hull's
     centroid: the box face already looking most nearly at the contact, so
     the rotation that follows is the smallest one that does the job. For a
     box there are six candidates covering the sphere, so that rotation is
     never more than 54.74 degrees whatever the piece's pose.

     The footprint IS that box face, which is exact for a flat-faced bit and
     generous for a round one. Cutting it down to the piece's real contact
     outline is the deferred shape layer; the clearance solve below means a
     generous footprint costs nothing in the gap that comes out.
     ============================================================ */
  function matingFace(bit, outward) {
    var box = bit.box, m = bit.matrix;
    var lo = box.min, hi = box.max, best = null, a, s;
    for (a = 0; a < 3; a++) {
      for (s = -1; s <= 1; s += 2) {
        var e = [0, 0, 0]; e[a] = s;
        var nw = unit(xfDir(m, e));
        if (!nw) continue;
        var score = dot(nw, mul(outward, -1));
        if (!best || score > best.score + 1e-12) best = { axis: a, sign: s, normal: nw, score: score };
      }
    }
    if (!best) return null;
    /* `best.sign` is the local direction that points AT the target, so the
       mating face is the box face at that end of its axis, and the outer
       face (`opp` below) is the opposite one. */
    var a2 = best.axis, u = (a2 + 1) % 3, v = (a2 + 2) % 3;
    var coord = (best.sign > 0) ? hi[a2] : lo[a2];
    var quad = [[lo[u], lo[v]], [hi[u], lo[v]], [hi[u], hi[v]], [lo[u], hi[v]]];
    var corners = [], i;
    for (i = 0; i < 4; i++) {
      var p = [0, 0, 0];
      p[a2] = coord; p[u] = quad[i][0]; p[v] = quad[i][1];
      corners.push(xfPoint(m, p));
    }
    var opp = [0, 0, 0];
    opp[a2] = (best.sign > 0) ? lo[a2] : hi[a2];
    opp[u] = (quad[0][0] + quad[2][0]) / 2; opp[v] = (quad[0][1] + quad[2][1]) / 2;
    var centre = mul(add(add(corners[0], corners[1]), add(corners[2], corners[3])), 0.25);
    return {
      axis: a2, sign: best.sign, normal: best.normal, corners: corners, centre: centre,
      outerCentre: xfPoint(m, opp),
      W: len(sub(corners[1], corners[0])),
      D: len(sub(corners[3], corners[0])),
      depth: Math.abs(hi[a2] - lo[a2]) * len(xfDir(m, (function () { var e = [0, 0, 0]; e[a2] = 1; return e; })()))
    };
  }

  /* ============================================================
     4. THE PLAN
     ============================================================ */

  /* How far past the support solution the clearance solve may travel. An air
     gap this feature can express is sub-millimetre; a bracket of a
     millimetre plus eight times the gap is far past anything a correction
     for footprint shape can need, and it bounds the prefilter above. */
  function solveReach(gapAbs) { return 1 + 8 * gapAbs; }

  function plan(hullSoup, bit, opts) {
    opts = opts || {};
    if (!hullSoup || !hullSoup.length || hullSoup.length % 9) {
      return { ok: false, reason: 'no target geometry to seat against' };
    }
    if (!bit || !bit.soup || !bit.soup.length || bit.soup.length % 9) {
      return { ok: false, reason: 'the piece being seated has no geometry' };
    }
    if (!bit.box || !finite3(bit.box.min) || !finite3(bit.box.max)) {
      return { ok: false, reason: 'the piece being seated has no local box' };
    }
    if (!bit.matrix || bit.matrix.length !== 16) {
      return { ok: false, reason: 'the piece being seated has no world matrix' };
    }
    var gap = Number(opts.gap);
    if (!isFinite(gap)) return { ok: false, reason: 'gap must be a finite number of mm' };
    var S = skinApi();
    if (!S || !S.supportExtreme) return { ok: false, reason: 'nso_skin.js is not loaded - no support measurement' };

    var ext3 = [bit.box.max[0] - bit.box.min[0], bit.box.max[1] - bit.box.min[1], bit.box.max[2] - bit.box.min[2]];
    var minExt = Math.min(ext3[0], Math.min(ext3[1], ext3[2]));
    var radius = Number(opts.normalRadius);
    if (!(radius > 0)) radius = Math.max(NORMAL_RADIUS_FLOOR, NORMAL_RADIUS_FRACTION * minExt);

    var frame = contactFrame(hullSoup, opts.point, { radius: radius, dihedralDeg: opts.dihedralDeg });
    if (!frame.ok) return { ok: false, reason: frame.reason };

    var outward = frame.outward, tangent = frame.tangent;
    var face = matingFace(bit, outward);
    if (!face) return { ok: false, reason: 'the piece being seated has no usable box face' };

    /* ---- the rotation: the smallest one that puts the mating face flat on
       the tangent plane, plus an optional roll about the contact normal ---- */
    var q = quatFromTo(face.normal, mul(outward, -1), tangent);
    var rollDeg = Number(opts.roll);
    if (isFinite(rollDeg) && rollDeg !== 0) {
      q = quatMul(q, quatFromAxisAngle(outward, rollDeg * Math.PI / 180));
    }
    var rotationDeg = quatAngleDeg(q);
    var maxTilt = Number(opts.maxTiltDeg);
    if (isFinite(maxTilt) && rotationDeg > maxTilt + 1e-9) {
      return {
        ok: false, kind: frame.kind, rotationDeg: rotationDeg,
        reason: 'seating there needs the piece turned ' + rotationDeg.toFixed(1) +
          ' degrees, past the ' + maxTilt + ' allowed'
      };
    }

    /* ---- rotate about the mating face centre, then put that centre on the
       target point (unless the caller keeps the piece where it is) ---- */
    var pivot = face.centre;
    var centre = (opts.center === false) ? false : true;
    var shift = centre ? sub(frame.point, pivot) : [0, 0, 0];

    function placeMatrix(t) { return deltaMatrix(q, pivot, add(shift, mul(outward, t))); }

    var base = transformSoup(bit.soup, placeMatrix(0));
    var faceAt0 = face.corners.map(function (c) { return add(add(quatRotate(q, sub(c, pivot)), pivot), shift); });
    var outerAt0 = add(add(quatRotate(q, sub(face.outerCentre, pivot)), pivot), shift);
    var faceS0 = dot(faceAt0[0], outward);
    var off = -gap;                                     /* outside the skin */

    /* ---- the support measurement, over the mating footprint ----
       sMax cuts out target material that ends up beyond the piece's far side
       entirely - the same thing the shipped tips probe does with the bit's
       outer face. It depends on where the piece lands, and where it lands
       depends on the measurement, so it is iterated; two passes is already
       exact on every fixture and the loop reports how many it took. */
    var fp = faceAt0.map(function (c) { return c.slice(); });
    var ext = null, t = 0, passes = 0, sMax = Infinity;
    for (passes = 1; passes <= 4; passes++) {
      ext = S.supportExtreme(hullSoup, fp, outward, { sMax: sMax });
      if (!ext) {
        return { ok: false, kind: frame.kind,
          reason: 'nothing of the target lies under the mating face at that point - aim inside the piece' };
      }
      var tNew = (ext.s + off) - faceS0;
      var sOuterNew = dot(outerAt0, outward) + tNew;
      var sMaxNew = Math.max(sOuterNew, ext.s + Math.abs(off) + 1e-6);
      if (passes > 1 && Math.abs(tNew - t) < 1e-9 && Math.abs(sMaxNew - sMax) < 1e-9) { t = tNew; break; }
      t = tNew; sMax = sMaxNew;
    }
    var tSupport = t;

    /* ---- the solve ----
       The support rule above places the mating FACE against the target's
       outermost point over the footprint quad. That is the validated rule and
       it is exact when the contact really is that quad - a flat-faced bit on a
       flat or convex face. It is not exact otherwise, and both ways: a round
       bit's quad over-reaches its own end face, and an irregular target rises
       outside the quad and comes closer to the piece's flank. Measured on
       fixtures/fixture_blob_organic.stl with the round fixtures/pin.stl, over
       sixteen aim points: up to 0.61 mm of real clearance for a requested
       0.18, which is twelve times the whole easy-release window.

       So the offset is SOLVED on the real quantity instead. One bisection,
       on the true minimum distance between the two surfaces as a function of
       how far along the contact normal the piece sits:

         gap < 0   solve for minimum distance = |gap|      (the air gap)
         gap = 0   solve for minimum distance = 0          (first contact)
         gap > 0   solve for first contact, then `gap` further in

       The last line is the generalisation that keeps the shipped convention
       intact rather than replacing it: where the contact IS the footprint
       quad, first contact and the support plane are the same offset, so
       "gap mm inside first contact" is exactly "gap mm inside the outermost
       point under the mating face", which is what Seat (support) has always
       meant. Where they differ, only the shape-dependent rule was ever wrong.

       The bisection is sound because the piece is rigid and moves along one
       axis: sliding it away from the target cannot reduce its distance to any
       triangle of the target that is on the approach side, and the prefilter
       keeps only those. It reports its own iteration count and the reach it
       was allowed, so a check can see the bracket rather than trust it. */
    var solve = 'support', iterations = 0, reach = 0, near = null, contactOffset = null;
    var gapAbs = Math.abs(gap);
    if (opts.solve !== 'support') {
      reach = solveReach(gapAbs);
      near = cullNear(hullSoup, soupBox(transformSoup(bit.soup, placeMatrix(tSupport))), reach + gapAbs);
      if (!near.length) {
        return { ok: false, kind: frame.kind,
          reason: 'no target surface within ' + (reach + gapAbs).toFixed(2) + ' mm of the seated piece' };
      }
      var dist = function (tt) { iterations++; return minDistance(near, transformSoup(bit.soup, placeMatrix(tt))); };

      /* dist(t) = want, for want > 0. Strictly increasing where it matters,
         so an ordinary bisection once the bracket is found. */
      var solveGap = function (want) {
        var lo = tSupport, hi = tSupport, flo = dist(lo) - want, fhi = flo, step;
        if (flo === 0) return tSupport;
        if (flo < 0) {
          step = Math.max(want, 1e-3);
          while (fhi < 0 && hi < tSupport + reach) {
            hi = Math.min(tSupport + reach, hi + step);
            fhi = dist(hi) - want; step *= 2;
          }
          if (fhi < 0) return null;
        } else {
          step = Math.max(want, 1e-3);
          while (flo > 0 && lo > tSupport - reach) {
            lo = Math.max(tSupport - reach, lo - step);
            flo = dist(lo) - want; step *= 2;
          }
          if (flo > 0) return null;
          hi = tSupport;
        }
        for (var it = 0; it < 80 && (hi - lo) > 1e-10; it++) {
          var mid = (lo + hi) / 2, fm = dist(mid) - want;
          if (fm < 0) lo = mid; else hi = mid;
          if (Math.abs(fm) < 1e-9) return mid;
        }
        return (lo + hi) / 2;
      };

      /* FIRST CONTACT is a different solve, and it has to be, because
         dist(t) = 0 over a whole interval: every offset that penetrates
         measures zero. So it is bracketed rather than inverted - the largest
         offset that still touches - with the invariant dist(lo) = 0 and
         dist(hi) > 0 held all the way down. Inverting it as if it were
         monotone-invertible is how a "touching" seat ends up 0.14 mm clear
         and a "0.05 overlap" ends up 0.10 mm deep. */
      var solveContact = function () {
        var lo = tSupport, hi = tSupport, step = Math.max(gapAbs, 1e-3);
        if (dist(tSupport) === 0) {
          var dHi = 0;
          while (dHi === 0 && hi < tSupport + reach) {
            hi = Math.min(tSupport + reach, hi + step);
            dHi = dist(hi); step *= 2;
          }
          if (dHi === 0) return null;
        } else {
          var dLo = 1;
          while (dLo > 0 && lo > tSupport - reach) {
            lo = Math.max(tSupport - reach, lo - step);
            dLo = dist(lo); step *= 2;
          }
          if (dLo > 0) return null;
          hi = tSupport;
        }
        for (var it = 0; it < 80 && (hi - lo) > 1e-10; it++) {
          var mid = (lo + hi) / 2;
          if (dist(mid) === 0) lo = mid; else hi = mid;
        }
        return lo;
      };

      var tSolved = (gap < 0) ? solveGap(gapAbs) : solveContact();
      if (tSolved === null) {
        return { ok: false, kind: frame.kind,
          reason: (gap < 0 ? 'could not open the gap to ' + gapAbs.toFixed(3) + ' mm' : 'could not find first contact') +
            ' within ' + reach.toFixed(2) + ' mm of the surface - the piece is wedged against the target' };
      }
      contactOffset = (gap < 0) ? null : tSolved;
      /* a penetration is measured from first contact, inward */
      t = (gap > 0) ? (tSolved - gap) : tSolved;
      solve = 'clearance';
    }

    /* ---- what actually came out, measured on the placed geometry ---- */
    var placed = transformSoup(bit.soup, placeMatrix(t));
    var measureAgainst = near || cullNear(hullSoup, soupBox(placed), Math.max(2, 8 * Math.abs(gap) + 1));
    var clearance = measureAgainst.length ? minDistance(measureAgainst, placed) : Infinity;
    var faceSFinal = faceS0 + t;

    return {
      ok: true,
      kind: frame.kind,
      contact: {
        point: frame.point, outward: outward, tangent: tangent, radius: radius,
        facesUsed: frame.facesUsed, planesFound: frame.planesFound, offSurface: frame.offSurface
      },
      mating: {
        axis: face.axis, sign: face.sign, normal: face.normal.slice(),
        W: face.W, D: face.D, depth: face.depth,
        corners: faceAt0.map(function (c, i) { return add(c, mul(outward, t)); })
      },
      quat: q, pivot: pivot.slice(), move: add(shift, mul(outward, t)),
      matrix: placeMatrix(t),
      rotationDeg: rotationDeg,
      centred: centre,
      support: { s: ext.s, point: ext.point.slice(), passes: passes, inside: ext.inside },
      gap: gap,
      /* the support convention's own number, the one Seat (support) reports */
      gapAchieved: -(faceSFinal - ext.s),
      /* the true minimum surface-to-surface distance, which for an air gap
         IS the gap that was asked for */
      clearance: clearance,
      offsetAlongNormal: t,
      supportOffset: tSupport,
      contactOffset: contactOffset,
      solve: solve, iterations: iterations, culledReach: reach,
      culledTris: (measureAgainst.length / 9) | 0
    };
  }

  var api = {
    NORMAL_RADIUS_FRACTION: NORMAL_RADIUS_FRACTION,
    NORMAL_RADIUS_FLOOR: NORMAL_RADIUS_FLOOR,
    contactFrame: contactFrame,
    refineNormal: refineNormal,
    matingFace: matingFace,
    plan: plan,
    minDistance: minDistance,
    transformSoup: transformSoup,
    deltaMatrix: deltaMatrix,
    quatFromTo: quatFromTo,
    cullNear: cullNear
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SeatSurface = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
