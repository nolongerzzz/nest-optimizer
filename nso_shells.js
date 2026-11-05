/* nso_shells.js - SHELLS AS PIECES: which shells of a piece cross which, and which sit inside which.

   Loads as a classic script (window.NSO_Shells) and as a Node module
   (require('../nso_shells.js')). Speaks the app's raw soup: a Float32Array/Array
   of 9 numbers per triangle, Z up, millimetres. No DOM, no Three.js, no other
   file: Split to parts (nso_split_parts.js), Lift (app-lift-plate.js) and the
   Findings row all ask here, and a worker can load it by name.

   THE RULE (docs/SHELLS-AS-PIECES.md)
     A closed shell that CROSSES another is a part. A closed shell that stands
     FREE of every other is a part. A closed shell wholly INSIDE another with no
     crossing is a cavity of it. box_closed is two closed shells laid through
     each other (74 piercing pairs): two parts, not one broken surface.

   WHERE THE NUMBERS COME FROM
     Crossing is NSO_Repair's own reading of the piercing count
     (NSO_Repair._overlapShells / pairCrosses): two triangles cross when each
     straddles the other's plane by more than CROSS_MM and they truly meet, so
     shells that merely touch (a mark sitting on a bar's face) do not. That
     reading is repeated here, not edited there, so NSO_Repair.js - which 213 of
     the suite's 262 steps reach - stays as it is; tools/nso_shells_test.js holds
     the two to the same pairs on box_closed.

   THE CONTRACT
     shells(soup, opts) -> { ok, n, shells, of, tris, words, reason }
         shells[i]: { id, faces (ascending), tris, closed, vol, lo, hi,
                      crosses: [ids], insideOf: id|null,
                      body, free, part, clear, liftable }
         owned: two or more parts and every one Lift takes out whole.
         `of` is the shell of each triangle (Int32Array); a face the cut left out
         (a collapsed sliver) is -1. opts.count: also count the crossing pairs
         (pairs, per shell and in all) - otherwise the first crossing of a pair
         of shells is enough and the search stops there.
         opts.cut: { n, of, faces } from cutShells() - shells already found
         (Split to parts passes its own, so both name the same faces).
         opts.inside false: skip the containment test (insideOf stays null) for
         a caller that wants only the crossings.
     cutShells(vids, pos) -> { n, of, faces }: the surface cut (see below).
     weld(soup, tol)      -> { vids: Int32Array (3 per face), pos: Float64Array, nv }
     extract(soup, faces) -> a new Float32Array of those triangles, bit for bit
     overlaps(items)      -> { pairs, names, line }: which of several pieces in plate space
                             ([{ name, soup }]) cross each other, and the export check's one
                             line about them
     describe(a)          -> "2 shells (box_closed ...)" the readout's words

   THE CUT. Touching-but-separate shells are separate. Faces join across an edge
   used by exactly two faces; an edge used by more (two shells meeting along it)
   is resolved by the order its faces come round the edge, each wedge of material
   pairing the two faces that bound it. Shells meeting at a corner share no edge
   and were never one. (Moved here from nso_split_parts.js, unchanged.) */
(function (root) {
  'use strict';

  var WELD_TOL = 1e-4;                    // "the same point" everywhere in this repo (nso_thickness.js)
  var CROSS_MM = 1e-3;                    // NSO_Repair.OVERLAP_CROSS_MM: how far past the other's plane counts as crossing
  var BOX_PAD = 1e-6;                     // a shell's box is inside another's to this
  var TIE = 1e-9;                         // radians: two faces at one angle round an edge
  var CELL = 0.01;                        // mm: the weld's hash cell (a hundred tolerances, so a point rarely sits near a seam)
  var DIRS = [[0.2672612, 0.5345225, 0.8017837],
              [-0.6, 0.31, 0.7396621],
              [0.1805, -0.9097, 0.3727]];   // three ray directions, none along an axis or a diagonal

  function words(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /* ------------------------------------------------------------------
     Weld: every corner of every face to a vertex id, corners within `tol` the
     same vertex. A hash of the corner's cell (and the neighbouring cells it is
     within tol of) over chained vertices - a collision costs a compare, never a
     wrong weld.
     ------------------------------------------------------------------ */
  function weld(soup, tol) {
    tol = tol > 0 ? tol : WELD_TOL;
    var nf = Math.floor(soup.length / 9), nc = nf * 3;
    var size = 1; while (size < nc * 2) size <<= 1;
    var mask = size - 1;
    var head = new Int32Array(size).fill(-1);
    var next = new Int32Array(nc), pos = new Float64Array(nc * 3), nv = 0;
    var vids = new Int32Array(nc);
    var inv = 1 / CELL, tol2 = tol * tol;

    function h(cx, cy, cz) {
      var k = (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) | 0;
      return (k ^ (k >>> 15)) & mask;
    }
    for (var c = 0; c < nc; c++) {
      var x = soup[c * 3], y = soup[c * 3 + 1], z = soup[c * 3 + 2];
      var fx = x * inv, fy = y * inv, fz = z * inv;
      var cx = Math.floor(fx), cy = Math.floor(fy), cz = Math.floor(fz);
      var lx = cx, hx = cx, ly = cy, hy = cy, lz = cz, hz = cz;
      var m = tol * inv;
      if (fx - cx < m) lx = cx - 1; else if (cx + 1 - fx < m) hx = cx + 1;
      if (fy - cy < m) ly = cy - 1; else if (cy + 1 - fy < m) hy = cy + 1;
      if (fz - cz < m) lz = cz - 1; else if (cz + 1 - fz < m) hz = cz + 1;
      var vid = -1;
      for (var a = lx; a <= hx && vid < 0; a++) for (var b = ly; b <= hy && vid < 0; b++) for (var d = lz; d <= hz && vid < 0; d++) {
        for (var v = head[h(a, b, d)]; v >= 0; v = next[v]) {
          var dx = x - pos[v * 3], dy = y - pos[v * 3 + 1], dz = z - pos[v * 3 + 2];
          if (dx * dx + dy * dy + dz * dz <= tol2) { vid = v; break; }
        }
      }
      if (vid < 0) {
        vid = nv++;
        pos[vid * 3] = x; pos[vid * 3 + 1] = y; pos[vid * 3 + 2] = z;
        var hh = h(cx, cy, cz);
        next[vid] = head[hh]; head[hh] = vid;
      }
      vids[c] = vid;
    }
    return { vids: vids, pos: pos, nv: nv, nf: nf };
  }

  /* ------------------------------------------------------------------
     The surface cut. vids: 3 welded corner ids per face; pos: 3 numbers per
     vertex. -> { n, of: Int32Array (shell per face), faces: [[face...]],
     odd: Uint8Array (1 per shell: it has an edge only one of its faces uses) }
     ------------------------------------------------------------------ */
  function cutShells(vids, pos) {
    var nf = Math.floor(vids.length / 3), f, e, k, nv = 0;
    for (var i = 0; i < vids.length; i++) if (vids[i] >= nv) nv = vids[i] + 1;
    var parent = new Int32Array(nf);
    for (f = 0; f < nf; f++) parent[f] = f;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }

    /* Per undirected edge: the faces on it, each as face * 2 + (1 when the face
       runs lo -> hi, else 0). An open-addressing table of the edge's first use,
       the rest chained, in face order. */
    var ne = nf * 3, size = 1; while (size < ne * 2) size <<= 1;
    var mask = size - 1, tab = new Int32Array(size).fill(-1), chain = new Int32Array(ne).fill(-1), last = new Int32Array(ne);
    var eLo = new Int32Array(ne), eHi = new Int32Array(ne), reps = [];
    for (f = 0; f < nf; f++) {
      for (e = 0; e < 3; e++) {
        var u = vids[f * 3 + e], w = vids[f * 3 + (e + 1) % 3];
        if (u === w) continue;                       // a collapsed edge joins nothing
        var lo = u < w ? u : w, hi = u < w ? w : u, id = f * 3 + e;
        eLo[id] = lo; eHi[id] = hi;
        var hh = (Math.imul(lo, 73856093) ^ Math.imul(hi, 19349663)) | 0;
        hh = (hh ^ (hh >>> 15)) & mask;
        for (;;) {
          var r = tab[hh];
          if (r < 0) { tab[hh] = id; last[id] = id; reps.push(id); break; }
          if (eLo[r] === lo && eHi[r] === hi) { chain[last[r]] = id; last[r] = id; break; }
          hh = (hh + 1) & mask;
        }
      }
    }
    var groups = [], singles = [];
    for (var ri = 0; ri < reps.length; ri++) {
      var r0 = reps[ri], r1 = chain[r0];
      if (r1 < 0) { singles.push((r0 / 3) | 0); continue; }          // one face on this edge: an open edge
      if (chain[r1] < 0) { union((r0 / 3) | 0, (r1 / 3) | 0); continue; }
      var lst = [];
      for (var q = r0; q >= 0; q = chain[q]) {
        var ff = (q / 3) | 0, ee = q - ff * 3;
        lst.push(ff * 2 + (vids[ff * 3 + ee] < vids[ff * 3 + (ee + 1) % 3] ? 1 : 0));
      }
      groups.push(lst);
      pairAround(lst, eLo[r0], eHi[r0], pos, vids, union);
    }

    var of = new Int32Array(nf).fill(-1), faces = [], n = 0;
    var idOf = new Map();
    for (f = 0; f < nf; f++) {
      var rt = find(f), s = idOf.get(rt);
      if (s === undefined) { s = n++; idOf.set(rt, s); faces.push([]); }
      of[f] = s;
      faces[s].push(f);
    }
    /* An edge one shell's faces use an odd number of times leaves that shell open. */
    var odd = new Uint8Array(n);
    for (var si = 0; si < singles.length; si++) odd[of[singles[si]]] = 1;
    for (var g = 0; g < groups.length; g++) {
      var gl = groups[g], per = new Map();
      for (var t = 0; t < gl.length; t++) { var sh = of[gl[t] >> 1]; per.set(sh, (per.get(sh) || 0) + 1); }
      per.forEach(function (cnt, sh2) { if (cnt & 1) odd[sh2] = 1; });
    }
    return { n: n, of: of, faces: faces, odd: odd };
  }

  /* An edge used by more than two faces: two shells meet along it. Come round the
     edge in angle; a face that runs lo -> hi has its material on the
     decreasing-angle side, one that runs hi -> lo on the increasing side, so a
     wedge of material is a hi -> lo face followed by the next lo -> hi face.
     Those two are one shell. Faces at one angle (two shells sharing a plane) are
     ordered the faces that close a wedge before the ones that open one. */
  function pairAround(lst, lo, hi, pos, vids, union) {
    var A = [pos[lo * 3], pos[lo * 3 + 1], pos[lo * 3 + 2]], B = [pos[hi * 3], pos[hi * 3 + 1], pos[hi * 3 + 2]];
    var ex = B[0] - A[0], ey = B[1] - A[1], ez = B[2] - A[2], L = Math.hypot(ex, ey, ez);
    if (!(L > 0)) return;
    ex /= L; ey /= L; ez /= L;
    // a basis (b1, b2) of the plane across the edge
    var ax = Math.abs(ex) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
    var b1x = ay * ez - 0 * ey, b1y = 0 * ex - ax * ez, b1z = ax * ey - ay * ex;
    var bl = Math.hypot(b1x, b1y, b1z);
    b1x /= bl; b1y /= bl; b1z /= bl;
    var b2x = ey * b1z - ez * b1y, b2y = ez * b1x - ex * b1z, b2z = ex * b1y - ey * b1x;
    var ent = [];
    for (var i = 0; i < lst.length; i++) {
      var f = lst[i] >> 1, up = (lst[i] & 1) === 1, x = -1;
      for (var k = 0; k < 3; k++) { var v = vids[f * 3 + k]; if (v !== lo && v !== hi) { x = v; break; } }
      if (x < 0) continue;                           // a sliver on this edge alone: no side to take
      var px = pos[x * 3] - A[0], py = pos[x * 3 + 1] - A[1], pz = pos[x * 3 + 2] - A[2], along = px * ex + py * ey + pz * ez;
      px -= along * ex; py -= along * ey; pz -= along * ez;
      if (!(Math.hypot(px, py, pz) > 0)) continue;
      ent.push({ f: f, up: up, th: Math.atan2(px * b2x + py * b2y + pz * b2z, px * b1x + py * b1y + pz * b1z) });
    }
    var k2 = ent.length;
    if (k2 < 2) return;
    ent.sort(function (p, q) { return p.th - q.th; });
    // start after the widest gap, so a tie never straddles the cut at +-pi
    var gi = 0, gw = -1;
    for (var g = 0; g < k2; g++) {
      var gap = g + 1 < k2 ? ent[g + 1].th - ent[g].th : ent[0].th + 2 * Math.PI - ent[g].th;
      if (gap > gw) { gw = gap; gi = (g + 1) % k2; }
    }
    var ord = [];
    for (var o = 0; o < k2; o++) ord.push(ent[(gi + o) % k2]);
    // within a tie, the faces that close a wedge (lo -> hi) come first
    for (var s = 0; s < k2;) {
      var t = s + 1;
      while (t < k2 && Math.abs(ord[t].th - ord[t - 1].th) <= TIE) t++;
      if (t - s > 1) {
        var grp = ord.slice(s, t);
        grp.sort(function (p, q) { return (q.up ? 1 : 0) - (p.up ? 1 : 0); });
        for (var m = 0; m < grp.length; m++) ord[s + m] = grp[m];
      }
      s = t;
    }
    for (var j = 0; j < k2; j++) {
      var cur = ord[j], nxt = ord[(j + 1) % k2];
      if (!cur.up && nxt.up) union(cur.f, nxt.f);
    }
  }

  /* ------------------------------------------------------------------
     Two triangles that CROSS (NSO_Repair.pairCrosses plus the meeting): each
     straddles the other's plane by more than CROSS_MM, and the two segments
     where each cuts the other's plane overlap. T and U are 9 numbers at offset
     o and p of arrays a and b.
     ------------------------------------------------------------------ */
  var _d = [0, 0, 0], _e = [0, 0, 0];
  function planeSide(s, o, t, p, out) {      // signed distances of t's corners to s's plane; -> straddles?
    var e1x = s[o + 3] - s[o], e1y = s[o + 4] - s[o + 1], e1z = s[o + 5] - s[o + 2];
    var e2x = s[o + 6] - s[o], e2y = s[o + 7] - s[o + 1], e2z = s[o + 8] - s[o + 2];
    var nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(L > 0)) return false;
    var pos = false, neg = false;
    for (var i = 0; i < 3; i++) {
      var d = ((t[p + i * 3] - s[o]) * nx + (t[p + i * 3 + 1] - s[o + 1]) * ny + (t[p + i * 3 + 2] - s[o + 2]) * nz) / L;
      out[i] = d;
      if (d > CROSS_MM) pos = true; else if (d < -CROSS_MM) neg = true;
    }
    return pos && neg;
  }
  /* The interval where triangle t (at p) cuts the plane of s (at o), along the direction D: from the
     signed distances d of t's corners; written to iv as [lo, hi]. */
  function interval(t, p, d, D, iv) {
    var pr = [t[p] * D[0] + t[p + 1] * D[1] + t[p + 2] * D[2], t[p + 3] * D[0] + t[p + 4] * D[1] + t[p + 5] * D[2],
              t[p + 6] * D[0] + t[p + 7] * D[1] + t[p + 8] * D[2]];
    // the lone corner on one side; the other two on the other (a zero counts with the side that makes it a lone corner)
    var s0 = d[0] > 0, s1 = d[1] > 0, s2 = d[2] > 0, lone;
    if (s0 === s1) lone = 2; else if (s0 === s2) lone = 1; else lone = 0;
    var a = lone, b = (lone + 1) % 3, c = (lone + 2) % 3;
    var t1 = pr[a] + (pr[b] - pr[a]) * d[a] / (d[a] - d[b]);
    var t2 = pr[a] + (pr[c] - pr[a]) * d[a] / (d[a] - d[c]);
    iv[0] = Math.min(t1, t2); iv[1] = Math.max(t1, t2);
  }
  var _iv1 = [0, 0], _iv2 = [0, 0];
  function crossTri(a, o, b, p) {
    if (!planeSide(a, o, b, p, _d)) return false;      // b straddles a's plane
    if (!planeSide(b, p, a, o, _e)) return false;      // and a straddles b's
    var n1x = (a[o + 4] - a[o + 1]) * (a[o + 8] - a[o + 2]) - (a[o + 5] - a[o + 2]) * (a[o + 7] - a[o + 1]);
    var n1y = (a[o + 5] - a[o + 2]) * (a[o + 6] - a[o]) - (a[o + 3] - a[o]) * (a[o + 8] - a[o + 2]);
    var n1z = (a[o + 3] - a[o]) * (a[o + 7] - a[o + 1]) - (a[o + 4] - a[o + 1]) * (a[o + 6] - a[o]);
    var n2x = (b[p + 4] - b[p + 1]) * (b[p + 8] - b[p + 2]) - (b[p + 5] - b[p + 2]) * (b[p + 7] - b[p + 1]);
    var n2y = (b[p + 5] - b[p + 2]) * (b[p + 6] - b[p]) - (b[p + 3] - b[p]) * (b[p + 8] - b[p + 2]);
    var n2z = (b[p + 3] - b[p]) * (b[p + 7] - b[p + 1]) - (b[p + 4] - b[p + 1]) * (b[p + 6] - b[p]);
    var D = [n1y * n2z - n1z * n2y, n1z * n2x - n1x * n2z, n1x * n2y - n1y * n2x];
    if (!(Math.abs(D[0]) + Math.abs(D[1]) + Math.abs(D[2]) > 0)) return false;     // parallel planes: cannot straddle both
    interval(b, p, _d, D, _iv1);      // where b cuts a's plane
    interval(a, o, _e, D, _iv2);      // where a cuts b's plane
    return _iv1[0] <= _iv2[1] && _iv2[0] <= _iv1[1];
  }

  /* ------------------------------------------------------------------
     Do shells I and J cross? The triangles of each inside the other's box, the
     lesser list hashed on a grid, the greater walked against it. count: tally
     every crossing pair, else stop at the first.
     ------------------------------------------------------------------ */
  function triBox(soup, f, lo, hi) {
    var o = f * 9, x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (var k = 0; k < 3; k++) {
      var x = soup[o + k * 3], y = soup[o + k * 3 + 1], z = soup[o + k * 3 + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    lo[0] = x0; lo[1] = y0; lo[2] = z0; hi[0] = x1; hi[1] = y1; hi[2] = z1;
  }
  function inBox(soup, f, B) {
    var o = f * 9, x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (var k = 0; k < 3; k++) {
      var x = soup[o + k * 3], y = soup[o + k * 3 + 1], z = soup[o + k * 3 + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    return x1 >= B.lo[0] && x0 <= B.hi[0] && y1 >= B.lo[1] && y0 <= B.hi[1] && z1 >= B.lo[2] && z0 <= B.hi[2];
  }

  /* Shell SA of soupA against shell SB of soupB (one soup for the shells of one piece; two for two pieces). A shell's
     `faces` null means every triangle of its soup, `n` of them. */
  function facesIn(soup, S, B) {
    var out = [], n = S.faces ? S.faces.length : S.n, i;
    for (i = 0; i < n; i++) { var f = S.faces ? S.faces[i] : i; if (inBox(soup, f, B)) out.push(f); }
    return out;
  }

  function shellsCross(soupA, SI, soupB, SJ, count, mark) {
    var B = { lo: [0, 0, 0], hi: [0, 0, 0] }, a;
    for (a = 0; a < 3; a++) {
      B.lo[a] = Math.max(SI.lo[a], SJ.lo[a]) - CROSS_MM;
      B.hi[a] = Math.min(SI.hi[a], SJ.hi[a]) + CROSS_MM;
      if (B.lo[a] > B.hi[a]) return 0;
    }
    var li = facesIn(soupA, SI, B);
    if (!li.length) return 0;
    var lj = facesIn(soupB, SJ, B);
    if (!lj.length) return 0;
    var bigIsI = li.length >= lj.length;
    var big = bigIsI ? li : lj, small = bigIsI ? lj : li, bigSoup = bigIsI ? soupA : soupB, smallSoup = bigIsI ? soupB : soupA;
    var need = Math.floor(bigSoup.length / 9);
    if (mark.seen.length < need) mark.seen = new Int32Array(need);

    // a grid over the box, a cell about the size of the bigger list's triangles
    var span = [B.hi[0] - B.lo[0], B.hi[1] - B.lo[1], B.hi[2] - B.lo[2]], lo = [0, 0, 0], hi = [0, 0, 0], ext = 0, k;
    var stride = Math.max(1, Math.floor(big.length / 64)), sampled = 0;
    for (k = 0; k < big.length; k += stride) {
      triBox(bigSoup, big[k], lo, hi);
      ext += Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]); sampled++;
    }
    ext /= Math.max(1, sampled);
    var cell = Math.max(ext, 1e-6);
    var nx, ny, nz;
    for (;;) {
      nx = Math.max(1, Math.ceil(span[0] / cell)); ny = Math.max(1, Math.ceil(span[1] / cell)); nz = Math.max(1, Math.ceil(span[2] / cell));
      if (nx * ny * nz <= 1 << 21) break;
      cell *= 1.5;
    }
    var cells = new Map();
    function cellRange(l, h) {
      return [Math.max(0, Math.min(nx - 1, Math.floor((l[0] - B.lo[0]) / cell))), Math.max(0, Math.min(nx - 1, Math.floor((h[0] - B.lo[0]) / cell))),
              Math.max(0, Math.min(ny - 1, Math.floor((l[1] - B.lo[1]) / cell))), Math.max(0, Math.min(ny - 1, Math.floor((h[1] - B.lo[1]) / cell))),
              Math.max(0, Math.min(nz - 1, Math.floor((l[2] - B.lo[2]) / cell))), Math.max(0, Math.min(nz - 1, Math.floor((h[2] - B.lo[2]) / cell)))];
    }
    for (k = 0; k < big.length; k++) {
      triBox(bigSoup, big[k], lo, hi);
      var r = cellRange(lo, hi);
      for (var x = r[0]; x <= r[1]; x++) for (var y = r[2]; y <= r[3]; y++) for (var z = r[4]; z <= r[5]; z++) {
        var key = (z * ny + y) * nx + x, lst = cells.get(key);
        if (!lst) cells.set(key, lst = []);
        lst.push(big[k]);
      }
    }
    var seen = mark.seen, found = 0;
    for (k = 0; k < small.length; k++) {
      triBox(smallSoup, small[k], lo, hi);
      var q = cellRange(lo, hi);
      var stamp = ++mark.n;
      for (var x2 = q[0]; x2 <= q[1]; x2++) for (var y2 = q[2]; y2 <= q[3]; y2++) for (var z2 = q[4]; z2 <= q[5]; z2++) {
        var lst2 = cells.get((z2 * ny + y2) * nx + x2);
        if (!lst2) continue;
        for (var m = 0; m < lst2.length; m++) {
          var g = lst2[m];
          if (seen[g] === stamp) continue;
          seen[g] = stamp;
          if (crossTri(smallSoup, small[k] * 9, bigSoup, g * 9)) { found++; if (!count) return 1; }
        }
      }
    }
    return found;
  }

  /* ------------------------------------------------------------------
     Is shell S inside shell T: a point on S's skin against T's own faces, the
     parity of a ray in three directions and a vote.
     ------------------------------------------------------------------ */
  function rayHits(soup, faces, o, d) {
    var n = 0;
    for (var i = 0; i < faces.length; i++) {
      var b = faces[i] * 9;
      var e1x = soup[b + 3] - soup[b], e1y = soup[b + 4] - soup[b + 1], e1z = soup[b + 5] - soup[b + 2];
      var e2x = soup[b + 6] - soup[b], e2y = soup[b + 7] - soup[b + 1], e2z = soup[b + 8] - soup[b + 2];
      var px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      var det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;
      var inv = 1 / det, tx = o[0] - soup[b], ty = o[1] - soup[b + 1], tz = o[2] - soup[b + 2];
      var u = (tx * px + ty * py + tz * pz) * inv;
      if (u < 0 || u > 1) continue;
      var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
      var v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      var t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > 1e-9) n++;
    }
    return n;
  }
  function samplePoints(soup, faces) {
    var out = [], step = Math.max(1, Math.floor(faces.length / 3));
    for (var i = 0; i < faces.length && out.length < 3; i += step) {
      var o = faces[i] * 9;
      out.push([(soup[o] + soup[o + 3] + soup[o + 6]) / 3, (soup[o + 1] + soup[o + 4] + soup[o + 7]) / 3, (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3]);
    }
    return out;
  }
  function insideShell(soup, T, pts) {
    var votes = 0, asked = 0;
    for (var p = 0; p < pts.length; p++) for (var d = 0; d < DIRS.length; d++) {
      asked++;
      if ((rayHits(soup, T.faces, pts[p], DIRS[d]) & 1) === 1) votes++;
    }
    return asked > 0 && votes * 2 > asked;
  }
  function boxHolds(big, small) {
    for (var a = 0; a < 3; a++) if (small.lo[a] < big.lo[a] - BOX_PAD || small.hi[a] > big.hi[a] + BOX_PAD) return false;
    return true;
  }

  /* ------------------------------------------------------------------ */

  function empty(reason) {
    return { ok: false, n: 0, shells: [], of: new Int32Array(0), tris: 0, words: '0 shells', reason: reason };
  }

  function shells(soup, opts) {
    opts = opts || {};
    if (!soup || soup.length < 9) return empty('Nothing to read - the piece is empty.');
    var nf = Math.floor(soup.length / 9), cut = opts.cut, i, j;
    if (!cut) {
      var W = weld(soup, opts.weldTol);
      cut = cutShells(W.vids, W.pos);
    }
    var list = cut.faces.map(function (faces, s) {
      var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], vol = 0;
      for (var q = 0; q < faces.length; q++) {
        var o = faces[q] * 9;
        for (var k = 0; k < 3; k++) for (var a = 0; a < 3; a++) {
          var x = soup[o + k * 3 + a];
          if (x < lo[a]) lo[a] = x; if (x > hi[a]) hi[a] = x;
        }
        vol += (soup[o] * (soup[o + 4] * soup[o + 8] - soup[o + 5] * soup[o + 7]) -
                soup[o + 1] * (soup[o + 3] * soup[o + 8] - soup[o + 5] * soup[o + 6]) +
                soup[o + 2] * (soup[o + 3] * soup[o + 7] - soup[o + 4] * soup[o + 6])) / 6;
      }
      return { id: s, faces: faces, tris: faces.length, closed: !(cut.odd && cut.odd[s]), vol: vol, lo: lo, hi: hi,
               crosses: [], insideOf: null, pairs: 0 };
    });

    // crossing: shells whose boxes meet, swept along X
    var order = list.slice().sort(function (p, q) { return p.lo[0] - q.lo[0]; }), total = 0, mark = { seen: new Int32Array(nf), n: 0 };
    for (i = 0; i < order.length; i++) {
      for (j = i + 1; j < order.length && order[j].lo[0] <= order[i].hi[0] + CROSS_MM; j++) {
        var A = order[i], B = order[j];
        if (A.lo[1] > B.hi[1] + CROSS_MM || B.lo[1] > A.hi[1] + CROSS_MM || A.lo[2] > B.hi[2] + CROSS_MM || B.lo[2] > A.hi[2] + CROSS_MM) continue;
        var n = shellsCross(soup, A, soup, B, !!opts.count, mark);
        if (!n) continue;
        A.crosses.push(B.id); B.crosses.push(A.id);
        A.pairs += n; B.pairs += n; total += n;
      }
    }
    list.forEach(function (s) { s.crosses.sort(function (p, q) { return p - q; }); });

    /* inside: a closed shell no other crosses, wholly in the box of a closed one it does not cross. The
       innermost holder (least volume) is the one named. */
    var byVol = list.filter(function (s) { return s.closed; }).sort(function (p, q) { return Math.abs(p.vol) - Math.abs(q.vol); });
    list.forEach(function (S) {
      if (opts.inside === false || !S.closed || S.crosses.length) return;
      var pts = null;
      for (var t = 0; t < byVol.length; t++) {
        var T = byVol[t];
        if (T === S || Math.abs(T.vol) <= Math.abs(S.vol) || !boxHolds(T, S)) continue;
        if (!pts) pts = samplePoints(soup, S.faces);
        if (insideShell(soup, T, pts)) { S.insideOf = T.id; break; }
      }
    });

    /* free: no crossing, in nothing. part: a shell of its own - it crosses another, or it is in nothing.
       clear: free, and its box meets no other body's box (a body is a shell and the hollows inside it) - two
       things on a plate, not a print-in-place assembly whose parts interleave. liftable: a part Lift can
       take out whole, no cut - one that crosses, or one that stands clear. */
    function bodyOf(s) { var g = 0; while (list[s].insideOf !== null && g++ < list.length) s = list[s].insideOf; return s; }
    list.forEach(function (S) { S.body = bodyOf(S.id); });
    function meet(S, T) {
      for (var a = 0; a < 3; a++) if (S.lo[a] > T.hi[a] + CROSS_MM || T.lo[a] > S.hi[a] + CROSS_MM) return false;
      return true;
    }
    list.forEach(function (S) {
      S.free = S.closed && !S.crosses.length && S.insideOf === null;
      S.part = S.closed && (S.crosses.length > 0 || S.insideOf === null);
      S.clear = S.free && list.every(function (T) { return T.body === S.body || !meet(S, T); });
      S.liftable = S.part && (S.crosses.length > 0 || S.clear);
    });
    var out = { ok: true, n: list.length, shells: list, of: cut.of, tris: nf, pairs: total, reason: '' };
    out.parts = list.filter(function (s) { return s.part; }).length;
    /* owned: two or more parts, and every one of them Lift takes out whole - then Lift reads the piece as shells
       and cuts nothing. A piece with one part, or with parts that interleave, is read the way it always was. */
    out.owned = out.parts >= 2 && list.every(function (s) { return !s.part || s.liftable; });
    out.words = words(out.parts, 'shell', 'shells');
    return out;
  }

  /* ------------------------------------------------------------------
     Pieces that overlap on a plate: items [{ name, soup }], each soup a piece in plate space. Two pieces overlap when
     a triangle of one CROSSES a triangle of the other (the same reading as shells above); pieces that only touch, or
     one standing wholly inside the other's hollow, do not. -> { ok, pairs: [[i, j]], names: [[a, b]], line }
     ------------------------------------------------------------------ */
  function boxOfSoup(soup) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i + 2 < soup.length; i += 3) for (var a = 0; a < 3; a++) {
      var x = soup[i + a];
      if (x < lo[a]) lo[a] = x; if (x > hi[a]) hi[a] = x;
    }
    return { lo: lo, hi: hi };
  }

  function overlaps(items) {
    var boxes = items.map(function (it) {
      var b = boxOfSoup(it.soup);
      return { faces: null, n: Math.floor(it.soup.length / 9), lo: b.lo, hi: b.hi };
    });
    var mark = { seen: new Int32Array(0), n: 0 }, pairs = [], names = [];
    for (var i = 0; i < items.length; i++) for (var j = i + 1; j < items.length; j++) {
      var A = boxes[i], B = boxes[j];
      if (A.lo[0] > B.hi[0] || B.lo[0] > A.hi[0] || A.lo[1] > B.hi[1] || B.lo[1] > A.hi[1] || A.lo[2] > B.hi[2] || B.lo[2] > A.hi[2]) continue;
      if (shellsCross(items[i].soup, A, items[j].soup, B, false, mark)) { pairs.push([i, j]); names.push([items[i].name, items[j].name]); }
    }
    var line = '';
    if (pairs.length) {
      var shown = names.slice(0, 3).map(function (n) { return n[0] + ' + ' + n[1]; }).join(', ');
      line = 'these pieces overlap; Join before printing: ' + shown + (names.length > 3 ? ' and ' + (names.length - 3) + ' more' : '');
    }
    return { ok: true, pairs: pairs, names: names, line: line };
  }

  function extract(soup, faces) {
    var out = new Float32Array(faces.length * 9);
    for (var i = 0; i < faces.length; i++) {
      var o = faces[i] * 9, at = i * 9;
      for (var c = 0; c < 9; c++) out[at + c] = soup[o + c];
    }
    return out;
  }

  /* The readout: how many shells are pieces of their own, and what is crossing what. */
  function describe(a) {
    if (!a || !a.ok) return a ? a.reason : '';
    var cav = a.shells.filter(function (s) { return s.insideOf !== null; }).length;
    return a.words + (a.n !== a.parts ? ' (' + words(a.n, 'shell', 'shells') + (cav ? ', ' + words(cav, 'hollow', 'hollows') + ' kept with ' + (cav === 1 ? 'its' : 'their') + ' shell' + (cav === 1 ? '' : 's') : '') + ')' : '');
  }

  var api = { shells: shells, cutShells: cutShells, weld: weld, extract: extract, describe: describe, overlaps: overlaps, crossTri: crossTri,
              CROSS_MM: CROSS_MM, WELD_TOL: WELD_TOL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_Shells = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
