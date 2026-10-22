/* A piece's bounds - one definition of where it is, one call to forget it.

   THE BOX THAT LIES. meshLocalBox3 used to be the geometry's bounding box with
   the mesh's matrix applied to its eight corners. That is the world box of the
   piece only while the corners are vertices - an unturned piece, or a box
   turned and nothing else. A piece whose geometry already carries a turn (a
   Seat here / drop-onto-piece bake: "turned 5.7 degrees and baked into its own
   axes") has a bounding box that is the tight box of the TURNED soup, not of
   the piece, so its corners are in the air beside it; pose that piece again
   (Tilt, Tip, a Rotate ring, the pose it already had) and the corners go on
   swinging out. The "lowest point" read off them sits below the lowest vertex,
   so To plate parks the piece above the bed and a second press says "Already
   on the plate"; Vertical's liftY is measured from the same number and reads
   0.00 over a piece that is drawn in the air; Tip on face lands the face
   short of the plate. Nothing in the geometry was stale. The question was
   asked of the wrong thing.

   So the world box here is measured on the VERTICES: the position attribute
   through the mesh's matrix, min and max. When the matrix cannot make a
   difference - no turn, or a turn that sends axes to axes - the bounding box
   is exact and is used as it is. The measurement is cached per geometry, keyed
   on what it was measured from (the position attribute, its version and its
   size, and the 3 x 3 of the matrix); a translation never invalidates it, so a
   drag, which only translates, costs a lookup.

   ONE INVALIDATION. nsoInvalidatePieceBounds(target) is what every geometry
   rewrite goes through - the pose-preserving bakes (nsoReseatPlacedPose: Lift,
   Cut, Scale, Soften, Seal, Mirror, Seat here, a drop onto a piece, an Undo of
   any of them) and the pose-consuming ones (nsoClearPlacedPose: Join,
   Subtract, Connect weld). It forgets what was measured for the piece's
   geometries, makes the geometry re-measure its own bounding box and sphere,
   and, for a placed entry, re-reads width / depth / height off the posed box.
   The cache would notice a swapped geometry on its own - a new object is a new
   key - but an edit in place, and the width / depth / height every pose reads
   (and the pose snapshot Undo copies), do not announce themselves.

   WHERE THE PIECE SITS. restOffsets(mesh) is how far the piece's lowest and
   highest points are from the mesh ORIGIN once posed. For a piece whose posed
   box is centred on its origin that is plus and minus half the height - what
   applyMeshRotation and both exporters used to assume everywhere. A baked,
   turned, re-posed piece is not centred, and the assumption put it up to a few
   millimetres off the plate. They read the offset instead.

   Plain classic script, loaded ahead of every app-*.js. Nothing here touches
   the DOM; the headless checks that load an app file into a bare context fall
   back to the plain bounding box when this is absent (meshLocalBox3). */
(function () {
  'use strict';

  var cache = new WeakMap();      // geometry -> { posAttr, version, count, rot, box }
  var AXIS_EPS = 1e-9;

  function T() { return typeof THREE !== 'undefined' ? THREE : null; }

  function positionOf(geometry) {
    return geometry && geometry.attributes ? geometry.attributes.position : null;
  }

  /* The 3 x 3 of a matrix, column-major as three.js keeps it. */
  function rotOf(e) { return [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]]; }

  /* True when the matrix sends every axis to an axis (identity, a mirror, a
     scale, a quarter turn): the bounding box is then exactly the box of the
     vertices, and no vertex needs visiting. Each ROW must have exactly one
     non-zero entry, in a column no other row uses. */
  function sendsAxesToAxes(r) {
    var used = [false, false, false];
    for (var row = 0; row < 3; row++) {
      var at = -1;
      for (var col = 0; col < 3; col++) {
        // r is column-major: r[col * 3 + row]
        if (Math.abs(r[col * 3 + row]) > AXIS_EPS) {
          if (at >= 0) return false;
          at = col;
        }
      }
      if (at < 0 || used[at]) return false;
      used[at] = true;
    }
    return true;
  }

  function sameRot(a, b) {
    for (var i = 0; i < 9; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /* The box of the geometry's vertices after the matrix's 3 x 3, translation
     left out: { min: [x, y, z], max: [x, y, z] }. */
  function measure(geometry, r) {
    var pos = positionOf(geometry);
    if (!pos || !pos.count) return null;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    if (sendsAxesToAxes(r)) {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      var bb = geometry.boundingBox, c = [bb.min.x, bb.min.y, bb.min.z], d = [bb.max.x, bb.max.y, bb.max.z];
      for (var row = 0; row < 3; row++) {
        // the one entry in this row scales one axis of the box into this one
        for (var col = 0; col < 3; col++) {
          var k = r[col * 3 + row];
          if (Math.abs(k) <= AXIS_EPS) continue;
          var a = k * c[col], b = k * d[col];
          lo[row] = Math.min(a, b); hi[row] = Math.max(a, b);
        }
      }
      return { min: lo, max: hi };
    }
    var arr = pos.array, n = pos.count, stride = pos.data ? pos.data.stride : 3, off = pos.offset || 0;
    if (pos.data) arr = pos.data.array;
    var r00 = r[0], r10 = r[1], r20 = r[2], r01 = r[3], r11 = r[4], r21 = r[5], r02 = r[6], r12 = r[7], r22 = r[8];
    var x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (var i = 0; i < n; i++) {
      var o = i * stride + off, x = arr[o], y = arr[o + 1], z = arr[o + 2];
      var X = r00 * x + r01 * y + r02 * z;
      var Y = r10 * x + r11 * y + r12 * z;
      var Z = r20 * x + r21 * y + r22 * z;
      if (X < x0) x0 = X; if (X > x1) x1 = X;
      if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
      if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
    }
    return { min: [x0, y0, z0], max: [x1, y1, z1] };
  }

  /* The vertices' box after `e`'s 3 x 3 (e: a matrix's 16 elements), cached. */
  function measuredUnder(g, e) {
    var pos = positionOf(g);
    if (!pos) return null;
    var r = rotOf(e);
    var hit = cache.get(g);
    if (hit && hit.pos === pos && hit.version === pos.version && hit.count === pos.count && sameRot(hit.rot, r)) {
      return hit.box;
    }
    var box = measure(g, r);
    if (!box) return null;
    cache.set(g, { pos: pos, version: pos.version, count: pos.count, rot: r, box: box });
    return box;
  }

  function measured(mesh) {
    var g = mesh && mesh.geometry;
    if (!positionOf(g)) return null;
    mesh.updateMatrixWorld(true);
    var e = mesh.matrixWorld.elements, box = measuredUnder(g, e);
    return box ? { box: box, e: e } : null;
  }

  /** The mesh's box in the world, measured on its vertices. */
  function worldBox(mesh) {
    var three = T();
    if (!mesh || !mesh.geometry || !three) return three ? new three.Box3() : null;
    var m = measured(mesh);
    if (!m) return new three.Box3();
    var e = m.e, b = m.box;
    return new three.Box3(
      new three.Vector3(b.min[0] + e[12], b.min[1] + e[13], b.min[2] + e[14]),
      new three.Vector3(b.max[0] + e[12], b.max[1] + e[13], b.max[2] + e[14]));
  }

  /** The box of `geometry`'s vertices after `matrix`'s rotation / scale, no
      translation: { min: [x, y, z], max: [x, y, z] } relative to the origin.
      What the exporters and the scene's basis place a piece by, without a mesh. */
  function boxUnder(geometry, matrix) {
    return geometry && matrix ? measuredUnder(geometry, matrix.elements) : null;
  }

  /** How far the piece's lowest and highest points are from the mesh origin,
      as it is posed now: { minY, maxY, height }. */
  function restOffsets(mesh) {
    var m = measured(mesh);
    if (!m) return null;
    // the mesh's matrix includes its parent's; the offset is from the origin
    return { minY: m.box.min[1], maxY: m.box.max[1], height: m.box.max[1] - m.box.min[1] };
  }

  /* The geometries a target stands for. */
  function geometriesOf(target, out) {
    out = out || [];
    if (!target) return out;
    var add = function (g) { if (g && g.attributes && out.indexOf(g) < 0) out.push(g); };
    if (target.attributes) add(target);                                  // a geometry
    else if (target.isMesh || target.geometry) add(target.geometry);      // a mesh, a model
    if (target.mesh) add(target.mesh.geometry);                           // a placed entry
    return out;
  }

  /** Forget what was measured for `target` (a placed entry, a model, a mesh or
      a geometry) and re-measure it: the geometry's own bounding box and sphere,
      and for a placed entry its width / depth / height off the posed box.
      Returns the entry's posed size, or null. */
  function invalidate(target) {
    geometriesOf(target).forEach(function (g) {
      cache.delete(g);
      frameCache.delete(g);
      if (window.NSO_BVH) window.NSO_BVH.touch(g);     // a big piece's tree is stale: ask for the next one now
      if (positionOf(g)) {
        g.computeBoundingBox();
        g.computeBoundingSphere();
      }
    });
    var mesh = target && (target.mesh || (target.isMesh ? target : null));
    if (!mesh || !mesh.geometry) return null;
    var off = restOffsets(mesh), three = T();
    if (!off || !three) return null;
    var box = worldBox(mesh), size = box.getSize(new three.Vector3());
    if (target.mesh && target !== mesh) {           // a placed entry: its sizes are what every pose reads
      target.width = size.x;
      target.depth = size.z;
      target.height = size.y;
    }
    return { x: size.x, y: size.y, z: size.z, minY: off.minY, maxY: off.maxY };
  }

  /* The box of a geometry's own vertices (no matrix), as a fresh Box3. For a
     BIG geometry (300k triangles and up) the walk over every vertex is 30-70 ms
     and the cutter asks it on every blade move, so the answer is kept, keyed on
     what it was measured from (the array, the attribute's version, its size) -
     an edit that is drawn bumps the version and is re-measured. A small
     geometry is measured every time, as it always was. */
  var boxCache = new WeakMap();
  function localBox(geometry) {
    var three = T(), pos = positionOf(geometry);
    if (!three || !pos) return null;
    var big = pos.count >= 900000;
    if (big) {
      var e = boxCache.get(geometry);
      if (e && e.array === pos.array && e.version === pos.version && e.count === pos.count) return e.box.clone();
    }
    var box = new three.Box3().setFromBufferAttribute(pos);
    if (big) boxCache.set(geometry, { array: pos.array, version: pos.version, count: pos.count, box: box.clone() });
    return box;
  }

  /* ---- THE PIECE'S FRAME --------------------------------------------------
     The one answer to "which way does this piece lie": its footprint - the
     narrowest rectangle round the shadow its vertices cast on the plate - as
     two LEVEL unit vectors, the long side and the short side, and the plate
     vertical. Every tool that needs the piece's axes asks this (pieceFrame);
     none keeps a copy of its own. It is measured on the vertices through the
     mesh's matrix, so it says the same thing of a piece whose turn is baked
     into its geometry (identity rotation, the pose fields 0) and of one still
     carrying a turn on its mesh mid-drag.

     The rectangle is found by rotating calipers: the narrowest rectangle round
     a convex polygon has a side along one of its edges, so each edge of the
     shadow's hull is tried. Exact ties (a regular polygon - a cylinder's
     shadow - has one per edge) go to the side nearest the plate's X, so a
     round piece reads square to the plate rather than at whatever edge came
     first. Within SQUARE_WITHIN of square there is no long side (`square`).

     Cached per geometry like the box above, keyed on the position attribute,
     its version and size, and the 3 x 3 of the matrix: a drag that only
     translates costs a lookup. HELD: while a pose drag is in hand the frame
     taken at the press is what every caller gets (holdFrame / releaseFrame),
     so the axes in hand do not swing under the pointer. */
  var frameCache = new WeakMap();
  var SQUARE_WITHIN = 0.05;
  var TIE = 1e-6;

  function hullOf(geometry, r) {
    var pos = positionOf(geometry);
    if (!pos || !pos.count) return [];
    var arr = pos.array, n = pos.count, stride = pos.data ? pos.data.stride : 3, off = pos.offset || 0;
    if (pos.data) arr = pos.data.array;
    var r00 = r[0], r20 = r[2], r01 = r[3], r21 = r[5], r02 = r[6], r22 = r[8];
    var X = new Float64Array(n), Z = new Float64Array(n), i, o;
    /* Akl-Toussaint: the eight extreme points bound an octagon; nothing
       strictly inside it can be on the hull. */
    var ext = [[Infinity, -1], [-Infinity, -1], [Infinity, -1], [-Infinity, -1],
               [Infinity, -1], [-Infinity, -1], [Infinity, -1], [-Infinity, -1]];
    for (i = 0; i < n; i++) {
      o = i * stride + off;
      var x = arr[o], y = arr[o + 1], z = arr[o + 2];
      var px = r00 * x + r01 * y + r02 * z, pz = r20 * x + r21 * y + r22 * z;
      X[i] = px; Z[i] = pz;
      var k = [px, px, pz, pz, px + pz, px + pz, px - pz, px - pz];
      for (var j = 0; j < 8; j++) {
        if (j % 2 === 0 ? k[j] < ext[j][0] : k[j] > ext[j][0]) { ext[j][0] = k[j]; ext[j][1] = i; }
      }
    }
    var oct = [ext[0][1], ext[7][1], ext[2][1], ext[5][1], ext[1][1], ext[6][1], ext[3][1], ext[4][1]];
    // order the octagon's corners round the centre of the box
    var cx = 0, cz = 0;
    oct.forEach(function (q) { cx += X[q]; cz += Z[q]; });
    cx /= 8; cz /= 8;
    oct = oct.filter(function (q, t) { return oct.indexOf(q) === t; })
      .sort(function (a, b) { return Math.atan2(Z[a] - cz, X[a] - cx) - Math.atan2(Z[b] - cz, X[b] - cx); });
    var inside = function (px, pz) {
      if (oct.length < 3) return false;
      for (var t = 0; t < oct.length; t++) {
        var a = oct[t], b = oct[(t + 1) % oct.length];
        if ((X[b] - X[a]) * (pz - Z[a]) - (Z[b] - Z[a]) * (px - X[a]) <= 1e-12) return false;
      }
      return true;
    };
    var pts = [];
    for (i = 0; i < n; i++) if (!inside(X[i], Z[i])) pts.push([X[i], Z[i]]);
    pts.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var cross = function (a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); };
    var lower = [], upper = [];
    for (i = 0; i < pts.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) lower.pop();
      lower.push(pts[i]);
    }
    for (i = pts.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) upper.pop();
      upper.push(pts[i]);
    }
    lower.pop(); upper.pop();
    return lower.concat(upper);
  }

  /* The narrowest rectangle round the hull: { d: [x, z] unit along one side,
     ed, en: the extents along d and along its normal, mid: [x, z] its centre }. */
  function narrowest(hull) {
    if (!hull.length) return null;
    var dirs = [];
    for (var i = 0; i < hull.length; i++) {
      var a = hull[i], b = hull[(i + 1) % hull.length], dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
      if (l > 1e-9) dirs.push([dx / l, dz / l]);
    }
    if (!dirs.length) dirs.push([1, 0]);
    var best = null, cands = [];
    dirs.forEach(function (d) {
      var lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity;
      hull.forEach(function (p) {
        var s = p[0] * d[0] + p[1] * d[1], t = -p[0] * d[1] + p[1] * d[0];
        if (s < lo0) lo0 = s; if (s > hi0) hi0 = s;
        if (t < lo1) lo1 = t; if (t > hi1) hi1 = t;
      });
      var c = { d: d, ed: hi0 - lo0, en: hi1 - lo1, area: (hi0 - lo0) * (hi1 - lo1),
                mid: [((lo0 + hi0) / 2) * d[0] - ((lo1 + hi1) / 2) * d[1], ((lo0 + hi0) / 2) * d[1] + ((lo1 + hi1) / 2) * d[0]] };
      cands.push(c);
      if (!best || c.area < best.area) best = c;
    });
    /* exact ties: the one whose long side lies nearest the plate's X */
    var nearX = function (c) { var L = c.ed >= c.en ? c.d : [-c.d[1], c.d[0]]; return Math.abs(L[0]); };
    cands.forEach(function (c) {
      if (c.area <= best.area * (1 + TIE) + 1e-12 && nearX(c) > nearX(best) + 1e-12) best = c;
    });
    return best;
  }

  function frameUnder(g, e) {
    var pos = positionOf(g);
    if (!pos) return null;
    var r = rotOf(e);
    var hit = frameCache.get(g);
    if (hit && hit.pos === pos && hit.version === pos.version && hit.count === pos.count && sameRot(hit.rot, r)) return hit.f;
    var hull = hullOf(g, r), rect = narrowest(hull);
    if (!rect) return null;
    var L = rect.ed >= rect.en ? rect.d : [-rect.d[1], rect.d[0]];
    var lenL = Math.max(rect.ed, rect.en), lenS = Math.min(rect.ed, rect.en);
    // canonical sense: the long side points +X (or +Z when square to X)
    if (L[0] < -1e-12 || (Math.abs(L[0]) <= 1e-12 && L[1] < 0)) L = [-L[0], -L[1]];
    var f = { long: [L[0], 0, L[1]], short: [-L[1], 0, L[0]], lengths: { long: lenL, short: lenS },
              mid: rect.mid, square: !(lenL > 0) || (lenL - lenS) <= SQUARE_WITHIN * lenL,
              area: rect.area, hull: hull };
    frameCache.set(g, { pos: pos, version: pos.version, count: pos.count, rot: r, f: f });
    return f;
  }

  var held = new WeakMap();      // placed entry -> the frame taken at the press
  function vec(a) { var three = T(); return new three.Vector3(a[0], a[1], a[2]); }
  /** The piece's frame as it lies now: { long, short, up } unit Vector3s (long
      and short level, long x up = short), { lengths: { long, short } } in mm,
      `centre` (the footprint's middle, at the piece's lowest point) and
      `square` (no long side). `p` is a placed entry or a mesh. */
  function pieceFrame(p) {
    var three = T();
    if (!three || !p) return null;
    if (held.has(p)) return cloneFrame(held.get(p));
    var mesh = p.mesh || (p.isMesh ? p : null);
    if (!mesh || !mesh.geometry) return null;
    mesh.updateMatrixWorld(true);
    var e = mesh.matrixWorld.elements, f = frameUnder(mesh.geometry, e);
    if (!f) return null;
    var box = worldBox(mesh);
    var r = squareToBody(placedOf(p, mesh), mesh, f) || f;
    var L = vec(r.long);
    return {
      long: L, short: new three.Vector3(-L.z, 0, L.x), up: new three.Vector3(0, 1, 0),
      lengths: { long: r.lengths.long, short: r.lengths.short, height: box.max.y - box.min.y },
      centre: new three.Vector3(r.mid[0] + e[12], box.min.y, r.mid[1] + e[14]),
      square: r.square
    };
  }
  function placedOf(p, mesh) {
    if (p && p.mesh) return p;
    var S = typeof state !== 'undefined' ? state : null;
    return (S && S.placed) ? S.placed.find(function (q) { return q && q.mesh === mesh; }) || null : null;
  }
  /* SQUARE TO THE BODY FIRST. The narrowest rectangle is ill-defined where
     the footprint is round or nearly square (a tube's shadow has one per facet,
     at whatever angle each falls) and off by a hair where the geometry carries
     a small turn nothing recorded (a Seat here bake, an imported part) - and a
     tool that turns by the frame would turn the piece by that meaningless
     angle. So the rectangle square to the piece's BODY axes (nsoPieceBodyQ,
     app-core.js: its load axes where its turns have taken them - exact, never
     measured) is tried first, along the shadow of each body axis that casts
     one: when it is within BODY_TOL of the narrowest, it IS the frame, its
     sides taken exactly. A piece the verbs turned, or never turned, therefore
     reads its own axes bit for bit; only a piece whose body really lies across
     its footprint is read off the hull. */
  var BODY_TOL = 0.02;
  function squareToBody(p, mesh, f) {
    var three = T();
    if (!three || !f.hull || !f.hull.length) return null;
    var q = (p && typeof window.nsoPieceBodyQ === 'function') ? window.nsoPieceBodyQ(p) : mesh.quaternion.clone();
    var best = null;
    [[1, 0, 0], [0, 0, 1], [0, 1, 0]].forEach(function (b) {
      var a = new three.Vector3(b[0], b[1], b[2]).applyQuaternion(q);
      var l = Math.hypot(a.x, a.z);
      if (l < 0.5) return;                              // a steep axis casts too short a shadow to square by
      var d = [a.x / l, a.z / l];
      var lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity;
      f.hull.forEach(function (h) {
        var s0 = h[0] * d[0] + h[1] * d[1], t = -h[0] * d[1] + h[1] * d[0];
        if (s0 < lo0) lo0 = s0; if (s0 > hi0) hi0 = s0;
        if (t < lo1) lo1 = t; if (t > hi1) hi1 = t;
      });
      var area = (hi0 - lo0) * (hi1 - lo1);
      if (!best || area < best.area - 1e-12) {
        best = { d: d, ed: hi0 - lo0, en: hi1 - lo1, area: area,
                 mid: [((lo0 + hi0) / 2) * d[0] - ((lo1 + hi1) / 2) * d[1], ((lo0 + hi0) / 2) * d[1] + ((lo1 + hi1) / 2) * d[0]] };
      }
    });
    if (!best || !(best.area <= f.area * (1 + BODY_TOL) + 1e-12)) return null;
    var L = best.ed >= best.en ? best.d : [-best.d[1], best.d[0]];
    if (L[0] < -1e-12 || (Math.abs(L[0]) <= 1e-12 && L[1] < 0)) L = [-L[0], -L[1]];
    var lenL = Math.max(best.ed, best.en), lenS = Math.min(best.ed, best.en);
    return { long: [L[0], 0, L[1]], lengths: { long: lenL, short: lenS }, mid: best.mid,
             square: !(lenL > 0) || (lenL - lenS) <= SQUARE_WITHIN * lenL };
  }
  function cloneFrame(f) {
    return { long: f.long.clone(), short: f.short.clone(), up: f.up.clone(),
             lengths: { long: f.lengths.long, short: f.lengths.short, height: f.lengths.height },
             centre: f.centre.clone(), square: f.square };
  }
  /** Hold the frame `p` has now until releaseFrame(p): a pose drag's press. */
  function holdFrame(p) {
    if (!p) return null;
    held.delete(p);
    var f = pieceFrame(p);
    if (f) held.set(p, f);
    return f;
  }
  function releaseFrame(p) { if (p) held.delete(p); }

  window.nsoBounds = {
    pieceFrame: pieceFrame,
    holdFrame: holdFrame,
    releaseFrame: releaseFrame,
    SQUARE_WITHIN: SQUARE_WITHIN,
    localBox: localBox,
    worldBox: worldBox,
    restOffsets: restOffsets,
    boxUnder: boxUnder,
    invalidate: invalidate,
    /* For the checks: how many geometries hold a measurement is not countable
       on a WeakMap, so ask about one. */
    has: function (geometry) { return cache.has(geometry); }
  };
  window.nsoInvalidatePieceBounds = invalidate;
  window.pieceFrame = pieceFrame;
})();
