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

   FEET. A trunk that lands on the plate stands on a pad: one first layer
   (0.2 mm) of a round slab, r = max(3 mm, 2.5 x the trunk's half-width), kept
   0.2 mm off the piece; pads that touch are unioned (opts.footPads false turns
   them off). A pad is a solid disc, never a ring: where pads overlap round a
   small gap the gap is filled, and where two just touch (discs of r = 3 on a
   6 mm lattice) a bridge makes the join solid, so a group of pads is one
   slab with no hole in it (a gap that holds something of the piece within
   0.2 mm is left, and counted in solid()'s padGaps; opts.padGaps false turns
   the filling off). Nothing goes below the plate: the trunk ends half a layer inside
   its pad, and a last leg that would lean onto the plate stops 1 mm short and
   drops straight.

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

   PROGRESS. opts.onProgress(msg), on plan(), parts() and weld(), is told
   { phase, done, total } as the work goes, once per unit finished:
     'detecting'  plan(): the plate and the spatial index; no count (null, null)
     'planning'   plan(): beacons settled / beacons given (a beacon inside the
                  piece is settled when it is refused)
     'building'   parts(): trunks swept / trunks
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
   same bytes as before.
   ============================================================ */
(function (root) {
  'use strict';

  var LATTICE_MM = 5;          /* L. Node pitch L/2 in x, y and z. */
  var AREA_CAP = 4;
  var MAX_MERGE = 3;           /* members meeting at one node: pairwise, or three when one stands in the way */            /* a merged section tops out at 4 x the strut area (FLAG) */
  var CLEAR_MM = 0.2;          /* rails are tested this far outside the section */
  var STEER_HEADINGS = 16;
  var STEER_LEANS = [1, 0.5];
  var RAY_EPS = 1e-3;
  var PAD_LAYERS_MM = 0.4;     /* a resting foot: two 0.2 mm layers */
  var GAP_MM = 0.18;           /* nso_support_interface.js's easy-release gap */
  var TIP_LEVELS = [0.05, 0.3, 0.6, 1.0, 1.5];   /* mm below a tip where the tip zone is swept for walls */
  var TIP_RISE_SIDES = 2;     /* a pickup stub's vertical last run, x the strut side */
  var NUDGE_STEPS = [0.25, 0.5, 0.75, 1];   /* x the strut side: how far a tip may move off a wall */
  var FOOT_LAYER_MM = 0.2;     /* a foot pad is one first layer thick (the 0.2 mm layers this file's gaps are sized for) */
  var FOOT_MIN_R_MM = 3;       /* foot pad radius: max(this, FOOT_HALF_WIDTHS x the trunk's half-width) */
  var FOOT_HALF_WIDTHS = 2.5;
  var FOOT_RUN_MM = 1;         /* a trunk that would land leaning stops this high and drops the rest straight */
  var FOOT_SIDES = 48;
  var FOOT_GAP_MM = 0.2;       /* a pad keeps this far off the piece (and what stands round it), the support gap and a hair */
  var GAP_CELL_MM = 0.025;     /* the raster the gaps between pads are found on: one cell */
  var GAP_CELLS_MAX = 4e6;     /* ...coarsened to this many cells on a very wide field of feet */
  var BRIDGE_NEAR_MM = 0.1;    /* pads whose outlines overlap or part by less than this are bridged */
  var BRIDGE_LEN_MM = 0.6;     /* a bridge: this long across the contact (more by the overlap), */
  var BRIDGE_WIDTH_MM = 0.8;   /* ...this wide, one first layer thick */
  var GAP_DILATE = 2;          /* a gap is filled this many cells past its own edge, so the fill overlaps the pads round it */
  var LEAN_TOL = 1e-4;          /* a face tilted exactly the lean limit is not a side face: float32 noise on its normal must not decide */
  var EAGERNESS = { strut: 0, tree: 1, 'gecko-hand': 1 };
  var HEARTBEAT_MS = 200;      /* a repeat of the last progress message goes out once this long has passed (see PROGRESS above) */

  function SA(o) { return (o && o.supportAim) || (root && root.NSO_SupportAim) || null; }
  function ST(o) { return (o && o.supportTree) || (root && root.NSO_SupportTree) || null; }
  function SBM(o) { return (o && o.beaconsModule) || (root && root.NSO_SupportBeacons) || null; }
  function PS(o) { return (o && o.pathSweep) || (root && root.NSO_PathSweep) || null; }

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

  /* =====================================================================
     THE PLAN
     ===================================================================== */
  function plan(rawTris, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '', stage: 'beacons', members: [], stubs: [], merges: [], pickups: [],
                steered: [], nudged: [], tight: [], unreachable: [], resting: [], inside: [], held: 0 };
    var A = SA(opts), T = ST(opts), say = progressOf(opts);
    if (!A || !T || typeof A.detectOverhangs !== 'function') {
      out.reason = 'nso_support_aim.js and nso_support_tree.js must be loaded'; return out;
    }
    var style = opts.style == null ? 'tree' : String(opts.style);
    if (!(style in EAGERNESS)) { out.reason = 'unknown support style ' + JSON.stringify(opts.style); return out; }
    var eager = opts.mergeEagerness == null ? EAGERNESS[style] : +opts.mergeEagerness;
    out.style = style; out.eagerness = eager;

    say('detecting', null, null, true);
    var bc = beaconsFor(rawTris, opts);
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
    var tiltDeg = opts.branchTiltDeg == null ? T.BRANCH_TILT_DEG : +opts.branchTiltDeg;
    var tanT = Math.tan(tiltDeg * Math.PI / 180), cosT = Math.cos(tiltDeg * Math.PI / 180);
    var L = opts.latticeMm == null ? LATTICE_MM : +opts.latticeMm, g = L / 2;
    var plateZ = bc.detect.plateZ;
    var reach = (opts.pickupReachMm == null ? bc.pitchMm * 1.05 : +opts.pickupReachMm) * (eager > 0 ? 1 : 0);
    var rest = !!opts.restOnModel;
    out.branchTiltDeg = tiltDeg; out.latticeMm = L; out.plateZ = plateZ; out.restOnModel = rest;
    var obstacles = [rawTris].concat(opts.occluders || []);
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

    /* ---- the descent ---- */
    var zTop = live[0].p[2];
    var kTop = Math.ceil((zTop - plateZ) / g - 1e-9);
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
              else ok = false;
            }
            if (!grew) break;
          }
          if (!ok) return;
          count = group.reduce(function (n, m) { return n + m.count; }, 0); sc = sideFor(s0, count);
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
          var a = anchor(m);
          m.path.push([a[0], a[1], plateZ]); m.free = false; m.end = 'plate';
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
      var q = [m.id];
      while (q.length) {
        var id = q.shift();
        tr.members.push(id);
        M[id].parents.slice().sort(function (x, y) { return x - y; }).forEach(function (p) { q.push(p); });
      }
      trunks.push(tr);
    });
    out.trunks = trunks;
    /* Every trunk says which regions its beacons came from: the lookup a
       caller removes "this region's supports" by. */
    trunks.forEach(function (t) { t.regionIds = regionIdsOf(bc.beacons, t.beacons); });
    trunks.forEach(function (t) {
      if (t.landing === 'rest') t.beacons.forEach(function (id) { out.resting.push(id); });
      out.held += t.beacons.length;
    });
    out.toPlate = trunks.filter(function (t) { return t.landing === 'plate'; }).length;

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
    if (p.unreachable.length) parts.push(p.unreachable.length + ' unreachable from the plate');
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
  function memberSolid(P, m, foot) {
    var pts = m.path.slice();
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
    var first = unit(sub(pts[1], pts[0])), up = Math.abs(first[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
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

  /* A pad: an n-sided prism round (cx, cy) from z0 to z1, outward-wound, its
     k-th corner at radius rs[k] (all equal for a plain disc). */
  function discSoup(cx, cy, z0, z1, rs, phase) {
    var n = rs.length, out = new Float32Array(n * 4 * 9), w = 0;
    function tri(a, b, c) {
      out[w++] = a[0]; out[w++] = a[1]; out[w++] = a[2];
      out[w++] = b[0]; out[w++] = b[1]; out[w++] = b[2];
      out[w++] = c[0]; out[w++] = c[1]; out[w++] = c[2];
    }
    for (var k = 0; k < n; k++) {
      var k1 = (k + 1) % n, a0 = phase + 2 * Math.PI * k / n, a1 = phase + 2 * Math.PI * (k + 1) / n;
      var p0 = [cx + rs[k] * Math.cos(a0), cy + rs[k] * Math.sin(a0)], p1 = [cx + rs[k1] * Math.cos(a1), cy + rs[k1] * Math.sin(a1)];
      tri([cx, cy, z1], [p0[0], p0[1], z1], [p1[0], p1[1], z1]);
      tri([cx, cy, z0], [p1[0], p1[1], z0], [p0[0], p0[1], z0]);
      tri([p0[0], p0[1], z0], [p1[0], p1[1], z0], [p1[0], p1[1], z1]);
      tri([p0[0], p0[1], z0], [p1[0], p1[1], z1], [p0[0], p0[1], z1]);
    }
    return out;
  }

  /* The pad's corner radii: r everywhere, drawn in where something of the
     piece (or an occluder) stands within FOOT_GAP_MM of the pad's slab - a
     horizontal ray from the centre at four heights through the slab and the
     gap above it. A corner never goes in past the trunk's own corner, and
     takes the least of itself and its two neighbours, so a wall's edge
     cannot slip between two corners. */
  function footRadii(A, obstacles, cx, cy, plateZ, thick, r, side, phase) {
    var n = FOOT_SIDES, rs = [], hs = [0.02, thick / 2, thick, thick + 0.18];
    var floor = side / Math.SQRT2 + 0.01;
    for (var k = 0; k < n; k++) {
      var a = phase + 2 * Math.PI * k / n, d = [Math.cos(a), Math.sin(a), 0], best = r + FOOT_GAP_MM;
      for (var hi = 0; hi < hs.length && A; hi++) {
        var h = A._nearestHit(obstacles, [cx, cy, plateZ + hs[hi]], d, 0, best);
        if (h > 0 && h < best) best = h;
      }
      rs.push(Math.max(floor, Math.min(r, best - FOOT_GAP_MM)));
    }
    var out = [];
    for (k = 0; k < n; k++) out.push(Math.min(rs[(k + n - 1) % n], rs[k], rs[(k + 1) % n]));
    return out;
  }

  /* A pad's outline: the n corners discSoup draws, as [x, y] pairs. */
  function padPoly(cx, cy, rs, phase) {
    var n = rs.length, out = [];
    for (var k = 0; k < n; k++) {
      var a = phase + 2 * Math.PI * k / n;
      out.push([cx + rs[k] * Math.cos(a), cy + rs[k] * Math.sin(a)]);
    }
    return out;
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

  /* THE GAPS BETWEEN PADS. Pads that overlap in a ring round a small gap - the
     discs of a lattice of trunks, say - leave a hole in the first layer: a
     handle in the foot, and a ring where the slicer wants a disc. Each such
     gap is found on a raster of the pads' union (cell h, a hair of a mm), its
     outline taken one cell outside the gap so it overlaps the pads round it,
     and handed back as a prism the pads' own thickness. A gap is left alone,
     and counted, when anything of the piece (or what stands round it) is
     within FOOT_GAP_MM of it: that is a gap the pads were drawn in to keep.
     Pads whose outlines just touch are bridged first (below), so that the gap
     a third pad closes beside them is a gap the raster can see.
     pads: [{ poly, id }]  ->  { fills: [{ poly, owner }], bridges: [{ poly,
     owner }], found, left }; owner is the id of the pad the part belongs to. */
  function padGaps(A, obstacles, pads, plateZ, thick) {
    var res = { fills: [], bridges: [], found: 0, left: 0 }, n = pads.length, i, j;
    if (n < 2) return res;
    var parent = [], rmax = [], cen = [], polys = [], trunkOf = [];
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    for (i = 0; i < n; i++) {
      var c = [0, 0], r = 0;
      pads[i].poly.forEach(function (q) { c[0] += q[0] / pads[i].poly.length; c[1] += q[1] / pads[i].poly.length; });
      pads[i].poly.forEach(function (q) { r = Math.max(r, Math.hypot(q[0] - c[0], q[1] - c[1])); });
      cen.push(c); rmax.push(r); parent.push(i); polys.push(pads[i].poly); trunkOf.push(pads[i].id);
    }
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
      if (Math.hypot(cen[i][0] - cen[j][0], cen[i][1] - cen[j][1]) < rmax[i] + rmax[j] + BRIDGE_NEAR_MM) parent[find(i)] = find(j);
    }
    /* How far from its centre does pad i reach along unit u? */
    function reach(k, u) {
      var poly = polys[k], c0 = cen[k], best = 0;
      for (var e = 0; e < poly.length; e++) {
        var pa = poly[e], pb = poly[(e + 1) % poly.length];
        var ex = pb[0] - pa[0], ey = pb[1] - pa[1], den = u[0] * ey - u[1] * ex;
        if (Math.abs(den) < 1e-12) continue;
        var qx = pa[0] - c0[0], qy = pa[1] - c0[1];
        var t = (qx * ey - qy * ex) / den, w = (qx * u[1] - qy * u[0]) / den;
        if (t > 0 && w >= -1e-9 && w <= 1 + 1e-9 && t > best) best = t;
      }
      return best;
    }
    /* TOUCHING PADS. Two pads whose outlines only just meet - overlapping or
       parted by less than BRIDGE_NEAR_MM, as discs of r = 3 on a 6 mm lattice
       do - join through a hair-thin neck, and the sealed slivers beside it
       are far too thin to find on any raster. A bridge across the contact is
       a solid neck, and is itself a part of the pad. */
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) {
      if (find(i) !== find(j)) continue;
      var dx = cen[j][0] - cen[i][0], dy = cen[j][1] - cen[i][1], dd = Math.hypot(dx, dy);
      if (!(dd > 1e-9)) continue;
      if (dd > rmax[i] + rmax[j] + BRIDGE_NEAR_MM) continue;
      var u = [dx / dd, dy / dd], pen = reach(i, u) + reach(j, [-u[0], -u[1]]) - dd;
      if (!(Math.abs(pen) <= BRIDGE_NEAR_MM)) continue;
      var mid = [cen[i][0] + u[0] * (reach(i, u) - pen / 2), cen[i][1] + u[1] * (reach(i, u) - pen / 2)];
      var L = BRIDGE_LEN_MM / 2 + Math.abs(pen) / 2, W = BRIDGE_WIDTH_MM / 2, v = [-u[1], u[0]];
      var bp = [[-L, -W], [L, -W], [L, W], [-L, W]].map(function (q) {
        return [mid[0] + u[0] * q[0] + v[0] * q[1], mid[1] + u[1] * q[0] + v[1] * q[1]];
      });
      res.bridges.push({ poly: bp, owner: pads[i].id, mid: mid, pad: i });
    }
    var clusters = {};
    for (i = 0; i < n; i++) (clusters[find(i)] || (clusters[find(i)] = [])).push(i);
    var hs = [thick / 2, thick + 0.18];       /* the slab's middle, and the gap above it */
    function clear(x, y) {
      if (A) {
        if (A.lineInsideAt(obstacles, [x, y, plateZ + 0.01], [0, 0, 1], 0.2) >= 0) return false;
        if (A._nearestHit(obstacles, [x, y, plateZ - 0.01], [0, 0, 1], 0, thick + 0.18 + 0.01) > 0) return false;
        for (var hi = 0; hi < hs.length; hi++) for (var k = 0; k < 8; k++) {
          var a = Math.PI * k / 4;
          if (A._nearestHit(obstacles, [x, y, plateZ + hs[hi]], [Math.cos(a), Math.sin(a), 0], 0, FOOT_GAP_MM + 0.05) > 0) return false;
        }
      }
      return true;
    }
    res.bridges = res.bridges.filter(function (b) {
      return clear(b.mid[0], b.mid[1]) && clear(b.poly[0][0], b.poly[0][1]) && clear(b.poly[2][0], b.poly[2][1]);
    });
    res.bridges.forEach(function (b) {
      var k = polys.length;
      polys.push(b.poly); trunkOf.push(b.owner); cen.push(b.mid); rmax.push(BRIDGE_LEN_MM);
      clusters[find(b.pad)].push(k);
    });
    Object.keys(clusters).forEach(function (key) {
      var ids = clusters[key];
      if (ids.length < 3) return;
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      ids.forEach(function (id) { polys[id].forEach(function (q) {
        if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1];
      }); });
      var h = Math.max(GAP_CELL_MM, Math.sqrt((x1 - x0) * (y1 - y0) / GAP_CELLS_MAX));
      x0 -= 2 * h; y0 -= 2 * h;
      var nx = Math.ceil((x1 - x0) / h) + 3, ny = Math.ceil((y1 - y0) / h) + 3;
      var owner = new Int32Array(nx * ny).fill(-1);
      ids.forEach(function (id) {                                /* cell centres inside each outline (even-odd) */
        var poly = polys[id], m = poly.length, ymin = Infinity, ymax = -Infinity;
        poly.forEach(function (q) { if (q[1] < ymin) ymin = q[1]; if (q[1] > ymax) ymax = q[1]; });
        var j0 = Math.max(0, Math.floor((ymin - y0) / h - 0.5)), j1 = Math.min(ny - 1, Math.ceil((ymax - y0) / h - 0.5));
        for (var jj = j0; jj <= j1; jj++) {
          var yc = y0 + (jj + 0.5) * h, xs = [];
          for (var e = 0; e < m; e++) {
            var pa = poly[e], pb = poly[(e + 1) % m];
            if ((pa[1] <= yc) !== (pb[1] <= yc)) xs.push(pa[0] + (yc - pa[1]) / (pb[1] - pa[1]) * (pb[0] - pa[0]));
          }
          xs.sort(function (u, v) { return u - v; });
          for (var q2 = 0; q2 + 1 < xs.length; q2 += 2) {
            var i0 = Math.max(0, Math.ceil((xs[q2] - x0) / h - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[q2 + 1] - x0) / h - 0.5));
            for (var ii = i0; ii <= i1; ii++) owner[jj * nx + ii] = id;
          }
        }
      });
      /* the air that reaches the raster's edge is outside; what does not is a gap */
      var comp = new Int32Array(nx * ny).fill(-1), stack = [], ncomp = 0, at;
      function flood(seed, label) {
        var cells = [];
        stack.push(seed); comp[seed] = label;
        while (stack.length) {
          var cc = stack.pop(), cx = cc % nx, cy = (cc - cx) / nx, pc;
          cells.push(cc);
          if (cx > 0 && owner[pc = cc - 1] < 0 && comp[pc] < 0) { comp[pc] = label; stack.push(pc); }
          if (cx < nx - 1 && owner[pc = cc + 1] < 0 && comp[pc] < 0) { comp[pc] = label; stack.push(pc); }
          if (cy > 0 && owner[pc = cc - nx] < 0 && comp[pc] < 0) { comp[pc] = label; stack.push(pc); }
          if (cy < ny - 1 && owner[pc = cc + nx] < 0 && comp[pc] < 0) { comp[pc] = label; stack.push(pc); }
        }
        return cells;
      }
      flood(0, 0); ncomp = 1;
      var gaps = [];
      for (at = 0; at < nx * ny; at++) if (owner[at] < 0 && comp[at] < 0) gaps.push(flood(at, ncomp++));
      gaps.forEach(function (cells) {
        res.found++;
        var inD = new Uint8Array(nx * ny), loopCells = [];
        cells.forEach(function (cc) {
          var cx = cc % nx, cy = (cc - cx) / nx;
          for (var dy = -GAP_DILATE; dy <= GAP_DILATE; dy++) for (var dx = -GAP_DILATE; dx <= GAP_DILATE; dx++) {
            var px = cx + dx, py = cy + dy;
            if (px < 0 || py < 0 || px >= nx || py >= ny) continue;
            inD[py * nx + px] = 1;
          }
        });
        /* the outline of the dilated gap: unit edges with the cell on their left */
        var next = new Map(), vkey = function (a, b) { return a * (nx + 2) + b; };
        for (var cy2 = 0; cy2 < ny; cy2++) for (var cx2 = 0; cx2 < nx; cx2++) {
          if (!inD[cy2 * nx + cx2]) continue;
          loopCells.push(cy2 * nx + cx2);
          var open = function (px, py) { return px < 0 || py < 0 || px >= nx || py >= ny || !inD[py * nx + px]; };
          var edges = [];
          if (open(cx2, cy2 - 1)) edges.push([[cx2, cy2], [cx2 + 1, cy2]]);
          if (open(cx2 + 1, cy2)) edges.push([[cx2 + 1, cy2], [cx2 + 1, cy2 + 1]]);
          if (open(cx2, cy2 + 1)) edges.push([[cx2 + 1, cy2 + 1], [cx2, cy2 + 1]]);
          if (open(cx2 - 1, cy2)) edges.push([[cx2, cy2 + 1], [cx2, cy2]]);
          edges.forEach(function (ed) {
            var k0 = vkey(ed[0][0], ed[0][1]);
            if (!next.has(k0)) next.set(k0, []);
            next.get(k0).push(ed);
          });
        }
        var used = new Set(), best = null, bestA = 0;
        next.forEach(function (list) {
          list.forEach(function (start) {
            if (used.has(start)) return;
            var loop = [start[0]], cur = start;
            used.add(start);
            for (var g = 0; g < 4 * nx * ny; g++) {
              var cand = (next.get(vkey(cur[1][0], cur[1][1])) || []).filter(function (e2) { return !used.has(e2); });
              if (!cand.length) break;
              var e3 = cand[0];
              if (cand.length > 1) {                            /* a pinch: keep the loop on its left, turn left first */
                var dx0 = cur[1][0] - cur[0][0], dy0 = cur[1][1] - cur[0][1];
                cand.sort(function (u, v) {
                  var cu = dx0 * (u[1][1] - u[0][1]) - dy0 * (u[1][0] - u[0][0]);
                  var cv = dx0 * (v[1][1] - v[0][1]) - dy0 * (v[1][0] - v[0][0]);
                  return cv - cu;
                });
                e3 = cand[0];
              }
              used.add(e3);
              if (e3 === start) break;
              loop.push(e3[0]); cur = e3;
              if (e3[1][0] === start[0][0] && e3[1][1] === start[0][1]) break;
            }
            var A2 = 0;
            for (var q = 0; q < loop.length; q++) { var u = loop[q], v = loop[(q + 1) % loop.length]; A2 += u[0] * v[1] - v[0] * u[1]; }
            if (A2 > bestA) { bestA = A2; best = loop; }
          });
        });
        if (!best || best.length < 3) { res.left++; return; }
        var world = best.map(function (q) { return [x0 + q[0] * h, y0 + q[1] * h]; });
        world = simplifyLoop(world, 0.5 * h);
        var area2 = 0;
        for (var q3 = 0; q3 < world.length; q3++) {
          var u2 = world[q3], v2 = world[(q3 + 1) % world.length]; area2 += u2[0] * v2[1] - v2[0] * u2[1];
        }
        if (!(area2 > 0)) { res.left++; return; }
        /* clear of the piece at the outline's corners and the gap's middle */
        var step = Math.max(1, Math.ceil(world.length / 8)), samples = world.filter(function (q, k) { return k % step === 0; }), mid = [0, 0];
        cells.forEach(function (cc) { var cx = cc % nx, cy = (cc - cx) / nx; mid[0] += (x0 + (cx + 0.5) * h) / cells.length; mid[1] += (y0 + (cy + 0.5) * h) / cells.length; });
        samples.push(mid);
        for (var si = 0; si < samples.length; si++) if (!clear(samples[si][0], samples[si][1])) { res.left++; return; }
        /* the pad that owns it: the nearest of those whose outline reaches the dilated gap */
        var near = {}, nearest = -1, nd = Infinity;
        loopCells.forEach(function (cc) { var o = owner[cc]; if (o >= 0) near[o] = true; });
        Object.keys(near).forEach(function (k2) {
          var d = Math.hypot(cen[k2][0] - mid[0], cen[k2][1] - mid[1]);
          if (d < nd) { nd = d; nearest = +k2; }
        });
        if (nearest < 0) { res.left++; return; }
        res.fills.push({ poly: world, owner: trunkOf[nearest] });
      });
    });
    return res;
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
  function boxesTouch(a, b) {
    for (var k = 0; k < 3; k++) if (a.lo[k] > b.hi[k] + 1e-3 || b.lo[k] > a.hi[k] + 1e-3) return false;
    return true;
  }

  /* The parts of every trunk, in union order: the landing member, then up
     the tree breadth first, each member's pickup stubs right after it, the
     resting pad right after the root, gecko fingers last. */
  function trunkStepper(p, opts) {
    var P = PS(opts), T = ST(opts), A = SA(opts);
    if (!P || typeof P.sweep !== 'function') return { ok: false, reason: 'nso_path_sweep.js is not loaded' };
    var probe = makeProbe(A, [opts.rawTris || []].concat(opts.occluders || []));
    var foot = opts.footPads === false ? 0 : (opts.firstLayerMm == null ? FOOT_LAYER_MM : +opts.firstLayerMm);
    var out = [], placed = [], droppedFingers = 0, shafts = [], padList = [];
    /* Every contact's shaft near its tip, for the fingers to keep clear of. */
    if (p.style === 'gecko-hand') {
      p.members.forEach(function (m) {
        if (m.dead || m.beacon == null || m.path.length < 2) return;
        var d = unit(sub(m.path[1], m.path[0]));
        shafts.push({ beacon: m.beacon, a: m.path[0], b: add(m.path[0], mul(d, 3)), r: m.side / Math.SQRT2 });
      });
      p.stubs.forEach(function (st) { shafts.push({ beacon: st.beacon, a: st.to, b: st.via, r: st.side / Math.SQRT2 }); });
    }
    /* One trunk's parts: null once swept, { ok: false, reason } when a member
       would not sweep. */
    function step(t) {
      var tr = p.trunks[t], parts = [], fingers = [];
      for (var i = 0; i < tr.members.length; i++) {
        var m = p.members[tr.members[i]];
        var ms = memberSolid(P, m, foot);
        if (!ms.ok) return { ok: false, reason: ms.reason };
        m.points = ms.points;
        parts = parts.concat(ms.soups.map(function (x) { return { soup: x }; }));
        if (foot && i === 0 && tr.landing === 'plate') {
          /* The foot: one first layer, a disc round the landing point. Pads of
             trunks that stand close overlap and join in solid()'s union. */
          var fa = ms.points[ms.points.length - 1], fr = Math.max(FOOT_MIN_R_MM, FOOT_HALF_WIDTHS * m.side / 2);
          var fph = 0.37 * (t + 1);
          var frs = footRadii(A, [opts.rawTris || []].concat(opts.occluders || []), fa[0], fa[1], p.plateZ, foot, fr, m.side, fph);
          parts.push({ soup: discSoup(fa[0], fa[1], p.plateZ, p.plateZ + foot, frs, fph), foot: true });
          padList.push({ poly: padPoly(fa[0], fa[1], frs, fph), id: t });
        }
        if (m.pad) {
          var h = Math.max(2 * m.side, 2.82) / 2, a = m.path[m.path.length - 1];
          parts.push({ soup: boxSoup([a[0] - h, a[1] - h, m.pad.z0], [a[0] + h, a[1] + h, m.pad.z1]) });
        }
        p.stubs.forEach(function (s) {
          if (s.member !== m.id) return;
          /* Started AT the pickup point: it lies on the column's axis, inside
             both the column it leaves and the one below, and is no vertex of
             either. Run back a quarter side instead, the stub's start landed
             within 0.2 mm of the parent column's run-on end, and the union
             pinched there (2 non-manifold edges on a box tilted 30 deg). */
          var sw = P.sweep({ points: [s.from, s.via, s.to], profile: squareProfile(s.side, phaseOf(p.members.length + s.beacon + 1)), up: [0, 1, 0] });
          if (sw.ok) { parts.push({ soup: sw.tris, stub: true }); s.soup = sw.tris; }
        });
        if (p.style === 'gecko-hand' && T && T._geckoHand) {
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
      /* The gaps between pads that overlap in a ring are filled, each by the
         pad nearest it, so every group of pads is one disc-shaped slab. */
      var gaps = { fills: [], found: 0, left: 0 };
      if (foot && opts.padGaps !== false) {
        gaps = padGaps(A, [opts.rawTris || []].concat(opts.occluders || []), padList, p.plateZ, foot);
        gaps.bridges.forEach(function (b) {
          var soup = prismSoup(b.poly, p.plateZ, p.plateZ + foot);
          if (soup) { out[b.owner].parts.push({ soup: soup, foot: true, bridge: true }); gaps.bridged = (gaps.bridged || 0) + 1; }
        });
        gaps.fills.forEach(function (f) {
          var soup = prismSoup(f.poly, p.plateZ, p.plateZ + foot);
          if (!soup) { gaps.left++; return; }
          out[f.owner].parts.push({ soup: soup, foot: true, fill: true });
          gaps.filled = (gaps.filled || 0) + 1;
        });
      }
      out.forEach(function (o) { o.parts = o.parts.concat(o.fingerParts); delete o.fingerParts; });
      return { ok: true, trunks: out, fingersDropped: droppedFingers, padGaps: { found: gaps.found, filled: gaps.filled || 0, bridged: gaps.bridged || 0, left: gaps.left } };
    }
    return { ok: true, n: p.trunks.length, step: step, finish: finish };
  }
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
     solid(), a trunk at a time, with opts.onProgress told 'building', trunks
     swept / trunks, and opts.yieldFn given a turn between trunks. Resolves
     { ok: false, reason } when a member would not sweep. */
  function parts(p, opts) {
    opts = opts || {};
    if (!p || !p.ok) return Promise.resolve({ ok: false, reason: (p && p.reason) || 'no plan' });
    if (!p.trunks.length) return Promise.resolve({ ok: true, trunks: [], fingersDropped: 0, padGaps: { found: 0, filled: 0, bridged: 0, left: 0 } });
    var sp = trunkStepper(p, Object.assign({}, opts, { rawTris: opts.rawTris || p.rawTris, occluders: opts.occluders || p.occluders }));
    if (!sp.ok) return Promise.resolve(sp);
    var say = progressOf(opts), t = 0;
    say('building', 0, sp.n, true);
    function run() {
      while (t < sp.n) {
        var r = sp.step(t++);
        if (r) return r;
        say('building', t, sp.n);
        var y = opts.yieldFn && opts.yieldFn();
        if (y && typeof y.then === 'function') return y.then(run);
      }
      var done = sp.finish();            /* the pad gaps: one call, after the last trunk */
      if (done.ok) say('building', sp.n, sp.n, true);
      return done;
    }
    return new Promise(function (go) { go(run()); });
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
    tp.trunks.forEach(function (tr) {
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
        solids.push({ soup: fin.soup, box: bounds(fin.soup), trunks: [tr.trunk] });
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
                A.soup = { soup: fin.soup, box: bounds(fin.soup), trunks: A.soup.trunks.concat(B.soup.trunks) };
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
      return rounds().then(function () {
        var out = groups.map(function (g) { return g.soup; });
        /* Each solid carries what it holds: its trunks' beacon ids, their
           regions, and where it lands ('plate', 'rest', or 'mixed'). A
           support built from one solid is then labelled by lookup. */
        out.forEach(function (x) {
          var ids = [], lands = {};
          x.trunks.slice().sort(function (a, b) { return a - b; }).forEach(function (t) {
            var tr = p.trunks[t];
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
               padGaps: tp.padGaps,
               partSoups: [].concat.apply([], tp.trunks.map(function (t) { return t.parts.map(function (x) { return x.soup; }); })),
               hollow: hollow, solidSoup: hollow ? hollow.solidSoup : null,
               reason: p.reason + (hollow ? ' ' + hollow.reason : '') };
    }).catch(function (err) {
      return { ok: false, reason: 'the support would not join into one solid: ' + ((err && err.message) || err) };
    });
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

  /* plan() keeps what solid() needs to clear gecko fingers. */
  function planSupport(rawTris, opts) {
    var p = plan(rawTris, opts);
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
    solid: solid,
    parts: parts,
    weld: weld,
    describe: describe,
    _sideFor: sideFor,
    _squareProfile: squareProfile,
    _earClip: earClip,
    _prismSoup: prismSoup,
    _padGaps: padGaps,
    _memberSolid: function (m, foot, opts) { return memberSolid(PS(opts || {}), m, foot); },
    _phaseOf: phaseOf,
    _makeProbe: makeProbe
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SupportGridpack = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
