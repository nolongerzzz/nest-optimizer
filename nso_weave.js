/* nso_weave.js - Weave: cut a patch out of a mesh at its own triangles, lay a fresh, evenly woven patch in the
   hole, and reattach it corner for corner. docs/WEAVE.md.

   Loads as a classic script (window.NSO_Weave) and as a Node module (needs nso_cdt.js). No DOM, no THREE.
   The soup is the app's usual triangle soup (9 numbers a triangle, counter-clockwise from outside).

     NSO_Weave.prepare(soup)              -> M     the welded mesh: corners, neighbours, normals
     NSO_Weave.ball(M, tri, point, r)     -> mask  the triangles within r of a point, joined to `tri`
     NSO_Weave.grow(M, mask, rings) / shrink(M, mask, rings)
     NSO_Weave.close(M, mask)             -> { mask, ... }  islands filled, pinches opened, one piece kept
     NSO_Weave.patch(M, mask)             -> { ok, tris, loops, frame, ... }   the puzzle piece, detached
     NSO_Weave.weave(M, patch, opts)      -> { ok, ... }   the new patch, fitted over the old one
     NSO_Weave.apply(soup, plan)          -> { ok, soup }  the old patch out, the new one in
     NSO_Weave.plan(soup, mask, opts)     -> the four above in a row

   THE IDEA. Every corner of a mesh is a place it can be cut. A selection of triangles is cut out along their
   own edges, like a puzzle piece: the piece (the PLATE) and, in the mesh, a hole whose rim is a loop of the
   mesh's own corners. The new patch is built to fit that hole and nothing else:

     - its rim IS the rim: every rim corner is a corner of a new triangle, no rim edge is split, the new
       triangles run the same way round the rim the old ones did - so the join is watertight with no weld,
       no boolean and nothing to repair;
     - its inside is woven fresh (nso_cdt.js): a hex lattice at the plate's own triangle size, graded in from
       the rim's corner spacing, relaxed, constrained-Delaunay triangulated - an even mesh, not the scan's;
     - its corners stand on a surface FITTED OVER THE PLATE. The plate is read as a height field along its mean
       normal; where the plate is plain face the new surface is the plate, where the plate has WORK on it (an
       engraving, a boss, a gouge: walls steeper than 65 degrees cut the height field into pieces, and the
       pieces that are not the face are the work) it is the face carried across - a quadratic fitted to the
       face round the work, the mismatch at its edge spread inward by Laplace's equation, so no step and the
       face's own curvature. fit 'follow' skips the work: the surface is the plate exactly, only re-woven.

   WHAT IT NEEDS: a patch whose outline is a clean loop of the mesh's corners (the card closes islands and
   pinches first), that is a height field along its mean normal (it does not curl round past about 75 degrees),
   and, to remove work, a crop whose EDGE falls on clean face round the work.

   PAINT SCOPE: NOT APPLICABLE here - this file reads a soup and returns a new one. The app's card carries the
   paint check (docs/HANDOFF.md). */
(function (root) {
  'use strict';

  var CDT = root && root.NSO_CDT ? root.NSO_CDT : null;
  if (!CDT && typeof module !== 'undefined' && typeof require === 'function') {
    try { CDT = require('./nso_cdt.js'); } catch (e) { CDT = null; }
  }

  var DEFAULTS = {
    fit: 'smooth',     // 'smooth': the work is bridged; 'follow': the plate exactly
    wallTan: 1.43,     // tan 55 degrees: a drop this steep between neighbouring nodes is a wall (an engraving's walls on a coarse mesh lean, and the face itself stays under 40)
    crease: 0.04,      // mm: the height field turning this sharply over three nodes is a crease (a wall's foot or top); at least 8 times the data's own roughness
    faceMin: 0.15,     // a piece of the height field this fraction of the biggest one is face, not work
    dil: 2,            // nodes the work is widened by (its walls' slopes)
    reach: 1.5,        // mm: work this near other work is fitted together
    ring: 2.5,         // mm of face round the work the surface is fitted to
    rimDecay: 1.0,     // mm over which the rim's last mismatch dies away inward
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
         join it, if they are small (at most half as many triangles as it has, and 5000) and face the way it does (the
         rest of a closed piece, its underside, is not a hole);
       - pinches: a corner where the selection's outline touches itself is surrounded by the selection;
       - one piece: of several pieces joined only at a corner, the biggest stays. */
  function close(M, mask, opts) {
    var cur = Uint8Array.from(mask), added = 0, t, k, pass, keep = opts && opts.keep;
    var sel = count(cur), cap = Math.min(5000, Math.max(50, sel >> 1));
    // islands: a region of unselected triangles with the selection all round it. A flood that runs past `cap`
    // (or reaches an open edge, or a region already known to be big) is the rest of the world, and everything it met is marked so.
    var stamp = new Int32Array(M.n), huge = new Uint8Array(M.n), floodId = 0, mean = [0, 0, 0], tt;
    for (tt = 0; tt < M.n; tt++) if (cur[tt]) { mean[0] += M.area[tt] * M.nrm[3 * tt]; mean[1] += M.area[tt] * M.nrm[3 * tt + 1]; mean[2] += M.area[tt] * M.nrm[3 * tt + 2]; }
    var ml = Math.hypot(mean[0], mean[1], mean[2]) || 1;
    mean = [mean[0] / ml, mean[1] / ml, mean[2] / ml];
    for (t = 0; t < M.n; t++) {
      if (!cur[t]) continue;
      for (k = 0; k < 3; k++) {
        var nb = M.nbr[3 * t + k];
        if (nb < 0 || cur[nb] || huge[nb] || stamp[nb]) continue;
        var comp = [nb], qh = 0, open = false;
        stamp[nb] = ++floodId;
        while (qh < comp.length) {
          var u = comp[qh++];
          for (var j = 0; j < 3; j++) {
            var w = M.nbr[3 * u + j];
            if (w === -1 || w === -2) { open = true; continue; }       // an open edge: not shut in
            if (cur[w] || stamp[w] === floodId) continue;
            if (huge[w]) { open = true; continue; }
            stamp[w] = floodId; comp.push(w);
          }
          if (open || comp.length > cap) break;
        }
        if (open || comp.length > cap) { for (var q = 0; q < comp.length; q++) huge[comp[q]] = 1; continue; }
        // a hole in a cut faces the way the cut does (an engraving's floor looks up, its walls sideways); the rest of a closed piece
        // - its underside - looks away, and is not a hole however small it is next to the cut
        var away = 0, all = 0;
        for (var q5 = 0; q5 < comp.length; q5++) {
          var u5 = comp[q5], a5 = M.area[u5];
          all += a5;
          if (M.nrm[3 * u5] * mean[0] + M.nrm[3 * u5 + 1] * mean[1] + M.nrm[3 * u5 + 2] * mean[2] < -0.3) away += a5;
        }
        if (all > 0 && away > 0.05 * all) { for (var q6 = 0; q6 < comp.length; q6++) huge[comp[q6]] = 1; continue; }
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

  /* Cut the selection out along its own triangles. -> { ok, tris (Int32Array), loops (arrays of corner ids, the
     selection on the left of each), frame { o, n, e1, e2 }, loops2 (the loops' corners as [u, v]), area, ... } */
  function patch(M, mask) {
    var tris = [], t, k, i;
    for (t = 0; t < M.n; t++) if (mask[t]) tris.push(t);
    if (!tris.length) return refuse('nothing is selected');
    var next = new Map(), bad = 0, nm = 0, edges = 0;
    for (i = 0; i < tris.length; i++) {
      t = tris[i];
      for (k = 0; k < 3; k++) {
        var nb = M.nbr[3 * t + k], a = M.vid[3 * t + k], b = M.vid[3 * t + (k + 1) % 3];
        if (a === b || (nb >= 0 && mask[nb])) continue;
        if (nb === -2) nm++;
        edges++;
        var l = next.get(a);
        if (l) { l.push(b); bad++; } else next.set(a, [b]);
      }
    }
    if (nm) return refuse('the cut runs along an edge three triangles share (' + nm + ' of them) - the mesh is not a surface there');
    if (!edges) return refuse('the selection is the whole piece - there is no rim to cut along');
    if (bad) return refuse('the selection touches itself at ' + bad + ' corner(s) - close it first');
    var loops = [], seen = new Set(), starts = Array.from(next.keys()).sort(function (x, y) { return x - y; });
    for (i = 0; i < starts.length; i++) {
      var s = starts[i];
      if (seen.has(s)) continue;
      var loop = [], cur = s, guard = 0;
      do {
        seen.add(cur); loop.push(cur);
        var nx = next.get(cur);
        if (!nx) return refuse('the outline of the selection does not close');
        cur = nx[0];
        if (++guard > edges + 2) return refuse('the outline of the selection does not close');
      } while (cur !== s);
      loops.push(loop);
    }
    var fr = frameFor(M, tris);
    if (!fr) return refuse('the selection has no direction (it is flat or empty)');
    var o = [0, 0, 0], nn = 0;
    loops.forEach(function (L) { L.forEach(function (v) { o[0] += M.P[3 * v]; o[1] += M.P[3 * v + 1]; o[2] += M.P[3 * v + 2]; nn++; }); });
    fr.o = [o[0] / nn, o[1] / nn, o[2] / nn];
    function proj(v) {
      var w0 = M.P[3 * v] - fr.o[0], w1 = M.P[3 * v + 1] - fr.o[1], w2 = M.P[3 * v + 2] - fr.o[2];
      return [w0 * fr.e1[0] + w1 * fr.e1[1] + w2 * fr.e1[2], w0 * fr.e2[0] + w1 * fr.e2[1] + w2 * fr.e2[2], w0 * fr.n[0] + w1 * fr.n[1] + w2 * fr.n[2]];
    }
    var loops2 = loops.map(function (L) { return L.map(function (v) { var p = proj(v); return [p[0], p[1]]; }); });
    var area = 0, back = 0, tilt = 0, totA = 0;
    for (i = 0; i < tris.length; i++) {
      t = tris[i]; totA += M.area[t];
      var d = M.nrm[3 * t] * fr.n[0] + M.nrm[3 * t + 1] * fr.n[1] + M.nrm[3 * t + 2] * fr.n[2];
      if (d < 0) back += M.area[t];
      tilt += M.area[t] * d;
    }
    var areas = loops2.map(function (L) { var s2 = 0; for (var q = 0; q < L.length; q++) { var a = L[q], b = L[(q + 1) % L.length]; s2 += a[0] * b[1] - b[0] * a[1]; } return s2 / 2; });
    var big = 0;
    areas.forEach(function (a, q) { if (Math.abs(a) > Math.abs(areas[big])) big = q; area = areas[big]; });
    if (areas[big] <= 0) return refuse('the selection\'s outline runs the wrong way round - its triangles do not agree which side is out');
    if (tilt / totA < 0.35 || back / totA > 0.3) {
      return refuse('the selection curls round too far to lay flat (its face turns ' + fmt(Math.acos(Math.max(-1, Math.min(1, tilt / totA))) * 180 / Math.PI, 0) + '° from its mean direction) - cut a smaller piece');
    }
    // the outline, flattened along the mean direction, must not cross or touch itself
    var segs = [];
    loops2.forEach(function (L, li) { for (var q = 0; q < L.length; q++) segs.push({ a: L[q], b: L[(q + 1) % L.length], li: li, q: q, m: L.length }); });
    var lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    loops2.forEach(function (L) { L.forEach(function (p) { lo[0] = Math.min(lo[0], p[0]); hi[0] = Math.max(hi[0], p[0]); lo[1] = Math.min(lo[1], p[1]); hi[1] = Math.max(hi[1], p[1]); }); });
    var meanSeg = 0;
    segs.forEach(function (s) { meanSeg += Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]); });
    var cs = Math.max(meanSeg / segs.length * 3, 1e-4), grid = new Map();
    segs.forEach(function (s, si) {
      var x0 = Math.floor((Math.min(s.a[0], s.b[0]) - lo[0]) / cs), x1 = Math.floor((Math.max(s.a[0], s.b[0]) - lo[0]) / cs);
      var y0 = Math.floor((Math.min(s.a[1], s.b[1]) - lo[1]) / cs), y1 = Math.floor((Math.max(s.a[1], s.b[1]) - lo[1]) / cs);
      for (var ix = x0; ix <= x1; ix++) for (var iy = y0; iy <= y1; iy++) { var kk = ix + ',' + iy, l = grid.get(kk); if (l) l.push(si); else grid.set(kk, [si]); }
    });
    function orient(p, q, r) { return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); }
    var crossing = null;
    grid.forEach(function (l) {
      if (crossing) return;
      for (var x = 0; x < l.length && !crossing; x++) for (var y = x + 1; y < l.length; y++) {
        var s1 = segs[l[x]], s2 = segs[l[y]];
        if (s1.li === s2.li && (Math.abs(s1.q - s2.q) === 1 || Math.abs(s1.q - s2.q) === s1.m - 1)) continue;   // neighbours share a corner
        var o1 = orient(s1.a, s1.b, s2.a), o2 = orient(s1.a, s1.b, s2.b), o3 = orient(s2.a, s2.b, s1.a), o4 = orient(s2.a, s2.b, s1.b);
        if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) { crossing = s1.a; break; }
      }
    });
    if (crossing) return refuse('the selection\'s outline folds over itself when flattened (near ' + fmt(crossing[0], 2) + ', ' + fmt(crossing[1], 2) + ' mm from its middle) - the cut runs along a wall or a fold; cut a smaller or smoother piece');
    var openEdges = 0;
    loops.forEach(function (L) { for (var q = 0; q < L.length; q++) { var a = L[q], b = L[(q + 1) % L.length]; void a; void b; } });
    for (i = 0; i < tris.length; i++) for (k = 0; k < 3; k++) if (M.nbr[3 * tris[i] + k] === -1) openEdges++;
    return { ok: true, tris: Int32Array.from(tris), mask: mask, loops: loops, loops2: loops2, frame: fr, area: totA, rimLength: segs.reduce(function (s, x) { return s + Math.hypot(x.b[0] - x.a[0], x.b[1] - x.a[1]); }, 0),
             rimCorners: nn, holes: loops.length - 1, openEdges: openEdges, flatArea: area, box: { lo: lo, hi: hi } };
  }

  /* ----------------------------------------------------------- the height field */

  function rasterize(M, pt, res) {
    var fr = pt.frame, lo = pt.box.lo, hi = pt.box.hi, pad = 3 * res;
    var x0 = lo[0] - pad, y0 = lo[1] - pad, nx = Math.ceil((hi[0] - lo[0] + 2 * pad) / res) + 1, ny = Math.ceil((hi[1] - lo[1] + 2 * pad) / res) + 1;
    var G = { x0: x0, y0: y0, nx: nx, ny: ny, res: res, N: nx * ny };
    var H = new Float32Array(G.N).fill(NaN), t, i, j, k;
    // the plate, and the ring of the mesh just outside its rim (so a node beside the rim has the real surface under it)
    var all = Array.prototype.slice.call(pt.tris), ringSeen = new Uint8Array(M.n);
    pt.loops.forEach(function (L) {
      L.forEach(function (v) {
        for (var a = M.vstart[v]; a < M.vstart[v + 1]; a++) { var u = M.vlist[a]; if (!pt.mask[u] && !ringSeen[u]) { ringSeen[u] = 1; all.push(u); } }
      });
    });
    pt.outside = all.length - pt.tris.length;
    for (var q = 0; q < all.length; q++) {
      t = all[q];
      var U = [0, 0, 0], Vv = [0, 0, 0], Z = [0, 0, 0];
      for (k = 0; k < 3; k++) {
        var v = M.vid[3 * t + k], w0 = M.P[3 * v] - fr.o[0], w1 = M.P[3 * v + 1] - fr.o[1], w2 = M.P[3 * v + 2] - fr.o[2];
        U[k] = w0 * fr.e1[0] + w1 * fr.e1[1] + w2 * fr.e1[2]; Vv[k] = w0 * fr.e2[0] + w1 * fr.e2[1] + w2 * fr.e2[2]; Z[k] = w0 * fr.n[0] + w1 * fr.n[1] + w2 * fr.n[2];
      }
      var det = (Vv[1] - Vv[2]) * (U[0] - U[2]) + (U[2] - U[1]) * (Vv[0] - Vv[2]);
      if (!(det > 1e-14)) continue;                              // standing on edge, or looking down: not a face seen from above
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
    // the domain: nodes inside the outline (even-odd over every loop)
    var D = new Uint8Array(G.N), cross = [];
    for (j = 0; j < ny; j++) {
      var yy = y0 + j * res + 1e-7, xs = [];
      pt.loops2.forEach(function (L) {
        for (var a = 0, b = L.length - 1; a < L.length; b = a++) {
          var pa = L[a], pb = L[b];
          if ((pa[1] > yy) !== (pb[1] > yy)) xs.push((pb[0] - pa[0]) * (yy - pa[1]) / (pb[1] - pa[1]) + pa[0]);
        }
      });
      xs.sort(function (p, r) { return p - r; });
      for (var s = 0; s + 1 < xs.length; s += 2) {
        var ia = Math.max(0, Math.ceil((xs[s] - x0) / res)), ib = Math.min(nx - 1, Math.floor((xs[s + 1] - x0) / res));
        for (i = ia; i <= ib; i++) D[j * nx + i] = 1;
      }
    }
    void cross;
    return { G: G, H: H, D: D };
  }

  /* least squares by the normal equations, columns scaled */
  function polyTerms(u, v, deg) {
    var t = [1, u, v];
    if (deg >= 2) t.push(u * u, u * v, v * v);
    if (deg >= 3) t.push(u * u * u, u * u * v, u * v * v, v * v * v);
    return t;
  }
  function solveLS(rows, ys, nt) {
    var A = [], b = [], i, j, k;
    for (i = 0; i < nt; i++) { A.push(new Float64Array(nt)); b.push(0); }
    for (k = 0; k < rows.length; k++) for (i = 0; i < nt; i++) { b[i] += rows[k][i] * ys[k]; for (j = 0; j < nt; j++) A[i][j] += rows[k][i] * rows[k][j]; }
    for (i = 0; i < nt; i++) A[i][i] += 1e-9;
    for (i = 0; i < nt; i++) {
      var p = i;
      for (j = i + 1; j < nt; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
      var tr = A[i]; A[i] = A[p]; A[p] = tr; var tb = b[i]; b[i] = b[p]; b[p] = tb;
      if (Math.abs(A[i][i]) < 1e-14) return null;
      for (j = i + 1; j < nt; j++) { var f = A[j][i] / A[i][i]; for (k = i; k < nt; k++) A[j][k] -= f * A[i][k]; b[j] -= f * b[i]; }
    }
    var c = new Float64Array(nt);
    for (i = nt - 1; i >= 0; i--) { var s = b[i]; for (j = i + 1; j < nt; j++) s -= A[i][j] * c[j]; c[i] = s / A[i][i]; }
    return c;
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

  /* The surface over the plate. -> { G, S (Float64, NaN outside), D, work (Uint8), face, stats } or a refusal. */
  function fitSurface(M, pt, ras, o, pitch) {
    var G = ras.G, H = ras.H, D = ras.D, N = G.N, nx = G.nx, ny = G.ny, res = G.res, i, j, id;
    var valid = new Uint8Array(N), nodes = 0, nvalid = 0;
    for (id = 0; id < N; id++) { if (D[id]) { nodes++; if (!isNaN(H[id])) { valid[id] = 1; nvalid++; } } }
    if (nodes < 12) return refuse('the selection is too small to weave (' + nodes + ' nodes at ' + fmt(res, 3) + ' mm)');
    var work = new Uint8Array(N), face = new Uint8Array(N), nWall = 0;
    if (o.fit === 'follow') {
      for (id = 0; id < N; id++) if (D[id]) { if (valid[id]) face[id] = 1; else work[id] = 1; }
    } else {
      // walls: a drop of more than wallTan between neighbours, or an edge of the plate's sight; they cut the field
      var wallDrop = o.wallTan * res, wall = new Uint8Array(N), d2s = [];
      // the data's own roughness: the median second difference over the domain (a scan's noise shows here; a clean mesh's does not)
      for (j = 1; j + 1 < ny; j += 3) for (i = 1; i + 1 < nx; i += 3) {
        id = j * nx + i;
        if (valid[id] && valid[id - 1] && valid[id + 1]) d2s.push(Math.abs(H[id + 1] - 2 * H[id] + H[id - 1]));
      }
      d2s.sort(function (a, b) { return a - b; });
      var creaseTol = Math.max(o.crease, 0.3 * wallDrop * 0.5, 8 * (d2s.length ? d2s[d2s.length >> 1] : 0));
      for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) {
        id = j * nx + i;
        if (!D[id]) continue;
        if (!valid[id]) { wall[id] = 1; continue; }
        var nbs = [i + 1 < nx ? id + 1 : -1, i > 0 ? id - 1 : -1, j + 1 < ny ? id + nx : -1, j > 0 ? id - nx : -1];
        for (var q = 0; q < 4; q++) {
          var m = nbs[q];
          if (m < 0 || !D[m]) continue;
          if (!valid[m]) { wall[id] = 1; wall[m] = 1; continue; }
          if (Math.abs(H[m] - H[id]) > wallDrop) { wall[id] = 1; wall[m] = 1; }
        }
        // a crease - the slope changing abruptly, at a wall's foot and at its top - shuts the gap a wall gentler than the others leaves
        if (i > 0 && i + 1 < nx && D[id - 1] && D[id + 1] && valid[id - 1] && valid[id + 1] && Math.abs(H[id + 1] - 2 * H[id] + H[id - 1]) > creaseTol) wall[id] = 1;
        if (j > 0 && j + 1 < ny && D[id - nx] && D[id + nx] && valid[id - nx] && valid[id + nx] && Math.abs(H[id + nx] - 2 * H[id] + H[id - nx]) > creaseTol) wall[id] = 1;
      }
      // the pieces of the field the walls leave; the big ones are face
      var label = new Int32Array(N).fill(-1), sizes = [], queue = new Int32Array(N);
      for (id = 0; id < N; id++) {
        if (!D[id] || wall[id] || label[id] >= 0) continue;
        var L = sizes.length, qh = 0, qt = 0;
        queue[qt++] = id; label[id] = L;
        while (qh < qt) {
          var c = queue[qh++], cx = c % nx, cy = (c / nx) | 0;
          if (cx + 1 < nx && D[c + 1] && !wall[c + 1] && label[c + 1] < 0) { label[c + 1] = L; queue[qt++] = c + 1; }
          if (cx > 0 && D[c - 1] && !wall[c - 1] && label[c - 1] < 0) { label[c - 1] = L; queue[qt++] = c - 1; }
          if (cy + 1 < ny && D[c + nx] && !wall[c + nx] && label[c + nx] < 0) { label[c + nx] = L; queue[qt++] = c + nx; }
          if (cy > 0 && D[c - nx] && !wall[c - nx] && label[c - nx] < 0) { label[c - nx] = L; queue[qt++] = c - nx; }
        }
        sizes.push(qt);
      }
      var biggest = 0;
      sizes.forEach(function (s) { if (s > biggest) biggest = s; });
      if (!biggest) return refuse('the selection has no face in it (it is all wall)');
      // a small piece is work only if walls shut it in; a sliver of the outline's jagged edge, with no wall touching it, is face
      var walled = new Uint8Array(sizes.length);
      for (id = 0; id < N; id++) {
        if (!D[id] || !wall[id]) continue;
        var wx = id % nx, wy = (id / nx) | 0, wn = [wx + 1 < nx ? id + 1 : -1, wx > 0 ? id - 1 : -1, wy + 1 < ny ? id + nx : -1, wy > 0 ? id - nx : -1];
        for (var wq = 0; wq < 4; wq++) if (wn[wq] >= 0 && D[wn[wq]] && label[wn[wq]] >= 0) walled[label[wn[wq]]] = 1;
      }
      for (id = 0; id < N; id++) if (D[id] && label[id] >= 0 && (sizes[label[id]] >= o.faceMin * biggest || !walled[label[id]])) face[id] = 1;
      for (id = 0; id < N; id++) if (D[id] && !face[id]) { work[id] = 1; if (wall[id]) nWall++; }
      // widened by the walls' slopes
      for (var d = 0; d < o.dil; d++) {
        var add = [];
        for (id = 0; id < N; id++) {
          if (!face[id]) continue;
          var x = id % nx, y = (id / nx) | 0;
          if ((x + 1 < nx && work[id + 1]) || (x > 0 && work[id - 1]) || (y + 1 < ny && work[id + nx]) || (y > 0 && work[id - nx])) add.push(id);
        }
        add.forEach(function (a) { face[a] = 0; work[a] = 1; });
      }
    }
    var nWork = 0;
    for (id = 0; id < N; id++) if (work[id]) nWork++;
    var S = new Float64Array(N).fill(NaN);
    for (id = 0; id < N; id++) if (face[id]) S[id] = H[id];
    for (id = 0; id < N; id++) if (!D[id] && !isNaN(H[id])) S[id] = H[id];       // the mesh just outside the rim: what is really there
    var info = { nodes: nodes, nWork: nWork, workArea: nWork * res * res, depth: 0, groups: 0 };
    if (nWork) {
      // How far each node is from the face, in steps, and which nodes are the ring of face round the work.
      var df = new Int32Array(N).fill(-1), dw = new Int32Array(N).fill(-1), fq = [], fh = 0, ringN = Math.max(6, Math.round(o.ring / res));
      for (id = 0; id < N; id++) if (face[id] && valid[id]) { df[id] = 0; fq.push(id); }
      while (fh < fq.length) {
        var c3 = fq[fh++], x4 = c3 % nx, y4 = (c3 / nx) | 0, nb4 = [x4 + 1 < nx ? c3 + 1 : -1, x4 > 0 ? c3 - 1 : -1, y4 + 1 < ny ? c3 + nx : -1, y4 > 0 ? c3 - nx : -1];
        for (var q4 = 0; q4 < 4; q4++) { var m4 = nb4[q4]; if (m4 < 0 || !D[m4] || df[m4] >= 0) continue; df[m4] = df[c3] + 1; fq.push(m4); }
      }
      fq = []; fh = 0;
      for (id = 0; id < N; id++) if (work[id]) { dw[id] = 0; fq.push(id); }
      while (fh < fq.length) {
        var c5 = fq[fh++];
        if (dw[c5] >= ringN) continue;
        var x5 = c5 % nx, y5 = (c5 / nx) | 0, nb5 = [x5 + 1 < nx ? c5 + 1 : -1, x5 > 0 ? c5 - 1 : -1, y5 + 1 < ny ? c5 + nx : -1, y5 > 0 ? c5 - nx : -1];
        for (var q5 = 0; q5 < 4; q5++) { var m5 = nb5[q5]; if (m5 < 0 || !D[m5] || dw[m5] >= 0) continue; dw[m5] = dw[c5] + 1; fq.push(m5); }
      }
      // The face, carried across: a quadratic fitted by moving least squares to the face round each node of a coarse
      // lattice over the work and its ring (the reach grows with how far the node is from any face), bilinear between.
      var cg = 6, cnx = Math.ceil(nx / cg) + 1, cny = Math.ceil(ny / cg) + 1, CP = new Float64Array(cnx * cny).fill(NaN), need = new Uint8Array(cnx * cny);
      for (id = 0; id < N; id++) if (dw[id] >= 0) need[Math.round(((id / nx) | 0) / cg) * cnx + Math.round((id % nx) / cg)] = 1;
      var sub = 2, maxFar = 0;
      for (id = 0; id < N; id++) if (work[id] && df[id] > maxFar) maxFar = df[id];
      var fitted = 0, thin = 0;
      for (var cj = 0; cj < cny; cj++) for (var ci = 0; ci < cnx; ci++) {
        if (!need[cj * cnx + ci]) continue;
        var gi = ci * cg, gj = cj * cg, near = 0, gid = Math.min(ny - 1, gj) * nx + Math.min(nx - 1, gi), dfc = df[gid] >= 0 ? df[gid] : maxFar;
        var rad = Math.min(Math.max(1.5, 1.6 * dfc * res + 1.0), 6.0), coef = null, tries;
        for (tries = 0; tries < 3 && !coef; tries++, rad *= 1.5) {
          var rn = Math.ceil(rad / res), A = [], bb = [], i0 = Math.max(0, gi - rn), i1 = Math.min(nx - 1, gi + rn), j0 = Math.max(0, gj - rn), j1 = Math.min(ny - 1, gj + rn);
          var nt = 6, M6 = new Float64Array(nt * nt), b6 = new Float64Array(nt), cnt = 0;
          for (var jj = j0 - (j0 % sub); jj <= j1; jj += sub) for (var ii = i0 - (i0 % sub); ii <= i1; ii += sub) {
            if (ii < 0 || jj < 0) continue;
            var nid = jj * nx + ii;
            if (!face[nid] || !valid[nid]) continue;
            var ddx = (ii - gi) * res, ddy = (jj - gj) * res, d2 = (ddx * ddx + ddy * ddy) / (rad * rad);
            if (d2 >= 1) continue;
            var wgt = (1 - d2) * (1 - d2), tt = polyTerms(ddx / rad, ddy / rad, 2);
            for (var r6 = 0; r6 < nt; r6++) { b6[r6] += wgt * tt[r6] * H[nid]; for (var c6 = 0; c6 < nt; c6++) M6[r6 * nt + c6] += wgt * tt[r6] * tt[c6]; }
            cnt++;
          }
          void A; void bb;
          if (cnt < 14) continue;
          var rows = [], ysv = [];
          // solve the 6 x 6 system M6 c = b6
          var Aug = [];
          for (var r7 = 0; r7 < nt; r7++) { Aug.push(Array.prototype.slice.call(M6, r7 * nt, r7 * nt + nt)); Aug[r7][r7] += 1e-9; Aug[r7].push(b6[r7]); }
          void rows; void ysv;
          var ok = true;
          for (var p7 = 0; p7 < nt && ok; p7++) {
            var piv = p7;
            for (var q7 = p7 + 1; q7 < nt; q7++) if (Math.abs(Aug[q7][p7]) > Math.abs(Aug[piv][p7])) piv = q7;
            var tmp7 = Aug[p7]; Aug[p7] = Aug[piv]; Aug[piv] = tmp7;
            if (Math.abs(Aug[p7][p7]) < 1e-12) { ok = false; break; }
            for (var q8 = p7 + 1; q8 < nt; q8++) { var f8 = Aug[q8][p7] / Aug[p7][p7]; for (var k8 = p7; k8 <= nt; k8++) Aug[q8][k8] -= f8 * Aug[p7][k8]; }
          }
          if (!ok) continue;
          coef = new Float64Array(nt);
          for (var r9 = nt - 1; r9 >= 0; r9--) { var sv = Aug[r9][nt]; for (var c9 = r9 + 1; c9 < nt; c9++) sv -= Aug[r9][c9] * coef[c9]; coef[r9] = sv / Aug[r9][r9]; }
          near = cnt;
        }
        void near;
        if (coef) { CP[cj * cnx + ci] = coef[0]; fitted++; } else thin++;
      }
      if (!fitted) return refuse('there is no face left round the work in this selection - make the crop larger, so its edge falls on clean face');
      var Pat = function (id2) {                                  // bilinear in the coarse lattice, NaN nodes left out
        var fx = (id2 % nx) / cg, fy = ((id2 / nx) | 0) / cg, i2 = Math.floor(fx), j2 = Math.floor(fy), tx = fx - i2, ty = fy - j2, sw = 0, sv2 = 0;
        for (var dj = 0; dj <= 1; dj++) for (var di = 0; di <= 1; di++) {
          var v = CP[(j2 + dj) * cnx + i2 + di];
          if (isNaN(v) || i2 + di >= cnx || j2 + dj >= cny) continue;
          var w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty);
          sw += w; sv2 += w * v;
        }
        return sw > 1e-9 ? sv2 / sw : NaN;
      };
      info.groups = fitted;
      // the residual of the real face on its fit, spread over the work by Laplace's equation
      var R = new Float64Array(N), freeList = [], inSys = new Uint8Array(N), PP = new Float64Array(N).fill(NaN);
      for (id = 0; id < N; id++) {
        if (dw[id] < 0) continue;
        var pv = Pat(id);
        PP[id] = pv;
        if (work[id]) { freeList.push(id); inSys[id] = 1; }
        else if (face[id] && valid[id] && !isNaN(pv)) { R[id] = H[id] - pv; inSys[id] = 1; }
      }
      relax(G, inSys, freeList, R, null, 0, 6000);
      var maxDepth = 0, lost = 0;
      for (id = 0; id < N; id++) {
        if (!work[id]) continue;
        if (isNaN(PP[id])) { lost++; continue; }
        S[id] = PP[id] + R[id];
        if (valid[id]) maxDepth = Math.max(maxDepth, Math.abs(H[id] - S[id]));
      }
      if (lost) {                                                // work too far from any fitted lattice node: borrow the neighbours' value
        for (var pass2 = 0; pass2 < 400 && lost; pass2++) {
          var filled = 0;
          for (id = 0; id < N; id++) {
            if (!work[id] || !isNaN(S[id])) continue;
            var x9 = id % nx, y9 = (id / nx) | 0, sx = 0, cx9 = 0;
            if (x9 + 1 < nx && !isNaN(S[id + 1])) { sx += S[id + 1]; cx9++; }
            if (x9 > 0 && !isNaN(S[id - 1])) { sx += S[id - 1]; cx9++; }
            if (y9 + 1 < ny && !isNaN(S[id + nx])) { sx += S[id + nx]; cx9++; }
            if (y9 > 0 && !isNaN(S[id - nx])) { sx += S[id - nx]; cx9++; }
            if (cx9) { S[id] = sx / cx9; filled++; }
          }
          lost -= filled;
          if (!filled) break;
        }
      }
      info.depth = maxDepth;
    }
    // a little beyond the domain, so a corner at the rim has four nodes round it
    for (var e = 0; e < 3; e++) {
      var fillList = [];
      for (id = 0; id < N; id++) {
        if (!isNaN(S[id])) continue;
        var x6 = id % nx, y6 = (id / nx) | 0, s6 = 0, c6 = 0;
        if (x6 + 1 < nx && !isNaN(S[id + 1])) { s6 += S[id + 1]; c6++; }
        if (x6 > 0 && !isNaN(S[id - 1])) { s6 += S[id - 1]; c6++; }
        if (y6 + 1 < ny && !isNaN(S[id + nx])) { s6 += S[id + nx]; c6++; }
        if (y6 > 0 && !isNaN(S[id - nx])) { s6 += S[id - nx]; c6++; }
        if (c6) fillList.push([id, s6 / c6]);
      }
      fillList.forEach(function (p) { S[p[0]] = p[1]; });
    }
    return { ok: true, G: G, S: S, D: D, H: H, work: work, face: face, valid: valid, info: info };
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

  /* ------------------------------------------------------------------- weaving */

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

  /* The new patch for a detached plate. opts: fit ('smooth' | 'follow'), pitch (mm; the plate's own edge by default),
     res (the height field's node spacing), tol... see DEFAULTS.
     -> { ok, newV (Float64Array: x y z per new corner), T (Int32Array: ids < nOld are the mesh's own corners, the rest
     are nOld + the index into newV), nOld, rim, stats } or a refusal. */
  function weave(M, pt, opts) {
    if (!CDT) return refuse('the mesher (nso_cdt.js) is not loaded');
    if (!pt || !pt.ok) return refuse(pt && pt.reason || 'nothing is detached');
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in opts || {}) if (opts[k] !== undefined && opts[k] !== null) o[k] = opts[k];
    var t0 = Date.now();
    var plate = plateEdge(M, pt.tris), pitch = o.pitch > 0 ? o.pitch : plate;
    if (!(pitch > 0)) return refuse('the plate has no triangle size to match');
    if (pt.flatArea / (0.433 * pitch * pitch) > o.maxTris) {
      return refuse('that patch would need about ' + String(Math.round(pt.flatArea / (0.433 * pitch * pitch))).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' triangles at a pitch of ' + fmt(pitch, 3) + ' mm - raise the pitch', { tooMany: true });
    }
    var res = o.res > 0 ? o.res : Math.min(0.12, Math.max(0.04, pitch / 3));
    var wBox = pt.box.hi[0] - pt.box.lo[0], hBox = pt.box.hi[1] - pt.box.lo[1];
    while ((wBox / res + 8) * (hBox / res + 8) > o.maxNodes) res *= 1.25;
    var ras = rasterize(M, pt, res);
    var fit = fitSurface(M, pt, ras, o, pitch);
    if (!fit.ok) return fit;
    var G = fit.G, fr = pt.frame;
    // the rim's mismatch with the surface, carried inward over rimDecay
    var rimZ = [], rimUV = [], loops = pt.loops, li, q, nRim = 0;
    function proj(v) {
      var w0 = M.P[3 * v] - fr.o[0], w1 = M.P[3 * v + 1] - fr.o[1], w2 = M.P[3 * v + 2] - fr.o[2];
      return [w0 * fr.e1[0] + w1 * fr.e1[1] + w2 * fr.e1[2], w0 * fr.e2[0] + w1 * fr.e2[1] + w2 * fr.e2[2], w0 * fr.n[0] + w1 * fr.n[1] + w2 * fr.n[2]];
    }
    var rimIds = [];
    for (li = 0; li < loops.length; li++) for (q = 0; q < loops[li].length; q++) { var p = proj(loops[li][q]); rimUV.push([p[0], p[1]]); rimZ.push(p[2]); rimIds.push(loops[li][q]); nRim++; }
    var N = G.N, delta = new Float64Array(N), cnt = new Float64Array(N), fixedIds = [], i, onWork = 0, worst = 0, rimOff = 0, rimBad = [], rimD = [];
    for (i = 0; i < nRim; i++) {
      var s0 = bilinear(G, fit.S, rimUV[i][0], rimUV[i][1]);
      if (isNaN(s0)) { rimD[i] = 0; continue; }
      var d = rimZ[i] - s0;
      rimD[i] = d;
      rimOff = Math.max(rimOff, Math.abs(d));
      var nid2 = Math.round((rimUV[i][1] - G.y0) / G.res) * G.nx + Math.round((rimUV[i][0] - G.x0) / G.res);
      if (nid2 < 0 || nid2 >= N) continue;
      if (!cnt[nid2]) fixedIds.push(nid2);
      delta[nid2] += d; cnt[nid2]++;
    }
    var tolRim = Math.max(0.03, 0.25 * fit.info.depth);
    if (o.fit !== 'follow') {
      for (i = 0; i < rimD.length; i++) if (Math.abs(rimD[i]) > tolRim) { onWork++; rimBad.push(rimIds[i]); worst = Math.max(worst, Math.abs(rimD[i])); }
    }
    if (onWork) {
      return refuse('the crop\'s edge cuts through the work: ' + onWork + ' of its ' + nRim + ' rim corners stand ' + fmt(worst, 2) + ' mm off the face, on the work. Widen the crop so its edge falls on clean face round the work.',
                    { rimOnWork: onWork, rimCorners: nRim, rimBad: rimBad });
    }
    var C = new Float64Array(N), inDom = new Uint8Array(N), free = [];
    for (i = 0; i < N; i++) if (!isNaN(fit.S[i])) { inDom[i] = 1; }
    fixedIds.forEach(function (id) { C[id] = delta[id] / cnt[id]; });
    var isFixed = new Uint8Array(N);
    fixedIds.forEach(function (id) { isFixed[id] = 1; });
    for (i = 0; i < N; i++) if (inDom[i] && !isFixed[i]) free.push(i);
    var kappa2 = Math.pow(G.res / o.rimDecay, 2);
    relax(G, inDom, free, C, isFixed, kappa2, 2500);
    // the corners: the rim's own, then the new ones, on the surface
    var fill = CDT.fill(pt.loops2, { pitch: pitch, maxTris: o.maxTris });
    if (!fill.ok) return refuse('the new patch could not be woven: ' + fill.reason, { tooMany: !!fill.tooMany });
    if (fill.flat) return refuse('the new patch came out with ' + fill.flat + ' flat or turned triangles');
    var nNew = fill.P.length - fill.nRim, newV = new Float64Array(3 * nNew), bad = 0;
    for (i = 0; i < nNew; i++) {
      var u = fill.P[fill.nRim + i][0], v = fill.P[fill.nRim + i][1], z = bilinear(G, fit.S, u, v), c = bilinear(G, C, u, v);
      if (isNaN(z)) { z = 0; bad++; }
      if (!isNaN(c)) z += c;
      newV[3 * i] = fr.o[0] + u * fr.e1[0] + v * fr.e2[0] + z * fr.n[0];
      newV[3 * i + 1] = fr.o[1] + u * fr.e1[1] + v * fr.e2[1] + z * fr.n[1];
      newV[3 * i + 2] = fr.o[2] + u * fr.e1[2] + v * fr.e2[2] + z * fr.n[2];
    }
    if (bad) return refuse('the new patch has ' + bad + ' corners with no surface under them');
    // ids: the rim's points are the mesh's own corners
    var nOld = M.nV, T = new Int32Array(fill.T.length);
    for (i = 0; i < T.length; i++) T[i] = fill.T[i] < fill.nRim ? rimIds[fill.T[i]] : nOld + (fill.T[i] - fill.nRim);
    // numbers for the readout
    var lens = [], angs = [], flipped = 0, tmp = [0, 0, 0];
    function pos(id, out) {
      if (id < nOld) { out[0] = M.P[3 * id]; out[1] = M.P[3 * id + 1]; out[2] = M.P[3 * id + 2]; }
      else { var j2 = id - nOld; out[0] = newV[3 * j2]; out[1] = newV[3 * j2 + 1]; out[2] = newV[3 * j2 + 2]; }
    }
    var pa = [0, 0, 0], pb = [0, 0, 0], pc = [0, 0, 0];
    for (i = 0; i < T.length; i += 3) {
      pos(T[i], pa); pos(T[i + 1], pb); pos(T[i + 2], pc);
      var e = [Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]), Math.hypot(pc[0] - pb[0], pc[1] - pb[1], pc[2] - pb[2]), Math.hypot(pa[0] - pc[0], pa[1] - pc[1], pa[2] - pc[2])];
      lens.push(e[0], e[1], e[2]);
      var nx2 = (pb[1] - pa[1]) * (pc[2] - pa[2]) - (pb[2] - pa[2]) * (pc[1] - pa[1]), ny2 = (pb[2] - pa[2]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[2] - pa[2]), nz2 = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pb[1] - pa[1]) * (pc[0] - pa[0]);
      if (nx2 * fr.n[0] + ny2 * fr.n[1] + nz2 * fr.n[2] <= 0) flipped++;
      for (var a = 0; a < 3; a++) {
        var A = e[a], B = e[(a + 1) % 3], Cc = e[(a + 2) % 3], cs = (A * A + B * B - Cc * Cc) / (2 * A * B);
        angs.push(Math.acos(Math.max(-1, Math.min(1, cs))) * 180 / Math.PI);
      }
    }
    void tmp;
    lens.sort(function (x, y) { return x - y; }); angs.sort(function (x, y) { return x - y; });
    var stats = {
      oldTris: pt.tris.length, newTris: T.length / 3, rimCorners: nRim, newCorners: nNew, pitch: pitch, plateEdge: plate, res: res,
      edgeP50: lens[lens.length >> 1], edgeP5: lens[(lens.length * 0.05) | 0], edgeP95: lens[(lens.length * 0.95) | 0],
      angleMin: angs[0], angleP1: angs[(angs.length * 0.01) | 0], angleP5: angs[(angs.length * 0.05) | 0],
      flipped: flipped, rimOff: rimOff, workArea: fit.info.workArea, workDepth: fit.info.depth, workGroups: fit.info.groups,
      area: pt.area, fit: o.fit, ms: Date.now() - t0
    };
    return { ok: true, newV: newV, T: T, nOld: nOld, rim: rimIds, stats: stats, work: fit.work, grid: G, surface: fit.S, valid: fit.valid, H: fit.H, face: fit.face };
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
              centroid: centroid, patch: patch, weave: weave, apply: apply, plan: plan, plateEdge: plateEdge, _rasterize: rasterize, _fit: fitSurface };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Weave = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
