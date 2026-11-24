/* nso_custom_shape.js - Custom shape: an outline you draw, made into a tray, a frame or a solid.

   Loads as a classic script (window.NSO_CustomShape) and as a Node module. No DOM, no THREE, no app
   state - the rule nso_stock.js and nso_fittings.js follow. app-custom-shape.js is the card that edits a
   spec and shows what this makes; tools/nso_custom_shape_test.js proves the geometry. docs/CUSTOM-SHAPE.md.

     NSO_CustomShape.outline(spec)  -> { ok, outer, inner, corners, info } | { ok: false, reason, at }
     NSO_CustomShape.make(spec)     -> { ok, soup: Float32Array, outer, inner, info } | { ok: false, reason, at }
     NSO_CustomShape.maxRadius(spec, i)        the largest Radius corner i's sides have room for
     NSO_CustomShape.preset(name)   -> a spec      PRESETS lists the names
     NSO_CustomShape.normalize(spec)            a clean copy, every number defaulted and clamped

   ---------------------------------------------------------------------------
   THE SPEC
   ---------------------------------------------------------------------------
     points  [{ x, y, r, rIn }]  the corners, mm, in either winding. r is the OUTSIDE radius at that
                                  corner; rIn the inside one - null (the default) works it out (below).
     sides   [{ wall, bulge }]    side i runs from point i to point i + 1 (the last closes to the first).
                                  wall: that side's own wall thickness, mm. bulge: the side as an arc -
                                  how far its middle stands off the straight line, mm, + out, - in, 0 straight.
     height  the piece's height, mm
     floor   tray: the floor's thickness, mm
     mode    'tray'   walls and a floor, open at the top (a bin, a drawer insert)
             'frame'  walls only, open at both ends (a ring, a fence, a gasket)
             'solid'  the outline filled and stood up (a plate, a spacer, a blank)

   ---------------------------------------------------------------------------
   HOW AN OUTLINE IS MADE - one rule for every corner, outside and in
   ---------------------------------------------------------------------------
   Every side is a PRIMITIVE: a line, or (with a bulge) a circular arc whose sagitta is the bulge. Moving a
   primitive in by d is exact - a line moves along its inward normal, an arc keeps its centre and its
   radius changes by d. The inside outline is every side moved in by ITS OWN wall, so each side keeps the
   thickness it was given, whatever its neighbours have.

   A corner rounded at radius rho is a circle tangent to both its sides; its centre is where the two sides,
   each moved a further rho in (out, at a reflex corner), cross. Outside: the sides at 0, rho = r. Inside:
   the sides at their walls, rho = rIn. So one function makes both, lines or arcs - line/line,
   line/circle, circle/circle intersections - and the tangent points are the centre's feet on the two
   (moved) sides.

   THE INSIDE RADIUS, when rIn is not given, keeps the wall round the corner: at a convex corner it is
   r - min(wall either side) (concentric when the walls are equal, never thinner than the thinner wall when
   they are not), floored at 0; at a reflex corner it is r + min(wall either side), so a sharp outside
   notch still gets a fillet of exactly the wall inside it.

   ---------------------------------------------------------------------------
   REFUSALS, each in words and each naming the point or side (counted from 1, in the order given):
     fewer than 3 points, or two points on top of each other
     a radius more than its two sides have room for (says how much they have)
     a bulge bigger than its side is long
     an outline that crosses itself
     walls that meet in the middle - the inside outline turns inside out or crosses itself
     a floor as thick as the piece is tall
   WARNINGS (made anyway): a wall thinner than 2 nozzle widths, measured on the outlines as built.
*/
(function (root) {
  'use strict';

  var EPS = 1e-9;
  var TOL = 0.02;            // mm: the most an arc's chords may stand off the true arc
  var MAX_ARC_SEG = 96;      // the most chords one arc gets
  var WALL_NOZZLES = 2;      // a wall under this many nozzle widths is warned about
  var DEFAULTS = { height: 30, floor: 2, wall: 2, r: 5, mode: 'tray', nozzle: 0.4,
                   lipWidth: 3, lipHeight: 2, lidThickness: 2, lidDepth: 4, lidFit: 0.25, lidWall: 1.6 };
  var MODES = ['tray', 'frame', 'solid'];
  var LIP_TYPES = ['none', 'out', 'in'];
  var LID_TYPES = ['none', 'with', 'only'];

  function fmt(x) { return (Math.round(x * 100) / 100).toFixed(2).replace(/\.?0+$/, ''); }
  function num(v, d) { v = +v; return isFinite(v) ? v : d; }

  /* ------------------------------------------------------------------ the spec */

  function normalize(spec) {
    spec = spec || {};
    var pts = (spec.points || []).map(function (p) {
      var rIn = (p && p.rIn != null && p.rIn !== '' && isFinite(+p.rIn)) ? Math.max(0, +p.rIn) : null;
      return { x: num(p && p.x, 0), y: num(p && p.y, 0), r: Math.max(0, num(p && p.r, DEFAULTS.r)), rIn: rIn };
    });
    var sides = [];
    for (var i = 0; i < pts.length; i++) {
      var s = (spec.sides && spec.sides[i]) || {};
      sides.push({ wall: Math.max(0, num(s.wall, DEFAULTS.wall)), bulge: num(s.bulge, 0) });
    }
    var mode = MODES.indexOf(spec.mode) >= 0 ? spec.mode : DEFAULTS.mode;
    var li = spec.lip || {}, ld = spec.lid || {};
    return {
      points: pts, sides: sides, mode: mode,
      lip: { type: LIP_TYPES.indexOf(li.type) >= 0 ? li.type : 'none', width: Math.max(0, num(li.width, DEFAULTS.lipWidth)),
             height: Math.max(0, num(li.height, DEFAULTS.lipHeight)), chamfer: li.chamfer == null ? true : !!li.chamfer },
      lid: { type: LID_TYPES.indexOf(ld.type) >= 0 ? ld.type : 'none', thickness: Math.max(0, num(ld.thickness, DEFAULTS.lidThickness)),
             depth: Math.max(0, num(ld.depth, DEFAULTS.lidDepth)), fit: Math.max(0, num(ld.fit, DEFAULTS.lidFit)),
             wall: Math.max(0, num(ld.wall, DEFAULTS.lidWall)) },
      height: Math.max(0, num(spec.height, DEFAULTS.height)),
      floor: Math.max(0, num(spec.floor, DEFAULTS.floor)),
      nozzle: Math.max(0.05, num(spec.nozzle, DEFAULTS.nozzle))
    };
  }

  function signedArea(loop) {
    var a = 0;
    for (var i = 0, n = loop.length; i < n; i++) {
      var p = loop[i], q = loop[(i + 1) % n];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }

  /* --------------------------------------------------------------- primitives
     A side, counter-clockwise, interior on the LEFT. { line: true, a, b, d (unit), n (inward unit), len }
     or { line: false, a, b, c (centre), R, k (+1 bulges out: interior inside the circle; -1 in), dir
     (+1 counter-clockwise round c, -1 clockwise), a0 (angle of a), phi (sweep) }. */
  function makeSide(a, b, bulge) {
    var dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
    var d = [dx / len, dy / len], n = [-d[1], d[0]];
    if (Math.abs(bulge) < 1e-6) return { line: true, a: a, b: b, d: d, n: n, len: len };
    var h = len / 2, s = Math.abs(bulge), k = bulge > 0 ? 1 : -1;
    var R = (h * h + s * s) / (2 * s);
    var m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    var off = k * (R - s);                         // centre: along the inward normal from the chord's middle
    var c = [m[0] + n[0] * off, m[1] + n[1] * off];
    var dir = k;                                   // out-bulge: centre on the left, so counter-clockwise
    var a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
    var phi = 2 * Math.atan2(h, R - s);
    return { line: false, a: a, b: b, c: c, R: R, k: k, dir: dir, a0: a0, phi: phi, len: R * phi, chord: len };
  }

  /* the side moved in by dist (out when negative): a line or a circle */
  function moved(side, dist) {
    if (side.line) return { line: true, p: [side.a[0] + side.n[0] * dist, side.a[1] + side.n[1] * dist], d: side.d };
    return { line: false, c: side.c, R: side.R - side.k * dist };
  }

  /* where two moved sides cross, the crossing nearest `ref` (null when they do not) */
  function cross(A, B, ref) {
    var out = [];
    if (A.line && B.line) {
      var den = A.d[0] * B.d[1] - A.d[1] * B.d[0];
      if (Math.abs(den) < 1e-12) return null;
      var t = ((B.p[0] - A.p[0]) * B.d[1] - (B.p[1] - A.p[1]) * B.d[0]) / den;
      return [A.p[0] + A.d[0] * t, A.p[1] + A.d[1] * t];
    }
    if (!A.line && !B.line) {
      if (A.R <= 0 || B.R <= 0) return null;
      var ex = B.c[0] - A.c[0], ey = B.c[1] - A.c[1], D = Math.hypot(ex, ey);
      if (D < 1e-12 || D > A.R + B.R + 1e-9 || D < Math.abs(A.R - B.R) - 1e-9) return null;
      var x = (D * D + A.R * A.R - B.R * B.R) / (2 * D), y2 = A.R * A.R - x * x, y = y2 > 0 ? Math.sqrt(y2) : 0;
      var ux = ex / D, uy = ey / D;
      out.push([A.c[0] + ux * x - uy * y, A.c[1] + uy * x + ux * y], [A.c[0] + ux * x + uy * y, A.c[1] + uy * x - ux * y]);
    } else {
      var L = A.line ? A : B, C = A.line ? B : A;
      if (C.R <= 0) return null;
      var fx = L.p[0] - C.c[0], fy = L.p[1] - C.c[1];
      var bq = fx * L.d[0] + fy * L.d[1], cq = fx * fx + fy * fy - C.R * C.R, disc = bq * bq - cq;
      if (disc < -1e-9) return null;
      var sq = disc > 0 ? Math.sqrt(disc) : 0;
      [-bq - sq, -bq + sq].forEach(function (t) { out.push([L.p[0] + L.d[0] * t, L.p[1] + L.d[1] * t]); });
    }
    var best = null, bd = Infinity;
    out.forEach(function (p) { var dd = Math.hypot(p[0] - ref[0], p[1] - ref[1]); if (dd < bd) { bd = dd; best = p; } });
    return best;
  }

  /* the foot of point p on a moved side */
  function foot(M, p) {
    if (M.line) {
      var t = (p[0] - M.p[0]) * M.d[0] + (p[1] - M.p[1]) * M.d[1];
      return [M.p[0] + M.d[0] * t, M.p[1] + M.d[1] * t];
    }
    var vx = p[0] - M.c[0], vy = p[1] - M.c[1], l = Math.hypot(vx, vy);
    if (l < 1e-12) return null;
    return [M.c[0] + vx / l * M.R, M.c[1] + vy / l * M.R];
  }

  /* how far along its side (0 at a, 1 at b) a point on the side, or on a moved copy, stands */
  function along(side, p) {
    if (side.line) return ((p[0] - side.a[0]) * side.d[0] + (p[1] - side.a[1]) * side.d[1]) / side.len;
    var ang = Math.atan2(p[1] - side.c[1], p[0] - side.c[0]);
    var pad = Math.PI - side.phi / 2, rel = side.dir * (ang - side.a0) + pad;
    rel = ((rel % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - pad;
    return rel / side.phi;
  }

  function tangentAt(side, end) {               // the unit direction of travel at a (end 0) or b (end 1)
    if (side.line) return side.d;
    var ang = side.a0 + side.dir * side.phi * end;
    return [-Math.sin(ang) * side.dir, Math.cos(ang) * side.dir];
  }

  /* --------------------------------------------------------------- corners
     corner(A, B, P, dA, dB, rho): the fillet at P, where side A ends and side B starts, between A moved in
     by dA and B by dB. -> { c, rho, ta (on A), tb (on B), convex, sA, sB } (sA, sB: how far along A / B the
     tangent points stand), or null. */
  function corner(A, B, P, dA, dB, rho) {
    var tA = tangentAt(A, 1), tB = tangentAt(B, 0);
    var crs = tA[0] * tB[1] - tA[1] * tB[0], dot = tA[0] * tB[0] + tA[1] * tB[1];
    var turn = Math.atan2(crs, dot);
    var convex = turn >= 0, sg = convex ? 1 : -1;
    var flat = Math.abs(turn) < 1e-4;
    if (flat) rho = 0;                            // a side carried straight on: no corner to round
    var MA = moved(A, dA + sg * rho), MB = moved(B, dB + sg * rho);
    /* the crossing nearest the one the tangent lines through P would give - a close guess, and it picks
       the right one of a circle's two crossings */
    var nA = [-tA[1], tA[0]], nB = [-tB[1], tB[0]];
    var gA = { line: true, p: [P[0] + nA[0] * (dA + sg * rho), P[1] + nA[1] * (dA + sg * rho)], d: tA };
    var gB = { line: true, p: [P[0] + nB[0] * (dB + sg * rho), P[1] + nB[1] * (dB + sg * rho)], d: tB };
    var ref = flat ? gA.p : (cross(gA, gB, P) || P);
    var c = flat ? (A.line && B.line ? ref : (cross(MA, MB, ref) || ref)) : cross(MA, MB, ref);
    if (!c) return null;
    var ta, tb;
    if (rho > 0) {
      ta = foot(moved(A, dA), c); tb = foot(moved(B, dB), c);
      if (!ta || !tb) return null;
    } else {
      ta = tb = c;
    }
    return { c: c, rho: rho, ta: ta, tb: tb, convex: convex, turn: turn, sA: along(A, ta), sB: along(B, tb) };
  }

  /* ----------------------------------------------------------- tessellation */
  function arcCount(R, sweep) {
    if (R <= TOL) return 1;
    var step = 2 * Math.acos(Math.max(-1, 1 - TOL / R));
    return Math.max(1, Math.min(MAX_ARC_SEG, Math.ceil(Math.abs(sweep) / Math.max(step, 1e-3))));
  }
  function arcPoints(c, R, a0, sweep, out, withStart) {
    var n = arcCount(R, sweep);
    for (var i = withStart ? 0 : 1; i <= n; i++) {
      var a = a0 + sweep * i / n;
      out.push([c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)]);
    }
  }
  function push(out, p) {
    var q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-7) out.push(p);
  }

  /* One closed outline: every side moved in by dist[i], every corner rounded at rho[i]. */
  function loop(sides, P, dist, rho, which, ix) {
    var n = sides.length, C = [], i;
    for (i = 0; i < n; i++) {
      var A = sides[(i + n - 1) % n], B = sides[i];
      var co = corner(A, B, P[i], dist[(i + n - 1) % n], dist[i], rho[i]);
      if (!co) {
        var u = ix ? ix[i] : i, wa = dist[(i + n - 1) % n], wb = dist[i];
        /* a curved side meeting its neighbour nearly in line: moved in by different walls, the two never
           cross again, so there is no corner for the inside to turn at */
        var why = Math.abs(wa - wb) > 1e-6
          ? ' its two sides meet nearly in line and their walls differ (' + fmt(wa) + ' and ' + fmt(wb) + ' mm), so once the walls are taken off they no longer meet - give them the same wall, or make the corner sharper'
          : ' rounded at ' + fmt(rho[i]) + ' mm it does not fit between its two sides once their walls (' + fmt(wa) + ' mm) are taken off - make the walls thinner, the curve gentler, or set its Inner R';
        return { ok: false, at: { point: u }, reason: which === 'inside'
          ? 'the inside corner at point ' + (u + 1) + ' has no room:' + why
          : 'the corner at point ' + (u + 1) + ' could not be rounded at ' + fmt(rho[i]) + ' mm - its sides do not meet there' };
      }
      C.push(co);
    }
    /* each side: its start corner's tangent point must come before its end corner's. Not "both within the
       side": a moved side's corner may stand past the end of the side it came from (unequal walls at an
       obtuse corner do that), and a fillet too big for its side shows up as the order turning over, since
       the next corner's tangent point is at the side's end or before it. */
    for (i = 0; i < n; i++) {
      var s0 = C[i].sB, s1 = C[(i + 1) % n].sA;
      if (s0 > s1 + 1e-6) return { ok: false, side: i, corners: C, reason: '', at: { side: i } };
    }
    /* marks[2i] is where corner i's fillet starts in the loop, marks[2i + 1] where side i starts (the fillet's
       end): every outline of one spec has the same 2n pieces in the same order, so two of them at different
       offsets can be stitched piece by piece (zip, below) whatever their point counts. A mark may equal the
       loop's length: that is index 0 again, the piece before it ending where the loop began. */
    var out = [], marks = [];
    function add(p) {
      var q = out[out.length - 1];
      if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-7) out.push(p);
      return out.length - 1;
    }
    for (i = 0; i < n; i++) {
      var co2 = C[i], S = sides[i], M = moved(S, dist[i]);
      /* the corner's fillet, ta -> tb */
      var arc = [];
      if (co2.rho > 0) {
        var a0 = Math.atan2(co2.ta[1] - co2.c[1], co2.ta[0] - co2.c[0]);
        var a1 = Math.atan2(co2.tb[1] - co2.c[1], co2.tb[0] - co2.c[0]);
        var sw = a1 - a0;
        if (co2.convex) { while (sw < 0) sw += 2 * Math.PI; } else { while (sw > 0) sw -= 2 * Math.PI; }
        arcPoints(co2.c, co2.rho, a0, sw, arc, true);
      } else arc.push(co2.c);
      marks.push(add(arc[0]));
      for (var q = 1; q < arc.length; q++) add(arc[q]);
      marks.push(out.length - 1);
      /* then the side, to the next corner's ta (not included: it is the next corner's first point) */
      var end = C[(i + 1) % n].ta;
      if (!S.line) {
        var b0 = Math.atan2(co2.tb[1] - M.c[1], co2.tb[0] - M.c[0]);
        var b1 = Math.atan2(end[1] - M.c[1], end[0] - M.c[0]);
        var sw2 = b1 - b0;
        if (S.dir > 0) { while (sw2 < 0) sw2 += 2 * Math.PI; } else { while (sw2 > 0) sw2 -= 2 * Math.PI; }
        if (Math.abs(sw2) > 1e-9 && M.R > 0) {
          var t2 = [];
          arcPoints(M.c, M.R, b0, sw2, t2, false);
          t2.pop();                                   // its last point is `end`
          t2.forEach(add);
        }
      }
    }
    if (out.length > 1) {
      var f = out[0], l = out[out.length - 1];
      if (Math.hypot(f[0] - l[0], f[1] - l[1]) <= 1e-7) out.pop();   // a mark on the popped point now reads as out.length: index 0
    }
    return { ok: true, loop: out, marks: marks, corners: C };
  }

  /* ------------------------------------------------------------- checks */
  function segHit(a, b, c, d) {
    function o(p, q, r) { return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); }
    var d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
    return ((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12));
  }
  /* the first pair of edges of `loop` that cross, or null. Bounding boxes first: a few hundred corners. */
  function selfCross(L) {
    var n = L.length, bb = [];
    for (var i = 0; i < n; i++) {
      var p = L[i], q = L[(i + 1) % n];
      bb.push([Math.min(p[0], q[0]), Math.max(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[1], q[1])]);
    }
    for (i = 0; i < n; i++) {
      for (var j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        var A = bb[i], B = bb[j];
        if (A[1] < B[0] || B[1] < A[0] || A[3] < B[2] || B[3] < A[2]) continue;
        if (segHit(L[i], L[(i + 1) % n], L[j], L[(j + 1) % n])) return [i, j];
      }
    }
    return null;
  }
  function loopsCross(A, B) {
    for (var i = 0; i < A.length; i++) for (var j = 0; j < B.length; j++)
      if (segHit(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
    return false;
  }
  function inside(p, L) {
    var c = false;
    for (var i = 0, j = L.length - 1; i < L.length; j = i++) {
      var a = L[i], b = L[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  function distToLoop(p, L) {
    var best = Infinity;
    for (var i = 0; i < L.length; i++) {
      var a = L[i], b = L[(i + 1) % L.length], vx = b[0] - a[0], vy = b[1] - a[1], ll = vx * vx + vy * vy;
      var t = ll > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / ll)) : 0;
      var d = Math.hypot(a[0] + vx * t - p[0], a[1] + vy * t - p[1]);
      if (d < best) best = d;
    }
    return best;
  }
  /* the thinnest wall as built: the least distance from either outline's corners to the other outline */
  function thinnest(O, I) {
    var m = Infinity, i;
    for (i = 0; i < I.length; i++) m = Math.min(m, distToLoop(I[i], O));
    for (i = 0; i < O.length; i++) m = Math.min(m, distToLoop(O[i], I));
    return m;
  }

  /* ------------------------------------------------------------- outline */

  /* The spec put counter-clockwise: `ix[j]` is the user's number for corner j, `sx[j]` for side j. */
  function oriented(sp) {
    var n = sp.points.length, P = sp.points.map(function (p) { return [p.x, p.y]; });
    var ix = [], sx = [], i;
    for (i = 0; i < n; i++) { ix.push(i); sx.push(i); }
    if (signedArea(P) < 0) {
      /* reversed: corner j is the user's n-1-j; side j (j -> j+1) is the user's side n-2-j, walked back */
      ix = ix.map(function (j) { return n - 1 - j; });
      sx = sx.map(function (j) { return ((n - 2 - j) % n + n) % n; });
    }
    return {
      P: ix.map(function (u) { return [sp.points[u].x, sp.points[u].y]; }),
      pt: ix.map(function (u) { return sp.points[u]; }),
      sd: sx.map(function (u) { return sp.sides[u]; }),
      ix: ix, sx: sx
    };
  }

  function sidesOf(o) {
    var n = o.P.length, S = [];
    for (var j = 0; j < n; j++) S.push(makeSide(o.P[j], o.P[(j + 1) % n], o.sd[j].bulge));
    return S;
  }

  function autoInner(o, S, j) {
    var n = o.P.length, p = o.pt[j];
    if (p.rIn != null) return p.rIn;
    var wA = o.sd[(j + n - 1) % n].wall, wB = o.sd[j].wall, w = Math.min(wA, wB);
    var A = S[(j + n - 1) % n], B = S[j], tA = tangentAt(A, 1), tB = tangentAt(B, 0);
    var convex = (tA[0] * tB[1] - tA[1] * tB[0]) >= 0;
    return convex ? Math.max(0, p.r - w) : p.r + w;
  }

  function basicChecks(sp) {
    var n = sp.points.length, i;
    if (n < 3) return 'an outline needs at least 3 points (it has ' + n + ')';
    for (i = 0; i < n; i++) {
      var a = sp.points[i], b = sp.points[(i + 1) % n], L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 0.01) return 'points ' + (i + 1) + ' and ' + ((i + 1) % n + 1) + ' are on top of each other';
      if (Math.abs(sp.sides[i].bulge) > L) return 'side ' + (i + 1) + "'s curve (" + fmt(sp.sides[i].bulge) + ' mm) is more than the side is long (' + fmt(L) + ' mm)';
    }
    if (Math.abs(signedArea(sp.points.map(function (p) { return [p.x, p.y]; }))) < 0.01) return 'the points enclose no area';
    return null;
  }

  /* The outside outline and (tray, frame) the inside one, checked. */
  function outline(spec) {
    var sp = normalize(spec), why = basicChecks(sp);
    if (why) return { ok: false, reason: why, at: null };
    var o = oriented(sp), S = sidesOf(o), n = o.P.length, j;
    var zero = [], rOut = [];
    for (j = 0; j < n; j++) { zero.push(0); rOut.push(o.pt[j].r); }
    var out = loop(S, o.P, zero, rOut, 'outside', o.ix);
    if (!out.ok) return tooRound(sp, o, out, 'outside');
    var walled = sp.mode !== 'solid';
    var res = { ok: true, outer: out.loop, inner: null, corners: [], warnings: [], spec: sp };
    var os = selfCross(out.loop);
    if (os) return { ok: false, reason: 'the outline crosses itself - drag the points so no side crosses another', at: null };

    var inn = null, rIn = [];
    if (walled) {
      var walls = [];
      for (j = 0; j < n; j++) { walls.push(o.sd[j].wall); rIn.push(autoInner(o, S, j)); }
      for (j = 0; j < n; j++) {
        if (walls[j] <= 0) return { ok: false, reason: 'side ' + (o.sx[j] + 1) + ' has no wall - give it at least ' + fmt(WALL_NOZZLES * sp.nozzle) + ' mm', at: { side: o.sx[j] } };
        if (!S[j].line && S[j].k > 0 && walls[j] >= S[j].R) return { ok: false, reason: 'side ' + (o.sx[j] + 1) + "'s wall (" + fmt(walls[j]) + ' mm) is more than its curve\'s radius (' + fmt(S[j].R) + ' mm)', at: { side: o.sx[j] } };
      }
      inn = loop(S, o.P, walls, rIn, 'inside', o.ix);
      if (!inn.ok) {
        if (inn.reason) return { ok: false, reason: inn.reason, at: inn.at };
        return tooRound(sp, o, inn, 'inside', true);
      }
      var A = signedArea(inn.loop);
      if (!(A > 0) || selfCross(inn.loop) || loopsCross(out.loop, inn.loop) || !inside(inn.loop[0], out.loop))
        return { ok: false, reason: 'the walls meet in the middle - the inside outline turns over on itself. Make the walls thinner, the shape bigger, or the inside radii smaller', at: null };
      res.inner = inn.loop;
      var thin = thinnest(out.loop, inn.loop);
      res.minWall = thin;
      if (thin < WALL_NOZZLES * sp.nozzle - 1e-6)
        res.warnings.push('the thinnest wall is ' + fmt(thin) + ' mm - under ' + WALL_NOZZLES + ' nozzle widths (' + fmt(WALL_NOZZLES * sp.nozzle) + ' mm) it may not print');
    }
    for (j = 0; j < n; j++) res.corners[o.ix[j]] = { r: o.pt[j].r, rIn: walled ? rIn[j] : null, auto: o.pt[j].rIn == null, convex: out.corners[j].convex };
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    out.loop.forEach(function (p) { lo[0] = Math.min(lo[0], p[0]); lo[1] = Math.min(lo[1], p[1]); hi[0] = Math.max(hi[0], p[0]); hi[1] = Math.max(hi[1], p[1]); });
    res.info = {
      width: hi[0] - lo[0], depth: hi[1] - lo[1], min: lo, max: hi,
      areaOut: signedArea(out.loop), areaIn: res.inner ? signedArea(res.inner) : 0,
      sideLengths: o.sx.map(function () { return 0; })
    };
    for (j = 0; j < n; j++) res.info.sideLengths[o.sx[j]] = S[j].len;
    var conv = out.corners.map(function (c) { return c.convex; });
    res.ctx = { o: o, S: S, walls: walled ? o.sd.map(function (d) { return d.wall; }) : null, rOut: rOut, rIn: walled ? rIn : null, conv: conv };
    res.outerLoop = out;
    res.innerLoop = inn;
    return res;
  }

  /* ------------------------------------------------------------- levels
     Another outline of the same spec, every side moved a further e in (out when e < 0) from the outside
     ('out') or from the inside ('in', which is already every side at its own wall), corners kept concentric:
     an outside corner's radius shrinks by e, a turned-in one's grows - the exact offset of the outline. A lip,
     a lid's plug, Grow and Shrink are all this. -> { ok, loop, marks } or { ok: false, reason }. */
  function conc(rho, e, convex) { return convex ? Math.max(0, rho - e) : Math.max(0, rho + e); }
  function level(ctx, base, e, what) {
    var n = ctx.o.P.length, dist = [], rho = [];
    for (var j = 0; j < n; j++) {
      dist.push((base === 'in' ? ctx.walls[j] : 0) + e);
      rho.push(conc(base === 'in' ? ctx.rIn[j] : ctx.rOut[j], e, ctx.conv[j]));
    }
    var L = loop(ctx.S, ctx.o.P, dist, rho, base === 'in' ? 'inside' : 'outside', ctx.o.ix);
    if (!L.ok) return { ok: false, reason: what + ' has no room: ' + (L.reason || ('side ' + (ctx.o.sx[L.side] + 1) + ' is used up by its corners')) };
    if (!(signedArea(L.loop) > 0) || selfCross(L.loop)) return { ok: false, reason: what + ' turns over on itself - the outline is too small or too narrow for it' };
    return L;
  }
  /* `child` lies wholly inside `parent`, touching it nowhere */
  function within(child, parent) {
    return inside(child[0], parent) && !loopsCross(child, parent);
  }

  /* A corner's fillet ran off its side: say which corners, and what room each has with the other as it is
     (a corner whose room is 0 is not named: it is the other one that is too big). */
  function tooRound(sp, o, L, which, inner) {
    var n = o.P.length, j = L.side, k = (j + 1) % n;
    var side = 'side ' + (o.sx[j] + 1), S = sidesOf(o)[j];
    var pa = o.ix[j] + 1, pb = o.ix[k] + 1;
    if (pa > pb && !(pa === n && pb === 1)) { var sw = pa; pa = pb; pb = sw; }   // as the side runs: "2 and 3", "4 and 1"
    if (pb === n && pa === 1) { pa = n; pb = 1; }
    if (inner)
      return { ok: false, at: { side: o.sx[j], points: [o.ix[j], o.ix[k]] },
               reason: 'the inside corners at points ' + pa + ' and ' + pb + ' are rounded more than ' + side +
                       ' has room for once its wall is taken off - set their Inner R smaller, or make the wall thinner' };
    var room = [[pa, maxRadiusOriented(sp, o, pa - 1)], [pb, maxRadiusOriented(sp, o, pb - 1)]].filter(function (x) { return x[1] > 0; });
    var msg = 'the corners at points ' + pa + ' and ' + pb + ' are rounded more than ' + side + ' (' + fmt(S.len) + ' mm long) has room for';
    if (room.length) msg += ' - ' + room.map(function (x) { return 'point ' + x[0] + ' can take up to ' + fmt(x[1]) + ' mm'; }).join(', ') + ' as the other stands';
    return { ok: false, reason: msg, at: { side: o.sx[j], points: [o.ix[j], o.ix[k]] } };
  }

  /* the largest outside radius corner u (the user's number, from 0) can take with every other corner as it is */
  function maxRadiusOriented(sp, o, u) {
    var S = sidesOf(o), n = o.P.length, j = o.ix.indexOf(u), zero = [], rr = [];
    for (var q = 0; q < n; q++) { zero.push(0); rr.push(o.pt[q].r); }
    function fits(r) {
      rr[j] = r;
      var A = S[(j + n - 1) % n], B = S[j];
      var c = corner(A, B, o.P[j], 0, 0, r);
      if (!c) return false;
      var prev = corner(S[(j + n - 2) % n], A, o.P[(j + n - 1) % n], 0, 0, rr[(j + n - 1) % n]);
      var next = corner(B, S[(j + 1) % n], o.P[(j + 1) % n], 0, 0, rr[(j + 1) % n]);
      if (!prev || !next) return false;
      return prev.sB <= c.sA + 1e-6 && c.sB <= next.sA + 1e-6;
    }
    if (!fits(0)) return 0;
    var lo = 0, hi = 1;
    while (hi < 1e5 && fits(hi)) { lo = hi; hi *= 2; }
    for (var it = 0; it < 40; it++) { var mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
    return Math.floor(lo * 100) / 100;
  }
  function maxRadius(spec, u) {
    var sp = normalize(spec);
    if (basicChecks(sp) || u < 0 || u >= sp.points.length) return 0;
    return maxRadiusOriented(sp, oriented(sp), u);
  }

  /* ------------------------------------------------------------- mesh */

  function triangulate(loops) {
    var CDT = root.NSO_CDT || (typeof require === 'function' ? require('./nso_cdt.js') : null);
    if (!CDT) throw new Error('NSO_CustomShape needs nso_cdt.js');
    var pts = [], segs = [];
    loops.forEach(function (L) {
      var b = pts.length;
      for (var i = 0; i < L.length; i++) { pts.push(L[i]); segs.push([b + i, b + (i + 1) % L.length]); }
    });
    var r = CDT.triangulate(pts, segs);
    if (!r || !r.tris) throw new Error((r && r.reason) || 'the outline could not be filled');
    return { pts: pts, tris: r.tris };
  }

  /* ------------------------------------------------------------- the mesh writer
     A piece is two STACKS of outlines, bottom to top - the outside surface and (walled) the inside one -
     each entry an outline at a height. Between two entries: the same outline higher up is a straight wall;
     a different outline higher up is a sloped band (a chamfer), zipped piece by piece; a different outline at
     the same height is a flat step (a lip's underside or ceiling), filled between the two. Then the caps:
     the bottom, the floor, the top. Every band and cap is built on the outlines' own points, so the mesh is
     closed by construction. */
  function writer() {
    var tri = [];
    function T(a, za, b, zb, c, zc) { tri.push(a[0], a[1], za, b[0], b[1], zb, c[0], c[1], zc); }
    function cap(loops, z, up) {
      var t = triangulate(loops);
      for (var i = 0; i < t.tris.length; i += 3) {
        var a = t.pts[t.tris[i]], b = t.pts[t.tris[i + 1]], c = t.pts[t.tris[i + 2]];
        if (up) T(a, z, b, z, c, z); else T(a, z, c, z, b, z);
      }
    }
    /* the band from lo (at z0) up to hi (at z1), facing out (or in, for an inside surface) */
    function zip(lo, z0, hi, z1, out) {
      var A = lo.loop, B = hi.loop, nA = A.length, nB = B.length, pieces = lo.marks.length;
      function face(a, za, b, zb, c, zc) { if (out) T(a, za, b, zb, c, zc); else T(a, za, c, zc, b, zb); }
      for (var k = 0; k < pieces; k++) {
        var a0 = lo.marks[k], a1 = k + 1 < pieces ? lo.marks[k + 1] : nA;
        var b0 = hi.marks[k], b1 = k + 1 < pieces ? hi.marks[k + 1] : nB;
        var pa = [], pb = [], i;
        for (i = a0; i <= a1; i++) pa.push(A[i % nA]);
        for (i = b0; i <= b1; i++) pb.push(B[i % nB]);
        var ta = params(pa), tb = params(pb), x = 0, y = 0;
        while (x < pa.length - 1 || y < pb.length - 1) {
          var stepA = y >= pb.length - 1 || (x < pa.length - 1 && ta[x + 1] <= tb[y + 1]);
          if (stepA) { face(pa[x], z0, pa[x + 1], z0, pb[y], z1); x++; }
          else { face(pa[x], z0, pb[y + 1], z1, pb[y], z1); y++; }
        }
      }
    }
    function params(pts) {
      var t = [0], L = 0;
      for (var i = 1; i < pts.length; i++) { L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); t.push(L); }
      return t.map(function (v, i) { return L > 1e-12 ? v / L : (pts.length > 1 ? i / (pts.length - 1) : 0); });
    }
    /* one surface's stack; `outside` true for the outside surface (faces out, material within its outlines) */
    function stack(list, outside) {
      for (var i = 0; i + 1 < list.length; i++) {
        var lo = list[i], hi = list[i + 1];
        if (hi.z > lo.z + 1e-9) zip(lo.L, lo.z, hi.L, hi.z, outside);
        else if (lo.L !== hi.L) {
          var bigUp = signedArea(hi.L.loop) > signedArea(lo.L.loop);
          var big = bigUp ? hi.L : lo.L, small = bigUp ? lo.L : hi.L;
          /* material above the step: outside, when the upper outline is the bigger; inside, the smaller */
          var down = outside ? bigUp : !bigUp;
          cap([big.loop, small.loop.slice().reverse()], lo.z, !down);
        }
      }
    }
    return { tri: tri, cap: cap, stack: stack, soup: function () { return new Float32Array(tri); } };
  }
  function soupVolume(s) {
    var v = 0;
    for (var i = 0; i < s.length; i += 9)
      v += (s[i] * (s[i + 4] * s[i + 8] - s[i + 5] * s[i + 7]) - s[i + 1] * (s[i + 3] * s[i + 8] - s[i + 5] * s[i + 6]) + s[i + 2] * (s[i + 3] * s[i + 7] - s[i + 4] * s[i + 6])) / 6;
    return v;
  }
  function shiftLoop(L, cx, cy) { return { loop: L.loop.map(function (p) { return [p[0] - cx, p[1] - cy]; }), marks: L.marks }; }
  function bbox(loop) {
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    loop.forEach(function (p) { lo[0] = Math.min(lo[0], p[0]); lo[1] = Math.min(lo[1], p[1]); hi[0] = Math.max(hi[0], p[0]); hi[1] = Math.max(hi[1], p[1]); });
    return { min: lo, max: hi, w: hi[0] - lo[0], d: hi[1] - lo[1] };
  }
  function bad(reason) { return { ok: false, reason: reason, at: null }; }

  function make(spec) {
    var o = outline(spec);
    if (!o.ok) return o;
    var sp = o.spec, H = sp.height, mode = sp.mode, lip = sp.lip, lid = sp.lid, ctx = o.ctx;
    var walled = mode !== 'solid';
    var F = mode === 'tray' ? sp.floor : 0;
    if (!(H > 0)) return bad('the height must be more than 0');
    if (mode === 'tray' && !(F > 0)) return bad('a tray needs a floor - give it a thickness, or choose Frame for no floor');
    if (mode === 'tray' && F >= H - 1e-6) return bad('the floor (' + fmt(F) + ' mm) is as thick as the tray is tall (' + fmt(H) + ' mm) - choose Solid for a filled piece');

    var O = { loop: o.outer, marks: o.outerLoop.marks }, I = walled ? { loop: o.inner, marks: o.innerLoop.marks } : null;
    var warnings = o.warnings.slice();

    /* ---- the lip: an outside flange (out) or an inside rim (in), lipH tall at the top, its underside a 45°
       chamfer (printable without support) unless that is turned off */
    var lipType = lip.type, w = lip.width, t = lip.height, ch = lip.chamfer;
    if (lipType === 'in' && !walled) lipType = 'none';               // a solid has no inside to have a rim on
    if (lipType !== 'none' && !(w > 0 && t > 0)) lipType = 'none';
    var OL = null, IL = null, under = ch ? w : 0;
    if (lipType === 'out') {
      OL = level(ctx, 'out', -w, 'the lip');
      if (!OL.ok) return bad(OL.reason);
      if (H - t - under < -1e-9) return bad('the lip (' + fmt(t) + ' mm' + (ch ? ' + its ' + fmt(w) + ' mm chamfer' : '') + ') is taller than the piece (' + fmt(H) + ' mm)' + (ch ? ' - turn the chamfer off, or make the lip thinner' : ''));
    } else if (lipType === 'in') {
      IL = level(ctx, 'in', w, 'the lip');
      if (!IL.ok) return bad(IL.reason + ' - make it narrower');
      if (!within(IL.loop, I.loop)) return bad('the lip turns over on itself - make it narrower');
      if (H - t - under < F - 1e-9) return bad('the lip (' + fmt(t) + ' mm' + (ch ? ' + its ' + fmt(w) + ' mm chamfer' : '') + ') reaches down past the ' + (mode === 'tray' ? 'floor' : 'bottom') + ' - make the piece taller or the lip thinner');
    }

    /* centre the footprint (the widest outline) on the origin, as a stock piece arrives */
    var foot = bbox((OL || O).loop), cx = (foot.min[0] + foot.max[0]) / 2, cy = (foot.min[1] + foot.max[1]) / 2;
    O = shiftLoop(O, cx, cy); if (I) I = shiftLoop(I, cx, cy);
    if (OL) OL = shiftLoop(OL, cx, cy); if (IL) IL = shiftLoop(IL, cx, cy);
    var topO = OL || O, topI = IL || I;

    var parts = [], body = null;
    try {
      if (lid.type !== 'only') {
        var W = writer();
        var outS = [{ L: O, z: 0 }];
        if (OL) { outS.push({ L: O, z: H - t - under }, { L: OL, z: H - t }, { L: OL, z: H }); }
        else outS.push({ L: O, z: H });
        W.stack(dedupeStack(outS), true);
        if (walled) {
          var inS = [{ L: I, z: F }];
          if (IL) { inS.push({ L: I, z: H - t - under }, { L: IL, z: H - t }, { L: IL, z: H }); }
          else inS.push({ L: I, z: H });
          W.stack(dedupeStack(inS), false);
          if (mode === 'tray') { W.cap([O.loop], 0, false); W.cap([I.loop], F, true); }
          else W.cap([O.loop, I.loop.slice().reverse()], 0, false);
          W.cap([topO.loop, topI.loop.slice().reverse()], H, true);
        } else {
          W.cap([O.loop], 0, false);
          W.cap([topO.loop], H, true);
        }
        var soup = W.soup(), bb = bbox(topO.loop.concat(O.loop));
        var text = MODE_NAME[mode] + ' ' + fmt(bb.w) + ' x ' + fmt(bb.d) + ' x ' + fmt(H) + ' mm';
        if (walled) text += ', wall ' + wallText(sp) + (mode === 'tray' ? ', floor ' + fmt(F) : '');
        if (lipType !== 'none') text += ', lip ' + (lipType === 'out' ? 'out ' : 'in ') + fmt(w) + ' x ' + fmt(t) + (ch ? ' chamfered' : '');
        body = { kind: 'body', label: 'custom ' + mode, soup: soup, text: text, volume: soupVolume(soup), size: [bb.w, bb.d, H] };
        parts.push(body);
      }

      /* ---- the lid: a plate the size of the top outline, printed face down, and a plug under it that fits
         the opening with `fit` all round (hollow, a `wall` thick ring, when there is room for one) */
      if (lid.type !== 'none') {
        if (!walled) return bad('a solid has no opening for a lid - choose Tray or Frame');
        var T0 = lid.thickness, D = lid.depth, c = lid.fit, pw = lid.wall;
        if (!(T0 > 0)) return bad('the lid needs a thickness');
        var room = H - F - (IL ? 0 : 0);
        if (D > room + 1e-9) return bad('the lid\'s plug (' + fmt(D) + ' mm) is deeper than the ' + (mode === 'tray' ? 'tray is inside' : 'frame is tall') + ' (' + fmt(room) + ' mm)');
        var eOpen = IL ? w : 0, PO = null, PI = null;
        if (D > 0) {
          PO = level(ctx, 'in', eOpen + c, 'the lid\'s plug');
          if (!PO.ok) return bad(PO.reason + ' - make the Fit smaller');
          if (pw > 0) {
            PI = level(ctx, 'in', eOpen + c + pw, 'the plug\'s hollow');
            if (!PI.ok || !within(PI.loop, PO.loop)) PI = null;              // no room for a hollow: a solid plug
          }
          PO = shiftLoop(PO, cx, cy); if (PI) PI = shiftLoop(PI, cx, cy);
        }
        var LW = writer();
        LW.stack([{ L: topO, z: 0 }, { L: topO, z: T0 }], true);
        LW.cap([topO.loop], 0, false);
        if (PO) {
          LW.cap([topO.loop, PO.loop.slice().reverse()], T0, true);
          LW.stack([{ L: PO, z: T0 }, { L: PO, z: T0 + D }], true);
          if (PI) {
            LW.stack([{ L: PI, z: T0 }, { L: PI, z: T0 + D }], false);
            LW.cap([PO.loop, PI.loop.slice().reverse()], T0 + D, true);
            LW.cap([PI.loop], T0, true);
          } else LW.cap([PO.loop], T0 + D, true);
        } else LW.cap([topO.loop], T0, true);
        var ls = LW.soup(), lb = bbox(topO.loop);
        var ltext = 'Lid ' + fmt(lb.w) + ' x ' + fmt(lb.d) + ' x ' + fmt(T0) + ' mm' +
          (PO ? ', ' + (PI ? 'hollow' : 'solid') + ' plug ' + fmt(D) + ' mm deep, ' + fmt(c) + ' mm fit' : ', flat');
        if (PO && pw > 0 && !PI) warnings.push('the opening is too narrow for a hollow plug - it is solid');
        parts.push({ kind: 'lid', label: 'custom lid', soup: ls, text: ltext, volume: soupVolume(ls), size: [lb.w, lb.d, T0 + D] });
      }
    } catch (e) {
      return bad((e && e.message) || String(e));
    }

    var info = o.info;
    info.height = H; info.mode = mode; info.floor = F; info.minWall = o.minWall != null ? o.minWall : null;
    info.lip = lipType; info.lid = lid.type;
    if (body) { info.volume = body.volume; info.triangles = body.soup.length / 9; info.width = body.size[0]; info.depth = body.size[1]; }
    else { info.volume = parts[0].volume; info.triangles = parts[0].soup.length / 9; }
    return {
      ok: true, parts: parts, soup: parts[0].soup, shift: [cx, cy], outer: O.loop, inner: I ? I.loop : null, lipOuter: OL ? OL.loop : null, lipInner: IL ? IL.loop : null,
      info: info, text: parts.map(function (q) { return q.text; }).join(' + '), warnings: warnings, spec: sp
    };
  }
  /* drop entries that add nothing: the same outline twice at one height (a chamfer of 0, a body of 0 below a lip) */
  function dedupeStack(list) {
    var out = [];
    list.forEach(function (e) {
      var q = out[out.length - 1];
      if (q && q.L === e.L && Math.abs(q.z - e.z) < 1e-9) return;
      out.push(e);
    });
    return out;
  }
  var MODE_NAME = { tray: 'Tray', frame: 'Frame', solid: 'Solid' };
  function wallText(sp) {
    var lo = Infinity, hi = -Infinity;
    sp.sides.forEach(function (s) { lo = Math.min(lo, s.wall); hi = Math.max(hi, s.wall); });
    return Math.abs(hi - lo) < 1e-9 ? fmt(lo) : fmt(lo) + '-' + fmt(hi);
  }

  /* ------------------------------------------------------------- grow / shrink
     The whole outline moved out by d (in, when d < 0) - its EXACT offset, kept editable: every point goes to
     where its two sides, moved, now meet; an outside corner's radius grows by d, a turned-in one's shrinks
     (never under 0); a curved side stays on its own circle's offset, re-cut between the new points. Walls and
     everything else are kept. -> { ok, spec } or { ok: false, reason }. */
  function offsetSpec(spec, d) {
    var sp = normalize(spec), why = basicChecks(sp);
    if (why) return { ok: false, reason: why };
    if (!d) return { ok: true, spec: sp };
    var ol = outline(Object.assign({}, sp, { mode: 'solid' }));
    if (!ol.ok) return { ok: false, reason: ol.reason };
    var o = ol.ctx.o, S = ol.ctx.S, n = o.P.length, j, NP = [];
    for (j = 0; j < n; j++) {
      var c = corner(S[(j + n - 1) % n], S[j], o.P[j], -d, -d, 0);
      if (!c) return { ok: false, reason: 'point ' + (o.ix[j] + 1) + ' has nowhere to go once the outline is moved ' + fmt(Math.abs(d)) + ' mm ' + (d > 0 ? 'out' : 'in') };
      NP.push(c.c);
    }
    /* every side must still run the way it ran: one that turned round has been used up */
    for (j = 0; j < n; j++) {
      var a0 = o.P[j], b0 = o.P[(j + 1) % n], a1 = NP[j], b1 = NP[(j + 1) % n];
      if ((b1[0] - a1[0]) * (b0[0] - a0[0]) + (b1[1] - a1[1]) * (b0[1] - a0[1]) <= 0)
        return { ok: false, reason: 'side ' + (o.sx[j] + 1) + ' is used up once the outline is moved ' + fmt(Math.abs(d)) + ' mm in - the shape is too small for that' };
    }
    var out = normalize(sp);
    for (j = 0; j < n; j++) {
      var u = o.ix[j], p = out.points[u];
      p.x = round2(NP[j][0]); p.y = round2(NP[j][1]);
      p.r = round2(conc(o.pt[j].r, -d, ol.ctx.conv[j]));
    }
    for (j = 0; j < n; j++) {
      var side = S[j], us = o.sx[j];
      if (side.line) continue;
      var R2 = side.R + side.k * d, a = NP[j], b = NP[(j + 1) % n], h = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
      if (!(R2 > h)) return { ok: false, reason: 'side ' + (us + 1) + "'s curve closes up once the outline is moved " + fmt(Math.abs(d)) + ' mm in' };
      out.sides[us].bulge = round2(side.k * (R2 - Math.sqrt(R2 * R2 - h * h)));
    }
    var check = outline(Object.assign({}, out, { mode: 'solid' }));
    if (!check.ok) return { ok: false, reason: 'moved ' + fmt(Math.abs(d)) + ' mm ' + (d > 0 ? 'out' : 'in') + ', ' + check.reason };
    return { ok: true, spec: out };
  }
  function round2(x) { return Math.round(x * 100) / 100; }

  /* ------------------------------------------------------------- measurements (calipers)
     A side's LENGTH is point to point: where its two neighbouring sides meet, as if the corners were sharp -
     what calipers read across a box-like piece whatever its corner radii, and on a curved side its chord.

     setSideLength(spec, i, L, how) gives side i (the user's number, from 0) that length:
       'stretch' (the default)  the shape is cut across the side's middle and the far half pulled along the
                                side: every point past the middle moves by the change, so a rectangle stays a
                                rectangle, an L keeps its notch, and the sides that cross the cut take it up
       'end'                    only the side's end point moves, along the side
       'start'                  only its start point moves, back along the side
     setExtent(spec, 'x' | 'y', W) stretches the outline the same way across its own middle until the outline
     as built - corners, curves and all - is W across. Both -> { ok, spec } or { ok: false, reason }; the spec
     comes back whether or not it makes a valid outline (the editor says what is wrong, and Ctrl+Z is there). */
  function sideLengthOf(spec, i) {
    var sp = normalize(spec), n = sp.points.length;
    if (i < 0 || i >= n) return 0;
    var a = sp.points[i], b = sp.points[(i + 1) % n];
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
  function stretchAlong(sp, mid, d, delta) {
    sp.points.forEach(function (p) {
      if ((p.x - mid[0]) * d[0] + (p.y - mid[1]) * d[1] > 1e-6) { p.x = round2(p.x + d[0] * delta); p.y = round2(p.y + d[1] * delta); }
    });
  }
  function setSideLength(spec, i, L, how) {
    var sp = normalize(spec), n = sp.points.length;
    if (i < 0 || i >= n) return { ok: false, reason: 'there is no side ' + (i + 1) };
    L = +L;
    if (!(L >= 0.01)) return { ok: false, reason: 'a side must be longer than 0 mm' };
    var a = sp.points[i], b = sp.points[(i + 1) % n], len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) return { ok: false, reason: 'side ' + (i + 1) + "'s points are on top of each other - move one first" };
    var d = [(b.x - a.x) / len, (b.y - a.y) / len];
    if (how === 'end') { b.x = round2(a.x + d[0] * L); b.y = round2(a.y + d[1] * L); }
    else if (how === 'start') { a.x = round2(b.x - d[0] * L); a.y = round2(b.y - d[1] * L); }
    else {
      var delta = L - len;
      if (delta < 0) {
        /* shrinking: a point past the cut may not be pulled back across it */
        var room = Infinity, mid0 = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        sp.points.forEach(function (p) { var t = (p.x - mid0[0]) * d[0] + (p.y - mid0[1]) * d[1]; if (t > 1e-6) room = Math.min(room, t); });
        if (-delta >= room - 1e-6) return { ok: false, reason: 'side ' + (i + 1) + ' cannot be stretched down to ' + fmt(L) + ' mm - the shape across its middle would fold over (the most it can lose is ' + fmt(room) + ' mm). Move only its end point instead' };
      }
      stretchAlong(sp, [(a.x + b.x) / 2, (a.y + b.y) / 2], d, delta);
    }
    return { ok: true, spec: sp, was: len };
  }
  function setExtent(spec, axis, W) {
    var sp = normalize(spec), k = axis === 'y' ? 1 : 0, d = k ? [0, 1] : [1, 0];
    W = +W;
    if (!(W >= 0.1)) return { ok: false, reason: 'the size must be more than 0' };
    var o = outline(Object.assign({}, sp, { mode: 'solid' }));
    if (!o.ok) return { ok: false, reason: 'the outline is not valid yet: ' + o.reason };
    var was = k ? o.info.depth : o.info.width;
    /* stretch across the outline's own middle; a curve crossing the cut can bend the extent a little, so
       measure and correct, a few times */
    for (var it = 0; it < 4; it++) {
      var cur = k ? o.info.depth : o.info.width, delta = W - cur;
      if (Math.abs(delta) < 0.005) break;
      var mid = [(o.info.min[0] + o.info.max[0]) / 2, (o.info.min[1] + o.info.max[1]) / 2], room = Infinity;
      sp.points.forEach(function (p) { var t = (k ? p.y : p.x) - mid[k]; if (t > 1e-6) room = Math.min(room, t); });
      if (delta < 0 && -delta >= room - 1e-6) return { ok: false, reason: 'it cannot be made ' + fmt(W) + ' mm ' + (k ? 'deep' : 'wide') + ' by stretching - points past its middle would cross it (the most it can lose is ' + fmt(room) + ' mm)' };
      stretchAlong(sp, mid, d, delta);
      o = outline(Object.assign({}, sp, { mode: 'solid' }));
      if (!o.ok) return { ok: true, spec: sp, was: was };       // made as asked; the editor says what is wrong
    }
    return { ok: true, spec: sp, was: was };
  }

  /* ------------------------------------------------------------- an outline from points
     fromLoop(points, { tol, wall }): a closed run of points - a section of a mesh, a trace - made into a spec
     the editor can work with, every side within `tol` mm (default 0.2) of the points:
       1. every edge is cut into pieces no longer than `tol` (a long straight side then has points of its own
          to say it is straight; a facet's section has one more on every diagonal, which says nothing)
       2. the STRAIGHT RUNS: every stretch at least STRAIGHT_MIN mm long that lies within tol of one line
       3. each GAP between two straight runs is
            - nothing (a sharp corner): one point, where the two lines meet
            - one arc tangent to both lines (a fillet): one point where the lines meet, with the arc's radius
              as its Radius - a rounded corner, as the editor makes one
            - otherwise a chain of arcs (least-squares circles, each within tol and at most ~150°) and short
              straight sides, each a side of its own
       4. a loop with no straight run (a disc, an ellipse, a blob) is the chain of 3 alone
     It is moved so its lowest-left corner is at (0, 0). -> { ok, spec, shift: [dx, dy], info } or { ok: false, reason } */
  var STRAIGHT_MIN = 3;
  function fromLoop(pts, opts) {
    opts = opts || {};
    var tol = Math.max(0.01, num(opts.tol, 0.2)), wall = num(opts.wall, DEFAULTS.wall), i, k;
    var P0 = [];
    (pts || []).forEach(function (p) {
      var q = P0[P0.length - 1];
      if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) P0.push([+p[0], +p[1]]);
    });
    while (P0.length > 1 && Math.hypot(P0[0][0] - P0[P0.length - 1][0], P0[0][1] - P0[P0.length - 1][1]) <= 1e-6) P0.pop();
    if (P0.length < 3) return { ok: false, reason: 'the outline has fewer than 3 points' };
    if (signedArea(P0) < 0) P0.reverse();
    if (!(signedArea(P0) > 0.01)) return { ok: false, reason: 'the outline encloses no area' };

    /* 1. densify; start at the longest edge, which on a faceted mesh is a straight side */
    var per = 0, longest = -1, st = 0;
    for (i = 0; i < P0.length; i++) {
      var el = Math.hypot(P0[(i + 1) % P0.length][0] - P0[i][0], P0[(i + 1) % P0.length][1] - P0[i][1]);
      per += el; if (el > longest) { longest = el; st = i; }
    }
    var hstep = Math.max(tol, per / 6000), P = [];
    for (i = 0; i < P0.length; i++) {
      var A0 = P0[(st + i) % P0.length], B0 = P0[(st + i + 1) % P0.length], m = Math.max(1, Math.ceil(Math.hypot(B0[0] - A0[0], B0[1] - A0[1]) / hstep));
      for (k = 0; k < m; k++) P.push([A0[0] + (B0[0] - A0[0]) * k / m, A0[1] + (B0[1] - A0[1]) * k / m]);
    }
    var N = P.length;
    function pt(q) { return P[((q % N) + N) % N]; }
    function arcLen(ia, ib) { var L = 0; for (var q = ia + 1; q <= ib; q++) L += Math.hypot(pt(q)[0] - pt(q - 1)[0], pt(q)[1] - pt(q - 1)[1]); return L; }
    function segDist(p, a, b) {
      var vx = b[0] - a[0], vy = b[1] - a[1], ll = vx * vx + vy * vy;
      var t = ll > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / ll)) : 0;
      return Math.hypot(a[0] + vx * t - p[0], a[1] + vy * t - p[1]);
    }
    function lineFit(ia, ib) {
      var A = pt(ia), B = pt(ib);
      if (Math.hypot(B[0] - A[0], B[1] - A[1]) < 1e-9) return false;
      for (var q = ia + 1; q < ib; q++) if (segDist(pt(q), A, B) > tol) return false;
      return true;
    }
    /* least-squares line through a run: its mean and direction (the run's own way) */
    function lineLS(ia, ib) {
      var n0 = ib - ia + 1, mx = 0, my = 0, q;
      for (q = ia; q <= ib; q++) { mx += pt(q)[0]; my += pt(q)[1]; }
      mx /= n0; my /= n0;
      var sxx = 0, sxy = 0, syy = 0;
      for (q = ia; q <= ib; q++) { var x = pt(q)[0] - mx, y = pt(q)[1] - my; sxx += x * x; sxy += x * y; syy += y * y; }
      var ang = 0.5 * Math.atan2(2 * sxy, sxx - syy), d = [Math.cos(ang), Math.sin(ang)];
      var run = [pt(ib)[0] - pt(ia)[0], pt(ib)[1] - pt(ia)[1]];
      if (d[0] * run[0] + d[1] * run[1] < 0) d = [-d[0], -d[1]];
      return { p: [mx, my], d: d };
    }
    function onLine(L, p) { var t = (p[0] - L.p[0]) * L.d[0] + (p[1] - L.p[1]) * L.d[1]; return [L.p[0] + L.d[0] * t, L.p[1] + L.d[1] * t]; }
    function meet(L1, L2) {
      var den = L1.d[0] * L2.d[1] - L1.d[1] * L2.d[0];
      if (Math.abs(den) < 1e-6) return null;
      var t = ((L2.p[0] - L1.p[0]) * L2.d[1] - (L2.p[1] - L1.p[1]) * L2.d[0]) / den;
      return [L1.p[0] + L1.d[0] * t, L1.p[1] + L1.d[1] * t];
    }
    /* least-squares circle (Kasa) through a run, about its mean for conditioning */
    function circleFit(ia, ib) {
      var n0 = ib - ia + 1, mx = 0, my = 0, q;
      if (n0 < 3) return null;
      for (q = ia; q <= ib; q++) { mx += pt(q)[0]; my += pt(q)[1]; }
      mx /= n0; my /= n0;
      var Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, Sxz = 0, Syz = 0, Sz = 0;
      for (q = ia; q <= ib; q++) {
        var x = pt(q)[0] - mx, y = pt(q)[1] - my, z = x * x + y * y;
        Sxx += x * x; Sxy += x * y; Syy += y * y; Sx += x; Sy += y; Sxz += x * z; Syz += y * z; Sz += z;
      }
      var M = [[Sxx, Sxy, Sx, -Sxz], [Sxy, Syy, Sy, -Syz], [Sx, Sy, n0, -Sz]];
      for (var c0 = 0; c0 < 3; c0++) {
        var piv = c0;
        for (var r0 = c0 + 1; r0 < 3; r0++) if (Math.abs(M[r0][c0]) > Math.abs(M[piv][c0])) piv = r0;
        var tmp = M[c0]; M[c0] = M[piv]; M[piv] = tmp;
        if (Math.abs(M[c0][c0]) < 1e-12) return null;
        for (var r1 = 0; r1 < 3; r1++) if (r1 !== c0) {
          var f = M[r1][c0] / M[c0][c0];
          for (var c1 = c0; c1 < 4; c1++) M[r1][c1] -= f * M[c0][c1];
        }
      }
      var D = M[0][3] / M[0][0], E = M[1][3] / M[1][1], F = M[2][3] / M[2][2], R2 = D * D / 4 + E * E / 4 - F;
      if (!(R2 > 0)) return null;
      return { c: [mx - D / 2, my - E / 2], R: Math.sqrt(R2) };
    }
    /* an arc through a run: within tol, turning one way, at most ~150°, and (unless `loose`) not as good as
       straight. `loose` is for the search, where short runs must pass so a longer one can be tried. */
    function arcFit(ia, ib, loose) {
      if (ib - ia < 2) return loose ? {} : null;
      var C = circleFit(ia, ib);
      if (!C) return loose && lineFit(ia, ib) ? {} : null;   // points in a line: a circle of no curvature, for the search
      var q;
      for (q = ia; q <= ib; q++) if (Math.abs(Math.hypot(pt(q)[0] - C.c[0], pt(q)[1] - C.c[1]) - C.R) > tol) return null;
      var sweep = 0;
      for (q = ia + 1; q <= ib; q++) {
        var u = [pt(q - 1)[0] - C.c[0], pt(q - 1)[1] - C.c[1]], v = [pt(q)[0] - C.c[0], pt(q)[1] - C.c[1]];
        sweep += Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]);
      }
      if (Math.abs(sweep) > 2.62) return null;                                     // ~150°: a full circle is 3 arcs
      if (!loose && C.R * (1 - Math.cos(sweep / 2)) < 2 * tol) return null;      // as good as straight
      return { c: C.c, R: C.R, ccw: sweep > 0 };
    }
    function furthest(ia, limit, ok) {
      var good = -1, step = 1, e = ia + 1;
      while (e <= limit && ok(ia, e)) { good = e; step *= 2; e = ia + step; }
      var lo = good < 0 ? ia : good, hi = Math.min(e, limit + 1);
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (ok(ia, mid)) lo = mid; else hi = mid; }
      return lo > ia ? lo : -1;
    }

    /* 2. straight runs. Within tol of a line is not enough - a short stretch of any arc is that - so a run is
       straight only when a line explains it about as well as the best circle does (a straight side: both near
       0, or both the scan's noise; a piece of a fillet: the line is off by its sag, the circle by nothing). */
    function devCircle(ia, ib) {
      var C = circleFit(ia, ib), m = 0;
      if (!C) return Infinity;
      for (var q = ia; q <= ib; q++) m = Math.max(m, Math.abs(Math.hypot(pt(q)[0] - C.c[0], pt(q)[1] - C.c[1]) - C.R));
      return m;
    }
    /* straight: long enough, and the best circle through it bows no more than its own leftover error (or a
       tenth of tol) - a line's best circle is nearly flat; a piece of a gentle arc bows clearly, even when
       facets put the arc's points a little off it */
    function straight(ia, ib) {
      if (arcLen(ia, ib) < STRAIGHT_MIN) return false;
      var C = circleFit(ia, ib);
      if (!C) return true;                            // in a line exactly
      var h = Math.hypot(pt(ib)[0] - pt(ia)[0], pt(ib)[1] - pt(ia)[1]) / 2;
      var bow = C.R > h ? C.R - Math.sqrt(C.R * C.R - h * h) : C.R;
      return bow <= Math.max(2 * devCircle(ia, ib), 0.1 * tol);
    }
    /* runs are walked at half of tol (an arc's tail passes for straight for a shorter way), and a run
       found takes the first bit of each fillet beside it all the same: trim each end back to the points on
       the run's own best line - within the noise of its middle half, or a tenth of tol - so the line is the
       side's and the fillet is whole. */
    var tolS = tol / 2;
    function lineFitS(ia, ib) {
      var A = pt(ia), B = pt(ib);
      if (Math.hypot(B[0] - A[0], B[1] - A[1]) < 1e-9) return false;
      for (var q = ia + 1; q < ib; q++) if (segDist(pt(q), A, B) > tolS) return false;
      return true;
    }
    function trim(r) {
      for (var pass = 0; pass < 3; pass++) {
        var L = lineLS(r.a, r.b), q, res = [];
        for (q = r.a; q <= r.b; q++) res.push(Math.abs((pt(q)[0] - L.p[0]) * L.d[1] - (pt(q)[1] - L.p[1]) * L.d[0]));
        var n0 = res.length, mid = res.slice(Math.floor(n0 / 4), Math.ceil(3 * n0 / 4)), rms = 0;
        mid.forEach(function (v) { rms += v * v; });
        rms = Math.sqrt(rms / Math.max(1, mid.length));
        var thr = Math.max(0.1 * tol, 3 * rms), a2 = r.a, b2 = r.b;
        while (b2 - a2 > 2 && res[a2 - r.a] > thr) a2++;
        while (b2 - a2 > 2 && res[b2 - r.a] > thr) b2--;
        if (a2 === r.a && b2 === r.b) break;
        r.a = a2; r.b = b2;
      }
      return r;
    }
    /* The first run may have begun before the start: walk it back so it is whole. */
    var start = 0, e0 = furthest(0, N, lineFitS);
    if (e0 > 0 && arcLen(0, e0) >= STRAIGHT_MIN) {
      var back = 0;
      while (back < N - e0 - 1 && lineFitS(-(back + 1), e0)) back++;
      start = -back;
    }
    var runs = [], pos = start, end = start + N;
    while (pos < end) {
      var e = furthest(pos, end, lineFitS);
      var r0 = e > pos ? trim({ a: pos, b: e }) : null;
      if (r0 && straight(r0.a, r0.b)) { runs.push(r0); pos = e; }
      else pos++;
    }
    /* two runs one after the other on one line are one run */
    for (var mg = runs.length - 1; mg > 0; mg--) {
      var r1 = runs[mg - 1], r2 = runs[mg];
      if (r2.a - r1.b > 3) continue;
      var m2 = trim({ a: r1.a, b: r2.b });             // trimmed first: one of the two may start in a fillet's tail
      if (lineFitS(m2.a, m2.b) && m2.b - m2.a >= Math.max(r1.b - r1.a, r2.b - r2.a)) runs.splice(mg - 1, 2, m2);
    }
    /* a run that reaches the end and one that begins at the start are one run, if they are straight together */
    if (runs.length > 1 && runs[runs.length - 1].b >= end && runs[0].a === start) {
      var last = runs[runs.length - 1];
      if (lineFitS(last.a, runs[0].b + N)) { runs[0] = trim({ a: last.a - N, b: runs[0].b }); runs.pop(); }
    }

    /* 3. chains: arcs and short straight sides for a stretch of points, greedily */
    function chain(ia, ib) {
      var out = [], q = ia;
      while (q < ib) {
        var eA = furthest(q, ib, function (x, y) { return !!arcFit(x, y, true); });
        var fit = eA > q ? arcFit(q, eA) : null;
        if (fit) { out.push({ a: q, b: eA, arc: fit }); q = eA; continue; }
        var eL = furthest(q, ib, lineFit);
        if (eL <= q) eL = q + 1;
        out.push({ a: q, b: eL, arc: null });
        q = eL;
      }
      return out;
    }
    function bulgeOf(arc, A, B) {
      var h = Math.hypot(B[0] - A[0], B[1] - A[1]) / 2;
      if (!(h > 1e-9) || arc.R <= h) return 0;
      var sag = arc.R - Math.sqrt(arc.R * arc.R - h * h);
      return (arc.ccw ? 1 : -1) * sag;                // counter-clockwise round its centre: bowed out
    }

    var V = [], SD = [], rounded = 0;                 // vertices { x, y, r } and the side from each to the next
    function addV(p, r) { V.push({ x: p[0], y: p[1], r: r || 0 }); }
    if (!runs.length) {
      var ch = chain(0, N);
      ch.forEach(function (c) { addV(pt(c.a)); SD.push(c.arc ? bulgeOf(c.arc, pt(c.a), pt(c.b)) : 0); });
    } else {
      var lines = runs.map(function (r) { return lineLS(r.a, r.b); }), K = runs.length;
      /* each gap: a corner (X, r) or a chain */
      var gaps = runs.map(function (r, j) {
        var nx = runs[(j + 1) % K], ga = r.b, gb = nx.a + (j === K - 1 ? N : 0);
        var L1 = lines[j], L2 = lines[(j + 1) % K], X = meet(L1, L2);
        if (gb - ga <= 1 && X) return { corner: X, r: 0 };
        var fit = gb - ga >= 2 ? arcFit(ga, gb) : null;
        if (fit && X) {
          var d1 = Math.abs((fit.c[0] - L1.p[0]) * L1.d[1] - (fit.c[1] - L1.p[1]) * L1.d[0]);
          var d2 = Math.abs((fit.c[0] - L2.p[0]) * L2.d[1] - (fit.c[1] - L2.p[1]) * L2.d[0]);
          var slack = Math.max(2 * tol, 0.03 * fit.R);
          if (Math.abs(d1 - fit.R) <= slack && Math.abs(d2 - fit.R) <= slack) return { corner: X, r: Math.round(fit.R * 10) / 10, arc: true };
        }
        return { chain: chain(ga, gb), ga: ga, gb: gb };
      });
      for (var j = 0; j < K; j++) {
        var pg = gaps[(j + K - 1) % K], g = gaps[j], L = lines[j];
        if (pg.corner) addV(pg.corner, pg.r); else addV(onLine(L, pt(runs[j].a)));
        SD.push(0);                                   // the straight run
        if (g.corner) { if (g.arc) rounded++; continue; }
        addV(onLine(L, pt(runs[j].b)));
        var nextStart = onLine(lines[(j + 1) % K], pt(g.gb));
        g.chain.forEach(function (c, q) {
          var A = q === 0 ? onLine(L, pt(runs[j].b)) : pt(c.a), B = q === g.chain.length - 1 ? nextStart : pt(c.b);
          SD.push(c.arc ? bulgeOf(c.arc, A, B) : 0);
          if (q < g.chain.length - 1) addV(pt(c.b));
        });
      }
    }
    /* points closer than 0.05 mm are one */
    for (i = V.length - 1; i >= 0 && V.length > 3; i--) {
      var nb = V[(i + 1) % V.length];
      if (Math.hypot(nb.x - V[i].x, nb.y - V[i].y) < 0.05) { nb.r = Math.max(nb.r, V[i].r); V.splice(i, 1); SD.splice(i, 1); }
    }
    if (V.length < 3) return { ok: false, reason: 'the outline came out as fewer than 3 points - try a finer Detail' };
    var lo = [Infinity, Infinity];
    V.forEach(function (p) { lo[0] = Math.min(lo[0], p.x); lo[1] = Math.min(lo[1], p.y); });
    var spec = {
      points: V.map(function (p) { return { x: round2(p.x - lo[0]), y: round2(p.y - lo[1]), r: p.r, rIn: null }; }),
      sides: SD.map(function (b2) { return { wall: wall, bulge: round2(b2) }; })
    };
    var res = outline(Object.assign({}, spec, { mode: 'solid' }));
    if (!res.ok) return { ok: false, reason: 'the outline read could not be rebuilt (' + res.reason + ') - try a different Detail' };
    return { ok: true, spec: spec, shift: [-lo[0], -lo[1]],
             info: { points: spec.points.length, curved: spec.sides.filter(function (s3) { return s3.bulge; }).length, rounded: rounded, from: P0.length,
                     areaFrom: signedArea(P0), area: res.info.areaOut } };
  }

  /* ------------------------------------------------------------- presets */
  function P(x, y, r) { return { x: x, y: y, r: r, rIn: null }; }
  function evenSides(n, wall) { var s = []; for (var i = 0; i < n; i++) s.push({ wall: wall, bulge: 0 }); return s; }
  var PRESETS = {
    rect: function () { return { points: [P(0, 0, 0), P(80, 0, 0), P(80, 50, 0), P(0, 50, 0)], sides: evenSides(4, 2), height: 25, floor: 2, mode: 'tray' }; },
    rounded: function () { return { points: [P(0, 0, 8), P(80, 0, 8), P(80, 50, 8), P(0, 50, 8)], sides: evenSides(4, 2), height: 25, floor: 2, mode: 'tray' }; },
    /* a tray with one corner swept off in a long curve - a console or door-pocket insert */
    scoop: function () {
      var s = evenSides(5, 2.5);
      s[4].bulge = 6;
      return { points: [P(0, 50, 12), P(0, 160, 8), P(70, 160, 8), P(70, 0, 8), P(30, 0, 14)], sides: s, height: 30, floor: 2, mode: 'tray' };
    },
    lshape: function () { return { points: [P(0, 0, 4), P(90, 0, 4), P(90, 35, 4), P(35, 35, 4), P(35, 80, 4), P(0, 80, 4)], sides: evenSides(6, 2), height: 25, floor: 2, mode: 'tray' }; },
    trapezoid: function () { return { points: [P(0, 0, 5), P(90, 0, 5), P(70, 50, 5), P(20, 50, 5)], sides: evenSides(4, 2), height: 25, floor: 2, mode: 'tray' }; },
    hexagon: function () {
      var pts = [];
      for (var i = 0; i < 6; i++) { var a = Math.PI / 6 + i * Math.PI / 3; pts.push(P(Math.round(40 * Math.cos(a) * 100) / 100, Math.round(40 * Math.sin(a) * 100) / 100, 4)); }
      return { points: pts, sides: evenSides(6, 2), height: 25, floor: 2, mode: 'tray' };
    }
  };
  function preset(name) { return PRESETS[name] ? normalize(PRESETS[name]()) : null; }

  var API = {
    normalize: normalize, outline: outline, make: make, maxRadius: maxRadius, preset: preset,
    offsetSpec: offsetSpec, fromLoop: fromLoop, setSideLength: setSideLength, sideLength: sideLengthOf, setExtent: setExtent,
    PRESETS: Object.keys(PRESETS), MODES: MODES.slice(), LIP_TYPES: LIP_TYPES.slice(), LID_TYPES: LID_TYPES.slice(), DEFAULTS: DEFAULTS, WALL_NOZZLES: WALL_NOZZLES,
    signedArea: signedArea, fmt: fmt
  };
  root.NSO_CustomShape = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
