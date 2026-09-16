/* nso_skin.js - apply a contact "skin" (a fine relief pattern) onto one flat
   rectangular face of a closed triangle soup, and measure a skinned surface
   the way Seat needs it: by its contact TIPS, not its base plane.

   Loads as a classic script (window.NSO_Skin) and as a Node module
   (require('../nso_skin.js')). No DOM, no Three.js: a mesh is the app's raw
   soup, a Float32Array/Array of 9 numbers per triangle, in whatever axes the
   caller uses (the app's rawTris are Z up, millimetres, untranslated).

   ---------------------------------------------------------------------------
   WHAT THIS IS FOR - breakaway support through minimal contact
   ---------------------------------------------------------------------------
   A breakaway piece B is printed on top of a support block A. The weld between
   them is decided at the interface: a flat A face fuses B on solidly, an air
   gap never fuses (skin_join_test, validated separately). In between is
   genuine minimal contact: A's face carries a relief whose TIPS are all that
   B's face touches. This module makes that relief on A, on one face, in
   place, as a single closed shell. It does not touch B and it does not merge
   anything.

   ---------------------------------------------------------------------------
   THE TWO SURFACES A SKINNED FACE HAS
   ---------------------------------------------------------------------------
   base plane  the original flat face of A (before the skin), and the floor
               between the relief features afterwards
   tips plane  the plane the relief's highest points lie in - rib tops, ring
               top, ridge crests. In 'raise' mode it is `height` above the
               base plane; in 'recess' mode it IS the base plane and the
               valleys are cut down.

   "Flush / gap 0" for a breakaway piece means B's face sits ON THE TIPS. A
   seat that measures from the base plane buries B in the relief by the full
   skin height and prints a solid fuse, which is exactly the failure this
   module exists to avoid. supportExtreme() below is the measurement Seat
   uses: the hull's outermost point along the bit's normal, taken over the
   bit's footprint only, with every hull triangle clipped to that footprint
   first so a rib whose end vertices lie outside the footprint still counts
   where it passes under the bit.

   ---------------------------------------------------------------------------
   PATTERNS (all dimensions mm, heights along the face's outward normal)
   ---------------------------------------------------------------------------
   crosshatch  rib lattice: ribs along both in-plane axes, rectangular section
               `rib` wide, `pitch` apart, `height` tall, coplanar tops. The
               "fine mesh" skin. Contact = the lattice's top area. Defaults
               are one extrusion line wide (0.42 at a 0.4 nozzle - thinner and
               the slicer drops the rib, the coupon doc's rule), 1.2 pitch,
               0.6 tall (three 0.2 layers). NOTE: the physical reference
               (v8_FINAL's printed interface) is not in this repo as geometry,
               so these are stated defaults, every one a parameter.
   zigzag      parallel ridges with a trapezoid (sawtooth) section: `base`
               wide at the floor, `tip` wide at the crest, `height` tall,
               `pitch` apart, running along the face's second axis. Contact =
               the crests. The "line contact" family.
   ring        the coupon anchor tip: one tapered ring centred on the face,
               outer radius `rOut`, wall `wallBase` at the floor tapering to
               `wallTip` at the top, `height` tall. Contact = the thin annulus
               at the top. Raise mode only.

   mode 'raise' (default) adds the relief on top of the face; A grows by
   `height`. mode 'recess' cuts the valleys into A instead; the tips stay in
   the original face plane. `margin` keeps the pattern off the face edges
   (default: one pitch for the grid patterns, one wall for the ring).

   ---------------------------------------------------------------------------
   HOW THE FACE IS REPLACED (why the result is one watertight shell)
   ---------------------------------------------------------------------------
   findFace picks the planar face whose normal best matches the requested
   direction (the outermost one if several are parallel). Its boundary loop
   must reduce to a rectangle: 4 corners, right angles. The face triangles are
   removed and a relief surface is built over the same rectangle, whose
   perimeter is the ORIGINAL loop at height 0. Every perimeter vertex the
   relief introduces along a side is also inserted into the wall triangles
   that share that side (each such wall triangle becomes a fan), so no
   T-junction is left behind: every edge of the result is shared by exactly
   two triangles. Perimeter points are computed once, by the same lerp along
   the original corners, and reused bit-for-bit on both sides of the seam.

   applySkinToFace never returns a half-result: on any refusal the input soup
   is returned untouched with ok:false and a reason.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   NSO_Skin.PATTERNS                      { name: { defaults, describe } }
   NSO_Skin.findFace(soup, dir, plane?)   -> face | null
                                          plane: optional offset n.p = plane;
                                          given, the group on THAT plane is
                                          taken instead of the outermost one
   NSO_Skin.applySkinToFace(soup, {
       dir: [x,y,z],                      face direction (outward normal)
       plane: number,                     optional, see findFace
       pattern: 'crosshatch'|'zigzag'|'ring',
       params: {...},                     pattern parameters (see defaults)
       mode: 'raise'|'recess' })
     -> { ok, reason?, tris, face, tipHeight, tipsPlane, basePlane,
          tipArea, reliefTris, params, pattern, mode }
   NSO_Skin.supportExtreme(soup, footprintCorners[4], normal, opts)
     -> { s, point, inside } | null      max of p.normal over soup within the
                                          footprint prism (opts.sMax caps it)
   NSO_Skin.tipContactArea(soup, footprintCorners, normal, sTips, tol)
     -> mm^2 of soup triangles lying in the tips plane, clipped to footprint
*/
(function (root) {
  'use strict';
  var PLANE_TOL = 0.05;   /* mm - a select entry's offset vs a face group's, same D_TOL as app-mask.js */

  /* ------------------------------------------------------------ vectors */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function unit(a) { var L = len(a); return L > 0 ? scale(a, 1 / L) : [0, 0, 0]; }
  /* a*(1-t) + b*t: exact a at t=0 and exact b at t=1, which a + t*(b-a) is not */
  function lerp(a, b, t) {
    var s = 1 - t;
    return [a[0] * s + b[0] * t, a[1] * s + b[1] * t, a[2] * s + b[2] * t];
  }
  function triAreaVec(a, b, c) { return scale(cross(sub(b, a), sub(c, a)), 0.5); }

  function triCount(soup) { return (soup.length / 9) | 0; }
  function vtx(soup, t, k) { var o = t * 9 + k * 3; return [soup[o], soup[o + 1], soup[o + 2]]; }
  function pushTri(out, a, b, c) {
    out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  }
  /* push a triangle wound so its normal points along `want`; drop it if flat */
  function pushOriented(out, a, b, c, want) {
    var n = cross(sub(b, a), sub(c, a));
    var L = len(n);
    if (L < 1e-14) return false;
    if (dot(n, want) < 0) pushTri(out, a, c, b); else pushTri(out, a, b, c);
    return true;
  }
  function vkey(p) {
    return Math.round(p[0] * 1e4) + '_' + Math.round(p[1] * 1e4) + '_' + Math.round(p[2] * 1e4);
  }

  /* ------------------------------------------------------------ patterns */
  var PATTERNS = {
    crosshatch: {
      defaults: { pitch: 1.2, rib: 0.42, height: 0.6, margin: null },
      describe: function (p) {
        return 'crosshatch lattice, rib ' + p.rib + ' mm, pitch ' + p.pitch + ' mm, ' + p.height + ' mm tall';
      }
    },
    zigzag: {
      defaults: { pitch: 2.0, base: 1.2, tip: 0.42, height: 0.6, margin: null },
      describe: function (p) {
        return 'sawtooth ridges, base ' + p.base + ' -> tip ' + p.tip + ' mm, pitch ' + p.pitch + ' mm, ' + p.height + ' mm tall';
      }
    },
    ring: {
      defaults: { rOut: 5.0, wallBase: 0.8, wallTip: 0.4, height: 1.0, segments: 96, margin: null },
      describe: function (p) {
        return 'tapered ring, r ' + p.rOut + ' mm, wall ' + p.wallBase + ' -> ' + p.wallTip + ' mm, ' + p.height + ' mm tall';
      }
    }
  };

  function withDefaults(name, params) {
    var d = PATTERNS[name].defaults, out = {}, k;
    for (k in d) if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k];
    if (params) for (k in params) if (Object.prototype.hasOwnProperty.call(params, k) && params[k] != null) out[k] = params[k];
    return out;
  }

  /* ------------------------------------------------------------ face pick */

  /* Planar faces whose normal is within 30 degrees of dir, grouped by plane. */
  function findFace(soup, dir, plane) {
    var d = unit(dir);
    if (len(d) === 0) return null;
    /* plane (optional): the face's own offset n.p = plane, as a face select
       records it (app-mask.js). With it, the pick is the coplanar group ON
       that plane, not the outermost one along dir - which is what lets an
       explicitly selected pocket floor win over the hull face above it. */
    var wantPlane = (typeof plane === 'number' && isFinite(plane)) ? plane : null;
    var n = triCount(soup);
    var groups = [];
    for (var t = 0; t < n; t++) {
      var a = vtx(soup, t, 0), b = vtx(soup, t, 1), c = vtx(soup, t, 2);
      var nv = cross(sub(b, a), sub(c, a));
      var L = len(nv);
      if (L < 1e-14) continue;
      nv = scale(nv, 1 / L);
      var dd = dot(nv, d);
      if (dd < 0.866) continue;
      var off = dot(nv, a);
      var g = null;
      for (var i = 0; i < groups.length; i++) {
        if (dot(groups[i].n, nv) > 1 - 1e-6 && Math.abs(groups[i].d - off) < 1e-4) { g = groups[i]; break; }
      }
      if (!g) { g = { n: nv, d: off, dotDir: dd, tris: [], area: 0 }; groups.push(g); }
      g.tris.push(t);
      g.area += L * 0.5;
    }
    if (!groups.length) return null;
    var best = null;
    for (var k = 0; k < groups.length; k++) {
      var gk = groups[k];
      if (wantPlane !== null && Math.abs(gk.d - wantPlane) > PLANE_TOL) continue;
      if (!best || gk.dotDir > best.dotDir + 1e-4 ||
          (Math.abs(gk.dotDir - best.dotDir) <= 1e-4 && gk.d > best.d)) best = gk;
    }
    return best;
  }

  /* Boundary loop of a set of triangles: edges used once, walked in the
     winding direction. Null unless it is exactly one loop. */
  function boundaryLoop(soup, tris) {
    var count = new Map(), dir = new Map(), pts = new Map();
    for (var i = 0; i < tris.length; i++) {
      var t = tris[i];
      var v = [vtx(soup, t, 0), vtx(soup, t, 1), vtx(soup, t, 2)];
      var k = [vkey(v[0]), vkey(v[1]), vkey(v[2])];
      for (var e = 0; e < 3; e++) {
        var ka = k[e], kb = k[(e + 1) % 3];
        if (ka === kb) continue;
        if (!pts.has(ka)) pts.set(ka, v[e]);
        var ek = ka < kb ? ka + '|' + kb : kb + '|' + ka;
        count.set(ek, (count.get(ek) || 0) + 1);
        dir.set(ek, [ka, kb]);
      }
    }
    var next = new Map(), nEdges = 0;
    count.forEach(function (c, ek) {
      if (c !== 1) return;
      var ab = dir.get(ek);
      if (next.has(ab[0])) { nEdges = -1; return; }
      next.set(ab[0], ab[1]);
      nEdges++;
    });
    if (nEdges < 3) return null;
    var start = next.keys().next().value, cur = start, loop = [], guard = 0;
    do {
      loop.push(pts.get(cur));
      cur = next.get(cur);
      if (cur === undefined) return null;
      if (++guard > nEdges + 1) return null;
    } while (cur !== start);
    if (loop.length !== nEdges) return null;
    return loop;
  }

  /* Drop collinear points; keep the corners. */
  function corners(loop) {
    var pts = loop.slice(), changed = true;
    while (changed && pts.length > 3) {
      changed = false;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[(i + pts.length - 1) % pts.length], q = pts[i], r = pts[(i + 1) % pts.length];
        var a = sub(q, p), b = sub(r, q);
        var la = len(a), lb = len(b);
        if (la < 1e-9 || len(cross(a, b)) < 1e-6 * la * lb) { pts.splice(i, 1); changed = true; break; }
      }
    }
    return pts;
  }

  /* --------------------------------------------- rectangle face frame */

  /* Returns { c: [c0,c1,c2,c3] CCW seen from +N, U, V, N, W, D } or a reason string. */
  function rectFrame(soup, face) {
    var loop = boundaryLoop(soup, face.tris);
    if (!loop) return 'face boundary is not a single loop';
    var cs = corners(loop);
    if (cs.length !== 4) return 'face is not a rectangle (' + cs.length + ' corners)';
    var e0 = sub(cs[1], cs[0]), e1 = sub(cs[2], cs[1]), e2 = sub(cs[3], cs[2]), e3 = sub(cs[0], cs[3]);
    var es = [e0, e1, e2, e3];
    for (var i = 0; i < 4; i++) {
      var a = es[i], b = es[(i + 1) % 4];
      if (Math.abs(dot(a, b)) > 1e-4 * len(a) * len(b)) return 'face corners are not right angles';
    }
    var nrm = unit(cross(e0, e1));
    if (dot(nrm, face.n) < 0) { cs.reverse(); cs.unshift(cs.pop()); nrm = scale(nrm, -1); }
    /* after a reverse the corner order is c0,c3,c2,c1 -> rotate so c0 stays first */
    e0 = sub(cs[1], cs[0]);
    var U = unit(e0), W = len(e0);
    var Vd = sub(cs[3], cs[0]);
    var V = unit(Vd), D = len(Vd);
    var N = unit(cross(U, V));
    if (dot(N, face.n) < 0.999) return 'face frame is not right-handed';
    if (W < 1e-6 || D < 1e-6) return 'face is degenerate';
    return { c: cs, U: U, V: V, N: N, W: W, D: D };
  }

  /* ------------------------------------------- perimeter bookkeeping */

  /* Sides run c0->c1 (v=0), c1->c2 (u=W), c2->c3 (v=D, u decreasing),
     c3->c0 (u=0, v decreasing). A side keeps sorted params t in [0,1] and
     the exact point for each; the same point object is what both the relief
     perimeter and the wall fans use. */
  function makeSides(fr) {
    var sides = [];
    for (var k = 0; k < 4; k++) {
      sides.push({ a: fr.c[k], b: fr.c[(k + 1) % 4], ts: [0, 1], pts: [fr.c[k], fr.c[(k + 1) % 4]] });
    }
    return sides;
  }
  function sideInsert(side, t, exactPt) {
    if (t <= 1e-9 || t >= 1 - 1e-9) return t <= 1e-9 ? side.pts[0] : side.pts[side.pts.length - 1];
    for (var i = 0; i < side.ts.length; i++) {
      if (Math.abs(side.ts[i] - t) < 1e-9) return side.pts[i];
      if (side.ts[i] > t) {
        var p = exactPt || lerp(side.a, side.b, t);
        side.ts.splice(i, 0, t); side.pts.splice(i, 0, p);
        return p;
      }
    }
    return null;
  }
  /* param of point p along side, or null if not on the side segment */
  function sideParam(side, p, tol) {
    var ab = sub(side.b, side.a), L2 = dot(ab, ab);
    var t = dot(sub(p, side.a), ab) / L2;
    if (t < -1e-7 || t > 1 + 1e-7) return null;
    var foot = lerp(side.a, side.b, Math.min(1, Math.max(0, t)));
    if (len(sub(p, foot)) > tol) return null;
    return Math.min(1, Math.max(0, t));
  }

  /* Wall triangles that own a sub-segment of a side get their existing
     mid-side vertices registered, so the relief perimeter meets them. */
  function registerWallVertices(soup, faceSet, sides, tol) {
    var n = triCount(soup);
    for (var t = 0; t < n; t++) {
      if (faceSet.has(t)) continue;
      var v = [vtx(soup, t, 0), vtx(soup, t, 1), vtx(soup, t, 2)];
      for (var e = 0; e < 3; e++) {
        var p = v[e], q = v[(e + 1) % 3];
        for (var k = 0; k < 4; k++) {
          var tp = sideParam(sides[k], p, tol), tq = sideParam(sides[k], q, tol);
          if (tp === null || tq === null) continue;
          sideInsert(sides[k], tp, p);
          sideInsert(sides[k], tq, q);
        }
      }
    }
  }

  /* Replace every wall triangle that shares a piece of a side with a fan
     over the side's registered points. */
  function fanWalls(soup, faceSet, sides, tol, out) {
    var n = triCount(soup), used = 0;
    for (var t = 0; t < n; t++) {
      if (faceSet.has(t)) continue;
      var v = [vtx(soup, t, 0), vtx(soup, t, 1), vtx(soup, t, 2)];
      var done = false;
      for (var e = 0; e < 3 && !done; e++) {
        var p = v[e], q = v[(e + 1) % 3], r = v[(e + 2) % 3];
        for (var k = 0; k < 4; k++) {
          var side = sides[k];
          var tp = sideParam(side, p, tol), tq = sideParam(side, q, tol);
          if (tp === null || tq === null) continue;
          var lo = Math.min(tp, tq), hi = Math.max(tp, tq);
          var mids = [];
          for (var i = 0; i < side.ts.length; i++) {
            if (side.ts[i] > lo + 1e-9 && side.ts[i] < hi - 1e-9) mids.push(side.pts[i]);
          }
          if (tp > tq) mids.reverse();
          var chain = [p].concat(mids, [q]);
          for (var c = 0; c + 1 < chain.length; c++) pushTri(out, chain[c], chain[c + 1], r);
          used++;
          done = true;
          break;
        }
      }
      if (!done) pushTri(out, v[0], v[1], v[2]);
    }
    return used;
  }

  /* --------------------------------------------------- grid relief */

  /* A vertical wall between two cells sharing the edge P0->P1, heights
     (a0,a1) on side A and (b0,b1) on the other; sideA points from the edge
     into cell A. The wall faces the lower side. */
  function wallBetween(out, P0, P1, a0, a1, b0, b1, sideA, N) {
    var d0 = a0 - b0, d1 = a1 - b1;
    if (Math.abs(d0) < 1e-12 && Math.abs(d1) < 1e-12) return;
    if (d0 * d1 < 0) {
      var t = d0 / (d0 - d1);
      var Pc = lerp(P0, P1, t), hc = a0 + (a1 - a0) * t;
      wallBetween(out, P0, Pc, a0, hc, b0, hc, sideA, N);
      wallBetween(out, Pc, P1, hc, a1, hc, b1, sideA, N);
      return;
    }
    var want = (d0 + d1) > 0 ? scale(sideA, -1) : sideA;
    var A0 = add(P0, scale(N, a0)), A1 = add(P1, scale(N, a1));
    var B0 = add(P0, scale(N, b0)), B1 = add(P1, scale(N, b1));
    pushOriented(out, A0, A1, B1, want);
    pushOriented(out, A0, B1, B0, want);
  }

  function gridRelief(fr, sides, breaksU, breaksV, cellHeights, out) {
    var nu = breaksU.length - 1, nv = breaksV.length - 1;
    var W = fr.W, D = fr.D, N = fr.N, U = fr.U, V = fr.V, c0 = fr.c[0];
    /* one base point per grid node, perimeter nodes shared with the sides */
    var base = new Array((nu + 1) * (nv + 1));
    function idx(i, j) { return j * (nu + 1) + i; }
    var i, j;
    for (j = 0; j <= nv; j++) {
      for (i = 0; i <= nu; i++) {
        var u = breaksU[i], v = breaksV[j], p;
        if (j === 0) p = sideInsert(sides[0], u / W);
        else if (j === nv) p = sideInsert(sides[2], 1 - u / W);
        else if (i === 0) p = sideInsert(sides[3], 1 - v / D);
        else if (i === nu) p = sideInsert(sides[1], v / D);
        else p = add(c0, add(scale(U, u), scale(V, v)));
        base[idx(i, j)] = p;
      }
    }
    var H = new Array(nu * nv);
    var tipArea = 0, hmax = -Infinity;
    for (j = 0; j < nv; j++) for (i = 0; i < nu; i++) {
      var h = cellHeights(breaksU[i], breaksU[i + 1], breaksV[j], breaksV[j + 1]);
      H[j * nu + i] = h;
      for (var q = 0; q < 4; q++) if (h[q] > hmax) hmax = h[q];
    }
    function lift(p, h) { return h === 0 ? p : add(p, scale(N, h)); }
    var reliefStart = out.length;
    for (j = 0; j < nv; j++) for (i = 0; i < nu; i++) {
      var h4 = H[j * nu + i];
      var p00 = lift(base[idx(i, j)], h4[0]), p10 = lift(base[idx(i + 1, j)], h4[1]);
      var p11 = lift(base[idx(i + 1, j + 1)], h4[2]), p01 = lift(base[idx(i, j + 1)], h4[3]);
      pushOriented(out, p00, p10, p11, N);
      pushOriented(out, p00, p11, p01, N);
      if (Math.abs(h4[0] - hmax) < 1e-9 && Math.abs(h4[1] - hmax) < 1e-9 &&
          Math.abs(h4[2] - hmax) < 1e-9 && Math.abs(h4[3] - hmax) < 1e-9) {
        tipArea += (breaksU[i + 1] - breaksU[i]) * (breaksV[j + 1] - breaksV[j]);
      }
    }
    var negU = scale(U, -1), negV = scale(V, -1);
    /* walls on vertical grid lines */
    for (i = 0; i <= nu; i++) for (j = 0; j < nv; j++) {
      var P0 = base[idx(i, j)], P1 = base[idx(i, j + 1)];
      var L = i > 0 ? H[j * nu + i - 1] : null, R = i < nu ? H[j * nu + i] : null;
      var a0 = L ? L[1] : 0, a1 = L ? L[2] : 0;   /* left cell's right edge */
      var b0 = R ? R[0] : 0, b1 = R ? R[3] : 0;   /* right cell's left edge */
      wallBetween(out, P0, P1, a0, a1, b0, b1, negU, N);
    }
    /* walls on horizontal grid lines */
    for (j = 0; j <= nv; j++) for (i = 0; i < nu; i++) {
      var Q0 = base[idx(i, j)], Q1 = base[idx(i + 1, j)];
      var B = j > 0 ? H[(j - 1) * nu + i] : null, T = j < nv ? H[j * nu + i] : null;
      var c0h = B ? B[3] : 0, c1h = B ? B[2] : 0;  /* bottom cell's top edge */
      var d0h = T ? T[0] : 0, d1h = T ? T[1] : 0;  /* top cell's bottom edge */
      wallBetween(out, Q0, Q1, c0h, c1h, d0h, d1h, negV, N);
    }
    return { tipArea: tipArea, hmax: hmax, reliefTris: (out.length - reliefStart) / 9 };
  }

  /* rib intervals centred on a span L, inset by margin */
  function ribIntervals(L, rib, pitch, margin) {
    var free = L - 2 * margin;
    if (free < rib) return [];
    var k = Math.floor((free - rib) / pitch) + 1;
    var total = (k - 1) * pitch + rib;
    var start = (L - total) / 2;
    var iv = [];
    for (var i = 0; i < k; i++) iv.push([start + i * pitch, start + i * pitch + rib]);
    return iv;
  }
  function inAny(x, ivs) {
    for (var i = 0; i < ivs.length; i++) if (x > ivs[i][0] && x < ivs[i][1]) return true;
    return false;
  }
  function uniqSorted(arr) {
    arr.sort(function (a, b) { return a - b; });
    var out = [];
    for (var i = 0; i < arr.length; i++) if (!out.length || arr[i] - out[out.length - 1] > 1e-9) out.push(arr[i]);
    return out;
  }
  function withinSpan(arr, L) {
    var out = [0];
    for (var i = 0; i < arr.length; i++) if (arr[i] > 1e-9 && arr[i] < L - 1e-9) out.push(arr[i]);
    out.push(L);
    return uniqSorted(out);
  }

  /* In recess mode the margin band is a rim left at the original plane: the
     valleys stop short of the face edge, so the block's side walls are never
     duplicated. Recess therefore needs margin > 0. */
  function rimCheck(margin, shift) {
    if (shift < 0 && !(margin > 0)) return 'recess needs a margin > 0 (the rim the valleys stop at)';
    return null;
  }
  function isRim(u0, u1, v0, v1, W, D, margin) {
    var um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
    return um < margin || um > W - margin || vm < margin || vm > D - margin;
  }

  function crosshatchPlan(fr, p, shift) {
    var margin = p.margin == null ? p.pitch : p.margin;
    var bad = rimCheck(margin, shift);
    if (bad) return bad;
    var ivU = ribIntervals(fr.W, p.rib, p.pitch, margin);
    var ivV = ribIntervals(fr.D, p.rib, p.pitch, margin);
    if (!ivU.length || !ivV.length) return 'face too small for the crosshatch (rib ' + p.rib + ', margin ' + margin + ')';
    var bu = [margin, fr.W - margin], bv = [margin, fr.D - margin], i;
    for (i = 0; i < ivU.length; i++) bu.push(ivU[i][0], ivU[i][1]);
    for (i = 0; i < ivV.length; i++) bv.push(ivV[i][0], ivV[i][1]);
    var h = p.height;
    return {
      breaksU: withinSpan(bu, fr.W), breaksV: withinSpan(bv, fr.D),
      cellHeights: function (u0, u1, v0, v1) {
        if (isRim(u0, u1, v0, v1, fr.W, fr.D, margin)) return [0, 0, 0, 0];
        var raised = inAny((u0 + u1) / 2, ivU) || inAny((v0 + v1) / 2, ivV);
        var z = (raised ? h : 0) + shift;
        return [z, z, z, z];
      },
      ribsU: ivU.length, ribsV: ivV.length, margin: margin
    };
  }

  function zigzagPlan(fr, p, shift) {
    var margin = p.margin == null ? p.pitch : p.margin;
    var bad = rimCheck(margin, shift);
    if (bad) return bad;
    if (p.tip > p.base) return 'zigzag tip must not be wider than its base';
    var ridges = ribIntervals(fr.W, p.base, p.pitch, margin);
    if (!ridges.length) return 'face too small for the zigzag ridges (base ' + p.base + ', margin ' + margin + ')';
    if (fr.D - 2 * margin <= 0) return 'face too small for the zigzag ridges (margin ' + margin + ')';
    var bu = [margin, fr.W - margin], i;
    var flank = (p.base - p.tip) / 2;
    for (i = 0; i < ridges.length; i++) {
      var b0 = ridges[i][0], b1 = ridges[i][1];
      bu.push(b0, b0 + flank, b1 - flank, b1);
    }
    var v0m = margin, v1m = fr.D - margin;
    var h = p.height;
    function profile(u) {
      for (var k = 0; k < ridges.length; k++) {
        var b0 = ridges[k][0], b1 = ridges[k][1];
        if (u < b0 || u > b1) continue;
        if (flank < 1e-12) return h;
        if (u < b0 + flank) return h * (u - b0) / flank;
        if (u > b1 - flank) return h * (b1 - u) / flank;
        return h;
      }
      return 0;
    }
    return {
      breaksU: withinSpan(bu, fr.W), breaksV: withinSpan([v0m, v1m], fr.D),
      cellHeights: function (u0, u1, v0, v1) {
        if (isRim(u0, u1, v0, v1, fr.W, fr.D, margin)) return [0, 0, 0, 0];
        var h0 = profile(u0) + shift, h1 = profile(u1) + shift;
        return [h0, h1, h1, h0];
      },
      ridges: ridges.length, margin: margin
    };
  }

  /* --------------------------------------------------- ring relief */

  function ringRelief(fr, sides, p, out) {
    var margin = p.margin == null ? p.wallBase : p.margin;
    var half = Math.min(fr.W, fr.D) / 2;
    if (p.rOut + margin > half) return 'ring r ' + p.rOut + ' + margin ' + margin + ' does not fit a ' + fr.W.toFixed(2) + ' x ' + fr.D.toFixed(2) + ' face';
    if (p.wallTip > p.wallBase || p.wallTip <= 0) return 'ring wall must taper: 0 < wallTip <= wallBase';
    if (p.wallBase >= p.rOut) return 'ring wall thicker than its radius';
    var seg = Math.max(12, p.segments | 0);
    var taper = (p.wallBase - p.wallTip) / 2;
    var rOut0 = p.rOut, rOut1 = p.rOut - taper;
    var rIn0 = p.rOut - p.wallBase, rIn1 = rIn0 + taper;
    var h = p.height;
    var U = fr.U, V = fr.V, N = fr.N;
    var C = add(fr.c[0], add(scale(U, fr.W / 2), scale(V, fr.D / 2)));
    var reliefStart = out.length;

    function circle(r, z) {
      var pts = [];
      for (var k = 0; k < seg; k++) {
        var th = 2 * Math.PI * k / seg;
        var q = add(C, add(scale(U, r * Math.cos(th)), scale(V, r * Math.sin(th))));
        if (z) q = add(q, scale(N, z));
        pts.push(q);
      }
      return pts;
    }
    var out0 = circle(rOut0, 0), out1 = circle(rOut1, h), in1 = circle(rIn1, h), in0 = circle(rIn0, 0);
    var radial = [];
    for (var k = 0; k < seg; k++) {
      var th = 2 * Math.PI * k / seg;
      radial.push(add(scale(U, Math.cos(th)), scale(V, Math.sin(th))));
    }
    function strip(A, B, wantFn) {
      for (var k = 0; k < seg; k++) {
        var k1 = (k + 1) % seg, w = wantFn(k);
        pushOriented(out, A[k], A[k1], B[k1], w);
        pushOriented(out, A[k], B[k1], B[k], w);
      }
    }
    strip(out0, out1, function (k) { return radial[k]; });                 /* outer wall */
    strip(out1, in1, function () { return N; });                          /* top annulus */
    strip(in1, in0, function (k) { return scale(radial[k], -1); });       /* inner wall */
    for (var f = 0; f < seg; f++) pushOriented(out, C, in0[f], in0[(f + 1) % seg], N); /* floor disk */

    /* the floor outside the ring: zipper between the rectangle loop and out0 */
    var rectPts = [];
    var hw = fr.W / 2, hd = fr.D / 2;
    for (var s = 0; s < seg; s++) {
      var ang = 2 * Math.PI * s / seg, cs = Math.cos(ang), sn = Math.sin(ang);
      var tEdge = Math.min(Math.abs(cs) > 1e-12 ? hw / Math.abs(cs) : Infinity,
                           Math.abs(sn) > 1e-12 ? hd / Math.abs(sn) : Infinity);
      var x = cs * tEdge, y = sn * tEdge;   /* local, centred */
      var pt;
      if (Math.abs(Math.abs(x) - hw) < 1e-9 * Math.max(1, hw)) {
        /* on a u = const side: right side (k=1) runs v 0->D, left (k=3) runs v D->0 */
        if (x > 0) pt = sideInsert(sides[1], (y + hd) / fr.D);
        else pt = sideInsert(sides[3], 1 - (y + hd) / fr.D);
      } else {
        /* on a v = const side: bottom (k=0) runs u 0->W, top (k=2) runs u W->0 */
        if (y < 0) pt = sideInsert(sides[0], (x + hw) / fr.W);
        else pt = sideInsert(sides[2], 1 - (x + hw) / fr.W);
      }
      if (pt) rectPts.push(pt);
    }
    /* every registered side point, in CCW order, with its angle about C */
    var loopPts = [];
    for (var sd = 0; sd < 4; sd++) {
      var side = sides[sd];
      for (var q = 0; q < side.pts.length - 1; q++) loopPts.push(side.pts[q]);
    }
    function angleOf(pt) {
      var d = sub(pt, C);
      var a = Math.atan2(dot(d, V), dot(d, U));
      return a < 0 ? a + 2 * Math.PI : a;
    }
    var rect = loopPts.map(function (pt) { return { p: pt, a: angleOf(pt) }; })
      .sort(function (x, y) { return x.a - y.a; });
    var inner = out0.map(function (pt, k) { return { p: pt, a: 2 * Math.PI * k / seg }; });
    var i = 0, j = 0, nr = rect.length, ni = inner.length;
    var steps = nr + ni;
    for (var st = 0; st < steps; st++) {
      var aR = rect[(i + 1) % nr].a + (i + 1 >= nr ? 2 * Math.PI : 0);
      var aI = inner[(j + 1) % ni].a + (j + 1 >= ni ? 2 * Math.PI : 0);
      if (i < nr && (j >= ni || aR <= aI)) {
        pushOriented(out, rect[i % nr].p, rect[(i + 1) % nr].p, inner[j % ni].p, N);
        i++;
      } else {
        pushOriented(out, rect[i % nr].p, inner[(j + 1) % ni].p, inner[j % ni].p, N);
        j++;
      }
    }
    var tipArea = Math.PI * (rOut1 * rOut1 - rIn1 * rIn1);
    return { tipArea: tipArea, hmax: h, reliefTris: (out.length - reliefStart) / 9, margin: margin,
             rOutTop: rOut1, rInTop: rIn1 };
  }

  /* ------------------------------------------------------- apply */

  function applySkinToFace(soup, opts) {
    opts = opts || {};
    var res = { ok: false, tris: soup };
    var name = opts.pattern || 'crosshatch';
    if (!PATTERNS[name]) { res.reason = 'unknown pattern "' + name + '"'; return res; }
    var p = withDefaults(name, opts.params);
    var mode = opts.mode || 'raise';
    if (mode !== 'raise' && mode !== 'recess') { res.reason = 'mode must be raise or recess'; return res; }
    if (!(p.height > 0)) { res.reason = 'height must be positive'; return res; }
    if (!soup || triCount(soup) < 4) { res.reason = 'empty soup'; return res; }
    var dir = opts.dir || [0, 0, 1];
    var face = findFace(soup, dir, opts.plane);
    if (!face) {
      res.reason = (typeof opts.plane === 'number')
        ? 'no flat face on the selected plane (n.p = ' + opts.plane.toFixed(3) + ') within 30 degrees of its normal'
        : 'no flat face within 30 degrees of the requested direction';
      return res;
    }
    var fr = rectFrame(soup, face);
    if (typeof fr === 'string') { res.reason = fr; return res; }

    var faceSet = new Set(face.tris);
    var sides = makeSides(fr);
    var tol = 1e-4;
    registerWallVertices(soup, faceSet, sides, tol);

    var relief = [];
    var info;
    var shift = mode === 'recess' ? -p.height : 0;
    if (name === 'ring') {
      if (mode === 'recess') { res.reason = 'ring is raise-only'; return res; }
      info = ringRelief(fr, sides, p, relief);
      if (typeof info === 'string') { res.reason = info; return res; }
    } else {
      var plan = name === 'crosshatch' ? crosshatchPlan(fr, p, shift) : zigzagPlan(fr, p, shift);
      if (typeof plan === 'string') { res.reason = plan; return res; }
      info = gridRelief(fr, sides, plan.breaksU, plan.breaksV, plan.cellHeights, relief);
      info.margin = plan.margin;
      if (plan.ribsU != null) { info.ribsU = plan.ribsU; info.ribsV = plan.ribsV; }
      if (plan.ridges != null) info.ridges = plan.ridges;
    }

    var out = [];
    var fanned = fanWalls(soup, faceSet, sides, tol, out);
    for (var i = 0; i < relief.length; i++) out.push(relief[i]);

    var tipsOffset = mode === 'recess' ? 0 : p.height;
    res.ok = true;
    res.tris = new Float32Array(out);
    res.pattern = name;
    res.mode = mode;
    res.params = p;
    res.face = { n: fr.N, d: face.d, corners: fr.c, W: fr.W, D: fr.D, tris: face.tris.length };
    res.basePlane = face.d;
    res.tipsPlane = face.d + tipsOffset;
    res.tipHeight = p.height;
    res.tipArea = info.tipArea;
    res.reliefTris = info.reliefTris;
    res.wallTrisFanned = fanned;
    res.info = info;
    res.describe = PATTERNS[name].describe(p) + (mode === 'recess' ? ', recessed' : '');
    return res;
  }

  /* ------------------------------------------- tips measurement */

  /* Sutherland-Hodgman clip of a polygon (array of {u,v,s}) against
     lo <= key <= hi. */
  function clipAxis(poly, key, lo, hi) {
    function clipOne(input, inside, at) {
      var outp = [];
      for (var i = 0; i < input.length; i++) {
        var cur = input[i], prev = input[(i + input.length - 1) % input.length];
        var ci = inside(cur), pi = inside(prev);
        if (ci) {
          if (!pi) outp.push(at(prev, cur));
          outp.push(cur);
        } else if (pi) outp.push(at(prev, cur));
      }
      return outp;
    }
    function isect(a, b, bound) {
      var t = (bound - a[key]) / (b[key] - a[key]);
      var r = { u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t, s: a.s + (b.s - a.s) * t };
      r[key] = bound;
      return r;
    }
    var p1 = clipOne(poly, function (q) { return q[key] >= lo; }, function (a, b) { return isect(a, b, lo); });
    if (!p1.length) return p1;
    return clipOne(p1, function (q) { return q[key] <= hi; }, function (a, b) { return isect(a, b, hi); });
  }

  function footprintFrame(cornersFp, normal) {
    var o = cornersFp[0];
    var Uv = sub(cornersFp[1], o), Vv = sub(cornersFp[3], o);
    var W = len(Uv), D = len(Vv);
    var U = unit(Uv), V = unit(Vv);
    var N = unit(normal);
    return { o: o, U: U, V: V, N: N, W: W, D: D };
  }

  /* The soup's extreme along `normal` inside the prism over the footprint
     rectangle (4 corners, any order around it, as the app's face corners).
     opts.sMax: ignore anything beyond this along the normal (the bit's own
     far face, so a hull that wraps around the bit is not mistaken for the
     surface under it). Returns null if nothing of the soup lies under the
     footprint. */
  function supportExtreme(soup, cornersFp, normal, opts) {
    opts = opts || {};
    var f = footprintFrame(cornersFp, normal);
    var sMax = (opts.sMax == null) ? Infinity : opts.sMax;
    var best = -Infinity, bestPt = null, inside = 0;
    var n = triCount(soup);
    for (var t = 0; t < n; t++) {
      var poly = [];
      var allBeyond = true;
      for (var k = 0; k < 3; k++) {
        var p = vtx(soup, t, k), d = sub(p, f.o);
        var s = dot(p, f.N);             /* absolute, p . normal */
        if (s <= sMax + 1e-6) allBeyond = false;
        poly.push({ u: dot(d, f.U), v: dot(d, f.V), s: s });
      }
      if (allBeyond) continue;
      poly = clipAxis(poly, 'u', 0, f.W);
      if (poly.length < 3) continue;
      poly = clipAxis(poly, 'v', 0, f.D);
      if (poly.length < 3) continue;
      inside++;
      for (var q = 0; q < poly.length; q++) {
        if (poly[q].s <= sMax + 1e-6 && poly[q].s > best) {
          best = poly[q].s;
          var inPlane = add(f.o, add(scale(f.U, poly[q].u), scale(f.V, poly[q].v)));
          bestPt = add(inPlane, scale(f.N, poly[q].s - dot(inPlane, f.N)));
        }
      }
    }
    if (!bestPt) return null;
    return { s: best, point: bestPt, inside: inside };
  }

  /* Area (mm^2) of soup triangles that lie in the plane p.normal = sTips
     (within tol), clipped to the footprint. The real contact patch. */
  function tipContactArea(soup, cornersFp, normal, sTips, tol) {
    tol = tol || 1e-6;
    var f = footprintFrame(cornersFp, normal);
    var s0 = sTips;
    var area = 0, n = triCount(soup);
    for (var t = 0; t < n; t++) {
      var poly = [], ok = true;
      for (var k = 0; k < 3 && ok; k++) {
        var pk = vtx(soup, t, k), d = sub(pk, f.o);
        var s = dot(pk, f.N);
        if (Math.abs(s - s0) > tol) ok = false;
        poly.push({ u: dot(d, f.U), v: dot(d, f.V), s: s });
      }
      if (!ok) continue;
      poly = clipAxis(poly, 'u', 0, f.W);
      if (poly.length < 3) continue;
      poly = clipAxis(poly, 'v', 0, f.D);
      if (poly.length < 3) continue;
      var a = 0;
      for (var q = 0; q < poly.length; q++) {
        var r = poly[(q + 1) % poly.length];
        a += poly[q].u * r.v - r.u * poly[q].v;
      }
      area += Math.abs(a) / 2;
    }
    return area;
  }

  var api = {
    PATTERNS: PATTERNS,
    withDefaults: withDefaults,
    findFace: findFace,
    applySkinToFace: applySkinToFace,
    supportExtreme: supportExtreme,
    tipContactArea: tipContactArea
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_Skin = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
