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
     height   w = B + d. B is the base under the island nso_lift_auto.js
              fitted to the exposed surround (opts.target: quadratics fitted
              where the rolling ball touches the surface round the footprint,
              or the ball's own estimate where none fits). d is how far the
              real surface stands off B: held at the rim corners and at the
              far corners of the real triangles round them (the neighbours
              as they are); at the points inside, the d that minimises
                  sum (cotangent Laplacian of d)^2 / area
                    + 4 / relaxMm^4 * sum area * d^2
              over the points inside AND the rim corners. A rim corner's
              Laplacian reaches across the weld into its real neighbours, so
              the first term carries their height AND slope into the fill
              there, triangle by triangle (a C1 join - a harmonic fill would
              match only the height); the second lets d die away into B over
              about relaxMm (1.5 mm, the width of the ring the base was
              measured on). So where the base and the real neighbours
              disagree, the boundary follows the neighbours and the middle
              relaxes to the base. Nothing else: no smoothing, no texture
              made up.

   The plate gains the fill facing out; the lifted piece gains the same fill
   turned over as its back. Plate + piece = the source, exactly.

   API
     fill(A, I, ear, opts) -> { ok, cap, stats, reason }
         A    nso_lift_auto.js's analysis (its M, map.grid, map.B)
         I    the island (its tris, loops, frame = the view's)
         ear  capFor's triangles on the root loops (facing out), flat
              [x, y, z, ...] at the loop vertices
         opts { relaxMm, target: (u, v) => the base along the view }
         cap  the fill, the same layout: triangles facing out
     baseSampler(grid, B) -> (u, v) => B read bilinearly (NaN off the surface)

   LIFT 4 - THE BASE IS A SURFACE REGION (`surface`, below). The base under the
   cursor need not be a planar face: it grows from the triangle under it while
   the surface stays smooth and stops at creases; what stands on it, attached
   only through it, lifts as one piece, cut along the region's curvature with
   the hole filled flush by the fill above. Planar regions are handed to
   Lift 2 / 3 unchanged. See the section's own header.
     surface.analyse(soup, seedTri, opts) -> { ok, engine: 'surface', region, islands, islandOf, ... }
                                             or Lift 2 / 3's analysis with planar: true
     surface.lift / surface.remove(soup, A, ids, deps)    as NSO_LiftAuto's

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
  /** Split the inside edge a-b at the new point `id`: the two triangles on it
      become four. false when the edge has a triangle on one side only. */
  Tri.prototype.split = function (a, b, id) {
    var t = this.E.get(a * KEY + b), u = this.E.get(b * KEY + a);
    if (t == null || u == null) return false;
    var r = this.T[t], s = this.T[u], k = r.indexOf(a), p = r[(k + 2) % 3], j = s.indexOf(b), q = s[(j + 2) % 3];
    this.kill(t); this.kill(u);
    this.add(a, id, p); this.add(id, b, p); this.add(b, id, q); this.add(id, a, q);
    return true;
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

    // ---- a chord between two root vertices that is also an edge inside the island would put four
    // triangles on one edge of the piece (a thin neck: the island's own edge joins them): split it ----
    var inI0 = new Uint8Array(M.nt), chords = new Set(), split = 0;
    I.tris.forEach(function (t) { inI0[t] = 1; });
    I.tris.forEach(function (t) {
      for (var k = 0; k < 3; k++) {
        var u = M.twin(t, k);
        if (u < 0 || !inI0[u]) continue;
        var pa = M.V[M.tv[t * 3 + k]], pb = M.V[M.tv[t * 3 + (k + 1) % 3]];
        var ia = key.get(pa[0] + ',' + pa[1] + ',' + pa[2]), ib = key.get(pb[0] + ',' + pb[1] + ',' + pb[2]);
        if (ia == null || ib == null || ia >= nLoop || ib >= nLoop) continue;
        chords.add(ia < ib ? ia * 4194304 + ib : ib * 4194304 + ia);
      }
    });
    if (chords.size) {
      var hits = [];
      D.T.forEach(function (rw) {
        if (!rw) return;
        for (var k2 = 0; k2 < 3; k2++) {
          var a3 = rw[k2], b3 = rw[(k2 + 1) % 3];
          if (a3 < nLoop && b3 < nLoop && a3 < b3 && chords.has(a3 * 4194304 + b3)) hits.push([a3, b3]);
          else if (a3 < nLoop && b3 < nLoop && b3 < a3 && chords.has(b3 * 4194304 + a3)) hits.push([b3, a3]);
        }
      });
      hits.forEach(function (h) {
        var nid = X.length;
        X.push((X[h[0]] + X[h[1]]) / 2); Y.push((Y[h[0]] + Y[h[1]]) / 2); W.push(NaN); P3.push(null);
        if (D.split(h[0], h[1], nid)) { split++; added++; } else { X.pop(); Y.pop(); W.pop(); P3.pop(); }
      });
    }

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
               iters: it, relaxMm: o.relaxMm, maxOffBaseMm: dMax, earFlipped: flipped, chordsSplit: split, ms: now() - t0 }
    };
  }

  // =========================================================================
  // Lift 4: the base is a surface REGION, not only a planar face
  // =========================================================================
  //
  // The base under the cursor grows from the triangle under it across edges
  // while the surface stays smooth, and stops at creases. Everything above
  // that region and attached only through it is a feature; a feature is cut
  // along the region's own curvature (the smooth local fit Lift 3 fills
  // with) and the hole is filled flush with the surround. A planar region
  // is a face: it is handed to Lift 2 / 3 unchanged (planar:true).
  //
  //   region   from the seed triangle across an edge to its neighbour while
  //            (1) the two normals are within creaseDeg (12 degrees), and
  //            (2) the normal has not turned more than creaseDeg since the
  //            surface ~windowMm (4 mm) back along the way in. (2) is what
  //            stops a fillet, whose edges are each gentle: a surface
  //            smooth enough to be a base bends with a radius of at least
  //            windowMm / creaseDeg (19 mm); a tighter curve is a crease.
  //            The normals are the mesh's own with the noise taken out and
  //            the creases left in (smoothNormals: a bilateral filter), so a
  //            sculpt's roughness is not a crease and a crease still is.
  //   feature  a connected set of triangles outside the region that touches
  //            it. It is a detail on this surface when it stands on it (its
  //            root edges lead out of the surface, not into it), has less
  //            surface than the region it stands on (more: it is the body),
  //            and its root can be filled in one go (the surround leans no
  //            more than slantDeg from its mean direction: a feature that
  //            wraps right round the surface cannot).
  //   base     under each root: the surface round it (the region within
  //            ringMm of the root loops) fitted with local quadratics in
  //            the roots' own frame (the fit Lift 3 uses); a patch of the
  //            feature that already lies on that base (a ring's bore floor)
  //            is base, not feature, and stays on the plate.
  //   lift     the feature + a fill on each group of root loops (nso_lift_
  //            curved.fill, welded to the real neighbours at the rim) is its
  //            own closed piece; the plate keeps every other triangle in
  //            order and gains the same fill facing out.
  //   assembly lift-assembly's rule (nso_lift_auto.assemble): a free shell a
  //            feature holds comes along.

  var SURF = {
    smoothRings: 3,      // the crease rule reads normals filtered this many passes (sculpt noise is not a crease; a crease stays one)
    creaseDeg: 12,       // an edge bending more than this is a crease...
    windowMm: 4,         // ...and so is a place where the normal has turned this much over this much surface
    planarTolMm: 0.05,   // a region whose corners all lie this near one plane is a face
    ringMm: 3.5,         // the surface measured round each root: this far (along the surface)
    sigmaMm: 3,          // the base carried across: local quadratics weighted over about this
    joinMm: 3.5,         // root loops this close (box to box) are one cut
    flushMm: 0.06,       // a patch of a feature this near the base under it is base
    minTris: 6,          // fewer triangles than this is a speck, not a feature
    speckMm: 0.15,       // standing out less than this is not a feature (mesh noise, a layer's worth of dent)
    aboveShare: 0.5,     // this share of the root edges (by length) must lead out of the surface...
    levelTol: 0.1,       // ...or run level with it (up to this slope: the smoothed crease leaves a flat collar)
    bodyFrac: 1,         // a feature with more surface than the region it stands on is the body
    slantDeg: 60,        // a root whose surround leans more than this from its mean direction (90th percentile) cannot be filled in one go
    flushMinTris: 20,    // a patch of a feature is base only if it is a patch: at least this many triangles...
    flushMinMm2: 1,      // ...and this much surface
    relaxMm: 1.5,
    captureMm: 2
  };

  var SWHY = {
    open: 'it runs into an open edge of the mesh',
    bigger: 'it has more surface than the region it stands on - it is the body, not a detail on it',
    wrap: 'where it meets the surface it wraps round further than one fill can follow (its root turns more than 35 degrees from its mean direction)',
    below: 'it is cut into this surface rather than standing on it',
    surfaceloops: 'where it meets the surface does not close into clean loops',
    nosurface: 'there is too little surface round it to measure what it stands on'
  };

  function LAu() {
    if (root && root.NSO_LiftAuto) return root.NSO_LiftAuto;
    if (typeof require === 'function') { try { return require('./nso_lift_auto.js'); } catch (e) { /* browser */ } }
    return null;
  }
  function L1() {
    if (root && root.NSO_Lift) return root.NSO_Lift;
    if (typeof require === 'function') { try { return require('./nso_lift.js'); } catch (e) { /* browser */ } }
    return null;
  }
  function dep(deps, name) {
    return (deps && deps[name]) || (root && root[name]) ||
           (typeof globalThis !== 'undefined' ? globalThis[name] : null) || null;
  }
  function fmt(x, d) { return (+x).toFixed(d == null ? 2 : d); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function norm3(a) { var l = Math.hypot(a[0], a[1], a[2]); return l ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1]; }

  /** Face normals with the noise taken out and the creases left in: `rings`
      passes of a bilateral filter - each triangle's normal becomes the area
      weighted mean of its own and its three edge neighbours', a neighbour
      weighing exp(-(1 - cos) / 0.12) of the angle between the two (a 12 degree
      neighbour 0.83, 25 degrees 0.46, 45 degrees 0.09, a right angle 0.0002),
      so what bends a little is averaged and what bends a lot is not.
      Unit; the raw ones for 0. Cached on the index. */
  function smoothNormals(M, rings) {
    if (!(rings > 0)) return M.n;
    var key = 'sn' + rings;
    if (M[key]) return M[key];
    var nt = M.nt, cur = new Float64Array(M.n), nxt = new Float64Array(nt * 3), r, t, k;
    for (r = 0; r < rings; r++) {
      for (t = 0; t < nt; t++) {
        var ax = cur[t * 3], ay = cur[t * 3 + 1], az = cur[t * 3 + 2];
        if (ax === 0 && ay === 0 && az === 0) continue;
        var sx = ax * M.area[t], sy = ay * M.area[t], sz = az * M.area[t];
        for (k = 0; k < 3; k++) {
          var u = M.twin(t, k);
          if (u < 0) continue;
          var bx = cur[u * 3], by = cur[u * 3 + 1], bz = cur[u * 3 + 2];
          var w = Math.exp(-(1 - (ax * bx + ay * by + az * bz)) / 0.12) * M.area[u];
          sx += w * bx; sy += w * by; sz += w * bz;
        }
        var l = Math.hypot(sx, sy, sz);
        if (l > 0) { nxt[t * 3] = sx / l; nxt[t * 3 + 1] = sy / l; nxt[t * 3 + 2] = sz / l; }
        else { nxt[t * 3] = ax; nxt[t * 3 + 1] = ay; nxt[t * 3 + 2] = az; }
      }
      var tmp = cur; cur = nxt; nxt = tmp;
    }
    M[key] = cur;
    return cur;
  }

  /** The region round `seed`: see the header. -> { inR, tris, area, lo, hi, diag } */
  function growRegion(M, seed, o) {
    var nt = M.nt, tv = M.tv, VX = M.VX, N = smoothNormals(M, o.smoothRings);
    var cosE = Math.cos(o.creaseDeg * Math.PI / 180), win = o.windowMm;
    var inR = new Uint8Array(nt), par = new Int32Array(nt).fill(-1), PL = new Float32Array(nt), q = new Int32Array(nt), qn = 0;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], area = 0;
    function cen(t, a) { return (VX[tv[t * 3] * 3 + a] + VX[tv[t * 3 + 1] * 3 + a] + VX[tv[t * 3 + 2] * 3 + a]) / 3; }
    function dn(a, b) { return N[a * 3] * N[b * 3] + N[a * 3 + 1] * N[b * 3 + 1] + N[a * 3 + 2] * N[b * 3 + 2]; }
    inR[seed] = 1; q[qn++] = seed;
    for (var i = 0; i < qn; i++) {
      var t = q[i];
      for (var k = 0; k < 3; k++) {
        var u = M.twin(t, k);
        if (u < 0 || inR[u] || !(M.area[u] > 1e-12)) continue;
        if (dn(t, u) < cosE) continue;
        var step = Math.hypot(cen(u, 0) - cen(t, 0), cen(u, 1) - cen(t, 1), cen(u, 2) - cen(t, 2));
        var Lu = PL[t] + step, a = t;
        while (par[a] >= 0 && Lu - PL[a] < win) a = par[a];
        if (Lu - PL[a] >= win / 2 && dn(a, u) < cosE) continue;
        inR[u] = 1; par[u] = t; PL[u] = Lu; q[qn++] = u;
      }
    }
    var tris = new Array(qn);
    for (i = 0; i < qn; i++) {
      t = q[i]; tris[i] = t; area += M.area[t];
      for (var c = 0; c < 3; c++) { var x = cen(t, c); if (x < lo[c]) lo[c] = x; if (x > hi[c]) hi[c] = x; }
    }
    return { inR: inR, tris: tris, area: area, lo: lo, hi: hi, diag: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) };
  }

  /** { n, d } when every corner of `tris` lies within tol of the seed's plane. */
  function planarOf(M, tris, seed, tol) {
    var n = [M.n[seed * 3], M.n[seed * 3 + 1], M.n[seed * 3 + 2]], p0 = M.V[M.tv[seed * 3]], d = dot3(p0, n);
    for (var i = 0; i < tris.length; i++) {
      var t = tris[i];
      for (var k = 0; k < 3; k++) {
        var o3 = M.tv[t * 3 + k] * 3;
        if (Math.abs(M.VX[o3] * n[0] + M.VX[o3 + 1] * n[1] + M.VX[o3 + 2] * n[2] - d) > tol) return null;
      }
    }
    return { n: n, d: d };
  }

  /** A small dense system by Gauss-Jordan with partial pivots (Lift 2's). */
  function solveN(A, b, eps) {
    var n = b.length, m = A.map(function (r, i) { return r.concat([b[i]]); });
    for (var c = 0; c < n; c++) {
      var p = c;
      for (var r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
      if (!(Math.abs(m[p][c]) > eps)) return null;
      var tmp = m[c]; m[c] = m[p]; m[p] = tmp;
      for (r = 0; r < n; r++) {
        if (r === c) continue;
        var f = m[r][c] / m[c][c];
        for (var k = c; k <= n; k++) m[r][k] -= f * m[c][k];
      }
    }
    return m.map(function (row, i) { return row[n] / row[i]; });
  }

  /** The base carried across: quadratics h = a u^2 + b uv + c v^2 + d u + e v + f
      fitted by least squares at each node of a lattice sigma / 2 apart, a sample
      weighted exp(-r^2 / 2 sigma^2) from its node; read anywhere as the nodes'
      quadratics blended bilinearly (Lift 3's fitLocal, on samples). */
  function fitSurface(SU, SV, SH, sg) {
    var Nn = SU.length;
    if (Nn < 15) return null;
    var step = sg / 2, cut2 = 9 * sg * sg, inv2 = 1 / (2 * sg * sg);
    var ulo = Infinity, uhi = -Infinity, vlo = Infinity, vhi = -Infinity, q;
    for (q = 0; q < Nn; q++) {
      if (SU[q] < ulo) ulo = SU[q]; if (SU[q] > uhi) uhi = SU[q];
      if (SV[q] < vlo) vlo = SV[q]; if (SV[q] > vhi) vhi = SV[q];
    }
    var gw, gh;
    for (;;) {
      gw = Math.max(2, Math.ceil((uhi - ulo) / step) + 1); gh = Math.max(2, Math.ceil((vhi - vlo) / step) + 1);
      if (gw * gh <= 30000) break;
      step *= 1.5;
    }
    // samples in buckets sg wide: a node reads the 7 x 7 round it
    var bw = Math.max(1, Math.ceil((uhi - ulo) / sg) + 1), bh = Math.max(1, Math.ceil((vhi - vlo) / sg) + 1), bk = new Array(bw * bh);
    for (q = 0; q < Nn; q++) {
      var bi = Math.floor((SU[q] - ulo) / sg) + Math.floor(((SV[q] - vlo) / sg)) * bw;
      (bk[bi] || (bk[bi] = [])).push(q);
    }
    var C = new Array(gw * gh), bad = 0;
    for (var gj = 0; gj < gh; gj++) {
      for (var gi = 0; gi < gw; gi++) {
        var nu0 = ulo + gi * step, nv0 = vlo + gj * step, A6 = [], b6 = [0, 0, 0, 0, 0, 0], k6, sw = 0;
        for (k6 = 0; k6 < 6; k6++) A6.push([0, 0, 0, 0, 0, 0]);
        var bx = Math.floor((nu0 - ulo) / sg), by = Math.floor((nv0 - vlo) / sg);
        for (var yy = by - 3; yy <= by + 3; yy++) {
          if (yy < 0 || yy >= bh) continue;
          for (var xx = bx - 3; xx <= bx + 3; xx++) {
            if (xx < 0 || xx >= bw) continue;
            var L = bk[yy * bw + xx];
            if (!L) continue;
            for (var m = 0; m < L.length; m++) {
              q = L[m];
              var x = (SU[q] - nu0) / sg, y = (SV[q] - nv0) / sg, r2 = (x * x + y * y) * sg * sg;
              if (r2 > cut2) continue;
              var w = Math.exp(-r2 * inv2), f = [x * x, x * y, y * y, x, y, 1];
              sw += w;
              for (var a = 0; a < 6; a++) { var wf = w * f[a]; b6[a] += wf * SH[q]; for (var b2 = 0; b2 <= a; b2++) A6[a][b2] += wf * f[b2]; }
            }
          }
        }
        for (var a2 = 0; a2 < 6; a2++) for (var b3 = a2 + 1; b3 < 6; b3++) A6[a2][b3] = A6[b3][a2];
        var c6 = sw > 0 ? solveN(A6, b6, 1e-7 * sw) : null;
        if (!c6) { bad++; C[gj * gw + gi] = null; continue; }
        C[gj * gw + gi] = [c6[0] / (sg * sg), c6[1] / (sg * sg), c6[2] / (sg * sg), c6[3] / sg, c6[4] / sg, c6[5], nu0, nv0];
      }
    }
    if (bad === C.length) return null;
    var N4x = [1, -1, 0, 0], N4y = [0, 0, 1, -1];
    for (var pass = 0; bad && pass < gw + gh; pass++) {            // a node nothing holds borrows a neighbour's
      var C2 = C.slice();
      for (gj = 0; gj < gh; gj++) for (gi = 0; gi < gw; gi++) {
        if (C[gj * gw + gi]) continue;
        for (var kk = 0; kk < 4; kk++) {
          var ii = gi + N4x[kk], jj = gj + N4y[kk];
          if (ii < 0 || jj < 0 || ii >= gw || jj >= gh || !C[jj * gw + ii]) continue;
          C2[gj * gw + gi] = C[jj * gw + ii]; bad--; break;
        }
      }
      C = C2;
    }
    function T(U, V) {
      var fx = (U - ulo) / step, fy = (V - vlo) / step;
      var x0 = Math.max(0, Math.min(gw - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(gh - 2, Math.floor(fy)));
      var tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0)), sum = 0;
      for (var k2 = 0; k2 < 4; k2++) {
        var c = C[(y0 + (k2 >> 1)) * gw + x0 + (k2 & 1)];
        if (!c) return NaN;
        var du = U - c[6], dv = V - c[7];
        var wt = ((k2 & 1) ? tx : 1 - tx) * ((k2 >> 1) ? ty : 1 - ty);
        sum += wt * (c[0] * du * du + c[1] * du * dv + c[2] * dv * dv + c[3] * du + c[4] * dv + c[5]);
      }
      return sum;
    }
    var mx = 0, ss = 0;
    for (q = 0; q < Nn; q++) { var rr = SH[q] - T(SU[q], SV[q]); ss += rr * rr; if (Math.abs(rr) > mx) mx = Math.abs(rr); }
    return { T: T, rms: Math.sqrt(ss / Nn), max: mx, box: { ulo: ulo - step, uhi: uhi + step, vlo: vlo - step, vhi: vhi + step } };
  }

  /** The surface round a group of root loops: the triangles outside the
      feature reached from the root edges across gentle edges within ringMm
      (along the surface), their corners as (u, v, w) in the group's frame. */
  function ringSamples(M, inC, edges, fr, o) {
    var tv = M.tv, VX = M.VX, N = M.n, cosE = Math.cos(o.creaseDeg * Math.PI / 180);
    var seen = new Map(), queue = [];
    edges.forEach(function (e) {
      var u = M.twin(e.t, e.k);
      if (u >= 0 && !inC(u) && !seen.has(u)) { seen.set(u, 0); queue.push(u); }
    });
    function cen(t, a) { return (VX[tv[t * 3] * 3 + a] + VX[tv[t * 3 + 1] * 3 + a] + VX[tv[t * 3 + 2] * 3 + a]) / 3; }
    for (var i = 0; i < queue.length; i++) {
      var t = queue[i], L = seen.get(t);
      for (var k = 0; k < 3; k++) {
        var u = M.twin(t, k);
        if (u < 0 || inC(u) || seen.has(u) || !(M.area[u] > 1e-12)) continue;
        if (N[t * 3] * N[u * 3] + N[t * 3 + 1] * N[u * 3 + 1] + N[t * 3 + 2] * N[u * 3 + 2] < cosE) continue;
        var Lu = L + Math.hypot(cen(u, 0) - cen(t, 0), cen(u, 1) - cen(t, 1), cen(u, 2) - cen(t, 2));
        if (Lu > o.ringMm) continue;
        seen.set(u, Lu); queue.push(u);
      }
    }
    var vs = new Set();
    queue.forEach(function (t2) { for (var c = 0; c < 3; c++) vs.add(tv[t2 * 3 + c]); });
    var SU = [], SV = [], SH = [];
    vs.forEach(function (v) {
      var x = VX[v * 3], y = VX[v * 3 + 1], z = VX[v * 3 + 2];
      SU.push(x * fr.e1[0] + y * fr.e1[1] + z * fr.e1[2]);
      SV.push(x * fr.e2[0] + y * fr.e2[1] + z * fr.e2[2]);
      SH.push(x * fr.n[0] + y * fr.n[1] + z * fr.n[2]);
    });
    return { SU: SU, SV: SV, SH: SH, tris: queue.length };
  }

  function loopBox(M, L) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    L.verts.forEach(function (v) { var p = M.V[v]; for (var a = 0; a < 3; a++) { if (p[a] < lo[a]) lo[a] = p[a]; if (p[a] > hi[a]) hi[a] = p[a]; } });
    return { lo: lo, hi: hi };
  }
  /** The outside neighbours' mean normal across the loop edges, area-weighted:
      the way the surface faces where the feature stands. */
  function outNormal(M, edges) {
    var s = [0, 0, 0];
    edges.forEach(function (e) {
      var u = M.twin(e.t, e.k);
      if (u < 0) return;
      var a = M.area[u];
      s[0] += a * M.n[u * 3]; s[1] += a * M.n[u * 3 + 1]; s[2] += a * M.n[u * 3 + 2];
    });
    return norm3(s);
  }

  /**
   * One feature: the triangles `tris`, a connected set outside the region.
   * -> an array of islands (one, or several when a flush patch splits it, or
   * none when it is a speck / all base).
   */
  function readFeature(ctx, tris, pass2) {
    var M = ctx.M, o = ctx.o, tv = M.tv, VX = M.VX, P1 = ctx.P1;
    var gen = ++ctx.gen, stamp = ctx.stamp;
    tris.forEach(function (t) { stamp[t] = gen; });
    function inC(u) { return stamp[u] === gen; }
    var open = false, bedges = [], area = 0, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    tris.forEach(function (t) {
      area += M.area[t];
      for (var k = 0; k < 3; k++) {
        var o3 = tv[t * 3 + k] * 3;
        for (var c = 0; c < 3; c++) { var x = VX[o3 + c]; if (x < lo[c]) lo[c] = x; if (x > hi[c]) hi[c] = x; }
        var u = M.twin(t, k);
        if (u < 0) { open = true; continue; }
        if (inC(u)) continue;
        bedges.push({ t: t, k: k, u: u });
      }
    });
    function mk(status, extra) {
      return Object.assign({ status: status, reason: SWHY[status] || '', tris: tris, areaMm2: area, bounds: { lo: lo, hi: hi }, group: 'large',
        heightMm: 0, groups: [], loops: [], necks: null }, extra || {});
    }
    if (!bedges.length) return [];                                      // joined to nothing here: another shell
    if (tris.length < o.minTris) return [];
    // how far it stands out, cheaply: against the plane through its root
    var cx = 0, cy = 0, cz = 0;
    bedges.forEach(function (e) {
      var o3 = tv[e.t * 3 + e.k] * 3;
      cx += VX[o3]; cy += VX[o3 + 1]; cz += VX[o3 + 2];
    });
    var nAvg = outNormal(M, bedges), proxy = 0;
    cx /= bedges.length; cy /= bedges.length; cz /= bedges.length;
    if (tris.length <= 400) {
      tris.forEach(function (t) {
        for (var k = 0; k < 3; k++) {
          var o3 = tv[t * 3 + k] * 3, h = (VX[o3] - cx) * nAvg[0] + (VX[o3 + 1] - cy) * nAvg[1] + (VX[o3 + 2] - cz) * nAvg[2];
          if (h > proxy) proxy = h;
        }
      });
      if (proxy < o.speckMm) return [];
    }
    if (open) return [mk('open')];
    // bigger than the surface it stands on: it is the body
    if (area > o.bodyFrac * ctx.R.area) return [mk('bigger')];
    var loops = P1.internals.boundaryLoops(M, tris, inC, P1.internals.planeFrame(nAvg));
    if (!loops.length || loops.some(function (L) { return L.broken; })) return [mk('surfaceloops')];

    // loops -> groups (loops that are near each other are one cut), each with the surface round it
    var boxes = loops.map(function (L) { return loopBox(M, L); }), parent = loops.map(function (_, i) { return i; });
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    for (var i = 0; i < loops.length; i++) for (var j = i + 1; j < loops.length; j++) {
      var ov = true;
      for (var a = 0; a < 3; a++) if (boxes[i].lo[a] - o.joinMm > boxes[j].hi[a] || boxes[j].lo[a] - o.joinMm > boxes[i].hi[a]) ov = false;
      if (ov) parent[find(i)] = find(j);
    }
    var byRoot = new Map();
    loops.forEach(function (L, i2) { var r = find(i2); (byRoot.get(r) || byRoot.set(r, []).get(r)).push(i2); });
    var groups = [], cosS = Math.cos(o.slantDeg * Math.PI / 180), wrapDeg = 0, SN = smoothNormals(M, o.smoothRings);
    byRoot.forEach(function (idx) {
      var Ls = idx.map(function (i2) { return loops[i2]; }), edges = [], glo = [Infinity, Infinity, Infinity], ghi = [-Infinity, -Infinity, -Infinity];
      Ls.forEach(function (L, q) {
        L.edges.forEach(function (e) { edges.push({ t: e.t, k: e.k }); });
        var bx = boxes[idx[q]];
        for (var a2 = 0; a2 < 3; a2++) { if (bx.lo[a2] < glo[a2]) glo[a2] = bx.lo[a2]; if (bx.hi[a2] > ghi[a2]) ghi[a2] = bx.hi[a2]; }
      });
      var n = outNormal(M, edges), fr = P1.internals.planeFrame(n);
      var cs = [];                                    // how far the surface leans from the group's mean direction along its root (the 90th percentile: one rough triangle is not a wrap)
      edges.forEach(function (e) {
        var u = M.twin(e.t, e.k);
        if (u >= 0) cs.push(SN[u * 3] * n[0] + SN[u * 3 + 1] * n[1] + SN[u * 3 + 2] * n[2]);
      });
      cs.sort(function (x, y) { return y - x; });
      var c90 = cs.length ? cs[Math.min(cs.length - 1, Math.floor(cs.length * 0.9))] : 1;
      if (c90 < cosS) wrapDeg = Math.max(wrapDeg, Math.acos(Math.max(-1, c90)) * 180 / Math.PI);
      if (wrapDeg) return;
      var smp = ringSamples(M, inC, edges, fr, o), fit = fitSurface(smp.SU, smp.SV, smp.SH, o.sigmaMm);
      groups.push({ loops: Ls, edges: edges, frame: fr, n: n, fit: fit, samples: smp.SU.length, surroundTris: smp.tris,
        centre: [(glo[0] + ghi[0]) / 2, (glo[1] + ghi[1]) / 2, (glo[2] + ghi[2]) / 2] });
    });
    if (wrapDeg) return [mk('wrap', { reason: SWHY.wrap.replace('35', String(o.slantDeg)) + ' - it turns ' + Math.round(wrapDeg) + '\u00b0' })];
    if (groups.some(function (g) { return !g.fit; })) return [mk('nosurface')];

    // height above the base of a vertex, from the group it is nearest (NaN: off every fit)
    function heightOf(g, v) {
      var x = VX[v * 3], y = VX[v * 3 + 1], z = VX[v * 3 + 2], fr = g.frame, b = g.fit.box;
      var u = x * fr.e1[0] + y * fr.e1[1] + z * fr.e1[2], vv = x * fr.e2[0] + y * fr.e2[1] + z * fr.e2[2];
      if (u < b.ulo || u > b.uhi || vv < b.vlo || vv > b.vhi) return NaN;
      var T = g.fit.T(u, vv);
      return T === T ? x * fr.n[0] + y * fr.n[1] + z * fr.n[2] - T : NaN;
    }
    function nearGroup(v) {
      var best = null, bd = Infinity;
      for (var gi = 0; gi < groups.length; gi++) {
        var g = groups[gi], h = heightOf(g, v);
        if (!(h === h)) continue;
        var dx = VX[v * 3] - g.centre[0], dy = VX[v * 3 + 1] - g.centre[1], dz = VX[v * 3 + 2] - g.centre[2], d = dx * dx + dy * dy + dz * dz;
        if (d < bd) { bd = d; best = { g: g, h: h }; }
      }
      return best;
    }
    if (!pass2) {
      var rms = 0;
      groups.forEach(function (g) { rms = Math.max(rms, g.fit.rms); });
      var flush = Math.min(0.15, Math.max(o.flushMm, 3 * rms)), cosE = Math.cos(o.creaseDeg * Math.PI / 180);
      // smooth patches of the feature; a patch whose every corner lies on the base is base
      var patchOf = new Map(), patches = [];
      tris.forEach(function (t0) {
        if (patchOf.has(t0)) return;
        var P = [t0], id = patches.length;
        patchOf.set(t0, id);
        for (var pi = 0; pi < P.length; pi++) {
          var t = P[pi];
          for (var k = 0; k < 3; k++) {
            var u = M.twin(t, k);
            if (u < 0 || !inC(u) || patchOf.has(u) || !(M.area[u] > 1e-12)) continue;
            if (M.n[t * 3] * M.n[u * 3] + M.n[t * 3 + 1] * M.n[u * 3 + 1] + M.n[t * 3 + 2] * M.n[u * 3 + 2] < cosE) continue;
            patchOf.set(u, id); P.push(u);
          }
        }
        patches.push(P);
      });
      var drop = new Set();
      patches.forEach(function (P, id) {
        var ok = P.length >= o.flushMinTris, pa = 0;
        P.forEach(function (t) { pa += M.area[t]; });
        if (pa < o.flushMinMm2) ok = false;
        for (var pi = 0; pi < P.length && ok; pi++) {
          for (var k = 0; k < 3; k++) {
            var ng = nearGroup(tv[P[pi] * 3 + k]);
            if (!ng || Math.abs(ng.h) > flush) { ok = false; break; }
          }
        }
        if (ok) drop.add(id);
      });
      // then the edge of what is left, peeled: a triangle at the edge whose corners all lie on the base is the
      // surface itself (the smoothed crease stops the region a triangle or two short), and left in the piece it
      // would lie on the fill as a membrane of no thickness
      var live = new Set(tris.filter(function (t) { return !drop.has(patchOf.get(t)); })), peeled = 0, front = [];
      function edgeOf(t) {
        for (var k = 0; k < 3; k++) { var u = M.twin(t, k); if (u >= 0 && !live.has(u)) return true; }
        return false;
      }
      function onBase(t) {
        for (var k = 0; k < 3; k++) {
          var ng = nearGroup(tv[t * 3 + k]);
          if (!ng || Math.abs(ng.h) > flush) return false;
        }
        return true;
      }
      live.forEach(function (t) { if (edgeOf(t)) front.push(t); });
      for (var fi = 0; fi < front.length; fi++) {
        var ft = front[fi];
        if (!live.has(ft) || !onBase(ft)) continue;
        live.delete(ft); peeled++;
        for (var fk = 0; fk < 3; fk++) { var fu = M.twin(ft, fk); if (fu >= 0 && live.has(fu)) front.push(fu); }
      }
      if (drop.size || peeled) {
        var keep = tris.filter(function (t) { return live.has(t); });
        if (!keep.length) return [];
        // what is left may be several features now; each is read again with its own roots
        var out = [];
        componentsOf(M, keep).forEach(function (c) { readFeature(ctx, c, true).forEach(function (I) { out.push(I); }); });
        return out;
      }
    }

    // does it stand on the surface, or sink into it?
    var blen = 0, above = 0;
    bedges.forEach(function (e) {
      var a = tv[e.t * 3 + e.k], b = tv[e.t * 3 + (e.k + 1) % 3], c = tv[e.t * 3 + (e.k + 2) % 3];
      var len = Math.hypot(VX[b * 3] - VX[a * 3], VX[b * 3 + 1] - VX[a * 3 + 1], VX[b * 3 + 2] - VX[a * 3 + 2]);
      var mx = (VX[a * 3] + VX[b * 3]) / 2, my = (VX[a * 3 + 1] + VX[b * 3 + 1]) / 2, mz = (VX[a * 3 + 2] + VX[b * 3 + 2]) / 2;
      var side = (VX[c * 3] - mx) * M.n[e.u * 3] + (VX[c * 3 + 1] - my) * M.n[e.u * 3 + 1] + (VX[c * 3 + 2] - mz) * M.n[e.u * 3 + 2];
      blen += len;
      if (side >= -o.levelTol * len) above += len;
    });
    if (blen > 0 && above / blen < o.aboveShare) return [mk('below')];

    // standing out: the furthest any corner is above the base
    var hmax = 0, measured = 0, seenV = new Set();
    tris.forEach(function (t) {
      for (var k = 0; k < 3; k++) {
        var v = tv[t * 3 + k];
        if (seenV.has(v)) continue;
        seenV.add(v);
        var ng = nearGroup(v);
        if (!ng) continue;
        measured++;
        if (ng.h > hmax) hmax = ng.h;
      }
    });
    if (!measured) hmax = proxy;
    if (hmax < o.speckMm) return [];
    var rmsAll = 0;
    groups.forEach(function (g) { rmsAll = Math.max(rmsAll, g.fit.rms); });
    var notes = [];
    if (rmsAll > 0.02) {
      notes.push('the surface round it is rough (' + fmt(rmsAll, 3) + ' mm rms about the smooth surface fitted to it): the fill meets it at the rim and ' +
        'runs smooth across - the roughness is not made up under it');
    }
    return [mk('ok', { heightMm: hmax, loops: loops, groups: groups, fitRmsMm: rmsAll, notes: notes, reason: '' })];
  }

  /** Connected sets of `tris` (edge to edge, inside the set). */
  function componentsOf(M, tris) {
    var inS = new Set(tris), seen = new Set(), out = [];
    tris.forEach(function (t0) {
      if (seen.has(t0)) return;
      var q = [t0];
      seen.add(t0);
      for (var i = 0; i < q.length; i++) {
        for (var k = 0; k < 3; k++) {
          var u = M.twin(q[i], k);
          if (u < 0 || !inS.has(u) || seen.has(u)) continue;
          seen.add(u); q.push(u);
        }
      }
      out.push(q);
    });
    return out;
  }

  function surfaceAnalyse(soup, seedTri, opts) {
    var o = Object.assign({}, SURF, opts || {}), t0 = now(), A1 = LAu(), P1 = L1();
    if (!A1 || !P1) return { ok: false, refused: 'deps', reason: 'Lift needs nso_lift.js and nso_lift_auto.js' };
    if (!soup || soup.length < 36) return { ok: false, refused: 'empty', reason: 'there is no mesh to lift from' };
    var ms = {};
    var M = o.M || A1.index(soup);
    ms.index = now() - t0;
    var seed = seedTri | 0;
    if (!(seed >= 0 && seed < M.nt)) return { ok: false, refused: 'seed', reason: 'that click is not on a triangle of this piece' };
    if (!(M.area[seed] > 1e-9)) return { ok: false, refused: 'seed', reason: 'the clicked triangle has no area - click the surface itself' };
    var t1 = now();
    var R = growRegion(M, seed, o);
    ms.region = now() - t1;
    var tol = o.planarTolMm;
    var pl = o.planar === false ? null : planarOf(M, R.tris, seed, tol);
    if (pl) {
      // a planar region is a face: Lift 2 / 3's own read, unchanged
      var big = R.tris.slice().sort(function (a, b) { return M.area[b] - M.area[a]; }).slice(0, 3);
      var A = null;
      for (var i = 0; i < big.length && !(A && A.ok && A.islands.length); i++) {
        var r = A1.analyse(soup, big[i], { M: M, normal: pl.n, curved: true });
        if (r.ok && (!A || !A.ok)) A = r;
        else if (r.ok && r.islands.length) A = r;
        else if (!A) A = r;
      }
      if (A) A.planar = true;
      return A || { ok: false, refused: 'face', reason: 'that face could not be read' };
    }

    // ---- the features: what is outside the region and touches it ----
    var t2 = now(), nt = M.nt, inR = R.inR;
    var ctx = { M: M, o: o, P1: P1, R: R, gen: 0, stamp: new Int32Array(nt) };
    var compOf = new Int32Array(nt).fill(-1), comps = [];
    for (var t = 0; t < nt; t++) {
      if (inR[t] || compOf[t] >= 0) continue;
      var q = [t], id = comps.length;
      compOf[t] = id;
      for (var qi = 0; qi < q.length; qi++) {
        for (var k = 0; k < 3; k++) {
          var u = M.twin(q[qi], k);
          if (u < 0 || inR[u] || compOf[u] >= 0) continue;
          compOf[u] = id; q.push(u);
        }
      }
      comps.push(q);
    }
    ms.components = now() - t2;
    var t3 = now(), islands = [];
    comps.forEach(function (c) { readFeature(ctx, c, false).forEach(function (I) { islands.push(I); }); });
    ms.features = now() - t3;
    islands.sort(function (a, b) { return b.areaMm2 - a.areaMm2; });
    islands.forEach(function (I, i2) { I.id = i2; });
    var islandOf = new Int32Array(nt).fill(-1);
    islands.forEach(function (I) { I.tris.forEach(function (t4) { islandOf[t4] = I.id; }); });
    var t4 = now();
    var asm = A1.assemble(M, seed, islands, islandOf, { captureMm: o.captureMm });
    islands = asm.islands;
    ms.assemble = now() - t4;
    return {
      ok: true, engine: 'surface', kind: 'surface', M: M, seed: seed, region: R, islands: islands, islandOf: islandOf,
      map: { thresholdMm: o.speckMm, words: 'the surface under the cursor, grown from the triangle under it while it stays smooth' },
      relaxMm: o.relaxMm, opts: o, shells: asm.shells, caught: asm.caught,
      componentCount: comps.length, ms: Object.assign(ms, { total: now() - t0 })
    };
  }

  // -------------------------------------------------------------------------
  // Lift / Remove
  // -------------------------------------------------------------------------

  function pieceOf(soup, I, caps) {
    var n = I.tris.length * 9;
    caps.forEach(function (cp) { n += cp.length; });
    var ps = new Float32Array(n), o = 0;
    I.tris.forEach(function (t) { for (var q = 0; q < 9; q++) ps[o++] = soup[t * 9 + q]; });
    caps.forEach(function (cp) {
      for (var c = 0; c < cp.length; c += 9) {
        ps[o++] = cp[c]; ps[o++] = cp[c + 1]; ps[o++] = cp[c + 2];
        ps[o++] = cp[c + 6]; ps[o++] = cp[c + 7]; ps[o++] = cp[c + 8];
        ps[o++] = cp[c + 3]; ps[o++] = cp[c + 4]; ps[o++] = cp[c + 5];
      }
    });
    return ps;
  }

  function surfaceCut(soup, A, ids, deps) {
    var A1 = LAu(), P1 = L1();
    if (!A || !A.ok || A.engine !== 'surface') return { ok: false, reason: 'pick a surface first' };
    var capEngine = dep(deps, 'rawFlatCapLoops');
    if (typeof capEngine !== 'function') return { ok: false, reason: 'Lift needs the cut engine (app-cut.js, rawFlatCapLoops)' };
    var want = Array.from(new Set(ids || []));
    if (!want.length) return { ok: false, reason: 'nothing is chosen - click a detail first' };
    var M = A.M, nt = M.nt, chosen = new Uint8Array(nt), pieces = [], caps = [];
    for (var w = 0; w < want.length; w++) {
      var I = A.islands[want[w]];
      if (!I) return { ok: false, reason: 'there is no detail ' + want[w] + ' on this surface' };
      if (I.status !== 'ok') return { ok: false, reason: 'detail ' + (I.id + 1) + ' cannot be lifted: ' + (I.reason || SWHY[I.status]) };
      var mine = [], stats = [];
      for (var g = 0; g < I.groups.length; g++) {
        var G = I.groups[g], ear;
        try { ear = P1.internals.capFor({ M: M, plane: { n: G.frame.n, d: 0 }, frame: G.frame }, { loops: G.loops }, capEngine); }
        catch (err) { return { ok: false, reason: 'detail ' + (I.id + 1) + ' could not be capped (' + ((err && err.message) || err) + ')' }; }
        var stub = { M: M, map: { grid: { n: G.frame.n, e1: G.frame.e1, e2: G.frame.e2 } } };
        var fl = fill(stub, { tris: I.tris, loops: G.loops.map(function (L) { return { verts: L.verts }; }) }, ear,
          { relaxMm: A.relaxMm, target: G.fit.T });
        if (!fl.ok) return { ok: false, reason: 'detail ' + (I.id + 1) + ' could not be filled under: ' + fl.reason + ' - nothing changed' };
        mine.push(fl.cap); stats.push(fl.stats);
      }
      var ps = pieceOf(soup, I, mine), pc = A1.census(ps), held = 0;
      I.tris.forEach(function (t) { chosen[t] = 1; });
      if (I.parts && I.parts.length) {
        var extra = 0;
        I.parts.forEach(function (P) { extra += P.tris.length * 9; });
        var whole = new Float32Array(ps.length + extra), wo = ps.length;
        whole.set(ps);
        I.parts.forEach(function (P) {
          P.tris.forEach(function (t) { chosen[t] = 1; for (var q3 = 0; q3 < 9; q3++) whole[wo++] = soup[t * 9 + q3]; });
          held++;
        });
        ps = whole; pc = A1.census(ps);
      }
      if (!pc.closed || pc.degen) {
        return { ok: false, reason: 'detail ' + (I.id + 1) + ' would not come off as a closed piece (' + pc.open + ' open, ' + pc.nm +
          ' non-manifold, ' + pc.degen + ' degenerate) - nothing changed' };
      }
      var off = 0, capTris = 0;
      stats.forEach(function (s) { off = Math.max(off, s.maxOffBaseMm); capTris += s.tris; });
      pieces.push({ id: I.id, soup: ps, heightMm: I.heightMm, capTris: capTris, volume: P1.volume(ps), census: pc, group: I.group,
        backOffMm: off, parts: held, fill: stats[0], fills: stats, notes: I.notes || [], rootAreaMm2: 0, sharedCorners: 0, contacts: [] });
      mine.forEach(function (c) { caps.push(c); });
    }
    var kept = 0;
    for (var t = 0; t < nt; t++) if (!chosen[t]) kept++;
    var capLen = caps.reduce(function (s, x) { return s + x.length; }, 0);
    var plate = new Float32Array(kept * 9 + capLen), p = 0;
    for (t = 0; t < nt; t++) {
      if (chosen[t]) continue;
      for (var q2 = 0; q2 < 9; q2++) plate[p++] = soup[t * 9 + q2];
    }
    caps.forEach(function (cq) { for (var i = 0; i < cq.length; i++) plate[p++] = cq[i]; });
    var src = A.sourceCensus || (A.sourceCensus = A1.census(soup)), pl = A1.census(plate);
    if (src.closed && (!pl.closed || pl.degen)) {
      return { ok: false, reason: 'the plate would not stay closed (' + pl.open + ' open, ' + pl.nm + ' non-manifold, ' + pl.degen +
        ' degenerate) - nothing changed' };
    }
    var vSrc = P1.volume(soup), vPlate = P1.volume(plate), vP = pieces.reduce(function (s, x) { return s + x.volume; }, 0);
    return { ok: true, plate: plate, pieces: pieces, keptTris: kept, plateCensus: pl,
             volumes: { source: vSrc, plate: vPlate, pieces: vP, residual: vSrc - vPlate - vP } };
  }

  function surfaceWords(r, A) {
    var n = r.pieces.length, notes = [], held = r.pieces.reduce(function (s, pc) { return s + (pc.parts || 0); }, 0);
    r.pieces.forEach(function (pc) { (pc.notes || []).forEach(function (s) { notes.push(s); }); });
    return { n: n, notes: notes, held: held ? ' with ' + plural(held, 'captured part') : '' };
  }

  function surfaceLift(soup, A, ids, deps) {
    var r = surfaceCut(soup, A, ids, deps);
    if (!r.ok) return r;
    var W = surfaceWords(r, A);
    r.notes = W.notes;
    r.reason = 'lifted ' + plural(W.n, 'detail') + W.held + ' (' + fmt(r.volumes.pieces) + ' mm³) off the surface, each cut along the surface it ' +
      'stands on; the plate keeps ' + r.keptTris + ' of its ' + A.M.nt + ' triangles as they were; where ' + (W.n === 1 ? 'it' : 'they') +
      ' stood, the surface round ' + (W.n === 1 ? 'it' : 'them') + ' is carried across, welded to it at the rim' +
      (W.notes.length ? '. Note: ' + W.notes.join('; ') : '');
    return r;
  }

  function surfaceRemove(soup, A, ids, deps) {
    var r = surfaceCut(soup, A, ids, deps);
    if (!r.ok) return r;
    var W = surfaceWords(r, A);
    return { ok: true, plate: r.plate, keptTris: r.keptTris, plateCensus: r.plateCensus,
      removed: r.pieces.map(function (pc) { return { id: pc.id, volume: pc.volume, group: pc.group, backOffMm: pc.backOffMm, capTris: pc.capTris, fill: pc.fill }; }),
      volumes: { source: r.volumes.source, plate: r.volumes.plate, removed: r.volumes.pieces, residual: r.volumes.residual },
      notes: W.notes,
      reason: 'removed ' + plural(W.n, 'detail') + W.held + ' (' + fmt(r.volumes.pieces) + ' mm³); the plate keeps ' + r.keptTris + ' of its ' + A.M.nt +
        ' triangles as they were; where ' + (W.n === 1 ? 'it' : 'they') + ' stood, the surface round ' + (W.n === 1 ? 'it' : 'them') + ' is carried across' };
  }

  var api = {
    DEFAULTS: DEFAULTS, fill: fill, baseSampler: baseSampler, Tri: Tri,
    surface: { DEFAULTS: SURF, WHY: SWHY, analyse: surfaceAnalyse, lift: surfaceLift, remove: surfaceRemove, region: growRegion, fit: fitSurface }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_LiftCurved = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
