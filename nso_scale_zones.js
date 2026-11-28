/* ============================================================
   nso_scale_zones.js - Scale zones: scale PART of a piece and keep the rest.
   docs/SCALE-ZONES.md. The card section is app-scale-zones.js.

   Loads as a classic script (window.NSO_ScaleZones) and as a Node module.
   No DOM, no THREE. Everything is in the piece's raw frame (rawTris: Z up,
   millimetres, 9 floats a triangle).

   A ZONE is a box or a cylinder in that frame, and says KEEP or SCALE:
     { id, kind: 'keep' | 'scale', shape: 'box', c: [x, y, z], h: [hx, hy, hz] }
     { id, kind: 'keep' | 'scale', shape: 'cyl', c: [x, y, z], axis: 0|1|2, r, hl }
   (a cylinder: centre c, its axis along raw X, Y or Z, radius r, half length hl).

   WHAT MOVES. Every vertex gets a weight w:
     - inside a KEEP zone (or on its skin) w = 0: it never moves. Keep wins.
     - when there are SCALE zones, w = 1 inside one, 0 outside them all;
     - when there are only KEEP zones, everything outside them has w = 1.
   With a Blend distance b > 0 the step is eased: w climbs from 0 at the
   zone's skin to 1 at b from it (smoothstep), so the change tapers instead
   of stepping. A vertex moves to  p + w (S(p) - p),  S the scale about a pivot.

   PARTS AND THEIR PIVOTS. The vertices with w > 0 fall into connected parts
   (joined by the piece's own edges; in Scale-zone mode, only within one
   zone, so two pillars in two zones are two parts). Each part is scaled
   about its own pivot:
     join    (the default) where the part meets what is kept: the middle of
             the points where its edges cross the zone's skin. The neck of a
             shower head, the underside of a thumb screw's head, the foot of a
             pillar - the joint stays where it is and the part grows out of it.
             A part that touches nothing kept falls back to its own middle.
     centre  the middle of the part's own box.
     base    the middle of the bottom (lowest raw Z) of the part's own box.

   SAME TRIANGLES. Nothing is cut or added: the triangles that cross a zone's
   skin stretch to join the two sizes, so a closed piece stays closed. A
   triangle turned inside out by the move (a part shrunk past the kept ring it
   joins) is a fold, and apply() refuses it in words.

   FIT. fit(soup, tri, point) sizes a zone to the part the click was on: the
   cross-section through the click (the loop the point is on), walked along
   the axis while the section keeps its size, stopped where it jumps (a
   shoulder, a head, the base a pillar stands on) or ends. A round section
   gives a cylinder, any other a box, just bigger than the part.
   ============================================================ */
(function (root) {
  'use strict';

  var Q = 1e4;                 // vertices weld on a 0.1 micron grid
  var TOL = 1e-6;              // a vertex on a zone's skin is in it
  var MIN_FACTOR = 0.05, MAX_FACTOR = 20;
  var AXES = ['X', 'Y', 'Z'];

  /* ---------------------------------------------------------------- index */

  /** Weld the soup: unique vertices, each triangle's three, and the vertex neighbours. */
  function index(soup) {
    var n = (soup.length / 9) | 0, map = new Map(), pos = [], tv = new Int32Array(n * 3);
    for (var t = 0; t < n; t++) {
      for (var c = 0; c < 3; c++) {
        var o = t * 9 + c * 3;
        var k = Math.round(soup[o] * Q) + ',' + Math.round(soup[o + 1] * Q) + ',' + Math.round(soup[o + 2] * Q);
        var id = map.get(k);
        if (id === undefined) { id = pos.length / 3; map.set(k, id); pos.push(soup[o], soup[o + 1], soup[o + 2]); }
        tv[t * 3 + c] = id;
      }
    }
    var nv = pos.length / 3, deg = new Int32Array(nv + 1);
    for (var i = 0; i < n * 3; i++) deg[tv[i]] += 2;
    var start = new Int32Array(nv + 1);
    for (var v = 0; v < nv; v++) start[v + 1] = start[v] + deg[v];
    var fill = start.slice(0, nv), nb = new Int32Array(start[nv]);
    for (t = 0; t < n; t++) {
      for (c = 0; c < 3; c++) {
        var a = tv[t * 3 + c], b = tv[t * 3 + (c + 1) % 3];
        if (a === b) continue;
        nb[fill[a]++] = b; nb[fill[b]++] = a;
      }
    }
    return { n: n, nv: nv, pos: new Float64Array(pos), tv: tv, start: start, fill: fill, nb: nb, soup: soup };
  }
  function neighbours(ix, v, fn) { for (var j = ix.start[v]; j < ix.fill[v]; j++) fn(ix.nb[j]); }

  /* ---------------------------------------------------------------- zones */

  function copy(z) {
    var o = { id: z.id, kind: z.kind === 'keep' ? 'keep' : 'scale', shape: z.shape === 'cyl' ? 'cyl' : 'box', c: z.c.slice() };
    if (o.shape === 'cyl') { o.axis = z.axis | 0; o.r = +z.r; o.hl = +z.hl; } else o.h = z.h.slice();
    return o;
  }
  function valid(z) {
    if (!z || !z.c || z.c.length !== 3 || !z.c.every(isFinite)) return false;
    if (z.shape === 'cyl') return z.r > 0 && z.hl > 0 && (z.axis === 0 || z.axis === 1 || z.axis === 2);
    return !!(z.h && z.h.length === 3 && z.h.every(function (v) { return v > 0; }));
  }
  /** Signed distance from the zone's skin: < 0 inside, > 0 outside. */
  function sdf(z, x, y, w) {
    var p = [x - z.c[0], y - z.c[1], w - z.c[2]], d0, d1;
    if (z.shape === 'cyl') {
      var a = z.axis, u = p[(a + 1) % 3], v = p[(a + 2) % 3];
      d0 = Math.sqrt(u * u + v * v) - z.r; d1 = Math.abs(p[a]) - z.hl;
      var o0 = Math.max(d0, 0), o1 = Math.max(d1, 0);
      return Math.sqrt(o0 * o0 + o1 * o1) + Math.min(Math.max(d0, d1), 0);
    }
    var q0 = Math.abs(p[0]) - z.h[0], q1 = Math.abs(p[1]) - z.h[1], q2 = Math.abs(p[2]) - z.h[2];
    var e0 = Math.max(q0, 0), e1 = Math.max(q1, 0), e2 = Math.max(q2, 0);
    return Math.sqrt(e0 * e0 + e1 * e1 + e2 * e2) + Math.min(Math.max(q0, q1, q2), 0);
  }
  /** The zone's box: { lo, hi }. */
  function bounds(z) {
    var h = z.shape === 'cyl' ? [z.r, z.r, z.r] : z.h.slice();
    if (z.shape === 'cyl') h[z.axis] = z.hl;
    return { lo: [z.c[0] - h[0], z.c[1] - h[1], z.c[2] - h[2]], hi: [z.c[0] + h[0], z.c[1] + h[1], z.c[2] + h[2]] };
  }
  /** Its sizes in words, in mm: "cylinder Ø10.2 × 21.0 along Z" / "box 20.0 × 20.0 × 12.0". */
  function describe(z, fmt) {
    fmt = fmt || function (v) { return (Math.round(v * 10) / 10).toFixed(1); };
    if (z.shape === 'cyl') return 'cylinder Ø' + fmt(2 * z.r) + ' × ' + fmt(2 * z.hl) + ' along ' + AXES[z.axis];
    return 'box ' + fmt(2 * z.h[0]) + ' × ' + fmt(2 * z.h[1]) + ' × ' + fmt(2 * z.h[2]);
  }

  function smooth(t) { return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }

  /** The weight of one point, and the scale zone it belongs to (-1: none / keep-only mode). */
  function weightAt(zs, blend, x, y, w) {
    var wk = 1, i, d;
    for (i = 0; i < zs.keep.length; i++) {
      d = sdf(zs.keep[i], x, y, w);
      if (blend > 0) wk = Math.min(wk, clamp01(d / blend)); else if (d <= TOL) { wk = 0; break; }
      if (wk === 0) break;
    }
    if (wk === 0) return { w: 0, zone: -1 };
    var ws = 1, zone = -1;
    if (zs.scale.length) {
      ws = 0;
      for (i = 0; i < zs.scale.length; i++) {
        d = -sdf(zs.scale[i], x, y, w);
        var val = blend > 0 ? clamp01(d / blend) : (d >= -TOL ? 1 : 0);
        if (val > ws || (zone < 0 && val > 0)) { ws = val; zone = i; }
      }
    }
    var out = wk * ws;
    return { w: blend > 0 ? smooth(out) : out, zone: out > 0 ? zone : -1 };
  }
  function split(zones) {
    var keep = [], scale = [];
    (zones || []).forEach(function (z) { if (valid(z)) (z.kind === 'keep' ? keep : scale).push(z); });
    return { keep: keep, scale: scale };
  }

  /** Every vertex's weight and zone. */
  function weights(ix, zones, blend) {
    var zs = split(zones), w = new Float32Array(ix.nv), zid = new Int16Array(ix.nv);
    for (var v = 0; v < ix.nv; v++) {
      var r = weightAt(zs, blend, ix.pos[v * 3], ix.pos[v * 3 + 1], ix.pos[v * 3 + 2]);
      w[v] = r.w; zid[v] = r.zone;
    }
    return { w: w, zid: zid, zs: zs };
  }

  /* ---------------------------------------------------------------- parts */

  /**
   * The parts that move, each with its pivot. opts: { ix, blend, anchor: 'join' | 'centre' | 'base' }.
   * -> { ok, parts: [{ verts, zone, pivot, lo, hi, joined }], w, zid, moving, kept, reason }
   */
  function plan(soup, zones, opts) {
    opts = opts || {};
    var ix = opts.ix || index(soup), blend = Math.max(0, +opts.blend || 0), anchor = opts.anchor || 'join';
    var zs = split(zones);
    if (!zs.keep.length && !zs.scale.length) return { ok: false, reason: 'no zones yet - add a Keep or a Scale zone first' };
    var W = weights(ix, zones, blend), w = W.w, zid = W.zid;
    var par = new Int32Array(ix.nv), moving = 0;
    for (var v = 0; v < ix.nv; v++) { par[v] = v; if (w[v] > 0) moving++; }
    if (!moving) {
      return { ok: false, reason: zs.scale.length ? 'no part of the piece is inside a Scale zone' : 'the Keep zones hold the whole piece - nothing is left to scale' };
    }
    function find(x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }
    for (v = 0; v < ix.nv; v++) {
      if (!(w[v] > 0)) continue;
      for (var j = ix.start[v]; j < ix.fill[v]; j++) {
        var u = ix.nb[j];
        if (w[u] > 0 && zid[u] === zid[v]) { var a = find(u), b = find(v); if (a !== b) par[a] = b; }
      }
    }
    var byRoot = new Map(), parts = [];
    for (v = 0; v < ix.nv; v++) {
      if (!(w[v] > 0)) continue;
      var r = find(v), P = byRoot.get(r);
      if (!P) { P = { verts: [], zone: zid[v], lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], cross: null }; byRoot.set(r, P); parts.push(P); }
      P.verts.push(v);
      for (var k = 0; k < 3; k++) { var x = ix.pos[v * 3 + k]; if (x < P.lo[k]) P.lo[k] = x; if (x > P.hi[k]) P.hi[k] = x; }
    }
    /* where each part meets what is kept: its edges to a w = 0 vertex, cut where w falls to 0 */
    parts.forEach(function (P) {
      var clo = [Infinity, Infinity, Infinity], chi = [-Infinity, -Infinity, -Infinity], nCross = 0;
      P.verts.forEach(function (a) {
        for (var j = ix.start[a]; j < ix.fill[a]; j++) {
          var b = ix.nb[j];
          if (w[b] > 0) continue;
          var ax = ix.pos[a * 3], ay = ix.pos[a * 3 + 1], az = ix.pos[a * 3 + 2];
          var dx = ix.pos[b * 3] - ax, dy = ix.pos[b * 3 + 1] - ay, dz = ix.pos[b * 3 + 2] - az;
          var t0 = 0, t1 = 1;
          for (var it = 0; it < 30; it++) {
            var tm = (t0 + t1) / 2;
            if (weightAt(zs, blend, ax + dx * tm, ay + dy * tm, az + dz * tm).w > 0) t0 = tm; else t1 = tm;
          }
          var p = [ax + dx * t1, ay + dy * t1, az + dz * t1];
          for (var k = 0; k < 3; k++) { if (p[k] < clo[k]) clo[k] = p[k]; if (p[k] > chi[k]) chi[k] = p[k]; }
          nCross++;
        }
      });
      P.joined = nCross > 0;
      P.crossings = nCross;
      var mid = [(P.lo[0] + P.hi[0]) / 2, (P.lo[1] + P.hi[1]) / 2, (P.lo[2] + P.hi[2]) / 2];
      if (anchor === 'centre') P.pivot = mid;
      else if (anchor === 'base') P.pivot = [mid[0], mid[1], P.lo[2]];
      else P.pivot = nCross ? [(clo[0] + chi[0]) / 2, (clo[1] + chi[1]) / 2, (clo[2] + chi[2]) / 2] : mid;
      P.anchor = anchor === 'join' && !nCross ? 'centre' : anchor;
    });
    parts.sort(function (a, b) { return b.verts.length - a.verts.length; });
    return { ok: true, ix: ix, parts: parts, w: w, zid: zid, moving: moving, kept: ix.nv - moving };
  }

  function factors(f) {
    if (typeof f === 'number') return [f, f, f];
    if (f && f.length === 3) return [+f[0], +f[1], +f[2]];
    return null;
  }

  /**
   * Scale the parts. factor: a number (uniform) or [fx, fy, fz] in the raw axes.
   * opts: { ix, blend, anchor, pivot (one pivot for every part, overrides anchor) }.
   * -> { ok, soup, parts: [{ pivot, verts, lo, hi, newLo, newHi, joined, anchor }], moving, kept, folds, reason }
   */
  function apply(soup, zones, factor, opts) {
    opts = opts || {};
    var F = factors(factor);
    if (!F || !F.every(isFinite)) return { ok: false, reason: 'the scale is not a number' };
    for (var k = 0; k < 3; k++) {
      if (!(F[k] >= MIN_FACTOR && F[k] <= MAX_FACTOR)) {
        return { ok: false, reason: 'a scale of ' + Math.round(F[k] * 1000) / 10 + '% is outside ' + (MIN_FACTOR * 100) + '% to ' + (MAX_FACTOR * 100) + '%' };
      }
    }
    var P = plan(soup, zones, opts);
    if (!P.ok) return P;
    var ix = P.ix, w = P.w, np = new Float64Array(ix.pos);
    P.parts.forEach(function (part) {
      var pv = opts.pivot ? opts.pivot.slice() : part.pivot;
      part.pivot = pv;
      var nlo = [Infinity, Infinity, Infinity], nhi = [-Infinity, -Infinity, -Infinity];
      part.verts.forEach(function (v) {
        var wv = w[v];
        for (var k = 0; k < 3; k++) {
          var x = ix.pos[v * 3 + k], s = pv[k] + (x - pv[k]) * F[k], y = x + wv * (s - x);
          np[v * 3 + k] = y;
          if (y < nlo[k]) nlo[k] = y; if (y > nhi[k]) nhi[k] = y;
        }
      });
      part.newLo = nlo; part.newHi = nhi;
    });
    /* each corner is moved from its OWN coordinates (the weld groups corners a hair apart), so a kept
       corner is bit for bit what it was and the corners of one vertex move alike */
    var pivotOf = new Map();
    P.parts.forEach(function (part) { part.verts.forEach(function (v) { pivotOf.set(v, part.pivot); }); });
    var out = new Float32Array(ix.n * 9), folds = 0, flat = 0;
    for (var t = 0; t < ix.n; t++) {
      var moved = false;
      for (var c = 0; c < 3; c++) {
        var v = ix.tv[t * 3 + c], o = t * 9 + c * 3, wv = w[v];
        if (!(wv > 0)) { out[o] = soup[o]; out[o + 1] = soup[o + 1]; out[o + 2] = soup[o + 2]; continue; }
        moved = true;
        var pv = pivotOf.get(v);
        for (var q = 0; q < 3; q++) { var x0 = soup[o + q]; out[o + q] = x0 + wv * (pv[q] + (x0 - pv[q]) * F[q] - x0); }
      }
      if (!moved) continue;
      var n0 = normal(ix.pos, ix.tv, t), n1 = normal(np, ix.tv, t);
      var l0 = Math.hypot(n0[0], n0[1], n0[2]), l1 = Math.hypot(n1[0], n1[1], n1[2]);
      if (l0 < 1e-12) continue;                                  // already a sliver: nothing to turn over
      if (l1 < 1e-9 * Math.max(1, l0)) { flat++; continue; }
      if (n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2] < 0) folds++;
    }
    var res = { ok: true, soup: out, parts: P.parts.map(function (p) {
      return { pivot: p.pivot, verts: p.verts.length, zone: p.zone, lo: p.lo, hi: p.hi, newLo: p.newLo, newHi: p.newHi, joined: p.joined, anchor: opts.pivot ? 'pivot' : p.anchor };
    }), moving: P.moving, kept: P.kept, folds: folds, flat: flat, factor: F };
    if (folds || flat) {
      res.ok = false;
      res.reason = (folds ? folds + ' face' + (folds === 1 ? '' : 's') + ' would turn inside out' : flat + ' face' + (flat === 1 ? '' : 's') + ' would flatten to nothing') +
        ' where the scaled part meets the kept one - ' + (F.some(function (f) { return f < 1; }) ? 'it is shrunk past what it joins; ' : '') +
        'scale it less, add a Blend, or move the zone\'s edge';
    }
    return res;
  }
  function normal(pos, tv, t) {
    var a = tv[t * 3] * 3, b = tv[t * 3 + 1] * 3, c = tv[t * 3 + 2] * 3;
    var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    var vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  }

  /** A scale zone carried with its part (after a Set), so it still holds it. */
  function carry(z, pivot, factor) {
    var F = factors(factor), o = copy(z);
    o.c = [0, 1, 2].map(function (k) { return pivot[k] + (z.c[k] - pivot[k]) * F[k]; });
    if (o.shape === 'cyl') {
      var a = o.axis;
      o.hl = z.hl * F[a];
      o.r = z.r * Math.max(F[(a + 1) % 3], F[(a + 2) % 3]);
    } else o.h = z.h.map(function (v, k) { return v * F[k]; });
    return o;
  }

  /* ---------------------------------------------------------------- fit */

  /* the points where the plane x[a] = h cuts triangle t (0 or 2 of them) */
  function cut(soup, t, a, h, out) {
    var o = t * 9, got = 0;
    for (var e = 0; e < 3; e++) {
      var i = o + e * 3, j = o + ((e + 1) % 3) * 3;
      var da = soup[i + a] - h, db = soup[j + a] - h;
      if ((da < 0 && db >= 0) || (da >= 0 && db < 0)) {
        var s = da / (da - db);
        out.push(soup[i] + (soup[j] - soup[i]) * s, soup[i + 1] + (soup[j + 1] - soup[i + 1]) * s, soup[i + 2] + (soup[j + 2] - soup[i + 2]) * s);
        got++;
      }
    }
    if (got !== 2) { out.length -= got * 3; return false; }
    return true;
  }

  /* The loop of the section x[a] = h that the click point is on: the slice's segments chained into
     loops through the triangles' shared edges, and the smallest whose box holds the point (else the nearest). */
  function loopAt(ix, a, h, point) {
    var soup = ix.soup, edgeOwner = new Map(), segs = [], pts = [];
    var par = [];
    function find(x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }
    for (var t = 0; t < ix.n; t++) {
      var o = t * 9;
      var lo = Math.min(soup[o + a], soup[o + 3 + a], soup[o + 6 + a]), hi = Math.max(soup[o + a], soup[o + 3 + a], soup[o + 6 + a]);
      if (!(lo < h && hi > h)) continue;
      var before = pts.length;
      if (!cut(soup, t, a, h, pts)) continue;
      var s = segs.length;
      segs.push(t);
      par.push(s);
      for (var e = 0; e < 3; e++) {
        var va = ix.tv[t * 3 + e], vb = ix.tv[t * 3 + (e + 1) % 3];
        var key = va < vb ? va + '_' + vb : vb + '_' + va, other = edgeOwner.get(key);
        if (other === undefined) edgeOwner.set(key, s); else { var r1 = find(other), r2 = find(s); if (r1 !== r2) par[r1] = r2; }
      }
      void before;
    }
    if (!segs.length) return null;
    var u = (a + 1) % 3, v = (a + 2) % 3, loops = new Map();
    for (var i = 0; i < segs.length; i++) {
      var r = find(i), L = loops.get(r);
      if (!L) { L = { pts: [], lo: [Infinity, Infinity], hi: [-Infinity, -Infinity], near: Infinity }; loops.set(r, L); }
      for (var q = 0; q < 2; q++) {
        var x = pts[i * 6 + q * 3 + u], y = pts[i * 6 + q * 3 + v];
        L.pts.push(x, y);
        if (x < L.lo[0]) L.lo[0] = x; if (x > L.hi[0]) L.hi[0] = x;
        if (y < L.lo[1]) L.lo[1] = y; if (y > L.hi[1]) L.hi[1] = y;
      }
      var d = segDist(point[u], point[v], pts[i * 6 + u], pts[i * 6 + v], pts[i * 6 + 3 + u], pts[i * 6 + 3 + v]);
      if (d < L.near) L.near = d;
    }
    var best = null, pad = 1e-3;
    loops.forEach(function (L) {
      var holds = point[u] >= L.lo[0] - pad && point[u] <= L.hi[0] + pad && point[v] >= L.lo[1] - pad && point[v] <= L.hi[1] + pad;
      L.area = (L.hi[0] - L.lo[0]) * (L.hi[1] - L.lo[1]);
      L.holds = holds;
      if (!best || (holds && !best.holds) || (holds === best.holds && (holds ? L.area < best.area : L.near < best.near))) best = L;
    });
    return best;
  }
  function segDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy, t = l > 0 ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }

  /* the fit along one axis from one clicked point */
  function fitAxis(ix, a, point, extentLo, extentHi) {
    var soup = ix.soup, u = (a + 1) % 3, v = (a + 2) % 3, span = extentHi - extentLo;
    var h0 = point[a], step0 = Math.max(1e-3, span * 1e-4), L = null;
    /* the plane through the click; a click on a face square to the axis (a cap) slides off it either way */
    var tries = [h0, h0 - step0 * 20, h0 + step0 * 20, h0 - span * 0.01, h0 + span * 0.01];
    for (var i = 0; i < tries.length && !L; i++) {
      if (tries[i] <= extentLo || tries[i] >= extentHi) continue;
      var cand = loopAt(ix, a, tries[i], point);
      if (cand && (cand.holds || cand.near < span * 0.02)) { L = cand; h0 = tries[i]; }
    }
    if (!L) return null;
    var cu = (L.lo[0] + L.hi[0]) / 2, cv = (L.lo[1] + L.hi[1]) / 2, R0 = 0, Rin = Infinity;
    for (i = 0; i < L.pts.length; i += 2) {
      var d = Math.hypot(L.pts[i] - cu, L.pts[i + 1] - cv);
      if (d > R0) R0 = d; if (d < Rin) Rin = d;
    }
    if (!(R0 > 0)) return null;
    var Rlim = Math.max(2.5 * R0, R0 + 3);
    /* the triangles near the axis, binned along it */
    var step = Math.min(0.5, Math.max(0.02, R0 / 8)), nb = Math.max(1, Math.ceil(span / step) + 1), bins = [];
    for (i = 0; i < nb; i++) bins.push([]);
    for (var t = 0; t < ix.n; t++) {
      var o = t * 9, alo = Infinity, ahi = -Infinity, ulo = Infinity, uhi = -Infinity, vlo = Infinity, vhi = -Infinity;
      for (var c = 0; c < 3; c++) {
        var pa = soup[o + c * 3 + a], pu = soup[o + c * 3 + u], pv = soup[o + c * 3 + v];
        if (pa < alo) alo = pa; if (pa > ahi) ahi = pa;
        if (pu < ulo) ulo = pu; if (pu > uhi) uhi = pu;
        if (pv < vlo) vlo = pv; if (pv > vhi) vhi = pv;
      }
      if (ulo > cu + Rlim || uhi < cu - Rlim || vlo > cv + Rlim || vhi < cv - Rlim) continue;
      var b0 = Math.max(0, Math.floor((alo - extentLo) / step)), b1 = Math.min(nb - 1, Math.floor((ahi - extentLo) / step));
      for (var b = b0; b <= b1; b++) bins[b].push(t);
    }
    var buf = [];
    function measure(h) {
      var b = Math.floor((h - extentLo) / step);
      if (b < 0 || b >= nb) return null;
      var max = -1, n = 0, lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      bins[b].forEach(function (t) {
        buf.length = 0;
        if (!cut(soup, t, a, h, buf)) return;
        for (var q = 0; q < 6; q += 3) {
          var du = buf[q + u] - cu, dv = buf[q + v] - cv, d = Math.sqrt(du * du + dv * dv);
          if (d > Rlim) continue;
          n++;
          if (d > max) max = d;
          if (buf[q + u] < lo[0]) lo[0] = buf[q + u]; if (buf[q + u] > hi[0]) hi[0] = buf[q + u];
          if (buf[q + v] < lo[1]) lo[1] = buf[q + v]; if (buf[q + v] > hi[1]) hi[1] = buf[q + v];
        }
      });
      return n ? { max: max, lo: lo, hi: hi } : null;
    }
    /* The axis. One section of a thread is off its axis (a single-start thread's section is a spiral, its box
       shifted by up to the thread's depth), so the middle is taken over the sections a little either side -
       a turn of a thread sweeps every angle - and only those the size of the clicked one, so a shoulder near
       the click does not pull it over. */
    var uLo = L.lo[0], uHi = L.hi[0], vLo = L.lo[1], vHi = L.hi[1], win = Math.max(R0, 2), ns = 24;
    for (i = -ns; i <= ns; i++) {
      var hs = h0 + win * i / ns, ms = measure(hs);
      if (!ms || ms.max > R0 * 1.35 + 0.3 || ms.max < R0 * 0.5) continue;
      if (ms.lo[0] < uLo) uLo = ms.lo[0]; if (ms.hi[0] > uHi) uHi = ms.hi[0];
      if (ms.lo[1] < vLo) vLo = ms.lo[1]; if (ms.hi[1] > vHi) vHi = ms.hi[1];
    }
    cu = (uLo + uHi) / 2; cv = (vLo + vHi) / 2;
    var aspect = Math.min(uHi - uLo, vHi - vLo) / Math.max(uHi - uLo, vHi - vLo);
    R0 = 0; Rin = Infinity;
    for (i = 0; i < L.pts.length; i += 2) {
      var dd = Math.hypot(L.pts[i] - cu, L.pts[i + 1] - cv);
      if (dd > R0) R0 = dd; if (dd < Rin) Rin = dd;
    }
    var m0 = measure(h0);
    if (m0 && m0.max > R0) R0 = m0.max;
    var round = Rin / R0 > 0.75 && aspect > 0.9;
    var Rhi = R0 * 1.02 + 0.05, Rlo = R0 * 0.6;
    function ok(h) { var m = measure(h); return !!(m && m.max <= Rhi && m.max >= Rlo); }
    if (!ok(h0)) return null;
    var run = { R: R0, lo: [L.lo[0], L.lo[1]], hi: [L.hi[0], L.hi[1]] };
    function walk(dir) {
      var hOk = h0, h = h0;
      for (;;) {
        h += dir * step;
        if (h <= extentLo || h >= extentHi) return dir > 0 ? extentHi + step * 0.01 : extentLo - step * 0.01;
        var m = measure(h);
        if (!(m && m.max <= Rhi && m.max >= Rlo)) break;
        if (m.max > run.R) run.R = m.max;
        if (m.lo[0] < run.lo[0]) run.lo[0] = m.lo[0]; if (m.hi[0] > run.hi[0]) run.hi[0] = m.hi[0];
        if (m.lo[1] < run.lo[1]) run.lo[1] = m.lo[1]; if (m.hi[1] > run.hi[1]) run.hi[1] = m.hi[1];
        hOk = h;
      }
      var hBad = h;
      for (var it = 0; it < 18; it++) { var hm = (hOk + hBad) / 2; if (ok(hm)) hOk = hm; else hBad = hm; }
      return hBad + dir * 1e-3;
    }
    var hiEnd = walk(1), loEnd = walk(-1);
    return { axis: a, cu: cu, cv: cv, R: run.R, round: round, lo: loEnd, hi: hiEnd, len: hiEnd - loEnd, box: run, h: h0 };
  }

  /**
   * A zone sized to the part under a click. tri: the clicked triangle; point: the click on it (raw).
   * opts: { ix, kind: 'keep' | 'scale', axis (force one) }.
   * -> { ok, zone, axis, round, reason }
   */
  function fit(soup, tri, point, opts) {
    opts = opts || {};
    var ix = opts.ix || index(soup);
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < ix.nv; i++) for (var k = 0; k < 3; k++) { var x = ix.pos[i * 3 + k]; if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }
    if (!point) {
      var o = tri * 9;
      point = [0, 1, 2].map(function (k) { return (soup[o + k] + soup[o + 3 + k] + soup[o + 6 + k]) / 3; });
    }
    var axes = opts.axis != null ? [opts.axis] : [2, 0, 1], best = null;
    axes.forEach(function (a) {
      var f = fitAxis(ix, a, point, lo[a], hi[a]);
      if (!f) return;
      f.score = f.len / (2 * f.R);
      /* a round section is what a turned part (a thread, a shaft, a pillar) shows along its own axis, so a
         round fit beats any other; among the same kind the more slender wins, Z on a near tie */
      if (!best || (f.round && !best.round) || (f.round === best.round && (f.score > best.score * 1.15 || (f.score > best.score && a === 2)))) best = f;
    });
    if (!best) return { ok: false, reason: 'no part could be traced through that point - put a box there and size it by hand' };
    var a = best.axis, u = (a + 1) % 3, v = (a + 2) % 3, kind = opts.kind === 'keep' ? 'keep' : 'scale', z;
    var c = [0, 0, 0];
    c[a] = (best.lo + best.hi) / 2;
    if (best.round) {
      c[u] = best.cu; c[v] = best.cv;
      z = { kind: kind, shape: 'cyl', c: c, axis: a, r: best.R + Math.max(0.15, best.R * 0.03), hl: (best.hi - best.lo) / 2 };
    } else {
      var m = Math.max(0.15, best.R * 0.03), h = [0, 0, 0];
      c[u] = (best.box.lo[0] + best.box.hi[0]) / 2; c[v] = (best.box.lo[1] + best.box.hi[1]) / 2;
      h[u] = (best.box.hi[0] - best.box.lo[0]) / 2 + m; h[v] = (best.box.hi[1] - best.box.lo[1]) / 2 + m; h[a] = (best.hi - best.lo) / 2;
      z = { kind: kind, shape: 'box', c: c, h: h };
    }
    return { ok: true, zone: z, axis: a, round: best.round, length: best.hi - best.lo, radius: best.R };
  }

  var api = {
    index: index, sdf: sdf, bounds: bounds, copy: copy, valid: valid, describe: describe,
    weights: weights, plan: plan, apply: apply, carry: carry, fit: fit,
    MIN_FACTOR: MIN_FACTOR, MAX_FACTOR: MAX_FACTOR, AXES: AXES
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSO_ScaleZones = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
