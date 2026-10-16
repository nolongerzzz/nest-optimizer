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
        if (span <= bridgeMm) { counts.bridged++; return null; }
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

    out.ok = true;
    out.beacons = beacons;
    out.regions = regionsOf(beacons, out.grid);
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
    detect: detect,
    regionsOf: regionsOf
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SupportBeacons = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
