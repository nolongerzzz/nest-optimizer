/* nso_flange.js - find a flange on a closed triangle soup, and lift it out.

   Loads as a classic script (window.NSO_Flange) and as a Node module
   (require('../nso_flange.js')). No DOM, no Three.js: a mesh is the app's raw
   soup (9 numbers per triangle, Z up, millimetres).

   READ docs/GSCOPE-FLANGE.md FIRST - it has the rule, the numbers it was
   validated on, and what it deliberately does not find.

   ---------------------------------------------------------------------------
   WHY THIS EXISTS
   ---------------------------------------------------------------------------
   G-scope's isolation tabs are whatever the file groups: a slice's FEATURE:
   tags (Outer wall, Sparse infill...) or a mesh's build objects. Those are
   print-process and file-structure categories. A flange is neither - it is a
   functional, geometric part of ONE object - so nothing in the file names it,
   and taking the clamp bar's flange out used to mean cropping it by hand.
   This module names it.

   ---------------------------------------------------------------------------
   THE RULE (a flat, thin, wide protrusion off a thicker body)
   ---------------------------------------------------------------------------
   1. Candidate axes: the directions the surface area actually faces. Face
      normals are clustered (5 deg); a cluster is an axis when it holds >= 3 %
      of the area AND has area facing both ways along it - a slab needs a top
      and a bottom.
   2. Along each axis, rays on a grid of cell size h give every column's solid
      intervals [a, b] (entry/exit by winding, so a shared edge or a seam
      sliver cannot flip the parity - a column that does not close is marked
      bad and left out, never guessed).
   3. Slabs: neighbouring columns join when their intervals overlap and have
      the same thickness and the same two faces (to a tolerance) - so a
      component is a flat, parallel-faced plate of one thickness t.
   4. A slab is a FLANGE when, on its core (columns within 5 % of the median
      thickness t):
        attached   some edges meet a column that is THICKER and contains the
                   slab's depth band - the root. rootLen >= 2 t.
        thin       the body at the root (max thickness within 4 t of the
                   root edge) is >= 2.5 t.
        wide       it sticks out >= 3 t (and >= 4 h) from its root.
        flat       both faces fit a plane to 0.05 t + 0.02 mm RMS.
        straight   the root is a line (RMS <= max(0.75 h, 2 % of rootLen)),
                   because the flange is lifted out by ONE cut on that line.
      Every candidate is kept with the criteria it failed, so "why not" is
      always answerable - see `candidates`.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   detect(soup, opts)          -> { flanges, candidates, axes, cell, badCells, ms }
   extract(soup, flange, cut)  -> { ok, positions, reason, plane } - the flange
                                  as a closed solid: `cut` is app-cut.js's
                                  rawCut(tris, axisIdx, plane, keepMin); the
                                  soup is turned so the root plane is an axis
                                  plane when it is not one already.
   describe(result)            -> one status line
*/
(function (root) {
  'use strict';

  var AXIS_COS = Math.cos(5 * Math.PI / 180);
  var ROOT_CLEAR = 0.002;     // mm the cut stands off the outermost neck wall

  function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]); return l ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; }
  function median(arr) {
    if (!arr.length) return 0;
    var s = arr.slice().sort(function (x, y) { return x - y; });
    var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function bounds(soup) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < soup.length; i++) {
      var k = i % 3;
      if (soup[i] < lo[k]) lo[k] = soup[i];
      if (soup[i] > hi[k]) hi[k] = soup[i];
    }
    return { lo: lo, hi: hi };
  }

  /** Unit normal and area of triangle t. */
  function triNormal(s, t) {
    var o = t * 9;
    var ux = s[o + 3] - s[o], uy = s[o + 4] - s[o + 1], uz = s[o + 5] - s[o + 2];
    var vx = s[o + 6] - s[o], vy = s[o + 7] - s[o + 1], vz = s[o + 8] - s[o + 2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var l = Math.hypot(nx, ny, nz);
    return l ? { n: [nx / l, ny / l, nz / l], area: l / 2 } : null;
  }

  // -------------------------------------------------------------------------
  // 1. Candidate axes
  // -------------------------------------------------------------------------

  function candidateAxes(soup, opts) {
    var n = Math.floor(soup.length / 9);
    var tris = [];
    var total = 0;
    for (var t = 0; t < n; t++) {
      var tn = triNormal(soup, t);
      if (!tn) continue;
      tris.push(tn);
      total += tn.area;
    }
    tris.sort(function (a, b) { return b.area - a.area; });
    var clusters = [];   // { d, sum:[..], plus, minus }
    tris.forEach(function (tn) {
      for (var c = 0; c < clusters.length; c++) {
        var d = dot(tn.n, clusters[c].d);
        if (Math.abs(d) >= AXIS_COS) {
          var sg = d >= 0 ? 1 : -1;
          var cl = clusters[c];
          cl.sum[0] += sg * tn.n[0] * tn.area; cl.sum[1] += sg * tn.n[1] * tn.area; cl.sum[2] += sg * tn.n[2] * tn.area;
          if (sg > 0) cl.plus += tn.area; else cl.minus += tn.area;
          return;
        }
      }
      clusters.push({ d: tn.n.slice(), sum: [tn.n[0] * tn.area, tn.n[1] * tn.area, tn.n[2] * tn.area],
                      plus: tn.area, minus: 0 });
    });
    var minShare = opts.axisShare != null ? opts.axisShare : 0.03;
    return clusters
      .filter(function (c) {
        return (c.plus + c.minus) >= minShare * total &&
               Math.min(c.plus, c.minus) >= 0.01 * total;
      })
      .sort(function (a, b) { return (b.plus + b.minus) - (a.plus + a.minus); })
      .slice(0, opts.maxAxes || 6)
      .map(function (c) {
        var d = norm(c.sum);
        // Canonical sign, so an axis reads the same whichever face came first.
        var big = Math.abs(d[0]) >= Math.abs(d[1]) && Math.abs(d[0]) >= Math.abs(d[2]) ? 0
          : (Math.abs(d[1]) >= Math.abs(d[2]) ? 1 : 2);
        if (d[big] < 0) d = [-d[0], -d[1], -d[2]];
        // Within half a degree of a world axis IS that axis: the mean of a
        // 5-degree cluster is pulled a hair off by the fillets and drafts it
        // swept in (0.06 deg on the clamp bar), and an axis-aligned flange
        // should be cut on an axis plane with no turn at all.
        if (Math.abs(d[big]) > Math.cos(0.5 * Math.PI / 180)) { d = [0, 0, 0]; d[big] = 1; }
        return { d: d, share: (c.plus + c.minus) / total };
      });
  }

  // -------------------------------------------------------------------------
  // 2. Column intervals along one axis
  // -------------------------------------------------------------------------

  function basisFor(d) {
    var ref = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    var u = norm(cross(ref, d));
    var v = cross(d, u);
    // Axis-aligned d gets axis-aligned u, v (so a report reads in X / Y / Z).
    return { u: u, v: v, d: d };
  }

  function columns(soup, B, h) {
    var n = Math.floor(soup.length / 9);
    var P = new Float64Array(n * 9);
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (var i = 0; i < n * 3; i++) {
      var x = soup[i * 3], y = soup[i * 3 + 1], z = soup[i * 3 + 2];
      var pu = B.u[0] * x + B.u[1] * y + B.u[2] * z;
      var pv = B.v[0] * x + B.v[1] * y + B.v[2] * z;
      var pw = B.d[0] * x + B.d[1] * y + B.d[2] * z;
      P[i * 3] = pu; P[i * 3 + 1] = pv; P[i * 3 + 2] = pw;
      if (pu < lo[0]) lo[0] = pu; if (pu > hi[0]) hi[0] = pu;
      if (pv < lo[1]) lo[1] = pv; if (pv > hi[1]) hi[1] = pv;
    }
    // Cell centres sit off every round coordinate, so a ray does not run
    // exactly along an edge a CAD export put on a round number.
    var jit = 0.0137 * h;
    var u0 = lo[0] - h + jit, v0 = lo[1] - h + jit * 1.618;
    var nu = Math.ceil((hi[0] - u0) / h) + 2, nv = Math.ceil((hi[1] - v0) / h) + 2;
    var hitCell = [], hitW = [], hitS = [];
    for (var t = 0; t < n; t++) {
      var o = t * 9;
      var ax = P[o], ay = P[o + 1], aw = P[o + 2];
      var bx = P[o + 3], by = P[o + 4], bw = P[o + 5];
      var cx = P[o + 6], cy = P[o + 7], cw = P[o + 8];
      var den = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(den) < 1e-14) continue;              // edge-on to the ray
      // Signed area in (u, v) is the normal's component along d (u x v = d),
      // so its sign is facing: < 0 faces against the ray, which enters there.
      var s = den < 0 ? 1 : -1;
      var i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - u0) / h - 0.5));
      var i1 = Math.min(nu - 1, Math.floor((Math.max(ax, bx, cx) - u0) / h - 0.5));
      var j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - v0) / h - 0.5));
      var j1 = Math.min(nv - 1, Math.floor((Math.max(ay, by, cy) - v0) / h - 0.5));
      for (var j = j0; j <= j1; j++) {
        var py = v0 + (j + 0.5) * h;
        for (var ii = i0; ii <= i1; ii++) {
          var px = u0 + (ii + 0.5) * h;
          var l1 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / den;
          var l2 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / den;
          var l3 = 1 - l1 - l2;
          if (l1 < 0 || l2 < 0 || l3 < 0) continue;
          hitCell.push(j * nu + ii);
          hitW.push(l1 * aw + l2 * bw + l3 * cw);
          hitS.push(s);
        }
      }
    }
    // Sort the hits by cell, then depth.
    var order = new Uint32Array(hitCell.length);
    for (var k = 0; k < order.length; k++) order[k] = k;
    order.sort(function (p, q) { return hitCell[p] - hitCell[q] || hitW[p] - hitW[q]; });

    var ncell = nu * nv;
    var cellFirst = new Int32Array(ncell).fill(-1), cellN = new Int32Array(ncell);
    var bad = new Uint8Array(ncell);
    var A = [], Bv = [], C = [];
    var badCount = 0;
    var q = 0;
    while (q < order.length) {
      var cell = hitCell[order[q]];
      var e = q;
      while (e < order.length && hitCell[order[e]] === cell) e++;
      // Winding along the ray. Two hits at one depth with one facing are one
      // surface met on a shared edge; count it once.
      var depth = 0, start = 0, ok = true, lastW = -Infinity, lastS = 0;
      var first = A.length;
      for (var r = q; r < e; r++) {
        var w = hitW[order[r]], sg = hitS[order[r]];
        if (sg === lastS && w - lastW < 1e-6) continue;
        lastW = w; lastS = sg;
        var was = depth;
        depth += sg;
        if (depth < 0) { ok = false; break; }
        if (was === 0 && depth > 0) start = w;
        else if (was > 0 && depth === 0 && w - start > 1e-6) {
          A.push(start); Bv.push(w); C.push(cell);
        }
      }
      if (!ok || depth !== 0) {
        A.length = first; Bv.length = first; C.length = first;
        bad[cell] = 1; badCount++;
      } else if (A.length > first) {
        cellFirst[cell] = first; cellN[cell] = A.length - first;
      }
      q = e;
    }
    return { nu: nu, nv: nv, u0: u0, v0: v0, h: h, cellFirst: cellFirst, cellN: cellN, bad: bad,
             badCount: badCount, a: Float64Array.from(A), b: Float64Array.from(Bv), cell: Int32Array.from(C) };
  }

  // -------------------------------------------------------------------------
  // 3 + 4. Slabs, and which of them are flanges
  // -------------------------------------------------------------------------

  var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function overlapping(G, cell, a, b, minOverlap) {
    var out = [];
    var f = G.cellFirst[cell];
    if (f < 0) return out;
    for (var k = f; k < f + G.cellN[cell]; k++) {
      var ov = Math.min(b, G.b[k]) - Math.max(a, G.a[k]);
      if (ov > minOverlap) out.push(k);
    }
    return out;
  }

  function slabsAlong(G, axis, opts) {
    var h = G.h, nn = G.a.length;
    var comp = new Int32Array(nn).fill(-1);
    var comps = [];
    var faceTol = 0.25 * h + 0.01;
    for (var s0 = 0; s0 < nn; s0++) {
      if (comp[s0] >= 0) continue;
      var id = comps.length;
      var members = [s0];
      comp[s0] = id;
      for (var qi = 0; qi < members.length; qi++) {
        var k = members[qi];
        var ck = G.cell[k], ci = ck % G.nu, cj = (ck - ci) / G.nu;
        var tk = G.b[k] - G.a[k];
        for (var di = 0; di < 4; di++) {
          var ni = ci + DIRS[di][0], nj = cj + DIRS[di][1];
          if (ni < 0 || nj < 0 || ni >= G.nu || nj >= G.nv) continue;
          var nc = nj * G.nu + ni;
          var f = G.cellFirst[nc];
          if (f < 0) continue;
          for (var m = f; m < f + G.cellN[nc]; m++) {
            if (comp[m] >= 0) continue;
            var tm = G.b[m] - G.a[m];
            if (Math.abs(tm - tk) > 0.03 + 0.03 * Math.max(tm, tk)) continue;
            if (Math.abs(G.a[m] - G.a[k]) > faceTol || Math.abs(G.b[m] - G.b[k]) > faceTol) continue;
            comp[m] = id;
            members.push(m);
          }
        }
      }
      comps.push(members);
    }
    var minCells = opts.minCells || 12;
    var out = [];
    comps.forEach(function (members, id) {
      if (members.length < minCells) return;
      var c = judge(G, axis, members, id, comp, opts);
      if (c) out.push(c);
    });
    return out;
  }

  /** Least-squares plane w = p0 + p1 u + p2 v; returns the RMS residual. */
  function planeRms(us, vs, ws) {
    var n = ws.length;
    if (n < 3) return 0;
    var su = 0, sv = 0, sw = 0;
    for (var i = 0; i < n; i++) { su += us[i]; sv += vs[i]; sw += ws[i]; }
    su /= n; sv /= n; sw /= n;
    var uu = 0, uv = 0, vv = 0, uw = 0, vw = 0;
    for (i = 0; i < n; i++) {
      var du = us[i] - su, dv = vs[i] - sv, dw = ws[i] - sw;
      uu += du * du; uv += du * dv; vv += dv * dv; uw += du * dw; vw += dv * dw;
    }
    var det = uu * vv - uv * uv;
    var p1 = 0, p2 = 0;
    if (Math.abs(det) > 1e-12) { p1 = (uw * vv - vw * uv) / det; p2 = (vw * uu - uw * uv) / det; }
    var r = 0;
    for (i = 0; i < n; i++) {
      var e = (ws[i] - sw) - p1 * (us[i] - su) - p2 * (vs[i] - sv);
      r += e * e;
    }
    return Math.sqrt(r / n);
  }

  function judge(G, axis, members, id, comp, opts) {
    var h = G.h;
    var ts = members.map(function (k) { return G.b[k] - G.a[k]; });
    var t = median(ts);
    var tol = 0.05 * t + 0.02;
    var core = members.filter(function (k, i) { return Math.abs(ts[i] - t) <= tol; });
    if (core.length < (opts.minCells || 12)) return null;
    var inCore = new Set(core);
    var a = median(core.map(function (k) { return G.a[k]; }));
    var b = median(core.map(function (k) { return G.b[k]; }));

    var us = [], vs = [], wa = [], wb = [];
    var rootPts = [], rootDirs = [], rootThick = [], rootA = [], rootB = [];
    var edgesFree = 0, edgesRoot = 0, edgesRim = 0, edgesBad = 0;
    var maxWalk = Math.ceil(4 * t / h) + 2;
    core.forEach(function (k) {
      var ck = G.cell[k], ci = ck % G.nu, cj = (ck - ci) / G.nu;
      var pu = G.u0 + (ci + 0.5) * h, pv = G.v0 + (cj + 0.5) * h;
      us.push(pu); vs.push(pv); wa.push(G.a[k]); wb.push(G.b[k]);
      for (var di = 0; di < 4; di++) {
        var ni = ci + DIRS[di][0], nj = cj + DIRS[di][1];
        if (ni < 0 || nj < 0 || ni >= G.nu || nj >= G.nv) { edgesFree++; continue; }
        var nc = nj * G.nu + ni;
        if (G.bad[nc]) { edgesBad++; continue; }
        var ov = overlapping(G, nc, G.a[k], G.b[k], 0.1 * t);
        if (!ov.length) { edgesFree++; continue; }
        if (ov.some(function (m) { return inCore.has(m); })) continue;       // interior
        var thick = ov.filter(function (m) {
          var tm = G.b[m] - G.a[m];
          var cover = Math.min(G.b[k], G.b[m]) - Math.max(G.a[k], G.a[m]);
          return tm > t * 1.25 && cover >= 0.8 * (G.b[k] - G.a[k]);
        });
        if (!thick.length) { edgesRim++; continue; }
        edgesRoot++;
        rootA.push(G.a[thick[0]]); rootB.push(G.b[thick[0]]);
        rootPts.push([pu + 0.5 * h * DIRS[di][0], pv + 0.5 * h * DIRS[di][1]]);
        rootDirs.push(DIRS[di]);
        // How thick is the body behind this edge? Walk into it, following
        // the interval that holds the slab's band, for up to 4 t.
        var best = 0, cur = thick[0], wi = ni, wj = nj;
        for (var step = 0; step < maxWalk; step++) {
          var tc = G.b[cur] - G.a[cur];
          if (tc > best) best = tc;
          wi += DIRS[di][0]; wj += DIRS[di][1];
          if (wi < 0 || wj < 0 || wi >= G.nu || wj >= G.nv) break;
          var nx = overlapping(G, wj * G.nu + wi, G.a[k], G.b[k], 0.1 * t);
          if (!nx.length) break;
          cur = nx[0];
        }
        rootThick.push(best);
      }
    });

    var cu = 0, cv = 0;
    for (var ci2 = 0; ci2 < us.length; ci2++) { cu += us[ci2]; cv += vs[ci2]; }
    cu /= us.length; cv /= us.length;
    var cw = (a + b) / 2;
    var cand = {
      centroid: [cu * axis.u[0] + cv * axis.v[0] + cw * axis.d[0],
                 cu * axis.u[1] + cv * axis.v[1] + cw * axis.d[1],
                 cu * axis.u[2] + cv * axis.v[2] + cw * axis.d[2]],
      axis: axis.d.slice(), u: axis.u.slice(), v: axis.v.slice(),
      thickness: t, band: [a, b], cells: core.length, area: core.length * h * h,
      edges: { free: edgesFree, root: edgesRoot, rim: edgesRim, bad: edgesBad },
      rootThickness: median(rootThick),
      flatRms: Math.max(planeRms(us, vs, wa), planeRms(us, vs, wb)),
      reach: 0, rootLen: 0, rootRms: 0, root: null, failed: [], _core: core, _G: G
    };
    if (!rootPts.length) { cand.failed.push('attached'); return cand; }

    // Root line: principal direction of the root edge midpoints.
    var mx = 0, my = 0;
    rootPts.forEach(function (p) { mx += p[0]; my += p[1]; });
    mx /= rootPts.length; my /= rootPts.length;
    var sxx = 0, sxy = 0, syy = 0;
    rootPts.forEach(function (p) { var dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; });
    var ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    var e1 = [Math.cos(ang), Math.sin(ang)], e2 = [-e1[1], e1[0]];
    // e2 points from the flange INTO the body.
    var into = 0;
    rootDirs.forEach(function (d) { into += d[0] * e2[0] + d[1] * e2[1]; });
    if (into < 0) e2 = [-e2[0], -e2[1]];
    var along = rootPts.map(function (p) { return (p[0] - mx) * e1[0] + (p[1] - my) * e1[1]; });
    var off = rootPts.map(function (p) { return (p[0] - mx) * e2[0] + (p[1] - my) * e2[1]; });
    cand.rootLen = Math.max.apply(null, along) - Math.min.apply(null, along) + h;
    cand.rootRms = Math.sqrt(off.reduce(function (s, x) { return s + x * x; }, 0) / off.length);
    var reach = 0, behind = 0;
    for (var i = 0; i < us.length; i++) {
      var dd = -((us[i] - mx) * e2[0] + (vs[i] - my) * e2[1]);
      if (dd > reach) reach = dd;
      if (dd < -h) behind++;
    }
    cand.reach = reach + 0.5 * h;
    cand.behind = behind / us.length;
    cand.root = { point2: [mx, my], along2: e1, into2: e2,
                  span: [Math.min.apply(null, along), Math.max.apply(null, along)],
                  bodyBand: [median(rootA), median(rootB)] };

    if (cand.rootLen < 2 * t) cand.failed.push('attached');
    if (!(cand.rootThickness >= 2.5 * t)) cand.failed.push('thin');
    if (cand.reach < 3 * t || cand.reach < 4 * h) cand.failed.push('wide');
    if (cand.flatRms > tol) cand.failed.push('flat');
    if (cand.rootRms > Math.max(0.75 * h, 0.02 * cand.rootLen) || cand.behind > 0.05) cand.failed.push('straight');
    return cand;
  }

  // -------------------------------------------------------------------------
  // The body behind the root, measured the other way
  // -------------------------------------------------------------------------

  /** Every crossing of the ray O + s D with the soup, as [s, +1 entry | -1 exit], sorted. */
  function rayHits(soup, O, D) {
    var n = Math.floor(soup.length / 9), hits = [];
    for (var t = 0; t < n; t++) {
      var o = t * 9;
      var a0 = [soup[o], soup[o + 1], soup[o + 2]];
      var E1 = [soup[o + 3] - a0[0], soup[o + 4] - a0[1], soup[o + 5] - a0[2]];
      var E2 = [soup[o + 6] - a0[0], soup[o + 7] - a0[1], soup[o + 8] - a0[2]];
      var P = cross(D, E2), det = dot(E1, P);
      if (Math.abs(det) < 1e-12) continue;
      var T = vsub(O, a0), uu = dot(T, P) / det;
      if (uu < 0 || uu > 1) continue;
      var Q = cross(T, E1), vv = dot(D, Q) / det;
      if (vv < 0 || uu + vv > 1) continue;
      var dist = dot(E2, Q) / det;
      if (dist <= 0) continue;
      hits.push([dist, det > 0 ? 1 : -1]);   // det = -D.n: > 0 faces the ray - an entry
    }
    hits.sort(function (x, y) { return x[0] - y[0]; });
    // One surface met on a shared edge is two hits at one distance; count it once.
    var out = [], lastD = -1, lastS = 0;
    hits.forEach(function (hh) {
      if (hh[1] === lastS && hh[0] - lastD < 1e-6) return;
      lastD = hh[0]; lastS = hh[1];
      out.push(hh);
    });
    return out;
  }

  /** Length of the first solid run along a ray, starting outside (inside0 0) or inside (1). */
  function firstRun(hits, inside0) {
    var depth = inside0, start = inside0 ? 0 : null;
    for (var i = 0; i < hits.length; i++) {
      var was = depth;
      depth += hits[i][1];
      if (was === 0 && depth > 0) start = hits[i][0];
      else if (was > 0 && depth === 0) return start === null ? 0 : hits[i][0] - start;
    }
    return 0;
  }

  /**
   * What the flange comes off, measured the other way: from the root, INTO
   * the body, along the flange's own reach direction. Two readings, and
   * either one makes it a flange:
   *
   *   bulk    beside the slab's band (at up to 7 depths across the root
   *           body's own interval): the first solid run. A flange off a
   *           body has body behind it - the clamp bar's is 19 mm.
   *   across  in the slab's band, starting inside it at the root: how far
   *           the slab carries on through the neck. A T or I section's
   *           flange crosses its web into the other wing, so it is a flange
   *           off a web thinner than itself would be.
   *
   * One leg of an L-bracket is neither: its root is the other leg, which is
   * tall along this leg's normal (so it looks attached and thick) but only a
   * plate thickness deep this way, and nothing carries on across the corner.
   *
   * 15 stations along the root; per station the best reading counts, and
   * the upper quartile of the stations is the answer - so holes through the
   * body (the clamp bar's keyholes, a third of its root) do not sink it, and
   * one gusset between two plates does not make a body out of them.
   */
  function bodyDepth(soup, c) {
    var h = c._G.h;
    var e1 = c.root.along2, e2 = c.root.into2, p = c.root.point2;
    var D = norm([e2[0] * c.u[0] + e2[1] * c.v[0], e2[0] * c.u[1] + e2[1] * c.v[1], e2[0] * c.u[2] + e2[1] * c.v[2]]);
    var lo = c.root.bodyBand[0], hi = c.root.bodyBand[1];
    var pad = 0.1 * c.thickness;
    var depths = [];
    for (var k = 0; k < 7; k++) {
      var w = lo + (hi - lo) * (k + 0.5) / 7;
      if (w > c.band[0] - pad && w < c.band[1] + pad) continue;
      depths.push(w);
    }
    var mid = (c.band[0] + c.band[1]) / 2;
    function at(q2, w) {
      return [q2[0] * c.u[0] + q2[1] * c.v[0] + w * c.axis[0],
              q2[0] * c.u[1] + q2[1] * c.v[1] + w * c.axis[1],
              q2[0] * c.u[2] + q2[1] * c.v[2] + w * c.axis[2]];
    }
    var bulk = [], across = [];
    for (var st = 0; st < 15; st++) {
      var al = c.root.span[0] + (c.root.span[1] - c.root.span[0]) * (0.05 + 0.9 * st / 14);
      var base = [p[0] + al * e1[0], p[1] + al * e1[1]];
      // Half a cell out onto the flange side: in air beside the band...
      var q2 = [base[0] - 0.5 * h * e2[0], base[1] - 0.5 * h * e2[1]];
      var best = 0;
      depths.forEach(function (w) { best = Math.max(best, firstRun(rayHits(soup, at(q2, w), D), 0)); });
      bulk.push(best);
      // ...and inside the slab in it, running out through the far side.
      across.push(firstRun(rayHits(soup, at(q2, mid), D), 1) - 0.5 * h);
    }
    function q3(arr) { arr.sort(function (x, y) { return x - y; }); return arr[Math.floor(arr.length * 0.75)]; }
    return { bulk: q3(bulk), across: q3(across) };
  }

  // -------------------------------------------------------------------------
  // Refining the root onto the real neck wall
  // -------------------------------------------------------------------------

  /**
   * The root from the grid is only good to half a cell. Where the body has a
   * wall facing the flange side right there (the neck under or over the
   * slab), that wall IS the root: snap the cut plane onto it.
   */
  function refineRoot(soup, cand) {
    var h = cand._G.h;
    var e2 = cand.root.into2, p = cand.root.point2;
    // 3D directions of the root frame.
    var N = norm([-(e2[0] * cand.u[0] + e2[1] * cand.v[0]),
                  -(e2[0] * cand.u[1] + e2[1] * cand.v[1]),
                  -(e2[0] * cand.u[2] + e2[1] * cand.v[2])]);   // points OUT of the body, toward the flange
    // An axis-aligned root reads as the axis, not as the axis plus 6e-17.
    N = norm(N.map(function (x) { return Math.abs(x) < 1e-12 ? 0 : x; }));
    var off0 = -(p[0] * e2[0] + p[1] * e2[1]);                   // root offset along N (u,v part)
    var n = Math.floor(soup.length / 9);
    var sw = 0, sa = 0, outer = -Infinity;
    for (var t = 0; t < n; t++) {
      var tn = triNormal(soup, t);
      if (!tn || dot(tn.n, N) < AXIS_COS) continue;
      var o = t * 9;
      var c = [(soup[o] + soup[o + 3] + soup[o + 6]) / 3, (soup[o + 1] + soup[o + 4] + soup[o + 7]) / 3,
               (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3];
      var cw = dot(c, cand.axis);
      var offc = dot(c, N);
      // The neck wall is next to the slab's band along the axis, not in it.
      if (cw > cand.band[0] + 0.25 * cand.thickness && cw < cand.band[1] - 0.25 * cand.thickness) continue;
      if (Math.abs(offc - off0) > 1.5 * h) continue;
      sw += offc * tn.area; sa += tn.area;
      if (offc > outer) outer = offc;
    }
    var snapped = sa > 0;
    // The cut goes just past the OUTERMOST piece of neck wall, not through
    // its mean: a wall that steps (the clamp bar's is at y = -1.9987 over
    // most of its length and -2.0103 near a Mirror-Join seam) would otherwise
    // leave a 12 um skin of neck on the flange side, joined to the flange by
    // the cap. 2 um is twenty weld radii - far enough that no wall vertex is
    // snapped onto the cap, and far below anything a printer can see.
    return {
      normal: N,
      wall: snapped ? sw / sa : off0,
      offset: snapped ? outer + ROOT_CLEAR : off0,
      snapped: snapped,
      wallArea: sa,
      wallSpread: snapped ? outer - sw / sa : 0
    };
  }

  // -------------------------------------------------------------------------
  // detect()
  // -------------------------------------------------------------------------

  function detect(soup, opts) {
    opts = opts || {};
    var t0 = Date.now();
    var res = { flanges: [], candidates: [], axes: [], cell: 0, badCells: 0, ms: 0, reason: '' };
    if (!soup || soup.length < 36) { res.reason = 'no geometry'; return res; }
    var bb = bounds(soup);
    var diag = Math.hypot(bb.hi[0] - bb.lo[0], bb.hi[1] - bb.lo[1], bb.hi[2] - bb.lo[2]);
    var h = opts.cell || Math.min(1.0, Math.max(0.15, diag / 500));
    res.cell = h;
    var axes = candidateAxes(soup, opts);
    axes.forEach(function (ax) {
      var B = basisFor(ax.d);
      // Keep one axis grid under ~2M cells whatever the part's size.
      var ext = [0, 0];
      [B.u, B.v].forEach(function (e, i) {
        var lo = Infinity, hi = -Infinity;
        for (var k = 0; k < 8; k++) {
          var c = [k & 1 ? bb.hi[0] : bb.lo[0], k & 2 ? bb.hi[1] : bb.lo[1], k & 4 ? bb.hi[2] : bb.lo[2]];
          var d = dot(c, e);
          if (d < lo) lo = d; if (d > hi) hi = d;
        }
        ext[i] = hi - lo;
      });
      var hAx = Math.max(h, Math.sqrt(ext[0] * ext[1] / 2e6));
      var G = columns(soup, B, hAx);
      res.badCells += G.badCount;
      var cands = slabsAlong(G, B, opts);
      res.axes.push({ d: ax.d, share: ax.share, cell: hAx, columns: G.a.length, bad: G.badCount,
                      slabs: cands.length });
      cands.forEach(function (c) {
        if (!c.failed.length) {
          c.body = bodyDepth(soup, c);
          if (!(c.body.bulk >= 2.5 * c.thickness || c.body.across >= 2.5 * c.thickness)) c.failed.push('body');
        }
        if (!c.failed.length) {
          c.cut = refineRoot(soup, c);
          c.volume = c.area * c.thickness;
          res.flanges.push(c);
        }
        res.candidates.push(c);
      });
    });
    // Rank the rest by how near they came, for the "why not" report.
    res.candidates.sort(function (x, y) { return x.failed.length - y.failed.length || y.area - x.area; });
    res.flanges.sort(function (x, y) { return y.area - x.area; });
    res.candidates.forEach(function (c) { delete c._core; delete c._G; });
    res.ms = Date.now() - t0;
    res.reason = res.flanges.length
      ? res.flanges.length + ' flange' + (res.flanges.length === 1 ? '' : 's')
      : 'no flange: ' + (res.candidates.length
          ? 'the nearest flat plate (' + fmt(res.candidates[0].thickness) + ' mm) ' +
            res.candidates[0].failed.map(function (k) { return WHY[k] || k; }).join(', and ')
          : 'no flat plate of one thickness anywhere');
    return res;
  }

  function fmt(x) { return (Math.round(x * 100) / 100).toString(); }

  /** Each test's failure, in words - what the tab says when there is none. */
  var WHY = {
    attached: 'does not come off anything thicker',
    thin: 'is not thin next to what it comes off',
    wide: 'does not stick out far enough',
    flat: 'is not flat',
    straight: 'meets its body along a curve, not a line',
    body: 'comes off another plate, not a body'
  };

  // -------------------------------------------------------------------------
  // extract(): the flange as its own closed solid
  // -------------------------------------------------------------------------

  /** Rotation taking unit vector `from` onto +axis `to` (0 x, 1 y, 2 z); 3x3 row-major. */
  function rotOnto(from, toIdx) {
    var to = [0, 0, 0]; to[toIdx] = 1;
    var v = cross(from, to), c = dot(from, to), s = Math.hypot(v[0], v[1], v[2]);
    if (s < 1e-12) {
      if (c > 0) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
      // 180 degrees about any axis perpendicular to `to`.
      var p = toIdx === 0 ? [0, 1, 0] : [1, 0, 0];
      return [2 * p[0] * p[0] - 1, 2 * p[0] * p[1], 2 * p[0] * p[2],
              2 * p[1] * p[0], 2 * p[1] * p[1] - 1, 2 * p[1] * p[2],
              2 * p[2] * p[0], 2 * p[2] * p[1], 2 * p[2] * p[2] - 1];
    }
    var k = [v[0] / s, v[1] / s, v[2] / s], C = 1 - c;
    return [c + k[0] * k[0] * C, k[0] * k[1] * C - k[2] * s, k[0] * k[2] * C + k[1] * s,
            k[1] * k[0] * C + k[2] * s, c + k[1] * k[1] * C, k[1] * k[2] * C - k[0] * s,
            k[2] * k[0] * C - k[1] * s, k[2] * k[1] * C + k[0] * s, c + k[2] * k[2] * C];
  }
  function applyRot(R, soup, transpose) {
    var out = new Float32Array(soup.length);
    for (var i = 0; i < soup.length; i += 3) {
      var x = soup[i], y = soup[i + 1], z = soup[i + 2];
      if (!transpose) {
        out[i] = R[0] * x + R[1] * y + R[2] * z; out[i + 1] = R[3] * x + R[4] * y + R[5] * z; out[i + 2] = R[6] * x + R[7] * y + R[8] * z;
      } else {
        out[i] = R[0] * x + R[3] * y + R[6] * z; out[i + 1] = R[1] * x + R[4] * y + R[7] * z; out[i + 2] = R[2] * x + R[5] * y + R[8] * z;
      }
    }
    return out;
  }

  /** Connected components of a soup, by shared (welded) vertices. */
  function components(soup) {
    var n = Math.floor(soup.length / 9);
    var parent = new Int32Array(n);
    for (var i = 0; i < n; i++) parent[i] = i;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    var seen = new Map();
    var q = 1e4;
    for (var t = 0; t < n; t++) {
      for (var k = 0; k < 3; k++) {
        var o = t * 9 + k * 3;
        var key = Math.round(soup[o] * q) + ',' + Math.round(soup[o + 1] * q) + ',' + Math.round(soup[o + 2] * q);
        var prev = seen.get(key);
        if (prev == null) seen.set(key, t);
        else { var ra = find(prev), rb = find(t); if (ra !== rb) parent[ra] = rb; }
      }
    }
    var groups = new Map();
    for (t = 0; t < n; t++) {
      var r = find(t);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(t);
    }
    return Array.from(groups.values());
  }

  /**
   * Lift one detected flange out as a closed solid: one cut on the root plane
   * (the part's own rawCut, so the cap is the one the Cut tool would make),
   * keeping the flange side, and of what is on that side only the pieces that
   * lie in the slab's band - anything else the plane happens to cut off is
   * not the flange and is dropped.
   */
  function extract(soup, flange, cut) {
    if (typeof cut !== 'function') return { ok: false, reason: 'no cut function' };
    if (!flange || !flange.cut) return { ok: false, reason: 'not a detected flange' };
    var N = flange.cut.normal;
    var big = Math.abs(N[0]) >= Math.abs(N[1]) && Math.abs(N[0]) >= Math.abs(N[2]) ? 0
      : (Math.abs(N[1]) >= Math.abs(N[2]) ? 1 : 2);
    var aligned = Math.abs(Math.abs(N[big]) - 1) < 1e-9;
    var R = aligned ? null : rotOnto(N, big);
    var src = R ? applyRot(R, soup, false) : soup;
    var sign = aligned ? (N[big] > 0 ? 1 : -1) : 1;
    var plane = sign * flange.cut.offset;
    // N points toward the flange. rawCut's keepMin keeps coordinate >= plane
    // (the plane becomes that piece's minimum), so it is the flange side
    // exactly when N points up the axis.
    var keepMin = sign > 0;
    var kept;
    try { kept = cut(src, big, plane, keepMin); }
    catch (err) { return { ok: false, reason: 'cut failed: ' + (err && err.message ? err.message : err) }; }
    if (!kept || kept.length < 9) return { ok: false, reason: 'the cut kept nothing on the flange side' };
    var out = R ? applyRot(R, kept, true) : kept;
    // Keep the pieces that are the slab: most of their area inside the band.
    var d = flange.axis, lo = flange.band[0], hi = flange.band[1], pad = 0.1 * flange.thickness + 0.05;
    var keepTris = [], spill = 0;
    components(out).forEach(function (tris) {
      var inside = 0, all = 0, wlo = Infinity, whi = -Infinity;
      tris.forEach(function (t) {
        var o = t * 9;
        for (var k = 0; k < 3; k++) {
          var wv = dot([out[o + k * 3], out[o + k * 3 + 1], out[o + k * 3 + 2]], d);
          if (wv < wlo) wlo = wv; if (wv > whi) whi = wv;
        }
        var tn = triNormal(out, t);
        if (!tn) return;
        var w = (dot([out[o], out[o + 1], out[o + 2]], d) + dot([out[o + 3], out[o + 4], out[o + 5]], d) +
                 dot([out[o + 6], out[o + 7], out[o + 8]], d)) / 3;
        all += tn.area;
        if (w >= lo - pad && w <= hi + pad) inside += tn.area;
      });
      if (!(all > 0 && inside / all >= 0.5)) return;          // not the slab: something else the plane cut off
      // Mostly slab but reaching out of the band: the cut took body with it.
      // Refused rather than handed back as "the flange".
      if (wlo < lo - pad || whi > hi + pad) { spill++; return; }
      keepTris = keepTris.concat(tris);
    });
    if (spill) return { ok: false, reason: 'the cut on the root takes part of the body with the flange' };
    if (!keepTris.length) return { ok: false, reason: 'nothing on the flange side of the root lies in the slab' };
    var pos = new Float32Array(keepTris.length * 9);
    keepTris.forEach(function (t, i) { for (var k = 0; k < 9; k++) pos[i * 9 + k] = out[t * 9 + k]; });
    return { ok: true, positions: pos, plane: { axisIdx: big, offset: plane, turned: !aligned } };
  }

  function describe(res) {
    if (!res) return 'Flange: not run';
    if (!res.flanges.length) return 'Flange: none detected (' + res.reason.replace(/^no flange: /, '') + ')';
    return 'Flange: ' + res.flanges.map(function (f) {
      return fmt(f.thickness) + ' mm thick, ' + fmt(f.reach) + ' mm out, ' + fmt(f.rootLen) + ' mm along its root';
    }).join('; ');
  }

  var api = {
    detect: detect,
    extract: extract,
    describe: describe,
    components: components
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_Flange = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
