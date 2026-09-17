/* nso_thickness.js - the canonical wall-thickness / nozzle-safety check.

   Loads as a classic script (window.NSO_Thickness) and as a Node module
   (require('../nso_thickness.js')). No DOM, no Three.js, no wasm: a mesh is
   the app's raw soup (a Float32Array/Array of 9 numbers per triangle, Z up,
   millimetres), a section is a closed 2D loop of [u,v] points.

   ---------------------------------------------------------------------------
   WHY THIS EXISTS
   ---------------------------------------------------------------------------
   "Is this feature thick enough to print?" was being answered separately, and
   differently, everywhere it was asked - and in two of the three places it was
   not really being answered at all:

     tools/mesh_validate.py  wall_thickness(): a real 3D raycast against the
       whole mesh, with a stated floor (0.42 mm at a 0.4 nozzle) and a genuine
       pass/fail. Sound, but Python-only and reachable solely through the
       validator CLI, so nothing in the app could call it.

     app-cut.js  rawLocalThickness2() / rawCornerWallLimit2(): a 2D measurement
       on the cut cross-section, used to clamp a fillet radius to 0.45x the
       wall available at that corner. It measures a real distance, but it never
       compared the result against any printability floor, and when it found no
       opposing wall at all it returned a bare `4` - a magic number that reads
       as "4 mm of wall is available" to every caller, on geometry where the
       true answer is "not measured".

     nso_skin.js  the 0.42 mm rib: a stated DEFAULT in the pattern table, not a
       guard. withDefaults() takes whatever the caller passes, so a rib of 0.1
       goes through silently. There is no auto-bump anywhere in this repo.

     app-join.js / app.js  buildCutVolume(): rays along the punch axis only,
       reserves minWall along THAT axis, then inflates the cut box laterally
       with no wall test at all. One axis checked, two assumed - and at a
       corner both faces are load-bearing. See cutClearance() below.

   So: one module, one floor, no silent fallbacks, and three probes - a 3D
   probe for a mesh, a 2D probe for a section, and a clearance probe for a
   proposed cut. Anything that needs to know whether a feature is printable
   calls this and gets a number it can trust plus a verdict it can show.

   The three answer genuinely different questions, and the third exists because
   the first two cannot answer it: measureMesh() asks "is the wall that is
   there thick enough?", and a cut that SEVERS a wall removes material rather
   than thinning it, so the finished mesh has nothing thin in it to find.

   ---------------------------------------------------------------------------
   THE FLOOR
   ---------------------------------------------------------------------------
   A wall thinner than one extrusion line cannot be printed: the slicer either
   drops the feature or fuses it into its neighbour. One line at a 0.4 mm
   nozzle is 0.42 mm - the figure already stated in nso_skin.js ("thinner and
   the slicer drops the rib") and already used as the default threshold by
   mesh_validate.py. floorFor(nozzle) generalises exactly that: nozzle x 1.05,
   which reproduces 0.42 at 0.4 and scales to any other nozzle. It is a stated
   default, not a measured one; a caller who knows their slicer's real line
   width passes `minWall` directly and the floor steps aside.

   ---------------------------------------------------------------------------
   WHAT "THICKNESS" MEANS HERE
   ---------------------------------------------------------------------------
   Distance from a surface to the nearest surface BEHIND it, measured along the
   inward normal. On a shell with two coherent sides that is the wall
   thickness. On two sheets facing each other it is the gap - which matters for
   the same reason, because an FDM printer fuses a sub-line-width gap into one
   solid. On a woven sheet it is the crossing clearance. The name is `wall`
   because that is what it is on a shell; read it as "nearest surface behind"
   on anything else, exactly as mesh_validate.py documents it.

   A face that meets nothing within the probe distance is a SHEET: a single
   vase-mode wall whose width the slicer decides, or a wall simply thicker than
   the probe. Sheets are counted, never failed - we do not know their
   thickness, and inventing one is what the `4` above was doing.

   ---------------------------------------------------------------------------
   API
   ---------------------------------------------------------------------------
   floorFor(nozzle)                     -> mm, the safe floor for that nozzle
   measureMesh(rawTris, opts)           -> report (3D probe, whole mesh)
   measureRegion(rawTris, faces, opts)  -> report (3D probe, a face subset)
   cutClearance(rawTris, cutLo, cutHi, opts) -> what a PROPOSED cut leaves standing
   loopWallAt(loop2, i, opts)           -> { mm, measured, ... } (2D probe)
   cornerWall(loop2, i) / bandWall(loop2, i) -> the fillet clamp's two shapes
   measureLoop(loop2, opts)             -> report (2D probe, whole section)
   safeRadius(requestedR, availableMM, opts) -> { r, floored, ... }
   describe(report)                     -> one status line

   The measuring calls all return the same shape (cutClearance is the odd one
   out - a cut is a question about several axes at once, so its report is a
   list of sides plus `severed` / `breached` / `thin`; see its own comment):
     {
       kind, nozzle_mm, threshold_mm, probe_mm,
       measured, thin, sheets,          // counts
       min_mm,                          // thinnest measured, null if nothing measured
       pass,                            // false only when something measured came in thin
       examples: [{ at, hit, mm }],
       reason                           // human-readable, always set
     }
   `pass` is true when nothing measured came in under the floor. Unmeasured is
   never a pass disguised as one: `measured` and `sheets` say how much of the
   piece the verdict actually covers.
*/
(function (root) {
  'use strict';

  /* One extrusion line is a nozzle width plus the squish the slicer applies.
     1.05 is what turns the 0.4 nozzle this repo already quotes into the
     0.42 mm rib it already builds. */
  var LINE_RATIO = 1.05;
  var NOZZLE_DEFAULT = 0.4;
  var PROBE_DEFAULT = 5.0;    // mm behind a face to look; same as mesh_validate.py
  var WELD_TOL = 1e-4;        // mm; "the same point" everywhere in this repo
  var MAX_EXAMPLES = 8;

  function floorFor(nozzle) {
    var d = (typeof nozzle === 'number' && nozzle > 0) ? nozzle : NOZZLE_DEFAULT;
    /* Rounded to the nanometre so the default reads as exactly 0.42, the
       figure nso_skin.js and mesh_validate.py both quote, instead of
       0.42000000000000004 leaking into every status line and comparison. */
    return Math.round(d * LINE_RATIO * 1e6) / 1e6;
  }

  /* Resolve the threshold once, the same way for both probes: an explicit
     minWall wins, otherwise the floor for the nozzle. */
  function resolveOpts(opts) {
    opts = opts || {};
    var nozzle = (typeof opts.nozzle === 'number' && opts.nozzle > 0) ? opts.nozzle : NOZZLE_DEFAULT;
    var minWall = (typeof opts.minWall === 'number' && opts.minWall >= 0) ? opts.minWall : floorFor(nozzle);
    var probe = (typeof opts.probe === 'number' && opts.probe > 0) ? opts.probe : PROBE_DEFAULT;
    return {
      nozzle: nozzle,
      minWall: minWall,
      probe: probe,
      weldTol: (typeof opts.weldTol === 'number') ? opts.weldTol : WELD_TOL,
      eps: (typeof opts.eps === 'number') ? opts.eps : 1e-9,
      maxExamples: (typeof opts.maxExamples === 'number') ? opts.maxExamples : MAX_EXAMPLES
    };
  }

  /* ---------------------------------------------------------------- vectors */
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function norm(a) { return Math.sqrt(dot(a, a)); }

  /* Moller-Trumbore. Distance along unit `d` from `orig` to triangle T, or
     null. Port of mesh_validate.py's _ray_tri, same epsilon handling. */
  function rayTri(orig, d, T, eps) {
    var a = T[0], b = T[1], c = T[2];
    var e1 = sub(b, a), e2 = sub(c, a);
    var p = cross(d, e2);
    var det = dot(e1, p);
    if (det > -1e-14 && det < 1e-14) return null;
    var inv = 1.0 / det;
    var s = sub(orig, a);
    var u = dot(s, p) * inv;
    if (u < -eps || u > 1.0 + eps) return null;
    var q = cross(s, e1);
    var v = dot(d, q) * inv;
    if (v < -eps || u + v > 1.0 + eps) return null;
    var t = dot(e2, q) * inv;
    return t > eps ? t : null;
  }

  /* Raw soup -> welded triangles plus per-corner vertex ids.

     This is a RADIUS weld, not a grid snap, because mesh_validate.py's weld()
     is one and this module has to agree with it: hash into tol-sized cells,
     then search the 27-cell neighbourhood and take the first vertex within a
     true radius `tol`. A bare snap puts two vertices straddling a cell
     boundary into different cells however close they are, so it under-welds
     by an amount that depends on where the geometry happens to sit relative
     to the origin - on the tape fixture that is hundreds of vertex pairs
     inside tolerance left unmerged.

     Both outputs matter to the probe, and for different reasons:
       - the welded POSITIONS are what gets measured, so a pair of corners a
         hair apart does not read as a real surface a hair away;
       - the welded IDS are how a face is told from its own neighbours.
     Measuring raw positions while welding only for adjacency is exactly the
     bug that made this module disagree with the Python on real, messy meshes
     while agreeing on clean synthetic ones. */
  function indexSoup(rawTris, weldTol) {
    var tol = weldTol > 0 ? weldTol : WELD_TOL;
    var inv = 1 / tol, tol2 = tol * tol;
    var cells = new Map();
    var verts = [];
    var tris = [], vids = [];
    var n = (rawTris.length / 9) | 0;
    for (var f = 0; f < n; f++) {
      var o = f * 9, T = [], ids = [];
      for (var k = 0; k < 3; k++) {
        var x = rawTris[o + k * 3], y = rawTris[o + k * 3 + 1], z = rawTris[o + k * 3 + 2];
        var cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
        var vid = -1;
        for (var di = -1; di <= 1 && vid < 0; di++) {
          for (var dj = -1; dj <= 1 && vid < 0; dj++) {
            for (var dk = -1; dk <= 1 && vid < 0; dk++) {
              var bucket = cells.get((cx + di) + ',' + (cy + dj) + ',' + (cz + dk));
              if (!bucket) continue;
              for (var bi = 0; bi < bucket.length; bi++) {
                var q = verts[bucket[bi]];
                var ddx = x - q[0], ddy = y - q[1], ddz = z - q[2];
                if (ddx * ddx + ddy * ddy + ddz * ddz <= tol2) { vid = bucket[bi]; break; }
              }
            }
          }
        }
        if (vid < 0) {
          vid = verts.length;
          verts.push([x, y, z]);
          var key = cx + ',' + cy + ',' + cz;
          var own = cells.get(key);
          if (!own) { own = []; cells.set(key, own); }
          own.push(vid);
        }
        T.push(verts[vid]);
        ids.push(vid);
      }
      tris.push(T);
      vids.push(ids);
    }
    return { tris: tris, vids: vids };
  }


  function emptyReport(kind, o, reason) {
    return {
      kind: kind, nozzle_mm: o.nozzle, threshold_mm: o.minWall, probe_mm: o.probe,
      measured: 0, thin: 0, sheets: 0, min_mm: null, pass: true,
      examples: [], reason: reason
    };
  }

  /* Uniform hash of triangle bounding boxes, cell = the mean triangle bbox
     diagonal. Shared by every 3D probe in this file so they all see the same
     broad phase; it is the structure mesh_validate.py uses. */
  function buildGrid(tris) {
    var n = tris.length;
    var boxes = [], diagSum = 0;
    for (var t = 0; t < n; t++) {
      var A = tris[t][0], B = tris[t][1], C = tris[t][2];
      var lo = [Math.min(A[0], B[0], C[0]), Math.min(A[1], B[1], C[1]), Math.min(A[2], B[2], C[2])];
      var hi = [Math.max(A[0], B[0], C[0]), Math.max(A[1], B[1], C[1]), Math.max(A[2], B[2], C[2])];
      boxes.push([lo, hi]);
      diagSum += norm(sub(hi, lo));
    }
    var cell = Math.max(diagSum / (n || 1), 1e-9);
    var invC = 1 / cell;
    var grid = new Map();
    for (var g = 0; g < n; g++) {
      var b = boxes[g];
      var x0 = Math.floor(b[0][0] * invC), x1 = Math.floor(b[1][0] * invC);
      var y0 = Math.floor(b[0][1] * invC), y1 = Math.floor(b[1][1] * invC);
      var z0 = Math.floor(b[0][2] * invC), z1 = Math.floor(b[1][2] * invC);
      for (var ix = x0; ix <= x1; ix++) {
        for (var iy = y0; iy <= y1; iy++) {
          for (var iz = z0; iz <= z1; iz++) {
            var k = ix + ',' + iy + ',' + iz;
            var bucket = grid.get(k);
            if (!bucket) { bucket = []; grid.set(k, bucket); }
            bucket.push(g);
          }
        }
      }
    }
    return { grid: grid, cell: cell, invC: invC, boxes: boxes };
  }

  /* ------------------------------------------------------- 3D probe: a mesh */

  /* Cast from every selected face's centroid along its inward normal and stop
     at the first triangle met within `probe`, ignoring the source face and
     anything sharing a welded vertex with it.

     Broad phase is a uniform hash on triangle bounding boxes, walked cell by
     cell along the ray (3D DDA) and abandoned as soon as the next cell starts
     beyond the closest hit so far - the same structure mesh_validate.py uses,
     ported rather than reinvented so the two agree number for number.

     `faces` (optional) restricts which faces are MEASURED; the whole mesh is
     always available as a target, because the wall behind a selected face is
     usually made of faces outside the selection. */
  function measureMesh(rawTris, opts) {
    var o = resolveOpts(opts);
    var faces = (opts && opts.faces) || null;
    if (!rawTris || !rawTris.length) return emptyReport('mesh', o, 'empty mesh - nothing measured');

    var idx = indexSoup(rawTris, o.weldTol);
    var tris = idx.tris, vids = idx.vids;
    var n = tris.length;
    if (!n) return emptyReport('mesh', o, 'empty mesh - nothing measured');

    /* which faces to measure */
    var want;
    if (faces && faces.length) {
      want = [];
      for (var q = 0; q < faces.length; q++) {
        var fi = faces[q] | 0;
        if (fi >= 0 && fi < n) want.push(fi);
      }
    } else {
      want = null;   // all of them
    }

    var G = buildGrid(tris);
    var cell = G.cell, invC = G.invC, grid = G.grid;

    var rep = emptyReport('mesh', o, '');
    var bestAll = null;
    var count = want ? want.length : n;

    for (var w = 0; w < count; w++) {
      var f = want ? want[w] : w;
      var P = tris[f];
      var N = cross(sub(P[1], P[0]), sub(P[2], P[0]));
      var L = norm(N);
      if (!(L > 0)) continue;                        // degenerate: counted elsewhere
      var d = [-N[0] / L, -N[1] / L, -N[2] / L];     // inward
      var orig = [(P[0][0] + P[1][0] + P[2][0]) / 3,
                  (P[0][1] + P[1][1] + P[2][1]) / 3,
                  (P[0][2] + P[1][2] + P[2][2]) / 3];

      /* 3D DDA along orig + d*s, s in [0, probe] */
      var ci = [Math.floor(orig[0] * invC), Math.floor(orig[1] * invC), Math.floor(orig[2] * invC)];
      var step = [0, 0, 0], tMax = [Infinity, Infinity, Infinity], tDelta = [Infinity, Infinity, Infinity];
      for (var a2 = 0; a2 < 3; a2++) {
        if (d[a2] > 1e-15) {
          step[a2] = 1;
          tMax[a2] = ((ci[a2] + 1) * cell - orig[a2]) / d[a2];
          tDelta[a2] = cell / d[a2];
        } else if (d[a2] < -1e-15) {
          step[a2] = -1;
          tMax[a2] = (ci[a2] * cell - orig[a2]) / d[a2];
          tDelta[a2] = -cell / d[a2];
        }
      }

      var best = null, bestU = null;
      var seen = new Set();
      var entry = 0;
      var mine = vids[f];
      while (entry <= o.probe) {
        if (best !== null && entry > best) break;
        var cellList = grid.get(ci[0] + ',' + ci[1] + ',' + ci[2]);
        if (cellList) {
          for (var ii = 0; ii < cellList.length; ii++) {
            var u = cellList[ii];
            if (u === f || seen.has(u)) continue;
            seen.add(u);
            var other = vids[u];
            if (other[0] === mine[0] || other[0] === mine[1] || other[0] === mine[2] ||
                other[1] === mine[0] || other[1] === mine[1] || other[1] === mine[2] ||
                other[2] === mine[0] || other[2] === mine[1] || other[2] === mine[2]) continue;
            var s = rayTri(orig, d, tris[u], o.eps);
            if (s !== null && s <= o.probe && (best === null || s < best)) { best = s; bestU = u; }
          }
        }
        var kMin = (tMax[0] < tMax[1]) ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
        entry = tMax[kMin];
        ci[kMin] += step[kMin];
        tMax[kMin] += tDelta[kMin];
      }

      rep.measured++;
      if (best === null) { rep.sheets++; continue; }
      if (bestAll === null || best < bestAll) bestAll = best;
      /* A wall built AT the threshold passes: float32 coordinates put a
         0.42 mm rib at 0.419998, which is the file's rounding and not a thin
         wall. One weld radius of slack, the same figure used everywhere. */
      if (best < o.minWall - WELD_TOL) {
        rep.thin++;
        if (rep.examples.length < o.maxExamples) {
          rep.examples.push({ at: f, hit: bestU, mm: Math.round(best * 1e5) / 1e5 });
        }
      }
    }

    rep.min_mm = bestAll;
    rep.pass = rep.thin === 0;
    rep.reason = reasonFor(rep, 'face');
    return rep;
  }

  /* A named convenience for the region case, so a caller selecting a face does
     not have to know that `faces` is an option key. */
  function measureRegion(rawTris, faces, opts) {
    var o = opts ? Object.assign({}, opts) : {};
    o.faces = faces;
    return measureMesh(rawTris, o);
  }

  /* --------------------------------------------- 3D probe: a proposed cut */

  /* Every hit along a ray, sorted, using the same uniform hash as the wall
     probe. Unlike the wall probe this does not stop at the nearest hit: the
     clearance check needs to know where the material ENDS, not just where the
     next surface is. */
  function allHits(G, tris, orig, d, maxT, eps) {
    var cell = G.cell, invC = G.invC, grid = G.grid;
    var ci = [Math.floor(orig[0] * invC), Math.floor(orig[1] * invC), Math.floor(orig[2] * invC)];
    var step = [0, 0, 0], tMax = [Infinity, Infinity, Infinity], tDelta = [Infinity, Infinity, Infinity];
    for (var a = 0; a < 3; a++) {
      if (d[a] > 1e-15) {
        step[a] = 1; tMax[a] = ((ci[a] + 1) * cell - orig[a]) / d[a]; tDelta[a] = cell / d[a];
      } else if (d[a] < -1e-15) {
        step[a] = -1; tMax[a] = (ci[a] * cell - orig[a]) / d[a]; tDelta[a] = -cell / d[a];
      }
    }
    var hits = [], seen = new Set(), entry = 0;
    while (entry <= maxT) {
      var bucket = grid.get(ci[0] + ',' + ci[1] + ',' + ci[2]);
      if (bucket) {
        for (var i = 0; i < bucket.length; i++) {
          var u = bucket[i];
          if (seen.has(u)) continue;
          seen.add(u);
          var t = rayTri(orig, d, tris[u], eps);
          if (t !== null && t <= maxT) hits.push(t);
        }
      }
      var k = (tMax[0] < tMax[1]) ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
      if (!isFinite(tMax[k])) break;
      entry = tMax[k];
      ci[k] += step[k];
      tMax[k] += tDelta[k];
    }
    hits.sort(function (x, y) { return x - y; });
    /* Collapse coincident hits. A ray that passes exactly through the diagonal
       two triangles of a quad share crosses the surface ONCE but records two
       hits at the same distance, which breaks parity and - worse - produces a
       zero-thickness "solid span" that reads as a member the cut severed. Seen
       for real on box_open.stl: the corner samples hit z = 25 twice and a
       legitimate corner notch was reported as severing the piece.

       The merge radius is the weld tolerance this module uses everywhere else
       for "the same point". Anything thinner than that is not a feature; it is
       two records of one surface. */
    var merged = [];
    for (var m = 0; m < hits.length; m++) {
      if (!merged.length || hits[m] - merged[merged.length - 1] > WELD_TOL) merged.push(hits[m]);
    }
    return merged;
  }

  /* How much wall a PROPOSED CUT leaves standing, on every axis.

     This is the check the app-join.js / app.js cut path does not have. That one
     rays along frame.punch only, finds the far wall, and reserves `minWall`
     along THAT axis - then inflates the cut box laterally by `lateralPad` with
     no wall test of any kind. One axis is checked; the other two are assumed.

     At a corner, or anywhere a bit travels ALONG a wall rather than across it,
     that assumption is wrong and the failure is invisible afterwards. On
     fixtures/box_open.stl (60x40x25, 2 mm walls) a 4x2x6 bit in the corner of
     the y=0 wall, punching +X, removes 48 of 48 mm3. The punch-axis ray
     measures 60 mm of material - because it is tunnelling along the wall, not
     through it - so the check approves a 59 mm cut that takes the whole 2 mm
     wall out over that window, opening the outside into the cavity. The result
     is a closed, sound, single-component mesh whose thinnest wall is still
     1 mm. measureMesh() passes it, and correctly so: severing REMOVES material
     rather than thinning it, so no thickness check on the finished mesh can
     see it. It has to be caught before the cut, against both load-bearing
     faces, which is what this does.

     For each of the six faces of the cut box, sample across the face, and at
     each sample ask two questions of the ORIGINAL mesh:
       - just inside the cut boundary, was there material here at all? If not,
         this sample has nothing to say and is skipped (a cut reaching through
         open cavity is not eating a wall).
       - just outside it, is there material, and how far does it run before the
         solid ends? That length is the wall this cut leaves standing on that
         side.
     The worst sample wins, the same way buildCutVolume takes the worst of its
     five, and every side is reported.

     A side with material but under the floor is `thin`. A side with none at
     all is `breached`. An axis breached on BOTH sides is `severed`: the cut
     spans the full thickness of the member there and nothing is left holding
     it. That is the corner case, and it is exactly what one-axis checking
     cannot express.

     `opts.through` names the axis the bit is meant to punch along (0/1/2 or
     'x'/'y'/'z'). Severing THAT axis is the whole point of a through cut, so
     it is reported and not failed; severing any other is a cut wall. Omit it
     and every axis is held to the floor.

     cutLo/cutHi are the cut volume's world-axis-aligned bounds - for the app
     path, the box buildCutVolume actually hands to the kernel, lateral pad
     included, not the bit's own footprint.

     LIMITS, stated rather than implied. This samples `opts.samples` squared
     lines per axis (5x5 by default, inset from the cut's rim), so a wall
     threatened only in a gap between sample lines can still be missed; raise
     `samples` for a finer sweep. It is a strictly denser probe than the five
     points buildCutVolume takes, not a proof. It also reads the mesh as it is
     BEFORE the cut and assumes the cut volume is the axis-aligned box given;
     a rotated bit should be passed the world AABB of its cut volume, which is
     conservative (it can over-report, never under-report). Sample lines whose
     hit list comes back odd are counted in `grazed` and contribute nothing. */
  function cutClearance(rawTris, cutLo, cutHi, opts) {
    var o = resolveOpts(opts);
    opts = opts || {};
    var AX = ['x', 'y', 'z'];
    var through = opts.through;
    if (typeof through === 'string') through = AX.indexOf(through);
    if (typeof through !== 'number' || through < 0 || through > 2) through = -1;
    var nSamp = (typeof opts.samples === 'number' && opts.samples >= 1) ? (opts.samples | 0) : 5;

    var rep = {
      kind: 'cut', nozzle_mm: o.nozzle, threshold_mm: o.minWall,
      through: through >= 0 ? AX[through] : null,
      sides: [], severed: [], severed_fatal: [], breached: [], thin: [],
      samples: nSamp * nSamp, grazed: 0,
      min_mm: null, pass: true, reason: ''
    };
    if (!rawTris || !rawTris.length) { rep.reason = 'empty mesh - nothing measured'; return rep; }

    var idx = indexSoup(rawTris, o.weldTol);
    var tris = idx.tris;
    var G = buildGrid(tris);

    var mlo = [Infinity, Infinity, Infinity], mhi = [-Infinity, -Infinity, -Infinity];
    for (var t = 0; t < tris.length; t++) {
      for (var c = 0; c < 3; c++) {
        for (var a0 = 0; a0 < 3; a0++) {
          if (tris[t][c][a0] < mlo[a0]) mlo[a0] = tris[t][c][a0];
          if (tris[t][c][a0] > mhi[a0]) mhi[a0] = tris[t][c][a0];
        }
      }
    }
    var span = norm(sub(mhi, mlo)) * 2 + 1;
    var eps = o.eps;
    var tol = WELD_TOL;

    for (var ax = 0; ax < 3; ax++) {
      var b1 = (ax + 1) % 3, b2 = (ax + 2) % 3;
      var dir = [0, 0, 0]; dir[ax] = 1;
      var c0 = Math.min(cutLo[ax], cutHi[ax]), c1 = Math.max(cutLo[ax], cutHi[ax]);

      var minus = { axis: AX[ax], sign: -1, label: AX[ax] + '-', measured: 0,
                    remaining_mm: null, breached: false, thin: false, is_through: ax === through };
      var plus = { axis: AX[ax], sign: 1, label: AX[ax] + '+', measured: 0,
                   remaining_mm: null, breached: false, thin: false, is_through: ax === through };
      var severedHere = 0, grazedHere = 0;

      for (var i = 0; i < nSamp; i++) {
        for (var j = 0; j < nSamp; j++) {
          var f1 = nSamp === 1 ? 0.5 : (0.1 + 0.8 * i / (nSamp - 1));
          var f2 = nSamp === 1 ? 0.5 : (0.1 + 0.8 * j / (nSamp - 1));
          var org = [0, 0, 0];
          org[ax] = mlo[ax] - 1;
          org[b1] = cutLo[b1] + (cutHi[b1] - cutLo[b1]) * f1;
          org[b2] = cutLo[b2] + (cutHi[b2] - cutLo[b2]) * f2;

          var hits = allHits(G, tris, org, dir, span, eps);
          if (hits.length < 2 || hits.length % 2 !== 0) { grazedHere++; continue; }   // this line says nothing

          /* Solid spans along this line, in world coordinates on `ax`. */
          for (var h = 0; h + 1 < hits.length; h += 2) {
            var s0 = org[ax] + hits[h], s1 = org[ax] + hits[h + 1];
            if (s1 - s0 <= tol) continue;                            // zero-thickness: a grazed surface, not a member
            if (c1 <= s0 + tol || c0 >= s1 - tol) continue;          // cut misses this span

            /* Does the cut swallow this span whole? Then nothing on this line
               holds the member together any more - that is severance, and it
               is the thing a one-axis check cannot express. */
            if (c0 <= s0 + tol && c1 >= s1 - tol) { severedHere++; continue; }

            /* Otherwise, what is left on each side of the cut WITHIN this span.
               A side whose material the cut starts at or before simply has
               none - that is the face the bit entered through, normal for any
               cut - and is recorded as breached, not as a thin wall. */
            if (c0 > s0 + tol) {
              minus.measured++;
              var below = c0 - s0;
              if (minus.remaining_mm === null || below < minus.remaining_mm) minus.remaining_mm = below;
            } else {
              minus.measured++;
              minus.remaining_mm = 0;
            }
            if (c1 < s1 - tol) {
              plus.measured++;
              var above = s1 - c1;
              if (plus.remaining_mm === null || above < plus.remaining_mm) plus.remaining_mm = above;
            } else {
              plus.measured++;
              plus.remaining_mm = 0;
            }
          }
        }
      }

      [minus, plus].forEach(function (side) {
        if (!side.measured) return;
        if (side.remaining_mm === 0) { side.breached = true; rep.breached.push(side.label); }
        else if (side.remaining_mm < o.minWall - WELD_TOL) { side.thin = true; rep.thin.push(side.label); }
        /* min_mm is the thinnest wall LEFT STANDING, so a breached side does
           not contribute a 0 to it. A breach is not a thin wall, it is the
           absence of one, and the entry face of any cut breaches by design. */
        if (!side.breached && (rep.min_mm === null || side.remaining_mm < rep.min_mm)) {
          rep.min_mm = side.remaining_mm;
        }
      });
      minus.severed_samples = plus.severed_samples = severedHere;
      /* Lines whose hit list came back odd after the coincident-hit merge: the
         ray still grazed something and that line is not evidence either way.
         Counted rather than swallowed, so "nothing severed" can be told apart
         from "nothing could be measured". */
      minus.grazed_samples = plus.grazed_samples = grazedHere;
      rep.grazed += grazedHere;
      rep.sides.push(minus, plus);
      if (severedHere) rep.severed.push(AX[ax]);
    }

    /* Severing the declared punch axis is what a through cut IS; severing any
       other axis is a wall cut in half. */
    rep.severed_fatal = rep.severed.filter(function (a) { return a !== rep.through; });
    rep.pass = rep.severed_fatal.length === 0 && rep.thin.length === 0;
    var anyMeasured = rep.sides.some(function (x) { return x.measured > 0; }) || rep.severed.length > 0;

    if (rep.severed_fatal.length) {
      rep.reason = 'cut severs the piece across ' + rep.severed_fatal.join(' and ') +
                   ' - it removes the full thickness there' +
                   (rep.through ? ' (punch axis is ' + rep.through + ')' : '');
    } else if (rep.thin.length) {
      rep.reason = 'cut leaves under ' + round3(o.minWall) + ' mm on ' + rep.thin.join(', ') +
                   ' (thinnest ' + round3(rep.min_mm) + ' mm)';
    } else if (!anyMeasured) {
      rep.reason = 'cut removes no material - nothing measured';
    } else {
      rep.reason = (rep.min_mm === null
                      ? 'no wall left standing anywhere the cut removed material'
                      : 'thinnest wall left standing ' + round3(rep.min_mm) + ' mm, floor ' +
                        round3(o.minWall) + ' mm') +
                   (rep.severed.length ? ' (through cut on ' + rep.severed.join(', ') + ', as intended)' : '') +
                   (rep.breached.length ? ' (open to air on ' + rep.breached.join(', ') + ')' : '');
    }
    return rep;
  }


  /* ---------------------------------------------- 2D probe: a section loop */

  /* The measurement app-cut.js's fillet clamp has always made, kept
     bit-for-bit: an inward ray along the corner bisector at loop point `i`,
     plus a direction-independent nearest-vertex distance, whichever is
     tighter. Both signals are here for the reason app-cut.js records: the
     bisector ray looks along ONE direction and can miss a genuinely close
     point that is not roughly in that direction.

     What is NEW is the honesty about not finding anything. The old code
     returned a bare `4` in that case, which every caller then multiplied as
     though 4 mm of wall had been measured. Here `measured` is false and `mm`
     carries whatever fallback the caller asked for, so a caller that cares can
     tell "4 mm of wall" from "no idea".

     The two passes need SEPARATE skip rules, because app-cut.js's two live
     variants disagree about them and both are load-bearing:

       BAND   (rawLocalThickness2)   both passes ignore |j - i| < 2
       CORNER (rawCornerWallLimit2,  segments ignore j = i and j = i-1;
               and the inline        points also ignore j = i+1
               wallLimitAt)

     Rather than average the two into something neither caller asked for, both
     are named presets below and each call site says which rule it is on.

     They also disagree about what the fallback MEANS, which is the sharper
     half of the bug. BAND computes
         min(ray ?? 4, nearest ?? 4)
     so whenever the bisector ray misses, the 4 enters the min as a CAP and
     BAND can never report more than 4 mm of wall however much is really
     there. CORNER accumulates both passes into one running minimum and only
     falls back to 4 when neither found anything at all. Two functions eleven
     hundred lines apart, the same magic number, two different meanings.
     `fallbackMode` keeps each one's meaning exactly:
       'perSignal' - BAND: the fallback substitutes for each missing signal
       'whenNone'  - CORNER: the fallback applies only if nothing was found
     In both cases `measured` reports whether a REAL signal was found, so a
     caller can finally tell a measured 4 mm from a guessed one.


     opts.skipSeg(j,i,n)  true to exclude segment j from the bisector pass
     opts.skipPt(j,i,n)   true to exclude point j from the nearest pass
     opts.skipNear   shorthand: both passes ignore |j - i| < skipNear. Default 2.
     opts.minT       smallest ray distance that counts as a real far wall.
     opts.fallback   what `mm` reads when a signal is missing. Default null.
     opts.fallbackMode 'perSignal' or 'whenNone' (default).
     opts.nearest    false to use the bisector ray alone. */
  function loopWallAt(loop2, i, opts) {
    opts = opts || {};
    var n = loop2.length;
    var skipNear = (typeof opts.skipNear === 'number') ? opts.skipNear : 2;
    var minT = (typeof opts.minT === 'number') ? opts.minT : 0.1;
    var fallback = (opts.fallback === undefined) ? null : opts.fallback;
    var useNearest = opts.nearest !== false;

    var out = { mm: fallback, measured: false, byRay: null, byNearest: null };
    if (n < 3) return out;

    var curr = loop2[i];
    var prev = loop2[(i - 1 + n) % n], next = loop2[(i + 1) % n];
    /* inward normal of the chord prev->next: app-cut.js's rawEdgeInwardNormal2 */
    var dx0 = next[0] - prev[0], dy0 = next[1] - prev[1];
    var len0 = Math.hypot(dx0, dy0) || 1e-12;
    var nn = [-dy0 / len0, dx0 / len0];

    /* which loop points/segments are "the corner itself" and must not answer */
    function nearWindow(j) {
      var dj = Math.abs(j - i);
      return dj < skipNear || dj > n - skipNear;
    }
    var skipSeg = opts.skipSeg ? function (j) { return opts.skipSeg(j, i, n); } : nearWindow;
    var skipPt = opts.skipPt ? function (j) { return opts.skipPt(j, i, n); } : nearWindow;

    var minD = Infinity;
    for (var j = 0; j < n; j++) {
      if (skipSeg(j)) continue;
      var a = loop2[j], b = loop2[(j + 1) % n];
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var den = nn[0] * dy - nn[1] * dx;
      if (Math.abs(den) < 1e-10) continue;
      var t = ((a[0] - curr[0]) * dy - (a[1] - curr[1]) * dx) / den;
      var u = ((a[0] - curr[0]) * nn[1] - (a[1] - curr[1]) * nn[0]) / -den;
      if (t > minT && t < minD && u >= -0.05 && u <= 1.05) minD = t;
    }
    if (minD !== Infinity) out.byRay = minD;

    if (useNearest) {
      var nearest = Infinity;
      for (var j2 = 0; j2 < n; j2++) {
        if (skipPt(j2)) continue;
        var dd = Math.hypot(loop2[j2][0] - curr[0], loop2[j2][1] - curr[1]);
        if (dd < nearest) nearest = dd;
      }
      if (nearest !== Infinity) out.byNearest = nearest;
    }

    out.measured = (out.byRay !== null) || (out.byNearest !== null);

    if (opts.fallbackMode === 'perSignal') {
      /* BAND: each missing signal contributes the fallback to the min. */
      var r = (out.byRay === null) ? fallback : out.byRay;
      var p = useNearest ? ((out.byNearest === null) ? fallback : out.byNearest) : null;
      var cand = [];
      if (r !== null && r !== undefined) cand.push(r);
      if (p !== null && p !== undefined) cand.push(p);
      out.mm = cand.length ? Math.min.apply(null, cand) : fallback;
      return out;
    }

    /* whenNone (CORNER, and the default): one running minimum over whatever
       was actually found; the fallback only speaks if nothing was. */
    var best = Infinity;
    if (out.byRay !== null) best = Math.min(best, out.byRay);
    if (out.byNearest !== null) best = Math.min(best, out.byNearest);
    out.mm = (best === Infinity) ? fallback : best;
    return out;
  }

  /* Every point of a section, against the floor. */
  function measureLoop(loop2, opts) {
    var o = resolveOpts(opts);
    var rep = emptyReport('section', o, '');
    if (!loop2 || loop2.length < 3) { rep.reason = 'section has fewer than 3 points - nothing measured'; return rep; }
    var bestAll = null;
    for (var i = 0; i < loop2.length; i++) {
      var w = loopWallAt(loop2, i, opts);
      if (!w.measured) { rep.sheets++; rep.measured++; continue; }
      rep.measured++;
      if (bestAll === null || w.mm < bestAll) bestAll = w.mm;
      if (w.mm < o.minWall - WELD_TOL) {
        rep.thin++;
        if (rep.examples.length < o.maxExamples) {
          rep.examples.push({ at: i, hit: null, mm: Math.round(w.mm * 1e5) / 1e5 });
        }
      }
    }
    rep.min_mm = bestAll;
    rep.pass = rep.thin === 0;
    rep.reason = reasonFor(rep, 'point');
    return rep;
  }

  /* ------------------------------------------------------------- verdicts */

  function reasonFor(rep, unit) {
    if (!rep.measured) return 'nothing measured';
    var head;
    if (rep.thin) {
      head = rep.thin + ' ' + unit + (rep.thin === 1 ? '' : 's') + ' under ' +
             round3(rep.threshold_mm) + ' mm, thinnest ' + round3(rep.min_mm) + ' mm';
    } else if (rep.min_mm === null) {
      head = 'no wall found within ' + round3(rep.probe_mm) + ' mm of any ' + unit;
    } else {
      head = 'thinnest ' + round3(rep.min_mm) + ' mm, floor ' + round3(rep.threshold_mm) + ' mm';
    }
    if (rep.sheets) {
      head += ' (' + rep.sheets + ' unmeasured - nothing behind them within ' +
              round3(rep.probe_mm) + ' mm)';
    }
    return head;
  }

  function round3(x) { return (x === null || x === undefined) ? '?' : Math.round(x * 1000) / 1000; }

  function describe(rep) {
    if (!rep) return '';
    return (rep.pass ? 'Wall OK' : 'Wall TOO THIN') + ' - ' + rep.reason +
           ' (' + rep.measured + ' measured at a ' + round3(rep.nozzle_mm) + ' mm nozzle)';
  }

  /* --------------------------------------------------- the clamp consumers */

  /* Clamp a requested radius to what the wall at that spot can give, and say
     whether the result still leaves a printable wall behind it.

     `ratio` is the caller's own geometric rule (app-cut.js uses 0.45: a fillet
     may eat at most 45% of the wall available at that corner). That rule is
     unchanged. What is added is the floor: a corner whose wall is so thin that
     even the clamped fillet leaves under one extrusion line behind it is
     reported as `floored`, with `residualMM` saying what is actually left.

     Returns the clamped radius plus the full picture, so a caller can keep
     today's geometry and still surface the warning. */
  function safeRadius(requestedR, availableMM, opts) {
    opts = opts || {};
    var o = resolveOpts(opts);
    var ratio = (typeof opts.ratio === 'number') ? opts.ratio : 0.45;
    var out = {
      r: 0, requested: requestedR, available: availableMM, ratio: ratio,
      threshold_mm: o.minWall, nozzle_mm: o.nozzle,
      measured: (typeof availableMM === 'number' && isFinite(availableMM)),
      residualMM: null, floored: false, reason: ''
    };
    if (!out.measured) {
      out.r = 0;
      out.reason = 'no wall measured at this corner - radius not clamped from geometry';
      return out;
    }
    out.r = Math.min(requestedR, Math.max(0, availableMM * ratio));
    out.residualMM = availableMM - out.r;
    if (out.residualMM < o.minWall - WELD_TOL) {
      out.floored = true;
      out.reason = 'fillet leaves ' + round3(out.residualMM) + ' mm of wall, under the ' +
                   round3(o.minWall) + ' mm floor for a ' + round3(o.nozzle) + ' mm nozzle';
    } else {
      out.reason = 'leaves ' + round3(out.residualMM) + ' mm of wall, floor ' + round3(o.minWall) + ' mm';
    }
    return out;
  }

  /* The two live rules in app-cut.js's fillet clamp, named once here so the
     call sites read as "measure this the BAND way" instead of carrying four
     lines of index arithmetic each. Passing one of these reproduces that
     site's historical number exactly; `fallback: 4` is what the old code
     returned when it found nothing, kept so the retrofit changes no geometry
     while `measured` newly tells a real 4 mm from a guess. */
  var LOOP_BAND = {
    minT: 0.1, nearest: true, skipNear: 2, fallbackMode: 'perSignal',
    note: 'rawLocalThickness2: bisector ray + nearest point, both ignoring |j-i| < 2'
  };
  var LOOP_CORNER = {
    minT: 0.1, nearest: true, fallbackMode: 'whenNone',
    skipSeg: function (j, i, n) { return j === i || j === (i - 1 + n) % n; },
    skipPt: function (j, i, n) { return j === i || j === (i - 1 + n) % n || j === (i + 1) % n; },
    note: 'rawCornerWallLimit2 / wallLimitAt: segments ignore i and i-1, points also ignore i+1'
  };
  /* Merge a preset with a caller's overrides without mutating either. */
  function withPreset(preset, opts) {
    var out = {}, k;
    for (k in preset) if (Object.prototype.hasOwnProperty.call(preset, k)) out[k] = preset[k];
    if (opts) for (k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) out[k] = opts[k];
    return out;
  }

  /* What app-cut.js and app-finish.js returned when their loop probe found
     nothing. Kept so the retrofit changes no geometry; named so it is no
     longer a bare `4` that reads like a measurement. A caller that wants the
     truth instead of the historical number reads `.measured`. */
  var LEGACY_FALLBACK_MM = 4;

  /* The two call shapes the fillet clamp actually uses. One line at the call
     site, the preset and the legacy fallback applied for it. */
  function cornerWall(loop2, i, opts) {
    return loopWallAt(loop2, i, withPreset(LOOP_CORNER,
             withPreset({ fallback: LEGACY_FALLBACK_MM }, opts)));
  }
  function bandWall(loop2, i, opts) {
    return loopWallAt(loop2, i, withPreset(LOOP_BAND,
             withPreset({ fallback: LEGACY_FALLBACK_MM }, opts)));
  }

  /* ------------------------------------------------- the cut-path readout */

  /* The ONE wording for a cut's nozzle-safety finding, so every cut site says
     it the same way instead of each one re-deriving a sentence from the report.

     Returns '' when there is nothing to warn about, which is the common case.
     Two things are deliberately NOT findings:

       - a cut that leaves a printable wall everywhere (`pass`);
       - a breach on its own. The entry face of EVERY cut breaches, because the
         bit has to come from somewhere, so warning on that would fire on every
         cut and therefore mean nothing. Breached sides are named as context
         when something else is already wrong, never as the finding itself.

     A finding here is a WARNING and never a refusal. Severing a wall is
     precisely what Local-Carve's corner gouge does on purpose (docs/
     LOCAL-CARVE.md 3c), so a caller's job is to say so on its status line and
     commit the cut regardless. The verdict stays the caller's to print; this
     function only fixes the words. */
  function cutWarning(rep) {
    if (!rep || rep.pass) return '';
    var head = (rep.severed_fatal && rep.severed_fatal.length) ? 'WALL SEVERED' : 'WALL LEFT THIN';
    var s = head + ': ' + rep.reason +
            ' - floor ' + round3(rep.threshold_mm) +
            ' mm at a ' + round3(rep.nozzle_mm) + ' mm nozzle';
    if (rep.breached && rep.breached.length) s += ', open to air on ' + rep.breached.join(', ');
    return s + ' - reported, not blocked';
  }

  var api = {
    cutClearance: cutClearance,
    cutWarning: cutWarning,
    LEGACY_FALLBACK_MM: LEGACY_FALLBACK_MM,
    cornerWall: cornerWall,
    bandWall: bandWall,
    LOOP_BAND: LOOP_BAND,
    LOOP_CORNER: LOOP_CORNER,
    withPreset: withPreset,
    LINE_RATIO: LINE_RATIO,
    NOZZLE_DEFAULT: NOZZLE_DEFAULT,
    PROBE_DEFAULT: PROBE_DEFAULT,
    WELD_TOL: WELD_TOL,
    floorFor: floorFor,
    measureMesh: measureMesh,
    measureRegion: measureRegion,
    loopWallAt: loopWallAt,
    measureLoop: measureLoop,
    safeRadius: safeRadius,
    describe: describe
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NSO_Thickness = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
