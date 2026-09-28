/* nso_face_features.js - find a handle, a bracket, a lid or a hinge on a
   closed triangle soup, and lift each out as its own closed solid.

   Loads as a classic script (window.NSO_FaceFeatures) and as a Node module
   (require('../nso_face_features.js')). No DOM, no Three.js: a mesh is the
   app's raw soup (9 numbers per triangle, Z up, millimetres).

   READ docs/GSCOPE-FEATURES.md FIRST - it has the four rules, the numbers
   they were validated on (tools/nso_face_features_test.js, against the ground
   truth tools/nso_features.js declares), and what each deliberately does not
   find. The flange has its own module and page (nso_flange.js,
   docs/GSCOPE-FLANGE.md); this one follows its shape: a named rule, every
   clause a worded refusal, every candidate kept with the clauses it failed.

   ---------------------------------------------------------------------------
   WHAT THE FOUR SHARE: a protrusion off a face
   ---------------------------------------------------------------------------
   A handle, a bracket, a lid and a hinge are all something fused onto a flat
   face of a body. Where they are fused, the face has a HOLE in it: the face's
   own triangles stop at a loop, and across that loop is the feature. So:

   1. Faces. Triangles are grown into flat regions (every vertex within a
      whisker of the seed's plane, the normal within 1 degree).
   2. Roots. A region's boundary is chained into loops. Its outer loop runs
      one way round; a loop running the other way is a hole in the face -
      a place where something meets it. Those are the ROOT LOOPS.
   3. Protrusions. From a root loop, the surface on the far side is flooded
      without ever entering the face. What that flood holds is one thing
      standing on the face, and the root loops it comes back to are every
      place it meets the face. It must close on this face's root loops alone
      (never the face's outer edge, never an open edge), and lie wholly on
      the face's outer side - a pocket or a bore goes the other way and is
      not a protrusion.
   4. Its solid. The flood plus one cap per root loop (the loop's own
      vertices, ear-clipped, facing into the body) is a closed solid: the
      feature, exactly, with nothing cut and no vertex moved. A root's area
      is its cap's area.
   5. Shells. The soup's closed shells, with their signed volume and Euler
      characteristic: the host, the voids (negative), any second body.

   Every protrusion is a candidate for every rule. Each rule's clauses run in
   order (one that fails skips the ones that depend on it) and every failure
   is kept, so "why not a handle here?" always has an answer in words (WHY).

   ---------------------------------------------------------------------------
   THE FOUR RULES
   ---------------------------------------------------------------------------
   HANDLE   a rod that closes a through-opening with its face.
     feet      it meets the face at exactly two places
     round     both are round (radial RMS <= 5 % of r), and the same size (10 %)
     closed    straight out from between the feet, a ray meets the rod
     opening   ...after at least the rod's own width of air (2r): a hand fits
     rod       ...and the grip it meets is the same rod (2r across, to 15 %)

   BRACKET  a plate fused flat on the face, an arm square to it, braced.
     root      it meets the face at exactly one place
     plate     the solid over the root is one thickness t over most of it
               (>= 50 %), never thinner (>= 0.9 t anywhere), and the root is a
               plate's footprint, at least 4t across both ways - not a line
     arm       a strip of it runs out >= 3t: one uniform arm, about t wide
               (<= 1.5t + a sample), >= 4t long, along the plate's edge
     braced    beside the arm, at least one gusset: a region whose height over
               the plate falls off in a straight line with distance from the
               arm (R^2 >= 0.95, falling). Without it the arm is a flange by
               nso_flange.js's rule, and this says so.

   LID      a cover seated on a ring round an opening, locating by a plug.
     root      it meets the face at exactly one place
     void      under it, the soup has an enclosed void that reaches up to the
               face inside the root: the pocket it closes
     plug      where the void meets the face it is a ring, round a plug that
               drops into the pocket (the void wraps its sides and bottom)
     seat      the pocket's opening lies inside the root with a rim all round:
               the lid meets the hull on a ring, and only there
     free      the void is one genus-0 shell: the plug stops short of the
               floor (a plug down on the floor makes the void a ring)

   HINGE    fixed knuckles on two webs, a second body captive on their pin.
     webs      the fixed part meets the face at exactly two places
     body      a second body (a separate closed shell, positive volume) is
               tangled with it
     bored     that body has one through-hole (genus 1): something to turn on
     captive   cut square to the line through the webs, at the body's middle,
               the fixed part's section (the pin) lies inside the body's hole
     axial     along that line, both ways, the fixed part is there within one
               knuckle radius: fixed knuckles on both sides hold it on the pin
     free      it clears the pin all round (> 0) and both fixed knuckles

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   analyse(soup)            -> the shared analysis (faces, protrusions, shells)
   detect(soup, only)       -> { handle, bracket, lid, hinge, ms, protrusions }
                               each { found: [...], candidates: [...], reason }
                               `only` is an optional list of rule names
   describe(result, type)   -> one status line
   RULES, WHY               -> rule names; each clause's failure in words
*/
(function (root) {
  'use strict';

  var RULES = ['handle', 'bracket', 'lid', 'hinge'];
  var PLANE_COS = Math.cos(1 * Math.PI / 180);

  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function vadd(a, b, s) { s = s == null ? 1 : s; return [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function len(a) { return Math.hypot(a[0], a[1], a[2]); }
  function norm(a) { var l = len(a); return l ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; }
  function clean(a) { return norm(a.map(function (x) { return Math.abs(x) < 1e-9 ? 0 : x; })); }
  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (x, y) { return x - y; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function fmt(x, d) { var p = Math.pow(10, d == null ? 2 : d); return (Math.round(x * p) / p).toString(); }

  /** An in-plane frame (e1, e2) with e1 x e2 = n. */
  function planeFrame(n) {
    var ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    var e1 = norm(cross(ref, n));
    // Prefer an axis-aligned e1 when n is axis-aligned, so reports read in X / Y / Z.
    e1 = clean(e1);
    var e2 = clean(cross(n, e1));
    return { e1: e1, e2: e2, n: n };
  }

  // -------------------------------------------------------------------------
  // The shared analysis
  // -------------------------------------------------------------------------

  function analyse(soup) {
    var nt = Math.floor(soup.length / 9);
    var A = { soup: soup, nt: nt, V: [], tv: new Int32Array(nt * 3), faces: [], protrusions: [], shells: [],
              scale: 0, eps: 0 };
    // Weld: exact to 1e-4 mm, as nso_flange.js's components() does.
    var key = new Map(), V = A.V, q = 1e4;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var t = 0; t < nt; t++) {
      for (var k = 0; k < 3; k++) {
        var o = t * 9 + k * 3;
        var x = soup[o], y = soup[o + 1], z = soup[o + 2];
        var kk = Math.round(x * q) + ',' + Math.round(y * q) + ',' + Math.round(z * q);
        var id = key.get(kk);
        if (id == null) { id = V.length; key.set(kk, id); V.push([x, y, z]); }
        A.tv[t * 3 + k] = id;
        if (x < lo[0]) lo[0] = x; if (x > hi[0]) hi[0] = x;
        if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y;
        if (z < lo[2]) lo[2] = z; if (z > hi[2]) hi[2] = z;
      }
    }
    A.bounds = { lo: lo, hi: hi };
    A.scale = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
    A.eps = 2e-4 + 2e-6 * A.scale;               // "on the plane"
    // Directed edges -> triangle. The twin of a->b is b->a.
    var dir = new Map();
    function ek(a, b) { return a * 4294967296 + b; }
    var bad = 0;
    for (t = 0; t < nt; t++) {
      for (k = 0; k < 3; k++) {
        var a = A.tv[t * 3 + k], b = A.tv[t * 3 + (k + 1) % 3];
        if (a === b) continue;
        var e = ek(a, b);
        if (dir.has(e)) { dir.set(e, -1); bad++; } else dir.set(e, t);
      }
    }
    A.dir = dir;
    A.ek = ek;
    A.twin = function (t, k) {
      var a = A.tv[t * 3 + k], b = A.tv[t * 3 + (k + 1) % 3];
      var r = dir.get(ek(b, a));
      return r == null ? -1 : r;
    };
    A.badEdges = bad;
    // Triangle planes.
    A.n = new Float64Array(nt * 3); A.d = new Float64Array(nt); A.area = new Float64Array(nt);
    for (t = 0; t < nt; t++) {
      var p0 = V[A.tv[t * 3]], p1 = V[A.tv[t * 3 + 1]], p2 = V[A.tv[t * 3 + 2]];
      var c = cross(vsub(p1, p0), vsub(p2, p0)), l = len(c);
      A.area[t] = l / 2;
      if (l > 0) { A.n[t * 3] = c[0] / l; A.n[t * 3 + 1] = c[1] / l; A.n[t * 3 + 2] = c[2] / l; A.d[t] = dot(p0, [c[0] / l, c[1] / l, c[2] / l]); }
    }
    shells(A);
    faces(A);
    A.faces.forEach(function (F) { protrusionsOn(A, F); });
    return A;
  }

  function triN(A, t) { return [A.n[t * 3], A.n[t * 3 + 1], A.n[t * 3 + 2]]; }

  /** Closed shells: edge-connected components, with volume, area, chi. */
  function shells(A) {
    var nt = A.nt, comp = new Int32Array(nt).fill(-1);
    for (var s = 0; s < nt; s++) {
      if (comp[s] >= 0) continue;
      var id = A.shells.length, list = [s];
      comp[s] = id;
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        for (var k = 0; k < 3; k++) {
          var u = A.twin(t, k);
          if (u >= 0 && comp[u] < 0) { comp[u] = id; list.push(u); }
        }
      }
      var verts = new Set(), open = 0, vol = 0, area = 0;
      list.forEach(function (t) {
        for (var k = 0; k < 3; k++) { verts.add(A.tv[t * 3 + k]); if (A.twin(t, k) < 0) open++; }
        var p0 = A.V[A.tv[t * 3]], p1 = A.V[A.tv[t * 3 + 1]], p2 = A.V[A.tv[t * 3 + 2]];
        vol += dot(p0, cross(p1, p2)) / 6;
        area += A.area[t];
      });
      // Closed and manifold: E = 3F / 2.
      A.shells.push({ id: id, tris: list, volume: vol, area: area, closed: open === 0,
                      chi: verts.size - 1.5 * list.length + list.length,
                      bounds: triBounds(A, list) });
    }
    A.shellOf = comp;
  }

  function triBounds(A, tris) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    tris.forEach(function (t) {
      for (var k = 0; k < 3; k++) {
        var p = A.V[A.tv[t * 3 + k]];
        for (var i = 0; i < 3; i++) { if (p[i] < lo[i]) lo[i] = p[i]; if (p[i] > hi[i]) hi[i] = p[i]; }
      }
    });
    return { lo: lo, hi: hi };
  }

  /** Flat regions, and the loops round each. */
  function faces(A) {
    var nt = A.nt, reg = new Int32Array(nt).fill(-1);
    A.faceOf = reg;
    for (var s = 0; s < nt; s++) {
      if (reg[s] >= 0 || !(A.area[s] > 0)) continue;
      var n = triN(A, s), d = A.d[s], id = A.faces.length, list = [s];
      reg[s] = id;
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        for (var k = 0; k < 3; k++) {
          var u = A.twin(t, k);
          if (u < 0 || reg[u] >= 0 || !(A.area[u] > 0)) continue;
          if (dot(triN(A, u), n) < PLANE_COS) continue;
          var on = true;
          for (var j = 0; j < 3; j++) if (Math.abs(dot(A.V[A.tv[u * 3 + j]], n) - d) > A.eps) { on = false; break; }
          if (!on) continue;
          reg[u] = id; list.push(u);
        }
      }
      A.faces.push({ id: id, n: n, d: d, tris: list, loops: null });
    }
    // Only a region with a hole in it can carry a feature, and a region with
    // a hole has at least 4 triangles: chain the loops of those.
    A.faces.forEach(function (F) {
      if (F.tris.length < 4) { F.loops = []; return; }
      F.loops = loopsOf(A, F);
    });
  }

  /** A region's boundary loops, in the region's own winding. */
  function loopsOf(A, F) {
    var inF = function (t) { return t >= 0 && A.faceOf[t] === F.id; };
    var next = new Map();       // a -> [b...]
    var edgeCount = 0;
    F.tris.forEach(function (t) {
      for (var k = 0; k < 3; k++) {
        if (inF(A.twin(t, k))) continue;
        var a = A.tv[t * 3 + k], b = A.tv[t * 3 + (k + 1) % 3];
        if (!next.has(a)) next.set(a, []);
        next.get(a).push(b);
        edgeCount++;
      }
    });
    if (!edgeCount) return [];
    var fr = planeFrame(F.n), loops = [];
    var used = new Set();
    next.forEach(function (bs, a0) {
      bs.forEach(function (b0) {
        var e0 = a0 + '>' + b0;
        if (used.has(e0)) return;
        var verts = [a0], a = a0, b = b0, ok = true, guard = 0;
        used.add(e0);
        while (b !== a0) {
          verts.push(b);
          var cand = (next.get(b) || []).filter(function (c) { return !used.has(b + '>' + c); });
          if (!cand.length || ++guard > edgeCount) { ok = false; break; }
          used.add(b + '>' + cand[0]);
          a = b; b = cand[0];
        }
        if (!ok) return;
        var P = verts.map(function (v) { var p = A.V[v]; return [dot(p, fr.e1), dot(p, fr.e2)]; });
        loops.push({ verts: verts, area2: area2(P), P: P });
      });
    });
    loops.forEach(function (L, i) { L.id = i; L.inner = L.area2 < 0; });
    return loops;
  }

  function area2(P) {
    var s = 0;
    for (var i = 0; i < P.length; i++) { var a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return s / 2;
  }

  /**
   * Every protrusion standing on face F: flood from each root loop.
   * `A.protrusions` gets { face, loops, tris, outside, ... } for each.
   */
  function protrusionsOn(A, F) {
    var inner = F.loops.filter(function (L) { return L.inner; });
    if (!inner.length) return;
    // Which root loop each boundary edge (directed as the region has it) is on.
    var loopOfEdge = new Map();
    F.loops.forEach(function (L) {
      for (var i = 0; i < L.verts.length; i++) loopOfEdge.set(A.ek(L.verts[i], L.verts[(i + 1) % L.verts.length]), L);
    });
    var done = new Set();
    var cap = Math.max(2000, Math.floor(0.6 * A.nt));
    inner.forEach(function (L0) {
      if (done.has(L0.id)) return;
      // Seeds: across the loop's edges.
      var seeds = [];
      for (var i = 0; i < L0.verts.length; i++) {
        var t = A.dir.get(A.ek(L0.verts[(i + 1) % L0.verts.length], L0.verts[i]));
        if (t != null && t >= 0) seeds.push(t);
      }
      if (!seeds.length) return;
      var inP = new Set(seeds), list = seeds.slice(), loops = new Set([L0.id]), leak = '';
      for (var j = 0; j < list.length && !leak; j++) {
        var tt = list[j];
        for (var k = 0; k < 3; k++) {
          var u = A.twin(tt, k);
          if (u < 0) { leak = 'open'; break; }
          if (A.faceOf[u] === F.id) {
            var a = A.tv[tt * 3 + k], b = A.tv[tt * 3 + (k + 1) % 3];
            var Lx = loopOfEdge.get(A.ek(b, a));
            if (!Lx || !Lx.inner) { leak = 'edge'; break; }
            loops.add(Lx.id);
            continue;
          }
          if (inP.has(u)) continue;
          inP.add(u); list.push(u);
        }
        if (list.length > cap) leak = 'body';
      }
      loops.forEach(function (id) { done.add(id); });
      if (leak) return;               // not something standing on this face
      // Wholly on the outer side?
      var minW = Infinity, maxW = -Infinity;
      list.forEach(function (t) {
        for (var k = 0; k < 3; k++) {
          var w = dot(A.V[A.tv[t * 3 + k]], F.n) - F.d;
          if (w < minW) minW = w; if (w > maxW) maxW = w;
        }
      });
      if (minW < -A.eps || maxW < 10 * A.eps) return;     // a recess, not a protrusion
      var Ls = Array.from(loops).map(function (id) { return F.loops[id]; });
      var P = { id: A.protrusions.length, face: F, n: F.n, d: F.d, loops: Ls, tris: list, height: maxW };
      finishProtrusion(A, P);
      A.protrusions.push(P);
    });
  }

  function finishProtrusion(A, P) {
    var fr = planeFrame(P.n);
    P.frame = fr;
    P.loops = P.loops.map(function (L) {
      var c2 = [0, 0];
      L.P.forEach(function (p) { c2[0] += p[0]; c2[1] += p[1]; });
      c2 = [c2[0] / L.P.length, c2[1] / L.P.length];
      var rs = L.P.map(function (p) { return Math.hypot(p[0] - c2[0], p[1] - c2[1]); });
      var r = rs.reduce(function (s, x) { return s + x; }, 0) / rs.length;
      var rms = Math.sqrt(rs.reduce(function (s, x) { return s + (x - r) * (x - r); }, 0) / rs.length);
      // In-plane extents along the loop's own principal axes.
      var sxx = 0, sxy = 0, syy = 0;
      L.P.forEach(function (p) { var dx = p[0] - c2[0], dy = p[1] - c2[1]; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; });
      var ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), a1 = [Math.cos(ang), Math.sin(ang)], a2 = [-a1[1], a1[0]];
      var ext = [[Infinity, -Infinity], [Infinity, -Infinity]];
      L.P.forEach(function (p) {
        var x = (p[0] - c2[0]) * a1[0] + (p[1] - c2[1]) * a1[1], y = (p[0] - c2[0]) * a2[0] + (p[1] - c2[1]) * a2[1];
        ext[0][0] = Math.min(ext[0][0], x); ext[0][1] = Math.max(ext[0][1], x);
        ext[1][0] = Math.min(ext[1][0], y); ext[1][1] = Math.max(ext[1][1], y);
      });
      return { id: L.id, verts: L.verts, P: L.P, area: Math.abs(L.area2), c2: c2,
               centre: to3(fr, c2, P.d), radius: r, roundness: r > 0 ? rms / r : 1,
               fill: r > 0 ? Math.abs(L.area2) / (Math.PI * r * r) : 0,
               extents: [ext[0][1] - ext[0][0], ext[1][1] - ext[1][0]].sort(function (x, y) { return y - x; }) };
    });
    P.rootArea = P.loops.reduce(function (s, L) { return s + L.area; }, 0);
    P.bounds = triBounds(A, P.tris);
  }

  function to3(fr, p2, w) {
    return [p2[0] * fr.e1[0] + p2[1] * fr.e2[0] + w * fr.n[0],
            p2[0] * fr.e1[1] + p2[1] * fr.e2[1] + w * fr.n[1],
            p2[0] * fr.e1[2] + p2[1] * fr.e2[2] + w * fr.n[2]];
  }

  // -------------------------------------------------------------------------
  // Caps: a loop (with holes), ear-clipped on its own vertices
  // -------------------------------------------------------------------------

  /**
   * Triangulate a polygon given as 2D points in a frame where it runs
   * counter-clockwise, with holes running clockwise. Returns index triples
   * into the concatenated [outer, ...holes] point list, counter-clockwise.
   * Holes are bridged to the outer loop, then ears are clipped. Nothing is
   * added or moved: the cap closes on exactly the loop's own vertices.
   */
  function triangulate(outer, holes) {
    var pts = outer.slice(), idx = outer.map(function (_, i) { return i; });
    (holes || []).slice().sort(function (a, b) {
      return Math.max.apply(null, b.map(function (p) { return p[0]; })) - Math.max.apply(null, a.map(function (p) { return p[0]; }));
    }).forEach(function (H) {
      var base = pts.length;
      H.forEach(function (p) { pts.push(p); });
      // The hole's rightmost vertex, bridged to the nearest visible vertex of the ring so far.
      var hi = 0;
      for (var i = 1; i < H.length; i++) if (H[i][0] > H[hi][0]) hi = i;
      var hp = H[hi], best = -1, bestD = Infinity;
      for (var j = 0; j < idx.length; j++) {
        var p = pts[idx[j]];
        var dd = (p[0] - hp[0]) * (p[0] - hp[0]) + (p[1] - hp[1]) * (p[1] - hp[1]);
        if (dd >= bestD) continue;
        if (!visible(pts, idx, hp, p, idx[j])) continue;
        best = j; bestD = dd;
      }
      if (best < 0) throw new Error('a hole in a cap could not be bridged');
      var ring = [];
      for (i = 0; i <= H.length; i++) ring.push(base + (hi + i) % H.length);
      idx = idx.slice(0, best + 1).concat(ring).concat([idx[best]]).concat(idx.slice(best + 1));
    });
    var out = [], guard = 0;
    var cur = idx.slice();
    while (cur.length > 3 && guard++ < 100000) {
      var clipped = false;
      for (var pass = 0; pass < 2 && !clipped; pass++) {
        for (var i = 0; i < cur.length; i++) {
          var ia = cur[(i + cur.length - 1) % cur.length], ib = cur[i], ic = cur[(i + 1) % cur.length];
          var a = pts[ia], b = pts[ib], c = pts[ic];
          var cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
          if (pass === 0 ? !(cr > 1e-12) : !(cr >= -1e-12)) continue;
          var inside = false;
          for (var m = 0; m < cur.length && !inside; m++) {
            var im = cur[m];
            if (im === ia || im === ib || im === ic) continue;
            var p = pts[im];
            if (p[0] === a[0] && p[1] === a[1] || p[0] === b[0] && p[1] === b[1] || p[0] === c[0] && p[1] === c[1]) continue;
            if (inTri(p, a, b, c)) inside = true;
          }
          if (inside) continue;
          if (cr > 1e-12) out.push([ia, ib, ic]);
          cur.splice(i, 1);
          clipped = true;
          break;
        }
      }
      if (!clipped) throw new Error('a cap could not be triangulated');
    }
    if (cur.length === 3) {
      var a3 = pts[cur[0]], b3 = pts[cur[1]], c3 = pts[cur[2]];
      if ((b3[0] - a3[0]) * (c3[1] - a3[1]) - (b3[1] - a3[1]) * (c3[0] - a3[0]) > 1e-12) out.push(cur.slice());
    }
    return { pts: pts, tris: out };
  }
  function inTri(p, a, b, c) {
    var d1 = (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
    var d2 = (p[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (p[1] - c[1]);
    var d3 = (p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1]);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  }
  function segX(p, q, a, b) {
    function o(u, v, w) { return (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]); }
    var d1 = o(p, q, a), d2 = o(p, q, b), d3 = o(a, b, p), d4 = o(a, b, q);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }
  function visible(pts, idx, p, q) {
    for (var i = 0; i < idx.length; i++) {
      var a = pts[idx[i]], b = pts[idx[(i + 1) % idx.length]];
      if (segX(p, q, a, b)) return false;
    }
    return true;
  }

  /**
   * Cap triangles (world, 9 floats each) closing loops that lie in the plane
   * of `fr` at offset w, facing `facing` (+1 along fr.n, -1 against it).
   * `outer` is one loop of vertex ids, `holes` more; any winding.
   */
  function capSoup(A, fr, outer, holes, facing) {
    // Work in a 2D frame whose "up" is the cap's normal.
    var e1 = fr.e1, e2 = facing > 0 ? fr.e2 : [-fr.e2[0], -fr.e2[1], -fr.e2[2]];
    function P2(ids) { return ids.map(function (v) { var p = A.V[v]; return [dot(p, e1), dot(p, e2)]; }); }
    var O = outer.slice(), op = P2(O);
    if (area2(op) < 0) { O.reverse(); op.reverse(); }
    var Hs = (holes || []).map(function (h) {
      var H = h.slice(), hp = P2(H);
      if (area2(hp) > 0) { H.reverse(); hp.reverse(); }
      return { ids: H, p: hp };
    });
    var T = triangulate(op, Hs.map(function (h) { return h.p; }));
    var ids = O.concat.apply(O, Hs.map(function (h) { return h.ids; }));
    var out = [];
    T.tris.forEach(function (tr) {
      tr.forEach(function (i) { var p = A.V[ids[i]]; out.push(p[0], p[1], p[2]); });
    });
    return out;
  }

  function trisSoup(A, tris) {
    var out = new Array(tris.length * 9);
    tris.forEach(function (t, i) {
      for (var k = 0; k < 3; k++) {
        var p = A.V[A.tv[t * 3 + k]];
        out[i * 9 + k * 3] = p[0]; out[i * 9 + k * 3 + 1] = p[1]; out[i * 9 + k * 3 + 2] = p[2];
      }
    });
    return out;
  }

  /** A protrusion as a closed solid: its surface plus a cap on every root loop, facing into the body. */
  function protrusionSolid(A, P) {
    if (P.solid) return P.solid;
    var out = trisSoup(A, P.tris);
    P.loops.forEach(function (L) { out = out.concat(capSoup(A, P.frame, L.verts, [], -1)); });
    P.solid = out;
    return out;
  }

  function soupVolume(s) {
    var v = 0;
    for (var i = 0; i + 8 < s.length; i += 9) {
      v += (s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) +
            s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6])) / 6;
    }
    return v;
  }
  function soupBounds(s) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < s.length; i++) { var k = i % 3; if (s[i] < lo[k]) lo[k] = s[i]; if (s[i] > hi[k]) hi[k] = s[i]; }
    return { lo: lo, hi: hi };
  }

  // -------------------------------------------------------------------------
  // Rays and sections
  // -------------------------------------------------------------------------

  /** Every crossing of the ray O + s D with `tris`, as [s, +1 entry | -1 exit], sorted. */
  function rayHits(A, tris, O, D) {
    var hits = [];
    for (var i = 0; i < tris.length; i++) {
      var t = tris[i];
      var a0 = A.V[A.tv[t * 3]], a1 = A.V[A.tv[t * 3 + 1]], a2 = A.V[A.tv[t * 3 + 2]];
      var E1 = vsub(a1, a0), E2 = vsub(a2, a0);
      var Pv = cross(D, E2), det = dot(E1, Pv);
      if (Math.abs(det) < 1e-14) continue;
      var T = vsub(O, a0), uu = dot(T, Pv) / det;
      if (uu < 0 || uu > 1) continue;
      var Q = cross(T, E1), vv = dot(D, Q) / det;
      if (vv < 0 || uu + vv > 1) continue;
      var dist = dot(E2, Q) / det;
      if (dist <= 0) continue;
      hits.push([dist, det > 0 ? 1 : -1]);
    }
    hits.sort(function (x, y) { return x[0] - y[0]; });
    var out = [], lastD = -1, lastS = 0;
    hits.forEach(function (h) {
      if (h[1] === lastS && h[0] - lastD < 1e-6) return;
      lastD = h[0]; lastS = h[1];
      out.push(h);
    });
    return out;
  }
  function firstHit(A, tris, O, D, sign) {
    var h = rayHits(A, tris, O, D);
    for (var i = 0; i < h.length; i++) if (!sign || h[i][1] === sign) return h[i][0];
    return null;
  }

  /**
   * The section of a closed set of triangles by the plane x.N = w, as closed
   * 2D loops in frame fr (points keyed by the edge they cross, so a closed
   * surface gives closed loops). Returns null if a loop does not close.
   */
  function section(A, tris, N, w, fr) {
    var seg = new Map();   // pointKey -> [pointKey...]
    var pt = new Map();
    function crossing(a, b) {
      var k = a < b ? a + '_' + b : b + '_' + a;
      if (!pt.has(k)) {
        var pa = A.V[a], pb = A.V[b], da = dot(pa, N) - w, db = dot(pb, N) - w, s = da / (da - db);
        var p = [pa[0] + s * (pb[0] - pa[0]), pa[1] + s * (pb[1] - pa[1]), pa[2] + s * (pb[2] - pa[2])];
        pt.set(k, [dot(p, fr.e1), dot(p, fr.e2)]);
      }
      return k;
    }
    tris.forEach(function (t) {
      var v = [A.tv[t * 3], A.tv[t * 3 + 1], A.tv[t * 3 + 2]];
      var s = v.map(function (i) { return dot(A.V[i], N) - w > 0; });
      if (s[0] === s[1] && s[1] === s[2]) return;
      var ks = [];
      for (var k = 0; k < 3; k++) if (s[k] !== s[(k + 1) % 3]) ks.push(crossing(v[k], v[(k + 1) % 3]));
      if (ks.length !== 2) return;
      if (!seg.has(ks[0])) seg.set(ks[0], []);
      if (!seg.has(ks[1])) seg.set(ks[1], []);
      seg.get(ks[0]).push(ks[1]); seg.get(ks[1]).push(ks[0]);
    });
    var seen = new Set(), loops = [];
    var ok = true;
    seg.forEach(function (_, k0) {
      if (seen.has(k0) || !ok) return;
      var loop = [k0], prev = null, cur = k0;
      seen.add(k0);
      for (;;) {
        var nb = seg.get(cur);
        if (!nb || nb.length !== 2) { ok = false; return; }
        var nx = nb[0] === prev ? nb[1] : nb[0];
        if (nx === k0) break;
        if (seen.has(nx)) { ok = false; return; }
        seen.add(nx); loop.push(nx); prev = cur; cur = nx;
      }
      loops.push(loop.map(function (k) { return pt.get(k); }));
    });
    return ok ? loops : null;
  }
  function pointInPoly(p, P) {
    var inside = false;
    for (var i = 0, j = P.length - 1; i < P.length; j = i++) {
      if ((P[i][1] > p[1]) !== (P[j][1] > p[1]) &&
          p[0] < (P[j][0] - P[i][0]) * (p[1] - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) inside = !inside;
    }
    return inside;
  }
  function segDist(p, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    var s = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - a[0] - s * dx, p[1] - a[1] - s * dy);
  }
  /** Least distance between two closed 2D polylines. */
  function loopDist(P, Q) {
    var best = Infinity, i, j;
    for (i = 0; i < P.length; i++) for (j = 0; j < Q.length; j++) best = Math.min(best, segDist(P[i], Q[j], Q[(j + 1) % Q.length]));
    for (j = 0; j < Q.length; j++) for (i = 0; i < P.length; i++) best = Math.min(best, segDist(Q[j], P[i], P[(i + 1) % P.length]));
    return best;
  }
  /** 2D ray from p along u against closed loops: sorted crossing distances. */
  function ray2(p, u, loops) {
    var out = [];
    loops.forEach(function (P) {
      for (var i = 0; i < P.length; i++) {
        var a = P[i], b = P[(i + 1) % P.length];
        var ex = b[0] - a[0], ey = b[1] - a[1];
        var den = u[0] * ey - u[1] * ex;
        if (Math.abs(den) < 1e-14) continue;
        var wx = a[0] - p[0], wy = a[1] - p[1];
        var s = (wx * ey - wy * ex) / den, r = (wx * u[1] - wy * u[0]) / den;
        if (s > 1e-9 && r >= 0 && r < 1) out.push(s);
      }
    });
    return out.sort(function (x, y) { return x - y; });
  }

  // -------------------------------------------------------------------------
  // HANDLE
  // -------------------------------------------------------------------------

  function judgeHandle(A, P) {
    var c = { rule: 'handle', protrusion: P.id, failed: [], measured: {} };
    var m = c.measured;
    m.feet = P.loops.length;
    if (P.loops.length !== 2) { c.failed.push('feet'); return c; }
    var f1 = P.loops[0], f2 = P.loops[1];
    m.footRadii = [f1.radius, f2.radius];
    m.roundness = Math.max(f1.roundness, f2.roundness);
    m.fill = Math.min(f1.fill, f2.fill);
    var r = (f1.radius + f2.radius) / 2;
    m.rodRadius = r;
    // Round: every vertex the same distance out, and the loop fills its
    // circle (an 8-gon fills 90 %; a 2:1 rectangle, whose corners are also
    // equidistant, fills 51 %).
    if (m.roundness > 0.05 || m.fill < 0.9 || Math.abs(f1.radius - f2.radius) > 0.1 * r) c.failed.push('round');
    var span = len(vsub(f2.centre, f1.centre));
    m.span = span;
    m.openingWidth = span - f1.radius - f2.radius;
    var mid = vadd(f1.centre, f2.centre); mid = [mid[0] / 2, mid[1] / 2, mid[2] / 2];
    var O = vadd(mid, P.n, 1e-3);
    var h = rayHits(A, P.tris, O, P.n);
    var entry = null, exit = null;
    for (var i = 0; i < h.length; i++) {
      if (entry === null && h[i][1] > 0) entry = h[i][0];
      else if (entry !== null && h[i][1] < 0) { exit = h[i][0]; break; }
    }
    if (entry === null || exit === null) { c.failed.push('closed'); return c; }
    m.clear = entry + 1e-3;
    m.grip = exit - entry;
    m.openingCentre = vadd(mid, P.n, m.clear / 2);
    m.loopNormal = canon(clean(cross(P.n, norm(vsub(f2.centre, f1.centre)))));
    if (m.clear < 2 * r) c.failed.push('opening');
    if (Math.abs(m.grip - 2 * r) > 0.15 * 2 * r) c.failed.push('rod');
    return c;
  }

  /** Canonical sign: the largest component positive. */
  function canon(d) {
    var big = Math.abs(d[0]) >= Math.abs(d[1]) && Math.abs(d[0]) >= Math.abs(d[2]) ? 0 : (Math.abs(d[1]) >= Math.abs(d[2]) ? 1 : 2);
    return d[big] < 0 ? [-d[0], -d[1], -d[2]] : d;
  }

  // -------------------------------------------------------------------------
  // BRACKET
  // -------------------------------------------------------------------------

  function judgeBracket(A, P) {
    var c = { rule: 'bracket', protrusion: P.id, failed: [], measured: {} };
    var m = c.measured;
    if (P.loops.length !== 1) { c.failed.push('root'); return c; }
    var L = P.loops[0], fr = P.frame;
    // Samples over the root, on a grid of at most ~4000.
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    L.P.forEach(function (p) { lo[0] = Math.min(lo[0], p[0]); lo[1] = Math.min(lo[1], p[1]); hi[0] = Math.max(hi[0], p[0]); hi[1] = Math.max(hi[1], p[1]); });
    var s = Math.max(0.25, Math.sqrt(L.area / 4000));
    var jit = 0.0137 * s;
    var nu = Math.max(1, Math.floor((hi[0] - lo[0]) / s)), nv = Math.max(1, Math.floor((hi[1] - lo[1]) / s));
    var grid = new Map(), samples = [];
    for (var j = 0; j < nv; j++) for (var i = 0; i < nu; i++) {
      var p2 = [lo[0] + (i + 0.5) * s + jit, lo[1] + (j + 0.5) * s + jit * 1.618];
      if (!pointInPoly(p2, L.P)) continue;
      var O = to3(fr, p2, P.d + 1e-4);
      var ex = firstHit(A, P.tris, O, P.n, -1);
      if (ex === null) continue;
      var smp = { i: i, j: j, p2: p2, run: ex + 1e-4 };
      grid.set(j * nu + i, samples.length);
      samples.push(smp);
    }
    m.samples = samples.length;
    m.sample = s;
    if (samples.length < 16) { c.failed.push('plate'); return c; }
    var runs = samples.map(function (x) { return x.run; });
    var t = median(runs), tol = 0.05 * t + 0.02;
    m.thickness = t;
    m.plateShare = runs.filter(function (x) { return Math.abs(x - t) <= tol; }).length / runs.length;
    m.minRun = Math.min.apply(null, runs);
    m.rootExtents = L.extents;
    m.rootArea = L.area;
    if (m.plateShare < 0.5 || m.minRun < 0.9 * t || L.extents[1] < 4 * t) { c.failed.push('plate'); return c; }

    function comps(pred) {
      var lab = new Map(), out = [];
      samples.forEach(function (x, k) {
        if (lab.has(k) || !pred(x)) return;
        var q = [k]; lab.set(k, out.length);
        for (var a = 0; a < q.length; a++) {
          var y = samples[q[a]];
          [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (dd) {
            var ni = y.i + dd[0], nj = y.j + dd[1];
            if (ni < 0 || nj < 0 || ni >= nu || nj >= nv) return;
            var kk = grid.get(nj * nu + ni);
            if (kk == null || lab.has(kk) || !pred(samples[kk])) return;
            lab.set(kk, out.length); q.push(kk);
          });
        }
        out.push(q.map(function (a) { return samples[a]; }));
      });
      return out;
    }
    function pca(pts) {
      var mx = 0, my = 0;
      pts.forEach(function (x) { mx += x.p2[0]; my += x.p2[1]; });
      mx /= pts.length; my /= pts.length;
      var sxx = 0, sxy = 0, syy = 0;
      pts.forEach(function (x) { var dx = x.p2[0] - mx, dy = x.p2[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; });
      var ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), a1 = [Math.cos(ang), Math.sin(ang)], a2 = [-a1[1], a1[0]];
      var e = [[Infinity, -Infinity], [Infinity, -Infinity]];
      pts.forEach(function (x) {
        var u = (x.p2[0] - mx) * a1[0] + (x.p2[1] - my) * a1[1], v = (x.p2[0] - mx) * a2[0] + (x.p2[1] - my) * a2[1];
        e[0][0] = Math.min(e[0][0], u); e[0][1] = Math.max(e[0][1], u); e[1][0] = Math.min(e[1][0], v); e[1][1] = Math.max(e[1][1], v);
      });
      return { c: [mx, my], a1: a1, a2: a2, length: e[0][1] - e[0][0] + s, width: e[1][1] - e[1][0] + s };
    }

    // The arm: where the solid runs out >= 3t, at the arm's own (flat-ended)
    // run - the gussets' tapering runs beside it are not the arm.
    var tall = runs.filter(function (x) { return x >= 3 * t; }).sort(function (a, b) { return a - b; });
    if (!tall.length) { c.failed.push('arm'); return c; }
    var armRun = tall[Math.floor(0.9 * (tall.length - 1))], armTol = 0.05 * armRun + 0.02;
    var arms = comps(function (x) { return Math.abs(x.run - armRun) <= armTol; }).sort(function (a, b) { return b.length - a.length; });
    var arm = arms[0], ap = pca(arm);
    armRun = median(arm.map(function (x) { return x.run; }));
    var armEdge = Infinity;
    arm.forEach(function (x) {
      for (var k = 0; k < L.P.length; k++) armEdge = Math.min(armEdge, segDist(x.p2, L.P[k], L.P[(k + 1) % L.P.length]));
    });
    m.arm = { projects: armRun, width: ap.width, length: ap.length, fromEdge: armEdge,
              normal: canon(clean(to3(fr, ap.a2, 0))), share: arm.length / tall.length };
    // Its two faces, by ray square to it at mid-height: its own thickness,
    // and exactly where the plate side of it is.
    var Om = to3(fr, ap.c, P.d + (t + armRun) / 2);
    var faceA = firstHit(A, P.tris, Om, to3(fr, ap.a2, 0), -1), faceB = firstHit(A, P.tris, Om, to3(fr, [-ap.a2[0], -ap.a2[1]], 0), -1);
    m.arm.thickness = faceA !== null && faceB !== null ? faceA + faceB : 0;
    if (ap.width > 1.5 * t + s || ap.length < 4 * t || armEdge > 1.5 * s || Math.abs(m.arm.thickness - t) > 0.25 * t) {
      c.failed.push('arm'); return c;
    }

    // Gussets: beside the arm, falling off in a straight line away from it.
    var armSet = new Set(arm);
    var inArm = function (x) { return armSet.has(x); };
    var tap = comps(function (x) { return !inArm(x) && x.run > t + tol && x.run < armRun - armTol; });
    // The side of the arm the plate lies on: + along a2 when most of the root is there.
    var side = 0;
    samples.forEach(function (x) { side += (x.p2[0] - ap.c[0]) * ap.a2[0] + (x.p2[1] - ap.c[1]) * ap.a2[1]; });
    var sg = side >= 0 ? 1 : -1;
    var armFar = sg > 0 ? faceA : faceB;      // the arm's plate-side face, from its centre line
    var gussets = [];
    tap.forEach(function (g) {
      if (g.length < 6) return;
      // Beside the arm: some sample next to an arm sample.
      var touches = g.some(function (x) {
        return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(function (dd) {
          var kk = grid.get((x.j + dd[1]) * nu + (x.i + dd[0]));
          return kk != null && armSet.has(samples[kk]);
        });
      });
      if (!touches) return;
      var ds = g.map(function (x) { return sg * ((x.p2[0] - ap.c[0]) * ap.a2[0] + (x.p2[1] - ap.c[1]) * ap.a2[1]) - armFar; });
      var rs = g.map(function (x) { return x.run; });
      var fit = linfit(ds, rs);
      gussets.push({ samples: g.length, slope: fit.b, r2: fit.r2, legOut: fit.a - t, legAlong: fit.b < 0 ? (t - fit.a) / fit.b : Infinity,
                     angle: Math.atan(-fit.b) * 180 / Math.PI,
                     centre: to3(fr, pca(g).c, P.d + t + (fit.a - t) / 3) });
    });
    m.gussets = gussets;
    var braced = gussets.filter(function (g) { return g.r2 >= 0.95 && g.slope < -0.2; });
    m.braced = braced.length;
    if (!braced.length) c.failed.push('braced');
    return c;
  }

  function linfit(x, y) {
    var n = x.length, sx = 0, sy = 0;
    for (var i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
    sx /= n; sy /= n;
    var sxx = 0, sxy = 0, syy = 0;
    for (i = 0; i < n; i++) { sxx += (x[i] - sx) * (x[i] - sx); sxy += (x[i] - sx) * (y[i] - sy); syy += (y[i] - sy) * (y[i] - sy); }
    var b = sxx > 0 ? sxy / sxx : 0;
    return { a: sy - b * sx, b: b, r2: sxx > 0 && syy > 0 ? sxy * sxy / (sxx * syy) : 0 };
  }

  // -------------------------------------------------------------------------
  // LID
  // -------------------------------------------------------------------------

  function judgeLid(A, P) {
    var c = { rule: 'lid', protrusion: P.id, failed: [], measured: {} };
    var m = c.measured;
    if (P.loops.length !== 1) { c.failed.push('root'); return c; }
    var L = P.loops[0], fr = P.frame, N = P.n, eps = A.eps;
    // The void: a closed shell of negative volume with triangles on the root
    // plane, facing into the body, inside the root.
    var found = null;
    A.shells.forEach(function (S) {
      if (found || !S.closed || !(S.volume < 0)) return;
      var strip = S.tris.filter(function (t) {
        if (dot(triN(A, t), N) > -PLANE_COS) return false;
        for (var k = 0; k < 3; k++) if (Math.abs(dot(A.V[A.tv[t * 3 + k]], N) - P.d) > eps) return false;
        var cc = [0, 1, 2].map(function (i) { return (A.V[A.tv[t * 3]][i] + A.V[A.tv[t * 3 + 1]][i] + A.V[A.tv[t * 3 + 2]][i]) / 3; });
        return pointInPoly([dot(cc, fr.e1), dot(cc, fr.e2)], L.P);
      });
      if (strip.length) found = { S: S, strip: strip };
    });
    if (!found) { c.failed.push('void'); return c; }
    var S = found.S;
    m.voidVolume = -S.volume;
    // The strip's boundary loops, in the strip's winding.
    var inStrip = new Set(found.strip);
    var next = new Map(), nE = 0;
    found.strip.forEach(function (t) {
      for (var k = 0; k < 3; k++) {
        if (inStrip.has(A.twin(t, k))) continue;
        var a = A.tv[t * 3 + k], b = A.tv[t * 3 + (k + 1) % 3];
        if (!next.has(a)) next.set(a, []);
        next.get(a).push(b); nE++;
      }
    });
    var loops = [], used = new Set();
    next.forEach(function (bs, a0) {
      bs.forEach(function (b0) {
        if (used.has(a0 + '>' + b0)) return;
        used.add(a0 + '>' + b0);
        var vs = [a0], b = b0, guard = 0;
        while (b !== a0 && guard++ <= nE) {
          vs.push(b);
          var cand = (next.get(b) || []).filter(function (x) { return !used.has(b + '>' + x); });
          if (!cand.length) break;
          used.add(b + '>' + cand[0]); b = cand[0];
        }
        if (b !== a0) return;
        var P2 = vs.map(function (v) { return [dot(A.V[v], fr.e1), dot(A.V[v], fr.e2)]; });
        loops.push({ verts: vs, P: P2, area: Math.abs(area2(P2)) });
      });
    });
    loops.sort(function (a, b) { return b.area - a.area; });
    if (loops.length < 2) { c.failed.push('plug'); return c; }
    var opening = loops[0], plugs = loops.slice(1);
    // The void's other triangles, flooded without crossing the strip: the one
    // on the opening is the pocket (the host's), the rest is the plug.
    var sideOf = new Map();
    var openingEdges = new Set();
    for (var i = 0; i < opening.verts.length; i++) openingEdges.add(A.ek(opening.verts[(i + 1) % opening.verts.length], opening.verts[i]));
    var rest = S.tris.filter(function (t) { return !inStrip.has(t); });
    var restSet = new Set(rest), lab = new Map(), groups = [];
    rest.forEach(function (s0) {
      if (lab.has(s0)) return;
      var q = [s0], g = groups.length, onOpening = false;
      lab.set(s0, g);
      for (var a = 0; a < q.length; a++) {
        var t = q[a];
        for (var k = 0; k < 3; k++) {
          var u = A.twin(t, k);
          if (openingEdges.has(A.ek(A.tv[t * 3 + k], A.tv[t * 3 + (k + 1) % 3]))) onOpening = true;
          if (u < 0 || !restSet.has(u) || lab.has(u)) continue;
          lab.set(u, g); q.push(u);
        }
      }
      groups.push({ tris: q, pocket: onOpening });
    });
    var plugTris = [], pocketTris = [];
    groups.forEach(function (g) { (g.pocket ? pocketTris : plugTris).push.apply(g.pocket ? pocketTris : plugTris, g.tris); });
    if (!plugTris.length || !pocketTris.length) { c.failed.push('plug'); return c; }
    m.clear = Infinity;
    plugs.forEach(function (Pl) { m.clear = Math.min(m.clear, loopDist(opening.P, Pl.P)); });
    // Seat: the opening inside the root, a rim all round.
    var inside = opening.P.every(function (p) { return pointInPoly(p, L.P); });
    m.rim = loopDist(opening.P, L.P);
    m.seatArea = L.area - opening.area;
    m.opening = opening.area;
    if (!inside || !(m.rim > 2 * eps)) c.failed.push('seat');
    // Free: the void is one genus-0 shell.
    m.voidChi = S.chi;
    if (S.chi !== 2) c.failed.push('free');
    // Depths, by ray, square to the seat.
    var pc = [0, 0]; plugs[0].P.forEach(function (p) { pc[0] += p[0]; pc[1] += p[1]; });
    pc = [pc[0] / plugs[0].P.length, pc[1] / plugs[0].P.length];
    var down = [-N[0], -N[1], -N[2]];
    var O = to3(fr, pc, P.d - 1e-4);
    var pd = firstHit(A, plugTris, O, down, -1);
    m.plugDepth = pd === null ? 0 : pd + 1e-4;
    if (pd !== null) {
      var fl = firstHit(A, pocketTris, to3(fr, pc, P.d - m.plugDepth - 1e-4), down, 0);
      m.floorGap = fl === null ? 0 : fl + 1e-4;
    }
    var up = firstHit(A, P.tris, to3(fr, pc, P.d + 1e-4), N, -1);
    m.plate = up === null ? 0 : up + 1e-4;
    c._lid = { strip: found.strip, plugTris: plugTris, opening: opening };
    return c;
  }

  // -------------------------------------------------------------------------
  // HINGE
  // -------------------------------------------------------------------------

  function judgeHinge(A, P) {
    var c = { rule: 'hinge', protrusion: P.id, failed: [], measured: {} };
    var m = c.measured;
    m.webs = P.loops.length;
    if (P.loops.length !== 2) { c.failed.push('webs'); return c; }
    var host = A.shellOf[P.tris[0]];
    var axis = canonAlong(norm(vsub(P.loops[1].centre, P.loops[0].centre)));
    // A second body tangled with it: a closed shell of positive volume, its
    // box overlapping the fixed part's.
    var pb = P.bounds, pad = 1e-3;
    var bodies = A.shells.filter(function (S) {
      if (S.id === host || !S.closed || !(S.volume > 0)) return false;
      return [0, 1, 2].every(function (i) { return S.bounds.lo[i] < pb.hi[i] + pad && pb.lo[i] < S.bounds.hi[i] + pad; });
    });
    if (!bodies.length) { c.failed.push('body'); return c; }
    var M = bodies.sort(function (a, b) { return b.volume - a.volume; })[0];
    m.bodyVolume = M.volume;
    m.bodyChi = M.chi;
    if (M.chi !== 0) { c.failed.push('bored'); return c; }
    // Cut square to the axis at the body's middle (volume centroid along it).
    var mid = 0, vw = 0;
    M.tris.forEach(function (t) {
      var p0 = A.V[A.tv[t * 3]], p1 = A.V[A.tv[t * 3 + 1]], p2 = A.V[A.tv[t * 3 + 2]];
      var v = dot(p0, cross(p1, p2)) / 6;
      mid += v * (dot(p0, axis) + dot(p1, axis) + dot(p2, axis)) / 4; vw += v;
    });
    mid = mid / vw;
    var fr = planeFrame(axis);
    var w = mid + 0.00137;             // off any vertex a round number put there
    var secB = section(A, M.tris, axis, w, fr), secF = section(A, P.tris, axis, w, fr);
    if (!secB || !secF || !secF.length) { c.failed.push('captive'); return c; }
    // The pin: a section of the fixed part that lies inside the body's hole.
    var pin = null, bore = null;
    secF.forEach(function (Q) {
      if (pin) return;
      var cc = [0, 0]; Q.forEach(function (p) { cc[0] += p[0]; cc[1] += p[1]; });
      cc = [cc[0] / Q.length, cc[1] / Q.length];
      // Inside the body's outline, but not in its material: a hole.
      var n = 0; secB.forEach(function (B) { if (pointInPoly(cc, B)) n++; });
      if (n === 2) {
        pin = { P: Q, c: cc };
        bore = secB.filter(function (B) { return pointInPoly(cc, B); }).sort(function (a, b) { return Math.abs(area2(a)) - Math.abs(area2(b)); })[0];
      }
    });
    if (!pin || !Q_inside(pin.P, bore)) { c.failed.push('captive'); return c; }
    // Radii and clearance along 16 rays square to the axis.
    var rp = [], rb = [], gap = Infinity;
    for (var k = 0; k < 16; k++) {
      var a = 2 * Math.PI * (k + 0.37) / 16, u = [Math.cos(a), Math.sin(a)];
      var sp = ray2(pin.c, u, [pin.P]), sb = ray2(pin.c, u, [bore]);
      if (!sp.length || !sb.length) continue;
      rp.push(sp[0]); rb.push(sb[0]); gap = Math.min(gap, sb[0] - sp[0]);
    }
    // Radii at the section's corners (the section crosses the barrel's long
    // edges at an n-gon's corner radius, its stated radius); the least gap along the rays is the clearance at the
    // flats, cos(pi / n) of it.
    function vr(Q) { return Q.reduce(function (sm, p) { return Math.max(sm, Math.hypot(p[0] - pin.c[0], p[1] - pin.c[1])); }, 0); }
    m.pinRadius = vr(pin.P); m.boreRadius = vr(bore); m.clear = m.boreRadius - m.pinRadius; m.leastGap = gap;
    m.axisPoint = to3(fr, pin.c, w);
    m.axis = axis;
    // The knuckle's outer radius: toward the face, out through the body.
    var na = dot(P.n, axis);
    var toFace = norm([-P.n[0] + na * axis[0], -P.n[1] + na * axis[1], -P.n[2] + na * axis[2]]);
    var hB = rayHits(A, M.tris, m.axisPoint, toFace), exits = hB.filter(function (h) { return h[1] < 0; });
    m.knuckleRadius = exits.length ? exits[0][0] : 0;
    // Axial: from inside the knuckle wall, both ways along the axis.
    var Q = vadd(m.axisPoint, toFace, (m.boreRadius + m.knuckleRadius) / 2);
    var gaps = [1, -1].map(function (sgn) {
      var D = [axis[0] * sgn, axis[1] * sgn, axis[2] * sgn];
      var out = firstHit(A, M.tris, Q, D, -1);
      if (out === null) return null;
      var fx = firstHit(A, P.tris, vadd(Q, D, out), D, 1);
      return fx === null || fx > m.knuckleRadius ? null : fx;
    });
    m.axialGaps = gaps;
    if (gaps[0] === null || gaps[1] === null) { c.failed.push('axial'); return c; }
    if (!(m.leastGap > 2 * A.eps) || !(Math.min(gaps[0], gaps[1]) > 2 * A.eps)) c.failed.push('free');
    c._hinge = { body: M };
    return c;
  }
  function Q_inside(Q, B) { return B && Q.every(function (p) { return pointInPoly(p, B); }); }
  function canonAlong(d) { return canon(clean(d)); }

  // -------------------------------------------------------------------------
  // detect()
  // -------------------------------------------------------------------------

  var JUDGE = { handle: judgeHandle, bracket: judgeBracket, lid: judgeLid, hinge: judgeHinge };

  /** Each clause's failure, in words - what a row says when there is none. */
  var WHY = {
    handle: {
      feet: 'meets its face at {feet} place(s), not on two feet',
      round: 'stands on feet that are not round - not a rod',
      closed: 'does not close over the space between its feet',
      opening: 'leaves an opening narrower than itself - no room for a hand',
      rod: 'is not the same rod across the opening as at its feet'
    },
    bracket: {
      root: 'meets its face at more than one place, not on one plate',
      plate: 'does not lie flat on its face as a plate of one thickness',
      arm: 'has no arm of its own thickness standing square off its plate',
      braced: 'has an arm but no gusset bracing it - an angle, which the flange rule finds'
    },
    lid: {
      root: 'meets its face at more than one place, not on one seat',
      void: 'closes no pocket - there is nothing enclosed under it',
      plug: 'has no plug dropping into its pocket to locate it',
      seat: 'does not sit on a ring round its pocket',
      free: 'has its plug fused to the pocket floor'
    },
    hinge: {
      webs: 'meets its face at {webs} place(s), not on two webs',
      body: 'carries no second body - nothing moves',
      bored: 'carries a second body with no bore to turn on',
      captive: 'does not pass a pin through the moving part',
      axial: 'does not hold the moving part between two fixed knuckles',
      free: 'touches its moving part - it is not free to turn'
    }
  };
  function why(rule, c) {
    return c.failed.map(function (k) {
      return (WHY[rule][k] || k).replace(/\{(\w+)\}/g, function (_, n) { return c.measured[n]; });
    }).join(', and ');
  }

  var NAMES = { handle: 'handle', bracket: 'bracket', lid: 'lid', hinge: 'hinge' };

  function detect(soup, only) {
    var t0 = Date.now();
    var rules = only && only.length ? only : RULES;
    var res = { ms: 0, protrusions: 0, faces: 0 };
    if (!soup || soup.length < 36) {
      rules.forEach(function (r) { res[r] = { found: [], candidates: [], reason: 'no geometry' }; });
      return res;
    }
    var A = analyse(soup);
    res.protrusions = A.protrusions.length;
    res.faces = A.faces.length;
    rules.forEach(function (rule) {
      var out = { found: [], candidates: [], reason: '' };
      A.protrusions.forEach(function (P) {
        var c;
        try { c = JUDGE[rule](A, P); }
        catch (err) { c = { rule: rule, protrusion: P.id, failed: ['error'], measured: { error: String(err && err.message || err) } }; }
        c.face = { normal: P.n.slice(), offset: P.d };
        c.roots = P.loops.map(function (L) { return { centre: L.centre, area: L.area, radius: L.radius }; });
        // A lid's root is its seat: the ring between its footprint and the
        // pocket's opening, not the footprint.
        c.rootArea = rule === 'lid' && c.measured.seatArea != null ? c.measured.seatArea : P.rootArea;
        c.bounds = P.bounds;
        c.centroid = [(P.bounds.lo[0] + P.bounds.hi[0]) / 2, (P.bounds.lo[1] + P.bounds.hi[1]) / 2, (P.bounds.lo[2] + P.bounds.hi[2]) / 2];
        if (!c.failed.length) {
          try { c.positions = Float32Array.from(solidFor(A, P, c)); }
          catch (err) { c.failed.push('solid'); c.measured.error = String(err && err.message || err); }
        }
        if (!c.failed.length) {
          c.volume = soupVolume(c.positions);
          c.triangles = c.positions.length / 9;
          c.extent = soupBounds(c.positions);
          out.found.push(c);
        }
        delete c._lid; delete c._hinge;
        out.candidates.push(c);
      });
      out.candidates.sort(function (x, y) { return x.failed.length - y.failed.length || y.rootArea - x.rootArea; });
      var near = out.candidates[0];
      out.reason = out.found.length
        ? out.found.length + ' ' + NAMES[rule] + (out.found.length === 1 ? '' : 's')
        : 'no ' + NAMES[rule] + ': ' + (near
            ? 'the nearest thing standing on a face (' + near.roots.length + ' root' + (near.roots.length === 1 ? '' : 's') + ', ' +
              fmt(near.rootArea, 1) + ' mm²) ' + why(rule, near)
            : 'nothing stands on a flat face here');
      res[rule] = out;
    });
    res.ms = Date.now() - t0;
    return res;
  }

  /** The feature as its own closed solid. */
  function solidFor(A, P, c) {
    var out = trisSoup(A, P.tris);
    if (c.rule === 'lid') {
      var L = c._lid;
      // The plate and its plug: the flood, the void's plug side and the strip
      // under the plate, and one ring cap on the seat, facing into the body.
      out = out.concat(trisSoup(A, L.strip), trisSoup(A, L.plugTris),
                       capSoup(A, P.frame, P.loops[0].verts, [L.opening.verts], -1));
      return out;
    }
    P.loops.forEach(function (Lp) { out = out.concat(capSoup(A, P.frame, Lp.verts, [], -1)); });
    if (c.rule === 'hinge') out = out.concat(trisSoup(A, c._hinge.body.tris));
    return out;
  }

  function describe(res, rule) {
    var r = res && res[rule];
    var Name = rule.charAt(0).toUpperCase() + rule.slice(1);
    if (!r) return Name + ': not run';
    if (!r.found.length) return Name + ': none detected (' + r.reason.replace(/^no \w+: /, '') + ')';
    return Name + ': ' + r.found.map(function (f) { return summary(rule, f); }).join('; ');
  }

  /** The measured numbers a row shows. */
  function summary(rule, f) {
    var m = f.measured;
    if (rule === 'handle') return fmt(2 * m.rodRadius, 1) + ' mm rod, ' + fmt(m.clear, 1) + ' mm clear';
    if (rule === 'bracket') return fmt(m.thickness, 1) + ' mm, ' + fmt(m.arm.projects, 1) + ' mm arm, ' + m.braced + ' gusset' + (m.braced === 1 ? '' : 's');
    if (rule === 'lid') return fmt(m.clear, 2) + ' mm clear, ' + fmt(m.rim, 1) + ' mm seat';
    if (rule === 'hinge') return fmt(m.clear, 2) + ' mm clear, 2 bodies';
    return '';
  }

  var api = {
    RULES: RULES,
    WHY: WHY,
    analyse: analyse,
    detect: detect,
    describe: describe,
    summary: summary,
    triangulate: triangulate
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_FaceFeatures = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
