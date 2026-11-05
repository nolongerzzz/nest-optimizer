/*
 * G-scope's measuring: what a selection of toolpath moves adds up to.
 * -------------------------------------------------------------------
 * Pure numbers, no DOM: the viewer (app-microscope.js, the MEASURE row) and
 * the command-line checks (tools/nso_gscope_measure_test.js) call the same
 * functions, so a number read off the card is the number a test holds.
 *
 * An ITEM is a move of a sliced file, or a G-scope segment that carries one
 * (`seg.mv`): x0 y0 x1 y1 z width height length layer feature objectId index.
 * Items are read in FILE ORDER (`index`, else the order given): a "run" is a
 * stretch of moves each starting where the one before it ended, which is how
 * the nozzle laid it without lifting.
 *
 *   summarize(items)        -> { moves, lengthMm, volumeMm3, layers, zMin, zMax,
 *                                bbox, features[], objects[] }
 *                              one row per feature type (and per object id),
 *                              longest first.
 *   layerRows(items, opts)  -> one row per (layer Z, feature) of the chosen
 *                              features: runs, lines, long and short lines,
 *                              length, dominant angle, line pitch, footprint,
 *                              and corners (every turn of more than 5 degrees
 *                              inside a run: a zigzag has one at each end of
 *                              each stroke, a straight edge none).
 *   compare(a, b)           -> the feature types only one side has, and the
 *                              rows side by side.
 *   report(sum, rows, name) -> the same as plain text, to copy.
 *
 * The line metrics are the ones the support-interface work used to compare
 * the generator with Bambu's reference slice (docs/SUPPORT-INTERFACE.md).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NSOMeasure = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var RUN_JOIN_MM = 0.02;        // a move starting this near the last one's end continues its run
  var LINE_JOIN_DEG = 3;         // two moves within this of one angle, end to start, are one line
  var LONG_LINE_MM = 2;          // a line shorter than this is a turn, not a stroke
  var CORNER_DEG = 5;              // a turn of more than this inside a run is a corner
  var PITCH_BIN_DEG = 5;         // the dominant direction is read in bins this wide
  var PITCH_CLUSTER_MM = 0.25;   // lines this near across are one line of the lattice
  var PITCH_SAME_DEG = 10;       // lines within this of the dominant direction are along it

  function mvOf(it) { return it && it.mv ? it.mv : it; }
  function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

  /* items in file order, as plain moves */
  function movesOf(items) {
    var out = [];
    for (var i = 0; i < (items || []).length; i++) { var m = mvOf(items[i]); if (m) out.push(m); }
    var ordered = out.every(function (m) { return typeof m.index === 'number'; });
    if (ordered) out.sort(function (a, b) { return a.index - b.index; });
    return out;
  }
  function lenOf(m) { return num(m.length, Math.hypot(m.x1 - m.x0, m.y1 - m.y0)); }
  function featOf(m) { return m.feature || '(untagged)'; }

  /* ---------------------------------------------------------- summary */

  function summarize(items) {
    var mv = movesOf(items), byF = {}, byO = {}, layers = {}, bb = [Infinity, Infinity, -Infinity, -Infinity];
    var zMin = Infinity, zMax = -Infinity, len = 0, vol = 0;
    mv.forEach(function (m) {
      var L = lenOf(m), v = L * num(m.width, 0) * num(m.height, 0);
      len += L; vol += v;
      layers[m.layer] = 1;
      if (m.z < zMin) zMin = m.z; if (m.z > zMax) zMax = m.z;
      [[m.x0, m.y0], [m.x1, m.y1]].forEach(function (p) {
        if (p[0] < bb[0]) bb[0] = p[0]; if (p[1] < bb[1]) bb[1] = p[1]; if (p[0] > bb[2]) bb[2] = p[0]; if (p[1] > bb[3]) bb[3] = p[1];
      });
      var f = featOf(m), a = byF[f] || (byF[f] = { feature: f, moves: 0, lengthMm: 0, volumeMm3: 0, zMin: Infinity, zMax: -Infinity });
      a.moves++; a.lengthMm += L; a.volumeMm3 += v; if (m.z < a.zMin) a.zMin = m.z; if (m.z > a.zMax) a.zMax = m.z;
      var o = m.objectId == null ? '-' : String(m.objectId), b = byO[o] || (byO[o] = { obj: o, moves: 0, lengthMm: 0 });
      b.moves++; b.lengthMm += L;
    });
    function rows(map) { return Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.lengthMm - a.lengthMm; }); }
    return {
      moves: mv.length, lengthMm: len, volumeMm3: vol, layers: Object.keys(layers).length,
      zMin: mv.length ? zMin : null, zMax: mv.length ? zMax : null,
      bbox: mv.length ? bb : null,
      features: rows(byF), objects: rows(byO),
      avgMoveMm: mv.length ? len / mv.length : 0
    };
  }

  /* ------------------------------------------------------ line metrics */

  /* the moves of one run, merged where they carry on in one direction (a straight stroke the slicer wrote as several moves is one line) */
  function mergeLines(runs) {
    var out = [];
    runs.forEach(function (run) {
      var cur = null;
      run.forEach(function (s) {
        var a = Math.atan2(s[3] - s[1], s[2] - s[0]);
        if (cur) {
          var d = Math.abs(a - cur.a); d = Math.min(d, 2 * Math.PI - d);
          if (d < LINE_JOIN_DEG * Math.PI / 180 && Math.hypot(s[0] - cur.x1, s[1] - cur.y1) < RUN_JOIN_MM) { cur.x1 = s[2]; cur.y1 = s[3]; return; }
          out.push(cur);
        }
        cur = { x0: s[0], y0: s[1], x1: s[2], y1: s[3], a: a };
      });
      if (cur) out.push(cur);
    });
    return out.map(function (l) {
      var deg = ((Math.atan2(l.y1 - l.y0, l.x1 - l.x0) * 180 / Math.PI) % 180 + 180) % 180;
      return { x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, a: l.a, len: Math.hypot(l.x1 - l.x0, l.y1 - l.y0), deg: deg };
    });
  }

  function lineMetrics(runs) {
    var lines = mergeLines(runs), tot = 0, h = {}, i;
    lines.forEach(function (l) { tot += l.len; });
    lines.forEach(function (l) { if (l.len >= LONG_LINE_MM) { var k = Math.round(l.deg / PITCH_BIN_DEG) * PITCH_BIN_DEG % 180; h[k] = (h[k] || 0) + l.len; } });
    var dom = 0, best = -1;
    Object.keys(h).forEach(function (k) { if (h[k] > best) { best = h[k]; dom = +k; } });
    var nx = -Math.sin(dom * Math.PI / 180), ny = Math.cos(dom * Math.PI / 180);
    var along = lines.filter(function (l) { return l.len >= LONG_LINE_MM && Math.min(Math.abs(l.deg - dom), 180 - Math.abs(l.deg - dom)) <= PITCH_SAME_DEG; });
    var offs = along.map(function (l) { return ((l.x0 + l.x1) / 2) * nx + ((l.y0 + l.y1) / 2) * ny; }).sort(function (a, b) { return a - b; });
    var cl = [];
    offs.forEach(function (o) { var last = cl[cl.length - 1]; if (last && o - last[last.length - 1] < PITCH_CLUSTER_MM) last.push(o); else cl.push([o]); });
    var cs = cl.map(function (c) { return c.reduce(function (a, b) { return a + b; }, 0) / c.length; });
    var gaps = []; for (i = 1; i < cs.length; i++) gaps.push(cs[i] - cs[i - 1]);
    gaps.sort(function (a, b) { return a - b; });
    var bb = [Infinity, Infinity, -Infinity, -Infinity];
    lines.forEach(function (l) { [[l.x0, l.y0], [l.x1, l.y1]].forEach(function (p) { if (p[0] < bb[0]) bb[0] = p[0]; if (p[1] < bb[1]) bb[1] = p[1]; if (p[0] > bb[2]) bb[2] = p[0]; if (p[1] > bb[3]) bb[3] = p[1]; }); });
    var corners = 0;
    runs.forEach(function (run) {
      for (var k = 1; k < run.length; k++) {
        var a1 = Math.atan2(run[k - 1][3] - run[k - 1][1], run[k - 1][2] - run[k - 1][0]), a2 = Math.atan2(run[k][3] - run[k][1], run[k][2] - run[k][0]);
        if (Math.abs((a2 - a1 + Math.PI) % (2 * Math.PI) - Math.PI) > CORNER_DEG * Math.PI / 180) corners++;
      }
    });
    return {
      runs: runs.length, lines: lines.length, longLines: along.length, shortLines: lines.filter(function (l) { return l.len < LONG_LINE_MM; }).length,
      lengthMm: tot, domDeg: dom, pitchMm: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
      widthMm: lines.length ? bb[2] - bb[0] : 0, depthMm: lines.length ? bb[3] - bb[1] : 0, corners: corners
    };
  }

  /* one row per (layer Z, feature) of the features asked for (opts.features: names; none asked: the support family) */
  function layerRows(items, opts) {
    opts = opts || {};
    var want = opts.features && opts.features.length ? opts.features : null;
    var by = {}, order = [], prev = null;
    movesOf(items).forEach(function (m) {
      var f = featOf(m);
      if (want ? want.indexOf(f) < 0 : !/^Support/.test(f)) { prev = null; return; }
      var k = m.z.toFixed(3) + '|' + f + '|' + (m.objectId == null ? '' : m.objectId), g = by[k];
      if (!g) { g = by[k] = { z: m.z, layer: m.layer, feature: f, obj: m.objectId == null ? null : m.objectId, runs: [] }; order.push(g); }
      var seg = [m.x0, m.y0, m.x1, m.y1];
      if (prev && prev.k === k && Math.hypot(prev.x1 - m.x0, prev.y1 - m.y0) < RUN_JOIN_MM && g.runs.length) g.runs[g.runs.length - 1].push(seg);
      else g.runs.push([seg]);
      prev = { k: k, x1: m.x1, y1: m.y1 };
    });
    return order.sort(function (a, b) { return a.z - b.z || (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0); })
      .map(function (g) { var r = lineMetrics(g.runs); r.z = g.z; r.layer = g.layer; r.feature = g.feature; r.obj = g.obj; return r; });
  }

  /* ----------------------------------------------------------- compare */

  /* two summaries: the feature types only one has (the thing a reader would not otherwise notice), and the rest side by side */
  function compare(a, b) {
    var ia = {}, ib = {}, names = [];
    a.features.forEach(function (f) { ia[f.feature] = f; names.push(f.feature); });
    b.features.forEach(function (f) { ib[f.feature] = f; if (!ia[f.feature]) names.push(f.feature); });
    return {
      onlyA: a.features.filter(function (f) { return !ib[f.feature]; }).map(function (f) { return f.feature; }),
      onlyB: b.features.filter(function (f) { return !ia[f.feature]; }).map(function (f) { return f.feature; }),
      rows: names.map(function (n) { return { feature: n, a: ia[n] || null, b: ib[n] || null }; }),
      total: { a: { moves: a.moves, lengthMm: a.lengthMm }, b: { moves: b.moves, lengthMm: b.lengthMm } }
    };
  }

  /* ------------------------------------------------------------ report */

  function f1(v) { return v == null ? '-' : (+v).toFixed(1); }
  function f2(v) { return v == null ? '-' : (+v).toFixed(2); }
  function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }
  function lpad(s, n) { s = String(s); while (s.length < n) s = ' ' + s; return s; }

  function report(sum, rows, name) {
    var L = [];
    L.push('G-scope measure' + (name ? ' - ' + name : ''));
    L.push(sum.moves + ' moves, ' + f1(sum.lengthMm) + ' mm, ' + f1(sum.volumeMm3) + ' mm3, ' + sum.layers + ' layers' +
           (sum.zMin == null ? '' : ', Z ' + f2(sum.zMin) + ' - ' + f2(sum.zMax)) + ', avg move ' + f2(sum.avgMoveMm) + ' mm');
    L.push('');
    L.push(pad('feature', 26) + lpad('moves', 7) + lpad('mm', 9) + lpad('Z from', 8) + lpad('Z to', 8));
    sum.features.forEach(function (x) { L.push(pad(x.feature, 26) + lpad(x.moves, 7) + lpad(f1(x.lengthMm), 9) + lpad(f2(x.zMin), 8) + lpad(f2(x.zMax), 8)); });
    if (rows && rows.length) {
      L.push('');
      L.push(pad('Z', 8) + pad('feature', 20) + lpad('runs', 5) + lpad('lines', 6) + lpad('long', 5) + lpad('short', 6) + lpad('mm', 8) + lpad('deg', 5) + lpad('pitch', 7) + lpad('w', 6) + lpad('d', 6) + lpad('corn', 6));
      rows.forEach(function (r) {
        L.push(pad(f2(r.z), 8) + pad(r.feature, 20) + lpad(r.runs, 5) + lpad(r.lines, 6) + lpad(r.longLines, 5) + lpad(r.shortLines, 6) + lpad(f1(r.lengthMm), 8) + lpad(r.domDeg, 5) + lpad(f2(r.pitchMm), 7) + lpad(f1(r.widthMm), 6) + lpad(f1(r.depthMm), 6) + lpad(r.corners, 6));
      });
    }
    return L.join('\n');
  }

  /* -------------------------------------------------------------- reach */

  /* Where a head's support stops, against the overhang it holds up. Bambu's rule (measured on its slice of the six reference heads): the support runs up
     to the TOP layer that has Overhang wall - its last line 0.2 - 0.4 mm under it - and nothing above, because what is printed above that layer has
     something under it. Per head (opts.headOf(move) names it: the object id by default; a caller that knows names joins a part to the objects that
     support it): the overhang wall's Z range, the top of the support family (Support, interface, transition), and gap = overhang top - support top. */
  var SUPPORT_FAMILY = { 'Support': 1, 'Support interface': 1, 'Support transition': 1 };

  function reach(items, opts) {
    var headOf = (opts && opts.headOf) || function (m) { return m.objectId == null ? null : String(m.objectId); };
    var by = {}, order = [];
    movesOf(items).forEach(function (m) {
      var h = headOf(m);
      if (h == null) return;
      var r = by[h];
      if (!r) { r = by[h] = { head: h, overhangZMin: null, overhangTop: null, overhangMoves: 0, overhangMm: 0, supportTop: null, interfaceTop: null, supportMoves: 0 }; order.push(h); }
      var f = featOf(m), z = num(m.z, null);
      if (z == null) return;
      if (f === 'Overhang wall') {
        r.overhangMoves++;
        r.overhangMm += m.x0 != null && m.x1 != null ? Math.hypot(m.x1 - m.x0, m.y1 - m.y0) : num(m.length, 0);
        if (r.overhangTop == null || z > r.overhangTop) r.overhangTop = z;
        if (r.overhangZMin == null || z < r.overhangZMin) r.overhangZMin = z;
      } else if (SUPPORT_FAMILY[f]) {
        r.supportMoves++;
        if (r.supportTop == null || z > r.supportTop) r.supportTop = z;
        if (f === 'Support interface' && (r.interfaceTop == null || z > r.interfaceTop)) r.interfaceTop = z;
      }
    });
    return order.map(function (h) {
      var r = by[h];
      r.overhangMm = Math.round(r.overhangMm * 100) / 100;
      r.gapMm = r.overhangTop != null && r.supportTop != null ? Math.round((r.overhangTop - r.supportTop) * 1000) / 1000 : null;
      return r;
    });
  }

  return { summarize: summarize, layerRows: layerRows, compare: compare, report: report, lineMetrics: lineMetrics, mergeLines: mergeLines, reach: reach };
});
