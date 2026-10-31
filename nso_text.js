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
    var cx = o.keep ? 0 : (lo[0] + hi[0]) / 2, cy = o.keep ? 0 : (lo[1] + hi[1]) / 2, mm = mask.mmPerPx;   // keep: where the picture put them
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
  function triangulate(sh, tolerant) {                          // tolerant: a rim read off a mesh, whose noise may leave a sliver turned over
    var V = [], T = [];
    for (var i = 0; i < sh.polys.length; i++) {
      var P = sh.polys[i], tr = triangulatePoly(V, P);
      if (!tr) return { reason: 'the letters could not be triangulated (a hole with no way out)' };
      var want = area2(P.outer), got = 0;
      P.holes.forEach(function (H) { want += area2(H); });
      want = Math.abs(want);
      tr.forEach(function (t) { got += triArea2(V, t); });
      if (!(Math.abs(got - want) <= (tolerant ? 1e-3 : 1e-6) * Math.max(1, want) + 1e-9)) {
        return { reason: 'the letters could not be triangulated cleanly (area ' + fmt2(got / 2) + ' mm² against ' + fmt2(want / 2) + ')' };
      }
      for (var j = 0; j < tr.length; j++) {
        if (!(triArea2(V, tr[j]) > (tolerant ? -1e-4 : 0))) return { reason: 'the letters could not be triangulated cleanly (a flat or turned triangle)' };
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


  /* ------------------------------------------------------------- removing */

  /* REMOVE. The text this tool stamps is a set of recesses: each letter a FLOOR,
     ringed by WALLS that run straight up (along one axis n0) to a RIM on the face.
     pockets() finds them from a click on one, with no memory of the stamp - so it
     works on a piece stamped last week, after other edits, or on any other tool's
     recess - and fill() takes them out by surgery on the mesh, not a boolean: the
     floor and wall triangles are dropped and a cap is laid over the rim loop, its
     boundary the rim's own vertices, so nothing is left to be coincident with
     anything and the piece stays as watertight as it was (a mesh that is already
     overlapping or open elsewhere is not asked to be a solid first).

     A recess in a FLAT face has a floor in one plane (within a degree, 0.01 mm) and
     a rim in one plane above it (0.02 mm); the cap is the flat polygon of the rim.
     A recess in a CURVED face has a floor that is a smooth patch (neighbouring
     facets within 25 degrees), n0 found from its walls' own normals (the direction
     every wall contains), and walls that rise above the floor edge they stand on.
     Each floor vertex on the patch's edge has a wall straight above it, and the rim
     segment that crosses its line is on the original surface, so the height of the
     face above that vertex is known; the rest are Laplace's equation on the floor's
     own mesh. The floor lifted by those heights is the surface the recess was cut
     from (a stamp's floor is that surface offset down, so it kept the curve), and
     the cap is the rim polygon cut into 1 mm triangles, its inside vertices put on
     that lifted floor.

     From the click: a triangle on a floor (or a wall: the nearest 40 within 3 mm
     are tried) seeds it. opts.word fills every recess of the same axis and depth
     within opts.reach mm of one already chosen (single linkage), so a word goes in
     one click; otherwise only the one clicked. */
  var weldCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function weld(soup) {
    var hit = weldCache && weldCache.get(soup);
    if (hit && hit.len === soup.length) return hit;
    var n = (soup.length / 9) | 0, vid = new Int32Array(3 * n), ids = new Map(), nV = 0, i, t, k;
    var P = [];
    for (i = 0; i < 3 * n; i++) {
      var key = Math.round(soup[3 * i] * 1e4) + ',' + Math.round(soup[3 * i + 1] * 1e4) + ',' + Math.round(soup[3 * i + 2] * 1e4);
      var id = ids.get(key);
      if (id === undefined) { id = nV++; ids.set(key, id); P.push([soup[3 * i], soup[3 * i + 1], soup[3 * i + 2]]); }
      vid[i] = id;
    }
    var nrm = new Float64Array(3 * n), area = new Float64Array(n), edges = new Map(), K = 1 << 26;
    for (t = 0; t < n; t++) {
      var a = P[vid[3 * t]], b = P[vid[3 * t + 1]], c = P[vid[3 * t + 2]];
      var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, L = Math.hypot(nx, ny, nz) || 1;
      nrm[3 * t] = nx / L; nrm[3 * t + 1] = ny / L; nrm[3 * t + 2] = nz / L;
      area[t] = L / 2;
      for (k = 0; k < 3; k++) {
        var e0 = vid[3 * t + k], e1 = vid[3 * t + (k + 1) % 3];
        if (e0 === e1) continue;
        var ek = e0 < e1 ? e0 * K + e1 : e1 * K + e0, l = edges.get(ek);
        if (l) l.push(t); else edges.set(ek, [t]);
      }
    }
    var M = { n: n, vid: vid, P: P, nrm: nrm, area: area, edges: edges, K: K, soup: soup, len: soup.length };
    if (weldCache) weldCache.set(soup, M);
    return M;
  }
  function across(M, t, k) {                                 // the triangle over t's edge k, or -1
    var e0 = M.vid[3 * t + k], e1 = M.vid[3 * t + (k + 1) % 3], l = M.edges.get(e0 < e1 ? e0 * M.K + e1 : e1 * M.K + e0);
    if (!l) return -1;
    for (var i = 0; i < l.length; i++) if (l[i] !== t) return l[i];
    return -1;
  }
  function frameFor(n) {
    var e1 = Math.abs(n[0]) < 0.9 ? [0, -n[2], n[1]] : [-n[2], 0, n[0]], L = Math.hypot(e1[0], e1[1], e1[2]);
    e1 = [e1[0] / L, e1[1] / L, e1[2] / L];
    return { n: n, e1: e1, e2: [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]] };
  }
  /* Directed rim edges -> loops of vertex ids, or null when a chain does not close. A vertex the rim
     touches twice (two lobes meeting at a point) goes on by the sharpest left turn in the plane of
     the face, which keeps each lobe a loop of its own. */
  function loopsOf(rim, M, n0) {
    var F = frameFor(n0), out = new Map(), i, used = new Set(), K = 1 << 26;
    function xy(v) { var p = M.P[v]; return [p[0] * F.e1[0] + p[1] * F.e1[1] + p[2] * F.e1[2], p[0] * F.e2[0] + p[1] * F.e2[1] + p[2] * F.e2[2]]; }
    for (i = 0; i < rim.length; i++) {
      var l = out.get(rim[i][0]);
      if (l) l.push(rim[i][1]); else out.set(rim[i][0], [rim[i][1]]);
    }
    var loops = [];
    for (i = 0; i < rim.length; i++) {
      var a0 = rim[i][0], b0 = rim[i][1];
      if (used.has(a0 * K + b0)) continue;
      var loop = [a0], a = a0, b = b0, guard = 0;
      for (;;) {
        used.add(a * K + b);
        if (b === a0) {
          // closed when no unused edge leaves the start vertex's loop back into it: this loop is done
          break;
        }
        loop.push(b);
        var cands = (out.get(b) || []).filter(function (c) { return !used.has(b * K + c); });
        if (!cands.length) return null;
        var pa = xy(a), pb = xy(b), din = [pb[0] - pa[0], pb[1] - pa[1]], best = cands[0], bt = -Infinity;
        if (cands.length > 1) {
          cands.forEach(function (c) {
            var pc = xy(c), dout = [pc[0] - pb[0], pc[1] - pb[1]];
            var tau = Math.atan2(din[0] * dout[1] - din[1] * dout[0], din[0] * dout[0] + din[1] * dout[1]);
            if (tau > bt) { bt = tau; best = c; }
          });
        }
        a = b; b = best;
        if (++guard > rim.length + 5) return null;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops.length ? loops : null;
  }

  /* A recess in a flat face, from a triangle on its floor. */
  function pocketFlat(M, seed) {
    var n0 = [M.nrm[3 * seed], M.nrm[3 * seed + 1], M.nrm[3 * seed + 2]], o = M.P[M.vid[3 * seed]], tol = 0.01, cosF = Math.cos(Math.PI / 180);
    function ht(v) { var p = M.P[v]; return (p[0] - o[0]) * n0[0] + (p[1] - o[1]) * n0[1] + (p[2] - o[2]) * n0[2]; }
    function nd(t) { return M.nrm[3 * t] * n0[0] + M.nrm[3 * t + 1] * n0[1] + M.nrm[3 * t + 2] * n0[2]; }
    function flat(t) { return nd(t) >= cosF && Math.abs(ht(M.vid[3 * t])) < tol && Math.abs(ht(M.vid[3 * t + 1])) < tol && Math.abs(ht(M.vid[3 * t + 2])) < tol; }
    var floor = new Set([seed]), q = [seed], t, k, u, i;
    while (q.length) {
      t = q.pop();
      for (k = 0; k < 3; k++) { u = across(M, t, k); if (u >= 0 && !floor.has(u) && flat(u)) { floor.add(u); q.push(u); } }
    }
    var wall = new Set(), wq = [];
    function wallOf(u, from) {                              // a triangle square to the floor, rising above it
      if (u < 0 || floor.has(u) || wall.has(u) || Math.abs(nd(u)) > 0.2) return false;
      var top = false;
      for (var j = 0; j < 3; j++) if (ht(M.vid[3 * u + j]) > 0.02) top = true;
      if (!top && !from) return false;
      wall.add(u); wq.push(u);
      return true;
    }
    floor.forEach(function (f) { for (var j = 0; j < 3; j++) { var w = across(M, f, j); if (w >= 0 && !floor.has(w)) wallOf(w, false); } });
    if (!wall.size) return null;
    while (wq.length) {
      t = wq.pop();
      for (k = 0; k < 3; k++) { u = across(M, t, k); if (u >= 0 && !floor.has(u)) wallOf(u, true); }
      if (wall.size > 200000) return null;
    }
    var inP = function (x) { return floor.has(x) || wall.has(x); }, rim = [], rimTris = [], deg = true;
    function visit(tt) {
      for (var j = 0; j < 3; j++) {
        var nb = across(M, tt, j);
        if (nb >= 0 && inP(nb)) continue;
        if (nb < 0) { deg = false; continue; }              // an open edge: not a recess
        rim.push([M.vid[3 * tt + j], M.vid[3 * tt + (j + 1) % 3]]); rimTris.push(nb);
      }
    }
    floor.forEach(visit); wall.forEach(visit);
    if (!deg || !rim.length) return null;
    for (i = 0; i < rimTris.length; i++) if (nd(rimTris[i]) < 0.9) return null;   // a step, not the face
    var loops = loopsOf(rim, M, n0);
    if (!loops) return null;
    var lo = Infinity, hi = -Infinity;
    loops.forEach(function (l) { l.forEach(function (v) { var h = ht(v); lo = Math.min(lo, h); hi = Math.max(hi, h); }); });
    if (hi - lo > 0.02 || lo < 0.02) return null;
    return { curved: false, floor: floor, wall: wall, loops: loops, n0: n0, H: (lo + hi) / 2 };
  }

  function minEigen3(C) {                                    // the eigenvector of the smallest eigenvalue, C symmetric 3x3
    var a = [[C[0], C[1], C[2]], [C[1], C[3], C[4]], [C[2], C[4], C[5]]], v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var sweep = 0; sweep < 40; sweep++) {
      var off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
      if (off < 1e-14) break;
      for (var p = 0; p < 2; p++) for (var q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        var th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), sn = t * c, k;
        for (k = 0; k < 3; k++) { var akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - sn * akq; a[k][q] = sn * akp + c * akq; }
        for (k = 0; k < 3; k++) { var apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - sn * aqk; a[q][k] = sn * apk + c * aqk; }
        for (k = 0; k < 3; k++) { var vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - sn * vkq; v[k][q] = sn * vkp + c * vkq; }
      }
    }
    var best = 0;
    for (var i = 1; i < 3; i++) if (a[i][i] < a[best][best]) best = i;
    return [v[0][best], v[1][best], v[2][best]];
  }
  /* A recess in a curved face, from a triangle on its floor (see the header). */
  function pocketCurved(M, seed) {
    var cosS = Math.cos(25 * Math.PI / 180), cap = 8000, i, j, k, t, u;
    function nrm(x) { return [M.nrm[3 * x], M.nrm[3 * x + 1], M.nrm[3 * x + 2]]; }
    function sliver(x) { return M.area[x] < 2e-6; }          // a boolean's splinters: their normals mean nothing
    function d3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
    var floor = new Set([seed]), q = [seed], refN = new Map(), ax = nrm(seed);
    refN.set(seed, ax);
    function hzs(v) { var Pt = M.P[v]; return Pt[0] * ax[0] + Pt[1] * ax[1] + Pt[2] * ax[2]; }
    while (q.length) {
      t = q.pop();
      var tn = refN.get(t);
      for (k = 0; k < 3; k++) {
        u = across(M, t, k);
        if (u < 0 || floor.has(u)) continue;
        if (!sliver(u)) {
          if (d3(tn, nrm(u)) >= cosS) { floor.add(u); refN.set(u, nrm(u)); q.push(u); }
        } else {                                              // a splinter lying in the floor (its far corner level with the edge it hangs from) belongs to it
          var ea = hzs(M.vid[3 * t + k]), eb = hzs(M.vid[3 * t + (k + 1) % 3]), third = -1;
          for (var c3 = 0; c3 < 3; c3++) { var vv = M.vid[3 * u + c3]; if (vv !== M.vid[3 * t + k] && vv !== M.vid[3 * t + (k + 1) % 3]) third = vv; }
          if (third >= 0 && Math.abs(hzs(third) - (ea + eb) / 2) < 0.05) { floor.add(u); refN.set(u, tn); q.push(u); }
        }
        if (floor.size > cap) return null;
      }
    }
    var side = new Set(), fn = [0, 0, 0];
    floor.forEach(function (f) {
      var n = nrm(f);
      fn[0] += n[0]; fn[1] += n[1]; fn[2] += n[2];
      for (var e = 0; e < 3; e++) { var w = across(M, f, e); if (w < 0) { side.add(-1); continue; } if (!floor.has(w)) side.add(w); }
    });
    if (side.has(-1) || !side.size) return null;
    var C = [0, 0, 0, 0, 0, 0];
    side.forEach(function (w) {
      if (sliver(w)) return;
      var n = nrm(w);
      C[0] += n[0] * n[0]; C[1] += n[0] * n[1]; C[2] += n[0] * n[2]; C[3] += n[1] * n[1]; C[4] += n[1] * n[2]; C[5] += n[2] * n[2];
    });
    var n0 = minEigen3(C), Lf = Math.hypot(fn[0], fn[1], fn[2]) || 1;
    if (d3(n0, fn) < 0) n0 = [-n0[0], -n0[1], -n0[2]];
    if (d3(n0, fn) / Lf < 0.5) return null;                  // the floor does not face along the walls' axis
    function hz(v) { var P = M.P[v]; return P[0] * n0[0] + P[1] * n0[1] + P[2] * n0[2]; }
    var bad = false;
    var sideA = 0, sideBad = 0;                              // walls are square to n0, by area: a corner triangle or two may lean
    side.forEach(function (w) { if (sliver(w)) return; sideA += M.area[w]; if (Math.abs(d3(nrm(w), n0)) > 0.35) sideBad += M.area[w]; });
    if (sideBad > 0.15 * sideA) bad = true;
    if (bad) return null;
    var vf = new Set();
    floor.forEach(function (f) { for (var e = 0; e < 3; e++) vf.add(M.vid[3 * f + e]); });
    var wall = new Set(), wq = [], flatA = 0;
    side.forEach(function (w) {                              // walls rise above the floor edge they stand on: a recess, not a boss (by area)
      if (sliver(w)) { wall.add(w); wq.push(w); return; }
      var top = -Infinity, lo = Infinity, cnt = 0;
      for (var e = 0; e < 3; e++) { var v = M.vid[3 * w + e]; if (vf.has(v)) { lo = Math.min(lo, hz(v)); cnt++; } else top = Math.max(top, hz(v)); }
      if (cnt !== 2 || !(top > lo + 0.02)) flatA += M.area[w];
      wall.add(w); wq.push(w);
    });
    if (flatA > 0.15 * sideA) return null;
    while (wq.length) {
      t = wq.pop();
      for (k = 0; k < 3; k++) {
        u = across(M, t, k);
        if (u < 0) return null;
        if (floor.has(u) || wall.has(u)) continue;
        if (sliver(u) || Math.abs(d3(nrm(u), n0)) <= 0.2) { wall.add(u); wq.push(u); if (wall.size > cap) return null; }
      }
    }
    // A floor can come in pieces: small tilted triangles at a corner of the outline (a boolean's bevel)
    // stop the smooth flood, and the far part of the letter is left as a floor-like patch standing at the
    // foot of walls already taken. What lies at the foot of a wall and is shut in by the recess on every
    // side (the triangles round it, bevels and all, are the island) is part of the floor; the face itself
    // is not shut in, and a counter inside a letter stands at the top of its walls, not their foot.
    function inPk(x) { return wall.has(x) || floor.has(x); }
    var fLo = Infinity, fHi = -Infinity;
    floor.forEach(function (f) { for (var e = 0; e < 3; e++) { var hh = hz(M.vid[3 * f + e]); fLo = Math.min(fLo, hh); fHi = Math.max(fHi, hh); } });
    fLo -= 0.6; fHi += 0.6;
    function inBand(x) { for (var e = 0; e < 3; e++) { var hh = hz(M.vid[3 * x + e]); if (hh < fLo || hh > fHi) return false; } return true; }
    for (var absorbRound = 0; absorbRound < 6; absorbRound++) {
      var taken = false, tried = new Set(), patchCap = 3 * floor.size + 50;   // a piece of the letter is not bigger than the letter
      wall.forEach(function (w) {
        if (sliver(w)) return;
        for (var e = 0; e < 3; e++) {
          var nb = across(M, w, e);
          if (nb < 0 || inPk(nb) || tried.has(nb) || sliver(nb) || d3(nrm(nb), n0) < 0.9 || !inBand(nb)) continue;
          var ea = M.vid[3 * w + e], eb = M.vid[3 * w + (e + 1) % 3], third = -1;
          for (var c3 = 0; c3 < 3; c3++) { var vv = M.vid[3 * w + c3]; if (vv !== ea && vv !== eb) third = vv; }
          if (!(third >= 0 && hz(third) > Math.max(hz(ea), hz(eb)) + 0.1)) continue;      // at the foot of the wall
          var patch = new Set([nb]), pq = [nb], enclosed = true;
          while (pq.length && enclosed) {
            var tp = pq.pop(), tnp = nrm(tp);
            for (var kk = 0; kk < 3; kk++) {
              var up = across(M, tp, kk);
              if (up < 0) { enclosed = false; break; }
              if (patch.has(up) || inPk(up)) continue;
              patch.add(up); pq.push(up);
              if (patch.size > patchCap) { enclosed = false; break; }
            }
          }
          patch.forEach(function (x) { tried.add(x); });
          if (enclosed) { patch.forEach(function (x) { floor.add(x); }); taken = true; }
        }
      });
      if (!taken) break;
    }
    // the rim: what the walls open onto is the face (by area: splinters do not vote). Loops of no
    // area - a splinter island inside the recess, a splinter lobe hanging off it - are absorbed
    // (the island dropped with it, the lobe left out of it), so the cap is never asked to cover nothing.
    var rim, owner, loops, ok = true, F0 = frameFor(n0), pass;
    function inP(x) { return wall.has(x) || floor.has(x); }
    function area2d(l) {
      var sum = 0;
      for (var z = 0; z < l.length; z++) {
        var p1 = M.P[l[z]], p2 = M.P[l[(z + 1) % l.length]];
        var x1 = p1[0] * F0.e1[0] + p1[1] * F0.e1[1] + p1[2] * F0.e1[2], y1 = p1[0] * F0.e2[0] + p1[1] * F0.e2[1] + p1[2] * F0.e2[2];
        var x2 = p2[0] * F0.e1[0] + p2[1] * F0.e1[1] + p2[2] * F0.e1[2], y2 = p2[0] * F0.e2[0] + p2[1] * F0.e2[1] + p2[2] * F0.e2[2];
        sum += x1 * y2 - x2 * y1;
      }
      return sum / 2;
    }
    for (pass = 0; pass < 6; pass++) {
      rim = []; owner = new Map(); var rimArea = 0, rimBad = 0, K3 = 1 << 26;
      var scan = function (w) {
        for (var e = 0; e < 3; e++) {
          var nb = across(M, w, e);
          if (nb < 0) { ok = false; continue; }
          if (inP(nb)) continue;
          if (!sliver(nb)) { rimArea += M.area[nb]; if (d3(nrm(nb), n0) < 0.3) rimBad += M.area[nb]; }
          var ea = M.vid[3 * w + e], eb = M.vid[3 * w + (e + 1) % 3];
          rim.push([ea, eb]); owner.set(ea * K3 + eb, [w, e]);
        }
      };
      wall.forEach(scan); floor.forEach(scan);
      if (!ok || !rim.length || rimBad > 0.1 * rimArea) return null;
      loops = loopsOf(rim, M, n0);
      if (!loops) return null;
      // a zero-width spike (the loop goes out along a line and straight back) is a splinter pair: take the
      // splinters it is made of into the recess and read the rim again
      var spiky = 0;
      loops.forEach(function (l) {
        for (var z = 0; z < l.length; z++) {
          var A1 = M.P[l[(z + l.length - 1) % l.length]], B1 = M.P[l[z]], C1 = M.P[l[(z + 1) % l.length]];
          var ux = B1[0] - A1[0], uy = B1[1] - A1[1], uz = B1[2] - A1[2], vx = C1[0] - B1[0], vy = C1[1] - B1[1], vz = C1[2] - B1[2];
          var du = ux * n0[0] + uy * n0[1] + uz * n0[2], dv = vx * n0[0] + vy * n0[1] + vz * n0[2];
          var tu = [ux - du * n0[0], uy - du * n0[1], uz - du * n0[2]], tv = [vx - dv * n0[0], vy - dv * n0[1], vz - dv * n0[2]];
          var lu = Math.hypot(tu[0], tu[1], tu[2]), lv = Math.hypot(tv[0], tv[1], tv[2]);
          if (lu < 1e-9 || lv < 1e-9) continue;
          var cs = (tu[0] * tv[0] + tu[1] * tv[1] + tu[2] * tv[2]) / (lu * lv);
          if (cs < -0.9999) {                                   // turns straight back
            for (var side2 = 0; side2 < 2; side2++) {
              var ow2 = owner.get((side2 ? l[z] : l[(z + l.length - 1) % l.length]) * K3 + (side2 ? l[(z + 1) % l.length] : l[z]));
              if (!ow2) continue;
              var nb3 = across(M, ow2[0], ow2[1]);
              if (nb3 >= 0 && !inP(nb3) && sliver(nb3)) { wall.add(nb3); spiky++; }
            }
          }
        }
      });
      var tiny = loops.filter(function (l) { return Math.abs(area2d(l)) < 1e-3; });
      if (!tiny.length && !spiky) break;
      if (!tiny.length) continue;
      tiny.forEach(function (l) {                             // the sign of a loop this small means nothing: try it as an island, else as a lobe
        var island = [], seenI = new Set(), qi = [], z;
        for (z = 0; z < l.length; z++) {
          var ow = owner.get(l[z] * K3 + l[(z + 1) % l.length]);
          if (!ow) continue;
          var nb2 = across(M, ow[0], ow[1]);
          if (nb2 >= 0 && !inP(nb2) && !seenI.has(nb2)) { seenI.add(nb2); qi.push(nb2); }
        }
        while (qi.length && island.length < 200) {
          var tI = qi.pop();
          island.push(tI);
          for (var e2 = 0; e2 < 3; e2++) { var u2 = across(M, tI, e2); if (u2 >= 0 && !inP(u2) && !seenI.has(u2)) { seenI.add(u2); qi.push(u2); } }
        }
        if (island.length < 200 && island.length) { island.forEach(function (x) { wall.add(x); }); return; }
        var lobe = new Set(), ql = [];
        for (z = 0; z < l.length; z++) { var o2 = owner.get(l[z] * K3 + l[(z + 1) % l.length]); if (o2 && !lobe.has(o2[0])) { lobe.add(o2[0]); ql.push(o2[0]); } }
        while (ql.length && lobe.size < 200) {
          var tL = ql.pop();
          for (var e3 = 0; e3 < 3; e3++) { var u3 = across(M, tL, e3); if (u3 >= 0 && inP(u3) && !lobe.has(u3)) { lobe.add(u3); ql.push(u3); } }
        }
        if (lobe.size >= 200) { ok = false; return; }
        lobe.forEach(function (x) { wall.delete(x); floor.delete(x); });
      });
      if (!ok) return null;
      if (pass === 5) return null;
    }
    if (!loops || !floor.size) return null;
    // the floor's own mesh, compact
    var idx = new Map(), P = [], T3 = [];
    function vi(v) { var x = idx.get(v); if (x === undefined) { x = P.length; idx.set(v, x); P.push(M.P[v]); } return x; }
    floor.forEach(function (f) { T3.push([vi(M.vid[3 * f]), vi(M.vid[3 * f + 1]), vi(M.vid[3 * f + 2])]); });
    var inv = [];
    idx.forEach(function (c, v) { inv[c] = v; });
    var have = new Map(), K = 1 << 26, onB = new Set();
    T3.forEach(function (tr) { for (var e = 0; e < 3; e++) have.set(tr[e] * K + tr[(e + 1) % 3], 1); });
    T3.forEach(function (tr) { for (var e = 0; e < 3; e++) { var a = tr[e], b = tr[(e + 1) % 3]; if (!have.has(b * K + a)) { onB.add(a); onB.add(b); } } });
    // the height of the face above each vertex on the patch's edge: the wall stands straight up
    // from it, so the rim segment that crosses its line gives the height there
    var h = new Float64Array(P.length), fixed = new Uint8Array(P.length), failed = false, loose = 0;
    function tan(Pt) { var d = Pt[0] * n0[0] + Pt[1] * n0[1] + Pt[2] * n0[2]; return [Pt[0] - d * n0[0], Pt[1] - d * n0[1], Pt[2] - d * n0[2]]; }
    var segs = rim.map(function (r) {
      var A = M.P[r[0]], B = M.P[r[1]];
      return { a: tan(A), b: tan(B), ha: A[0] * n0[0] + A[1] * n0[1] + A[2] * n0[2], hb: B[0] * n0[0] + B[1] * n0[1] + B[2] * n0[2] };
    });
    onB.forEach(function (a) {
      var A = P[a], At = tan(A), hA = A[0] * n0[0] + A[1] * n0[1] + A[2] * n0[2], bh = 0;
      for (var g = 0; g < segs.length; g++) {                 // the highest point of any rim segment standing over this vertex
        var S = segs[g], dx = S.b[0] - S.a[0], dy = S.b[1] - S.a[1], dz = S.b[2] - S.a[2], L2 = dx * dx + dy * dy + dz * dz, dist, hh;
        if (L2 < 1e-12) { dist = Math.hypot(At[0] - S.a[0], At[1] - S.a[1], At[2] - S.a[2]); hh = Math.max(S.ha, S.hb); }
        else {
          var tt = Math.max(0, Math.min(1, ((At[0] - S.a[0]) * dx + (At[1] - S.a[1]) * dy + (At[2] - S.a[2]) * dz) / L2));
          dist = Math.hypot(At[0] - S.a[0] - tt * dx, At[1] - S.a[1] - tt * dy, At[2] - S.a[2] - tt * dz);
          hh = S.ha + tt * (S.hb - S.ha);
        }
        if (dist < 0.03 && hh - hA > bh) bh = hh - hA;
      }
      if (!(bh > 0.02)) { loose++; return; }                // no rim over it: a fin inside the letter, whose ridge is not the face - left to the interpolation
      h[a] = bh; fixed[a] = 1;
    });
    if (loose > 0.25 * onB.size || loose === onB.size) failed = true;
    if (failed) return null;
    var nbr = P.map(function () { return []; });             // Laplace on the floor's graph
    T3.forEach(function (tr) { for (var e = 0; e < 3; e++) { var a = tr[e], b = tr[(e + 1) % 3]; nbr[a].push(b); nbr[b].push(a); } });
    var mean = 0, cntB = 0;
    for (i = 0; i < P.length; i++) if (fixed[i]) { mean += h[i]; cntB++; }
    mean /= cntB || 1;
    for (i = 0; i < P.length; i++) if (!fixed[i]) h[i] = mean;
    for (var it = 0; it < 4000; it++) {
      var move = 0;
      for (i = 0; i < P.length; i++) {
        if (fixed[i] || !nbr[i].length) continue;
        var sum = 0;
        for (j = 0; j < nbr[i].length; j++) sum += h[nbr[i][j]];
        var nv = sum / nbr[i].length;
        move = Math.max(move, Math.abs(nv - h[i]));
        h[i] = nv;
      }
      if (move < 1e-7) break;
    }
    var hmin = Infinity, hmax = -Infinity;
    for (i = 0; i < P.length; i++) { hmin = Math.min(hmin, h[i]); hmax = Math.max(hmax, h[i]); }
    if (hmin < 0.02 || hmax > 50) return null;
    return { curved: true, floor: floor, wall: wall, loops: loops, n0: n0, H: mean, lift: { P: P, T: T3, h: h, ids: inv } };
  }

  /* The cap over one recess's rim: { tris: [[a, b, c] of 3D points] } or { reason }. */
  function capOf(M, E) {
    var F = frameFor(E.n0), org = E.curved ? E.lift.P[0] : M.P[E.loops[0][0]], i, j;
    function to2(p) {
      var w = [p[0] - org[0], p[1] - org[1], p[2] - org[2]];
      return [w[0] * F.e1[0] + w[1] * F.e1[1] + w[2] * F.e1[2], w[0] * F.e2[0] + w[1] * F.e2[1] + w[2] * F.e2[2]];
    }
    var rings = E.loops.map(function (l) { return { ids: l, pts: l.map(function (v) { return to2(M.P[v]); }) }; });
    var outers = rings.filter(function (r) { return area2(r.pts) > 0; }), holes = rings.filter(function (r) { return area2(r.pts) < 0; });
    if (!outers.length) return { reason: 'that recess has no outline to cap' };
    var polys = outers.map(function (r) { return { outer: r.pts, holes: [], ids: r.ids.slice(), a2: area2(r.pts) }; });
    holes.forEach(function (h) {
      var best = null;
      polys.forEach(function (P) { if (inside(P.outer, h.pts[0]) && (!best || P.a2 < best.a2)) best = P; });
      if (!best) return;
      best.holes.push(h.pts); best.ids = best.ids.concat(h.ids);
    });
    var ids = [];
    polys.forEach(function (P) { ids = ids.concat(P.ids); });
    var tri = triangulate({ polys: polys.map(function (P) { return { outer: P.outer, holes: P.holes }; }) }, !!E.curved);
    if (!tri.V) return { reason: 'the rim of that recess could not be capped (' + tri.reason + ')' };
    var V = tri.V, T = tri.T, nRing = ids.length;
    if (V.length !== nRing) return { reason: 'the rim of that recess could not be capped' };
    var P3 = ids.map(function (v) { return M.P[v]; });
    if (E.curved) {
      // the triangles of the rim polygon are chords of a curved face; an edge across the inside is split
      // where the lifted floor stands more than 0.01 mm off its chord, the new corner put on the floor
      var L = E.lift, F2 = L.P.map(to2), sh = L.P.map(function (p, k) { return (p[0] - org[0]) * F.n[0] + (p[1] - org[1]) * F.n[1] + (p[2] - org[2]) * F.n[2] + L.h[k]; });
      var at = function (x, y) {                               // the lifted floor's height at (x, y): inside a triangle, else the nearest one's, if within 0.05 mm
        var bestK = -1, bestOut = Infinity, bu = 0, bv = 0, bw = 0;
        for (var k = 0; k < L.T.length; k++) {
          var t = L.T[k], a = F2[t[0]], b = F2[t[1]], c = F2[t[2]];
          var d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
          if (Math.abs(d) < 1e-14) continue;
          var u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d, v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d, w = 1 - u - v;
          var out = Math.max(0, -u, -v, -w);
          if (out < bestOut) { bestOut = out; bestK = k; bu = u; bv = v; bw = w; if (out === 0) break; }
        }
        if (bestK < 0 || bestOut > 0.05) return null;
        var tt = L.T[bestK];
        return bu * sh[tt[0]] + bv * sh[tt[1]] + bw * sh[tt[2]];
      };
      var sArr = P3.map(function (p) { return (p[0] - org[0]) * F.n[0] + (p[1] - org[1]) * F.n[1] + (p[2] - org[2]) * F.n[2]; });
      var cell = 0.05, hash = new Map();                         // no two corners within 0.03 mm: a fan of cuts toward one corner makes slivers
      function hkey(x, y) { return Math.floor(x / cell) + ',' + Math.floor(y / cell); }
      function hadd(i) { var k = hkey(V[i][0], V[i][1]), l = hash.get(k); if (l) l.push(i); else hash.set(k, [i]); }
      function crowded(x, y) {
        var cx = Math.floor(x / cell), cy = Math.floor(y / cell);
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
          var l = hash.get((cx + dx) + ',' + (cy + dy));
          if (l) for (var q = 0; q < l.length; q++) if (Math.hypot(V[l[q]][0] - x, V[l[q]][1] - y) < 0.03) return true;
        }
        return false;
      }
      for (i = 0; i < V.length; i++) hadd(i);
      var rf = refineInterior(V, T, function (a, b, m) {
        if (Math.hypot(V[a][0] - V[b][0], V[a][1] - V[b][1]) < 0.4 || crowded(m[0], m[1])) return false;
        var s = at(m[0], m[1]), sa = at(V[a][0], V[a][1]), sb = at(V[b][0], V[b][1]);   // the floor's own curve, not the rim's few-micron mismatch with it
        return s !== null && sa !== null && sb !== null && Math.abs(s - (sa + sb) / 2) > 0.01;
      }, function (m, a, b, mid) {
        var s = at(mid[0], mid[1]);
        hadd(m);
        if (s === null) s = (sArr[a] + sArr[b]) / 2;
        sArr[m] = s;
        P3[m] = [org[0] + F.e1[0] * mid[0] + F.e2[0] * mid[1] + F.n[0] * s, org[1] + F.e1[1] * mid[0] + F.e2[1] * mid[1] + F.n[1] * s,
                 org[2] + F.e1[2] * mid[0] + F.e2[2] * mid[1] + F.n[2] * s];
      }, V);
      T = rf;
    }
    return { tris: T.map(function (t) { return [P3[t[0]], P3[t[1]], P3[t[2]]]; }) };
  }
  /* Split the interior edges that want(a, b, midpoint) says to (the outline is not touched), in
     passes; made(m, a, b, midpoint) hears of each new corner. V is grown in place. -> triangles */
  function refineInterior(V, T0, want, made) {
    var T = T0.map(function (t) { return t.slice(); }), K = 1 << 26, pass;
    for (pass = 0; pass < 14; pass++) {
      var edges = new Map(), k, e;
      for (k = 0; k < T.length; k++) for (e = 0; e < 3; e++) {
        var a = T[k][e], b = T[k][(e + 1) % 3], key = a < b ? a * K + b : b * K + a, l = edges.get(key);
        if (l) l.push(k); else edges.set(key, [k]);
      }
      var taken = new Uint8Array(T.length), next = [], did = false;
      for (k = 0; k < T.length && T.length + next.length < 20000; k++) {
        if (taken[k]) continue;
        for (e = 0; e < 3; e++) {
          var a2 = T[k][e], b2 = T[k][(e + 1) % 3], l2 = edges.get(a2 < b2 ? a2 * K + b2 : b2 * K + a2);
          if (l2.length !== 2) continue;
          var other = l2[0] === k ? l2[1] : l2[0];
          if (taken[other]) continue;
          var mid = [(V[a2][0] + V[b2][0]) / 2, (V[a2][1] + V[b2][1]) / 2];
          if (!want(a2, b2, mid)) continue;
          var ic = T[k][(e + 2) % 3], Tn = T[other], id = -1;
          for (var q = 0; q < 3; q++) if (Tn[q] !== a2 && Tn[q] !== b2) id = Tn[q];
          var m = V.length;
          V.push(mid);
          made(m, a2, b2, mid);
          taken[k] = 1; taken[other] = 1; did = true;
          next.push([a2, m, ic], [m, b2, ic], [b2, m, id], [m, a2, id]);
          break;
        }
      }
      if (!did) break;
      var keep = [];
      for (k = 0; k < T.length; k++) if (!taken[k]) keep.push(T[k]);
      T = keep.concat(next);
    }
    return T;
  }

  /* The recesses under a click. -> { ok, reason, pockets, count, depth, width, height } */
  function pockets(soup, hit, opts) {
    var o = { word: (opts || {}).word, reach: (opts || {}).reach };
    if (o.word === undefined) o.word = true;
    if (!(o.reach >= 0)) o.reach = 3;
    if (!soup || soup.length < 36 || soup.length % 9) return refuse('there is no piece to take text off');
    var p0 = hit && (hit.point || hit.p || hit);
    if (!p0 || !(p0.length >= 3 || p0.x !== undefined)) return refuse('the click has no point on the piece');
    p0 = p0.length >= 3 ? [+p0[0], +p0[1], +p0[2]] : [+p0.x, +p0.y, +p0.z];
    var M = weld(soup), i, t, near = [];
    for (t = 0; t < M.n; t++) {
      var a = M.P[M.vid[3 * t]], b = M.P[M.vid[3 * t + 1]], c = M.P[M.vid[3 * t + 2]];
      var d = Math.hypot((a[0] + b[0] + c[0]) / 3 - p0[0], (a[1] + b[1] + c[1]) / 3 - p0[1], (a[2] + b[2] + c[2]) / 3 - p0[2]);
      if (d < 3) near.push([d, t]);
    }
    near.sort(function (x, y) { return x[0] - y[0]; });
    // a click from the side lands on a wall or the face as often as on the floor: try first the
    // triangles that stand at the foot of a wall (a neighbour square to them that rises above their edge)
    function footing(t0) {
      if (M.area[t0] < 2e-6) return false;
      var nt = [M.nrm[3 * t0], M.nrm[3 * t0 + 1], M.nrm[3 * t0 + 2]];
      for (var k = 0; k < 3; k++) {
        var u = across(M, t0, k);
        if (u < 0 || M.area[u] < 2e-6) continue;
        if (Math.abs(M.nrm[3 * u] * nt[0] + M.nrm[3 * u + 1] * nt[1] + M.nrm[3 * u + 2] * nt[2]) > 0.2) continue;
        var va = M.vid[3 * t0 + k], vb = M.vid[3 * t0 + (k + 1) % 3], vc = -1;
        for (var c = 0; c < 3; c++) { var w = M.vid[3 * u + c]; if (w !== va && w !== vb) vc = w; }
        var hv = function (v) { return M.P[v][0] * nt[0] + M.P[v][1] * nt[1] + M.P[v][2] * nt[2]; };
        if (vc >= 0 && hv(vc) > (hv(va) + hv(vb)) / 2 + 0.02) return true;
      }
      return false;
    }
    var seedsNear = near.filter(function (x) { return footing(x[1]); }).slice(0, 40).concat(near.slice(0, 40));
    var first = null;
    for (i = 0; i < seedsNear.length && !first; i++) first = pocketFlat(M, seedsNear[i][1]);
    for (i = 0; i < seedsNear.length && !first; i++) first = pocketCurved(M, seedsNear[i][1]);
    if (!first) return refuse('that is not the inside of a recess in a face - click on the floor of an engraved letter');
    var n = first.n0, F = frameFor(n), org = M.P[M.vid[3 * Array.from(first.floor)[0]]];
    function box(E) {
      var pts = [];
      E.loops.forEach(function (l) { l.forEach(function (v) { pts.push(M.P[v]); }); });
      var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity], lo3 = [Infinity, Infinity, Infinity], hi3 = [-Infinity, -Infinity, -Infinity];
      pts.forEach(function (p) {
        var w = [p[0] - org[0], p[1] - org[1], p[2] - org[2]], x = w[0] * F.e1[0] + w[1] * F.e1[1] + w[2] * F.e1[2], y = w[0] * F.e2[0] + w[1] * F.e2[1] + w[2] * F.e2[2];
        lo[0] = Math.min(lo[0], x); lo[1] = Math.min(lo[1], y); hi[0] = Math.max(hi[0], x); hi[1] = Math.max(hi[1], y);
        for (var k = 0; k < 3; k++) { lo3[k] = Math.min(lo3[k], p[k]); hi3[k] = Math.max(hi3[k], p[k]); }
      });
      E.lo = lo; E.hi = hi; E.lo3 = lo3; E.hi3 = hi3;
      return E;
    }
    function gap3(A, B) {
      var s = 0;
      for (var k = 0; k < 3; k++) { var g = Math.max(0, A.lo3[k] - B.hi3[k], B.lo3[k] - A.hi3[k]); s += g * g; }
      return Math.sqrt(s);
    }
    var chosen = [box(first)];
    if (o.word) {
      // candidates: the floor triangles that stand at the foot of a wall (a wall's lowest edge along n),
      // near a chosen recess. Found once, from the walls, not by trying every triangle in reach.
      var used = new Set(first.floor);
      chosen[0].wall.forEach(function (w) { used.add(w); });
      var seeds = [];
      function hzn(v) { var q = M.P[v]; return q[0] * n[0] + q[1] * n[1] + q[2] * n[2]; }
      for (t = 0; t < M.n; t++) {
        if (M.area[t] < 2e-6 || Math.abs(M.nrm[3 * t] * n[0] + M.nrm[3 * t + 1] * n[1] + M.nrm[3 * t + 2] * n[2]) > 0.2) continue;
        for (var k = 0; k < 3; k++) {
          var u = across(M, t, k);
          if (u < 0 || M.area[u] < 2e-6) continue;
          var va = M.vid[3 * t + k], vb = M.vid[3 * t + (k + 1) % 3], vc = M.vid[3 * t + (k + 2) % 3];
          if (hzn(vc) > (hzn(va) + hzn(vb)) / 2 + 0.02 && M.nrm[3 * u] * n[0] + M.nrm[3 * u + 1] * n[1] + M.nrm[3 * u + 2] * n[2] > (first.curved ? 0.3 : 0.9998)) {
            var A = M.P[va], B = M.P[vb];
            seeds.push([u, [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2]]);
          }
        }
      }
      var zone = o.reach + 1, rounds = 0, grew = true, found = [];
      var tryFrom = first.curved ? pocketCurved : pocketFlat;
      while (grew && rounds++ < 40) {
        grew = false;
        for (var si = 0; si < seeds.length; si++) {
          var sd = seeds[si];
          if (used.has(sd[0])) continue;
          var cen = sd[1];
          var close = chosen.some(function (E) {
            for (var q = 0; q < 3; q++) if (cen[q] < E.lo3[q] - zone || cen[q] > E.hi3[q] + zone) return false;
            return true;
          });
          if (!close) continue;
          var pk = tryFrom(M, sd[0]);
          if (!pk) { used.add(sd[0]); continue; }
          pk.floor.forEach(function (x) { used.add(x); });
          pk.wall.forEach(function (x) { used.add(x); });
          if (Math.abs(pk.n0[0] * n[0] + pk.n0[1] * n[1] + pk.n0[2] * n[2]) < 0.999 ||
              (first.curved ? Math.min(pk.H, first.H) < 0.5 * Math.max(pk.H, first.H) : Math.abs(pk.H - first.H) > 0.03)) continue;
          box(pk);
          found.push(pk);
        }
        for (i = found.length - 1; i >= 0; i--) {
          if (chosen.some(function (E) { return gap3(E, found[i]) <= o.reach; })) { chosen.push(found[i]); found.splice(i, 1); grew = true; }
        }
      }
    }
    var lo2 = [Infinity, Infinity], hi2 = [-Infinity, -Infinity], depth = 0, worst = 0;
    chosen.forEach(function (E) {
      lo2[0] = Math.min(lo2[0], E.lo[0]); lo2[1] = Math.min(lo2[1], E.lo[1]); hi2[0] = Math.max(hi2[0], E.hi[0]); hi2[1] = Math.max(hi2[1], E.hi[1]);
      depth += E.H / chosen.length;
    });
    return {
      ok: true, curved: first.curved, pockets: chosen, count: chosen.length, depth: depth, width: hi2[0] - lo2[0], height: hi2[1] - lo2[1],
      _M: M, frame: { o: org, n: n, ex: F.e1, ey: F.e2 },
      reason: (chosen.length === 1 ? '1 recess' : chosen.length + ' recesses') + (first.curved ? ' in a curved face' : '') + ', ' + (first.curved ? 'about ' : '') +
        fmt(depth) + ' mm deep, ' + fmt(hi2[0] - lo2[0]) + ' × ' + fmt(hi2[1] - lo2[1]) + ' mm'
    };
  }

  /* The caps over the plan's recesses, one soup (what fill() lays down; the page draws it as the ghost). */
  function caps(pl) {
    if (!pl || !pl.ok) return { reason: 'there is nothing to fill' };
    if (pl._caps) return pl._caps;
    var out = [], i;
    for (i = 0; i < pl.pockets.length; i++) {
      var c = capOf(pl._M, pl.pockets[i]);
      if (!c.tris) return { reason: c.reason };
      out.push(c.tris);
    }
    var n = 0;
    out.forEach(function (l) { n += l.length; });
    var soup = new Float32Array(n * 9), q = 0;
    out.forEach(function (l) { l.forEach(function (t) { for (var k = 0; k < 3; k++) { soup[q++] = t[k][0]; soup[q++] = t[k][1]; soup[q++] = t[k][2]; } }); });
    pl._caps = { soup: soup, tris: n };
    return pl._caps;
  }
  /* The piece with its recesses filled: every floor and wall triangle dropped, the caps laid on. */
  function fill(soup, pl) {
    if (!pl || !pl.ok || !pl._M || pl._M.soup !== soup) return { ok: false, reason: 'the piece changed since the recesses were read' };
    var c = caps(pl);
    if (!c.soup) return { ok: false, reason: c.reason };
    var drop = new Set();
    pl.pockets.forEach(function (E) { E.floor.forEach(function (x) { drop.add(x); }); E.wall.forEach(function (x) { drop.add(x); }); });
    var n = (soup.length / 9) | 0, out = new Float32Array((n - drop.size) * 9 + c.soup.length), q = 0, t;
    for (t = 0; t < n; t++) {
      if (drop.has(t)) continue;
      out.set(soup.subarray(9 * t, 9 * t + 9), q); q += 9;
    }
    out.set(c.soup, q);
    return { ok: true, soup: out, dropped: drop.size, added: c.tris };
  }


  /* Cap polygons that already exist in 3D: loops of exact boundary points (outer counter-clockwise seen
     from along n, holes clockwise; one loop's points are an array of [x, y, z]), a frame { o, n, e1, e2 }
     and at(x, y) -> the surface's height along n from o at that (e1, e2) place, or null. The polygon is
     triangulated on its own corners (so the cap is welded to what it closes, corner for corner) and its
     interior edges split where the surface stands more than opts.sag (0.01 mm) off their chord, the new
     corners put on it. -> { tris: [[a, b, c] of 3D points] } or { reason }. Resurface (nso_resurface.js)
     uses it to close the hole where it took the old skin out. */
  function capLoops(loops, fr, at, opts) {
    var o = opts || {}, sag = o.sag > 0 ? o.sag : 0.01, minEdge = o.minEdge > 0 ? o.minEdge : 0.4, i, j;
    function to2(p) {
      var w = [p[0] - fr.o[0], p[1] - fr.o[1], p[2] - fr.o[2]];
      return [w[0] * fr.e1[0] + w[1] * fr.e1[1] + w[2] * fr.e1[2], w[0] * fr.e2[0] + w[1] * fr.e2[1] + w[2] * fr.e2[2]];
    }
    var rings = loops.map(function (l) { return { pts3: l, pts: l.map(to2) }; });
    var outers = rings.filter(function (r) { return area2(r.pts) > 0; }), holes = rings.filter(function (r) { return area2(r.pts) < 0; });
    if (!outers.length) return { reason: 'there is no outline to close' };
    var polys = outers.map(function (r) { return { outer: r.pts, holes: [], p3: r.pts3.slice(), a2: area2(r.pts) }; });
    holes.forEach(function (h) {
      var best = null;
      polys.forEach(function (P) { if (inside(P.outer, h.pts[0]) && (!best || P.a2 < best.a2)) best = P; });
      if (!best) return;
      best.holes.push(h.pts); best.p3 = best.p3.concat(h.pts3);
    });
    var P3 = [];
    polys.forEach(function (P) { P3 = P3.concat(P.p3); });
    var tri = triangulate({ polys: polys.map(function (P) { return { outer: P.outer, holes: P.holes }; }) }, true);
    if (!tri.V) return { reason: 'the outline could not be closed (' + tri.reason + ')' };
    var V = tri.V, T = tri.T;
    if (V.length !== P3.length) return { reason: 'the outline could not be closed' };
    var nRing = V.length, cell = 0.05, hash = new Map();
    function hkey(x, y) { return Math.floor(x / cell) + ',' + Math.floor(y / cell); }
    function hadd(k) { var key = hkey(V[k][0], V[k][1]), l = hash.get(key); if (l) l.push(k); else hash.set(key, [k]); }
    function crowded(x, y) {
      var cx = Math.floor(x / cell), cy = Math.floor(y / cell);
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
        var l = hash.get((cx + dx) + ',' + (cy + dy));
        if (l) for (var q = 0; q < l.length; q++) if (Math.hypot(V[l[q]][0] - x, V[l[q]][1] - y) < 0.03) return true;
      }
      return false;
    }
    for (i = 0; i < V.length; i++) hadd(i);
    var rf = refineInterior(V, T, function (a, b, m) {
      if (Math.hypot(V[a][0] - V[b][0], V[a][1] - V[b][1]) < minEdge || crowded(m[0], m[1])) return false;
      var s = at(m[0], m[1]), sa = at(V[a][0], V[a][1]), sb = at(V[b][0], V[b][1]);
      return s !== null && sa !== null && sb !== null && Math.abs(s - (sa + sb) / 2) > sag;
    }, function (m, a, b, mid) {
      var s = at(mid[0], mid[1]);
      hadd(m);
      if (s === null) {
        var pa = P3[a] || null, pb = P3[b] || null;
        s = ((pa ? (pa[0] - fr.o[0]) * fr.n[0] + (pa[1] - fr.o[1]) * fr.n[1] + (pa[2] - fr.o[2]) * fr.n[2] : 0) + (pb ? (pb[0] - fr.o[0]) * fr.n[0] + (pb[1] - fr.o[1]) * fr.n[1] + (pb[2] - fr.o[2]) * fr.n[2] : 0)) / 2;
      }
      P3[m] = [fr.o[0] + fr.e1[0] * mid[0] + fr.e2[0] * mid[1] + fr.n[0] * s, fr.o[1] + fr.e1[1] * mid[0] + fr.e2[1] * mid[1] + fr.n[1] * s,
               fr.o[2] + fr.e1[2] * mid[0] + fr.e2[2] * mid[1] + fr.n[2] * s];
    }, V);
    return { tris: rf.map(function (t) { return [P3[t[0]], P3[t[1]], P3[t[2]]]; }), nRing: nRing };
  }

  var API = {
    capLoops: capLoops,
    _across: across,
    _loopsOf: loopsOf,
    _frameFor: frameFor,
    pockets: pockets,
    caps: caps,
    fill: fill,
    _weld: weld,
    _pocketCurved: pocketCurved,
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
