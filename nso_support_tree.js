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
     by the same call the trunk is. buildStrut's side is the PLANNING section
     (roots, spread, clearance of the plan); the solids themselves are round
     and tapered by the measured diameter law by default - see SECTIONS - and
     'square' keeps the planning square as the solid too.
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
      reported. The 'gecko-hand' style (3b) is a shape option layered on
      that cap, not an answer to this: it claims nothing about printing.
      nso_support_aim.js's OUT OF SCOPE 2 and nso_seat_surface.js's
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
   branch(rootPoint, tip, opts)          -> { ok, soup, parts, tiltDeg, ... }
   opts.branchStyle                      'square' (default) or 'gecko-hand', see 3b
   planTree(rawTris, opts)               -> detect + contacts + trunk + fan
   unionParts(parts, opts)               -> Promise of the app's own union
   opts.section                          'round' (default: tapered by the measured
                                         law) or 'square', see SECTIONS
   opts.hollow                           planTree also bores every part, see 6
   hollowParts(plan, opts)               -> { ok, parts, hollowed, solid, ... }
   hollowTree(plan, opts)                -> Promise of union(parts) - union(bores)
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

  /* BRANCH STYLES - what a contact's tip LOOKS like, and nothing else.
     'square' is the shipped shape, and the default. 'gecko-hand' adds a hand
     at each contact point - see 3b. GECKO HAND. Neither one moves a contact,
     the split point, the trunk, a branch's root, heading, length or tilt: the
     style is read only after all of that is decided, and
     tools/nso_support_tree_test.js section 7b asserts the two plans are
     identical in every one of those numbers on every fixture. */
  var BRANCH_STYLES = ['square', 'gecko-hand'];

  /* SECTIONS - what a trunk or branch is in cross-section, along its length.

     'round' is the default: a regular ROUND_SIDES-gon of the same AREA as a
     circle of the law's diameter, tapering along the part by the law below.
     'square' is the constant 1.2 mm strut this file shipped first, kept so
     the two can be compared and so the square facts the older suites pin
     stay pinned.

     Neither changes the PLAN. Contacts, the split, the trunk's base and axis,
     every branch's root, heading, length and tilt are decided first, on the
     planning side buildStrut settled (1.2 mm), exactly as before; the
     section is read only when the solids are made. The one thing a fatter
     solid can change is clearance - a round part is tested on its own
     rails, and one that would run into the piece keeps the square section
     the plan already cleared, named in plan.sectionFallback. Nothing planned
     moves and nothing is dropped. */
  var SECTIONS = ['round', 'square'];
  var ROUND_SIDES = 24;

  /* THE DIAMETER LAW, measured off the real reference and re-derived on every
     run by tools/nso_support_tree_shape_check.js (docs/SUPPORT-TREE-SHAPE.md):

        d = TIP_DIAMETER_MM + 2 tan(DIAMETER_ANGLE_DEG) x (height below the tip)

     one linear law for trunk AND branch (eqD = 1.97 + 0.172 x depth, r2
     0.988, on 1,824 slices of tabletop.gcode.3mf). Both numbers are that
     slice's own settings - tree_support_branch_diameter = 2 and
     tree_support_branch_diameter_angle = 5 - which is what the toolpath
     turned out to honour. A caller passes tipDiameterMm / diameterAngleDeg to
     use its own. The base foot the reference also has (+1.35 mm at the
     plate, gone by z 1.8) is NOT this law and is not built here. */
  var TIP_DIAMETER_MM = 2;
  var DIAMETER_ANGLE_DEG = 5;

  /* The hand's proportions, as multiples of the shared cross-section side so
     the hand scales with the strut it grows from. Chosen, not measured - this
     is the shape option, and the reference slice has no opinion on it.
       FINGERS          five, the gecko's own count
       FAN_DEG          the arc the fingers splay over, centred on the
                        branch's outward heading (a hand reaching, not a
                        star); a vertical tip has no heading and gets the
                        full circle instead
       KNUCKLE_SIDES    how far back down the shaft the fingers leave it
       REACH_SIDES      how far out from the contact the fingertips land, in
                        the plane of the surface being supported
       ROOT_SIDES       how far off the shaft axis each finger's root sits,
                        toward its own fingertip - the same no-shared-start-
                        point reason as ROOT_SPREAD_SIDES. Small, because it
                        is the root CAP that has to stay inside the shaft,
                        not just its centre: offset plus the hexagon's
                        circumradius must be under the 0.5 half-width, and
                        geckoHand refuses by name when it is not. At 0.25
                        the first version put the cap 0.646 mm out on a
                        0.6 mm half-width, poking through the shaft wall
                        beside a rail; on the shelf fixture the union then
                        carried a cluster of vertices microns apart along
                        that rail, and the default 1e-4 weld read 2 open
                        edges there - measured, and gone at 0.1
       WIDTH_SIDES      the finger's hexagon, across its flats; never under
                        the wall-thickness floor the trunk was held to */
  var GECKO = {
    FINGERS: 5,
    FAN_DEG: 216,
    KNUCKLE_SIDES: 1,
    REACH_SIDES: 1,
    ROOT_SIDES: 0.1,
    WIDTH_SIDES: 0.5
  };

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

  function sectionOf(opts) {
    var s = (opts && opts.section != null) ? String(opts.section) : 'round';
    return SECTIONS.indexOf(s) >= 0 ? s : null;
  }

  /* d(z) for a part whose tip is at zTip: the law, never under the tip
     diameter (a point above its own tip - a tip engaged past the contact -
     is at the tip diameter). */
  function lawOf(opts) {
    var tipD = (opts && opts.tipDiameterMm != null) ? +opts.tipDiameterMm : TIP_DIAMETER_MM;
    var ang = (opts && opts.diameterAngleDeg != null) ? +opts.diameterAngleDeg : DIAMETER_ANGLE_DEG;
    var per = 2 * Math.tan(ang * Math.PI / 180);
    return {
      tipMm: tipD, angleDeg: ang, perMm: per,
      at: function (z, zTip) { return tipD + per * Math.max(0, zTip - z); }
    };
  }

  /* A regular n-gon with the AREA of a circle of diameter d - the reference's
     diameter is an area-equivalent one, so this is the like-for-like shape. */
  function roundProfile(d, n) {
    n = n || ROUND_SIDES;
    var R = (d / 2) * Math.sqrt((2 * Math.PI / n) / Math.sin(2 * Math.PI / n));
    var out = [];
    for (var k = 0; k < n; k++) {
      var a = 2 * Math.PI * k / n;
      out.push([R * Math.cos(a), R * Math.sin(a)]);
    }
    return { profile: out, circumMm: R, apothemMm: R * Math.cos(Math.PI / n) };
  }

  /* A straight round frustum from `from` (diameter dFrom) to `to` (dTo),
     through NSO_PathSweep's taper. */
  function roundPart(PS, from, to, dFrom, dTo) {
    var rp = roundProfile(dFrom);
    var sw = PS.sweep({ points: [from, to], profile: rp.profile, scales: [1, dTo / dFrom] });
    return {
      sweep: sw, ok: sw.ok, reason: sw.reason, soup: sw.tris,
      axis: { from: from.slice(), to: to.slice(), a0: rp.apothemMm, a1: rp.apothemMm * dTo / dFrom },
      dFromMm: dFrom, dToMm: dTo
    };
  }

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
  // opts.branchStyle   'square' (default) or 'gecko-hand' - see 3b
  // opts.floorMm       gecko-hand only: the floor a finger may not go under
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
    var style = styleOf(opts);
    if (!style) {
      out.reason = 'unknown branchStyle ' + JSON.stringify(opts.branchStyle) + ' - one of ' +
        BRANCH_STYLES.join(', ');
      return out;
    }
    var section = sectionOf(opts);
    if (!section) {
      out.reason = 'unknown section ' + JSON.stringify(opts.section) + ' - one of ' + SECTIONS.join(', ');
      return out;
    }

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

    /* The tip of the law is the CONTACT, not the engaged end: a caller that
       pushes the tip past the surface gets the tip diameter there, not a
       narrower one. */
    var sw, law = null;
    if (section === 'round') {
      law = lawOf(opts);
      var zTip = (opts.zTipMm == null) ? tip[2] : +opts.zTipMm;
      var rp = roundPart(PS, rootPoint, end, law.at(rootPoint[2], zTip), law.at(end[2], zTip));
      sw = rp.sweep;
      out.axis = rp.axis;
      out.dFromMm = rp.dFromMm;
      out.dToMm = rp.dToMm;
    } else {
      sw = PS.sweep({ points: [rootPoint, end], profile: squareProfile(side) });
      out.axis = { from: rootPoint.slice(), to: end.slice(), a0: side / 2, a1: side / 2 };
    }
    out.sweep = sw;
    out.section = section;
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
    out.style = style;
    out.parts = [out.soup];
    if (style === 'gecko-hand') {
      /* The hand is ADDED at the tip the square branch already reaches: the
         shaft above is the default branch, byte for byte, so the contact, the
         axis, the tilt and the flat cap's own overshoot are all unchanged. */
      /* At the PLANNING side whatever the section: the hand is the tip shape
         tree:test 7b validated, and it stays byte for byte that hand. Sized
         to a round tip's 2 mm instead, its fingers reach 2 mm and bridge
         into the neighbouring contacts 3.29 mm away - measured as through-
         holes (Euler -74 on the shelf) closing loops through the tree. */
      var hand = geckoHand(end, d, side, {
        normal: opts.targetNormal, floorMm: opts.floorMm, shaftMm: L, pathSweep: PS
      });
      if (!hand.ok) { out.ok = false; out.reason = 'the gecko hand would not build: ' + hand.reason; return out; }
      out.hand = hand;
      out.parts = out.parts.concat(hand.fingers.map(function (f) { return f.soup; }));
      out.fingerPenetrationMm = tn ? handPenetration(hand, tip, tn) : null;
    }
    out.reason = (section === 'round'
        ? 'a round branch ' + out.dFromMm.toFixed(3) + ' -> ' + out.dToMm.toFixed(3) + ' mm across, '
        : 'a ' + side.toFixed(3) + ' mm branch, ') + L.toFixed(3) + ' mm long, ' +
      out.tiltDeg.toFixed(2) + ' deg off vertical' +
      (out.hand ? ', ending in a ' + out.hand.fingers.length + '-finger gecko hand' : '');
    return out;
  }

  /* =====================================================================
     3b. GECKO HAND - an alternate tip, and ONLY a tip

     What the 'gecko-hand' style adds at a contact point. The square branch
     is built first, exactly as the default builds it, and still ends on the
     contact with its flat cap; the hand is GECKO.FINGERS extra swept
     solids that leave the shaft a knuckle's depth below the tip and splay
     out to fingertips lying in the plane of the surface being held up,
     centred on the contact. So the contact point, and the count of them, is
     the default's - the hand is that one contact's pad, drawn as a hand.

     Every finger is one more two-point NSO_PathSweep, for the reason the
     branch is: one segment, no mitre, an exact cross-section. The section is
     a regular HEXAGON - convex, counter-clockwise, containing its origin, so
     profileCheck takes it - and its across-flats width is never under the
     wall-thickness floor the trunk was held to, so a finger is not a feature
     the thickness check would call too thin to print.

     The fingers are separate parts, not welded into the branch here: the
     union is still NSO_unionSoups, folded left, and each finger's root sits
     inside the shaft so every one genuinely overlaps what it is unioned
     against. Roots are spread off the axis toward their own fingertip for
     ROOT_SPREAD_SIDES' reason - two sweeps sharing a start point pinch.
     ===================================================================== */

  function hexProfile(acrossFlats) {
    var r = acrossFlats / Math.sqrt(3), p = [];
    for (var k = 0; k < 6; k++) {
      var a = (30 + 60 * k) * Math.PI / 180;
      p.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return p;
  }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }

  // end     the point the shaft ends at (the contact, plus any tipEngageMm)
  // dir     the shaft's unit heading
  // side    the shaft's cross-section side
  // opts.normal    the supported surface's normal - the fingertips lie in its
  //                plane; without one, the plane square to the shaft
  // opts.floorMm   the wall-thickness floor a finger may not go under
  // opts.shaftMm   the shaft's own length; the knuckle stays inside its half
  function geckoHand(end, dir, side, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '', fingers: [] };
    var PS = sweepModule(opts);
    if (!PS || typeof PS.sweep !== 'function') { out.reason = 'nso_path_sweep.js is not loaded'; return out; }
    var d = unit(dir);
    if (!finite3(end) || !d || !(side > 0)) { out.reason = 'a hand needs a finite tip, a heading and a side'; return out; }

    /* The fingertips' plane. A surface normal nearly square to the shaft
       would lay the fingers along the shaft itself, so that one falls back. */
    var n = unit(opts.normal || []);
    if (!n || Math.abs(dot(n, d)) < 0.1) n = mul(d, -1);

    /* The heading the fan is centred on: the shaft's own lean, laid into the
       plane. A shaft standing square to the plane has none, and gets the
       full circle rather than an arbitrary half of it. */
    var h = sub(d, mul(n, dot(d, n))), full = false;
    if (len(h) < 1e-6) {
      full = true;
      var ax = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
      h = sub(ax, mul(n, dot(ax, n)));
    }
    h = unit(h);
    var g = cross(n, h);

    var width = Math.max(GECKO.WIDTH_SIDES * side, (opts.floorMm > 0) ? +opts.floorMm : 0);
    var profile = hexProfile(width);
    var rootOff = GECKO.ROOT_SIDES * side;
    if (!(rootOff + width / Math.sqrt(3) < side / 2)) {
      out.reason = 'a ' + width.toFixed(3) + ' mm finger cannot start inside a ' + side.toFixed(3) +
        ' mm shaft - its root cap would stand out through the shaft wall';
      return out;
    }
    var knuckle = GECKO.KNUCKLE_SIDES * side;
    if (opts.shaftMm > 0) knuckle = Math.min(knuckle, opts.shaftMm / 2);
    var reach = GECKO.REACH_SIDES * side;
    var base = add(end, mul(d, -knuckle));

    var F = GECKO.FINGERS;
    for (var k = 0; k < F; k++) {
      var deg = full ? k * 360 / F : -GECKO.FAN_DEG / 2 + k * GECKO.FAN_DEG / (F - 1);
      var a = deg * Math.PI / 180;
      var u = add(mul(h, Math.cos(a)), mul(g, Math.sin(a)));
      var tipPt = add(end, mul(u, reach));
      var rad = unit(sub(u, mul(d, dot(u, d))));
      var from = rad ? add(base, mul(rad, rootOff)) : base;
      var sw = PS.sweep({ points: [from, tipPt], profile: profile });
      if (!sw.ok) { out.reason = 'finger ' + k + ' would not sweep: ' + sw.reason; return out; }
      var run = sub(tipPt, from), L = len(run);
      out.fingers.push({
        index: k, soup: sw.tris, sweep: sw, from: from, to: tipPt,
        dir: mul(run, 1 / L), lengthMm: L, fanDeg: deg
      });
    }
    out.ok = true;
    out.widthMm = width;
    out.sectionAreaMm2 = 1.5 * Math.sqrt(3) * Math.pow(width / Math.sqrt(3), 2);
    out.knuckleMm = knuckle;
    out.reachMm = reach;
    out.fullCircle = full;
    out.normal = n;
    out.reason = F + ' fingers, ' + width.toFixed(3) + ' mm across, reaching ' + reach.toFixed(3) +
      ' mm from the contact';
    return out;
  }

  /* The flat-cap overshoot of section 3, measured over every finger: how far
     any finger vertex stands past the supported surface's plane. */
  function handPenetration(hand, tip, tn) {
    var worst = 0;
    for (var f = 0; f < hand.fingers.length; f++) {
      var s = hand.fingers[f].soup;
      for (var v = 0; v < s.length; v += 3) {
        var past = -((s[v] - tip[0]) * tn[0] + (s[v + 1] - tip[1]) * tn[1] + (s[v + 2] - tip[2]) * tn[2]);
        if (past > worst) worst = past;
      }
    }
    return worst;
  }

  /* The clearance probe of section 4, for any one swept part: its axis over
     the whole run, and its rails over the shaft - everything but the last
     cross-section, which is the cap's business. Returns null when clear. */
  function probeClear(SA, obstacles, from, dir, lengthMm, rails, capMm) {
    var probes = [[from, dir, lengthMm - EPS_MM, 'the axis']];
    var shaft = lengthMm - capMm;
    if (shaft > 2 * EPS_MM) {
      for (var j = 0; j < rails.length; j++) probes.push([rails[j], dir, shaft - EPS_MM, 'rail ' + j]);
    }
    for (j = 0; j < probes.length; j++) {
      var hit = SA._nearestHit(obstacles, probes[j][0], probes[j][1], EPS_MM, probes[j][2]);
      if (hit > 0) {
        return { at: hit, why: probes[j][3] + ' is blocked ' + hit.toFixed(3) + ' mm along, ' +
                 (probes[j][2] - hit).toFixed(3) + ' mm short of the end of its run' };
      }
    }
    return null;
  }

  /* A hand's fingers are clearance-tested like a branch, and one that would
     run into the piece is LEFT OFF rather than refusing the branch: the
     fingers are the tip's shape, not its contact, so losing one changes what
     the tip looks like and nothing about what holds the overhang up. */
  function clearFingers(SA, obstacles, hand) {
    var kept = [], dropped = [];
    for (var f = 0; f < hand.fingers.length; f++) {
      var fi = hand.fingers[f];
      var stop = probeClear(SA, obstacles, fi.from, fi.dir, fi.lengthMm, fi.sweep.rings[0], hand.widthMm);
      if (stop) dropped.push({ index: fi.index, at: stop.at, why: 'finger ' + fi.index + ': ' + stop.why });
      else kept.push(fi);
    }
    hand.fingers = kept;
    hand.dropped = dropped;
    return hand;
  }

  /* WALL CLEARANCE - a contact's tip kept clear of the piece's SIDE walls.

     contactPoints() places contacts over the overhang's own footprint and
     knows nothing about what rises beside it. On the tape piece that put a
     contact 0.74 mm from a wall: a 2 mm round tip there reaches 0.26 mm INTO
     the wall, inside the last cross-section a branch's rail probe leaves out
     as cap. Bambu keeps its supports support_object_xy_distance off the
     object for the same reason. So, with opts.wallClearanceMm (the air gap
     the tip must keep), every contact is tested with horizontal rays at a few
     heights over its tip's last 3 mm, each against the tip's own radius at
     that height (the diameter law for 'round', the square's half-diagonal
     otherwise) plus the clearance; a contact that is too close is moved
     inward, straight away from the nearest wall, and dropped back onto the
     region. Every move is reported, in mm. A contact that cannot be cleared
     without leaving the region is refused by name. */
  function clearWalls(SA, rawTris, region, points, opts) {
    var out = { ok: false, reason: '', moved: [], clearanceMm: +opts.wallClearanceMm };
    var gap = out.clearanceMm, law = lawOf(opts), round = sectionOf(opts) === 'round';
    var side = (opts.sideMm == null) ? 1.2 : +opts.sideMm;
    var tris = region.tris.map(function (t) { return triOf(rawTris, t); });
    var obstacles = [rawTris];
    var LEVELS = [0.01, 0.3, 0.6, 1.0, 1.5, 2.0, 3.0], DIRS = 24;
    function radius(depth, zTip) {
      return round ? law.at(zTip - depth, zTip) / 2 : side / Math.SQRT2;
    }
    function onRegion(x, y) {
      var best = null;
      for (var t = 0; t < tris.length; t++) {
        var z = zOnTriAt(tris[t], x, y);
        if (z != null && (best == null || z < best)) best = z;
      }
      return best;
    }
    function worst(q) {
      var w = null;
      for (var li = 0; li < LEVELS.length; li++) {
        var z = q[2] - gap - LEVELS[li], need = radius(gap + LEVELS[li], q[2]) + gap;
        for (var k = 0; k < DIRS; k++) {
          var a = 2 * Math.PI * k / DIRS, d = [Math.cos(a), Math.sin(a), 0];
          var hit = SA._nearestHit(obstacles, [q[0], q[1], z], d, EPS_MM, need + 1);
          if (hit > 0 && hit < need && (!w || need - hit > w.short)) w = { dir: d, short: need - hit, at: hit, z: z, need: need };
        }
      }
      return w;
    }
    for (var i = 0; i < points.length; i++) {
      var q = points[i].p.slice(), start = q.slice(), total = 0, guard = 0, w;
      while ((w = worst(q)) && guard++ < 12) {
        var step = w.short + 0.01;
        var nx = q[0] - w.dir[0] * step, ny = q[1] - w.dir[1] * step, nz = onRegion(nx, ny);
        if (nz == null) {
          out.reason = 'contact ' + i + ' is ' + w.at.toFixed(3) + ' mm from a wall where its tip needs ' +
            w.need.toFixed(3) + ' mm, and moving it clear would take it off the overhang';
          return out;
        }
        q = [nx, ny, nz]; total += step;
      }
      if (w) { out.reason = 'contact ' + i + ' could not be cleared in 12 moves'; return out; }
      if (total > 0) {
        out.moved.push({ index: i, from: start, to: q.slice(), mm: Math.hypot(q[0] - start[0], q[1] - start[1]) });
        points[i].p = q;
        points[i].source = (points[i].source || '') + '+cleared';
      }
    }
    out.ok = true;
    out.reason = out.moved.length
      ? out.moved.length + ' contact(s) moved clear of a wall: ' +
        out.moved.map(function (m) { return 'contact ' + m.index + ' by ' + m.mm.toFixed(3) + ' mm'; }).join(', ')
      : 'every contact already clear of the walls by ' + gap + ' mm';
    return out;
  }

  /* probeClear for a TAPERED part: the rails of a frustum converge, so each
     is cast along its own line - ring 0 to ring 1 - rather than parallel to
     the axis from ring 0, which would test a wider solid than the one built.
     The last capMm of each rail is the cap's business, as in probeClear. */
  function probeRails(SA, obstacles, from, dir, lengthMm, rings, capMm) {
    var probes = [[from, dir, lengthMm - EPS_MM, 'the axis']];
    var A = rings[0], B = rings[rings.length - 1];
    for (var j = 0; j < A.length; j++) {
      var v = sub(B[j], A[j]), Lr = len(v), shaft = Lr - capMm;
      if (shaft > 2 * EPS_MM) probes.push([A[j], mul(v, 1 / Lr), shaft - EPS_MM, 'rail ' + j]);
    }
    for (j = 0; j < probes.length; j++) {
      var hit = SA._nearestHit(obstacles, probes[j][0], probes[j][1], EPS_MM, probes[j][2]);
      if (hit > 0) {
        return { at: hit, why: probes[j][3] + ' is blocked ' + hit.toFixed(3) + ' mm along, ' +
                 (probes[j][2] - hit).toFixed(3) + ' mm short of the end of its run' };
      }
    }
    return null;
  }

  function styleOf(opts) {
    var s = (opts && opts.branchStyle != null) ? String(opts.branchStyle) : 'square';
    return BRANCH_STYLES.indexOf(s) >= 0 ? s : null;
  }

  /* =====================================================================
     4. THE WHOLE TREE
     ===================================================================== */

  // Everything detectOverhangs and aim take, plus:
  //   opts.maxSpanMm      permitted span between contacts
  //   opts.branchTiltDeg  the branch limit
  //   opts.regionId       which region, default the largest
  //   opts.hollow         true: also hollow every part - see 6. HOLLOW. The
  //                       plan itself is planned first, exactly as without
  //                       it; hollowing is read after all of it is settled
  function planTree(rawTris, opts) {
    var p = planSolid(rawTris, opts);
    if (p.ok && opts && opts.hollow) {
      p.hollow = hollowParts(p, opts);
      p.reason += '; ' + (p.hollow.ok ? p.hollow.reason : 'NOT hollowed - ' + p.hollow.reason);
    }
    return p;
  }

  function planSolid(rawTris, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '', stage: 'detect', parts: [], branches: [] };

    var SA = aimModule(opts);
    if (!SA || typeof SA.detectOverhangs !== 'function') {
      out.reason = 'nso_support_aim.js is not loaded - it owns the detection, the base search ' +
        'and the strut, and none of them is reimplemented here';
      return out;
    }

    var style = styleOf(opts);
    if (!style) {
      out.reason = 'unknown branchStyle ' + JSON.stringify(opts.branchStyle) + ' - one of ' +
        BRANCH_STYLES.join(', ');
      return out;
    }
    out.style = style;
    var section = sectionOf(opts);
    if (!section) {
      out.reason = 'unknown section ' + JSON.stringify(opts.section) + ' - one of ' + SECTIONS.join(', ');
      return out;
    }
    out.section = section;
    /* Every part's axis and the apothem of its section at each end, aligned
       with out.parts: what the exact bores of section 6 are built from. */
    out.partAxes = [];
    out.sectionFallback = [];
    function addPart(soup, axis) { out.parts.push(soup); out.partAxes.push(axis); }
    function sectionNote() {
      if (section !== 'round') return '; square section';
      return '; round, ' + (out.trunk.section === 'round'
        ? 'trunk ' + out.trunk.dFromMm.toFixed(3) + ' -> ' + out.trunk.dToMm.toFixed(3) + ' mm' : 'trunk square') +
        (out.sectionFallback.length ? ', ' + out.sectionFallback.length + ' part(s) kept square where round would hit the piece' : '');
    }
    function fingerAxis(hand, f) {
      return { from: f.from.slice(), to: f.to.slice(), a0: hand.widthMm / 2, a1: hand.widthMm / 2 };
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
    if (opts.wallClearanceMm > 0) {
      out.wallClearance = clearWalls(SA, rawTris, region, cp.points, opts);
      if (!out.wallClearance.ok) { out.reason = out.wallClearance.reason; return out; }
    }

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
    out.sideMm = trunk.sideMm;

    /* THE ROUND TRUNK. aim() settled the base, the axis and the reach on the
       planning strut, and all of that is kept; only the solid along that axis
       is remade, as a frustum under the diameter law. Its tip is the highest
       contact it serves - on the reference every tip is at one height - so
       the trunk is never narrower at the collar than a branch leaving it. */
    var zTipTrunk = -Infinity;
    for (i = 0; i < cp.points.length; i++) if (cp.points[i].p[2] > zTipTrunk) zTipTrunk = cp.points[i].p[2];
    out.zTipMm = zTipTrunk;
    var trunkAxis = { from: trunk.from.slice(), to: trunk.tip.slice(), a0: trunk.sideMm / 2, a1: trunk.sideMm / 2 };
    if (section === 'round') {
      var PSt = sweepModule(opts);
      if (!PSt || typeof PSt.sweep !== 'function') {
        out.reason = 'nso_path_sweep.js is not loaded - a round trunk is a swept frustum';
        return out;
      }
      var law = lawOf(opts);
      out.law = { tipMm: law.tipMm, angleDeg: law.angleDeg, perMm: law.perMm };
      var rt = roundPart(PSt, trunk.from, trunk.tip, law.at(trunk.from[2], zTipTrunk), law.at(trunk.tip[2], zTipTrunk));
      if (!rt.ok) { out.reason = 'the round trunk would not sweep: ' + rt.reason; return out; }
      /* Its own rails against the piece: aim() tested the axis, and a 5 mm
         trunk has a body the axis does not. The cap is excluded only where
         the trunk ends ON a contact, as a branch's is. */
      var tStop = probeRails(SA, obstacles, trunk.from, trunk.dir, trunk.lengthMm, rt.sweep.rings,
        (single || carried >= 0) ? rt.dToMm : 0);
      if (tStop) {
        /* THE SQUARE FALLBACK. A round part whose own body would run into the
           piece keeps the planning section aim() already cleared, and says
           so - the tree is not refused, and nothing planned moves. */
        out.sectionFallback.push({ role: 'trunk', label: 'trunk', why: 'the round trunk (' +
          rt.dFromMm.toFixed(3) + ' -> ' + rt.dToMm.toFixed(3) + ' mm) would run into the piece: ' + tStop.why });
        out.trunk = trunk = Object.assign({}, trunk, { section: 'square', roundRefused: tStop.why });
      } else {
        trunkAxis = rt.axis;
        out.trunk = trunk = Object.assign({}, trunk, {
          soup: rt.soup, squareSoup: trunk.soup, section: 'round', sweep: rt.sweep,
          dFromMm: rt.dFromMm, dToMm: rt.dToMm, axis: rt.axis
        });
      }
    } else {
      out.trunk = trunk = Object.assign({}, trunk, { section: 'square' });
    }
    addPart(trunk.soup, trunkAxis);

    /* A trunk that ends ON a contact - the single strut, or the one carrying
       the contact on its own axis - gets the same hand a branch would, so
       under 'gecko-hand' every contact point has one. The trunk's own soup
       is untouched: the fingers are parts beside it, as on a branch. */
    if (style === 'gecko-hand' && (single || carried >= 0)) {
      var th = geckoHand(trunk.tip, trunk.dir, trunk.sideMm, {
        normal: region.normal, floorMm: trunk.floorMm, shaftMm: trunk.lengthMm
      });
      if (!th.ok) { out.reason = 'the trunk\'s gecko hand would not build: ' + th.reason; return out; }
      clearFingers(SA, obstacles, th);
      out.trunkHand = th;
    }

    if (single) {
      if (out.trunkHand) {
        for (i = 0; i < out.trunkHand.fingers.length; i++) {
          addPart(out.trunkHand.fingers[i].soup, fingerAxis(out.trunkHand, out.trunkHand.fingers[i]));
        }
        out.fingers = out.trunkHand.fingers.length;
        out.fingersDropped = out.trunkHand.dropped.length;
      }
      out.ok = true;
      out.stage = 'done';
      out.single = true;
      out.reason = det.reason + '; one contact point, so no split: ' + trunk.reason + sectionNote() +
        (out.trunkHand ? '; a gecko hand of ' + out.fingers + ' finger(s)' : '');
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
        sideMm: trunk.sideMm, targetNormal: region.normal, floorMm: trunk.floorMm, section: section
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
      var stop = (section === 'round')
        ? probeRails(SA, obstacles, rootPoint, br.dir, br.lengthMm, br.sweep.rings, br.dToMm)
        : probeClear(SA, obstacles, rootPoint, br.dir, br.lengthMm, br.sweep.rings[0], trunk.sideMm);
      if (stop && section === 'round') {
        /* The square fallback, as for the trunk: the same branch at the
           planning section, under the square plan's own clearance test. */
        var sqb = branch(rootPoint, q, Object.assign({}, opts, {
          sideMm: trunk.sideMm, targetNormal: region.normal, floorMm: trunk.floorMm, section: 'square'
        }));
        var sqStop = sqb.ok ? probeClear(SA, obstacles, rootPoint, sqb.dir, sqb.lengthMm, sqb.sweep.rings[0], trunk.sideMm)
                            : { why: sqb.reason };
        if (!sqStop) {
          out.sectionFallback.push({ role: 'branch', label: 'branch ' + out.branches.length + ' (contact ' + i + ')',
            contactIndex: i, why: 'the round branch (' + br.dFromMm.toFixed(3) + ' -> ' + br.dToMm.toFixed(3) +
              ' mm) would run into the piece: ' + stop.why });
          br = sqb;
          br.roundRefused = stop.why;
          stop = null;
        }
      }
      if (stop) {
        blocked.push({ index: i, at: stop.at, why: stop.why });
        continue;
      }
      if (br.hand) {
        clearFingers(SA, obstacles, br.hand);
        br.parts = [br.soup].concat(br.hand.fingers.map(function (fi) { return fi.soup; }));
        br.fingerPenetrationMm = handPenetration(br.hand, q, unit(region.normal));
      }

      br.contactIndex = i;
      out.branches.push(br);
      addPart(br.soup, br.axis);
    }
    out.blocked = blocked;
    /* the axis, and one per rail */
    out.probesPerBranch = 1 + (section === 'round' ? ROUND_SIDES : squareProfile(trunk.sideMm).length);
    /* THE FINGERS GO ON AFTER EVERY SHAFT, not beside their own. The fold is
       left to right, so this makes the first 1 + branches steps of the union
       the default tree's own steps, in the default's own order - the trunk
       and fan the canonical checker already passes - and every finger is then
       unioned against a solid that has its shaft in it. Interleaved, the
       boolean re-rounds the fan's roots to float32 between branches in a
       different order, and on the tall fixture that alone was measured as 2
       piercing pairs down at the branch roots, nowhere near a hand. */
    if (style === 'gecko-hand') {
      var fingers = 0, dropped = 0;
      for (i = 0; i < out.branches.length; i++) {
        for (var f = 0; f < out.branches[i].hand.fingers.length; f++) {
          addPart(out.branches[i].hand.fingers[f].soup, fingerAxis(out.branches[i].hand, out.branches[i].hand.fingers[f]));
        }
        fingers += out.branches[i].hand.fingers.length;
        dropped += out.branches[i].hand.dropped.length;
      }
      if (out.trunkHand) {
        for (i = 0; i < out.trunkHand.fingers.length; i++) {
          addPart(out.trunkHand.fingers[i].soup, fingerAxis(out.trunkHand, out.trunkHand.fingers[i]));
        }
        fingers += out.trunkHand.fingers.length;
        dropped += out.trunkHand.dropped.length;
      }
      out.fingers = fingers;
      out.fingersDropped = dropped;
    }

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
      ', ' + out.tiltDeg.min.toFixed(2) + '..' + out.tiltDeg.max.toFixed(2) + ' deg off vertical' + sectionNote() +
      (style === 'gecko-hand' ? '; gecko hands, ' + out.fingers + ' finger(s)' +
        (out.fingersDropped ? ', ' + out.fingersDropped + ' left off where they met the piece' : '') : '');
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

  /* THE FLOAT32 COLLAPSE, at a crossing rather than at a root.
     ROOT_SPREAD_SIDES keeps branch roots apart so two branch walls do not
     pinch at a shared start point - the one place the square section made
     that happen. The round section (24-gon frusta, tapered by the law) made
     it happen somewhere else: where two thicker branches cross near their
     tips at a grazing angle, two facets meet so obliquely that two distinct
     vertices of their intersection curve land on one float32 when
     NSO_CSG.manifoldToSoup writes the result. The output then carries
     triangles with a REPEATED corner: zero area, zero volume, and at each one
     a pair of non-manifold edges. Measured on the G-scope shelf fixture
     (tools/gcode-test/gscope-support-drive-check.mjs), a 16-branch tree at
     2 and 3 mm: 2 such triangles, 2 non-manifold edges, 1 mis-wound edge by
     exact vertex; square section on the same plan, 0. That fixture is the
     only one it shows on - no tree suite puts two round branches that close.

     A triangle whose float32 corners repeat covers nothing, so removing it
     removes no surface and moves no vertex. That is all this does, and it is
     gated: kept only when the exact-vertex census of what is left has no more
     open or non-manifold edges than before. Every triangle it drops is
     counted in the result. */
  function repeatedCornerFree(soup) {
    var n = (soup.length / 9) | 0, keep = [], dropped = 0;
    for (var t = 0; t < n; t++) {
      var o = t * 9;
      var ab = soup[o] === soup[o + 3] && soup[o + 1] === soup[o + 4] && soup[o + 2] === soup[o + 5];
      var bc = soup[o + 3] === soup[o + 6] && soup[o + 4] === soup[o + 7] && soup[o + 5] === soup[o + 8];
      var ca = soup[o + 6] === soup[o] && soup[o + 7] === soup[o + 1] && soup[o + 8] === soup[o + 2];
      if (ab || bc || ca) { dropped++; continue; }
      keep.push(t);
    }
    if (!dropped) return { soup: soup, dropped: 0 };
    var out = new Float32Array(keep.length * 9);
    for (var i = 0; i < keep.length; i++) {
      for (var k = 0; k < 9; k++) out[i * 9 + k] = soup[keep[i] * 9 + k];
    }
    return { soup: out, dropped: dropped };
  }
  function exactEdgeCensus(soup) {
    var E = new Map(), n = (soup.length / 9) | 0;
    function key(i) { return soup[i] + ',' + soup[i + 1] + ',' + soup[i + 2]; }
    for (var t = 0; t < n; t++) {
      var k = [key(t * 9), key(t * 9 + 3), key(t * 9 + 6)];
      for (var e = 0; e < 3; e++) {
        var u = k[e], v = k[(e + 1) % 3];
        if (u === v) continue;
        var kk = u < v ? u + '|' + v : v + '|' + u;
        E.set(kk, (E.get(kk) || 0) + 1);
      }
    }
    var open = 0, nm = 0;
    E.forEach(function (c) { if (c === 1) open++; else if (c > 2) nm++; });
    return { open: open, nm: nm };
  }
  function dropCollapsed(soup) {
    var r = repeatedCornerFree(soup);
    if (!r.dropped) return r;
    var before = exactEdgeCensus(soup), after = exactEdgeCensus(r.soup);
    if (after.open > before.open || after.nm > before.nm) return { soup: soup, dropped: 0, refused: r.dropped };
    return r;
  }

  /* AND THE NEAR-COLLAPSE. The same grazing crossings also leave distinct
     vertices a few micrometres to a tenth of a micrometre apart (measured on
     the shelf tree: 12 pairs under 1e-4 mm, the closest 9.8e-7), which the
     canonical checker's default weld reads as open edges. Handled on the
     finished union by collapseShortEdges below, gated: kept only if the
     exact census has no more open or non-manifold edges than before and
     the signed volume moves by under 1e-6 of itself; otherwise the union is
     returned as manifold gave it and the refusal is named in the result. */
  var WELD_MM = 1e-4;
  /* Short-edge collapse at the canonical weld. A boolean's intersection curve
     comes back from manifold as float32 with runs of vertices microns apart
     (1e-6 .. 6e-5 mm between neighbours). They are real, distinct vertices
     and the surface through them is closed - but the canonical checker's
     default weld (1e-4, first-representative, NOT transitive) splits such a
     run wherever its greedy pass happens to, and the split reads as an open
     edge (the G-scope gecko-hand: one, at a run of seven vertices spanning
     1.8e-4 mm). Welding does not fix that: a weld at 1e-4 also identifies
     non-adjacent vertices across the crossing and reports non-manifold edges.
     What removes it is removing the sub-weld EDGES themselves: every edge
     shorter than WELD_MM is collapsed onto one endpoint, shortest first,
     only when that is topologically safe (the link condition: the two ends
     share exactly the two opposite vertices) and no surviving triangle
     flips. Each collapse moves geometry by less than WELD_MM and removes the
     two sliver triangles on the edge. */
  function collapseShortEdges(soup, tol) {
    var n = soup.length / 9 | 0;
    var ids = new Map(), P = [], T = new Int32Array(n * 3);
    for (var i = 0; i < n * 3; i++) {
      var k = soup[i*3] + ',' + soup[i*3+1] + ',' + soup[i*3+2];
      var id = ids.get(k);
      if (id === undefined) { id = P.length; ids.set(k, id); P.push([soup[i*3], soup[i*3+1], soup[i*3+2]]); }
      T[i] = id;
    }
    var alive = new Uint8Array(n).fill(1);
    var vt = P.map(function () { return []; });           // vertex -> triangles
    for (var t = 0; t < n; t++) for (var c = 0; c < 3; c++) vt[T[t*3+c]].push(t);
    var rep = new Int32Array(P.length); for (var v = 0; v < P.length; v++) rep[v] = v;
    function d(a, b) { return Math.hypot(P[a][0]-P[b][0], P[a][1]-P[b][1], P[a][2]-P[b][2]); }
    function nrm(a, b, c) {
      var u = [P[b][0]-P[a][0], P[b][1]-P[a][1], P[b][2]-P[a][2]], w = [P[c][0]-P[a][0], P[c][1]-P[a][1], P[c][2]-P[a][2]];
      return [u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]];
    }
    var edges = [];
    for (var t2 = 0; t2 < n; t2++) for (var e = 0; e < 3; e++) {
      var a = T[t2*3+e], b = T[t2*3+(e+1)%3];
      if (a < b) { var L = d(a, b); if (L < tol) edges.push([L, a, b]); }
    }
    edges.sort(function (x, y) { return x[0] - y[0]; });
    var collapsed = 0;
    function nb(v) { var s = new Set(); vt[v].forEach(function (t) { if (!alive[t]) return; for (var c = 0; c < 3; c++) if (T[t*3+c] !== v) s.add(T[t*3+c]); }); return s; }
    for (var q = 0; q < edges.length; q++) {
      var a = edges[q][1], b = edges[q][2];
      if (rep[a] !== a || rep[b] !== b) continue;       // an endpoint already went
      if (!(d(a, b) < tol)) continue;
      var shared = vt[a].filter(function (t) { return alive[t] && vt[b].indexOf(t) >= 0; });
      if (shared.length !== 2) continue;                // not a manifold interior edge
      var opp = new Set();
      shared.forEach(function (t) { for (var c = 0; c < 3; c++) { var x = T[t*3+c]; if (x !== a && x !== b) opp.add(x); } });
      var na = nb(a), nbb = nb(b), common = 0, ok = true;
      na.forEach(function (x) { if (nbb.has(x)) { common++; if (!opp.has(x)) ok = false; } });
      if (!ok || common !== opp.size) continue;          // link condition
      // b -> a: no surviving triangle of b may flip or collapse
      var flip = false;
      vt[b].forEach(function (t) {
        if (!alive[t] || shared.indexOf(t) >= 0 || flip) return;
        var tri = [T[t*3], T[t*3+1], T[t*3+2]];
        var n0 = nrm(tri[0], tri[1], tri[2]);
        var t1 = tri.map(function (x) { return x === b ? a : x; });
        var n1 = nrm(t1[0], t1[1], t1[2]);
        var dot = n0[0]*n1[0] + n0[1]*n1[1] + n0[2]*n1[2];
        if (!(dot > 0)) flip = true;
      });
      if (flip) continue;
      shared.forEach(function (t) { alive[t] = 0; });
      vt[b].forEach(function (t) {
        if (!alive[t]) return;
        for (var c = 0; c < 3; c++) if (T[t*3+c] === b) T[t*3+c] = a;
        vt[a].push(t);
      });
      rep[b] = a;
      collapsed++;
    }
    var out = [];
    for (var t3 = 0; t3 < n; t3++) if (alive[t3]) for (var c3 = 0; c3 < 3; c3++) { var p = P[T[t3*3+c3]]; out.push(p[0], p[1], p[2]); }
    return { soup: new Float32Array(out), collapsed: collapsed, removedTris: n - out.length / 9 };
  }

  function signedVolume(soup) {
    var v = 0;
    for (var t = 0; t + 8 < soup.length; t += 9) {
      var ax = soup[t], ay = soup[t + 1], az = soup[t + 2];
      var bx = soup[t + 3], by = soup[t + 4], bz = soup[t + 5];
      var cx = soup[t + 6], cy = soup[t + 7], cz = soup[t + 8];
      v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
    }
    return v / 6;
  }
  function finishUnion(soup) {
    var c = dropCollapsed(soup);
    var w = collapseShortEdges(c.soup, WELD_MM);
    if (!w.collapsed) return { soup: c.soup, welded: 0, dropped: c.dropped };
    soup = c.soup;
    var r = repeatedCornerFree(w.soup);
    var before = exactEdgeCensus(soup), after = exactEdgeCensus(r.soup);
    if (after.open > before.open || after.nm > before.nm) {
      return { soup: soup, welded: 0, dropped: c.dropped, refused: 'the collapse would raise open / non-manifold edges' };
    }
    var v0 = signedVolume(soup), v1 = signedVolume(r.soup);
    if (!(Math.abs(v1 - v0) <= 1e-6 * Math.abs(v0))) {
      return { soup: soup, welded: 0, dropped: c.dropped, refused: 'the collapse would move the volume by ' + Math.abs(v1 - v0).toExponential(2) + ' mm3' };
    }
    return { soup: r.soup, welded: w.collapsed, dropped: c.dropped + r.dropped };
  }

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
    var acc = parts[0], step = 0, collapsed = 0;   // collapsed: kept for the result's shape
    function next(i) {
      if (i >= parts.length) {
        var fin = finishUnion(acc);
        acc = fin.soup;
        return { ok: true, soup: acc, steps: step, collapsedDropped: collapsed + fin.dropped,
          collapsedShortEdges: fin.welded, collapseRefused: fin.refused || null,
          reason: step + ' union(s) over ' + parts.length + ' parts, ' +
            ((acc.length / 9) | 0) + ' triangles' +
            (collapsed + fin.dropped ? '; ' + (collapsed + fin.dropped) + ' zero-area triangle(s) with a repeated float32 corner dropped' : '') +
            (fin.welded ? '; ' + fin.welded + ' edge(s) under ' + WELD_MM + ' mm collapsed' : '') +
            (fin.refused ? '; short-edge collapse at ' + WELD_MM + ' mm refused - ' + fin.refused : '') };
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

  /* =====================================================================
     6. HOLLOW - exact bores: union(parts) - union(each part shrunk by a wall)

     THE PHYSICS, unchanged: a real Bambu tree, cut open, is hollow in the
     trunk and in the smallest branches, with ONE line of wall
     (docs/SUPPORT-TREE-SHAPE.md, Finding 2); and a wall under the nozzle's
     floor is not printed thin, it is silently dropped. So the wall is
     NSO_Thickness.floorFor(nozzle), through the floor the trunk was built to.

     THE CONSTRUCTION is the one the real toolpath shows (Finding 4): the tree
     is a union of swept solids, and a merged contour is one wall around ONE
     merged bore. So:

         hollow tree = union(outer parts) - union(inner parts)

     where each part's INNER is that part shrunk inward by exactly one wall:
     every side face moved in by `wall` along its own normal, and each end cap
     moved in by `wall` along the axis. Every part here is a straight prism or
     frustum of a regular polygon, so that inner is again one: the section at
     each end is the same polygon with its apothem reduced by
     wall / cos(alpha), alpha the taper's half-angle - the face leans alpha
     off the axis, so moving it `wall` along its normal moves it
     wall / cos(alpha) across the section. (A radial wall - apothem minus
     wall - would leave wall x cos(alpha) perpendicular: the cos(slope)
     shortfall NSO_wheelInnerAt measured, in miniature.)

     WHY THE WALL IS EXACT, NOT SAMPLED. A convex solid shrunk face by face
     by `wall` is exactly the set of its points at least `wall` from its
     surface - the erosion nso_hollow.js samples on a grid, here in closed
     form. So every bore point lies at least `wall` inside its own part, hence
     inside the union, and no point of the union's outer surface is nearer
     than `wall` to any bore. There is no grid, no level set, no keep region,
     and no tolerance but the kernel's. What replaces the sampled version's
     solid knot: bores that overlap become ONE bore, as the reference's do.

     WHAT IT DOES NOT PROMISE. Where two bores diverge they part before their
     tubes do, and for a short run the material between them is thinner than
     a wall. That is a membrane BETWEEN TWO BORES, not a wall to the outside:
     a slicer offsetting the two holes by half a line merges them, which is
     the single merged bore the reference shows at the same place. It is
     measured and reported, never counted as a wall.

     THE FALLBACK. A part stays solid, named, when its bore would be narrower
     than one line (minBoreMm, default the floor: two lines laid side by side
     round a hole thinner than one of them leave no hole a slicer keeps - and
     the reference's own ~2 mm tips close up), or it is too short for two end
     walls, or the wall asked for is under the floor. Never the whole tree.
     ===================================================================== */

  function thicknessModule(opts) {
    return (opts && opts.thickness) || (root && root.NSO_Thickness) ||
           (typeof NSO_Thickness !== 'undefined' ? NSO_Thickness : null);
  }

  /* What each entry of plan.parts is, by identity. */
  function partLabels(plan) {
    var by = new Map(), i, f;
    if (plan.trunk && plan.trunk.soup) by.set(plan.trunk.soup, { role: 'trunk', label: 'trunk' });
    var brs = plan.branches || [];
    for (i = 0; i < brs.length; i++) {
      by.set(brs[i].soup, { role: 'branch', label: 'branch ' + i + ' (contact ' + brs[i].contactIndex + ')', branch: i });
      var h = brs[i].hand;
      if (h) for (f = 0; f < h.fingers.length; f++) {
        by.set(h.fingers[f].soup, { role: 'finger', branch: i, label: 'finger ' + h.fingers[f].index + ' of branch ' + i });
      }
    }
    if (plan.trunkHand) for (f = 0; f < plan.trunkHand.fingers.length; f++) {
      by.set(plan.trunkHand.fingers[f].soup, { role: 'finger', label: 'finger ' + plan.trunkHand.fingers[f].index + ' of the trunk' });
    }
    return (plan.parts || []).map(function (s, k) { return by.get(s) || { role: 'part', label: 'part ' + k }; });
  }

  /* One part's inner: its own vertices, each moved to the end station a wall
     in from its end and scaled about the axis to the shrunk section there.
     Same triangles, same winding, so a closed solid in gives a closed solid
     out. Refuses (with the numbers) when there is no bore to make. */
  function innerOf(soup, axis, wall, minBore) {
    var u = sub(axis.to, axis.from), L = len(u);
    if (!(L > 0)) return { ok: false, kind: 'other', why: 'the part has no length' };
    u = mul(u, 1 / L);
    if (!(L > 2 * wall + minBore)) {
      return { ok: false, kind: 'too-small', why: 'a ' + L.toFixed(3) + ' mm part is too short for two ' +
        wall.toFixed(3) + ' mm end walls and a bore' };
    }
    var a0 = axis.a0, a1 = axis.a1;
    var tanA = (a0 - a1) / L, cosA = 1 / Math.sqrt(1 + tanA * tanA), delta = wall / cosA;
    var aAt = function (s) { return a0 + (a1 - a0) * s / L; };
    var b0 = aAt(wall) - delta, b1 = aAt(L - wall) - delta;
    var bore = 2 * Math.min(b0, b1);
    if (!(bore >= minBore - 1e-9)) {
      return { ok: false, kind: 'too-small', boreMm: bore,
        why: 'its bore would be ' + (bore > 0 ? bore.toFixed(3) + ' mm across' : 'nothing') + ' - ' +
          (2 * Math.min(a0, a1)).toFixed(3) + ' mm across the flats less two ' + wall.toFixed(3) +
          ' mm walls is under the ' + minBore.toFixed(3) + ' mm a slicer keeps as a hole' };
    }
    var k0 = b0 / a0, k1 = b1 / a1;
    var out = new Float32Array(soup.length), worstEnd = 0;
    for (var v = 0; v < soup.length; v += 3) {
      var p = [soup[v], soup[v + 1], soup[v + 2]], d = sub(p, axis.from), t = dot(d, u);
      var atEnd = t > L / 2, rad = sub(d, mul(u, t));
      var off = atEnd ? Math.abs(t - L) : Math.abs(t);
      if (off > worstEnd) worstEnd = off;
      var q = add(add(axis.from, mul(u, atEnd ? L - wall : wall)), mul(rad, atEnd ? k1 : k0));
      out[v] = q[0]; out[v + 1] = q[1]; out[v + 2] = q[2];
    }
    /* Every vertex of these parts is on one of the two end sections. A part
       that is not (a finger's hexagon is; so is every sweep and every aim()
       prism) is refused rather than shrunk into something else. */
    if (worstEnd > 1e-3) return { ok: false, kind: 'other', why: 'the part is not a two-ended prism or frustum (a vertex ' + worstEnd.toFixed(4) + ' mm off its end sections)' };
    return { ok: true, soup: out, boreFromMm: 2 * b0, boreToMm: 2 * b1, deltaMm: delta, halfAngleDeg: Math.atan(tanA) * 180 / Math.PI };
  }

  // opts.hollowWallMm  the wall; default the floor the trunk was built to
  // opts.minBoreMm     the narrowest bore kept; default the same floor
  function hollowParts(plan, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '', parts: [], hollowed: 0, solid: [] };
    if (!plan || !plan.ok || !plan.parts || !plan.parts.length || !plan.partAxes) {
      out.reason = 'hollowParts needs a planned tree';
      return out;
    }
    var floor = plan.trunk && plan.trunk.floorMm;
    var wall = (opts.hollowWallMm == null) ? floor : +opts.hollowWallMm;
    var minBore = (opts.minBoreMm == null) ? floor : +opts.minBoreMm;
    if (!(wall > 0)) { out.reason = 'no wall to hollow to - pass hollowWallMm, or plan with a floor'; return out; }
    out.wallMm = wall; out.floorMm = floor; out.minBoreMm = minBore;
    var labels = partLabels(plan);
    for (var i = 0; i < plan.parts.length; i++) {
      var rec = { index: i, role: labels[i].role, label: labels[i].label, branch: labels[i].branch, hollow: false };
      var r;
      if (wall < floor - 1e-9) {
        r = { ok: false, kind: 'under-floor', why: 'a ' + wall.toFixed(3) + ' mm wall is under the ' + floor.toFixed(3) +
          ' mm nozzle floor - a wall that thin is dropped from the toolpath, not printed thin' };
      } else {
        r = innerOf(plan.parts[i], plan.partAxes[i], wall, minBore);
      }
      if (r.ok) {
        rec.hollow = true; rec.inner = r.soup; rec.boreFromMm = r.boreFromMm; rec.boreToMm = r.boreToMm;
        rec.halfAngleDeg = r.halfAngleDeg; rec.deltaMm = r.deltaMm;
        out.hollowed++;
      } else {
        rec.kind = r.kind; rec.reason = r.why; rec.boreMm = r.boreMm;
        out.solid.push({ index: i, label: rec.label, role: rec.role, kind: r.kind, why: r.why });
      }
      out.parts.push(rec);
    }
    out.ok = true;
    var kinds = {};
    out.solid.forEach(function (x) { kinds[x.kind] = (kinds[x.kind] || 0) + 1; });
    out.reason = out.hollowed + ' of ' + plan.parts.length + ' part(s) get a bore inside a ' + wall.toFixed(3) + ' mm wall' +
      (out.solid.length ? '; ' + out.solid.length + ' left solid (' +
        Object.keys(kinds).map(function (k) { return kinds[k] + ' ' + k; }).join(', ') + ')' : '');
    return out;
  }

  /* The whole hollow tree: the solid union exactly as unionParts builds it,
     then every inner taken out of it by the kernel, one at a time.
     opts.subtractSoups  default NSO_subtractSoups (app-join.js)
     opts.unionSoups     as unionParts */
  function hollowTree(plan, opts) {
    opts = opts || {};
    var S = opts.subtractSoups || (root && root.NSO_subtractSoups) ||
            (typeof NSO_subtractSoups !== 'undefined' ? NSO_subtractSoups : null);
    if (typeof S !== 'function') {
      return Promise.resolve({ ok: false, soup: null,
        reason: 'app-join.js is not loaded - NSO_subtractSoups is the kernel subtract the bores go through' });
    }
    var hp = (plan && plan.hollow && plan.hollow.ok) ? plan.hollow : hollowParts(plan, opts);
    if (!hp.ok) return Promise.resolve({ ok: false, soup: null, hollow: hp, reason: hp.reason });
    return unionParts(plan.parts, opts).then(function (u) {
      if (!u.ok) return { ok: false, soup: null, hollow: hp, reason: 'the solid union failed: ' + u.reason };
      var acc = u.soup, removed = 0, cut = 0, parts = null;
      var recs = hp.parts.filter(function (r) { return r.hollow; });
      function next(k) {
        if (k >= recs.length) {
          var bores = parts == null ? 0 : parts - 1;
          return {
            ok: true, soup: acc, solidSoup: u.soup, hollow: hp, solid: hp.solid,
            boresCut: cut, boreShells: bores, removedMm3: removed,
            reason: 'hollow tree: ' + cut + ' of ' + plan.parts.length + ' part(s) bored at a ' +
              hp.wallMm.toFixed(3) + ' mm wall, joined into ' + bores + ' bore(s), ' + removed.toFixed(3) + ' mm^3 removed' +
              (hp.solid.length ? '; ' + hp.solid.length + ' left solid - ' +
                hp.solid.map(function (x) { return x.label + ' (' + x.kind + ')'; }).join(', ') : '')
          };
        }
        var r = recs[k];
        return S(acc, r.inner).then(function (d) {
          if (d && d.ok) { acc = d.soup; cut++; removed += d.removedMm3; parts = d.parts; r.cut = true; }
          else {
            r.hollow = false; r.cut = false; r.kind = 'kernel';
            r.reason = 'the kernel would not remove its bore: ' + ((d && d.reason) || 'no reason given');
            hp.solid.push({ index: r.index, label: r.label, role: r.role, kind: 'kernel', why: r.reason });
          }
          return next(k + 1);
        });
      }
      return next(0);
    });
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
    BRANCH_STYLES: BRANCH_STYLES.slice(),
    GECKO: Object.assign({}, GECKO),     /* a copy: the proportions are not a setting */
    contactPoints: contactPoints,
    splitPoint: splitPoint,
    branch: branch,
    planTree: planTree,
    unionParts: unionParts,
    /* The cleanup unionParts applies to its finished left fold - exposed so
       tools/nso_support_tree_test.js can hold unionParts to exactly
       finishUnion(fold), and so the refusal cases can be driven directly. */
    _finishUnion: finishUnion,
    hollowParts: hollowParts,
    hollowTree: hollowTree,
    SECTIONS: SECTIONS.slice(),
    ROUND_SIDES: ROUND_SIDES,
    TIP_DIAMETER_MM: TIP_DIAMETER_MM,
    DIAMETER_ANGLE_DEG: DIAMETER_ANGLE_DEG,
    _lawOf: lawOf,
    _roundProfile: roundProfile,
    _roundPart: roundPart,
    _innerOf: innerOf,
    _probeRails: probeRails,
    describe: describe,
    /* exposed for the tests, not for callers */
    _zOnTriAt: zOnTriAt,
    _squareProfile: squareProfile,
    _hexProfile: hexProfile,
    _geckoHand: geckoHand
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SupportTree = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
