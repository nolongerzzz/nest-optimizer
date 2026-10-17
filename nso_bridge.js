/* nso_bridge.js - Bridge: stretch a web of mesh from one place on a piece to
   another place (on the same piece or another one) and weld both ends, so the
   result is one closed solid. docs/BRIDGE.md.

   Loads as a classic script (window.NSO_Bridge) and as a Node module. No DOM,
   no THREE. Every soup is the app's usual triangle soup (9 numbers a
   triangle), in ONE frame for both pieces: the plate's world frame, Z up
   (app-bridge.js reads each placed mesh with meshToWorldSoup and turns it
   Z up), so the two pieces' poses are already in the numbers.

   What is picked chooses the web - one card, no mode switch:

     face -> face    BAND. A ruled loft between the two face outlines. The
                     outlines are resampled onto one shared set of points
                     (every vertex of either outline, nothing else), matched
                     by the rotation that puts them nearest each other, so the
                     band does not twist. Both faces' cap triangles go, the
                     walls next to them take the new points (split, so no
                     T-junction is left), and the band is stitched to the two
                     loops on the very same numbers - no kernel, no snapping.
                     Identical parallel faces give a plain straight band.
     point -> point  STRING. A round rod (default 2 mm), each end sunk under
                     the surface by Assemble's own seat measure (the rim gap,
                     NSO_Assemble.rootGap) plus 0.5 mm, then unioned.
     edge -> edge    SHEET. A flat slab between two straight edges, a
                     thickness field (default the thinner piece's wall, at
                     least two nozzle widths), its ends sunk 0.5 mm into both
                     pieces and unioned. Flush with the faces either side when
                     the edges' faces lie in the sheet's plane.

   Reused, not re-implemented:
     NSO_fuseTolerance / NSO_fuseVertGrid   (nso_planar_fuse.js) the vertex
        space and its tolerance - Join's planar fuse, the same rules
     NSO_PathSweep.sweep / profileRegular   (nso_path_sweep.js) the rod
     NSO_sectionClassLoop / NSO_sectionShow (nso_section.js) naming a face
     NSO_Assemble.rootGap                   (nso_assemble.js) the seat depth
     NSO_Thickness.measureRegion / floorFor (nso_thickness.js) the sheet's
        default and its floor
     NSO_Repair._triTriIntersect            (NSO_Repair.js) every guard that
        asks "does this cross that"
     NSO_unionSoups                         (app-join.js) the boolean, handed
        in by the caller as opts.union - it is async and needs the kernel, and
        this file stays synchronous and node-testable, as nso_assemble.js does

   Every web is straight. A curved bridge is Bend's job afterwards.

   PAINT SCOPE: NOT APPLICABLE here - this file reads soups and returns new
   ones. app-bridge.js, which replaces pieces, carries the paint check and its
   label (docs/HANDOFF.md). */
(function (root) {
  'use strict';

  var DEFAULTS = {
    planarDeg: 0.5,        // a neighbour within this of the seed's normal joins the flat region
    faceCreaseDeg: 20,     // ...and the region is a FACE when every rim edge is at least this sharp
    edgeTolMm: 1.0,        // a click within this of a face's straight rim edge picks the edge
    edgeFrac: 0.25,        // ...capped at this fraction of the face's narrower span
    edgeStraightDeg: 0.5,  // rim edges within this of each other run on as one straight edge
    maxOpposeDeg: 60,      // two faces may be at most this far from facing each other
    diameterMm: 2,         // the string
    sinkMm: 0.5,           // how far a string or sheet end goes under the surface, past the rim gap
    nozzle: 0.4,
    leaveDeg: 80,          // a string must leave each surface at least 10 degrees off it
    flushDeg: 2,           // a face this close to the sheet's plane makes the sheet flush with it
    clearMm: 0.02,         // the "does the web cross a piece" test stays this clear of the welded ends
    probeMm: 50            // the wall probe for the sheet's default
  };

  /* ------------------------------------------------------------- vectors */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function unit(a) { var L = len(a); return L > 0 ? [a[0] / L, a[1] / L, a[2] / L] : null; }
  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
  function deg(r) { return r * 180 / Math.PI; }
  function rad(d) { return d * Math.PI / 180; }
  function clamp1(x) { return x > 1 ? 1 : (x < -1 ? -1 : x); }
  function f1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
  function show(x) { return (typeof NSO_sectionShow === 'function') ? NSO_sectionShow(x) : f1(x); }
  function anyPerp(u) {
    var a = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return unit(cross(u, a));
  }
  function triCount(s) { return (s && s.length) ? (s.length / 9) | 0 : 0; }
  function opt(o, k) { return (o && o[k] != null) ? o[k] : DEFAULTS[k]; }

  function need(name, ok) {
    if (!ok) throw new Error('Bridge needs ' + name + ' loaded - nothing here re-implements it');
  }

  /* ------------------------------------------------------------ topology

     One vertex space per soup, Join's: NSO_fuseVertGrid at NSO_fuseTolerance.
     he: directed half-edge "a>b" -> its code t*3+e. */
  function tolFor(soups) {
    need('nso_planar_fuse.js (NSO_fuseTolerance)', typeof NSO_fuseTolerance === 'function');
    return NSO_fuseTolerance(soups);
  }

  function index(soup, opts) {
    need('nso_planar_fuse.js (NSO_fuseVertGrid)', typeof NSO_fuseVertGrid === 'function');
    var n = triCount(soup);
    var tolInfo = (opts && opts.tolInfo) || tolFor([soup]);
    var grid = NSO_fuseVertGrid(tolInfo.tol);
    var vid = new Int32Array(n * 3), i, exact = new Map();
    // Bit-equal corners first (most of them: a soup repeats each vertex ~6
    // times), so the grid only interns each distinct point once.
    for (i = 0; i < n * 3; i++) {
      var x = soup[i * 3], y = soup[i * 3 + 1], z = soup[i * 3 + 2], k0 = x + ',' + y + ',' + z, id0 = exact.get(k0);
      if (id0 === undefined) { id0 = grid.intern(x, y, z); exact.set(k0, id0); }
      vid[i] = id0;
    }
    var nrm = new Float64Array(n * 3), area = new Float64Array(n), he = new Map(), dupHe = 0;
    for (var t = 0; t < n; t++) {
      var o = t * 9;
      var e1 = [soup[o + 3] - soup[o], soup[o + 4] - soup[o + 1], soup[o + 5] - soup[o + 2]];
      var e2 = [soup[o + 6] - soup[o], soup[o + 7] - soup[o + 1], soup[o + 8] - soup[o + 2]];
      var c = cross(e1, e2), L = len(c);
      area[t] = L / 2;
      if (L > 0) { nrm[t * 3] = c[0] / L; nrm[t * 3 + 1] = c[1] / L; nrm[t * 3 + 2] = c[2] / L; }
      for (var e = 0; e < 3; e++) {
        var a = vid[t * 3 + e], b = vid[t * 3 + (e + 1) % 3];
        if (a === b) continue;
        var k = a + '>' + b;
        if (he.has(k)) dupHe++; else he.set(k, t * 3 + e);
      }
    }
    return { soup: soup, n: n, vid: vid, pts: grid.pts, nrm: nrm, area: area, he: he, dupHe: dupHe,
             tol: tolInfo.tol, tolInfo: tolInfo };
  }

  function P(T, v) { return [T.pts[v * 3], T.pts[v * 3 + 1], T.pts[v * 3 + 2]]; }
  function Nt(T, t) { return [T.nrm[t * 3], T.nrm[t * 3 + 1], T.nrm[t * 3 + 2]]; }
  function triPt(soup, t, k) { var o = t * 9 + k * 3; return [soup[o], soup[o + 1], soup[o + 2]]; }
  function twin(T, t, e) {
    var a = T.vid[t * 3 + e], b = T.vid[t * 3 + (e + 1) % 3];
    var h = T.he.get(b + '>' + a);
    return h == null ? -1 : h;
  }

  /* ----------------------------------------------------- the flat region */
  function flatRegion(T, seed, opts) {
    var n0 = Nt(T, seed);
    var cosTol = Math.cos(rad(opt(opts, 'planarDeg')));
    var p0 = triPt(T.soup, seed, 0);
    var size = T.tolInfo.diag || 1;
    var distTol = Math.max(4 * T.tol, 1e-6 * size, 1e-5);
    var inR = new Uint8Array(T.n), out = [], stack = [seed];
    inR[seed] = 1;
    while (stack.length) {
      var t = stack.pop();
      out.push(t);
      for (var e = 0; e < 3; e++) {
        var h = twin(T, t, e);
        if (h < 0) continue;
        var u = (h / 3) | 0;
        if (inR[u]) continue;
        if (T.area[u] > 0 && dot(Nt(T, u), n0) < cosTol) continue;
        var ok = true;
        for (var k = 0; k < 3 && ok; k++) if (Math.abs(dot(sub(triPt(T.soup, u, k), p0), n0)) > distTol) ok = false;
        if (!ok) continue;
        inR[u] = 1;
        stack.push(u);
      }
    }
    out.sort(function (a, b) { return a - b; });
    return { tris: out, inR: inR, normal: n0 };
  }

  /* The region's rim: its boundary half-edges, chained into loops, each with
     the crease to the triangle across it. Loops run the way the region's own
     triangles do: an outline counter-clockwise about the face's normal, a
     hole clockwise. */
  function rimOf(T, R) {
    var edges = [], byStart = new Map(), minCrease = 180, open = 0, branch = 0;
    for (var i = 0; i < R.tris.length; i++) {
      var t = R.tris[i];
      for (var e = 0; e < 3; e++) {
        var a = T.vid[t * 3 + e], b = T.vid[t * 3 + (e + 1) % 3];
        if (a === b) continue;
        var h = twin(T, t, e);
        if (h >= 0 && R.inR[(h / 3) | 0]) continue;
        var crease = 0;
        if (h < 0) open++;
        else crease = deg(Math.acos(clamp1(dot(R.normal, Nt(T, (h / 3) | 0)))));
        if (crease < minCrease) minCrease = crease;
        var E = { a: a, b: b, t: t, e: e, twin: h, crease: crease, used: false };
        edges.push(E);
        if (byStart.has(a)) branch++; else byStart.set(a, E);
      }
    }
    var loops = [];
    if (!branch) {
      for (var j = 0; j < edges.length; j++) {
        if (edges[j].used) continue;
        var lp = [], cur = edges[j], guard = 0;
        while (cur && !cur.used && guard++ <= edges.length) {
          cur.used = true;
          lp.push(cur);
          cur = byStart.get(cur.b);
        }
        if (!lp.length || lp[lp.length - 1].b !== lp[0].a) { branch++; break; }
        loops.push(lp);
      }
    }
    return { edges: edges, loops: loops, minCrease: edges.length ? minCrease : 0, open: open, branch: branch };
  }

  // Signed area of a 3D loop about n, and its perimeter centroid.
  function loopArea(pts, n) {
    var s = [0, 0, 0];
    for (var i = 0; i < pts.length; i++) s = add(s, cross(pts[i], pts[(i + 1) % pts.length]));
    return dot(s, n) / 2;
  }
  function loopCentroid(pts) {
    var c = [0, 0, 0], L = 0;
    for (var i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length], l = len(sub(b, a));
      c = add(c, mul(add(a, b), l / 2)); L += l;
    }
    return L > 0 ? mul(c, 1 / L) : pts[0].slice();
  }

  // A face's own 2D frame: u along its outline's longest edge.
  function faceFrame(F) {
    var o = F.loops[F.outer].pts, best = -1, u = null;
    for (var i = 0; i < o.length; i++) {
      var d = sub(o[(i + 1) % o.length], o[i]), l = len(d);
      if (l > best) { best = l; u = d; }
    }
    u = unit(sub(u, mul(F.normal, dot(u, F.normal)))) || anyPerp(F.normal);
    return { u: u, v: cross(F.normal, u) };
  }
  function to2(F, fr, p) { var d = sub(p, F.centroid); return [dot(d, fr.u), dot(d, fr.v)]; }

  // What a face's outline is, in words: nso_section.js's fit, on the face's plane.
  function faceShape(F) {
    var fr = faceFrame(F), p2 = F.loops[F.outer].pts.map(function (p) { return to2(F, fr, p); });
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    p2.forEach(function (q) { for (var k = 0; k < 2; k++) { if (q[k] < lo[k]) lo[k] = q[k]; if (q[k] > hi[k]) hi[k] = q[k]; } });
    var span = [hi[0] - lo[0], hi[1] - lo[1]];
    var cls = (typeof NSO_sectionClassLoop === 'function' && p2.length >= 3) ? NSO_sectionClassLoop(p2) : null;
    var holes = F.loops.length - 1;
    var w = Math.max(span[0], span[1]), h = Math.min(span[0], span[1]);
    var txt;
    if (cls && cls.cls === 'round') txt = 'round Ø' + show(2 * cls.circle.r);
    else if (cls && cls.cls === 'rectangular') txt = show(w) + ' × ' + show(h) + ' mm rectangle';
    else txt = show(w) + ' × ' + show(h) + ' mm outline, ' + p2.length + ' points';
    if (holes) txt += ' with ' + (holes === 1 ? 'a hole' : holes + ' holes');
    return { text: txt, span: span, minSpan: h, cls: cls ? cls.cls : null };
  }

  /* ------------------------------------------------------------- picking

     What a click at `point` on triangle `tri` picks, in this order:
       an EDGE  - within edgeTol of a straight rim edge of a face,
       a FACE   - a flat region whose whole rim is creased,
       a POINT  - anything else (a curved surface, a facet of one). */
  function faceAt(T, tri, opts) {
    var R = flatRegion(T, tri, opts);
    var rim = rimOf(T, R);
    var isFace = rim.loops.length > 0 && !rim.open && !rim.branch && rim.minCrease >= opt(opts, 'faceCreaseDeg');
    if (!isFace) return { ok: false, region: R, rim: rim };
    var loops = rim.loops.map(function (lp) {
      var pts = lp.map(function (E) { return P(T, E.a); });
      return { edges: lp, vids: lp.map(function (E) { return E.a; }), pts: pts, area: loopArea(pts, R.normal) };
    });
    var outer = 0;
    for (var i = 1; i < loops.length; i++) if (loops[i].area > loops[outer].area) outer = i;
    if (!(loops[outer].area > 0)) return { ok: false, region: R, rim: rim };
    var c = [0, 0, 0], A = 0;
    R.tris.forEach(function (t) {
      var g = mul(add(add(triPt(T.soup, t, 0), triPt(T.soup, t, 1)), triPt(T.soup, t, 2)), 1 / 3);
      c = add(c, mul(g, T.area[t])); A += T.area[t];
    });
    var F = { ok: true, tris: R.tris, inR: R.inR, normal: R.normal, centroid: A > 0 ? mul(c, 1 / A) : loopCentroid(loops[outer].pts),
              area: A, loops: loops, outer: outer, minCrease: rim.minCrease };
    F.shape = faceShape(F);
    return F;
  }

  function segDist(p, a, b) {
    var d = sub(b, a), L2 = dot(d, d), t = L2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), d) / L2)) : 0;
    return { d: len(sub(p, lerp(a, b, t))), t: t };
  }

  // The straight run of rim edges through loop edge k.
  function straightRun(T, loop, k, opts) {
    var E = loop.edges, n = E.length, cosT = Math.cos(rad(opt(opts, 'edgeStraightDeg')));
    var dir = unit(sub(P(T, E[k].b), P(T, E[k].a)));
    function along(j) { var d = unit(sub(P(T, E[j].b), P(T, E[j].a))); return d && dot(d, dir) >= cosT; }
    var lo = k, hi = k, steps = 0;
    while (steps++ < n - 1 && along((hi + 1) % n)) hi = (hi + 1) % n;
    steps = 0;
    while (steps++ < n - 1 && along((lo - 1 + n) % n) && ((lo - 1 + n) % n) !== hi) lo = (lo - 1 + n) % n;
    var run = [], j = lo;
    for (;;) { run.push(E[j]); if (j === hi) break; j = (j + 1) % n; }
    return run;
  }

  function pick(T, tri, point, opts) {
    if (!(tri >= 0 && tri < T.n)) return { kind: null, reason: 'nothing under the pointer' };
    var F = faceAt(T, tri, opts);
    if (F.ok) {
      var tolE = Math.min(opt(opts, 'edgeTolMm'), opt(opts, 'edgeFrac') * F.shape.minSpan);
      var best = null;
      F.loops.forEach(function (lp, li) {
        lp.edges.forEach(function (E, k) {
          var sd = segDist(point, P(T, E.a), P(T, E.b));
          if (sd.d <= tolE && (!best || sd.d < best.d)) best = { d: sd.d, li: li, k: k };
        });
      });
      if (best) {
        var run = straightRun(T, F.loops[best.li], best.k, opts);
        var a = P(T, run[0].a), b = P(T, run[run.length - 1].b);
        var across = run[0].twin >= 0 ? Nt(T, (run[0].twin / 3) | 0) : null;
        return { kind: 'edge', tri: tri, point: point.slice(), a: a, b: b, lengthMm: len(sub(b, a)),
                 dir: unit(sub(b, a)), face: F, faceNormal: F.normal, acrossNormal: across,
                 acrossTri: run[0].twin >= 0 ? (run[0].twin / 3) | 0 : -1,
                 run: run, text: 'edge ' + show(len(sub(b, a))) + ' mm' };
      }
      return { kind: 'face', tri: tri, point: point.slice(), face: F, normal: F.normal, centroid: F.centroid,
               text: 'face, ' + F.shape.text };
    }
    return { kind: 'point', tri: tri, point: point.slice(), normal: Nt(T, tri), text: 'point' };
  }

  /* ------------------------------------------------------ loop matching */
  function cumLen(pts) {
    var c = [0];
    for (var i = 0; i < pts.length; i++) c.push(c[i] + len(sub(pts[(i + 1) % pts.length], pts[i])));
    return c;
  }
  // The point at parameter t (0..1, wrapping) on a closed loop: segment and fraction.
  function at(pts, cum, t) {
    var L = cum[cum.length - 1], s = ((t % 1) + 1) % 1 * L;
    var lo = 0, hi = pts.length - 1;
    while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid - 1; }
    var segL = cum[lo + 1] - cum[lo], f = segL > 0 ? (s - cum[lo]) / segL : 0;
    return { seg: lo, f: f, p: lerp(pts[lo], pts[(lo + 1) % pts.length], f) };
  }

  /* Match loop A (as it runs) against loop B run backwards, so both go round
     the same way seen down the gap. The shift s that puts B's point at t + s
     nearest A's point at t (each measured from its own centroid) is the
     rotation that does not twist the band. Candidates: every vertex of either
     loop brought onto vertex 0 of the other. */
  function matchLoops(A, B, mergeMm) {
    var PA = A.pts, PB = B.pts.slice().reverse();
    // reversed: PB[k] = B.pts[m-1-k]; rotate so PB[0] = B.pts[0] for readability
    PB.unshift(PB.pop());
    var n = PA.length, m = PB.length;
    var cA = cumLen(PA), cB = cumLen(PB), LA = cA[n], LB = cB[m];
    var gA = loopCentroid(PA), gB = loopCentroid(PB);
    var tA = cA.slice(0, n).map(function (x) { return x / LA; });
    var tB = cB.slice(0, m).map(function (x) { return x / LB; });
    var M = Math.min(256, Math.max(64, 2 * Math.max(n, m)));
    var samplesA = [];
    for (var k = 0; k < M; k++) samplesA.push(sub(at(PA, cA, k / M).p, gA));
    function cost(s) {
      var c = 0;
      for (var k = 0; k < M; k++) {
        var d = sub(samplesA[k], sub(at(PB, cB, k / M + s).p, gB));
        c += dot(d, d);
      }
      return c;
    }
    var best = { s: 0, c: Infinity };
    var cands = [];
    for (var j = 0; j < m; j++) cands.push(tB[j] - tA[0]);
    for (var i = 0; i < n; i++) cands.push(tB[0] - tA[i]);
    cands.forEach(function (s) { s = ((s % 1) + 1) % 1; var c = cost(s); if (c < best.c - 1e-12) best = { s: s, c: c }; });
    var s = best.s;
    // The merged stations: every vertex of A, every vertex of B, at A's parameter.
    var st = [];
    for (i = 0; i < n; i++) st.push({ t: tA[i], ai: i, bj: -1 });
    for (j = 0; j < m; j++) st.push({ t: (((tB[j] - s) % 1) + 1) % 1, ai: -1, bj: j });
    st.sort(function (x, y) { return x.t - y.t; });
    var mergeT = mergeMm / Math.max(LA, LB);
    var merged = [];
    st.forEach(function (x) {
      var last = merged[merged.length - 1];
      if (last && (x.t - last.t) <= mergeT && (last.ai < 0 || x.ai < 0) && (last.bj < 0 || x.bj < 0)) {
        if (x.ai >= 0) { last.ai = x.ai; last.t = x.t; }
        if (x.bj >= 0) last.bj = x.bj;
        return;
      }
      merged.push({ t: x.t, ai: x.ai, bj: x.bj });
    });
    // wrap: the last station within merge reach of the first, across 1.0
    if (merged.length > 1) {
      var first = merged[0], lastS = merged[merged.length - 1];
      if (first.t + 1 - lastS.t <= mergeT && (first.ai < 0 || lastS.ai < 0) && (first.bj < 0 || lastS.bj < 0)) {
        if (lastS.ai >= 0) { first.ai = lastS.ai; first.t = lastS.t - 1; }
        if (lastS.bj >= 0) first.bj = lastS.bj;
        merged.pop();
      }
    }
    // Resolve each station's two points. A point not at a vertex lies on a
    // loop edge: record it so the wall across that edge takes it too.
    var insA = [], insB = [];
    var out = merged.map(function (x) {
      var a, b, ra, rb;
      if (x.ai >= 0) { a = PA[x.ai]; ra = { vertex: x.ai }; }
      else {
        var q = at(PA, cA, x.t);
        a = q.p; ra = { edge: q.seg, u: q.f, p: a };
        insA.push(ra);
      }
      if (x.bj >= 0) { b = PB[x.bj]; rb = { vertex: x.bj }; }
      else {
        var qb = at(PB, cB, x.t + s);
        b = qb.p;
        // PB segment k runs PB[k] -> PB[k+1]; PB[k] = B.pts[(m-k)%m]. That is
        // B's own half-edge (m-k-1)%m, run the other way: u = 1 - f.
        rb = { edge: (m - qb.seg - 1) % m, u: 1 - qb.f, p: b };
        insB.push(rb);
      }
      return { a: a, b: b, ra: ra, rb: rb, t: x.t };
    });
    // Twist: the largest turn between matched spokes, about the gap.
    var axis = unit(sub(gB, gA)) || [0, 0, 1], twist = 0;
    out.forEach(function (x) {
      var da = sub(x.a, gA), db = sub(x.b, gB);
      da = sub(da, mul(axis, dot(da, axis))); db = sub(db, mul(axis, dot(db, axis)));
      var la = len(da), lb = len(db);
      if (la > 1e-9 && lb > 1e-9) {
        var ang = deg(Math.atan2(dot(cross(da, db), axis), dot(da, db)));
        if (Math.abs(ang) > Math.abs(twist)) twist = ang;
      }
    });
    return { stations: out, insA: insA, insB: insB, shift: s, cost: best.c, twistDeg: twist,
             counts: { a: n, b: m, out: out.length } };
  }

  /* --------------------------------------------- guards: does this cross that */
  function boxOf(tri) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var k = 0; k < 3; k++) for (var c = 0; c < 3; c++) {
      var v = tri[k][c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v;
    }
    return { lo: lo, hi: hi };
  }
  /* Pairs between two lists of triangles ({p:[a,b,c], ids:[..]}) that cross:
     NSO_Repair's own test, box-pruned by sweep along X. `same` = one list
     against itself. Pairs sharing a vertex are the welds and are skipped. */
  function crossings(L1, L2, same, maxReport) {
    need('NSO_Repair.js (_triTriIntersect)', typeof NSO_Repair !== 'undefined' && NSO_Repair && NSO_Repair._triTriIntersect);
    var tt = NSO_Repair._triTriIntersect, EPS = 1e-9;
    var all = [];
    L1.forEach(function (x, i) { x.box = x.box || boxOf(x.p); all.push({ x: x, s: 0, i: i }); });
    if (!same) L2.forEach(function (x, i) { x.box = x.box || boxOf(x.p); all.push({ x: x, s: 1, i: i }); });
    all.sort(function (p, q) { return p.x.box.lo[0] - q.x.box.lo[0]; });
    var active = [], hits = 0, kinds = {}, first = null;
    for (var i = 0; i < all.length; i++) {
      var A = all[i], keep = [];
      for (var j = 0; j < active.length; j++) {
        var B = active[j];
        if (B.x.box.hi[0] < A.x.box.lo[0] - EPS) continue;
        keep.push(B);
        if (!same && A.s === B.s) continue;
        var ba = A.x.box, bb = B.x.box;
        if (ba.hi[1] < bb.lo[1] - EPS || ba.lo[1] > bb.hi[1] + EPS || ba.hi[2] < bb.lo[2] - EPS || ba.lo[2] > bb.hi[2] + EPS) continue;
        var share = false;
        for (var a = 0; a < 3 && !share; a++) for (var b = 0; b < 3; b++) if (A.x.ids[a] === B.x.ids[b]) { share = true; break; }
        if (share) continue;
        var k = tt(A.x.p[0], A.x.p[1], A.x.p[2], B.x.p[0], B.x.p[1], B.x.p[2]);
        if (k) {
          hits++; kinds[k] = (kinds[k] || 0) + 1;
          if (!first) first = [A.x, B.x];
          if (maxReport && hits >= maxReport) return { pairs: hits, kinds: kinds, first: first };
        }
      }
      keep.push(A);
      active = keep;
    }
    return { pairs: hits, kinds: kinds, first: first };
  }

  function trisOfSoup(soup, idsBase, filter) {
    var out = [], n = triCount(soup);
    for (var t = 0; t < n; t++) {
      if (filter && !filter(t)) continue;
      out.push({ p: [triPt(soup, t, 0), triPt(soup, t, 1), triPt(soup, t, 2)], ids: [idsBase + 't' + t + 'a', idsBase + 't' + t + 'b', idsBase + 't' + t + 'c'], t: t });
    }
    return out;
  }
  // Only the triangles of `soup` whose box meets `box` (grown by g).
  function trisNear(soup, box, g, tag) {
    var out = [], n = triCount(soup);
    for (var t = 0; t < n; t++) {
      var o = t * 9, ok = true;
      for (var c = 0; c < 3 && ok; c++) {
        var lo = Math.min(soup[o + c], soup[o + 3 + c], soup[o + 6 + c]), hi = Math.max(soup[o + c], soup[o + 3 + c], soup[o + 6 + c]);
        if (hi < box.lo[c] - g || lo > box.hi[c] + g) ok = false;
      }
      if (ok) out.push({ p: [triPt(soup, t, 0), triPt(soup, t, 1), triPt(soup, t, 2)], ids: [tag + t + 'a', tag + t + 'b', tag + t + 'c'], t: t });
    }
    return out;
  }
  function soupBox(soup) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < soup.length; i += 3) for (var c = 0; c < 3; c++) {
      var v = soup[i + c]; if (v < lo[c]) lo[c] = v; if (v > hi[c]) hi[c] = v;
    }
    return { lo: lo, hi: hi };
  }

  /* --------------------------------------------------------------- BAND */
  function planBand(pieces, A, B, opts) {
    var FA = A.target.face, FB = B.target.face;
    var nA = FA.normal, nB = FB.normal;
    if (A.piece === B.piece && FA.tris[0] === FB.tris[0]) return refuse('band', 'both ends are the same face - click one face, then another');
    var oppose = deg(Math.acos(clamp1(-dot(nA, nB))));
    if (oppose > opt(opts, 'maxOpposeDeg') + 1e-9) {
      return refuse('band', 'the two faces are ' + f1(oppose) + '° from facing each other - a band takes faces no more than ' +
        opt(opts, 'maxOpposeDeg') + '° from straight on; turn one piece to face the other');
    }
    var gap = sub(FB.centroid, FA.centroid);
    if (!(dot(gap, nA) > 0) || !(dot(gap, nB) < 0)) {
      var which = !(dot(gap, nA) > 0) ? 'the first face' : 'the second face';
      return refuse('band', 'the faces face away from each other - ' + which + ' looks away from the other, so a band from it would run back through its own piece');
    }
    if (FA.loops.length !== FB.loops.length) {
      return refuse('band', 'the faces are different shapes - one has ' + FA.loops.length + ' outline(s), the other ' + FB.loops.length +
        '; a band joins outline to outline and hole to hole');
    }
    // Pair loops: outline with outline, each hole with the nearest hole (by
    // its offset from its own face's centroid).
    var pairs = [[FA.outer, FB.outer]];
    var holesA = [], holesB = [];
    FA.loops.forEach(function (l, i) { if (i !== FA.outer) holesA.push(i); });
    FB.loops.forEach(function (l, i) { if (i !== FB.outer) holesB.push(i); });
    var usedB = {};
    holesA.forEach(function (ia) {
      var ga = sub(loopCentroid(FA.loops[ia].pts), FA.centroid), bi = -1, bd = Infinity;
      holesB.forEach(function (ib) {
        if (usedB[ib]) return;
        var d = len(sub(ga, sub(loopCentroid(FB.loops[ib].pts), FB.centroid)));
        if (d < bd) { bd = d; bi = ib; }
      });
      usedB[bi] = 1;
      pairs.push([ia, bi]);
    });
    var tolInfo = tolFor(A.piece === B.piece ? [pieces[A.piece]] : [pieces[A.piece], pieces[B.piece]]);
    var mergeMm = Math.max(1e-4, 10 * tolInfo.tol);
    var matches = pairs.map(function (pr) { return matchLoops(FA.loops[pr[0]], FB.loops[pr[1]], mergeMm); });

    // The band, triangle by triangle, on the stations' own numbers.
    var band = [], twist = 0;
    matches.forEach(function (M) {
      var S = M.stations, n = S.length;
      if (Math.abs(M.twistDeg) > Math.abs(twist)) twist = M.twistDeg;
      for (var k = 0; k < n; k++) {
        var s0 = S[k], s1 = S[(k + 1) % n];
        var d1 = len(sub(s0.a, s1.b)), d2 = len(sub(s1.a, s0.b));
        if (d1 <= d2) { band.push([s0.a, s1.a, s1.b]); band.push([s0.a, s1.b, s0.b]); }
        else { band.push([s0.a, s1.a, s0.b]); band.push([s1.a, s1.b, s0.b]); }
      }
    });
    var web = new Float32Array(band.length * 9);
    band.forEach(function (t, i) { for (var k = 0; k < 3; k++) for (var c = 0; c < 3; c++) web[i * 9 + k * 3 + c] = t[k][c]; });

    var lengthMm = len(gap);
    var plan = { ok: true, kind: 'band', web: web, A: A, B: B, matches: matches, pairs: pairs, tolInfo: tolInfo,
                 opposeDeg: oppose, twistDeg: twist, lengthMm: lengthMm, pieces: pieces };

    // The weld is built now: the guards read it, and Set commits this very soup.
    var res = weldBand(plan);
    plan.result = res;
    var bandStart = triCount(res.soup) - triCount(web);
    var near = bandLists(res.soup, bandStart, tolInfo.tol);
    // Guard: the loft crossing itself.
    if (crossings(near.band, null, true, 1).pairs) {
      return refuse('band', 'the band between these faces would cross itself - the outlines are too different to loft straight across (' +
        FA.shape.text + ' to ' + FB.shape.text + ')');
    }
    // Guard: the band through either piece.
    if (near.rest.length) {
      var c = crossings(near.band, near.rest, false, 1);
      if (c.pairs) {
        var pc = c.first[1].band ? c.first[0] : c.first[1];
        var who = A.piece === B.piece ? 'the piece' : (pc.t < res.counts[0] ? 'the first piece' : 'the second piece');
        return refuse('band', 'the band would pass through ' + who + ' - something stands between the two faces');
      }
    }
    plan.text = 'band ' + show(lengthMm) + ' mm, ' + FA.shape.text + (FA.shape.text === FB.shape.text ? ' both ends' : ' to ' + FB.shape.text) +
      (oppose > 0.05 ? ', ' + f1(oppose) + '° off square' : '') + ' · ' + matches.map(function (M) { return M.counts.a + '/' + M.counts.b + ' → ' + M.counts.out; }).join(', ') + ' points';
    return plan;
  }

  /* The welded soup as two lists for the guards: the band, and every other
     triangle near it, all on one vertex grid - so a weld (a shared vertex) is
     never read as a crossing. */
  function bandLists(soup, bandStart, tol) {
    var grid = NSO_fuseVertGrid(tol), band = [], rest = [];
    var n = triCount(soup), t;
    for (t = bandStart; t < n; t++) {
      var p = [triPt(soup, t, 0), triPt(soup, t, 1), triPt(soup, t, 2)];
      band.push({ p: p, ids: p.map(function (q) { return grid.intern(q[0], q[1], q[2]); }), t: t, band: true });
    }
    var bb = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
    band.forEach(function (x) { for (var k = 0; k < 3; k++) for (var c = 0; c < 3; c++) { var v = x.p[k][c]; if (v < bb.lo[c]) bb.lo[c] = v; if (v > bb.hi[c]) bb.hi[c] = v; } });
    var g = 4 * tol;
    for (t = 0; t < bandStart; t++) {
      var o = t * 9, ok = true;
      for (var c2 = 0; c2 < 3 && ok; c2++) {
        var lo = Math.min(soup[o + c2], soup[o + 3 + c2], soup[o + 6 + c2]), hi = Math.max(soup[o + c2], soup[o + 3 + c2], soup[o + 6 + c2]);
        if (hi < bb.lo[c2] - g || lo > bb.hi[c2] + g) ok = false;
      }
      if (!ok) continue;
      var q3 = [triPt(soup, t, 0), triPt(soup, t, 1), triPt(soup, t, 2)];
      rest.push({ p: q3, ids: q3.map(function (q) { return grid.intern(q[0], q[1], q[2]); }), t: t });
    }
    return { band: band, rest: rest };
  }

  /* Build the welded soup: both pieces less their caps, the walls round the
     loops split where the band brought new points, and the band. */
  function weldBand(plan) {
    var pieces = plan.pieces, A = plan.A, B = plan.B;
    var drop = {}, ins = {};   // per piece: cap triangles; per piece: wall tri -> [{edge, list}]
    function addCaps(end) { var d = drop[end.piece] || (drop[end.piece] = {}); end.target.face.tris.forEach(function (t) { d[t] = 1; }); }
    addCaps(A); addCaps(B);
    function addIns(end, loopIdx, list) {
      var F = end.target.face, lp = F.loops[loopIdx];
      var I = ins[end.piece] || (ins[end.piece] = {});
      list.forEach(function (r) {
        var E = lp.edges[r.edge];
        if (E.twin < 0) return;
        var wt = (E.twin / 3) | 0, we = E.twin % 3;
        // the wall runs this edge b -> a: along its own edge, the point sits at 1 - u
        var W = I[wt] || (I[wt] = [[], [], []]);
        W[we].push({ u: 1 - r.u, p: r.p });
      });
    }
    plan.matches.forEach(function (M, i) {
      addIns(A, plan.pairs[i][0], M.insA);
      addIns(B, plan.pairs[i][1], M.insB);
    });
    /* The seam: every loop vertex on one canonical value, the first piece's
       winning - NSO_planarFusePair's weld, so the result is closed by bit
       equality and not merely by rounding. */
    var seam = NSO_fuseVertGrid(plan.tolInfo.tol), canon = [];
    [A, B].forEach(function (end) {
      end.target.face.loops.forEach(function (lp) {
        lp.pts.forEach(function (q) { if (seam.find(q[0], q[1], q[2]) < 0) canon[seam.intern(q[0], q[1], q[2])] = q; });
      });
    });
    var out = [], split = 0, snapped = 0, counts = [];
    function push(p) {
      var id = seam.find(p[0], p[1], p[2]);
      if (id >= 0) { var c = canon[id]; if (c[0] !== p[0] || c[1] !== p[1] || c[2] !== p[2]) snapped++; p = c; }
      out.push(p[0], p[1], p[2]);
    }
    var done = {};
    [A.piece, B.piece].forEach(function (pi) {
      if (done[pi]) return;
      done[pi] = 1;
      var soup = pieces[pi], d = drop[pi] || {}, I = ins[pi] || {};
      for (var t = 0; t < triCount(soup); t++) {
        if (d[t]) continue;
        var V = [triPt(soup, t, 0), triPt(soup, t, 1), triPt(soup, t, 2)];
        var W = I[t];
        if (!W) { push(V[0]); push(V[1]); push(V[2]); continue; }
        split++;
        var poly = [], edgesWith = 0, which = -1;
        for (var e = 0; e < 3; e++) {
          poly.push(V[e]);
          var L = W[e].slice().sort(function (x, y) { return x.u - y.u; });
          if (L.length) { edgesWith++; which = e; }
          L.forEach(function (x) { poly.push(x.p); });
        }
        if (edgesWith === 1) {
          // fan from the corner opposite the split edge
          var apex = (which + 2) % 3, start = poly.indexOf(V[apex]);
          var ring = poly.slice(start).concat(poly.slice(0, start));
          for (var k = 1; k < ring.length - 1; k++) { push(ring[0]); push(ring[k]); push(ring[k + 1]); }
        } else {
          var g = mul(add(add(V[0], V[1]), V[2]), 1 / 3);
          for (var k2 = 0; k2 < poly.length; k2++) { push(g); push(poly[k2]); push(poly[(k2 + 1) % poly.length]); }
        }
      }
      counts.push(out.length / 9);
    });
    for (var i = 0; i < plan.web.length; i += 3) push([plan.web[i], plan.web[i + 1], plan.web[i + 2]]);
    var soupOut = new Float32Array(out);
    return { ok: true, soup: soupOut, split: split, snapped: snapped, counts: counts };
  }

  /* --------------------------------------------------------------- STRING */
  function planString(pieces, A, B, opts) {
    var d = +opt(opts, 'diameterMm'), r = d / 2, sink = +opt(opts, 'sinkMm');
    if (!(d > 0)) return refuse('string', 'the string needs a diameter above 0 mm');
    var pA = A.target.point, pB = B.target.point, L = len(sub(pB, pA));
    if (L < d) {
      return refuse('string', 'the string would be ' + show(L) + ' mm long, shorter than its own Ø' + show(d) +
        ' - pick two points further apart, or a thinner string');
    }
    var u = mul(sub(pB, pA), 1 / L);
    var nA = A.target.normal, nB = B.target.normal;
    var leave = Math.cos(rad(opt(opts, 'leaveDeg')));
    var cA = dot(u, nA), cB = -dot(u, nB);
    if (!(cA > leave) || !(cB > leave)) {
      var w = !(cA > leave) ? 'first' : 'second';
      return refuse('string', 'the string would pass through the ' + w + ' piece - from that point the line to the other one runs ' +
        (((w === 'first' ? cA : cB) <= 0) ? 'into the piece' : 'along its surface') + ', not away from it');
    }
    var n = Math.max(16, Math.min(96, Math.ceil(Math.PI / Math.acos(1 - Math.min(0.01, r * 0.5) / r))));
    if (n % 2) n++;
    var e1 = anyPerp(u), e2 = cross(u, e1);
    function rim(p) {
      var out = [];
      for (var i = 0; i < n; i++) { var a = 2 * Math.PI * i / n; out.push(add(p, add(mul(e1, r * Math.cos(a)), mul(e2, r * Math.sin(a))))); }
      return out;
    }
    need('nso_assemble.js (NSO_Assemble.rootGap)', typeof NSO_Assemble !== 'undefined' && NSO_Assemble && NSO_Assemble.rootGap);
    var gA = NSO_Assemble.rootGap(pieces[A.piece], rim(pA), opts && opts.aim ? { aim: opts.aim } : {});
    var gB = NSO_Assemble.rootGap(pieces[B.piece], rim(pB), opts && opts.aim ? { aim: opts.aim } : {});
    if (!gA.ok || !gB.ok) return refuse('string', (gA.ok ? gB : gA).reason);
    var engA = gA.gapMm + sink, engB = gB.gapMm + sink;
    need('nso_path_sweep.js (NSO_PathSweep.sweep)', typeof NSO_PathSweep !== 'undefined' && NSO_PathSweep && NSO_PathSweep.sweep);
    var S = NSO_PathSweep;
    var rod = S.sweep({ points: [sub(pA, mul(u, engA)), add(pB, mul(u, engB))], profile: S.profileRegular(n, r), up: e1 });
    if (!rod.ok) return refuse('string', rod.reason);
    var plan = { ok: true, kind: 'string', web: outward(rod.tris), A: A, B: B, pieces: pieces, diameterMm: d, segments: n,
                 lengthMm: L, engageMm: [engA, engB], rimGapMm: [gA.gapMm, gB.gapMm], axis: u };
    // Guard: the exposed rod through either piece. It stays clear of each
    // end by the rim gap plus how far its side runs on past the point when
    // it leaves the surface at an angle.
    var clr = opt(opts, 'clearMm');
    var offA = gA.gapMm + r * Math.tan(Math.acos(clamp1(cA))) + clr, offB = gB.gapMm + r * Math.tan(Math.acos(clamp1(cB))) + clr;
    if (offA + offB < L) {
      var chk = S.sweep({ points: [add(pA, mul(u, offA)), sub(pB, mul(u, offB))], profile: S.profileRegular(n, r * 0.999), up: e1 });
      if (chk.ok) {
        var hit = webThroughPieces(plan, chk.tris);
        if (hit) return refuse('string', 'the string would pass through ' + hit + ' - something stands between the two points');
      }
    }
    plan.text = 'string Ø' + show(d) + ', ' + show(L) + ' mm between the points, each end sunk ' + show(engA) + ' / ' + show(engB) + ' mm';
    return plan;
  }

  function webThroughPieces(plan, chkSoup) {
    var box = soupBox(chkSoup), wl = trisOfSoup(chkSoup, 'w');
    var seen = {}, list = [];
    [plan.A, plan.B].forEach(function (end) {
      if (seen[end.piece]) return;
      seen[end.piece] = 1;
      trisNear(plan.pieces[end.piece], box, 1e-6, 'p' + end.piece + '_').forEach(function (x) { x.piece = end.piece; list.push(x); });
    });
    if (!list.length) return null;
    var c = crossings(wl, list, false, 1);
    if (!c.pairs) return null;
    var pc = c.first[1].piece != null ? c.first[1] : c.first[0];
    return plan.A.piece === plan.B.piece ? 'the piece' : (pc.piece === plan.A.piece ? 'the first piece' : 'the second piece');
  }

  /* ---------------------------------------------------------------- SHEET */
  function wallAt(soup, end, opts) {
    if (typeof NSO_Thickness === 'undefined' || !NSO_Thickness || !NSO_Thickness.measureRegion) return null;
    var faces = end.target.face.tris.slice();
    if (end.target.acrossTri >= 0) faces.push(end.target.acrossTri);
    var rep = NSO_Thickness.measureRegion(soup, faces, { probe: opt(opts, 'probeMm'), nozzle: opt(opts, 'nozzle') });
    return rep && rep.min_mm != null ? rep.min_mm : null;
  }
  function sheetDefault(pieces, A, B, opts) {
    var walls = [wallAt(pieces[A.piece], A, opts), wallAt(pieces[B.piece], B, opts)].filter(function (x) { return x != null; });
    var floor = 2 * opt(opts, 'nozzle');
    var w = walls.length ? Math.min.apply(null, walls) : floor;
    return { mm: Math.max(floor, Math.round(w * 100) / 100), wallMm: walls.length ? Math.min.apply(null, walls) : null, floorMm: floor };
  }

  /* A closed web (the sheet's slab, the string's rod) must have its triangles
     wound outward whichever way its edges or points were clicked: if the signed
     volume came out negative the whole soup is inside-out, so flip every triangle. */
  function outward(soup) {
    var vol = 0, o, t, n = soup.length;
    for (o = 0; o + 8 < n; o += 9) {
      vol += dot([soup[o], soup[o + 1], soup[o + 2]], cross([soup[o + 3], soup[o + 4], soup[o + 5]], [soup[o + 6], soup[o + 7], soup[o + 8]]));
    }
    if (vol < 0) for (o = 0; o + 8 < n; o += 9) for (t = 0; t < 3; t++) {
      var a = o + 3 + t, b = o + 6 + t, tmp = soup[a]; soup[a] = soup[b]; soup[b] = tmp;
    }
    return soup;
  }

  function hexa(c) {
    // c: 8 corners, 0-3 bottom ring, 4-7 top ring above them
    var F = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    var out = new Float32Array(F.length * 9), v = 0;
    F.forEach(function (f) { f.forEach(function (i) { out[v++] = c[i][0]; out[v++] = c[i][1]; out[v++] = c[i][2]; }); });
    return outward(out);
  }

  function planSheet(pieces, A, B, opts) {
    var a0 = A.target.a, a1 = A.target.b, b0 = B.target.a, b1 = B.target.b;
    if (A.piece === B.piece && len(sub(a0, b0)) + len(sub(a1, b1)) < 1e-9) return refuse('sheet', 'both ends are the same edge - click one edge, then another');
    if (len(sub(a0, b0)) + len(sub(a1, b1)) > len(sub(a0, b1)) + len(sub(a1, b0))) { var tmp = b0; b0 = b1; b1 = tmp; }
    var Q = [a0, a1, b1, b0];
    var nsum = [0, 0, 0];
    for (var i = 0; i < 4; i++) nsum = add(nsum, cross(Q[i], Q[(i + 1) % 4]));
    var m = unit(nsum);
    if (!m || len(nsum) < 1e-9) return refuse('sheet', 'the two edges lie on one line - there is no flat sheet between them');
    var g = mul(add(add(a0, a1), add(b0, b1)), 0.25), dev = 0, devAt = 0;
    Q.forEach(function (q, k) { var dd = Math.abs(dot(sub(q, g), m)); if (dd > dev) { dev = dd; devAt = k; } });
    var lenA = len(sub(a1, a0)), lenB = len(sub(b1, b0));
    var planTol = Math.max(0.05, 0.01 * Math.min(lenA, lenB));
    if (dev > planTol) {
      return refuse('sheet', 'the two edges are not in one plane (' + show(2 * dev) + ' mm out of it) - a flat sheet cannot meet both; turn one piece, or pick edges that lie in one plane');
    }
    for (i = 0; i < 4; i++) {
      var z = dot(cross(sub(Q[(i + 1) % 4], Q[i]), sub(Q[(i + 2) % 4], Q[(i + 1) % 4])), m);
      if (!(z > 0)) return refuse('sheet', 'the sheet between these edges would fold over itself - pick edges that face each other');
    }
    var dirA = unit(sub(a1, a0)), dirB = unit(sub(b1, b0));
    var midA = lerp(a0, a1, 0.5), midB = lerp(b0, b1, 0.5);
    function outward(dir, mine, other) {
      var w = unit(cross(m, dir));
      return dot(w, sub(other, mine)) > 0 ? mul(w, -1) : w;
    }
    var wA = outward(dirA, midA, midB), wB = outward(dirB, midB, midA);
    var gapMm = Math.min(Math.abs(dot(sub(b0, a0), wA)), Math.abs(dot(sub(b1, a1), wA)));
    // Each edge's faces must face the gap: the face on the piece's side of
    // the edge has to be the solid side.
    var def = sheetDefault(pieces, A, B, opts);
    var t = (opts && opts.thicknessMm != null && opts.thicknessMm !== '') ? +opts.thicknessMm : def.mm;
    if (!(t > 0)) return refuse('sheet', 'the sheet needs a thickness above 0 mm');
    if (t < def.floorMm - 1e-9) return refuse('sheet', 'a ' + show(t) + ' mm sheet is under two nozzle widths (' + show(def.floorMm) + ' mm) - the slicer would not print it as a wall');
    // Flush: an edge face lying in the sheet's plane fixes which side the sheet goes.
    var cosF = Math.cos(rad(opt(opts, 'flushDeg')));
    function flushSign(end) {
      var ns = [end.target.faceNormal, end.target.acrossNormal].filter(Boolean);
      for (var k = 0; k < ns.length; k++) { var dd = dot(ns[k], m); if (Math.abs(dd) >= cosF) return dd > 0 ? 1 : -1; }
      return 0;
    }
    var sA = flushSign(A), sB = flushSign(B);
    var hi, lo, mode;
    if (sA && sA === sB) { hi = sA > 0 ? 0 : t; lo = sA > 0 ? -t : 0; mode = 'flush'; }
    else if (sA && !sB) { hi = sA > 0 ? 0 : t; lo = sA > 0 ? -t : 0; mode = 'flush'; }
    else if (sB && !sA) { hi = sB > 0 ? 0 : t; lo = sB > 0 ? -t : 0; mode = 'flush'; }
    else { hi = t / 2; lo = -t / 2; mode = 'centred'; }
    var sink = +opt(opts, 'sinkMm');
    function slab(ea0, ea1, eb1, eb0, sa, sb) {
      var ring = [add(ea0, mul(wA, sa)), add(ea1, mul(wA, sa)), add(eb1, mul(wB, sb)), add(eb0, mul(wB, sb))];
      return hexa(ring.map(function (q) { return add(q, mul(m, lo)); }).concat(ring.map(function (q) { return add(q, mul(m, hi)); })));
    }
    var web = slab(a0, a1, b1, b0, sink, sink);
    var plan = { ok: true, kind: 'sheet', web: web, A: A, B: B, pieces: pieces, thicknessMm: t, defaultMm: def.mm, wallMm: def.wallMm,
                 mode: mode, normal: m, gapMm: gapMm, lengthMm: [lenA, lenB], planeDevMm: dev };
    var clr = opt(opts, 'clearMm');
    var chk = slab(a0, a1, b1, b0, -clr, -clr);
    // shrink the check slab off the edges' ends too
    var hit = webThroughPieces(plan, shrinkAlong(chk, dirA, clr));
    if (hit) return refuse('sheet', 'the sheet would pass through ' + hit + ' - something stands between the two edges');
    plan.text = 'sheet ' + show(t) + ' mm thick' + (mode === 'flush' ? ', flush with the faces' : ', centred on the edges') + ', ' +
      show(Math.max(lenA, lenB)) + ' mm long, spanning ' + show(gapMm) + ' mm';
    return plan;
  }
  // Pull every point of a soup in by d from its extent along dir (both ends).
  function shrinkAlong(soup, dir, d) {
    var lo = Infinity, hi = -Infinity, i;
    for (i = 0; i < soup.length; i += 3) { var s = soup[i] * dir[0] + soup[i + 1] * dir[1] + soup[i + 2] * dir[2]; if (s < lo) lo = s; if (s > hi) hi = s; }
    var out = new Float32Array(soup.length);
    for (i = 0; i < soup.length; i += 3) {
      var p = [soup[i], soup[i + 1], soup[i + 2]], s2 = dot(p, dir);
      var q = s2 - lo < d ? add(p, mul(dir, d - (s2 - lo))) : (hi - s2 < d ? sub(p, mul(dir, d - (hi - s2))) : p);
      out[i] = q[0]; out[i + 1] = q[1]; out[i + 2] = q[2];
    }
    return out;
  }

  /* ----------------------------------------------------------------- plan */
  function refuse(kind, reason) { return { ok: false, kind: kind, reason: reason }; }

  /* pieces: [soup, ...] (world, Z up). a, b: { piece, target } where target
     came from pick() on that piece's index. A face end paired with a point
     end is a string: the face end gives up the point it was pressed at. */
  function plan(pieces, a, b, opts) {
    if (!a || !b || !a.target || !b.target || !a.target.kind || !b.target.kind) return refuse(null, 'pick two places on the pieces');
    var ka = a.target.kind, kb = b.target.kind;
    if (ka === 'face' && kb === 'face') return planBand(pieces, a, b, opts);
    if (ka === 'edge' && kb === 'edge') return planSheet(pieces, a, b, opts);
    if (ka === 'edge' || kb === 'edge') {
      return refuse(null, 'one end is an edge and the other a ' + (ka === 'edge' ? kb : ka) +
        ' - a sheet runs edge to edge; click an edge, then another edge, or pick between faces or points');
    }
    function asPoint(e) {
      if (e.target.kind === 'point') return e;
      return { piece: e.piece, target: { kind: 'point', tri: e.target.tri, point: e.target.point, normal: e.target.normal } };
    }
    return planString(pieces, asPoint(a), asPoint(b), opts);
  }

  /* --------------------------------------------------------------- weld

     The band welds itself. A string or sheet is unioned, with the boolean
     the caller hands in (opts.union, NSO_unionSoups' contract): first piece
     with the web, then that with the second piece. Each step must merge -
     the kernel's own component count drops - or nothing is changed. */
  function weld(p, opts) {
    if (!p || !p.ok) return Promise.resolve(p || refuse(null, 'nothing planned'));
    if (p.kind === 'band') {
      var r = p.result || weldBand(p);
      return Promise.resolve(finish(p, r.soup, topology(r.soup, p.tolInfo), null, { split: r.split, snapped: r.snapped }));
    }
    var union = opts && opts.union;
    if (typeof union !== 'function') return Promise.resolve(refuse(p.kind, 'no boolean kernel to weld with'));
    var sA = p.pieces[p.A.piece], sB = p.pieces[p.B.piece];
    return union(sA, p.web).then(function (u1) {
      if (!u1 || !u1.ok) return refuse(p.kind, 'the ' + p.kind + ' would not weld to the first piece (' + ((u1 && u1.reason) || 'union failed') + ')');
      if (p.A.piece === p.B.piece) return finish(p, u1.soup, null, u1.stats, { steps: 1 });
      return union(u1.soup, sB).then(function (u2) {
        if (!u2 || !u2.ok) return refuse(p.kind, 'the ' + p.kind + ' would not weld to the second piece (' + ((u2 && u2.reason) || 'union failed') + ')');
        return finish(p, u2.soup, null, u2.stats, { steps: 2, parts: u2.parts, partsA: u2.partsA, partsB: u2.partsB });
      });
    });
  }

  function finish(p, soup, topo, kernelStats, extra) {
    topo = topo || topology(soup, tolFor([soup]));
    var sealedIn = true;
    var seen = {};
    [p.A.piece, p.B.piece].forEach(function (pi) {
      if (seen[pi]) return; seen[pi] = 1;
      var t = topology(p.pieces[pi], tolFor([p.pieces[pi]]));
      if (t.open || t.nm) sealedIn = false;
    });
    var open = kernelStats ? kernelStats.open : topo.open, nm = kernelStats ? kernelStats.nm : topo.nm;
    if (sealedIn && (open || nm || topo.badWinding)) {
      return refuse(p.kind, 'the welded piece would not be closed (' + open + ' open edge(s), ' + nm + ' non-manifold, ' +
        topo.badWinding + ' wound the wrong way) - nothing changed');
    }
    var out = { ok: true, kind: p.kind, soup: soup, topo: topo, kernel: kernelStats, plan: p, text: p.text };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
    return out;
  }

  /* Closed / manifold / wound / how many shells, welded on Join's grid. */
  function topology(soup, tolInfo) {
    var tol = (tolInfo && tolInfo.tol) || tolFor([soup]).tol;
    var grid = NSO_fuseVertGrid(tol), n = triCount(soup), vid = new Int32Array(n * 3), exact = new Map();
    for (var i = 0; i < n * 3; i++) {
      var x = soup[i * 3], y = soup[i * 3 + 1], z = soup[i * 3 + 2], k0 = x + ',' + y + ',' + z, id0 = exact.get(k0);
      if (id0 === undefined) { id0 = grid.intern(x, y, z); exact.set(k0, id0); }
      vid[i] = id0;
    }
    var und = new Map(), dir = new Map(), degenerate = 0;
    var parent = new Int32Array(n);
    for (i = 0; i < n; i++) parent[i] = i;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    for (var t = 0; t < n; t++) {
      var v = [vid[t * 3], vid[t * 3 + 1], vid[t * 3 + 2]];
      if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) { degenerate++; continue; }
      for (var e = 0; e < 3; e++) {
        var a = v[e], b = v[(e + 1) % 3], k = a < b ? a + '_' + b : b + '_' + a;
        var L = und.get(k);
        if (!L) { L = []; und.set(k, L); }
        L.push(t);
        var dk = a + '>' + b;
        dir.set(dk, (dir.get(dk) || 0) + 1);
      }
    }
    var open = 0, nm = 0, bad = 0;
    und.forEach(function (L) {
      if (L.length === 1) open++;
      else if (L.length > 2) nm++;
      for (var j = 1; j < L.length; j++) { var ra = find(L[0]), rb = find(L[j]); if (ra !== rb) parent[ra] = rb; }
    });
    dir.forEach(function (c) { if (c > 1) bad++; });
    var roots = {}, shells = 0;
    for (t = 0; t < n; t++) {
      var tv = [vid[t * 3], vid[t * 3 + 1], vid[t * 3 + 2]];
      if (tv[0] === tv[1] || tv[1] === tv[2] || tv[0] === tv[2]) continue;
      var r = find(t); if (!roots[r]) { roots[r] = 1; shells++; }
    }
    var V = grid.pts.length / 3;
    return { tris: n, verts: V, edges: und.size, open: open, nm: nm, badWinding: bad, degenerate: degenerate, shells: shells,
             euler: V - und.size + (n - degenerate) };
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

  var API = {
    DEFAULTS: DEFAULTS,
    index: index,
    pick: pick,
    faceAt: faceAt,
    plan: plan,
    weld: weld,
    weldBand: weldBand,
    sheetDefault: sheetDefault,
    topology: topology,
    volume: volume,
    outward: outward,
    matchLoops: matchLoops
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Bridge = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
