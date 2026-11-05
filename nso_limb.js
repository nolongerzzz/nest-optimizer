/* nso_limb.js - Limb: grab a branch anywhere along it, then stretch it or bend it.

   Loads as a classic script (window.NSO_Limb) and as a Node module. No DOM, no
   THREE, no app state - tools/nso_limb_test.js drives it headless and
   app-limb.js is the pointer session on top of it. See docs/LIMB.md.

   WHY THIS EXISTS. Extend holds a cross-section bit for bit, so it needs ONE
   straight axis that is X, Y or Z, and a whole tree has none: its trunk leans,
   its branches leave at every angle. Pull has no such rule, but its falloff is
   a ball of radius <= 50 mm in SPACE, so grabbing one tip drags the twig beside
   it, and what it drags it drags with a bell, never as a limb. A branch is a
   thing you move by its topology, so that is what this does.

   THE PIECE IS A TREE. The root is the part of the piece that sits lowest
   (the trunk's foot). d(v) is the distance over the surface from the root to
   every vertex (Dijkstra on the mesh's edges), so a branch is a stretch of the
   surface where d runs from its fork up to its tip, and the level sets of d
   are the loops that go round it. Sweeping the vertices from the highest d
   down with a union-find tells everything the tool needs:

     CARRIED   the vertices that are still connected to the grab through
               vertices at least as far from the root as the grab: the tip
               end of the grab and everything that grows out of it, twigs,
               sub-branches and all. These move RIGIDLY.
     FORK      going down from the grab, the first vertex at which the grab's
               branch joins another branch that is longer than PERSIST_MM
               beyond that vertex (a bump on a tip is not a branch: it is
               swallowed). Everything above it is the LIMB.
     HINGE Q   the centre of the loop where the limb meets the fork; the grab's
               own loop has the centre A. Q -> A is the limb's bone.
     FLEX ZONE the limb below the grab: the vertices between the two loops.
               Nothing grows out of it - the fork above is the first junction -
               so it is one internode, and it is the only part that deforms.

   THE MOVE. The grab's centre A is taken to a new place A' (the cursor, or an
   Extend by so many mm, or a Bend by so many degrees). The flex zone becomes a
   pipe bent the way the Bend tool bends one, with one change: the turn and the
   stretch are not spread evenly along it but ramp with g(s) = smoothstep(s / L),
   s the position along the bone, so neither jumps at the fork or at the grab.

       the centre line:   c(s) = integral from 0 to s of  sigma'(s') (cos(phi) u0 + sin(phi) b) ds'
                          phi(s) = theta g(s)       the section's turn so far
                          sigma(s) = s + e g(s)     arc length: the bone grows by e
       a vertex at (s, y, z) - s along the bone, y towards the side the bone leans
       to (b), z across (n = u0 x b) - goes to

                          Q + c(s) + y (cos(phi) b - sin(phi) u0) + z n

   Every ring of the zone is carried whole - the girth of the limb is the girth
   it had - and the centre line is exactly L + e long. The zone leaves the fork
   along u0 with no curvature and the tip end leaves it along u1, turned by theta,
   with none. The carried part (the grab and everything beyond it) takes the rigid
   motion that carries the end frame, T(x) = Q + c(L) + R(x - A), R the turn
   by theta about n, so its shape is untouched. With theta = 0 this is an Extend:
   each ring slides e g(s) along the bone and none of them changes shape.

   FOLLOWING THE CURSOR. A drag asks for the grab's centre to LAND on a point, and
   a bent pipe's end is not where its tangent points, so displaceTo solves for the
   (theta, e) whose c(L) is that point (Newton, ~6 steps, to 1e-6 mm). 'bend'
   holds e = 0 and solves theta alone; 'extend' is theta = 0.

   HOW FAR A BEND CAN GO. The zone folds over itself where its radius of curvature
   is no bigger than its own half-width. The curve is tightest mid-zone, where the
   turn runs at 1.5 theta / L and the centre line at 1 + 1.5 e / L, so theta is
   capped at (L + 1.5 e) / (1.5 x 1.2 x w), w the widest vertex of the zone from the
   bone, and at MAX_BEND_DEG. A shortening stops at MIN_ZONE_FRAC of the zone.

   WHAT DOES NOT MOVE. Every vertex that is not part of the limb is copied
   through untouched. Nothing is scaled. No vertex is welded or deleted.

   THE FLEX ZONE IS DENSIFIED first (nso_densify.js, SPACING mm) so that the
   bend has vertices to bend with; the rest of the piece keeps its triangles.

   THE GUARDS, at release, on the result:
     COLLAPSE   a triangle gone to zero area is a fold.
     FLIP       a triangle that turned inside out (its normal reversed) is a
                fold too; the usual cause is a bend too sharp for a short zone.
     SELF-INTERSECTION  the canonical count (NSO_Repair), before and after on
                the same triangulation; it may not rise.
   A refused move returns the words and no triangles.

     NSO_Limb.context(rawTris)                     -> ctx  (weld + distance from the root, reusable)
     NSO_Limb.probe(ctx, click, opts)              -> the limb a click would grab (no densify)
     NSO_Limb.prepare(rawTris, click, opts)        -> S      (S.ok false = refused)
        click [x,y,z] a point on the surface
        opts  { reach = 0 (mm; 0 = down to the fork), spacing = 1, maxTris, ctx, densify = true }
     NSO_Limb.setReach(S, reach)                   hinge the zone nearer the grab than the fork
     NSO_Limb.displaceTo(S, D, mode)               the grab's centre follows D ('free' | 'extend' | 'bend')
     NSO_Limb.displaceBy(S, extendMm, bendDeg, toward)
     NSO_Limb.finish(S, opts)                      the guards -> { ok, reason, tris, report }
*/
(function (root) {
  'use strict';

  var Densify = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./nso_densify.js') : root.NSO_Densify;

  var SPACING = 1.0;           // mm, the densify target in the flex zone
  var PERSIST_MM = 1.5;        // a branch shorter than this beyond its joint is a bump, not a fork
  var BASE_FRAC = 0.03;        // the root is the lowest 3% of the piece's height
  var MIN_ZONE_FRAC = 0.4;     // a limb may be shortened to this fraction of its flex zone, no further
  var FOLD_SAFETY = 1.2;       // the bend radius stays this many half-widths of the zone
  var TABLE = 512;             // steps in the centre-line integral
  var MAX_BEND_DEG = 110;      // a bend past this is a fold, not a limb
  var MAX_TRIS = 600000;

  function round3(v) { return Math.round(v * 1000) / 1000; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, k) { return [a[0] * k, a[1] * k, a[2] * k]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function unit(a) { var l = len(a); return l > 0 ? mul(a, 1 / l) : [0, 0, 0]; }

  /* ------------------------------------------------------------- the graph */

  function buildGraph(mesh) {
    var V = mesh.vertCount, T = mesh.triCount, tri = mesh.tri, k, t;
    var deg = new Int32Array(V + 1);
    for (t = 0; t < T; t++) {
      for (k = 0; k < 3; k++) { deg[tri[t * 3 + k] + 1] += 2; }
    }
    for (var v = 0; v < V; v++) deg[v + 1] += deg[v];
    var raw = new Int32Array(deg[V]), fill = new Int32Array(V);
    for (t = 0; t < T; t++) {
      for (k = 0; k < 3; k++) {
        var a = tri[t * 3 + k], b = tri[t * 3 + (k + 1) % 3];
        raw[deg[a] + fill[a]++] = b;
        raw[deg[b] + fill[b]++] = a;
      }
    }
    // each edge was listed by both of its triangles: keep one of each.
    var start = new Int32Array(V + 1), list = new Int32Array(deg[V]), seen = new Int32Array(V), n = 0;
    for (v = 0; v < V; v++) {
      start[v] = n;
      for (var j = deg[v]; j < deg[v + 1]; j++) {
        var u = raw[j];
        if (seen[u] === v + 1) continue;
        seen[u] = v + 1;
        list[n++] = u;
      }
    }
    start[V] = n;
    return { start: start, list: list.subarray(0, n) };
  }

  function dist(pos, a, b) {
    var dx = pos[a * 3] - pos[b * 3], dy = pos[a * 3 + 1] - pos[b * 3 + 1], dz = pos[a * 3 + 2] - pos[b * 3 + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* Distance over the surface from the nearest of `sources`, along the mesh's
     edges. A binary heap with lazy deletion. */
  function geodesic(mesh, g, sources) {
    var V = mesh.vertCount, pos = mesh.pos, d = new Float64Array(V).fill(Infinity);
    var cap = g.list.length + sources.length + 8;
    var hk = new Float64Array(cap), hv = new Int32Array(cap), hn = 0;
    function push(k, v) {
      var i = hn++;
      while (i > 0) {
        var p = (i - 1) >> 1;
        if (hk[p] <= k) break;
        hk[i] = hk[p]; hv[i] = hv[p]; i = p;
      }
      hk[i] = k; hv[i] = v;
    }
    function pop() {
      hn--;
      var k = hk[hn], v = hv[hn], i = 0;
      for (;;) {
        var a = 2 * i + 1, b = a + 1, s = i, sk = k;
        if (a < hn && hk[a] < sk) { s = a; sk = hk[a]; }
        if (b < hn && hk[b] < sk) { s = b; sk = hk[b]; }
        if (s === i) break;
        hk[i] = hk[s]; hv[i] = hv[s]; i = s;
      }
      hk[i] = k; hv[i] = v;
    }
    var q;
    for (q = 0; q < sources.length; q++) { d[sources[q]] = 0; push(0, sources[q]); }
    while (hn) {
      var k0 = hk[0], u = hv[0];
      pop();
      if (k0 > d[u]) continue;
      for (var j = g.start[u]; j < g.start[u + 1]; j++) {
        var w = g.list[j], nd = k0 + dist(pos, u, w);
        if (nd < d[w]) { d[w] = nd; push(nd, w); }
      }
    }
    return d;
  }

  /* The root: the vertices in the lowest BASE_FRAC of the piece's height. */
  function baseVertices(mesh) {
    var V = mesh.vertCount, pos = mesh.pos, lo = Infinity, hi = -Infinity, v;
    for (v = 0; v < V; v++) {
      var z = pos[v * 3 + 2];
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
    var cut = lo + BASE_FRAC * (hi - lo), out = [];
    for (v = 0; v < V; v++) if (pos[v * 3 + 2] <= cut) out.push(v);
    return out;
  }

  /* weld + graph + distance from the root: all that does not depend on where
     the click is, so a hover can ask a hundred questions of one context. */
  function context(rawTris, mesh) {
    if (!Densify) return { ok: false, reason: 'nso_densify.js is not loaded' };
    if (!mesh) {
      if (!rawTris || rawTris.length < 9) return { ok: false, reason: 'empty piece' };
      mesh = Densify.weld(rawTris);
    }
    if (!mesh.triCount) return { ok: false, reason: 'nothing left after welding' };
    var g = buildGraph(mesh);
    var roots = baseVertices(mesh);
    var d = geodesic(mesh, g, roots);
    var V = mesh.vertCount, order = new Int32Array(V), v;
    for (v = 0; v < V; v++) order[v] = v;
    order.sort(function (a, b) { return (d[b] - d[a]) || (a - b); });     // highest first
    for (v = 0; v < V; v++) {
      if (!isFinite(d[v])) return { ok: false, reason: 'the piece is not one connected surface - the limb tool needs a single tree' };
    }
    return { ok: true, mesh: mesh, graph: g, roots: roots, d: d, order: order };
  }

  function nearestVertex(pos, V, c) {
    var best = -1, bd = Infinity;
    for (var v = 0; v < V; v++) {
      var dx = pos[v * 3] - c[0], dy = pos[v * 3 + 1] - c[1], dz = pos[v * 3 + 2] - c[2];
      var q = dx * dx + dy * dy + dz * dz;
      if (q < bd) { bd = q; best = v; }
    }
    return best;
  }

  /* ---------------------------------------------------------------- analyse */

  /* The limb a grab at `click` would take. */
  function analyze(ctx, click) {
    var mesh = ctx.mesh, g = ctx.graph, d = ctx.d, order = ctx.order, pos = mesh.pos, V = mesh.vertCount;
    var vg = nearestVertex(pos, V, click);
    var parent = new Int32Array(V).fill(-1), maxd = new Float64Array(V), added = new Uint8Array(V);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function flood(seed) {
      var mask = new Uint8Array(V), stack = [seed], n = 0;
      mask[seed] = 1;
      while (stack.length) {
        var u = stack.pop(); n++;
        for (var j = g.start[u]; j < g.start[u + 1]; j++) {
          var w = g.list[j];
          if (added[w] && !mask[w]) { mask[w] = 1; stack.push(w); }
        }
      }
      return { mask: mask, n: n };
    }
    var carried = null, gAdded = false, fork = -1, i, j;
    for (i = 0; i < V; i++) {
      var v = order[i], comps = [];
      for (j = g.start[v]; j < g.start[v + 1]; j++) {
        var u = g.list[j];
        if (!added[u]) continue;
        var r = find(u);
        if (comps.indexOf(r) < 0) comps.push(r);
      }
      if (gAdded && comps.length >= 2) {
        var rg = find(vg);
        if (comps.indexOf(rg) >= 0 && maxd[rg] - d[v] >= PERSIST_MM) {
          for (var c = 0; c < comps.length; c++) {
            if (comps[c] !== rg && maxd[comps[c]] - d[v] >= PERSIST_MM) { fork = v; break; }
          }
          if (fork >= 0) break;
        }
      }
      added[v] = 1; parent[v] = v; maxd[v] = d[v];
      for (j = 0; j < comps.length; j++) {
        var a = find(v), b = find(comps[j]);
        if (a !== b) { parent[b] = a; if (maxd[b] > maxd[a]) maxd[a] = maxd[b]; }
      }
      if (v === vg) { gAdded = true; carried = flood(vg).mask; }
    }
    var limb = flood(vg).mask;
    if (!carried) carried = limb;               // unreachable: vg is always added before any fork
    var atBase = fork < 0;

    function centre(mask) {
      var sx = 0, sy = 0, sz = 0, n = 0;
      for (var v2 = 0; v2 < V; v2++) {
        if (!mask[v2]) continue;
        var edge = false;
        for (var j2 = g.start[v2]; j2 < g.start[v2 + 1]; j2++) if (!mask[g.list[j2]]) { edge = true; break; }
        if (!edge) continue;
        sx += pos[v2 * 3]; sy += pos[v2 * 3 + 1]; sz += pos[v2 * 3 + 2]; n++;
      }
      return n ? { c: [sx / n, sy / n, sz / n], n: n } : null;
    }
    var A = centre(carried);
    var Q = atBase ? null : centre(limb);
    if (!Q) {
      var rx = 0, ry = 0, rz = 0;
      for (j = 0; j < ctx.roots.length; j++) { rx += pos[ctx.roots[j] * 3]; ry += pos[ctx.roots[j] * 3 + 1]; rz += pos[ctx.roots[j] * 3 + 2]; }
      Q = { c: [rx / ctx.roots.length, ry / ctx.roots.length, rz / ctx.roots.length], n: ctx.roots.length };
    }
    if (!A) return { ok: false, reason: 'the grab is the whole piece - there is nothing to hold still' };
    var chord = sub(A.c, Q.c), L = len(chord);
    if (!(L > 1e-6)) return { ok: false, reason: 'the limb has no length between its fork and the grab' };

    var nLimb = 0, nCarried = 0;
    for (var v3 = 0; v3 < V; v3++) { if (limb[v3]) nLimb++; if (carried[v3]) nCarried++; }
    return {
      ok: true, vg: vg, fork: fork, atBase: atBase, tFork: fork >= 0 ? d[fork] : 0, dGrab: d[vg],
      limb: limb, carried: carried, nLimb: nLimb, nCarried: nCarried,
      Q: Q.c, A: A.c, u0: mul(chord, 1 / L), L: L,
      grabPoint: [pos[vg * 3], pos[vg * 3 + 1], pos[vg * 3 + 2]]
    };
  }

  /* The loop's radius, for the marker and for the zone's densify sphere: the
     median distance of the limb's vertices near the grab from the bone. */
  function ringRadius(mesh, an) {
    var pos = mesh.pos, V = mesh.vertCount, Q = an.Q, u0 = an.u0, near = [];
    var band = Math.max(1, 0.2 * an.L);
    for (var v = 0; v < V; v++) {
      if (!an.limb[v]) continue;
      var rel = [pos[v * 3] - Q[0], pos[v * 3 + 1] - Q[1], pos[v * 3 + 2] - Q[2]];
      var s = dot(rel, u0);
      if (Math.abs(s - an.L) > band) continue;
      var perp = sub(rel, mul(u0, s));
      near.push(len(perp));
    }
    if (!near.length) return 1.5;
    near.sort(function (a, b) { return a - b; });
    return near[near.length >> 1];
  }

  /* What a click would grab, for the hover marker: no densify, no copy. */
  function probe(ctx, click) {
    if (!ctx || !ctx.ok) return { ok: false, reason: ctx ? ctx.reason : 'no context' };
    var an = analyze(ctx, click);
    if (!an.ok) return an;
    an.radius = ringRadius(ctx.mesh, an);
    return an;
  }

  /* ---------------------------------------------------------------- prepare */

  function prepare(rawTris, click, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '' };
    if (!Densify) { out.reason = 'nso_densify.js is not loaded'; return out; }
    if (!click || click.length < 3) { out.reason = 'no grab point'; return out; }
    var ctx0 = opts.ctx && opts.ctx.ok ? opts.ctx : context(rawTris);
    if (!ctx0.ok) { out.reason = ctx0.reason; return out; }
    var an = analyze(ctx0, click);
    if (!an.ok) { out.reason = an.reason; return out; }

    var spacing = opts.spacing > 0 ? opts.spacing : SPACING;
    var mesh = ctx0.mesh, ctx = ctx0, dens = null;
    if (opts.densify !== false) {
      // a sphere round the flex zone: every vertex of it, from its midpoint.
      var M = mul(add(an.Q, an.A), 0.5), r = an.L / 2 + 1, pos0 = ctx0.mesh.pos, V0 = ctx0.mesh.vertCount;
      for (var v = 0; v < V0; v++) {
        if (!an.limb[v] || an.carried[v]) continue;
        var dx = pos0[v * 3] - M[0], dy = pos0[v * 3 + 1] - M[1], dz = pos0[v * 3 + 2] - M[2];
        var q = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (q + 0.5 > r) r = q + 0.5;
      }
      var reg = Densify.region(rawTris, { c: M, r: r }, { spacing: spacing, maxTris: opts.maxTris || MAX_TRIS, margin: opts.margin });
      if (!reg.ok) { out.reason = reg.reason; return out; }
      dens = reg.report;
      if (reg.changed) {
        ctx = context(null, reg.mesh);
        if (!ctx.ok) { out.reason = ctx.reason; return out; }
        an = analyze(ctx, click);
        if (!an.ok) { out.reason = an.reason; return out; }
        mesh = reg.mesh;
      }
    }

    var V = mesh.vertCount, T = mesh.triCount, tri = mesh.tri, t, k, vv;
    var vdeg = new Int32Array(V + 1);
    for (t = 0; t < T * 3; t++) vdeg[tri[t] + 1]++;
    for (vv = 0; vv < V; vv++) vdeg[vv + 1] += vdeg[vv];
    var vtList = new Int32Array(T * 3), fill = new Int32Array(V);
    for (t = 0; t < T; t++) for (k = 0; k < 3; k++) { var w = tri[t * 3 + k]; vtList[vdeg[w] + fill[w]++] = t; }

    var basePos = new Float64Array(mesh.pos);
    var S = {
      ok: true, reason: '', mesh: mesh, ctx: ctx, basePos: basePos, pos: new Float64Array(basePos),
      vtStart: vdeg, vtList: vtList, densify: dens, origTris: rawTris, spacing: spacing,
      an: an, click: click.slice(), carried: an.carried, limb: an.limb,
      Q0: an.Q, A: an.A, u0: an.u0, L: an.L, radius: ringRadius(mesh, an),
      fork: { atBase: an.atBase, at: an.Q, length: an.L }
    };
    var list = [];
    for (vv = 0; vv < V; vv++) if (an.limb[vv]) list.push(vv);
    S.limbList = new Int32Array(list);
    S.touched = new Int32Array(0);
    setReach(S, opts.reach || 0);
    return S;
  }

  /* Hinge the zone `reach` mm below the grab, or at the fork (reach 0, or more
     than the fork allows). It decides which vertices move and where the zone
     starts; nothing else about the limb changes. */
  function setReach(S, reach) {
    var i, v, o;
    for (i = 0; i < S.touched.length; i++) {     // whatever the last reach moved goes back
      v = S.touched[i]; o = v * 3;
      S.pos[o] = S.basePos[o]; S.pos[o + 1] = S.basePos[o + 1]; S.pos[o + 2] = S.basePos[o + 2];
    }
    var want = reach > 0 ? reach : S.L;
    S.reach = Math.min(S.L, Math.max(0.05, want));
    S.reachClipped = reach > 0 && reach > S.L;
    S.Q = sub(S.A, mul(S.u0, S.reach));          // the hinge: Q0 itself when the reach is the whole bone
    var touched = [], bp = S.basePos, half = 0, u0 = S.u0, Q = S.Q, ss = [];
    for (i = 0; i < S.limbList.length; i++) {
      v = S.limbList[i]; o = v * 3;
      var rx = bp[o] - Q[0], ry = bp[o + 1] - Q[1], rz = bp[o + 2] - Q[2];
      var s = rx * u0[0] + ry * u0[1] + rz * u0[2];
      if (!S.carried[v] && s <= 0) continue;
      touched.push(v); ss.push(s);
      if (S.carried[v]) continue;
      var px = rx - s * u0[0], py = ry - s * u0[1], pz = rz - s * u0[2];
      var w = Math.sqrt(px * px + py * py + pz * pz);
      if (s < S.reach && w > half) half = w;
    }
    S.touched = new Int32Array(touched);
    S.half = half;                               // the zone's widest vertex from the bone
    /* The cut between the zone and the carried part is a loop of the surface
       and it is never square to the bone, so a few carried vertices lie a
       little short of the grab along it. Those follow the zone's own law (it
       is the rigid motion's, to the last digit, at s = L), and only a carried
       vertex further than that from the cut - a twig that hooks back past the
       grab, say - is held rigid whatever its s. */
    var band = 2 * half + 2 * S.spacing, dg = S.ctx.d[S.an.vg];
    S.rigid = new Uint8Array(touched.length);
    for (i = 0; i < touched.length; i++) {
      v = touched[i];
      S.rigid[i] = (S.carried[v] && (ss[i] <= 0 || ss[i] >= S.reach || S.ctx.d[v] - dg > band)) || ss[i] >= S.reach ? 1 : 0;
    }
    S.last = null;
    return S;
  }

  /* --------------------------------------------------------------- the move */

  /* The zone's centre line in the bone's frame, for a turn of th and a growth of
     e: cu[k], cb[k] at s = L k / TABLE, along u0 and along the lean b. */
  function profile(L, e, th) {
    var K = TABLE, cu = new Float64Array(K + 1), cb = new Float64Array(K + 1), h = L / K;
    var pu = 1, pb = 0;
    for (var k = 1; k <= K; k++) {
      var t = k / K, g = t * t * (3 - 2 * t), sp = 1 + e * 6 * t * (1 - t) / L, phi = th * g;
      var iu = sp * Math.cos(phi), ib = sp * Math.sin(phi);
      cu[k] = cu[k - 1] + 0.5 * h * (pu + iu);
      cb[k] = cb[k - 1] + 0.5 * h * (pb + ib);
      pu = iu; pb = ib;
    }
    return { cu: cu, cb: cb };
  }

  /* Where the zone's end lands, (along u0, along b), for (th, e). */
  function endPoint(L, e, th) {
    if (th < 1e-9) return [L + e, 0];
    var p = profile(L, e, th);
    return [p.cu[TABLE], p.cb[TABLE]];
  }

  /* The widest a bend of this zone can be when it grows by e, in radians. The
     curve is tightest mid-zone, where the turn runs at 1.5 theta / L and the
     centre line at 1 + 1.5 e / L: a radius of (L + 1.5 e) / (1.5 theta). */
  function maxTurn(S, e) {
    var m = MAX_BEND_DEG * Math.PI / 180, eff = S.reach + 1.5 * e;
    return S.half > 0 ? Math.min(m, eff / (1.5 * FOLD_SAFETY * S.half)) : m;
  }
  function minGrowth(S) { return -(1 - MIN_ZONE_FRAC) * S.reach; }

  /* Turn S.pos into the moved limb for a turn th towards b and a growth e. Only
     the touched vertices are written. */
  function apply(S, th, e, b) {
    var u0 = S.u0, Q = S.Q, Lr = S.reach, A = S.A, bp = S.basePos, pos = S.pos, i, v, o;
    var res = { ext: e, angleDeg: th * 180 / Math.PI, len: Lr + e, b: b };
    if (th < 1e-9) {
      // a pure Extend: a ring at s slides e g(s) along the bone, the carried part e.
      for (i = 0; i < S.touched.length; i++) {
        v = S.touched[i]; o = v * 3;
        var sx = (bp[o] - Q[0]) * u0[0] + (bp[o + 1] - Q[1]) * u0[1] + (bp[o + 2] - Q[2]) * u0[2];
        var tt = Math.min(1, Math.max(0, sx / Lr));
        var slide = S.rigid[i] ? e : e * tt * tt * (3 - 2 * tt);
        pos[o] = bp[o] + slide * u0[0]; pos[o + 1] = bp[o + 1] + slide * u0[1]; pos[o + 2] = bp[o + 2] + slide * u0[2];
      }
      res.u1 = u0; res.A1 = add(A, mul(u0, e));
      S.last = res;
      return res;
    }
    var n = cross(u0, b), cth = Math.cos(th), sth = Math.sin(th), K = TABLE;
    var pr = profile(Lr, e, th), cu = pr.cu, cb = pr.cb;
    var Eu = cu[K], Eb = cb[K];                        // the end of the centre line
    var A1 = [Q[0] + Eu * u0[0] + Eb * b[0], Q[1] + Eu * u0[1] + Eb * b[1], Q[2] + Eu * u0[2] + Eb * b[2]];
    for (i = 0; i < S.touched.length; i++) {
      v = S.touched[i]; o = v * 3;
      var rx = bp[o] - Q[0], ry = bp[o + 1] - Q[1], rz = bp[o + 2] - Q[2];
      var px, py, pz, cu2, cb2;
      if (S.rigid[i]) {
        // rigid: the end frame carries it. R turns u0 onto u1 about n.
        var ex = bp[o] - A[0], ey = bp[o + 1] - A[1], ez = bp[o + 2] - A[2];
        var eu = ex * u0[0] + ey * u0[1] + ez * u0[2], eb = ex * b[0] + ey * b[1] + ez * b[2], en = ex * n[0] + ey * n[1] + ez * n[2];
        cu2 = Eu + eu * cth - eb * sth; cb2 = Eb + eu * sth + eb * cth;
        px = Q[0] + cu2 * u0[0] + cb2 * b[0] + en * n[0];
        py = Q[1] + cu2 * u0[1] + cb2 * b[1] + en * n[1];
        pz = Q[2] + cu2 * u0[2] + cb2 * b[2] + en * n[2];
      } else {
        var s = rx * u0[0] + ry * u0[1] + rz * u0[2];
        var y = rx * b[0] + ry * b[1] + rz * b[2];
        var z = rx * n[0] + ry * n[1] + rz * n[2];
        var f = Math.min(1, Math.max(0, s / Lr)) * K, k0 = Math.min(K - 1, Math.floor(f)), fr = f - k0;
        var tt2 = f / K, phi = th * tt2 * tt2 * (3 - 2 * tt2), cp = Math.cos(phi), sp = Math.sin(phi);
        var cx = cu[k0] + (cu[k0 + 1] - cu[k0]) * fr, cy = cb[k0] + (cb[k0 + 1] - cb[k0]) * fr;
        cu2 = cx - y * sp; cb2 = cy + y * cp;
        px = Q[0] + cu2 * u0[0] + cb2 * b[0] + z * n[0];
        py = Q[1] + cu2 * u0[1] + cb2 * b[1] + z * n[1];
        pz = Q[2] + cu2 * u0[2] + cb2 * b[2] + z * n[2];
      }
      pos[o] = px; pos[o + 1] = py; pos[o + 2] = pz;
    }
    res.u1 = add(mul(u0, cth), mul(b, sth)); res.A1 = A1;
    S.last = res;
    return res;
  }

  function perpUnit(S, v) {
    var p = sub(v, mul(S.u0, dot(v, S.u0))), l = len(p);
    if (l > 1e-9) return mul(p, 1 / l);
    var any = Math.abs(S.u0[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return unit(cross(S.u0, any));
  }

  /* The grab's centre follows D, landing on A + D (or, in 'extend', on the
     part of D along the bone; in 'bend', on the ray towards it, the limb's
     length held). Returns what was done, and said so when a limit cut in. */
  function displaceTo(S, D, mode) {
    var t = add(S.A, D), rel = sub(t, S.Q), Lr = S.reach;
    var cu = dot(rel, S.u0), perp = sub(rel, mul(S.u0, cu)), cbT = len(perp);
    var b = perpUnit(S, rel), clampedAngle = false, clampedLen = false, th = 0, e = 0;
    if (mode === 'extend') { th = 0; e = Math.max(minGrowth(S), cu - Lr); clampedLen = cu - Lr < minGrowth(S); }
    else {
      var alpha = Math.atan2(cbT, cu), Lc = Math.sqrt(cu * cu + cbT * cbT);
      if (cu < 0) alpha = Math.min(Math.PI, alpha);
      // the turn the chord needs is about twice the angle it makes with the bone
      th = 2 * alpha;
      if (mode === 'bend') {
        e = 0;
        var lim = maxTurn(S, 0);
        if (th > lim) { th = lim; clampedAngle = true; }
        // one unknown: bisect th so that the chord of the zone makes the angle alpha
        var lo = 0, hi = Math.min(lim, Math.PI * 1.2);
        if (alpha < 1e-9) { th = 0; }
        else {
          for (var it = 0; it < 60; it++) {
            var mid = 0.5 * (lo + hi), ep = endPoint(Lr, 0, mid), ang = Math.atan2(ep[1], ep[0]);
            if (ang < alpha) lo = mid; else hi = mid;
          }
          th = Math.min(lim, 0.5 * (lo + hi));
          clampedAngle = clampedAngle || (alpha > Math.atan2(endPoint(Lr, 0, lim)[1], endPoint(Lr, 0, lim)[0]) + 1e-9);
        }
      } else {
        // two unknowns, (th, e): Newton on (chord length, chord angle)
        e = Lc - Lr;
        var minE = minGrowth(S), tgt = [Lc, alpha];
        function polar(x, y) { var q = endPoint(Lr, y, x); return [Math.sqrt(q[0] * q[0] + q[1] * q[1]), Math.atan2(q[1], q[0])]; }
        if (alpha < 1e-9) { th = 0; e = Math.max(minE, cu - Lr); }
        else {
          for (var k = 0; k < 40; k++) {
            var f0 = polar(th, e), r0 = [f0[0] - tgt[0], f0[1] - tgt[1]];
            if (Math.abs(r0[0]) < 1e-7 && Math.abs(r0[1]) < 1e-9) break;
            var d1 = 1e-5, fa = polar(th + d1, e), fb = polar(th, e + d1 * Lr);
            var j00 = (fa[0] - f0[0]) / d1, j10 = (fa[1] - f0[1]) / d1;
            var j01 = (fb[0] - f0[0]) / (d1 * Lr), j11 = (fb[1] - f0[1]) / (d1 * Lr);
            var det = j00 * j11 - j01 * j10;
            if (Math.abs(det) < 1e-14) break;
            var dth = (j11 * r0[0] - j01 * r0[1]) / det, de = (-j10 * r0[0] + j00 * r0[1]) / det;
            th = Math.max(1e-6, th - dth); e = e - de;
          }
          if (e < minE) { e = minE; clampedLen = true; }
          var lim2 = maxTurn(S, e);
          if (th > lim2) { th = lim2; clampedAngle = true; }
        }
      }
    }
    var r = apply(S, th, e, b);
    r.clampedAngle = clampedAngle; r.clampedLen = clampedLen; r.maxAngle = maxTurn(S, e);
    r.miss = len(sub(r.A1, mode === 'extend' ? add(S.A, mul(S.u0, dot(D, S.u0))) : t));
    return r;
  }

  /* Extend by `extendMm` (negative shortens) and turn the tip end `bendDeg`
     towards `toward` (any vector; only the part square to the bone counts). */
  function displaceBy(S, extendMm, bendDeg, toward) {
    var e = Math.max(minGrowth(S), extendMm || 0), clampedLen = (extendMm || 0) < minGrowth(S);
    var th = Math.max(0, (bendDeg || 0)) * Math.PI / 180, lim = maxTurn(S, e), clampedAngle = false;
    if (th > lim) { th = lim; clampedAngle = true; }
    var r = apply(S, th, e, perpUnit(S, toward || [0, 0, 1]));
    r.clampedAngle = clampedAngle; r.clampedLen = clampedLen; r.maxAngle = lim;
    return r;
  }

  /* ------------------------------------------------------------------ guards */

  function areaN(pos, tri, t) {
    var a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
    var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    var wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    return [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
  }

  /* Collapse and flip, over the triangles that touch a moved vertex.

     A bend turns every normal on the tip side by up to theta, so "the normal
     reversed" cannot be asked of the raw normals: a clean 110 degree bend
     reverses all of them. Each triangle's old normal is first turned by the
     bend its vertices went through (theta g(s), or theta for a rigid vertex)
     about n, and it is that expected normal the new one is compared with. */
  function foldGuard(S) {
    var tri = S.mesh.tri, seen = new Uint8Array(S.mesh.triCount), zeroB = 0, zeroA = 0, flip = 0;
    var bent = S.last && S.last.angleDeg > 1e-6, th = bent ? S.last.angleDeg * Math.PI / 180 : 0;
    var u0 = S.u0, Q = S.Q, Lr = S.reach, n = bent ? cross(u0, S.last.b) : null;
    var slot = new Map();
    for (var i = 0; i < S.touched.length; i++) slot.set(S.touched[i], i);
    function turnOf(v) {
      if (!bent) return 0;
      var i2 = slot.get(v);
      if (i2 !== undefined && S.rigid[i2]) return th;
      if (i2 === undefined) return 0;
      var o = v * 3, sx = ((S.basePos[o] - Q[0]) * u0[0] + (S.basePos[o + 1] - Q[1]) * u0[1] + (S.basePos[o + 2] - Q[2]) * u0[2]) / Lr;
      sx = sx < 0 ? 0 : (sx > 1 ? 1 : sx);
      return th * sx * sx * (3 - 2 * sx);
    }
    for (var q = 0; q < S.touched.length; q++) {
      var v0 = S.touched[q];
      for (var j = S.vtStart[v0]; j < S.vtStart[v0 + 1]; j++) {
        var t = S.vtList[j];
        if (seen[t]) continue;
        seen[t] = 1;
        var nb = areaN(S.basePos, tri, t), na = areaN(S.pos, tri, t);
        var ab = len(nb) * 0.5, aa = len(na) * 0.5;
        if (ab <= 1e-12) zeroB++;
        if (aa <= 1e-12) { zeroA++; continue; }
        if (ab <= 1e-12) continue;
        var want = nb;
        if (bent) {
          var phi = (turnOf(tri[t * 3]) + turnOf(tri[t * 3 + 1]) + turnOf(tri[t * 3 + 2])) / 3;
          var c = Math.cos(phi), sn = Math.sin(phi), nd = dot(n, nb), cr = cross(n, nb);
          want = [nb[0] * c + cr[0] * sn + n[0] * nd * (1 - c), nb[1] * c + cr[1] * sn + n[1] * nd * (1 - c), nb[2] * c + cr[2] * sn + n[2] * nd * (1 - c)];
        }
        if (dot(want, na) < 0) flip++;
      }
    }
    var res = { ok: zeroA <= zeroB && flip === 0, zeroBefore: zeroB, zeroAfter: zeroA, flipped: flip };
    if (zeroA > zeroB) res.reason = 'the move would collapse ' + (zeroA - zeroB) + ' triangle' + (zeroA - zeroB === 1 ? '' : 's') + ' to nothing - the surface folds over itself';
    else if (flip) res.reason = 'the move would turn ' + flip + ' triangle' + (flip === 1 ? '' : 's') + ' inside out - the bend is too sharp for this limb (grab lower, or bend less)';
    return res;
  }

  function f32(pos) {
    var o = new Float64Array(pos.length);
    for (var i = 0; i < pos.length; i++) o[i] = Math.fround(pos[i]);
    return o;
  }

  /* The triangles with a vertex inside the box the moved vertices travel
     through, from where they were to where they went, grown by a millimetre. */
  function reachTriangles(S) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], i, k;
    for (i = 0; i < S.touched.length; i++) {
      var o = S.touched[i] * 3;
      for (k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], S.basePos[o + k], S.pos[o + k]);
        hi[k] = Math.max(hi[k], S.basePos[o + k], S.pos[o + k]);
      }
    }
    for (k = 0; k < 3; k++) { lo[k] -= 1; hi[k] += 1; }
    var tri = S.mesh.tri, T = S.mesh.triCount, bp = S.basePos, sel = [];
    for (var t = 0; t < T; t++) {
      for (var c = 0; c < 3; c++) {
        var p = tri[t * 3 + c] * 3;
        if (bp[p] >= lo[0] && bp[p] <= hi[0] && bp[p + 1] >= lo[1] && bp[p + 1] <= hi[1] && bp[p + 2] >= lo[2] && bp[p + 2] <= hi[2]) {
          sel.push(tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]); break;
        }
      }
    }
    return new Int32Array(sel);
  }

  function pierceGuard(S, opts) {
    var R = (opts && opts.repair) || root.NSO_Repair;
    if (!R || typeof R._selfIntersectionDetail !== 'function') {
      return { ok: false, unavailable: true, reason: 'the canonical self-intersection checker (NSO_Repair) is not loaded' };
    }
    var faces = reachTriangles(S);
    var before = R._selfIntersectionDetail({ pos: f32(S.basePos), faces: faces }).pierce;
    var after = R._selfIntersectionDetail({ pos: f32(S.pos), faces: faces }).pierce;
    var res = { ok: after <= before, before: before, after: after, triangles: faces.length / 3 };
    if (!res.ok) {
      res.reason = 'the moved limb would pass through the tree (' + after + ' self-intersecting pair' +
        (after === 1 ? '' : 's') + ' where it had ' + before + ')';
    }
    return res;
  }

  function finish(S, opts) {
    opts = opts || {};
    var res = { ok: false, reason: '', tris: S.origTris, report: null };
    if (!S.last || (Math.abs(S.last.ext) < 1e-9 && S.last.angleDeg < 1e-9)) {
      res.ok = true; res.noop = true; res.reason = 'the limb did not move'; return res;
    }
    var fold = foldGuard(S);
    if (!fold.ok) { res.reason = fold.reason; res.report = { fold: fold }; return res; }
    var pierce = pierceGuard(S, opts);
    if (!pierce.ok) { res.reason = pierce.reason; res.report = { fold: fold, pierce: pierce }; return res; }
    res.ok = true;
    res.tris = Densify.toSoup(S.mesh, S.pos);
    res.report = {
      moved: S.touched.length, carried: S.an.nCarried, limb: S.an.nLimb,
      extend: S.last.ext, angleDeg: S.last.angleDeg, reach: S.reach, zone: S.L,
      densify: S.densify, fold: fold, pierce: pierce,
      trisBefore: (S.origTris.length / 9) | 0, trisAfter: S.mesh.triCount
    };
    return res;
  }

  /* The sentence a status line carries about what was grabbed. */
  function describe(S) {
    var f = S.an.atBase ? 'no fork below it - the whole piece swings from its foot' : 'down to the fork ' + round3(S.L) + ' mm below';
    return 'limb of ' + S.an.nCarried + ' carried vertices, flex zone ' + round3(S.reach) + ' mm (' + f + ')';
  }

  var API = {
    SPACING: SPACING, PERSIST_MM: PERSIST_MM, MAX_BEND_DEG: MAX_BEND_DEG, MIN_ZONE_FRAC: MIN_ZONE_FRAC,
    context: context, probe: probe, analyze: analyze, prepare: prepare, setReach: setReach,
    displaceTo: displaceTo, displaceBy: displaceBy, finish: finish, describe: describe,
    foldGuard: foldGuard, pierceGuard: pierceGuard
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Limb = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
