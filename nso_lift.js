/* nso_lift.js - Lift, phase 1: take any detail off a flat face and leave the
   face flat.

   Loads as a classic script (window.NSO_Lift) and as a Node module
   (require('../nso_lift.js')). No DOM, no Three.js: a mesh is the app's raw
   soup (9 numbers per triangle, Z up, millimetres).

   READ docs/LIFT.md FIRST - it has the model, the numbers it was checked on
   (tools/nso_lift_test.js) and what it deliberately does not do.

   ---------------------------------------------------------------------------
   ONE QUESTION, NOT A CATALOGUE
   ---------------------------------------------------------------------------
   Flange, Handle, Bracket, Lid and Hinge are named rules (nso_flange.js,
   nso_face_features.js). This file asks the one question underneath them:
   "what sticks out from this face, and by how much". It has no names for
   dots, lines, rings, letters or textures; a detail is whatever stands proud
   of the face, and its height is how far.

     base     the flat face the user picked. Its plane is fitted to the
              coplanar patch round the clicked triangle: triangles joined
              edge to edge whose three corners lie within `flatTol` of the
              seed's plane, facing the same way.
     island   material standing proud of that plane, connected to it:
              triangles with no corner below the plane and at least one above
              it, joined through edges that leave the plane (two islands that
              touch only along a line IN the plane are two bodies once the
              plane is cut, so they are two islands). Its height is the
              furthest any of its corners stands out.
     offered  an island whose height is MORE than the slider's "how far out
              counts", that meets the face all round (every edge it stops at
              lies in the plane, next to the face or to another island) and
              that stays inside the picked face's footprint: it never meets
              the face's OUTER edge and it lies within it. So a part's own
              sharp edges, a raised rim or a step that runs over the side,
              are never offered.
     lift     each chosen island + a cap on its root loops, facing into the
              face, is its own closed piece: its flat back lies in the base
              plane. The plate keeps every other triangle exactly as it was
              and gains the same cap facing out, so it is flat and closed
              where the island stood. A ring's root is two loops, and the cap
              is the annulus between them: the bore stays open.

   Both cases the ticket names land here. On a part with real flat faces an
   island's root loops are holes in the base patch. On a relief slab the
   islands rise straight out of the paper through sloped triangles; their
   root loops run through the paper's own vertices, and the slider decides
   what counts. Nothing is cut and no vertex is moved: the caps are made of
   the root loops' own vertices.

   THE CAPS ARE THE CUT ENGINE'S. rawFlatCapLoops (app-cut.js) nests the
   loops (rawNestLoops: a loop inside a loop is a hole), bridges each hole
   into its outline and ear-clips the result. It works on an axis plane; a
   base whose normal is not an axis is turned into a frame where it is, the
   triangles come back, and every corner is mapped back to the loop vertex it
   was made from - so the cap is still built of the original vertices.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   analyse(soup, seedTri, opts)  -> { ok, reason, plane, base, islands, ... }
                                    or { ok: false, refused: 'curved' | ...,
                                    reason } in plain words
   offered(analysis, minHeight)  -> the island ids the slider offers
   lift(soup, analysis, ids, deps) -> { ok, plate, pieces: [{ id, soup,
                                    volume }], volumes, reason }
   census(soup)                  -> { tris, open, nm, degen, closed }
   volume(soup)                  -> signed volume, mm^3
   defaultMinHeight(nozzle)      -> the slider's default: NSO_Thickness's
                                    floorFor(nozzle), 0.42 mm at 0.4

   PAINT SCOPE: NONE, for this module. It reads soups and writes none.
   app-gscope-lift.js replaces the piece and declares its own scope.
*/
(function (root) {
  'use strict';

  var DEFAULTS = {
    flatTolMm: 0.001,   // + 2 ppm of the part's size: "in the plane"
    curveDeg: 20,       // a facet edge that bends less than this is a gentle one
    curveShare: 0.5,    // ...along more than this share of the face's outer edge
    curveRatio: 4       // ...and the face is not this many times its neighbours: curved
  };

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function len(a) { return Math.hypot(a[0], a[1], a[2]); }
  function norm(a) { var l = len(a); return l ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; }
  function fmt(x, d) { return (+x).toFixed(d == null ? 2 : d); }

  function dep(deps, name) {
    return (deps && deps[name]) || (root && root[name]) ||
           (typeof globalThis !== 'undefined' ? globalThis[name] : null) || null;
  }

  /** The slider's default: one extrusion line at the nozzle (NSO_Thickness). */
  function defaultMinHeight(nozzle) {
    var T = dep(null, 'NSO_Thickness');
    if (T && typeof T.floorFor === 'function') return T.floorFor(nozzle);
    var d = (typeof nozzle === 'number' && nozzle > 0) ? nozzle : 0.4;
    return Math.round(d * 1.05 * 1e6) / 1e6;
  }

  // -------------------------------------------------------------------------
  // The mesh: exact weld (a closed soup shares its corners bit for bit),
  // directed edges, planes.
  // -------------------------------------------------------------------------

  function index(soup) {
    var nt = Math.floor(soup.length / 9);
    var M = { soup: soup, nt: nt, V: [], tv: new Int32Array(nt * 3) };
    var key = new Map(), V = M.V;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var t = 0; t < nt; t++) {
      for (var k = 0; k < 3; k++) {
        var o = t * 9 + k * 3;
        var x = soup[o], y = soup[o + 1], z = soup[o + 2];
        var kk = x + ',' + y + ',' + z;
        var id = key.get(kk);
        if (id == null) { id = V.length; key.set(kk, id); V.push([x, y, z]); }
        M.tv[t * 3 + k] = id;
        if (x < lo[0]) lo[0] = x; if (x > hi[0]) hi[0] = x;
        if (y < lo[1]) lo[1] = y; if (y > hi[1]) hi[1] = y;
        if (z < lo[2]) lo[2] = z; if (z > hi[2]) hi[2] = z;
      }
    }
    M.scale = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
    var dir = new Map(), NV = V.length + 1;
    M.ek = function (a, b) { return a * NV + b; };
    for (t = 0; t < nt; t++) {
      for (k = 0; k < 3; k++) {
        var a = M.tv[t * 3 + k], b = M.tv[t * 3 + (k + 1) % 3];
        if (a === b) continue;
        var e = M.ek(a, b);
        dir.set(e, dir.has(e) ? -1 : t);          // -1: the edge is used twice one way
      }
    }
    M.dir = dir;
    M.twin = function (t, k) {
      var r = dir.get(M.ek(M.tv[t * 3 + (k + 1) % 3], M.tv[t * 3 + k]));
      return r == null ? -1 : r;
    };
    M.n = new Float64Array(nt * 3);
    M.area = new Float64Array(nt);
    for (t = 0; t < nt; t++) {
      var p0 = V[M.tv[t * 3]], c = cross(sub(V[M.tv[t * 3 + 1]], p0), sub(V[M.tv[t * 3 + 2]], p0)), l = len(c);
      M.area[t] = l / 2;
      if (l > 0) { M.n[t * 3] = c[0] / l; M.n[t * 3 + 1] = c[1] / l; M.n[t * 3 + 2] = c[2] / l; }
    }
    return M;
  }

  function triN(M, t) { return [M.n[t * 3], M.n[t * 3 + 1], M.n[t * 3 + 2]]; }
  function angleDeg(a, b) { return Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) * 180 / Math.PI; }

  /** An in-plane frame with e1 x e2 = n, so CCW in (e1, e2) is CCW seen from +n. */
  function planeFrame(n) {
    var ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    var e1 = norm(cross(ref, n));
    var e2 = cross(n, e1);
    return { e1: e1, e2: e2, n: n };
  }

  /** Triangles joined edge to edge, every corner within tol of the seed's
      plane and facing its way: the flat patch round a triangle. */
  function growPatch(M, seed, tol, cap) {
    var n = triN(M, seed), d = dot(M.V[M.tv[seed * 3]], n);
    var inP = new Set([seed]), list = [seed];
    for (var i = 0; i < list.length && (!cap || list.length < cap); i++) {
      var t = list[i];
      for (var k = 0; k < 3; k++) {
        var u = M.twin(t, k);
        if (u < 0 || inP.has(u)) continue;
        if (M.area[u] > 1e-9 && dot(triN(M, u), n) <= 0) continue;
        var on = true;
        for (var j = 0; j < 3; j++) if (Math.abs(dot(M.V[M.tv[u * 3 + j]], n) - d) > tol) { on = false; break; }
        if (!on) continue;
        inP.add(u); list.push(u);
      }
    }
    var area = 0;
    list.forEach(function (t) { area += M.area[t]; });
    return { tris: list, set: inP, area: area, n: n, d: d };
  }

  /** Directed boundary edges of a triangle set, chained into loops. At a
      corner where two loops touch, the loop keeps the set on its left: it
      takes the first outgoing edge clockwise from the way it came in. */
  function boundaryLoops(M, tris, inSet, fr) {
    var out = new Map(), count = 0;
    tris.forEach(function (t) {
      for (var k = 0; k < 3; k++) {
        var u = M.twin(t, k);
        if (u >= 0 && inSet(u)) continue;
        var a = M.tv[t * 3 + k], b = M.tv[t * 3 + (k + 1) % 3];
        if (!out.has(a)) out.set(a, []);
        out.get(a).push({ b: b, t: t, k: k, used: false });
        count++;
      }
    });
    function p2(v) { var p = M.V[v]; return [dot(p, fr.e1), dot(p, fr.e2)]; }
    var loops = [];
    out.forEach(function (es, a0) {
      es.forEach(function (e0) {
        if (e0.used) return;
        e0.used = true;
        var verts = [a0], edges = [e0], prev = a0, cur = e0.b, guard = 0, ok = true;
        while (cur !== a0) {
          verts.push(cur);
          var cand = (out.get(cur) || []).filter(function (x) { return !x.used; });
          if (!cand.length || ++guard > count) { ok = false; break; }
          var pick = cand[0];
          if (cand.length > 1) {
            var P = p2(cur), B = p2(prev), back = Math.atan2(B[1] - P[1], B[0] - P[0]), best = Infinity;
            cand.forEach(function (x) {
              var Q = p2(x.b), ang = back - Math.atan2(Q[1] - P[1], Q[0] - P[0]);
              while (ang <= 0) ang += 2 * Math.PI;
              while (ang > 2 * Math.PI) ang -= 2 * Math.PI;
              if (ang < best) { best = ang; pick = x; }
            });
          }
          pick.used = true;
          edges.push(pick);
          prev = cur; cur = pick.b;
        }
        if (!ok) { loops.push({ verts: verts, edges: edges, broken: true, area: 0 }); return; }
        var P2 = verts.map(p2), s = 0;
        for (var i = 0; i < P2.length; i++) { var q = P2[i], r = P2[(i + 1) % P2.length]; s += q[0] * r[1] - r[0] * q[1]; }
        loops.push({ verts: verts, edges: edges, area: s / 2, P2: P2 });
      });
    });
    return loops;
  }

  // -------------------------------------------------------------------------
  // analyse: the base, and what stands on it
  // -------------------------------------------------------------------------

  function analyse(soup, seedTri, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var t0 = Date.now();
    if (!soup || soup.length < 36) return { ok: false, refused: 'empty', reason: 'there is no mesh to lift from' };
    var M = index(soup);
    var seed = seedTri | 0;
    if (!(seed >= 0 && seed < M.nt)) return { ok: false, refused: 'seed', reason: 'that click is not on a triangle of this piece' };
    if (!(M.area[seed] > 1e-9)) return { ok: false, refused: 'seed', reason: 'the clicked triangle has no area - click the face itself' };
    var tol = o.flatTolMm + 2e-6 * M.scale;

    // ---- the base: the flat patch round the click, and its plane ----
    var P = growPatch(M, seed, tol);
    var nsum = [0, 0, 0];
    P.tris.forEach(function (t) { var a = M.area[t]; nsum[0] += a * M.n[t * 3]; nsum[1] += a * M.n[t * 3 + 1]; nsum[2] += a * M.n[t * 3 + 2]; });
    var n = norm(nsum);
    for (var ax = 0; ax < 3; ax++) {
      if (Math.abs(n[ax]) > 1 - 1e-12) { n = [0, 0, 0]; n[ax] = nsum[ax] > 0 ? 1 : -1; }
    }
    var pv = new Set();
    P.tris.forEach(function (t) { for (var k = 0; k < 3; k++) pv.add(M.tv[t * 3 + k]); });
    var dsum = 0, cnt = 0;
    pv.forEach(function (v) { dsum += dot(M.V[v], n); cnt++; });
    var d = dsum / cnt, resid = 0;
    pv.forEach(function (v) { resid = Math.max(resid, Math.abs(dot(M.V[v], n) - d)); });
    var fr = planeFrame(n);

    // ---- its loops, and the outer one ----
    var Ploops = boundaryLoops(M, P.tris, function (t) { return P.set.has(t); }, fr);
    var outer = null;
    Ploops.forEach(function (L) { if (!L.broken && L.area > 0 && (!outer || L.area > outer.area)) outer = L; });

    // ---- flat, or one facet of something curved? ----
    var curve = curvature(M, P, outer, n, tol, o);
    var base = { tris: P.tris.length, list: P.tris, areaMm2: P.area, residualMm: resid, outerMm: curve.outerMm };
    var plane = { n: n, d: d, tolMm: tol };
    if (curve.curved) {
      return { ok: false, refused: 'curved', plane: plane, base: base, curve: curve,
        reason: 'Lift needs a flat face, and this one is curved: round the click it is flat (within ' +
          fmt(tol * 1000, 1) + ' µm of one plane) over only ' + fmt(P.area, 2) + ' mm² (' + P.tris.length +
          ' triangle' + (P.tris.length === 1 ? '' : 's') + '), and from there it bends on by about ' +
          fmt(curve.bendDeg, 1) + '° into each next facet. Pick the flat face the details stand on.' };
    }

    // ---- every triangle: on the face, standing proud of it, or below ----
    var nt = M.nt, sV = new Float64Array(M.V.length);
    for (var v = 0; v < M.V.length; v++) sV[v] = dot(M.V[v], n) - d;
    var BASE = 1, ABOVE = 2, BELOW = 3;
    var cls = new Uint8Array(nt);
    for (var t = 0; t < nt; t++) {
      var a = sV[M.tv[t * 3]], b = sV[M.tv[t * 3 + 1]], c = sV[M.tv[t * 3 + 2]];
      var mn = Math.min(a, b, c), mx = Math.max(a, b, c);
      if (mn < -tol) cls[t] = BELOW;
      else if (mx <= tol) cls[t] = (M.area[t] <= 1e-9 || dot(triN(M, t), n) > 0) ? BASE : BELOW;
      else cls[t] = ABOVE;
    }
    function inPlaneEdge(t, k) {
      return Math.abs(sV[M.tv[t * 3 + k]]) <= tol && Math.abs(sV[M.tv[t * 3 + (k + 1) % 3]]) <= tol;
    }

    // ---- the footprint: the top the click is on - the face and everything
    //      standing on it, joined edge to edge, never going below the plane.
    //      Its rim is where the part's own sides go down. ----
    var top = new Uint8Array(nt), tl = [seed];
    top[seed] = 1;
    for (var ti = 0; ti < tl.length; ti++) {
      for (var tk = 0; tk < 3; tk++) {
        var tu = M.twin(tl[ti], tk);
        if (tu >= 0 && !top[tu] && cls[tu] !== BELOW) { top[tu] = 1; tl.push(tu); }
      }
    }

    // ---- islands: ABOVE triangles joined through edges that leave the plane ----
    var isl = new Int32Array(nt).fill(-1), islands = [];
    for (var s = 0; s < nt; s++) {
      if (cls[s] !== ABOVE || !top[s] || isl[s] >= 0) continue;
      var id = islands.length, list = [s];
      isl[s] = id;
      for (var i = 0; i < list.length; i++) {
        var tt = list[i];
        for (var k = 0; k < 3; k++) {
          if (inPlaneEdge(tt, k)) continue;
          var u = M.twin(tt, k);
          if (u >= 0 && cls[u] === ABOVE && isl[u] < 0) { isl[u] = id; list.push(u); }
        }
      }
      islands.push({ id: id, tris: list });
    }

    islands.forEach(function (I) {
      var h = 0, hv = new Set(), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      var why = null;
      I.tris.forEach(function (t) {
        for (var k = 0; k < 3; k++) {
          var vv = M.tv[t * 3 + k];
          if (sV[vv] > h) h = sV[vv];
          if (!hv.has(vv)) {
            hv.add(vv);
            var p = M.V[vv];
            for (var q = 0; q < 3; q++) { if (p[q] < lo[q]) lo[q] = p[q]; if (p[q] > hi[q]) hi[q] = p[q]; }
          }
          if (why) continue;
          var u = M.twin(t, k);
          if (u >= 0 && isl[u] === I.id) continue;
          // Where it stops, it must stop IN the plane, next to the face or
          // another island - never at an open edge, never down a side.
          if (u < 0) why = 'open';
          else if (!inPlaneEdge(t, k) || cls[u] === BELOW) why = 'edge';
        }
      });
      I.heightMm = h;
      I.triangles = I.tris.length;
      I.bounds = { lo: lo, hi: hi };
      I.center = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
      if (!why) {
        I.loops = boundaryLoops(M, I.tris, function (t) { return isl[t] === I.id; }, fr);
        if (I.loops.some(function (L) { return L.broken; })) why = 'loops';
      }
      if (!why) {
        // A detail stands inside its own outer root loop: the biggest loop
        // runs round it (CCW seen from the face's side). Something that only
        // has loops running the other way stands OUTSIDE where it meets the
        // face - it is the body, as when the bottom face is picked.
        var big = null, ra = 0;
        I.loops.forEach(function (L) { ra += L.area; if (!big || Math.abs(L.area) > Math.abs(big.area)) big = L; });
        I.rootAreaMm2 = ra;
        if (!(big.area > 0)) why = 'body';
        else if (!(ra > 0)) why = 'loops';
      }
      I.status = why || 'ok';
      I.reason = why ? WHY[why] : null;
    });
    var ok = islands.filter(function (I) { return I.status === 'ok'; });
    return {
      ok: true, M: M, plane: plane, frame: fr, base: base, curve: curve, seed: seed,
      islands: islands, islandOf: isl, classOf: cls,
      liftable: ok.length, ms: Date.now() - t0,
      reason: describeAnalysis(islands, base)
    };
  }

  var WHY = {
    open: 'it runs into an open edge of the mesh',
    edge: 'it runs over the edge of the face, down the side of the part - it is part of the body, not a detail on the face',
    body: 'it stands round the face rather than on it - it is the body, not a detail on the face',
    loops: 'where it meets the face does not close into clean loops'
  };

  function describeAnalysis(islands, base) {
    var ok = islands.filter(function (I) { return I.status === 'ok'; });
    var not = islands.length - ok.length;
    return islands.length + ' thing(s) stand proud of the face (' + fmt(base.areaMm2, 1) + ' mm²): ' +
      ok.length + ' can be lifted' + (not ? ', ' + not + ' are part of the body (they run over the edge of the face)' : '');
  }

  /** Is the base one facet of a curved surface? Gentle bends (< curveDeg)
      along most of its outer edge, into neighbouring flat patches that are
      not much smaller than it: a cylinder's strip, a sphere's facet. A big
      flat face meeting a fillet is not refused - the fillet's strips are
      narrow next to it. */
  function curvature(M, P, outer, n, tol, o) {
    var out = { curved: false, gentleShare: 0, bendDeg: 0, outerMm: 0, neighbourAreaMm2: 0 };
    if (!outer) return out;
    var total = 0, gentle = 0, bends = [], seeds = [];
    outer.edges.forEach(function (e) {
      var a = M.V[M.tv[e.t * 3 + e.k]], b = M.V[M.tv[e.t * 3 + (e.k + 1) % 3]], L = len(sub(b, a));
      total += L;
      var u = M.twin(e.t, e.k);
      if (u < 0 || !(M.area[u] > 1e-9)) return;
      var ang = angleDeg(triN(M, u), n);
      if (ang < o.curveDeg) { gentle += L; bends.push(ang); seeds.push(u); }
    });
    out.outerMm = total;
    out.gentleShare = total > 0 ? gentle / total : 0;
    if (!(out.gentleShare > o.curveShare)) return out;
    bends.sort(function (x, y) { return x - y; });
    out.bendDeg = bends[bends.length >> 1];
    var seen = new Set(), areas = [];
    for (var i = 0; i < seeds.length && areas.length < 24; i++) {
      if (seen.has(seeds[i])) continue;
      var Q = growPatch(M, seeds[i], tol, 20000);
      Q.tris.forEach(function (t) { seen.add(t); });
      areas.push(Q.area);
    }
    var mean = areas.reduce(function (s, x) { return s + x; }, 0) / (areas.length || 1);
    out.neighbourAreaMm2 = mean;
    out.curved = P.area < o.curveRatio * mean;
    return out;
  }

  /** The islands the slider offers: liftable, and standing out MORE than minHeight. */
  function offered(A, minHeight) {
    if (!A || !A.ok) return [];
    var h = +minHeight || 0;
    return A.islands.filter(function (I) { return I.status === 'ok' && I.heightMm > h; })
      .map(function (I) { return I.id; });
  }

  // -------------------------------------------------------------------------
  // lift
  // -------------------------------------------------------------------------

  /** The cap over one island's root loops, facing +n, built of the loops' own
      vertices by rawFlatCapLoops. */
  function capFor(A, I, rawFlatCapLoops) {
    var M = A.M, n = A.plane.n, ax = -1;
    for (var k = 0; k < 3; k++) if (Math.abs(n[k]) === 1) ax = k;
    // Start each loop away from any corner it shares with another, so the
    // nesting test (one vertex decides) never probes a shared point.
    var uses = new Map();
    I.loops.forEach(function (L) { L.verts.forEach(function (v) { uses.set(v, (uses.get(v) || 0) + 1); }); });
    var loops = I.loops.map(function (L) {
      var s0 = 0;
      while (s0 < L.verts.length - 1 && uses.get(L.verts[s0]) > 1) s0++;
      return L.verts.slice(s0).concat(L.verts.slice(0, s0)).map(function (v) { return M.V[v]; });
    });
    if (ax >= 0) {
      return rawFlatCapLoops(loops, ax, A.plane.d * n[ax], n[ax] < 0);
    }
    var fr = A.frame, back = new Map();
    var local = loops.map(function (L) {
      return L.map(function (p) {
        var q = [dot(p, fr.e1), dot(p, fr.e2), dot(p, fr.n)];
        back.set(q[0] + ',' + q[1] + ',' + q[2], p);
        return q;
      });
    });
    var c = rawFlatCapLoops(local, 2, A.plane.d, false), outc = [];
    for (var i = 0; i < c.length; i += 3) {
      var p = back.get(c[i] + ',' + c[i + 1] + ',' + c[i + 2]);
      if (!p) throw new Error('the cap made a corner that is not on the root loop');
      outc.push(p[0], p[1], p[2]);
    }
    return outc;
  }

  function lift(soup, A, ids, deps) {
    if (!A || !A.ok) return { ok: false, reason: 'pick a flat face first' };
    var rawFlatCapLoops = dep(deps, 'rawFlatCapLoops');
    if (typeof rawFlatCapLoops !== 'function') return { ok: false, reason: 'Lift needs the cut engine (app-cut.js, rawFlatCapLoops)' };
    var want = Array.from(new Set(ids || []));
    if (!want.length) return { ok: false, reason: 'nothing is chosen - click a detail first' };
    var M = A.M, nt = M.nt, chosen = new Int32Array(nt).fill(-1);
    var pieces = [], plateCaps = [];
    for (var w = 0; w < want.length; w++) {
      var I = A.islands[want[w]];
      if (!I) return { ok: false, reason: 'there is no detail ' + want[w] + ' on this face' };
      if (I.status !== 'ok') return { ok: false, reason: 'detail ' + (I.id + 1) + ' cannot be lifted: ' + I.reason };
      var cap;
      try { cap = capFor(A, I, rawFlatCapLoops); }
      catch (err) { return { ok: false, reason: 'detail ' + (I.id + 1) + ' could not be capped (' + ((err && err.message) || err) + ')' }; }
      var ps = new Float32Array(I.tris.length * 9 + cap.length), o = 0;
      I.tris.forEach(function (t) { chosen[t] = I.id; for (var q = 0; q < 9; q++) ps[o++] = soup[t * 9 + q]; });
      // The piece's flat back: the plate's cap, turned over.
      for (var c = 0; c < cap.length; c += 9) {
        ps[o++] = cap[c]; ps[o++] = cap[c + 1]; ps[o++] = cap[c + 2];
        ps[o++] = cap[c + 6]; ps[o++] = cap[c + 7]; ps[o++] = cap[c + 8];
        ps[o++] = cap[c + 3]; ps[o++] = cap[c + 4]; ps[o++] = cap[c + 5];
      }
      var pc = census(ps);
      if (!pc.closed || pc.degen) {
        return { ok: false, reason: 'detail ' + (I.id + 1) + ' would not come off as a closed piece (' +
          pc.open + ' open, ' + pc.nm + ' non-manifold, ' + pc.degen + ' degenerate) - nothing changed' };
      }
      pieces.push({ id: I.id, soup: ps, heightMm: I.heightMm, capTris: cap.length / 9, volume: volume(ps),
                    rootAreaMm2: I.rootAreaMm2, census: pc });
      plateCaps.push(cap);
    }
    var kept = 0;
    for (var t = 0; t < nt; t++) if (chosen[t] < 0) kept++;
    var capLen = plateCaps.reduce(function (s, x) { return s + x.length; }, 0);
    var plate = new Float32Array(kept * 9 + capLen), p = 0;
    for (t = 0; t < nt; t++) {
      if (chosen[t] >= 0) continue;
      for (var q2 = 0; q2 < 9; q2++) plate[p++] = soup[t * 9 + q2];
    }
    plateCaps.forEach(function (cp) { for (var i = 0; i < cp.length; i++) plate[p++] = cp[i]; });
    var src = census(soup), pl = census(plate);
    if (src.closed && (!pl.closed || pl.degen)) {
      return { ok: false, reason: 'the plate would not stay closed (' + pl.open + ' open, ' + pl.nm +
        ' non-manifold, ' + pl.degen + ' degenerate) - nothing changed' };
    }
    var vSrc = volume(soup), vPlate = volume(plate), vPieces = pieces.reduce(function (s, x) { return s + x.volume; }, 0);
    return {
      ok: true, plate: plate, pieces: pieces, keptTris: kept, plateCensus: pl,
      volumes: { source: vSrc, plate: vPlate, pieces: vPieces, residual: vSrc - vPlate - vPieces },
      reason: 'lifted ' + pieces.length + ' detail' + (pieces.length === 1 ? '' : 's') + ' (' +
        fmt(vPieces, 2) + ' mm³) off the face; the plate keeps ' + kept + ' of its ' + nt +
        ' triangles as they were and is flat where ' + (pieces.length === 1 ? 'it' : 'they') + ' stood'
    };
  }

  // -------------------------------------------------------------------------
  // Checks
  // -------------------------------------------------------------------------

  /** Closed and manifold, by exact corners: every directed edge once, and its
      twin once. Degenerate: a repeated corner or no area. */
  function census(soup) {
    var nt = Math.floor(soup.length / 9), key = new Map(), nv = 0, ids = new Int32Array(nt * 3);
    for (var i = 0; i < nt * 3; i++) {
      var o = i * 3, k = soup[o] + ',' + soup[o + 1] + ',' + soup[o + 2], id = key.get(k);
      if (id == null) { id = nv++; key.set(k, id); }
      ids[i] = id;
    }
    var dir = new Map(), degen = 0, nm = 0, open = 0;
    for (var t = 0; t < nt; t++) {
      var a = ids[t * 3], b = ids[t * 3 + 1], c = ids[t * 3 + 2];
      var p = t * 9;
      var cr = cross([soup[p + 3] - soup[p], soup[p + 4] - soup[p + 1], soup[p + 5] - soup[p + 2]],
                     [soup[p + 6] - soup[p], soup[p + 7] - soup[p + 1], soup[p + 8] - soup[p + 2]]);
      if (a === b || b === c || a === c || len(cr) < 1e-12) degen++;
      [[a, b], [b, c], [c, a]].forEach(function (e) {
        var kk = e[0] * nv + e[1];
        dir.set(kk, (dir.get(kk) || 0) + 1);
      });
    }
    dir.forEach(function (cnt, kk) {
      var a = Math.floor(kk / nv), b = kk - a * nv;
      if (a === b) return;
      var tw = dir.get(b * nv + a) || 0;
      if (tw && a > b) return;                       // each undirected edge once
      if (cnt > 1 || tw > 1) nm++;
      else if (tw === 0) open++;
    });
    return { tris: nt, verts: nv, open: open, nm: nm, degen: degen, closed: open === 0 && nm === 0,
             chi: nv - (dir.size / 2) + nt };
  }

  function volume(soup) {
    var v = 0;
    for (var o = 0; o + 8 < soup.length; o += 9) {
      v += soup[o] * (soup[o + 4] * soup[o + 8] - soup[o + 5] * soup[o + 7]) -
           soup[o + 1] * (soup[o + 3] * soup[o + 8] - soup[o + 5] * soup[o + 6]) +
           soup[o + 2] * (soup[o + 3] * soup[o + 7] - soup[o + 4] * soup[o + 6]);
    }
    return v / 6;
  }

  var api = {
    DEFAULTS: DEFAULTS,
    WHY: WHY,
    defaultMinHeight: defaultMinHeight,
    analyse: analyse,
    offered: offered,
    lift: lift,
    census: census,
    volume: volume,
    // For Lift 2 (nso_lift_auto.js), which cuts each island at its own
    // plane: the same loops and the same caps, nothing here changes.
    internals: { planeFrame: planeFrame, boundaryLoops: boundaryLoops, capFor: capFor }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_Lift = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
