/* ============================================================
   nso_support_tree.js - a trunk that stops, and branches that finish the job.

   Loads as a classic script (window.NSO_SupportTree) and as a Node module
   (require('../nso_support_tree.js')). No DOM, no THREE, no wasm. Soups are
   the app's raw convention: 9 floats per triangle, Z up, millimetres.

   ---------------------------------------------------------------------------
   WHAT THIS IS
   ---------------------------------------------------------------------------
   nso_support_aim.js aims ONE straight strut at ONE point and names three
   things as somebody else's ticket: branching (its OUT OF SCOPE 1), contact
   geometry (2), and support density / layout (3). This file is the first two
   thirds of 1 and all of 3, for a single trunk:

     TRUNK     the existing straight-line auto-aim, from the nearest viable
               base, stopped at a COMPUTED SPLIT POINT instead of at the
               overhang.
     BRANCHES  one per contact point the overhang actually needs, each an
               independent sweep from the trunk's end to its own point.
     UNION     the app's own boolean (NSO_unionSoups, app-join.js), because a
               trunk and its branches are one solid or they are a pile of
               solids that happen to touch.

   Nothing here asks the caller how many branches to make or where to put
   them. Both come out of the overhang's own geometry and out of two constants
   measured off a real, sliced Bambu tree support - see THE REFERENCE below.

   ---------------------------------------------------------------------------
   WHAT IS REUSED, AND DELIBERATELY NOT REWRITTEN
   ---------------------------------------------------------------------------
   - NSO_SupportAim does the detection, the base search, the strut, the growth
     and the bake. The trunk is literally its aim(), handed a different target.
     Its _nearestHit is what every branch's clearance probe casts, so the two
     halves of one feature cannot end up with two opinions about what "clear"
     means - the same Moller-Trumbore, the same epsilon at both ends.
   - NSO_PathSweep grows every branch. docs/CURVING-PATH.md named this exact
     caller ("the branching ticket ... should call NSO_PathSweep rather than
     grow anything itself"), and the reason is Extend's: Extend refuses an
     off-cardinal axis, so a branch leaving a trunk at 20 deg cannot be grown
     by it at all. A two-point path is one segment with no joints, so the
     sweep's mitre arithmetic never runs and the branch's cross-section is
     exact by the same argument Extend makes.
   - NSO_Thickness.floorFor, through NSO_SupportAim.buildStrut. There is still
     exactly one wall-thickness floor in this repo and a branch is held to it
     by the same call the trunk is: the branch profile is a square of the side
     buildStrut settled on, so trunk and branch have the SAME cross-section
     and one floor check covers both.
   - NSO_unionSoups (app-join.js). Not reimplemented, not approximated, and
     not skipped: unionParts() refuses by name when it is not loaded.

   ---------------------------------------------------------------------------
   THE GEOMETRY QUESTION, AND WHERE THE ANSWER CAME FROM
   ---------------------------------------------------------------------------
   "Where does an interface need a contact point to avoid sag" is a COVERING
   question, not a beam-deflection one: the overhang droops wherever it has to
   span too far between the things holding it up, so the contacts have to be
   placed so that no point of the region is further from one than the covering
   radius a lattice at that span achieves - span / sqrt(2), the centre of a
   cell, NOT half the span. That is the whole of it, and it is why this file
   computes a covering radius and measures the one it achieved, rather than
   integrating anything.

   THE SAG MATH FROM THE RASTER TRACER DOES NOT APPLY, and the ticket asked
   that this be settled rather than assumed. nso_raster_lines.js's "bridge"
   (collapseBridges, BRIDGE_STROKES, the `bridge <= w / sin(t)` bound) is a
   SKELETON bridge: the one-pixel stub Zhang-Suen thinning leaves where two
   drawn strokes cross. It is measured in pixels of a source image, its bound
   comes from the width of a rhombus, and it says nothing about molten
   filament over air. The word is shared; the mathematics is not, and reusing
   it would have been a pun rather than a reuse.

   What IS reused is nso_support_aim.js's own region.spanMm, which its OUT OF
   SCOPE 4 reports and explicitly declines to take a view on ("callers wanting
   it gate on region.spanMm themselves"). This file is that caller, and the
   view it takes is stated as a number below.

   ---------------------------------------------------------------------------
   THE REFERENCE: fixtures/3mf/tabletop.gcode.3mf, sliced by Bambu Studio
   ---------------------------------------------------------------------------
   Both constants below are measured off a real tree support that really
   printed, not chosen. tools/nso_support_tree_reference_check.js re-measures
   them from the file on every run and fails if this file has drifted from
   what the slicer actually did.

   The structure: a 69.9 x 69.9 mm flat overhang at z = 19.5, supported from
   the plate at z = 0.3.

     z 0.60 .. 4.50   36 islands, every layer. The TRUNK phase: the count does
                      not move for 14 layers.
     z 4.80 .. 19.20  36 -> 451, monotonically. The BRANCH phase.
     z 19.50, 19.80   Support interface: one perforated sheet at a 1.09 mm
                      line pitch, which is the 0.61 rib + 0.5 gap already
                      measured in docs/SKIN-CROSSHATCH-PITCH.md, reached here
                      from the other direction.

   So the observed pattern is exactly the one this file builds: bulk carries
   the load as far as it can, then hands off to many thin, independent
   branches that each end at one discrete point.

   MAX_SPAN_MM = 3.29. The reference's final support layer puts 451 contact
   islands under a 4892 mm^2 footprint: sqrt(4892 / 451) = 3.2935 mm of areal
   pitch. Nearest-neighbour spacing over the same 451 islands is 2.36 mm
   median and 3.94 mm at its worst, so the areal figure sits inside the range
   the structure itself uses. A square lattice at this pitch reproduces the
   reference's own contact count on the reference's own footprint to +7%.

   BRANCH_TILT_DEG = 31.44. Measured, per tip, as the angle off vertical from
   that tip to its nearest trunk: median 18.19 deg, p95 26.83 deg, and 31.44
   deg at the very worst. That worst case is the widest the proven structure
   ever leans, so it is what this file allows - not the 45 deg printable angle
   nso_support_aim.js detects overhangs at. 45 deg is kept as the CEILING and
   a caller asking past it is refused by name, because a branch leaning
   further than that is an unsupported overhang by this repo's own detector,
   and a support that needs support is not a support.

   ---------------------------------------------------------------------------
   WHERE THE TRUNK STOPS
   ---------------------------------------------------------------------------
   As high as it can. The trunk is the load path, so every millimetre it
   climbs is a millimetre no branch has to carry; the constraint is that once
   it stops, EVERY branch it hands off to must still stand within the tilt
   above. Raising the split point shortens the rise the branches have to fan
   out over, so the tilt of the widest branch grows - and the split point is
   the highest station on the trunk line at which the widest one is still
   inside the limit.

   Found by scanning the line, not by bisection, and that is deliberate: as
   the split point climbs it also moves sideways toward the fan's centre, so
   the widest branch's tilt is not monotone in the trunk length and a
   bisection would be quietly answering a different question. The scan's
   resolution is reported as splitResolutionMm rather than assumed.

   When NO station works - when even standing at the base the fan is wider
   than the tilt allows - this refuses and says how many trunks the region
   would need instead. That refusal is the honest answer and the reference
   agrees with it: one trunk cannot serve a 70 mm tabletop, which is why the
   real slice used 36.

   ---------------------------------------------------------------------------
   OUT OF SCOPE, named so the next ticket does not have to re-derive it
   ---------------------------------------------------------------------------
   1. MORE THAN ONE TRUNK. planTree() builds one trunk and its fan. It
      computes and reports trunksNeeded when one is not enough, and it stops
      there: WHERE a field of trunks should stand relative to each other is
      the layout half of nso_support_aim.js's OUT OF SCOPE 3, and placing them
      well needs a Voronoi partition of the contact set that this file does
      not attempt.
   2. BRANCHES THAT MERGE, OR BEND. Every branch here is one straight segment
      from the split point to its own contact. NSO_PathSweep takes N points,
      so a curved branch is a longer `points` array and nothing else - but
      WHICH curve, and around what, is the path search that is still nobody's
      ticket. Two branches that merge on the way down are a different solid
      again, and docs/HANDOFF.md's own note on the sweep says not to try to
      make it grow a Y: union the strands instead.
   3. CONTACT GEOMETRY. A branch ends in the same flat cap the strut does, so
      it inherits the same tipPenetrationMm, measured here per branch and
      reported. nso_support_aim.js's OUT OF SCOPE 2 and nso_seat_surface.js's
      deferred contact layer are still one unsolved thing, and this file adds
      a third caller for it rather than a third opinion.
   4. WHETHER THE SLICER COULD BRIDGE IT ANYWAY. MAX_SPAN_MM is what the
      reference structure does, not what PLA can do unsupported. A caller who
      has measured its own material passes maxSpanMm and this file uses it.

   ---------------------------------------------------------------------------
   PAINT SCOPE: SUB-REGION - inherited, not re-decided
   ---------------------------------------------------------------------------
   Detection is nso_support_aim.js's, so opts.skipList is REQUIRED here for
   exactly the reasons it is required there, and is passed straight through
   without inspection. This file names no faces of its own: the contacts it
   places all sit on triangles that detectOverhangs already flagged, so a
   painted face is out of the scan before this file ever sees the region.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   contactPoints(rawTris, region, opts)  -> { ok, points, pitchMm, ... }
   splitPoint(from, apex, contacts, opts)-> { ok, point, trunkMm, ... }
   branch(rootPoint, tip, opts)          -> { ok, soup, tiltDeg, ... }
   planTree(rawTris, opts)               -> detect + contacts + trunk + fan
   unionParts(parts, opts)               -> Promise of the app's own union
   describe(result)                      -> one status line
   ============================================================ */
(function (root) {
  'use strict';

  /* Both measured off fixtures/3mf/tabletop.gcode.3mf - see THE REFERENCE in
     the header, and tools/nso_support_tree_reference_check.js, which takes
     them out of the file again on every run. */
  var MAX_SPAN_MM = 3.29;
  var BRANCH_TILT_DEG = 31.44;

  /* How far a branch's root is sunk back along the trunk, as a multiple of
     the shared cross-section side. A branch starting exactly at the trunk's
     end cap meets it at a point: two solids touching on a plane of zero
     thickness, which is the one input a boolean kernel is entitled to refuse.
     One full side of overlap puts the branch root a whole cross-section
     inside the trunk, whatever direction the branch leaves in. */
  var ROOT_OVERLAP_SIDES = 1;

  /* And how far ACROSS the trunk it is moved, along its own heading, as a
     multiple of the same side. A branch leaves the trunk on its OWN SIDE
     rather than out of its axis, which is also what a real branch does.

     This is not cosmetic, and it was not in the first version. With every
     root on the axis, any two branches share a start point, so their side
     walls meet along a curve that pinches to nothing exactly there - and
     NSO_CSG.manifoldToSoup writes the result as float32, whose spacing at
     plate coordinates is about 2e-6 mm. Two vertices of that pinch land on
     the same float32 and the boolean's output carries a triangle with a
     repeated vertex: measured, on the multi-branch fixtures in
     tools/nso_support_tree_test.js, as 1 to 2 degenerate triangles and 2 to 6
     non-manifold edges that no weld tolerance removes, because they are in
     the buffer. With the roots spread, all three come back 0 open, 0
     non-manifold, 0 degenerate, Euler 2. The 16-branch fixture is clean
     either way, which is why this had to be measured on more than one:
     whether two particular branches pinch depends on how their walls happen
     to meet.

     0.4 is under the 0.5 half-width, so the root's centre is still inside the
     trunk's own cross-section - which is the bound that matters, and the
     reason this is not simply "as far apart as possible": at 0.45 the fixtures
     start reporting a piercing pair instead, measured the same way. */
  var ROOT_SPREAD_SIDES = 0.4;

  /* A branch this close to the trunk's own direction is not a branch: it is
     the trunk carrying on. Built as one it would be a prism coaxial with the
     trunk, its four side walls exactly coplanar with the trunk's, and a
     boolean handed two coincident coplanar walls emits slivers and
     zero-area triangles at the seam - measured, before this existed, as 2
     degenerate triangles and 2 non-manifold edges on a region whose centre
     contact sat dead on the aim. So the trunk takes that contact itself and
     the fan is the rest. One degree, because the wall coincidence is what
     matters and it is gone well before the angle is visible. */
  var COLLINEAR_DEG = 1;

  /* Stations on the trunk line for the split scan. 2048 over a trunk of
     tens of millimetres is tens of microns of resolution, which is reported
     rather than assumed - see WHERE THE TRUNK STOPS. */
  var SPLIT_STATIONS = 2048;

  /* A guard, not a parameter: a region asking for more contacts than this has
     either been handed a pitch of nearly zero or is not one region. Refused
     by name so the failure is a sentence and not a heap of branches. */
  var MAX_CONTACTS = 512;

  var EPS_MM = 1e-3;                       /* same ray epsilon as the aim */

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function unit(a) { var L = len(a); return L > 1e-15 ? mul(a, 1 / L) : null; }
  function dist(a, b) { return len(sub(a, b)); }
  function distXY(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  function finite3(p) {
    return !!p && p.length === 3 && isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]);
  }

  function aimModule(opts) {
    return (opts && opts.supportAim) || (root && root.NSO_SupportAim) ||
           (typeof NSO_SupportAim !== 'undefined' ? NSO_SupportAim : null);
  }
  function sweepModule(opts) {
    return (opts && opts.pathSweep) || (root && root.NSO_PathSweep) ||
           (typeof NSO_PathSweep !== 'undefined' ? NSO_PathSweep : null);
  }

  /* =====================================================================
     1. THE CONTACT POINTS

     A square lattice at the permitted span, clipped to the region, then
     topped up until the covering radius is actually achieved rather than
     hoped for.

     THE LATTICE IS LAID AT EXACTLY THE PITCH, CENTRED ON THE REGION'S OWN
     BOUNDING BOX. With a footprint w wide and a pitch p, ceil(w / p) sites
     spread symmetrically about the centre leave at most p between neighbours
     and at most p/2 between the outermost site and the edge - so the whole
     box is covered at the radius asked for, and a region narrower than one
     pitch gets exactly one site, at its centre. That degenerate case is what
     makes this a superset of nso_support_aim.js rather than a replacement
     for it: one contact means no split, and the result IS the single strut.

     Sites are centred rather than packed from a corner so that a symmetric
     region gets a symmetric answer. A lattice anchored at min-x would put its
     slack all at one end and hand a mirrored piece a different tree.

     A SITE LANDS ON THE REGION BY VERTICAL PROJECTION. The region's triangles
     all satisfy n.z < -cos(angleDeg) by construction - that is what flagged
     them - so none of them is anywhere near edge-on and every one projects
     onto XY without degenerating. Where several of them cover one site, the
     LOWEST is taken: a support arriving from below meets that one first, and
     aiming past it at a surface further up would drive the branch through
     solid material.

     THE COVERING RADIUS IS pitch / sqrt(2), NOT pitch / 2. The farthest a
     point can be from every site of a square lattice is the centre of a cell,
     which is half the diagonal: 2.3264 mm at the 3.29 mm span. Half the pitch
     is the gap between NEIGHBOURS, which is the quantity the reference was
     measured as and the quantity the lattice reproduces - the two are
     different numbers and conflating them would have the lattice failing its
     own covering test at the centre of every cell it lays.

     THE TOP-UP IS WHAT MAKES THE COVERING A FACT. The lattice covers the
     bounding box in plan; the region is not its bounding box, and on a tilted
     region the distance between two sites along the surface is longer than
     the distance between them in plan by 1/cos(tilt). So the region is
     SAMPLED - its triangles' vertices plus a barycentric grid over each of
     them at half the span, which is fine enough that the worst point of a
     cell cannot hide between samples - every sample is measured in 3D against
     the contacts already placed, the farthest uncovered one becomes a contact,
     and that repeats until nothing is left uncovered. The achieved radius
     comes back as coverageMm whatever happens, so a caller is never asked to
     take the covering on trust.

     Sampling the triangles rather than only their corners is not a detail. A
     flat rectangular region arrives as TWO triangles, so vertices and
     centroids are six points, none of them in the middle of a lattice cell:
     the coverage figure would have been measured where it is best and
     reported as if it were measured where it is worst.
     ===================================================================== */

  function triOf(soup, t) {
    var o = t * 9;
    return [[soup[o], soup[o + 1], soup[o + 2]],
            [soup[o + 3], soup[o + 4], soup[o + 5]],
            [soup[o + 6], soup[o + 7], soup[o + 8]]];
  }

  /* z of the triangle's plane at (x, y), or null when (x, y) is outside the
     triangle's XY projection. Barycentric, so the test and the height are one
     computation and cannot disagree. */
  function zOnTriAt(tri, x, y) {
    var ax = tri[0][0], ay = tri[0][1], bx = tri[1][0], by = tri[1][1];
    var cx = tri[2][0], cy = tri[2][1];
    var d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-12) return null;                 /* edge-on in plan */
    var u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
    var v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
    var w = 1 - u - v;
    if (u < -1e-9 || v < -1e-9 || w < -1e-9) return null;
    return u * tri[0][2] + v * tri[1][2] + w * tri[2][2];
  }

  // opts.maxSpanMm   permitted span between contacts, default MAX_SPAN_MM
  // opts.maxContacts guard, default MAX_CONTACTS
  function contactPoints(rawTris, region, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '', points: [], lattice: 0, topUp: 0 };
    if (!rawTris || !rawTris.length) { out.reason = 'no soup to read the region from'; return out; }
    if (!region || !region.tris || !region.tris.length) {
      out.reason = 'contactPoints needs a region from NSO_SupportAim.detectOverhangs';
      return out;
    }
    var pitch = (opts.maxSpanMm == null) ? MAX_SPAN_MM : +opts.maxSpanMm;
    if (!(pitch > 0)) { out.reason = 'maxSpanMm must be positive, got ' + opts.maxSpanMm; return out; }
    var cap = (opts.maxContacts == null) ? MAX_CONTACTS : (opts.maxContacts | 0);
    out.pitchMm = pitch;

    var tris = [], i, j;
    for (i = 0; i < region.tris.length; i++) tris.push(triOf(rawTris, region.tris[i]));

    var mn = [Infinity, Infinity], mx = [-Infinity, -Infinity];
    for (i = 0; i < tris.length; i++) for (j = 0; j < 3; j++) {
      if (tris[i][j][0] < mn[0]) mn[0] = tris[i][j][0];
      if (tris[i][j][0] > mx[0]) mx[0] = tris[i][j][0];
      if (tris[i][j][1] < mn[1]) mn[1] = tris[i][j][1];
      if (tris[i][j][1] > mx[1]) mx[1] = tris[i][j][1];
    }

    var nx = Math.max(1, Math.ceil((mx[0] - mn[0]) / pitch));
    var ny = Math.max(1, Math.ceil((mx[1] - mn[1]) / pitch));
    out.latticeNx = nx; out.latticeNy = ny;
    if (nx * ny > cap * 4) {
      out.reason = 'a ' + (mx[0] - mn[0]).toFixed(1) + ' x ' + (mx[1] - mn[1]).toFixed(1) +
        ' mm region at a ' + pitch + ' mm span asks for a ' + nx + ' x ' + ny +
        ' lattice, past the ' + cap + '-contact guard - raise opts.maxContacts deliberately, ' +
        'or split the region';
      return out;
    }
    var cx = (mn[0] + mx[0]) / 2, cy = (mn[1] + mx[1]) / 2;

    var pts = [];
    for (i = 0; i < nx; i++) {
      for (j = 0; j < ny; j++) {
        var x = cx + (i - (nx - 1) / 2) * pitch;
        var y = cy + (j - (ny - 1) / 2) * pitch;
        var bestZ = null;
        for (var t = 0; t < tris.length; t++) {
          var z = zOnTriAt(tris[t], x, y);
          if (z == null) continue;
          if (bestZ == null || z < bestZ) bestZ = z;      /* the underside met first */
        }
        if (bestZ != null) pts.push({ p: [x, y, bestZ], source: 'lattice' });
      }
    }
    out.lattice = pts.length;

    /* A region the lattice missed entirely - a sliver between two sites, or
       one narrow enough that its single centred site fell off it. It still
       needs holding up, so it falls back to the aim point detectOverhangs
       already pulled onto the surface, which is the single-strut answer. */
    if (!pts.length) {
      if (!finite3(region.point)) { out.reason = 'the lattice missed the region and it has no aim point'; return out; }
      pts.push({ p: region.point.slice(), source: 'region-point' });
      out.latticeMissed = true;
    }

    /* Samples: every vertex, plus a barycentric grid over every triangle at
       half the span. Deduplicated on a 1e-4 mm grid, the same weld tolerance
       detectOverhangs clusters at, so the two modules agree on what one point
       is. The subdivision is capped at 32 a side: past that the samples are
       finer than the thing being measured and the cost is quadratic. */
    var seen = new Map(), samples = [];
    function addSample(p) {
      var k = Math.round(p[0] * 1e4) + '|' + Math.round(p[1] * 1e4) + '|' + Math.round(p[2] * 1e4);
      if (seen.has(k)) return;
      seen.set(k, 1);
      samples.push(p);
    }
    for (i = 0; i < tris.length; i++) {
      var A = tris[i][0], B = tris[i][1], C = tris[i][2];
      var longest = Math.max(dist(A, B), dist(B, C), dist(C, A));
      var n = Math.max(1, Math.min(32, Math.ceil(longest / (pitch / 2))));
      for (var a = 0; a <= n; a++) {
        for (var b = 0; a + b <= n; b++) {
          var wa = a / n, wb = b / n, wc = 1 - wa - wb;
          addSample([A[0] * wa + B[0] * wb + C[0] * wc,
                     A[1] * wa + B[1] * wb + C[1] * wc,
                     A[2] * wa + B[2] * wb + C[2] * wc]);
        }
      }
    }
    out.samples = samples.length;

    var radius = pitch / Math.SQRT2;
    out.coveringRadiusMm = radius;
    var near = new Float64Array(samples.length);
    for (i = 0; i < samples.length; i++) {
      var best = Infinity;
      for (j = 0; j < pts.length; j++) { var d = dist(samples[i], pts[j].p); if (d < best) best = d; }
      near[i] = best;
    }
    while (pts.length < cap) {
      var worst = -1, at = -1;
      for (i = 0; i < samples.length; i++) if (near[i] > worst) { worst = near[i]; at = i; }
      if (!(worst > radius)) break;
      pts.push({ p: samples[at].slice(), source: 'top-up' });
      out.topUp++;
      for (i = 0; i < samples.length; i++) {
        var dd = dist(samples[i], samples[at]);
        if (dd < near[i]) near[i] = dd;
      }
    }

    var achieved = 0;
    for (i = 0; i < samples.length; i++) if (near[i] > achieved) achieved = near[i];
    out.coverageMm = achieved;
    if (achieved > radius + 1e-9) {
      out.reason = 'the ' + cap + '-contact guard was reached with ' + achieved.toFixed(3) +
        ' mm of the region still further than ' + radius.toFixed(3) + ' mm from a contact - ' +
        'raise opts.maxContacts deliberately, or loosen opts.maxSpanMm';
      return out;
    }

    /* Nearest-neighbour spacing over the contacts that came out. Reported so
       it can be put beside the reference's own 2.36 mm median directly, which
       is what tools/nso_support_tree_reference_check.js does. */
    var nn = [];
    for (i = 0; i < pts.length; i++) {
      var b2 = Infinity;
      for (j = 0; j < pts.length; j++) { if (i === j) continue; var d2 = dist(pts[i].p, pts[j].p); if (d2 < b2) b2 = d2; }
      if (isFinite(b2)) nn.push(b2);
    }
    nn.sort(function (a, b) { return a - b; });
    out.nnMm = nn.length
      ? { min: nn[0], median: nn[(nn.length / 2) | 0], max: nn[nn.length - 1], count: nn.length }
      : null;

    out.ok = true;
    out.points = pts;
    out.reason = pts.length + ' contact point(s) at a ' + pitch + ' mm span (' +
      out.lattice + ' on the lattice' + (out.topUp ? ', ' + out.topUp + ' topped up' : '') +
      '), region covered to ' + achieved.toFixed(3) + ' mm';
    return out;
  }

  /* =====================================================================
     2. WHERE THE TRUNK STOPS

     The highest station on the trunk line at which every branch it would hand
     off to is still inside the tilt. See WHERE THE TRUNK STOPS in the header
     for why this is a scan rather than a bisection.
     ===================================================================== */

  // opts.branchTiltDeg  the limit, default BRANCH_TILT_DEG, ceiling 45
  // opts.stations       scan resolution, default SPLIT_STATIONS
  function splitPoint(from, apex, contacts, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '' };
    if (!finite3(from) || !finite3(apex)) { out.reason = 'from and apex must both be finite 3-vectors'; return out; }
    if (!contacts || !contacts.length) { out.reason = 'no contact points to hand off to'; return out; }

    var SA = aimModule(opts);
    /* The ceiling is nso_support_aim.js's printable angle, read from it rather
       than restated: a branch leaning further off vertical than the angle that
       module calls an overhang IS an overhang, and would need support itself. */
    var ceiling = (SA && SA.ANGLE_DEFAULT_DEG != null) ? SA.ANGLE_DEFAULT_DEG : 45;
    var tilt = (opts.branchTiltDeg == null) ? BRANCH_TILT_DEG : +opts.branchTiltDeg;
    if (!(tilt > 0)) { out.reason = 'branchTiltDeg must be positive, got ' + opts.branchTiltDeg; return out; }
    if (tilt > ceiling) {
      out.reason = 'branchTiltDeg ' + tilt + ' is past the ' + ceiling + ' deg printable angle ' +
        'nso_support_aim.js detects overhangs at - a branch leaning further than that is an ' +
        'unsupported overhang itself, and a support that needs support is not a support';
      return out;
    }
    out.branchTiltDeg = tilt;
    out.ceilingDeg = ceiling;
    var tanMax = Math.tan(tilt * Math.PI / 180);

    var run = sub(apex, from), total = len(run);
    if (!(total > 0)) { out.reason = 'the trunk has nowhere to go: base and apex coincide'; return out; }
    var dir = mul(run, 1 / total);
    var stations = (opts.stations == null) ? SPLIT_STATIONS : (opts.stations | 0);
    if (!(stations >= 2)) { out.reason = 'need at least 2 stations, got ' + opts.stations; return out; }
    out.splitResolutionMm = total / stations;

    function widest(S) {
      var worst = -1, at = -1;
      for (var i = 0; i < contacts.length; i++) {
        var q = contacts[i].p || contacts[i];
        var rise = q[2] - S[2];
        var horiz = distXY(q, S);
        /* A contact at or below the station is not reachable by a branch that
           leans: it would have to hang downward off the trunk. Reported as an
           infinite tilt so the scan rejects the station rather than dividing
           by a rise of zero. */
        var deg = (rise > 1e-9) ? Math.atan2(horiz, rise) * 180 / Math.PI : 180;
        if (deg > worst) { worst = deg; at = i; }
      }
      return { deg: worst, index: at };
    }

    var bestT = -1, bestW = null;
    for (var k = stations; k >= 0; k--) {
      var t = total * (k / stations);
      var S = add(from, mul(dir, t));
      var w = widest(S);
      if (w.deg <= tilt) { bestT = t; bestW = w; break; }
    }

    if (bestT < 0) {
      /* Not a failure to report as a mystery: say what one trunk would have
         had to do, and how many trunks the fan would take instead. At the
         base the rise is the largest it ever gets, so the fan radius one
         trunk can serve there is rise * tan(tilt), and the contacts that fall
         outside it are the ones that need a trunk of their own. */
      var w0 = widest(from);
      var q0 = contacts[w0.index].p || contacts[w0.index];
      var rise0 = q0[2] - from[2];
      var reach = Math.max(rise0, 0) * tanMax;
      var needed = 1;
      if (reach > 1e-6) {
        var mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
        for (var c = 0; c < contacts.length; c++) {
          var p = contacts[c].p || contacts[c];
          if (p[0] < mnx) mnx = p[0];
          if (p[0] > mxx) mxx = p[0];
          if (p[1] < mny) mny = p[1];
          if (p[1] > mxy) mxy = p[1];
        }
        /* A square lattice of trunks, each serving a cell whose circumradius
           is the reach: cell side = reach * sqrt(2). */
        var cell = reach * Math.SQRT2;
        needed = Math.max(1, Math.ceil((mxx - mnx) / cell)) * Math.max(1, Math.ceil((mxy - mny) / cell));
      }
      out.trunksNeeded = needed;
      out.widestDeg = w0.deg;
      out.reason = 'one trunk cannot serve this fan: even standing at the base the widest branch ' +
        'leans ' + w0.deg.toFixed(2) + ' deg off vertical, past the ' + tilt + ' deg limit. ' +
        'The region wants about ' + needed + ' trunks, and where a field of them should stand is ' +
        'the layout half of nso_support_aim.js OUT OF SCOPE 3';
      return out;
    }

    out.ok = true;
    out.point = add(from, mul(dir, bestT));
    out.dir = dir;
    out.trunkMm = bestT;
    out.apexMm = total;
    out.trunkFraction = total > 0 ? bestT / total : 0;
    out.widestDeg = bestW.deg;
    out.widestContact = bestW.index;
    out.reason = 'the trunk stops ' + bestT.toFixed(3) + ' mm along its aim (' +
      (out.trunkFraction * 100).toFixed(1) + '% of the way to the fan centre); the widest of ' +
      contacts.length + ' branches then leans ' + bestW.deg.toFixed(2) + ' deg off vertical, ' +
      'inside the ' + tilt + ' deg limit';
    return out;
  }

  /* =====================================================================
     3. ONE BRANCH

     A two-point sweep. One segment, no joints, so the mitre arithmetic in
     NSO_PathSweep never runs and the cross-section is exact along the whole
     branch for the same reason Extend's is - see that module's header.

     The profile is the SQUARE the trunk already settled on, so trunk and
     branch have one cross-section and one wall-thickness floor between them.
     Counter-clockwise and centred on the origin, which is what profileCheck
     requires: the end caps fan from the path point, so it has to be inside
     its own ring.
     ===================================================================== */

  function squareProfile(side) {
    var h = side / 2;
    return [[-h, -h], [h, -h], [h, h], [-h, h]];
  }

  // opts.sideMm        the cross-section side; normally buildStrut's own
  // opts.targetNormal  measure the flat cap's overshoot against this
  // opts.tipEngageMm   push the tip past the contact (or, negative, stop it
  //                    short). Same name and same sign as aim()'s own, so a
  //                    caller pulling every tip back off the surface says it
  //                    once and means it for the trunk and the branches alike.
  function branch(rootPoint, tip, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '' };
    if (!finite3(rootPoint) || !finite3(tip)) { out.reason = 'branch needs two finite 3-vectors'; return out; }
    var PS = sweepModule(opts);
    if (!PS || typeof PS.sweep !== 'function') {
      out.reason = 'nso_path_sweep.js is not loaded - it is the growth mechanism a branch needs, ' +
        'because NSO_extendRaw refuses an off-cardinal axis by name and a branch leaves the ' +
        'trunk on one';
      return out;
    }
    var side = (opts.sideMm == null) ? 0 : +opts.sideMm;
    if (!(side > 0)) { out.reason = 'branch needs a positive sideMm - pass the one buildStrut settled on'; return out; }

    var run = sub(tip, rootPoint), L0 = len(run);
    if (!(L0 > 0)) { out.reason = 'branch root and tip coincide'; return out; }
    var d = mul(run, 1 / L0);
    var engage = (opts.tipEngageMm == null) ? 0 : +opts.tipEngageMm;
    var end = add(tip, mul(d, engage));
    var L = L0 + engage;
    if (!(L > 0)) {
      out.reason = 'tipEngageMm ' + engage + ' is longer than the ' + L0.toFixed(4) +
        ' mm branch, which would run it backwards out of the trunk';
      return out;
    }

    var sw = PS.sweep({ points: [rootPoint, end], profile: squareProfile(side) });
    out.sweep = sw;
    if (!sw.ok) { out.reason = 'the branch would not sweep: ' + sw.reason; return out; }

    out.ok = true;
    out.soup = sw.tris;
    out.from = rootPoint.slice();
    out.tip = end;
    out.contact = tip.slice();
    out.dir = d;
    out.lengthMm = L;
    out.tipEngageMm = engage;
    out.sideMm = side;
    /* Off VERTICAL, not off the trunk: what decides whether a branch prints is
       how far it leans away from up, and that is the same quantity
       detectOverhangs measures a face by. */
    out.tiltDeg = Math.atan2(Math.hypot(d[0], d[1]), d[2]) * 180 / Math.PI;

    /* The same flat-cap overshoot nso_support_aim.js measures on the strut,
       measured the same way on the branch: the cap is perpendicular to the
       branch and the face it lands on is not, so its far corner stands proud.
       It is a property of a flat cap, not an error in the aim, and it is
       reported for the same reason - a fifth of a millimetre is fine and two
       millimetres is a branch driven through the piece. */
    var tn = unit(opts.targetNormal || []);
    out.tipPenetrationMm = null;
    if (tn) {
      var worst = 0;
      for (var v = 0; v < sw.tris.length; v += 3) {
        var past = -((sw.tris[v] - tip[0]) * tn[0] +
                     (sw.tris[v + 1] - tip[1]) * tn[1] +
                     (sw.tris[v + 2] - tip[2]) * tn[2]);
        if (past > worst) worst = past;
      }
      out.tipPenetrationMm = worst;
    }
    out.reason = 'a ' + side.toFixed(3) + ' mm branch, ' + L.toFixed(3) + ' mm long, ' +
      out.tiltDeg.toFixed(2) + ' deg off vertical';
    return out;
  }

  /* =====================================================================
     4. THE WHOLE TREE
     ===================================================================== */

  // Everything detectOverhangs and aim take, plus:
  //   opts.maxSpanMm      permitted span between contacts
  //   opts.branchTiltDeg  the branch limit
  //   opts.regionId       which region, default the largest
  function planTree(rawTris, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '', stage: 'detect', parts: [], branches: [] };

    var SA = aimModule(opts);
    if (!SA || typeof SA.detectOverhangs !== 'function') {
      out.reason = 'nso_support_aim.js is not loaded - it owns the detection, the base search ' +
        'and the strut, and none of them is reimplemented here';
      return out;
    }

    var det = SA.detectOverhangs(rawTris, opts);
    out.detect = det;
    if (!det.ok) { out.reason = det.reason; return out; }
    if (!det.regions.length) { out.reason = det.reason; return out; }

    var idx = (opts.regionId == null) ? 0 : (opts.regionId | 0);
    var region = det.regions[idx];
    if (!region) { out.reason = 'no region with id ' + idx + ' - ' + det.regions.length + ' found'; return out; }
    out.region = region;

    out.stage = 'contacts';
    var cp = contactPoints(rawTris, region, opts);
    out.contacts = cp;
    if (!cp.ok) { out.reason = cp.reason; return out; }

    var bases = opts.bases || [{ kind: 'plate', z: det.plateZ }];
    var obstacles = opts.obstacles || [rawTris].concat(opts.occluders || []);

    /* THE SINGLE-CONTACT CASE IS THE OLD FEATURE, UNCHANGED. A region narrow
       enough to need one contact has no fan, so there is nothing to split and
       nothing to branch: the answer is one straight strut aimed at that point,
       which is exactly what nso_support_aim.js already builds. It is returned
       as such rather than as a tree with an empty branch list dressed up. */
    var single = cp.points.length === 1;

    /* The fan's centre, which is where the trunk points. Not the region's own
       aim point: with a fan, the thing the trunk has to get under is the set
       of contacts, and their centroid is the direction that leaves every
       branch the shortest reach. */
    var apex = [0, 0, 0], i;
    for (i = 0; i < cp.points.length; i++) apex = add(apex, cp.points[i].p);
    apex = mul(apex, 1 / cp.points.length);
    out.apex = apex;

    out.stage = 'base';
    var nb = SA.nearestBase(single ? cp.points[0].p : apex, bases,
      Object.assign({}, opts, { obstacles: obstacles }));
    out.base = nb;
    if (!nb.ok) { out.reason = nb.reason; return out; }

    /* The trunk is aimed from the base nearestBase picked, and from that one
       only. Re-offering the whole list to aim() would let it settle on a
       different base for the split point than the fan was measured against,
       and the tilt figures would then be about a trunk nobody built. */
    var chosen = [nb.base];

    var target = single ? cp.points[0].p : null;
    var carried = -1;                     /* the contact the trunk takes itself */
    if (!single) {
      out.stage = 'split';
      var sp = splitPoint(nb.from, apex, cp.points, opts);
      out.split = sp;
      if (!sp.ok) { out.reason = sp.reason; out.trunksNeeded = sp.trunksNeeded; return out; }
      target = sp.point;

      /* A CONTACT ON THE TRUNK'S OWN AXIS IS THE TRUNK'S, NOT A BRANCH'S - see
         COLLINEAR_DEG. A symmetric region with an odd lattice count puts one
         contact dead on the aim every time, so this is the ordinary case and
         not a corner one. The trunk grows past its split point to reach it;
         the split point is still where the fan leaves, which is the thing
         that was computed. The farthest of them is taken when several line
         up, because the trunk passing through the nearer ones covers them. */
      var far = -1;
      for (i = 0; i < cp.points.length; i++) {
        var away = unit(sub(cp.points[i].p, sp.point));
        if (!away) continue;
        var offDeg = Math.acos(Math.min(1, Math.max(-1, dot(away, sp.dir)))) * 180 / Math.PI;
        if (offDeg > COLLINEAR_DEG) continue;
        var reach = dist(cp.points[i].p, nb.from);
        if (reach > far) { far = reach; carried = i; }
      }
      if (carried >= 0) target = cp.points[carried].p;
      out.trunkCarriesContact = carried;
    }

    out.stage = 'trunk';
    var trunkOpts = Object.assign({}, opts, { bases: chosen, obstacles: obstacles });
    if ((single || carried >= 0) && trunkOpts.targetNormal === undefined) {
      trunkOpts.targetNormal = region.normal;
    }
    var trunk = SA.aim(target, chosen, trunkOpts);
    out.trunk = trunk;
    if (!trunk.ok) {
      out.reason = 'the trunk would not reach ' +
        (single ? 'the one contact point' :
         carried >= 0 ? 'the contact on its own axis' : 'its split point') +
        ': ' + trunk.reason;
      return out;
    }
    out.parts.push(trunk.soup);
    out.sideMm = trunk.sideMm;

    if (single) {
      out.ok = true;
      out.stage = 'done';
      out.single = true;
      out.reason = det.reason + '; one contact point, so no split: ' + trunk.reason;
      return out;
    }

    /* Each branch starts one cross-section back down the trunk and a little
       across it, onto its own side - see ROOT_OVERLAP_SIDES and
       ROOT_SPREAD_SIDES. The back-off gives the union a solid overlap to work
       on instead of two caps meeting on a plane of zero thickness; the spread
       stops any two branches sharing a start point. */
    out.stage = 'branches';
    var overlap = ROOT_OVERLAP_SIDES * trunk.sideMm;
    var spread = ROOT_SPREAD_SIDES * trunk.sideMm;
    var collar = add(out.split.point, mul(trunk.dir, -overlap));
    out.branchRoot = collar;
    out.rootOverlapMm = overlap;
    out.rootSpreadMm = spread;

    var blocked = [];
    for (i = 0; i < cp.points.length; i++) {
      if (i === carried) continue;                 /* the trunk is taking this one */
      var q = cp.points[i].p;

      /* The branch's own side of the trunk: the part of its heading that is
         across the trunk rather than along it. A branch with no such part is
         the collinear case, which the trunk already took. */
      var head = unit(sub(q, collar));
      var across = head ? unit(sub(head, mul(trunk.dir, dot(head, trunk.dir)))) : null;
      var rootPoint = across ? add(collar, mul(across, spread)) : collar;

      var br = branch(rootPoint, q, Object.assign({}, opts, {
        sideMm: trunk.sideMm, targetNormal: region.normal
      }));
      if (!br.ok) { blocked.push({ index: i, why: br.reason }); continue; }

      /* THE CLEARANCE TEST IS RUN ON THE BRANCH'S OWN RAILS AS WELL AS ITS
         AXIS. nearestBase tests one centre line, which is the right test for
         choosing between bases and too little for a solid 1.2 mm across: a
         branch threading a gap narrower than itself has a clear centre line
         and a body through the wall. NSO_PathSweep already built the four
         rails the solid is made of, so they are what gets cast rather than a
         circumscribed cylinder that would refuse branches that fit.

         THE RAILS ARE TESTED OVER THE SHAFT, NOT THE WHOLE BRANCH - the last
         cross-section is left out. That is not a softened gate, it is the
         only coherent one: the cap is flat and perpendicular to the branch,
         the face it lands on is not, so on any oblique branch the leading
         rails stand proud of the target by design. Measured before this
         exclusion existed, EVERY branch on all three fixtures was "blocked
         0.4 mm short" - by the overhang it was aiming at. What the cap does
         in that last cross-section is tipPenetrationMm's business, measured
         and reported per branch, exactly as nso_support_aim.js reports it for
         the strut. Both ends are excluded by one epsilon besides, for the
         reason nearestBase excludes them.

         A branch shorter than one cross-section has no shaft and is tested on
         its axis alone; it is also a branch that is almost entirely cap, and
         the tip measurement is the one that means anything about it. */
      var rings = br.sweep.rings, j;
      var shaft = br.lengthMm - trunk.sideMm;
      var probes = [[rootPoint, br.dir, br.lengthMm - EPS_MM, 'the axis']];
      if (shaft > 2 * EPS_MM) {
        for (j = 0; j < rings[0].length; j++) {
          probes.push([rings[0][j], br.dir, shaft - EPS_MM, 'rail ' + j]);
        }
      }
      var stop = null;
      for (j = 0; j < probes.length && !stop; j++) {
        var hit = SA._nearestHit(obstacles, probes[j][0], probes[j][1], EPS_MM, probes[j][2]);
        if (hit > 0) {
          stop = { at: hit, why: probes[j][3] + ' is blocked ' + hit.toFixed(3) + ' mm along, ' +
                   (probes[j][2] - hit).toFixed(3) + ' mm short of the end of its run' };
        }
      }
      if (stop) {
        blocked.push({ index: i, at: stop.at, why: stop.why });
        continue;
      }

      br.contactIndex = i;
      out.branches.push(br);
      out.parts.push(br.soup);
    }
    out.blocked = blocked;
    out.probesPerBranch = 1 + squareProfile(trunk.sideMm).length;   /* the axis, and one per rail */

    if (!out.branches.length) {
      out.reason = 'the trunk reached ' + (carried >= 0 ? 'its own contact' : 'its split point') +
        ' and not one of the ' + (cp.points.length - (carried >= 0 ? 1 : 0)) +
        ' branches could leave it: ' + (blocked[0] ? blocked[0].why : 'no reason recorded');
      return out;
    }

    var tilts = out.branches.map(function (b) { return b.tiltDeg; }).sort(function (a, b) { return a - b; });
    var lens = out.branches.map(function (b) { return b.lengthMm; });
    var pen = 0;
    for (i = 0; i < out.branches.length; i++) {
      if (out.branches[i].tipPenetrationMm > pen) pen = out.branches[i].tipPenetrationMm;
    }
    out.tiltDeg = { min: tilts[0], median: tilts[(tilts.length / 2) | 0], max: tilts[tilts.length - 1] };
    out.branchLengthMm = { min: Math.min.apply(null, lens), max: Math.max.apply(null, lens) };
    out.worstTipPenetrationMm = pen;

    out.ok = true;
    out.stage = 'done';
    out.reason = det.reason + '; ' + cp.reason + '; ' + out.split.reason + '; ' +
      out.branches.length + ' branch(es)' + (blocked.length ? ', ' + blocked.length + ' refused' : '') +
      ', ' + out.tiltDeg.min.toFixed(2) + '..' + out.tiltDeg.max.toFixed(2) + ' deg off vertical';
    return out;
  }

  /* =====================================================================
     5. THE UNION

     The app's own boolean, reached the same way grow() reaches Extend: by
     name, from the same global the Complete Join button calls, and refused by
     name when it is not there. A trunk and its branches that are merely
     stacked in an array are a pile of solids, and a slicer handed a pile of
     solids in contact prints the seams as seams.

     Folded left to right rather than pairwise: the trunk is in every
     intermediate result, so every branch is unioned against something it
     genuinely overlaps. A pairwise tree would union branch to branch first,
     and two branches leaving one trunk in different directions do not touch.
     ===================================================================== */

  function unionParts(parts, opts) {
    opts = opts || {};
    var U = (opts.unionSoups) || (root && root.NSO_unionSoups) ||
            (typeof NSO_unionSoups !== 'undefined' ? NSO_unionSoups : null);
    if (typeof U !== 'function') {
      return Promise.resolve({ ok: false, soup: null,
        reason: 'app-join.js is not loaded - NSO_unionSoups is the app\'s one boolean and ' +
          'nothing here reimplements or approximates it' });
    }
    if (!parts || !parts.length) {
      return Promise.resolve({ ok: false, soup: null, reason: 'nothing to union' });
    }
    if (parts.length === 1) {
      return Promise.resolve({ ok: true, soup: parts[0], steps: 0, reason: 'one part, nothing to union' });
    }
    var acc = parts[0], step = 0;
    function next(i) {
      if (i >= parts.length) {
        return { ok: true, soup: acc, steps: step,
          reason: step + ' union(s) over ' + parts.length + ' parts, ' +
            ((acc.length / 9) | 0) + ' triangles' };
      }
      return U(acc, parts[i]).then(function (r) {
        step++;
        if (!r || !r.ok) {
          return { ok: false, soup: null, steps: step,
            reason: 'union step ' + step + ' of ' + (parts.length - 1) + ' failed: ' +
              ((r && r.reason) || 'no reason given') };
        }
        acc = r.soup;
        return next(i + 1);
      });
    }
    return Promise.resolve(next(1));
  }

  function describe(res) {
    if (!res) return 'no result';
    if (!res.ok) return 'Support tree refused - ' + (res.reason || 'no reason given');
    return 'Support tree: ' + res.reason;
  }

  var api = {
    MAX_SPAN_MM: MAX_SPAN_MM,
    BRANCH_TILT_DEG: BRANCH_TILT_DEG,
    COLLINEAR_DEG: COLLINEAR_DEG,
    ROOT_OVERLAP_SIDES: ROOT_OVERLAP_SIDES,
    ROOT_SPREAD_SIDES: ROOT_SPREAD_SIDES,
    MAX_CONTACTS: MAX_CONTACTS,
    contactPoints: contactPoints,
    splitPoint: splitPoint,
    branch: branch,
    planTree: planTree,
    unionParts: unionParts,
    describe: describe,
    /* exposed for the tests, not for callers */
    _zOnTriAt: zOnTriAt,
    _squareProfile: squareProfile
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SupportTree = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
