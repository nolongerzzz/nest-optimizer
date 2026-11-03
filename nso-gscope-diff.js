/*
 * NSO COMPARE DIFF
 * ----------------
 * What two overlaid pieces of G-code differ by, as numbers the slicer can act on - not pixels. G-scope's Compare puts what is isolated on
 * plate 1 (A, "ours") and on plate 2 (B, "the reference") on plate 3, lined up; this reads the two move lists - already in one frame - and
 * says, layer by layer and line type by line type, where the material is only A's, only B's, or both's; where each line type starts and
 * stops in Z; and whether the support runs up to the first layer of its interface or transition plate and stays inside that plate's outline.
 *
 *   NSOCompareDiff.compute(movesA, movesB, opts) -> report
 *   NSOCompareDiff.text(report)                  -> the report as a short readable text
 *   NSOCompareDiff.CLASSES                       -> ['part', 'support', 'interface', 'transition']
 *
 * A move is { x0, y0, x1, y1, z, width, height, length, feature } (nso-gcode-lines.js). Each is painted onto a grid (opts.cellMm, 0.1) as the
 * stadium it prints - the segment thickened by half its width. A layer's two masks are compared cell for cell; areas are mm^2.
 *
 * CLASSES. 'part' is every line type that is not a support's; 'support' is the tree ("Support"); 'interface' and 'transition' are the plate
 * it carries ("Support interface", "Support transition"). Travel is not read.
 *
 * LAYERS are paired by the height they occupy (z - height .. z): A's layer and the B layer that overlaps it by at least half the thinner
 * one are one row (best overlap first, each used once) - Bambu's layers near a plate are 0.28, 0.55 ..., not on the 0.2 grid; a layer with no
 * partner is a row of its own.
 *
 * THE PLATE'S FIRST LAYER. The lowest layer of an interface or transition (the plate's footprint P, union of the two) with none of either
 * under it. For it, per side:
 *   supportBelowMm2   tree material on the layer under it within `nearMm` (1.0) of P - the tree that runs up to the plate;
 *   gap               true when there is none: the tree stops short of the plate (a layer or more of air between);
 *   overshootMm2      tree material on the layer under it, within `reachMm` (3.0) of P and more than `edgeMm` (0.15) outside it:
 *                     tips and branches that stand out past the plate's outline;
 *   overshootMaxMm    the furthest of them from P.
 *
 * Pure: no DOM, no THREE. Node and browser.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSOCompareDiff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CLASSES = ['part', 'support', 'interface', 'transition'];
  var SUPPORT_CLASSES = ['support', 'interface', 'transition'];

  function classOf(feature) {
    var f = String(feature || '');
    if (!f || /^travel/i.test(f) || /^(wipe|prime|custom|skirt|brim)/i.test(f) && !/^support/i.test(f)) return null;
    if (/^support interface/i.test(f)) return 'interface';
    if (/^support transition/i.test(f)) return 'transition';
    if (/^support/i.test(f)) return 'support';
    return 'part';
  }

  /** The grid over both pieces' moves. */
  function gridOf(lists, cell, pad) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    lists.forEach(function (ms) {
      ms.forEach(function (m) {
        if (!classOf(m.feature)) return;
        var w = (m.width || 0.45) / 2;
        x0 = Math.min(x0, m.x0 - w, m.x1 - w); x1 = Math.max(x1, m.x0 + w, m.x1 + w);
        y0 = Math.min(y0, m.y0 - w, m.y1 - w); y1 = Math.max(y1, m.y0 + w, m.y1 + w);
      });
    });
    if (!isFinite(x0)) return null;
    var ox = x0 - pad, oy = y0 - pad;
    return { ox: ox, oy: oy, cell: cell, nx: Math.ceil((x1 + pad - ox) / cell) + 1, ny: Math.ceil((y1 + pad - oy) / cell) + 1 };
  }

  /** One move painted as the stadium it prints. */
  function paint(mask, g, m) {
    var hw = (m.width || 0.45) / 2, c = g.cell;
    var ax = m.x0, ay = m.y0, bx = m.x1, by = m.y1, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    var i0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw - g.ox) / c)), i1 = Math.min(g.nx - 1, Math.ceil((Math.max(ax, bx) + hw - g.ox) / c));
    var j0 = Math.max(0, Math.floor((Math.min(ay, by) - hw - g.oy) / c)), j1 = Math.min(g.ny - 1, Math.ceil((Math.max(ay, by) + hw - g.oy) / c));
    var r2 = hw * hw;
    for (var j = j0; j <= j1; j++) {
      var py = g.oy + (j + 0.5) * c;
      for (var i = i0; i <= i1; i++) {
        var px = g.ox + (i + 0.5) * c;
        var t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        var qx = px - (ax + t * dx), qy = py - (ay + t * dy);
        if (qx * qx + qy * qy <= r2) mask[j * g.nx + i] = 1;
      }
    }
  }

  function count(mask) { var n = 0; for (var i = 0; i < mask.length; i++) n += mask[i]; return n; }

  /** Squared distance (in cells) to the nearest set cell of `mask`, exact (Felzenszwalb - Huttenlocher). Large where nothing is set. */
  function edt2Full(mask, nx, ny) {
    var INF = 1e12, f = new Float64Array(Math.max(nx, ny)), d = new Float64Array(Math.max(nx, ny)), v = new Int32Array(Math.max(nx, ny)), z = new Float64Array(Math.max(nx, ny) + 1);
    var out = new Float64Array(nx * ny);
    function pass(n) {
      var k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
      for (var q = 1; q < n; q++) {
        var s;
        for (;;) {
          s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
          if (s <= z[k] && k > 0) k--; else break;
        }
        if (s <= z[k]) { v[k] = q; z[k] = -INF; z[k + 1] = INF; } else { k++; v[k] = q; z[k] = s; z[k + 1] = INF; }
      }
      k = 0;
      for (var p = 0; p < n; p++) { while (z[k + 1] < p) k++; d[p] = (p - v[k]) * (p - v[k]) + f[v[k]]; }
    }
    var i, j;
    for (i = 0; i < nx; i++) {
      for (j = 0; j < ny; j++) f[j] = mask[j * nx + i] ? 0 : INF;
      pass(ny);
      for (j = 0; j < ny; j++) out[j * nx + i] = d[j];
    }
    for (j = 0; j < ny; j++) {
      for (i = 0; i < nx; i++) f[i] = out[j * nx + i];
      pass(nx);
      for (i = 0; i < nx; i++) out[j * nx + i] = d[i];
    }
    return out;
  }

  /** The same, but only where it is wanted: the distance is run over the box of the mask grown by `padCells`, and is 1e12 (far) outside it. Every caller reads
      the distance against a limit no larger than the pad, so nothing it reads changes - and a layer's mask is a few pieces on a plate, not the whole plate. */
  var POOL = [];
  function edt2(mask, nx, ny, padCells, slot) {
    if (padCells == null) return edt2Full(mask, nx, ny);
    var i0 = nx, i1 = -1, j0 = ny, j1 = -1;
    for (var j = 0; j < ny; j++) {
      var row = j * nx;
      for (var i = 0; i < nx; i++) if (mask[row + i]) { if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; }
    }
    var out = POOL[slot || 0];                                                  // one buffer per call site, refilled: the result is read at once, before the site asks again
    if (!out || out.length !== nx * ny) out = POOL[slot || 0] = new Float64Array(nx * ny);
    out.fill(1e12);
    if (i1 < 0) return out;
    i0 = Math.max(0, i0 - padCells); j0 = Math.max(0, j0 - padCells); i1 = Math.min(nx - 1, i1 + padCells); j1 = Math.min(ny - 1, j1 + padCells);
    var cw = i1 - i0 + 1, ch = j1 - j0 + 1, sub = new Uint8Array(cw * ch);
    for (var cj = 0; cj < ch; cj++) for (var ci = 0; ci < cw; ci++) sub[cj * cw + ci] = mask[(j0 + cj) * nx + i0 + ci];
    var d = edt2Full(sub, cw, ch);
    for (var cj2 = 0; cj2 < ch; cj2++) for (var ci2 = 0; ci2 < cw; ci2++) out[(j0 + cj2) * nx + i0 + ci2] = d[cj2 * cw + ci2];
    return out;
  }

  /** The moves of one side by layer key -> class -> list. */
  function byLayer(moves, keyOf) {
    var out = {};
    moves.forEach(function (m) {
      var c = classOf(m.feature);
      if (!c) return;
      var k = keyOf(m.z);
      var L = out[k] || (out[k] = { z: m.z, h: 0, cls: {} });
      if ((m.height || 0) > L.h) L.h = m.height;
      (L.cls[c] || (L.cls[c] = [])).push(m);
    });
    return out;
  }

  function stadiumArea(m) { var h = m.height || 0.2, w = m.width || 0.45; return h * (w - h) + Math.PI * h * h / 4; }
  function r2(x) { return Math.round(x * 100) / 100; }
  function r3(x) { return Math.round(x * 1000) / 1000; }

  function compute(movesA, movesB, opts) {
    opts = opts || {};
    var cell = opts.cellMm || 0.1, zTol = opts.zTolMm != null ? opts.zTolMm : 0.11;
    var nearMm = opts.nearMm || 1.0, reachMm = opts.reachMm || 3.0, edgeMm = opts.edgeMm || 0.15;
    var g = gridOf([movesA, movesB], cell, reachMm + 1);
    var empty = { meta: { cellMm: cell, zTolMm: zTol, moves: [movesA.length, movesB.length] }, layers: [], classes: {}, plate: { A: [], B: [] }, worst: [] };
    if (!g) return empty;
    var N = g.nx * g.ny, cell2 = cell * cell, BED_MM = 0.5;
    var hasTree = { A: movesA.some(function (m) { return classOf(m.feature) === 'support'; }), B: movesB.some(function (m) { return classOf(m.feature) === 'support'; }) };
    // two families of layers, paired on their own: the part's and the support's (Bambu prints its support layers at their own heights,
    // 6.58 / 6.86 / 7.14, between the part's 6.6 / 6.8 / 7.0)
    var FAM = 1e9, famOf = function (k) { return k >= FAM ? 1 : 0; }, zOf = function (k) { return k % FAM; };
    var keyed = function (moves) {
      var out = {};
      moves.forEach(function (m) {
        var c = classOf(m.feature);
        if (!c) return;
        var k = Math.round(m.z * 1000) + (c === 'part' ? 0 : FAM);
        var L = out[k] || (out[k] = { z: m.z, h: 0, cls: {} });
        if ((m.height || 0) > L.h) L.h = m.height;
        (L.cls[c] || (L.cls[c] = [])).push(m);
      });
      return out;
    };
    var LA = keyed(movesA), LB = keyed(movesB);
    // layer rows: A's layer and B's layer that cover the same height are one row; a layer with no partner is a row of its own.
    // Paired by overlap of the heights the layers occupy (z - h .. z), not by z alone: Bambu's layers near a plate are not on the 0.2 grid
    // (0.28, 0.55 ...), and a z tolerance leaves ours 0.40 and its 0.55 as two lone layers that look like all-different material.
    var zsA = Object.keys(LA).map(Number).sort(function (a, b) { return a - b; });
    var zsB = Object.keys(LB).map(Number).sort(function (a, b) { return a - b; });
    var rows = zsA.map(function (k) { return { a: k, b: null }; });
    var spanOf = function (L) { var h = L.h || 0.2; return [L.z - h, L.z, h]; };
    var cand = [];
    zsA.forEach(function (ka, i) {
      var sa = spanOf(LA[ka]);
      zsB.forEach(function (kb) {
        if (famOf(kb) !== famOf(ka)) return;
        var sb = spanOf(LB[kb]), ov = Math.min(sa[1], sb[1]) - Math.max(sa[0], sb[0]);
        if (ov >= 0.5 * Math.min(sa[2], sb[2]) - 1e-9 || Math.abs(zOf(ka) - zOf(kb)) <= zTol * 1000 * 0.5) cand.push({ i: i, kb: kb, ov: ov, dz: Math.abs(zOf(ka) - zOf(kb)) });
      });
    });
    cand.sort(function (p, q) { return (q.ov - p.ov) || (p.dz - q.dz); });
    var usedB = {};
    cand.forEach(function (c) {
      if (rows[c.i].b != null || usedB[c.kb]) return;
      rows[c.i].b = c.kb; usedB[c.kb] = true;
    });
    zsB.forEach(function (kb) { if (!usedB[kb]) rows.push({ a: null, b: kb }); });
    var rowZ = function (r) { return zOf(r.a != null ? r.a : r.b); };
    rows.sort(function (p, q) { return (rowZ(p) - rowZ(q)) || (famOf(p.a != null ? p.a : p.b) - famOf(q.a != null ? q.a : q.b)); });

    var sums = {};
    CLASSES.forEach(function (c) {
      sums[c] = { A: { firstZ: null, lastZ: null, layers: 0, moves: 0, lengthMm: 0, volumeMm3: 0, areaMm2: 0 },
                  B: { firstZ: null, lastZ: null, layers: 0, moves: 0, lengthMm: 0, volumeMm3: 0, areaMm2: 0 }, onlyAMm2: 0, onlyBMm2: 0, bothMm2: 0 };
    });
    var layers = [], plate = { A: [], B: [] }, prev = { A: null, B: null, zA: null, zB: null }, ADJACENT_MM = 0.5;   // a layer more than this under is not 'the layer under'

    // WHAT ELSE THE COMPARE READS (so a missing piece is named, not hunted for): per footprint the plate's stack (bottom, top, layers) on each side;
    // whole plate layers one side has alone; the hatch angle layer by layer; tiny isolated pieces; how far a piece reaches past the other side.
    var stk = { A: { top: new Float32Array(N), bot: new Float32Array(N).fill(1e9), n: new Uint16Array(N) }, B: { top: new Float32Array(N), bot: new Float32Array(N).fill(1e9), n: new Uint16Array(N) } };
    var loneRaw = { aLacks: [], bLacks: [] }, strayRaw = { A: [], B: [] }, angBad = [], angCmp = 0;
    function blobOf(cells, cls, z) {
      var G = { cls: cls, zFrom: z, zTo: z, layers: 1, areaMm2: cells.length * cell2, peakMm2: cells.length * cell2, sx: 0, sy: 0, n: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      cells.forEach(function (c) {
        var i = c % g.nx, j = (c - i) / g.nx, x = g.ox + (i + 0.5) * cell, y = g.oy + (j + 0.5) * cell;
        G.sx += x; G.sy += y; G.n++;
        if (x < G.x0) G.x0 = x; if (x > G.x1) G.x1 = x; if (y < G.y0) G.y0 = y; if (y > G.y1) G.y1 = y;
      });
      return G;
    }
    /** Pieces of the same class and side that sit over one another on layers up to 0.6 mm apart are one piece. */
    function stackBlobs(list) {
      var out = [];
      list.slice().sort(function (p, q) { return p.zFrom - q.zFrom; }).forEach(function (b) {
        var hit = null;
        for (var k = 0; k < out.length && !hit; k++) {
          var o = out[k];
          if (o.cls === b.cls && o.zTo >= b.zFrom - 0.6 - 1e-9 && b.x0 - 1 <= o.x1 && b.x1 + 1 >= o.x0 && b.y0 - 1 <= o.y1 && b.y1 + 1 >= o.y0) hit = o;
        }
        if (!hit) { out.push(b); return; }
        hit.layers += b.layers; hit.areaMm2 += b.areaMm2; if (b.peakMm2 > hit.peakMm2) hit.peakMm2 = b.peakMm2;
        hit.sx += b.sx; hit.sy += b.sy; hit.n += b.n; hit.zTo = Math.max(hit.zTo, b.zTo);
        hit.x0 = Math.min(hit.x0, b.x0); hit.y0 = Math.min(hit.y0, b.y0); hit.x1 = Math.max(hit.x1, b.x1); hit.y1 = Math.max(hit.y1, b.y1);
      });
      return out;
    }
    /** The direction the long lines of a layer run in, 0 - 180 degrees, and how much of their length agrees (loops spread, hatch does not). */
    function hatchAngle(list) {
      var bins = new Float64Array(60), tot = 0;
      list.forEach(function (m) {
        var L = m.length || Math.hypot(m.x1 - m.x0, m.y1 - m.y0);
        if (L < 1.0) return;
        var a = Math.atan2(m.y1 - m.y0, m.x1 - m.x0) * 180 / Math.PI; a = ((a % 180) + 180) % 180;
        bins[Math.min(59, Math.floor(a / 3))] += L; tot += L;
      });
      if (tot < 4) return null;
      var best = 0, bw = -1;
      for (var i = 0; i < 60; i++) { var w = bins[(i + 59) % 60] + bins[i] + bins[(i + 1) % 60]; if (w > bw) { bw = w; best = i; } }
      var num = 0, den = 0;
      for (var k = -1; k <= 1; k++) { var w2 = bins[(best + k + 60) % 60]; num += w2 * ((best + k) * 3 + 1.5); den += w2; }
      var deg = num / den; deg = ((deg % 180) + 180) % 180;
      return { deg: deg, share: bw / tot };
    }

    function masksOf(L) {
      var out = {};
      if (!L) return out;
      CLASSES.forEach(function (c) {
        if (!L.cls[c]) return;
        var m = new Uint8Array(N);
        L.cls[c].forEach(function (mv) { paint(m, g, mv); });
        out[c] = m;
      });
      return out;
    }
    function union(ma, mb) {
      if (!ma) return mb || null;
      if (!mb) return ma;
      var o = new Uint8Array(N);
      for (var i = 0; i < N; i++) o[i] = ma[i] | mb[i];
      return o;
    }
    function side(name, L, ms, z) {
      CLASSES.forEach(function (c) {
        var S = sums[c][name], list = L && L.cls[c];
        if (!list || !list.length) return;
        S.moves += list.length;
        list.forEach(function (m) { S.lengthMm += m.length || Math.hypot(m.x1 - m.x0, m.y1 - m.y0); S.volumeMm3 += (m.length || Math.hypot(m.x1 - m.x0, m.y1 - m.y0)) * stadiumArea(m); });
        var area = count(ms[c]) * cell2;
        if (area > 0.01) {
          S.layers++; S.areaMm2 += area;
          if (S.firstZ == null || z < S.firstZ) S.firstZ = z;
          if (S.lastZ == null || z > S.lastZ) S.lastZ = z;
        }
      });
    }
    /** Connected pieces of a mask, joined across gaps up to `joinMm` (a plate is lines with air between them). Returns [{cells:[idx...], box}] */
    function regionsOf(P, joinMm) {
      var d2 = edt2(P, g.nx, g.ny, Math.ceil(joinMm / cell) + 2, 0), j2 = Math.pow(joinMm / cell, 2), lab = new Int32Array(N), out = [], stack = [];
      for (var s0 = 0; s0 < N; s0++) {
        if (!P[s0] || lab[s0]) continue;
        var id = out.length + 1, cells = [], fill = [];
        lab[s0] = id; stack.push(s0);
        // flood over every cell within joinMm of the mask, so lines of one plate fall into one region
        while (stack.length) {
          var c = stack.pop(), ci = c % g.nx, cj = (c - ci) / g.nx;
          fill.push(c);
          if (P[c]) cells.push(c);
          for (var k = 0; k < 4; k++) {
            var ni = ci + (k === 0 ? 1 : k === 1 ? -1 : 0), nj = cj + (k === 2 ? 1 : k === 3 ? -1 : 0);
            if (ni < 0 || nj < 0 || ni >= g.nx || nj >= g.ny) continue;
            var n = nj * g.nx + ni;
            if (lab[n] || d2[n] > j2) continue;
            lab[n] = id; stack.push(n);
          }
        }
        out.push({ cells: cells, fill: fill });
      }
      return out;
    }
    /**
     * The first layer of every plate region on this layer: a region (lines of interface or transition, joined across 1 mm) with none of
     * either under it on this side's previous layer. For each, the tree under it and the tree standing out past it.
     */
    function firstPlateLayer(name, ms, z, prevMs) {
      var P = union(ms.interface, ms.transition);
      if (!P || count(P) * cell2 < 0.05) return;
      var Pprev = prevMs && union(prevMs.interface, prevMs.transition);
      var dPrev = Pprev && count(Pprev) * cell2 >= 0.05 ? edt2(Pprev, g.nx, g.ny, Math.ceil(1.5 / cell) + 2, 1) : null, cont2 = Math.pow(1.5 / cell, 2);
      var near2 = Math.pow(nearMm / cell, 2), reach2 = Math.pow(reachMm / cell, 2), edge2 = Math.pow(edgeMm / cell, 2);
      var S = prevMs && prevMs.support, first = new Uint8Array(N), nFirst = 0, nGap = 0, below = 0, plateCells = 0;
      regionsOf(P, 1.0).forEach(function (R) {
        if (R.cells.length * cell2 < 0.05) return;
        if (dPrev) {                                                              // already under it a layer down -> not its first layer
          var on = 0;
          for (var q = 0; q < R.cells.length; q++) if (dPrev[R.cells[q]] <= cont2) on++;
          if (on >= 0.3 * R.cells.length) return;
        }
        var Rm = new Uint8Array(N);
        R.cells.forEach(function (c) { Rm[c] = 1; first[c] = 1; });
        nFirst++; plateCells += R.cells.length;
        var dR = edt2(Rm, g.nx, g.ny, Math.ceil(nearMm / cell) + 2, 2), b = 0;
        if (S) for (var i = 0; i < N; i++) if (S[i] && dR[i] <= near2) b++;
        below += b;
        if (b === 0 && hasTree[name] && z > BED_MM) nGap++;                      // no tree in the selection, or a plate on the bed: nothing to run up to it
      });
      if (!nFirst) return;
      var d2 = edt2(first, g.nx, g.ny, Math.ceil(reachMm / cell) + 2, 3), over = 0, maxD2 = 0;
      if (S) for (var j = 0; j < N; j++) {
        if (!S[j]) continue;
        var d = d2[j];
        if (d > edge2 && d <= reach2) { over++; if (d > maxD2) maxD2 = d; }
      }
      plate[name].push({ z: r2(z), regions: nFirst, gapRegions: nGap, plateMm2: r2(plateCells * cell2), supportBelowMm2: r2(below * cell2), gap: nGap > 0, treeAbsent: !hasTree[name], onBed: z <= BED_MM,
                         overshootMm2: r2(over * cell2), overshootMaxMm: r2(Math.sqrt(maxD2) * cell) });
    }

    /**
     * WHERE one side has support-family material the other does not: per layer row and class, the cells only A's (or only B's), joined across 1 mm
     * into pieces of at least 1 mm2, and stacked layer on layer into regions (a piece that overlaps the one under it in the same class and side is
     * the same region). Coordinates are in A's own file frame (opts.offsetA is how far A was moved to stand here).
     */
    var offA = opts.offsetA || [0, 0], gapKeys = {}, gapAll = [], MIN_GAP_CELLS = Math.round(1.0 / cell2);
    function trackGaps(cls, side, mask, z, dOther) {
      var key = cls + side, st = gapKeys[key] || (gapKeys[key] = { map: null, z: null });
      var comps = mask ? regionsOf(mask, 1.0).filter(function (R) { return R.cells.length >= MIN_GAP_CELLS; }) : [];
      if (!comps.length) return;                                                   // a layer with none of it: the region may pick up again within 0.6 mm
      var next = new Int32Array(N);
      comps.forEach(function (R) {
        var id = 0;
        if (st.map && st.z != null && z - st.z <= 0.6 + 1e-9) {
          var votes = {}, best = 0;
          for (var q = 0; q < R.cells.length; q++) { var v = st.map[R.cells[q]]; if (v) { votes[v] = (votes[v] || 0) + 1; if (votes[v] > (votes[best] || 0)) best = v; } }
          id = best;
        }
        var G = id ? gapAll[id - 1] : null;
        if (!G) {
          G = { cls: cls, side: side === 'A' ? 'onlyA' : 'onlyB', zFrom: z, zTo: z, layers: 0, areaMm2: 0, peakMm2: 0, sx: 0, sy: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
          gapAll.push(G); id = gapAll.length;
        }
        var a = R.cells.length * cell2;
        if (dOther) {                                                              // how far into the other side's empty space it reaches (a rim is under ~0.4 mm; a horn is not)
          var md = -1;
          for (var q2 = 0; q2 < R.cells.length; q2++) { var dv = dOther[R.cells[q2]]; if (dv < 1e11 && dv > md) md = dv; }
          if (md >= 0) G.depth = Math.max(G.depth || 0, Math.sqrt(md) * cell);
        }
        G.layers++; G.areaMm2 += a; if (a > G.peakMm2) G.peakMm2 = a;
        if (z < G.zFrom) G.zFrom = z; if (z > G.zTo) G.zTo = z;
        R.cells.forEach(function (c) {
          var i = c % g.nx, j = (c - i) / g.nx, x = g.ox + (i + 0.5) * cell, y = g.oy + (j + 0.5) * cell;
          G.sx += x; G.sy += y; G.n = (G.n || 0) + 1;
          if (x < G.x0) G.x0 = x; if (x > G.x1) G.x1 = x; if (y < G.y0) G.y0 = y; if (y > G.y1) G.y1 = y;
        });
        R.fill.forEach(function (c) { next[c] = id; });
      });
      st.map = next; st.z = z;
    }

    var plateRows = [];
    rows.forEach(function (r) {
      var A = r.a != null ? LA[r.a] : null, B = r.b != null ? LB[r.b] : null;
      var z = A ? A.z : B.z;
      var mA = masksOf(A), mB = masksOf(B);
      plateRows.push({ A: A, B: B, zA: A ? A.z : null, zB: B ? B.z : null, mA: union(mA.interface, mA.transition), mB: union(mB.interface, mB.transition) });
      side('A', A, mA, A ? A.z : z); side('B', B, mB, B ? B.z : z);
      [['A', A], ['B', B]].forEach(function (t) {                                  // the plate's column: where it stands, from which Z to which, in how many layers (lines drawn 0.14 wider so the hatch's 0.04 gaps close)
        var L = t[1]; if (!L || !(L.cls.interface || L.cls.transition)) return;
        var m = new Uint8Array(N);
        ['interface', 'transition'].forEach(function (c) { (L.cls[c] || []).forEach(function (mv) { paint(m, g, { x0: mv.x0, y0: mv.y0, x1: mv.x1, y1: mv.y1, width: (mv.width || 0.45) + 0.14 }); }); });
        var S = stk[t[0]], top = L.z, bot = L.z - (L.h || 0.2);
        for (var i = 0; i < N; i++) if (m[i]) { S.n[i]++; if (top > S.top[i]) S.top[i] = top; if (bot < S.bot[i]) S.bot[i] = bot; }
      });
      (function () {                                                              // a whole plate layer one side has and the other has not, however small
        var pm = function (ms) { return union(ms.interface, ms.transition); }, ua = pm(mA), ub = pm(mB);
        var aa = ua ? count(ua) * cell2 : 0, bb = ub ? count(ub) * cell2 : 0;
        var one = bb >= 0.3 && aa < 0.05 ? ['aLacks', ub, B.z] : aa >= 0.3 && bb < 0.05 ? ['bLacks', ua, A.z] : null;
        if (!one) return;
        regionsOf(one[1], 1.0).forEach(function (R) {
          if (R.cells.length * cell2 < 0.3) return;
          loneRaw[one[0]].push(blobOf(R.cells, 'plate', one[2]));
        });
      })();
      ['interface', 'transition'].forEach(function (c) {                          // the hatch direction layer by layer
        if (!(A && B && A.cls[c] && B.cls[c])) return;
        var a = hatchAngle(A.cls[c]), b = hatchAngle(B.cls[c]);
        if (!a || !b || a.share < 0.3 || b.share < 0.3) return;
        angCmp++;
        var d = Math.abs(a.deg - b.deg) % 180; d = Math.min(d, 180 - d);
        if (d > 10) angBad.push({ cls: c, z: r2(z), ours: r2(a.deg), ref: r2(b.deg), diffDeg: r2(d) });
      });
      var row = { z: r2(z), zB: B ? r2(B.z) : null, zA: A ? r2(A.z) : null, cls: {} };
      var sup = 0;
      CLASSES.forEach(function (c) {
        var a = mA[c], b = mB[c];
        if (!a && !b) return;
        var na = 0, nb = 0, both = 0;
        for (var i = 0; i < N; i++) { var x = a ? a[i] : 0, y = b ? b[i] : 0; na += x; nb += y; both += x & y; }
        var e = { a: r2(na * cell2), b: r2(nb * cell2), both: r2(both * cell2), onlyA: r2((na - both) * cell2), onlyB: r2((nb - both) * cell2) };
        row.cls[c] = e;
        sums[c].onlyAMm2 += (na - both) * cell2; sums[c].onlyBMm2 += (nb - both) * cell2; sums[c].bothMm2 += both * cell2;
        if (SUPPORT_CLASSES.indexOf(c) >= 0) {
          sup += e.onlyA + e.onlyB;
          [['A', a, b, e.onlyA, A], ['B', b, a, e.onlyB, B]].forEach(function (t) {
            if (t[3] < 0.1 && !gapKeys[c + t[0]]) return;
            var only = null;
            if (t[3] >= 0.1 && t[1]) { only = new Uint8Array(N); for (var k = 0; k < N; k++) only[k] = t[1][k] && !(t[2] && t[2][k]) ? 1 : 0; }
            var zz = t[4] ? t[4].z : z;
            if (only && c !== 'support') regionsOf(only, 1.0).forEach(function (R) {          // a piece of plate on its own, under 1 mm2: the stray ring, the speck
              var ar = R.cells.length * cell2;
              if (ar < 0.1 || ar >= 1.0) return;
              var bl = blobOf(R.cells, c, zz);
              if (bl.x1 - bl.x0 <= 3.5 && bl.y1 - bl.y0 <= 3.5) strayRaw[t[0]].push(bl);       // small and alone; a rim sliver runs the length of its plate
            });
            trackGaps(c, t[0], t[3] >= 1.0 ? only : null, zz, t[3] >= 1.0 && t[2] ? edt2(t[2], g.nx, g.ny, Math.ceil(6 / cell), 4) : null);
          });
        }
      });
      row.supportDiffMm2 = r2(sup);
      layers.push(row);
      if (A) firstPlateLayer('A', mA, A.z, prev.zA != null && A.z - prev.zA <= ADJACENT_MM ? prev.A : null);
      if (B) firstPlateLayer('B', mB, B.z, prev.zB != null && B.z - prev.zB <= ADJACENT_MM ? prev.B : null);
      var hasSup = function (m) { return m.support || m.interface || m.transition; };       // the layer under = the last layer that carries support (Bambu's support layers sit at their own Z, between the part's)
      if (A && hasSup(mA)) { prev.A = mA; prev.zA = A.z; } if (B && hasSup(mB)) { prev.B = mB; prev.zB = B.z; }                                  // each side's own previous layer, whatever the pairing
    });

    /**
     * THE PLATES OF A STACK: a stack is 3-4 plates (layers) on top of each other, and the stack's own numbers (top, bottom, outline) are an outside view that
     * hides which plate is off. Per plate, bottom to top: where each side has it (Z), what it is (interface / transition by length), its area and how much of
     * it both have, how far its outline is, the length of its lines, the way its hatch runs - and what is wrong with it, in the plate's own words.
     */
    function platesOf(R) {
      var cells = R.cells, PRESENT_MM2 = 0.3, out = [];
      var inR = new Uint8Array(N); cells.forEach(function (c) { inR[c] = 1; });
      var inReg = function (m) {
        var ci = Math.floor(((m.x0 + m.x1) / 2 - g.ox) / cell), cj = Math.floor(((m.y0 + m.y1) / 2 - g.oy) / cell);
        return ci >= 0 && cj >= 0 && ci < g.nx && cj < g.ny && inR[cj * g.nx + ci] === 1;
      };
      var sideOf = function (L, mask) {
        if (!L || !mask) return null;
        var n = 0; for (var q = 0; q < cells.length; q++) n += mask[cells[q]];
        if (n * cell2 < PRESENT_MM2) return null;
        var len = { interface: 0, transition: 0 }, all = [];
        ['interface', 'transition'].forEach(function (c) { (L.cls[c] || []).forEach(function (m) { if (!inReg(m)) return; len[c] += m.length || Math.hypot(m.x1 - m.x0, m.y1 - m.y0); all.push(m); }); });
        var ang = hatchAngle(all);
        return { moves: all, n: n, z: L.z, h: L.h || 0.2, lenMm: len.interface + len.transition, kind: len.interface >= len.transition ? 'interface' : 'transition', iShare: len.interface / Math.max(1e-9, len.interface + len.transition), ang: ang && ang.share >= 0.3 ? ang.deg : null };
      };
      plateRows.forEach(function (pr) {
        var a = sideOf(pr.A, pr.mA), b = sideOf(pr.B, pr.mB);
        if (!a && !b) return;
        var both = 0;
        if (a && b) for (var q = 0; q < cells.length; q++) both += pr.mA[cells[q]] & pr.mB[cells[q]];
        var na = a ? a.n : 0, nb = b ? b.n : 0, e = { n: out.length + 1, zA: a ? r2(a.z) : null, zB: b ? r2(b.z) : null, kindA: a ? a.kind : null, kindB: b ? b.kind : null,
          aMm2: r2(na * cell2), bMm2: r2(nb * cell2), bothMm2: r2(both * cell2), lenA: a ? r2(a.lenMm) : 0, lenB: b ? r2(b.lenMm) : 0, angA: a && a.ang != null ? r2(a.ang) : null, angB: b && b.ang != null ? r2(b.ang) : null, flags: [] };
        e.lineIoU = na + nb - both > 0 ? r2(both / (na + nb - both)) : null;
        if (a && b) {
          e.dZMm = r2(a.z - b.z); e.dRadiusMm = r2(Math.sqrt(na * cell2 / Math.PI) - Math.sqrt(nb * cell2 / Math.PI));
          if (Math.abs(e.dZMm) > 0.05) e.flags.push('Z ' + (e.dZMm > 0 ? '+' : '') + e.dZMm.toFixed(2));
          if (Math.abs(e.dRadiusMm) > 0.15) e.flags.push('outline ' + (e.dRadiusMm > 0 ? 'too big' : 'too small') + ' ' + (e.dRadiusMm > 0 ? '+' : '') + e.dRadiusMm.toFixed(2));
          if (a.kind !== b.kind && Math.abs(a.iShare - b.iShare) > 0.5) e.flags.push(a.kind + ' vs ' + b.kind);
          if (e.angA != null && e.angB != null) { var d = Math.abs(e.angA - e.angB) % 180; d = Math.min(d, 180 - d); if (d > 10) e.flags.push('hatch ' + Math.round(e.angA) + ' vs ' + Math.round(e.angB) + ' deg'); }
          var lr = b.lenMm > 0 ? a.lenMm / b.lenMm : 1; e.lenRatio = r2(lr);
          if (lr > 1.25 || lr < 0.8) e.flags.push('lines x' + lr.toFixed(2));
          if (e.lineIoU != null && e.lineIoU < 0.6) e.flags.push('line IoU ' + e.lineIoU.toFixed(2));
        } else e.flags.push(a ? 'ours only' : 'reference only');
        var segs = function (q) { return q ? q.moves.map(function (m) { return [r2(m.x0), r2(m.y0), r2(m.x1), r2(m.y1), m.width || 0.45, /interface/i.test(m.feature) ? 1 : 0]; }) : []; };
        Object.defineProperty(e, 'draw', { value: { A: segs(a), B: segs(b) }, enumerable: false });      // the lines themselves, for the side by side view; kept out of the JSON
        out.push(e);
      });
      return out;
    }
    // THE STACKS: every footprint of plate (either side's, joined across 0.5 mm) with, per side, the Z it starts and ends at, its layer count and its
    // area; and where both stand, how far the top and bottom are apart and how far the outline is (as a circle of the same area).
    var stacks = [];
    (function () {
      var U = new Uint8Array(N);
      for (var i = 0; i < N; i++) U[i] = stk.A.n[i] || stk.B.n[i] ? 1 : 0;
      regionsOf(U, 0.5).forEach(function (R) {
        if (R.cells.length * cell2 < 1.0) return;
        var T = { A: { n: 0, bot: Infinity, top: -Infinity, lay: 0 }, B: { n: 0, bot: Infinity, top: -Infinity, lay: 0 } };
        var both = 0, dTop = 0, dBot = 0, sx = 0, sy = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        R.cells.forEach(function (c) {
          var ci = c % g.nx, cj = (c - ci) / g.nx, x = g.ox + (ci + 0.5) * cell, y = g.oy + (cj + 0.5) * cell;
          sx += x; sy += y; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          ['A', 'B'].forEach(function (n) {
            var S = stk[n]; if (!S.n[c]) return;
            var q = T[n]; q.n++; if (S.bot[c] < q.bot) q.bot = S.bot[c]; if (S.top[c] > q.top) q.top = S.top[c]; if (S.n[c] > q.lay) q.lay = S.n[c];
          });
          if (stk.A.n[c] && stk.B.n[c]) { both++; dTop += stk.A.top[c] - stk.B.top[c]; dBot += stk.A.bot[c] - stk.B.bot[c]; }
        });
        var side2 = function (q) { return q.n ? { zFrom: r2(q.bot), zTo: r2(q.top), layers: q.lay, footMm2: r2(q.n * cell2) } : null; };
        var st = { x: r2(sx / R.cells.length - offA[0]), y: r2(sy / R.cells.length - offA[1]), sizeMm: [r2(x1 - x0), r2(y1 - y0)], A: side2(T.A), B: side2(T.B), flags: [] };
        if (both >= 10) {
          st.dTopMm = r2(dTop / both); st.dBottomMm = r2(dBot / both);
          st.dRadiusMm = r2(Math.sqrt(T.A.n * cell2 / Math.PI) - Math.sqrt(T.B.n * cell2 / Math.PI));
          if (Math.abs(st.dTopMm) > 0.1) st.flags.push('top ' + (st.dTopMm > 0 ? 'high' : 'low'));
          if (Math.abs(st.dBottomMm) > 0.1) st.flags.push('bottom ' + (st.dBottomMm > 0 ? 'high' : 'low'));
          if (Math.abs(st.dRadiusMm) > 0.15) st.flags.push('outline ' + (st.dRadiusMm > 0 ? 'too big' : 'too small'));
        }
        if (st.A && st.B && st.A.layers !== st.B.layers) st.flags.push('layers ' + st.A.layers + ' vs ' + st.B.layers);
        if (!st.A) st.flags.push('ours has none'); if (!st.B) st.flags.push('reference has none');
        st.plates = platesOf(R);
        Object.defineProperty(st, 'box', { value: [x0, y0, x1, y1], enumerable: false });
        st._area = Math.max(T.A.n, T.B.n);
        stacks.push(st);
      });
      stacks.sort(function (p, q) { return q._area - p._area; });
      stacks.forEach(function (st) { delete st._area; });
    })();
    var classes = {};
    CLASSES.forEach(function (c) {
      var s = sums[c];
      ['A', 'B'].forEach(function (n) {
        var q = s[n];
        q.lengthMm = r2(q.lengthMm); q.volumeMm3 = r2(q.volumeMm3); q.areaMm2 = r2(q.areaMm2);
        q.firstZ = q.firstZ == null ? null : r2(q.firstZ); q.lastZ = q.lastZ == null ? null : r2(q.lastZ);
      });
      s.onlyAMm2 = r2(s.onlyAMm2); s.onlyBMm2 = r2(s.onlyBMm2); s.bothMm2 = r2(s.bothMm2);
      classes[c] = s;
    });
    var worst = layers.filter(function (l) { return l.supportDiffMm2 > 0; })
      .sort(function (p, q) { return q.supportDiffMm2 - p.supportDiffMm2; }).slice(0, 8)
      .map(function (l) { return { z: l.z, supportDiffMm2: l.supportDiffMm2, cls: l.cls }; });
    var shape = function (G) {
      return { cls: G.cls, zFrom: r2(G.zFrom), zTo: r2(G.zTo), layers: G.layers, areaMm2: r2(G.areaMm2), peakMm2: r2(G.peakMm2),
               x: r2(G.sx / G.n - offA[0]), y: r2(G.sy / G.n - offA[1]),
               bbox: [r2(G.x0 - offA[0]), r2(G.y0 - offA[1]), r2(G.x1 - offA[0]), r2(G.y1 - offA[1])], sizeMm: [r2(G.x1 - G.x0), r2(G.y1 - G.y0)],
               depthMm: G.depth != null ? r2(G.depth) : null };
    };
    var byArea = function (p, q) { return q.areaMm2 - p.areaMm2; };
    var gaps = {
      aLacks: gapAll.filter(function (G) { return G.side === 'onlyB'; }).map(shape).sort(byArea).slice(0, 12),   // the reference has it, ours does not
      bLacks: gapAll.filter(function (G) { return G.side === 'onlyA'; }).map(shape).sort(byArea).slice(0, 6)    // ours has it, the reference does not
    };
    return { meta: { cellMm: cell, frame: 'gap coordinates are in A\'s own file frame (A\'s offset on the compare plate taken off)', offsetAMm: offA, zTolMm: zTol, nearMm: nearMm, reachMm: reachMm, edgeMm: edgeMm, moves: [movesA.length, movesB.length], layers: layers.length },
             classes: classes, layers: layers, plate: plate, worst: worst, gaps: gaps,
             stacks: stacks.slice(0, 16),
             lone: { aLacks: stackBlobs(loneRaw.aLacks).map(shape).sort(byArea).slice(0, 10), bLacks: stackBlobs(loneRaw.bLacks).map(shape).sort(byArea).slice(0, 10) },
             angles: { compared: angCmp, mismatched: angBad.length, items: angBad.slice(0, 24) },
             strays: { A: stackBlobs(strayRaw.A).map(shape).sort(byArea).slice(0, 10), B: stackBlobs(strayRaw.B).map(shape).sort(byArea).slice(0, 10) } };
  }


  /**
   * THE PLATES SIDE BY SIDE: one card per plate of a stack, bottom to top, each with ours | reference | both laid over each other - the same frame on every
   * card, so the numbers can be checked against the lines. Returns HTML (inline SVG, a <style> of its own); `opts.stack` is the stack's index in rep.stacks.
   */
  var PLATE_CSS = '.pl-wrap{font:13px/1.35 system-ui,sans-serif;color:#222}.pl-head{margin:0 0 6px;font-weight:600}.pl-legend{margin:0 0 10px;color:#555}' +
    '.pl-legend b.o{color:#e8741a}.pl-legend b.b{color:#1f6fd6}.pl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(620px,1fr));gap:12px}' +
    '.pl-card{border:1px solid #ccd;border-radius:6px;padding:6px 8px;background:#fff}.pl-card.bad{border-color:#d33}.pl-title{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}' +
    '.pl-title b{font-size:14px}.pl-flag{color:#c22;font-weight:600}.pl-ok{color:#2a8a3a}.pl-stat{color:#555;font-size:12px;margin:2px 0 4px}' +
    '.pl-row{display:flex;gap:4px}.pl-cell{flex:1;min-width:0}.pl-cell small{display:block;text-align:center;color:#666;font-size:11px}' +
    '.pl-cell svg{width:100%;height:auto;background:#fafafa;border:1px solid #e3e3ea;display:block}.pl-ov{mix-blend-mode:multiply}';
  function platesHtml(rep, opts) {
    opts = opts || {};
    var st = rep && rep.stacks && rep.stacks[opts.stack || 0];
    if (!st || !st.plates || !st.plates.length || !st.box) return '<div class="pl-wrap">No plates to show.</div>';
    var M = 1.0, bx = st.box, vx = bx[0] - M, vy = -(bx[3] + M), vw = bx[2] - bx[0] + 2 * M, vh = bx[3] - bx[1] + 2 * M;
    var f = function (v) { return (Math.round(v * 100) / 100).toString(); };
    var path = function (segs, kind) {
      var d = '';
      segs.forEach(function (q) { if (q[5] === kind) d += 'M' + f(q[0]) + ' ' + f(-q[1]) + 'L' + f(q[2]) + ' ' + f(-q[3]); });
      return d;
    };
    var layer = function (segs, col) {                                          // transition lines paler, interface lines full: the two read apart
      var w = segs.length ? segs[0][4] : 0.45, di = path(segs, 1), dt = path(segs, 0), o = '';
      if (dt) o += '<path d="' + dt + '" stroke="' + col + '" stroke-opacity="0.55" stroke-width="' + f(w) + '" stroke-linecap="round" fill="none"/>';
      if (di) o += '<path d="' + di + '" stroke="' + col + '" stroke-width="' + f(w) + '" stroke-linecap="round" fill="none"/>';
      return o;
    };
    var OC = '#e8741a', BC = '#1f6fd6';
    var svg = function (inner, cls) { return '<svg viewBox="' + f(vx) + ' ' + f(vy) + ' ' + f(vw) + ' ' + f(vh) + '" xmlns="http://www.w3.org/2000/svg"' + (cls ? ' class="' + cls + '"' : '') + '>' + inner + '</svg>'; };
    var out = '<style>' + PLATE_CSS + '</style><div class="pl-wrap"><div class="pl-head">Stack at X ' + st.x.toFixed(1) + ' Y ' + st.y.toFixed(1) + ' &mdash; ' + st.sizeMm[0].toFixed(1) + ' x ' + st.sizeMm[1].toFixed(1) + ' mm, ' + st.plates.length + ' plates, bottom to top' +
      (st.flags.length ? ' <span class="pl-flag">&larr; ' + st.flags.join(', ') + '</span>' : '') + '</div>' +
      '<div class="pl-legend"><b class="o">orange</b> = ours, <b class="b">blue</b> = reference, third picture both together (where they agree it is dark). Solid lines = interface, pale = transition. Same frame on every card.</div><div class="pl-grid">';
    st.plates.forEach(function (p) {
      var dr = p.draw || { A: [], B: [] };
      var kinds = (p.kindA || '-') + ' / ' + (p.kindB || '-');
      out += '<div class="pl-card' + (p.flags.length ? ' bad' : '') + '"><div class="pl-title"><b>plate ' + p.n + '</b><span>Z ' + (p.zA != null ? p.zA.toFixed(2) : '-') + ' | ' + (p.zB != null ? p.zB.toFixed(2) : '-') + '</span><span>' + kinds + '</span>' +
        (p.flags.length ? '<span class="pl-flag">' + p.flags.join(', ') + '</span>' : '<span class="pl-ok">matches</span>') + '</div>' +
        '<div class="pl-stat">area ' + p.aMm2.toFixed(1) + ' | ' + p.bMm2.toFixed(1) + ' mm2 &middot; lines ' + p.lenA.toFixed(0) + ' | ' + p.lenB.toFixed(0) + ' mm &middot; hatch ' + (p.angA != null ? Math.round(p.angA) : '-') + ' | ' + (p.angB != null ? Math.round(p.angB) : '-') +
        ' deg &middot; line IoU ' + (p.lineIoU != null ? p.lineIoU.toFixed(2) : '-') + (p.dRadiusMm != null ? ' &middot; outline ' + (p.dRadiusMm > 0 ? '+' : '') + p.dRadiusMm.toFixed(2) + ' mm' : '') + '</div>' +
        '<div class="pl-row"><div class="pl-cell"><small>ours</small>' + svg(layer(dr.A, OC)) + '</div><div class="pl-cell"><small>reference</small>' + svg(layer(dr.B, BC)) + '</div>' +
        '<div class="pl-cell"><small>both</small>' + svg('<g class="pl-ov">' + layer(dr.A, OC) + '</g><g class="pl-ov" opacity="0.8">' + layer(dr.B, BC) + '</g>') + '</div></div></div>';
    });
    return out + '</div></div>';
  }

  var LABEL = { part: 'part', support: 'support (tree)', interface: 'interface', transition: 'transition' };

  /** The report as text: the table of line types, then the plate's first layer, then the worst layers. */
  function text(rep) {
    if (!rep || !rep.layers || !rep.layers.length) return 'Nothing to compare.';
    var out = [];
    out.push('A = Plate 1 (ours), B = Plate 2 (reference). Areas in mm2 per layer summed over the piece; Z in mm.');
    out.push('');
    out.push('line type     Z range A        Z range B        layers A/B   only A    only B     both');
    CLASSES.forEach(function (c) {
      var s = rep.classes[c];
      if (!s || (!s.A.layers && !s.B.layers)) return;
      var zr = function (q) { return q.firstZ == null ? '-' : q.firstZ.toFixed(2) + ' - ' + q.lastZ.toFixed(2); };
      out.push(pad(LABEL[c], 13) + pad(zr(s.A), 17) + pad(zr(s.B), 17) + pad(s.A.layers + '/' + s.B.layers, 13) + pad(s.onlyAMm2.toFixed(1), 10) + pad(s.onlyBMm2.toFixed(1), 10) + s.bothMm2.toFixed(1));
    });
    ['A', 'B'].forEach(function (n) {
      var p = rep.plate[n];
      out.push('');
      out.push((n === 'A' ? 'A' : 'B') + ': ' + (p.length ? p.length + ' plate' + (p.length === 1 ? '' : 's') + ' (first layers of interface / transition)' : 'no interface or transition plate'));
      p.forEach(function (q) {
        out.push('  z ' + q.z.toFixed(2) + '  ' + q.regions + ' plate' + (q.regions === 1 ? '' : 's') + ' ' + q.plateMm2.toFixed(1) + '  tree under it ' + q.supportBelowMm2.toFixed(1) + (q.gap ? '  GAP: ' + q.gapRegions + ' of ' + q.regions + ' with no tree under' : q.treeAbsent ? '  (no tree in this selection - gap not judged)' : q.onBed ? '  (on the bed)' : '') +
                 '  past its outline ' + q.overshootMm2.toFixed(2) + ' mm2 (max ' + q.overshootMaxMm.toFixed(2) + ' mm)');
      });
    });
    var G = rep.gaps;
    if (G && (G.aLacks.length || G.bLacks.length)) {
      var line = function (q) {
        return '  ' + pad(q.cls, 11) + 'z ' + q.zFrom.toFixed(2) + (q.zTo > q.zFrom ? ' - ' + q.zTo.toFixed(2) : '') + '  (' + q.layers + ' layer' + (q.layers === 1 ? '' : 's') + ')  at X ' + q.x.toFixed(1) + ' Y ' + q.y.toFixed(1) +
               '  box ' + q.sizeMm[0].toFixed(1) + ' x ' + q.sizeMm[1].toFixed(1) + '  ' + q.areaMm2.toFixed(1) + ' mm2 in all (peak ' + q.peakMm2.toFixed(1) + '/layer)' + (q.depthMm != null ? '  reaches ' + q.depthMm.toFixed(2) + ' mm past the other' : '');
      };
      if (G.aLacks.length) { out.push(''); out.push('WHERE OURS HAS NOTHING AND THE REFERENCE DOES (largest first; X Y in A\'s file coordinates):'); G.aLacks.forEach(function (q) { out.push(line(q)); }); }
      if (G.bLacks.length) { out.push(''); out.push('where ours has material the reference does not:'); G.bLacks.forEach(function (q) { out.push(line(q)); }); }
    }
    var oneLine = function (q) {
      return '  z ' + q.zFrom.toFixed(2) + (q.zTo > q.zFrom ? ' - ' + q.zTo.toFixed(2) : '') + '  (' + q.layers + ' layer' + (q.layers === 1 ? '' : 's') + ')  at X ' + q.x.toFixed(1) + ' Y ' + q.y.toFixed(1) + '  ' + q.sizeMm[0].toFixed(1) + ' x ' + q.sizeMm[1].toFixed(1) + ' mm  ' + q.areaMm2.toFixed(1) + ' mm2';
    };
    var Lo = rep.lone;
    if (Lo && Lo.aLacks.length) { out.push(''); out.push('PLATE LAYERS ONLY THE REFERENCE HAS (a whole layer, however small - ours has none on that layer):'); Lo.aLacks.forEach(function (q) { out.push(oneLine(q)); }); }
    if (Lo && Lo.bLacks.length) { out.push(''); out.push('plate layers only ours has:'); Lo.bLacks.forEach(function (q) { out.push(oneLine(q)); }); }
    if (rep.stacks && rep.stacks.length) {
      var sf = function (q) { return q ? q.zFrom.toFixed(2) + ' - ' + q.zTo.toFixed(2) + ' (' + q.layers + ' lay, ' + q.footMm2.toFixed(1) + ' mm2)' : 'none'; };
      out.push(''); out.push('PLATE STACKS (each footprint: Z from - to, layers, area; ours | reference; then top / bottom / outline offsets, ours minus reference):');
      rep.stacks.forEach(function (q) {
        out.push('  X ' + q.x.toFixed(1) + ' Y ' + q.y.toFixed(1) + '  ' + q.sizeMm[0].toFixed(1) + ' x ' + q.sizeMm[1].toFixed(1) + '   ' + sf(q.A) + ' | ' + sf(q.B) +
                 (q.dTopMm != null ? '   top ' + q.dTopMm.toFixed(2) + '  bottom ' + q.dBottomMm.toFixed(2) + '  outline radius ' + q.dRadiusMm.toFixed(2) : '') + (q.flags.length ? '   <-- ' + q.flags.join(', ') : ''));
        (q.plates || []).forEach(function (p) { out.push('      plate ' + p.n + '  Z ' + (p.zA != null ? p.zA.toFixed(2) : '-') + ' | ' + (p.zB != null ? p.zB.toFixed(2) : '-') + '  ' + pad((p.kindA || '-') + '/' + (p.kindB || '-'), 23) + 'area ' + p.aMm2.toFixed(1) + ' | ' + p.bMm2.toFixed(1) + '  lines ' + p.lenA.toFixed(0) + ' | ' + p.lenB.toFixed(0) + ' mm  hatch ' + (p.angA != null ? Math.round(p.angA) : '-') + ' | ' + (p.angB != null ? Math.round(p.angB) : '-') + '  IoU ' + (p.lineIoU != null ? p.lineIoU.toFixed(2) : '-') + (p.dRadiusMm != null ? '  outline ' + (p.dRadiusMm > 0 ? '+' : '') + p.dRadiusMm.toFixed(2) : '') + (p.flags.length ? '   <-- ' + p.flags.join(', ') : '')); });
      });
    }
    if (rep.angles && rep.angles.compared) {
      out.push(''); out.push('HATCH ANGLE: ' + rep.angles.mismatched + ' of ' + rep.angles.compared + ' interface / transition layers run a different way (over 10 degrees)');
      rep.angles.items.forEach(function (q) { out.push('  z ' + q.z.toFixed(2) + '  ' + q.cls + '  ours ' + q.ours.toFixed(0) + ' deg, reference ' + q.ref.toFixed(0) + ' deg'); });
    }
    var St = rep.strays;
    if (St && (St.A.length || St.B.length)) {
      if (St.A.length) { out.push(''); out.push('SMALL PIECES OF OURS ALONE (under 1 mm2 each, alone on their layer - stray rings, specks):'); St.A.forEach(function (q) { out.push('  ' + pad(q.cls, 11) + oneLine(q).trim()); }); }
      if (St.B.length) { out.push(''); out.push('small pieces of the reference alone:'); St.B.forEach(function (q) { out.push('  ' + pad(q.cls, 11) + oneLine(q).trim()); }); }
    }
    if (rep.worst.length) {
      out.push('');
      out.push('layers that differ most (support, interface and transition together): ' + rep.worst.map(function (w) { return w.z.toFixed(2) + ' (' + w.supportDiffMm2.toFixed(1) + ')'; }).join(', '));
    }
    return out.join('\n');
  }
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

  /** The same report as blocks for a narrow panel (no wide table to scroll sideways): the card draws these, the words are text()'s. */
  function view(rep) {
    if (!rep || !rep.layers || !rep.layers.length) return [{ kind: 'lead', text: 'Nothing to compare.' }];
    var B = [], f1 = function (v) { return v.toFixed(1); };
    B.push({ kind: 'lead', text: 'A = Plate 1 (ours), B = Plate 2 (reference). Areas in mm2 per layer summed over the piece; Z in mm.' });
    var rows = [];
    CLASSES.forEach(function (c) {
      var s = rep.classes[c];
      if (!s || (!s.A.layers && !s.B.layers)) return;
      var zr = function (q) { return q.firstZ == null ? '-' : q.firstZ.toFixed(2) + ' - ' + q.lastZ.toFixed(2); };
      rows.push({ label: LABEL[c], zA: zr(s.A), zB: zr(s.B), layersA: s.A.layers, layersB: s.B.layers, onlyA: f1(s.onlyAMm2), onlyB: f1(s.onlyBMm2), both: f1(s.bothMm2) });
    });
    B.push({ kind: 'types', title: 'line type', rows: rows });
    ['A', 'B'].forEach(function (n) {
      var p = rep.plate[n];
      var items = p.map(function (q) {
        return { head: 'z ' + q.z.toFixed(2) + '  ' + q.regions + ' plate' + (q.regions === 1 ? '' : 's') + ' ' + f1(q.plateMm2) + ' mm2',
                 tree: 'tree under it ' + f1(q.supportBelowMm2), outline: 'past its outline ' + q.overshootMm2.toFixed(2) + ' mm2 (max ' + q.overshootMaxMm.toFixed(2) + ' mm)',
                 note: q.gap ? 'GAP: ' + q.gapRegions + ' of ' + q.regions + ' with no tree under' : q.treeAbsent ? '(no tree in this selection - gap not judged)' : q.onBed ? '(on the bed)' : '', gap: !!q.gap };
      });
      B.push({ kind: 'plates', title: n + ': ' + (p.length ? p.length + ' plate' + (p.length === 1 ? '' : 's') + ' (first layers of interface / transition)' : 'no interface or transition plate'), items: items });
    });
    var G = rep.gaps;
    var gi = function (q) {
      return { what: q.cls, z: 'z ' + q.zFrom.toFixed(2) + (q.zTo > q.zFrom ? ' - ' + q.zTo.toFixed(2) : '') + '  (' + q.layers + ' layer' + (q.layers === 1 ? '' : 's') + ')',
               at: 'at X ' + f1(q.x) + ' Y ' + f1(q.y) + '  box ' + f1(q.sizeMm[0]) + ' x ' + f1(q.sizeMm[1]), area: f1(q.areaMm2) + ' mm2 in all (peak ' + f1(q.peakMm2) + '/layer)' };
    };
    if (G && G.aLacks.length) B.push({ kind: 'gaps', title: 'WHERE OURS HAS NOTHING AND THE REFERENCE DOES (largest first; X Y in A\'s file coordinates):', items: G.aLacks.map(gi) });
    if (G && G.bLacks.length) B.push({ kind: 'gaps', title: 'where ours has material the reference does not:', items: G.bLacks.map(gi) });
    var oi = function (q, what) {
      return { what: what || q.cls, z: 'z ' + q.zFrom.toFixed(2) + (q.zTo > q.zFrom ? ' - ' + q.zTo.toFixed(2) : '') + '  (' + q.layers + ' layer' + (q.layers === 1 ? '' : 's') + ')',
               at: 'at X ' + f1(q.x) + ' Y ' + f1(q.y) + '  box ' + f1(q.sizeMm[0]) + ' x ' + f1(q.sizeMm[1]), area: f1(q.areaMm2) + ' mm2 in all' };
    };
    if (rep.lone && rep.lone.aLacks.length) B.push({ kind: 'gaps', title: 'PLATE LAYERS ONLY THE REFERENCE HAS (a whole layer, however small):', items: rep.lone.aLacks.map(function (q) { return oi(q, 'plate'); }) });
    if (rep.lone && rep.lone.bLacks.length) B.push({ kind: 'gaps', title: 'plate layers only ours has:', items: rep.lone.bLacks.map(function (q) { return oi(q, 'plate'); }) });
    if (rep.stacks && rep.stacks.length) {
      var sf = function (q) { return q ? q.zFrom.toFixed(2) + ' - ' + q.zTo.toFixed(2) + ', ' + q.layers + ' layers, ' + f1(q.footMm2) + ' mm2' : 'none'; };
      B.push({ kind: 'gaps', title: 'PLATE STACKS (ours | reference):', items: rep.stacks.map(function (q) {
        return { what: q.flags.length ? '<-- ' + q.flags.join(', ') : 'stack', z: 'ours ' + sf(q.A), at: 'ref  ' + sf(q.B) + '   at X ' + f1(q.x) + ' Y ' + f1(q.y),
                 area: q.dTopMm != null ? 'top ' + q.dTopMm.toFixed(2) + '  bottom ' + q.dBottomMm.toFixed(2) + '  outline radius ' + q.dRadiusMm.toFixed(2) + ' mm' : '' };
      }) });
    }
    if (rep.stacks) rep.stacks.forEach(function (q) {
      if (!q.plates || !q.plates.length) return;
      B.push({ kind: 'gaps', title: 'PLATES OF THE STACK AT X ' + f1(q.x) + ' Y ' + f1(q.y) + ' (bottom to top, ours | reference):', items: q.plates.map(function (p) {
        return { what: p.flags.length ? '<-- ' + p.flags.join(', ') : 'plate ' + p.n + ' ok', z: 'plate ' + p.n + '  Z ' + (p.zA != null ? p.zA.toFixed(2) : '-') + ' | ' + (p.zB != null ? p.zB.toFixed(2) : '-') + '  ' + (p.kindA || '-') + ' / ' + (p.kindB || '-'),
                 at: 'area ' + f1(p.aMm2) + ' | ' + f1(p.bMm2) + ' mm2  lines ' + p.lenA.toFixed(0) + ' | ' + p.lenB.toFixed(0) + ' mm  hatch ' + (p.angA != null ? Math.round(p.angA) : '-') + ' | ' + (p.angB != null ? Math.round(p.angB) : '-') + ' deg',
                 area: 'line IoU ' + (p.lineIoU != null ? p.lineIoU.toFixed(2) : '-') + (p.dRadiusMm != null ? '  outline radius ' + (p.dRadiusMm > 0 ? '+' : '') + p.dRadiusMm.toFixed(2) + ' mm' : '') };
      }) });
    });
    if (rep.angles && rep.angles.compared) B.push({ kind: 'worst', title: 'HATCH ANGLE: ' + rep.angles.mismatched + ' of ' + rep.angles.compared + ' layers differ (ours / reference, deg):', items: rep.angles.items.map(function (q) { return [q.z.toFixed(2) + ' ' + q.cls, q.ours.toFixed(0) + ' / ' + q.ref.toFixed(0) + ' deg']; }).map(function (w) { return [w[0], w[1].replace(' mm2', '')]; }) });
    if (rep.strays && rep.strays.A.length) B.push({ kind: 'gaps', title: 'SMALL PIECES OF OURS ALONE (under 1 mm2, alone on their layer):', items: rep.strays.A.map(function (q) { return oi(q); }) });
    if (rep.strays && rep.strays.B.length) B.push({ kind: 'gaps', title: 'small pieces of the reference alone:', items: rep.strays.B.map(function (q) { return oi(q); }) });
    if (rep.worst.length) B.push({ kind: 'worst', title: 'layers that differ most (support, interface and transition together):', items: rep.worst.map(function (w) { return [w.z.toFixed(2), f1(w.supportDiffMm2)]; }) });
    return B;
  }

  return { compute: compute, text: text, view: view, platesHtml: platesHtml, classOf: classOf, edt2: edt2Full, CLASSES: CLASSES };
});
