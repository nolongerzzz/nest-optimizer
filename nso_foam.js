/* nso_foam.js - Foam: fill buried space from the bottom up, to a level.

   Loads as a classic script (window.NSO_Foam) and as a Node module
   (require('../nso_foam.js')). No DOM, no Three.js: a mesh is the app's raw
   soup (9 numbers per triangle, Z up, millimetres).

   READ docs/FOAM.md FIRST - it has the model, the numbers it was checked on
   (tools/nso_foam_test.js, tools/nso_foam_box_test.js) and what it
   deliberately does not do.

   ---------------------------------------------------------------------------
   WHAT IT IS
   ---------------------------------------------------------------------------
   foamBox: foam is a stock generator bounded by a box, the way Extract bit is
   a cutter bounded by its bit. Given a piece and a box (Crop's Box: centre,
   size, yaw), it fills every bit of empty space inside the box that is BURIED
   in the piece - inside the piece's outer outline, layer by layer - and welds
   to every face of the piece it meets. A cup's bowl is buried, the air over
   its rim is not, so the box only needs a size and a depth. The fill rises
   from the bottom of the buried space in the box; `amount` (0..100) is how
   far. See "foamBox" below for the model and how it is found exactly.

   Foam (Finish -> Shape, app-foam.js) is the sealed-hollow case: ONE cavity,
   filled from its lowest point up to a LEVEL, the way a liquid rises.

     cavity   a shell that bounds a closed void inside the piece, found by
              nso_hollow.js cavityShells() - the test fill() itself uses, so a
              captive separate solid is never a cavity here either.
     up       the plate's vertical as the piece lies, given in the piece's raw
              axes (opts.up). Unposed it is raw +Z.
     level    a height along `up`, measured from the cavity's lowest point.

   Setting the foam is foamBox's engine with the box the cavity's own bounds:
   the part of the cavity ABOVE the level stays a cavity, closed by a flat
   floor facing up into what is left of the void. Below the level is now
   solid. Nothing else in the piece is touched: every triangle that is not on
   this cavity's shell is copied in its original order, bit for bit.

     level at the floor   nothing changes - the soup comes back as it went in
     level at the top     the shell is dropped whole, which is exactly what
                          Fill / Densify gives for that cavity (same triangles,
                          same order)
     in between           the shell above the level, plus the floor. A cavity
                          that splits into separate pockets above the level
                          comes back as separate closed shells, one per pocket.

   The preview (what the app draws while the level rises) is the cut engine's
   rawCut (app-cut.js) through the cavity's shell turned inside out.

   A plate vertical that is not one of the raw axes (a piece laid on a slanted
   face) is turned into a frame where it is +Z, cut there, and mapped back.
   Every corner the cut did not make is mapped back to the raw vertex it came
   from, so even then the cavity's untouched triangles are the original ones.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   foamBox(piece, box, amount, opts) -> Promise of { ok, changed, mesh,
                                          addedVolume, touched, level, span,
                                          merged, reason, ... }
       piece { rawTris, toRaw?, name?, skipList }: the soup in raw axes; toRaw
       (16 numbers, column-major) maps the plate frame P into it, as Crop takes
       it. skipList IS REQUIRED (nsoMaskFaceList(m)). box { c, h, yaw } in P.
       touched: the piece's shells the foam welds to, numbered in the order of
       their first triangle. Overlapping shells are merged for this operation
       only (docs/WORK-AS-IS.md; opts.overlap, else nsoOverlap, else the
       kernel's NSO_overlapMeasure / NSO_shellMergeCore).
   foamBoxSolid(piece, box, amount, opts) -> the same, now, on the piece as one
       solid as it is (no overlap check, no merge)
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
       segments (6 numbers each). deps.rawCut: the cut engine, else the global.
   foam(soup, A, id, height, opts)    -> { ok, changed, soup, removedVolume,
                                          remainingVolume, fraction, pockets,
                                          changedFaces, reason }
       opts.skipList IS REQUIRED: nsoMaskFaceList(m), the painted faces. It is
       not optional with an "unpainted" default, because unpainted is the value
       a caller gets by forgetting (docs/HANDOFF.md, "paint wins").
   readout(fraction, volume)          -> "Foam: 42% of the hollow, 7,396 mm³"
   census(soup)                       -> { tris, open, nm, degen, closed }

   Refusals follow the house contract: ok false, reason in plain words, and
   `soup` / `mesh` is the ORIGINAL soup.

   PAINT SCOPE: SUB-REGION (docs/HANDOFF.md, "Scoping"). Foam changes only
   the faces it welds to - for a hollow, the ones the level reaches. A painted
   face among them stands it down, named; paint anywhere else does not. A
   piece whose shells must be merged first stands down for any paint: the
   merge replaces every triangle.
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

    /* Set is foamBox's engine with the box the hollow's own bounds: only the
       level cuts the void, and the void is exactly this hollow's shell - a
       captive solid inside it is held in the foam on its own shell, as Fill
       holds it, rather than welded. Everything off the shell is copied in its
       own order; at the top nothing is added, so this is fill()'s drop-and-copy
       for the shell. */
    var lim = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
    for (var b = 0; b < cv.faces.length; b++) {
      for (var cc = 0; cc < 3; cc++) {
        var ob = cv.faces[b] * 9 + cc * 3;
        var pq = toF(F, soup[ob], soup[ob + 1], soup[ob + 2]);
        for (var ax = 0; ax < 3; ax++) { if (pq[ax] < lim.lo[ax]) lim.lo[ax] = pq[ax]; if (pq[ax] > lim.hi[ax]) lim.hi[ax] = pq[ax]; }
      }
    }
    var r = foamCore(soup, upFrame(F), lim, { voidFaces: cv.faces, level: L.atTop ? null : L.z, amount: 100, skipList: [] });
    if (!r.ok) {
      out.reason = 'Foam: hollow ' + (cv.id + 1) + ' could not be cut at this level (' + (r.reason || r.kind) + '). Nothing changed.';
      if (r.census) out.census = r.census;
      return out;
    }
    var res = r.mesh, rest = res.subarray(r.restFrom * 9);

    /* The shell's volume left above the level, and the captive solids now
       held in the foam (all of each one, or Set would have refused). */
    var shellLeft = rest.length ? -signedVolume(rest) : 0;
    var embedded = 0;
    for (var ci = 0; ci < cv.captives.length; ci++) if (cv.captives[ci].hi <= L.z + EDGE_TOL) embedded += cv.captives[ci].volume;
    var remaining = shellLeft - (cv.shellVolume - cv.volume - embedded);
    out.ok = true;
    out.changed = true;
    out.soup = res;
    out.census = r.census;
    out.changedFaces = touched.length;
    out.remainingVolume = remaining;
    out.removedVolume = cv.volume - remaining;
    out.embeddedVolume = embedded;
    out.fraction = cv.volume > 0 ? out.removedVolume / cv.volume : 1;
    out.pockets = rest.length ? components(rest) : 0;
    out.reason = 'Foam set in hollow ' + (cv.id + 1) + ' - ' + grouped(out.removedVolume) + ' mm³ now solid (' +
      Math.round(out.fraction * 100) + '% of it)' +
      (L.atTop ? ', the hollow is gone' :
        ', ' + grouped(remaining) + ' mm³ still hollow above a flat floor' +
        (out.pockets > 1 ? ', in ' + out.pockets + ' separate pockets' : '')) + '.';
    return out;
  }

  /* ===================================================================
     foamBox: foam in a box, bounded by the piece
     =================================================================== */

  /* WHAT IS BURIED. Per layer - a flat section of the piece across its up -
     the piece's outermost contours with their insides filled, inner contours
     ignored: the outer boundary a slicer reads. Empty space inside that
     outline is buried, sealed or open alike: a cup's bowl is, the air over its
     rim is not. The foam is the buried empty space inside the box, risen from
     the box's floor to a level. It welds to every face of the piece it meets,
     it stops at the box's walls where they are inside the piece, and the
     piece's own surface stops it where the box leaves the piece.

     HOW IT IS FOUND, EXACTLY. A section's loop is an outer contour when no
     other outline holds it; every other loop - a hole's, or an island's in a
     hole - borders buried space. The shape of the section can only change at
     a critical vertex of the height on the surface (a lowest or highest
     point, a saddle, a pinch); between two critical heights every loop only
     slides, and the faces of one loop's band, found by walking the edges
     inside that slab, all face the same side. So the test is one section per
     slab, and a face is cut at a critical height only where the side it faces
     changes there. A flat face at a critical height asks the section just
     above it (facing up) or just below it (facing down) whether its centre is
     inside an outline.

     THE VOID. The faces that border buried space, turned inside out, closed by
     a flat LID wherever the buried space ends against air (a cup's rim, the
     floor of a bell), are a closed solid: the buried empty space. The foam is
     that solid cut by the box's six faces and the level, plane by plane, each
     cut closed by a flat cap - rawCut's clip and cap, on exact shared corners:
     a corner made on an edge is made once, from the edge's two ends in a fixed
     order, and every face on that edge uses it. No general boolean.

     SETTING IT. The void's faces inside the foam go (the foam is welded there),
     their parts outside it stay, the foam's caps and lids are added. Every
     triangle the foam does not reach is copied as it came, bit for bit; a face
     whose edge gained a corner from the cut is split at it so nothing is left
     open (it does not move). */

  var BOX_TOL = 1e-4;            // app-cut.js's weld radius: a corner this close to a box face is on it
  var WALL = 0, LID = 1, CAP = 2;
  /* How far off an edge a corner may sit and still be on it: a welded corner
     moves up to twice the weld radius (squared, for |cross|^2 <= REACH2 |edge|^2). */
  var REACH2 = (2.02 * BOX_TOL) * (2.02 * BOX_TOL);

  function clock() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

  /* ---- exact corners, edges, shells ---- */

  var HF = new Float64Array(1), HU = new Uint32Array(HF.buffer);
  function bitsHash(x) { HF[0] = x === 0 ? 0 : x; return (HU[0] ^ Math.imul(HU[1], 0x9E3779B1)) | 0; }
  function pow2(n) { var c = 16; while (c < n) c *= 2; return c; }

  /* Corners welded by exact position: ids per corner, one position per id,
     and the first corner each id came from. */
  function weldExact(Q, n) {
    var mask = pow2(n * 2) - 1, table = new Int32Array(mask + 1).fill(-1);
    var ids = new Int32Array(n), V = new Float64Array(n * 3), first = new Int32Array(n), nv = 0;
    for (var i = 0; i < n; i++) {
      var x = Q[i * 3], y = Q[i * 3 + 1], z = Q[i * 3 + 2];
      var h = (Math.imul(bitsHash(x), 73856093) ^ Math.imul(bitsHash(y), 19349663) ^ Math.imul(bitsHash(z), 83492791)) & mask;
      for (;;) {
        var s = table[h];
        if (s < 0) { table[h] = nv; V[nv * 3] = x; V[nv * 3 + 1] = y; V[nv * 3 + 2] = z; first[nv] = i; ids[i] = nv++; break; }
        if (V[s * 3] === x && V[s * 3 + 1] === y && V[s * 3 + 2] === z) { ids[i] = s; break; }
        h = (h + 1) & mask;
      }
    }
    return { ids: ids, V: V.subarray(0, nv * 3), first: first.subarray(0, nv), nv: nv };
  }

  /* Edges of an indexed soup: each undirected edge once, with the half-edges
     on it (half-edge t*3+k runs from corner k of triangle t to corner k+1).
     Counts what a closed, consistently wound 2-manifold may not have. */
  function buildEdges(T, nt) {
    var n = nt * 3, mask = pow2(n + (n >> 1)) - 1, table = new Int32Array(mask + 1).fill(-1);
    var eA = new Int32Array(n), eB = new Int32Array(n), h0 = new Int32Array(n), h1 = new Int32Array(n);
    var cnt = new Uint8Array(n), edgeOf = new Int32Array(n), ne = 0, degen = 0;
    for (var t = 0; t < nt; t++) {
      var o = t * 3;
      /* A triangle with a repeated corner has no area and joins nothing: it
         is left out of the edges (and copied through untouched). */
      if (T[o] === T[o + 1] || T[o + 1] === T[o + 2] || T[o] === T[o + 2]) {
        degen++;
        edgeOf[o] = edgeOf[o + 1] = edgeOf[o + 2] = -1;
        continue;
      }
      for (var k = 0; k < 3; k++) {
        var u = T[o + k], w = T[o + (k + 1) % 3], lo = u < w ? u : w, hi = u < w ? w : u;
        var h = (Math.imul(lo, 0x9E3779B1) ^ Math.imul(hi, 0x85EBCA77)) & mask, s;
        for (;;) {
          s = table[h];
          if (s < 0) { s = ne++; table[h] = s; eA[s] = lo; eB[s] = hi; h0[s] = o + k; h1[s] = -1; cnt[s] = 1; break; }
          if (eA[s] === lo && eB[s] === hi) { if (cnt[s] === 1) h1[s] = o + k; if (cnt[s] < 255) cnt[s]++; break; }
          h = (h + 1) & mask;
        }
        edgeOf[o + k] = s;
      }
    }
    var open = 0, nm = 0, flipped = 0;
    for (var e = 0; e < ne; e++) {
      if (cnt[e] === 1) open++;
      else if (cnt[e] > 2) nm++;
      else if (T[h0[e]] === T[h1[e]]) flipped++;          // both half-edges start at the same corner
    }
    return { ne: ne, eA: eA, eB: eB, h0: h0, h1: h1, cnt: cnt, edgeOf: edgeOf,
             open: open, nm: nm, flipped: flipped, degen: degen };
  }

  /* Shells: faces joined across shared edges (as cavityShells joins them),
     numbered in the order of their first triangle. */
  function shellIds(T, nt, E) {
    var parent = new Int32Array(nt);
    for (var t = 0; t < nt; t++) parent[t] = t;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    for (var e = 0; e < E.ne; e++) {
      if (E.h1[e] < 0 || E.h0[e] < 0) continue;
      var a = find((E.h0[e] / 3) | 0), b = find((E.h1[e] / 3) | 0);
      if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; }
    }
    var id = new Int32Array(nt).fill(-1), of = new Int32Array(nt), n = 0;
    for (t = 0; t < nt; t++) { var r = find(t); if (id[r] < 0) id[r] = n++; of[t] = id[r]; }
    return { of: of, count: n };
  }

  /* ---- the frame: the box's axes, up = +Z ---- */

  /* A frame maps a raw point p to q = R (p - t) and back by p = S q + t. The
     box's frame is the plate frame P turned by -yaw about its vertical, so the
     box is axis-aligned in it; toRaw (16 numbers, column-major, as Crop takes
     it) maps P into the raw frame, omitted it is the identity. With no pose
     and no yaw every mapping is the identity, exact. */
  function matFrame(R, S, t) {
    var exact = t[0] === 0 && t[1] === 0 && t[2] === 0;
    for (var i = 0; i < 9 && exact; i++) if (R[i] !== 0 && R[i] !== 1 && R[i] !== -1) exact = false;
    var identity = exact && R[0] === 1 && R[4] === 1 && R[8] === 1;
    return {
      exact: exact,
      identity: identity,
      to: function (x, y, z, out, o) {
        x -= t[0]; y -= t[1]; z -= t[2];
        out[o] = x * R[0] + y * R[1] + z * R[2];
        out[o + 1] = x * R[3] + y * R[4] + z * R[5];
        out[o + 2] = x * R[6] + y * R[7] + z * R[8];
      },
      from: function (q0, q1, q2) {
        return [q0 * S[0] + q1 * S[1] + q2 * S[2] + t[0], q0 * S[3] + q1 * S[4] + q2 * S[5] + t[1],
                q0 * S[6] + q1 * S[7] + q2 * S[8] + t[2]];
      }
    };
  }
  /* The old Foam's frame (frameFor): q = (p.e1, p.e2, p.n), p = e1 q0 + e2 q1 + n q2 - the very
     expressions toF / fromF compute, so a hollow's span reads the same either way. */
  function upFrame(F) {
    return matFrame([F.e1[0], F.e1[1], F.e1[2], F.e2[0], F.e2[1], F.e2[2], F.n[0], F.n[1], F.n[2]],
                    [F.e1[0], F.e2[0], F.n[0], F.e1[1], F.e2[1], F.n[1], F.e1[2], F.e2[2], F.n[2]], [0, 0, 0]);
  }
  function inv3(m) {
    var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
    var A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
    if (!(Math.abs(det) > 1e-300)) return null;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
            B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
            C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
  function boxFrame(toRaw, yaw) {
    var th = (yaw || 0) * Math.PI / 180, c = yaw ? Math.cos(th) : 1, s = yaw ? Math.sin(th) : 0;
    var M = toRaw && toRaw.length === 16 ? toRaw : null;
    var ident = !M || (M[0] === 1 && M[1] === 0 && M[2] === 0 && M[4] === 0 && M[5] === 1 && M[6] === 0 &&
                       M[8] === 0 && M[9] === 0 && M[10] === 1);
    // G = M3 Rz(yaw) maps the box frame into raw (rows), and its inverse back
    var M3 = M ? [M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    var t = M ? [M[12], M[13], M[14]] : [0, 0, 0];
    var Rz = [c, -s, 0, s, c, 0, 0, 0, 1];
    var G = [], i, j, k;
    for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) {
      var v = 0;
      for (k = 0; k < 3; k++) v += M3[i * 3 + k] * Rz[k * 3 + j];
      G[i * 3 + j] = v;
    }
    var Gi = (ident && !yaw) ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : inv3(G);
    if (!Gi) return null;
    return matFrame(Gi, G, t);
  }

  /* ---- a growing vertex store and exact shared corners ---- */

  /* P: positions (box frame), the original ids first. A corner made on an edge
     (u, w) at a plane is made from the edge's two ends in id order, so the two
     faces on the edge get the same corner, bit for bit, whichever way round
     they wind it. */
  function Store(V, nv) {
    this.P = Array.prototype.slice.call(V);
    this.nv = nv;
    this.splits = new Map();
    this.rep = new Map();
    this.planes = [];             // the planes of caps and lids: { axis, value, sign }
  }
  /* A cap's or lid's plane, by index (a CAP / LID face's src). */
  Store.prototype.plane = function (axis, value, sign) {
    for (var i = 0; i < this.planes.length; i++) {
      var q = this.planes[i];
      if (q.axis === axis && q.value === value && q.sign === sign) return i;
    }
    this.planes.push({ axis: axis, value: value, sign: sign });
    return this.planes.length - 1;
  };
  /* The corner a made corner was folded into (weldPlane), or itself. */
  Store.prototype.find = function (v) {
    var r = this.rep.get(v);
    if (r === undefined) return v;
    var root = this.find(r);
    if (root !== r) this.rep.set(v, root);
    return root;
  };

  /* Corners on a plane closer than twice the weld radius are one corner -
     rawCut's rule (rawSnapPlanePoints) - for the cuts at a critical height,
     where a vertex can sit a hair off the height and the cut beside it would
     leave a sliver the canonical checker's weld collapses. A corner the cut
     made folds into the nearest corner within reach that stays where it is,
     never into one that is itself folded (no chain can carry a corner further
     than the radius), and an original corner never moves. */
  function weldPlane(S, ids, axis, value) {
    var P = S.P, nv0 = S.nv, tol = 2 * BOX_TOL, inv = 1 / tol, cells = new Map(), list = [];
    ids.forEach(function (v) { if (Math.abs(P[v * 3 + axis] - value) <= BOX_TOL) list.push(v); });
    if (list.length < 2) return 0;
    list.sort(function (a, b) { return a - b; });
    function key(cx, cy, cz) { return cx + ',' + cy + ',' + cz; }
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var v = list[i], x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
      var cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv), best = -1, bd = tol * tol;
      if (v >= nv0) {
        for (var a = -1; a <= 1; a++) for (var b = -1; b <= 1; b++) for (var c = -1; c <= 1; c++) {
          var cl = cells.get(key(cx + a, cy + b, cz + c));
          if (!cl) continue;
          for (var k = 0; k < cl.length; k++) {
            var w = cl[k], dx = x - P[w * 3], dy = y - P[w * 3 + 1], dz = z - P[w * 3 + 2], d2 = dx * dx + dy * dy + dz * dz;
            if (d2 <= bd) { bd = d2; best = w; }
          }
        }
      }
      if (best >= 0) { S.rep.set(v, best); n++; continue; }
      var kk = key(cx, cy, cz), l2 = cells.get(kk);
      if (l2) l2.push(v); else cells.set(kk, [v]);
    }
    return n;
  }
  /* A face list with every corner through the folds, faces that collapsed dropped. */
  function refold(S, F) {
    if (!S.rep.size) return F;
    var G = new Faces(), n = F.size();
    for (var i = 0; i < n; i++) {
      var a = S.find(F.a[i]), b = S.find(F.b[i]), c = S.find(F.c[i]);
      if (a === b || b === c || a === c) continue;
      G.add(a, b, c, F.tag[i], F.src[i]);
    }
    return G;
  }
  function refoldPoly(S, poly) {
    var out = [];
    for (var i = 0; i < poly.length; i++) {
      var v = S.find(poly[i]);
      if (out.length && out[out.length - 1] === v) continue;
      out.push(v);
    }
    while (out.length > 1 && out[0] === out[out.length - 1]) out.pop();
    return out;
  }
  Store.prototype.split = function (u, w, axis, value) {
    var lo = u < w ? u : w, hi = u < w ? w : u, key = axis + '|' + value + '|' + lo + '|' + hi;
    var id = this.splits.get(key);
    if (id !== undefined) return id;
    var P = this.P, a = lo * 3, b = hi * 3, s = (value - P[a + axis]) / (P[b + axis] - P[a + axis]);
    var q = [P[a] + (P[b] - P[a]) * s, P[a + 1] + (P[b + 1] - P[a + 1]) * s, P[a + 2] + (P[b + 2] - P[a + 2]) * s];
    q[axis] = value;
    id = P.length / 3;
    P.push(q[0], q[1], q[2]);
    this.splits.set(key, id);
    return id;
  };

  /* A face list: three corners, a tag (WALL / LID / CAP) and, for a wall,
     the input triangle it lies on. */
  function Faces() { this.a = []; this.b = []; this.c = []; this.tag = []; this.src = []; }
  Faces.prototype.add = function (a, b, c, tag, src) { this.a.push(a); this.b.push(b); this.c.push(c); this.tag.push(tag); this.src.push(src); };
  Faces.prototype.size = function () { return this.a.length; };
  Faces.prototype.addPoly = function (poly, tag, src, flip) {
    for (var i = 1; i + 1 < poly.length; i++) {
      if (flip) this.add(poly[0], poly[i + 1], poly[i], tag, src);
      else this.add(poly[0], poly[i], poly[i + 1], tag, src);
    }
  };

  /* Directed edges, keyed exactly. */
  var EK = 67108864;             // 2^26: corner ids stay under it (a key stays under 2^52)
  function ekey(u, w) { return u * EK + w; }

  /* ---- caps: loops on a plane -> triangles ---- */

  /* Cap edges (each [u, w], the cap's boundary the way the cap winds it) into
     closed loops. At a corner where two loops touch, the walk keeps to the cap
     it is on by turning as far toward it as it can. (u, v) are the plane's
     axes in right-handed order with the normal axis; sign is the side the cap
     faces. */
  function chainLoops(P, edges, axis, sign) {
    var u2 = (axis + 1) % 3, v2 = (axis + 2) % 3, m = edges.length / 2, outOf = new Map();
    for (var i = 0; i < m; i++) {
      var l = outOf.get(edges[i * 2]);
      if (!l) { l = []; outOf.set(edges[i * 2], l); }
      l.push(i);
    }
    var used = new Uint8Array(m), loops = [];
    for (var s0 = 0; s0 < m; s0++) {
      if (used[s0]) continue;
      var loop = [edges[s0 * 2]], cur = s0, start = edges[s0 * 2], guard = 0;
      used[s0] = 1;
      for (;;) {
        var v = edges[cur * 2 + 1];
        if (v === start) break;
        if (guard++ > m) return null;
        var cand = (outOf.get(v) || []).filter(function (j) { return !used[j]; });
        if (!cand.length) return null;
        var nx = cand[0];
        if (cand.length > 1) {
          var pu = edges[cur * 2], ax = P[v * 3 + u2] - P[pu * 3 + u2], ay = P[v * 3 + v2] - P[pu * 3 + v2], best = -Infinity;
          for (var q = 0; q < cand.length; q++) {
            var w = edges[cand[q] * 2 + 1], bx = P[w * 3 + u2] - P[v * 3 + u2], by = P[w * 3 + v2] - P[v * 3 + v2];
            var turn = Math.atan2(ax * by - ay * bx, ax * bx + ay * by) * sign;
            if (turn > best) { best = turn; nx = cand[q]; }
          }
        }
        used[nx] = 1;
        loop.push(v);
        cur = nx;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  }

  /* Loops on a plane -> the triangles that fill them, facing `sign` along
     `axis`. The cut engine's cap (app-cut.js: rawNestLoops, rawBridgeHoles,
     rawEarClip2D) on corner ids: loops classed by nesting depth (even = an
     outline, odd = a hole in the smallest outline round it), each hole spliced
     into its outline through a bridge walked both ways, the outline ear-clipped.
     No corner is added. -> [a, b, c, ...] or null. */
  function capTris(P, loops, axis, sign) {
    var u2 = (axis + 1) % 3, v2 = (axis + 2) % 3;
    function p2(id) { return [P[id * 3 + u2], P[id * 3 + v2]]; }
    var L = loops.map(function (ids) {
      var pts = ids.map(p2), a = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i], q = pts[(i + 1) % pts.length];
        a += p[0] * q[1] - q[0] * p[1];
        if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
      }
      return { ids: ids, p2: pts, area: a / 2, box: [x0, y0, x1, y1], depth: 0, parent: -1, holes: [] };
    });
    function inside(pt, poly) {
      var c = false;
      for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        var a = poly[i], b = poly[j];
        if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
      }
      return c;
    }
    var holders = L.map(function () { return []; }), i, j;
    for (i = 0; i < L.length; i++) {
      for (j = 0; j < L.length; j++) {
        if (i === j || !(Math.abs(L[j].area) > Math.abs(L[i].area))) continue;
        /* Asked at a corner of loop i that loop j does not share: two loops
           that touch at a corner (a pinch) hold each other at no other point. */
        var mine = new Set(L[j].ids), pt = null;
        for (var q = 0; q < L[i].ids.length && !pt; q++) if (!mine.has(L[i].ids[q])) pt = L[i].p2[q];
        if (!pt) continue;
        var bx = L[j].box;
        if (pt[0] < bx[0] || pt[0] > bx[2] || pt[1] < bx[1] || pt[1] > bx[3]) continue;
        if (inside(pt, L[j].p2)) holders[i].push(j);
      }
      L[i].depth = holders[i].length;
    }
    for (i = 0; i < L.length; i++) {
      if (L[i].depth % 2 === 0) continue;
      var best = -1;
      for (var h = 0; h < holders[i].length; h++) {
        j = holders[i][h];
        if (L[j].depth === L[i].depth - 1 && (best < 0 || Math.abs(L[j].area) < Math.abs(L[best].area))) best = j;
      }
      if (best < 0) return null;
      L[i].parent = best;
      L[best].holes.push(i);
    }
    var out = [];
    for (i = 0; i < L.length; i++) {
      if (L[i].depth % 2 !== 0) continue;
      var poly = L[i].holes.length ? bridgeHoles(L[i], L[i].holes.map(function (k) { return L[k]; })) : orient(L[i], true);
      if (!poly) return null;
      var tri = earClip(poly.map(function (v) { return v.p2; }));
      for (var k = 0; k < tri.length; k++) {
        var A = poly[tri[k][0]], B = poly[tri[k][1]], C = poly[tri[k][2]];
        if (A.id === B.id || B.id === C.id || A.id === C.id) continue;
        var cr = (B.p2[0] - A.p2[0]) * (C.p2[1] - A.p2[1]) - (B.p2[1] - A.p2[1]) * (C.p2[0] - A.p2[0]);
        if ((cr > 0 ? 1 : -1) === sign) out.push(A.id, B.id, C.id);
        else out.push(A.id, C.id, B.id);
      }
    }
    return out;
  }
  function orient(l, ccw) {
    var idx = l.p2.map(function (_, i) { return i; });
    if ((l.area > 0) !== ccw) idx.reverse();
    return idx.map(function (i) { return { p2: l.p2[i], id: l.ids[i] }; });
  }
  /* rawBridgeHoles (app-cut.js), on {p2, id}. */
  function bridgeHoles(outer, holes) {
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    function same(a, b) { return a[0] === b[0] && a[1] === b[1]; }
    function on(x, s, e) {
      return Math.min(s[0], e[0]) <= x[0] && x[0] <= Math.max(s[0], e[0]) && Math.min(s[1], e[1]) <= x[1] && x[1] <= Math.max(s[1], e[1]);
    }
    function hits(p, q, a, b) {
      if ((same(a, p) || same(a, q)) && (same(b, p) || same(b, q))) return true;
      var pShared = same(a, p) || same(b, p), qShared = same(a, q) || same(b, q);
      var d1 = cross(a, b, p), d2 = cross(a, b, q), d3 = cross(p, q, a), d4 = cross(p, q, b);
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
      if (d3 === 0 && !same(a, p) && !same(a, q) && on(a, p, q)) return true;
      if (d4 === 0 && !same(b, p) && !same(b, q) && on(b, p, q)) return true;
      if (d1 === 0 && !pShared && on(p, a, b)) return true;
      if (d2 === 0 && !qShared && on(q, a, b)) return true;
      return false;
    }
    function inWedge(a, P0, b, m) {
      var l1 = cross(a, P0, m) > 0, l2 = cross(P0, b, m) > 0;
      return cross(a, P0, b) >= 0 ? (l1 && l2) : (l1 || l2);
    }
    var poly = orient(outer, true);
    var pending = holes.map(function (h) { return orient(h, false); });
    function maxX(r) { var m = -Infinity; for (var i = 0; i < r.length; i++) if (r[i].p2[0] > m) m = r[i].p2[0]; return m; }
    pending.sort(function (A, B) { return maxX(B) - maxX(A); });
    while (pending.length) {
      var hole = pending.shift();
      var mOrder = hole.map(function (_, i) { return i; }).sort(function (i, j) { return hole[j].p2[0] - hole[i].p2[0]; });
      var done = false;
      for (var mi = 0; mi < mOrder.length && !done; mi++) {
        var M0 = hole[mOrder[mi]].p2;
        var cand = poly.map(function (_, i) { return i; }).sort(function (i, j) {
          var a = poly[i].p2, b = poly[j].p2;
          return ((a[0] - M0[0]) * (a[0] - M0[0]) + (a[1] - M0[1]) * (a[1] - M0[1])) -
                 ((b[0] - M0[0]) * (b[0] - M0[0]) + (b[1] - M0[1]) * (b[1] - M0[1]));
        });
        for (var ci = 0; ci < cand.length; ci++) {
          var pi = cand[ci], P0 = poly[pi].p2;
          if (!inWedge(poly[(pi - 1 + poly.length) % poly.length].p2, P0, poly[(pi + 1) % poly.length].p2, M0)) continue;
          var blocked = false, rings = [poly, hole].concat(pending);
          for (var r = 0; r < rings.length && !blocked; r++) {
            var ring = rings[r];
            for (var e = 0; e < ring.length && !blocked; e++) if (hits(M0, P0, ring[e].p2, ring[(e + 1) % ring.length].p2)) blocked = true;
          }
          if (blocked) continue;
          var mIdx = mOrder[mi], hh = hole.slice(mIdx).concat(hole.slice(0, mIdx + 1));
          poly = poly.slice(0, pi + 1).concat(hh, poly.slice(pi));
          done = true;
          break;
        }
      }
      if (!done) return null;
    }
    return poly;
  }
  /* rawEarClip2D (app-cut.js): a simple polygon (or one bridged to its holes)
     into index triples. */
  function earClip(pts) {
    function area(p) { var a = 0; for (var i = 0; i < p.length; i++) { var q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return a / 2; }
    function convex(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 1e-9; }
    function sgn(p1, p2, p3) { return (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]); }
    function inTri(p, a, b, c, eps) {
      var d1 = sgn(p, a, b), d2 = sgn(p, b, c), d3 = sgn(p, c, a);
      if (Math.abs(d1) < eps || Math.abs(d2) < eps || Math.abs(d3) < eps) return false;
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
    }
    function onSeg(p, a, c, eps) {
      var ex = c[0] - a[0], ey = c[1] - a[1], cr = ex * (p[1] - a[1]) - ey * (p[0] - a[0]);
      if (Math.abs(cr) >= eps) return false;
      var t = ex * (p[0] - a[0]) + ey * (p[1] - a[1]);
      return t > 0 && t < ex * ex + ey * ey;
    }
    var work = pts.map(function (_, i) { return i; });
    if (area(pts) < 0) work.reverse();
    var tris = [], guard = 0, scan = 0;
    while (work.length > 3 && guard++ < 200000) {
      var found = false, n = work.length;
      for (var s = 0; s < n; s++) {
        var i = (scan + s) % work.length;
        var ip = work[(i - 1 + work.length) % work.length], ic = work[i], inx = work[(i + 1) % work.length];
        var a = pts[ip], b = pts[ic], c = pts[inx];
        if (!convex(a, b, c)) continue;
        var blocked = false;
        for (var k = 0; k < work.length && !blocked; k++) {
          var jj = work[k];
          if (jj === ip || jj === ic || jj === inx) continue;
          if (inTri(pts[jj], a, b, c, 1e-7) || onSeg(pts[jj], a, c, 1e-7)) blocked = true;
        }
        if (blocked) continue;
        tris.push([ip, ic, inx]);
        work.splice(i, 1);
        scan = i > 0 ? i - 1 : 0;
        found = true;
        break;
      }
      if (!found) {
        for (var mm = 1; mm < work.length - 1; mm++) tris.push([work[0], work[mm], work[mm + 1]]);
        work.length = 0;
        break;
      }
    }
    if (work.length === 3) tris.push([work[0], work[1], work[2]]);
    return tris;
  }

  /* ---- the cut: a closed face list against one plane ---- */

  /* Keeps the side coord >= value (ge) or <= value (!ge) and closes it with a
     flat cap facing the side cut away; a corner within BOX_TOL of the plane is
     on it. A wall's part on the far side goes to `outside` (it stays on the
     piece). A face lying in the plane stays when it faces the far side - it is
     already the cap there - and goes otherwise. -> the kept list, the same
     list when nothing is on the far side, or null when the cap cannot be made. */
  function cutFaces(S, F, axis, value, ge, outside) {
    var P = S.P, sg = ge ? 1 : -1, n = F.size(), nv0 = P.length / 3, i, k;
    var sd = new Int8Array(nv0);
    for (i = 0; i < nv0; i++) { var dd = (P[i * 3 + axis] - value) * sg; sd[i] = dd > BOX_TOL ? 1 : (dd < -BOX_TOL ? -1 : 0); }
    function side(v) { return v < nv0 ? sd[v] : 0; }          // a corner made by this cut is on the plane
    var A = F.a, B = F.b, C = F.c, far = false;
    for (i = 0; i < n && !far; i++) if (sd[A[i]] < 0 || sd[B[i]] < 0 || sd[C[i]] < 0) far = true;
    if (!far) return F;
    var K = new Faces(), cutFlat = new Set();
    for (i = 0; i < n; i++) {
      var a = A[i], b = B[i], c = C[i], da = sd[a], db = sd[b], dc = sd[c], tag = F.tag[i], src = F.src[i];
      if (da >= 0 && db >= 0 && dc >= 0 && (da || db || dc)) { K.add(a, b, c, tag, src); continue; }
      if (da <= 0 && db <= 0 && dc <= 0 && (da || db || dc)) { if (tag === WALL) outside.add(a, b, c, tag, src); continue; }
      if (!da && !db && !dc) {
        var o1 = (axis + 1) % 3, o2 = (axis + 2) % 3;
        var nA = (P[b * 3 + o1] - P[a * 3 + o1]) * (P[c * 3 + o2] - P[a * 3 + o2]) - (P[b * 3 + o2] - P[a * 3 + o2]) * (P[c * 3 + o1] - P[a * 3 + o1]);
        if (nA * sg < 0) K.add(a, b, c, tag, src);
        else if (tag === WALL) outside.add(a, b, c, tag, src);
        continue;
      }
      if (tag !== WALL) cutFlat.add(src);
      var poly = [a, b, c], d = [da, db, dc], IN = [], OUT = [];
      for (k = 0; k < 3; k++) {
        var u = poly[k], w = poly[(k + 1) % 3], du = d[k], dw = d[(k + 1) % 3];
        if (du >= 0) IN.push(u);
        if (du <= 0) OUT.push(u);
        if ((du > 0 && dw < 0) || (du < 0 && dw > 0)) { var x = S.split(u, w, axis, value); IN.push(x); OUT.push(x); }
      }
      if (IN.length >= 3) K.addPoly(IN, tag, src, false);
      if (OUT.length >= 3 && tag === WALL) outside.addPoly(OUT, tag, src, false);
    }
    /* The corners on the plane, welded as rawCut welds them. */
    var onIds = new Set();
    for (i = 0; i < K.size(); i++) {
      if (side(K.a[i]) === 0) onIds.add(K.a[i]);
      if (side(K.b[i]) === 0) onIds.add(K.b[i]);
      if (side(K.c[i]) === 0) onIds.add(K.c[i]);
    }
    if (weldPlane(S, onIds, axis, value)) K = refold(S, K);
    /* A cap or lid this cut crossed keeps a corner wherever the cut met one of
       its diagonals; they all sit on the cut's line, and the cap made next
       would carry them as a run of corners along the box's edge. Each such cap
       or lid is laid again from the corners other faces use. */
    if (cutFlat.size) K = relayFlats(S, K, cutFlat);
    /* The cap: the kept faces' open edges with both ends on the plane. */
    var dir = new Map(), m = K.size();
    for (i = 0; i < m; i++) {
      var fa = K.a[i], fb = K.b[i], fc = K.c[i], on = (side(fa) === 0 ? 1 : 0) + (side(fb) === 0 ? 1 : 0) + (side(fc) === 0 ? 1 : 0);
      if (on < 2) continue;
      for (k = 0; k < 3; k++) {
        var p = k === 0 ? fa : (k === 1 ? fb : fc), q = k === 0 ? fb : (k === 1 ? fc : fa);
        if (side(p) !== 0 || side(q) !== 0) continue;
        var rk = ekey(q, p);
        if (dir.has(rk)) { var c0 = dir.get(rk); if (c0 > 1) dir.set(rk, c0 - 1); else dir.delete(rk); }
        else dir.set(ekey(p, q), (dir.get(ekey(p, q)) || 0) + 1);
      }
    }
    if (dir.size) {
      var edges = [];
      dir.forEach(function (c1, key) {
        var p0 = Math.floor(key / EK), q0 = key - p0 * EK;
        for (var r = 0; r < c1; r++) edges.push(q0, p0);    // the cap runs each open edge the other way
      });
      var loops = chainLoops(S.P, edges, axis, -sg);
      if (!loops) return null;
      var tris = capTris(S.P, loops, axis, -sg);
      if (!tris) return null;
      var pc = S.plane(axis, value, -sg);
      for (i = 0; i < tris.length; i += 3) K.add(tris[i], tris[i + 1], tris[i + 2], CAP, pc);
    }
    return K;
  }

  /* ---- what is buried ---- */

  /* The loops of one section through the triangles listed, at height h: each
     triangle that crosses gives a segment from the edge it crosses going down
     to the edge it crosses going up (nso_slicer.js sliceMesh's rule, so an
     outline runs counter-clockwise and a hole clockwise), chained by edge.
     tie: a corner exactly at h counts as below (the section just above h) or,
     with tie 'up', as above (the section just below h).
     -> [{ tris, pts (x0, y0, x1, y1, ...), area, box }] or null if a chain is open. */
  function sectionLoops(M, list, from, to, h, tieUp) {
    var V = M.V, T = M.T, E = M.E, start = new Map(), sS = [], sE = [], sT = [];
    for (var i = from; i < to; i++) {
      var t = list[i], o = t * 3, above = [0, 0, 0], na = 0;
      for (var k = 0; k < 3; k++) {
        var z = V[T[o + k] * 3 + 2];
        above[k] = tieUp ? (z >= h ? 1 : 0) : (z > h ? 1 : 0);
        na += above[k];
      }
      if (na === 0 || na === 3) continue;
      var dn = -1, up = -1;
      for (k = 0; k < 3; k++) {
        var k1 = (k + 1) % 3;
        if (above[k] && !above[k1]) dn = k;
        else if (!above[k] && above[k1]) up = k;
      }
      start.set(E.edgeOf[o + dn], sS.length);
      sS.push(E.edgeOf[o + dn]); sE.push(E.edgeOf[o + up]); sT.push(t);
    }
    function pt(e, out) {
      var a = E.eA[e] * 3, b = E.eB[e] * 3, s = (h - V[a + 2]) / (V[b + 2] - V[a + 2]);
      out.push(V[a] + (V[b] - V[a]) * s, V[a + 1] + (V[b + 1] - V[a + 1]) * s);
    }
    var used = new Uint8Array(sS.length), loops = [];
    for (var s0 = 0; s0 < sS.length; s0++) {
      if (used[s0]) continue;
      var tris = [], pts = [], cur = s0, guard = 0;
      for (;;) {
        used[cur] = 1;
        tris.push(sT[cur]);
        pt(sS[cur], pts);
        var nx = start.get(sE[cur]);
        if (nx === s0) break;
        if (nx === undefined || used[nx] || guard++ > sS.length) return null;
        cur = nx;
      }
      var a2 = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, n = pts.length / 2;
      for (var j = 0; j < n; j++) {
        var px = pts[j * 2], py = pts[j * 2 + 1], qx = pts[((j + 1) % n) * 2], qy = pts[((j + 1) % n) * 2 + 1];
        a2 += px * qy - qx * py;
        if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      }
      loops.push({ tris: tris, pts: pts, area: a2 / 2, box: [x0, y0, x1, y1] });
    }
    return loops;
  }
  function inLoop(x, y, L) {
    var b = L.box;
    if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) return false;
    var p = L.pts, n = p.length / 2, c = false;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var ax = p[i * 2], ay = p[i * 2 + 1], bx = p[j * 2], by = p[j * 2 + 1];
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) c = !c;
    }
    return c;
  }
  /* Which loops are outer contours: wound as an outline (counter-clockwise)
     and held by no larger outline. Everything else borders buried space. */
  function outerFlags(loops) {
    var ccw = [], i;
    for (i = 0; i < loops.length; i++) if (loops[i].area > 0) ccw.push(i);
    ccw.sort(function (a, b) { return loops[b].area - loops[a].area; });
    var outer = new Uint8Array(loops.length);
    for (var r = 0; r < ccw.length; r++) {
      var L = loops[ccw[r]], x = L.pts[0], y = L.pts[1], held = false;
      for (var q = 0; q < r && !held; q++) if (inLoop(x, y, loops[ccw[q]])) held = true;
      if (!held) outer[ccw[r]] = 1;
    }
    return outer;
  }

  function lowerBound(arr, x) { var lo = 0, hi = arr.length; while (lo < hi) { var m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }
  function upperBound(arr, x) { var lo = 0, hi = arr.length; while (lo < hi) { var m = (lo + hi) >> 1; if (arr[m] <= x) lo = m + 1; else hi = m; } return lo; }
  function uniqueSorted(a) {
    var s = Float64Array.from(a).sort(), n = 0;
    for (var i = 0; i < s.length; i++) if (i === 0 || s[i] !== s[n - 1]) s[n++] = s[i];
    return s.slice(0, n);
  }

  /* The critical heights: where a vertex is lowest or highest among its
     neighbours, or its lower neighbours fall in more than one arc (a saddle),
     or its fan is more than one ring (a pinch). Ties in height are broken by
     corner id, which only adds critical vertices where faces lie flat. */
  function criticalHeights(M) {
    var V = M.V, T = M.T, nv = M.nv, nt = M.nt, i;
    var deg = new Int32Array(nv + 1), E = M.E;
    for (i = 0; i < nt * 3; i++) if (E.edgeOf[i] >= 0) deg[T[i] + 1]++;
    for (i = 0; i < nv; i++) deg[i + 1] += deg[i];
    var fill = deg.slice(0, nv), fan = new Int32Array(nt * 3);
    for (i = 0; i < nt * 3; i++) if (E.edgeOf[i] >= 0) fan[fill[T[i]]++] = i;
    var maxDeg = 0;
    for (i = 0; i < nv; i++) if (deg[i + 1] - deg[i] > maxDeg) maxDeg = deg[i + 1] - deg[i];
    var mark = new Int32Array(nv).fill(-1), loc = new Int32Array(nv);
    var nb = new Int32Array(maxDeg * 2 + 2), par = new Int32Array(maxDeg * 2 + 2), parL = new Int32Array(maxDeg * 2 + 2);
    function find(p, x) { while (p[x] !== x) { p[x] = p[p[x]]; x = p[x]; } return x; }
    var crit = [];
    for (var v = 0; v < nv; v++) {
      var m = 0, zv = V[v * 3 + 2];
      for (i = deg[v]; i < deg[v + 1]; i++) {
        var c = fan[i], t = (c / 3) | 0, k = c - t * 3;
        var p = T[t * 3 + (k + 1) % 3], q = T[t * 3 + (k + 2) % 3];
        if (mark[p] !== v) { mark[p] = v; loc[p] = m; nb[m] = p; par[m] = m; parL[m] = m; m++; }
        if (mark[q] !== v) { mark[q] = v; loc[q] = m; nb[m] = q; par[m] = m; parL[m] = m; m++; }
        var ip = loc[p], iq = loc[q];
        var ra = find(par, ip), rb = find(par, iq);
        if (ra !== rb) par[ra] = rb;
        var zp = V[p * 3 + 2], zq = V[q * 3 + 2];
        var lp = zp < zv || (zp === zv && p < v), lq = zq < zv || (zq === zv && q < v);
        if (lp && lq) { ra = find(parL, ip); rb = find(parL, iq); if (ra !== rb) parL[ra] = rb; }
      }
      var rings = 0, nLow = 0, lowArcs = 0;
      for (var j = 0; j < m; j++) {
        if (find(par, j) === j) rings++;
        var w = nb[j], zw = V[w * 3 + 2];
        if (zw < zv || (zw === zv && w < v)) { nLow++; if (find(parL, j) === j) lowArcs++; }
      }
      if (rings !== 1 || nLow === 0 || nLow === m || lowArcs !== 1) crit.push(zv);
    }
    return uniqueSorted(crit);
  }

  /* Which faces border buried space, in the box's height range [z0, z1].
     -> { faces (the void's walls and lids, closed), pieces (per input
     triangle cut at a height, its parts and their sides), wallTris } or
     { reason }. */
  function buriedVoid(M, S, z0, z1) {
    var V = M.V, T = M.T, nt = M.nt, E = M.E, i, t;
    var C = criticalHeights(M);
    var zs = new Float64Array(M.nv);
    for (i = 0; i < M.nv; i++) zs[i] = V[i * 3 + 2];
    var D = uniqueSorted(zs);
    if (C.length < 2 || z1 <= D[0] || z0 >= D[D.length - 1]) return { faces: new Faces(), pieces: new Map(), slabs: 0 };
    var iA = upperBound(C, z0) - 1, iB = lowerBound(C, z1);
    if (iA < 0) iA = 0;
    if (iB > C.length - 1) iB = C.length - 1;
    var nS = iB - iA;
    if (nS <= 0) return { faces: new Faces(), pieces: new Map(), slabs: 0 };

    /* Each triangle's slabs, in range. Flat ones at a critical height belong
       to none (they are asked below). */
    var tlo = new Float64Array(nt), thi = new Float64Array(nt), j0 = new Int32Array(nt).fill(-1), j1 = new Int32Array(nt).fill(-2);
    var jj0 = new Int32Array(nt), jj1 = new Int32Array(nt), flatAt = new Int32Array(nt).fill(-1);
    var count = new Int32Array(nS + 1);
    for (t = 0; t < nt; t++) {
      if (E.edgeOf[t * 3] < 0) continue;                // a collapsed triangle joins nothing
      var za = V[T[t * 3] * 3 + 2], zb = V[T[t * 3 + 1] * 3 + 2], zc = V[T[t * 3 + 2] * 3 + 2];
      var lo = Math.min(za, zb, zc), hi = Math.max(za, zb, zc);
      tlo[t] = lo; thi[t] = hi;
      var a, b;
      if (lo === hi) {
        var ci = lowerBound(C, lo);
        if (ci < C.length && C[ci] === lo) { if (ci >= iA && ci <= iB) flatAt[t] = ci; continue; }
        a = b = ci - 1;
      } else { a = upperBound(C, lo) - 1; b = lowerBound(C, hi) - 1; }
      jj0[t] = a; jj1[t] = b;
      if (a < iA) a = iA;
      if (b > iB - 1) b = iB - 1;
      if (a > b) continue;
      j0[t] = a; j1[t] = b;
      for (var s = a; s <= b; s++) count[s - iA + 1]++;
    }
    for (i = 0; i < nS; i++) count[i + 1] += count[i];
    var bucket = new Int32Array(count[nS]), at = count.slice(0, nS);
    var labOff = new Int32Array(nt).fill(-1), nLab = 0;
    for (t = 0; t < nt; t++) {
      if (j0[t] < 0) continue;
      labOff[t] = nLab; nLab += j1[t] - j0[t] + 1;
      for (s = j0[t]; s <= j1[t]; s++) bucket[at[s - iA]++] = t;
    }
    var lab = new Uint8Array(nLab);                  // 1 = faces outside, 2 = faces buried space
    var stamp = new Int32Array(nt).fill(-1), local = new Int32Array(nt), parent = new Int32Array(count[nS] > 0 ? count[nS] : 1);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    var unlabeled = 0;

    for (var js = 0; js < nS; js++) {
      var j = js + iA, b0 = count[js], b1 = count[js + 1], cLo = C[j], cHi = C[j + 1];
      if (b0 === b1) continue;
      /* The section: halfway across the widest gap between vertex heights in the slab. */
      var d0 = lowerBound(D, cLo), d1 = lowerBound(D, cHi), gap = -1, h = (cLo + cHi) / 2;
      for (i = d0; i < d1; i++) if (D[i + 1] - D[i] > gap) { gap = D[i + 1] - D[i]; h = (D[i] + D[i + 1]) / 2; }
      var loops = sectionLoops(M, bucket, b0, b1, h, false);
      if (!loops) return { reason: 'a section at ' + f1(h) + ' mm does not close' };
      var outer = outerFlags(loops);
      for (i = b0; i < b1; i++) { stamp[bucket[i]] = j; local[bucket[i]] = i - b0; parent[i - b0] = i - b0; }
      for (i = b0; i < b1; i++) {
        t = bucket[i];
        for (var k = 0; k < 3; k++) {
          var e = E.edgeOf[t * 3 + k], ot = E.h0[e] === t * 3 + k ? E.h1[e] : E.h0[e];
          if (ot < 0) continue;
          var t2 = (ot / 3) | 0;
          if (stamp[t2] !== j) continue;
          var ez0 = V[E.eA[e] * 3 + 2], ez1 = V[E.eB[e] * 3 + 2];
          if (ez0 > ez1) { var tmp = ez0; ez0 = ez1; ez1 = tmp; }
          if (!(ez0 < cHi && ez1 > cLo)) continue;
          var r1 = find(i - b0), r2 = find(local[t2]);
          if (r1 !== r2) parent[r1] = r2;
        }
      }
      var side = new Uint8Array(b1 - b0);
      for (var li = 0; li < loops.length; li++) {
        var want = outer[li] ? 1 : 2, lt = loops[li].tris;
        for (k = 0; k < lt.length; k++) {
          var rr = find(local[lt[k]]);
          if (side[rr] && side[rr] !== want) return { reason: 'the band round one loop at ' + f1(h) + ' mm faces both ways' };
          side[rr] = want;
        }
      }
      for (i = b0; i < b1; i++) {
        t = bucket[i];
        var sd = side[find(i - b0)];
        if (!sd) { sd = 1; unlabeled++; }
        lab[labOff[t] + (j - j0[t])] = sd;
      }
    }

    /* Flat faces at a critical height: is the centre of each inside an outline
       just above it (facing up) or just below it (facing down)? */
    var flatSide = new Uint8Array(nt), byH = new Map();
    for (t = 0; t < nt; t++) {
      if (flatAt[t] < 0) continue;
      var l2 = byH.get(flatAt[t]);
      if (!l2) { l2 = []; byH.set(flatAt[t], l2); }
      l2.push(t);
    }
    var flatErr = null;
    byH.forEach(function (list, ci) {
      if (flatErr) return;
      var hh = C[ci], ups = [], downs = [];
      list.forEach(function (tt) {
        var o = tt * 3, A = T[o] * 3, B = T[o + 1] * 3, Cc = T[o + 2] * 3;
        var nz = (V[B] - V[A]) * (V[Cc + 1] - V[A + 1]) - (V[B + 1] - V[A + 1]) * (V[Cc] - V[A]);
        if (nz > 0) ups.push(tt); else if (nz < 0) downs.push(tt);
      });
      [[ups, ci, false], [downs, ci - 1, true]].forEach(function (job) {
        var faces = job[0], sj = job[1];
        if (!faces.length || sj < iA || sj > iB - 1) return;             // out of range: not buried space in range
        var bs = sj - iA, lps = sectionLoops(M, bucket, count[bs], count[bs + 1], hh, job[2]);
        if (!lps) { flatErr = 'the section just ' + (job[2] ? 'below ' : 'above ') + f1(hh) + ' mm does not close'; return; }
        faces.forEach(function (tt) {
          var o = tt * 3, A = T[o] * 3, B = T[o + 1] * 3, Cc = T[o + 2] * 3;
          var la = Math.hypot(V[B] - V[Cc], V[B + 1] - V[Cc + 1]), lb = Math.hypot(V[A] - V[Cc], V[A + 1] - V[Cc + 1]),
              lc = Math.hypot(V[A] - V[B], V[A + 1] - V[B + 1]), ls = la + lb + lc || 1;
          var x = (la * V[A] + lb * V[B] + lc * V[Cc]) / ls, y = (la * V[A + 1] + lb * V[B + 1] + lc * V[Cc + 1]) / ls;
          var inAny = false;
          for (var q = 0; q < lps.length && !inAny; q++) if (inLoop(x, y, lps[q])) inAny = true;
          flatSide[tt] = inAny ? 2 : 1;
        });
      });
    });
    if (flatErr) return { reason: flatErr };

    /* The void's walls: every face that borders buried space, turned inside
       out; a face whose side changes inside its span is cut there. */
    var W = new Faces(), pieces = new Map(), wallTris = 0, cutAt = new Map(), split = [];
    for (t = 0; t < nt; t++) {
      if (E.edgeOf[t * 3] < 0) continue;
      var tri = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
      if (flatAt[t] >= 0 || (tlo[t] === thi[t])) {
        var fs = flatAt[t] >= 0 ? flatSide[t] : (labOff[t] >= 0 ? lab[labOff[t]] : 0);
        if (fs === 2) { W.add(tri[0], tri[2], tri[1], WALL, t); wallTris++; }
        continue;
      }
      if (labOff[t] < 0) continue;
      var n = j1[t] - j0[t] + 1, anyW = false, allW = true;
      for (k = 0; k < n; k++) { if (lab[labOff[t] + k] === 2) anyW = true; else allW = false; }
      if (!anyW) continue;
      wallTris++;
      var cutBelow = jj0[t] < j0[t], cutAbove = jj1[t] > j1[t];
      if (allW && !cutBelow && !cutAbove) { W.add(tri[0], tri[2], tri[1], WALL, t); continue; }
      /* Heights where the side changes, bottom up; out of range counts as outside. */
      var cuts = [], sides = [], cur = cutBelow ? false : lab[labOff[t]] === 2;
      sides.push(cur);
      for (k = 0; k < n; k++) {
        var isW = lab[labOff[t] + k] === 2;
        if (isW !== cur) { cuts.push(C[j0[t] + k]); sides.push(isW); cur = isW; }
      }
      if (cutAbove && cur) { cuts.push(C[j1[t] + 1]); sides.push(false); }
      var rest = tri, parts = [];
      for (var cI = 0; cI < cuts.length; cI++) {
        var zc2 = cuts[cI], below = [], abv = [], atH = cutAt.get(zc2);
        if (!atH) { atH = new Set(); cutAt.set(zc2, atH); }
        for (k = 0; k < rest.length; k++) {
          var u = rest[k], w = rest[(k + 1) % rest.length], zu = S.P[u * 3 + 2], zw = S.P[w * 3 + 2];
          if (zu <= zc2) below.push(u);
          if (zu >= zc2) abv.push(u);
          atH.add(u);
          if ((zu < zc2 && zw > zc2) || (zu > zc2 && zw < zc2)) { var x2 = S.split(u, w, 2, zc2); below.push(x2); abv.push(x2); atH.add(x2); }
        }
        if (below.length >= 3) parts.push({ poly: below, buried: sides[cI] });
        rest = abv;
      }
      if (rest.length >= 3) parts.push({ poly: rest, buried: sides[cuts.length] });
      pieces.set(t, parts);
      split.push(t);
    }
    /* The corners of those cuts, welded on each height as a box cut welds
       them; then the cut faces' buried parts join the void. */
    var folded = 0;
    cutAt.forEach(function (set, zc3) { folded += weldPlane(S, set, 2, zc3); });
    for (var sp = 0; sp < split.length; sp++) {
      var tp = split[sp], pl = pieces.get(tp), kept = [];
      for (k = 0; k < pl.length; k++) {
        var poly2 = folded ? refoldPoly(S, pl[k].poly) : pl[k].poly;
        if (poly2.length < 3) continue;
        kept.push({ poly: poly2, buried: pl[k].buried });
        if (pl[k].buried) W.addPoly(poly2, WALL, tp, true);
      }
      pieces.set(tp, kept);
    }

    /* Lids: where the void's walls stop against air, a flat lid closes them -
       facing up over buried space below it, down under buried space above. */
    var X = edgeTable(W), P = S.P, groups = new Map(), bad = 0;
    for (var xe = 0; xe < X.ne; xe++) {
      if (X.fwd[xe] + X.rev[xe] !== 1) continue;
      var fi = X.face[xe], p0 = X.fwd[xe] ? X.lo[xe] : X.hi[xe], q0 = X.fwd[xe] ? X.hi[xe] : X.lo[xe];
      /* Buried space only ends at a critical height (or the range's ends,
         which are critical heights too): the lid is on that height. */
      var zm = (P[p0 * 3 + 2] + P[q0 * 3 + 2]) / 2, cz = lowerBound(C, zm);
      if (cz >= C.length || (cz > 0 && zm - C[cz - 1] < C[cz] - zm)) cz--;
      var zp = C[cz];
      if (Math.abs(P[p0 * 3 + 2] - zp) > 2 * BOX_TOL || Math.abs(P[q0 * 3 + 2] - zp) > 2 * BOX_TOL) { bad++; continue; }
      var fv = [W.a[fi], W.b[fi], W.c[fi]], third = -1;
      for (var r0 = 0; r0 < 3; r0++) if (fv[r0] !== p0 && fv[r0] !== q0) third = fv[r0];
      var zt = P[third * 3 + 2], facing;
      if (zt < zp - 2 * BOX_TOL) facing = 1;
      else if (zt > zp + 2 * BOX_TOL) facing = -1;
      else {
        var A = fv[0] * 3, B = fv[1] * 3, Cc = fv[2] * 3;
        facing = ((P[B] - P[A]) * (P[Cc + 1] - P[A + 1]) - (P[B + 1] - P[A + 1]) * (P[Cc] - P[A])) > 0 ? 1 : -1;
      }
      var gk = zp + '|' + facing, g = groups.get(gk);
      if (!g) { g = { z: zp, facing: facing, edges: [] }; groups.set(gk, g); }
      g.edges.push(q0, p0);
    }
    if (bad) return { reason: bad + ' edge' + (bad === 1 ? '' : 's') + ' where buried space ends are not level' };
    var lidErr = null;
    groups.forEach(function (g) {
      if (lidErr) return;
      var loops = chainLoops(P, g.edges, 2, g.facing);
      var tris = loops && capTris(P, loops, 2, g.facing);
      if (!tris) { lidErr = 'the lid at ' + f1(g.z) + ' mm could not be made'; return; }
      var pl = S.plane(2, g.z, g.facing);
      for (var r = 0; r < tris.length; r += 3) W.add(tris[r], tris[r + 1], tris[r + 2], LID, pl);
    });
    if (lidErr) return { reason: lidErr };
    return { faces: W, pieces: pieces, wallTris: wallTris, slabs: nS, critical: C.length, unlabeled: unlabeled };
  }

  /* A face list's edges: each undirected edge once, how many faces run it
     each way (fwd: low id to high, rev: back) and one face on it. */
  function edgeTable(F) {
    var n = F.size(), m = n * 3, mask = pow2(m + (m >> 1)) - 1, table = new Int32Array(mask + 1).fill(-1);
    var lo = new Int32Array(m), hi = new Int32Array(m), fwd = new Uint8Array(m), rev = new Uint8Array(m), face = new Int32Array(m);
    var A = F.a, B = F.b, C = F.c, ne = 0;
    for (var i = 0; i < n; i++) {
      for (var k = 0; k < 3; k++) {
        var u = k === 0 ? A[i] : (k === 1 ? B[i] : C[i]), w = k === 0 ? B[i] : (k === 1 ? C[i] : A[i]);
        var l = u < w ? u : w, h2 = u < w ? w : u;
        var h = (Math.imul(l, 0x9E3779B1) ^ Math.imul(h2, 0x85EBCA77)) & mask, s;
        for (;;) {
          s = table[h];
          if (s < 0) { s = ne++; table[h] = s; lo[s] = l; hi[s] = h2; break; }
          if (lo[s] === l && hi[s] === h2) break;
          h = (h + 1) & mask;
        }
        if (u < w) { if (fwd[s] < 255) fwd[s]++; } else if (rev[s] < 255) rev[s]++;
        face[s] = i;
      }
    }
    return { ne: ne, lo: lo, hi: hi, fwd: fwd, rev: rev, face: face };
  }

  /* Is a face list closed: every directed edge once, its reverse once? */
  function closedFaces(F) {
    var X = edgeTable(F), open = 0, nm = 0;
    for (var e = 0; e < X.ne; e++) {
      if (X.fwd[e] === 1 && X.rev[e] === 1) continue;
      if (X.fwd[e] + X.rev[e] === 1) open++; else nm++;
    }
    return { open: open, nm: nm, closed: !open && !nm };
  }

  /* The parts of one face outside the foam (in the void's winding, `lst`
     into `outside`) laid again in the piece's winding: their outline, less
     the corners nobody needs (each lies on a straight run of the outline),
     filled by the cap code in the face's own plane. Parts that cannot be laid
     again are handed back as they are. */
  function relay(S, outside, lst, needed, tp, T) {
    var P = S.P, flat = [], i;
    for (i = 0; i < lst.length; i++) {
      var a = S.find(outside.a[lst[i]]), b = S.find(outside.b[lst[i]]), c = S.find(outside.c[lst[i]]);
      if (a === b || b === c || a === c) continue;
      flat.push(a, c, b);                               // back in the piece's winding
    }
    var o0 = T[tp * 3] * 3, o1 = T[tp * 3 + 1] * 3, o2 = T[tp * 3 + 2] * 3;
    var nrm = cross([P[o1] - P[o0], P[o1 + 1] - P[o0 + 1], P[o1 + 2] - P[o0 + 2]], [P[o2] - P[o0], P[o2 + 1] - P[o0 + 1], P[o2 + 2] - P[o0 + 2]]);
    var ax = Math.abs(nrm[0]) >= Math.abs(nrm[1]) && Math.abs(nrm[0]) >= Math.abs(nrm[2]) ? 0 : (Math.abs(nrm[1]) >= Math.abs(nrm[2]) ? 1 : 2);
    var out = relayRegion(P, flat, ax, nrm[ax] > 0 ? 1 : -1, function (v) { return v < S.nv || needed.has(v); }, true);
    return out || flat;
  }

  /* Faces lying in one plane (flat ids, wound to face `sign` along `ax`) laid
     again from their outline with the corners `need` refuses left out - each
     lies on a straight run of the outline. split: first split the faces' edges
     at their own corners lying on them (parts cut at different times). -> the
     new flat ids, or null to keep them as they were. */
  function relayRegion(P, flat, ax, sign, need, split) {
    var n = flat.length / 3, i, k, drop = false;
    for (i = 0; i < flat.length && !drop; i++) if (!need(flat[i])) drop = true;
    if (!drop || n < 2) return null;
    if (split) {
      var cl = Array.from(new Set(flat)), out = [];
      for (i = 0; i < n; i++) {
        var v = [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]], ins = [null, null, null], hit = false;
        for (k = 0; k < 3; k++) {
          var on = onSegment(P, v[k], v[(k + 1) % 3], cl);
          if (on.length) { ins[k] = on; hit = true; }
        }
        if (!hit) out.push(v[0], v[1], v[2]); else splitTri(v, ins, out);
      }
      flat = out; n = flat.length / 3;
    }
    var X = new Faces();
    for (i = 0; i < n; i++) X.add(flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2], WALL, 0);
    var E2 = edgeTable(X), edges = [];
    for (var e = 0; e < E2.ne; e++) {
      if (E2.fwd[e] + E2.rev[e] !== 1) continue;
      if (E2.fwd[e]) edges.push(E2.lo[e], E2.hi[e]); else edges.push(E2.hi[e], E2.lo[e]);
    }
    var loops = chainLoops(P, edges, ax, sign);
    if (!loops) return null;
    loops = loops.map(function (l) { return l.filter(need); }).filter(function (l) { return l.length >= 3; });
    var tris = loops.length ? capTris(P, loops, ax, sign) : null;
    if (!tris || !tris.length) return null;
    // the same area, or it is kept as it was
    var u2 = (ax + 1) % 3, v2 = (ax + 2) % 3;
    function area(list) {
      var sum = 0;
      for (var q = 0; q < list.length; q += 3) {
        var p = list[q] * 3, r1 = list[q + 1] * 3, r2 = list[q + 2] * 3;
        sum += (P[r1 + u2] - P[p + u2]) * (P[r2 + v2] - P[p + v2]) - (P[r1 + v2] - P[p + v2]) * (P[r2 + u2] - P[p + u2]);
      }
      return sum;
    }
    var a0 = area(flat), a1 = area(tris);
    if (!(Math.abs(a1 - a0) <= 1e-6 * Math.max(1, Math.abs(a0)))) return null;
    return tris;
  }

  /* relayRegion for the caps and lids (by plane) a cut crossed: a corner is
     needed when a face off that plane uses it. */
  function relayFlats(S, K, planes) {
    var n = K.size(), uses = new Map(), groups = new Map(), i;
    for (i = 0; i < n; i++) {
      var inG = K.tag[i] !== WALL && planes.has(K.src[i]);
      if (inG) {
        var g = groups.get(K.src[i]);
        if (!g) { g = []; groups.set(K.src[i], g); }
        g.push(i);
      }
    }
    if (!groups.size) return K;
    groups.forEach(function (list) {
      for (var j = 0; j < list.length; j++) [K.a[list[j]], K.b[list[j]], K.c[list[j]]].forEach(function (v) { if (!uses.has(v)) uses.set(v, new Set()); });
    });
    for (i = 0; i < n; i++) {
      var key = K.tag[i] === WALL ? -1 : K.src[i], va = uses.get(K.a[i]), vb = uses.get(K.b[i]), vc = uses.get(K.c[i]);
      if (va) va.add(key);
      if (vb) vb.add(key);
      if (vc) vc.add(key);
    }
    var replaced = new Map();
    groups.forEach(function (list, pl) {
      var q = S.planes[pl], flat = [];
      for (var j = 0; j < list.length; j++) flat.push(K.a[list[j]], K.b[list[j]], K.c[list[j]]);
      var tris = relayRegion(S.P, flat, q.axis, q.sign, function (v) {
        var u = uses.get(v);
        if (!u) return true;
        var other = false;
        u.forEach(function (k2) { if (k2 !== pl) other = true; });
        return other;
      }, false);
      if (tris) replaced.set(pl, { list: list, tris: tris });
    });
    if (!replaced.size) return K;
    var skip = new Uint8Array(n), G = new Faces();
    replaced.forEach(function (r) { r.list.forEach(function (j) { skip[j] = 1; }); });
    for (i = 0; i < n; i++) if (!skip[i]) G.add(K.a[i], K.b[i], K.c[i], K.tag[i], K.src[i]);
    replaced.forEach(function (r, pl) {
      var tg = K.tag[r.list[0]];
      for (var j = 0; j < r.tris.length; j += 3) G.add(r.tris[j], r.tris[j + 1], r.tris[j + 2], tg, pl);
    });
    return G;
  }

  /* The corners of `list` strictly inside the segment u-w (on its line), from u toward w. */
  function onSegment(P, u, w, list) {
    var ux = P[u * 3], uy = P[u * 3 + 1], uz = P[u * 3 + 2];
    var dx = P[w * 3] - ux, dy = P[w * 3 + 1] - uy, dz = P[w * 3 + 2] - uz, L2 = dx * dx + dy * dy + dz * dz, out = [];
    if (!(L2 > 0)) return out;
    for (var i = 0; i < list.length; i++) {
      var x = list[i];
      if (x === u || x === w) continue;
      var px = P[x * 3] - ux, py = P[x * 3 + 1] - uy, pz = P[x * 3 + 2] - uz, t = (px * dx + py * dy + pz * dz) / L2;
      if (!(t > 1e-9 && t < 1 - 1e-9)) continue;
      var cx = py * dz - pz * dy, cy = pz * dx - px * dz, cz = px * dy - py * dx;
      if (cx * cx + cy * cy + cz * cz > REACH2 * L2) continue;
      out.push([t, x]);
    }
    out.sort(function (a, b) { return a[0] - b[0]; });
    return out.map(function (p) { return p[1]; });
  }

  /* ---- T-junctions ---- */

  /* A face whose edge gained corners from a cut on the other side (its own
     edge u-w unpaired, the other side's edges running w -> x1 -> ... -> u along
     it) is split at them. Only faces listed in `suspects` are asked. */
  function mendTJunctions(P, out, suspects) {
    var dir = new Map(), i, k;
    for (var si = 0; si < suspects.length; si++) {
      i = suspects[si];
      for (k = 0; k < 3; k++) {
        var key = ekey(out[i * 3 + k], out[i * 3 + (k + 1) % 3]);
        dir.set(key, (dir.get(key) || 0) + 1);
      }
    }
    var openFrom = new Map();
    dir.forEach(function (c, key) {
      var p = Math.floor(key / EK), q = key - p * EK;
      if (dir.has(ekey(q, p))) return;
      var l = openFrom.get(p);
      if (!l) { l = []; openFrom.set(p, l); }
      l.push(q);
    });
    if (!openFrom.size) return { changed: [], added: [] };
    function along(u, w) {
      // the other side's chain from w back to u, strictly along the segment
      var ux = P[u * 3], uy = P[u * 3 + 1], uz = P[u * 3 + 2];
      var dx = P[w * 3] - ux, dy = P[w * 3 + 1] - uy, dz = P[w * 3 + 2] - uz, L2 = dx * dx + dy * dy + dz * dz;
      var chain = [], cur = w, guard = 0;
      while (cur !== u && guard++ < 64) {
        var nx = openFrom.get(cur), pick = -1, bestT = -1;
        if (!nx) return null;
        for (var r = 0; r < nx.length; r++) {
          var x = nx[r];
          if (x === u) { pick = u; break; }
          var px = P[x * 3] - ux, py = P[x * 3 + 1] - uy, pz = P[x * 3 + 2] - uz;
          var tt = (px * dx + py * dy + pz * dz) / L2;
          var cx = py * dz - pz * dy, cy = pz * dx - px * dz, cz = px * dy - py * dx;
          if (!(tt > 0 && tt < 1) || (cx * cx + cy * cy + cz * cz) > REACH2 * L2) continue;
          if (tt > bestT) { bestT = tt; pick = x; }
        }
        if (pick < 0) return null;
        if (pick !== u) chain.push(pick);
        cur = pick;
      }
      return cur === u && chain.length ? chain.reverse() : null;  // from u toward w
    }
    var changed = [], added = [];
    for (si = 0; si < suspects.length; si++) {
      i = suspects[si];
      var v = [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]], ins = [null, null, null], any = false;
      for (k = 0; k < 3; k++) {
        var u = v[k], w = v[(k + 1) % 3];
        if (dir.has(ekey(w, u))) continue;
        var ch = along(u, w);
        if (ch) { ins[k] = ch; any = true; }
      }
      if (!any) continue;
      changed.push(i);
      splitTri(v, ins, added);
    }
    return { changed: changed, added: added };
  }
  /* A triangle with corners inserted on its edges (ins[k]: the corners on edge
     k, from corner k toward k+1) into triangles: cut at one inserted corner
     and the opposite corner, and again on each half. */
  function splitTri(v, ins, out) {
    var k = -1;
    for (var r = 0; r < 3; r++) if (ins[r] && ins[r].length) { k = r; break; }
    if (k < 0) { out.push(v[0], v[1], v[2]); return; }
    var A = v[k], B = v[(k + 1) % 3], Cc = v[(k + 2) % 3], list = ins[k], mid = (list.length / 2) | 0, X = list[mid];
    var before = list.slice(0, mid), after = list.slice(mid + 1);
    var onBC = ins[(k + 1) % 3], onCA = ins[(k + 2) % 3];
    // A X C and X B C, in the original's winding (edges A->X, X->C, C->A and X->B, B->C, C->X)
    var i1 = [null, null, null], i2 = [null, null, null];
    i1[0] = before.length ? before : null; i1[2] = onCA;      // triangle [A, X, C]: edges A-X, X-C, C-A
    i2[0] = after.length ? after : null; i2[1] = onBC;        // triangle [X, B, C]: edges X-B, B-C, C-X
    splitTri([A, X, Cc], i1, out);
    splitTri([X, B, Cc], i2, out);
  }

  /* ---- the census, fast ---- */

  /* census() over exact corners, with an integer index rather than a string
     per corner: the same counts. */
  function censusFast(soup) {
    var nt = Math.floor(soup.length / 9), Q = new Float64Array(nt * 9);
    for (var i = 0; i < nt * 9; i++) Q[i] = soup[i];
    var W0 = weldExact(Q, nt * 3), T = W0.ids, E = buildEdges(T, nt), degen = 0;
    for (var t = 0; t < nt; t++) {
      var p = t * 9, a = T[t * 3], b = T[t * 3 + 1], c = T[t * 3 + 2];
      var cr = cross([soup[p + 3] - soup[p], soup[p + 4] - soup[p + 1], soup[p + 5] - soup[p + 2]],
                     [soup[p + 6] - soup[p], soup[p + 7] - soup[p + 1], soup[p + 8] - soup[p + 2]]);
      if (a === b || b === c || a === c || Math.hypot(cr[0], cr[1], cr[2]) < 1e-12) degen++;
    }
    return { tris: nt, open: E.open, nm: E.nm + E.flipped, degen: degen, closed: E.open === 0 && E.nm === 0 && E.flipped === 0 };
  }

  /* ---- the engine ---- */

  /* soup: the piece, a closed solid, in raw axes. frame: raw <-> box frame.
     box: { lo, hi } in the box frame. opts:
       level        the foam's surface (box-frame height), instead of amount
       amount       0..100 of the buried space's height in the box
       voidFaces    the old Foam's hollow: these input triangles ARE the void's
                    walls (a sealed shell), nothing else is asked
       skipList     the paint skip list (required)
       timings      an object to fill with the stages' milliseconds
     -> { ok, changed, mesh, addedVolume, touchedTris, level, span, ... } */
  function foamCore(soup, frame, box, opts) {
    var tm = opts.timings || null, t0 = clock(), t1;
    function lap(name) { if (tm) { t1 = clock(); tm[name] = (tm[name] || 0) + (t1 - t0); t0 = t1; } }
    var out = { ok: false, changed: false, mesh: soup, addedVolume: 0, touchedTris: [], reason: '', level: null, span: null };
    var nt = Math.floor(soup.length / 9);
    var Q = new Float64Array(nt * 9);
    if (frame.identity) { for (var i = 0; i < nt * 9; i++) Q[i] = soup[i]; }
    else for (i = 0; i < nt * 3; i++) frame.to(soup[i * 3], soup[i * 3 + 1], soup[i * 3 + 2], Q, i * 3);
    var W0 = weldExact(Q, nt * 3), T = W0.ids;
    var E = buildEdges(T, nt);
    var M = { V: W0.V, T: T, nv: W0.nv, nt: nt, E: E };
    lap('index');
    if (!opts.voidFaces && (E.open || E.nm || E.flipped)) {
      out.kind = 'notSolid';
      out.reason = 'it is not a closed solid (' + E.open + ' open, ' + (E.nm + E.flipped) + ' non-manifold edges), so ' +
        'there is no inside to tell buried space by';
      return out;
    }
    var S = new Store(W0.V, W0.nv), Wf, pieces = new Map(), info = {};
    if (opts.voidFaces) {
      Wf = new Faces();
      for (i = 0; i < opts.voidFaces.length; i++) {
        var tv = opts.voidFaces[i];
        Wf.add(T[tv * 3], T[tv * 3 + 2], T[tv * 3 + 1], WALL, tv);
      }
    } else {
      var B = buriedVoid(M, S, box.lo[2], box.hi[2]);
      if (B.reason) { out.kind = 'unread'; out.reason = 'its buried space could not be read: ' + B.reason; return out; }
      Wf = B.faces; pieces = B.pieces;
      info = { slabs: B.slabs, critical: B.critical, walls: B.wallTris, unlabeled: B.unlabeled };
    }
    lap('classify');
    var shut = closedFaces(Wf);
    if (!shut.closed) {
      out.kind = 'unread';
      out.reason = 'its buried space does not close (' + shut.open + ' open, ' + shut.nm + ' non-manifold edges)';
      return out;
    }

    /* The foam: the void cut by the box's six faces, then by the level. */
    var outside = new Faces(), F = Wf;
    var planes = [[2, box.lo[2], true], [2, box.hi[2], false], [0, box.lo[0], true], [0, box.hi[0], false],
                  [1, box.lo[1], true], [1, box.hi[1], false]];
    for (i = 0; i < planes.length && F && F.size(); i++) F = cutFaces(S, F, planes[i][0], planes[i][1], planes[i][2], outside);
    if (!F) { out.kind = 'unread'; out.reason = 'the box\'s cut through the buried space could not be capped'; return out; }
    var n = F.size(), P = S.P, zlo = Infinity, zhi = -Infinity;
    for (i = 0; i < n; i++) {
      var fz = [P[F.a[i] * 3 + 2], P[F.b[i] * 3 + 2], P[F.c[i] * 3 + 2]];
      for (var k = 0; k < 3; k++) { if (fz[k] < zlo) zlo = fz[k]; if (fz[k] > zhi) zhi = fz[k]; }
    }
    if (!n) { out.ok = false; out.kind = 'none'; out.info = info; return out; }
    out.span = [zlo, zhi];
    var L = opts.level != null ? +opts.level : zlo + Math.max(0, Math.min(100, +opts.amount || 0)) / 100 * (zhi - zlo);
    out.level = L;
    if (!(L > zlo + BOX_TOL)) { out.ok = true; out.reason = 'the level is at the floor of the buried space - nothing to set'; lap('cut'); return out; }
    if (L < zhi - BOX_TOL) F = cutFaces(S, F, 2, L, false, outside);
    if (!F) { out.kind = 'unread'; out.reason = 'the level\'s cut through the buried space could not be capped'; return out; }
    lap('cut');

    /* Setting it: which input triangles the foam reaches. */
    n = F.size();
    var touched = new Uint8Array(nt), nTouched = 0;
    for (i = 0; i < n; i++) if (F.tag[i] === WALL && !touched[F.src[i]]) { touched[F.src[i]] = 1; nTouched++; }
    var touchedList = [];
    for (i = 0; i < nt; i++) if (touched[i]) touchedList.push(i);
    out.touchedTris = touchedList;
    if (opts.skipList && opts.skipList.length) {
      var pa = paintedAmong(soup, touchedList, opts.skipList);
      if (pa) { out.kind = 'painted'; out.painted = pa; return out; }
    }
    var walled = new Uint8Array(nt);
    for (i = 0; i < Wf.size(); i++) if (Wf.tag[i] === WALL) walled[Wf.src[i]] = 1;
    /* The foam's volume, from its own closed faces. */
    var vf = 0;
    for (i = 0; i < n; i++) {
      var A = F.a[i] * 3, Bq = F.b[i] * 3, Cq = F.c[i] * 3;
      vf += P[A] * (P[Bq + 1] * P[Cq + 2] - P[Bq + 2] * P[Cq + 1]) - P[A + 1] * (P[Bq] * P[Cq + 2] - P[Bq + 2] * P[Cq]) +
            P[A + 2] * (P[Bq] * P[Cq + 1] - P[Bq + 1] * P[Cq]);
    }
    out.foamVolume = vf / 6;

    /* The result, by corner id: untouched triangles first, in their order
       (those off the void, then the void's own); then what is left of the
       faces the foam reached; then the foam's caps and lids. */
    var ids = [], keepT = [], block = [];
    for (i = 0; i < nt; i++) if (!touched[i] && !walled[i]) { ids.push(T[i * 3], T[i * 3 + 1], T[i * 3 + 2]); keepT.push(i); block.push(1); }
    for (i = 0; i < nt; i++) if (!touched[i] && walled[i]) { ids.push(T[i * 3], T[i * 3 + 1], T[i * 3 + 2]); keepT.push(i); block.push(2); }
    function put(a, b, c, bl) {
      a = S.find(a); b = S.find(b); c = S.find(c);
      if (a === b || b === c || a === c) return;
      ids.push(a, b, c); keepT.push(-1); block.push(bl);
    }
    for (i = 0; i < nt; i++) {
      if (!touched[i]) continue;
      var parts = pieces.get(i);
      if (parts) for (k = 0; k < parts.length; k++) {
        if (parts[k].buried) continue;
        var pp = refoldPoly(S, parts[k].poly);
        for (var q = 1; q + 1 < pp.length; q++) put(pp[0], pp[q], pp[q + 1], 3);
      }
    }
    /* What is left of a face the foam reached is that face less the foam's
       part of it. The box's planes are endless, so the cuts also crossed it
       where the box is not; those corners are dropped and what is left is
       laid again from the corners anything else needs - the face's own, the
       foam's caps and lids, the parts above or below where it was cut at a
       height - so nothing next to it has to change. */
    var needed = new Set(), byT = new Map(), ns = outside.size();
    for (i = 0; i < n; i++) if (F.tag[i] !== WALL) { needed.add(S.find(F.a[i])); needed.add(S.find(F.b[i])); needed.add(S.find(F.c[i])); }
    pieces.forEach(function (pl, tp) {
      if (!touched[tp]) return;
      for (var r = 0; r < pl.length; r++) if (!pl[r].buried) pl[r].poly.forEach(function (v) { needed.add(S.find(v)); });
    });
    for (i = 0; i < ns; i++) {
      if (!touched[outside.src[i]]) continue;
      var lst = byT.get(outside.src[i]);
      if (!lst) { lst = []; byT.set(outside.src[i], lst); }
      lst.push(i);
    }
    byT.forEach(function (lst, tp) {
      var tris = relay(S, outside, lst, needed, tp, T);
      for (var r = 0; r < tris.length; r += 3) put(tris[r], tris[r + 1], tris[r + 2], 3);
    });
    for (i = 0; i < n; i++) if (F.tag[i] !== WALL) put(F.a[i], F.b[i], F.c[i], 4);
    lap('assemble');

    /* T-junctions: only near what changed. An untouched triangle can only be
       open along an edge it shares with one the foam reached. */
    var suspects = [];
    for (i = 0; i < keepT.length; i++) {
      if (keepT[i] < 0) { suspects.push(i); continue; }
      var tt = keepT[i];
      for (k = 0; k < 3; k++) {
        var e = E.edgeOf[tt * 3 + k];
        if (e < 0) break;
        var oth = E.h0[e] === tt * 3 + k ? E.h1[e] : E.h0[e];
        if (oth >= 0 && (touched[(oth / 3) | 0] || pieces.has((oth / 3) | 0))) { suspects.push(i); break; }
      }
    }
    var mend = mendTJunctions(P, ids, suspects);
    lap('mend');

    /* Out to raw axes: an original corner is the corner it came from, bit for bit. */
    var drop = new Uint8Array(keepT.length);
    for (i = 0; i < mend.changed.length; i++) drop[mend.changed[i]] = 1;
    var nOut = 0;
    for (i = 0; i < keepT.length; i++) if (!drop[i]) nOut++;
    nOut += mend.added.length / 3;
    var res = new Float32Array(nOut * 9), at = 0, rawCache = new Map();
    function rawOf(v) {
      if (v < S.nv) { var c = W0.first[v] * 3; return [soup[c], soup[c + 1], soup[c + 2]]; }
      var r = rawCache.get(v);
      if (!r) { r = frame.from(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); rawCache.set(v, r); }
      return r;
    }
    function emit(a, b, c) {
      var ra = rawOf(a), rb = rawOf(b), rc = rawOf(c);
      res[at] = ra[0]; res[at + 1] = ra[1]; res[at + 2] = ra[2]; res[at + 3] = rb[0]; res[at + 4] = rb[1]; res[at + 5] = rb[2];
      res[at + 6] = rc[0]; res[at + 7] = rc[1]; res[at + 8] = rc[2]; at += 9;
    }
    var restFrom = -1;
    for (i = 0; i < keepT.length; i++) {
      if (drop[i]) continue;
      if (block[i] > 1 && restFrom < 0) restFrom = at / 9;
      if (keepT[i] >= 0) { for (k = 0; k < 9; k++) res[at + k] = soup[keepT[i] * 9 + k]; at += 9; }
      else emit(ids[i * 3], ids[i * 3 + 1], ids[i * 3 + 2]);
    }
    if (restFrom < 0) restFrom = at / 9;
    for (i = 0; i < mend.added.length; i += 3) emit(mend.added[i], mend.added[i + 1], mend.added[i + 2]);
    lap('emit');

    /* Checked before it is handed back: closed, 2-manifold, nothing collapsed
       (by exact corners, census()'s rule) - when the piece came in closed. */
    var cs = censusFast(res);
    lap('check');
    if ((!E.open && !E.nm && !E.flipped) && (!cs.closed || cs.degen)) {
      out.kind = 'open';
      out.census = cs;
      out.reason = 'the piece would not stay closed (' + cs.open + ' open, ' + cs.nm + ' non-manifold, ' + cs.degen +
        ' degenerate edges)';
      return out;
    }
    var sh = shellIds(T, nt, E), seen = new Uint8Array(sh.count), shells = [];
    for (i = 0; i < touchedList.length; i++) { var sid = sh.of[touchedList[i]]; if (!seen[sid]) { seen[sid] = 1; shells.push(sid); } }
    shells.sort(function (a, b) { return a - b; });
    out.ok = true;
    out.changed = true;
    out.mesh = res;
    out.census = cs;
    out.restFrom = restFrom;        // the first triangle after those off the void (block 1), untouched
    out.changedFaces = nTouched;
    out.mended = mend.changed.length;
    out.touchedShells = shells;
    out.shellCount = sh.count;
    out.info = info;
    out.addedVolume = signedVolume(res) - signedVolume(soup);
    lap('volume');
    return out;
  }

  /* ---- the API ---- */

  function soupOf(piece) {
    if (!piece) return null;
    if (ArrayBuffer.isView(piece) || Array.isArray(piece)) return piece;
    return piece.rawTris || piece.soup || null;
  }
  function nameOf(piece) { return (piece && piece.name) || 'the piece'; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function vec3(v) { return v && v.length === 3 && isNum(v[0]) && isNum(v[1]) && isNum(v[2]); }

  /* A refusal in the house contract: ok false, the reason in words, the mesh
     the piece as it came. */
  function refusal(soup, kind, reason) {
    return { ok: false, changed: false, kind: kind, mesh: soup, addedVolume: 0, touched: [], reason: reason };
  }
  function checkBox(box) {
    if (!box || typeof box !== 'object') return 'Foam needs a box: { c: [x, y, z], h: [hx, hy, hz], yaw }';
    if (box.kind != null && box.kind !== 'box') return 'Foam fills a box, not a ' + box.kind;
    if (!vec3(box.c)) return 'the box needs a centre, c: [x, y, z]';
    if (!vec3(box.h) || !(box.h[0] > 0 && box.h[1] > 0 && box.h[2] > 0)) return 'the box needs half-sizes above 0, h: [hx, hy, hz]';
    if (box.yaw != null && !isNum(box.yaw)) return 'the box yaw must be a number of degrees';
    return null;
  }

  /* foamBoxSolid(piece, box, amount): foamBox on a piece taken as one solid as
     it is (no overlap check, no merge). The engine; foamBox is this after the
     work-as-is rule. */
  function foamBoxSolid(piece, box, amount, opts) {
    opts = opts || {};
    var first = quickRefusal(piece, box, amount, opts);
    if (first) return first;
    var soup = soupOf(piece), name = nameOf(piece);
    var skip = piece.skipList !== undefined ? piece.skipList : opts.skipList;
    var a = amount == null ? 100 : Math.max(0, Math.min(100, +amount));
    var frame = boxFrame(piece && piece.toRaw, box.yaw || 0);
    if (!frame) return refusal(soup, 'pose', 'Foam: the piece\'s pose cannot be inverted. Nothing changed.');
    var th = (box.yaw || 0) * Math.PI / 180, c = box.yaw ? Math.cos(th) : 1, s = box.yaw ? Math.sin(th) : 0;
    var cq = [box.c[0] * c + box.c[1] * s, -box.c[0] * s + box.c[1] * c, box.c[2]];
    var lim = { lo: [cq[0] - box.h[0], cq[1] - box.h[1], cq[2] - box.h[2]], hi: [cq[0] + box.h[0], cq[1] + box.h[1], cq[2] + box.h[2]] };
    var r = foamCore(soup, frame, lim, { amount: a, skipList: skip, timings: opts.timings });
    var out = { ok: r.ok, changed: r.changed, kind: r.kind || (r.changed ? 'set' : 'nothing'), mesh: r.mesh,
                addedVolume: r.ok && r.changed ? r.addedVolume : 0, touched: r.touchedShells || [], level: r.level, span: r.span,
                amount: a, foamVolume: r.foamVolume || 0, changedFaces: r.changedFaces || 0, mended: r.mended || 0,
                touchedTris: r.touchedTris || [], shells: r.shellCount || 0, census: r.census, info: r.info, reason: '' };
    if (!r.ok) {
      out.mesh = soup;
      if (r.kind === 'none') {
        out.reason = 'Foam: there is no buried empty space in the box - inside it, ' + name + ' is all material or open ' +
          'air outside its outline, so there is nothing to fill. Nothing changed.';
      } else if (r.kind === 'painted') {
        var nm = (typeof opts.faceName === 'function') ? opts.faceName(r.painted.index) : null;
        out.painted = r.painted;
        out.reason = 'Foam stood down - ' + (nm || faceWord(r.painted.entry)) + ' is painted, and it is a face the foam ' +
          'would weld to. Paint elsewhere does not matter; clear this face\'s paint to foam here. Nothing changed.';
      } else {
        out.reason = 'Foam: ' + name + ' - ' + r.reason + '. Nothing changed.';
      }
      return out;
    }
    if (!r.changed) {
      out.reason = 'Foam: ' + (a <= 0 ? 'the amount is 0' : r.reason) + ' - nothing to set. Nothing changed.';
      return out;
    }
    out.reason = setWords(out);
    return out;
  }
  function setWords(r, merged) {
    var n = r.touched.length;
    return 'Foam set - ' + grouped(r.addedVolume) + ' mm³ of buried space filled (' + Math.round(r.amount) + '% of what the box ' +
      'holds, to ' + f1(r.level) + ' mm), welded to ' + (n ? n + ' shell' + (n === 1 ? '' : 's') : 'no face - it stands free in the ' +
      'space it filled') + (merged ? ' (' + merged + ')' : '') + '.';
  }

  /* Work as is (docs/WORK-AS-IS.md, the #213 rule): the overlap check and the
     merge, from the caller (opts.overlap), else the page's nsoOverlap (kept per
     piece, a big one in the worker), else the kernel's own functions. Unknown -
     nothing loaded to ask - is never a merge. */
  function overlapOf(opts) {
    if (opts.overlap) return opts.overlap;
    if (root && root.nsoOverlap && typeof root.nsoOverlap.merge === 'function') {
      return { measure: function (s) { return root.nsoOverlap.measureAsync(s); }, merge: function (s) { return root.nsoOverlap.merge(s); } };
    }
    var me = dep(null, 'NSO_overlapMeasure'), mg = dep(null, 'NSO_shellMergeCore');
    return (me && mg) ? { measure: me, merge: mg } : null;
  }
  function mergedNote(name, n) { return name + ' had ' + n + ' overlapping shells - merged for this operation'; }

  /* The merged solid's touched triangles -> the shells of the piece as it came:
     a corner it shares with the piece names the shell; failing that, the
     piece's triangle the face's centre lies on. */
  function originalShells(orig, merged, tris) {
    var nt = Math.floor(orig.length / 9), Q = new Float64Array(nt * 9), i;
    for (i = 0; i < nt * 9; i++) Q[i] = orig[i];
    var W0 = weldExact(Q, nt * 3), E = buildEdges(W0.ids, nt), sh = shellIds(W0.ids, nt, E), at = new Map();
    for (i = 0; i < nt * 3; i++) {
      var k = Q[i * 3] + ',' + Q[i * 3 + 1] + ',' + Q[i * 3 + 2];
      if (!at.has(k)) at.set(k, sh.of[(i / 3) | 0]);
    }
    var found = new Set();
    for (var q = 0; q < tris.length && found.size < sh.count; q++) {
      var o = tris[q] * 9, hit = -1;
      for (var c = 0; c < 3 && hit < 0; c++) {
        var key = merged[o + c * 3] + ',' + merged[o + c * 3 + 1] + ',' + merged[o + c * 3 + 2];
        if (at.has(key)) hit = at.get(key);
      }
      if (hit < 0) {
        var p = [(merged[o] + merged[o + 3] + merged[o + 6]) / 3, (merged[o + 1] + merged[o + 4] + merged[o + 7]) / 3,
                 (merged[o + 2] + merged[o + 5] + merged[o + 8]) / 3], best = Infinity;
        for (var t = 0; t < nt; t++) {
          var d = pointTriDist(p, orig, t * 9);
          if (d < best) { best = d; hit = sh.of[t]; }
        }
      }
      if (hit >= 0) found.add(hit);
    }
    return Array.from(found).sort(function (x, y) { return x - y; });
  }
  function pointTriDist(p, s, o) {
    var a = [s[o], s[o + 1], s[o + 2]], b = [s[o + 3], s[o + 4], s[o + 5]], c = [s[o + 6], s[o + 7], s[o + 8]];
    var ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    var n = norm(cross(ab, ac));
    if (!n) return Infinity;
    var ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]], dn = dot(ap, n);
    var q = [p[0] - n[0] * dn, p[1] - n[1] * dn, p[2] - n[2] * dn];
    // inside the triangle (by barycentric signs), else the plane distance plus how far outside it is
    var c1 = dot(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [q[0] - a[0], q[1] - a[1], q[2] - a[2]]), n);
    var c2 = dot(cross([c[0] - b[0], c[1] - b[1], c[2] - b[2]], [q[0] - b[0], q[1] - b[1], q[2] - b[2]]), n);
    var c3 = dot(cross([a[0] - c[0], a[1] - c[1], a[2] - c[2]], [q[0] - c[0], q[1] - c[1], q[2] - c[2]]), n);
    var out = Math.max(0, -Math.min(c1, c2, c3)) / (Math.hypot(ab[0], ab[1], ab[2]) + 1e-12);
    return Math.abs(dn) + out;
  }

  /* foamBox(piece, box, amount) -> Promise of { ok, changed, mesh, addedVolume, touched, reason, ... }

       piece   { rawTris, toRaw?, name?, skipList } - rawTris the piece's soup in
               its raw axes; toRaw (16 numbers, column-major) maps the plate
               frame P into it, as Crop takes it; skipList nsoMaskFaceList(m),
               REQUIRED (never assumed empty)
       box     Crop's Box: { c: [x, y, z], h: [hx, hy, hz], yaw } in P, mm and
               degrees about the vertical
       amount  0..100: the foam's surface, risen from the bottom of the buried
               space in the box to its top. 100 is all of it.

     mesh is the piece with the foam welded in (raw axes, a new soup); addedVolume
     the mm³ it gained; touched the ids of the piece's shells the foam welds to
     (shells numbered in the order of their first triangle). Pieces whose shells
     overlap are merged for this operation only, and the result is built on the
     merge (`merged` says so). Each call takes the result of the one before, so
     sprays stack. */
  function foamBox(piece, box, amount, opts) {
    opts = opts || {};
    var soup = soupOf(piece), name = nameOf(piece);
    var first = quickRefusal(piece, box, amount, opts);
    if (first) return Promise.resolve(first);
    var ov = overlapOf(opts);
    var skip = piece && piece.skipList !== undefined ? piece.skipList : opts.skipList;
    function onMerged(m, n, why) {
      if (m && (m.cancelled || m.timedOut)) {
        return refusal(soup, 'stopped', 'Foam: merging ' + name + '\'s overlapping shells ' + (m.timedOut ? 'ran too long and ' : '') +
          'was stopped. Nothing changed.');
      }
      if (!m || !m.ok) {
        return refusal(soup, 'merge', 'Foam: ' + name + ' has ' + (n || 'several') + ' overlapping shells that cannot be merged into one ' +
          'closed solid: ' + ((m && m.reason) || 'the kernel is not loaded') + '. Nothing changed.');
      }
      if (skip.length) {
        return refusal(soup, 'painted', 'Foam stood down - ' + name + '\'s shells ' + (why || 'overlap') + ', and merging them for the ' +
          'fill replaces every triangle, so the paint on it could not stay where it is. Clear the paint to foam it. Nothing changed.');
      }
      var p2 = {};
      for (var k in piece) if (Object.prototype.hasOwnProperty.call(piece, k)) p2[k] = piece[k];
      p2.rawTris = m.soup;
      var r = foamBoxSolid(p2, box, amount, opts);
      r.merged = mergedNote(name, n || 2);
      if (r.ok && r.changed) {
        r.touched = originalShells(soup, m.soup, r.touchedTris);
        r.reason = setWords(r, r.merged);
      } else if (!r.ok) r.mesh = soup;
      return r;
    }
    return Promise.resolve(ov ? ov.measure(soup) : null).then(function (me) {
      if (me && me.stopped) {
        return refusal(soup, 'stopped', 'Foam: the overlap check ' + (me.timedOut ? 'ran too long and ' : '') + 'was stopped. Nothing changed.');
      }
      if (me && me.overlapShells >= 2) {
        return Promise.resolve(ov.merge(soup)).then(function (m) { return onMerged(m, me.overlapShells); });
      }
      var r = foamBoxSolid(piece, box, amount, opts);
      /* Shells that touch without crossing, or a piece that is otherwise not
         one clean solid as it lies: the merge makes one, when it can. */
      if (!r.ok && r.kind === 'notSolid' && ov && ov.merge) {
        return Promise.resolve(ov.merge(soup)).then(function (m) {
          if (!m || !m.ok) return r;
          return onMerged(m, (m.shells || 2), 'are not one clean solid');
        });
      }
      return r;
    });
  }
  function quickRefusal(piece, box, amount, opts) {
    var soup = soupOf(piece);
    if (!soup || soup.length < 9) return refusal(soup, 'empty', 'Foam: the piece is empty - nothing to fill.');
    var skip = piece && piece.skipList !== undefined ? piece.skipList : opts.skipList;
    if (!Array.isArray(skip)) {
      return refusal(soup, 'paint', 'Foam needs the paint skip list (nsoMaskFaceList) - it is never assumed empty. Nothing changed.');
    }
    var bad = checkBox(box);
    if (bad) return refusal(soup, 'box', 'Foam: ' + bad + '. Nothing changed.');
    if (amount != null && !isNum(+amount)) return refusal(soup, 'amount', 'Foam: the amount must be a number from 0 to 100. Nothing changed.');
    return null;
  }

  var api = {
    analyse: analyse,
    preview: preview,
    foam: foam,
    foamBox: foamBox,
    foamBoxSolid: foamBoxSolid,
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
