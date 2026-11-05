/* nso_weave.js - Weave: cut a patch out of a mesh at its own triangles, clone its surface as a fresh, evenly woven patch, and reattach
   it corner for corner. docs/WEAVE.md.

   Loads as a classic script (window.NSO_Weave) and as a Node module (needs nso_cdt.js). No DOM, no THREE.
   The soup is the app's usual triangle soup (9 numbers a triangle, counter-clockwise from outside).

     NSO_Weave.prepare(soup)              -> M     the welded mesh: corners, neighbours, normals
     NSO_Weave.flood(M, tri, ok) / ball(M, tri, point, r) / grow / shrink  -> mask     selecting (the app's lasso feeds flood)
     NSO_Weave.close(M, mask)             -> { mask, ... }  islands filled, pinches opened, one piece kept
     NSO_Weave.patch(M, mask)             -> { ok, tris, loops, ... }   the puzzle piece, detached
     NSO_Weave.weave(M, patch, opts)      -> { ok, newV, T, ... }       the new patch
     NSO_Weave.apply(soup, plan, mask)    -> { ok, soup }  the old patch out, the new one in
     NSO_Weave.plan(soup, mask, opts)     -> the four above in a row

   THE IDEA. Every corner of a mesh is a place it can be cut. A selection of triangles is cut out along their own edges, like a puzzle
   piece: the piece (the PLATE) and, in the mesh, a hole whose rim is a loop of the mesh's own corners. The new patch is built to fit that
   hole and nothing else:

     - its rim IS the rim: every rim corner is a corner of a new triangle, no rim edge is split, the new triangles run the same way round
       the rim the old ones did - so the join is watertight with no weld, no boolean and nothing to repair;
     - its surface is the plate's, CLONED, not flattened: no plane, no projection direction, no limit on how far the patch curves. With
       fit 'smooth' the WORK on the plate (an engraving, a boss: pieces the creases between neighbouring triangles cut off the face) is
       first bridged - each hole of it filled locally, a thin-plate spline through the face round it - and the cleaned patch is then
       REMESHED on its own surface (split / collapse / flip toward the pitch, corners moved along the surface and put back on it, the rim held).
       fit 'follow' remeshes the plate as it is.

   WHAT IT NEEDS: a plate whose outline is a clean loop of the mesh's corners (close() makes it one), and, to remove work, a lasso whose
   edge falls on clean face round it (work the edge crosses stays as it is, and is counted).

   PAINT SCOPE: NOT APPLICABLE here - this file reads a soup and returns a new one. The app's card carries the paint check (docs/HANDOFF.md). */
(function (root) {
  'use strict';

  var CDT = root && root.NSO_CDT ? root.NSO_CDT : null;
  if (!CDT && typeof module !== 'undefined' && typeof require === 'function') {
    try { CDT = require('./nso_cdt.js'); } catch (e) { CDT = null; }
  }

  var DEFAULTS = {
    fit: 'smooth',     // 'smooth': the work is bridged; 'follow': the plate exactly
    wallDeg: 35,       // neighbouring triangles whose normals differ by more than this are not joined: a wall, a crease
    steepDeg: 55,      // a triangle this far from the mean normal of the selection round it (a box of three `local` cells) is a wall (a filleted lip has no crease)
    local: 1,          // mm: the cell of the box that the face direction is read over (three cells across)
    faceMin: 0.15,     // a piece the creases leave this fraction of the biggest one (by area) is face, not work
    dil: 1,            // rings of triangles the work is widened by (its walls' lips)
    ring: 2.5,         // mm of face round a hole the surface is fitted to
    rimDecay: 1.0,     // mm over which a hole rim's last mismatch dies away inward
    maxNodes: 450000,
    maxTris: 400000
  };

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function unit(a) { var L = Math.hypot(a[0], a[1], a[2]); return L > 1e-300 ? [a[0] / L, a[1] / L, a[2] / L] : null; }
  function refuse(reason, extra) { var r = { ok: false, reason: reason }; for (var k in extra || {}) r[k] = extra[k]; return r; }
  function fmt(x, d) { return (Math.round(x * Math.pow(10, d || 1)) / Math.pow(10, d || 1)).toFixed(d || 1); }

  /* ------------------------------------------------------------ the welded mesh */

  var cache = typeof WeakMap === 'function' ? new WeakMap() : null;

  /* Corners are welded to 0.1 micron. M.nbr[3t + k] is the triangle across edge k of t (corner k to corner k + 1),
     -1 if there is none (an open edge), -2 if three or more triangles share it. */
  function prepare(soup) {
    var hit = cache && cache.get(soup);
    if (hit && hit.len === soup.length) return hit;
    var n = (soup.length / 9) | 0, vid = new Int32Array(3 * n), ids = new Map(), P = [], i, t, k;
    for (i = 0; i < 3 * n; i++) {
      var key = Math.round(soup[3 * i] * 1e4) + ',' + Math.round(soup[3 * i + 1] * 1e4) + ',' + Math.round(soup[3 * i + 2] * 1e4), id = ids.get(key);
      if (id === undefined) { id = P.length / 3; ids.set(key, id); P.push(soup[3 * i], soup[3 * i + 1], soup[3 * i + 2]); }
      vid[i] = id;
    }
    var nV = P.length / 3, Pf = Float64Array.from(P), nrm = new Float64Array(3 * n), area = new Float64Array(n), nbr = new Int32Array(3 * n).fill(-1);
    var he = new Map(), K = nV + 1, degenerate = 0, nonManifold = 0;
    for (t = 0; t < n; t++) {
      var a = vid[3 * t], b = vid[3 * t + 1], c = vid[3 * t + 2];
      var ux = Pf[3 * b] - Pf[3 * a], uy = Pf[3 * b + 1] - Pf[3 * a + 1], uz = Pf[3 * b + 2] - Pf[3 * a + 2];
      var vx = Pf[3 * c] - Pf[3 * a], vy = Pf[3 * c + 1] - Pf[3 * a + 1], vz = Pf[3 * c + 2] - Pf[3 * a + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, L = Math.hypot(nx, ny, nz);
      if (L > 1e-18) { nrm[3 * t] = nx / L; nrm[3 * t + 1] = ny / L; nrm[3 * t + 2] = nz / L; } else degenerate++;
      area[t] = L / 2;
      for (k = 0; k < 3; k++) {
        var e0 = vid[3 * t + k], e1 = vid[3 * t + (k + 1) % 3];
        if (e0 === e1) continue;
        var ek = e0 < e1 ? e0 * K + e1 : e1 * K + e0, o = he.get(ek);
        if (o === undefined) he.set(ek, 3 * t + k);
        else if (o >= 0) { nbr[o] = t; nbr[3 * t + k] = (o / 3) | 0; he.set(ek, -1); }
        else { nbr[3 * t + k] = -2; nonManifold++; }
      }
    }
    // corner -> triangles
    var vstart = new Int32Array(nV + 1);
    for (i = 0; i < 3 * n; i++) vstart[vid[i] + 1]++;
    for (i = 0; i < nV; i++) vstart[i + 1] += vstart[i];
    var fillAt = vstart.slice(0, nV), vlist = new Int32Array(3 * n);
    for (t = 0; t < n; t++) for (k = 0; k < 3; k++) vlist[fillAt[vid[3 * t + k]]++] = t;
    var M = { n: n, nV: nV, vid: vid, P: Pf, nrm: nrm, area: area, nbr: nbr, vstart: vstart, vlist: vlist, len: soup.length, degenerate: degenerate, nonManifold: nonManifold };
    if (cache) cache.set(soup, M);
    return M;
  }
  function centroid(M, t) {
    var a = 3 * M.vid[3 * t], b = 3 * M.vid[3 * t + 1], c = 3 * M.vid[3 * t + 2], P = M.P;
    return [(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3];
  }

  /* ------------------------------------------------------------------ selecting */

  /* The triangles joined to `seed` whose centre stands within r of `point`, `ok(t)` permitting. */
  function flood(M, seed, ok) {
    var mask = new Uint8Array(M.n), q = [seed], qh = 0;
    if (seed < 0 || seed >= M.n || !ok(seed)) return mask;
    mask[seed] = 1;
    while (qh < q.length) {
      var t = q[qh++];
      for (var k = 0; k < 3; k++) {
        var nb = M.nbr[3 * t + k];
        if (nb < 0 || mask[nb] || !ok(nb)) continue;
        mask[nb] = 1; q.push(nb);
      }
    }
    return mask;
  }
  /* opts.axis + opts.minDot: only triangles that face within acos(minDot) of the axis join (so a circle laid on a
     thin finger does not wrap round it). */
  function ball(M, seed, point, r, opts) {
    var r2 = r * r, ax = opts && opts.axis, md = opts && opts.minDot != null ? opts.minDot : -2;
    return flood(M, seed, function (t) {
      if (t === seed) return true;
      if (ax && M.nrm[3 * t] * ax[0] + M.nrm[3 * t + 1] * ax[1] + M.nrm[3 * t + 2] * ax[2] < md) return false;
      var c = centroid(M, t), dx = c[0] - point[0], dy = c[1] - point[1], dz = c[2] - point[2];
      return dx * dx + dy * dy + dz * dz <= r2;
    });
  }
  function count(mask) { var c = 0; for (var i = 0; i < mask.length; i++) if (mask[i]) c++; return c; }
  /* every triangle sharing a corner with the selection joins it, `rings` times */
  function grow(M, mask, rings) {
    var cur = Uint8Array.from(mask);
    for (var r = 0; r < (rings || 1); r++) {
      var vert = new Uint8Array(M.nV), t, k;
      for (t = 0; t < M.n; t++) if (cur[t]) for (k = 0; k < 3; k++) vert[M.vid[3 * t + k]] = 1;
      for (t = 0; t < M.n; t++) if (!cur[t] && (vert[M.vid[3 * t]] || vert[M.vid[3 * t + 1]] || vert[M.vid[3 * t + 2]])) cur[t] = 1;
    }
    return cur;
  }
  /* every selected triangle that shares a corner with an unselected one leaves it, `rings` times */
  function shrink(M, mask, rings) {
    var cur = Uint8Array.from(mask);
    for (var r = 0; r < (rings || 1); r++) {
      var vert = new Uint8Array(M.nV), t, k;
      for (t = 0; t < M.n; t++) if (!cur[t]) for (k = 0; k < 3; k++) vert[M.vid[3 * t + k]] = 1;
      for (t = 0; t < M.n; t++) if (cur[t] && (vert[M.vid[3 * t]] || vert[M.vid[3 * t + 1]] || vert[M.vid[3 * t + 2]])) cur[t] = 0;
    }
    return cur;
  }
  function components(M, mask) {                                // edge-connected pieces of a selection: [[t...], ...]
    var seen = new Uint8Array(M.n), out = [];
    for (var s = 0; s < M.n; s++) {
      if (!mask[s] || seen[s]) continue;
      var comp = [s], qh = 0;
      seen[s] = 1;
      while (qh < comp.length) {
        var t = comp[qh++];
        for (var k = 0; k < 3; k++) { var nb = M.nbr[3 * t + k]; if (nb >= 0 && mask[nb] && !seen[nb]) { seen[nb] = 1; comp.push(nb); } }
      }
      out.push(comp);
    }
    return out;
  }
  /* Make a selection a patch that can be cut out whole (opts.keep: triangles whose holes are to be left as they are):
       - islands: unselected triangles shut in by the selection (a letter's counter, the back wall of a recess)
         join it, if they are small (at most half as many triangles as it has, and 5000) and - when they are more than a
         few dozen triangles and over 2% of it - face the way it does (the rest of a closed piece, its underside, is not a hole);
       - pinches: a corner where the selection's outline touches itself is surrounded by the selection;
       - one piece: of several pieces joined only at a corner, the biggest stays. */
  function close(M, mask, opts) {
    var cur = Uint8Array.from(mask), added = 0, t, k, pass, keep = opts && opts.keep;
    var sel = count(cur), cap = Math.min(5000, Math.max(50, sel >> 1));
    // islands: a region of unselected triangles with the selection all round it. A flood that runs past `cap`
    // (or reaches an open edge, or a region already known to be big) is the rest of the world, and everything it met is marked so.
    var stamp = new Int32Array(M.n), huge = new Uint8Array(M.n), floodId = 0, edge = new Int32Array(M.n), gmean = [0, 0, 0], tt;
    for (tt = 0; tt < M.n; tt++) if (cur[tt]) { gmean[0] += M.area[tt] * M.nrm[3 * tt]; gmean[1] += M.area[tt] * M.nrm[3 * tt + 1]; gmean[2] += M.area[tt] * M.nrm[3 * tt + 2]; }
    var gl = Math.hypot(gmean[0], gmean[1], gmean[2]) || 1;
    gmean = [gmean[0] / gl, gmean[1] / gl, gmean[2] / gl];
    for (t = 0; t < M.n; t++) {
      if (!cur[t]) continue;
      for (k = 0; k < 3; k++) {
        var nb = M.nbr[3 * t + k];
        if (nb < 0 || cur[nb] || huge[nb] || stamp[nb]) continue;
        var comp = [nb], qh = 0, open = false, border = [];
        stamp[nb] = ++floodId;
        while (qh < comp.length) {
          var u = comp[qh++];
          for (var j = 0; j < 3; j++) {
            var w = M.nbr[3 * u + j];
            if (w === -1 || w === -2) { open = true; continue; }       // an open edge: not shut in
            if (cur[w]) { if (edge[w] !== floodId) { edge[w] = floodId; border.push(w); } continue; }
            if (stamp[w] === floodId) continue;
            if (huge[w]) { open = true; continue; }
            stamp[w] = floodId; comp.push(w);
          }
          if (open || comp.length > cap) break;
        }
        if (open || comp.length > cap) { for (var q = 0; q < comp.length; q++) huge[comp[q]] = 1; continue; }
        // a hole in a cut faces the way the cut does (an engraving's floor looks up, its walls sideways); the rest of a closed piece
        // - its underside - looks away, and is not a hole however small it is next to the cut
        // (it must look away by both readings of the way the cut faces - where the island meets it, and over the whole cut - to be
        // the rest of the piece: a curved cut faces many ways, and a lone steep triangle has a noisy neighbourhood)
        var away = 0, awayG = 0, all = 0, mean = [0, 0, 0];
        for (var q7 = 0; q7 < border.length; q7++) { var b7 = border[q7]; mean[0] += M.area[b7] * M.nrm[3 * b7]; mean[1] += M.area[b7] * M.nrm[3 * b7 + 1]; mean[2] += M.area[b7] * M.nrm[3 * b7 + 2]; }
        var ml = Math.hypot(mean[0], mean[1], mean[2]) || 1;
        mean = [mean[0] / ml, mean[1] / ml, mean[2] / ml];
        for (var q5 = 0; q5 < comp.length; q5++) {
          var u5 = comp[q5], a5 = M.area[u5], n0 = M.nrm[3 * u5], n1 = M.nrm[3 * u5 + 1], n2 = M.nrm[3 * u5 + 2];
          all += a5;
          if (n0 * mean[0] + n1 * mean[1] + n2 * mean[2] < -0.3) away += a5;
          if (n0 * gmean[0] + n1 * gmean[1] + n2 * gmean[2] < -0.3) awayG += a5;
        }
        if (awayG < away) away = awayG;
        if (comp.length > Math.max(60, 0.02 * sel) && all > 0 && away > 0.05 * all) { for (var q6 = 0; q6 < comp.length; q6++) huge[comp[q6]] = 1; continue; }
        if (keep) {                                              // a hole the user cut on purpose (opts.keep) stays a hole
          var held = false;
          for (var q3 = 0; q3 < comp.length && !held; q3++) if (keep[comp[q3]]) held = true;
          if (held) { for (var q4 = 0; q4 < comp.length; q4++) huge[comp[q4]] = 1; continue; }
        }
        for (var q2 = 0; q2 < comp.length; q2++) cur[comp[q2]] = 1;
        added += comp.length;
      }
    }
    // pinches
    var pinched = 0;
    for (pass = 0; pass < 12; pass++) {
      var outDeg = new Map(), any = false;
      for (t = 0; t < M.n; t++) {
        if (!cur[t]) continue;
        for (k = 0; k < 3; k++) {
          var nb2 = M.nbr[3 * t + k];
          if (nb2 >= 0 && cur[nb2]) continue;
          var a = M.vid[3 * t + k];
          outDeg.set(a, (outDeg.get(a) || 0) + 1);
        }
      }
      outDeg.forEach(function (d, v) {
        if (d < 2) return;
        any = true; pinched++;
        for (var i = M.vstart[v]; i < M.vstart[v + 1]; i++) { var tt = M.vlist[i]; if (!cur[tt]) { cur[tt] = 1; added++; } }
      });
      if (!any) break;
    }
    // one piece
    var comps = components(M, cur), dropped = 0;
    if (comps.length > 1) {
      comps.sort(function (x, y) { return y.length - x.length; });
      for (var c = 1; c < comps.length; c++) for (var z = 0; z < comps[c].length; z++) { cur[comps[c][z]] = 0; dropped++; }
    }
    return { mask: cur, added: added, pinched: pinched, dropped: dropped, pieces: comps.length, count: count(cur) };
  }

  /* ------------------------------------------------------------ detaching */

  function frameFor(M, tris) {
    var n = [0, 0, 0], i, t, it;
    for (i = 0; i < tris.length; i++) { t = tris[i]; n[0] += M.area[t] * M.nrm[3 * t]; n[1] += M.area[t] * M.nrm[3 * t + 1]; n[2] += M.area[t] * M.nrm[3 * t + 2]; }
    n = unit(n);
    if (!n) return null;
    for (it = 0; it < 3; it++) {                                // the face's own direction: what leans far from it (walls, a crease) does not pull
      var m = [0, 0, 0];
      for (i = 0; i < tris.length; i++) {
        t = tris[i];
        if (M.nrm[3 * t] * n[0] + M.nrm[3 * t + 1] * n[1] + M.nrm[3 * t + 2] * n[2] < 0.7) continue;
        m[0] += M.area[t] * M.nrm[3 * t]; m[1] += M.area[t] * M.nrm[3 * t + 1]; m[2] += M.area[t] * M.nrm[3 * t + 2];
      }
      var mu = unit(m);
      if (!mu) break;
      n = mu;
    }
    var ax = Math.abs(n[0]) <= Math.abs(n[1]) && Math.abs(n[0]) <= Math.abs(n[2]) ? [1, 0, 0] : Math.abs(n[1]) <= Math.abs(n[2]) ? [0, 1, 0] : [0, 0, 1];
    var e1 = unit([ax[0] - dot(ax, n) * n[0], ax[1] - dot(ax, n) * n[1], ax[2] - dot(ax, n) * n[2]]), e2 = cross(n, e1);
    return { n: n, e1: e1, e2: e2 };
  }

  function polyTerms(u, v, deg) {
    var t = [1, u, v];
    if (deg >= 2) t.push(u * u, u * v, v * v);
    if (deg >= 3) t.push(u * u * u, u * u * v, u * v * v, v * v * v);
    return t;
  }
  /* Laplace's (screened, if kappa2 > 0) equation over `free` nodes of the domain, `fixed` nodes holding their value.
     val is read and written; nodes outside `inD` are not neighbours. Successive over-relaxation. */
  function relax(G, inD, free, val, fixedMask, kappa2, iters) {
    var nx = G.nx, ny = G.ny, i, it, w = 1.7;
    for (it = 0; it < iters; it++) {
      var move = 0;
      for (var f = 0; f < free.length; f++) {
        var id = free[f], x = id % nx, y = (id / nx) | 0, s = 0, c = 0;
        if (x + 1 < nx && inD[id + 1]) { s += val[id + 1]; c++; }
        if (x > 0 && inD[id - 1]) { s += val[id - 1]; c++; }
        if (y + 1 < ny && inD[id + nx]) { s += val[id + nx]; c++; }
        if (y > 0 && inD[id - nx]) { s += val[id - nx]; c++; }
        if (!c) continue;
        var nv = s / (c + kappa2), ov = val[id], upd = ov + w * (nv - ov);
        var d = Math.abs(upd - ov);
        if (d > move) move = d;
        val[id] = upd;
      }
      if (move < 2e-6) break;
    }
    void fixedMask; void i;
  }

  function bilinear(G, F, x, y) {                                // F over the grid; NaN nodes are left out of the average
    var fx = (x - G.x0) / G.res, fy = (y - G.y0) / G.res, i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j, sw = 0, sv = 0;
    for (var dj = 0; dj <= 1; dj++) for (var di = 0; di <= 1; di++) {
      var ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= G.nx || jj >= G.ny) continue;
      var v = F[jj * G.nx + ii];
      if (isNaN(v)) continue;
      var w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty);
      sw += w; sv += w * v;
    }
    return sw > 1e-9 ? sv / sw : NaN;
  }

  function median(a) { if (!a.length) return 0; var b = a.slice().sort(function (x, y) { return x - y; }); return b[b.length >> 1]; }

  /* The plate's own triangle size: the median edge length. */
  function plateEdge(M, tris) {
    var L = [], P = M.P;
    for (var i = 0; i < tris.length; i++) {
      var t = tris[i];
      for (var k = 0; k < 3; k++) {
        var a = 3 * M.vid[3 * t + k], b = 3 * M.vid[3 * t + (k + 1) % 3];
        L.push(Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]));
      }
    }
    return median(L);
  }

  /* ----------------------------------------------------------------- detaching */

  /* The outline of a set of triangles: loops of corner ids, the set on the left of each. */
  function boundaryLoops(M, mask) {
    var next = new Map(), bad = 0, nm = 0, edges = 0, t, k, i;
    for (t = 0; t < M.n; t++) {
      if (!mask[t]) continue;
      for (k = 0; k < 3; k++) {
        var nb = M.nbr[3 * t + k], a = M.vid[3 * t + k], b = M.vid[3 * t + (k + 1) % 3];
        if (a === b || (nb >= 0 && mask[nb])) continue;
        if (nb === -2) nm++;
        edges++;
        var l = next.get(a);
        if (l) { l.push(b); bad++; } else next.set(a, [b]);
      }
    }
    if (nm) return { ok: false, reason: 'the cut runs along an edge three triangles share (' + nm + ' of them) - the mesh is not a surface there' };
    if (!edges) return { ok: false, reason: 'the selection is the whole piece - there is no rim to cut along' };
    if (bad) return { ok: false, reason: 'the selection touches itself at ' + bad + ' corner(s) - close it first' };
    var loops = [], seen = new Set(), starts = Array.from(next.keys()).sort(function (x, y) { return x - y; });
    for (i = 0; i < starts.length; i++) {
      var s0 = starts[i];
      if (seen.has(s0)) continue;
      var loop = [], cur = s0, guard = 0;
      do {
        seen.add(cur); loop.push(cur);
        var nx = next.get(cur);
        if (!nx) return { ok: false, reason: 'the outline of the selection does not close' };
        cur = nx[0];
        if (++guard > edges + 2) return { ok: false, reason: 'the outline of the selection does not close' };
      } while (cur !== s0);
      loops.push(loop);
    }
    return { ok: true, loops: loops, edges: edges };
  }

  /* Cut the selection out along its own triangles: the plate. -> { ok, tris (Int32Array), loops (arrays of corner ids,
     the plate on the left of each), area, rimCorners, holes, ... } or a refusal. It needs no direction and no flatness:
     the plate is whatever surface the selection took, curved or grooved. */
  function patch(M, mask) {
    var tris = [], t, i, k;
    for (t = 0; t < M.n; t++) if (mask[t]) tris.push(t);
    if (!tris.length) return refuse('nothing is selected');
    var bl = boundaryLoops(M, mask);
    if (!bl.ok) return refuse(bl.reason);
    var area = 0, openEdges = 0, rimLength = 0, nn = 0;
    for (i = 0; i < tris.length; i++) { area += M.area[tris[i]]; for (k = 0; k < 3; k++) if (M.nbr[3 * tris[i] + k] === -1) openEdges++; }
    bl.loops.forEach(function (L) {
      for (var q = 0; q < L.length; q++) {
        var a = 3 * L[q], b = 3 * L[(q + 1) % L.length];
        rimLength += Math.hypot(M.P[a] - M.P[b], M.P[a + 1] - M.P[b + 1], M.P[a + 2] - M.P[b + 2]);
        nn++;
      }
    });
    return { ok: true, tris: Int32Array.from(tris), mask: mask, loops: bl.loops, area: area, rimLength: rimLength, rimCorners: nn, holes: bl.loops.length - 1, openEdges: openEdges };
  }

  /* ------------------------------------------------------------ finding the work */

  /* The selection cut along its creases: neighbouring triangles whose normals differ by more than o.wallDeg are not joined.
     The big pieces (faceMin of the biggest, by area) are the face; the rest are work - a pit's floor, its walls, a boss, the
     island inside an O. There is no direction in it: it reads the mesh, so it is the same on a curved palm as on a slab.
     -> work (Uint8Array over the mesh) widened o.dil rings, then with its pinches opened (a corner where the face would touch itself). */
  function segment(M, mask, o, keepOut) {
    var cosT = Math.cos(o.wallDeg * Math.PI / 180), label = new Int32Array(M.n).fill(-1), areas = [], t, k, q = [];
    // a wall by the local face direction: a triangle standing more than o.steepDeg from the mean normal of the selection round it (a box of
    // three cells of o.local mm). A filleted lip turns the normal a quarter turn over several triangles, none of them a crease; the wall itself is steep.
    var steep = new Uint8Array(M.n), cosS = Math.cos(o.steepDeg * Math.PI / 180), cell = o.local, sums = new Map(), ckey = new Array(M.n);
    for (t = 0; t < M.n; t++) {
      if (!mask[t]) continue;
      var c0 = centroid(M, t), gx = Math.floor(c0[0] / cell), gy = Math.floor(c0[1] / cell), gz = Math.floor(c0[2] / cell), key0 = gx + ',' + gy + ',' + gz, sv = sums.get(key0);
      ckey[t] = [gx, gy, gz];
      if (!sv) { sv = [0, 0, 0]; sums.set(key0, sv); }
      sv[0] += M.area[t] * M.nrm[3 * t]; sv[1] += M.area[t] * M.nrm[3 * t + 1]; sv[2] += M.area[t] * M.nrm[3 * t + 2];
    }
    for (t = 0; t < M.n; t++) {
      if (!mask[t] || !(M.area[t] > 0)) continue;
      var kk = ckey[t], sx = 0, sy = 0, sz = 0;
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
        var sv2 = sums.get((kk[0] + dx) + ',' + (kk[1] + dy) + ',' + (kk[2] + dz));
        if (sv2) { sx += sv2[0]; sy += sv2[1]; sz += sv2[2]; }
      }
      var sl = Math.hypot(sx, sy, sz);
      if (sl > 0 && (M.nrm[3 * t] * sx + M.nrm[3 * t + 1] * sy + M.nrm[3 * t + 2] * sz) / sl < cosS) steep[t] = 1;
    }
    for (var s0 = 0; s0 < M.n; s0++) {
      if (!mask[s0] || label[s0] >= 0) continue;
      var L = areas.length, a = 0, qh = 0;
      q.length = 0; q.push(s0); label[s0] = L;
      while (qh < q.length) {
        t = q[qh++]; a += M.area[t];
        for (k = 0; k < 3; k++) {
          var nb = M.nbr[3 * t + k];
          if (nb < 0 || !mask[nb] || label[nb] >= 0) continue;
          var d = M.nrm[3 * t] * M.nrm[3 * nb] + M.nrm[3 * t + 1] * M.nrm[3 * nb + 1] + M.nrm[3 * t + 2] * M.nrm[3 * nb + 2];
          if ((d < cosT || steep[t] !== steep[nb]) && M.area[t] > 0 && M.area[nb] > 0) continue;
          label[nb] = L; q.push(nb);
        }
      }
      areas.push(a);
    }
    var biggest = 0;
    areas.forEach(function (a2) { if (a2 > biggest) biggest = a2; });
    // a piece that comes within a ring of the selection's edge is not taken for work: it is a feature the edge crosses, and stays as it is
    var touch = new Uint8Array(areas.length);
    if (keepOut) for (t = 0; t < M.n; t++) if (mask[t] && (keepOut.has(M.vid[3 * t]) || keepOut.has(M.vid[3 * t + 1]) || keepOut.has(M.vid[3 * t + 2]))) touch[label[t]] = 1;
    var work = new Uint8Array(M.n), nPieces = 0, kept = [];
    for (t = 0; t < M.n; t++) if (mask[t] && areas[label[t]] < o.faceMin * biggest) { if (touch[label[t]]) { if (kept.indexOf(label[t]) < 0) kept.push(label[t]); } else work[t] = 1; }
    areas.forEach(function (a2) { if (a2 >= o.faceMin * biggest) nPieces++; });
    function widen() {                                          // every selected triangle sharing a corner with work joins it
      var vert = new Uint8Array(M.nV), tt, kk;
      for (tt = 0; tt < M.n; tt++) if (work[tt]) for (kk = 0; kk < 3; kk++) vert[M.vid[3 * tt + kk]] = 1;
      for (tt = 0; tt < M.n; tt++) if (mask[tt] && !work[tt] && (vert[M.vid[3 * tt]] || vert[M.vid[3 * tt + 1]] || vert[M.vid[3 * tt + 2]])) work[tt] = 1;
    }
    var any = false;
    for (t = 0; t < M.n; t++) if (work[t]) { any = true; break; }
    if (any) for (var d2 = 0; d2 < o.dil; d2++) widen();
    // pinches: a corner where the face's own outline meets itself - take the face triangles round it into the work
    for (var pass = 0; pass < 12 && any; pass++) {
      var outDeg = new Map(), more = false;
      for (t = 0; t < M.n; t++) {
        if (!mask[t] || work[t]) continue;
        for (k = 0; k < 3; k++) {
          var n2 = M.nbr[3 * t + k];
          if (n2 >= 0 && mask[n2] && !work[n2]) continue;
          var v = M.vid[3 * t + k];
          outDeg.set(v, (outDeg.get(v) || 0) + 1);
        }
      }
      outDeg.forEach(function (c, v) {
        if (c < 2) return;
        more = true;
        for (var i = M.vstart[v]; i < M.vstart[v + 1]; i++) { var tt = M.vlist[i]; if (mask[tt]) work[tt] = 1; }
      });
      if (!more) break;
    }
    // specks of face left inside the work (a scan's roughness; the widening ate the neck that joined them): they are work too,
    // unless they come near the edge (a feature the edge crosses)
    if (any) {
      for (var round = 0; round < 3; round++) {
        var fm = new Uint8Array(M.n), changed = false;
        for (t = 0; t < M.n; t++) if (mask[t] && !work[t]) fm[t] = 1;
        components(M, fm).forEach(function (comp) {
          var a2 = 0, near = false;
          comp.forEach(function (tt) { a2 += M.area[tt]; if (keepOut && (keepOut.has(M.vid[3 * tt]) || keepOut.has(M.vid[3 * tt + 1]) || keepOut.has(M.vid[3 * tt + 2]))) near = true; });
          if (a2 < o.faceMin * biggest && !near) { comp.forEach(function (tt) { work[tt] = 1; }); changed = true; }
        });
        if (!changed) break;
      }
    }
    return { work: work, pieces: nPieces, kept: kept.length };
  }

  /* The first few places where the outlines (arrays of [x, y], any loops) cross or touch each other or themselves: [[loop, k], [loop, k]] pairs
     naming the segment k -> k + 1 of each. */
  function loopCrossings(loops2, limit) {
    var segs = [], lo = [Infinity, Infinity], hi = [-Infinity, -Infinity], mean = 0, i, out = [];
    loops2.forEach(function (L, li) {
      for (var q = 0; q < L.length; q++) {
        var a = L[q], b = L[(q + 1) % L.length];
        segs.push({ a: a, b: b, li: li, k: q, m: L.length });
        lo[0] = Math.min(lo[0], a[0]); hi[0] = Math.max(hi[0], a[0]); lo[1] = Math.min(lo[1], a[1]); hi[1] = Math.max(hi[1], a[1]);
        mean += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
    });
    if (!segs.length) return out;
    var cs = Math.max(3 * mean / segs.length, 1e-6), grid = new Map();
    segs.forEach(function (s, si) {
      var x0 = Math.floor((Math.min(s.a[0], s.b[0]) - lo[0]) / cs), x1 = Math.floor((Math.max(s.a[0], s.b[0]) - lo[0]) / cs);
      var y0 = Math.floor((Math.min(s.a[1], s.b[1]) - lo[1]) / cs), y1 = Math.floor((Math.max(s.a[1], s.b[1]) - lo[1]) / cs);
      for (var ix = x0; ix <= x1; ix++) for (var iy = y0; iy <= y1; iy++) { var kk = ix + ',' + iy, l = grid.get(kk); if (l) l.push(si); else grid.set(kk, [si]); }
    });
    function orient(p, q, r) { return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); }
    grid.forEach(function (l) {
      for (var x = 0; x < l.length && out.length < limit; x++) for (var y = x + 1; y < l.length && out.length < limit; y++) {
        var s1 = segs[l[x]], s2 = segs[l[y]];
        if (s1 === s2 || (s1.li === s2.li && (Math.abs(s1.k - s2.k) === 1 || Math.abs(s1.k - s2.k) === s1.m - 1))) continue;
        var o1 = orient(s1.a, s1.b, s2.a), o2 = orient(s1.a, s1.b, s2.b), o3 = orient(s2.a, s2.b, s1.a), o4 = orient(s2.a, s2.b, s1.b);
        if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) out.push([[s1.li, s1.k], [s2.li, s2.k]]);
      }
    });
    void i;
    return out;
  }

  /* ----------------------------------------------------- filling a hole, locally */

  // the heights (along the frame's normal) of some triangles, onto the grid: the face seen from above; NaN where there is none
  function rasterTris(M, tris, fr, G) {
    var H = new Float32Array(G.N).fill(NaN), nx = G.nx, ny = G.ny, res = G.res, x0 = G.x0, y0 = G.y0, i, j, k;
    for (var q = 0; q < tris.length; q++) {
      var t = tris[q], U = [0, 0, 0], Vv = [0, 0, 0], Z = [0, 0, 0];
      for (k = 0; k < 3; k++) {
        var v = M.vid[3 * t + k], w0 = M.P[3 * v] - fr.o[0], w1 = M.P[3 * v + 1] - fr.o[1], w2 = M.P[3 * v + 2] - fr.o[2];
        U[k] = w0 * fr.e1[0] + w1 * fr.e1[1] + w2 * fr.e1[2]; Vv[k] = w0 * fr.e2[0] + w1 * fr.e2[1] + w2 * fr.e2[2]; Z[k] = w0 * fr.n[0] + w1 * fr.n[1] + w2 * fr.n[2];
      }
      var det = (Vv[1] - Vv[2]) * (U[0] - U[2]) + (U[2] - U[1]) * (Vv[0] - Vv[2]);
      if (!(det > 1e-14)) continue;
      var i0 = Math.max(0, Math.ceil((Math.min(U[0], U[1], U[2]) - x0) / res - 1e-9)), i1 = Math.min(nx - 1, Math.floor((Math.max(U[0], U[1], U[2]) - x0) / res + 1e-9));
      var j0 = Math.max(0, Math.ceil((Math.min(Vv[0], Vv[1], Vv[2]) - y0) / res - 1e-9)), j1 = Math.min(ny - 1, Math.floor((Math.max(Vv[0], Vv[1], Vv[2]) - y0) / res + 1e-9));
      for (j = j0; j <= j1; j++) for (i = i0; i <= i1; i++) {
        var x = x0 + i * res, y = y0 + j * res;
        var l1 = ((Vv[1] - Vv[2]) * (x - U[2]) + (U[2] - U[1]) * (y - Vv[2])) / det, l2 = ((Vv[2] - Vv[0]) * (x - U[2]) + (U[0] - U[2]) * (y - Vv[2])) / det, l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
        var z = l1 * Z[0] + l2 * Z[1] + l3 * Z[2], id = j * nx + i;
        if (!(H[id] >= z)) H[id] = z;
      }
    }
    return H;
  }
  // the nodes inside the loops (even-odd over every loop)
  function domainOf(G, loops2) {
    var D = new Uint8Array(G.N), nx = G.nx, res = G.res;
    for (var j = 0; j < G.ny; j++) {
      var yy = G.y0 + j * res + 1e-7, xs = [];
      loops2.forEach(function (L) {
        for (var a = 0, b = L.length - 1; a < L.length; b = a++) {
          var pa = L[a], pb = L[b];
          if ((pa[1] > yy) !== (pb[1] > yy)) xs.push((pb[0] - pa[0]) * (yy - pa[1]) / (pb[1] - pa[1]) + pa[0]);
        }
      });
      xs.sort(function (p, r) { return p - r; });
      for (var s = 0; s + 1 < xs.length; s += 2) {
        var ia = Math.max(0, Math.ceil((xs[s] - G.x0) / res)), ib = Math.min(nx - 1, Math.floor((xs[s + 1] - G.x0) / res));
        for (var i = ia; i <= ib; i++) D[j * nx + i] = 1;
      }
    }
    return D;
  }

  /* The face carried across a hole D: a quadratic fitted by moving least squares to the face round each node of a coarse
     lattice over the hole and its ring (the reach grows with the distance to the nearest face), bilinear between; the small
     mismatch between it and the real face at the hole's edge spread inward by Laplace's equation, so there is no step.
     -> { ok, S (heights; NaN far from it), fitted } or a refusal. */
  function carryAcross(G, H, D, o) {
    var N = G.N, nx = G.nx, ny = G.ny, res = G.res, id, i, valid = new Uint8Array(N), face = new Uint8Array(N);
    for (id = 0; id < N; id++) if (!isNaN(H[id])) { valid[id] = 1; if (!D[id]) face[id] = 1; }
    var S = new Float64Array(N).fill(NaN);
    for (id = 0; id < N; id++) if (face[id]) S[id] = H[id];
    var dw = new Int32Array(N).fill(-1), fq = [], fh = 0, ringN = Math.max(6, Math.round(o.ring / res));
    function nbs(c) { var x = c % nx, y = (c / nx) | 0; return [x + 1 < nx ? c + 1 : -1, x > 0 ? c - 1 : -1, y + 1 < ny ? c + nx : -1, y > 0 ? c - nx : -1]; }
    for (id = 0; id < N; id++) if (D[id]) { dw[id] = 0; fq.push(id); }
    while (fh < fq.length) {                                    // steps from the hole, out through the face: the ring
      var c5 = fq[fh++];
      if (dw[c5] >= ringN) continue;
      var n5 = nbs(c5);
      for (var q5 = 0; q5 < 4; q5++) { var m5 = n5[q5]; if (m5 < 0 || dw[m5] >= 0 || !valid[m5]) continue; dw[m5] = dw[c5] + 1; fq.push(m5); }
    }
    // a thin-plate spline through the ring of face (a smoothed one: scan noise is not interpolated), evaluated over the hole. It
    // minimises bending, so a dome, a saddle or a groove goes on across the gap the way the face round it says.
    var smp = [], stride = 1;
    for (id = 0; id < N; id++) if (face[id] && dw[id] > 0) smp.push(id);
    if (smp.length < 14) return refuse('there is no face left round the work in this selection - make the lasso larger, so its edge falls on clean face');
    var maxS = 520;
    if (smp.length > maxS) {                                    // spread over the ring, nearer the hole first: a stride over the nodes, offset by distance
      stride = Math.ceil(smp.length / maxS);
      var keepS = [];
      for (var si = 0; si < smp.length; si += stride) keepS.push(smp[si]);
      smp = keepS;
    }
    var ns = smp.length, sxs = new Float64Array(ns), sys = new Float64Array(ns), szs = new Float64Array(ns), mx0 = 0, my0 = 0, sc = 0;
    for (i = 0; i < ns; i++) { sxs[i] = G.x0 + (smp[i] % nx) * res; sys[i] = G.y0 + ((smp[i] / nx) | 0) * res; szs[i] = H[smp[i]]; mx0 += sxs[i]; my0 += sys[i]; }
    mx0 /= ns; my0 /= ns;
    for (i = 0; i < ns; i++) sc = Math.max(sc, Math.hypot(sxs[i] - mx0, sys[i] - my0));
    sc = sc || 1;
    var zmean = 0;
    for (i = 0; i < ns; i++) zmean += szs[i];
    zmean /= ns;
    var nn = ns + 3, A = new Float64Array(nn * nn), rhs = new Float64Array(nn);
    function phi(r2) { return r2 > 1e-18 ? 0.5 * r2 * Math.log(r2) : 0; }
    for (i = 0; i < ns; i++) {
      for (var j2 = 0; j2 < ns; j2++) { var dx = (sxs[i] - sxs[j2]) / sc, dy = (sys[i] - sys[j2]) / sc; A[i * nn + j2] = phi(dx * dx + dy * dy); }
      A[i * nn + i] += 1e-5;
      A[i * nn + ns] = 1; A[i * nn + ns + 1] = (sxs[i] - mx0) / sc; A[i * nn + ns + 2] = (sys[i] - my0) / sc;
      A[ns * nn + i] = 1; A[(ns + 1) * nn + i] = (sxs[i] - mx0) / sc; A[(ns + 2) * nn + i] = (sys[i] - my0) / sc;
      rhs[i] = szs[i] - zmean;
    }
    for (var p = 0; p < nn; p++) {                              // Gauss elimination with partial pivoting
      var piv = p;
      for (var r = p + 1; r < nn; r++) if (Math.abs(A[r * nn + p]) > Math.abs(A[piv * nn + p])) piv = r;
      if (Math.abs(A[piv * nn + p]) < 1e-14) return refuse('the face round the work could not be fitted - make the lasso larger');
      if (piv !== p) { for (var c = 0; c < nn; c++) { var tmpv = A[p * nn + c]; A[p * nn + c] = A[piv * nn + c]; A[piv * nn + c] = tmpv; } var tr = rhs[p]; rhs[p] = rhs[piv]; rhs[piv] = tr; }
      for (var r2 = p + 1; r2 < nn; r2++) {
        var f = A[r2 * nn + p] / A[p * nn + p];
        if (f === 0) continue;
        for (var c2 = p; c2 < nn; c2++) A[r2 * nn + c2] -= f * A[p * nn + c2];
        rhs[r2] -= f * rhs[p];
      }
    }
    var wts = new Float64Array(nn);
    for (var q = nn - 1; q >= 0; q--) { var acc = rhs[q]; for (var c3 = q + 1; c3 < nn; c3++) acc -= A[q * nn + c3] * wts[c3]; wts[q] = acc / A[q * nn + q]; }
    var fitted = ns;
    for (id = 0; id < N; id++) {
      if (!D[id]) continue;
      var xq = G.x0 + (id % nx) * res, yq = G.y0 + ((id / nx) | 0) * res, zq = wts[ns] + wts[ns + 1] * (xq - mx0) / sc + wts[ns + 2] * (yq - my0) / sc;
      for (i = 0; i < ns; i++) { var ex = (xq - sxs[i]) / sc, ey = (yq - sys[i]) / sc; zq += wts[i] * phi(ex * ex + ey * ey); }
      S[id] = zq + zmean;
    }
    for (var e = 0; e < 3; e++) {                               // a little beyond, so a corner at the rim has four nodes round it
      var fillList = [];
      for (id = 0; id < N; id++) {
        if (!isNaN(S[id])) continue;
        var n6 = nbs(id), s6 = 0, c6n = 0;
        for (var q6 = 0; q6 < 4; q6++) if (n6[q6] >= 0 && !isNaN(S[n6[q6]])) { s6 += S[n6[q6]]; c6n++; }
        if (c6n) fillList.push([id, s6 / c6n]);
      }
      fillList.forEach(function (p) { S[p[0]] = p[1]; });
    }
    return { ok: true, S: S, fitted: fitted };
  }

  /* One hole of work, filled: the triangles that stand where the work stood, on the rim of the hole (its corners are the mesh's
     own), their inside woven fresh on the surface the face carries across. The hole is small and the face round it is what it is
     fitted to, so a local height field along the face's own direction is enough here, however the whole patch curves.
     -> { ok, T (ids < M.nV are the mesh's, M.nV + i the new corner i), newV, depth } or a refusal. */
  function fillClusterOnce(M, tris, workAll, o, pitch) {
    var ck = new Uint8Array(M.n), i, t, k;
    tris.forEach(function (x) { ck[x] = 1; });
    var bl = boundaryLoops(M, ck);
    if (!bl.ok) return refuse(bl.reason);
    // the face round it: rings of triangles out from the hole's corners, up to o.ring mm
    var rings = Math.max(4, Math.min(60, Math.ceil(o.ring / Math.max(pitch, 1e-3)) + 2)), seenT = new Uint8Array(M.n), seenV = new Uint8Array(M.nV), data = [], front = [];
    bl.loops.forEach(function (L) { L.forEach(function (v) { if (!seenV[v]) { seenV[v] = 1; front.push(v); } }); });
    var ref = null;                                             // the way the face faces at the hole: the first ring's mean normal; what turns far from it (a side, an underside) is not this face
    for (var r = 0; r < rings; r++) {
      var nextF = [];
      front.forEach(function (v) {
        for (var a = M.vstart[v]; a < M.vstart[v + 1]; a++) {
          var u = M.vlist[a];
          if (seenT[u] || ck[u] || workAll[u]) continue;
          if (ref && M.nrm[3 * u] * ref[0] + M.nrm[3 * u + 1] * ref[1] + M.nrm[3 * u + 2] * ref[2] < 0.5) continue;
          seenT[u] = 1; data.push(u);
          for (var c = 0; c < 3; c++) { var w = M.vid[3 * u + c]; if (!seenV[w]) { seenV[w] = 1; nextF.push(w); } }
        }
      });
      if (r === 0) {
        var m0 = [0, 0, 0];
        data.forEach(function (u) { m0[0] += M.area[u] * M.nrm[3 * u]; m0[1] += M.area[u] * M.nrm[3 * u + 1]; m0[2] += M.area[u] * M.nrm[3 * u + 2]; });
        ref = unit(m0);
      }
      front = nextF;
    }
    if (data.length < 8) return refuse('there is no face left round the work in this selection - make the lasso larger, so its edge falls on clean face');
    var fr = frameFor(M, data);
    if (!fr) return refuse('the face round the work has no direction');
    var o3 = [0, 0, 0], nn = 0;
    bl.loops.forEach(function (L) { L.forEach(function (v) { o3[0] += M.P[3 * v]; o3[1] += M.P[3 * v + 1]; o3[2] += M.P[3 * v + 2]; nn++; }); });
    fr.o = [o3[0] / nn, o3[1] / nn, o3[2] / nn];
    function proj(v) {
      var w0 = M.P[3 * v] - fr.o[0], w1 = M.P[3 * v + 1] - fr.o[1], w2 = M.P[3 * v + 2] - fr.o[2];
      return [w0 * fr.e1[0] + w1 * fr.e1[1] + w2 * fr.e1[2], w0 * fr.e2[0] + w1 * fr.e2[1] + w2 * fr.e2[2], w0 * fr.n[0] + w1 * fr.n[1] + w2 * fr.n[2]];
    }
    var loops2 = bl.loops.map(function (L) { return L.map(function (v) { var p = proj(v); return [p[0], p[1]]; }); });
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    loops2.forEach(function (L) { L.forEach(function (p) { lo[0] = Math.min(lo[0], p[0]); hi[0] = Math.max(hi[0], p[0]); lo[1] = Math.min(lo[1], p[1]); hi[1] = Math.max(hi[1], p[1]); }); });
    var res = Math.min(0.12, Math.max(0.04, pitch / 3)), pad = o.ring + 0.5;
    while (((hi[0] - lo[0] + 2 * pad) / res + 2) * ((hi[1] - lo[1] + 2 * pad) / res + 2) > o.maxNodes) res *= 1.25;
    var G = { x0: lo[0] - pad, y0: lo[1] - pad, nx: Math.ceil((hi[0] - lo[0] + 2 * pad) / res) + 1, ny: Math.ceil((hi[1] - lo[1] + 2 * pad) / res) + 1, res: res };
    G.N = G.nx * G.ny;
    var H = rasterTris(M, data, fr, G), D = domainOf(G, loops2);
    var cr = carryAcross(G, H, D, o);
    if (!cr.ok) return cr;
    // the last mismatch with the rim's own corners, carried inward over rimDecay
    var N = G.N, delta = new Float64Array(N), cnt = new Float64Array(N), fixedIds = [], rimIds = [], rimZ = [], rimUV = [];
    bl.loops.forEach(function (L) { L.forEach(function (v) { var p = proj(v); rimIds.push(v); rimUV.push([p[0], p[1]]); rimZ.push(p[2]); }); });
    for (i = 0; i < rimIds.length; i++) {
      var s0 = bilinear(G, cr.S, rimUV[i][0], rimUV[i][1]);
      if (isNaN(s0)) continue;
      var nid = Math.round((rimUV[i][1] - G.y0) / res) * G.nx + Math.round((rimUV[i][0] - G.x0) / res);
      if (nid < 0 || nid >= N) continue;
      if (!cnt[nid]) fixedIds.push(nid);
      delta[nid] += rimZ[i] - s0; cnt[nid]++;
    }
    var C = new Float64Array(N), inDom = new Uint8Array(N), isFixed = new Uint8Array(N), free = [];
    for (i = 0; i < N; i++) if (!isNaN(cr.S[i])) inDom[i] = 1;
    fixedIds.forEach(function (id) { C[id] = delta[id] / cnt[id]; isFixed[id] = 1; });
    for (i = 0; i < N; i++) if (inDom[i] && !isFixed[i]) free.push(i);
    relax(G, inDom, free, C, isFixed, Math.pow(res / o.rimDecay, 2), 2500);
    var cross = loopCrossings(loops2, 6);
    if (cross.length) {                                         // the outline folds over itself in the plane: it runs down a wall somewhere, where some of the work was taken for face
      var ids = [];
      cross.forEach(function (c) { c.forEach(function (sg) { var L = bl.loops[sg[0]]; ids.push(L[sg[1]], L[(sg[1] + 1) % L.length]); }); });
      return refuse('a hole of work folds over itself when laid flat - the work is too tangled with a steep wall here', { cross: ids });
    }
    var fill = CDT.fill(loops2, { pitch: pitch, maxTris: o.maxTris });
    if (!fill.ok) return refuse('a hole of work could not be filled: ' + fill.reason, { tooMany: !!fill.tooMany });
    if (fill.flat || Math.abs(fill.areaGot - fill.areaWant) > 0.01 * Math.max(Math.abs(fill.areaWant), 1e-6)) return refuse('a hole of work folds over itself when laid flat (its filled area is ' + fmt(fill.areaGot, 2) + ' mm2 against its outline\'s ' + fmt(fill.areaWant, 2) + ') - the work is too tangled with a steep wall here; use Follow, or a lasso that leaves it out');
    var nNew = fill.P.length - fill.nRim, newV = new Float64Array(3 * nNew);
    for (i = 0; i < nNew; i++) {
      var u = fill.P[fill.nRim + i][0], v = fill.P[fill.nRim + i][1], z = bilinear(G, cr.S, u, v), c = bilinear(G, C, u, v);
      if (isNaN(z)) return refuse('a hole of work has corners with no surface under them');
      if (!isNaN(c)) z += c;
      newV[3 * i] = fr.o[0] + u * fr.e1[0] + v * fr.e2[0] + z * fr.n[0];
      newV[3 * i + 1] = fr.o[1] + u * fr.e1[1] + v * fr.e2[1] + z * fr.n[1];
      newV[3 * i + 2] = fr.o[2] + u * fr.e1[2] + v * fr.e2[2] + z * fr.n[2];
    }
    var T = new Int32Array(fill.T.length);
    for (i = 0; i < T.length; i++) T[i] = fill.T[i] < fill.nRim ? rimIds[fill.T[i]] : M.nV + (fill.T[i] - fill.nRim);
    // a chord of the fill between two rim corners that the mesh already joins by an edge would leave three triangles on it: split it
    var loopEdge = new Set();
    bl.loops.forEach(function (L) { for (var q = 0; q < L.length; q++) { var a = L[q], b = L[(q + 1) % L.length]; loopEdge.add(a < b ? a * (M.nV + 1) + b : b * (M.nV + 1) + a); } });
    function joined(u, v) { for (var a = M.vstart[u]; a < M.vstart[u + 1]; a++) { var tq = M.vlist[a]; if (M.vid[3 * tq] === v || M.vid[3 * tq + 1] === v || M.vid[3 * tq + 2] === v) return true; } return false; }
    var fe = new Map(), chords = [];
    for (i = 0; i < T.length; i += 3) for (k = 0; k < 3; k++) {
      var u = T[i + k], v = T[i + (k + 1) % 3];
      if (u >= M.nV || v >= M.nV) continue;
      var key = u < v ? u * (M.nV + 1) + v : v * (M.nV + 1) + u;
      if (loopEdge.has(key)) continue;
      var rec = fe.get(key);
      if (rec) rec.push(i / 3); else fe.set(key, [i / 3]);
    }
    fe.forEach(function (tr, key) { var u2 = Math.floor(key / (M.nV + 1)), v2 = key % (M.nV + 1); if (tr.length === 2 && joined(u2, v2)) chords.push([u2, v2, tr[0], tr[1]]); });
    if (chords.length) {
      var Tl = Array.from(T), nvl = newV.length / 3, extraV = Array.from(newV), dead = new Set();
      chords.forEach(function (ch) {
        var u3 = ch[0], v3 = ch[1], m = M.nV + nvl++;
        extraV.push((M.P[3 * u3] + M.P[3 * v3]) / 2, (M.P[3 * u3 + 1] + M.P[3 * v3 + 1]) / 2, (M.P[3 * u3 + 2] + M.P[3 * v3 + 2]) / 2);
        [ch[2], ch[3]].forEach(function (tq) {
          var tv = [Tl[3 * tq], Tl[3 * tq + 1], Tl[3 * tq + 2]], j;
          for (j = 0; j < 3; j++) if ((tv[j] === u3 && tv[(j + 1) % 3] === v3) || (tv[j] === v3 && tv[(j + 1) % 3] === u3)) break;
          var a2 = tv[j], b2 = tv[(j + 1) % 3], w = tv[(j + 2) % 3];
          dead.add(tq);
          Tl.push(a2, m, w, m, b2, w);
        });
      });
      var Tn = [];
      for (i = 0; i < Tl.length; i += 3) if (!dead.has(i / 3)) Tn.push(Tl[i], Tl[i + 1], Tl[i + 2]);
      T = Int32Array.from(Tn); newV = Float64Array.from(extraV);
    }
    // how deep the work was: its corners against the surface that replaces it
    var depth = 0, seenW = new Uint8Array(M.nV);
    tris.forEach(function (tq) {
      for (var c2 = 0; c2 < 3; c2++) {
        var v2 = M.vid[3 * tq + c2];
        if (seenW[v2]) continue;
        seenW[v2] = 1;
        var p = proj(v2), sS = bilinear(G, cr.S, p[0], p[1]), cC = bilinear(G, C, p[0], p[1]);
        if (!isNaN(sS)) depth = Math.max(depth, Math.abs(p[2] - sS - (isNaN(cC) ? 0 : cC)));
      }
    });
    void t; void k;
    return { ok: true, T: T, newV: newV, depth: depth, nTris: T.length / 3 };
  }

  /* fillClusterOnce, and where the outline of the hole folds over itself the work is grown round the fold - the triangles within three rings of
     it that were taken for face - and the hole tried again, up to eight times. */
  function fillCluster(M, tris, workAll, o, pitch) {
    var list = tris.slice(), grown = [], attempt;
    for (attempt = 0; attempt < 8; attempt++) {
      var r = fillClusterOnce(M, list, workAll, o, pitch);
      if (r.ok) { r.tris = list; return r; }
      if (!r.cross) { grown.forEach(function (tq) { workAll[tq] = 0; }); return r; }
      var front = r.cross.slice(), seenV = new Set(front), added = 0;
      for (var ring = 0; ring < 3; ring++) {
        var next = [];
        front.forEach(function (v) {
          for (var a = M.vstart[v]; a < M.vstart[v + 1]; a++) {
            var u = M.vlist[a];
            if (workAll[u] || !o.mask || !o.mask[u]) continue;
            if (o.keepOut && (o.keepOut.has(M.vid[3 * u]) || o.keepOut.has(M.vid[3 * u + 1]) || o.keepOut.has(M.vid[3 * u + 2]))) continue;
            workAll[u] = 1; list.push(u); grown.push(u); added++;
            for (var c = 0; c < 3; c++) { var w = M.vid[3 * u + c]; if (!seenV.has(w)) { seenV.add(w); next.push(w); } }
          }
        });
        front = next;
      }
      if (!added) break;
    }
    grown.forEach(function (tq) { workAll[tq] = 0; });
    return refuse('a hole of work folds over itself when laid flat (its outline crosses itself even grown round the fold) - the work is too tangled with a steep wall here');
  }

  /* ------------------------------------------------------------ remeshing on the surface */

  /* The nearest point on a fixed set of triangles, by a grid over them. P: corner positions (3 each), T: triangles. */
  function surfaceIndex(P, T) {
    var nt = T.length / 3, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], i, t, k, mean = 0;
    for (i = 0; i < P.length; i += 3) for (k = 0; k < 3; k++) { if (P[i + k] < lo[k]) lo[k] = P[i + k]; if (P[i + k] > hi[k]) hi[k] = P[i + k]; }
    for (t = 0; t < nt; t++) { var a = 3 * T[3 * t], b = 3 * T[3 * t + 1]; mean += Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1], P[a + 2] - P[b + 2]); }
    var cell = Math.max(2.5 * mean / Math.max(nt, 1), 1e-6), dim = [0, 0, 0];
    for (;;) {
      for (k = 0; k < 3; k++) dim[k] = Math.floor((hi[k] - lo[k]) / cell) + 1;
      if (dim[0] * dim[1] * dim[2] <= 4e6) break;
      cell *= 1.4;
    }
    var counts = new Int32Array(dim[0] * dim[1] * dim[2] + 1);
    function range(tq, out) {
      var vs = [3 * T[3 * tq], 3 * T[3 * tq + 1], 3 * T[3 * tq + 2]];
      for (var kk = 0; kk < 3; kk++) {
        var mn = Math.min(P[vs[0] + kk], P[vs[1] + kk], P[vs[2] + kk]), mx = Math.max(P[vs[0] + kk], P[vs[1] + kk], P[vs[2] + kk]);
        out[kk] = Math.floor((mn - lo[kk]) / cell); out[kk + 3] = Math.floor((mx - lo[kk]) / cell);
      }
    }
    var r = [0, 0, 0, 0, 0, 0], x, y, z;
    for (t = 0; t < nt; t++) { range(t, r); for (z = r[2]; z <= r[5]; z++) for (y = r[1]; y <= r[4]; y++) for (x = r[0]; x <= r[3]; x++) counts[(z * dim[1] + y) * dim[0] + x + 1]++; }
    for (i = 0; i < dim[0] * dim[1] * dim[2]; i++) counts[i + 1] += counts[i];
    var fillAt = counts.slice(0, dim[0] * dim[1] * dim[2]), list = new Int32Array(counts[dim[0] * dim[1] * dim[2]]);
    for (t = 0; t < nt; t++) { range(t, r); for (z = r[2]; z <= r[5]; z++) for (y = r[1]; y <= r[4]; y++) for (x = r[0]; x <= r[3]; x++) list[fillAt[(z * dim[1] + y) * dim[0] + x]++] = t; }
    var best = [0, 0, 0];
    function closestOn(tq, qx, qy, qz, out) {                   // Ericson's closest point on a triangle
      var a = 3 * T[3 * tq], b = 3 * T[3 * tq + 1], c = 3 * T[3 * tq + 2];
      var ax = P[a], ay = P[a + 1], az = P[a + 2], abx = P[b] - ax, aby = P[b + 1] - ay, abz = P[b + 2] - az, acx = P[c] - ax, acy = P[c + 1] - ay, acz = P[c + 2] - az;
      var apx = qx - ax, apy = qy - ay, apz = qz - az, d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
      if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return; }
      var bpx = qx - P[b], bpy = qy - P[b + 1], bpz = qz - P[b + 2], d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) { out[0] = P[b]; out[1] = P[b + 1]; out[2] = P[b + 2]; return; }
      var vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { var v = d1 / (d1 - d3); out[0] = ax + v * abx; out[1] = ay + v * aby; out[2] = az + v * abz; return; }
      var cpx = qx - P[c], cpy = qy - P[c + 1], cpz = qz - P[c + 2], d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
      if (d6 >= 0 && d5 <= d6) { out[0] = P[c]; out[1] = P[c + 1]; out[2] = P[c + 2]; return; }
      var vb = d5 * d2 - d1 * d6;
      if (vb <= 0 && d2 >= 0 && d6 <= 0) { var w = d2 / (d2 - d6); out[0] = ax + w * acx; out[1] = ay + w * acy; out[2] = az + w * acz; return; }
      var va = d3 * d6 - d5 * d4;
      if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { var w2 = (d4 - d3) / ((d4 - d3) + (d5 - d6)); out[0] = P[b] + w2 * (P[c] - P[b]); out[1] = P[b + 1] + w2 * (P[c + 1] - P[b + 1]); out[2] = P[b + 2] + w2 * (P[c + 2] - P[b + 2]); return; }
      var den = 1 / (va + vb + vc), v2 = vb * den, w3 = vc * den;
      out[0] = ax + abx * v2 + acx * w3; out[1] = ay + aby * v2 + acy * w3; out[2] = az + abz * v2 + acz * w3;
    }
    /* -> the nearest point to (qx, qy, qz) written to out; the squared distance */
    return function nearest(qx, qy, qz, out) {
      var cx = Math.floor((qx - lo[0]) / cell), cy = Math.floor((qy - lo[1]) / cell), cz = Math.floor((qz - lo[2]) / cell), bd = Infinity, tmp = [0, 0, 0];
      cx = Math.max(0, Math.min(dim[0] - 1, cx)); cy = Math.max(0, Math.min(dim[1] - 1, cy)); cz = Math.max(0, Math.min(dim[2] - 1, cz));
      for (var rad = 0; rad < 40; rad++) {
        for (var zz = Math.max(0, cz - rad); zz <= Math.min(dim[2] - 1, cz + rad); zz++) for (var yy = Math.max(0, cy - rad); yy <= Math.min(dim[1] - 1, cy + rad); yy++) for (var xx = Math.max(0, cx - rad); xx <= Math.min(dim[0] - 1, cx + rad); xx++) {
          if (Math.max(Math.abs(xx - cx), Math.abs(yy - cy), Math.abs(zz - cz)) !== rad) continue;
          var cid = (zz * dim[1] + yy) * dim[0] + xx;
          for (var q = counts[cid]; q < counts[cid + 1]; q++) {
            closestOn(list[q], qx, qy, qz, tmp);
            var d = (tmp[0] - qx) * (tmp[0] - qx) + (tmp[1] - qy) * (tmp[1] - qy) + (tmp[2] - qz) * (tmp[2] - qz);
            if (d < bd) { bd = d; best[0] = tmp[0]; best[1] = tmp[1]; best[2] = tmp[2]; }
          }
        }
        if (bd < Infinity && Math.sqrt(bd) <= rad * cell) break;
      }
      out[0] = best[0]; out[1] = best[1]; out[2] = best[2];
      return bd;
    };
  }

  /* Isotropic remeshing (Botsch and Kobbelt): edges split above 4/3 of the target length, collapsed below 4/5, flipped toward valence 6,
     the corners moved along the surface toward their neighbours' mean and put back ON the original surface. The corners on the
     outline (every corner of a boundary edge) never move and no edge of the outline is split, collapsed or flipped: the rim is the rim.
     P (3 per corner), T (3 per triangle, counter-clockwise); returns { P, T, nv, alive: which of the first corners stayed ids }. */
  function isoRemesh(P0, T0, nv0, Ltarget, o) {
    var nearest = surfaceIndex(P0, T0), i, t, k;
    var px = Array.from({ length: nv0 }, function (_, v) { return P0[3 * v]; }), py = Array.from({ length: nv0 }, function (_, v) { return P0[3 * v + 1]; }), pz = Array.from({ length: nv0 }, function (_, v) { return P0[3 * v + 2]; });
    var fixed = new Array(nv0).fill(false), vt = [], ta = [], tb = [], tc = [], tal = [], emap = new Map(), K = 4194304, tmp = [0, 0, 0];
    for (i = 0; i < nv0; i++) vt.push([]);
    function ek(a, b) { return a < b ? a * K + b : b * K + a; }
    function link(t0) {
      var v = [ta[t0], tb[t0], tc[t0]];
      for (var q = 0; q < 3; q++) {
        vt[v[q]].push(t0);
        var key = ek(v[q], v[(q + 1) % 3]), l = emap.get(key);
        if (l) l.push(t0); else emap.set(key, [t0]);
      }
    }
    function unlink(t0) {
      var v = [ta[t0], tb[t0], tc[t0]];
      for (var q = 0; q < 3; q++) {
        var s = vt[v[q]], ix = s.indexOf(t0); if (ix >= 0) s.splice(ix, 1);
        var key = ek(v[q], v[(q + 1) % 3]), l = emap.get(key);
        if (l) { var j = l.indexOf(t0); if (j >= 0) l.splice(j, 1); if (!l.length) emap.delete(key); }
      }
    }
    function addTri(a, b, c) { ta.push(a); tb.push(b); tc.push(c); tal.push(true); link(ta.length - 1); return ta.length - 1; }
    function killTri(t0) { unlink(t0); tal[t0] = false; }
    for (t = 0; t < T0.length / 3; t++) addTri(T0[3 * t], T0[3 * t + 1], T0[3 * t + 2]);
    emap.forEach(function (l, key) { if (l.length === 1) { fixed[Math.floor(key / K)] = true; fixed[key % K] = true; } });
    var boundaryCount = 0;
    emap.forEach(function (l) { if (l.length === 1) boundaryCount++; });
    function newVert(x, y, z, fx) { px.push(x); py.push(y); pz.push(z); fixed.push(!!fx); vt.push([]); return px.length - 1; }
    function triNormal(t0, out) {
      var a = ta[t0], b = tb[t0], c = tc[t0], ux = px[b] - px[a], uy = py[b] - py[a], uz = pz[b] - pz[a], vx = px[c] - px[a], vy = py[c] - py[a], vz = pz[c] - pz[a];
      out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx;
      return Math.hypot(out[0], out[1], out[2]);
    }
    function len(a, b) { return Math.hypot(px[a] - px[b], py[a] - py[b], pz[a] - pz[b]); }
    function project(v) { nearest(px[v], py[v], pz[v], tmp); px[v] = tmp[0]; py[v] = tmp[1]; pz[v] = tmp[2]; }
    function third(t0, a, b) { return ta[t0] !== a && ta[t0] !== b ? ta[t0] : tb[t0] !== a && tb[t0] !== b ? tb[t0] : tc[t0]; }
    function directed(t0, a, b) { return (ta[t0] === a && tb[t0] === b) || (tb[t0] === a && tc[t0] === b) || (tc[t0] === a && ta[t0] === b); }   // t0 runs a -> b
    function edgesNow() { var out = []; emap.forEach(function (l, key) { out.push(key); }); return out; }
    var hi = 4 / 3 * Ltarget, lo = 4 / 5 * Ltarget;

    function split(key) {
      var l = emap.get(key);
      if (!l || l.length !== 2) return false;
      var a = Math.floor(key / K), b = key % K;
      if (len(a, b) <= hi) return false;
      var m = newVert((px[a] + px[b]) / 2, (py[a] + py[b]) / 2, (pz[a] + pz[b]) / 2, false);
      project(m);
      l.slice().forEach(function (tq) {
        var w = third(tq, a, b), fwd = directed(tq, a, b);
        killTri(tq);
        if (fwd) { addTri(a, m, w); addTri(m, b, w); } else { addTri(b, m, w); addTri(m, a, w); }
      });
      return true;
    }
    function collapse(key) {
      var l = emap.get(key);
      if (!l || l.length !== 2) return false;
      var a = Math.floor(key / K), b = key % K;
      if (fixed[a] && fixed[b]) return false;
      if (len(a, b) >= lo) return false;
      var keep = a, drop = b;
      if (fixed[b]) { keep = b; drop = a; }
      // link condition: the neighbours the two share are exactly the two opposite corners
      var nk = new Set(), shared = 0;
      vt[keep].forEach(function (tq) { nk.add(ta[tq]); nk.add(tb[tq]); nk.add(tc[tq]); });
      vt[drop].forEach(function (tq) { [ta[tq], tb[tq], tc[tq]].forEach(function (w) { if (w !== keep && w !== drop && nk.has(w)) shared++; }); });
      var sharedUnique = new Set();
      vt[drop].forEach(function (tq) { [ta[tq], tb[tq], tc[tq]].forEach(function (w) { if (w !== keep && w !== drop && nk.has(w)) sharedUnique.add(w); }); });
      if (sharedUnique.size !== 2) return false;
      if (fixed[keep] && o && o.blocked) {                      // the survivor would be joined to every neighbour of the dropped corner: not to one the mesh outside already joins it to
        var blockedNew = false;
        vt[drop].forEach(function (tq) { [ta[tq], tb[tq], tc[tq]].forEach(function (w) { if (w !== keep && w !== drop && !nk.has(w) && fixed[w] && o.blocked(keep, w)) blockedNew = true; }); });
        if (blockedNew) return false;
      }
      void shared;
      // where the survivor goes; no triangle round the dropped corner may turn over, and none may grow an edge over the high mark
      var nx = fixed[keep] ? px[keep] : (px[a] + px[b]) / 2, ny = fixed[keep] ? py[keep] : (py[a] + py[b]) / 2, nz = fixed[keep] ? pz[keep] : (pz[a] + pz[b]) / 2;
      if (!fixed[keep]) { nearest(nx, ny, nz, tmp); nx = tmp[0]; ny = tmp[1]; nz = tmp[2]; }
      var okc = true, nn0 = [0, 0, 0], nn1 = [0, 0, 0], sx = px[keep], sy = py[keep], sz = pz[keep];
      var around = vt[drop].filter(function (tq) { return l.indexOf(tq) < 0; }).concat(vt[keep].filter(function (tq) { return l.indexOf(tq) < 0; }));
      around.forEach(function (tq) {
        if (!okc) return;
        var n0 = triNormal(tq, nn0), uses = (ta[tq] === drop || tb[tq] === drop || tc[tq] === drop) ? drop : keep;
        var ox = px[uses], oy = py[uses], oz = pz[uses];
        px[uses] = nx; py[uses] = ny; pz[uses] = nz;
        var n1 = triNormal(tq, nn1), dd = nn0[0] * nn1[0] + nn0[1] * nn1[1] + nn0[2] * nn1[2];
        var w0 = tq, e = [ta[w0], tb[w0], tc[w0]], mx = 0;
        for (var q = 0; q < 3; q++) mx = Math.max(mx, len(e[q], e[(q + 1) % 3]));
        px[uses] = ox; py[uses] = oy; pz[uses] = oz;
        if (n0 < 1e-14 || n1 < 1e-14 || dd / (n0 * n1) < 0.4 || mx > hi) okc = false;
      });
      void sx; void sy; void sz;
      if (!okc) return false;
      var affected = vt[drop].slice();
      l.slice().forEach(function (tq) { killTri(tq); });
      affected.forEach(function (tq) {
        if (!tal[tq]) return;
        var v = [ta[tq], tb[tq], tc[tq]].map(function (w) { return w === drop ? keep : w; });
        killTri(tq); addTri(v[0], v[1], v[2]);
      });
      px[keep] = nx; py[keep] = ny; pz[keep] = nz;
      vt[drop] = [];
      return true;
    }
    function valence(v) { return vt[v].length; }
    function flip(key) {
      var l = emap.get(key);
      if (!l || l.length !== 2) return false;
      var a = Math.floor(key / K), b = key % K, t1 = l[0], t2 = l[1];
      var c = third(t1, a, b), d = third(t2, a, b);
      if (c === d || emap.has(ek(c, d))) return false;
      if (fixed[c] && fixed[d] && o && o.blocked && o.blocked(c, d)) return false;       // the mesh outside already joins them
      if (!directed(t1, a, b)) { var sw = t1; t1 = t2; t2 = sw; var sc = c; c = d; d = sc; }
      // t1 runs a -> b with c on its left; t2 runs b -> a with d
      function dev(v, delta) { var tgt = fixed[v] ? 4 : 6, val = valence(v) + delta; return (val - tgt) * (val - tgt); }
      var before = dev(a, 0) + dev(b, 0) + dev(c, 0) + dev(d, 0), after = dev(a, -1) + dev(b, -1) + dev(c, 1) + dev(d, 1);
      if (after >= before) return false;
      var n0 = [0, 0, 0], n1 = [0, 0, 0], n2 = [0, 0, 0], m0 = triNormal(t1, n0), m1 = triNormal(t2, n1);
      void m0; void m1;
      // the two new triangles (a, d, c) and (d, b, c): neither may turn over against the old pair
      var avg = [n0[0] + n1[0], n0[1] + n1[1], n0[2] + n1[2]], al = Math.hypot(avg[0], avg[1], avg[2]) || 1;
      function nrm3(p, q, r, out) { var ux = px[q] - px[p], uy = py[q] - py[p], uz = pz[q] - pz[p], vx = px[r] - px[p], vy = py[r] - py[p], vz = pz[r] - pz[p]; out[0] = uy * vz - uz * vy; out[1] = uz * vx - ux * vz; out[2] = ux * vy - uy * vx; return Math.hypot(out[0], out[1], out[2]); }
      var q1 = nrm3(a, d, c, n2), d1 = (n2[0] * avg[0] + n2[1] * avg[1] + n2[2] * avg[2]) / (q1 * al || 1);
      var q2 = nrm3(d, b, c, n2), d2 = (n2[0] * avg[0] + n2[1] * avg[1] + n2[2] * avg[2]) / (q2 * al || 1);
      if (q1 < 1e-14 || q2 < 1e-14 || d1 < 0.5 || d2 < 0.5) return false;
      killTri(t1); killTri(t2);
      addTri(a, d, c); addTri(d, b, c);
      return true;
    }
    function smooth() {
      var nn = [0, 0, 0], moves = [], v;
      for (v = 0; v < px.length; v++) {
        if (fixed[v] || !vt[v].length) continue;
        var sx = 0, sy = 0, sz = 0, c = 0, nx = 0, ny = 0, nz = 0, seen = new Set();
        vt[v].forEach(function (tq) {
          var m = triNormal(tq, nn); nx += nn[0]; ny += nn[1]; nz += nn[2];
          [ta[tq], tb[tq], tc[tq]].forEach(function (w) { if (w !== v && !seen.has(w)) { seen.add(w); sx += px[w]; sy += py[w]; sz += pz[w]; c++; } });
          void m;
        });
        if (!c) continue;
        var nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
        var dx = sx / c - px[v], dy = sy / c - py[v], dz = sz / c - pz[v], dn = dx * nx + dy * ny + dz * nz;
        moves.push([v, px[v] + 0.6 * (dx - dn * nx), py[v] + 0.6 * (dy - dn * ny), pz[v] + 0.6 * (dz - dn * nz)]);
      }
      moves.forEach(function (m) {
        var v2 = m[0], ox = px[v2], oy = py[v2], oz = pz[v2];
        px[v2] = m[1]; py[v2] = m[2]; pz[v2] = m[3];
        // refuse a move that turns a triangle over
        var bad = false, n0 = [0, 0, 0];
        vt[v2].forEach(function (tq) { var q = triNormal(tq, n0); if (q < 1e-14) bad = true; });
        if (bad) { px[v2] = ox; py[v2] = oy; pz[v2] = oz; }
      });
    }
    function projectAll() { for (var v = 0; v < px.length; v++) if (!fixed[v] && vt[v].length) project(v); }
    var iters = o && o.iters > 0 ? o.iters : 6, it;
    for (it = 0; it < iters; it++) {
      var ops = 0, before = emap.size;
      edgesNow().forEach(function (key) { if (split(key)) ops++; });
      edgesNow().forEach(function (key) { if (collapse(key)) ops++; });
      edgesNow().forEach(function (key) { if (flip(key)) ops++; });
      smooth(); smooth(); smooth();                              // along the surface; then put back on it once
      projectAll();
      if (it >= 2 && ops < 0.005 * before) break;                // settled
    }
    edgesNow().forEach(flip); smooth(); smooth(); projectAll();
    // out: the corners still in use, in order; the original first corners keep their ids where they are alive
    var used = new Int32Array(px.length).fill(-1), n = 0;
    for (t = 0; t < ta.length; t++) if (tal[t]) { [ta[t], tb[t], tc[t]].forEach(function (v) { if (used[v] < 0) used[v] = -2; }); }
    var order = [];
    for (i = 0; i < px.length; i++) if (used[i] === -2) { used[i] = n++; order.push(i); }
    var P = new Float64Array(3 * n), T = [];
    order.forEach(function (v, j) { P[3 * j] = px[v]; P[3 * j + 1] = py[v]; P[3 * j + 2] = pz[v]; });
    for (t = 0; t < ta.length; t++) if (tal[t]) T.push(used[ta[t]], used[tb[t]], used[tc[t]]);
    var map = new Int32Array(nv0).fill(-1);
    for (i = 0; i < nv0; i++) map[i] = used[i] >= 0 ? used[i] : -1;
    void k; void boundaryCount;
    return { P: P, T: Int32Array.from(T), nv: n, map: map };
  }

  /* ------------------------------------------------------------------- weaving */

  /* The new patch for a detached plate. opts: fit ('smooth': the work on the plate - engraving, bosses, gouges - is bridged;
     'follow': the plate's own surface, only re-woven), pitch (mm; the plate's own edge by default).
       1. smooth: the work is found on the mesh by its creases and each hole of it filled, locally, with the face carried across;
       2. the whole cleaned patch is unrolled (conformal) to the plane, whatever its curve;
       3. the plane's outline - the rim, corner for corner - is woven (nso_cdt.js) at the pitch, the sizing following the unrolling's scale;
       4. each new corner is lifted back onto the cleaned patch where it stands, so the new surface is a clone of it.
     -> { ok, newV (x y z per new corner), T (ids < nOld are the mesh's own corners, the rest nOld + the index into newV), nOld, rim, stats }
     or a refusal. */
  function weave(M, pt, opts) {
    if (!CDT) return refuse('the mesher (nso_cdt.js) is not loaded');
    if (!pt || !pt.ok) return refuse(pt && pt.reason || 'nothing is detached');
    var o = {}, k, i, t;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in opts || {}) if (opts[k] !== undefined && opts[k] !== null) o[k] = opts[k];
    var t0 = Date.now();
    var plate = plateEdge(M, pt.tris), pitch = o.pitch > 0 ? o.pitch : plate;
    if (!(pitch > 0)) return refuse('the plate has no triangle size to match');
    if (pt.area / (0.433 * pitch * pitch) > o.maxTris) {
      return refuse('that patch would need about ' + String(Math.round(pt.area / (0.433 * pitch * pitch))).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' triangles at a pitch of ' + fmt(pitch, 3) + ' mm - raise the pitch', { tooMany: true });
    }
    // 1. the work, and its holes filled
    var fills = [], extra = [], nOld = M.nV, work = new Uint8Array(M.n), workArea = 0, workDepth = 0, groups = 0, keptFeatures = 0, unfilled = [];
    if (o.fit !== 'follow') {
      // the corners of the outline and the ring inside it: work that comes that near the edge is a feature the edge crosses
      var rimSet = new Set(), keepOut = new Set();
      pt.loops.forEach(function (L) { L.forEach(function (v) { rimSet.add(v); keepOut.add(v); }); });
      for (t = 0; t < M.n; t++) {
        if (!pt.mask[t]) continue;
        if (rimSet.has(M.vid[3 * t]) || rimSet.has(M.vid[3 * t + 1]) || rimSet.has(M.vid[3 * t + 2])) for (k = 0; k < 3; k++) keepOut.add(M.vid[3 * t + k]);
      }
      var seg = segment(M, pt.mask, o, keepOut);
      work = seg.work; keptFeatures = seg.kept;
      var wl = [];
      for (t = 0; t < M.n; t++) if (work[t]) wl.push(t);
      var clusters = wl.length ? components(M, work) : [], done = new Uint8Array(M.n), oF = Object.assign({}, o, { mask: pt.mask, keepOut: keepOut });
      for (var ci = 0; ci < clusters.length; ci++) {
        var live = clusters[ci].filter(function (tq) { return work[tq] && !done[tq]; });
        if (!live.length) continue;
        var fc = fillCluster(M, live, work, oF, pitch);
        if (!fc.ok) {                                           // a piece of the surface that is not a bridgeable hole (a finger web, a fold): it stays as it is
          live.forEach(function (tq) { work[tq] = 0; });
          keptFeatures++; unfilled.push(fc.reason);
          continue;
        }
        fc.tris.forEach(function (tq) { workArea += M.area[tq]; done[tq] = 1; });
        var off = extra.length / 3;
        for (i = 0; i < fc.newV.length; i++) extra.push(fc.newV[i]);
        var T2 = new Int32Array(fc.T.length);
        for (i = 0; i < T2.length; i++) T2[i] = fc.T[i] >= nOld ? fc.T[i] + off : fc.T[i];
        fills.push(T2);
        workDepth = Math.max(workDepth, fc.depth);
        groups++;
      }
    }
    // 2. the cleaned patch: the face, and what filled the holes
    var lid = new Map(), lp = [], lt = [];
    function local(id) {
      var l = lid.get(id);
      if (l !== undefined) return l;
      l = lid.size; lid.set(id, l);
      if (id < nOld) lp.push(M.P[3 * id], M.P[3 * id + 1], M.P[3 * id + 2]);
      else { var j = id - nOld; lp.push(extra[3 * j], extra[3 * j + 1], extra[3 * j + 2]); }
      return l;
    }
    for (t = 0; t < M.n; t++) if (pt.mask[t] && !work[t]) for (k = 0; k < 3; k++) lt.push(local(M.vid[3 * t + k]));
    fills.forEach(function (F) { for (var q = 0; q < F.length; q++) lt.push(local(F[q])); });
    var rimLocal = [], rimLoops = pt.loops.map(function (L) { return L.map(function (v) { var l = lid.get(v); if (l === undefined) l = local(v); rimLocal.push(l); return l; }); });
    var nv = lid.size, P = Float64Array.from(lp), TT = Int32Array.from(lt);
    var newV, T, nNew, rimIds = [];
    pt.loops.forEach(function (L) { L.forEach(function (v) { rimIds.push(v); }); });
    {
      // the cleaned patch remeshed where it stands: edges split, collapsed and flipped toward the pitch, the corners moved along the
      // surface and put back on it, the rim held. Whatever the patch does - curves, grooves, saddles - it is the same surface.
      var gOf = new Map();
      rimLocal.forEach(function (l, idx) { gOf.set(l, rimIds[idx]); });
      function joinedM(u, v) { for (var a = M.vstart[u]; a < M.vstart[u + 1]; a++) { var tq = M.vlist[a]; if (M.vid[3 * tq] === v || M.vid[3 * tq + 1] === v || M.vid[3 * tq + 2] === v) return true; } return false; }
      var oR = { iters: o.iters, blocked: function (a, b) { var ga = gOf.get(a), gb = gOf.get(b); return ga !== undefined && gb !== undefined && joinedM(ga, gb); } };
      var rm = isoRemesh(P, TT, nv, pitch, oR);
      var glob = new Int32Array(rm.nv).fill(-1);
      rimLocal.forEach(function (l, idx) { if (rm.map[l] >= 0) glob[rm.map[l]] = rimIds[idx]; });
      var idxOf = new Int32Array(rm.nv).fill(-1), nn2 = 0;
      for (i = 0; i < rm.nv; i++) if (glob[i] < 0) idxOf[i] = nn2++;
      nNew = nn2; newV = new Float64Array(3 * nNew);
      for (i = 0; i < rm.nv; i++) if (idxOf[i] >= 0) { newV[3 * idxOf[i]] = rm.P[3 * i]; newV[3 * idxOf[i] + 1] = rm.P[3 * i + 1]; newV[3 * idxOf[i] + 2] = rm.P[3 * i + 2]; }
      T = new Int32Array(rm.T.length);
      for (i = 0; i < T.length; i++) T[i] = glob[rm.T[i]] >= 0 ? glob[rm.T[i]] : nOld + idxOf[rm.T[i]];
      var seenRim = 0;
      rimLocal.forEach(function (l) { if (rm.map[l] >= 0) seenRim++; });
      if (seenRim !== rimLocal.length) return refuse('the remeshing lost ' + (rimLocal.length - seenRim) + ' rim corners');
    }
    // numbers for the readout
    var lens = [], angs = [], flipped = 0;
    function pos(id, out) {
      if (id < nOld) { out[0] = M.P[3 * id]; out[1] = M.P[3 * id + 1]; out[2] = M.P[3 * id + 2]; }
      else { var j2 = id - nOld; out[0] = newV[3 * j2]; out[1] = newV[3 * j2 + 1]; out[2] = newV[3 * j2 + 2]; }
    }
    var pa = [0, 0, 0], pb = [0, 0, 0], pc = [0, 0, 0];
    for (i = 0; i < T.length; i += 3) {
      pos(T[i], pa); pos(T[i + 1], pb); pos(T[i + 2], pc);
      var e = [Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]), Math.hypot(pc[0] - pb[0], pc[1] - pb[1], pc[2] - pb[2]), Math.hypot(pa[0] - pc[0], pa[1] - pc[1], pa[2] - pc[2])];
      lens.push(e[0], e[1], e[2]);
      for (var a3 = 0; a3 < 3; a3++) {
        var A = e[a3], B = e[(a3 + 1) % 3], Cc = e[(a3 + 2) % 3], cs = (A * A + B * B - Cc * Cc) / (2 * A * B);
        angs.push(Math.acos(Math.max(-1, Math.min(1, cs))) * 180 / Math.PI);
      }
    }
    // turned: two triangles running the same way along an edge they share (the new patch's own winding disagreeing with itself)
    var dirE = new Map(), sameDir = 0, KK = nOld + nNew + 1;
    for (i = 0; i < T.length; i += 3) for (var q2 = 0; q2 < 3; q2++) {
      var ek = T[i + q2] * KK + T[i + (q2 + 1) % 3];
      if (dirE.has(ek)) sameDir++; else dirE.set(ek, 1);
    }
    flipped += sameDir;
    lens.sort(function (x2, y2) { return x2 - y2; }); angs.sort(function (x2, y2) { return x2 - y2; });
    var stats = {
      oldTris: pt.tris.length, newTris: T.length / 3, rimCorners: pt.rimCorners, newCorners: nNew, pitch: pitch, plateEdge: plate,
      edgeP50: lens[lens.length >> 1], edgeP5: lens[(lens.length * 0.05) | 0], edgeP95: lens[(lens.length * 0.95) | 0],
      angleMin: angs[0], angleP1: angs[(angs.length * 0.01) | 0], angleP5: angs[(angs.length * 0.05) | 0],
      flipped: flipped, keptFeatures: keptFeatures, unfilled: unfilled, workArea: workArea, workDepth: workDepth, workGroups: groups, area: pt.area, fit: o.fit, ms: Date.now() - t0
    };
    return { ok: true, newV: newV, T: T, nOld: nOld, rim: rimIds, stats: stats, work: work };
  }

  /* --------------------------------------------------------------- reattaching */

  /* The soup with the plate out and the new patch in. `mask` is the selection the plan was made for. */
  function apply(soup, plan, mask) {
    if (!plan || !plan.ok) return refuse(plan && plan.reason || 'there is no new patch');
    var M = prepare(soup);
    if (M.nV !== plan.nOld) return refuse('the piece changed since the patch was woven');
    var n = M.n, keep = 0, t, i;
    for (t = 0; t < n; t++) if (!mask[t]) keep++;
    var out = new Float32Array(9 * (keep + plan.T.length / 3)), q = 0;
    for (t = 0; t < n; t++) { if (mask[t]) continue; out.set(soup.subarray(9 * t, 9 * t + 9), q); q += 9; }
    for (i = 0; i < plan.T.length; i++) {
      var id = plan.T[i];
      if (id < plan.nOld) { out[q++] = M.P[3 * id]; out[q++] = M.P[3 * id + 1]; out[q++] = M.P[3 * id + 2]; }
      else { var j = id - plan.nOld; out[q++] = plan.newV[3 * j]; out[q++] = plan.newV[3 * j + 1]; out[q++] = plan.newV[3 * j + 2]; }
    }
    return { ok: true, soup: out, removed: n - keep, added: plan.T.length / 3 };
  }

  /* selection -> patch -> woven patch, in a row */
  function plan(soup, mask, opts) {
    var M = prepare(soup), c = close(M, mask);
    if (!c.count) return refuse('nothing is selected');
    var pt = patch(M, c.mask);
    if (!pt.ok) return pt;
    var w = weave(M, pt, opts);
    if (!w.ok) return w;
    w.patch = pt; w.mask = c.mask; w.closed = c;
    return w;
  }

  var API = { DEFAULTS: DEFAULTS, prepare: prepare, ball: ball, flood: flood, grow: grow, shrink: shrink, close: close, components: components, count: count,
              centroid: centroid, patch: patch, weave: weave, apply: apply, plan: plan, plateEdge: plateEdge, segment: segment, boundaryLoops: boundaryLoops, _isoRemesh: isoRemesh };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Weave = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
