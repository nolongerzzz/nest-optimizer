/* ============================================================
   nso_sketch.js - a drawing: freehand lines and fills, in millimetres,
   made into solids that stand out of a face. docs/DRAW.md.
   Headless: no DOM, no THREE, no app state. The page loads it as
   window.NSO_Sketch and node requires it (tools/nso_sketch_test.js).
   The editor that draws one is app-draw-editor.js (DRAW > Draw editor);
   the stage that puts one on a piece is app-draw-connect.js.

   A SKETCH is { height, objects: [OBJECT] }, an OBJECT is
     { id, name, kind: 'line' | 'fill', pts: [[x, y], ...], closed, width, height }
   x right, y up, mm. `height` on an object overrides the sketch's.

     line   the stroke given a width: an open line has round ends, a closed
            one (a rectangle drawn as a line, a stroke that comes back to its
            start and is closed) is a ring of that width.
     fill   the area the stroke goes round, closed from its last point to its
            first.

   OUTLINES. A line's outline is its two sides, each the stroke moved out by
   half the width, joined round its outside corners by an arc and, inside a
   corner, cut where the two moved segments cross (the little loop the inside
   of a turn throws is taken out). Round ends close it. A line that crosses
   itself cannot be one outline: it is cut into runs that each do not, the
   runs overlapping a little, and the caller unions them (`parts`).

   SOLIDS. Each outline (a fill's, or a line's, holes included) is triangulated
   (NSO_CDT, constrained, holes by even-odd) and stood up from z0 to z1 -
   bottom, top and a wall round every loop. Every loop edge is cut to at most
   MAX_EDGE first: a long thin triangle is what a boolean cuts into slivers
   (docs/CONNECT.md, "Wall triangles are cut every 2 mm"). Closed and
   outward-wound by construction; checked by signed volume.
   ============================================================ */
(function (root) {
  'use strict';

  var MAX_EDGE = 2;          // mm, longest outline edge handed to the triangulation
  var ARC_DEG = 15;          // a round join or end, a corner every this many degrees
  var THIN_MM = 0.35;        // a pointer's jitter: raw points closer than this are one
  var CORNER_DEG = 60;       // a turn sharper than this is kept as a corner when smoothing
  var MIN_WIDTH = 0.2, MIN_HEIGHT = 0.05;
  var FLUSH_TOL = 0.015, FLUSH_GAP = 0.02;   // mm: a top this near the top of what it is welded to, and how far over it it is stood

  function CDT() { return root.NSO_CDT || (typeof require === 'function' ? tryReq('./nso_cdt.js') : null); }
  function tryReq(p) { try { return require(p); } catch (e) { return null; } }
  function num(x, d) { x = +x; return isFinite(x) ? x : d; }
  function f2(x) { return (Math.round(x * 100) / 100).toFixed(2); }
  function d2(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  /* ---------------------------------------------------------------- the stroke */

  function dedupe(pts, eps, closed) {
    var out = [];
    pts.forEach(function (p) { if (!out.length || d2(out[out.length - 1], p) > eps) out.push([+p[0], +p[1]]); });
    if (closed) while (out.length > 2 && d2(out[0], out[out.length - 1]) <= eps) out.pop();
    return out;
  }

  function turnDeg(a, b, c) {
    var ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
    var lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (lu < 1e-12 || lv < 1e-12) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)))) * 180 / Math.PI;
  }

  /* Chaikin's corner cutting, a turn over CORNER_DEG kept as a corner. */
  function chaikin(pts, closed) {
    var n = pts.length;
    if (n < 3) return pts.slice();
    var out = [];
    for (var i = 0; i < n; i++) {
      var prev = pts[(i - 1 + n) % n], p = pts[i], next = pts[(i + 1) % n];
      var end = !closed && (i === 0 || i === n - 1);
      if (end || turnDeg(prev, p, next) > CORNER_DEG) { out.push(p.slice()); }
      else {
        out.push([0.75 * p[0] + 0.25 * prev[0], 0.75 * p[1] + 0.25 * prev[1]]);
        out.push([0.75 * p[0] + 0.25 * next[0], 0.75 * p[1] + 0.25 * next[1]]);
      }
    }
    return dedupe(out, 1e-6, closed);
  }

  /* Ramer-Douglas-Peucker: the fewest points within tol of the stroke. */
  function rdp(pts, tol) {
    if (pts.length < 3) return pts.slice();
    var keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var s = stack.pop(), a = pts[s[0]], b = pts[s[1]], best = -1, at = -1;
      var dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
      for (var i = s[0] + 1; i < s[1]; i++) {
        var p = pts[i], d = L < 1e-12 ? d2(p, a) : Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L;
        if (d > best) { best = d; at = i; }
      }
      if (best > tol) { keep[at] = 1; stack.push([s[0], at], [at, s[1]]); }
    }
    return pts.filter(function (_, i) { return keep[i]; });
  }

  /* A raw pointer stroke (mm) -> the stroke kept: jitter thinned, smoothed
     twice, as few points as stay within 0.03 mm of that. */
  function smooth(raw, opts) {
    opts = opts || {};
    var closed = !!opts.closed;
    var p = dedupe(raw, num(opts.thin, THIN_MM), closed);
    if (p.length < 2) return p;
    if (opts.smooth !== false) { p = chaikin(p, closed); p = chaikin(p, closed); }
    return rdp(p, num(opts.tol, 0.03));
  }

  /* ---------------------------------------------------------------- 2D helpers */

  function signedArea(L) {
    var a = 0;
    for (var i = 0; i < L.length; i++) { var p = L[i], q = L[(i + 1) % L.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return a / 2;
  }
  function pathLength(pts, closed) {
    var s = 0;
    for (var i = 1; i < pts.length; i++) s += d2(pts[i - 1], pts[i]);
    if (closed && pts.length > 2) s += d2(pts[pts.length - 1], pts[0]);
    return s;
  }
  function bounds(objs) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    (objs || []).forEach(function (o) {
      var r = (o && o.width ? o.width / 2 : 0) * (o && o.kind === 'line' ? 1 : 0);
      (o.pts || []).forEach(function (p) {
        b.x0 = Math.min(b.x0, p[0] - r); b.y0 = Math.min(b.y0, p[1] - r);
        b.x1 = Math.max(b.x1, p[0] + r); b.y1 = Math.max(b.y1, p[1] + r);
      });
    });
    if (!(b.x1 >= b.x0)) return null;
    b.w = b.x1 - b.x0; b.h = b.y1 - b.y0; b.cx = (b.x0 + b.x1) / 2; b.cy = (b.y0 + b.y1) / 2;
    return b;
  }

  /* Where segments ab and cd cross, strictly inside both (an end touching is not a crossing). */
  function segX(a, b, c, d) {
    var rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
    var den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-14) return null;
    var qx = c[0] - a[0], qy = c[1] - a[1];
    var t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
    var e = 1e-9;
    if (t <= e || t >= 1 - e || u <= e || u >= 1 - e) return null;
    return [a[0] + rx * t, a[1] + ry * t];
  }

  /* The first two edges of a loop (or an open chain) that cross: [i, j] or null.
     A sweep over x, so a long stroke is not n squared. */
  function selfCross(L, closed) {
    var n = L.length, m = closed ? n : n - 1, segs = [];
    for (var i = 0; i < m; i++) {
      var a = L[i], b = L[(i + 1) % n];
      segs.push({ i: i, a: a, b: b, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) });
    }
    segs.sort(function (p, q) { return p.x0 - q.x0; });
    for (var s = 0; s < segs.length; s++) {
      var A = segs[s];
      for (var t = s + 1; t < segs.length && segs[t].x0 <= A.x1; t++) {
        var B = segs[t];
        if (B.y0 > A.y1 || B.y1 < A.y0) continue;
        var di = Math.abs(A.i - B.i);
        if (di <= 1 || (closed && di === m - 1)) continue;          // neighbours share a corner
        if (segX(A.a, A.b, B.a, B.b)) return [Math.min(A.i, B.i), Math.max(A.i, B.i)];
      }
    }
    return null;
  }

  function densify(L, maxEdge) {
    var out = [];
    for (var i = 0; i < L.length; i++) {
      var p = L[i], q = L[(i + 1) % L.length], k = Math.ceil(d2(p, q) / maxEdge);
      out.push(p);
      for (var j = 1; j < k; j++) out.push([p[0] + (q[0] - p[0]) * j / k, p[1] + (q[1] - p[1]) * j / k]);
    }
    return out;
  }

  /* ---------------------------------------------------------------- a line's outline */

  function arc(c, r, a0, a1, out) {         // from angle a0 to a1 (either way), the ends left out
    var span = a1 - a0, k = Math.max(1, Math.ceil(Math.abs(span) * 180 / Math.PI / ARC_DEG));
    for (var j = 1; j < k; j++) { var a = a0 + span * j / k; out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]); }
  }

  /* One side of a stroke moved out by r: s = +1 the left, -1 the right. */
  function side(P, r, s, closed) {
    var n = P.length, m = closed ? n : n - 1, dirs = [], out = [];
    for (var k = 0; k < m; k++) {
      var a = P[k], b = P[(k + 1) % n], L = d2(a, b);
      dirs.push([(b[0] - a[0]) / L, (b[1] - a[1]) / L]);
    }
    function nrm(k) { var d = dirs[k]; return [-d[1] * s * r, d[0] * s * r]; }
    function joint(prev, k, p) {
      var dp = dirs[prev], dk = dirs[k], cr = dp[0] * dk[1] - dp[1] * dk[0];
      if (cr * s >= -1e-9) return;                                  // the inside of the turn: unloop cuts it
      var np = nrm(prev), nk = nrm(k), a0 = Math.atan2(np[1], np[0]), a1 = Math.atan2(nk[1], nk[0]);
      if (s > 0) { while (a1 > a0) a1 -= 2 * Math.PI; } else { while (a1 < a0) a1 += 2 * Math.PI; }
      out.push([p[0] + np[0], p[1] + np[1]]);
      arc(p, r, a0, a1, out);
    }
    for (var k2 = 0; k2 < m; k2++) {
      var p = P[k2], q = P[(k2 + 1) % n], nk = nrm(k2);
      if (k2 > 0) joint(k2 - 1, k2, p);
      out.push([p[0] + nk[0], p[1] + nk[1]], [q[0] + nk[0], q[1] + nk[1]]);
    }
    if (closed) joint(m - 1, 0, P[0]);
    var c = unloop(dedupe(out, 1e-7, closed), 6 * r + 2);
    if (!closed) return c;
    /* the turn at the first corner: the chain's end crosses its start */
    var N = c.length, K = Math.min(N - 2, 40);
    for (var i = 0; i < K; i++) for (var j = N - 1; j >= Math.max(i + 2, N - 1 - K); j--) {
      if (i === 0 && j === N - 1) continue;                        // they share the first corner
      var X = segX(c[i], c[i + 1], c[j], c[(j + 1) % N]);
      if (X) return [X].concat(c.slice(i + 1, j + 1));
    }
    return c;
  }

  /* The inside of a turn throws a little loop (the two moved segments cross):
     cut it out at the crossing. Only loops shorter than `reach` - a stroke that
     really crosses itself is not touched here. */
  function unloop(c, reach) {
    var out = c.slice(), i = 0;
    while (i < out.length - 2) {
      var run = 0, last = i + 2, j;
      for (j = i + 2; j < out.length - 1; j++) { run += d2(out[j - 1], out[j]); if (run > reach) break; last = j; }
      var hit = -1, X = null;
      for (j = last; j >= i + 2; j--) {
        if (j + 1 >= out.length) continue;
        X = segX(out[i], out[i + 1], out[j], out[j + 1]);
        if (X) { hit = j; break; }
      }
      if (hit >= 0) out.splice(i + 1, hit - i, X);
      i++;
    }
    return out;
  }

  /* An open stroke of half-width r -> one outline, counter-clockwise, or null when it crosses itself. */
  function openOutline(P, r, cap) {
    var left = side(P, r, 1, false), right = side(P, r, -1, false), loop = left.slice();
    var n = P.length, e = P[n - 1], d = [e[0] - P[n - 2][0], e[1] - P[n - 2][1]], d0 = [P[1][0] - P[0][0], P[1][1] - P[0][1]];
    var aL = Math.atan2(d[0], -d[1]);                                // the left normal at the end
    if (cap !== 'flat') arc(e, r, aL, aL - Math.PI, loop);
    for (var i = right.length - 1; i >= 0; i--) loop.push(right[i]);
    var aR = Math.atan2(-d0[0], d0[1]);                              // the right normal at the start
    if (cap !== 'flat') arc(P[0], r, aR, aR - Math.PI, loop);
    loop = dedupe(loop, 1e-7, true);
    if (signedArea(loop) < 0) loop.reverse();
    return selfCross(loop, true) ? null : loop;
  }

  /* An open stroke that crosses itself: halves, overlapping by a few points so their union is one. */
  function openParts(P, r, cap, depth) {
    var L = openOutline(P, r, cap);
    if (L) return [[L]];
    if (depth > 7) return null;
    if (P.length < 8) {                                              // too few corners to halve: put more on it
      var D = [P[0]], step = Math.max(0.25, r);
      for (var k = 1; k < P.length; k++) {
        var a = P[k - 1], b = P[k], m = Math.max(1, Math.ceil(d2(a, b) / step));
        for (var j = 1; j <= m; j++) D.push([a[0] + (b[0] - a[0]) * j / m, a[1] + (b[1] - a[1]) * j / m]);
      }
      if (D.length < 8) return null;
      P = D;
    }
    var mid = Math.floor(P.length / 2), over = Math.max(2, Math.ceil(r * 2 / Math.max(1e-3, pathLength(P) / P.length)));
    var a = openParts(P.slice(0, Math.min(P.length, mid + over + 1)), r, 'round', depth + 1);
    var b = openParts(P.slice(Math.max(0, mid - over)), r, 'round', depth + 1);
    return a && b ? a.concat(b) : null;
  }

  /* A closed stroke of half-width r: a ring (outer, then the hole), or - narrower than its width - a fill of the outer. */
  function ringOutline(P, r) {
    var Q = signedArea(P) < 0 ? P.slice().reverse() : P;
    var outer = side(Q, r, -1, true), inner = side(Q, r, 1, true);
    if (signedArea(outer) < 0 || selfCross(outer, true)) return null;
    var holeOk = inner.length >= 3 && signedArea(inner) > 0 && !selfCross(inner, true);
    if (!holeOk) return [outer];
    return [outer, inner.slice().reverse()];
  }

  /* ---------------------------------------------------------------- an object's outlines */

  function check(o) {
    if (!o || !Array.isArray(o.pts)) return { ok: false, reason: 'not a drawn object' };
    var kind = o.kind === 'fill' ? 'fill' : 'line', closed = kind === 'fill' || !!o.closed;
    var pts = dedupe(o.pts, 1e-4, closed);
    var width = num(o.width, 1.2);
    if (kind === 'line' && !(width >= MIN_WIDTH)) return { ok: false, reason: 'a line must be at least ' + MIN_WIDTH + ' mm wide' };
    if (pts.length < (closed ? 3 : 2)) return { ok: false, reason: kind === 'fill' ? 'a fill needs at least three points' : 'a line needs at least two points' };
    return { ok: true, kind: kind, closed: closed, pts: pts, width: width };
  }

  /* -> { ok, regions: [[outer, hole, ...], ...] } - more than one region is a
     line cut into runs that overlap (the caller unions them). */
  function outlines(o) {
    var c = check(o);
    if (!c.ok) return c;
    var name = o.name || (c.kind === 'fill' ? 'a fill' : 'a line');
    if (c.kind === 'fill') {
      var L = c.pts.slice();
      if (selfCross(L, true)) return { ok: false, reason: name + ' crosses itself - a fill must go round once (draw it as two fills, or make it a line)' };
      if (Math.abs(signedArea(L)) < 0.01) return { ok: false, reason: name + ' encloses no area' };
      if (signedArea(L) < 0) L.reverse();
      return { ok: true, regions: [[L]] };
    }
    var r = c.width / 2;
    if (c.closed) {
      var ring = ringOutline(c.pts, r);
      if (!ring) return { ok: false, reason: name + ' crosses itself as a ring - open it, or make it a fill' };
      return { ok: true, regions: [ring] };
    }
    if (pathLength(c.pts) < 1e-3) return { ok: false, reason: name + ' has no length' };
    var parts = openParts(c.pts, r, o.cap === 'flat' ? 'flat' : 'round', 0);
    if (!parts) return { ok: false, reason: name + ' folds onto itself tighter than its width - draw it wider apart or make it thinner' };
    return { ok: true, regions: parts };
  }

  /* ---------------------------------------------------------------- solids */

  /* loops (outer CCW, holes CW) stood up from z0 to z1 -> a closed soup. */
  function extrude(loops, z0, z1) {
    var lib = CDT();
    if (!lib) return { ok: false, reason: 'nso_cdt.js did not load' };
    if (!(z1 > z0)) return { ok: false, reason: 'no height' };
    var pts = [], segs = [], rings = [];
    loops.forEach(function (L) {
      var D = densify(L, MAX_EDGE), base = pts.length;
      D.forEach(function (p, i) { pts.push(p); segs.push([base + i, base + (i + 1) % D.length]); });
      rings.push(D);
    });
    var tr = lib.triangulate(pts, segs);
    if (!tr || !tr.tris) return { ok: false, reason: 'the outline could not be filled' + (tr && tr.reason ? ': ' + tr.reason : '') };
    if (tr.split) return { ok: false, reason: 'the outline touches itself' };
    var out = [], tris = tr.tris;
    function T(a, za, b, zb, c, zc) { out.push(a[0], a[1], za, b[0], b[1], zb, c[0], c[1], zc); }
    for (var q = 0; q < tris.length; q += 3) {
      var A = pts[tris[q]], B = pts[tris[q + 1]], C = pts[tris[q + 2]];
      if ((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]) < 0) { var t = B; B = C; C = t; }
      T(A, z0, C, z0, B, z0);
      T(A, z1, B, z1, C, z1);
    }
    rings.forEach(function (D) {
      for (var w = 0; w < D.length; w++) {
        var P0 = D[w], P1 = D[(w + 1) % D.length];
        T(P0, z0, P1, z0, P1, z1);
        T(P0, z0, P1, z1, P0, z1);
      }
    });
    var soup = new Float32Array(out), vol = signedVolume(soup);
    if (!(vol > 0)) return { ok: false, reason: 'the outline came out inside out' };
    return { ok: true, soup: soup, volume: vol };
  }

  function signedVolume(s) {
    var v = 0;
    for (var i = 0; i < s.length; i += 9) {
      v += s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7])
         - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6])
         + s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6]);
    }
    return v / 6;
  }

  /* The whole sketch as solids, centred on its box (x, y), z out of the face.
     opts: embed (how far below z = 0 every solid starts; 0 for a piece of its
     own), lift (the whole drawing raised off the face; negative sinks it),
     scale, mirror ('x' | 'y'), height (overrides every object's).
     -> { ok, parts: [{ soup, volume, obj, region }], area, box } */
  function solids(sketch, opts) {
    opts = opts || {};
    var objs = (sketch && sketch.objects || []).filter(function (o) { return o && o.hidden !== true; });
    if (!objs.length) return { ok: false, reason: 'the drawing is empty - draw something in the Draw editor first' };
    var sc = num(opts.scale, 1), mx = opts.mirror === 'x' ? -1 : 1, my = opts.mirror === 'y' ? -1 : 1;
    /* stretch: the drawing pulled along its own x and y (a line's width is not stretched) */
    var st = opts.stretch || [1, 1], sx = num(st[0], 1), sy = num(st[1], 1);
    if (!(sc > 0)) return { ok: false, reason: 'the scale must be more than 0' };
    if (!(sx > 0) || !(sy > 0)) return { ok: false, reason: 'a stretch must be more than 0' };
    var b = bounds(objs), embed = Math.max(0, num(opts.embed, 0)), lift = num(opts.lift, 0), parts = [], area = 0, lowered = 0;
    for (var k = 0; k < objs.length; k++) {
      var src = objs[k];
      var o = { name: src.name, kind: src.kind, closed: src.closed, cap: src.cap, width: num(src.width, 1.2) * sc,
                pts: (src.pts || []).map(function (p) { return [(p[0] - b.cx) * sc * sx * mx, (p[1] - b.cy) * sc * sy * my]; }) };
      if (mx * my < 0) o.pts.reverse();
      var h = num(opts.height, NaN);
      if (!(h > 0)) h = num(src.height, NaN);
      if (!(h > 0)) h = num(sketch.height, 1);
      if (!(h >= MIN_HEIGHT)) return { ok: false, reason: (src.name || 'an object') + ': the height must be at least ' + MIN_HEIGHT + ' mm', at: k };
      /* a top flush with the top of what it is welded to is a seam the boolean cannot close cleanly (it leaves
         non-manifold edges; just under it is worse - the cut runs through the piece's own slivers): stood FLUSH_GAP
         over it instead - far below any layer height */
      if (opts.avoidTop != null && Math.abs(lift + h - opts.avoidTop) < FLUSH_TOL) { h = opts.avoidTop + FLUSH_GAP - lift; lowered++; }
      var ol = outlines(o);
      if (!ol.ok) return { ok: false, reason: ol.reason, at: k };
      for (var g = 0; g < ol.regions.length; g++) {
        var e = extrude(ol.regions[g], lift - embed, lift + h);
        if (!e.ok) return { ok: false, reason: (src.name || 'an object') + ': ' + e.reason, at: k };
        parts.push({ soup: e.soup, volume: e.volume, obj: k, region: g, loops: ol.regions[g] });
        if (g === 0) area += ol.regions[g].reduce(function (s, L) { return s + signedArea(L); }, 0);
      }
    }
    return { ok: true, parts: parts, area: area, box: { w: b.w * sc * sx, h: b.h * sc * sy }, centre: [b.cx, b.cy], count: objs.length, lowered: lowered };
  }

  /* parts that share space (their boxes overlap): groups the caller unions before anything else */
  function overlapGroups(parts) {
    var box = parts.map(function (p) {
      var s = p.soup, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (var i = 0; i < s.length; i += 3) for (var k = 0; k < 3; k++) { if (s[i + k] < lo[k]) lo[k] = s[i + k]; if (s[i + k] > hi[k]) hi[k] = s[i + k]; }
      return { lo: lo, hi: hi };
    });
    var par = parts.map(function (_, i) { return i; });
    function find(a) { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; }
    for (var i = 0; i < parts.length; i++) for (var j = i + 1; j < parts.length; j++) {
      var A = box[i], B = box[j], hit = true;
      for (var k = 0; k < 3; k++) if (A.lo[k] > B.hi[k] + 1e-6 || B.lo[k] > A.hi[k] + 1e-6) hit = false;
      if (hit) par[find(i)] = find(j);
    }
    var g = {};
    parts.forEach(function (p, i) { var r = find(i); (g[r] = g[r] || []).push(p); });
    return Object.keys(g).map(function (k) { return g[k]; });
  }

  function concat(soups) {
    var n = soups.reduce(function (s, x) { return s + x.length; }, 0), out = new Float32Array(n), at = 0;
    soups.forEach(function (x) { out.set(x, at); at += x.length; });
    return out;
  }

  /* ---------------------------------------------------------------- the sketch */

  function normalize(sk) {
    var s = { height: Math.max(MIN_HEIGHT, num(sk && sk.height, 1)), objects: [], nextId: 1, trace: null };
    /* a piece traced under the sheet: the drawing is then in PLATE millimetres (x, y as the plate has them, from
       above), and `box` is the piece's plan box when it was traced - so Connect can put the drawing where it was
       drawn, and follow the piece if it has moved since */
    var t = sk && sk.trace;
    if (t && Array.isArray(t.loops) && t.box) {
      s.trace = { pieceId: t.pieceId, name: String(t.name || ''), at: num(t.at, 0), z0: num(t.z0, 0), z1: num(t.z1, 0),
                  box: { x0: num(t.box.x0, 0), y0: num(t.box.y0, 0), x1: num(t.box.x1, 0), y1: num(t.box.y1, 0) },
                  loops: t.loops.filter(function (L) { return Array.isArray(L) && L.length >= 3; })
                    .map(function (L) { return L.map(function (p) { return [num(p[0], 0), num(p[1], 0)]; }); }),
                  rims: (t.rims || []).filter(function (L) { return Array.isArray(L) && L.length >= 3; })
                    .map(function (L) { return L.map(function (p) { return [num(p[0], 0), num(p[1], 0)]; }); }) };
    }
    ((sk && sk.objects) || []).forEach(function (o) {
      if (!o || !Array.isArray(o.pts) || o.pts.length < 2) return;
      s.objects.push({
        id: o.id != null ? o.id : null, name: String(o.name || ''), kind: o.kind === 'fill' ? 'fill' : 'line',
        closed: !!o.closed, width: Math.max(MIN_WIDTH, num(o.width, 1.2)),
        height: o.height == null || o.height === '' ? null : Math.max(MIN_HEIGHT, num(o.height, 1)),
        pts: o.pts.map(function (p) { return [num(p[0], 0), num(p[1], 0)]; })
      });
    });
    var top = 0;
    s.objects.forEach(function (o) { if (typeof o.id === 'number' && o.id > top) top = o.id; });
    s.objects.forEach(function (o) { if (typeof o.id !== 'number') o.id = ++top; });
    s.nextId = top + 1;
    return s;
  }

  /* A 2D affine [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
  function transform(pts, m) {
    return pts.map(function (p) { return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]]; });
  }

  function rectPts(x0, y0, x1, y1) { return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]; }
  function ellipsePts(cx, cy, rx, ry) {
    var k = Math.max(24, Math.min(96, Math.ceil(Math.PI * (Math.abs(rx) + Math.abs(ry)) / 1.2))), out = [];
    for (var i = 0; i < k; i++) { var a = 2 * Math.PI * i / k; out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
    return out;
  }

  function describe(sk) {
    var o = (sk && sk.objects) || [], lines = o.filter(function (x) { return x.kind !== 'fill'; }).length, fills = o.length - lines, b = bounds(o);
    var words = [];
    if (lines) words.push(lines + ' line' + (lines > 1 ? 's' : ''));
    if (fills) words.push(fills + ' fill' + (fills > 1 ? 's' : ''));
    return (words.join(' + ') || 'nothing drawn') + (b ? ', ' + f2(b.w) + ' × ' + f2(b.h) + ' mm' : '');
  }

  var API = {
    smooth: smooth, chaikin: chaikin, rdp: rdp, outlines: outlines, extrude: extrude, solids: solids, overlapGroups: overlapGroups,
    concat: concat, normalize: normalize, bounds: bounds, transform: transform, rectPts: rectPts, ellipsePts: ellipsePts,
    describe: describe, signedArea: signedArea, signedVolume: signedVolume, selfCross: selfCross, pathLength: pathLength,
    FLUSH_GAP: FLUSH_GAP, MAX_EDGE: MAX_EDGE, MIN_WIDTH: MIN_WIDTH, MIN_HEIGHT: MIN_HEIGHT
  };
  root.NSO_Sketch = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
