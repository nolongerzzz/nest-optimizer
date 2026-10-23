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
       2 transition and 2 interface layers at 0.84 mm, each a loop and a
       serpentine inside it, on the tips' flat caps (THE SHEET,
       below; docs/SUPPORT-INTERFACE.md) - and under a curved or sloped
       underside a STAIR, one band a layer, each held by tips of its own
       tree (THE STAIR; section 7). nso_support_gridpack.js parts()
       builds it, and the caps, with opts.interface.
   cutPath(pts, cutZ, side, rise) -> a column (top first) cut flat at cutZ,
       standing straight up from `rise` (default: side) under the cut
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
  function exactDistance(A, B, reach, beat, under) {
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
    /* under: every triangle of A nearer B than it, by index (best.under) -
       pruned at `under`, not at the best so far */
    var collect = under == null ? null : [];
    for (var a = 0, ai = 0; a < A.length; a += 9, ai++) {
      if (beat && (ai & 1023) === 0) beat();
      var TA = triAt(A, a), ba = boxOf(TA), lim = collect ? under : Math.min(best.mm, reach), dA = Infinity;
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
        if (g > (collect ? under : Math.min(best.mm, reach))) continue;
        best.pairs++;
        var d = triTri(TA, b.T);
        if (d < dA) dA = d;
        if (d < best.mm) {
          best.mm = d;
          best.at = [(TA[0][0] + TA[1][0] + TA[2][0]) / 3, (TA[0][1] + TA[1][1] + TA[2][1]) / 3, (TA[0][2] + TA[1][2] + TA[2][2]) / 3];
          best.topZ = ba.hi[2]; best.lowZ = ba.lo[2];
        }
      }
      if (collect && dA < under) collect.push(ai);
    }
    if (best.mm > reach) best.mm = Infinity;
    if (collect) best.under = collect;
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
     between them. Bambu's tree builds this instead, measured on the
     top_clip_x2 coupon (thinwall_sideXside.gcode.3mf, tree slim: z 12.58 /
     12.86 / 13.13 / 13.40), bottom to top:
        caps     every tip under the ceiling widens over its last CAP_RISE_MM
                 to a flat cap CAP_MIN_MM - CAP_MAX_MM across, its neighbours
                 at most CAP_GAP_MAX_MM away edge to edge; every cap ends at
                 ONE level, z_cap, one full layer under T1
        T1, T2   two TRANSITION layers, direction A, 0.84 mm pitch, the same
                 in both - rails over the caps
        I1       INTERFACE, direction B, across the rails
        I2       INTERFACE, direction A: the rails again
        gap      0.18 mm of air, then the part
     EVERY LAYER IS A LOOP AND A SERPENTINE, a piece at a time: one closed
     perimeter loop round each piece of the sheet's footprint (Bambu's opens
     every layer: 22.24 x 14.34 mm), then one serpentine inside it - line,
     U-turn, line, at 0.84 mm (Bambu's: 13.6 mm lines, 0.84 mm turns) -
     whose turns stand IN from the loop and never touch it, joined to the
     loop at ONE point, its start: one connected thin wall, one path a
     layer (Bambu's: 54 extrusions, 3 travels).
     The loop is what the sheet releases by: the owner printed the loops
     alone, by accident, and they came away clean.
     NOTHING BUT THE SHEET OCCUPIES THE SHEET'S LAYERS: a cap's top, and a
     capless tip's cut, is z_cap exactly, and T1's underside is z_cap - the
     two meet on that plane (no overlap: a slicer layer through T1 cuts no
     cap). The layers above stand each on the one below the same way, faces
     meeting: T2 is T1, and set EPS_MM into it their walls stood in one
     plane for 2 um, which the union left as slivers (2 piercing pairs on
     the clamp's area 1).

     ONE THIN WALL A PIECE, JOINED AT ONE POINT. The sheet is laid on a
     grid at the pitch both ways in its frame (A along, B across). Each
     PIECE has its loop round its outline - a rectangle, or a stepped
     rectilinear outline, as Bambu's loops follow the region - and its
     serpentine on the piece's INNER grid points only (a point all four of
     whose cells are the piece's): every line and turn of it stands a
     pitch off the loop, a clear gap of the pitch less a line (0.44 mm at
     0.40, a line width and more; Bambu's turns stand 0.36 mm in from its
     loop) -
     but for ONE grid step joining the serpentine's start to the loop (THE
     BRIDGE, bridged()), so loop and serpentine are one connected thin wall
     with one hole, drawn as one path. With the turns ON the loop (the
     first build), loop and lines fused into one region with every channel
     closed, and a slicer traced each channel - each line twice: 610 - 856
     mm a layer in 1,350 - 2,700 segments on the owner's plate
     (thinwall_supports_bambu.gcode.3mf), against Bambu's 434 mm in 54.
     The serpentine's lines run along A (T1, T2, I2) or B (I1); on each
     line the inner points' runs, and of those the longest strip of runs on
     consecutive lines sharing a point with the next, line i turning into
     line i + 1 at one end, the ends alternating.
     NSO_Crosshatch.oneDirection is held on the lines of the layer's
     direction (the serpentine's and the loop's sides along it).

     THE FIELD: every cap of the level (a capless tip: its column's top)
     dilated by FIELD_MM, so caps CAP_GAP_MAX_MM apart meet in it; inside the
     free raster (THE FOOTPRINT, below); out of another level's cells and
     LEVEL_EDGE_MM short of them.

     THE PIECES. A grid cell is the sheet's when its four edges lie in the
     field; runs of cells shorter than MIN_RUN_MM either way go, and so does
     a cell that meets another only at a corner; each 4-connected set left
     is a piece of the field. Each is the sheet's largest rectangle in it
     where that carries as many caps as its strips do (the coupon's slab and
     leg: one each); else its column STRIPS - where a column of cells splits
     round a hole, or two meet, the strips end and that column goes (a gap
     of a pitch: no two loops touch), so a ring round a boss is four strips -
     each its own piece, a rectangle where that carries as much, else its
     stepped outline. A piece carrying fewer than two caps goes. A cap is
     carried when a wall of T1, loop or serpentine, either way, lies across
     it with its whole width on it.

     LINE WIDTH. SHEET_UNDER of a bead, to the 0.01 mm: the bead is
     NSO_Thickness.floorFor, nozzle x 1.05 (0.42 at a 0.4 nozzle), so the
     line is 0.42 x 0.95 = 0.399 -> 0.40 mm, one line width under the bead
     (nozzle x 0.95 would be 0.38: not what printed). A slicer insets a
     region by half a bead for its outer wall, so a strip under a bead has
     no wall in it: it is a THIN WALL, and the sheet is printed by the
     slicer's thin-wall pass, one centre pass a line. On the owner's A1 mini,
     Bambu Studio with the classic wall generator and Detect thin wall on
     printed the 0.40 sheet in one pass (filament 1.09 m, against 1.03 m
     without the sheet and 1.14 m for a 0.43 sheet outlined round its
     sliver); with thin walls off it prints nothing of it. So every support
     object carries both, SHEET_SLICER: wall_generator = classic (Bambu's
     default is Arachne) and detect_thin_wall = 1, as object metadata in
     Metadata/model_settings.config (nso-3mf.js, an object's settings) -
     Bambu reads object metadata into the object's config for any vendor's
     3MF, and drops it when the file is imported as geometry only. NSO's
     own slicer (Clipper2) has no thin-wall mode and keeps none of a strip
     under a bead: it draws no sheet (a slicer ticket).

     THE LEVEL. A tip's sheet top is GAP_MM under the lowest point of the
     ceiling over the tip's cell (vertical rays; a point more than one layer
     below the tip is a lip or a wall, not the ceiling, and is left to the
     footprint below). Tips whose tops agree within LEVEL_TOL_MM are one level:
     one sheet. The stack is four layers of layerMm, each on the one below,
     T1 on z_cap.

     THE CAPS. A tip of the level ends in a cap that follows its own leg: a
     round frustum from where the leg's axis crosses CAP_RISE_MM under z_cap
     (CAP_FOOT of the column's side across: inside its square however it is
     turned) up to where it crosses z_cap, its flat top exactly z_cap. The
     column is cut along its own axis CAP_TUCK_MM and half its diagonal under
     the cap's top, so its end is under the cap's top and inside the cap's
     height (the rise is never less than that and CAP_TUCK_MM again: a strut
     of 2.7 mm would end under a 2 mm cap's foot); the end's corners may stand
     out of the cap's flank, where the column stood before it was cut. Its top
     CAP_BAND_MM stands upright, so the cap's top edge is a wall of its own
     (a flank cut 10 um from its end came back from the kernel as needles
     NSO's slicer could not close). Standing the tip upright under the cap
     instead walks its top up to 1.2 mm along a 30 deg leg and bunches the
     caps of tips that lean to one node (measured: caps 0.9 mm apart on the
     coupon's leg).
     A cap's width is the distance to the nearest tip of the level less
     CAP_SPACE_MM, held to CAP_MIN_MM - CAP_MAX_MM. Two caps nearer than
     their widths allow first SPREAD: both slide apart, each within its
     slack (its top still over its column's end), where they still keep
     their clearances - legs leaning to one node cross z_cap closer than
     their tips stand (the coupon's slab: caps 2.11 mm unspread, 2.50
     spread). Then a cap is narrowed by
     CAP_STEP_MM while any of it comes nearer the piece than the gap or within
     COLUMN_CLEAR_MM of a column of a tree that does not carry this level -
     down to the column's own side, where the tip has no cap (said, per tip)
     and is cut flat at z_cap (its top where that cut puts it, and no cap
     within CAP_PART_MM of it). Those clearances are sampled first, then every
     cap is MEASURED: a hull round it against the piece with exactDistance,
     narrowed until it keeps the gap.

     THE FOOTPRINT (the free raster). A cell is free only where the COLUMN of
     the stack, [base - gap, top + gap), meets nothing of the piece within
     gap + half a line (a raster of vertical rays, flooded from the tips so
     the inside of a wall is never mistaken for air, then dilated), and no
     other support's column passes through the stack there (a member of a
     tree this level carries that stays under z_cap is under the stack, not
     in it). Each cell belongs to the nearest sheet tip (within CELL_PITCHES
     of the tips' own spacing) - which is how another level's cells are
     known.

     A TIP NO T LINE LIES ON (its cap beside a wall the sheet keeps off, or
     on no piece) is cut at z_cap all the same if a line of the
     sheet passes over it, or else cut at the gap line ('gap', finish()'s last
     rung, no cap), standing beside the sheet, not under it.

     THE ANGLE is chosen, and reported. The planner's tips stand on the beacon
     grid's square lattice; A is the candidate whose pieces leave the fewest
     caps with no T wall on them, then the one with the fewest pieces, then
     the fewest that are not rectangles, then T's lines 2 mm or longer, then
     the most sheet (in 5 % bands), then the shorter line (A across a
     rectangle's short side, as Bambu's), then the axes first.

     THE GAP IS MEASURED, not trusted: each level's stack is measured with
     exactDistance against the piece (minDistance's sampler cannot prune a
     flat top lying exactly the gap under a ceiling: every sample is a
     candidate) and lowered (a sloped ceiling) or cleared round the offending
     point (a wall) until the true minimum is the gap.

     IN THE CARD'S WORKER. sheet() runs inside NSO_SupportGridpack.parts(),
     which the Supports card runs in its build worker; opts.beat() is called
     through the long loops so the worker's progress never goes quiet, and
     opts.progress(done, total) counts the tips (every one that is not a
     side tip): a tip is done when its level's gap holds (or the level fails
     and it is cut at the gap) - and, while a level is being solved, its
     tips are told off by the share of the level's footprint raster read in
     its first pass (never the last of them, and never back).

     sheet(piece, stations, opts) -> plan (plain data, plus .probe, a function
       for the caller's own clearance checks - drop it before posting the plan)
       stations: [{ label, beacon, contact, side, col }] - col indexes
                 opts.columns: [{ pts (top first), side, tree }], every
                 support member's polyline (tree: the trunk it belongs to),
                 so the sheet and its caps keep out of the ones it does not
                 carry
       opts: gapMm, layerMm, widthMm | nozzle, pitchMm, sideMm, plateZ,
             footMm, occluders, angleDeg (forces I1's), capRiseMm, capMinMm,
             capMaxMm, thickness, crosshatch, rasterLines, beat, progress
       every sheet tip carries cutZ, rise (cutPath's) and cap ({ c, w, z0,
       z1, footD } or null); a tip a stair holds by itself has mode 'drop'
       and is not built; every level its caps, zCap and its four layers
       ({ role, angleDeg, z0, z1, pieces: [{ kind: 'rectangle' | 'outline',
       sizeMm, areaMm2, perimMm, caps, lines, loop, snake }], loopMm
       (the first piece's size), lines, linesMm, lengthMm, shortestMm,
       paths: [each piece's loop, closed, then its serpentine] }); a stair
       is a level too, with .stair ({ slopeDeg, angleDeg, strips, ... }),
       .held (the tips it holds by itself), .stair.tips (the tips its
       strips want: [{ p, strip }], planned and built by gridpack as the
       stair's own tree) and its layers its transition then one band a
       layer (role 'interface', widthMm, beads, advanceMm, overlapMm, tips)
     =================================================================== */
  var SHEET_PITCH_MM = 0.84;   /* the reference's interface pitch (0.42 line + 0.42 channel) */
  var SHEET_ROLES = ['transition', 'transition', 'interface', 'interface'];
  var SHEET_UNDER = 0.95;      /* a line is this much of a bead, to the 0.01 mm: see LINE WIDTH */
  /* what the sheet needs of the slicer, written on every support object
     (Metadata/model_settings.config): see LINE WIDTH */
  /* every support object's per-object overrides, one set for all of them
     (docs/BAMBU-PROJECT-EXPORT.md): the sheet's thin-wall pass (above) and
     the supports' own filler off (sparse_infill_density 0 %, wall_loops 1:
     Bambu fills a support object like a part, sparse plus internal solid
     inside every trunk and branch; Bambu's own tree slim prints a trunk as a
     loop or two round air) and nothing else. top / bottom_shell_layers 0
     were tried and failed on the owner's print: the 0.2 mm foot pads printed
     as a 15 % lattice, so 81 % of layer 2's support walls had no line under
     them and the trunks went to spaghetti. Per-family tuning waits for a
     print. */
  var SHEET_SLICER = { wall_generator: 'classic', detect_thin_wall: '1', sparse_infill_density: '0%', wall_loops: '1' };
  var CELL_MM = 0.1;           /* the footprint raster */
  var SAMPLE_MM = 0.05;        /* along a line */
  var LEVEL_TOL_MM = 0.01;
  var CELL_PITCHES = 0.6;      /* a sample belongs to a tip within this many tip spacings (Chebyshev) */
  var MIN_RUN_MM = 2;          /* a line shorter than this is not kept: no printed segment under 2 mm */
  var LEVEL_EDGE_MM = 0.25;    /* runs of two levels stop this far apart */
  var FIELD_MM = 1.25;         /* the caps dilated this far are the sheet's field: caps CAP_GAP_MAX_MM apart meet in it (see THE FIELD) */
  var COLUMN_CLEAR_MM = 0.2;   /* the sheet and its caps keep this far off another support's column */
  var ROOM_MM = 0.5;           /* a cut tip keeps this much of itself above the foot */
  var CAP_RISE_MM = 2;         /* a tip widens to its cap over this much of its rise */
  var CAP_MIN_MM = 2.5;        /* a cap is this wide at least... */
  var CAP_MAX_MM = 4;          /* ...and at most */
  var CAP_SPACE_MM = 0.5;      /* where there is room, a cap leaves this much air to its nearest neighbour */
  var CAP_GAP_MAX_MM = 2;      /* the most air between a cap and its nearest neighbour (CAP_MAX_MM caps on tips 6 mm apart) */
  var CAP_STEP_MM = 0.25;      /* a cap too near the piece or another support narrows by this */
  var CAP_FOOT = 0.9;          /* the cap's foot across, as a share of the column's side: inside its square however either is turned */
  var CAP_TUCK_MM = 0.1;       /* the column under a cap ends this far (and half its diagonal) inside it: no face of the two shares a plane */
  var CAP_SIDES = 32;          /* the cap's rim, sampled for its clearance */
  var CAP_PART_MM = 0.05;      /* a cap stops this far short of its neighbour's: caps never overlap (see THE CAPS) */
  var CAP_BAND_MM = 0.02;      /* a cap's top band: upright, this tall, so its top edge is a wall, not the flank's (see THE CAPS) */
  var LINE_ANGLES = [0, 90, 26.565051177077994, 116.56505117707799, 63.43494882292201, 153.43494882292202, 45, 135];
  /* THE STAIR (see THE STAIR, below sheet()'s levels) */
  var STAIR_JOIN = 1.6;        /* tips this many tip spacings apart (or nearer) are one stair */
  var STAIR_MIN_TIPS = 3;      /* a stair holds at least this many tips */
  var STAIR_MIN_DEG = 3;       /* the underside's fitted slope: under this it is a ceiling (the levels' work) */
  var STAIR_MAX_DEG = 70;      /* ...over this, a wall */
  var STAIR_DV = 0.25;         /* a band's front edge is read every this along the stair's lines */
  var STAIR_JUMP_MM = 0.5;     /* ...and a run of them is one band while no step jumps further */
  var STAIR_BACK_MM = 0.55;    /* a strip's back edge lies no further than this under the part */
  var STAIR_STEP_MM = 0.03;    /* a band nearer the piece than the gap moves up the slope by this, at least */
  var STAIR_TIP_MM = 5;        /* a strip's leading part has a tip every this, or nearer, along it (Bambu's branch distance) */
  var STAIR_SNAP_DEG = 2;       /* a fall this near one of the sheet's line angles takes it */
  var STAIR_REACH_MM = 3;
  var STAIR_START = 0.6;       /* the stair starts where a strip first runs this share of the longest strip's length */      /* a strip lies only where the part's underside is this near over it */

  function sheet(piece, stations, opts) {
    opts = opts || {};
    var TH = mod(opts, 'thickness', 'NSO_Thickness');
    var CH = mod(opts, 'crosshatch', 'NSO_Crosshatch');
    var RL = mod(opts, 'rasterLines', 'NSO_RasterLines');
    if (!TH || !CH || !RL) return { ok: false, reason: 'the sheet needs nso_thickness.js, nso_crosshatch.js and nso_raster_lines.js' };
    var o = {
      gap: opts.gapMm == null ? GAP_MM : +opts.gapMm,
      layer: opts.layerMm == null ? LAYER_MM : +opts.layerMm,
      width: opts.widthMm == null ? Math.round(TH.floorFor(opts.nozzle) * SHEET_UNDER * 100) / 100 : +opts.widthMm,
      pitch: opts.pitchMm == null ? SHEET_PITCH_MM : +opts.pitchMm,
      side: opts.sideMm == null ? 1.2 : +opts.sideMm,
      plateZ: opts.plateZ == null ? 0 : +opts.plateZ,
      foot: opts.footMm == null ? 0 : +opts.footMm,
      capRise: opts.capRiseMm == null ? CAP_RISE_MM : +opts.capRiseMm,
      capMin: opts.capMinMm == null ? CAP_MIN_MM : +opts.capMinMm,
      capMax: opts.capMaxMm == null ? CAP_MAX_MM : +opts.capMaxMm,
      eps: EPS_MM
    };
    if (!(o.pitch > o.width)) return { ok: false, reason: 'pitch ' + o.pitch + ' does not clear the ' + o.width + ' mm line' };
    var columns = opts.columns || [];
    var obstacles = [piece].concat(opts.occluders || []).filter(function (s) { return s && s.length >= 9; });
    var PPs = obstacles.map(function (s) { return prepared(TH, s); });
    var NL = SHEET_ROLES.length, stackH = NL * o.layer;
    /* how far under the cap's top a capped column ends: CAP_TUCK and half its
       diagonal - and the cap rises at least that and CAP_TUCK again, so the
       column always ends inside its cap's height (a strut of 2.7 mm or more,
       or a short capRiseMm, would otherwise end under the cap's foot and the
       cap, and the sheet on it, float) */
    var sink = CAP_TUCK_MM + o.side * Math.SQRT1_2;
    o.capRise = Math.max(o.capRise, sink + CAP_TUCK_MM);
    /* where a column's axis crosses z (its polyline, top first; above it, its top) */
    function colAxisAt(pts, z) {
      if (pts.length < 2 || z >= pts[0][2]) return [pts[0][0], pts[0][1]];
      for (var k = 0; k + 1 < pts.length; k++) {
        var a = pts[k], b = pts[k + 1];
        if (z <= a[2] + 1e-12 && z >= b[2] - 1e-12) {
          var dz = a[2] - b[2], f = dz > 1e-12 ? (a[2] - z) / dz : 0;
          return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
        }
      }
      var e = pts[pts.length - 1]; return [e[0], e[1]];
    }

    /* opts.beat(): called through the long loops, so a caller that reports
       progress (the card's build worker) is never silent for long */
    var beat = typeof opts.beat === 'function' ? opts.beat : function () {};
    var tell = typeof opts.progress === 'function' ? opts.progress : null, nTips = 0, settled = 0, levels = [];
    function told() {
      if (!tell) return;
      var d = settled;
      levels.forEach(function (L) { d += L.told || 0; });
      try { tell(d, nTips); } catch (err) { /* a listener must not stop the sheet */ }
    }
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
    function nearestPt(p, r) {
      var best = null;
      for (var i = 0; i < PPs.length; i++) { var nr = PPs[i].nearest(p, r); if (nr && (!best || nr.dist < best.dist)) best = nr; }
      return best;
    }

    var tips = stations.map(function (st, i) {
      return { i: i, label: st.label, beacon: st.beacon, contact: st.contact.slice(), col: st.col,
               mode: st.side ? 'side' : 'sheet', level: -1 };
    });
    var cand = tips.filter(function (t) { return t.mode === 'sheet'; });
    nTips = cand.length;

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
      /* ROOM: the cut must leave a tip under the stack and its cap, above its foot. */
      if (!(t.zBase - Math.max(o.side, o.capRise) - ROOM_MM > o.plateZ + o.foot) || !col) { t.mode = 'gap'; t.why = 'no room for the stack and its cap above the plate'; }
    });

    var tipOfCol = {};
    tips.forEach(function (t) { tipOfCol[t.col] = t; });

    /* ---- levels ---- */
    cand.filter(function (t) { return t.mode === 'sheet'; }).sort(function (a, b) { return a.zTop - b.zTop; }).forEach(function (t) {
      var L = levels[levels.length - 1];
      if (!L || t.zTop - L.first > LEVEL_TOL_MM) { L = { id: levels.length, first: t.zTop, tips: [], told: 0 }; levels.push(L); }
      L.tips.push(t); t.level = L.id;
    });
    /* a tip on no level (no room for the stack) is settled already */
    settled = nTips - levels.reduce(function (n, L) { return n + L.tips.length; }, 0);
    told();

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

    /* A PIECE'S LOOP: the boundary of its cells, one closed polygon (a
       piece is a column-convex strip, so it has no hole) */
    function loopOf(G, has) {
      var key = function (k, j) { return k + ',' + j; }, nextOf = {}, start = null;
      for (var k = 0; k < G.K; k++) for (var j = 0; j < G.J; j++) {
        if (!has(k, j)) continue;
        /* the cell's edges counter-clockwise; one whose other side is not the piece's is the outline's */
        if (!has(k, j - 1)) nextOf[key(k, j)] = [k + 1, j];
        if (!has(k + 1, j)) nextOf[key(k + 1, j)] = [k + 1, j + 1];
        if (!has(k, j + 1)) nextOf[key(k + 1, j + 1)] = [k, j + 1];
        if (!has(k - 1, j)) nextOf[key(k, j + 1)] = [k, j];
        if (!start) start = [k, j];
      }
      var loop = [start], at0 = start, seen = 0, total = Object.keys(nextOf).length;
      do { at0 = nextOf[key(at0[0], at0[1])]; loop.push(at0); seen++; } while ((at0[0] !== start[0] || at0[1] !== start[1]) && seen <= total);
      var ar = 0;
      for (var i = 0; i + 1 < loop.length; i++) ar += loop[i][0] * loop[i + 1][1] - loop[i + 1][0] * loop[i][1];
      return { loop: loop, closed: seen === total, areaCells: ar / 2, perimCells: loop.length - 1 };
    }
    /* THE SERPENTINE, ONE PITCH INSIDE THE LOOP. It runs on the piece's
       inner grid points only - a point all four of whose cells are the
       piece's - so every one of its lines and turns stands a pitch off
       the loop: a clear gap of a line width (0.84 - 0.40 mm) between the
       two walls, as Bambu's serpentine stands in from its loop, and the
       two never touch. Lines along one direction (lineOf: the line's
       index, alongOf: the position along it); on each line the inner
       points' runs; of those, the longest strip of runs on consecutive
       lines that share a point with the next (where the turn is); line i
       turns into line i + 1 at one end, the ends alternating, each turn
       where both lines reach; a line left shorter than a pitch between
       its two turns breaks the strip, and the longest piece is kept. */
    function serpentineOf(G, has, alongA) {
      var inner = function (k, j) { return has(k - 1, j - 1) && has(k, j - 1) && has(k - 1, j) && has(k, j); };
      var n1 = alongA ? G.K : G.J, n2 = alongA ? G.J : G.K, lines = [];
      for (var a = 0; a <= n1; a++) {
        var runs = [];
        for (var b = 0; b <= n2;) {
          var ok = alongA ? inner(a, b) : inner(b, a);
          if (!ok) { b++; continue; }
          var e = b; while (e <= n2 && (alongA ? inner(a, e) : inner(e, a))) e++;
          if (e - 1 - b >= 1) runs.push([b, e - 1]);
          b = e;
        }
        lines.push(runs);
      }
      /* the longest strip: one run a line, each sharing a point with the next */
      var val = [], top = null;
      for (var i = 0; i < lines.length; i++) {
        val[i] = lines[i].map(function (r) {
          var pv = 0, prev = -1;
          if (i > 0) val[i - 1].forEach(function (q, j2) {
            var R0 = lines[i - 1][j2];
            if (Math.min(R0[1], r[1]) - Math.max(R0[0], r[0]) >= 0 && q.val > pv) { pv = q.val; prev = j2; }
          });
          return { val: r[1] - r[0] + pv, prev: prev };
        });
        val[i].forEach(function (q, j2) { if (!top || q.val > top.val) top = { val: q.val, i: i, j: j2 }; });
      }
      if (!top) return null;
      var seq = [];
      for (var i2 = top.i, j3 = top.j; j3 >= 0; j3 = val[i2][j3].prev, i2--) {
        seq.unshift({ i: i2, lo: lines[i2][j3][0], hi: lines[i2][j3][1] });
        if (i2 === 0) break;
      }
      function build(first) {
        var n = seq.length, side = function (i3) { return i3 % 2 ? -first : first; }, vt = [];
        for (var t = 0; t + 1 < n; t++) {
          var A = seq[t], B = seq[t + 1], v = side(t) > 0 ? Math.min(A.hi, B.hi) : Math.max(A.lo, B.lo);
          vt.push(v >= Math.max(A.lo, B.lo) && v <= Math.min(A.hi, B.hi) ? v : null);
        }
        var pieces = [], cur = [];
        for (var t2 = 0; t2 < n; t2++) {
          var lo = seq[t2].lo, hi = seq[t2].hi;
          if (t2 > 0 && vt[t2 - 1] != null && cur.length) { if (side(t2 - 1) > 0) hi = vt[t2 - 1]; else lo = vt[t2 - 1]; }
          if (t2 + 1 < n && vt[t2] != null) { if (side(t2) > 0) hi = vt[t2]; else lo = vt[t2]; }
          if (hi - lo < 1 || (t2 > 0 && vt[t2 - 1] == null)) { if (cur.length) pieces.push(cur); cur = []; if (hi - lo < 1) continue; }
          cur.push({ i: seq[t2].i, lo: lo, hi: hi, out: side(t2) });
        }
        if (cur.length) pieces.push(cur);
        var best = null;
        pieces.forEach(function (pc) { var l = pc.reduce(function (s, x) { return s + x.hi - x.lo; }, 0); if (!best || l > best.len) best = { len: l, lines: pc }; });
        return best;
      }
      var b1 = build(1), b2 = build(-1), sn = !b1 ? b2 : !b2 ? b1 : (b2.len > b1.len ? b2 : b1);
      if (!sn) return null;
      /* the path: each line from its end on the side it came in by to the side it leaves by */
      var path = [];
      sn.lines.forEach(function (ln) {
        var from = ln.out > 0 ? ln.lo : ln.hi, to = ln.out > 0 ? ln.hi : ln.lo, d = to > from ? 1 : -1;
        for (var v = from; ; v += d) { path.push(alongA ? [ln.i, v] : [v, ln.i]); if (v === to) break; }
      });
      return { path: path, lines: sn.lines.map(function (ln) { return { i: ln.i, lo: ln.lo, hi: ln.hi }; }) };
    }
    /* A PIECE BUILT: its loop, its two serpentines (along A for T1, T2,
       I2; along B for I1), and the caps it carries - a wall of T1, loop or
       serpentine, either way, across the cap with its whole width on it */
    /* THE BRIDGE: the serpentine joins its loop at ONE point - its start,
       a pitch from a point of the loop, bridged by that one grid step - so
       loop and serpentine are one connected thin wall, drawn as one path
       (Bambu's: 54 extrusions, 3 travels a layer), and everywhere else
       the serpentine keeps the pitch off the loop. If only its far end has
       a loop point a step away, the serpentine is run the other way. */
    function bridged(loop, sn) {
      var onLoop = {};
      loop.forEach(function (p) { onLoop[p[0] + ',' + p[1]] = p; });
      function foot(p) {
        var c = [[p[0] - 1, p[1]], [p[0] + 1, p[1]], [p[0], p[1] - 1], [p[0], p[1] + 1]];
        for (var i = 0; i < c.length; i++) if (onLoop[c[i][0] + ',' + c[i][1]]) return c[i];
        return null;
      }
      var path = sn.path, f = foot(path[0]);
      if (!f) { var r = path.slice().reverse(), g = foot(r[0]); if (g) { path = r; f = g; } }
      if (!f) return null;
      return { path: [f].concat(path), lines: sn.lines };
    }
    /* ---- one level's stack ---- */
    function buildLevel(L, angleForced) {
      var live = L.tips.filter(function (t) { return t.mode === 'sheet'; });
      /* a sheet spans from tip to tip: one tip alone carries a patch, not a sheet */
      if (live.length < 2) return { ok: false, reason: 'a sheet needs two tips at one level; this one has ' + live.length };
      var zTop = L.zTop, zBase = zTop - stackH, zCap = zBase;
      /* each tip's cap: its top where the leg crosses z_cap, its foot CAP_RISE_MM down the leg */
      live.forEach(function (t) { var pts = columns[t.col].pts; t.top = colAxisAt(pts, zCap); t.capFoot = colAxisAt(pts, zCap - o.capRise); });
      var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      live.forEach(function (t) {
        for (var k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], t.contact[k] - H); hi[k] = Math.max(hi[k], t.contact[k] + H); }
      });
      /* the reach of a line's edge off its centreline: half a width (at a
         line's square end, half a width times root 2) */
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
      var NH = Math.max(3, Math.ceil((z1 - z0) / (o.layer / 2)));
      /* the level's tips told off by the share of the raster read (see opts.progress) */
      var rows = 0, rowsAll = ny * (1 + NH), nL = L.tips.length;
      function rowRead() {
        rows++;
        var k = Math.min(nL - 1, Math.floor(nL * rows / rowsAll));
        if (k > L.told) { L.told = k; told(); }
      }
      for (var j = 0; j < ny; j++, rowRead()) for (var i = 0, b0 = beat(); i < nx; i++) {
        if (hitIn(ox + i * CELL_MM, oy + j * CELL_MM, z0, z1)) hit[j * nx + i] = 1;
      }
      for (var hk = 0; hk < NH; hk++) {
        var zh = z0 + (z1 - z0) * (hk + 0.5) / NH;
        for (var jr = 0; jr < ny; jr++, beat(), rowRead()) markInside(oy + jr * CELL_MM, zh, function (i0) { hit[jr * nx + i0] = 1; });
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
      var mine = {}, trees = {};
      L.tips.forEach(function (t) { mine[t.col] = true; var cl = columns[t.col]; if (cl && cl.tree != null) trees[cl.tree] = true; });
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
        /* a member of a tree this level carries that stays under z_cap
           (its top and half its side) is under the stack, not in it */
        if (col.tree != null && trees[col.tree] && !tipOfCol[ci] &&
            Math.max.apply(null, col.pts.map(function (q) { return q[2]; })) + col.side / 2 <= zCap) return;
        var rad = col.side * Math.SQRT1_2 + COLUMN_CLEAR_MM + o.width / 2 + CELL_MM;
        /* a tip's column as planned, and as it may yet be cut - under its own
           sheet or at the gap - since a cut stands its top straight up from
           lower down its leg, somewhere the planned leg is not */
        var variants = [col.pts], tt = tipOfCol[ci];
        if (tt && tt.zTop != null) variants.push(cutPath(col.pts, tt.zTop, col.side), cutPath(col.pts, tt.zBase - sink, col.side, 0));
        variants.forEach(function (p) { blockPath(p, col.side, rad); });
      });
      /* where a column's polyline passes through the band [za, zb], in xy: its pieces */
      function bandPieces(p, side, za, zb, fn) {
        if (p.length === 1) { if (p[0][2] >= za - side && p[0][2] <= zb + side) fn(p[0], p[0]); return; }
        for (var k = 0; k + 1 < p.length; k++) {
          var a = p[k], b2 = p[k + 1], zhi = Math.max(a[2], b2[2]) + side, zlo = Math.min(a[2], b2[2]) - side;
          if (zhi < za || zlo > zb) continue;
          var dz = b2[2] - a[2], ta = 0, tb = 1;
          if (Math.abs(dz) > 1e-9) {
            var t0 = (za - side - a[2]) / dz, t1 = (zb + side - a[2]) / dz;
            ta = Math.max(0, Math.min(t0, t1)); tb = Math.min(1, Math.max(t0, t1));
            if (ta > tb) continue;
          }
          fn([a[0] + (b2[0] - a[0]) * ta, a[1] + (b2[1] - a[1]) * ta], [a[0] + (b2[0] - a[0]) * tb, a[1] + (b2[1] - a[1]) * tb]);
        }
      }
      function blockPath(p, side, rad) { bandPieces(p, side, zb0, zb1, function (a, b2) { blockSeg(a, b2, rad); }); }
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

      /* THE CAPS: as wide as the nearest tip allows, then narrowed off the
         piece and off every column of a tree this level does not carry */
      /* null when a cap of width w topped at c keeps its clearances, else
         what it comes too near: { push } - the horizontal way out from the
         piece, when it is the piece - or { column: true } */
      /* a column's box in xy, once a level */
      var colBoxes = [];
      function colBox(ci) {
        if (!colBoxes[ci]) {
          var b = [Infinity, Infinity, -Infinity, -Infinity];
          columns[ci].pts.forEach(function (q) { b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); });
          colBoxes[ci] = b;
        }
        return colBoxes[ci];
      }
      function capFoul(t, c, w) {
        var f = t.capFoot, Rc = w / 2, rb = CAP_FOOT * o.side / 2, aim = o.gap + Rc * (1 - Math.cos(Math.PI / CAP_SIDES)) + 0.003;
        function at(s) { return [f[0] + (c[0] - f[0]) * s, f[1] + (c[1] - f[1]) * s]; }
        /* [z, centre, radius]: the top, half way in on it, half way up, the foot */
        var rings = [[zCap, c, Rc], [zCap, c, Rc / 2], [zCap - o.capRise / 2, at(0.5), (Rc + rb) / 2], [zCap - o.capRise, f, rb]];
        var samples = [[c[0], c[1], zCap]];
        for (var ri = 0; ri < rings.length; ri++) for (var k = 0; k < CAP_SIDES; k++) {
          var a = 2 * Math.PI * k / CAP_SIDES, q = rings[ri][1];
          samples.push([q[0] + rings[ri][2] * Math.cos(a), q[1] + rings[ri][2] * Math.sin(a), rings[ri][0]]);
        }
        /* the deepest offence: a sample in the piece (out through its nearest
           face, then the gap) or one nearer it than the gap */
        var worst = null;
        for (var si = 0; si < samples.length; si++) {
          var p = samples[si], ins = inside(p), nr = nearestPt(p, ins ? Math.max(1, Rc * 2) : aim);
          if (ins && !nr) return { inside: true };
          if (!nr || (!ins && !(nr.dist < aim))) continue;
          var need = ins ? nr.dist + aim : aim - nr.dist;
          if (!worst || need > worst.need) worst = { need: need, ins: ins, from: p, to: nr.point };
        }
        if (worst) {
          var dx = worst.from[0] - worst.to[0], dy = worst.from[1] - worst.to[1], dl = Math.hypot(dx, dy), sg = worst.ins ? -1 : 1;
          return { push: dl > 1e-9 ? [sg * dx / dl * (worst.need + 0.01), sg * dy / dl * (worst.need + 0.01)] : null };
        }
        for (var ci = 0; ci < columns.length; ci++) {
          var col = columns[ci];
          if (mine[ci] || !col || !col.pts || !col.pts.length || (col.tree != null && trees[col.tree])) continue;
          var rad = Rc + col.side * Math.SQRT1_2 + COLUMN_CLEAR_MM, near = false, cb = colBox(ci);
          if (Math.min(c[0], f[0]) - rad > cb[2] || Math.max(c[0], f[0]) + rad < cb[0] ||
              Math.min(c[1], f[1]) - rad > cb[3] || Math.max(c[1], f[1]) + rad < cb[1]) continue;
          bandPieces(col.pts, col.side, zCap - o.capRise, zCap, function (a2, b2) { if (!near && segSeg2(c, f, a2, b2) <= rad) near = true; });
          if (near) return { column: true };
        }
        return null;
      }
      /* A cap too near the piece first slides its top away from it - as far
         as still covers the column's end (its top less the column's half
         diagonal) - and only then narrows */
      live.forEach(function (t) {
        beat();
        var nnTop = Infinity;
        live.forEach(function (u) { if (u !== t) nnTop = Math.min(nnTop, Math.hypot(u.top[0] - t.top[0], u.top[1] - t.top[1])); });
        var w = Math.min(o.capMax, Math.max(o.capMin, nnTop - CAP_SPACE_MM)), why = null, c = null;
        for (; w > o.side + 1e-9; w = Math.max(o.side, w - CAP_STEP_MM)) {
          var cc = t.top.slice(), slack = w / 2 - o.side * Math.SQRT1_2, bad = null;
          for (var it2 = 0; it2 < 8; it2++) {
            bad = capFoul(t, cc, w);
            if (!bad || !bad.push) break;
            var nc = [cc[0] + bad.push[0], cc[1] + bad.push[1]];
            if (!(Math.hypot(nc[0] - t.top[0], nc[1] - t.top[1]) <= slack)) break;
            cc = nc; why = 'slid off the piece';
          }
          if (!bad) { c = cc; break; }
          why = 'narrowed off the piece or another support';
          if (w <= o.side + 1e-9 + CAP_STEP_MM && w - CAP_STEP_MM <= o.side + 1e-9) { w = o.side; break; }
        }
        if (!c) { t.cap = null; t.capWhy = 'no room for a cap: the column\'s own top'; return; }
        t.cap = { c: c, b: t.capFoot.slice(), w: w, z0: zCap - o.capRise, z1: zCap, footD: CAP_FOOT * o.side, band: CAP_BAND_MM, nnMm: nnTop, why: why,
                  slidMm: Math.hypot(c[0] - t.top[0], c[1] - t.top[1]) };
        t.capWhy = why;
      });
      /* CAPS SPREAD BEFORE THEY NARROW. Legs that lean to one node cross
         z_cap closer than their tips stand (the coupon's slab: 2.16 mm, caps
         2.11 mm wide), so two caps nearer than their widths allow first slide
         apart along the line between them, each within its own slack - its
         top still over its column's end - and a slide is kept only where the
         cap still keeps its clearances (capFoul) */
      var spread = live.filter(function (t) { return t.cap; }), fixed = {};
      function slackOf(t) { return t.cap.w / 2 - o.side * Math.SQRT1_2; }
      /* rounds: every cap pushed by all its crowding neighbours at once (half
         each pair's shortfall; all of it against a cap that cannot move),
         held to its slack, and checked where it lands - one that fouls stays
         where it was, and moves no more */
      for (var sp = 0; sp < 24; sp++) {
        var pushes = spread.map(function () { return [0, 0]; }), any = false;
        for (var sa = 0; sa < spread.length; sa++) for (var sb = sa + 1; sb < spread.length; sb++) {
          var CA = spread[sa].cap.c, CB = spread[sb].cap.c, fa = fixed[sa], fb = fixed[sb];
          if (fa && fb) continue;
          var ddx = CB[0] - CA[0], ddy = CB[1] - CA[1], dd2 = Math.hypot(ddx, ddy), need = (spread[sa].cap.w + spread[sb].cap.w) / 2 + CAP_PART_MM;
          if (dd2 >= need - 1e-9 || dd2 < 1e-6) continue;
          /* a pair no slide can part (tips 1.3 - 2.1 mm apart on the clamp's
             area 2) is left to the narrowing below */
          if (Math.hypot(spread[sa].top[0] - spread[sb].top[0], spread[sa].top[1] - spread[sb].top[1]) +
              (fa ? 0 : slackOf(spread[sa])) + (fb ? 0 : slackOf(spread[sb])) < need) continue;
          var short = need - dd2 + 2e-4, ux = ddx / dd2, uy = ddy / dd2, ka = fa ? 0 : fb ? 1 : 0.5, kb = fb ? 0 : fa ? 1 : 0.5;
          pushes[sa][0] -= ux * short * ka; pushes[sa][1] -= uy * short * ka;
          pushes[sb][0] += ux * short * kb; pushes[sb][1] += uy * short * kb;
        }
        spread.forEach(function (T, k) {
          if (fixed[k] || (!pushes[k][0] && !pushes[k][1])) return;
          var c0 = T.cap.c, nc = [c0[0] + pushes[k][0], c0[1] + pushes[k][1]];
          var off = Math.hypot(nc[0] - T.top[0], nc[1] - T.top[1]), sl = slackOf(T);
          /* at the slack's edge: as far as it goes */
          if (off > sl) nc = [T.top[0] + (nc[0] - T.top[0]) / off * sl, T.top[1] + (nc[1] - T.top[1]) / off * sl];
          if (Math.hypot(nc[0] - c0[0], nc[1] - c0[1]) < 1e-4) return;
          if (capFoul(T, nc, T.cap.w)) { fixed[k] = true; return; }
          T.cap.c = nc; T.cap.slidMm = Math.hypot(nc[0] - T.top[0], nc[1] - T.top[1]); any = true;
        });
        if (!any) break;
      }
      /* CAPS NEVER OVERLAP. Two flat tops in one plane that overlap are the
         one input the union cannot be trusted with - measured on the clamp's
         area 2, tips 1.3 - 2.1 mm apart, 2.5 mm caps: 70 piercing pairs in
         the welded sheet; none with the caps apart - so a cap stops
         CAP_PART_MM short of every neighbour, both shrinking alike: tips
         closer than CAP_MIN_MM + CAP_PART_MM get the widest caps that fit
         (said, per tip), which a slicer's closing (0.049 mm at Bambu's
         defaults) prints as one region with them. A cap that would be no
         wider than its column is no cap. */
      var capped = live.filter(function (t) { return t.cap; });
      for (var pass = 0, moved = true; moved && pass < 8; pass++) {
        moved = false;
        for (var ia = 0; ia < capped.length; ia++) for (var ib = ia + 1; ib < capped.length; ib++) {
          var A = capped[ia].cap, B = capped[ib].cap, dd = Math.hypot(A.c[0] - B.c[0], A.c[1] - B.c[1]) - CAP_PART_MM;
          if ((A.w + B.w) / 2 <= dd + 1e-9) continue;
          /* the narrower keeps its width when the wider can give the rest */
          var span = Math.max(dd, 0);
          if (A.w <= span) B.w = 2 * span - A.w;
          else if (B.w <= span) A.w = 2 * span - B.w;
          else { A.w = span; B.w = span; }
          A.why = B.why = 'held short of a neighbour ' + (dd + CAP_PART_MM).toFixed(2) + ' mm away'; moved = true;
        }
      }
      capped.forEach(function (t) {
        if (t.cap.w <= o.side + 1e-9) { t.cap = null; t.capWhy = 'no room for a cap: the column\'s own top'; }
        else t.capWhy = t.cap.why;
      });
      /* A TIP WITH NO CAP stands as before: its column cut flat at z_cap
         after an upright run of its side, so its top is THERE, not where its
         leg crosses z_cap (a 30 deg leg: 0.7 mm apart) - and no cap comes
         within CAP_PART_MM of that top's square either.
         EVERY CAP IS MEASURED: capFoul samples a few rings, which a rib or a
         post between them gets past, so each cap - as a hull round the
         polygon gridpack builds - is measured against the piece with the
         exact triangle distance and narrowed by CAP_STEP_MM until it keeps
         the gap. Narrowing only ever takes a cap in (its foot stays), so a
         cap measured clear stays clear. */
      function bareTop(t) { var cp = cutPath(columns[t.col].pts, zCap, o.side, o.side); return [cp[0][0], cp[0][1]]; }
      function noCap(t, why) { t.cap = null; t.capWhy = why; t.top = bareTop(t); }
      var pending = live.filter(function (t) { return t.cap; });
      live.forEach(function (t) { if (!t.cap) t.top = bareTop(t); });
      /* THE LEVELS BUILT BEFORE THIS ONE: their caps and bare tops standing
         within a cap's rise of this level hold this level's caps CAP_PART_MM
         short too - on a tilted ceiling each row of tips is a level of its
         own, 3 mm from the next row's, and caps sized row by row overlapped
         with their tops 12 - 74 um apart */
      var others = [];
      levels.forEach(function (M) {
        if (M === L || !M.ok || !M.res) return;
        if (!(Math.abs(M.res.zCap - zCap) < o.capRise)) return;
        M.tips.forEach(function (u) { if (u.mode === 'sheet' && (u.cap || u.top)) others.push(u); });
      });
      for (var settle = 0; settle < 64; settle++) {
        var changed = false;
        live.forEach(function (t) {
          if (!t.cap) return;
          others.forEach(function (u) {
            if (!t.cap) return;
            var at = u.cap ? u.cap.c : u.top, reachU = u.cap ? u.cap.w / 2 : o.side * Math.SQRT1_2;
            var room = Math.hypot(t.cap.c[0] - at[0], t.cap.c[1] - at[1]) - reachU - CAP_PART_MM;
            if (t.cap.w / 2 > room + 1e-9) {
              t.cap.w = Math.max(0, 2 * room); t.cap.why = t.capWhy = 'held short of a neighbour of another level ' + Math.hypot(t.cap.c[0] - at[0], t.cap.c[1] - at[1]).toFixed(2) + ' mm away';
              changed = true;
              if (t.cap.w <= o.side + 1e-9) noCap(t, 'no room for a cap: the column\'s own top');
            }
          });
          if (!t.cap) return;
          live.forEach(function (u) {
            if (u === t || u.cap || !t.cap) return;
            var room = Math.hypot(t.cap.c[0] - u.top[0], t.cap.c[1] - u.top[1]) - o.side * Math.SQRT1_2 - CAP_PART_MM;
            if (t.cap.w / 2 > room + 1e-9) {
              t.cap.w = Math.max(0, 2 * room); t.cap.why = t.capWhy = 'held short of a neighbour\'s column ' + Math.hypot(t.cap.c[0] - u.top[0], t.cap.c[1] - u.top[1]).toFixed(2) + ' mm away';
              changed = true;
              if (t.cap.w <= o.side + 1e-9) noCap(t, 'no room for a cap: the column\'s own top');
            }
          });
        });
        pending = pending.filter(function (t) { return t.cap; });
        if (pending.length) {
          var hulls = pending.map(function (t) { return capHull(t.cap); }), first = [], nT = 0;
          hulls.forEach(function (hs) { first.push(nT); nT += hs.length / 9; });
          var soupC = joinSoups(hulls), near = {};
          obstacles.forEach(function (B) {
            exactDistance(soupC, B, o.gap + 0.1, beat, o.gap - 1e-5).under.forEach(function (ai) {
              var lo2 = 0, hi2 = first.length - 1;
              while (lo2 < hi2) { var md = (lo2 + hi2 + 1) >> 1; if (first[md] <= ai) lo2 = md; else hi2 = md - 1; }
              near[lo2] = true;
            });
          });
          pending = pending.filter(function (t, k) {
            if (!near[k]) return false;
            changed = true;
            t.cap.w = Math.max(o.side, t.cap.w - CAP_STEP_MM); t.cap.why = t.capWhy = 'narrowed off the piece (measured)';
            if (t.cap.w <= o.side + 1e-9) { noCap(t, 'no room for a cap: the piece is in its way'); return false; }
            return true;
          });
        }
        if (!changed) break;
      }
      /* THE FIELD (see THE SNAKE): where a line's centre may lie - every
         cap of the level (a bare top: its square's half side) dilated by
         FIELD_MM, inside the free raster, out of another level's cells and
         LEVEL_EDGE_MM short of them */
      var edge = new Uint8Array(nx * ny), RE = Math.ceil(LEVEL_EDGE_MM / CELL_MM), field = new Uint8Array(nx * ny);
      for (var qe = 0; qe < nx * ny; qe++) {
        var ko = own[qe];
        if (ko < 0 || tips[ko].level === L.id) continue;
        var ei = qe % nx, ej = (qe - ei) / nx;
        for (var dje = -RE; dje <= RE; dje++) for (var die = -RE; die <= RE; die++) {
          var ii2 = ei + die, jj2 = ej + dje;
          if (ii2 >= 0 && ii2 < nx && jj2 >= 0 && jj2 < ny && Math.hypot(die, dje) * CELL_MM <= LEVEL_EDGE_MM) edge[jj2 * nx + ii2] = 1;
        }
      }
      function carrierOf(t) { return t.cap ? { c: t.cap.c, r: t.cap.w / 2 } : { c: t.top, r: o.side / 2 }; }
      live.forEach(function (t) {
        var cr = carrierOf(t), rr = cr.r + FIELD_MM;
        var i0 = Math.max(0, Math.floor((cr.c[0] - rr - ox) / CELL_MM)), i1 = Math.min(nx - 1, Math.ceil((cr.c[0] + rr - ox) / CELL_MM));
        var j0 = Math.max(0, Math.floor((cr.c[1] - rr - oy) / CELL_MM)), j1 = Math.min(ny - 1, Math.ceil((cr.c[1] + rr - oy) / CELL_MM));
        for (var jf = j0; jf <= j1; jf++) for (var iff = i0; iff <= i1; iff++) {
          var qf = jf * nx + iff, kf = own[qf];
          if (!free[qf] || edge[qf] || (kf >= 0 && tips[kf].level !== L.id)) continue;
          if (Math.hypot(ox + iff * CELL_MM - cr.c[0], oy + jf * CELL_MM - cr.c[1]) <= rr) field[qf] = 1;
        }
      });
      function fieldAt(x, y) {
        var i = Math.round((x - ox) / CELL_MM), j = Math.round((y - oy) / CELL_MM);
        return i >= 0 && i < nx && j >= 0 && j < ny && field[j * nx + i] === 1;
      }
      /* a frame: lines run along dir, at u = k * pitch across them (nrm) */
      function frameAt(phi) {
        var th = phi * Math.PI / 180, dx = Math.cos(th), dy = Math.sin(th);
        return { phi: phi, dir: [dx, dy], nrm: [-dy, dx] };
      }
      function at(F, u, v) { return [u * F.nrm[0] + v * F.dir[0], u * F.nrm[1] + v * F.dir[1]]; }
      /* THE PIECES at phi. The sheet's grid is the pitch both ways in the
         frame (u = k * pitch across A, v = j * pitch along it); a cell is
         the sheet's when its four edges lie in the field. Runs of cells
         shorter than MIN_RUN_MM either way go (every channel the layers
         close is 2 mm or longer), and so does a cell that meets another
         piece only at a corner; each 4-connected set left is a PIECE. */
      var MINC = Math.ceil(MIN_RUN_MM / o.pitch - 1e-9);
      function gridFor(phi) {
        var F = frameAt(phi), umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
        [[ox, oy], [ox + nx * CELL_MM, oy], [ox, oy + ny * CELL_MM], [ox + nx * CELL_MM, oy + ny * CELL_MM]].forEach(function (c) {
          var u = c[0] * F.nrm[0] + c[1] * F.nrm[1], v = c[0] * F.dir[0] + c[1] * F.dir[1];
          umin = Math.min(umin, u); umax = Math.max(umax, u); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v);
        });
        var k0 = Math.floor(umin / o.pitch), j0 = Math.floor(vmin / o.pitch);
        var K = Math.ceil(umax / o.pitch) - k0, J = Math.ceil(vmax / o.pitch) - j0;
        function P(k, j) { return at(F, (k0 + k) * o.pitch, (j0 + j) * o.pitch); }
        function edgeIn(a, b) {
          for (var s = 0; s <= 6; s++) { var x = a[0] + (b[0] - a[0]) * s / 6, y = a[1] + (b[1] - a[1]) * s / 6; if (!fieldAt(x, y)) return false; }
          return true;
        }
        var eA = new Uint8Array((K + 1) * J), eB = new Uint8Array(K * (J + 1)), cell = new Uint8Array(K * J);
        for (var k = 0; k <= K; k++) { beat(); for (var j = 0; j < J; j++) eA[k * J + j] = edgeIn(P(k, j), P(k, j + 1)) ? 1 : 0; }
        for (var k2 = 0; k2 < K; k2++) for (var j2 = 0; j2 <= J; j2++) eB[k2 * (J + 1) + j2] = edgeIn(P(k2, j2), P(k2 + 1, j2)) ? 1 : 0;
        for (var k3 = 0; k3 < K; k3++) for (var j3 = 0; j3 < J; j3++)
          cell[k3 * J + j3] = eA[k3 * J + j3] && eA[(k3 + 1) * J + j3] && eB[k3 * (J + 1) + j3] && eB[k3 * (J + 1) + j3 + 1] ? 1 : 0;
        var C = function (k, j) { return k >= 0 && k < K && j >= 0 && j < J && cell[k * J + j] === 1; };
        for (var changed = true; changed;) {
          changed = false;
          /* short runs, along A (a column) and across it (a row) */
          for (var kc = 0; kc < K; kc++) for (var jc = 0; jc < J;) {
            if (!C(kc, jc)) { jc++; continue; }
            var je = jc; while (C(kc, je)) je++;
            if (je - jc < MINC) { for (var q = jc; q < je; q++) cell[kc * J + q] = 0; changed = true; }
            jc = je;
          }
          for (var jr = 0; jr < J; jr++) for (var kr = 0; kr < K;) {
            if (!C(kr, jr)) { kr++; continue; }
            var ke = kr; while (C(ke, jr)) ke++;
            if (ke - kr < MINC) { for (var q2 = kr; q2 < ke; q2++) cell[q2 * J + jr] = 0; changed = true; }
            kr = ke;
          }
          /* two cells meeting at a corner only */
          for (var kd = 0; kd + 1 < K; kd++) for (var jd = 0; jd + 1 < J; jd++) {
            var a = C(kd, jd), b = C(kd + 1, jd), c = C(kd, jd + 1), d = C(kd + 1, jd + 1);
            if (a && d && !b && !c) { cell[(kd + 1) * J + jd + 1] = 0; changed = true; }
            else if (b && c && !a && !d) { cell[kd * J + jd + 1] = 0; changed = true; }
          }
        }
        /* the pieces */
        var comp = new Int32Array(K * J).fill(-1), comps = [];
        for (var s0 = 0; s0 < K * J; s0++) {
          if (!cell[s0] || comp[s0] >= 0) continue;
          var id = comps.length, st = [s0], cells = [];
          comp[s0] = id;
          while (st.length) {
            var q3 = st.pop(), qk = (q3 / J) | 0, qj = q3 - qk * J;
            cells.push(q3);
            [[qk - 1, qj], [qk + 1, qj], [qk, qj - 1], [qk, qj + 1]].forEach(function (nb) {
              if (C(nb[0], nb[1])) { var w = nb[0] * J + nb[1]; if (comp[w] < 0) { comp[w] = id; st.push(w); } }
            });
          }
          comps.push({ id: id, cells: cells });
        }
        /* where each cap's lines are: the columns of lines whose whole
           width lies on it (kl..kh), and its row */
        var spans = live.map(function (t) {
          var cr = carrierOf(t), cu = cr.c[0] * F.nrm[0] + cr.c[1] * F.nrm[1], cv = cr.c[0] * F.dir[0] + cr.c[1] * F.dir[1], h = cr.r - o.width / 2;
          return { t: t, kl: Math.ceil((cu - h) / o.pitch - 1e-9) - k0, kh: Math.floor((cu + h) / o.pitch + 1e-9) - k0, j: Math.floor(cv / o.pitch) - j0,
                   jl: Math.ceil((cv - h) / o.pitch - 1e-9) - j0, jh: Math.floor((cv + h) / o.pitch + 1e-9) - j0, cu: cu - k0 * o.pitch, cv: cv - j0 * o.pitch, r: cr.r };
        });
        return { F: F, K: K, J: J, k0: k0, j0: j0, P: P, cell: cell, comp: comp, comps: comps, spans: spans };
      }
      /* the caps a set of cells carries: a line along A of it - between two
         of its cells or on its edge - across the cap */
      function capsOf(G, has) {
        var out = {};
        G.spans.forEach(function (sp) {
          if (sp.kl > sp.kh || sp.j < 0 || sp.j >= G.J) return;
          for (var k = Math.max(0, sp.kl); k <= Math.min(G.K, sp.kh); k++) if (has(k - 1, sp.j) || has(k, sp.j)) { out[sp.t.i] = true; return; }
        });
        return out;
      }
      /* the largest rectangle of a piece that carries the most of its caps */
      function bestRect(G, has, cellsOf) {
        var ks = cellsOf.map(function (q) { return (q / G.J) | 0; }), js = cellsOf.map(function (q) { return q % G.J; });
        var kmin = Math.min.apply(null, ks), kmax = Math.max.apply(null, ks), jmin = Math.min.apply(null, js), jmax = Math.max.apply(null, js), best = null;
        for (var ca = kmin; ca <= kmax; ca++) {
          var iv = null;
          for (var cb = ca; cb <= kmax; cb++) {
            var runs = [];
            for (var j = jmin; j <= jmax;) { if (!has(cb, j)) { j++; continue; } var e = j; while (has(cb, e)) e++; runs.push([j, e]); j = e; }
            if (iv === null) iv = runs;
            else { var nx2 = []; iv.forEach(function (I) { runs.forEach(function (R) { var lo = Math.max(I[0], R[0]), hi = Math.min(I[1], R[1]); if (hi - lo >= MINC) nx2.push([lo, hi]); }); }); iv = nx2; }
            iv = iv.filter(function (I) { return I[1] - I[0] >= MINC; });
            if (!iv.length) break;
            if (cb - ca + 1 < MINC) continue;
            iv.forEach(function (I) {
              var inR = function (k, j) { return k >= ca && k <= cb && j >= I[0] && j < I[1]; };
              var n = Object.keys(capsOf(G, inR)).length, area = (cb - ca + 1) * (I[1] - I[0]);
              if (!best || n > best.n || (n === best.n && area > best.area)) best = { n: n, area: area, ca: ca, cb: cb, ja: I[0], jb: I[1] };
            });
          }
        }
        return best;
      }
      function pieceOf(G, has, kind) {
        var lp = loopOf(G, has), sA = serpentineOf(G, has, true), sB = serpentineOf(G, has, false);
        if (!lp.closed || !sA || !sB) return null;
        sA = bridged(lp.loop, sA); sB = bridged(lp.loop, sB);
        if (!sA || !sB) return null;
        /* T1's walls, edge by edge: 'a k,j' along A from (k, j), 'b j,k' along B from (k, j) */
        var mat = {};
        [lp.loop, sA.path].forEach(function (pth) {
          for (var i = 0; i + 1 < pth.length; i++) {
            var p = pth[i], q = pth[i + 1];
            if (p[0] === q[0]) mat['a' + p[0] + ',' + Math.min(p[1], q[1])] = true;
            else mat['b' + p[1] + ',' + Math.min(p[0], q[0])] = true;
          }
        });
        /* a wall at offset d from the cap's centre has its whole width on
           the cap over the chord +-sqrt(r^2 - (d + w/2)^2): any edge of it
           there carries the cap */
        var caps = {};
        G.spans.forEach(function (sp) {
          if (sp.kl > sp.kh) return;
          function on(kind, a, d, along) {
            var c = sp.r * sp.r - Math.pow(Math.abs(d) + o.width / 2, 2);
            if (c < 0) return false;
            c = Math.sqrt(c);
            for (var b = Math.floor((along - c) / o.pitch); b <= Math.floor((along + c - 1e-9) / o.pitch); b++) if (mat[kind + a + ',' + b]) return true;
            return false;
          }
          for (var k = sp.kl; k <= sp.kh; k++) if (on('a', k, sp.cu - k * o.pitch, sp.cv)) { caps[sp.t.i] = true; return; }
          for (var j = sp.jl; j <= sp.jh; j++) if (on('b', j, sp.cv - j * o.pitch, sp.cu)) { caps[sp.t.i] = true; return; }
        });
        var us = lp.loop.map(function (p3) { return p3[0]; }), vs = lp.loop.map(function (p3) { return p3[1]; });
        return { kind: kind, loop: lp.loop, snakeA: sA, snakeB: sB, caps: caps, n: Object.keys(caps).length,
                 areaCells: lp.areaCells, perimCells: lp.perimCells,
                 size: [Math.max.apply(null, us) - Math.min.apply(null, us), Math.max.apply(null, vs) - Math.min.apply(null, vs)] };
      }
      /* COLUMN STRIPS. A piece whose columns (cells along A) are each one run
         and overlap the next one to one is a strip; where a column splits
         round a hole, or two meet, the strips end and the column between
         them goes (a gap of a pitch: two loops never touch), and new strips
         start past it - a ring round a boss is four strips */
      function stripsOf(G, cells) {
        var set = {};
        cells.forEach(function (q) { set[q] = true; });
        var has = function (k, j) { return k >= 0 && k < G.K && j >= 0 && j < G.J && set[k * G.J + j] === true; };
        var strips = [], prev = [];
        for (var k = 0; k < G.K; k++) {
          var cur = [];
          for (var j = 0; j < G.J;) { if (!has(k, j)) { j++; continue; } var e = j; while (has(k, e)) e++; cur.push({ r: [j, e], strip: undefined }); j = e; }
          var over = function (a, b) { return Math.min(a[1], b[1]) - Math.max(a[0], b[0]) > 0; };
          cur.forEach(function (c) {
            var ov = prev.filter(function (p) { return over(p.r, c.r); });
            if (!ov.length || ov.every(function (p) { return p.strip === null; })) { c.strip = { cells: [] }; strips.push(c.strip); return; }
            var p = ov[0];
            if (ov.length === 1 && p.strip && cur.filter(function (c2) { return over(p.r, c2.r); }).length === 1) c.strip = p.strip;
            else c.strip = null;
          });
          cur.forEach(function (c) { if (c.strip) for (var q = c.r[0]; q < c.r[1]; q++) c.strip.cells.push(k * G.J + q); });
          prev = cur;
        }
        return strips.map(function (s) { return s.cells; }).filter(function (c) { return c.length; });
      }
      /* the sheet at phi: its pieces - every strip of the field's pieces,
         as the largest rectangle in it where that carries every cap the
         strip does (the coupon's slab: one), else as its stepped outline;
         a piece carrying fewer than two caps goes */
      function sheetAt(phi) {
        var G = gridFor(phi), pieces = [], crossed = {}, cellsTot = 0, lineLen = 0, lineN = 0, minLine = Infinity;
        function asPiece(cells) {
          var set = {};
          cells.forEach(function (q) { set[q] = true; });
          var has = function (k, j) { return k >= 0 && k < G.K && j >= 0 && j < G.J && set[k * G.J + j] === true; };
          var pc = pieceOf(G, has, 'outline'), R = bestRect(G, has, cells);
          if (R) {
            var rp = pieceOf(G, function (k, j) { return k >= R.ca && k <= R.cb && j >= R.ja && j < R.jb; }, 'rectangle');
            if (rp && (!pc || rp.n >= pc.n)) pc = rp;
          }
          return pc && pc.n >= 2 ? pc : null;
        }
        G.comps.forEach(function (cp) {
          /* the field's piece as its best rectangle, where that carries as
             many caps as its strips do (the coupon's leg: a ragged end
             column would split it); else its strips */
          var strips = stripsOf(G, cp.cells).map(asPiece).filter(Boolean), whole = null;
          var sum = 0;
          strips.forEach(function (q) { sum += q.n; });
          var set0 = {};
          cp.cells.forEach(function (q) { set0[q] = true; });
          var R0 = bestRect(G, function (k, j) { return k >= 0 && k < G.K && j >= 0 && j < G.J && set0[k * G.J + j] === true; }, cp.cells);
          if (R0) whole = pieceOf(G, function (k, j) { return k >= R0.ca && k <= R0.cb && j >= R0.ja && j < R0.jb; }, 'rectangle');
          (whole && whole.n >= 2 && whole.n >= sum ? [whole] : strips).forEach(function (pc) {
            Object.keys(pc.caps).forEach(function (i) { crossed[i] = true; });
            cellsTot += pc.areaCells;
            pc.snakeA.lines.forEach(function (l) { lineLen += l.hi - l.lo; lineN++; minLine = Math.min(minLine, (l.hi - l.lo) * o.pitch); });
            pieces.push(pc);
          });
        });
        return { angleDeg: phi, G: G, pieces: pieces, crossed: crossed, areaCells: cellsTot, minLineMm: minLine,
                 lineMm: lineN ? lineLen / lineN * o.pitch : 0, bare: live.filter(function (t) { return !crossed[t.i]; }).length };
      }
      var tried = (angleForced == null ? LINE_ANGLES : [angleForced]).map(sheetAt);
      var maxArea = Math.max.apply(null, tried.map(function (x) { return x.areaCells; }).concat([1]));
      tried.forEach(function (x) { x.droppedShare = 1 - x.areaCells / maxArea; });
      /* the fewest caps no line lies on, then the fewest pieces, then the
         fewest pieces that are not rectangles (the simplest loop that
         carries as much: the coupon's slab is one rectangle), then T's lines
         2 mm or longer (a piece three cells across has room for 0.84 mm
         lines one way only: T, three layers of four, takes the long way),
         then the most
         sheet (5 % bands), then the shorter line - A across a rectangle's short side, as
         Bambu's tree (13.6 mm lines in its 14.3 x 22.2 loop) - then the
         axes first; in bands, so a near tie goes to the axes and does not
         flip on a sample's rounding */
      var outlines = function (x) { return x.pieces.filter(function (q) { return q.kind !== 'rectangle'; }).length; };
      var order = tried.filter(function (x) { return x.pieces.length; }).sort(function (a, b) {
        var shortA = a.minLineMm < MIN_RUN_MM - 1e-9 ? 1 : 0, shortB = b.minLineMm < MIN_RUN_MM - 1e-9 ? 1 : 0;
        return (a.bare - b.bare) || (a.pieces.length - b.pieces.length) || (outlines(a) - outlines(b)) || (shortA - shortB) ||
               (Math.floor(a.droppedShare * 20) - Math.floor(b.droppedShare * 20)) ||
               (Math.round(a.lineMm) - Math.round(b.lineMm)) ||
               (LINE_ANGLES.indexOf(a.angleDeg) - LINE_ANGLES.indexOf(b.angleDeg));
      });
      var best = order[0];
      if (!best) return { ok: false, reason: 'no piece of 2 mm lines carries two caps of this level' };
      var uncrossed = live.filter(function (t) { return !best.crossed[t.i]; });
      if (live.length - uncrossed.length < 2) return { ok: false, reason: 'a sheet needs two caps its lines lie on; ' + (live.length - uncrossed.length) + ' here' };
      /* THE STACK: T1 and T2 the one layer (rails over the caps), I1 across
         them, I2 the rails again - every one in the same loops */
      var G = best.G, built = [];
      var pts = function (vs) { return vs.map(function (p) { return G.P(p[0], p[1]); }); };
      /* a loop's straight sides along A (or B), as segments */
      var segsAlong = function (loop, alongA) {
        var out = [];
        for (var i = 0; i + 1 < loop.length; i++) {
          var p = loop[i], q = loop[i + 1];
          if (alongA ? p[0] === q[0] : p[1] === q[1]) out.push([G.P(p[0], p[1]), G.P(q[0], q[1])]);
        }
        return out;
      };
      var plan = best.pieces.map(function (pc) {
        return { kind: pc.kind, loop: pts(pc.loop), snakeA: pts(pc.snakeA.path), snakeB: pts(pc.snakeB.path),
                 linesA: pc.snakeA.lines, linesB: pc.snakeB.lines, caps: pc.n,
                 sizeMm: [pc.size[0] * o.pitch, pc.size[1] * o.pitch], areaMm2: pc.areaCells * o.pitch * o.pitch, perimMm: pc.perimCells * o.pitch,
                 loopSegsA: segsAlong(pc.loop, true), loopSegsB: segsAlong(pc.loop, false) };
      });
      for (var lk = 0; lk < NL; lk++) {
        var alongA = lk !== 2, paths = [], segs = [], soups = [], nLines = 0, lineMm = 0, shortest = Infinity, loopMm = 0, pieces = [];
        for (var pi = 0; pi < plan.length; pi++) {
          var pc = plan[pi], lines = alongA ? pc.linesA : pc.linesB, snake = alongA ? pc.snakeA : pc.snakeB;
          lines.forEach(function (l) {
            var len = (l.hi - l.lo) * o.pitch;
            nLines++; lineMm += len; shortest = Math.min(shortest, len);
            segs.push(alongA ? [G.P(l.i, l.lo), G.P(l.i, l.hi)] : [G.P(l.lo, l.i), G.P(l.hi, l.i)]);
          });
          segs = segs.concat(alongA ? pc.loopSegsA : pc.loopSegsB);
          loopMm += pc.perimMm;
          paths.push(pc.loop, snake);
          pieces.push({ kind: pc.kind, sizeMm: pc.sizeMm, areaMm2: pc.areaMm2, perimMm: pc.perimMm, caps: pc.caps,
                        lines: lines.length, loop: pc.loop, snake: snake });
        }
        var bad = CH.oneDirection(segs);
        if (bad) return { ok: false, reason: 'layer ' + (lk + 1) + ': ' + bad };
        /* T1 sits on z_cap, each layer on the one below: faces meeting, no
           overlap (T2 is T1 again: an overlap would stand their walls in one
           plane for EPS_MM, which the union leaves as slivers) */
        var zb = zBase + lk * o.layer;
        for (var pj = 0; pj < plan.length; pj++) {
          /* a piece: its loop and its serpentine, a clear line width apart
             but at the bridge - one graph, one connected wall */
          var ex = RL.extrudeFlat([pieces[pj].loop, pieces[pj].snake], { width: o.width, height: o.layer, baseZ: zb });
          if (!ex.ok) return { ok: false, reason: 'layer ' + (lk + 1) + ', piece ' + (pj + 1) + ' would not extrude: ' + ex.reason };
          soups.push(ex.tris);
        }
        built.push({ role: SHEET_ROLES[lk], angleDeg: alongA ? best.angleDeg : (best.angleDeg + 90) % 180, z0: zb, z1: zb + o.layer,
                     pieces: pieces, loopMm: pieces[0].sizeMm.slice(), lines: nLines, linesMm: lineMm, lengthMm: loopMm + lineMm,
                     shortestMm: shortest, paths: paths, soup: joinSoups(soups) });
      }
      return { ok: true, zTop: zTop, zBase: zBase, zCap: zCap, layers: built, uncrossed: uncrossed,
               lines: { angleDeg: best.angleDeg, droppedShare: best.droppedShare, bare: best.bare, pieces: plan.length,
                        tried: tried.map(function (x) { return { angleDeg: x.angleDeg, droppedShare: x.droppedShare, bare: x.bare }; }) } };
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
          /* A TIP WHOSE CAP NO T LINE LIES ON (its top is beside a wall the
             sheet keeps off, or on no piece): if any line of the
             sheet passes over it, it stays cut at z_cap and carries nothing;
             if none does, it is cut at the gap line instead and holds the
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
            if (over) { t.carried = false; t.why = 'no T line lies on its cap; cut at z_cap under the sheet'; }
            else { t.mode = 'gap'; t.level = -1; t.cap = null; t.why = 'no line of the sheet reaches it'; }
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
      if (!L.ok) L.tips.forEach(function (t) { if (t.mode === 'sheet') { t.mode = 'gap'; t.level = -1; t.cap = null; t.why = 'its level failed: ' + L.reason; } });
      L.told = L.tips.length;
      told();
    });

    /* ===================================================================
       THE STAIR - a sheet under a curved or sloped underside
       (docs/SUPPORT-INTERFACE.md, section 7)
       ===================================================================
       A level is one z. An underside that slopes or curves has no single z:
       each of its tips is a level of its own, too narrow for a sheet, and
       was cut at the gap with nothing between. Bambu's tree builds a
       STAIRCASE OF RIBBONS there instead (Simple_Overhang_Test.gcode.3mf,
       tree slim, threshold 30: z 41.8 - 46.2), one per layer: a strip
       across the overhang's whole width, 1 - 4 lines wide along the slope,
       each layer's strip moved ~0.55 mm up the curve from the one below,
       so consecutive strips overlap and each rests on the one under it.

       WHICH TIPS. The tips whose level failed (one tip a level, or no
       piece of 2 mm lines), STAIR_JOIN tip spacings or nearer one another,
       at least STAIR_MIN_TIPS, their contacts on an underside whose fitted
       slope is STAIR_MIN_DEG - STAIR_MAX_DEG and spanning two layers or
       more. A flat ceiling's tips are all on levels that built, so a
       ceiling is never a stair: its sheet is the levels' (four layers,
       unchanged). A surface is flat where its strips at consecutive layers
       would coincide; that is what the levels already are.

       THE FRAME. A along the underside's level lines (perpendicular to its
       fitted fall), B up the slope.

       EACH LAYER'S STRIP is a BAND, laid where the gap puts it - not on a
       grid, so it moves with the curve a layer at a time (the arc: 0.2 -
       1.1 mm). The stair's layers are the slicer's (tops at plateZ + m x
       layerMm). At a layer, a raster cell is in the band's field where the
       column of the layer, from gap under its base to gap over its top,
       holds nothing of the piece (vertical rays, read as inside intervals
       from under the piece's box, so the inside of the arc is never air)
       nor any other support's column, and the underside lies within
       STAIR_REACH_MM over it (no strip runs out past the part's edge).
       Along A, every STAIR_DV, the band's front edge is the first u from
       down the slope where the field holds a line's width; the run of those
       longest along A is the band: ONE region.
       EACH STRIP covers the part's step over it (supports-stair-body: round
       3's top came loose - each strip advanced ~0.55 mm past the one below
       and Bambu printed its leading line in air; strips narrower than the
       part's step left its bars dashed): as wide as the next layer's
       advance and one line, at least two lines, so the next strip's
       down-slope line lies on this one's up-slope line. Its lines are the
       sheet's (o.width at o.pitch): two - a loop alone - or a loop and one
       serpentine inside it, tied to the loop at one point; kept to the
       part's outline and one line, the top strip covering all the part has
       left over it (spread, its loop's channel opening, where the outline
       holds it to fewer lines). A layer so steep that one line would stand
       its back edge further than STAIR_BACK_MM under the part is below the
       stair (the arc's foot, ~45 deg).

       WHAT HOLDS EACH STRIP. A strip lies over the strip below only in part
       (the arc: 0 - 0.34 mm along the slope); the rest - its leading part,
       up the slope - is held by TIPS, never by the stair's lean (0.55 mm a
       0.2 mm layer is ~70 deg off upright): wherever that part is half a
       line or wider, a tip every STAIR_TIP_MM or nearer along the strip
       (Bambu's branch distance; its own tree puts ~1.4 branch tops under
       each strip), each set a quarter stretch along from the strip
       below's, its column's down-slope face at the strip's front edge and
       its top the strip's underside. The tips are the stair's own tree:
       nso_support_gridpack.js plans them (opts.mergeThroughCrowd) and builds
       them with the stair, so the tree grows with the stair. The lowest
       strip stands on a transition (itself again, a layer under it), the
       transition on caps over the plan's tips under it (as the levels'
       caps: cut along their own legs, narrowed until each keeps the gap,
       never overlapping) and on tips of its own. Every other tip of the plan
       on the curve is not built (mode 'drop'): its spot is held by the
       stair, and the planner's members that hold only such tips are left
       out (nso_support_gridpack.js).

       THE GAP IS MEASURED: every band with exactDistance against the
       piece; one nearer than the gap moves up the slope (STAIR_STEP_MM at a
       time) and is built again.
       =================================================================== */
    function buildStairs() {
      var pool = tips.filter(function (t) { return t.mode === 'gap' && t.why && t.why.indexOf('its level failed') === 0 && columns[t.col]; });
      if (pool.length < STAIR_MIN_TIPS) return [];
      var par = pool.map(function (t, i) { return i; });
      function fd(i) { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; }
      for (var a = 0; a < pool.length; a++) for (var b = a + 1; b < pool.length; b++) {
        if (Math.hypot(pool[a].contact[0] - pool[b].contact[0], pool[a].contact[1] - pool[b].contact[1]) <= STAIR_JOIN * spacing + 1e-9) {
          var ra = fd(a), rb = fd(b);
          if (ra !== rb) par[Math.max(ra, rb)] = Math.min(ra, rb);
        }
      }
      var groups = {};
      pool.forEach(function (t, i) { var r = fd(i); (groups[r] = groups[r] || []).push(t); });
      var out = [];
      Object.keys(groups).map(Number).sort(function (x, y) { return x - y; }).forEach(function (k) {
        var st = stairOf(groups[k]);
        if (st) out.push(st);
      });
      return out;
    }

    function stairOf(group) {
      if (group.length < STAIR_MIN_TIPS) return null;
      var zs = group.map(function (t) { return t.contact[2]; });
      if (Math.max.apply(null, zs) - Math.min.apply(null, zs) < 2 * o.layer) return null;
      /* the underside's fall: the plane through the contacts, least squares */
      var S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], R = [0, 0, 0], cx = 0, cy = 0;
      group.forEach(function (t) { cx += t.contact[0] / group.length; cy += t.contact[1] / group.length; });
      group.forEach(function (t) {
        var v = [t.contact[0] - cx, t.contact[1] - cy, 1];
        for (var i = 0; i < 3; i++) { R[i] += v[i] * t.contact[2]; for (var j = 0; j < 3; j++) S[i][j] += v[i] * v[j]; }
      });
      var det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
      if (!(Math.abs(det) > 1e-9)) return null;
      var ga = (R[0] * S[1][1] - R[1] * S[0][1]) / det, gb = (S[0][0] * R[1] - S[1][0] * R[0]) / det, gn = Math.hypot(ga, gb);
      var slopeDeg = Math.atan(gn) * 180 / Math.PI;
      if (!(slopeDeg >= STAIR_MIN_DEG && slopeDeg <= STAIR_MAX_DEG)) return null;
      var e = [ga / gn, gb / gn];
      var phi = Math.round(((Math.atan2(-e[0], e[1]) * 180 / Math.PI) + 360) % 360 * 100) / 100;
      /* a fall within STAIR_SNAP_DEG of one of the sheet's line angles takes it (the arc's: 0.34 -> 0) */
      LINE_ANGLES.concat(LINE_ANGLES.map(function (x) { return x + 180; }), [360]).forEach(function (x) {
        if (Math.abs(phi - x) <= STAIR_SNAP_DEG) phi = x % 360;
      });
      var th = phi * Math.PI / 180, F = { phi: phi, dir: [Math.cos(th), Math.sin(th)], nrm: [-Math.sin(th), Math.cos(th)] };
      function uOf(p) { return p[0] * F.nrm[0] + p[1] * F.nrm[1]; }
      function vOf(p) { return p[0] * F.dir[0] + p[1] * F.dir[1]; }
      function atUV(u, v) { return [u * F.nrm[0] + v * F.dir[0], u * F.nrm[1] + v * F.dir[1]]; }

      /* the raster: every cell's inside intervals along its vertical ray */
      var mine = {};
      group.forEach(function (t) { mine[t.i] = true; });
      /* the field keeps half a line off any column the piece stands in (a
         line's square end, half a width times root 2, is the exact solve's
         to hold): the column already
         holds the gap over and under the layer, and the exact solve below
         holds the gap itself (a level's raster grows by the gap as well, for
         its walls; under a slope that set every strip a further gap's run
         up it) */
      var D = H + 1, r = CELL_MM * Math.SQRT1_2 + 1e-3, pad = D + r + o.gap + 2 * CELL_MM;
      var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      group.forEach(function (t) { for (var k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], t.contact[k]); hi[k] = Math.max(hi[k], t.contact[k]); } });
      var ox = lo[0] - pad, oy = lo[1] - pad;
      var nx = Math.ceil((hi[0] - lo[0] + 2 * pad) / CELL_MM) + 1, ny = Math.ceil((hi[1] - lo[1] + 2 * pad) / CELL_MM) + 1;
      var iv = new Array(nx * ny), near = new Uint8Array(nx * ny);
      for (var j0 = 0; j0 < ny; j0++) {
        beat();
        for (var i0 = 0; i0 < nx; i0++) {
          var x = ox + i0 * CELL_MM, y = oy + j0 * CELL_MM, list = [];
          for (var pi = 0; pi < PPs.length; pi++) {
            var P = PPs[pi];
            if (x < P.lo[0] || x > P.hi[0] || y < P.lo[1] || y > P.hi[1]) continue;
            var z0 = P.lo[2] - 1, hs = P.hitsAlong([x, y, z0], [0, 0, 1], P.hi[2] - P.lo[2] + 2);
            for (var h = 0; h + 1 < hs.length; h += 2) list.push(z0 + hs[h], z0 + hs[h + 1]);
          }
          iv[j0 * nx + i0] = list;
          for (var g = 0; g < group.length; g++) {
            if (Math.abs(group[g].contact[0] - x) <= D && Math.abs(group[g].contact[1] - y) <= D) { near[j0 * nx + i0] = 1; break; }
          }
        }
      }
      /* the columns the stair keeps off: every member of a tree that holds a
         tip outside this stair (a tree of the stair's tips alone is cut
         under its lowest strip, or left out) */
      var treeOthers = {};
      tips.forEach(function (t) { var cl = columns[t.col]; if (!mine[t.i] && cl && cl.tree != null) treeOthers[cl.tree] = true; });
      var foreign = [];
      columns.forEach(function (cl, ci) {
        if (!cl || !cl.pts || !cl.pts.length) return;
        var tt = tipOfCol[ci];
        if (tt && mine[tt.i]) return;
        if (cl.tree != null && !treeOthers[cl.tree] && !tt) return;
        foreign.push(cl);
      });
      var R0 = Math.ceil(r / CELL_MM), disc = [];
      for (var dj = -R0; dj <= R0; dj++) for (var di = -R0; di <= R0; di++) if (Math.hypot(di, dj) * CELL_MM <= r) disc.push([di, dj]);
      var zTopOf = function (m) { return o.plateZ + m * o.layer; };
      /* the field of the layer whose top is zTopOf(m): see EACH LAYER'S STRIP */
      function fieldFor(m, extra) {
        var zt = zTopOf(m), za = zt - o.layer - o.gap, zb = zt + o.gap, n = nx * ny;
        var blk = new Uint8Array(n), fld = new Uint8Array(n);
        for (var q = 0; q < n; q++) {
          var L = iv[q], ce = Infinity;
          for (var k = 0; k + 1 < L.length; k += 2) {
            if (L[k] < zb && L[k + 1] > za) { blk[q] = 1; break; }
            if (L[k] >= zb && L[k] < ce) ce = L[k];
          }
          if (!blk[q] && ce - zb <= STAIR_REACH_MM) fld[q] = 1;
        }
        for (var q2 = 0; q2 < n; q2++) {
          if (!blk[q2]) continue;
          var ci = q2 % nx, cj = (q2 - ci) / nx;
          if (ci > 0 && ci < nx - 1 && cj > 0 && cj < ny - 1 && blk[q2 - 1] && blk[q2 + 1] && blk[q2 - nx] && blk[q2 + nx]) continue;
          for (var d = 0; d < disc.length; d++) {
            var ii = ci + disc[d][0], jj = cj + disc[d][1];
            if (ii >= 0 && ii < nx && jj >= 0 && jj < ny) fld[jj * nx + ii] = 0;
          }
        }
        function stamp(a, b, rad) {
          var i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - rad - ox) / CELL_MM)), i1 = Math.min(nx - 1, Math.ceil((Math.max(a[0], b[0]) + rad - ox) / CELL_MM));
          var j0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - rad - oy) / CELL_MM)), j1 = Math.min(ny - 1, Math.ceil((Math.max(a[1], b[1]) + rad - oy) / CELL_MM));
          for (var jy = j0; jy <= j1; jy++) for (var ix = i0; ix <= i1; ix++) {
            if (segDist2([ox + ix * CELL_MM, oy + jy * CELL_MM], a, b) <= rad) fld[jy * nx + ix] = 0;
          }
        }
        foreign.forEach(function (cl) {
          var rad = cl.side * Math.SQRT1_2 + COLUMN_CLEAR_MM + o.width / 2 + CELL_MM, p = cl.pts;
          for (var k = 0; k < p.length; k++) {
            var A = p[k], B = p[Math.min(k + 1, p.length - 1)];
            if (Math.max(A[2], B[2]) + cl.side < za || Math.min(A[2], B[2]) - cl.side > zb) continue;
            stamp(A, B, rad);
          }
        });
        (extra || []).forEach(function (eb) { stamp(eb, eb, eb[2]); });
        return fld;
      }
      function fieldAt(fld, x, y) {
        var i = Math.round((x - ox) / CELL_MM), j = Math.round((y - oy) / CELL_MM);
        return i >= 0 && i < nx && j >= 0 && j < ny && fld[j * nx + i] === 1;
      }
      /* the frame's extent over the raster */
      var umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
      [[ox, oy], [ox + nx * CELL_MM, oy], [ox, oy + ny * CELL_MM], [ox + nx * CELL_MM, oy + ny * CELL_MM]].forEach(function (c) {
        umin = Math.min(umin, uOf(c)); umax = Math.max(umax, uOf(c)); vmin = Math.min(vmin, vOf(c)); vmax = Math.max(vmax, vOf(c));
      });
      var DU = CELL_MM / 2, bead = TH.floorFor(opts.nozzle);
      /* A LAYER'S BAND: along the stair's level lines, every STAIR_DV, the
         first u from down the slope where the field holds a line's width -
         its front edge. The run of those that follow on from one another
         (no jump over STAIR_JUMP_MM) longest along A is the band: one
         region, laid where the gap puts it, not on a grid. */
      function bandOf(fld) {
        var pts = [];
        for (var v = vmin; v <= vmax + 1e-9; v += STAIR_DV) {
          var f = null;
          for (var u = umin; u <= umax - o.width; u += DU) {
            var p = atUV(u, v), q = atUV(u + o.width, v);
            if (fieldAt(fld, p[0], p[1]) && fieldAt(fld, q[0], q[1]) && fieldAt(near, p[0], p[1])) { f = u; break; }
          }
          pts.push({ v: v, f: f });
        }
        var best = null, cur = [];
        pts.concat([{ v: Infinity, f: null }]).forEach(function (pt) {
          if (pt.f != null && cur.length && Math.abs(pt.f - cur[cur.length - 1].f) <= STAIR_JUMP_MM) { cur.push(pt); return; }
          if (cur.length && (!best || cur.length > best.length)) best = cur;
          cur = pt.f != null ? [pt] : [];
        });
        if (!best || (best.length - 1) * STAIR_DV < MIN_RUN_MM) return null;
        return { pts: best, v0: best[0].v, v1: best[best.length - 1].v, len: (best.length - 1) * STAIR_DV };
      }
      function frontAt(bd, v) {
        if (!bd || v < bd.v0 - 1e-9 || v > bd.v1 + 1e-9) return null;
        var k = Math.min(bd.pts.length - 1, Math.max(0, Math.round((v - bd.v0) / STAIR_DV)));
        return bd.pts[k].f + (bd.shift || 0);
      }

      /* every layer the stair's tips span, and two under */
      var zMin = Math.min.apply(null, zs), zMax = Math.max.apply(null, zs);
      var mA = Math.floor((zMin - 2) / o.layer), mB = Math.ceil((zMax + STAIR_REACH_MM) / o.layer);
      var lay = {}, longest = 0;
      for (var m = mA; m <= mB; m++) {
        beat();
        lay[m] = { m: m, fld: fieldFor(m, null) };
        lay[m].band = bandOf(lay[m].fld);
        if (lay[m].band) longest = Math.max(longest, lay[m].band.len);
      }
      /* does layer m's band (a mm round it across the slope) hold point p? */
      function bandHolds(m, p, W, a) {
        var f = frontAt(lay[m] && lay[m].band, vOf(p));
        return f != null && uOf(p) >= f - a && uOf(p) <= f + W + a;
      }
      /* THE STAIR'S START: the lowest layer whose band runs at least
         STAIR_START of the longest band's length and holds a tip; it runs up
         while every layer has a band. A tip's layer is the lowest of the
         stair's whose band holds it. */
      var mLo = Infinity;
      for (var ml = mA; ml <= mB && !isFinite(mLo); ml++) {
        if (lay[ml].band && lay[ml].band.len >= STAIR_START * longest &&
            group.some(function (t) { return bandHolds(ml, t.contact, o.width, 1); })) mLo = ml;
      }
      if (!isFinite(mLo)) return null;
      var mTop = mLo;
      for (var m3 = mLo + 1; m3 <= mB && lay[m3].band; m3++) mTop = m3;
      if (mTop - mLo + 1 < 2) return null;
      /* where the slope is so steep that even one line stands its back edge
         further than STAIR_BACK_MM under the part, the stair has not begun
         (the arc's foot, ~45 deg: a line there is 0.6 - 0.8 mm under it) -
         the part rises (layer / advance) for every mm up the slope, the
         advance being how far the band moves a layer */
      function medianAdvance(m) {
        var M2 = m < mTop ? m + 1 : m - 1, d = [];
        lay[m].band.pts.forEach(function (pt) { var f2 = frontAt(lay[M2].band, pt.v); if (f2 != null) d.push(Math.abs(f2 - pt.f)); });
        d.sort(function (x, y) { return x - y; });
        return d.length ? Math.max(d[d.length >> 1], DU) : o.layer;
      }
      function lineFits(m) { return (STAIR_BACK_MM - o.gap) * medianAdvance(m) / o.layer >= o.width - 1e-9; }
      while (mTop - mLo + 1 > 2 && !lineFits(mLo)) mLo++;
      /* EACH STRIP (supports-stair-body) is as wide as the part's step over
         it - the next layer's advance - and one line (a bead), and at least
         two lines, so the next strip's down-slope line lies on this one's
         up-slope line. Its lines are the sheet's (o.width at o.pitch): two -
         a loop alone - or a loop and one serpentine inside it, tied to the
         loop at one point. A strip keeps to the part's outline and one line:
         the top strip covers all the part has left over it, and one the
         outline holds to fewer lines spreads them, its loop's channel
         opening. The advance is the 90th percentile of the band's, line by
         line along it (the top layer takes the one under). */
      function advanceAt(m) {
        var M2 = m < mTop ? m + 1 : m - 1, d = [];
        lay[m].band.pts.forEach(function (pt) {
          var f2 = frontAt(lay[M2].band, pt.v), f1 = frontAt(lay[m].band, pt.v);
          if (f2 != null && f1 != null) d.push(m < mTop ? f2 - f1 : f1 - f2);
        });
        d.sort(function (x, y) { return x - y; });
        return d.length ? Math.max(d[Math.min(d.length - 1, Math.floor(0.9 * d.length))], DU) : o.layer;
      }
      function widthOf(n, pt) { return (n - 1) * (pt || o.pitch) + o.width; }
      /* how far the part runs on over a band, up the slope from its front:
         the median, along it, of the field's run from the front (the field
         ends where the part over it does, a cell either side) */
      function roomAt(m) {
        var bd = lay[m].band, r = [];
        bd.pts.forEach(function (pt) {
          var f = pt.f + (bd.shift || 0), u = f;
          while (u + DU <= umax && fieldAt(lay[m].fld, atUV(u + DU, pt.v)[0], atUV(u + DU, pt.v)[1])) u += DU;
          r.push(u - f + CELL_MM);
        });
        r.sort(function (x, y) { return x - y; });
        return r.length ? r[r.length >> 1] : 0;
      }
      function planWidth(m) {
        var a = advanceAt(m), room = roomAt(m) + bead, need = m === mTop ? room : a + bead, n = 2;
        while (widthOf(n) < need - 1e-9 && widthOf(n + 1) <= room + 1e-9) n++;
        var pt = o.pitch;
        if (widthOf(n) < need - 1e-9) pt = (Math.min(need, Math.max(room, widthOf(n))) - o.width) / (n - 1);
        return { n: n, pitch: pt, W: widthOf(n, pt), a: a };
      }
      /* a strip built: its loop round the band's outline and, from three lines
         up, the serpentine inside it, both centrelines o.width / 2 in from the
         outline; the serpentine starts on the loop's down-v end (the tie) and
         keeps a pitch off the loop everywhere else */
      function stripBuild(m, z0, role, wd) {
        var bd = lay[m].band, sh = bd.shift || 0, hw = o.width / 2, n = wd.n, pt = wd.pitch, W = wd.W;
        var va = bd.v0 + hw, vb = bd.v1 - hw;
        if (!(vb - va > 2 * pt)) return { ok: false, reason: 'the band is too short for its loop' };
        var vs = [va];
        bd.pts.forEach(function (q) { if (q.v > va + 1e-6 && q.v < vb - 1e-6) vs.push(q.v); });
        vs.push(vb);
        function at(k, v) { return atUV(frontAt(bd, v) + sh + hw + k * pt, v); }
        function thin(poly) {
          for (var k = poly.length - 2; k >= 1; k--) if (segDist2(poly[k], poly[k - 1], poly[k + 1]) < 0.01) poly.splice(k, 1);
          return poly;
        }
        var front = thin(vs.map(function (v) { return at(0, v); }));
        var back = thin(vs.map(function (v) { return at(n - 1, v); }).reverse());
        /* the loop's down-v end, back to front, through each serpentine line's foot */
        var foot = [];
        for (var k = n - 2; k >= 1; k--) foot.push(at(k, va));
        var loop = front.concat(back, foot, [front[0]]);
        var paths = [loop], snake = null;
        if (n >= 3) {
          var lo = va + pt, hi = vb - pt, vi = vs.filter(function (v) { return v > lo + 1e-6 && v < hi - 1e-6; });
          snake = [at(1, va)];
          for (var k2 = 1; k2 <= n - 2; k2++) {
            var run = [lo].concat(vi, [hi]);
            if (k2 % 2 === 0) run.reverse();
            run.forEach(function (v) { snake.push(at(k2, v)); });
          }
          snake = thin(snake);
          paths.push(snake);
        }
        var ex = RL.extrudeFlat(paths, { width: o.width, height: o.layer, baseZ: z0 });
        if (!ex.ok) return { ok: false, reason: 'it would not extrude: ' + ex.reason };
        return { ok: true, soup: ex.tris, layer: { role: role, angleDeg: phi, z0: z0, z1: z0 + o.layer,
                 pieces: [{ kind: 'strip', sizeMm: [bd.len, W], areaMm2: bd.len * W, perimMm: 2 * (bd.len + W), caps: 0, lines: n, loop: loop, snake: snake }],
                 loopMm: [bd.len, W], lines: n, linesMm: n * bd.len, lengthMm: n * bd.len, shortestMm: bd.len,
                 paths: paths, widthMm: W, beads: n, pitchMm: pt, advanceMm: wd.a } };
      }
      /* THE GAP, MEASURED: against the piece's triangles near the stair (each
         measure boxes every triangle it is handed); a strip nearer than the gap
         moves up the slope, a step at a time, and is built again */
      var reachG = o.gap + 0.1, built = {}, minD = Infinity;
      var zLoC = zTopOf(mA) - 3 * o.layer - o.capRise - 1, zHiC = zTopOf(mB) + 1;
      var nearSoups = obstacles.map(function (B) {
        var keep = [];
        for (var i = 0; i < B.length; i += 9) {
          var bx0 = Math.min(B[i], B[i + 3], B[i + 6]), bx1 = Math.max(B[i], B[i + 3], B[i + 6]);
          var by0 = Math.min(B[i + 1], B[i + 4], B[i + 7]), by1 = Math.max(B[i + 1], B[i + 4], B[i + 7]);
          var bz0 = Math.min(B[i + 2], B[i + 5], B[i + 8]), bz1 = Math.max(B[i + 2], B[i + 5], B[i + 8]);
          if (bx1 < ox - 1 || bx0 > ox + nx * CELL_MM + 1 || by1 < oy - 1 || by0 > oy + ny * CELL_MM + 1 || bz1 < zLoC || bz0 > zHiC) continue;
          for (var k = 0; k < 9; k++) keep.push(B[i + k]);
        }
        return new Float32Array(keep);
      }).filter(function (B) { return B.length >= 9; });
      function nearest(soup) {
        var dmin = Infinity;
        nearSoups.forEach(function (B) { dmin = Math.min(dmin, exactDistance(soup, B, reachG, beat).mm); });
        return dmin;
      }
      function solveStrip(m, z0, role, wd) {
        for (var it = 0; it < 16; it++) {
          var b = stripBuild(m, z0, role, wd);
          if (!b.ok) return b;
          var d = nearest(b.soup);
          if (d >= o.gap - 1e-5) { b.minMm = d; return b; }
          lay[m].band.shift = (lay[m].band.shift || 0) + Math.max(STAIR_STEP_MM, o.gap - d);
        }
        return { ok: false, reason: 'the gap would not hold at z ' + (z0 + o.layer).toFixed(2) };
      }
      /* the top: no strip runs past the part's outline and one line */
      while (mTop - mLo + 1 > 2 && widthOf(2) > roomAt(mTop) + bead + 1e-9) mTop--;
      /* the strips: built, the gap solved (a band moves up the slope), and
         their widths read again from where the bands now lie - twice */
      var widths = {};
      for (var pass = 0; pass < 2; pass++) {
        var was = JSON.stringify(widths), short = false;
        for (var m4 = mLo; m4 <= mTop; m4++) widths[m4] = planWidth(m4);
        if (pass && JSON.stringify(widths) === was) break;
        for (var m5 = mLo; m5 <= mTop; m5++) {
          var sv = solveStrip(m5, zTopOf(m5) - o.layer, 'interface', widths[m5]);
          if (!sv.ok) { if (m5 - mLo >= 2) { mTop = m5 - 1; short = true; break; } return null; }
          built[m5] = sv;
        }
        if (short) for (var m6 = mLo; m6 <= mTop; m6++) widths[m6] = planWidth(m6);
      }
      for (var m7 = mLo; m7 <= mTop; m7++) {
        if (!built[m7] || built[m7].layer.beads !== widths[m7].n || Math.abs(built[m7].layer.pitchMm - widths[m7].pitch) > 1e-9) {
          var sv2 = solveStrip(m7, zTopOf(m7) - o.layer, 'interface', widths[m7]);
          if (!sv2.ok) return null;
          built[m7] = sv2;
        }
        minD = Math.min(minD, built[m7].minMm);
      }
      /* the transition: the lowest strip again, one layer under it */
      var zCap = zTopOf(mLo) - 2 * o.layer;
      var tb = stripBuild(mLo, zCap, 'transition', widths[mLo]);
      if (!tb.ok) return null;
      var dT = nearest(tb.soup);
      if (!(dT >= o.gap - 1e-5)) return null;
      minD = Math.min(minD, dT);
      /* WHAT HOLDS EACH STRIP UP. A strip rests on the strip below where it
         lies over it; the rest of it - its leading part, up the slope, half a
         line or more wide - is held by a tip: every STAIR_TIP_MM or nearer
         along it, its column's down-slope face at the strip's front edge (so
         its top keeps the gap where the part comes lowest), its top the
         strip's underside. The tips are planned as a tree of their own
         (nso_support_gridpack.js), so the tree grows with the stair: the
         stair's lean is never what holds it. The lowest strip stands on its
         transition and the caps under it. */
      var want = [], restMm = {};
      /* where along a band its tips go: STAIR_TIP_MM apart or nearer, each
         holding the stretch of band round it (a band L long has ceil(L /
         STAIR_TIP_MM) tips, at the middles of equal stretches: 2 on the
         arc's 9.75 mm), the next strip's set a quarter stretch along, the
         one after a quarter back - so a column does not stand straight over
         the one a layer below it (Bambu's own: ~1.4 tops a strip, 5 mm apart) */
      function tipVs(bd, m) {
        var nT = Math.max(1, Math.ceil(bd.len / STAIR_TIP_MM - 1e-9)), step = bd.len / nT, sh2 = [0, 0.25, 0, -0.25][m % 4] * step, out = [];
        for (var k = 0; k < nT; k++) out.push(Math.min(bd.v1 - o.side / 2, Math.max(bd.v0 + o.side / 2, bd.v0 + (k + 0.5) * step + sh2)));
        return out;
      }
      for (var m6 = mLo; m6 <= mTop; m6++) {
        var bd6 = lay[m6].band, W6 = widths[m6].W, Wb = m6 > mLo ? widths[m6 - 1].W : 0, rs = [];
        var under = m6 > mLo ? lay[m6 - 1].band : null;
        bd6.pts.forEach(function (pt) {
          var fb = frontAt(under, pt.v);
          rs.push(fb == null ? 0 : Math.max(0, Math.min(fb + Wb, pt.f + (bd6.shift || 0) + W6) - Math.max(fb, pt.f + (bd6.shift || 0))));
        });
        rs.sort(function (x, y) { return x - y; });
        restMm[m6] = rs[rs.length >> 1];
        /* the lowest strip stands on its transition, the transition on the
           carriers' caps and on tips of its own */
        var zt = m6 === mLo ? zTopOf(mLo) - 2 * o.layer : zTopOf(m6) - o.layer;
        tipVs(bd6, m6 - mLo).forEach(function (v) {
          var f = frontAt(bd6, v), fb2 = frontAt(under, v);
          var lo2 = fb2 == null ? f : Math.max(f, fb2 + Wb), hi2 = f + W6;
          /* a strip whose leading part (the median along it) is half a line
             or wider has every tip, set where the part narrows at least half
             a line in from its back edge */
          if (hi2 - lo2 < o.width / 2) { if (W6 - restMm[m6] < o.width / 2) return; lo2 = hi2 - o.width / 2; }
          var c = Math.max((lo2 + hi2) / 2, f + o.side / 2), xy = atUV(c, v);
          want.push({ p: [xy[0], xy[1], zt], strip: m6 });
        });
      }
      /* THE CARRIERS of the lowest strip: the tips under it (a mm round its
         band), each with its cap at z_cap */
      var carriers = group.filter(function (t) { return bandHolds(mLo, t.contact, widths[mLo].W, 1); });
      if (!carriers.length) return null;
      carriers.forEach(function (t) {
        var pts = columns[t.col].pts;
        t.top = colAxisAt(pts, zCap); t.capFoot = colAxisAt(pts, zCap - o.capRise);
      });
      carriers.forEach(function (t) {
        var nnTop = Infinity;
        carriers.forEach(function (u) { if (u !== t) nnTop = Math.min(nnTop, Math.hypot(u.top[0] - t.top[0], u.top[1] - t.top[1])); });
        var w = Math.min(o.capMax, Math.max(o.capMin, nnTop - CAP_SPACE_MM));
        t.cap = { c: t.top.slice(), b: t.capFoot.slice(), w: w, z0: zCap - o.capRise, z1: zCap, footD: CAP_FOOT * o.side, band: CAP_BAND_MM, nnMm: nnTop, why: null, slidMm: 0 };
      });
      /* caps never overlap (THE CAPS) */
      for (var pass2 = 0, moved = true; moved && pass2 < 8; pass2++) {
        moved = false;
        for (var ia = 0; ia < carriers.length; ia++) for (var ib = ia + 1; ib < carriers.length; ib++) {
          var CA = carriers[ia].cap, CB = carriers[ib].cap, dd = Math.hypot(CA.c[0] - CB.c[0], CA.c[1] - CB.c[1]) - CAP_PART_MM;
          if ((CA.w + CB.w) / 2 <= dd + 1e-9) continue;
          var span = Math.max(dd, 0);
          if (CA.w <= span) CB.w = 2 * span - CA.w; else if (CB.w <= span) CA.w = 2 * span - CB.w; else { CA.w = span; CB.w = span; }
          CA.why = CB.why = 'held short of a neighbour ' + (dd + CAP_PART_MM).toFixed(2) + ' mm away'; moved = true;
        }
      }
      /* every cap measured, narrowed until it keeps the gap */
      carriers.forEach(function (t) {
        for (var it2 = 0; it2 < 16 && t.cap; it2++) {
          if (t.cap.w <= o.side + 1e-9) { t.cap = null; break; }
          var hull = capHull(t.cap), bad = false;
          nearSoups.forEach(function (B) { if (!bad && exactDistance(hull, B, o.gap + 0.1, beat, o.gap - 1e-5).under.length) bad = true; });
          if (!bad) break;
          t.cap.w = Math.max(o.side, t.cap.w - CAP_STEP_MM); t.cap.why = 'narrowed off the piece (measured)';
        }
        if (t.cap && t.cap.w <= o.side + 1e-9) t.cap = null;
        if (!t.cap) { var cp = cutPath(columns[t.col].pts, zCap, o.side, o.side); t.top = [cp[0][0], cp[0][1]]; t.capWhy = 'no room for a cap: the column\'s own top'; }
        else t.capWhy = t.cap.why;
      });
      /* a carrier with no cap stands its bare top at z_cap: measured too, and
         one nearer the piece than the gap carries nothing */
      carriers = carriers.filter(function (t) {
        if (t.cap) return true;
        var d2 = o.side * Math.SQRT2, hull = capHull({ c: t.top, b: t.top, w: d2, footD: d2, z0: zCap - o.side, z1: zCap, band: 0 }), bad = false;
        nearSoups.forEach(function (B) { if (!bad && exactDistance(hull, B, o.gap + 0.1, beat, o.gap - 1e-5).under.length) bad = true; });
        return !bad;
      });
      if (!carriers.length) return null;
      /* the lowest strip's own tips keep off its carriers' caps and tops */
      want = want.filter(function (w) {
        if (w.strip !== mLo) return true;
        return carriers.every(function (t) {
          var r0 = (t.cap ? t.cap.w / 2 : o.side * Math.SQRT1_2) + o.side * Math.SQRT1_2 + CAP_PART_MM;
          return Math.hypot(w.p[0] - t.top[0], w.p[1] - t.top[1]) > r0;
        });
      });
      /* each tip's layer: the lowest strip of the stair whose band holds it */
      group.forEach(function (t) {
        t.stairM = null;
        for (var m7 = mLo; m7 <= mTop; m7++) if (bandHolds(m7, t.contact, widths[m7].W, 1)) { t.stairM = m7; break; }
      });
      /* the stair, as a level: its layers bottom up, the transition first */
      var layers = [tb.layer];
      tb.layer.soup = tb.soup;
      for (var m8 = mLo; m8 <= mTop; m8++) {
        var Ly = built[m8].layer;
        Ly.soup = built[m8].soup; Ly.overlapMm = m8 > mLo ? restMm[m8] : null; Ly.minDistanceMm = built[m8].minMm;
        Ly.tips = want.filter(function (w) { return w.strip === m8; }).length;
        layers.push(Ly);
      }
      var zTopStair = zTopOf(mTop);
      var held = group.filter(function (t) { return carriers.indexOf(t) < 0; });
      return { group: group, carriers: carriers, held: held, zCap: zCap, zBase: zCap, zTop: zTopStair, layers: layers, minD: minD,
               lines: { angleDeg: phi, stair: true, slopeDeg: slopeDeg, droppedShare: 0, bare: 0, pieces: layers.length, tried: [] },
               stair: { slopeDeg: slopeDeg, angleDeg: phi, mLo: mLo, mTop: mTop, strips: mTop - mLo + 1, topMm: zTopStair,
                        tips: want.map(function (w) { return { p: w.p, strip: w.strip - mLo }; }),
                        cutAbove: group.filter(function (t) { return t.stairM != null && t.stairM > mTop; }).length } };
    }

    var stairsBuilt = opts.stairs === false ? [] : buildStairs();
    stairsBuilt.forEach(function (st) {
      var L = { id: levels.length, first: st.zTop, tips: st.carriers, told: st.carriers.length, ok: true, stair: st,
                res: { zTop: st.zTop, zBase: st.zBase, zCap: st.zCap, layers: st.layers, lines: st.lines }, minDistanceMm: st.minD };
      levels.push(L);
      st.carriers.forEach(function (t) { t.mode = 'sheet'; t.level = L.id; t.why = null; t.carried = true; });
      /* the tips above where the stair ends stay cut at the gap - unless that
         cut would stand in a strip (a stair cut short under them), when the
         stair holds them as well; the rest the stair holds */
      st.held.forEach(function (t) {
        if (t.stairM != null && t.stairM <= st.stair.mTop) {
          t.mode = 'drop'; t.level = L.id; t.cap = null; t.why = 'held by the stair: its strip rests on the strip below';
          return;
        }
        if (t.stairM == null) return;
        var top = cutPath(columns[t.col].pts, t.zu - o.gap, o.side)[0];
        var hits = st.layers.some(function (Ly) {
          if (Ly.z0 > top[2]) return false;
          var reachTip = o.side * Math.SQRT1_2 + Ly.widthMm / 2 + 0.05;
          return Ly.paths.some(function (pth) {
            for (var q = 0; q + 1 < pth.length; q++) if (segDist2(top, pth[q], pth[q + 1]) <= reachTip) return true;
            return false;
          });
        });
        if (hits) { t.mode = 'drop'; t.level = L.id; t.cap = null; t.why = 'held by the stair: its cut would stand in a strip under it'; }
      });
    });

    /* the cut heights: a capped tip along its own leg, inside its cap (rise
       0: no upright run); an uncapped one flat at z_cap; a gap tip flat, the
       gap under the part */
    tips.forEach(function (t) {
      if (t.mode === 'sheet') {
        var L = levels[t.level];
        t.zTop = L.res.zTop; t.zBase = L.res.zBase;
        t.cutZ = t.cap ? L.res.zCap - sink : L.res.zCap;
        t.rise = t.cap ? 0 : o.side;
      } else if (t.mode === 'gap') {
        if (t.zu == null) t.zu = t.contact[2];
        t.cutZ = t.zu - o.gap; t.cap = null;
      }
    });
    var lv = levels.filter(function (L) { return L.ok; }).map(function (L) {
      var mineTips = L.tips.filter(function (t) { return t.mode === 'sheet'; });
      var out = { id: L.id, zTop: L.res.zTop, zBase: L.res.zBase, zCap: L.res.zCap, tips: mineTips.map(function (t) { return t.i; }),
               caps: mineTips.filter(function (t) { return t.cap; }).map(function (t) { return { tip: t.i, c: t.cap.c, w: t.cap.w, nnMm: t.cap.nnMm }; }),
               layers: L.res.layers, lines: L.res.lines, minDistanceMm: L.minDistanceMm, solvedDropMm: L.solvedDropMm || 0 };
      /* a stair: the tips it holds by itself, and its shape */
      if (L.stair) {
        out.stair = L.stair.stair;
        out.held = tips.filter(function (t) { return t.mode === 'drop' && t.level === L.id; }).map(function (t) { return t.i; });
      }
      return out;
    });
    var counts = { sheet: 0, gap: 0, side: 0, caps: 0, drop: 0 };
    tips.forEach(function (t) { counts[t.mode]++; if (t.mode === 'sheet' && t.cap) counts.caps++; });
    return {
      ok: true, gapMm: o.gap, layerMm: o.layer, widthMm: o.width, pitchMm: o.pitch, epsMm: o.eps, tipSpacingMm: spacing,
      cap: { riseMm: o.capRise, minMm: o.capMin, maxMm: o.capMax, gapMaxMm: CAP_GAP_MAX_MM, tuckMm: CAP_TUCK_MM, foot: CAP_FOOT },
      levels: lv, failed: levels.filter(function (L) { return !L.ok; }).map(function (L) { return { id: L.id, zTop: L.first, reason: L.reason }; }),
      tips: tips.map(function (t) {
        var cap = t.mode === 'sheet' && t.cap ? { c: t.cap.c, b: t.cap.b, w: t.cap.w, z0: t.cap.z0, z1: t.cap.z1, footD: t.cap.footD, band: t.cap.band, why: t.cap.why } : null;
        return { i: t.i, label: t.label, beacon: t.beacon, col: t.col, mode: t.mode, level: t.level, carried: t.mode === 'sheet' ? t.carried !== false : null,
                 zTop: t.zTop, zBase: t.zBase, cutZ: t.cutZ, rise: t.mode === 'sheet' ? t.rise : null, cap: cap,
                 why: t.why || (t.mode === 'sheet' && !t.cap ? t.capWhy : null) || null };
      }),
      counts: counts,
      reason: (function () {
        var nSt = lv.filter(function (L) { return L.stair; }), nFl = lv.length - nSt.length;
        return nFl + ' sheet(s) of 4 layers (2 transition, 2 interface), each a loop and a serpentine, at ' + o.pitch + ' mm' +
          (nSt.length ? ', ' + nSt.length + ' stair(s) of ' + nSt.map(function (L) { return L.stair.strips; }).join(' + ') + ' strips' : '') +
          ' on ' + counts.caps + ' cap(s) over ' + counts.sheet +
          ' tip(s); ' + (counts.drop ? counts.drop + ' tip(s) held by a stair, ' : '') + counts.gap + ' tip(s) cut at the gap, ' + counts.side + ' side tip(s) held off the face';
      })(),
      probe: { nearest: nearestMm }
    };
  }

  /* A column (top first) cut flat at cutZ: from where its axis is `rise`
     (default: one side) under the cut - or, on a leg shorter than twice
     that, halfway down it - straight up to the cut, so the top is a level
     square on a leaning leg and never leaves the column's own leg (two legs
     meeting at a merge node must not be cut to one stub at the node). The
     path from there on is the column's. */
  function cutPath(pts, cutZ, side, rise) {
    if (pts[0][2] <= cutZ + 1e-9) return pts.map(function (q) { return q.slice(); });
    var zEnd = pts[pts.length - 1][2];
    var zq = cutZ - Math.min(rise == null ? side : rise, Math.max(0, (cutZ - zEnd) / 2));
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

  /* A hull round a cap as gridpack builds it (a CAP_SIDES-gon frustum with
     its corners on the foot's and the top's circles, turned any way): the
     frustum of the two circles' circumscribed 32-gons, which holds every
     such polygon - so a cap measured clear on it is clear as built. */
  function capHull(cap) {
    var n = 32, k = 1 / Math.cos(Math.PI / n), r0 = cap.footD / 2 * k, r1 = cap.w / 2 * k, out = new Float32Array(n * 54), w = 0;
    var bd = cap.band > 0 && cap.band < cap.z1 - cap.z0 ? cap.band : 0, zm = cap.z1 - bd, f = (zm - cap.z0) / (cap.z1 - cap.z0);
    var m = [cap.b[0] + (cap.c[0] - cap.b[0]) * f, cap.b[1] + (cap.c[1] - cap.b[1]) * f];
    function put(p) { out[w++] = p[0]; out[w++] = p[1]; out[w++] = p[2]; }
    for (var i = 0; i < n; i++) {
      var a0 = 2 * Math.PI * i / n, a1 = 2 * Math.PI * (i + 1) / n;
      var p0 = [cap.b[0] + r0 * Math.cos(a0), cap.b[1] + r0 * Math.sin(a0), cap.z0], p1 = [cap.b[0] + r0 * Math.cos(a1), cap.b[1] + r0 * Math.sin(a1), cap.z0];
      var m0 = [m[0] + r1 * Math.cos(a0), m[1] + r1 * Math.sin(a0), zm], m1 = [m[0] + r1 * Math.cos(a1), m[1] + r1 * Math.sin(a1), zm];
      var q0 = [cap.c[0] + r1 * Math.cos(a0), cap.c[1] + r1 * Math.sin(a0), cap.z1], q1 = [cap.c[0] + r1 * Math.cos(a1), cap.c[1] + r1 * Math.sin(a1), cap.z1];
      put([cap.b[0], cap.b[1], cap.z0]); put(p1); put(p0);
      put([cap.c[0], cap.c[1], cap.z1]); put(q0); put(q1);
      put(p0); put(p1); put(m1);
      put(p0); put(m1); put(m0);
      put(m0); put(m1); put(q1);
      put(m0); put(q1); put(q0);
    }
    return out;
  }
  function joinSoups(list) {
    var n = 0; list.forEach(function (s) { n += s.length; });
    var out = new Float32Array(n), w = 0;
    list.forEach(function (s) { out.set(s, w); w += s.length; });
    return out;
  }

  var api = {
    DEFAULTS: { gapMm: GAP_MM, layerMm: LAYER_MM, pitchMm: PITCH_MM, repeats: REPEATS, epsMm: EPS_MM },
    SHEET: { pitchMm: SHEET_PITCH_MM, roles: SHEET_ROLES.slice(), under: SHEET_UNDER, minRunMm: MIN_RUN_MM, cellMm: CELL_MM,
             sampleMm: SAMPLE_MM, lineAngles: LINE_ANGLES.slice(), fieldMm: FIELD_MM, levelEdgeMm: LEVEL_EDGE_MM,
             slicerSettings: Object.assign({}, SHEET_SLICER) },
    STAIR: { tipMm: STAIR_TIP_MM, backMm: STAIR_BACK_MM },
    CAP: { riseMm: CAP_RISE_MM, minMm: CAP_MIN_MM, maxMm: CAP_MAX_MM, spaceMm: CAP_SPACE_MM, gapMaxMm: CAP_GAP_MAX_MM,
           tuckMm: CAP_TUCK_MM, partMm: CAP_PART_MM, bandMm: CAP_BAND_MM, foot: CAP_FOOT },
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
