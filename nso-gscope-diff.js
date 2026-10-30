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
 * LAYERS are paired by Z: A's layer and the B layer within opts.zTolMm (0.11) of it are one row; a layer with no partner is a row of its own.
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
  function edt2(mask, nx, ny) {
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

  /** The moves of one side by layer key -> class -> list. */
  function byLayer(moves, keyOf) {
    var out = {};
    moves.forEach(function (m) {
      var c = classOf(m.feature);
      if (!c) return;
      var k = keyOf(m.z);
      var L = out[k] || (out[k] = { z: m.z, cls: {} });
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
    var key = function (z) { return Math.round(z * 1000); };
    var LA = byLayer(movesA, key), LB = byLayer(movesB, key);
    // layer rows: A's z, B's z within the tolerance of it, or alone
    var zsA = Object.keys(LA).map(Number).sort(function (a, b) { return a - b; });
    var zsB = Object.keys(LB).map(Number).sort(function (a, b) { return a - b; });
    var rows = zsA.map(function (k) { return { a: k, b: null }; });
    zsB.forEach(function (kb) {
      var best = -1, bd = Infinity;
      rows.forEach(function (r, i) { var d = Math.abs(r.a - kb); if (r.a != null && r.b == null && d < bd) { bd = d; best = i; } });
      if (best >= 0 && bd <= zTol * 1000) rows[best].b = kb; else rows.push({ a: null, b: kb });
    });
    rows.sort(function (p, q) { return (p.a != null ? p.a : p.b) - (q.a != null ? q.a : q.b); });

    var sums = {};
    CLASSES.forEach(function (c) {
      sums[c] = { A: { firstZ: null, lastZ: null, layers: 0, moves: 0, lengthMm: 0, volumeMm3: 0, areaMm2: 0 },
                  B: { firstZ: null, lastZ: null, layers: 0, moves: 0, lengthMm: 0, volumeMm3: 0, areaMm2: 0 }, onlyAMm2: 0, onlyBMm2: 0, bothMm2: 0 };
    });
    var layers = [], plate = { A: [], B: [] }, prev = { A: null, B: null, zA: null, zB: null }, ADJACENT_MM = 0.5;   // a layer more than this under is not 'the layer under'

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
      var d2 = edt2(P, g.nx, g.ny), j2 = Math.pow(joinMm / cell, 2), lab = new Int32Array(N), out = [], stack = [];
      for (var s0 = 0; s0 < N; s0++) {
        if (!P[s0] || lab[s0]) continue;
        var id = out.length + 1, cells = [];
        lab[s0] = id; stack.push(s0);
        // flood over every cell within joinMm of the mask, so lines of one plate fall into one region
        while (stack.length) {
          var c = stack.pop(), ci = c % g.nx, cj = (c - ci) / g.nx;
          if (P[c]) cells.push(c);
          for (var k = 0; k < 4; k++) {
            var ni = ci + (k === 0 ? 1 : k === 1 ? -1 : 0), nj = cj + (k === 2 ? 1 : k === 3 ? -1 : 0);
            if (ni < 0 || nj < 0 || ni >= g.nx || nj >= g.ny) continue;
            var n = nj * g.nx + ni;
            if (lab[n] || d2[n] > j2) continue;
            lab[n] = id; stack.push(n);
          }
        }
        out.push({ cells: cells });
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
      var dPrev = Pprev && count(Pprev) * cell2 >= 0.05 ? edt2(Pprev, g.nx, g.ny) : null, cont2 = Math.pow(1.5 / cell, 2);
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
        var dR = edt2(Rm, g.nx, g.ny), b = 0;
        if (S) for (var i = 0; i < N; i++) if (S[i] && dR[i] <= near2) b++;
        below += b;
        if (b === 0 && hasTree[name] && z > BED_MM) nGap++;                      // no tree in the selection, or a plate on the bed: nothing to run up to it
      });
      if (!nFirst) return;
      var d2 = edt2(first, g.nx, g.ny), over = 0, maxD2 = 0;
      if (S) for (var j = 0; j < N; j++) {
        if (!S[j]) continue;
        var d = d2[j];
        if (d > edge2 && d <= reach2) { over++; if (d > maxD2) maxD2 = d; }
      }
      plate[name].push({ z: r2(z), regions: nFirst, gapRegions: nGap, plateMm2: r2(plateCells * cell2), supportBelowMm2: r2(below * cell2), gap: nGap > 0, treeAbsent: !hasTree[name], onBed: z <= BED_MM,
                         overshootMm2: r2(over * cell2), overshootMaxMm: r2(Math.sqrt(maxD2) * cell) });
    }

    rows.forEach(function (r) {
      var A = r.a != null ? LA[r.a] : null, B = r.b != null ? LB[r.b] : null;
      var z = A ? A.z : B.z;
      var mA = masksOf(A), mB = masksOf(B);
      side('A', A, mA, A ? A.z : z); side('B', B, mB, B ? B.z : z);
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
        if (SUPPORT_CLASSES.indexOf(c) >= 0) sup += e.onlyA + e.onlyB;
      });
      row.supportDiffMm2 = r2(sup);
      layers.push(row);
      if (A) firstPlateLayer('A', mA, A.z, prev.zA != null && A.z - prev.zA <= ADJACENT_MM ? prev.A : null);
      if (B) firstPlateLayer('B', mB, B.z, prev.zB != null && B.z - prev.zB <= ADJACENT_MM ? prev.B : null);
      var hasSup = function (m) { return m.support || m.interface || m.transition; };       // the layer under = the last layer that carries support (Bambu's support layers sit at their own Z, between the part's)
      if (A && hasSup(mA)) { prev.A = mA; prev.zA = A.z; } if (B && hasSup(mB)) { prev.B = mB; prev.zB = B.z; }                                  // each side's own previous layer, whatever the pairing
    });

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
    return { meta: { cellMm: cell, zTolMm: zTol, nearMm: nearMm, reachMm: reachMm, edgeMm: edgeMm, moves: [movesA.length, movesB.length], layers: layers.length },
             classes: classes, layers: layers, plate: plate, worst: worst };
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
    if (rep.worst.length) {
      out.push('');
      out.push('layers that differ most (support, interface and transition together): ' + rep.worst.map(function (w) { return w.z.toFixed(2) + ' (' + w.supportDiffMm2.toFixed(1) + ')'; }).join(', '));
    }
    return out.join('\n');
  }
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

  return { compute: compute, text: text, classOf: classOf, edt2: edt2, CLASSES: CLASSES };
});
