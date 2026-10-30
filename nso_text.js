/* nso_text.js - Text: type a word, stamp it into the surface of a piece.
   docs/TEXT.md.

   Loads as a classic script (window.NSO_Text) and as a Node module. No DOM, no
   THREE. The page rasterises the text (a canvas knows every font the machine
   has); this file does the rest, on numbers:

     NSO_Text.shape(mask, opts)          -> { ok, polys, width, height, area, ... }
     NSO_Text.plan(soup, hit, shape, o)  -> { ok, reason, stats, frame, data }
     NSO_Text.cutter(plan)               -> one closed triangle soup (Float32Array)

   mask  { w, h, data, mmPerPx }: data is w * h alpha values 0..255, row 0 at the
         TOP (a canvas's ImageData order). Ink is alpha >= 128. A pixel is
         mmPerPx wide, so the mask carries the letters' size.

   SHAPE. The 128 contour of the alpha field is traced by marching squares, the
   crossings placed by linear interpolation (so a 16 px/mm raster is good to
   well under a pixel), the loops simplified (Douglas-Peucker, 0.35 px) and the
   specks under 2 px dropped. Outer loops come out counter-clockwise, holes
   clockwise; each hole is filed under the smallest outer loop that holds it. The
   polygons are in mm, y up, centred on the middle of the ink's bounding box, so
   that centre is what the click puts on the surface. shape() owns no surface.

   TRIANGULATION. Ear clipping with the holes bridged into their outer loop
   (Eberly: the rightmost vertex of a hole, a ray to the right, the visible
   vertex). Every polygon's triangles must add up to its own area or the shape
   is refused: a bad triangulation is never handed to the boolean.

   PLAN. The click's smooth surface comes from NSO_Punch.surface: its frame
   (n the smooth normal at the click, u along the face's longest straight edge,
   v = n x u) and a probe, foot(p), for where the line through a tangent-plane
   point along n meets that same surface. The text reads along u turned angle
   degrees counter-clockwise seen from outside (mirror: reversed, for a stamp
   or a mould). The cutter is a prism along n with:

     - a flat TOP, lift (0.2 mm) above the highest surface under the text,
     - vertical walls,
     - a BOTTOM that follows the surface: each vertex of the text's own
       triangulation sits depth below the footprint under it, measured square to
       the surface there (depth / cos of the surface's lean from n, never more
       than 2x), so the engraving is the same depth all over a cylinder or a
       dome, not a flat-bottomed scoop. On a flat face the bottom is flat and
       the triangulation is left alone; on a curved one it is refined (longest
       edge bisection) until no edge is over maxEdge (1 mm), so the bottom's
       straight facets are within a hundredth of a mm of the true offset.

   REFUSED, in words, the piece untouched:
     - a point of the text with no surface under it (the text runs off the face,
       or onto another face: a step, the side of the slab);
     - a wall under the text thinner than the floor (two nozzle widths) once the
       engraving is taken out; it says how deep would fit;
     - a number that is not one (depth, angle, size).
   Not refused, said: strokes thinner than a nozzle width (they will not print).

   PAINT SCOPE: NOT APPLICABLE here - this file reads a soup and returns a new
   one. The app's Text card, which subtracts it, carries the paint check
   (docs/HANDOFF.md). */
(function (root) {
  'use strict';

  var Punch = root && root.NSO_Punch ? root.NSO_Punch : null;
  if (!Punch && typeof module !== 'undefined' && typeof require === 'function') {
    try { Punch = require('./nso_punch.js'); } catch (e) { Punch = null; }
  }

  var DEFAULTS = {
    thr: 128,            // alpha at or over this is ink
    tolPx: 0.35,         // simplification, in pixels
    minAreaPx: 2,        // a loop smaller than this is a speck
    depth: 1,            // mm below the surface
    angle: 0,            // degrees, counter-clockwise seen from outside
    mirror: false,
    nozzle: 0.4,         // the wall floor under the text is two of these
    lift: 0.2,           // the cutter's top stands this far over the highest surface
    maxEdge: 1,          // mm, the longest edge of a curved surface's bottom
    maxTris: 30000,      // a plan over this coarsens maxEdge, then refuses
    smoothDeg: 30,
    maxDepth: 50,
    sampleCap: 1500      // wall-thickness rays per plan
  };

  function fmt(x) { var a = (Math.round(x * 10) / 10).toFixed(1); return a === '-0.0' ? '0.0' : a; }
  function fmt2(x) { return (Math.round(x * 100) / 100).toFixed(2); }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  /* ----------------------------------------------------------- the contour */

  /* Marching squares on the alpha field. Returns closed loops of [x, y] in
     pixels (y up, pixel centres on whole numbers), inside on the left: outer
     loops counter-clockwise, holes clockwise. */
  function trace(d, w, h, thr) {
    function val(x, y) { return (x < 0 || y < 0 || x >= w || y >= h) ? 0 : d[(h - 1 - y) * w + x]; }
    var rowInk = new Uint8Array(h + 2), x, y, i;
    for (y = 0; y < h; y++) {
      var base = (h - 1 - y) * w;
      for (x = 0; x < w; x++) if (d[base + x] >= thr) { rowInk[y + 1] = 1; break; }
    }
    var W2 = w + 2, nextOf = new Map(), pts = new Map();
    function hId(cx, cy) { return ((cy + 1) * W2 + (cx + 1)) * 2; }
    function vId(cx, cy) { return ((cy + 1) * W2 + (cx + 1)) * 2 + 1; }
    function putH(cx, cy, f0, f1) {
      var id = hId(cx, cy);
      if (!pts.has(id)) pts.set(id, [cx + (thr - f0) / (f1 - f0), cy]);
      return id;
    }
    function putV(cx, cy, f0, f1) {
      var id = vId(cx, cy);
      if (!pts.has(id)) pts.set(id, [cx, cy + (thr - f0) / (f1 - f0)]);
      return id;
    }
    for (y = -1; y < h; y++) {
      if (!rowInk[y + 1] && !rowInk[y + 2]) continue;
      for (x = -1; x < w; x++) {
        var f0 = val(x, y), f1 = val(x + 1, y), f2 = val(x + 1, y + 1), f3 = val(x, y + 1);
        var i0 = f0 >= thr, i1 = f1 >= thr, i2 = f2 >= thr, i3 = f3 >= thr;
        if (i0 === i1 && i1 === i2 && i2 === i3) continue;
        var ins = [i0, i1, i2, i3], cr = [];
        for (var k = 0; k < 4; k++) {
          var s = ins[k], e = ins[(k + 1) % 4];
          if (s === e) continue;
          var id = k === 0 ? putH(x, y, f0, f1) : k === 1 ? putV(x + 1, y, f1, f2) : k === 2 ? putH(x, y + 1, f3, f2) : putV(x, y, f0, f3);
          cr.push({ id: id, a: s });                  // a: in -> out, where the contour comes in
        }
        if (cr.length === 2) {
          var A = cr[0].a ? cr[0] : cr[1], B = cr[0].a ? cr[1] : cr[0];
          nextOf.set(A.id, B.id);
        } else {
          var joined = (f0 + f1 + f2 + f3) / 4 >= thr;     // the saddle: is the ink one piece?
          for (i = 0; i < 4; i++) if (cr[i].a) nextOf.set(cr[i].id, cr[joined ? (i + 1) % 4 : (i + 3) % 4].id);
        }
      }
    }
    var loops = [], seen = new Set();
    nextOf.forEach(function (_, start) {
      if (seen.has(start)) return;
      var loop = [], cur = start, ok = true;
      while (!seen.has(cur)) {
        seen.add(cur);
        loop.push(pts.get(cur));
        cur = nextOf.get(cur);
        if (cur === undefined) { ok = false; break; }
      }
      if (ok && cur === start && loop.length >= 3) loops.push(loop);
    });
    return loops;
  }

  function area2(p) {            // twice the signed area, counter-clockwise positive
    var s = 0;
    for (var i = 0, n = p.length; i < n; i++) {
      var a = p[i], b = p[(i + 1) % n];
      s += a[0] * b[1] - b[0] * a[1];
    }
    return s;
  }
  function perimeter(p) {
    var s = 0;
    for (var i = 0, n = p.length; i < n; i++) {
      var a = p[i], b = p[(i + 1) % n];
      s += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    return s;
  }

  /* Douglas-Peucker on a closed loop: split at the point farthest from the
     first, simplify the two chains. */
  function simplifyClosed(p, eps) {
    var n = p.length;
    if (n <= 4) return p;
    var far = 0, fd = -1, i;
    for (i = 1; i < n; i++) {
      var dd = (p[i][0] - p[0][0]) * (p[i][0] - p[0][0]) + (p[i][1] - p[0][1]) * (p[i][1] - p[0][1]);
      if (dd > fd) { fd = dd; far = i; }
    }
    var keep = new Uint8Array(n);
    keep[0] = 1; keep[far] = 1;
    function chain(i0, i1) {                  // indices i0 < i1 on the unrolled loop
      var stack = [[i0, i1]];
      while (stack.length) {
        var seg = stack.pop(), a = p[seg[0] % n], b = p[seg[1] % n];
        var dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy), best = -1, bd = eps;
        for (var j = seg[0] + 1; j < seg[1]; j++) {
          var q = p[j % n];
          var dist = L > 1e-12 ? Math.abs((q[0] - a[0]) * dy - (q[1] - a[1]) * dx) / L : Math.hypot(q[0] - a[0], q[1] - a[1]);
          if (dist > bd) { bd = dist; best = j; }
        }
        if (best >= 0) { keep[best % n] = 1; stack.push([seg[0], best], [best, seg[1]]); }
      }
    }
    chain(0, far);
    chain(far, n);
    var out = [];
    for (i = 0; i < n; i++) if (keep[i]) out.push(p[i]);
    return out;
  }

  /* A loop without its repeated points, its straight-through points and its
     zero-width spikes (a tip where the path turns back along itself): the
     vertices a triangulation cannot use. The shape is unchanged. */
  function cleanLoop(p) {
    function dead(a, b, c) {                       // b adds nothing between a and c: a repeat, a straight run, a spike
      var ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
      if (ab < 1e-9) return true;
      var cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      return Math.abs(cr) <= 1e-9 * Math.max(1, ab * bc);
    }
    var out = [], i;
    for (i = 0; i < p.length; i++) {
      while (out.length >= 2 && dead(out[out.length - 2], out[out.length - 1], p[i])) out.pop();
      out.push(p[i]);
    }
    for (var again = true; again && out.length > 3;) {         // the seam, where the loop closes
      again = false;
      var n = out.length;
      if (dead(out[n - 2], out[n - 1], out[0])) { out.pop(); again = true; }
      else if (dead(out[n - 1], out[0], out[1])) { out.shift(); again = true; }
    }
    return out;
  }

  /* Which loops cross or touch each other or themselves (a segment's endpoint on
     another, or the two cutting through): the indices, by a grid of the segments. */
  function crossing(loops) {
    var segs = [], total = 0, i, k;
    loops.forEach(function (l, li) {
      for (k = 0; k < l.length; k++) {
        var a = l[k], b = l[(k + 1) % l.length];
        segs.push({ a: a, b: b, li: li, k: k, n: l.length });
        total += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
    });
    if (!segs.length) return new Set();
    var cell = Math.max(1, 2 * total / segs.length), grid = new Map(), bad = new Set();
    segs.forEach(function (sg, id) {
      var x0 = Math.floor(Math.min(sg.a[0], sg.b[0]) / cell), x1 = Math.floor(Math.max(sg.a[0], sg.b[0]) / cell);
      var y0 = Math.floor(Math.min(sg.a[1], sg.b[1]) / cell), y1 = Math.floor(Math.max(sg.a[1], sg.b[1]) / cell);
      for (var gx = x0; gx <= x1; gx++) for (var gy = y0; gy <= y1; gy++) {
        var key = gx * 100003 + gy, l = grid.get(key);
        if (l) l.push(id); else grid.set(key, [id]);
      }
    });
    function orient(p, q, r) { return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); }
    function onSeg(p, q, r) {                                   // r on the segment pq, not at its ends
      if (Math.abs(orient(p, q, r)) > 1e-9) return false;
      var t = ((r[0] - p[0]) * (q[0] - p[0]) + (r[1] - p[1]) * (q[1] - p[1])) / ((q[0] - p[0]) * (q[0] - p[0]) + (q[1] - p[1]) * (q[1] - p[1]));
      return t > 1e-9 && t < 1 - 1e-9;
    }
    grid.forEach(function (ids) {
      for (var x = 0; x < ids.length; x++) for (var y = x + 1; y < ids.length; y++) {
        var A = segs[ids[x]], B = segs[ids[y]];
        if (A.li === B.li && (Math.abs(A.k - B.k) === 1 || Math.abs(A.k - B.k) === A.n - 1)) continue;
        var d1 = orient(A.a, A.b, B.a), d2 = orient(A.a, A.b, B.b), d3 = orient(B.a, B.b, A.a), d4 = orient(B.a, B.b, A.b);
        if ((d1 * d2 < 0 && d3 * d4 < 0) || onSeg(A.a, A.b, B.a) || onSeg(A.a, A.b, B.b) || onSeg(B.a, B.b, A.a) || onSeg(B.a, B.b, A.b)) {
          bad.add(A.li); bad.add(B.li);
        }
      }
    });
    return bad;
  }
  /* Simplify every loop, then check none crosses another or itself (a spike
     thinner than the tolerance can fold over); a loop that does is simplified
     again at half the tolerance, down to the traced loop, which cannot. */
  function simplifySafe(raw, eps) {
    raw = raw.map(cleanLoop);
    var cur = raw.map(function (r) { return { eps: eps, pts: cleanLoop(simplifyClosed(r, eps)) }; });
    for (var iter = 0; iter < 6; iter++) {
      var bad = crossing(cur.map(function (c) { return c.pts; }));
      if (!bad.size) break;
      bad.forEach(function (li) {
        var c = cur[li];
        c.eps = iter >= 4 ? 0 : c.eps / 2;
        c.pts = c.eps > 0 ? cleanLoop(simplifyClosed(raw[li], c.eps)) : raw[li];
      });
    }
    return cur.map(function (c) { return c.pts; }).filter(function (l) { return l.length >= 3; });
  }

  /* The text's shape: polygons in mm. */
  function shape(mask, opts) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in opts || {}) if (opts[k] !== undefined) o[k] = opts[k];
    function bad(reason) { return { ok: false, reason: reason, polys: [] }; }
    if (!mask || !(mask.w > 0) || !(mask.h > 0) || !mask.data || mask.data.length < mask.w * mask.h) return bad('there is no text to stamp');
    if (!(mask.mmPerPx > 0) || !isFinite(mask.mmPerPx)) return bad('the text has no size');
    var raw = trace(mask.data, mask.w, mask.h, o.thr), loops = [], i;
    raw = raw.filter(function (r) { return r.length >= 3 && Math.abs(area2(r)) / 2 >= o.minAreaPx; });
    loops = simplifySafe(raw, o.tolPx);
    if (!loops.length) return bad('there is no ink in that text - nothing to stamp');
    var outers = [], holes = [];
    loops.forEach(function (l) { (area2(l) > 0 ? outers : holes).push(l); });
    if (!outers.length) return bad('there is no ink in that text - nothing to stamp');
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    outers.forEach(function (l) {
      l.forEach(function (p) {
        lo[0] = Math.min(lo[0], p[0]); lo[1] = Math.min(lo[1], p[1]);
        hi[0] = Math.max(hi[0], p[0]); hi[1] = Math.max(hi[1], p[1]);
      });
    });
    var cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2, mm = mask.mmPerPx;
    function toMm(l) { return l.map(function (p) { return [(p[0] - cx) * mm, (p[1] - cy) * mm]; }); }
    var polys = outers.map(function (l) { return { outer: toMm(l), holes: [], a2: area2(l) }; });
    holes.forEach(function (hl) {
      var p0 = hl[0], best = null;
      polys.forEach(function (P, j) {
        if (inside(outers[j], p0) && (!best || P.a2 < best.a2)) best = P;
      });
      if (best) best.holes.push(toMm(hl));
    });
    var area = 0, perim = 0;
    polys.forEach(function (P) {
      area += area2(P.outer) / 2; perim += perimeter(P.outer);
      P.holes.forEach(function (H) { area += area2(H) / 2; perim += perimeter(H); });
      delete P.a2;
    });
    return {
      ok: true, polys: polys, width: (hi[0] - lo[0]) * mm, height: (hi[1] - lo[1]) * mm, area: area, perimeter: perim,
      stroke: perim > 0 ? 2 * area / perim : 0, vertices: polys.reduce(function (n, P) {
        return n + P.outer.length + P.holes.reduce(function (m, H) { return m + H.length; }, 0);
      }, 0), mmPerPx: mm
    };
  }
  function inside(poly, p) {
    var c = false, n = poly.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var a = poly[i], b = poly[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  /* The same shape read backwards, x reversed. */
  function mirrored(sh) {
    if (sh._mirror) return sh._mirror;
    function flip(r) { return r.map(function (p) { return [-p[0], p[1]]; }).reverse(); }
    var m = {};
    for (var k in sh) m[k] = sh[k];
    m.polys = sh.polys.map(function (P) { return { outer: flip(P.outer), holes: P.holes.map(flip) }; });
    m._mesh = null; m._mirror = null;
    sh._mirror = m;
    return m;
  }

  /* ------------------------------------------------------- triangulation */

  function inTri(ax, ay, bx, by, cx, cy, px, py) {       // counter-clockwise triangle, edges included
    return (cx - px) * (ay - py) - (ax - px) * (cy - py) >= 0 &&
           (ax - px) * (by - py) - (bx - px) * (ay - py) >= 0 &&
           (bx - px) * (cy - py) - (cx - px) * (by - py) >= 0;
  }
  function nodeOf(i, x, y) { return { i: i, x: x, y: y, prev: null, next: null }; }
  function ringNodes(V, ring) {
    var first = null, last = null;
    ring.forEach(function (p) {
      var nd = nodeOf(V.length, p[0], p[1]);
      V.push([p[0], p[1]]);
      if (!first) first = nd; else { last.next = nd; nd.prev = last; }
      last = nd;
    });
    last.next = first; first.prev = last;
    return first;
  }
  function turn(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
  function same(a, b) { return a.x === b.x && a.y === b.y; }

  /* The vertex of the ring a hole's rightmost vertex M can see (Eberly). */
  function bridgeTo(M, start) {
    var mx = M.x, my = M.y, bestX = Infinity, edge = null, p = start;
    do {
      var q = p.next;
      if (p.y <= my && q.y > my) {                          // an upward edge crossing the ray's height
        var x = p.x + (my - p.y) * (q.x - p.x) / (q.y - p.y);
        if (x >= mx && x < bestX) { bestX = x; edge = p; }
      }
      p = q;
    } while (p !== start);
    if (!edge) return null;
    var P = edge.x > edge.next.x ? edge : edge.next;
    if (edge.y === my && edge.x >= mx) return edge;          // the ray ran through a vertex
    var ax = mx, ay = my, bx = bestX, by = my, cx = P.x, cy = P.y;
    if ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) < 0) { var tx = bx, ty = by; bx = cx; by = cy; cx = tx; cy = ty; }
    var best = P, bt = Infinity, r = start;
    do {
      if (r !== P && r.x >= mx && !(r.x === mx && r.y === my) && turn(r.prev, r, r.next) <= 0 && inTri(ax, ay, bx, by, cx, cy, r.x, r.y)) {
        var t = Math.abs(r.y - my) / Math.max(1e-300, r.x - mx);
        if (t < bt || (t === bt && r.x < best.x)) { bt = t; best = r; }
      }
      r = r.next;
    } while (r !== start);
    return best;
  }
  function splice(V0, M) {                                   // V0 -> M ... M' -> V0' -> V0's old next
    var last = M.prev, nxt = V0.next;
    var M1 = nodeOf(M.i, M.x, M.y), V1 = nodeOf(V0.i, V0.x, V0.y);
    V0.next = M; M.prev = V0;
    last.next = M1; M1.prev = last;
    M1.next = V1; V1.prev = M1;
    V1.next = nxt; nxt.prev = V1;
  }
  function isEar(b, n) {
    var a = b.prev, c = b.next;
    if (turn(a, b, c) <= 0) return false;
    var p = c.next;
    for (var k = 0; k < n - 3 && p !== a; k++, p = p.next) {
      if (same(p, a) || same(p, b) || same(p, c)) continue;
      if (turn(p.prev, p, p.next) <= 0 && inTri(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y)) return false;
    }
    return true;
  }
  /* One polygon with its holes -> triangles (index triples into V, which the
     polygon's vertices are appended to). */
  function triangulatePoly(V, P) {
    var outer = area2(P.outer) > 0 ? P.outer : P.outer.slice().reverse();
    var start = ringNodes(V, outer), count = outer.length, i;
    var holes = P.holes.map(function (H) { return area2(H) < 0 ? H : H.slice().reverse(); });
    var hn = holes.map(function (H) {
      var first = ringNodes(V, H), m = first, p = first;
      do { if (p.x > m.x) m = p; p = p.next; } while (p !== first);
      return { M: m, n: H.length };
    });
    hn.sort(function (a, b) { return b.M.x - a.M.x; });
    for (i = 0; i < hn.length; i++) {
      var tgt = bridgeTo(hn[i].M, start);
      if (!tgt) return null;
      splice(tgt, hn[i].M);
      count += hn[i].n + 2;
    }
    var tris = [], ear = start, remaining = count;
    while (remaining > 3) {
      var found = false, p = ear;
      for (var k = 0; k < remaining; k++, p = p.next) {
        if (isEar(p, remaining)) {
          tris.push([p.prev.i, p.i, p.next.i]);
          p.prev.next = p.next; p.next.prev = p.prev;
          ear = p.next.next; remaining--; found = true;
          break;
        }
      }
      if (found) continue;
      // no ear: take the least reflex corner so the loop always ends; the area gate catches the damage
      var bp = ear, bt = -Infinity, q = ear;
      for (k = 0; k < remaining; k++, q = q.next) { var tt = turn(q.prev, q, q.next); if (tt > bt) { bt = tt; bp = q; } }
      tris.push([bp.prev.i, bp.i, bp.next.i]);
      bp.prev.next = bp.next; bp.next.prev = bp.prev;
      ear = bp.next; remaining--;
    }
    if (remaining === 3) tris.push([ear.prev.i, ear.i, ear.next.i]);
    return tris;
  }
  function triArea2(V, t) {
    var a = V[t[0]], b = V[t[1]], c = V[t[2]];
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  }
  /* The whole shape: { V, T } or { reason }. */
  function triangulate(sh) {
    var V = [], T = [];
    for (var i = 0; i < sh.polys.length; i++) {
      var P = sh.polys[i], tr = triangulatePoly(V, P);
      if (!tr) return { reason: 'the letters could not be triangulated (a hole with no way out)' };
      var want = area2(P.outer), got = 0;
      P.holes.forEach(function (H) { want += area2(H); });
      want = Math.abs(want);
      tr.forEach(function (t) { got += triArea2(V, t); });
      if (!(Math.abs(got - want) <= 1e-6 * Math.max(1, want) + 1e-9)) {
        return { reason: 'the letters could not be triangulated cleanly (area ' + fmt2(got / 2) + ' mm² against ' + fmt2(want / 2) + ')' };
      }
      for (var j = 0; j < tr.length; j++) {
        if (!(triArea2(V, tr[j]) > 0)) return { reason: 'the letters could not be triangulated cleanly (a flat or turned triangle)' };
        T.push(tr[j]);
      }
    }
    return { V: V, T: T };
  }

  /* ------------------------------------------------------------ refinement */

  /* Longest-edge bisection (Rivara) to no edge over maxEdge. Triangles stay
     counter-clockwise and the mesh conforming: a split edge splits both sides. */
  function refine(V0, T0, maxEdge, maxTris) {
    var V = V0.map(function (p) { return [p[0], p[1]]; }), tris = [], alive = [], edges = new Map();
    var K = 1 << 26;
    function key(a, b) { return a < b ? a * K + b : b * K + a; }
    function reg(t) {
      var T = tris[t];
      for (var k = 0; k < 3; k++) {
        var e = key(T[k], T[(k + 1) % 3]), l = edges.get(e);
        if (l) l.push(t); else edges.set(e, [t]);
      }
    }
    function unreg(t) {
      var T = tris[t];
      for (var k = 0; k < 3; k++) {
        var e = key(T[k], T[(k + 1) % 3]), l = edges.get(e);
        if (!l) continue;
        var j = l.indexOf(t);
        if (j >= 0) l.splice(j, 1);
        if (!l.length) edges.delete(e);
      }
    }
    var live = 0;
    function addTri(a, b, c) { tris.push([a, b, c]); alive.push(1); reg(tris.length - 1); live++; return tris.length - 1; }
    function elen(a, b) { return Math.hypot(V[a][0] - V[b][0], V[a][1] - V[b][1]); }
    function longest(t) {                                   // edge number k: T[k] -> T[k + 1]
      var T = tris[t], bk = 0, bl = -1;
      for (var k = 0; k < 3; k++) { var l = elen(T[k], T[(k + 1) % 3]); if (l > bl) { bl = l; bk = k; } }
      return { k: bk, len: bl };
    }
    function across(t, a, b) {
      var l = edges.get(key(a, b));
      if (!l) return -1;
      for (var i = 0; i < l.length; i++) if (l[i] !== t) return l[i];
      return -1;
    }
    T0.forEach(function (t) { addTri(t[0], t[1], t[2]); });
    var work = [];
    for (var i = 0; i < tris.length; i++) work.push(i);
    var cap = maxTris || 1e9;
    while (work.length) {
      var t0 = work.pop();
      if (!alive[t0] || longest(t0).len <= maxEdge) continue;
      // walk to the end of the chain of longest edges, then split there
      var chain = [t0], cur = t0, nb, L;
      for (;;) {
        L = longest(cur);
        var a = tris[cur][L.k], b = tris[cur][(L.k + 1) % 3];
        nb = across(cur, a, b);
        if (nb < 0) break;
        var Ln = longest(nb), na = tris[nb][Ln.k], nbb = tris[nb][(Ln.k + 1) % 3];
        if ((na === a && nbb === b) || (na === b && nbb === a)) break;
        chain.push(nb); cur = nb;
        if (chain.length > 4000) return { reason: 'the letters would not refine' };
      }
      L = longest(cur);
      var Tc = tris[cur], ia = Tc[L.k], ib = Tc[(L.k + 1) % 3], ic = Tc[(L.k + 2) % 3];
      nb = across(cur, ia, ib);
      var m = V.length;
      V.push([(V[ia][0] + V[ib][0]) / 2, (V[ia][1] + V[ib][1]) / 2]);
      var fresh = [];
      var d = -1;
      if (nb >= 0) { var Tn = tris[nb]; for (var q = 0; q < 3; q++) if (Tn[q] !== ia && Tn[q] !== ib) d = Tn[q]; }
      unreg(cur); alive[cur] = 0; live--;
      fresh.push(addTri(ia, m, ic), addTri(m, ib, ic));
      if (nb >= 0) {
        unreg(nb); alive[nb] = 0; live--;
        fresh.push(addTri(ib, m, d), addTri(m, ia, d));
      }
      if (live > cap) return { reason: 'too many triangles', tooMany: true };
      for (var f = 0; f < fresh.length; f++) work.push(fresh[f]);
      for (var c = chain.length - 1; c >= 0; c--) if (alive[chain[c]]) work.push(chain[c]);
    }
    var T = [];
    for (i = 0; i < tris.length; i++) if (alive[i]) T.push(tris[i]);
    return { V: V, T: T };
  }

  /* The directed edges with no partner: the outline of the triangulation. */
  function outline(V, T) {
    var K = 1 << 26, have = new Map(), out = [];
    T.forEach(function (t) { for (var k = 0; k < 3; k++) have.set(t[k] * K + t[(k + 1) % 3], 1); });
    T.forEach(function (t) {
      for (var k = 0; k < 3; k++) {
        var a = t[k], b = t[(k + 1) % 3];
        if (!have.has(b * K + a)) out.push([a, b]);
      }
    });
    return out;
  }

  /* The text's own triangulation, kept on the shape: base once, refined per edge. */
  function meshFor(sh, maxEdge, maxTris) {
    sh._mesh = sh._mesh || {};
    var base = sh._mesh.base;
    if (!base) {
      base = triangulate(sh);
      sh._mesh.base = base;
    }
    if (base.reason) return base;
    if (!(maxEdge > 0)) return { V: base.V, T: base.T, edge: 0 };
    var edge = maxEdge, tries = 0;
    for (;;) {
      var key = 'e' + edge.toFixed(3), got = sh._mesh[key];
      if (!got) {
        got = refine(base.V, base.T, edge, maxTris);
        if (!got.reason) got.edge = edge;
        sh._mesh[key] = got;
      }
      if (!got.reason) return got;
      if (!got.tooMany || ++tries > 5) return { reason: 'that is too much text for this surface - ' + (got.reason || 'it would not mesh') + '; make it smaller or use fewer letters' };
      edge *= 1.5;
    }
  }

  /* -------------------------------------------------------------- the plan */

  function refuse(reason, extra) {
    var r = { ok: false, reason: reason };
    for (var k in extra || {}) r[k] = extra[k];
    return r;
  }
  function optsOf(opts) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in opts || {}) if (opts[k] !== undefined) o[k] = opts[k];
    return o;
  }
  function badOpts(o) {
    if (!(isFinite(o.depth) && o.depth > 0)) return 'the depth needs a number above 0';
    if (o.depth > o.maxDepth) return 'a depth of ' + fmt(o.depth) + ' mm is more than one stamp makes (' + o.maxDepth + ')';
    if (!isFinite(o.angle)) return 'the angle needs a number';
    if (!(isFinite(o.nozzle) && o.nozzle > 0)) return 'the nozzle width must be above 0';
    if (!(isFinite(o.maxEdge) && o.maxEdge > 0)) return 'the mesh edge must be above 0';
    return null;
  }

  /* Run the stamp on the soup at the click. See the header. */
  function plan(soup, hit, sh, opts) {
    var o = optsOf(opts), bad = badOpts(o);
    if (bad) return refuse(bad);
    if (!Punch || !Punch.surface) return refuse('the surface probe (nso_punch.js) is not loaded');
    if (!sh || !sh.ok || !sh.polys || !sh.polys.length) return refuse((sh && sh.reason) || 'there is no text to stamp');
    var S = Punch.surface(soup, hit, { smoothDeg: o.smoothDeg });
    if (!S.ok) return refuse(S.reason);
    var th = o.angle * Math.PI / 180, cs = Math.cos(th), sn = Math.sin(th);
    var ex = add(mul(S.u, cs), mul(S.v, sn)), ey = add(mul(S.u, -sn), mul(S.v, cs));
    var src = o.mirror ? mirrored(sh) : sh;
    var mesh = meshFor(src, S.flat ? 0 : o.maxEdge, o.maxTris);
    if (mesh.reason) return refuse(mesh.reason);
    var V = mesh.V, T = mesh.T, nV = V.length, i;
    var frame = { o: S.o, n: S.n, u: S.u, v: S.v, ex: ex, ey: ey };

    // the surface under every vertex of the text
    var h = new Float64Array(nV), cosS = new Float64Array(nV), miss = [], feet = new Array(nV), hasH = 0, hSum = 0;
    for (i = 0; i < nV; i++) {
      var p = add(S.o, add(mul(ex, V[i][0]), mul(ey, V[i][1])));
      var ft = S.foot(p);
      if (!ft) { miss.push(i); feet[i] = null; continue; }
      feet[i] = ft;
      h[i] = dot(sub(ft.point, S.o), S.n);
      cosS[i] = Math.max(0.5, dot(ft.normal, S.n));
      hSum += h[i]; hasH++;
    }
    var fill = hasH ? hSum / hasH : 0;
    miss.forEach(function (j) { h[j] = fill; cosS[j] = 1; });
    var hMax = -Infinity, hb = new Float64Array(nV);
    for (i = 0; i < nV; i++) { hb[i] = h[i] - o.depth / cosS[i]; if (h[i] > hMax) hMax = h[i]; }
    var data = { V: V, T: T, hb: hb, ht: hMax + o.lift, o: S.o, n: S.n, ex: ex, ey: ey, edges: null };
    var stats = {
      width: sh.width, height: sh.height, depth: o.depth, tris: T.length, vertices: nV, flat: S.flat, edge: mesh.edge,
      missed: miss.length, stroke: sh.stroke, thin: sh.stroke < o.nozzle, area: sh.area
    };
    var out = { frame: frame, data: data, stats: stats };

    if (miss.length) {
      var pct = Math.round(100 * miss.length / nV);
      return refuse('the text runs off the face: ' + pct + '% of its outline has no surface of the click’s under it. Make it smaller, turn it, or move it' +
        ' (' + fmt(sh.width) + ' × ' + fmt(sh.height) + ' mm)', out);
    }

    // the wall left under it
    var floor = 2 * o.nozzle, stride = Math.max(1, Math.ceil(nV / o.sampleCap)), minRem = Infinity, maxFit = Infinity, thinAt = 0;
    for (i = 0; i < nV; i += stride) {
      var th2 = S.thickness(feet[i].point, S.n);
      if (th2 == null) continue;
      var along = o.depth / cosS[i], rem = th2 - along, fit = (th2 - floor) * cosS[i];
      if (rem < minRem) { minRem = rem; thinAt = th2; }
      if (fit < maxFit) maxFit = fit;
    }
    stats.minWall = isFinite(minRem) ? minRem : null;
    stats.maxDepth = isFinite(maxFit) ? Math.max(0, maxFit) : null;
    if (isFinite(minRem) && minRem < floor - 1e-9) {
      return refuse('the wall under the text is ' + fmt(thinAt) + ' mm at its thinnest; ' + fmt(o.depth) + ' mm deep leaves ' + fmt(Math.max(0, minRem)) +
        ' and the floor is ' + fmt(floor) + ' (two nozzle widths). ' + (maxFit > 0.05 ? 'At most ' + fmt(maxFit) + ' mm deep fits.' : 'There is no depth that fits here.'), out);
    }
    out.ok = true;
    out.reason = fmt(sh.width) + ' × ' + fmt(sh.height) + ' mm, ' + fmt(o.depth) + ' mm deep' +
      (stats.thin ? ' - strokes about ' + fmt(sh.stroke) + ' mm, under a nozzle width, will not print' : '');
    return out;
  }

  /* The cutter: one closed triangle soup, wound outward, in the piece's frame. */
  function cutter(pl) {
    var D = pl && pl.data;
    if (!D) return new Float32Array(0);
    if (!D.edges) D.edges = outline(D.V, D.T);
    var nT = D.T.length, nE = D.edges.length, out = new Float32Array((2 * nT + 2 * nE) * 9), q = 0;
    function at(i, bottom) {
      var w = bottom ? D.hb[i] : D.ht, x = D.V[i][0], y = D.V[i][1];
      return [D.o[0] + D.ex[0] * x + D.ey[0] * y + D.n[0] * w,
              D.o[1] + D.ex[1] * x + D.ey[1] * y + D.n[1] * w,
              D.o[2] + D.ex[2] * x + D.ey[2] * y + D.n[2] * w];
    }
    function tri(A, B, C) {
      out[q++] = A[0]; out[q++] = A[1]; out[q++] = A[2];
      out[q++] = B[0]; out[q++] = B[1]; out[q++] = B[2];
      out[q++] = C[0]; out[q++] = C[1]; out[q++] = C[2];
    }
    D.T.forEach(function (t) {
      tri(at(t[0], false), at(t[1], false), at(t[2], false));
      tri(at(t[0], true), at(t[2], true), at(t[1], true));
    });
    D.edges.forEach(function (e) {
      var Ta = at(e[0], false), Tb = at(e[1], false), Ba = at(e[0], true), Bb = at(e[1], true);
      tri(Ta, Ba, Bb);
      tri(Ta, Bb, Tb);
    });
    return out;
  }

  var API = {
    DEFAULTS: DEFAULTS,
    shape: shape,
    plan: plan,
    cutter: cutter,
    _trace: trace,
    _simplify: simplifyClosed,
    _crossing: crossing,
    _simplifySafe: simplifySafe,
    _triangulate: triangulate,
    _refine: refine,
    _outline: outline,
    _mirrored: mirrored
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Text = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
