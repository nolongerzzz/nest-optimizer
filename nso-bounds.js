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

  window.nsoBounds = {
    worldBox: worldBox,
    restOffsets: restOffsets,
    boxUnder: boxUnder,
    invalidate: invalidate,
    /* For the checks: how many geometries hold a measurement is not countable
       on a WeakMap, so ask about one. */
    has: function (geometry) { return cache.has(geometry); }
  };
  window.nsoInvalidatePieceBounds = invalidate;
})();
