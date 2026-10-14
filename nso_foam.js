/* nso_foam.js - Foam: fill an enclosed hollow from the bottom up, to a level.

   Loads as a classic script (window.NSO_Foam) and as a Node module
   (require('../nso_foam.js')). No DOM, no Three.js: a mesh is the app's raw
   soup (9 numbers per triangle, Z up, millimetres).

   READ docs/FOAM.md FIRST - it has the model, the numbers it was checked on
   (tools/nso_foam_test.js) and what it deliberately does not do.

   ---------------------------------------------------------------------------
   WHAT IT IS
   ---------------------------------------------------------------------------
   Fill / Densify (nso_hollow.js fill) drops the shells that bound enclosed
   cavities, all at once. Foam is its visible, partial counterpart: ONE cavity,
   filled from its lowest point up to a LEVEL, the way a liquid rises.

     cavity   a shell that bounds a closed void inside the piece, found by
              nso_hollow.js cavityShells() - the test fill() itself uses, so a
              captive separate solid is never a cavity here either.
     up       the plate's vertical as the piece lies, given in the piece's raw
              axes (opts.up). Unposed it is raw +Z.
     level    a height along `up`, measured from the cavity's lowest point.

   Setting the foam cuts the cavity's shell with the flat plane at the level.
   The part ABOVE stays a cavity, and the cut is closed by a flat floor facing
   up into what is left of the void. Below the level is now solid. Nothing
   else in the piece is touched: every triangle that is not on this cavity's
   shell is copied in its original order, bit for bit.

     level at the floor   nothing changes - the soup comes back as it went in
     level at the top     the shell is dropped whole, which is exactly what
                          Fill / Densify gives for that cavity (same triangles,
                          same order)
     in between           the shell above the level, plus the floor. A cavity
                          that splits into separate pockets above the level
                          comes back as separate closed shells, one per pocket.

   THE CUT IS THE CUT ENGINE'S. rawCut (app-cut.js) - weld, snap, clip, nest
   the section's loops, cap, split degenerates - is what Cut and Lift run. It
   cuts a solid, so the cavity's shell is turned inside out (the void as a
   solid, wound outward), cut, and turned back. No boolean is needed or used:
   a plane through one closed shell is all this is.

   A plate vertical that is not one of the raw axes (a piece laid on a slanted
   face) is turned into a frame where it is +Z, cut there, and mapped back.
   Every corner the cut did not make is mapped back to the raw vertex it came
   from, so even then the cavity's untouched triangles are the original ones.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   analyse(soup, opts)                -> { ok, kind, reason, cavities, frame }
       kind: 'cavities' | 'none' | 'open' | 'unconfirmed' | 'empty'.
       opts.up: raw direction.
       cavities[i]: { id, faces, volume, shellVolume, lo, hi, height,
       captives:[{lo,hi,volume}] }. lo / hi are along `up`, in mm. volume is
       the EMPTY space: the shell's volume less any captive solid inside it.
   preview(soup, A, id, height, deps) -> { ok, foam, ring, foamVolume,
                                          fraction, captiveCross, reason }
       foam: the solid below the level (raw soup, wound outward) - what the
       app draws in orange. ring: the level's line round the cavity wall, as
       segments (6 numbers each).
   foam(soup, A, id, height, opts)    -> { ok, changed, soup, removedVolume,
                                          remainingVolume, fraction, pockets,
                                          changedFaces, reason }
       opts.skipList IS REQUIRED: nsoMaskFaceList(m), the painted faces. It is
       not optional with an "unpainted" default, because unpainted is the value
       a caller gets by forgetting (docs/HANDOFF.md, "paint wins").
       opts.rawCut / deps.rawCut: the cut engine, else the global.
   readout(fraction, volume)          -> "Foam: 42% of the hollow, 7,396 mm³"
   census(soup)                       -> { tris, open, nm, degen, closed }

   Refusals follow the house contract: ok false, reason in plain words, and
   `soup` is the ORIGINAL soup.

   PAINT SCOPE: SUB-REGION (docs/HANDOFF.md, "Scoping"). Foam changes only
   the faces of the cavity it fills - the ones the level reaches. A painted
   face among them stands it down, named; paint anywhere else does not.
*/
(function (root) {
  'use strict';

  var NODE = (typeof module !== 'undefined' && module.exports);
  var H = NODE ? require('./nso_hollow.js') : null;

  /* app-cut.js's weld radius (RAW_CUT_WELD_TOL). A level closer than this to
     the cavity's floor or ceiling is the floor or the ceiling: rawCut would
     snap the corners there onto the plane anyway. */
  var EDGE_TOL = 1e-4;
  /* app-mask.js's own tolerances for "the same face": N_TOL on the normal,
     D_TOL on the plane offset. Read from there, never loosened here. */
  var MASK_N_TOL = 0.02, MASK_D_TOL = 0.05;
  /* Open-vessel probe: samples per axis over the piece's box. */
  var OPEN_SAMPLES = 16;

  function hollowMod() {
    if (!H && root) H = root.NSO_Hollow;
    if (!H || typeof H.cavityShells !== 'function') {
      throw new Error('nso_foam.js needs nso_hollow.js (cavityShells) - a cavity is what Fill / Densify says it is');
    }
    return H;
  }
  function dep(deps, name) {
    return (deps && deps[name]) || (root && root[name]) ||
           (typeof globalThis !== 'undefined' ? globalThis[name] : null) || null;
  }

  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : null; }
  function f1(x) { return (Math.round(x * 10) / 10).toFixed(1); }
  function grouped(x) {
    var s = String(Math.round(x)), neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    for (var i = s.length - 3; i > 0; i -= 3) s = s.slice(0, i) + ',' + s.slice(i);
    return (neg ? '-' : '') + s;
  }

  /* ===================================================================
     The frame: `up` becomes +Z
     =================================================================== */

  /* A right-handed frame (e1, e2, n) with n = up. When up is a raw axis the
     frame is that axis and two others with signs - every mapping is then a
     permutation with signs, exact in floating point, so a cut on a piece
     lying on its side moves no coordinate it does not cut. */
  var AXIS_FRAMES = {
    '2,1': [[1, 0, 0], [0, 1, 0]], '2,-1': [[1, 0, 0], [0, -1, 0]],
    '0,1': [[0, 1, 0], [0, 0, 1]], '0,-1': [[0, 1, 0], [0, 0, -1]],
    '1,1': [[0, 0, 1], [1, 0, 0]], '1,-1': [[0, 0, 1], [-1, 0, 0]]
  };
  function frameFor(up) {
    var u = norm(up || [0, 0, 1]) || [0, 0, 1];
    for (var k = 0; k < 3; k++) {
      if (Math.abs(u[k]) > 1 - 1e-9) {
        var sg = u[k] > 0 ? 1 : -1, n = [0, 0, 0];
        n[k] = sg;
        var E = AXIS_FRAMES[k + ',' + sg];
        return { e1: E[0], e2: E[1], n: n, axis: k, sign: sg };
      }
    }
    var helper = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    var e1 = norm(cross(helper, u)), e2 = cross(u, e1);
    return { e1: e1, e2: e2, n: u, axis: -1, sign: 0 };
  }
  function toF(F, x, y, z) {
    return [x * F.e1[0] + y * F.e1[1] + z * F.e1[2],
            x * F.e2[0] + y * F.e2[1] + z * F.e2[2],
            x * F.n[0] + y * F.n[1] + z * F.n[2]];
  }
  function fromF(F, q) {
    return [q[0] * F.e1[0] + q[1] * F.e2[0] + q[2] * F.n[0],
            q[0] * F.e1[1] + q[1] * F.e2[1] + q[2] * F.n[1],
            q[0] * F.e1[2] + q[1] * F.e2[2] + q[2] * F.n[2]];
  }

  /* ===================================================================
     Small mesh tools
     =================================================================== */

  function signedVolume(soup) {
    var v = 0;
    for (var o = 0; o + 8 < soup.length; o += 9) {
      v += soup[o] * (soup[o + 4] * soup[o + 8] - soup[o + 5] * soup[o + 7]) -
           soup[o + 1] * (soup[o + 3] * soup[o + 8] - soup[o + 5] * soup[o + 6]) +
           soup[o + 2] * (soup[o + 3] * soup[o + 7] - soup[o + 4] * soup[o + 6]);
    }
    return v / 6;
  }

  /** Closed and manifold, by exact corners: every directed edge once, and its
      twin once. Degenerate: a repeated corner or no area. nso_lift.js's
      census, the same rule, so "closed" means one thing to both. */
  function census(soup) {
    var nt = Math.floor(soup.length / 9), key = new Map(), nv = 0, ids = new Int32Array(nt * 3);
    for (var i = 0; i < nt * 3; i++) {
      var o = i * 3, k = soup[o] + ',' + soup[o + 1] + ',' + soup[o + 2], id = key.get(k);
      if (id == null) { id = nv++; key.set(k, id); }
      ids[i] = id;
    }
    var dir = new Map(), degen = 0, nm = 0, open = 0;
    for (var t = 0; t < nt; t++) {
      var a = ids[t * 3], b = ids[t * 3 + 1], c = ids[t * 3 + 2], p = t * 9;
      var cr = cross([soup[p + 3] - soup[p], soup[p + 4] - soup[p + 1], soup[p + 5] - soup[p + 2]],
                     [soup[p + 6] - soup[p], soup[p + 7] - soup[p + 1], soup[p + 8] - soup[p + 2]]);
      if (a === b || b === c || a === c || Math.hypot(cr[0], cr[1], cr[2]) < 1e-12) degen++;
      var es = [[a, b], [b, c], [c, a]];
      for (var e = 0; e < 3; e++) {
        var kk = es[e][0] * nv + es[e][1];
        dir.set(kk, (dir.get(kk) || 0) + 1);
      }
    }
    dir.forEach(function (cnt, kk) {
      var a2 = Math.floor(kk / nv), b2 = kk - a2 * nv;
      if (a2 === b2) return;
      var tw = dir.get(b2 * nv + a2) || 0;
      if (tw && a2 > b2) return;
      if (cnt > 1 || tw > 1) nm++;
      else if (!tw) open++;
    });
    return { tris: nt, open: open, nm: nm, degen: degen, closed: open === 0 && nm === 0 };
  }

  /* Edge-connected pieces of a soup, by exact corners: how many separate
     pockets a cut left. */
  function components(soup) {
    var nt = Math.floor(soup.length / 9), key = new Map(), nv = 0, ids = new Int32Array(nt * 3);
    for (var i = 0; i < nt * 3; i++) {
      var o = i * 3, k = soup[o] + ',' + soup[o + 1] + ',' + soup[o + 2], id = key.get(k);
      if (id == null) { id = nv++; key.set(k, id); }
      ids[i] = id;
    }
    var parent = new Int32Array(nt);
    for (var t = 0; t < nt; t++) parent[t] = t;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    var owner = new Map();
    for (t = 0; t < nt; t++) {
      for (var e = 0; e < 3; e++) {
        var a = ids[t * 3 + e], b = ids[t * 3 + (e + 1) % 3];
        var kk = (a < b ? a : b) * nv + (a < b ? b : a);
        var w = owner.get(kk);
        if (w == null) owner.set(kk, t);
        else { var r1 = find(t), r2 = find(w); if (r1 !== r2) parent[r1] = r2; }
      }
    }
    var roots = new Set();
    for (t = 0; t < nt; t++) roots.add(find(t));
    return roots.size;
  }

  /* Does a ray from p along d cross this face list an odd number of times?
     Möller-Trumbore, on an oblique direction no axis-aligned face grazes. */
  var ODD_DIR = norm([0.5772, 0.3101, 0.7556]);
  function insideFaces(soup, faces, p) {
    var d = ODD_DIR, hits = 0;
    for (var q = 0; q < faces.length; q++) {
      var o = faces[q] * 9;
      var e1 = [soup[o + 3] - soup[o], soup[o + 4] - soup[o + 1], soup[o + 5] - soup[o + 2]];
      var e2 = [soup[o + 6] - soup[o], soup[o + 7] - soup[o + 1], soup[o + 8] - soup[o + 2]];
      var h = cross(d, e2), a = dot(e1, h);
      if (Math.abs(a) < 1e-14) continue;
      var f = 1 / a, s = [p[0] - soup[o], p[1] - soup[o + 1], p[2] - soup[o + 2]];
      var u = f * dot(s, h);
      if (u < 0 || u > 1) continue;
      var qv = cross(s, e1), v = f * dot(d, qv);
      if (v < 0 || u + v > 1) continue;
      if (f * dot(e2, qv) > 1e-9) hits++;
    }
    return (hits & 1) === 1;
  }

  /* A shell's span along `up`. */
  function spanOf(soup, faces, F) {
    var lo = Infinity, hi = -Infinity;
    for (var q = 0; q < faces.length; q++) {
      var o = faces[q] * 9;
      for (var c = 0; c < 3; c++) {
        var z = soup[o + c * 3] * F.n[0] + soup[o + c * 3 + 1] * F.n[1] + soup[o + c * 3 + 2] * F.n[2];
        if (z < lo) lo = z;
        if (z > hi) hi = z;
      }
    }
    return { lo: lo, hi: hi };
  }

  /* ===================================================================
     analyse: which hollows does this piece have?
     =================================================================== */

  /* No sealed cavity - but is the piece a vessel, a hollow open to the
     outside? Asked on a grid of points in the piece's box that are NOT in
     material: one that has the piece below it and on all four sides of it
     (rays along -up, +-e1, +-e2) sits in a basin a liquid would stay in - a
     cup, a vase, a pocket. Two such points and the piece is called open. A
     bracket's corner or a channel's floor escapes sideways; an arch has
     nothing below it but the plate. */
  function openVessel(P, F) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var t = 0; t < P.tris.length; t++) {
      for (var c = 0; c < 3; c++) {
        var p = P.tris[t][c], q = toF(F, p[0], p[1], p[2]);
        for (var a = 0; a < 3; a++) { if (q[a] < lo[a]) lo[a] = q[a]; if (q[a] > hi[a]) hi[a] = q[a]; }
      }
    }
    var dirs = [F.e1, [-F.e1[0], -F.e1[1], -F.e1[2]], F.e2, [-F.e2[0], -F.e2[1], -F.e2[2]]];
    var down = [-F.n[0], -F.n[1], -F.n[2]];
    var reach = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 1;
    var N = OPEN_SAMPLES, basin = 0;
    for (var i = 0; i < N; i++) {
      for (var j = 0; j < N; j++) {
        for (var k = 0; k < N; k++) {
          var qf = [lo[0] + (i + 0.5) / N * (hi[0] - lo[0]),
                    lo[1] + (j + 0.5) / N * (hi[1] - lo[1]),
                    lo[2] + (k + 0.5) / N * (hi[2] - lo[2])];
          var pr = fromF(F, qf);
          if (P.inside(pr)) continue;
          if (!P.hitsAlong(pr, down, reach).length) continue;
          var walled = true;
          for (var d = 0; d < 4 && walled; d++) if (!P.hitsAlong(pr, dirs[d], reach).length) walled = false;
          if (walled && ++basin >= 2) return true;
        }
      }
    }
    return false;
  }

  function analyse(soup, opts) {
    opts = opts || {};
    var F = frameFor(opts.up);
    var out = { ok: false, kind: 'empty', reason: '', cavities: [], frame: F, shells: 0 };
    if (!soup || soup.length < 9) { out.reason = 'Foam: the piece is empty - nothing to fill.'; return out; }
    var C = hollowMod().cavityShells(soup, opts);
    if (!C) { out.reason = 'Foam: the piece is empty - nothing to fill.'; return out; }
    out.shells = C.shells.length;
    var solids = [];
    for (var s = 0; s < C.shells.length; s++) {
      if (C.info[s].cavity) {
        var sp = spanOf(soup, C.shells[s], F);
        out.cavities.push({ id: out.cavities.length, shell: s, faces: C.shells[s],
                            volume: -C.info[s].vol, shellVolume: -C.info[s].vol,
                            lo: sp.lo, hi: sp.hi, height: sp.hi - sp.lo, captives: [] });
      } else if (C.info[s].vol > 0) solids.push(s);
    }
    /* A captive solid - a rattle's ball - is an outward shell sitting inside a
       cavity's void. It is never a cavity and never touched; the foam may rise
       past it, embedding it the way Fill does, but its surface may not stop
       inside it (foam() says so). */
    out.cavities.forEach(function (cv) {
      solids.forEach(function (s2) {
        var o = C.shells[s2][0] * 9;
        var p = [(soup[o] + soup[o + 3] + soup[o + 6]) / 3, (soup[o + 1] + soup[o + 4] + soup[o + 7]) / 3,
                 (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3];
        if (insideFaces(soup, cv.faces, p)) {
          var sp2 = spanOf(soup, C.shells[s2], F);
          var ks = C.shells[s2].slice().sort(function (a, b) { return a - b; });
          cv.captives.push({ shell: s2, faces: ks, lo: sp2.lo, hi: sp2.hi, volume: C.info[s2].vol });
          cv.volume -= C.info[s2].vol;
        }
      });
    });
    if (out.cavities.length) {
      out.ok = true;
      out.kind = 'cavities';
      out.reason = 'Hollows found: ' + out.cavities.map(function (cv) {
        return 'Hollow ' + (cv.id + 1) + ' - ' + grouped(cv.volume) + ' mm³';
      }).join(', ') + '.';
      return out;
    }
    /* An inward-wound shell the cavity test could not confirm is in material:
       Fill / Densify leaves it alone, so Foam does too - and says what it is
       rather than guess. Wall thickness no longer lands here - cavityShells()
       probes across the whole piece - so what does is a shell wound inward
       that is not in material: most often a separate body saved inside out. */
    var mis = C.info.filter(function (x) { return x.misWound; }).length;
    if (mis) {
      out.kind = 'unconfirmed';
      out.reason = 'Foam: this piece has ' + mis + ' inner shell' + (mis === 1 ? '' : 's') + ' facing inward that ' +
        'Fill / Densify\'s test could not confirm as a sealed hollow - it is not sitting inside material, which ' +
        'is what a separate body saved inside out looks like. Foam finds hollows the way Fill does, so it leaves ' +
        (mis === 1 ? 'it' : 'them') + ' alone. Nothing changed.';
      return out;
    }
    if (openVessel(C.P, F)) {
      out.kind = 'open';
      out.reason = 'Foam: this piece\'s hollow is open to the outside, like a cup or a vase. Foam fills a ' +
        'sealed hollow only - open vessels come later. Nothing changed.';
      return out;
    }
    out.kind = 'none';
    out.reason = 'Foam: this piece has no enclosed hollow - it is solid all the way through, so there is ' +
      'nothing to fill. Nothing changed.';
    return out;
  }

  /* ===================================================================
     The cut
     =================================================================== */

  /* The cavity's shell in the frame, turned inside out: the void as a solid
     wound outward, which is what rawCut cuts. `back` maps each corner (as
     float32, the way rawCut hands it back) to the raw vertex it came from. */
  function voidSolid(soup, cv, F) {
    var out = new Array(cv.faces.length * 9), back = new Map(), at = 0;
    for (var q = 0; q < cv.faces.length; q++) {
      var o = cv.faces[q] * 9;
      var order = [0, 2, 1];
      for (var c = 0; c < 3; c++) {
        var v = o + order[c] * 3;
        var p = toF(F, soup[v], soup[v + 1], soup[v + 2]);
        out[at++] = p[0]; out[at++] = p[1]; out[at++] = p[2];
        back.set(Math.fround(p[0]) + ',' + Math.fround(p[1]) + ',' + Math.fround(p[2]),
                 [soup[v], soup[v + 1], soup[v + 2]]);
      }
    }
    return { soup: out, back: back };
  }

  /* Frame soup -> raw soup. flip: turn the winding back inside out. */
  function toRaw(fs, F, back, flip) {
    var out = new Float32Array(fs.length);
    var order = flip ? [0, 2, 1] : [0, 1, 2];
    for (var t = 0; t < fs.length; t += 9) {
      for (var c = 0; c < 3; c++) {
        var o = t + order[c] * 3;
        var p = back && back.get(fs[o] + ',' + fs[o + 1] + ',' + fs[o + 2]);
        if (!p) p = fromF(F, [fs[o], fs[o + 1], fs[o + 2]]);
        out[t + c * 3] = p[0]; out[t + c * 3 + 1] = p[1]; out[t + c * 3 + 2] = p[2];
      }
    }
    return out;
  }

  /* rawCut's keepMin=true keeps coord >= plane (see rawClipTrianglesAtPlane),
     and caps facing -axis, outward from what it kept. So on the void-solid:
     true keeps the void ABOVE the level (what stays a cavity), false keeps
     the void BELOW it (the foam). */
  function cutVoid(V, level, keepAbove, rawCut) {
    var r = rawCut(V.soup, 2, level, !!keepAbove);
    return (r && r.length >= 9) ? r : null;
  }

  function cavityOf(A, id) {
    if (!A || !A.ok) return null;
    return A.cavities[id] || null;
  }

  /* Height above the floor -> the plane, clamped to the cavity. */
  function levelOf(cv, height) {
    var h = +height;
    if (!(h >= 0)) h = 0;
    if (h > cv.height) h = cv.height;
    return { h: h, z: cv.lo + h, atFloor: h <= EDGE_TOL, atTop: h >= cv.height - EDGE_TOL };
  }

  function captiveCross(cv, z) {
    for (var i = 0; i < cv.captives.length; i++) {
      var k = cv.captives[i];
      if (z > k.lo + EDGE_TOL && z < k.hi - EDGE_TOL) return k;
    }
    return null;
  }

  /* How much of the captive solids sits below the level - space the cavity's
     shell encloses but that was never empty, so it is not foam. A captive the
     level passes through is cut the same way the void is (preview only: Set
     refuses that level). */
  function captiveBelow(soup, cv, F, z, rawCut) {
    var v = 0;
    for (var i = 0; i < cv.captives.length; i++) {
      var k = cv.captives[i];
      if (k.hi <= z + EDGE_TOL) { v += k.volume; continue; }
      if (k.lo >= z - EDGE_TOL) continue;
      var fs = [];
      for (var q = 0; q < k.faces.length; q++) {
        var o = k.faces[q] * 9;
        for (var c = 0; c < 3; c++) {
          var p = toF(F, soup[o + c * 3], soup[o + c * 3 + 1], soup[o + c * 3 + 2]);
          fs.push(p[0], p[1], p[2]);
        }
      }
      try { var cut = rawCut(fs, 2, z, false); if (cut) v += signedVolume(cut); } catch (e) { /* preview only */ }
    }
    return v;
  }

  /* The level's line round the cavity wall, as raw segments. */
  function ringAt(soup, cv, F, z) {
    var segs = [];
    for (var q = 0; q < cv.faces.length; q++) {
      var o = cv.faces[q] * 9, P = [], D = [];
      for (var c = 0; c < 3; c++) {
        P.push(toF(F, soup[o + c * 3], soup[o + c * 3 + 1], soup[o + c * 3 + 2]));
        D.push(P[c][2] - z);
      }
      var pts = [];
      for (var e = 0; e < 3; e++) {
        var a = P[e], b = P[(e + 1) % 3], da = D[e], db = D[(e + 1) % 3];
        if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
          var t = da / (da - db);
          pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z]);
        }
      }
      if (pts.length === 2) {
        var r0 = fromF(F, pts[0]), r1 = fromF(F, pts[1]);
        segs.push(r0[0], r0[1], r0[2], r1[0], r1[1], r1[2]);
      }
    }
    return new Float32Array(segs);
  }

  function readout(fraction, volume) {
    return 'Foam: ' + Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '% of the hollow, ' +
      grouped(volume) + ' mm³';
  }

  /* ===================================================================
     preview: what the app draws while the foam rises
     =================================================================== */

  function preview(soup, A, id, height, deps) {
    var cv = cavityOf(A, id);
    if (!cv) return { ok: false, reason: 'Foam: there is no hollow ' + (id + 1) + ' on this piece.' };
    var rawCut = dep(deps, 'rawCut');
    if (typeof rawCut !== 'function') return { ok: false, reason: 'Foam needs the cut engine (app-cut.js, rawCut)' };
    var F = A.frame, L = levelOf(cv, height);
    var out = { ok: true, height: L.h, level: L.z, foam: new Float32Array(0), ring: new Float32Array(0),
                foamVolume: 0, embeddedVolume: 0, fraction: 0, captiveCross: captiveCross(cv, L.z), reason: '' };
    if (L.atTop) {
      var V0 = voidSolid(soup, cv, F);
      out.foam = toRaw(V0.soup, F, V0.back, false);
      out.foamVolume = cv.volume;
      out.embeddedVolume = cv.shellVolume - cv.volume;
      out.fraction = 1;
    } else if (!L.atFloor) {
      var V = voidSolid(soup, cv, F), below;
      try { below = cutVoid(V, L.z, false, rawCut); }
      catch (e) { return { ok: false, reason: 'Foam: the hollow could not be cut at this level (' + ((e && e.message) || e) + ')' }; }
      if (below) {
        out.foam = toRaw(below, F, V.back, false);
        out.embeddedVolume = captiveBelow(soup, cv, F, L.z, rawCut);
        out.foamVolume = signedVolume(below) - out.embeddedVolume;
        out.fraction = cv.volume > 0 ? out.foamVolume / cv.volume : 0;
      }
      out.ring = ringAt(soup, cv, F, L.z);
    }
    out.reason = readout(out.fraction, out.foamVolume);
    return out;
  }

  /* ===================================================================
     foam: set it
     =================================================================== */

  /* Which painted face, if any, is among the faces this foam changes? A face
     changes when the level reaches any corner of it (rawCut snaps a corner
     within its weld radius of the plane onto it), and at the top every face
     of the shell goes. The skip list is nsoMaskFaceList's, read as it was
     recorded: a face is the plane on its axis and side. */
  function paintedAmong(soup, faces, skipList) {
    if (!skipList.length) return null;
    for (var q = 0; q < faces.length; q++) {
      var o = faces[q] * 9;
      var N = norm(cross([soup[o + 3] - soup[o], soup[o + 4] - soup[o + 1], soup[o + 5] - soup[o + 2]],
                         [soup[o + 6] - soup[o], soup[o + 7] - soup[o + 1], soup[o + 8] - soup[o + 2]]));
      if (!N) continue;
      var c = [(soup[o] + soup[o + 3] + soup[o + 6]) / 3, (soup[o + 1] + soup[o + 4] + soup[o + 7]) / 3,
               (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3];
      for (var i = 0; i < skipList.length; i++) {
        var e = skipList[i], n = [0, 0, 0];
        n[e.axisIdx] = e.keepMin ? -1 : 1;
        if (Math.abs(N[0] - n[0]) < MASK_N_TOL && Math.abs(N[1] - n[1]) < MASK_N_TOL &&
            Math.abs(N[2] - n[2]) < MASK_N_TOL && Math.abs(dot(n, c) - e.d) < MASK_D_TOL) {
          return { index: i, entry: e, face: faces[q] };
        }
      }
    }
    return null;
  }

  function faceWord(e) {
    return (e.inner ? 'the inner ' : 'the ') + 'XYZ'.charAt(e.axisIdx) + (e.keepMin ? '-' : '+') +
      ' face at ' + (+e.d).toFixed(2);
  }

  function foam(soup, A, id, height, opts) {
    opts = opts || {};
    var out = { ok: false, changed: false, soup: soup, reason: '', removedVolume: 0, remainingVolume: 0, embeddedVolume: 0,
                fraction: 0, pockets: 0, changedFaces: 0, height: 0, level: null };
    var cv = cavityOf(A, id);
    if (!cv) { out.reason = 'Foam: there is no hollow ' + (id + 1) + ' on this piece. Nothing changed.'; return out; }
    if (!Array.isArray(opts.skipList)) {
      out.reason = 'Foam needs the paint skip list (nsoMaskFaceList) - it is never assumed empty. Nothing changed.';
      return out;
    }
    var rawCut = dep(opts, 'rawCut');
    if (typeof rawCut !== 'function') { out.reason = 'Foam needs the cut engine (app-cut.js, rawCut). Nothing changed.'; return out; }
    var F = A.frame, L = levelOf(cv, height);
    out.height = L.h;
    out.level = L.z;
    out.remainingVolume = cv.volume;
    if (L.atFloor) {
      out.ok = true;
      out.reason = 'Foam: the level is at the floor of hollow ' + (cv.id + 1) + ' - nothing to set. Nothing changed.';
      return out;
    }
    var k = captiveCross(cv, L.z);
    if (k) {
      out.reason = 'Foam: the foam\'s surface would run through the loose solid inside hollow ' + (cv.id + 1) +
        ' (it sits from ' + f1(k.lo - cv.lo) + ' to ' + f1(k.hi - cv.lo) + ' mm above the floor). Set the level ' +
        'below ' + f1(k.lo - cv.lo) + ' mm or above ' + f1(k.hi - cv.lo) + ' mm. Nothing changed.';
      out.captive = k;
      return out;
    }

    /* The faces this level changes, and the paint test on exactly those. */
    var touched = [];
    for (var q = 0; q < cv.faces.length; q++) {
      if (L.atTop) { touched.push(cv.faces[q]); continue; }
      var o = cv.faces[q] * 9, zmin = Infinity;
      for (var c = 0; c < 3; c++) {
        var z = soup[o + c * 3] * F.n[0] + soup[o + c * 3 + 1] * F.n[1] + soup[o + c * 3 + 2] * F.n[2];
        if (z < zmin) zmin = z;
      }
      if (zmin < L.z + EDGE_TOL) touched.push(cv.faces[q]);
    }
    var painted = paintedAmong(soup, touched, opts.skipList);
    if (painted) {
      var name = (typeof opts.faceName === 'function') ? opts.faceName(painted.index) : null;
      out.reason = 'Foam stood down - ' + (name || faceWord(painted.entry)) + ' is painted, and it is a wall of ' +
        'hollow ' + (cv.id + 1) + ' the foam would change. Paint elsewhere does not matter; clear this face\'s ' +
        'paint to foam here. Nothing changed.';
      out.painted = painted;
      return out;
    }

    var above = null, V = voidSolid(soup, cv, F);
    if (!L.atTop) {
      try { above = cutVoid(V, L.z, true, rawCut); }
      catch (e) {
        out.reason = 'Foam: hollow ' + (cv.id + 1) + ' could not be cut at this level (' + ((e && e.message) || e) +
          '). Nothing changed.';
        return out;
      }
    }

    /* Every face not on this shell, in its own order; then the cavity that is
       left, turned back to face into the void. At the top nothing is
       appended, so this is fill()'s own drop-and-copy for this shell. */
    var drop = new Uint8Array(soup.length / 9);
    for (var d = 0; d < cv.faces.length; d++) drop[cv.faces[d]] = 1;
    var keepN = 0;
    for (var t = 0; t < drop.length; t++) if (!drop[t]) keepN++;
    var rest = above ? toRaw(above, F, V.back, true) : new Float32Array(0);
    var res = new Float32Array(keepN * 9 + rest.length), at = 0;
    for (t = 0; t < drop.length; t++) {
      if (drop[t]) continue;
      for (var i = 0; i < 9; i++) res[at + i] = soup[t * 9 + i];
      at += 9;
    }
    res.set(rest, at);

    /* The shell's volume left above the level, and the captive solids now
       held in the foam (all of each one, or Set would have refused). */
    var shellLeft = above ? signedVolume(above) : 0;
    var embedded = 0;
    for (var ci = 0; ci < cv.captives.length; ci++) if (cv.captives[ci].hi <= L.z + EDGE_TOL) embedded += cv.captives[ci].volume;
    var remaining = shellLeft - (cv.shellVolume - cv.volume - embedded);
    var cs = census(res), src = census(soup);
    if (src.closed && (!cs.closed || cs.degen)) {
      out.reason = 'Foam: the piece would not stay closed (' + cs.open + ' open, ' + cs.nm + ' non-manifold, ' +
        cs.degen + ' degenerate edges) - nothing changed.';
      return out;
    }
    out.ok = true;
    out.changed = true;
    out.soup = res;
    out.census = cs;
    out.changedFaces = touched.length;
    out.remainingVolume = remaining;
    out.removedVolume = cv.volume - remaining;
    out.embeddedVolume = embedded;
    out.fraction = cv.volume > 0 ? out.removedVolume / cv.volume : 1;
    out.pockets = above ? components(above) : 0;
    out.reason = 'Foam set in hollow ' + (cv.id + 1) + ' - ' + grouped(out.removedVolume) + ' mm³ now solid (' +
      Math.round(out.fraction * 100) + '% of it)' +
      (L.atTop ? ', the hollow is gone' :
        ', ' + grouped(remaining) + ' mm³ still hollow above a flat floor' +
        (out.pockets > 1 ? ', in ' + out.pockets + ' separate pockets' : '')) + '.';
    return out;
  }

  var api = {
    analyse: analyse,
    preview: preview,
    foam: foam,
    readout: readout,
    census: census,
    components: components,
    signedVolume: signedVolume,
    frameFor: frameFor,
    grouped: grouped,
    EDGE_TOL: EDGE_TOL
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_Foam = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
