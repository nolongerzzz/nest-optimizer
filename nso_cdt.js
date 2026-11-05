/* nso_cdt.js - a constrained Delaunay triangulation of points and segments in the plane, and Fill:
   a polygon (with holes) woven into an even mesh whose rim is the polygon's own corners.
   docs/WEAVE.md.

   Loads as a classic script (window.NSO_CDT) and as a Node module. No DOM, no THREE.

     NSO_CDT.triangulate(points, segments)  -> { tris: Int32Array, nTri, split } | { reason }
     NSO_CDT.fill(loops, opts)              -> { ok, P, T, nRim, ... } | { ok: false, reason }

   WHY IT EXISTS. Weave (nso_weave.js) cuts a patch out of a mesh and lays a new one in the hole. The new
   patch has to meet the old rim corner for corner - every corner of the rim is a corner of a new
   triangle, and no rim edge is split - or the join is not watertight. A polygon cannot be filled that way
   by ear clipping and bisection (sliver fans), and a plain Delaunay triangulation drops any rim edge whose
   diametral disc is not empty (a scan's rim is full of them). So: a CONSTRAINED Delaunay triangulation.

   triangulate: incremental Delaunay insertion (walk to the triangle, split it, flip the edges that fail
   the circle test), then each segment is forced in by Sloan's flip walk - the edges it crosses are flipped
   out of the way, a convex quad at a time - and the Delaunay flips that follow leave the segments alone.
   The corners are the points given; nothing is added or moved and no segment is split (a point that lies
   exactly on a segment splits that segment in two instead, and `split` counts them). Triangles come out
   counter-clockwise; the inside is what the segments enclose (crossing a segment turns in into out), so
   holes are just loops inside loops.

   fill: loops of 2D corners (outer counter-clockwise, holes clockwise, as an outline read off a mesh is) ->
   the loops' corners come first in P, in the order given, then the interior corners. The interior is a
   hex lattice at opts.pitch, graded toward the rim so the first row of new corners stands about as far
   from the rim as the rim's own corners stand from each other, thinned where the grading asks for finer,
   and relaxed (Laplacian smoothing of the interior corners, re-triangulated each pass). A rim edge is
   never split: what the rim was, it is. */
(function (root) {
  'use strict';

  /* ---------------------------------------------------------------- predicates
     Both return 0 when the answer is inside the rounding of the arithmetic, so a caller tests > 0, < 0 and 0. */

  function orient(ax, ay, bx, by, cx, cy) {
    var l = (bx - ax) * (cy - ay), r = (by - ay) * (cx - ax), d = l - r;
    return Math.abs(d) <= 1e-12 * (Math.abs(l) + Math.abs(r)) ? 0 : d;
  }
  // > 0 when d is inside the circle through counter-clockwise a, b, c
  function incircle(ax, ay, bx, by, cx, cy, dx, dy) {
    var adx = ax - dx, ady = ay - dy, bdx = bx - dx, bdy = by - dy, cdx = cx - dx, cdy = cy - dy;
    var al = adx * adx + ady * ady, bl = bdx * bdx + bdy * bdy, cl = cdx * cdx + cdy * cdy;
    var t1 = al * (bdx * cdy - cdx * bdy), t2 = bl * (cdx * ady - adx * cdy), t3 = cl * (adx * bdy - bdx * ady);
    var det = t1 + t2 + t3;
    var perm = al * (Math.abs(bdx * cdy) + Math.abs(cdx * bdy)) + bl * (Math.abs(cdx * ady) + Math.abs(adx * cdy)) + cl * (Math.abs(adx * bdy) + Math.abs(bdx * ady));
    return Math.abs(det) <= 1e-12 * perm ? 0 : det;
  }

  /* ------------------------------------------------------------ the triangulation */

  /* pts: array of [x, y]; segs: array of [i, j] indices into pts.
     nHard (optional): only the first nHard segments are outline - the rest are forced edges that do not turn in into out (a ridge
     line, a footprint drawn inside the shape). Left out, every segment is outline, as it always was. */
  function triangulate(pts, segs, nHard) {
    var n = pts.length, i, t;
    var hardN = nHard == null ? (segs ? segs.length : 0) : nHard, softNow = false;
    if (!n) return { tris: new Int32Array(0), nTri: 0, split: 0 };
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (i = 0; i < n; i++) {
      if (pts[i][0] < lo[0]) lo[0] = pts[i][0];
      if (pts[i][0] > hi[0]) hi[0] = pts[i][0];
      if (pts[i][1] < lo[1]) lo[1] = pts[i][1];
      if (pts[i][1] > hi[1]) hi[1] = pts[i][1];
    }
    var span = Math.max(hi[0] - lo[0], hi[1] - lo[1], 1e-6), cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, big = span * 64;
    var X = new Float64Array(n + 3), Y = new Float64Array(n + 3);
    // the super triangle's corners are ids 0, 1, 2; the caller's point k is k + 3
    X[0] = cx - big; Y[0] = cy - big; X[1] = cx + big; Y[1] = cy - big; X[2] = cx; Y[2] = cy + big;
    for (i = 0; i < n; i++) { X[i + 3] = pts[i][0]; Y[i + 3] = pts[i][1]; }
    // V: three corners a triangle, counter-clockwise. N[3t + k]: the triangle across the edge opposite corner k
    // (or -1). C[3t + k]: that edge is a segment.
    var V = [0, 1, 2], N = [-1, -1, -1], C = [0, 0, 0];
    var vtri = new Int32Array(n + 3).fill(-1);
    vtri[0] = vtri[1] = vtri[2] = 0;
    var nTri = 1, last = 0, split = 0;

    function newTri() { V.push(0, 0, 0); N.push(-1, -1, -1); C.push(0, 0, 0); return nTri++; }
    function slotOf(tr, nb) { return N[3 * tr] === nb ? 0 : N[3 * tr + 1] === nb ? 1 : 2; }
    function relink(nb, oldT, newT) { if (nb >= 0) N[3 * nb + slotOf(nb, oldT)] = newT; }
    function setTri(tr, a, b, c) { V[3 * tr] = a; V[3 * tr + 1] = b; V[3 * tr + 2] = c; vtri[a] = tr; vtri[b] = tr; vtri[c] = tr; }
    function cornerOf(tr, v) { return V[3 * tr] === v ? 0 : V[3 * tr + 1] === v ? 1 : 2; }

    /* Flip the edge opposite corner k of t: t = (A, p, q) and u across it = (D, q, p) become t = (A, p, D), u = (A, D, q). */
    function flip(tr, k) {
      var A = V[3 * tr + k], p = V[3 * tr + (k + 1) % 3], q = V[3 * tr + (k + 2) % 3];
      var u = N[3 * tr + k], j = slotOf(u, tr), D = V[3 * u + j];
      var nbtp = N[3 * tr + (k + 1) % 3], nbtq = N[3 * tr + (k + 2) % 3], ctp = C[3 * tr + (k + 1) % 3], ctq = C[3 * tr + (k + 2) % 3];
      var nbuq = N[3 * u + (j + 1) % 3], nbup = N[3 * u + (j + 2) % 3], cuq = C[3 * u + (j + 1) % 3], cup = C[3 * u + (j + 2) % 3];
      setTri(tr, A, p, D); setTri(u, A, D, q);
      N[3 * tr] = nbuq; C[3 * tr] = cuq; N[3 * tr + 1] = u; C[3 * tr + 1] = 0; N[3 * tr + 2] = nbtq; C[3 * tr + 2] = ctq;
      N[3 * u] = nbup; C[3 * u] = cup; N[3 * u + 1] = nbtp; C[3 * u + 1] = ctp; N[3 * u + 2] = tr; C[3 * u + 2] = 0;
      relink(nbuq, u, tr);
      relink(nbtp, tr, u);
    }

    // `st` holds (corner, triangle) pairs: the edge opposite that corner of that triangle is to be checked
    function legalize(st) {
      while (st.length) {
        var tr = st.pop(), k = st.pop();
        if (C[3 * tr + k]) continue;
        var u = N[3 * tr + k];
        if (u < 0) continue;
        var D = V[3 * u + slotOf(u, tr)], a = V[3 * tr], b = V[3 * tr + 1], c = V[3 * tr + 2];
        if (incircle(X[a], Y[a], X[b], Y[b], X[c], Y[c], X[D], Y[D]) > 0) {
          flip(tr, k);                                       // the new point is now corner 0 of both, so the outer edges face corner 0
          st.push(0, tr, 0, u);
        }
      }
    }

    /* The triangle holding (x, y), and the slot of the edge it lies on (-1: inside). */
    function locate(x, y) {
      var tr = last, steps = 0, guard = 4 * nTri + 64;
      for (;;) {
        var moved = false, on = -1, k0 = steps % 3;
        for (var kk = 0; kk < 3; kk++) {
          var k = (k0 + kk) % 3, b = V[3 * tr + (k + 1) % 3], c = V[3 * tr + (k + 2) % 3], o = orient(X[b], Y[b], X[c], Y[c], x, y);
          if (o < 0) {
            var nb = N[3 * tr + k];
            if (nb < 0) return null;
            tr = nb; moved = true; break;
          }
          if (o === 0) on = k;
        }
        if (!moved) return { t: tr, edge: on };
        if (++steps > guard) break;
      }
      for (tr = 0; tr < nTri; tr++) {                        // a walk that circles: look at every triangle
        var inside = true, on2 = -1;
        for (var q = 0; q < 3; q++) {
          var bb = V[3 * tr + (q + 1) % 3], cc = V[3 * tr + (q + 2) % 3], oo = orient(X[bb], Y[bb], X[cc], Y[cc], x, y);
          if (oo < 0) { inside = false; break; }
          if (oo === 0) on2 = q;
        }
        if (inside) return { t: tr, edge: on2 };
      }
      return null;
    }

    // -> the corner id the point is (its own, or the earlier corner it duplicates), or -1
    function insert(v) {
      var x = X[v], y = Y[v], loc = locate(x, y);
      if (!loc) return -1;
      var tr = loc.t, a = V[3 * tr], b = V[3 * tr + 1], c = V[3 * tr + 2], q, st = [];
      for (q = 0; q < 3; q++) {
        var w = V[3 * tr + q];
        if (Math.abs(X[w] - x) < 1e-12 && Math.abs(Y[w] - y) < 1e-12) return w;
      }
      if (loc.edge < 0) {                                    // inside: three triangles
        var nbA = N[3 * tr], nbB = N[3 * tr + 1], nbC = N[3 * tr + 2], cA = C[3 * tr], cB = C[3 * tr + 1], cC = C[3 * tr + 2];
        var t1 = newTri(), t2 = newTri();
        setTri(tr, a, b, v); setTri(t1, b, c, v); setTri(t2, c, a, v);
        // tr = (a, b, v): opposite a is (b, v) -> t1; opposite b is (v, a) -> t2; opposite v is (a, b) -> nbC
        N[3 * tr] = t1; N[3 * tr + 1] = t2; N[3 * tr + 2] = nbC; C[3 * tr] = 0; C[3 * tr + 1] = 0; C[3 * tr + 2] = cC;
        // t1 = (b, c, v): opposite b is (c, v) -> t2; opposite c is (v, b) -> tr; opposite v is (b, c) -> nbA
        N[3 * t1] = t2; N[3 * t1 + 1] = tr; N[3 * t1 + 2] = nbA; C[3 * t1] = 0; C[3 * t1 + 1] = 0; C[3 * t1 + 2] = cA;
        // t2 = (c, a, v): opposite c is (a, v) -> tr; opposite a is (v, c) -> t1; opposite v is (c, a) -> nbB
        N[3 * t2] = tr; N[3 * t2 + 1] = t1; N[3 * t2 + 2] = nbB; C[3 * t2] = 0; C[3 * t2 + 1] = 0; C[3 * t2 + 2] = cB;
        relink(nbA, tr, t1); relink(nbB, tr, t2);
        st.push(2, tr, 2, t1, 2, t2);
        legalize(st);
        last = tr;
        return v;
      }
      // on an edge: four triangles. t = (A, B, E), the point v on its edge (B, E); u across = (D, E, B)
      var e = loc.edge, u = N[3 * tr + e];
      if (u < 0) return -1;
      var A = V[3 * tr + e], B = V[3 * tr + (e + 1) % 3], E = V[3 * tr + (e + 2) % 3];
      var nbB2 = N[3 * tr + (e + 1) % 3], nbE = N[3 * tr + (e + 2) % 3], cB2 = C[3 * tr + (e + 1) % 3], cE2 = C[3 * tr + (e + 2) % 3], cX = C[3 * tr + e];
      var j = slotOf(u, tr), D = V[3 * u + j];
      var nBD = N[3 * u + (j + 1) % 3], nDE = N[3 * u + (j + 2) % 3], cBD = C[3 * u + (j + 1) % 3], cDE = C[3 * u + (j + 2) % 3];
      if (cX) split++;
      var T2 = newTri(), U2 = newTri();
      setTri(tr, A, B, v); setTri(T2, A, v, E); setTri(u, D, E, v); setTri(U2, D, v, B);
      // T1 = tr = (A, B, v): opposite A (B, v) -> U2; opposite B (v, A) -> T2; opposite v (A, B) -> nbE
      N[3 * tr] = U2; N[3 * tr + 1] = T2; N[3 * tr + 2] = nbE; C[3 * tr] = cX; C[3 * tr + 1] = 0; C[3 * tr + 2] = cE2;
      // T2 = (A, v, E): opposite A (v, E) -> u; opposite v (E, A) -> nbB2; opposite E (A, v) -> T1
      N[3 * T2] = u; N[3 * T2 + 1] = nbB2; N[3 * T2 + 2] = tr; C[3 * T2] = cX; C[3 * T2 + 1] = cB2; C[3 * T2 + 2] = 0;
      // U1 = u = (D, E, v): opposite D (E, v) -> T2; opposite E (v, D) -> U2; opposite v (D, E) -> nDE
      N[3 * u] = T2; N[3 * u + 1] = U2; N[3 * u + 2] = nDE; C[3 * u] = cX; C[3 * u + 1] = 0; C[3 * u + 2] = cDE;
      // U2 = (D, v, B): opposite D (v, B) -> T1; opposite v (B, D) -> nBD; opposite B (D, v) -> U1
      N[3 * U2] = tr; N[3 * U2 + 1] = nBD; N[3 * U2 + 2] = u; C[3 * U2] = cX; C[3 * U2 + 1] = cBD; C[3 * U2 + 2] = 0;
      relink(nbB2, tr, T2); relink(nBD, u, U2);
      st.push(2, tr, 1, T2, 2, u, 1, U2);
      legalize(st);
      last = tr;
      return v;
    }

    // the points in a boustrophedon over coarse rows, which keeps each walk short
    var order = new Array(n);
    for (i = 0; i < n; i++) order[i] = i;
    var cell = span / Math.max(1, Math.sqrt(n));
    var rowOf = function (k) { return Math.floor((Y[k + 3] - lo[1]) / cell); };
    order.sort(function (p, q) {
      var rp = rowOf(p), rq = rowOf(q);
      if (rp !== rq) return rp - rq;
      return (rp & 1) ? X[q + 3] - X[p + 3] : X[p + 3] - X[q + 3];
    });
    var rep = new Int32Array(n + 3);                          // the corner a point stands for (itself unless it duplicates one)
    for (i = 0; i < n + 3; i++) rep[i] = i;
    for (i = 0; i < n; i++) {
      var kp = order[i] + 3, r = insert(kp);
      if (r < 0) return { reason: 'a corner could not be placed (' + X[kp].toFixed(4) + ', ' + Y[kp].toFixed(4) + ')' };
      rep[kp] = r;
    }

    /* ---- the segments */
    // the edge a-b, as { t, k } (it is the edge opposite corner k of t), or null
    function findEdge(a, b) {
      var tr = vtri[a], first = tr, g = 0, s;
      if (tr < 0) return null;
      do {                                                   // counter-clockwise round a ...
        s = cornerOf(tr, a);
        if (V[3 * tr + (s + 1) % 3] === b) return { t: tr, k: (s + 2) % 3 };
        if (V[3 * tr + (s + 2) % 3] === b) return { t: tr, k: (s + 1) % 3 };
        tr = N[3 * tr + (s + 1) % 3];
        if (++g > 1000000) return null;
      } while (tr >= 0 && tr !== first);
      if (tr < 0) {                                          // ... and, if the star is open (a corner of the super triangle), clockwise
        tr = first;
        for (g = 0; g < 1000000; g++) {
          s = cornerOf(tr, a);
          tr = N[3 * tr + (s + 2) % 3];
          if (tr < 0) return null;
          s = cornerOf(tr, a);
          if (V[3 * tr + (s + 1) % 3] === b) return { t: tr, k: (s + 2) % 3 };
          if (V[3 * tr + (s + 2) % 3] === b) return { t: tr, k: (s + 1) % 3 };
        }
      }
      return null;
    }
    function mark(a, b) {
      var e = findEdge(a, b);
      if (!e) return false;
      var v = softNow ? 2 : 1;                               // 1: outline, 2: forced but not outline
      if (C[3 * e.t + e.k] !== 1) C[3 * e.t + e.k] = v;
      var u = N[3 * e.t + e.k];
      if (u >= 0 && C[3 * u + slotOf(u, e.t)] !== 1) C[3 * u + slotOf(u, e.t)] = v;
      return true;
    }
    function crosses(a, b, p, q) {                           // the open segment p-q crosses the open segment a-b
      var o1 = orient(X[a], Y[a], X[b], Y[b], X[p], Y[p]), o2 = orient(X[a], Y[a], X[b], Y[b], X[q], Y[q]);
      var o3 = orient(X[p], Y[p], X[q], Y[q], X[a], Y[a]), o4 = orient(X[p], Y[p], X[q], Y[q], X[b], Y[b]);
      return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
    }
    function edgeSlot(tr, p, q) {                            // the corner of tr opposite its edge p-q
      for (var k = 0; k < 3; k++) {
        var u = V[3 * tr + (k + 1) % 3], w = V[3 * tr + (k + 2) % 3];
        if ((u === p && w === q) || (u === q && w === p)) return k;
      }
      return -1;
    }
    // the triangle at a whose wedge holds the direction a -> b: its corner at a is slot s, x then y counter-clockwise
    function wedge(a, b) {
      var tr = vtri[a], first = tr, g = 0;
      do {
        var s = cornerOf(tr, a), x = V[3 * tr + (s + 1) % 3], y = V[3 * tr + (s + 2) % 3];
        if (orient(X[a], Y[a], X[x], Y[x], X[b], Y[b]) >= 0 && orient(X[a], Y[a], X[b], Y[b], X[y], Y[y]) >= 0) return { t: tr, s: s, x: x, y: y };
        tr = N[3 * tr + (s + 1) % 3];
        if (tr < 0 || ++g > 1000000) return null;
      } while (tr !== first);
      return null;
    }
    function insertSeg(a, b, depth) {
      if (a === b) return true;
      if (depth > 64) return false;
      if (mark(a, b)) return true;
      var w = wedge(a, b);
      if (!w) return false;
      if (w.x === b || w.y === b) return mark(a, b);
      // the edges the segment crosses, from the one opposite a in the wedge on; ex stays on the right of a->b, ey on the left
      var crossed = [[w.x, w.y]], cur = w.t, ex = w.x, ey = w.y, guard = 0;
      for (;;) {
        var k = edgeSlot(cur, ex, ey);
        if (k < 0) return false;
        var nb = N[3 * cur + k];
        if (nb < 0) return false;
        var apex = V[3 * nb + slotOf(nb, cur)];
        if (apex === b) break;
        var o = orient(X[a], Y[a], X[b], Y[b], X[apex], Y[apex]);
        if (o === 0) {                                       // a corner stands on the segment: it is two segments
          split++;
          return insertSeg(a, apex, depth + 1) && insertSeg(apex, b, depth + 1);
        }
        if (o > 0) ey = apex; else ex = apex;
        crossed.push([ex, ey]);
        cur = nb;
        if (++guard > 1000000) return false;
      }
      var queue = crossed, qi = 0, iter = 0, cap = 50 * crossed.length + 1000;
      while (qi < queue.length) {
        if (++iter > cap) return false;
        var ed = queue[qi++], p = ed[0], q = ed[1], fe = findEdge(p, q);
        if (!fe) continue;
        if (C[3 * fe.t + fe.k]) return false;                 // a segment in the way of a segment: the outline crosses itself
        var tt = fe.t, kk = fe.k, uu = N[3 * tt + kk];
        if (uu < 0) return false;
        var rr = V[3 * tt + kk], ss = V[3 * uu + slotOf(uu, tt)];
        // the quad p, rr, q, ss is convex when rr-ss crosses p-q; if not, leave it for later
        var o1 = orient(X[rr], Y[rr], X[ss], Y[ss], X[p], Y[p]), o2 = orient(X[rr], Y[rr], X[ss], Y[ss], X[q], Y[q]);
        if (!((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0))) { queue.push(ed); continue; }
        flip(tt, kk);
        if (crosses(a, b, rr, ss)) queue.push([rr, ss]);
      }
      return mark(a, b);
    }
    for (i = 0; i < segs.length; i++) {
      var sa = rep[segs[i][0] + 3], sb = rep[segs[i][1] + 3];
      softNow = i >= hardN;
      if (!insertSeg(sa, sb, 0)) {
        return { reason: 'the outline could not be forced into the triangulation (it crosses itself near ' +
          X[sa].toFixed(3) + ', ' + Y[sa].toFixed(3) + ')', badSeg: i };
      }
    }

    /* ---- Delaunay again, leaving the segments alone */
    var stack = [];
    for (t = 0; t < nTri; t++) for (var kq = 0; kq < 3; kq++) { if (N[3 * t + kq] > t && !C[3 * t + kq]) stack.push(kq, t); }
    var rounds = 0, maxRounds = 60 * nTri + 1000;
    while (stack.length && rounds++ < maxRounds) {
      var t2 = stack.pop(), k2 = stack.pop();
      if (C[3 * t2 + k2]) continue;
      var u2 = N[3 * t2 + k2];
      if (u2 < 0) continue;
      var D2 = V[3 * u2 + slotOf(u2, t2)], a2 = V[3 * t2], b2 = V[3 * t2 + 1], c2 = V[3 * t2 + 2];
      if (incircle(X[a2], Y[a2], X[b2], Y[b2], X[c2], Y[c2], X[D2], Y[D2]) <= 0) continue;
      var A2 = V[3 * t2 + k2], p2 = V[3 * t2 + (k2 + 1) % 3], q2 = V[3 * t2 + (k2 + 2) % 3];
      var s1 = orient(X[A2], Y[A2], X[D2], Y[D2], X[p2], Y[p2]), s2 = orient(X[A2], Y[A2], X[D2], Y[D2], X[q2], Y[q2]);
      if (!((s1 < 0 && s2 > 0) || (s1 > 0 && s2 < 0))) continue;        // not a convex quad: leave it
      flip(t2, k2);
      // t = (A, p, D), u = (A, D, q): the quad's four outer edges
      stack.push(0, t2, 2, t2, 0, u2, 1, u2);
    }

    /* ---- inside: from the super triangle out, crossing a segment turns out into in */
    var state = new Int8Array(nTri).fill(-1), qq = [], qh = 0;
    for (t = 0; t < nTri; t++) if (V[3 * t] < 3 || V[3 * t + 1] < 3 || V[3 * t + 2] < 3) { state[t] = 0; qq.push(t); }
    while (qh < qq.length) {
      var tc = qq[qh++];
      for (var k3 = 0; k3 < 3; k3++) {
        var nb3 = N[3 * tc + k3];
        if (nb3 < 0 || state[nb3] >= 0) continue;
        state[nb3] = C[3 * tc + k3] === 1 ? 1 - state[tc] : state[tc];
        qq.push(nb3);
      }
    }
    var out = [], m = 0;
    for (t = 0; t < nTri; t++) {
      if (state[t] !== 1) continue;
      out.push(rep[V[3 * t]] - 3, rep[V[3 * t + 1]] - 3, rep[V[3 * t + 2]] - 3);
      m++;
    }
    return { tris: Int32Array.from(out), nTri: m, split: split };
  }

  /* ------------------------------------------------------------------ fill */

  function area2(p) {
    var s = 0;
    for (var i = 0, n = p.length; i < n; i++) { var a = p[i], b = p[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1]; }
    return s;
  }
  function median(a) { if (!a.length) return 0; var b = a.slice().sort(function (x, y) { return x - y; }); return b[b.length >> 1]; }

  /* loops: arrays of [x, y]. opts: pitch (the interior's edge length; the median rim edge if absent), grade (how
     fast the mesh coarsens from the rim, default 0.35), smooth (relaxing passes, default 4), maxTris.
     -> { ok, P (rim corners first), T (Int32Array, counter-clockwise), nRim, nTri, ... } or { ok: false, reason }. */
  function fill(loops, opts) {
    var o = opts || {}, i, j;
    var rim = [], segs = [], starts = [];
    loops.forEach(function (L) {
      var s0 = rim.length, m = L.length;
      starts.push(s0);
      for (var q = 0; q < m; q++) { rim.push([L[q][0], L[q][1]]); segs.push([s0 + q, s0 + (q + 1) % m]); }
    });
    var nRim = rim.length;
    if (nRim < 3) return { ok: false, reason: 'there is no outline to fill' };
    // the rim's own spacing at each corner: the mean of the two edges that meet there
    var hb = new Float64Array(nRim), allE = [];
    loops.forEach(function (L, li) {
      var s0 = starts[li], m = L.length;
      for (var q = 0; q < m; q++) {
        var a = rim[s0 + (q + m - 1) % m], b = rim[s0 + q], c = rim[s0 + (q + 1) % m];
        var e1 = Math.hypot(b[0] - a[0], b[1] - a[1]), e2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
        hb[s0 + q] = (e1 + e2) / 2;
        allE.push(e2);
      }
    });
    var h0 = o.pitch > 0 ? o.pitch : median(allE);
    if (!(h0 > 0)) return { ok: false, reason: 'the outline has no length' };
    var grade = o.grade > 0 ? o.grade : 0.35, maxTris = o.maxTris > 0 ? o.maxTris : 600000;
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (i = 0; i < nRim; i++) {
      if (rim[i][0] < lo[0]) lo[0] = rim[i][0];
      if (rim[i][0] > hi[0]) hi[0] = rim[i][0];
      if (rim[i][1] < lo[1]) lo[1] = rim[i][1];
      if (rim[i][1] > hi[1]) hi[1] = rim[i][1];
    }
    if ((hi[0] - lo[0]) * (hi[1] - lo[1]) / (h0 * h0 * 0.866) > maxTris * 3) {
      return { ok: false, tooMany: true, reason: 'that patch would need over ' + maxTris + ' triangles at a pitch of ' + h0.toFixed(3) + ' mm - raise the pitch' };
    }

    // the rim's segments in a grid, for the distance to the rim and its spacing there
    var cs = Math.max(h0 * 3, 1e-3), sgrid = new Map();
    segs.forEach(function (s, si) {
      var a = rim[s[0]], b = rim[s[1]];
      var x0 = Math.floor((Math.min(a[0], b[0]) - lo[0]) / cs), x1 = Math.floor((Math.max(a[0], b[0]) - lo[0]) / cs);
      var y0 = Math.floor((Math.min(a[1], b[1]) - lo[1]) / cs), y1 = Math.floor((Math.max(a[1], b[1]) - lo[1]) / cs);
      for (var ix = x0; ix <= x1; ix++) for (var iy = y0; iy <= y1; iy++) {
        var k = ix + ',' + iy, l = sgrid.get(k);
        if (l) l.push(si); else sgrid.set(k, [si]);
      }
    });
    function nearRim(x, y) {                                 // the distance to the rim and the rim's spacing there; Infinity far away (over 3 pitches)
      var ix = Math.floor((x - lo[0]) / cs), iy = Math.floor((y - lo[1]) / cs), best = Infinity, bh = h0;
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
        var l = sgrid.get((ix + dx) + ',' + (iy + dy));
        if (!l) continue;
        for (var q = 0; q < l.length; q++) {
          var s = segs[l[q]], a = rim[s[0]], b = rim[s[1]], abx = b[0] - a[0], aby = b[1] - a[1], L2 = abx * abx + aby * aby;
          var tt = L2 > 0 ? ((x - a[0]) * abx + (y - a[1]) * aby) / L2 : 0;
          tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
          var d = Math.hypot(x - (a[0] + tt * abx), y - (a[1] + tt * aby));
          if (d < best) { best = d; bh = hb[s[0]] * (1 - tt) + hb[s[1]] * tt; }
        }
      }
      return { d: best, hb: bh };
    }
    function inside(x, y) {                                  // even-odd over every loop
      var c = false;
      for (var li = 0; li < loops.length; li++) {
        var s0 = starts[li], m = loops[li].length;
        for (var q = 0, w = m - 1; q < m; w = q++) {
          var a = rim[s0 + q], b = rim[s0 + w];
          if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
        }
      }
      return c;
    }
    var hFloor = 0.6 * h0;
    function sizing(x, y) {                                  // the edge length wanted at a place, and how far it is from the rim
      var r = nearRim(x, y);
      if (!isFinite(r.d)) return { h: h0, d: Infinity };
      var rimH = Math.max(hFloor, Math.min(2 * h0, r.hb));
      var w = Math.exp(-r.d * grade / Math.max(h0, rimH));
      return { h: h0 * (1 - w) + rimH * w, d: r.d };
    }

    // the interior corners: the lattice at the pitch where the grading wants about that, a finer one where it wants less
    var accepted = [], acc = new Map(), hmin = Math.min(h0, hFloor), ac = h0 * 1.2;
    function crowded(x, y, r) {
      var ix = Math.floor((x - lo[0]) / ac), iy = Math.floor((y - lo[1]) / ac), rr = Math.ceil(r / ac);
      for (var dx = -rr; dx <= rr; dx++) for (var dy = -rr; dy <= rr; dy++) {
        var l = acc.get((ix + dx) + ',' + (iy + dy));
        if (!l) continue;
        for (var q = 0; q < l.length; q++) if (Math.hypot(accepted[l[q]][0] - x, accepted[l[q]][1] - y) < r) return true;
      }
      return false;
    }
    function accept(x, y) {
      accepted.push([x, y]);
      var k = Math.floor((x - lo[0]) / ac) + ',' + Math.floor((y - lo[1]) / ac), l = acc.get(k);
      if (l) l.push(accepted.length - 1); else acc.set(k, [accepted.length - 1]);
    }
    var dh0 = h0 * Math.sqrt(3) / 2, rows = Math.floor((hi[1] - lo[1]) / dh0) + 1, row, col;
    for (row = 0; row <= rows; row++) {
      var y1 = lo[1] + row * dh0, sx = lo[0] + ((row & 1) ? h0 / 2 : 0), cols = Math.floor((hi[0] - sx) / h0) + 1;
      for (col = 0; col <= cols; col++) {
        var x1 = sx + col * h0;
        if (x1 > hi[0] || y1 > hi[1] || !inside(x1, y1)) continue;
        var sz = sizing(x1, y1);
        if (sz.d < 0.55 * sz.h || sz.h < 0.9 * h0) continue;
        accept(x1, y1);
      }
    }
    if (hmin < 0.9 * h0) {
      var dh = hmin * Math.sqrt(3) / 2, rows2 = Math.floor((hi[1] - lo[1]) / dh) + 1;
      for (row = 0; row <= rows2; row++) {
        var y2 = lo[1] + row * dh + 0.31 * hmin, sx2 = lo[0] + ((row & 1) ? hmin / 2 : 0) + 0.17 * hmin, cols2 = Math.floor((hi[0] - sx2) / hmin) + 1;
        for (col = 0; col <= cols2; col++) {
          var x2 = sx2 + col * hmin;
          if (x2 > hi[0] || y2 > hi[1] || !inside(x2, y2)) continue;
          var sz2 = sizing(x2, y2);
          if (sz2.h >= 0.9 * h0 || sz2.d < 0.55 * sz2.h || crowded(x2, y2, 0.8 * sz2.h)) continue;
          accept(x2, y2);
        }
      }
    }
    var pts = rim.concat(accepted);
    // relaxing passes: 4 for a patch of a few thousand corners, fewer as it grows (each is a whole triangulation)
    var passes = o.smooth >= 0 ? o.smooth : (pts.length > 60000 ? 1 : pts.length > 25000 ? 2 : 4);
    if (pts.length > maxTris) return { ok: false, tooMany: true, reason: 'that patch would need over ' + maxTris + ' triangles - raise the pitch' };

    // triangulate, relax the interior corners toward the mean of their neighbours, triangulate again
    var tri = null, pass;
    for (pass = 0; pass <= passes; pass++) {
      tri = triangulate(pts, segs);
      if (tri.reason) return { ok: false, reason: tri.reason };
      if (pass === passes) break;
      var sumx = new Float64Array(pts.length), sumy = new Float64Array(pts.length), cnt = new Float64Array(pts.length);
      for (j = 0; j < tri.nTri; j++) {
        var ia = tri.tris[3 * j], ib = tri.tris[3 * j + 1], ic = tri.tris[3 * j + 2];
        sumx[ia] += pts[ib][0] + pts[ic][0]; sumy[ia] += pts[ib][1] + pts[ic][1]; cnt[ia] += 2;
        sumx[ib] += pts[ia][0] + pts[ic][0]; sumy[ib] += pts[ia][1] + pts[ic][1]; cnt[ib] += 2;
        sumx[ic] += pts[ia][0] + pts[ib][0]; sumy[ic] += pts[ia][1] + pts[ib][1]; cnt[ic] += 2;
      }
      for (i = nRim; i < pts.length; i++) {
        if (!cnt[i]) continue;
        var nx = sumx[i] / cnt[i], ny = sumy[i] / cnt[i];
        if (!inside(nx, ny)) continue;
        var sz3 = sizing(nx, ny);
        if (sz3.d < 0.45 * sz3.h) continue;                   // not into the rim's margin
        pts[i] = [pts[i][0] + 0.7 * (nx - pts[i][0]), pts[i][1] + 0.7 * (ny - pts[i][1])];
      }
    }
    // an interior corner no triangle uses is not a corner (a rim corner always is)
    var used = new Uint8Array(pts.length);
    for (j = 0; j < tri.tris.length; j++) used[tri.tris[j]] = 1;
    var remap = new Int32Array(pts.length).fill(-1), P = [], k2 = 0;
    for (i = 0; i < pts.length; i++) if (i < nRim || used[i]) { remap[i] = k2++; P.push(pts[i]); }
    var T = new Int32Array(tri.tris.length);
    for (j = 0; j < T.length; j++) T[j] = remap[tri.tris[j]];
    var flat = 0, areaGot = 0, want = 0;
    for (j = 0; j < T.length; j += 3) {
      var a3 = P[T[j]], b3 = P[T[j + 1]], c3 = P[T[j + 2]], ar = (b3[0] - a3[0]) * (c3[1] - a3[1]) - (b3[1] - a3[1]) * (c3[0] - a3[0]);
      if (!(ar > 0)) flat++;
      areaGot += ar / 2;
    }
    loops.forEach(function (L) { want += area2(L) / 2; });
    return { ok: true, P: P, T: T, nRim: nRim, nTri: T.length / 3, flat: flat, areaGot: areaGot, areaWant: want, pitch: h0, split: tri.split };
  }

  var API = { triangulate: triangulate, fill: fill, _orient: orient, _incircle: incircle };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_CDT = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
