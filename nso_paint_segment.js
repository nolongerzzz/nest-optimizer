/*
 * NSO colour segmentation - a painted piece's layers split by filament, as Bambu Studio splits them
 * ------------------------------------------------------------------------------------------------
 * Studio 02.09.01.70's MultiMaterialSegmentation.cpp (multi_material_segmentation_by_painting), in the
 * same three parts (docs/MULTICOLOR.md, "Colours on one layer"):
 *
 *   1. THE SIDES. Each painted triangle that crosses a layer's cutting plane leaves a coloured line on
 *      the layer's outline. The outline takes those colours (unpainted stretches: the piece's own
 *      filament), and the layer is split among them: every point goes to the colour of the outline
 *      nearest it (Studio: a Voronoi diagram of the coloured outline). A layer whose outline is one
 *      colour is that colour; one with no painted line on it keeps its own filament.
 *   2. THE TOPS AND BOTTOMS. A top face (painted or not) colours the layer it is the top of, and the
 *      top_color_penetration_layers - 1 below it, each one (outer wall + spacing) narrower, so the
 *      colour is a skin; a bottom face the same upwards (bottom_color_penetration_layers). A face
 *      covered by the layer next to it is no top / bottom. Tops and bottoms win over the sides.
 *   3. What is left is the piece's own filament.
 *
 * NSO's Voronoi is a raster one: the layer on a 0.05 mm grid, each colour's distance to its stretch of
 * outline, the boundary where two distances are equal (interpolated, so it is no staircase), then cut
 * back to the exact outline.
 *
 * Headless (Node, the page and the slice worker). window.NSO_PaintSegment.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSO_PaintSegment = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var GRID = 0.05;              /* mm, the raster of the side split */
  var ON_EDGE = 0.06;           /* mm, how near the outline a painted line must lie to colour it */

  /* --------------------------------------------------------------------------------------------- */
  /* the paint's leaves, raw: state 0 is unpainted (the triangle's own filament)                     */
  /* --------------------------------------------------------------------------------------------- */
  function leavesOf(P, paint, decode) {
    var out = [];
    for (var i = 0; i < paint.triangles; i++) {
      var o = i * 9, a = [P[o], P[o + 1], P[o + 2]], b = [P[o + 3], P[o + 4], P[o + 5]], c = [P[o + 6], P[o + 7], P[o + 8]];
      if (paint.flip && paint.flip[i]) { var t = b; b = c; c = t; }
      var own = paint.ext ? (paint.ext[i] || 1) : 1;
      decode(paint.codes[i], a, b, c, function (p, q, r, st) {
        var ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2], vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
        var nz = ux * vy - uy * vx, nl = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, nz) || 1;
        out.push({ p: p, q: q, r: r, st: st, own: own, nz: nz / nl,
                   z0: Math.min(p[2], q[2], r[2]), z1: Math.max(p[2], q[2], r[2]) });
      });
    }
    return out;
  }

  /** the segment where a triangle crosses the plane z (Studio's projection of a painted facet), or null */
  function cut(L, z) {
    var v = [L.p, L.q, L.r].sort(function (a, b) { return a[2] - b[2]; });
    if (z < v[0][2] - 1e-6 || z > v[2][2] + 1e-6 || v[2][2] - v[0][2] < 1e-3) return null;
    var lerp = function (a, b) { var t = (z - a[2]) / ((b[2] - a[2]) || 1); return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]; };
    var s = lerp(v[0], v[2]), e;
    if (Math.abs(v[1][2] - z) < 1e-6 && (Math.abs(v[0][2] - v[1][2]) < 1e-3 || Math.abs(v[1][2] - v[2][2]) < 1e-3)) e = [v[1][0], v[1][1]];
    else e = v[1][2] > z ? lerp(v[0], v[1]) : lerp(v[1], v[2]);
    return [s, e];
  }

  /* --------------------------------------------------------------------------------------------- */
  /* 1. the sides                                                                                   */
  /* --------------------------------------------------------------------------------------------- */
  /** The outline's colour, sampled: [{x, y, c}] every GRID along each loop (c 0: unpainted). */
  function colourOutline(loops, segs) {
    var out = [];
    /* the painted lines in buckets of 2 mm, for the nearest-line look-up */
    var B = 2, grid = new Map();
    segs.forEach(function (s, k) {
      var x0 = Math.floor(Math.min(s.a[0], s.b[0]) / B), x1 = Math.floor(Math.max(s.a[0], s.b[0]) / B);
      var y0 = Math.floor(Math.min(s.a[1], s.b[1]) / B), y1 = Math.floor(Math.max(s.a[1], s.b[1]) / B);
      for (var gx = x0; gx <= x1; gx++) for (var gy = y0; gy <= y1; gy++) { var key = gx + ',' + gy; (grid.get(key) || grid.set(key, []).get(key)).push(k); }
    });
    var near = function (x, y) {
      var best = 0, bd = ON_EDGE, key = Math.floor(x / B) + ',' + Math.floor(y / B), list = grid.get(key) || [];
      for (var i = 0; i < list.length; i++) {
        var s = segs[list[i]], dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], l2 = dx * dx + dy * dy;
        var t = l2 > 0 ? Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (y - s.a[1]) * dy) / l2)) : 0;
        var d = Math.hypot(s.a[0] + t * dx - x, s.a[1] + t * dy - y);
        if (d < bd) { bd = d; best = s.c; }
      }
      return best;
    };
    loops.forEach(function (lp) {
      for (var i = 0; i < lp.length; i++) {
        var a = lp[i], b = lp[(i + 1) % lp.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len / GRID));
        for (var k = 0; k < n; k++) {
          var x = a[0] + (b[0] - a[0]) * (k + 0.5) / n, y = a[1] + (b[1] - a[1]) * (k + 0.5) / n;
          out.push({ x: x, y: y, c: near(x, y) });
        }
      }
    });
    return out;
  }

  /** Felzenszwalb's squared distance transform of one row / column (f: 0 at a seed, Infinity elsewhere), in place */
  function dt1(f, n, d, v, z) {
    var k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (var q = 1; q < n; q++) {
      if (f[q] === Infinity) continue;
      if (f[v[k]] === Infinity) { v[k] = q; continue; }
      var s;
      while (true) {
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
        if (s <= z[k] && k > 0) { k--; continue; }
        break;
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    if (f[v[0]] === Infinity) { for (var i = 0; i < n; i++) d[i] = Infinity; return; }
    k = 0;
    for (var q2 = 0; q2 < n; q2++) {
      while (z[k + 1] < q2) k++;
      var dq = q2 - v[k];
      d[q2] = dq * dq + f[v[k]];
    }
  }
  function edt(seed, W, H) {
    var f = new Float64Array(Math.max(W, H)), d = new Float64Array(Math.max(W, H)), v = new Int32Array(Math.max(W, H)), z = new Float64Array(Math.max(W, H) + 1);
    var out = new Float64Array(W * H), x, y;
    for (x = 0; x < W; x++) {
      for (y = 0; y < H; y++) f[y] = seed[y * W + x] ? 0 : Infinity;
      dt1(f, H, d, v, z);
      for (y = 0; y < H; y++) out[y * W + x] = d[y];
    }
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) f[x] = out[y * W + x];
      dt1(f, W, d, v, z);
      for (x = 0; x < W; x++) out[y * W + x] = Math.sqrt(d[x]);
    }
    return out;
  }

  /** marching squares: the loops where field > 0 (outer and holes; read them with the even-odd rule) */
  function contours(field, W, H, x0, y0) {
    var segs = [];
    var P = function (i, j) { return field[j * W + i]; };
    var at = function (i, j, i2, j2) {
      var a = P(i, j), b = P(i2, j2), t = a / ((a - b) || 1e-12);
      return [x0 + (i + (i2 - i) * t) * GRID, y0 + (j + (j2 - j) * t) * GRID];
    };
    for (var j = 0; j + 1 < H; j++) {
      for (var i = 0; i + 1 < W; i++) {
        var a = P(i, j) > 0, b = P(i + 1, j) > 0, c = P(i + 1, j + 1) > 0, d = P(i, j + 1) > 0;
        var code = (a ? 1 : 0) | (b ? 2 : 0) | (c ? 4 : 0) | (d ? 8 : 0);
        if (code === 0 || code === 15) continue;
        var eB = function () { return at(i, j, i + 1, j); }, eR = function () { return at(i + 1, j, i + 1, j + 1); };
        var eT = function () { return at(i, j + 1, i + 1, j + 1); }, eL = function () { return at(i, j, i, j + 1); };
        switch (code) {
          case 1: case 14: segs.push([eL(), eB()]); break;
          case 2: case 13: segs.push([eB(), eR()]); break;
          case 3: case 12: segs.push([eL(), eR()]); break;
          case 4: case 11: segs.push([eR(), eT()]); break;
          case 6: case 9: segs.push([eB(), eT()]); break;
          case 7: case 8: segs.push([eL(), eT()]); break;
          case 5: segs.push([eL(), eT()]); segs.push([eB(), eR()]); break;
          case 10: segs.push([eL(), eB()]); segs.push([eR(), eT()]); break;
        }
      }
    }
    /* join the pieces into loops by their ends */
    var key = function (p) { return Math.round(p[0] * 1e5) + ',' + Math.round(p[1] * 1e5); };
    var byEnd = new Map();
    segs.forEach(function (s, k) { [0, 1].forEach(function (e) { var kk = key(s[e]); (byEnd.get(kk) || byEnd.set(kk, []).get(kk)).push(k); }); });
    var used = new Uint8Array(segs.length), loops = [];
    for (var s0 = 0; s0 < segs.length; s0++) {
      if (used[s0]) continue;
      used[s0] = 1;
      var loop = [segs[s0][0], segs[s0][1]], cur = segs[s0][1];
      for (var guard = 0; guard < segs.length; guard++) {
        var list = byEnd.get(key(cur)) || [], nx = -1;
        for (var m = 0; m < list.length; m++) if (!used[list[m]]) { nx = list[m]; break; }
        if (nx < 0) break;
        used[nx] = 1;
        var sg = segs[nx], other = key(sg[0]) === key(cur) ? sg[1] : sg[0];
        loop.push(other); cur = other;
      }
      if (loop.length > 3) loops.push(loop.slice(0, -1));
    }
    return loops;
  }

  /** The side split of one layer: { colour: Cs } (colours 1-based; 0 the piece's own), or a single colour, or null (no painted line). */
  function sides(g, cs, segs) {
    if (!segs.length) return null;
    var loops = g.polys(cs);
    var pts = colourOutline(loops, segs);
    var cols = {};
    pts.forEach(function (p) { cols[p.c] = 1; });
    var ks = Object.keys(cols).map(Number);
    if (ks.length === 1) { var one = {}; one[ks[0]] = cs; return one; }
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(function (p) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; });
    x0 -= 4 * GRID; y0 -= 4 * GRID; x1 += 4 * GRID; y1 += 4 * GRID;
    var W = Math.ceil((x1 - x0) / GRID) + 1, H = Math.ceil((y1 - y0) / GRID) + 1;
    var dist = {};
    ks.forEach(function (c) {
      var seed = new Uint8Array(W * H);
      pts.forEach(function (p) { if (p.c === c) seed[Math.round((p.y - y0) / GRID) * W + Math.round((p.x - x0) / GRID)] = 1; });
      dist[c] = edt(seed, W, H);
    });
    var out = {};
    ks.forEach(function (c) {
      var field = new Float64Array(W * H), dc = dist[c];
      for (var q = 0; q < W * H; q++) {
        var other = Infinity;
        for (var k = 0; k < ks.length; k++) if (ks[k] !== c && dist[ks[k]][q] < other) other = dist[ks[k]][q];
        field[q] = other - dc[q];
      }
      /* closed loops: the raster's own border is nobody's */
      for (var bx = 0; bx < W; bx++) { field[bx] = -1; field[(H - 1) * W + bx] = -1; }
      for (var by = 0; by < H; by++) { field[by * W] = -1; field[by * W + W - 1] = -1; }
      var reg = g.of(contours(field, W, H, x0, y0), 'EvenOdd');
      out[c] = g.inter(cs, reg);
    });
    return out;
  }

  /* --------------------------------------------------------------------------------------------- */
  /* the whole piece                                                                                */
  /* --------------------------------------------------------------------------------------------- */
  /**
   * segment(g, soup, paint, decode, planes, S, o) -> per layer { slot: Cs } (0-based slots), covering S[i].
   *   planes: [{ sliceZ }] in the soup's frame; S: each layer's section (the slicer's); o: { topLayers, bottomLayers, wallWidthMm,
   *   layerMm, ownSlot }.
   */
  function segment(g, soup, paint, decode, planes, S, o) {
    var n = planes.length, leaves = leavesOf(soup, paint, decode);
    var own = o.ownFilament || 1;
    var w = o.wallWidthMm || 0.42;
    var spacing = function (h) { return w - h * (1 - Math.PI / 4); };
    var openR = 0.5 * w * 0.5;                                  /* small_region_threshold: half an outer wall, halved (gap fill on) */
    var open = function (cs) { return g.isEmpty(cs) ? cs : g.offset(g.offset(cs, -openR), openR); };
    var zs = planes.map(function (p) { return p.sliceZ; });

    /* the side lines of each layer, from the painted (state > 0) leaves */
    var segsAt = zs.map(function () { return []; });
    leaves.forEach(function (L) {
      if (L.st <= 0 || L.z1 - L.z0 < 1e-3) return;
      for (var i = 0; i < n; i++) {
        if (zs[i] < L.z0 - 1e-6) continue;
        if (zs[i] > L.z1 + 1e-6) break;
        var s = cut(L, zs[i]);
        if (s) segsAt[i].push({ a: s[0], b: s[1], c: L.st });
      }
    });

    /* the tops and bottoms: each up / down facing leaf (painted or not: colour 0 is the piece's own) over the layer it caps */
    var nc = 0; leaves.forEach(function (L) { if (L.st > nc) nc = L.st; });
    var topRaw = [], botRaw = [];
    for (var c0 = 0; c0 <= nc; c0++) { topRaw.push(zs.map(function () { return []; })); botRaw.push(zs.map(function () { return []; })); }
    leaves.forEach(function (L) {
      if (Math.abs(L.nz) < 1e-6) return;
      var tri = [[L.p[0], L.p[1]], [L.q[0], L.q[1]], [L.r[0], L.r[1]]];
      if (L.nz < 0) tri.reverse();
      for (var i = 0; i < n; i++) {
        var lo = i > 0 ? zs[i - 1] : -Infinity, hi = zs[i], up = i + 1 < n ? zs[i + 1] : Infinity;
        if (L.nz > 0 && L.z1 >= hi - 1e-6 && L.z0 <= up + 1e-6 && !(L.z0 >= up - 1e-6)) topRaw[L.st][i].push(tri);
        if (L.nz < 0 && L.z0 <= hi + 1e-6 && L.z1 >= lo - 1e-6 && !(L.z1 <= lo + 1e-6)) botRaw[L.st][i].push(tri);
      }
    });
    var tbDirect = [], tbShell = [];
    for (var c1 = 0; c1 <= nc; c1++) { tbDirect.push(zs.map(function () { return []; })); tbShell.push(zs.map(function () { return []; })); }
    for (var c = 0; c <= nc; c++) {
      for (var i = 0; i < n; i++) {
        if (topRaw[c][i].length) {
          var top = g.of(topRaw[c][i], 'NonZero');
          if (i + 1 < n) top = g.diff(top, S[i + 1]);
          top = open(top);
          if (!g.isEmpty(top)) {
            tbDirect[c][i].push(top);
            var off = 0, trimmed = S[i];
            for (var last = i - 1; last > Math.max(i - o.topLayers, 0); last--) {
              off -= spacing(planes[last].h || o.layerMm) + w;
              trimmed = g.inter(trimmed, S[last]);
              var sh = open(g.inter(top, g.offset(trimmed, off)));
              if (g.isEmpty(sh)) break;
              tbShell[c][last].push(sh);
            }
          }
        }
        if (botRaw[c][i].length) {
          var bot = g.of(botRaw[c][i], 'NonZero');
          if (i > 0) bot = g.diff(bot, S[i - 1]);
          bot = open(bot);
          if (!g.isEmpty(bot)) {
            tbDirect[c][i].push(bot);
            var offb = 0, trimmedb = S[i];
            for (var lb = i + 1; lb < Math.min(i + o.bottomLayers, n); lb++) {
              offb -= spacing(planes[lb].h || o.layerMm) + w;
              trimmedb = g.inter(trimmedb, S[lb]);
              var shb = open(g.inter(bot, g.offset(trimmedb, offb)));
              if (g.isEmpty(shb)) break;
              tbShell[c][lb].push(shb);
            }
          }
        }
      }
    }

    /* each layer: the sides, then the tops and bottoms over them, then the piece's own filament in the rest */
    return S.map(function (cs, i) {
      var res = {};
      if (g.isEmpty(cs)) return res;
      /* tops / bottoms: the direct ones first, the shells where no direct one is; colour 1 first claims, then 2 ..., then 0 */
      var direct = [], painted;
      for (var c2 = 0; c2 <= nc; c2++) direct.push(g.unionAll(tbDirect[c2][i]));
      painted = g.unionAll(direct);
      var tb = [];
      for (var c3 = 0; c3 <= nc; c3++) tb.push(g.union(direct[c3], g.diff(g.unionAll(tbShell[c3][i]), painted)));
      var claimed = g.empty();
      for (var c4 = 1; c4 <= nc; c4++) { tb[c4] = g.diff(tb[c4], claimed); claimed = g.union(claimed, tb[c4]); }
      tb[0] = g.diff(tb[0], claimed);
      var tbAll = g.unionAll(tb);
      var sd = sides(g, cs, segsAt[i]) || {};
      var got = g.empty();
      var add = function (filament, region) {
        region = g.inter(region, cs);
        /* a sliver no wall can print (where two edges of the split nearly meet) is the piece's own: Studio's opening and its 0.1 mm^2 */
        if (filament !== own) region = g.dropSmall(open(region), 0.1);
        if (g.isEmpty(region) || g.area(region) < 1e-4) return;
        var slot = filament - 1;
        res[slot] = res[slot] ? g.union(res[slot], region) : region;
        got = g.union(got, region);
      };
      Object.keys(sd).map(Number).forEach(function (f) { if (f >= 1) add(f, g.diff(sd[f], tbAll)); });
      for (var c5 = 1; c5 <= nc; c5++) add(c5, tb[c5]);
      add(own, g.diff(cs, got));
      return res;
    });
  }

  return { sides: sides, segment: segment, leavesOf: leavesOf, cut: cut, edt: edt, contours: contours, GRID: GRID };
});
