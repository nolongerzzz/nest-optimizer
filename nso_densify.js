/* nso_densify.js - subdivide the triangles inside a sphere to a fixed spacing.

   Loads as a classic script (window.NSO_Densify) and as a Node module. No DOM,
   no THREE, no app state.

   WHY IT IS ITS OWN FILE. A coarse mesh has no degrees of freedom to take a
   curve: the top of a 20 mm cube is two triangles, and pulling the middle of it
   moves nothing because there is no vertex in the middle. Anything that moves
   the surface by hand (Pull today, the gun after it) has to put vertices where
   it is about to work first, and has to do it the same way, so the answer to
   "how fine is fine" lives in one place. This is that place. app-brush.js has
   its own refinement (NSO_brushRefine) that is sized by the brush radius and
   rebuilt mid-stroke; it is left as it is. This one is sized in millimetres,
   done once per region, and reports what it did.

   WHAT IT DOES. Welds the soup to an indexed mesh, then, in rounds, marks every
   edge longer than `spacing` that belongs to a triangle within `r + margin` of
   the zone's centre and splits it at its midpoint. Each round halves the marked
   edges, so a 60 mm edge reaches 0.5 mm in seven rounds. The unit of work is
   the EDGE, keyed on its vertex pair: both triangles that share a marked edge
   are handed the same midpoint vertex, including a triangle outside the zone,
   so the result has no T-junction by construction - the mesh is never repaired
   afterwards, it is never broken. Winding is kept, every original vertex keeps
   its exact coordinates (midpoints are the only new points, and they lie on the
   old edges), so the surface is geometrically unchanged; only its sampling is.

   THE ONE EXCEPTION IS A SLIVER (see "slivers" below): a triangle less than
   1e-3 mm high cannot be cut without putting two points closer together than
   the 1e-4 mm everything downstream welds at, so it is flipped or collapsed
   away first. That moves the surface by at most the sliver's height or its
   shortest edge (<= 0.02 mm, and <= a tenth of the spacing), the report says
   how far (`moved`), and a mesh with no slivers is not touched by it.

   WHAT "INSIDE THE RADIUS" MEANS. A triangle is in the zone when the nearest
   point of the triangle to the zone's centre is within r + margin - not when a
   vertex is. A vertex test misses the case this exists for: a two-triangle
   face with a 12 mm zone at its middle has every vertex 14 mm away. The margin
   (default one spacing) keeps one more ring of fine triangles beyond the
   radius, so nothing that moves is next to a coarse triangle that does not.

   IDEMPOTENT. Run on a region that is already fine it splits nothing and says
   so (`splits: 0`), which is how "once per region" is kept without anyone
   remembering which regions were done.

   NUMBERS. spacing is a MAXIMUM EDGE LENGTH, not an average: when this is done
   every edge of every triangle in the zone is <= spacing (an edge already
   within 1e-4 mm of it counts: FINE_SLACK, below). A split edge halves,
   so a result edge is in (spacing/2, spacing] unless it was already shorter.
   `maxTris` is a budget: a round that would pass it is not applied (half a
   round is not a mesh anyone wants) and the report says `capped`.

     NSO_Densify.region(rawTris, zone, opts) -> {
       ok, reason, mesh, soup, changed,
       report: { spacing, splits, passes, trisBefore, trisAfter, capped, zone,
                 slivers, moved }
     }
       rawTris  Float32Array/Array, 9 floats per triangle
       zone     { c: [x,y,z], r }                (r in mm)
       opts     { spacing = 0.5, margin = spacing, maxPasses = 24,
                  maxTris = 600000, weld = 1e-4,
                  sliver = 1e-3, sliverEdge = min(0.02, spacing / 10) }
                slivers  triangles lower than `sliver` mm flipped or collapsed
                         (their shortest edge up to `sliverEdge`) before
                         cutting; `moved` is the furthest the surface went
       mesh     { pos: Float64Array, tri: Int32Array, vertCount, triCount }
       soup     Float32Array rebuilt from the mesh (same winding)
       changed  false when nothing was split (soup is then rawTris itself)

     NSO_Densify.weld(rawTris, tol) -> mesh
     NSO_Densify.refine(mesh, zone, opts) -> { mesh, splits, passes, capped,
                                               flips, collapses, moved }
     NSO_Densify.toSoup(mesh, pos?) -> Float32Array
     NSO_Densify.triDist2(pos, a, b, c, p) -> squared distance from p to the triangle
     NSO_Densify.say(report) -> one status-line phrase
*/
(function (root) {
  'use strict';

  var DEFAULT_SPACING = 0.5;
  /* An edge within this of the spacing IS the spacing. The grading and the
     halving make edges of exactly the spacing, and a float32 soup stores a
     1 mm edge at 26 mm from the origin as 1.0000028 mm: without the slack,
     densifying a densified region cut those again (it is not idempotent). One
     weld tolerance - nothing downstream can tell the difference. */
  var FINE_SLACK = 1e-4;

  /* ------------------------------------------------------------ weld */

  /* Soup -> indexed mesh. Vertices within `tol` of each other are one vertex
     (grid-hashed on tol, checked against the 26 neighbouring cells so two
     points either side of a cell wall still merge). The FIRST point seen is the
     representative, so a vertex that was never a duplicate keeps its exact
     coordinates. Triangles that collapse to fewer than three distinct vertices
     are dropped - they have no area to keep. */
  function weld(rawTris, tol) {
    var n = (rawTris.length / 9) | 0;
    var t = (tol > 0) ? tol : 1e-4, inv = 1 / t;
    var cell = new Map();
    var pos = [];
    var tri = [];
    var ids = new Int32Array(n * 3);
    for (var i = 0; i < n * 3; i++) {
      var x = rawTris[i * 3], y = rawTris[i * 3 + 1], z = rawTris[i * 3 + 2];
      var cx = Math.floor(x * inv), cy = Math.floor(y * inv), cz = Math.floor(z * inv);
      var found = -1;
      for (var dx = -1; dx <= 1 && found < 0; dx++) {
        for (var dy = -1; dy <= 1 && found < 0; dy++) {
          for (var dz = -1; dz <= 1 && found < 0; dz++) {
            var b = cell.get((cx + dx) + '|' + (cy + dy) + '|' + (cz + dz));
            if (!b) continue;
            for (var q = 0; q < b.length; q++) {
              var o = b[q] * 3;
              if (Math.abs(pos[o] - x) <= t && Math.abs(pos[o + 1] - y) <= t && Math.abs(pos[o + 2] - z) <= t) {
                found = b[q];
                break;
              }
            }
          }
        }
      }
      if (found < 0) {
        found = pos.length / 3;
        pos.push(x, y, z);
        var key = cx + '|' + cy + '|' + cz;
        var bucket = cell.get(key);
        if (bucket) bucket.push(found); else cell.set(key, [found]);
      }
      ids[i] = found;
    }
    for (var k = 0; k < n; k++) {
      var a = ids[k * 3], b2 = ids[k * 3 + 1], c = ids[k * 3 + 2];
      if (a === b2 || b2 === c || c === a) continue;
      tri.push(a, b2, c);
    }
    return {
      pos: new Float64Array(pos), tri: new Int32Array(tri),
      vertCount: pos.length / 3, triCount: tri.length / 3
    };
  }

  /* Indexed mesh -> flat soup, same order and winding. Float32, like every
     rawTris in the app. */
  function toSoup(mesh, pos) {
    var p = pos || mesh.pos;
    var out = new Float32Array(mesh.triCount * 9);
    for (var t = 0; t < mesh.triCount; t++) {
      for (var v = 0; v < 3; v++) {
        var i = mesh.tri[t * 3 + v] * 3, o = t * 9 + v * 3;
        out[o] = p[i]; out[o + 1] = p[i + 1]; out[o + 2] = p[i + 2];
      }
    }
    return out;
  }

  /* ------------------------------------------------- triangle distance */

  /* Squared distance from point p to triangle (a, b, c) of an indexed pos
     array - Ericson, Real-Time Collision Detection 5.1.5. */
  function triDist2(pos, ia, ib, ic, p) {
    var a0 = pos[ia * 3], a1 = pos[ia * 3 + 1], a2 = pos[ia * 3 + 2];
    var b0 = pos[ib * 3], b1 = pos[ib * 3 + 1], b2 = pos[ib * 3 + 2];
    var c0 = pos[ic * 3], c1 = pos[ic * 3 + 1], c2 = pos[ic * 3 + 2];
    var abx = b0 - a0, aby = b1 - a1, abz = b2 - a2;
    var acx = c0 - a0, acy = c1 - a1, acz = c2 - a2;
    var apx = p[0] - a0, apy = p[1] - a1, apz = p[2] - a2;
    var d1 = abx * apx + aby * apy + abz * apz;
    var d2 = acx * apx + acy * apy + acz * apz;
    var qx, qy, qz;
    if (d1 <= 0 && d2 <= 0) { qx = a0; qy = a1; qz = a2; }
    else {
      var bpx = p[0] - b0, bpy = p[1] - b1, bpz = p[2] - b2;
      var d3 = abx * bpx + aby * bpy + abz * bpz;
      var d4 = acx * bpx + acy * bpy + acz * bpz;
      if (d3 >= 0 && d4 <= d3) { qx = b0; qy = b1; qz = b2; }
      else {
        var vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
          var v1 = d1 / (d1 - d3);
          qx = a0 + v1 * abx; qy = a1 + v1 * aby; qz = a2 + v1 * abz;
        } else {
          var cpx = p[0] - c0, cpy = p[1] - c1, cpz = p[2] - c2;
          var d5 = abx * cpx + aby * cpy + abz * cpz;
          var d6 = acx * cpx + acy * cpy + acz * cpz;
          if (d6 >= 0 && d5 <= d6) { qx = c0; qy = c1; qz = c2; }
          else {
            var vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) {
              var w1 = d2 / (d2 - d6);
              qx = a0 + w1 * acx; qy = a1 + w1 * acy; qz = a2 + w1 * acz;
            } else {
              var va = d3 * d6 - d5 * d4;
              if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
                var w2 = (d4 - d3) / ((d4 - d3) + (d5 - d6));
                qx = b0 + w2 * (c0 - b0); qy = b1 + w2 * (c1 - b1); qz = b2 + w2 * (c2 - b2);
              } else {
                var den = 1 / (va + vb + vc);
                var v = vb * den, w = vc * den;
                qx = a0 + abx * v + acx * w; qy = a1 + aby * v + acy * w; qz = a2 + abz * v + acz * w;
              }
            }
          }
        }
      }
    }
    var dx = p[0] - qx, dy = p[1] - qy, dz = p[2] - qz;
    return dx * dx + dy * dy + dz * dz;
  }

  function d2(pos, i, j) {
    var a = i * 3, b = j * 3;
    var dx = pos[a] - pos[b], dy = pos[a + 1] - pos[b + 1], dz = pos[a + 2] - pos[b + 2];
    return dx * dx + dy * dy + dz * dz;
  }

  /* One triangle with up to three marked edges, rebuilt so the pieces tile it
     with the original winding. `midOf(u, v)` is the midpoint vertex id of the
     marked edge u-v, or -1 when it is not marked.

     The LONGEST marked edge is bisected first, to the opposite vertex, and each
     half is then offered the same question again: a marked edge that survives
     in a half is bisected in turn. One mark gives two triangles, two marks
     three, three marks four - and because the longest edge always goes first,
     the pieces are cut ACROSS a long thin triangle rather than along it. */
  function emit(a, b, c, midOf, out, pos) {
    var mab = midOf(a, b), mbc = midOf(b, c), mca = midOf(c, a);
    if (mab < 0 && mbc < 0 && mca < 0) { out.push(a, b, c); return; }
    var lab = mab >= 0 ? d2(pos, a, b) : -1;
    var lbc = mbc >= 0 ? d2(pos, b, c) : -1;
    var lca = mca >= 0 ? d2(pos, c, a) : -1;
    if (lab >= lbc && lab >= lca) {
      emit(a, mab, c, midOf, out, pos); emit(mab, b, c, midOf, out, pos);
    } else if (lbc >= lca) {
      emit(b, mbc, a, midOf, out, pos); emit(mbc, c, a, midOf, out, pos);
    } else {
      emit(c, mca, b, midOf, out, pos); emit(mca, a, b, midOf, out, pos);
    }
  }

  /* ----------------------------------------------------------- needles */

  /* WHY BISECTION ALONE IS NOT ENOUGH. Cutting a triangle's longest edge keeps
     its angles (Rivara: never worse than half the starting minimum), and a
     needle - a revolved wall's 40 mm x 0.65 mm facet is the common one - is
     all small angle. Bisect it down to 0.5 mm edges and every piece is still
     a needle: measured on a 96-segment tube, 768 triangles became 99,000 for
     a 12 mm zone (about 13,000 is what the area needs), some of them 0.005 mm
     wide. That is not only memory: every gate after this walks those triangles.

     So a needle is not bisected, it is ZIPPED. Its sides are cut into equal
     pieces of at most `spacing` (the edge key carries the count, so the
     neighbour across the edge agrees without being asked), and the strip
     between the two long sides is laddered: two chains of points, always
     advance the one that makes the shorter new diagonal. No new point leaves
     the old edges, the width is kept, and the count is the length over the
     spacing - about two triangles per spacing of length.

     A triangle counts as a needle when it is thin (aspect > 3) AND narrow
     (its shortest altitude is under 3 spacings). Thin but wide - a 100 x 20
     slab face - is not: a ladder across it would be 20 mm rungs, which is a
     needle of its own. That one is bisected.

     A needle can also be much longer than the zone (a 200 mm tube wall with a
     12 mm zone at its lip), and zipping the whole of it would spend most of
     the triangles where nothing is going to move. So needles longer than the
     zone's diameter are first bisected - which is harmless to a needle, it
     only halves the length - until each piece is about the zone's size. */
  var NEEDLE_ASPECT = 3, NEEDLE_NARROW = 3;
  // a thin triangle whose SHORTEST edge is this many heights long is a cap, not a needle (zip, below)
  var CAP_RATIO = 4;

  function crossLen(pos, a, b, c) {
    var ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    var vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    return Math.sqrt(nx * nx + ny * ny + nz * nz);          // twice the area
  }

  /* Is triangle (a, b, c) a needle? q0..q2 are its squared edge lengths. */
  function isNeedle(pos, a, b, c, q0, q1, q2, spacing) {
    var qmax = Math.max(q0, q1, q2);
    if (!(qmax > 0)) return false;
    var l0 = Math.sqrt(q0), l1 = Math.sqrt(q1), l2 = Math.sqrt(q2);
    var area2 = crossLen(pos, a, b, c);
    if (!(area2 > 0)) return true;                       // a sliver is as bad as a needle
    var sp = (l0 + l1 + l2) * 0.5;
    var aspect = Math.sqrt(qmax) / (area2 / sp);         // longest edge over twice the inradius
    if (aspect <= NEEDLE_ASPECT) return false;
    return area2 / Math.sqrt(qmax) <= NEEDLE_NARROW * spacing;     // shortest altitude
  }

  // Fraction of its total length at which each point of a chain sits.
  function fractions(pos, ids) {
    var f = new Float64Array(ids.length), acc = 0;
    for (var i = 1; i < ids.length; i++) { acc += Math.sqrt(d2(pos, ids[i - 1], ids[i])); f[i] = acc; }
    if (acc > 0) for (var k = 1; k < ids.length; k++) f[k] /= acc;
    return f;
  }

  /* Where a needle's edge is cut: the parameters t in (0, 1), from the lower
     vertex id to the higher, of the points to add. Only the part of the edge
     inside the zone's reach is subdivided (to pieces of at most `spacing`), plus
     the two points where the edge enters and leaves it - so a 200 mm wall with
     a 12 mm zone at its lip is cut into three needles, the middle one fine and
     the other two left alone, and not ladder rungs for the whole of its length.
     The reach is taken a hair over (CLIP_PAD) so the two outer pieces lie
     strictly outside it and are not refined in their turn. */
  var CLIP_PAD = 1.001;

  /* The part of the edge lo-hi inside the zone's reach, as { t0, t1, len }
     (t from lo to hi), or null if it does not touch it. */
  function edgeSpan(pos, lo, hi, zone, reach) {
    var px = pos[lo * 3], py = pos[lo * 3 + 1], pz = pos[lo * 3 + 2];
    var dx = pos[hi * 3] - px, dy = pos[hi * 3 + 1] - py, dz = pos[hi * 3 + 2] - pz;
    var len2 = dx * dx + dy * dy + dz * dz, len = Math.sqrt(len2);
    if (!(len > 0)) return null;
    var ox = px - zone.c[0], oy = py - zone.c[1], oz = pz - zone.c[2];
    var R = reach * CLIP_PAD;
    var qa = len2, qb = 2 * (ox * dx + oy * dy + oz * dz), qc = ox * ox + oy * oy + oz * oz - R * R;
    var disc = qb * qb - 4 * qa * qc;
    if (disc < 0) return null;
    var sq = Math.sqrt(disc);
    var t0 = Math.max(0, (-qb - sq) / (2 * qa)), t1 = Math.min(1, (-qb + sq) / (2 * qa));
    if (!(t1 > t0)) return null;
    return { t0: t0, t1: t1, len: len };
  }

  /* The cut parameters for a span: the two ends of it, even pieces of at most
     `spacing` between them, and past each end a geometric grading (2, 4, 8 ...
     spacings from the zone's edge) so a triangle beside the fine ones is at
     most about twice their length rather than the whole wall - the long needle
     that stood right against a fine ladder was where the checker's phantom
     piercing pairs lived (docs/PULL.md). */
  function spanCuts(span, spacing) {
    var t0 = span.t0, t1 = span.t1, len = span.len;
    var n = Math.max(1, Math.ceil(((t1 - t0) * len - FINE_SLACK) / spacing - 1e-9));
    var ts = [], i, step = 2 * spacing, at = t0 * len;
    while (at > 1e-9 && ts.length < 64) {
      at -= step;
      if (at <= 0.25 * step) break;
      ts.unshift(at / len); step *= 2;
    }
    /* The sphere can cross an edge a hair from one of its ends. A cut there is
       a vertex a hair from another one - and on a fan of edges meeting at that
       end, a row of them a hair from each other. Inside a quarter spacing of
       an end the end itself stands in for it (the piece it leaves is at most
       1.25 spacings, and bisection halves it). */
    var gap = 0.25 * spacing;
    if (t0 * len >= gap) ts.push(t0);
    for (i = 1; i < n; i++) ts.push(t0 + (t1 - t0) * i / n);
    if ((1 - t1) * len >= gap) ts.push(t1);
    step = 2 * spacing; at = t1 * len;
    while (at < len - 1e-9 && ts.length < 128) {
      at += step;
      if (at >= len - 0.25 * step) break;
      ts.push(at / len); step *= 2;
    }
    return ts;
  }

  /* One zipping round over the needles in the zone. Returns the new mesh, or
     null when there was none (nothing touched).

     QUADS. Two needles that share their longest edge and lie in one plane are
     a thin RECTANGLE cut along its diagonal - which is exactly what a revolved
     or extruded wall is made of. Laddering each half separately keeps the
     diagonal, so the strip ends up with a line of vertices down its middle and
     every ladder triangle tapering to nothing at one end. The pair is laddered
     as ONE quad between its two long sides instead: the diagonal goes, the
     rungs are the strip's full width all the way along, and there are half as
     many triangles and none of them thin. A needle with no such partner is
     laddered alone, as above. */
  function zip(mesh, zone, spacing, reach) {
    var V = mesh.vertCount, T = mesh.triCount, tri = mesh.tri, pos = mesh.pos;
    var s2 = (spacing + FINE_SLACK) * (spacing + FINE_SLACK), reach2 = reach * reach;
    /* needle[t]: t is a needle (by shape) that is coarse. inZone[t]: and it
       touches the zone. Only an in-zone needle starts anything, but its other
       half may lie just outside the sphere: it is a needle too, and leaving it
       out would split a rectangle into one laddered half and one untouched
       half, with the thin tapered triangles that makes along the diagonal. */
    var needle = new Uint8Array(T), inZone = new Uint8Array(T), t, k, any = false;
    var byEdge = new Map();
    for (t = 0; t < T; t++) {
      var a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
      var q0 = d2(pos, a, b), q1 = d2(pos, b, c), q2 = d2(pos, c, a);
      if (Math.max(q0, q1, q2) <= s2) continue;
      if (!isNeedle(pos, a, b, c, q0, q1, q2, spacing)) continue;
      needle[t] = 1;
      if (triDist2(pos, a, b, c, zone.c) <= reach2) { inZone[t] = 1; any = true; }
      var es = [a, b, b, c, c, a];
      for (k = 0; k < 3; k++) {
        var u = es[k * 2], w = es[k * 2 + 1], key = u < w ? u * V + w : w * V + u;
        var list = byEdge.get(key);
        if (list) list.push(t); else byEdge.set(key, [t]);
      }
    }
    if (!any) return null;

    // Where each needle edge meets the zone, on its own.
    var edgeS = new Map();
    byEdge.forEach(function (ts, key) {
      var hi = key % V, lo = (key - hi) / V;
      var sp = edgeSpan(pos, lo, hi, zone, reach);
      if (sp) edgeS.set(key, sp);
    });

    // Pair the needles that are halves of a rectangle.
    var partner = new Int32Array(T).fill(-1), quads = new Map();
    function triNormal(tt) {
      var ia = tri[tt * 3] * 3, ib = tri[tt * 3 + 1] * 3, ic = tri[tt * 3 + 2] * 3;
      var ux = pos[ib] - pos[ia], uy = pos[ib + 1] - pos[ia + 1], uz = pos[ib + 2] - pos[ia + 2];
      var vx = pos[ic] - pos[ia], vy = pos[ic + 1] - pos[ia + 1], vz = pos[ic + 2] - pos[ia + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var L = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      return [nx / L, ny / L, nz / L];
    }
    function longestIdx(tt) {
      var e0 = d2(pos, tri[tt * 3], tri[tt * 3 + 1]), e1 = d2(pos, tri[tt * 3 + 1], tri[tt * 3 + 2]),
          e2 = d2(pos, tri[tt * 3 + 2], tri[tt * 3]);
      return (e0 >= e1 && e0 >= e2) ? 0 : (e1 >= e2 ? 1 : 2);
    }
    function ek(u, w) { return u < w ? u * V + w : w * V + u; }
    for (t = 0; t < T; t++) {
      if (!inZone[t] || partner[t] >= 0) continue;
      var li = longestIdx(t);
      var tv = [tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]];
      var dkey = ek(tv[li], tv[(li + 1) % 3]);
      var sharing = byEdge.get(dkey);
      if (!sharing || sharing.length !== 2) continue;
      var o = sharing[0] === t ? sharing[1] : sharing[0];
      if (!needle[o] || partner[o] >= 0) continue;
      var olv = longestIdx(o);
      var ov = [tri[o * 3], tri[o * 3 + 1], tri[o * 3 + 2]];
      if (ek(ov[olv], ov[(olv + 1) % 3]) !== dkey) continue;
      var n1 = triNormal(t), n2 = triNormal(o);
      if (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] < 1 - 1e-9) continue;
      // rotate t so the shared edge runs C -> A; D is the other triangle's apex
      var QA = tv[(li + 1) % 3], QB = tv[(li + 2) % 3], QC = tv[li], QD = -1;
      for (k = 0; k < 3; k++) if (ov[k] !== QA && ov[k] !== QC) QD = ov[k];
      if (QD < 0) continue;
      // convex?  every turn of A,B,C,D must be the way the triangle turns
      var corners = [QA, QB, QC, QD], convex = true;
      for (k = 0; k < 4 && convex; k++) {
        var p0 = corners[k] * 3, p1 = corners[(k + 1) % 4] * 3, p2 = corners[(k + 2) % 4] * 3;
        var e1x = pos[p1] - pos[p0], e1y = pos[p1 + 1] - pos[p0 + 1], e1z = pos[p1 + 2] - pos[p0 + 2];
        var e2x = pos[p2] - pos[p1], e2y = pos[p2 + 1] - pos[p1 + 1], e2z = pos[p2 + 2] - pos[p1 + 2];
        var cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
        if (cx * n1[0] + cy * n1[1] + cz * n1[2] <= 0) convex = false;
      }
      if (!convex) continue;
      // the long sides are the opposite pair with the greater total length
      var lAB = d2(pos, QA, QB), lBC = d2(pos, QB, QC), lCD = d2(pos, QC, QD), lDA = d2(pos, QD, QA);
      var A2 = QA, B2 = QB, C2 = QC, D2 = QD;
      var sA = Math.sqrt(lBC), sB = Math.sqrt(lDA), sF = Math.sqrt(lAB), sH = Math.sqrt(lCD);
      if (sF + sH > sA + sB) { A2 = QB; B2 = QC; C2 = QD; D2 = QA; sA = Math.sqrt(lCD); sB = Math.sqrt(lAB); sF = Math.sqrt(lBC); sH = Math.sqrt(lDA); }
      /* ...and it IS a strip: two long sides of about one length, each well
         over the foot and the head. Two neighbouring needles of a FAN - the
         spokes a boolean leaves from an intersection curve to a far corner -
         also share a longest edge in one plane, but their "long sides" are a
         60 mm spoke and a 0.09 mm piece of the curve. Paired, the two sides
         share their cuts (below), and the 0.09 mm edge was cut 32 times for a
         30 mm one: points 0.003 mm apart and a ladder of slivers. */
      if (Math.min(sA, sB) < 0.75 * Math.max(sA, sB) || Math.min(sA, sB) < NEEDLE_ASPECT * Math.max(sF, sH)) continue;
      partner[t] = o; partner[o] = t;
      quads.set(t, [A2, B2, C2, D2, dkey]);
    }

    /* THE TWO LONG SIDES OF A RECTANGLE ARE CUT AT THE SAME PLACES. Each side
       was cut where the zone's sphere crosses it, and two neighbouring sides
       are crossed at different heights when the sphere's centre is close to
       them: the ladder between them then has slanted rungs, and a slanted rung
       on a 0.65 mm strip is a triangle 0.06 mm wide. So every side that is
       half of a quad shares its cuts with the side across it - and, since that
       side is half of the next quad, with the whole ring of them (a union-find
       with a flip bit, because two sides can run opposite ways round). */
    var uf = new Map();                      // edge key -> { p: parent key, f: flip to parent }
    function find(key) {
      var n = uf.get(key);
      if (!n) { n = { p: key, f: 0 }; uf.set(key, n); }
      if (n.p === key) return { root: key, f: 0 };
      var r = find(n.p);
      n.p = r.root; n.f ^= r.f;
      return { root: r.root, f: n.f };
    }
    quads.forEach(function (q) {
      var k1 = ek(q[1], q[2]), k2 = ek(q[3], q[0]);
      // each side's t runs lo -> hi; the climb runs B -> C and A -> D
      var f1 = q[1] < q[2] ? 0 : 1, f2 = q[0] < q[3] ? 0 : 1;
      var r1 = find(k1), r2 = find(k2);
      if (r1.root === r2.root) return;
      // t1 = flip(f1) of tau, t2 = flip(f2) of tau: t1 is t2 flipped when f1 != f2
      var rel = f1 ^ f2;
      uf.get(r1.root).p = r2.root;
      uf.get(r1.root).f = r1.f ^ rel ^ r2.f;
    });
    var cls = new Map();                     // root -> the union of its members' spans, in the root's t
    uf.forEach(function (n, key) {
      var r = find(key), own = edgeS.get(key);
      if (!own) return;
      var a0 = r.f ? 1 - own.t1 : own.t0, a1 = r.f ? 1 - own.t0 : own.t1;
      var c = cls.get(r.root);
      if (!c) cls.set(r.root, { t0: a0, t1: a1, len: own.len });
      else { c.t0 = Math.min(c.t0, a0); c.t1 = Math.max(c.t1, a1); c.len = Math.max(c.len, own.len); }
    });
    var edgeT = new Map(), decided = new Set();
    uf.forEach(function (n, key) {
      var r = find(key), c = cls.get(r.root);
      if (!c) return;
      var span = r.f ? { t0: 1 - c.t1, t1: 1 - c.t0, len: c.len } : { t0: c.t0, t1: c.t1, len: c.len };
      var ts = spanCuts(span, spacing);
      decided.add(key);
      if (ts.length) edgeT.set(key, ts);
    });
    // every other needle edge (the rest of the unpaired needles, the feet and
    // heads of the quads, the diagonals) is cut on its own
    // (An edge with no cut is not in edgeT at all: an empty list there made a
    // quad with uncut sides look cut, and its two fans overlapped.)
    edgeS.forEach(function (sp, key) {
      if (decided.has(key)) return;
      var ts = spanCuts(sp, spacing);
      if (ts.length) edgeT.set(key, ts);
    });
    // A quad whose sides came out uncut has nothing to ladder: back to two needles.
    quads.forEach(function (q, t1) {
      var dkey = q[4];
      if (edgeT.has(ek(q[1], q[2])) && edgeT.has(ek(q[3], q[0]))) { edgeT.delete(dkey); return; }
      var o = partner[t1]; partner[t1] = -1; partner[o] = -1; quads.delete(t1);
    });

    // The new points: one per cut, ids in the order of t from lo to hi.
    var npos = [];
    var edgeIds = new Map();
    var next = V;
    edgeT.forEach(function (ts, key) {
      var hi = key % V, lo = (key - hi) / V;
      var ids = [];
      for (var i = 0; i < ts.length; i++) {
        var f = ts[i];
        npos.push(pos[lo * 3] + (pos[hi * 3] - pos[lo * 3]) * f,
                  pos[lo * 3 + 1] + (pos[hi * 3 + 1] - pos[lo * 3 + 1]) * f,
                  pos[lo * 3 + 2] + (pos[hi * 3 + 2] - pos[lo * 3 + 2]) * f);
        ids.push(next++);
      }
      edgeIds.set(key, ids);
    });
    if (!edgeIds.size) return null;
    var allPos = new Float64Array(next * 3);
    allPos.set(pos.subarray(0, V * 3));
    allPos.set(npos, V * 3);

    // Vertices from u to v along the edge, cut points included.
    function chain(u, v) {
      var ids = edgeIds.get(ek(u, v));
      if (!ids) return [u, v];
      var out = [u], i;
      if (u < v) for (i = 0; i < ids.length; i++) out.push(ids[i]);
      else for (i = ids.length - 1; i >= 0; i--) out.push(ids[i]);
      out.push(v);
      return out;
    }

    var built = [];
    function tri3(x, y, z) { if (x !== y && y !== z && z !== x) built.push(x, y, z); }

    for (t = 0; t < T; t++) {
      var ta = tri[t * 3], tb = tri[t * 3 + 1], tc = tri[t * 3 + 2];
      var quad = quads.get(t);
      if (partner[t] >= 0 && !quad) continue;            // the second half, done with the first
      if (quad) {
        /* A, B, C, D run counter-clockwise; B->C and D->A are the long sides,
           A->B the foot and C->D the head. Left side L climbs A->D, right side
           R climbs B->C. The foot is fanned from L's first point, the head
           from L's last-but-one, and the ladder climbs between the two
           diagonals that leaves. */
        var QAq = quad[0], QBq = quad[1], QCq = quad[2], QDq = quad[3];
        var Lq = chain(QAq, QDq), Rq = chain(QBq, QCq);
        var foot = chain(QAq, QBq), head = chain(QCq, QDq), m;
        var Fb = Lq[1], Ft = Lq[Lq.length - 2];
        for (m = 0; m + 1 < foot.length; m++) tri3(foot[m], foot[m + 1], Fb);
        for (m = 0; m + 1 < head.length; m++) tri3(head[m], head[m + 1], Ft);
        var gL = fractions(allPos, Lq), gR = fractions(allPos, Rq);
        var ii = 1, jj = 0, iEnd = Lq.length - 2, jEnd = Rq.length - 1;
        while (ii < iEnd || jj < jEnd) {
          var stepL = (jj === jEnd) ? true : (ii === iEnd) ? false : gL[ii + 1] <= gR[jj + 1];
          if (stepL) { tri3(Lq[ii + 1], Lq[ii], Rq[jj]); ii++; }
          else { tri3(Rq[jj], Rq[jj + 1], Lq[ii]); jj++; }
        }
        continue;
      }
      if (!edgeIds.has(ek(ta, tb)) && !edgeIds.has(ek(tb, tc)) && !edgeIds.has(ek(tc, ta))) {
        built.push(ta, tb, tc); continue;
      }
      var e0 = d2(allPos, ta, tb), e1 = d2(allPos, tb, tc), e2 = d2(allPos, tc, ta);
      /* A CAP - the third vertex a hair off the longest edge, both its other
         edges long - has no short base to ladder up from: a boolean leaves
         them along a wall it cut (100 mm of wall edge, the third vertex 0.04 mm
         off it, 39 mm up). Laddered as a needle, its 39 mm "base" was fanned
         from one point, every fan edge a long spoke inside a 0.04 mm strip,
         and the bisection after cut those nearly parallel spokes into
         midpoints 7e-5 mm apart that share no triangle - a weld merges them,
         and no edge collapse can. So a cap is laddered between its long edge
         and the two-edge path through the third vertex, both from one end of
         the long edge to the other: the rungs go ACROSS the strip. */
      var eMax = Math.max(e0, e1, e2), eMin = Math.min(e0, e1, e2);
      var hCap = crossLen(allPos, ta, tb, tc) / Math.sqrt(eMax);
      if (eMax > 0 && Math.sqrt(eMin) > CAP_RATIO * hCap) {
        var cu, cw, cm;                                     // u->w the long edge, in the winding
        if (e0 === eMax) { cu = ta; cw = tb; cm = tc; }
        else if (e1 === eMax) { cu = tb; cw = tc; cm = ta; }
        else { cu = tc; cw = ta; cm = tb; }
        var Lc = chain(cu, cw);                             // with the winding
        /* Both chains start at u, so the ladder is opened with ONE triangle,
           u and the first point of each. Left to the stepping rule, one chain
           can take several steps while the other is still at u, and each of
           those is a triangle from u to two points on u's own edge: three
           corners on one line, area 1e-17, which the bisection after grinds
           into points 1e-5 mm apart. (So a long edge with no cut on it, which
           would leave nothing to open with, is laddered as a needle below.) */
        if (Lc.length > 2) {
          var Rc = chain(cu, cm).concat(chain(cm, cw).slice(1)); // against it
          var gLc = fractions(allPos, Lc), gRc = fractions(allPos, Rc);
          tri3(cu, Lc[1], Rc[1]);
          var ic = 1, jc = 1;
          while (ic < Lc.length - 1 || jc < Rc.length - 1) {
            var stepLc = (jc === Rc.length - 1) ? true : (ic === Lc.length - 1) ? false : gLc[ic + 1] <= gRc[jc + 1];
            // the last step is degenerate (both chains end at w) and skipped
            if (stepLc) { tri3(Lc[ic], Lc[ic + 1], Rc[jc]); ic++; }
            else { tri3(Rc[jc + 1], Rc[jc], Lc[ic]); jc++; }
          }
          continue;
        }
      }
      /* Rotate (keeping the winding) so the apex C is opposite the shortest
         edge AB: the ladder runs from that short base up the two long sides. */
      var A, B, C;
      if (e0 <= e1 && e0 <= e2) { A = ta; B = tb; C = tc; }
      else if (e1 <= e2) { A = tb; B = tc; C = ta; }
      else { A = tc; B = ta; C = tb; }
      var L = chain(A, C);                                   // A -> C
      var R = chain(B, C);                                   // B -> C
      /* The base A..B may itself carry cut points. It is fanned from the first
         point up the LEFT side; but if the left side is uncut and the right is
         not, that point is the apex C itself, the fan would tile the whole
         triangle and strand the right side's cut points (a T-junction), so the
         fan is taken from the right side's first point and the ladder starts
         on the other foot. */
      var base = chain(A, B), q;
      var fromLeft = (L.length > 2 || R.length === 2);
      var F = fromLeft ? L[1] : R[1];
      for (q = 0; q + 1 < base.length; q++) tri3(base[q], base[q + 1], F);
      /* Advance whichever chain is BEHIND, by the fraction of its own length
         already walked. (The first version advanced the one with the shorter
         new diagonal. At a needle's tip the two sides are nearly the same line,
         that rule let one chain run ahead to the tip, and the other chain's
         points were left to fan into it: a run of triangles with all three
         corners on one straight edge, area 1e-15.) */
      var fL = fractions(allPos, L), fR = fractions(allPos, R);
      var i2 = fromLeft ? 1 : 0, j2 = fromLeft ? 0 : 1;
      while (i2 < L.length - 1 || j2 < R.length - 1) {
        var advL = (j2 === R.length - 1) ? true
          : (i2 === L.length - 1) ? false
          : fL[i2 + 1] <= fR[j2 + 1];
        // The wind keeps the boundary direction: R runs B->C, so a step on R
        // is (R_j, R_j+1, L_i); L runs the other way round, so a step on L is
        // (L_i+1, L_i, R_j). A step at either end is degenerate and skipped.
        if (advL) { tri3(L[i2 + 1], L[i2], R[j2]); i2++; }
        else { tri3(R[j2], R[j2 + 1], L[i2]); j2++; }
      }
    }
    return { pos: allPos, tri: new Int32Array(built), vertCount: next, triCount: (built.length / 3) | 0 };
  }

  /* ----------------------------------------------------------- bisection */

  /* One triangle with up to three marked edges, rebuilt so the pieces tile it
     with the original winding. `midOf(u, v)` is the midpoint vertex id of the
     marked edge u-v, or -1 when it is not marked.

     The LONGEST marked edge is bisected first, to the opposite vertex, and each
     half is then offered the same question again: a marked edge that survives
     in a half is bisected in turn. One mark gives two triangles, two marks
     three, three marks four. */
  function emit(a, b, c, midOf, out, pos) {
    var mab = midOf(a, b), mbc = midOf(b, c), mca = midOf(c, a);
    if (mab < 0 && mbc < 0 && mca < 0) { out.push(a, b, c); return; }
    var lab = mab >= 0 ? d2(pos, a, b) : -1;
    var lbc = mbc >= 0 ? d2(pos, b, c) : -1;
    var lca = mca >= 0 ? d2(pos, c, a) : -1;
    if (lab >= lbc && lab >= lca) {
      emit(a, mab, c, midOf, out, pos); emit(mab, b, c, midOf, out, pos);
    } else if (lbc >= lca) {
      emit(b, mbc, a, midOf, out, pos); emit(mbc, c, a, midOf, out, pos);
    } else {
      emit(c, mca, b, midOf, out, pos); emit(mca, a, b, midOf, out, pos);
    }
  }

  /* One round of longest-edge bisection. A triangle in the zone whose longest
     edge is over `limit` has that edge marked (and only that one: marking every
     long edge is the red refinement that turns strips into needles). Returns
     the new mesh, or null when nothing needed cutting. `needlesOnly` restricts
     the round to the coarse cutting of long needles described above. */
  function bisect(mesh, zone, spacing, reach2, limit, needlesOnly) {
    var V = mesh.vertCount, T = mesh.triCount, tri = mesh.tri, pos = mesh.pos;
    var lim2 = limit * limit;
    var mark = new Map();
    var t;
    for (t = 0; t < T; t++) {
      var a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
      var e0 = d2(pos, a, b), e1 = d2(pos, b, c), e2 = d2(pos, c, a);
      if (e0 <= lim2 && e1 <= lim2 && e2 <= lim2) continue;
      if (triDist2(pos, a, b, c, zone.c) > reach2) continue;
      if (needlesOnly && !isNeedle(pos, a, b, c, e0, e1, e2, spacing)) continue;
      var li = (e0 >= e1 && e0 >= e2) ? 0 : (e1 >= e2 ? 1 : 2);
      var pr = [a, b, b, c, c, a];
      var u = pr[li * 2], w = pr[li * 2 + 1];
      mark.set(u < w ? u * V + w : w * V + u, -1);
    }
    if (!mark.size) return null;

    /* LONGEST-EDGE CLOSURE. A triangle that has any marked edge must have its
       own longest edge marked too (Rivara's propagation, run for every
       triangle at once), so a neighbour is not cut along an edge that is not
       its longest. It terminates: each mark added is a strictly longer edge
       than the one that asked for it. A triangle that is already fine is cut
       along the mark it was handed and no more - propagating through a fine
       region only splits edges nobody asked for. */
    var grew = true, guard = 0;
    while (grew && guard++ < 64) {
      grew = false;
      for (t = 0; t < T; t++) {
        var ca = tri[t * 3], cb = tri[t * 3 + 1], cc = tri[t * 3 + 2];
        var kab = (ca < cb ? ca * V + cb : cb * V + ca);
        var kbc = (cb < cc ? cb * V + cc : cc * V + cb);
        var kca = (cc < ca ? cc * V + ca : ca * V + cc);
        if (!mark.has(kab) && !mark.has(kbc) && !mark.has(kca)) continue;
        var f0 = d2(pos, ca, cb), f1 = d2(pos, cb, cc), f2 = d2(pos, cc, ca);
        if (f0 <= lim2 && f1 <= lim2 && f2 <= lim2) continue;
        var lk = (f0 >= f1 && f0 >= f2) ? kab : (f1 >= f2 ? kbc : kca);
        if (!mark.has(lk)) { mark.set(lk, -1); grew = true; }
      }
    }

    var newV = V + mark.size;
    var npos = new Float64Array(newV * 3);
    npos.set(pos.subarray(0, V * 3));
    var next = V;
    mark.forEach(function (unused, key) {
      var hi = key % V, lo = (key - hi) / V;
      var i = lo * 3, j = hi * 3, o = next * 3;
      npos[o] = (pos[i] + pos[j]) * 0.5;
      npos[o + 1] = (pos[i + 1] + pos[j + 1]) * 0.5;
      npos[o + 2] = (pos[i + 2] + pos[j + 2]) * 0.5;
      mark.set(key, next);
      next++;
    });
    var midOf = function (u, w) {
      // an edge touching a vertex made this round is half of a cut one, never marked
      if (u >= V || w >= V) return -1;
      var m = mark.get(u < w ? u * V + w : w * V + u);
      return (m == null) ? -1 : m;
    };
    // EVERY triangle is rebuilt, in the zone or not: one outside it that
    // shares a marked edge is split here, and that is what keeps this
    // T-junction free.
    var built = [];
    for (t = 0; t < T; t++) emit(tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2], midOf, built, npos);
    return { pos: npos, tri: new Int32Array(built), vertCount: newV, triCount: (built.length / 3) | 0,
             splits: mark.size };
  }

  /* ----------------------------------------------------------- slivers */

  /* WHY A SLIVER HAS TO GO FIRST. A Manifold boolean that cuts a long wall
     triangle (a revolved cylinder's are its full height) leaves CAPS behind:
     triangles 40-60 mm long whose third vertex lies a few ten-thousandths of
     a millimetre off the long edge. Such a triangle is closed and manifold, and
     passes every gate - but everything this file does to it puts points on
     two of its edges at nearly the same place along its length (the zip cuts
     each edge where the zone's sphere crosses it, and two edges that are
     nearly one line are crossed at nearly one place; bisection halves the long
     edge and then the short ones next to it). Two such points are as far apart
     as the cap is high, and 7e-5 mm is closer than the 1e-4 mm every consumer
     welds at (mesh_validate.py, NSO_Repair, this file's own weld on the next
     call). Welded, the two become one vertex and the edges on either side of
     it double: a closed soup in, non-manifold edges and flipped winding out,
     with no T-junction anywhere in the topology this file built. When the
     coordinates are close enough to round to one float32, the same thing shows
     in the soup itself as open and non-manifold edges.

     So before anything is cut, every triangle lower than `sliver` (its height
     over its longest edge) has that longest edge FLIPPED - replaced by the edge
     from its low vertex to the far vertex of the triangle across. That is the
     same pair of triangles as inserting the low vertex into the long edge and
     dropping the zero-area remainder, which is what the cap is: a T-junction
     that happens to be within tolerance. Only vertices are reused, none move,
     and the surface moves by at most the cap's height (the low vertex is that
     far from the plane of the triangle across), so with `sliver` at 1e-3 mm
     the change is a micron at most and usually a tenth of that.

     A flip is made only when it RAISES the lower of the two triangles' heights
     - a needle fan along an intersection curve would otherwise trade its long
     edges for tiny caps along the curve and back again. It is never made when
     the new edge already exists (that would be a non-manifold edge), or when
     either new triangle would face away from the one it replaces. Each flip
     strictly improves its pair, and the work list is bounded besides.

     WHEN NO FLIP HELPS, THE SHORT EDGE GOES. The case this was written for -
     a 96-segment cylinder with a 4 mm-radius branch, whose silhouette runs
     within 0.006 mm of the cylinder's vertical edges - has slivers that no
     flip improves: the boolean's intersection curve takes a 0.004 mm step
     ALONG the wall's long direction, and every triangle on that step, whichever
     way the quad is cut, is a 1e-4 mm sliver (a triangle on a 0.004 mm edge is
     at most 0.004 x sin(angle) high, and the angle is the curve's slope).
     So when a sliver's shortest edge is at most `sliverEdge` it is
     COLLAPSED - the higher-numbered end joins the lower, the two triangles on
     it go - which is a weld at that edge's length. Only when the edge is
     interior and manifold, the link condition holds (else the collapse pinches
     the surface into a non-manifold edge), and none of the triangles that move
     turns over or tilts by more than 60 degrees. */
  var SLIVER_H = 1e-3, SLIVER_E = 0.02;

  // twice the area over the longest edge = the lowest altitude, in mm
  function lowAlt(pos, a, b, c) {
    var q = Math.max(d2(pos, a, b), d2(pos, b, c), d2(pos, c, a));
    return q > 0 ? crossLen(pos, a, b, c) / Math.sqrt(q) : 0;
  }

  function normalOf(pos, a, b, c) {
    var ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    var vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  }

  /* Edge surgery on a copy of an indexed mesh: flips and collapses with the
     adjacency kept up to date, then compacted back to a plain mesh. Shared by
     the sliver pass before refining and the weld-safe pass after it. */
  function surgery(mesh) {
    var V = mesh.vertCount, T = mesh.triCount, pos = mesh.pos;
    var tri = new Int32Array(mesh.tri), t, k;
    var dead = new Uint8Array(T);
    // directed edge u->w -> the triangle that has it; undirected use count beside
    var half = new Map(), count = new Map();
    var around = new Array(V);                       // vertex -> its triangles (may hold stale ids)
    var S = { tri: tri, dead: dead, moved: 0, flips: 0, collapses: 0, onChange: null };
    function ek(u, w) { return u < w ? u * V + w : w * V + u; }
    function link(tt, on) {
      for (var e = 0; e < 3; e++) {
        var u = tri[tt * 3 + e], w = tri[tt * 3 + (e + 1) % 3], key = ek(u, w);
        if (on) { half.set(u * V + w, tt); count.set(key, (count.get(key) || 0) + 1); }
        else {
          if (half.get(u * V + w) === tt) half.delete(u * V + w);
          var n = (count.get(key) || 0) - 1;
          if (n > 0) count.set(key, n); else count.delete(key);
        }
      }
    }
    function has(tt, v) { return tri[tt * 3] === v || tri[tt * 3 + 1] === v || tri[tt * 3 + 2] === v; }
    function trisOf(v) {
      var src = around[v] || [], out = [];
      for (var i = 0; i < src.length; i++) {
        var tt = src[i];
        if (!dead[tt] && has(tt, v) && out.indexOf(tt) < 0) out.push(tt);
      }
      around[v] = out;
      return out;
    }
    function ringOf(v) {
      var ts = trisOf(v), s = new Set();
      for (var i = 0; i < ts.length; i++) for (var e = 0; e < 3; e++) {
        var x = tri[ts[i] * 3 + e];
        if (x !== v) s.add(x);
      }
      return s;
    }
    function dot(p, q) { return p[0] * q[0] + p[1] * q[1] + p[2] * q[2]; }
    for (t = 0; t < T; t++) {
      link(t, true);
      for (k = 0; k < 3; k++) {
        var vv = tri[t * 3 + k];
        (around[vv] || (around[vv] = [])).push(t);
      }
    }
    S.trisOf = trisOf;
    S.edgeCount = function (u, w) { return count.get(ek(u, w)) || 0; };

    /* Triangle t's edge u->w swapped for m-x, m being t's third vertex. Only
       when it RAISES the lower of the two heights (`improve`), the new edge is
       not there already, and neither new triangle faces away. */
    S.flip = function (t, u, w, m) {
      if (count.get(ek(u, w)) !== 2) return false;           // an open or non-manifold edge: leave it
      var o = half.get(w * V + u);
      if (o == null || o === t || dead[o]) return false;
      var x = -1;
      for (var i = 0; i < 3; i++) { var vi = tri[o * 3 + i]; if (vi !== u && vi !== w) x = vi; }
      if (x < 0 || x === m || count.has(ek(m, x))) return false;
      var nO = normalOf(pos, w, u, x), nT = normalOf(pos, u, w, m);
      var ref = [nO[0] + nT[0], nO[1] + nT[1], nO[2] + nT[2]];
      if (dot(normalOf(pos, u, x, m), ref) <= 0 || dot(normalOf(pos, x, w, m), ref) <= 0) return false;
      var hT = lowAlt(pos, u, w, m);
      var before = Math.min(hT, lowAlt(pos, w, u, x));
      var after = Math.min(lowAlt(pos, u, x, m), lowAlt(pos, x, w, m));
      if (!(after > before)) return false;
      link(t, false); link(o, false);
      tri[t * 3] = u; tri[t * 3 + 1] = x; tri[t * 3 + 2] = m;
      tri[o * 3] = x; tri[o * 3 + 1] = w; tri[o * 3 + 2] = m;
      link(t, true); link(o, true);
      around[x].push(t); around[m].push(o);
      // m's height over u-w (its distance off the plane of the triangle across) is how far the surface moved
      S.moved = Math.max(S.moved, hT);
      S.flips++;
      if (S.onChange) { S.onChange(t); S.onChange(o); }
      return true;
    };

    /* Edge p-r shrunk to the point p: r's triangles are p's, the two on the
       edge go. Only when the edge is interior and manifold, the LINK CONDITION
       holds (p and r have no common neighbour but the two apexes of the edge -
       else the collapse pinches the surface into a non-manifold edge), and
       none of r's triangles turns over or tilts by more than 60 degrees. */
    S.collapse = function (p, r) {
      if (count.get(ek(p, r)) !== 2) return false;
      var t1 = half.get(p * V + r), t2 = half.get(r * V + p);
      if (t1 == null || t2 == null || dead[t1] || dead[t2]) return false;
      var apex = new Set(), i;
      for (i = 0; i < 3; i++) {
        var a1 = tri[t1 * 3 + i], a2 = tri[t2 * 3 + i];
        if (a1 !== p && a1 !== r) apex.add(a1);
        if (a2 !== p && a2 !== r) apex.add(a2);
      }
      if (apex.size !== 2) return false;
      var rp = ringOf(p), rr = ringOf(r), bad = false, common = 0;
      rr.forEach(function (x) { if (rp.has(x)) { common++; if (!apex.has(x)) bad = true; } });
      if (bad || common !== 2) return false;
      var ts = trisOf(r), moving = [];
      for (i = 0; i < ts.length; i++) {
        var tt = ts[i];
        if (tt === t1 || tt === t2) continue;
        var vs = [tri[tt * 3], tri[tt * 3 + 1], tri[tt * 3 + 2]];
        var n0 = normalOf(pos, vs[0], vs[1], vs[2]);
        var ws = vs.map(function (v) { return v === r ? p : v; });
        var n1 = normalOf(pos, ws[0], ws[1], ws[2]);
        if (dot(n0, n1) <= 0.5 * Math.sqrt(dot(n0, n0) * dot(n1, n1))) return false;
        moving.push(tt);
      }
      link(t1, false); link(t2, false); dead[t1] = 1; dead[t2] = 1;
      for (i = 0; i < moving.length; i++) {
        var mt = moving[i];
        link(mt, false);
        for (var e = 0; e < 3; e++) if (tri[mt * 3 + e] === r) tri[mt * 3 + e] = p;
        link(mt, true);
        around[p].push(mt);
      }
      around[r] = [];
      S.moved = Math.max(S.moved, Math.sqrt(d2(pos, p, r)));
      S.collapses++;
      if (S.onChange) for (i = 0; i < moving.length; i++) S.onChange(moving[i]);
      return true;
    };

    /* Back to a plain mesh: dead triangles out, unused vertices out, the rest
       renumbered IN ORDER (so a vertex that was older than another still is). */
    S.result = function () {
      if (!S.flips && !S.collapses) return mesh;
      var used = new Uint8Array(V), nt = [], tt, kk;
      for (tt = 0; tt < T; tt++) if (!dead[tt]) for (kk = 0; kk < 3; kk++) used[tri[tt * 3 + kk]] = 1;
      var remap = new Int32Array(V).fill(-1), nv = 0, np = [];
      for (var v = 0; v < V; v++) if (used[v]) { remap[v] = nv++; np.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); }
      for (tt = 0; tt < T; tt++) if (!dead[tt]) for (kk = 0; kk < 3; kk++) nt.push(remap[tri[tt * 3 + kk]]);
      return { pos: new Float64Array(np), tri: new Int32Array(nt), vertCount: nv, triCount: (nt.length / 3) | 0 };
    };
    return S;
  }

  /* Flip, or collapse, the slivers of `mesh` away - those near enough to the
     zone to be cut (within `reach` plus their own length; anything further
     that the cutting still reaches is the weld-safe pass's). With no zone,
     every sliver. Returns { mesh, flips, collapses, moved }; the mesh is the
     input itself when nothing was done. `moved` is the furthest any surface
     point went. */
  function unsliver(mesh, hMax, eMax, zone, reach) {
    var none = { mesh: mesh, flips: 0, collapses: 0, moved: 0 };
    if (!(hMax > 0)) return none;
    var pos = mesh.pos, T = mesh.triCount, t, work = [];
    for (t = 0; t < T; t++) {
      var ia = mesh.tri[t * 3], ib = mesh.tri[t * 3 + 1], ic = mesh.tri[t * 3 + 2];
      if (!(lowAlt(pos, ia, ib, ic) < hMax)) continue;
      if (zone) {
        var near = reach + Math.sqrt(Math.max(d2(pos, ia, ib), d2(pos, ib, ic), d2(pos, ic, ia)));
        if (triDist2(pos, ia, ib, ic, zone.c) > near * near) continue;
      }
      work.push(t);
    }
    if (!work.length) return none;
    var S = surgery(mesh), tri = S.tri;
    S.onChange = function (tt) {
      if (!S.dead[tt] && lowAlt(pos, tri[tt * 3], tri[tt * 3 + 1], tri[tt * 3 + 2]) < hMax) work.push(tt);
    };
    var guard = work.length * 8 + 64, e2Max = eMax > 0 ? eMax * eMax : 0;
    while (work.length && guard-- > 0) {
      t = work.pop();
      if (S.dead[t]) continue;
      var a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
      if (!(lowAlt(pos, a, b, c) < hMax)) continue;
      var q0 = d2(pos, a, b), q1 = d2(pos, b, c), q2 = d2(pos, c, a);
      // the longest edge u->w, and m across it
      var u, w, m;
      if (q0 >= q1 && q0 >= q2) { u = a; w = b; m = c; }
      else if (q1 >= q2) { u = b; w = c; m = a; }
      else { u = c; w = a; m = b; }
      if (S.flip(t, u, w, m)) continue;
      // the shortest edge, if it is short enough to be a weld
      var s0, s1, qs;
      if (q0 <= q1 && q0 <= q2) { s0 = a; s1 = b; qs = q0; }
      else if (q1 <= q2) { s0 = b; s1 = c; qs = q1; }
      else { s0 = c; s1 = a; qs = q2; }
      if (!(qs <= e2Max)) continue;
      // keep the older vertex (the lower id) where it is
      if (!S.collapse(Math.min(s0, s1), Math.max(s0, s1))) S.collapse(Math.max(s0, s1), Math.min(s0, s1));
    }
    if (!S.flips && !S.collapses) return none;
    return { mesh: S.result(), flips: S.flips, collapses: S.collapses, moved: S.moved };
  }

  /* WELD-SAFE. Whatever is left: an edge this file made that is shorter than
     `minLen` (twice the weld tolerance) is collapsed into its older end. Two
     vertices that close are one vertex to every consumer that welds, and a
     weld that merges them without removing the two triangles between them is
     exactly the doubled edge this pass exists to prevent - so they are merged
     here, properly. It arises where no sliver is low enough to be flipped
     away first: a boolean's fan of spokes meeting at a far corner the zone
     reaches, 1.8e-4 rad apart, cut at the same distance from that corner.
     Only edges with at least one end at or past `firstNew` (a vertex the
     refinement made) are touched, and the surface moves by under `minLen`.
     Returns { mesh, collapses, moved, left } - `left` the short edges that
     could not be collapsed (the link condition, or a triangle turning over). */
  function weldSafe(mesh, minLen, firstNew) {
    var none = { mesh: mesh, collapses: 0, moved: 0, left: 0 };
    if (!(minLen > 0)) return none;
    var pos = mesh.pos, T = mesh.triCount, tri0 = mesh.tri, m2 = minLen * minLen, t, e, work = [];
    for (t = 0; t < T; t++) for (e = 0; e < 3; e++) {
      var u0 = tri0[t * 3 + e], w0 = tri0[t * 3 + (e + 1) % 3];
      if (u0 < w0 && w0 >= firstNew && d2(pos, u0, w0) < m2) work.push(u0, w0);
    }
    if (!work.length) return none;
    var S = surgery(mesh), left = 0;
    for (var i = 0; i < work.length; i += 2) {
      var p = work[i], r = work[i + 1];                    // p < r, r is new
      if (S.edgeCount(p, r) !== 2) continue;               // already gone with an earlier collapse
      if (!S.collapse(p, r) && !(p >= firstNew && S.collapse(r, p))) left++;
    }
    return { mesh: S.result(), collapses: S.collapses, moved: S.moved, left: left };
  }

  /* ----------------------------------------------------------- refine */

  function stillCoarse(mesh, zone, spacing, reach2) {
    var s2 = (spacing + FINE_SLACK) * (spacing + FINE_SLACK), tri = mesh.tri, pos = mesh.pos;
    for (var q = 0; q < mesh.triCount; q++) {
      var a = tri[q * 3], b = tri[q * 3 + 1], c = tri[q * 3 + 2];
      if ((d2(pos, a, b) > s2 || d2(pos, b, c) > s2 || d2(pos, c, a) > s2) &&
          triDist2(pos, a, b, c, zone.c) <= reach2) return true;
    }
    return false;
  }

  function refine(mesh, zone, opts) {
    opts = opts || {};
    var spacing = opts.spacing > 0 ? opts.spacing : DEFAULT_SPACING;
    var margin = opts.margin != null ? +opts.margin : spacing;
    var maxPasses = opts.maxPasses != null ? (opts.maxPasses | 0) : 24;
    var maxTris = opts.maxTris != null ? (opts.maxTris | 0) : 600000;
    var sliver = opts.sliver != null ? +opts.sliver : SLIVER_H;
    var out = { mesh: mesh, splits: 0, passes: 0, capped: false, spacing: spacing, zipped: 0,
                flips: 0, collapses: 0, moved: 0, closeLeft: 0 };
    if (!zone || !zone.c || !(zone.r > 0)) return out;
    var reach = zone.r + margin, reach2 = reach * reach;
    // 0. slivers flipped or collapsed away (kept only if something is then split, below)
    var sliverEdge = opts.sliverEdge != null ? +opts.sliverEdge : Math.min(SLIVER_E, 0.1 * spacing);
    var uns = unsliver(mesh, sliver, sliverEdge, zone, reach);
    var cur = uns.mesh, next, pass;

    // 1. needles zipped, once: only the part inside the zone is subdivided
    var zipped = zip(cur, zone, spacing, reach);
    if (zipped) {
      if (zipped.triCount > maxTris) out.capped = true;
      else { out.zipped = zipped.vertCount - cur.vertCount; out.splits += out.zipped; cur = zipped; }
    }
    // 2. whatever is still coarse, by longest-edge bisection
    for (pass = 0; !out.capped && pass < maxPasses; pass++) {
      next = bisect(cur, zone, spacing, reach2, spacing + FINE_SLACK, false);
      if (!next) break;
      if (next.triCount > maxTris) { out.capped = true; break; }
      out.splits += next.splits; out.passes = pass + 1; cur = next;
    }
    if (!out.capped && pass === maxPasses) out.capped = stillCoarse(cur, zone, spacing, reach2);
    // 3. no two vertices this made closer than a weld would keep apart
    var safe = { collapses: 0, moved: 0, left: 0 };
    if (out.splits > 0) {
      var minLen = opts.weldSafe != null ? +opts.weldSafe : 2 * (opts.weld > 0 ? opts.weld : 1e-4);
      for (var round = 0; round < 4; round++) {
        var ws = weldSafe(cur, minLen, uns.mesh.vertCount);
        cur = ws.mesh; safe.collapses += ws.collapses; safe.moved = Math.max(safe.moved, ws.moved); safe.left = ws.left;
        if (!ws.collapses) break;
      }
    }
    // A zone with nothing to split hands back the mesh it was given, flips and
    // all undone: "unchanged" means unchanged.
    if (out.splits > 0) {
      out.mesh = cur; out.flips = uns.flips; out.collapses = uns.collapses + safe.collapses;
      out.moved = Math.max(uns.moved, safe.moved); out.closeLeft = safe.left;
    }
    return out;
  }

  /* ----------------------------------------------------------- region */

  function region(rawTris, zone, opts) {
    opts = opts || {};
    var res = { ok: false, reason: '', mesh: null, soup: rawTris, changed: false, report: null };
    if (!rawTris || rawTris.length < 9) { res.reason = 'empty soup'; return res; }
    if (!zone || !zone.c || !(zone.r > 0)) { res.reason = 'no zone'; return res; }
    var base = weld(rawTris, opts.weld);
    if (!base.triCount) { res.reason = 'nothing left after welding'; return res; }
    var ref = refine(base, zone, opts);
    res.ok = true;
    res.mesh = ref.mesh;
    res.changed = ref.splits > 0;
    res.soup = res.changed ? toSoup(ref.mesh) : rawTris;
    res.report = {
      spacing: ref.spacing, splits: ref.splits, passes: ref.passes, capped: ref.capped,
      trisBefore: (rawTris.length / 9) | 0, trisAfter: ref.mesh.triCount,
      zone: { c: zone.c.slice(), r: zone.r },
      slivers: ref.flips + ref.collapses, moved: ref.moved
    };
    return res;
  }

  /* The one phrase a status line carries. */
  function say(report) {
    if (!report) return '';
    var sp = (Math.round(report.spacing * 1000) / 1000) + ' mm';
    if (!report.splits) return 'already ' + sp + ' fine here';
    return 'densified to ' + sp + ' spacing (' + report.trisBefore + '→' + report.trisAfter +
           ' triangles)' + (report.capped ? ', stopped at the triangle budget' : '');
  }

  var API = {
    DEFAULT_SPACING: DEFAULT_SPACING,
    weld: weld, toSoup: toSoup, refine: refine, region: region,
    triDist2: triDist2, say: say,
    _unsliver: unsliver           // internal: the sliver pre-pass on its own, for tests
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Densify = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
