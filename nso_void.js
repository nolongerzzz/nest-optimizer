/* nso_void.js - which void did you mean? The selection step of Extract bit.

   Loads as a classic script (window.NSO_Void) and as a Node module. Speaks the app's soup: a Float32Array
   of 9 numbers per triangle, one coordinate system throughout (the caller's), millimetres. No DOM, no THREE,
   no boolean kernel. It needs nso_thickness.js (the ray index) and nso_hollow.js (the exact EDT), the two
   files Hollow already stands on.

   WHY A CLICK. A piece's voids are not countable without being told which one: the bore of a tube, the
   Allen socket in a bolt head, the mouth on a face, the thread grooves, the dents between bumps, the
   gaps round a notch - they are all "space the piece does not fill". Guessing the largest (the first
   version of Extract bit) gave a slotted tube from a bolt and the whole blob from a head. So the user
   clicks the void - on its wall, or its bottom - and this file answers one question: which surface
   belongs to the void that click is in?

   THE ANSWER IS THE WALL, NOT A VOLUME. What comes back is the void's WALL: the corners of the triangles
   that face it, as a point list. The caller (nso_csg.js NSO_cavityCore) takes the convex hull of those
   points and subtracts the piece from it with the real kernel, so the bit's walls are the piece's own,
   exact, thread flanks and all. Here nothing is meshed and no volume is made; it is only used to decide
   which triangles are the void's.

   HOW THE WALL IS FOUND.
     1. The piece is voxelised on a grid (one ray a column, parity), padded by the biggest ball it will try.
     2. The click's point, nudged along the face's normal, is a node in the air: the SEED.
     3. A CLOSING of the piece by a ball of radius R fills every dent a ball that size cannot get into:
        the bore of a tube whose Ø is under 2R, a socket, a mouth, with a lid across the opening, the
        way a rolling ball bridges it. Closing less the piece is the filled space; the part of it the seed
        is in (6-connected) is THE VOID at R.
     4. R is tried upward from about a node. The seed is outside the filled space until R is big enough to
        close the void it is in, then the void jumps to its full size, then it holds - until R is big enough
        to close the dents next to it, where it leaks into them and grows again. The void is taken where
        it first HOLDS: the smallest ball that closes it, so the least reach into its neighbours. (opts.R
        asks for one radius instead: the "Lid R" box.)
     5. The piece's triangles that FACE that void (a node of it one or two nodes out along the outward normal,
        from some point on the triangle) are its wall. The lid's sag does not matter - only the wall is used, and the
        lid the caller makes is the hull's.

   -> select(soup, point, normal, opts) =
        { ok, points: Float32Array (xyz, x3 per wall corner, welded), tris, seed: [x,y,z], R, auto,
          cells, volumeMm3, pitch, tried: [{ R, cells }...], reason }
      ok false: reason says why in words (not inside a void, not a closed solid, nothing closes over it).  */

(function (root) {
  'use strict';

  var MAX_DIM = 110;          // nodes on the longest axis
  var MAX_NODES = 1.8e6;      // total nodes
  var MIN_CELLS = 6;          // a void smaller than this is a crease, not a void
  var HOLD = 1.3;             // the void "holds" when the next radius grows it by no more than this
  var GROW_RINGS = 2;         // rings of neighbouring triangles whose corners join the wall's, for the hull
  var STEP = 1.35;            // radius ratio between tries

  function need() {
    var TH = root && root.NSO_Thickness, H = root && root.NSO_Hollow;
    if (!TH || typeof TH.prepare !== 'function') throw new Error('nso_void.js needs nso_thickness.js');
    if (!H || typeof H.edt3d !== 'function') throw new Error('nso_void.js needs nso_hollow.js (edt3d)');
    return { TH: TH, H: H };
  }
  function round3(x) { return Math.round(x * 1000) / 1000; }

  /* Open edges of a welded index: a void is a notion that needs a closed piece. */
  function openEdges(vids) {
    var m = new Map(), open = 0;
    for (var f = 0; f < vids.length; f++) {
      var t = vids[f];
      for (var e = 0; e < 3; e++) {
        var a = t[e], b = t[(e + 1) % 3];
        if (a === b) continue;
        var k = a < b ? a * 4294967296 + b : b * 4294967296 + a;
        m.set(k, (m.get(k) || 0) + 1);
      }
    }
    m.forEach(function (c) { if (c !== 2) open++; });
    return open;
  }

  function select(soup, point, normal, opts) {
    opts = opts || {};
    var K = need(), TH = K.TH, H = K.H;
    if (!soup || soup.length < 9) return { ok: false, reason: 'nothing to extract from - empty piece' };
    if (!point || point.length < 3) return { ok: false, reason: 'click the void first - on a wall of it, or its bottom' };

    var P;
    try { P = TH.prepare(soup, {}); } catch (e) { return { ok: false, reason: 'could not index the piece - ' + ((e && e.message) || e) }; }
    if (!P) return { ok: false, reason: 'nothing to extract from - empty piece' };
    var open = openEdges(P.vids);
    /* A stray edge or two (a sliver the kernel left, a weld that closed a crease) moves parity along one column; a
       piece with no inside to speak of is another thing. */
    if (open > Math.max(8, P.vids.length * 0.002)) {
      return { ok: false, reason: 'a void needs a closed solid - this piece has ' + open + ' open or shared edge(s). Seal it first (Check & repair).' };
    }


    var userR = (typeof opts.R === 'number' && opts.R > 0) ? opts.R : null;
    var lo0 = P.lo, hi0 = P.hi;
    var maxSpan0 = Math.max(hi0[0] - lo0[0], hi0[1] - lo0[1], hi0[2] - lo0[2]);
    /* Small reach first: a fine grid, so a socket in a long bolt is many nodes across. A void too big for it (a
       bore nearly the piece's own width, a short ring whose lid sags the whole way down) is not closed by its biggest
       ball and the next reach is tried; the last is a coarse grid, which is enough to say which triangles face it. */
    var reaches = userR ? [userR] : [Math.max(0.15 * maxSpan0, 1), Math.max(0.55 * maxSpan0, 1), Math.max(1.3 * maxSpan0, 1)];
    var res = null;
    for (var q = 0; q < reaches.length; q++) {
      res = attempt(K, P, soup, point, normal, opts, reaches[q], userR);
      if (res.ok) return res;
    }
    return res;
  }

  /* One try at one reach: the biggest ball Rcap, which sets the padding and so the pitch. */
  function attempt(K, P, soup, point, normal, opts, Rcap, userR) {
    var H = K.H;
    var lo = P.lo, hi = P.hi;
    var span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    var maxSpan = Math.max(span[0], span[1], span[2]);
    /* The grid: the piece's box padded by the biggest ball, at a pitch that keeps the longest axis (and the
       whole grid) inside the limits. */
    var pitch = (maxSpan + 2 * Rcap) / (MAX_DIM - 6), guard = 0;
    while (guard++ < 100) {
      var pad0 = Math.ceil(Rcap / pitch) + 3;
      var nn = (Math.ceil(span[0] / pitch) + 2 * pad0) * (Math.ceil(span[1] / pitch) + 2 * pad0) * (Math.ceil(span[2] / pitch) + 2 * pad0);
      if (nn <= MAX_NODES) break;
      pitch *= 1.1;
    }
    if (typeof opts.pitch === 'number' && opts.pitch > 0) pitch = opts.pitch;
    var pad = Math.ceil(Rcap / pitch) + 3;
    var nx = Math.ceil(span[0] / pitch) + 2 * pad, ny = Math.ceil(span[1] / pitch) + 2 * pad, nz = Math.ceil(span[2] / pitch) + 2 * pad;
    var N = nx * ny * nz;
    /* Off any round fraction of the pitch, for the reason Hollow's grid is: a ray along a face of an axis-aligned
       piece is the one case parity gets wrong. */
    var jitter = pitch * 0.01374;
    var org = [lo[0] - pad * pitch + jitter, lo[1] - pad * pitch + jitter, lo[2] - pad * pitch + jitter];

    /* 1. inside / outside, one ray a column. */
    var inside = new Uint8Array(N);
    var zTop = org[2] + (nz - 1) * pitch;
    var i, j, k;
    for (j = 0; j < ny; j++) {
      var oy = org[1] + j * pitch;
      if (oy < lo[1] - pitch || oy > hi[1] + pitch) continue;
      for (i = 0; i < nx; i++) {
        var ox = org[0] + i * pitch;
        if (ox < lo[0] - pitch || ox > hi[0] + pitch) continue;
        var hits = P.hitsAlong([ox, oy, org[2]], [0, 0, 1], (zTop - org[2]) + pitch);
        if (!hits.length) continue;
        var h = 0;
        for (k = 0; k < nz; k++) {
          var s2 = k * pitch;
          while (h < hits.length && hits[h] <= s2) h++;
          if (h & 1) inside[(k * ny + j) * nx + i] = 1;
        }
      }
    }
    function nodeOf(x, y, z) {
      var a = Math.round((x - org[0]) / pitch), b = Math.round((y - org[1]) / pitch), c = Math.round((z - org[2]) / pitch);
      if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) return -1;
      return (c * ny + b) * nx + a;
    }

    /* 2. the seed: a node in the air on the side of the face the click is on. */
    var seed = -1;
    var nrm = null;
    if (normal && normal.length >= 3) {
      var nl = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
      if (nl > 1e-9) nrm = [normal[0] / nl, normal[1] / nl, normal[2] / nl];
    }
    var tries = nrm ? [1, 1.5, 2, 2.5, -1, -1.5, -2, -2.5] : [0];
    for (var q = 0; q < tries.length && seed < 0; q++) {
      var t = tries[q] * pitch;
      var cand = nrm ? nodeOf(point[0] + nrm[0] * t, point[1] + nrm[1] * t, point[2] + nrm[2] * t)
                     : nodeOf(point[0], point[1], point[2]);
      if (cand >= 0 && !inside[cand]) seed = cand;
    }
    if (seed < 0) return { ok: false, reason: 'that click is not on a wall facing air - click the void itself' };

    /* 3. distance to the piece, once: the dilations all come from it. */
    var sites = new Float64Array(N);
    for (var n0 = 0; n0 < N; n0++) sites[n0] = inside[n0] ? 0 : 1e18;
    var dS = H.edt3d(sites, nx, ny, nz);

    /* The void at one radius: the closing less the piece, the seed's part of it. null when the seed is not in it. */
    var stack = new Int32Array(N), mark = new Uint8Array(N);
    function voidAt(rNodes) {
      var r2 = rNodes * rNodes, n1;
      var comp = new Float64Array(N);                  // sites of the erosion: nodes NOT in the dilation
      for (n1 = 0; n1 < N; n1++) comp[n1] = (dS[n1] <= r2) ? 1e18 : 0;
      var e = H.edt3d(comp, nx, ny, nz);
      comp = null;
      var closed = function (idx) { return !inside[idx] && e[idx] > r2; };
      if (!closed(seed)) return null;
      mark.fill(0);
      var sp = 0, list = [];
      stack[sp++] = seed; mark[seed] = 1;
      var sx = nx, sxy = nx * ny;
      while (sp) {
        var c = stack[--sp];
        list.push(c);
        var ci = c % nx, cj = ((c / nx) | 0) % ny, ck = (c / sxy) | 0;
        var nb;
        if (ci > 0)      { nb = c - 1;   if (!mark[nb] && closed(nb)) { mark[nb] = 1; stack[sp++] = nb; } }
        if (ci < nx - 1) { nb = c + 1;   if (!mark[nb] && closed(nb)) { mark[nb] = 1; stack[sp++] = nb; } }
        if (cj > 0)      { nb = c - sx;  if (!mark[nb] && closed(nb)) { mark[nb] = 1; stack[sp++] = nb; } }
        if (cj < ny - 1) { nb = c + sx;  if (!mark[nb] && closed(nb)) { mark[nb] = 1; stack[sp++] = nb; } }
        if (ck > 0)      { nb = c - sxy; if (!mark[nb] && closed(nb)) { mark[nb] = 1; stack[sp++] = nb; } }
        if (ck < nz - 1) { nb = c + sxy; if (!mark[nb] && closed(nb)) { mark[nb] = 1; stack[sp++] = nb; } }
      }
      return list;
    }

    /* 4. the radii, smallest first; the void is taken where it first holds. */
    var radii = [];
    if (userR) radii.push(userR);
    else for (var r = 1.25 * pitch; r <= Rcap + 1e-9; r *= STEP) radii.push(r);
    var tried = [], chosen = null, prev = null;
    for (var ri = 0; ri < radii.length && !chosen; ri++) {
      var mm = radii[ri];
      var list = voidAt(mm / pitch);
      var cells = list ? list.length : 0;
      tried.push({ R: round3(mm), cells: cells });
      if (cells < MIN_CELLS) continue;
      var here = { R: mm, list: list, cells: cells };
      if (userR) chosen = here;
      else if (prev && cells <= prev.cells * HOLD) chosen = prev;     // it held: the smaller ball had it all
      else prev = here;
    }
    if (!chosen && prev) chosen = prev;                               // it never held: the biggest ball tried
    if (!chosen) {
      return { ok: false, reason: userR
        ? 'a ' + round3(userR) + ' mm ball does not close over where you clicked - try a bigger Lid R, or leave it blank'
        : 'nothing closes over where you clicked, up to a ' + round3(Rcap) + ' mm ball - it is not inside a void (is it on the outside of the piece?)',
        tried: tried };
    }

    /* 5. its wall: the triangles that FACE the void. A triangle is the void's wall when, from some point on it, one
       or two nodes out along its outward normal is a node of the void. Whole triangles, however long: the bore of a
       tube is a strip of triangles as long as the tube, with corners only on its two end rings, and those corners are
       FAR from the void at its lids (a lid is a thin dome over the opening) - asking about the corners dropped
       triangles at random and left the bit with a ragged edge. The top face round a socket faces away from the void
       and is never asked for. */
    var inV = new Uint8Array(N);
    for (var c2 = 0; c2 < chosen.list.length; c2++) inV[chosen.list[c2]] = 1;
    var nTri = (soup.length / 9) | 0, pts = [], seen = new Map(), wallTris = 0;
    var isWall = new Uint8Array(nTri);
    var FRONT = [1.0 * pitch, 1.75 * pitch];
    function faces(px, py, pz, nx0, ny0, nz0) {
      for (var d = 0; d < FRONT.length; d++) {
        var id = nodeOf(px + nx0 * FRONT[d], py + ny0 * FRONT[d], pz + nz0 * FRONT[d]);
        if (id >= 0 && inV[id]) return true;
      }
      return false;
    }
    for (var tI = 0; tI < nTri; tI++) {
      var o = tI * 9;
      var ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
      var ux = soup[o + 3] - ax, uy = soup[o + 4] - ay, uz = soup[o + 5] - az;
      var wx = soup[o + 6] - ax, wy = soup[o + 7] - ay, wz = soup[o + 8] - az;
      var tx = uy * wz - uz * wy, ty = uz * wx - ux * wz, tz = ux * wy - uy * wx;
      var tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      if (!(tl > 1e-12)) continue;
      tx /= tl; ty /= tl; tz /= tl;
      var longest = Math.max(Math.sqrt(ux * ux + uy * uy + uz * uz), Math.sqrt(wx * wx + wy * wy + wz * wz),
                             Math.sqrt((wx - ux) * (wx - ux) + (wy - uy) * (wy - uy) + (wz - uz) * (wz - uz)));
      var sub = Math.min(24, Math.max(1, Math.ceil(longest / pitch)));
      var hit = false;
      for (var i1 = 0; i1 <= sub && !hit; i1++) {
        for (var j1 = 0; i1 + j1 <= sub && !hit; j1++) {
          var fu = (sub === 1 ? 1 / 3 : i1 / sub), fw = (sub === 1 ? 1 / 3 : j1 / sub);
          if (faces(ax + ux * fu + wx * fw, ay + uy * fu + wy * fw, az + uz * fu + wz * fw, tx, ty, tz)) hit = true;
        }
      }
      if (!hit) continue;
      wallTris++;
      isWall[tI] = 1;
      for (var v = 0; v < 3; v++) {
        var x = soup[o + v * 3], y = soup[o + v * 3 + 1], z = soup[o + v * 3 + 2];
        var key = Math.round(x * 1e4) + ',' + Math.round(y * 1e4) + ',' + Math.round(z * 1e4);
        if (seen.has(key)) continue;
        seen.set(key, 1);
        pts.push(x, y, z);
      }
    }
    /* The wall's NEIGHBOURS: the triangles that share a corner with it, and so the corners of those. They are what
       the wall alone leaves out and the hull needs: the crest flats between a thread's flanks, and the flat end faces
       the bore opens on. Without them the lid of a threaded hole is the hull of its grooves alone, which at the ends
       is a plane that slopes down through the crests and cuts the top off the thread. With them the lid is the face
       the void opens on, flat. A corner of a neighbour is one the wall already has or a step from it, so a face of
       big triangles puts its far corners in the hull, which on a flat face is the same plane. */
    var grown = 0;
    if (opts.grow !== false && pts.length) {
      var isIn = new Map(seen);                      // the corners the hull has so far, by position
      function key3(o2) {
        return Math.round(soup[o2] * 1e4) + ',' + Math.round(soup[o2 + 1] * 1e4) + ',' + Math.round(soup[o2 + 2] * 1e4);
      }
      /* The box the wall's own corners fill, a half node over: a neighbour's corner joins the hull only inside it. The
         hull can fill out to the face the void opens on, but cannot reach past the void's own extent - the far
         corners of a big face, or the skin beyond a mouth's rim, would otherwise swell it. */
      var bl = [Infinity, Infinity, Infinity], bh = [-Infinity, -Infinity, -Infinity];
      for (var q1 = 0; q1 < pts.length; q1 += 3) for (var a1 = 0; a1 < 3; a1++) { if (pts[q1 + a1] < bl[a1]) bl[a1] = pts[q1 + a1]; if (pts[q1 + a1] > bh[a1]) bh[a1] = pts[q1 + a1]; }
      var bm = 0.5 * pitch + 1e-3;
      function inBox(x, y, z) { return x >= bl[0] - bm && x <= bh[0] + bm && y >= bl[1] - bm && y <= bh[1] + bm && z >= bl[2] - bm && z <= bh[2] + bm; }
      /* Two rings: the first takes the crest flats and the end face's triangles at the groove; the second the end
         face's triangles at the crests, which touch only the first ring. Each ring tests against the corners the ring
         before it ended with. */
      for (var ring = 0; ring < GROW_RINGS; ring++) {
        var wl = [Infinity, Infinity, Infinity], wh = [-Infinity, -Infinity, -Infinity];
        for (var q0 = 0; q0 < pts.length; q0 += 3) for (var a0 = 0; a0 < 3; a0++) { if (pts[q0 + a0] < wl[a0]) wl[a0] = pts[q0 + a0]; if (pts[q0 + a0] > wh[a0]) wh[a0] = pts[q0 + a0]; }
        var epad = 1e-3, add = [], addKeys = [];
        for (var tN = 0; tN < nTri; tN++) {
          if (isWall[tN]) continue;
          var on = tN * 9, any = false;
          for (var vv = 0; vv < 3 && !any; vv++) {    // a corner inside the box of the hull's corners, and then one that IS one
            var xx = soup[on + vv * 3], yy = soup[on + vv * 3 + 1], zz = soup[on + vv * 3 + 2];
            if (xx < wl[0] - epad || xx > wh[0] + epad || yy < wl[1] - epad || yy > wh[1] + epad || zz < wl[2] - epad || zz > wh[2] + epad) continue;
            if (isIn.has(key3(on + vv * 3))) any = true;
          }
          if (!any) continue;
          isWall[tN] = 2;                              // taken, so the next ring does not count it twice
          grown++;
          for (var v3 = 0; v3 < 3; v3++) {
            var k3 = key3(on + v3 * 3);
            if (isIn.has(k3) || !inBox(soup[on + v3 * 3], soup[on + v3 * 3 + 1], soup[on + v3 * 3 + 2])) continue;
            addKeys.push(k3);
            add.push(soup[on + v3 * 3], soup[on + v3 * 3 + 1], soup[on + v3 * 3 + 2]);
          }
        }
        for (var ak = 0; ak < addKeys.length; ak++) isIn.set(addKeys[ak], 1);
        for (var ad = 0; ad < add.length; ad++) pts.push(add[ad]);
        if (!add.length) break;
      }
    }
    if (wallTris < 2 || pts.length < 12) {
      return { ok: false, reason: 'found the void but not its wall (' + wallTris + ' triangle(s)) - try another click', tried: tried };
    }
    var seedPos = [org[0] + (seed % nx) * pitch, org[1] + (((seed / nx) | 0) % ny) * pitch, org[2] + ((seed / (nx * ny)) | 0) * pitch];
    return { ok: true, points: new Float32Array(pts), tris: wallTris, grown: grown, seed: seedPos, R: round3(chosen.R), auto: !userR,
             cells: chosen.cells, volumeMm3: chosen.cells * pitch * pitch * pitch, pitch: round3(pitch), span: round3(maxSpan), tried: tried, reason: '' };
  }

  var API = { select: select, MIN_CELLS: MIN_CELLS, HOLD: HOLD, STEP: STEP };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Void = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
