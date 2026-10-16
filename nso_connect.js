/* nso_connect.js - Connect: build a connector between two anchors, and either
   weld it into the pieces it joins or keep it as a piece of its own.
   docs/CONNECT.md.

   Bridge (nso_bridge.js) is the quick gap-fill: what is picked decides the
   shape. Connect is the builder: the two anchors are only WHERE, the card
   decides WHAT runs between them.

   Loads as a classic script (window.NSO_Connect) and as a Node module. No DOM,
   no THREE. Every soup is the app's usual triangle soup (9 numbers a
   triangle), in ONE frame for every piece: the plate's world frame, Z up
   (app-connect.js reads each placed mesh the way app-bridge.js does).

   ANCHORS are what NSO_Bridge.pick returns (face / edge / point), wrapped as
   { piece, target }:
     point  the point itself, the surface normal there
     face   the face's centroid, the face's normal
     edge   its midpoint (String, Tube, Tapered) or its full length (Ribbon),
            leaving along the bisector of the edge's two faces

   SHAPES. The path is straight in this file (a curved path is a later ticket).
     string    Ø                       a round rod
     ribbon    width x thickness       a flat strap; its flat face is
                                       perpendicular to the average of the two
                                       anchor normals: the thickness runs along
                                       that average (what is left of it once the
                                       path direction is taken out), so a strap
                                       between two level tops lies level. Two
                                       normals facing each other average to
                                       nothing; then the strap lies level (thin
                                       along Z)
     tube      Ø x wall                a closed hollow rod: an outer rod and a
                                       sealed bore inside it, one wall clear of
                                       both ends, so the bore pierces neither
                                       anchor
     tapered   Ø at A, Ø at B          a cone between them (a true frustum)

   RESULT.
     weld      both ends sunk and unioned exactly as Bridge's string: sunk by
               the rim gap (NSO_Assemble.rootGap) plus sinkMm, the same leave
               angle, the boolean handed in as opts.union and NSO_Bridge.weld's
               own two steps and its own closed-solid check. The tube's bore
               rides through the union as an internal void.
     separate  no boolean. The connector is its own closed piece, each end cut
               flush with the plane of the surface it meets (no sink).

   Reused, not re-implemented:
     NSO_PathSweep.sweep / profileRegular   (nso_path_sweep.js) every profile
     NSO_Assemble.rootGap                   (nso_assemble.js) the seat depth
     NSO_Bridge.weld / topology / volume / DEFAULTS   (nso_bridge.js) the
        weld, the closed-solid check, and the sink / leave angle / clearance
     NSO_Repair._triTriIntersect            (NSO_Repair.js) "does this cross that"

   PAINT SCOPE: NOT APPLICABLE here - this file reads soups and returns new
   ones. app-connect.js, which replaces pieces, carries the paint check and its
   label (docs/HANDOFF.md). */
(function (root) {
  'use strict';

  var SHAPES = ['string', 'ribbon', 'tube', 'tapered'];
  var DEFAULTS = {
    shape: 'string',
    result: 'weld',
    diameterMm: 2,          // String
    widthMm: 6,             // Ribbon
    thicknessMm: 1.2,
    tubeDiaMm: 4,           // Tube
    wallMm: 0.8,
    diaAMm: 4,              // Tapered, at A
    diaBMm: 1.5,            // ... at B
    ribbonOverEdge: 2,      // a ribbon may be this many times its shorter anchor edge wide
    perpFloor: 0.1,         // below this the normals' average has no sideways part (a ribbon then lies level)
    stationMm: 2,           // wall triangles are cut to at most this long (see emitRod)
    boreScale: 0.999        // the "does it cross a piece" body stays this far inside the real one
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
  function rad(d) { return d * Math.PI / 180; }
  function deg(r) { return r * 180 / Math.PI; }
  function clamp1(x) { return x > 1 ? 1 : (x < -1 ? -1 : x); }
  function f1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
  function show(x) { return (typeof NSO_sectionShow === 'function') ? NSO_sectionShow(x) : f1(x); }
  function anyPerp(u) {
    var a = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return unit(cross(u, a));
  }
  function triCount(s) { return (s && s.length) ? (s.length / 9) | 0 : 0; }
  function refuse(shape, reason) { return { ok: false, kind: shape || null, reason: reason }; }

  function need(name, ok) {
    if (!ok) throw new Error('Connect needs ' + name + ' loaded - nothing here re-implements it');
  }
  function bridge() {
    need('nso_bridge.js (NSO_Bridge)', typeof NSO_Bridge !== 'undefined' && NSO_Bridge);
    return NSO_Bridge;
  }
  function sweeper() {
    need('nso_path_sweep.js (NSO_PathSweep.sweep)', typeof NSO_PathSweep !== 'undefined' && NSO_PathSweep && NSO_PathSweep.sweep);
    return NSO_PathSweep;
  }

  /* An option as a number: the named one when given, else the default. NaN
     (a blank or a word) is "not given". */
  function opt(o, k) {
    var v = (o && o[k] != null && o[k] !== '') ? +o[k] : NaN;
    return isFinite(v) ? v : DEFAULTS[k];
  }
  function bopt(o, k) {                 // Bridge's own numbers: sink, leave angle, clearance
    var v = (o && o[k] != null) ? +o[k] : NaN;
    return isFinite(v) ? v : bridge().DEFAULTS[k];
  }

  /* ------------------------------------------------------------- anchors */
  function anchorOf(end) {
    var t = end.target, k = t.kind;
    if (k === 'point') return { kind: k, p: t.point.slice(), n: unit(t.normal), edge: null };
    if (k === 'face') return { kind: k, p: (t.centroid || t.point).slice(), n: unit(t.normal || t.face.normal), edge: null };
    if (k === 'edge') {
      var n = unit(add(t.faceNormal || [0, 0, 1], t.acrossNormal || t.faceNormal || [0, 0, 1])) || unit(t.faceNormal);
      return { kind: k, p: lerp(t.a, t.b, 0.5), n: n, edge: { a: t.a, b: t.b, lengthMm: t.lengthMm != null ? t.lengthMm : len(sub(t.b, t.a)) } };
    }
    return null;
  }

  /* ------------------------------------------------------------ the shape */
  function sidesFor(r) {
    var n = Math.max(16, Math.min(96, Math.ceil(Math.PI / Math.acos(1 - Math.min(0.01, r * 0.5) / r))));
    if (n % 2) n++;
    return n;
  }

  /* The shape's numbers, validated; or a refusal. */
  function readShape(shape, opts) {
    var s = { shape: shape };
    if (shape === 'string') {
      s.d = opt(opts, 'diameterMm');
      if (!(s.d > 0)) return refuse(shape, 'the string needs a diameter above 0 mm');
      s.rMax = s.d / 2; s.minLen = s.d;
      s.size = 'Ø' + show(s.d);
    } else if (shape === 'ribbon') {
      s.w = opt(opts, 'widthMm'); s.t = opt(opts, 'thicknessMm');
      if (!(s.w > 0) || !(s.t > 0)) return refuse(shape, 'the ribbon needs a width and a thickness above 0 mm');
      s.rMax = Math.hypot(s.w, s.t) / 2; s.minLen = Math.max(s.w, s.t);
      s.size = show(s.w) + ' × ' + show(s.t) + ' mm';
    } else if (shape === 'tube') {
      s.d = opt(opts, 'tubeDiaMm'); s.wall = opt(opts, 'wallMm');
      if (!(s.d > 0)) return refuse(shape, 'the tube needs a diameter above 0 mm');
      if (!(s.wall > 0)) return refuse(shape, 'the tube needs a wall above 0 mm');
      if (s.wall >= s.d / 2 - 1e-9) {
        return refuse(shape, 'a ' + show(s.wall) + ' mm wall leaves no bore in a Ø' + show(s.d) + ' tube - the wall has to be under half the diameter (' +
          show(s.d / 2) + ' mm)');
      }
      s.rMax = s.d / 2; s.rBore = s.d / 2 - s.wall; s.minLen = s.d;
      s.size = 'Ø' + show(s.d) + ' × ' + show(s.wall) + ' wall';
    } else if (shape === 'tapered') {
      s.dA = opt(opts, 'diaAMm'); s.dB = opt(opts, 'diaBMm');
      if (!(s.dA > 0) || !(s.dB > 0)) return refuse(shape, 'the tapered connector needs a diameter above 0 mm at both ends');
      s.rMax = Math.max(s.dA, s.dB) / 2; s.minLen = Math.max(s.dA, s.dB);
      s.size = 'Ø' + show(s.dA) + ' → Ø' + show(s.dB);
    } else {
      return refuse(null, 'unknown shape "' + shape + '" - String, Ribbon, Tube or Tapered');
    }
    return s;
  }

  /* The shape's frame about the axis u: e1 and e2 span the section; for a
     ribbon w (the width) is e1 and f (the thickness, the flat face's normal)
     is e2. */
  function frameFor(shape, u, nA, nB) {
    if (shape !== 'ribbon') { var e1 = anyPerp(u); return { u: u, e1: e1, e2: cross(u, e1), w: null, f: null, levelFallback: false }; }
    var avg = add(nA, nB);
    var f = sub(avg, mul(u, dot(avg, u)));
    var fallback = false;
    if (len(f) < DEFAULTS.perpFloor) {
      fallback = true;
      f = sub([0, 0, 1], mul(u, u[2]));
      if (len(f) < 1e-6) f = sub([1, 0, 0], mul(u, u[0]));
    }
    f = unit(f);
    var w = unit(cross(f, u));           // then cross(u, w) = f
    return { u: u, e1: w, e2: f, w: w, f: f, levelFallback: fallback };
  }

  function rectProfile(w, t) {
    return [[-w / 2, -t / 2], [w / 2, -t / 2], [w / 2, t / 2], [-w / 2, t / 2]];
  }

  /* The outline of the shape's section at an anchor c: the points the seat
     depth is measured with (the rim). */
  function rimAt(spec, c, fr, r) {
    var out = [], i, n, a;
    if (spec.shape === 'ribbon') {
      var hw = spec.w / 2, ht = spec.t / 2, W = fr.w, F = fr.f;
      [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]].forEach(function (q) {
        out.push(add(c, add(mul(W, q[0] * hw), mul(F, q[1] * ht))));
      });
      return out;
    }
    n = sidesFor(r);
    for (i = 0; i < n; i++) {
      a = 2 * Math.PI * i / n;
      out.push(add(c, add(mul(fr.e1, r * Math.cos(a)), mul(fr.e2, r * Math.sin(a)))));
    }
    return out;
  }

  /* One rod from `from` to `to`, the shape's section; `k` scales it (the
     "does it cross a piece" body is the same rod, a hair slimmer). rA / rB are
     a taper's radii at the two ends. */
  function rod(spec, fr, from, to, rA, rB, k) {
    var S = sweeper(), o = { points: [from, to], up: fr.e1 };
    k = k || 1;
    if (spec.shape === 'ribbon') o.profile = rectProfile(spec.w * k, spec.t * k);
    else if (spec.shape === 'tapered') {
      o.profile = S.profileRegular(sidesFor(spec.rMax), 1);
      o.scales = [rA * k, rB * k];
    } else {
      var r = spec.shape === 'tube' ? spec.rMax : spec.d / 2;
      o.profile = S.profileRegular(sidesFor(r), r * k);
    }
    return S.sweep(o);
  }

  // Wind a closed soup the other way (a bore: its material is outside it).
  function flipped(soup) {
    var out = new Float32Array(soup.length);
    for (var o = 0; o < soup.length; o += 9) {
      for (var c = 0; c < 3; c++) {
        out[o + c] = soup[o + c];
        out[o + 3 + c] = soup[o + 6 + c];
        out[o + 6 + c] = soup[o + 3 + c];
      }
    }
    return out;
  }
  function concat(a, b) {
    var out = new Float32Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }

  /* The rod's triangles, from the sweep's own rings (NSO_PathSweep has done
     the profile, the frame and its gates), with two things the sweep's
     two-ring walls do not do:

       STATIONS. A wall triangle that runs the whole length of a long rod is
       hundreds of times longer than it is wide, and the boolean cuts it into
       slivers a ten-thousandth of a millimetre across wherever a piece's
       facets cross it. The walls are cut every `segMm` along their rails
       (a rail is a straight line, so a station on it is exact and every wall
       quad stays planar - the sweep's own argument).

       FLUSH ENDS. When `ends` is given, { a: [point, normal], b: [point,
       normal] }, each end ring slides along its own rail onto the plane
       through that point with that normal. The end cap, fanned from the axis
       point that already lies on the plane, stays a flat polygon. Returns null
       when a rail would not reach its plane in the right order.

     Winding and the cap fan are the sweep's (start cap, walls, end cap). */
  function emitRod(sw, segMm, ends) {
    var first = sw.rings[0], last = sw.rings[sw.rings.length - 1], M = first.length, j;
    var r0 = first, rN = last;
    if (ends) {
      r0 = []; rN = [];
      for (j = 0; j < M; j++) {
        var v = first[j], w = last[j], d = sub(w, v);
        var dA = dot(d, ends.a[1]), dB = dot(d, ends.b[1]);
        if (!(dA > 1e-9) || !(dB < -1e-9)) return null;
        var pa = add(v, mul(d, dot(sub(ends.a[0], v), ends.a[1]) / dA));
        var pb = add(v, mul(d, dot(sub(ends.b[0], v), ends.b[1]) / dB));
        if (!(dot(sub(pb, pa), d) > 0)) return null;
        r0.push(pa); rN.push(pb);
      }
    }
    var run = 0;
    for (j = 0; j < M; j++) run = Math.max(run, len(sub(rN[j], r0[j])));
    var K = Math.max(1, Math.ceil(run / segMm - 1e-9));
    var out = new Float32Array((2 * M * K + 2 * M) * 9), w2 = 0;
    function emit(a, b, c) {
      out[w2++] = a[0]; out[w2++] = a[1]; out[w2++] = a[2];
      out[w2++] = b[0]; out[w2++] = b[1]; out[w2++] = b[2];
      out[w2++] = c[0]; out[w2++] = c[1]; out[w2++] = c[2];
    }
    var rings = [r0], k;
    for (k = 1; k < K; k++) {
      var ring = [];
      for (j = 0; j < M; j++) ring.push(lerp(r0[j], rN[j], k / K));
      rings.push(ring);
    }
    rings.push(rN);
    var p0 = sw.pts[0], p1 = sw.pts[sw.pts.length - 1];
    for (j = 0; j < M; j++) emit(p0, r0[(j + 1) % M], r0[j]);
    for (k = 0; k < K; k++) {
      var Ra = rings[k], Rb = rings[k + 1];
      for (j = 0; j < M; j++) {
        var j2 = (j + 1) % M;
        emit(Ra[j], Ra[j2], Rb[j2]);
        emit(Ra[j], Rb[j2], Rb[j]);
      }
    }
    for (j = 0; j < M; j++) emit(p1, rN[j], rN[(j + 1) % M]);
    return { tris: out, stations: K, rings: [r0, rN] };
  }

  /* --------------------------------------------- does this cross that */
  function boxOf(p) {
    return { lo: [Math.min(p[0][0], p[1][0], p[2][0]), Math.min(p[0][1], p[1][1], p[2][1]), Math.min(p[0][2], p[1][2], p[2][2])],
             hi: [Math.max(p[0][0], p[1][0], p[2][0]), Math.max(p[0][1], p[1][1], p[2][1]), Math.max(p[0][2], p[1][2], p[2][2])] };
  }
  function trisOf(soup) {
    var out = [], n = triCount(soup);
    for (var t = 0; t < n; t++) {
      var o = t * 9, p = [[soup[o], soup[o + 1], soup[o + 2]], [soup[o + 3], soup[o + 4], soup[o + 5]], [soup[o + 6], soup[o + 7], soup[o + 8]]];
      out.push({ p: p, box: boxOf(p) });
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
  /* Does `body` cross `piece`? NSO_Repair's own triangle test, the piece
     narrowed to the triangles near the body first. */
  function crosses(bodyTris, bodyBox, piece) {
    need('NSO_Repair.js (_triTriIntersect)', typeof NSO_Repair !== 'undefined' && NSO_Repair && NSO_Repair._triTriIntersect);
    var tt = NSO_Repair._triTriIntersect, n = triCount(piece), g = 1e-6;
    for (var t = 0; t < n; t++) {
      var o = t * 9, ok = true;
      for (var c = 0; c < 3 && ok; c++) {
        var lo = Math.min(piece[o + c], piece[o + 3 + c], piece[o + 6 + c]), hi = Math.max(piece[o + c], piece[o + 3 + c], piece[o + 6 + c]);
        if (hi < bodyBox.lo[c] - g || lo > bodyBox.hi[c] + g) ok = false;
      }
      if (!ok) continue;
      var q = [[piece[o], piece[o + 1], piece[o + 2]], [piece[o + 3], piece[o + 4], piece[o + 5]], [piece[o + 6], piece[o + 7], piece[o + 8]]], qb = boxOf(q);
      for (var i = 0; i < bodyTris.length; i++) {
        var b = bodyTris[i].box;
        if (b.hi[0] < qb.lo[0] || b.lo[0] > qb.hi[0] || b.hi[1] < qb.lo[1] || b.lo[1] > qb.hi[1] || b.hi[2] < qb.lo[2] || b.lo[2] > qb.hi[2]) continue;
        var p = bodyTris[i].p;
        if (tt(p[0], p[1], p[2], q[0], q[1], q[2])) return true;
      }
    }
    return false;
  }

  /* ----------------------------------------------------------------- plan

     pieces: [soup, ...] (world, Z up). a, b: { piece, target } with target from
     NSO_Bridge.pick on that piece's index. opts:
       shape 'string' | 'ribbon' | 'tube' | 'tapered'      result 'weld' | 'separate'
       diameterMm | widthMm, thicknessMm | tubeDiaMm, wallMm | diaAMm, diaBMm
       others   soups of every other piece on the plate (a third piece in the way)
       aim      handed to NSO_Assemble.rootGap
       sinkMm / leaveDeg / clearMm   Bridge's own, defaulting to Bridge's */
  function plan(pieces, a, b, opts) {
    opts = opts || {};
    var shape = opts.shape || DEFAULTS.shape;
    if (SHAPES.indexOf(shape) < 0) return refuse(null, 'unknown shape "' + shape + '" - String, Ribbon, Tube or Tapered');
    var result = opts.result === 'separate' ? 'separate' : 'weld';
    var okA = a && a.target && a.target.kind, okB = b && b.target && b.target.kind;
    if (!okA || !okB) {
      return refuse(shape, (!okA && !okB) ? 'anchors A and B are both missing - pick them on the pieces'
        : 'anchor ' + (okA ? 'B' : 'A') + ' is missing - pick it on a piece');
    }
    var spec = readShape(shape, opts);
    if (spec.ok === false) return spec;

    var A = anchorOf(a), B = anchorOf(b);
    if (!A || !B || !A.n || !B.n) return refuse(shape, 'an anchor has no surface normal to leave from');

    // A ribbon is no wider than twice the shorter anchor edge it spans.
    if (shape === 'ribbon') {
      var edges = [A, B].filter(function (x) { return x.edge; }).map(function (x) { return x.edge.lengthMm; });
      if (edges.length) {
        var shortest = Math.min.apply(null, edges), cap = DEFAULTS.ribbonOverEdge * shortest;
        if (spec.w > cap + 1e-9) {
          return refuse(shape, 'a ' + show(spec.w) + ' mm wide ribbon is more than ' + DEFAULTS.ribbonOverEdge + '× the shorter anchor edge (' +
            show(shortest) + ' mm) - at most ' + show(cap) + ' mm; narrow it, or anchor on a longer edge');
        }
      }
    }

    var L = len(sub(B.p, A.p));
    if (L < spec.minLen) {
      return refuse(shape, 'the connector would be ' + show(L) + ' mm long, shorter than its own ' +
        (shape === 'ribbon' ? 'width' : 'Ø') + ' ' + show(spec.minLen) + ' - pick anchors further apart, or make it smaller');
    }
    var u = mul(sub(B.p, A.p), 1 / L);
    var leave = Math.cos(rad(bopt(opts, 'leaveDeg')));
    var cA = dot(u, A.n), cB = -dot(u, B.n);
    if (!(cA > leave) || !(cB > leave)) {
      var which = !(cA > leave) ? 'first' : 'second';
      return refuse(shape, 'the connector would pass through the ' + which + ' piece - from anchor ' + (which === 'first' ? 'A' : 'B') +
        ' the line to the other one runs ' + (((which === 'first' ? cA : cB) <= 0) ? 'into the piece' : 'along its surface') + ', not away from it');
    }
    var fr = frameFor(shape, u, A.n, B.n);

    // Radii of a taper, along the axis: r(s), s measured from anchor A.
    var rA = spec.dA ? spec.dA / 2 : 0, rB = spec.dB ? spec.dB / 2 : 0;
    function rAt(s) { return rA + (rB - rA) * s / L; }

    var sink = bopt(opts, 'sinkMm'), clr = bopt(opts, 'clearMm');
    var gapA = 0, gapB = 0, engA = 0, engB = 0, S = sweeper(), sw, rimR;
    if (result === 'weld') {
      need('nso_assemble.js (NSO_Assemble.rootGap)', typeof NSO_Assemble !== 'undefined' && NSO_Assemble && NSO_Assemble.rootGap);
      var ropt = opts.aim ? { aim: opts.aim } : {};
      rimR = function (s) { return shape === 'tapered' ? rAt(s) : spec.rMax; };
      var gA = NSO_Assemble.rootGap(pieces[a.piece], rimAt(spec, A.p, fr, rimR(0)), ropt);
      var gB = NSO_Assemble.rootGap(pieces[b.piece], rimAt(spec, B.p, fr, rimR(L)), ropt);
      if (!gA.ok || !gB.ok) return refuse(shape, (gA.ok ? gB : gA).reason);
      gapA = gA.gapMm; gapB = gB.gapMm; engA = gapA + sink; engB = gapB + sink;
      var s0 = rAt(-engA), s1 = rAt(L + engB);
      if (shape === 'tapered' && (!(s0 > 0) || !(s1 > 0))) {
        return refuse(shape, 'the taper, run on into the pieces, would close to a point inside one of them - a smaller difference between the two Ø');
      }
      sw = rod(spec, fr, sub(A.p, mul(u, engA)), add(B.p, mul(u, engB)), s0, s1);
    } else {
      sw = rod(spec, fr, A.p, B.p, rA, rB);
    }
    if (!sw.ok) return refuse(shape, sw.reason);
    var em = emitRod(sw, DEFAULTS.stationMm, result === 'separate' ? { a: [A.p, A.n], b: [B.p, B.n] } : null);
    if (!em) return refuse(shape, 'the ends could not be cut flush with the surfaces - the connector runs too nearly along one of them');
    var web = em.tris;

    // The tube's bore: sealed, one wall clear of each surface, wound inward.
    var bore = null;
    if (shape === 'tube') {
      var bd = function (c, gap) { var cos = Math.max(1e-6, c); return gap + spec.wall / cos + spec.rBore * Math.tan(Math.acos(clamp1(c))); };
      var dA = bd(cA, gapA), dB = bd(cB, gapB);
      if (dA + dB >= L) {
        return refuse(shape, 'the tube is too short for its bore - it needs ' + show(dA + dB) + ' mm between the anchors to keep a ' +
          show(spec.wall) + ' mm wall at each end, and has ' + show(L));
      }
      var bs = rod({ shape: 'string', d: 2 * spec.rBore, rMax: spec.rBore }, fr, add(A.p, mul(u, dA)), sub(B.p, mul(u, dB)), 0, 0);
      if (!bs.ok) return refuse(shape, bs.reason);
      bore = { fromMm: dA, toMm: L - dB, lengthMm: L - dA - dB, rBore: spec.rBore };
      web = concat(web, flipped(emitRod(bs, DEFAULTS.stationMm, null).tris));
    }

    var plan = { ok: true, kind: shape, shape: shape, result: result, web: web, A: a, B: b, pieces: pieces, lengthMm: L, axis: u,
                 frame: fr, anchors: [A, B], spec: spec, segments: sidesFor(spec.rMax), engageMm: result === 'weld' ? [engA, engB] : null,
                 rimGapMm: result === 'weld' ? [gapA, gapB] : null, bore: bore, endRings: em.rings, stations: em.stations };

    /* Guard: the exposed connector through a piece. It stays clear of each
       welded end by the rim gap plus how far its side runs on past the anchor
       when it leaves the surface at an angle (as Bridge's string does). A
       third piece has no end on it, so the whole run is held to it. */
    var offA = gapA + spec.rMax * Math.tan(Math.acos(clamp1(cA))) + clr, offB = gapB + spec.rMax * Math.tan(Math.acos(clamp1(cB))) + clr;
    var K = DEFAULTS.boreScale;
    var others = (opts.others || []).map(function (o) { return o && o.soup ? o : { soup: o, name: null }; }).filter(function (o) { return o.soup && o.soup.length; });
    function bodyBetween(s0, s1) {
      var c = rod(spec, fr, add(A.p, mul(u, s0)), add(A.p, mul(u, s1)), rAt(s0), rAt(s1), K);
      return c.ok ? { tris: trisOf(c.tris), box: soupBox(c.tris) } : null;   // the check needs no stations: a crossing is a crossing
    }
    if (offA + offB < L) {
      var near = bodyBetween(offA, L - offB);
      if (near) {
        var pi = [a.piece].concat(b.piece === a.piece ? [] : [b.piece]);
        for (var i = 0; i < pi.length; i++) {
          if (crosses(near.tris, near.box, pieces[pi[i]])) {
            return refuse(shape, 'the connector would pass through ' + (a.piece === b.piece ? 'the piece' : (pi[i] === a.piece ? 'the first piece' : 'the second piece')) +
              ' - something stands between the two anchors');
          }
        }
      }
    }
    if (others.length) {
      var whole = bodyBetween(0, L);
      for (var j = 0; j < others.length && whole; j++) {
        if (crosses(whole.tris, whole.box, others[j].soup)) {
          return refuse(shape, 'the straight connector passes through a third piece' + (others[j].name ? ' (' + others[j].name + ')' : '') +
            ' - move it out of the way, or pick anchors with a clear line between them');
        }
      }
    }

    plan.text = describe(spec, L, result);
    return plan;
  }

  function describe(spec, L, result) {
    var name = { string: 'String', ribbon: 'Ribbon', tube: 'Tube', tapered: 'Tapered' }[spec.shape];
    return name + ' ' + spec.size + ', ' + show(L) + ' mm between the anchors · ' +
      (result === 'weld' ? 'welds into A and B' : 'kept as its own piece');
  }

  /* --------------------------------------------------------------- weld

     Weld: NSO_Bridge.weld's own two unions and closed-solid check, handed the
     boolean as opts.union. Separate: no boolean at all; the connector is the
     piece, and it has to be closed. */
  function weld(p, opts) {
    if (!p || !p.ok) return Promise.resolve(p || refuse(null, 'nothing planned'));
    if (p.result === 'separate') {
      var topo = bridge().topology(p.web);
      var vol = bridge().volume(p.web);
      if (topo.open || topo.nm || topo.badWinding || topo.degenerate || !(vol > 0)) {
        return Promise.resolve(refuse(p.kind, 'the connector would not be a closed piece (' + topo.open + ' open edge(s), ' + topo.nm +
          ' non-manifold, ' + topo.badWinding + ' wound the wrong way, volume ' + vol.toFixed(3) + ') - nothing added'));
      }
      return Promise.resolve({ ok: true, kind: p.kind, result: 'separate', soup: p.web, topo: topo, kernel: null, plan: p, text: p.text, volumeMm3: vol });
    }
    return bridge().weld(p, opts).then(function (r) { if (r && r.ok) r.result = 'weld'; return r; });
  }

  var API = {
    SHAPES: SHAPES,
    DEFAULTS: DEFAULTS,
    plan: plan,
    weld: weld,
    emitRod: emitRod
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Connect = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
