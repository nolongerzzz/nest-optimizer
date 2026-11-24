/* ============================================================
   NSO_Carve — the local carving tool's geometry core
   no ES modules, browser-global like the rest of the app, and no THREE:
   plain triangle soups and plain 3-vectors, so tools/nso_carve_test.js runs
   the whole of this file under node with no browser.

   What this is
   ------------
   A small, freely-oriented, local carving tool. Pick a blade profile, aim it
   at a face, an edge or a corner of a piece, and subtract just that local
   volume. A handheld rotary tool, not the Cutter's full-plane Split.

   What it deliberately is NOT
   ---------------------------
   It is not a second boolean, and it does not touch one. `docs/LOCAL-CARVE.md`
   measured the shipped CSG path — NSO_plugFrame -> NSO_CSG.buildCutVolume ->
   subtractSoupBFromA in app-join.js — at a hand-parked edge and corner and
   found it already removes exactly blade n hull (0.000 mm^3 shortfall) with a
   clean gate on tools/mesh_validate.py. The gap was placement only:
   NSO_seatFlushBitToHull requires all four corners of the bit's outer box face
   to hit the hull along one punch axis, which a straddling bit cannot do (2 of
   4 at an edge, 1 of 4 at a corner), and where it does not refuse a straddle
   it silently drives it out and seats the bit flush on one face instead.

   So this file replaces the PLACEMENT step and nothing else. It emits a blade
   solid and a world matrix; app-carve.js wraps those in a frame of exactly the
   shape buildCutVolume already reads and hands it to the unchanged
   subtractSoupBFromA. Same pattern as nso_inside_corners.js, which gives a
   concave pocket a convex treatment by running the unmodified convex engine on
   the plug and letting the boolean mirror it inward: keep the kernel path, move
   what you feed it.

   BLADE-LOCAL CONVENTION — every builder obeys it, every placement assumes it
   ---------------------------------------------------------------------------
     +Y  is OUT of the material. The blade's local AABB is y in [0, height];
         y = 0 is the cutting tip and y = height the shank end, which must stay
         outside the piece (so height > depth, enforced).
     +Z  is the blade's sweep axis: the length of a slab, the apex line of a
         V-groove. Placement lays it along an edge.
     +X  is the cross axis, = Y x Z.
     The cut reference point is local (0, 0, 0) — the tip.

   That convention is what lets one frame serve every blade and every target.
   With local +Y as the outward normal, the frame handed to the kernel is
   always { axis: 1, sign: 1, capCoord: height }: the free orientation lives
   entirely in the world matrix, and buildCutVolume's own maths never learns
   that anything changed.

   WHAT IS NOT SOLVED HERE, on purpose
   -----------------------------------
   1. Pose state is this tool's own. A blade is never a placed piece: it is
      built, transformed, subtracted and dropped, so it never enters
      state.placed and never meets applyMeshRotation. That is deliberate. The
      app's pose model is quantised Euler (90 deg yaw, 15 deg tilt/bank, no
      quaternion field, and none in snapshotPlacedPose), so it cannot represent
      a free orientation; threading a real quaternion through it would touch
      every piece and every pose button for one consumer. See
      docs/LOCAL-CARVE.md, "Deferred: free orientation in the pose model".
   2. minWall still guards ONE axis, unchanged. buildCutVolume measures depth
      by ray-casting along frame.punch only, so at an edge or a corner — where
      two or three faces are in play — a carve can still sever a thin wall in a
      direction nothing measured. That is not silently accepted: carveReport
      names it in the status line every time more than one face is engaged.
      Generalising it belongs with the wall-thickness/nozzle-safety audit, not
      here.
   ============================================================ */
(function (root) {
  'use strict';

  var EPS = 1e-9;

  /* ---- plain 3-vector helpers (no THREE in this file) ---- */
  function v3(x, y, z) { return [x, y, z]; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function norm(a) { var L = len(a); return (L > EPS) ? [a[0] / L, a[1] / L, a[2] / L] : null; }

  /* ============================================================
     1. THE BLADE LIBRARY  (Task 2)

     Shape of the registry is NSO_Skin.PATTERNS's, deliberately:
     { name: { defaults, describe, build } }. Same per-profile defaults, same
     human-readable describe, same withDefaults merge, so the viewport <select>
     that drives skin patterns drives blades the same way.

     It is NOT app-library.js's CATALOG. That is a flat list of STL filenames
     for fixed-size connector plugs authored offline; nothing in it is
     parametric and nothing in it generates geometry. A blade has to be sized
     to the cut, so it is built, not fetched.

     Every build() returns a CLOSED WATERTIGHT solid soup (Float32Array, 9
     floats per triangle, no shared index — the soup the whole app speaks) in
     blade-local mm, wound outward, positive signed volume.
     ============================================================ */

  /* Extrude a convex polygon in the local XY plane along local Z. Serves the
     slab and the wedge: both are prisms, so there is one cap-and-sides
     routine rather than two hand-wound solids.
     `poly` is [[x,y], ...] counter-clockwise seen from +Z. */
  function extrudeZ(poly, z0, z1, sink) {
    var n = poly.length, i;
    /* +Z cap: the polygon's own order is CCW from +Z, which is outward there */
    for (i = 1; i < n - 1; i++) {
      sink.push(poly[0][0], poly[0][1], z1, poly[i][0], poly[i][1], z1, poly[i + 1][0], poly[i + 1][1], z1);
    }
    /* -Z cap: reversed */
    for (i = 1; i < n - 1; i++) {
      sink.push(poly[0][0], poly[0][1], z0, poly[i + 1][0], poly[i + 1][1], z0, poly[i][0], poly[i][1], z0);
    }
    /* sides: for a CCW edge a->b the outward in-plane normal is (dy, -dx), and
       (a@z0, b@z0, b@z1) / (a@z0, b@z1, a@z1) is the winding that gives it */
    for (i = 0; i < n; i++) {
      var a = poly[i], b = poly[(i + 1) % n];
      sink.push(a[0], a[1], z0, b[0], b[1], z0, b[0], b[1], z1);
      sink.push(a[0], a[1], z0, b[0], b[1], z1, a[0], a[1], z1);
    }
  }

  /* Surface of revolution about local Y, from a list of rings
     [{ y, rad }, ...] bottom to top, plus caps. A ring of radius 0 is a pole:
     its band degenerates to a fan, so the second triangle of each quad is
     dropped rather than emitted as a zero-area sliver. */
  function revolveY(rings, seg, sink) {
    var i, j, k;
    var cosT = [], sinT = [];
    for (j = 0; j <= seg; j++) {
      /* j == seg reuses j == 0's exact values, so the seam welds bit for bit */
      var t = (j % seg) / seg * Math.PI * 2;
      cosT.push(Math.cos(t)); sinT.push(Math.sin(t));
    }
    function P(ring, j) { return [ring.rad * cosT[j], ring.y, ring.rad * sinT[j]]; }

    for (k = 0; k < rings.length - 1; k++) {
      var L = rings[k], U = rings[k + 1];
      for (j = 0; j < seg; j++) {
        var lj = P(L, j), lj1 = P(L, j + 1), uj = P(U, j), uj1 = P(U, j + 1);
        if (L.rad > EPS || U.rad > EPS) {
          sink.push(lj[0], lj[1], lj[2], uj[0], uj[1], uj[2], uj1[0], uj1[1], uj1[2]);
        }
        if (L.rad > EPS) {
          sink.push(lj[0], lj[1], lj[2], uj1[0], uj1[1], uj1[2], lj1[0], lj1[1], lj1[2]);
        }
      }
    }
    /* bottom cap only when the first ring is not already a pole */
    var B = rings[0];
    if (B.rad > EPS) {
      for (j = 0; j < seg; j++) {
        var bj = P(B, j), bj1 = P(B, j + 1);
        sink.push(0, B.y, 0, bj[0], bj[1], bj[2], bj1[0], bj1[1], bj1[2]);
      }
    }
    var T = rings[rings.length - 1];
    if (T.rad > EPS) {
      for (j = 0; j < seg; j++) {
        var tj = P(T, j), tj1 = P(T, j + 1);
        sink.push(0, T.y, 0, tj1[0], tj1[1], tj1[2], tj[0], tj[1], tj[2]);
      }
    }
  }

  var BLADES = {
    /* flat shave: a slab. The y = 0 face is the cut, so it leaves a flat
       bottom and square walls - the local equivalent of a Split that stops. */
    flat: {
      defaults: { width: 6, length: 10, height: 6 },
      describe: function (p) {
        return 'flat shave, ' + p.width + ' x ' + p.length + ' mm face, ' + p.height + ' mm tall';
      },
      build: function (p) {
        var w = p.width / 2, h = p.height, L = p.length / 2;
        var out = [];
        extrudeZ([[-w, 0], [w, 0], [w, h], [-w, h]], -L, L, out);
        return out;
      },
      /* the cut's footprint across the surface, which is also the radius the
         probe uses to decide which faces this blade will actually touch */
      reach: function (p) { return Math.max(p.width, p.length) / 2; }
    },

    /* ball-nose gouge: a hemisphere-ended cylinder. Rounded floor, no corner
       to concentrate stress in, which is the point of a gouge. */
    ball: {
      defaults: { radius: 2, height: 6, seg: 24, rings: 6 },
      describe: function (p) {
        return 'ball-nose gouge, r ' + p.radius + ' mm, ' + p.height + ' mm tall, ' + p.seg + ' segments';
      },
      build: function (p) {
        var r = p.radius, H = p.height, seg = Math.max(8, p.seg | 0), nr = Math.max(2, p.rings | 0);
        var rings = [], k;
        for (k = 0; k <= nr; k++) {
          var phi = (k / nr) * (Math.PI / 2);
          rings.push({ y: r - r * Math.cos(phi), rad: r * Math.sin(phi) });
        }
        rings.push({ y: H, rad: r });     /* the shank, straight up from the equator */
        var out = [];
        revolveY(rings, seg, out);
        return out;
      },
      reach: function (p) { return p.radius; }
    },

    /* V-groove / chamfer cut: a wedge whose apex line is local Z. Cutting to
       depth d leaves a groove 2*d*tan(angle/2) wide, so ONE blade gives every
       chamfer size - depth is the size control, which is why `width` is not a
       parameter here. */
    vee: {
      defaults: { angle: 90, length: 10, height: 6 },
      describe: function (p) {
        var w = 2 * p.height * Math.tan(p.angle * Math.PI / 360);
        return 'V-groove, ' + p.angle + ' deg included, ' + p.length + ' mm long, ' +
          p.height + ' mm tall (' + w.toFixed(2) + ' mm wide at the top)';
      },
      build: function (p) {
        var h = p.height, L = p.length / 2;
        var w = h * Math.tan(p.angle * Math.PI / 360);   /* half-width at the top */
        var out = [];
        extrudeZ([[0, 0], [w, h], [-w, h]], -L, L, out);
        return out;
      },
      reach: function (p) {
        return Math.max(p.height * Math.tan(p.angle * Math.PI / 360), p.length / 2);
      }
    }
  };

  /* NSO_Skin.withDefaults's contract: only keys the profile declares survive,
     so a stale field from another blade cannot leak into a build. */
  function withDefaults(name, over) {
    if (!BLADES[name]) return null;
    var d = BLADES[name].defaults, out = {}, k;
    for (k in d) if (Object.prototype.hasOwnProperty.call(d, k)) {
      out[k] = (over && over[k] !== undefined && isFinite(Number(over[k]))) ? Number(over[k]) : d[k];
    }
    return out;
  }

  /* Validate before building: a blade with a bad parameter must refuse with a
     reason, never emit a broken solid for the kernel to reject downstream. */
  function validate(name, p) {
    if (!BLADES[name]) return 'unknown blade "' + name + '"';
    var k;
    for (k in p) if (Object.prototype.hasOwnProperty.call(p, k)) {
      if (!isFinite(p[k]) || p[k] <= 0) return name + ': ' + k + ' must be a positive number';
    }
    if (p.height !== undefined && p.height < 0.2) return name + ': height must be at least 0.2 mm';
    if (name === 'ball' && p.height <= p.radius + 1e-6) {
      return 'ball: height must exceed the radius (' + p.radius + ' mm) - the shank has to reach clear of the piece';
    }
    if (name === 'vee' && (p.angle < 10 || p.angle > 170)) return 'vee: angle must be between 10 and 170 degrees';
    return null;
  }

  /* name -> { soup, box, height, reach, describe } in blade-local mm */
  function buildBlade(name, over) {
    var p = withDefaults(name, over);
    if (!p) return { ok: false, reason: 'unknown blade "' + name + '"' };
    var bad = validate(name, p);
    if (bad) return { ok: false, reason: bad };
    var arr = BLADES[name].build(p);
    var soup = Float32Array.from(arr);
    if (!soup.length || soup.length % 9) return { ok: false, reason: name + ': builder produced a malformed soup' };
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], i, c;
    for (i = 0; i < soup.length; i++) {
      c = i % 3;
      if (soup[i] < lo[c]) lo[c] = soup[i];
      if (soup[i] > hi[c]) hi[c] = soup[i];
    }
    return {
      ok: true, blade: name, params: p, soup: soup,
      box: { min: lo, max: hi },
      height: hi[1],
      reach: BLADES[name].reach(p),
      describe: BLADES[name].describe(p)
    };
  }

  /* ============================================================
     2. THE TARGET PROBE  (Task 3, first half)

     Which faces of the piece does a blade aimed at this point actually meet -
     one (a face), two (an edge), or three (a corner)? And which way is "out
     of the material" there?

     This is the generalisation Seat could not make. Seat asks a fixed question
     - do all four corners of the bit's outer box face see the hull along one
     of six box axes - and a straddling bit fails it by construction. The
     question here is local and shape-agnostic: gather the triangles this blade
     can reach, cluster their normals into distinct planes, and let the count
     of clusters say what kind of feature it is. A face is then just the
     one-cluster case of the same formula, not a separate path.

     The outward direction is the normalised SUM of the distinct face normals -
     the bisector. For one face that is the face normal; for two it is the
     chamfer direction a file would take down an edge; for three it is the
     corner diagonal. One formula, three features.
     ============================================================ */

  var COS_SAME = 0.996;                       /* ~5 deg: two triangles of ONE flat face */
  var DIHEDRAL_DEG = 20;                      /* below this, two planes are one smooth region */

  /* Two thresholds, because they answer different questions and a single one
     cannot answer both.

     COS_SAME groups triangles into PLANES: two triangles of one flat face, or
     the two halves of a quad, differ by float noise only.

     DIHEDRAL_DEG then groups planes into FEATURES: is this a real edge, or is
     it one smoothly curved surface that happens to be tessellated? A box edge
     is 90 deg and is a feature boundary. A dome tessellated in 12 deg steps is
     not - and reading it as an edge (or a corner, with three facets in reach)
     is how a gouge on a smooth dome ended up being aimed at the meet of three
     tangent planes, which for a convex surface is a point in mid-air OUTSIDE
     the piece. The blade then removed nothing. Measured on
     fixtures/fixture_sphere_curved.stl: 0.0000 mm^3.

     So planes within DIHEDRAL_DEG of each other are merged, area-weighted,
     into one feature, transitively - which makes a gouge on a dome a `face`
     carve, as it should be, while leaving a box corner a corner. */

  /* squared distance from p to triangle abc, and the closest point */
  function closestOnTri(p, a, b, c, out) {
    var ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    var d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) { out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; return dot(sub(p, a), sub(p, a)); }
    var bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) { out[0] = b[0]; out[1] = b[1]; out[2] = b[2]; return dot(bp, bp); }
    var vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
      var v0 = d1 / (d1 - d3), q0 = add(a, mul(ab, v0));
      out[0] = q0[0]; out[1] = q0[1]; out[2] = q0[2]; return dot(sub(p, q0), sub(p, q0));
    }
    var cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) { out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return dot(cp, cp); }
    var vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
      var w0 = d2 / (d2 - d6), q1 = add(a, mul(ac, w0));
      out[0] = q1[0]; out[1] = q1[1]; out[2] = q1[2]; return dot(sub(p, q1), sub(p, q1));
    }
    var va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      var u0 = (d4 - d3) / ((d4 - d3) + (d5 - d6)), q2 = add(b, mul(sub(c, b), u0));
      out[0] = q2[0]; out[1] = q2[1]; out[2] = q2[2]; return dot(sub(p, q2), sub(p, q2));
    }
    var den = 1 / (va + vb + vc), vv = vb * den, ww = vc * den;
    var q3 = add(a, add(mul(ab, vv), mul(ac, ww)));
    out[0] = q3[0]; out[1] = q3[1]; out[2] = q3[2];
    return dot(sub(p, q3), sub(p, q3));
  }

  /* A stable axis in the plane perpendicular to n: take the world axis n is
     least aligned with and project it out. Deterministic, so a face carve
     with no natural edge direction still lands the same way every time. */
  function anyPerp(n) {
    var ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    var pick = (ax <= ay && ax <= az) ? [1, 0, 0] : ((ay <= az) ? [0, 1, 0] : [0, 0, 1]);
    return norm(sub(pick, mul(n, dot(pick, n))));
  }

  /* Sign a direction deterministically, so the same edge always yields the
     same tangent whichever of its two faces came first out of the cluster. */
  function canonicalDir(d) {
    var i;
    for (i = 0; i < 3; i++) {
      if (d[i] > 1e-6) return d;
      if (d[i] < -1e-6) return mul(d, -1);
    }
    return d;
  }

  function opts_dihedral(o) {
    var d = o && Number(o.dihedralDeg);
    return (isFinite(d) && d > 0 && d < 180) ? d : DIHEDRAL_DEG;
  }

  /* Union planes whose normals are within the dihedral threshold of each other,
     transitively, and give each group one area-weighted normal. A group's
     `point` and `best` keep the nearest of its members', so the reference point
     is still the closest real surface point in the feature. */
  function mergeToFeatures(cl, cosDihedral) {
    var n = cl.length, parent = [], i, j;
    for (i = 0; i < n; i++) parent.push(i);
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    for (i = 0; i < n; i++) {
      for (j = i + 1; j < n; j++) {
        if (dot(cl[i].n, cl[j].n) >= cosDihedral) {
          var ra = find(i), rb = find(j);
          if (ra !== rb) parent[ra] = rb;
        }
      }
    }
    var groups = {}, order = [];
    for (i = 0; i < n; i++) {
      var r = find(i);
      if (!groups[r]) { groups[r] = { sum: [0, 0, 0], area: 0, best: Infinity, point: null, planes: 0 }; order.push(r); }
      var g = groups[r];
      g.sum = add(g.sum, mul(cl[i].n, cl[i].area));
      g.area += cl[i].area;
      g.planes++;
      if (cl[i].best < g.best) { g.best = cl[i].best; g.point = cl[i].point; }
    }
    var out = [];
    for (i = 0; i < order.length; i++) {
      var gg = groups[order[i]];
      var nn = norm(gg.sum);
      if (!nn) continue;                  /* a group that averages to nothing is not a feature */
      out.push({ n: nn, area: gg.area, best: gg.best, point: gg.point, planes: gg.planes });
    }
    out.sort(function (p, q) {
      if (Math.abs(q.area - p.area) > 1e-9) return q.area - p.area;
      return (q.n[0] - p.n[0]) || (q.n[1] - p.n[1]) || (q.n[2] - p.n[2]);
    });
    return out;
  }

  /* hullSoup: world-space triangle soup. point: where the user aimed.
     radius: how far the blade reaches across the surface (blade.reach).
     opts.dihedralDeg overrides the feature threshold. */
  function probeTarget(hullSoup, point, radius, opts) {
    if (!hullSoup || !hullSoup.length || hullSoup.length % 9) {
      return { ok: false, reason: 'no hull geometry to carve' };
    }
    if (!(radius > 0)) return { ok: false, reason: 'blade reach must be positive' };

    var r2 = radius * radius, i;
    var clusters = [];              /* { n, area, best (sq dist), point } */
    /* `nearest` is the closest real surface point among the triangles the
       prefilter kept. Sound because it is only read once a cluster exists, and
       a cluster means a triangle within `radius` was kept - so the true nearest
       point is in that set. */
    var cp = [0, 0, 0], nearest = null, nearestD2 = Infinity;

    var px = point[0], py = point[1], pz = point[2];
    for (i = 0; i < hullSoup.length; i += 9) {
      /* Conservative AABB reject before the closest-point solve. A triangle
         whose bounding box is more than `radius` from the aim point on ANY axis
         cannot have a closest point within radius, so this never changes the
         answer - it only stops a ~40-operation solve running on every triangle
         of the piece. It matters because this is a tool for repeated clicks:
         fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl is 98,586
         triangles and a blade reaches a few mm of them. */
      var t0 = hullSoup[i], t1 = hullSoup[i + 1], t2 = hullSoup[i + 2];
      var t3 = hullSoup[i + 3], t4 = hullSoup[i + 4], t5 = hullSoup[i + 5];
      var t6 = hullSoup[i + 6], t7 = hullSoup[i + 7], t8 = hullSoup[i + 8];
      if (px < Math.min(t0, t3, t6) - radius || px > Math.max(t0, t3, t6) + radius) continue;
      if (py < Math.min(t1, t4, t7) - radius || py > Math.max(t1, t4, t7) + radius) continue;
      if (pz < Math.min(t2, t5, t8) - radius || pz > Math.max(t2, t5, t8) + radius) continue;
      var a = [t0, t1, t2];
      var b = [t3, t4, t5];
      var c = [t6, t7, t8];
      var d2 = closestOnTri(point, a, b, c, cp);
      if (d2 < nearestD2) { nearestD2 = d2; nearest = [cp[0], cp[1], cp[2]]; }
      if (d2 > r2) continue;
      var raw = cross(sub(b, a), sub(c, a));
      var area2 = len(raw);
      if (area2 <= EPS) continue;            /* degenerate triangle, no normal to read */
      var n = mul(raw, 1 / area2);
      var hit = null, k;
      for (k = 0; k < clusters.length; k++) {
        if (dot(clusters[k].n, n) >= COS_SAME) { hit = clusters[k]; break; }
      }
      if (hit) {
        hit.area += area2 / 2;
        if (d2 < hit.best) { hit.best = d2; hit.point = [cp[0], cp[1], cp[2]]; }
      } else {
        clusters.push({ n: n, area: area2 / 2, best: d2, point: [cp[0], cp[1], cp[2]] });
      }
    }

    if (!clusters.length) {
      return { ok: false, reason: 'nothing within ' + radius.toFixed(2) + ' mm of that point - aim at the piece' };
    }

    /* Biggest faces first, then by normal, so the result never depends on
       triangle order in the soup. */
    clusters.sort(function (p, q) {
      if (Math.abs(q.area - p.area) > 1e-9) return q.area - p.area;
      return (q.n[0] - p.n[0]) || (q.n[1] - p.n[1]) || (q.n[2] - p.n[2]);
    });

    var planes = clusters.length;
    clusters = mergeToFeatures(clusters, Math.cos(opts_dihedral(opts) * Math.PI / 180));
    var found = clusters.length;
    var use = clusters.slice(0, 3);
    var sum = [0, 0, 0], j;
    for (j = 0; j < use.length; j++) sum = add(sum, use[j].n);
    var outward = norm(sum);
    if (!outward) {
      /* opposing normals inside one blade reach: a wall or a fin thinner than
         the blade. There is no "out of the material" here, and guessing one
         would carve through from both sides. */
      return {
        ok: false,
        reason: 'the faces within ' + radius.toFixed(2) + ' mm point opposite ways - the wall is thinner than ' +
          'this blade. Use a smaller blade or aim away from the edge'
      };
    }

    var kind = (use.length === 1) ? 'face' : (use.length === 2 ? 'edge' : 'corner');

    /* The blade's sweep axis. At an edge that is the edge itself, which is why
       a V-groove aimed at an edge chamfers it with no rotation asked for. */
    var tangent;
    if (use.length >= 2) {
      tangent = norm(cross(use[0].n, use[1].n));
      if (tangent) tangent = canonicalDir(tangent);
    }
    if (!tangent) tangent = anyPerp(outward);
    /* orthonormalise against outward - two clustered normals need not be
       exactly perpendicular on a faceted surface */
    tangent = norm(sub(tangent, mul(outward, dot(tangent, outward)))) || anyPerp(outward);

    /* The reference point: the closest surface point among the faces in play,
       so a click near an edge snaps onto the feature rather than hovering. */
    var refPoint = use[0].point, refD2 = use[0].best;
    for (j = 1; j < use.length; j++) if (use[j].best < refD2) { refD2 = use[j].best; refPoint = use[j].point; }
    if (use.length > 1) {
      /* At a real edge or corner the feature IS the intersection of the planes
         in play, and that is where the blade should sit. But a plane meet is
         only on the surface when the planes really are the piece's faces: for
         tangent planes of a convex curve it is a point out in the air, and a
         blade placed there cuts nothing. The dihedral merge above stops most of
         that; this bounds what is left. The meet has to land within the blade's
         own reach of a real surface point, or it is not this feature and the
         nearest surface point is used instead. */
      var meet = intersectPlanes(use, refPoint);
      if (meet && nearest && len(sub(meet, nearest)) <= radius) refPoint = meet;
    }

    return {
      ok: true,
      kind: kind,
      facesFound: found,
      facesUsed: use.length,
      planesFound: planes,
      normals: use.map(function (c) { return c.n.slice(); }),
      areas: use.map(function (c) { return c.area; }),
      outward: outward,
      tangent: tangent,
      point: refPoint,
      surfacePoint: nearest,
      offSurface: Math.sqrt(nearestD2),
      radius: radius
    };
  }

  /* Where the faces in play meet, nearest to `near`.
     Two planes meet in a line: take the point on it closest to `near`.
     Three meet in a point: solve the 3x3. Returns null if degenerate. */
  function intersectPlanes(use, near) {
    var n0 = use[0].n, p0 = use[0].point, d0 = dot(n0, p0);
    var n1 = use[1].n, d1 = dot(n1, use[1].point);
    if (use.length === 2) {
      var dir = cross(n0, n1);
      var L2 = dot(dir, dir);
      if (L2 < 1e-10) return null;          /* the two planes are parallel */
      /* the point on the line closest to the origin, in the plane the two
         normals span: P = ((d0 - d1*c) n0 + (d1 - d0*c) n1) / (1 - c^2) */
      var c01 = dot(n0, n1), den = 1 - c01 * c01;
      if (Math.abs(den) < 1e-10) return null;
      var base = mul(add(mul(n0, (d0 - d1 * c01)), mul(n1, (d1 - d0 * c01))), 1 / den);
      /* then slide along the line to the point nearest `near` */
      var t = dot(sub(near, base), dir) / L2;
      return add(base, mul(dir, t));
    }
    var n2 = use[2].n, d2 = dot(n2, use[2].point);
    var det = dot(n0, cross(n1, n2));
    if (Math.abs(det) < 1e-8) return null;
    return mul(add(add(mul(cross(n1, n2), d0), mul(cross(n2, n0), d1)), mul(cross(n0, n1), d2)), 1 / det);
  }

  /* ============================================================
     3. THE PLACEMENT  (Task 3, second half)

     Blade-local -> world, as a 4x4 in THREE's column-major `elements` order so
     app-carve.js can hand it straight to Matrix4.fromArray with no reshuffling.

     Columns are [X, Y, Z, origin]: Y is the outward bisector, Z the sweep axis
     (rolled by `roll` about Y), X = Y x Z, which makes the basis orthonormal
     and right-handed by construction. The origin is the blade's tip, put
     `depth` mm inside the surface along -Y.

     Because it is a pure rotation plus a translation, local mm are world mm on
     every axis - which matters downstream: buildCutVolume divides its measured
     world depth by the basis length to get back into local units, and a scale
     here would quietly change the safety box.
     ============================================================ */
  function placeBlade(probe, opts) {
    opts = opts || {};
    if (!probe || !probe.ok) return { ok: false, reason: (probe && probe.reason) || 'no target' };
    var depth = Number(opts.depth);
    if (!isFinite(depth) || depth <= 0) return { ok: false, reason: 'depth must be a positive number of mm' };
    var height = Number(opts.height);
    if (!isFinite(height) || height <= 0) return { ok: false, reason: 'blade height missing' };
    if (depth >= height) {
      return {
        ok: false,
        reason: 'depth ' + depth + ' mm needs a blade taller than ' + height +
          ' mm - the shank must stay outside the piece'
      };
    }
    var roll = (opts.roll === undefined) ? 0 : Number(opts.roll);
    if (!isFinite(roll)) return { ok: false, reason: 'roll must be a number of degrees' };

    var Y = probe.outward;
    var Z = probe.tangent;
    if (roll) {
      var a = roll * Math.PI / 180;
      var Xt = cross(Y, Z);
      Z = norm(add(mul(Z, Math.cos(a)), mul(Xt, Math.sin(a)))) || Z;
    }
    var X = norm(cross(Y, Z));
    if (!X) return { ok: false, reason: 'degenerate blade frame - outward and sweep axis are parallel' };
    Z = cross(X, Y);   /* re-derive, so the basis is exactly orthonormal */

    var origin = sub(probe.point, mul(Y, depth));

    return {
      ok: true,
      /* THREE.Matrix4 column-major elements */
      matrix: [X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, Z[0], Z[1], Z[2], 0, origin[0], origin[1], origin[2], 1],
      basis: { x: X, y: Y, z: Z },
      origin: origin,
      outward: Y,
      punch: mul(Y, -1),
      depth: depth,
      roll: roll,
      kind: probe.kind
    };
  }

  /* blade-local soup -> world soup, through a column-major 4x4 */
  function transformSoup(soup, m) {
    var out = new Float32Array(soup.length), i;
    for (i = 0; i < soup.length; i += 3) {
      var x = soup[i], y = soup[i + 1], z = soup[i + 2];
      out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
      out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    }
    return out;
  }

  /* ============================================================
     4. ONE CALL: hull + aim + blade -> everything the kernel needs

     The returned `frame` is plain data in exactly the shape
     NSO_CSG.buildCutVolume reads - axis/sign/box/capCoord/span plus the
     matrix - so app-carve.js only has to lift matrix and box into THREE
     types. Nothing in app-join.js changes.
     ============================================================ */
  function plan(hullSoup, point, bladeName, params, opts) {
    opts = opts || {};
    var blade = buildBlade(bladeName, params);
    if (!blade.ok) return blade;

    var radius = (opts.radius !== undefined && isFinite(Number(opts.radius)) && Number(opts.radius) > 0)
      ? Number(opts.radius) : blade.reach;
    var probe = probeTarget(hullSoup, point, radius, opts);
    if (!probe.ok) return { ok: false, reason: probe.reason, blade: blade };

    var placed = placeBlade(probe, { depth: opts.depth, roll: opts.roll, height: blade.height });
    if (!placed.ok) return { ok: false, reason: placed.reason, blade: blade, probe: probe };

    var span = Math.max(
      blade.box.max[0] - blade.box.min[0],
      blade.box.max[1] - blade.box.min[1],
      blade.box.max[2] - blade.box.min[2]
    );

    return {
      ok: true,
      blade: blade,
      probe: probe,
      placed: placed,
      worldSoup: transformSoup(blade.soup, placed.matrix),
      /* the plug frame, as data. axis/sign are fixed by the blade-local
         convention (+Y is out), which is the whole trick: every free
         orientation is carried by `matrix` alone. */
      frame: {
        matrix: placed.matrix,
        box: blade.box,
        axis: 1,
        sign: 1,
        outerNormal: placed.outward,
        punch: placed.punch,
        capCoord: blade.height,
        span: span
      }
    };
  }

  /* ============================================================
     5. THE STATUS LINE

     Honest about the one thing this tool does not guard. minWall is measured
     along frame.punch only (docs/LOCAL-CARVE.md §3c: a corner bite took all
     48.000 of 48.000 mm^3 through a 2 mm wall on fixtures/box_open.stl with
     minWall 1.0, and the result still gated clean). At an edge or a corner two
     or three faces are in play and only one direction was measured, so the
     line says so - every time, not only when it went wrong.
     ============================================================ */
  function carveReport(planned, removed, intended) {
    if (!planned || !planned.ok) return 'Carve failed - ' + ((planned && planned.reason) || 'unknown');
    var p = planned.probe, b = planned.blade, pl = planned.placed;
    var s = 'Carved ' + p.kind + ' - ' + b.describe + ', depth ' + pl.depth + ' mm';
    if (pl.roll) s += ', roll ' + pl.roll + '°';
    if (isFinite(removed)) s += ' - ' + removed.toFixed(3) + ' mm³ removed';
    if (isFinite(removed) && isFinite(intended) && intended - removed > 1e-3) {
      s += ' (held back ' + (intended - removed).toFixed(3) + ' mm³ to keep the wall)';
    }
    if (p.facesUsed > 1) {
      s += ' - wall checked along the cut axis only, ' + p.facesUsed + ' faces in play';
    }
    if (p.facesFound > p.facesUsed) {
      s += ' - ' + p.facesFound + ' faces within reach, used the largest ' + p.facesUsed;
    }
    return s;
  }

  /* ============================================================
     6. THE STROKE - press, drag, release = one continuous groove

     A click punches the blade in once (plan(), above). A drag sweeps it. The
     groove is the blade dragged along the stroke, and it is built so that
     NOTHING about the stroke's shape can make the sweep fail:

       - the stroke is smoothed a little (a hand and a pixel grid are not a
         line), then simplified to the fewest straight segments that stay
         within STROKE_RDP_MM of it. It is never coarsened to fit the tool;
       - each segment is a straight PRISM: the blade's section (its silhouette
         seen down its own sweep axis - the rectangle of the slab, the triangle
         of the wedge, the U of the ball-nose) extruded along the segment. A
         prism is a valid closed solid at any length, however short and
         however the stroke turns beside it;
       - each vertex between two segments gets a JOINT: the same section
         revolved about the vertex's outward axis (for the ball-nose that is
         the blade itself, a ball). It fills the wedge the two prisms leave on
         the outside of a turn with a round join, at ANY turn and any curve
         radius - a U tighter than the blade is wide, a hairpin, a spiral;
       - and the blade itself stands at the press and at the release, which
         is what gives a ball-nose groove its round ends and a slab or a wedge
         its own length of overrun, because that is where the blade was.
     The app unions them in the kernel and subtracts: a sweep with round joins
     is exactly the union of its parts, and a union has no failure mode that a
     path has (the old mitred NSO_PathSweep refused a turn tighter than the
     blade, and the retry that gave it a coarser path is what made U's into
     V's and S's into backwards Z's).

     The blade FOLLOWS THE SURFACE. Each segment's outward axis is the mean of
     the surface normals at its two ends, each joint's the normal at its
     vertex - so a groove drawn across a sphere or a cylinder lies in the
     surface instead of cutting a chord through it. (One orientation for the
     whole stroke, with the surface allowed to turn 25 degrees from it, is why
     a long curved line on a curved face used to be refused.) What is still
     refused is a stroke that crosses an EDGE: two neighbouring samples whose
     normals differ by more than STROKE_EDGE_DEG are on different faces, and a
     groove that bends round a box edge is two strokes, not one.

     The prisms and joints of a straight stroke are exactly what the old sweep
     was: section area x length, one segment, the end blades the same.
     ============================================================ */
  var STROKE_EDGE_DEG = 35;            /* neighbouring samples further apart than this are on two faces */
  var STROKE_RDP_MM = 0.03;            /* how far the simplified line may stray from the smoothed one */
  var STROKE_MAX_SEGS = 400;           /* the cost cap: the tolerance grows until the line fits in this many */
  var STROKE_JOINT_SEG = 32;           /* facets round a joint */
  var STROKE_JOINT_MIN_DEG = 0.25;     /* a vertex that turns less than this needs no joint */
  var STROKE_MAX_SAMPLES = 1500;       /* resampling density cap along a long stroke */
  var STROKE_STATION_MM = 0.5;         /* wall-gate stations along the stroke */
  var LOFT_MAX_TURN = 120 * Math.PI / 180;   /* a miter stretches the section by 1/cos(turn/2): 2x at this */
  var GROOVE_ABOVE_MM = 1;             /* how far above the surface the groove solid reaches (the blade's shank is taller, and needs
                                          to be wider than a bend can fit, for nothing the cut touches) */
  var STROKE_DEV_MM = 0.15;            /* how far smoothing a shaky line harder may move it from the gently smoothed one */
  var STROKE_SMOOTH_STEPS = [1, 1.7, 2.9, 4.9, 8.4];   /* the window, in multiples of the gentle one, tried in turn */
  var LOFT_MIN_ADVANCE = 1e-4;         /* a rail must move this far forward along its segment (mm) */

  /* The blade's section seen down its sweep axis, in blade-local (x, y):
     CCW, tip at y = 0, shank end at y = height - the same numbers build()
     uses, so the swept groove and the end blades cannot disagree. */
  function grooveSection(name, over) {
    var blade = buildBlade(name, over);
    if (!blade.ok) return blade;
    var p = blade.params, poly, hw;
    if (name === 'flat') {
      hw = p.width / 2;
      poly = [[-hw, 0], [hw, 0], [hw, p.height], [-hw, p.height]];
    } else if (name === 'vee') {
      hw = p.height * Math.tan(p.angle * Math.PI / 360);
      poly = [[0, 0], [hw, p.height], [-hw, p.height]];
    } else {
      var r = p.radius, nr = Math.max(2, p.rings | 0), k, right = [];
      for (k = 1; k <= nr; k++) {
        var phi = (k / nr) * (Math.PI / 2);
        right.push([r * Math.sin(phi), r - r * Math.cos(phi)]);
      }
      hw = r;
      poly = [[0, 0]].concat(right, [[r, p.height], [-r, p.height]],
        right.slice().reverse().map(function (q) { return [-q[0], q[1]]; }));
    }
    /* outward normal at each vertex: the mean of its two edges' (dy, -dx) */
    var n = poly.length, normals = [], i;
    for (i = 0; i < n; i++) {
      var a = poly[(i + n - 1) % n], b = poly[i], c = poly[(i + 1) % n];
      var e1 = [b[1] - a[1], -(b[0] - a[0])], e2 = [c[1] - b[1], -(c[0] - b[0])];
      var l1 = Math.hypot(e1[0], e1[1]), l2 = Math.hypot(e2[0], e2[1]);
      var m = [e1[0] / l1 + e2[0] / l2, e1[1] / l1 + e2[1] / l2], lm = Math.hypot(m[0], m[1]);
      normals.push([m[0] / lm, m[1] / lm]);
    }
    return { ok: true, blade: blade, profile: poly, normals: normals, halfWidth: hw, height: blade.height };
  }

  /* The stroke as the planner reads it, in four steps - every one of them
     keeps the line the user drew and only takes the noise out of it.

       1. resample at an even spacing along the drag, positions and normals
          together, so the next step's window means the same millimetres
          everywhere and a fast drag (few samples) is no different from a slow
          one (many);
       2. smooth: a moving average over a few tenths of a millimetre, twice,
          with the window tapering to nothing at both ends so the press and the
          release stay exactly where they were. A hand-held mouse over a pixel
          grid draws a staircase; this is what turns it back into a curve. The
          window is a fraction of the blade's half-width (a tool cannot cut
          what is finer than itself) and is capped at 1 mm, which on a 3 mm
          radius curve moves the line by under 0.06 mm;
       3. simplify (Ramer-Douglas-Peucker) to within STROKE_RDP_MM: a straight
          drag is one segment, a curve as few as hold the tolerance;
       4. the normals, smoothed with the positions, are the blade's outward
          axis along the line. */
  function resample(pts, ns, h) {
    var cum = [0], i;
    for (i = 1; i < pts.length; i++) cum.push(cum[i - 1] + len(sub(pts[i], pts[i - 1])));
    var L = cum[cum.length - 1], n = Math.max(1, Math.ceil(L / h)), P = [], N = [], j = 0, k;
    for (k = 0; k <= n; k++) {
      var d = (k === n) ? L : L * k / n;
      while (j < pts.length - 2 && cum[j + 1] < d) j++;
      var seg = cum[j + 1] - cum[j], t = seg > EPS ? (d - cum[j]) / seg : 0;
      t = Math.max(0, Math.min(1, t));
      P.push(add(pts[j], mul(sub(pts[j + 1], pts[j]), t)));
      var nn = norm(add(mul(ns[j], 1 - t), mul(ns[j + 1], t)));
      N.push(nn || ns[j]);
    }
    return { P: P, N: N, length: L, step: L / n };
  }

  /* One box-filter pass over positions and normals, window k samples each
     side. Past either end the line is continued by reflecting it through the
     end point (the normals by mirroring them), which leaves the first and last
     point exactly where they were AND smooths the stretch beside them - the
     press and the release are where a hand is least steady, and they are what
     the end blades take their direction from. */
  function boxPass(P, N, k) {
    var n = P.length, outP = [], outN = [], i, j;
    k = Math.max(0, Math.min(k, n - 1));
    for (i = 0; i < n; i++) {
      var sp = [0, 0, 0], sn = [0, 0, 0];
      for (j = i - k; j <= i + k; j++) {
        var p, q;
        if (j < 0) { p = sub(mul(P[0], 2), P[-j]); q = N[-j]; }
        else if (j > n - 1) { p = sub(mul(P[n - 1], 2), P[2 * (n - 1) - j]); q = N[2 * (n - 1) - j]; }
        else { p = P[j]; q = N[j]; }
        sp = add(sp, p); sn = add(sn, q);
      }
      outP.push(mul(sp, 1 / (2 * k + 1)));
      outN.push(norm(sn) || N[i]);
    }
    return { P: outP, N: outN };
  }

  /* RDP on the points but remembering which survive, so the normals can be
     read at the same indices. */
  function rdpIndices(pts, tol) {
    var keepIdx = [], keep = new Uint8Array(pts.length), stack = [[0, pts.length - 1]], i;
    keep[0] = keep[pts.length - 1] = 1;
    while (stack.length) {
      var se = stack.pop(), s0 = se[0], e0 = se[1];
      var d = sub(pts[e0], pts[s0]), L = len(d), worst = -1, at = -1;
      for (i = s0 + 1; i < e0; i++) {
        var w = sub(pts[i], pts[s0]);
        var dist = (L > EPS) ? len(cross(w, d)) / L : len(w);
        if (dist > worst) { worst = dist; at = i; }
      }
      if (worst > tol && at > 0) { keep[at] = 1; stack.push([s0, at], [at, e0]); }
    }
    for (i = 0; i < pts.length; i++) if (keep[i]) keepIdx.push(i);
    return keepIdx;
  }

  /* A slab or a wedge points the way its first and last segments do, so those
     two must be long enough to say where the stroke is heading: drop the
     vertices closer than `reach` to either end (the line keeps its ends). A
     ball-nose has no heading and asks for none. */
  function trimEnds(idx, P, reach) {
    if (!(reach > 0) || idx.length < 3) return idx;
    var cum = [0], i;
    for (i = 1; i < P.length; i++) cum.push(cum[i - 1] + len(sub(P[i], P[i - 1])));
    var total = cum[cum.length - 1], out = [idx[0]];
    if (total <= 2 * reach) return [idx[0], idx[idx.length - 1]];
    for (i = 1; i < idx.length - 1; i++) {
      if (cum[idx[i]] >= reach && total - cum[idx[i]] >= reach) out.push(idx[i]);
    }
    out.push(idx[idx.length - 1]);
    return out;
  }

  /* samples [{ point, normal }] (world, off the drag) -> the stroke's surface
     line with the surface's outward normal at every vertex of it. */
  function strokePath(samples, opts) {
    opts = opts || {};
    var pts = [], ns = [], i;
    for (i = 0; i < (samples || []).length; i++) {
      var s = samples[i], p = s && s.point, nn = s && s.normal && norm(s.normal);
      if (!p || !isFinite(p[0]) || !isFinite(p[1]) || !isFinite(p[2]) || !nn) continue;
      if (pts.length && len(sub(p, pts[pts.length - 1])) < 1e-6) continue;
      pts.push([+p[0], +p[1], +p[2]]); ns.push(nn);
    }
    if (pts.length < 2) return { ok: false, reason: 'the stroke has fewer than two points on the piece' };

    /* An edge: two neighbouring samples on different faces. */
    var along = 0, maxStep = 0, stepAt = 0, stepOver = 0;
    for (i = 1; i < pts.length; i++) {
      var gap = len(sub(pts[i], pts[i - 1]));
      along += gap;
      var ang = Math.acos(Math.max(-1, Math.min(1, dot(ns[i], ns[i - 1])))) * 180 / Math.PI;
      if (ang > maxStep) { maxStep = ang; stepAt = along; stepOver = gap; }
    }
    if (maxStep > STROKE_EDGE_DEG) {
      return {
        ok: false, spreadDeg: maxStep,
        reason: 'the stroke crosses onto another face (the surface turns ' + maxStep.toFixed(0) + '° within ' +
          stepOver.toFixed(1) + ' mm at ' + stepAt.toFixed(1) + ' mm along; one stroke follows one smooth surface, ' +
          'up to ' + STROKE_EDGE_DEG + '° between neighbouring points) - let go before the edge and stroke the next face on its own'
      };
    }

    var raw = pts.length, total = along;
    var h = Math.max(0.1, total / STROKE_MAX_SAMPLES);
    var rs = resample(pts, ns, h);
    var hw = (opts.halfWidth > 0) ? opts.halfWidth : 1;
    var smoothMm = Math.min(1, Math.max(0.15, 0.2 * hw)) * ((opts.smooth > 0) ? opts.smooth : 1);
    var k = Math.round(smoothMm / rs.step);
    var P = rs.P, N = rs.N;
    if (k >= 1) {
      var a = boxPass(P, N, k), b = boxPass(a.P, a.N, k);
      P = b.P; N = b.N;
    }

    var tol = STROKE_RDP_MM, idx = rdpIndices(P, tol);
    while (idx.length - 1 > STROKE_MAX_SEGS) { tol *= 1.5; idx = rdpIndices(P, tol); }
    idx = trimEnds(idx, P, opts.endReach);
    var line = [], nrm = [], L = 0;
    for (i = 0; i < idx.length; i++) { line.push(P[idx[i]]); nrm.push(N[idx[i]]); }
    for (i = 1; i < line.length; i++) L += len(sub(line[i], line[i - 1]));

    var sum = [0, 0, 0], spread = 0;
    for (i = 0; i < nrm.length; i++) sum = add(sum, nrm[i]);
    var Y = norm(sum);
    if (!Y) return { ok: false, reason: 'the surface normals under the stroke cancel out - it crosses a thin edge' };
    for (i = 0; i < nrm.length; i++) {
      spread = Math.max(spread, Math.acos(Math.max(-1, Math.min(1, dot(nrm[i], Y)))) * 180 / Math.PI);
    }
    return { ok: true, surface: line, normals: nrm, outward: Y, length: L, spreadDeg: spread, raw: raw, tolerance: tol,
             smoothed: P, smoothMm: smoothMm };
  }

  /* the blade at a sweep end, in world, from that end's own frame vectors */
  function bladeAt(blade, X, Y, Z, origin) {
    var m = [X[0], X[1], X[2], 0, Y[0], Y[1], Y[2], 0, Z[0], Z[1], Z[2], 0, origin[0], origin[1], origin[2], 1];
    return { matrix: m, soup: transformSoup(blade.soup, m) };
  }

  /* The groove as ONE skin: the section placed in a ring at every vertex of
     the line, neighbouring rings joined by quads. Because a ring is shared by
     the segment before it and the segment after it, the skin is a single
     watertight solid with no two faces meeting at a glancing angle - which is
     what a union of separate prisms is full of at every gentle bend, and what
     the weld at the canonical checker's 1e-4 then collapses into open and
     non-manifold edges (measured: a flat shave along an S failed the gate with
     22 piercing triangles, a V-groove with 18 non-manifold edges).

     A ring at an interior vertex lies in the plane that bisects the two
     segments, with the section stretched sideways by 1/cos(turn/2): the miter,
     which keeps every wall of the groove the section's own width apart from
     the line on both sides of the bend. Its up axis is the surface normal AT
     that vertex, so the groove follows the surface.

     The skin is only a solid while the miter fits: on the inside of a bend
     tighter than the section is wide, a rail runs backwards ("the miter has
     eaten the segment") and the skin folds over itself. That is detected here,
     per rail and per segment, and the caller builds the groove from prisms and
     joints instead - correct at any curve, merely less tidy. */
  function loftStroke(V, NV, profile, depth) {
    var m = V.length - 1, n = profile.length, i, k;
    var U = [];
    for (i = 0; i < m; i++) {
      var uu = norm(sub(V[i + 1], V[i]));
      if (!uu) return { ok: false, reason: 'two points of the line coincide', at: i };
      U.push(uu);
    }
    var frames = [], rings = [];
    for (i = 0; i <= m; i++) {
      var t, scale = 1, turn = 0;
      if (i === 0) t = U[0];
      else if (i === m) t = U[m - 1];
      else {
        turn = Math.acos(Math.max(-1, Math.min(1, dot(U[i - 1], U[i]))));
        t = norm(add(U[i - 1], U[i]));
        if (!t || turn > LOFT_MAX_TURN) return { ok: false, reason: 'the line turns ' + (turn * 180 / Math.PI).toFixed(0) + '° at point ' + i, at: i };
        scale = 1 / Math.cos(turn / 2);
      }
      var Yq = norm(sub(NV[i], mul(t, dot(NV[i], t))));
      if (!Yq) return { ok: false, reason: 'the line runs straight into the surface at point ' + i, at: i };
      var Xq = norm(cross(Yq, t));
      var tip = sub(V[i], mul(Yq, depth));
      frames.push({ X: Xq, Y: Yq, t: t, tip: tip });
      var ring = [];
      for (k = 0; k < n; k++) ring.push(add(tip, add(mul(Xq, profile[k][0] * scale), mul(Yq, profile[k][1]))));
      rings.push(ring);
    }
    /* every rail must advance along its segment */
    for (i = 0; i < m; i++) {
      for (k = 0; k < n; k++) {
        if (dot(sub(rings[i + 1][k], rings[i][k]), U[i]) <= LOFT_MIN_ADVANCE) {
          return { ok: false, reason: 'the miter eats segment ' + i + ' on the groove\'s ' + (profile[k][0] < 0 ? 'left' : 'right') + ' wall', at: i };
        }
      }
    }
    var out = [];
    function tri(a, b, c) { out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }
    for (i = 0; i < m; i++) {
      for (k = 0; k < n; k++) {
        var k1 = (k + 1) % n, a0 = rings[i][k], b0 = rings[i][k1], b1 = rings[i + 1][k1], a1 = rings[i + 1][k];
        tri(a0, b0, b1); tri(a0, b1, a1);
      }
    }
    for (k = 1; k < n - 1; k++) {
      tri(rings[m][0], rings[m][k], rings[m][k + 1]);
      tri(rings[0][0], rings[0][k + 1], rings[0][k]);
    }
    return { ok: true, tris: Float32Array.from(out), frames: frames, rings: rings };
  }

  /* A convex polygon (CCW, [[x, y], ...]) cut off above y = yMax. */
  function clipProfile(poly, yMax) {
    var out = [], n = poly.length, i;
    for (i = 0; i < n; i++) {
      var a = poly[i], b = poly[(i + 1) % n], ain = a[1] <= yMax, bin = b[1] <= yMax;
      if (ain) out.push(a);
      if (ain !== bin) {
        var t = (yMax - a[1]) / (b[1] - a[1]);
        out.push([a[0] + t * (b[0] - a[0]), yMax]);
      }
    }
    /* a cut that lands on an existing vertex must not leave two of them */
    var clean = [];
    for (i = 0; i < out.length; i++) {
      var prev = clean.length ? clean[clean.length - 1] : null;
      if (prev && Math.hypot(out[i][0] - prev[0], out[i][1] - prev[1]) < 1e-9) continue;
      clean.push(out[i]);
    }
    while (clean.length > 1 && Math.hypot(clean[0][0] - clean[clean.length - 1][0], clean[0][1] - clean[clean.length - 1][1]) < 1e-9) clean.pop();
    return clean;
  }

  /* How wide the groove really is: the widest the section gets at or below the
     surface (y <= depth). A wedge 8 mm tall is 16 mm across its shank but
     1 mm either side of its path when it cuts 1 mm deep, and it is the
     second that the smoothing and the end headings are sized to. */
  function cutHalfWidth(profile, depth) {
    var n = profile.length, best = 0, i;
    for (i = 0; i < n; i++) {
      var a = profile[i], b = profile[(i + 1) % n];
      if (a[1] <= depth) best = Math.max(best, Math.abs(a[0]));
      if ((a[1] - depth) * (b[1] - depth) < 0) {
        var t = (depth - a[1]) / (b[1] - a[1]);
        best = Math.max(best, Math.abs(a[0] + t * (b[0] - a[0])));
      }
    }
    return best;
  }

  /* Which way the stroke is heading at one end, read over `reach` mm of it
     rather than over its first segment, which can be a fraction of a
     millimetre long and point anywhere a pixel's noise says. Forward along the
     stroke at both ends. */
  function endHeading(V, atStart, reach) {
    var m = V.length - 1, walked = 0, i, far;
    if (atStart) {
      far = V[m];
      for (i = 1; i <= m; i++) { walked += len(sub(V[i], V[i - 1])); if (walked >= reach) { far = V[i]; break; } }
      return norm(sub(far, V[0]));
    }
    far = V[0];
    for (i = m - 1; i >= 0; i--) { walked += len(sub(V[i + 1], V[i])); if (walked >= reach) { far = V[i]; break; } }
    return norm(sub(V[m], far));
  }

  /* The solid a joint is: the groove's section revolved about local Y, tip at
     the origin. The ball-nose's section IS a profile of revolution, so its
     joint is the blade; the slab's is the cylinder of its half-width and the
     wedge's the cone, each as tall as the blade. */
  function jointLocal(profile) {
    /* the right half of a profile that is symmetric about x = 0, bottom to top */
    var half = profile.filter(function (q) { return q[0] >= -1e-9; });
    half.sort(function (p, q) { return (p[1] - q[1]) || (q[0] - p[0]); });
    var rings = half.map(function (q) { return { y: q[1], rad: Math.max(0, q[0]) }; });
    var out = [];
    revolveY(rings, STROKE_JOINT_SEG, out);
    return Float32Array.from(out);
  }

  /* A polyline of surface points and normals -> the pieces a groove along it
     is made of: the frame of each segment (also what the wall gate stands its
     stations in), a prism per segment, a joint per bend, and the one-skin
     alternative. */
  function grooveParts(profile, V, NV, depth) {
    var m = V.length - 1, i, segs = [], prisms = [], sweeps = [];
    /* One frame per segment: u along it, the outward axis the mean of the
       surface normals at its two ends (made square to u), X = Y x u so that
       X x Y = u, the blade-local convention. The tip line runs `depth` below
       the surface along that axis. */
    for (i = 0; i < m; i++) {
      var A = V[i], B = V[i + 1], d = sub(B, A), L = len(d);
      var u = norm(d);
      var Yn = norm(add(NV[i], NV[i + 1])) || NV[i];
      var Ys = u ? norm(sub(Yn, mul(u, dot(Yn, u)))) : null;
      if (!u || !Ys) return { ok: false, reason: 'the stroke runs straight into the surface' };
      var X = norm(cross(Ys, u));
      var origin = sub(A, mul(Ys, depth));
      var mat = [X[0], X[1], X[2], 0, Ys[0], Ys[1], Ys[2], 0, u[0], u[1], u[2], 0, origin[0], origin[1], origin[2], 1];
      var local = [];
      extrudeZ(profile, 0, L, local);
      var tris = transformSoup(Float32Array.from(local), mat);
      segs.push({ A: A, B: B, u: u, len: L, X: X, Y: Ys, origin: origin });
      prisms.push(tris);
      sweeps.push({ tris: tris, segs: [{ u: u, len: L }], frames: [{ r: X, s: Ys }, { r: X, s: Ys }],
                    pts: [origin, add(origin, mul(u, L))] });
    }
    /* The joints, between consecutive segments, where the line turns. */
    var jointSoup = jointLocal(profile), joints = 0, jointPieces = [];
    for (i = 1; i < m; i++) {
      var s0 = segs[i - 1], s1 = segs[i];
      var turn = Math.acos(Math.max(-1, Math.min(1, dot(s0.u, s1.u)))) * 180 / Math.PI;
      if (turn < STROKE_JOINT_MIN_DEG) continue;
      var Yv = NV[i];
      var bis = norm(add(s0.u, s1.u)) || s1.u;
      var Xj = norm(cross(Yv, bis)) || anyPerp(Yv);
      var Zj = cross(Xj, Yv);
      var tip = sub(V[i], mul(Yv, depth));
      var mj = [Xj[0], Xj[1], Xj[2], 0, Yv[0], Yv[1], Yv[2], 0, Zj[0], Zj[1], Zj[2], 0, tip[0], tip[1], tip[2], 1];
      jointPieces.push(transformSoup(jointSoup, mj));
      joints++;
    }
    return { ok: true, segs: segs, prisms: prisms, sweeps: sweeps, jointPieces: jointPieces, joints: joints,
             loft: loftStroke(V, NV, profile, depth) };
  }

  /* hull + drag samples + blade -> every solid the groove is the union of,
     plus the stations the wall gate reads. THREE-free and kernel-free: the
     app unions `pieces` and subtracts. */
  function planStroke(hullSoup, samples, bladeName, params, opts) {
    opts = opts || {};
    var sec = grooveSection(bladeName, params);
    if (!sec.ok) return sec;
    var blade = sec.blade;
    var depth = Number(opts.depth);
    if (!isFinite(depth) || depth <= 0) return { ok: false, reason: 'depth must be a positive number of mm' };
    if (depth >= blade.height) {
      return { ok: false, reason: 'depth ' + depth + ' mm needs a blade taller than ' + blade.height +
        ' mm - the shank must stay outside the piece' };
    }

    var cutHW = cutHalfWidth(sec.profile, depth);
    var endReach = (bladeName === 'ball') ? 0 : Math.min(2, Math.max(0.8, 1.5 * cutHW));
    var cutProfile = clipProfile(sec.profile, depth + GROOVE_ABOVE_MM);

    /* The line is smoothed as gently as noise allows and no gentler. A hand
       over a pixel grid leaves a line of short, kinked segments, and a skin
       cannot turn through a kink shorter than the groove is wide; so if the
       gently smoothed line will not carry the skin, smooth it harder - but
       only while the harder line stays within STROKE_DEV_MM of the gentle one.
       Shake is that small and goes; a hairpin is not and stays, and is then
       built as the union that has no such limit. (What this replaces re-planned
       a refused line from fewer points, however far that moved it.) */
    var path = null, path0 = null, q;
    for (q = 0; q < STROKE_SMOOTH_STEPS.length; q++) {
      var cand = strokePath(samples, { halfWidth: cutHW, endReach: endReach, smooth: STROKE_SMOOTH_STEPS[q] });
      if (!cand.ok) return { ok: false, reason: cand.reason, blade: blade };
      if (q === 0) path0 = cand;
      else {
        var dev = 0, di;
        for (di = 0; di < cand.smoothed.length; di++) dev = Math.max(dev, len(sub(cand.smoothed[di], path0.smoothed[di])));
        if (dev > STROKE_DEV_MM) break;
      }
      if (cand.length < (opts.minLength || 0.2)) break;
      if (loftStroke(cand.surface, cand.normals, cutProfile, depth).ok) { path = cand; break; }
    }
    if (!path) path = path0;
    if (path.length < (opts.minLength || 0.2)) {
      return { ok: false, short: true, reason: 'the stroke is ' + path.length.toFixed(2) + ' mm - that is a click, not a groove', blade: blade };
    }

    var V = path.surface, NV = path.normals, m = V.length - 1, i, k;

    /* A slab or a wedge overruns each end of the stroke by half its length -
       that is where the blade was. That overrun is the same section extruded
       straight on, so it is made part of the groove (two collinear segments
       added to the line) rather than a blade unioned on: a union of the two
       puts the slab's walls coplanar with the groove's own, which the kernel
       resolves to slivers that fail the canonical weld. A ball-nose's end is a
       hemisphere, which the groove cannot be extended into, so it keeps its
       blade at each end - meeting the groove in a coincident ring. */
    var overrun = (bladeName === 'ball') ? 0 : blade.params.length / 2;
    var Vx = V, NVx = NV;
    if (overrun > 0 && m >= 1) {
      var uS = norm(sub(V[1], V[0])), uE = norm(sub(V[m], V[m - 1]));
      Vx = [sub(V[0], mul(uS, overrun))].concat(V, [add(V[m], mul(uE, overrun))]);
      NVx = [NV[0]].concat(NV, [NV[m]]);
    }

    var base = grooveParts(cutProfile, V, NV, depth);
    if (!base.ok) return { ok: false, reason: base.reason, blade: blade };
    var ext = (Vx === V) ? base : grooveParts(cutProfile, Vx, NVx, depth);
    if (!ext.ok) return { ok: false, reason: ext.reason, blade: blade };
    var segs = base.segs;

    /* The blade itself at the press and at the release: in the skin, standing
       in the skin's own end rings; in the union, pointing the way the stroke
       is heading over a blade's width of it (a ball-nose is the same from
       every side; a slab and a wedge are not). */
    var reach = Math.min(3, Math.max(1, 2 * cutHW)), sF = segs[0], sL = segs[segs.length - 1];
    function endFrame(at, atStart, seg) {
      var u = endHeading(V, atStart, reach) || seg.u;
      var Yn = NV[at];
      var Ys = norm(sub(Yn, mul(u, dot(Yn, u)))) || seg.Y;
      var X = norm(cross(Ys, u));
      return { u: u, Y: Ys, X: X, origin: sub(V[at], mul(Ys, depth)) };
    }
    var fF = endFrame(0, true, sF), fL = endFrame(m, false, sL);
    var endsUnion = [
      bladeAt(blade, fF.X, fF.Y, fF.u, fF.origin),
      bladeAt(blade, fL.X, fL.Y, fL.u, fL.origin)
    ];
    var asSoups = function (list) { return list.map(function (e) { return e.soup; }); };

    /* The groove, two ways. As ONE skin: watertight by construction, no
       glancing faces, the way to build any bend the section fits round. Or as
       a union of a prism per segment and a JOINT at every vertex that turns -
       the section revolved about the vertex's outward axis (for a ball-nose,
       the blade itself) - which has no limit on how tight a bend can be, at
       the price of the glancing faces. The skin is used when it is a solid;
       the union is kept beside it either way (`piecesAlt`) for the app to
       fall back on if the kernel finds the skin wanting. */
    var ends = endsUnion, mode = 'union', alt = null, sweeps = base.sweeps;
    var piecesUnion = ext.prisms.concat(ext.jointPieces, overrun > 0 ? [] : asSoups(endsUnion));
    var outPieces = piecesUnion;
    if (ext.loft.ok && base.loft.ok) {
      var g0 = base.loft.frames[0], gm = base.loft.frames[m];
      ends = [bladeAt(blade, g0.X, g0.Y, g0.t, g0.tip), bladeAt(blade, gm.X, gm.Y, gm.t, gm.tip)];
      outPieces = [ext.loft.tris].concat(overrun > 0 ? [] : asSoups(ends));
      alt = piecesUnion;
      mode = 'skin';
      sweeps = [{ tris: base.loft.tris, segs: segs.map(function (g) { return { u: g.u, len: g.len }; }),
                  frames: base.loft.frames.map(function (g) { return { r: g.X, s: g.Y }; }),
                  pts: base.loft.frames.map(function (g) { return g.tip; }) }];
    }
    var joints = ext.joints;

    /* Stations for the wall gate: every STROKE_STATION_MM along each segment,
       the tip line point plus that segment's frame. */
    var stations = [], along = 0, si;
    for (si = 0; si < segs.length; si++) {
      var sg = segs[si];
      var nst = Math.max(1, Math.ceil(sg.len / STROKE_STATION_MM));
      for (k = 0; k <= nst; k++) {
        if (k === 0 && stations.length) continue;
        stations.push({ tip: add(sg.origin, mul(sg.u, sg.len * k / nst)), X: sg.X, Y: sg.Y,
                        u: sg.u, along: along + sg.len * k / nst });
      }
      along += sg.len;
    }

    return {
      ok: true, blade: blade, section: sec, depth: depth, lift: 0, cutHalfWidth: cutHW, cutProfile: cutProfile,
      outward: path.outward, surface: path.surface, normals: path.normals, length: path.length,
      runs: 1, segments: segs.length, joints: joints, mode: mode, skinReason: mode === 'skin' ? '' : (ext.loft.reason || base.loft.reason || ''),
      sweeps: sweeps, ends: ends, pieces: outPieces, piecesAlt: alt,
      stations: stations, spreadDeg: path.spreadDeg, tolerance: path.tolerance
    };
  }

  /* Does the ray (o, d) meet the surface at distance t at a glancing angle -
     the face it hits within SKIN_GRAZE of edge-on? Needs the probe to name the
     face; without that it is never taken as a graze, so a wall is never
     missed for want of an answer. */
  var SKIN_GRAZE = 0.5;                /* |cos| of the angle between the ray and the face's normal below which it grazes */
  function grazesSkin(P, o, d, t) {
    if (!P || typeof P.nearest !== 'function' || typeof P.faceNormal !== 'function') return false;
    var near = P.nearest(add(o, mul(d, t)), 0.25);
    if (!near || near.face == null) return false;
    var N = P.faceNormal(near.face);
    return !!N && Math.abs(dot(N, d)) < SKIN_GRAZE;
  }

  /* The wall gate for a groove. A groove is refused - in words, before the
     kernel runs - if anywhere along it it would leave less than `floor` of
     wall: two nozzle widths unless told otherwise.

     Two questions per station, both on the piece as it is now:
       1. the canonical one, NSO_Thickness's strokeGate at the tip line - how
          thick is the wall under the deepest point of the blade, and what does
          a cut this deep leave of it;
       2. the groove's own sides. From every vertex of the section that lies
          inside the material, look straight out of the groove along the
          section's own outward normal: the first surface met is the wall the
          groove leaves on that side. A slab run along a box's edge severs the
          side wall, not the floor, and only this question sees it.
     `P` is NSO_Thickness.prepare(hullSoup). */
  function strokeWallGate(P, planned, opts) {
    opts = opts || {};
    var nozzle = (opts.nozzle > 0) ? opts.nozzle : 0.4;
    var floor = (opts.minWall > 0) ? opts.minWall : 2 * nozzle;
    var out = { ok: true, floor_mm: floor, nozzle_mm: nozzle, thinnest_mm: Infinity, at_mm: null, side: null,
                stations: 0, rays: 0, reason: '' };
    if (!P || !planned || !planned.ok) { out.reason = 'nothing measured'; return out; }
    var sec = planned.section, depth = planned.depth, i, j;
    var probe = depth + floor + 1;
    var round3 = function (v) { return Math.round(v * 1000) / 1000; };
    var floorWords = round3(floor) + ' mm floor (two ' + round3(nozzle) + ' mm nozzle widths)';
    /* Where to look out of the groove from: every vertex of the section that
       is inside the material (along its vertex normal) and the middle of
       every in-material stretch of edge (along the edge's own normal) - so a
       slab's flat side, whose two corners both sit at the tip, is still
       asked. The tip itself is question 1's. */
    var probes = [], prof = sec.profile, np = prof.length;
    for (j = 0; j < np; j++) {
      var A = prof[j], Bq = prof[(j + 1) % np];
      if (A[1] < depth - 1e-6 && !(Math.abs(A[0]) < 1e-9 && A[1] < 1e-9 && P.strokeGate)) {
        probes.push({ at: A, n: sec.normals[j] });
      }
      if (A[1] >= depth && Bq[1] >= depth) continue;
      var lo = A, hi = Bq;
      var clip = function (a, b) { var t = (depth - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), depth]; };
      if (A[1] > depth) lo = clip(Bq, A);
      if (Bq[1] > depth) hi = clip(A, Bq);
      var ex = hi[0] - lo[0], ey = hi[1] - lo[1], el = Math.hypot(ex, ey);
      if (el < 1e-6) continue;
      probes.push({ at: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2], n: [ey / el, -ex / el] });
    }
    for (i = 0; i < planned.stations.length; i++) {
      var st = planned.stations[i];
      var surf = add(st.tip, mul(st.Y, depth));
      out.stations++;
      if (P.strokeGate) {
        var g = P.strokeGate({ point: surf, normal: st.Y, depth: depth, minWall: floor, nozzle: nozzle, label: 'carve' });
        if (g && g.measured) {
          if (g.residual_mm < out.thinnest_mm) { out.thinnest_mm = g.residual_mm; out.at_mm = st.along; out.side = 'floor'; }
          if (!g.ok) {
            out.ok = false;
            out.reason = g.reason + ', ' + st.along.toFixed(1) + ' mm along the stroke';
            out.gate = g;
            return out;
          }
        }
      }
      if (!P.hitsAlong) continue;
      var stMin = Infinity;
      for (j = 0; j < probes.length; j++) {
        var q = probes[j].at, nq = probes[j].n;
        var o = add(st.tip, add(mul(st.X, q[0]), mul(st.Y, q[1])));
        var d = add(mul(st.X, nq[0]), mul(st.Y, nq[1]));
        var hits = P.hitsAlong(o, d, probe);
        out.rays++;
        if (!hits || !hits.length) continue;
        var tmin = (typeof hits[0] === 'number') ? hits[0] : hits[0].t;
        /* Looking sideways from just under the lip of a groove cut into a
           CURVED face, the ray leaves through that same face a hair away, the
           surface having fallen away beneath it. That is the groove's own
           mouth, not a wall left standing: a wall is a face the ray meets
           square on, and the skin it grazes is not. */
        if (grazesSkin(P, o, d, tmin)) continue;
        if (tmin < stMin) stMin = tmin;
        if (tmin < out.thinnest_mm) { out.thinnest_mm = tmin; out.at_mm = st.along; out.side = 'side'; }
      }
      /* the thinnest wall at this station, not the first ray under the floor */
      if (stMin < floor - 1e-4) {
        out.ok = false;
        out.reason = 'the groove\'s side would leave ' + round3(stMin) + ' mm of wall ' + st.along.toFixed(1) +
          ' mm along the stroke, under the ' + floorWords;
        return out;
      }
    }
    if (out.ok && out.reason === '') {
      out.reason = isFinite(out.thinnest_mm)
        ? 'thinnest wall left ' + round3(out.thinnest_mm) + ' mm, floor ' + round3(floor) + ' mm'
        : 'no surface within ' + round3(probe) + ' mm of the groove, every wall it leaves is thicker';
    }
    return out;
  }

  /* The ONE wording for a refused groove, built on strokeRefusal's lead so a
     punch, a brush and a groove say "Thicken first" the same way. */
  function strokeRefusalText(gate, nozzle) {
    if (!gate || gate.ok) return '';
    var r = gate.reason;
    if (gate.gate && gate.side !== 'side') {
      r = r.replace(/floor for a ([\d.]+) mm nozzle/, 'floor (two $1 mm nozzle widths)');
    }
    return 'Carve refused - wall too thin here, Thicken first: ' + r + ' - piece unchanged';
  }

  function strokeReport(planned, removed, intended) {
    if (!planned || !planned.ok) return 'Carve failed - ' + ((planned && planned.reason) || 'unknown');
    var s = 'Carved a ' + planned.length.toFixed(1) + ' mm groove - ' + planned.blade.describe +
      ', depth ' + planned.depth + ' mm, ' + planned.segments + ' segment' + (planned.segments === 1 ? '' : 's');
    if (isFinite(removed)) s += ' - ' + removed.toFixed(3) + ' mm³ removed';
    if (isFinite(removed) && isFinite(intended) && Math.abs(intended - removed) > 1e-3) {
      s += ' (' + intended.toFixed(3) + ' mm³ planned)';
    }
    return s;
  }

  var api = {
    BLADES: BLADES,
    withDefaults: withDefaults,
    validate: validate,
    buildBlade: buildBlade,
    probeTarget: probeTarget,
    placeBlade: placeBlade,
    transformSoup: transformSoup,
    plan: plan,
    carveReport: carveReport,
    grooveSection: grooveSection,
    strokePath: strokePath,
    planStroke: planStroke,
    strokeWallGate: strokeWallGate,
    strokeRefusalText: strokeRefusalText,
    strokeReport: strokeReport,
    STROKE_EDGE_DEG: STROKE_EDGE_DEG,
    /* exposed for the tests, not for callers */
    _closestOnTri: closestOnTri,
    _extrudeZ: extrudeZ,
    _revolveY: revolveY
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_Carve = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
