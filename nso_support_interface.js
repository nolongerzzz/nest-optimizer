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
    var P = exactPrepared(B, reach);
    var cell = P.cell, big = P.big, BTt = P.T, BB = P.bb, mark = P.mark;
    var best = { mm: Infinity, at: null, topZ: null, pairs: 0 };
    /* under: every triangle of A nearer B than it, by index (best.under) -
       pruned at `under`, not at the best so far */
    var collect = under == null ? null : [];
    var cand = P.cand;
    for (var a = 0, ai = 0; a < A.length; a += 9, ai++) {
      if (beat && (ai & 1023) === 0) beat();
      var ax0 = A[a], ax1 = A[a + 1], ax2 = A[a + 2], ay0 = A[a + 3], ay1 = A[a + 4], ay2 = A[a + 5], az0 = A[a + 6], az1 = A[a + 7], az2 = A[a + 8];
      var balo0 = Math.min(ax0, ay0, az0), balo1 = Math.min(ax1, ay1, az1), balo2 = Math.min(ax2, ay2, az2);
      var bahi0 = Math.max(ax0, ay0, az0), bahi1 = Math.max(ax1, ay1, az1), bahi2 = Math.max(ax2, ay2, az2);
      var lim = collect ? under : Math.min(best.mm, reach), dA = Infinity, stamp = ++P.stamp;
      /* the candidates in the order the grid holds them: the big triangles, then each cell's (a triangle in several
         cells is tried at its first) */
      var nc = 0;
      for (var q = 0; q < big.length; q++) { if (nc === cand.length) cand = P.cand = growInt32(cand); cand[nc++] = big[q]; }
      for (var i2 = Math.floor((balo0 - lim) / cell); i2 <= Math.floor((bahi0 + lim) / cell); i2++)
        for (var j2 = Math.floor((balo1 - lim) / cell); j2 <= Math.floor((bahi1 + lim) / cell); j2++)
          for (var k2 = Math.floor((balo2 - lim) / cell); k2 <= Math.floor((bahi2 + lim) / cell); k2++) {
            var L = exactCell(P, i2, j2, k2);
            if (L) for (var q2 = 0; q2 < L.length; q2++) { if (nc === cand.length) cand = P.cand = growInt32(cand); cand[nc++] = L[q2]; }
          }
      /* the bound a candidate is held to, and its square either way */
      var bound = collect ? under : Math.min(best.mm, reach), b2 = bound * bound, b2hi = b2 * (1 + 1e-9), b2lo = b2 * (1 - 1e-9);
      for (var c = 0; c < nc; c++) {
        var id = cand[c];
        if (mark[id] === stamp) continue;
        mark[id] = stamp;
        var o6 = id * 6;
        /* the gap between the two boxes on each axis: max(0, a.lo - b.hi, b.lo - a.hi) */
        var gx = 0, gy = 0, gz = 0, t0 = balo0 - BB[o6 + 3], t1 = BB[o6] - bahi0;
        if (t0 > gx) gx = t0; if (t1 > gx) gx = t1;
        t0 = balo1 - BB[o6 + 4]; t1 = BB[o6 + 1] - bahi1;
        if (t0 > gy) gy = t0; if (t1 > gy) gy = t1;
        t0 = balo2 - BB[o6 + 5]; t1 = BB[o6 + 2] - bahi2;
        if (t0 > gz) gz = t0; if (t1 > gz) gz = t1;
        var sq = gx * gx + gy * gy + gz * gz;
        /* g = hypot(gx, gy, gz) > bound: settled on the squares where they are far apart, by the hypot itself where
           they are not (a square sum and a hypot agree to 1e-15) */
        if (sq > b2hi) continue;
        if (!(sq < b2lo) && Math.hypot(gx, gy, gz) > bound) continue;
        best.pairs++;
        var d = triTriFlat(ax0, ax1, ax2, ay0, ay1, ay2, az0, az1, az2, BTt, id * 9);
        if (d < dA) dA = d;
        if (d < best.mm) {
          best.mm = d;
          best.at = [(ax0 + ay0 + az0) / 3, (ax1 + ay1 + az1) / 3, (ax2 + ay2 + az2) / 3];
          best.topZ = bahi2; best.lowZ = balo2;
          if (!collect) { bound = Math.min(best.mm, reach); b2 = bound * bound; b2hi = b2 * (1 + 1e-9); b2lo = b2 * (1 - 1e-9); }
        }
      }
      if (collect && dA < under) collect.push(ai);
    }
    if (best.mm > reach) best.mm = Infinity;
    if (collect) best.under = collect;
    return best;
  }
  function growInt32(a) { var n = new Int32Array(Math.max(1024, a.length * 2)); n.set(a); return n; }

  /* The stair's raster loops, out of stairOf: the same arithmetic on typed arrays handed in, in functions of their own
     (inside stairOf's closures they ran forty times slower). */

  /* a layer's cells: blk where an interval of the piece meets the layer's window (za, zb) - the layer and the gap over
     and under it; fld where nothing does and the piece's next underside is within reach over it. Cell q's intervals
     are iv[ivAt[q]] .. iv[ivAt[q + 1]] (in, out, in, out ...). */
  function stairBlocks(ivAt, iv, n, za, zb, reach, blk, fld) {
    var INF = Infinity;     /* a global is a lookup through the sandbox where this runs in a vm context: once, not per cell */
    for (var q = 0; q < n; q++) {
      var ce = INF, kEnd = ivAt[q + 1];
      for (var k = ivAt[q]; k + 1 < kEnd; k += 2) {
        if (iv[k] < zb && iv[k + 1] > za) { blk[q] = 1; break; }
        if (iv[k] >= zb && iv[k] < ce) ce = iv[k];
      }
      if (!blk[q] && ce - zb <= reach) fld[q] = 1;
    }
  }
  /* the field kept off every blocked cell that has an open neighbour: rows = [dj, di from, di to] of the disc, or its
     cells (di, dj) where a row is broken */
  function stairHalo(blk, fld, nx, ny, rows, whole, cells) {
    var n = nx * ny, max = Math.max, min = Math.min;
    for (var q2 = 0; q2 < n; q2++) {
      if (!blk[q2]) continue;
      var ci = q2 % nx, cj = (q2 - ci) / nx;
      if (ci > 0 && ci < nx - 1 && cj > 0 && cj < ny - 1 && blk[q2 - 1] && blk[q2 + 1] && blk[q2 - nx] && blk[q2 + nx]) continue;
      if (whole) {
        for (var d = 0; d < rows.length; d += 3) {
          var jj = cj + rows[d], ia = max(0, ci + rows[d + 1]), ib = min(nx - 1, ci + rows[d + 2]);
          if (jj >= 0 && jj < ny && ia <= ib) fld.fill(0, jj * nx + ia, jj * nx + ib + 1);
        }
      } else {
        for (var d2 = 0; d2 < cells.length; d2 += 2) {
          var ii2 = ci + cells[d2], jj2 = cj + cells[d2 + 1];
          if (ii2 >= 0 && ii2 < nx && jj2 >= 0 && jj2 < ny) fld[jj2 * nx + ii2] = 0;
        }
      }
    }
  }
  /* along one level line (at v) of a band's frame, the first u from down the slope where the field holds a line's
     width and the cell is near a tip; null where none does */
  function stairFront(fld, near, nx, ny, ox, oy, umin, umax, width, DU, nrm0, nrm1, dir0, dir1, v) {
    var vd0 = v * dir0, vd1 = v * dir1, round = Math.round, cellMm = CELL_MM;
    for (var u = umin; u <= umax - width; u += DU) {
      var px = u * nrm0 + vd0, py = u * nrm1 + vd1;
      var i = round((px - ox) / cellMm), j = round((py - oy) / cellMm);
      if (!(i >= 0 && i < nx && j >= 0 && j < ny && fld[j * nx + i] === 1)) continue;
      var u2 = u + width, qx = u2 * nrm0 + vd0, qy = u2 * nrm1 + vd1;
      var i2 = round((qx - ox) / cellMm), j2 = round((qy - oy) / cellMm);
      if (!(i2 >= 0 && i2 < nx && j2 >= 0 && j2 < ny && fld[j2 * nx + i2] === 1)) continue;
      if (near[j * nx + i] === 1) return u;
    }
    return null;
  }

  /* B's side of exactDistance: its triangles' boxes on a grid of cells max(1, 4 reach) wide. It depends on B and the
     cell alone, so a caller that measures many soups against the same B builds it once (exactPrep) and hands the
     handle where B goes; a soup handed bare is prepared for the one call. */
  var EXACT_OFF = 65536, EXACT_M = 131072;
  function exactPrep(B, reach) {
    var cell = Math.max(1, reach * 4), n = (B.length / 9) | 0;
    var T = new Float64Array(n * 9), lo = new Float64Array(n * 3), hi = new Float64Array(n * 3), bb = new Float64Array(n * 6), rng = new Int32Array(n * 6), isBig = new Uint8Array(n);
    var numeric = isFinite(cell), big = [];
    for (var id = 0; id < n; id++) {
      var o = id * 9, o3 = id * 3;
      for (var k = 0; k < 9; k++) T[o + k] = B[o + k];
      for (var ax = 0; ax < 3; ax++) {
        lo[o3 + ax] = Math.min(T[o + ax], T[o + 3 + ax], T[o + 6 + ax]);
        hi[o3 + ax] = Math.max(T[o + ax], T[o + 3 + ax], T[o + 6 + ax]);
      }
      for (var q6 = 0; q6 < 3; q6++) { bb[id * 6 + q6] = lo[o3 + q6]; bb[id * 6 + 3 + q6] = hi[o3 + q6]; }
      var n0 = Math.floor(lo[o3] / cell), n1 = Math.floor(hi[o3] / cell), m0 = Math.floor(lo[o3 + 1] / cell), m1 = Math.floor(hi[o3 + 1] / cell);
      var k0 = Math.floor(lo[o3 + 2] / cell), k1 = Math.floor(hi[o3 + 2] / cell);
      if ((n1 - n0 + 1) * (m1 - m0 + 1) * (k1 - k0 + 1) > 4096) { isBig[id] = 1; big.push(id); continue; }
      rng[id * 6] = n0; rng[id * 6 + 1] = n1; rng[id * 6 + 2] = m0; rng[id * 6 + 3] = m1; rng[id * 6 + 4] = k0; rng[id * 6 + 5] = k1;
      /* a number names the cell while every index lies within +-EXACT_OFF; past that the cell keeps its string */
      if (!(n0 > -EXACT_OFF && n1 < EXACT_OFF && m0 > -EXACT_OFF && m1 < EXACT_OFF && k0 > -EXACT_OFF && k1 < EXACT_OFF)) numeric = false;
    }
    var grid = new Map();
    for (var id2 = 0; id2 < n; id2++) {
      if (isBig[id2]) continue;
      for (var i = rng[id2 * 6]; i <= rng[id2 * 6 + 1]; i++) for (var j = rng[id2 * 6 + 2]; j <= rng[id2 * 6 + 3]; j++) for (var kk = rng[id2 * 6 + 4]; kk <= rng[id2 * 6 + 5]; kk++) {
        var key = numeric ? ((i + EXACT_OFF) * EXACT_M + (j + EXACT_OFF)) * EXACT_M + (kk + EXACT_OFF) : i + ',' + j + ',' + kk;
        var L = grid.get(key);
        if (!L) { L = []; grid.set(key, L); }
        L.push(id2);
      }
    }
    return { src: B, cell: cell, numeric: numeric, grid: grid, big: big, T: T, bb: bb, mark: new Float64Array(n), stamp: 0, cand: new Int32Array(1024) };
  }
  function exactPrepared(B, reach) {
    if (B && B.grid && B.T) {
      if (B.cell === Math.max(1, reach * 4)) return B;
      B = B.src;
    }
    return exactPrep(B, reach);
  }
  function exactCell(P, i, j, k) {
    if (!P.numeric) return P.grid.get(i + ',' + j + ',' + k);
    if (!(i > -EXACT_OFF && i < EXACT_OFF && j > -EXACT_OFF && j < EXACT_OFF && k > -EXACT_OFF && k < EXACT_OFF)) return undefined;
    return P.grid.get(((i + EXACT_OFF) * EXACT_M + (j + EXACT_OFF)) * EXACT_M + (k + EXACT_OFF));
  }

  /* The pair distance as ptTri / segSeg / triTri below have it, on plain numbers: the same closest points by the same
     formulas, and the hypot of the same differences. The running minimum is TT_MIN; a candidate whose squared length is
     past it by more than a part in 1e9 cannot be nearer (a hypot and a square sum agree to 1e-15) and is not hypotted. */
  var TT_MIN = Infinity, TT_MIN2 = Infinity;
  function ttConsider(dx, dy, dz) {
    var sq = dx * dx + dy * dy + dz * dz;
    if (sq !== sq) { TT_MIN = NaN; TT_MIN2 = NaN; return; }
    if (sq > TT_MIN2 * (1 + 1e-9)) return;
    var h = Math.hypot(dx, dy, dz);
    if (h < TT_MIN) { TT_MIN = h; TT_MIN2 = h * h; }
  }
  function ptTriFlat(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
    var abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az, apx = px - ax, apy = py - ay, apz = pz - az;
    var d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) return ttConsider(px - ax, py - ay, pz - az);
    var bpx = px - bx, bpy = py - by, bpz = pz - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return ttConsider(px - bx, py - by, pz - bz);
    var vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { var v = d1 / (d1 - d3); return ttConsider(px - (ax + abx * v), py - (ay + aby * v), pz - (az + abz * v)); }
    var cpx = px - cx, cpy = py - cy, cpz = pz - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return ttConsider(px - cx, py - cy, pz - cz);
    var vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { var w = d2 / (d2 - d6); return ttConsider(px - (ax + acx * w), py - (ay + acy * w), pz - (az + acz * w)); }
    var va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      var w2 = (d4 - d3) / ((d4 - d3) + (d5 - d6));
      return ttConsider(px - (bx + (cx - bx) * w2), py - (by + (cy - by) * w2), pz - (bz + (cz - bz) * w2));
    }
    var den = 1 / (va + vb + vc), v2 = vb * den, w3 = vc * den;
    return ttConsider(px - (ax + abx * v2 + acx * w3), py - (ay + aby * v2 + acy * w3), pz - (az + abz * v2 + acz * w3));
  }
  function segSegFlat(p1x, p1y, p1z, q1x, q1y, q1z, p2x, p2y, p2z, q2x, q2y, q2z) {
    /* the two segments' boxes are a lower bound on how near they come: past the running minimum by more than the
       rounding of the closest points (they lie on the segments), the pair cannot be the minimum and is not solved */
    if (TT_MIN2 < Infinity) {
      var l1 = p1x < q1x ? p1x : q1x, h1 = p1x < q1x ? q1x : p1x, l2 = p2x < q2x ? p2x : q2x, h2 = p2x < q2x ? q2x : p2x;
      var gx = (l1 > l2 ? l1 : l2) - (h1 < h2 ? h1 : h2);
      l1 = p1y < q1y ? p1y : q1y; h1 = p1y < q1y ? q1y : p1y; l2 = p2y < q2y ? p2y : q2y; h2 = p2y < q2y ? q2y : p2y;
      var gy = (l1 > l2 ? l1 : l2) - (h1 < h2 ? h1 : h2);
      l1 = p1z < q1z ? p1z : q1z; h1 = p1z < q1z ? q1z : p1z; l2 = p2z < q2z ? p2z : q2z; h2 = p2z < q2z ? q2z : p2z;
      var gz = (l1 > l2 ? l1 : l2) - (h1 < h2 ? h1 : h2);
      var g2 = (gx > 0 ? gx * gx : 0) + (gy > 0 ? gy * gy : 0) + (gz > 0 ? gz * gz : 0);
      if (g2 > TT_MIN2 * (1 + 1e-6) + 1e-12) return;
    }
    var d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z, d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z, rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
    var a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz, s, t;
    if (a <= 1e-18 && e <= 1e-18) return ttConsider(p1x - p2x, p1y - p2y, p1z - p2z);
    if (a <= 1e-18) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
    else {
      var c = d1x * rx + d1y * ry + d1z * rz;
      if (e <= 1e-18) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else {
        var b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
        s = den !== 0 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
        else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
      }
    }
    return ttConsider((p1x + d1x * s) - (p2x + d2x * t), (p1y + d1y * s) - (p2y + d2y * t), (p1z + d1z * s) - (p2z + d2z * t));
  }
  /* A's corners (x, y, z of each: a0 a1 a2 are the x's) against the triangle at T[o] */
  function triTriFlat(a0, a1, a2, b0, b1, b2, c0, c1, c2, T, o) {
    /* A = [[a0, a1, a2], [b0, b1, b2], [c0, c1, c2]]: read as the corners' x, y, z */
    var Ax = a0, Ay = a1, Az = a2, Bx = b0, By = b1, Bz = b2, Cx = c0, Cy = c1, Cz = c2;
    var Px = T[o], Py = T[o + 1], Pz = T[o + 2], Qx = T[o + 3], Qy = T[o + 4], Qz = T[o + 5], Rx = T[o + 6], Ry = T[o + 7], Rz = T[o + 8];
    TT_MIN = Infinity; TT_MIN2 = Infinity;
    ptTriFlat(Ax, Ay, Az, Px, Py, Pz, Qx, Qy, Qz, Rx, Ry, Rz); ptTriFlat(Px, Py, Pz, Ax, Ay, Az, Bx, By, Bz, Cx, Cy, Cz);
    ptTriFlat(Bx, By, Bz, Px, Py, Pz, Qx, Qy, Qz, Rx, Ry, Rz); ptTriFlat(Qx, Qy, Qz, Ax, Ay, Az, Bx, By, Bz, Cx, Cy, Cz);
    ptTriFlat(Cx, Cy, Cz, Px, Py, Pz, Qx, Qy, Qz, Rx, Ry, Rz); ptTriFlat(Rx, Ry, Rz, Ax, Ay, Az, Bx, By, Bz, Cx, Cy, Cz);
    segSegFlat(Ax, Ay, Az, Bx, By, Bz, Px, Py, Pz, Qx, Qy, Qz); segSegFlat(Ax, Ay, Az, Bx, By, Bz, Qx, Qy, Qz, Rx, Ry, Rz); segSegFlat(Ax, Ay, Az, Bx, By, Bz, Rx, Ry, Rz, Px, Py, Pz);
    segSegFlat(Bx, By, Bz, Cx, Cy, Cz, Px, Py, Pz, Qx, Qy, Qz); segSegFlat(Bx, By, Bz, Cx, Cy, Cz, Qx, Qy, Qz, Rx, Ry, Rz); segSegFlat(Bx, By, Bz, Cx, Cy, Cz, Rx, Ry, Rz, Px, Py, Pz);
    segSegFlat(Cx, Cy, Cz, Ax, Ay, Az, Px, Py, Pz, Qx, Qy, Qz); segSegFlat(Cx, Cy, Cz, Ax, Ay, Az, Qx, Qy, Qz, Rx, Ry, Rz); segSegFlat(Cx, Cy, Cz, Ax, Ay, Az, Rx, Ry, Rz, Px, Py, Pz);
    return TT_MIN;
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
  /* Bambu's dense interface (support_interface_spacing 0.1 at a 0.42 line): its lines lie 0.46 mm apart on every transition and interface
     layer of the reference slice (docs/SUPPORT-ONE-TRUNK.md). 0.47 here: the strip's joins need a segment of 0.4665 mm, and at 0.46 the
     stair under a tilted plane would not build. */
  var SHEET_DENSE_PITCH_MM = 0.47;
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
  var PERIM_REACH_MM = 6;      /* THE PART'S OUTLINE: a level's field and its caps lie only where the part is over the stack's top within this far (a flat sheet's own, shorter reach, opts.flatGapMaxMm, is the field's besides) */
  var PERIM_GROW_MM = [0, -0.3, -0.6, -0.9, -1.2];   /* a rim too thin for the sheet's 2 mm lines: the outline taken to its edge, then out past it by this much (a negative margin), the least that gives a sheet */
  var FILL_MM = 3;             /* THE FILL: with the contact surface's footprint (opts.footprints) a level's field runs this far past a cap's rim, to the footprint's edge and no further... */
  var FILL_REACH_MM = 1.2;     /* ...wherever the part is this near over the stack's top (the legacy field, a cap and 1.25 mm, needs no such reach) */
  var CONC_CUSHION_MM = 0.08;      /* the opened level set keeps its walls this much more than a line width apart (what the cleaning of a loop moves them by: the extrusion refuses an overlap) */
  var CONC_SIMPLIFY_MM = 0.015;    /* a loop's points within this of the line between their neighbours go */
  var REGION_TIP_NEAR_MM = 0.5;   /* a tip's contact this near a footprint's edge is the footprint's */
  var REGION_MARGIN_MM = 0.02;    /* the region plate's cells lie this far in from the footprint's edge (the face's own edge: the plate may run to it; it was 0.1, which left a band 0.15 mm wide bare all round a 1 - 2 mm rim and the tails of the Negative Spheres' patches); its first loop is the edge of that, a wall's centre ~0.1 mm in */
  var REGION_HOLE_FILL_MM2 = 3;   /* a hole in a footprint under this area is laid over, not round (see shellPass) */
  var REGION_FLAT_MM = 0.3;       /* a footprint whose height (2nd to 98th percentile) varies by no more than this is one flat face: the plate is one level at its lowest height */
  var SHELL_START_MM = 1.2;        /* the height rays start under the footprint's lowest spot: the underside may be lower than any spot of it */
  var REGION_PLANE_SHARE = 0.25;  /* ...or, on a big range, within this share of the range (a plane's residual is a few percent of its height, a dome's a quarter) */
  var REGION_PLANE_MM = 0.15;     /* ...and a footprint whose surface lies within this of one plane that leans 3 - 70 deg is a stair's, not the plate's */
  var THIN_NARROW_MM = -0.02;     /* ...a half line and this much in from the sliver's edge (a negative number is room; 0.06 let a bead be wider than a 0.3 mm tail by that much each side and gained nothing measurable) */
  var THIN_MIN_MM = 0.6;         /* a thin bead (a line along a sliver the outline and the hatch left bare) shorter than this is a speck of the skeleton */
  var THIN_CLEAR_MM = 0.06;       /* ...stands a line and this far (centre to centre) from every path laid, so no two lines meet except at a node */
  var THIN_SIMPLIFY_MM = 0.06;    /* ...its skeleton's staircase cleaned to this */
  var THIN_SEG_MM = 0.6;          /* ...no segment of it shorter than this */
  var EDGE_HATCH_HALF_MM = 1.0;  /* ... and only where the region is 2 mm across somewhere: a strip a line or two wide is one bead along it, not lines across it */
  var EDGE_HATCH_SHARE = 0.3;   /* a narrow region is laid in lines alone, edge to edge, when they hold at least this share of it (lines x pitch over its area) */
  var RING_LINE_MIN_MM = 0.5;     /* ...with lines down to this long inside it (the corners of the ring are a gap a line or two across) */
  var RING_MIN_AREA_MM2 = 20;      /* ...in a region of at least this area (a ring round a cavity, a trunk's cut and all: its outline may be one loop or two) */
  var RING_OUTLINE_GAIN = 1.25;  /* a ring's outline and what hatch fits inside it is kept over the edge-to-edge lines when it lays this many times their length */
  var HATCH_MIN_SHARE = 0.6;     /* a hatch whose lines (times the pitch) fill less than this share of the room inside its outline is given up for concentric loops */
  var REGION_MIN_LOOP_MM = 2.4;  /* a loop of the region plate shorter than this is a speck of the level set (a medial axis's end), not a line */
  var FILL_FLAT_MM = 2.4;      /* the region plate (and the fill) is for a footprint whose height range (its spots', and 1.6 mm of padding) is no more than this: a face of one height, not a slope or a dome */
  var FILL_MAX_TIPS = 16;      /* ...for a level of this many tips or fewer: a few tips on a wide surface is what it is for; a level of dozens already stands across its surface, and the filled build of the clamp's 54-tip level costs 5.5 s for next to nothing (+0.5 % of the support) */
  var PERIM_NEAR_MM = 3.6;     /* a level none of whose tips is this near the part's edge (a cap's 2 mm, the field's 1.25, the margin) is built as it always was: the outline cannot reach it */
  var PERIM_MARGIN_MM = 0.2;   /* ...and this far in from where it stops, a line's centre: its edge (0.2) ends on the outline, not over the air beyond it */
  var COLUMN_CLEAR_MM = 0.2;   /* the sheet and its caps keep this far off another support's column */
  var LOW_ROOM_MM = 0.5;       /* a tip with no room for a cap is cut flat under the stack where its column stands this much clear of the foot */
  var ROOM_MM = 0.5;           /* a cut tip keeps this much of itself above the foot */
  var CAP_RISE_MM = 2;         /* a tip widens to its cap over this much of its rise */
  var CAP_MIN_MM = 2.5;        /* a cap is this wide at least... */
  var CAP_MAX_MM = 4;          /* ...and at most */
  var CAP_SPACE_MM = 0.5;      /* where there is room, a cap leaves this much air to its nearest neighbour */
  var CAP_GAP_MAX_MM = 2;      /* the most air between a cap and its nearest neighbour (CAP_MAX_MM caps on tips 6 mm apart) */
  var CAP_IN_MM = 1.5;         /* a cap hanging off the part's edge is moved in this far at most before it is narrowed */
  var CAP_STEP_MM = 0.25;      /* a cap too near the piece or another support narrows by this */
  var CAP_FOOT = 0.9;          /* the cap's foot across, as a share of the column's side: inside its square however either is turned */
  var CAP_TUCK_MM = 0.1;       /* the column under a cap ends this far (and half its diagonal) inside it: no face of the two shares a plane */
  var CAP_SIDES = 32;          /* the cap's rim, sampled for its clearance */
  var CAP_TIP_MIN_MM = 0.5;    /* the least a flared cap narrows to where its plate is a ring or a thin neck: it tapers to the plate's width rather than stand out past it */
  var FLARE_OVERLAP = 1.4;     /* a flared cap under a region plate is this much of the way to its nearest neighbour's centre and past it, held to CAP_MAX_MM: their rims meet (flareOf) */
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
  var STAIR_LEG_MM = 4.5;      /* a row of a stair's posts has a leg every this along it (opts.stairLegMm, the card's Dense: a blade of posts, a tree leg to each stretch); null: a leg to every post */
  var STAIR_PERIM_MM = 2.5;    /* the tips of a Dense stair stand along the outline of its sheet this far apart at the most, at its low end... */
  var STAIR_PERIM_TOP_MM = 4.0; /* ...and this far apart at its high end, where a tip is a long leg from the crown (the spacing grows with the strip a tip stands under) */
  var STAIR_PERIM_IN_MM = 0.6; /* ...this far in from its edge (under the transition, not under its rim) */
  var STAIR_FILL_MM = 3.8;     /* ...and inside it wherever none is nearer than this */
  var STAIR_ROW_MM = 2.4;      /* a post joins the row whose last post is this near it in plan, or nearer... */
  var STAIR_ROW_GAP = 3;       /* ...and no more than this many strips under it */
  var STAIR_TIP_MM = 5;        /* a strip's leading part has a tip every this, or nearer, along it (Bambu's branch distance) */
  var STAIR_SNAP_DEG = 2;       /* a fall this near one of the sheet's line angles takes it */
  var STAIR_REACH_MM = 3;
  var STAIR_TOP_REACH_MM = 1.1; /* a Dense stair's top strip covers the part only where it is this near over the strip's top (a stack and a bit): not into the fillet where it curves up to its wall */
  var STAIR_NEAT_MM = [0.06, 0.15, 0.3];   /* a strip whose front would not extrude is drawn on its front straightened to these, in turn (mm) */
  var LONE_SINKS = [0.03, 0.06, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6];   /* a lone tip's sheet with no field is tried again this far lower, in turn (mm) */
  var STAIR_WALL_MM = 0.56;    /* the stair asked again keeps its strips this far off the piece's walls: the gap, a line's corner, a cell */
  var LONE_SLACK = 0.25;       /* ...and a column's end blocks a last-resort sheet this share of its side above its top */
  var LONE_FIELD_MM = 2.6;     /* a last-resort sheet may lie this far from its tip's axis, a cap or not: room for a piece of three cells */
  var LATE_SPAN_MM = 0.8;      /* a small cluster of leftover tips whose ceilings span this or less is one level at the lowest of them */
  var LATE_LINK_MM = 3.6;      /* ...tips this near are one cluster; */
  var LATE_CLUSTER_MAX = 9;    /* ...of this many tips at most */
  var LATE_TOL_MM = 0.2;       /* tips left over agree on a level to this: under half a layer, the sheet at the lowest ceiling of them */
  var LONE_MAX_TIPS = 9;       /* ...for a level of this many tips or fewer (a row of them has no field to find that way) */
  var XY_CLEAR_MM = 0.35;      /* SIDEWAYS: a support line keeps this from the part's lines (the slice's support_object_xy_distance), centre to centre */
  var HELD_TOP_MM = 0.7;       /* A TIP IS SAID HELD BY ITS SHEET only where one is under it: a stair's strip within STAIR_HOLD_MM of it in plan whose top is no further under the contact than this... */
  var HELD_FLAT_MM = 0.9;      /* ...and a flat sheet's top no further under it than this (the gap and the three lines of its interface) */
  var STAIR_HOLD_MM = 1.5;     /* a stair holds a tip a strip of it lies this near in plan... */
  var STAIR_UNDER_MM = 1.2;    /* ...and no further under the tip's contact than this (the stack, the gap and a strip's step) */
  var STAIR_ROUNDS = 4;        /* the tips a stair leaves are asked for a stair again, this many times at most */
  var STAIR_CUTS = 6;          /* a stair is cut short by the gap at most this many times */
  var STAIR_FRONT_RUN = 0.8;   /* ...its front no steeper than this, mm up the slope per mm along it */
  var STAIR_STUB_MM = 0.45;    /* ...with no corner nearer the loop's ends than this */
  var STAIR_START = 0.6;       /* the stair starts where a strip first runs this share of the longest strip's length */      /* a strip lies only where the part's underside is this near over it */

  /* =====================================================================
     THE REGION PLATE'S GEOMETRY (docs/SUPPORT-FOOTPRINT.md section 9): a region on a raster - the footprint's cells that a stack may stand in - as
     the closed loops a plate of concentric lines is printed in. Pure functions of typed arrays: the distance to the region's edge, the level sets
     of it (marching squares, linear along an edge), and the polyline cleaned. A level set is OPENED first (what is thinner than a line and its gap
     goes), so no two walls of a layer are nearer than the line width: the extrusion refuses an overlap.
     ===================================================================== */
  /* the Euclidean distance, in cells, from each cell of mask (1) to the nearest cell that is 0 (Felzenszwalb - Huttenlocher); 0 on a 0 cell. The
     raster's frame is not a zero: the caller leaves a margin of them. */
  function edtCells(mask, nx, ny) {
    var BIG = 1e12, n = Math.max(nx, ny), f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    var g = new Float64Array(nx * ny), out = new Float32Array(nx * ny), i, j;
    function pass(len) {
      var k = 0;
      v[0] = 0; z[0] = -BIG; z[1] = BIG;
      for (var q = 1; q < len; q++) {
        var sx;
        for (;;) {
          sx = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
          if (sx > z[k] || k === 0) break;
          k--;
        }
        if (sx > z[k]) { k++; v[k] = q; z[k] = sx; z[k + 1] = BIG; } else { v[k] = q; z[k] = -BIG; z[k + 1] = BIG; }
      }
      k = 0;
      for (var q2 = 0; q2 < len; q2++) {
        while (z[k + 1] < q2) k++;
        d[q2] = (q2 - v[k]) * (q2 - v[k]) + f[v[k]];
      }
    }
    for (i = 0; i < nx; i++) {
      for (j = 0; j < ny; j++) f[j] = mask[j * nx + i] ? BIG : 0;
      pass(ny);
      for (j = 0; j < ny; j++) g[j * nx + i] = d[j];
    }
    for (j = 0; j < ny; j++) {
      for (i = 0; i < nx; i++) f[i] = g[j * nx + i];
      pass(nx);
      for (i = 0; i < nx; i++) out[j * nx + i] = d[i] >= BIG / 2 ? 1e6 : Math.sqrt(d[i]);
    }
    return out;
  }
  /* the closed loops of {val > level} on the raster: polylines of [i, j] in cells, the first point repeated; marching squares, the crossing found
     along its edge by linear interpolation (a saddle is read by the cell's mean) */
  var MS_TABLE = [null, [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], null, [[0, 2]], [[3, 2]], [[2, 3]], [[0, 2]], null, [[1, 2]], [[1, 3]], [[0, 1]], [[3, 0]], null];
  function isoLoops(val, nx, ny, level) {
    var adj = new Map(), pos = new Map();
    function edgeId(e, i, j) {      /* 0 bottom (i,j)-(i+1,j), 1 right (i+1,j)-(i+1,j+1), 2 top (i,j+1)-(i+1,j+1), 3 left (i,j)-(i,j+1) */
      if (e === 0) return 2 * (j * nx + i);
      if (e === 1) return 2 * (j * nx + i + 1) + 1;
      if (e === 2) return 2 * ((j + 1) * nx + i);
      return 2 * (j * nx + i) + 1;
    }
    function at(e, i, j) {
      var id = edgeId(e, i, j), p = pos.get(id);
      if (p) return id;
      var ia = i, ja = j, ib = i, jb = j;
      if (e === 0) { ib = i + 1; } else if (e === 1) { ia = i + 1; ib = i + 1; jb = j + 1; } else if (e === 2) { ja = j + 1; ib = i + 1; jb = j + 1; } else { jb = j + 1; }
      var va = val[ja * nx + ia], vb = val[jb * nx + ib], t = vb === va ? 0.5 : (level - va) / (vb - va);
      pos.set(id, [ia + (ib - ia) * t, ja + (jb - ja) * t]);
      return id;
    }
    function link(a, b) {
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(b); adj.get(b).push(a);
    }
    for (var j = 0; j + 1 < ny; j++) for (var i = 0; i + 1 < nx; i++) {
      var va = val[j * nx + i] > level, vb = val[j * nx + i + 1] > level, vc = val[(j + 1) * nx + i + 1] > level, vd = val[(j + 1) * nx + i] > level;
      var cs = (va ? 1 : 0) | (vb ? 2 : 0) | (vc ? 4 : 0) | (vd ? 8 : 0);
      if (cs === 0 || cs === 15) continue;
      var segs;
      if (cs === 5 || cs === 10) {
        var mid = (val[j * nx + i] + val[j * nx + i + 1] + val[(j + 1) * nx + i + 1] + val[(j + 1) * nx + i]) / 4 > level;
        if (cs === 5) segs = mid ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
        else segs = mid ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]];
      } else segs = MS_TABLE[cs];
      for (var s = 0; s < segs.length; s++) link(at(segs[s][0], i, j), at(segs[s][1], i, j));
    }
    var loops = [], seen = new Set();
    adj.forEach(function (_, start) {
      if (seen.has(start)) return;
      var ring = [], cur = start, prev = -1;
      for (;;) {
        seen.add(cur); ring.push(pos.get(cur));
        var nb = adj.get(cur), nx2 = nb[0] === prev && nb.length > 1 ? nb[1] : nb[0];
        if (nb.length === 2 && nb[0] === nb[1]) nx2 = nb[0];
        if (nx2 === undefined || seen.has(nx2)) break;
        prev = cur; cur = nx2;
      }
      if (ring.length >= 3) { ring.push(ring[0].slice()); loops.push(ring); }
    });
    return loops;
  }
  /* a closed ring made fit for the extrusion: every segment at least as long as the joins at its two ends need (a join of turn t eats half a width times
     tan(t / 2) of each segment it ends), by merging the vertex of the least turn of a segment that is too short into its neighbours; null when the
     ring cannot be made so (fewer than 3 points, or a turn so sharp no length serves) */
  function fitRing(ring, halfW) {
    var pts = ring.slice(0, -1);
    function turn(i) {
      var n = pts.length, a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
      var ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1], lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (lu < 1e-9 || lv < 1e-9) return Math.PI;
      return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
    }
    function eat(i) { var t = turn(i); return t > Math.PI * 0.8 ? Infinity : halfW * Math.tan(t / 2); }
    for (var guard = 0; guard < 4000 && pts.length >= 3; guard++) {
      var n = pts.length, bad = -1, worst = 0;
      for (var i = 0; i < n; i++) {
        var j = (i + 1) % n, len = Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]), need = eat(i) + eat(j) + 0.02;
        if (len < need && need - len > worst) { worst = need - len; bad = i; }
      }
      if (bad < 0) { pts.push(pts[0].slice()); return pts; }
      var b2 = (bad + 1) % n, drop = turn(bad) <= turn(b2) ? bad : b2;
      if (!isFinite(eat(drop)) && !isFinite(eat(drop === bad ? b2 : bad))) return null;
      pts.splice(drop, 1);
    }
    return null;
  }
  /* THE CONCENTRIC LOOPS of a region (the mask's 1 cells, a raster of nx x ny cells of cellMm with its [0, 0] at (ox, oy)): the level sets of the distance
     to its edge, the first a tenth of a mm in, then a pitch apart, each opened by half a line and its gap so no two walls are nearer than a line width,
     each cleaned to what the extrusion takes; as { ring: [[x, y], ... closed], lenMm, level }. How a raft is laid, and Bambu's interface. */
  function concentricLoops(M, nx, ny, ox, oy, cellMm, pitchMm, widthMm, minLoopMm, maxLevels) {
    var N = nx * ny, dist = edtCells(M, nx, ny), dmax = 0, loops = [];
    for (var qd = 0; qd < N; qd++) if (dist[qd] > dmax) dmax = dist[qd];
    var half = (widthMm + CONC_CUSHION_MM) / 2 / cellMm;
    for (var lv = 0; !maxLevels || lv < maxLevels; lv++) {
      var lev = 0.5 + 0.1 / cellMm + lv * pitchMm / cellMm;                     /* cells: half a cell to the edge itself, then a tenth of a mm in, then a pitch each */
      if (lev > dmax) break;
      var T = new Uint8Array(N);
      for (var qt = 0; qt < N; qt++) T[qt] = dist[qt] >= lev ? 1 : 0;
      var e = edtCells(T, nx, ny), core = new Uint8Array(N), any = false;
      for (var qc = 0; qc < N; qc++) { if (T[qc] && e[qc] - 0.5 >= half - 1e-9) { core[qc] = 0; any = true; } else core[qc] = 1; }     /* 0 = a cell the opened set stands on */
      if (!any) break;
      var gd = edtCells(core, nx, ny), h = new Float32Array(N);
      for (var qh = 0; qh < N; qh++) h[qh] = half + 0.5 - gd[qh];
      isoLoops(h, nx, ny, 0).forEach(function (ring) {
        var mm = ring.map(function (p) { return [ox + p[0] * cellMm, oy + p[1] * cellMm]; });
        var sr = simplifyRing(mm, CONC_SIMPLIFY_MM), len = 0;
        sr = sr && fitRing(sr, widthMm / 2);
        if (!sr) return;
        for (var k = 1; k < sr.length; k++) len += Math.hypot(sr[k][0] - sr[k - 1][0], sr[k][1] - sr[k - 1][1]);
        if (len >= minLoopMm) loops.push({ ring: sr, lenMm: len, level: lv });
      });
    }
    return loops;
  }
  /* THE SLAB OF A REGION (opts.slabPlate): the region's footprint as ONE solid prism a layer high - its outline traced off the mask (marching squares,
     simplified), the holes bridged to it and the cap ear-clipped on the loops' own vertices (so the prism is closed, not a soup). It is the footprint
     alone: no loops, no lines, no thin beads. The slicer that reads it lays the zigzag itself (a sheet zone is filled with one continuous run, turned each
     layer), where the plate of loops and lines it used to read was cut by the slicer's wall inset into the pieces the G-scope showed (20 runs a layer
     against Bambu's 2). Returns { rings: [closed [x, y] rings, outer first], tris: Float32Array } or null when the mask has no ring to trace or the
     triangulation fails (the caller then lays the loops and lines as before). */
  /* the share of a region a set of paths covers, each a line wide: the paths stamped on the raster, as the cells of the region that lie within a half line of one */
  function coverShare(M, nx, ny, ox, oy, cellMm, widthMm, paths) {
    var N = nx * ny, C = new Uint8Array(N), r = widthMm / 2, rc = Math.ceil(r / cellMm), m = 0, cov = 0, q;
    paths.forEach(function (p) {
      for (var k = 1; k < p.length; k++) {
        var len = Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]), n = Math.max(1, Math.ceil(len / (cellMm * 0.5)));
        for (var u = 0; u <= n; u++) {
          var x = p[k - 1][0] + (p[k][0] - p[k - 1][0]) * u / n, y = p[k - 1][1] + (p[k][1] - p[k - 1][1]) * u / n, ci = Math.round((x - ox) / cellMm), cj = Math.round((y - oy) / cellMm);
          for (var dj = -rc; dj <= rc; dj++) for (var di = -rc; di <= rc; di++) {
            var ii = ci + di, jj = cj + dj;
            if (ii >= 0 && ii < nx && jj >= 0 && jj < ny && Math.hypot(ii * cellMm + ox - x, jj * cellMm + oy - y) <= r) C[jj * nx + ii] = 1;
          }
        }
      }
    });
    for (q = 0; q < N; q++) if (M[q]) { m++; if (C[q]) cov++; }
    return m ? cov / m : 0;
  }
  var SLAB_MIN_MM2 = 3.5;      /* a slab is laid for an island of the footprint this big at least */
  var SLAB_WEAK_SHARE = 0.75;  /* slabPlate 'weak': a region is laid as a slab when its loops and lines (and thin beads) cover less than this share of it */
  function slabOfMask(M, nx, ny, ox, oy, cellMm, z0, z1, epsMm) {
    var f = new Float32Array(M.length), q;
    for (q = 0; q < M.length; q++) f[q] = M[q] ? 1 : 0;
    function a2(r) { var s = 0; for (var i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return s / 2; }
    function pip(p, r) {
      var inn = false;
      for (var i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) && p[0] < (r[j][0] - r[i][0]) * (p[1] - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) inn = !inn;
      return inn;
    }
    var rings = isoLoops(f, nx, ny, 0.5).map(function (r) {
      var mm = r.map(function (p) { return [ox + p[0] * cellMm, oy + p[1] * cellMm]; });
      mm = simplifyRing(mm, epsMm);
      return mm.slice(0, -1);
    }).filter(function (r) { return r.length >= 3 && Math.abs(a2(r)) > 0.05; });
    if (!rings.length) return null;
    var depth = rings.map(function (r, i) { var d = 0; rings.forEach(function (o2, k) { if (k !== i && pip(r[0], o2)) d++; }); return d; });
    var out = [], closed = [];
    function side(r) {                                                   /* the wall of a ring wound with the solid on its left */
      for (var i = 0; i < r.length; i++) {
        var a = r[i], b = r[(i + 1) % r.length];
        out.push(a[0], a[1], z0, b[0], b[1], z0, b[0], b[1], z1, a[0], a[1], z0, b[0], b[1], z1, a[0], a[1], z1);
      }
    }
    for (var i = 0; i < rings.length; i++) {
      if (depth[i] % 2) continue;
      var O = rings[i].slice();
      if (Math.abs(a2(O)) < SLAB_MIN_MM2) continue;                    /* a speck of a footprint is no plate (the loops and lines drop it as well: nothing survives their opening) */
      if (a2(O) < 0) O.reverse();
      var Hs = [];
      rings.forEach(function (h, k) { if (depth[k] === depth[i] + 1 && pip(h[0], O)) { var H = h.slice(); if (a2(H) > 0) H.reverse(); Hs.push(H); } });
      var T;
      try { T = triangulateRings(O, Hs); } catch (e) { return null; }
      if (!T.tris.length) return null;
      var want = Math.abs(a2(O)), capA = 0;                            /* the cap must hold the ring's area less its holes': a hole the bridging left covered is refused */
      Hs.forEach(function (h) { want -= Math.abs(a2(h)); });
      T.tris.forEach(function (t) { var A = T.pts[t[0]], B = T.pts[t[1]], C = T.pts[t[2]]; capA += Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])) / 2; });
      if (Math.abs(capA - want) > 0.02 * Math.max(want, 1)) return null;
      T.tris.forEach(function (t) {
        var A = T.pts[t[0]], B = T.pts[t[1]], C = T.pts[t[2]];
        out.push(A[0], A[1], z1, B[0], B[1], z1, C[0], C[1], z1);
        out.push(A[0], A[1], z0, C[0], C[1], z0, B[0], B[1], z0);
      });
      side(O); Hs.forEach(side);
      closed.push(O.concat([O[0].slice()]));
    }
    if (!closed.length) return null;
    return { rings: closed, tris: new Float32Array(out) };
  }
  /* an outer ring (counter-clockwise) with holes (clockwise) cut into triangles on their own vertices: each hole bridged to the nearest vertex it can see,
     then the ears clipped (as nso_face_features.triangulate does for a cap) */
  function triangulateRings(outer, holes) {
    var pts = outer.slice(), idx = outer.map(function (_, i) { return i; });
    function o3(u, v, w) { return (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]); }
    function crosses(p, q, a, b) { var d1 = o3(p, q, a), d2 = o3(p, q, b), d3 = o3(a, b, p), d4 = o3(a, b, q); return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)); }
    function sees(p, q) { for (var i = 0; i < idx.length; i++) if (crosses(p, q, pts[idx[i]], pts[idx[(i + 1) % idx.length]])) return false; return true; }
    function inTri(p, a, b, c) {
      var d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]), d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]), d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    }
    holes.slice().sort(function (a, b) { return Math.max.apply(null, b.map(function (p) { return p[0]; })) - Math.max.apply(null, a.map(function (p) { return p[0]; })); }).forEach(function (H) {
      var base = pts.length, hi = 0, i;
      H.forEach(function (p) { pts.push(p); });
      for (i = 1; i < H.length; i++) if (H[i][0] > H[hi][0]) hi = i;
      var hp = H[hi], best = -1, bestD = Infinity;
      for (var j = 0; j < idx.length; j++) {
        var p = pts[idx[j]], dd = (p[0] - hp[0]) * (p[0] - hp[0]) + (p[1] - hp[1]) * (p[1] - hp[1]);
        if (dd < bestD && sees(hp, p)) { best = j; bestD = dd; }
      }
      if (best < 0) throw new Error('a hole could not be bridged');
      var ring = [];
      for (i = 0; i <= H.length; i++) ring.push(base + (hi + i) % H.length);
      idx = idx.slice(0, best + 1).concat(ring).concat([idx[best]]).concat(idx.slice(best + 1));
    });
    var tris = [], cur = idx.slice(), guard = 0;
    while (cur.length > 3 && guard++ < 100000) {
      var clipped = false;
      for (var pass = 0; pass < 2 && !clipped; pass++) for (var i2 = 0; i2 < cur.length; i2++) {
        var ia = cur[(i2 + cur.length - 1) % cur.length], ib = cur[i2], ic = cur[(i2 + 1) % cur.length], a = pts[ia], b = pts[ib], c = pts[ic], cr = o3(a, b, c);
        if (pass === 0 ? !(cr > 1e-12) : !(cr >= -1e-12)) continue;
        var inside = false;
        for (var m = 0; m < cur.length && !inside; m++) {
          var im = cur[m];
          if (im === ia || im === ib || im === ic) continue;
          var pp = pts[im];
          if ((pp[0] === a[0] && pp[1] === a[1]) || (pp[0] === b[0] && pp[1] === b[1]) || (pp[0] === c[0] && pp[1] === c[1])) continue;
          if (inTri(pp, a, b, c)) inside = true;
        }
        if (inside) continue;
        if (cr > 1e-12) tris.push([ia, ib, ic]);
        cur.splice(i2, 1); clipped = true; break;
      }
      if (!clipped) throw new Error('a cap could not be triangulated');
    }
    if (cur.length === 3 && o3(pts[cur[0]], pts[cur[1]], pts[cur[2]]) > 1e-12) tris.push(cur.slice());
    return { pts: pts, tris: tris };
  }
  /* THE PLATE OF A REGION, as Bambu lays a raft and its interface: an outline loop hugging the region's edge, and inside it a hatch at hatchDeg (the
     caller alternates it layer by layer), the lines a pitch apart on a lattice fixed in the plane (so two layers of one direction stack line on line),
     each running to a line's gap short of the loop - the loops and the lines are separate paths, never touching, which the extrusion takes. A region too
     thin for a hatch inside its loop (nothing left a hatch-line's gap and a half inside it) is laid in concentric loops as it is. Returns
     { loops: [{ ring, lenMm }], lines: [[[x0, y0], [x1, y1]], ...] }. */
  function plateOfRegion(M, nx, ny, ox, oy, cellMm, pitchMm, widthMm, hatchDeg, minLoopMm, minLineMm) {
    var pl = plateOfRegionCore(M, nx, ny, ox, oy, cellMm, pitchMm, widthMm, hatchDeg, minLoopMm, minLineMm);
    pl.thin = thinLines(M, nx, ny, ox, oy, cellMm, widthMm, pl.loops, pl.lines, THIN_MIN_MM);
    return pl;
  }
  /* THE THIN PARTS of a region: what the outline's opening and the hatch leave bare where the region is a bead wide and no more (a rim's crescent, a
     tapering end). The bead's centre may lie anywhere a half line in from the region's edge, so the cells that are that far in and a line and a
     gap from every path already laid are thinned to one pixel (Zhang - Suen), traced into open polylines, and cleaned (Douglas - Peucker, no
     segment shorter than THIN_SEG_MM). Each returned polyline is one bead along the middle of its sliver. */
  function thinLines(M, nx, ny, ox, oy, cellMm, widthMm, loops, lines, minLenMm) {
    var N = nx * ny, dist = edtCells(M, nx, ny), need = (widthMm / 2 - THIN_NARROW_MM) / cellMm + 0.5, avoid = widthMm + THIN_CLEAR_MM, T = new Uint8Array(N), any = false, q;
    for (q = 0; q < N; q++) if (dist[q] >= need) { T[q] = 1; any = true; }
    if (!any) return [];
    /* the cells a laid path occupies: the distance from them says where a new bead may stand */
    var P = new Uint8Array(N).fill(1), laid = false;
    function mark(a, b) {
      var len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len / (cellMm * 0.5)));
      for (var k = 0; k <= n; k++) {
        var ci = Math.round((a[0] + (b[0] - a[0]) * k / n - ox) / cellMm), cj = Math.round((a[1] + (b[1] - a[1]) * k / n - oy) / cellMm);
        if (ci >= 0 && ci < nx && cj >= 0 && cj < ny) { P[cj * nx + ci] = 0; laid = true; }
      }
    }
    loops.forEach(function (l) { for (var k = 1; k < l.ring.length; k++) mark(l.ring[k - 1], l.ring[k]); });
    lines.forEach(function (l) { mark(l[0], l[1]); });
    if (laid) { var dp = edtCells(P, nx, ny); for (q = 0; q < N; q++) if (T[q] && dp[q] * cellMm < avoid) T[q] = 0; }
    /* Zhang - Suen thinning; the raster's frame is 0 (the caller's margin) */
    var S = T, changed = true, passes = 0, idx = [];
    for (q = 0; q < N; q++) if (S[q]) idx.push(q);
    if (!idx.length) return [];
    while (changed && passes++ < 60) {
      changed = false;
      for (var step = 0; step < 2; step++) {
        var kill = [];
        for (var ii = 0; ii < idx.length; ii++) {
          var p = idx[ii];
          if (!S[p]) continue;
          var x = p % nx, y = (p - x) / nx;
          if (x < 1 || y < 1 || x > nx - 2 || y > ny - 2) { kill.push(p); continue; }
          var p2 = S[p - nx], p3 = S[p - nx + 1], p4 = S[p + 1], p5 = S[p + nx + 1], p6 = S[p + nx], p7 = S[p + nx - 1], p8 = S[p - 1], p9 = S[p - nx - 1];
          var B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          var Ac = (!p2 && p3) + (!p3 && p4) + (!p4 && p5) + (!p5 && p6) + (!p6 && p7) + (!p7 && p8) + (!p8 && p9) + (!p9 && p2);
          if (Ac !== 1) continue;
          if (step === 0 ? (p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0) : (p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0)) kill.push(p);
        }
        if (kill.length) { changed = true; kill.forEach(function (k) { S[k] = 0; }); }
      }
      idx = idx.filter(function (k) { return S[k]; });
    }
    if (!idx.length) return [];
    /* trace: from each end first, then from whatever is left (a loop, a junction's other arms) */
    var NB = [-1, 1, -nx, nx, -nx - 1, -nx + 1, nx - 1, nx + 1], seen = new Uint8Array(N), paths = [];
    function deg(k) { var d = 0; for (var e = 0; e < 8; e++) if (S[k + NB[e]]) d++; return d; }
    function junctionNear(k, not) { for (var e = 0; e < 8; e++) { var c = k + NB[e]; if (c !== not && S[c] && deg(c) >= 3) return c; } return -1; }
    function walk(start) {
      var path = [start], cur = start, j0 = deg(start) >= 3 ? -1 : junctionNear(start, -1);
      seen[start] = 1;
      if (j0 >= 0) path.unshift(j0);                           /* an arm leaves its junction's own pixel, so two lines meet at one node */
      for (;;) {
        var nxt = -1;
        for (var e = 0; e < 8 && nxt < 0; e++) { var c = cur + NB[e]; if (S[c] && !seen[c]) nxt = c; }
        if (nxt < 0) { var j1 = junctionNear(cur, j0); if (j1 >= 0 && path.length > 2) path.push(j1); break; }
        seen[nxt] = 1; path.push(nxt); cur = nxt;
        if (deg(nxt) >= 3) break;                            /* a junction ends the arm; the other arms start from it */
      }
      return path;
    }
    function unseenDeg(k) { var d = 0; for (var e = 0; e < 8; e++) if (S[k + NB[e]] && !seen[k + NB[e]]) d++; return d; }
    var ends = idx.filter(function (k) { return deg(k) <= 1; });
    ends.forEach(function (k) { if (!seen[k]) paths.push(walk(k)); });
    for (var rounds = 0; rounds < 4; rounds++) idx.forEach(function (k) { if (!seen[k] && unseenDeg(k) <= 1) paths.push(walk(k)); });
    idx.forEach(function (k) { if (!seen[k]) paths.push(walk(k)); });
    var out = [];
    paths.forEach(function (pp) {
      var pts = pp.map(function (k) { var x = k % nx, y = (k - x) / nx; return [ox + x * cellMm, oy + y * cellMm]; });
      pts = simplifyPath(pts, THIN_SIMPLIFY_MM);
      for (var g = 0; g < 50 && pts.length > 2; g++) {              /* no segment shorter than the extrusion takes: its end vertex goes */
        var bad = -1;
        for (var s = 0; s + 1 < pts.length; s++) if (Math.hypot(pts[s + 1][0] - pts[s][0], pts[s + 1][1] - pts[s][1]) < THIN_SEG_MM) { bad = s; break; }
        if (bad < 0) break;
        pts.splice(bad + 1 < pts.length - 1 ? bad + 1 : bad, 1);
      }
      var len = 0;
      for (var s2 = 1; s2 < pts.length; s2++) len += Math.hypot(pts[s2][0] - pts[s2 - 1][0], pts[s2][1] - pts[s2 - 1][1]);
      if (pts.length >= 2 && len >= minLenMm) out.push(pts);
    });
    return out;
  }
  /* an open polyline with the points within eps of the line between their neighbours dropped (Douglas - Peucker) */
  function simplifyPath(pts, eps) {
    if (pts.length < 3) return pts.slice();
    var keep = new Uint8Array(pts.length), stack = [[0, pts.length - 1]];
    keep[0] = keep[pts.length - 1] = 1;
    while (stack.length) {
      var se = stack.pop(), a = pts[se[0]], b = pts[se[1]], dx = b[0] - a[0], dy = b[1] - a[1], dd = Math.hypot(dx, dy) || 1e-9, worst = -1, wi = -1;
      for (var i = se[0] + 1; i < se[1]; i++) {
        var d = Math.abs((pts[i][0] - a[0]) * dy - (pts[i][1] - a[1]) * dx) / dd;
        if (d > worst) { worst = d; wi = i; }
      }
      if (worst > eps) { keep[wi] = 1; stack.push([se[0], wi], [wi, se[1]]); }
    }
    return pts.filter(function (p, i) { return keep[i]; });
  }
  function plateOfRegionCore(M, nx, ny, ox, oy, cellMm, pitchMm, widthMm, hatchDeg, minLoopMm, minLineMm) {
    var N = nx * ny, outline = concentricLoops(M, nx, ny, ox, oy, cellMm, pitchMm, widthMm, minLoopMm, 1);
    if (!outline.length) return { loops: [], lines: [] };
    var dist = edtCells(M, nx, ny), th = hatchDeg * Math.PI / 180, ux = Math.cos(th), uy = Math.sin(th), nxv = -uy, nyv = ux;
    /* the lines of a hatch over the cells of H: a lattice fixed in the plane, a pitch apart, each run of H a line (shorter than the minimum, none) */
    function hatchOver(H, minLen) {
      var lines = [], cmin = Infinity, cmax = -Infinity, tmin = Infinity, tmax = -Infinity;
      for (var j = 0; j < ny; j++) for (var i = 0; i < nx; i++) if (H[j * nx + i]) {
        var x = ox + i * cellMm, y = oy + j * cellMm, c = x * nxv + y * nyv, t = x * ux + y * uy;
        if (c < cmin) cmin = c; if (c > cmax) cmax = c; if (t < tmin) tmin = t; if (t > tmax) tmax = t;
      }
      var step = cellMm / 2;
      function inH(x, y) {
        var ii = Math.round((x - ox) / cellMm), jj = Math.round((y - oy) / cellMm);
        return ii >= 0 && ii < nx && jj >= 0 && jj < ny && H[jj * nx + ii] === 1;
      }
      for (var k = Math.ceil(cmin / pitchMm); k * pitchMm <= cmax; k++) {
        var cc = k * pitchMm, run = null;
        for (var tt = tmin - 4 * step; tt <= tmax + 4 * step; tt += step) {
          var px = cc * nxv + tt * ux, py = cc * nyv + tt * uy, on = inH(px, py);
          if (on && !run) run = [tt, tt];
          else if (on) run[1] = tt;
          else if (run) { if (run[1] - run[0] >= minLen) lines.push([[cc * nxv + run[0] * ux, cc * nyv + run[0] * uy], [cc * nxv + run[1] * ux, cc * nyv + run[1] * uy]]); run = null; }
        }
        if (run && run[1] - run[0] >= minLen) lines.push([[cc * nxv + run[0] * ux, cc * nyv + run[0] * uy], [cc * nxv + run[1] * ux, cc * nyv + run[1] * uy]]);
      }
      return lines;
    }
    function lenOf(lines) { var s = 0; lines.forEach(function (l) { s += Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1]); }); return s; }
    var edgeIn = 0.1 + widthMm + 0.1;      /* the hatch starts this far in from the edge: the outline's centre, then a line and a gap */
    var H = new Uint8Array(N), any = false, hCells = 0, mCells = 0, dMax = 0;
    for (var q = 0; q < N; q++) { mCells += M[q]; if (dist[q] > dMax) dMax = dist[q]; if (dist[q] >= edgeIn / cellMm + 0.5) { H[q] = 1; any = true; hCells++; } }
    var lines = any ? hatchOver(H, minLineMm) : [];
    /* a region the hatch mostly misses (a ring a couple of mm wide: its lines are cut short of the minimum, or never fit) is laid in concentric loops instead */
    if (!any || lenOf(lines) * pitchMm < HATCH_MIN_SHARE * hCells * cellMm * cellMm) {
      /* ... unless the lines alone, run edge to edge (a line's half in from the edge, no loop), hold the region: the zigzag of a narrow patch, as the slicer lays it */
      var Hw = new Uint8Array(N);
      for (var qw = 0; qw < N; qw++) if (dist[qw] >= (widthMm / 2 + 0.03) / cellMm + 0.5) Hw[qw] = 1;
      var wide = hatchOver(Hw, Math.max(0.5, minLineMm * 0.6));
      var wideOk = dMax * cellMm >= EDGE_HATCH_HALF_MM && wide.length >= 3 && lenOf(wide) * pitchMm >= EDGE_HATCH_SHARE * mCells * cellMm * cellMm;
      /* A RING of narrow bands and wide corners (a flat face round a cavity): its outline loops hold the bands, the hatch inside them the corners, on EVERY
         layer. Which of this and the edge-to-edge lines the share test above left was the hatch's angle, so the layers turned each other's way (55 % of the
         face held on one, 70 on the next, the lines of the other crossing a band they cannot fit); the one that lays more line is kept, this when it lays
         RING_OUTLINE_GAIN times what the lines alone do. */
      if (any && mCells * cellMm * cellMm >= RING_MIN_AREA_MM2) {          /* a big region that is narrow everywhere (a small patch keeps the lines edge to edge) */
        var inner = hatchOver(H, RING_LINE_MIN_MM), lenOut = lenOf(inner);
        outline.forEach(function (lp) { lenOut += lp.lenMm; });
        if (inner.length && (!wideOk || lenOut >= RING_OUTLINE_GAIN * lenOf(wide))) return { loops: outline, lines: inner };
      }
      if (wideOk) return { loops: [], lines: wide };
      return { loops: concentricLoops(M, nx, ny, ox, oy, cellMm, pitchMm, widthMm, minLoopMm), lines: [] };
    }
    return { loops: outline, lines: lines };
  }
  /* a mask with its edge smoothed: three box blurs of radius r cells (about a gaussian of 0.9 r) and the 0.5 level; a stepped edge (the height map's
     layers) and its spikes become a curve a loop can follow. The mask's own cells never grow past the blur: nothing is added more than r cells out. */
  function smoothMask(M, nx, ny, r) {
    var N = nx * ny, a = new Float32Array(N), b = new Float32Array(N), i, j, p, k, w = 2 * r + 1;
    for (i = 0; i < N; i++) a[i] = M[i] ? 1 : 0;
    for (p = 0; p < 3; p++) {
      for (j = 0; j < ny; j++) {
        var acc = 0;
        for (i = -r; i < nx + r; i++) {
          if (i + r < nx) acc += i + r >= 0 ? a[j * nx + i + r] : 0;
          if (i - r - 1 >= 0 && i - r - 1 < nx) acc -= a[j * nx + i - r - 1];
          if (i >= 0 && i < nx) b[j * nx + i] = acc / w;
        }
      }
      for (i = 0; i < nx; i++) {
        var acc2 = 0;
        for (j = -r; j < ny + r; j++) {
          if (j + r < ny) acc2 += j + r >= 0 ? b[(j + r) * nx + i] : 0;
          if (j - r - 1 >= 0 && j - r - 1 < ny) acc2 -= b[(j - r - 1) * nx + i];
          if (j >= 0 && j < ny) a[j * nx + i] = acc2 / w;
        }
      }
    }
    var out = new Uint8Array(N);
    for (k = 0; k < N; k++) out[k] = a[k] >= 0.5 ? 1 : 0;
    return out;
  }
  /* a closed polyline with the points that lie within eps of the line between their neighbours dropped (Douglas - Peucker, the ring cut at two far points) */
  function simplifyRing(ring, eps) {
    var pts = ring.slice(0, -1), n = pts.length;
    if (n < 4) return ring;
    function dp(a, b, keep) {
      var best = -1, bi = -1, ax = pts[a][0], ay = pts[a][1], bx = pts[b % n][0], by = pts[b % n][1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      for (var i = a + 1; i < b; i++) {
        var px = pts[i % n][0] - ax, py = pts[i % n][1] - ay, t = L2 > 1e-18 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0, ex = px - t * dx, ey = py - t * dy, dd = ex * ex + ey * ey;
        if (dd > best) { best = dd; bi = i; }
      }
      if (best > eps * eps) { keep[bi % n] = true; dp(a, bi, keep); dp(bi, b, keep); }
    }
    var far = 0, fd = -1;
    for (var k = 1; k < n; k++) { var dd2 = Math.hypot(pts[k][0] - pts[0][0], pts[k][1] - pts[0][1]); if (dd2 > fd) { fd = dd2; far = k; } }
    var keep = {}; keep[0] = true; keep[far] = true;
    dp(0, far, keep); dp(far, n, keep);
    var out = [];
    for (var q = 0; q < n; q++) if (keep[q]) out.push(pts[q]);
    if (out.length < 3) return ring;
    out.push(out[0].slice());
    return out;
  }

  function sheet(piece, stations, opts) {
    opts = opts || {};
    var TH = mod(opts, 'thickness', 'NSO_Thickness');
    var CH = mod(opts, 'crosshatch', 'NSO_Crosshatch');
    var RL = mod(opts, 'rasterLines', 'NSO_RasterLines');
    if (!TH || !CH || !RL) return { ok: false, reason: 'the sheet needs nso_thickness.js, nso_crosshatch.js and nso_raster_lines.js' };
    var o = {
      gap: opts.gapMm == null ? GAP_MM : +opts.gapMm,
      layer: opts.layerMm == null ? LAYER_MM : +opts.layerMm,
      sheetLayer: opts.sheetLayerMm > 0 ? +opts.sheetLayerMm : 0,            /* a flat plate's layers are this thick (Bambu's support layers: 0.275), 0: the layer's */
      width: opts.widthMm == null ? Math.round(TH.floorFor(opts.nozzle) * SHEET_UNDER * 100) / 100 : +opts.widthMm,
      pitch: opts.pitchMm == null ? SHEET_PITCH_MM : +opts.pitchMm,
      side: opts.sideMm == null ? 1.2 : +opts.sideMm,
      plateZ: opts.plateZ == null ? 0 : +opts.plateZ,
      foot: opts.footMm == null ? 0 : +opts.footMm,
      capRise: opts.capRiseMm == null ? CAP_RISE_MM : +opts.capRiseMm,
      capMin: opts.capMinMm == null ? CAP_MIN_MM : +opts.capMinMm,
      capMax: opts.capMaxMm == null ? CAP_MAX_MM : +opts.capMaxMm,
      slabEps: opts.slabEpsMm == null ? 0.12 : +opts.slabEpsMm,      /* how far the traced outline may stray from the mask's own edge when it is simplified */
      slab: opts.slabPlate === true || opts.slabPlate === 'weak' ? opts.slabPlate : false,                      /* a region plate laid as one solid footprint for the slicer to fill (slabOfMask), not as loops and lines */
      flare: opts.regionFlare === true,                                 /* a tip under a region plate ends in a flared cap, as Bambu's legs do (flareOf), not a bare column */
      eps: EPS_MM
    };
    if (!(o.pitch > o.width)) return { ok: false, reason: 'pitch ' + o.pitch + ' does not clear the ' + o.width + ' mm line' };
    var columns = opts.columns || [];
    var obstacles = [piece].concat(opts.occluders || []).filter(function (s) { return s && s.length >= 9; });
    var PPs = obstacles.map(function (s) { return prepared(TH, s); });
    /* the layers of a sheet: two of transition and as many of interface as asked (opts.interfaceLayers, 2 unless said: the clamp's
       reference; Bambu's own top interface layers are 3 in the six-heads reference). The interface layers alternate across and
       along the sheet's A from the first, as the reference's do. */
    var nI = opts.interfaceLayers == null ? 2 : Math.max(1, Math.min(6, Math.round(+opts.interfaceLayers)));
    /* THE FLAT SHEET'S REACH (opts.flatGapMaxMm, null: no limit): a level's field stops where the part's underside is further than
       this over the sheet's top. A flat sheet under a dome, a ball, a bowl reaches round it as far as its caps and the field go and
       leaves a gap that grows to millimetres at its rim; held to a reach, it is a plate under the pole, with the gap it has there. */
    var flatMax = opts.flatGapMaxMm == null ? null : +opts.flatGapMaxMm, reachMemo = new Map();
    /* THE PART'S OUTLINE (opts.perimeter, off unless true: the card asks): a cap or a line of the sheet lies where the part is over it, not out over
       the air past the part's edge - a tip standing at the edge of the surface (a rim's corner) had a cap and a field that hung off it
       (docs/SUPPORT-FOOTPRINT.md). A level that has no sheet inside the outline is built again without it, as it was. */
    var regionOn = false, regionWanted = opts.regionPlate === true, fillOn = false, wantPerim = opts.perimeter === true, perimOn = wantPerim, perimMargin = PERIM_MARGIN_MM, perimMemo = new Map();
    /* is the part over (x, y), within the reach, from a stack's top up? (the cell a sample falls in, read once) */
    /* THE CONTACT SURFACE'S OWN OUTLINE (opts.footprints, from nso_support_beacons.js footprintsOf: the areas' footprints): where the card has it,
       "the part is over (x, y)" is "(x, y) is on the surface a stack of this height holds" - the loops, not a silhouette - and the field fills it
       (THE FILL), whatever the tips that were planned for it. */
    var feet = ((wantPerim || regionWanted) && Array.isArray(opts.footprints) && opts.footprints.length) ? opts.footprints.map(function (f) {
      var b = [Infinity, Infinity, -Infinity, -Infinity];
      f.loops.forEach(function (L) { L.forEach(function (q) { b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); }); });
      return { zl: f.zl, zh: f.zh, loops: f.loops, box: b, marginMm: typeof f.marginMm === 'number' ? f.marginMm : null };   /* marginMm: a footprint the user painted over keeps the plate to the edge */
    }) : null;
    function inFeet(x, y, zc) {
      for (var fi = 0; fi < feet.length; fi++) {
        var f = feet[fi];
        if (zc < f.zl - 0.5 || zc > f.zh + 1.5 || x < f.box[0] || x > f.box[2] || y < f.box[1] || y > f.box[3]) continue;
        var inn = false;
        for (var li = 0; li < f.loops.length; li++) {
          var L = f.loops[li];
          for (var q = 0, w = L.length - 1; q < L.length; w = q++) {
            if ((L[q][1] > y) !== (L[w][1] > y) && x < (L[w][0] - L[q][0]) * (y - L[q][1]) / (L[w][1] - L[q][1]) + L[q][0]) inn = !inn;
          }
        }
        if (inn) return true;
      }
      return false;
    }
    function perimOver(x, y, zTop) {
      var byFeet = feet && fillOn, kq = Math.round(x / CELL_MM) + ',' + Math.round(y / CELL_MM) + ',' + zTop.toFixed(3) + (byFeet ? 'f' : ''), v = perimMemo.get(kq);
      if (v === undefined) { v = byFeet ? inFeet(x, y, zTop + o.gap) : isFinite(firstHit(x, y, zTop + 0.01, o.gap + PERIM_REACH_MM)); perimMemo.set(kq, v); }
      return v;
    }
    var fillMemo = new Map();
    function fillReach(x, y, zTop) {
      var kq = Math.round(x / CELL_MM) + ',' + Math.round(y / CELL_MM) + ',' + zTop.toFixed(3), v = fillMemo.get(kq);
      if (v === undefined) { v = isFinite(firstHit(x, y, zTop + 0.01, o.gap + FILL_REACH_MM)); fillMemo.set(kq, v); }
      return v;
    }
    var ROLES = ['transition', 'transition'];
    for (var ri = 0; ri < nI; ri++) ROLES.push('interface');
    /* each obstacle's side of exactDistance, built once for the cell the reach asks for */
    var obsEx = [];
    function exactVs(i, reach) {
      var h = obsEx[i];
      if (!h || h.cell !== Math.max(1, reach * 4)) h = obsEx[i] = exactPrep(obstacles[i], reach);
      return h;
    }
    if (!(o.sheetLayer > 0)) o.sheetLayer = o.layer;
    var NL = ROLES.length, stackH = NL * o.sheetLayer;
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
    var toldLast = 0;
    function told(extra) {
      if (!tell) return;
      var d = settled + (extra || 0);
      levels.forEach(function (L) { d += L.told || 0; });
      d = Math.min(nTips, Math.max(d, toldLast));                /* never down: a plate that is dropped after some of its tips were said done does not take the count back */
      toldLast = d;
      try { tell(d, nTips); } catch (err) { /* a listener must not stop the sheet */ }
    }
    /* the queries below are asked again and again with the same numbers - a level is built several times (the old way, the outline, its
       steps) and a cap's rim is tried at the same places - and the piece does not move: each answer is kept by its arguments */
    var qHit = new Map(), qFirst = new Map(), qIn = new Map(), qNear = new Map(), qRay = new Map();
    function hitIn(x, y, z0, z1) {
      var k = x + ',' + y + ',' + z0 + ',' + z1, v = qHit.get(k);
      if (v === undefined) {
        v = false;
        for (var i = 0; i < PPs.length && !v; i++) if (PPs[i].hitsAlong([x, y, z0], [0, 0, 1], z1 - z0).length) v = true;
        qHit.set(k, v);
      }
      return v;
    }
    function firstHit(x, y, z0, len) {
      var k = x + ',' + y + ',' + z0 + ',' + len, best = qFirst.get(k);
      if (best === undefined) {
        best = Infinity;
        for (var i = 0; i < PPs.length; i++) {
          var hs = PPs[i].hitsAlong([x, y, z0], [0, 0, 1], len);
          if (hs.length && hs[0] < best) best = hs[0];
        }
        qFirst.set(k, best);
      }
      return best;
    }
    function inside(p) {
      var k = p[0] + ',' + p[1] + ',' + p[2], v = qIn.get(k);
      if (v === undefined) {
        v = false;
        for (var i = 0; i < PPs.length && !v; i++) if (PPs[i].inside(p)) v = true;
        qIn.set(k, v);
      }
      return v;
    }
    function nearestMm(p, r) {
      var best = Infinity;
      for (var i = 0; i < PPs.length; i++) { var nr = PPs[i].nearest(p, r); if (nr && nr.dist < best) best = nr.dist; }
      return best;
    }
    function nearestPt(p, r) {
      var k = p[0] + ',' + p[1] + ',' + p[2] + ',' + r, best = qNear.get(k);
      if (best === undefined) {
        best = null;
        for (var i = 0; i < PPs.length; i++) { var nr = PPs[i].nearest(p, r); if (nr && (!best || nr.dist < best.dist)) best = nr; }
        qNear.set(k, best);
      }
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
      /* ROOM: the cut must leave a tip under the stack and its cap, above its foot. Where there is room for the tip and
         not for its cap (a ceiling rising from the plate: the low side of a tipped piece), the tip is cut flat under
         the stack with no cap, the column's own top carrying T1 - as a tip whose cap has no room anywhere else. */
      if (!col) { t.mode = 'gap'; t.why = 'no room for the stack and its cap above the plate'; }
      else if (!(t.zBase - Math.max(o.side, o.capRise) - ROOM_MM > o.plateZ + o.foot)) {
        if (t.zBase - o.side - o.plateZ - o.foot >= LOW_ROOM_MM) t.lowRoom = true;
        else { t.mode = 'gap'; t.why = 'no room for the stack and its cap above the plate'; }
      }
    });

    var tipOfCol = {};
    tips.forEach(function (t) { tipOfCol[t.col] = t; });

    /* =====================================================================
       THE REGION PLATE (opts.regionPlate, docs/SUPPORT-FOOTPRINT.md section 9): where the card knows a surface's footprint (opts.footprints), the
       interface and the transition under it are laid from the footprint and the surface's height alone, not from the tips: for every print layer the
       cells whose stack (the transition layers under the interface layers, one stack of NL layers) takes that layer - a column's stack ends the gap under
       the surface - an outline loop hugging the region's edge and a hatch inside it, alternating 45 / 135 deg, as Bambu lays a raft and its interface.
       A flat face is one level; a dome or a curve grows and shrinks layer by layer. The tips inside the footprint stand under it, each cut to the
       plate's bottom where it is. A footprint that is one planar slope (a stair's: STAIR_MIN_DEG) is left to the stair. Checked as a sheet is (the exact
       distance to the part, the other columns); a plate that fails any is not built and the footprint goes the ordinary way.
       ===================================================================== */
    var shellLevels = [];
    function shellPass() {
      if (!regionWanted || !feet)return;
      var CELLS = 0.1, MARGIN = REGION_MARGIN_MM;
      var zLowAll = Infinity;                     /* the lowest footprint: Bambu's support layer grid is anchored there (below the first sheet's top: the sheet's layers; above it, where surfaces slope, the part's) */
      feet.forEach(function (f) { if (f.zl < zLowAll) zLowAll = f.zl; });
      /* the small footprints first: their tips are counted (the card's Building starts moving) before the large one is done */
      feet.map(function (f, fi) { return fi; }).sort(function (a, b) { return (feet[a].box[2] - feet[a].box[0]) * (feet[a].box[3] - feet[a].box[1]) - (feet[b].box[2] - feet[b].box[0]) * (feet[b].box[3] - feet[b].box[1]); }).forEach(function (fi) {
        var f = feet[fi];
        /* a hole in the footprint smaller than REGION_HOLE_FILL_MM2 is part of the surface (the crest of a cavity's apex: a cone 0.2 - 0.4 mm over its rim, a
           square millimetre or two the detector traces as a hole, and Bambu holds): the plate is laid over it */
        var plateLoops = f.loops.filter(function (Lp) {
          var a = 0;
          for (var q0 = 0; q0 < Lp.length; q0++) { var u0 = Lp[q0], v0 = Lp[(q0 + 1) % Lp.length]; a += u0[0] * v0[1] - v0[0] * u0[1]; }
          return !(a < 0 && -a / 2 < REGION_HOLE_FILL_MM2);                   /* the detector's holes run clockwise */
        });
        function inFoot(x, y) {
          if (x < f.box[0] || x > f.box[2] || y < f.box[1] || y > f.box[3]) return false;
          var inn = false;
          for (var li = 0; li < plateLoops.length; li++) {
            var Lp = plateLoops[li];
            for (var q = 0, w = Lp.length - 1; q < Lp.length; w = q++) if ((Lp[q][1] > y) !== (Lp[w][1] > y) && x < (Lp[w][0] - Lp[q][0]) * (y - Lp[q][1]) / (Lp[w][1] - Lp[q][1]) + Lp[q][0]) inn = !inn;
          }
          return inn;
        }
        /* a tip whose contact stands at the footprint's edge (the Oblique strip's, 0.25 mm beyond its apex) is the plate's
           as well: it was left a column the plate carved its clearance from, and a strip 2 mm wide went bare */
        function nearFoot(x, y) {
          if (inFoot(x, y)) return true;
          for (var da = 0; da < 8; da++) if (inFoot(x + REGION_TIP_NEAR_MM * Math.cos(da * Math.PI / 4), y + REGION_TIP_NEAR_MM * Math.sin(da * Math.PI / 4))) return true;
          return false;
        }
        var mine = cand.filter(function (t) { return t.mode === 'sheet' && !t.shell && t.contact[2] >= f.zl - 0.5 && t.contact[2] <= f.zh + 1.5 && nearFoot(t.contact[0], t.contact[1]); });
        if (!mine.length)return;
        var ox = f.box[0] - 1, oy = f.box[1] - 1, nx = Math.ceil((f.box[2] - f.box[0] + 2) / CELLS) + 1, ny = Math.ceil((f.box[3] - f.box[1] + 2) / CELLS) + 1, N = nx * ny;
        /* the surface's height over the footprint, read on a 0.2 mm lattice and kept by the nearest */
        var S = new Float32Array(N).fill(NaN), fp = new Uint8Array(N), STEP = 2, zs = [];
        for (var j0 = 0; j0 < ny; j0 += STEP, beat()) for (var i0 = 0; i0 < nx; i0 += STEP) {
          var x0 = ox + i0 * CELLS, y0 = oy + j0 * CELLS;
          if (!inFoot(x0, y0)) continue;
          var zStart = f.zl - SHELL_START_MM;
          var h = firstHit(x0, y0, zStart, f.zh - zStart + 3);
          if (isFinite(h) && zStart + h <= f.zh + 1.0) { S[j0 * nx + i0] = zStart + h; fp[j0 * nx + i0] = 1; zs.push(zStart + h); }     /* a hit far above the footprint is a stem's or another face's, not its underside */
        }
        told(Math.round(0.1 * mine.length));          /* the setup is told as it goes (a footprint's first second is not a still bar): a tenth after the surface is read, */
        if (zs.length < 30) return;
        zs.sort(function (a, b) { return a - b; });
        var zLoQ = zs[Math.floor(zs.length * 0.02)], zHiQ = zs[Math.floor(zs.length * 0.98)], range = zHiQ - zLoQ;
        if (range > REGION_FLAT_MM) {
          /* a plane (a stair's) stays the stair's; a curve is the plate's */
          var sx = 0, sy = 0, sz = 0, cnt = 0, pts = [];
          for (var jp = 0; jp < ny; jp += STEP) for (var ip = 0; ip < nx; ip += STEP) if (fp[jp * nx + ip]) { pts.push([ox + ip * CELLS, oy + jp * CELLS, S[jp * nx + ip]]); sx += pts[pts.length - 1][0]; sy += pts[pts.length - 1][1]; sz += pts[pts.length - 1][2]; cnt++; }
          var mx = sx / cnt, my = sy / cnt, mz = sz / cnt, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
          pts.forEach(function (p) { var a = p[0] - mx, b = p[1] - my, c = p[2] - mz; sxx += a * a; sxy += a * b; syy += b * b; sxz += a * c; syz += b * c; });
          var det = sxx * syy - sxy * sxy, resid = 0;
          if (Math.abs(det) > 1e-9) {
            var ga = (sxz * syy - syz * sxy) / det, gb = (syz * sxx - sxz * sxy) / det;
            pts.forEach(function (p) { resid = Math.max(resid, Math.abs(p[2] - mz - ga * (p[0] - mx) - gb * (p[1] - my))); });
            var slopeDeg = Math.atan(Math.hypot(ga, gb)) * 180 / Math.PI;
            if (resid <= Math.max(REGION_PLANE_MM, REGION_PLANE_SHARE * range) && slopeDeg >= STAIR_MIN_DEG && slopeDeg <= STAIR_MAX_DEG && !(opts.regionSlopes === true && o.sheetLayer !== o.layer)) return;     /* Dense: a planar slope is the region plate's too (Bambu's ribbon), not the stair's rungs */
          }
        }
        /* fill the lattice's cells; a flat face takes its lowest height */
        for (var jf = 0; jf < ny; jf++) for (var iff = 0; iff < nx; iff++) {
          var q0 = jf * nx + iff;
          if (fp[q0]) continue;
          var xf = ox + iff * CELLS, yf = oy + jf * CELLS;
          if (!inFoot(xf, yf)) continue;
          var ia = iff - (iff % STEP), ja = jf - (jf % STEP), best = NaN;
          for (var dj = 0; dj <= STEP; dj += STEP) for (var di = 0; di <= STEP; di += STEP) {
            var qa = Math.min(ny - 1, ja + dj) * nx + Math.min(nx - 1, ia + di);
            if (fp[qa] === 1 && (isNaN(best) || S[qa] < best)) best = S[qa];      /* the lowest of the four lattice heights round it: never over the surface */
          }
          if (!isNaN(best)) { S[q0] = best; fp[q0] = 2; }
        }
        for (var q1 = 0; q1 < N; q1++) if (fp[q1] === 1) fp[q1] = 1;
        var inRegion = new Uint8Array(N);
        for (var q2 = 0; q2 < N; q2++) inRegion[q2] = fp[q2] && !isNaN(S[q2]) ? 1 : 0;
        if (range <= REGION_FLAT_MM) for (var q3 = 0; q3 < N; q3++) if (inRegion[q3]) S[q3] = zs[0];
        told(Math.round(0.3 * mine.length));          /* three tenths after the fill, */
        var dEdge = edtCells(inRegion, nx, ny), usable = new Uint8Array(N), nUse = 0;
        var margin = f.marginMm != null ? f.marginMm : MARGIN;
        for (var q4 = 0; q4 < N; q4++) if (inRegion[q4] && (dEdge[q4] - 0.5) * CELLS >= margin) { usable[q4] = 1; nUse++; }
        if (nUse * CELLS * CELLS < (f.marginMm != null ? 0.8 : 4))return;               /* a region the user painted may be small */
        /* the other columns - every one this footprint's tips do not stand - keep their clearance from the plate, wherever they pass through its height */
        var carriers = {};
        mine.forEach(function (t) { carriers[t.col] = true; });
        function carve(radTest) {
          columns.forEach(function (col, ci) {
            if (carriers[ci] || !col || !col.pts || !col.pts.length)return;
            if (tipOfCol[ci] && tipOfCol[ci].mode === 'drop')return;
            var rad = col.side * Math.SQRT1_2 + COLUMN_CLEAR_MM + o.width / 2;
            var cb = [Infinity, Infinity, -Infinity, -Infinity];
            col.pts.forEach(function (q) { cb[0] = Math.min(cb[0], q[0]); cb[1] = Math.min(cb[1], q[1]); cb[2] = Math.max(cb[2], q[0]); cb[3] = Math.max(cb[3], q[1]); });
            if (cb[0] - rad > f.box[2] || cb[2] + rad < f.box[0] || cb[1] - rad > f.box[3] || cb[3] + rad < f.box[1])return;
            for (var k = 0; k + 1 < Math.max(2, col.pts.length); k++) {
              var a = col.pts[k], b = col.pts[Math.min(k + 1, col.pts.length - 1)];
              if (Math.min(a[2], b[2]) - col.side > f.zh + 1.5) continue;
              if (Math.max(a[2], b[2]) + col.side < zLoQ - stackH - o.gap) continue;
              var x0c = Math.min(a[0], b[0]) - rad, x1c = Math.max(a[0], b[0]) + rad, y0c = Math.min(a[1], b[1]) - rad, y1c = Math.max(a[1], b[1]) + rad;
              var ic0 = Math.max(0, Math.floor((x0c - ox) / CELLS)), ic1 = Math.min(nx - 1, Math.ceil((x1c - ox) / CELLS)), jc0 = Math.max(0, Math.floor((y0c - oy) / CELLS)), jc1 = Math.min(ny - 1, Math.ceil((y1c - oy) / CELLS));
              var ex = b[0] - a[0], ey = b[1] - a[1], ee = ex * ex + ey * ey;
              for (var jc = jc0; jc <= jc1; jc++) for (var ic = ic0; ic <= ic1; ic++) {
                var qc = jc * nx + ic;
                if (!usable[qc]) continue;
                var px = ox + ic * CELLS - a[0], py = oy + jc * CELLS - a[1], fr = ee > 1e-18 ? Math.max(0, Math.min(1, (px * ex + py * ey) / ee)) : 0;
                if (Math.hypot(px - fr * ex, py - fr * ey) <= rad) usable[qc] = 0;
              }
            }
          });
        }
        carve();
        /* every column's stack: its top layer m (the top at or under the surface less the gap), NL layers deep; layers counted from the lowest column's top */
        /* under a slope the gap is the perpendicular one: a column is held gap / cos(tilt) under the surface (the local slope, from the lattice's 0.2 mm steps) */
        var gapAt = new Float32Array(N);
        for (var qg2 = 0; qg2 < N; qg2++) {
          if (!inRegion[qg2]) continue;
          var gi = qg2 % nx, gj = (qg2 - gi) / nx, gmax = 0;
          for (var dg = 0; dg < 4; dg++) {
            var gi2 = gi + (dg === 0 ? 2 : dg === 1 ? -2 : 0), gj2 = gj + (dg === 2 ? 2 : dg === 3 ? -2 : 0);
            if (gi2 < 0 || gi2 >= nx || gj2 < 0 || gj2 >= ny || !inRegion[gj2 * nx + gi2]) continue;
            gmax = Math.max(gmax, Math.abs(S[qg2] - S[gj2 * nx + gi2]) / (2 * CELLS));
          }
          gapAt[qg2] = o.gap * Math.sqrt(1 + gmax * gmax) + (o.width / 2 + 0.03) * gmax;   /* a bead is a line wide: on a slope its downhill edge stands lower than its middle */
        }
        var A = zs[0] - o.gap, m = new Int32Array(N).fill(-99999), mmin = 1e9, mmax = -1e9;
        for (var q5 = 0; q5 < N; q5++) {
          if (!usable[q5]) continue;
          m[q5] = Math.floor((S[q5] - (range <= REGION_FLAT_MM ? o.gap : gapAt[q5]) - A) / o.layer + 1e-4) - 1;     /* the lowest flat stands on a layer's edge: float32 noise (1e-8 mm) must not push it a layer down */
          if (m[q5] < mmin) mmin = m[q5]; if (m[q5] > mmax) mmax = m[q5];
        }
        if (mmin > mmax)return;
        /* THE PART'S OWN WALLS beside the plate (a stem, a tab hanging below the face): a vertical wall is no face a vertical ray meets, so the cells round
           the region are read at the stack's heights for being inside the piece, and the plate keeps its clearance - the gap, a half line - from them */
        (function () {
          var clear = o.gap + o.width / 2 + 0.03, Rw = Math.ceil((clear + 0.5) / CELLS), blocked = new Uint8Array(N), anyB = false;
          var dNear = edtCells((function () { var inv = new Uint8Array(N); for (var q = 0; q < N; q++) inv[q] = usable[q] ? 0 : 1; return inv; })(), nx, ny);
          /* the stack height beside the region: each ring cell takes it from a neighbour nearer in, one cell a pass */
          var mNear = new Int32Array(N).fill(-99999);
          for (var qn = 0; qn < N; qn++) if (usable[qn]) mNear[qn] = m[qn];
          for (var pass = 0; pass < Rw; pass++) {
            var prev = mNear.slice();
            for (var jn = 1; jn < ny - 1; jn++) for (var inn = 1; inn < nx - 1; inn++) {
              var qq2 = jn * nx + inn;
              if (prev[qq2] !== -99999) continue;
              var v2 = prev[qq2 - 1] !== -99999 ? prev[qq2 - 1] : prev[qq2 + 1] !== -99999 ? prev[qq2 + 1] : prev[qq2 - nx] !== -99999 ? prev[qq2 - nx] : prev[qq2 + nx];
              if (v2 !== -99999) mNear[qq2] = v2;
            }
          }
          for (var jw = 0; jw < ny; jw++, beat()) for (var iw = 0; iw < nx; iw++) {
            var qw = jw * nx + iw;
            if (usable[qw] || dNear[qw] * CELLS > clear) continue;                /* a wall further than the clearance from every cell of the plate takes none of it */
            var mw = mNear[qw];
            if (mw === -99999) continue;
            var zB = A + (mw - NL + 1) * o.layer, zT = A + (mw + 1) * o.layer, xw = ox + iw * CELLS, yw = oy + jw * CELLS;
            /* a point of the part within the clearance, level with the stack's bottom or middle (the face above is further than that from either) */
            if (nearestMm([xw, yw, (zB + zT) / 2], clear + 0.02) < clear) { blocked[qw] = 1; anyB = true; }
          }
          if (!anyB)return;
          var dB = edtCells((function () { var inv = new Uint8Array(N); for (var q = 0; q < N; q++) inv[q] = blocked[q] ? 0 : 1; return inv; })(), nx, ny);
          for (var q8 = 0; q8 < N; q8++) if (usable[q8] && dB[q8] * CELLS < clear) usable[q8] = 0;
        })();
        told(Math.round(0.5 * mine.length));          /* half once the walls stand; the layers carry it from there to 95 % */
        mmin = 1e9; mmax = -1e9;
        for (var q9 = 0; q9 < N; q9++) if (usable[q9]) { if (m[q9] < mmin) mmin = m[q9]; if (m[q9] > mmax) mmax = m[q9]; }
        if (mmin > mmax)return;
        /* THE SHEET'S OWN LAYERS (Dense): Bambu cuts its supports on a grid of their own - the lowest stack's top is an anchor, below it the layers are the sheet's thickness
           (0.275, 5 of them 1.375 mm), above it the part's 0.2 - and a stack is the 5 grid layers under a cell's top. A stack's bottom is where that puts it; a flat plate is one stack,
           a plate that steps (a slope, a dome's flank) has stacks of 1.375 at its low end and 1.0 above, and the slicer's own typing then finds the 2 transition and 3 interface layers
           of each column. The plate is laid in BANDS: between each two heights a stack starts or ends at */
        var gridMode = o.sheetLayer !== o.layer && (mmin === mmax || zs[0] <= zLowAll + 0.5), gTop = A + (mmin + 1) * o.layer;
        var botOfM = function (mq) { var j = mq - mmin; return !gridMode ? A + (mq - NL + 1) * o.layer : (j >= NL ? A + (mq + 1) * o.layer - NL * o.layer : gTop - (NL - j) * o.sheetLayer); };
        var topOfM = function (mq) { return A + (mq + 1) * o.layer; };
        var bands = [], zLow = botOfM(mmin);
        if (!gridMode) {
          for (var nb = mmin - NL + 1; nb <= mmax; nb++) bands.push({ n: nb, zb: A + nb * o.layer, h: o.layer, has: (function (nn) { return function (mq) { return nn <= mq && nn >= mq - NL + 1; }; })(nb) });
        } else {
          var seenM = {}, brk = [];
          for (var qm = 0; qm < N; qm++) if (usable[qm] && !seenM[m[qm]]) { seenM[m[qm]] = 1; brk.push(botOfM(m[qm]), topOfM(m[qm])); }
          brk.sort(function (a, b) { return a - b; });
          var ub = brk.filter(function (v, k) { return !k || v - brk[k - 1] > 1e-6; });
          for (var kb = 0; kb + 1 < ub.length; kb++) bands.push({ n: kb, zb: ub[kb], h: ub[kb + 1] - ub[kb], has: (function (lo, hi) { return function (mq) { return botOfM(mq) <= lo + 1e-6 && topOfM(mq) >= hi - 1e-6; }; })(ub[kb], ub[kb + 1]) });
        }
        /* the tips this plate carries: where the plate is under the tip's contact */
        var carry = mine.filter(function (t) {
          var ic = Math.round((t.contact[0] - ox) / CELLS), jc = Math.round((t.contact[1] - oy) / CELLS);
          var low = null;
          for (var dj2 = -2; dj2 <= 2; dj2++) for (var di2 = -2; di2 <= 2; di2++) { var qq = (jc + dj2) * nx + ic + di2; if (ic + di2 >= 0 && ic + di2 < nx && jc + dj2 >= 0 && jc + dj2 < ny && usable[qq] && (low === null || m[qq] < low)) low = m[qq]; }
          if (low === null) return false;
          t.shellM = low;                       /* the lowest stack within 0.2 mm of the tip: its column always reaches */
          return true;
        });
        if (!carry.length)return;
        var layersOut = [], soups = [], soupsLoops = [], failed = null, totalLen = 0;
        var maskLayers = [];                    /* each laid layer's traced mask (the cells it covers), to find the lowest layer a tip stands under */
        for (var bn = 0; bn < bands.length && !failed; bn++, beat()) {
          var BD = bands[bn], n = BD.n, thk = BD.h;
          told(Math.floor(carry.length * (0.5 + 0.45 * bn / Math.max(1, bands.length))));
          var Mk = new Uint8Array(N), any = false;
          for (var q6 = 0; q6 < N; q6++) if (usable[q6] && BD.has(m[q6])) { Mk[q6] = 1; any = true; }
          if (!any) continue;
          var Mraw = Mk;
          var zb = BD.zb, pl = null, paths = null, ex2 = null;
          for (var tryN = 0; tryN < 5; tryN++) {
            /* a layer the extrusion refuses is asked again with more room between its walls, then as its loops alone */
            beat();
            /* the layer's region cropped to its own box (and a margin for the blur and the opening): the distance transforms run over that, not the whole footprint */
            var cI0 = nx, cI1 = -1, cJ0 = ny, cJ1 = -1;
            for (var qb = 0; qb < N; qb++) if (Mraw[qb]) { var bi = qb % nx, bj = (qb - bi) / nx; if (bi < cI0) cI0 = bi; if (bi > cI1) cI1 = bi; if (bj < cJ0) cJ0 = bj; if (bj > cJ1) cJ1 = bj; }
            cI0 = Math.max(0, cI0 - 14); cJ0 = Math.max(0, cJ0 - 14); cI1 = Math.min(nx - 1, cI1 + 14); cJ1 = Math.min(ny - 1, cJ1 + 14);
            var cnx = cI1 - cI0 + 1, cny = cJ1 - cJ0 + 1, Mcrop = new Uint8Array(cnx * cny);
            for (var cj = 0; cj < cny; cj++) for (var ci2 = 0; ci2 < cnx; ci2++) Mcrop[cj * cnx + ci2] = Mraw[(cJ0 + cj) * nx + cI0 + ci2];
            Mk = smoothMask(Mcrop, cnx, cny, 1 + Math.min(tryN, 3));                 /* a layer the extrusion refuses is traced again from a smoother mask */
            var weak = false;
            if (o.slab === 'weak') {                                          /* the plate of loops and lines, asked first: a slab only where it leaves the region thin (a crescent, a ring: 50 - 66 %) */
              var plc = plateOfRegion(Mk, cnx, cny, ox + cI0 * CELLS, oy + cJ0 * CELLS, CELLS, o.pitch + 0.03, o.width, (n % 2 ? 135 : 45), REGION_MIN_LOOP_MM, 0.9);
              weak = (plc.loops.length > 0 || plc.lines.length > 0) && coverShare(Mk, cnx, cny, ox + cI0 * CELLS, oy + cJ0 * CELLS, CELLS, o.width, plc.loops.map(function (l) { return l.ring; }).concat(plc.lines, plc.thin)) < SLAB_WEAK_SHARE;
            }
            if (o.slab === true || weak) {
              var sl = slabOfMask(Mk, cnx, cny, ox + cI0 * CELLS, oy + cJ0 * CELLS, CELLS, zb, zb + thk, o.slabEps);
              if (sl) {
                var slLen = 0; sl.rings.forEach(function (r) { for (var k = 1; k < r.length; k++) slLen += Math.hypot(r[k][0] - r[k - 1][0], r[k][1] - r[k - 1][1]); });
                pl = { loops: sl.rings.map(function (r) { return { ring: r, lenMm: 0 }; }), lines: [], thin: [], slab: true };
                pl.loops[0].lenMm = slLen;
                paths = sl.rings; ex2 = { ok: true, tris: sl.tris };
                break;
              }
            }
            pl = plateOfRegion(Mk, cnx, cny, ox + cI0 * CELLS, oy + cJ0 * CELLS, CELLS, o.pitch + 0.03 + 0.04 * Math.min(tryN, 2), o.width + 0.03 * Math.min(tryN, 2), (n % 2 ? 135 : 45), REGION_MIN_LOOP_MM, 0.9 + 0.4 * tryN);
            if (tryN >= 1) pl.thin = [];                                       /* the thin beads go first when a layer is refused: the loops and the hatch are the plate */
            if (tryN >= 2) pl.lines = [];
            if (tryN === 3) { var longest = 0; pl.loops.forEach(function (l) { longest = Math.max(longest, l.lenMm); }); pl.loops = pl.loops.filter(function (l) { return l.lenMm >= Math.min(longest, 8); }); }
            if (tryN === 4) { var lg = null; pl.loops.forEach(function (l) { if (!lg || l.lenMm > lg.lenMm) lg = l; }); pl.loops = lg ? [lg] : []; }
            if (!pl.loops.length && !pl.thin.length && !pl.lines.length) break;
            paths = pl.loops.map(function (l) { return l.ring; }).concat(pl.lines, pl.thin);
            ex2 = RL.extrudeFlat(paths, { width: o.width, height: thk, baseZ: zb });
            if (ex2.ok) break;
          }
          var exLoops = ex2 && ex2.ok && pl.lines.length ? RL.extrudeFlat(pl.loops.map(function (l) { return l.ring; }).concat(pl.thin), { width: o.width, height: thk, baseZ: zb }) : ex2;
          if (!pl.loops.length && !pl.thin.length && !pl.lines.length) continue;
          if (!ex2.ok) { failed = 'layer ' + n + ' would not extrude: ' + ex2.reason; break; }
          var len = 0, lo = [Infinity, Infinity], hi = [-Infinity, -Infinity], area = 0;
          pl.loops.forEach(function (l) { len += l.lenMm; });
          pl.lines.forEach(function (l) { len += Math.hypot(l[1][0] - l[0][0], l[1][1] - l[0][1]); });
          pl.thin.forEach(function (pp) { for (var k = 1; k < pp.length; k++) len += Math.hypot(pp[k][0] - pp[k - 1][0], pp[k][1] - pp[k - 1][1]); });
          paths.forEach(function (pa) { pa.forEach(function (q) { lo[0] = Math.min(lo[0], q[0]); lo[1] = Math.min(lo[1], q[1]); hi[0] = Math.max(hi[0], q[0]); hi[1] = Math.max(hi[1], q[1]); }); });
          for (var q7 = 0; q7 < N; q7++) area += Mraw[q7];
          area *= CELLS * CELLS; totalLen += len;
          var piece = { kind: 'region', sizeMm: [hi[0] - lo[0], hi[1] - lo[1]], areaMm2: area, perimMm: len, caps: carry.length, lines: pl.lines.length + pl.loops.length + pl.thin.length, loop: paths[0], snake: [] };
          layersOut.push({ role: (gridMode ? BD.zb - zLow < 2 * o.sheetLayer - 1e-6 : n - (mmin - NL + 1) < 2) ? 'transition' : 'interface', angleDeg: n % 2 ? 135 : 45, z0: zb, z1: zb + thk, pieces: [piece], loopMm: piece.sizeMm.slice(), lines: piece.lines, linesMm: len, lengthMm: len,
                          shortestMm: 0, paths: paths, soup: ex2.tris });
          soups.push(ex2.tris); soupsLoops.push(exLoops && exLoops.ok ? exLoops.tris : ex2.tris);
          maskLayers.push({ zb: zb, M: Mk, i0: cI0, j0: cJ0, w: cnx, h: cny, x0: ox + cI0 * CELLS, y0: oy + cJ0 * CELLS, cell: CELLS });
        }
        if (failed || !layersOut.length) return;
        /* the plate against the part: no nearer than the gap (a stem beside it, a wall) */
        /* the loops, not the hatch: a hatch line ends a line and a gap short of them and lies level with them, so it is no nearer the part */
        var soupAll = joinSoups(soupsLoops), dmin = Infinity, rch = o.gap + 0.1;
        for (var bi = 0; bi < obstacles.length; bi++) { var dd = exactDistance(soupAll, exactVs(bi, rch), rch, beat); if (dd.mm < dmin) dmin = dd.mm; }
        if (dmin < o.gap - 1e-5) return;
        var zBaseMin = botOfM(mmin), zTopMax = A + (mmax + 1) * o.layer;
        var L = { id: levels.length, first: zTopMax, tips: carry, told: carry.length, ok: true, shell: true, minDistanceMm: dmin,
                  res: { zTop: zTopMax, zBase: zBaseMin, zCap: zBaseMin, layers: layersOut, uncrossed: [], region: true,
                         lines: { angleDeg: 0, droppedShare: 0, bare: 0, pieces: layersOut.length, tried: [] } } };
        levels.push(L); shellLevels.push(L);
        settled += carry.length; L.told = 0; told();                    /* the tips this plate carries are done: said now, not when every footprint has been read */
        carry.forEach(function (t) {
          var mm = t.shellM;
          t.shell = true; t.mode = 'sheet'; t.level = L.id; t.why = null; t.carried = true; t.cap = null; t.capWhy = 'no cap: the region plate lies on the tip itself';
          t.shellB = botOfM(mm); t.zTop = A + (mm + 1) * o.layer; t.zBase = t.shellB;
          /* the plate's lowest layer THAT COVERS the tip: the stack the tip's cell calls the lowest may be a speck the traced mask drops (a bead a cell wide), and the
             plate there begins a layer higher - the tip then ends a layer short of it, a gap in the column under the sheet */
          (function () {
            var ic = Math.round((t.contact[0] - ox) / CELLS), jc = Math.round((t.contact[1] - oy) / CELLS);
            for (var li = 0; li < maskLayers.length; li++) {
              var ml = maskLayers[li], hit = false;
              if (ml.zb < t.shellB - 1e-6) continue;
              for (var dj3 = -2; dj3 <= 2 && !hit; dj3++) for (var di3 = -2; di3 <= 2 && !hit; di3++) {
                var ci3 = ic + di3 - ml.i0, cj3 = jc + dj3 - ml.j0;
                if (ci3 >= 0 && ci3 < ml.w && cj3 >= 0 && cj3 < ml.h && ml.M[cj3 * ml.w + ci3]) hit = true;
              }
              if (hit) { if (ml.zb > t.shellB + 1e-6) { t.shellB = ml.zb; t.zBase = ml.zb; } plateUnder[t.i] = ml; break; }
            }
          })();
          t.top = bareShellTop(t, t.shellB);
        });
      });
    }
    var plateUnder = {};                      /* tip index -> the plate layer (its traced mask) the tip stands under: how far the plate reaches round the tip (flareOf) */
    function bareShellTop(t, z) { var cp = cutPath(columns[t.col].pts, z, o.side, o.side); return [cp[0][0], cp[0][1]]; }
    shellPass();

    /* ---- levels ---- */
    cand.filter(function (t) { return t.mode === 'sheet' && !t.shell; }).sort(function (a, b) { return a.zTop - b.zTop; }).forEach(function (t) {
      var L = levels[levels.length - 1];
      if (!L || L.shell || t.zTop - L.first > LEVEL_TOL_MM) { L = { id: levels.length, first: t.zTop, tips: [], told: 0 }; levels.push(L); }     /* never a region plate's level: it holds its own tips */
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
      /* a sheet spans from tip to tip: one tip alone carries a patch, not a sheet - unless it is a tip nothing else
         could give a sheet (L.lone: the last resort, below the stair) */
      var minCaps = L.lone ? 1 : 2;
      if (live.length < minCaps) return { ok: false, reason: 'a sheet needs two tips at one level; this one has ' + live.length };
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
      /* THE PART'S OUTLINE: is the part over (x, y), within the reach, from the stack's top up? */
      function overAt(x, y) { return perimOver(x, y, zTop); }
      function inPerim(x, y) {
        var m = perimMargin;
        if (m > 0) return overAt(x, y) && overAt(x - m, y) && overAt(x + m, y) && overAt(x, y - m) && overAt(x, y + m);
        if (m === 0) return overAt(x, y);
        return overAt(x, y) || overAt(x + m, y) || overAt(x - m, y) || overAt(x, y + m) || overAt(x, y - m);     /* the outline grown by |m| */
      }
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
        PPs.forEach(function (P, pi) {
          if (y < P.lo[1] || y > P.hi[1] || z < P.lo[2] || z > P.hi[2]) return;
          var x0 = P.lo[0] - 1, kr = pi + ',' + y + ',' + z, hs = qRay.get(kr);
          if (hs === undefined) { hs = P.hitsAlong([x0, y, z], [1, 0, 0], P.hi[0] - x0 + 1); qRay.set(kr, hs); }
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
        /* a tip a stair holds by itself is not built (mode 'drop'): its column is no obstacle */
        if (tipOfCol[ci] && tipOfCol[ci].mode === 'drop') return;
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
      /* a column's end is flat: it reaches into the stack's band by its own height and no more than a quarter of its side
         beyond (the flat sheets keep a whole side: a branch merged just under the tips blocked the tips beside it, 6 of the
         real Base's 20 at yaw 0); a last-resort sheet keeps the quarter */
      function blockPath(p, side, rad) { bandPieces(p, L.lone ? side * LONE_SLACK : side, zb0, zb1, function (a, b2) { blockSeg(a, b2, rad); }); }
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
        /* a cap does not hang off the part: its rim stays where the part is over it. One that does slides toward its centre, and narrows
           when it can slide no further (the caller's loop). Asked first: it is the cheap question, and the answer is most of the work */
        if (perimOn) {
          for (var hs2 = 0; hs2 < CAP_SIDES; hs2++) {
            var han = 2 * Math.PI * hs2 / CAP_SIDES, hx = c[0] + Rc * Math.cos(han), hy = c[1] + Rc * Math.sin(han);
            if (!inPerim(hx, hy)) {
              var hdx = c[0] - hx, hdy = c[1] - hy, hl = Math.hypot(hdx, hdy);
              return { push: hl > 1e-9 ? [hdx / hl * CAP_STEP_MM / 2, hdy / hl * CAP_STEP_MM / 2] : null };
            }
          }
        }
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
        if (t.lowRoom) { t.cap = null; t.capWhy = 'no room for a cap: low over the plate'; return; }
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
          obstacles.forEach(function (B, bi) {
            exactDistance(soupC, exactVs(bi, o.gap + 0.1), o.gap + 0.1, beat, o.gap - 1e-5).under.forEach(function (ai) {
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
      /* THE REGION PLATE (opts.regionPlate, docs/SUPPORT-FOOTPRINT.md section 9). The field is a region, not a sheet's pieces: its components that a cap
         or a bare top stands on are laid in concentric lines - the level sets of the distance to the region's edge, a pitch apart, each opened by
         half a line and its gap so no two walls overlap - the same loops in every layer of the stack (T1, T2, I1..), over the caps. A ring round a
         cavity is two loops; a crescent is its own; a flat footprint is filled to its edge. Nothing here is 2 mm lines or rectangles. */
      function regionBuild() {
        var N = nx * ny, lab = new Int32Array(N).fill(-1), ncomp = 0;
        for (var s0 = 0; s0 < N; s0++) {
          if (!field[s0] || lab[s0] >= 0) continue;
          var st = [s0]; lab[s0] = ncomp;
          while (st.length) {
            var q = st.pop(), qi = q % nx, qj = (q - qi) / nx;
            if (qi > 0 && field[q - 1] && lab[q - 1] < 0) { lab[q - 1] = ncomp; st.push(q - 1); }
            if (qi < nx - 1 && field[q + 1] && lab[q + 1] < 0) { lab[q + 1] = ncomp; st.push(q + 1); }
            if (qj > 0 && field[q - nx] && lab[q - nx] < 0) { lab[q - nx] = ncomp; st.push(q - nx); }
            if (qj < ny - 1 && field[q + nx] && lab[q + nx] < 0) { lab[q + nx] = ncomp; st.push(q + nx); }
          }
          ncomp++;
        }
        /* a component stands on a cap (or a bare top) when a cell of it lies under the cap's disc */
        var carried = {}, tipCarried = {};
        live.forEach(function (t) {
          var cr = carrierOf(t), rad = cr.r + 0.15;
          var i0 = Math.max(0, Math.floor((cr.c[0] - rad - ox) / CELL_MM)), i1 = Math.min(nx - 1, Math.ceil((cr.c[0] + rad - ox) / CELL_MM));
          var j0 = Math.max(0, Math.floor((cr.c[1] - rad - oy) / CELL_MM)), j1 = Math.min(ny - 1, Math.ceil((cr.c[1] + rad - oy) / CELL_MM));
          for (var jj = j0; jj <= j1; jj++) for (var ii = i0; ii <= i1; ii++) {
            var qq = jj * nx + ii;
            if (lab[qq] >= 0 && Math.hypot(ox + ii * CELL_MM - cr.c[0], oy + jj * CELL_MM - cr.c[1]) <= rad) { carried[lab[qq]] = true; tipCarried[t.i] = true; }
          }
        });
        if (!Object.keys(carried).length) return { ok: false, reason: 'no region of the footprint lies under a cap of this level' };
        var M = new Uint8Array(N);
        for (var qm = 0; qm < N; qm++) if (lab[qm] >= 0 && carried[lab[qm]]) M[qm] = 1;
        var loops = concentricLoops(M, nx, ny, ox, oy, CELL_MM, o.pitch, o.width, REGION_MIN_LOOP_MM);
        if (!loops.length) return { ok: false, reason: 'the region leaves no loop of a line\'s width' };
        var uncrossed = live.filter(function (t) { return !tipCarried[t.i]; });
        if (live.length - uncrossed.length < 1) return { ok: false, reason: 'no cap of this level has a line over it' };
        var paths = loops.map(function (lp) { return lp.ring; }), lenTot = 0, lo2 = [Infinity, Infinity], hi2 = [-Infinity, -Infinity], areaMm2 = 0;
        loops.forEach(function (lp) { lenTot += lp.lenMm; lp.ring.forEach(function (p) { lo2[0] = Math.min(lo2[0], p[0]); lo2[1] = Math.min(lo2[1], p[1]); hi2[0] = Math.max(hi2[0], p[0]); hi2[1] = Math.max(hi2[1], p[1]); }); });
        for (var qa = 0; qa < N; qa++) if (M[qa]) areaMm2 += CELL_MM * CELL_MM;
        var built = [];
        for (var lk = 0; lk < NL; lk++) {
          var zb = zBase + lk * o.sheetLayer, ex = RL.extrudeFlat(paths, { width: o.width, height: o.sheetLayer, baseZ: zb });
          if (!ex.ok) return { ok: false, reason: 'layer ' + (lk + 1) + ' of the region would not extrude: ' + ex.reason };
          var piece = { kind: 'region', sizeMm: [hi2[0] - lo2[0], hi2[1] - lo2[1]], areaMm2: areaMm2, perimMm: lenTot, caps: live.length - uncrossed.length, lines: loops.length, loop: paths[0], snake: [] };
          built.push({ role: ROLES[lk], angleDeg: 0, z0: zb, z1: zb + o.sheetLayer, pieces: [piece], loopMm: piece.sizeMm.slice(), lines: loops.length, linesMm: lenTot, lengthMm: lenTot,
                       shortestMm: Math.min.apply(null, loops.map(function (lp) { return lp.lenMm; })), paths: paths, soup: ex.tris });
        }
        return { ok: true, zTop: zTop, zBase: zBase, zCap: zCap, layers: built, uncrossed: uncrossed, region: true,
                 lines: { angleDeg: 0, droppedShare: 0, bare: uncrossed.length, pieces: 1, tried: [] } };
      }
      var reachCache = flatMax == null || L.tips.length < 2 ? null : reachMemo, reachZ = L.first.toFixed(2);
      function inReach(x, y) {
        var kq = Math.round(x / 0.25) + ',' + Math.round(y / 0.25) + ',' + reachZ, v = reachCache.get(kq);
        if (v === undefined) { v = isFinite(firstHit(x, y, L.first + 0.01, o.gap + flatMax)); reachCache.set(kq, v); }
        return v;
      }
      if (regionOn) {
        /* THE REGION PLATE: the field is the footprint itself - every cell of it a stack may stand in (free, off another level's cells, the part within
           reach over the stack's top, and 0.2 mm in from the footprint's edge) - not what the caps' discs reach */
        for (var jg = 0; jg < ny; jg++) for (var ig = 0; ig < nx; ig++) {
          var qg = jg * nx + ig, kg = own[qg];
          if (!free[qg] || edge[qg] || (kg >= 0 && tips[kg].level !== L.id)) continue;
          var xg = ox + ig * CELL_MM, yg = oy + jg * CELL_MM;
          if (inPerim(xg, yg) && fillReach(xg, yg, zTop)) field[qg] = 1;
        }
        return regionBuild();
      }
      live.forEach(function (t) {
        var cr = carrierOf(t), rr0 = cr.r + (L.lone ? Math.max(FIELD_MM, LONE_FIELD_MM - cr.r) : FIELD_MM), rr = feet && perimOn && fillOn ? Math.max(rr0, cr.r + FILL_MM) : rr0;
        var i0 = Math.max(0, Math.floor((cr.c[0] - rr - ox) / CELL_MM)), i1 = Math.min(nx - 1, Math.ceil((cr.c[0] + rr - ox) / CELL_MM));
        var j0 = Math.max(0, Math.floor((cr.c[1] - rr - oy) / CELL_MM)), j1 = Math.min(ny - 1, Math.ceil((cr.c[1] + rr - oy) / CELL_MM));
        for (var jf = j0; jf <= j1; jf++) for (var iff = i0; iff <= i1; iff++) {
          var qf = jf * nx + iff, kf = own[qf];
          if (!free[qf] || edge[qf] || (kf >= 0 && tips[kf].level !== L.id)) continue;
          var dcap = Math.hypot(ox + iff * CELL_MM - cr.c[0], oy + jf * CELL_MM - cr.c[1]);
          if (dcap <= rr && (!reachCache || inReach(ox + iff * CELL_MM, oy + jf * CELL_MM)) && (!perimOn || inPerim(ox + iff * CELL_MM, oy + jf * CELL_MM)) &&
              (dcap <= rr0 || fillReach(ox + iff * CELL_MM, oy + jf * CELL_MM, zTop))) field[qf] = 1;
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
              /* capsOf(G, inR) for the rectangle ca..cb x I, counted without building it: a cap is carried when its row is in I and some column of
                 its lines meets a cell of the rectangle on either side (k - 1 or k), i.e. k in ca..cb + 1 */
              var n = 0, area = (cb - ca + 1) * (I[1] - I[0]);
              for (var si = 0; si < G.spans.length; si++) {
                var sp = G.spans[si];
                if (sp.kl > sp.kh || sp.j < 0 || sp.j >= G.J || sp.j < I[0] || sp.j >= I[1]) continue;
                if (Math.max(0, sp.kl, ca) <= Math.min(G.K, sp.kh, cb + 1)) n++;
              }
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
          return pc && pc.n >= minCaps ? pc : null;
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
          (whole && whole.n >= minCaps && whole.n >= sum ? [whole] : strips).forEach(function (pc) {
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
      /* a last-resort sheet keeps the contract's 2 mm line: a piece three cells across has T lines of 0.84 mm one way, and only the
         coupon's leg (its I1) is allowed those - and a tip alone in its area (a custom tip), which has no other sheet to join */
      var order = tried.filter(function (x) { return x.pieces.length && (!L.lone || tips.length < 2 || x.minLineMm >= MIN_RUN_MM - 1e-9); }).sort(function (a, b) {
        var shortA = a.minLineMm < MIN_RUN_MM - 1e-9 ? 1 : 0, shortB = b.minLineMm < MIN_RUN_MM - 1e-9 ? 1 : 0;
        return (a.bare - b.bare) || (a.pieces.length - b.pieces.length) || (outlines(a) - outlines(b)) || (shortA - shortB) ||
               (Math.floor(a.droppedShare * 20) - Math.floor(b.droppedShare * 20)) ||
               (Math.round(a.lineMm) - Math.round(b.lineMm)) ||
               (LINE_ANGLES.indexOf(a.angleDeg) - LINE_ANGLES.indexOf(b.angleDeg));
      });
      var best = order[0];
      if (!best) return { ok: false, reason: 'no piece of 2 mm lines carries two caps of this level' };
      var uncrossed = live.filter(function (t) { return !best.crossed[t.i]; });
      if (live.length - uncrossed.length < minCaps) return { ok: false, reason: 'a sheet needs ' + (minCaps === 1 ? 'a cap' : 'two caps') + ' its lines lie on; ' + (live.length - uncrossed.length) + ' here' };
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
        var alongA = lk < 2 || (lk - 2) % 2 === 1, paths = [], segs = [], soups = [], nLines = 0, lineMm = 0, shortest = Infinity, loopMm = 0, pieces = [];
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
        var zb = zBase + lk * o.sheetLayer;
        for (var pj = 0; pj < plan.length; pj++) {
          /* a piece: its loop and its serpentine, a clear line width apart
             but at the bridge - one graph, one connected wall */
          var ex = RL.extrudeFlat([pieces[pj].loop, pieces[pj].snake], { width: o.width, height: o.sheetLayer, baseZ: zb });
          if (!ex.ok) return { ok: false, reason: 'layer ' + (lk + 1) + ', piece ' + (pj + 1) + ' would not extrude: ' + ex.reason };
          soups.push(ex.tris);
        }
        built.push({ role: ROLES[lk], angleDeg: alongA ? best.angleDeg : (best.angleDeg + 90) % 180, z0: zb, z1: zb + o.sheetLayer,
                     pieces: pieces, loopMm: pieces[0].sizeMm.slice(), lines: nLines, linesMm: lineMm, lengthMm: loopMm + lineMm,
                     shortestMm: shortest, paths: paths, soup: joinSoups(soups) });
      }
      return { ok: true, zTop: zTop, zBase: zBase, zCap: zCap, layers: built, uncrossed: uncrossed,
               lines: { angleDeg: best.angleDeg, droppedShare: best.droppedShare, bare: best.bare, pieces: plan.length,
                        tried: tried.map(function (x) { return { angleDeg: x.angleDeg, droppedShare: x.droppedShare, bare: x.bare }; }) } };
    }

    /* THE OUTLINE, PER LEVEL. A level none of whose tips stands near the part's edge (PERIM_NEAR_MM) is built as it always was: the outline
       cannot reach it. For one that does, the old way is tried first, and if it fails the outline is not why: the level fails as it did, at the
       cost of the one build (the outline only takes field away; on the six heads and the clamp no level the old way cannot build was built
       with it). Otherwise the level is built with the outline, 0.2 mm in from the part's edge; where that leaves nothing of it (a rim thinner
       than the sheet's 2 mm lines) with the outline to the edge, then grown out past it a little at a time (PERIM_GROW_MM), and only then as it
       always was. L.perim says which: { marginMm } (positive: in from the edge; 0: to it; negative: out past it) or { marginMm: null, why } */
    function levelNearEdge(L) {
      var zT = L.zTop;
      for (var ti = 0; ti < L.tips.length; ti++) {
        var t = L.tips[ti];
        if (t.mode !== 'sheet') continue;
        for (var ka = 0; ka < 16; ka++) {
          var an = 2 * Math.PI * ka / 16;
          for (var rr = 0.25; rr <= PERIM_NEAR_MM + 1e-9; rr += 0.25) if (!perimOver(t.contact[0] + rr * Math.cos(an), t.contact[1] + rr * Math.sin(an), zT)) return true;
        }
      }
      return false;
    }
    function feetFlat(L) {
      for (var ti = 0; ti < L.tips.length; ti++) {
        var t = L.tips[ti];
        if (t.mode !== 'sheet') continue;
        for (var fi = 0; fi < feet.length; fi++) {
          var f = feet[fi];
          if (t.contact[0] < f.box[0] - 0.5 || t.contact[0] > f.box[2] + 0.5 || t.contact[1] < f.box[1] - 0.5 || t.contact[1] > f.box[3] + 0.5 || t.contact[2] < f.zl - 0.5 || t.contact[2] > f.zh + 1.5) continue;
          if (f.zh - f.zl > FILL_FLAT_MM) return false;
        }
      }
      return true;
    }
    if (wantPerim) {
      var buildLevelInside = buildLevel;
      buildLevel = function (L, angleForced) {
        var keep = perimMargin;
        try {
          perimOn = false;
          var plain = buildLevelInside(L, angleForced);                      /* the old way */
          if (!plain.ok && regionWanted && feet && feetFlat(L)) {
            /* THE REGION PLATE where the sheet has no piece (a rim, a ring round a cavity): the footprint is laid in loops, over the level's caps */
            regionOn = true; perimOn = true; fillOn = true;
            var rp = buildLevelInside(L, angleForced);
            regionOn = false; fillOn = false;
            if (rp.ok) { L.perim = { marginMm: perimMargin, region: true }; return rp; }
            perimOn = false;
          }
          if (!plain.ok || !levelNearEdge(L)) return plain;
          perimOn = true;
          /* THE FILL first, where the footprints are known: the field runs to the surface's edge. A rim too thin to fill (the sheet's 2 mm lines)
             fails it, and the level is built as the outline alone builds it, below: a filled piece out over a thin rim is the fault. */
          if (feet && L.tips.length <= FILL_MAX_TIPS) {
            fillOn = true;
            var rf = buildLevelInside(L, angleForced);
            fillOn = false;
            if (rf.ok) { L.perim = { marginMm: perimMargin, fill: true }; return rf; }
          }
          var r = buildLevelInside(L, angleForced), used = { marginMm: perimMargin }, first = r.ok ? null : r.reason;
          for (var mi = 0; mi < PERIM_GROW_MM.length && !r.ok; mi++) { perimMargin = PERIM_GROW_MM[mi]; r = buildLevelInside(L, angleForced); used = { marginMm: perimMargin }; }
          if (!r.ok) { perimOn = false; r = buildLevelInside(L, angleForced); used = { marginMm: null, why: first }; }     /* again: a build leaves its marks on the tips */
          L.perim = used;
          return r;
        } finally { perimMargin = keep; perimOn = true; fillOn = false; }
      };
    }
    rebucket();
    var reach = o.gap + 0.1;
    function solveLevel(L) {
      L.zTop = L.first;
      var sunk = 0;
      for (var it = 0; it < 8 + LONE_SINKS.length; it++) {
        var res;
        if (flatMax != null && L.tips.length >= 2) {
          /* the level as it was first (never worse for it: a level that has no piece costs what it always did), then with the reach;
             the reach's piece is the one kept where it has one, else the level is built as it was again, the tips' marks being its */
          var keepReach = flatMax;
          flatMax = null; res = buildLevel(L, opts.angleDeg); flatMax = keepReach;
          if (res.ok) {
            var reached = buildLevel(L, opts.angleDeg);
            if (reached.ok) res = reached; else { flatMax = null; res = buildLevel(L, opts.angleDeg); flatMax = keepReach; }
          }
        } else res = buildLevel(L, opts.angleDeg);
        /* a lone tip at the lowest point of its piece (a vertex, a ridge) has the ceiling lower than any sample of its
           cell a few hundredths away: that is a ceiling in the stack, and no field. The sheet goes lower until it has one. */
        if (!res.ok && L.lone && L.tips.length <= LONE_MAX_TIPS && sunk < LONE_SINKS.length) { L.zTop = L.first - LONE_SINKS[sunk++]; continue; }
        /* the flat sheet's reach left it no piece (a ring round a cavity, a rim): the level is asked again without it */
        if (!res.ok) { L.ok = false; L.reason = res.reason; break; }
        var soup = joinSoups(res.layers.map(function (x) { return x.soup; }));
        var dmin = Infinity, at = null, atTop = null;
        obstacles.forEach(function (B, bi) {
          var d = exactDistance(soup, exactVs(bi, reach), reach, beat);
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
    }
    levels.forEach(function (L) { if (!L.shell) solveLevel(L); });                /* a region plate is built whole, above: it is not a sheet's level to solve */

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
      /* two tips are one stair when they stand STAIR_JOIN tip spacings apart or nearer - the spacing the tips round them
         keep: the median over the whole plan, or this tip's own where it stands wider (a lattice of 3 mm tips with a
         rim of 1.5 mm ones round it has a median of 1.5, and no 3 mm neighbour would be joined) */
      var own = pool.map(function (t) {
        var b = Infinity;
        cand.forEach(function (u) { if (u !== t) b = Math.min(b, Math.hypot(u.contact[0] - t.contact[0], u.contact[1] - t.contact[1])); });
        return Math.max(spacing, isFinite(b) ? b : 0);
      });
      for (var a = 0; a < pool.length; a++) for (var b = a + 1; b < pool.length; b++) {
        if (Math.hypot(pool[a].contact[0] - pool[b].contact[0], pool[a].contact[1] - pool[b].contact[1]) <= STAIR_JOIN * Math.max(own[a], own[b]) + 1e-9) {
          var ra = fd(a), rb = fd(b);
          if (ra !== rb) par[Math.max(ra, rb)] = Math.min(ra, rb);
        }
      }
      var groups = {};
      pool.forEach(function (t, i) { var r = fd(i); (groups[r] = groups[r] || []).push(t); });
      var out = [];
      Object.keys(groups).map(Number).sort(function (x, y) { return x - y; }).forEach(function (k) {
        var st = stairOf(groups[k]);
        /* a stair that leaves tips of its group, or none, is asked again with the walls kept off; the one that holds more stands */
        var heldBy = function (x) { return x ? x.carriers.length + x.held.filter(function (t) { return t.stairM != null && t.stairM <= x.stair.mTop; }).length : 0; };
        if (!st || heldBy(st) < groups[k].length) {
          var st2 = stairOf(groups[k], STAIR_WALL_MM);
          if (st2 && heldBy(st2) > heldBy(st)) st = st2;
        }
        if (st) { st.snap.forEach(function (x) { x.t.stairM = x.stairM; x.t.top = x.top; x.t.capFoot = x.capFoot; x.t.cap = x.cap; x.t.capWhy = x.capWhy; }); out.push(st); }
      });
      return out;
    }

    function stairOf(group, wallMm) {
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
      /* iv: each cell's intervals (z in, z out, ...), in one array: cell q's run from ivAt[q] to ivAt[q + 1] */
      var near = new Uint8Array(nx * ny), ivAt = new Int32Array(nx * ny + 1), iv = new Float64Array(4096), ivN = 0;
      for (var j0 = 0; j0 < ny; j0++) {
        beat();
        for (var i0 = 0; i0 < nx; i0++) {
          var x = ox + i0 * CELL_MM, y = oy + j0 * CELL_MM;
          ivAt[j0 * nx + i0] = ivN;
          for (var pi = 0; pi < PPs.length; pi++) {
            var P = PPs[pi];
            if (x < P.lo[0] || x > P.hi[0] || y < P.lo[1] || y > P.hi[1]) continue;
            var z0 = P.lo[2] - 1, hs = P.hitsAlong([x, y, z0], [0, 0, 1], P.hi[2] - P.lo[2] + 2);
            for (var h = 0; h + 1 < hs.length; h += 2) {
              if (ivN + 2 > iv.length) { var grown = new Float64Array(iv.length * 2); grown.set(iv); iv = grown; }
              iv[ivN++] = z0 + hs[h]; iv[ivN++] = z0 + hs[h + 1];
            }
          }
        }
      }
      ivAt[nx * ny] = ivN;
      /* a cell is near when a tip of the group is within D of it on both axes: each tip marks the cells in a window a
         cell wider than that, by the same test */
      group.forEach(function (t) {
        var cx = t.contact[0], cy = t.contact[1];
        var ia = Math.max(0, Math.floor((cx - D - ox) / CELL_MM) - 1), ib = Math.min(nx - 1, Math.ceil((cx + D - ox) / CELL_MM) + 1);
        var ja = Math.max(0, Math.floor((cy - D - oy) / CELL_MM) - 1), jb = Math.min(ny - 1, Math.ceil((cy + D - oy) / CELL_MM) + 1);
        for (var jn = ja; jn <= jb; jn++) for (var in2 = ia; in2 <= ib; in2++) {
          if (Math.abs(cx - (ox + in2 * CELL_MM)) <= D && Math.abs(cy - (oy + jn * CELL_MM)) <= D) near[jn * nx + in2] = 1;
        }
      });
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
      /* wallMm: the stair that would not hold the gap keeps this far off every cell the piece is in (a wall beside a
         strip is the gap's, and a strip moved up the slope is no further from it) */
      var rWall = Math.max(r, wallMm || 0), R0 = Math.ceil(rWall / CELL_MM), disc = [];
      for (var dj = -R0; dj <= R0; dj++) for (var di = -R0; di <= R0; di++) if (Math.hypot(di, dj) * CELL_MM <= rWall) disc.push([di, dj]);
      /* the disc by rows: row dj holds the cells di from lo to hi (the disc's rows are unbroken) */
      var discRows = [];
      disc.forEach(function (c) {
        var row = discRows.find(function (r) { return r[0] === c[1]; });
        if (!row) discRows.push(row = [c[1], c[0], c[0], 0]);
        row[1] = Math.min(row[1], c[0]); row[2] = Math.max(row[2], c[0]); row[3]++;
      });
      var discWhole = discRows.every(function (r) { return r[3] === r[2] - r[1] + 1; });
      var discRowsFlat = new Int32Array(discRows.length * 3), discFlat = new Int32Array(disc.length * 2);
      discRows.forEach(function (r, k) { discRowsFlat[k * 3] = r[0]; discRowsFlat[k * 3 + 1] = r[1]; discRowsFlat[k * 3 + 2] = r[2]; });
      disc.forEach(function (c, k) { discFlat[k * 2] = c[0]; discFlat[k * 2 + 1] = c[1]; });
      var zTopOf = function (m) { return o.plateZ + m * o.layer; };
      /* the field of the layer whose top is zTopOf(m): see EACH LAYER'S STRIP */
      function fieldFor(m, extra, reach) {
        var zt = zTopOf(m), za = zt - o.layer - o.gap, zb = zt + o.gap, n = nx * ny;
        var blk = new Uint8Array(n), fld = new Uint8Array(n);
        stairBlocks(ivAt, iv, n, za, zb, reach || STAIR_REACH_MM, blk, fld);
        stairHalo(blk, fld, nx, ny, discRowsFlat, discWhole, discFlat);
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
          var f = stairFront(fld, near, nx, ny, ox, oy, umin, umax, o.width, DU, F.nrm[0], F.nrm[1], F.dir[0], F.dir[1], v);
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
      function bandHolds(m, p, W, a, ends) {
        var bd = lay[m] && lay[m].band, v = vOf(p);
        /* ends: a tip a mm or less past either end of the band is held by its last line */
        if (ends && bd) v = Math.min(bd.v1, Math.max(bd.v0, v));
        var f = frontAt(bd, v);
        /* the strip is drawn one shift further up the slope than the band's front reads (stripBuild adds it again) */
        if (f != null && bd) f += bd.shift || 0;
        return f != null && uOf(p) >= f - a && uOf(p) <= f + W + a && (!ends || Math.abs(vOf(p) - v) <= a);
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
        if (opts.stairLegMm && !lay[m].fldT) lay[m].fldT = fieldFor(m, null, STAIR_TOP_REACH_MM);
        var fR = opts.stairLegMm ? lay[m].fldT : lay[m].fld;
        bd.pts.forEach(function (pt) {
          var f = pt.f + (bd.shift || 0), u = f;
          while (u + DU <= umax && fieldAt(fR, atUV(u + DU, pt.v)[0], atUV(u + DU, pt.v)[1])) u += DU;
          r.push(u - f + CELL_MM);
        });
        r.sort(function (x, y) { return x - y; });
        return r.length ? r[r.length >> 1] : 0;
      }
      /* A STRIP AS DEEP AS BAMBU'S STACK (opts.stairLegMm, the card's Dense). Bambu's interface is a sheet of 3 interface and 2 transition layers
         under the part, following it: at every point under the part, the five layers under the gap. A stair's strip is one layer of that sheet: as wide as
         five advances and a bead (3.1 mm on the Oblique), so that the strips stand five deep wherever they lie, its front 3 layers deep interface and the
         two under them transition - and what lies below them is the tree. A strip as wide as one advance and a bead (the Open stair's) stands one or
         two deep, and everything under it that touches it was read as part of it. */
      var stackN = opts.stairLegMm ? nI + 2 : 0;
      /* the depth of the stack, where the part is: from a strip's front to the front of the strip stackN layers up (stackN advances where the slope is
         even, and the 2 mm the first layer's front jumps at the part's rounded low edge, which stackN x that advance would have made 9 mm of flat plate) */
      function stackReach(m) {
        var M2 = m + stackN - 1, bd = lay[m].band, d = [];
        if (M2 > mTop || !lay[M2] || !lay[M2].band) return null;
        bd.pts.forEach(function (pt) { var f2 = frontAt(lay[M2].band, pt.v); if (f2 != null) d.push(f2 - pt.f); });
        d.sort(function (x, y) { return x - y; });
        return d.length ? Math.max(d[d.length >> 1], 0) : null;
      }
      function planWidth(m) {
        var a = advanceAt(m), bd0 = stackN ? 0 : bead, room = roomAt(m) + bd0, sr = stackN ? stackReach(m) : null;
        var need = m === mTop ? room : (stackN ? Math.min(room, (sr != null ? sr : (stackN - 1) * a) + bd0) : a + bead), n = 2;
        while (widthOf(n) < need - 1e-9 && widthOf(n + 1) <= room + 1e-9) n++;
        var pt = o.pitch;
        if (widthOf(n) < need - 1e-9) pt = (Math.min(need, Math.max(room, widthOf(n))) - o.width) / (n - 1);
        return { n: n, pitch: pt, W: widthOf(n, pt), a: a };
      }
      /* a strip built: its loop round the band's outline and, from three lines
         up, the serpentine inside it, both centrelines o.width / 2 in from the
         outline; the serpentine starts on the loop's down-v end (the tie) and
         keeps a pitch off the loop everywhere else */
      function stripBuild(m, z0, role, wd, neat) {   /* neat: the tolerance the front is straightened to, mm */
        var bd = lay[m].band, sh = bd.shift || 0, hw = o.width / 2, n = wd.n, pt = wd.pitch, W = wd.W;
        var va = bd.v0 + hw, vb = bd.v1 - hw;
        /* a strip's lines are spread to cover the part's step (planWidth), more than a pitch apart when two lines at the pitch fall short;
           the loop's turn needs its own pitch, not the spread */
        if (!(vb - va > 2 * Math.min(pt, o.pitch))) return { ok: false, reason: 'the band is too short for its loop' };
        var vs = [va], fAt = function (v) { return frontAt(bd, v); };
        if (neat) {
          /* the front as a few straight runs: a raster steps by a cell, and on a tilted or turned band the steps are
             segments shorter than the joins at their ends need, or lines of the strip that run into one another */
          /* ...no steeper than STAIR_FRONT_RUN across the strip's lines (the lines are the front moved up the slope by a pitch:
             on a steeper edge they would stand within a line width of one another), and never nearer the part's low side
             than the field put it: the smallest such front that holds the true one */
          var fv = bd.pts.map(function (q) { return q.f; }), dv = bd.pts.length > 1 ? bd.pts[1].v - bd.pts[0].v : STAIR_DV;
          for (var k1 = 1; k1 < fv.length; k1++) fv[k1] = Math.max(fv[k1], fv[k1 - 1] - STAIR_FRONT_RUN * dv);
          for (var k2 = fv.length - 2; k2 >= 0; k2--) fv[k2] = Math.max(fv[k2], fv[k2 + 1] - STAIR_FRONT_RUN * dv);
          var NP = RL.simplify(bd.pts.map(function (q, k) { return [q.v, fv[k]]; }), neat);
          fAt = function (v) {
            for (var k = 0; k + 1 < NP.length; k++) {
              if (v <= NP[k + 1][0] + 1e-9) { var t = NP[k + 1][0] > NP[k][0] ? Math.max(0, (v - NP[k][0]) / (NP[k + 1][0] - NP[k][0])) : 0; return NP[k][1] + t * (NP[k + 1][1] - NP[k][1]) + sh; }
            }
            return NP[NP.length - 1][1] + sh;
          };
          NP.forEach(function (q) { if (q[0] > va + STAIR_STUB_MM && q[0] < vb - STAIR_STUB_MM) vs.push(q[0]); });
        } else bd.pts.forEach(function (q) { if (q.v > va + 1e-6 && q.v < vb - 1e-6) vs.push(q.v); });
        vs.push(vb);
        function at(k, v) { return atUV(fAt(v) + sh + hw + k * pt, v); }
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
      var nearPreps = nearSoups.map(function (B) { return exactPrep(B, reachG); });
      function nearest(soup) {
        var dmin = Infinity;
        nearPreps.forEach(function (B) { dmin = Math.min(dmin, exactDistance(soup, B, reachG, beat).mm); });
        return dmin;
      }
      /* SIDEWAYS, MEASURED: the piece cut at a layer's middle (the outline as oriented segments, its inside on the left),
         and each strip's centrelines sampled against it. The gap above is a distance to the surface, which a strip wholly
         inside the piece (where its underside is lower than the strip) passes; the outline does not. A line keeps
         XY_CLEAR_MM from the piece's outer line, which lies half a line in from the outline. What a strip is short by, in mm
         (0 when it keeps clear; its depth and the clearance when it lies in the piece) */
      var sections = {};
      function sectionAt(zm) {
        var key = zm.toFixed(3);
        if (sections[key]) return sections[key];
        var segs = [];
        obstacles.forEach(function (B) {   /* all of them: a point is inside by the outline all round it, not by the part of it near the stair */
          for (var i = 0; i < B.length; i += 9) {
            var za = B[i + 2], zb = B[i + 5], zc = B[i + 8];
            if ((za > zm && zb > zm && zc > zm) || (za <= zm && zb <= zm && zc <= zm)) continue;
            var pts = [], V = [[B[i], B[i + 1], za], [B[i + 3], B[i + 4], zb], [B[i + 6], B[i + 7], zc]];
            for (var e = 0; e < 3; e++) {
              var a = V[e], b = V[(e + 1) % 3];
              if ((a[2] > zm) !== (b[2] > zm)) { var t = (zm - a[2]) / (b[2] - a[2]); pts.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); }
            }
            if (pts.length !== 2) continue;
            var nx = (V[1][1] - V[0][1]) * (V[2][2] - V[0][2]) - (V[1][2] - V[0][2]) * (V[2][1] - V[0][1]);
            var ny = (V[1][2] - V[0][2]) * (V[2][0] - V[0][0]) - (V[1][0] - V[0][0]) * (V[2][2] - V[0][2]);
            var P = pts[0], Q = pts[1];
            if ((Q[0] - P[0]) * -ny + (Q[1] - P[1]) * nx < 0) { P = pts[1]; Q = pts[0]; }
            segs.push([P[0], P[1], Q[0], Q[1]]);
          }
        });
        return (sections[key] = segs);
      }
      function sideShort(b, z0) {
        var S = sectionAt(z0 + o.layer / 2);
        if (!S.length) return 0;
        var need = XY_CLEAR_MM - o.width / 2 + 0.01, short = 0, lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
        b.layer.paths.forEach(function (pth) { pth.forEach(function (q) { lo = [Math.min(lo[0], q[0]), Math.min(lo[1], q[1])]; hi = [Math.max(hi[0], q[0]), Math.max(hi[1], q[1])]; }); });
        var near = S.filter(function (g) {
          return Math.max(g[0], g[2]) >= lo[0] - need - 0.5 && Math.min(g[0], g[2]) <= hi[0] + need + 0.5 && Math.max(g[1], g[3]) >= lo[1] - need - 0.5 && Math.min(g[1], g[3]) <= hi[1] + need + 0.5;
        });
        if (!near.length) return 0;
        function at(x, y) {
          var w = 0, d = Infinity;
          for (var k = 0; k < S.length; k++) {
            var g = S[k];
            if (g[1] <= y) { if (g[3] > y && (g[2] - g[0]) * (y - g[1]) - (x - g[0]) * (g[3] - g[1]) > 0) w++; }
            else if (g[3] <= y && (g[2] - g[0]) * (y - g[1]) - (x - g[0]) * (g[3] - g[1]) < 0) w--;
          }
          for (var k2 = 0; k2 < near.length; k2++) d = Math.min(d, segDist2([x, y], [near[k2][0], near[k2][1]], [near[k2][2], near[k2][3]]));
          return w !== 0 ? -d : d;
        }
        b.layer.paths.forEach(function (pth) {
          for (var i = 0; i + 1 < pth.length; i++) {
            var A = pth[i], B2 = pth[i + 1], n = Math.max(1, Math.ceil(Math.hypot(B2[0] - A[0], B2[1] - A[1]) / 0.25));
            for (var j = 0; j <= n; j++) {
              var d = at(A[0] + j / n * (B2[0] - A[0]), A[1] + j / n * (B2[1] - A[1]));
              short = Math.max(short, need - d);
            }
          }
        });
        return short > 0 ? short : 0;
      }
      /* a strip as the band lies; or, where that would not extrude, on the band's front straightened */
      function stripTry(m, z0, role, wd) {
        var b = stripBuild(m, z0, role, wd);
        for (var q = 0; q < STAIR_NEAT_MM.length && !b.ok && /it would not extrude/.test(b.reason); q++) b = stripBuild(m, z0, role, wd, STAIR_NEAT_MM[q]);
        return b;
      }
      function solveStrip(m, z0, role, wd) {
        var shift0 = lay[m].band.shift || 0, n0 = wd.n, fail = null;
        /* a strip the gap would not hold for, its shifts spent, loses its back line - where the part comes down on it,
           at a wall that rises beside it (the stem of a tipped piece) - and is solved again, down to two lines */
        for (var nl = n0; nl >= 2; nl--) {
          if (nl < n0) { wd.n = nl; wd.W = widthOf(nl, wd.pitch); lay[m].band.shift = shift0; }
          for (var it = 0; it < 16; it++) {
            var b = stripTry(m, z0, role, wd);
            if (!b.ok) return b;
            var d = nearest(b.soup), ss = sideShort(b, z0);
            if (d >= o.gap - 1e-5 && ss <= 1e-9) { b.minMm = d; return b; }
            lay[m].band.shift = (lay[m].band.shift || 0) + Math.max(STAIR_STEP_MM, o.gap - d, ss);
          }
          fail = { ok: false, reason: 'the gap would not hold at z ' + (z0 + o.layer).toFixed(2) };
        }
        wd.n = n0; wd.W = widthOf(n0, wd.pitch); lay[m].band.shift = shift0;
        return fail;
      }
      /* the top: no strip runs past the part's outline and one line */
      while (mTop - mLo + 1 > 2 && widthOf(2) > roomAt(mTop) + bead + 1e-9) mTop--;
      /* the strips: built, the gap solved (a band moves up the slope), and
         their widths read again from where the bands now lie - twice. A strip
         the gap would not hold for (a wall of the part beside it) ends the
         stair under it, and the widths are planned again for the shorter
         stair; the tips above it are left to the next stair */
      var widths = {};
      for (var round = 0, stairDone = false; !stairDone; round++) {
        if (round > STAIR_CUTS) return null;
        var cut = false;
        for (var pass = 0; pass < 2 && !cut; pass++) {
          var was = JSON.stringify(widths);
          for (var m4 = mLo; m4 <= mTop; m4++) widths[m4] = planWidth(m4);
          if (pass && JSON.stringify(widths) === was) break;
          for (var m5 = mLo; m5 <= mTop; m5++) {
            var sv = solveStrip(m5, zTopOf(m5) - o.layer, 'interface', widths[m5]);
            if (!sv.ok) { if (m5 - mLo >= 2) { mTop = m5 - 1; cut = true; break; } return null; }
            built[m5] = sv;
          }
        }
        if (cut) { widths = {}; continue; }
        minD = Infinity;
        for (var m7 = mLo; m7 <= mTop; m7++) {
          if (!built[m7] || built[m7].layer.beads !== widths[m7].n || Math.abs(built[m7].layer.pitchMm - widths[m7].pitch) > 1e-9) {
            var sv2 = solveStrip(m7, zTopOf(m7) - o.layer, 'interface', widths[m7]);
            if (!sv2.ok) { if (m7 - mLo >= 2) { mTop = m7 - 1; cut = true; break; } return null; }
            built[m7] = sv2;
          }
          minD = Math.min(minD, built[m7].minMm);
        }
        if (cut) { widths = {}; continue; }
        stairDone = true;
      }
      /* the transition: the lowest strip again, one layer under it */
      var zCap = zTopOf(mLo) - 2 * o.layer;
      var tb = stripTry(mLo, zCap, 'transition', widths[mLo]);
      if (!tb.ok) return null;
      var dT = nearest(tb.soup);
      if (!(dT >= o.gap - 1e-5) || sideShort(tb, zCap) > 1e-9) return null;
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
      var want = [], restMm = {}, legMm = opts.stairLegMm == null ? 0 : +opts.stairLegMm;
      /* where along a band its tips go: STAIR_TIP_MM apart or nearer, each
         holding the stretch of band round it (a band L long has ceil(L /
         STAIR_TIP_MM) tips, at the middles of equal stretches: 2 on the
         arc's 9.75 mm), the next strip's set a quarter stretch along, the
         one after a quarter back - so a column does not stand straight over
         the one a layer below it (Bambu's own: ~1.4 tops a strip, 5 mm apart);
         with a leg length (opts.stairLegMm) the same places on every strip:
         the posts of a column climb the slope one over the next and overlap,
         a ramp-topped blade that the legs hold */
      function tipVs(bd, m) {
        var nT = Math.max(1, Math.ceil(bd.len / STAIR_TIP_MM - 1e-9)), step = bd.len / nT, sh2 = legMm ? 0 : [0, 0.25, 0, -0.25][m % 4] * step, out = [];
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
        if (!stackN) tipVs(bd6, m6 - mLo).forEach(function (v) {
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
      /* THE SHEET'S PERIMETER (opts.stairLegMm, the card's Dense): a sheet of 2 + 2 layers is held where it ends. A tip on every strip's lead edge is a
         picket fence (42 on the Oblique, a blade of posts under each row); the sheet's edge is what sags, and the sheet bridges what lies inside it. So the
         tips stand along the outline of the sheet - the footprint of its strips, the lowest layer at each point - every STAIR_PERIM_MM, 0.6 mm in from the
         edge, each at the underside of the lowest strip over it; and inside it, where no tip is within STAIR_FILL_MM. Each is the end of a twig off a branch
         (nso_support_gridpack.js): a tip whose top dies at the transition. */
      var perimGap = null;
      if (stackN) {
        var CS = 0.25, uLo = Infinity, uHi = -Infinity, vLo = Infinity, vHi = -Infinity;
        for (var mq = mLo; mq <= mTop; mq++) {
          var bq = lay[mq].band;
          vLo = Math.min(vLo, bq.v0); vHi = Math.max(vHi, bq.v1);
          bq.pts.forEach(function (pt) { uLo = Math.min(uLo, pt.f + (bq.shift || 0)); uHi = Math.max(uHi, pt.f + (bq.shift || 0) + widths[mq].W); });
        }
        var nU = Math.ceil((uHi - uLo) / CS) + 3, nV = Math.ceil((vHi - vLo) / CS) + 3, cellM = new Int16Array(nU * nV).fill(-1);
        function lowestOver(u, v) {
          for (var m8 = mLo; m8 <= mTop; m8++) {
            var bd8 = lay[m8].band, f8 = frontAt(bd8, v);
            if (f8 == null) continue;
            f8 += bd8.shift || 0;
            if (u >= f8 - 1e-9 && u <= f8 + widths[m8].W + 1e-9) return m8;
          }
          return -1;
        }
        for (var iu = 0; iu < nU; iu++) for (var iv = 0; iv < nV; iv++) cellM[iu * nV + iv] = lowestOver(uLo + (iu - 1) * CS, vLo + (iv - 1) * CS);
        /* depth of a cell inside the footprint: the distance (4-neighbour chamfer, in cells) to the nearest cell outside it */
        var dep = new Float32Array(nU * nV).fill(0), changed2 = true;
        for (var ic = 0; ic < nU * nV; ic++) dep[ic] = cellM[ic] >= 0 ? 1e3 : 0;
        for (var pass3 = 0; pass3 < 200 && changed2; pass3++) {
          changed2 = false;
          for (var ju = 0; ju < nU; ju++) for (var jv = 0; jv < nV; jv++) {
            var ix = ju * nV + jv;
            if (dep[ix] === 0) continue;
            var best2 = dep[ix];
            if (ju === 0 || jv === 0 || ju === nU - 1 || jv === nV - 1) best2 = 1;
            else best2 = Math.min(best2, dep[ix - nV] + 1, dep[ix + nV] + 1, dep[ix - 1] + 1, dep[ix + 1] + 1);
            if (best2 < dep[ix]) { dep[ix] = best2; changed2 = true; }
          }
        }
        var inset = Math.max(1, Math.round(STAIR_PERIM_IN_MM / CS)), cand = [];
        for (var ju2 = 0; ju2 < nU; ju2++) for (var jv2 = 0; jv2 < nV; jv2++) if (dep[ju2 * nV + jv2] >= inset && dep[ju2 * nV + jv2] <= inset + 1) cand.push({ u: uLo + (ju2 - 1) * CS, v: vLo + (jv2 - 1) * CS, m: cellM[ju2 * nV + jv2] });
        var cu = 0, cv = 0;
        cand.forEach(function (c) { cu += c.u / cand.length; cv += c.v / cand.length; });
        cand.sort(function (a, b) { return Math.atan2(a.v - cv, a.u - cu) - Math.atan2(b.v - cv, b.u - cu); });
        var chosen = [];
        var spanM = Math.max(1, mTop - mLo);
        function perimAt(c) { return STAIR_PERIM_MM + (STAIR_PERIM_TOP_MM - STAIR_PERIM_MM) * Math.max(0, Math.min(1, (c.m - mLo) / spanM)); }
        cand.forEach(function (c) { if (chosen.every(function (q) { return Math.hypot(q.u - c.u, q.v - c.v) >= Math.min(perimAt(c), perimAt(q)); })) chosen.push(c); });
        /* inside: the cell furthest from every tip while one is further than STAIR_FILL_MM, under the footprint by more than the inset */
        for (var guard2 = 0; guard2 < 40; guard2++) {
          var far = null, farD = STAIR_FILL_MM;
          for (var ju3 = 0; ju3 < nU; ju3++) for (var jv3 = 0; jv3 < nV; jv3++) {
            if (dep[ju3 * nV + jv3] < inset) continue;
            var uu = uLo + (ju3 - 1) * CS, vv = vLo + (jv3 - 1) * CS, dn = Infinity;
            for (var qq = 0; qq < chosen.length; qq++) dn = Math.min(dn, Math.hypot(chosen[qq].u - uu, chosen[qq].v - vv));
            if (dn > farD) { farD = dn; far = { u: uu, v: vv, m: cellM[ju3 * nV + jv3] }; }
          }
          if (!far) break;
          chosen.push(far);
        }
        chosen.forEach(function (c) {
          var xy = atUV(c.u, c.v);
          want.push({ p: [xy[0], xy[1], c.m === mLo ? zTopOf(mLo) - 2 * o.layer : zTopOf(c.m) - o.layer], strip: c.m });
        });
        /* the longest stretch of the outline between two tips, as the owner reads it ("fully support the perimeter"): from every outline cell to its nearest tip */
        perimGap = 0;
        for (var ju4 = 0; ju4 < nU; ju4++) for (var jv4 = 0; jv4 < nV; jv4++) {
          if (dep[ju4 * nV + jv4] !== 1) continue;
          var uo = uLo + (ju4 - 1) * CS, vo = vLo + (jv4 - 1) * CS, dm = Infinity;
          for (var q5 = 0; q5 < chosen.length; q5++) dm = Math.min(dm, Math.hypot(chosen[q5].u - uo, chosen[q5].v - vo));
          perimGap = Math.max(perimGap, dm);
        }
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
        t.cap = t.lowRoom ? null : { c: t.top.slice(), b: t.capFoot.slice(), w: w, z0: zCap - o.capRise, z1: zCap, footD: CAP_FOOT * o.side, band: CAP_BAND_MM, nnMm: nnTop, why: null, slidMm: 0 };
      });
      /* caps never overlap (THE CAPS) */
      for (var pass2 = 0, moved = true; moved && pass2 < 8; pass2++) {
        moved = false;
        for (var ia = 0; ia < carriers.length; ia++) for (var ib = ia + 1; ib < carriers.length; ib++) {
          var CA = carriers[ia].cap, CB = carriers[ib].cap;
          if (!CA || !CB) continue;
          var dd = Math.hypot(CA.c[0] - CB.c[0], CA.c[1] - CB.c[1]) - CAP_PART_MM;
          if ((CA.w + CB.w) / 2 <= dd + 1e-9) continue;
          var span = Math.max(dd, 0);
          if (CA.w <= span) CB.w = 2 * span - CA.w; else if (CB.w <= span) CA.w = 2 * span - CB.w; else { CA.w = span; CB.w = span; }
          CA.why = CB.why = 'held short of a neighbour ' + (dd + CAP_PART_MM).toFixed(2) + ' mm away'; moved = true;
        }
      }
      /* THE CAPS KEEP TO THE PART (opts.perimeter, the card asks): a cap stands where the part is over it, not out over the air past the part's edge
         (a stair's lowest tip stands at the end of the slope, on the edge: its 4 mm cap hung 2 mm off it - the owner's picture). A cap whose rim
         is not all under the part is moved in (CAP_IN_MM at most, in 16 directions, the least first), else narrowed a step, down to the tip's own
         width; a tip whose column top is not under the part either keeps its bare top. */
      if (wantPerim) carriers.forEach(function (t) {
        var cp = t.cap;
        if (!cp) return;
        function rimOver(cx, cy, w) {
          for (var a = 0; a < 16; a++) if (!perimOver(cx + w / 2 * Math.cos(Math.PI * a / 8), cy + w / 2 * Math.sin(Math.PI * a / 8), zCap)) return false;
          return perimOver(cx, cy, zCap);
        }
        var c0 = cp.c.slice(), w0 = cp.w, fit = null;
        for (var w = w0; w > o.side + 1e-9 && !fit; w = Math.max(o.side, w - CAP_STEP_MM)) {
          for (var d = 0; d <= CAP_IN_MM + 1e-9 && !fit; d += d === 0 ? 0.25 : 0.25) {
            for (var a2 = 0; a2 < (d === 0 ? 1 : 16) && !fit; a2++) {
              var cx = c0[0] + d * Math.cos(Math.PI * a2 / 8), cy = c0[1] + d * Math.sin(Math.PI * a2 / 8);
              if (rimOver(cx, cy, w)) fit = { c: [cx, cy, c0[2]], w: w, moved: d };
            }
          }
          if (w <= o.side + 1e-9) break;
        }
        if (!fit) { t.cap = null; t.capWhy = 'no room under the part for a cap: the column\'s own top'; return; }
        if (fit.moved > 0 || fit.w < w0 - 1e-9) { cp.c = fit.c; cp.w = fit.w; cp.why = 'kept to the part: ' + (fit.moved > 0 ? 'moved in ' + fit.moved.toFixed(2) + ' mm' : '') + (fit.w < w0 - 1e-9 ? ' narrowed to ' + fit.w.toFixed(2) : ''); }
      });
      /* every cap measured, narrowed until it keeps the gap */
      carriers.forEach(function (t) {
        for (var it2 = 0; it2 < 16 && t.cap; it2++) {
          if (t.cap.w <= o.side + 1e-9) { t.cap = null; break; }
          var hull = capHull(t.cap), bad = false;
          nearPreps.forEach(function (B) { if (!bad && exactDistance(hull, B, o.gap + 0.1, beat, o.gap - 1e-5).under.length) bad = true; });
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
        nearPreps.forEach(function (B) { if (!bad && exactDistance(hull, B, o.gap + 0.1, beat, o.gap - 1e-5).under.length) bad = true; });
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
      want.forEach(function (w) { w.leg = true; });
      /* each tip's layer: the lowest strip of the stair whose band holds it */
      group.forEach(function (t) {
        t.stairM = null;
        for (var m7 = mLo; m7 <= mTop; m7++) if (bandHolds(m7, t.contact, widths[m7].W, 1, true)) { t.stairM = m7; break; }
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
      /* the tips' own marks (stairOf writes them on the shared tips, and may run twice over a group) */
      var snap = group.map(function (t) { return { t: t, stairM: t.stairM, top: t.top, capFoot: t.capFoot, cap: t.cap, capWhy: t.capWhy }; });
      return { snap: snap, group: group, carriers: carriers, held: held, zCap: zCap, zBase: zCap, zTop: zTopStair, layers: layers, minD: minD,
               lines: { angleDeg: phi, stair: true, slopeDeg: slopeDeg, droppedShare: 0, bare: 0, pieces: layers.length, tried: [] },
               stair: { slopeDeg: slopeDeg, angleDeg: phi, mLo: mLo, mTop: mTop, strips: mTop - mLo + 1, topMm: zTopStair, perimGapMm: perimGap,
                        tips: want.map(function (w) { return { p: w.p, strip: w.strip - mLo, leg: w.leg !== false }; }),
                        cutAbove: group.filter(function (t) { return t.stairM != null && t.stairM > mTop; }).length } };
    }

    var stairsBuilt = [];
    function applyStair(st) {
      /* A STAIR HOLDS A TIP ONLY WHERE IT IS: a strip of it within STAIR_HOLD_MM of the tip in plan, with its top no more than
         STAIR_UNDER_MM under the tip's contact. On a steep underside (the wall of a cavity) the plan says a strip holds a
         tip the strip is millimetres below; that tip is left to the next round and the last resort, and named if no sheet fits */
      var reaches = function (t) {
        return st.layers.some(function (Ly) {
          if (Ly.z1 > t.contact[2] + 0.05 || Ly.z1 < t.contact[2] - STAIR_UNDER_MM) return false;
          return Ly.paths.some(function (pth) {
            for (var q = 0; q + 1 < pth.length; q++) if (segDist2(t.contact, pth[q], pth[q + 1]) <= STAIR_HOLD_MM) return true;
            return false;
          });
        });
      };
      st.carriers = st.carriers.filter(function (t) { return reaches(t); });
      st.held = st.held.filter(function (t) { return t.stairM == null || reaches(t); });
      /* a stair whose lowest strip no tip reaches would stand on nothing */
      if (!st.carriers.length) return false;
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
      return true;
    }


    /* A STAIR AGAIN ON WHAT IT LEFT. A stair stops where the gap would not hold for its next strip, or where the part
       leaves no room; the tips above are still tips whose level failed, and the same is asked of them: a stair of
       their own. Each round holds at least one tip more, so it ends. */
    if (opts.stairs !== false) {
      for (var rnd = 0; rnd < STAIR_ROUNDS; rnd++) {
        var found = buildStairs();
        if (!found.length) break;
        var applied = 0;
        found.forEach(function (st) { if (applyStair(st) !== false) { stairsBuilt.push(st); applied++; } });
        if (!applied) break;
      }
    }

    /* THE LAST RESORT, for a tip no level and no stair could carry (one tip at its height on a slope that left it out of
       every stair, a pair, a stair that stopped under it): a level of its own at its own height, and for one tip a sheet
       of one piece round its cap - the same four layers, under the lowest ceiling over its cell, at the gap. A tip a
       slope puts further up the piece's cell than the lowest ceiling stands under a sheet that is nearer there than the
       gap is only at its lowest point; no tip stays a bare pillar for want of a neighbour. */
    var lateLevels = [];
    if (opts.lone !== false) {
      var leftOver = tips.filter(function (t) { return t.mode === 'gap' && t.why && (t.why.indexOf('its level failed') === 0 || t.why === 'no line of the sheet reaches it') && columns[t.col]; })
        .sort(function (x, y) { return (x.zTop - y.zTop) || (x.i - y.i); });
      /* a level of these tips (the lowest ceiling of them, none more than LATE_TOL_MM above it); where that has no piece, each
         tip a level of its own, the widest cap first - and a tip whose own has none, with a sheet of another lying over its
         top, is cut under that one's lines as a tip no T line lies on is */
      var lateTry = function (group, how) {
        var L = { id: levels.length, first: group[0].zTop, tips: group.slice(), told: 0, lone: true };
        levels.push(L); lateLevels.push(L);
        group.forEach(function (t) { t.mode = 'sheet'; t.level = L.id; t.why = null; t.cap = null; });
        rebucket();
        solveLevel(L);
        if (L.ok) return;
        L.dead = true;
        if (group.length > 1) {
          group.forEach(function (t) { t.mode = 'gap'; t.level = -1; });
          if (how === 'cluster') {
            /* the cluster's one level had no piece: its tips in levels of a tenth of a layer or two, then alone */
            var sub = null;
            group.forEach(function (t) {
              if (sub && t.zTop - sub[0].zTop <= LATE_TOL_MM) sub.push(t);
              else { if (sub) lateTry(sub); sub = [t]; }
            });
            if (sub) lateTry(sub);
          } else group.forEach(function (t) { lateTry([t]); });
          return;
        }
        var t0 = group[0], reachTip = o.side * Math.SQRT1_2 + o.width / 2 + 0.05;
        levels.some(function (M) {
          if (!M.ok || M.dead || !M.res || M.stair || !M.lone || Math.abs(M.res.zTop - t0.zTop) > LATE_SPAN_MM) return false;
          var top = cutPath(columns[t0.col].pts, M.res.zCap, o.side, o.side)[0];
          var over = M.res.layers.some(function (Ly) {
            return Ly.paths.some(function (pth) {
              for (var q = 0; q + 1 < pth.length; q++) if (segDist2(top, pth[q], pth[q + 1]) <= reachTip) return true;
              return false;
            });
          });
          if (!over) return false;
          t0.mode = 'sheet'; t0.level = M.id; t0.cap = null; t0.carried = false; t0.top = [top[0], top[1]];
          t0.why = 'no T line lies on its cap; cut at z_cap under the sheet';
          M.tips.push(t0);
          return true;
        });
      };
      /* the tips left, in clusters (a tip within LATE_LINK_MM of another is its cluster's: a dome's few tips, 3 mm apart): a
         small cluster whose ceilings span LATE_SPAN_MM or less gets one level at the lowest of them first - one sheet across a
         dome's foot, as Bambu's rings are one footprint - and only where that has no piece the levels and the singles above */
      var par = leftOver.map(function (t, i) { return i; });
      var fnd = function (i) { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
      for (var ca = 0; ca < leftOver.length; ca++) for (var cb = ca + 1; cb < leftOver.length; cb++) {
        if (Math.hypot(leftOver[ca].contact[0] - leftOver[cb].contact[0], leftOver[ca].contact[1] - leftOver[cb].contact[1]) <= LATE_LINK_MM) {
          var ra = fnd(ca), rb = fnd(cb);
          if (ra !== rb) par[Math.max(ra, rb)] = Math.min(ra, rb);
        }
      }
      var clusters = {};
      leftOver.forEach(function (t, i) { (clusters[fnd(i)] = clusters[fnd(i)] || []).push(t); });
      Object.keys(clusters).map(Number).sort(function (x, y) { return x - y; }).forEach(function (k) {
        var cl = clusters[k];
        if (cl.length >= 2 && cl.length <= LATE_CLUSTER_MAX && cl[cl.length - 1].zTop - cl[0].zTop <= LATE_SPAN_MM) { lateTry(cl, 'cluster'); return; }
        var gi = null;
        cl.forEach(function (t) {
          if (gi && t.zTop - gi[0].zTop <= LATE_TOL_MM) gi.push(t);
          else { if (gi) lateTry(gi); gi = [t]; }
        });
        if (gi) lateTry(gi);
      });
      /* what a last-resort sheet built and did not reach (its lines came to one tip of the cluster and not the rest) is asked once
         more, a tip at a time: a sheet of its own, or cut under another's lines */
      tips.filter(function (t) { return t.mode === 'gap' && t.why === 'no line of the sheet reaches it' && columns[t.col] && t.level === -1; })
        .sort(function (x, y) { return (x.zTop - y.zTop) || (x.i - y.i); }).forEach(function (t) { lateTry([t]); });
    }

    /* the cut heights: a capped tip along its own leg, inside its cap (rise
       0: no upright run); an uncapped one flat at z_cap; a gap tip flat, the
       gap under the part */
    /* A FLARED CAP UNDER A REGION PLATE. The plate lies on the tip itself, so the tip was a bare column cut flat under it: a tube. Bambu's leg widens into a
       bowl under its transition (a platform of rings 3 - 5 mm across). The cap is the sheet's own (THE CAPS): a round frustum from CAP_RISE_MM down the leg
       to the plate's base, as wide as the nearest tip of the plate allows (held to the cap's maximum); the caller narrows it off the part. */
    function flareOf(t) {
      var col = columns[t.col];
      if (!col || !col.pts || col.pts.length < 2 || t.shellB == null) return null;
      var zCap = t.shellB, pts = col.pts;
      if (!(zCap - o.capRise - ROOM_MM > o.plateZ + o.foot)) return null;
      var top = colAxisAt(pts, zCap), foot = colAxisAt(pts, zCap - o.capRise), nn = Infinity;
      tips.forEach(function (u) {
        if (u === t || u.mode !== 'sheet' || u.shellB == null || !columns[u.col]) return;
        var ut = colAxisAt(columns[u.col].pts, u.shellB);
        nn = Math.min(nn, Math.hypot(ut[0] - top[0], ut[1] - top[1]));
      });
      var w = Math.min(o.capMax, Math.max(o.side + 0.2, nn * FLARE_OVERLAP));      /* neighbours' caps may run into each other: one platform, as Bambu's bowls do */
      /* never past the plate's perimeter: the cap's top disc stays inside the layer it meets (a tip stands >= 1 mm in from the surface's edge, a 4 mm cap would not) */
      var ml = plateUnder[t.i];
      if (ml) {
        var ic = (top[0] - ml.x0) / ml.cell, jc = (top[1] - ml.y0) / ml.cell, Rc = Math.ceil(o.capMax / ml.cell / 2) + 2, dEdge = Rc * ml.cell;
        for (var dj = -Rc; dj <= Rc; dj++) for (var di = -Rc; di <= Rc; di++) {
          var qi = Math.round(ic) + di, qj = Math.round(jc) + dj;
          if (qi >= 0 && qi < ml.w && qj >= 0 && qj < ml.h && ml.M[qj * ml.w + qi]) continue;
          dEdge = Math.min(dEdge, Math.max(0, Math.hypot(qi - ic, qj - jc) * ml.cell - ml.cell / 2));
        }
        w = Math.min(w, Math.max(CAP_TIP_MIN_MM, 2 * (dEdge - 0.05)));
      }
      return { c: top, b: foot, w: w, z0: zCap - o.capRise, z1: zCap, footD: CAP_FOOT * o.side, band: CAP_BAND_MM, nnMm: nn, why: null, slidMm: 0, flare: true };
    }
    tips.forEach(function (t) {
      if (t.mode === 'sheet') {
        var L = levels[t.level];
        if (L.shell) {
          t.zTop = t.zTop; t.zBase = t.shellB; t.cutZ = t.shellB; t.rise = o.side;
          var fc = o.flare ? flareOf(t) : null;
          if (fc) { t.cap = fc; t.capWhy = 'flared under the region plate'; t.cutZ = t.shellB - sink; t.rise = 0; }
          return;
        }
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
      if (wantPerim) out.outline = L.perim || null;
      /* a stair: the tips it holds by itself, and its shape */
      if (L.stair) {
        out.stair = L.stair.stair;
        out.held = tips.filter(function (t) { return t.mode === 'drop' && t.level === L.id; }).map(function (t) { return t.i; });
      }
      return out;
    });
    var counts = { sheet: 0, gap: 0, side: 0, caps: 0, drop: 0 };
    tips.forEach(function (t) { counts[t.mode]++; if (t.mode === 'sheet' && t.cap) counts.caps++; });
    var bare = tips.filter(function (t) { return t.mode === 'gap'; }).map(function (t) {
      return { i: t.i, beacon: t.beacon, label: t.label, contact: t.contact.slice(), why: t.why || 'no sheet could be built here' };
    });
    var notes = [], byWhy = {};
    bare.forEach(function (b) { (byWhy[b.why] = byWhy[b.why] || []).push(b); });
    /* a tip under the sheet that carries nothing (no T line lies on its cap) is said as well: it holds the ceiling by the sheet's lines */
    var loose = tips.filter(function (t) {
      if (t.mode !== 'sheet' && t.mode !== 'drop') return false;
      var Lv = levels[t.level];
      if (!Lv) return false;
      if (!Lv.stair) return t.contact[2] - Lv.res.zTop > HELD_FLAT_MM;
      return !Lv.stair.layers.some(function (Ly) {
        if (Ly.z1 > t.contact[2] + 0.05 || Ly.z1 < t.contact[2] - HELD_TOP_MM) return false;
        return Ly.paths.some(function (pth) {
          for (var q = 0; q + 1 < pth.length; q++) if (segDist2(t.contact, pth[q], pth[q + 1]) <= STAIR_HOLD_MM) return true;
          return false;
        });
      });
    }).map(function (t) { return { i: t.i, beacon: t.beacon, label: t.label, contact: t.contact.slice(), why: 'its sheet lies too far under it: no line of it comes within ' + STAIR_HOLD_MM + ' mm in plan and ' + HELD_TOP_MM + ' mm under its contact (the piece\'s flank keeps the lines 0.35 mm back)' }; });
    var uncarried = tips.filter(function (t) { return t.mode === 'sheet' && t.carried === false; }).map(function (t) { return { i: t.i, beacon: t.beacon, label: t.label, contact: t.contact.slice(), why: 'under the sheet, carrying nothing: no T line lies on its cap' }; });
    uncarried = uncarried.concat(loose);
    uncarried.forEach(function (b) { (byWhy[b.why] = byWhy[b.why] || []).push(b); });
    /* a side tip leaves a face steeper than the lean limit sideways and is held off it (said, never counted bare) */
    tips.filter(function (t) { return t.mode === 'side'; }).forEach(function (t) {
      (byWhy['a side tip: its face is too steep for a sheet, held off the face'] = byWhy['a side tip: its face is too steep for a sheet, held off the face'] || []).push({ contact: t.contact });
    });
    Object.keys(byWhy).sort().forEach(function (w) {
      var list = byWhy[w], at = list.slice(0, 3).map(function (b) { return '(' + b.contact.map(function (v) { return v.toFixed(1); }).join(', ') + ')'; }).join(' ');
      notes.push(list.length + (list.length === 1 ? ' tip has' : ' tips have') + ' no sheet under ' + (list.length === 1 ? 'it' : 'them') + ' (' + w + '), at ' + at + (list.length > 3 ? ' and ' + (list.length - 3) + ' more' : ''));
    });
    return {
      ok: true, gapMm: o.gap, layerMm: o.layer, widthMm: o.width, pitchMm: o.pitch, epsMm: o.eps, tipSpacingMm: spacing,
      cap: { riseMm: o.capRise, minMm: o.capMin, maxMm: o.capMax, gapMaxMm: CAP_GAP_MAX_MM, tuckMm: CAP_TUCK_MM, foot: CAP_FOOT },
      levels: lv, failed: levels.filter(function (L) { return !L.ok && !L.dead; }).map(function (L) { return { id: L.id, zTop: L.first, reason: L.reason }; }),
      tips: tips.map(function (t) {
        var cap = t.mode === 'sheet' && t.cap ? { c: t.cap.c, b: t.cap.b, w: t.cap.w, z0: t.cap.z0, z1: t.cap.z1, footD: t.cap.footD, band: t.cap.band, why: t.cap.why, flare: !!t.cap.flare } : null;
        return { i: t.i, label: t.label, beacon: t.beacon, col: t.col, contact: t.contact.slice(), mode: t.mode, level: t.level, carried: t.mode === 'sheet' ? t.carried !== false : null,
                 zTop: t.zTop, zBase: t.zBase, cutZ: t.cutZ, rise: t.mode === 'sheet' ? t.rise : null, cap: cap,
                 why: t.why || (t.mode === 'sheet' && !t.cap ? t.capWhy : null) || null };
      }),
      counts: counts,
      /* THE TIPS LEFT WITHOUT A SHEET, NAMED. A tip that meets the part and has no sheet under it is never silent: where
         it stands, and why none could be built - in words, one line a reason */
      bare: bare,
      uncarried: uncarried,
      notes: notes,
      reason: (function () {
        var nSt = lv.filter(function (L) { return L.stair; }), nFl = lv.length - nSt.length;
        return nFl + ' sheet(s) of ' + (2 + nI) + ' layers (2 transition, ' + nI + ' interface), each a loop and a serpentine, at ' + o.pitch + ' mm' +
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
    SHEET: { pitchMm: SHEET_PITCH_MM, densePitchMm: SHEET_DENSE_PITCH_MM, denseInterfaceLayers: 3, denseSheetLayerMm: 0.275, denseFlatGapMaxMm: 0.9, denseStairLegMm: STAIR_LEG_MM, roles: SHEET_ROLES.slice(), under: SHEET_UNDER, minRunMm: MIN_RUN_MM, cellMm: CELL_MM,
             sampleMm: SAMPLE_MM, lineAngles: LINE_ANGLES.slice(), fieldMm: FIELD_MM, levelEdgeMm: LEVEL_EDGE_MM,
             slicerSettings: Object.assign({}, SHEET_SLICER) },
    STAIR: { tipMm: STAIR_TIP_MM, backMm: STAIR_BACK_MM },
    CAP: { riseMm: CAP_RISE_MM, minMm: CAP_MIN_MM, maxMm: CAP_MAX_MM, spaceMm: CAP_SPACE_MM, gapMaxMm: CAP_GAP_MAX_MM,
           tuckMm: CAP_TUCK_MM, partMm: CAP_PART_MM, bandMm: CAP_BAND_MM, foot: CAP_FOOT },
    sheet: sheet,
    region: { edtCells: edtCells, isoLoops: isoLoops, simplifyRing: simplifyRing, fitRing: fitRing, concentricLoops: concentricLoops, plateOfRegion: plateOfRegion, smoothMask: smoothMask },     /* the region plate's geometry (docs/SUPPORT-FOOTPRINT.md section 9) */
    cutPath: cutPath,
    finish: finish,
    minDistance: function (A, B, opts) { return minDistance(mod(opts, 'thickness', 'NSO_Thickness'), A, B, opts); },
    exactDistance: function (A, B, opts) { return exactDistance(A, B, (opts && opts.reach) || Infinity); },
    _patch: function (cx, cy, zBase, o, repeats) { return patch(mod(o, 'crosshatch', 'NSO_Crosshatch'), cx, cy, zBase, o, repeats); }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SupportInterface = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
