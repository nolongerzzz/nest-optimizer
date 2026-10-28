/* ============================================================
   nso_support_blockers.js - Supports Blockers: boxes on the plate inside which
   no support is made. docs/SUPPORT-BLOCKERS.md.

   Loads as a classic script (window.NSO_SupportBlockers) and as a Node module.
   No DOM, no THREE. Everything is in the plate's own frame P - millimetres,
   Z up, the frame the Supports card detects and plans in (a piece's world soup,
   (x, -z, y) of the scene).

   A BOX is { id, c: [x, y, z], h: [hx, hy, hz] }: its centre and its half sizes.
   A list of boxes is a UNION: a point is blocked when any box holds it, so
   boxes that overlap are one larger area, whatever shape the overlap makes.

   WHAT A BLOCKER STOPS. Three things, all asked of the same list:
     - a SPOT (a beacon: the place a support would touch the piece) inside a
       box is not built - filterBeacons takes it out of the card's list, so it
       is not outlined, counted or planned;
     - the SURFACE a spot held, where the box cuts it: the area's footprint
       (the outline the card draws, and the contact surface the interface
       sheet is laid over) has the blocked part cut away - clipFootprint -
       so the sheet does not fill, under the part, what the box was put there
       to keep free;
     - the SUPPORT ITSELF: the box is an obstacle (soups), as another piece
       is, so a trunk or a sheet is routed round it and none stands in it.
   The first two are exact against the box where a surface is flat and to the
   grid's pitch where it is not; the third is the planner's own avoidance.
   ============================================================ */
(function (root) {
  'use strict';

  var MIN_MM = 1;              // no half-size below half of this: a box is at least 1 mm each way
  var TOL_MM = 1e-6;           // a spot exactly on a face is in
  var CELL_MM = 0.1;           // the raster a footprint is clipped on (the interface sheet's own: its edge is off by half of this at most)
  var CELL_CAP = 1.2e6;        // cells in one raster; a bigger footprint takes a coarser cell
  var SIMPLIFY_MM = 0.05;      // the traced loops lose the points that lie this near the line between their neighbours
  var MIN_LOOP_MM2 = 0.5;      // a loop of the clipped footprint smaller than this is a crumb of the raster, not a surface

  function copy(b) { return { id: b.id, c: b.c.slice(), h: b.h.slice() }; }
  function boxesOf(list) { return (list || []).filter(function (b) { return b && b.c && b.h; }); }

  /** The box's corners: { lo: [x, y, z], hi: [x, y, z] }. */
  function bounds(b) {
    return { lo: [b.c[0] - b.h[0], b.c[1] - b.h[1], b.c[2] - b.h[2]], hi: [b.c[0] + b.h[0], b.c[1] + b.h[1], b.c[2] + b.h[2]] };
  }
  /** A box from its corners. */
  function fromBounds(lo, hi, id) {
    return { id: id, c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2], h: [(hi[0] - lo[0]) / 2, (hi[1] - lo[1]) / 2, (hi[2] - lo[2]) / 2] };
  }
  function holds(b, x, y, z) {
    return Math.abs(x - b.c[0]) <= b.h[0] + TOL_MM && Math.abs(y - b.c[1]) <= b.h[1] + TOL_MM && Math.abs(z - b.c[2]) <= b.h[2] + TOL_MM;
  }
  /** Is the point (x, y, z) in any box? */
  function blocked(boxes, x, y, z) {
    for (var i = 0; i < boxes.length; i++) if (holds(boxes[i], x, y, z)) return true;
    return false;
  }
  /** Do two boxes share any volume (touching faces count: they are one area)? */
  function overlap(a, b) {
    for (var k = 0; k < 3; k++) if (Math.abs(a.c[k] - b.c[k]) > a.h[k] + b.h[k] + TOL_MM) return false;
    return true;
  }
  /** The boxes grouped into the areas they make together: [[box, ...], ...], each group a connected run of overlapping boxes. */
  function areas(boxes) {
    boxes = boxesOf(boxes);
    var seen = boxes.map(function () { return false; }), out = [];
    for (var i = 0; i < boxes.length; i++) {
      if (seen[i]) continue;
      var group = [], stack = [i];
      seen[i] = true;
      while (stack.length) {
        var k = stack.pop();
        group.push(boxes[k]);
        for (var j = 0; j < boxes.length; j++) if (!seen[j] && overlap(boxes[k], boxes[j])) { seen[j] = true; stack.push(j); }
      }
      out.push(group);
    }
    return out;
  }

  /** The beacons split into those the boxes leave and those they hold: { kept, held }. A beacon is { x, y, z, ... }. */
  function filterBeacons(list, boxes) {
    boxes = boxesOf(boxes);
    if (!boxes.length) return { kept: list, held: [] };
    var kept = [], held = [];
    list.forEach(function (b) { (blocked(boxes, b.x, b.y, b.z) ? held : kept).push(b); });
    return { kept: kept, held: held };
  }

  /** A box as a closed triangle soup (9 numbers a triangle, outward winding): the obstacle the planner routes round. */
  function soupOf(b) {
    var l = [b.c[0] - b.h[0], b.c[1] - b.h[1], b.c[2] - b.h[2]], h = [b.c[0] + b.h[0], b.c[1] + b.h[1], b.c[2] + b.h[2]];
    var v = function (i, j, k) { return [i ? h[0] : l[0], j ? h[1] : l[1], k ? h[2] : l[2]]; };
    var quads = [   // each quad counter-clockwise seen from outside
      [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)],   // -z
      [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],   // +z
      [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)],   // -y
      [v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)],   // +y
      [v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)],   // -x
      [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)]    // +x
    ];
    var out = new Float32Array(quads.length * 18), o = 0;
    quads.forEach(function (q) {
      [[0, 1, 2], [0, 2, 3]].forEach(function (t) { t.forEach(function (i) { out[o++] = q[i][0]; out[o++] = q[i][1]; out[o++] = q[i][2]; }); });
    });
    return out;
  }
  /** Every box as an obstacle soup. */
  function soups(boxes) { return boxesOf(boxes).map(soupOf); }

  /* The loops filled even-odd on the raster whose cell (i, j) is centred at (ox + i cell, oy + j cell): a scanline a row, the
     crossings of the edges that span it, sorted, and the cells between the 1st and 2nd, the 3rd and 4th ... set. */
  function fill(loops, ox, oy, cell, nx, ny) {
    var M = new Uint8Array(nx * ny), rows = new Array(ny);
    loops.forEach(function (L) {
      for (var q = 0, w = L.length - 1; q < L.length; w = q++) {
        var ax = L[w][0], ay = L[w][1], bx = L[q][0], by = L[q][1];
        if (ay === by) continue;
        var j0 = Math.max(0, Math.ceil((Math.min(ay, by) - oy) / cell)), j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) - oy) / cell));
        for (var j = j0; j <= j1; j++) {
          var y = oy + j * cell;
          if ((by > y) === (ay > y)) continue;                   // the same half-open rule the point-in-polygon test has
          (rows[j] || (rows[j] = [])).push(ax + (bx - ax) * (y - ay) / (by - ay));
        }
      }
    });
    for (var r = 0; r < ny; r++) {
      var xs = rows[r];
      if (!xs) continue;
      xs.sort(function (a, b) { return a - b; });
      for (var k = 0; k + 1 < xs.length; k += 2) {
        var i0 = Math.max(0, Math.ceil((xs[k] - ox) / cell)), i1 = Math.min(nx - 1, Math.ceil((xs[k + 1] - ox) / cell) - 1);
        for (var i = i0; i <= i1; i++) M[r * nx + i] = 1;
      }
    }
    return M;
  }
  function areaOf(L) {
    var a = 0;
    for (var q = 0, w = L.length - 1; q < L.length; w = q++) a += (L[w][0] * L[q][1]) - (L[q][0] * L[w][1]);
    return Math.abs(a) / 2;
  }
  function regionHelpers(Rg) {
    if (Rg && Rg.edtCells && Rg.isoLoops) return Rg;
    var SI = root && root.NSO_SupportInterface;
    if (!SI && typeof require === 'function') { try { SI = require('./nso_support_interface.js'); } catch (e) { SI = null; } }
    return SI && SI.region ? SI.region : null;
  }

  /**
   * A footprint with what the boxes hold cut away.
   *   fp       { loops: [[[x, y, z], ...], ...] }  an area's footprint (nso_support_beacons.js region.footprint), even-odd
   *   beacons  the area's spots, { x, y, z, normal }: they say how high the surface is under any (x, y) of it
   *   boxes    the blocker boxes
   *   pitch    the beacon grid's pitch, mm (how far a spot's plane is trusted)
   * Returns the footprint itself when no box reaches it (nothing is re-traced, so a plate with no blocker builds as it did), else a new
   * { loops, clipped: true } - the footprint on a CELL_MM raster with the cells whose surface lies in a box taken out, traced again
   * - or null when nothing of it is left.
   *
   * A cell's surface height is read off the plane of the spot nearest it in plan (z - (nx dx + ny dy) / nz), as the card's outline lifts its
   * cells; a cell is held when that point is in a box.
   */
  function clipFootprint(fp, beacons, boxes, pitch, Rg) {
    boxes = boxesOf(boxes);
    if (!fp || !fp.loops || !fp.loops.length || !boxes.length) return fp;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, zl = Infinity, zh = -Infinity;
    fp.loops.forEach(function (L) {
      L.forEach(function (q) {
        if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0];
        if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1];
        if (q.length > 2) { if (q[2] < zl) zl = q[2]; if (q[2] > zh) zh = q[2]; }
      });
    });
    (beacons || []).forEach(function (b) { if (b.z < zl) zl = b.z; if (b.z > zh) zh = b.z; });
    var reach = 1.5 * (pitch || 3);                          // a plane is trusted this far from its spot, and a sloped cell's height is off by about this
    var near = boxes.filter(function (b) {
      var B = bounds(b);
      return B.hi[0] >= x0 && B.lo[0] <= x1 && B.hi[1] >= y0 && B.lo[1] <= y1 && B.hi[2] >= zl - reach && B.lo[2] <= zh + reach;
    });
    if (!near.length) return fp;
    var R = regionHelpers(Rg);
    if (!R) return fp;
    var cell = CELL_MM, nx, ny;
    for (;;) {
      nx = Math.ceil((x1 - x0) / cell) + 3; ny = Math.ceil((y1 - y0) / cell) + 3;
      if (nx * ny <= CELL_CAP) break;
      cell *= 1.25;
    }
    var ox = x0 - cell, oy = y0 - cell, N = nx * ny, M = new Uint8Array(N);
    // the spots that can be nearest a cell a box holds: those within `reach` of a box's plan
    var spots = (beacons || []).filter(function (b) {
      return near.some(function (n) { return Math.abs(b.x - n.c[0]) <= n.h[0] + reach && Math.abs(b.y - n.c[1]) <= n.h[1] + reach; });
    });
    var any = false, cutAny = false, inside = fill(fp.loops, ox, oy, cell, nx, ny);
    for (var j = 0; j < ny; j++) {
      var y = oy + j * cell;
      for (var i = 0; i < nx; i++) {
        if (!inside[j * nx + i]) continue;
        var x = ox + i * cell;
        var held = false;
        for (var k = 0; k < near.length && !held; k++) {
          var n = near[k];
          if (Math.abs(x - n.c[0]) > n.h[0] + TOL_MM || Math.abs(y - n.c[1]) > n.h[1] + TOL_MM) continue;
          var z = surfaceZ(spots, x, y);
          held = z == null ? (zl >= n.c[2] - n.h[2] && zh <= n.c[2] + n.h[2]) : holds(n, x, y, z);
        }
        if (held) cutAny = true; else { M[j * nx + i] = 1; any = true; }
      }
    }
    if (!cutAny) return fp;                                   // a box was near, but held none of its surface
    if (!any) return null;
    var loops = R.isoLoops(R.edtCells(M, nx, ny), nx, ny, 0.5).map(function (ring) {
      if (R.simplifyRing) ring = R.simplifyRing(ring, SIMPLIFY_MM / cell);
      var a = ring[0], z0 = ring[ring.length - 1];
      if (ring.length > 3 && a[0] === z0[0] && a[1] === z0[1]) ring = ring.slice(0, -1);       // the detector's loops are open: the first point is not repeated
      return ring.map(function (v) {
        var px = ox + v[0] * cell, py = oy + v[1] * cell;
        var z = surfaceZ(beacons || [], px, py);
        return [px, py, z == null ? (zl + zh) / 2 : z];
      });
    }).filter(function (L) { return L.length >= 3 && areaOf(L) >= MIN_LOOP_MM2; });
    return loops.length ? Object.assign({}, fp, { loops: loops, clipped: true }) : null;
  }
  /* the height of the surface under (x, y), from the plane of the spot nearest it in plan; null when there is no spot */
  function surfaceZ(spots, x, y) {
    var best = null, bd = Infinity;
    for (var i = 0; i < spots.length; i++) {
      var d = (spots[i].x - x) * (spots[i].x - x) + (spots[i].y - y) * (spots[i].y - y);
      if (d < bd) { bd = d; best = spots[i]; }
    }
    if (!best) return null;
    var n = best.normal;
    if (!n || Math.abs(n[2]) < 0.3) return best.z;           // a wall's spot: no plane to lean on
    return best.z - (n[0] * (x - best.x) + n[1] * (y - best.y)) / n[2];
  }

  /**
   * The areas' footprints as the interface sheet reads them (nso_support_beacons.js footprintsOf), with what the boxes hold cut away.
   * regions: det.beaconRegions. With no box that reaches an area its footprint is what footprintsOf gives.
   */
  function footprintsOf(regions, boxes, pitch, Rg) {
    var SB = root && root.NSO_SupportBeacons;
    if (!SB && typeof require === 'function') { try { SB = require('./nso_support_beacons.js'); } catch (e) { SB = null; } }
    boxes = boxesOf(boxes);
    var cut = !boxes.length ? regions : (regions || []).map(function (r) {
      if (!r.footprint) return r;
      var fp = clipFootprint(r.footprint, r.beacons, boxes, pitch, Rg);
      return fp === r.footprint ? r : Object.assign({}, r, { footprint: fp });
    });
    return SB.footprintsOf(cut);
  }

  var api = {
    MIN_MM: MIN_MM, CELL_MM: CELL_MM,
    copy: copy, bounds: bounds, fromBounds: fromBounds, blocked: blocked, holds: holds, overlap: overlap, areas: areas,
    filterBeacons: filterBeacons, soupOf: soupOf, soups: soups, clipFootprint: clipFootprint, footprintsOf: footprintsOf, surfaceZ: surfaceZ
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_SupportBlockers = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
