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
   (BRANCH_TILT_DEG, 31.44 deg, the reference's widest branch), node
   lattice L (5 mm), and merge eagerness (the Style: 'strut' 0, 'tree' 1).

   BEACONS. The support points. Each is { p, n } - a point on the surface
   and its outward normal. Today they come from gridBeacons() below, which
   grids detectOverhangs' regions at the contact pitch through
   NSO_SupportTree.contactPoints. claude/support-beacons is building the
   real detector (NSO_SupportBeacons.detect); beaconsFor() is the one place
   that swaps over, and opts.beacons takes a list directly.

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

   LANDING. Plate first, always. A member with no route to the plate:
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
   gridBeacons(rawTris, opts)  -> { ok, reason, beacons, detect, regions }
   plan(rawTris, opts)         -> { ok, reason, members, merges, trunks, ... }
   solid(plan, opts)           -> Promise { ok, soup, solids, reason }; opts.hollow
                                  bores every member (BORES), hollowWallMm, minBoreMm
   describe(plan)              -> one plain status line
   opts: skipList (required, as detectOverhangs), angleDeg, occluders,
         regionId, sideMm, style ('strut' | 'tree' | 'gecko-hand'),
         branchTiltDeg, latticeMm, pitchMm, restOnModel, beacons
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
  var EAGERNESS = { strut: 0, tree: 1, 'gecko-hand': 1 };

  function SA(o) { return (o && o.supportAim) || (root && root.NSO_SupportAim) || null; }
  function ST(o) { return (o && o.supportTree) || (root && root.NSO_SupportTree) || null; }
  function PS(o) { return (o && o.pathSweep) || (root && root.NSO_PathSweep) || null; }

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
     BEACONS - the adapter. Today's detectOverhangs regions, gridded at the
     contact pitch by the same contactPoints the tree used, each point
     carrying the normal of the region triangle under it.
     ===================================================================== */
  function gridBeacons(rawTris, opts) {
    opts = opts || {};
    var A = SA(opts), T = ST(opts);
    if (!A || !T) return { ok: false, reason: 'nso_support_aim.js and nso_support_tree.js must be loaded', beacons: [] };
    var det = A.detectOverhangs(rawTris, opts);
    if (!det.ok) return { ok: false, reason: det.reason, detect: det, beacons: [] };
    var regions = opts.regionId == null ? det.regions : det.regions.filter(function (r) { return r.id === (opts.regionId | 0); });
    if (opts.regionId != null && !regions.length) {
      return { ok: false, reason: 'there is no overhang ' + ((opts.regionId | 0) + 1) + ' on this piece', detect: det, beacons: [] };
    }
    /* The pitch is the contact span, or wider when the strut is. A pair's
       merge node sits half a pitch along a row, so the next row's points are
       sqrt(5)/2 pitches from it; the merged column must clear them (touch()),
       or no merge can ever go ahead. 3.29 mm holds up to a 1.9 mm strut; a
       2 mm strut gets 3.41, a 3 mm one 4.94. */
    var st = A.buildStrut(opts), side = st.ok ? st.sideMm : 0;
    var pitch = Math.max(opts.pitchMm == null ? T.MAX_SPAN_MM : +opts.pitchMm,
                         touch(sideFor(side, 2), side) / (Math.sqrt(5) / 2));
    var out = [];
    regions.forEach(function (r) {
      var cp = T.contactPoints(rawTris, r, { maxSpanMm: pitch });
      if (!cp.ok) return;
      cp.points.forEach(function (c) {
        var n = r.normal, bestZ = null;
        for (var i = 0; i < r.tris.length; i++) {
          var o = r.tris[i] * 9, tri = [[rawTris[o], rawTris[o + 1], rawTris[o + 2]],
            [rawTris[o + 3], rawTris[o + 4], rawTris[o + 5]], [rawTris[o + 6], rawTris[o + 7], rawTris[o + 8]]];
          var z = T._zOnTriAt(tri, c.p[0], c.p[1]);
          if (z == null || Math.abs(z - c.p[2]) > 1e-4 || (bestZ != null && z >= bestZ)) continue;
          bestZ = z; n = unit(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]))) || r.normal;
        }
        out.push({ id: out.length, p: c.p.slice(), n: n.slice(), regionId: r.id, source: c.source });
      });
    });
    return { ok: true, reason: out.length + ' support point(s)', beacons: out, detect: det, regions: regions, pitchMm: pitch };
  }

  /* The ONE place the beacon source is chosen. Swap to
     NSO_SupportBeacons.detect here when claude/support-beacons lands. */
  function beaconsFor(rawTris, opts) {
    if (opts.beacons) {
      var A = SA(opts), det = A.detectOverhangs(rawTris, opts);
      return { ok: det.ok, reason: det.reason, detect: det, regions: det.regions || [],
               pitchMm: opts.pitchMm == null ? ST(opts).MAX_SPAN_MM : +opts.pitchMm,
               beacons: opts.beacons.map(function (b, i) { return { id: i, p: b.p.slice(), n: (unit(b.n) || [0, 0, -1]).slice(), regionId: b.regionId, source: b.source || 'given' }; }) };
    }
    return gridBeacons(rawTris, opts);
  }

  /* =====================================================================
     CLEARANCE - one leg, axis and rails, against the piece and occluders.
     ===================================================================== */
  function makeProbe(A, obstacles) {
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
    var A = SA(opts), T = ST(opts);
    if (!A || !T || typeof A.detectOverhangs !== 'function') {
      out.reason = 'nso_support_aim.js and nso_support_tree.js must be loaded'; return out;
    }
    var style = opts.style == null ? 'tree' : String(opts.style);
    if (!(style in EAGERNESS)) { out.reason = 'unknown support style ' + JSON.stringify(opts.style); return out; }
    var eager = opts.mergeEagerness == null ? EAGERNESS[style] : +opts.mergeEagerness;
    out.style = style; out.eagerness = eager;

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
    var next = 0;
    for (var k = kTop; k >= 0; k--) {
      var zk = plateZ + k * g;

      /* 1. beacons above this level start (or are picked up) */
      while (next < live.length && live[next].p[2] > zk + 1e-9) {
        var b = live[next++];
        var sideBeacon = b.n[2] > -cosT;
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
      }

      /* 2. merges at this level */
      if (eager > 0 && k > 0) {
        var free = M.filter(function (m) { return m.free && !m.dead && anchor(m)[2] > zk + 1e-9; });
        var cand = [];
        for (var i = 0; i < free.length; i++) {
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
    }
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
  function memberSolid(P, m) {
    var pts = m.path.slice();
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
  function trunkParts(p, opts) {
    var P = PS(opts), T = ST(opts), A = SA(opts);
    if (!P || typeof P.sweep !== 'function') return { ok: false, reason: 'nso_path_sweep.js is not loaded' };
    var probe = makeProbe(A, [opts.rawTris || []].concat(opts.occluders || []));
    var out = [], placed = [], droppedFingers = 0, shafts = [];
    /* Every contact's shaft near its tip, for the fingers to keep clear of. */
    if (p.style === 'gecko-hand') {
      p.members.forEach(function (m) {
        if (m.dead || m.beacon == null || m.path.length < 2) return;
        var d = unit(sub(m.path[1], m.path[0]));
        shafts.push({ beacon: m.beacon, a: m.path[0], b: add(m.path[0], mul(d, 3)), r: m.side / Math.SQRT2 });
      });
      p.stubs.forEach(function (st) { shafts.push({ beacon: st.beacon, a: st.to, b: st.via, r: st.side / Math.SQRT2 }); });
    }
    for (var t = 0; t < p.trunks.length; t++) {
      var tr = p.trunks[t], parts = [], fingers = [];
      for (var i = 0; i < tr.members.length; i++) {
        var m = p.members[tr.members[i]];
        var ms = memberSolid(P, m);
        if (!ms.ok) return { ok: false, reason: ms.reason };
        m.points = ms.points;
        parts = parts.concat(ms.soups.map(function (x) { return { soup: x }; }));
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
      out.push({ trunk: t, parts: parts.concat(fingers), fingers: fingers.length });
    }
    return { ok: true, trunks: out, fingersDropped: droppedFingers };
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
    var T = ST(opts);
    if (!p || !p.ok) return Promise.resolve({ ok: false, reason: (p && p.reason) || 'no plan' });
    if (!p.trunks.length) return Promise.resolve({ ok: true, soup: new Float32Array(0), solids: [], reason: p.reason });
    var tp = trunkParts(p, Object.assign({}, opts, { rawTris: opts.rawTris || p.rawTris, occluders: opts.occluders || p.occluders }));
    if (!tp.ok) return Promise.resolve({ ok: false, reason: tp.reason });
    var U = opts.unionSoups || (root && root.NSO_unionSoups);
    if (typeof U !== 'function') return Promise.resolve({ ok: false, reason: 'app-join.js is not loaded - NSO_unionSoups joins the support' });
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
          });
        });
      });
      chain = chain.then(function () {
        var fin = T._finishUnion(acc);
        solids.push({ soup: fin.soup, box: bounds(fin.soup), trunks: [tr.trunk] });
      });
    });
    /* Trunks whose boxes meet are offered to the union, pair by pair; it
       joins them only when they really touch. Iterative, not recursive: a
       wide region has a hundred trunks. */
    var group = [], soupOf = [];
    chain = chain.then(function () {
      solids.forEach(function (x, i) { group.push(i); soupOf.push(x); });
      function find(i) { while (group[i] !== i) i = group[i] = group[group[i]]; return i; }
      var c2 = Promise.resolve();
      for (var i = 0; i < solids.length; i++) {
        for (var j = i + 1; j < solids.length; j++) {
          if (!boxesTouch(solids[i].box, solids[j].box)) continue;
          (function (i, j) {
            c2 = c2.then(function () {
              var ri = find(i), rj = find(j);
              if (ri === rj) return null;
              return U(soupOf[ri].soup, soupOf[rj].soup).then(function (r) {
                if (!(r && r.ok)) return;
                var fin = T._finishUnion(r.soup);
                group[rj] = ri;
                soupOf[ri] = { soup: fin.soup, box: bounds(fin.soup), trunks: soupOf[ri].trunks.concat(soupOf[rj].trunks) };
              });
            });
          })(i, j);
        }
      }
      return c2.then(function () {
        var out = [];
        for (var k = 0; k < solids.length; k++) if (find(k) === k) out.push(soupOf[k]);
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
    describe: describe,
    _sideFor: sideFor,
    _squareProfile: squareProfile,
    _phaseOf: phaseOf,
    _makeProbe: makeProbe
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SupportGridpack = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
