/* Defect LOCATOR — the canonical checker's findings with their coordinates.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * It is not a fourth checker. Every number it reports comes out of the
 * canonical implementations already in the repo, and it adds exactly one
 * thing: WHERE. `NSO_Repair.inspect()` says "4 piercing pairs"; this says
 * which four pairs, at which coordinates, so `app-defects.js` can paint them
 * on the piece in the viewport instead of printing a number the user then has
 * to go and find.
 *
 * The split, check by check:
 *
 *   open edges, non-manifold edges,     NSO_Repair._buildEdges / ._analyze —
 *   boundary loops, components          the same edge table `analyze()` counts
 *   winding, degenerate triangles       counted HERE, the validator's way, not
 *                                       analyze()'s — see the note at
 *                                       degenerateRaw() for the two
 *                                       long-standing definitions and why
 *                                       this file takes the validator's
 *   piercing / coplanar pairs           NSO_Repair._selfIntersectionDetail
 *                                       with { collect: true }, which records
 *                                       the pairs its own testPair counted and
 *                                       changes no count
 *   wall / gap                          TRANSCRIBED HERE, see below
 *
 * Only the wall/gap check is new code, and only because there was no browser
 * copy of it to reuse: docs/NON-SOLID.md §6 said "the wall/gap check lives in
 * the validator, not in the app. Nothing in the browser measures thickness
 * yet." That is now out of date — this file is the browser copy, transcribed
 * line for line from `wall_thickness()` in tools/mesh_validate.py (same
 * inward-normal ray from every centroid, same uniform hash walked by 3D DDA,
 * same "ignore the source triangle and anything sharing a welded vertex with
 * it", same one-weld-radius of slack so a rib built AT the threshold passes),
 * and tools/nso_defect_overlay_test.js holds the two to the same numbers on
 * every fixture in the repo, the way tools/nso_selfint_equiv_test.js already
 * holds the self-intersection pair.
 *
 * EQUIVALENCE. `locate(raw, { minWall: 0.42, nonSolid: f })` is
 * `python3 tools/mesh_validate.py <file> --min-wall 0.42 [--non-solid]`:
 * same measurements, and `verdict()` transcribed as the same list with the
 * same one flag-conditional entry (open edges). Nothing here re-derives
 * intent from an edge count — `nonSolid` is passed in, never guessed. See
 * docs/NON-SOLID.md §3, the rule for new consumers.
 *
 * COORDINATES. Everything comes back in the raw soup's own space, the space
 * the caller handed in. The rotate-and-centre into the viewport's display
 * space is app-defects.js's job, because that transform belongs to the piece
 * on the plate and not to the check.
 *
 * Node: module.exports as well as window.NSO_Defects, for the tools. */
(function (global) {
  'use strict';

  var VERSION = 'NSO_Defects/1.0.0';

  /* The nozzle floor. One extrusion line at a 0.4 nozzle, the figure
     nso_skin.js states for its thinnest rib and the only nozzle-derived
     number in the repo. A stated default, not a measurement, and a
     parameter. Same constant as NOZZLE_MIN_WALL in tools/mesh_validate.py. */
  var NOZZLE_MIN_WALL = 0.42;
  var WALL_PROBE = 5.0;
  /* Plane-distance / ray epsilon, mm. SELFINT_EPS in mesh_validate.py. */
  var EPS = 1e-9;

  function repair() {
    var R = global.NSO_Repair;
    if (!R || typeof R._weldToIndexed !== 'function' || typeof R._buildEdges !== 'function' ||
        typeof R._analyze !== 'function' || typeof R._selfIntersectionDetail !== 'function') {
      throw new Error('NSO_Defects needs NSO_Repair.js (with its _weldToIndexed / _buildEdges / ' +
                      '_analyze / _selfIntersectionDetail hooks) loaded first');
    }
    return R;
  }

  function faceCount(m) { return m.faces.length / 3; }

  /* ------------------------------------------------------------------ *
   * two numbers that are NOT NSO_Repair's
   * ------------------------------------------------------------------ *
   *
   * `NSO_Repair.analyze()` and `tools/mesh_validate.py` count degenerate
   * triangles and inconsistent winding differently, and have since before
   * this file existed. Both are defensible where they sit, and neither is
   * wrong; they are answering to different callers:
   *
   *   degenerate    analyze() measures the WELDED mesh, because that is the
   *                 mesh its repair stages are about to operate on. The
   *                 validator measures the RAW soup, because that is what is
   *                 in the file. On the tape fixture the weld collapses 297
   *                 slivers to exactly zero area, so analyze() reads 297 and
   *                 mesh_validate.py reads 0 - the same mesh, two honest
   *                 answers to two different questions.
   *   winding       analyze() counts UNDIRECTED edges used twice in the same
   *                 direction, and classifies an edge used more than twice as
   *                 non-manifold instead. The validator counts DIRECTED edges
   *                 used more than once, which also fires on the extra uses
   *                 along a non-manifold run. On synth_dup_exact that is 0
   *                 against 3.
   *
   * `locate()` is the VALIDATOR's battery in the browser, so it reports the
   * validator's two, computed here rather than read off analyze(). Nothing in
   * NSO_Repair changes: its repair gate keeps its own numbers with their own
   * meaning. tools/nso_defect_overlay_test.js pins both sides of this - that
   * locate() equals mesh_validate.py, AND that the divergence from
   * analyze() is the one described above and not some new drift. */

  // `ar < 1e-12` over the raw soup, exactly as validate() does it.
  function degenerateRaw(rawTris) {
    var n = 0;
    for (var i = 0; i + 8 < rawTris.length; i += 9) {
      var ux = rawTris[i + 3] - rawTris[i], uy = rawTris[i + 4] - rawTris[i + 1], uz = rawTris[i + 5] - rawTris[i + 2];
      var vx = rawTris[i + 6] - rawTris[i], vy = rawTris[i + 7] - rawTris[i + 1], vz = rawTris[i + 8] - rawTris[i + 2];
      var cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      if (0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz) < 1e-12) n++;
    }
    return n;
  }

  // Directed edges used more than once, exactly as edge_report() does it.
  function windingEdges(m) {
    var directed = Object.create(null);
    var nf = faceCount(m);
    for (var f = 0; f < nf; f++) {
      var a = m.faces[f * 3], b = m.faces[f * 3 + 1], c = m.faces[f * 3 + 2];
      var e = [a + '>' + b, b + '>' + c, c + '>' + a];
      for (var i = 0; i < 3; i++) directed[e[i]] = (directed[e[i]] || 0) + 1;
    }
    var n = 0;
    for (var k in directed) if (directed[k] > 1) n++;
    return n;
  }
  function triVerts(m, f, out) {
    for (var i = 0; i < 3; i++) {
      var v = m.faces[f * 3 + i] * 3;
      out.push(m.pos[v], m.pos[v + 1], m.pos[v + 2]);
    }
  }

  /* ------------------------------------------------------------------ *
   * wall / gap — transcribed from wall_thickness() in mesh_validate.py
   * ------------------------------------------------------------------ */

  /* Moller-Trumbore. Distance along unit `d` from `orig` to the triangle
     (ax..cz), or -1. `_ray_tri` in mesh_validate.py, same epsilon handling:
     the barycentric tests are eps-tolerant, and a hit at or behind the origin
     (t <= eps) is not a hit. */
  function rayTri(ox, oy, oz, dx, dy, dz,
                  ax, ay, az, bx, by, bz, cx, cy, cz, eps) {
    var e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    var e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    var px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    var det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-14 && det < 1e-14) return -1;
    var inv = 1 / det;
    var sx = ox - ax, sy = oy - ay, sz = oz - az;
    var u = (sx * px + sy * py + sz * pz) * inv;
    if (u < -eps || u > 1 + eps) return -1;
    var qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    var v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < -eps || u + v > 1 + eps) return -1;
    var t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t > eps ? t : -1;
  }

  /* Distance from each face to the nearest surface BEHIND it.
   *
   * From every triangle's centroid a ray is cast along the INWARD normal (the
   * side the material is on for an outward-wound surface) and stopped at the
   * first triangle it meets within `probe` mm, ignoring the source triangle
   * and anything sharing a welded vertex with it. On a shell with two coherent
   * sides - a cup, a squishy - that distance is the wall thickness, face by
   * face. A face that meets nothing within the probe is a SHEET (a
   * single-surface vase-mode wall, or a wall thicker than the probe) and is
   * counted, not failed.
   *
   * The ray does not ask which way the hit triangle faces, so a thin wall can
   * never be missed; what it additionally catches is a thin GAP - two sheets
   * closer than a line width, which FDM fuses into one. Read the name as
   * "nearest surface behind" on anything that is not a shell.
   *
   * Unlike the validator, which keeps 8 examples for its report, this keeps
   * EVERY thin face: they are what gets painted, and a truncated list would
   * paint a truncated defect. */
  function wallThickness(m, minWall, probe, eps, weldTol) {
    var nf = faceCount(m);
    var out = {
      thresholdMm: minWall, probeMm: probe, facesMeasured: 0,
      thinFaces: 0, sheetFaces: 0, minWallMm: null, faces: []
    };
    if (!nf || !(probe > 0) || !(minWall > 0)) return out;

    // Per-face boxes, and the mean box diagonal that sets the cell pitch.
    var boxes = new Float64Array(nf * 6);
    var diagSum = 0;
    for (var f = 0; f < nf; f++) {
      var a = m.faces[f * 3] * 3, b = m.faces[f * 3 + 1] * 3, c = m.faces[f * 3 + 2] * 3;
      var d2 = 0;
      for (var k = 0; k < 3; k++) {
        var lo = Math.min(m.pos[a + k], m.pos[b + k], m.pos[c + k]);
        var hi = Math.max(m.pos[a + k], m.pos[b + k], m.pos[c + k]);
        boxes[f * 6 + k] = lo; boxes[f * 6 + 3 + k] = hi;
        d2 += (hi - lo) * (hi - lo);
      }
      diagSum += Math.sqrt(d2);
    }
    var cell = Math.max(diagSum / nf, 1e-9);
    var inv = 1 / cell;

    var grid = Object.create(null);
    for (f = 0; f < nf; f++) {
      var x0 = Math.floor(boxes[f * 6] * inv), x1 = Math.floor(boxes[f * 6 + 3] * inv);
      var y0 = Math.floor(boxes[f * 6 + 1] * inv), y1 = Math.floor(boxes[f * 6 + 4] * inv);
      var z0 = Math.floor(boxes[f * 6 + 2] * inv), z1 = Math.floor(boxes[f * 6 + 5] * inv);
      for (var ix = x0; ix <= x1; ix++) {
        for (var iy = y0; iy <= y1; iy++) {
          for (var iz = z0; iz <= z1; iz++) {
            var key = ix + ',' + iy + ',' + iz;
            (grid[key] || (grid[key] = [])).push(f);
          }
        }
      }
    }

    /* "Shares a welded vertex" is the same skip the self-intersection test
       makes, and for the same reason: an adjacent triangle is touching by
       construction, so its distance is zero and means nothing. */
    var seen = new Int32Array(nf);          // stamped per source face, instead of a Set
    var stamp = 0;
    var best_all = null;
    var ci = [0, 0, 0], step = [0, 0, 0], tMax = [0, 0, 0], tDelta = [0, 0, 0];

    for (f = 0; f < nf; f++) {
      var ia = m.faces[f * 3], ib = m.faces[f * 3 + 1], ic = m.faces[f * 3 + 2];
      var pa = ia * 3, pb = ib * 3, pc = ic * 3;
      var ax = m.pos[pa], ay = m.pos[pa + 1], az = m.pos[pa + 2];
      var bx = m.pos[pb], by = m.pos[pb + 1], bz = m.pos[pb + 2];
      var cx = m.pos[pc], cy = m.pos[pc + 1], cz = m.pos[pc + 2];
      var ux = bx - ax, uy = by - ay, uz = bz - az;
      var vx = cx - ax, vy = cy - ay, vz = cz - az;
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (!(L > 0)) continue;               // degenerate, counted apart
      var dx = -nx / L, dy = -ny / L, dz = -nz / L;
      var ox = (ax + bx + cx) / 3, oy = (ay + by + cy) / 3, oz = (az + bz + cz) / 3;

      // 3D DDA along o + d*s, s in [0, probe]
      var o = [ox, oy, oz], d = [dx, dy, dz];
      for (k = 0; k < 3; k++) {
        ci[k] = Math.floor(o[k] * inv);
        step[k] = 0; tMax[k] = Infinity; tDelta[k] = Infinity;
        if (d[k] > 1e-15) {
          step[k] = 1;
          tMax[k] = ((ci[k] + 1) * cell - o[k]) / d[k];
          tDelta[k] = cell / d[k];
        } else if (d[k] < -1e-15) {
          step[k] = -1;
          tMax[k] = (ci[k] * cell - o[k]) / d[k];
          tDelta[k] = -cell / d[k];
        }
      }

      var best = -1, bestU = -1;
      stamp++;
      var entry = 0;
      while (entry <= probe) {
        if (best >= 0 && entry > best) break;
        var bucket = grid[ci[0] + ',' + ci[1] + ',' + ci[2]];
        if (bucket) {
          for (var q = 0; q < bucket.length; q++) {
            var u2 = bucket[q];
            if (u2 === f || seen[u2] === stamp) continue;
            seen[u2] = stamp;
            var ja = m.faces[u2 * 3], jb = m.faces[u2 * 3 + 1], jc = m.faces[u2 * 3 + 2];
            if (ja === ia || ja === ib || ja === ic ||
                jb === ia || jb === ib || jb === ic ||
                jc === ia || jc === ib || jc === ic) continue;
            var qa = ja * 3, qb = jb * 3, qc = jc * 3;
            var s = rayTri(ox, oy, oz, dx, dy, dz,
                           m.pos[qa], m.pos[qa + 1], m.pos[qa + 2],
                           m.pos[qb], m.pos[qb + 1], m.pos[qb + 2],
                           m.pos[qc], m.pos[qc + 1], m.pos[qc + 2], eps);
            if (s >= 0 && s <= probe && (best < 0 || s < best)) { best = s; bestU = u2; }
          }
        }
        var kk = 0;
        if (tMax[1] < tMax[kk]) kk = 1;
        if (tMax[2] < tMax[kk]) kk = 2;
        entry = tMax[kk];
        if (!(entry < Infinity)) break;     // the ray leaves the grid on every axis
        ci[kk] += step[kk];
        tMax[kk] += tDelta[kk];
      }

      out.facesMeasured++;
      if (best < 0) { out.sheetFaces++; continue; }
      if (best_all === null || best < best_all) best_all = best;
      /* A wall built AT the threshold passes: float32 puts a 0.42 mm rib at
         0.419998, and that is the file's rounding, not a thin wall. One weld
         radius of slack, the same figure the rest of the battery calls "the
         same point". */
      if (best < minWall - weldTol) {
        out.thinFaces++;
        out.faces.push({ face: f, hit: bestU, mm: best });
      }
    }
    out.minWallMm = best_all;
    return out;
  }

  /* ------------------------------------------------------------------ *
   * the verdict — verdict() in mesh_validate.py, transcribed
   * ------------------------------------------------------------------ */

  /* Kept as a list, in the same order, so the split stays readable in one
     place and cannot drift into a blanket bypass: every entry but `open
     edges` applies whether or not the piece is declared non-solid.
     docs/NON-SOLID.md §3. */
  function verdictFails(r, nonSolid) {
    var fails = [];
    if (r.nonManifoldEdges) fails.push('non-manifold edges ' + r.nonManifoldEdges);
    if (r.flippedEdges) fails.push('inconsistent winding ' + r.flippedEdges);
    if (r.degenerateTris) fails.push('degenerate triangles ' + r.degenerateTris);
    if (r.pierce) fails.push('self-intersecting (piercing) pairs ' + r.pierce);
    if (!nonSolid && r.openEdges) fails.push('open edges ' + r.openEdges + ' (flag it non-solid if intentional)');
    if (r.wall && r.wall.thinFaces) {
      fails.push('wall/gap under ' + r.wall.thresholdMm + ' mm on ' + r.wall.thinFaces +
                 ' face(s), thinnest ' + r.wall.minWallMm.toFixed(3) + ' mm');
    }
    return fails;
  }

  /* ------------------------------------------------------------------ *
   * locate
   * ------------------------------------------------------------------ */

  /* `rawTris` is the app's raw soup (9 floats per triangle). Options:
   *
   *   nonSolid   the piece's own flag, passed in by the caller from
   *              nsoNonSolid(m). NEVER inferred here. Changes the verdict
   *              only - every measurement below is taken either way.
   *   minWall    wall/gap threshold, mm. Default NOZZLE_MIN_WALL. 0 turns the
   *              wall pass off, as `--min-wall 0` does in the validator.
   *   wallProbe  how far the ray looks, mm. Default WALL_PROBE.
   *   weldTol    adjacency weld radius. Default NSO_Repair.WELD_TOL.
   *
   * Returns the counts, the verdict, and `marks`: flat coordinate arrays in
   * the caller's own space, ready to become geometry.
   *
   *   marks.openEdges        6 floats per segment (x1 y1 z1 x2 y2 z2)
   *   marks.nonManifoldEdges 6 floats per segment
   *   marks.pierceTris       9 floats per triangle
   *   marks.thinTris         9 floats per triangle
   *
   * Coplanar overlap is COUNTED and not marked. docs/NSO_Repair.md records
   * why it stays out of the gate - a boolean seam produces legitimate
   * coplanar contact - and painting it would cry wolf on every fused piece.
   *
   * A thin wall is marked on BOTH sides: the face that measured thin and the
   * face its ray hit. One face alone reads as a skin; the pair reads as the
   * wall, which is the thing that is too thin. `wall.thinFaces` stays the
   * validator's number - the faces that measured - so the count and the paint
   * can differ, on purpose. */
  function locate(rawTris, options) {
    var R = repair();
    var opts = options || {};
    var weldTol = (opts.weldTol != null ? opts.weldTol : R.WELD_TOL);
    var minWall = (opts.minWall != null ? opts.minWall : NOZZLE_MIN_WALL);
    var probe = (opts.wallProbe != null ? opts.wallProbe : WALL_PROBE);
    var nonSolid = !!opts.nonSolid;

    var w = R._weldToIndexed(rawTris, weldTol);
    var m = w.mesh;
    var base = R._analyze(m, { selfIntersections: false });
    var si = R._selfIntersectionDetail(m, { collect: true });

    var edges = R._buildEdges(m);
    var openXYZ = [], nmXYZ = [];
    for (var key in edges) {
      var rec = edges[key];
      if (rec.count !== 1 && rec.count <= 2) continue;
      var pa = rec.a * 3, pb = rec.b * 3;
      var dst = (rec.count === 1) ? openXYZ : nmXYZ;
      dst.push(m.pos[pa], m.pos[pa + 1], m.pos[pa + 2],
               m.pos[pb], m.pos[pb + 1], m.pos[pb + 2]);
    }

    var pierceFaces = Object.create(null);
    for (var i = 0; i < si.pairs.length; i++) {
      var pr = si.pairs[i];
      if (pr.kind !== 'pierce') continue;
      pierceFaces[pr.a] = 1;
      pierceFaces[pr.b] = 1;
    }
    var pierceXYZ = [];
    for (var pf in pierceFaces) triVerts(m, +pf, pierceXYZ);

    var wall = wallThickness(m, minWall, probe, EPS, weldTol);
    var thinSet = Object.create(null);
    for (i = 0; i < wall.faces.length; i++) {
      thinSet[wall.faces[i].face] = 1;
      if (wall.faces[i].hit >= 0) thinSet[wall.faces[i].hit] = 1;
    }
    var thinXYZ = [];
    for (var tf in thinSet) triVerts(m, +tf, thinXYZ);

    var report = {
      version: VERSION,
      soupTris: rawTris.length / 9,
      weldedVerts: w.collapsed,
      tris: base.tris,
      openEdges: base.openEdges,
      nonManifoldEdges: base.nonManifoldEdges,
      oddEdges: base.oddEdges,
      // the validator's two, not analyze()'s - see the note above
      flippedEdges: windingEdges(m),
      degenerateTris: degenerateRaw(rawTris),
      boundaryLoops: base.boundaryLoops,
      components: base.components,
      pierce: si.pierce,
      coplanar: si.coplanar,
      piercePairs: si.pairs.filter(function (p) { return p.kind === 'pierce'; }),
      wall: wall,
      nonSolid: nonSolid,
      marks: {
        openEdges: new Float32Array(openXYZ),
        nonManifoldEdges: new Float32Array(nmXYZ),
        pierceTris: new Float32Array(pierceXYZ),
        thinTris: new Float32Array(thinXYZ)
      }
    };
    report.fails = verdictFails(report, nonSolid);
    report.verdict = report.fails.length ? 'FAIL' : 'PASS';
    return report;
  }

  var api = {
    VERSION: VERSION,
    NOZZLE_MIN_WALL: NOZZLE_MIN_WALL,
    WALL_PROBE: WALL_PROBE,
    locate: locate,
    /* Exposed for tools/nso_defect_overlay_test.js, which holds the wall pass
       to tools/mesh_validate.py face-for-face. */
    _wallThickness: wallThickness,
    _verdictFails: verdictFails,
    _degenerateRaw: degenerateRaw,
    _windingEdges: windingEdges
  };

  global.NSO_Defects = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof window !== 'undefined' ? window : this);
