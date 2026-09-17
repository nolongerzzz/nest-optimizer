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
    /* exposed for the tests, not for callers */
    _closestOnTri: closestOnTri,
    _extrudeZ: extrudeZ,
    _revolveY: revolveY
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_Carve = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
