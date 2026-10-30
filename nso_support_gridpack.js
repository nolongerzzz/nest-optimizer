/* ============================================================
   nso_support_gridpack.js - supports grown from the overhang DOWN to the
   plate: one strut per support point, merged pairwise on a node lattice.

   Loads as a classic script (window.NSO_SupportGridpack) and as a Node
   module. No DOM, no THREE. Soups are the app's raw convention: 9 floats per
   triangle, Z up, millimetres.

   ---------------------------------------------------------------------------
   WHY THIS REPLACED THE TRUNK-FIRST PLANNER
   ---------------------------------------------------------------------------
   nso_support_tree.js's planSolid planted ONE trunk from the plate under the
   fan's centre and fanned branches up to the contacts. Every branch had to
   reach from one collar, so one bad angle refused the whole region: a flat
   face tilted 30 deg put contacts below the split and was refused with
   "widest branch leans 180 deg off vertical". The straight strut built one
   post at the region's centre. A second Generate stacked a support inside
   the first. Direction: over-support by default, refuse only the impossible.

   ---------------------------------------------------------------------------
   THE PLANNER (deterministic)
   ---------------------------------------------------------------------------
   Dials: strut side s (buildStrut's, floored), lean limit theta
   (BRANCH_TILT_DEG, 30 deg: inside the reference's widest branch, 31.44), node
   lattice L (5 mm), and merge eagerness (the Style: 'strut' 0, 'tree' 1).

   BEACONS. The support points. Each is { p, n } - a point on the surface
   and its outward normal. They come from gridBeacons() below:
   NSO_SupportBeacons.detect's own beacons, EXPOSED ONES ONLY (a spot whose
   air reaches the outside; the inside of a sealed cavity is no beacon, but a
   shelf over its own base, a bridge over its foot and the underside of an arch
   are - detection is geometry only, and what is under the spot is no part of
   it), each carrying the id of its beacon region (its area). opts.beacons
   takes a list directly (the Supports card's; G-scope's row). Whether a beacon
   can be reached is decided HERE, by LANDING below.

   HELD. A beacon is held when it is in a landed trunk. Merging joins members
   and never drops one, so on a clean face held == the area's beacon count; a
   face that needs more capacity gets more trunks, never a section past 4 x s^2.

   LEVEL 0. Every beacon starts a strut straight down from its point. A
   SIDE beacon - its face leans more than theta off straight down, so a
   vertical strut would run along it - first gets a lateral stub out along
   its normal, then turns down.

   DESCENT. Lattice levels z_k = plateZ + k * L/2 are visited top down. A
   member is a straight run hanging from its ANCHOR (the last point where it
   turned: its beacon, a merge node, a pickup point, the end of a steer).
   At level z its lean budget is (anchor.z - z) * tan(theta) * eagerness.

   MERGING. Two free members whose budgets both reach the lattice node
   nearest their midpoint (XY node pitch L/2) lean to that node in one
   straight leg each and become ONE member there, carrying both counts.
   Pairs are taken closest first; each member merges at most once per
   level; a member with no reachable partner continues straight. A merged
   member's section is a square of area count x s^2, capped at 4 x s^2
   (FLAG: the cap and the square section are choices, not measurements).

   COLUMN PICKUP. A free member whose straight run passes within one beacon
   pitch (horizontally) of a LOWER under-beacon picks it up with a short
   stub - a leg leaning theta, then a vertical last 2 x s to the point, so the
   tip meets the face as a strut's does - instead of that beacon starting a
   strut of its own.

   OBSTACLES. Every leg is tested before it is taken: the axis and the rails
   of its section (plus CLEAR_MM), with NSO_SupportAim's own ray test (the
   straight-down ones through its down grid, same answer ray for ray). A
   merge whose legs or whose node's drop to the plate is blocked does not
   happen that level; the members carry on and retry lower. A member whose
   straight drop to the plate is blocked STEERS: for each of 16 headings at
   theta and theta/2, the leaning line from its anchor is walked down the
   lattice levels and the first point from which the drop is clear is taken
   - one leg check and one drop check per heading per level, no path search.
   Openings in the piece are found this way: a drop that is clear through a
   hole is a clear drop.

   FEET. A trunk that lands on the plate stands on a pad one first layer
   (0.2 mm) thick. Trunks whose feet stand within 6 mm share ONE pad: the
   union of their footprints grown by 4 mm, kept 0.2 mm off the piece; pads
   that would touch are one pad, and the trunks on a pad are one support
   (FEET, below). opts.footPads false builds no foot; 'shared' builds every
   trunk on its foot but draws no pad - shareFeet() draws them over several
   plans at once (the Supports card's areas). Nothing goes below the plate:
   the trunk ends half a layer inside its pad, and a last leg that would
   lean onto the plate stops 1 mm short and drops straight. On the card's
   build (opts.interface) every trunk on a foot also gets a round trunk
   round its axis, wider going down and flared onto its pad, and the pad is
   drawn round the flare (TRUNKS, below).

   LANDING. Plate first, always: straight down, else steered round the piece
   within the lean limit (STEER below). A member with no route to the plate:
     - restOnModel off (default): builds nothing; its beacons are counted
       as "unreachable from the plate".
     - restOnModel on: drops straight onto the piece below and stands on a
       two-layer pad a support gap above it; counted as "resting on the part".

   REFUSAL. Only a beacon inside the piece is refused, and the plan says so
   in one plain line. Everything else is built or counted.

   GEOMETRY. Each member is ONE NSO_PathSweep of a constant square section
   along its own polyline - every bend a mitred joint. A member formed at a
   node starts half its own side ABOVE the node, so the members merging there
   end inside it and the union has volume to work on. Every member that ends
   at one landing is unioned (NSO_unionSoups, through
   NSO_SupportTree.unionParts) into one solid per landed trunk; trunks that
   touch are joined, the rest are handed back side by side in one soup.

   IDEMPOTENT. Same input, same bytes: every order above is fixed (beacons
   by height then x then y; pairs by distance then member id; headings by
   angle). app-gscope-support.js replaces an existing support for the
   region rather than stacking a second one.

   OUT OF SCOPE: economics dials beyond L, curved legs, round or tapered
   sections, UI.

   API
   ---------------------------------------------------------------------------
   gridBeacons(rawTris, opts)  -> { ok, reason, beacons, detect, regions (beacon regions) }
   plan(rawTris, opts)         -> { ok, reason, members, merges, trunks, ... }
   solid(plan, opts)           -> Promise { ok, soup, solids, reason }; opts.hollow
                                  bores every member (BORES), hollowWallMm, minBoreMm
   describe(plan)              -> one plain status line
   opts: skipList (required, as detectOverhangs), angleDeg, occluders,
         regionId, sideMm, style ('strut' | 'tree' | 'gecko-hand'),
         branchTiltDeg, latticeMm, pitchMm, restOnModel, beacons, footPads,
         firstLayerMm
   opts.beacons: an explicit list ({ p, n } or { x, y, z, normal }, each
         optionally with regionId and key) planned instead of detecting.
   Every plan.trunks[i] carries regionIds; every solid(plan).solids[i]
   carries beacons (ids), regionIds and landing.
   opts.feed: the user's points - { mode: 'auto' | 'assisted' | 'custom',
         tips, beaconsOff, landingZones, excluded, knobs } (THE FEED, below;
         knobs: { trunkTipMm, trunkAngleDeg, leanDeg, nodeMm }, THE KNOBS).
         Absent, the plan is today's, byte for byte.
   members(plan, parts)        -> { members: [{ id, kind, from, to, carries }],
                                  unsupported }; shells() answers with both
                                  (MEMBERS, below)
   parts(plan, { interface: true }) (and solid()): a tip a STAIR holds by
         itself (sheet()'s mode 'drop', docs/SUPPORT-INTERFACE.md section 7)
         is not built, nor any member that holds only such tips; the tips the
         stair's strips want are planned as a tree of their own and built
         after the plan's trunks (tp.stairTrunks; trunk numbers past the
         plan's); every other tip that meets the
         part ends in a flat cap 2.5 - 4 mm across under
         nso_support_interface.js's SHEET - 2 transition and 2 interface
         layers at 0.84 mm, each a loop and a serpentine inside it, on the
         caps (all ending at z_cap), 0.18 mm under the part - or is cut at
         the gap line, or (a
         side tip) drawn back off its face; weld() joins each sheet to the
         trunks it stands on. Off by default:
         solid(plan) is the same bytes as before. The Supports card turns it
         on (docs/SUPPORT-INTERFACE.md). Gecko fingers are not grown under a
         sheet. tp.sheet / weld().sheet: what was built, per tip and level.

   PROGRESS. opts.onProgress(msg), on plan(), parts() and weld(), is told
   { phase, done, total } as the work goes, once per unit finished:
     'detecting'  plan(): the plate and the spatial index; no count (null, null)
     'planning'   plan(): beacons settled / beacons given (a beacon inside the
                  piece is settled when it is refused)
     'building'   parts(): units done / buildUnits(plan, opts) - with the
                  interface sheet its tips first (sheet()'s opts.progress),
                  then one per trunk swept
     'welding'    weld(): the unions; no count (the number of joins is not
                  known until the last one is done), so null, null
   A phase with no count says so with nulls; no total is ever guessed. done
   never goes down within a phase and never passes total. Between units the
   last message is repeated once HEARTBEAT_MS has passed, so the gap between
   messages is at most HEARTBEAT_MS plus the longest single unit: a unit is
   not interrupted, so one that runs for a second is a second between
   messages. A callback that throws is ignored. parts() and weld() also take
   opts.yieldFn(): called between units, and awaited when it returns a
   promise - the page's turn to repaint, or to stop the work by rejecting.
   solid(plan) is parts() then weld() with no callback and no yields: the
   same bytes as before. shells(plan, parts) is solid()'s answer with no
   boolean - every part its own closed shell, grouped as weld() would join
   them (the Supports card's build; support:shells holds its layers to the
   weld's).
   ============================================================ */
(function (root) {
  'use strict';

  var LATTICE_MM = 5;          /* L. Node pitch L/2 in x, y and z. */
  var AREA_CAP = 4;
  var MAX_MERGE = 3;           /* members meeting at one node: pairwise, or three when one stands in the way */            /* a merged section tops out at 4 x the strut area (FLAG) */
  var CLEAR_MM = 0.2;          /* rails are tested this far outside the section */
  var STEER_HEADINGS = 16;
  var STEER_STEP_MM = 5;       /* a leaning route is tried leaning this much further down at a time (twice the node lattice's z step, L/2: the test is a gate, not a planner) */
  var STEER_LEANS = [1, 0.5];
  var RAY_EPS = 1e-3;
  var PAD_LAYERS_MM = 0.4;     /* a resting foot: two 0.2 mm layers */
  var GAP_MM = 0.18;           /* nso_support_interface.js's easy-release gap */
  var SHEET_SINK_MM = 0.015;   /* weld() only: T1's underside this far into the caps, inside their 0.02 mm upright band (joinSheets) */
  var TIP_LEVELS = [0.05, 0.3, 0.6, 1.0, 1.5];   /* mm below a tip where the tip zone is swept for walls */
  var TIP_RISE_SIDES = 2;     /* a pickup stub's vertical last run, x the strut side */
  var NUDGE_STEPS = [0.25, 0.5, 0.75, 1];   /* x the strut side: how far a tip may move off a wall */
  var FOOT_LAYER_MM = 0.2;     /* a foot pad is one first layer thick (the 0.2 mm layers this file's gaps are sized for) */
  var FOOT_CLUSTER_MM = 6;     /* trunks whose feet stand this close (centre to centre, in plan) share one pad */
  var FOOT_GROW_MM = 4;        /* a pad is its trunks' footprints grown by this */
  var FOOT_RUN_MM = 1;         /* a trunk that would land leaning stops this high and drops the rest straight */
  var FOOT_GAP_MM = 0.2;       /* a pad keeps this far off the piece (and what stands round it), the support gap and a hair */
  var FOOT_CELL_MM = 0.05;     /* the raster a pad is drawn on: one cell */
  var FOOT_CELLS_MAX = 4e6;    /* ...coarsened to this many cells on a very wide field of feet */
  var FOOT_TOUCH_MM = 0.1;     /* pads that would part by less than this are one pad */
  /* THE TRUNK (supports-foot, TRUNKS below): Bambu's tree slim law, 2 mm at the top of what a trunk holds up and
     wider going down at a constant angle, then a flare onto the pad */
  var TRUNK_TIP_MM = 2;        /* the law's diameter at the top (Bambu's tree_support_branch_diameter) */
  var TRUNK_ANGLE_DEG = 5.5;   /* ...growing going down at this half-angle (Bambu's setting is 5; its slice of simple_overhang grows at 5.2) */
  var FLARE_MM = 4.5;            /* the flare: over this much above the plate the trunk widens faster... */
  var FLARE_ANGLE_DEG = 21;    /* ...by this half-angle more (Bambu's own bottom 4 mm on simple_overhang need 12.4) */
  var TRUNK_SHARE = 0.5;       /* a trunk rises up its stem while the stem holds at least this share of the trunk's tips */
  var TRUNK_KEEP_MM = 0.35;    /* a trunk keeps this far off the piece (Bambu's support_object_xy_distance) */
  var TRUNK_TIP_CLEAR_MM = 4;  /* ...and ends this far under any tip within TRUNK_TIP_REACH_MM of it: under every cap, sheet and gap */
  var TRUNK_TIP_REACH_MM = 5;
  var TRUNK_SIDES = 32;        /* a trunk is a round solid of this many sides */
  var TRUNK_STEP_MM = 0.25;    /* the piece's distance is read up a trunk's axis this often */
  var TRUNK_FOOT_CLEAR_MM = 3.86; /* a trunk's foot stands this far off the part's base on the first layer: Bambu's on
                                    simple_overhang (its trunk's first-layer ring to the part's outer wall, edge to edge, 0.5 mm lines) */
  var RELAND_STEP_MM = 0.5;    /* a landing moved off the part is tried this far apart, ... */
  var RELAND_SLACK_MM = 0.3;   /* ...and the foot's clearance is asked this much over (the trunk is grown round the landing, a hair off it: the wider the flare, the more it shows) */
  var RELAND_HEADINGS = 32;    /* ...in this many directions */
  var CAP_SIDES = 16;          /* a cap under the sheet: a round frustum of this many sides */
  var LEAN_TOL = 1e-4;          /* a face tilted exactly the lean limit is not a side face: float32 noise on its normal must not decide */
  var EAGERNESS = { strut: 0, tree: 1, 'gecko-hand': 1 };
  var HEARTBEAT_MS = 200;      /* a repeat of the last progress message goes out once this long has passed (see PROGRESS above) */
  /* THE CROWN (supports-thinning-1, CROWNS below): a circle of the custom feed carries ONE tree. The joins are built
     to Bambu's own, measured from fixtures/supports/simple_overhang_bambu.gcode.3mf by tools/nso_support_bambu_joins.js
     (7 joins; the P1S slice of the same part is the same tree) - nothing here is invented:
       area       the parent's cross-section area against the sum of its children's: 0.97 - 1.09, median 0.99
       angle      a child's direction against its parent's, going up: 4.0 - 47.7 deg, median 15.3, p90 36.7
       fan        two children against each other: 25.2 - 50.0 deg
       taper      a trunk widens going down at 4.4 deg (its slice; the setting is 5)  */
  var JOINS = { areaRatio: [0.97, 1.09], angleDeg: [4.0, 47.7], fanDeg: [25.2, 50.0], widestRatio: [1.20, 1.43], taperDeg: 4.4 };
  var CROWN_AREA_RATIO = 1.0;       /* a join keeps its area: the parent is the sum of its children (inside JOINS.areaRatio) */
  var CROWN_MAX_KIDS = 3;           /* children at one join: 2 or 3 (the root may carry 1 when it holds one tip) */
  var CROWN_TIP_DROP_MM = TRUNK_TIP_CLEAR_MM;   /* a tip's column runs at least this far before its first join: under its cap */
  var CROWN_NODE_DROP_MM = 3;       /* a branch runs at least this far between joins */
  var CROWN_OVAL_MAX = 3;           /* an oval trunk is at most this long against its width (area kept) */
  var CROWN_BRANCH_TAPER_DEG = 0;   /* between two joins a Bambu branch holds its width (its 30-layer stretches measure -0.5 to -1.0 deg); only the trunk widens, at JOINS.taperDeg and over the law */
  var CROWN_STUB_SIDES = 20;          /* a crown tip's round stub: sides */
  var CROWN_TRUNK_SINK_MM = 1;       /* ...the trunk stops this far under its top, inside the smooth body's shoulder */
  var CROWN_BLOB_TRIS = 24000;        /* ...and no body is meshed finer than this many triangles allow */
  var CROWN_BLEND_MM = 0.25;          /* the branches of a crown flow into one another and into the trunk: the smooth union's blend (crown.blendMm) */
  var CROWN_BLOB_CELL_MM = 0.25;      /* ...meshed on a grid this fine (crown.blobCellMm) */
  var CROWN_TUBE_SIDES = 20;        /* a branch is a round tube of this many sides... */
  var CROWN_BALL_SEGS = 10;         /* ...and a join a ball of this many bands (twice that round) */
  var CROWN_ROOT_FLOOR_MM = FLARE_MM + 2;   /* the first join is at least this far over the plate: the flare stays in the trunk */
  var CROWN_NODE_RINGS = [1, 2, 3, 4.5, 6, 8];   /* a join that its branches cannot reach clear is tried this far off its place, in STEER_HEADINGS directions */
  var CROWN_LEAN_HARD_DEG = 75;     /* a branch leaning more than this is a bar lying flat: brought down to the lean limit (crown.leanHardDeg) */
  var LEAN_FLOOR_MM = 1.5;          /* a join or a leg's end lowered to hold the lean limit stands no lower than this over the plate */
  var CROWN_SEARCH_STEP_MM = 0.5;   /* a trunk moved off the centre of its circle is tried this far apart, in RELAND_HEADINGS directions */

  /* THE CROWN'S KNOBS: every value above is a DEFAULT, none a rule. opts.crown = { areaRatio, tipDropMm, nodeDropMm, ovalMax,
     branchTaperDeg, rootFloorMm, designLeanDeg (null: half the widest measured angle, at most the lean limit), nodeRings,
     searchStepMm, tubeSides, nudgeTips, nudgeMarginMm (0: a tip is moved only where its column would touch a wall; the planner's own
     0.2 mm margin moved 14 more of the arc's tips, and its stair then did not form), trunk: { tipMm, angleDeg, flareMm, flareAngleDeg } } overrides any of them; the trunk's law
     is TRUNKS' today's. The lean limit is opts.branchTiltDeg, as ever. plan.crownKnobs says what was used. */
  function crownKnobs(opts) {
    var o = (opts && opts.crown) || {}, t = o.trunk || {};
    function pick(v, d) { return v == null || !isFinite(v) ? d : +v; }
    return {
      nudgeTips: o.nudgeTips == null ? true : !!o.nudgeTips, nudgeMarginMm: pick(o.nudgeMarginMm, 0), maxKids: Math.max(2, Math.round(pick(o.maxKids, CROWN_MAX_KIDS))), areaRatio: pick(o.areaRatio, CROWN_AREA_RATIO), tipDropMm: pick(o.tipDropMm, CROWN_TIP_DROP_MM), nodeDropMm: pick(o.nodeDropMm, CROWN_NODE_DROP_MM),
      ovalMax: pick(o.ovalMax, CROWN_OVAL_MAX), branchTaperDeg: pick(o.branchTaperDeg, CROWN_BRANCH_TAPER_DEG), rootFloorMm: pick(o.rootFloorMm, CROWN_ROOT_FLOOR_MM), leanHardDeg: pick(o.leanHardDeg, CROWN_LEAN_HARD_DEG),
      designLeanDeg: o.designLeanDeg == null ? null : +o.designLeanDeg, nodeRings: Array.isArray(o.nodeRings) ? o.nodeRings.slice() : CROWN_NODE_RINGS.slice(),
      searchStepMm: pick(o.searchStepMm, CROWN_SEARCH_STEP_MM), tipRiseMm: pick(o.tipRiseMm, 0),
      smooth: o.smooth == null ? true : !!o.smooth, blendMm: pick(o.blendMm, CROWN_BLEND_MM), blobCellMm: pick(o.blobCellMm, CROWN_BLOB_CELL_MM), tubeSides: Math.max(6, Math.round(pick(o.tubeSides, CROWN_TUBE_SIDES))),
      trunk: { tipMm: pick(t.tipMm, TRUNK_TIP_MM), angleDeg: pick(t.angleDeg, TRUNK_ANGLE_DEG), flareMm: pick(t.flareMm, FLARE_MM), flareAngleDeg: pick(t.flareAngleDeg, FLARE_ANGLE_DEG), footClearMm: pick(t.footClearMm, TRUNK_FOOT_CLEAR_MM), uniformH: t.uniformH == null ? null : +t.uniformH, padGrowMm: t.padGrowMm == null ? null : +t.padGrowMm }
    };
  }

  function SA(o) { return (o && o.supportAim) || (root && root.NSO_SupportAim) || null; }
  function ST(o) { return (o && o.supportTree) || (root && root.NSO_SupportTree) || null; }
  function SBM(o) { return (o && o.beaconsModule) || (root && root.NSO_SupportBeacons) || null; }
  function PS(o) { return (o && o.pathSweep) || (root && root.NSO_PathSweep) || null; }
  function SIM(o) { return (o && o.supportInterface) || (root && root.NSO_SupportInterface) || null; }

  /* say(phase, done, total, force): tells opts.onProgress. A repeat of the
     last message is dropped unless HEARTBEAT_MS has passed since it was sent,
     or `force` is set; so a loop can call it on every unit and on every level
     and the listener still hears one message per change and a beat in between. */
  function progressOf(opts) {
    var cb = opts && opts.onProgress;
    if (typeof cb !== 'function') return function () {};
    var last = { phase: null, done: null, total: null, at: 0 };
    return function say(phase, done, total, force) {
      var now = Date.now();
      if (!force && last.phase === phase && last.done === done && last.total === total && now - last.at < HEARTBEAT_MS) return;
      last = { phase: phase, done: done, total: total, at: now };
      try { cb({ phase: phase, done: done, total: total }); } catch (err) { /* a listener must not stop the plan */ }
    };
  }

  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
  function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function len(a) { return Math.sqrt(dot(a, a)); }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function unit(a) { var L = len(a); return L > 1e-15 ? mul(a, 1 / L) : null; }
  function hdist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
  /* Closest distance between segments p0-p1 and q0-q1 (Ericson 5.1.9). */
  function segDist(p0, p1, q0, q1) {
    var d1 = sub(p1, p0), d2 = sub(q1, q0), r = sub(p0, q0);
    var a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), s, t;
    if (a < 1e-18 && e < 1e-18) return len(r);
    if (a < 1e-18) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
    else {
      var c = dot(d1, r);
      if (e < 1e-18) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else {
        var b = dot(d1, d2), den = a * e - b * b;
        s = den > 1e-18 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
        else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
      }
    }
    return len(sub(add(p0, mul(d1, s)), add(q0, mul(d2, t))));
  }

  /* =====================================================================
     BEACONS - the adapter. NSO_SupportBeacons.detect's own beacons, on its
     plan grid, exposed ones only (docs/SUPPORT-BEACONS.md): every spot that
     needs holding and can be reached from outside the piece. Each carries
     the id of the beacon region (the area) it belongs to. Nothing here
     decides what needs holding or where; it only asks.
     ===================================================================== */
  function gridBeacons(rawTris, opts) {
    opts = opts || {};
    var A = SA(opts), T = ST(opts), SB = SBM(opts);
    if (!A || !T) return { ok: false, reason: 'nso_support_aim.js and nso_support_tree.js must be loaded', beacons: [] };
    if (!SB || typeof SB.detect !== 'function') return { ok: false, reason: 'nso_support_beacons.js must be loaded', beacons: [] };
    if (opts.skipList === undefined) {
      return { ok: false, reason: 'the planner needs opts.skipList - pass nsoMaskFaceList(m), or [] to state ' +
        'that nothing is painted; there is no unpainted default', beacons: [] };
    }
    /* The pitch is the contact span, or wider when the strut is. A pair's
       merge node sits half a pitch along a row, so the next row's points are
       sqrt(5)/2 pitches from it; the merged column must clear them (touch()),
       or no merge can ever go ahead. The detector's own 3 mm holds up to a
       1.7 mm strut; a 2 mm strut gets 3.41, a 3 mm one 4.94. */
    var st = A.buildStrut(opts), side = st.ok ? st.sideMm : 0;
    var pitch = Math.max(opts.pitchMm == null ? SB.PITCH_DEFAULT_MM : +opts.pitchMm,
                         touch(sideFor(side, 2), side) / (Math.sqrt(5) / 2));
    var det = SB.detect(rawTris, {
      pitch: pitch, angleDeg: opts.angleDeg, plateZ: opts.plateZ, minDropMm: opts.minDropMm,
      skipList: opts.skipList, occluders: opts.occluders, planeTol: opts.planeTol, bridgeMm: opts.bridgeMm
    });
    if (!det.ok) return { ok: false, reason: det.reason, detect: det, beacons: [] };
    var regions = opts.regionId == null ? det.regions : det.regions.filter(function (r) { return r.id === (opts.regionId | 0); });
    if (opts.regionId != null && !regions.length) {
      return { ok: false, reason: 'there is no overhang ' + ((opts.regionId | 0) + 1) + ' on this piece', detect: det, beacons: [] };
    }
    var out = [];
    regions.forEach(function (r) {
      r.beacons.forEach(function (b) {
        out.push({ id: out.length, p: [b.x, b.y, b.z], n: b.normal.slice(), regionId: r.id, source: 'detect', kind: b.need.kind });
      });
    });
    return { ok: true, reason: out.length + ' support point(s)', beacons: out, detect: det, regions: regions, pitchMm: pitch };
  }

  /* The ONE place the beacon source is chosen.

     EXPLICIT BEACONS (opts.beacons). The caller's own list, planned as it
     is: the Supports card hands in the detected set with the user's manual
     and painted edits already applied. Each entry is either the planner's
     { p, n } or a detector record { x, y, z, normal } (nso_support_beacons.js),
     and may carry regionId and key; both ride through untouched, so a trunk
     and a solid can say which region and which beacons they hold. Detection
     still runs for the plate, without its beacon grid - the list given IS the
     beacons - and names no region: the caller's regionIds are the only ones. */
  function beaconsFor(rawTris, opts) {
    if (opts.beacons) {
      var A = SA(opts), det = A.detectOverhangs(rawTris, Object.assign({}, opts, { beacons: false }));
      return { ok: det.ok, reason: det.reason, detect: det, regions: [],
               pitchMm: opts.pitchMm == null ? ST(opts).MAX_SPAN_MM : +opts.pitchMm,
               beacons: opts.beacons.map(function (b, i) {
                 var p = b.p ? b.p : [b.x, b.y, b.z], n = b.n || b.normal;
                 return { id: i, p: p.slice(), n: (unit(n || [0, 0, -1]) || [0, 0, -1]).slice(), regionId: b.regionId,
                          key: b.key, source: b.source || 'given' };
               }) };
    }
    return gridBeacons(rawTris, opts);
  }

  /* =====================================================================
     THE FEED - the user's points (opts.feed). docs/SUPPORT-GRIDPACK.md "Feed".
     =====================================================================
     Three ways to feed the planner; the card picks one. Absent (or
     { mode: 'auto' } with nothing else) is today's plan, byte for byte.
       auto      detection's beacons, as today. Takes only `excluded`.
       assisted  detection's beacons (opts.beacons when given, as the card's
                 area), less beaconsOff, plus tips; landingZones.
       custom    no beacon grid: the tips given are every tip; landingZones.
     opts.feed = { mode, tips: [{ x, y, z }], beaconsOff: [tip ids],
                   landingZones: [{ x, y, r }], excluded: [member ids],
                   knobs: { trunkTipMm, trunkAngleDeg, leanDeg, nodeMm } }   (THE KNOBS, below)
     A TIP ID names a spot: 'b' + its point (a detected beacon) or 'u' + the
     point given (a tip of the user's), each coordinate to 0.01 mm - so the
     id of a spot is the same in every build that has it. A given tip is
     snapped to the nearest face of the piece within SNAP_MM and takes that
     face's normal: from there it is planned as a detected beacon at that
     spot is (the same nudge, cap, sheet and gap). One on no face within
     SNAP_MM, or on a face turned up more than UP_MAX, is refused and
     reported (plan.feed.refused), never moved. */
  var SNAP_MM = 1;             /* a given tip this far off the piece is on no face */
  var UP_MAX = 0.26;           /* a face turned up more than this holds nothing (app-supports-card.js's own figure) */
  var KEEP_TRIM_MM = LATTICE_MM;   /* an erased member's keep-out starts this far down from a tip it held */
  var FEED_MODES = { auto: true, assisted: true, custom: true };
  /* THE KNOBS (opts.feed.knobs; an Assisted or Custom feed's "playground").
     Four numbers the planner and the trunk builder have always had as
     constants; given, they are read in every place the constant was:
       trunkTipMm     TRUNK_TIP_MM     the trunk law's diameter at the top (growTrunks, reland, the TRUNK descriptor)
       trunkAngleDeg  TRUNK_ANGLE_DEG  the half-angle it grows going down (the same three)
       leanDeg        BRANCH_TILT_DEG  the lean limit (plan(), reland's reach)
       nodeMm         LATTICE_MM       the node lattice L (plan(); the erased-member keep-out's trim)
     Absent, the plan is today's, byte for byte. There is no floor and no
     ceiling: a number must be finite and > 0 (trunkAngleDeg >= 0: 0 is a
     straight trunk) and the geometry decides the rest. What a value breaks
     is REPORTED (plan.knobs.problems), never clamped. The flare, the pad, the
     interface and the hollow core are not knobs. */
  var KNOB_KEYS = ['trunkTipMm', 'trunkAngleDeg', 'leanDeg', 'nodeMm'];
  function knobsOf(k) {
    if (k == null) return null;
    if (typeof k !== 'object' || Array.isArray(k)) return { error: 'feed.knobs is not an object' };
    var given = {}, n = 0, keys = Object.keys(k);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i], v = k[key];
      if (KNOB_KEYS.indexOf(key) < 0) return { error: 'unknown knob ' + JSON.stringify(key) + ' (' + KNOB_KEYS.join(', ') + ')' };
      if (v == null) continue;
      if (typeof v !== 'number' || !isFinite(v)) return { error: 'feed.knobs.' + key + ' is not a finite number: ' + JSON.stringify(v) };
      if (key === 'trunkAngleDeg' ? v < 0 : !(v > 0)) return { error: 'feed.knobs.' + key + ' must be ' + (key === 'trunkAngleDeg' ? '>= 0 (0 is a straight trunk)' : '> 0') + ', got ' + v };
      given[key] = v; n++;
    }
    return n ? { given: given } : null;
  }
  function fmt2(v) { return (Math.round(v * 100) / 100).toFixed(2); }
  function tipId(p, given) { return (given ? 'u' : 'b') + fmt2(p[0]) + ',' + fmt2(p[1]) + ',' + fmt2(p[2]); }
  function tidOf(b) { return b.tid || tipId(b.p, false); }
  /* FNV-1a, 32 bits: a member's id from what it is */
  function hash32(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  /* The feed, checked: null when it asks for nothing (today's plan), else
     { mode, tips, off, zones, excluded } or { error }. */
  function feedOf(opts) {
    var f = opts && opts.feed;
    if (f == null) return null;
    if (typeof f !== 'object') return { error: 'opts.feed is not an object' };
    var mode = f.mode == null ? 'auto' : String(f.mode);
    if (!FEED_MODES[mode]) return { error: 'unknown feed mode ' + JSON.stringify(f.mode) + ' (auto, assisted or custom)' };
    var tips = f.tips || [], off = f.beaconsOff || [], zones = f.landingZones || [], ex = f.excluded || [];
    if (!Array.isArray(tips) || !Array.isArray(off) || !Array.isArray(zones) || !Array.isArray(ex)) {
      return { error: 'feed.tips, beaconsOff, landingZones and excluded are lists' };
    }
    if (mode === 'auto' && (tips.length || off.length || zones.length)) {
      return { error: 'feed mode auto takes no tips, beaconsOff or landingZones - say assisted or custom' };
    }
    var kn = knobsOf(f.knobs);
    if (kn && kn.error) return kn;
    if (kn && mode === 'auto') return { error: 'feed mode auto takes no knobs - say assisted or custom' };
    if (mode === 'custom' && off.length) return { error: 'beaconsOff is for assisted: custom has no beacons to turn off' };
    for (var i = 0; i < tips.length; i++) {
      var t = tips[i];
      if (!t || !isFinite(t.x) || !isFinite(t.y) || !isFinite(t.z)) return { error: 'feed.tips[' + i + '] is not { x, y, z }' };
    }
    for (i = 0; i < zones.length; i++) {
      var z = zones[i];
      if (!z || !isFinite(z.x) || !isFinite(z.y) || !(z.r > 0)) return { error: 'feed.landingZones[' + i + '] is not { x, y, r } with r > 0' };
    }
    if (mode === 'auto' && !ex.length) return null;
    var offSet = {}, exSet = {};
    off.forEach(function (id) { offSet[String(id)] = true; });
    ex.forEach(function (id) { exSet[String(id)] = true; });
    return { mode: mode, tips: tips, off: offSet, zones: zones.map(function (q) { var z = { x: +q.x, y: +q.y, r: +q.r }; if (q.maxKids != null) z.maxKids = Math.max(2, Math.round(+q.maxKids)); return z; }),
             excluded: ex.map(String), exSet: exSet, knobs: kn };
  }
  /* The nearest point of the piece to q, and its face's unit normal. */
  function nearestFace(soup, q) {
    var best = null;
    for (var i = 0; i + 8 < soup.length; i += 9) {
      var a = [soup[i], soup[i + 1], soup[i + 2]], b = [soup[i + 3], soup[i + 4], soup[i + 5]], c = [soup[i + 6], soup[i + 7], soup[i + 8]];
      var n = unit(cross(sub(b, a), sub(c, a)));
      if (!n) continue;
      var x = closestOnTri(q, a, b, c), d = len(sub(q, x));
      if (!best || d < best.d) best = { d: d, p: x, n: n };
    }
    return best;
  }
  /* Ericson's closest point on a triangle. */
  function closestOnTri(p, a, b, c) {
    var ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
    if (d1 <= 0 && d2 <= 0) return a;
    var bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) return b;
    var vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, mul(ab, d1 / (d1 - d3)));
    var cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
    if (d6 >= 0 && d5 <= d6) return c;
    var vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, mul(ac, d2 / (d2 - d6)));
    var va = d3 * d6 - d5 * d4;
    if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) return add(b, mul(sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
    var den = 1 / (va + vb + vc);
    return add(a, add(mul(ab, vb * den), mul(ac, vc * den)));
  }
  /* The beacons a fed plan starts from: beaconsFor's (none in custom), less
     the ones turned off or erased, plus the tips given. Each carries its tip
     id (tid). Refused tips and the beacons left out are on the answer. */
  function feedBeacons(rawTris, opts, F) {
    var bc = beaconsFor(rawTris, F.mode === 'custom' && !opts._stairBeacons ? Object.assign({}, opts, { beacons: [] }) : opts);
    if (!bc.ok) return bc;
    var list = [], off = [], erased = [], refused = [];
    bc.beacons.forEach(function (b) {
      var id = tipId(b.p, false);
      if (F.off[id]) { off.push(id); return; }
      if (F.exSet[id]) { erased.push(id); return; }
      list.push(Object.assign({}, b, { tid: id }));
    });
    var seen = {};
    F.tips.forEach(function (t) {
      var q = [+t.x, +t.y, +t.z], id = tipId(q, true);
      if (seen[id]) return;
      seen[id] = true;
      if (F.exSet[id]) { erased.push(id); return; }
      var nf = nearestFace(rawTris, q);
      if (!nf || nf.d > SNAP_MM) { refused.push({ tip: id, why: 'on no face of the piece within ' + SNAP_MM + ' mm' }); return; }
      if (nf.n[2] > UP_MAX) { refused.push({ tip: id, why: 'on a face turned up: nothing hangs there' }); return; }
      list.push({ p: nf.p.slice(), n: nf.n.slice(), regionId: t.regionId, key: t.key, source: 'given', tid: id });
    });
    list.forEach(function (b, i) { b.id = i; });
    bc.beacons = list;
    bc.feed = { mode: F.mode, off: off, erased: erased, refused: refused };
    if (!list.length) { bc.ok = false; bc.reason = 'no tips to plan: ' + (refused.length ? refused.length + ' refused, ' : '') + (off.length + erased.length) + ' left out'; }
    return bc;
  }

  /* Which regions a set of beacon ids belongs to: sorted, distinct, the
     beacons' own regionId (undefined ones left out). */
  function regionIdsOf(beacons, ids) {
    var seen = {}, out = [];
    ids.forEach(function (id) {
      var r = beacons[id] && beacons[id].regionId;
      if (r == null || seen[r]) return;
      seen[r] = true; out.push(r);
    });
    return out.sort(function (a, b) { return a - b; });
  }

  /* =====================================================================
     CLEARANCE - one leg, axis and rails, against the piece and occluders.
     ===================================================================== */
  function makeProbe(A, obstacles) {
    /* Every ray goes through the pieces' spatial indexes (aim's section 0b),
       straight-down ones through the footprint variant of the same query. */
    var grid = A._buildDownGrid(obstacles);
    /* Nearest blocking hit along a->b (distance from a), or -1. capA / capB:
       how much of each end the RAILS leave out (a tip's own cross-section is
       the cap's business, as in the tree's probeRails); the axis is always
       tested end to end but for the ray epsilon. */
    function leg(a, b, side, capA, capB, clear) {
      if (clear == null) clear = CLEAR_MM;
      var d = sub(b, a), L = len(d);
      if (!(L > 2 * RAY_EPS)) return -1;
      var u = mul(d, 1 / L);
      var vertical = Math.abs(u[0]) < 1e-12 && Math.abs(u[1]) < 1e-12;
      if (vertical && u[2] > 0) return leg(b, a, side, capB, capA, clear);
      function cast(o, t0, t1) {
        if (!(t1 - t0 > 2 * RAY_EPS)) return -1;
        var org = add(o, mul(u, t0));
        var h = vertical ? A._nearestHitDown(grid, org, RAY_EPS, t1 - t0 - RAY_EPS)
                         : A._nearestHit(obstacles, org, u, RAY_EPS, t1 - t0 - RAY_EPS);
        return h > 0 ? t0 + h : -1;
      }
      var best = cast(a, 0, L), offs = [];
      /* Eight rails on the section's circumscribed circle: every member's
         square is turned by its own phase (see PHASE), so the probe takes
         the circle any turn of it fits in. */
      var r = vertical ? [1, 0, 0] : (unit(cross(u, [0, 0, 1])) || [1, 0, 0]), s = cross(u, r), R = side / Math.SQRT2 + clear;
      for (var k = 0; k < 8; k++) {
        var t = 2 * Math.PI * k / 8;
        offs.push(add(mul(r, R * Math.cos(t)), mul(s, R * Math.sin(t))));
      }
      var rails = [];
      for (var j = 0; j < offs.length; j++) {
        var hh = cast(add(a, offs[j]), capA, L - capB);
        if (hh > 0 && (best < 0 || hh < best)) best = hh;
        rails.push(offs[j]);
      }
      if (best >= 0) return best;
      /* A line that crosses no face is wholly in material or wholly out of
         it, and lineBlockedAt cannot tell which - a rail that starts inside
         a wall beside the strut reads clear. lineInsideAt asks. */
      if (A.lineInsideAt(obstacles, a, u, L) >= 0) return 0;
      for (j = 0; j < rails.length; j++) {
        var t0 = capA, t1 = L - capB;
        if (!(t1 - t0 > 2 * RAY_EPS)) continue;
        var ins = A.lineInsideAt(obstacles, add(add(a, rails[j]), mul(u, t0)), u, t1 - t0);
        if (ins >= 0) return t0 + ins;
      }
      return -1;
    }
    return { leg: leg };
  }

  /* Two square columns, each free to turn (PHASE), touch inside this
     horizontal distance: their circumscribed radii plus both clearances. */
  function touch(sa, sb) { return (sa + sb) / Math.SQRT2 + 2 * CLEAR_MM; }
  /* Horizontal distance from column point c to the part of leg a -> n that
     is at or below c's own top (a column hangs from its anchor down). */
  function legNear(a, n, c) {
    var t0 = 0;
    if (a[2] > c[2]) { if (n[2] >= c[2]) return Infinity; t0 = (a[2] - c[2]) / (a[2] - n[2]); }
    var p = [a[0] + (n[0] - a[0]) * t0, a[1] + (n[1] - a[1]) * t0];
    var dx = n[0] - p[0], dy = n[1] - p[1], L2 = dx * dx + dy * dy;
    var t = L2 > 0 ? Math.max(0, Math.min(1, ((c[0] - p[0]) * dx + (c[1] - p[1]) * dy) / L2)) : 0;
    return Math.hypot(p[0] + dx * t - c[0], p[1] + dy * t - c[1]);
  }
  function sideFor(base, count) { return base * Math.sqrt(Math.min(count, AREA_CAP)); }
  function nodeOf(x, g) { return g * Math.round(x / g); }

  /* plan.knobs: the four values the plan and its trunks use (the ones not
     given are the constants they replace), what was given, the given ones
     that are not the default (the export names a support by these), and
     problems - what a value makes of the plan, found here and, once the
     solids are made, in shells(). Never a clamp: a value is used as given. */
  function knobsEcho(given, tiltDeg, L, T) {
    var k = { trunkTipMm: given.trunkTipMm != null ? given.trunkTipMm : TRUNK_TIP_MM,
              trunkAngleDeg: given.trunkAngleDeg != null ? given.trunkAngleDeg : TRUNK_ANGLE_DEG,
              leanDeg: tiltDeg, nodeMm: L, given: Object.assign({}, given), nonDefault: {}, problems: [] };
    var dflt = { trunkTipMm: TRUNK_TIP_MM, trunkAngleDeg: TRUNK_ANGLE_DEG, leanDeg: T.BRANCH_TILT_DEG, nodeMm: LATTICE_MM };
    KNOB_KEYS.forEach(function (key) { if (given[key] != null && given[key] !== dflt[key]) k.nonDefault[key] = given[key]; });
    if (given.leanDeg != null && !(tiltDeg < 90)) k.problems.push({ kind: 'lean', knob: 'leanDeg', what: 'a lean of ' + tiltDeg + ' deg is a leg lying flat or climbing, not a lean off vertical: tan() is no reach' });
    if (given.trunkAngleDeg != null && !(k.trunkAngleDeg < 90)) k.problems.push({ kind: 'angle', knob: 'trunkAngleDeg', what: 'a half-angle of ' + k.trunkAngleDeg + ' deg does not widen a trunk going down: tan() is no slope' });
    return k;
  }
  /* A problem found once the solids are made (parts(), shells()): one of each kind in plan.knobs.problems, however often it is found. */
  function knobProblem(p, kind, knob, what, count) {
    var list = p.knobs.problems;
    for (var i = list.length - 1; i >= 0; i--) if (list[i].kind === kind) list.splice(i, 1);
    list.push({ kind: kind, knob: knob, what: what, count: count });
  }
  /* Edges not shared by exactly one triangle each way (corners to 1e-5 mm): 0 for a closed shell. */
  function openEdges(soup) {
    var E = {}, K = function (i) { return Math.round(soup[i] * 1e5) + ',' + Math.round(soup[i + 1] * 1e5) + ',' + Math.round(soup[i + 2] * 1e5); };
    for (var t = 0; t + 8 < soup.length; t += 9) {
      var k = [K(t), K(t + 3), K(t + 6)];
      for (var e = 0; e < 3; e++) {
        var a = k[e], b = k[(e + 1) % 3], fwd = a < b, ek = fwd ? a + '|' + b : b + '|' + a, r = E[ek] || (E[ek] = [0, 0]);
        r[fwd ? 0 : 1]++;
      }
    }
    var bad = 0;
    for (var key in E) if (E[key][0] !== 1 || E[key][1] !== 1) bad++;
    return bad;
  }

  /* IS THIS POINT IN THE SOLID, counted with the surface's own sense. The probe's inside() is the parity of a +Z ray's
     crossings with coincident hits merged (nso_thickness.js: one surface, two records), and a part made of two shells that
     touch on a plane - a head standing on a wedge, as the six test heads are - has its two faces there merged into ONE
     crossing: every point under it reads inside, and no trunk may stand under the head. Here a crossing counts +1 where the
     ray meets a face turned down (it enters) and -1 where it meets one turned up (it leaves): two shells touching on a
     plane cancel, as they should. The ray is moved by a fixed fraction of a micron off the grid's edges. */
  var INSIDE_JIT = [0.001371, 0.002193];
  function insideSigned(P, q) {
    if (!P || !P.tris) return false;
    if (q[0] < P.lo[0] || q[0] > P.hi[0] || q[1] < P.lo[1] || q[1] > P.hi[1] || q[2] > P.hi[2]) return false;
    var x = q[0] + INSIDE_JIT[0], y = q[1] + INSIDE_JIT[1], z0 = q[2], wind = 0, tris = P.tris, idx = P._xyIndex;
    if (!idx) {
      idx = P._xyIndex = { cell: 2, map: new Map() };
      for (var t = 0; t < tris.length; t++) {
        var T = tris[t], i0 = Math.floor(Math.min(T[0][0], T[1][0], T[2][0]) / 2), i1 = Math.floor(Math.max(T[0][0], T[1][0], T[2][0]) / 2);
        var j0 = Math.floor(Math.min(T[0][1], T[1][1], T[2][1]) / 2), j1 = Math.floor(Math.max(T[0][1], T[1][1], T[2][1]) / 2);
        for (var i = i0; i <= i1; i++) for (var j = j0; j <= j1; j++) {
          var kk = i + ',' + j, b = idx.map.get(kk);
          if (!b) idx.map.set(kk, b = []);
          b.push(t);
        }
      }
    }
    var bucket = idx.map.get(Math.floor(x / 2) + ',' + Math.floor(y / 2));
    if (!bucket) return false;
    for (var u = 0; u < bucket.length; u++) {
      var V = tris[bucket[u]], ax = V[0][0], ay = V[0][1];
      var d = (V[1][1] - V[2][1]) * (V[0][0] - V[2][0]) + (V[2][0] - V[1][0]) * (V[0][1] - V[2][1]);
      if (Math.abs(d) < 1e-14) continue;                                   /* a wall: the ray runs along it */
      var l1 = ((V[1][1] - V[2][1]) * (x - V[2][0]) + (V[2][0] - V[1][0]) * (y - V[2][1])) / d;
      var l2 = ((V[2][1] - V[0][1]) * (x - V[2][0]) + (V[0][0] - V[2][0]) * (y - V[2][1])) / d, l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      var zh = l1 * V[0][2] + l2 * V[1][2] + l3 * V[2][2];
      if (zh <= z0) continue;
      wind += d > 0 ? -1 : 1;                                              /* d > 0: counter-clockwise from above = faces up = leaves */
    }
    return wind > 0;
  }

  /* =====================================================================
     CROWNS (supports-thinning-1) - the custom feed's tree: ONE per landing circle

     A circle carries every tip that is sent to it, as one tree. Its tips are
     split BY POSITION, recursively: the nearest pair up (the globally
     nearest first; an odd one out joins the nearest pair), the nearest
     pairs / nodes then group up the same way, 2 or 3 to a join, until at
     most 3 are left: those are the trunk's branches. 6 tips are 3 pairs,
     and a trunk with 3 branches (1 > 3 > 6); 12 are 6 pairs, 3 groups of
     two, and the trunk (1 > 3 > 6 > 12); one tip is a straight trunk; two
     are one split.
     crownTopology(leaves, forbid) -> { nodes, root, rounds }
       leaves: [{ pos: [x, y, z], key }]; forbid: { 'key;key': true } - a
       join that would carry exactly that set of tips is not made (an erased
       branch: the tree is split around it)
       nodes[i]: { id, leaf, kids: [node ids], tips: [leaf ids], pos: [x, y, z]
       (the tips' centroid), level (0 for a tip, else 1 + its deepest kid) }
       rounds: how many nodes each round of grouping left - [12, 6, 3, 1]
     ===================================================================== */
  function crownTopology(leaves, forbid, maxKids) {
    maxKids = maxKids || CROWN_MAX_KIDS;
    var nodes = leaves.map(function (L, i) {
      return { id: i, leaf: true, kids: [], tips: [i], pos: L.pos.slice(), keys: [L.key], level: 0 };
    });
    var cur = nodes.map(function (n) { return n.id; }), rounds = [cur.length];
    var banned = function (idsA) {
      if (!forbid) return false;
      var ks = [];
      idsA.forEach(function (id) { ks = ks.concat(nodes[id].keys); });
      return !!forbid[ks.slice().sort().join(';')];
    };
    function dist(a, b) { return len(sub(nodes[a].pos, nodes[b].pos)); }
    while (cur.length > maxKids) {
      var pairs = [], i, j;
      for (i = 0; i < cur.length; i++) for (j = i + 1; j < cur.length; j++) pairs.push({ a: cur[i], b: cur[j], d: dist(cur[i], cur[j]) });
      pairs.sort(function (p, q) { return (p.d - q.d) || (p.a - q.a) || (p.b - q.b); });
      var used = {}, groups = [];
      /* the globally nearest pair first, each node at most once - a pair that would repeat an erased join waits */
      pairs.forEach(function (p) { if (!used[p.a] && !used[p.b] && !banned([p.a, p.b])) { used[p.a] = used[p.b] = true; groups.push([p.a, p.b]); } });
      /* a pair nothing allowed was left over: pair what is left, nearest first, whatever was erased - the tree is still built */
      var left = cur.filter(function (id) { return !used[id]; });
      while (left.length > 1) {
        var best = null;
        for (i = 0; i < left.length; i++) for (j = i + 1; j < left.length; j++) {
          var d = dist(left[i], left[j]);
          if (!best || d < best.d - 1e-12) best = { a: left[i], b: left[j], d: d };
        }
        used[best.a] = used[best.b] = true; groups.push([best.a, best.b]);
        left = left.filter(function (id) { return !used[id]; });
      }
      /* an odd one out joins the nearest group (a join of 3), by the distance to the group's centroid */
      if (left.length) {
        var gi = -1, gd = Infinity;
        groups.forEach(function (gr, k) {
          var c = [0, 0, 0], n = 0;
          gr.forEach(function (id) { var w = nodes[id].tips.length; c = add(c, mul(nodes[id].pos, w)); n += w; });
          var dd = len(sub(mul(c, 1 / n), nodes[left[0]].pos));
          if (dd < gd - 1e-12 && gr.length < maxKids) { gd = dd; gi = k; }
        });
        if (gi < 0) { groups.push([left[0]]); } else groups[gi].push(left[0]);
      }
      var next = groups.map(function (gr) {
        var tips = [], keys = [], c = [0, 0, 0], lv = 0;
        gr.forEach(function (id) {
          var nd = nodes[id];
          tips = tips.concat(nd.tips); keys = keys.concat(nd.keys); lv = Math.max(lv, nd.level);
          c = add(c, mul(nd.pos, nd.tips.length));
        });
        var nn = { id: nodes.length, leaf: false, kids: gr.slice(), tips: tips, keys: keys, level: lv + 1, pos: mul(c, 1 / tips.length) };
        nodes.push(nn);
        return nn.id;
      });
      cur = next;
      rounds.push(cur.length);
    }
    /* what is left is the trunk's: it holds 1, 2 or 3 */
    var tipsAll = [], keysAll = [], cc = [0, 0, 0], lvAll = 0;
    cur.forEach(function (id) { var nd = nodes[id]; tipsAll = tipsAll.concat(nd.tips); keysAll = keysAll.concat(nd.keys); lvAll = Math.max(lvAll, nd.level); cc = add(cc, mul(nd.pos, nd.tips.length)); });
    var root = { id: nodes.length, leaf: false, root: true, kids: cur.slice(), tips: tipsAll, keys: keysAll, level: lvAll + 1, pos: mul(cc, 1 / tipsAll.length) };
    nodes.push(root);
    if (rounds[rounds.length - 1] !== 1 || leaves.length === 1) rounds.push(1);
    return { nodes: nodes, root: root.id, rounds: rounds };
  }

  /* =====================================================================
     THE PLAN
     ===================================================================== */
  function plan(rawTris, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '', stage: 'beacons', members: [], stubs: [], merges: [], pickups: [],
                steered: [], nudged: [], tight: [], unreachable: [], resting: [], inside: [], held: 0 };
    if (opts._feed) { out.offZone = []; out.zoneLanded = []; out.unmerged = []; }
    var A = SA(opts), T = ST(opts), say = progressOf(opts);
    if (!A || !T || typeof A.detectOverhangs !== 'function') {
      out.reason = 'nso_support_aim.js and nso_support_tree.js must be loaded'; return out;
    }
    var style = opts.style == null ? 'tree' : String(opts.style);
    if (!(style in EAGERNESS)) { out.reason = 'unknown support style ' + JSON.stringify(opts.style); return out; }
    var eager = opts.mergeEagerness == null ? EAGERNESS[style] : +opts.mergeEagerness;
    out.style = style; out.eagerness = eager;
    /* the knobs (the feed's; a stair's own tree is handed its plan's as opts._knobs), each over the constant it replaces */
    var KN = (opts._feed && opts._feed.knobs) || opts._knobs || null, kg = KN ? KN.given : {};
    var tiltDeg = kg.leanDeg != null ? kg.leanDeg : (opts.branchTiltDeg == null ? T.BRANCH_TILT_DEG : +opts.branchTiltDeg);
    var L = kg.nodeMm != null ? kg.nodeMm : (opts.latticeMm == null ? LATTICE_MM : +opts.latticeMm), g = L / 2;
    if (KN) out.knobs = knobsEcho(kg, tiltDeg, L, T);

    say('detecting', null, null, true);
    var F = opts._feed || null;
    var bc = F ? feedBeacons(rawTris, opts, F) : beaconsFor(rawTris, opts);
    if (F) out.feed = bc.feed || { mode: F.mode, off: [], erased: [], refused: [] };
    out.detect = bc.detect;
    if (!bc.ok) { out.reason = bc.reason; return out; }
    out.region = (bc.regions && bc.regions.length) ? bc.regions[0] : null;
    if (!bc.beacons.length) { out.reason = bc.detect ? bc.detect.reason : 'no support points'; return out; }
    out.beacons = bc.beacons;
    out.pitchMm = bc.pitchMm;

    var strut = A.buildStrut(opts);
    if (!strut.ok) { out.reason = strut.reason; return out; }
    var s0 = strut.sideMm;
    out.sideMm = s0; out.floorMm = strut.floorMm;
    out.handSideMm = Math.max(A.STRUT_SIDE_DEFAULT_MM, strut.floorMm);
    var tanT = Math.tan(tiltDeg * Math.PI / 180), cosT = Math.cos(tiltDeg * Math.PI / 180);
    var plateZ = bc.detect.plateZ;
    var reach = (opts.pickupReachMm == null ? bc.pitchMm * 1.05 : +opts.pickupReachMm) * (eager > 0 ? 1 : 0);
    var rest = !!opts.restOnModel;
    /* opts.mergeThroughCrowd: a member in a node's way that cannot join the
       merge does not hold it up (a stair's own tree, a tip under every strip
       a layer apart, is crowded everywhere: held to the usual rule it merged
       nowhere and stood 93 struts on the plate; joining up to 8, or leaning
       45 deg, did not free it). Its legs may then pass through that member -
       support on support, kept as shells (shells(): the card's build, never
       welded). Where a leg only grazes one, the weld (support:shells'
       reference) closes a sliver of void the shells do not - the tilted box,
       z 6.10, 0.009 mm2: under a bead's cross-section, which support:shells
       does not count as a hole. */
    var crowd = !!opts.mergeThroughCrowd;
    out.branchTiltDeg = tiltDeg; out.latticeMm = L; out.plateZ = plateZ; out.restOnModel = rest;
    var obstacles = [rawTris].concat(opts.occluders || []);
    /* an erased member's keep-out (the feed's `excluded`): in the way of every
       leg, as the piece is - and nowhere else (detection never sees it) */
    if (opts._keepOut && opts._keepOut.length) obstacles = obstacles.concat(opts._keepOut);
    /* LANDING ZONES (the feed's): a trunk lands on the plate only where its
       CENTRE - the axis of its end - is inside a zone's circle; its pad and
       its flared trunk (TRUNKS) may spill past the line */
    var Z = F && F.zones.length ? F.zones : null;
    function zoneOf(q) {
      if (!Z) return -1;
      for (var zi = 0; zi < Z.length; zi++) if (Math.hypot(q[0] - Z[zi].x, q[1] - Z[zi].y) <= Z[zi].r + 1e-9) return zi;
      return -1;
    }
    /* ...and a merge or a pickup that would leave its member out of reach of
       every zone (its new anchor q) does not happen */
    function zoneReach(q) {
      for (var zi = 0; zi < Z.length; zi++) {
        if (Math.hypot(q[0] - Z[zi].x, q[1] - Z[zi].y) - Z[zi].r <= leanReach(q[2]) + 1e-9) return true;
      }
      return false;
    }
    /* One index per piece, built here once for the whole plan (or found, if
       this soup was planned before and is unchanged: every value is checked,
       once, so an edit in place cannot leave a stale index behind). */
    obstacles.forEach(function (soup) { A._indexFor(soup, true); });
    var probe = makeProbe(A, obstacles);

    /* ---- refusal: a beacon inside the piece ---- */
    var live = [];
    /* Inside: the short line out of the point along its own normal is in
       material (lineInsideAt - a point that lies ON a face, a contact
       against a wall, is not inside; the nudge below deals with it). */
    bc.beacons.forEach(function (b) {
      if (A.lineInsideAt(obstacles, b.p, b.n, 0.2) >= 0) out.inside.push(b.id); else live.push(b);
    });
    if (!live.length) {
      out.reason = 'Every support point is inside the piece, so there is nowhere to start a support.';
      return out;
    }
    live.sort(function (a, b) { return (b.p[2] - a.p[2]) || (a.p[0] - b.p[0]) || (a.p[1] - b.p[1]) || (a.id - b.id); });
    /* A beacon is settled when it has a place in the plan or is refused: the
       ones inside the piece are settled already; the rest settle as the
       descent below starts them. */
    var nBeacons = bc.beacons.length, next = 0;
    say('planning', out.inside.length, nBeacons, true);

    /* ---- members ---- */
    var M = out.members;
    function newMember(path, count, beacons, kind, tipCap) {
      var m = { id: M.length, path: path, count: count, side: sideFor(s0, count), beacons: beacons,
                kind: kind, free: true, end: null, child: -1, parents: [], tipCap: tipCap || 0 };
      M.push(m);
      return m;
    }
    function anchor(m) { return m.path[m.path.length - 1]; }
    function dropHit(p, side, cap) { return probe.leg(p, [p[0], p[1], plateZ], side, cap, 0); }

    /* THE TIP'S OWN ZONE. The rail test leaves a tip's last cross-section
       out (on a sloped face the cap's downhill corner meets the face by
       design). A WALL beside the tip is another matter: a tip within its
       section of a side wall has its top in the wall, and the interface
       finish then cannot keep its gap there (measured on the tab and tall
       arms, 0.07 mm and 0 mm from the post). So the tip's top TIP_ZONE_MM is
       swept with horizontal rays at a few heights, and anything nearer than
       the section's circumradius plus CLEAR_MM is a wall - except the face
       the tip is holding up, recognised by lying in its tangent plane. */
    function tipClear(q, n, side, margin) {
      var need = side / Math.SQRT2 + (margin == null ? CLEAR_MM : margin);
      for (var hi = 0; hi < TIP_LEVELS.length; hi++) {
        var o = [q[0], q[1], q[2] - TIP_LEVELS[hi]];
        for (var k = 0; k < STEER_HEADINGS; k++) {
          var t = 2 * Math.PI * k / STEER_HEADINGS, d = [Math.cos(t), Math.sin(t), 0], t0 = RAY_EPS;
          for (var guard = 0; guard < 4; guard++) {
            var h = A._nearestHit(obstacles, o, d, t0, need);
            if (!(h > 0)) break;
            var x = add(o, mul(d, h));
            if (Math.abs(dot(sub(x, q), n)) < 0.02) { t0 = h + RAY_EPS; continue; }   /* the supported face */
            return false;
          }
        }
      }
      return true;
    }

    /* A beat for the listener from inside a long step (a steer, a level's
       merges): the same numbers again, let through once HEARTBEAT_MS has
       passed since the last message. */
    function beat() { say('planning', out.inside.length + next, nBeacons); }

    /* A member just made: a clear drop, a steer, a rest, or nothing. */
    function settle(m) {
      var a = anchor(m), cap = m.path.length === 1 ? m.tipCap : 0;
      var fresh = m.kind === 'beacon' && m.path.length === 1;
      var n = fresh ? out.beacons[m.beacon].n : null;
      var tipOk = !fresh || tipClear(a, n, m.side);
      if (tipOk && dropHit(a, m.side, cap) < 0) return true;
      if (tipOk && steer(m, a, cap)) return true;
      /* A TIP AGAINST A WALL: the tip is moved straight off it, along the
         face's own tangent plane, by the least of NUDGE_STEPS that gives a
         clear tip and a clear drop (or, failing that, a clear tip and a
         steer - tried once per step) - the old tree's clearWalls, here for
         every point, and reported. The moved tip is still under the face.
         A tip that reads clear but has no route - one lying exactly ON a
         wall, whose rays start in the wall's plane and cannot see it - tries
         the same moves for a straight drop only. */
      if (fresh) {
        var cands = [];
        for (var si = 0; si < NUDGE_STEPS.length; si++) {
          var dd = NUDGE_STEPS[si] * s0;
          for (var h0 = 0; h0 < STEER_HEADINGS; h0++) {
            beat();
            var th = 2 * Math.PI * h0 / STEER_HEADINGS, dx = Math.cos(th) * dd, dy = Math.sin(th) * dd;
            var q = [a[0] + dx, a[1] + dy, a[2] - (n[0] * dx + n[1] * dy) / n[2]];
            if (!(A._nearestHit(obstacles, [q[0], q[1], q[2] - 0.2], [0, 0, 1], 0, 0.4) > 0)) continue;
            if (!tipClear(q, n, m.side)) continue;
            cands.push({ q: q, mm: dd, step: si });
          }
        }
        var pickQ = null, i, tried = {};
        for (i = 0; i < cands.length && !pickQ; i++) if (dropHit(cands[i].q, m.side, cap) < 0) pickQ = cands[i];
        for (i = 0; i < cands.length && !pickQ && !tipOk; i++) {
          if (tried[cands[i].step]) continue;
          tried[cands[i].step] = true;
          m.path[0] = cands[i].q;
          if (steer(m, cands[i].q, cap)) pickQ = cands[i];
          else m.path[0] = a;
        }
        if (pickQ) {
          out.nudged.push({ beacon: m.beacon, from: a.slice(), to: pickQ.q.slice(), mm: pickQ.mm });
          m.path[0] = pickQ.q;
          return true;
        }
        /* No move clears it by the margin: a tip that does not TOUCH the
           wall stays where it is (the interface ladder takes a smaller
           patch there, or cuts at the gap). */
        if (!tipOk && tipClear(a, n, m.side, 0)) {
          out.tight.push(m.beacon);
          if (dropHit(a, m.side, cap) < 0 || steer(m, a, cap)) return true;
        }
      }
      if (rest) {
        var hit = dropHit(a, m.side, cap);
        var zs = a[2] - hit;
        if (zs - plateZ > PAD_LAYERS_MM + GAP_MM && hit > GAP_MM + PAD_LAYERS_MM) {
          m.pad = { z0: zs + GAP_MM, z1: zs + GAP_MM + PAD_LAYERS_MM, surfaceZ: zs };
          m.path.push([a[0], a[1], m.pad.z0 + PAD_LAYERS_MM / 2]);
          m.free = false; m.end = 'rest';
          return true;
        }
      }
      m.free = false; m.end = 'none';
      return false;
    }

    /* STEER: for each heading at theta and theta/2, the leaning line from
       the anchor is walked down the lattice levels; the first point from
       which the drop is clear wins, shallowest first. */
    function steer(m, a, cap) {
      var best = null;
      for (var li = 0; li < STEER_LEANS.length; li++) {
        for (var hi = 0; hi < STEER_HEADINGS; hi++) {
          beat();
          var t = 2 * Math.PI * hi / STEER_HEADINGS, u = [Math.cos(t), Math.sin(t)], lean = tanT * STEER_LEANS[li];
          for (var k = Math.floor((a[2] - plateZ) / g - 1e-9); k >= 0; k--) {
            var z = plateZ + k * g, D = a[2] - z;
            if (best && D >= best.D) break;
            var W = [a[0] + u[0] * D * lean, a[1] + u[1] * D * lean, z];
            if (probe.leg(a, W, m.side, cap, 0) >= 0) break;          /* the leaning line itself is blocked */
            if (k === 0 && Z && zoneOf(W) < 0) break;              /* on the plate, but in no landing zone */
            if (k === 0 || dropHit(W, m.side, 0) < 0) { best = { D: D, W: W, heading: hi, lean: STEER_LEANS[li] }; break; }
          }
        }
      }
      if (!best) return false;
      m.path.push(best.W);
      out.steered.push({ member: m.id, to: best.W.slice(), leanDeg: Math.atan(tanT * best.lean) * 180 / Math.PI });
      if (best.W[2] <= plateZ + 1e-9) { m.free = false; m.end = 'plate'; }
      return true;
    }
    function drop(m) {                     /* nothing built for it */
      m.dead = true;
      m.beacons.forEach(function (id) { out.unreachable.push(id); });
    }
    /* THE PLATE: a free member drops straight down - into a landing zone
       when there are any (zoneLand); a merge or a pickup that then lands in
       no zone is undone and its branches land alone (unmerge), so the zone
       rule drops only a tip that no zone can take by itself. */
    function landAt0(m) {
      var a = anchor(m);
      if (!Z || zoneOf(a) >= 0) { m.path.push([a[0], a[1], plateZ]); m.free = false; m.end = 'plate'; return; }
      if (zoneLand(m)) return;
      if (m.parents.length) { unmerge(m); return; }
      m.free = false; m.end = 'none';
      m.beacons.forEach(function (id) { out.offZone.push(id); });
      drop(m);
    }
    function unmerge(m) {
      m.dead = true; m.free = false; m.end = 'none';
      out.unmerged.push({ member: m.id, kind: m.kind, parents: m.parents.slice() });
      out.merges = out.merges.filter(function (x) { return x.member !== m.id; });
      var stub = null;
      if (m.kind === 'pickup') {
        out.stubs.forEach(function (x) { if (x.member === m.id) stub = x; });
        out.stubs = out.stubs.filter(function (x) { return x.member !== m.id; });
        out.pickups = out.pickups.filter(function (x) { return x.member !== m.id; });
      }
      m.parents.forEach(function (id) {
        var q = M[id];
        q.path.pop(); q.free = true; q.end = null; q.child = -1; delete q.childSide;
      });
      m.parents.forEach(function (id) { landAt0(M[id]); });
      /* the beacon the pickup's stub held starts a strut of its own */
      if (stub) {
        var b = out.beacons[stub.beacon], nm = newMember([b.p.slice()], 1, [b.id], 'beacon', s0);
        nm.beacon = b.id;
        if (!settle(nm)) drop(nm);
        else if (nm.free) landAt0(nm);
      }
    }
    /* INTO A ZONE: a member whose drop would land in no landing zone leans
       from its anchor, within the lean limit, to the nearest point of a zone
       it can reach - its full lean then straight down, or one straight leg
       to the plate - clear of the piece and of every other tree's members
       (their columns' touch distance). Targets: each zone's nearest point to
       the anchor, its centre, and 16 headings round its rim, nearest first.
       A zone no member reaches stays empty, and is reported (plan.zones). */
    function zoneLand(m) {
      var a = anchor(m), cap = m.path.length === 1 ? m.tipCap : 0, H = a[2] - plateZ;
      var mine = {}, q = [m.id];
      while (q.length) { var id = q.pop(); if (mine[id]) continue; mine[id] = true; M[id].parents.forEach(function (pp) { q.push(pp); }); }
      var T = [];
      Z.forEach(function (z, zi) {
        var rIn = z.r - 1e-6;
        var c = [z.x, z.y], d0 = Math.hypot(a[0] - c[0], a[1] - c[1]);
        if (d0 > 1e-9) T.push({ zi: zi, k: -1, p: [c[0] + (a[0] - c[0]) / d0 * rIn, c[1] + (a[1] - c[1]) / d0 * rIn] });
        T.push({ zi: zi, k: 0, p: c });
        for (var h = 0; h < STEER_HEADINGS; h++) {
          var t = 2 * Math.PI * h / STEER_HEADINGS;
          T.push({ zi: zi, k: h + 1, p: [c[0] + rIn * Math.cos(t), c[1] + rIn * Math.sin(t)] });
        }
      });
      T.forEach(function (t) { t.d = Math.hypot(t.p[0] - a[0], t.p[1] - a[1]); });
      T.sort(function (x, y) { return (x.d - y.d) || (x.zi - y.zi) || (x.k - y.k); });
      function apart(legs) {
        for (var i = 0; i < M.length; i++) {
          var o = M[i];
          if (o.dead || mine[o.id]) continue;
          for (var j = 0; j + 1 < o.path.length; j++) {
            for (var l = 0; l < legs.length; l++) if (segDist(legs[l][0], legs[l][1], o.path[j], o.path[j + 1]) < touch(m.side, o.side)) return false;
          }
        }
        return true;
      }
      for (var i = 0; i < T.length; i++) {
        beat();
        var tg = T[i], P0 = [tg.p[0], tg.p[1], plateZ];
        if (tg.d > H * tanT + 1e-9) break;              /* the rest are farther still */
        var routes = [];
        if (tg.d > 1e-9) {
          var W = [tg.p[0], tg.p[1], a[2] - tg.d / tanT];
          if (W[2] > plateZ + 1e-9) routes.push([W, P0]);
        }
        routes.push([P0]);
        for (var r = 0; r < routes.length; r++) {
          var pts = [a].concat(routes[r]), ok = true;
          for (var s = 0; s + 1 < pts.length && ok; s++) {
            ok = probe.leg(pts[s], pts[s + 1], m.side, s === 0 ? cap : 0, 0) < 0;
          }
          var legs = [];
          for (s = 0; s + 1 < pts.length; s++) legs.push([pts[s], pts[s + 1]]);
          if (!ok || !apart(legs)) continue;
          routes[r].forEach(function (pt) { m.path.push(pt.slice()); });
          m.free = false; m.end = 'plate';
          out.zoneLanded.push({ member: m.id, zone: tg.zi, to: P0.slice() });
          return true;
        }
      }
      return false;
    }

    /* =====================================================================
       THE CROWNS (supports-thinning-1; docs/SUPPORT-GRIDPACK.md section 8)

       Custom feed with landing circles: every tip is built, and each circle
       carries ONE tree of the tips sent to it. No lattice descent, no merge,
       no pickup, nothing refused: a connection over the lean limit is built
       as planned and marked (plan.overLean) with a spot on the plate where a
       drop from it would sit inside the limit (plan.suggested).
         1. a tip near a wall is moved off it (the nudge, as every tip);
         2. a tip goes to the circle the zone rule sends it to - the nearest
            circle it reaches within the lean with a clear route (zoneLand's
            targets); none does: the nearest circle;
         3. a circle's tips are split by position (crownTopology): the joins;
         4. the trunk stands on the circle's centre, or the nearest point of
            the circle where it fits (RELAND's test), its top the first join;
         5. the joins: each one laterally between its tips' centroid and the
            trunk's axis (the nearer the trunk, the nearer the axis), as high
            as the design lean (half Bambu's widest measured angle) lets it
            sit under its branches, never nearer than a cap or a ball needs;
         6. the thickness: a join keeps its area (the parent's cross-section
            is the sum of its children's, CROWN_AREA_RATIO), a branch widens
            going down at the trunk's angle, the trunk is at least Bambu's law
            at every height (TRUNKS) and oval - area kept - along the spread
            of the tips it carries (CROWN_OVAL_MAX); the branches off the
            trunk start along its long axis, where they are going.
       ===================================================================== */
    function leanReach(z) { return (z - plateZ) * tanT; }
    function crownPlan() {
      var TH = TM(opts), CK = crownKnobs(opts), taD = Math.tan(CK.trunk.angleDeg * Math.PI / 180), tbD = Math.tan(CK.trunk.flareAngleDeg * Math.PI / 180);
      out.crownKnobs = CK;
      out.footClearMm = CK.trunk.footClearMm;
      var cosN = Math.cos(Math.PI / TRUNK_SIDES), zf = plateZ + CK.trunk.flareMm, taB = Math.tan(CK.branchTaperDeg * Math.PI / 180);
      var foot = opts.firstLayerMm == null ? FOOT_LAYER_MM : +opts.firstLayerMm;
      /* the lean a branch is DESIGNED to: half the widest angle Bambu's joins measure, so that a branch and the one it
         joins never bend past it (the limit itself, tiltDeg, is what marks) */
      var tanD = Math.tan((CK.designLeanDeg != null ? CK.designLeanDeg : Math.min(tiltDeg, JOINS.angleDeg[1] / 2)) * Math.PI / 180);
      /* THE LEAN LIMIT OF A BRANCH: a leg over the hard lean (CK.leanHardDeg, 75: a bar lying nearly flat, which will not print) is brought down to
         the lean limit (tiltDeg) - its join stands lower, or its end meets the trunk lower, where it is going. A stair's own tree (_stairTree) holds
         the lean limit throughout. The legs between the two are as the plan has always made them (the marked over-lean members). */
      var tanLim = Math.tan(tiltDeg * Math.PI / 180), tanHard = opts._stairTree ? tanLim : Math.tan(Math.max(tiltDeg, CK.leanHardDeg) * Math.PI / 180);
      var thProbes = null;
      function probesTH() {
        if (!thProbes) thProbes = TH && typeof TH.prepare === 'function' ? obstacles.filter(function (sp) { return sp && sp.length >= 9; }).map(function (sp) { return probeOf(TH, sp); }).filter(Boolean) : [];
        return thProbes;
      }
      var forbid = null;
      if (opts._forbid && opts._forbid.length) { forbid = {}; opts._forbid.forEach(function (ids) { forbid[ids.slice().sort().join(';')] = true; }); }
      out.crowns = []; out.overLean = []; out.suggested = []; out.blocked = [];
      function law(z, H) { if (CK.trunk.uniformH != null) H = plateZ + CK.trunk.uniformH; return CK.trunk.tipMm / 2 + taD * Math.max(0, H - z) + flareAt(z, zf, tbD, CK.trunk.flareMm); }

      /* ---- 1. the tips, moved off a wall ---- */
      var tips = live.map(function (b) {
        var q = b.p.slice();
        if (CK.nudgeTips && !tipClear(q, b.n, s0, CK.nudgeMarginMm)) {
          var found = null;
          for (var si = 0; si < NUDGE_STEPS.length && !found; si++) {
            var dd = NUDGE_STEPS[si] * s0;
            for (var h0 = 0; h0 < STEER_HEADINGS && !found; h0++) {
              beat();
              var th = 2 * Math.PI * h0 / STEER_HEADINGS, dx = Math.cos(th) * dd, dy = Math.sin(th) * dd;
              var c = [q[0] + dx, q[1] + dy, q[2] - (b.n[0] * dx + b.n[1] * dy) / b.n[2]];
              if (!(A._nearestHit(obstacles, [c[0], c[1], c[2] - 0.2], [0, 0, 1], 0, 0.4) > 0)) continue;
              if (!tipClear(c, b.n, s0, CK.nudgeMarginMm)) continue;
              found = { p: c, mm: dd };
            }
          }
          if (found) { out.nudged.push({ beacon: b.id, from: q.slice(), to: found.p.slice(), mm: found.mm }); q = found.p; }
          else out.tight.push(b.id);          /* no move clears it: the tip is built where it is (a wall beside it is the interface's to meet) */
        }
        var side = b.n[2] > -cosT + LEAN_TOL, hz = unit([b.n[0], b.n[1], 0]) || [1, 0, 0];
        return { b: b, p: q, side: side, attach: side ? add(q, mul(hz, s0 + CLEAR_MM)) : q.slice(), key: tidOf(b) };
      });

      /* ---- 2. a tip's circle ---- */
      function targets(p, z) {
        var rIn = z.r - 1e-6, d0 = hdist(p, [z.x, z.y]), T = [];
        if (d0 <= z.r) T.push([p[0], p[1]]);
        if (d0 > 1e-9) T.push([z.x + (p[0] - z.x) / d0 * rIn, z.y + (p[1] - z.y) / d0 * rIn]);
        T.push([z.x, z.y]);
        for (var h = 0; h < STEER_HEADINGS; h++) { var t = 2 * Math.PI * h / STEER_HEADINGS; T.push([z.x + rIn * Math.cos(t), z.y + rIn * Math.sin(t)]); }
        return T.map(function (q, k) { return { p: q, k: k, d: hdist(p, q) }; }).sort(function (x, y) { return (x.d - y.d) || (x.k - y.k); });
      }
      function routeClear(p, z) {
        var H = p[2] - plateZ, T = targets(p, z);
        for (var i = 0; i < T.length; i++) {
          beat();
          var tg = T[i], P0 = [tg.p[0], tg.p[1], plateZ];
          if (tg.d > H * tanT + 1e-9) break;
          var routes = [];
          if (tg.d > 1e-9) { var W = [tg.p[0], tg.p[1], p[2] - tg.d / tanT]; if (W[2] > plateZ + 1e-9) routes.push([W, P0]); }
          routes.push([P0]);
          for (var r = 0; r < routes.length; r++) {
            var pts = [p].concat(routes[r]), ok = true;
            for (var s = 0; s + 1 < pts.length && ok; s++) ok = probe.leg(pts[s], pts[s + 1], s0, s === 0 ? s0 : 0, 0) < 0;
            if (ok) return true;
          }
        }
        return false;
      }
      function assignZone(t) {
        var p = t.attach, order = Z.map(function (z, zi) { return { zi: zi, d: Math.max(0, hdist(p, [z.x, z.y]) - z.r) }; });
        order.sort(function (x, y) { return (x.d - y.d) || (x.zi - y.zi); });
        for (var i = 0; i < order.length; i++) {
          if (!(order[i].d <= leanReach(p[2]) + 1e-9)) break;
          if (routeClear(p, Z[order[i].zi])) return order[i].zi;
        }
        return order[0].zi;                /* no circle takes it within the lean: the nearest, and its connection says so */
      }
      var mine = Z.map(function () { return []; });
      tips.forEach(function (t) { mine[assignZone(t)].push(t); });

      /* ---- 3 - 6. a circle's tree ---- */
      function buildCrown(zi, list) {
        var zone = Z[zi], ci = out.crowns.length;
        var topo = crownTopology(list.map(function (t) { return { pos: t.attach, key: t.key }; }), forbid, zone.maxKids || CK.maxKids), nodes = topo.nodes, root = nodes[topo.root];
        var Dleaf = 1;
        (function walk(n, d, par) { n.depth = d; n.parent = par; n.kids.forEach(function (c) { walk(nodes[c], d + 1, n.id); }); if (n.leaf) Dleaf = Math.max(Dleaf, d); })(root, 0, -1);
        var order = nodes.slice().sort(function (a, b) { return (a.level - b.level) || (a.id - b.id); });
        var Hmax = Math.max.apply(null, list.map(function (t) { return t.p[2]; }));
        var zLow = Math.min.apply(null, list.map(function (t) { return t.attach[2]; }));
        var zRootMin = Math.max(plateZ + 1, Math.min(plateZ + CK.rootFloorMm, zLow - CK.tipDropMm));
        /* the spread of the tips: the oval's long axis */
        var n0 = list.length, cx0 = 0, cy0 = 0, i;
        list.forEach(function (t) { cx0 += t.attach[0] / n0; cy0 += t.attach[1] / n0; });
        var sxx = 0, syy = 0, sxy = 0;
        list.forEach(function (t) { var dx = t.attach[0] - cx0, dy = t.attach[1] - cy0; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; });
        var spreadAng = n0 > 1 ? 0.5 * Math.atan2(2 * sxy, sxx - syy) : 0;
        /* a stair grafted onto its circle's trunk takes that trunk's long axis */
        var gr = opts._graft && opts._graft[zi];
        if (gr) spreadAng = gr.ang;
        var uAx = [Math.cos(spreadAng), Math.sin(spreadAng)];
        var tr2 = sxx + syy, de = Math.sqrt(Math.max(0, (sxx - syy) * (sxx - syy) / 4 + sxy * sxy)), l1 = (tr2 / 2 + de) / n0, l2 = Math.max(0, tr2 / 2 - de) / n0;
        var elong = l1 < 1e-12 ? 1 : l2 < 1e-12 * l1 ? Infinity : Math.sqrt(l1 / l2), half = 0;
        if (gr) elong = Infinity;
        list.forEach(function (t) { half = Math.max(half, Math.abs((t.attach[0] - cx0) * uAx[0] + (t.attach[1] - cy0) * uAx[1])); });
        function ovalK(rEq) { return n0 < 2 || elong < 1.25 ? 1 : Math.min(CK.ovalMax, Math.max(1, half / rEq)); }
        var tipArea = s0 * s0, rTipOf = function (cnt) { return Math.sqrt(cnt * tipArea * CK.areaRatio / Math.PI); };
        var rootKids = root.kids;

        /* where everything stands, for a trunk on (Ax, Ay) */
        function solve(Ax, Ay, check) {
          var P = {}, S = {}, zOf = {};
          nodes.forEach(function (n) {
            if (n.leaf) { P[n.id] = list[n.tips[0]].attach.slice(); return; }
            if (n.root) return;
            var w = 1 - n.depth / Dleaf;
            P[n.id] = [n.pos[0] + w * (Ax - n.pos[0]), n.pos[1] + w * (Ay - n.pos[1]), 0];
          });
          var rEst = rTipOf(n0) * 1.15, kEst = ovalK(rEst), aEst = rEst * Math.sqrt(kEst);
          rootKids.forEach(function (cid) {
            var cp = P[cid], pr = (cp[0] - Ax) * uAx[0] + (cp[1] - Ay) * uAx[1], lim = Math.max(0, aEst - rTipOf(nodes[cid].tips.length)) * 0.9;
            var s = Math.max(-lim, Math.min(lim, pr));
            S[cid] = [Ax + uAx[0] * s, Ay + uAx[1] * s, 0];
          });
          order.forEach(function (n) {
            if (n.leaf) { zOf[n.id] = P[n.id][2]; return; }
            var floor = n.root ? zRootMin : zRootMin + n.depth * CK.nodeDropMm;
            /* how high the join may sit over (or under) its branches when it stands at `lat` */
            function zAt(lat) {
              var base = Infinity, mn = Infinity;
              n.kids.forEach(function (cid) {
                var c = nodes[cid], to = n.root ? S[cid] : lat, h = hdist(P[cid], to);
                var minDrop = c.leaf ? CK.tipDropMm : Math.max(CK.nodeDropMm, 1.25 * rTipOf(c.tips.length));
                base = Math.min(base, zOf[cid] - Math.max(h / tanD, minDrop)); mn = Math.min(mn, zOf[cid]);
              });
              /* a join stands no higher than its branches' lean (the limit, tiltDeg) lets it: a leg of 80 deg that the floor under the joins made is a
                 bar that will not print (the owner: "comes off the trunk at a 90"). The root's own legs are lowered one by one below (S). */
              var zOld = Math.min(Math.max(base, floor), mn - 0.5);
              if (n.root) return zOld;
              var over = false, zLn = Infinity;
              n.kids.forEach(function (cid) {
                var top = zOf[cid] - (nodes[cid].leaf ? CK.tipRiseMm : 0), h2 = hdist(P[cid], lat);
                if (h2 > tanHard * (top - zOld) + 1e-9) over = true;
                zLn = Math.min(zLn, top - h2 / tanLim);
              });
              return over ? Math.min(zOld, Math.max(zLn, plateZ + LEAN_FLOOR_MM)) : zOld;
            }
            if (n.root || !check) { zOf[n.id] = zAt(P[n.id]); if (!n.root) P[n.id][2] = zOf[n.id]; return; }
            /* against the piece (and what is erased): the join stands where its branches reach it clear - at its place, else
               the nearest place round it, first toward the trunk */
            var b0 = P[n.id].slice(), toward = Math.atan2(Ay - b0[1], Ax - b0[0]), best = null;
            function clearAt(lat) {
              var z = zAt(lat), at = [lat[0], lat[1], z];
              for (var ki = 0; ki < n.kids.length; ki++) {
                var c = nodes[n.kids[ki]];
                if (probe.leg(P[c.id], at, c.leaf ? s0 : rTipOf(c.tips.length) * Math.SQRT2, c.leaf ? s0 : 0, 0) >= 0) return null;
              }
              return z;
            }
            var z0 = clearAt([b0[0], b0[1]]);
            if (z0 != null) best = { lat: [b0[0], b0[1]], z: z0 };
            for (var ri = 0; ri < CK.nodeRings.length && !best; ri++) {
              for (var hi2 = 0; hi2 < STEER_HEADINGS && !best; hi2++) {
                beat();
                var hd = toward + (hi2 % 2 ? 1 : -1) * Math.ceil(hi2 / 2) * 2 * Math.PI / STEER_HEADINGS, lat2 = [b0[0] + CK.nodeRings[ri] * Math.cos(hd), b0[1] + CK.nodeRings[ri] * Math.sin(hd)];
                var zc = clearAt(lat2);
                if (zc != null) best = { lat: lat2, z: zc };
              }
            }
            if (best) { P[n.id][0] = best.lat[0]; P[n.id][1] = best.lat[1]; zOf[n.id] = best.z; }
            else zOf[n.id] = zAt(b0);
            P[n.id][2] = zOf[n.id];
          });
          var zTop = zOf[root.id];
          rootKids.forEach(function (cid) {
            /* a root's leg that would lean past the limit meets the trunk lower, where it is going: its end is inside the trunk's body */
            var topC = zOf[cid] - (nodes[cid].leaf ? CK.tipRiseMm : 0), hC = hdist(P[cid], S[cid]);
            S[cid][2] = hC > tanHard * (topC - zTop) + 1e-9 ? Math.min(zTop, Math.max(topC - hC / tanLim, plateZ + LEAN_FLOOR_MM)) : zTop;
          });
          /* the thickness: area kept at a join, widening going down */
          /* the uniform trunk (crown.trunk.uniformH): no branch is thicker than the trunk it joins - a stair's forty tips on one root made a
             tube 8 mm across over a 4 mm stem (the owner: "abnormally thick compared to the others") */
          var capR = CK.trunk.uniformH != null ? law(zTop, Hmax) : Infinity;
          var rTop = {}, rBot = {}, Abot = {}, rootA = 0;
          order.forEach(function (n) {
            if (n.leaf) { rTop[n.id] = rBot[n.id] = Math.sqrt(tipArea / Math.PI); Abot[n.id] = tipArea; return; }
            var A0 = 0;
            n.kids.forEach(function (cid) { A0 += Abot[cid]; });
            A0 *= CK.areaRatio;
            if (n.root) { rootA = A0; return; }
            rTop[n.id] = Math.min(Math.sqrt(A0 / Math.PI), capR);
            rBot[n.id] = Math.min(rTop[n.id] + taB * (zOf[n.id] - zOf[n.parent]), capR);
            Abot[n.id] = Math.PI * rBot[n.id] * rBot[n.id];
          });
          var rNeed = Math.sqrt(rootA / Math.PI), lawTop = law(zTop, Hmax), rEqTop = CK.trunk.uniformH != null ? lawTop : Math.max(lawTop, rNeed), k = ovalK(rEqTop);
          return { A: [Ax, Ay], P: P, S: S, z: zOf, zTop: zTop, rTop: rTop, rBot: rBot, rNeed: rNeed, lawTop: lawTop, rEqTop: rEqTop,
                   dR: rEqTop - lawTop, k: k, a: rEqTop * Math.sqrt(k), b: rEqTop / Math.sqrt(k) };
        }
        /* how far a round trunk of the law's width (area kept) on (Ax, Ay) falls short of standing clear of the piece and
           what is erased, its foot as far off as Bambu's: 0 when it fits */
        function trunkGap(sol, stopAt, coarse) {
          var cx = sol.A[0], cy = sol.A[1], top = sol.zTop, PR = probesTH(), z0 = plateZ + foot / 2, worst = 0, zl = [];
          for (var z = z0; ; z += (coarse ? 8 : 2) * TRUNK_STEP_MM) { zl.push(Math.min(z, top)); if (z >= top) break; }
          /* the heights in an order that finds a trunk that does not fit early: the top (under the part), the foot, then the halves
             between (a tall trunk's room is won or lost at a few heights; read bottom to top, a candidate that fails at the head cost
             the whole stem first: 33 s of the clamp's 60-tip plan) */
          var order = [zl.length - 1], seen = {};
          seen[zl.length - 1] = 1;
          if (!seen[0]) { seen[0] = 1; order.push(0); }
          for (var st = Math.max(1, Math.floor((zl.length - 1) / 2)); ; st = Math.floor(st / 2)) {
            for (var k0 = st; k0 < zl.length - 1; k0 += st) if (!seen[k0]) { seen[k0] = 1; order.push(k0); }
            if (st <= 1) break;
          }
          for (var oi = 0; oi < order.length; oi++) {
            var zz = zl[order[oi]], need = (law(zz, Hmax) + sol.dR) / cosN + (zz <= plateZ + foot + 1e-9 ? CK.trunk.footClearMm : TRUNK_KEEP_MM);
            for (var q = 0; q < PR.length; q++) {
              if (insideSigned(PR[q], [cx, cy, zz])) { worst = Math.max(worst, need + 1); }
              else {
                var hit = PR[q].nearest([cx, cy, zz], need + 0.01);
                if (hit && hit.dist < need) worst = Math.max(worst, need - hit.dist);
              }
              if (stopAt && worst > 0) return worst;
            }
          }
          if (!PR.length && probe.leg([cx, cy, top], [cx, cy, plateZ], (law(plateZ + CK.trunk.flareMm, Hmax) + sol.dR) * Math.SQRT2, 0, 0) >= 0) worst = 1;
          return worst;
        }
        /* the centre of the circle, else the nearest point of it where the trunk fits */
        var cands = [[zone.x, zone.y]];
        for (var rr = CK.searchStepMm; rr < zone.r - 1e-6; rr += CK.searchStepMm) {
          for (var hh = 0; hh < RELAND_HEADINGS; hh++) { var th2 = 2 * Math.PI * hh / RELAND_HEADINGS; cands.push([zone.x + rr * Math.cos(th2), zone.y + rr * Math.sin(th2)]); }
        }
        for (var h3 = 0; h3 < RELAND_HEADINGS; h3++) { var th3 = 2 * Math.PI * h3 / RELAND_HEADINGS; cands.push([zone.x + (zone.r - 1e-6) * Math.cos(th3), zone.y + (zone.r - 1e-6) * Math.sin(th3)]); }
        var sol = null, tried = 0, given = opts._axes && opts._axes[zi];
        if (given) { sol = solve(given[0], given[1]); tried = 1; }
        for (i = 0; i < cands.length && !sol; i++) {
          beat();
          var s1 = solve(cands[i][0], cands[i][1]);
          tried++;
          if (trunkGap(s1, true) === 0) { sol = s1; break; }
        }
        var tight = !sol;
        if (!sol) {
          /* it fits nowhere in the circle: the trunk is built all the same, where it falls shortest of room (the centre on a tie) */
          var bestGap = Infinity;
          cands.forEach(function (c0, k0) {
            /* nowhere fits, so where it falls shortest is a search over every point of the circle at every height: 33 s for the clamp's nine
               trunks. Every third point, every 2 mm of height (coarse), finds the same place to within the circle's own step. */
            if (k0 % 3) return;
            var s2 = solve(c0[0], c0[1]), gp = trunkGap(s2, false, true);
            if (gp < bestGap - 1e-9) { bestGap = gp; sol = s2; }
          });
        }
        sol = solve(sol.A[0], sol.A[1], true);

        /* the branches against the piece (and what is erased): a branch through it takes one bend round it */
        var edges = [];
        nodes.forEach(function (n) {
          if (n.root) return;
          var par = nodes[n.parent], t = n.leaf ? list[n.tips[0]] : null;
          var from = sol.P[n.id], to = par.root ? sol.S[n.id] : sol.P[par.id];
          var rB = sol.rBot[n.id];
          edges.push({ n: n, from: from, to: to, mid: null, side: n.leaf ? s0 : rB * Math.SQRT2, capA: n.leaf ? s0 : 0, tip: t });
        });
        edges.forEach(function (e) {
          if (probe.leg(e.from, e.to, e.side, e.capA, 0) < 0) return;
          var mid = [(e.from[0] + e.to[0]) / 2, (e.from[1] + e.to[1]) / 2, (e.from[2] + e.to[2]) / 2], W = null, span = e.from[2] - e.to[2];
          /* one bend: out from the middle of the branch, up to 16 mm, at a few heights between its ends, 32 ways round */
          for (var ring = 1; ring <= 16 && !W; ring = ring < 4 ? ring + 1 : ring < 8 ? ring + 2 : ring + 4) {
            for (var fz = 0; fz < 3 && !W; fz++) {
              for (var h4 = 0; h4 < 2 * STEER_HEADINGS && !W; h4++) {
                beat();
                var tt = 2 * Math.PI * h4 / (2 * STEER_HEADINGS), cand = [mid[0] + ring * Math.cos(tt), mid[1] + ring * Math.sin(tt), mid[2] + [0, 0.25, -0.25][fz] * span];
                if (cand[2] >= e.from[2] - 0.5 || cand[2] <= e.to[2] + 0.5) continue;
                if (probe.leg(e.from, cand, e.side, e.capA, 0) < 0 && probe.leg(cand, e.to, e.side, 0, 0) < 0) W = cand;
              }
            }
          }
          /* none: the branch would go through the piece. Never built that way and never hidden - the plan lists it (plan.blocked) */
          if (W) e.mid = W; else { e.blocked = true; out.blocked.push({ crown: ci, node: e.n.id, from: e.from.slice(), to: e.to.slice() }); }
        });

        /* ---- the members ---- */
        var mOf = {}, kidsOf = {};
        function pathOf(e) {
          var pts = [];
          if (e.tip) {
            pts.push(e.tip.p.slice()); if (e.tip.side) pts.push(e.tip.attach.slice());
            /* a tip stands straight for its cap's rise before it leans to its join: legs that lean from the contact cross the
               cap's height closer than their tips stand, and no cap fits (the pickup's vertical last run, TIP_RISE_SIDES) */
            var rise = Math.min(CK.tipRiseMm, e.from[2] - e.to[2] - 0.5), pa = e.tip.attach;
            if (rise > 0.25 && hdist(pa, e.to) > 1e-6) pts.push([pa[0], pa[1], pa[2] - rise]);
          } else pts.push(e.from.slice());
          if (e.mid) pts.push(e.mid.slice());
          pts.push(e.to.slice());
          return pts;
        }
        var beaconsOfNode = function (n) { return n.tips.map(function (ti) { return list[ti].b.id; }).sort(function (x, y) { return x - y; }); };
        var edgeOf = {};
        edges.forEach(function (e) { edgeOf[e.n.id] = e; });
        nodes.filter(function (n) { return n.leaf; }).forEach(function (n) {
          var e = edgeOf[n.id], t = e.tip, m = newMember(pathOf(e), 1, [t.b.id], t.side ? 'side' : 'beacon', s0);
          m.beacon = t.b.id; m.end = 'merge'; m.free = false; m.crown = ci; m.childSide = 2 * (nodes[n.parent].root ? sol.rEqTop : sol.rTop[n.parent]);
          mOf[n.id] = m.id;
        });
        nodes.filter(function (n) { return !n.leaf && !n.root; }).sort(function (a, b) { return (a.level - b.level) || (a.id - b.id); }).forEach(function (n) {
          var e = edgeOf[n.id], pts = pathOf(e), rA = sol.rTop[n.id], rZ = sol.rBot[n.id], z0 = e.from[2], z1 = e.to[2];
          var m = newMember(pts, n.tips.length, beaconsOfNode(n), 'crown', 0);
          m.radii = pts.map(function (q) { return z0 - z1 > 1e-9 ? rA + (rZ - rA) * Math.max(0, Math.min(1, (z0 - q[2]) / (z0 - z1))) : rA; });
          m.round = true; m.end = 'merge'; m.free = false; m.crown = ci; m.side = 2 * Math.max(rA, rZ);
          m.childSide = 2 * (nodes[n.parent].root ? sol.rEqTop : sol.rTop[n.parent]);
          mOf[n.id] = m.id;
        });
        var rm = newMember([[sol.A[0], sol.A[1], sol.zTop], [sol.A[0], sol.A[1], plateZ]], n0, beaconsOfNode(root), 'crown', 0);
        rm.round = true; rm.end = 'plate'; rm.free = false; rm.crown = ci; rm.side = 2 * sol.a;
        rm.oval = { ux: uAx[0], uy: uAx[1], ang: spreadAng, k: sol.k, dR: sol.dR, law: CK.trunk };
        mOf[root.id] = rm.id;
        edges.forEach(function (e) { if (e.blocked) { M[mOf[e.n.id]].blocked = true; out.blocked.forEach(function (b) { if (b.crown === ci && b.node === e.n.id) b.tips = e.n.tips.map(function (ti) { return list[ti].key; }).sort(); }); } });
        nodes.forEach(function (n) {
          if (n.leaf) return;
          var pm = M[mOf[n.id]];
          pm.parents = n.kids.map(function (c) { return mOf[c]; }).sort(function (x, y) { return x - y; });
          pm.parents.forEach(function (id) { M[id].child = pm.id; M[id].childSide = M[id].childSide || pm.side; });
        });

        /* ---- over the lean limit: built as planned, and marked; a spot on the plate to drop from it ---- */
        var overs = [];
        edges.forEach(function (e) {
          var pts = pathOf(e), start = e.tip && e.tip.side ? 1 : 0, worst = 0, topPt = null;
          for (var q = start; q + 1 < pts.length; q++) {
            var h = hdist(pts[q], pts[q + 1]), dz = pts[q][2] - pts[q + 1][2], ln = dz > 1e-9 ? Math.atan2(h, dz) * 180 / Math.PI : 90;
            if (ln > worst) { worst = ln; topPt = pts[q]; }
          }
          if (worst > tiltDeg + 1e-6) overs.push({ node: e.n, mid: mOf[e.n.id], leanDeg: worst, top: pts[0] });   /* a drop from the member's own top */
        });
        overs.forEach(function (o) {
          var top = o.top, Hh = top[2] - plateZ, reach = leanReach(top[2]), to = [sol.A[0] - top[0], sol.A[1] - top[1]], dA = Math.hypot(to[0], to[1]);
          var d0 = Math.min(dA, reach * 0.97), base = dA > 1e-9 ? Math.atan2(to[1], to[0]) : 0, spot = null;
          for (var f = 0; f < 3 && !spot; f++) {
            var dd2 = d0 * [1, 0.75, 0.5][f];
            for (var hq = 0; hq < STEER_HEADINGS + 1 && !spot; hq++) {
              var off = hq === 0 ? 0 : (hq % 2 ? 1 : -1) * Math.ceil(hq / 2) * 2 * Math.PI / STEER_HEADINGS, ang = base + off;
              var sp = [top[0] + dd2 * Math.cos(ang), top[1] + dd2 * Math.sin(ang), plateZ];
              if (probe.leg(top, sp, s0, 0, 0) < 0) spot = sp;
            }
          }
          if (!spot) spot = [top[0] + d0 * Math.cos(base), top[1] + d0 * Math.sin(base), plateZ];
          o.spot = spot;
          o.spotLean = Hh > 1e-9 ? Math.atan2(hdist(top, spot), Hh) * 180 / Math.PI : 90;
        });
        var rec = {
          zone: zi, tips: n0, tipSide: s0, rounds: topo.rounds, shape: topo.rounds.slice().reverse().join('>'), axis: sol.A.slice(),
          offCentreMm: hdist(sol.A, [zone.x, zone.y]), tight: tight, tried: tried, zTop: sol.zTop, H: Hmax,
          rNeed: sol.rNeed, lawTop: sol.lawTop, rEqTop: sol.rEqTop,
          oval: { angDeg: spreadAng * 180 / Math.PI, k: sol.k, a: sol.a, b: sol.b, half: half, elong: elong },
          root: rm.id, detours: edges.filter(function (e) { return e.mid; }).length,
          nodes: nodes.map(function (n) {
            return { id: n.id, member: mOf[n.id], kind: n.leaf ? 'tip' : n.root ? 'root' : 'node', kids: n.kids.map(function (c) { return mOf[c]; }),
                     tips: n.tips.length, pos: n.root ? [sol.A[0], sol.A[1], sol.zTop] : sol.P[n.id].slice(), rTop: n.root ? sol.rEqTop : sol.rTop[n.id],
                     rBot: n.root ? sol.rEqTop : sol.rBot[n.id], parent: n.parent,
                     to: n.root ? [sol.A[0], sol.A[1], plateZ] : edgeOf[n.id].to.slice(), mid: !n.root && edgeOf[n.id].mid ? edgeOf[n.id].mid.slice() : null };
          }),
          overLean: overs.length
        };
        out.crowns.push(rec);
        overs.forEach(function (o) {
          out.overLean.push({ mi: o.mid, tipKeys: o.node.tips.map(function (ti) { return list[ti].key; }).sort(), leanDeg: o.leanDeg });
          out.suggested.push({ x: o.spot[0], y: o.spot[1], mi: o.mid, leanDeg: o.spotLean });
        });
      }
      var done = 0;
      mine.forEach(function (list, zi) {
        if (list.length) buildCrown(zi, list);
        done += list.length;
        next = done;
        say('planning', out.inside.length + done, nBeacons);
      });
    }

    /* ---- the descent ---- */
    var zTop = live[0].p[2];
    var crownMode = !!(F && F.mode === 'custom' && Z);
    if (crownMode) { out.feedZones = Z.map(function (z) { return { x: z.x, y: z.y, r: z.r }; }); crownPlan(); }
    var kTop = crownMode ? -1 : Math.ceil((zTop - plateZ) / g - 1e-9);
    for (var k = kTop; k >= 0; k--) {
      var zk = plateZ + k * g;

      /* 1. beacons above this level start (or are picked up) */
      while (next < live.length && live[next].p[2] > zk + 1e-9) {
        var b = live[next++];
        var sideBeacon = b.n[2] > -cosT + LEAN_TOL;
        if (!sideBeacon && reach > 0) {
          var pick = null;
          M.forEach(function (m) {
            if (!m.free || m.dead) return;
            var a = anchor(m), h = hdist(a, b.p);
            if (!(h <= reach) || !(a[2] > b.p[2] + 1e-6)) return;
            var Q = [a[0], a[1], b.p[2] - TIP_RISE_SIDES * s0 - h / tanT];
            if (!(Q[2] > plateZ + g) || !(Q[2] < a[2])) return;
            if (pick && (h > pick.h || (h === pick.h && m.id > pick.m.id))) return;
            pick = { m: m, h: h, Q: Q };
          });
          /* The stub leans from Q to a point straight under the beacon and
             rises the last TIP_RISE_SIDES vertically, so its tip meets the
             face exactly as a strut's does. */
          var V = pick && [b.p[0], b.p[1], b.p[2] - TIP_RISE_SIDES * s0];
          if (pick && Z && !zoneReach(pick.Q)) pick = null;
          if (pick && probe.leg(pick.Q, V, s0, 0, 0) < 0 && probe.leg(V, b.p, s0, 0, s0) < 0 &&
              probe.leg(anchor(pick.m), pick.Q, pick.m.side, pick.m.path.length === 1 ? pick.m.tipCap : 0, 0) < 0 &&
              dropHit(pick.Q, sideFor(s0, pick.m.count + 1), 0) < 0) {
            var pm = pick.m;
            pm.path.push(pick.Q); pm.free = false; pm.end = 'pickup';
            var ch = newMember([pick.Q], pm.count + 1, pm.beacons.concat([b.id]), 'pickup');
            ch.parents.push(pm.id); pm.child = ch.id; pm.childSide = ch.side;
            out.stubs.push({ beacon: b.id, from: pick.Q.slice(), via: V, to: b.p.slice(), side: s0, member: ch.id });
            out.pickups.push({ beacon: b.id, by: pm.id, at: pick.Q.slice(), member: ch.id });
            say('planning', out.inside.length + next, nBeacons);
            continue;
          }
        }
        var path = [b.p.slice()];
        if (sideBeacon) {
          var hz = unit([b.n[0], b.n[1], 0]) || [1, 0, 0];
          path.push(add(b.p, mul(hz, s0 + CLEAR_MM)));
        }
        var nm = newMember(path, 1, [b.id], sideBeacon ? 'side' : 'beacon', s0);
        nm.beacon = b.id;
        if (!settle(nm)) drop(nm);
        say('planning', out.inside.length + next, nBeacons);
      }

      /* 2. merges at this level */
      if (eager > 0 && k > 0) {
        var free = M.filter(function (m) { return m.free && !m.dead && anchor(m)[2] > zk + 1e-9; });
        var cand = [];
        for (var i = 0; i < free.length; i++) {
          beat();
          for (var j = i + 1; j < free.length; j++) {
            var A0 = anchor(free[i]), B0 = anchor(free[j]);
            var rA = (A0[2] - zk) * tanT * eager, rB = (B0[2] - zk) * tanT * eager, d = hdist(A0, B0);
            if (d > rA + rB) continue;
            var N = [nodeOf((A0[0] + B0[0]) / 2, g), nodeOf((A0[1] + B0[1]) / 2, g), zk];
            if (hdist(A0, N) > rA + 1e-9 || hdist(B0, N) > rB + 1e-9) continue;
            cand.push({ a: free[i], b: free[j], d: d, N: N });
          }
        }
        cand.sort(function (x, y) { return (x.d - y.d) || (x.a.id - y.a.id) || (x.b.id - y.b.id); });
        /* A NODE KEEPS ITS DISTANCE. The column a merge starts, and the legs
           that lean into it, must not touch another member: two solids that
           touch at the top and meet again at a lower merge close a loop
           through the support. A member in the way that can reach the node
           itself joins the merge (so a merge is pairwise unless something
           stands right there; never more than MAX_MERGE - a star of legs
           converging on one node crosses itself at grazing angles, measured
           as non-manifold union output on a 40 deg face); one that cannot
           makes the merge wait a level. */
        var used = {}, born = [];
        cand.forEach(function (c) {
          beat();
          if (used[c.a.id] || used[c.b.id]) return;
          var group = [c.a, c.b], ok = true;
          for (var round = 0; round < 4 && ok; round++) {
            var count = group.reduce(function (n, m) { return n + m.count; }, 0), sc = sideFor(s0, count), grew = false;
            for (var bi = 0; bi < born.length; bi++) if (hdist(born[bi], c.N) < touch(sc, born[bi].side)) ok = false;
            for (var fi = 0; fi < free.length && ok; fi++) {
              var o = free[fi];
              if (used[o.id] || group.indexOf(o) >= 0) continue;
              var oa = anchor(o), near = hdist(oa, c.N) < touch(sc, o.side);
              for (var gi = 0; gi < group.length && !near; gi++) near = legNear(anchor(group[gi]), c.N, oa) < touch(group[gi].side, o.side);
              if (!near) continue;
              if (group.length < MAX_MERGE && oa[2] > zk + 1e-9 && hdist(oa, c.N) <= (oa[2] - zk) * tanT * eager + 1e-9) { group.push(o); grew = true; }
              else if (!crowd) ok = false;
            }
            if (!grew) break;
          }
          if (!ok) return;
          count = group.reduce(function (n, m) { return n + m.count; }, 0); sc = sideFor(s0, count);
          if (Z && !zoneReach(c.N)) return;
          if (dropHit(c.N, sc, 0) >= 0) return;
          for (var li = 0; li < group.length; li++) {
            var gm = group[li];
            if (probe.leg(anchor(gm), c.N, gm.side, gm.path.length === 1 ? gm.tipCap : 0, 0) >= 0) return;
          }
          group.forEach(function (m) { used[m.id] = true; });
          var from = group.map(function (m) { return anchor(m).slice(); });
          var mm = newMember([c.N.slice()], count, [].concat.apply([], group.map(function (m) { return m.beacons; })), 'merge');
          group.forEach(function (p) { p.path.push(c.N.slice()); p.free = false; p.end = 'merge'; p.child = mm.id; p.childSide = mm.side; mm.parents.push(p.id); });
          born.push({ 0: c.N[0], 1: c.N[1], side: mm.side });
          out.merges.push({ z: zk, node: c.N.slice(), members: group.map(function (m) { return m.id; }), count: count, member: mm.id, from: from });
        });
      }

      /* 3. the plate */
      if (k === 0) {
        M.forEach(function (m) {
          if (!m.free || m.dead) return;
          landAt0(m);
        });
      }
      say('planning', out.inside.length + next, nBeacons);
    }
    say('planning', out.inside.length + next, nBeacons, true);
    /* ---- trunks ---- */
    var trunks = [];
    M.forEach(function (m) {
      if (m.dead || (m.end !== 'plate' && m.end !== 'rest')) return;
      var tr = { root: m.id, landing: m.end, members: [], beacons: m.beacons.slice() };
      if (m.crown != null) tr.crown = m.crown;
      var q = [m.id];
      while (q.length) {
        var id = q.shift();
        tr.members.push(id);
        M[id].parents.slice().sort(function (x, y) { return x - y; }).forEach(function (p) { q.push(p); });
      }
      trunks.push(tr);
    });
    out.trunks = trunks;
    trunks.forEach(function (t, ti) { if (t.crown != null) out.crowns[t.crown].trunk = ti; });
    /* Every trunk says which regions its beacons came from: the lookup a
       caller removes "this region's supports" by. */
    trunks.forEach(function (t) { t.regionIds = regionIdsOf(bc.beacons, t.beacons); });
    trunks.forEach(function (t) {
      if (t.landing === 'rest') t.beacons.forEach(function (id) { out.resting.push(id); });
      out.held += t.beacons.length;
    });
    out.toPlate = trunks.filter(function (t) { return t.landing === 'plate'; }).length;
    if (Z) {
      out.zones = Z.map(function (z) { return { x: z.x, y: z.y, r: z.r, trunks: [] }; });
      trunks.forEach(function (t, ti) {
        if (t.landing !== 'plate') return;
        var m = M[t.root], e = m.path[m.path.length - 1], zi = zoneOf(e);
        t.zone = zi;
        if (zi >= 0) out.zones[zi].trunks.push(ti);
      });
      out.zonesEmpty = [];
      out.zones.forEach(function (z, zi) { if (!z.trunks.length) out.zonesEmpty.push(zi); });
    }

    /* Interface stations, in nso_support_interface.finish's shape. */
    out.stations = [];
    M.forEach(function (m) {
      if (m.dead || m.beacon == null) return;
      var b = bc.beacons[m.beacon], tip = m.path[0];       /* the tip, after any move off a wall */
      var below = m.path.length > 1 ? m.path[1] : [tip[0], tip[1], tip[2] - 5];
      out.stations.push({ label: 'point ' + b.id, beacon: b.id, contact: tip.slice(), from: below.slice(), to: tip.slice(), side: m.kind === 'side' });
    });
    out.stubs.forEach(function (s) {
      out.stations.push({ label: 'point ' + s.beacon, beacon: s.beacon, contact: s.to.slice(), from: s.via.slice(), to: s.to.slice() });
    });

    out.ok = true;
    out.stage = 'done';
    out.reason = describeCounts(out, bc.beacons.length);
    return out;
  }

  function describeCounts(p, total) {
    var parts = [];
    var held = p.held;
    var line = 'Holds ' + held + ' of ' + total + ' support point' + (total === 1 ? '' : 's');
    if (p.toPlate) line += ' on ' + p.toPlate + (p.toPlate === 1 ? ' trunk' : ' trunks') + ' to the plate';
    if (p.resting.length) parts.push(p.resting.length + ' resting on the part');
    if (p.unreachable.length) parts.push(p.unreachable.length + ' unreachable from the plate' +
      (p.offZone && p.offZone.length ? ' (' + p.offZone.length + ' in reach of no landing zone)' : ''));
    if (p.inside.length) parts.push(p.inside.length + ' inside the piece, left out');
    return line + (parts.length ? '; ' + parts.join(', ') : '') + '.';
  }

  /* =====================================================================
     THE SOLIDS
     ===================================================================== */
  /* PHASE. Every part's square is turned about its own axis by a phase of
     its own - the golden angle times its index, mod 90 deg - so no two parts
     ever put a wall in one plane. Measured without it: a pickup stub leaving
     its column in the same row lay with two walls in the column's own wall
     planes, and the union came back non-manifold (4 edges, 3 parts from 2)
     at a 3 mm strut. Coplanar overlapping walls are the one input the
     boolean cannot be trusted with; distinct phases remove the case. */
  var GOLDEN_DEG = 137.50776405003785;
  function phaseOf(i) { return ((i * GOLDEN_DEG) % 90) * Math.PI / 180; }
  function squareProfile(side, phase) {
    var R = side / Math.SQRT2, out = [];
    for (var k = 0; k < 4; k++) {
      var a = (phase || 0) + Math.PI / 4 + k * Math.PI / 2;
      out.push([R * Math.cos(a), R * Math.sin(a)]);
    }
    return out;
  }

  function roundProfile(r, n, phase) {
    var out = [];
    for (var k = 0; k < n; k++) { var a = (phase || 0) + 2 * Math.PI * k / n; out.push([r * Math.cos(a), r * Math.sin(a)]); }
    return out;
  }

  function cleanPath(pts) {
    var out = [];
    pts.forEach(function (p) { if (!out.length || len(sub(p, out[out.length - 1])) > 1e-6) out.push(p.slice()); });
    for (var i = 1; i + 1 < out.length; i++) {
      var u = unit(sub(out[i], out[i - 1])), v = unit(sub(out[i + 1], out[i]));
      if (u && v && dot(u, v) > 1 - 1e-12) { out.splice(i, 1); i--; }
    }
    return out;
  }

  /* One member, one sweep: its whole polyline, mitred at every bend. A member
     formed at a node or a pickup starts half its side above that point. */
  function memberSolid(P, m, foot, path, seed) {
    var pts = (path || m.path).slice();
    /* A trunk that lands on a foot pad ends half a first layer inside it, so
       its end cap is not coplanar with the pad's bottom (the boolean's one
       untrustworthy input) and the pad, not the cap, is what sits on the plate. */
    if (foot && m.end === 'plate') {
      /* ...and lands upright. A last leg that leans would put its cap's low
         corner under the plate: it stops FOOT_RUN_MM short and drops the rest
         straight (at most half the leg, so a short leg still has a lean). */
      var nP = pts.length, la = pts[Math.max(0, nP - 2)], lb = pts[nP - 1], drop = la[2] - lb[2];
      if (nP >= 2 && Math.hypot(lb[0] - la[0], lb[1] - la[1]) > 1e-6 && drop > 1e-6) {
        var rise = Math.min(FOOT_RUN_MM, drop / 2), fr = 1 - rise / drop;
        var E = [la[0] + (lb[0] - la[0]) * fr, la[1] + (lb[1] - la[1]) * fr, lb[2] + rise];
        pts[nP - 1] = E;
        pts.push([E[0], E[1], lb[2]]);
      }
      var lastP = pts[pts.length - 1].slice();
      lastP[2] += foot / 2;
      pts[pts.length - 1] = lastP;
    }
    if (m.kind === 'merge' || m.kind === 'pickup') pts.unshift(add(pts[0], [0, 0, m.side / 2]));
    pts = cleanPath(pts);
    /* A member that ends in a junction runs on past it along its own last
       leg by a quarter of the member it joins. Two legs ending exactly AT
       the node share their caps' centre vertex, and the boolean pinches
       there - measured on the tilted box: 2 piercing pairs at one Y, the
       same float32 pinch docs/SUPPORT-TREE.md section 5 measured at shared
       branch roots. Run on, each end is its own point inside the column. */
    if (m.end === 'merge' || m.end === 'pickup') {
      var nL = pts.length, lastU = unit(sub(pts[nL - 1], pts[nL - 2]));
      pts[nL - 1] = add(pts[nL - 1], mul(lastU, m.childSide / 4));
    }
    var first = unit(sub(pts[1], pts[0])), up = seed || (Math.abs(first[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]);
    if (m.crownRound > 0 && pts.length >= 2) {
      /* A CROWN'S TIP is a round post, and only its stub: the vertical rise under the cap, down to where the leg leans. The leg from
         there to its join is the crown's smooth body (blobSoup), flowing into the post and into the join with no joint between. */
      var stub = pts.length > 2 ? pts.slice(0, 2) : pts, rs = P.sweep({ points: stub, profile: roundProfile(m.crownRound, CROWN_STUB_SIDES, phaseOf(m.id + 1)), up: up });
      if (!rs.ok) return { ok: false, reason: 'member ' + m.id + ' would not sweep: ' + rs.reason };
      return { ok: true, soups: [rs.tris], points: pts, legPts: pts.length > 2 ? pts.slice(1) : null, round: true };
    }
    var sw = P.sweep({ points: pts, profile: squareProfile(m.side, phaseOf(m.id + 1)), up: up });
    if (sw.ok) return { ok: true, soups: [sw.tris], points: pts };
    /* A mitre the sweep refuses (a leg shorter than the corner needs - a
       side point's stub a millimetre above the plate): the member's legs as
       separate straight sweeps. Each runs on past its END joint by three
       quarters of a side and starts AT its start joint, so neighbours
       overlap without two run-on ends meeting, and each leg takes its own
       phase so no two put a wall in one plane. */
    var soups = [];
    for (var i = 0; i + 1 < pts.length; i++) {
      var a = pts[i], b = pts[i + 1], u = unit(sub(b, a));
      var b2 = i + 2 < pts.length ? add(b, mul(u, 0.75 * m.side)) : b;
      var upl = Math.abs(u[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      var s2 = P.sweep({ points: [a, b2], profile: squareProfile(m.side, phaseOf(m.id + 1 + 7 * i)), up: upl });
      if (!s2.ok) return { ok: false, reason: 'member ' + m.id + ' would not sweep: ' + s2.reason };
      soups.push(s2.tris);
    }
    return { ok: true, soups: soups, points: pts, split: true };
  }

  /* A cap under the sheet: a round frustum (n sides) from radius r0 round
     (bx, by) at z0 up to r1 round (cx, cy) at z1 - oblique when it follows a
     leaning leg - outward-wound, its corners turned by `phase`. With `band`,
     its top `band` stands upright at r1 (sheet()'s THE CAPS: the sheet's
     underside cuts that band, not the long flank). */
  function frustumSoup(bx, by, cx, cy, z0, z1, r0, r1, n, phase, band) {
    var bd = band > 0 && band < z1 - z0 ? band : 0, zm = z1 - bd, f = (zm - z0) / (z1 - z0);
    var mx = bx + (cx - bx) * f, my = by + (cy - by) * f;
    var out = new Float32Array(n * (bd ? 6 : 4) * 9), w = 0;
    function tri(a, b, c) {
      out[w++] = a[0]; out[w++] = a[1]; out[w++] = a[2];
      out[w++] = b[0]; out[w++] = b[1]; out[w++] = b[2];
      out[w++] = c[0]; out[w++] = c[1]; out[w++] = c[2];
    }
    for (var k = 0; k < n; k++) {
      var a0 = phase + 2 * Math.PI * k / n, a1 = phase + 2 * Math.PI * (k + 1) / n;
      var p0 = [bx + r0 * Math.cos(a0), by + r0 * Math.sin(a0), z0], p1 = [bx + r0 * Math.cos(a1), by + r0 * Math.sin(a1), z0];
      var q0 = [cx + r1 * Math.cos(a0), cy + r1 * Math.sin(a0), z1], q1 = [cx + r1 * Math.cos(a1), cy + r1 * Math.sin(a1), z1];
      tri([cx, cy, z1], q0, q1);
      tri([bx, by, z0], p1, p0);
      if (bd) {
        var m0 = [mx + r1 * Math.cos(a0), my + r1 * Math.sin(a0), zm], m1 = [mx + r1 * Math.cos(a1), my + r1 * Math.sin(a1), zm];
        tri(p0, p1, m1);
        tri(p0, m1, m0);
        tri(m0, m1, q1);
        tri(m0, q1, q0);
      } else {
        tri(p0, p1, q1);
        tri(p0, q1, q0);
      }
    }
    return out;
  }

  /* A trunk's footprint on the plate: the circle round its end square (side
     s, radius s / root 2) - whatever way the sweep turned the square, which a
     cut at the tip can change - so a pad depends only on where the trunk
     lands and how thick it is. */
  function footprintOf(c, side) { return { c: [c[0], c[1]], r: side * Math.SQRT1_2 }; }

  /* =====================================================================
     TRUNKS (supports-foot; docs/SUPPORT-GRIDPACK.md, *The trunk*)

     The round-2 print of simple_overhang failed at the floor: a 37 mm tree
     on a 2.4 mm column and a small round pad peeled off the plate when the
     nozzle caught the stair; the tree itself held. Bambu's tree slim on the
     same part stands on a trunk 12 mm across at the floor. So a trunk that
     lands on the plate (the card's build: opts.interface) gets a round solid
     of its own round its foot's axis, kept beside its column as one more
     shell - nothing the planner built changes:

       r(z) = TRUNK_TIP_MM / 2 + tan(TRUNK_ANGLE_DEG) x (H - z)
              + tan(FLARE_ANGLE_DEG) x (FLARE_MM - z), below FLARE_MM

     its inscribed radius at height z over the plate. H is the top of what
     the trunk holds up: the highest of its tips, or of the sheet or stair it
     carries (all of a stair's trunks are as tall as the stair). Bambu's own
     law is the same with 5 deg and no H but its tips. The tip diameter and the
     angle are the feed's knobs when it gives them (THE KNOBS): the foot's
     record carries the law (grow.law), and growTrunks, the landing (reland)
     and shareFeet all read it from there. The trunk rises from
     the pad up its STEM - the landing member, then at each merge the parent
     holding most of its tips - while the stem holds at least TRUNK_SHARE of
     them: where the tree splits, the trunk ends. A taproot (a strut never
     merged) is its own stem. It ends TRUNK_TIP_CLEAR_MM under every tip
     within TRUNK_TIP_REACH_MM of it (any tree's, any area's: under every
     cap, sheet, stair and gap), and keeps TRUNK_KEEP_MM off the piece, read
     with the nearest-face probe every TRUNK_STEP_MM up its axis: where the
     piece is nearer, the trunk is narrower there, and it ends where it would
     be narrower than its own column.

     The trunk's pad is drawn round its flared base (footprint r = the base's
     outer radius), grown FOOT_GROW_MM as before: pads grow with the trunk.
     ===================================================================== */
  /* rings: [z, R] (a circle) or [z, Rl, Rs] (an ellipse: long semi-axis Rl along `ang`, short semi-axis Rs) */
  function revolveSoup(cx, cy, rings, n, phase, ang) {
    var nr = rings.length, out = new Float32Array((2 * n + 2 * n * (nr - 1)) * 9), w = 0, V = [];
    var ca = Math.cos(ang || 0), sa = Math.sin(ang || 0);
    for (var k = 0; k < nr; k++) {
      var row = [], Rl = rings[k][1], Rs = rings[k].length > 2 ? rings[k][2] : Rl;
      for (var j = 0; j <= n; j++) {
        var a = phase + 2 * Math.PI * (j % n) / n, ex = Rl * Math.cos(a), ey = Rs * Math.sin(a);
        row.push([cx + ex * ca - ey * sa, cy + ex * sa + ey * ca, rings[k][0]]);
      }
      V.push(row);
    }
    function tri(a, b, c) {
      out[w++] = a[0]; out[w++] = a[1]; out[w++] = a[2];
      out[w++] = b[0]; out[w++] = b[1]; out[w++] = b[2];
      out[w++] = c[0]; out[w++] = c[1]; out[w++] = c[2];
    }
    var lo = [cx, cy, rings[0][0]], hi = [cx, cy, rings[nr - 1][0]];
    for (var q = 0; q < n; q++) {
      tri(lo, V[0][q + 1], V[0][q]);
      tri(hi, V[nr - 1][q], V[nr - 1][q + 1]);
      for (var m = 0; m + 1 < nr; m++) {
        tri(V[m][q], V[m][q + 1], V[m + 1][q + 1]);
        tri(V[m][q], V[m + 1][q + 1], V[m + 1][q]);
      }
    }
    return out;
  }
  /* A branch of the crown (CROWNS): a round tube from a (radius ra) to b (rb), n sides, its end faces flat and square to
     its axis, outward-wound. A ball for a join: a UV sphere, n round and n / 2 bands, outward-wound. Both closed. */
  function tubeSoup(a, ra, b, rb, n, phase) {
    var d = unit(sub(b, a));
    if (!d) return new Float32Array(0);
    var u = unit(cross(d, Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])), v = cross(d, u);
    var out = new Float32Array(n * 4 * 9), w = 0;
    function put(p) { out[w++] = p[0]; out[w++] = p[1]; out[w++] = p[2]; }
    function tri(p, q, r) { put(p); put(q); put(r); }
    function at(c, r, ang) { return [c[0] + r * (u[0] * Math.cos(ang) + v[0] * Math.sin(ang)), c[1] + r * (u[1] * Math.cos(ang) + v[1] * Math.sin(ang)), c[2] + r * (u[2] * Math.cos(ang) + v[2] * Math.sin(ang))]; }
    for (var k = 0; k < n; k++) {
      var a0 = phase + 2 * Math.PI * k / n, a1 = phase + 2 * Math.PI * (k + 1) / n;
      var p0 = at(a, ra, a0), p1 = at(a, ra, a1), q0 = at(b, rb, a0), q1 = at(b, rb, a1);
      tri(b, q0, q1);
      tri(a, p1, p0);
      tri(p0, p1, q1);
      tri(p0, q1, q0);
    }
    return out;
  }
  function ballSoup(c, r, n, phase) {
    var bands = Math.max(2, n >> 1), out = new Float32Array((2 * n * (bands - 1)) * 9), w = 0, V = [];
    for (var i = 0; i <= bands; i++) {
      var th = Math.PI * i / bands, row = [];
      for (var j = 0; j <= n; j++) {
        var ph = phase + 2 * Math.PI * (j % n) / n;
        row.push(i === 0 ? [c[0], c[1], c[2] + r] : i === bands ? [c[0], c[1], c[2] - r]
          : [c[0] + r * Math.sin(th) * Math.cos(ph), c[1] + r * Math.sin(th) * Math.sin(ph), c[2] + r * Math.cos(th)]);
      }
      V.push(row);
    }
    function tri(p, q, s) {
      out[w++] = p[0]; out[w++] = p[1]; out[w++] = p[2]; out[w++] = q[0]; out[w++] = q[1]; out[w++] = q[2]; out[w++] = s[0]; out[w++] = s[1]; out[w++] = s[2];
    }
    for (var ii = 0; ii < bands; ii++) {
      for (var jj = 0; jj < n; jj++) {
        if (ii > 0) tri(V[ii][jj], V[ii + 1][jj], V[ii][jj + 1]);
        if (ii < bands - 1) tri(V[ii + 1][jj], V[ii + 1][jj + 1], V[ii][jj + 1]);
      }
    }
    return out.subarray(0, w);
  }

  /* THE SMOOTH BODY OF A CROWN. Its branches are round and run into one another and into the trunk the way a bent tube does: no ball at a join, no
     seam. The tree is a set of tapered capsules - each tube, each tip's leg from where it leans, the top of the trunk - and the surface is
     the smooth union of their distance fields: d = -k ln(sum exp(-d_i / k)) over the paths that come within reach (one path is its own hard minimum over
     its segments, so a bend is not a bead), meshed on a grid of `h` mm by SURFACE NETS (a vertex in each cell the surface crosses, the average of its
     edge crossings; a quad over each edge that changes sign), every vertex then walked onto the surface along the field's gradient. Closed and outward-wound.
     prims: [{ pts: [[x, y, z]...], r: [radius at each point], clip: { p, n } (optional: cut flat at the plane through p, nothing on the side n points to) }]; k: the blend, mm. Float32Array soup, empty if there is nothing. */
  function blobSoup(prims, k, h, cut) {
    /* cut: { zMax, zMin (the plate: no body stands under it), away: function (x, y, z) -> the distance to what the body keeps off, keep } - the body is cut flat at zMax and carved back from `away` by `keep` */
    if (!prims.length) return new Float32Array(0);
    /* the cell is no finer than the body's size allows: its surface, as the capsules' (a path's length x its girth, its ends), at 2 triangles a cell, is held to
       CROWN_BLOB_TRIS - a crown of 25 paths over 40 mm is 150 k triangles at 0.2 mm and a quarter of that at 0.35, and as smooth to the eye */
    var area = 0;
    prims.forEach(function (pr) {
      for (var q = 0; q + 1 < pr.pts.length; q++) area += len(sub(pr.pts[q + 1], pr.pts[q])) * Math.PI * (pr.r[q] + pr.r[q + 1]);
      area += 4 * Math.PI * pr.r[0] * pr.r[0];
    });
    h = Math.max(h, Math.sqrt(2 * area / CROWN_BLOB_TRIS));
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], reach = 7 * k;
    prims.forEach(function (pr) {
      pr.box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      pr.pts.forEach(function (q, i) {
        for (var d = 0; d < 3; d++) {
          pr.box[d] = Math.min(pr.box[d], q[d] - pr.r[i] - reach); pr.box[3 + d] = Math.max(pr.box[3 + d], q[d] + pr.r[i] + reach);
          lo[d] = Math.min(lo[d], q[d] - pr.r[i] - 2 * h); hi[d] = Math.max(hi[d], q[d] + pr.r[i] + 2 * h);
        }
      });
    });
    var nx = Math.ceil((hi[0] - lo[0]) / h) + 1, ny = Math.ceil((hi[1] - lo[1]) / h) + 1, nz = Math.ceil((hi[2] - lo[2]) / h) + 1;
    if (nx * ny * nz > 12e6) return new Float32Array(0);
    function segD(px, py, pz, a, ra, b, rb) {
      var ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2], ee = ex * ex + ey * ey + ez * ez;
      var t = ee > 1e-18 ? ((px - a[0]) * ex + (py - a[1]) * ey + (pz - a[2]) * ez) / ee : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      var dx = px - a[0] - ex * t, dy = py - a[1] - ey * t, dz = pz - a[2] - ez * t;
      return Math.sqrt(dx * dx + dy * dy + dz * dz) - (ra + (rb - ra) * t);
    }
    /* the field at a point from the paths in `cand` (every path whose box holds it, when not given) */
    function base(px, py, pz, cand) {
      var sum = 0, n = cand ? cand.length : prims.length;
      for (var ii = 0; ii < n; ii++) {
        var pr = cand ? cand[ii] : prims[ii], bx = pr.box;
        if (!cand && (px < bx[0] || py < bx[1] || pz < bx[2] || px > bx[3] || py > bx[4] || pz > bx[5])) continue;
        var d = Infinity;
        for (var s = 0; s + 1 < pr.pts.length; s++) { var q = segD(px, py, pz, pr.pts[s], pr.r[s], pr.pts[s + 1], pr.r[s + 1]); if (q < d) d = q; }
        if (pr.pts.length === 1) d = segD(px, py, pz, pr.pts[0], pr.r[0], pr.pts[0], pr.r[0]);
        if (pr.clip) { var cd = (px - pr.clip.p[0]) * pr.clip.n[0] + (py - pr.clip.p[1]) * pr.clip.n[1] + (pz - pr.clip.p[2]) * pr.clip.n[2]; if (cd > d) d = cd; }
        sum += Math.exp(-d / k);
      }
      return sum > 0 ? -k * Math.log(sum) : 1e3;
    }
    /* ...and the cut: flat at zMax, carved back from what the body keeps off (`away`, only asked where the surface is near) */
    function carve(f, px, py, pz, useAway) {
      if (!cut || f >= 1) return f;
      if (cut.zMax != null && pz - cut.zMax > f) f = pz - cut.zMax;
      if (cut.zMin != null && cut.zMin - pz > f) f = cut.zMin - pz;
      if (useAway && cut.away && f < 0.6) { var da = cut.away(px, py, pz); if (cut.keep - da > f) f = cut.keep - da; }
      return f;
    }
    /* the paths and the part's nearness, bucketed in 2 mm cubes: a node asks its own bucket only */
    var BK = 2, bnx = Math.ceil((hi[0] - lo[0]) / BK) + 1, bny = Math.ceil((hi[1] - lo[1]) / BK) + 1, bnz = Math.ceil((hi[2] - lo[2]) / BK) + 1, buckets = new Array(bnx * bny * bnz), bNear = new Uint8Array(bnx * bny * bnz);
    prims.forEach(function (pr) {
      var i0 = Math.max(0, Math.floor((pr.box[0] - lo[0]) / BK)), i1 = Math.min(bnx - 1, Math.floor((pr.box[3] - lo[0]) / BK));
      var j0 = Math.max(0, Math.floor((pr.box[1] - lo[1]) / BK)), j1 = Math.min(bny - 1, Math.floor((pr.box[4] - lo[1]) / BK));
      var k0 = Math.max(0, Math.floor((pr.box[2] - lo[2]) / BK)), k1 = Math.min(bnz - 1, Math.floor((pr.box[5] - lo[2]) / BK));
      for (var bk = k0; bk <= k1; bk++) for (var bj = j0; bj <= j1; bj++) for (var bi = i0; bi <= i1; bi++) { var bq = (bk * bny + bj) * bnx + bi; (buckets[bq] || (buckets[bq] = [])).push(pr); }
    });
    for (var bq2 = 0; bq2 < buckets.length; bq2++) {
      if (!buckets[bq2]) continue;
      if (!(cut && cut.away)) continue;
      var bi2 = bq2 % bnx, bj2 = ((bq2 / bnx) | 0) % bny, bk2 = (bq2 / (bnx * bny)) | 0;
      bNear[bq2] = cut.away(lo[0] + (bi2 + 0.5) * BK, lo[1] + (bj2 + 0.5) * BK, lo[2] + (bk2 + 0.5) * BK) < cut.keep + BK * 0.87 + 0.3 ? 1 : 0;
    }
    function field(px, py, pz) {
      var bq = (Math.floor((pz - lo[2]) / BK) * bny + Math.floor((py - lo[1]) / BK)) * bnx + Math.floor((px - lo[0]) / BK), cand = buckets[bq];
      return cand ? carve(base(px, py, pz, cand), px, py, pz, bNear[bq] === 1) : 1e3;
    }
    /* The field is sampled where the surface can be: on a coarse grid (a block = BLK cells) first, and a block whose eight corners all lie further from the
       surface than its own diagonal (the field is 1-Lipschitz) is inside or outside throughout and is not sampled - only the blocks the surface crosses are. */
    var BLK = 4, cnx = Math.ceil((nx - 1) / BLK) + 1, cny = Math.ceil((ny - 1) / BLK) + 1, cnz = Math.ceil((nz - 1) / BLK) + 1;
    var CF = new Float32Array(cnx * cny * cnz), i, j, l, ci, cj, cl;
    for (cl = 0; cl < cnz; cl++) for (cj = 0; cj < cny; cj++) for (ci = 0; ci < cnx; ci++)
      CF[(cl * cny + cj) * cnx + ci] = field(lo[0] + Math.min(ci * BLK, nx - 1) * h, lo[1] + Math.min(cj * BLK, ny - 1) * h, lo[2] + Math.min(cl * BLK, nz - 1) * h);
    var F = new Float32Array(nx * ny * nz), have = new Uint8Array(nx * ny * nz), act = new Uint8Array((cnx - 1) * (cny - 1) * (cnz - 1)), reachB = BLK * h * 0.87 + 0.05;
    function blockCorner(bi, bj, bl, q) { return CF[((bl + ((q >> 2) & 1)) * cny + bj + ((q >> 1) & 1)) * cnx + bi + (q & 1)]; }
    for (cl = 0; cl < cnz - 1; cl++) for (cj = 0; cj < cny - 1; cj++) for (ci = 0; ci < cnx - 1; ci++) {
      var mn = Infinity, pos = 0;
      for (var q0 = 0; q0 < 8; q0++) { var cfv = blockCorner(ci, cj, cl, q0); if (Math.abs(cfv) < mn) mn = Math.abs(cfv); if (cfv > 0) pos++; }
      if (mn > reachB && (pos === 0 || pos === 8)) continue;
      act[(cl * (cny - 1) + cj) * (cnx - 1) + ci] = 1;
      for (l = cl * BLK; l <= Math.min((cl + 1) * BLK, nz - 1); l++) for (j = cj * BLK; j <= Math.min((cj + 1) * BLK, ny - 1); j++) for (i = ci * BLK; i <= Math.min((ci + 1) * BLK, nx - 1); i++) {
        var ni0 = (l * ny + j) * nx + i;
        if (have[ni0]) continue;
        have[ni0] = 1; F[ni0] = field(lo[0] + i * h, lo[1] + j * h, lo[2] + l * h);
      }
    }
    for (cl = 0; cl < cnz - 1; cl++) for (cj = 0; cj < cny - 1; cj++) for (ci = 0; ci < cnx - 1; ci++) {
      if (act[(cl * (cny - 1) + cj) * (cnx - 1) + ci]) continue;
      var sgn = blockCorner(ci, cj, cl, 0) > 0 ? 1 : -1;
      for (l = cl * BLK; l <= Math.min((cl + 1) * BLK, nz - 1); l++) for (j = cj * BLK; j <= Math.min((cj + 1) * BLK, ny - 1); j++) for (i = ci * BLK; i <= Math.min((ci + 1) * BLK, nx - 1); i++) {
        var ni1 = (l * ny + j) * nx + i;
        if (!have[ni1]) { have[ni1] = 1; F[ni1] = sgn * reachB; }
      }
    }
    /* the blocks the surface crosses, as a list of their cells' ranges */
    var actList = [];
    for (cl = 0; cl < cnz - 1; cl++) for (cj = 0; cj < cny - 1; cj++) for (ci = 0; ci < cnx - 1; ci++) if (act[(cl * (cny - 1) + cj) * (cnx - 1) + ci]) actList.push([ci, cj, cl]);
    var cellV, verts, vcell, quads, CE = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    function cv(ci, cj, cl) { return cellV[(cl * (ny - 1) + cj) * (nx - 1) + ci]; }
    function walk(v, iters) {
      var bq = (Math.max(0, Math.min(bnz - 1, Math.floor((v[2] - lo[2]) / BK))) * bny + Math.max(0, Math.min(bny - 1, Math.floor((v[1] - lo[1]) / BK)))) * bnx + Math.max(0, Math.min(bnx - 1, Math.floor((v[0] - lo[0]) / BK)));
      var cand = buckets[bq] || [];    /* the paths whose reach covers this vertex's cube (a path further than its reach adds under a thousandth) */
      /* the part is asked about only where the vertex is near it (most are far) */
      var near = !!(cut && cut.away) && cut.away(v[0], v[1], v[2]) < cut.keep + 2 * h;
      function f(x, y, z) { return carve(base(x, y, z, cand), x, y, z, near); }
      for (var it = 0; it < (iters || 1); it++) {
        var f0 = f(v[0], v[1], v[2]), e = h * 0.2;
        var gx = (f(v[0] + e, v[1], v[2]) - f0) / e, gy = (f(v[0], v[1] + e, v[2]) - f0) / e, gz = (f(v[0], v[1], v[2] + e) - f0) / e;
        var gg = gx * gx + gy * gy + gz * gz;
        if (!(gg > 1e-12)) break;
        var step = f0 / gg, mv = Math.abs(f0) / Math.sqrt(gg);
        if (mv > h) step *= h / mv;
        v[0] -= step * gx; v[1] -= step * gy; v[2] -= step * gz;
      }
      return v;
    }
    /* THE TOPOLOGY, made sure of: a vertex in each cell the surface crosses, a quad round each edge that changes sign. Where two sheets of the surface pass through one
       cell (a neck thinner than the grid) the quads share an edge three or four ways - a mesh no boolean takes. The cells at such an edge are eroded (their inside
       nodes taken out) and the surface found again, until every edge has its two faces; a body that cannot be made so is none (the crown is built the old way). */
    function extract() {
      cellV = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1); verts = []; vcell = []; quads = [];
      var broken = [];
      actList.forEach(function (bk) {
        for (var l = bk[2] * BLK; l < Math.min((bk[2] + 1) * BLK, nz - 1); l++) for (var j = bk[1] * BLK; j < Math.min((bk[1] + 1) * BLK, ny - 1); j++) for (var i = bk[0] * BLK; i < Math.min((bk[0] + 1) * BLK, nx - 1); i++) {
          var c = [], neg = 0;
          for (var q = 0; q < 8; q++) { var f = F[((l + ((q >> 2) & 1)) * ny + j + ((q >> 1) & 1)) * nx + i + (q & 1)]; c.push(f); if (f < 0) neg++; }
          if (neg === 0 || neg === 8) continue;
          var sx = 0, sy = 0, sz = 0, cnt = 0;
          for (var e2 = 0; e2 < 12; e2++) {
            var a = CE[e2][0], b = CE[e2][1];
            if ((c[a] < 0) === (c[b] < 0)) continue;
            var t = c[a] / (c[a] - c[b]);
            var ax = a & 1, ay = (a >> 1) & 1, az = (a >> 2) & 1, bx2 = b & 1, by2 = (b >> 1) & 1, bz2 = (b >> 2) & 1;
            sx += ax + (bx2 - ax) * t; sy += ay + (by2 - ay) * t; sz += az + (bz2 - az) * t; cnt++;
          }
          cellV[(l * (ny - 1) + j) * (nx - 1) + i] = verts.length;
          vcell.push([i, j, l]);
          verts.push([lo[0] + (i + sx / cnt) * h, lo[1] + (j + sy / cnt) * h, lo[2] + (l + sz / cnt) * h]);
        }
      });
      var seen = new Uint8Array(nx * ny * nz);
      actList.forEach(function (bk) {
        for (var l = Math.max(1, bk[2] * BLK); l <= Math.min((bk[2] + 1) * BLK, nz - 2); l++) for (var j = Math.max(1, bk[1] * BLK); j <= Math.min((bk[1] + 1) * BLK, ny - 2); j++) for (var i = Math.max(1, bk[0] * BLK); i <= Math.min((bk[0] + 1) * BLK, nx - 2); i++) {
          var nid = (l * ny + j) * nx + i;
          if (seen[nid]) continue;
          seen[nid] = 1;
          var f0 = F[nid], in0 = f0 < 0, qs = [];
          if (i + 1 < nx && (F[nid + 1] < 0) !== in0) qs.push([cv(i, j - 1, l - 1), cv(i, j, l - 1), cv(i, j, l), cv(i, j - 1, l)]);
          if (j + 1 < ny && (F[nid + nx] < 0) !== in0) qs.push([cv(i - 1, j, l - 1), cv(i - 1, j, l), cv(i, j, l), cv(i, j, l - 1)]);
          if (l + 1 < nz && (F[nid + nx * ny] < 0) !== in0) qs.push([cv(i - 1, j - 1, l), cv(i, j - 1, l), cv(i, j, l), cv(i - 1, j, l)]);
          qs.forEach(function (qd) {
            if (qd.some(function (v) { return v < 0; })) { broken.push(qd.filter(function (v) { return v >= 0; })); return; }
            qd.push(!in0); quads.push(qd);
          });
        }
      });
      var em = new Map();
      function tick(u, v) { var kk = u < v ? u * 4294967296 + v : v * 4294967296 + u, r = em.get(kk); if (!r) em.set(kk, r = { n: 0, u: u, v: v }); r.n++; }
      quads.forEach(function (qd) { tick(qd[0], qd[1]); tick(qd[1], qd[2]); tick(qd[2], qd[0]); tick(qd[0], qd[2]); tick(qd[2], qd[3]); tick(qd[3], qd[0]); });
      /* a diagonal (0-2) is in both triangles: it counts twice by design */
      var bad = [];
      em.forEach(function (r) { var diag = false; if (r.n !== 2) bad.push([r.u, r.v]); });
      return bad.concat(broken);
    }
    var bads = null;
    for (var attempt = 0; attempt < 8; attempt++) {
      bads = extract();
      if (!bads.length) break;
      bads.forEach(function (vs) {
        vs.forEach(function (vi) {
          var cc = vcell[vi];
          for (var q = 0; q < 8; q++) {
            var ni = (cc[2] + ((q >> 2) & 1)) * ny * nx + (cc[1] + ((q >> 1) & 1)) * nx + cc[0] + (q & 1);
            if (F[ni] < 0) F[ni] = 0.002;
          }
        });
      });
    }
    if (bads.length || !verts.length) return new Float32Array(0);
    /* the surface nets' small ripple, taken out: each vertex moves halfway to the mean of its neighbouring cells' vertices, and is walked back onto the surface */
    for (var pass = 0; pass < 2; pass++) {
      var nv = verts.map(function (v) { return v.slice(); });
      for (var vi = 0; vi < verts.length; vi++) {
        var cc = vcell[vi], ci2 = cc[0], cj2 = cc[1], cl2 = cc[2];
        if (ci2 < 1 || cj2 < 1 || cl2 < 1 || ci2 > nx - 3 || cj2 > ny - 3 || cl2 > nz - 3) continue;
        var ax = 0, ay = 0, az = 0, na = 0, nb = [cv(ci2 - 1, cj2, cl2), cv(ci2 + 1, cj2, cl2), cv(ci2, cj2 - 1, cl2), cv(ci2, cj2 + 1, cl2), cv(ci2, cj2, cl2 - 1), cv(ci2, cj2, cl2 + 1)];
        for (var b2 = 0; b2 < 6; b2++) if (nb[b2] >= 0) { ax += verts[nb[b2]][0]; ay += verts[nb[b2]][1]; az += verts[nb[b2]][2]; na++; }
        if (na < 2) continue;
        var vv = verts[vi];
        nv[vi] = [vv[0] + 0.5 * (ax / na - vv[0]), vv[1] + 0.5 * (ay / na - vv[1]), vv[2] + 0.5 * (az / na - vv[2])];
      }
      verts = nv;
    }
    verts.forEach(function (v) { walk(v, 2); });          /* ...every vertex onto the surface, along the field's gradient */
    var out = [];
    quads.forEach(function (qd) {
      var A = verts[qd[0]], B = verts[qd[1]], C = verts[qd[2]], D = verts[qd[3]];
      if (qd[4]) { var t2 = B; B = D; D = t2; }
      out.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], A[0], A[1], A[2], C[0], C[1], C[2], D[0], D[1], D[2]);
    });
    return new Float32Array(out);
  }

  /* A CONVEX SOLID CUT AT A HEIGHT: what lies over z = zc is taken off and the cut closed with a cap (a tube, a ball, a post, a cap cone is each convex:
     the cut is one convex polygon). Triangles over the plane go; those across it are clipped; the cut's points, ordered round their
     middle, are the cap. A soup wholly under the plane is returned as it was. Used on a stair's own tree: a leaning post ends where
     the strips' top is, not 0.5 mm over it in the air (a speck in the slice, the owner's "stray piece floating above where supports stop"). */
  function clipConvexBelow(soup, zc) {
    var n = soup.length / 9, over = false, i;
    for (i = 0; i < soup.length; i += 3) if (soup[i + 2] > zc + 1e-6) { over = true; break; }
    if (!over) return soup;
    var out = [], cut = [];
    function put(a, b, c) { out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); }
    function at(a, b) { var t = (zc - a[2]) / (b[2] - a[2]); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, zc]; }
    for (i = 0; i < n; i++) {
      var v = [[soup[9 * i], soup[9 * i + 1], soup[9 * i + 2]], [soup[9 * i + 3], soup[9 * i + 4], soup[9 * i + 5]], [soup[9 * i + 6], soup[9 * i + 7], soup[9 * i + 8]]];
      var inn = v.map(function (q) { return q[2] <= zc + 1e-6; }), k = inn.filter(Boolean).length;
      if (k === 3) { put(v[0], v[1], v[2]); continue; }
      if (k === 0) continue;
      /* rotate so the odd vertex is v[0] */
      var odd = k === 1 ? inn.indexOf(true) : inn.indexOf(false), a = v[odd], b = v[(odd + 1) % 3], c = v[(odd + 2) % 3];
      if (k === 1) { var p1 = at(a, b), p2 = at(a, c); put(a, p1, p2); cut.push(p1, p2); }
      else { var q1 = at(b, a), q2 = at(c, a); put(b, c, q2); put(b, q2, q1); cut.push(q1, q2); }
    }
    if (cut.length >= 3) {
      var cx = 0, cy = 0;
      cut.forEach(function (q) { cx += q[0] / cut.length; cy += q[1] / cut.length; });
      var ring = cut.slice().sort(function (p, q) { return Math.atan2(p[1] - cy, p[0] - cx) - Math.atan2(q[1] - cy, q[0] - cx); });
      var uniq = [];
      ring.forEach(function (q) { var l = uniq[uniq.length - 1]; if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-6) uniq.push(q); });
      for (i = 1; i + 1 < uniq.length; i++) put([cx, cy, zc], uniq[i + 1], uniq[i]);          /* up-facing: counter-clockwise from above */
      if (uniq.length > 2) put([cx, cy, zc], uniq[1], uniq[0]);
    }
    return new Float32Array(out);
  }

  /* THE FLARE'S CURVE: the extra radius a trunk has over its law under FLARE_MM is a trumpet, not a cone - tb x flareMm at the plate,
     falling with the square of the way up to the stem, which it meets at the stem's own slope: no visible joint where the base ends
     and the trunk begins, and a trunk that is mostly trunk (the owner's, on the first cone) */
  function flareAt(z, zf, tb, fm) {
    if (!(z < zf)) return 0;
    var u = (zf - z) / fm;
    return tb * fm * u * u;
  }
  /* the heights a trunk's rings stand at over its flare: the bottom, FLARE_RINGS between, the flare's top, the top */
  var FLARE_RINGS = 6;
  function ringZs(z0, zf, top) {
    var out = [z0];
    if (zf > z0 + 1e-6 && zf < top - 1e-6) {
      for (var i = 1; i < FLARE_RINGS; i++) out.push(z0 + (zf - z0) * i / FLARE_RINGS);
      out.push(zf);
    }
    out.push(top);
    return out;
  }

  /* THE TAPERED BASE, kept where the piece leaves no room for the law's own: a trunk that stood a straight stick up from its
     pad (its room the same at every height) can pop off the plate in the print. Rings [z, r] or [z, a, b], bottom first, are
     held under a cone that starts at the bottom ring - FLARE_ANGLE_DEG a side over the flare's height (zf), the law's own
     angle above it - and never under floor (the trunk's own column). A ring already narrower is left alone. */
  function taperBase(rings, floor, zf) {
    var z0 = rings[0][0], tf = Math.tan(FLARE_ANGLE_DEG * Math.PI / 180) + Math.tan(TRUNK_ANGLE_DEG * Math.PI / 180), ta = Math.tan(TRUNK_ANGLE_DEG * Math.PI / 180);
    var base = rings[0].slice(1);
    for (var i = 1; i < rings.length; i++) {
      var dz = rings[i][0] - z0, drop = dz <= zf - z0 ? tf * dz : tf * (zf - z0) + ta * (dz - (zf - z0));
      for (var j = 1; j < rings[i].length; j++) rings[i][j] = Math.max(Math.min(floor, rings[i][j]), Math.min(rings[i][j], base[j - 1] - drop));
    }
  }

  /* A CROWN's trunk (CROWNS): the law's body - area kept - made oval along the spread of its tips, as long as the piece
     leaves room: where it comes near, the oval is first made less long (area kept), and only when it is round and still
     does not fit is it narrowed under the law (never under the 2 mm of the law's top). g.crown: { ang, k, dR }. */
  function growCrownTrunk(f, fi, g, probes, plateZ, thick, ta, tb, cosN, zf, z0) {
    var cr = g.crown, cx = f.c[0], cy = f.c[1], top = Math.max(g.top, z0 + 2 * thick), LW = cr.law;
    if (LW) { ta = Math.tan(LW.angleDeg * Math.PI / 180); tb = Math.tan(LW.flareAngleDeg * Math.PI / 180); zf = plateZ + LW.flareMm; }
    var tipMm = LW ? LW.tipMm : TRUNK_TIP_MM;
    var Hl = LW && LW.uniformH != null ? plateZ + LW.uniformH : g.H;
    var law = function (z) { return tipMm / 2 + ta * Math.max(0, Hl - z) + flareAt(z, zf, tb, LW ? LW.flareMm : FLARE_MM) + cr.dR; };
    var rec = { c: [cx, cy], H: g.H, stemTop: g.top, top: top, rings: null, why: null, crown: true, k: cr.k, ang: cr.ang };
    f.grown = rec;
    var zs = [];
    for (var z = z0; z < top - 1e-9; z += TRUNK_STEP_MM) zs.push(z);
    zs.push(top);
    var ca = Math.cos(cr.ang), sa = Math.sin(cr.ang), slack = TRUNK_STEP_MM / 2, M = 32;
    /* the piece's distance from the axis at each height, read once (nearest face; inside counts as 0) */
    var dAx = zs.map(function (zz) {
      var d = Infinity;
      probes.forEach(function (P) {
        if (insideSigned(P, [cx, cy, zz])) { d = 0; return; }
        var hit = P.nearest([cx, cy, zz], law(zs[0]) * Math.sqrt(cr.k) / cosN + TRUNK_KEEP_MM + 3);
        if (hit && hit.dist < d) d = hit.dist;
      });
      return d;
    });
    /* does the ellipse (outer long a, short b) at zs[q] keep TRUNK_KEEP_MM off the piece? */
    function roomAt(q, a, b) {
      var d = dAx[q];
      if (d >= a + TRUNK_KEEP_MM + slack) return true;
      if (d < b + TRUNK_KEEP_MM + slack) return false;
      for (var j = 0; j < M; j++) {
        var t = 2 * Math.PI * j / M, ex = a * Math.cos(t), ey = b * Math.sin(t), pt = [cx + ex * ca - ey * sa, cy + ex * sa + ey * ca, zs[q]];
        for (var w = 0; w < probes.length; w++) {
          if (insideSigned(probes[w], pt)) return false;
          var hit = probes[w].nearest(pt, TRUNK_KEEP_MM + slack + 0.01);
          if (hit && hit.dist < TRUNK_KEEP_MM + slack) return false;
        }
      }
      return true;
    }
    var k = cr.k, ks = [];
    for (var i = 0; i <= 4; i++) ks.push(1 + (cr.k - 1) * (4 - i) / 4);
    var useK = null;
    for (i = 0; i < ks.length && useK == null; i++) {
      var kq = Math.sqrt(ks[i]), ok = true;
      for (var q = 0; q < zs.length && ok; q++) ok = roomAt(q, law(zs[q]) * kq / cosN, law(zs[q]) / kq / cosN);
      if (ok) useK = ks[i];
    }
    var rings;
    if (useK != null) {
      var kk = Math.sqrt(useK);
      rings = ringZs(zs[0], zf, top).map(function (zr) { return [zr, law(zr) * kk / cosN, law(zr) / kk / cosN]; });
      rec.k = useK;
    } else {
      /* round, and narrowed where the piece comes near: a ring a millimetre, each held to the least room within a millimetre
         of it - the law's body, no less than the law's own top */
      rings = [];
      var floorR = tipMm / 2 / cosN;
      for (var q2 = 0; q2 < zs.length; q2 += Math.round(1 / TRUNK_STEP_MM)) {
        var room = Infinity;
        for (var q3 = 0; q3 < zs.length; q3++) if (Math.abs(zs[q3] - zs[q2]) <= 1 + 1e-9) room = Math.min(room, dAx[q3] - TRUNK_KEEP_MM - slack);
        var R = Math.max(floorR, Math.min(law(zs[q2]) / cosN, room));
        rings.push([zs[q2], R, R]);
      }
      if (rings[rings.length - 1][0] < top - 1e-6) { var Rt = Math.max(floorR, Math.min(law(top) / cosN, dAx[zs.length - 1] - TRUNK_KEEP_MM - slack)); rings.push([top, Rt, Rt]); }
      taperBase(rings, floorR, zf);
      rec.narrowed = true; rec.k = 1;
    }
    rec.rings = rings;
    rec.top = rings[rings.length - 1][0];
    rec.axis = [ca, sa];
    var ph = ((GOLDEN_DEG * (fi + 1)) % (360 / TRUNK_SIDES)) * Math.PI / 180;
    f.shell = revolveSoup(cx, cy, rings, TRUNK_SIDES, ph, cr.ang);
    f.core = Math.max(f.r * Math.SQRT1_2, Math.min(rings[0][1], rings[0][2]) * cosN);
    f.r = Math.max(f.r, rings[0][1]);
  }

  /* Every foot with a trunk record (f.grow: { H, top, side, tips }) gets its
     trunk: f.shell (the soup), f.grown (what was built, or why not), and its
     footprint widened to the trunk's base (f.r, and f.core, the base's
     inscribed radius: always pad). Feet without a record are left alone. */
  function growTrunks(TH, obstacles, feet, plateZ, thick) {
    var probes = obstacles.map(function (sp) { return probeOf(TH, sp); }).filter(Boolean);
    var tb = Math.tan(FLARE_ANGLE_DEG * Math.PI / 180);
    var cosN = Math.cos(Math.PI / TRUNK_SIDES), tips = [], seen = [];
    feet.forEach(function (f) {
      var T = f.grow && f.grow.tips;
      if (T && seen.indexOf(T) < 0) { seen.push(T); tips = tips.concat(T); }
    });
    var zf = plateZ + FLARE_MM, z0 = plateZ + thick / 2;
    feet.forEach(function (f, fi) {
      var g = f.grow;
      if (!g) return;
      var cx = f.c[0], cy = f.c[1];
      /* the law's inscribed radius at z, and the side's outer radius it is built at (the foot's own law: the knobs', when given) */
      var tipMm = g.law ? g.law.tipMm : TRUNK_TIP_MM, ta = Math.tan((g.law ? g.law.angleDeg : TRUNK_ANGLE_DEG) * Math.PI / 180);
      if (g.crown) { growCrownTrunk(f, fi, g, probes, plateZ, thick, ta, tb, cosN, zf, z0); return; }
      var law = function (z) { return tipMm / 2 + ta * Math.max(0, g.H - z) + flareAt(z, zf, tb, FLARE_MM); };
      var Rmax = law(z0) / cosN, top = g.top;
      tips.forEach(function (q) {
        if (Math.hypot(q[0] - cx, q[1] - cy) <= Rmax + TRUNK_TIP_REACH_MM) top = Math.min(top, q[2] - TRUNK_TIP_CLEAR_MM);
      });
      var rec = { c: [cx, cy], H: g.H, stemTop: g.top, top: top, rings: null, why: null };
      if (g.law) rec.law = g.law;
      f.grown = rec;
      if (!(top > z0 + thick)) { rec.why = 'no height under its tips'; return; }
      /* how far each height of the axis may reach before it comes within TRUNK_KEEP_MM of the piece, less the step's slack */
      var zs = [], allow = [];
      for (var z = z0; z < top - 1e-9; z += TRUNK_STEP_MM) zs.push(z);
      zs.push(top);
      zs.forEach(function (zz) {
        var d = Infinity;
        probes.forEach(function (P) {
          if (P.inside && P.inside([cx, cy, zz])) { d = 0; return; }
          var hit = P.nearest([cx, cy, zz], Rmax + TRUNK_KEEP_MM + 1);
          if (hit && hit.dist < d) d = hit.dist;
        });
        allow.push(d - TRUNK_KEEP_MM - TRUNK_STEP_MM / 2);
      });
      var rings;
      if (zs.every(function (zz, k) { return law(zz) / cosN <= allow[k]; })) {
        rings = ringZs(z0, zf, top).map(function (zr) { return [zr, law(zr) / cosN]; });
      } else {
        /* narrowed where the piece comes near: a ring a millimetre, each held
           to the least room within a millimetre of it (so every height between
           two rings is), ending under the first that would be narrower than
           the trunk's own column */
        rings = [];
        var own = g.side / 2 / cosN;
        for (var k = 0; k < zs.length; k += Math.round(1 / TRUNK_STEP_MM)) {
          var zz = zs[k], room = Infinity;
          for (var q = 0; q < zs.length; q++) if (Math.abs(zs[q] - zz) <= 1 + 1e-9) room = Math.min(room, allow[q]);
          var R = Math.min(law(zz) / cosN, room);
          if (R < own) break;
          rings.push([zz, R]);
        }
        if (rings.length < 2) { rec.why = 'no room beside the piece'; return; }
        taperBase(rings, own, zf);
        rec.narrowed = true;
      }
      rec.rings = rings;
      rec.top = rings[rings.length - 1][0];
      var ph = ((GOLDEN_DEG * (fi + 1)) % (360 / TRUNK_SIDES)) * Math.PI / 180;
      f.shell = revolveSoup(cx, cy, rings, TRUNK_SIDES, ph);
      f.core = Math.max(f.r * Math.SQRT1_2, rings[0][1] * cosN);
      f.r = Math.max(f.r, rings[0][1]);
    });
    return feet.filter(function (f) { return f.grown; }).map(function (f) { return f.grown; });
  }

  /* Ear clipping of a simple polygon, counter-clockwise in, triangles out as
     index triples, or null when it will not triangulate (a self-touching
     outline): the caller then leaves that polygon alone. */
  function earClip(poly) {
    var n = poly.length, idx = [], i, out = [];
    if (n < 3) return null;
    for (i = 0; i < n; i++) idx.push(i);
    function cross2(a, b, c) { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
    function inTri(p, a, b, c) {
      return cross2(a, b, p) >= -1e-12 && cross2(b, c, p) >= -1e-12 && cross2(c, a, p) >= -1e-12;
    }
    var guard = 0;
    while (idx.length > 3) {
      var clipped = false, m = idx.length;
      for (i = 0; i < m; i++) {
        var ia = idx[(i + m - 1) % m], ib = idx[i], ic = idx[(i + 1) % m];
        var a = poly[ia], b = poly[ib], c = poly[ic];
        if (!(cross2(a, b, c) > 1e-12)) continue;             /* reflex or flat: not an ear */
        var ear = true;
        for (var j = 0; j < m && ear; j++) {
          var ij = idx[j];
          if (ij === ia || ij === ib || ij === ic) continue;
          if (inTri(poly[ij], a, b, c)) ear = false;
        }
        if (!ear) continue;
        out.push([ia, ib, ic]);
        idx.splice(i, 1);
        clipped = true;
        break;
      }
      if (!clipped || ++guard > 10 * n) return null;
    }
    out.push([idx[0], idx[1], idx[2]]);
    return out;
  }

  /* A prism over a simple counter-clockwise polygon, from z0 to z1, outward-
     wound; null if the polygon will not triangulate. */
  function prismSoup(poly, z0, z1) {
    var tri = earClip(poly);
    if (!tri) return null;
    var n = poly.length, out = new Float32Array((tri.length * 2 + n * 2) * 9), w = 0;
    function put(a, b, c) {
      out[w++] = a[0]; out[w++] = a[1]; out[w++] = a[2];
      out[w++] = b[0]; out[w++] = b[1]; out[w++] = b[2];
      out[w++] = c[0]; out[w++] = c[1]; out[w++] = c[2];
    }
    tri.forEach(function (t) {
      var a = poly[t[0]], b = poly[t[1]], c = poly[t[2]];
      put([a[0], a[1], z1], [b[0], b[1], z1], [c[0], c[1], z1]);
      put([a[0], a[1], z0], [c[0], c[1], z0], [b[0], b[1], z0]);
    });
    for (var k = 0; k < n; k++) {
      var p0 = poly[k], p1 = poly[(k + 1) % n];
      put([p0[0], p0[1], z0], [p1[0], p1[1], z0], [p1[0], p1[1], z1]);
      put([p0[0], p0[1], z0], [p1[0], p1[1], z1], [p0[0], p0[1], z1]);
    }
    return out;
  }

  /* Douglas-Peucker on a closed loop, eps in the loop's own units. */
  function simplifyLoop(pts, eps) {
    var n = pts.length;
    if (n < 4) return pts;
    function dseg(p, a, b) {
      var dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
      var t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
      return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
    }
    function dp(lo, hi, keep) {
      var worst = -1, at = -1;
      for (var i = lo + 1; i < hi; i++) { var d = dseg(pts[i], pts[lo], pts[hi % n]); if (d > worst) { worst = d; at = i; } }
      if (worst > eps) { keep[at] = true; dp(lo, at, keep); dp(at, hi, keep); }
    }
    var far = 0, fd = -1;                                      /* split at the point farthest from vertex 0 */
    for (var i = 1; i < n; i++) { var d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]); if (d > fd) { fd = d; far = i; } }
    var keep = new Array(n); keep[0] = true; keep[far] = true;
    dp(0, far, keep); dp(far, n, keep);
    return pts.filter(function (p, k) { return keep[k]; });
  }

  /* =====================================================================
     FEET - one first-layer pad under every group of trunks
     =====================================================================
     A trunk that lands on the plate stands on a pad one first layer thick.
     Trunks whose feet stand within FOOT_CLUSTER_MM share ONE pad: the union
     of their footprints (the circle round each trunk's end square, footprintOf)
     grown by FOOT_GROW_MM, kept FOOT_GAP_MM off the piece. Pads that
     would touch - overlap, or part by less than FOOT_TOUCH_MM - are one pad,
     and every trunk on one pad is one support: on the 2026-10-20 print the
     first layers of two supports overlapped and Bambu Studio reported a path
     conflict between them. A cluster's grown footprints always meet (6 mm is
     under twice the growth), so a cluster stands on one pad unless the piece
     itself stands between its feet. Pads the piece's keep-off leaves less
     than FOOT_TOUCH_MM apart (and their outlines' simplification) cannot
     print apart either: they are LINKED, and their trunks one support too
     (groups). clustersSplit counts the clusters whose feet still stand in
     more than one support - but for a foot the piece itself hems in,
     measured exactly (clustersHemmed); hemmed, the pads that are nothing but a foot's
     own end (the piece all round it, or the raster's slack round a thin
     trunk beside a thin pin of the piece); a sliver of that kind that will
     not triangulate is no pad (padsDropped): the trunk stands on its own end.

     EACH GROUP OF FEET HAS ITS OWN RASTER (rasterPads): feet whose grown
     footprints could come within FOOT_TOUCH_MM of each other. One raster
     over every foot coarsened its cells with their spread - one foot 250 mm
     away made them 0.13 mm, and the slack rang a thin trunk round with
     piece that was not there.

     Drawn on a raster of FOOT_CELL_MM, since the union of grown circles has no
     closed form a soup wants: a cell is pad when its centre is within
     FOOT_GROW_MM of a footprint and further than FOOT_GAP_MM (and the
     raster's own slack: a row between two that read the piece, a cell's
     half-diagonal, the outline's simplification) from the piece anywhere
     through the slab and the gap above it (rows of horizontal rays, parity,
     every 0.04 mm up). The cells inside a trunk's own end square are always
     pad, whatever is near: the circle in the square (r / root 2), less the
     cell's half-diagonal and the outline's simplification, so a pad comes no
     nearer the piece than the trunk standing on it (the planner keeps the
     trunk off; the circle round the square would reach a quarter of a
     millimetre past its sides - 0.14 mm off the clamp). Air the
     pad closes round is pad, and a crack under FOOT_TOUCH_MM between two
     parts of it is closed; a hole the piece stands in (a leg of it, with
     trunks all round) is opened to the outside by a slot three cells wide,
     the way that cuts least pad and bends between the feet, so every pad is
     one simple outline, traced on the cells' edges, simplified to a cell and
     extruded.

     footPads(TH, obstacles, feet, plateZ, thick)
       feet: [{ key, c: [x, y], r }] - footprintOf's circles
       -> { pads: [{ keys, poly, soup, areaMm2, hemmed }], groups: [[keys]] (one
            support each), clusters: [[keys]], clustersSplit, clustersHemmed,
            hemmed, padsDropped, holesFilled, holesSlotted, cellMm, failed: [why] }
     ===================================================================== */
  var PROBES = typeof WeakMap === 'function' ? new WeakMap() : null;
  function probeOf(TH, soup) {
    var sig = soup.length + ':' + soup[0] + ':' + soup[soup.length >> 1] + ':' + soup[soup.length - 1];
    var hit = PROBES && PROBES.get(soup);
    if (hit && hit.sig === sig && hit.TH === TH) return hit.P;
    var P = TH.prepare(soup, {});
    if (PROBES && P) PROBES.set(soup, { sig: sig, TH: TH, P: P });
    return P;
  }
  function TM(o) { return (o && o.thickness) || (root && root.NSO_Thickness) || null; }
  /* how far a foot's pad is grown past its trunk's base: FOOT_GROW_MM, or - the crown's trunk, with its own law (crown.trunk.padGrowMm) - that:
     a pad a hand wider than the trunk, the way Bambu's is round a model's stem (the owner's, on the first cone) */
  function padGrowOf(f) {
    var law = f.grow && f.grow.crown && f.grow.crown.law;
    return law && law.padGrowMm != null ? Math.min(FOOT_GROW_MM, law.padGrowMm) : FOOT_GROW_MM;
  }
  function footPads(TH, obstacles, feet, plateZ, thick) {
    var res = { pads: [], groups: [], clusters: [], clustersSplit: 0, hemmed: 0, padsDropped: 0, holesFilled: 0, holesSlotted: 0, cellMm: FOOT_CELL_MM, failed: [] };
    if (!feet.length) return res;
    var nF = feet.length, i, j;
    function uf(n) { var par = []; for (var q = 0; q < n; q++) par.push(q); return { find: function (x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; },
      join: function (x, y) { x = this.find(x); y = this.find(y); if (x !== y) par[Math.max(x, y)] = Math.min(x, y); } }; }
    /* the clusters: feet within FOOT_CLUSTER_MM, single linkage */
    var CL = uf(nF), rMax = 0;
    feet.forEach(function (f) { rMax = Math.max(rMax, f.r); });
    for (i = 0; i < nF; i++) for (j = i + 1; j < nF; j++) {
      if (Math.hypot(feet[i].c[0] - feet[j].c[0], feet[i].c[1] - feet[j].c[1]) <= FOOT_CLUSTER_MM + 1e-9) CL.join(i, j);
    }
    var cl = {};
    for (i = 0; i < nF; i++) (cl[CL.find(i)] || (cl[CL.find(i)] = [])).push(i);
    /* EACH GROUP OF FEET ON ITS OWN RASTER: feet whose grown footprints
       could come within FOOT_TOUCH_MM (and a millimetre more) of each other.
       One raster over every foot coarsened its cells with the spread of the
       feet (FOOT_CELLS_MAX) - one far foot made a small trunk's cells 0.13 mm
       and the raster's slack rang its foot round with "piece" that was not
       there - and cost a flood of every cell per hole. */
    var GR = uf(nF), reach = 2 * (rMax + FOOT_GROW_MM) + FOOT_TOUCH_MM + 1;
    for (i = 0; i < nF; i++) for (j = i + 1; j < nF; j++) {
      if (Math.abs(feet[i].c[0] - feet[j].c[0]) <= reach && Math.abs(feet[i].c[1] - feet[j].c[1]) <= reach &&
          Math.hypot(feet[i].c[0] - feet[j].c[0], feet[i].c[1] - feet[j].c[1]) <= reach) GR.join(i, j);
    }
    var groups = {};
    for (i = 0; i < nF; i++) (groups[GR.find(i)] || (groups[GR.find(i)] = [])).push(i);
    /* every foot on a pad, and pads that come within FOOT_TOUCH_MM of each
       other (a gap the piece's keep-off leaves, too narrow to print apart),
       are ONE support: SUP joins the feet */
    var SUP = uf(nF), all = [];
    Object.keys(groups).forEach(function (g0) {
      var idx = groups[g0], r = rasterPads(TH, obstacles, idx.map(function (q) { return feet[q]; }), plateZ, thick);
      res.cellMm = Math.max(res.cellMm, r.cellMm); res.holesFilled += r.holesFilled; res.holesSlotted += r.holesSlotted;
      res.failed = res.failed.concat(r.failed);
      var base = all.length;
      r.pads.forEach(function (pd) {
        pd.feet = pd.feet.map(function (l) { return idx[l]; });
        for (var q = 1; q < pd.feet.length; q++) SUP.join(pd.feet[0], pd.feet[q]);
        all.push(pd);
      });
      r.links.forEach(function (lk) { SUP.join(all[base + lk[0]].feet[0], all[base + lk[1]].feet[0]); });
    });
    all.forEach(function (pd) {
      if (pd.hemmed) res.hemmed++;
      if (!pd.soup) { res.padsDropped++; return; }
      res.pads.push({ keys: pd.feet.map(function (f) { return feet[f].key; }), feet: pd.feet.slice(), poly: pd.poly, soup: pd.soup, areaMm2: pd.areaMm2, hemmed: pd.hemmed });
    });
    var sup = {};
    for (i = 0; i < nF; i++) (sup[SUP.find(i)] || (sup[SUP.find(i)] = [])).push(feet[i].key);
    res.groups = Object.keys(sup).map(function (r0) { return sup[r0]; });
    /* A FOOT THE PIECE HEMS IN, measured, not read off the raster: no point
       in the band a pad touching its end square would cover (rings out to
       FOOT_GAP_MM from the square) stands FOOT_GAP_MM clear of the piece
       anywhere through the slab and the gap above it - so no pad can touch
       the trunk and keep the gap: the wedge's trunk in a pocket of
       v9_mirror_factory has none within 0.95 mm of its middle. A thin trunk
       the raster's slack rang round (a thin pin of the piece beside it) has
       some right at its square, and stays a split. */
    var probes = obstacles.map(function (sp) { return probeOf(TH, sp); }).filter(Boolean);
    function hemmedExactly(f) {
      var rIn = f.core != null ? f.core : f.r * Math.SQRT1_2, zs = [];
      for (var zz = 0.02; zz <= thick + FOOT_GAP_MM + 1e-9; zz += 0.06) zs.push(plateZ + zz);
      for (var dr = 0.05; dr <= FOOT_GAP_MM + 1e-9; dr += 0.05) {
        for (var k2 = 0; k2 < 36; k2++) {
          var a = 2 * Math.PI * k2 / 36, x = f.c[0] + (rIn + dr) * Math.cos(a), y = f.c[1] + (rIn + dr) * Math.sin(a);
          var clear = zs.every(function (z) {
            /* nearest() answers with the nearest face at any distance inside
               the probe's grid: the distance is read, not the answer's absence */
            return probes.every(function (P) { if (P.inside && P.inside([x, y, z])) return false; var hit = P.nearest([x, y, z], FOOT_GAP_MM); return !hit || !(hit.dist < FOOT_GAP_MM); });
          });
          if (clear) return false;
        }
      }
      return true;
    }
    /* clusters, by key, and how many stand in more than one support - but
       for feet the piece hems in (clustersHemmed) */
    res.clustersHemmed = 0;
    Object.keys(cl).forEach(function (r0) {
      var fs = cl[r0], bySup = {};
      fs.forEach(function (f) { (bySup[SUP.find(f)] || (bySup[SUP.find(f)] = [])).push(f); });
      var parts = Object.keys(bySup).map(function (k3) { return bySup[k3]; }).sort(function (a, b) { return b.length - a.length; });
      if (parts.length > 1) {
        if (parts.slice(1).every(function (pt) { return pt.every(function (f) { return hemmedExactly(feet[f]); }); })) res.clustersHemmed++;
        else res.clustersSplit++;
      }
      res.clusters.push(fs.map(function (f) { return feet[f].key; }));
    });
    return res;
  }
  /* One group's raster (footPads): its pads [{ feet (local), poly, soup, areaMm2,
     hemmed }] - soup null for a sliver that would not triangulate - and links
     [[pad, pad]] between pads within FOOT_TOUCH_MM of each other. */
  function rasterPads(TH, obstacles, feet, plateZ, thick) {
    var res = { pads: [], links: [], holesFilled: 0, holesSlotted: 0, cellMm: FOOT_CELL_MM, failed: [] };
    var i, j, k;

    /* the raster */
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    feet.forEach(function (f) { x0 = Math.min(x0, f.c[0] - f.r); x1 = Math.max(x1, f.c[0] + f.r); y0 = Math.min(y0, f.c[1] - f.r); y1 = Math.max(y1, f.c[1] + f.r); });
    var mg = FOOT_GROW_MM + 6 * FOOT_CELL_MM;   /* (the widest a pad grows: a foot's own padGrow is never more) */
    x0 -= mg; y0 -= mg; x1 += mg; y1 += mg;
    var h = Math.max(FOOT_CELL_MM, Math.sqrt((x1 - x0) * (y1 - y0) / FOOT_CELLS_MAX));
    res.cellMm = h;
    var nx = Math.ceil((x1 - x0) / h) + 1, ny = Math.ceil((y1 - y0) / h) + 1, N = nx * ny;
    function cx(ii) { return x0 + (ii + 0.5) * h; }
    function cy(jj) { return y0 + (jj + 0.5) * h; }
    var grow = new Uint8Array(N), core = new Int32Array(N).fill(-1), solid = new Uint8Array(N), block = new Uint8Array(N);
    feet.forEach(function (f, fi) {
      var Rg = f.r + padGrowOf(f), rg2 = Rg * Rg, rc = Math.max(h, (f.core != null ? f.core : f.r * Math.SQRT1_2) - h * (1 + Math.SQRT1_2)), rc2 = rc * rc, fx = f.c[0], fy = f.c[1];
      var i0 = Math.max(0, Math.floor((fx - Rg - x0) / h)), i1 = Math.min(nx - 1, Math.ceil((fx + Rg - x0) / h));
      var j0 = Math.max(0, Math.floor((fy - Rg - y0) / h)), j1 = Math.min(ny - 1, Math.ceil((fy + Rg - y0) / h));
      for (var jj = j0; jj <= j1; jj++) {
        var dy = y0 + (jj + 0.5) * h - fy, dy2 = dy * dy;
        if (dy2 > rg2) continue;
        for (var ii = i0; ii <= i1; ii++) {
          var dx = x0 + (ii + 0.5) * h - fx, d2 = dx * dx + dy2;
          if (d2 > rg2) continue;
          grow[jj * nx + ii] = 1;
          if (d2 <= rc2 && core[jj * nx + ii] < 0) core[jj * nx + ii] = fi;
        }
      }
    });
    /* the piece through the slab and the gap above it: every cell a row's
       inside interval touches */
    var hs = [];
    for (var zz = 0.02; zz <= thick + FOOT_GAP_MM + 0.04 + 1e-9; zz += 0.04) hs.push(zz);
    obstacles.forEach(function (soup) {
      var P = probeOf(TH, soup);
      if (!P) return;
      for (var jj = 0; jj < ny; jj++) {
        var y = cy(jj);
        if (y < P.lo[1] || y > P.hi[1]) continue;
        for (var hk = 0; hk < hs.length; hk++) {
          var z = plateZ + hs[hk];
          if (z < P.lo[2] || z > P.hi[2]) continue;
          var xs = P.lo[0] - 1, hits = P.hitsAlong([xs, y, z], [1, 0, 0], P.hi[0] - xs + 1);
          for (var q = 0; q + 1 < hits.length; q += 2) {
            var ia = Math.max(0, Math.floor((xs + hits[q] - x0) / h)), ib = Math.min(nx - 1, Math.floor((xs + hits[q + 1] - x0) / h));
            for (var ii = ia; ii <= ib; ii++) solid[jj * nx + ii] = 1;
          }
        }
      }
    });
    /* blocked: within FOOT_GAP_MM of the piece, and the raster's own slack -
       a row between two that read the piece (h), a cell's half-diagonal, and
       the outline's simplification (h) */
    var rB = FOOT_GAP_MM + h * (2 + Math.SQRT1_2), RB = Math.ceil(rB / h), disc = [];
    for (var dj = -RB; dj <= RB; dj++) for (var di = -RB; di <= RB; di++) if (Math.hypot(di, dj) * h <= rB) disc.push([di, dj]);
    for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) {
      var c0 = j * nx + i;
      if (!solid[c0]) continue;
      block[c0] = 1;
      var edge = i === 0 || j === 0 || i === nx - 1 || j === ny - 1 || !solid[c0 - 1] || !solid[c0 + 1] || !solid[c0 - nx] || !solid[c0 + nx];
      if (!edge) continue;
      for (k = 0; k < disc.length; k++) {
        var ii2 = i + disc[k][0], jj2 = j + disc[k][1];
        if (ii2 >= 0 && ii2 < nx && jj2 >= 0 && jj2 < ny) block[jj2 * nx + ii2] = 1;
      }
    }
    var reg = new Uint8Array(N);
    for (k = 0; k < N; k++) reg[k] = (grow[k] && !block[k]) || core[k] >= 0 ? 1 : 0;
    /* a crack narrower than FOOT_TOUCH_MM between two parts of the pad is pad */
    var KT = Math.max(1, Math.ceil(FOOT_TOUCH_MM / h)), dirs = [[1, 0], [0, 1], [1, 1], [1, -1]], fill = [];
    for (j = 0; j < ny; j++) for (i = 0; i < nx; i++) {
      var c1 = j * nx + i;
      if (reg[c1] || block[c1]) continue;
      for (var dk = 0; dk < dirs.length; dk++) {
        var hitA = false, hitB = false;
        for (var s = 1; s <= KT && !hitA; s++) { var ia1 = i + dirs[dk][0] * s, ja1 = j + dirs[dk][1] * s; if (ia1 >= 0 && ia1 < nx && ja1 >= 0 && ja1 < ny && reg[ja1 * nx + ia1]) hitA = true; }
        for (s = 1; s <= KT && !hitB; s++) { var ib1 = i - dirs[dk][0] * s, jb1 = j - dirs[dk][1] * s; if (ib1 >= 0 && ib1 < nx && jb1 >= 0 && jb1 < ny && reg[jb1 * nx + ib1]) hitB = true; }
        if (hitA && hitB) { fill.push(c1); break; }
      }
    }
    fill.forEach(function (c2) { reg[c2] = 1; });

    /* the air outside: empty cells the raster's edge reaches */
    function outside() {
      var out = new Uint8Array(N), st = [];
      for (var a = 0; a < nx; a++) { st.push(a, (ny - 1) * nx + a); }
      for (var b = 0; b < ny; b++) { st.push(b * nx, b * nx + nx - 1); }
      st = st.filter(function (c3) { if (reg[c3] || out[c3]) return false; out[c3] = 1; return true; });
      while (st.length) {
        var c3 = st.pop(), ci = c3 % nx, cj = (c3 - ci) / nx;
        var nb = [ci > 0 ? c3 - 1 : -1, ci < nx - 1 ? c3 + 1 : -1, cj > 0 ? c3 - nx : -1, cj < ny - 1 ? c3 + nx : -1];
        for (var e = 0; e < 4; e++) if (nb[e] >= 0 && !reg[nb[e]] && !out[nb[e]]) { out[nb[e]] = 1; st.push(nb[e]); }
      }
      return out;
    }
    /* the holes: empty cells the outside does not reach, by component */
    function holes(out) {
      var lab = new Int32Array(N).fill(-1), list = [];
      for (var c4 = 0; c4 < N; c4++) {
        if (reg[c4] || out[c4] || lab[c4] >= 0) continue;
        var cells = [], st = [c4]; lab[c4] = list.length;
        while (st.length) {
          var c5 = st.pop(), ci = c5 % nx, cj = (c5 - ci) / nx;
          cells.push(c5);
          var nb = [ci > 0 ? c5 - 1 : -1, ci < nx - 1 ? c5 + 1 : -1, cj > 0 ? c5 - nx : -1, cj < ny - 1 ? c5 + nx : -1];
          for (var e = 0; e < 4; e++) if (nb[e] >= 0 && !reg[nb[e]] && !out[nb[e]] && lab[nb[e]] < 0) { lab[nb[e]] = list.length; st.push(nb[e]); }
        }
        list.push(cells);
      }
      return list;
    }
    /* air the pad closes round, with nothing of the piece in it, is pad */
    var hl = holes(outside()), toSlot = [];
    hl.forEach(function (cells) {
      if (cells.some(function (c6) { return block[c6]; })) toSlot.push(cells);
      else { cells.forEach(function (c6) { reg[c6] = 1; }); res.holesFilled++; }
    });
    /* a cell joined to the pad only at a corner (a checkerboard of four) is a
       pinch the outline cannot take: the corner is filled, or the cell let go */
    function unpinch() {
      for (var pass = 0; pass < 8; pass++) {
        var changed = false;
        for (var jj = 0; jj + 1 < ny; jj++) for (var ii = 0; ii + 1 < nx; ii++) {
          var a = jj * nx + ii, b = a + 1, c = a + nx, d = c + 1;
          var diag1 = reg[a] && reg[d] && !reg[b] && !reg[c], diag2 = reg[b] && reg[c] && !reg[a] && !reg[d];
          if (!diag1 && !diag2) continue;
          var empties = diag1 ? [b, c] : [a, d], fulls = diag1 ? [a, d] : [b, c];
          var f = empties.filter(function (x) { return !block[x]; });
          if (f.length) reg[f[0]] = 1;
          else { var g = fulls.filter(function (x) { return core[x] < 0; }); if (g.length) reg[g[0]] = 0; else continue; }
          changed = true;
        }
        if (!changed) return;
      }
    }
    unpinch();
    /* A HOLE THE PIECE STANDS IN (a post, a table leg, with trunks landing
       all round it): a slot to the outside air, three cells wide, along the
       way that cuts the least pad and crosses no foot - a search outward
       from the hole, through air for nothing and through pad a cell at a
       time, round the feet's own cells, so it bends between feet where a
       straight one would meet one. One hole at a time, the outside read
       again before each: a hole an earlier slot opened is left as it is,
       and a slot ends at the first air it meets - an earlier slot's too -
       instead of running on across the pad (crossing slots cut a pad in
       two, 0.15 mm apart: two supports). A cut that joins a hole to the
       outside cannot part the pad; it is widened only where it cuts. */
    if (toSlot.length) {
      /* the outside is flooded once; each cut's air is added to it */
      var out1 = outside(), seen = new Int32Array(N), from = new Int32Array(N);
      toSlot.forEach(function (cells, hk) {
        var mark = hk + 1;
        cells = cells.filter(function (c7) { return !reg[c7]; });
        if (!cells.length || cells.some(function (c7) { return out1[c7]; })) return;
        var cur = [], next = [], end = -1;
        cells.forEach(function (c7) { seen[c7] = mark; from[c7] = -1; cur.push(c7); });
        while (cur.length && end < 0) {
          while (cur.length) {
            var c8 = cur.pop();
            if (out1[c8]) { end = c8; break; }
            var ci8 = c8 % nx, cj8 = (c8 - ci8) / nx;
            var nb8 = [ci8 > 0 ? c8 - 1 : -1, ci8 < nx - 1 ? c8 + 1 : -1, cj8 > 0 ? c8 - nx : -1, cj8 < ny - 1 ? c8 + nx : -1];
            for (var e8 = 0; e8 < 4; e8++) {
              var q8 = nb8[e8];
              if (q8 < 0 || seen[q8] === mark || core[q8] >= 0) continue;
              if (reg[q8]) next.push(q8, c8);
              else { seen[q8] = mark; from[q8] = c8; cur.push(q8); }
            }
          }
          if (end >= 0) break;
          cur = [];
          for (var n8 = 0; n8 < next.length; n8 += 2) {
            if (seen[next[n8]] === mark) continue;
            seen[next[n8]] = mark; from[next[n8]] = next[n8 + 1]; cur.push(next[n8]);
          }
          next = [];
        }
        if (end < 0) { res.failed.push('a pad round the piece could not be opened to the outside (its feet ring it)'); return; }
        var cut = [], opened = [];
        for (var c9 = end; c9 >= 0; c9 = from[c9]) { opened.push(c9); if (reg[c9]) cut.push(c9); }
        cut.forEach(function (c10) {
          var ci = c10 % nx, cj = (c10 - ci) / nx;
          for (var dj = -1; dj <= 1; dj++) for (var di = -1; di <= 1; di++) {
            var ii = ci + di, jj = cj + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
            var c11 = jj * nx + ii;
            if (core[c11] < 0 && reg[c11]) { reg[c11] = 0; opened.push(c11); }
          }
        });
        /* the cut, the hole and any air they reach are outside now */
        while (opened.length) {
          var c12 = opened.pop();
          if (reg[c12] || out1[c12]) continue;
          out1[c12] = 1;
          var ci12 = c12 % nx, cj12 = (c12 - ci12) / nx;
          if (ci12 > 0) opened.push(c12 - 1);
          if (ci12 < nx - 1) opened.push(c12 + 1);
          if (cj12 > 0) opened.push(c12 - nx);
          if (cj12 < ny - 1) opened.push(c12 + nx);
        }
        res.holesSlotted++;
      });
      unpinch();
    }
    /* the pads: the parts of the region with a footprint in them */
    var lab = new Int32Array(N).fill(-1), comps = [];
    for (k = 0; k < N; k++) {
      if (!reg[k] || lab[k] >= 0) continue;
      var st2 = [k], cells2 = [];
      lab[k] = comps.length;
      while (st2.length) {
        var c11 = st2.pop(), ci2 = c11 % nx, cj2 = (c11 - ci2) / nx;
        cells2.push(c11);
        var nb2 = [ci2 > 0 ? c11 - 1 : -1, ci2 < nx - 1 ? c11 + 1 : -1, cj2 > 0 ? c11 - nx : -1, cj2 < ny - 1 ? c11 + nx : -1];
        for (var e2 = 0; e2 < 4; e2++) if (nb2[e2] >= 0 && reg[nb2[e2]] && lab[nb2[e2]] < 0) { lab[nb2[e2]] = comps.length; st2.push(nb2[e2]); }
      }
      comps.push({ cells: cells2, feet: [] });
    }
    /* each foot is on the pad its own centre cell is in (feet that stand on
       one another share their cells: a cell's core names only the first) */
    feet.forEach(function (f, fi) {
      var ii = Math.min(nx - 1, Math.max(0, Math.floor((f.c[0] - x0) / h))), jj = Math.min(ny - 1, Math.max(0, Math.floor((f.c[1] - y0) / h)));
      var cc = jj * nx + ii;
      if (lab[cc] >= 0) comps[lab[cc]].feet.push(fi);
      else res.failed.push('a trunk\'s foot is on no pad');
    });
    /* pads within FOOT_TOUCH_MM of each other, and the outlines' own
       simplification, across cells the keep-off left between them: linked */
    var LK = Math.ceil((FOOT_TOUCH_MM + 2 * h) / h) + 1, win = [], linked = {};
    for (var lj = -LK; lj <= LK; lj++) for (var li = -LK; li <= LK; li++) if ((li || lj) && Math.hypot(li, lj) <= LK) win.push([li, lj]);
    comps.forEach(function (cm, ca) {
      if (!cm.feet.length) return;
      cm.cells.forEach(function (c14) {
        var i4 = c14 % nx, j4 = (c14 - i4) / nx;
        if (i4 > 0 && i4 < nx - 1 && j4 > 0 && j4 < ny - 1 && reg[c14 - 1] && reg[c14 + 1] && reg[c14 - nx] && reg[c14 + nx]) return;
        for (var w4 = 0; w4 < win.length; w4++) {
          var i5 = i4 + win[w4][0], j5 = j4 + win[w4][1];
          if (i5 < 0 || j5 < 0 || i5 >= nx || j5 >= ny) continue;
          var cb = lab[j5 * nx + i5];
          if (cb >= 0 && cb !== ca && comps[cb].feet.length) linked[Math.min(ca, cb) + ',' + Math.max(ca, cb)] = true;
        }
      });
    });
    /* each pad's outline: unit edges with the pad on their left, walked into loops */
    var next = new Map();
    function vk(a, b) { return a * (ny + 2) + b; }
    comps.forEach(function (cm, ci3) {
      if (!cm.feet.length) return;
      cm.cells.forEach(function (c12) {
        var i3 = c12 % nx, j3 = (c12 - i3) / nx;
        function open(a, b) { return a < 0 || b < 0 || a >= nx || b >= ny || !reg[b * nx + a]; }
        var es = [];
        if (open(i3, j3 - 1)) es.push([[i3, j3], [i3 + 1, j3]]);
        if (open(i3 + 1, j3)) es.push([[i3 + 1, j3], [i3 + 1, j3 + 1]]);
        if (open(i3, j3 + 1)) es.push([[i3 + 1, j3 + 1], [i3, j3 + 1]]);
        if (open(i3 - 1, j3)) es.push([[i3, j3 + 1], [i3, j3]]);
        es.forEach(function (ed) { ed.comp = ci3; var k0 = vk(ed[0][0], ed[0][1]); if (!next.has(k0)) next.set(k0, []); next.get(k0).push(ed); });
      });
    });
    var loopsOf = {}, used = new Set();
    next.forEach(function (list) {
      list.forEach(function (start) {
        if (used.has(start)) return;
        var loop = [start[0]], cur = start;
        used.add(start);
        for (var g = 0; g < 4 * N; g++) {
          var cand = (next.get(vk(cur[1][0], cur[1][1])) || []).filter(function (e3) { return !used.has(e3); });
          if (!cand.length) break;
          var e4 = cand[0];
          used.add(e4);
          if (e4[1][0] === start[0][0] && e4[1][1] === start[0][1]) { loop.push(e4[0]); break; }
          loop.push(e4[0]); cur = e4;
        }
        var A2 = 0;
        for (var q2 = 0; q2 < loop.length; q2++) { var u = loop[q2], v = loop[(q2 + 1) % loop.length]; A2 += u[0] * v[1] - v[0] * u[1]; }
        (loopsOf[start.comp] || (loopsOf[start.comp] = [])).push({ loop: loop, area2: A2 });
      });
    });
    var padOf = {};
    comps.forEach(function (cm, ci4) {
      if (!cm.feet.length) return;
      var hemmed = cm.cells.every(function (c13) { return core[c13] >= 0; });
      padOf[ci4] = res.pads.length;
      var pd = { feet: cm.feet, poly: null, soup: null, areaMm2: cm.cells.length * h * h, hemmed: hemmed };
      res.pads.push(pd);
      var ls = (loopsOf[ci4] || []).slice().sort(function (a, b) { return b.area2 - a.area2; });
      if (!ls.length || !(ls[0].area2 > 0)) { res.failed.push('a pad has no outline'); return; }
      if (ls.length > 1) { res.failed.push('a pad still has a hole in it'); return; }
      var world = ls[0].loop.map(function (q3) { return [x0 + q3[0] * h, y0 + q3[1] * h]; });
      var soup = null, poly = null;
      for (var tries = 0; tries < 3 && !soup; tries++) {
        poly = simplifyLoop(world, h * (1 + tries));
        soup = prismSoup(poly, plateZ, plateZ + thick);
      }
      /* a sliver round a foot that will not triangulate: no pad - the trunk
         stands on its own end, in the support of the pads it is linked to */
      if (!soup) { if (!(hemmed || pd.areaMm2 < 1)) res.failed.push('a pad\'s outline would not triangulate'); return; }
      var ar = 0;
      for (var q4 = 0; q4 < poly.length; q4++) { var a5 = poly[q4], b5 = poly[(q4 + 1) % poly.length]; ar += a5[0] * b5[1] - b5[0] * a5[1]; }
      pd.poly = poly; pd.soup = soup; pd.areaMm2 = ar / 2;
    });
    Object.keys(linked).forEach(function (k5) { var ab = k5.split(','); res.links.push([padOf[+ab[0]], padOf[+ab[1]]]); });
    return res;
  }

  /* FEET SHARED ACROSS AREAS. The Supports card builds each area on its own
     (parts with footPads: 'shared' - every trunk standing on its foot, no pad
     drawn) and hands every area's shells here: the pads are drawn once, over
     every area's feet (footPads), and the supports that stand on one pad are
     one support - whatever area they hold up. A foot with a trunk record
     (f.grow, the card's build) gets its trunk here first (TRUNKS: under every
     area's tips), and its pad is drawn round the trunk's base; a trunk that
     comes within FOOT_TOUCH_MM of another support's solid makes the two one
     support, as pads too near to print apart do.
       builds: [{ solids: [{ soup, feet: [{ c, r, grow }] }] }]   (shells() results)
       opts: plateZ, firstLayerMm, occluders, thickness
       -> { ok, objects: [{ from: [[build, solid]...], soup, pads, trunks }], pads,
            trunks: [{ from, c, H, stemTop, top, rings, why, soup }], padOutlines: [{ from, poly, areaMm2 }],
            clusters, clustersSplit, hemmed, holesFilled, holesSlotted, reason }
     An object's soup is its solids' soups in order, then its trunks, then
     its pads. */
  function shareFeet(builds, piece, opts) {
    opts = opts || {};
    var TH = TM(opts);
    if (!TH || typeof TH.prepare !== 'function') return { ok: false, reason: 'nso_thickness.js is not loaded - the pads are drawn with its probe' };
    var thick = opts.firstLayerMm == null ? FOOT_LAYER_MM : +opts.firstLayerMm, plateZ = opts.plateZ == null ? 0 : +opts.plateZ;
    var ids = [], idOf = {}, feet = [], footOf = [];
    (builds || []).forEach(function (b, bi) {
      ((b && b.solids) || []).forEach(function (sd, si) {
        var key = bi + ':' + si;
        idOf[key] = ids.length; ids.push([bi, si]);
        (sd.feet || []).forEach(function (f) { feet.push(f.grow ? { key: key, c: f.c, r: f.r, grow: f.grow } : { key: key, c: f.c, r: f.r }); footOf.push(f); });
      });
    });
    var obstacles = [piece].concat(opts.occluders || []).filter(function (s) { return s && s.length >= 9; });
    if (feet.some(function (f) { return f.grow; })) growTrunks(TH, obstacles, feet, plateZ, thick);
    var fp = footPads(TH, obstacles, feet, plateZ, thick);
    if (fp.failed.length) return { ok: false, reason: 'the feet: ' + fp.failed[0] };
    var par = ids.map(function (x, q) { return q; });
    function find(x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }
    /* one support per group of feet: on one pad, or on pads too near to print apart */
    fp.groups.forEach(function (g) {
      for (var q = 1; q < g.length; q++) { var a = find(idOf[g[0]]), b = find(idOf[g[q]]); if (a !== b) par[Math.max(a, b)] = Math.min(a, b); }
    });
    /* a trunk within FOOT_TOUCH_MM of another support's solid: one support.
       Read both ways - the solid's corners inside the trunk's section at
       their height, and the trunk's corners near the solid - on the solids
       whose boxes come that near */
    var boxes = [];
    feet.forEach(function (f) {
      if (!f.shell) return;
      var q = idOf[f.key], rg = f.grown.rings, R = rg[0][1] + FOOT_TOUCH_MM;
      ids.forEach(function (id, k) {
        if (find(k) === find(q)) return;
        var sp = builds[id[0]].solids[id[1]].soup, bx = boxes[k] || (boxes[k] = bounds(sp));
        if (bx.lo[0] > f.c[0] + R || bx.hi[0] < f.c[0] - R || bx.lo[1] > f.c[1] + R || bx.hi[1] < f.c[1] - R ||
            bx.lo[2] > rg[rg.length - 1][0] + FOOT_TOUCH_MM || bx.hi[2] < rg[0][0] - FOOT_TOUCH_MM) return;
        var near = false;
        for (var v = 0; v < sp.length && !near; v += 3) {
          var z = sp[v + 2];
          if (z < rg[0][0] - FOOT_TOUCH_MM || z > rg[rg.length - 1][0] + FOOT_TOUCH_MM) continue;
          var j = 0;
          while (j + 2 < rg.length && rg[j + 1][0] < z) j++;
          var a = rg[j], b = rg[Math.min(j + 1, rg.length - 1)], tt = b[0] > a[0] ? Math.max(0, Math.min(1, (z - a[0]) / (b[0] - a[0]))) : 0;
          if (Math.hypot(sp[v] - f.c[0], sp[v + 1] - f.c[1]) <= a[1] + (b[1] - a[1]) * tt + FOOT_TOUCH_MM) near = true;
        }
        var P = near ? null : probeOf(TH, sp);
        for (var w = 0; P && w < f.shell.length && !near; w += 3) {
          var hit = P.nearest([f.shell[w], f.shell[w + 1], f.shell[w + 2]], FOOT_TOUCH_MM + 0.5);
          if (hit && hit.dist < FOOT_TOUCH_MM) near = true;
        }
        if (near) { var A0 = find(q), B0 = find(k); par[Math.max(A0, B0)] = Math.min(A0, B0); }
      });
    });
    var groups = {}, order = [];
    ids.forEach(function (id, q) { var r = find(q); if (!groups[r]) { groups[r] = { from: [], pads: [], trunks: [] }; order.push(r); } groups[r].from.push(id); });
    feet.forEach(function (f) { if (f.shell) groups[find(idOf[f.key])].trunks.push(f.shell); });
    fp.pads.forEach(function (pd) { groups[find(idOf[pd.keys[0]])].pads.push(pd.soup); });
    var objects = order.map(function (r) {
      var g = groups[r], list = g.from.map(function (id) { return builds[id[0]].solids[id[1]].soup; }).concat(g.trunks, g.pads);
      return { from: g.from, soup: joinAll(list), pads: g.pads.length, trunks: g.trunks.length };
    });
    /* every pad as a member (MEMBERS): it carries what its trunks carry */
    var members = fp.pads.map(function (pd) {
      return padMember(pd.feet.map(function (f) { return footOf[f].member; }).filter(function (x) { return x != null; }),
                       [].concat.apply([], pd.feet.map(function (f) { return footOf[f].carries || []; })), pd.soup);
    });
    var trunks = feet.filter(function (f) { return f.grown; }).map(function (f) {
      return Object.assign({ from: ids[idOf[f.key]], soup: f.shell || null, padR: f.r, padCore: f.core }, f.grown);
    });
    return { ok: true, objects: objects, members: members, pads: fp.pads.length, trunks: trunks,
             padOutlines: fp.pads.map(function (pd) { return { from: pd.keys.map(function (k) { return ids[idOf[k]]; }), poly: pd.poly, areaMm2: pd.areaMm2 }; }), clusters: fp.clusters.length, clustersSplit: fp.clustersSplit,
             clustersHemmed: fp.clustersHemmed, hemmed: fp.hemmed, padsDropped: fp.padsDropped, holesFilled: fp.holesFilled, holesSlotted: fp.holesSlotted,
             reason: fp.pads.length + ' pad(s) under ' + fp.clusters.length + ' cluster(s) of feet' +
               (fp.padsDropped ? ' (' + fp.padsDropped + ' a trunk with no room for a pad, on its own end)' : '') +
               (fp.clustersHemmed ? '; ' + fp.clustersHemmed + ' cluster(s) with a trunk the piece hems in, a support of its own' : '') + '; ' + objects.length + ' support(s)' };
  }

  function boxSoup(lo, hi) {
    var v = [[lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
             [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]]];
    var f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
             [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    var out = new Float32Array(f.length * 9), w = 0;
    f.forEach(function (t) { t.forEach(function (i) { out[w++] = v[i][0]; out[w++] = v[i][1]; out[w++] = v[i][2]; }); });
    return out;
  }

  function bounds(soup) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < soup.length; i++) { var k = i % 3; if (soup[i] < lo[k]) lo[k] = soup[i]; if (soup[i] > hi[k]) hi[k] = soup[i]; }
    return { lo: lo, hi: hi };
  }
  function joinAll(list) {
    var n = 0; list.forEach(function (x) { n += x.length; });
    var out = new Float32Array(n), w = 0;
    list.forEach(function (x) { out.set(x, w); w += x.length; });
    return out;
  }
  /* A ZERO-AREA TRIANGLE whose three float32 corners are distinct but in
     line: the kernel's output after the sheet's join with every trunk it
     carries has one now and then (measured: one at z 41 in the clamp's area
     1, in a trunk the sheet never touches - the join re-triangulates it all).
     It is removed by splitting the neighbour across its long edge at the
     middle corner: the same surface, still closed and manifold, no volume
     moved - each kept only when the exact-vertex census says so. */
  function flatSplit(soup) {
    function key(i) { return soup[i] + ',' + soup[i + 1] + ',' + soup[i + 2]; }
    var n = (soup.length / 9) | 0, flat = [];
    for (var t = 0; t < n; t++) {
      var o = t * 9, ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
      var vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
      var cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (cx === 0 && cy === 0 && cz === 0) {
        var k = [key(o), key(o + 3), key(o + 6)];
        if (k[0] !== k[1] && k[1] !== k[2] && k[0] !== k[2]) flat.push(t);
      }
    }
    if (!flat.length) return soup;
    var edgeTris = new Map();
    for (var e = 0; e < n; e++) for (var c = 0; c < 3; c++) {
      var ka = key(e * 9 + c * 3), kb = key(e * 9 + ((c + 1) % 3) * 3), ek = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      if (!edgeTris.has(ek)) edgeTris.set(ek, []);
      edgeTris.get(ek).push(e);
    }
    var out = Array.prototype.slice.call(soup), dead = {}, add2 = [];
    flat.forEach(function (t) {
      if (dead[t]) return;
      var o = t * 9, P = [0, 1, 2].map(function (c) { return [soup[o + c * 3], soup[o + c * 3 + 1], soup[o + c * 3 + 2]]; });
      /* the middle corner: the one inside the span of the other two */
      var L = [0, 1, 2].map(function (c) { var a = P[(c + 1) % 3], b = P[(c + 2) % 3]; return len(sub(a, b)); });
      var m = L.indexOf(Math.max(L[0], L[1], L[2])), A = P[(m + 1) % 3], B = P[(m + 2) % 3], M = P[m];
      var ka = A.join(','), kb = B.join(','), ek = ka < kb ? ka + '|' + kb : kb + '|' + ka;
      var nb = (edgeTris.get(ek) || []).filter(function (x) { return x !== t && !dead[x]; });
      if (nb.length !== 1) return;
      var q = nb[0], Q = [0, 1, 2].map(function (c) { return [soup[q * 9 + c * 3], soup[q * 9 + c * 3 + 1], soup[q * 9 + c * 3 + 2]]; });
      var qa = -1, qb = -1;
      Q.forEach(function (p, c) { if (p.join(',') === ka) qa = c; if (p.join(',') === kb) qb = c; });
      if (qa < 0 || qb < 0) return;
      var D = Q[3 - qa - qb];
      /* keep the neighbour's winding: it runs A->B or B->A */
      var fwd = (qb === (qa + 1) % 3);
      var t1 = fwd ? [A, M, D] : [M, A, D], t2 = fwd ? [M, B, D] : [B, M, D];
      dead[t] = dead[q] = true;
      add2.push(t1, t2);
    });
    if (!add2.length) return soup;
    var res = [];
    for (var i = 0; i < n; i++) if (!dead[i]) for (var j = 0; j < 9; j++) res.push(out[i * 9 + j]);
    add2.forEach(function (tri) { tri.forEach(function (p) { res.push(p[0], p[1], p[2]); }); });
    var fixed = new Float32Array(res);
    function census(S) {
      var E = new Map(), bad = 0;
      for (var i = 0; i < S.length; i += 9) for (var c = 0; c < 3; c++) {
        var a = i + c * 3, b = i + ((c + 1) % 3) * 3;
        var ka = S[a] + ',' + S[a + 1] + ',' + S[a + 2], kb = S[b] + ',' + S[b + 1] + ',' + S[b + 2];
        var k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
        E.set(k, (E.get(k) || 0) + 1);
      }
      E.forEach(function (v) { if (v !== 2) bad++; });
      return bad;
    }
    return census(fixed) <= census(soup) ? fixed : soup;
  }
  /* flatSplit until nothing changes: a run of flat triangles along one line
     (the clamp's area 1: six on one trunk edge, z 57.79, after the sheet's
     join) comes apart one triangle a pass, each split giving the next flat
     one a proper neighbour */
  function flatSplits(soup) {
    for (var pass = 0; pass < 8; pass++) { var next = flatSplit(soup); if (next === soup) break; soup = next; }
    return soup;
  }
  function boxesTouch(a, b) {
    for (var k = 0; k < 3; k++) if (a.lo[k] > b.hi[k] + 1e-3 || b.lo[k] > a.hi[k] + 1e-3) return false;
    return true;
  }

  /* The sheet for a plan (opts.interface): nso_support_interface.js plans it
     over the plan's stations; the tips are then built to it. Each tip's
     closest approach to the piece is measured on its own swept solid, and a
     tip cut at the gap line (or a side tip drawn back off its face) moves
     until it is the gap - the same rule the sheet's own solve keeps. */
  /* The plan's columns, and the stations at their tips: what the sheet is
     planned over. */
  function sheetStations(p) {
    var cols = [], colOf = {}, treeOf = {};
    (p.trunks || []).forEach(function (tr, t) { tr.members.forEach(function (id) { treeOf[id] = t; }); });
    (p.members || []).forEach(function (m) {
      if (m.dead || !m.path || !m.path.length) return;
      /* a crown's branches and trunk (CROWNS) are what the tips stand on, not columns the sheet's lines keep off: they
         lie 4 mm and more under the tips, where no sheet is, and a stair's strips cross them as they cross the stair's
         own tree (support on support, one support). Only each tip's column is the sheet's. */
      if (m.round && m.crown != null) return;
      var pts = m.path.slice();
      if (m.kind === 'merge' || m.kind === 'pickup') pts.unshift(add(pts[0], [0, 0, m.side / 2]));
      cols.push({ pts: pts, side: m.side, tree: treeOf[m.id] != null ? treeOf[m.id] : null });
      if (m.beacon != null) colOf[m.beacon] = cols.length - 1;
    });
    (p.stubs || []).forEach(function (s) {
      cols.push({ pts: [s.to, s.via, s.from], side: s.side, tree: treeOf[s.member] != null ? treeOf[s.member] : null });
      colOf[s.beacon] = cols.length - 1;
    });
    var sts = (p.stations || []).filter(function (st) { return colOf[st.beacon] != null; }).map(function (st) {
      return { label: st.label, beacon: st.beacon, contact: st.contact, side: !!st.side, col: colOf[st.beacon] };
    });
    return { cols: cols, sts: sts };
  }
  /* How many units parts() counts 'building' in: one per trunk swept, and,
     with the sheet, one per tip the sheet is planned for (a tip that is not
     a side tip) - sheet() tells them off as it goes (its opts.progress). */
  function buildUnits(p, opts) {
    if (!p || !p.ok || !p.trunks || !p.trunks.length) return 0;
    if (!(opts && opts.interface)) return p.trunks.length;
    return p.trunks.length + sheetStations(p).sts.filter(function (st) { return !st.side; }).length;
  }

  function sheetFor(p, opts, foot) {
    var SI = SIM(opts), P = PS(opts);
    if (!SI || typeof SI.sheet !== 'function') return { ok: false, reason: 'nso_support_interface.js is not loaded' };
    var ss = sheetStations(p), cols = ss.cols, sts = ss.sts;
    var plan = SI.sheet(opts.rawTris, sts, {
      columns: cols, sideMm: p.sideMm, plateZ: p.plateZ, footMm: foot, occluders: opts.occluders,
      layerMm: opts.layerMm, gapMm: opts.gapMm, pitchMm: opts.sheetPitchMm, angleDeg: opts.sheetAngleDeg, widthMm: opts.sheetWidthMm, interfaceLayers: opts.interfaceLayers, sheetLayerMm: opts.sheetLayerMm, flatGapMaxMm: opts.sheetFlatGapMm, stairLegMm: opts.sheetStairLegMm, perimeter: opts.sheetPerimeter, footprints: opts.sheetFootprints, regionPlate: opts.sheetRegionPlate, regionSlopes: opts.sheetRegionSlopes, regionFlare: opts.sheetRegionFlare, slabPlate: opts.sheetSlabPlate, slabEpsMm: opts.sheetSlabEps,
      capRiseMm: opts.capRiseMm, capMinMm: opts.capMinMm, capMaxMm: opts.capMaxMm,
      thickness: opts.thickness, crosshatch: opts.crosshatch, rasterLines: opts.rasterLines, beat: opts.beat,
      progress: opts.sheetProgress
    });
    if (!plan.ok) return plan;
    /* a tip's clearance is read on its corners, edge middles and face
       middles - a sample, so it is held a hair over the gap */
    var gap = plan.gapMm, aim = gap + 0.003, byBeacon = {}, tipLog = [];
    plan.tips.forEach(function (t) { byBeacon[t.beacon] = t; });
    /* the tip's own solid against the piece, over its top R mm round the
       contact (the rest of the column is the planner's, kept off by its rails) */
    function clearance(soup, near) {
      var best = Infinity, R = 2.5, seen = new Set();
      function at(x, y, z) {
        if (Math.abs(x - near[0]) > R || Math.abs(y - near[1]) > R || Math.abs(z - near[2]) > R) return;
        var k = x + ',' + y + ',' + z;           /* a corner or an edge is shared: probed once */
        if (seen.has(k)) return;
        seen.add(k);
        var d = plan.probe.nearest([x, y, z], gap + 0.5);
        if (d < best) best = d;
      }
      for (var i = 0; i < soup.length; i += 9) {
        var a = [soup[i], soup[i + 1], soup[i + 2]], b = [soup[i + 3], soup[i + 4], soup[i + 5]], c = [soup[i + 6], soup[i + 7], soup[i + 8]];
        at(a[0], a[1], a[2]); at(b[0], b[1], b[2]); at(c[0], c[1], c[2]);
        at((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2); at((b[0] + c[0]) / 2, (b[1] + c[1]) / 2, (b[2] + c[2]) / 2);
        at((c[0] + a[0]) / 2, (c[1] + a[1]) / 2, (c[2] + a[2]) / 2); at((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3);
      }
      return best;
    }
    function joined(ms) {
      var n = 0; ms.soups.forEach(function (s) { n += s.length; });
      var out = new Float32Array(n), w = 0; ms.soups.forEach(function (s) { out.set(s, w); w += s.length; });
      return out;
    }
    /* lower a cut until the tip's own solid keeps the gap */
    function settleCut(t, build, pts, side, near, phase) {
      var z = t.cutZ, res = null, d = Infinity, path = null;
      for (var it = 0; it < 10; it++) {
        path = cleanPath(SI.cutPath(pts, z, side, t.rise));
        res = build(path);
        if (!res.ok) return res;
        if (t.mode === 'sheet') { d = null; break; }
        d = clearance(res.soup, near);
        if (d >= aim) break;
        z -= (aim - d) + 0.01;
      }
      var needle = null;
      if (t.mode === 'gap' && d != null && d >= aim && z < t.cutZ - 0.1) needle = needleOf(path[0], near, side, phase, z);
      if (needle && res.soups) res.soups = res.soups.concat([needle.soup]);
      tipLog.push({ beacon: t.beacon, mode: t.mode, cutZ: z, clearanceMm: d, needleTopZ: needle ? needle.topZ : null });
      return res;
    }
    /* A TAPERED TIP FOR A LEDGE. A column that holds a ledge beside a wall (a
       square head on a round post: the ledge is 0.2 - 1.2 mm from the flank)
       cannot keep its 1.2 mm square up to the ledge - the flank is inside it -
       so settleCut lowers it until the square clears. Bambu's tower tapers to a
       point there and goes on up to 0.2 - 0.4 mm under the overhang. This is
       that point: from just inside the settled column's top, a straight
       frustum up toward the contact (aimed at it, else straight up), the
       highest one whose own solid keeps the gap. Its top is a bead's width,
       so the slicer lays one line up it. */
    function needleOf(base, near, side, phase, zCut) {
      var topMax = near[2] - gap - 0.02, scales = [0.4, 0.32];
      for (var zt = topMax; zt > zCut + 0.4; zt -= 0.2) {
        var aimAt = [[near[0], near[1]], [base[0], base[1]]];
        for (var a = 0; a < aimAt.length; a++) for (var q = 0; q < scales.length; q++) {
          var r = P.sweep({ points: [[base[0], base[1], zCut - 0.2], [aimAt[a][0], aimAt[a][1], zt]], profile: squareProfile(side, phase), up: [0, 1, 0], scales: [1, scales[q]] });
          if (!r.ok || !r.tris || !r.tris.length) continue;
          if (clearance(r.tris, near) >= aim) return { soup: r.tris, topZ: zt };
        }
      }
      return null;
    }
    /* A CUT KEEPS THE COLUMN AS IT WAS. The sweep seeds its square's frame
       on the first segment and carries it round every bend by the minimal
       rotation (nso_path_sweep.js), so a path that now starts straight up
       from lower down its leg would turn the whole column below by some
       angle - measured: a square corner 0.009 mm nearer the clamp's wall,
       20 mm under the cut. The seed is chosen so that, past the cut, the frame
       is the one the uncut member had there. */
    function rotMin(v, from, to) {
      var ax = cross(from, to), sn = len(ax), c = dot(from, to);
      if (sn <= 1e-14) return v.slice();
      ax = mul(ax, 1 / sn);
      var ang = Math.atan2(sn, c), ca = Math.cos(ang), sa = Math.sin(ang);
      return add(add(mul(v, ca), mul(cross(ax, v), sa)), mul(ax, dot(ax, v) * (1 - ca)));
    }
    function framesOf(pts) {
      var u = [];
      for (var k = 0; k + 1 < pts.length; k++) u.push(unit(sub(pts[k + 1], pts[k])));
      var up = Math.abs(u[0][1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      var r = [unit(sub(up, mul(u[0], dot(up, u[0]))))];
      for (var j = 1; j < u.length; j++) r.push(rotMin(r[j - 1], u[j - 1], u[j]));
      return { u: u, r: r };
    }
    function memberBuild(m) {
      var orig = memberSolid(P, m, foot), F = orig.ok && !orig.split ? framesOf(orig.points) : null;
      return function (path) {
        var seed = null;
        if (F && path.length >= 2) {
          /* the original segment the cut path rejoins: the one its second point lies on */
          var np = cleanPath(path), Qp = path[1], k = 0, bd = Infinity;
          for (var j = 0; j + 1 < orig.points.length; j++) {
            var a = orig.points[j], b = orig.points[j + 1], ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(Qp, a), ab) / Math.max(1e-18, dot(ab, ab))));
            var d = len(sub(Qp, add(a, mul(ab, t))));
            if (d < bd) { bd = d; k = j; }
          }
          if (bd < 1e-6 && np.length >= 2) seed = rotMin(F.r[k], F.u[k], unit(sub(np[1], np[0])));
        }
        var ms = memberSolid(P, m, foot, path, seed);
        if (ms.ok) ms.soup = joined(ms);
        return ms;
      };
    }
    /* A TIP UNDER THE SHEET ends in its cap (sheet()'s THE CAPS): a round
       frustum following its leg from CAP_RISE down to I1's underside, its
       flat top CAP_INTO_MM into I1 and its last CAP_BAND_MM upright; the
       column, cut along its own axis (no upright run), ends inside the cap's
       height. Its own shell, the next part after the column. */
    function capped(t, res, k) {
      if (!res || !res.ok || t.mode !== 'sheet' || !t.cap) return res;
      var c = t.cap, ph = ((GOLDEN_DEG * (k + 1)) % (360 / CAP_SIDES)) * Math.PI / 180, cw = c.w, cs = null;
      /* a flared cap (under a region plate) is narrowed until it keeps the gap to the part, as the sheet's own caps are */
      for (var ci = 0; ci < 14; ci++) {
        cs = frustumSoup(c.b[0], c.b[1], c.c[0], c.c[1], c.z0, c.z1, c.footD / 2, cw / 2, CAP_SIDES, ph, c.band);
        if (!c.flare || cw <= c.footD + 0.3 || clearance(cs, [c.c[0], c.c[1], c.z1]) >= aim) break;
        cw -= 0.25;
      }
      res.capSoup = cs;
      if (res.soups) res.soups = res.soups.concat([res.capSoup]);
      return res;
    }
    function member(m) {
      var t = byBeacon[m.beacon], build = memberBuild(m), pts = m.path;
      if (t.mode !== 'side') return capped(t, settleCut(t, build, pts, m.side, pts[0], phaseOf(m.id + 1)), m.beacon);
      /* A SIDE TIP leaves its face sideways (a lateral stub along the face's
         normal, then down). It is drawn back along that stub until its own
         solid keeps the gap - while the stub stays longer than its own mitre
         (R past the elbow): a leg shorter than that folds the sweep over
         itself (measured: 3 non-manifold edges on the clamp's 45 deg
         chamfer, where the gap wants 1.05 of a 1.4 mm stub). Past that the
         stub goes and the DROP stands straight up from the elbow toward the
         face, lowered until it keeps the gap. */
      var dir = unit(sub(pts[1], pts[0])), L01 = len(sub(pts[1], pts[0])), n = p.beacons[m.beacon].n;
      var nh = Math.hypot(n[0], n[1]), R = m.side / Math.SQRT2, room = L01 - R - 0.1;
      var tr = nh > 1e-6 ? Math.min(room, (gap + R * Math.abs(n[2])) / nh * 0.8) : 0, res = null, d = 0;
      for (var it = 0; it < 14 && tr >= 0 && tr <= room; it++) {
        res = build([add(pts[0], mul(dir, tr))].concat(pts.slice(1)));
        if (!res.ok) break;
        d = clearance(res.soup, pts[0]);
        if (d >= aim) { tipLog.push({ beacon: m.beacon, mode: 'side', retractMm: tr, clearanceMm: d }); return res; }
        tr += Math.max(0.03, (aim - d) * 1.5);
      }
      var E = pts[1], rest = pts.slice(1), up = Math.abs(n[2]) > 1e-6 ? L01 * nh / Math.abs(n[2]) : 0;
      for (var k2 = 0; k2 < 24 && up > 0.05; k2++) {
        res = build(cleanPath([[E[0], E[1], E[2] + up]].concat(rest)));
        if (res.ok) {
          d = clearance(res.soup, pts[0]);
          if (d >= aim) { tipLog.push({ beacon: m.beacon, mode: 'side-up', upMm: up, clearanceMm: d }); return res; }
        }
        up -= Math.max(0.03, (aim - (res.ok ? d : 0)) * 1.5);
      }
      var t2 = { beacon: m.beacon, mode: 'side-cut', cutZ: E[2] };
      return settleCut(t2, build, rest, m.side, pts[0], phaseOf(m.id + 1));
    }
    function stub(s) {
      var t = byBeacon[s.beacon];
      var build = function (path) {
        var r = P.sweep({ points: path.slice().reverse(), profile: squareProfile(s.side, phaseOf(p.members.length + s.beacon + 1)), up: [0, 1, 0] });
        if (r.ok) r.soup = r.tris; else r.reason = 'stub ' + s.beacon + ' would not sweep: ' + r.reason;
        return r;
      };
      return capped(t, settleCut(t, build, [s.to, s.via, s.from], s.side, s.to, phaseOf(p.members.length + s.beacon + 1)), s.beacon);
    }
    function summary() {
      return {
        gapMm: plan.gapMm, layerMm: plan.layerMm, widthMm: plan.widthMm, pitchMm: plan.pitchMm, tipSpacingMm: plan.tipSpacingMm,
        counts: plan.counts, reason: plan.reason, failed: plan.failed, tips: plan.tips, bare: plan.bare, uncarried: plan.uncarried, notes: plan.notes, tipLog: tipLog, cap: plan.cap,
        levels: plan.levels.map(function (L) {
          return { id: L.id, zTop: L.zTop, zBase: L.zBase, zCap: L.zCap, tips: L.tips, caps: L.caps, lines: L.lines,
                   minDistanceMm: L.minDistanceMm, solvedDropMm: L.solvedDropMm, stair: L.stair, held: L.held,
                   layers: L.layers.map(function (x) { return { role: x.role, angleDeg: x.angleDeg, z0: x.z0, z1: x.z1, lines: x.lines, lengthMm: x.lengthMm,
                                                                widthMm: x.widthMm, overlapMm: x.overlapMm, beads: x.beads, advanceMm: x.advanceMm, tips: x.tips,
                                                                linesMm: x.linesMm, loopMm: x.loopMm, pitchMm: x.pitchMm, minDistanceMm: x.minDistanceMm, pieces: (x.pieces || []).map(function (q) { return { kind: q.kind, sizeMm: q.sizeMm, areaMm2: q.areaMm2, perimMm: q.perimMm, caps: q.caps, lines: q.lines }; }), shortestMm: x.shortestMm, paths: x.paths }; }) };
        })
      };
    }
    return { ok: true, plan: plan, byBeacon: byBeacon, member: member, stub: stub, summary: summary };
  }

  /* The parts of every trunk, in union order: the landing member, then up
     the tree breadth first, each member's pickup stubs right after it, the
     resting pad right after the root, gecko fingers last. */
  function trunkStepper(p, opts) {
    var P = PS(opts), T = ST(opts), A = SA(opts);
    if (!P || typeof P.sweep !== 'function') return { ok: false, reason: 'nso_path_sweep.js is not loaded' };
    var probe = makeProbe(A, [opts.rawTris || []].concat(opts.occluders || []));
    var foot = opts.footPads === false ? 0 : (opts.firstLayerMm == null ? FOOT_LAYER_MM : +opts.firstLayerMm);
    /* opts.footPads 'shared': every trunk stands on its foot as usual, but no
       pad is drawn here - the caller draws them over several plans at once
       (shareFeet, the Supports card's areas) from tp.feet */
    var shared = opts.footPads === 'shared';
    /* TRUNKS: on the card's build (the sheet's), every trunk on a foot gets
       its round trunk; opts.trunkGrowth false (or true) says otherwise */
    var grow = !!foot && (opts.trunkGrowth != null ? !!opts.trunkGrowth : !!opts.interface);
    var out = [], placed = [], droppedFingers = 0, shafts = [], feet = [];
    /* THE SHEET (opts.interface): every tip that meets the part is cut flat
       under nso_support_interface.js's sheet, or cut at the gap line, or (a
       side tip) drawn back off its face until the gap holds. */
    var sh = null;
    if (opts.interface) {
      sh = sheetFor(p, opts, foot);
      if (!sh.ok) return { ok: false, reason: 'the interface sheet: ' + sh.reason };
    }
    /* Every contact's shaft near its tip, for the fingers to keep clear of. */
    if (p.style === 'gecko-hand' && !sh) {
      p.members.forEach(function (m) {
        if (m.dead || m.beacon == null || m.path.length < 2) return;
        var d = unit(sub(m.path[1], m.path[0]));
        shafts.push({ beacon: m.beacon, a: m.path[0], b: add(m.path[0], mul(d, 3)), r: m.side / Math.SQRT2 });
      });
      p.stubs.forEach(function (st) { shafts.push({ beacon: st.beacon, a: st.to, b: st.via, r: st.side / Math.SQRT2 }); });
    }
    /* One trunk's parts: null once swept, { ok: false, reason } when a member
       would not sweep. */
    /* A TIP A STAIR HOLDS (sheet()'s THE STAIR: mode 'drop') is not built,
       and neither is a member that holds only such tips, nor a stub to one */
    function dropped(b) { return !!(sh && b != null && sh.byBeacon[b] && sh.byBeacon[b].mode === 'drop'); }
    function leftOut(m) { return !!(sh && m.beacons && m.beacons.length && m.beacons.every(dropped)); }
    /* A trunk's record for growTrunks (TRUNKS): H, the top of what it holds
       up - its highest tip, the top of the sheet or stair a tip of it is
       under, or (a stair's own tree) opts.trunkTopMm - and its stem's top:
       from the landing member up through the parent holding most of its
       tips (the lower id on a tie) while that parent holds TRUNK_SHARE of them */
    function stemOf(tr, root) {
      var live = function (m) { return m.beacons.filter(function (b) { return !dropped(b); }).length; };
      var H = opts.trunkTopMm != null ? +opts.trunkTopMm : -Infinity, n = live(root), cur = root;
      tr.beacons.forEach(function (b) {
        if (dropped(b)) return;
        H = Math.max(H, p.beacons[b].p[2]);
        var st = sh && sh.byBeacon[b];
        if (st && st.mode === 'sheet' && st.zTop != null) H = Math.max(H, st.zTop);
      });
      for (;;) {
        var best = null, bc = -1;
        cur.parents.forEach(function (id) {
          var q = p.members[id];
          if (q.dead || leftOut(q)) return;
          var c = live(q);
          if (c > bc || (c === bc && id < best.id)) { bc = c; best = q; }
        });
        if (!best || bc < TRUNK_SHARE * n) break;
        cur = best;
      }
      var top = cur.path[0][2] + (cur.kind === 'merge' || cur.kind === 'pickup' ? cur.side / 2 : 0);
      var rec = { H: H, top: top, side: root.side, tips: null };
      if (p.knobs) rec.law = { tipMm: p.knobs.trunkTipMm, angleDeg: p.knobs.trunkAngleDeg };   /* the knobs' law rides with the foot: growTrunks and shareFeet read it from there */
      return rec;
    }
    /* A TRUNK'S LANDING, KEPT OFF THE PART (supports-stair-body): its
       flared foot - the law's outer radius at the plate - stands
       TRUNK_FOOT_CLEAR_MM off the part on the first layer, as Bambu's
       does, and from there up to its stem's top the law fits TRUNK_KEEP_MM
       off it everywhere, so the trunk flares to its full width. A landing
       that does not is moved: the landing member's drop leans from the
       point it falls from to the nearest point (RELAND_STEP_MM apart, in
       RELAND_HEADINGS directions, no further than the plan's branch lean
       allows from that height) where the trunk fits and the leaning leg is
       clear. None found: it lands as planned (and growTrunks narrows it). */
    var relanded = [], landProbes = null;
    function reland(m, g) {
      var e = m.path[m.path.length - 1], from = m.path.length > 1 ? m.path[m.path.length - 2] : null;
      if (!from || !(e[2] <= p.plateZ + 1e-9)) return null;
      var THr = TM(opts);
      if (!THr) return null;
      if (!landProbes) landProbes = [opts.rawTris || []].concat(opts.occluders || []).filter(function (sp) { return sp && sp.length >= 9; })
        .map(function (sp) { return probeOf(THr, sp); }).filter(Boolean);
      var tb = Math.tan(FLARE_ANGLE_DEG * Math.PI / 180), cosN = Math.cos(Math.PI / TRUNK_SIDES);
      var tipMm = g.law ? g.law.tipMm : TRUNK_TIP_MM, ta = Math.tan((g.law ? g.law.angleDeg : TRUNK_ANGLE_DEG) * Math.PI / 180);
      var z0 = p.plateZ + foot / 2, zf = p.plateZ + FLARE_MM, top = Math.min(g.top, from[2]);
      var law = function (z) { return tipMm / 2 + ta * Math.max(0, g.H - z) + flareAt(z, zf, tb, FLARE_MM); };
      var zs = [];
      for (var z = z0; z < top - 1e-9; z += 2 * TRUNK_STEP_MM) zs.push(z);
      function fits(c) {
        for (var k = 0; k < zs.length; k++) {
          var zz = zs[k], need = law(zz) / cosN + (zz <= p.plateZ + foot + 1e-9 ? (p.footClearMm != null ? p.footClearMm : TRUNK_FOOT_CLEAR_MM) + RELAND_SLACK_MM : TRUNK_KEEP_MM);
          for (var q = 0; q < landProbes.length; q++) {
            var P0 = landProbes[q];
            if (P0.inside && P0.inside([c[0], c[1], zz])) return false;
            var hit = P0.nearest([c[0], c[1], zz], need + 0.01);
            if (hit && hit.dist < need) return false;
          }
        }
        return true;
      }
      if (fits(e)) return null;
      var sMax = (from[2] - p.plateZ) * Math.tan((p.branchTiltDeg || 30) * Math.PI / 180);
      for (var sd = RELAND_STEP_MM; sd <= sMax + 1e-9; sd += RELAND_STEP_MM) {
        for (var hh = 0; hh < RELAND_HEADINGS; hh++) {
          var th = 2 * Math.PI * hh / RELAND_HEADINGS, W = [e[0] + sd * Math.cos(th), e[1] + sd * Math.sin(th), e[2]];
          if (probe.leg(from, W, m.side, 0, 0) >= 0) continue;
          if (!fits(W)) continue;
          return { path: m.path.slice(0, -1).concat([W]), from: e.slice(), to: W, mm: sd };
        }
      }
      return null;
    }
    /* A CROWN (CROWNS): one tree to one circle. Its tips are built as every tip is (the column, cut at the cap or the gap);
       a branch is round tubes along its path, a ball at each join; its trunk is the oval body growTrunks makes on its foot
       (the card's build, and shareFeet) or, with no growth, a plain oval of the law. Nothing else of the tree changes. */
    function tipTopOf(tr) {
      var H = opts.trunkTopMm != null ? +opts.trunkTopMm : -Infinity;
      tr.beacons.forEach(function (b) {
        if (dropped(b)) return;
        H = Math.max(H, p.beacons[b].p[2]);
        var st = sh && sh.byBeacon[b];
        if (st && st.mode === 'sheet' && st.zTop != null) H = Math.max(H, st.zTop);
      });
      return H;
    }
    function crownPhase(k, n) { return ((GOLDEN_DEG * (k + 1)) % (360 / n)) * Math.PI / 180; }
    function stepCrown(t, tr, plain) {
      var parts = [], ci = tr.crown, cr = p.crowns[ci], TS = (p.crownKnobs && p.crownKnobs.tubeSides) || CROWN_TUBE_SIDES;
      var CKn = p.crownKnobs || {}, smooth = CKn.smooth !== false && !plain, prims = [];
      var rootM = p.members[tr.root], rootKids = {};
      rootM.parents.forEach(function (id) { rootKids[id] = true; });
      for (var i = 0; i < tr.members.length; i++) {
        var m = p.members[tr.members[i]];
        if (leftOut(m)) continue;
        if (m.id === tr.root) continue;
        if (m.blocked) continue;            /* its way is through the piece: not built (plan.blocked says which, and what it holds) */
        if (m.beacon != null) {
          m.crownRound = smooth ? m.side / Math.sqrt(Math.PI) : 0;      /* round, of the square's area */
          var ms = sh && sh.byBeacon[m.beacon] ? sh.member(m) : memberSolid(P, m, foot);
          if (!ms.ok) return { ok: false, reason: ms.reason };
          m.points = ms.points;
          var twig = smooth && opts._stairTree && ms.round;     /* a stair's tip is a twig of the smooth body: no exact post, no flat stub end */
          if (!twig) parts = parts.concat(ms.soups.map(function (x) { return { soup: x }; }));
          if (ms.round && ms.points.length >= 2) {
            /* its whole post and leg, from its stub's top to its join: a primitive of the crown's body, cut flat a little under the stub's top and a hair
               thinner along the stub (the stub's own surface is the one seen there); the bend where the post leans into its leg is a round joint of the same
               radius, so the post runs into the leg with no crease */
            var rt = m.crownRound, st0 = ms.points[0], st1 = ms.points[1], su = unit(sub(st0, st1)), sl = len(sub(st0, st1));
            var lp = ms.points.map(function (q) { return q.slice(); });
            if (twig) {
              /* the twig narrows to the tip and dies a hair into the strip over it: its top is cut flat there, its radius running from the tip's down to the leg's
                 at the bend, so the post is a taper of the branch it leaves, not a cylinder stood on it */
              var rTip = Math.max(0.4, 0.62 * rt), hair = 0.18;
              var tw = [add(st0, mul(su, hair))], rr = [rTip];
              for (var qi = 1; qi < lp.length; qi++) { tw.push(lp[qi]); rr.push(rt); }
              prims.push({ pts: tw, r: rr, clip: { p: add(st0, mul(su, hair)), n: su } });
            } else
            prims.push({ pts: lp, r: lp.map(function (q, qi) { return qi === 0 ? rt - 0.04 : rt; }), clip: { p: add(st0, mul(su, -Math.min(0.3, sl * 0.5))), n: su } });
          }
          continue;
        }
        var pts = m.path, R = m.radii;
        m.points = pts.map(function (q) { return q.slice(); });
        if (smooth) {
          var bp = pts.map(function (q) { return q.slice(); }), bn = bp.length;
          if (rootKids[m.id]) bp[bn - 1] = add(bp[bn - 1], mul(unit(sub(bp[bn - 1], bp[bn - 2])), R[bn - 1]));
          prims.push({ pts: bp, r: R.slice() });
          continue;
        }
        parts.push({ soup: ballSoup(pts[0], R[0], TS, crownPhase(m.id, TS)) });
        for (var s = 0; s + 1 < pts.length; s++) {
          var a = pts[s], b = pts[s + 1];
          /* a branch off the trunk runs on into it by its own radius: it ends inside the trunk's body, not on its face */
          if (s + 2 === pts.length && rootKids[m.id]) b = add(b, mul(unit(sub(b, a)), R[s + 1]));
          parts.push({ soup: tubeSoup(a, R[s], b, R[s + 1], TS, crownPhase(m.id + 3 * s + 1, TS)) });
          if (s + 2 < pts.length) parts.push({ soup: ballSoup(pts[s + 1], R[s + 1], TS, crownPhase(m.id + 3 * s + 2, TS)) });
        }
      }
      if (smooth && prims.length) {
        /* the trunk's top, a shoulder the branches rise out of: a capsule on its axis, as wide as the trunk is there, its dome standing a little over the top */
        var LWs = rootM.oval && rootM.oval.law, ax = rootM.path[0], zt = ax[2], rTr;
        if (LWs) {
          var Hs = LWs.uniformH != null ? p.plateZ + LWs.uniformH : tipTopOf(tr), tas = Math.tan(LWs.angleDeg * Math.PI / 180);
          rTr = function (z) { return LWs.tipMm / 2 + tas * Math.max(0, Hs - z) + (rootM.oval.dR || 0); };
        } else rTr = function () { return rootM.side / 2; };
        var rTop = rTr(zt);
        var zSh = Math.max(zt - 3, p.plateZ + 0.5 * rTop);        /* a join that a lean limit brought down to the flare: its shoulder starts above the plate */
        prims.push({ pts: [[ax[0], ax[1], zSh], [ax[0], ax[1], Math.max(zSh + 0.2, zt - 0.65 * rTop)]], r: [rTr(zSh), rTr(Math.max(zSh + 0.2, zt - 0.65 * rTop))] });
        var THc = TM(opts), keepR = TRUNK_KEEP_MM + 0.05, probesC = THc ? [opts.rawTris || []].concat(opts.occluders || []).filter(function (sp) { return sp && sp.length >= 9; })
          .map(function (sp) { return probeOf(THc, sp); }).filter(Boolean) : [];
        var cutB = { zMax: opts._clipZ != null ? opts._clipZ : null, zMin: p.plateZ, keep: keepR,
          away: probesC.length ? function (x, y, z) { var d = Infinity; for (var q = 0; q < probesC.length; q++) { var hit = probesC[q].nearest([x, y, z], keepR + 0.3); if (hit && hit.dist < d) d = hit.dist; } return d; } : null };
        var blob = blobSoup(prims, CKn.blendMm || CROWN_BLEND_MM, CKn.blobCellMm || CROWN_BLOB_CELL_MM, cutB);
        if (!blob.length) return stepCrown(t, tr, true);          /* a body no mesher could make closed: the crown is built the old way, balls and tubes */
        parts.push({ soup: blob, smooth: true });
      }
      /* the trunk: its foot, and (growTrunks) its body */
      if (foot && tr.landing === 'plate' && !(opts._graft && opts._graft[cr.zone] != null)) {
        var A0 = rootM.path[0], H = tipTopOf(tr), LW = rootM.oval.law || { tipMm: TRUNK_TIP_MM, angleDeg: TRUNK_ANGLE_DEG, flareMm: FLARE_MM, flareAngleDeg: FLARE_ANGLE_DEG };
        var Hlaw = LW.uniformH != null ? p.plateZ + LW.uniformH : H;
        var zTr = A0[2] - (smooth && prims.length ? CROWN_TRUNK_SINK_MM : 0);   /* the exact trunk stops a little under its top: the crown's smooth body is the shoulder over it */
        var gw = { H: H, top: zTr, side: rootM.side, tips: null, crown: { ang: rootM.oval.ang, k: rootM.oval.k, dR: rootM.oval.dR, law: LW } };
        var aBase = LW.tipMm / 2 + Math.tan(LW.angleDeg * Math.PI / 180) * Math.max(0, Hlaw - p.plateZ) + Math.tan(LW.flareAngleDeg * Math.PI / 180) * LW.flareMm + rootM.oval.dR;
        var ft = { key: t, trunk: t, c: [A0[0], A0[1]], r: aBase * Math.sqrt(rootM.oval.k) / Math.cos(Math.PI / TRUNK_SIDES) };
        if (grow) ft.grow = gw;
        else {
          var lawF = function (z) { return LW.tipMm / 2 + Math.tan(LW.angleDeg * Math.PI / 180) * Math.max(0, Hlaw - z) + flareAt(z, p.plateZ + LW.flareMm, Math.tan(LW.flareAngleDeg * Math.PI / 180), LW.flareMm) + rootM.oval.dR; };
          var cN = Math.cos(Math.PI / TRUNK_SIDES), kq = Math.sqrt(rootM.oval.k), zz0 = p.plateZ + foot / 2, rg = ringZs(zz0, p.plateZ + LW.flareMm, zTr);
          parts.push({ soup: revolveSoup(A0[0], A0[1], rg.map(function (z) { return [z, lawF(z) * kq / cN, lawF(z) / kq / cN]; }), TRUNK_SIDES, crownPhase(t, TRUNK_SIDES), rootM.oval.ang), trunkShell: true });
        }
        feet.push(ft);
      }
      out.push({ trunk: t, parts: parts, fingerParts: [], fingers: 0 });
      return null;
    }
    function step(t) {
      var tr = p.trunks[t], parts = [], fingers = [];
      if (tr.crown != null) return stepCrown(t, tr);
      for (var i = 0; i < tr.members.length; i++) {
        var m = p.members[tr.members[i]];
        if (leftOut(m)) continue;
        /* THE LANDING (TRUNKS): a trunk whose foot the part would stand
           nearer than Bambu's lands further off it */
        var landed = null, gw = null;
        if (grow && foot && i === 0 && tr.landing === 'plate') {
          gw = stemOf(tr, m);
          if (m.beacon == null) landed = reland(m, gw);
        }
        var ms = landed ? memberSolid(P, m, foot, landed.path)
          : sh && m.beacon != null && sh.byBeacon[m.beacon] ? sh.member(m) : memberSolid(P, m, foot);
        if (!ms.ok) return { ok: false, reason: ms.reason };
        m.points = ms.points;
        parts = parts.concat(ms.soups.map(function (x) { return { soup: x }; }));
        if (foot && i === 0 && tr.landing === 'plate') {
          /* The foot: where the trunk stands, its own end square - the pads
             are drawn over every foot at once, in finish() (FEET) */
          var fp0 = footprintOf(ms.points[ms.points.length - 1], m.side);
          var ft = { key: t, trunk: t, c: fp0.c, r: fp0.r };
          if (grow) ft.grow = gw;
          if (landed) relanded.push({ trunk: t, from: landed.from, to: landed.to, mm: landed.mm, why: landed.why });
          feet.push(ft);
        }
        if (m.pad) {
          var h = Math.max(2 * m.side, 2.82) / 2, a = m.path[m.path.length - 1];
          parts.push({ soup: boxSoup([a[0] - h, a[1] - h, m.pad.z0], [a[0] + h, a[1] + h, m.pad.z1]) });
        }
        p.stubs.forEach(function (s) {
          if (s.member !== m.id || dropped(s.beacon)) return;
          /* Started AT the pickup point: it lies on the column's axis, inside
             both the column it leaves and the one below, and is no vertex of
             either. Run back a quarter side instead, the stub's start landed
             within 0.2 mm of the parent column's run-on end, and the union
             pinched there (2 non-manifold edges on a box tilted 30 deg). */
          var sw = sh && sh.byBeacon[s.beacon] ? sh.stub(s)
            : P.sweep({ points: [s.from, s.via, s.to], profile: squareProfile(s.side, phaseOf(p.members.length + s.beacon + 1)), up: [0, 1, 0] });
          if (sw.ok) {
            parts.push({ soup: sw.tris, stub: true }); s.soup = sw.tris;
            if (sw.capSoup) parts.push({ soup: sw.capSoup, cap: true });
          }
        });
        if (p.style === 'gecko-hand' && T && T._geckoHand && !sh) {
          var tips = [];
          if (m.beacon != null) {
            var pts = ms.points, dir = unit(sub(pts[0], pts[1]));
            tips.push({ end: pts[0], dir: dir, n: p.beacons[m.beacon].n, beacon: m.beacon });
          }
          p.stubs.forEach(function (s) { if (s.member === m.id) tips.push({ end: s.to, dir: unit(sub(s.to, s.via)), n: p.beacons[s.beacon].n, beacon: s.beacon }); });
          tips.forEach(function (tp) {
            /* At the planning side, as the old tree kept it: a hand sized to
               a fatter strut reaches into its neighbours' and closes loops. */
            var hand = T._geckoHand(tp.end, tp.dir, p.handSideMm, { normal: tp.n, floorMm: p.floorMm, pathSweep: P });
            if (!hand.ok) return;
            hand.fingers.forEach(function (f) {
              /* the finger's own hexagon (circumradius width / sqrt 3), no
                 extra clearance: it lies along the face by design, as the
                 old tree's clearFingers tested it */
              if (probe.leg(f.from, f.to, hand.widthMm * Math.SQRT2 / Math.sqrt(3), 0, hand.widthMm, 0) >= 0) return;
              /* and clear of every OTHER hand: two hands that touch close a
                 loop through the support (measured: 2 handles on the tall arm
                 where tips were moved off the post) */
              var gap = 2 * hand.widthMm / Math.sqrt(3) + CLEAR_MM;
              for (var q = 0; q < placed.length; q++) {
                if (placed[q].tip !== tp && segDist(f.from, f.to, placed[q].a, placed[q].b) < gap) { droppedFingers++; return; }
              }
              for (q = 0; q < shafts.length; q++) {
                if (shafts[q].beacon !== tp.beacon &&
                    segDist(f.from, f.to, shafts[q].a, shafts[q].b) < hand.widthMm / Math.sqrt(3) + shafts[q].r + CLEAR_MM) { droppedFingers++; return; }
              }
              placed.push({ tip: tp, a: f.from, b: f.to });
              fingers.push({ soup: f.soup, optional: true });
            });
          });
        }
      }
      out.push({ trunk: t, parts: parts, fingerParts: fingers, fingers: fingers.length });
      return null;
    }
    function finish() {
      /* THE STAIR'S TREE (sheet()'s THE STAIR): the tips each strip's leading
         part wants, planned as a tree of their own - a beacon on each strip's
         underside, the piece the obstacle (a column 1.2 mm across meets the
         strips under its own: support on support, one support) - and built
         as trunks after the plan's, standing on feet with them. Its trunks
         hold no spot of the card's; each is joined to its stair. */
      var stairTrunks = [], stairOf = {}, stairLog = [];
      if (sh) sh.plan.levels.forEach(function (L) {
        if (!L.stair || !L.stair.tips || !L.stair.tips.length) return;
        /* a row of posts that climb the slope is held by a leg every STAIR_LEG_MM (sheet()'s THE LEGS): the tips with a leg are the tree's beacons;
           the others are round posts standing on their row, built below - the row is one blade, its legs the tree's */
        var legTips = L.stair.tips.filter(function (w) { return w.leg !== false; }), fillTips = L.stair.tips.filter(function (w) { return w.leg === false; });
        var p2o = Object.assign({}, opts, {
          beacons: legTips.map(function (w, i) { return { p: w.p, n: [0, 0, -1], key: 'stair' + L.id + '.' + i }; }),
          skipList: [], style: p.style, sideMm: p.sideMm, restOnModel: false, mergeThroughCrowd: true, _stairTree: true,
          interface: false, onProgress: null, _knobs: p.knobs ? { given: p.knobs.given } : null });
        /* a custom plan's stair is carried the way its tips are: one tree to a circle, on the circles' own feed. Where a
           circle's own tree is built, the stair's trunk stands on its axis (one trunk, as far as the part lets it) */
        var graftHost = {};
        if (p.crowns && p.feedZones) {
          var axes = {};
          p.crowns.forEach(function (c) { if (c.trunk != null && !leftOut(p.members[p.trunks[c.trunk].root])) { axes[c.zone] = c.axis; graftHost[c.zone] = c.trunk; } });
          p2o._feed = { mode: 'custom', tips: [], off: {}, exSet: {}, excluded: [], zones: p.feedZones };
          var graft = {};
          Object.keys(axes).forEach(function (zk) { var hc = p.crowns.filter(function (c) { return c.zone === +zk; })[0]; graft[zk] = { axis: axes[zk], ang: hc.oval.angDeg * Math.PI / 180 }; });
          p2o.crown = p.crownKnobs; p2o.branchTiltDeg = p.branchTiltDeg;
          p2o._stairBeacons = true; p2o._axes = axes; p2o._graft = graft; p2o._keepOut = null;
        }
        var p2 = plan(opts.rawTris, p2o);
        if (!p2.ok) { stairLog.push({ level: L.id, wanted: L.stair.tips.length, held: 0, reason: p2.reason }); return; }
        var sp2 = trunkStepper(p2, Object.assign({}, opts, { interface: false, footPads: 'shared', onProgress: null, trunkGrowth: grow, trunkTopMm: L.zTop, _clipZ: L.zTop, _graft: p2o._graft || null, _stairTree: true }));
        if (!sp2.ok) { stairLog.push({ level: L.id, wanted: L.stair.tips.length, held: 0, reason: sp2.reason }); return; }
        for (var t2 = 0; t2 < sp2.n; t2++) { var r2 = sp2.step(t2); if (r2) { stairLog.push({ level: L.id, reason: r2.reason }); return; } }
        var f2 = sp2.finish(), tmap = {};
        if (fillTips.length && f2.trunks.length) {
          var rPost = p.sideMm / Math.sqrt(Math.PI), rise = (p.crownKnobs && p.crownKnobs.tipRiseMm) || 2.6;
          fillTips.forEach(function (w, i) {
            f2.trunks[0].parts.push({ soup: tubeSoup([w.p[0], w.p[1], w.p[2] - rise], rPost, w.p.slice(), rPost, CROWN_STUB_SIDES, crownPhase(i + 1000, CROWN_STUB_SIDES)), stairPost: true });
          });
        }
        f2.trunks.forEach(function (x) {
          var tr2 = p2.trunks[x.trunk], zc = tr2.crown != null && p2.crowns ? p2.crowns[tr2.crown] : null;
          var host = zc && graftHost[zc.zone] != null ? graftHost[zc.zone] : null;
          if (host != null) {
            /* GRAFTED (a custom plan): the stair's branches join the circle's own trunk - one trunk to a circle. Its
               top branches enter the trunk where they are going, and the trunk is as wide as both asked for. */
            var he = out.filter(function (o) { return o.trunk === host; })[0], hf = feet.filter(function (f) { return f.trunk === host; })[0];
            he.parts = he.parts.concat(x.parts.map(function (q) { return q.sheet || q.smooth || !q.soup ? q : Object.assign({}, q, { soup: clipConvexBelow(q.soup, L.zTop) }); }));
            if (hf && hf.grow && hf.grow.crown) {
              var cH = p.crowns[p.trunks[host].crown], g2 = hf.grow.crown;
              g2.areaR2 = (g2.areaR2 == null ? cH.rNeed * cH.rNeed : g2.areaR2) + zc.rNeed * zc.rNeed;
              if (g2.law && g2.law.uniformH != null) g2.dR = 0; else g2.dR = Math.max(g2.dR, Math.sqrt(g2.areaR2) - cH.lawTop);
              g2.k = Math.max(g2.k, zc.oval.k);
              hf.grow.H = Math.max(hf.grow.H, L.zTop);
            }
            if ((stairOf[L.id] = stairOf[L.id] || []).indexOf(host) < 0) stairOf[L.id].push(host);
            return;
          }
          var T = p.trunks.length + stairTrunks.length;
          tmap[x.trunk] = T;
          out.push({ trunk: T, parts: x.parts.map(function (q) { return q.sheet || q.smooth || !q.soup ? q : Object.assign({}, q, { soup: clipConvexBelow(q.soup, L.zTop) }); }), fingerParts: [], fingers: 0 });
          /* path and pts: what members() names it by, and which of the stair's spots it carries */
          stairTrunks.push({ beacons: [], landing: tr2.landing, stair: L.id,
                             path: p2.members[tr2.root].path.map(function (q) { return q.slice(); }),
                             pts: tr2.beacons.map(function (b) { return p2.beacons[b].p.slice(); }) });
          (stairOf[L.id] = stairOf[L.id] || []).push(T);
        });
        f2.feet.forEach(function (f) { if (tmap[f.trunk] != null) feet.push({ key: tmap[f.trunk], trunk: tmap[f.trunk], c: f.c, r: f.r, grow: f.grow }); });
        (f2.relanded || []).forEach(function (r) { if (tmap[r.trunk] != null) relanded.push({ trunk: tmap[r.trunk], from: r.from, to: r.to, mm: r.mm, stair: L.id }); });
        stairLog.push({ level: L.id, wanted: L.stair.tips.length, held: (p2.held != null ? p2.held : legTips.length - p2.unreachable.length) + fillTips.length,
                        unreachable: p2.unreachable.length, trunks: p2.trunks.length, members: p2.members.filter(function (m) { return !m.dead; }).length,
                        maxLeanDeg: p2.members.reduce(function (mx, m) {
                          if (m.dead || !m.path) return mx;
                          for (var qi = 0; qi + 1 < m.path.length; qi++) { var dz = Math.abs(m.path[qi + 1][2] - m.path[qi][2]), dh = Math.hypot(m.path[qi + 1][0] - m.path[qi][0], m.path[qi + 1][1] - m.path[qi][1]); if (dz + dh > 1.5) mx = Math.max(mx, Math.atan2(dh, dz) * 180 / Math.PI); }
                          return mx;
                        }, 0) });
      });
      /* THE TRUNKS: every built tip, the plan's and the stair trees', is
         one the trunks end under (here, and in shareFeet() over every area) */
      var trunks = [];
      if (grow) {
        var tipZones = [];
        p.trunks.forEach(function (tr) {
          tr.members.forEach(function (id) {
            var m = p.members[id];
            if (m.beacon != null && !leftOut(m) && !dropped(m.beacon)) tipZones.push(m.path[0].slice());
          });
        });
        var inTrunk = {};
        p.trunks.forEach(function (tr) { tr.members.forEach(function (id) { inTrunk[id] = true; }); });
        p.stubs.forEach(function (s) { if (inTrunk[s.member] && !dropped(s.beacon)) tipZones.push(s.to.slice()); });
        if (sh) sh.plan.levels.forEach(function (L) { ((L.stair && L.stair.tips) || []).forEach(function (w) { tipZones.push(w.p.slice()); }); });
        feet.forEach(function (f) { if (f.grow) f.grow.tips = tipZones; });
      }
      if (grow && feet.length && !shared) {
        var THg = TM(opts);
        if (!THg) return { ok: false, reason: 'nso_thickness.js is not loaded - the trunks keep off the piece with its probe' };
        var obsG = [opts.rawTris || []].concat(opts.occluders || []).filter(function (s) { return s && s.length >= 9; });
        /* the knobs' law only (the plan is the default's): the same feet under the default law, to tell what the law broke from what is not built today */
        var nd = p.knobs ? p.knobs.nonDefault : null, byLaw = nd && (nd.trunkTipMm != null || nd.trunkAngleDeg != null) && nd.leanDeg == null && nd.nodeMm == null;
        var feet0 = byLaw ? feet.map(function (f) { var q = { key: f.key, trunk: f.trunk, c: f.c.slice(), r: f.r }; if (f.grow) { q.grow = Object.assign({}, f.grow); delete q.grow.law; } return q; }) : null;
        trunks = growTrunks(THg, obsG, feet, p.plateZ, foot);
        if (p.knobs) {
          var lost = feet.map(function (f, i) { return i; }).filter(function (i) { return feet[i].grown && feet[i].grown.why; });
          /* no knob that moves the plan: what the default law builds is today's, and no problem of the knobs' */
          if (feet0 && lost.length) { growTrunks(THg, obsG, feet0, p.plateZ, foot); lost = lost.filter(function (i) { return !(feet0[i].grown && feet0[i].grown.why); }); }
          else if (!nd || !Object.keys(nd).length) lost = [];
          if (lost.length) {
            var why = {};
            lost.forEach(function (i) { (why[feet[i].grown.why] = why[feet[i].grown.why] || []).push(feet[i].grown.c.map(fmt2).join(',')); });
            knobProblem(p, 'trunk', null, lost.length + ' of ' + feet.length + ' trunk(s) not built' + (feet0 ? ' that the default law builds' : ' (not compared with the default plan\'s, which leaves some unbuilt too)') + ': ' +
              Object.keys(why).map(function (w) {
                return w + ' (' + why[w].slice(0, 3).join('; ') + (why[w].length > 3 ? '; ...' : '') + ')';
              }).join(', '), lost.length);
          }
        }
        feet.forEach(function (f) { if (f.shell) out[f.key].parts.push({ soup: f.shell, trunkShell: true }); });
      }
      /* THE PADS (FEET): one per group of feet, each the first part of the
         lowest trunk standing on it - the others join it through the pad */
      var pads = { count: 0, clusters: 0, clustersSplit: 0, hemmed: 0, padsDropped: 0, holesFilled: 0, holesSlotted: 0, shared: shared }, padGroups = [];
      if (foot && feet.length && !shared) {
        var TH = TM(opts);
        if (!TH) return { ok: false, reason: 'nso_thickness.js is not loaded - the foot pads are drawn with its probe' };
        var fp = footPads(TH, [opts.rawTris || []].concat(opts.occluders || []).filter(function (s) { return s && s.length >= 9; }), feet, p.plateZ, foot);
        if (fp.failed.length) return { ok: false, reason: 'the feet: ' + fp.failed[0] };
        fp.pads.forEach(function (pd) {
          var keys = pd.keys.slice().sort(function (a, b) { return a - b; });
          out[keys[0]].parts.push({ soup: pd.soup, foot: true, pad: true, keys: keys });
        });
        /* the trunks of one support: on one pad, or on pads too near to print apart */
        fp.groups.forEach(function (g) { if (g.length > 1) padGroups.push(g.slice().sort(function (a, b) { return a - b; })); });
        pads = { count: fp.pads.length, clusters: fp.clusters.length, clustersSplit: fp.clustersSplit, clustersHemmed: fp.clustersHemmed, hemmed: fp.hemmed, padsDropped: fp.padsDropped, holesFilled: fp.holesFilled,
                 holesSlotted: fp.holesSlotted, cellMm: fp.cellMm, shared: false,
                 areasMm2: fp.pads.map(function (pd) { return pd.areaMm2; }), outlines: fp.pads.map(function (pd) { return pd.poly; }) };
      }
      out.forEach(function (o) { o.parts = o.parts.concat(o.fingerParts); delete o.fingerParts; });
      /* Each sheet is one more entry, its layers in order: weld() folds
         them into one solid and joins it to the trunks it stands on. */
      if (sh) {
        sh.plan.levels.forEach(function (L) {
          /* the trunks that carry its tips: what it is joined to */
          var carriers = [];
          /* a stair is joined to the trunks it holds by itself as well: their spots are its */
          L.tips.concat(L.held || []).forEach(function (ti) {
            var b = sh.plan.tips[ti].beacon;
            p.trunks.forEach(function (tr, k) { if (tr.beacons.indexOf(b) >= 0 && carriers.indexOf(k) < 0) carriers.push(k); });
          });
          (stairOf[L.id] || []).forEach(function (T) { carriers.push(T); });
          out.push({ trunk: -1, sheet: L.id, carriers: carriers, tips: L.tips.concat(L.held || []).map(function (ti) { return sh.plan.tips[ti].beacon; }),
                     parts: L.layers.map(function (x) { return { soup: x.soup, sheet: true }; }), fingers: 0 });
        });
      }
      var summ = sh ? sh.summary() : null;
      if (summ) summ.stairTrees = stairLog;
      return { ok: true, trunks: out, fingersDropped: droppedFingers, pads: pads, padGroups: padGroups, stairTrunks: stairTrunks,
               feet: feet.map(function (f) { return f.grow ? { trunk: f.trunk, c: f.c, r: f.r, grow: f.grow } : { trunk: f.trunk, c: f.c, r: f.r }; }),
               trunkShells: trunks, sheet: summ, relanded: relanded };
    }
    return { ok: true, n: p.trunks.length, step: step, finish: finish };
  }
  /* A trunk of the plan, or of a stair's own tree (numbered after the plan's) */
  function trunkOf(p, tp, t) { return p.trunks[t] || ((tp && tp.stairTrunks) || [])[t - p.trunks.length]; }
  /* The parts of every trunk at once - the sync path solid() has always taken. */
  function trunkParts(p, opts) {
    var sp = trunkStepper(p, opts);
    if (!sp.ok) return sp;
    for (var t = 0; t < sp.n; t++) {
      var r = sp.step(t);
      if (r) return r;
    }
    return sp.finish();
  }

  /* Promise of { ok, soup, solids, reason }. One solid per landed trunk;
     trunks that touch are joined into one.

     Each trunk is folded left through NSO_unionSoups in trunkParts' order.
     A gecko finger that does not reach the shaft it was grown from is left
     off and counted (it is the tip's shape, not its support). A structural
     part that does not touch is kept beside the rest, as its own shell, and
     counted in `detached` - it is never silently dropped. */
  function solid(p, opts) {
    opts = opts || {};
    if (!p || !p.ok) return Promise.resolve({ ok: false, reason: (p && p.reason) || 'no plan' });
    if (!p.trunks.length) return Promise.resolve({ ok: true, soup: new Float32Array(0), solids: [], reason: p.reason });
    var tp = trunkParts(p, Object.assign({}, opts, { rawTris: opts.rawTris || p.rawTris, occluders: opts.occluders || p.occluders }));
    if (!tp.ok) return Promise.resolve({ ok: false, reason: tp.reason });
    return weld(p, tp, opts);
  }

  /* Promise of the trunks' parts (trunkParts' result): the BUILDING half of
     solid(), a trunk at a time, with opts.onProgress told 'building', units
     done / buildUnits(p, opts) - the sheet's tips as sheet() settles them,
     then the trunks as they are swept - and opts.yieldFn given a turn between
     trunks. Resolves { ok: false, reason } when a member would not sweep. */
  function parts(p, opts) {
    opts = opts || {};
    if (!p || !p.ok) return Promise.resolve({ ok: false, reason: (p && p.reason) || 'no plan' });
    if (!p.trunks.length) return Promise.resolve({ ok: true, trunks: [], fingersDropped: 0, pads: { count: 0, clusters: 0, clustersSplit: 0, hemmed: 0, holesFilled: 0, holesSlotted: 0 }, padGroups: [], feet: [] });
    /* the sheet is planned before the first trunk, and counts its own tips
       (sheet()'s opts.progress); the beat between them is a repeat */
    var say = progressOf(opts), t = 0, nU = buildUnits(p, opts), nS = nU - p.trunks.length, sheetDone = 0;
    say('building', 0, nU, true);
    var sp = trunkStepper(p, Object.assign({}, opts, { rawTris: opts.rawTris || p.rawTris, occluders: opts.occluders || p.occluders,
      beat: function () { say('building', sheetDone, nU); },
      sheetProgress: function (d) { if (d > sheetDone && d <= nS) { sheetDone = d; say('building', d, nU); } } }));
    if (!sp.ok) return Promise.resolve(sp);
    say('building', nS, nU, true);
    function run() {
      while (t < sp.n) {
        var r = sp.step(t++);
        if (r) return r;
        if (t < sp.n) say('building', nS + t, nU);
        var y = opts.yieldFn && opts.yieldFn();
        if (y && typeof y.then === 'function') return y.then(run);
      }
      var done = sp.finish();            /* the pad gaps: one call, after the last trunk - the last unit */
      if (done.ok) say('building', nU, nU, true);
      return done;
    }
    return new Promise(function (go) { go(run()); }).then(function (done) { return opts.foldSheets === false ? done : foldSheets(done, opts); });
  }

  /* A SHEET'S LAYERS, folded into one solid off the page - after parts()
     (the default), or as a build worker's own step once every area is built
     (parts with foldSheets: false, then foldSheets; the worker loads
     nso_csg.js for it) - and not in weld(), on the page: the even layers and
     the odd never overlap within a set (a layer lies between), so each set is
     one soup of disjoint shells, and the two overlap only where a layer sits
     EPS into the one below: ONE union (two layers now, I1 and I2). Its inputs
     are under the boolean door's worker size, so on the page it ran in the
     page's thread - measured with four layers, the longest stall of the
     clamp's build (0.9 s). Without a union here (NSO_unionSoups not loaded)
     weld() folds it, the same way. The Supports card no longer folds at all:
     it keeps every layer its own shell (shells()). */
  function foldSheets(done, opts) {
    var U = (opts && opts.unionSoups) || (root && root.NSO_unionSoups), T = ST(opts);
    if (!done || !done.ok || typeof U !== 'function' || !T) return done;
    var chain = Promise.resolve();
    done.trunks.forEach(function (tr) {
      if (tr.sheet == null || tr.parts.length < 2) return;
      chain = chain.then(function () {
        var L = tr.parts.map(function (x) { return x.soup; });
        return U(joinAll(L.filter(function (x, k) { return k % 2 === 0; })), joinAll(L.filter(function (x, k) { return k % 2 === 1; }))).then(function (r) {
          if (!r || !r.ok) return;        /* weld() tries again, and says why */
          tr.parts = [{ soup: T._finishUnion(r.soup).soup, sheet: true, folded: true }];
        });
      });
    });
    return chain.then(function () { return done; });
  }

  /* Promise of solid()'s result from the trunks' parts: the WELDING half. The
     unions are the app's one boolean and each is one step the page cannot cut
     short; opts.yieldFn gets a turn after every one, and opts.onProgress is
     told 'welding' with no count. */
  function weld(p, tp, opts) {
    opts = opts || {};
    var T = ST(opts);
    if (!p || !p.ok) return Promise.resolve({ ok: false, reason: (p && p.reason) || 'no plan' });
    if (!p.trunks.length) return Promise.resolve({ ok: true, soup: new Float32Array(0), solids: [], reason: p.reason });
    var U = opts.unionSoups || (root && root.NSO_unionSoups);
    if (typeof U !== 'function') return Promise.resolve({ ok: false, reason: 'app-join.js is not loaded - NSO_unionSoups joins the support' });
    var say = progressOf(opts);
    /* After every union: the beat, then the page's turn. */
    function between() { say('welding', null, null); return opts.yieldFn ? opts.yieldFn() : undefined; }
    say('welding', null, null, true);
    var solids = [], dropped = 0, detached = 0;
    var chain = Promise.resolve();
    var sheets = tp.trunks.filter(function (tr) { return tr.sheet != null; });
    tp.trunks.forEach(function (tr) {
      if (tr.sheet != null || !tr.parts.length) return;
      var acc = null;
      tr.parts.forEach(function (part, k) {
        chain = chain.then(function () {
          if (!acc) { acc = part.soup; return null; }
          return U(acc, part.soup).then(function (r) {
            if (r && r.ok) { acc = r.soup; return; }
            if (!r || !r.soup) throw new Error('trunk ' + tr.trunk + ', part ' + k + ': ' + ((r && r.reason) || 'the kernel gave no result'));
            if (part.optional) { dropped++; return; }
            detached++; acc = r.soup;
          }).then(between);
        });
      });
      chain = chain.then(function () {
        var fin = T._finishUnion(acc);
        solids.push({ soup: fin.soup, box: bounds(fin.soup), trunks: [tr.trunk], sheets: [] });
      }).then(between);
    });
    /* Trunks whose boxes meet are offered to the union; it joins them only
       when they really touch. With foot pads a whole slope's trunks can end
       up in one solid, so the joins go in ROUNDS, each pairing off groups
       that touch (lowest first) and uniting every pair once: a balanced
       merge, about log2 of the trunks' worth of work, where folding the
       trunks into one growing solid one at a time re-processed the whole of
       it for every trunk (13 s against 2 s on a 98-trunk face). A pair whose
       union fails is remembered and not offered again. */
    chain = chain.then(function () {
      var groups = solids.map(function (x, i) { return { ids: [i], soup: x }; }), failed = new Set();
      var pk = function (i, j) { return i < j ? i + '|' + j : j + '|' + i; };
      function touching(A, B) {
        for (var a = 0; a < A.ids.length; a++) for (var b = 0; b < B.ids.length; b++) {
          if (boxesTouch(solids[A.ids[a]].box, solids[B.ids[b]].box) && !failed.has(pk(A.ids[a], B.ids[b]))) return true;
        }
        return false;
      }
      function round() {
        var used = {}, pairs = [];
        for (var a = 0; a < groups.length; a++) {
          if (used[a]) continue;
          for (var b = a + 1; b < groups.length; b++) {
            if (used[b] || !touching(groups[a], groups[b])) continue;
            used[a] = used[b] = true; pairs.push([a, b]); break;
          }
        }
        if (!pairs.length) return Promise.resolve(false);
        var c2 = Promise.resolve(), dead = {};
        pairs.forEach(function (pr) {
          c2 = c2.then(function () {
            var A = groups[pr[0]], B = groups[pr[1]];
            return U(A.soup.soup, B.soup.soup).then(function (r) {
              if (r && r.ok) {
                var fin = T._finishUnion(r.soup);
                A.soup = { soup: fin.soup, box: bounds(fin.soup), trunks: A.soup.trunks.concat(B.soup.trunks), sheets: A.soup.sheets.concat(B.soup.sheets) };
                A.ids = A.ids.concat(B.ids);
                dead[pr[1]] = true;
              } else {
                A.ids.forEach(function (i) { B.ids.forEach(function (j) { failed.add(pk(i, j)); }); });
              }
            }).then(between);
          });
        });
        return c2.then(function () {
          groups = groups.filter(function (g, k) { return !dead[k]; });
          return true;
        });
      }
      function rounds() { return round().then(function (again) { return again ? rounds() : null; }); }
      /* THE SHEETS, after the trunks: each in two unions, not one per round.
         Its layers in ONE union - the even layers and the odd never overlap
         within a set (a layer lies between), so each set is one soup of
         disjoint shells and the two overlap only where a layer sits EPS into
         the one below. Then ONE union with every solid that carries one of
         its tips (I1 sits on each cap, 0.01 mm into it, and EPS into each
         uncapped tip): offered to the trunks round by round instead, the
         sheet - the biggest solid there - was re-processed once per trunk it
         took in (64 s against 17 s for the clamp's 126 trunks). The carriers
         go in FIRST: the kernel settles a face that meets another within a
         few microns by the side it came in on, and with the sheet first it
         dropped a whole I1 line over uncapped tips cut 2 um into it (the
         clamp's area 1: 8.9 mm2 of its section at z 71.5, two slivers left) -
         the other way it keeps every line, at every height of those tops
         from 71.423 to 71.432 (measured). Either way round the cut was
         a cap's flank cut 10 um from its top, retriangulated into needles
         NSO's slicer could not close (the wedge lost a cap's section the
         carriers-first way); the caps' upright top band (sheet()'s THE
         CAPS) keeps that cut off the flank, and the wedge's join is clean. */
      /* a soup's lowest face moved down by d: every vertex at its lowest z */
      function sunkBottom(soup, d) {
        var lo = Infinity, out = new Float32Array(soup);
        for (var i = 2; i < soup.length; i += 3) if (soup[i] < lo) lo = soup[i];
        for (var j = 2; j < out.length; j += 3) if (out[j] === lo) out[j] = lo - d;
        return out;
      }
      /* A UNION THAT MERGED, voids or no voids: the kernel's test (fewer
         parts out than in) counts every closed surface of the result as a
         part, a void inside the solid as well. A stair's strips stacked over
         the legs of its tree seal hairline slits between a leg and a strip
         (the tilted box: 45 voids of 0.003 mm3 or less round one solid; the
         kernel read 53 parts out of 4 + 1 and said they did not touch). So
         where the kernel says they do not touch, the pieces are counted
         again as the solids they are - connected surfaces of positive volume
         - in the result and in each input. */
      function solidsIn(soup) {
        var id = new Map(), par = [], vol = [];
        function vk(i) { var k = soup[i] + ',' + soup[i + 1] + ',' + soup[i + 2]; if (!id.has(k)) { id.set(k, par.length); par.push(par.length); } return id.get(k); }
        function fd(x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }
        var tri = [];
        for (var i = 0; i < soup.length; i += 9) {
          var a = vk(i), b = vk(i + 3), c = vk(i + 6);
          par[fd(b)] = fd(a); par[fd(c)] = fd(a); tri.push(a);
        }
        for (var t = 0; t < tri.length; t++) {
          var o = t * 9, r = fd(tri[t]);
          vol[r] = (vol[r] || 0) + (soup[o] * (soup[o + 4] * soup[o + 8] - soup[o + 5] * soup[o + 7]) -
            soup[o + 1] * (soup[o + 3] * soup[o + 8] - soup[o + 5] * soup[o + 6]) + soup[o + 2] * (soup[o + 3] * soup[o + 7] - soup[o + 4] * soup[o + 6])) / 6;
        }
        var n = 0;
        vol.forEach(function (v) { if (v > 0) n++; });
        return n;
      }
      function merged(r, a, b) {
        if (r && r.ok) return true;
        if (!r || !r.soup || !/do not touch/.test(r.reason || '')) return false;
        return solidsIn(r.soup) < solidsIn(a) + solidsIn(b);
      }
      /* THE CARRIERS, one soup for the sheet to meet. Solids that only graze
         (the union said "do not touch": a stair tree's legs round a pocket,
         a hair apart) are put through the kernel ONE AT A TIME first, as a
         soup of the four of them side by side would be read with its grazes
         unsettled and, with the sheet added, resolved differently round a
         slit than the solids are (the tilted box: a 0.08 mm wall laid across
         a 0.12 mm2 pocket between the legs, z 7.3 - 10.3, that the shells
         do not have). A result without a soup (the kernel refused) is the
         solids side by side, as before. */
      function stackUp(list) {
        var acc = Promise.resolve(list[0]);
        list.slice(1).forEach(function (s2) {
          acc = acc.then(function (a2) {
            return U(a2, s2).then(function (r) { return (r && r.soup && r.soup.length) ? r.soup : joinAll([a2, s2]); });
          });
        });
        return acc;
      }
      function joinSheets() {
        var c3 = Promise.resolve();
        sheets.forEach(function (sh) {
          c3 = c3.then(function () {
            var L = sh.parts.map(function (x) { return x.soup; });
            /* FOR THE UNION ONLY, T1's underside goes SHEET_SINK_MM into the
               caps under it. Built, the caps' tops and T1's underside are one
               plane, z_cap - and the kernel left that plane, where a T1 wall
               meets a cap's top, as a T-junction it reads as piercing (2 pairs
               on the clamp's area 2). Sunk, T1's underside cuts the caps'
               0.02 mm upright top band instead, as I1's did when the caps
               stood 0.01 mm into it (sunk 0.01 or 0.005, a T1 wall along the
               clamp's area 1 ring left a sliver in the band; 0.015, none).
               The parts (and so the card's export, and every slice) keep
               z_cap exact. */
            if (L.length > 1) L[0] = sunkBottom(L[0], SHEET_SINK_MM);
            var Lev = L.length === 1 ? null : joinAll(L.filter(function (x, k) { return k % 2 === 0; })), Lod = L.length === 1 ? null : joinAll(L.filter(function (x, k) { return k % 2 === 1; }));
            var folded = L.length === 1 ? Promise.resolve({ ok: true, soup: L[0], folded: true }) : U(Lev, Lod);
            return folded.then(function (r) {
              if (!(L.length === 1 || merged(r, Lev, Lod))) throw new Error('sheet ' + sh.sheet + ': its layers would not join: ' + ((r && r.reason) || 'no result'));
              /* the fold is cleaned with the join it goes into, once: the
                 cleanup walks every triangle, and the lattice is ~200k of them */
              var S = r.soup, carry = {};
              (sh.carriers || []).forEach(function (t) { carry[t] = true; });
              var mine = groups.filter(function (g) { return g.soup.trunks.some(function (t) { return carry[t]; }); });
              if (!mine.length) { S = T._finishUnion(S).soup; groups.push({ ids: [], soup: { soup: S, box: bounds(S), trunks: [], sheets: [sh.sheet] } }); return null; }
              return stackUp(mine.map(function (g) { return g.soup.soup; })).then(function (Am) {
              return U(Am, S).then(function (u) {
                /* a sheet that meets none of its own tips would be placed in
                   mid-air: the build says so instead */
                if (!merged(u, Am, S)) throw new Error('sheet ' + sh.sheet + ' does not meet the tips it was built on: ' + ((u && u.reason) || 'no result'));
                var fin = flatSplits(T._finishUnion(u.soup).soup), trunks = [], sh2 = [sh.sheet];
                mine.forEach(function (g) { trunks = trunks.concat(g.soup.trunks); sh2 = sh2.concat(g.soup.sheets); });
                /* a trunk a stair holds by itself has no parts and no solid of
                   its own: its spots are the stair's (as shells() counts them) */
                (sh.carriers || []).forEach(function (t) { if (trunks.indexOf(t) < 0 && !groups.some(function (g) { return g.soup.trunks.indexOf(t) >= 0; })) trunks.push(t); });
                groups = groups.filter(function (g) { return mine.indexOf(g) < 0; });
                groups.push({ ids: [], soup: { soup: fin, box: bounds(fin), trunks: trunks, sheets: sh2 } });
              });
              });
            }).then(between);
          });
        });
        return c3;
      }
      /* trunks on pads too near to print apart (FEET: linked, not touching)
         are one support all the same: their solids go side by side, as
         shells() groups them */
      function joinPadGroups() {
        (tp.padGroups || []).forEach(function (pg) {
          var mine = groups.filter(function (g) { return g.soup.trunks.some(function (t) { return pg.indexOf(t) >= 0; }); });
          if (mine.length < 2) return;
          var S = joinAll(mine.map(function (g) { return g.soup.soup; })), trunks = [], sh2 = [];
          mine.forEach(function (g) { trunks = trunks.concat(g.soup.trunks); sh2 = sh2.concat(g.soup.sheets); });
          groups = groups.filter(function (g) { return mine.indexOf(g) < 0; });
          groups.push({ ids: [], soup: { soup: S, box: bounds(S), trunks: trunks, sheets: sh2 } });
        });
      }
      return rounds().then(joinSheets).then(joinPadGroups).then(function () {
        var out = groups.map(function (g) { return g.soup; });
        /* Each solid carries what it holds: its trunks' beacon ids, their
           regions, and where it lands ('plate', 'rest', or 'mixed'). A
           support built from one solid is then labelled by lookup. */
        out.forEach(function (x) {
          var ids = [], lands = {};
          x.trunks.slice().sort(function (a, b) { return a - b; }).forEach(function (t) {
            var tr = trunkOf(p, tp, t);
            ids = ids.concat(tr.beacons); lands[tr.landing] = true;
          });
          x.beacons = ids;
          x.regionIds = p.beacons ? regionIdsOf(p.beacons, ids) : [];
          var ls = Object.keys(lands);
          x.landing = ls.length === 1 ? ls[0] : 'mixed';
        });
        solids = out;
      });
    });
    var hollow = null;
    return chain.then(function () {
      var n = solids.reduce(function (s, x) { return s + x.soup.length; }, 0), soup = new Float32Array(n), w = 0;
      solids.forEach(function (x) { soup.set(x.soup, w); w += x.soup.length; });
      if (!opts.hollow) return soup;
      return bore(p, soup, opts).then(function (h) { hollow = h; return h.soup; });
    }).then(function (soup) {
      return { ok: true, soup: soup, solids: solids, fingersDropped: dropped + tp.fingersDropped, detached: detached,
               pads: tp.pads, sheet: tp.sheet || null,
               /* a sheet that joined no trunk would stand in air: counted, never hidden */
               sheetsAlone: solids.filter(function (x) { return x.sheets.length && !x.trunks.length; }).length,
               partSoups: [].concat.apply([], tp.trunks.map(function (t) { return t.parts.map(function (x) { return x.soup; }); })),
               hollow: hollow, solidSoup: hollow ? hollow.solidSoup : null,
               reason: p.reason + (hollow ? ' ' + hollow.reason : '') };
    }).catch(function (err) {
      return { ok: false, reason: 'the support would not join into one solid: ' + ((err && err.message) || err) };
    });
  }

  /* THE PARTS AS SHELLS, no boolean: solid()'s result from the trunks' parts
     with every part kept as its own closed shell - the Supports card's build.
     The slicer fills an object's overlapping shells as one (Bambu Studio, and
     NSO's own slicer: nso_slicer.js fills every section with the Positive
     rule), so the printed layers are the welded support's; support:shells
     holds the two to it, section by section at every 0.2 mm layer. What a
     solid holds is what weld() would have joined: trunks that stand on one
     foot pad (tp.padGroups), and each sheet with every trunk that carries one
     of its tips. Each solid carries its trunks' feet (footprints), from which
     shareFeet() draws the pads when parts() was told footPads: 'shared'. A sheet that no trunk carries stands as a solid
     of its own, counted in sheetsAlone, as weld() counts it. Gecko fingers
     are kept as they were grown (weld() leaves off one that does not reach:
     there is no boolean here to ask; under the sheet none is grown). A
     solid's soup is its parts' soups in order, trunk by trunk, each sheet's
     layers after its trunks. Synchronous, and the same bytes every time. */
  function shells(p, tp) {
    if (!p || !p.ok) return { ok: false, reason: (p && p.reason) || 'no plan' };
    if (!p.trunks.length) return { ok: true, soup: new Float32Array(0), solids: [], reason: p.reason, shells: 0 };
    if (!tp || !tp.ok) return { ok: false, reason: (tp && tp.reason) || 'no parts' };
    var E = tp.trunks, parent = E.map(function (x, k) { return k; }), entryOf = {}, MB = membersOf(p, tp);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function join(a, b) { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
    E.forEach(function (x, k) { if (x.sheet == null) entryOf[x.trunk] = k; });
    (tp.padGroups || []).forEach(function (g) {
      for (var i = 1; i < g.length; i++) if (entryOf[g[0]] != null && entryOf[g[i]] != null) join(entryOf[g[0]], entryOf[g[i]]);
    });
    E.forEach(function (x, k) {
      if (x.sheet == null) return;
      (x.carriers || []).forEach(function (t) { if (entryOf[t] != null) join(entryOf[t], k); });
    });
    var groups = [], at = {}, count = 0;
    E.forEach(function (x, k) {
      var r = find(k);
      if (at[r] == null) { at[r] = groups.length; groups.push({ trunk: [], sheet: [] }); }
      (x.sheet == null ? groups[at[r]].trunk : groups[at[r]].sheet).push(x);
    });
    var solids = groups.map(function (g) {
      var list = [];
      g.trunk.concat(g.sheet).forEach(function (x) { x.parts.forEach(function (q) { list.push(q.soup); count++; }); });
      var soup = joinAll(list), ids = [], lands = {};
      var trunks = g.trunk.map(function (x) { return x.trunk; });
      trunks.slice().sort(function (a, b) { return a - b; }).forEach(function (t) {
        var tr = trunkOf(p, tp, t);
        ids = ids.concat(tr.beacons); lands[tr.landing] = true;
      });
      var ls = Object.keys(lands), mineT = {};
      trunks.forEach(function (t) { mineT[t] = true; });
      return { soup: soup, box: bounds(soup), trunks: trunks, sheets: g.sheet.map(function (x) { return x.sheet; }), beacons: ids,
               regionIds: p.beacons ? regionIdsOf(p.beacons, ids) : [], landing: ls.length === 1 ? ls[0] : 'mixed',
               /* where its trunks stand: shareFeet() draws the pads from these when parts() drew none */
               feet: (tp.feet || []).filter(function (f) { return mineT[f.trunk]; }).map(function (f) {
                 var o = f.grow ? { c: f.c, r: f.r, grow: f.grow } : { c: f.c, r: f.r };
                 o.member = MB.trunkIds[f.trunk]; o.carries = MB.trunkCarries[f.trunk];
                 return o;
               }) };
    });
    /* with knobs: a shell that is not closed would slice open (plan.knobs.problems) */
    if (p.knobs) {
      var open = 0;
      E.forEach(function (x) { x.parts.forEach(function (q) { if (openEdges(q.soup)) open++; }); });
      if (open) knobProblem(p, 'shell', null, open + ' of ' + count + ' shell(s) are not closed (open or non-manifold edges): they would slice open', open);
    }
    return { ok: true, soup: joinAll(solids.map(function (x) { return x.soup; })), solids: solids, shells: count,
             members: MB.members, unsupported: MB.unsupported,
             fingersDropped: tp.fingersDropped || 0, detached: 0, pads: tp.pads, sheet: tp.sheet || null,
             sheetsAlone: solids.filter(function (x) { return x.sheets.length && !x.trunks.length; }).length,
             reason: p.reason };
  }

  /* =====================================================================
     BORES - hollow = union(members) - union(each member shrunk by a wall)

     docs/SUPPORT-TREE.md 6b's construction, carried to a mitred member. A
     member is one constant square section swept along its polyline, so every
     side wall is a plane parallel to its segment and every mitre a bisector
     plane; moving each side wall in by `wall` is the same sweep with the side
     reduced by 2 x wall - exactly, with no taper to pay cos(alpha) for - and
     its end caps come in by `wall` along their own segments. Every bore
     point is then at least `wall` inside its member, hence inside the
     support. Bores of members that meet overlap and become one bore, as the
     reference's merged contours do.

     A member stays solid, named, when its bore would be narrower than
     minBoreMm (default the floor - a single 1.2 mm strut at a 0.42 mm wall
     leaves 0.36 mm, which no slicer keeps as a hole) or it is too short for
     two end walls; a pickup stub and a gecko finger likewise. Never the
     whole support. A wall under the floor is refused by name.
     ===================================================================== */
  function bore(p, soup, opts) {
    var P = PS(opts), T = ST(opts);
    var S = opts.subtractSoups || (root && root.NSO_subtractSoups);
    var out = { solidSoup: soup, soup: soup, bores: [], solid: [], cut: 0, removedMm3: 0 };
    if (typeof S !== 'function') {
      out.reason = '(not hollowed: NSO_subtractSoups, app-join.js, is not loaded)';
      return Promise.resolve(out);
    }
    var wall = opts.hollowWallMm == null ? p.floorMm : +opts.hollowWallMm;
    var minBore = opts.minBoreMm == null ? p.floorMm : +opts.minBoreMm;
    out.wallMm = wall; out.minBoreMm = minBore;
    if (!(wall >= p.floorMm - 1e-9)) {
      out.reason = '(not hollowed: a ' + wall + ' mm wall is under the ' + p.floorMm + ' mm nozzle floor)';
      return Promise.resolve(out);
    }
    p.members.forEach(function (m) {
      if (m.dead || !m.points || m.end === 'none') return;
      var label = 'member ' + m.id, inner = m.side - 2 * wall, pts = m.points.map(function (q) { return q.slice(); });
      var n = pts.length, u0 = unit(sub(pts[1], pts[0])), u1 = unit(sub(pts[n - 1], pts[n - 2]));
      var L0 = len(sub(pts[1], pts[0])), L1 = len(sub(pts[n - 1], pts[n - 2]));
      if (!(inner >= minBore - 1e-9)) { out.solid.push({ label: label, kind: 'too-small', boreMm: inner }); return; }
      if (!(L0 > wall + minBore) || !(L1 > wall + minBore) || (n === 2 && !(L0 > 2 * wall + minBore))) {
        out.solid.push({ label: label, kind: 'too-small', why: 'too short for two end walls' }); return;
      }
      pts[0] = add(pts[0], mul(u0, wall));
      pts[n - 1] = sub(pts[n - 1], mul(u1, wall));
      var up = Math.abs(u0[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      var sw = P.sweep({ points: pts, profile: squareProfile(inner, phaseOf(m.id + 1)), up: up });
      if (!sw.ok) { out.solid.push({ label: label, kind: 'other', why: sw.reason }); return; }
      out.bores.push({ label: label, member: m.id, soup: sw.tris, boreMm: inner });
    });
    p.stubs.forEach(function (st) { out.solid.push({ label: 'stub ' + st.beacon, kind: 'too-small', boreMm: st.side - 2 * wall }); });
    var acc = soup, chain = Promise.resolve();
    out.bores.forEach(function (b) {
      chain = chain.then(function () {
        return S(acc, b.soup).then(function (d) {
          if (d && d.ok) { acc = d.soup; out.cut++; out.removedMm3 += d.removedMm3; b.cut = true; }
          else { b.cut = false; out.solid.push({ label: b.label, kind: 'kernel', why: (d && d.reason) || 'no reason' }); }
        });
      });
    });
    return chain.then(function () {
      out.soup = T._finishUnion(acc).soup;
      out.reason = '(' + out.cut + ' bore' + (out.cut === 1 ? '' : 's') + ' inside a ' + (+wall.toFixed(2)) +
        ' mm wall; ' + out.solid.length + ' part' + (out.solid.length === 1 ? '' : 's') + ' left solid)';
      return out;
    });
  }

  /* =====================================================================
     MEMBERS - what a build is made of, each named, so the card can light
     one, erase one (the feed's `excluded`) and plan again.
     =====================================================================
     members(plan, parts) -> { members, unsupported, ... }; shells() answers
     with the same two, shareFeet() with its pads as members.
       { id, kind: 'tip' | 'branch' | 'trunk' | 'pad' | 'sheet', from, to, carries }
     from / to   its top end and its bottom end ([x, y, z]); a tip's are its
                 contact and the point under it on its column, a pad's and a
                 sheet's the middle of its box at its top and at its bottom
     carries     the tip ids it holds up, sorted: a tip itself; a branch the
                 tips above it; a trunk every tip of its tree; a pad every tip
                 of the trunks on it; a sheet the tips under it. A held tip is
                 in exactly one trunk's carries; an unheld one is in
                 `unsupported` (unreachable, inside the piece, refused).
                 A stair's own trunks are trunk members; each tip the stair
                 holds by itself is carried by one of them (membersOf).
     id          a tip: its tip id. Anything else: its kind and a hash of what
                 it carries and where it runs (its polyline to 0.01 mm; a
                 pad's trunks; a sheet's top) - the same in every build of the
                 same inputs, a new one wherever it is not the same member.
     ===================================================================== */
  function ptKey(q) { return fmt2(q[0]) + ',' + fmt2(q[1]) + ',' + fmt2(q[2]); }
  function memberId(kind, carries, pts) { return kind + '-' + hash32(carries.join(';') + '|' + pts.map(ptKey).join(';')); }
  function sortedIds(list) {
    var seen = {}, out = [];
    list.forEach(function (x) { if (!seen[x]) { seen[x] = true; out.push(x); } });
    return out.sort();
  }
  function boxEnds(soups) {
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    soups.forEach(function (sp) { var b = bounds(sp); for (var k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.lo[k]); hi[k] = Math.max(hi[k], b.hi[k]); } });
    var cx = (lo[0] + hi[0]) / 2, cy = (lo[1] + hi[1]) / 2;
    return { from: [cx, cy, hi[2]], to: [cx, cy, lo[2]] };
  }
  function padMember(trunkIds, carries, soup) {
    var ts = sortedIds(trunkIds.filter(function (x) { return x != null; })), cs = sortedIds(carries), e = boxEnds([soup]);
    return { id: 'pad-' + hash32(ts.join(';')), kind: 'pad', from: e.from, to: e.to, carries: cs };
  }
  /* The plan's own members (tips, branches, trunks), and `ref`: id -> the
     polyline (top first) and side an erased member's keep-out is swept on. */
  function planMembers(p, drop, away) {
    var res = { members: [], ref: {}, trunkIds: [], trunkCarries: [], unsupported: [], idOf: {} };
    if (!p || !p.beacons) return res;
    drop = drop || {}; away = away || {};
    /* a member that holds only tips a stair holds is not built (trunkStepper's
       leftOut); a tip a stair's own trunks carry is not its plan trunk's */
    var built = function (m) { return !(m.beacons.length && m.beacons.every(function (b) { return drop[b] != null; })); };
    var mine = function (ids) { return ids.filter(function (b) { return !away[b]; }); };
    var tid = function (id) { return tidOf(p.beacons[id]); }, st = {};
    (p.stations || []).forEach(function (s) { st[s.beacon] = s; });
    function put(kind, m, pts, carries, side, tipTop) {
      var cs = sortedIds(carries.map(tid)), id = memberId(kind, cs, pts);
      res.members.push({ id: id, kind: kind, from: pts[0].slice(), to: pts[pts.length - 1].slice(), carries: cs });
      res.ref[id] = { kind: kind, pts: pts.map(function (q) { return q.slice(); }), side: side, tipTop: tipTop, carries: cs };
      return { id: id, carries: cs };
    }
    (p.trunks || []).forEach(function (tr) {
      var inTree = {};
      var rootId = null, rootCarries = null;
      tr.members.forEach(function (mid) {
        inTree[mid] = true;
        var m = p.members[mid], pts = m.path;
        if (!built(m)) return;
        var r = put(mid === tr.root ? 'trunk' : 'branch', m, pts, mine(m.beacons), m.side, m.beacon != null);
        res.idOf[mid] = r.id;
        if (mid === tr.root) { rootId = r.id; rootCarries = r.carries; }
      });
      res.trunkIds.push(rootId); res.trunkCarries.push(rootCarries || []);
      (p.stubs || []).forEach(function (s) { if (inTree[s.member] && drop[s.beacon] == null) put('branch', null, [s.to, s.via, s.from], [s.beacon], s.side, true); });
      tr.beacons.slice().sort(function (a, b) { return a - b; }).forEach(function (b) {
        var s = st[b], id = tid(b);
        /* a tip a stair holds has no column: its member is its spot */
        var top = s ? s.contact : p.beacons[b].p, below = s && drop[b] == null ? s.from : top;
        res.members.push({ id: id, kind: 'tip', from: top.slice(), to: below.slice(), carries: [id] });
      });
    });
    res.unsupported = sortedIds((p.unreachable || []).concat(p.inside || []).map(tid)
      .concat(((p.feed && p.feed.refused) || []).map(function (r) { return r.tip; })));
    return res;
  }
  /* The build's members: the plan's, then every pad parts() drew and every
     sheet, from its parts (trunkParts' answer). */
  function membersOf(p, tp) {
    /* THE STAIR (tp.sheet's tips in mode 'drop'): each tip a stair holds by
       itself is carried by ONE of that stair's own trunks - the one whose
       spots on the strips come nearest it in plan (the lower number on a tie);
       a stair whose tree was not built leaves its tips with their plan trunks */
    var drop = {}, away = {}, byStair = {}, sts = (tp && tp.stairTrunks) || [], nT = p && p.trunks ? p.trunks.length : 0;
    ((tp && tp.sheet && tp.sheet.tips) || []).forEach(function (t) { if (t.mode === 'drop') drop[t.beacon] = t.level; });
    sts.forEach(function (x, k) { (byStair[x.stair] = byStair[x.stair] || []).push(k); });
    var stairCarries = sts.map(function () { return []; });
    Object.keys(drop).map(Number).sort(function (a, b) { return a - b; }).forEach(function (b) {
      var ks = byStair[drop[b]];
      if (!ks || !ks.length || !p.beacons[b]) return;
      var q = p.beacons[b].p, best = -1, bd = Infinity;
      ks.forEach(function (k) {
        (sts[k].pts || []).forEach(function (w) { var d = Math.hypot(w[0] - q[0], w[1] - q[1]); if (d < bd - 1e-12) { bd = d; best = k; } });
      });
      if (best < 0) best = ks[0];
      away[b] = true;
      stairCarries[best].push(b);
    });
    var res = planMembers(p, drop, away);
    if (!tp || !tp.trunks) return res;
    var tid = function (id) { return tidOf(p.beacons[id]); };
    /* a stair's own trunks: numbered after the plan's, as tp numbers them */
    sts.forEach(function (x, k) {
      var pts = x.path || [], cs = sortedIds(stairCarries[k].map(tid));
      var id = memberId('trunk', cs, pts.length ? pts : [[0, 0, 0]]);
      if (pts.length) res.members.push({ id: id, kind: 'trunk', from: pts[0].slice(), to: pts[pts.length - 1].slice(), carries: cs });
      res.trunkIds[nT + k] = pts.length ? id : null; res.trunkCarries[nT + k] = cs;
    });
    tp.trunks.forEach(function (e) {
      e.parts.forEach(function (q) {
        if (!q.pad) return;
        res.members.push(padMember(q.keys.map(function (t) { return res.trunkIds[t]; }),
          [].concat.apply([], q.keys.map(function (t) { return res.trunkCarries[t] || []; })), q.soup));
      });
    });
    tp.trunks.forEach(function (e) {
      if (e.sheet == null) return;
      var cs = sortedIds((e.tips || []).map(tid)), ends = boxEnds(e.parts.map(function (q) { return q.soup; }));
      res.members.push({ id: 'sheet-' + hash32(cs.join(';') + '|' + fmt2(ends.from[2])), kind: 'sheet', from: ends.from, to: ends.to, carries: cs });
    });
    return res;
  }
  function members(p, tp) {
    var r = membersOf(p, tp);
    return { members: r.members, unsupported: r.unsupported, excluded: (p && p.excluded) || null, zones: (p && p.zones) || null };
  }

  /* An erased member's keep-out: its polyline swept at its own side, a leg
     at a time, starting KEEP_TRIM_MM down when its top is a tip (so the tip
     is not inside it, and can lean away). */
  function keepOutSoups(P, ref, trimMm) {
    var pts = ref.pts.map(function (q) { return q.slice(); });
    if (ref.tipTop) {
      var total = 0;
      for (var i = 0; i + 1 < pts.length; i++) total += len(sub(pts[i + 1], pts[i]));
      var trim = Math.min(trimMm == null ? KEEP_TRIM_MM : trimMm, total / 2);
      while (pts.length > 1 && trim > 1e-9) {
        var L0 = len(sub(pts[1], pts[0]));
        if (L0 <= trim) { trim -= L0; pts.shift(); continue; }
        pts[0] = add(pts[0], mul(sub(pts[1], pts[0]), trim / L0));
        trim = 0;
      }
    }
    var out = [];
    for (var k = 0; k + 1 < pts.length; k++) {
      var u = unit(sub(pts[k + 1], pts[k]));
      if (!u) continue;
      var sw = P.sweep({ points: [pts[k], pts[k + 1]], profile: squareProfile(ref.side, 0), up: Math.abs(u[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0] });
      if (sw.ok) out.push(sw.tris);
    }
    return out;
  }
  /* A fed plan. The feed's `excluded` names tips (left out, as beaconsOff
     does) and members of an earlier build: the plan is made, the members it
     names are found in it by id, each becomes a keep-out (keepOutSoups) and
     the plan is made again - so its tips are held by other members, or are
     unsupported, and it is not built. A member that only exists in a plan
     made without an earlier erasure is found in the round after it. A pad or
     a sheet is not erased on its own: it is reported (excluded.notErased). */
  function planFed(rawTris, opts, F) {
    var P = PS(opts), keep = [], resolved = [], notErased = [], pending = [], forbid = [];
    F.excluded.forEach(function (id) {
      if (/^(trunk|branch)-/.test(id)) pending.push(id);
      else if (/^(pad|sheet)-/.test(id)) notErased.push(id);
    });
    var p;
    for (;;) {
      p = plan(rawTris, Object.assign({}, opts, { _feed: F, _keepOut: keep, _forbid: forbid }));
      if (!p.ok || !pending.length) break;
      var pm = planMembers(p), hit = pending.filter(function (id) { return pm.ref[id]; });
      if (!hit.length) break;
      if (!P || typeof P.sweep !== 'function') {
        p = { ok: false, stage: 'feed', reason: 'nso_path_sweep.js is not loaded - an erased member\'s keep-out is swept with it' };
        break;
      }
      hit.forEach(function (id) {
        keep = keep.concat(keepOutSoups(P, pm.ref[id], F.knobs && F.knobs.given.nodeMm != null ? F.knobs.given.nodeMm : KEEP_TRIM_MM)); resolved.push(id);
        /* a crown's branch that holds more than one tip: that join is not made again - the tree is split round it */
        var rf = pm.ref[id];
        if (p.crowns && rf.kind === 'branch' && !rf.tipTop && rf.carries && rf.carries.length > 1) forbid.push(rf.carries.slice());
      });
      pending = pending.filter(function (id) { return !pm.ref[id]; });
    }
    var erasedTips = (p.feed && p.feed.erased) || [];
    p.excluded = { members: resolved, tips: erasedTips, notErased: notErased,
                   unknown: pending.concat(F.excluded.filter(function (id) {
                     return !/^(trunk|branch|pad|sheet)-/.test(id) && erasedTips.indexOf(id) < 0;
                   })) };
    return p;
  }

  /* A crown plan's overLean and suggested name the members by the ids the build gives them (planMembers), and each crown's
     nodes say which member they are. */
  function crownIds(p) {
    var pm = planMembers(p), id = function (mi) { return pm.idOf[mi] != null ? pm.idOf[mi] : null; };
    p.overLean = p.overLean.map(function (o) { return { member: id(o.mi), tip: o.tipKeys[0], leanDeg: o.leanDeg }; });
    p.suggested = p.suggested.map(function (s) { return { x: s.x, y: s.y, forMember: id(s.mi), leanDeg: s.leanDeg }; });
    p.crowns.forEach(function (c) { c.rootId = id(c.root); c.nodes.forEach(function (n) { n.memberId = id(n.member); }); });
  }

  /* =====================================================================
     ONE TRUNK (opts.oneTrunk) - the way Bambu's tree slim grows a tree

     Bambu does not stand a column under every spot of the grid. It puts a tip
     every tree_support_branch_distance (5 mm), lets a sheet of transition and
     interface layers carry what lies between them, gathers the tips into a
     canopy of branches that lean up to tree_support_branch_angle (45 deg) and
     stands that canopy on ONE trunk (docs/SUPPORT-ONE-TRUNK.md). The default
     planner measured 20 spots a 14 x 13 mm flat head, on a 3 mm grid, and
     built 6 trunks; Bambu's slice of the same head has 5 tips and 1 trunk.

     With opts.oneTrunk and no feed: the detected (or given) beacons of each
     area are THINNED to the spacing the sheet can carry - farthest first, until
     every beacon is within `coverMm` of a tip - and the tips of a cluster (an
     area's, split where one trunk could not reach) are fed to the crown planner
     (CROWNS) with one landing circle under the cluster's centroid. Nothing the
     crown planner does is new: its tree, its trunk, the sheet and the caps are
     the custom feed's, with the knobs this mode sets (the tip's straight rise
     for its cap, the canopy's lean).

     The beacons a thinned tip does not name are COVERED: each is within
     coverMm of a tip that is built, and is held through it
     (plan.oneTrunk.covered). A tip stands for the spots around it.
     ===================================================================== */
  var ONE = {
    coverMm: 3.3,         /* every beacon is within this of a tip: a cap (up to 2 mm out) and the sheet's field (1.25 mm) reach 3.25 */
    clusterMm: 12,        /* a cluster's tips lie within this of its centre: one trunk feeds a canopy of about this radius (Bambu's own, 14 mm across; 12 left the fewest over-lean members on a 40 x 30 mm slab: 5 trunks, against 8 at 9 and 3 at 15) */
    crown: { tipDropMm: 3.2, nodeDropMm: 2, rootFloorMm: 6, ovalMax: 1, trunk: { tipMm: 2.8, uniformH: 10, padGrowMm: 0.6 } },   /* a canopy is 3.2 mm of straight tip, then joins 2 mm apart, on a trunk that stands 6 mm clear of the plate (its flare is 4.5, curved, and the stem above it plain) */
    lowMm: 4,             /* a spot this near the plate (the low edge of a tipped part) is on the first layers: nothing is stood under it, and it is held by the plate */
    minTips: 3,           /* an area of three spots or more keeps three tips at least: a curved underside is a stair only from three (nso_support_interface.js STAIR_MIN_TIPS) */
    zWindowMm: 4,         /* tips more than this apart in height (gap to the next tip up) are not served by one trunk */
    centreReachMm: 5,     /* a spot within this of a cluster's tip counts toward where the cluster's trunk stands (covered ones, and the ones a wall took) */
    lostRounds: 2,        /* a spot no branch reaches is left out and the tips planned again, this many times at most */
    splitRounds: 3,       /* a cluster with a branch that has no way round the piece is split, this many times at most */
    splitFactor: 0.6,     /* ...to this share of its radius */
    circleMm: 6,          /* the landing circle the trunk may stand in, round the cluster's centre */
    footClearMm: 0.6,     /* the trunk's foot stands this far off the part on the first layer: Bambu's own, on its six test heads, is 0.3 - 0.4 (support_object_xy_distance 0.35); the 3.86 of the default is simple_overhang's */
    tipRiseMm: 2.6,       /* a tip stands straight this far under its contact before it leans (its cap's rise and a little more) */
    designLeanDeg: 38,    /* the canopy is designed to this lean; Bambu's branch angle is 45 and its joins measure up to 47.7 */
    tiltDeg: 50           /* ...and only a lean past this is marked */
  };
  function thinTips(list, coverMm, minTips) {
    var n = list.length;
    if (n <= 1) return list.map(function (b, i) { return i; });
    var cx = 0, cy = 0, i, j;
    list.forEach(function (b) { cx += b.p[0] / n; cy += b.p[1] / n; });
    var d2 = list.map(function (b) { return Math.hypot(b.p[0] - cx, b.p[1] - cy); }), first = 0;
    for (i = 1; i < n; i++) if (d2[i] < d2[first] - 1e-12 || (Math.abs(d2[i] - d2[first]) <= 1e-12 && (list[i].p[0] - list[first].p[0] || list[i].p[1] - list[first].p[1]) < 0)) first = i;
    var chosen = [first], dmin = list.map(function (b) { return Math.hypot(b.p[0] - list[first].p[0], b.p[1] - list[first].p[1]); });
    for (;;) {
      var best = -1, bd = -1;
      for (i = 0; i < n; i++) {
        if (dmin[i] > bd + 1e-9 || (best >= 0 && Math.abs(dmin[i] - bd) <= 1e-9 && (list[i].p[0] - list[best].p[0] || list[i].p[1] - list[best].p[1]) < 0)) { bd = dmin[i]; best = i; }
      }
      if (best < 0 || (bd <= coverMm && chosen.length >= Math.min(minTips, n))) break;
      if (bd <= 1e-9) break;
      chosen.push(best);
      for (j = 0; j < n; j++) dmin[j] = Math.min(dmin[j], Math.hypot(list[j].p[0] - list[best].p[0], list[j].p[1] - list[best].p[1]));
    }
    return chosen;
  }
  /* split an area's tips into clusters no wider than clusterMm from a centre: farthest-first seeds, each tip to the nearest seed, centres moved to the means, twice */
  function clusterTips(tips, radiusMm) {
    var n = tips.length;
    function spread(idx) {
      var cx = 0, cy = 0;
      idx.forEach(function (k) { cx += tips[k].p[0] / idx.length; cy += tips[k].p[1] / idx.length; });
      var r = 0; idx.forEach(function (k) { r = Math.max(r, Math.hypot(tips[k].p[0] - cx, tips[k].p[1] - cy)); });
      return { c: [cx, cy], r: r };
    }
    var all = []; for (var i = 0; i < n; i++) all.push(i);
    var groups = [all];
    for (var guard = 0; guard < 16; guard++) {
      var bad = -1;
      for (var g = 0; g < groups.length; g++) if (groups[g].length > 1 && spread(groups[g]).r > radiusMm + 1e-9) { bad = g; break; }
      if (bad < 0) break;
      var idx = groups[bad], c = spread(idx).c, a = idx[0], da = -1;
      idx.forEach(function (k) { var d = Math.hypot(tips[k].p[0] - c[0], tips[k].p[1] - c[1]); if (d > da + 1e-9) { da = d; a = k; } });
      var b = idx[0], db = -1;
      idx.forEach(function (k) { var d = Math.hypot(tips[k].p[0] - tips[a].p[0], tips[k].p[1] - tips[a].p[1]); if (d > db + 1e-9) { db = d; b = k; } });
      var ca = [tips[a].p[0], tips[a].p[1]], cb = [tips[b].p[0], tips[b].p[1]], ga = [], gb = [];
      for (var it = 0; it < 6; it++) {
        ga = []; gb = [];
        idx.forEach(function (k) { (Math.hypot(tips[k].p[0] - ca[0], tips[k].p[1] - ca[1]) <= Math.hypot(tips[k].p[0] - cb[0], tips[k].p[1] - cb[1]) ? ga : gb).push(k); });
        if (!ga.length || !gb.length) break;
        ca = spread(ga).c; cb = spread(gb).c;
      }
      if (!ga.length || !gb.length) break;
      groups.splice(bad, 1, ga, gb);
    }
    return groups;
  }
  /* the tips, in bands of height: a tip joins a band while it is within zWindowMm of the band's tips (single linkage), so a
     slope is one band and two ceilings a floor apart are two, and no trunk is asked to serve both */
  function zBands(tips, windowMm) {
    var idx = tips.map(function (t, i) { return i; }).sort(function (x, y) { return (tips[x].p[2] - tips[y].p[2]) || (x - y); }), bands = [];
    idx.forEach(function (i) {
      var cur = bands[bands.length - 1];
      if (cur && tips[i].p[2] - tips[cur[cur.length - 1]].p[2] <= windowMm) cur.push(i); else bands.push([i]);
    });
    return bands;
  }
  /* WHICH AREAS ONE TRUNK SERVES. Bambu finds a rim round a cavity in pieces - three or four little areas - and stands one
     trunk under all of them. areas: [{ id, pts: [{ x, y, z }] }], in the order they are built; -> [[area index, ...], ...]. An
     area joins the group before it while the group's spots (all of them) lie within clusterMm of their centroid and within
     zWindowMm of height - the canopy one trunk can feed. The card plans a group in one call (its first area's), and every
     area of it keeps its own outline, status and answer. */
  function oneTrunkGroups(areas, opts) {
    var ck = Object.assign({}, ONE, (opts && typeof opts === 'object') ? opts : {});
    function fits(list) {
      if (!list.length) return true;
      var cx = 0, cy = 0, lo = Infinity, hi = -Infinity, r = 0;
      list.forEach(function (b) { cx += b.x / list.length; cy += b.y / list.length; lo = Math.min(lo, b.z); hi = Math.max(hi, b.z); });
      list.forEach(function (b) { r = Math.max(r, Math.hypot(b.x - cx, b.y - cy)); });
      return r <= ck.clusterMm + 1e-9 && hi - lo <= ck.zWindowMm + 1e-9;
    }
    var left = areas.map(function (a, i) { return i; }), out = [];
    while (left.length) {
      var g = [left.shift()], pts = areas[g[0]].pts.slice();
      for (var i = 0; i < left.length;) {
        var cand = pts.concat(areas[left[i]].pts);
        if (fits(cand)) { g.push(left.splice(i, 1)[0]); pts = cand; } else i++;
      }
      out.push(g);
    }
    return out;
  }
  function planOneTrunk(rawTris, opts) {
    var bc = beaconsFor(rawTris, opts);
    if (!bc.ok || !bc.beacons.length) return null;                      /* the ordinary plan says why, in its own words */
    var say = progressOf(opts);
    say('detecting', null, null, true);
    var ck = Object.assign({}, ONE, (opts.oneTrunk && typeof opts.oneTrunk === 'object') ? opts.oneTrunk : {});
    ck.crown = Object.assign({}, ONE.crown, (opts.oneTrunk && opts.oneTrunk.crown) || {});
    var byArea = {}, order = [];
    bc.beacons.forEach(function (b) {
      var k = b.regionId == null ? -1 : b.regionId;
      if (!byArea[k]) { byArea[k] = []; order.push(k); }
      byArea[k].push(b);
    });
    /* a spot whose tip no branch can reach round the piece, even alone (plan.blocked left after every split) has no route to the
       plate: it is not built, and is the plan's unreachable - the same word the lattice planner gives it. The pool is thinned
       again without it, so the spots beside it stand tips of their own. */
    var lost = {}, nLost = 0, p = null, chosen, covered, thinned, clusters, rounds, onPlate = [], plateZ1 = bc.detect && bc.detect.plateZ != null ? bc.detect.plateZ : 0;
    bc.beacons.forEach(function (b) { if (b.p[2] - plateZ1 < ck.lowMm) { lost[b.id] = 'plate'; onPlate.push({ beacon: b.id, key: b.key, regionId: b.regionId, p: b.p.slice() }); } });
    /* A SPOT WITH NO ROUTE DOWN stands no tip, and is not covered by one beside it: a spot over the part's own base, or the middle of
       a tunnel's ceiling, has a neighbour within the sheet's reach whose column reaches the plate, but the sheet does not lie under
       the spot because of that. A route is a straight leg to the plate or a leaning one (the limit's lean, 16 headings, the whole
       reach and half of it), clear of the piece as every leg of the planner is, at the LATTICE planner's lean limit (30 deg, not the
       canopy's 50: "no route to the plate" means what it always meant). Such a spot is the plan's unreachable. */
    (function () {
      var A0 = SA(opts), st = A0 && A0.buildStrut ? A0.buildStrut(opts) : null, plateZ0 = bc.detect && bc.detect.plateZ;
      if (!st || !st.ok || plateZ0 == null) return;
      var pr = makeProbe(A0, [rawTris].concat(opts.occluders || [])), tanL = Math.tan((opts.branchTiltDeg == null ? ST(opts).BRANCH_TILT_DEG : +opts.branchTiltDeg) * Math.PI / 180) * 0.97, side = st.sideMm;
      /* the route a tip at `at` has down: straight, leaning to the plate, or leaning a while and then straight (the lattice planner's
         steer: the leaning line walked down a node's height at a time, a clear leg and a clear drop at each) */
      function routeDown(at, straightOnly) {
        var H = at[2] - plateZ0, tip = [at[0], at[1], at[2] - 0.01];
        if (!(H > side)) return true;                                      /* on the plate's own layer: nothing under it to ask */
        if (pr.leg(tip, [tip[0], tip[1], plateZ0], side, side, 0) < 0) return true;
        if (straightOnly) return false;
        for (var f = 0; f < 2; f++) {
          for (var h = 0; h < STEER_HEADINGS; h++) {
            var th = 2 * Math.PI * h / STEER_HEADINGS, ux = Math.cos(th), uy = Math.sin(th), tl = tanL * (f ? 0.5 : 1);
            for (var dz = STEER_STEP_MM; dz < H - 1e-9; dz += STEER_STEP_MM) {
              var q = [tip[0] + ux * dz * tl, tip[1] + uy * dz * tl, tip[2] - dz];
              if (pr.leg(tip, q, side, side, 0) >= 0) break;                /* the leaning line is blocked from here down */
              if (pr.leg(q, [q[0], q[1], plateZ0], side, 0, 0) < 0) return true;
            }
            if (pr.leg(tip, [tip[0] + ux * H * tl, tip[1] + uy * H * tl, plateZ0], side, side, 0) < 0) return true;
          }
        }
        return false;
      }
      bc.beacons.forEach(function (b) {
        if (b.p[2] - plateZ0 < ck.lowMm) return;                           /* on the plate's first layers: held by the plate (below) */
        var ok = routeDown(b.p);
        /* a tip against a wall is moved off it along its face, as the lattice planner moves one (NUDGE_STEPS of the strut's side) */
        for (var si = 0; si < NUDGE_STEPS.length && !ok && b.n[2] < -1e-6; si++) {
          for (var h0 = 0; h0 < STEER_HEADINGS && !ok; h0++) {
            var t0 = 2 * Math.PI * h0 / STEER_HEADINGS, dd = NUDGE_STEPS[si] * side, dx = Math.cos(t0) * dd, dy = Math.sin(t0) * dd;
            ok = routeDown([b.p[0] + dx, b.p[1] + dy, b.p[2] - (b.n[0] * dx + b.n[1] * dy) / b.n[2]], true);   /* a nudged tip: a straight drop (the leaning search is the spot's own, once) */
          }
        }
        if (!ok) { lost[b.id] = true; nLost++; }
      });
    })();
    for (var outer = 0; outer <= ck.lostRounds; outer++) {
      /* 1. every area thinned to the tips the sheet can carry; the rest are covered by the nearest */
      chosen = []; covered = []; thinned = 0;
      order.forEach(function (k) {
        var pool = byArea[k].filter(function (b) { return !lost[b.id]; });
        if (!pool.length) return;
        var pick = thinTips(pool, ck.coverMm, Math.min(ck.minTips, pool.length)), isTip = {}, mine = [];
        pick.forEach(function (i) { isTip[i] = true; mine.push(pool[i]); });
        pool.forEach(function (b, i) {
          if (isTip[i]) return;
          var by = null, bd = Infinity;
          mine.forEach(function (c) { var d = Math.hypot(b.p[0] - c.p[0], b.p[1] - c.p[1]); if (d < bd) { bd = d; by = c; } });
          covered.push({ beacon: b.id, key: b.key, regionId: b.regionId, p: b.p.slice(), by: by.id, byKey: by.key, mm: bd });
          thinned++;
        });
        mine.forEach(function (b) { chosen.push(b); });
      });
      if (!chosen.length) return null;                                     /* nothing left to stand: the ordinary plan says why */
      /* 2. the tips of every area, in bands of height, clustered; a cluster whose canopy has a branch with no way round the
         piece (plan.blocked) is split smaller and planned again - a tip is never left without its branch */
      clusters = [];
      zBands(chosen, ck.zWindowMm).forEach(function (band) {
        clusterTips(band.map(function (i) { return chosen[i]; }), ck.clusterMm).forEach(function (g) { clusters.push({ tips: g.map(function (j) { return chosen[band[j]]; }), r: ck.clusterMm }); });
      });
      rounds = 0;
      for (;;) {
        var tips = [], zones = [];
        clusters.forEach(function (c) {
          /* the circle stands under the tips' centroid - weighted toward the higher tips when a first plan had a branch with no way
             round (c.bias): under a slope the room is under its high end, and a branch can climb from there to a lower tip, where a
             branch from under the low end meets the underside rising over it */
          var cx = 0, cy = 0, wsum = 0, zlo = Math.min.apply(null, c.tips.map(function (b) { return b.p[2]; }));
          c.tips.forEach(function (b) { var w = c.bias ? Math.pow(b.p[2] - zlo + 0.5, c.bias) : 1; cx += b.p[0] * w; cy += b.p[1] * w; wsum += w; });
          /* the trunk stands under the middle of the HEAD, not of the tips that happened to be reachable: the spots the thinning
             covered and the ones lost to a wall, each to its nearest tip within centreReachMm, count as the tip they belong to
             (a dome whose far side stands against a post: its pole, not the near ring, is where its trunk is) */
          if (!c.bias) {
            bc.beacons.forEach(function (b) {
              if (c.tips.indexOf(b) >= 0 || b.regionId !== c.tips[0].regionId) return;
              var bt = null, bd = Infinity;
              c.tips.forEach(function (t) { var d = Math.hypot(b.p[0] - t.p[0], b.p[1] - t.p[1]); if (d < bd) { bd = d; bt = t; } });
              if (bd > ck.centreReachMm) return;
              var other = false;
              clusters.forEach(function (c2) { if (c2 !== c) c2.tips.forEach(function (t2) { if (Math.hypot(b.p[0] - t2.p[0], b.p[1] - t2.p[1]) < bd - 1e-9) other = true; }); });
              if (!other) { cx += b.p[0]; cy += b.p[1]; wsum += 1; }
            });
          }
          /* ...and as many branches to a join as the head's height asks: a squat head has no room for a join under a join (a
             branch from a join 0.5 mm under its tips leans along the underside it should clear), so its tips go to the trunk's top
             in as few levels as the room allows - a flat umbrella - and a tall head keeps Bambu's pairs (2 - 3 to a join) */
          var room = zlo - ck.crown.rootFloorMm - ck.crown.tipDropMm, allowed = Math.max(0, Math.floor(room / ck.crown.nodeDropMm + 1e-9)), K = 3, mm = c.tips.length, rds = 0;
          for (K = 3; K < c.tips.length; K++) {
            mm = c.tips.length; rds = 0;
            while (mm > K) { mm = Math.max(1, Math.floor(mm / 2)); rds++; }
            if (rds <= allowed) break;
          }
          zones.push({ x: cx / wsum, y: cy / wsum, r: ck.circleMm, maxKids: Math.max(3, Math.min(K, c.tips.length)) });
          c.tips.forEach(function (b) { tips.push({ x: b.p[0], y: b.p[1], z: b.p[2], regionId: b.regionId, key: b.key, beaconId: b.id }); });
        });
        var o2 = Object.assign({}, opts, {
          feed: { mode: 'custom', tips: tips, landingZones: zones },
          crown: Object.assign({ tipRiseMm: ck.tipRiseMm, designLeanDeg: ck.designLeanDeg }, ck.crown || {}, opts.crown || {}, { trunk: Object.assign({ footClearMm: ck.footClearMm }, (ck.crown && ck.crown.trunk) || {}, (opts.crown && opts.crown.trunk) || {}) }),
          branchTiltDeg: opts.branchTiltDeg == null ? ck.tiltDeg : opts.branchTiltDeg,
          beacons: undefined, oneTrunk: undefined
        });
        var F2 = feedOf(o2);
        if (F2 && F2.error) return { ok: false, stage: 'feed', reason: F2.error };
        p = planFed(rawTris, o2, F2);
        if (!p.ok || !p.blocked || !p.blocked.length || rounds >= ck.splitRounds) break;
        /* the crown (its zone) of each blocked branch splits; the others stand */
        var bad = {};
        p.blocked.forEach(function (bl) { var cr = p.crowns[bl.crown]; if (cr) bad[cr.zone] = true; });
        var next = [], split = false;
        clusters.forEach(function (c, zi) {
          if (!bad[zi] || c.tips.length < 2) { next.push(c); return; }
          if (!c.bias) { c.bias = 1; next.push(c); split = true; return; }          /* first: the trunk moved toward the high end */
          var r2 = c.r * ck.splitFactor;
          var gs = clusterTips(c.tips, r2);
          if (gs.length < 2) gs = clusterTips(c.tips, 0.5 * Math.max.apply(null, c.tips.map(function (b) { return Math.hypot(b.p[0] - zones[zi].x, b.p[1] - zones[zi].y); })));
          if (gs.length < 2) { next.push(c); return; }
          split = true;
          gs.forEach(function (g) { next.push({ tips: g.map(function (j) { return c.tips[j]; }), r: r2 }); });
        });
        if (!split) break;
        clusters = next; rounds++;
      }
      if (!p.ok || !p.blocked || !p.blocked.length || outer >= ck.lostRounds) break;
      var byTid = {}, found = 0;
      chosen.forEach(function (b) { byTid[tipId(b.p, true)] = b; });
      p.blocked.forEach(function (bl) { (bl.tips || []).forEach(function (tid) { var b = byTid[tid]; if (b && !lost[b.id]) { lost[b.id] = true; nLost++; found++; } }); });
      if (!found) break;
    }
    if (p.ok) {
      /* the lost spots, as unreachable beacons of the plan (its beacons list is the card's key for every id it answers with) */
      Object.keys(lost).filter(function (id) { return lost[id] === true; }).map(Number).sort(function (x, y) { return x - y; }).forEach(function (id) {
        var b = bc.beacons[id], at = p.beacons.length;
        p.beacons.push({ id: at, p: b.p.slice(), n: b.n.slice(), regionId: b.regionId, key: b.key, source: b.source || 'given', tid: tipId(b.p, true) });
        p.unreachable.push(at);
      });
      p.oneTrunk = { coverMm: ck.coverMm, areas: order.length, clusters: clusters.map(function (c) { return { tips: c.tips.length, radiusMm: c.r }; }),
                     tips: chosen.length, beacons: bc.beacons.length, thinned: thinned, covered: covered, onPlate: onPlate, splits: rounds, lost: nLost };
      p.reason = p.reason + (thinned ? ' ' + thinned + ' more spot(s) of the ' + bc.beacons.length + ' lie within ' + ck.coverMm + ' mm of a tip and are held through it.' : '');
    }
    return p;
  }

  /* plan() keeps what solid() needs to clear gecko fingers. */
  function planSupport(rawTris, opts) {
    var F = feedOf(opts), p;
    if (F && F.error) p = { ok: false, stage: 'feed', reason: F.error };
    else if (opts && opts.oneTrunk && !F) p = planOneTrunk(rawTris, opts) || plan(rawTris, opts);
    else p = F ? planFed(rawTris, opts, F) : plan(rawTris, opts);
    if (p.ok && p.crowns) crownIds(p);
    p.rawTris = rawTris;
    p.occluders = (opts && opts.occluders) || [];
    return p;
  }

  function describe(p) {
    if (!p) return 'no plan';
    return p.ok ? 'Support: ' + p.reason : 'Support refused: ' + p.reason;
  }

  var api = {
    LATTICE_MM: LATTICE_MM, AREA_CAP: AREA_CAP, CLEAR_MM: CLEAR_MM, EAGERNESS: Object.assign({}, EAGERNESS),
    STEER_HEADINGS: STEER_HEADINGS, STEER_LEANS: STEER_LEANS.slice(),
    gridBeacons: gridBeacons,
    plan: planSupport,
    oneTrunkGroups: oneTrunkGroups,
    ONE_TRUNK: JSON.parse(JSON.stringify(ONE)),
    solid: solid,
    parts: parts,
    weld: weld,
    shells: shells,
    members: members,
    tipId: function (p, given) { return tipId(p, !!given); },
    FEED: { snapMm: SNAP_MM, upMax: UP_MAX, keepTrimMm: KEEP_TRIM_MM, modes: Object.keys(FEED_MODES) },
    buildUnits: buildUnits,
    describe: describe,
    _sideFor: sideFor,
    _squareProfile: squareProfile,
    _earClip: earClip,
    _prismSoup: prismSoup,
    shareFeet: shareFeet,
    _footPads: function (obstacles, feet, plateZ, thick, opts) { return footPads(TM(opts), obstacles, feet, plateZ, thick == null ? FOOT_LAYER_MM : thick); },
    _footprintOf: footprintOf,
    _frustumSoup: frustumSoup,
    FEET: { layerMm: FOOT_LAYER_MM, clusterMm: FOOT_CLUSTER_MM, growMm: FOOT_GROW_MM, gapMm: FOOT_GAP_MM, cellMm: FOOT_CELL_MM, touchMm: FOOT_TOUCH_MM },
    /* TRUNK is the shipped law (the knobs' defaults); trunkLaw(plan) is the law that plan builds its trunks by: the feed's knobs over it */
    trunkLaw: function (p) {
      var k = p && p.knobs;
      return { tipMm: k ? k.trunkTipMm : TRUNK_TIP_MM, angleDeg: k ? k.trunkAngleDeg : TRUNK_ANGLE_DEG, flareMm: FLARE_MM, flareAngleDeg: FLARE_ANGLE_DEG };
    },
    KNOBS: { keys: KNOB_KEYS.slice() },
    blobSoup: blobSoup,      /* the smooth body of a crown: blobSoup([{ pts, r }], blendMm, cellMm) -> soup */
    flareAt: flareAt,        /* the extra radius the flare gives a trunk at z: flareAt(z, plateZ + flareMm, tan(flareAngle), flareMm) */
    TRUNK: { tipMm: TRUNK_TIP_MM, angleDeg: TRUNK_ANGLE_DEG, flareMm: FLARE_MM, flareAngleDeg: FLARE_ANGLE_DEG, share: TRUNK_SHARE,
             keepMm: TRUNK_KEEP_MM, tipClearMm: TRUNK_TIP_CLEAR_MM, tipReachMm: TRUNK_TIP_REACH_MM, sides: TRUNK_SIDES, footClearMm: TRUNK_FOOT_CLEAR_MM },
    JOINS: JSON.parse(JSON.stringify(JOINS)),
    CROWN: { areaRatio: CROWN_AREA_RATIO, maxKids: CROWN_MAX_KIDS, tipDropMm: CROWN_TIP_DROP_MM, nodeDropMm: CROWN_NODE_DROP_MM, ovalMax: CROWN_OVAL_MAX,
             branchTaperDeg: CROWN_BRANCH_TAPER_DEG, rootFloorMm: CROWN_ROOT_FLOOR_MM },
    crownKnobs: function (o) { return crownKnobs(o); },
    _crownTopology: crownTopology,
    _tubeSoup: tubeSoup,
    _ballSoup: ballSoup,
    _memberSolid: function (m, foot, opts) { return memberSolid(PS(opts || {}), m, foot); },
    _phaseOf: phaseOf,
    foldSheets: function (tp, opts) { return foldSheets(tp, opts || {}); },
    _makeProbe: makeProbe
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SupportGridpack = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
