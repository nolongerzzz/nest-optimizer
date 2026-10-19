/* nso_crop.js - Crop, the copy engine.

   Loads as a classic script (window.NSO_Crop) and, spliced into a vm context
   beside the kernel adapter, under node (tools/nso_crop_engine_test.js).
   Sections 1-4 are headless: no DOM, no Three.js, no app state. Section 5 is
   the one browser-only step, putting the result on the plate.

   ---------------------------------------------------------------------------
   WHAT CROP IS
   ---------------------------------------------------------------------------
   Crop is one operation: COPY what a shape holds out of a piece, as a new,
   sealed, solid piece. The original is not cut, capped or repaired - it is
   only read, and comes out byte for byte as it went in. The copy lands on the
   plate where it was cut from, so it overlaps the original there and the user
   grabs it from that spot.

       NSO_Crop.plan(piece, shape)  -> Promise<{ ok, faces, volumeMm3, bbox, text }>
       NSO_Crop.run(piece, shape)   -> Promise<{ ok, tris, faces, volumeMm3, bbox, ... }>

   plan asks the kernel what the copy would be and builds nothing. run builds
   it and hands back the closed mesh. Either one returns { ok: false, reason }
   and nothing else when the shape holds nothing of the piece or the result is
   not closed - those are the only two refusals. A shape that holds the whole
   piece is a perfectly good copy of it.

   ---------------------------------------------------------------------------
   THE PIECE AND THE FRAMES
   ---------------------------------------------------------------------------
   piece = { name, rawTris, toRaw }
     rawTris  the piece's triangle soup, 9 floats a triangle, in its raw (file)
              frame. Read only: nothing in here writes to it.
     toRaw    16 numbers, column-major, the rigid map from the plate frame P
              (z up: the way the piece stands on the plate) into rawTris'
              frame. Omitted, P is the raw frame. The shape is built where the
              user sees it, in P, and moved onto the soup by that one map, so
              the piece's own vertices are never moved or re-rounded.
   The result is in the piece's raw frame, so it needs no pose of its own: the
   same toRaw puts it where the original is.

   ---------------------------------------------------------------------------
   THE SHAPES - all in P, placed and sized freely
   ---------------------------------------------------------------------------
     box       { kind: 'box', c: [x,y,z], h: [hx,hy,hz], yaw }
     cylinder  { kind: 'cylinder', c, r, hl, axis: 'x'|'y'|'z', yaw }
               radius r, half-length hl along axis (default z)
     sphere    { kind: 'sphere', c, r }
     piece     { kind: 'piece', source }
               another piece is the cutter: the copy is where the two overlap
     outline   { kind: 'outline', source, mode, tri, d1, d2, z1, z2 }
               the footprint of a chosen piece, extruded between heights z1 and
               z2 (omitted: right through the piece being cropped)
   yaw is degrees about the vertical, through the centre, counter-clockwise
   seen from above. `source` is a plate-frame soup, or a piece-like object
   ({ rawTris, toRaw }), which may be the very piece being cropped.

   OUTLINE. The footprint F is the chosen piece's silhouette from above
   (mode 'silhouette', the default), or - mode 'rim', with `tri` the index of a
   triangle of the source - the edge loop that triangle borders, projected onto
   the plate. A rim is found by walking out from the triangle across edges
   that bend less than creaseDeg (default 30), which gives the smooth face the
   triangle is on, and taking the loop of crease / open edges around it. A
   triangle with an edge on one of the face's loops takes that loop (so on a
   tube's end face the outer triangles pick the outer rim and the inner ones
   the bore); any other takes the face's outermost loop.

   The offsets are distances, never negative: d1 grows F outward, d2 shrinks
   it inward, and the region is the band between the two,

       (F grown by d1)  minus  (F shrunk by d2)

   so d1 alone is a skin outside the footprint, d2 alone a skin inside it, and
   both together a ring across it. d1 = d2 = 0 is the footprint itself, exactly
   - no offset is applied, so the cutter's walls are the source's own outline
   to the last bit. (A band of no width would hold nothing; asking for one is
   never what the user means, so zero on both is read as "the whole outline".)
   `solid: true` keeps the whole of the grown (d1) or shrunk (d2) footprint
   instead of the band between.

   ---------------------------------------------------------------------------
   THE KERNEL AND THE CHECKS
   ---------------------------------------------------------------------------
   Manifold's intersect, the kernel crop:shapes already used. The cutter is a
   kernel solid - a primitive, an extruded cross-section, or another piece -
   moved onto the piece by one transform. The result is checked twice:

     - on the float32 values it will be saved as: every directed edge occurs
       once and its reverse once (closed, manifold, consistently wound), the
       same exact-key census Crop's box uses
     - after the weld every other tool applies, at the canonical checker's
       radius (WELD_MM, 1e-4 mm): the census again, on the welded vertices.
       Two polygonal surfaces that cross almost exactly at a vertex leave an
       edge a few micro-millimetres long, which the first census passes and
       the weld shuts into a non-manifold pinch

   No slivers means no edge under SHORT_MM (twice that radius). A result with
   one is handed to the kernel's simplify, at growing tolerances, until it has
   none; one that still fails the welded census is refused, as not closed. Loose
   parts under SPECK_REL of the copy - the film a cutter wall leaves where it
   grazes a face - are dropped and counted. Circles and spheres are polygons
   whose chords sag at most DEFAULTS.sagMm inside the true curve (a sphere's
   twice as finely cut, since its error runs both ways).

   ---------------------------------------------------------------------------
   THE CARD (app-crop-card.js)
   ---------------------------------------------------------------------------
   The Crop card is this engine and nothing else: a shape dragged to size, a
   readout from planOn(), a button that calls copy(). planOn(model, shape) is
   plan() for a model on the plate - it finds the pose and any `pieceId`
   source as copy() does - and footprintPolys(shape) hands the card the
   outline's boundary so it can put the offset handles on it.
   ===================================================================== */
(function (root) {
  'use strict';

  var DEFAULTS = {
    sagMm: 0.005,        // a circle's chords sag at most this inside the true circle
    minSeg: 48,
    maxSeg: 2048,
    growSeg: 256,        // segments per full turn on an offset's round corners
    marginMm: 1,         // an outline with no z range runs this far past the piece
    tinyMm3: 1e-3,       // a copy below this (or 1e-7 of the piece) is nothing
    speckRel: 1e-6,      // a loose part under this fraction of the copy is a speck
    weldMm: 1e-4,        // the canonical checker's weld radius (mesh_validate.py WELD_TOL)
    shortMm: 2e-4,       // an edge under this is a sliver: twice the weld radius
    creaseDeg: 30,       // a rim's face ends where edges bend more than this
    weldQ: 1e4,          // 0.1 micron buckets, as NSO_edgeStats welds
    cleanTol: [2e-4, 5e-4, 1e-3]   // the simplify tolerances tried, in turn, on a result with slivers
  };
  var SHAPES = ['box', 'cylinder', 'sphere', 'piece', 'outline'];

  var IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  function kernel() {
    if (typeof NSO_CSG !== 'undefined') return NSO_CSG;
    if (root && root.NSO_CSG) return root.NSO_CSG;
    return null;
  }

  /* =====================================================================
     1. Small helpers
     ===================================================================== */

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function f1(v) { return v.toFixed(1); }
  function f2(v) { return v.toFixed(2); }

  // Segments for a circle of radius r whose chords sag at most sagMm.
  function circleSegments(r) {
    var c = 1 - DEFAULTS.sagMm / r;
    var n = c > -1 ? Math.ceil(Math.PI / Math.acos(Math.max(-1, Math.min(1, c)))) : DEFAULTS.minSeg;
    n = Math.max(DEFAULTS.minSeg, Math.min(DEFAULTS.maxSeg, n));
    return Math.ceil(n / 4) * 4;
  }

  // A sphere's segments: its error is on a surface, not a line, so twice a
  // circle's, and never fewer than 128 (0.14% of a whole sphere's volume).
  function sphereSegments(r) {
    return Math.ceil(Math.max(128, Math.min(512, 2 * circleSegments(r))) / 4) * 4;
  }

  function bounds(soup) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i + 2 < soup.length; i += 3) {
      for (var k = 0; k < 3; k++) {
        var v = soup[i + k];
        if (v < lo[k]) lo[k] = v;
        if (v > hi[k]) hi[k] = v;
      }
    }
    return { lo: lo, hi: hi };
  }

  // Signed volume of a soup (divergence theorem about the origin). A void
  // shell counts negative, so it is the volume of the solid.
  function volume(s) {
    var v = 0;
    for (var o = 0; o + 8 < s.length; o += 9) {
      v += s[o] * (s[o+4] * s[o+8] - s[o+5] * s[o+7]) - s[o+1] * (s[o+3] * s[o+8] - s[o+5] * s[o+6]) +
           s[o+2] * (s[o+3] * s[o+7] - s[o+4] * s[o+6]);
    }
    return v / 6;
  }

  /* Edge census, twice. The exact-key one is on the float32 values an exported
     STL carries: every directed edge once and its reverse once is closed +
     manifold + consistently wound. The welded one is the same count after the
     weld the checker and the slicers apply (a radius weld, as mesh_validate's):
     `welded.collapsed` counts triangles that weld to a line or a point. `slivers`
     counts triangles with an edge under shortMm. */
  function directedCensus(ids, n) {
    var dir = new Map(), collapsed = 0;
    for (var t = 0; t < n; t++) {
      var a = ids[t * 3], b = ids[t * 3 + 1], c = ids[t * 3 + 2];
      if (a === b || b === c || a === c) { collapsed++; continue; }
      var e = [a + '>' + b, b + '>' + c, c + '>' + a];
      for (var i = 0; i < 3; i++) dir.set(e[i], (dir.get(e[i]) || 0) + 1);
    }
    var open = 0, repeated = 0;
    dir.forEach(function (cnt, key) {
      if (cnt > 1) repeated += cnt - 1;
      var p = key.split('>');
      if (!dir.has(p[1] + '>' + p[0])) open++;
    });
    return { open: open, repeated: repeated, collapsed: collapsed, edges: dir.size };
  }

  // Vertex ids for a soup: exact (same float32 triple) or welded to a radius,
  // the first vertex of a cluster standing for it. -> { ids, pts }
  function vertexIds(f32, radius) {
    var ids = new Int32Array(f32.length / 3), seen = new Map();
    if (!radius) {
      for (var v = 0; v < ids.length; v++) {
        var k = f32[v * 3] + ',' + f32[v * 3 + 1] + ',' + f32[v * 3 + 2], id = seen.get(k);
        if (id === undefined) { id = seen.size; seen.set(k, id); }
        ids[v] = id;
      }
      return { ids: ids, pts: null };
    }
    var inv = 1 / radius, r2 = radius * radius, pts = [], cells = new Map();
    for (var u = 0; u < ids.length; u++) {
      var x = f32[u * 3], y = f32[u * 3 + 1], z = f32[u * 3 + 2];
      var cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv), found = -1;
      for (var dx = -1; dx <= 1 && found < 0; dx++) {
        for (var dy = -1; dy <= 1 && found < 0; dy++) {
          for (var dz = -1; dz <= 1 && found < 0; dz++) {
            var list = cells.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
            if (!list) continue;
            for (var q = 0; q < list.length; q++) {
              var p = pts[list[q]];
              if ((p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y) + (p[2] - z) * (p[2] - z) <= r2) { found = list[q]; break; }
            }
          }
        }
      }
      if (found < 0) {
        found = pts.length; pts.push([x, y, z]);
        var key = cx + ',' + cy + ',' + cz, own = cells.get(key);
        if (!own) { own = []; cells.set(key, own); }
        own.push(found);
      }
      ids[u] = found;
    }
    return { ids: ids, pts: pts };
  }

  /* The soup with every vertex moved onto its cluster's first (within radius),
     and the triangles that weld to a line or a point dropped: an edge
     collapse where two surfaces crossed almost at a vertex. */
  function weldSoup(f32, radius) {
    var w = vertexIds(f32, radius), ids = w.ids, pts = w.pts, n = (f32.length / 9) | 0, keep = [];
    for (var t = 0; t < n; t++) {
      var a = ids[t * 3], b = ids[t * 3 + 1], c = ids[t * 3 + 2];
      if (a === b || b === c || a === c) continue;
      keep.push(a, b, c);
    }
    var out = new Float32Array(keep.length * 3);
    for (var i = 0; i < keep.length; i++) { out[i * 3] = pts[keep[i]][0]; out[i * 3 + 1] = pts[keep[i]][1]; out[i * 3 + 2] = pts[keep[i]][2]; }
    return out;
  }

  function census(f32) {
    var n = (f32.length / 9) | 0, slivers = 0, short2 = DEFAULTS.shortMm * DEFAULTS.shortMm;
    for (var t = 0; t < n; t++) {
      var o = t * 9;
      for (var e = 0; e < 3; e++) {
        var a = o + e * 3, b = o + ((e + 1) % 3) * 3;
        var dx = f32[a] - f32[b], dy = f32[a + 1] - f32[b + 1], dz = f32[a + 2] - f32[b + 2];
        if (dx * dx + dy * dy + dz * dz < short2) { slivers++; break; }
      }
    }
    var exact = directedCensus(vertexIds(f32, 0).ids, n);
    var welded = directedCensus(vertexIds(f32, DEFAULTS.weldMm).ids, n);
    return { open: exact.open, repeated: exact.repeated, degenerate: exact.collapsed, slivers: slivers, edges: exact.edges,
             welded: welded };
  }
  function censusClean(c) {
    return !c.open && !c.repeated && !c.degenerate && !c.slivers && !c.welded.open && !c.welded.repeated && !c.welded.collapsed;
  }
  function censusScore(c) {
    return c.open + c.repeated + c.degenerate + c.slivers + c.welded.open + c.welded.repeated + c.welded.collapsed;
  }

  /* 4x4 affine, column-major (THREE's Matrix4.elements, and the kernel's). */
  function matMul(A, B) {
    var o = new Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        var s = 0;
        for (var k = 0; k < 4; k++) s += A[k * 4 + r] * B[c * 4 + k];
        o[c * 4 + r] = s;
      }
    }
    return o;
  }
  function matT(x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; }
  function matRx(deg) {
    var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  }
  function matRy(deg) {
    var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  }
  function matRz(deg) {
    var a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  }
  function matApply(M, x, y, z) {
    return [M[0] * x + M[4] * y + M[8] * z + M[12],
            M[1] * x + M[5] * y + M[9] * z + M[13],
            M[2] * x + M[6] * y + M[10] * z + M[14]];
  }
  function matApplySoup(M, s) {
    var out = new Float32Array(s.length);
    for (var i = 0; i < s.length; i += 3) {
      var q = matApply(M, s[i], s[i + 1], s[i + 2]);
      out[i] = q[0]; out[i + 1] = q[1]; out[i + 2] = q[2];
    }
    return out;
  }
  function matInvert(M) {
    var a = M[0], b = M[4], c = M[8], d = M[1], e = M[5], f = M[9], g = M[2], h = M[6], i = M[10];
    var A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    var det = a * A + b * B + c * C;
    if (!(Math.abs(det) > 1e-12)) return null;
    var r = 1 / det;
    // the inverse of the 3x3, row by row: the adjugate over the determinant
    var m00 = A * r, m01 = -(b * i - c * h) * r, m02 = (b * f - c * e) * r;
    var m10 = B * r, m11 = (a * i - c * g) * r, m12 = -(a * f - c * d) * r;
    var m20 = C * r, m21 = -(a * h - b * g) * r, m22 = (a * e - b * d) * r;
    var tx = M[12], ty = M[13], tz = M[14];
    return [m00, m10, m20, 0, m01, m11, m21, 0, m02, m12, m22, 0,
            -(m00 * tx + m01 * ty + m02 * tz), -(m10 * tx + m11 * ty + m12 * tz), -(m20 * tx + m21 * ty + m22 * tz), 1];
  }
  // The kernel reads a matrix only when it is an Array of its own realm, and a
  // literal made inside a vm context (the node tests) is not. slice.call hands
  // back one of the calling realm's, which is the kernel's.
  function realmArray(a) { return Array.prototype.slice.call(a); }

  function soupOf(piece) {
    return piece ? (piece.rawTris || piece.tris || null) : null;
  }

  // A soup's bounding box in P, given the map from its frame into P (null: it is P).
  function extentInP(soup, fromRaw) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i + 2 < soup.length; i += 3) {
      var p = fromRaw ? matApply(fromRaw, soup[i], soup[i + 1], soup[i + 2]) : [soup[i], soup[i + 1], soup[i + 2]];
      for (var k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
    }
    return { lo: lo, hi: hi };
  }

  // A piece-like or a bare soup, in the plate frame P.
  function soupInP(src) {
    if (!src) return null;
    if (typeof src.length === 'number') return src;       // already P
    var raw = soupOf(src);
    if (!raw) return null;
    if (!src.toRaw) return raw;
    var inv = matInvert(Array.prototype.slice.call(src.toRaw));
    if (!inv) return null;
    var out = new Float32Array(raw.length);
    for (var i = 0; i + 2 < raw.length; i += 3) {
      var p = matApply(inv, raw[i], raw[i + 1], raw[i + 2]);
      out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
    }
    return out;
  }

  /* =====================================================================
     2. The outline: silhouette and rim, as kernel cross-sections
     ===================================================================== */

  /* The silhouette seen from above: every triangle of `soup` (P) dropped onto
     z = 0, wound counter-clockwise. Walls drop to nothing and are left out.
     Their union, under the non-zero rule, is the silhouette. Points are
     { x, y }: the kernel reads an [x, y] pair only when it is an Array of its
     own realm, so a soup from a vm context would not pass. */
  function silhouettePolys(soup) {
    var polys = [];
    for (var o = 0; o + 8 < soup.length; o += 9) {
      var ax = soup[o], ay = soup[o + 1], bx = soup[o + 3], by = soup[o + 4], cx = soup[o + 6], cy = soup[o + 7];
      var ar = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (!(Math.abs(ar) > 1e-10)) continue;
      var A = { x: ax, y: ay }, B = { x: bx, y: by }, C = { x: cx, y: cy };
      polys.push(ar > 0 ? [A, B, C] : [A, C, B]);
    }
    return polys;
  }

  /* The rim a triangle borders. soupP is the source in P, tri an index into
     it. -> { loop: [[x,y,z], ...], area, loops, patchTris } or { reason }. */
  function rimLoop(soupP, triIdx, creaseDeg) {
    var Q = DEFAULTS.weldQ;
    var nT = (soupP.length / 9) | 0;
    if (!(triIdx >= 0 && triIdx < nT) || triIdx !== Math.floor(triIdx)) {
      return { reason: 'triangle ' + triIdx + ' is not a triangle of that piece (it has ' + nT + ')' };
    }
    var cosC = Math.cos((isNum(creaseDeg) ? creaseDeg : DEFAULTS.creaseDeg) * Math.PI / 180);
    var vmap = new Map(), pts = [], tris = [], nrm = [], slot = new Array(nT);
    function vid(x, y, z) {
      var k = Math.round(x * Q) + '_' + Math.round(y * Q) + '_' + Math.round(z * Q);
      var i = vmap.get(k);
      if (i === undefined) { i = pts.length; pts.push([x, y, z]); vmap.set(k, i); }
      return i;
    }
    for (var t = 0; t < nT; t++) {
      var o = t * 9;
      var a = vid(soupP[o], soupP[o + 1], soupP[o + 2]);
      var b = vid(soupP[o + 3], soupP[o + 4], soupP[o + 5]);
      var c = vid(soupP[o + 6], soupP[o + 7], soupP[o + 8]);
      slot[t] = -1;
      if (a === b || b === c || a === c) continue;
      var ux = soupP[o + 3] - soupP[o], uy = soupP[o + 4] - soupP[o + 1], uz = soupP[o + 5] - soupP[o + 2];
      var vx = soupP[o + 6] - soupP[o], vy = soupP[o + 7] - soupP[o + 1], vz = soupP[o + 8] - soupP[o + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(L > 1e-12)) continue;
      slot[t] = tris.length;
      tris.push([a, b, c]);
      nrm.push([nx / L, ny / L, nz / L]);
    }
    if (slot[triIdx] < 0) return { reason: 'triangle ' + triIdx + ' has no area, so it has no face to take a rim from' };

    // Edge -> the triangles on it, each with the way round it uses the edge.
    var edges = new Map();
    function ek(u, v) { return u < v ? u + '_' + v : v + '_' + u; }
    for (var i = 0; i < tris.length; i++) {
      for (var e = 0; e < 3; e++) {
        var u = tris[i][e], w = tris[i][(e + 1) % 3], key = ek(u, w);
        var list = edges.get(key);
        if (!list) { list = []; edges.set(key, list); }
        list.push({ t: i, fwd: u < w });
      }
    }
    // Smooth: two triangles, wound the same way round the shape, bending less
    // than the crease angle.
    function smoothNeighbour(i2, u2, w2) {
      var list2 = edges.get(ek(u2, w2));
      if (!list2 || list2.length !== 2) return -1;
      var other = list2[0].t === i2 ? list2[1] : list2[0];
      var self = list2[0].t === i2 ? list2[0] : list2[1];
      if (other.fwd === self.fwd) return -1;
      var n1 = nrm[i2], n2 = nrm[other.t];
      return n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] >= cosC ? other.t : -1;
    }

    // The smooth face the triangle is on.
    var seen = new Uint8Array(tris.length), stack = [slot[triIdx]], patch = [];
    seen[slot[triIdx]] = 1;
    while (stack.length) {
      var cur = stack.pop();
      patch.push(cur);
      for (var e2 = 0; e2 < 3; e2++) {
        var nb = smoothNeighbour(cur, tris[cur][e2], tris[cur][(e2 + 1) % 3]);
        if (nb >= 0 && !seen[nb]) { seen[nb] = 1; stack.push(nb); }
      }
    }

    // Its boundary: the directed edges whose other side is not smooth.
    var bEdges = [], byFrom = new Map();
    for (var p = 0; p < patch.length; p++) {
      var tv = tris[patch[p]];
      for (var e3 = 0; e3 < 3; e3++) {
        var u3 = tv[e3], w3 = tv[(e3 + 1) % 3];
        if (smoothNeighbour(patch[p], u3, w3) >= 0) continue;
        var idx = bEdges.length;
        bEdges.push({ a: u3, b: w3, t: patch[p] });
        var out = byFrom.get(u3);
        if (!out) { out = []; byFrom.set(u3, out); }
        out.push(idx);
      }
    }
    if (!bEdges.length) return { reason: 'that face has no edge - it is a closed surface all the way round' };

    // Walk the boundary into closed loops.
    var used = new Uint8Array(bEdges.length), loops = [];
    for (var s = 0; s < bEdges.length; s++) {
      if (used[s]) continue;
      var chain = [], cur2 = s, closed = false;
      for (;;) {
        used[cur2] = 1;
        chain.push(cur2);
        if (bEdges[cur2].b === bEdges[s].a) { closed = true; break; }
        var outs = byFrom.get(bEdges[cur2].b) || [], nxt = -1;
        for (var q = 0; q < outs.length; q++) if (!used[outs[q]]) { nxt = outs[q]; break; }
        if (nxt < 0) break;
        cur2 = nxt;
      }
      if (!closed) continue;
      var ring = [], area = 0;
      for (var r = 0; r < chain.length; r++) ring.push(pts[bEdges[chain[r]].a]);
      for (var r2 = 0; r2 < ring.length; r2++) {
        var P0 = ring[r2], P1 = ring[(r2 + 1) % ring.length];
        area += P0[0] * P1[1] - P1[0] * P0[1];
      }
      loops.push({ ring: ring, area: area / 2, edges: chain });
    }
    if (!loops.length) return { reason: 'the edge round that face does not close into a loop' };

    // The loop the triangle's own edge is on, else the outermost.
    var mine = slot[triIdx], pick = null, k;
    for (k = 0; k < loops.length; k++) {
      var has = false;
      for (var m2 = 0; m2 < loops[k].edges.length; m2++) if (bEdges[loops[k].edges[m2]].t === mine) { has = true; break; }
      if (has && (!pick || Math.abs(loops[k].area) > Math.abs(pick.area))) pick = loops[k];
    }
    if (!pick) for (k = 0; k < loops.length; k++) if (!pick || Math.abs(loops[k].area) > Math.abs(pick.area)) pick = loops[k];
    return { loop: pick.ring, area: pick.area, loops: loops.length, patchTris: patch.length };
  }

  /* The footprint of an outline shape as a kernel CrossSection in P's xy
     (the caller deletes it), or { reason }. */
  function footprint(wasm, shape) {
    var src = soupInP(shape.source);
    if (!src || src.length < 9) return { reason: 'the outline has no source piece' };
    var mode = shape.mode === 'rim' ? 'rim' : 'silhouette';
    var polys, what = shape.label || 'the outline', note = '';
    if (mode === 'rim') {
      var rim = rimLoop(src, shape.tri, shape.creaseDeg);
      if (rim.reason) return { reason: rim.reason };
      if (!(Math.abs(rim.area) > 1e-6)) return { reason: 'that rim is edge-on from above - it has no footprint' };
      var ring = rim.loop.map(function (p) { return { x: p[0], y: p[1] }; });
      if (rim.area < 0) ring.reverse();
      polys = [ring];
      note = rim.loops + ' loop(s) on that face, ' + rim.patchTris + ' triangles in it';
    } else {
      polys = silhouettePolys(src);
      if (!polys.length) return { reason: 'the source piece has no outline seen from above' };
    }
    var base = new wasm.CrossSection(polys, 'NonZero');
    if (base.isEmpty() || !(base.area() > 1e-6)) { base.delete(); return { reason: 'the source piece has no outline seen from above' }; }

    var d1 = shape.d1 == null ? 0 : shape.d1, d2 = shape.d2 == null ? 0 : shape.d2;
    var grown = null, shrunk = null, out = null;
    try {
      if (!(d1 > 0) && !(d2 > 0)) { out = base; base = null; return { cs: out, what: what, note: note, mode: mode }; }
      if (shape.solid) {
        // the whole of the grown (or shrunk) footprint
        out = d1 > 0 ? base.offset(d1, 'Round', 2, DEFAULTS.growSeg) : base.offset(-d2, 'Round', 2, DEFAULTS.growSeg);
        if (out.isEmpty() || !(out.area() > 1e-6)) {
          out.delete(); out = null;
          return { reason: 'an offset of ' + (d1 > 0 ? '+' + f2(d1) : '-' + f2(d2)) + ' mm leaves nothing of the outline' };
        }
        return { cs: out, what: what, note: note, mode: mode };
      }
      grown = d1 > 0 ? base.offset(d1, 'Round', 2, DEFAULTS.growSeg) : base;
      shrunk = d2 > 0 ? base.offset(-d2, 'Round', 2, DEFAULTS.growSeg) : base;
      out = shrunk.isEmpty() ? grown.offset(0, 'Round', 2, DEFAULTS.growSeg) : grown.subtract(shrunk);
      if (out.isEmpty() || !(out.area() > 1e-6)) {
        out.delete(); out = null;
        return { reason: 'the band from ' + f2(d2) + ' mm inside to ' + f2(d1) + ' mm outside the outline is empty' };
      }
      return { cs: out, what: what, note: note, mode: mode };
    } finally {
      if (grown && grown !== base) grown.delete();
      if (shrunk && shrunk !== base) shrunk.delete();
      if (base && base !== out) base.delete();
    }
  }

  /* =====================================================================
     3. The cutter: a kernel solid in the piece's raw frame
     ===================================================================== */

  function vec3(v) {
    return v && v.length === 3 && isNum(v[0]) && isNum(v[1]) && isNum(v[2]);
  }

  /* Shape numbers, checked in words. -> a reason, or '' when they will do. */
  function shapeProblem(shape) {
    if (!shape || typeof shape !== 'object') return 'no shape';
    var kind = shape.kind;
    if (SHAPES.indexOf(kind) < 0) return 'unknown shape "' + kind + '" - it is one of ' + SHAPES.join(', ');
    var yaw = shape.yaw == null ? 0 : shape.yaw;
    if (kind === 'box' || kind === 'cylinder' || kind === 'sphere') {
      if (!vec3(shape.c)) return 'the ' + kind + ' needs a centre, c: [x, y, z]';
      if (!isNum(yaw)) return 'the ' + kind + ' yaw must be a number of degrees';
    }
    if (kind === 'box') {
      if (!vec3(shape.h) || !(shape.h[0] > 0 && shape.h[1] > 0 && shape.h[2] > 0)) return 'the box needs half-sizes above 0, h: [hx, hy, hz]';
    } else if (kind === 'cylinder') {
      if (!(shape.r > 0)) return 'the cylinder needs a radius above 0';
      if (!(shape.hl > 0)) return 'the cylinder needs a half-length above 0, hl';
      if (shape.axis != null && ['x', 'y', 'z'].indexOf(shape.axis) < 0) return 'the cylinder axis is x, y or z';
    } else if (kind === 'sphere') {
      if (!(shape.r > 0)) return 'the sphere needs a radius above 0';
    } else if (kind === 'piece') {
      if (!shape.source) return 'the piece shape needs another piece as its source';
    } else if (kind === 'outline') {
      if (!shape.source) return 'the outline needs a piece to take it from';
      if (shape.mode != null && shape.mode !== 'silhouette' && shape.mode !== 'rim') return 'the outline mode is silhouette or rim';
      if (shape.mode === 'rim' && !(shape.tri >= 0)) return 'a rim outline needs tri, the index of a triangle on that rim';
      if (shape.d1 != null && !(shape.d1 >= 0)) return 'offset d1 is a distance of 0 or more';
      if (shape.d2 != null && !(shape.d2 >= 0)) return 'offset d2 is a distance of 0 or more';
      if ((shape.z1 != null) !== (shape.z2 != null)) return 'give both heights z1 and z2, or neither';
      if (shape.z1 != null && !(isNum(shape.z1) && isNum(shape.z2) && shape.z2 > shape.z1)) return 'the outline heights need z1 below z2';
    }
    return '';
  }

  /* -> { m, what, ... } where m is a kernel Manifold in the piece's raw frame
     (the caller deletes it), or { reason }. ctx: { toRaw, pieceP }. */
  function buildCutter(wasm, shape, ctx) {
    var kern = kernel();
    var toRaw = ctx.toRaw || IDENTITY;
    var kind = shape.kind, yaw = shape.yaw == null ? 0 : shape.yaw;
    var what = shape.label || ('the ' + (kind === 'piece' ? 'other piece' : kind));
    var base = null, moved = null, solid = null, placed = null, man = null;
    try {
      if (kind === 'box') {
        base = wasm.Manifold.cube({ x: 2 * shape.h[0], y: 2 * shape.h[1], z: 2 * shape.h[2] }, true);
        moved = base.transform(realmArray(matMul(toRaw, matMul(matT(shape.c[0], shape.c[1], shape.c[2]), matRz(yaw)))));
        return { m: moved, what: what };
      }
      if (kind === 'cylinder') {
        var n = circleSegments(shape.r), axis = shape.axis || 'z';
        base = wasm.Manifold.cylinder(2 * shape.hl, shape.r, shape.r, n, true);
        var orient = axis === 'x' ? matRy(90) : axis === 'y' ? matRx(-90) : IDENTITY;
        moved = base.transform(realmArray(matMul(toRaw, matMul(matT(shape.c[0], shape.c[1], shape.c[2]),
                                                               matMul(matRz(yaw), orient)))));
        var out = { m: moved, what: what, segments: n, areaMm2: 0.5 * n * shape.r * shape.r * Math.sin(2 * Math.PI / n) };
        if (axis === 'z') out.regionP = { lo: [shape.c[0] - shape.r, shape.c[1] - shape.r], hi: [shape.c[0] + shape.r, shape.c[1] + shape.r] };
        return out;
      }
      if (kind === 'sphere') {
        var ns = sphereSegments(shape.r);
        base = wasm.Manifold.sphere(shape.r, ns);
        moved = base.transform(realmArray(matMul(toRaw, matT(shape.c[0], shape.c[1], shape.c[2]))));
        return { m: moved, what: what, segments: ns };
      }
      if (kind === 'piece') {
        var sp = soupInP(shape.source);
        if (!sp || sp.length < 9) return { reason: 'the other piece has no triangles' };
        var mo = manifoldOfPiece(wasm, sp, 'the other piece');
        if (!mo.man) return { reason: mo.reason };
        man = mo.man;
        moved = man.transform(realmArray(toRaw));
        return { m: moved, what: what };
      }
      // outline
      var fp = footprint(wasm, shape);
      if (!fp.cs) return { reason: fp.reason };
      try {
        var z1, z2;
        if (shape.z1 != null) { z1 = shape.z1; z2 = shape.z2; }
        else if (ctx.pieceP) { z1 = ctx.pieceP.lo[2] - DEFAULTS.marginMm; z2 = ctx.pieceP.hi[2] + DEFAULTS.marginMm; }
        else return { reason: 'the outline needs heights z1 and z2' };
        solid = fp.cs.extrude(z2 - z1);
        placed = solid.translate(0, 0, z1);   // varargs: an array from another realm is not instanceof Array
        moved = placed.transform(realmArray(toRaw));
        var b = fp.cs.bounds(), bmin = b.min, bmax = b.max;
        var res = { m: moved, what: fp.what, areaMm2: fp.cs.area(), note: fp.note, mode: fp.mode,
          regionP: { lo: [bmin.x !== undefined ? bmin.x : bmin[0], bmin.y !== undefined ? bmin.y : bmin[1]],
                     hi: [bmax.x !== undefined ? bmax.x : bmax[0], bmax.y !== undefined ? bmax.y : bmax[1]] } };
        return res;
      } finally {
        fp.cs.delete();
      }
    } catch (err) {
      if (moved) { moved.delete(); moved = null; }
      return { reason: 'the kernel could not build the ' + kind + ' (' + ((err && err.message) || err) + ')' };
    } finally {
      if (base) base.delete();
      if (solid) solid.delete();
      if (placed) placed.delete();
      if (man) man.delete();
    }
  }

  /* The cutter on its own, in the plate frame, for a preview: a closed soup.
     No piece needed; an outline with no z range needs one. */
  async function cutterSoup(shape) {
    var kern = kernel(), wasm;
    if (!kern) return { reason: 'no boolean kernel in this build' };
    try { wasm = await kern.load(); }
    catch (err) { return { reason: 'the boolean kernel failed to load' }; }
    var why = shapeProblem(shape);
    if (why) return { reason: why };
    var c = buildCutter(wasm, shape, { toRaw: null, pieceP: null });
    if (!c.m) return { reason: c.reason };
    try { return { soup: kern.manifoldToSoup(c.m), areaMm2: c.areaMm2 }; }
    catch (err) { return { reason: (err && err.message) || String(err) }; }
    finally { c.m.delete(); }
  }

  /* =====================================================================
     4. plan / run
     ===================================================================== */

  /* The piece as a kernel solid: as it is, else welded once (the kernel wants
     shared vertices). -> { man } or { reason }. */
  function manifoldOfPiece(wasm, soup, what) {
    var kern = kernel(), man = null, why = '';
    function attempt(s) {
      try {
        var m = kern.soupToManifold(wasm, s);
        if (m.status && m.status() !== 'NoError') { why = m.status(); m.delete(); return null; }
        return m;
      } catch (err) { why = (err && err.message) || String(err); return null; }
    }
    man = attempt(soup);
    if (!man && typeof weldSoupVerts === 'function' && typeof NSO_weldEpsFor === 'function') {
      man = attempt(weldSoupVerts(soup, NSO_weldEpsFor(soup, 0.08)));
    }
    return man ? { man: man } : { reason: 'the kernel does not take ' + what + ' as a closed solid (' + why + ')' };
  }

  function sizeText(b) {
    return f1(b.hi[0] - b.lo[0]) + ' x ' + f1(b.hi[1] - b.lo[1]) + ' x ' + f1(b.hi[2] - b.lo[2]) + ' mm';
  }

  /* The one pipeline under plan and run.
       build     false: ask the kernel and stop, true: make the mesh
     On refusal ok is false and tris is the input soup object. */
  async function cropCore(piece, shape, build) {
    var soup = soupOf(piece);
    var res = { ok: false, reason: '', tris: soup };
    if (!soup || soup.length < 9) { res.reason = 'empty piece'; return res; }
    var why = shapeProblem(shape);
    if (why) { res.reason = why; return res; }
    var toRaw = piece.toRaw ? Array.prototype.slice.call(piece.toRaw) : null;
    var fromRaw = toRaw ? matInvert(toRaw) : null;
    if (toRaw && !fromRaw) { res.reason = 'the plate-to-piece transform is singular'; return res; }

    // The piece's extent in P: an outline's default height, and a cheap miss test.
    res.pieceP = extentInP(soup, fromRaw);

    var kern = kernel(), wasm;
    if (!kern) { res.reason = 'no boolean kernel in this build'; return res; }
    try { wasm = await kern.load(); }
    catch (err) { res.reason = 'the boolean kernel failed to load (' + ((err && err.message) || err) + ')'; return res; }

    var cutter = null, man = null, out = null, simp = null;
    try {
      var c = buildCutter(wasm, shape, { toRaw: toRaw, pieceP: res.pieceP });
      if (!c.m) { res.reason = c.reason; return res; }
      cutter = c.m;
      res.what = c.what; res.segments = c.segments || null; res.areaMm2 = c.areaMm2 || null;
      res.regionP = c.regionP || null; res.note = c.note || '';

      var mp = manifoldOfPiece(wasm, soup, 'this piece');
      if (!mp.man) { res.reason = mp.reason; return res; }
      man = mp.man;
      var v0 = man.volume();
      out = man.intersect(cutter);
      if (out.status && out.status() !== 'NoError') { res.reason = 'the kernel refused the cut (' + out.status() + ')'; return res; }
      var v1 = out.isEmpty() ? 0 : out.volume();
      res.volumeBefore = v0; res.keptMm3 = v1; res.removedMm3 = v0 - v1;
      var tiny = Math.max(DEFAULTS.tinyMm3, Math.abs(v0) * 1e-7);
      res.tinyMm3 = tiny;
      var gate = holdsNothing(res);
      if (gate) { res.reason = gate; return res; }

      if (!build) {
        var bb = out.boundingBox();
        res.faces = out.numTri();
        res.volumeMm3 = v1;
        res.bbox = { lo: [bb.min.x !== undefined ? bb.min.x : bb.min[0], bb.min.y !== undefined ? bb.min.y : bb.min[1], bb.min.z !== undefined ? bb.min.z : bb.min[2]],
                     hi: [bb.max.x !== undefined ? bb.max.x : bb.max[0], bb.max.y !== undefined ? bb.max.y : bb.max[1], bb.max.z !== undefined ? bb.max.z : bb.max[2]] };
        res.ok = true;
        return res;
      }

      /* The mesh. Loose parts are dropped when they are specks: a cutter wall
         that grazes a face leaves a film of no thickness behind it. A void
         inside the piece is a part of its own with negative volume and stays. */
      var speck = Math.max(tiny, Math.abs(v1) * DEFAULTS.speckRel);
      function assemble(m) {
        var parts = typeof m.decompose === 'function' ? m.decompose() : null;
        if (!parts || parts.length <= 1) {
          if (parts) for (var a = 0; a < parts.length; a++) parts[a].delete();
          return { tris: kern.manifoldToSoup(m), parts: 1, dropped: 0 };
        }
        var kept = [], dropped = 0;
        for (var j = 0; j < parts.length; j++) {
          if (Math.abs(parts[j].volume()) < speck) dropped++;
          else kept.push(kern.manifoldToSoup(parts[j]));
          parts[j].delete();
        }
        var n = 0, q;
        for (q = 0; q < kept.length; q++) n += kept[q].length;
        var all = new Float32Array(n), w = 0;
        for (q = 0; q < kept.length; q++) { all.set(kept[q], w); w += kept[q].length; }
        return { tris: all, parts: kept.length, dropped: dropped };
      }
      var made = assemble(out);
      var cen = census(made.tris);
      // Slivers, in order of how little they disturb: the kernel's own simplify,
      // then an edge collapse by weld at the checker's radius, then at twice it.
      var steps = DEFAULTS.cleanTol.map(function (tol) { return { simplify: tol }; })
        .concat([{ weld: DEFAULTS.weldMm }, { weld: DEFAULTS.shortMm }]);
      for (var ti = 0; !censusClean(cen) && ti < steps.length; ti++) {
        var tryMade;
        if (steps[ti].simplify) {
          if (typeof out.simplify !== 'function') continue;
          simp = out.simplify(steps[ti].simplify);
          tryMade = assemble(simp);
          simp.delete(); simp = null;
        } else {
          tryMade = { tris: weldSoup(made.tris, steps[ti].weld), parts: made.parts, dropped: made.dropped };
        }
        var cen2 = census(tryMade.tris);
        if (censusScore(cen2) < censusScore(cen)) { made = tryMade; cen = cen2; }
      }
      if (!made.tris.length) { res.reason = res.what + ' holds nothing of this piece - only specks'; return res; }
      if (cen.open || cen.repeated || cen.degenerate || cen.welded.open || cen.welded.repeated || cen.welded.collapsed) {
        res.reason = 'the result did not come out closed (open ' + cen.open + ', repeated ' + cen.repeated +
          ', degenerate ' + cen.degenerate + (cen.welded.open || cen.welded.repeated || cen.welded.collapsed
            ? '; after the weld open ' + cen.welded.open + ', repeated ' + cen.welded.repeated + ', collapsed ' + cen.welded.collapsed : '') + ')';
        return res;
      }
      res.tris = made.tris;
      res.parts = made.parts; res.dropped = made.dropped; res.census = cen;
      res.faces = made.tris.length / 9;
      res.volumeMm3 = volume(made.tris);
      res.bbox = bounds(made.tris);
      res.ok = true;
      return res;
    } catch (err) {
      res.reason = 'the kernel failed (' + ((err && err.message) || err) + ')';
      res.tris = soup;
      return res;
    } finally {
      if (cutter) cutter.delete();
      if (man) man.delete();
      if (out) out.delete();
      if (simp) simp.delete();
    }
  }

  /* WHERE IT RUNS. crop() is cropCore() on the page's thread for a small piece, exactly as it was, and in a
     worker (nso_csg.js NSO_boolRun, nso_work.js) when the piece or the other shape is big: the page posts
     copies of the soups, the worker runs cropCore on them and posts the result back, and the page's thread
     stays free while the kernel works. The answer is the same object either way; a refusal still carries the
     input soup as tris. Stopped (Escape) or timed out, it is a refusal with cancelled / timedOut set.
     A plan() is a crop with build false: it has a channel of its own, and a newer plan replaces the one
     still running, since the card asks again at every drag. */
  function trisOf(v) {
    if (!v) return 0;
    if (typeof v.length === 'number') return (v.length / 9) | 0;
    var s = soupOf(v);
    return s ? (s.length / 9) | 0 : 0;
  }

  async function crop(piece, shape, build) {
    var boolRun = root && root.NSO_boolRun;
    if (typeof boolRun !== 'function') return cropCore(piece, shape, build);
    var soup = soupOf(piece);
    var spec = {
      path: 'NSO_Crop.job', channel: build ? 'bool' : 'bool-plan', key: build ? null : 'crop-plan',
      label: build ? 'Cropping' : 'Measuring', host: 'crop-readout',
      files: function () { return ['nso_csg.js', 'nso_crop.js']; },
      tris: function (a) { return Math.max(trisOf(a[0]), trisOf(a[1] && a[1].source)); },
      refuse: function (a, why) { return { ok: false, reason: why, tris: soup }; },
      restore: function (r) { if (r && !r.ok && !r.tris) r.tris = soup; return r; }
    };
    return boolRun(spec, [piece, shape, build], function () { return cropCore(piece, shape, build); });
  }

  /* In the worker: cropCore, the copy handed back moved. */
  function job(piece, shape, build) {
    return cropCore(piece, shape, build).then(function (r) {
      return root && root.NSO_boolHandBack ? root.NSO_boolHandBack(r) : r;
    });
  }

  function holdsNothing(res) {
    return res.keptMm3 > res.tinyMm3 ? '' : res.what + ' holds nothing of this piece - move it over the piece';
  }

  function say(res, verb) {
    return verb + ' ' + f1(res.volumeMm3) + ' mm³ in ' + res.faces + ' faces, ' + sizeText(res.bbox) +
      ' - the original is not touched.';
  }

  /* A refusal that was a stop, not a finding: say so, so the card does not report it as the kernel's no. */
  function stopped(from, to) {
    if (from.cancelled) to.cancelled = true;
    if (from.timedOut) to.timedOut = true;
    if (from.superseded) to.superseded = true;
    return to;
  }

  async function plan(piece, shape) {
    var r = await crop(piece, shape, false);
    if (!r.ok) return stopped(r, { ok: false, reason: r.reason });
    return { ok: true, faces: r.faces, volumeMm3: r.volumeMm3, bbox: r.bbox, what: r.what, note: r.note,
             text: say(r, 'Would copy') };
  }

  async function run(piece, shape) {
    var r = await crop(piece, shape, true);
    if (!r.ok) return stopped(r, { ok: false, reason: r.reason });
    return { ok: true, tris: r.tris, faces: r.faces, volumeMm3: r.volumeMm3, bbox: r.bbox, parts: r.parts,
             dropped: r.dropped, census: r.census, what: r.what, note: r.note, text: say(r, 'Copied') };
  }

  /* =====================================================================
     5. Onto the plate (browser only)

     The copy is a model of its own, "<name> crop N", in state.models and on
     the plate, with the raw triple the raw engines take. It is built in the
     original's raw frame and centred on its own bounding box, so it is put
     where it was cut from the way Split to parts puts each part back: the
     original's pose, carried by the difference of the two centres.
     One Undo removes it. The original is only read.
     ===================================================================== */

  // P (z up) <-> world (y up): world = (Px, Pz, -Py).
  function worldFromP() { return new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1); }
  function pFromWorld() { return new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1); }

  /* P -> m's raw frame, through `mesh` as drawn: { M } (16 numbers,
     column-major) or { reason }. The display transform the bake draws with is
     local = (x - off.x, z - off.y, -y - off.z); the mesh's matrix is the pose
     on top of that. */
  function plateToRaw(m, mesh) {
    if (!m || !m.rawTris || m.rawAxis !== 'zup' || !m.centerOffset) return { reason: 'Crop needs a raw piece' };
    if (!mesh || !mesh.geometry) return { reason: 'the piece is not drawn' };
    /* Both boxes are the same numbers either way; a big piece's are kept (app-crop.js NSO_cropBounds, nso-bounds.js
       localBox), because the card asks at every pause of a drag and each walk of a million triangles is ~30 ms of the
       page's thread. A small piece is measured afresh, as ever. */
    var off = m.centerOffset, rb = (typeof NSO_cropBounds === 'function' ? NSO_cropBounds : bounds)(m.rawTris);
    var posAttr = mesh.geometry.attributes && mesh.geometry.attributes.position, bb;
    if (posAttr && posAttr.count >= 900000 && root && root.nsoBounds && typeof root.nsoBounds.localBox === 'function') {
      bb = root.nsoBounds.localBox(mesh.geometry);
    } else {
      mesh.geometry.computeBoundingBox();
      bb = mesh.geometry.boundingBox;
    }
    var pairs = [[rb.lo[0] - off.x, bb.min.x], [rb.hi[0] - off.x, bb.max.x], [rb.lo[2] - off.y, bb.min.y],
                 [rb.hi[2] - off.y, bb.max.y], [-rb.hi[1] - off.z, bb.min.z], [-rb.lo[1] - off.z, bb.max.z]];
    for (var i = 0; i < pairs.length; i++) {
      if (Math.abs(pairs[i][0] - pairs[i][1]) > 1e-3) {
        return { reason: 'the piece was turned since it was loaded, so its raw frame no longer matches the view' };
      }
    }
    var rawFromLocal = new THREE.Matrix4().set(1, 0, 0, off.x, 0, 0, -1, -off.z, 0, 1, 0, off.y, 0, 0, 0, 1);
    mesh.updateMatrixWorld(true);
    var M = rawFromLocal.multiply(new THREE.Matrix4().copy(mesh.matrixWorld).invert()).multiply(worldFromP());
    return { M: Array.from(M.elements) };
  }

  // A placed piece's triangles in P, from the mesh as drawn.
  function meshSoupP(mesh) {
    var g = mesh.geometry, pos = g.attributes.position, idx = g.index;
    var n = idx ? idx.count : pos.count;
    mesh.updateMatrixWorld(true);
    var M = pFromWorld().multiply(mesh.matrixWorld);
    var out = new Float32Array(n * 3), v = new THREE.Vector3();
    for (var i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(M);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    return out;
  }

  function placedOf(id) {
    return (state.placed || []).find(function (p) { return p && p.sourceId === id && p.mesh; }) || null;
  }

  function cropName(base) {
    var re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' crop (\\d+)$'), top = 0;
    (state.models || []).forEach(function (mm) {
      var hit = re.exec(mm.name || '');
      if (hit && +hit[1] > top) top = +hit[1];
    });
    return base + ' crop ' + (top + 1);
  }

  /* The new entry exactly where `host` stands: its pose, carried by the
     difference of the two centres; the height it was cut at kept. */
  function landInPlace(entry, made, hostModel, host, hostBottom) {
    ['rotY', 'rotated', 'flipX', 'tipX', 'tipZ', 'tiltX', 'tiltZ'].forEach(function (k) { entry[k] = host[k]; });
    entry.liftY = 0;
    applyMeshRotation(entry);
    var cH = hostModel.centerOffset, cN = made.centerOffset;
    host.mesh.updateMatrixWorld(true);
    var at = host.mesh.localToWorld(new THREE.Vector3(cN.x - cH.x, cN.y - cH.y, cN.z - cH.z));
    entry.mesh.quaternion.copy(host.mesh.quaternion);
    entry.mesh.position.copy(at);
    entry.mesh.updateMatrixWorld(true);
    entry.x = at.x; entry.z = at.z;
    var lift = (host.liftY || 0) + meshLocalBox3(entry.mesh).min.y - hostBottom;
    entry.liftY = lift > 1e-6 ? lift : 0;
  }

  function status(msg, bad) {
    if (typeof setStatus === 'function') setStatus(msg, !!bad);
  }

  /* A model on the plate and a shape, ready for plan / run: the pose through
     the mesh as drawn, and a `pieceId` (a piece on the plate, read as drawn -
     it may be m itself) turned into the soup it names.
     -> { piece, shape, host } or { reason } */
  function resolve(m, shape) {
    if (typeof state === 'undefined' || typeof THREE === 'undefined') return { reason: 'Crop needs the app' };
    if (!m || !m.rawTris) return { reason: 'select a raw piece first' };
    var host = placedOf(m.id);
    if (!host) return { reason: 'that piece is not on the plate' };
    var fr = plateToRaw(m, host.mesh);
    if (fr.reason) return { reason: fr.reason };
    var sh = {};
    Object.keys(shape || {}).forEach(function (k) { sh[k] = shape[k]; });
    if (sh.pieceId != null) {
      var other = placedOf(sh.pieceId);
      if (!other) return { reason: 'the other piece is no longer on the plate' };
      sh.source = meshSoupP(other.mesh);
    }
    return { piece: { name: m.name, rawTris: m.rawTris, toRaw: fr.M }, shape: sh, host: host };
  }

  /* plan() for a model on the plate: what the card's readout asks. */
  async function planOn(m, shape) {
    var r = resolve(m, shape);
    if (r.reason) return { ok: false, reason: r.reason };
    // a piece whose shells a CROP already merged is planned on that solid, as its copy will be
    var mergedRaw = root && root.nsoOverlap ? root.nsoOverlap.cachedMerge(r.piece.rawTris) : null;
    if (!mergedRaw) return plan(r.piece, r.shape);
    var n = root.nsoOverlap.shells(r.piece.rawTris, true);
    r.piece.rawTris = mergedRaw;
    var p = await plan(r.piece, r.shape);
    if (p && p.ok) p.merged = root.nsoOverlap.note(m.name, n);
    return p;
  }

  /* The outline's footprint F - before any offset - as plain loops in P:
     { polys: [[[x, y], ...], ...], area } or { reason }. For the card's
     handles, which sit on its boundary. */
  async function footprintPolys(shape) {
    var kern = kernel(), wasm;
    if (!kern) return { reason: 'no boolean kernel in this build' };
    try { wasm = await kern.load(); }
    catch (err) { return { reason: 'the boolean kernel failed to load' }; }
    if (!shape || shape.kind !== 'outline' || !shape.source) return { reason: 'no outline' };
    var plain = {};
    Object.keys(shape).forEach(function (k) { plain[k] = shape[k]; });
    plain.d1 = 0; plain.d2 = 0;
    var fp = footprint(wasm, plain);
    if (!fp.cs) return { reason: fp.reason };
    try {
      var polys = fp.cs.toPolygons().map(function (ring) {
        return ring.map(function (p) { return p.x !== undefined ? [p.x, p.y] : [p[0], p[1]]; });
      });
      return { polys: polys, area: fp.cs.area() };
    } catch (err) { return { reason: (err && err.message) || String(err) }; }
    finally { fp.cs.delete(); }
  }

  /* NSO_Crop.copy(m, shape) -> Promise<{ ok, id, name, ... } | { ok: false, reason }>
     m is a model of state.models that is on the plate. A shape's `piece` or
     `source` may be { pieceId } instead: a piece on the plate, read as drawn
     (it may be m itself). */
  var busy = false;
  async function copy(m, shape) {
    function refuse(why, flags) {
      status(flags && flags.cancelled ? 'Crop stopped - nothing changed' : 'Crop refused - nothing changed (' + why + ')', !(flags && flags.cancelled));
      return stopped(flags || {}, { ok: false, reason: why });
    }
    if (typeof state === 'undefined' || typeof THREE === 'undefined' || typeof addModel !== 'function') {
      return { ok: false, reason: 'Crop copy needs the app' };
    }
    if (busy) return { ok: false, reason: 'busy' };
    var rs = resolve(m, shape);
    if (rs.reason) return refuse(rs.reason);
    var host = rs.host;
    busy = true;
    try {
      /* Work as is (nso-helpers.js, nsoOverlap): a piece - or a Piece cutter - whose shells overlap is cut from
         those shells merged into one solid, for this copy only. The piece on the plate is not touched. */
      var merged = [];
      if (root && root.nsoOverlap) {
        var sol = await root.nsoOverlap.solid(m, null, 'crop-readout');
        if (!sol.ok) return refuse(sol.reason, sol);
        if (sol.merged) { rs.piece.rawTris = sol.soup; merged.push(sol.note); }
        // a Piece cutter is a solid too; an Outline reads its piece's triangles by index, so it is left as drawn
        var cutter = rs.shape.kind === 'piece' && rs.shape.pieceId != null ? placedOf(rs.shape.pieceId) : null;
        var cm = cutter && cutter.sourceId !== m.id ? (state.models || []).find(function (x) { return x.id === cutter.sourceId; }) : null;
        if (cm) {
          var cs = await root.nsoOverlap.solid(cm, { geometry: cutter.mesh.geometry, mesh: cutter.mesh }, 'crop-readout');
          if (!cs.ok) return refuse(cs.reason, cs);
          if (cs.merged) { rs.shape.source = root.nsoOverlap.zUp(cs.world); merged.push(cs.note); }
        } else if (cutter && sol.merged) {
          // the piece is its own cutter: the same merged solid, through the pose it is drawn with
          rs.shape.source = matApplySoup(matInvert(rs.piece.toRaw), sol.soup);
        }
      }
      var r = await run(rs.piece, rs.shape);
      if (!r.ok) return refuse(r.reason, r);

      var geo = rawResultToDisplayGeometry(r.tris);
      var name = cropName(m.name || 'piece');
      var id = addModel(name, geo, {
        rawTris: r.tris, rawAxis: 'zup', centerOffset: computeCenterOffsetFromRaw(r.tris),
        keepSelection: true, silent: true
      });
      if (id == null) return refuse('the copy is under 0.1 mm across one way, too small to be a piece');
      pushUndo({ type: 'addModels', ids: [id], editId: state.editId, cutT: state.cutT });
      var made = state.models.find(function (mm) { return mm.id === id; });
      var hostBottom = meshLocalBox3(host.mesh).min.y;
      var entry = placeModelMovable(made, host.x, host.z);
      if (entry) landInPlace(entry, made, m, host, hostBottom);
      var at = state.placed.indexOf(entry);
      if (at >= 0 && typeof selectPlaced === 'function') selectPlaced(at);
      if (typeof renderModelList === 'function') renderModelList();
      if (typeof updateAdjustUI === 'function') updateAdjustUI();
      var text = 'Crop: "' + name + '" - ' + say(r, 'copied') +
        ' It sits where it was cut from; grab it to move it. One Undo removes it.' +
        (merged.length ? ' (' + merged.join('; ') + '.)' : '');
      status(text);
      return { ok: true, id: id, name: name, faces: r.faces, volumeMm3: r.volumeMm3, bbox: r.bbox, text: text };
    } catch (err) {
      return refuse((err && err.message) || String(err));
    } finally {
      busy = false;
    }
  }

  var API = {
    SHAPES: SHAPES,
    DEFAULTS: DEFAULTS,
    plan: plan,
    run: run,
    cutterSoup: cutterSoup,
    cropCore: cropCore,
    job: job,
    resolve: resolve,
    planOn: planOn,
    footprintPolys: footprintPolys,
    rimLoop: rimLoop,
    census: census,
    weldSoup: weldSoup,
    volume: volume,
    bounds: bounds,
    extentInP: extentInP,
    circleSegments: circleSegments,
    sphereSegments: sphereSegments,
    matApply: matApply,
    matInvert: matInvert,
    plateToRaw: plateToRaw,
    meshSoupP: meshSoupP,
    copy: copy
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Crop = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
