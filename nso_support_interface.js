/* ============================================================
   nso_support_interface.js - where a support MEETS the piece: an air gap and
   a breakaway interface, instead of a tip driven into the overhang.

   Loads as a classic script (window.NSO_SupportInterface) and as a Node
   module. No DOM, no THREE. Soups are the app's raw convention: 9 floats per
   triangle, Z up, millimetres. The booleans are the app's own
   (NSO_unionSoups / NSO_subtractSoups, app-join.js), passed in or found by
   name - nothing here reimplements them.

   ---------------------------------------------------------------------------
   WHAT WAS WRONG, MEASURED
   ---------------------------------------------------------------------------
   Every support this repo aimed so far ended ON the overhang: the aim lands
   its tip on the contact point, by design (nso_support_aim.js). On the tape
   piece every tip - the strut and all five of the region-1 tree - stops at
   plate z 18.042, which is inside 0.2 mm layer 91 (18.0 - 18.2), with no
   air between support and piece. Bambu Studio reported exactly that: the
   tree and the piece overlapping at layer 91. And none of those supports had
   an interface at all - bulk structure all the way up.

   ---------------------------------------------------------------------------
   WHAT THIS BUILDS, AT EVERY TIP
   ---------------------------------------------------------------------------
        piece  ---------------------------------   underside, z_u
               air gap: GAP_MM (0.18), the true minimum distance
        layer 2  |  |  |  |    lines one way           \  NSO_Crosshatch:
        layer 1  ---------     lines across layer 2    /  one direction per layer
        bulk     (the trunk or branch, CUT flat at the interface's underside)

   THE GAP is the repo's own easy-release figure: the Seat (support) slider's
   -0.18, "an air gap of that size" (nso_seat_surface.js, docs/SEAT-SURFACE.md;
   the convention locked in tools/breakaway_coupons.py). It is measured the
   way the seat solve measures it: as the TRUE MINIMUM DISTANCE between the
   two surfaces, not a vertical offset - and it is measured over the whole
   support, not only at the tips, because a flank that grazes the piece is the
   same conflict as a tip that touches it. At 0.2 mm layers a 0.18 mm gap is
   one empty slicer layer between interface and piece - what Bambu's own
   support_top_z_distance of 0.2 gives.

   THE INTERFACE is nso_crosshatch.js, unchanged: two layers, each ONE
   direction of 0.42 mm lines at a 1.2 mm pitch, the second across the first -
   the construction that module exists for, because a layer that runs both
   ways welds to the one above it instead of crossing it (its header carries
   the measurement). Layer height = the print's layer height, so each
   interface layer is exactly one slicer layer. The patch is sized to the tip
   it sits on: REPEATS lines each way, so every layer-1 line crosses the cut
   tip and is carried by it - a line that misses the tip would be printed in
   mid-air. It is centred where the support's own axis crosses the
   interface's underside, not on the contact point, so a leaning branch
   carries its patch squarely.

   THE BULK is cut flat at the interface's underside - a box removed above
   that plane over the patch's footprint - so the tip's own flat cap, which
   stands proud of a level cut on any leaning branch, cannot reach into the
   gap. On a bored tree the cut opens the bore upward; the interface lines
   bridge it, which is what a real tree support's interface does over its
   tube.

   JOINING. Layer 2 is lowered EPS_MM into layer 1 and layer 1 set EPS_MM into
   the cut, so each join is an overlap the kernel can merge rather than two
   faces meeting on a plane of zero thickness - the same reason
   nso_support_tree.js sinks a branch root into its trunk. 2 microns, far
   below anything printed.

   ---------------------------------------------------------------------------
   THE LADDER, per tip, when the patch comes too close to the piece
   ---------------------------------------------------------------------------
   A patch is tested on its own before it is joined: if any of it is nearer
   the piece than the gap (a wall beside the contact, a step in the
   underside), it drops to 1 repeat each way - a cross, still carried by the
   tip - and if that is too close too, the tip gets NO interface: its bulk is
   cut at the gap line instead and the tip is named in `stations`. The gap is
   never given up to fit an interface.

   API
   ---------------------------------------------------------------------------
   DEFAULTS
   finish(bulkSoup, stations, piece, opts) -> Promise {
       ok, soup, stations:[...], minDistanceMm, reason }
     stations: [{ label, contact:[x,y,z], from:[x,y,z], to:[x,y,z] }]
       contact  where the support was aimed, ON the underside
       from/to  the support's own axis near its tip (for the patch centre)
     opts: gapMm, layerMm, widthMm, pitchMm, repeats, unionSoups,
           subtractSoups, crosshatch, thickness
   minDistance(soupA, soupB, opts) -> { mm, at }  sampled true minimum distance
   exactDistance(soupA, soupB, { reach }) -> { mm, at }  every triangle pair, closed form
   sheet(piece, stations, opts) -> the region-wide sheet a tree's tips carry:
       2 transition + 2 interface layers at 0.84 mm (THE SHEET, below;
       docs/SUPPORT-INTERFACE.md). nso_support_gridpack.js parts() builds it
       with opts.interface.
   cutPath(pts, cutZ, side) -> a column (top first) cut flat at cutZ
   ============================================================ */
(function (root) {
  'use strict';

  var GAP_MM = 0.18;          /* Seat (support) -0.18: the easy-release air gap */
  var LAYER_MM = 0.2;         /* one interface layer = one slicer layer */
  var PITCH_MM = 1.2;         /* nso_crosshatch.js's shipped pitch */
  var REPEATS = 2;            /* lines each way; 2 x 1.2 mm pitch crosses a 2 mm tip twice */
  var EPS_MM = 0.002;         /* the joining overlap - see JOINING */

  function mod(opts, key, name) {
    return (opts && opts[key]) || (root && root[name]) ||
           (typeof globalThis !== 'undefined' && globalThis[name]) || null;
  }

  /* ---------------------------------------------------------- distance */

  /* True minimum distance between two closed soups, sampled densely where it
     matters. Both are piecewise planar, so the minimum sits at a vertex of one
     against a face of the other, or edge against edge. So: every vertex of each
     against the other, then every edge and face of A that came within reach,
     resampled at `step`. The answer is an upper bound on the truth that closes
     on it as `step` shrinks; the step is reported. */
  function minDistance(TH, A, B, opts) {
    opts = opts || {};
    var step = opts.step || 0.05, reach = opts.reach || 1.0;
    var PB = opts.preparedB || TH.prepare(B, {}), PA = TH.prepare(A, {});
    var best = { mm: Infinity, at: null };
    function probe(P, p) {
      var nr = P.nearest(p, best.mm < Infinity ? Math.min(best.mm, reach) + 1e-9 : reach);
      if (nr && nr.dist < best.mm) best = { mm: nr.dist, at: p.slice() };
      return nr ? nr.dist : Infinity;
    }
    var near = [];
    for (var f = 0; f < PA.tris.length; f++) {
      var T = PA.tris[f], d = Infinity;
      for (var k = 0; k < 3; k++) d = Math.min(d, probe(PB, T[k]));
      var c = [(T[0][0] + T[1][0] + T[2][0]) / 3, (T[0][1] + T[1][1] + T[2][1]) / 3, (T[0][2] + T[1][2] + T[2][2]) / 3];
      d = Math.min(d, probe(PB, c));
      if (d < reach) near.push(f);
    }
    /* B's vertices against A: the vertex-of-B-on-face-of-A case. Only B's
       vertices inside A's box grown by `reach` can matter. */
    var lo = PA.lo, hi = PA.hi;
    for (var g = 0; g < PB.tris.length; g++) {
      for (var j = 0; j < 3; j++) {
        var v = PB.tris[g][j];
        if (v[0] < lo[0] - reach || v[0] > hi[0] + reach || v[1] < lo[1] - reach || v[1] > hi[1] + reach ||
            v[2] < lo[2] - reach || v[2] > hi[2] + reach) continue;
        probe(PA, v);
      }
    }
    /* THE FACES OF A THAT CAME CLOSE, subdivided with a bound rather than
       gridded: a triangle whose centroid is d from B and whose points are all
       within R of that centroid cannot come nearer than d - R, so it is split
       only while d - R could still beat the best found, down to `step`. A
       support's side faces run the length of a trunk; a flat grid at `step`
       over one of those is tens of thousands of probes for the same answer.
       A triangle is split in TWO across its longest edge: a sheet's line is
       a sliver 0.42 mm wide and tens of millimetres long, and quartering it
       makes 4^k slivers where halving the long edge makes 2^k pieces - the
       same bound, the same step, minutes become seconds. */
    function refine(P0, P1, P2, depth) {
      var c = [(P0[0] + P1[0] + P2[0]) / 3, (P0[1] + P1[1] + P2[1]) / 3, (P0[2] + P1[2] + P2[2]) / 3];
      var R = Math.max(dist(c, P0), dist(c, P1), dist(c, P2));
      var d = probe(PB, c);
      var bound = Math.min(best.mm, reach);
      if (d - R > bound || R < step / 2 || depth > 48) return;
      var e01 = dist(P0, P1), e12 = dist(P1, P2), e20 = dist(P2, P0);
      if (e01 >= e12 && e01 >= e20) { var m = mid(P0, P1); refine(P0, m, P2, depth + 1); refine(m, P1, P2, depth + 1); }
      else if (e12 >= e20) { var m2 = mid(P1, P2); refine(P1, m2, P0, depth + 1); refine(m2, P2, P0, depth + 1); }
      else { var m3 = mid(P2, P0); refine(P2, m3, P1, depth + 1); refine(m3, P0, P1, depth + 1); }
    }
    for (var n = 0; n < near.length; n++) {
      var U = PA.tris[near[n]];
      refine(U[0], U[1], U[2], 0);
    }
    best.step = step;
    return best;
  }
  function dist(p, q) { return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); }

  /* EXACT minimum distance between two soups, every triangle pair within
     reach in closed form (a vertex of one against the other, Ericson's
     closest point, or an edge against an edge) - the method
     tools/nso_tri_distance.js cross-checks the sampler with, with candidates
     from a grid of B's triangle boxes. It does not detect interpenetration;
     the sheet's footprint is built clear of the inside of the piece. A
     result past reach is Infinity. Used by sheet(): a flat top parallel to a
     ceiling at exactly the gap is the sampler's worst case (no bound prunes
     it) and this one's best (two big triangles). */
  function exactDistance(A, B, reach, beat) {
    var cell = Math.max(1, reach * 4), grid = new Map(), BT = [];
    function key(i, j, k) { return i + ',' + j + ',' + k; }
    function triAt(S, o) { return [[S[o], S[o + 1], S[o + 2]], [S[o + 3], S[o + 4], S[o + 5]], [S[o + 6], S[o + 7], S[o + 8]]]; }
    function boxOf(T) {
      return { lo: [Math.min(T[0][0], T[1][0], T[2][0]), Math.min(T[0][1], T[1][1], T[2][1]), Math.min(T[0][2], T[1][2], T[2][2])],
               hi: [Math.max(T[0][0], T[1][0], T[2][0]), Math.max(T[0][1], T[1][1], T[2][1]), Math.max(T[0][2], T[1][2], T[2][2])] };
    }
    for (var o = 0; o < B.length; o += 9) {
      var T = triAt(B, o), bx = boxOf(T), id = BT.length;
      BT.push({ T: T, lo: bx.lo, hi: bx.hi, mark: -1 });
      var n0 = Math.floor(bx.lo[0] / cell), n1 = Math.floor(bx.hi[0] / cell), m0 = Math.floor(bx.lo[1] / cell), m1 = Math.floor(bx.hi[1] / cell);
      var k0 = Math.floor(bx.lo[2] / cell), k1 = Math.floor(bx.hi[2] / cell);
      if ((n1 - n0 + 1) * (m1 - m0 + 1) * (k1 - k0 + 1) > 4096) { (grid.get('big') || grid.set('big', []).get('big')).push(id); continue; }
      for (var i = n0; i <= n1; i++) for (var j = m0; j <= m1; j++) for (var k = k0; k <= k1; k++) {
        var kk = key(i, j, k); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push(id);
      }
    }
    var big = grid.get('big') || [], best = { mm: Infinity, at: null, topZ: null, pairs: 0 };
    for (var a = 0, ai = 0; a < A.length; a += 9, ai++) {
      if (beat && (ai & 1023) === 0) beat();
      var TA = triAt(A, a), ba = boxOf(TA), lim = Math.min(best.mm, reach);
      var cands = big.slice();
      for (var i2 = Math.floor((ba.lo[0] - lim) / cell); i2 <= Math.floor((ba.hi[0] + lim) / cell); i2++)
        for (var j2 = Math.floor((ba.lo[1] - lim) / cell); j2 <= Math.floor((ba.hi[1] + lim) / cell); j2++)
          for (var k2 = Math.floor((ba.lo[2] - lim) / cell); k2 <= Math.floor((ba.hi[2] + lim) / cell); k2++) {
            var L = grid.get(key(i2, j2, k2)); if (L) cands = cands.concat(L);
          }
      for (var c = 0; c < cands.length; c++) {
        var b = BT[cands[c]];
        if (b.mark === ai) continue;
        b.mark = ai;
        var g = Math.hypot(Math.max(0, ba.lo[0] - b.hi[0], b.lo[0] - ba.hi[0]), Math.max(0, ba.lo[1] - b.hi[1], b.lo[1] - ba.hi[1]),
                           Math.max(0, ba.lo[2] - b.hi[2], b.lo[2] - ba.hi[2]));
        if (g > Math.min(best.mm, reach)) continue;
        best.pairs++;
        var d = triTri(TA, b.T);
        if (d < best.mm) {
          best.mm = d;
          best.at = [(TA[0][0] + TA[1][0] + TA[2][0]) / 3, (TA[0][1] + TA[1][1] + TA[2][1]) / 3, (TA[0][2] + TA[1][2] + TA[2][2]) / 3];
          best.topZ = ba.hi[2]; best.lowZ = ba.lo[2];
        }
      }
    }
    if (best.mm > reach) best.mm = Infinity;
    return best;
  }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function ptTri(p, a, b, c) {
    var ab = sub3(b, a), ac = sub3(c, a), ap = sub3(p, a), d1 = dot3(ab, ap), d2 = dot3(ac, ap);
    if (d1 <= 0 && d2 <= 0) return dist(p, a);
    var bp = sub3(p, b), d3 = dot3(ab, bp), d4 = dot3(ac, bp);
    if (d3 >= 0 && d4 <= d3) return dist(p, b);
    var vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { var v = d1 / (d1 - d3); return dist(p, [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]); }
    var cp = sub3(p, c), d5 = dot3(ab, cp), d6 = dot3(ac, cp);
    if (d6 >= 0 && d5 <= d6) return dist(p, c);
    var vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { var w = d2 / (d2 - d6); return dist(p, [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]); }
    var va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      var w2 = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      return dist(p, [b[0] + (c[0] - b[0]) * w2, b[1] + (c[1] - b[1]) * w2, b[2] + (c[2] - b[2]) * w2]);
    }
    var den = 1 / (va + vb + vc), v2 = vb * den, w3 = vc * den;
    return dist(p, [a[0] + ab[0] * v2 + ac[0] * w3, a[1] + ab[1] * v2 + ac[1] * w3, a[2] + ab[2] * v2 + ac[2] * w3]);
  }
  function segSeg(p1, q1, p2, q2) {
    var d1 = sub3(q1, p1), d2 = sub3(q2, p2), r = sub3(p1, p2), a = dot3(d1, d1), e = dot3(d2, d2), f = dot3(d2, r), s, t;
    if (a <= 1e-18 && e <= 1e-18) return dist(p1, p2);
    if (a <= 1e-18) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
    else {
      var c = dot3(d1, r);
      if (e <= 1e-18) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else {
        var b = dot3(d1, d2), den = a * e - b * b;
        s = den !== 0 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
        else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
      }
    }
    return dist([p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s], [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t]);
  }
  function triTri(A, B) {
    var d = Infinity;
    for (var i = 0; i < 3; i++) d = Math.min(d, ptTri(A[i], B[0], B[1], B[2]), ptTri(B[i], A[0], A[1], A[2]));
    for (var i2 = 0; i2 < 3; i2++) for (var j = 0; j < 3; j++) d = Math.min(d, segSeg(A[i2], A[(i2 + 1) % 3], B[j], B[(j + 1) % 3]));
    return d;
  }
  function mid(p, q) { return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]; }

  /* ----------------------------------------------------------- geometry */

  function box(lo, hi) {
    var v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
    var f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    var out = new Float32Array(f.length * 9), w = 0;
    for (var i = 0; i < f.length; i++) for (var k = 0; k < 3; k++) {
      var p = v[f[i][k]]; out[w++] = p[0]; out[w++] = p[1]; out[w++] = p[2];
    }
    return out;
  }

  /* Where the support's axis crosses the plane z. */
  function axisAt(from, to, z) {
    var dz = to[2] - from[2];
    if (Math.abs(dz) < 1e-12) return [to[0], to[1]];
    var t = (z - from[2]) / dz;
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
  }

  /* One two-layer crosshatch patch, centred on (cx, cy), underside at zBase. */
  function patch(CH, cx, cy, zBase, o, repeats) {
    var span = CH.spanFor(repeats, o.pitch, o.width);
    var b = CH.build({ W: span, D: span, pitch: o.pitch, width: o.width, height: o.layer,
                       angle: o.angle, ends: 'turn', baseZ: zBase, fit: 'nearest' });
    if (!b.ok) return { ok: false, reason: b.reason };
    var l1 = b.layers[0].tris, l2 = b.layers[1].tris;
    var dx = cx - b.spanU / 2, dy = cy - b.spanV / 2;
    var out = new Float32Array(l1.length + l2.length);
    for (var i = 0; i < l1.length; i += 3) { out[i] = l1[i] + dx; out[i + 1] = l1[i + 1] + dy; out[i + 2] = l1[i + 2]; }
    for (var j = 0; j < l2.length; j += 3) {
      var w = l1.length + j;
      out[w] = l2[j] + dx; out[w + 1] = l2[j + 1] + dy; out[w + 2] = l2[j + 2] - o.eps;   /* into layer 1 */
    }
    return {
      ok: true, soup: out, layer1: l1.length / 9, layerSoups: [out.subarray(0, l1.length), out.subarray(l1.length)],
      span: b.spanU, repeats: repeats,
      census: [b.layers[0].census, b.layers[1].census],
      lineDirections: [b.layers[0].lineDirection, b.layers[1].lineDirection],
      crossings: b.crossings, contactPerCrossing: b.contactPerCrossing
    };
  }

  function finish(bulk, stations, piece, opts) {
    opts = opts || {};
    var TH = mod(opts, 'thickness', 'NSO_Thickness');
    var CH = mod(opts, 'crosshatch', 'NSO_Crosshatch');
    var U = mod(opts, 'unionSoups', 'NSO_unionSoups');
    var S = mod(opts, 'subtractSoups', 'NSO_subtractSoups');
    if (!TH || !CH || typeof U !== 'function' || typeof S !== 'function') {
      return Promise.resolve({ ok: false, reason: 'needs nso_thickness.js, nso_crosshatch.js and app-join.js ' +
        '(NSO_unionSoups, NSO_subtractSoups) - none of them is reimplemented here' });
    }
    var o = {
      gap: opts.gapMm == null ? GAP_MM : +opts.gapMm,
      layer: opts.layerMm == null ? LAYER_MM : +opts.layerMm,
      width: opts.widthMm == null ? TH.floorFor(opts.nozzle) : +opts.widthMm,
      pitch: opts.pitchMm == null ? PITCH_MM : +opts.pitchMm,
      repeats: opts.repeats == null ? REPEATS : (opts.repeats | 0),
      angle: opts.angle == null ? 0 : +opts.angle,
      eps: EPS_MM
    };
    if (!(o.gap > 0)) return Promise.resolve({ ok: false, reason: 'the gap must be a positive air gap, got ' + o.gap });

    /* ---- plan every station, and test each patch against the piece ---- */
    var PP = TH.prepare(piece, {});
    var plans = stations.map(function (st) {
      /* THE UNDERSIDE over the whole patch, not only at the contact: the
         lowest point of the piece straight above the footprint, by vertical
         rays - so an underside that slopes a little over the patch sets the
         height, not the one point the aim landed on. Only within ONE LAYER of
         the contact: anything lower is a lip or a wall beside the tip, and
         dropping the whole stack under it would leave the contact itself
         unsupported, the gap there grown to whatever the lip's depth is. That
         is the ladder's job, below. */
      var zu = st.contact[2], half0 = CH.spanFor(o.repeats, o.pitch, o.width) / 2 + 0.2;
      for (var gx = -half0; gx <= half0 + 1e-9; gx += half0 / 4) {
        for (var gy = -half0; gy <= half0 + 1e-9; gy += half0 / 4) {
          var hs = PP.hitsAlong([st.contact[0] + gx, st.contact[1] + gy, st.contact[2] - 1], [0, 0, 1], 2);
          if (hs.length) { var zz = st.contact[2] - 1 + hs[0]; if (zz < zu && zz > st.contact[2] - o.layer) zu = zz; }
        }
      }
      var zTop = zu - o.gap, zBase = zTop - 2 * o.layer;
      var c = axisAt(st.from, st.to, zBase);
      var rec = { label: st.label, contact: st.contact.slice(), zUnderside: zu, zTop: zTop, zBase: zBase,
                  centre: c, repeats: 0, interface: false, tried: [] };
      for (var r = o.repeats; r >= 1; r--) {
        var pt = patch(CH, c[0], c[1], zBase, o, r);
        if (!pt.ok) { rec.tried.push({ repeats: r, why: pt.reason }); continue; }
        var d = minDistance(TH, pt.soup, piece, { reach: o.gap * 4 });
        /* THE GAP IS SOLVED, not set: an underside that is not quite level
           over the patch brings its top nearer than the vertical offset, so
           the stack is lowered by the shortfall until the TRUE distance is
           the gap - the seat solve's rule. Only a shortfall straight above
           is solved this way; a wall beside the patch is the ladder's job. */
        for (var sv = 0; sv < 4 && d.mm < o.gap - 1e-5 && d.mm > o.gap * 0.5 && d.at[2] >= zTop - 2 * o.eps - 1e-3; sv++) {
          var drop = o.gap - d.mm + 1e-4;
          zTop -= drop; zBase -= drop; rec.zTop = zTop; rec.zBase = zBase; rec.solvedDropMm = (rec.solvedDropMm || 0) + drop;
          c = axisAt(st.from, st.to, zBase); rec.centre = c;
          pt = patch(CH, c[0], c[1], zBase, o, r);
          d = minDistance(TH, pt.soup, piece, { reach: o.gap * 4 });
        }
        if (d.mm >= o.gap - 1e-5) {
          rec.interface = true; rec.repeats = r; rec.span = pt.span; rec.patch = pt; rec.patchDistanceMm = d.mm;
          break;
        }
        rec.tried.push({ repeats: r, why: 'a ' + pt.span.toFixed(3) + ' mm patch comes ' + d.mm.toFixed(4) +
          ' mm from the piece at [' + d.at.map(function (v) { return v.toFixed(3); }).join(', ') + '], under the ' +
          o.gap + ' mm gap' });
      }
      /* The cut: at the interface's underside where there is one, at the gap
         line where there is not. Over the patch's footprint plus the tip's own
         lean - see THE BULK. */
      /* Sized to the FULL patch whatever patch was chosen: the box has to take
         the whole tip off, and a 1x1 patch's footprint (0.81 mm half-width) is
         narrower than a 2 mm tip - measured, a ring of the tip left standing
         0.05 mm off a lip beside it. */
      var half = CH.spanFor(o.repeats, o.pitch, o.width) / 2 + 0.2;
      rec.cutZ = rec.interface ? zBase + o.eps : zTop;
      rec.cutBox = box([c[0] - half, c[1] - half, rec.cutZ], [c[0] + half, c[1] + half, zu + 50]);
      return rec;
    });

    /* ---- cut, then join, then measure ---- */
    var acc = bulk;
    var chain = Promise.resolve();
    plans.forEach(function (rec) {
      chain = chain.then(function () {
        return S(acc, rec.cutBox).then(function (d) {
          rec.cutOk = !!(d && d.ok); rec.cutRemovedMm3 = d && d.removedMm3;
          if (d && d.ok) acc = d.soup;
          else rec.cutWhy = (d && d.reason) || 'no reason';
        });
      });
    });
    plans.forEach(function (rec) {
      if (!rec.interface) return;
      chain = chain.then(function () {
        /* The two layers are joined to EACH OTHER first. Handed over as one
           soup of two overlapping shells, the kernel takes the overlap as
           given - measured: 48 piercing pairs on one 2x2 patch - so the
           patch is made one solid before it meets the bulk. */
        return U(rec.patch.layerSoups[0], rec.patch.layerSoups[1]).then(function (pu) {
          if (!pu || !pu.ok) { rec.joined = false; rec.joinWhy = 'the two layers would not join: ' + ((pu && pu.reason) || ''); return null; }
          return U(acc, pu.soup);
        }).then(function (u) {
          if (u === null) return;
          rec.joined = !!(u && u.ok);
          if (u && u.ok) acc = u.soup;
          else rec.joinWhy = (u && u.reason) || 'no reason';
        });
      });
    });
    return chain.then(function () {
      var bad = plans.filter(function (r) { return !r.cutOk || (r.interface && !r.joined); });
      var d = minDistance(TH, acc, piece, { reach: o.gap * 4 });
      var ok = !bad.length;
      var withIf = plans.filter(function (r) { return r.interface; }).length;
      var ok = ok && d.mm >= o.gap - 1e-5;
      return {
        ok: ok, soup: acc, stations: plans, minDistanceMm: d.mm, minDistanceAt: d.at, sampleStepMm: d.step,
        gapMm: o.gap, layerMm: o.layer, widthMm: o.width, pitchMm: o.pitch,
        reason: (ok ? '' : 'NOT OK - ') + withIf + ' of ' + plans.length + ' tip(s) carry a two-layer crosshatch interface' +
          (withIf < plans.length ? ' (' + plans.filter(function (r) { return !r.interface; })
            .map(function (r) { return r.label; }).join(', ') + ' cut at the gap instead)' : '') +
          '; closest approach to the piece ' + d.mm.toFixed(4) + ' mm (gap ' + o.gap + ')' +
          (bad.length ? '; failed: ' + bad.map(function (r) { return r.label + ' ' + (r.cutWhy || r.joinWhy); }).join('; ') : '')
      };
    });
  }

  /* ===================================================================
     THE SHEET - what a tree's tips carry, region-wide (docs/SUPPORT-INTERFACE.md)
     ===================================================================
     finish() above puts one 2 x 2 patch on each tip. Under a ceiling the
     patches are islands 3.29 mm apart and the part's first layer still bridges
     between them. Bambu's tree (the clamp_body reference, 0.2 mm layers,
     interface spacing 0.5) builds a SHEET instead, bottom to top:
        T1, T2   two TRANSITION layers, 0.84 mm pitch, the first one bridging
                 tip to tip
        I1, I2   two INTERFACE layers, 0.84 mm pitch, one direction per layer
        gap      0.18 mm of air (one empty slicer layer at 0.2 mm), then the part
     This builds that sheet over every group of tips that holds one ceiling.

     ONE DIRECTION PER LAYER, EACH ACROSS THE ONE BELOW: T1 at theta, T2 at
     theta + 90, I1 at theta, I2 at theta + 90. Each layer is checked with
     NSO_Crosshatch.oneDirection, the crosshatch's own guard, and extruded with
     NSO_RasterLines.extrudeFlat, the crosshatch's own line section.

     OPEN LINES, NOT A BOUSTROPHEDON. nso_crosshatch.js refuses end turns at a
     0.84 mm pitch with a 0.42 mm line (clearance 0, measured: a turn there
     welds along the layer above). Its reason is about TURNS: open lines at
     0.84 are allowed. A run ends where the ceiling ends (or a wall, or another
     support's column), not at a rectangle's edge, so turns would not join
     neighbours anyway. finish() keeps its 1.2 mm boustrophedon patches - the
     pitch at which its turns clear.

     THE LEVEL. A tip's sheet top is GAP_MM under the lowest point of the
     ceiling over the tip's cell (vertical rays; a point more than one layer
     below the tip is a lip or a wall, not the ceiling, and is left to the
     footprint below). Tips whose tops agree within LEVEL_TOL_MM are one level:
     one sheet. The stack is four layers of layerMm, each set EPS_MM into the
     one below (finish()'s joining overlap), T1 EPS_MM into the cut tips.

     THE FOOTPRINT. Each sample along a line belongs to the nearest sheet tip
     (within CELL_PITCHES of the tips' own spacing). It is kept only where the
     COLUMN of the stack, [base - gap, top + gap), meets nothing of the piece
     within gap + half a line (a raster of vertical rays, flooded from the tips
     so the inside of a wall is never mistaken for air, then dilated), and no
     other support's column passes through the stack there. A run that would
     meet a sheet of another level stops LEVEL_EDGE_MM short of it.

     NOTHING FLOATS. A T1 run is kept only if it crosses a cut tip; T2 only if
     it crosses a kept T1 run; and so on up. A tip that no T1 run crosses is
     cut at the gap line instead ('gap', finish()'s last rung) and the sheet
     is rebuilt round its column.

     T1's ANGLE is chosen, and reported. The planner's tips stand on the
     beacon grid's square lattice; a T1 line parallel to the lattice and
     between two columns of it crosses no tip at all and would be printed in
     air from end to end. The reference's tips are irregular, so its axis-
     aligned lines meet them. Here theta is the candidate that drops the least
     T1 line, then leaves the least of it hung from turns alone, then the axes
     (each compared in bands, so a near tie goes to the axes).

     THE GAP IS MEASURED, not trusted: each level's stack is measured with
     exactDistance against the piece (minDistance's sampler cannot prune a
     flat top lying exactly the gap under a ceiling: every sample is a
     candidate) and lowered (a sloped ceiling) or cleared round the offending
     point (a wall) until the true minimum is the gap.

     IN THE CARD'S WORKER. sheet() runs inside NSO_SupportGridpack.parts(),
     which the Supports card runs in its build worker; opts.beat() is called
     through the long loops so the worker's progress never goes quiet.

     sheet(piece, stations, opts) -> plan (plain data, plus .probe, a function
       for the caller's own clearance checks - drop it before posting the plan)
       stations: [{ label, beacon, contact, side, col }] - col indexes
                 opts.columns: [{ pts (top first), side }], every support
                 member's polyline, so the sheet keeps out of the ones it does
                 not carry
       opts: gapMm, layerMm, widthMm | nozzle, pitchMm, sideMm, plateZ,
             footMm, occluders, angleDeg (forces T1's), thickness, crosshatch,
             rasterLines
     =================================================================== */
  var SHEET_PITCH_MM = 0.84;   /* the reference's interface and transition pitch (0.42 line + 0.42 channel) */
  var SHEET_ROLES = ['transition', 'transition', 'interface', 'interface'];
  var CELL_MM = 0.1;           /* the footprint raster */
  var SAMPLE_MM = 0.05;        /* along a line */
  var LEVEL_TOL_MM = 0.01;
  var CELL_PITCHES = 0.6;      /* a sample belongs to a tip within this many tip spacings (Chebyshev) */
  var MIN_RUN_MM = 0.84;       /* a run shorter than one pitch is not kept */
  var LEVEL_EDGE_MM = 0.25;    /* runs of two levels stop this far apart */
  var COLUMN_CLEAR_MM = 0.2;   /* the sheet keeps this far off another support's column */
  var TURN_SKEW_MM = 1.0;      /* a T1 turn joins two runs whose ends are at most this much more than a pitch apart */
  var ROOM_MM = 0.5;           /* a cut tip keeps this much of itself above the foot */
  var T1_ANGLES = [0, 90, 26.565051177077994, 116.56505117707799, 63.43494882292201, 153.43494882292202, 45, 135];

  function sheet(piece, stations, opts) {
    opts = opts || {};
    var TH = mod(opts, 'thickness', 'NSO_Thickness');
    var CH = mod(opts, 'crosshatch', 'NSO_Crosshatch');
    var RL = mod(opts, 'rasterLines', 'NSO_RasterLines');
    if (!TH || !CH || !RL) return { ok: false, reason: 'the sheet needs nso_thickness.js, nso_crosshatch.js and nso_raster_lines.js' };
    var o = {
      gap: opts.gapMm == null ? GAP_MM : +opts.gapMm,
      layer: opts.layerMm == null ? LAYER_MM : +opts.layerMm,
      width: opts.widthMm == null ? TH.floorFor(opts.nozzle) : +opts.widthMm,
      pitch: opts.pitchMm == null ? SHEET_PITCH_MM : +opts.pitchMm,
      side: opts.sideMm == null ? 1.2 : +opts.sideMm,
      plateZ: opts.plateZ == null ? 0 : +opts.plateZ,
      foot: opts.footMm == null ? 0 : +opts.footMm,
      eps: EPS_MM
    };
    if (!(o.pitch > o.width)) return { ok: false, reason: 'pitch ' + o.pitch + ' does not clear the ' + o.width + ' mm line' };
    var columns = opts.columns || [];
    var obstacles = [piece].concat(opts.occluders || []).filter(function (s) { return s && s.length >= 9; });
    var PPs = obstacles.map(function (s) { return prepared(TH, s); });
    var NL = SHEET_ROLES.length, stackH = NL * o.layer - (NL - 1) * o.eps;

    /* opts.beat(): called through the long loops, so a caller that reports
       progress (the card's build worker) is never silent for long */
    var beat = typeof opts.beat === 'function' ? opts.beat : function () {};
    function hitIn(x, y, z0, z1) {
      for (var i = 0; i < PPs.length; i++) if (PPs[i].hitsAlong([x, y, z0], [0, 0, 1], z1 - z0).length) return true;
      return false;
    }
    function firstHit(x, y, z0, len) {
      var best = Infinity;
      for (var i = 0; i < PPs.length; i++) {
        var hs = PPs[i].hitsAlong([x, y, z0], [0, 0, 1], len);
        if (hs.length && hs[0] < best) best = hs[0];
      }
      return best;
    }
    function inside(p) { for (var i = 0; i < PPs.length; i++) if (PPs[i].inside(p)) return true; return false; }
    function nearestMm(p, r) {
      var best = Infinity;
      for (var i = 0; i < PPs.length; i++) { var nr = PPs[i].nearest(p, r); if (nr && nr.dist < best) best = nr.dist; }
      return best;
    }

    var tips = stations.map(function (st, i) {
      return { i: i, label: st.label, beacon: st.beacon, contact: st.contact.slice(), col: st.col,
               mode: st.side ? 'side' : 'sheet', level: -1 };
    });
    var cand = tips.filter(function (t) { return t.mode === 'sheet'; });

    /* the tips' own spacing: the median nearest neighbour */
    var nn = cand.map(function (t) {
      var b = Infinity;
      cand.forEach(function (u) { if (u !== t) b = Math.min(b, Math.hypot(u.contact[0] - t.contact[0], u.contact[1] - t.contact[1])); });
      return b;
    }).filter(isFinite).sort(function (a, b) { return a - b; });
    var spacing = nn.length ? nn[nn.length >> 1] : 3;
    var H = Math.max(o.side, CELL_PITCHES * spacing);

    /* ---- each sheet tip's level: the lowest ceiling over its cell ---- */
    cand.forEach(function (t) {
      beat();
      var c = t.contact, zu = c[2], n = 4;
      for (var gx = -n; gx <= n; gx++) for (var gy = -n; gy <= n; gy++) {
        var x = c[0] + gx * H / n, y = c[1] + gy * H / n, z0 = c[2] - o.layer - 0.01;
        if (inside([x, y, z0])) continue;                 /* the inside of a wall */
        var h = firstHit(x, y, z0, o.layer + 0.02);
        if (isFinite(h) && z0 + h < zu) zu = z0 + h;
      }
      t.zu = zu; t.zTop = zu - o.gap; t.zBase = t.zTop - stackH;
      var col = columns[t.col];
      /* ROOM: the cut must leave a tip under the stack, above its foot. */
      if (!(t.zBase - o.side - ROOM_MM > o.plateZ + o.foot) || !col) { t.mode = 'gap'; t.why = 'no room for the stack above the plate'; }
    });

    var tipOfCol = {};
    tips.forEach(function (t) { tipOfCol[t.col] = t; });

    /* ---- levels ---- */
    var levels = [];
    cand.filter(function (t) { return t.mode === 'sheet'; }).sort(function (a, b) { return a.zTop - b.zTop; }).forEach(function (t) {
      var L = levels[levels.length - 1];
      if (!L || t.zTop - L.first > LEVEL_TOL_MM) { L = { id: levels.length, first: t.zTop, tips: [] }; levels.push(L); }
      L.tips.push(t); t.level = L.id;
    });

    /* where a column's axis crosses z (the column's own polyline, top first) */
    function colAt(col, z) {
      if (col.pts.length < 2) return [col.pts[0][0], col.pts[0][1]];
      var p = col.pts;
      if (z >= p[0][2]) return [p[0][0], p[0][1]];
      for (var k = 0; k + 1 < p.length; k++) {
        var a = p[k], b = p[k + 1];
        if (z <= a[2] + 1e-12 && z >= b[2] - 1e-12) {
          var dz = a[2] - b[2], f = dz > 1e-12 ? (a[2] - z) / dz : 0;
          return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
        }
      }
      var e = p[p.length - 1]; return [e[0], e[1]];
    }

    /* every sheet tip (all levels), bucketed for the nearest-tip lookup */
    var bucket = new Map();
    function bkey(i, j) { return i + ',' + j; }
    function rebucket() {
      bucket.clear();
      tips.forEach(function (t) {
        if (t.mode !== 'sheet') return;
        var k = bkey(Math.floor(t.contact[0] / H), Math.floor(t.contact[1] / H));
        if (!bucket.has(k)) bucket.set(k, []);
        bucket.get(k).push(t);
      });
    }
    function owner(x, y) {
      var bi = Math.floor(x / H), bj = Math.floor(y / H), best = null, bd = Infinity;
      for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) {
        var L = bucket.get(bkey(bi + di, bj + dj));
        if (!L) continue;
        for (var k = 0; k < L.length; k++) {
          var t = L[k], dx = x - t.contact[0], dy = y - t.contact[1];
          if (Math.abs(dx) > H || Math.abs(dy) > H) continue;
          var d = dx * dx + dy * dy;
          if (d < bd || (d === bd && t.i < best.i)) { bd = d; best = t; }
        }
      }
      return best;
    }

    /* ---- one level's stack ---- */
    function buildLevel(L, angleForced) {
      var live = L.tips.filter(function (t) { return t.mode === 'sheet'; });
      /* a sheet spans from tip to tip: one tip alone carries a patch, not a sheet */
      if (live.length < 2) return { ok: false, reason: 'a sheet needs two tips at one level; this one has ' + live.length };
      var zTop = L.zTop, zBase = zTop - stackH;
      /* where each tip's top stands once cut: its column at one side under the cut */
      live.forEach(function (t) { var cp = cutPath(columns[t.col].pts, zBase + o.eps, o.side); t.top = [cp[0][0], cp[0][1]]; });
      var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      live.forEach(function (t) {
        for (var k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], t.contact[k] - H); hi[k] = Math.max(hi[k], t.contact[k] + H); }
      });
      /* the reach of a line's edge off its centreline: half a width, and at a
         turn's mitred corner half a width times root 2 */
      var r = o.gap + o.width / 2 * Math.SQRT2 + CELL_MM * Math.SQRT1_2 + 1e-3;
      var pad = r + 2 * CELL_MM;
      var ox = lo[0] - pad, oy = lo[1] - pad;
      var nx = Math.ceil((hi[0] - lo[0] + 2 * pad) / CELL_MM) + 1, ny = Math.ceil((hi[1] - lo[1] + 2 * pad) / CELL_MM) + 1;
      var z0 = zBase - o.gap, z1 = zTop + o.gap - 1e-4;
      /* 1: the piece is in the column. A vertical ray sees every face the
         column crosses except a vertical one, which it runs parallel to: a
         WALL. So the inside is read as well, on horizontal rays along each
         row at a few heights through the column (parity, from outside the
         piece's box): a column standing in a wall is in material. */
      var hit = new Uint8Array(nx * ny);
      for (var j = 0; j < ny; j++) for (var i = 0, b0 = beat(); i < nx; i++) {
        if (hitIn(ox + i * CELL_MM, oy + j * CELL_MM, z0, z1)) hit[j * nx + i] = 1;
      }
      var NH = Math.max(3, Math.ceil((z1 - z0) / (o.layer / 2)));
      for (var hk = 0; hk < NH; hk++) {
        var zh = z0 + (z1 - z0) * (hk + 0.5) / NH;
        for (var jr = 0; jr < ny; jr++, beat()) markInside(oy + jr * CELL_MM, zh, function (i0) { hit[jr * nx + i0] = 1; });
      }
      function markInside(y, z, mark) {
        PPs.forEach(function (P) {
          if (y < P.lo[1] || y > P.hi[1] || z < P.lo[2] || z > P.hi[2]) return;
          var x0 = P.lo[0] - 1, hs = P.hitsAlong([x0, y, z], [1, 0, 0], P.hi[0] - x0 + 1);
          for (var h = 0; h + 1 < hs.length; h += 2) {
            var xa = x0 + hs[h], xb = x0 + hs[h + 1];
            for (var ii = Math.max(0, Math.floor((xa - ox) / CELL_MM)); ii < nx && ox + ii * CELL_MM <= xb; ii++) {
              if (ox + ii * CELL_MM >= xa) mark(ii);
            }
          }
        });
      }
      var seen = new Uint8Array(nx * ny), stack = [];
      live.forEach(function (t) {
        var i = Math.round((t.contact[0] - ox) / CELL_MM), j = Math.round((t.contact[1] - oy) / CELL_MM);
        for (var dj = -3; dj <= 3; dj++) for (var di = -3; di <= 3; di++) {
          var q = (j + dj) * nx + (i + di);
          if (i + di >= 0 && i + di < nx && j + dj >= 0 && j + dj < ny && !hit[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
      });
      while (stack.length) {
        var q = stack.pop(), qi = q % nx, qj = (q - qi) / nx;
        var nb = [qi > 0 ? q - 1 : -1, qi < nx - 1 ? q + 1 : -1, qj > 0 ? q - nx : -1, qj < ny - 1 ? q + nx : -1];
        for (var b = 0; b < 4; b++) if (nb[b] >= 0 && !hit[nb[b]] && !seen[nb[b]]) { seen[nb[b]] = 1; stack.push(nb[b]); }
      }
      /* free = reached, and nothing blocked within r (a disc) */
      var R = Math.ceil(r / CELL_MM), disc = [];
      for (var dj = -R; dj <= R; dj++) for (var di = -R; di <= R; di++) if (Math.hypot(di, dj) * CELL_MM <= r) disc.push([di, dj]);
      var free = new Uint8Array(nx * ny);
      for (var q2 = 0; q2 < nx * ny; q2++) free[q2] = seen[q2];
      for (var q3 = 0; q3 < nx * ny; q3++) {
        if (seen[q3]) continue;
        var ci = q3 % nx, cj = (q3 - ci) / nx;
        for (var d = 0; d < disc.length; d++) {
          var ii = ci + disc[d][0], jj = cj + disc[d][1];
          if (ii >= 0 && ii < nx && jj >= 0 && jj < ny) free[jj * nx + ii] = 0;
        }
      }
      /* the columns this level does not carry: every other member through the stack */
      /* a tip of this level cut at the gap instead stands flush with the
         sheet's top: the sheet may meet it, so it is no obstacle either */
      var mine = {};
      L.tips.forEach(function (t) { mine[t.col] = true; });
      function blockSeg(a, b, rad) {
        var x0 = Math.min(a[0], b[0]) - rad, x1 = Math.max(a[0], b[0]) + rad, y0 = Math.min(a[1], b[1]) - rad, y1 = Math.max(a[1], b[1]) + rad;
        var i0 = Math.max(0, Math.floor((x0 - ox) / CELL_MM)), i1 = Math.min(nx - 1, Math.ceil((x1 - ox) / CELL_MM));
        var j0 = Math.max(0, Math.floor((y0 - oy) / CELL_MM)), j1 = Math.min(ny - 1, Math.ceil((y1 - oy) / CELL_MM));
        var ex = b[0] - a[0], ey = b[1] - a[1], ee = ex * ex + ey * ey;
        for (var jy = j0; jy <= j1; jy++) for (var ix = i0; ix <= i1; ix++) {
          var px = ox + ix * CELL_MM - a[0], py = oy + jy * CELL_MM - a[1];
          var f = ee > 1e-18 ? Math.max(0, Math.min(1, (px * ex + py * ey) / ee)) : 0;
          if (Math.hypot(px - f * ex, py - f * ey) <= rad) free[jy * nx + ix] = 0;
        }
      }
      var zb0 = zBase - o.gap, zb1 = zTop + o.gap;
      columns.forEach(function (col, ci) {
        if (mine[ci] || !col || !col.pts || !col.pts.length) return;
        var rad = col.side * Math.SQRT1_2 + COLUMN_CLEAR_MM + o.width / 2 + CELL_MM;
        /* a tip's column as planned, and as it may yet be cut - under its own
           sheet or at the gap - since a cut stands its top straight up from
           lower down its leg, somewhere the planned leg is not */
        var variants = [col.pts], tt = tipOfCol[ci];
        if (tt && tt.zTop != null) variants.push(cutPath(col.pts, tt.zTop, col.side), cutPath(col.pts, tt.zBase + o.eps, col.side));
        variants.forEach(function (p) { blockPath(p, col.side, rad); });
      });
      function blockPath(p, side, rad) {
        if (p.length === 1) { if (p[0][2] >= zb0 && p[0][2] <= zb1 + side) blockSeg(p[0], p[0], rad); return; }
        var col = { side: side };
        for (var k = 0; k + 1 < p.length; k++) {
          var a = p[k], b2 = p[k + 1], za = Math.max(a[2], b2[2]) + col.side, zz = Math.min(a[2], b2[2]) - col.side;
          if (za < zb0 || zz > zb1) continue;
          /* the part of the segment inside the band, in xy */
          var dz = b2[2] - a[2], ta = 0, tb = 1;
          if (Math.abs(dz) > 1e-9) {
            var t0 = (zb0 - col.side - a[2]) / dz, t1 = (zb1 + col.side - a[2]) / dz;
            ta = Math.max(0, Math.min(t0, t1)); tb = Math.min(1, Math.max(t0, t1));
            if (ta > tb) continue;
          }
          blockSeg([a[0] + (b2[0] - a[0]) * ta, a[1] + (b2[1] - a[1]) * ta], [a[0] + (b2[0] - a[0]) * tb, a[1] + (b2[1] - a[1]) * tb], rad);
        }
      }
      L.extraBlocks = L.extraBlocks || [];
      L.extraBlocks.forEach(function (eb) { blockSeg(eb, eb, eb[2]); });
      function freeAt(x, y) {
        var i = Math.round((x - ox) / CELL_MM), j = Math.round((y - oy) / CELL_MM);
        return i >= 0 && i < nx && j >= 0 && j < ny && free[j * nx + i] === 1;
      }
      /* the nearest sheet tip of each raster cell, found once: a line's
         samples read it here (owner() per sample, for every candidate angle,
         was most of a big level's time) */
      var own = new Int32Array(nx * ny);
      for (var jo = 0; jo < ny; jo++) {
        beat();
        for (var io = 0; io < nx; io++) { var ow = owner(ox + io * CELL_MM, oy + jo * CELL_MM); own[jo * nx + io] = ow ? ow.i : -1; }
      }
      function ownerAt(x, y) {
        var i = Math.round((x - ox) / CELL_MM), j = Math.round((y - oy) / CELL_MM);
        if (i < 0 || i >= nx || j < 0 || j >= ny) return null;
        var k = own[j * nx + i];
        return k < 0 ? null : tips[k];
      }

      /* runs of one layer at angle phi: [{ u, v0, v1, a:[x,y], b:[x,y] }] */
      var hw = o.width / 2;
      function runsAt(phi) {
        var th = phi * Math.PI / 180, dx = Math.cos(th), dy = Math.sin(th), mx = -dy, my = dx;
        var cs = [[lo[0], lo[1]], [hi[0], lo[1]], [lo[0], hi[1]], [hi[0], hi[1]]];
        var umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
        cs.forEach(function (c) {
          var u = c[0] * mx + c[1] * my, v = c[0] * dx + c[1] * dy;
          umin = Math.min(umin, u); umax = Math.max(umax, u); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
        });
        var out = [];
        for (var k = Math.ceil(umin / o.pitch); k * o.pitch <= umax; k++) {
          var u = k * o.pitch, run = null, prevOther = false;
          var close = function (edgeOther) {
            if (!run) return;
            if (run.otherLo) run.v0 += LEVEL_EDGE_MM;
            if (edgeOther) run.v1 -= LEVEL_EDGE_MM;
            if (run.v1 - run.v0 >= MIN_RUN_MM) out.push(run);
            run = null;
          };
          beat();
          for (var v = Math.ceil(vmin / SAMPLE_MM) * SAMPLE_MM; v <= vmax + 1e-9; v += SAMPLE_MM) {
            var x = u * mx + v * dx, y = u * my + v * dy;
            var ow = ownerAt(x, y), keep = ow && ow.level === L.id && freeAt(x, y);
            var other = !!(ow && ow.level !== L.id);
            if (keep) {
              if (!run) run = { u: u, v0: v, v1: v, otherLo: prevOther };
              else run.v1 = v;
            } else close(other);
            prevOther = other;
          }
          close(false);
        }
        out.forEach(function (rn) {
          rn.a = [rn.u * mx + rn.v0 * dx, rn.u * my + rn.v0 * dy];
          rn.b = [rn.u * mx + rn.v1 * dx, rn.u * my + rn.v1 * dy];
          rn.dir = [dx, dy]; rn.nrm = [mx, my];
        });
        return out;
      }
      /* where a run crosses a point (a tip's top) or another run */
      function crossesPoint(rn, p, half) {
        var u = p[0] * rn.nrm[0] + p[1] * rn.nrm[1], v = p[0] * rn.dir[0] + p[1] * rn.dir[1];
        return Math.abs(u - rn.u) <= half && v >= rn.v0 && v <= rn.v1 ? v : null;
      }
      function crossesRun(a, b) {
        /* a and b are perpendicular: b's line meets a at v = b.u's point projected */
        var den = a.dir[0] * b.nrm[0] + a.dir[1] * b.nrm[1];
        if (Math.abs(den) < 1e-9) return false;
        var t = (b.u - (a.a[0] * b.nrm[0] + a.a[1] * b.nrm[1])) / den;     /* along a from a.a */
        if (t < 0 || t > a.v1 - a.v0) return false;
        var X = [a.a[0] + a.dir[0] * t, a.a[1] + a.dir[1] * t];
        var vb = X[0] * b.dir[0] + X[1] * b.dir[1];
        return vb >= b.v0 && vb <= b.v1;
      }
      /* T1 at phi: its runs joined end to end into serpentines (a turn from
         one run to the next line's run, at alternate ends, where the turn's
         own path is footprint), the way the reference's transition is one
         path; a serpentine that crosses no tip is dropped. */
      function t1For(phi) {
        var runs = runsAt(phi), total = 0, chains = [], open = [];
        runs.forEach(function (rn) { rn.k = Math.round(rn.u / o.pitch); total += rn.v1 - rn.v0; });
        runs.sort(function (a, b) { return (a.k - b.k) || (a.v0 - b.v0); });
        var byK = {};
        runs.forEach(function (rn) { (byK[rn.k] = byK[rn.k] || []).push(rn); });
        function endOf(rn, side) { return side === 1 ? rn.b : rn.a; }
        function at(rn, v) { return [rn.u * rn.nrm[0] + v * rn.dir[0], rn.u * rn.nrm[1] + v * rn.dir[1]]; }
        function turnFree(p, q) {
          var n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / SAMPLE_MM));
          for (var i = 0; i <= n; i++) {
            var x = p[0] + (q[0] - p[0]) * i / n, y = p[1] + (q[1] - p[1]) * i / n, ow = ownerAt(x, y);
            if (!ow || ow.level !== L.id || !freeAt(x, y)) return false;
          }
          return true;
        }
        runs.forEach(function (B) {
          var pick = null;
          open.forEach(function (c) {
            if (c.tail.k !== B.k - 1 || c.done) return;
            var sides = c.free == null ? [1, 0] : [c.free];
            sides.forEach(function (sd) {
              /* the turn runs straight across, at the inner of the two ends:
                 the longer run gives up the difference (at most TURN_SKEW_MM),
                 so the turn is never a diagonal lying along a line */
              var A = c.tail, va = sd === 1 ? A.v1 : A.v0, vb = sd === 1 ? B.v1 : B.v0, skew = Math.abs(va - vb);
              var vt = sd === 1 ? Math.min(va, vb) : Math.max(va, vb);
              if (skew > TURN_SKEW_MM) return;
              if ((sd === 1 ? vt - A.v0 : A.v1 - vt) < MIN_RUN_MM / 2 || (sd === 1 ? vt - B.v0 : B.v1 - vt) < MIN_RUN_MM / 2) return;
              if (pick && skew >= pick.skew) return;
              /* a turn is a strip across the two lines: no other run on
                 either line may end within a line width of it */
              var clash = (byK[A.k] || []).concat(byK[B.k] || []).some(function (R) {
                return R !== A && R !== B && vt >= R.v0 - o.width - 0.05 && vt <= R.v1 + o.width + 0.05;
              });
              if (clash || !turnFree(at(A, vt), at(B, vt))) return;
              pick = { c: c, side: sd, skew: skew, vt: vt };
            });
          });
          if (pick) {
            var c = pick.c;
            if (c.free == null) c.first = pick.side;
            var A0 = c.tail;
            if (pick.side === 1) { A0.v1 = pick.vt; B.v1 = pick.vt; } else { A0.v0 = pick.vt; B.v0 = pick.vt; }
            A0.a = at(A0, A0.v0); A0.b = at(A0, A0.v1); B.a = at(B, B.v0); B.b = at(B, B.v1);
            c.runs.push(B); c.sides.push(pick.side); c.tail = B; c.free = 1 - pick.side;
            c.done = false;
          } else {
            c = { runs: [B], sides: [], tail: B, free: null };
            chains.push(c); open.push(c);
          }
          /* a chain links once per line */
          open = open.filter(function (x) { return x.tail.k >= B.k - 1; });
        });
        var kept = [], keptRuns = [], dropped = 0, hung = 0, bridge = 0, cant = 0, crossed = {};
        chains.forEach(function (c) {
          var any = false, per = c.runs.map(function (rn) {
            var vs = [];
            live.forEach(function (t) {
              var v = crossesPoint(rn, t.top, o.side / 2);
              if (v != null) vs.push({ v: v, t: t });
            });
            if (vs.length) any = true;
            return vs;
          });
          if (!any) { c.runs.forEach(function (rn) { dropped += rn.v1 - rn.v0; }); return; }
          c.runs.forEach(function (rn, k) {
            var vs = per[k].map(function (x) { crossed[x.t.i] = true; return x.v; }).sort(function (a, b) { return a - b; });
            if (!vs.length) { hung += rn.v1 - rn.v0; return; }
            for (var j = 0; j + 1 < vs.length; j++) bridge = Math.max(bridge, vs[j + 1] - vs[j] - o.side);
            cant = Math.max(cant, vs[0] - rn.v0 - o.side / 2, rn.v1 - vs[vs.length - 1] - o.side / 2);
          });
          /* the serpentine as one path: each run walked toward the end its turn leaves from */
          var path = [], s0 = c.runs.length > 1 ? c.sides[0] : 1;
          path.push(endOf(c.runs[0], 1 - s0), endOf(c.runs[0], s0));
          for (var k = 1; k < c.runs.length; k++) path.push(endOf(c.runs[k], c.sides[k - 1]), endOf(c.runs[k], 1 - c.sides[k - 1]));
          kept.push(path);
          keptRuns = keptRuns.concat(c.runs);
        });
        return { angleDeg: phi, runs: keptRuns, paths: kept, droppedMm: dropped, totalMm: total,
                 droppedShare: total > 0 ? dropped / total : 1, hungShare: total > 0 ? hung / total : 1,
                 maxBridgeMm: Math.max(0, bridge), maxCantileverMm: Math.max(0, cant), crossed: crossed };
      }
      var tried = (angleForced == null ? T1_ANGLES : [angleForced]).map(t1For);
      /* least dropped (5 % bands), then least hung from turns alone (10 %
         bands), then the axes first, then the shortest bridge - in bands, so
         a near tie goes to the axes, as the reference's lines run, and does
         not flip on a sample's rounding */
      var best = tried.slice().sort(function (a, b) {
        return (Math.floor(a.droppedShare * 20) - Math.floor(b.droppedShare * 20)) ||
               (Math.floor(a.hungShare * 10) - Math.floor(b.hungShare * 10)) ||
               (T1_ANGLES.indexOf(a.angleDeg) - T1_ANGLES.indexOf(b.angleDeg)) || (a.maxBridgeMm - b.maxBridgeMm);
      })[0];
      /* where the footprint is narrow the turns are most of the line: the
         layer is then built from its runs that cross a tip, open-ended */
      best.turns = true;
      if (CH.oneDirection(best.paths)) {
        best.turns = false;
        best.runs = best.runs.filter(function (rn) { return live.some(function (t) { return crossesPoint(rn, t.top, o.side / 2) != null; }); });
        best.paths = null;
        best.crossed = {};
        best.runs.forEach(function (rn) { live.forEach(function (t) { if (crossesPoint(rn, t.top, o.side / 2) != null) best.crossed[t.i] = true; }); });
      }
      var uncrossed = live.filter(function (t) { return !best.crossed[t.i]; });
      if (live.length - uncrossed.length < 2) return { ok: false, reason: 'a sheet needs two tips its lines cross; ' + (live.length - uncrossed.length) + ' here' };
      var layers = [{ runs: best.runs, paths: best.paths, angleDeg: best.angleDeg }];
      for (var li = 1; li < NL; li++) {
        var phi = (best.angleDeg + (li % 2 ? 90 : 0)) % 180, below = layers[li - 1].runs;
        var rs = runsAt(phi).filter(function (rn) { return below.some(function (q) { return crossesRun(rn, q); }); });
        layers.push({ runs: rs, angleDeg: phi });
      }
      var built = [];
      for (var lk = 0; lk < NL; lk++) {
        var Lk = layers[lk];
        var paths = Lk.paths || Lk.runs.map(function (rn) { return [rn.a, rn.b]; });
        if (!paths.length) return { ok: false, reason: SHEET_ROLES[lk] + ' layer ' + (lk + 1) + ' has no line left', uncrossed: uncrossed };
        var bad = CH.oneDirection(paths);
        if (bad) return { ok: false, reason: 'layer ' + (lk + 1) + ': ' + bad };
        var zb = zBase + lk * (o.layer - o.eps);
        var ex = RL.extrudeFlat(paths, { width: o.width, height: o.layer, baseZ: zb });
        if (!ex.ok) return { ok: false, reason: 'layer ' + (lk + 1) + ' would not extrude: ' + ex.reason };
        built.push({ role: SHEET_ROLES[lk], angleDeg: Lk.angleDeg, z0: zb, z1: zb + o.layer, lines: Lk.runs.length,
                     lengthMm: Lk.runs.reduce(function (s, rn) { return s + rn.v1 - rn.v0; }, 0),
                     paths: paths, soup: ex.tris });
      }
      return { ok: true, zTop: zTop, zBase: zBase, layers: built, uncrossed: uncrossed,
               t1: { angleDeg: best.angleDeg, maxBridgeMm: best.maxBridgeMm, maxCantileverMm: best.maxCantileverMm,
                     droppedShare: best.droppedShare, hungShare: best.hungShare, serpentines: best.paths ? best.paths.length : 0, turns: best.turns,
                     tried: tried.map(function (x) { return { angleDeg: x.angleDeg, droppedShare: x.droppedShare, hungShare: x.hungShare, maxBridgeMm: x.maxBridgeMm }; }) } };
    }

    rebucket();
    var reach = o.gap + 0.1;
    levels.forEach(function (L) {
      L.zTop = L.first;
      for (var it = 0; it < 8; it++) {
        var res = buildLevel(L, opts.angleDeg);
        if (!res.ok) { L.ok = false; L.reason = res.reason; break; }
        var soup = joinSoups(res.layers.map(function (x) { return x.soup; }));
        var dmin = Infinity, at = null, atTop = null;
        obstacles.forEach(function (B) {
          var d = exactDistance(soup, B, reach, beat);
          if (d.mm < dmin) { dmin = d.mm; at = d.at; atTop = d.topZ; }
        });
        if (dmin >= o.gap - 1e-5) {
          L.ok = true; L.res = res; L.minDistanceMm = dmin;
          /* A TIP NO T1 LINE CROSSES (its top is beside a wall the sheet
             keeps off, or at a narrow end): if any line of the sheet passes
             over it, it stays cut under the sheet and carries nothing; if
             none does, it is cut at the gap line instead and holds the
             ceiling itself (finish()'s last rung) - in neither case does a
             tip stand inside the sheet. */
          var reachTip = o.side * Math.SQRT1_2 + o.width / 2 + 0.05;
          res.uncrossed.forEach(function (t) {
            /* where the tip would stand if cut at the gap: its column through
               the stack's height, as that cut builds it */
            var gp = cutPath(columns[t.col].pts, t.zTop, o.side), stand = [];
            for (var g = 0; g + 1 < gp.length; g++) {
              var a = gp[g], b = gp[g + 1];
              if (Math.max(a[2], b[2]) < res.zBase - o.side || Math.min(a[2], b[2]) > res.zTop) continue;
              stand.push([a, b]);
            }
            var over = res.layers.some(function (Ly) {
              return Ly.paths.some(function (pth) {
                for (var q = 0; q + 1 < pth.length; q++) {
                  if (segDist2(t.top, pth[q], pth[q + 1]) <= reachTip) return true;
                  for (var k = 0; k < stand.length; k++) if (segSeg2(stand[k][0], stand[k][1], pth[q], pth[q + 1]) <= reachTip) return true;
                }
                return false;
              });
            });
            if (over) { t.carried = false; t.why = 'no transition line crosses it; cut under the sheet'; }
            else { t.mode = 'gap'; t.level = -1; t.why = 'no line of the sheet reaches it'; }
          });
          break;
        }
        /* the solve: a ceiling nearer than the gap straight above the top is
           met by lowering the level; anything else is cleared round */
        if (at && atTop >= res.zTop - o.layer / 2) { L.zTop -= (o.gap - dmin) + 1e-4; L.solvedDropMm = (L.solvedDropMm || 0) + (o.gap - dmin) + 1e-4; }
        else if (at) { L.extraBlocks = (L.extraBlocks || []).concat([[at[0], at[1], o.gap + o.width + CELL_MM]]); }
        else { L.ok = false; L.reason = 'the gap could not be measured'; break; }
        L.lastMinMm = dmin;
      }
      if (!L.ok && !L.reason) L.reason = 'the gap would not hold after 8 tries (closest ' + (L.lastMinMm || 0).toFixed(4) + ' mm)';
      if (!L.ok) L.tips.forEach(function (t) { if (t.mode === 'sheet') { t.mode = 'gap'; t.level = -1; t.why = 'its level failed: ' + L.reason; } });
    });

    /* the cut heights */
    tips.forEach(function (t) {
      if (t.mode === 'sheet') {
        var L = levels[t.level];
        t.zTop = L.res.zTop; t.zBase = L.res.zBase; t.cutZ = L.res.zBase + o.eps;
      } else if (t.mode === 'gap') {
        if (t.zu == null) t.zu = t.contact[2];
        t.cutZ = t.zu - o.gap;
      }
    });
    var lv = levels.filter(function (L) { return L.ok; }).map(function (L) {
      return { id: L.id, zTop: L.res.zTop, zBase: L.res.zBase, tips: L.tips.filter(function (t) { return t.mode === 'sheet'; }).map(function (t) { return t.i; }),
               layers: L.res.layers, t1: L.res.t1, minDistanceMm: L.minDistanceMm, solvedDropMm: L.solvedDropMm || 0 };
    });
    var counts = { sheet: 0, gap: 0, side: 0 };
    tips.forEach(function (t) { counts[t.mode]++; });
    return {
      ok: true, gapMm: o.gap, layerMm: o.layer, widthMm: o.width, pitchMm: o.pitch, epsMm: o.eps, tipSpacingMm: spacing,
      levels: lv, failed: levels.filter(function (L) { return !L.ok; }).map(function (L) { return { id: L.id, zTop: L.first, reason: L.reason }; }),
      tips: tips.map(function (t) {
        return { i: t.i, label: t.label, beacon: t.beacon, col: t.col, mode: t.mode, level: t.level, carried: t.mode === 'sheet' ? t.carried !== false : null,
                 zTop: t.zTop, zBase: t.zBase, cutZ: t.cutZ, why: t.why || null };
      }),
      counts: counts,
      reason: lv.length + ' sheet(s) of 2 transition + 2 interface layers at ' + o.pitch + ' mm over ' + counts.sheet +
        ' tip(s); ' + counts.gap + ' tip(s) cut at the gap, ' + counts.side + ' side tip(s) held off the face',
      probe: { nearest: nearestMm }
    };
  }

  /* A column (top first) cut flat at cutZ: from where its axis is one side
     under the cut - or, on a leg shorter than that, halfway down it - straight
     up to the cut, so the top is a level square on a leaning leg and never
     leaves the column's own leg (two legs meeting at a merge node must not be
     cut to one stub at the node). The path from there on is the column's. */
  function cutPath(pts, cutZ, side) {
    if (pts[0][2] <= cutZ + 1e-9) return pts.map(function (q) { return q.slice(); });
    var zEnd = pts[pts.length - 1][2];
    var zq = cutZ - Math.min(side, Math.max(0, (cutZ - zEnd) / 2));
    for (var k = 0; k + 1 < pts.length; k++) {
      var a = pts[k], b = pts[k + 1];
      if (b[2] <= zq + 1e-12) {
        var f = (a[2] - zq) / (a[2] - b[2]), Q = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, zq];
        var out = [[Q[0], Q[1], cutZ], Q];
        for (var j = k + 1; j < pts.length; j++) {
          var p = pts[j], l = out[out.length - 1];
          if (Math.hypot(p[0] - l[0], p[1] - l[1], p[2] - l[2]) > 1e-6) out.push(p.slice());
        }
        return out;
      }
    }
    var e = pts[pts.length - 1];
    return [[e[0], e[1], Math.max(cutZ, e[2] + 1e-3)], e.slice()];
  }

  /* 2D distance between segments ab and cd (z ignored) */
  function segSeg2(a, b, c, d) {
    function orient(p, q, r) { return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); }
    var o1 = orient(a, b, c), o2 = orient(a, b, d), o3 = orient(c, d, a), o4 = orient(c, d, b);
    if (((o1 > 0) !== (o2 > 0)) && ((o3 > 0) !== (o4 > 0))) return 0;
    return Math.min(segDist2(a, c, d), segDist2(b, c, d), segDist2(c, a, b), segDist2(d, a, b));
  }
  function segDist2(p, a, b) {
    var ex = b[0] - a[0], ey = b[1] - a[1], ee = ex * ex + ey * ey;
    var f = ee > 1e-18 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / ee)) : 0;
    return Math.hypot(p[0] - a[0] - f * ex, p[1] - a[1] - f * ey);
  }

  /* ONE PROBE PER PIECE. Every area of a build is planned against the same
     piece array (the Supports card's worker keeps one copy for the build), and
     preparing the probe is the weld and the grid over every triangle: 0.6 s
     of the 49k-triangle wedge, paid 25 times over for its 25 areas before
     this. Kept per array, and checked on a sample of its values so an array
     edited in place is not served a stale probe. */
  var PREP = typeof WeakMap === 'function' ? new WeakMap() : null;
  function prepared(TH, soup) {
    var sig = soup.length + ':' + soup[0] + ':' + soup[soup.length >> 1] + ':' + soup[soup.length - 1];
    var hit = PREP && PREP.get(soup);
    if (hit && hit.sig === sig && hit.TH === TH) return hit.P;
    var P = TH.prepare(soup, {});
    if (PREP) PREP.set(soup, { sig: sig, TH: TH, P: P });
    return P;
  }

  function joinSoups(list) {
    var n = 0; list.forEach(function (s) { n += s.length; });
    var out = new Float32Array(n), w = 0;
    list.forEach(function (s) { out.set(s, w); w += s.length; });
    return out;
  }

  var api = {
    DEFAULTS: { gapMm: GAP_MM, layerMm: LAYER_MM, pitchMm: PITCH_MM, repeats: REPEATS, epsMm: EPS_MM },
    SHEET: { pitchMm: SHEET_PITCH_MM, roles: SHEET_ROLES.slice(), cellMm: CELL_MM, sampleMm: SAMPLE_MM, t1Angles: T1_ANGLES.slice() },
    sheet: sheet,
    cutPath: cutPath,
    finish: finish,
    minDistance: function (A, B, opts) { return minDistance(mod(opts, 'thickness', 'NSO_Thickness'), A, B, opts); },
    exactDistance: function (A, B, opts) { return exactDistance(A, B, (opts && opts.reach) || Infinity); },
    _patch: function (cx, cy, zBase, o, repeats) { return patch(mod(o, 'crosshatch', 'NSO_Crosshatch'), cx, cy, zBase, o, repeats); }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SupportInterface = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
