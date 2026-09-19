// ===================== Sculpt tier 1: adjacency + global smoothing =====================
// Headless geometry only. Nothing in the first two sections touches the DOM,
// Three.js or app state, so the same file runs under node for the self-test
// (tools/sculpt_selftest.js) and under a classic script tag in the browser.
//
// Everything here speaks rawTris: a flat Float32Array triangle soup, 9 floats
// per triangle, no shared indices — the same buffer Cut and Soften pass
// around. The soup has no topology of its own, so section 1 builds one.
//
// SCOPE, stated up front: global Laplacian smoothing has NO feature
// preservation. It cannot keep a sharp edge sharp, cannot protect a region,
// and shrinks whatever it touches. That is the algorithm, not a defect. The
// brush tier (push / pull / local smooth) is what gets a "smooth here, leave
// that corner alone" workflow. Do not bolt feature detection onto this file.

/* =====================================================================
   1. Weld + adjacency

   The undirected-edge count is the same pattern NSO_edgeStats and
   rawCheckWatertightQuick already use, with one difference that matters:
   those weld by rounding a coordinate into a string bucket, so two vertices
   a hair apart but either side of a bucket wall stay separate and their
   shared edge reads as two open edges. This one welds by real distance —
   a vertex looks in its own cell and the 26 around it — and then counts
   edges on the resulting INTEGER indices, the way NSO_manifoldStats counts
   them off the kernel's own mesh. Positions never enter the edge key.
   ===================================================================== */

// Weld tolerance that cannot eat the piece's own detail. Same reasoning as
// NSO_weldEpsFor in app-join.js: cap the ask at a third of the shortest real
// edge in the soup, so coincident vertices still merge and real geometry
// never does. A tolerance larger than an edge would weld that edge's two
// ends together and delete the triangle.
//
// One difference, and it is not cosmetic. NSO_weldEpsFor takes the strict
// minimum edge in the soup, so ONE sliver sets the tolerance for the whole
// mesh. Measured on fixtures/tape_on-edge-single-B101_rounded_v8_FINAL.stl:
// 2 edges out of 98,586 are shorter than 1e-4 (shortest 1.499e-5), and the
// strict minimum drags the tolerance to 5e-6. At 5e-6 the float32 rounding
// in the STL keeps 400-odd vertex pairs apart and the part reads as 1402
// open edges. It is not open: at 3e-5 it welds to V-E+F = 2, 0 open, 0
// non-manifold. Two slivers cost a sound mesh its topology.
//
// So separate the two populations. Edges shorter than the requested
// tolerance are what the caller asked to weld; edges longer than it are the
// detail to protect. Take the cap from the LONGER population - unless the
// short edges are more than 1% of the mesh, in which case they are not
// slivers, they are the piece's real feature scale (a wrapped surface at
// 0.034 mm edges asked to weld at 0.08), and the strict minimum is right.
//
// LATENT: this rule is only sound at the 1e-4 default it is called with, and
// `want` is the reason. It splits the two populations AT `want`, so as the ask
// grows the "slivers to discard" set swallows real detail, and once it passes
// 1% the rule falls back to the strict minimum it exists to avoid. Measured on
// the tape fixture (NSO_buildAdjacency, rawTol):
//
//   want    tol returned   V-E+F  open  nm  dropped
//   1e-4      4.2397e-5        2     0   0        2   correct
//   1e-3      4.2824e-4        2     0   0       38   topology holds, eats 36
//                                                     extra triangles silently
//   1e-2      3.6650e-3       -8    32   2      162   broken
//   0.08      4.9970e-6     -297  1402   0        0   sliver-poisoned: >1% of
//                                                     edges are below 0.08, so
//                                                     it takes the raw minimum
//
// So do NOT expose `want`/opts.tol as a knob without replacing this rule
// first. NSO_weldEpsFor (app-join.js, weld-eps1) is the version that does not
// have this failure mode: it splits on the gap in the mesh's own edge
// distribution instead of on `want`, and returns 4.2397e-5 for the tape at
// every ask above. It is not called from here because app-sculpt.js loads
// before app-join.js and tools/sculpt_selftest.js loads this file alone in a
// vm; unifying the two means hoisting the helper into app-core.js.
function NSO_sculptWeldTol(rawTris, want) {
  want = (want > 0) ? want : 1e-4;
  var n = (rawTris && rawTris.length) ? (rawTris.length / 9) | 0 : 0;
  if (!n) return want;
  var minAll = Infinity, minAbove = Infinity, below = 0, total = 0;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    for (var e = 0; e < 3; e++) {
      var a = o + e * 3, b = o + ((e + 1) % 3) * 3;
      var dx = rawTris[a] - rawTris[b], dy = rawTris[a + 1] - rawTris[b + 1], dz = rawTris[a + 2] - rawTris[b + 2];
      var L = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (L <= 1e-12) continue;   // exactly coincident: nothing to protect
      total++;
      if (L < minAll) minAll = L;
      if (L < want) { below++; continue; }
      if (L < minAbove) minAbove = L;
    }
  }
  if (!total || !isFinite(minAll)) return want;
  var pervasive = (below / total) > 0.01;
  var basis = pervasive ? minAll : (isFinite(minAbove) ? minAbove : minAll);
  return Math.min(want, basis / 3);
}

// rawTris -> indexed mesh + vertex->vertex adjacency.
//
// opts.tol        weld distance, default 1e-4 capped by NSO_sculptWeldTol
// opts.rawTol     true = use opts.tol as given, no cap (self-test only)
//
// Returns:
//   ok, reason
//   vertCount, triCount, droppedTris, weldTol, weldDrift
//   isolated  vertices left with no incident edge by a dropped sliver
//   pos       Float64Array(vertCount*3)   welded positions
//   tri       Int32Array(triCount*3)      indices into pos
//   nbrStart  Int32Array(vertCount+1)     CSR row starts
//   nbrList   Int32Array(edgeCount*2)     neighbour vertex ids
//   edgeCount, openEdges, nmEdges
//   stackedDirs, orientable              directed-edge check: a directed edge
//                                        used twice means two triangles walk
//                                        their shared edge the same way, i.e.
//                                        one of them is wound backwards
//   boundary  Uint8Array(vertCount)       1 = vertex sits on an open edge
function NSO_buildAdjacency(rawTris, opts) {
  opts = opts || {};
  var out = { ok: false, reason: '' };
  if (!rawTris || rawTris.length < 9 || (rawTris.length % 9) !== 0) {
    out.reason = 'not a triangle soup';
    return out;
  }
  var triIn = (rawTris.length / 9) | 0;
  var tol = (opts.tol > 0) ? opts.tol : 1e-4;
  if (!opts.rawTol) tol = NSO_sculptWeldTol(rawTris, tol);
  var inv = 1 / tol;

  // Spatial hash on cells of side tol. A vertex can only merge with one in
  // its own cell or a touching cell, so 27 lookups settle it exactly.
  var cells = new Map();
  var px = [], py = [], pz = [];
  var drift = 0;

  function cellKey(ix, iy, iz) {
    return ix + ',' + iy + ',' + iz;
  }
  function vid(x, y, z) {
    var ix = Math.floor(x * inv), iy = Math.floor(y * inv), iz = Math.floor(z * inv);
    var best = -1, bestD = tol * tol;
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        for (var dz = -1; dz <= 1; dz++) {
          var bucket = cells.get(cellKey(ix + dx, iy + dy, iz + dz));
          if (!bucket) continue;
          for (var i = 0; i < bucket.length; i++) {
            var j = bucket[i];
            var ex = px[j] - x, ey = py[j] - y, ez = pz[j] - z;
            var d2 = ex * ex + ey * ey + ez * ez;
            if (d2 <= bestD) { bestD = d2; best = j; }
          }
        }
      }
    }
    if (best >= 0) {
      var dd = Math.sqrt(bestD);
      if (dd > drift) drift = dd;
      return best;
    }
    var id = px.length;
    px.push(x); py.push(y); pz.push(z);
    var k = cellKey(ix, iy, iz);
    var b = cells.get(k);
    if (b) b.push(id); else cells.set(k, [id]);
    return id;
  }

  var tri = [];
  var dropped = 0;
  for (var t = 0; t < triIn; t++) {
    var o = t * 9;
    var a = vid(rawTris[o], rawTris[o + 1], rawTris[o + 2]);
    var b2 = vid(rawTris[o + 3], rawTris[o + 4], rawTris[o + 5]);
    var c = vid(rawTris[o + 6], rawTris[o + 7], rawTris[o + 8]);
    // A triangle two of whose corners welded together is a sliver with no
    // area. Keeping it would put a zero-length edge in the adjacency graph
    // and a self-loop in every neighbour average.
    if (a === b2 || b2 === c || c === a) { dropped++; continue; }
    tri.push(a, b2, c);
  }
  var vertCount = px.length;
  var triCount = (tri.length / 3) | 0;
  if (!triCount) { out.reason = 'every triangle welded away'; return out; }

  var pos = new Float64Array(vertCount * 3);
  for (var v = 0; v < vertCount; v++) {
    pos[v * 3] = px[v]; pos[v * 3 + 1] = py[v]; pos[v * 3 + 2] = pz[v];
  }
  var triArr = new Int32Array(tri);

  // Undirected edge counts on indices. Key is a single number, not a
  // string: vertCount stays far under 2^26 in practice, so min*N+max is
  // exact in a double.
  var em = new Map();
  // Directed count as well, for the same reason rawCheckWatertightQuick keeps
  // one: undirected pairing says the surface is closed, it does NOT say the
  // two triangles sharing an edge walk it in opposite directions. A face
  // wound backwards pairs perfectly and still inverts that face's
  // contribution to the volume, which is exactly the kind of mesh that must
  // never reach the volume gate unflagged.
  var dm = new Map();
  for (var q = 0; q < triCount; q++) {
    var i0 = triArr[q * 3], i1 = triArr[q * 3 + 1], i2 = triArr[q * 3 + 2];
    var pairs = [i0, i1, i1, i2, i2, i0];
    for (var e = 0; e < 3; e++) {
      var u = pairs[e * 2], w = pairs[e * 2 + 1];
      var lo = u < w ? u : w, hi = u < w ? w : u;
      var key = lo * vertCount + hi;
      em.set(key, (em.get(key) || 0) + 1);
      var dkey = u * vertCount + w;
      dm.set(dkey, (dm.get(dkey) || 0) + 1);
    }
  }
  var stackedDirs = 0;
  dm.forEach(function (c) { if (c > 1) stackedDirs++; });

  var edgeCount = em.size;
  var open = 0, nm = 0;
  var deg = new Int32Array(vertCount);
  var boundary = new Uint8Array(vertCount);
  em.forEach(function (count, key) {
    var hi = key % vertCount, lo = (key - hi) / vertCount;
    deg[lo]++; deg[hi]++;
    if (count === 1) { open++; boundary[lo] = 1; boundary[hi] = 1; }
    else if (count > 2) nm++;
  });

  var nbrStart = new Int32Array(vertCount + 1);
  for (var s = 0; s < vertCount; s++) nbrStart[s + 1] = nbrStart[s] + deg[s];
  var nbrList = new Int32Array(edgeCount * 2);
  var fill = new Int32Array(vertCount);
  em.forEach(function (count, key) {
    var hi = key % vertCount, lo = (key - hi) / vertCount;
    nbrList[nbrStart[lo] + fill[lo]++] = hi;
    nbrList[nbrStart[hi] + fill[hi]++] = lo;
  });

  // A triangle whose corners all welded together leaves its vertex behind
  // with no incident edge. It never reaches the output soup (that is built
  // from tri[]) and smoothing skips it, but it would otherwise inflate the
  // vertex count the caller is shown, so count it explicitly.
  var isolated = 0;
  for (var d0 = 0; d0 < vertCount; d0++) if (deg[d0] === 0) isolated++;

  out.ok = true;
  out.isolated = isolated;
  out.vertCount = vertCount;
  out.triCount = triCount;
  out.triIn = triIn;
  out.droppedTris = dropped;
  out.weldTol = tol;
  out.weldDrift = drift;
  out.pos = pos;
  out.tri = triArr;
  out.nbrStart = nbrStart;
  out.nbrList = nbrList;
  out.edgeCount = edgeCount;
  out.openEdges = open;
  out.nmEdges = nm;
  out.stackedDirs = stackedDirs;
  out.orientable = (stackedDirs === 0);
  out.boundary = boundary;
  return out;
}

// Indexed mesh back to a flat soup. Same triangle order, same winding.
function NSO_adjacencyToRaw(adj, pos) {
  var p = pos || adj.pos;
  var n = adj.triCount;
  var out = new Float32Array(n * 9);
  for (var t = 0; t < n; t++) {
    for (var v = 0; v < 3; v++) {
      var i = adj.tri[t * 3 + v] * 3;
      var o = t * 9 + v * 3;
      out[o] = p[i]; out[o + 1] = p[i + 1]; out[o + 2] = p[i + 2];
    }
  }
  return out;
}

/* =====================================================================
   2. Measurement

   Same discipline as the repair pass: numbers before, numbers after, and
   the swap only happens if the numbers allow it. Bounding box is in the
   list because volume alone hides which way a mesh shrank.
   ===================================================================== */

// Positional edge count, the app's own view (NSO_edgeStats, 0.1 micron
// buckets). Reported alongside the indexed count on purpose: the indexed
// count cannot change under smoothing, so only the positional one can
// catch two vertices being driven together into a fold.
function NSO_sculptEdgeStatsPositional(rawTris) {
  var n = (rawTris.length / 9) | 0;
  var q = 1e4;
  function key(o) {
    return Math.round(rawTris[o] * q) + '_' + Math.round(rawTris[o + 1] * q) + '_' + Math.round(rawTris[o + 2] * q);
  }
  var map = new Map();
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    var k = [key(o), key(o + 3), key(o + 6)];
    for (var e = 0; e < 3; e++) {
      var a = k[e], b = k[(e + 1) % 3];
      if (a === b) continue;
      var ek = a < b ? (a + '|' + b) : (b + '|' + a);
      map.set(ek, (map.get(ek) || 0) + 1);
    }
  }
  var open = 0, nm = 0;
  map.forEach(function (c) { if (c === 1) open++; else if (c > 2) nm++; });
  return { open: open, nm: nm };
}

function NSO_sculptMetrics(rawTris, adj) {
  var n = (rawTris.length / 9) | 0;
  var minX = Infinity, minY = Infinity, minZ = Infinity;
  var maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  var vol = 0, area = 0, degen = 0, minEdge = Infinity;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    var ax = rawTris[o], ay = rawTris[o + 1], az = rawTris[o + 2];
    var bx = rawTris[o + 3], by = rawTris[o + 4], bz = rawTris[o + 5];
    var cx = rawTris[o + 6], cy = rawTris[o + 7], cz = rawTris[o + 8];
    if (ax < minX) minX = ax; if (ax > maxX) maxX = ax;
    if (bx < minX) minX = bx; if (bx > maxX) maxX = bx;
    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
    if (ay < minY) minY = ay; if (ay > maxY) maxY = ay;
    if (by < minY) minY = by; if (by > maxY) maxY = by;
    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
    if (az < minZ) minZ = az; if (az > maxZ) maxZ = az;
    if (bz < minZ) minZ = bz; if (bz > maxZ) maxZ = bz;
    if (cz < minZ) minZ = cz; if (cz > maxZ) maxZ = cz;
    // Signed volume of the tetrahedron on the origin: divergence theorem,
    // valid for any closed surface whatever the origin.
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    var ux = bx - ax, uy = by - ay, uz = bz - az;
    var vx = cx - ax, vy = cy - ay, vz = cz - az;
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var a2 = Math.sqrt(nx * nx + ny * ny + nz * nz) * 0.5;
    area += a2;
    if (a2 < 1e-12) degen++;
    var pts = [ax, ay, az, bx, by, bz, cx, cy, cz];
    for (var e = 0; e < 3; e++) {
      var i = e * 3, j = ((e + 1) % 3) * 3;
      var L = Math.hypot(pts[i] - pts[j], pts[i + 1] - pts[j + 1], pts[i + 2] - pts[j + 2]);
      if (L < minEdge) minEdge = L;
    }
  }
  var ep = NSO_sculptEdgeStatsPositional(rawTris);
  var m = {
    tris: n,
    bbox: {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      size: [maxX - minX, maxY - minY, maxZ - minZ]
    },
    volume: vol,
    area: area,
    degenerate: degen,
    minEdge: isFinite(minEdge) ? minEdge : 0,
    openPos: ep.open,
    nmPos: ep.nm
  };
  if (adj && adj.ok) {
    m.verts = adj.vertCount;
    m.openIdx = adj.openEdges;
    m.nmIdx = adj.nmEdges;
    m.stackedDirs = adj.stackedDirs;
    m.orientable = adj.orientable;
    // Watertight means closed AND consistently wound. A mesh that pairs every
    // edge but flips a face is not a solid: its volume is wrong by twice that
    // face's contribution, and no slicer will read it the way it looks.
    m.watertight = (adj.openEdges === 0 && adj.nmEdges === 0 && adj.stackedDirs === 0 && ep.open === 0 && ep.nm === 0);
  } else {
    m.watertight = (ep.open === 0 && ep.nm === 0);
  }
  return m;
}

/* =====================================================================
   3. Global Laplacian smoothing

   Every vertex steps toward the average of its adjacency-graph neighbours.
   Jacobi, not Gauss-Seidel: a pass reads only the previous pass's
   positions, so the result does not depend on vertex order.

   Topology is untouched by construction. The index buffer built in
   section 1 is reused verbatim for the output soup, so vertex count,
   triangle count and connectivity are identical before and after; only
   the numbers in pos[] change.

   What this DOES do, unavoidably:
     - rounds sharp edges and corners (no feature term exists here),
     - shrinks the piece, thin sections fastest, since the average of a
       thin slab's neighbours lies inside the slab from both faces at once.
   Both are measured by the self-test rather than hidden.
   ===================================================================== */

// opts.passes      integer >= 0, default 1
// opts.strength    0..1 step per pass, default 0.5. >1 overshoots and is
//                  refused; 1.0 is already full replacement by the average.
// opts.pinBoundary default true - vertices on an open edge do not move, so
//                  an open mesh keeps its rim instead of curling it in.
// opts.tol         weld tolerance handed to NSO_buildAdjacency
// opts.adj         a prebuilt adjacency (skips the weld)
// opts.gate        default true - refuse the result if it is worse
// opts.maxVolumeChange  optional 0..1; refuse if |volume| moves by more than
//                  this fraction in EITHER direction. Two-sided on purpose.
//                  Every surface moves toward its own centre of curvature,
//                  so a convex outside loses material and a CONCAVE inside
//                  gains it - a cavity wall pushed toward its neighbours'
//                  average is pushed into the cavity. On a hollow part the
//                  second effect can win outright: library/box_closed.stl's
//                  tray shell measures 13632 mm3 before and 32784 mm3 after
//                  ONE pass at strength 0.5, because its 25 mm cavity fills
//                  in. A loss-only budget waves that straight through, which
//                  is why this one is symmetric. Off by default: volume
//                  change is what the algorithm does, and gating it by
//                  default would refuse correct results. Set it when a
//                  caller has a real budget.
//
// Returns { ok, reason, tris, before, after, adjacency, moved, maxMove }.
// On refusal ok is false, reason says why, and tris is the ORIGINAL soup —
// the caller can swap unconditionally, the way commitSoften does, because
// a refused smooth hands back what it was given.
function NSO_smoothGlobal(rawTris, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '', tris: rawTris };
  if (!rawTris || rawTris.length < 9) { res.reason = 'empty soup'; return res; }

  var passes = (opts.passes == null) ? 1 : (opts.passes | 0);
  var strength = (opts.strength == null) ? 0.5 : +opts.strength;
  var pinBoundary = (opts.pinBoundary == null) ? true : !!opts.pinBoundary;
  var gate = (opts.gate == null) ? true : !!opts.gate;
  if (!(passes >= 0)) { res.reason = 'bad pass count'; return res; }
  if (!(strength >= 0 && strength <= 1)) { res.reason = 'strength must be 0..1'; return res; }

  var adj = opts.adj || NSO_buildAdjacency(rawTris, { tol: opts.tol });
  if (!adj.ok) { res.reason = 'adjacency: ' + adj.reason; return res; }
  res.adjacency = adj;
  // Not a refusal: smoothing reuses the index buffer, so it cannot make the
  // winding worse. But the volume numbers below - and the volume-sign gate -
  // are only meaningful on a consistently wound mesh, so say so out loud
  // rather than reporting a signed volume that is quietly part cancellation.
  if (!adj.orientable) {
    res.warn = 'input winding inconsistent (' + adj.stackedDirs +
      ' directed edges used twice) - volume figures are not a solid volume';
  }

  // The welded soup, not the caller's, is the honest "before": welding can
  // drop slivers and nudge duplicates onto one representative, and that
  // change belongs to the weld, not to the smoothing.
  var baseTris = NSO_adjacencyToRaw(adj, adj.pos);
  res.before = NSO_sculptMetrics(baseTris, adj);

  var n = adj.vertCount;
  var cur = new Float64Array(adj.pos);
  var next = new Float64Array(n * 3);
  var nbrStart = adj.nbrStart, nbrList = adj.nbrList, boundary = adj.boundary;

  for (var p = 0; p < passes; p++) {
    for (var v = 0; v < n; v++) {
      var s = nbrStart[v], e = nbrStart[v + 1], k = e - s;
      var o = v * 3;
      // No neighbours, or pinned on an open rim: hold position. A pinned
      // vertex still acts as an anchor for the ones that do move.
      if (k === 0 || (pinBoundary && boundary[v])) {
        next[o] = cur[o]; next[o + 1] = cur[o + 1]; next[o + 2] = cur[o + 2];
        continue;
      }
      var sx = 0, sy = 0, sz = 0;
      for (var i = s; i < e; i++) {
        var j = nbrList[i] * 3;
        sx += cur[j]; sy += cur[j + 1]; sz += cur[j + 2];
      }
      sx /= k; sy /= k; sz /= k;
      next[o] = cur[o] + strength * (sx - cur[o]);
      next[o + 1] = cur[o + 1] + strength * (sy - cur[o + 1]);
      next[o + 2] = cur[o + 2] + strength * (sz - cur[o + 2]);
    }
    var swap = cur; cur = next; next = swap;
  }

  var moved = 0, maxMove = 0;
  for (var v2 = 0; v2 < n; v2++) {
    var o2 = v2 * 3;
    var d = Math.hypot(cur[o2] - adj.pos[o2], cur[o2 + 1] - adj.pos[o2 + 1], cur[o2 + 2] - adj.pos[o2 + 2]);
    if (d > 1e-9) moved++;
    if (d > maxMove) maxMove = d;
  }
  res.moved = moved;
  res.maxMove = maxMove;

  var outTris = NSO_adjacencyToRaw(adj, cur);
  var after = NSO_sculptMetrics(outTris, adj);
  after.verts = adj.vertCount;
  after.openIdx = adj.openEdges;
  after.nmIdx = adj.nmEdges;
  res.after = after;

  // Refusals, all of them before the caller swaps geometry.
  //
  // Read this for what it is: a TOPOLOGY gate, not a safety gate. It proves
  // the smooth did not tear, fold or unseal the mesh. It says nothing about
  // whether the result is still the part. Measured here, a 384-triangle
  // thin-wall tube smooths to 0.001 mm tall - 100% of its volume gone - and
  // passes every check below with 0 open and 0 non-manifold edges, because a
  // wafer is a perfectly watertight wafer. Only maxVolumeChange bounds that,
  // and it is off unless a caller sets it.
  if (gate) {
    var bad = null;
    if (after.tris !== res.before.tris) bad = 'triangle count changed';
    else if (after.openPos > res.before.openPos) bad = 'open edges rose ' + res.before.openPos + '->' + after.openPos;
    else if (after.nmPos > res.before.nmPos) bad = 'non-manifold edges rose ' + res.before.nmPos + '->' + after.nmPos;
    else if (after.degenerate > res.before.degenerate) bad = 'degenerate triangles rose ' + res.before.degenerate + '->' + after.degenerate;
    else if (opts.nonSolid) {
      // NON-SOLID SCOPE (docs/NON-SOLID.md): a signed volume has no meaning
      // without an inside, so on a piece the user flagged non-solid the two
      // volume checks are replaced by the same budget on surface area. The
      // topology checks above run unchanged - they are about tearing, not
      // closure - and the open-edge check above is a delta, so a piece that
      // arrives open passes it either way.
      if (!isFinite(after.area)) bad = 'area not finite';
      else if (opts.maxVolumeChange > 0 && res.before.area > 0) {
        var achange = after.area / res.before.area - 1;
        if (Math.abs(achange) > opts.maxVolumeChange) {
          bad = 'surface area ' + (achange < 0 ? 'loss ' : 'gain ') +
            Math.abs(achange * 100).toFixed(2) + '% over budget (non-solid)';
        }
      }
    }
    else if (!isFinite(after.volume)) bad = 'volume not finite';
    else if (res.before.volume !== 0 && Math.sign(after.volume) !== Math.sign(res.before.volume)) bad = 'volume flipped sign';
    else if (opts.maxVolumeChange > 0 && res.before.volume !== 0) {
      var change = Math.abs(after.volume) / Math.abs(res.before.volume) - 1;
      if (Math.abs(change) > opts.maxVolumeChange) {
        bad = 'volume ' + (change < 0 ? 'loss ' : 'gain ') +
          Math.abs(change * 100).toFixed(2) + '% over budget';
      }
    }
    if (bad) { res.reason = bad; res.tris = rawTris; return res; }
  }

  res.ok = true;
  res.tris = outTris;
  return res;
}

/* =====================================================================
   4. App wiring

   Kept separate from the geometry on purpose: everything above runs with
   no DOM, no Three.js and no app state. This part is the commit() half of
   the house lifecycle - undo entry first, display geometry rebuilt from
   the new rawTris, placed instance re-seated - modelled on commitSoften
   in app-finish.js. It no-ops anywhere those helpers do not exist.
   ===================================================================== */
function NSO_sculptCommitRaw(m, working, undoType, statusText) {
  if (typeof THREE === 'undefined' || !m || !working || working.length < 9) return false;
  if (typeof pushUndo === 'function') {
    pushUndo({
      type: undoType || 'sculptReplace',
      modelId: m.id,
      prevGeometry: m.geometry ? m.geometry.clone() : null,
      prevRawTris: m.rawTris,
      prevRawAxis: m.rawAxis,
      prevCenterOffset: m.centerOffset,
      prevSize: m.size ? { x: m.size.x, y: m.size.y, z: m.size.z } : null
    });
  }

  var newGeo = (typeof rawResultToDisplayGeometry === 'function')
    ? rawResultToDisplayGeometry(working) : null;
  if (!newGeo) return false;
  newGeo.computeBoundingBox();
  var size2 = new THREE.Vector3();
  newGeo.boundingBox.getSize(size2);

  m.geometry = newGeo;
  m.rawTris = working;
  m.rawAxis = 'zup';
  if (typeof computeCenterOffsetFromRaw === 'function') m.centerOffset = computeCenterOffsetFromRaw(working);
  m.size = { x: size2.x, y: size2.y, z: size2.z };

  var placedEntry = (typeof state !== 'undefined' && state.placed)
    ? state.placed.find(function (p) { return p && p.sourceId === m.id; }) : null;
  if (placedEntry) {
    var px = placedEntry.x, pz = placedEntry.z;
    if (placedEntry.mesh && state.modelGroup) {
      state.modelGroup.remove(placedEntry.mesh);
      if (placedEntry.mesh.material) {
        if (Array.isArray(placedEntry.mesh.material)) placedEntry.mesh.material.forEach(function (mt) { mt.dispose(); });
        else placedEntry.mesh.material.dispose();
      }
    }
    var mat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8, metalness: 0.05, roughness: 0.4,
      emissive: 0x0a3a5c, emissiveIntensity: 0.25
    });
    var mesh = new THREE.Mesh(m.geometry, mat);
    mesh.position.set(px, m.size.y / 2 + 0.3, pz);
    mesh.userData.sourceId = m.id;
    mesh.userData.placedIndex = state.placed.indexOf(placedEntry);
    state.modelGroup.add(mesh);
    placedEntry.mesh = mesh;
    placedEntry.geometry = m.geometry;
    placedEntry.width = m.size.x;
    placedEntry.depth = m.size.z;
    placedEntry.height = m.size.y;

    /* A bake replaces the GEOMETRY. It does not move the piece, so the pose
       the adjust buttons recorded on the placed entry - rotY, tipX/tiltX,
       flipX, tipZ/tiltZ, liftY - still stands, and the fresh mesh above is
       built at identity. Left there the two disagree silently: the viewport
       draws the piece unrotated while buildCombinedGeometry() and the 3MF
       writer keep reading the record, so the file comes out posed and the
       screen does not. Nothing says so until a piece is posed, baked, and
       exported in that order, which is why it stayed invisible.

       applyMeshRotation is the one definition of that record -> mesh
       mapping, and it re-measures width/depth/height off the POSED box,
       which the three lines above can only do for an unposed piece. Only
       called when there IS a pose to put back: an unposed piece keeps the
       exact placement this has always given it. */
    var posed = !!(placedEntry.rotY || placedEntry.tipX || placedEntry.tiltX ||
                   placedEntry.flipX || placedEntry.tipZ || placedEntry.tiltZ ||
                   placedEntry.liftY);
    if (posed && typeof applyMeshRotation === 'function') applyMeshRotation(placedEntry);
  }

  if (typeof updateEditSize === 'function') updateEditSize();
  if (typeof renderModelList === 'function') renderModelList();
  if (typeof updateUndoBtn === 'function') updateUndoBtn();
  if (typeof nsoMaskRepaint === 'function') nsoMaskRepaint();
  if (statusText && typeof setStatus === 'function') setStatus(statusText);
  return true;
}

// Smooth the selected piece and bake it. Returns the result object so a
// caller (or the console) can read the before/after numbers.
//
// This is the one place a default volume budget belongs. NSO_smoothGlobal
// stays unopinionated because a script may well want to smooth a part to
// nothing on purpose; a user with a button does not, and the topology gate
// will not stop them. 25% either way, overridable per call, and the refusal
// says the number so it is obvious what happened rather than looking broken.
function NSO_smoothSelectedModel(opts) {
  var m = (typeof getActiveModel === 'function') ? getActiveModel() : null;
  if (!m) {
    if (typeof setStatus === 'function') setStatus('Select a piece first', true);
    return { ok: false, reason: 'no selection' };
  }
  var soupIn = (m.rawTris && m.rawAxis === 'zup') ? m.rawTris : null;
  if (!soupIn) {
    if (typeof setStatus === 'function') setStatus('Smooth needs a raw piece - unchanged', true);
    return { ok: false, reason: 'no rawTris' };
  }
  // Standing rule (docs/HANDOFF.md): a painted face stays untouched by ANY
  // bake. Global Laplacian smoothing moves every unpinned vertex on the piece
  // and has no way to hold a face still - that is the algorithm, stated at the
  // top of this file, not something to bolt on here. So a painted piece is a
  // stand-down, naming the count, rather than a bake that quietly ignores the
  // paint. Clear the paint, or wait for the brush tier.
  //
  // PAINT SCOPE: WHOLE-PIECE. Any painted face on the piece stands this down.
  // There is no sub-region to scope the check to - the smoothing touches every
  // unpinned vertex - so nsoMaskCount is the whole test. See the scoping rule
  // in docs/HANDOFF.md; the brush tier, when it exists, will be sub-region and
  // must re-answer that question rather than inherit this line.
  var paintedCount = (typeof nsoMaskCount === 'function') ? nsoMaskCount(m) : 0;
  if (paintedCount > 0) {
    if (typeof setStatus === 'function') {
      setStatus('Smooth stood down - ' + paintedCount + ' painted face(s); global smoothing ' +
                'cannot hold a face still. Clear paint to smooth.', true);
    }
    return { ok: false, reason: 'painted faces: ' + paintedCount, painted: paintedCount };
  }
  opts = opts || {};
  if (opts.maxVolumeChange == null) opts.maxVolumeChange = 0.25;
  // NON-SOLID SCOPE (docs/NON-SOLID.md): read the user's flag through
  // nsoNonSolid and hand it to the gate, which swaps its volume budget for a
  // surface-area budget. Nothing here infers it from the open-edge count.
  if (opts.nonSolid == null) opts.nonSolid = (typeof nsoNonSolid === 'function') && nsoNonSolid(m);
  var r = NSO_smoothGlobal(soupIn, opts);
  if (!r.ok) {
    if (typeof setStatus === 'function') setStatus('Smooth refused - piece unchanged (' + r.reason + ')', true);
    return r;
  }
  var txt;
  if (opts.nonSolid) {
    var areaPct = r.before.area ? (100 * (r.after.area / r.before.area - 1)) : 0;
    txt = 'Smooth done (non-solid) - verts ' + r.after.verts +
      ', open ' + r.before.openPos + '\u2192' + r.after.openPos +
      ', area ' + (areaPct >= 0 ? '+' : '') + areaPct.toFixed(2) + '%';
  } else {
    var volPct = r.before.volume ? (100 * (Math.abs(r.after.volume) / Math.abs(r.before.volume) - 1)) : 0;
    txt = 'Smooth done - verts ' + r.after.verts +
      ', open ' + r.before.openPos + '\u2192' + r.after.openPos +
      ', volume ' + (volPct >= 0 ? '+' : '') + volPct.toFixed(2) + '%';
  }
  NSO_sculptCommitRaw(m, r.tris, 'smoothReplace', txt);
  return r;
}


/* ---------------------------------------------------------------------------
   UI entry point. Self-wired here rather than in the shared button block so
   that wiring a sculpt tool does not touch a protected fat file. Guarded on
   `document` because this file also runs headless under
   tools/sculpt_selftest.js.

   Deliberately a bare button and no parameter panel: NSO_smoothSelectedModel
   already carries the only default that matters for a click (maxVolumeChange
   0.25, two-sided) and refuses loudly rather than silently mangling a piece.
   Passes/strength stay console-only until there is a reason to surface them.
--------------------------------------------------------------------------- */
if (typeof document !== 'undefined') {
  (function wireSmoothButton() {
    function wire() {
      var btn = document.getElementById('btn-smooth');
      if (!btn || btn.dataset.nsoWired === '1') return;
      btn.dataset.nsoWired = '1';
      btn.addEventListener('click', function () {
        try {
          NSO_smoothSelectedModel();
        } catch (err) {
          console.error('[smooth]', err);
          if (typeof setStatus === 'function') {
            setStatus('Smooth failed - piece unchanged (' + ((err && err.message) || err) + ')', true);
          }
        }
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  })();
}
