/* ============================================================
   nso_support_beacons.js - where a piece needs holding, sampled on a plan grid
   from below. One beacon per spot that needs holding, not one region per
   cluster of flagged triangles.

   Loads as a classic script (window.NSO_SupportBeacons) and as a Node module
   (require('../nso_support_beacons.js')). No DOM, no THREE. A mesh is the
   app's raw soup - 9 numbers per triangle, Z up, millimetres - the same input
   nso_support_aim.js takes.

   ---------------------------------------------------------------------------
   WHY THIS REPLACES THE PER-TRIANGLE TEST
   ---------------------------------------------------------------------------
   detectOverhangs (nso_support_aim.js) flags a whole triangle by one ray down
   from its centroid and clusters the flagged triangles into regions with one
   aim point each. Three things follow from that, all of them wrong for a
   support planner:
     - it depends on tessellation: one huge underside triangle is one flag, a
       fine mesh of the same face is thousands, and a triangle half over a
       boss is flagged, or not, whole;
     - it misses what has no triangle of its own to flag: a bridge is just a
       flat face, a downward edge between two printable faces is no face at
       all, a tip is a vertex;
     - it hands the planner a region, not coverage. Where inside the region
       needs a contact is left to whoever reads it.

   Here the question is asked of PLACES instead of triangles. A plan grid at
   `pitch` mm is laid over the piece's footprint; from every cell a ray goes
   straight up from the plate and every surface it crosses is walked, not
   just the first. At each downward-facing crossing with air below it, the
   spot either needs holding or it does not, and if it does it gets a beacon.
   The answer depends on the shape, not on how the shape was cut into
   triangles: the tilted-box gate in tools/nso_support_beacons_test.js gives
   the same count for a 2-triangle underside and a 2048-triangle one.

   ---------------------------------------------------------------------------
   EXPOSED ONLY
   ---------------------------------------------------------------------------
   A beacon counts only if the air at its spot reaches the outside of the
   piece. That is all this module asks: it is geometry, and it does not ask
   what is under the spot. A shelf over its own base, a bridge over its own
   foot and the underside of an arch are all exposed - air runs out from under
   them - and each gets its beacons. Whether a support can GET there is the
   planner's question (nso_support_gridpack.js: the plate first, round the
   piece within the lean budget, the piece only when restOnModel is on;
   what is left is counted unreachable).

   What is left out is the INSIDE of a closed piece: cavity ceilings, the
   walls and floors of a sealed void - spots whose air has no way out. The
   test is rays from the spot: first along its own normal (the cheap, common
   case), then a fan over the hemisphere the normal faces, 16 headings at each
   of 0.5, 5, 15, 30, 50 and 70 deg above the face's own plane. If any of them
   leaves the piece's bounding box without meeting the piece, the air has a
   way out. The piece's own triangles only: another piece in the way (an
   occluder) does not make a spot interior. counts.interior is how many
   candidates were left out; counts.sheltered is how many were kept although
   their own normal runs into the piece (the shelf, the arch).

   A fan is a sample, not a proof: a long tunnel narrower than its length
   divided by ~115 (the 0.5 deg ray) and not along a face's own heading could
   slip through it and be counted interior. A sealed cavity cannot be taken
   for open - no ray gets out of it.

   ---------------------------------------------------------------------------
   THE FOUR WAYS A SPOT NEEDS HOLDING (need.kind)
   ---------------------------------------------------------------------------
   Every crossing is first required to have air under it: the gap down to the
   material or plate below must exceed minDropMm (0.5 mm, nso_support_aim.js's
   own figure - below it the face is resting, not hanging). Then:

   face   the face there is steeper than the overhang angle - 45 deg from
          vertical by default, the threshold detectOverhangs and every slicer
          in the README already use - measured from the triangle normal:
          n.z < -cos(angleDeg). Open to the plate below.

   gap    the same steep face, but the air under it is bounded: material
          below it (undercut, the underside of a shelf over its own base; a
          cavity ceiling too, which EXPOSED ONLY above then drops), or a near-flat face anchored on
          both sides along x or y (a bridge) whose span is wider than the
          bridgeable span, 5 mm by default. A flat face anchored on both
          sides by a span of 5 mm or less is BRIDGED and gets no beacon - the
          one place this module decides something does not need holding that
          the angle alone would hold. 5 mm is stated, not measured: it is
          comfortably inside what any slicer bridges unsupported, so it errs
          towards support, which is the direction asked for.

   edge / tip   a downward feature no centre ray hits squarely. Three nets:
          (1) every cell's four corners are sampled too, and a corner that
              hits something needing holding where the centre ray has no
              downward crossing within one pitch in z marks the cell (a thin
              rib or fin running between the centres);
          (2) a downward crease - an edge both of whose faces rise away from
              it, the faces more than 30 deg apart, the edge itself flatter
              than the overhang angle - is sampled at half-pitch along its
              length (a knife edge under two printable faces);
          (3) a vertex lower than every neighbour, with air under it (a tip).
          (2) and (3) only add a beacon to a cell that does not already have
          one within one pitch in z.

   ridge  a near-vertical feature with small horizontal ribs - a thread, a
          fin stack - where the face needs holding but there is no room to
          come up from below: material within ridgeGapMm (3 mm) under it, the
          rib reaching no more than ridgeReachMm (3 mm) out from the wall it
          hangs off, and open air laterally. That spot gets a SIDE beacon:
          its normal is the lateral approach direction (horizontal, out of
          the wall), and it sits on the rib's underside 0.35 mm off the wall -
          0.35 mm being the support/object XY distance Bambu Studio ships, so
          a lateral support stood where the beacon says clears the wall by
          exactly the gap the slicer would keep.

   ---------------------------------------------------------------------------
   A BEACON
   ---------------------------------------------------------------------------
   { x, y, z, normal, need: { angle, gapBelow, kind, ... }, cell: [i, j], tri }
     z       ON the surface. Interface offset is the planner's job.
     normal  unit, pointing from the surface toward where a support comes
             from: the face's own outward normal, or for a side beacon the
             lateral approach direction (n.z = 0).
     need.angle     the surface's tilt off horizontal, deg (0 = flat ceiling).
     need.gapBelow  air under the spot, mm, down to material or the plate.
     need.below     'plate' or 'material'.
     tri     the triangle of the piece the beacon sits on. Diagnostic only -
             the one tessellation-dependent number in the record.

   One beacon per needing crossing per cell, so a cavity ceiling above a
   floor that itself overhangs gives two beacons in one cell, at different z.

   ---------------------------------------------------------------------------
   REGIONS, for callers that still read regions
   ---------------------------------------------------------------------------
   Beacons in 8-adjacent cells within 1.5 pitch of each other in z are one
   region; region.point is the centroid of its beacons, region.beacons the
   members. detectOverhangs attaches these as det.beaconRegions and hangs each
   legacy region's own beacons off it as region.beacons; see docs/SUPPORT-
   BEACONS.md for why its triangle regions are kept alongside rather than
   replaced.

   ---------------------------------------------------------------------------
   PAINT
   ---------------------------------------------------------------------------
   opts.skipList is read exactly as nso_support_aim.js reads it (the
   nsoMaskFaceList entries). A crossing on a painted face is still material -
   it blocks what is above it - but gets no beacon. detect() itself takes []
   when no list is passed; detectOverhangs, which keeps the "no unpainted
   default" rule, refuses before it ever gets here.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   detect(rawTris, opts) -> { ok, reason, beacons, grid: {pitch, origin, nx, ny},
                              regions, counts }
   regionsOf(beacons, grid) -> regions
   ============================================================ */
(function (root) {
  'use strict';

  var PITCH_DEFAULT_MM = 3;          /* the ask: denser than Bambu's ~3.9 mm equivalent */
  var ANGLE_DEFAULT_DEG = 45;        /* nso_support_aim.js ANGLE_DEFAULT_DEG */
  var MIN_DROP_MM = 0.5;             /* nso_support_aim.js minDropMm default */
  var BRIDGE_DEFAULT_MM = 5;         /* bridgeable span, stated */
  var BRIDGE_TILT_MAX_DEG = 10;      /* a face this close to flat can be bridged */
  var SIDE_STANDOFF_MM = 0.35;       /* Bambu Studio's support/object XY distance */
  var RIDGE_GAP_MM = 3;              /* less room than this below: no support from below */
  var RIDGE_REACH_MM = 3;            /* a rib longer than this is an overhang, not a rib */
  var CREASE_MIN_DEG = 30;           /* faces closer than this are one curved surface */
  var INSET_PRODUCT_MM = 1;          /* what the Supports card asks (opts.insetMm): a spot stands at least this far in from the edge of the surface it holds, so a column (1.2 mm) and the lines round it stay on the part. Off (0) unless asked: the planner suites pin the spots where the grid put them */
  var FOOT_TOL_MM = 0.4;             /* the footprint: the flood's first step from a spot may find the surface this far (plus a step's climb) from the spot's own height; each later step, an eighth of it plus the step's climb */
  var FLAT_NZ = Math.cos(3 * Math.PI / 180);   /* a face is flat, for moving a spot in it, within 3 deg of the plate */
  var BRIDGE_MIN_PRODUCT_MM = 1.3;   /* what the Supports card asks (opts.bridgeMinMm): a flat face between two walls closer than this is a ledge Bambu holds (the Circular and Sphere heads' four corners), not a span anything bridges */
  var SEED_PITCH_MM = 1;             /* what the Supports card asks (opts.seedPitchMm): a second, finer look for the surfaces the grid stepped over */
  var SEED_MARGIN_MM = 0.6;          /* a fine hit this near a footprint is that footprint's edge, not a surface of its own */
  var SEED_MIN_DROP_MM = 2;          /* a seed has this much air under it at least: a face within a couple of mm of the plate is held by the first layers (the planner stands nothing under it) */
  var SEED_NEAR_MM = 3;              /* ...and it is no more than the rest of a surface the grid already holds: a seeded surface within this far of a footprint at its height is that surface's own far edge (a crescent of rim), held by the spots and the sheet there */
  var SEED_MIN_AREA_MM2 = 1.5;       /* a seeded area whose footprint is smaller than this is not held (Bambu leaves such specks bare) */
  var LEDGE_MIN_AREA_MM2 = 0.15;     /* ...except a ledge between two walls (opts.bridgeMinMm), which Bambu does hold: the corners of a square head on a round post are 0.4 - 0.8 mm2 each, read 0.2 - 0.4 off the 0.25 mm footprint step */
  var LEDGE_PITCH_MM = 0.5;          /* the look that finds them: a ledge 0.7 mm across falls between the samples at 1 mm */
  var LEDGE_MAX_CELLS = 400000;      /* ...and only on a plate-sized piece's worth of cells at that pitch */
  var FOOT_STEP_MM = 0.25;           /* the footprint's sample step (a cell is pitch / round(pitch / step) of it) */
  var SAME_Z_MM = 1e-4;              /* two hits this close on one ray are one crossing */
  var HIT_EPS_MM = 1e-3;
  var FAN_AZIMUTHS = 16;             /* exposed-only fan: headings round a blocked spot's normal... */
  var FAN_ELEVATIONS_DEG = [0.5, 5, 15, 30, 50, 70];   /* ...each at these angles above the face's own plane */

  /* ---- ray / triangle, double-sided. The same Moller-Trumbore
     nso_support_aim.js writes out, for the same reason it gives. ---- */
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

  function triNormal(soup, o) {
    var ux = soup[o + 3] - soup[o], uy = soup[o + 4] - soup[o + 1], uz = soup[o + 5] - soup[o + 2];
    var vx = soup[o + 6] - soup[o], vy = soup[o + 7] - soup[o + 1], vz = soup[o + 8] - soup[o + 2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(L > 1e-15)) return null;
    return [nx / L, ny / L, nz / L];
  }

  /* Same rule as nso_support_aim.js onSkippedFace. */
  function onSkippedFace(n, o, soup, skipList, planeTol) {
    for (var i = 0; i < skipList.length; i++) {
      var e = skipList[i];
      if (e == null || e.axisIdx == null) continue;
      var k = e.axisIdx | 0;
      if (Math.abs(n[k]) < 0.999) continue;
      if ((n[k] >= 0 ? 1 : -1) !== (e.keepMin ? -1 : 1)) continue;
      if (e.d == null) return true;
      if (Math.abs(soup[o + k] - e.d) < planeTol) return true;
    }
    return false;
  }

  /* ---- an index for rays along one cardinal axis. Every triangle is filed
     by its extent in the two coordinates across the axis, so a ray along
     the axis only ever tests the handful in its own bucket. Built once per
     axis (z for the columns, x and y for the bridge and ridge probes). ---- */
  function buildAxisIndex(tris, axis) {
    var a = (axis + 1) % 3, b = (axis + 2) % 3;
    var mna = Infinity, mxa = -Infinity, mnb = Infinity, mxb = -Infinity, k;
    for (k = 0; k < tris.length; k++) {
      var T = tris[k];
      if (T.lo[a] < mna) mna = T.lo[a];
      if (T.hi[a] > mxa) mxa = T.hi[a];
      if (T.lo[b] < mnb) mnb = T.lo[b];
      if (T.hi[b] > mxb) mxb = T.hi[b];
    }
    var side = Math.max(1, Math.min(256, Math.round(Math.sqrt(tris.length))));
    var wa = Math.max(mxa - mna, 1e-6) / side, wb = Math.max(mxb - mnb, 1e-6) / side;
    var cells = new Array(side * side);
    for (k = 0; k < tris.length; k++) {
      var t = tris[k];
      var i0 = Math.max(0, Math.min(side - 1, Math.floor((t.lo[a] - mna) / wa)));
      var i1 = Math.max(0, Math.min(side - 1, Math.floor((t.hi[a] - mna) / wa)));
      var j0 = Math.max(0, Math.min(side - 1, Math.floor((t.lo[b] - mnb) / wb)));
      var j1 = Math.max(0, Math.min(side - 1, Math.floor((t.hi[b] - mnb) / wb)));
      for (var i = i0; i <= i1; i++) for (var j = j0; j <= j1; j++) {
        var c = j * side + i;
        if (!cells[c]) cells[c] = [];
        cells[c].push(t);
      }
    }
    return { axis: axis, a: a, b: b, side: side, mna: mna, mnb: mnb, wa: wa, wb: wb, cells: cells };
  }

  /* Every crossing of the whole line through p along the index's axis, as
     { s: coordinate along the axis, T }, sorted by s. The ray starts below
     everything (origin = sMin - 1) so one pass sees both directions. */
  function lineHits(ix, p, sMin) {
    var a = ix.a, b = ix.b, ax = ix.axis;
    var i = Math.max(0, Math.min(ix.side - 1, Math.floor((p[a] - ix.mna) / ix.wa)));
    var j = Math.max(0, Math.min(ix.side - 1, Math.floor((p[b] - ix.mnb) / ix.wb)));
    var list = ix.cells[j * ix.side + i];
    var out = [];
    if (!list) return out;
    var o = [p[0], p[1], p[2]];
    o[ax] = sMin - 1;
    var d = [0, 0, 0];
    d[ax] = 1;
    for (var k = 0; k < list.length; k++) {
      var T = list[k];
      if (p[a] < T.lo[a] || p[a] > T.hi[a] || p[b] < T.lo[b] || p[b] > T.hi[b]) continue;
      var tt = rayTri(o[0], o[1], o[2], d[0], d[1], d[2], T.soup, T.o);
      if (tt > 0) out.push({ s: o[ax] + tt, T: T });
    }
    out.sort(function (u, v) { return u.s - v.s; });
    return out;
  }

  /* Hits on one ray that land on a shared edge or vertex come back once per
     triangle. Collapse them: same place, same facing along the ray, one
     crossing. Opposite facings at the same place are kept - that is a thin
     wall or two pieces touching, and both crossings are real. */
  function dedupe(hits, axis) {
    var out = [];
    for (var k = 0; k < hits.length; k++) {
      var h = hits[k], sg = h.T.n[axis] > 0 ? 1 : -1, dup = false;
      for (var m = out.length - 1; m >= 0 && h.s - out[m].s < SAME_Z_MM; m--) {
        if ((out[m].T.n[axis] > 0 ? 1 : -1) === sg) { dup = true; break; }
      }
      if (!dup) out.push(h);
    }
    return out;
  }

  /* ===================================================================== */
  function detect(rawTris, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '', beacons: [], grid: null, regions: [], counts: null };
    if (!rawTris || rawTris.length < 9 || (rawTris.length % 9) !== 0) {
      out.reason = 'not a triangle soup'; return out;
    }
    if (opts.skipList === null) {
      out.reason = 'a painted face has no axis and side to name it by, so it cannot be ' +
        'scoped out of the beacon scan - clear the paint or paint a flat face';
      return out;
    }
    var skipList = opts.skipList || [];
    var pitch = (opts.pitch == null) ? PITCH_DEFAULT_MM : +opts.pitch;
    if (!(pitch > 0)) { out.reason = 'pitch must be positive, got ' + opts.pitch; return out; }
    var angleDeg = (opts.angleDeg == null) ? ANGLE_DEFAULT_DEG : +opts.angleDeg;
    if (!(angleDeg > 0 && angleDeg < 90)) {
      out.reason = 'angleDeg must be between 0 and 90 exclusive, got ' + opts.angleDeg; return out;
    }
    var nzMax = -Math.cos(angleDeg * Math.PI / 180);
    var minDrop = (opts.minDropMm == null) ? MIN_DROP_MM : +opts.minDropMm;
    var bridgeMm = (opts.bridgeMm == null) ? BRIDGE_DEFAULT_MM : +opts.bridgeMm;
    var bridgeTiltMax = (opts.bridgeTiltMaxDeg == null) ? BRIDGE_TILT_MAX_DEG : +opts.bridgeTiltMaxDeg;
    var bridgeMin = (opts.bridgeMinMm == null) ? 0 : +opts.bridgeMinMm;      /* a span narrower than this is a ledge between two walls, not a bridge: held (0 = off, the planner suites' pins) */
    var standoff = (opts.sideStandoffMm == null) ? SIDE_STANDOFF_MM : +opts.sideStandoffMm;
    var ridgeGap = (opts.ridgeGapMm == null) ? RIDGE_GAP_MM : +opts.ridgeGapMm;
    var ridgeReach = (opts.ridgeReachMm == null) ? RIDGE_REACH_MM : +opts.ridgeReachMm;
    var creaseMin = Math.cos(((opts.creaseMinDeg == null) ? CREASE_MIN_DEG : +opts.creaseMinDeg) * Math.PI / 180);
    var planeTol = (opts.planeTol == null) ? 1e-3 : +opts.planeTol;
    var occluders = opts.occluders || [];

    /* ---- every triangle, the piece's own and the occluders', once ---- */
    var tris = [], own = [], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    var all = [{ soup: rawTris, own: true }];
    for (var q = 0; q < occluders.length; q++) {
      if (occluders[q] && occluders[q].length >= 9) all.push({ soup: occluders[q], own: false });
    }
    for (var s = 0; s < all.length; s++) {
      var soup = all[s].soup, nt = (soup.length / 9) | 0;
      for (var t = 0; t < nt; t++) {
        var o = t * 9, n = triNormal(soup, o);
        if (!n) continue;
        var T = {
          soup: soup, o: o, n: n, own: all[s].own, idx: all[s].own ? t : -1,
          lo: [Math.min(soup[o], soup[o + 3], soup[o + 6]), Math.min(soup[o + 1], soup[o + 4], soup[o + 7]),
               Math.min(soup[o + 2], soup[o + 5], soup[o + 8])],
          hi: [Math.max(soup[o], soup[o + 3], soup[o + 6]), Math.max(soup[o + 1], soup[o + 4], soup[o + 7]),
               Math.max(soup[o + 2], soup[o + 5], soup[o + 8])],
          painted: false
        };
        if (T.own && skipList.length) T.painted = onSkippedFace(n, o, soup, skipList, planeTol);
        tris.push(T);
        if (T.own) {
          own.push(T);
          for (var k = 0; k < 3; k++) {
            if (T.lo[k] < lo[k]) lo[k] = T.lo[k];
            if (T.hi[k] > hi[k]) hi[k] = T.hi[k];
          }
        }
      }
    }
    if (!own.length) { out.reason = 'the soup has no triangle with any area'; return out; }
    var gmin = [Infinity, Infinity, Infinity];
    for (var g0 = 0; g0 < tris.length; g0++) for (var g1 = 0; g1 < 3; g1++) {
      if (tris[g0].lo[g1] < gmin[g1]) gmin[g1] = tris[g0].lo[g1];
    }
    var plateZ = (opts.plateZ == null) ? lo[2] : +opts.plateZ;
    /* z for the columns, always; x and y only once a bridge or ridge probe
       asks, since most pieces never do */
    var IX = [null, null, buildAxisIndex(tris, 2)];
    function ix(axis) { return IX[axis] || (IX[axis] = buildAxisIndex(tris, axis)); }

    /* ---- the plan grid: whole cells, centred on the footprint ---- */
    var w = hi[0] - lo[0], h = hi[1] - lo[1];
    var nx = Math.max(1, Math.ceil(w / pitch - 1e-9)), ny = Math.max(1, Math.ceil(h / pitch - 1e-9));
    var origin = [lo[0] - (nx * pitch - w) / 2, lo[1] - (ny * pitch - h) / 2];
    out.grid = { pitch: pitch, origin: origin, nx: nx, ny: ny };

    var counts = { cells: nx * ny, rays: 0, crossings: 0, resting: 0, printable: 0, bridged: 0,
                   painted: 0, interior: 0, sheltered: 0, face: 0, gap: 0, edge: 0, tip: 0, ridge: 0 };
    out.counts = counts;

    /* ---- one column: every crossing of the vertical line through (x, y),
       walked from the plate up with a material depth count. A downward
       crossing met at depth 0 is a surface with air (or the plate) under it:
       a candidate. Equal-z hits are ordered exits first, so a face sitting
       flush on another (a pillar under an arm) reads as touching, gap 0. ---- */
    function column(x, y) {
      counts.rays++;
      var hits = dedupe(lineHits(IX[2], [x, y, 0], gmin[2]), 2);
      hits.sort(function (u, v) {
        if (Math.abs(u.s - v.s) < SAME_Z_MM) return (v.T.n[2] > 0 ? 1 : 0) - (u.T.n[2] > 0 ? 1 : 0);
        return u.s - v.s;
      });
      var depth = 0, lastTop = plateZ, below = 'plate', cands = [];
      for (var k = 0; k < hits.length; k++) {
        var H = hits[k], z = H.s;
        if (H.T.n[2] > 0) {
          depth = Math.max(0, depth - 1);
          if (depth === 0) { lastTop = Math.max(z, plateZ); below = 'material'; }
        } else {
          if (depth === 0 && H.T.own) {
            cands.push({ x: x, y: y, z: z, T: H.T, gap: z - lastTop, below: below, need: undefined });
          }
          depth++;
        }
      }
      return cands;
    }

    /* Nearest hit forward (+1) or backward (-1) along a cardinal horizontal
       axis from p, strictly beyond HIT_EPS_MM. Returns {d, T} or null. */
    function probe(p, axis, sign) {
      var hits = lineHits(ix(axis), p, gmin[axis]), best = null;
      for (var k = 0; k < hits.length; k++) {
        var d = (hits[k].s - p[axis]) * sign;
        if (d > HIT_EPS_MM && (!best || d < best.d)) best = { d: d, T: hits[k].T };
      }
      return best;
    }

    /* Nearest hit along an arbitrary horizontal direction, brute force with a
       bbox reject. Only the ridge openness test calls it. */
    function probeDir(p, dir, maxD) {
      var best = -1;
      for (var k = 0; k < tris.length; k++) {
        var T = tris[k];
        if (p[2] < T.lo[2] || p[2] > T.hi[2]) continue;
        var tt = rayTri(p[0], p[1], p[2], dir[0], dir[1], 0, T.soup, T.o);
        if (tt > HIT_EPS_MM && tt < maxD && (best < 0 || tt < best)) best = tt;
      }
      return best;
    }

    /* The candidate in column (x, y) that continues a surface last seen at z:
       the one nearest z, within `tol`. */
    function surfaceNear(x, y, z, tol) {
      var c = column(x, y), best = null;
      for (var k = 0; k < c.length; k++) {
        var dz = Math.abs(c[k].z - z);
        if (dz <= tol && (!best || dz < Math.abs(best.z - z))) best = c[k];
      }
      return best;
    }

    /* A rib hanging off a wall, with no room under it: find the wall, step
       0.35 mm back out from it along the lateral normal, and put the beacon on
       the rib's underside there. null when this is not a rib. */
    function ridgeAt(c, tiltDeg) {
      var nx0 = c.T.n[0], ny0 = c.T.n[1], hl = Math.sqrt(nx0 * nx0 + ny0 * ny0);
      var lat = null, delta = Math.min(0.25, c.gap / 2);
      var pin = [c.x, c.y, c.z - delta];
      if (hl > 0.1) {
        lat = [nx0 / hl, ny0 / hl];
      } else {
        /* A flat rib underside says nothing about which way is out: the wall
           does. Nearest wall along the four cardinal directions, its own
           normal turned flat. */
        var bestW = null;
        for (var ax = 0; ax < 2; ax++) for (var sg = -1; sg <= 1; sg += 2) {
          var pr = probe(pin, ax, sg);
          if (pr && pr.d <= ridgeReach && (!bestW || pr.d < bestW.d)) bestW = pr;
        }
        if (!bestW) return null;
        var wl = Math.sqrt(bestW.T.n[0] * bestW.T.n[0] + bestW.T.n[1] * bestW.T.n[1]);
        if (!(wl > 0.1)) return null;
        lat = [bestW.T.n[0] / wl, bestW.T.n[1] / wl];
      }
      /* Walk in toward the wall along -lat while the underside goes on with
         air under it. Where it stops is the root of the rib. */
      var step = 0.05, d = 0, zPrev = c.z, good = 0, bad = -1;
      while (d < ridgeReach) {
        d += step;
        var sx = c.x - lat[0] * d, sy = c.y - lat[1] * d;
        var sn = surfaceNear(sx, sy, zPrev, step * 4 + 1e-3);
        if (!sn || !(sn.gap > 0.01)) { bad = d; break; }
        good = d; zPrev = sn.z;
      }
      if (bad < 0) return null;                          /* longer than a rib */
      for (var it = 0; it < 6; it++) {                   /* refine the root */
        var mid = (good + bad) / 2;
        var sm = surfaceNear(c.x - lat[0] * mid, c.y - lat[1] * mid, zPrev, step * 4 + 1e-3);
        if (sm && sm.gap > 0.01) good = mid; else bad = mid;
      }
      var rootD = (good + bad) / 2;
      var off = rootD - standoff;                        /* signed distance from the cell point back in */
      var bx = c.x - lat[0] * off, by = c.y - lat[1] * off;
      var at = surfaceNear(bx, by, c.z, Math.max(1, Math.abs(off) * 3));
      if (!at) { at = c; bx = c.x; by = c.y; }
      /* Laterally open: a support has to get in from that side. */
      var blocked = probeDir([bx, by, at.z - Math.min(0.25, Math.max(at.gap, 0.02) / 2)],
                             [lat[0], lat[1]], 2 * ridgeReach);
      if (blocked > 0) return null;
      return {
        x: bx, y: by, z: at.z, T: at.T, normal: [lat[0], lat[1], 0],
        need: { angle: tiltDeg, gapBelow: at.gap, below: c.below, kind: 'ridge', side: true,
                standoffMm: standoff, wallMm: rootD }
      };
    }

    /* Does this candidate need holding, and how? Cached on the candidate. */
    function needOf(c) {
      if (c.need !== undefined) return c.need;
      c.need = null;
      if (c.T.painted) { counts.painted++; return null; }
      if (!(c.gap > minDrop)) { counts.resting++; return null; }
      var nz = c.T.n[2];
      var tilt = Math.acos(Math.min(1, Math.max(-1, -nz))) * 180 / Math.PI;
      if (!(nz < nzMax)) { counts.printable++; return null; }
      var base = { angle: tilt, gapBelow: c.gap, below: c.below };

      if (c.below === 'material' && c.gap <= ridgeGap) {
        var r = ridgeAt(c, tilt);
        if (r) { c.need = r; return r; }
      }
      if (tilt <= bridgeTiltMax) {
        var pin = [c.x, c.y, c.z - Math.min(0.25, c.gap / 2)], span = Infinity;
        for (var ax = 0; ax < 2; ax++) {
          var f = probe(pin, ax, 1), b = probe(pin, ax, -1);
          if (f && b && f.d + b.d < span) span = f.d + b.d;
        }
        if (span <= bridgeMm && !(span < bridgeMin && c.gap >= SEED_MIN_DROP_MM)) { counts.bridged++; return null; }     /* a ledge hangs: air under it, not the wedge of a tilted slab near the plate */
        if (span < Infinity) {
          base.kind = 'gap'; base.spanMm = span;
          c.need = { x: c.x, y: c.y, z: c.z, T: c.T, normal: c.T.n.slice(), need: base };
          return c.need;
        }
      }
      base.kind = (c.below === 'material') ? 'gap' : 'face';
      c.need = { x: c.x, y: c.y, z: c.z, T: c.T, normal: c.T.n.slice(), need: base };
      return c.need;
    }

    /* ---- EXPOSED ONLY. Is this spot in air that reaches the outside?
       The piece's own triangles are filed in a coarse xy grid and a ray is
       walked through the cells it crosses (Amanatides-Woo, 2D): a near-
       vertical ray visits one cell, a sideways one a row. A hit is anything
       beyond HIT_EPS_MM; the face the spot sits on and its coplanar
       neighbours are never in front of it. ---- */
    var XG = (function () {
      var side = Math.max(1, Math.min(128, Math.round(Math.sqrt(own.length))));
      var wx = Math.max(hi[0] - lo[0], 1e-6) / side, wy = Math.max(hi[1] - lo[1], 1e-6) / side;
      var cells = new Array(side * side);
      for (var k = 0; k < own.length; k++) {
        var T = own[k];
        T.seen = -1;
        var i0 = Math.max(0, Math.min(side - 1, Math.floor((T.lo[0] - lo[0]) / wx)));
        var i1 = Math.max(0, Math.min(side - 1, Math.floor((T.hi[0] - lo[0]) / wx)));
        var j0 = Math.max(0, Math.min(side - 1, Math.floor((T.lo[1] - lo[1]) / wy)));
        var j1 = Math.max(0, Math.min(side - 1, Math.floor((T.hi[1] - lo[1]) / wy)));
        for (var i = i0; i <= i1; i++) for (var j = j0; j <= j1; j++) {
          var c = j * side + i;
          (cells[c] || (cells[c] = [])).push(T);
        }
      }
      return { side: side, wx: wx, wy: wy, cells: cells, stamp: 0 };
    })();
    /* Does the ray from o along unit d leave the piece's bounding box without
       meeting the piece? */
    function rayOut(o, d) {
      var g = XG;
      var tEnd = Infinity, a;
      for (a = 0; a < 3; a++) {
        if (d[a] > 1e-12) tEnd = Math.min(tEnd, (hi[a] - o[a]) / d[a]);
        else if (d[a] < -1e-12) tEnd = Math.min(tEnd, (lo[a] - o[a]) / d[a]);
      }
      if (!(tEnd > HIT_EPS_MM)) return true;                 /* already at the box wall, facing out */
      tEnd += HIT_EPS_MM;                                    /* a face lying ON the box wall is still a face */
      var stamp = ++g.stamp;
      var ci = Math.max(0, Math.min(g.side - 1, Math.floor((o[0] - lo[0]) / g.wx)));
      var cj = Math.max(0, Math.min(g.side - 1, Math.floor((o[1] - lo[1]) / g.wy)));
      var sx = d[0] > 0 ? 1 : -1, sy = d[1] > 0 ? 1 : -1;
      var tx = Infinity, ty = Infinity, dtx = Infinity, dty = Infinity;
      if (Math.abs(d[0]) > 1e-12) {
        dtx = g.wx / Math.abs(d[0]);
        tx = ((sx > 0 ? lo[0] + (ci + 1) * g.wx : lo[0] + ci * g.wx) - o[0]) / d[0];
      }
      if (Math.abs(d[1]) > 1e-12) {
        dty = g.wy / Math.abs(d[1]);
        ty = ((sy > 0 ? lo[1] + (cj + 1) * g.wy : lo[1] + cj * g.wy) - o[1]) / d[1];
      }
      for (;;) {
        var list = g.cells[cj * g.side + ci];
        if (list) for (var k = 0; k < list.length; k++) {
          var T = list[k];
          if (T.seen === stamp) continue;
          T.seen = stamp;
          var tt = rayTri(o[0], o[1], o[2], d[0], d[1], d[2], T.soup, T.o);
          if (tt > HIT_EPS_MM && tt < tEnd) return false;
        }
        var tNext = Math.min(tx, ty);
        if (!(tNext < tEnd)) return true;
        if (tx <= ty) { ci += sx; tx += dtx; } else { cj += sy; ty += dty; }
        if (ci < 0 || cj < 0 || ci >= g.side || cj >= g.side) return true;
      }
    }
    /* A spot's own normal first (the common case, one cheap ray); failing
       that, a fan over the hemisphere the normal faces: FAN_AZIMUTHS headings
       round the normal at each of FAN_ELEVATIONS_DEG above the face's own
       plane, the smallest first (the way out of a shelf or a tunnel is
       nearly along the face). Air that any ray gets out through is air that
       reaches the outside; a sealed cavity has no such ray. */
    var fan = [];
    (function () {
      for (var ei = 0; ei < FAN_ELEVATIONS_DEG.length; ei++) {
        var el = FAN_ELEVATIONS_DEG[ei] * Math.PI / 180;
        for (var ai = 0; ai < FAN_AZIMUTHS; ai++) {
          var az = 2 * Math.PI * ai / FAN_AZIMUTHS;
          fan.push([Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)]);
        }
      }
    })();
    function exposed(nd) {
      var n = nd.normal, o = [nd.x, nd.y, nd.z];
      if (rayOut(o, n)) return true;
      var t1 = Math.abs(n[2]) < 0.9 ? [-n[1], n[0], 0] : [0, -n[2], n[1]];
      var l1 = Math.sqrt(t1[0] * t1[0] + t1[1] * t1[1] + t1[2] * t1[2]);
      t1 = [t1[0] / l1, t1[1] / l1, t1[2] / l1];
      var t2 = [n[1] * t1[2] - n[2] * t1[1], n[2] * t1[0] - n[0] * t1[2], n[0] * t1[1] - n[1] * t1[0]];
      for (var k = 0; k < fan.length; k++) {
        var f = fan[k];
        if (rayOut(o, [f[0] * t1[0] + f[1] * t2[0] + f[2] * n[0],
                       f[0] * t1[1] + f[1] * t2[1] + f[2] * n[1],
                       f[0] * t1[2] + f[1] * t2[2] + f[2] * n[2]])) { counts.sheltered++; return true; }
      }
      return false;
    }

    var beacons = [], byCell = new Array(nx * ny);
    function addBeacon(nd, i, j, kindOverride, extra) {
      var need = {};
      for (var key in nd.need) if (Object.prototype.hasOwnProperty.call(nd.need, key)) need[key] = nd.need[key];
      if (kindOverride && need.kind !== 'ridge') { need.via = need.kind; need.kind = kindOverride; }
      if (extra) for (var e in extra) if (Object.prototype.hasOwnProperty.call(extra, e)) need[e] = extra[e];
      // opts.exposedOnly === false keeps the spots in sealed air too (a cavity
      // ceiling): the rule as it was before exposed-only, for a caller that
      // asks. Off by default nowhere in the app.
      if (opts.exposedOnly !== false && !exposed(nd)) { counts.interior++; return null; }
      var bcn = { x: nd.x, y: nd.y, z: nd.z, normal: nd.normal, need: need, cell: [i, j], tri: nd.T.idx };
      beacons.push(bcn);
      var ci = j * nx + i;
      (byCell[ci] || (byCell[ci] = [])).push(bcn);
      counts[need.kind]++;
      return bcn;
    }
    function cellHasNear(i, j, z, tol) {
      var L = byCell[j * nx + i];
      if (!L) return false;
      for (var k = 0; k < L.length; k++) if (Math.abs(L[k].z - z) <= tol) return true;
      return false;
    }

    /* ---- centres, and the corner lattice they share ---- */
    var corners = new Array((nx + 1) * (ny + 1));
    function cornerCol(ci, cj) {
      var key = cj * (nx + 1) + ci;
      if (!corners[key]) corners[key] = column(origin[0] + ci * pitch, origin[1] + cj * pitch);
      return corners[key];
    }
    var claimed = new Set();
    for (var j = 0; j < ny; j++) {
      for (var i = 0; i < nx; i++) {
        var cx = origin[0] + (i + 0.5) * pitch, cy = origin[1] + (j + 0.5) * pitch;
        var cc = column(cx, cy), m;
        counts.crossings += cc.length;
        for (m = 0; m < cc.length; m++) {
          var nd = needOf(cc[m]);
          if (nd) addBeacon(nd, i, j);
        }
        /* corners: a needing crossing the centre has no downward crossing
           within one pitch of, in z, is a feature the centre missed */
        var loose = [];
        var cs = [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]];
        for (var u = 0; u < 4; u++) {
          var col = cornerCol(cs[u][0], cs[u][1]);
          for (var v = 0; v < col.length; v++) {
            var ck = (cs[u][1] * (nx + 1) + cs[u][0]) + ':' + v;
            if (claimed.has(ck)) continue;
            var matched = false;
            for (m = 0; m < cc.length; m++) if (Math.abs(cc[m].z - col[v].z) <= pitch) { matched = true; break; }
            if (matched) continue;
            var cn = needOf(col[v]);
            if (cn) loose.push({ nd: cn, key: ck });
          }
        }
        loose.sort(function (p1, p2) { return p1.nd.z - p2.nd.z; });
        for (m = 0; m < loose.length; m++) {
          if (cellHasNear(i, j, loose[m].nd.z, pitch)) { claimed.add(loose[m].key); continue; }
          addBeacon(loose[m].nd, i, j, 'edge', { via: loose[m].nd.need.kind, corner: true });
          claimed.add(loose[m].key);
          for (var mm = m + 1; mm < loose.length; mm++) {
            if (loose[mm].nd.z - loose[m].nd.z <= pitch) claimed.add(loose[mm].key);
          }
        }
      }
    }

    /* ---- creases and tips: downward features with no face of their own.
       Both sit only where every face meeting them faces down, so only the
       downward-facing triangles are welded. ---- */
    var weld = new Map(), vid = 0, vpos = [], vnbr = [], edges = new Map();
    function vkey(p) {
      var key = Math.round(p[0] * 1e4) + '|' + Math.round(p[1] * 1e4) + '|' + Math.round(p[2] * 1e4);
      var id = weld.get(key);
      if (id === undefined) { id = vid++; weld.set(key, id); vpos.push(p); vnbr.push(new Set()); }
      return id;
    }
    for (var e0 = 0; e0 < own.length; e0++) {
      var TT = own[e0], so = TT.soup, oo = TT.o, ids = [];
      if (!(TT.n[2] < 0)) continue;
      for (var vv = 0; vv < 3; vv++) ids.push(vkey([so[oo + vv * 3], so[oo + vv * 3 + 1], so[oo + vv * 3 + 2]]));
      for (var ee = 0; ee < 3; ee++) {
        var a = ids[ee], b = ids[(ee + 1) % 3], c3 = ids[(ee + 2) % 3];
        if (a === b) continue;
        vnbr[a].add(b); vnbr[b].add(a);
        var ek = a < b ? a + '_' + b : b + '_' + a;
        var rec = edges.get(ek);
        if (!rec) edges.set(ek, rec = { a: a, b: b, faces: [] });
        rec.faces.push({ T: TT, opp: c3 });
      }
    }
    function cellOf(x, y) {
      var ci = Math.floor((x - origin[0]) / pitch), cj = Math.floor((y - origin[1]) / pitch);
      if (ci < 0 || cj < 0 || ci >= nx || cj >= ny) return null;
      return [ci, cj];
    }
    function addFeature(p, nrm, kind, angle, ownFaces) {
      var cell = cellOf(p[0], p[1]);
      if (!cell || cellHasNear(cell[0], cell[1], p[2], pitch)) return;
      var sn = surfaceNear(p[0], p[1], p[2], 0.01);
      if (!sn || sn.T.painted || !(sn.gap > minDrop)) return;
      /* A crease hangs in air only if the surface the column finds there is
         the crease's own. Another face of the piece within 0.01 mm of the
         crease point means the crease is flush on, or buried in, that face
         (a lid's edge sunk into the box wall it sits on): not a knife edge. */
      if (ownFaces && ownFaces.indexOf(sn.T) < 0) return;
      addBeacon({ x: p[0], y: p[1], z: p[2], T: sn.T, normal: nrm,
                  need: { angle: angle, gapBelow: sn.gap, below: sn.below, kind: kind } },
                cell[0], cell[1]);
    }
    var sinMax = Math.sin(angleDeg * Math.PI / 180);
    edges.forEach(function (E) {
      if (E.faces.length !== 2) return;
      var n1 = E.faces[0].T.n, n2 = E.faces[1].T.n;
      if (!(n1[2] < 0 && n2[2] < 0)) return;
      if (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] > creaseMin) return;
      var A = vpos[E.a], B = vpos[E.b];
      var ex = B[0] - A[0], ey = B[1] - A[1], ez = B[2] - A[2];
      var el = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (!(el > 1e-9)) return;
      if (Math.abs(ez) / el >= sinMax) return;          /* the edge climbs fast enough */
      for (var f = 0; f < 2; f++) {                      /* both faces rise away from it */
        var P = vpos[E.faces[f].opp];
        var tpar = ((P[0] - A[0]) * ex + (P[1] - A[1]) * ey + (P[2] - A[2]) * ez) / (el * el);
        var dz = P[2] - (A[2] + ez * tpar);
        if (!(dz > 1e-6)) return;
      }
      var nm = [n1[0] + n2[0], n1[1] + n2[1], n1[2] + n2[2]];
      var nl = Math.sqrt(nm[0] * nm[0] + nm[1] * nm[1] + nm[2] * nm[2]) || 1;
      nm = [nm[0] / nl, nm[1] / nl, nm[2] / nl];
      var tilt = Math.asin(Math.min(1, Math.abs(ez) / el)) * 180 / Math.PI;
      var steps = Math.max(1, Math.ceil(el / (pitch / 2)));
      for (var st = 0; st < steps; st++) {
        var fr = (st + 0.5) / steps;
        addFeature([A[0] + ex * fr, A[1] + ey * fr, A[2] + ez * fr], nm, 'edge', tilt, [E.faces[0].T, E.faces[1].T]);
      }
    });
    for (var vi = 0; vi < vid; vi++) {
      if (!vnbr[vi].size) continue;
      var vz = vpos[vi][2], lowest = true;
      vnbr[vi].forEach(function (nb) {
        if (!(vpos[nb][2] > vz + 1e-6)) lowest = false;
        /* interior to the downward faces: a vertex on the rim of a downward
           patch (where it meets a wall) is not a tip, whatever its height */
        var E2 = edges.get(vi < nb ? vi + '_' + nb : nb + '_' + vi);
        if (!E2 || E2.faces.length !== 2) lowest = false;
      });
      if (lowest) addFeature(vpos[vi], [0, 0, -1], 'tip', 0);
    }


    /* ---- THE FOOTPRINT: where each area's surface really is, edge to edge ----
       A beacon is a sample on a grid; the surface it holds is not a stack of
       grid cells. Round its edge the cells hang out over the air (a spot found
       by a corner of its cell, the cell mostly empty), and a support stood on
       such a spot, or a sheet laid on such a cell, hangs off the part. So each
       area (region) gets the outline of the surface itself: the grid is sampled
       at FOOT_STEP_MM, a flood from the area's own spots walks out over the
       samples while a column of the piece crosses where the surface goes on
       (no further from the last sample's height than a face that needs holding
       can climb in one step, and the crossing needs holding - the same test as
       a beacon's), the boundary is traced (marching squares) and each of its
       crossings found by bisection on the columns themselves. Cells whose eight
       neighbours all have a centre spot are whole and are not sampled.
       region.footprint = { loops: [[[x, y, z], ...], ...] (outer loops
         counter-clockwise, holes clockwise: the surface lies on the left of
         travel), areaMm2, stepMm, insetMm }
       Then, where opts.insetMm is asked (the card asks 1 mm; default 0, the spots stay where the grid put them), a spot of a FLAT area
       (every face of it within 3 deg of the plate: a tilted or curved face keeps its spots at the grid's own points, which its stair
       and its flat sheet's reach are laid on) nearer the edge than that is moved
       in to the nearest sampled point that is not, or to the point farthest
       from the edge it can reach (a rim thinner than two insets): z, normal and
       triangle taken from the column there, b.moved = { from, mm }, b.clearMm
       its distance to the edge. Only the surface spots (face, gap and a corner
       'edge') have a footprint; a crease, a tip and a side spot keep their
       cell and are left where they are. */
    function footprints(regions, insetArg) {
      var inset = insetArg != null ? insetArg : (opts.insetMm == null) ? 0 : +opts.insetMm;
      var sub = Math.max(2, Math.round(pitch / FOOT_STEP_MM)), fs = pitch / sub;
      var moved = 0;
      function isSurface(b) {
        var k = b.need.kind;
        return k === 'face' || k === 'gap' || (k === 'edge' && b.need.corner);
      }
      for (var ri = 0; ri < regions.length; ri++) {
        var R = regions[ri], refs = R.beacons.filter(isSurface);
        R.footprint = null;
        if (!refs.length) continue;
        var cellRefs = new Map(), minI = Infinity, minJ = Infinity, maxI = -Infinity, maxJ = -Infinity, bi;
        for (bi = 0; bi < refs.length; bi++) {
          var ci = refs[bi].cell[0], cj = refs[bi].cell[1], ck = cj * nx + ci;
          if (!cellRefs.has(ck)) cellRefs.set(ck, []);
          cellRefs.get(ck).push(refs[bi]);
          if (ci < minI) minI = ci; if (ci > maxI) maxI = ci;
          if (cj < minJ) minJ = cj; if (cj > maxJ) maxJ = cj;
        }
        /* the node grid: cells minI-2 .. maxI+2 (one ring of cells the surface may reach into, one of nodes that are off) */
        var I0 = minI - 2, J0 = minJ - 2, CI = maxI - minI + 5, CJ = maxJ - minJ + 5, W = CI * sub + 1, Hh = CJ * sub + 1;
        function nodeX(a) { return origin[0] + (I0 * sub + a) * fs; }
        function nodeY(b) { return origin[1] + (J0 * sub + b) * fs; }
        function cellHas(i, j) { return i >= 0 && j >= 0 && i < nx && j < ny && cellRefs.has(j * nx + i); }
        /* the surface's crossing at (x, y) that continues a surface last seen at zRef (tol: how far it may have moved): the
           column's crossing that needs holding nearest zRef, or null. A face that needs holding is no steeper than angleDeg, so
           over one step the surface climbs no more than step * tan(angleDeg), and a curved surface is followed where a plane
           through a beacon would be left behind. */
        function patchNear(x, y, zRef, tol) {
          var col = column(x, y), best = null, bd = tol + 1e-9;
          for (var k = 0; k < col.length; k++) {
            var nd = needOf(col[k]);
            if (!nd || nd.need.kind === 'ridge') continue;
            var d = Math.abs(col[k].z - zRef);
            if (d <= bd) { bd = d; best = col[k]; }
          }
          return best;
        }
        var tanA = Math.min(1, Math.tan(angleDeg * Math.PI / 180));
        function stepTol(dist) { return dist * tanA + FOOT_TOL_MM / 8; }
        /* nodes: 0 unknown, 1 on, 2 off */
        var state = new Uint8Array(W * Hh), zs = new Float64Array(W * Hh);
        function centred(i, j) {                                   /* the cell's centre is on the surface (a corner spot is the edge of one) */
          var L = i >= 0 && j >= 0 && i < nx && j < ny ? cellRefs.get(j * nx + i) : null;
          if (L) for (var q = 0; q < L.length; q++) if (!L[q].need.corner) return true;
          return false;
        }
        function whole(i, j) {
          if (!centred(i, j)) return false;
          for (var dj = -1; dj <= 1; dj++) for (var di = -1; di <= 1; di++) if ((di || dj) && !centred(i + di, j + dj)) return false;
          return true;
        }
        /* the cells a node touches (up to four) */
        function cellsOfNode(a, b, fn) {
          var ca = I0 + Math.floor(a / sub), cb = J0 + Math.floor(b / sub);
          for (var dj = (b % sub === 0 ? -1 : 0); dj <= 0; dj++) for (var di = (a % sub === 0 ? -1 : 0); di <= 0; di++) fn(ca + di, cb + dj);
        }
        function ringed(a, b) {
          var yes = false;
          cellsOfNode(a, b, function (qi, qj) { for (var ej = -1; ej <= 1; ej++) for (var ei = -1; ei <= 1; ei++) if (cellHas(qi + ei, qj + ej)) yes = true; });
          return yes;
        }
        function isWhole(a, b) {
          var yes = false;
          cellsOfNode(a, b, function (qi, qj) { if (whole(qi, qj)) yes = true; });
          return yes;
        }
        function liftOf(x, y, bc) { return bc.z - (bc.normal[0] * (x - bc.x) + bc.normal[1] * (y - bc.y)) / bc.normal[2]; }
        /* flood: the beacons' own nodes, the whole cells, then outward over the columns while the surface goes on */
        var queue = [], qh = 0;
        function setOn(k, z) { state[k] = 1; zs[k] = z; queue.push(k); }
        function nodeOfPoint(x, y) { return [Math.round((x - nodeX(0)) / fs), Math.round((y - nodeY(0)) / fs)]; }
        for (bi = 0; bi < refs.length; bi++) {
          var nn = nodeOfPoint(refs[bi].x, refs[bi].y);
          if (nn[0] < 1 || nn[1] < 1 || nn[0] > W - 2 || nn[1] > Hh - 2) continue;
          var kk = nn[1] * W + nn[0];
          if (state[kk] === 1) continue;
          var sd = patchNear(nodeX(nn[0]), nodeY(nn[1]), refs[bi].z, FOOT_TOL_MM + fs * tanA);
          if (sd) setOn(kk, sd.z);
        }
        for (var wb = 1; wb < Hh - 1; wb++) for (var wa = 1; wa < W - 1; wa++) {
          var wk = wb * W + wa;
          if (state[wk] !== 1 && isWhole(wa, wb)) {
            var wl = null, wd = Infinity;
            cellsOfNode(wa, wb, function (qi, qj) { var L = qi >= 0 && qj >= 0 && qi < nx && qj < ny ? cellRefs.get(qj * nx + qi) : null; if (L) for (var q = 0; q < L.length; q++) { var d = Math.hypot(L[q].x - nodeX(wa), L[q].y - nodeY(wb)); if (d < wd) { wd = d; wl = L[q]; } } });
            if (wl) setOn(wk, liftOf(nodeX(wa), nodeY(wb), wl));
          }
        }
        while (qh < queue.length) {
          var ck = queue[qh++], ca2 = ck % W, cb2 = (ck - ca2) / W;
          var nbs = [[ca2 - 1, cb2], [ca2 + 1, cb2], [ca2, cb2 - 1], [ca2, cb2 + 1]];
          for (var ni = 0; ni < 4; ni++) {
            var na2 = nbs[ni][0], nb2 = nbs[ni][1];
            if (na2 < 1 || nb2 < 1 || na2 > W - 2 || nb2 > Hh - 2) continue;
            var nk = nb2 * W + na2;
            if (state[nk] === 1) continue;
            if (!ringed(na2, nb2)) { state[nk] = 2; continue; }
            var pn = patchNear(nodeX(na2), nodeY(nb2), zs[ck], stepTol(fs));
            if (pn) setOn(nk, pn.z); else state[nk] = 2;
          }
        }
        function nodeAt(a, b) { return state[b * W + a] === 1; }

        /* marching squares, each crossing refined on the columns */
        var cross = new Map();
        function crossing(a0, b0, a1, b1) {
          var id = (b0 === b1 ? 0 : 1) + 2 * (Math.min(b0, b1) * W + Math.min(a0, a1)), v = cross.get(id);
          if (v) return v;
          var on0 = nodeAt(a0, b0), pa0 = on0 ? [a0, b0] : [a1, b1], pb0 = on0 ? [a1, b1] : [a0, b0];
          var xa = nodeX(pa0[0]), ya = nodeY(pa0[1]), xb = nodeX(pb0[0]), yb = nodeY(pb0[1]);
          var za = zs[pa0[1] * W + pa0[0]], zr = za, lo2 = 0, hi2 = 1;
          for (var it = 0; it < 6; it++) {
            var mid = (lo2 + hi2) / 2, pm = patchNear(xa + (xb - xa) * mid, ya + (yb - ya) * mid, zr, stepTol(mid * fs));
            if (pm) { lo2 = mid; za = pm.z; } else hi2 = mid;
          }
          var tt = (lo2 + hi2) / 2;
          v = { id: id, p: [xa + (xb - xa) * tt, ya + (yb - ya) * tt, za], next: [] };
          cross.set(id, v);
          return v;
        }
        function link(u, v) { u.next.push(v); v.next.push(u); }
        for (var sb = 0; sb + 1 < Hh; sb++) for (var sa = 0; sa + 1 < W; sa++) {
          var c0 = nodeAt(sa, sb), c1 = nodeAt(sa + 1, sb), c2 = nodeAt(sa + 1, sb + 1), c3 = nodeAt(sa, sb + 1);
          var cs = (c0 ? 1 : 0) | (c1 ? 2 : 0) | (c2 ? 4 : 0) | (c3 ? 8 : 0);
          if (cs === 0 || cs === 15) continue;
          var e0 = function () { return crossing(sa, sb, sa + 1, sb); }, e1 = function () { return crossing(sa + 1, sb, sa + 1, sb + 1); },
              e2 = function () { return crossing(sa, sb + 1, sa + 1, sb + 1); }, e3 = function () { return crossing(sa, sb, sa, sb + 1); };
          switch (cs) {
            case 1: case 14: link(e3(), e0()); break;
            case 2: case 13: link(e0(), e1()); break;
            case 3: case 12: link(e3(), e1()); break;
            case 4: case 11: link(e1(), e2()); break;
            case 5: link(e3(), e0()); link(e1(), e2()); break;
            case 6: case 9: link(e0(), e2()); break;
            case 7: case 8: link(e3(), e2()); break;
            case 10: link(e0(), e1()); link(e2(), e3()); break;
          }
        }
        /* the loops */
        var loops = [], seen = new Set();
        cross.forEach(function (st0) {
          if (seen.has(st0.id) || st0.next.length !== 2) return;
          var loop = [], cur = st0, prev = null;
          for (;;) {
            seen.add(cur.id); loop.push(cur.p);
            var nxt = cur.next[0] === prev ? cur.next[1] : cur.next[0];
            if (cur.next[0] === prev && cur.next[1] === prev) nxt = cur.next[0];
            if (nxt === st0 || seen.has(nxt.id)) break;
            prev = cur; cur = nxt;
          }
          if (loop.length >= 3) loops.push(loop);
        });
        function areaOf(L) { var a = 0; for (var q = 0; q < L.length; q++) { var u = L[q], v = L[(q + 1) % L.length]; a += u[0] * v[1] - v[0] * u[1]; } return a / 2; }
        function inLoop(pt2, L) {
          var inn = false;
          for (var q = 0, w = L.length - 1; q < L.length; w = q++) {
            if ((L[q][1] > pt2[1]) !== (L[w][1] > pt2[1]) && pt2[0] < (L[w][0] - L[q][0]) * (pt2[1] - L[q][1]) / (L[w][1] - L[q][1]) + L[q][0]) inn = !inn;
          }
          return inn;
        }
        /* drop the collinear vertices, orient by nesting: outer counter-clockwise, a hole clockwise */
        loops = loops.map(function (L) {
          var out2 = [];
          for (var q = 0; q < L.length; q++) {
            var a = L[(q + L.length - 1) % L.length], b = L[q], c = L[(q + 1) % L.length];
            var cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
            if (Math.abs(cr) > 1e-5 * Math.max(1, Math.hypot(c[0] - a[0], c[1] - a[1]))) out2.push(b);
          }
          return out2.length >= 3 ? out2 : L;
        });
        var depthOf = loops.map(function (L, q) {
          var d = 0;
          for (var w = 0; w < loops.length; w++) if (w !== q && inLoop(L[0], loops[w])) d++;
          return d;
        });
        var area = 0;
        loops = loops.map(function (L, q) {
          var ar = areaOf(L), wantCcw = depthOf[q] % 2 === 0;
          area += Math.abs(ar) * (wantCcw ? 1 : -1);
          return (ar > 0) === wantCcw ? L : L.slice().reverse();
        });
        R.footprint = { loops: loops, areaMm2: area, stepMm: fs, insetMm: inset };
        /* only a FLAT area keeps its spots in: a spot moves in its plane and its height is the same. An area with a tilted or a curved
           face keeps them at the grid's own points - the stair under a tilted plane and a flat sheet's reach under a dome are laid on
           tips there, and a spot moved along a slope changes the height the levels are read at (Oblique's stair became five bare tips) */
        var flatArea = refs.every(function (b) { return -b.normal[2] >= FLAT_NZ; });

        /* the edge: segments of every loop, for the distance to it */
        var segs = [];
        loops.forEach(function (L) { for (var q = 0; q < L.length; q++) { var u = L[q], v = L[(q + 1) % L.length]; segs.push([u[0], u[1], v[0], v[1]]); } });
        function edgeDist(x, y) {
          var best = Infinity;
          for (var q = 0; q < segs.length; q++) {
            var s2 = segs[q], dx = s2[2] - s2[0], dy = s2[3] - s2[1], l2 = dx * dx + dy * dy;
            var t = l2 > 0 ? Math.max(0, Math.min(1, ((x - s2[0]) * dx + (y - s2[1]) * dy) / l2)) : 0;
            var d = Math.hypot(x - s2[0] - t * dx, y - s2[1] - t * dy);
            if (d < best) best = d;
          }
          return best;
        }
        for (bi = 0; bi < refs.length; bi++) {
          var B = refs[bi];
          if (!(inset > 0)) continue;                                  /* the spots are left alone: no field is added to them */
          B.clearMm = edgeDist(B.x, B.y);
          if (B.clearMm >= inset - 0.05 || !flatArea) continue;
          /* the nearest sampled point at least `inset` from the edge, else the one farthest from it, within a pitch */
          var bestN = null, bestKey = null, a0n = Math.floor((B.x - nodeX(0)) / fs), b0n = Math.floor((B.y - nodeY(0)) / fs), rN = Math.ceil(pitch / fs);
          for (var qb = Math.max(1, b0n - rN); qb <= Math.min(Hh - 2, b0n + rN); qb++) for (var qa = Math.max(1, a0n - rN); qa <= Math.min(W - 2, a0n + rN); qa++) {
            if (state[qb * W + qa] !== 1) continue;
            var qx = nodeX(qa), qy = nodeY(qb), dd = Math.hypot(qx - B.x, qy - B.y);
            if (dd > pitch) continue;
            var cl = edgeDist(qx, qy), keyc = [Math.min(cl, inset), -dd];
            if (!bestKey || keyc[0] > bestKey[0] + 1e-9 || (Math.abs(keyc[0] - bestKey[0]) <= 1e-9 && keyc[1] > bestKey[1])) { bestKey = keyc; bestN = [qa, qb, cl, dd]; }
          }
          if (!bestN || !(bestN[2] > B.clearMm + 0.1)) continue;
          var nxp = nodeX(bestN[0]), nyp = nodeY(bestN[1]), pm2 = patchNear(nxp, nyp, zs[bestN[1] * W + bestN[0]], 0.05);
          if (!pm2) continue;
          var from = [B.x, B.y, B.z];
          B.x = nxp; B.y = nyp; B.z = pm2.z;
          B.normal = pm2.T.n.slice(); B.tri = pm2.T.idx;
          B.need.gapBelow = pm2.gap; B.need.below = pm2.below;
          B.need.angle = Math.acos(Math.min(1, Math.max(-1, -B.normal[2]))) * 180 / Math.PI;
          B.moved = { from: from, mm: bestN[3] };
          B.clearMm = bestN[2];
          moved++;
        }
      }
      counts.moved = moved;
      /* regions' summaries follow their beacons */
      if (moved) regions.forEach(function (R) {
        var c = [0, 0, 0], mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        R.beacons.forEach(function (b) {
          var p = [b.x, b.y, b.z];
          for (var a = 0; a < 3; a++) { c[a] += p[a] / R.beacons.length; if (p[a] < mn[a]) mn[a] = p[a]; if (p[a] > mx[a]) mx[a] = p[a]; }
        });
        R.point = c; R.min = mn; R.max = mx; R.spanMm = Math.max(mx[0] - mn[0], mx[1] - mn[1]);
      });
    }


    /* ---- THE FINER LOOK. A grid of `pitch` mm steps over a surface narrower than itself: the Negative Spheres' apex (3 - 4 mm across, which
       Bambu lays a second interface on) falls between the samples at 3 mm and is found from 2.5 mm; a ledge under 1.5 mm is found in some
       alignments of the grid and not in others. So (opts.seedPitchMm, the card asks 1) the piece is read again at that pitch, and a hit
       that is no part of the surface an area of the grid already holds - outside every footprint (and the margin round it), at that height -
       is a SEED: one a coarse cell and height is added to the beacons (need.seeded), and the areas and their footprints are made again, so
       the flood from a seed traces the whole of its surface. A seeded surface is traced on its own and kept only if a disc SEED_MIN_WIDTH_MM wide fits in it (and it is no speck): a thinner crescent is left as the grid had it.
       The grid's own spots are not moved, taken away or added to wherever they hold. ---- */
    function seedMissed(regions, sp, onlyLedges) {
      var fine = detect(rawTris, Object.assign({}, opts, { pitch: sp, seedPitchMm: 0, footprint: false, insetMm: 0 }));
      if (!fine.ok) return 0;
      function surf(b) { var k = b.need.kind; return k === 'face' || k === 'gap' || (k === 'edge' && b.need.corner); }
      var fp = regions.filter(function (R) { return R.footprint; }).map(function (R) {
        var zl = Infinity, zh = -Infinity, segs = [];
        R.beacons.forEach(function (b) { if (b.z < zl) zl = b.z; if (b.z > zh) zh = b.z; });      /* a dome's rim is its highest and its pole its lowest: the spots too */
        R.footprint.loops.forEach(function (L) {
          for (var q = 0; q < L.length; q++) {
            var u = L[q], v = L[(q + 1) % L.length];
            if (u[2] < zl) zl = u[2]; if (u[2] > zh) zh = u[2];
            segs.push([u[0], u[1], v[0], v[1]]);
          }
        });
        return { loops: R.footprint.loops, zl: zl - 0.8, zh: zh + 0.8, segs: segs };
      });
      function insideLoops(F, x, y) {
        var inn = false;
        F.loops.forEach(function (L) {
          for (var q = 0, w = L.length - 1; q < L.length; w = q++) {
            if ((L[q][1] > y) !== (L[w][1] > y) && x < (L[w][0] - L[q][0]) * (y - L[q][1]) / (L[w][1] - L[q][1]) + L[q][0]) inn = !inn;
          }
        });
        return inn;
      }
      function edgeD(F, x, y) {
        var best = Infinity;
        for (var q = 0; q < F.segs.length; q++) {
          var s2 = F.segs[q], dx = s2[2] - s2[0], dy = s2[3] - s2[1], l2 = dx * dx + dy * dy;
          var t = l2 > 0 ? Math.max(0, Math.min(1, ((x - s2[0]) * dx + (y - s2[1]) * dy) / l2)) : 0;
          var d = Math.hypot(x - s2[0] - t * dx, y - s2[1] - t * dy);
          if (d < best) best = d;
        }
        return best;
      }
      var kept = {}, added = 0, cands = [], sr;
      fine.beacons.forEach(function (b) {
        if (!surf(b) || !(b.need.gapBelow >= SEED_MIN_DROP_MM)) return;
        if (onlyLedges && !(b.need.spanMm != null && b.need.spanMm < bridgeMin)) return;     /* the half-mm look keeps only the ledges it was asked for */
        if (onlyLedges) {                                                                    /* ...and not one an earlier look already holds */
          for (var q = 0; q < beacons.length; q++) { var o = beacons[q]; if (Math.abs(o.x - b.x) < 0.75 && Math.abs(o.y - b.y) < 0.75 && Math.abs(o.z - b.z) < 0.3) return; }
        }
        for (var f = 0; f < fp.length; f++) {
          var F = fp[f];
          if (b.z < F.zl || b.z > F.zh) continue;
          if (insideLoops(F, b.x, b.y) || edgeD(F, b.x, b.y) <= SEED_MARGIN_MM) return;
        }
        var ci = Math.floor((b.x - origin[0]) / pitch), cj = Math.floor((b.y - origin[1]) / pitch);
        if (ci < 0 || cj < 0 || ci >= nx || cj >= ny) return;
        var key = ci + ',' + cj + ',' + Math.round(b.z / sp);
        if (kept[key]) return;
        kept[key] = true;
        var need = {};
        for (var nk in b.need) if (Object.prototype.hasOwnProperty.call(b.need, nk)) need[nk] = b.need[nk];
        need.seeded = true;
        cands.push({ x: b.x, y: b.y, z: b.z, normal: b.normal, need: need, cell: [ci, cj], tri: b.tri });
      });
      if (!cands.length) return 0;
      /* each seeded surface is traced on its own and judged below: not a speck, and not the rest of a surface the grid already holds */
      /* by height first (a rim and the apex over it are two surfaces whatever regionsOf joins), then by place */
      var byZ = {};
      cands.forEach(function (c) { var kz = Math.round(c.z / 1.5); (byZ[kz] = byZ[kz] || []).push(c); });
      Object.keys(byZ).forEach(function (kz) {
        footprints(sr = regionsOf(byZ[kz], out.grid), 0);
        sr.forEach(function (R) {
          var ledge = bridgeMin > 0 && R.beacons.length > 0 && R.beacons.every(function (b) { return b.need.spanMm != null && b.need.spanMm < bridgeMin; });
          if (!R.footprint || R.footprint.areaMm2 < (ledge ? LEDGE_MIN_AREA_MM2 : SEED_MIN_AREA_MM2)) return;
          var near = R.beacons.some(function (b) {
            for (var f = 0; f < fp.length; f++) { if (b.z >= fp[f].zl && b.z <= fp[f].zh && edgeD(fp[f], b.x, b.y) <= SEED_NEAR_MM) return true; }
            return false;
          });
          if (near) return;
          R.beacons.forEach(function (b) { beacons.push(b); added++; });
        });
      });
      return added;
    }
    out.ok = true;
    out.beacons = beacons;
    out.regions = regionsOf(beacons, out.grid);
    var seedPitch = +opts.seedPitchMm || 0;
    var wantFoot = opts.footprint === true || +opts.insetMm > 0 || seedPitch > 0;
    if (wantFoot) {
      var fcounts = {}, fk;
      for (fk in counts) if (Object.prototype.hasOwnProperty.call(counts, fk)) fcounts[fk] = counts[fk];
      var passes = [];
      if (seedPitch > 0 && seedPitch < pitch) passes.push([seedPitch, false]);
      if (bridgeMin > 0 && seedPitch > 0 && LEDGE_PITCH_MM < Math.min(pitch, seedPitch) && out.grid.nx * out.grid.ny * Math.pow(pitch / LEDGE_PITCH_MM, 2) <= LEDGE_MAX_CELLS) passes.push([LEDGE_PITCH_MM, true]);
      if (passes.length) counts.seeded = 0;
      for (var ps = 0; ps < passes.length; ps++) {
        footprints(out.regions, 0);                         /* where the grid's spots already hold: the coverage the finer look is read against */
        var added = seedMissed(out.regions, passes[ps][0], passes[ps][1]);
        counts.seeded += added;
        if (added) {
          /* a seeded surface is an area of its own, by height: the rim the grid held and the apex over it are planned as they were and as two */
          var held = beacons.filter(function (b) { return !b.need.seeded; }), seeds = {}, regs = held.length ? regionsOf(held, out.grid) : [];
          beacons.forEach(function (b) { if (b.need.seeded) { var kz = Math.round(b.z / 1.5); (seeds[kz] = seeds[kz] || []).push(b); } });
          Object.keys(seeds).forEach(function (kz) { regs = regs.concat(regionsOf(seeds[kz], out.grid)); });
          regs.sort(function (a, b2) { return b2.count - a.count; });
          regs.forEach(function (R, ri) { R.id = ri; });
          out.regions = regs;
        }
      }
      footprints(out.regions);
      for (fk in fcounts) if (Object.prototype.hasOwnProperty.call(fcounts, fk)) counts[fk] = fcounts[fk];   /* sampling asks needOf of columns that are no beacon's: not counted */
    }
    out.angleDeg = angleDeg;
    out.plateZ = plateZ;
    out.minDropMm = minDrop;
    out.bridgeMm = bridgeMm;
    out.reason = beacons.length
      ? beacons.length + ' beacon(s) at ' + pitch + ' mm pitch in ' + out.regions.length + ' region(s): ' +
        ['face', 'gap', 'edge', 'tip', 'ridge'].filter(function (k) { return counts[k]; })
          .map(function (k) { return counts[k] + ' ' + k; }).join(', ')
      : 'nothing needs holding at ' + pitch + ' mm pitch below ' + angleDeg + ' deg';
    return out;
  }

  /* Beacons in 8-adjacent cells, within 1.5 pitch of each other in z, are one
     region. Two beacons in ONE cell are never joined by that cell alone - a
     floor and the ceiling above it are different places. */
  function regionsOf(beacons, grid) {
    var pitch = grid.pitch, nx = grid.nx, byCell = new Map();
    var parent = new Int32Array(beacons.length), k;
    for (k = 0; k < beacons.length; k++) {
      parent[k] = k;
      var key = beacons[k].cell[1] * nx + beacons[k].cell[0];
      if (!byCell.has(key)) byCell.set(key, []);
      byCell.get(key).push(k);
    }
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    for (k = 0; k < beacons.length; k++) {
      var B = beacons[k];
      for (var di = -1; di <= 1; di++) for (var dj = -1; dj <= 1; dj++) {
        if (!di && !dj) continue;
        var ii = B.cell[0] + di, jj = B.cell[1] + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= grid.ny) continue;
        var L = byCell.get(jj * nx + ii);
        if (!L) continue;
        for (var m = 0; m < L.length; m++) {
          if (Math.abs(beacons[L[m]].z - B.z) <= 1.5 * pitch) {
            var ra = find(k), rb = find(L[m]);
            if (ra !== rb) parent[rb] = ra;
          }
        }
      }
    }
    var groups = new Map();
    for (k = 0; k < beacons.length; k++) {
      var r = find(k);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(beacons[k]);
    }
    var regions = [];
    groups.forEach(function (mem) {
      var c = [0, 0, 0], mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      var cells = new Set(), kinds = {};
      for (var q = 0; q < mem.length; q++) {
        var p = [mem[q].x, mem[q].y, mem[q].z];
        for (var a = 0; a < 3; a++) {
          c[a] += p[a] / mem.length;
          if (p[a] < mn[a]) mn[a] = p[a];
          if (p[a] > mx[a]) mx[a] = p[a];
        }
        cells.add(mem[q].cell[1] * nx + mem[q].cell[0]);
        kinds[mem[q].need.kind] = (kinds[mem[q].need.kind] || 0) + 1;
      }
      regions.push({
        point: c, beacons: mem, count: mem.length, cellCount: cells.size,
        planAreaMm2: cells.size * pitch * pitch, kinds: kinds, min: mn, max: mx,
        spanMm: Math.max(mx[0] - mn[0], mx[1] - mn[1])
      });
    });
    regions.sort(function (a, b) { return b.count - a.count; });
    for (k = 0; k < regions.length; k++) regions[k].id = k;
    return regions;
  }

  /* The areas' footprints as the sheet reads them (opts.footprints of nso_support_interface.js sheet()): plain data, [{ zl, zh, loops: [[[x, y], ...]] }],
     zl .. zh the heights of the area's spots and its edge. Areas with no footprint (a crease, a tip) are left out. */
  function footprintsOf(regions) {
    var out = [];
    (regions || []).forEach(function (R) {
      if (!R.footprint) return;
      var zl = Infinity, zh = -Infinity;
      R.beacons.forEach(function (b) { if (b.z < zl) zl = b.z; if (b.z > zh) zh = b.z; });
      var loops = R.footprint.loops.map(function (L) {
        return L.map(function (q) { if (q[2] < zl) zl = q[2]; if (q[2] > zh) zh = q[2]; return [q[0], q[1]]; });
      });
      out.push({ zl: zl, zh: zh, loops: loops });
    });
    return out;
  }

  var api = {
    PITCH_DEFAULT_MM: PITCH_DEFAULT_MM,
    ANGLE_DEFAULT_DEG: ANGLE_DEFAULT_DEG,
    MIN_DROP_MM: MIN_DROP_MM,
    BRIDGE_DEFAULT_MM: BRIDGE_DEFAULT_MM,
    BRIDGE_TILT_MAX_DEG: BRIDGE_TILT_MAX_DEG,
    SIDE_STANDOFF_MM: SIDE_STANDOFF_MM,
    RIDGE_GAP_MM: RIDGE_GAP_MM,
    RIDGE_REACH_MM: RIDGE_REACH_MM,
    CREASE_MIN_DEG: CREASE_MIN_DEG,
    INSET_PRODUCT_MM: INSET_PRODUCT_MM,
    BRIDGE_MIN_PRODUCT_MM: BRIDGE_MIN_PRODUCT_MM,
    SEED_PITCH_PRODUCT_MM: SEED_PITCH_MM,
    detect: detect,
    footprintsOf: footprintsOf,
    regionsOf: regionsOf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SupportBeacons = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
