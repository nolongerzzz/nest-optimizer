/* ============================================================
   nso_support_aim.js - overhang detection, and a straight-line support
   aimed from the nearest viable base to the point that needs it.

   Loads as a classic script (window.NSO_SupportAim) and as a Node module
   (require('../nso_support_aim.js')). No DOM, no THREE, no wasm: a mesh is
   the app's raw soup - a Float32Array/Array of 9 numbers per triangle, Z up,
   millimetres - which is the convention Cut, Soften, Extend and Carve all
   already speak.

   ---------------------------------------------------------------------------
   TWO CAPABILITIES, ONE FILE
   ---------------------------------------------------------------------------
   1. FIND the places a piece needs support: downward-facing surface steeper
      than the printable angle, with nothing underneath it to land on.
   2. AIM one straight support at such a place, from the nearest base that can
      actually see it, and GROW it until it touches.

   They are separate entry points (detectOverhangs / aim) because they answer
   separate questions, and plan() is the two of them wired together for the
   common case.

   ---------------------------------------------------------------------------
   WHAT IS REUSED, AND DELIBERATELY NOT REWRITTEN
   ---------------------------------------------------------------------------
   - NSO_extendRaw (app-extend.js) does ALL the growing. A support is built as
     a short prism along its own local +Z and then stretched to length by
     Extend, which holds the cross-section bit for bit and gates that promise
     coordinate by coordinate on every run. Nothing here reimplements a
     stretch, and nothing here is allowed to move a support's cross-section:
     that is the number the wall-thickness floor was checked against, so a
     growth step that could change it would invalidate the check that came
     before it. Extend refuses an off-cardinal axis on purpose (see its header,
     "OUT OF SCOPE 5"), which is exactly why the strut is grown in its OWN
     local frame, with the axis forced to z, and only then turned to face the
     target. The aim never reaches Extend's arithmetic.

   - NSO_Thickness.floorFor (nso_thickness.js) is the ONLY source of the
     wall-thickness / nozzle-safety floor. It is not re-derived, not defaulted
     to a literal, and not silently skipped when the module is absent: a
     support whose floor cannot be established is refused by name. A strut
     thinner than one extrusion line is not a thin support, it is a support the
     slicer drops, and the print then fails in the one place it was told not
     to.

   - NSO_SeatSurface.quatFromTo / transformSoup (nso_seat_surface.js) do the
     turn and the bake. quatFromTo already settles the antiparallel case with a
     caller-supplied fallback axis rather than an arbitrary one, which a
     straight-down aim hits every time it points at -Z.

   ---------------------------------------------------------------------------
   A FREE ORIENTATION MUST BE BAKED, NOT POSED - the same finding, a third time
   ---------------------------------------------------------------------------
   Local-Carve found it for the blade and Seat-Against-Curved found it for the
   seated piece: the app's pose model is quantised Euler (90 deg yaw, 15 deg
   tilt/bank, no quaternion field, and none in snapshotPlacedPose), and
   buildCombinedGeometry rebuilds each piece's rotation from those fields
   rather than reading mesh.quaternion. A rotation written to the quaternion is
   visible in the scene and ABSENT from the export.

   A support aimed along a computed direction is a free orientation by
   definition - the direction comes out of the geometry, not out of a menu - so
   it cannot be posed. place() therefore BAKES the turn into the strut's own
   triangles and hands the matrix back as DATA. The strut that comes out of
   plan() is already pointing where it should; its caller sets no rotation at
   all. That is the same contained-pose-state decision the other two made,
   reached from the same constraint, and it is why what this module returns can
   be put through the canonical checker as it stands.

   ---------------------------------------------------------------------------
   OUT OF SCOPE, named so the next ticket does not have to re-derive it
   ---------------------------------------------------------------------------
   1. CURVING / BRANCHING ORGANIC PATHS. Multi-segment, spline-routed tree
      supports of the kind Bambu Studio grows - a trunk that splits, branches
      that merge, a path that bends around the piece instead of stopping at it.
      This module computes ONE straight direction from ONE base to ONE point
      and refuses when that line is blocked. It does not route around the
      obstruction, and it must not be extended to: a curved support cannot be
      grown by Extend at all (Extend refuses a curved axis by name, see its
      header, "OUT OF SCOPE 2"), so branching needs a different growth
      mechanism as well as a different path search. Both belong in the next
      ticket, together.

      LANDED ALONGSIDE THIS, and it closes half of that: nso_path_sweep.js
      (NSO_PathSweep) is a mitred polyline sweep - N oriented stations plus one
      convex profile into a watertight soup - built on Extend's own correctness
      argument carried round a corner. That is the growth mechanism a branching
      support needs, so the next ticket no longer has to invent one; it needs
      the PATH SEARCH (where to route, and around what) and the attachment,
      and it should call NSO_PathSweep rather than grow anything itself. Both
      modules are parked unwired, which is the right order: the primitive
      first, the routing that drives it second. See docs/CURVING-PATH.md.

      AND THE OTHER HALF LANDED LATER: nso_support_tree.js (NSO_SupportTree,
      docs/SUPPORT-TREE.md) is the routing and the attachment. It derives the
      contact points an overhang needs from the overhang's own geometry,
      computes where a trunk has to stop, calls aim() below for the trunk and
      NSO_PathSweep for every branch, and unions them with NSO_unionSoups. It
      still does not route around a blockage - a blocked branch is refused
      there too, by rail as well as by axis - and it builds ONE trunk. A field
      of trunks is still OUT OF SCOPE 3 below.

   2. SUPPORT INTERFACE / CONTACT GEOMETRY. The strut ends in its own flat
      cap. A breakaway tip, a contact layer, a tapered head that widens into
      the overhang - none of them are here. nso_seat_surface.js deferred the
      same layer for the same reason ("Deferred: contact geometry") and the two
      should be solved once, for both.

   3. SUPPORT DENSITY / LAYOUT. One region gets one strut, aimed at one point.
      How many struts a large overhang wants, and where they should sit
      relative to each other, is a layout question this file does not ask.
      HOW MANY is now answered by nso_support_tree.js, at a span measured off
      a real Bambu tree support. WHERE A FIELD OF TRUNKS SHOULD STAND is not:
      that module builds one trunk, and refuses by name - naming the count -
      when one is not enough.

   4. BRIDGING. A ceiling spanning two walls is flagged as an overhang here
      whenever nothing sits under it, because nothing sits under it. Whether
      the slicer could bridge it unsupported is a span-and-material judgement
      that no angle test can make. Callers that want it gate on region.spanMm
      themselves; detectOverhangs reports the span and takes no view.

   ---------------------------------------------------------------------------
   PAINT SCOPE: SUB-REGION - per docs/HANDOFF.md
   ---------------------------------------------------------------------------
   The standing rule is that a painted face stays untouched by ANY bake
   mechanism, and the scoping rule asks whether a feature acts on an
   identifiable sub-region. This one does: it names specific faces as needing
   support, and a support lands on those faces and nowhere else. So the check
   is scoped to the faces it actually flags, and paint elsewhere on the piece
   does not stand it down.

   opts.skipList is therefore a REQUIRED input, not an optional one with an
   unpainted default - unpainted is the value a caller gets by forgetting. Pass
   nsoMaskFaceList(m) straight through: this module reads the raw axis and side
   each click recorded and never re-derives which face was meant. A null from
   nsoMaskFaceList (a painted face with no axis to name) is passed through as
   null and refused here by name, which is the caller's cue that the paint
   cannot be honoured rather than a reason to proceed as if there were none.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   detectOverhangs(rawTris, opts)          -> { ok, regions: [...], ... }
   nearestBase(point, bases, opts)         -> { ok, from, dir, length, ... }
   buildStrut(opts)                        -> { ok, soup, sideMm, lengthMm }
   grow(soup, targetLengthMm, opts)        -> Extend's own result, verbatim
   place(soup, from, dir, opts)            -> { ok, soup, matrix, quat }
   aim(point, bases, opts)                 -> { ok, soup, from, dir, ... }
   plan(rawTris, opts)                     -> detect + aim, for the first region
   sectionAt(soup, origin, dir, t)         -> { ok, area, perimeter, segments }
   uniformity(soup, origin, dir, opts)     -> { ok, stations, spread, ... }
   describe(result)                        -> one status line
   ============================================================ */
(function (root) {
  'use strict';

  /* The printable angle a support is generated below, measured from the build
     plate: a surface leaning less than this off horizontal has nothing holding
     its first extrusion up. 45 deg is the figure the app already draws its
     overhang tint with (applyOverhangColors, app-core.js) and the default
     every slicer in the README's list ships. Stated, not measured. */
  var ANGLE_DEFAULT_DEG = 45;

  /* Below this a flagged patch is a tessellation artefact - one sliver on a
     curved flank that happened to tip past the threshold - not a region worth
     a strut. Callers wanting every last triangle pass minAreaMm2: 0. */
  var MIN_REGION_AREA_MM2 = 1.0;

  /* Default square strut side, before the floor is applied. 1.2 mm is three
     extrusion lines at a 0.4 nozzle: thin enough to snap off by hand, thick
     enough that the slicer prints it as a wall rather than as a single
     unanchored line. Stated, not measured. */
  var STRUT_SIDE_DEFAULT_MM = 1.2;

  /* The prism is built this long and then grown to the real length by Extend.
     It only has to be long enough that the band scan has a gap to cut in, and
     short enough that every real aim is a genuine stretch rather than a
     shortening - Extend refuses to shorten (its "OUT OF SCOPE 4"), so this
     must stay below the shortest support anyone would ask for. */
  var STRUT_SEED_MM = 0.5;

  /* Ray offsets. A ray leaving a surface must not re-hit the triangle it left,
     and a hit at exactly the far end of a segment must not read as a blockage.
     Both are float32 questions on soup coordinates, so the epsilon is in the
     same units as the geometry and generous by two orders of magnitude over
     float32 spacing at plate scale (1.2e-4 mm at 1400 mm, per app-extend.js). */
  var RAY_EPS_MM = 1e-3;

  var UP = [0, 0, 1];

  /* ---- plain 3-vectors. Same shapes as nso_carve.js / nso_seat_surface.js,
     so a point crosses between the three modules with no conversion. ---- */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function unit(a) { var L = len(a); return L > 1e-15 ? mul(a, 1 / L) : null; }
  function finite3(p) {
    return !!p && p.length === 3 && isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]);
  }
  function triCount(soup) { return (soup && soup.length) ? (soup.length / 9) | 0 : 0; }

  /* Unit normal and twice-area of triangle t, from the winding. Returns null
     for a degenerate triangle, which is then skipped everywhere: a triangle
     with no area faces no direction, so it can neither be an overhang nor
     block a ray. */
  function triNormal(soup, t) {
    var o = t * 9;
    var ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
    var vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(L > 1e-15)) return null;
    return { n: [nx / L, ny / L, nz / L], area: L / 2 };
  }
  function triCentroid(soup, t) {
    var o = t * 9;
    return [(soup[o] + soup[o + 3] + soup[o + 6]) / 3,
            (soup[o + 1] + soup[o + 4] + soup[o + 7]) / 3,
            (soup[o + 2] + soup[o + 5] + soup[o + 8]) / 3];
  }

  /* Moller-Trumbore, double-sided. Written out here rather than borrowed
     because every copy in the repo is behind something this module refuses to
     depend on: NSO_rayHitsSoup lives in app-join.js (THREE and the DOM),
     NSO_Thickness's allHits is private to its closure, and mesh_validate.py is
     Python. Same maths, and tools/nso_support_aim_test.js holds it to
     NSO_Thickness's answer on a real fixture so the two cannot drift. */
  function rayTri(ox, oy, oz, dx, dy, dz, soup, o) {
    var ax = soup[o], ay = soup[o + 1], az = soup[o + 2];
    var e1x = soup[o + 3] - ax, e1y = soup[o + 4] - ay, e1z = soup[o + 5] - az;
    var e2x = soup[o + 6] - ax, e2y = soup[o + 7] - ay, e2z = soup[o + 8] - az;
    var px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    var det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-14) return -1;
    var inv = 1 / det;
    var tx = ox - ax, ty = oy - ay, tz = oz - az;
    var u = (tx * px + ty * py + tz * pz) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) return -1;
    var qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    var v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) return -1;
    var tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return tt > 0 ? tt : -1;
  }

  /* Nearest hit strictly beyond `tMin` and strictly before `tMax`, over every
     soup in `soups`. -1 for a clear line. */
  function nearestHit(soups, orig, dir, tMin, tMax) {
    var best = -1;
    for (var s = 0; s < soups.length; s++) {
      var soup = soups[s];
      if (!soup || !soup.length) continue;
      var n = triCount(soup);
      for (var t = 0; t < n; t++) {
        var tt = rayTri(orig[0], orig[1], orig[2], dir[0], dir[1], dir[2], soup, t * 9);
        if (tt > tMin && tt < tMax && (best < 0 || tt < best)) best = tt;
      }
    }
    return best;
  }

  /* A uniform XY bucket grid, for the ONE ray direction this module casts
     thousands of: straight down. A vertical ray can only ever meet a triangle
     whose XY footprint contains the ray's (x, y), so bucketing every triangle
     by that footprint once turns the self-support scan from flagged x tris
     into flagged x (the handful in one cell). Measured on
     fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl, 32862 triangles:
     one ray from every triangle takes 169 s brute force and 0.27 s through
     the grid, and the whole detectOverhangs scan of that part lands at 0.13 s
     (median of five).

     Same answer, ray for ray - tools/nso_support_aim_test.js pins that
     equality on real fixtures rather than trusting it, because a spatial
     index that is merely nearly right reads exactly like a correct one until
     the day it does not. It already caught one: see the clamp note in
     nearestHitDown.

     Arbitrary-direction rays are left brute force on purpose: the base
     viability check casts one ray per candidate base, so a second index would
     cost more to build than the scan it saved. */
  function buildDownGrid(soups) {
    var tris = [], s, t, n, o, k;
    for (s = 0; s < soups.length; s++) {
      var soup = soups[s];
      if (!soup || !soup.length) continue;
      n = triCount(soup);
      for (t = 0; t < n; t++) {
        o = t * 9;
        tris.push({
          soup: soup, o: o,
          x0: Math.min(soup[o], soup[o + 3], soup[o + 6]),
          x1: Math.max(soup[o], soup[o + 3], soup[o + 6]),
          y0: Math.min(soup[o + 1], soup[o + 4], soup[o + 7]),
          y1: Math.max(soup[o + 1], soup[o + 4], soup[o + 7])
        });
      }
    }
    if (!tris.length) return { cells: null, tris: tris };

    var mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (k = 0; k < tris.length; k++) {
      if (tris[k].x0 < mnx) mnx = tris[k].x0;
      if (tris[k].x1 > mxx) mxx = tris[k].x1;
      if (tris[k].y0 < mny) mny = tris[k].y0;
      if (tris[k].y1 > mxy) mxy = tris[k].y1;
    }
    /* sqrt(N) cells a side puts about one triangle in each, and the cap keeps
       a 30k-triangle mesh from allocating a quarter of a million cells. */
    var side = Math.max(1, Math.min(256, Math.round(Math.sqrt(tris.length))));
    var w = Math.max(mxx - mnx, 1e-6) / side, h = Math.max(mxy - mny, 1e-6) / side;
    var cells = new Array(side * side);
    for (k = 0; k < tris.length; k++) {
      var T = tris[k];
      var i0 = Math.max(0, Math.min(side - 1, Math.floor((T.x0 - mnx) / w)));
      var i1 = Math.max(0, Math.min(side - 1, Math.floor((T.x1 - mnx) / w)));
      var j0 = Math.max(0, Math.min(side - 1, Math.floor((T.y0 - mny) / h)));
      var j1 = Math.max(0, Math.min(side - 1, Math.floor((T.y1 - mny) / h)));
      for (var i = i0; i <= i1; i++) for (var j = j0; j <= j1; j++) {
        var c = j * side + i;
        if (!cells[c]) cells[c] = [];
        cells[c].push(T);
      }
    }
    return { cells: cells, side: side, mnx: mnx, mny: mny, w: w, h: h, tris: tris };
  }

  /* Nearest hit straight down from (orig), in (tMin, tMax). Same answer as
     nearestHit(soups, orig, [0,0,-1], tMin, tMax), reached through the grid. */
  function nearestHitDown(grid, orig, tMin, tMax) {
    var list;
    if (!grid.cells) {
      list = grid.tris;
    } else {
      /* Clamped exactly as the bucketing clamps, and for the same reason: a
         triangle whose bbox ends ON the grid's own maximum is filed in the
         last cell, so a ray arriving at that same coordinate has to look
         there too. Flooring without the clamp sends it to cell `side`, which
         does not exist, and the ray reports a clear line through solid
         material. That is not a rounding: it is every ray on the mesh's own
         +x or +y boundary, which on a symmetric part is a whole face's worth.
         A point genuinely outside the grid lands in an edge cell and is then
         rejected by the per-triangle footprint test below, at the cost of one
         cell's worth of work. */
      var i = Math.max(0, Math.min(grid.side - 1, Math.floor((orig[0] - grid.mnx) / grid.w)));
      var j = Math.max(0, Math.min(grid.side - 1, Math.floor((orig[1] - grid.mny) / grid.h)));
      list = grid.cells[j * grid.side + i];
      if (!list) return -1;
    }
    var best = -1;
    for (var k = 0; k < list.length; k++) {
      var T = list[k];
      if (orig[0] < T.x0 || orig[0] > T.x1 || orig[1] < T.y0 || orig[1] > T.y1) continue;
      var tt = rayTri(orig[0], orig[1], orig[2], 0, 0, -1, T.soup, T.o);
      if (tt > tMin && tt < tMax && (best < 0 || tt < best)) best = tt;
    }
    return best;
  }

  /* Closest point on a triangle to p, by Ericson's region test. NSO_Carve has
     the same routine but exposes it as _closestOnTri, marked "for the tests,
     not for callers", so it is written out rather than reached into. */
  function closestOnTri(p, a, b, c) {
    var ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    var d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a.slice();
    var bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b.slice();
    var vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, mul(ab, d1 / (d1 - d3)));
    var cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c.slice();
    var vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, mul(ac, d2 / (d2 - d6)));
    var va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
      return add(b, mul(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
    }
    var den = 1 / (va + vb + vc);
    return add(a, add(mul(ab, vb * den), mul(ac, vc * den)));
  }

  function closestOnSoup(p, soup) {
    var n = triCount(soup), best = null, bestD = Infinity;
    for (var t = 0; t < n; t++) {
      var o = t * 9;
      var q = closestOnTri(p, [soup[o], soup[o + 1], soup[o + 2]],
                              [soup[o + 3], soup[o + 4], soup[o + 5]],
                              [soup[o + 6], soup[o + 7], soup[o + 8]]);
      var d = len(sub(q, p));
      if (d < bestD) { bestD = d; best = q; }
    }
    return best ? { point: best, distance: bestD } : null;
  }

  function soupBounds(soup) {
    var n = triCount(soup);
    if (!n) return null;
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < n * 9; i += 3) {
      for (var k = 0; k < 3; k++) {
        var c = soup[i + k];
        if (c < mn[k]) mn[k] = c;
        if (c > mx[k]) mx[k] = c;
      }
    }
    return { min: mn, max: mx };
  }

  /* =====================================================================
     1. DETECTION

     The angle test, stated once so the sign conventions cannot drift.

     n is the OUTWARD unit normal, so a downward-facing surface has n.z < 0.
     Let g be the angle between n and straight down, and let phi be the
     surface's own tilt off the build plate. A flat ceiling has n = -Z, g = 0,
     phi = 0. A vertical wall has n.z = 0, g = 90, phi = 90. The two are the
     same angle: g = phi, because the angle between a plane and the horizontal
     equals the angle between its normal and the vertical.

     So "steeper than the printable angle" - a surface leaning further off the
     plate than the threshold - is phi < angleDeg, which is

         n.z < -cos(angleDeg)

     and at the 45 deg default that is n.z < -0.7071.

     This is NOT the test applyOverhangColors (app-core.js) draws the viewport
     tint with. That one flags `n.z < cos(45)`, which is every face more than
     45 deg off UP - a vertical wall included, at n.z = 0 - and then patches
     the flat underside back out with a second `n.z > -0.95` clause. It is a
     tint, it has always been a tint, and reusing it as the detector would
     flag every vertical wall on every piece and miss every flat ceiling. The
     angle-vs-normal shape is borrowed; the threshold is corrected, and the
     correction is the reason this is not a one-line call into that function.

     THE SECOND HALF IS WHAT MAKES IT A DETECTOR RATHER THAN A TINT. A steep
     downward face with material under it is already supported - the piece
     holds itself up. So every flagged triangle then gets one ray straight
     down from its own centroid: a hit before the plate means something is
     underneath, and the triangle is dropped. That test is the whole
     difference between "faces that point down" and "regions that need
     support", and it is why a cantilever's underside is reported while the
     underside of a step sitting on its own base is not.
     ===================================================================== */

  /* A triangle lies on a painted face when its normal names that axis and side
     and its plane coordinate matches the one the click recorded. The skip-list
     entries are read exactly as nsoMaskFaceList hands them over - axisIdx,
     keepMin, d - and never re-derived from a bounding box. */
  function onSkippedFace(n, o, soup, skipList, planeTol) {
    for (var i = 0; i < skipList.length; i++) {
      var e = skipList[i];
      if (e == null || e.axisIdx == null) continue;
      var k = e.axisIdx | 0;
      if (Math.abs(n[k]) < 0.999) continue;
      if ((n[k] >= 0 ? 1 : -1) !== (e.keepMin ? -1 : 1)) continue;
      if (e.d == null) return true;              /* face named with no plane: skip the whole side */
      if (Math.abs(soup[o + k] - e.d) < planeTol) return true;
    }
    return false;
  }

  /* Union-find over the flagged triangles, joined by a shared welded vertex.
     The weld key is a quantised coordinate triple; the grid is the same idea
     NSO_Thickness.indexSoup uses, at the same default tolerance, so two
     modules looking at one mesh agree on which vertices are one vertex. */
  function clusterTris(soup, flagged, weldTol) {
    var parent = new Int32Array(flagged.length);
    for (var i = 0; i < flagged.length; i++) parent[i] = i;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }

    var inv = 1 / weldTol, map = new Map();
    for (var f = 0; f < flagged.length; f++) {
      var o = flagged[f] * 9;
      for (var v = 0; v < 3; v++) {
        var key = Math.round(soup[o + v * 3] * inv) + '|' +
                  Math.round(soup[o + v * 3 + 1] * inv) + '|' +
                  Math.round(soup[o + v * 3 + 2] * inv);
        var prev = map.get(key);
        if (prev === undefined) map.set(key, f); else union(prev, f);
      }
    }
    var groups = new Map();
    for (var g = 0; g < flagged.length; g++) {
      var r = find(g);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(flagged[g]);
    }
    return Array.from(groups.values());
  }

  // opts.angleDeg    printable angle off the build plate, default 45
  // opts.plateZ      the plate, default the soup's own minimum z
  // opts.minAreaMm2  drop regions smaller than this, default 1.0
  // opts.skipList    REQUIRED. nsoMaskFaceList(m) verbatim; [] when nothing is
  //                  painted, null when a painted face has no axis to name -
  //                  which is refused, not defaulted away.
  // opts.occluders   other pieces' world soups. Material in one of these under
  //                  an overhang supports it exactly as the piece's own does.
  // opts.weldTol     vertex weld for clustering, default 1e-4 mm
  function detectOverhangs(rawTris, opts) {
    opts = opts || {};
    var out = {
      ok: false, reason: '', regions: [],
      angleDeg: 0, plateZ: 0,
      trisTotal: 0, trisDownward: 0, trisFlagged: 0,
      trisSelfSupported: 0, trisPainted: 0, trisBelowMinArea: 0, trisOnPlate: 0
    };
    if (!rawTris || rawTris.length < 9 || (rawTris.length % 9) !== 0) {
      out.reason = 'not a triangle soup'; return out;
    }
    if (opts.skipList === undefined) {
      out.reason = 'detectOverhangs needs opts.skipList - pass nsoMaskFaceList(m), ' +
        'or [] to state that nothing is painted; there is no unpainted default';
      return out;
    }
    if (opts.skipList === null) {
      out.reason = 'a painted face has no axis and side to name it by, so it cannot be ' +
        'scoped out of the overhang scan - clear the paint or paint a flat face';
      return out;
    }
    var skipList = opts.skipList;

    var angleDeg = (opts.angleDeg == null) ? ANGLE_DEFAULT_DEG : +opts.angleDeg;
    if (!(angleDeg > 0 && angleDeg < 90)) {
      out.reason = 'angleDeg must be between 0 and 90 exclusive, got ' + opts.angleDeg;
      return out;
    }
    out.angleDeg = angleDeg;
    var nzMax = -Math.cos(angleDeg * Math.PI / 180);

    var bounds = soupBounds(rawTris);
    var plateZ = (opts.plateZ == null) ? bounds.min[2] : +opts.plateZ;
    out.plateZ = plateZ;
    var minArea = (opts.minAreaMm2 == null) ? MIN_REGION_AREA_MM2 : +opts.minAreaMm2;
    var weldTol = (opts.weldTol == null) ? 1e-4 : +opts.weldTol;
    var planeTol = (opts.planeTol == null) ? 1e-3 : +opts.planeTol;
    var occluders = opts.occluders || [];
    var downGrid = buildDownGrid([rawTris].concat(occluders));

    /* A face this close to the plate has nowhere to put a support: the strut
       would be shorter than it is wide. Below the floor it is not an overhang
       that was missed, it is a face that is already down. Default 0.5 mm,
       which is where a fixture's bottom chamfer and a sphere's contact patch
       both sit - measured across every STL in fixtures/ and library/. */
    var minDrop = (opts.minDropMm == null) ? 0.5 : +opts.minDropMm;
    out.minDropMm = minDrop;

    var n = triCount(rawTris);
    out.trisTotal = n;
    var flagged = [];

    for (var t = 0; t < n; t++) {
      var tn = triNormal(rawTris, t);
      if (!tn) continue;                                   /* no area, no facing */
      if (!(tn.n[2] < nzMax)) continue;                    /* not steep enough, or facing up */
      out.trisDownward++;

      if (skipList.length && onSkippedFace(tn.n, t * 9, rawTris, skipList, planeTol)) {
        out.trisPainted++;
        continue;
      }

      /* Straight down from just under the face. The offset is what stops the
         ray re-hitting the triangle it started on; the drop is measured to
         the plate, because a hit below the plate is not underneath anything
         that will be printed. */
      var c = triCentroid(rawTris, t);
      var drop = c[2] - plateZ;
      if (!(drop > minDrop)) { out.trisOnPlate++; continue; }
      var orig = [c[0], c[1], c[2] - RAY_EPS_MM];
      /* The window runs all the way to the plate, not to just short of it.
         The case that settles it is the normal one: a pillar standing FLUSH
         under the overhang, its top face coincident with the face being
         tested. The ray then starts inside that pillar and its only hit is
         the pillar's own underside, sitting exactly on the plate - so a
         window that stops a hair above the plate reports a clear line
         through solid material and calls a fully propped overhang
         unsupported. Anything below the plate is not going to be printed, and
         no hit can land there: the plate is the soup's own minimum. */
      var hit = nearestHitDown(downGrid, orig, RAY_EPS_MM, drop);
      if (hit > 0) { out.trisSelfSupported++; continue; }  /* material underneath */

      flagged.push(t);
    }
    out.trisFlagged = flagged.length;

    if (!flagged.length) {
      out.ok = true;
      out.reason = 'no unsupported overhang below ' + angleDeg + ' deg';
      return out;
    }

    var groups = clusterTris(rawTris, flagged, weldTol);
    var regions = [];
    for (var g = 0; g < groups.length; g++) {
      var tris = groups[g];
      var area = 0, wc = [0, 0, 0], wn = [0, 0, 0], lowest = null, worstNz = 0;
      var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (var i = 0; i < tris.length; i++) {
        var ti = tris[i], tni = triNormal(rawTris, ti);
        area += tni.area;
        wc = add(wc, mul(triCentroid(rawTris, ti), tni.area));
        wn = add(wn, mul(tni.n, tni.area));
        if (tni.n[2] < worstNz) worstNz = tni.n[2];
        var oi = ti * 9;
        for (var v = 0; v < 3; v++) {
          var p = [rawTris[oi + v * 3], rawTris[oi + v * 3 + 1], rawTris[oi + v * 3 + 2]];
          if (!lowest || p[2] < lowest[2]) lowest = p;
          for (var k = 0; k < 3; k++) {
            if (p[k] < mn[k]) mn[k] = p[k];
            if (p[k] > mx[k]) mx[k] = p[k];
          }
        }
      }
      if (!(area > 0)) continue;
      if (area < minArea) { out.trisBelowMinArea += tris.length; continue; }

      /* The aim point is the area-weighted centroid PULLED BACK ONTO THE
         SURFACE. An overhang that is not flat has a centroid floating in the
         air below itself, and aiming a support at a point the piece does not
         occupy is how a strut ends up stopping short of, or driving through,
         the thing it was meant to hold. */
      var centroid = mul(wc, 1 / area);
      var onSurface = centroid, bestD = Infinity;
      for (var j = 0; j < tris.length; j++) {
        var oj = tris[j] * 9;
        var q = closestOnTri(centroid,
          [rawTris[oj], rawTris[oj + 1], rawTris[oj + 2]],
          [rawTris[oj + 3], rawTris[oj + 4], rawTris[oj + 5]],
          [rawTris[oj + 6], rawTris[oj + 7], rawTris[oj + 8]]);
        var d = len(sub(q, centroid));
        if (d < bestD) { bestD = d; onSurface = q; }
      }

      regions.push({
        id: regions.length,
        tris: tris,
        triCount: tris.length,
        areaMm2: area,
        point: onSurface,            /* aim here */
        /* Area-weighted mean OUTWARD normal of the region: the direction the
           face looks, which for a downward-facing region points down and away
           from the material. aim() uses it to measure how far a flat strut cap
           ends up past the surface it is aiming at. */
        normal: unit(wn) || [0, 0, -1],
        centroid: centroid,
        lowest: lowest,
        min: mn, max: mx,
        spanMm: Math.max(mx[0] - mn[0], mx[1] - mn[1]),
        dropMm: onSurface[2] - plateZ,
        steepestNz: worstNz
      });
    }

    regions.sort(function (a, b) { return b.areaMm2 - a.areaMm2; });
    for (var r = 0; r < regions.length; r++) regions[r].id = r;

    out.ok = true;
    out.regions = regions;
    out.reason = regions.length
      ? regions.length + ' unsupported region(s) below ' + angleDeg + ' deg, ' +
        'largest ' + regions[0].areaMm2.toFixed(2) + ' mm^2'
      : 'every downward face is either supported from below or smaller than ' +
        minArea + ' mm^2';
    return out;
  }

  /* =====================================================================
     2. THE AIM

     One straight line, from the nearest base that can actually see the point.

     A base is VIABLE when the segment from its foot to the target is clear:
     nothing of the piece, and nothing of any other obstacle, sits strictly
     between them. That is the condition that makes this a single direction
     rather than a path search. A base whose line is blocked is not nudged,
     not routed around and not bent - it is rejected, the next-nearest base is
     tried, and when none is clear the aim refuses and says what blocked it.
     Routing around the blockage is the curving/branching ticket; see "OUT OF
     SCOPE 1" at the top. Refusing here is what keeps that boundary honest.

     "Nearest" is the true nearest point on the base, not the point below the
     target: on the plate those are the same point (the plate is horizontal,
     so its closest point to anything is straight down from it), but on
     another piece they are not, and taking the straight-down point there
     would aim a support at thin air beside the piece it meant to stand on.
     ===================================================================== */

  // bases: [{ kind:'plate', z }, { kind:'piece', soup, id }]
  // opts.obstacles  soups the line must not pierce - normally the model itself
  // opts.minLength  refuse a base closer than this, default 1x the strut side
  function nearestBase(point, bases, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '', considered: [] };
    if (!finite3(point)) { out.reason = 'aim point is not a finite 3-vector'; return out; }
    if (!bases || !bases.length) { out.reason = 'no bases offered'; return out; }
    /* Zero obstacles is legal - an aim through free space - and is also
       exactly what a caller who forgot to pass the model passes, and the two
       are indistinguishable from in here. So the count is reported rather than
       guessed at: with none, every base reads viable because nothing was
       checked. plan() fills this in from the piece itself. */
    var obstacles = opts.obstacles || [];
    out.obstaclesChecked = obstacles.length;
    var minLength = (opts.minLength == null) ? 0.5 : +opts.minLength;

    var cands = [];
    for (var i = 0; i < bases.length; i++) {
      var b = bases[i];
      if (!b) continue;
      if (b.kind === 'plate') {
        var z = (b.z == null) ? 0 : +b.z;
        if (!(point[2] > z)) continue;                    /* at or under the plate */
        cands.push({ base: b, index: i, from: [point[0], point[1], z], length: point[2] - z });
      } else if (b.kind === 'piece') {
        var near = closestOnSoup(point, b.soup);
        if (!near) continue;
        cands.push({ base: b, index: i, from: near.point, length: near.distance });
      } else {
        continue;
      }
    }
    if (!cands.length) { out.reason = 'no base offers a foot below the aim point'; return out; }
    cands.sort(function (a, b) { return a.length - b.length; });

    for (var c = 0; c < cands.length; c++) {
      var cand = cands[c];
      var rec = { kind: cand.base.kind, id: cand.base.id, length: cand.length, viable: false, why: '' };
      out.considered.push(rec);

      if (!(cand.length > minLength)) {
        rec.why = 'foot is ' + cand.length.toFixed(4) + ' mm from the target, under the ' +
          minLength + ' mm minimum - there is no room for a support here';
        continue;
      }
      var dir = unit(sub(point, cand.from));
      if (!dir) { rec.why = 'foot and target coincide'; continue; }

      /* The line is clear when nothing is hit strictly between the two ends.
         Both ends are excluded by RAY_EPS_MM: the foot sits ON the base and
         the tip sits ON the target, so a hit at either end is the thing the
         support is attaching to, not an obstruction. */
      var blockAt = nearestHit(obstacles, cand.from, dir, RAY_EPS_MM, cand.length - RAY_EPS_MM);
      if (blockAt > 0) {
        rec.why = 'the straight line is blocked ' + blockAt.toFixed(3) + ' mm along, ' +
          (cand.length - blockAt).toFixed(3) + ' mm short of the target';
        continue;
      }

      rec.viable = true;
      rec.why = 'clear';
      out.ok = true;
      out.base = cand.base;
      out.baseIndex = cand.index;
      out.from = cand.from;
      out.dir = dir;
      out.length = cand.length;
      out.reason = 'aimed from the ' + cand.base.kind +
        (cand.base.id != null ? ' (' + cand.base.id + ')' : '') +
        ', ' + cand.length.toFixed(3) + ' mm away';
      return out;
    }

    out.reason = 'no viable base - ' +
      out.considered.map(function (r) { return r.kind + ': ' + r.why; }).join('; ') +
      '. A support that has to bend around the piece to get there is a curving ' +
      'path, which is out of scope here by name';
    return out;
  }

  /* =====================================================================
     3. THE STRUT: built short along local +Z, grown by Extend, then turned.

     The order is the whole of the design.

     BUILT ALONG +Z because Extend holds the cross-section bit for bit only on
     a cardinal axis and refuses an oblique one by name. A strut in its own
     local frame is always on one.

     GROWN BEFORE IT IS TURNED because the turn is a rotation of every
     coordinate, and Extend's promise is that two of the three are copied
     through unchanged. Rotate first and there is no axis left to make that
     promise about; the stretch would become a shear through a rounding error
     and Extend would refuse, correctly, for a reason that had nothing to do
     with the support.

     TURNED BY BAKING, not by posing - see the header. The matrix comes back as
     data; the triangles come back already turned.
     ===================================================================== */

  /* A closed right prism, cross-section `sideMm` square, from z = 0 to
     z = lengthMm, centred on the local z axis. Twelve triangles, outward
     wound. Deliberately the simplest solid that has a constant cross-section:
     its side walls all have n.z = 0, so Extend's band scan finds the whole
     length clean and cuts in the middle of it. */
  function prism(sideMm, lengthMm) {
    var h = sideMm / 2, L = lengthMm;
    var v = [
      [-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0],
      [-h, -h, L], [h, -h, L], [h, h, L], [-h, h, L]
    ];
    var faces = [
      [0, 2, 1], [0, 3, 2],          /* bottom cap, outward = -Z */
      [4, 5, 6], [4, 6, 7],          /* top cap,    outward = +Z */
      [0, 1, 5], [0, 5, 4],          /* -Y */
      [1, 2, 6], [1, 6, 5],          /* +X */
      [2, 3, 7], [2, 7, 6],          /* +Y */
      [3, 0, 4], [3, 4, 7]           /* -X */
    ];
    var soup = new Float32Array(faces.length * 9), w = 0;
    for (var f = 0; f < faces.length; f++) {
      for (var k = 0; k < 3; k++) {
        var p = v[faces[f][k]];
        soup[w++] = p[0]; soup[w++] = p[1]; soup[w++] = p[2];
      }
    }
    return soup;
  }

  /* The floor, from nso_thickness.js and from nowhere else. A caller may pass
     a measured line width as opts.minWall and step the floor aside - that is
     nso_thickness.js's own contract - but a caller who passes nothing gets the
     canonical figure, and a build with no way to establish one refuses. */
  function resolveFloor(opts) {
    if (opts && typeof opts.minWall === 'number' && opts.minWall > 0) {
      return { ok: true, floor: opts.minWall, source: 'caller-supplied minWall' };
    }
    var T = (opts && opts.thickness) || root && root.NSO_Thickness ||
            (typeof NSO_Thickness !== 'undefined' ? NSO_Thickness : null);
    if (!T || typeof T.floorFor !== 'function') {
      return { ok: false, floor: 0, source: null,
        reason: 'nso_thickness.js is not loaded, so the wall-thickness floor cannot be ' +
                'established - refusing rather than inventing one. Load it, or pass ' +
                'opts.minWall with a measured extrusion width.' };
    }
    var nozzle = (opts && opts.nozzle) || undefined;
    return { ok: true, floor: T.floorFor(nozzle), source: 'NSO_Thickness.floorFor', nozzle: nozzle };
  }

  // opts.sideMm   requested square side, default 1.2
  // opts.minWall / opts.nozzle / opts.thickness  -> resolveFloor
  // opts.seedMm   seed length before the stretch, default 0.5
  function buildStrut(opts) {
    opts = opts || {};
    var out = { ok: false, reason: '' };
    var fl = resolveFloor(opts);
    if (!fl.ok) { out.reason = fl.reason; return out; }

    var want = (opts.sideMm == null) ? STRUT_SIDE_DEFAULT_MM : +opts.sideMm;
    if (!(want > 0)) { out.reason = 'sideMm must be positive, got ' + opts.sideMm; return out; }
    var side = Math.max(want, fl.floor);
    var seed = (opts.seedMm == null) ? STRUT_SEED_MM : +opts.seedMm;
    if (!(seed > 0)) { out.reason = 'seedMm must be positive, got ' + opts.seedMm; return out; }

    out.ok = true;
    out.soup = prism(side, seed);
    out.sideMm = side;
    out.lengthMm = seed;
    out.requestedSideMm = want;
    out.floorMm = fl.floor;
    out.floorSource = fl.source;
    out.flooredUp = side > want;
    out.reason = out.flooredUp
      ? 'strut side raised from ' + want + ' to the ' + fl.floor + ' mm floor (' + fl.source + ')'
      : 'strut side ' + side + ' mm, clear of the ' + fl.floor + ' mm floor (' + fl.source + ')';
    return out;
  }

  /* The growth step, and the whole of it. Extend's result is returned
     verbatim - its reason, its gates, its measured residual - because a
     support that failed to reach must say so in the same words a stretch that
     failed to reach says it, and wrapping the failure in a new sentence is how
     two vocabularies for one event start. */
  function grow(soup, targetLengthMm, opts) {
    opts = opts || {};
    var ext = (opts.extendRaw) || (root && root.NSO_extendRaw) ||
              (typeof NSO_extendRaw !== 'undefined' ? NSO_extendRaw : null);
    if (typeof ext !== 'function') {
      return { ok: false, reason: 'app-extend.js is not loaded - NSO_extendRaw is what grows a ' +
        'support, and nothing here reimplements a stretch', tris: soup };
    }
    /* axis forced to z: the strut IS its own axis, and letting the detector
       vote lets a short seed with a wide cross-section elect x or y. */
    return ext(soup, {
      axis: 'z',
      length: targetLengthMm,
      gate: (opts.gate == null) ? true : opts.gate,
      lengthUlps: opts.lengthUlps
    });
  }

  /* Bake the turn. `dir` becomes the strut's local +Z; `from` becomes local
     origin. Antiparallel - a support pointing straight down, which is every
     support that hangs off an overhang onto a piece below it - is settled by
     the fallback axis rather than by whatever a cross product with a world
     axis happens to produce. */
  function place(soup, from, dir, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '' };
    if (!finite3(from)) { out.reason = 'from is not a finite 3-vector'; return out; }
    var d = unit(dir || []);
    if (!d) { out.reason = 'dir is not a usable direction'; return out; }

    var S = (opts.seat) || (root && root.NSO_SeatSurface) ||
            (typeof NSO_SeatSurface !== 'undefined' ? NSO_SeatSurface : null);
    if (!S || typeof S.quatFromTo !== 'function' || typeof S.transformSoup !== 'function') {
      out.reason = 'nso_seat_surface.js is not loaded - its quatFromTo settles the ' +
        'antiparallel case and its transformSoup is the bake, and both are reused here';
      return out;
    }

    /* A fallback that is not parallel to +Z, so the antiparallel branch has a
       real axis to turn about. */
    var fallback = opts.fallbackAxis || [1, 0, 0];
    var q = S.quatFromTo(UP, d, fallback);

    /* Column-major 4x4, THREE's Matrix4.elements order - the order
       transformSoup, xfPoint and NSO_Carve.placeBlade all already speak. */
    var x = q[0], y = q[1], z = q[2], w = q[3];
    var m = [
      1 - 2 * (y * y + z * z), 2 * (x * y + z * w),     2 * (x * z - y * w),     0,
      2 * (x * y - z * w),     1 - 2 * (x * x + z * z), 2 * (y * z + x * w),     0,
      2 * (x * z + y * w),     2 * (y * z - x * w),     1 - 2 * (x * x + y * y), 0,
      from[0],                 from[1],                 from[2],                 1
    ];
    var moved = S.transformSoup(soup, m);
    /* back to float32: the rest of the app stores raw soups as Float32Array,
       and a Float64Array would read as "more precise" to every downstream
       weld tolerance that is keyed off float32 spacing. */
    var f32 = new Float32Array(moved.length);
    for (var i = 0; i < moved.length; i++) f32[i] = moved[i];

    out.ok = true;
    out.soup = f32;
    out.matrix = m;
    out.quat = q;
    out.turnedDeg = 2 * Math.acos(Math.min(1, Math.max(-1, Math.abs(w)))) * 180 / Math.PI;
    out.reason = 'baked a ' + out.turnedDeg.toFixed(2) + ' deg turn into the strut\'s own triangles';
    return out;
  }

  /* Build, grow, turn - in that order, for one target point. */
  function aim(point, bases, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '', stage: 'base' };

    var nb = nearestBase(point, bases, opts);
    out.base = nb;
    if (!nb.ok) { out.reason = nb.reason; return out; }

    out.stage = 'build';
    var b = buildStrut(opts);
    out.build = b;
    if (!b.ok) { out.reason = b.reason; return out; }

    /* How far the strut has to reach. The default lands its end cap exactly on
       the target point; a caller wanting the tip to bite into the overhang
       passes tipEngageMm, and one wanting it to stop short passes a negative. */
    var engage = (opts.tipEngageMm == null) ? 0 : +opts.tipEngageMm;
    var target = nb.length + engage;
    if (!(target > b.lengthMm)) {
      out.reason = 'the support only has to reach ' + target.toFixed(4) + ' mm, which is no ' +
        'longer than the ' + b.lengthMm + ' mm seed - Extend lengthens only, so lower opts.seedMm';
      return out;
    }

    out.stage = 'grow';
    var g = grow(b.soup, target, opts);
    out.grow = g;
    if (!g.ok) { out.reason = 'the strut would not grow to length: ' + g.reason; return out; }

    out.stage = 'place';
    var p = place(g.tris, nb.from, nb.dir, opts);
    out.place = p;
    if (!p.ok) { out.reason = p.reason; return out; }

    /* Measured, not assumed: where did the end cap actually land? Extend
       reports its own residual along the local axis; this is the same question
       asked of the finished world-space solid, after the turn. */
    var tip = add(nb.from, mul(nb.dir, g.lengthAfter));

    /* HOW FAR THE CAP GOES PAST THE FACE, measured off the finished solid.
       The tip point lands on the target exactly, but the cap is a flat square
       PERPENDICULAR TO THE AIM, and the face it meets is not. So whenever the
       aim is oblique to the target's normal, half the cap sits proud of the
       surface and the other half stops short of it. The extreme is the cap
       corner, which stands (side/2) * sin(angle between them) past the face -
       0.189737 mm for a 1.2 mm strut at 18.435 deg, measured and pinned in
       tools/nso_support_aim_test.js against that closed form.

       That is a property of a flat cap, not an error in the aim, and it is
       exactly the contact-geometry layer named in "OUT OF SCOPE 2" at the top
       - the same layer nso_seat_surface.js deferred, for the same reason. It
       is measured and reported here rather than left for a caller to discover,
       because a support that penetrates its target by a fifth of a millimetre
       is fine and one that penetrates it by two is a support driven through
       the piece, and nothing downstream can tell those apart without a
       number. Null when the caller names no target normal. */
    var penetration = null;
    var tn = unit(opts.targetNormal || []);
    if (tn) {
      penetration = 0;
      for (var vi = 0; vi < p.soup.length; vi += 3) {
        var past = -((p.soup[vi] - point[0]) * tn[0] +
                     (p.soup[vi + 1] - point[1]) * tn[1] +
                     (p.soup[vi + 2] - point[2]) * tn[2]);
        if (past > penetration) penetration = past;
      }
    }
    out.tipPenetrationMm = penetration;

    out.ok = true;
    out.stage = 'done';
    out.soup = p.soup;
    out.from = nb.from;
    out.dir = nb.dir;
    out.target = point;
    out.tip = tip;
    out.lengthMm = g.lengthAfter;
    out.sideMm = b.sideMm;
    out.floorMm = b.floorMm;
    out.reachErrorMm = len(sub(tip, point)) - Math.abs(engage);
    out.reason = 'a ' + b.sideMm.toFixed(3) + ' mm strut, ' + g.lengthAfter.toFixed(3) +
      ' mm long, aimed from the ' + nb.base.kind + ' along [' +
      nb.dir.map(function (c) { return c.toFixed(4); }).join(', ') + ']';
    return out;
  }

  /* detect + aim, for the biggest region. The convenience path; a caller with
     its own opinion about which region matters calls the two halves itself. */
  function plan(rawTris, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '', stage: 'detect' };
    var det = detectOverhangs(rawTris, opts);
    out.detect = det;
    if (!det.ok) { out.reason = det.reason; return out; }
    if (!det.regions.length) { out.reason = det.reason; return out; }

    var idx = (opts.regionId == null) ? 0 : (opts.regionId | 0);
    var region = det.regions[idx];
    if (!region) { out.reason = 'no region with id ' + idx + ' - ' + det.regions.length + ' found'; return out; }
    out.region = region;

    var bases = opts.bases || [{ kind: 'plate', z: det.plateZ }];
    var o = Object.assign({}, opts);
    if (!o.obstacles) o.obstacles = [rawTris].concat(opts.occluders || []);

    out.stage = 'aim';
    if (o.targetNormal === undefined) o.targetNormal = region.normal;
    var a = aim(region.point, bases, o);
    out.aim = a;
    if (!a.ok) { out.reason = a.reason; return out; }

    out.ok = true;
    out.stage = 'done';
    out.soup = a.soup;
    out.reason = det.reason + '; ' + a.reason;
    return out;
  }

  /* =====================================================================
     4. THE EVIDENCE: is the cross-section really uniform along the aim?

     Extend proves its own promise in its own local frame, coordinate by
     coordinate. This asks the question again of the finished, turned solid,
     in world space, perpendicular to the direction it was actually aimed
     along - which is the axis the claim is about and the one no local check
     can see after the bake.

     The section of a closed solid by a plane is a closed loop, so its area
     comes straight out of the shoelace sum over the crossing segments once
     they are consistently oriented. The orientation rule is dir x n: at a
     point where the surface's outward normal is n, the boundary runs along
     dir x n, which is the anticlockwise tangent seen down the aim axis. That
     is one line, and it is the reason the area comes out positive rather than
     as a sum of cancelling pieces.
     ===================================================================== */

  function basisFor(dir) {
    var t = (Math.abs(dir[0]) < 0.9) ? [1, 0, 0] : [0, 1, 0];
    var u = unit(sub(t, mul(dir, dot(t, dir))));
    return { u: u, v: cross(dir, u) };          /* u x v = dir */
  }

  function sectionAt(soup, origin, dir, t, basis) {
    var out = { ok: false, t: t, area: 0, perimeter: 0, segments: 0 };
    var d = unit(dir);
    if (!d || !finite3(origin)) { out.reason = 'bad origin or direction'; return out; }
    var B = basis || basisFor(d);
    var planeD = dot(d, origin) + t;
    var n = triCount(soup), area = 0, per = 0, segs = 0;

    for (var tri = 0; tri < n; tri++) {
      var o = tri * 9;
      var p = [[soup[o], soup[o + 1], soup[o + 2]],
               [soup[o + 3], soup[o + 4], soup[o + 5]],
               [soup[o + 6], soup[o + 7], soup[o + 8]]];
      var s = [dot(d, p[0]) - planeD, dot(d, p[1]) - planeD, dot(d, p[2]) - planeD];
      var pos = (s[0] > 0) + (s[1] > 0) + (s[2] > 0);
      var neg = (s[0] < 0) + (s[1] < 0) + (s[2] < 0);
      if (!pos || !neg) continue;                      /* no crossing, or grazing */

      var hits = [];
      for (var e = 0; e < 3; e++) {
        var a = e, b = (e + 1) % 3;
        if ((s[a] > 0) === (s[b] > 0)) continue;
        var f = s[a] / (s[a] - s[b]);
        hits.push(add(p[a], mul(sub(p[b], p[a]), f)));
      }
      if (hits.length !== 2) continue;

      var tn = triNormal(soup, tri);
      if (!tn) continue;
      var want = cross(d, tn.n);                       /* the anticlockwise tangent here */
      var A = hits[0], C = hits[1];
      if (dot(sub(C, A), want) < 0) { var tmp = A; A = C; C = tmp; }

      var au = dot(sub(A, origin), B.u), av = dot(sub(A, origin), B.v);
      var cu = dot(sub(C, origin), B.u), cv = dot(sub(C, origin), B.v);
      area += (au * cv - cu * av);
      per += len(sub(C, A));
      segs++;
    }

    if (!segs) { out.reason = 'the plane at t = ' + t + ' misses the solid'; return out; }
    out.ok = true;
    out.area = area / 2;
    out.perimeter = per;
    out.segments = segs;
    return out;
  }

  // opts.stations   how many planes, default 9
  // opts.marginMm   how far to stay off each end, default 1x the section's own
  //                 extent /20, so the end caps are never sectioned
  function uniformity(soup, origin, dir, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '', stations: [] };
    var d = unit(dir);
    if (!d || !finite3(origin)) { out.reason = 'bad origin or direction'; return out; }

    var lengthMm = opts.lengthMm;
    if (lengthMm == null) {
      var n = triCount(soup), lo = Infinity, hi = -Infinity;
      for (var i = 0; i < n * 9; i += 3) {
        var s = d[0] * (soup[i] - origin[0]) + d[1] * (soup[i + 1] - origin[1]) + d[2] * (soup[i + 2] - origin[2]);
        if (s < lo) lo = s;
        if (s > hi) hi = s;
      }
      lengthMm = hi - lo;
    }
    if (!(lengthMm > 0)) { out.reason = 'the solid has no extent along the aim'; return out; }

    var count = (opts.stations == null) ? 9 : (opts.stations | 0);
    if (count < 2) { out.reason = 'need at least 2 stations'; return out; }
    var margin = (opts.marginMm == null) ? lengthMm / 20 : +opts.marginMm;
    var lo2 = margin, hi2 = lengthMm - margin;
    if (!(hi2 > lo2)) { out.reason = 'margin leaves no room between the end caps'; return out; }

    var B = basisFor(d);
    var areas = [], pers = [];
    for (var k = 0; k < count; k++) {
      var t = lo2 + (hi2 - lo2) * (k / (count - 1));
      var sec = sectionAt(soup, origin, d, t, B);
      out.stations.push(sec);
      if (!sec.ok) { out.reason = 'station ' + k + ': ' + sec.reason; return out; }
      areas.push(sec.area);
      pers.push(sec.perimeter);
    }

    var aMin = Math.min.apply(null, areas), aMax = Math.max.apply(null, areas);
    var pMin = Math.min.apply(null, pers), pMax = Math.max.apply(null, pers);
    out.ok = true;
    out.lengthMm = lengthMm;
    out.areaMin = aMin; out.areaMax = aMax;
    out.areaSpreadMm2 = aMax - aMin;
    out.areaRelSpread = aMax > 0 ? (aMax - aMin) / aMax : 0;
    out.perimeterMin = pMin; out.perimeterMax = pMax;
    out.perimeterRelSpread = pMax > 0 ? (pMax - pMin) / pMax : 0;
    out.reason = count + ' sections between ' + lo2.toFixed(3) + ' and ' + hi2.toFixed(3) +
      ' mm: area ' + aMin.toFixed(6) + ' .. ' + aMax.toFixed(6) + ' mm^2 (' +
      (out.areaRelSpread * 100).toExponential(2) + '% spread)';
    return out;
  }

  function describe(res) {
    if (!res) return 'no result';
    if (!res.ok) return 'Support aim refused - ' + (res.reason || 'no reason given');
    return 'Support aim: ' + res.reason;
  }

  var api = {
    ANGLE_DEFAULT_DEG: ANGLE_DEFAULT_DEG,
    MIN_REGION_AREA_MM2: MIN_REGION_AREA_MM2,
    STRUT_SIDE_DEFAULT_MM: STRUT_SIDE_DEFAULT_MM,
    STRUT_SEED_MM: STRUT_SEED_MM,
    detectOverhangs: detectOverhangs,
    nearestBase: nearestBase,
    buildStrut: buildStrut,
    grow: grow,
    place: place,
    aim: aim,
    plan: plan,
    sectionAt: sectionAt,
    uniformity: uniformity,
    describe: describe,
    /* exposed for the tests, not for callers */
    _prism: prism,
    _closestOnTri: closestOnTri,
    _nearestHit: nearestHit,
    _buildDownGrid: buildDownGrid,
    _nearestHitDown: nearestHitDown,
    _resolveFloor: resolveFloor
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SupportAim = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
