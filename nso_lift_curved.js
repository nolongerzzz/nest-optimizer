/* nso_lift_curved.js - Lift 3: the repair under a detail lifted off a CURVED
   base. The surrounding exposed surface, carried across the footprint and
   welded to the real neighbour triangles at the rim.

   Loads as a classic script (window.NSO_LiftCurved) and as a Node module
   (require('../nso_lift_curved.js')). No DOM, no Three.js. nso_lift_auto.js
   calls it from Lift and Remove for an island it read with { curved: true }
   whose base is not one flat plane; everything else there is Lift 2's.

   READ docs/LIFT.md FIRST (section 6, "Lift 3").

   ---------------------------------------------------------------------------
   WHAT THE FILL IS
   ---------------------------------------------------------------------------
   Looking down the map's view n, the island's root loops (where it meets the
   face) are a polygon - with holes for a ring's bore. The fill is that
   polygon triangulated, with points inside it, each point lifted to a height
   along n:

     rim      the root loops' OWN vertices, unmoved: the fill shares them
              with the real neighbour triangles, so it is welded to them -
              the same position, bit for bit, no step.
     inside   a lattice of points, spacing about one root edge (the size of
              the neighbours' triangles), none closer than 0.45 of it to the
              rim; the loops ear-clipped by the cut engine (capFor ->
              rawFlatCapLoops), then each point inserted and the triangles
              kept Delaunay (Lawson flips; the root edges are never flipped).
     height   w = B + d. B is the rolling-ball base nso_lift_auto.js already
              fit to the exposed surround (the map's estimate, read
              bilinearly). d is how far the real surface stands off B:
              measured on the exposed neighbours all round (a local height
              grid of every triangle facing the view that is not part of a
              detail), and inside the footprint the d that minimises
                  sum (Laplacian d)^2  +  4 / relaxMm^4 * sum d^2
              with the exposed cells held. The first term carries the
              neighbours' height AND slope across the rim (a C1 join - a
              harmonic fill would match only the height); the second lets d
              die away into B over about relaxMm (1.5 mm, the width of the
              ring the base was measured on). So where the base estimate and
              the real neighbours disagree, the boundary follows the
              neighbours and the middle relaxes to the estimate. Nothing
              else: no smoothing of B, no texture made up.

   The plate gains the fill facing out; the lifted piece gains the same fill
   turned over as its back. Plate + piece = the source, exactly.

   API
     fill(A, I, ear, opts) -> { ok, cap, stats, reason }
         A    nso_lift_auto.js's analysis (its M, map.grid, map.B, islandOf)
         I    the island (its tris, loops, frame = the view's)
         ear  capFor's triangles on the root loops (facing out), flat
              [x, y, z, ...] at the loop vertices
         cap  the fill, the same layout: triangles facing out
     baseSampler(grid, B) -> (u, v) => B read bilinearly (NaN off the surface)

   PAINT SCOPE: NONE, for this module. It reads soups and writes none.
*/
(function (root) {
  'use strict';

  var DEFAULTS = {
    relaxMm: 1.5,          // d dies away into the base over about this
    spacingMinMm: 0.12,    // the lattice inside: about one root edge, kept within these
    spacingMaxMm: 0.8,
    clearFrac: 0.45,       // ...no point closer than this many spacings to the rim
    maxPoints: 20000,      // coarser past this many points
    cgTol: 1e-11,
    cgMax: 8000
  };

  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  /** The map's base estimate, read bilinearly between cell centres; corners
      off the surface (NaN) are left out, NaN when all four are. */
  function baseSampler(G, B) {
    var nu = G.nu, nv = G.nv, cell = G.cell, u0 = G.u0, v0 = G.v0;
    return function (u, v) {
      var gx = (u - u0) / cell - 0.5, gy = (v - v0) / cell - 0.5;
      var x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0, sw = 0, sv = 0;
      for (var k = 0; k < 4; k++) {
        var xx = x0 + (k & 1), yy = y0 + (k >> 1);
        if (xx < 0 || yy < 0 || xx >= nu || yy >= nv) continue;
        var b = B[yy * nu + xx];
        if (!(b === b)) continue;
        var w = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy);
        sw += w; sv += w * b;
      }
      return sw > 1e-9 ? sv / sw : NaN;
    };
  }

  // -------------------------------------------------------------------------
  // The triangulation: the ear-clip, refined with points inside, Delaunay
  // -------------------------------------------------------------------------

  function Tri(X, Y) {
    this.X = X; this.Y = Y; this.T = []; this.E = new Map(); this.dead = []; this.flips = 0;
  }
  var KEY = 4194304;   // vertex ids stay below 2^22
  Tri.prototype.orient = function (a, b, c) {
    var X = this.X, Y = this.Y;
    return (X[b] - X[a]) * (Y[c] - Y[a]) - (Y[b] - Y[a]) * (X[c] - X[a]);
  };
  Tri.prototype.incircle = function (a, b, c, d) {
    var X = this.X, Y = this.Y;
    var ax = X[a] - X[d], ay = Y[a] - Y[d], bx = X[b] - X[d], by = Y[b] - Y[d], cx = X[c] - X[d], cy = Y[c] - Y[d];
    return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
  };
  Tri.prototype.add = function (a, b, c) {
    var t = this.dead.length ? this.dead.pop() : this.T.length;
    this.T[t] = [a, b, c];
    this.E.set(a * KEY + b, t); this.E.set(b * KEY + c, t); this.E.set(c * KEY + a, t);
    return t;
  };
  Tri.prototype.kill = function (t) {
    var r = this.T[t];
    for (var k = 0; k < 3; k++) { var key = r[k] * KEY + r[(k + 1) % 3]; if (this.E.get(key) === t) this.E.delete(key); }
    this.T[t] = null; this.dead.push(t);
  };
  /** Flip edge a->b of triangle t = (a, b, p) when the far vertex is inside
      its circumcircle; then the two new outer edges. A root edge has no
      triangle on its other side, so it is never flipped. */
  Tri.prototype.legalize = function (t0, a0, b0) {
    var stack = [[t0, a0, b0]], guard = 0;
    while (stack.length && guard++ < 1e6) {
      var it = stack.pop(), t = it[0], a = it[1], b = it[2], r = this.T[t];
      if (!r) continue;
      var k = r.indexOf(a);
      if (k < 0 || r[(k + 1) % 3] !== b) continue;
      var p = r[(k + 2) % 3], u = this.E.get(b * KEY + a);
      if (u == null) continue;
      var s = this.T[u], q = s[0] === b ? s[2] : s[1] === b ? s[0] : s[1];   // s = (b, a, q) in some rotation
      if (!(this.incircle(a, b, p, q) > 0)) continue;
      if (!(this.orient(a, q, p) > 0 && this.orient(q, b, p) > 0)) continue;
      if (this.E.has(p * KEY + q) || this.E.has(q * KEY + p)) continue;
      this.kill(t); this.kill(u); this.flips++;
      var t1 = this.add(a, q, p), t2 = this.add(q, b, p);
      stack.push([t1, a, q], [t2, q, b]);
    }
  };
  Tri.prototype.locate = function (x, y, start) {
    var X = this.X, Y = this.Y, T = this.T, t = start, guard = 0;
    function side(a, b) { return (X[b] - X[a]) * (y - Y[a]) - (Y[b] - Y[a]) * (x - X[a]); }
    if (t != null && T[t]) {
      while (guard++ < 4096) {
        var r = T[t], moved = false;
        for (var k = 0; k < 3; k++) {
          var a = r[k], b = r[(k + 1) % 3];
          if (side(a, b) < 0) {
            var u = this.E.get(b * KEY + a);
            if (u == null) { moved = null; break; }
            t = u; moved = true; break;
          }
        }
        if (moved === false) return t;
        if (moved === null) break;
      }
    }
    for (var i = 0; i < T.length; i++) {
      var s = T[i];
      if (s && side(s[0], s[1]) >= 0 && side(s[1], s[2]) >= 0 && side(s[2], s[0]) >= 0) return i;
    }
    return -1;
  };
  /** Insert point id into the triangle it is in (strictly inside, and clear
      of its edges by `clear`); false when it is not. */
  Tri.prototype.insert = function (id, start, clear) {
    var t = this.locate(this.X[id], this.Y[id], start);
    if (t < 0) return -1;
    var r = this.T[t], a = r[0], b = r[1], c = r[2];
    var X = this.X, Y = this.Y;
    var e = [[a, b], [b, c], [c, a]];
    for (var k = 0; k < 3; k++) {
      var p = e[k][0], q = e[k][1], len = Math.hypot(X[q] - X[p], Y[q] - Y[p]);
      if (!(this.orient(p, q, id) > clear * len)) return -1;
    }
    this.kill(t);
    var t1 = this.add(a, b, id), t2 = this.add(b, c, id), t3 = this.add(c, a, id);
    this.legalize(t1, a, b); this.legalize(t2, b, c); this.legalize(t3, c, a);
    return this.E.get(a * KEY + b) != null ? this.E.get(a * KEY + b) : t1;
  };
  /** Lawson flips over every inside edge until it is Delaunay. */
  Tri.prototype.delaunay = function () {
    for (var pass = 0; pass < 100; pass++) {
      var f0 = this.flips, T = this.T;
      for (var t = 0; t < T.length; t++) {
        var r = T[t];
        if (r) for (var k = 0; k < 3 && T[t] === r; k++) this.legalize(t, r[k], r[(k + 1) % 3]);
      }
      if (this.flips === f0) break;
    }
  };

  // -------------------------------------------------------------------------
  // The fill
  // -------------------------------------------------------------------------

  function fill(A, I, ear, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var t0 = now();
    var M = A.M, G = A.map.grid, n = G.n, e1 = G.e1, e2 = G.e2;
    var Bs = o.target || A.map.sampler || (A.map.sampler = baseSampler(G, A.map.B));

    // ---- the polygon: the root loops, in the view's frame ----
    var key = new Map(), X = [], Y = [], W = [], P3 = [];
    function vid(x, y, z) {
      var k = x + ',' + y + ',' + z, id = key.get(k);
      if (id == null) {
        id = X.length; key.set(k, id); P3.push([x, y, z]);
        X.push(x * e1[0] + y * e1[1] + z * e1[2]); Y.push(x * e2[0] + y * e2[1] + z * e2[2]); W.push(x * n[0] + y * n[1] + z * n[2]);
      }
      return id;
    }
    var loops = I.loops.map(function (L) { return L.verts.map(function (v) { var p = M.V[v]; return vid(p[0], p[1], p[2]); }); });
    var nLoop = X.length;
    var D = new Tri(X, Y);
    for (var c = 0; c < ear.length; c += 9) {
      var a = vid(ear[c], ear[c + 1], ear[c + 2]), b = vid(ear[c + 3], ear[c + 4], ear[c + 5]), d = vid(ear[c + 6], ear[c + 7], ear[c + 8]);
      if (X.length !== nLoop) return { ok: false, reason: 'the cut engine\'s cap made a corner that is not on the root loop' };
      var or = D.orient(a, b, d);
      if (or < 0) D.add(a, d, b); else D.add(a, b, d);
    }
    var flipped = 0;
    D.T.forEach(function (r) { if (r && D.orient(r[0], r[1], r[2]) <= 0) flipped++; });
    D.delaunay();

    // ---- the lattice inside ----
    var edges = [], lo = [Infinity, Infinity], hi = [-Infinity, -Infinity], lens = [];
    loops.forEach(function (L) {
      for (var i = 0; i < L.length; i++) {
        var p = L[i], q = L[(i + 1) % L.length];
        edges.push([p, q]); lens.push(Math.hypot(X[q] - X[p], Y[q] - Y[p]));
        if (X[p] < lo[0]) lo[0] = X[p]; if (X[p] > hi[0]) hi[0] = X[p];
        if (Y[p] < lo[1]) lo[1] = Y[p]; if (Y[p] > hi[1]) hi[1] = Y[p];
      }
    });
    lens.sort(function (x, y) { return x - y; });
    var area = 0;
    loops.forEach(function (L) { for (var i = 0; i < L.length; i++) { var p = L[i], q = L[(i + 1) % L.length]; area += X[p] * Y[q] - X[q] * Y[p]; } });
    area = Math.abs(area / 2);
    var h = Math.max(o.spacingMinMm, Math.min(o.spacingMaxMm, lens[lens.length >> 1] || o.spacingMinMm));
    h = Math.max(h, Math.sqrt(area / (0.866 * o.maxPoints)));
    // edge buckets for the distance and inside tests
    var bs = Math.max(h, 0.25), bw = Math.ceil((hi[0] - lo[0]) / bs) + 1, bh = Math.ceil((hi[1] - lo[1]) / bs) + 1;
    var buckets = new Map();
    edges.forEach(function (E, i) {
      var p = E[0], q = E[1];
      var i0 = Math.floor((Math.min(X[p], X[q]) - lo[0]) / bs), i1 = Math.floor((Math.max(X[p], X[q]) - lo[0]) / bs);
      var j0 = Math.floor((Math.min(Y[p], Y[q]) - lo[1]) / bs), j1 = Math.floor((Math.max(Y[p], Y[q]) - lo[1]) / bs);
      for (var j = j0; j <= j1; j++) for (var ii = i0; ii <= i1; ii++) { var k = j * bw + ii; (buckets.get(k) || buckets.set(k, []).get(k)).push(i); }
    });
    function inside(x, y) {
      var cnt = false;
      for (var i = 0; i < edges.length; i++) {
        var p = edges[i][0], q = edges[i][1];
        if ((Y[p] > y) !== (Y[q] > y) && x < (X[q] - X[p]) * (y - Y[p]) / (Y[q] - Y[p]) + X[p]) cnt = !cnt;
      }
      return cnt;
    }
    function clearOf(x, y, r) {
      var i0 = Math.floor((x - r - lo[0]) / bs), i1 = Math.floor((x + r - lo[0]) / bs);
      var j0 = Math.floor((y - r - lo[1]) / bs), j1 = Math.floor((y + r - lo[1]) / bs);
      for (var j = j0; j <= j1; j++) {
        for (var ii = i0; ii <= i1; ii++) {
          var L = buckets.get(j * bw + ii);
          if (!L) continue;
          for (var m = 0; m < L.length; m++) {
            var p = edges[L[m]][0], q = edges[L[m]][1];
            var vx = X[q] - X[p], vy = Y[q] - Y[p], l2 = vx * vx + vy * vy;
            var t = l2 > 0 ? Math.max(0, Math.min(1, ((x - X[p]) * vx + (y - Y[p]) * vy) / l2)) : 0;
            var dx = X[p] + t * vx - x, dy = Y[p] + t * vy - y;
            if (dx * dx + dy * dy < r * r) return false;
          }
        }
      }
      return true;
    }
    var rowH = h * Math.sqrt(3) / 2, pts = [];
    for (var jr = 0, y = lo[1] + rowH / 2; y < hi[1]; jr++, y += rowH) {
      for (var x = lo[0] + ((jr & 1) ? h / 2 : 0) + h / 4; x < hi[0]; x += h) {
        if (clearOf(x, y, o.clearFrac * h) && inside(x, y)) pts.push([x, y]);
      }
    }
    var start = 0, added = 0;
    pts.forEach(function (p) {
      var id = X.length;
      X.push(p[0]); Y.push(p[1]); W.push(NaN); P3.push(null);
      var t = D.insert(id, start, 1e-3 * h);
      if (t < 0) { X.pop(); Y.pop(); W.pop(); P3.pop(); return; }
      start = t; added++;
    });

    // ---- heights, solved on the mesh itself ----
    // d = w - B. Held: d at the rim corners and at the far corners of the
    // real triangles round them (the neighbours, as they are). Free: d at
    // the points inside. Minimised: sum over the inside points AND the rim
    // corners of (cotangent Laplacian of d)^2 / area, plus mu * area * d^2
    // inside. A rim corner's Laplacian reaches across the weld into its real
    // neighbours, so keeping it small carries their slope into the fill
    // there, triangle by triangle; mu = 4 / relaxMm^4 lets d die away into
    // the base inside.
    var nF = X.length, nv = M.nv, tv = M.tv, VX = M.VX;
    var loc = new Int32Array(nv).fill(-1), isRim = new Uint8Array(nv), inI = new Uint8Array(M.nt);
    I.tris.forEach(function (t) { inI[t] = 1; });
    I.loops.forEach(function (L) {
      L.verts.forEach(function (v) { var p = M.V[v]; loc[v] = key.get(p[0] + ',' + p[1] + ',' + p[2]); isRim[v] = 1; });
    });
    var outT = [];
    for (var tt = 0; tt < M.nt; tt++) {
      if (inI[tt]) continue;
      var v0 = tv[tt * 3], v1 = tv[tt * 3 + 1], v2 = tv[tt * 3 + 2];
      if (!isRim[v0] && !isRim[v1] && !isRim[v2]) continue;
      var tri = [v0, v1, v2].map(function (v) {
        if (loc[v] < 0) {
          loc[v] = X.length;
          var px = VX[v * 3], py = VX[v * 3 + 1], pz = VX[v * 3 + 2];
          X.push(px * e1[0] + py * e1[1] + pz * e1[2]); Y.push(px * e2[0] + py * e2[1] + pz * e2[2]); W.push(px * n[0] + py * n[1] + pz * n[2]);
          P3.push(null);
        }
        return loc[v];
      });
      outT.push(tri);
    }
    var NV = X.length, Ar = new Float64Array(NV), WT = new Map();
    function addTri(i, j, k) {
      var ar = D.orient(i, j, k);
      if (!(ar > 0)) return;                       // seen edge-on or from behind: no say in the slope
      [[i, j, k], [j, k, i], [k, i, j]].forEach(function (c3) {
        var p = c3[0], q = c3[1], r = c3[2];      // the cotangent at p weighs edge q-r
        var ux = X[q] - X[p], uy = Y[q] - Y[p], vx = X[r] - X[p], vy = Y[r] - Y[p];
        var cot = (ux * vx + uy * vy) / ar, kk = q < r ? q * NV + r : r * NV + q;
        WT.set(kk, (WT.get(kk) || 0) + cot / 2);
      });
      Ar[i] += ar / 6; Ar[j] += ar / 6; Ar[k] += ar / 6;
    }
    D.T.forEach(function (r) { if (r) addTri(r[0], r[1], r[2]); });
    outT.forEach(function (r) { addTri(r[0], r[1], r[2]); });
    var adj = []; for (var i = 0; i < NV; i++) adj.push([]);
    WT.forEach(function (w, kk) { var i2 = Math.floor(kk / NV), j2 = kk - i2 * NV; adj[i2].push(j2, w); adj[j2].push(i2, w); });
    var deg = new Float64Array(NV);
    for (i = 0; i < NV; i++) for (var m = 1; m < adj[i].length; m += 2) deg[i] += adj[i][m];
    // the base at every point; d held at the rim and beyond it
    var Tb = new Float64Array(NV), dv = new Float64Array(NV), bad = 0;
    for (i = 0; i < NV; i++) {
      var bw2 = Bs(X[i], Y[i]);
      if (!(bw2 === bw2)) { if (i >= nLoop && i < nF) bad++; bw2 = W[i] === W[i] ? W[i] : 0; }
      Tb[i] = bw2;
      if (i < nLoop || i >= nF) dv[i] = W[i] - bw2;
    }
    if (bad) return { ok: false, reason: 'the base under it could not be read at ' + bad + ' point(s) of the fill' };
    var mu = 4 / Math.pow(o.relaxMm, 4), Ay = new Float64Array(NV);
    function K(x, z) {                           // z = Lr' diag(1/A) Lr x + mu A x, on the points inside
      for (var i3 = 0; i3 < nF; i3++) {
        var s3 = -deg[i3] * x[i3], ad = adj[i3];
        for (var m3 = 0; m3 < ad.length; m3 += 2) s3 += ad[m3 + 1] * x[ad[m3]];
        Ay[i3] = Ar[i3] > 0 ? s3 / Ar[i3] : 0;
      }
      for (var u3 = nLoop; u3 < nF; u3++) {
        var s4 = -deg[u3] * Ay[u3], ad2 = adj[u3];
        for (var m4 = 0; m4 < ad2.length; m4 += 2) if (ad2[m4] < nF) s4 += ad2[m4 + 1] * Ay[ad2[m4]];
        z[u3] = s4 + mu * Ar[u3] * x[u3];
      }
    }
    var zb = new Float64Array(NV), bvec = new Float64Array(NV), xs = new Float64Array(NV), rr = 0, it = 0;
    var save = mu; mu = 0; K(dv, zb); mu = save;
    for (i = nLoop; i < nF; i++) { bvec[i] = -zb[i]; rr += bvec[i] * bvec[i]; }
    var bb = rr, r = new Float64Array(bvec), pp = new Float64Array(NV), Ap = new Float64Array(NV);
    for (i = nLoop; i < nF; i++) pp[i] = r[i];
    if (bb > 0 && nF > nLoop) {
      for (it = 0; it < o.cgMax; it++) {
        K(pp, Ap);
        var pAp = 0;
        for (i = nLoop; i < nF; i++) pAp += pp[i] * Ap[i];
        if (!(pAp > 0)) break;
        var al = rr / pAp, rr2 = 0;
        for (i = nLoop; i < nF; i++) { xs[i] += al * pp[i]; r[i] -= al * Ap[i]; rr2 += r[i] * r[i]; }
        if (rr2 <= o.cgTol * o.cgTol * bb) { rr = rr2; it++; break; }
        var be = rr2 / rr;
        rr = rr2;
        for (i = nLoop; i < nF; i++) pp[i] = r[i] + be * pp[i];
      }
    }
    var dMax = 0;
    for (var id = nLoop; id < nF; id++) {
      W[id] = Tb[id] + xs[id];
      if (Math.abs(xs[id]) > dMax) dMax = Math.abs(xs[id]);
      P3[id] = [0, 1, 2].map(function (a2) { return X[id] * e1[a2] + Y[id] * e2[a2] + W[id] * n[a2]; });
    }

    // ---- out: triangles facing out (CCW looking down n) ----
    var cap = [], folded = 0, nTri = 0;
    D.T.forEach(function (rw) {
      if (!rw) return;
      nTri++;
      var A3 = P3[rw[0]], B3 = P3[rw[1]], C3 = P3[rw[2]];
      var ux = B3[0] - A3[0], uy = B3[1] - A3[1], uz = B3[2] - A3[2], vx = C3[0] - A3[0], vy = C3[1] - A3[1], vz = C3[2] - A3[2];
      var nn = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
      if (!(nn > 0)) folded++;
      cap.push(A3[0], A3[1], A3[2], B3[0], B3[1], B3[2], C3[0], C3[1], C3[2]);
    });
    if (folded) return { ok: false, reason: 'the fill would fold over itself (' + folded + ' triangle(s) facing in)' };
    return {
      ok: true, cap: cap,
      stats: { points: added, lattice: pts.length, loopVerts: nLoop, ringVerts: NV - nF, tris: nTri, spacingMm: h,
               iters: it, relaxMm: o.relaxMm, maxOffBaseMm: dMax, earFlipped: flipped, ms: now() - t0 }
    };
  }

  var api = { DEFAULTS: DEFAULTS, fill: fill, baseSampler: baseSampler, Tri: Tri };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_LiftCurved = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
