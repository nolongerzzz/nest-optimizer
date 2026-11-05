/* ============================================================
   nso_box_edges.js - round or bevel ANY chosen edges of a plain box.

   Soften's whole-solid wrap rounds all twelve edges of a box, or (with faces
   painted out) the edges between the faces left unpainted. That cannot say
   "just these two": an edge rounds only when both of its faces do, so two
   parallel edges on one side, or a single edge, or two edges with different
   radii, are out of its reach. This kernel takes the edges themselves.

   THE SHAPE. A box edge that takes radius R is the box with a quarter-round
   (or a flat bevel) in place of that edge, run the full length of the edge.
   Each one is convex, and so is their intersection, so the result of any set
   of edges is the box clipped by the profile planes of every picked edge:

     - Round  : the quarter circle is NA chords (12 per 90 degrees, the same
                sampling the wrap uses); each chord is a plane parallel to the
                edge, its corners ON the circle, the first and last touching
                the two faces exactly where the circle is tangent to them.
     - Bevel  : one chord - the flat cut.

   Because it is a clip and not a stitching of patches, the places where picked
   edges meet need no case of their own. Two picked edges that share a corner
   mitre there (the way a CAD fillet does when the third edge is left sharp);
   an edge that stops at a corner is simply cut square at that corner's face;
   parallel edges on opposite sides of one face may take up the whole width -
   R = half the face is a true half-round, where the flat between them has
   shrunk to nothing and is dropped.

   Each edge has its OWN radius. That is what lets two bakes build one piece:
   the bottom pair at R 15, then the top pair at R 3, from the same box.

   EDGE NUMBERS. edge = axis*4 + sideA*2 + sideB, where `axis` is the way the
   edge runs, A and B are the other two axes in ascending order, and each side
   is 0 for the low face and 1 for the high one. The same order the wrap
   counts its edges in. NSO_boxEdgeFaces(id) says which two faces an edge is
   between.

   Headless: flat triangle soups in, a flat triangle soup out, no THREE, no DOM.
   ============================================================ */
(function (root) {
  'use strict';

  var NA_ROUND = 12;           // chords per quarter turn, as the wrap's arc samples
  var EPS = 1e-9;              // a point this near a plane is on it
  var SNAP = 1e4;              // output grid - the one Soften's seal test welds on - so shared corners are the same number on
                             // both faces, and a feature too small to see (two nearly equal radii) collapses instead of tearing

  function edgeAxes(id) {
    var c = id >> 2, o = [0, 1, 2].filter(function (x) { return x !== c; });
    return { c: c, a: o[0], b: o[1], sa: (id >> 1) & 1, sb: id & 1 };
  }

  /* The two faces an edge is between, as [axis, side] pairs. */
  function boxEdgeFaces(id) {
    var e = edgeAxes(id);
    return [[e.a, e.sa], [e.b, e.sb]];
  }

  /* Edge number of the edge between two faces, or -1 when they are not
     neighbours (the same axis: opposite faces, or one face twice). */
  function boxEdgeBetween(fa, sa, fb, sb) {
    if (fa === fb) return -1;
    if (fa > fb) { var t = fa; fa = fb; fb = t; t = sa; sa = sb; sb = t; }
    var c = 3 - fa - fb;
    return c * 4 + sa * 2 + sb;
  }

  /* The twelve edges as raw-space segments, for drawing and picking. */
  function boxEdgeSegments(lo, hi) {
    var out = [];
    for (var id = 0; id < 12; id++) {
      var e = edgeAxes(id), p = [0, 0, 0], q = [0, 0, 0];
      p[e.a] = q[e.a] = e.sa ? hi[e.a] : lo[e.a];
      p[e.b] = q[e.b] = e.sb ? hi[e.b] : lo[e.b];
      p[e.c] = lo[e.c]; q[e.c] = hi[e.c];
      out.push({ id: id, p: p, q: q });
    }
    return out;
  }

  function dot(u, v) { return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]; }
  function sub(u, v) { return [u[0] - v[0], u[1] - v[1], u[2] - v[2]]; }
  function cross(u, v) { return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; }

  /* Twice the area vector of a polygon (Newell). */
  function areaVec(poly) {
    var s = [0, 0, 0];
    for (var i = 0; i < poly.length; i++) {
      var c = cross(poly[i], poly[(i + 1) % poly.length]);
      s[0] += c[0]; s[1] += c[1]; s[2] += c[2];
    }
    return s;
  }

  /* Wind a convex polygon so its normal points the way `n` does. */
  function wind(poly, n) {
    if (dot(areaVec(poly), n) < 0) poly.reverse();
    return poly;
  }

  function dedupe(poly, tol) {
    var out = [];
    for (var i = 0; i < poly.length; i++) {
      var p = poly[i], q = out.length ? out[out.length - 1] : null;
      if (q && Math.abs(p[0] - q[0]) < tol && Math.abs(p[1] - q[1]) < tol && Math.abs(p[2] - q[2]) < tol) continue;
      out.push(p);
    }
    while (out.length > 1) {
      var a = out[0], z = out[out.length - 1];
      if (Math.abs(a[0] - z[0]) < tol && Math.abs(a[1] - z[1]) < tol && Math.abs(a[2] - z[2]) < tol) out.pop();
      else break;
    }
    return out;
  }

  /* Cut a convex polyhedron (a list of { v: polygon, n: outward normal }) by the
     half-space n.x <= d. Faces wholly inside stay, faces wholly outside go,
     faces across the plane are trimmed, and the cut itself becomes a new face. */
  function clip(faces, n, d) {
    var anyOut = false, i, j;
    for (i = 0; i < faces.length && !anyOut; i++)
      for (j = 0; j < faces[i].v.length; j++) if (dot(n, faces[i].v[j]) - d > EPS) { anyOut = true; break; }
    if (!anyOut) return faces;                       // the plane cuts nothing

    var next = [], cap = [];
    for (i = 0; i < faces.length; i++) {
      var f = faces[i], v = f.v, k = v.length, dist = new Array(k), allIn = true, allOut = true;
      for (j = 0; j < k; j++) {
        dist[j] = dot(n, v[j]) - d;
        if (dist[j] > EPS) allIn = false;
        if (dist[j] < -EPS) allOut = false;
      }
      var keep;
      if (allIn) keep = v;
      else if (allOut && !allIn) { keep = null; }
      else {
        keep = [];
        for (j = 0; j < k; j++) {
          var p = v[j], q = v[(j + 1) % k], dp = dist[j], dq = dist[(j + 1) % k];
          var pin = dp <= EPS, qin = dq <= EPS;
          if (pin) keep.push(p);
          if (pin !== qin && Math.abs(dp - dq) > 0) {
            var t = dp / (dp - dq);
            keep.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), p[2] + t * (q[2] - p[2])]);
          }
        }
        keep = dedupe(keep, 1e-12);
      }
      if (keep) {
        for (j = 0; j < keep.length; j++) if (Math.abs(dot(n, keep[j]) - d) <= EPS * 4) cap.push(keep[j]);
        if (keep.length >= 3) next.push({ v: keep, n: f.n });
      } else {
        // wholly outside, but an edge of it may lie in the plane: that edge is still on the cut
        for (j = 0; j < k; j++) if (Math.abs(dist[j]) <= EPS * 4) cap.push(v[j]);
      }
    }
    cap = dedupe(cap.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }), 1e-9);
    // dedupe only neighbours in sort order; sweep once more over the whole list for repeats
    var uniq = [];
    cap.forEach(function (p) {
      for (var u = 0; u < uniq.length; u++)
        if (Math.abs(p[0] - uniq[u][0]) < 1e-9 && Math.abs(p[1] - uniq[u][1]) < 1e-9 && Math.abs(p[2] - uniq[u][2]) < 1e-9) return;
      uniq.push(p);
    });
    if (uniq.length >= 3) {
      var c = [0, 0, 0];
      uniq.forEach(function (p) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; });
      c = [c[0] / uniq.length, c[1] / uniq.length, c[2] / uniq.length];
      var ax = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      var u1 = cross(n, ax), l = Math.hypot(u1[0], u1[1], u1[2]);
      u1 = [u1[0] / l, u1[1] / l, u1[2] / l];
      var u2 = cross(n, u1);
      uniq.sort(function (a, b) {
        var da = sub(a, c), db = sub(b, c);
        return Math.atan2(dot(da, u2), dot(da, u1)) - Math.atan2(dot(db, u2), dot(db, u1));
      });
      wind(uniq, n);
      var av = areaVec(uniq);
      if (0.5 * Math.hypot(av[0], av[1], av[2]) > 1e-9) next.push({ v: uniq, n: n });
    }
    return next;
  }

  /* The chords of one edge's profile, as outward-normal planes { n, d }.
     `pts` are the profile's corner points in the plane across the edge, `da`
     and `db` the way in along each of its two faces. */
  function profilePlanes(box, e, R, mode) {
    var lo = box.lo, hi = box.hi;
    var P = [0, 0, 0];
    P[e.a] = e.sa ? hi[e.a] : lo[e.a];
    P[e.b] = e.sb ? hi[e.b] : lo[e.b];
    var da = e.sa ? -1 : 1, db = e.sb ? -1 : 1;     // inward along A, inward along B
    var C = [0, 0, 0];                               // the circle's centre, R in from both faces
    C[e.a] = P[e.a] + da * R; C[e.b] = P[e.b] + db * R;
    var n = (mode === 'chamfer') ? 1 : NA_ROUND, planes = [];
    var at = function (phi) {                        // phi 0: tangent to face A ... phi 90: tangent to face B
      var q = [0, 0, 0];
      q[e.a] = C[e.a] - da * R * Math.cos(phi);
      q[e.b] = C[e.b] - db * R * Math.sin(phi);
      return q;
    };
    for (var k = 0; k < n; k++) {
      var p0 = at((Math.PI / 2) * (k / n));
      var pm = (Math.PI / 2) * ((k + 0.5) / n);
      var nn = [0, 0, 0];
      nn[e.a] = -da * Math.cos(pm); nn[e.b] = -db * Math.sin(pm);
      // the chord plane passes through both of its ends
      planes.push({ n: nn, d: dot(nn, p0) });
    }
    return planes;
  }

  /* How much radius each picked edge can really have. An edge's arc rolls off
     R deep from each of its two faces; along any one axis the roll-off from the
     low face and from the high face must fit in the box's width there, or the
     solid pinches. So per axis: depth from the low face (the biggest R among
     picked edges on it) + depth from the high face <= the width. Where that is
     broken, every edge touching that axis is scaled by the same factor until it
     is not. A single edge may use the whole face (R = width); a pair on
     opposite sides of one face share it half and half - R = half the width is
     the true half-round. `R` is a 12-long array, 0 where an edge is not picked;
     it is returned cut down. */
  function fitRadii(box, R) {
    R = R.slice();
    for (var pass = 0; pass < 8; pass++) {
      var changed = false;
      for (var ax = 0; ax < 3; ax++) {
        var lo = 0, hi = 0, id;
        for (id = 0; id < 12; id++) {
          if (!(R[id] > 0)) continue;
          var f = boxEdgeFaces(id);
          for (var k = 0; k < 2; k++) if (f[k][0] === ax) { if (f[k][1]) hi = Math.max(hi, R[id]); else lo = Math.max(lo, R[id]); }
        }
        if (lo + hi > box.ext[ax] * (1 + 1e-12)) {
          var scale = box.ext[ax] / (lo + hi);
          for (id = 0; id < 12; id++) {
            if (!(R[id] > 0)) continue;
            var g = boxEdgeFaces(id);
            if (g[0][0] === ax || g[1][0] === ax) R[id] *= scale;
          }
          changed = true;
        }
      }
      if (!changed) break;
    }
    return R;
  }

  /* Open and non-manifold edge counts on the weld grid Soften's own seal test
     uses (app-finish.js nsoSealScore), so "closed" means the same thing here. */
  function closure(soup) {
    var q = 1e4, use = new Map();
    var vk = function (i) { return Math.round(soup[i] * q) + '|' + Math.round(soup[i + 1] * q) + '|' + Math.round(soup[i + 2] * q); };
    for (var t = 0; t + 8 < soup.length; t += 9) {
      var K = [vk(t), vk(t + 3), vk(t + 6)];
      for (var e = 0; e < 3; e++) {
        var a = K[e], b = K[(e + 1) % 3];
        if (a === b) continue;
        var k = a < b ? a + '~' + b : b + '~' + a;
        use.set(k, (use.get(k) || 0) + 1);
      }
    }
    var open = 0, nm = 0;
    use.forEach(function (c) { if (c % 2) open++; if (c > 2) nm++; });
    return { open: open, nm: nm };
  }

  /* NSO_boxEdgeRound(box, edges, opts)
       box    { lo, hi, ext }, the plain box (rawSolidBox's answer)
       edges  [{ id, R, mode }]  mode 'fillet' (default) or 'chamfer'; one entry per edge
       opts   { square: [[bool,bool],[bool,bool],[bool,bool]] } faces to leave exactly
              as they are - an edge touching one of them is left sharp
     Returns { soup, build } - soup is a Float32Array of triangles (outward wound),
     build says what was made: { edges, requested, clamped, tris, perEdge: [...],
     shrunk, sealed } - shrunk when the radii had to come down 0.1% (or more) to
     keep the solid from touching itself.
     Throws when nothing is left to round. */
  function boxEdgeRound(box, edges, opts) {
    opts = opts || {};
    var sq = opts.square || null;
    var picked = [], i;
    for (i = 0; i < 12; i++) picked[i] = null;
    (edges || []).forEach(function (s) {
      if (!s || !(s.id >= 0 && s.id < 12) || !(s.R > 0)) return;
      var f = boxEdgeFaces(s.id);
      if (sq && (sq[f[0][0]][f[0][1]] || sq[f[1][0]][f[1][1]])) return;     // touches a painted-out face
      picked[s.id] = { id: s.id, R: s.R, mode: s.mode === 'chamfer' ? 'chamfer' : 'fillet' };
    });
    var flags = picked.map(function (p) { return !!p; });
    var list = picked.filter(Boolean);
    if (!list.length) throw new Error('no edge to round - left unchanged');

    var asked = [];
    for (i = 0; i < 12; i++) asked[i] = picked[i] ? picked[i].R : 0;
    var fit = fitRadii(box, asked);

    // One go at the shape with every radius scaled by `shrink`. A set of edges
    // that each use a whole face width can meet in a tangent point that leaves
    // the solid touching itself along a line; a hair less radius clears it, so
    // that is the retry (see below), not a case of its own.
    var attempt = function (shrink) {
    var lo = box.lo, hi = box.hi;
    var faces = [];
    for (var ax = 0; ax < 3; ax++) {
      var o = [0, 1, 2].filter(function (x) { return x !== ax; });
      for (var s = 0; s < 2; s++) {
        var mk = function (vb, vc) { var p = [0, 0, 0]; p[ax] = s ? hi[ax] : lo[ax]; p[o[0]] = vb; p[o[1]] = vc; return p; };
        var nrm = [0, 0, 0]; nrm[ax] = s ? 1 : -1;
        faces.push({ v: wind([mk(lo[o[0]], lo[o[1]]), mk(hi[o[0]], lo[o[1]]), mk(hi[o[0]], hi[o[1]]), mk(lo[o[0]], hi[o[1]])], nrm), n: nrm });
      }
    }

    var perEdge = [], clamped = 0, maxR = 0;
    list.forEach(function (sp) {
      var e = edgeAxes(sp.id);
      // to the micron, rounded down: two radii that differ by less than that are the same radius,
      // and the mitre between them is then exact instead of a sliver nobody can see
      var R = Math.floor(fit[sp.id] * shrink * 1000 + 1e-6) / 1000;
      if (R < sp.R - 1e-9) clamped++;
      if (!(R > 1e-4)) return;
      if (R > maxR) maxR = R;
      perEdge.push({ id: sp.id, R: R, requested: sp.R, mode: sp.mode });
      profilePlanes(box, e, R, sp.mode).forEach(function (pl) { faces = clip(faces, pl.n, pl.d); });
    });
    if (!perEdge.length) throw new Error('R leaves nothing to round - left unchanged');

    // A face that has shrunk to a line (two half-round edges meeting) or lost
    // its area is dropped; the rest are snapped to one grid so a corner shared
    // by two faces is the same number in both, then fanned into triangles.
    var snap = function (x) { var r = Math.round(x * SNAP) / SNAP; return r === 0 ? 0 : r; };
    var out = [], tris = 0;
    faces.forEach(function (f) {
      var poly = dedupe(f.v.map(function (p) { return [snap(p[0]), snap(p[1]), snap(p[2])]; }), 1e-9);
      if (poly.length < 3) return;
      var av = areaVec(poly);
      if (0.5 * Math.hypot(av[0], av[1], av[2]) < 1e-7) return;
      wind(poly, f.n);
      for (var t = 1; t + 1 < poly.length; t++) {
        var A = poly[0], B = poly[t], C = poly[t + 1];
        var cv = cross(sub(B, A), sub(C, A));
        if (0.5 * Math.hypot(cv[0], cv[1], cv[2]) < 1e-9) continue;
        out.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
        tris++;
      }
    });
    if (tris < 4) throw new Error('edge round produced no geometry - left unchanged');
    var build = { edges: perEdge.length, requested: list.length, clamped: clamped, maxR: maxR, tris: tris,
                  perEdge: perEdge, shrunk: shrink !== 1 };
    return { soup: new Float32Array(out), build: build };
    };

    var res = null, tries = [1, 0.999, 0.99, 0.95];
    for (var ti = 0; ti < tries.length; ti++) {
      res = attempt(tries[ti]);
      var sc = closure(res.soup);
      res.build.sealed = !sc.open && !sc.nm;
      if (res.build.sealed) break;
    }
    boxEdgeRound.lastBuild = res.build;
    return res;
  }

  var api = {
    round: boxEdgeRound,
    faces: boxEdgeFaces,
    between: boxEdgeBetween,
    segments: boxEdgeSegments,
    fit: fitRadii
  };
  root.NSO_BoxEdges = api;
  root.NSO_boxEdgeRound = boxEdgeRound;
  root.NSO_boxEdgeFaces = boxEdgeFaces;
  root.NSO_boxEdgeBetween = boxEdgeBetween;
  root.NSO_boxEdgeSegments = boxEdgeSegments;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
