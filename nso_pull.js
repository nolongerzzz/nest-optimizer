/* nso_pull.js - Pull: grab a spot on a piece and drag it, the surface around
   the grab following with a soft falloff.

   Loads as a classic script (window.NSO_Pull) and as a Node module. No DOM, no
   THREE, no app state - tools/nso_pull_test.js drives it headless, and
   app-pull.js is the pointer session on top of it. See docs/PULL.md.

   THE FIELD. A pull has a GRAB (a point on the surface, a radius, a
   displacement D) and any number of PINS (a point and a radius each, which
   hold the surface still). Every vertex within the grab's radius moves by

       D * phi(v)        phi = g(v) * s(v)

   g is the grab's own falloff, the smooth bell: 1 at the centre, 0 at the
   radius, flat at both ends (bell(t) = t*t*(3 - 2t), t = 1 - d/r). s is what the
   pins leave of it. A pin holds by ITS OWN bell - 1 at the pin, 0 at the pin's
   radius - weighted by how much nearer it is than the grab:

       s = product over pins of ( 1 - bell_pin(v) * q_pin(v) )
       q_pin = w_pin / (w_pin + w_grab),   w_h = 1 / (d_h^4 + eps^4)

   so the NEAREST HANDLE WINS where radii overlap, and wins smoothly: at a pin's
   own vertex q = 1 and the bell is 1, so the vertex does not move; at the
   grab's own vertex q = 0, so the grab follows the cursor exactly even with a
   pin's radius over it; in between the two blend with no step at the border
   where "nearest" changes hands, which a hard winner-takes-all would leave as
   a cliff in the surface. phi depends only on where the vertices were and
   where the handles are, never on D - so it is worked out once, and every
   mouse move after that is `base + D * phi`.

   THE GRAB AND THE PINS SNAP to the nearest vertex of the densified mesh (the
   grab always; a pin when one is within a spacing and a bit), so "the lip moved
   6 mm at the grab" and "the pinned vertex did not move" are statements about a
   vertex, not about a point that sits inside a triangle.

   DENSIFY FIRST. A coarse mesh has no vertex to take a curve (nso_densify.js).
   prepare() subdivides the triangles inside the grab's radius to 0.5 mm, once,
   and reports what it did; a region that is already fine is left alone.

   THE GUARDS, at release, on the result and never the preview:
     WALL     a wall that would go under two nozzle widths (0.8 mm at 0.4),
              measured the way Carve measures it - NSO_Thickness.prepare() on
              the result, wallAt() along each station's own inward normal - at a
              station on every moved vertex (~0.5 mm apart, since that is the
              spacing; a very large region is sampled every k-th vertex and
              says so).
     SELF-INTERSECTION  the canonical count (NSO_Repair) over the triangles the
              move could reach, before and after on the SAME triangulation. The
              baseline is the densified mesh, not the original: densify changes
              no surface, so any count it carries is the checker's float32
              noise on a thin slanted ladder and not the pull's doing, and a
              pull must not be refused for it nor be blamed for it.
     COLLAPSE a triangle that goes to zero area is a fold; refused as one.
   A refused pull returns the words and no triangles.

   WHAT A PULL DOES TO A WALL. By default (the SECTION RULE, findPartners below)
   each wall vertex is paired with the point straight through the wall from it
   and takes the displacement of their mid-point, so both skins move by the same
   vector and the wall never gets thicker; carried sideways across a slope it is
   still thinner measured square to its new surface, by cos(slope), slope up to
   1.5 |D| / r: 1.57 mm of a 1.6 mm wall at 50 mm radius, 1.39 at 12. With
   `sideOnly` the falloff is measured along the surface and only the skin under
   the grab moves. `section: false` is the plain rule - each vertex by its own
   distance - kept for the headless checks. docs/PULL.md has the numbers.

     NSO_Pull.prepare(rawTris, grab, pins, opts) -> S      (S.ok false = refused)
       grab { c:[x,y,z], r }       pins [{ c, r }]
       opts { spacing = 0.5, maxTris, nozzle = 0.4, sideOnly = false, section = true }
     NSO_Pull.displace(S, D)       fills S.pos: base + D * phi, over S.zone
     NSO_Pull.finish(S, D, opts)   the guards -> { ok, reason, tris, report }
     NSO_Pull.pull(rawTris, spec)  all three, for a headless caller
     NSO_Pull.bell(d, r)  NSO_Pull.phiAt(grab, pins, p)
*/
(function (root) {
  'use strict';

  var Densify = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./nso_densify.js') : root.NSO_Densify;

  var SPACING = 0.5;           // mm, the densify target
  var NOZZLE = 0.4;            // mm, the one nozzle this app quotes
  var FLOOR_NOZZLES = 2;       // a wall under this many nozzle widths is refused
  var EPS4 = Math.pow(0.05, 4);
  var MAX_STATIONS = 24000;    // wall stations before sampling every k-th
  var SNAP_PIN = 1.2 * SPACING;
  var PARTNER_MAX = 6;         // mm: a surface deeper than this behind a vertex is a solid, not its wall's other skin
  var PARTNER_RATIO = 2;       // ... and the hit must be within this many x the local wall thickness
  var PARTNER_ANTI = -0.8;     // ... and face back at the vertex (cos of the angle between the two normals)
  var OFFSET_RINGS = 12;       // rings the mid-point offset is carried past the last partnered vertex ...
  var OFFSET_FADE = 0.85;      // ... and the factor it fades by at each
  var CREASE_DEG = 60;         // "this side only" never crosses an edge sharper than this

  function round3(v) { return Math.round(v * 1000) / 1000; }

  /* ----------------------------------------------------------- the field */

  /* 1 at the centre, 0 at the radius and beyond, flat at both ends. */
  function bell(d, r) {
    if (!(r > 0)) return 0;
    var t = 1 - d / r;
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - 2 * t);
  }

  /* phi from distances already measured: dg to the grab, dps[i] to pin i. The
     distances are Euclidean in space for a plain pull, from a wall's mid-surface
     for a section pull, along the surface for "This side only". */
  function phiD(dg, rg, dps, rps) {
    var g = bell(dg, rg);
    if (!(g > 0)) return 0;
    if (!dps || !dps.length) return g;
    var wg = 1 / (dg * dg * dg * dg + EPS4), s = 1;
    for (var i = 0; i < dps.length; i++) {
      var b = bell(dps[i], rps[i]);
      if (!(b > 0)) continue;
      var d2 = dps[i] * dps[i];
      var wp = 1 / (d2 * d2 + EPS4);
      s *= 1 - b * (wp / (wp + wg));
    }
    return g * s;
  }

  /* The fraction of the grab's displacement point p gets, by straight distance. */
  function phiAt(grab, pins, p) {
    var dg = Math.sqrt(sq(p, grab.c)), dps = [], rps = [];
    for (var i = 0; i < (pins ? pins.length : 0); i++) { dps.push(Math.sqrt(sq(p, pins[i].c))); rps.push(pins[i].r); }
    return phiD(dg, grab.r, dps, rps);
  }
  function sq(a, b) { var x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return x * x + y * y + z * z; }

  /* ---------------------------------------------------------------- prepare */

  function nearestVertex(pos, V, c) {
    var best = -1, bd = Infinity;
    for (var v = 0; v < V; v++) {
      var dx = pos[v * 3] - c[0], dy = pos[v * 3 + 1] - c[1], dz = pos[v * 3 + 2] - c[2];
      var d = dx * dx + dy * dy + dz * dz;
      if (d < bd) { bd = d; best = v; }
    }
    return { v: best, d: Math.sqrt(bd) };
  }

  /* ---------------------------------------------- a wall's mid-surface */

  /* THE SECTION RULE. A vertex on one skin of a wall and the point straight
     through the wall from it are two ends of one section; their falloff
     distance is measured from the MID-POINT, so both get the same displacement
     and the wall moves as one section instead of its two skins being carried by
     different amounts. The partner is the first surface met along the vertex's
     inward normal, if it is within PARTNER_MAX (a deeper one is a solid, not a
     wall), within PARTNER_RATIO x the local wall thickness (the thinnest such
     hit in the vertex's one-ring - a hit much longer than its neighbours' is a
     ray that slid out of a corner, not the far skin), and faces back at the
     vertex. A vertex with no partner - an open edge, a solid, a rim corner -
     keeps its own position: the plain rule.

     findPartners() returns, for each vertex asked: has[], and anchor[] (the
     mid-point). The ray cast is its own: a uniform grid over the triangles
     near the grab, because NSO_Thickness.wallAt() looks the nearest face up
     first and 70,000 of those is twenty seconds on a 50 mm radius. */
  function findPartners(S, cands, centre, reach) {
    var mesh = S.mesh, pos = S.basePos, tri = mesh.tri, V = mesh.vertCount;
    var n = cands.length;
    var out = { has: new Uint8Array(n), anchor: new Float64Array(n * 3), t: new Float64Array(n) };
    var norms = vertexNormals(S, pos, cands);
    // grid over the triangles within `reach` of the grab
    var CELL = 1.0, inv = 1 / CELL, grid = new Map(), r2 = reach * reach, T = mesh.triCount;
    var tn = new Float64Array(T * 3), keep = [];
    function key(i, j, k) { return ((i + 4096) * 8192 + (j + 4096)) * 8192 + (k + 4096); }
    for (var t = 0; t < T; t++) {
      var ia = tri[t * 3] * 3, ib = tri[t * 3 + 1] * 3, ic = tri[t * 3 + 2] * 3;
      var near = false;
      for (var q = 0; q < 3 && !near; q++) {
        var io = tri[t * 3 + q] * 3;
        var dx = pos[io] - centre[0], dy = pos[io + 1] - centre[1], dz = pos[io + 2] - centre[2];
        if (dx * dx + dy * dy + dz * dz <= r2) near = true;
      }
      if (!near) continue;
      var ux = pos[ib] - pos[ia], uy = pos[ib + 1] - pos[ia + 1], uz = pos[ib + 2] - pos[ia + 2];
      var wx = pos[ic] - pos[ia], wy = pos[ic + 1] - pos[ia + 1], wz = pos[ic + 2] - pos[ia + 2];
      var cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx, L = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (!(L > 0)) continue;
      tn[t * 3] = cx / L; tn[t * 3 + 1] = cy / L; tn[t * 3 + 2] = cz / L;
      keep.push(t);
      var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (var m = 0; m < 3; m++) {
        var o3 = tri[t * 3 + m] * 3;
        for (var a = 0; a < 3; a++) { if (pos[o3 + a] < lo[a]) lo[a] = pos[o3 + a]; if (pos[o3 + a] > hi[a]) hi[a] = pos[o3 + a]; }
      }
      for (var i = Math.floor(lo[0] * inv); i <= Math.floor(hi[0] * inv); i++)
        for (var j = Math.floor(lo[1] * inv); j <= Math.floor(hi[1] * inv); j++)
          for (var k = Math.floor(lo[2] * inv); k <= Math.floor(hi[2] * inv); k++) {
            var kk = key(i, j, k), b2 = grid.get(kk);
            if (b2) b2.push(t); else grid.set(kk, [t]);
          }
    }
    var stamp = new Int32Array(T), rayId = 0;
    var rawT = new Float64Array(V).fill(Infinity), rawOK = new Uint8Array(V);
    for (var c = 0; c < n; c++) {
      var v = cands[c], o = v * 3;
      var nx = norms[c * 3], ny = norms[c * 3 + 1], nz = norms[c * 3 + 2];
      if (!nx && !ny && !nz) continue;
      var dir = [-nx, -ny, -nz], org = [pos[o], pos[o + 1], pos[o + 2]];
      rayId++;
      var ci = [Math.floor(org[0] * inv), Math.floor(org[1] * inv), Math.floor(org[2] * inv)];
      var step = [0, 0, 0], tMax = [Infinity, Infinity, Infinity], tDelta = [Infinity, Infinity, Infinity];
      for (var ax = 0; ax < 3; ax++) {
        if (dir[ax] > 1e-12) { step[ax] = 1; tMax[ax] = ((ci[ax] + 1) * CELL - org[ax]) / dir[ax]; tDelta[ax] = CELL / dir[ax]; }
        else if (dir[ax] < -1e-12) { step[ax] = -1; tMax[ax] = (ci[ax] * CELL - org[ax]) / dir[ax]; tDelta[ax] = -CELL / dir[ax]; }
      }
      var best = Infinity, bestT = -1, entry = 0;
      while (entry <= Math.min(best, PARTNER_MAX)) {
        var bucket = grid.get(key(ci[0], ci[1], ci[2]));
        if (bucket) {
          for (var bi = 0; bi < bucket.length; bi++) {
            var tt = bucket[bi];
            if (stamp[tt] === rayId) continue;
            stamp[tt] = rayId;
            if (tri[tt * 3] === v || tri[tt * 3 + 1] === v || tri[tt * 3 + 2] === v) continue;
            // Moller-Trumbore, both sides
            var a0 = tri[tt * 3] * 3, a1 = tri[tt * 3 + 1] * 3, a2 = tri[tt * 3 + 2] * 3;
            var e1x = pos[a1] - pos[a0], e1y = pos[a1 + 1] - pos[a0 + 1], e1z = pos[a1 + 2] - pos[a0 + 2];
            var e2x = pos[a2] - pos[a0], e2y = pos[a2 + 1] - pos[a0 + 1], e2z = pos[a2 + 2] - pos[a0 + 2];
            var px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
            var det = e1x * px + e1y * py + e1z * pz;
            if (Math.abs(det) < 1e-14) continue;
            var id = 1 / det, sx = org[0] - pos[a0], sy = org[1] - pos[a0 + 1], sz = org[2] - pos[a0 + 2];
            var uu = (sx * px + sy * py + sz * pz) * id;
            if (uu < -1e-9 || uu > 1 + 1e-9) continue;
            var qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
            var vv = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * id;
            if (vv < -1e-9 || uu + vv > 1 + 1e-9) continue;
            var th = (e2x * qx + e2y * qy + e2z * qz) * id;
            if (th > 1e-6 && th < best) { best = th; bestT = tt; }
          }
        }
        var kx = (tMax[0] < tMax[1]) ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
        if (!isFinite(tMax[kx])) break;
        entry = tMax[kx]; ci[kx] += step[kx]; tMax[kx] += tDelta[kx];
      }
      if (bestT < 0 || best > PARTNER_MAX) continue;
      // the far surface must face back at the vertex
      var facing = tn[bestT * 3] * nx + tn[bestT * 3 + 1] * ny + tn[bestT * 3 + 2] * nz;
      if (facing > PARTNER_ANTI) continue;
      rawT[v] = best; rawOK[v] = 1;
      out.t[c] = best;
    }
    // local thickness: the thinnest hit in the vertex's one-ring (and its own)
    for (var c2 = 0; c2 < n; c2++) {
      var v2 = cands[c2];
      if (!rawOK[v2]) continue;
      var loc = rawT[v2];
      for (var j2 = S.vtStart[v2]; j2 < S.vtStart[v2 + 1]; j2++) {
        var t2 = S.vtList[j2];
        for (var m2 = 0; m2 < 3; m2++) { var u2 = tri[t2 * 3 + m2]; if (rawOK[u2] && rawT[u2] < loc) loc = rawT[u2]; }
      }
      if (rawT[v2] > PARTNER_RATIO * loc) continue;
      out.has[c2] = 1;
      var o2 = v2 * 3, h = rawT[v2] / 2;
      out.anchor[c2 * 3] = pos[o2] - norms[c2 * 3] * h;
      out.anchor[c2 * 3 + 1] = pos[o2 + 1] - norms[c2 * 3 + 1] * h;
      out.anchor[c2 * 3 + 2] = pos[o2 + 2] - norms[c2 * 3 + 2] * h;
    }
    return out;
  }

  /* ---------------------------------------------- "this side only" */

  /* Distance ALONG THE SURFACE from vertex `src`, to every vertex within
     `radius` of it, by Dijkstra over the mesh's edges - and never across a
     crease (two faces more than CREASE_DEG apart), so the walk stays on the
     skin it started on: a bore does not reach the outside by way of the rim. */
  function geodesic(S, src, radius) {
    var tri = S.mesh.tri, pos = S.basePos, cosC = Math.cos(CREASE_DEG * Math.PI / 180);
    var tnCache = new Map();
    function tnorm(t) {
      var c = tnCache.get(t);
      if (c) return c;
      var a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, cc = tri[t * 3 + 2] * 3;
      var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      var vx = pos[cc] - pos[a], vy = pos[cc + 1] - pos[a + 1], vz = pos[cc + 2] - pos[a + 2];
      var x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, L = Math.sqrt(x * x + y * y + z * z) || 1;
      c = [x / L, y / L, z / L]; tnCache.set(t, c); return c;
    }
    var dist = new Map(), heap = [];
    function push(d, v) {
      heap.push([d, v]);
      var i = heap.length - 1;
      while (i > 0) { var p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; var tmp = heap[p]; heap[p] = heap[i]; heap[i] = tmp; i = p; }
    }
    function pop() {
      var top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last; var i = 0;
        for (;;) {
          var l = 2 * i + 1, r = l + 1, m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          var tmp = heap[m]; heap[m] = heap[i]; heap[i] = tmp; i = m;
        }
      }
      return top;
    }
    dist.set(src, 0); push(0, src);
    var done = new Set();
    while (heap.length) {
      var top = pop(), d = top[0], v = top[1];
      if (done.has(v)) continue;
      done.add(v);
      /* A vertex ON a crease (a rim: it belongs to the skin behind the grab and
         to the face over the edge) is reached but not walked on from: crossing
         the crease through its corner would be the one way over it that the
         edges do not forbid. */
      var steps = [], onCrease = false;
      for (var j = S.vtStart[v]; j < S.vtStart[v + 1]; j++) {
        var t = S.vtList[j];
        for (var m = 0; m < 3; m++) {
          var u = tri[t * 3 + m];
          if (u === v) continue;
          // the other triangle on edge v-u, if any: is the edge a crease?
          var crease = false;
          for (var j2 = S.vtStart[v]; j2 < S.vtStart[v + 1] && !crease; j2++) {
            var t2 = S.vtList[j2];
            if (t2 === t) continue;
            if (tri[t2 * 3] !== u && tri[t2 * 3 + 1] !== u && tri[t2 * 3 + 2] !== u) continue;
            var n1 = tnorm(t), n2 = tnorm(t2);
            if (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] < cosC) crease = true;
          }
          if (crease) { onCrease = true; continue; }
          steps.push(u);
        }
      }
      if (onCrease && v !== src) continue;
      for (var si = 0; si < steps.length; si++) {
        var u2 = steps[si];
        var dx = pos[u2 * 3] - pos[v * 3], dy = pos[u2 * 3 + 1] - pos[v * 3 + 1], dz = pos[u2 * 3 + 2] - pos[v * 3 + 2];
        var nd = d + Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (nd >= radius) continue;
        var old = dist.get(u2);
        if (old === undefined || nd < old) { dist.set(u2, nd); push(nd, u2); }
      }
    }
    return dist;
  }

  /* WHERE THE SECTION RULE STOPS. At a wall's rim (and at any open edge) the
     vertices on one side have a partner and their neighbours do not, and if the
     neighbours simply fell back to their own position the two would be
     measured from points up to half a wall apart: a step in the displacement
     of 0.1 mm per 0.3 mm of surface, which on a 1.6 mm lip left 0.46 mm of wall
     at the rim. So the offset (mid-point minus vertex) is carried outward from
     the partnered vertices ring by ring, fading by OFFSET_FADE each ring for
     OFFSET_RINGS rings: the plain rule is reached by a slope, not a step. A
     solid, with no partnered vertex near it, never gets an offset at all. */
  function extendOffsets(S, cands, off, st) {
    var tri = S.mesh.tri, inCand = new Uint8Array(S.mesh.vertCount);
    for (var i = 0; i < cands.length; i++) inCand[cands[i]] = 1;
    var frontier = [];
    for (i = 0; i < cands.length; i++) if (st[cands[i]] === 2) frontier.push(cands[i]);
    var fade = 1;
    for (var ring = 0; ring < OFFSET_RINGS && frontier.length; ring++) {
      fade *= OFFSET_FADE;
      var next = [], seen = new Map();
      for (var q = 0; q < frontier.length; q++) {
        var v = frontier[q];
        for (var j = S.vtStart[v]; j < S.vtStart[v + 1]; j++) {
          var t = S.vtList[j];
          for (var m = 0; m < 3; m++) {
            var u = tri[t * 3 + m];
            if (!inCand[u] || st[u]) continue;
            var a = seen.get(u);
            if (!a) { a = [0, 0, 0, 0]; seen.set(u, a); next.push(u); }
            a[0] += off[v * 3]; a[1] += off[v * 3 + 1]; a[2] += off[v * 3 + 2]; a[3]++;
          }
        }
      }
      // set after the sweep so one ring does not feed the next within a round
      for (q = 0; q < next.length; q++) {
        var w = next[q], aa = seen.get(w);
        off[w * 3] = aa[0] / aa[3] * OFFSET_FADE; off[w * 3 + 1] = aa[1] / aa[3] * OFFSET_FADE; off[w * 3 + 2] = aa[2] / aa[3] * OFFSET_FADE;
        st[w] = 1;
      }
      frontier = next;
    }
  }

  function prepare(rawTris, grab, pins, opts) {
    opts = opts || {};
    var out = { ok: false, reason: '' };
    if (!Densify) { out.reason = 'nso_densify.js is not loaded'; return out; }
    if (!rawTris || rawTris.length < 9) { out.reason = 'empty piece'; return out; }
    if (!grab || !grab.c || !(grab.r > 0)) { out.reason = 'no grab point'; return out; }
    pins = pins || [];

    var spacing = opts.spacing > 0 ? opts.spacing : SPACING;
    var reg = Densify.region(rawTris, { c: grab.c, r: grab.r }, {
      spacing: spacing, maxTris: opts.maxTris, margin: opts.margin
    });
    if (!reg.ok) { out.reason = reg.reason; return out; }
    var mesh = reg.mesh, V = mesh.vertCount;
    var basePos = new Float64Array(mesh.pos);

    // Vertex -> triangles, so a live preview rewrites only what moved.
    var T = mesh.triCount, tri = mesh.tri;
    var vdeg = new Int32Array(V + 1), t, k, v;
    for (t = 0; t < T * 3; t++) vdeg[tri[t] + 1]++;
    for (v = 0; v < V; v++) vdeg[v + 1] += vdeg[v];
    var vtList = new Int32Array(T * 3), fill = new Int32Array(V);
    for (t = 0; t < T; t++) {
      for (k = 0; k < 3; k++) { var vv = tri[t * 3 + k]; vtList[vdeg[vv] + fill[vv]++] = t; }
    }
    var S = {
      ok: true, reason: '',
      mesh: mesh, basePos: basePos, pos: new Float64Array(basePos),
      vtStart: vdeg, vtList: vtList,
      densify: reg.report, changed: reg.changed,
      origTris: rawTris, spacing: spacing,
      nozzle: opts.nozzle > 0 ? opts.nozzle : NOZZLE
    };
    S.mode = opts.sideOnly ? 'side' : (opts.section === false ? 'space' : 'section');

    // The handles snap to a vertex of the mesh they act on.
    var ng = nearestVertex(basePos, V, grab.c);
    var g = { c: [basePos[ng.v * 3], basePos[ng.v * 3 + 1], basePos[ng.v * 3 + 2]], r: grab.r, v: ng.v, at: grab.c.slice() };
    var ps = [];
    for (var i = 0; i < pins.length; i++) {
      var np = nearestVertex(basePos, V, pins[i].c);
      var snapped = np.d <= SNAP_PIN * 1.0 + 1e-9;
      ps.push({
        c: snapped ? [basePos[np.v * 3], basePos[np.v * 3 + 1], basePos[np.v * 3 + 2]] : pins[i].c.slice(),
        r: pins[i].r, v: snapped ? np.v : -1, at: pins[i].c.slice()
      });
    }
    S.grab = g; S.pins = ps;

    var zone = [], phiList = [], moved = [], partnered = 0;
    var rg = g.r;
    if (S.mode === 'side') {
      /* Only the skin under the grab: every distance is along the surface. */
      var dg = geodesic(S, g.v, rg);
      var pd = ps.map(function (pn) { return pn.v >= 0 ? geodesic(S, pn.v, pn.r) : null; });
      dg.forEach(function (d, vtx) {
        var dps = [], rps = [];
        for (var q = 0; q < ps.length; q++) {
          if (!pd[q]) continue;
          var dq = pd[q].get(vtx);
          dps.push(dq === undefined ? Infinity : dq); rps.push(ps[q].r);
        }
        var f = phiD(d, rg, dps, rps);
        zone.push(vtx); phiList.push(f);
        if (f > 0) moved.push(vtx);
      });
    } else {
      var cands = [], r2 = Math.pow(rg + (S.mode === 'section' ? PARTNER_MAX / 2 : 0), 2);
      var want = new Set();
      for (v = 0; v < V; v++) {
        var dx = basePos[v * 3] - g.c[0], dy = basePos[v * 3 + 1] - g.c[1], dz = basePos[v * 3 + 2] - g.c[2];
        if (dx * dx + dy * dy + dz * dz < r2) { cands.push(v); want.add(v); }
      }
      ps.forEach(function (pn) { if (pn.v >= 0 && !want.has(pn.v)) { cands.push(pn.v); want.add(pn.v); } });
      var off = null, st = null;
      if (S.mode === 'section') {
        var cArr = Int32Array.from(cands);
        var pt = findPartners(S, cArr, g.c, rg + PARTNER_MAX + 1);
        off = new Float64Array(V * 3); st = new Uint8Array(V);
        for (var c0 = 0; c0 < cArr.length; c0++) {
          if (!pt.has[c0]) continue;
          var w0 = cArr[c0];
          st[w0] = 2;
          off[w0 * 3] = pt.anchor[c0 * 3] - basePos[w0 * 3];
          off[w0 * 3 + 1] = pt.anchor[c0 * 3 + 1] - basePos[w0 * 3 + 1];
          off[w0 * 3 + 2] = pt.anchor[c0 * 3 + 2] - basePos[w0 * 3 + 2];
        }
        extendOffsets(S, cArr, off, st);
        // A handle on a wall is centred on the wall's MID-POINT, so both skins
        // at the grab (or at the pin) share the handle's full effect.
        var shift = function (h) {
          if (h.v < 0 || !st[h.v]) return;
          h.c = [basePos[h.v * 3] + off[h.v * 3], basePos[h.v * 3 + 1] + off[h.v * 3 + 1], basePos[h.v * 3 + 2] + off[h.v * 3 + 2]];
        };
        shift(g); ps.forEach(shift);
      }
      var pnt = [0, 0, 0];
      for (var ci = 0; ci < cands.length; ci++) {
        v = cands[ci];
        if (st && st[v]) {
          pnt[0] = basePos[v * 3] + off[v * 3]; pnt[1] = basePos[v * 3 + 1] + off[v * 3 + 1]; pnt[2] = basePos[v * 3 + 2] + off[v * 3 + 2];
          if (st[v] === 2) partnered++;
        } else { pnt[0] = basePos[v * 3]; pnt[1] = basePos[v * 3 + 1]; pnt[2] = basePos[v * 3 + 2]; }
        if (sq(pnt, g.c) >= rg * rg) continue;
        var f2 = phiAt(g, ps, pnt);
        zone.push(v); phiList.push(f2);
        if (f2 > 0) moved.push(v);
      }
    }
    S.zone = new Int32Array(zone); S.phi = new Float64Array(phiList); S.moved = new Int32Array(moved);
    S.partnered = partnered;
    return S;
  }

  /* ---------------------------------------------------------------- displace */

  function displace(S, D) {
    var pos = S.pos, base = S.basePos, zone = S.zone, phi = S.phi;
    for (var i = 0; i < zone.length; i++) {
      var v = zone[i], o = v * 3, f = phi[i];
      pos[o] = base[o] + D[0] * f;
      pos[o + 1] = base[o + 1] + D[1] * f;
      pos[o + 2] = base[o + 2] + D[2] * f;
    }
    S.D = [D[0], D[1], D[2]];
    return S.zone;
  }

  /* ------------------------------------------------------------------ guards */

  function vertexNormals(S, pos, verts) {
    var tri = S.mesh.tri, out = new Float64Array(verts.length * 3);
    for (var q = 0; q < verts.length; q++) {
      var v = verts[q], nx = 0, ny = 0, nz = 0;
      for (var j = S.vtStart[v]; j < S.vtStart[v + 1]; j++) {
        var t = S.vtList[j] * 3;
        var a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
        var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        var wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
        nx += uy * wz - uz * wy; ny += uz * wx - ux * wz; nz += ux * wy - uy * wx;
      }
      var L = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (L > 1e-300) { out[q * 3] = nx / L; out[q * 3 + 1] = ny / L; out[q * 3 + 2] = nz / L; }
    }
    return out;
  }

  /* WALL. Returns { ok, thinnest, at, stations, every, reason }. */
  function wallGuard(S, outTris, opts) {
    var TH = opts.thickness || (typeof require === 'function' && typeof module !== 'undefined'
      ? require('./nso_thickness.js') : root.NSO_Thickness);
    var nozzle = S.nozzle, floor = (opts.minWall > 0) ? opts.minWall : FLOOR_NOZZLES * nozzle;
    var res = { ok: true, floor: floor, nozzle: nozzle, thinnest: null, at: null, stations: 0, every: 1, reason: '' };
    if (!TH || typeof TH.prepare !== 'function') {
      res.skipped = true; res.reason = 'wall check unavailable - nso_thickness.js is not loaded';
      return res;
    }
    var P = TH.prepare(outTris, { nozzle: nozzle, minWall: floor });
    if (!P) { res.skipped = true; res.reason = 'nothing to measure'; return res; }
    var verts = S.moved, n = verts.length;
    var every = Math.max(1, Math.ceil(n / (opts.maxStations || MAX_STATIONS)));
    var list = [];
    for (var i = 0; i < n; i += every) list.push(verts[i]);
    var norms = vertexNormals(S, S.pos, list);
    var probe = floor + 1;
    var thinnest = Infinity, at = null, measured = 0;
    for (var q = 0; q < list.length; q++) {
      var v = list[q], o = v * 3;
      var pt = [S.pos[o], S.pos[o + 1], S.pos[o + 2]];
      var nrm = [norms[q * 3], norms[q * 3 + 1], norms[q * 3 + 2]];
      if (!nrm[0] && !nrm[1] && !nrm[2]) continue;
      var w = P.wallAt(pt, { normal: nrm, probe: probe });
      if (!w.measured) continue;
      measured++;
      if (w.mm < thinnest) { thinnest = w.mm; at = pt; }
    }
    res.stations = list.length; res.measured = measured; res.every = every;
    if (measured) { res.thinnest = thinnest; res.at = at; }
    if (measured && thinnest < floor - 1e-4) {
      res.ok = false;
      res.reason = 'it would leave ' + round3(thinnest) + ' mm of wall near (' +
        at.map(function (x) { return round3(x); }).join(', ') + '), under the ' + round3(floor) +
        ' mm floor (two ' + round3(nozzle) + ' mm nozzle widths)';
    }
    return res;
  }

  /* The triangles the move could reach: any with a vertex within r + |D| + 1
     of the grab. A pierce needs a moved triangle on one side, and a moved
     triangle started inside r, so nothing outside that sphere can be involved
     in a NEW one. */
  function reachTriangles(S, D) {
    var reach = S.grab.r + Math.sqrt(D[0] * D[0] + D[1] * D[1] + D[2] * D[2]) + 1, r2 = reach * reach;
    var tri = S.mesh.tri, T = S.mesh.triCount, c = S.grab.c, bp = S.basePos, sel = [];
    for (var t = 0; t < T; t++) {
      for (var k = 0; k < 3; k++) {
        var o = tri[t * 3 + k] * 3;
        var dx = bp[o] - c[0], dy = bp[o + 1] - c[1], dz = bp[o + 2] - c[2];
        if (dx * dx + dy * dy + dz * dz <= r2) { sel.push(tri[t * 3], tri[t * 3 + 1], tri[t * 3 + 2]); break; }
      }
    }
    return new Int32Array(sel);
  }

  function f32(pos) {
    var o = new Float64Array(pos.length);
    for (var i = 0; i < pos.length; i++) o[i] = Math.fround(pos[i]);
    return o;
  }

  /* SELF-INTERSECTION. Same triangles, base positions against moved ones, both
     rounded to float32 because that is what the soup the checker will see
     carries. */
  function pierceGuard(S, D, opts) {
    var R = opts.repair || root.NSO_Repair;
    if (!R || typeof R._selfIntersectionDetail !== 'function') {
      return { ok: false, unavailable: true,
               reason: 'the canonical self-intersection checker (NSO_Repair) is not loaded' };
    }
    var faces = reachTriangles(S, D);
    var before = R._selfIntersectionDetail({ pos: f32(S.basePos), faces: faces }).pierce;
    var after = R._selfIntersectionDetail({ pos: f32(S.pos), faces: faces }).pierce;
    var res = { ok: after <= before, before: before, after: after, triangles: faces.length / 3 };
    if (!res.ok) {
      res.reason = 'the moved surface would pass through itself (' + after + ' self-intersecting pair' +
        (after === 1 ? '' : 's') + ' where it had ' + before + ')';
    }
    return res;
  }

  function areaOf(pos, tri, t) {
    var a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
    var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    var wx = pos[c] - pos[a], wy = pos[c + 1] - pos[a + 1], wz = pos[c + 2] - pos[a + 2];
    var nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    return Math.sqrt(nx * nx + ny * ny + nz * nz) * 0.5;
  }

  /* COLLAPSE. Triangles touching a moved vertex that are, or have become,
     zero-area. The count may not rise. */
  function collapseGuard(S) {
    var seen = new Uint8Array(S.mesh.triCount), tri = S.mesh.tri;
    var before = 0, after = 0;
    for (var q = 0; q < S.moved.length; q++) {
      var v = S.moved[q];
      for (var j = S.vtStart[v]; j < S.vtStart[v + 1]; j++) {
        var t = S.vtList[j];
        if (seen[t]) continue;
        seen[t] = 1;
        if (areaOf(S.basePos, tri, t) <= 1e-12) before++;
        if (areaOf(S.pos, tri, t) <= 1e-12) after++;
      }
    }
    var res = { ok: after <= before, before: before, after: after };
    if (!res.ok) res.reason = 'the move would collapse ' + (after - before) + ' triangle' +
      (after - before === 1 ? '' : 's') + ' to nothing - the surface folds over itself';
    return res;
  }

  /* ------------------------------------------------------------------ finish */

  function finish(S, D, opts) {
    opts = opts || {};
    var res = { ok: false, reason: '', tris: S.origTris, report: null };
    var len = Math.sqrt(D[0] * D[0] + D[1] * D[1] + D[2] * D[2]);
    if (!(len > 1e-9)) { res.ok = true; res.noop = true; res.reason = 'the grab did not move'; return res; }
    displace(S, D);

    var outTris = Densify.toSoup(S.mesh, S.pos);

    var collapse = collapseGuard(S);
    if (!collapse.ok) { res.reason = collapse.reason; res.report = { collapse: collapse }; return res; }

    var wall = wallGuard(S, outTris, opts);
    if (!wall.ok) { res.reason = wall.reason; res.report = { wall: wall }; return res; }

    var pierce = pierceGuard(S, D, opts);
    if (!pierce.ok) { res.reason = pierce.reason; res.report = { wall: wall, pierce: pierce }; return res; }

    res.ok = true;
    res.tris = outTris;
    res.report = {
      moved: S.moved.length, zone: S.zone.length, length: len,
      densify: S.densify, wall: wall, pierce: pierce, collapse: collapse,
      trisBefore: (S.origTris.length / 9) | 0, trisAfter: S.mesh.triCount
    };
    return res;
  }

  /* One call, for a headless caller: spec { grab:{c,r}, pins:[{c,r}], D:[x,y,z] }. */
  function pull(rawTris, spec, opts) {
    var S = prepare(rawTris, spec.grab, spec.pins || [], opts);
    if (!S.ok) return { ok: false, reason: S.reason, tris: rawTris, S: S };
    displace(S, spec.D);
    var f = finish(S, spec.D, opts);
    f.S = S;
    return f;
  }

  var API = {
    SPACING: SPACING, NOZZLE: NOZZLE, FLOOR_NOZZLES: FLOOR_NOZZLES,
    bell: bell, phiAt: phiAt, prepare: prepare, displace: displace, finish: finish, pull: pull,
    vertexNormals: vertexNormals, wallGuard: wallGuard, pierceGuard: pierceGuard
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.NSO_Pull = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
