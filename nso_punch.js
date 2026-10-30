/* nso_punch.js - Punch: click a face, get a round hole straight through it (or
   to a depth), and the same hole repeated in a grid or on a circle.
   docs/PUNCH.md.

   Loads as a classic script (window.NSO_Punch) and as a Node module. No DOM,
   no THREE. The soup is the app's usual triangle soup (9 numbers a triangle)
   in the frame the click was read in; every point and direction handed in or
   out is [x, y, z] in that same frame.

     NSO_Punch.plan(soup, hit, opts) -> { ok, holes, reason, ... }
     NSO_Punch.cutters(plan)          -> [ soup, ... ]  one cylinder a hole

   plan() only reads the soup. A refusal is { ok: false, holes: [], reason }
   with the reason in words; nothing is built and the piece is as it was.

   hit   { point: [x, y, z], normal: [x, y, z] } - the app's pick. hit.tri (the
         triangle number, three's faceIndex on a non-indexed mesh) is used when
         given; otherwise the triangle under the point is found. The normal
         only says which side was clicked: the frame's normal is the surface's
         own smooth normal at the point (below), so a click on a faceted
         cylinder lays its pattern square to the cylinder, not to the facet.

   opts  diaMm     the hole (default 3). Its flats are at this diameter, so a
                   pin of this size goes in: the cutter's corners sit on
                   dia / 2 / cos(pi / sides).
         depth     'through' (default) or a number of mm below the surface
         countersink 'none' (the only one for now)
         nozzle    mm, default 0.4; the wall floor is two of these
         pattern   'none' | 'grid' | 'radial' (or { type, ...fields })
           grid    rows, cols, pitchX, pitchY, anchor 'corner' | 'centre'
                   cols run along u, rows along v, row-major from the anchor
           radial  n, R - n holes on a circle of radius R about the click,
                   the first at angle 0 (along u), counter-clockwise seen from
                   outside the face

   THE FACE'S FRAME. n is the smooth normal at the click. u runs along the
   face's longest straight edge: the longest collinear run of rim edges of the
   flat region the click is on (for a slab's top its longest side, for a
   cylinder's facet strip the cylinder's length), laid square to n, its
   largest world component made positive. v = n x u.

   EACH HOLE. A pattern point p = click + x u + y v is a point in the click's
   tangent plane. Its footprint is where the line through p along n meets the
   SAME SMOOTH SURFACE the click is on (triangles joined across edges of at
   most smoothDeg), on its front side, nearest p. No footprint - the line
   misses the piece, or lands on another face (a step down, the side of the
   slab) - and the hole is DROPPED and counted in the reason, not refused.
   The hole's axis is the surface's smooth normal at its own footprint: the
   facet normals of the triangles round each corner of the footprint's
   triangle (same surface only), angle-weighted, interpolated across it. On a
   faceted cylinder that is the true radial direction at the footprint.

   A hole is { n, centre, axis, dia, depth, lift, spans }: centre the
   footprint, axis the outward unit normal there, and the cutter runs from
   centre + lift * axis to depth mm further in along -axis. lift is 0.2 mm.
   'through' = the ray in leaves the piece for good (its last exit), + 0.2 mm
   past it: a 10 mm slab reads depth 10.4. A number d reads d + 0.2. spans
   are the stretches of the ray inside material, [s0, s1] mm below centre.

   REFUSED, in words (the piece unchanged), when a hole would leave less than
   the floor (two nozzle widths) of wall:
     - to a neighbour hole: the closest approach of the two holes' material
       spans, less both radii ("holes 3 and 4 would leave 0.5 mm between
       them; the floor is 0.8");
     - to the piece's edge: where the hole goes in and comes out of each span,
       the distance from that point to the nearest CONVEX edge of the surface
       it is on, less the radius (a concave corner - the foot of a boss, a
       pocket's wall - is not an edge to break through);
     - under a blind hole: the skin left between its bottom and the far face.
   Holes are numbered by their place in the pattern, from 1, dropped ones
   included, so a number can be counted off on the grid.

   PAINT SCOPE: NOT APPLICABLE here - this file reads a soup and returns new
   ones. The app's Punch, which subtracts them, carries the paint check
   (docs/HANDOFF.md). */
(function (root) {
  'use strict';

  var BVH = root && root.NSO_BVH ? root.NSO_BVH : null;
  if (!BVH && typeof module !== 'undefined' && typeof require === 'function') {
    try { BVH = require('./nso_bvh.js'); } catch (e) { BVH = null; }
  }

  var DEFAULTS = {
    diaMm: 3,
    depth: 'through',
    countersink: 'none',
    nozzle: 0.4,
    pattern: 'none',
    rows: 2, cols: 2, pitchX: 10, pitchY: 10, anchor: 'corner',
    n: 6, R: 10,
    endMm: 0.2,          // the cutter runs this far past the surface at each end
    smoothDeg: 30,       // neighbours this close are one smooth surface (and share a normal)
    planarDeg: 0.5,      // ...and this close, one flat region (the frame's u comes from its rim)
    maxHoles: 400,
    maxCount: 100        // rows, cols or n
  };

  /* ------------------------------------------------------------- vectors */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function unit(a) { var L = len(a); return L > 1e-300 ? [a[0] / L, a[1] / L, a[2] / L] : null; }
  function vec(p) {
    if (!p) return null;
    var v = (p.length >= 3) ? [+p[0], +p[1], +p[2]] : [+p.x, +p.y, +p.z];
    return (isFinite(v[0]) && isFinite(v[1]) && isFinite(v[2])) ? v : null;
  }
  function vtx(s, t, k) { var o = 9 * t + 3 * k; return [s[o], s[o + 1], s[o + 2]]; }
  function fmt(x, floor) {
    var a = (Math.round(x * 10) / 10).toFixed(1);
    if (floor != null && a === fmt(floor)) a = (Math.round(x * 100) / 100).toFixed(2);
    return a === '-0.0' ? '0.0' : a;
  }
  function plural(k, one, many) { return k + ' ' + (k === 1 ? one : many); }

  /* ---------------------------------------------- the soup, read once */
  var meshCache = typeof WeakMap === 'function' ? new WeakMap() : null;

  /* Welded corners, edge neighbours, facet normals, smooth surfaces (union
     across edges of at most smoothDeg) and each surface's convex rim. Kept on
     the soup's array: a card re-plans at every change of a field. */
  function meshOf(soup, smoothDeg) {
    var key = smoothDeg;
    var hit = meshCache && meshCache.get(soup);
    if (hit && hit.key === key && hit.len === soup.length) return hit;
    var n = (soup.length / 9) | 0, t, k;
    var nrm = new Float64Array(3 * n), cen = new Float64Array(3 * n);
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (t = 0; t < n; t++) {
      var a = vtx(soup, t, 0), b = vtx(soup, t, 1), c = vtx(soup, t, 2);
      var nn = unit(cross(sub(b, a), sub(c, a))) || [0, 0, 0];
      nrm[3 * t] = nn[0]; nrm[3 * t + 1] = nn[1]; nrm[3 * t + 2] = nn[2];
      for (k = 0; k < 3; k++) {
        cen[3 * t + k] = (a[k] + b[k] + c[k]) / 3;
        lo[k] = Math.min(lo[k], a[k], b[k], c[k]); hi[k] = Math.max(hi[k], a[k], b[k], c[k]);
      }
    }
    var diag = n ? len(sub(hi, lo)) : 0;
    var q = 1e4;                                  // weld at 0.1 micron
    var ids = new Map(), vid = new Int32Array(3 * n), nV = 0;
    for (var i = 0; i < 3 * n; i++) {
      var kk = Math.round(soup[3 * i] * q) + ',' + Math.round(soup[3 * i + 1] * q) + ',' + Math.round(soup[3 * i + 2] * q);
      var id = ids.get(kk);
      if (id === undefined) { id = nV++; ids.set(kk, id); }
      vid[i] = id;
    }
    // edges: key -> [tri, tri, ...]
    var edges = new Map();
    for (t = 0; t < n; t++) for (k = 0; k < 3; k++) {
      var e0 = vid[3 * t + k], e1 = vid[3 * t + (k + 1) % 3];
      if (e0 === e1) continue;
      var ek = e0 < e1 ? e0 * nV + e1 : e1 * nV + e0;
      var lst = edges.get(ek);
      if (lst) lst.push(t); else edges.set(ek, [t]);
    }
    // smooth surfaces
    var par = new Int32Array(n);
    for (t = 0; t < n; t++) par[t] = t;
    function find(x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }
    var cosS = Math.cos(smoothDeg * Math.PI / 180);
    edges.forEach(function (l) {
      if (l.length !== 2) return;
      var A = l[0], B = l[1];
      var d = nrm[3 * A] * nrm[3 * B] + nrm[3 * A + 1] * nrm[3 * B + 1] + nrm[3 * A + 2] * nrm[3 * B + 2];
      if (d >= cosS) { var ra = find(A), rb = find(B); if (ra !== rb) par[ra] = rb; }
    });
    var region = new Int32Array(n);
    for (t = 0; t < n; t++) region[t] = find(t);
    // each surface's convex rim (and open edges): segments, 6 numbers each
    var rims = new Map(), tol = 1e-9 * Math.max(1, diag);
    for (t = 0; t < n; t++) for (k = 0; k < 3; k++) {
      var v0 = vid[3 * t + k], v1 = vid[3 * t + (k + 1) % 3];
      if (v0 === v1) continue;
      var l2 = edges.get(v0 < v1 ? v0 * nV + v1 : v1 * nV + v0), rim = l2.length === 1;
      for (var j = 0; !rim && j < l2.length; j++) {
        var B2 = l2[j];
        if (B2 === t || region[B2] === region[t]) continue;
        var g = (cen[3 * B2] - cen[3 * t]) * nrm[3 * t] + (cen[3 * B2 + 1] - cen[3 * t + 1]) * nrm[3 * t + 1] +
                (cen[3 * B2 + 2] - cen[3 * t + 2]) * nrm[3 * t + 2];
        if (g < -tol) rim = true;
      }
      if (!rim) continue;
      var seg = rims.get(region[t]);
      if (!seg) { seg = []; rims.set(region[t], seg); }
      var o0 = 9 * t + 3 * k, o1 = 9 * t + 3 * ((k + 1) % 3);
      seg.push(soup[o0], soup[o0 + 1], soup[o0 + 2], soup[o1], soup[o1 + 1], soup[o1 + 2]);
    }
    // corner -> triangles round it (for the smooth normal)
    var cnt = new Int32Array(nV + 1);
    for (i = 0; i < 3 * n; i++) cnt[vid[i] + 1]++;
    for (i = 0; i < nV; i++) cnt[i + 1] += cnt[i];
    var fill = cnt.slice(0, nV), ring = new Int32Array(3 * n);
    for (i = 0; i < 3 * n; i++) ring[fill[vid[i]]++] = i;   // corner numbers
    var ix = null;
    if (BVH && BVH.indexFor && BVH.rayCandidates && n >= 64) {
      try { ix = BVH.indexFor(soup, false, 64); } catch (e2) { ix = null; }
    }
    var M = { key: key, len: soup.length, soup: soup, n: n, nrm: nrm, vid: vid, edges: edges, nV: nV,
              region: region, rims: rims, ringStart: cnt, ring: ring, diag: diag, lo: lo, hi: hi, ix: ix, cand: [] };
    if (meshCache) meshCache.set(soup, M);
    return M;
  }
  function triN(M, t) { return [M.nrm[3 * t], M.nrm[3 * t + 1], M.nrm[3 * t + 2]]; }

  /* The smooth normal at p on triangle t (see the header). */
  function smoothNormal(M, t, p) {
    var s = M.soup, P = [vtx(s, t, 0), vtx(s, t, 1), vtx(s, t, 2)], reg = M.region[t];
    var cn = [];
    for (var k = 0; k < 3; k++) {
      var v = M.vid[3 * t + k], acc = [0, 0, 0];
      for (var q = M.ringStart[v]; q < M.ringStart[v + 1]; q++) {
        var corner = M.ring[q], u = (corner / 3) | 0, c = corner % 3;
        if (M.region[u] !== reg) continue;
        var A = vtx(s, u, c), e1 = unit(sub(vtx(s, u, (c + 1) % 3), A)), e2 = unit(sub(vtx(s, u, (c + 2) % 3), A));
        if (!e1 || !e2) continue;
        var w = Math.acos(Math.max(-1, Math.min(1, dot(e1, e2))));
        acc = add(acc, mul(triN(M, u), w));
      }
      cn.push(unit(acc) || triN(M, t));
    }
    var w3 = bary(P, p);
    return unit(add(add(mul(cn[0], w3[0]), mul(cn[1], w3[1])), mul(cn[2], w3[2]))) || triN(M, t);
  }
  function bary(P, p) {
    var v0 = sub(P[1], P[0]), v1 = sub(P[2], P[0]), v2 = sub(p, P[0]);
    var d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
    var den = d00 * d11 - d01 * d01;
    if (Math.abs(den) < 1e-300) return [1 / 3, 1 / 3, 1 / 3];
    var b = (d11 * d20 - d01 * d21) / den, c = (d00 * d21 - d01 * d20) / den;
    b = Math.max(0, Math.min(1, b)); c = Math.max(0, Math.min(1 - b, c));
    return [1 - b - c, b, c];
  }

  /* ------------------------------------------------------------- rays */
  function rayTri(s, t, o, d) {
    var p = 9 * t;
    var ax = s[p], ay = s[p + 1], az = s[p + 2];
    var e1x = s[p + 3] - ax, e1y = s[p + 4] - ay, e1z = s[p + 5] - az;
    var e2x = s[p + 6] - ax, e2y = s[p + 7] - ay, e2z = s[p + 8] - az;
    var px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    var det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-14) return null;
    var inv = 1 / det, tx = o[0] - ax, ty = o[1] - ay, tz = o[2] - az;
    var u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) return null;
    var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    var v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) return null;
    return (e2x * qx + e2y * qy + e2z * qz) * inv;
  }
  /* Every triangle the ray (o, unit d) crosses for t in [0, limit], by t. */
  function rayHits(M, o, d, limit) {
    var out = [], cand = null, t, h;
    if (M.ix) cand = BVH.rayCandidates(M.ix, o[0], o[1], o[2], d[0], d[1], d[2], limit, M.cand);
    var m = cand ? cand.length : M.n;
    for (var q = 0; q < m; q++) {
      t = cand ? cand[q] : q;
      h = rayTri(M.soup, t, o, d);
      if (h !== null && h >= 0 && h <= limit) out.push({ t: h, tri: t });
    }
    out.sort(function (a, b) { return a.t - b.t || a.tri - b.tri; });
    return out;
  }

  /* ----------------------------------------------------- the click */
  function clickedTri(M, p, nHint, given) {
    if (given != null && given >= 0 && given < M.n && (given | 0) === given) return given;
    var hint = nHint && unit(nHint);
    if (hint) {
      var hs = rayHits(M, add(p, hint), mul(hint, -1), 2), best = -1, bd = 0.05;
      for (var i = 0; i < hs.length; i++) {
        var off = Math.abs(hs[i].t - 1);
        if (off < bd && dot(triN(M, hs[i].tri), hint) > 0) { bd = off; best = hs[i].tri; }
      }
      if (best >= 0) return best;
    }
    // the triangle nearest the point (a click read off a coarser copy)
    var bt = -1, bdist = Infinity;
    for (var t = 0; t < M.n; t++) {
      if (hint && dot(triN(M, t), hint) <= 0) continue;
      var dd = len(sub(closestOnTri(vtx(M.soup, t, 0), vtx(M.soup, t, 1), vtx(M.soup, t, 2), p), p));
      if (dd < bdist) { bdist = dd; bt = t; }
    }
    return bdist <= Math.max(0.05, 1e-4 * M.diag) ? bt : -1;
  }
  function closestOnTri(a, b, c, p) {
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
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return add(b, mul(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
    var den = 1 / (va + vb + vc);
    return add(a, add(mul(ab, vb * den), mul(ac, vc * den)));
  }

  /* u: along the longest straight run of the flat region's rim (header). */
  function faceU(M, seed, n0, planarDeg) {
    var s = M.soup, ns = triN(M, seed), ps = vtx(s, seed, 0);
    var cosP = Math.cos(planarDeg * Math.PI / 180), tolD = Math.max(1e-4, 1e-6 * M.diag);
    var inR = new Map(), stack = [seed], t, k;
    inR.set(seed, true);
    function flatWith(u) {
      if (dot(triN(M, u), ns) < cosP) return false;
      for (var c = 0; c < 3; c++) if (Math.abs(dot(ns, sub(vtx(s, u, c), ps))) > tolD) return false;
      return true;
    }
    var bnd = [];
    while (stack.length) {
      t = stack.pop();
      for (k = 0; k < 3; k++) {
        var a = M.vid[3 * t + k], b = M.vid[3 * t + (k + 1) % 3];
        if (a === b) continue;
        var l = M.edges.get(a < b ? a * M.nV + b : b * M.nV + a), inner = false;
        for (var j = 0; j < l.length; j++) {
          var u = l[j];
          if (u === t) continue;
          if (inR.has(u)) { inner = true; continue; }
          if (flatWith(u)) { inR.set(u, true); stack.push(u); inner = true; }
        }
        if (!inner) bnd.push([vtx(s, t, k), vtx(s, t, (k + 1) % 3)]);
      }
    }
    var segs = bnd.map(function (e) { var d = sub(e[1], e[0]); return { a: e[0], d: unit(d), L: len(d) }; })
                  .filter(function (g) { return g.d && g.L > 0; })
                  .sort(function (x, y) { return y.L - x.L; }).slice(0, 200);
    var runs = [];
    var cosR = Math.cos(0.5 * Math.PI / 180);
    segs.forEach(function (g) {
      for (var r = 0; r < runs.length; r++) {
        var R = runs[r];
        if (Math.abs(dot(R.d, g.d)) < cosR) continue;
        var off = sub(g.a, R.a), perp = sub(off, mul(R.d, dot(off, R.d)));
        if (len(perp) > tolD * 10) continue;
        R.L += g.L; return;
      }
      runs.push({ a: g.a, d: g.d, L: g.L });
    });
    var best = null;
    runs.forEach(function (R) {
      if (!best || R.L > best.L * (1 + 1e-6)) { best = R; return; }
      if (R.L >= best.L * (1 - 1e-6)) {               // a tie: the one nearer world x, then y
        for (var c = 0; c < 3; c++) {
          var x = Math.abs(R.d[c]), y = Math.abs(best.d[c]);
          if (Math.abs(x - y) > 1e-6) { if (x > y) best = R; return; }
        }
      }
    });
    var u0 = best ? best.d : [1, 0, 0];
    var uu = unit(sub(u0, mul(n0, dot(u0, n0))));
    if (!uu) uu = unit(sub([1, 0, 0], mul(n0, n0[0]))) || unit(sub([0, 1, 0], mul(n0, n0[1])));
    var big = 0;
    for (var c2 = 1; c2 < 3; c2++) if (Math.abs(uu[c2]) > Math.abs(uu[big]) + 1e-9) big = c2;
    return uu[big] < 0 ? mul(uu, -1) : uu;
  }

  /* --------------------------------------------------------- the pattern */
  function patternOf(o) {
    var pts = [], i, j;
    if (o.pattern === 'grid') {
      for (j = 0; j < o.rows; j++) for (i = 0; i < o.cols; i++) {
        if (o.anchor === 'centre') pts.push([(i - (o.cols - 1) / 2) * o.pitchX, (j - (o.rows - 1) / 2) * o.pitchY]);
        else pts.push([i * o.pitchX, j * o.pitchY]);
      }
    } else if (o.pattern === 'radial') {
      for (i = 0; i < o.n; i++) { var a = 2 * Math.PI * i / o.n; pts.push([o.R * Math.cos(a), o.R * Math.sin(a)]); }
    } else pts.push([0, 0]);
    return pts;
  }

  function optsOf(opts) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    opts = opts || {};
    for (k in opts) if (opts[k] !== undefined) o[k] = opts[k];
    if (opts.pattern && typeof opts.pattern === 'object') {
      for (k in opts.pattern) if (k !== 'type' && opts.pattern[k] !== undefined) o[k] = opts.pattern[k];
      o.pattern = opts.pattern.type || 'none';
    }
    if (o.anchor === 'center') o.anchor = 'centre';
    return o;
  }
  function badOpts(o) {
    if (!(isFinite(o.diaMm) && o.diaMm > 0)) return 'the hole needs a diameter above 0';
    if (!(isFinite(o.nozzle) && o.nozzle > 0)) return 'the nozzle width must be above 0';
    if (o.diaMm < 2 * o.nozzle) return 'a ' + fmt(o.diaMm) + ' mm hole is narrower than two nozzle widths (' + fmt(2 * o.nozzle) + ') - it would print shut';
    if (o.depth !== 'through' && !(isFinite(o.depth) && o.depth > 0)) return "depth is 'through' or a number of mm above 0";
    if (o.countersink !== 'none' && o.countersink != null) return 'countersinks are not in Punch yet - countersink must be none';
    var cnt = function (x) { return (x | 0) === x && x >= 1 && x <= o.maxCount; };
    if (o.pattern === 'grid') {
      if (!cnt(o.rows) || !cnt(o.cols)) return 'a grid needs whole numbers of rows and columns, 1 to ' + o.maxCount;
      if (o.cols > 1 && !(isFinite(o.pitchX) && o.pitchX > 0)) return 'the grid needs a pitch across its columns above 0';
      if (o.rows > 1 && !(isFinite(o.pitchY) && o.pitchY > 0)) return 'the grid needs a pitch across its rows above 0';
      if (o.anchor !== 'corner' && o.anchor !== 'centre') return "the grid's anchor is 'corner' or 'centre'";
      if (o.rows * o.cols > o.maxHoles) return o.rows * o.cols + ' holes is more than one punch makes (' + o.maxHoles + ')';
    } else if (o.pattern === 'radial') {
      if (!cnt(o.n)) return 'a circle of holes needs a whole number of holes, 1 to ' + o.maxCount;
      if (!(isFinite(o.R) && o.R > 0)) return 'the circle needs a radius above 0';
    } else if (o.pattern !== 'none') return "pattern is 'none', 'grid' or 'radial'";
    return null;
  }

  /* The ray in from a footprint: stretches of material [s0, s1] below it,
     with the triangles they enter and leave by. null = it never leaves. */
  function spansFrom(M, c, axis) {
    var L = M.diag + 1, dir = mul(axis, -1), hs = rayHits(M, add(c, mul(axis, L)), dir, 2 * L + 1);
    var spans = [], depth = 0, start = 0, startTri = -1, last = null;
    for (var i = 0; i < hs.length; i++) {
      var s = hs[i].t - L;
      if (s < -1e-4) continue;
      var entering = dot(triN(M, hs[i].tri), dir) < 0;
      if (last && Math.abs(s - last.s) < 1e-6 && last.entering === entering) continue;   // a shared edge
      last = { s: s, entering: entering };
      if (entering) { if (depth === 0) { start = Math.max(0, s); startTri = hs[i].tri; } depth++; }
      else if (depth > 0) { depth--; if (depth === 0) spans.push({ s0: start, s1: s, inTri: startTri, outTri: hs[i].tri }); }
    }
    return depth === 0 && spans.length ? spans : null;
  }

  function distToRim(M, reg, p) {
    var seg = M.rims.get(reg);
    if (!seg) return Infinity;
    var best = Infinity;
    for (var i = 0; i < seg.length; i += 6) {
      var a = [seg[i], seg[i + 1], seg[i + 2]], ab = [seg[i + 3] - a[0], seg[i + 4] - a[1], seg[i + 5] - a[2]];
      var L2 = dot(ab, ab), t = L2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / L2)) : 0;
      var d = len(sub(p, add(a, mul(ab, t))));
      if (d < best) best = d;
    }
    return best;
  }
  /* Closest approach of segments p1q1 and p2q2 (Ericson 5.1.9). */
  function segDist(p1, q1, p2, q2) {
    var d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
    var a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), s, t;
    if (a <= 1e-18 && e <= 1e-18) return len(r);
    if (a <= 1e-18) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
    else {
      var c = dot(d1, r);
      if (e <= 1e-18) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else {
        var b = dot(d1, d2), den = a * e - b * b;
        s = den > 1e-18 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
        else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
      }
    }
    return len(sub(add(p1, mul(d1, s)), add(p2, mul(d2, t))));
  }

  /* ------------------------------------------------------------- plan */
  function refuse(reason, extra) {
    var r = { ok: false, holes: [], reason: reason };
    for (var k in extra || {}) r[k] = extra[k];
    return r;
  }

  /* The click read off the soup: its triangle, the smooth surface it is on,
     and the face's frame (header). { reason } when the click is not on it. */
  function frameOf(soup, hit, o) {
    var p0 = vec(hit && (hit.point || hit.p || hit)), nh = vec(hit && (hit.normal || hit.n));
    if (!p0) return { reason: 'the click has no point on the piece' };
    var M = meshOf(soup, o.smoothDeg);
    var seed = clickedTri(M, p0, nh, hit && (hit.tri != null ? hit.tri : hit.faceIndex));
    if (seed < 0) return { reason: 'the click is not on this piece' };
    var n0 = smoothNormal(M, seed, p0), u = faceU(M, seed, n0, o.planarDeg);
    return { M: M, seed: seed, p0: p0, n0: n0, R0: M.region[seed], u: u, v: cross(n0, u) };
  }
  /* A tangent-plane point's footprint: where the line through p along n0 meets
     surface R0 on its front side, nearest p - { point, normal, tri }, or null. */
  function footOf(M, R0, n0, p) {
    var L = M.diag + 1, hs = rayHits(M, add(p, mul(n0, L)), mul(n0, -1), 2 * L), best = null;
    for (var j = 0; j < hs.length; j++) {
      var h = hs[j];
      if (M.region[h.tri] !== R0 || dot(triN(M, h.tri), n0) <= 0.05) continue;
      if (!best || Math.abs(h.t - L) < Math.abs(best.t - L)) best = h;
    }
    if (!best) return null;
    var c = add(p, mul(n0, L - best.t));
    return { point: c, normal: smoothNormal(M, best.tri, c), tri: best.tri };
  }

  function plan(soup, hit, opts) {
    var o = optsOf(opts);
    var bad = badOpts(o);
    if (bad) return refuse(bad);
    if (!soup || soup.length < 36 || soup.length % 9) return refuse('there is no piece to punch');
    var F = frameOf(soup, hit, o);
    if (F.reason) return refuse(F.reason);
    var M = F.M, p0 = F.p0, n0 = F.n0, R0 = F.R0, u = F.u, v = F.v;
    var r = o.diaMm / 2, floor = 2 * o.nozzle;
    var pts = patternOf(o);

    // footprints
    var holes = [], dropped = [], droppedAt = [];
    for (var i = 0; i < pts.length; i++) {
      var p = add(p0, add(mul(u, pts[i][0]), mul(v, pts[i][1])));
      var ft = footOf(M, R0, n0, p);
      if (!ft) { dropped.push(i + 1); droppedAt.push({ n: i + 1, point: p, axis: n0 }); continue; }
      var c = ft.point, axis = ft.normal;
      var spans = spansFrom(M, c, axis);
      if (!spans) return refuse('hole ' + (i + 1) + ' goes in and never comes out - the piece is not closed there; Repair it first');
      holes.push({ n: i + 1, centre: c, axis: axis, dia: o.diaMm, depth: 0, lift: o.endMm, spans: spans });
    }
    var total = pts.length;
    if (!holes.length) {
      return refuse(total === 1 ? 'the hole misses the piece' :
        'all ' + total + ' holes fall off the face - nothing is left to punch',
        { dropped: dropped.length, droppedHoles: dropped, droppedAt: droppedAt, frame: { o: p0, u: u, v: v, n: n0 }, wouldBe: [] });
    }

    // depth, and the skin under a blind hole
    var viol = [];
    holes.forEach(function (H) {
      if (o.depth === 'through') { H.depth = H.spans[H.spans.length - 1].s1 + 2 * o.endMm; return; }
      var d = +o.depth, kept = [];
      H.depth = d + o.endMm;
      H.spans.forEach(function (S) {
        if (S.s0 >= d) return;
        if (S.s1 > d) {
          var skin = S.s1 - d;
          if (skin < floor) viol.push({ kind: 'skin', wall: skin, holes: [H.n],
            text: 'hole ' + H.n + ' would leave a ' + fmt(skin, floor) + ' mm skin under it' });
          kept.push({ s0: S.s0, s1: d, inTri: S.inTri, outTri: -1 });
        } else kept.push(S);
      });
      H.spans = kept;
    });

    // wall to the piece's edge, where each span goes in and comes out
    holes.forEach(function (H) {
      var worst = Infinity;
      H.spans.forEach(function (S) {
        [[S.s0, S.inTri], [S.s1, S.outTri]].forEach(function (e) {
          if (e[1] < 0) return;
          var w = distToRim(M, M.region[e[1]], sub(H.centre, mul(H.axis, e[0]))) - r;
          if (w < worst) worst = w;
        });
      });
      if (worst < floor) viol.push({ kind: 'edge', wall: worst, holes: [H.n],
        text: worst < 0 ? 'hole ' + H.n + ' would break through the piece\'s edge' :
              'hole ' + H.n + ' would leave ' + fmt(worst, floor) + ' mm of wall to the piece\'s edge' });
    });

    // wall to each neighbour, over the stretches both are in material
    var segs = holes.map(function (H) {
      return H.spans.map(function (S) {
        var a = sub(H.centre, mul(H.axis, S.s0)), b = sub(H.centre, mul(H.axis, S.s1));
        return { a: a, b: b, mid: mul(add(a, b), 0.5), half: (S.s1 - S.s0) / 2 };
      });
    });
    for (var x = 0; x < holes.length; x++) for (var y = x + 1; y < holes.length; y++) {
      var w = Infinity;
      segs[x].forEach(function (A) {
        segs[y].forEach(function (B) {
          if (len(sub(A.mid, B.mid)) - A.half - B.half - 2 * r >= Math.min(w, floor)) return;
          w = Math.min(w, segDist(A.a, A.b, B.a, B.b) - 2 * r);
        });
      });
      if (w < floor) viol.push({ kind: 'between', wall: w, holes: [holes[x].n, holes[y].n],
        text: w < 0 ? 'holes ' + holes[x].n + ' and ' + holes[y].n + ' would run into each other' :
              'holes ' + holes[x].n + ' and ' + holes[y].n + ' would leave ' + fmt(w, floor) + ' mm between them' });
    }
    var frame = { o: p0, u: u, v: v, n: n0 };
    if (viol.length) {
      viol.sort(function (a, b) { return a.wall - b.wall; });
      var more = viol.length - 1;
      return refuse(viol[0].text + '; the floor is ' + fmt(floor) + (more ? ' (' + plural(more, 'more place is', 'more places are') + ' under it too)' : ''),
        { violations: viol, floor: floor, frame: frame, dropped: dropped.length, droppedHoles: dropped, droppedAt: droppedAt, wouldBe: holes });
    }
    var what = plural(holes.length, 'hole', 'holes') + ' Ø' + fmt(o.diaMm) + ' ' +
               (o.depth === 'through' ? 'through' : fmt(+o.depth) + ' mm deep');
    var reason = dropped.length ?
      plural(dropped.length, 'hole', 'holes') + ' of ' + total + ' fall off the face and ' + (dropped.length === 1 ? 'was' : 'were') +
      ' dropped (' + dropped.join(', ') + '); punching ' + what : 'punching ' + what;
    return { ok: true, holes: holes, reason: reason, dropped: dropped.length, droppedHoles: dropped, droppedAt: droppedAt,
             floor: floor, frame: frame };
  }

  /* ----------------------------------------------------------- cutters */
  /* 48 sides at Ø6 and up, 8 per mm of diameter below that, never under 16. */
  function sidesFor(dia) { return Math.max(16, Math.min(48, 8 * Math.ceil(dia - 1e-9))); }

  /* One closed cylinder soup per hole, wound outward, from centre + lift *
     axis to depth mm along -axis. The flats sit at dia / 2. */
  function cutters(pl) {
    var holes = (pl && pl.holes) || [];
    return holes.map(function (H) {
      var a = unit(H.axis), m = sidesFor(H.dia), rv = H.dia / 2 / Math.cos(Math.PI / m);
      var e1 = unit(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0])), e2 = cross(a, e1);
      var P0 = add(H.centre, mul(a, H.lift == null ? DEFAULTS.endMm : H.lift)), P1 = sub(P0, mul(a, H.depth));
      var top = [], bot = [], k;
      for (k = 0; k < m; k++) {
        var th = 2 * Math.PI * k / m, rad = add(mul(e1, rv * Math.cos(th)), mul(e2, rv * Math.sin(th)));
        top.push(add(P0, rad)); bot.push(add(P1, rad));
      }
      var out = new Float32Array(m * 4 * 9), q = 0;
      function tri(A, B, C) { out.set(A, q); out.set(B, q + 3); out.set(C, q + 6); q += 9; }
      for (k = 0; k < m; k++) {
        var k1 = (k + 1) % m;
        tri(P0, top[k], top[k1]);
        tri(P1, bot[k1], bot[k]);
        tri(top[k], bot[k], bot[k1]);
        tri(top[k], bot[k1], top[k1]);
      }
      return out;
    });
  }

  /* Slide the click dx along u and dy along v, on its own surface: the hit a
     nudge or a drag of the anchor moves to - { ok, point, normal, tri } or
     { ok: false, reason } (it would leave the face; the click stays). */
  function slide(soup, hit, dx, dy, opts) {
    var o = optsOf(opts);
    if (!soup || soup.length < 36 || soup.length % 9) return { ok: false, reason: 'there is no piece to punch' };
    var F = frameOf(soup, hit, o);
    if (F.reason) return { ok: false, reason: F.reason };
    var ft = footOf(F.M, F.R0, F.n0, add(F.p0, add(mul(F.u, dx), mul(F.v, dy))));
    return ft ? { ok: true, point: ft.point, normal: ft.normal, tri: ft.tri } : { ok: false, reason: 'that is off the face' };
  }

  /* The click's smooth surface as a probe, for Text (nso_text.js): the frame
     (o the click on the surface, n its smooth normal, u and v as plan's), foot(p)
     for a tangent-plane point's footprint - { point, normal, tri } or null -
     thickness(c, axis) for the first stretch of material under c along -axis,
     and flat: every facet of the click's surface within planarDeg of n. */
  function surface(soup, hit, opts) {
    var o = optsOf(opts);
    if (!soup || soup.length < 36 || soup.length % 9) return { ok: false, reason: 'there is no piece to stamp' };
    var F = frameOf(soup, hit, o);
    if (F.reason) return { ok: false, reason: F.reason };
    var M = F.M, cosP = Math.cos(o.planarDeg * Math.PI / 180), flat = true;
    for (var t = 0; t < M.n && flat; t++) {
      if (M.region[t] === F.R0 && dot(triN(M, t), F.n0) < cosP) flat = false;
    }
    return {
      ok: true, o: F.p0, n: F.n0, u: F.u, v: F.v, flat: flat, diag: M.diag,
      foot: function (p) { return footOf(M, F.R0, F.n0, p); },
      thickness: function (c, axis) { var sp = spansFrom(M, c, axis); return sp ? sp[0].s1 : null; }
    };
  }

  /* Do any two of the plan's cutters meet (in air, past the material - through
     holes crossing a tube's bore)? Then they are unioned before the subtract;
     otherwise they go to the kernel as one soup of separate shells. */
  function cuttersOverlap(pl) {
    var holes = (pl && pl.holes) || [];
    var seg = holes.map(function (H) {
      var m = sidesFor(H.dia), a = unit(H.axis), P0 = add(H.centre, mul(a, H.lift == null ? DEFAULTS.endMm : H.lift));
      return { a: P0, b: sub(P0, mul(a, H.depth)), r: H.dia / 2 / Math.cos(Math.PI / m) };
    });
    for (var i = 0; i < seg.length; i++) for (var j = i + 1; j < seg.length; j++) {
      if (segDist(seg[i].a, seg[i].b, seg[j].a, seg[j].b) < seg[i].r + seg[j].r + 1e-6) return true;
    }
    return false;
  }

  var API = {
    DEFAULTS: DEFAULTS,
    plan: plan,
    cutters: cutters,
    slide: slide,
    surface: surface,
    cuttersOverlap: cuttersOverlap,
    sidesFor: sidesFor,
    _smoothNormal: function (soup, t, p, smoothDeg) { return smoothNormal(meshOf(soup, smoothDeg || DEFAULTS.smoothDeg), t, p); }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Punch = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
