/* Findings - Check's report, sorted into problems a person can go and look at.
 *
 * Pure: no DOM, no THREE. app-findings.js draws and acts on what this returns;
 * tools/nso_findings_test.js holds it to NSO_Defects' own report in node.
 *
 * WHAT IT ADDS. NSO_Defects.locate() (nso-defects.js) reports counts and flat
 * coordinate runs - "221 open edges" and 1,326 floats. Nothing in that says
 * how many separate places are wrong, or where to point the camera. This file
 * groups the marks into PROBLEMS: one per hole, one per patch of doubled
 * edges, one per knot of piercing triangles, one per thin wall. It reads the
 * report's `marks` and nothing else, and it changes no count: every edge and
 * every triangle the report marked lands in exactly one problem, which the
 * test asserts on every fixture it runs.
 *
 * HOW THINGS ARE GROUPED. Edges (open, non-manifold) are in the same problem
 * when an endpoint of one is within JOIN_EDGE of an endpoint of the other.
 * The marks are welded vertices, so edges that share a vertex share an
 * endpoint exactly and a boundary loop is one problem however it winds; two
 * loops a hair apart are one problem too, which is what "close together"
 * means to someone looking at the print. Endpoints, not boxes: the boxes of
 * the two rims of a 1.2 mm cup wall overlap, the rims do not touch, and they
 * are two holes. Triangles (piercing, thin) are in the same problem when
 * their boxes, grown by the join distance, overlap:
 *
 *   open, nonManifold   JOIN_EDGE    0.05 mm - well under any real feature,
 *                                    well over float32 noise at plate scale
 *   pierce              JOIN_EDGE    the two faces of a pair cross, so their
 *                                    boxes overlap with no slack at all
 *   thin                minWall      a thin face and the face its ray hit are
 *                                    at most one wall apart, by definition
 *
 * Coordinates stay in whatever space the marks are in (the raw Z-up soup's,
 * as NSO_Defects returns them). app-findings.js moves the centres to the
 * display mesh the same way app-defects.js moves the marks.
 *
 * NON-SOLID SCOPE. `rows()` reads `report.nonSolid`, which app-defects.js set
 * from `nsoNonSolid(m)` when it ran the check; nothing here derives intent
 * from an edge count. On a flagged piece the open-edge row is DECLARED, not a
 * fault: neutral, no fix button, and it does not stop the "Nothing wrong
 * found" row. docs/NON-SOLID.md section 3. */
(function (global) {
  'use strict';

  var JOIN_EDGE = 0.05;

  /* ---- clustering ---- */

  /* items: [{lo:[x,y,z], hi:[x,y,z]}]. Union-find over a uniform hash: each
     item goes into every cell its grown box covers, and items sharing a cell
     are tested box against box. The cell is at least the join distance and at
     least the median item, so an item covers a handful of cells. */
  function cluster(items, join) {
    var n = items.length;
    var parent = new Int32Array(n);
    for (var i = 0; i < n; i++) parent[i] = i;
    function find(a) {
      while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
      return a;
    }
    function union(a, b) {
      a = find(a); b = find(b);
      if (a !== b) parent[a < b ? b : a] = (a < b ? a : b);
    }
    if (n < 2) return groupsOf(parent, n, find);

    var sizes = [];
    for (i = 0; i < n; i++) {
      var it = items[i];
      sizes.push(Math.max(it.hi[0] - it.lo[0], it.hi[1] - it.lo[1], it.hi[2] - it.lo[2]));
    }
    sizes.sort(function (a, b) { return a - b; });
    var cell = Math.max(join * 2, sizes[sizes.length >> 1], 1e-3);
    var h = join / 2;
    var grid = new Map();
    for (i = 0; i < n; i++) {
      it = items[i];
      var x0 = Math.floor((it.lo[0] - h) / cell), x1 = Math.floor((it.hi[0] + h) / cell);
      var y0 = Math.floor((it.lo[1] - h) / cell), y1 = Math.floor((it.hi[1] + h) / cell);
      var z0 = Math.floor((it.lo[2] - h) / cell), z1 = Math.floor((it.hi[2] + h) / cell);
      for (var gx = x0; gx <= x1; gx++) for (var gy = y0; gy <= y1; gy++) for (var gz = z0; gz <= z1; gz++) {
        var key = gx + ',' + gy + ',' + gz;
        var bucket = grid.get(key);
        if (!bucket) { grid.set(key, [i]); continue; }
        for (var k = 0; k < bucket.length; k++) {
          var j = bucket[k];
          if (find(i) === find(j)) continue;
          var o = items[j];
          if (it.lo[0] - join <= o.hi[0] && o.lo[0] - join <= it.hi[0] &&
              it.lo[1] - join <= o.hi[1] && o.lo[1] - join <= it.hi[1] &&
              it.lo[2] - join <= o.hi[2] && o.lo[2] - join <= it.hi[2]) union(i, j);
        }
        bucket.push(i);
      }
    }
    return groupsOf(parent, n, find);
  }
  function groupsOf(parent, n, find) {
    var by = new Map(), out = [];
    for (var i = 0; i < n; i++) {
      var r = find(i);
      var g = by.get(r);
      if (!g) { g = []; by.set(r, g); out.push(g); }
      g.push(i);
    }
    return out;
  }

  /* A flat run of `stride` floats per item (6 for a segment, 9 for a
     triangle) becomes boxes. */
  function boxes(flat, stride) {
    var out = [];
    for (var i = 0; i + stride - 1 < flat.length; i += stride) {
      var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (var v = 0; v < stride; v += 3) for (var k = 0; k < 3; k++) {
        var c = flat[i + v + k];
        if (c < lo[k]) lo[k] = c;
        if (c > hi[k]) hi[k] = c;
      }
      out.push({ lo: lo, hi: hi });
    }
    return out;
  }

  /* Segments (6 floats each) grouped by endpoint proximity: a hash of cell
     `join`, and each endpoint looks in its own cell and the 26 round it. */
  function clusterEdges(flat, join) {
    var n = Math.floor(flat.length / 6);
    var parent = new Int32Array(n);
    for (var i = 0; i < n; i++) parent[i] = i;
    function find(a) {
      while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
      return a;
    }
    var cell = Math.max(join, 1e-6), j2 = join * join;
    var grid = new Map();
    for (i = 0; i < n; i++) {
      for (var e = 0; e < 2; e++) {
        var o = i * 6 + e * 3;
        var x = flat[o], y = flat[o + 1], z = flat[o + 2];
        var cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
          var b = grid.get((cx + dx) + ',' + (cy + dy) + ',' + (cz + dz));
          if (!b) continue;
          for (var k = 0; k < b.length; k += 4) {
            var ex = b[k + 1] - x, ey = b[k + 2] - y, ez = b[k + 3] - z;
            if (ex * ex + ey * ey + ez * ez > j2) continue;
            var ra = find(i), rb = find(b[k]);
            if (ra !== rb) parent[ra < rb ? rb : ra] = (ra < rb ? ra : rb);
          }
        }
        var key = cx + ',' + cy + ',' + cz;
        var own = grid.get(key);
        if (!own) grid.set(key, own = []);
        own.push(i, x, y, z);
      }
    }
    return groupsOf(parent, n, find);
  }

  function problemsOf(kind, flat, stride, join) {
    flat = flat || [];
    var items = boxes(flat, stride);
    var groups = (stride === 6) ? clusterEdges(flat, join) : cluster(items, join);
    var out = [];
    for (var g = 0; g < groups.length; g++) {
      var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (var i = 0; i < groups[g].length; i++) {
        var it = items[groups[g][i]];
        for (var k = 0; k < 3; k++) {
          if (it.lo[k] < lo[k]) lo[k] = it.lo[k];
          if (it.hi[k] > hi[k]) hi[k] = it.hi[k];
        }
      }
      out.push({
        kind: kind,
        count: groups[g].length,              // edges, or triangles
        members: groups[g],                   // indices into the marks run
        lo: lo, hi: hi,
        center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
        radius: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2
      });
    }
    // Biggest first, so problem 1 is the one most worth a look.
    out.sort(function (a, b) { return b.count - a.count || b.radius - a.radius; });
    for (var n = 0; n < out.length; n++) out[n].number = n + 1;
    return out;
  }

  /* report -> { open, nonManifold, pierce, thin }, each a list of problems. */
  function group(report, opts) {
    opts = opts || {};
    var mk = report.marks || {};
    var minWall = (report.wall && report.wall.thresholdMm > 0) ? report.wall.thresholdMm : 0.42;
    var joinEdge = opts.joinEdge != null ? opts.joinEdge : JOIN_EDGE;
    return {
      open: problemsOf('open', mk.openEdges, 6, joinEdge),
      nonManifold: problemsOf('nonManifold', mk.nonManifoldEdges, 6, joinEdge),
      pierce: problemsOf('pierce', mk.pierceTris, 9, joinEdge),
      thin: problemsOf('thin', mk.thinTris, 9, opts.joinThin != null ? opts.joinThin : minWall)
    };
  }

  /* ---- the card's rows, in words ---- */

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

  /* One row per kind of problem found, in the order the card shows them.
     Counts are the REPORT's, never re-counted here; the number of places is
     the grouping's. `fix` names the existing control a row's one button
     presses; `handledBy` is the sentence for a row that has none yet. */
  function rows(report, problems) {
    var out = [];
    var nonSolid = !!report.nonSolid;
    var P = problems || group(report);
    if (report.openEdges) {
      var h = P.open.length;
      if (nonSolid) {
        out.push({
          kind: 'open', declared: true, problems: P.open,
          title: plural(h, 'opening') + ', ' + plural(report.openEdges, 'open edge') + ' - declared',
          meaning: 'This piece is flagged non-solid, so it is meant to be open here. Not a fault; nothing to fix.',
          fix: null, handledBy: null
        });
      } else {
        out.push({
          kind: 'open', problems: P.open,
          title: plural(h, 'hole') + ', ' + plural(report.openEdges, 'open edge'),
          meaning: 'The surface has gaps, so a slicer has to guess where the inside is and can leave walls or layers out.',
          fix: 'cap', handledBy: null
        });
      }
    }
    if (report.nonManifoldEdges) {
      out.push({
        kind: 'nonManifold', problems: P.nonManifold,
        title: plural(P.nonManifold.length, 'place') + ', ' +
               plural(report.nonManifoldEdges, 'doubled or pinched edge'),
        meaning: 'More than two faces meet at these edges, so inside and outside are ambiguous and a slicer may add or drop walls there.',
        fix: 'sealRepair', handledBy: null
      });
    }
    if (report.pierce) {
      out.push({
        kind: 'pierce', problems: P.pierce,
        title: plural(P.pierce.length, 'place') + ', ' + plural(report.pierce, 'piercing pair') +
               ' - pieces passing through each other',
        meaning: 'Parts of the surface pass through each other, so the slicer may fill or hollow the overlap unpredictably.',
        fix: null,
        handledBy: 'No tool in the app removes this yet. Seal with Repair will not make it worse; the overlap has to be remodelled.'
      });
    }
    if (report.wall && report.wall.thinFaces) {
      out.push({
        kind: 'thin', problems: P.thin,
        title: plural(P.thin.length, 'place') + ', ' + plural(report.wall.thinFaces, 'face') + ' under ' +
               report.wall.thresholdMm + ' mm (thinnest ' + report.wall.minWallMm.toFixed(3) + ' mm)',
        meaning: 'These walls or gaps are thinner than one nozzle line, so they may print as nothing or fuse shut.',
        fix: null,
        handledBy: 'Handled by Thicken out or Thicken in, in the Finish menu under Shape.'
      });
    }
    if (report.verdict === 'PASS') {
      out.push({
        kind: 'clean', problems: [],
        title: 'Nothing wrong found',
        meaning: nonSolid
          ? 'Every check that applies passed. The open edges above are the ones this piece is meant to have.'
          : 'Every check passed: this piece should slice as one closed solid.',
        fix: null, handledBy: null
      });
    }
    return out;
  }

  /* Counted in the verdict, with no place on the mesh to point at (the same
     list app-defects.js names as "counted, not painted"). The card says them
     in a line so a FAIL never sits under an empty list. */
  function unplaced(report) {
    var n = [];
    if (report.flippedEdges) n.push(plural(report.flippedEdges, 'inconsistently wound edge'));
    if (report.degenerateTris) n.push(plural(report.degenerateTris, 'degenerate triangle'));
    return n;
  }

  /* The before/after line for one kind. */
  var NOUN = {
    open: ['open edge', 'open edges'],
    nonManifold: ['doubled or pinched edge', 'doubled or pinched edges'],
    pierce: ['piercing pair', 'piercing pairs'],
    thin: ['thin face', 'thin faces']
  };
  function countOf(report, kind) {
    if (!report) return 0;
    if (kind === 'open') return report.openEdges || 0;
    if (kind === 'nonManifold') return report.nonManifoldEdges || 0;
    if (kind === 'pierce') return report.pierce || 0;
    if (kind === 'thin') return (report.wall && report.wall.thinFaces) || 0;
    return 0;
  }
  function beforeNow(before, after, kind) {
    var b = countOf(before, kind), a = countOf(after, kind);
    return 'Before: ' + b + ' ' + NOUN[kind][b === 1 ? 0 : 1] + '. Now: ' + a + '.';
  }

  var api = {
    JOIN_EDGE: JOIN_EDGE,
    KINDS: ['open', 'nonManifold', 'pierce', 'thin'],
    group: group,
    _clusterEdges: clusterEdges,
    rows: rows,
    unplaced: unplaced,
    countOf: countOf,
    beforeNow: beforeNow,
    _cluster: cluster
  };
  global.NSO_Findings = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
