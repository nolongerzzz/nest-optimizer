/* Local brush - freehand surface deformation. One mechanism, three modes.

   This is NOT Local-Carve (app-carve.js / nso_carve.js / docs/LOCAL-CARVE.md).
   That tool places a dimensioned blade profile at a point the user names and
   subtracts it through the CSG kernel. This is a brush: the user holds the
   button down and drags, the surface deforms under the cursor as they go by
   moving the piece's own vertices - no blade, no boolean, no kernel - and the
   whole drag is one operation with one undo entry and one gate. Reach for
   Local-Carve when the shape matters and you can name it; reach for this when
   the shape is a gesture. Neither is the other's fallback.

   ================================================================= AUDIT
   Nothing in this app did drag-to-paint before this file, and nothing did a
   live uncommitted preview. Every paint / overlay / bake mechanism that
   existed was single-click-and-done:

     app-mask.js face paint   one pointerdown -> nsoMaskToggleAt -> pushUndo
                              and repaint on the SAME event
     Soften / Cap pick        state.softenArmed -> one click -> bake, disarm
     Join face pick           one click per piece, immediate
     Smooth (app-sculpt.js)   button -> whole-piece bake -> commit

   Re-checked 2026-09-18, after Local-Carve, Measure, Delete painted, Texture
   and Center-lock landed: every one of those is a click tool too, and this is
   still the only drag-to-paint and the only live preview in the app.
   `grep -n pointermove app-*.js` finds three files - app-core for the drags
   below, app-seat-grid copying a pose onto a grid it already built, and this
   one.

   Drag existed in exactly three places and none of them touched geometry:
   startMoveDrag (a placed piece's x/z on the plate - pose only), the cutter
   plane helper (the mesh is untouched until Cut), and the yaw drag. There was
   no hover feedback of any kind - `grep hover` over app-*.js was empty, and
   onCanvasPointerMove early-returns unless one of those three drags is already
   running, so there was no pointermove path that fires while nothing is
   pressed. `state.previewMesh` is not a preview despite the name: it is the
   displayed mesh when there is no real plate pack.

   So three mechanisms are invented here rather than copied, and they are the
   reason this file is shaped the way it is:

     1. an unpressed pointermove path, for the size ring;
     2. a stroke session that accumulates across moves but produces ONE undo
        entry and runs the gate ONCE, at pointerup - modelled on the
        startMoveDrag / dragMovePlaced / endMoveDrag skeleton, which is the
        only accumulate-then-commit-once shape in the repo;
     3. a light live refresh. NSO_sculptCommitRaw disposes materials and
        rebuilds the mesh from scratch; it is the right thing at commit and
        far too heavy to run per pointermove.

   ========================================================== THE BASE RULE
   Every stamp is applied to the UNDEFORMED base, never to the running
   result. A stroke is `stamps`, an accumulated per-vertex weight field, and
   one deformation of base -> work. Dragging back and forth over the same
   spot therefore settles instead of digging without limit, and a refinement
   part-way through a stroke can rebuild the whole result exactly rather than
   having to unpick what was already applied. `w` accumulates as a MAX over
   stamps, not a sum, for the same reason.

   ============================================================ SECTIONS
   0-6 are headless: no DOM, no Three.js, no app state, so
   tools/nso_brush_test.js can load this file through `vm` next to
   app-sculpt.js and drive the geometry directly.
   7 is the app wiring and no-ops wherever the app's helpers are absent.

     1. Mesh, graph, and the raw <-> indexed round trip
     2. Selection and falloff
     3. Adaptive refinement - conforming, T-junction free by construction
     4. Deformation - carve / emboss / local smooth
     5. Seam integrity - the boundary band, relaxed on purpose
     6. Audits and the gate
     7. App wiring - the stroke session, the ring, the buttons

   Depends on NSO_buildAdjacency (app-sculpt.js) for the one weld it does,
   and on NSO_Repair for the canonical self-intersection count. Both are
   required, not optional: see NSO_brushGate.
*/

/* =====================================================================
   1. Mesh, graph, and the raw <-> indexed round trip

   NSO_buildAdjacency welds and hands back an indexed mesh plus a CSR vertex
   graph. That weld is the expensive part and it runs exactly once per
   stroke. Refinement afterwards SPLITS EDGES of an already-welded indexed
   mesh, which cannot un-weld it, so the graph can be rebuilt from the index
   buffer alone - a linear pass, no spatial hashing - every time the mesh
   grows.
   ===================================================================== */

// Indexed mesh in the shape this file works on. Detached from the adjacency
// so refinement can grow it without disturbing the caller's copy.
function NSO_brushMesh(adj) {
  return {
    pos: new Float64Array(adj.pos),
    tri: new Int32Array(adj.tri),
    vertCount: adj.vertCount,
    triCount: adj.triCount
  };
}

/* CSR neighbour graph, CSR vertex->triangle map, and the edge counts, all
   from the index buffer. Same undirected/directed pair of counts
   NSO_buildAdjacency keeps and for the same reason: undirected pairing says
   the surface is closed, it does not say the two triangles sharing an edge
   walk it in opposite directions.

   The vertex->triangle map is here so the live preview can rewrite only the
   triangles a stroke actually moved instead of the whole display buffer. */
function NSO_brushGraph(mesh) {
  var V = mesh.vertCount, T = mesh.triCount, tri = mesh.tri;
  var em = new Map(), dm = new Map();
  var t, e;
  for (t = 0; t < T; t++) {
    var i0 = tri[t * 3], i1 = tri[t * 3 + 1], i2 = tri[t * 3 + 2];
    var pr = [i0, i1, i1, i2, i2, i0];
    for (e = 0; e < 3; e++) {
      var u = pr[e * 2], w = pr[e * 2 + 1];
      var lo = u < w ? u : w, hi = u < w ? w : u;
      var k = lo * V + hi;
      em.set(k, (em.get(k) || 0) + 1);
      var dk = u * V + w;
      dm.set(dk, (dm.get(dk) || 0) + 1);
    }
  }
  var stacked = 0;
  dm.forEach(function (c) { if (c > 1) stacked++; });

  var deg = new Int32Array(V), boundary = new Uint8Array(V);
  var open = 0, nm = 0;
  em.forEach(function (c, k) {
    var hi = k % V, lo = (k - hi) / V;
    deg[lo]++; deg[hi]++;
    if (c === 1) { open++; boundary[lo] = 1; boundary[hi] = 1; }
    else if (c > 2) nm++;
  });
  var nbrStart = new Int32Array(V + 1);
  for (var s = 0; s < V; s++) nbrStart[s + 1] = nbrStart[s] + deg[s];
  var nbrList = new Int32Array(em.size * 2);
  var fill = new Int32Array(V);
  em.forEach(function (c, k) {
    var hi = k % V, lo = (k - hi) / V;
    nbrList[nbrStart[lo] + fill[lo]++] = hi;
    nbrList[nbrStart[hi] + fill[hi]++] = lo;
  });

  var vdeg = new Int32Array(V);
  for (t = 0; t < T; t++) { vdeg[tri[t * 3]]++; vdeg[tri[t * 3 + 1]]++; vdeg[tri[t * 3 + 2]]++; }
  var vtStart = new Int32Array(V + 1);
  for (var s2 = 0; s2 < V; s2++) vtStart[s2 + 1] = vtStart[s2] + vdeg[s2];
  var vtList = new Int32Array(T * 3);
  var vfill = new Int32Array(V);
  for (t = 0; t < T; t++) {
    for (e = 0; e < 3; e++) {
      var v = tri[t * 3 + e];
      vtList[vtStart[v] + vfill[v]++] = t;
    }
  }

  return {
    nbrStart: nbrStart, nbrList: nbrList, boundary: boundary,
    vtStart: vtStart, vtList: vtList,
    edgeCount: em.size, openEdges: open, nmEdges: nm,
    stackedDirs: stacked, orientable: (stacked === 0)
  };
}

// Indexed mesh -> flat soup, same order and winding. Float32 to match every
// other rawTris in the app.
function NSO_brushToRaw(mesh, pos) {
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

/* =====================================================================
   2. Selection and falloff

   A stamp is one dab: a centre, an outward unit normal, a radius, a mode
   and an intensity. A stroke is a list of them. Weight accumulates as a MAX,
   never a sum - see THE BASE RULE at the top.
   ===================================================================== */

/* t is 1 at the centre and 0 at the rim.

   BOTH curves reach exactly 0 at the rim. A falloff that stops at a nonzero
   value would put a step between the last selected vertex and its unselected
   neighbour at an arbitrary place in the tessellation, which is a crease the
   mesh never asked for and the sliver source section 5 exists to handle.

   soft  smoothstep - flat at both ends, the gentle dish.
   hard  t^0.25 - still 0.84 at t=0.5, so the floor of the dab is nearly flat
         and the wall is steep. That steep wall is exactly what stresses the
         seam, which is why hard falloff is the case section 5 is measured on
         rather than the easy one. */
function NSO_brushFalloff(t, falloff) {
  if (!(t > 0)) return 0;
  if (t >= 1) return 1;
  return (falloff === 'hard') ? Math.pow(t, 0.25) : t * t * (3 - 2 * t);
}

/* Accumulate `stamps` into a per-vertex weight field over `pos`.

   Each vertex also keeps the normal of the stamp that WON its weight, not a
   blend: along a stroke that crosses a curved surface the winning stamp is
   the nearest one, and its normal is the surface normal there. Averaging
   normals across a stroke that turns a corner points the offset into the
   solid on the inside of the turn.

   Returns { w, nx, ny, nz, touched } where touched lists every vertex with
   w > 0, so nothing downstream has to sweep the whole mesh. */
function NSO_brushWeights(mesh, stamps, opts) {
  opts = opts || {};
  var V = mesh.vertCount, pos = mesh.pos;
  var w = new Float64Array(V);
  var nx = new Float64Array(V), ny = new Float64Array(V), nz = new Float64Array(V);
  var seen = new Uint8Array(V);
  var touched = [];
  var vn = (opts.frontOnly === false) ? null : (opts.normals || NSO_brushVertexNormals(mesh));
  var front = opts.front;

  for (var s = 0; s < stamps.length; s++) {
    var st = stamps[s];
    var r = st.r, r2 = r * r;
    if (!(r > 0)) continue;
    var cx = st.c[0], cy = st.c[1], cz = st.c[2];
    var lo = NSO_brushCellsInRange(mesh, cx, cy, cz, r, opts.hash);
    for (var q = 0; q < lo.length; q++) {
      var v = lo[q], o = v * 3;
      var dx = pos[o] - cx, dy = pos[o + 1] - cy, dz = pos[o + 2] - cz;
      var d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      if (!NSO_brushFacing(vn, v, st.n, front)) continue;
      var ww = NSO_brushFalloff(1 - Math.sqrt(d2) / r, st.falloff);
      if (!(ww > w[v])) continue;
      w[v] = ww;
      nx[v] = st.n[0]; ny[v] = st.n[1]; nz[v] = st.n[2];
      if (!seen[v]) { seen[v] = 1; touched.push(v); }
    }
  }
  return { w: w, nx: nx, ny: ny, nz: nz, touched: new Int32Array(touched) };
}

/* Area-weighted vertex normals.

   THE BRUSH MUST NOT GRAB THE FAR SIDE OF A THIN WALL. Measured on
   fixtures/lid_blank.stl (60 x 40 x 2.4mm): a 20mm brush on the top face has
   every vertex of the BOTTOM face inside its radius too - they are 2.4mm
   away, the brush is twenty. Without this test both faces are pushed down
   together, the plate keeps its thickness, and a stroke that should have
   punched a hole through a 2.4mm wall instead embosses a dish into it and
   sails through the self-intersection gate because nothing ever intersected.
   Volume moved 62mm3 out of 5760 and the piece silently grew 4.8mm on the
   axis it was being carved into.

   So a vertex is only in the brush if its own surface normal agrees with the
   stamp normal. Area weighting, not a plain average, so one sliver in a
   vertex's fan cannot outvote the face it actually belongs to. */
function NSO_brushVertexNormals(mesh) {
  var V = mesh.vertCount, T = mesh.triCount, pos = mesh.pos, tri = mesh.tri;
  var nx = new Float64Array(V), ny = new Float64Array(V), nz = new Float64Array(V);
  for (var t = 0; t < T; t++) {
    var a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
    var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    var vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    // Un-normalised cross product: its length is twice the area, which is
    // exactly the weight wanted.
    var cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    for (var k = 0; k < 3; k++) {
      var i = tri[t * 3 + k];
      nx[i] += cx; ny[i] += cy; nz[i] += cz;
    }
  }
  for (var v = 0; v < V; v++) {
    var L = Math.hypot(nx[v], ny[v], nz[v]);
    if (L > 1e-12) { nx[v] /= L; ny[v] /= L; nz[v] /= L; }
  }
  return { nx: nx, ny: ny, nz: nz };
}

/* Does this vertex face the way the stamp does? `front` is the dot-product
   floor: 0 keeps the hemisphere the user can see and is the default. */
function NSO_brushFacing(vn, v, n, front) {
  if (!vn) return true;
  var d = vn.nx[v] * n[0] + vn.ny[v] * n[1] + vn.nz[v] * n[2];
  return d > ((front == null) ? 0 : front);
}

/* Merge ONE stamp into an existing field, in place.

   The live stroke calls this per pointermove. Because weight accumulates as a
   MAX, a new stamp can only ever raise a weight, so merging is exact - the
   field after merging stamps one at a time is identical to the field built
   from all of them at once, which is what lets the preview and the commit run
   the same pipeline. Returns the vertices whose weight actually changed. */
function NSO_brushMergeStamp(mesh, field, stamp, hash, vn, front) {
  var pos = mesh.pos, w = field.w;
  var r = stamp.r, r2 = r * r;
  var changed = [];
  if (!(r > 0)) return changed;
  var cx = stamp.c[0], cy = stamp.c[1], cz = stamp.c[2];
  var cand = NSO_brushCellsInRange(mesh, cx, cy, cz, r, hash);
  var grew = [];
  for (var q = 0; q < cand.length; q++) {
    var v = cand[q], o = v * 3;
    var dx = pos[o] - cx, dy = pos[o + 1] - cy, dz = pos[o + 2] - cz;
    var d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > r2) continue;
    if (!NSO_brushFacing(vn, v, stamp.n, front)) continue;
    var ww = NSO_brushFalloff(1 - Math.sqrt(d2) / r, stamp.falloff);
    if (!(ww > w[v])) continue;
    var wasNew = !(w[v] > 0);
    w[v] = ww;
    field.nx[v] = stamp.n[0]; field.ny[v] = stamp.n[1]; field.nz[v] = stamp.n[2];
    changed.push(v);
    if (wasNew) grew.push(v);
  }
  if (grew.length) {
    var merged = new Int32Array(field.touched.length + grew.length);
    merged.set(field.touched, 0);
    merged.set(grew, field.touched.length);
    field.touched = merged;
  }
  return changed;
}

/* Vertices whose position could be within `r` of a point.

   A hash is optional: without one this is an honest full sweep, which is
   what the headless tests want and what a 12-triangle box deserves. The
   stroke session builds one because it calls this on every pointermove. */
function NSO_brushCellsInRange(mesh, cx, cy, cz, r, hash) {
  if (!hash) {
    var all = new Int32Array(mesh.vertCount);
    for (var i = 0; i < mesh.vertCount; i++) all[i] = i;
    return all;
  }
  return hash.query(cx, cy, cz, r);
}

// Uniform spatial hash over the base positions. Rebuilt whenever refinement
// grows the mesh; never during a plain pointermove.
function NSO_brushHash(mesh, cell) {
  var V = mesh.vertCount, pos = mesh.pos;
  var c = cell > 0 ? cell : 4;
  var inv = 1 / c;
  var map = new Map();
  for (var v = 0; v < V; v++) {
    var o = v * 3;
    var k = Math.floor(pos[o] * inv) + ',' + Math.floor(pos[o + 1] * inv) + ',' + Math.floor(pos[o + 2] * inv);
    var b = map.get(k);
    if (b) b.push(v); else map.set(k, [v]);
  }
  return {
    cell: c,
    query: function (x, y, z, r) {
      var i0 = Math.floor((x - r) * inv), i1 = Math.floor((x + r) * inv);
      var j0 = Math.floor((y - r) * inv), j1 = Math.floor((y + r) * inv);
      var k0 = Math.floor((z - r) * inv), k1 = Math.floor((z + r) * inv);
      var out = [];
      for (var i = i0; i <= i1; i++)
        for (var j = j0; j <= j1; j++)
          for (var k = k0; k <= k1; k++) {
            var b = map.get(i + ',' + j + ',' + k);
            if (b) for (var q = 0; q < b.length; q++) out.push(b[q]);
          }
      return out;
    }
  };
}

/* =====================================================================
   3. Adaptive refinement - conforming, T-junction free by construction

   THIS IS THE ANSWER TO "re-triangulate where the deformation warrants it".

   A 20mm cube face is two triangles. Carving a 10mm dimple into the middle of
   it moves no vertex at all, because there is no vertex in the middle to
   move: the brush has nothing to work with. Weighting harder does not help -
   the surface has no degrees of freedom there. The zone has to be subdivided
   first, and the amount of subdivision is set by the brush radius, not by the
   intensity: `target = radius / samples` is how finely the surface must be
   sampled for a dab of that size to be representable at all.

   THE T-JUNCTION IS PREVENTED, NOT REPAIRED. The failure mode is the one the
   Skin-wrap work hit and then had to sweep back out (the global T-junction
   repair in app-finish.js): trim each region in its own frame, and a cut that
   crosses an edge two regions share leaves a vertex on one side and not the
   other. That sweep is a cure. This is the vaccine, and it is worth the
   difference: splits are recorded PER EDGE, keyed on the vertex pair, so both
   triangles sharing an edge are handed the SAME midpoint vertex id. A
   triangle outside the brush zone that happens to share a marked edge is
   re-split too. There is no way for this pass to leave a hanging vertex, and
   NSO_brushTJunctionAudit in section 6 asserts that on real meshes rather
   than taking the argument's word for it.
   ===================================================================== */

// One triangle, up to three marked edges, rebuilt so the pieces tile it with
// the original winding. mab/mbc/mca are midpoint vertex ids or -1.
function NSO_brushSplitTri(a, b, c, mab, mbc, mca, out, pos) {
  var n = (mab >= 0 ? 1 : 0) + (mbc >= 0 ? 1 : 0) + (mca >= 0 ? 1 : 0);
  if (n === 0) { out.push(a, b, c); return; }
  if (n === 3) {
    out.push(a, mab, mca, mab, b, mbc, mca, mbc, c, mab, mbc, mca);
    return;
  }
  if (n === 1) {
    if (mab >= 0) out.push(a, mab, c, mab, b, c);
    else if (mbc >= 0) out.push(b, mbc, a, mbc, c, a);
    else out.push(c, mca, b, mca, a, b);
    return;
  }
  // Two marked. Rotate so the UNMARKED edge is CA; then P splits AB and Q
  // splits BC, and the triangle is a corner (P,B,Q) plus the quad A,P,Q,C.
  var A, B, C, P, Q;
  if (mca < 0) { A = a; B = b; C = c; P = mab; Q = mbc; }
  else if (mab < 0) { A = b; B = c; C = a; P = mbc; Q = mca; }
  else { A = c; B = a; C = b; P = mca; Q = mab; }
  out.push(P, B, Q);
  // Split the quad on its shorter diagonal - the longer one is the sliver.
  var d2AQ = NSO_brushD2(pos, A, Q), d2PC = NSO_brushD2(pos, P, C);
  if (d2AQ <= d2PC) out.push(A, P, Q, A, Q, C);
  else out.push(A, P, C, P, Q, C);
}

function NSO_brushD2(pos, i, j) {
  var a = i * 3, b = j * 3;
  var dx = pos[a] - pos[b], dy = pos[a + 1] - pos[b + 1], dz = pos[a + 2] - pos[b + 2];
  return dx * dx + dy * dy + dz * dz;
}

/* Refine `mesh` so every edge inside any of `zones` is no longer than
   `target`. Returns a NEW mesh; the input is untouched.

   zones: [{ c:[x,y,z], r }]  - the union of the stroke's dabs so far.
   opts.target    mm, the edge length to reach inside the zone
   opts.maxPasses cap on halving rounds (default 5 - each round halves, so 5
                  is a 32x reduction and far past anything a brush needs)
   opts.maxTris   triangle budget. A pass that would blow it is not applied
                  at all, and `capped` says so, because half a refinement
                  round is not a mesh anyone wants.

   A triangle counts as in-zone when any of its vertices is within
   r + its own longest edge of a zone centre. That over-includes, on
   purpose: it can never MISS a triangle the brush covers, and the
   over-inclusion shrinks with every round as the edges get shorter. The
   under-inclusive test (vertex within r) misses the whole point - on a
   2-triangle 20mm face with a 10mm brush at the centre, every vertex is
   14mm away and nothing would be refined at all. */
function NSO_brushRefine(mesh, zones, opts) {
  opts = opts || {};
  var target = opts.target > 0 ? opts.target : 0;
  var maxPasses = (opts.maxPasses == null) ? 5 : (opts.maxPasses | 0);
  var maxTris = (opts.maxTris == null) ? 400000 : (opts.maxTris | 0);
  var out = { mesh: mesh, passes: 0, splits: 0, capped: false, target: target };
  if (!(target > 0) || !zones || !zones.length) return out;

  var cur = mesh;
  for (var pass = 0; pass < maxPasses; pass++) {
    var V = cur.vertCount, T = cur.triCount, tri = cur.tri, pos = cur.pos;

    // Which edges have to be split. Keyed on the vertex PAIR, so the two
    // triangles sharing an edge cannot disagree about it.
    var mark = new Map();
    var t, e, z;
    for (t = 0; t < T; t++) {
      var a = tri[t * 3], b = tri[t * 3 + 1], c = tri[t * 3 + 2];
      var e0 = NSO_brushD2(pos, a, b), e1 = NSO_brushD2(pos, b, c), e2 = NSO_brushD2(pos, c, a);
      var longest = Math.sqrt(Math.max(e0, e1, e2));
      // in zone?
      var inZone = false;
      for (z = 0; z < zones.length && !inZone; z++) {
        var zc = zones[z].c, rr = zones[z].r + longest, rr2 = rr * rr;
        var vv = [a, b, c];
        for (var k = 0; k < 3; k++) {
          var o = vv[k] * 3;
          var dx = pos[o] - zc[0], dy = pos[o + 1] - zc[1], dz = pos[o + 2] - zc[2];
          if (dx * dx + dy * dy + dz * dz <= rr2) { inZone = true; break; }
        }
      }
      if (!inZone) continue;
      var len2 = [e0, e1, e2], pr = [a, b, b, c, c, a];
      for (e = 0; e < 3; e++) {
        if (len2[e] <= target * target) continue;
        var u = pr[e * 2], w2 = pr[e * 2 + 1];
        var lo = u < w2 ? u : w2, hi = u < w2 ? w2 : u;
        mark.set(lo * V + hi, -1);
      }
    }
    if (!mark.size) break;

    // Midpoints, one per marked edge, shared by everyone who touches it.
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
    var midOf = function (u, w3) {
      var lo = u < w3 ? u : w3, hi = u < w3 ? w3 : u;
      var m = mark.get(lo * V + hi);
      return (m == null) ? -1 : m;
    };

    // Rebuild EVERY triangle, in zone or not. A triangle outside the zone
    // that shares a marked edge is split here, and that is the whole reason
    // this cannot leave a T-junction behind.
    var built = [];
    for (t = 0; t < T; t++) {
      var a2 = tri[t * 3], b2 = tri[t * 3 + 1], c2 = tri[t * 3 + 2];
      NSO_brushSplitTri(a2, b2, c2, midOf(a2, b2), midOf(b2, c2), midOf(c2, a2), built, npos);
    }
    var newT = (built.length / 3) | 0;
    if (newT > maxTris) { out.capped = true; break; }

    cur = { pos: npos, tri: new Int32Array(built), vertCount: newV, triCount: newT };
    out.splits += mark.size;
    out.passes = pass + 1;
  }
  out.mesh = cur;
  return out;
}

/* How finely the zone has to be sampled for a dab of this radius to exist at
   all. `samples` is how many vertices across the brush diameter; 6 is the
   smallest that gives a dish rather than a faceted pit, measured on
   fixtures/box-20mm.stl where the face starts as two triangles. */
function NSO_brushTargetEdge(radius, samples) {
  var s = (samples > 1) ? samples : 6;
  return (2 * radius) / s;
}

/* =====================================================================
   4. Deformation - carve / emboss / local smooth

   Carve and Emboss are the same operation with opposite sign: move each
   selected vertex along the stamp normal by falloff * intensity * depth.
   Smooth is a LOCALISED Laplacian and is a different thing from
   NSO_smoothGlobal in app-sculpt.js - that one moves every unpinned vertex on
   the piece and, in its own words, "has no feature preservation and no way to
   protect a region". This one is confined to the weight field, and every
   vertex outside it is an anchor the relaxation pulls against. app-sculpt.js
   names this file as where selective work belongs; this is that.

   DEPTH IS KEYED TO RADIUS, not to an absolute millimetre figure. A 50mm
   brush at full force moving the same 2mm as a 5mm brush is not a brush, it
   is a dent tool with a size slider that does nothing. depthScale 0.25 puts
   full force at a quarter of the radius - a 20mm brush at intensity 1 digs
   5mm - and it is an opt so a caller with a real figure can say so.
   ===================================================================== */

function NSO_brushDeform(mesh, basePos, field, opts) {
  opts = opts || {};
  var mode = opts.mode || 'carve';
  var intensity = (opts.intensity == null) ? 0.5 : +opts.intensity;
  var radius = opts.radius > 0 ? opts.radius : 1;
  var depth = (opts.depthScale == null ? 0.25 : +opts.depthScale) * radius;
  /* `out` lets the live stroke reuse one buffer instead of allocating a copy
     of every vertex on the piece on every pointermove. The subset is reset to
     the base first either way, so a recompute is a pure function of (base,
     field) and repeating it cannot drift. */
  var pos = opts.out || new Float64Array(basePos.length);
  var w = field.w, touched = field.touched;
  var i, v, o;
  if (pos !== basePos) {
    if (!opts.out) pos.set(basePos);
    else {
      var reset = opts.reset || touched;
      for (i = 0; i < reset.length; i++) {
        v = reset[i]; o = v * 3;
        pos[o] = basePos[o]; pos[o + 1] = basePos[o + 1]; pos[o + 2] = basePos[o + 2];
      }
    }
  }

  if (mode === 'smooth') {
    // Localised Laplacian. Neighbours with w = 0 are never written, so they
    // hold the rim of the smoothed patch still while its interior relaxes -
    // which is the whole difference from the global pass.
    var passes = (opts.smoothPasses == null) ? 4 : (opts.smoothPasses | 0);
    var lambda = 0.5 * intensity;
    var nbrStart = opts.graph.nbrStart, nbrList = opts.graph.nbrList;
    var boundary = opts.graph.boundary;
    var scratch = new Float64Array(touched.length * 3);
    for (var p = 0; p < passes; p++) {
      for (i = 0; i < touched.length; i++) {
        v = touched[i]; o = v * 3;
        var s = nbrStart[v], e = nbrStart[v + 1], k = e - s;
        if (k === 0 || boundary[v]) {
          scratch[i * 3] = pos[o]; scratch[i * 3 + 1] = pos[o + 1]; scratch[i * 3 + 2] = pos[o + 2];
          continue;
        }
        var sx = 0, sy = 0, sz = 0;
        for (var j = s; j < e; j++) {
          var n3 = nbrList[j] * 3;
          sx += pos[n3]; sy += pos[n3 + 1]; sz += pos[n3 + 2];
        }
        sx /= k; sy /= k; sz /= k;
        var lw = lambda * w[v];
        scratch[i * 3] = pos[o] + lw * (sx - pos[o]);
        scratch[i * 3 + 1] = pos[o + 1] + lw * (sy - pos[o + 1]);
        scratch[i * 3 + 2] = pos[o + 2] + lw * (sz - pos[o + 2]);
      }
      for (i = 0; i < touched.length; i++) {
        v = touched[i]; o = v * 3;
        pos[o] = scratch[i * 3]; pos[o + 1] = scratch[i * 3 + 1]; pos[o + 2] = scratch[i * 3 + 2];
      }
    }
    return pos;
  }

  var sign = (mode === 'emboss') ? 1 : -1;
  for (i = 0; i < touched.length; i++) {
    v = touched[i]; o = v * 3;
    var a = sign * w[v] * intensity * depth;
    pos[o] = basePos[o] + field.nx[v] * a;
    pos[o + 1] = basePos[o + 1] + field.ny[v] * a;
    pos[o + 2] = basePos[o + 2] + field.nz[v] * a;
  }
  return pos;
}

/* =====================================================================
   5. Seam integrity - the boundary band, relaxed on purpose

   THIS IS THE ANSWER TO "smooth boundary vertices specifically".

   The falloff reaches 0 at the rim, so there is no cliff in the WEIGHT. The
   artifact is in the DERIVATIVE. With hard falloff the weight is still 0.84
   halfway out and 0.47 at t=0.05, so the last ring inside the rim is dragged
   most of the full depth while its neighbour one ring out has not moved at
   all. On a coarse zone those two rings are a millimetre apart and the
   triangle spanning them goes from equilateral to a near-degenerate spike -
   which is a sliver by tools/mesh_validate.py's own definition (longest edge
   over twice the inradius), and the thing the Skin-wrap seam work had to keep
   sweeping back out of its bakes.

   So the band is relaxed, and three things about how:

   1. STRENGTH IS (1 - w). The deep floor of the dab is what the user asked
      for and is not touched. The rim, where w is near 0, relaxes fully. The
      relaxation therefore cannot eat the carve - it can only soften the wall.

   2. FEATURE VERTICES ARE PINNED. The band reaches one ring OUTSIDE the
      brush, into geometry the user did not paint over, and on a coarse piece
      that ring can be the actual corner of the piece. A vertex whose incident
      face normals disagree by more than featureAngle is a real edge of the
      part and is held still. app-sculpt.js says its global pass must never
      grow a feature term and that selective work belongs to the brush tier;
      this is the brush tier, and the term belongs here.

   3. OPEN-EDGE VERTICES ARE PINNED, for the same reason NSO_smoothGlobal pins
      them - an open mesh keeps its rim instead of curling it in.

   The band extends one ring beyond the brush, so it is part of the affected
   set the paint scope and the gate are measured over. That is stated in
   docs/BRUSH.md and it is not a detail: a feature that moves a vertex has to
   count that vertex as its own.
   ===================================================================== */

// Max angle, in degrees, between the face normals incident on each vertex.
// Large means the vertex sits on a real edge of the part.
function NSO_brushFeatureAngles(mesh, graph, verts) {
  var out = new Float64Array(mesh.vertCount);
  var pos = mesh.pos, tri = mesh.tri;
  var vtStart = graph.vtStart, vtList = graph.vtList;
  var ns = [];
  for (var q = 0; q < verts.length; q++) {
    var v = verts[q];
    ns.length = 0;
    for (var i = vtStart[v]; i < vtStart[v + 1]; i++) {
      var t = vtList[i] * 3;
      var a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
      var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      var vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      var cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      var L = Math.hypot(cx, cy, cz);
      if (!(L > 1e-12)) continue;
      ns.push(cx / L, cy / L, cz / L);
    }
    var worst = 0;
    for (var m = 0; m + 2 < ns.length; m += 3) {
      for (var n = m + 3; n + 2 < ns.length; n += 3) {
        var d = ns[m] * ns[n] + ns[m + 1] * ns[n + 1] + ns[m + 2] * ns[n + 2];
        if (d < -1) d = -1; if (d > 1) d = 1;
        var ang = Math.acos(d) * 180 / Math.PI;
        if (ang > worst) worst = ang;
      }
    }
    out[v] = worst;
  }
  return out;
}

/* The band: every vertex on either side of the boundary between moved and
   unmoved, grown `rings` rings out. Returned as a list plus a per-vertex
   flag, because the relaxation wants both. */
function NSO_brushSeamBand(mesh, graph, field, rings) {
  var V = mesh.vertCount, w = field.w;
  var inBand = new Uint8Array(V);
  var list = [];
  var nbrStart = graph.nbrStart, nbrList = graph.nbrList;
  var i, v, j;
  for (i = 0; i < field.touched.length; i++) {
    v = field.touched[i];
    for (j = nbrStart[v]; j < nbrStart[v + 1]; j++) {
      var u = nbrList[j];
      if (w[u] > 0) continue;
      // v is inside the brush, u is outside: both sit on the seam.
      if (!inBand[v]) { inBand[v] = 1; list.push(v); }
      if (!inBand[u]) { inBand[u] = 1; list.push(u); }
    }
  }
  var r = (rings == null) ? 1 : (rings | 0);
  for (var pass = 0; pass < r; pass++) {
    var add = [];
    for (i = 0; i < list.length; i++) {
      v = list[i];
      for (j = nbrStart[v]; j < nbrStart[v + 1]; j++) {
        var u2 = nbrList[j];
        if (!inBand[u2]) { inBand[u2] = 1; add.push(u2); }
      }
    }
    for (i = 0; i < add.length; i++) list.push(add[i]);
  }
  return { list: new Int32Array(list), inBand: inBand };
}

function NSO_brushRelaxSeam(mesh, graph, pos, field, opts) {
  opts = opts || {};
  var passes = (opts.seamPasses == null) ? 3 : (opts.seamPasses | 0);
  var strength = (opts.seamStrength == null) ? 0.5 : +opts.seamStrength;
  var featureAngle = (opts.featureAngle == null) ? 40 : +opts.featureAngle;
  var rings = (opts.seamRings == null) ? 1 : (opts.seamRings | 0);
  var band = NSO_brushSeamBand(mesh, graph, field, rings);
  var out = { moved: 0, band: band.list.length, pinned: 0, passes: 0 };
  if (!band.list.length || passes <= 0 || !(strength > 0)) return out;

  // Feature angles are measured on the BASE mesh, not on the deformed one:
  // the carve itself creates a steep wall, and measuring after would read
  // that wall as a feature and pin the very vertices that need relaxing.
  var ang = NSO_brushFeatureAngles(mesh, graph, band.list);
  var nbrStart = graph.nbrStart, nbrList = graph.nbrList, boundary = graph.boundary;
  var w = field.w;
  var movable = [];
  for (var i = 0; i < band.list.length; i++) {
    var v = band.list[i];
    if (boundary[v] || ang[v] > featureAngle) { out.pinned++; continue; }
    movable.push(v);
  }
  if (!movable.length) return out;

  var scratch = new Float64Array(movable.length * 3);
  for (var p = 0; p < passes; p++) {
    for (var q = 0; q < movable.length; q++) {
      var v2 = movable[q], o = v2 * 3;
      var s = nbrStart[v2], e = nbrStart[v2 + 1], k = e - s;
      if (k === 0) {
        scratch[q * 3] = pos[o]; scratch[q * 3 + 1] = pos[o + 1]; scratch[q * 3 + 2] = pos[o + 2];
        continue;
      }
      var sx = 0, sy = 0, sz = 0;
      for (var j = s; j < e; j++) {
        var n3 = nbrList[j] * 3;
        sx += pos[n3]; sy += pos[n3 + 1]; sz += pos[n3 + 2];
      }
      sx /= k; sy /= k; sz /= k;
      // (1 - w): the floor of the dab is the user's ask and stays put.
      var lw = strength * (1 - w[v2]);
      scratch[q * 3] = pos[o] + lw * (sx - pos[o]);
      scratch[q * 3 + 1] = pos[o + 1] + lw * (sy - pos[o + 1]);
      scratch[q * 3 + 2] = pos[o + 2] + lw * (sz - pos[o + 2]);
    }
    for (var q2 = 0; q2 < movable.length; q2++) {
      var v3 = movable[q2], o2 = v3 * 3;
      pos[o2] = scratch[q2 * 3]; pos[o2 + 1] = scratch[q2 * 3 + 1]; pos[o2 + 2] = scratch[q2 * 3 + 2];
    }
    out.passes = p + 1;
  }
  out.moved = movable.length;
  out.bandList = band.list;
  out.inBand = band.inBand;
  return out;
}

/* =====================================================================
   6. Audits and the gate

   Two audits this feature owns, then one gate that refuses on any of them
   plus the canonical self-intersection count.
   ===================================================================== */

/* Sliver / degenerate count, on tools/mesh_validate.py's definition exactly:
   aspect = longest edge / (2 * inradius), inradius = area / semiperimeter,
   equilateral = 1, threshold 100. Transcribed rather than invented so the
   number this feature reports and the number the canonical checker reports
   are the same number. */
function NSO_brushSliverAudit(rawTris, aspectLimit) {
  var limit = (aspectLimit == null) ? 100 : +aspectLimit;
  var n = (rawTris.length / 9) | 0;
  var slivers = 0, degen = 0, worst = 0;
  for (var t = 0; t < n; t++) {
    var o = t * 9;
    var ax = rawTris[o], ay = rawTris[o + 1], az = rawTris[o + 2];
    var bx = rawTris[o + 3], by = rawTris[o + 4], bz = rawTris[o + 5];
    var cx = rawTris[o + 6], cy = rawTris[o + 7], cz = rawTris[o + 8];
    var ea = Math.hypot(bx - ax, by - ay, bz - az);
    var eb = Math.hypot(cx - bx, cy - by, cz - bz);
    var ec = Math.hypot(ax - cx, ay - cy, az - cz);
    var ux = bx - ax, uy = by - ay, uz = bz - az;
    var vx = cx - ax, vy = cy - ay, vz = cz - az;
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var area = Math.hypot(nx, ny, nz) * 0.5;
    var s = (ea + eb + ec) * 0.5;
    if (!(area > 0) || !(s > 0)) { degen++; slivers++; worst = Infinity; continue; }
    var inr = area / s;
    if (!(inr > 0)) { degen++; slivers++; worst = Infinity; continue; }
    var asp = Math.max(ea, eb, ec) / (2 * inr);
    if (asp > worst) worst = asp;
    if (asp > limit) slivers++;
  }
  return { slivers: slivers, degenerate: degen, worstAspect: worst, limit: limit };
}

/* T-junction audit: a welded vertex sitting in the INTERIOR of some
   triangle's edge. Section 3 cannot produce one - splits are per edge and
   shared - so this is here to prove that on real meshes rather than to
   argue it, and to catch one arriving from anywhere else.

   Detection is the sweep app-finish.js already uses for its cure: hash the
   welded points, walk only the cells a segment actually passes through, and
   test perpendicular distance with the parameter strictly inside (0,1).
   opts.maxEdges bounds it so a big part cannot hang a test run. */
function NSO_brushTJunctionAudit(rawTris, opts) {
  opts = opts || {};
  var tol = (opts.tol == null) ? 1e-4 : +opts.tol;
  var q = 1e4;
  var n = (rawTris.length / 9) | 0;
  var vk = function (x, y, z) {
    return Math.round(x * q) + '|' + Math.round(y * q) + '|' + Math.round(z * q);
  };
  var pts = new Map();
  var i, t;
  for (i = 0; i < rawTris.length; i += 3) {
    var k = vk(rawTris[i], rawTris[i + 1], rawTris[i + 2]);
    if (!pts.has(k)) pts.set(k, [rawTris[i], rawTris[i + 1], rawTris[i + 2]]);
  }
  var CELL = (opts.cell > 0) ? opts.cell : 1.0;
  var grid = new Map();
  pts.forEach(function (p) {
    var k2 = Math.floor(p[0] / CELL) + '|' + Math.floor(p[1] / CELL) + '|' + Math.floor(p[2] / CELL);
    var b = grid.get(k2);
    if (b) b.push(p); else grid.set(k2, [p]);
  });

  var hits = 0, checked = 0;
  var maxEdges = (opts.maxEdges == null) ? 600000 : (opts.maxEdges | 0);
  var seenEdge = new Set();
  for (t = 0; t < n; t++) {
    var o = t * 9;
    var V = [[rawTris[o], rawTris[o + 1], rawTris[o + 2]],
             [rawTris[o + 3], rawTris[o + 4], rawTris[o + 5]],
             [rawTris[o + 6], rawTris[o + 7], rawTris[o + 8]]];
    var K = [vk(V[0][0], V[0][1], V[0][2]), vk(V[1][0], V[1][1], V[1][2]), vk(V[2][0], V[2][1], V[2][2])];
    for (var e = 0; e < 3; e++) {
      var a = V[e], b2 = V[(e + 1) % 3];
      var ka = K[e], kb = K[(e + 1) % 3];
      if (ka === kb) continue;
      var ek = ka < kb ? ka + '~' + kb : kb + '~' + ka;
      if (seenEdge.has(ek)) continue;
      seenEdge.add(ek);
      if (++checked > maxEdges) return { tJunctions: hits, edges: checked, capped: true, tol: tol };
      var ex = b2[0] - a[0], ey = b2[1] - a[1], ez = b2[2] - a[2];
      var len2 = ex * ex + ey * ey + ez * ez;
      if (!(len2 > 1e-12)) continue;
      var inv = 1 / Math.sqrt(len2);
      var len = Math.sqrt(len2);
      var steps = Math.max(1, Math.ceil(len / (CELL * 0.5)));
      var cells = new Set();
      for (var sI = 0; sI <= steps; sI++) {
        var tt = sI / steps;
        var gx = Math.floor((a[0] + ex * tt) / CELL);
        var gy = Math.floor((a[1] + ey * tt) / CELL);
        var gz = Math.floor((a[2] + ez * tt) / CELL);
        for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++)
          cells.add((gx + dx) + '|' + (gy + dy) + '|' + (gz + dz));
      }
      var seenP = new Set();
      cells.forEach(function (ck) {
        var g = grid.get(ck);
        if (!g) return;
        for (var gi = 0; gi < g.length; gi++) {
          var p = g[gi];
          var pk = vk(p[0], p[1], p[2]);
          if (pk === ka || pk === kb || seenP.has(pk)) continue;
          seenP.add(pk);
          var u = ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey + (p[2] - a[2]) * ez) / len2;
          if (u <= 1e-6 || u >= 1 - 1e-6) continue;
          var cx2 = (p[1] - a[1]) * ez - (p[2] - a[2]) * ey;
          var cy2 = (p[2] - a[2]) * ex - (p[0] - a[0]) * ez;
          var cz2 = (p[0] - a[0]) * ey - (p[1] - a[1]) * ex;
          if (Math.hypot(cx2, cy2, cz2) * inv > tol) continue;
          hits++;
        }
      });
    }
  }
  return { tJunctions: hits, edges: checked, capped: false, tol: tol };
}

/* The canonical self-intersection count.

   NSO_Repair.js is the browser transcription of tools/mesh_validate.py, and
   tools/nso_selfint_equiv_test.js asserts the two agree pair-for-pair on
   every fixture in the repo. So this feature does not get its own copy - it
   calls that one, on the welded mesh, which is the policy that consolidation
   settled on.

   MISSING IS A REFUSAL, not a skip. Task 4's gate is "refuse on increased
   self-intersection count"; a gate that quietly does not run when its checker
   is absent is not a gate. */
function NSO_brushSelfInt(rawTris, opts) {
  opts = opts || {};
  var R = opts.repair || (typeof NSO_Repair !== 'undefined' ? NSO_Repair : null) ||
          (typeof window !== 'undefined' ? window.NSO_Repair : null);
  if (!R || typeof R._selfIntersectionDetail !== 'function' || typeof R._weldToIndexed !== 'function') {
    return { ok: false, reason: 'canonical self-intersection checker (NSO_Repair) not loaded' };
  }
  var tol = (opts.weldTol == null) ? 1e-4 : +opts.weldTol;
  var d = R._selfIntersectionDetail(R._weldToIndexed(rawTris, tol).mesh);
  return { ok: true, pierce: d.pierce, coplanar: d.coplanar };
}

/* Every number this feature is judged on, in one place. */
function NSO_brushScore(rawTris, opts) {
  opts = opts || {};
  var adj = opts.adj || (typeof NSO_buildAdjacency === 'function' ? NSO_buildAdjacency(rawTris, { tol: opts.weldTol }) : null);
  var m = (typeof NSO_sculptMetrics === 'function') ? NSO_sculptMetrics(rawTris, adj) : { tris: (rawTris.length / 9) | 0 };
  var sl = NSO_brushSliverAudit(rawTris, opts.aspectLimit);
  var tj = NSO_brushTJunctionAudit(rawTris, opts.tjunction);
  var si = (opts.selfInt === false) ? { ok: true, pierce: null, coplanar: null }
                                    : NSO_brushSelfInt(rawTris, opts);
  return {
    tris: m.tris, verts: m.verts, volume: m.volume, area: m.area,
    openPos: m.openPos, nmPos: m.nmPos, openIdx: m.openIdx, nmIdx: m.nmIdx,
    stackedDirs: m.stackedDirs, watertight: m.watertight,
    degenerate: sl.degenerate, slivers: sl.slivers, worstAspect: sl.worstAspect,
    tJunctions: tj.tJunctions, tjCapped: tj.capped,
    selfIntOk: si.ok, selfIntReason: si.reason,
    pierce: si.pierce, coplanar: si.coplanar,
    bbox: m.bbox
  };
}

/* The gate. Refuses, and the caller reverts - never "commits anyway with a
   warning". Ordered so the first line of a refusal names the worst thing
   that happened, not the first thing measured.

   The triangle count is NOT a gate here, unlike NSO_smoothGlobal where it is:
   refinement changes it on purpose, and a brush that refused to add
   triangles could not carve a coarse face at all. */
function NSO_brushGate(before, after, opts) {
  opts = opts || {};
  if (!after.selfIntOk) return { ok: false, reason: after.selfIntReason || 'self-intersection check unavailable' };
  if (!before.selfIntOk) return { ok: false, reason: before.selfIntReason || 'self-intersection check unavailable' };

  if (after.pierce != null && before.pierce != null && after.pierce > before.pierce) {
    return { ok: false, reason: 'self-intersections rose ' + before.pierce + '→' + after.pierce };
  }
  if (after.openPos > before.openPos) return { ok: false, reason: 'open edges rose ' + before.openPos + '→' + after.openPos };
  if (after.nmPos > before.nmPos) return { ok: false, reason: 'non-manifold edges rose ' + before.nmPos + '→' + after.nmPos };
  if (after.openIdx != null && before.openIdx != null && after.openIdx > before.openIdx)
    return { ok: false, reason: 'indexed open edges rose ' + before.openIdx + '→' + after.openIdx };
  if (after.stackedDirs != null && before.stackedDirs != null && after.stackedDirs > before.stackedDirs)
    return { ok: false, reason: 'backwards-wound edges rose ' + before.stackedDirs + '→' + after.stackedDirs };
  if (after.tJunctions > before.tJunctions)
    return { ok: false, reason: 'T-junctions rose ' + before.tJunctions + '→' + after.tJunctions };
  if (after.degenerate > before.degenerate)
    return { ok: false, reason: 'degenerate triangles rose ' + before.degenerate + '→' + after.degenerate };
  if (after.slivers > before.slivers)
    return { ok: false, reason: 'sliver triangles rose ' + before.slivers + '→' + after.slivers };
  if (!isFinite(after.volume)) return { ok: false, reason: 'volume not finite' };
  if (before.volume !== 0 && Math.sign(after.volume) !== Math.sign(before.volume))
    return { ok: false, reason: 'volume flipped sign' };
  var budget = (opts.maxVolumeChange == null) ? 0.25 : +opts.maxVolumeChange;
  if (budget > 0 && before.volume !== 0) {
    var ch = Math.abs(after.volume) / Math.abs(before.volume) - 1;
    if (Math.abs(ch) > budget) {
      return { ok: false, reason: 'volume ' + (ch < 0 ? 'loss ' : 'gain ') +
                                  Math.abs(ch * 100).toFixed(2) + '% over budget' };
    }
  }
  return { ok: true, reason: '' };
}

/* =====================================================================
   6c. THE LIVE WALL GATE - proactive, per dab, before the surface moves

   A SECOND AND INDEPENDENT LAYER, not a restatement of the one above.

   What already exists: NSO_brushFacing, the area-weighted front-facing filter
   at section 2. A stamp's vertices are kept only when their (area-weighted)
   vertex normal faces the way the stamp does, so a dab on the near wall of a
   thin piece cannot reach round and drag the FAR wall's vertices with it. That
   is the "the stroke reaches through to the other side" failure and it is
   fixed.

   What it does not cover, at all: a dab that only ever touches the near face
   and still leaves 0.2 mm of wall behind it. The far face never moved, the
   facing filter never had an opinion, the mesh that comes out is closed, sound,
   manifold and unprintable. Every check in NSO_brushGate above is a TOPOLOGY
   check - self-intersections, open edges, T-junctions, slivers, a volume budget
   - and none of them has any notion of how thick a wall is. A 0.2 mm wall
   passes all of them.

   So this gate asks the one question none of the others do, and asks it BEFORE
   the dab lands rather than after: how much wall is under this point, and what
   does a dab this deep leave of it? The answer comes from
   NSO_Thickness.prepare(), built once per stroke at pointerdown and walked per
   dab - which is the whole reason that entry point exists; measureMesh() would
   re-weld the piece on every pointermove.

   CHECKED THREE TIMES, deliberately, in the shape section 7's paint stand-down
   already uses: on the first dab, so a stroke that cannot land is refused
   before the user drags a groove they will not get; on every dab after it, so
   a drag that travels onto a thin wall is stopped at the wall rather than
   through it; and once over the whole stroke at pointerup, against the RESULT
   rather than the input, because the dabs overlap and the deepest point of the
   finished stroke is not the deepest point of any one dab.

   CARVE ONLY. Emboss moves the surface outward - it can only make a wall
   thicker - and local Smooth moves vertices along no fixed direction and by an
   amount the Laplacian decides, so there is no "depth" to gate. Both are
   reported as not gated rather than silently waved through.
   ===================================================================== */

/* How deep the CENTRE of one dab cuts, in mm. This is NSO_brushDeform's own
   arithmetic - w * intensity * depthScale * radius at w = 1 - named once here
   so the gate cannot drift from what the deformation actually does. */
function NSO_brushDabDepth(opts) {
  opts = opts || {};
  if (opts.mode === 'emboss' || opts.mode === 'smooth') return 0;
  var intensity = (opts.intensity == null) ? 0.5 : +opts.intensity;
  var radius = opts.radius > 0 ? opts.radius : 1;
  var scale = (opts.depthScale == null) ? 0.25 : +opts.depthScale;
  return Math.max(0, intensity * scale * radius);
}

/* One dab against the canonical floor. `probe` is an NSO_Thickness.prepare()
   result over the piece's raw soup; `point` and `normal` are in that same raw
   frame. Returns the gate report, whose `.ok` is the verdict and whose
   `.reason` is already worded. */
function NSO_brushWallGate(probe, point, normal, opts) {
  opts = opts || {};
  var depth = (opts.depth != null) ? +opts.depth : NSO_brushDabDepth(opts);
  if (!probe) {
    return { ok: true, skipped: true, kind: 'stroke', label: 'brush',
             reason: 'wall gate unavailable - nso_thickness.js is not loaded' };
  }
  if (!(depth > 0)) {
    return { ok: true, skipped: true, kind: 'stroke', label: 'brush',
             reason: 'not gated - ' + (opts.mode === 'emboss' ? 'Emboss adds material' :
                     (opts.mode === 'smooth' ? 'Smooth has no cut depth' : 'nothing to remove')) };
  }
  return probe.strokeGate({
    point: point, normal: normal, depth: depth, label: 'brush stroke',
    nozzle: opts.nozzle, minWall: opts.minWall
  });
}

/* The pointerup layer: the FINISHED stroke, measured on the result.

   The per-dab gate reads the piece as it was; the dabs overlap, so the deepest
   point of the finished stroke is deeper than any single dab's arithmetic
   predicts. This measures what actually came out, at the places the stroke
   touched, and is the layer that catches an overlap the per-dab gate let by
   one at a time. */
function NSO_brushWallGateResult(outTris, stamps, opts) {
  opts = opts || {};
  var TH = (typeof NSO_Thickness !== 'undefined') ? NSO_Thickness : null;
  if (!TH || typeof TH.prepare !== 'function' || !stamps || !stamps.length) {
    return { ok: true, skipped: true, reason: 'wall gate unavailable', thin: 0 };
  }
  if (NSO_brushDabDepth(opts) <= 0) {
    return { ok: true, skipped: true, reason: 'not gated - this mode removes nothing', thin: 0 };
  }
  var P = TH.prepare(outTris, { nozzle: opts.nozzle, minWall: opts.minWall });
  if (!P) return { ok: true, skipped: true, reason: 'wall gate unavailable', thin: 0 };
  var worst = null, thin = 0;
  for (var i = 0; i < stamps.length; i++) {
    /* depth 0: the cut has already happened, so the question is no longer
       "what would this leave" but "what did it leave". */
    var g = P.strokeGate({ point: stamps[i].c, depth: 0, label: 'brush stroke',
                           nozzle: opts.nozzle, minWall: opts.minWall });
    if (!g.measured) continue;
    if (worst === null || g.wall_mm < worst.wall_mm) worst = g;
    if (!g.ok) thin++;
  }
  if (!worst) return { ok: true, skipped: true, reason: 'nothing measurable under the stroke', thin: 0 };
  worst.thin = thin;
  return worst;
}

/* =====================================================================
   6b. One stroke, start to finish, headless

   The app wiring in section 7 does this incrementally so it can show a live
   preview; this is the same pipeline in one call, and it is what
   tools/nso_brush_test.js drives. Both end at the same numbers because both
   apply every stamp to the undeformed base - see THE BASE RULE.
   ===================================================================== */

function NSO_brushZones(stamps) {
  var z = [];
  for (var i = 0; i < stamps.length; i++) z.push({ c: stamps[i].c, r: stamps[i].r });
  return z;
}

function NSO_brushApply(rawTris, stamps, opts) {
  opts = opts || {};
  var res = { ok: false, reason: '', tris: rawTris };
  if (!rawTris || rawTris.length < 9) { res.reason = 'empty soup'; return res; }
  if (!stamps || !stamps.length) { res.reason = 'no stamps'; return res; }
  if (typeof NSO_buildAdjacency !== 'function') { res.reason = 'app-sculpt.js not loaded'; return res; }

  var adj = NSO_buildAdjacency(rawTris, { tol: opts.weldTol });
  if (!adj.ok) { res.reason = 'adjacency: ' + adj.reason; return res; }

  var base = NSO_brushMesh(adj);
  // The welded soup is the honest before: welding drops slivers and nudges
  // duplicates onto one representative, and that change belongs to the weld.
  var baseTris = NSO_brushToRaw(base);
  res.before = NSO_brushScore(baseTris, { adj: adj, weldTol: opts.weldTol,
                                          selfInt: opts.selfInt, tjunction: opts.tjunction });

  var minR = Infinity;
  for (var i = 0; i < stamps.length; i++) if (stamps[i].r < minR) minR = stamps[i].r;
  var target = (opts.targetEdge != null) ? +opts.targetEdge
                                         : NSO_brushTargetEdge(minR, opts.samples);
  var ref = NSO_brushRefine(base, NSO_brushZones(stamps), {
    target: target, maxPasses: opts.maxRefinePasses, maxTris: opts.maxTris
  });
  var mesh = ref.mesh;
  res.refine = { passes: ref.passes, splits: ref.splits, capped: ref.capped, target: target,
                 trisBefore: base.triCount, trisAfter: mesh.triCount };

  var graph = NSO_brushGraph(mesh);
  var normals = NSO_brushVertexNormals(mesh);
  var field = NSO_brushWeights(mesh, stamps, { normals: normals, frontOnly: opts.frontOnly, front: opts.front });
  res.selected = field.touched.length;
  if (!field.touched.length) { res.reason = 'the brush reached no vertices'; return res; }

  var basePos = new Float64Array(mesh.pos);
  var pos = NSO_brushDeform(mesh, basePos, field, {
    mode: opts.mode, intensity: opts.intensity, radius: minR,
    depthScale: opts.depthScale, smoothPasses: opts.smoothPasses, graph: graph
  });

  var seam = (opts.seam === false) ? { moved: 0, band: 0, pinned: 0, passes: 0 }
    : NSO_brushRelaxSeam({ pos: basePos, tri: mesh.tri, vertCount: mesh.vertCount, triCount: mesh.triCount },
                         graph, pos, field, opts);
  res.seam = seam;

  var outTris = NSO_brushToRaw(mesh, pos);
  res.after = NSO_brushScore(outTris, { weldTol: opts.weldTol, selfInt: opts.selfInt,
                                        tjunction: opts.tjunction });

  var moved = 0, maxMove = 0;
  for (var v = 0; v < mesh.vertCount; v++) {
    var o = v * 3;
    var d = Math.hypot(pos[o] - basePos[o], pos[o + 1] - basePos[o + 1], pos[o + 2] - basePos[o + 2]);
    if (d > 1e-9) moved++;
    if (d > maxMove) maxMove = d;
  }
  res.moved = moved;
  res.maxMove = maxMove;

  if (opts.gate !== false) {
    var g = NSO_brushGate(res.before, res.after, opts);
    if (!g.ok) { res.reason = g.reason; res.tris = rawTris; return res; }
  }
  res.ok = true;
  res.tris = outTris;
  res.mesh = mesh;
  res.field = field;
  res.graph = graph;
  return res;
}

/* =====================================================================
   6c. Paint scope

   PAINT SCOPE: SUB-REGION. See the scoping rule in docs/HANDOFF.md.

   The brush acts on an identifiable sub-region - the vertices its stamps
   reach, plus the one-ring seam band section 5 relaxes - so it checks only
   the painted faces that sub-region actually lies on. Paint anywhere else on
   the piece does not stand it down. This is the same rule the whole-piece
   features apply at their own scope, NOT a laxer reading of it: Smooth stands
   down on any paint because global Laplacian smoothing moves every unpinned
   vertex and has no sub-region to scope a check to. This one does.

   THE SEAM BAND COUNTS. It reaches one ring outside the brush into geometry
   the user never dragged over, and section 5 moves those vertices. A feature
   that moves a vertex has to count that vertex as its own, so the affected
   set is the union - not the brush disc.

   OPERAND: NONE. docs/HANDOFF.md's operand/veto rule asks two questions - what
   does this act ON (the SELECT list, if anything) and what must it not touch
   (the EXCLUDE list, always). The brush's operand is a GESTURE: the surface
   under the cursor, aimed by dragging. So it never reads the select list, and
   it does read the exclude list, because the second question always has an
   answer.

   The planes come from nsoMaskPlaneList, which reads back what each click
   recorded. Nothing here re-derives which face was meant from a normal and a
   bounding box; docs/HANDOFF.md is explicit that the second mapping is what
   put the yellow on one face and the exclude on another.

   A vertex lying ON a painted plane counts as touching that face. That
   over-triggers at a shared corner - a vertex where three faces meet lies on
   all three planes - and over-triggering is the safe direction for a rule
   whose whole point is that forgetting must not bake over paint. */
function NSO_brushAffectedPoints(mesh, field, seam) {
  var out = [];
  var pos = mesh.pos, i, v, o;
  for (i = 0; i < field.touched.length; i++) {
    v = field.touched[i]; o = v * 3;
    out.push(pos[o], pos[o + 1], pos[o + 2]);
  }
  var band = seam && seam.bandList;
  if (band) {
    for (i = 0; i < band.length; i++) {
      v = band[i]; o = v * 3;
      out.push(pos[o], pos[o + 1], pos[o + 2]);
    }
  }
  return new Float64Array(out);
}

function NSO_brushPaintCheck(planes, points, tol) {
  var t = (tol == null) ? 1e-3 : +tol;
  var hit = [];
  if (!planes || !planes.length || !points || !points.length) return { any: false, painted: hit };
  for (var p = 0; p < planes.length; p++) {
    var pl = planes[p];
    if (!pl || !pl.n) continue;
    for (var i = 0; i + 2 < points.length; i += 3) {
      var d = pl.n[0] * points[i] + pl.n[1] * points[i + 1] + pl.n[2] * points[i + 2] - pl.d;
      if (Math.abs(d) <= t) { hit.push(pl); break; }
    }
  }
  return { any: hit.length > 0, painted: hit };
}

function NSO_brushPaintName(pl) {
  if (!pl) return 'a painted face';
  if (pl.axisIdx == null) return 'a painted recessed face';
  return (pl.inner ? 'the inner ' : 'the ') + 'XYZ'.charAt(pl.axisIdx) +
         (pl.keepMin ? '-' : '+') + ' face';
}

/* The stand-down line, in the same shape the four wired bakes already use so
   the roster reads as one rule rather than five dialects. It names the faces
   because a sub-region feature that says "2 painted" alone has not told the
   user which two, or why the brush they are holding stopped. */
function NSO_brushStandDownStatus(painted) {
  var names = [];
  for (var i = 0; i < painted.length; i++) names.push(NSO_brushPaintName(painted[i]));
  return 'Brush stood down - ' + painted.length + ' painted face(s); the stroke reaches ' +
         names.join(', ') + '. The brush moves those vertices and the seam band around them, ' +
         'so it cannot hold that face still. Clear the paint there, or brush somewhere else ' +
         '(paint elsewhere on the piece does not stop it).';
}

/* =====================================================================
   7. App wiring - the stroke session, the ring, the buttons

   Everything above runs with no DOM, no Three.js and no app state. This part
   is the interaction, and it is the part with no precedent in this repo (see
   the AUDIT at the top). Three things it has to get right:

   ONE UNDO ENTRY. The stroke is one operation. pushUndo is called once, at
   pointerup, through NSO_sculptCommitRaw - the same commit half Smooth uses,
   so undo names the brush and puts the piece back in one press.

   THE PREVIEW IS NOT A COMMIT. During the drag the placed mesh is shown a
   throwaway geometry; m.geometry and m.rawTris are not touched at all. A
   refused stroke, a cancelled stroke and a lost pointer all end by putting
   the original geometry back and disposing the preview. Nothing downstream -
   export, the checker, Join, the mask - can see a stroke that did not commit.

   THE PREVIEW RUNS THE SAME PIPELINE THE COMMIT WILL. Weights, deformation
   and the seam relax are identical; the commit adds the gate and the bake.
   So what the user lets go of is what they get, unless the gate refuses it,
   and the only way to be surprised is to be told why.
   ===================================================================== */
if (typeof document !== 'undefined') (function () {
  var SEGMENTS = 64;
  // Above the paint overlay (40), which is itself above every other helper.
  // The ring says where the next dab lands and nothing may cover it.
  var RING_ORDER = 60;
  // Dab spacing along the drag, as a fraction of the radius. Below about 0.2
  // the stamps are redundant (max-accumulation makes them no-ops); above 0.5
  // a fast drag leaves a scalloped groove instead of a smooth one.
  var SPACING = 0.25;
  // Refinement is done in generous zones so a drag does not re-refine on
  // every dab; 1.8 radii keeps a normal stroke to a handful of rebuilds.
  var REFINE_MARGIN = 1.8;

  var ring = null, ringVisible = false;
  var session = null;
  var armed = false;

  function model() { return (typeof getActiveModel === 'function') ? getActiveModel() : null; }
  function say(t, bad) { if (typeof setStatus === 'function') setStatus(t, !!bad); }
  function el(id) { return document.getElementById(id); }

  /* raw <-> display, measured off the piece the same way app-mask.js measures
     it. The display mesh is the raw soup rotated -90deg about X and then
     centred, so the transform is fixed apart from that centring, and the
     centring is measured rather than assumed - a piece rebuilt by the kernel
     and a piece straight off a bake do not carry the same one. */
  function frameOf(m) {
    if (!m || !m.rawTris || !m.rawTris.length) return null;
    var r = m.rawTris;
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < r.length; i += 3) {
      var d = [r[i], r[i + 2], -r[i + 1]];
      for (var k = 0; k < 3; k++) {
        if (d[k] < lo[k]) lo[k] = d[k];
        if (d[k] > hi[k]) hi[k] = d[k];
      }
    }
    return { c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] };
  }
  function rawPointFromLocal(f, p) {
    var d = [p[0] + f.c[0], p[1] + f.c[1], p[2] + f.c[2]];
    return [d[0], -d[2], d[1]];
  }
  function rawDirFromLocal(v) { return [v[0], -v[2], v[1]]; }

  /* ---- the controls ---- */
  function readOpts() {
    var size = el('inp-brush-size'), force = el('inp-brush-intensity');
    var mode = el('sel-brush-mode'), hard = el('chk-brush-hard');
    var r = size ? parseFloat(size.value) : 12;
    if (!(r > 0)) r = 12;
    var it = force ? parseFloat(force.value) : 0.5;
    if (!(it >= 0)) it = 0.5;
    return {
      radius: r,
      intensity: it,
      mode: mode ? mode.value : 'carve',
      falloff: (hard && hard.checked) ? 'hard' : 'soft'
    };
  }
  function syncLabels() {
    var o = readOpts();
    var a = el('out-brush-size'), b = el('out-brush-intensity');
    if (a) a.textContent = o.radius.toFixed(0) + ' mm';
    if (b) b.textContent = o.intensity.toFixed(2);
    if (ring && ringVisible) buildRing(o.radius);
  }

  /* ---- the ring ----
     A LineLoop in the scene rather than the model group, so it is never
     raycast, never exported and never picked up by anything that walks the
     pieces. Same trick app-mask.js and app-sel-outline.js use on their own
     overlays. */
  function buildRing(radius) {
    if (typeof THREE === 'undefined' || !state || !state.scene) return;
    var pts = [];
    for (var i = 0; i < SEGMENTS; i++) {
      var a = (i / SEGMENTS) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
    }
    var geo = new THREE.BufferGeometry().setFromPoints(pts);
    if (!ring) {
      var mat = new THREE.LineBasicMaterial({ color: 0xe8a33d, depthTest: false, transparent: true, opacity: 0.95 });
      ring = new THREE.LineLoop(geo, mat);
      ring.renderOrder = RING_ORDER;
      ring.raycast = function () {};
      ring.visible = false;
      state.scene.add(ring);
    } else {
      if (ring.geometry) ring.geometry.dispose();
      ring.geometry = geo;
    }
  }
  function showRing(point, normalWorld, radius) {
    buildRing(radius);
    if (!ring) return;
    ring.position.copy(point);
    // Lift the ring off the surface so it is not z-fought by the face it sits
    // on; depthTest is off anyway, this keeps it from looking embedded.
    ring.position.addScaledVector(normalWorld, 0.05);
    var q = new THREE.Quaternion();
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normalWorld.clone().normalize());
    ring.quaternion.copy(q);
    ring.visible = true;
    ringVisible = true;
  }
  function hideRing() {
    if (ring) ring.visible = false;
    ringVisible = false;
  }

  /* ---- picking ---- */
  function pick(event) {
    if (!state || !state.renderer || !state.camera || !state.modelGroup) return null;
    if (typeof setPointerFromEvent !== 'function') return null;
    setPointerFromEvent(event);
    state.raycaster.setFromCamera(state.pointer, state.camera);
    var hits = state.raycaster.intersectObjects(state.modelGroup.children, true);
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (h.faceIndex == null || !h.face) continue;
      var obj = h.object;
      while (obj && obj.userData.placedIndex == null && obj.parent) obj = obj.parent;
      var idx = obj && obj.userData ? obj.userData.placedIndex : undefined;
      if (typeof idx !== 'number' || !state.placed[idx]) continue;
      var placed = state.placed[idx];
      var m = state.models.find(function (mm) { return mm.id === placed.sourceId; });
      if (!m || !m.rawTris || m.rawAxis !== 'zup') continue;
      return { hit: h, placed: placed, idx: idx, m: m, mesh: placed.mesh };
    }
    return null;
  }

  /* ---- display geometry, written straight from the indexed mesh ----
     rawResultToDisplayGeometry does the same rotation but re-centres on the
     new bounding box, which during a drag would make the piece slide out from
     under the cursor as the carve changes its extent. The centring is
     captured once at pointerdown and held for the whole stroke; the commit
     goes through the normal path and re-centres properly there. */
  function writeDisplay(s, verts) {
    var mesh = s.base, pos = s.pos, c = s.centre, arr = s.disp;
    var tri = mesh.tri;
    function tri9(t) {
      var o = t * 9;
      for (var v = 0; v < 3; v++) {
        var i = tri[t * 3 + v] * 3, q = o + v * 3;
        arr[q] = pos[i] - c[0];
        arr[q + 1] = pos[i + 2] - c[1];
        arr[q + 2] = -pos[i + 1] - c[2];
      }
    }
    if (!verts) {
      for (var t = 0; t < mesh.triCount; t++) tri9(t);
      return;
    }
    // Only the triangles incident on the vertices that moved. On a piece with
    // a hundred thousand triangles this is the difference between a brush and
    // a slideshow.
    var g = s.graph, seen = s.triSeen;
    for (var i = 0; i < verts.length; i++) {
      var v2 = verts[i];
      for (var j = g.vtStart[v2]; j < g.vtStart[v2 + 1]; j++) {
        var t2 = g.vtList[j];
        if (seen[t2] === s.drawStamp) continue;
        seen[t2] = s.drawStamp;
        tri9(t2);
      }
    }
  }

  function makePreviewGeometry(s) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(s.disp, 3));
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }

  /* ---- the stroke ---- */
  function recompute(s, full) {
    /* Every vertex this stroke has EVER moved goes back to base first, so a
       recompute is a pure function of (base, stamps) and repeated recomputes
       cannot drift. THE BASE RULE, enforced.

       `dirty` is a running union, not this frame's set. The seam band moves
       outward as the stroke grows, and a vertex that was in it last frame and
       is not in it now still has to be reset and redrawn - otherwise it keeps
       last frame's relax on screen and in the committed soup. */
    var reset = s.dirty.length ? new Int32Array(s.dirty) : s.field.touched;
    s.pos = NSO_brushDeform(s.base, s.basePos, s.field, {
      mode: s.opts.mode, intensity: s.opts.intensity, radius: s.opts.radius,
      smoothPasses: s.smoothPasses, graph: s.graph, out: s.pos, reset: reset
    });
    s.seam = NSO_brushRelaxSeam(
      { pos: s.basePos, tri: s.base.tri, vertCount: s.base.vertCount, triCount: s.base.triCount },
      s.graph, s.pos, s.field, s.seamOpts);

    var i, v;
    for (i = 0; i < s.field.touched.length; i++) {
      v = s.field.touched[i];
      if (!s.dirtySeen[v]) { s.dirtySeen[v] = 1; s.dirty.push(v); }
    }
    if (s.seam && s.seam.bandList) {
      for (i = 0; i < s.seam.bandList.length; i++) {
        v = s.seam.bandList[i];
        if (!s.dirtySeen[v]) { s.dirtySeen[v] = 1; s.dirty.push(v); }
      }
    }

    s.drawStamp++;
    // Redraw this frame's movers plus everything the reset put back, which is
    // the whole running union - cheap, because it only ever covers the stroke.
    writeDisplay(s, full ? null : s.dirty);
  }

  function redraw(s) {
    if (!s.previewGeo) return;
    var attr = s.previewGeo.getAttribute('position');
    attr.needsUpdate = true;
    s.previewGeo.computeVertexNormals();
    s.previewGeo.computeBoundingSphere();
  }

  /* Refinement, mid-stroke. The zone is refined on the BASE mesh - the
     undeformed one - and then every stamp so far is re-applied, so the result
     after a refinement is exactly the result that would have come from a mesh
     refined at the start. Refining the deformed mesh instead would bake the
     carve into the new midpoints and there would be no base left to reset to. */
  function ensureRefined(s, centre) {
    var r = s.opts.radius, i;
    for (i = 0; i < s.refined.length; i++) {
      var z = s.refined[i];
      var d = Math.hypot(centre[0] - z.c[0], centre[1] - z.c[1], centre[2] - z.c[2]);
      if (d + r <= z.r) return false;
    }
    var zone = { c: [centre[0], centre[1], centre[2]], r: r * REFINE_MARGIN };
    var ref = NSO_brushRefine(s.base, [zone], {
      target: s.target, maxPasses: s.maxRefinePasses, maxTris: s.maxTris
    });
    s.refined.push(zone);
    if (ref.mesh === s.base) return false;

    s.base = ref.mesh;
    s.refineSplits += ref.splits;
    s.refineCapped = s.refineCapped || ref.capped;
    s.basePos = new Float64Array(s.base.pos);
    s.graph = NSO_brushGraph(s.base);
    s.hash = NSO_brushHash(s.base, Math.max(2, s.opts.radius));
    s.normals = NSO_brushVertexNormals(s.base);
    s.pos = new Float64Array(s.basePos);
    s.field = NSO_brushWeights(s.base, s.stamps, { hash: s.hash, normals: s.normals });
    s.dirty = [];
    s.dirtySeen = new Uint8Array(s.base.vertCount);
    s.disp = new Float32Array(s.base.triCount * 9);
    s.triSeen = new Int32Array(s.base.triCount);
    s.drawStamp = 1;
    return true;
  }

  /* The live wall gate, per dab. See section 6c for why this exists alongside
     the front-facing filter rather than instead of it.

     The probe is built ONCE, at pointerdown, and walked here - which is the
     whole point of NSO_Thickness.prepare(). A refused dab is simply not added:
     the stroke carries on, the user can keep dragging somewhere the wall can
     take it, and the thin spot is never cut. The first dab is the exception -
     a stroke that cannot even start is refused outright, so nobody drags a
     groove they are not going to get. */
  function wallRefusal(s, rawPoint, rawNormal) {
    if (!s.probe) return null;
    var g = NSO_brushWallGate(s.probe, rawPoint, rawNormal, {
      mode: s.opts.mode, intensity: s.opts.intensity, radius: s.opts.radius
    });
    if (g.ok || g.skipped) return null;
    s.lastGate = g;
    return (typeof NSO_Thickness !== 'undefined' && NSO_Thickness.strokeRefusal)
      ? NSO_Thickness.strokeRefusal(g)
      : 'Brush refused - wall too thin here, Thicken first: ' + g.reason;
  }

  function addStamp(s, rawPoint, rawNormal) {
    var grew = ensureRefined(s, rawPoint);
    var st = { c: rawPoint, n: rawNormal, r: s.opts.radius,
               falloff: s.opts.falloff, mode: s.opts.mode };
    s.stamps.push(st);
    if (grew) {
      s.field = NSO_brushWeights(s.base, s.stamps, { hash: s.hash, normals: s.normals });
      recompute(s, true);
      rebuildPreviewGeometry(s);
    } else {
      NSO_brushMergeStamp(s.base, s.field, st, s.hash, s.normals);
      recompute(s, false);
      redraw(s);
    }
    s.lastStamp = rawPoint;
  }

  /* The live preview's two ends, announced as a plain DOM event so anything
     listening (the watch log in nso-watch.js) can tell a preview from a
     commit: the commit itself is already on record through pushUndo, but a
     stroke that is shown and then dropped leaves no other trace. Costs one
     dispatch per stroke with nobody listening, and changes nothing. */
  function note(phase, s, why) {
    try {
      window.dispatchEvent(new CustomEvent('nso:op', { detail: {
        phase: phase, op: 'brush ' + ((s && s.opts && s.opts.mode) || '?') + ' stroke',
        model: s && s.m ? s.m.id : null, stamps: s && s.stamps ? s.stamps.length : 0,
        reason: why || null
      } }));
    } catch (e) { /* never let the announcement touch the stroke */ }
  }

  function rebuildPreviewGeometry(s) {
    var old = s.previewGeo;
    s.previewGeo = makePreviewGeometry(s);
    if (s.mesh) s.mesh.geometry = s.previewGeo;
    if (old) old.dispose();
  }

  function beginStroke(p, event) {
    var m = p.m;
    if (typeof NSO_buildAdjacency !== 'function') { say('Brush needs app-sculpt.js - nothing changed', true); return false; }
    var f = frameOf(m);
    if (!f) { say('Brush needs a raw piece - split, wrap or boolean it first', true); return false; }
    p.mesh.updateMatrixWorld();
    var lp = p.mesh.worldToLocal(p.hit.point.clone());
    var rawPoint = rawPointFromLocal(f, [lp.x, lp.y, lp.z]);
    var ln = p.hit.face.normal.clone().normalize();
    var rn = rawDirFromLocal([ln.x, ln.y, ln.z]);

    var adj = NSO_buildAdjacency(m.rawTris, {});
    if (!adj.ok) { say('Brush refused - ' + adj.reason, true); return false; }

    var o = readOpts();
    var base = NSO_brushMesh(adj);
    session = {
      m: m, mesh: p.mesh, idx: p.idx, frame: f, centre: f.c.slice(),
      origGeometry: m.geometry, origRaw: m.rawTris,
      adj: adj, base: base, basePos: new Float64Array(base.pos),
      graph: NSO_brushGraph(base), hash: NSO_brushHash(base, Math.max(2, o.radius)),
      stamps: [], refined: [], refineSplits: 0, refineCapped: false,
      target: NSO_brushTargetEdge(o.radius), maxRefinePasses: 5, maxTris: 400000,
      opts: o, smoothPasses: 4,
      seamOpts: { seamPasses: 3, seamStrength: 0.5, featureAngle: 40, seamRings: 1 },
      field: null, pos: null, seam: null, dirty: [], dirtySeen: null,
      disp: null, triSeen: null, drawStamp: 1,
      previewGeo: null, lastStamp: null, pointerId: event ? event.pointerId : null,
      moves: 0
    };
    /* Build once, ask many. measureMesh() would re-weld the piece on every
       pointermove; prepare() pays the weld and the triangle hash here, at
       pointerdown, and every dab after this is a DDA walk. */
    session.probe = null;
    if (typeof NSO_Thickness !== 'undefined' && typeof NSO_Thickness.prepare === 'function') {
      try { session.probe = NSO_Thickness.prepare(m.rawTris, {}); }
      catch (e) { session.probe = null; }
    }
    session.wallRefused = 0;
    session.normals = NSO_brushVertexNormals(base);
    session.dirtySeen = new Uint8Array(base.vertCount);
    session.pos = new Float64Array(session.basePos);
    session.field = NSO_brushWeights(base, [], { normals: session.normals });
    session.disp = new Float32Array(base.triCount * 9);
    session.triSeen = new Int32Array(base.triCount);
    writeDisplay(session);
    rebuildPreviewGeometry(session);
    note('preview', session);

    if (state.controls) state.controls.enabled = false;
    try { if (event && event.target.setPointerCapture) event.target.setPointerCapture(event.pointerId); } catch (e) {}
    /* The first dab, gated BEFORE it lands: the preview never shows a cut the
       commit is going to refuse. Torn down in the same three steps onDown uses
       for the paint stand-down, and in that order - session cleared, controls
       handed back, THEN reverted - so there is one shape for "this stroke does
       not start" and not two. */
    var refused = wallRefusal(session, rawPoint, rn);
    if (refused) {
      var dead = session;
      session = null;
      if (state.controls) state.controls.enabled = true;
      revert(dead, refused, true);
      return false;
    }
    addStamp(session, rawPoint, rn);
    say(labelOf(o.mode) + ' - drag to work the surface, let go to bake');
    return true;
  }

  function labelOf(mode) {
    return mode === 'emboss' ? 'Emboss' : (mode === 'smooth' ? 'Smooth (local)' : 'Carve');
  }

  function continueStroke(event) {
    var s = session;
    if (!s) return;
    var p = pick(event);
    if (!p || p.idx !== s.idx) return;
    s.mesh.updateMatrixWorld();
    var lp = s.mesh.worldToLocal(p.hit.point.clone());
    var rawPoint = rawPointFromLocal(s.frame, [lp.x, lp.y, lp.z]);
    if (s.lastStamp) {
      var d = Math.hypot(rawPoint[0] - s.lastStamp[0], rawPoint[1] - s.lastStamp[1],
                         rawPoint[2] - s.lastStamp[2]);
      if (d < s.opts.radius * SPACING) return;
    }
    var ln = p.hit.face.normal.clone().normalize();
    var rn2 = rawDirFromLocal([ln.x, ln.y, ln.z]);
    var refused = wallRefusal(s, rawPoint, rn2);
    if (refused) {
      /* The dab is dropped, not the stroke: the wall here cannot take it, the
         wall two centimetres along may well be able to. Nothing is cut here
         and the user is told why while they are still holding the button. */
      s.wallRefused++;
      s.lastStamp = rawPoint;
      say(refused, true);
      showRing(p.hit.point, ln.clone().transformDirection(s.mesh.matrixWorld), s.opts.radius);
      return;
    }
    addStamp(s, rawPoint, rn2);
    s.moves++;
    showRing(p.hit.point, ln.clone().transformDirection(s.mesh.matrixWorld), s.opts.radius);
  }

  /* PAINT SCOPE: SUB-REGION. The rule and both categories are in
     docs/HANDOFF.md; the reasoning for this one is at section 6c and in
     docs/BRUSH.md. Checked twice on purpose - once on the first dab, so a
     stroke that cannot land is refused before the user drags a groove they
     will not get, and once over the whole stroke at pointerup, because the
     drag can travel onto a painted face the first dab never reached. Same
     test, same wording, two moments. */
  function paintStandDown(s) {
    var planes = (typeof nsoMaskPlaneList === 'function') ? nsoMaskPlaneList(s.m) : [];
    if (!planes || !planes.length) return null;
    var pts = NSO_brushAffectedPoints(
      { pos: s.basePos, vertCount: s.base.vertCount }, s.field, s.seam);
    var chk = NSO_brushPaintCheck(planes, pts);
    return chk.any ? NSO_brushStandDownStatus(chk.painted) : null;
  }

  function revert(s, text, bad) {
    note('discard', s, text);
    if (s.mesh && s.origGeometry) s.mesh.geometry = s.origGeometry;
    if (s.previewGeo) { s.previewGeo.dispose(); s.previewGeo = null; }
    if (text) say(text, bad !== false);
  }

  function endStroke(commit) {
    var s = session;
    session = null;
    if (!s) return;
    if (state.controls) state.controls.enabled = true;

    if (!commit || !s.stamps.length) { revert(s, 'Brush cancelled - piece unchanged', false); return; }

    var stand = paintStandDown(s);
    if (stand) { revert(s, stand, true); return; }

    var outTris = NSO_brushToRaw(s.base, s.pos);
    var baseTris = NSO_brushToRaw(NSO_brushMesh(s.adj));
    var before, after;
    try {
      before = NSO_brushScore(baseTris, { adj: s.adj });
      after = NSO_brushScore(outTris, {});
    } catch (err) {
      revert(s, 'Brush refused - the checker threw (' + ((err && err.message) || err) + ')', true);
      return;
    }
    var g = NSO_brushGate(before, after, {});
    if (!g.ok) {
      revert(s, 'Brush refused - piece unchanged (' + g.reason + ')', true);
      return;
    }

    /* The third layer (section 6c): the FINISHED stroke, measured on the
       result. Overlapping dabs cut deeper than any one dab's arithmetic
       predicts, so this is not a restatement of the per-dab gate. */
    var wall = NSO_brushWallGateResult(outTris, s.stamps, {
      mode: s.opts.mode, intensity: s.opts.intensity, radius: s.opts.radius
    });
    if (!wall.ok) {
      revert(s, (typeof NSO_Thickness !== 'undefined' && NSO_Thickness.strokeRefusal)
        ? NSO_Thickness.strokeRefusal(wall)
        : 'Brush refused - wall too thin here, Thicken first: ' + wall.reason, true);
      return;
    }

    // Put the ORIGINAL geometry back on the mesh before committing, so the
    // undo entry NSO_sculptCommitRaw pushes carries the piece as it was and
    // not a throwaway preview.
    if (s.mesh && s.origGeometry) s.mesh.geometry = s.origGeometry;
    if (s.previewGeo) { s.previewGeo.dispose(); s.previewGeo = null; }

    var volPct = before.volume ? (100 * (Math.abs(after.volume) / Math.abs(before.volume) - 1)) : 0;
    var txt = labelOf(s.opts.mode) + ' done - ' + s.stamps.length + ' dab(s), ' +
      s.field.touched.length + ' vert(s) moved, seam band ' + (s.seam ? s.seam.band : 0) +
      ' (' + (s.seam ? s.seam.pinned : 0) + ' pinned), tris ' + before.tris + '→' + after.tris +
      ', open ' + before.openPos + '→' + after.openPos +
      ', slivers ' + before.slivers + '→' + after.slivers +
      ', T-junctions ' + before.tJunctions + '→' + after.tJunctions +
      ', self-int ' + before.pierce + '→' + after.pierce +
      ', volume ' + (volPct >= 0 ? '+' : '') + volPct.toFixed(2) + '%';
    if (wall && wall.measured && wall.wall_mm != null) {
      txt += ', thinnest wall under the stroke ' + (Math.round(wall.wall_mm * 1000) / 1000) +
             ' mm (floor ' + (Math.round(wall.threshold_mm * 1000) / 1000) + ')';
    }
    if (s.wallRefused) txt += ', ' + s.wallRefused + ' dab(s) refused - wall too thin there';
    if (typeof NSO_sculptCommitRaw === 'function') {
      NSO_sculptCommitRaw(s.m, outTris, 'brushReplace', txt);
    } else {
      say('Brush has nowhere to commit - app-sculpt.js is not loaded', true);
    }
    window.nsoBrushLast = { before: before, after: after, stamps: s.stamps.length,
                            refineSplits: s.refineSplits, capped: s.refineCapped,
                            seam: s.seam, gate: g };
  }

  /* ---- arming ----

     One armed tool at a time. Every mode below claims a press that lands on a
     piece, and two of them armed at once leaves the one app-core asks second
     silently dead.

     The convention here is app-measure.js's and app-center-lock.js's, not a
     fourth dialect: a mode that HAS a button is turned off THROUGH the button,
     never by writing its state flag, because the button carries aria-pressed
     and the armed class and a flag set behind its back leaves a lit button
     that does nothing.

     state.maskPaint is `false | 'exclude' | 'select'` since the paint grew its
     target list, so the click has to go to whichever of the two paint buttons
     is actually live. Clicking the other one would SWITCH paint modes rather
     than stop it - which is exactly what an earlier draft of this function did,
     because it was written against the single-button paint that existed before
     the select list landed. */
  function disarmOthers() {
    if (state.maskPaint) {
      var paintBtn = el(state.maskPaint === 'select' ? 'btn-mask-select' : 'btn-mask-paint');
      if (paintBtn) paintBtn.click();
    }
    if (state.carveArmed) {
      var carveBtn = el('btn-carve');
      if (carveBtn) carveBtn.click();
      else state.carveArmed = false;
    }
    if (state.measureOn) {
      var measureBtn = el('btn-measure');
      if (measureBtn) measureBtn.click();
      else state.measureOn = false;
    }
    if (state.seatHereArmed) {
      var seatBtn = el('btn-seat-here');
      if (seatBtn) seatBtn.click();
      else state.seatHereArmed = false;
    }
    if (state.centerLockArmed) {
      var clockBtn = el('btn-center-lock-pick');
      if (clockBtn) clockBtn.click();
      else state.centerLockArmed = false;
    }
    state.softenArmed = false;
    state.capArmed = false;
    if (typeof clearFacePick === 'function') clearFacePick();
  }

  function setLabel() {
    var b = el('btn-brush');
    if (!b) return;
    b.classList.toggle('is-armed', armed);
    b.textContent = armed ? 'Brush: on' : 'Brush';
  }
  function enter() {
    var m = model();
    if (!m || !m.rawTris || m.rawAxis !== 'zup') {
      say('Brush needs a raw piece - split, wrap or boolean it first', true);
      return;
    }
    armed = true;
    disarmOthers();
    setLabel();
    var o = readOpts();
    say(labelOf(o.mode) + ' brush armed - r ' + o.radius.toFixed(0) + 'mm, force ' +
        o.intensity.toFixed(2) + ', ' + o.falloff + ' falloff. Drag on the piece; ' +
        'click the button again to stop');
  }
  function exit() {
    if (session) endStroke(false);
    armed = false;
    hideRing();
    setLabel();
    say('Brush off');
  }
  function toggle() { if (armed) exit(); else enter(); }
  window.nsoBrushArmed = function () { return armed; };
  window.nsoBrushSetArmed = function (on) { if (!!on !== armed) toggle(); };

  /* Does the brush own this pointerdown? Asked by app-core's own
     pointerdown, exactly the way app-mask.js's nsoMaskTakesClick is asked,
     and for the same reason: app-core binds inside initThree() while the
     document is still parsing, so its capture listener on the canvas always
     runs before one bound here at DOMContentLoaded. Answering the question
     there is the only way to stop a stroke from also starting a move drag and
     reporting "Moved model #N" over the brush's own status. One predicate, so
     "the brush takes this" is decided here, where the hit test lives. */
  window.nsoBrushTakesPointer = function (event) {
    if (!armed || !event || event.button !== 0) return false;
    if (state.cutterOpen || state.joinSession) return false;
    return !!pick(event);
  };

  function onDown(event) {
    if (!armed || event.button !== 0) return;
    if (state.cutterOpen || state.joinSession) return;
    var p = pick(event);
    if (!p) return;
    event.stopPropagation();
    event.preventDefault();
    if (typeof selectPlaced === 'function' && p.m.id !== state.editId) selectPlaced(p.idx);
    if (!beginStroke(p, event)) return;
    var stand = paintStandDown(session);
    if (stand) { var s = session; session = null; if (state.controls) state.controls.enabled = true; revert(s, stand, true); }
  }

  function onMove(event) {
    if (!armed) return;
    if (session) { continueStroke(event); return; }
    var p = pick(event);
    if (!p) { hideRing(); return; }
    p.mesh.updateMatrixWorld();
    var nWorld = p.hit.face.normal.clone().transformDirection(p.mesh.matrixWorld).normalize();
    showRing(p.hit.point, nWorld, readOpts().radius);
  }

  function onUp() { if (session) endStroke(true); }
  function onCancel() { if (session) endStroke(false); }

  function bind() {
    var b = el('btn-brush');
    if (b && !b._brushBound) { b.addEventListener('click', toggle); b._brushBound = true; }
    var ids = ['inp-brush-size', 'inp-brush-intensity', 'sel-brush-mode', 'chk-brush-hard'];
    for (var i = 0; i < ids.length; i++) {
      var c = el(ids[i]);
      if (c && !c._brushBound) {
        c.addEventListener('input', syncLabels);
        c.addEventListener('change', syncLabels);
        c._brushBound = true;
      }
    }
    syncLabels();
    setLabel();
    if (!state || !state.renderer || !state.renderer.domElement || state._brushBound) return;
    state._brushBound = true;
    state.renderer.domElement.addEventListener('pointerdown', onDown, true);
    // The hover ring needs a pointermove that fires while NOTHING is pressed.
    // onCanvasPointerMove in app-core.js early-returns unless one of its three
    // drags is already running, so there was no such path in this app before
    // this line - see the AUDIT at the top of this file.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && session) { endStroke(false); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
  setTimeout(bind, 0);
})();
