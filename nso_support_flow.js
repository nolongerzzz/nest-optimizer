/* ============================================================
   nso_support_flow.js - THE TREE, GROWN ONE WAY (docs/SUPPORT-FLOW.md)

   One program for every tree support: tips at the spots that need holding,
   each carried DOWN a level at a time. On every level a branch

     - drifts toward its nearest neighbour, no faster than the branch angle
       allows, and the two become one branch where they meet;
     - stays where a route to the plate exists (THE REACH FIELD, below), so
       it walks round the part instead of being found blocked afterwards;
     - is as thick as ONE law says: the branch diameter at its top, widening
       by the diameter angle for every mm under the highest tip it carries,
       with a short flare at the plate. A twig, a branch and a trunk are the
       same thing at different depths.

   Where the trunks stand, how many there are and where the forks are is
   what falls out: no clusters, no landing circles, no per-shape rules.

   THE REACH FIELD. The part (and any occluder) is read into columns of
   solid spans on a plan grid. For every level the distance to the part is
   taken (an exact distance transform of the level's slab), and from the
   plate up a cell is FREE for a branch of a given thickness law when the
   part is far enough from it there AND a free cell lies next to it on the
   level below. A branch that keeps to free cells always has its way down.
   Thickness laws are binned by the height of the highest tip carried
   (`binMm`); the free sets are nested (a thicker law's is inside a thinner
   one's), so one byte a cell holds them all.

   plan(input) -> { ok, reason, branches, trunks, tips, unreachable, stats }
     input: { soups: [Float32Array of triangles ...]   the part first, then occluders
              plateZ, tips: [{ id, p: [x, y, z], twig }], knobs, opts }
     branches: [{ id, pts: [[x, y, z] ...] top first, r: [radius at each], into: branch id or -1 (the plate), tips: [tip ids] }]
     trunks:   [{ branch, c: [x, y], r, tips: [tip ids] }]   the branches that land
     unreachable: [tip ids]   no free start within reach of the spot, or a branch that lost its way (never built)
   prims(result) -> the branches as blobSoup's tapered capsules

   Pure: no DOM, no three.js, no other module. Deterministic.
   ============================================================ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSO_SupportFlow = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  var KNOBS = { branchDistanceMm: 5, branchDiameterMm: 2, branchAngleDeg: 45, branchDiameterAngleDeg: 5, tipDiameterMm: 0.8 };
  var DEF = {
    dzMm: 0.4,            /* a level */
    cellsMax: 12e6,       /* plan cells x levels: the grid is coarsened to hold this */
    marginMm: 6,          /* the grid reaches this far past the part and the tips, and a trunk's base radius more */
    binMm: 2,             /* thickness laws are binned by this much height of the highest tip */
    xyMm: 0.45,           /* a branch keeps this off the part in plan (the slicer's xy distance, 0.35, and the body's own keep) */
    leanAllow: 1.12,      /* a leaning round branch's level section is an ellipse: its radius counts this much wider */
    zGapMm: 0.5,          /* the part this far over a level counts on it: a branch does not climb under a ceiling */
    tipDropMm: 2.8,       /* a tip stands this far straight under its spot before it is a branch: its own column through the interface's stack and the
                             slicer's lines a mm under it, which cross one ring each (a body of tips joined there is crossed by lines over its hollow) */
    twigDropMm: 1.6,      /* ...a twig (no stack over it) this far */
    stubMaxMm: 7,         /* ...or, where the room under the spot is taken, starts at most this far under it, leaning to where there is room */
    rootFloorMm: 2.4,      /* no branch leans or joins this near the plate: the flare stands straight */
    flareMm: 2,           /* the flare: over this height above the plate the trunk widens... */
    flareTan: 0.45,       /* ...by this much a side for every mm (Bambu's P1S trunks: +1.35 mm at the first layer, gone by z 1.8) */
    reach: 0.95,          /* two branches go for one another when they can meet in this share of the height they have left */
    meet: 1.6,            /* two branches are one once their middles are this many levels' lean apart: neither steps sideways to join */
    approach: 4,          /* within this many levels' lean of the one it goes for, a branch heads straight at it */
    gather: 0.25,         /* how much of a branch's heading is toward the middle of all it can still meet, the rest toward the nearest */
    inertia: 0.5,         /* a branch's heading changes by half a level at a time: no kinks */
    twigTopMm: 0.25,      /* a twig's radius at its spot (one ring of line)... */
    twigRMm: 0.45,        /* ...and where it becomes a branch */
    rest: false,          /* the tree may stand on the part (a landing on any top face), not on the plate only */
    restMinMm: 0.8,       /* ...a tip over a face of the part is at least this long */
    minRMm: 0.2
  };

  /* ---- the part as columns of solid spans on the plan grid ---- */
  var JIT = [0.000137, 0.000219];
  function eachTriCell(soup, G, cb) {
    var c = G.c, nx = G.nx, ny = G.ny, x0 = G.x0 + JIT[0], y0 = G.y0 + JIT[1];
    for (var t = 0; t + 8 < soup.length; t += 9) {
      var ax = soup[t], ay = soup[t + 1], az = soup[t + 2], bx = soup[t + 3], by = soup[t + 4], bz = soup[t + 5], cx = soup[t + 6], cy = soup[t + 7], cz = soup[t + 8];
      var den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(den) < 1e-12) continue;                                   /* a wall seen edge on: no plan area */
      var i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - x0) / c - 0.5)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / c - 0.5));
      var j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - y0) / c - 0.5)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - y0) / c - 0.5));
      for (var j = j0; j <= j1; j++) {
        var py = y0 + (j + 0.5) * c;
        for (var i = i0; i <= i1; i++) {
          var px = x0 + (i + 0.5) * c;
          var u = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, v = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den, w = 1 - u - v;
          if (u < 0 || v < 0 || w < 0) continue;
          cb(j * nx + i, u * az + v * bz + w * cz);
        }
      }
    }
  }
  function buildSpans(soups, G) {
    var n = G.nx * G.ny, start = new Uint32Array(n + 1), s, i;
    for (s = 0; s < soups.length; s++) eachTriCell(soups[s], G, function (idx) { start[idx + 1]++; });
    for (i = 0; i < n; i++) start[i + 1] += start[i];
    var zs = new Float32Array(start[n]), fill = new Uint32Array(n);
    /* each soup is its own solid: its crossings are paired within it, so its spans go in as [in, out] already sorted per soup */
    for (s = 0; s < soups.length; s++) {
      var mark = fill.slice();
      eachTriCell(soups[s], G, function (idx, z) { zs[start[idx] + fill[idx]++] = z; });
      for (i = 0; i < n; i++) if (fill[i] - mark[i] > 1) { var a = start[i] + mark[i], b = start[i] + fill[i]; Array.prototype.sort.call(zs.subarray(a, b), function (p, q) { return p - q; }); }
    }
    return { start: start, zs: zs, soupsAt: null };
  }
  /* is (cell, z) inside the part? Spans are pairs in file order per soup; with one soup (or soups that do not share a column) the pairs are plain */
  function slabBlocked(S, n, za, zb, out) {
    var st = S.start, zs = S.zs, any = false;
    for (var i = 0; i < n; i++) {
      var a = st[i], b = st[i + 1], hit = 0;
      for (var q = a; q + 1 < b; q += 2) if (zs[q] < zb && zs[q + 1] > za) { hit = 1; break; }
      if (!hit && ((b - a) & 1) && zs[b - 1] < zb && zs[b - 1] > za) hit = 1;      /* an open sheet: its one crossing */
      out[i] = hit; if (hit) any = true;
    }
    return any;
  }
  function insideAt(S, G, x, y, z) {
    var i = Math.floor((x - G.x0) / G.c), j = Math.floor((y - G.y0) / G.c);
    if (i < 0 || j < 0 || i >= G.nx || j >= G.ny) return false;
    var idx = j * G.nx + i, a = S.start[idx], b = S.start[idx + 1];
    for (var q = a; q + 1 < b; q += 2) if (S.zs[q] < z && S.zs[q + 1] > z) return true;
    return false;
  }

  /* ---- exact squared distance to the nearest blocked cell, in cells (Felzenszwalb & Huttenlocher) ---- */
  function edt(blocked, nx, ny, out, tmp) {
    var INF = 1e12, n = Math.max(nx, ny), f = tmp.f, v = tmp.v, z = tmp.z, d = tmp.d, x, y, q, k, s;
    function pass(len) {
      k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
      for (q = 1; q < len; q++) {
        for (;;) {
          s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
          if (s <= z[k] && k > 0) k--; else break;
        }
        if (s <= z[k]) { v[k] = q; z[k] = -INF; z[k + 1] = INF; } else { k++; v[k] = q; z[k] = s; z[k + 1] = INF; }
      }
      k = 0;
      for (q = 0; q < len; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
    }
    for (x = 0; x < nx; x++) {
      for (y = 0; y < ny; y++) f[y] = blocked[y * nx + x] ? 0 : INF;
      pass(ny);
      for (y = 0; y < ny; y++) out[y * nx + x] = d[y];
    }
    for (y = 0; y < ny; y++) {
      for (x = 0; x < nx; x++) f[x] = out[y * nx + x];
      pass(nx);
      for (x = 0; x < nx; x++) out[y * nx + x] = d[x];
    }
    void n;
  }

  var CACHE = { key: null, F: null };
  function buildField(soups, plateZ, o, rB, tanT, tanA, lo, hi, zTipMax) {
    var dz = o.dzMm, m = dz * tanA;
    /* the box: the part, the margin and the thickest base more */
    var rBase = rB + tanT * Math.max(0, zTipMax - plateZ) + o.flareTan * o.flareMm, pad = o.marginMm + rBase * o.leanAllow + o.xyMm;
    var nLev = Math.max(2, Math.ceil((zTipMax - plateZ) / dz) + 1);
    var c = m / Math.SQRT2;                                                   /* a diagonal step of the grid is a level's lean */
    var wx = hi[0] - lo[0] + 2 * pad, wy = hi[1] - lo[1] + 2 * pad;
    if ((wx / c) * (wy / c) * nLev > o.cellsMax) {
      /* coarser: levels and cells together (the lean keeps its ratio) */
      var f = Math.cbrt((wx / c) * (wy / c) * nLev / o.cellsMax);
      dz *= f; m = dz * tanA; c = m / Math.SQRT2; nLev = Math.max(2, Math.ceil((zTipMax - plateZ) / dz) + 1);
    }
    var G = { c: c, x0: lo[0] - pad, y0: lo[1] - pad, nx: Math.ceil(wx / c) + 1, ny: Math.ceil(wy / c) + 1 }, nx = G.nx, ny = G.ny, N = nx * ny;
    var S = buildSpans(soups, G);
    function zOf(k) { return plateZ + k * dz; }
    function flare(z) { var h = z - plateZ; return h < o.flareMm ? o.flareTan * (o.flareMm - Math.max(0, h)) : 0; }
    function rAt(zv, z) { return Math.max(o.minRMm, rB + tanT * (zv - z)) + flare(z); }

    /* every level's distance to the part, mm */
    var dist = new Array(nLev), blk = new Uint8Array(N), tmp = { f: new Float64Array(Math.max(nx, ny)), v: new Int32Array(Math.max(nx, ny)), z: new Float64Array(Math.max(nx, ny) + 1), d: new Float64Array(Math.max(nx, ny)) };
    var d2 = new Float64Array(N), FAR = 1e3, k, i;
    for (k = 0; k < nLev; k++) {
      var zc = zOf(k), any = slabBlocked(S, N, zc - dz * 0.5, zc + dz * 0.5 + o.zGapMm, blk), D = new Float32Array(N);
      if (!any) D.fill(FAR);
      else { edt(blk, nx, ny, d2, tmp); for (i = 0; i < N; i++) D[i] = Math.sqrt(d2[i]) * c; }
      dist[k] = D;
    }
    /* THE LANDINGS (o.rest: the tree may rest on the part): a cell is a landing on the first level that clears a top face of the part under it -
       a branch may end there, standing on the part, as it may on the plate */
    var land = null;
    if (o.rest) {
      land = new Array(nLev);
      for (i = 0; i < N; i++) {
        for (var q = S.start[i] + 1; q < S.start[i + 1]; q += 2) {
          var zf = S.zs[q];
          if (zf - plateZ < 0.05) continue;
          var kl = Math.ceil((zf + dz * 0.5 - plateZ) / dz - 1e-9);
          if (kl < 1 || kl >= nLev) continue;
          (land[kl] || (land[kl] = new Uint8Array(N)))[i] = 1;
        }
      }
    }
    /* THE REACH FIELD: free[k][cell] = how many thickness laws (thinnest first) have a way down from here */
    var nCls = Math.max(1, Math.ceil((zTipMax - plateZ) / o.binMm) + 1), free = new Array(nLev);
    for (k = 0; k < nLev; k++) free[k] = new Uint8Array(N);
    var cur = new Uint8Array(N), prev = new Uint8Array(N), dil = new Uint8Array(N);
    for (var ci = 0; ci < nCls; ci++) {
      var zvC = plateZ + ci * o.binMm, alive = true;
      for (k = 0; k < nLev && alive; k++) {
        var need = rAt(zvC, zOf(k)) * o.leanAllow + o.xyMm, Dk = dist[k], Fk = free[k], Lk = land ? land[k] : null, cnt = 0, x, y, idx;
        if (k > 0) {
          /* the cells next to a free cell of the level below (3 x 3, separably) */
          for (y = 0; y < ny; y++) { var r0 = y * nx; for (x = 0; x < nx; x++) { idx = r0 + x; dil[idx] = prev[idx] | (x > 0 ? prev[idx - 1] : 0) | (x < nx - 1 ? prev[idx + 1] : 0); } }
          for (y = 0; y < ny; y++) { r0 = y * nx; for (x = 0; x < nx; x++) { idx = r0 + x; cur[idx] = dil[idx] | (y > 0 ? dil[idx - nx] : 0) | (y < ny - 1 ? dil[idx + nx] : 0); } }
        }
        for (y = 1; y < ny - 1; y++) {
          r0 = y * nx;
          for (x = 1; x < nx - 1; x++) {
            idx = r0 + x;
            var ok = Dk[idx] >= need && (k === 0 || cur[idx] || (Lk && Lk[idx])) && (ci === 0 || Fk[idx] === ci);   /* nested: only where the thinner law is free */
            if (ok) { Fk[idx] = ci + 1; cnt++; }
            cur[idx] = ok ? 1 : 0;
          }
        }
        for (x = 0; x < nx; x++) { cur[x] = 0; cur[(ny - 1) * nx + x] = 0; }
        for (y = 0; y < ny; y++) { cur[y * nx] = 0; cur[y * nx + nx - 1] = 0; }
        var sw = prev; prev = cur; cur = sw;
        if (!cnt && !land) alive = false;
      }
      prev.fill(0);
    }
    return { dz: dz, m: m, c: c, G: G, S: S, nLev: nLev, nCls: nCls, free: free, land: land };
  }

  function plan(input) {
    var o = Object.assign({}, DEF, input.opts || {}), K = Object.assign({}, KNOBS, input.knobs || {});
    var soups = (input.soups || []).filter(function (s) { return s && s.length >= 9; }), plateZ = +input.plateZ || 0, tipsIn = input.tips || [];
    /* input.candidates + input.pick: every spot that may stand a tip is asked first whether it has a way down (the same start a tip of it would
       take); pick(ids with none) answers with the tips to grow - the caller thins its spots knowing which cannot stand */
    var cands = input.candidates || null, spots = cands || tipsIn, candUnreachable = [];
    if (!spots.length) return { ok: true, reason: 'no tips', branches: [], trunks: [], rests: [], tips: [], unreachable: [], candUnreachable: [], stats: {} };
    var rB = K.branchDiameterMm / 2, tanT = Math.tan(K.branchDiameterAngleDeg * Math.PI / 180), tanA = Math.tan(Math.min(60, K.branchAngleDeg) * Math.PI / 180);
    /* THE FIELD (the grid, every level's distance to the part, the reach field) is the part's, not the tips': built from the part's own box and
       height, so every plan of one piece - an area at a time, or a second build with other tips - reads the same one (kept, one piece deep) */
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], zTipMax = -Infinity, sig = '';
    soups.forEach(function (s) {
      var sum = 0, step = Math.max(3, Math.floor(s.length / 3000) * 3);
      for (var i = 0; i < s.length; i += 3) for (var d = 0; d < 3; d++) { if (s[i + d] < lo[d]) lo[d] = s[i + d]; if (s[i + d] > hi[d]) hi[d] = s[i + d]; }
      for (var q = 0; q < s.length; q += step) sum += s[q] * 1.000001 + s[q + 1] * 0.731 + s[q + 2] * 1.37;
      sig += s.length + ':' + sum.toFixed(4) + ';';
    });
    var outside = false;
    spots.forEach(function (t) { for (var d = 0; d < 2; d++) { if (t.p[d] < lo[d]) { lo[d] = t.p[d]; outside = true; } if (t.p[d] > hi[d]) { hi[d] = t.p[d]; outside = true; } } if (t.p[2] > zTipMax) zTipMax = t.p[2]; });
    /* ...as high as the highest spot, rounded up to a bin of thickness laws (the part over it is nobody's to hold): a tall part with low
       overhangs is not read to its top */
    zTipMax = plateZ + Math.ceil((zTipMax - plateZ) / o.binMm + 1e-9) * o.binMm;
    var key = outside ? null : sig + '|' + plateZ + '|' + zTipMax.toFixed(3) + '|' + JSON.stringify(K) + '|' + JSON.stringify(o), F = key && CACHE.key === key ? CACHE.F : null;
    if (!F) {
      F = buildField(soups, plateZ, o, rB, tanT, tanA, lo, hi, zTipMax);
      if (key) { CACHE.key = key; CACHE.F = F; }
    }
    var dz = F.dz, m = F.m, c = F.c, G = F.G, nx = G.nx, ny = G.ny, N = nx * ny, S = F.S, nLev = F.nLev, nCls = F.nCls, free = F.free, land = F.land, k;
    function zOf(k2) { return plateZ + k2 * dz; }
    function flare(z) { var h = z - plateZ; return h < o.flareMm ? o.flareTan * (o.flareMm - Math.max(0, h)) : 0; }
    function rAt(zv, z) { return Math.max(o.minRMm, rB + tanT * (zv - z)) + flare(z); }
    function clsOf(zv) { return Math.max(0, Math.min(nCls - 1, Math.ceil((zv - plateZ) / o.binMm - 1e-9))); }
    function cellOf(x, y) { var i = Math.floor((x - G.x0) / c), j = Math.floor((y - G.y0) / c); return (i < 0 || j < 0 || i >= nx || j >= ny) ? -1 : j * nx + i; }
    function freeAt(k, x, y, cls) { var idx = cellOf(x, y); return idx >= 0 && free[k][idx] > cls; }
    /* the free cell of (k, cls) nearest (tx, ty) among those within `lim` of (fx, fy); null when there is none */
    function nearestFree(k, cls, tx, ty, fx, fy, lim) {
      var R = Math.ceil(lim / c) + 1, ci0 = Math.floor((fx - G.x0) / c), cj0 = Math.floor((fy - G.y0) / c), best = null, bd = Infinity, Fk = free[k];
      for (var j = Math.max(0, cj0 - R); j <= Math.min(ny - 1, cj0 + R); j++) for (var i = Math.max(0, ci0 - R); i <= Math.min(nx - 1, ci0 + R); i++) {
        if (Fk[j * nx + i] <= cls) continue;
        var px = G.x0 + (i + 0.5) * c, py = G.y0 + (j + 0.5) * c;
        if (Math.hypot(px - fx, py - fy) > lim) continue;
        var d = (px - tx) * (px - tx) + (py - ty) * (py - ty);
        if (d < bd - 1e-12) { bd = d; best = [px, py]; }
      }
      return best;
    }
    function lineClear(a, b) {
      var L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), n = Math.max(1, Math.ceil(L / (c * 0.7)));
      for (var q = 0; q <= n; q++) {
        var t = q / n, z = a[2] + (b[2] - a[2]) * t;
        if (a[2] - z < 0.45) continue;                                        /* the spot itself is on the part */
        if (insideAt(S, G, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z)) return false;
      }
      return true;
    }

    /* THE TIPS: each stands where there is room under its spot */
    var nodes = [], startsAt = {}, unreachable = [], tipOut = [];
    var kStop = Math.ceil(o.rootFloorMm / dz);
    function startOf(p, twig) {
      var rStart = twig ? o.twigRMm : rB, found = null;                      /* a tip's column is the branch diameter all its length: the law widens it from where it is a branch */
      var tipDrop = twig ? o.twigDropMm : o.tipDropMm, kHi = Math.min(nLev - 1, Math.floor((p[2] - tipDrop - plateZ) / dz + 1e-9)), kLo = Math.max(0, Math.floor((p[2] - o.stubMaxMm - plateZ) / dz));
      if (kHi < 0) kHi = 0;
      var k2, zk, drop, zv, cls, q;
      for (k2 = kHi; k2 >= kLo && !found; k2--) {
        zk = zOf(k2); drop = p[2] - zk; zv = zk + (rStart - rB) / tanT; cls = clsOf(zv);
        if (drop < 0.2) continue;
        q = freeAt(k2, p[0], p[1], cls) ? [p[0], p[1]] : nearestFree(k2, cls, p[0], p[1], p[0], p[1], drop * tanA);
        if (q && lineClear(p, [q[0], q[1], zk])) found = { k: k2, x: q[0], y: q[1], zv: zv, cls: cls };
      }
      /* resting on the part: a spot a short way over a face of the part (a pocket's ceiling over its floor) has no room for a tip's whole drop -
         its tip is as long as the room is */
      if (!found && land) for (k2 = kHi + 1; k2 < nLev && !found; k2++) {
        zk = zOf(k2); drop = p[2] - zk;
        if (drop < o.restMinMm) break;
        zv = zk + (rStart - rB) / tanT; cls = clsOf(zv);
        q = freeAt(k2, p[0], p[1], cls) ? [p[0], p[1]] : nearestFree(k2, cls, p[0], p[1], p[0], p[1], drop * tanA);
        if (q && lineClear(p, [q[0], q[1], zk])) found = { k: k2, x: q[0], y: q[1], zv: zv, cls: cls };
      }
      return found;
    }
    if (cands) {
      cands.forEach(function (cd) { if (!startOf(cd.p, !!cd.twig)) candUnreachable.push(cd.id); });
      if (typeof input.pick === 'function') tipsIn = input.pick(candUnreachable.slice()) || [];
    }
    tipsIn.forEach(function (t, ti) {
      var p = t.p, twig = !!t.twig, rTop = twig ? o.twigTopMm : rB, found = startOf(p, twig);
      tipOut.push({ id: t.id, p: p.slice(), twig: twig, start: found ? [found.x, found.y, zOf(found.k)] : null });
      if (!found) { unreachable.push(t.id); return; }
      var nd = { id: nodes.length, x: found.x, y: found.y, zv: found.zv, cls: found.cls, w: twig ? 0.25 : 1, vx: 0, vy: 0, tips: [t.id], into: -1, done: false, dead: false, partner: -1, mate: -1,
                 pts: [[p[0], p[1], p[2]], [found.x, found.y, zOf(found.k)]], r: [rTop, rAt(found.zv, zOf(found.k))], k0: found.k, zTop: p[2] };
      nodes.push(nd);
      (startsAt[found.k] = startsAt[found.k] || []).push(nd);
    });

    /* THE DESCENT */
    var live = [], merges = 0, stuck = 0, rested = {};
    for (k = nLev - 1; k >= 0; k--) {
      (startsAt[k] || []).forEach(function (nd) { live.push(nd); });
      if (!live.length) continue;
      var zk = zOf(k), a, b, i2, j2;
      /* 1. branches that have met are one */
      var again = true;
      while (again && k > 0) {
        again = false;
        for (i2 = 0; i2 < live.length && !again; i2++) for (j2 = i2 + 1; j2 < live.length && !again; j2++) {
          a = live[i2]; b = live[j2];
          var dd = Math.hypot(a.x - b.x, a.y - b.y), ra = rAt(a.zv, zk), rb = rAt(b.zv, zk);
          if (dd > Math.max(o.meet * m, 0.35 * Math.min(ra, rb))) continue;   /* ...or one is deep in the other */
          var zv = Math.max(a.zv, b.zv), cls = clsOf(zv), wt = a.w + b.w, mx = (a.x * a.w + b.x * b.w) / wt, my = (a.y * a.w + b.y * b.w) / wt;
          if (!freeAt(k, mx, my, cls)) {
            var big = a.zv >= b.zv ? a : b;
            if (freeAt(k, big.x, big.y, cls)) { mx = big.x; my = big.y; } else continue;
          }
          var nd = { id: nodes.length, x: mx, y: my, zv: zv, cls: cls, w: wt, vx: (a.vx * a.w + b.vx * b.w) / wt, vy: (a.vy * a.w + b.vy * b.w) / wt, tips: a.tips.concat(b.tips), into: -1, done: false, dead: false, partner: -1, mate: -1,
                     pts: [[mx, my, zk]], r: [rAt(zv, zk)], k0: k, zTop: Math.max(a.zTop, b.zTop) };
          nodes.push(nd);
          [a, b].forEach(function (ch) { ch.into = nd.id; ch.done = true; ch.pts.push([mx, my, zk]); ch.r.push(rAt(ch.zv, zk)); });
          live.splice(j2, 1); live.splice(i2, 1); live.push(nd);
          merges++; again = true;
        }
      }
      if (k === 0) break;
      /* 2. where each wants to go: toward the nearest branch it can still meet */
      var left = k - kStop;
      var zn = zOf(k - 1);
      /* THE PAIRS. Branches go for one another two by two - the nearest two first, each branch in one pair - so a field of tips halves at every
         meeting instead of every tip chasing the one before it. A pair holds while both stand and can still meet; one left over follows the
         nearest branch it can reach. */
      var byId = {}, touching = zk - plateZ > o.flareMm + dz;
      live.forEach(function (nd) { byId[nd.id] = nd; });
      function limOf(p, q) {
        var lim = left > 0 ? o.reach * m * left * (1 + Math.min(p.w, q.w) / Math.max(p.w, q.w)) : 0;
        if (touching) lim = Math.max(lim, 0.9 * (rAt(p.zv, zk) + rAt(q.zv, zk)));           /* two that already touch finish joining, over the flare */
        return lim;
      }
      live.forEach(function (nd) { var mt = nd.mate >= 0 ? byId[nd.mate] : null; if (!mt || mt.mate !== nd.id || Math.hypot(mt.x - nd.x, mt.y - nd.y) > limOf(nd, mt)) nd.mate = -1; });
      var single = live.filter(function (nd) { return nd.mate < 0; }), cand = [];
      for (i2 = 0; i2 < single.length; i2++) for (j2 = i2 + 1; j2 < single.length; j2++) {
        var dq = Math.hypot(single[i2].x - single[j2].x, single[i2].y - single[j2].y);
        if (dq <= limOf(single[i2], single[j2])) cand.push([dq, single[i2], single[j2]]);
      }
      cand.sort(function (p, q) { return (p[0] - q[0]) || (p[1].id - q[1].id) || (p[2].id - q[2].id); });
      cand.forEach(function (cq) { if (cq[1].mate < 0 && cq[2].mate < 0) { cq[1].mate = cq[2].id; cq[2].mate = cq[1].id; } });
      live.slice().sort(function (p, q) { return (q.w - p.w) || (p.id - q.id); }).forEach(function (nd) {
        var best = nd.mate >= 0 ? byId[nd.mate] : null, bd = Infinity, gcx = nd.x * nd.w, gcy = nd.y * nd.w, gsum = nd.w;
        live.forEach(function (ot) {
          if (ot === nd) return;
          var d = Math.hypot(ot.x - nd.x, ot.y - nd.y);
          if (d > limOf(nd, ot)) return;
          gcx += ot.x * ot.w; gcy += ot.y * ot.w; gsum += ot.w;
          if (nd.mate >= 0) return;
          var cost = ot.id === nd.partner ? d * 0.8 : d;                      /* one left over keeps the branch it follows unless another is clearly nearer */
          if (cost < bd) { bd = cost; best = ot; }
        });
        nd.partner = best ? best.id : -1;
        var wx2 = 0, wy2 = 0, near = false;
        if (best) {
          /* the heavier of two has stepped already (below): the lighter goes for where it now is, not where it was */
          var bx = best.stepped === k ? best.nx : best.x, by = best.stepped === k ? best.ny : best.y;
          var d = Math.hypot(bx - nd.x, by - nd.y), step = best.stepped === k ? Math.min(m, d) : Math.min(m, d * best.w / (nd.w + best.w));
          if (d > 1e-9) { wx2 = (bx - nd.x) / d * step; wy2 = (by - nd.y) / d * step; }
          near = d <= o.approach * m;                                         /* the last of the way: straight at it, nothing else weighed */
          /* ...and, with it, toward the middle of all it can still meet: a canopy draws in to one trunk while its height allows, not to a
             trunk for every knot of neighbours */
          if (!near && o.gather > 0 && gsum > 0) {
            var gx = gcx / gsum - nd.x, gy = gcy / gsum - nd.y, gd = Math.hypot(gx, gy);
            if (gd > 1e-9) { var gs = Math.min(m, gd) * o.gather; wx2 = wx2 * (1 - o.gather) + gx / gd * gs; wy2 = wy2 * (1 - o.gather) + gy / gd * gs; }
          }
        }
        /* the step down: the heading turned toward it, held to the lean, kept where there is a way on */
        var keep = near ? 0 : o.inertia, vx = nd.vx + (wx2 - nd.vx) * (1 - keep), vy = nd.vy + (wy2 - nd.vy) * (1 - keep), sp = Math.hypot(vx, vy);
        if (!best) { vx *= 0.5; vy *= 0.5; }
        if (sp > m) { vx *= m / sp; vy *= m / sp; }
        var tx = nd.x + vx, ty = nd.y + vy;
        if (!freeAt(k - 1, tx, ty, nd.cls)) {
          var q = nearestFree(k - 1, nd.cls, tx, ty, nd.x, nd.y, m * 1.05) || nearestFree(k - 1, nd.cls, tx, ty, nd.x, nd.y, c * 2.2);
          if (!q) {
            var li = land && land[k] ? cellOf(nd.x, nd.y) : -1;
            if (li >= 0 && land[k][li]) {                                    /* it stands on the part: its end runs down to the face */
              var zf = -Infinity;
              for (var sq = S.start[li] + 1; sq < S.start[li + 1]; sq += 2) if (S.zs[sq] <= zk - dz * 0.5 + 1e-6 && S.zs[sq] > zf) zf = S.zs[sq];
              nd.rest = true; nd.done = true; nd.gone = true; rested[nd.id] = zf > -Infinity ? zf : zk;
              if (zf > -Infinity && zf < zk - 1e-6) { nd.pts.push([nd.x, nd.y, zf]); nd.r.push(rAt(nd.zv, zk)); }
              return;
            }
            nd.dead = true; nd.done = true; stuck++; return;
          }
          vx = q[0] - nd.x; vy = q[1] - nd.y; tx = q[0]; ty = q[1];
        }
        nd.vx = vx; nd.vy = vy; nd.nx = tx; nd.ny = ty; nd.stepped = k;
      });
      live = live.filter(function (nd) { return !nd.dead && !nd.gone; });
      live.forEach(function (nd) { nd.x = nd.nx; nd.y = nd.ny; nd.pts.push([nd.x, nd.y, zn]); nd.r.push(rAt(nd.zv, zn)); });
    }
    /* what stands: the branches that reach the plate, and all that run into them */
    var landed = {}, trunks = [], rests = [];
    live.forEach(function (nd) { nd.done = true; landed[nd.id] = true; });
    var okNode = {};
    function lands(nd) {
      if (okNode[nd.id] != null) return okNode[nd.id];
      var r = nd.dead ? false : nd.into < 0 ? (!!landed[nd.id] || rested[nd.id] != null) : lands(nodes[nd.into]);
      okNode[nd.id] = r; return r;
    }
    var branches = [], idOf = {};
    nodes.forEach(function (nd) {
      if (!lands(nd)) { if (nd.pts[0][2] === nd.zTop && nd.tips.length === 1) unreachable.push(nd.tips[0]); return; }
      idOf[nd.id] = branches.length;
      branches.push({ id: branches.length, node: nd.id, pts: nd.pts, r: nd.r, into: nd.into, rest: rested[nd.id] != null, tips: nd.tips.slice(), tip: nd.pts[0][2] === nd.zTop && nd.tips.length === 1 ? nd.tips[0] : null });
    });
    branches.forEach(function (br) { br.into = br.into < 0 ? -1 : idOf[br.into]; delete br.node; });
    branches.forEach(function (br) {
      if (br.into >= 0) return;
      var e = br.pts[br.pts.length - 1];
      (br.rest ? rests : trunks).push({ branch: br.id, c: [e[0], e[1]], z: e[2], r: br.r[br.r.length - 1], tips: br.tips.slice() });
    });
    /* a dead branch's tips (it lost its way: the reach field says this cannot be, but a coarse grid may) are unreachable, never built */
    var un = {}; unreachable.forEach(function (id) { un[id] = true; });
    nodes.forEach(function (nd) { if (nd.dead) nd.tips.forEach(function (id) { if (!un[id]) { un[id] = true; unreachable.push(id); } }); });
    branches.forEach(function (br) { br.tips = br.tips.filter(function (id) { return !un[id]; }); });
    trunks.concat(rests).forEach(function (tr) { tr.tips = tr.tips.filter(function (id) { return !un[id]; }); });
    return { ok: true, reason: trunks.length + ' trunk(s), ' + (rests.length ? rests.length + ' standing on the part, ' : '') + branches.length + ' branch(es), ' + (tipsIn.length - unreachable.length) + ' tip(s)',
             branches: branches, trunks: trunks, rests: rests, tips: tipOut, unreachable: unreachable, candUnreachable: candUnreachable, plateZ: plateZ,
             stats: { levels: nLev, dzMm: dz, cellMm: c, nx: nx, ny: ny, classes: nCls, merges: merges, stuck: stuck, rests: rests.length } };
  }

  /* the branches as tapered capsules, each thinned to the points that matter (a straight run is its two ends) */
  function prims(res, tolMm) {
    var tol = tolMm == null ? 0.03 : tolMm;
    return res.branches.map(function (br) {
      var P = br.pts, R = br.r, keep = [0], a = 0;
      function far(i0, i1) {
        var A = P[i0], B = P[i1], worst = 0, at = -1, ex = B[0] - A[0], ey = B[1] - A[1], ez = B[2] - A[2], ee = ex * ex + ey * ey + ez * ez;
        for (var q = i0 + 1; q < i1; q++) {
          var t = ee > 1e-18 ? ((P[q][0] - A[0]) * ex + (P[q][1] - A[1]) * ey + (P[q][2] - A[2]) * ez) / ee : 0;
          var d = Math.hypot(P[q][0] - A[0] - ex * t, P[q][1] - A[1] - ey * t, P[q][2] - A[2] - ez * t) + Math.abs(R[q] - (R[i0] + (R[i1] - R[i0]) * t));
          if (d > worst) { worst = d; at = q; }
        }
        return worst > tol ? at : -1;
      }
      (function rdp(i0, i1) { var q = far(i0, i1); if (q < 0) return; rdp(i0, q); keep.push(q); rdp(q, i1); })(0, P.length - 1);
      keep.push(P.length - 1); void a;
      keep = keep.filter(function (v, i) { return i === 0 || v !== keep[i - 1]; });
      var out = { pts: keep.map(function (i) { return P[i].slice(); }), r: keep.map(function (i) { return R[i]; }), branch: br.id };
      /* a tip ends flat at its spot: a capsule's round end would stand a radius over it */
      if (br.tip != null) out.clip = { p: [P[0][0], P[0][1], P[0][2] - 0.02], n: [0, 0, 1] };
      return out;
    });
  }

  return { plan: plan, prims: prims, KNOBS: Object.assign({}, KNOBS), DEFAULTS: Object.assign({}, DEF) };
});
