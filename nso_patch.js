/* nso_patch.js - Patch: fill an open loop with a surface that CONTINUES the
   curvature round it. The engine behind the Findings card's "close this hole"
   fixes (Cap, Patch, Bridge) and behind ADD > Patch.

   Loads as a classic script (window.NSO_Patch) and as a Node module. No DOM,
   no THREE. Soups are the app's usual raw triangle soup: 9 numbers a
   triangle, any frame (nothing here cares which way is up).

   READ docs/PATCH.md FIRST.

   ---------------------------------------------------------------------------
   THE VERBS
   ---------------------------------------------------------------------------
     loops(soup)                 every open loop, with an id (this soup's only)
     describe(soup, loop)        planar? how far off its plane? how big?
     patch(soup, ids, opts)      PATCH: fill with a surface that continues the
                                 curvature round the rim - or, when the surround
                                 is planar within 0.05 mm, the flat cap
     readout(filled[i])          one plain line per hole filled: size, fit, error
     cap(soup, ids, opts)        CAP: the flat cap, this loop only
     bridgeLoops(soup, a, b)     BRIDGE two open loops: a strip welded to both
     gaps(soup, opts)            two end faces facing each other across a gap
                                 (a severed tube, a crack that opened)
     bridgeFaces(soup, gap)      BRIDGE a gap found above, with NSO_Bridge
     plan(soup, opts)            what each open loop wants: CAP, PATCH or BRIDGE
     topology(soup)              open / non-manifold / wound / shells / Euler

   ---------------------------------------------------------------------------
   WHAT PATCH DOES - the same rule as Lift 3's repair fill (docs/LIFT.md 6)
   ---------------------------------------------------------------------------
     rim      the loop's OWN vertices, unmoved: the fill shares them with the
              real triangles round the hole - the same numbers bit for bit, so
              there is no step and no sliver at the weld.
     surround a ring of the piece's own vertices out from the rim (a quarter of
              the hole's diameter, 3 to 8 triangle rings). A rim in one plane
              does not make a flat floor: a circular hole in a sphere has one.
              The surround decides.
     fit      a surface is fitted to the surround by least squares: the plane
              (the surround lies in the rim's plane to 0.05 mm: the flat cap),
              else a SPHERE, else Lift 3's QUADRIC. A fit follows the surround
              when its rms residual is within 4% of an edge (not under 0.01 mm)
              and no vertex of it, the rim's included, is off by more than 3x.
     fill     triangulated in the fit's chart (flat coordinates for it) and
              filled with points ON the fit at the surround's own spacing, the
              triangles kept Delaunay; a facet that would sag more than 0.02 mm
              off the fit is split. The interior is never on the loop's plane.
     report   per hole (patch()'s `filled[i].fit`, and readout(filled[i])): the
              loop's diameter, the fit's kind, radius and residual, how far the
              fill stands off it, the fill's and the surround's edge length.
              NEVER SILENT: when no fit follows the surround the hole is faired
              from the rim's slopes (the biharmonic: the new points minimise
              sum |L x|^2 over themselves and the rim, L the uniform Laplacian
              over the piece's edges and the fill's), or filled flat with
              opts.fallback 'flat', and the report says which and why.

   When the rim and its surround lie in one plane to within 0.05 mm
   (PLANAR_MM), the fill is the flat cap: minimum-area triangulation of the
   polygon and nothing inside.

   THE FILL IS WOUND TO THE RIM: for every boundary half-edge u->v of the
   piece, the fill holds v->u. Appended to the piece it closes the loop by
   bit equality of the rim vertices - no weld needed, no kernel.

   PAINT SCOPE: NONE, for this module. It reads soups and writes none; it adds
   triangles and leaves every existing one byte for byte. The caller that
   replaces a piece carries the paint check (app-patch.js). */
(function (root) {
  'use strict';

  var DEFAULTS = {
    weldTol: 1e-4,        // the checker's weld radius
    planarMm: 0.05,       // a rim whose FLATNESS (slab width) is within this gets the flat cap
    maxDpLoop: 500,       // minimum-area DP up to this many rim vertices; a fan from the best corner past it
    alpha: Math.SQRT2,    // Liepa's refinement factor
    spacing: 1.0,         // the fill's target edge length, as a fraction of the piece's own round the rim (the surround's density)
    ringFrac: 0.25,       // the surround ring is this fraction of the hole's diameter wide...
    ringMinHops: 3,       // ...but at least this many triangle rings,
    ringMaxHops: 8,       // ...and at most this many
    ringMinSamples: 24,   // widened (up to ringMaxHops + 4) until the fit has this many vertices
    flatHops: 3,          // a surround is flat when the rim plane holds the vertices this many rings out to planarMm
    fitTolFrac: 0.04,     // a fit follows the surround when its rms residual is within this fraction of an edge...
    fitMinTolMm: 0.01,    // ...and not under this
    poleCandidates: 1500, // directions tried for the sphere chart's pole
    maxCapDeg: 150,       // the sphere chart: no rim vertex farther than this from the pole
    sagTolMm: 0.02,       // a fill triangle's centre may stand this far off the fit (a flat facet is split until it does not)
    planSurroundMax: 200, // plan() reads the surround of a flat-rimmed loop only while the piece has this many loops or fewer
    fallback: 'fair',     // when no fit can be made: 'fair' (biharmonic, reported) or 'flat'
    maxNewPoints: 30000,
    fairMaxIter: 4000,
    fairTol: 1e-9,
    nozzle: 0.4
  };
  var KEY = 4194304;       // vertex ids stay below 2^22
  var MIN_FIT_VERTS = 12;  // fewer surround vertices than this and a sphere or quadric fits anything

  /* ----------------------------------------------------------------- math */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function unit(a) { var L = len(a); return L > 0 ? [a[0] / L, a[1] / L, a[2] / L] : null; }
  function deg(r) { return r * 180 / Math.PI; }
  function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function triCount(s) { return (s && s.length) ? (s.length / 9) | 0 : 0; }
  function ptOf(M, v) { return [M.pos[v * 3], M.pos[v * 3 + 1], M.pos[v * 3 + 2]]; }

  /* ---------------------------------------------------------------- index

     The soup welded at the checker's radius, first occurrence winning, so a
     canonical vertex carries the exact float32 numbers of the soup it came
     from. */
  function weld(soup, tol) {
    tol = tol || DEFAULTS.weldTol;
    var nt = triCount(soup), n = nt * 3;
    var pos = [], f = new Int32Array(n), exact = new Map(), cells = new Map();
    var inv = 1 / tol, tol2 = tol * tol;
    for (var s = 0; s < n; s++) {
      var x = soup[s * 3], y = soup[s * 3 + 1], z = soup[s * 3 + 2];
      var k0 = x + ',' + y + ',' + z, id = exact.get(k0);
      if (id === undefined) {
        var ci = Math.floor(x * inv), cj = Math.floor(y * inv), ck = Math.floor(z * inv), found = -1;
        for (var di = -1; di <= 1 && found < 0; di++) for (var dj = -1; dj <= 1 && found < 0; dj++) for (var dk = -1; dk <= 1 && found < 0; dk++) {
          var b = cells.get((ci + di) + ',' + (cj + dj) + ',' + (ck + dk));
          if (!b) continue;
          for (var q = 0; q < b.length; q++) {
            var v = b[q], ex = pos[v * 3] - x, ey = pos[v * 3 + 1] - y, ez = pos[v * 3 + 2] - z;
            if (ex * ex + ey * ey + ez * ez <= tol2) { found = v; break; }
          }
        }
        if (found < 0) {
          found = pos.length / 3; pos.push(x, y, z);
          var ck2 = ci + ',' + cj + ',' + ck, bb = cells.get(ck2);
          if (!bb) cells.set(ck2, bb = []);
          bb.push(found);
        }
        id = found;
        exact.set(k0, id);
      }
      f[s] = id;
    }
    return { nv: pos.length / 3, pos: Float64Array.from(pos), nt: nt, f: f, tol: tol };
  }

  /* Directed half-edge map a>b -> t*3+e (the first use), and how many times
     each directed edge is used. */
  function halfEdges(M) {
    var he = new Map(), dup = 0;
    for (var t = 0; t < M.nt; t++) {
      var a = M.f[t * 3], b = M.f[t * 3 + 1], c = M.f[t * 3 + 2];
      if (a === b || b === c || a === c) continue;
      for (var e = 0; e < 3; e++) {
        var u = M.f[t * 3 + e], v = M.f[t * 3 + (e + 1) % 3], k = u * M.nv + v;
        if (he.has(k)) dup++; else he.set(k, t * 3 + e);
      }
    }
    return { he: he, dup: dup };
  }

  /* ---------------------------------------------------------------- loops

     A boundary half-edge u>v has no twin v>u. Loops are traced by turning
     round v through the faces: from the face that owns u>v, cross each edge
     out of v to the face beyond it until an edge out of v has no twin. That is
     the next boundary half-edge OF THE SAME FAN, so at a pinch vertex (where a
     loop touches itself, or two loops meet) every loop stays a simple cycle
     and none crosses another. A cycle that still visits one vertex twice is cut
     at the repeat into simple cycles. */
  function traceLoops(M, H) {
    var bnd = [];
    H.he.forEach(function (code, k) {
      var u = Math.floor(k / M.nv), v = k - u * M.nv;
      if (!H.he.has(v * M.nv + u)) bnd.push(k);
    });
    bnd.sort(function (a, b) { return a - b; });
    var next = new Map();
    function nextOf(k) {
      var v = k % M.nv, code = H.he.get(k), guard = 0;
      for (;;) {
        if (guard++ > 4000) return -1;
        var t = (code / 3) | 0, e = code % 3;
        // face t holds the edge (u>v) at slot e: vertices u=f[e], v=f[e+1], w=f[e+2]
        var w = M.f[t * 3 + (e + 2) % 3];
        var twin = H.he.get(w * M.nv + v);                // the face across v>w holds w>v
        if (twin === undefined) return v * M.nv + w;      // v>w is a boundary half-edge: the loop turns onto it
        // that face holds w>v at slot twin%3; its vertices go w, v, x - the edge
        // INTO v is w>v. Round again with that edge as the one in.
        code = twin;
      }
    }
    var seen = new Set(), loops = [], bad = 0;
    for (var i = 0; i < bnd.length; i++) {
      var k0 = bnd[i];
      if (seen.has(k0)) continue;
      var cyc = [], k = k0, ok = true, guard = 0;
      while (!seen.has(k)) {
        seen.add(k); cyc.push(k);
        if (!next.has(k)) next.set(k, nextOf(k));
        var nk = next.get(k);
        if (nk < 0 || !H.he.has(nk) || H.he.has((nk % M.nv) * M.nv + Math.floor(nk / M.nv))) { ok = false; break; }
        k = nk;
        if (guard++ > bnd.length + 2) { ok = false; break; }
      }
      if (!ok || k !== k0) { bad++; continue; }
      var verts = cyc.map(function (kk) { return Math.floor(kk / M.nv); });
      cutRepeats(verts).forEach(function (sub) { if (sub.length >= 3) loops.push(sub); });
    }
    return { loops: loops, unclosed: bad };
  }
  /* A vertex list that visits one vertex twice, as simple cycles. */
  function cutRepeats(verts) {
    var out = [], stack = [], at = new Map();
    for (var i = 0; i < verts.length; i++) {
      var v = verts[i];
      if (at.has(v)) {
        var from = at.get(v), cyc = stack.splice(from);
        cyc.forEach(function (c) { at.delete(c); });
        out.push(cyc);
      }
      at.set(v, stack.length); stack.push(v);
    }
    if (stack.length) out.push(stack);
    return out;
  }

  /* ---------------------------------------------------------- the report */
  function planeFit(pts) {
    var n = pts.length, c = [0, 0, 0], i, k;
    for (i = 0; i < n; i++) c = add(c, pts[i]);
    c = mul(c, 1 / n);
    var C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (i = 0; i < n; i++) {
      var d = sub(pts[i], c);
      for (var a = 0; a < 3; a++) for (var b = 0; b < 3; b++) C[a][b] += d[a] * d[b];
    }
    var V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var sweep = 0; sweep < 30; sweep++) {
      var off = Math.abs(C[0][1]) + Math.abs(C[0][2]) + Math.abs(C[1][2]);
      if (off < 1e-18) break;
      for (var p = 0; p < 2; p++) for (var q = p + 1; q < 3; q++) {
        if (Math.abs(C[p][q]) < 1e-30) continue;
        var th = (C[q][q] - C[p][p]) / (2 * C[p][q]);
        var t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
        for (k = 0; k < 3; k++) {
          var akp = C[k][p], akq = C[k][q];
          C[k][p] = cs * akp - sn * akq; C[k][q] = sn * akp + cs * akq;
        }
        for (k = 0; k < 3; k++) {
          var apk = C[p][k], aqk = C[q][k];
          C[p][k] = cs * apk - sn * aqk; C[q][k] = sn * apk + cs * aqk;
        }
        for (k = 0; k < 3; k++) {
          var vkp = V[k][p], vkq = V[k][q];
          V[k][p] = cs * vkp - sn * vkq; V[k][q] = sn * vkp + cs * vkq;
        }
      }
    }
    var lo = 0;
    for (k = 1; k < 3; k++) if (C[k][k] < C[lo][lo]) lo = k;
    var nrm = [V[0][lo], V[1][lo], V[2][lo]];
    var dev = 0, hi = -Infinity, lo2 = Infinity;
    for (i = 0; i < n; i++) {
      var sd = dot(sub(pts[i], c), nrm);
      dev = Math.max(dev, Math.abs(sd));
      if (sd > hi) hi = sd;
      if (sd < lo2) lo2 = sd;
    }
    // flatness: the width of the slab between two parallel planes that holds
    // every point (the engineer's flatness), not the distance from the fit.
    return { centre: c, normal: nrm, deviationMm: dev, flatnessMm: hi - lo2 };
  }

  /* Loops as objects. id: the loop's place in the list, longest loop first,
     ties by lowest vertex. Valid for THIS soup only - patch one and the ids of
     the rest shift; ask again. */
  function loopsOf(soup, M, H) {
    M = M || weld(soup);
    H = H || halfEdges(M);
    var tr = traceLoops(M, H);
    var list = tr.loops.map(function (verts) {
      var pts = verts.map(function (v) { return ptOf(M, v); });
      var perim = 0;
      for (var i = 0; i < pts.length; i++) perim += len(sub(pts[(i + 1) % pts.length], pts[i]));
      var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      pts.forEach(function (p) { for (var k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; } });
      return { verts: verts, pts: pts, n: verts.length, perimeterMm: perim, lo: lo, hi: hi,
               minVert: Math.min.apply(null, verts) };
    });
    list.sort(function (a, b) { return b.n - a.n || a.minVert - b.minVert; });
    list.forEach(function (l, i) { l.id = i; });
    list.unclosed = tr.unclosed;
    return list;
  }
  function loops(soup) { return loopsOf(soup); }

  /* Planar? how far from its plane, how wide. */
  function describe(soup, loop) {
    var fit = planeFit(loop.pts);
    var r = 0, i;
    for (i = 0; i < loop.pts.length; i++) r = Math.max(r, len(sub(loop.pts[i], fit.centre)));
    // the polygon's area vector about the fit normal: sign tells which way the fill faces
    var A = [0, 0, 0];
    for (i = 0; i < loop.pts.length; i++) A = add(A, cross(sub(loop.pts[i], fit.centre), sub(loop.pts[(i + 1) % loop.pts.length], fit.centre)));
    var areaMm2 = len(A) / 2;
    return {
      planar: fit.flatnessMm <= DEFAULTS.planarMm,
      planarMm: fit.flatnessMm, normal: fit.normal, centre: fit.centre,
      radiusMm: r, perimeterMm: loop.perimeterMm, areaMm2: areaMm2, vertices: loop.n
    };
  }

  /* ---------------------------------------------------------- topology */
  function topology(soup, tol) {
    var M = weld(soup, tol), n = M.nt, nv = M.nv;
    var und = new Map(), dir = new Map(), degenerate = 0, t;
    var parent = new Int32Array(n);
    for (t = 0; t < n; t++) parent[t] = t;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    for (t = 0; t < n; t++) {
      var a = M.f[t * 3], b = M.f[t * 3 + 1], c = M.f[t * 3 + 2];
      if (a === b || b === c || a === c) { degenerate++; continue; }
      for (var e = 0; e < 3; e++) {
        var u = M.f[t * 3 + e], v = M.f[t * 3 + (e + 1) % 3], k = u < v ? u * nv + v : v * nv + u;
        var L = und.get(k); if (!L) und.set(k, L = []);
        L.push(t);
        var dk = u * nv + v;
        dir.set(dk, (dir.get(dk) || 0) + 1);
      }
    }
    var open = 0, nm = 0, bad = 0;
    und.forEach(function (L) {
      if (L.length === 1) open++; else if (L.length > 2) nm++;
      for (var j = 1; j < L.length; j++) { var ra = find(L[0]), rb = find(L[j]); if (ra !== rb) parent[ra] = rb; }
    });
    dir.forEach(function (cnt) { if (cnt > 1) bad++; });
    var roots = {}, shells = 0, used = new Uint8Array(nv);
    for (t = 0; t < n; t++) {
      var a2 = M.f[t * 3], b2 = M.f[t * 3 + 1], c2 = M.f[t * 3 + 2];
      if (a2 === b2 || b2 === c2 || a2 === c2) continue;
      used[a2] = used[b2] = used[c2] = 1;
      var r = find(t); if (!roots[r]) { roots[r] = 1; shells++; }
    }
    var V = 0; for (var i = 0; i < nv; i++) V += used[i];
    return { tris: n, verts: V, edges: und.size, open: open, nm: nm, badWinding: bad, degenerate: degenerate,
             shells: shells, euler: V - und.size + (n - degenerate) };
  }

  /* ------------------------------------------------- triangulating a loop

     P is the loop in FILL order (the boundary order reversed, so each rim edge
     is used the other way round). Minimum-area triangulation by dynamic
     programming, with a little preference for well-shaped triangles.

     Two modes. GRAPH: the loop, flattened onto its best plane, is a simple
     polygon - then a chord must run inside it and every triangle must wind the
     polygon's way, so the result is a proper triangulation of the flattened
     polygon. 3D: the loop folds over itself when flattened (it wraps a corner,
     a ridge) - then only the chords the mesh already has are refused. */
  function segCross2(a, b, c, d) {
    // proper crossing of ab and cd in 2D (touching ends do not count)
    function o(p, q, r) { return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); }
    var d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }
  function inPoly2(pt, poly) {
    var inside = false;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  function frameOf(fit) {
    var n = fit.normal, a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    var u = unit(cross(n, a)), v = cross(n, u);
    return { o: fit.centre, n: n, u: u, v: v };
  }
  function to2(F, p) { var d = sub(p, F.o); return [dot(d, F.u), dot(d, F.v)]; }

  function triShape(a, b, c) {
    var ab = len(sub(b, a)), bc = len(sub(c, b)), ca = len(sub(a, c));
    var ar = len(cross(sub(b, a), sub(c, a))) / 2;
    return { area: ar, q: ar > 0 ? Math.max(1, (ab + bc + ca) * (ab + bc + ca) / (12 * Math.sqrt(3) * ar)) : 1e9 };
  }

  function triangulateLoop(M, P, nbr, opts, chart2) {
    var n = P.length, pts = P.map(function (v) { return ptOf(M, v); });
    var p2, i, j, k;
    if (n === 3) return { tris: [[0, 1, 2]], mode: 'single' };
    if (chart2) p2 = chart2;          // the fitted surface's own coordinates: the rim, as it lies in them, is the polygon
    else {
      var fit = planeFit(pts), F = frameOf(fit);
      p2 = pts.map(function (p) { return to2(F, p); });
    }
    // the fill order's orientation about the fit normal
    var A2 = 0;
    for (i = 0; i < n; i++) { var a = p2[i], b = p2[(i + 1) % n]; A2 += a[0] * b[1] - b[0] * a[1]; }
    var orient = A2 >= 0 ? 1 : -1, perim = 0;
    for (i = 0; i < n; i++) perim += chart2 ? Math.hypot(p2[(i + 1) % n][0] - p2[i][0], p2[(i + 1) % n][1] - p2[i][1]) : len(sub(pts[(i + 1) % n], pts[i]));
    var graph = Math.abs(A2) / 2 > 1e-4 * perim * perim;
    for (i = 0; graph && i < n; i++) {
      for (j = i + 2; graph && j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        if (segCross2(p2[i], p2[(i + 1) % n], p2[j], p2[(j + 1) % n])) graph = false;
      }
    }
    if (n > opts.maxDpLoop) {
      var big = graph ? earClip(P, p2, orient, nbr) : fanTriangulate(P, nbr);
      return big ? { tris: big, mode: graph ? 'ears' : 'fan' } : null;
    }
    var INF = 1e300, W = new Float64Array(n * n).fill(INF), K = new Int32Array(n * n).fill(-1);
    var chord = new Int8Array(n * n);          // 0 unknown, 1 ok, -1 no
    function chordOk(i2, j2) {
      var key = i2 * n + j2;
      if (chord[key]) return chord[key] > 0;
      var ok = true, va = P[i2], vb = P[j2];
      if (va === vb) ok = false;
      var nb = nbr.get(va);
      if (ok && nb && nb.has(vb)) ok = false;            // the mesh already has that edge
      if (ok && graph) {
        for (var e = 0; e < n && ok; e++) {
          var e1 = e, e2 = (e + 1) % n;
          if (e1 === i2 || e1 === j2 || e2 === i2 || e2 === j2) continue;
          if (segCross2(p2[i2], p2[j2], p2[e1], p2[e2])) ok = false;
        }
        if (ok) {
          var mid = [(p2[i2][0] + p2[j2][0]) / 2, (p2[i2][1] + p2[j2][1]) / 2];
          if (!inPoly2(mid, p2)) ok = false;
        }
      }
      chord[key] = ok ? 1 : -1;
      return ok;
    }
    function triCost(i2, k2, j2) {
      if (P[i2] === P[k2] || P[k2] === P[j2] || P[i2] === P[j2]) return INF;
      if (graph) {
        var s = ((p2[k2][0] - p2[i2][0]) * (p2[j2][1] - p2[i2][1]) - (p2[k2][1] - p2[i2][1]) * (p2[j2][0] - p2[i2][0])) * orient;
        if (!(s > 1e-12 * perim * perim)) return INF;
      }
      var sh = triShape(pts[i2], pts[k2], pts[j2]);
      if (!(sh.area > 0)) return INF;
      return sh.area * (1 + 0.1 * Math.min(sh.q - 1, 50));
    }
    for (i = 0; i + 1 < n; i++) W[i * n + i + 1] = 0;
    for (var span = 2; span < n; span++) {
      for (i = 0; i + span < n; i++) {
        j = i + span;
        if (!(i === 0 && j === n - 1) && !chordOk(i, j)) continue;
        var best = INF, bk = -1;
        for (k = i + 1; k < j; k++) {
          var l = W[i * n + k], r = W[k * n + j];
          if (l >= INF || r >= INF) continue;
          var c = triCost(i, k, j);
          if (c >= INF) continue;
          c += l + r;
          if (c < best) { best = c; bk = k; }
        }
        W[i * n + j] = best; K[i * n + j] = bk;
      }
    }
    if (W[n - 1] >= INF) {
      if (chart2) return null;                       // a chart needs a proper planar triangulation or nothing
      if (graph) { opts = Object.assign({}, opts); return triangulateLoopRetry(M, P, nbr, opts); }
      return null;
    }
    var out = [];
    (function walk(i2, j2) {
      if (j2 - i2 < 2) return;
      var k2 = K[i2 * n + j2];
      out.push([i2, k2, j2]);
      walk(i2, k2); walk(k2, j2);
    })(0, n - 1);
    return { tris: out, mode: graph ? 'graph' : '3d' };
  }
  // no valid planar triangulation (a tangled rim): try again as a 3D loop
  function triangulateLoopRetry(M, P, nbr, opts) {
    var o = Object.assign({}, opts, { forceThreeD: true });
    return triangulateLoop3d(M, P, nbr, o);
  }
  function triangulateLoop3d(M, P, nbr, opts) {
    var n = P.length, pts = P.map(function (v) { return ptOf(M, v); });
    var INF = 1e300, W = new Float64Array(n * n).fill(INF), K = new Int32Array(n * n).fill(-1), i, j, k;
    function chordOk(i2, j2) { var nb = nbr.get(P[i2]); return P[i2] !== P[j2] && !(nb && nb.has(P[j2])); }
    for (i = 0; i + 1 < n; i++) W[i * n + i + 1] = 0;
    for (var span = 2; span < n; span++) {
      for (i = 0; i + span < n; i++) {
        j = i + span;
        if (!(i === 0 && j === n - 1) && !chordOk(i, j)) continue;
        var best = INF, bk = -1;
        for (k = i + 1; k < j; k++) {
          var l = W[i * n + k], r = W[k * n + j];
          if (l >= INF || r >= INF) continue;
          var sh = triShape(pts[i], pts[k], pts[j]);
          if (!(sh.area > 0)) continue;
          var c = l + r + sh.area * (1 + 0.1 * Math.min(sh.q - 1, 50));
          if (c < best) { best = c; bk = k; }
        }
        W[i * n + j] = best; K[i * n + j] = bk;
      }
    }
    if (W[n - 1] >= INF) return null;
    var out = [];
    (function walk(i2, j2) {
      if (j2 - i2 < 2) return;
      var k2 = K[i2 * n + j2];
      out.push([i2, k2, j2]);
      walk(i2, k2); walk(k2, j2);
    })(0, n - 1);
    return { tris: out, mode: '3d' };
  }
  /* A loop too long for the dynamic programme that is a simple polygon on its
     plane: ear clipping (first valid ear), refused chords the mesh already has. */
  function earClip(P, p2, orient, nbr) {
    var n = P.length, idx = [], i;
    for (i = 0; i < n; i++) idx.push(i);
    function turn(a, b, c) {
      return ((p2[b][0] - p2[a][0]) * (p2[c][1] - p2[a][1]) - (p2[b][1] - p2[a][1]) * (p2[c][0] - p2[a][0])) * orient;
    }
    var tris = [], guard = 0;
    while (idx.length > 3 && guard++ < n + 5) {
      var found = -1, L = idx.length;
      for (var m = 0; m < L && found < 0; m++) {
        var a = idx[(m - 1 + L) % L], b = idx[m], c = idx[(m + 1) % L];
        if (!(turn(a, b, c) > 0)) continue;
        var nb = nbr.get(P[a]);
        if (P[a] === P[c] || (nb && nb.has(P[c]))) continue;
        var empty = true;
        for (var k = 0; k < L && empty; k++) {
          var q = idx[k];
          if (q === a || q === b || q === c) continue;
          if (turn(a, b, q) >= 0 && turn(b, c, q) >= 0 && turn(c, a, q) >= 0) empty = false;
        }
        if (empty) found = m;
      }
      if (found < 0) return null;
      tris.push([idx[(found - 1 + L) % L], idx[found], idx[(found + 1) % L]]);
      idx.splice(found, 1);
    }
    if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
    return tris.length === n - 2 ? tris : null;
  }
  /* A loop too long for the dynamic programme, and not a simple polygon on its
     plane: a fan from the first corner
     whose chords the mesh does not already have (or null). */
  function fanTriangulate(P, nbr) {
    var n = P.length;
    for (var apex = 0; apex < n; apex++) {
      var ok = true, nb = nbr.get(P[apex]);
      for (var k = 2; k < n - 1 && ok; k++) {
        var v = P[(apex + k) % n];
        if (v === P[apex] || (nb && nb.has(v))) ok = false;
      }
      if (!ok) continue;
      var out = [];
      for (k = 1; k + 1 < n; k++) out.push([apex, (apex + k) % n, (apex + k + 1) % n]);
      return out;
    }
    return null;
  }

  /* ------------------------------------------------------------ the fill

     Q holds the new vertices (ids from M.nv up), the fill's triangles and the
     directed edges they use. A rim edge is used once, by a fill triangle, the
     other way round to the piece's own use: it is the only kind of edge with no
     twin among the fill's triangles, and the only kind never flipped. */
  function Fill(M) {
    this.M = M; this.pos = []; this.tris = []; this.E = new Map(); this.sigma = new Map();
    this.chart = null; this.uv = new Map(); this.orient = 1;      // set when the fill is built in a fitted surface's chart
  }
  /* Build the fill in a chart: every vertex has coordinates in it (the rim's from
     the caller, a new point's from where it was put), triangles must keep their
     orientation in it, and a new point is put ON the fit by chart.toSurf. */
  Fill.prototype.useChart = function (chart, P, p2, orient) {
    this.chart = chart; this.orient = orient;
    for (var i = 0; i < P.length; i++) this.uv.set(P[i], p2[i]);
  };
  Fill.prototype.areaUV = function (a, b, c) {
    var A = this.uv.get(a), B = this.uv.get(b), C = this.uv.get(c);
    return ((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0])) * this.orient;
  };
  /* The triangle whose inside holds chart point q, or -1 (outside the fill, or on
     an edge: such a point is not inserted). Walks from the last triangle made (points
     come in near one another) toward q across the edge it is on the wrong side of; if
     the walk leaves the fill (a concave rim) every triangle is tried. */
  Fill.prototype.locate = function (q, eps) {
    var o = this.orient, t = this._hint, steps = 0;
    function side(A, B) { return ((B[0] - A[0]) * (q[1] - A[1]) - (B[1] - A[1]) * (q[0] - A[0])) * o; }
    if (t != null && this.tris[t]) {
      for (; steps < 4000; steps++) {
        var r = this.tris[t], A = this.uv.get(r[0]), B = this.uv.get(r[1]), C = this.uv.get(r[2]);
        var s1 = side(A, B), s2 = side(B, C), s3 = side(C, A);
        if (s1 > eps && s2 > eps && s3 > eps) return t;
        var e = s1 <= s2 && s1 <= s3 ? 0 : (s2 <= s3 ? 1 : 2), u = this.E.get(r[(e + 1) % 3] * KEY + r[e]);
        if (u === undefined) break;
        t = u;
      }
    }
    for (t = 0; t < this.tris.length; t++) {
      var r2 = this.tris[t];
      if (!r2) continue;
      var A2 = this.uv.get(r2[0]), B2 = this.uv.get(r2[1]), C2 = this.uv.get(r2[2]);
      if (side(A2, B2) > eps && side(B2, C2) > eps && side(C2, A2) > eps) return t;
    }
    return -1;
  };
  /* Lawson flips from a stack of [triangle, a, b] (the directed edge a>b of that triangle):
     flip an edge while the vertex across it is inside the circle through the triangle's
     corners, in the chart. Never across a rim edge (it has no triangle on its other side),
     never to an edge the piece already has, never to a triangle that would not keep the
     chart's orientation. */
  Fill.prototype.legalize = function (stack, nbr, eps) {
    var guard = 0, flips = 0;
    while (stack.length && guard++ < 1000000) {
      var it = stack.pop(), tt = this.tris[it[0]], a = it[1], b = it[2];
      if (!tt) continue;
      var k = tt.indexOf(a);
      if (k < 0 || tt[(k + 1) % 3] !== b) continue;
      var p = tt[(k + 2) % 3], u = this.E.get(b * KEY + a);
      if (u === undefined) continue;                                  // a rim edge
      var s = this.tris[u], q = s[0] === b && s[1] === a ? s[2] : (s[1] === b && s[2] === a ? s[0] : s[1]);
      var A = this.uv.get(a), B = this.uv.get(b), Pp = this.uv.get(p), Qq = this.uv.get(q);
      var ax = A[0] - Qq[0], ay = A[1] - Qq[1], bx = B[0] - Qq[0], by = B[1] - Qq[1], cx = Pp[0] - Qq[0], cy = Pp[1] - Qq[1];
      var inc = ((ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay)) * this.orient;
      if (!(inc > 0)) continue;                                       // q is outside the circle through a, b, p: legal
      if (!(this.areaUV(a, q, p) > eps && this.areaUV(q, b, p) > eps)) continue;
      var nbp = nbr.get(p), nbq = nbr.get(q);
      if ((nbp && nbp.has(q)) || (nbq && nbq.has(p)) || this.E.has(p * KEY + q) || this.E.has(q * KEY + p)) continue;
      this.setTri(it[0], a, q, p);
      this.setTri(u, q, b, p);
      stack.push([it[0], a, q], [u, q, b]);
      flips++;
    }
    return flips;
  };
  /* Every edge of the fill, legalized: the triangles the minimum-area triangulation
     left along the rim (three rim vertices in a row) are flipped away once there are
     points inside to flip them toward. */
  Fill.prototype.delaunay = function (nbr, eps) {
    var total = 0;
    for (var pass = 0; pass < 8; pass++) {
      var stack = [];
      for (var t = 0; t < this.tris.length; t++) {
        var r = this.tris[t];
        if (r) stack.push([t, r[0], r[1]], [t, r[1], r[2]], [t, r[2], r[0]]);
      }
      var f = this.legalize(stack, nbr, eps);
      total += f;
      if (!f) break;
    }
    return total;
  };
  /* Put a point of the fit into the fill (split its triangle in three) and keep the
     triangles Delaunay in the chart: Lawson flips, never across a rim edge (it has
     no triangle on its other side) and never onto an edge the piece already has. */
  Fill.prototype.insert = function (uv, pt, sigma, nbr, eps) {
    var t = this.locate(uv, eps);
    if (t < 0) return false;
    var r = this.tris[t], v = this.addVertex(pt, sigma);
    this.uv.set(v, uv);
    this.setTri(t, r[0], r[1], v);
    var t2 = this.addTri(r[1], r[2], v), t3 = this.addTri(r[2], r[0], v);
    this._hint = t;
    this.legalize([[t, r[0], r[1]], [t2, r[1], r[2]], [t3, r[2], r[0]]], nbr, eps);
    return true;
  };
  Fill.prototype.P = function (v) {
    if (v < this.M.nv) return [this.M.pos[v * 3], this.M.pos[v * 3 + 1], this.M.pos[v * 3 + 2]];
    var o = (v - this.M.nv) * 3;
    return [this.pos[o], this.pos[o + 1], this.pos[o + 2]];
  };
  Fill.prototype.addVertex = function (p, sigma) {
    var id = this.M.nv + this.pos.length / 3;
    this.pos.push(p[0], p[1], p[2]);
    this.sigma.set(id, sigma);
    return id;
  };
  Fill.prototype.addTri = function (a, b, c) {
    var t = this.tris.length;
    this.tris.push([a, b, c]);
    this.E.set(a * KEY + b, t); this.E.set(b * KEY + c, t); this.E.set(c * KEY + a, t);
    return t;
  };
  Fill.prototype.setTri = function (t, a, b, c) {
    var r = this.tris[t], E = this.E;
    // only the edges this triangle still owns: after a flip the other triangle may already hold one
    for (var k = 0; k < 3; k++) { var key = r[k] * KEY + r[(k + 1) % 3]; if (E.get(key) === t) E.delete(key); }
    this.tris[t] = [a, b, c];
    this.E.set(a * KEY + b, t); this.E.set(b * KEY + c, t); this.E.set(c * KEY + a, t);
  };
  Fill.prototype.normal = function (t) {
    var r = this.tris[t], a = this.P(r[0]), b = this.P(r[1]), c = this.P(r[2]);
    return cross(sub(b, a), sub(c, a));
  };
  function minAngle(a, b, c) {
    var ab = len(sub(b, a)), bc = len(sub(c, b)), ca = len(sub(a, c));
    function ang(x, y, z) { var v = (y * y + z * z - x * x) / (2 * y * z); return Math.acos(Math.max(-1, Math.min(1, v))); }
    if (!(ab > 0 && bc > 0 && ca > 0)) return 0;
    return Math.min(ang(bc, ab, ca), ang(ca, ab, bc), ang(ab, bc, ca));
  }

  /* Liepa's rule: split a triangle at its centre while its centre is farther
     from its corners than the neighbours' edge length there - then relax by
     flipping, never across the rim and never onto an edge the mesh has. */
  Fill.prototype.refine = function (nbr, opts) {
    var alpha = opts.alpha, self = this, added = 0;
    for (var pass = 0; pass < 14; pass++) {
      var split = 0, nT = this.tris.length;
      for (var t = 0; t < nT; t++) {
        var r = this.tris[t];
        if (!r) continue;
        var pa = this.P(r[0]), pb = this.P(r[1]), pc = this.P(r[2]), c, cuv = null;
        if (this.chart) {              // the centre in the chart, put ON the fit
          var ua = this.uv.get(r[0]), ub = this.uv.get(r[1]), uc = this.uv.get(r[2]);
          cuv = [(ua[0] + ub[0] + uc[0]) / 3, (ua[1] + ub[1] + uc[1]) / 3];
          c = this.chart.toSurf(cuv);
        } else c = mul(add(add(pa, pb), pc), 1 / 3);
        var sa = this.sigma.get(r[0]), sb = this.sigma.get(r[1]), sc = this.sigma.get(r[2]);
        var sC = (sa + sb + sc) / 3;
        var da = alpha * len(sub(c, pa)), db = alpha * len(sub(c, pb)), dc = alpha * len(sub(c, pc));
        var tooBig = da > sC && db > sC && dc > sC && da > sa && db > sb && dc > sc;
        if (tooBig) {
          if (added >= opts.maxNewPoints) break;
          var v = this.addVertex(c, sC);
          if (cuv) this.uv.set(v, cuv);
          this.setTri(t, r[0], r[1], v);
          this.addTri(r[1], r[2], v);
          this.addTri(r[2], r[0], v);
          split++; added++;
        }
      }
      var flips = this.relax(nbr);
      if (!split && !flips) break;
    }
    return added;
  };
  /* On a fit, no facet may sag: an interior edge whose middle, put on the fit, stands
     more than sagTolMm off the straight edge is split at that middle (longest first, both
     triangles on it), then the fill is made Delaunay again. A flat triangle across a hole
     in a curved surface is split until it follows the surface. */
  Fill.prototype.refineSag = function (nbr, opts, eps) {
    var added = 0;
    for (var pass = 0; pass < 12; pass++) {
      var cands = [], t, e;
      for (t = 0; t < this.tris.length; t++) {
        var r = this.tris[t];
        if (!r) continue;
        for (e = 0; e < 3; e++) {
          var a = r[e], b = r[(e + 1) % 3];
          if (a > b) continue;
          var u = this.E.get(b * KEY + a);
          if (u === undefined) continue;                                 // a rim edge is the piece's
          var pa = this.P(a), pb = this.P(b), L = len(sub(pb, pa)), sg = (this.sigma.get(a) + this.sigma.get(b)) / 2;
          if (!(L > 0.5 * sg)) continue;
          var ua = this.uv.get(a), ub = this.uv.get(b), pm = this.chart.toSurf([(ua[0] + ub[0]) / 2, (ua[1] + ub[1]) / 2]);
          if (len(sub(pm, mul(add(pa, pb), 0.5))) > opts.sagTolMm) cands.push({ a: a, b: b, t: t, u: u, L: L });
        }
      }
      if (!cands.length || added >= opts.maxNewPoints) break;
      cands.sort(function (x, y) { return y.L - x.L; });
      var used = new Set();
      for (var c = 0; c < cands.length; c++) {
        var C = cands[c];
        if (used.has(C.t) || used.has(C.u)) continue;
        used.add(C.t); used.add(C.u);
        var tt = this.tris[C.t], k = tt.indexOf(C.a), p = tt[(k + 2) % 3];
        var ts = this.tris[C.u], k2 = ts.indexOf(C.b), q = ts[(k2 + 2) % 3];
        var u1 = this.uv.get(C.a), u2 = this.uv.get(C.b), um = [(u1[0] + u2[0]) / 2, (u1[1] + u2[1]) / 2];
        var v = this.addVertex(this.chart.toSurf(um), (this.sigma.get(C.a) + this.sigma.get(C.b)) / 2);
        this.uv.set(v, um);
        this.setTri(C.t, C.a, v, p); this.addTri(v, C.b, p);
        this.setTri(C.u, C.b, v, q); this.addTri(v, C.a, q);
        added++;
      }
      this.delaunay(nbr, eps);
    }
    return added;
  };
  Fill.prototype.relax = function (nbr) {
    var total = 0;
    for (var pass = 0; pass < 24; pass++) {
      var flips = 0;
      for (var t = 0; t < this.tris.length; t++) {
        var r = this.tris[t];
        if (!r) continue;
        for (var e = 0; e < 3; e++) {
          var a = r[e], b = r[(e + 1) % 3], p = r[(e + 2) % 3];
          var u = this.E.get(b * KEY + a);
          if (u === undefined) continue;                       // a rim edge
          var s = this.tris[u], q = s[0] === b && s[1] === a ? s[2] : (s[1] === b && s[2] === a ? s[0] : s[1]);
          if (p === q) continue;
          var nbp = nbr.get(p), nbq = nbr.get(q);
          if ((nbp && nbp.has(q)) || (nbq && nbq.has(p))) continue;     // the mesh has that edge
          if (this.E.has(p * KEY + q) || this.E.has(q * KEY + p)) continue;
          var A = this.P(a), B = this.P(b), Pp = this.P(p), Qq = this.P(q);
          var before = Math.min(minAngle(A, B, Pp), minAngle(B, A, Qq));
          var after = Math.min(minAngle(A, Qq, Pp), minAngle(Qq, B, Pp));
          if (!(after > before + 1e-6)) continue;
          if (this.chart) {            // both new triangles must keep the chart's orientation
            if (!(this.areaUV(a, q, p) > 0 && this.areaUV(q, b, p) > 0)) continue;
          } else {
            var n1 = cross(sub(Qq, A), sub(Pp, A)), n2 = cross(sub(B, Qq), sub(Pp, Qq));
            var o1 = cross(sub(B, A), sub(Pp, A)), o2 = cross(sub(A, B), sub(Qq, B));
            var oldN = unit(add(o1, o2));
            if (!oldN || dot(n1, oldN) <= 0 || dot(n2, oldN) <= 0) continue;
          }
          this.setTri(t, a, q, p);
          this.setTri(u, q, b, p);
          flips++;
          r = this.tris[t];
          break;
        }
      }
      total += flips;
      if (!flips) break;
    }
    return total;
  };

  /* Where the new points go: the points minimising sum |L x|^2 over the new
     points and the rim vertices, L the uniform Laplacian over the piece's own
     edges and the fill's. Conjugate gradient on the new points, three axes
     at once. Moves the new points; nothing else. */
  Fill.prototype.fair = function (rim, nbr, opts) {
    var M = this.M, nv = M.nv, nNew = this.pos.length / 3;
    if (!nNew) return { iters: 0, moved: 0 };
    var neigh = new Map(), self = this;
    function link(a, b) {
      var s = neigh.get(a); if (!s) neigh.set(a, s = new Set());
      s.add(b);
    }
    this.tris.forEach(function (r) {
      if (!r) return;
      for (var e = 0; e < 3; e++) { link(r[e], r[(e + 1) % 3]); link(r[(e + 1) % 3], r[e]); }
    });
    rim.forEach(function (v) {                                    // the piece's own edges at the rim
      var s = nbr.get(v);
      if (s) s.forEach(function (w) { link(v, w); link(w, v); });
    });
    // rows: every new vertex and every rim vertex
    var rows = [];
    for (var i = 0; i < nNew; i++) rows.push(nv + i);
    rim.forEach(function (v) { rows.push(v); });
    var rowIdx = rows.map(function (v) {
      var s = Array.from(neigh.get(v) || []), d = s.length;
      return { v: v, nb: s, w: d > 0 ? 1 / d : 0 };
    });
    var X = [new Float64Array(nNew), new Float64Array(nNew), new Float64Array(nNew)];
    var b = [new Float64Array(nNew), new Float64Array(nNew), new Float64Array(nNew)];
    for (i = 0; i < nNew; i++) for (var a = 0; a < 3; a++) X[a][i] = this.pos[i * 3 + a];
    function coordOf(v, a) { return v >= nv ? X[a][v - nv] : M.pos[v * 3 + a]; }
    // constant part of each row, and the right-hand side b = -M_F' (M_C x_C)
    var consts = rowIdx.map(function (R) {
      var c = [0, 0, 0];
      for (var a2 = 0; a2 < 3; a2++) {
        var s = 0;
        if (R.v < nv) s += M.pos[R.v * 3 + a2];
        for (var q = 0; q < R.nb.length; q++) if (R.nb[q] < nv) s -= R.w * M.pos[R.nb[q] * 3 + a2];
        c[a2] = s;
      }
      return c;
    });
    rowIdx.forEach(function (R, ri) {
      for (var a3 = 0; a3 < 3; a3++) {
        if (R.v >= nv) b[a3][R.v - nv] -= consts[ri][a3];
        for (var q = 0; q < R.nb.length; q++) if (R.nb[q] >= nv) b[a3][R.nb[q] - nv] -= (-R.w) * consts[ri][a3];
      }
    });
    function applyK(p, out) {                                    // out = M_F' M_F p
      for (var k = 0; k < nNew; k++) out[k] = 0;
      for (var ri = 0; ri < rowIdx.length; ri++) {
        var R = rowIdx[ri], y = 0;
        if (R.v >= nv) y += p[R.v - nv];
        for (var q = 0; q < R.nb.length; q++) if (R.nb[q] >= nv) y -= R.w * p[R.nb[q] - nv];
        if (y === 0) continue;
        if (R.v >= nv) out[R.v - nv] += y;
        for (q = 0; q < R.nb.length; q++) if (R.nb[q] >= nv) out[R.nb[q] - nv] -= R.w * y;
      }
    }
    var iters = 0, moved = 0;
    for (var ax = 0; ax < 3; ax++) {
      var x = X[ax], r = new Float64Array(nNew), pvec = new Float64Array(nNew), Ap = new Float64Array(nNew), Kx = new Float64Array(nNew);
      applyK(x, Kx);
      var rr = 0, bb = 0;
      for (i = 0; i < nNew; i++) { r[i] = b[ax][i] - Kx[i]; pvec[i] = r[i]; rr += r[i] * r[i]; bb += b[ax][i] * b[ax][i]; }
      var start = x.slice();
      var tol2 = opts.fairTol * opts.fairTol * Math.max(bb, 1e-30);
      for (var it = 0; it < opts.fairMaxIter && rr > tol2; it++) {
        applyK(pvec, Ap);
        var pAp = 0;
        for (i = 0; i < nNew; i++) pAp += pvec[i] * Ap[i];
        if (!(pAp > 0)) break;
        var al = rr / pAp, rr2 = 0;
        for (i = 0; i < nNew; i++) { x[i] += al * pvec[i]; r[i] -= al * Ap[i]; rr2 += r[i] * r[i]; }
        var be = rr2 / rr; rr = rr2;
        for (i = 0; i < nNew; i++) pvec[i] = r[i] + be * pvec[i];
        iters++;
      }
      for (i = 0; i < nNew; i++) moved = Math.max(moved, Math.abs(x[i] - start[i]));
    }
    for (i = 0; i < nNew; i++) for (a = 0; a < 3; a++) this.pos[i * 3 + a] = X[a][i];
    return { iters: iters, moved: moved };
  };

  /* ------------------------------------------------- the surround and its fit

     The surface round a hole is READ from the piece: a ring of its own
     vertices, out from the rim a few triangles (a quarter of the hole's
     diameter, 3 to 8 rings). A surface is fitted to that ring by least squares
     and the fill's interior vertices are put ON it - never on the loop's plane.

       plane    the surround lies in the rim's plane within 0.05 mm: the flat cap
       sphere   least squares, algebraic then polished on the true distance
       quadric  w = a u^2 + b uv + c v^2 + d u + e v + f over the best plane
                through the ring (Lift 3's local fit, nso_lift_curved.js)

     A fit FOLLOWS the surround when its rms residual is within 4% of an edge
     (and not under 0.01 mm). Sphere first; the quadric when the sphere does
     not follow; neither: the fill is faired from the rim (or flat) and says so.

     Each fit brings a CHART - flat coordinates (u, v) for the surface, with
     toSurf(uv) the point of the fit above them. The loop is triangulated in the
     chart, refined in it (a new point is the centre of its triangle IN THE
     CHART, put on the fit), and flipped with the chart's orientation test, so
     the fill is a proper triangulation of the hole however far the rim wraps.
     The sphere's chart is the stereographic projection from the point opposite
     a pole inside the hole (conformal: a small hole is nearly flat in it, a
     hole bigger than a hemisphere still lies flat in it). */
  function solveSmall(A, b, n) {
    var i, j, k;
    for (i = 0; i < n; i++) {
      var piv = i;
      for (j = i + 1; j < n; j++) if (Math.abs(A[j][i]) > Math.abs(A[piv][i])) piv = j;
      if (Math.abs(A[piv][i]) < 1e-14) return null;
      var tmp = A[i]; A[i] = A[piv]; A[piv] = tmp;
      var tb = b[i]; b[i] = b[piv]; b[piv] = tb;
      for (j = i + 1; j < n; j++) {
        var f = A[j][i] / A[i][i];
        for (k = i; k < n; k++) A[j][k] -= f * A[i][k];
        b[j] -= f * b[i];
      }
    }
    var x = new Array(n);
    for (i = n - 1; i >= 0; i--) {
      var s2 = b[i];
      for (j = i + 1; j < n; j++) s2 -= A[i][j] * x[j];
      x[i] = s2 / A[i][i];
    }
    return x;
  }

  function adjacencyOf(M) {
    if (M._adj) return M._adj;
    var adj = new Array(M.nv), i;
    for (i = 0; i < M.nv; i++) adj[i] = [];
    for (var t = 0; t < M.nt; t++) {
      var a = M.f[t * 3], b = M.f[t * 3 + 1], c = M.f[t * 3 + 2];
      adj[a].push(b, c); adj[b].push(a, c); adj[c].push(a, b);
    }
    M._adj = adj;
    return adj;
  }
  /* The largest distance between two rim vertices: "the loop's diameter". */
  function loopDiameter(pts) {
    var stride = Math.ceil(pts.length / 500), q = [], i, j, best = 0;     // a long rim: every few vertices is enough
    for (i = 0; i < pts.length; i += stride) q.push(pts[i]);
    for (i = 0; i < q.length; i++) for (j = i + 1; j < q.length; j++) {
      var dx = q[i][0] - q[j][0], dy = q[i][1] - q[j][1], dz = q[i][2] - q[j][2], d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > best) best = d2;
    }
    return Math.sqrt(best);
  }
  /* The ring of the piece's own vertices round a rim: rim = depth 0, then the
     vertices one triangle edge out, and so on. hops: a fixed number of rings,
     else the hole's size decides (and the ring is widened to hold enough
     vertices to fit). edgeMm is the surround's own triangle size: the mean
     length of the edges between its vertices. */
  function surroundOf(M, adj, rim, D, o, hops) {
    var depth = new Map(), frontier = [], es = 0, ec = 0;
    rim.forEach(function (v) { depth.set(v, 0); frontier.push(v); });
    rim.forEach(function (v) {
      var pv = ptOf(M, v);
      adj[v].forEach(function (w) { es += len(sub(ptOf(M, w), pv)); ec++; });
    });
    var rimEdge = ec ? es / ec : 1;
    var want = hops != null ? hops : Math.max(o.ringMinHops, Math.min(o.ringMaxHops, Math.ceil(o.ringFrac * D / rimEdge)));
    var cap = hops != null ? hops : o.ringMaxHops + 4, d = 0;
    while (d < cap && (d < want || (hops == null && depth.size < o.ringMinSamples))) {
      var nxt = [];
      frontier.forEach(function (v) {
        adj[v].forEach(function (w) { if (!depth.has(w)) { depth.set(w, d + 1); nxt.push(w); } });
      });
      if (!nxt.length) break;
      frontier = nxt; d++;
    }
    var verts = Array.from(depth.keys()), sum = 0, cnt = 0;
    verts.forEach(function (v) {
      var pv = ptOf(M, v), seen = {};
      adj[v].forEach(function (w) {
        if (w > v && depth.has(w) && !seen[w]) { seen[w] = 1; sum += len(sub(ptOf(M, w), pv)); cnt++; }
      });
    });
    return { depth: depth, verts: verts, hops: d, edgeMm: cnt ? sum / cnt : rimEdge, rimEdgeMm: rimEdge };
  }
  /* Is the surround flat? The rim lies in a plane within planarMm AND the ring
     (the first flatHops rings out from it) lies in that same plane: 4 in 5 of
     its vertices within planarMm. A circular hole in a sphere has a flat RIM;
     it is the ring that tells the sphere from a floor. */
  function surroundFlat(M, adj, rim, o) {
    var ring = surroundOf(M, adj, rim, 0, o, o.flatHops);
    var pf = planeFit(rim.map(function (v) { return ptOf(M, v); })), devs = [];
    ring.verts.forEach(function (v) {
      if (ring.depth.get(v) > 0) devs.push(Math.abs(dot(sub(ptOf(M, v), pf.centre), pf.normal)));
    });
    devs.sort(function (a, b) { return a - b; });
    var p80 = devs.length ? devs[Math.min(devs.length - 1, Math.floor(devs.length * 0.8))] : 0;
    return { flat: pf.flatnessMm <= o.planarMm && p80 <= o.planarMm, rimFlatMm: pf.flatnessMm, ringDevMm: p80, plane: pf };
  }

  /* Least-squares sphere: the algebraic fit (|x|^2 = 2 a.x + k, linear in a and
     k), then Gauss-Newton on the true distance residual |x - a| - R. */
  function fitSphere(pts) {
    var n = pts.length, i, a, b, k;
    if (n < 8) return null;
    var c0 = [0, 0, 0];
    pts.forEach(function (p) { c0 = add(c0, p); });
    c0 = mul(c0, 1 / n);
    var sc = 0;
    pts.forEach(function (p) { var d = sub(p, c0); sc += dot(d, d); });
    sc = Math.sqrt(sc / n);
    if (!(sc > 1e-12)) return null;
    var q = pts.map(function (p) { return mul(sub(p, c0), 1 / sc); });
    var AtA = [], Atb = [0, 0, 0, 0];
    for (a = 0; a < 4; a++) AtA.push([0, 0, 0, 0]);
    q.forEach(function (x) {
      var row = [2 * x[0], 2 * x[1], 2 * x[2], 1], rhs = dot(x, x);
      for (var r = 0; r < 4; r++) { Atb[r] += row[r] * rhs; for (var c = 0; c < 4; c++) AtA[r][c] += row[r] * row[c]; }
    });
    var sol = solveSmall(AtA, Atb, 4);
    if (!sol) return null;
    var cen = [sol[0], sol[1], sol[2]], R2 = sol[3] + dot(cen, cen);
    if (!(R2 > 0) || !isFinite(R2)) return null;
    var R = Math.sqrt(R2);
    for (var it = 0; it < 10; it++) {
      var JtJ = [], Jtr = [0, 0, 0, 0];
      for (a = 0; a < 4; a++) JtJ.push([0, 0, 0, 0]);
      for (i = 0; i < q.length; i++) {
        var d = sub(q[i], cen), L = len(d);
        if (L < 1e-12) continue;
        var J = [-d[0] / L, -d[1] / L, -d[2] / L, -1], r = L - R;
        for (a = 0; a < 4; a++) { Jtr[a] -= J[a] * r; for (b = 0; b < 4; b++) JtJ[a][b] += J[a] * J[b]; }
      }
      var dl = solveSmall(JtJ, Jtr, 4);
      if (!dl) break;
      cen = [cen[0] + dl[0], cen[1] + dl[1], cen[2] + dl[2]]; R += dl[3];
      if (Math.abs(dl[0]) + Math.abs(dl[1]) + Math.abs(dl[2]) + Math.abs(dl[3]) < 1e-13) break;
    }
    var centre = add(c0, mul(cen, sc)), Rmm = R * sc;
    if (!(Rmm > 0) || !isFinite(Rmm)) return null;
    var se = 0, mx = 0;
    pts.forEach(function (p) { var e = Math.abs(len(sub(p, centre)) - Rmm); se += e * e; if (e > mx) mx = e; });
    return { centre: centre, R: Rmm, rms: Math.sqrt(se / n), max: mx, n: n };
  }
  function orientOf(p2) {
    var A2 = 0;
    for (var i = 0; i < p2.length; i++) { var a = p2[i], b = p2[(i + 1) % p2.length]; A2 += a[0] * b[1] - b[0] * a[1]; }
    return A2 >= 0 ? 1 : -1;
  }
  /* The sphere's chart. P: the loop in fill order; rim: the loop as the piece
     has it (boundary order), for the way the piece faces. The pole is a point
     inside the hole: the direction (from 1500 tried) that has the fill-order
     rim winding once round it in the chart, with the least distance to the
     farthest rim vertex. Null (and a reason) when none does. */
  function sphereChart(M, H, rim, P, sph, o) {
    var c = sph.centre, n = P.length, dirs = [], i;
    for (i = 0; i < n; i++) {
      var dd = unit(sub(ptOf(M, P[i]), c));
      if (!dd) return { why: 'a rim vertex sits at the sphere\'s centre' };
      dirs.push(dd);
    }
    // which way the piece faces: its triangles on the rim against the way out of the sphere
    var so = 0;
    for (i = 0; i < rim.length; i++) {
      var code = H.he.get(rim[i] * M.nv + rim[(i + 1) % rim.length]);
      if (code === undefined) continue;
      var t = (code / 3) | 0, tp = triPts(M, t), g = mul(add(add(tp[0], tp[1]), tp[2]), 1 / 3);
      var nn = unit(triNormal(M, t)), out = unit(sub(g, c));
      if (nn && out) so += dot(nn, out);
    }
    var sOr = so >= 0 ? 1 : -1;
    var cands = [], N = o.poleCandidates, gold = Math.PI * (3 - Math.sqrt(5)), mean = [0, 0, 0];
    for (i = 0; i < N; i++) {
      var z = 1 - 2 * (i + 0.5) / N, rr = Math.sqrt(1 - z * z), th = i * gold;
      cands.push([rr * Math.cos(th), rr * Math.sin(th), z]);
    }
    dirs.forEach(function (d) { mean = add(mean, d); });
    var mu = unit(mean);
    if (mu) { cands.push(mu); cands.push(mul(mu, -1)); }
    var cosMin = Math.cos(o.maxCapDeg * Math.PI / 180), scored = [];
    function basisOf(pole) {
      var a = Math.abs(pole[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], e1 = unit(cross(a, pole));
      return { e1: e1, e2: cross(pole, e1) };
    }
    function project(pole, bs, d) {
      var den = 1 + dot(d, pole);
      return [dot(d, bs.e1) / den, dot(d, bs.e2) / den];
    }
    cands.forEach(function (pole) {
      var minDot = 1;
      for (var k = 0; k < n; k++) { var dp = dot(dirs[k], pole); if (dp < minDot) minDot = dp; }
      if (minDot < cosMin) return;
      var bs = basisOf(pole), xy = dirs.map(function (d) { return project(pole, bs, d); }), tot = 0;
      for (var k2 = 0; k2 < n; k2++) {
        var a2 = xy[k2], b2 = xy[(k2 + 1) % n];
        tot += Math.atan2(a2[0] * b2[1] - a2[1] * b2[0], a2[0] * b2[0] + a2[1] * b2[1]);
      }
      if (Math.round(tot / (2 * Math.PI)) !== sOr) return;
      scored.push({ pole: pole, bs: bs, xy: xy, cap: Math.acos(Math.max(-1, Math.min(1, minDot))) });
    });
    scored.sort(function (x, y) { return x.cap - y.cap; });
    for (var s = 0; s < Math.min(8, scored.length); s++) {
      var cand = scored[s], simple = true, xy2 = cand.xy;
      for (i = 0; simple && i < n; i++) for (var j = i + 2; simple && j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        if (segCross2(xy2[i], xy2[(i + 1) % n], xy2[j], xy2[(j + 1) % n])) simple = false;
      }
      if (!simple) continue;
      var pole = cand.pole, bs = cand.bs, R = sph.R, capRad = cand.cap;
      return {
        ok: true, p2: xy2, orient: sOr, capDeg: deg(cand.cap),
        /* mm of surface per unit of chart at uv (the stereographic scale), and a lattice of
           points on the sphere about the pole, rings a row apart, about sigma between points */
        mmPerUnit: function (uv) { return 2 * R / (1 + uv[0] * uv[0] + uv[1] * uv[1]); },
        lattice: function (sigma) {
          var h = sigma * 0.866 / R, out = [[0, 0]], ring = 0;
          for (var phi = h; phi < capRad + h && phi < 0.98 * Math.PI; phi += h, ring++) {
            var m = Math.max(3, Math.round(2 * Math.PI * R * Math.sin(phi) / sigma)), tn = Math.tan(phi / 2), off = (ring & 1) ? 0.5 : 0;
            for (var j = 0; j < m; j++) { var al = (j + off) * 2 * Math.PI / m; out.push([tn * Math.cos(al), tn * Math.sin(al)]); }
          }
          return out;
        },
        chart: {
          toSurf: function (uv) {
            var r2 = uv[0] * uv[0] + uv[1] * uv[1], dn = 1 + r2;
            var d = add(add(mul(bs.e1, 2 * uv[0] / dn), mul(bs.e2, 2 * uv[1] / dn)), mul(pole, (1 - r2) / dn));
            return add(c, mul(d, R));
          }
        }
      };
    }
    return { why: scored.length ? 'the rim crosses itself in every chart tried' : 'the hole covers more than ' + o.maxCapDeg + ' degrees of the sphere seen from any point inside it' };
  }

  /* Lift 3's local fit: the quadric over the best plane through the ring,
     weights 1, .7, .4, .25 ... by ring. { ok, ... } or { why }. */
  function fitQuadric(M, ring, rim, tol) {
    var verts = ring.verts, wts = [0.0, 0.7, 0.4, 0.25, 0.15, 0.1], i, a, b2;
    if (verts.length < MIN_FIT_VERTS) return { why: 'too few surround vertices to fit a quadric (' + verts.length + ')' };
    var pts = verts.map(function (v) { return ptOf(M, v); });
    var fit = planeFit(pts), F = frameOf(fit);
    var scale = 1e-9;
    rim.forEach(function (v) { scale = Math.max(scale, len(sub(ptOf(M, v), F.o))); });
    var uvw = pts.map(function (p) { var d = sub(p, F.o); return [dot(d, F.u) / scale, dot(d, F.v) / scale, dot(d, F.n) / scale]; });
    var AtA = [], Atb = [];
    for (a = 0; a < 6; a++) { AtA.push([0, 0, 0, 0, 0, 0]); Atb.push(0); }
    function wOf(v) { var rg = ring.depth.get(v); return rg === 0 ? 1 : (wts[Math.min(rg, wts.length - 1)] || 0.1); }
    for (i = 0; i < verts.length; i++) {
      var u = uvw[i][0], v2 = uvw[i][1], w = uvw[i][2], wt = wOf(verts[i]);
      var basis = [u * u, u * v2, v2 * v2, u, v2, 1];
      for (a = 0; a < 6; a++) { Atb[a] += wt * basis[a] * w; for (b2 = 0; b2 < 6; b2++) AtA[a][b2] += wt * basis[a] * basis[b2]; }
    }
    var co = solveSmall(AtA, Atb, 6);
    if (!co) return { why: 'the quadric fit is degenerate' };
    function B(u2, v2) { return co[0] * u2 * u2 + co[1] * u2 * v2 + co[2] * v2 * v2 + co[3] * u2 + co[4] * v2 + co[5]; }
    var se = 0, sw = 0, mx = 0;
    for (i = 0; i < verts.length; i++) {
      var wt2 = wOf(verts[i]), e = (B(uvw[i][0], uvw[i][1]) - uvw[i][2]) * scale;
      se += wt2 * e * e; sw += wt2; if (Math.abs(e) > mx) mx = Math.abs(e);
    }
    var rms = Math.sqrt(se / sw);
    if (!(rms <= tol)) return { why: 'the surround is no quadric either (' + rms.toFixed(3) + ' mm rms against ' + tol.toFixed(3) + ' allowed)', rms: rms };
    if (!(mx <= 3 * tol)) return { why: 'a surround vertex stands ' + mx.toFixed(3) + ' mm off the quadric (' + (3 * tol).toFixed(3) + ' allowed)', rms: rms };
    return { ok: true, F: F, scale: scale, B: B, rms: rms, max: mx, n: verts.length };
  }
  /* The quadric's chart: its plane's (u, v), the fit above them. */
  function quadricChart(M, q, P) {
    var F = q.F, scale = q.scale, B = q.B;
    var p2 = P.map(function (v) { var d = sub(ptOf(M, v), F.o); return [dot(d, F.u) / scale, dot(d, F.v) / scale]; });
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    p2.forEach(function (q) { for (var k = 0; k < 2; k++) { if (q[k] < lo[k]) lo[k] = q[k]; if (q[k] > hi[k]) hi[k] = q[k]; } });
    return {
      ok: true, p2: p2, orient: orientOf(p2),
      mmPerUnit: function () { return scale; },
      lattice: function (sigma) {                                   // a hexagonal lattice in the plane the quadric stands over
        var s = sigma / scale, out = [], row = 0;
        for (var y = lo[1]; y <= hi[1]; y += s * 0.866, row++) for (var x = lo[0] + ((row & 1) ? s / 2 : 0); x <= hi[0]; x += s) out.push([x, y]);
        return out;
      },
      chart: { toSurf: function (uv) { return add(add(add(F.o, mul(F.u, uv[0] * scale)), mul(F.v, uv[1] * scale)), mul(F.n, B(uv[0], uv[1]) * scale)); } },
      dev: function (p) { var d = sub(p, F.o), u3 = dot(d, F.u) / scale, v3 = dot(d, F.v) / scale; return Math.abs(dot(d, F.n) / scale - B(u3, v3)) * scale; }
    };
  }
  /* Does a sphere follow the surround? { ok, sph, fit, tol } or { why, fit? }. */
  function followsSphere(M, ring, diameter, o) {
    var tol = Math.max(o.fitTolFrac * ring.edgeMm, o.fitMinTolMm);
    var pts = ring.verts.map(function (v) { return ptOf(M, v); });
    if (pts.length < MIN_FIT_VERTS) return { why: 'too few surround vertices to fit a sphere (' + pts.length + ')' };
    var sph = fitSphere(pts);
    if (!sph) return { why: 'no sphere can be fitted to the ' + pts.length + ' surround vertices' };
    var fit = { kind: 'sphere', radiusMm: sph.R, centre: sph.centre, rmsMm: sph.rms, maxResidualMm: sph.max, samples: sph.n, tolMm: tol };
    if (!(sph.rms <= tol)) return { why: 'the surround is no sphere (rms ' + sph.rms.toFixed(3) + ' mm against ' + tol.toFixed(3) + ' allowed)', fit: fit };
    // and no vertex of it, the rim's included, stands far off: the fill is welded to the rim, so a rim off the fit is a kink
    if (!(sph.max <= 3 * tol)) return { why: 'a surround vertex stands ' + sph.max.toFixed(3) + ' mm off the sphere (' + (3 * tol).toFixed(3) + ' allowed)', fit: fit };
    if (!(sph.R >= 0.45 * diameter)) return { why: 'the sphere through the surround (R ' + sph.R.toFixed(2) + ' mm) is smaller than the hole', fit: fit };
    return { ok: true, sph: sph, fit: fit, tol: tol };
  }
  /* Is the surround curved in a way a fit follows? Used to tell a flat rim in a
     curved surface (a hole in a sphere) from one in a flat or creased one (a
     hole in a cube's face, which stays a flat cap). */
  function surroundCurved(M, adj, rim, diameter, o) {
    var ring = surroundOf(M, adj, rim, diameter, o), tol = Math.max(o.fitTolFrac * ring.edgeMm, o.fitMinTolMm);
    var s = followsSphere(M, ring, diameter, o);
    if (s.ok) return { ok: true, kind: 'sphere', ring: ring };
    var q = fitQuadric(M, ring, rim, tol);
    if (q.ok) return { ok: true, kind: 'quadric', ring: ring };
    return { ok: false, why: [s.why, q.why], ring: ring };
  }

  /* ------------------------------------------------- piercing, for the fill

     A fill that is only checked for closing can still pass through itself or
     through a nearby sheet. Two triangles that share a vertex are skipped (they
     touch by construction); everything else is Moller's test, the coplanar
     case left out. */
  function triTri(p0, p1, p2, q0, q1, q2) {
    var EPS = 1e-9;
    var n2 = cross(sub(q1, q0), sub(q2, q0)), d2 = -dot(n2, q0);
    var dp0 = dot(n2, p0) + d2, dp1 = dot(n2, p1) + d2, dp2 = dot(n2, p2) + d2;
    var s2 = len(n2) || 1;
    if (Math.abs(dp0) / s2 < EPS) dp0 = 0; if (Math.abs(dp1) / s2 < EPS) dp1 = 0; if (Math.abs(dp2) / s2 < EPS) dp2 = 0;
    if ((dp0 > 0 && dp1 > 0 && dp2 > 0) || (dp0 < 0 && dp1 < 0 && dp2 < 0)) return false;
    var n1 = cross(sub(p1, p0), sub(p2, p0)), d1 = -dot(n1, p0);
    var dq0 = dot(n1, q0) + d1, dq1 = dot(n1, q1) + d1, dq2 = dot(n1, q2) + d1;
    var s1 = len(n1) || 1;
    if (Math.abs(dq0) / s1 < EPS) dq0 = 0; if (Math.abs(dq1) / s1 < EPS) dq1 = 0; if (Math.abs(dq2) / s1 < EPS) dq2 = 0;
    if ((dq0 > 0 && dq1 > 0 && dq2 > 0) || (dq0 < 0 && dq1 < 0 && dq2 < 0)) return false;
    if (dp0 === 0 && dp1 === 0 && dp2 === 0) return false;          // coplanar: not a piercing
    var D = cross(n1, n2), ax = 0;
    if (Math.abs(D[1]) > Math.abs(D[ax])) ax = 1;
    if (Math.abs(D[2]) > Math.abs(D[ax])) ax = 2;
    function interval(v0, v1, v2, d0, d1, d2) {
      // project onto the largest axis of D; find the two crossing parameters
      var p = [v0[ax], v1[ax], v2[ax]], d = [d0, d1, d2], ts = [];
      for (var i = 0; i < 3; i++) {
        var j = (i + 1) % 3;
        if (d[i] === 0) ts.push(p[i]);
        if ((d[i] > 0 && d[j] < 0) || (d[i] < 0 && d[j] > 0)) ts.push(p[i] + (p[j] - p[i]) * d[i] / (d[i] - d[j]));
      }
      if (ts.length < 2) return null;
      return [Math.min.apply(null, ts), Math.max.apply(null, ts)];
    }
    var I1 = interval(p0, p1, p2, dp0, dp1, dp2), I2 = interval(q0, q1, q2, dq0, dq1, dq2);
    if (!I1 || !I2) return false;
    var lo = Math.max(I1[0], I2[0]), hi = Math.min(I1[1], I2[1]);
    return hi - lo > 1e-9;
  }
  /* A uniform grid of triangles (each: { p:[a,b,c], ids:[..], fill:bool }).
     Triangles can be added and the last few taken off again, so one grid of the
     piece's own triangles serves every trial fill. */
  function TriGrid(cell) { this.cell = cell; this.cells = new Map(); this.list = []; }
  TriGrid.prototype.add = function (T) {
    var idx = this.list.length; this.list.push(T);
    var c = this.cell, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], k, m;
    for (k = 0; k < 3; k++) for (m = 0; m < 3; m++) { var v = T.p[k][m]; if (v < lo[m]) lo[m] = v; if (v > hi[m]) hi[m] = v; }
    T.lo = lo; T.hi = hi; T.keys = [];
    for (var x = Math.floor(lo[0] / c); x <= Math.floor(hi[0] / c); x++) for (var y = Math.floor(lo[1] / c); y <= Math.floor(hi[1] / c); y++) for (var z = Math.floor(lo[2] / c); z <= Math.floor(hi[2] / c); z++) {
      var key = x + ',' + y + ',' + z, b = this.cells.get(key);
      if (!b) this.cells.set(key, b = []);
      b.push(idx); T.keys.push(key);
    }
    return idx;
  };
  TriGrid.prototype.truncate = function (n) {
    while (this.list.length > n) {
      var T = this.list.pop(), idx = this.list.length;
      for (var i = 0; i < T.keys.length; i++) {
        var b = this.cells.get(T.keys[i]);
        b.pop();                                   // triangles are added in order, so it is the last in each cell it is in
        if (!b.length) this.cells.delete(T.keys[i]);
      }
    }
  };
  /* How many triangles from index \`from\` up pierce another triangle (or one
     another). */
  TriGrid.prototype.pierceCount = function (from, ignore) {
    var seen = new Set(), hit = new Set(), self = this;
    for (var i = from || 0; i < this.list.length; i++) {
      var A = this.list[i];
      for (var q = 0; q < A.keys.length; q++) {
        var b = this.cells.get(A.keys[q]);
        for (var r = 0; r < b.length; r++) {
          var j = b[r];
          if (j === i) continue;
          var B = this.list[j];
          if (!A.fill && !B.fill) continue;
          var key = i < j ? i * 1000003 + j : j * 1000003 + i;
          if (seen.has(key)) continue;
          seen.add(key);
          if (A.hi[0] < B.lo[0] || B.hi[0] < A.lo[0] || A.hi[1] < B.lo[1] || B.hi[1] < A.lo[1] || A.hi[2] < B.lo[2] || B.hi[2] < A.lo[2]) continue;
          if (A.ids[0] === B.ids[0] || A.ids[0] === B.ids[1] || A.ids[0] === B.ids[2] ||
              A.ids[1] === B.ids[0] || A.ids[1] === B.ids[1] || A.ids[1] === B.ids[2] ||
              A.ids[2] === B.ids[0] || A.ids[2] === B.ids[1] || A.ids[2] === B.ids[2]) continue;
          if (ignore && ignore(A, B)) continue;
          if (triTri(A.p[0], A.p[1], A.p[2], B.p[0], B.p[1], B.p[2])) { if (A.fill) hit.add(i); if (B.fill) hit.add(j); }
        }
      }
    }
    return hit.size;
  };
  /* The piece's own triangles round a set of loops, into a grid (once). */
  function surfaceGrid(M, loopsList, edgeLen) {
    var cell = Math.max(edgeLen * 2, 1e-3), G = new TriGrid(cell), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    loopsList.forEach(function (L) { for (var k = 0; k < 3; k++) { if (L.lo[k] < lo[k]) lo[k] = L.lo[k]; if (L.hi[k] > hi[k]) hi[k] = L.hi[k]; } });
    var pad = cell * 3;
    for (var t = 0; t < M.nt; t++) {
      var a = M.f[t * 3], b = M.f[t * 3 + 1], c = M.f[t * 3 + 2];
      // keep any triangle with a corner inside the loops' padded box
      var inside = false;
      for (var k3 = 0; k3 < 3 && !inside; k3++) {
        var vv = M.f[t * 3 + k3], in3 = true;
        for (var m2 = 0; m2 < 3; m2++) { var xx = M.pos[vv * 3 + m2]; if (xx < lo[m2] - pad || xx > hi[m2] + pad) in3 = false; }
        if (in3) inside = true;
      }
      if (!inside) continue;
      G.add({ p: [ptOf(M, a), ptOf(M, b), ptOf(M, c)], ids: [a, b, c], fill: false });
    }
    return G;
  }

  /* ------------------------------------------------------------ the verbs */
  function surfaceNeighbours(M, want) {
    var nbr = new Map();
    want.forEach(function (v) { nbr.set(v, new Set()); });
    for (var t = 0; t < M.nt; t++) {
      var a = M.f[t * 3], b = M.f[t * 3 + 1], c = M.f[t * 3 + 2];
      var A = nbr.get(a), B = nbr.get(b), C = nbr.get(c);
      if (A) { A.add(b); A.add(c); }
      if (B) { B.add(a); B.add(c); }
      if (C) { C.add(a); C.add(b); }
    }
    return nbr;
  }
  function pickLoops(list, ids) {
    var out = [];
    (Array.isArray(ids) ? ids : [ids]).forEach(function (id) {
      var l = null;
      if (id && typeof id === 'object') l = list.filter(function (x) { return x.id === id.id; })[0];
      else l = list.filter(function (x) { return x.id === id; })[0];
      if (l) out.push(l);
    });
    return out;
  }

  /* Fill the named loops. mode 'patch' (curvature-continuing; a planar rim
     takes the flat cap) or 'cap' (the flat cap, always - the caller has said
     the rim is planar). Returns { ok, soup, filled: [...], stats } or
     { ok:false, reason } and the input untouched. */
  function fillLoops(soup, ids, mode, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var t0 = now();
    var M = weld(soup, o.weldTol), H = halfEdges(M);
    var list = loopsOf(soup, M, H);
    var chosen = pickLoops(list, ids);
    if (!chosen.length) return { ok: false, reason: 'no open loop there to ' + (mode === 'cap' ? 'cap' : 'patch') };
    var want = new Set();
    list.forEach(function (l) { l.verts.forEach(function (v) { want.add(v); }); });
    var nbr = surfaceNeighbours(M, want);
    var out = [], filled = [], total = { tris: 0, points: 0, ms: 0 }, filledSoFar = [], surfG = null;
    /* The piece's own triangles round the loops, once; each loop's finished
       fill is added to it for good; a trial fill goes on and comes off. */
    function piercesNow(Fl2, prev, onFit) {
      if (!surfG) {
        var ls = 0, lc = 0;
        for (var t3 = 0; t3 < Math.min(M.nt, 4000); t3++) { ls += len(sub(ptOf(M, M.f[t3 * 3]), ptOf(M, M.f[t3 * 3 + 1]))); lc++; }
        surfG = surfaceGrid(M, chosen, lc ? ls / lc : 1);
        surfG.doneFills = 0;
      }
      for (; surfG.doneFills < prev.length; surfG.doneFills++) {
        var k = surfG.doneFills;
        prev[k].forEach(function (tr) { surfG.add({ p: tr.p, ids: tr.ids.map(function (id) { return id < M.nv ? id : id + (k + 1) * 5000000; }), fill: true }); });
      }
      var n0 = surfG.list.length;
      Fl2.tris.forEach(function (tr) {
        if (!tr) return;
        surfG.add({ p: [Fl2.P(tr[0]), Fl2.P(tr[1]), Fl2.P(tr[2])], ids: [tr[0], tr[1], tr[2]].map(function (id) { return id < M.nv ? id : id + (prev.length + 1) * 5000000; }), fill: true });
      });
      /* A sheet of the piece that already lies ON the fit the new fill stands on
         is the same surface, not one the fill crosses: it is left out of the count. */
      var ignore = onFit ? function (A, B) {
        var T = A.fill ? B : A;
        return !T.fill && onFit(T.p[0]) && onFit(T.p[1]) && onFit(T.p[2]);
      } : null;
      var count = surfG.pierceCount(n0, ignore);
      surfG.truncate(n0);
      return count;
    }
    function makeFill(L, P, T) {
      var Fl = new Fill(M);
      // sigma at the rim: the mean length of the piece's own edges there, times the spacing (1: the surround's density)
      L.verts.forEach(function (v) {
        var s = nbr.get(v), sum = 0, cnt = 0, pv = ptOf(M, v);
        s.forEach(function (w) { sum += len(sub(ptOf(M, w), pv)); cnt++; });
        Fl.sigma.set(v, (cnt ? sum / cnt : 1) * o.spacing);
      });
      T.tris.forEach(function (tr) { Fl.addTri(P[tr[0]], P[tr[1]], P[tr[2]]); });
      return Fl;
    }
    /* The fill's interior: points of the fit at the surround's spacing (a lattice in the
       chart), none nearer the rim than 0.55 of it, put in one by one with the triangles
       kept Delaunay - so a round rim does not end up as a chain of sliver triangles. */
    function seedFill(Fl, cand, L, P, sigma) {
      var p2 = cand.p2, n = p2.length, added = 0, perim = 0, area = 0, i;
      for (i = 0; i < n; i++) {
        var q0 = p2[i], q1 = p2[(i + 1) % n];
        perim += Math.hypot(q1[0] - q0[0], q1[1] - q0[1]); area += q0[0] * q1[1] - q1[0] * q0[1];
      }
      // a hole so big that the lattice would pass maxNewPoints gets a coarser one, not a million points to throw away
      var cu = p2.reduce(function (a, q) { return [a[0] + q[0] / n, a[1] + q[1] / n]; }, [0, 0]), mm = cand.mmPerUnit(cu);
      var want = Math.abs(area) / 2 * mm * mm / (0.866 * sigma * sigma);
      if (want > o.maxNewPoints) sigma *= Math.sqrt(want / o.maxNewPoints);
      var pts = cand.lattice(sigma);
      var eps = 1e-9 * perim * perim;
      if (pts.length > o.maxNewPoints) pts = pts.filter(function (q, k) { return k % Math.ceil(pts.length / o.maxNewPoints) === 0; });
      pts.forEach(function (q) {
        if (!inPoly2(q, p2)) return;
        var dmin = Infinity;
        for (var j = 0; j < n; j++) {
          var a = p2[j], b = p2[(j + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
          var tt = l2 > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / l2)) : 0;
          dmin = Math.min(dmin, Math.hypot(q[0] - a[0] - tt * dx, q[1] - a[1] - tt * dy));
        }
        if (dmin * cand.mmPerUnit(q) < 0.55 * sigma) return;
        if (Fl.insert(q, cand.chart.toSurf(q), sigma, nbr, eps)) added++;
      });
      Fl.delaunay(nbr, eps);
      return added;
    }
    /* One rung of the fit ladder ('sphere' or 'quadric') on one loop: fit the
       surround, triangulate the hole in the fit's chart, refine it there with
       every new point ON the fit. { ok, Fl, fit, dev } or { why, fit? }. */
    function tryFit(kind, L, P, ring, diameter) {
      var cand, fit, dev;
      if (kind === 'sphere') {
        var fs = followsSphere(M, ring, diameter, o);
        if (!fs.ok) return { why: fs.why, fit: fs.fit };
        fit = fs.fit;
        cand = sphereChart(M, H, L.verts, P, fs.sph, o);
        if (!cand.ok) return { why: cand.why, fit: fit };
        dev = function (p) { return Math.abs(len(sub(p, fs.sph.centre)) - fs.sph.R); };
      } else {
        var tol = Math.max(o.fitTolFrac * ring.edgeMm, o.fitMinTolMm), fq = fitQuadric(M, ring, L.verts, tol);
        if (!fq.ok) return { why: fq.why, fit: { kind: 'quadric', rmsMm: fq.rms, tolMm: tol } };
        fit = { kind: 'quadric', rmsMm: fq.rms, maxResidualMm: fq.max, samples: fq.n, tolMm: tol };
        cand = quadricChart(M, fq, P);
        dev = cand.dev;
      }
      var T = triangulateLoop(M, P, nbr, o, cand.p2);
      if (!T || (T.mode !== 'graph' && T.mode !== 'single' && T.mode !== 'ears')) {
        return { why: 'the rim does not lie flat in the ' + kind + '\'s chart (it folds over itself)', fit: fit };
      }
      var Fl = makeFill(L, P, T);
      Fl.useChart(cand.chart, P, cand.p2, cand.orient);
      var added = seedFill(Fl, cand, L, P, ring.edgeMm * o.spacing);
      added += Fl.refine(nbr, o);
      var eps = 1e-9 * Math.pow(cand.p2.reduce(function (a2, q, i, arr) { return a2 + Math.hypot(arr[(i + 1) % arr.length][0] - q[0], arr[(i + 1) % arr.length][1] - q[1]); }, 0), 2);
      added += Fl.refineSag(nbr, o, eps);
      Fl.relax(nbr);
      var bad = 0;
      for (var t = 0; t < Fl.tris.length; t++) {
        var tr = Fl.tris[t];
        if (!tr) continue;
        if (!(Fl.areaUV(tr[0], tr[1], tr[2]) > 0) || !(len(Fl.normal(t)) > 1e-14)) bad++;
      }
      if (bad) return { why: 'the fill on the ' + kind + ' would fold or collapse ' + bad + ' triangle(s)', fit: fit };
      return { ok: true, Fl: Fl, fit: fit, dev: dev, added: added, mode: T.mode };
    }
    /* How far the fill's vertices stand off the fit: the rim (welded to the
       piece, so not moved) and the points put inside. */
    function deviation(Fl, P, dev) {
      var rimMax = 0, inMax = 0, i;
      P.forEach(function (v) { rimMax = Math.max(rimMax, dev(ptOf(M, v))); });
      for (i = 0; i < Fl.pos.length; i += 3) inMax = Math.max(inMax, dev([Fl.pos[i], Fl.pos[i + 1], Fl.pos[i + 2]]));
      return { maxDevMm: Math.max(rimMax, inMax), interiorMaxDevMm: inMax, rimMaxDevMm: rimMax };
    }
    function meanEdge(Fl) {
      var seen = new Set(), sum = 0, cnt = 0;
      Fl.tris.forEach(function (tr) {
        if (!tr) return;
        for (var e = 0; e < 3; e++) {
          var a = tr[e], b = tr[(e + 1) % 3], k = a < b ? a * KEY + b : b * KEY + a;
          if (seen.has(k)) continue;
          seen.add(k); sum += len(sub(Fl.P(a), Fl.P(b))); cnt++;
        }
      });
      return cnt ? sum / cnt : 0;
    }
    for (var li = 0; li < chosen.length; li++) {
      var L = chosen[li], d = describe(soup, L);
      var P = L.verts.slice().reverse();                      // fill order
      var diameter = loopDiameter(L.pts);
      var sf = mode === 'cap' ? null : surroundFlat(M, adjacencyOf(M), L.verts, o);
      var flat = mode === 'cap' || (d.planar && sf.flat), noFit = null;
      if (!flat && d.planar) {
        // a flat rim in a surround that is no flat plane: a curve a fit follows (a hole in a sphere), or not (a cube's face)
        var sc = surroundCurved(M, adjacencyOf(M), L.verts, diameter, o);
        if (!sc.ok) { flat = true; noFit = sc; }
      }
      var info = { loop: L.id, vertices: L.n, planar: d.planar, planarMm: d.planarMm, curved: !flat, diameterMm: diameter };
      var Fl = null, T = null;
      if (!flat) {
        var ring = surroundOf(M, adjacencyOf(M), L.verts, diameter, o), why = [], rungs = ['sphere', 'quadric'];
        for (var ri = 0; ri < rungs.length && !Fl; ri++) {
          var tf = tryFit(rungs[ri], L, P, ring, diameter);
          if (tf.ok) {
            var pc = piercesNow(tf.Fl, filledSoFar, function (p) { return tf.dev(p) <= 2 * tf.fit.tolMm; });
            if (pc === 0) {
              Fl = tf.Fl;
              info.method = 'fitted surface'; info.pierces = 0; info.added = tf.added; info.triangulation = tf.mode;
              info.fit = Object.assign({}, tf.fit, deviation(Fl, P, tf.dev));
            } else why.push('the ' + rungs[ri] + ' fill pierces ' + pc + ' triangle(s) of the piece');
          } else why.push(tf.why);
        }
        if (Fl) {
          info.fit.ringMm = ring.hops; info.fit.surroundEdgeMm = ring.edgeMm;
          if (why.length) info.fit.passedOver = why;          // the rungs above this one, and why each did not follow
        } else {
          info.fit = { kind: 'none', reason: why.join('; '), surroundEdgeMm: ring.edgeMm, samples: ring.verts.length };
        }
        if (!Fl && o.fallback !== 'flat') {
          // no fit follows the surround: the faired surface (biharmonic), eased off whatever it would pierce - and SAID
          T = triangulateLoop(M, P, nbr, o);
          if (!T) return { ok: false, reason: 'the ' + L.n + '-vertex loop at (' + d.centre.map(function (x) { return x.toFixed(1); }).join(', ') + ') cannot be crossed without doubling an edge the piece already has' };
          Fl = makeFill(L, P, T);
          info.triangulation = T.mode;
          info.added = Fl.refine(nbr, o);
          var basePos = Fl.pos.slice();
          var fr = Fl.fair(L.verts, nbr, o), fairPos = Fl.pos.slice(), lam = 1, ladder = [1, 0.7, 0.5, 0.35, 0.25, 0.15, 0.08, 0], npc = 0;
          for (var li2 = 0; li2 < ladder.length; li2++) {
            lam = ladder[li2];
            for (var q = 0; q < fairPos.length; q++) Fl.pos[q] = basePos[q] + lam * (fairPos[q] - basePos[q]);
            npc = piercesNow(Fl, filledSoFar);
            if (npc === 0) break;
          }
          info.method = lam === 1 ? 'fairing' : 'fairing, eased to ' + lam;
          info.fairIters = fr.iters; info.fairMoved = fr.moved; info.blend = lam; info.pierces = npc;
          info.fit.fallback = 'faired';
          // a fill that folded over itself is not shipped faired: it goes flat, and says so
          var bad = 0;
          for (var t = 0; t < Fl.tris.length; t++) {
            if (Fl.tris[t] && !(len(Fl.normal(t)) > 1e-14)) bad++;
          }
          if (bad) { Fl = null; info.fit.reason += '; the faired fill would collapse ' + bad + ' triangle(s)'; }
        }
        if (!Fl) {
          info.fit.fallback = 'flat';
          flat = true;
        }
      } else {
        // the flat cap: the surround is a plane (or the caller said so)
        var pf = sf ? sf.plane : planeFit(L.pts);
        if (noFit) {
          info.fit = { kind: 'none', reason: noFit.why.join('; ') + '; the rim is flat, so the flat cap', fallback: 'flat', surroundEdgeMm: noFit.ring.edgeMm, samples: noFit.ring.verts.length };
        } else {
          info.fit = { kind: 'plane', asked: mode === 'cap', flatnessMm: pf.flatnessMm, ringDevMm: sf ? sf.ringDevMm : null };
        }
      }
      if (flat) {
        // flat: the triangulation across the rim and nothing inside
        T = T && info.fit.fallback !== 'flat' ? T : triangulateLoop(M, P, nbr, o);
        if (!T) return { ok: false, reason: 'the ' + L.n + '-vertex loop at (' + d.centre.map(function (x) { return x.toFixed(1); }).join(', ') + ') cannot be crossed without doubling an edge the piece already has' };
        Fl = makeFill(L, P, T);
        info.triangulation = T.mode; info.method = 'flat cap';
        var pfl = planeFit(L.pts);
        info.maxDevMm = pfl.deviationMm;
        if (info.fit.kind === 'plane') info.fit.maxDevMm = pfl.deviationMm;
      }
      info.surroundEdgeMm = info.fit.surroundEdgeMm != null ? info.fit.surroundEdgeMm : null;
      info.fillEdgeMm = meanEdge(Fl);
      var mine = [];
      Fl.tris.forEach(function (tr3) {
        if (!tr3) return;
        var pp = [Fl.P(tr3[0]), Fl.P(tr3[1]), Fl.P(tr3[2])];
        for (var k = 0; k < 3; k++) out.push(pp[k][0], pp[k][1], pp[k][2]);
        mine.push({ p: pp, ids: [tr3[0], tr3[1], tr3[2]] });
      });
      filledSoFar.push(mine);
      info.tris = Fl.tris.filter(Boolean).length;
      filled.push(info);
      total.tris += info.tris; total.points += (info.added || 0);
    }
    var res = new Float32Array(soup.length + out.length);
    res.set(soup, 0);
    res.set(out, soup.length);
    total.ms = now() - t0;
    return { ok: true, soup: res, added: out.length / 9, filled: filled, stats: total, originalTris: triCount(soup) };
  }
  /* The readout line for one filled hole (an entry of patch()'s `filled`): its
     size, the surface its fill follows and how closely, or - never silently -
     that no fit could be made and what was done instead. */
  function readout(f) {
    var fit = f.fit || {}, head = '\u00d8' + f.diameterMm.toFixed(1) + ' mm hole: ', mm = function (x) { return x.toFixed(3) + ' mm'; };
    if (fit.kind === 'sphere') return head + 'sphere R ' + fit.radiusMm.toFixed(2) + ' mm (fit rms ' + mm(fit.rmsMm) + '), fill within ' + mm(fit.maxDevMm) + ' of it';
    if (fit.kind === 'quadric') return head + 'quadric surface (fit rms ' + mm(fit.rmsMm) + '), fill within ' + mm(fit.maxDevMm) + ' of it';
    if (fit.kind === 'plane') return head + (fit.asked ? 'flat cap, as asked' : 'flat surround, flat cap');
    return head + 'NO SURFACE FIT (' + (fit.reason || 'none made') + ') - ' +
           (fit.fallback === 'flat' ? 'filled FLAT' : 'faired from the rim slopes, not on a fit');
  }
  function patch(soup, ids, opts) { return fillLoops(soup, ids, 'patch', opts); }
  function cap(soup, ids, opts) { return fillLoops(soup, ids, 'cap', opts); }

  /* ------------------------------------------------------------ rays */
  function rayTri(o, d, a, b, c) {
    var e1 = sub(b, a), e2 = sub(c, a), p = cross(d, e2), det = dot(e1, p);
    if (det > -1e-14 && det < 1e-14) return -1;
    var inv = 1 / det, s2 = sub(o, a), u = dot(s2, p) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) return -1;
    var q = cross(s2, e1), v = dot(d, q) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) return -1;
    var t = dot(e2, q) * inv;
    return t > 1e-9 ? t : -1;
  }
  function triPts(M, t) { return [ptOf(M, M.f[t * 3]), ptOf(M, M.f[t * 3 + 1]), ptOf(M, M.f[t * 3 + 2])]; }
  function triNormal(M, t) {
    var p = triPts(M, t);
    return cross(sub(p[1], p[0]), sub(p[2], p[0]));
  }
  /* First surface hit along d from o, ignoring triangles that share a vertex
     with triangle t0 (they touch it by construction). { t, dist } or null. */
  function castRay(M, o, d, t0, maxDist) {
    var best = null, skip = {};
    if (t0 >= 0) { skip[M.f[t0 * 3]] = 1; skip[M.f[t0 * 3 + 1]] = 1; skip[M.f[t0 * 3 + 2]] = 1; }
    for (var t = 0; t < M.nt; t++) {
      var a = M.f[t * 3], b = M.f[t * 3 + 1], c = M.f[t * 3 + 2];
      if (t === t0 || skip[a] || skip[b] || skip[c]) continue;
      var h = rayTri(o, d, ptOf(M, a), ptOf(M, b), ptOf(M, c));
      if (h > 0 && h <= maxDist && (!best || h < best.dist)) best = { t: t, dist: h };
    }
    return best;
  }

  /* ----------------------------------------------------------- the bridge

     Two open loops joined by a strip of triangles that adds no point: the
     strip walks both loops at once, advancing whichever loop is behind (by arc
     length), so every triangle has two corners on one loop and one on the
     other. A is walked against its own boundary order and B along it, so each
     rim edge is used the other way round to the piece's own use - the strip
     closes both loops by bit equality. The start is the rotation that puts the
     two loops nearest each other (Bridge's rule: the one that does not twist
     the strip). */
  function arcParams(pts) {
    var c = [0];
    for (var i = 0; i < pts.length; i++) c.push(c[i] + len(sub(pts[(i + 1) % pts.length], pts[i])));
    var L = c[c.length - 1], t = [];
    for (i = 0; i < pts.length; i++) t.push(L > 0 ? c[i] / L : 0);
    return { t: t, L: L, cum: c };
  }
  function pointAt(pts, ar, t) {
    t = ((t % 1) + 1) % 1;
    var s = t * ar.L, lo = 0, hi = pts.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (ar.cum[mid] <= s) lo = mid; else hi = mid - 1; }
    var segL = ar.cum[lo + 1] - ar.cum[lo], f = segL > 0 ? (s - ar.cum[lo]) / segL : 0, a = pts[lo], b = pts[(lo + 1) % pts.length];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  function centroidOf(pts) {
    var c = [0, 0, 0], L = 0;
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length], l = len(sub(b, a));
      c = add(c, mul(add(a, b), l / 2)); L += l;
    }
    return L > 0 ? mul(c, 1 / L) : pts[0].slice();
  }
  function matchStrip(PA, PB) {
    var aA = arcParams(PA), aB = arcParams(PB), gA = centroidOf(PA), gB = centroidOf(PB);
    var n = PA.length, m = PB.length, S = Math.min(256, Math.max(64, 2 * Math.max(n, m))), k, j;
    var samples = [];
    for (k = 0; k < S; k++) samples.push(sub(pointAt(PA, aA, k / S), gA));
    function cost(sh) {
      var c = 0;
      for (var q = 0; q < S; q++) { var d = sub(samples[q], sub(pointAt(PB, aB, q / S + sh), gB)); c += dot(d, d); }
      return c;
    }
    var best = { sh: 0, c: Infinity }, cands = [];
    for (j = 0; j < m; j++) cands.push(aB.t[j] - aA.t[0]);
    for (var i = 0; i < n; i++) cands.push(aB.t[0] - aA.t[i]);
    cands.forEach(function (sh) { sh = ((sh % 1) + 1) % 1; var c = cost(sh); if (c < best.c - 1e-12) best = { sh: sh, c: c }; });
    return { shift: best.sh, aA: aA, aB: aB };
  }
  /* PA/PB: point lists in strip order (A against its boundary, B along it);
     VA/VB their vertex ids. Returns triangles as id triples. */
  function zipper(PA, VA, PB, VB) {
    var n = PA.length, m = PB.length, mt = matchStrip(PA, PB), tA = mt.aA.t;
    // B's parameter at each vertex, in A's parameterisation, nearest 0 start
    var tB = mt.aB.t.map(function (t) { return t - mt.shift; });
    var j0 = 0, bd = Infinity, j;
    for (j = 0; j < m; j++) {
      var u = ((tB[j] % 1) + 1) % 1; if (u > 0.5) u -= 1;
      if (Math.abs(u) < bd) { bd = Math.abs(u); j0 = j; }
    }
    var jt = new Array(m), prev = -Infinity;
    for (j = 0; j < m; j++) {
      var jj = (j0 + j) % m, tv = ((tB[jj] % 1) + 1) % 1; if (j === 0 && tv > 0.5) tv -= 1;
      if (j > 0) while (tv < prev) tv += 1;
      jt[j] = tv; prev = tv;
    }
    var tris = [], ia = 0, ib = 0, steps = n + m;
    for (var s2 = 0; s2 < steps; s2++) {
      var nextA = ia + 1 >= n ? 1 + 0 : tA[ia + 1], nextB = ib + 1 >= m ? jt[0] + 1 : jt[ib + 1];
      if (ia + 1 >= n) nextA = 1;
      var a0 = VA[ia % n], a1 = VA[(ia + 1) % n], b0 = VB[(j0 + ib) % m], b1 = VB[(j0 + ib + 1) % m];
      var advA = (ia < n) && (ib >= m || nextA <= nextB);
      if (ia >= n) advA = false;
      if (ib >= m) advA = true;
      if (advA) { tris.push([a0, a1, b0]); ia++; } else { tris.push([a0, b1, b0]); ib++; }
    }
    return { tris: tris, shiftT: mt.shift };
  }
  function spokes(PA, PB, shift, aA, aB) {
    var n = Math.max(PA.length, PB.length), S = Math.max(64, 2 * n), sum = 0, mx = 0, k;
    for (k = 0; k < S; k++) {
      var d = len(sub(pointAt(PA, aA, k / S), pointAt(PB, aB, k / S + shift)));
      sum += d; if (d > mx) mx = d;
    }
    return { mean: sum / S, max: mx };
  }
  /* Fill-order normal of a loop: the way a cap over it would face. */
  function fillNormal(pts) {
    var A = [0, 0, 0], c = centroidOf(pts);
    for (var i = 0; i < pts.length; i++) A = add(A, cross(sub(pts[i], c), sub(pts[(i + 1) % pts.length], c)));
    return unit(mul(A, -1));            // boundary order is the reverse of the fill's
  }

  function bridgeLoopsOnM(M, LA, LB) {
    var PA = LA.pts.slice().reverse(), VA = LA.verts.slice().reverse(), PB = LB.pts, VB = LB.verts;
    var z = zipper(PA, VA, PB, VB);
    var mt = matchStrip(PA, PB), sp = spokes(PA, PB, mt.shift, mt.aA, mt.aB);
    return { tris: z.tris, spokeMeanMm: sp.mean, spokeMaxMm: sp.max };
  }

  function appendTris(soup, M, tris, keep) {
    var kept = keep ? keep.length : triCount(soup), out = new Float32Array(kept * 9 + tris.length * 9), o = 0, i;
    if (keep) {
      for (i = 0; i < keep.length; i++) { out.set(soup.subarray(keep[i] * 9, keep[i] * 9 + 9), o); o += 9; }
    } else { out.set(soup, 0); o = soup.length; }
    tris.forEach(function (t) {
      for (var k = 0; k < 3; k++) { out[o++] = M.pos[t[k] * 3]; out[o++] = M.pos[t[k] * 3 + 1]; out[o++] = M.pos[t[k] * 3 + 2]; }
    });
    return out;
  }

  function bridgeLoops(soup, idA, idB, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {}), t0 = now();
    var M = weld(soup, o.weldTol), list = loopsOf(soup, M, halfEdges(M));
    var LA = pickLoops(list, idA)[0], LB = pickLoops(list, idB)[0];
    if (!LA || !LB || LA === LB) return { ok: false, reason: 'bridge needs two different open loops' };
    var B = bridgeLoopsOnM(M, LA, LB);
    var out = appendTris(soup, M, B.tris);
    var before = topology(soup), after = topology(out);
    if (after.nm > before.nm || after.badWinding > before.badWinding) {
      return { ok: false, reason: 'the strip between these two loops would not weld cleanly (' + after.nm + ' doubled edge(s), ' +
               after.badWinding + ' wound the wrong way) - nothing changed' };
    }
    return { ok: true, soup: out, added: B.tris.length, spokeMeanMm: B.spokeMeanMm, spokeMaxMm: B.spokeMaxMm,
             closed: before.open - after.open, ms: now() - t0 };
  }

  /* ----------------------------------------------- what each loop wants */
  function wallNearLoops(M, loopList, H) {
    // inward-ray distance from the triangles beside each rim, median
    var hits = [], seen = {}, cap = 60;
    loopList.forEach(function (L) {
      var step = Math.max(1, Math.floor(L.n / Math.max(1, Math.floor(cap / Math.max(1, loopList.length)))));
      for (var i = 0; i < L.n; i += step) {
        var u = L.verts[i], v = L.verts[(i + 1) % L.n], code = H.he.get(u * M.nv + v);
        if (code === undefined) continue;
        var t = (code / 3) | 0;
        if (seen[t]) continue; seen[t] = 1;
        var nrm = unit(triNormal(M, t));
        if (!nrm) continue;
        var p = triPts(M, t), c = mul(add(add(p[0], p[1]), p[2]), 1 / 3);
        var h = castRay(M, c, mul(nrm, -1), t, 1e9);
        if (h) hits.push(h.dist);
      }
    });
    if (!hits.length) return null;
    hits.sort(function (a, b) { return a - b; });
    return hits[hits.length >> 1];
  }

  /* CAP, PATCH or BRIDGE for every loop, from the loop's own geometry. */
  function plan(soup, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {});
    var M = weld(soup, o.weldTol), H = halfEdges(M), list = loopsOf(soup, M, H);
    var res = { loops: [], pairs: [], wallMm: null };
    var adj = adjacencyOf(M);
    list.forEach(function (L) {
      var d = describe(soup, L);
      /* Flat means the SURROUND is flat, not only the rim: a circular hole in a
         sphere has a rim in one plane, and a flat cap over it is the facet. */
      var sf = d.planar ? surroundFlat(M, adj, L.verts, o) : null, flat = d.planar && sf.flat;
      if (d.planar && !flat && list.length <= o.planSurroundMax) flat = !surroundCurved(M, adj, L.verts, loopDiameter(L.pts), o).ok;
      res.loops.push({ id: L.id, vertices: L.n, planar: flat, rimPlanar: d.planar, planarMm: d.planarMm, radiusMm: d.radiusMm,
                       centre: d.centre, normal: fillNormal(L.pts), fix: flat ? 'cap' : 'patch', partner: null,
                       anchor: L.pts[0].slice(),
                       lo: L.lo, hi: L.hi, minVert: L.minVert });
    });
    if (list.length < 2 || list.length > 40) return res;
    var wall = wallNearLoops(M, list, H);
    res.wallMm = wall;
    if (!(wall > 0)) return res;
    var cands = [];
    for (var i = 0; i < list.length; i++) for (var j = i + 1; j < list.length; j++) {
      var a = res.loops[i], b = res.loops[j];
      var dn = dot(a.normal, b.normal);
      var PA = list[i].pts.slice().reverse(), PB = list[j].pts;
      var mt = matchStrip(PA, PB), sp = spokes(PA, PB, mt.shift, mt.aA, mt.aB);
      var size = Math.max(a.radiusMm, b.radiusMm);
      var ratio = list[i].perimeterMm / list[j].perimeterMm;
      if (!(sp.mean <= 2 * wall) || !(wall <= 0.35 * size) || ratio < 0.5 || ratio > 2) continue;
      /* Two caps that would face each other (a severed tube, a crack that
         opened), or two rims in one plane, one inside the other (the lip of a
         double-skinned shell). The ends of a pipe face AWAY from each other
         and are not a pair. */
      var offAB = dot(sub(b.centre, a.centre), a.normal), offBA = dot(sub(a.centre, b.centre), b.normal);
      if (!(dn <= -Math.cos(30 * Math.PI / 180)) || offAB < -0.25 * wall || offBA < -0.25 * wall) continue;
      cands.push({ a: i, b: j, gapMm: sp.mean, spokeMaxMm: sp.max, wallMm: wall,
                   kind: (offAB > 0.25 * wall && offBA > 0.25 * wall) ? 'facing' : 'nested' });
    }
    cands.sort(function (x, y) { return x.gapMm - y.gapMm; });
    var used = {};
    cands.forEach(function (c) {
      if (used[c.a] || used[c.b]) return;
      used[c.a] = used[c.b] = 1;
      res.loops[c.a].fix = res.loops[c.b].fix = 'bridge';
      res.loops[c.a].partner = c.b; res.loops[c.b].partner = c.a;
      res.pairs.push(c);
    });
    return res;
  }

  /* The id of the loop that has a vertex within tolMm of each anchor, or -1. */
  function loopsAt(soup, anchors, tolMm) {
    tolMm = tolMm || 0.01;
    var M = weld(soup), list = loopsOf(soup, M, halfEdges(M));
    return anchors.map(function (a) {
      var best = -1, bd = tolMm;
      list.forEach(function (L) {
        for (var i = 0; i < L.pts.length; i++) {
          var d = len(sub(L.pts[i], a));
          if (d <= bd) { bd = d; best = L.id; }
        }
      });
      return best;
    });
  }

  /* Loops that share a vertex with any of these segments (6 numbers each: the
     report's marks), by id. */
  function loopsTouching(soup, flatSegs, tolMm) {
    tolMm = tolMm || 0.01;
    var M = weld(soup), list = loopsOf(soup, M, halfEdges(M)), cell = Math.max(tolMm, 1e-6), grid = new Map();
    function key(x, y, z) { return Math.floor(x / cell) + ',' + Math.floor(y / cell) + ',' + Math.floor(z / cell); }
    for (var i = 0; i + 5 < flatSegs.length; i += 3) {
      var k = key(flatSegs[i], flatSegs[i + 1], flatSegs[i + 2]);
      var b = grid.get(k); if (!b) grid.set(k, b = []);
      b.push(flatSegs[i], flatSegs[i + 1], flatSegs[i + 2]);
    }
    function near(p) {
      var cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
        var b2 = grid.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
        if (!b2) continue;
        for (var q = 0; q < b2.length; q += 3) {
          var ex = b2[q] - p[0], ey = b2[q + 1] - p[1], ez = b2[q + 2] - p[2];
          if (ex * ex + ey * ey + ez * ez <= tolMm * tolMm) return true;
        }
      }
      return false;
    }
    return list.filter(function (L) { return L.pts.some(near); }).map(function (L) { return L.id; });
  }

  /* ------------------------------------------------- gaps between end faces

     A severed tube is a closed solid, so it has no open loop; what it has is
     two flat END faces looking at each other across the slot. An END face is a
     flat region whose whole rim is a convex crease of at least 20 degrees
     (Bridge's face rule, plus convex: the end of something, not the floor of
     a groove). Two of them make a GAP when
       - they face each other, within 5 degrees of straight on;
       - the distance between their planes is at most twice the wall (the
         narrower side of either face, which on a tube's cut face is the wall);
       - they overlap: 80% of each, seen along the gap, lands on the other;
       - nothing stands between them.
     ADVISORY: a gap is not a defect (a slot is a slot), it never changes a
     verdict, and the Findings card offers Bridge on it and nothing more. */
  function flatRegions(M, H, o) {
    var nt = M.nt, nrm = new Array(nt), area = new Float64Array(nt), t;
    for (t = 0; t < nt; t++) {
      var c = triNormal(M, t), L = len(c);
      area[t] = L / 2; nrm[t] = L > 0 ? mul(c, 1 / L) : [0, 0, 0];
    }
    var cosTol = Math.cos(0.5 * Math.PI / 180), region = new Int32Array(nt).fill(-1), regions = [];
    for (t = 0; t < nt; t++) {
      if (region[t] >= 0 || !(area[t] > 0)) continue;
      var id = regions.length, stack = [t], tris = [], p0 = ptOf(M, M.f[t * 3]), n0 = nrm[t];
      region[t] = id;
      while (stack.length) {
        var u = stack.pop();
        tris.push(u);
        for (var e = 0; e < 3; e++) {
          var a = M.f[u * 3 + e], b = M.f[u * 3 + (e + 1) % 3], tw = H.he.get(b * M.nv + a);
          if (tw === undefined) continue;
          var w = (tw / 3) | 0;
          if (region[w] >= 0 || !(area[w] > 0) || dot(nrm[w], n0) < cosTol) continue;
          var ok = true;
          for (var k = 0; k < 3 && ok; k++) if (Math.abs(dot(sub(ptOf(M, M.f[w * 3 + k]), p0), n0)) > 1e-4 + 1e-5 * len(p0)) ok = false;
          if (!ok) continue;
          region[w] = id; stack.push(w);
        }
      }
      regions.push({ id: id, tris: tris, normal: n0, p0: p0 });
    }
    return { regions: regions, region: region, nrm: nrm, area: area };
  }
  function endFace(M, H, R, F, o) {
    var area = 0, c = [0, 0, 0], minCrease = 180, convex = true, closed = true;
    R.tris.forEach(function (t) {
      var p = triPts(M, t), g = mul(add(add(p[0], p[1]), p[2]), 1 / 3);
      area += F.area[t]; c = add(c, mul(g, F.area[t]));
      for (var e = 0; e < 3; e++) {
        var a = M.f[t * 3 + e], b = M.f[t * 3 + (e + 1) % 3], tw = H.he.get(b * M.nv + a);
        if (tw === undefined) { closed = false; continue; }
        var w = (tw / 3) | 0;
        if (F.region[w] === R.id) continue;
        var crease = deg(Math.acos(Math.max(-1, Math.min(1, dot(R.normal, F.nrm[w])))));
        if (crease < minCrease) minCrease = crease;
        var x = ptOf(M, M.f[w * 3 + (((tw % 3) + 2) % 3)]);                  // the far corner of the face across
        if (!(dot(R.normal, sub(x, ptOf(M, a))) < -1e-6)) convex = false;     // it must fall away behind the plane
      }
    });
    if (!(area > 0)) return null;
    c = mul(c, 1 / area);
    // in-plane extents: the narrower side is the wall
    var u = unit(cross(R.normal, Math.abs(R.normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])), v = cross(R.normal, u);
    var best = null;
    for (var ang = 0; ang < 180; ang += 5) {
      var ca = Math.cos(ang * Math.PI / 180), sa = Math.sin(ang * Math.PI / 180), ax = add(mul(u, ca), mul(v, sa)), ay = cross(R.normal, ax);
      var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      R.tris.forEach(function (t) {
        for (var k = 0; k < 3; k++) {
          var d = sub(ptOf(M, M.f[t * 3 + k]), c), q = [dot(d, ax), dot(d, ay)];
          for (var m = 0; m < 2; m++) { if (q[m] < lo[m]) lo[m] = q[m]; if (q[m] > hi[m]) hi[m] = q[m]; }
        }
      });
      var w2 = hi[0] - lo[0], h2 = hi[1] - lo[1], ar = w2 * h2;
      if (!best || ar < best.ar) best = { ar: ar, minSpan: Math.min(w2, h2), maxSpan: Math.max(w2, h2) };
    }
    return { id: R.id, tris: R.tris, normal: R.normal, centroid: c, areaMm2: area, minCrease: minCrease,
             convex: convex, closed: closed, minSpanMm: best.minSpan, maxSpanMm: best.maxSpan };
  }
  function overlapFrac(M, A, B, dir) {
    // the share of A's triangle centres that, carried along dir, land inside a triangle of B
    var tris = A.tris, step = Math.max(1, Math.floor(tris.length / 200)), hit = 0, tot = 0;
    var ax = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], u = unit(cross(dir, ax)), v = cross(dir, u);
    var o = A.centroid;
    var b2 = B.tris.map(function (t) {
      return triPts(M, t).map(function (p) { var d = sub(p, o); return [dot(d, u), dot(d, v)]; });
    });
    for (var i = 0; i < tris.length; i += step) {
      var p = triPts(M, tris[i]), g = mul(add(add(p[0], p[1]), p[2]), 1 / 3), d0 = sub(g, o), q = [dot(d0, u), dot(d0, v)];
      tot++;
      for (var j = 0; j < b2.length; j++) {
        var T = b2[j];
        function side(a, b) { return (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]); }
        var s1 = side(T[0], T[1]), s2 = side(T[1], T[2]), s3 = side(T[2], T[0]);
        if ((s1 >= -1e-9 && s2 >= -1e-9 && s3 >= -1e-9) || (s1 <= 1e-9 && s2 <= 1e-9 && s3 <= 1e-9)) { hit++; break; }
      }
    }
    return tot ? hit / tot : 0;
  }
  function gaps(soup, opts) {
    var o = Object.assign({ maxFaces: 24, minAreaMm2: 0.5, maxTris: 150000, minGapMm: 0.42 }, DEFAULTS, opts || {});
    if (triCount(soup) > o.maxTris) return [];
    var M = weld(soup, o.weldTol), H = halfEdges(M), F = flatRegions(M, H, o);
    var ends = [];
    F.regions.forEach(function (R) {
      var e = endFace(M, H, R, F, o);
      if (e && e.closed && e.convex && e.minCrease >= 20 && e.areaMm2 >= o.minAreaMm2) ends.push(e);
    });
    if (ends.length < 2 || ends.length > 400) return [];
    ends.sort(function (a, b) { return b.areaMm2 - a.areaMm2; });
    ends = ends.slice(0, 80);
    var cosOpp = -Math.cos(5 * Math.PI / 180), out = [];
    for (var i = 0; i < ends.length; i++) for (var j = i + 1; j < ends.length; j++) {
      var A = ends[i], B = ends[j];
      if (dot(A.normal, B.normal) > cosOpp) continue;
      var g = sub(B.centroid, A.centroid), gap = dot(g, A.normal);
      if (!(gap > 1e-6) || !(dot(g, B.normal) < -1e-6)) continue;               // facing, not facing away
      var wall = Math.min(A.minSpanMm, B.minSpanMm);
      if (!(gap <= 2 * wall) || gap < o.minGapMm) continue;           // under a line width is Check's thin-gap finding already
      var ratio = A.areaMm2 / B.areaMm2;
      if (ratio < 0.7 || ratio > 1 / 0.7) continue;
      if (overlapFrac(M, A, B, A.normal) < 0.8 || overlapFrac(M, B, A, A.normal) < 0.8) continue;
      // nothing between them: a ray from A's centre along its normal reaches B first
      var h = castRay(M, A.centroid, A.normal, A.tris[0], gap * 1.5);
      if (h && F.region[h.t] !== B.id) continue;
      out.push({ kind: 'faces', gapMm: gap, wallMm: wall, a: A, b: B,
                 centre: mul(add(A.centroid, B.centroid), 0.5), radiusMm: Math.max(A.maxSpanMm, B.maxSpanMm) / 2 + gap / 2 });
    }
    out.sort(function (x, y) { return y.a.areaMm2 - x.a.areaMm2; });
    return out.slice(0, o.maxFaces);
  }

  /* BRIDGE a gap: the two faces come off and the loops they leave are joined
     by the strip. Loops are matched one to one (outline to outline, hole to
     hole, nearest first). */
  function bridgeFaces(soup, gap, opts) {
    var o = Object.assign({}, DEFAULTS, opts || {}), t0 = now();
    var M = weld(soup, o.weldTol);
    var drop = new Uint8Array(M.nt);
    gap.a.tris.forEach(function (t) { drop[t] = 1; });
    gap.b.tris.forEach(function (t) { drop[t] = 1; });
    var keep = [], f2 = [];
    for (var t = 0; t < M.nt; t++) if (!drop[t]) { keep.push(t); f2.push(M.f[t * 3], M.f[t * 3 + 1], M.f[t * 3 + 2]); }
    var M2 = { nv: M.nv, pos: M.pos, nt: keep.length, f: Int32Array.from(f2), tol: M.tol };
    var H2 = halfEdges(M2), list = loopsOf(null, M2, H2);
    function rimSet(R) {
      var s = new Set();
      R.tris.forEach(function (tr) { for (var k = 0; k < 3; k++) s.add(M.f[tr * 3 + k]); });
      return s;
    }
    var sa = rimSet(gap.a), sb = rimSet(gap.b);
    var LA = list.filter(function (L) { return L.verts.every(function (v) { return sa.has(v); }); });
    var LB = list.filter(function (L) { return L.verts.every(function (v) { return sb.has(v); }); });
    if (!LA.length || LA.length !== LB.length) {
      return { ok: false, reason: 'the two faces have different outlines (' + LA.length + ' and ' + LB.length + ' loop(s)) - nothing changed' };
    }
    var tris = [], usedB = {}, spokeMax = 0, spokeMean = 0;
    for (var ia = 0; ia < LA.length; ia++) {
      var bestJ = -1, bestD = Infinity, ca = centroidOf(LA[ia].pts);
      for (var jb = 0; jb < LB.length; jb++) {
        if (usedB[jb]) continue;
        var cb = centroidOf(LB[jb].pts), d = len(sub(sub(cb, ca), mul(gap.a.normal, dot(sub(cb, ca), gap.a.normal))));
        if (d < bestD) { bestD = d; bestJ = jb; }
      }
      usedB[bestJ] = 1;
      var B = bridgeLoopsOnM(M2, LA[ia], LB[bestJ]);
      B.tris.forEach(function (tr) { tris.push(tr); });
      spokeMax = Math.max(spokeMax, B.spokeMaxMm); spokeMean += B.spokeMeanMm / LA.length;
    }
    var out = appendTris(soup, M, tris, keep);
    var before = topology(soup), after = topology(out);
    if (after.open > before.open || after.nm > before.nm || after.badWinding > before.badWinding) {
      return { ok: false, reason: 'the strip between the faces would not weld cleanly (open ' + before.open + '→' + after.open +
               ', doubled ' + before.nm + '→' + after.nm + ') - nothing changed' };
    }
    return { ok: true, soup: out, removed: gap.a.tris.length + gap.b.tris.length, added: tris.length,
             spokeMeanMm: spokeMean, spokeMaxMm: spokeMax, before: before, after: after, ms: now() - t0 };
  }

  var api = {
    DEFAULTS: DEFAULTS, KEY: KEY,
    _weld: weld, _halfEdges: halfEdges, _traceLoops: traceLoops, _cutRepeats: cutRepeats,
    _planeFit: planeFit, _math: { sub: sub, add: add, mul: mul, dot: dot, cross: cross, len: len, unit: unit, deg: deg, now: now, triCount: triCount, ptOf: ptOf },
    loopsOf: loopsOf, loops: loops, describe: describe, topology: topology,
    patch: patch, cap: cap, readout: readout, bridgeLoops: bridgeLoops, loopsAt: loopsAt, gaps: gaps, bridgeFaces: bridgeFaces, plan: plan, loopsTouching: loopsTouching,
    _castRay: castRay, _wallNearLoops: wallNearLoops, _zipper: zipper, _fillNormal: fillNormal, _appendTris: appendTris, _bridgeLoopsOnM: bridgeLoopsOnM, _triNormal: triNormal, _triPts: triPts, _fillLoops: fillLoops, _triangulateLoop: triangulateLoop
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_Patch = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
