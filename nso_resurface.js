/* nso_resurface.js - Resurface: put a surface back where work was done on it.
   docs/RESURFACE.md.

   Loads as a classic script (window.NSO_Resurface) and as a Node module. No DOM,
   no THREE. The soup is the app's usual triangle soup (9 numbers a triangle).

     NSO_Resurface.plan(soup, hit, opts)  -> { ok, reason, count, depth, ... }
     NSO_Resurface.apply(soup, plan)      -> { ok, soup, reason }

   WHY NOT READ THE DAMAGE. A tool that reads the recess off the mesh - its floor,
   its walls, its rim loop - is only as good as the mesh round it: a scan or a
   boolean leaves splinters, folds and piercing shells there, and the rim stops
   being a loop. This reads none of it. It looks DOWN a direction n (the stamp's
   axis, a click's normal) at the piece the way a ray does, and everything below
   is numbers on a grid:

     1. HEIGHT. A ray down every node of a grid over the box: the height of the
        first face it meets (h), how thick the material is under it (th), and
        the height of the underside (hb). A node no ray hits is air.
     2. THE WORK, BY ITS WALLS. A drop of more than 65 degrees between neighbouring
        nodes is a wall. Cut the grid along the walls: the pieces left that touch
        the box's edge or are most of it are the face (the click's own piece is
        tested however big - a trench runs out of any box); a piece that stands
        LOWER than the face across a wall is a pit, and it and the wall round it
        are the work. Air shut in by the piece is a hole straight through.
     3. WHICH WORK. The click's piece and those within reach (3 mm) of it,
        single linkage, as a word is.
     4. THE SURFACE TO RETURN TO. Q refitted to the ring of the face round the
        mask (3 to 12 nodes out; the rest of the box's work left out), and the
        small mismatch between it and the real heights at the mask's edge spread
        inward by Laplace's equation, so the new surface MEETS the old at the rim
        in height and carries the face's curvature across.
     5. THE NEW SKIN. The footprint is the work and four nodes (0.5 mm) of the face round
        it. Every triangle of the piece whose centre stands in the footprint and
        is visible from above (not under the floor, not above the face, not
        looking down) goes: the floor, the walls, the rim's splinters, the old
        skin. What is left has a hole whose edge is out in clean face, where the
        triangles are the piece's own. The hole is closed with the new surface:
        its edge the hole's own corners, welded to what they close, corner for
        corner; its inside triangulated and cut into 1 mm triangles, the new
        corners put on the surface of step 4 - the work's, and the measured face
        beyond; a hole straight through is closed top and bottom. The piece is as closed as it was; nothing was unioned, so there
        is nothing for a kernel to splinter, and a piece the kernel cannot
        read (the hand's shells pierce each other) is as good as any.

   The old surface under the floor is left where it is, inside the material the
   new skin now encloses.

   WHAT IT NEEDS OF THE PIECE: that a ray can hit it, and clean face a little way
   out from the work for the new skin to be welded to. Splinters, folded rims and
   piercing shells in the work itself do not matter: they are taken out with it.
   Splinter islands (kept skin shut in by the dropped triangles) go with the work.
   A hole straight through: the wall and the underside round it go too, and
   both faces are laid.

   PAINT SCOPE: NOT APPLICABLE here - this file reads a soup and returns a new
   one. The app's card (Text -> Remove) carries the paint check (docs/HANDOFF.md). */
(function (root) {
  'use strict';

  var BVH = root && root.NSO_BVH ? root.NSO_BVH : null;
  if (!BVH && typeof module !== 'undefined' && typeof require === 'function') {
    try { BVH = require('./nso_bvh.js'); } catch (e) { BVH = null; }
  }

  var DEFAULTS = {
    res: 0.12,        // mm between rays
    half: 6,          // the box's half-size along each axis of the face, mm
    tau: 0.06,        // how far under the face counts as work, mm
    reach: 3,         // mm: other work this near the click's is taken with it
    degree: 2,        // the face's order (2 or 3)
    pad: 0.3,         // mm the filler runs under the old floor
    band: 6,          // nodes the filler runs on past the mask
    dip: 0.015,       // mm a node the filler's top sinks under the old face in the band
    minWork: 3,       // nodes: smaller work than this is noise
    wallTan: 2.1,     // tan 65 degrees: a drop this steep between neighbouring nodes is a wall
    margin: 4,        // nodes of face round the work that the new skin covers
    maxNodes: 160000
  };

  function fmt(x) { var a = (Math.round(x * 10) / 10).toFixed(1); return a === '-0.0' ? '0.0' : a; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function unit(a) { var L = Math.hypot(a[0], a[1], a[2]); return L > 1e-300 ? [a[0] / L, a[1] / L, a[2] / L] : null; }

  /* ----------------------------------------------------------- the heights */

  function frameOf(n, hint) {
    var e1 = hint && Math.abs(dot(hint, n)) < 0.99 ? unit([hint[0] - dot(hint, n) * n[0], hint[1] - dot(hint, n) * n[1], hint[2] - dot(hint, n) * n[2]])
      : (Math.abs(n[0]) < 0.9 ? unit([0, -n[2], n[1]]) : unit([-n[2], 0, n[0]]));
    return { n: n, e1: e1, e2: cross(n, e1) };
  }

  /* A ray down every node: h (the face seen from above), th (its thickness) and hb
     (the underside), all heights along n from `o`; NaN where there is nothing. */
  function sample(soup, o, fr, G) {
    var nT = (soup.length / 9) | 0, ix = BVH && BVH.indexFor ? BVH.indexFor(soup, false, 64) : null, cand = [];
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], i, k;
    for (i = 0; i < soup.length; i += 3) for (k = 0; k < 3; k++) { if (soup[i + k] < lo[k]) lo[k] = soup[i + k]; if (soup[i + k] > hi[k]) hi[k] = soup[i + k]; }
    var L = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) + 2, N = G.nx * G.ny;
    var H = new Float32Array(N), TH = new Float32Array(N), HB = new Float32Array(N), d = [-fr.n[0], -fr.n[1], -fr.n[2]];
    var hits = [];
    for (var j = 0; j < G.ny; j++) for (i = 0; i < G.nx; i++) {
      var x = G.x0 + i * G.res, y = G.y0 + j * G.res, id = j * G.nx + i;
      var po = [o[0] + fr.e1[0] * x + fr.e2[0] * y + fr.n[0] * L, o[1] + fr.e1[1] * x + fr.e2[1] * y + fr.n[1] * L, o[2] + fr.e1[2] * x + fr.e2[2] * y + fr.n[2] * L];
      hits.length = 0;
      var list = ix ? BVH.rayCandidates(ix, po[0], po[1], po[2], d[0], d[1], d[2], 2 * L, cand) : null, m = list ? list.length : nT, q, t;
      for (q = 0; q < m; q++) {
        t = list ? list[q] : q;
        var b9 = 9 * t, ax = soup[b9], ay = soup[b9 + 1], az = soup[b9 + 2];
        var e1x = soup[b9 + 3] - ax, e1y = soup[b9 + 4] - ay, e1z = soup[b9 + 5] - az, e2x = soup[b9 + 6] - ax, e2y = soup[b9 + 7] - ay, e2z = soup[b9 + 8] - az;
        var px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x, det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-14) continue;
        var inv = 1 / det, tx = po[0] - ax, ty = po[1] - ay, tz = po[2] - az, u = (tx * px + ty * py + tz * pz) * inv;
        if (u < -1e-9 || u > 1 + 1e-9) continue;
        var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x, v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
        if (v < -1e-9 || u + v > 1 + 1e-9) continue;
        var tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (tt >= 0) hits.push([tt, det > 0 ? 1 : -1]);          // det > 0: the face looks back at the sender (a face seen from above); < 0: it looks away (an underside)
      }
      hits.sort(function (a, b) { return a[0] - b[0]; });
      var first = -1, second = -1, lastBack = -1;
      for (q = 0; q < hits.length; q++) {
        if (hits[q][1] > 0 && first < 0) first = q;
        if (hits[q][1] < 0) { if (first >= 0 && second < 0) second = q; lastBack = q; }
      }
      H[id] = first >= 0 ? L - hits[first][0] : NaN;
      TH[id] = first >= 0 && second >= 0 ? hits[second][0] - hits[first][0] : NaN;
      HB[id] = lastBack >= 0 ? L - hits[lastBack][0] : NaN;
    }
    return { H: H, TH: TH, HB: HB };
  }

  /* ------------------------------------------------------------- the face */

  function terms(u, v, deg) {
    var t = [1, u, v, u * u, u * v, v * v];
    if (deg >= 3) t.push(u * u * u, u * u * v, u * v * v, v * v * v);
    return t;
  }
  function solveLS(rows, ys, ws, nt) {                       // weighted least squares by the normal equations
    var A = [], b = [], i, j, k;
    for (i = 0; i < nt; i++) { A.push(new Float64Array(nt)); b.push(0); }
    for (k = 0; k < rows.length; k++) {
      var w = ws ? ws[k] : 1;
      for (i = 0; i < nt; i++) { b[i] += w * rows[k][i] * ys[k]; for (j = 0; j < nt; j++) A[i][j] += w * rows[k][i] * rows[k][j]; }
    }
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

  /* Laplace's equation over `free` nodes with `bound` (an index -> value map) round them. */
  function harmonic(G, free, bound) {
    var val = new Float64Array(G.nx * G.ny), ids = [], i;
    free.forEach(function (id) { ids.push(id); });
    var sum = 0, cnt = 0;
    bound.forEach(function (v) { sum += v; cnt++; });
    var mean = cnt ? sum / cnt : 0;
    for (i = 0; i < ids.length; i++) val[ids[i]] = mean;
    bound.forEach(function (v, id) { val[id] = v; });
    var nbr = [1, -1, G.nx, -G.nx];
    for (var it = 0; it < 4000; it++) {
      var move = 0;
      for (i = 0; i < ids.length; i++) {
        var id = ids[i], x = id % G.nx, s = 0, c = 0;
        if (x + 1 < G.nx) { s += val[id + 1]; c++; }
        if (x > 0) { s += val[id - 1]; c++; }
        if (id + G.nx < G.nx * G.ny) { s += val[id + G.nx]; c++; }
        if (id - G.nx >= 0) { s += val[id - G.nx]; c++; }
        var nv = s / c;
        move = Math.max(move, Math.abs(nv - val[id]));
        val[id] = nv;
      }
      if (move < 1e-6) break;
    }
    return val;
  }

  /* ---------------------------------------------------------------- plan */

  function refuse(reason, extra) {
    var r = { ok: false, reason: reason };
    for (var k in extra || {}) r[k] = extra[k];
    return r;
  }

  /* The surface the work was done on, and the filler that puts it back.
     hit { point, normal }: a click on the work (its floor or wall: anywhere in it);
     opts: n (the direction to look down, default the click's normal), axisHint,
     half, res, tau, reach, degree, pad. */
  function plan(soup, hit, opts) {
    var o = {}, k;
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in opts || {}) if (opts[k] !== undefined) o[k] = opts[k];
    if (!soup || soup.length < 36 || soup.length % 9) return refuse('there is no piece to resurface');
    var p0 = hit && (hit.point || hit.p || hit);
    if (!p0 || !(p0.length >= 3 || p0.x !== undefined)) return refuse('the click has no point on the piece');
    p0 = p0.length >= 3 ? [+p0[0], +p0[1], +p0[2]] : [+p0.x, +p0.y, +p0.z];
    var nIn = o.n || (hit && (hit.normal || hit.n)), n = nIn && unit([+nIn[0] || (nIn.x || 0), +nIn[1] || (nIn.y || 0), +nIn[2] || (nIn.z || 0)]);
    if (!n) return refuse('the click has no direction to look down');
    if (!(o.res >= 0.02 && o.res <= 1)) return refuse('the ray spacing needs a number between 0.02 and 1 mm');
    if (!(o.half >= 1 && o.half <= 100)) return refuse('the box needs a half-size between 1 and 100 mm');
    var fr = frameOf(n, o.axisHint), res = o.res, nx = Math.round(2 * o.half / res) + 1, ny = nx;
    while (nx * ny > o.maxNodes) { res *= 1.25; nx = Math.round(2 * o.half / res) + 1; ny = nx; }
    var G = { nx: nx, ny: ny, x0: -o.half, y0: -o.half, res: res };
    var S = sample(soup, p0, fr, G), N = nx * ny, i, j, id;
    // the click, as a node
    var ci = Math.round((0 - G.x0) / res), cj = Math.round((0 - G.y0) / res), cid = cj * nx + ci;
    // 1. the face: a polynomial through the top of the heights
    var u = new Float64Array(N), v = new Float64Array(N), valid = 0;
    for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) { id = j * nx + i; u[id] = (G.x0 + i * res) / o.half; v[id] = (G.y0 + j * res) / o.half; if (!isNaN(S.H[id])) valid++; }
    if (valid < 50) return refuse('the box holds almost none of the piece - look at the work from the side it was done on');
    var deg = o.degree >= 3 ? 3 : 2, nt = deg >= 3 ? 10 : 6;
    function evalQ(c, id2) { var t = terms(u[id2], v[id2], deg), s2 = 0; for (var a = 0; a < nt; a++) s2 += c[a] * t[a]; return s2; }
    function fitTop(include) {
      var c = null, tol = [2, 1, 0.5, 0.25, 0.12, o.tau];
      for (var pass = 0; pass < tol.length; pass++) {
        var rows = [], ys = [], a;
        for (a = 0; a < N; a++) {
          if (isNaN(S.H[a]) || !include(a)) continue;
          if (c && S.H[a] - evalQ(c, a) < -tol[pass]) continue;
          rows.push(terms(u[a], v[a], deg)); ys.push(S.H[a]);
        }
        if (rows.length < 3 * nt) return c;
        var c2 = solveLS(rows, ys, null, nt);
        if (!c2) return c;
        c = c2;
      }
      return c;
    }
    var Q = fitTop(function () { return true; });
    if (!Q) return refuse('the face under the work could not be fitted');
    // 2. the work. Work has WALLS: a drop of more than 65 degrees between neighbouring nodes. Cut the grid
    // along them and what is left falls into pieces; the pieces that touch the box's edge or are most of it
    // are the face; a piece that stands LOWER than the face across a wall is a pit - a recess, a trench, an
    // engraving - and with the wall round it is the work. (A fit of the whole box to a plane or a quadratic
    // was the first way to do this and it does not survive a palm: the face of a real part is not a
    // quadratic over a box.) Air shut in by the piece is a hole straight through.
    var wallN = new Uint8Array(N), mask = new Uint8Array(N), air = new Uint8Array(N), q = [];
    for (id = 0; id < N; id++) {
      if (isNaN(S.H[id])) { air[id] = 1; continue; }
      var gx = id % nx, g4 = [gx + 1 < nx ? id + 1 : -1, id + nx < N ? id + nx : -1];
      for (k = 0; k < 2; k++) if (g4[k] >= 0 && !isNaN(S.H[g4[k]]) && Math.abs(S.H[g4[k]] - S.H[id]) / res > o.wallTan) { wallN[id] = 1; wallN[g4[k]] = 1; }
    }
    var pieceOf = new Int32Array(N).fill(-1), pieces = [];
    for (id = 0; id < N; id++) {
      if (isNaN(S.H[id]) || wallN[id] || pieceOf[id] >= 0) continue;
      var Pc = { id: pieces.length, nodes: [], border: false }, stk = [id];
      pieceOf[id] = Pc.id;
      while (stk.length) {
        var t1 = stk.pop(), tx1 = t1 % nx, ty1 = (t1 / nx) | 0;
        Pc.nodes.push(t1);
        if (tx1 === 0 || ty1 === 0 || tx1 === nx - 1 || ty1 === ny - 1) Pc.border = true;
        [tx1 + 1 < nx ? t1 + 1 : -1, tx1 > 0 ? t1 - 1 : -1, t1 + nx < N ? t1 + nx : -1, t1 - nx >= 0 ? t1 - nx : -1].forEach(function (nb2) {
          if (nb2 >= 0 && !isNaN(S.H[nb2]) && !wallN[nb2] && pieceOf[nb2] < 0) { pieceOf[nb2] = Pc.id; stk.push(nb2); }
        });
      }
      pieces.push(Pc);
    }
    if (o.debug) { var wc = 0; for (id = 0; id < N; id++) wc += wallN[id]; console.log('walls', wc, 'pieces', pieces.length, 'sizes', pieces.map(function (P2) { return P2.nodes.length + (P2.border ? 'b' : ''); }).slice(0, 30).join(' ')); }
    // the click's own piece is tested however big it is or wherever it ends: a trench runs out of any box,
    // and its floor touches the edge; the face does not stand LOWER than what is across a wall from it
    function big(Pc) { return Pc.border || Pc.nodes.length > 0.3 * valid; }
    var clickPiece = -1;
    for (var rr = 0; rr <= 3 && clickPiece < 0; rr++) for (var qy = -rr; qy <= rr; qy++) for (var qx = -rr; qx <= rr; qx++) {
      if (Math.max(Math.abs(qx), Math.abs(qy)) !== rr) continue;
      var qi = (cj + qy) * nx + ci + qx;
      if (clickPiece < 0 && qi >= 0 && qi < N && pieceOf[qi] >= 0 && !big(pieces[pieceOf[qi]])) clickPiece = pieceOf[qi];
    }
    if (clickPiece < 0 && pieceOf[cid] >= 0) clickPiece = pieceOf[cid];       // the click is on a big piece itself: a trench floor
    var isFace = pieces.map(function (Pc) { return Pc.id !== clickPiece && big(Pc); });
    pieces.forEach(function (Pc) {
      if (isFace[Pc.id]) return;
      var hC = 0, nC = 0, hD = 0, nD = 0;
      Pc.nodes.forEach(function (a) {                       // across a wall from this piece: what stands there, and how high
        var ax = a % nx, ay = (a / nx) | 0;
        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (dd) {
          var bx = ax + dd[0], by = ay + dd[1];
          if (bx < 0 || by < 0 || bx >= nx || by >= ny) return;
          var w = by * nx + bx;
          if (!wallN[w]) return;
          hC += S.H[a]; nC++;
          for (var d2y = -2; d2y <= 2; d2y++) for (var d2x = -2; d2x <= 2; d2x++) {       // the wall is two nodes thick: look through it
            var cx = bx + d2x, cy = by + d2y;
            if (cx < 0 || cy < 0 || cx >= nx || cy >= ny) continue;
            var c2 = cy * nx + cx;
            if (!isNaN(S.H[c2]) && !wallN[c2] && pieceOf[c2] !== Pc.id) { hD += S.H[c2]; nD++; }
          }
        });
      });
      if (o.debug) console.log('piece', Pc.id, 'n', Pc.nodes.length, 'nC', nC, 'nD', nD, 'mean hC', nC ? (hC / nC).toFixed(2) : '-', 'hD', nD ? (hD / nD).toFixed(2) : '-');
      if (nC && nD && hD / nD - hC / nC > 0.1) {
        Pc.nodes.forEach(function (a) { mask[a] = 1; });
        Pc.nodes.forEach(function (a) {                     // and the wall round it
          var ax = a % nx, ay = (a / nx) | 0;
          for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
            var bx = ax + dx, by = ay + dy;
            if (bx < 0 || by < 0 || bx >= nx || by >= ny) continue;
            if (wallN[by * nx + bx]) mask[by * nx + bx] = 1;
          }
        });
      }
    });
    for (i = 0; i < nx; i++) for (j = 0; j < ny; j++) if ((i === 0 || j === 0 || i === nx - 1 || j === ny - 1) && air[j * nx + i] === 1) { air[j * nx + i] = 2; q.push(j * nx + i); }
    while (q.length) {                                       // air that reaches the box's edge is outside the piece
      id = q.pop();
      var xi = id % nx, nb = [xi + 1 < nx ? id + 1 : -1, xi > 0 ? id - 1 : -1, id + nx < N ? id + nx : -1, id - nx >= 0 ? id - nx : -1];
      for (k = 0; k < 4; k++) if (nb[k] >= 0 && air[nb[k]] === 1) { air[nb[k]] = 2; q.push(nb[k]); }
    }
    for (id = 0; id < N; id++) if (air[id] === 1) mask[id] = 2;     // shut-in air: a hole straight through
    // pieces of work (8-connected), the click's and those within reach
    var comp = new Int32Array(N).fill(-1), comps = [], c8 = [1, -1, nx, -nx, nx + 1, nx - 1, -nx + 1, -nx - 1];
    for (id = 0; id < N; id++) {
      if (!mask[id] || comp[id] >= 0) continue;
      var C = { id: comps.length, nodes: [], lo: [1e9, 1e9], hi: [-1e9, -1e9] }, st = [id];
      comp[id] = C.id;
      while (st.length) {
        var t0 = st.pop(), tx = t0 % nx, ty = (t0 / nx) | 0;
        C.nodes.push(t0);
        C.lo[0] = Math.min(C.lo[0], tx); C.lo[1] = Math.min(C.lo[1], ty); C.hi[0] = Math.max(C.hi[0], tx); C.hi[1] = Math.max(C.hi[1], ty);
        for (k = 0; k < 8; k++) {
          var nbx = tx + (k === 0 || k === 4 || k === 6 ? 1 : (k === 1 || k === 5 || k === 7 ? -1 : 0)), nby = ty + (k === 2 || k === 4 || k === 5 ? 1 : (k === 3 || k === 6 || k === 7 ? -1 : 0));
          if (nbx < 0 || nby < 0 || nbx >= nx || nby >= ny) continue;
          var nid = nby * nx + nbx;
          if (mask[nid] && comp[nid] < 0) { comp[nid] = C.id; st.push(nid); }
        }
      }
      if (C.nodes.length >= o.minWork) comps.push(C); else C.nodes.forEach(function (x2) { comp[x2] = -2; mask[x2] = 0; });
    }
    comps = comps.filter(function (C) { return C.nodes.length >= o.minWork; });
    if (!comps.length) return refuse('no pit with walls stands in this box - the box is not on any work, or the direction is not the one it was done from');
    function gap(A, B) { return Math.hypot(Math.max(0, A.lo[0] - B.hi[0], B.lo[0] - A.hi[0]), Math.max(0, A.lo[1] - B.hi[1], B.lo[1] - A.hi[1])) * res; }
    var first = null, bd = Infinity;
    comps.forEach(function (C) { var dd = 0; C.nodes.forEach(function (x2) { var dx = x2 % nx - ci, dy = ((x2 / nx) | 0) - cj, e = Math.hypot(dx, dy); if (!dd || e < dd) dd = e; }); if (dd < bd) { bd = dd; first = C; } });
    var chosen = [first], grew = true;
    while (grew) {
      grew = false;
      comps.forEach(function (C) { if (chosen.indexOf(C) < 0 && chosen.some(function (D) { return gap(C, D) <= o.reach; })) { chosen.push(C); grew = true; } });
    }
    var inMask = new Uint8Array(N), nMask = 0;
    chosen.forEach(function (C) { C.nodes.forEach(function (x2) { inMask[x2] = 1; nMask++; }); });
    // distance in nodes from the chosen work (Chebyshev), out to band
    var dist = new Int16Array(N).fill(-1), front = [];
    for (id = 0; id < N; id++) if (inMask[id]) { dist[id] = 0; front.push(id); }
    for (var step = 1; step <= o.band; step++) {
      var next = [];
      front.forEach(function (a) {
        var ax = a % nx, ay = (a / nx) | 0;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          var bx = ax + dx, by = ay + dy;
          if (bx < 0 || by < 0 || bx >= nx || by >= ny) continue;
          var bid = by * nx + bx;
          if (dist[bid] < 0) { dist[bid] = step; next.push(bid); }
        }
      });
      front = next;
    }
    // 3. the surface to return to: the face refitted to the ring round the work, the edge mismatch spread in
    var excl = new Uint8Array(N);                            // other work in the box does not count as face
    for (id = 0; id < N; id++) if (mask[id] && !inMask[id]) excl[id] = 1;
    var Q2 = fitTop(function (a) { return !excl[a] && !(dist[a] >= 0 && dist[a] <= 2) && (dist[a] < 0 ? true : dist[a] > 2); });
    var ringOnly = [];
    for (id = 0; id < N; id++) if (!isNaN(S.H[id]) && !excl[id] && dist[id] > 2 && dist[id] <= o.band + 6) ringOnly.push(id);
    var Qr = null;
    if (ringOnly.length >= 3 * nt) {                          // the ring alone, so the face is measured where it is, not box-wide
      var rows = [], ys = [];
      ringOnly.forEach(function (a) { rows.push(terms(u[a], v[a], deg)); ys.push(S.H[a]); });
      Qr = solveLS(rows, ys, null, nt);
    }
    var Qf = Qr || Q2 || Q;
    var free = new Set(), bound = new Map(), skirt = new Uint8Array(N);
    for (id = 0; id < N; id++) if (dist[id] >= 0 && dist[id] <= 2) free.add(id);
    free.forEach(function (a) {
      var ax = a % nx, ay = (a / nx) | 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var bx = ax + dx, by = ay + dy;
        if (bx < 0 || by < 0 || bx >= nx || by >= ny) continue;
        var bid = by * nx + bx;
        if (!free.has(bid) && !isNaN(S.H[bid]) && !excl[bid] && !bound.has(bid)) bound.set(bid, S.H[bid] - evalQ(Qf, bid));
      }
    });
    if (!bound.size) return refuse('there is no face left round the work in this box to carry across it - make the box larger');
    var corr = harmonic(G, free, bound);
    var Sf = new Float32Array(N);                             // the surface to return to, over the free nodes
    free.forEach(function (a) { Sf[a] = evalQ(Qf, a) + corr[a]; });
    // the bottom of a hole straight through: the underside read from below, spread across
    var HBf = null, holes = 0;
    chosen.forEach(function (C) { C.nodes.forEach(function (x2) { if (mask[x2] === 2) holes++; }); });
    if (holes) {
      var hfree = new Set(), hbound = new Map();
      for (id = 0; id < N; id++) if (mask[id] === 2 && inMask[id]) hfree.add(id);
      hfree.forEach(function (a) {
        var ax = a % nx, ay = (a / nx) | 0;
        for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
          var bx = ax + dx, by = ay + dy;
          if (bx < 0 || by < 0 || bx >= nx || by >= ny) continue;
          var bid = by * nx + bx;
          if (!hfree.has(bid) && !isNaN(S.HB[bid]) && !hbound.has(bid)) hbound.set(bid, S.HB[bid]);
        }
      });
      if (!hbound.size) return refuse('the hole has no underside round it to carry across');
      HBf = harmonic(G, hfree, hbound);
    }
    // 4. the surface the new skin follows: the new one over the work (and two nodes of rim), the measured face beyond
    var Tt = new Float32Array(N), maxDepth = 0, vol = 0;
    for (id = 0; id < N; id++) {
      if (dist[id] >= 0 && dist[id] <= 2 && free.has(id)) Tt[id] = Sf[id];
      else Tt[id] = S.H[id];
      if (dist[id] === 0 && !isNaN(S.H[id])) { maxDepth = Math.max(maxDepth, Sf[id] - S.H[id]); vol += (Sf[id] - S.H[id]) * res * res; }
    }
    var Tb = null, hnear = null;
    if (HBf) {                                                // the underside to return to, and where the hole is
      Tb = new Float32Array(N); hnear = new Uint8Array(N);
      for (id = 0; id < N; id++) Tb[id] = (mask[id] === 2 && inMask[id]) ? HBf[id] : S.HB[id];
      for (id = 0; id < N; id++) {
        if (!(mask[id] === 2 && inMask[id])) continue;
        var hx = id % nx, hy = (id / nx) | 0;
        for (var ey = -2; ey <= 2; ey++) for (var ex = -2; ex <= 2; ex++) {
          var gx2 = hx + ex, gy2 = hy + ey;
          if (gx2 >= 0 && gy2 >= 0 && gx2 < nx && gy2 < ny) hnear[gy2 * nx + gx2] = 1;
        }
      }
    }
    var area = nMask * res * res;
    var dbg = o.debug ? { nx: nx, ny: ny, res: res, H: S.H, mask: mask, inMask: inMask, Sf: Sf, Tt: Tt, dist: dist } : null;
    return {
      debug: dbg, ok: true, count: chosen.length, depth: maxDepth, area: area, volume: vol, holes: holes > 0, nodes: N, res: res,
      frame: { o: p0, n: fr.n, e1: fr.e1, e2: fr.e2 },
      _g: { G: G, H: S.H, T: Tt, B: Tb, hnear: hnear, dist: dist, margin: o.margin },
      reason: (chosen.length === 1 ? '1 piece of work' : chosen.length + ' pieces of work') + ', up to ' + fmt(maxDepth) + ' mm deep, ' + fmt(area) + ' mm², to put back'
    };
  }

  /* The piece with its skin replaced over the work: see the header, step 5. */
  var ISLAND = 400;                                             // a shut-in patch of skin this small is work, not island
  function apply(soup, pl) {
    if (!pl || !pl.ok || !pl._g) return { ok: false, reason: 'there is no plan to apply' };
    var NT = requireText();
    if (!NT || !NT._weld) return { ok: false, reason: 'the cap engine (nso_text.js) is not loaded' };
    var g = pl._g, G = g.G, fr = pl.frame, nx = G.nx, ny = G.ny, n = fr.n, t, k;
    var M = NT._weld(soup), drop = new Set();
    function bil(arr, x, y) {                                   // the grid's surface at (x, y), bilinear; null off it or where a corner is air
      var fx = (x - G.x0) / G.res, fy = (y - G.y0) / G.res, i0 = Math.floor(fx), j0 = Math.floor(fy);
      if (i0 < 0 || j0 < 0 || i0 + 1 >= nx || j0 + 1 >= ny) return null;
      var a = arr[j0 * nx + i0], b = arr[j0 * nx + i0 + 1], c = arr[(j0 + 1) * nx + i0], d = arr[(j0 + 1) * nx + i0 + 1];
      if (isNaN(a) || isNaN(b) || isNaN(c) || isNaN(d)) return null;
      var u = fx - i0, v = fy - j0;
      return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
    }
    // the triangles to take out: in the footprint, the skin seen from above - and, over a hole straight
    // through, its wall and the underside round it
    var Bz = g.B, hn = g.hnear;
    for (t = 0; t < M.n; t++) {
      var A = M.P[M.vid[3 * t]], B = M.P[M.vid[3 * t + 1]], C = M.P[M.vid[3 * t + 2]];
      var cx = (A[0] + B[0] + C[0]) / 3 - fr.o[0], cy = (A[1] + B[1] + C[1]) / 3 - fr.o[1], cz = (A[2] + B[2] + C[2]) / 3 - fr.o[2];
      var x = cx * fr.e1[0] + cy * fr.e1[1] + cz * fr.e1[2], y = cx * fr.e2[0] + cy * fr.e2[1] + cz * fr.e2[2], z = cx * n[0] + cy * n[1] + cz * n[2];
      var i0 = Math.round((x - G.x0) / G.res), j0 = Math.round((y - G.y0) / G.res);
      if (i0 < 1 || j0 < 1 || i0 >= nx - 1 || j0 >= ny - 1) continue;
      var dd = g.dist[j0 * nx + i0];
      if (dd < 0 || dd > g.margin) continue;
      var hmin = Infinity, hmax = -Infinity, bmin = Infinity, bmax = -Infinity;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        var hv = g.H[(j0 + dy) * nx + i0 + dx];
        if (!isNaN(hv)) { if (hv < hmin) hmin = hv; if (hv > hmax) hmax = hv; }
        if (Bz) {
          var bv = Bz[(j0 + dy) * nx + i0 + dx];
          if (!isNaN(bv)) { if (bv < bmin) bmin = bv; if (bv > bmax) bmax = bv; }
        }
      }
      var nd = M.nrm[3 * t] * n[0] + M.nrm[3 * t + 1] * n[1] + M.nrm[3 * t + 2] * n[2];
      if (isFinite(hmin) && z >= hmin - 0.08 && z <= hmax + 0.3 && nd >= -0.3) { drop.add(t); continue; }     // skin (an underside is not)
      if (Bz && isFinite(bmin)) {
        if (nd <= 0.3 && z >= bmin - 0.3 && z <= bmax + 0.08) drop.add(t);                                   // the underside round the hole
        else if (hn[j0 * nx + i0] && Math.abs(nd) < 0.5 && z >= bmin - 0.3 && z <= (isFinite(hmax) ? hmax : bmax) + 0.3) drop.add(t);   // the wall of the hole
      }
    }
    if (!drop.size) return { ok: false, reason: 'no skin stands over the work in this box' };
    // Islands: a bit of kept skin cut off from the rest by the dropped triangles (a splinter, a flake of
    // old wall) is a hole in the hole - a loop of no area the cap cannot go round. A kept patch that is
    // shut in by the dropped set and small is part of the work: it goes too. A big one is a real
    // island (a post through the work) and stays.
    var verdict = new Map(), isle = Math.min(ISLAND, Math.floor(drop.size / 4) + 4);
    drop.forEach(function (tt) {
      for (var e = 0; e < 3; e++) {
        var nb0 = NT._across(M, tt, e);
        if (nb0 < 0 || drop.has(nb0) || verdict.has(nb0)) continue;
        var comp = new Set([nb0]), stack = [nb0], big = false;
        while (stack.length && !big) {
          var cur = stack.pop();
          for (var e2 = 0; e2 < 3; e2++) {
            var nb2 = NT._across(M, cur, e2);
            if (nb2 < 0 || drop.has(nb2) || comp.has(nb2)) continue;
            comp.add(nb2); stack.push(nb2);
            if (comp.size > isle) { big = true; break; }
          }
        }
        comp.forEach(function (c) { verdict.set(c, big); });
        if (!big) comp.forEach(function (c) { drop.add(c); });
      }
    });
    // the hole's edge: the dropped triangles' edges whose other side stays
    var rim = [], open = false;
    drop.forEach(function (tt) {
      for (var e = 0; e < 3; e++) {
        var nb = NT._across(M, tt, e);
        if (nb < 0) { open = true; continue; }
        if (!drop.has(nb)) rim.push([M.vid[3 * tt + e], M.vid[3 * tt + (e + 1) % 3]]);
      }
    });
    if (open) return { ok: false, reason: 'the piece has an open edge under the work - Resurface will not close a hole next to one' };
    if (!rim.length) return { ok: false, reason: 'the work is the whole piece in this box - make the box larger so there is face round it' };
    // the rim in two: the edges on the top skin, and (over a hole straight through) those on the underside
    var rimT = [], rimB = [];
    rim.forEach(function (ed) {
      var P1 = M.P[ed[0]], P2 = M.P[ed[1]];
      if (!Bz) { rimT.push(ed); return; }
      var mx = (P1[0] + P2[0]) / 2 - fr.o[0], my = (P1[1] + P2[1]) / 2 - fr.o[1], mz = (P1[2] + P2[2]) / 2 - fr.o[2];
      var ex = mx * fr.e1[0] + my * fr.e1[1] + mz * fr.e1[2], ey = mx * fr.e2[0] + my * fr.e2[1] + mz * fr.e2[2], ez = mx * n[0] + my * n[1] + mz * n[2];
      var ti = bil(g.T, ex, ey), bi = bil(Bz, ex, ey);
      (bi !== null && (ti === null || Math.abs(ez - bi) < Math.abs(ez - ti)) ? rimB : rimT).push(ed);
    });
    var tris = [], loopCount = 0;
    [[rimT, false], [rimB, true]].forEach(function (sd) {
      if (!sd[0].length || tris === null) return;
      var down = sd[1], nn = down ? [-n[0], -n[1], -n[2]] : n;
      var lps = NT._loopsOf(sd[0], M, nn);
      if (!lps) { tris = null; return; }
      var l3 = lps.map(function (l) { return l.map(function (v) { return M.P[v]; }); });
      var frS = down ? { o: fr.o, n: nn, e1: fr.e1, e2: [-fr.e2[0], -fr.e2[1], -fr.e2[2]] } : fr;
      var atS = down ? function (x, y) { var h = bil(Bz, x, -y); return h === null ? null : -h; } : function (x, y) { return bil(g.T, x, y); };
      if (pl.debugApply) pl.debugApply(l3, frS, drop.size);
      var cp = NT.capLoops(l3, frS, atS, { sag: 0.01, minEdge: 0.4 });
      if (!cp.tris) { tris = { reason: cp.reason }; return; }
      tris = tris.concat(cp.tris); loopCount += lps.length;
    });
    if (tris === null) return { ok: false, reason: 'the edge of the hole where the old skin came out does not close into loops - make the box larger so it falls in clean face' };
    if (!Array.isArray(tris)) return { ok: false, reason: tris.reason };
    var cap = { tris: tris }, loops = { length: loopCount };
    var n0 = (soup.length / 9) | 0, out = new Float32Array((n0 - drop.size + cap.tris.length) * 9), q = 0;
    for (t = 0; t < n0; t++) {
      if (drop.has(t)) continue;
      out.set(soup.subarray(9 * t, 9 * t + 9), q); q += 9;
    }
    cap.tris.forEach(function (tr) { for (k = 0; k < 3; k++) { out[q++] = tr[k][0]; out[q++] = tr[k][1]; out[q++] = tr[k][2]; } });
    return { ok: true, soup: out, dropped: drop.size, added: cap.tris.length, loops: loops.length };
  }
  function requireText() {
    if (root && root.NSO_Text) return root.NSO_Text;
    try { return typeof require === 'function' ? require('./nso_text.js') : null; } catch (e) { return null; }
  }

  var API = { DEFAULTS: DEFAULTS, plan: plan, apply: apply, _sample: sample, _harmonic: harmonic };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Resurface = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
