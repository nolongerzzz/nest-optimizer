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
  var DEFAULTS = { height: 30, floor: 2, wall: 2, r: 5, mode: 'tray', nozzle: 0.4 };
  var MODES = ['tray', 'frame', 'solid'];

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
    return {
      points: pts, sides: sides, mode: mode,
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
    var out = [];
    for (i = 0; i < n; i++) {
      var co2 = C[i], S = sides[i], M = moved(S, dist[i]);
      /* the corner's fillet, ta -> tb */
      if (co2.rho > 0) {
        var a0 = Math.atan2(co2.ta[1] - co2.c[1], co2.ta[0] - co2.c[0]);
        var a1 = Math.atan2(co2.tb[1] - co2.c[1], co2.tb[0] - co2.c[0]);
        var sw = a1 - a0;
        if (co2.convex) { while (sw < 0) sw += 2 * Math.PI; } else { while (sw > 0) sw -= 2 * Math.PI; }
        var tmp = [];
        arcPoints(co2.c, co2.rho, a0, sw, tmp, true);
        tmp.forEach(function (p) { push(out, p); });
      } else push(out, co2.c);
      /* then the side, to the next corner's ta */
      var end = C[(i + 1) % n].ta;
      if (!S.line) {
        var b0 = Math.atan2(co2.tb[1] - M.c[1], co2.tb[0] - M.c[0]);
        var b1 = Math.atan2(end[1] - M.c[1], end[0] - M.c[0]);
        var sw2 = b1 - b0;
        if (S.dir > 0) { while (sw2 < 0) sw2 += 2 * Math.PI; } else { while (sw2 > 0) sw2 -= 2 * Math.PI; }
        if (Math.abs(sw2) > 1e-9 && M.R > 0) {
          var t2 = [];
          arcPoints(M.c, M.R, b0, sw2, t2, false);
          t2.forEach(function (p) { push(out, p); });
        }
      }
    }
    if (out.length > 1) {
      var f = out[0], l = out[out.length - 1];
      if (Math.hypot(f[0] - l[0], f[1] - l[1]) <= 1e-7) out.pop();
    }
    return { ok: true, loop: out, corners: C };
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
    return res;
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

  function make(spec) {
    var o = outline(spec);
    if (!o.ok) return o;
    var sp = o.spec, H = sp.height, mode = sp.mode;
    var F = mode === 'tray' ? sp.floor : 0;
    if (!(H > 0)) return { ok: false, reason: 'the height must be more than 0', at: null };
    if (mode === 'tray' && !(F > 0)) return { ok: false, reason: 'a tray needs a floor - give it a thickness, or choose Frame for no floor', at: null };
    if (mode === 'tray' && F >= H - 1e-6) return { ok: false, reason: 'the floor (' + fmt(F) + ' mm) is as thick as the tray is tall (' + fmt(H) + ' mm) - choose Solid for a filled piece', at: null };

    /* centre the footprint on the origin, as a stock piece arrives */
    var cx = (o.info.min[0] + o.info.max[0]) / 2, cy = (o.info.min[1] + o.info.max[1]) / 2;
    var shift = function (L) { return L.map(function (p) { return [p[0] - cx, p[1] - cy]; }); };
    var O = shift(o.outer), I = o.inner ? shift(o.inner) : null;

    var tri = [];
    function T(a, za, b, zb, c, zc) { tri.push(a[0], a[1], za, b[0], b[1], zb, c[0], c[1], zc); }
    function cap(t, z, up) {
      for (var i = 0; i < t.tris.length; i += 3) {
        var a = t.pts[t.tris[i]], b = t.pts[t.tris[i + 1]], c = t.pts[t.tris[i + 2]];
        if (up) T(a, z, b, z, c, z); else T(a, z, c, z, b, z);
      }
    }
    function wall(L, z0, z1, outward) {
      for (var i = 0; i < L.length; i++) {
        var p = L[i], q = L[(i + 1) % L.length];
        if (outward) { T(p, z0, q, z0, q, z1); T(p, z0, q, z1, p, z1); }
        else { T(p, z0, q, z1, q, z0); T(p, z0, p, z1, q, z1); }
      }
    }
    try {
      var full = triangulate([O]);
      var ring = I ? triangulate([O, I.slice().reverse()]) : null;
      if (mode === 'solid') {
        cap(full, 0, false); cap(full, H, true); wall(O, 0, H, true);
      } else if (mode === 'frame') {
        cap(ring, 0, false); cap(ring, H, true); wall(O, 0, H, true); wall(I, 0, H, false);
      } else {
        cap(full, 0, false); cap(ring, H, true); wall(O, 0, H, true); wall(I, F, H, false);
        cap(triangulate([I]), F, true);
      }
    } catch (e) {
      return { ok: false, reason: (e && e.message) || String(e), at: null };
    }
    var soup = new Float32Array(tri);
    var vol = o.info.areaOut * H - (mode === 'solid' ? 0 : o.info.areaIn * (H - F));
    var info = o.info;
    info.height = H; info.volume = vol; info.triangles = soup.length / 9; info.minWall = o.minWall != null ? o.minWall : null;
    info.mode = mode; info.floor = F;
    var text = MODE_NAME[mode] + ' ' + fmt(info.width) + ' x ' + fmt(info.depth) + ' x ' + fmt(H) + ' mm';
    if (mode !== 'solid') text += ', wall ' + wallText(sp) + (mode === 'tray' ? ', floor ' + fmt(F) : '');
    return { ok: true, soup: soup, outer: O, inner: I, info: info, text: text, warnings: o.warnings, spec: sp };
  }
  var MODE_NAME = { tray: 'Tray', frame: 'Frame', solid: 'Solid' };
  function wallText(sp) {
    var lo = Infinity, hi = -Infinity;
    sp.sides.forEach(function (s) { lo = Math.min(lo, s.wall); hi = Math.max(hi, s.wall); });
    return Math.abs(hi - lo) < 1e-9 ? fmt(lo) : fmt(lo) + '-' + fmt(hi);
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
    PRESETS: Object.keys(PRESETS), MODES: MODES.slice(), DEFAULTS: DEFAULTS, WALL_NOZZLES: WALL_NOZZLES,
    signedArea: signedArea, fmt: fmt
  };
  root.NSO_CustomShape = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
